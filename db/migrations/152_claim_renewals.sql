-- =============================================================================
-- Migration 152: a work claim counts its renewals, so how long a claim ran can
--                be read beside how often its holder renewed it (SMD-4540 PR 1)
-- =============================================================================
--
-- WHY
--   work_claims (115) keeps a claim's start, its last renewal and its end. A
--   renewal overwrites renewed_at, so nothing says how often a holder renewed.
--   SMD-4540 reports how long claims run, by how they ended and by the work's
--   size, so SMD-4541 can decide whether a claim should state when its work will
--   be done. The count says how often a claim's holder renewed it, which reads
--   within one kind of client, each renewing at its own pace (changes/
--   smd-4540.md's limits), not as a measure of work across them. The maintainer
--   chose (2026-11-23) the counter first, so that it reaches a release, and the
--   stable brain, before the report needs it.
--
-- WHAT
--   * work_claims.renewals: how many renewals of the claim landed. A claim made
--     from this migration on starts at 0 (the column's default); a claim made
--     before it reads NULL, uncounted, never 0, since its renewals went
--     unrecorded. CHECK renewals >= 0.
--   * renew_work_claim and claim_work's renewal branch (the holder's own token on
--     exactly this work) raise it by one, in the UPDATE that renews. NULL + 1 is
--     NULL, so an uncounted claim stays uncounted. A refusal writes nothing, so
--     it counts nothing; a lapsed claim its holder renews, nothing covering it,
--     counts that renewal; a takeover's new claim is a new row and starts at 0.
--   * ob1_work_claim_json adds `renewals`, so every function answering with a
--     claim's jsonb built by it (claim_work, renew_work_claim,
--     release_work_claim, release_closed_ticket_claims) carries it; 145's
--     release_holder_claims names its claims by id, issue and piece alone.
--   * list_work_claims is left as 143 made it. It returns columns, not the
--     jsonb, and a RETURNS TABLE cannot gain one under CREATE OR REPLACE; made
--     again here with one more, 143's own CREATE OR REPLACE would refuse it at a
--     `migrate.ts --reapply`, which runs every file in order. The server reads
--     each claim's renewals beside it by the claim's id, a scalar subquery
--     through the row's jsonb (store-sql.ts).
--
-- WHO READS
--   No grant changes: the column is work_claims', and the `claims` group's
--   SELECT, INSERT and UPDATE on the table reach it.
--
-- SAFETY
--   One column added (no existing column altered), its default and its check;
--   three functions redefined with their signatures unchanged, each carrying its
--   last definer's body (115's ob1_work_claim_json and renew_work_claim, 140's
--   claim_work) with the count its only change. No row is rewritten: existing
--   claims keep NULL. MINOR under MAINTAINING.md's versioning. test-schema [137],
--   test-upgrade [20co].
--
-- Prerequisites
--   115 (work_claims and its helpers) and 140 (claim_work's cap and its
--   helpers). Applied by `bun db/migrate.ts`. Re-applied: the column, its default,
--   its check and every count are kept, and the functions are replaced as they
--   were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['claim_work(text, text, text, integer, text, jsonb)', '115 (claim_work)'],
    ARRAY['renew_work_claim(uuid, text, integer, jsonb)', '115 (renew_work_claim)'],
    ARRAY['ob1_work_claim_json(work_claims, timestamp with time zone)', '115 (ob1_work_claim_json)'],
    ARRAY['ob1_work_claim_actor(jsonb, text)', '115 (ob1_work_claim_actor)'],
    ARRAY['ob1_work_claim_is_holder(work_claims, text, uuid, bytea)', '115 (ob1_work_claim_is_holder)'],
    ARRAY['ob1_work_claim_isolation(text)', '115 (ob1_work_claim_isolation)'],
    ARRAY['ob1_work_claim_issue(text)', '115 (ob1_work_claim_issue)'],
    ARRAY['ob1_work_claim_lease(integer)', '115 (ob1_work_claim_lease)'],
    ARRAY['ob1_work_claim_lock(text)', '115 (ob1_work_claim_lock)'],
    ARRAY['ob1_work_claim_text(text, integer, text)', '115 (ob1_work_claim_text)'],
    ARRAY['ob1_work_claim_token_hash(text)', '115 (ob1_work_claim_token_hash)'],
    ARRAY['ob1_work_claims_in_the_way(text, text, uuid, timestamp with time zone)', '115 (ob1_work_claims_in_the_way)'],
    ARRAY['ob1_work_claim_cap()', '140 (ob1_work_claim_cap)'],
    ARRAY['ob1_work_claim_holder_lock(text, uuid)', '140 (ob1_work_claim_holder_lock)'],
    ARRAY['ob1_work_claim_holder_live_count(text, uuid, timestamp with time zone)', '140 (ob1_work_claim_holder_live_count)']];
  i int;
BEGIN
  IF to_regclass('work_claims') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 152 needs 115 (work_claims); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 152 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
END
$qc$;

-- ---------------------------------------------------------------------------
-- work_claims.renewals — the count. Added with no default, so the claims that
-- stand keep NULL (uncounted); the default then holds for every claim after.
-- ---------------------------------------------------------------------------
ALTER TABLE work_claims ADD COLUMN IF NOT EXISTS renewals integer CONSTRAINT work_claims_renewals_counted CHECK (renewals >= 0);
ALTER TABLE work_claims ALTER COLUMN renewals SET DEFAULT 0;
COMMENT ON COLUMN work_claims.renewals IS
  'How many renewals of this claim landed: renew_work_claim, and claim_work with the holder''s own token on exactly this work. 0 for a new claim; NULL for a claim made before migration 152, whose renewals went uncounted. A refusal counts nothing. Migration 152 / SMD-4540.';

-- One claim as the functions return it: no token, no hash.
CREATE OR REPLACE FUNCTION ob1_work_claim_json(c work_claims, p_now timestamptz)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'issue', c.issue, 'piece', c.piece,
    'holder', c.holder_name, 'holder_agent_id', c.holder_agent_id, 'holder_kind', c.holder_kind,
    'label', c.label,
    'claimed_at', c.claimed_at, 'renewed_at', c.renewed_at, 'expires_at', c.expires_at,
    'released_at', c.released_at, 'released_by', c.released_by, 'released_by_kind', c.released_by_kind,
    'release_reason', c.release_reason, 'renewals', c.renewals,
    'state', CASE WHEN c.released_at IS NOT NULL THEN 'released' WHEN c.expires_at <= p_now THEN 'lapsed' ELSE 'live' END)
$$;
COMMENT ON FUNCTION ob1_work_claim_json(work_claims, timestamptz) IS
  'One work claim as jsonb, with its state at p_now (live, lapsed or released) and neither its token nor its hash; renewals is how many renewals of it landed, NULL for a claim made before migration 152 (uncounted). Migration 115 / SMD-3597; renewals, migration 152 / SMD-4540.';

-- ---------------------------------------------------------------------------
-- renew_work_claim — 115's body unchanged but for the count, marked SMD-4540
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION renew_work_claim(
  p_claim         uuid,
  p_token         text,
  p_lease_seconds int   DEFAULT 14400,
  p_actor         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_hash  bytea    := ob1_work_claim_token_hash(p_token);
  v_lease interval := ob1_work_claim_lease(p_lease_seconds);
  v_who   record;
  v_issue text;
  v_now   timestamptz;
  v_row   work_claims;
  v_held  jsonb;
BEGIN
  IF v_hash IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'renew_work_claim needs the claim''s token: the one claim_work returned', ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ob1_work_claim_isolation('renew_work_claim');
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'renew_work_claim');
  SELECT issue INTO v_issue FROM work_claims WHERE id = p_claim;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_FOUND', 'message', format('no claim %s', COALESCE(p_claim::text, '(none given)')), 'claim', NULL, 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  PERFORM ob1_work_claim_lock(v_issue);
  v_now := clock_timestamp();
  SELECT * INTO v_row FROM work_claims WHERE id = p_claim FOR UPDATE;

  IF NOT ob1_work_claim_is_holder(v_row, v_who.name, v_who.agent_id, v_hash) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_NOT_YOURS',
      'message', format('claim %s is held by %s, not by this key with this token', p_claim, v_row.holder_name),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  IF v_row.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'CLAIM_RELEASED',
      'message', format('claim %s ended at %s; claim the work again', p_claim,
                        to_char(v_row.released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"')),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;
  -- Lapsed meanwhile, another holder may have claimed a piece or the whole.
  SELECT jsonb_agg(ob1_work_claim_json(w, v_now) ORDER BY w.claimed_at, w.id) INTO v_held
    FROM ob1_work_claims_in_the_way(v_row.issue, v_row.piece_key, v_row.id, v_now) w;
  IF v_held IS NOT NULL THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'WORK_CLAIMED',
      'message', format('claim %s lapsed and a claim of %s now covers its work', p_claim, v_held->0->>'holder'),
      'claim', ob1_work_claim_json(v_row, v_now), 'held_by', v_held, 'token', NULL);
  END IF;
  -- Counted (SMD-4540): a claim made before migration 152 has no count, and NULL + 1 keeps it uncounted.
  UPDATE work_claims SET expires_at = v_now + v_lease, renewed_at = v_now, renewals = renewals + 1 WHERE id = p_claim RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'renewed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
END;
$$;
COMMENT ON FUNCTION renew_work_claim(uuid, text, int, jsonb) IS
  'Extends the caller''s own claim (the key p_actor names, and p_token, which claim_work returned) to p_lease_seconds from now. Returns jsonb {outcome, code, message, claim, held_by, token}: renewed, or refused — CLAIM_NOT_FOUND, CLAIM_NOT_YOURS, CLAIM_RELEASED (ended, or taken over after it lapsed), WORK_CLAIMED (it lapsed and another claim covers its work). A lapsed claim nothing covers is renewed. Each renewal that lands raises the claim''s renewals by one; a refusal leaves it. READ COMMITTED only. Migration 115 / SMD-3597; renewals, migration 152 / SMD-4540.';

-- ---------------------------------------------------------------------------
-- claim_work — 140's body unchanged but for the renewal branch's count, marked
-- SMD-4540 below. The cap block (SMD-3606) and every refusal stand as 140 left
-- them.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_work(
  p_issue         text,
  p_piece         text  DEFAULT NULL,
  p_label         text  DEFAULT NULL,
  p_lease_seconds int   DEFAULT 14400,
  p_token         text  DEFAULT NULL,
  p_actor         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_issue   text     := ob1_work_claim_issue(p_issue);
  v_piece   text     := ob1_work_claim_text(p_piece, 100, 'a piece');
  v_key     text     := COALESCE(lower(v_piece), '');
  v_label   text     := ob1_work_claim_text(p_label, 500, 'a label');
  v_lease   interval := ob1_work_claim_lease(p_lease_seconds);
  v_hash    bytea    := ob1_work_claim_token_hash(p_token);
  v_who     record;
  v_now     timestamptz;
  v_mine    work_claims;
  v_row     work_claims;
  v_held    jsonb;
  v_token   text;
  v_cap     int;
  v_count   int;
BEGIN
  -- A piece given but blank once cleaned would claim the whole ticket, the
  -- broadest claim: refused instead (review pass 3).
  IF p_piece IS NOT NULL AND v_piece IS NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'a piece was given but is blank once cleaned; pass NULL to claim the whole ticket', ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ob1_work_claim_isolation('claim_work');
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'claim_work');
  IF v_who.kind = 'ingested' THEN
    RAISE EXCEPTION USING
      MESSAGE = format('claim_work: %s is an ingested key (an importer''s), which cannot claim work', v_who.name),
      ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM ob1_work_claim_lock(v_issue);
  v_now := clock_timestamp();

  -- The caller's own unreleased claim on exactly this work, live or lapsed,
  -- that its token names: the one claim the read below leaves out.
  IF v_hash IS NOT NULL THEN
    SELECT * INTO v_mine FROM work_claims c
     WHERE c.issue = v_issue AND c.piece_key = v_key AND c.released_at IS NULL
       AND ob1_work_claim_is_holder(c, v_who.name, v_who.agent_id, v_hash)
     FOR UPDATE;
  END IF;

  SELECT jsonb_agg(ob1_work_claim_json(w, v_now) ORDER BY w.claimed_at, w.id) INTO v_held
    FROM ob1_work_claims_in_the_way(v_issue, v_key, v_mine.id, v_now) w;
  IF v_held IS NOT NULL THEN
    -- The message names the work the caller asked for, the first holder's key
    -- and the times — never text another key wrote (its piece, its label),
    -- which stays in held_by as data (review passes 1 and 2).
    RETURN jsonb_build_object(
      'outcome', 'refused', 'code', 'WORK_CLAIMED',
      'message', format('%s%s is covered by a claim of %s since %s, until %s',
                        v_issue, COALESCE(' ' || v_piece, ''), v_held->0->>'holder',
                        to_char((v_held->0->>'claimed_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'),
                        to_char((v_held->0->>'expires_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"')),
      'claim', NULL, 'held_by', v_held, 'token', NULL);
  END IF;

  -- The caller's own claim, nothing else covering it: renewed. A renewal reads
  -- no cap and is never refused by it (SMD-3606): work in hand is never cut off.
  IF v_mine.id IS NOT NULL THEN
    -- Counted (SMD-4540), as renew_work_claim counts; a claim made before migration 152 stays uncounted.
    UPDATE work_claims SET expires_at = v_now + v_lease, renewed_at = v_now, renewals = renewals + 1, label = COALESCE(v_label, label)
     WHERE id = v_mine.id RETURNING * INTO v_row;
    RETURN jsonb_build_object('outcome', 'renewed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', NULL);
  END IF;

  -- A NEW claim: cap the holder's live claims (SMD-3606). A per-holder advisory
  -- lock, taken after the per-ticket lock above (consistent order, no deadlock),
  -- makes the count and the insert below atomic against the same holder's
  -- concurrent claims on other tickets; without it two could each read one below
  -- the cap and both insert.
  PERFORM ob1_work_claim_holder_lock(v_who.name, v_who.agent_id);
  v_cap   := ob1_work_claim_cap();
  v_count := ob1_work_claim_holder_live_count(v_who.name, v_who.agent_id, v_now);
  IF v_count >= v_cap THEN
    RETURN jsonb_build_object(
      'outcome', 'refused', 'code', 'CLAIM_LIMIT',
      'message', format('%s holds %s live claims, the cap of %s; release one, or an operator raises the cap (set_work_claim_cap)', v_who.name, v_count, v_cap),
      'claim', NULL, 'held_by', '[]'::jsonb, 'token', NULL, 'cap', v_cap, 'held', v_count);
  END IF;

  -- A lapsed claim on exactly this ticket and piece: taken over. (Nothing live
  -- covers the work, so every unreleased row here has lapsed.)
  UPDATE work_claims
     SET released_at = v_now, released_by = v_who.name, released_by_agent_id = v_who.agent_id,
         released_by_kind = v_who.kind, release_reason = 'lapsed; taken over'
   WHERE issue = v_issue AND piece_key = v_key AND released_at IS NULL AND expires_at <= v_now;

  v_token := 'wc_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO work_claims (issue, piece, holder_name, holder_agent_id, holder_kind, token_hash, label, claimed_at, expires_at)
  VALUES (v_issue, v_piece, v_who.name, v_who.agent_id, v_who.kind, ob1_work_claim_token_hash(v_token), v_label, v_now, v_now + v_lease)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'claimed', 'code', NULL, 'message', NULL, 'claim', ob1_work_claim_json(v_row, v_now), 'held_by', '[]'::jsonb, 'token', v_token);
END;
$$;
COMMENT ON FUNCTION claim_work(text, text, text, int, text, jsonb) IS
  'Claims a ticket, or one piece of it, under a lease, so two agents never build one change (115, SMD-3597). The caller''s own claim on exactly this work (key and token) is renewed, not refused, and reads no cap; any other live claim on the same work refuses it WORK_CLAIMED; a lapsed claim on exactly this work is taken over. A NEW claim past the holder''s cap on live claims (ob1_work_claim_cap(), counted under a per-holder lock) is refused CLAIM_LIMIT (SMD-3606, migration 140). Returns {outcome, code, message, claim, held_by, token}; token once, on a claim. Migration 140 redefines 115''s to add the cap; migration 152 (SMD-4540) counts each renewal it makes in the claim''s renewals.';
