-- =============================================================================
-- Migration 144: release every live claim one holder holds — release_holder_claims,
--                an operator key's one-call undo of a claim hog (SMD-3606 PR 3)
-- =============================================================================
--
-- WHY
--   115 ends one claim at a time: release_work_claim takes a single claim id, so
--   an operator undoing another holder's claims pays one forced release per claim.
--   A key that hoarded the board — SMD-3606's runaway agent, before 140's cap
--   stops it — leaves hundreds, and clearing them one id at a time is the gap
--   SMD-3597's review named (Work item 3). 140 caps the claims a holder may make;
--   this ends the ones already made, in one call.
--
-- WHAT
--   release_holder_claims(p_holder, p_reason, p_actor): an operator key, named by
--   its agent id (046's registry kind; a name alone lends none, SMD-2608's rule,
--   as 115's forced release and 140's set_work_claim_cap read it), ends every
--   live claim (unreleased and unexpired — the set 140's cap counts) of one
--   holder in one call, each with p_reason. p_holder is a key's name, as
--   list_work_claims shows it (holder_name; names are unique, MCP_ACCESS_KEYS
--   refuses one twice, so it picks out one key). The reply is {ok: true, holder,
--   released: N, claims: [{id, issue, piece}, …]}: how many ended and which.
--     A key that is no operator, or reaches the brain with no agent id, is refused
--   {ok: false, error: NOT_OPERATOR, …}; nothing ends. A blank holder is NO_HOLDER,
--   a blank reason NO_REASON (releasing another's work always needs a reason, as
--   115's force does). The holder's lapsed and released claims, and every other
--   holder's, stand.
--     One atomic UPDATE, so no per-holder lock (claim_work takes one because it
--   counts then inserts — a read-then-write race; this neither reads-then-writes
--   nor inserts). READ COMMITTED, like the rest of the family (above it a single
--   UPDATE could fail a concurrent renewal with a serialization error; the check
--   refuses that isolation up front). A claim committed after the UPDATE's
--   snapshot is a new claim, not one this release missed. The rows stay as
--   history, with the operator and the reason on each, like any release.
--     SECURITY INVOKER, EXECUTE PUBLIC (115's claim functions): the server's role
--   writes work_claims under the claims group's UPDATE it already holds (115), so
--   this adds no grant. Nothing runs at apply time but the DDL; no row moves; no
--   table is touched. PATCH under FORK.md's version rules: a new function, nothing
--   existing changed. test-schema [131], test-upgrade [20ci], test-rest-sql [25],
--   the store and server suites.
--
-- Prerequisites
--   115 (work_claims; ob1_work_claim_actor, ob1_work_claim_text and
--   ob1_work_claim_isolation, which the body calls) and 046 (ob1_registry_kind,
--   the operator gate). Applied by `bun db/migrate.ts`.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape). Every probe names an object that stands on a brain at this file.
DO $qc$
BEGIN
  IF to_regclass('work_claims') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 144 needs 115 (work_claims); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_work_claim_actor(jsonb, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 144 needs 115 (ob1_work_claim_actor); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_registry_kind(uuid, text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 144 needs 046 (ob1_registry_kind); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

CREATE OR REPLACE FUNCTION release_holder_claims(
  p_holder text,
  p_reason text  DEFAULT NULL,
  p_actor  jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_who    record;
  v_kind   text;
  v_holder text := ob1_work_claim_text(p_holder, 200, 'a holder');
  v_reason text := ob1_work_claim_text(p_reason, 500, 'a reason');
  v_now    timestamptz;
  v_claims jsonb;
  v_count  integer;
BEGIN
  PERFORM ob1_work_claim_isolation('release_holder_claims');
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'release_holder_claims');
  -- The operator's kind by its agent id alone: a name is anyone's to write in an
  -- envelope, so it lends no kind (SMD-2608's rule, as 115's forced release and
  -- 140's set_work_claim_cap read it).
  v_kind := CASE WHEN v_who.agent_id IS NULL THEN NULL ELSE ob1_registry_kind(v_who.agent_id, NULL) END;
  IF v_who.agent_id IS NULL OR v_kind IS DISTINCT FROM 'operator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR', 'key', v_who.name, 'kind', v_kind,
      'message', format('only an operator key, named by its agent id, may release a holder''s claims; %s is %s', v_who.name,
                        CASE WHEN v_who.agent_id IS NULL THEN 'named by its name alone' ELSE COALESCE(v_kind, 'unclassified') END));
  END IF;
  IF v_holder IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_HOLDER',
      'message', 'name the holder whose live claims to release: a key''s name, as list_work_claims shows it');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NO_REASON',
      'message', 'releasing a holder''s claims needs a reason');
  END IF;

  v_now := clock_timestamp();
  -- One atomic UPDATE of every live claim the holder holds (unreleased and
  -- unexpired, the set 140's cap counts), by its key name. No count-then-insert,
  -- so no per-holder lock; a claim committed after this snapshot is a new claim,
  -- not one this release missed.
  WITH released AS (
    UPDATE work_claims
       SET released_at = v_now, released_by = v_who.name, released_by_agent_id = v_who.agent_id,
           released_by_kind = v_who.kind, release_reason = v_reason
     WHERE holder_name = v_holder AND released_at IS NULL AND expires_at > v_now
     RETURNING id, issue, piece, claimed_at
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'issue', issue, 'piece', piece)
                            ORDER BY issue, COALESCE(lower(piece), ''), claimed_at, id), '[]'::jsonb),
         count(*)::int
    INTO v_claims, v_count
    FROM released;
  RETURN jsonb_build_object('ok', true, 'holder', v_holder, 'released', v_count, 'claims', v_claims);
END
$$;
COMMENT ON FUNCTION release_holder_claims(text, text, jsonb) IS
  'An operator key ends every live claim (unreleased and unexpired) one holder holds — p_holder, a key''s name as list_work_claims shows it — in one call, each with p_reason: the one-call undo of a claim hog (SMD-3606 Work item 3; 140 caps new claims, this ends the ones made). Only a key the registry classifies operator by its agent id in p_actor (a name alone lends no kind, SMD-2608); any other answers {ok: false, error: NOT_OPERATOR, key, kind, message}, nothing ended. A blank holder answers NO_HOLDER, a blank reason NO_REASON. Otherwise {ok: true, holder, released: N, claims: [{id, issue, piece}, …]}, ordered as list_work_claims lists; the rows stay as history with the operator and reason on each. One atomic UPDATE, READ COMMITTED, no lock. The holder''s lapsed and released claims, and every other holder''s, stand. Migration 144 / SMD-3606.';
