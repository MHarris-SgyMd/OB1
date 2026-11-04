-- =============================================================================
-- Migration 118: a closed ticket's claims are released — board-sync ends
--                every unreleased claim on a ticket the brain records as
--                Done, Canceled or a Duplicate (SMD-3600)
-- =============================================================================
--
-- WHY
--   A claim ends when its holder releases it or its lease lapses (115). An
--   agent that merges its PR and stops without releasing leaves the claim
--   unreleased, and since SMD-3599 every read that names the ticket says so:
--   `⚠ Claimed: … lapsed at …, never released` stays on a Done ticket for as
--   long as the brain has the row. The board already says the work is over;
--   board-sync copies the board into the brain every five minutes, so it is
--   the one writer that knows, and this file gives it the release.
--
-- WHAT
--   release_closed_ticket_claims(p_run, p_dry_run, p_actor) — one call per
--   board-sync pass, returning jsonb {outcome, released}:
--   * WHICH TICKETS: every ticket holding an unreleased claim (live or
--     lapsed) whose head in ob1_ticket_head (068) has a settled status type
--     (node_settled_types(), 105: completed, canceled, duplicate) and is a
--     row an importer wrote — its metadata.source is `linear`, which the
--     server refuses to every key: capture_thought's `source` and its
--     metadata, and update_thought's metadata_patch (review passes 1 and
--     2). So a thought a key writes with an `issue` and a `status_type` of
--     its own never releases anyone's claim: when such a row is the head,
--     the ticket is left alone. A write key may still edit the board's own
--     rows — patch one's ticket keys (its status, or its `issue` to another
--     ticket), or retire an open head over an older closed board row (delete
--     it, or point a supersedes at it) — and
--     so make a ticket read closed, as it may already mislabel 095's `moved`
--     that way; board-sync writes the board's status back when the ticket
--     next moves. Only the server refuses the label: a raw SQL writer is
--     trusted as the database's owner is.
--   * WHICH CLAIMS: every unreleased claim on such a ticket, the whole
--     ticket's and every piece's, live or lapsed, whenever it was made — a
--     claim made on a ticket already closed is released at the next pass too
--     (the maintainer's choice, 2026-11-03). A ticket that reopens brings no
--     claim back: a released row stays released.
--   * THE END: released_at, released_by / _agent_id / _kind from the call's
--     envelope (board-sync's key, `ingested` on the stable brain — 115's
--     CHECK already allows the kind), and release_reason
--     `<issue> closed: <status> (<status_type>); <p_run>`, the status as the
--     head holds it, cleaned as 115 cleans free text and cut to 100
--     characters.
--   * p_dry_run reads the same claims, takes no lock and writes nothing;
--     outcome `dry_run`, each claim as it stands.
--   * `released`: one element per claim, 115's claim json (never a token or
--     its hash) with `ticket_status` and `ticket_status_type` beside it, by
--     ticket, piece and claim time.
--   * CONCURRENCY: 115's rules. READ COMMITTED alone (0A000 above it); each
--     ticket's advisory lock (ob1_work_claim_lock) taken in key order and held
--     to the end of the transaction, the head read again under it, so a claim
--     on a ticket the call reached, made while it waits for that ticket's
--     lock, is released with the rest; a ticket whose first unreleased claim
--     commits after the call's first read waits for the next call. One call
--     per transaction: the locks it holds are taken in
--     key order, and 115's writers take one ticket each, so no two wait on
--     each other in a cycle.
--   * A call whose envelope names nobody raises (42501), as 115's writers do.
--
-- PRIVILEGES
--   EXECUTE is revoked from PUBLIC — the first core function so held, since
--   ending another holder's claim is otherwise an operator's forced release
--   by agent id (115) — and granted through the `closedclaims` group
--   (db/config.mjs ROLE_GRANTS): EXECUTE on the function, SELECT and UPDATE
--   on work_claims. It reads ob1_ticket_head, thoughts and ob1_agents, the
--   capture group's SELECTs, which board-sync's role holds. The server never
--   calls it: no tool or REST operation reaches it, so a key ends another
--   key's claim by an operator's force, or — a write key — by marking a
--   board row closed (WHICH TICKETS, above). A plain `migrate.ts --grant`
--   issues every group, this one included: name the groups (`--groups`)
--   to keep a role without it. On a stack whose
--   every service connects as the database owner (the dogfood deploy) the
--   revoke binds nobody; the group is for a deployment that splits roles.
--   A role without the group gets 42501 naming the function, and board-sync
--   says so once and goes on.
--
-- SAFETY
--   Additive: two functions (the call and one helper), one REVOKE; nothing
--   existing changed. MINOR under FORK.md's version rules. test-schema [106],
--   test-upgrade [20bj].
--
-- Prerequisites
--   058 (node_settled_types; `duplicate` in it since 105), 068
--   (ob1_ticket_head), 115
--   (work_claims and its helpers). Applied by `bun db/migrate.ts`.
--   Re-applied: the functions are replaced as they were, and the REVOKE
--   holds the same.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
BEGIN
  IF to_regclass('public.ob1_ticket_head') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 118 needs 068 (ob1_ticket_head); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('node_settled_types()') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 118 needs 058 (node_settled_types); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('ob1_work_claim_lock(text)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 118 needs 115 (ob1_work_claim_lock); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- A ticket's settled status, when its head is an importer's row with a
-- settled status type; no row otherwise.
CREATE OR REPLACE FUNCTION ob1_work_claim_closed_head(p_issue text)
RETURNS TABLE (status text, status_type text)
LANGUAGE sql
STABLE
AS $$
  SELECT h.status, h.status_type
    FROM ob1_ticket_head h
    JOIN thoughts t ON t.id = h.head_id
   WHERE h.issue_key = md5(p_issue)::uuid AND h.issue = p_issue
     AND h.status_type = ANY (node_settled_types())
     AND t.metadata->>'source' = 'linear'
$$;
COMMENT ON FUNCTION ob1_work_claim_closed_head(text) IS
  'The ticket''s status and status type when its head (ob1_ticket_head, 068) has a settled status type (node_settled_types(): completed, canceled, duplicate) and is an importer''s row (metadata.source linear, which the server refuses to every key); no row otherwise. Migration 118 / SMD-3600.';

-- ---------------------------------------------------------------------------
-- release_closed_ticket_claims
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION release_closed_ticket_claims(
  p_run     text,
  p_dry_run boolean DEFAULT false,
  p_actor   jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_run    text := ob1_work_claim_text(p_run, 200, 'a run');
  v_who    record;
  v_ticket record;
  v_head   record;
  v_now    timestamptz;
  v_row    work_claims;
  v_status text;
  v_out    jsonb := '[]'::jsonb;
BEGIN
  IF v_run IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'release_closed_ticket_claims needs a run: the pass that releases, named in each reason', ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ob1_work_claim_isolation('release_closed_ticket_claims');
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'release_closed_ticket_claims');

  FOR v_ticket IN
    SELECT u.issue FROM (SELECT DISTINCT c.issue FROM work_claims c WHERE c.released_at IS NULL) u
     WHERE EXISTS (SELECT 1 FROM ob1_work_claim_closed_head(u.issue))
     ORDER BY u.issue
  LOOP
    IF p_dry_run THEN
      SELECT * INTO v_head FROM ob1_work_claim_closed_head(v_ticket.issue);
      v_now := clock_timestamp();
      SELECT v_out || COALESCE(jsonb_agg(ob1_work_claim_json(c, v_now)
                                         || jsonb_build_object('ticket_status', v_head.status, 'ticket_status_type', v_head.status_type)
                                         ORDER BY c.piece_key, c.claimed_at, c.id), '[]'::jsonb)
        INTO v_out
        FROM work_claims c WHERE c.issue = v_ticket.issue AND c.released_at IS NULL;
      CONTINUE;
    END IF;

    -- Under the ticket's lock, read again: the head may have moved, and a
    -- claim made before the lock was granted is now committed and seen.
    PERFORM ob1_work_claim_lock(v_ticket.issue);
    SELECT * INTO v_head FROM ob1_work_claim_closed_head(v_ticket.issue);
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    v_now := clock_timestamp();
    v_status := COALESCE(ob1_work_claim_text(left(v_head.status, 100), 100, 'a status'), v_head.status_type);
    FOR v_row IN
      UPDATE work_claims c
         SET released_at = v_now, released_by = v_who.name, released_by_agent_id = v_who.agent_id,
             released_by_kind = v_who.kind,
             release_reason = format('%s closed: %s (%s); %s', c.issue, v_status, v_head.status_type, v_run)
       WHERE c.issue = v_ticket.issue AND c.released_at IS NULL
      RETURNING c.*
    LOOP
      v_out := v_out || jsonb_build_array(ob1_work_claim_json(v_row, v_now)
                                          || jsonb_build_object('ticket_status', v_head.status, 'ticket_status_type', v_head.status_type));
    END LOOP;
  END LOOP;

  -- By ticket, piece and claim time, as list_work_claims orders them.
  SELECT COALESCE(jsonb_agg(e ORDER BY e->>'issue', lower(COALESCE(e->>'piece', '')), (e->>'claimed_at')::timestamptz, e->>'id'), '[]'::jsonb)
    INTO v_out FROM jsonb_array_elements(v_out) e;
  RETURN jsonb_build_object('outcome', CASE WHEN p_dry_run THEN 'dry_run' ELSE 'released' END, 'released', v_out);
END;
$$;
COMMENT ON FUNCTION release_closed_ticket_claims(text, boolean, jsonb) IS
  'Board-sync''s release: ends every unreleased claim (live or lapsed, the whole ticket''s and every piece''s) on a ticket whose head is an importer''s row (metadata.source linear) with a settled status type (completed, canceled, duplicate), stamped with the caller''s envelope and the reason "<issue> closed: <status> (<status_type>); <p_run>". p_dry_run reads the same claims and writes nothing. Returns jsonb {outcome: released | dry_run, released: [claim with ticket_status and ticket_status_type]}. Takes each ticket''s lock in key order; READ COMMITTED only; one call per transaction. EXECUTE is the closedclaims group''s, not PUBLIC''s. Migration 118 / SMD-3600.';

REVOKE EXECUTE ON FUNCTION release_closed_ticket_claims(text, boolean, jsonb) FROM PUBLIC;
