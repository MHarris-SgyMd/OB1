-- =============================================================================
-- Migration 140: a per-holder cap on live work claims, operator-settable, so no
--                one key can hoard claims (SMD-3606 PR 1)
-- =============================================================================
--
-- WHY
--   work_claims (115) lets any key hold any number of live claims at once. A
--   runaway or buggy agent — a loop that claims a ticket a tick, a session that
--   never releases — could fill the board with one key's claims and lock every
--   other agent out of work it never touches. 115's rules stop two keys claiming
--   one ticket; nothing caps one key across tickets (SMD-3606). The maintainer
--   chose (2026-11-13) a cap the operator sets at runtime, not a constant only a
--   migration changes.
--
-- WHAT
--   A key's LIVE claims — unreleased and unexpired, the "free" count 115 defines
--   (a lapsed claim counts as free, so it does not count here) — are capped.
--   claim_work counts them before it inserts a new claim and refuses CLAIM_LIMIT
--   at or above the cap; a renewal (the holder's own token on the same work)
--   changes no count and is never refused, so work in hand is never cut off.
--   * work_claim_cap_settings: the operator's cap settings, one row each, a
--     standing one at most (ended_at NULL). A row is history: it changes only to
--     end, once, when the next cap or a clear replaces it; a DELETE or TRUNCATE
--     is refused, so the rows say which cap stood when. Its own table, not an
--     ob1_config row (132's reason: the server's roles hold SELECT alone on
--     ob1_config, and a grant to write it would let them write other rows too).
--   * ob1_work_claim_cap_builtin(): the brain's own default cap, 50. Generous:
--     the dogfood's Claude Code sessions share one key (115), so a fleet of
--     worktrees counts as one holder, and 50 sits well above its realistic peak
--     while a hog (hundreds, thousands) blows past it. A retune of the brain's
--     own default replaces this function alone.
--   * ob1_work_claim_cap_refusal(cap): what is wrong with a cap value — not a
--     whole number, below 1, above 100000 — in words, or NULL. The trigger,
--     set_work_claim_cap and ob1_work_claim_cap() read it; a migration that
--     changes the range replaces this one function.
--   * ob1_work_claim_cap(): the standing cap, or the builtin when none stands.
--     claim_work reads it. A stored cap the refusal names (a later migration
--     narrowed the range, or a raw write with the trigger off) raises, so a
--     claim fails loudly naming the cap and the fix rather than be capped by a
--     value the operator did not choose (132's principle, the maintainer
--     2026-11-11). This blocks every new claim until the cap is fixed — a wide
--     blast radius, but the state is reachable only by bypassing the trigger.
--   * set_work_claim_cap(cap, actor): the operator's write. Only a key the
--     registry classifies operator, named by its agent id (115's forced release,
--     SMD-2608's rule: a name alone lends no kind); any other answers
--     {ok: false, error: NOT_OPERATOR}. A cap the refusal names answers
--     {ok: false, error: BAD_CAP}. NULL clears, so the builtin stands. Setting
--     what stands already writes nothing ({changed: false}).
--   * work_claim_cap_setting(): the standing cap for brain_info, with what is
--     wrong with it, never raising.
--   * ob1_work_claim_holder_lock(name, agent_id) and
--     ob1_work_claim_holder_live_count(name, agent_id, now): the per-holder
--     advisory lock and the live-claim count claim_work takes under it. The
--     holder is the key's agent id when it has one (two sessions of one key
--     share the cap), its name alone when it does not (an unclassified key).
--   * claim_work: redefined to cap. After the per-ticket lock (115) and the
--     renewal branch, a new claim takes a per-holder advisory lock — after the
--     ticket lock, a consistent order, so no deadlock — counts the holder's live
--     claims under it, and refuses CLAIM_LIMIT at or above the cap before it
--     inserts. The lock makes count-then-insert atomic against the same holder's
--     concurrent claims on other tickets; without it two could each read one
--     below the cap and both insert.
--
-- WHO READS
--   Every role that claims work now reads the cap: the `claims` group
--   (db/config.mjs) gains SELECT, INSERT and UPDATE on work_claim_cap_settings,
--   and this file grants them to each role holding the group's grants on
--   work_claims already, so no role's claim_work fails on the upgrade (132's
--   carry). A role holding the group can write the table directly; the trigger
--   holds what a row may be, the setting standing when written and an operator
--   key's agent id on it and on its end, and set_work_claim_cap who may call it
--   (132's convention).
--
-- SAFETY
--   One new table, its key and a partial unique index, two triggers and eight
--   functions, and claim_work redefined with the same signature. Nothing stored
--   is changed. With no standing row the cap is the builtin 50, so a brain whose
--   keys each hold fewer than 50 live claims is unaffected on the upgrade. MINOR
--   under FORK.md's version rules. test-schema [126], test-upgrade [20cd].
--
-- Prerequisites
--   046 (ob1_registry_kind), 061 (ob1_actor_agent_id), 115 (work_claims,
--   claim_work and its helpers: ob1_work_claim_actor, ob1_work_claim_lock,
--   ob1_work_claims_in_the_way, ob1_work_claim_json). Applied by
--   `bun db/migrate.ts`. Re-applied: the table, its indexes and rows are kept,
--   and the functions and triggers are replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not hold
-- (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['ob1_registry_kind(uuid, text)', '046 (ob1_registry_kind)'],
    ARRAY['ob1_actor_agent_id()', '061 (ob1_actor_agent_id)'],
    ARRAY['claim_work(text, text, text, integer, text, jsonb)', '115 (claim_work)'],
    ARRAY['ob1_work_claim_actor(jsonb, text)', '115 (ob1_work_claim_actor)'],
    ARRAY['ob1_work_claim_lock(text)', '115 (ob1_work_claim_lock)'],
    ARRAY['ob1_work_claims_in_the_way(text, text, uuid, timestamp with time zone)', '115 (ob1_work_claims_in_the_way)'],
    ARRAY['ob1_work_claim_json(work_claims, timestamp with time zone)', '115 (ob1_work_claim_json)']];
  i int;
BEGIN
  IF to_regclass('work_claims') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 140 needs 115 (work_claims); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 140 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_work_claim_cap_builtin — the brain's own default cap
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_work_claim_cap_builtin()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 50 $$;
COMMENT ON FUNCTION ob1_work_claim_cap_builtin() IS
  'The brain''s own default per-holder cap on live work claims, 50. ob1_work_claim_cap() returns it when no operator setting stands. Generous: one key can back a fleet of worktrees (115: the dogfood''s sessions share a key), so 50 sits above the realistic peak while a hog blows past it. A retune replaces this function alone. Migration 140 / SMD-3606.';

-- ---------------------------------------------------------------------------
-- ob1_work_claim_cap_refusal — what is wrong with a cap value
-- ---------------------------------------------------------------------------
-- The one place the cap's range is spelled: the trigger, set_work_claim_cap and
-- ob1_work_claim_cap() read it, so a migration that changes the range replaces
-- this one function.
CREATE OR REPLACE FUNCTION ob1_work_claim_cap_refusal(p_cap integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_cap IS NULL THEN 'a cap is required'
    WHEN p_cap < 1 THEN format('a cap below 1 (%s): a cap of 0 would refuse every new claim', p_cap)
    WHEN p_cap > 100000 THEN format('a cap above 100000 (%s)', p_cap)
    ELSE NULL
  END
$$;
COMMENT ON FUNCTION ob1_work_claim_cap_refusal(integer) IS
  'What is wrong with a per-holder claim cap — NULL, below 1, or above 100000 — in words, or NULL for none. The one place the range is spelled: the setting''s trigger, set_work_claim_cap and ob1_work_claim_cap() read it; a migration changing the range replaces this one function. Migration 140 / SMD-3606.';

-- ---------------------------------------------------------------------------
-- work_claim_cap_settings — the operator's cap settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_claim_cap_settings (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cap               integer NOT NULL CHECK (cap >= 1),
  set_by            text NOT NULL CHECK (btrim(set_by) <> '' AND length(set_by) <= 200),
  set_by_agent_id   uuid NOT NULL,
  set_at            timestamptz NOT NULL,
  ended_at          timestamptz,
  ended_by          text CHECK (btrim(ended_by) <> '' AND length(ended_by) <= 200),
  ended_by_agent_id uuid,
  CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (ended_by_agent_id IS NULL))
);
COMMENT ON TABLE work_claim_cap_settings IS
  'The operator''s per-holder cap on live work claims (ob1_work_claim_cap(): the standing row''s cap, or ob1_work_claim_cap_builtin() when none stands). One row per setting, at most one standing (ended_at NULL); a row changes only to end, once, when the next cap or a clear replaces it, and a DELETE or TRUNCATE is refused, so the rows say which cap stood when. cap is checked by ob1_work_claim_cap_refusal when written. set_by and ended_by name the operator key by its name then, with its agent id, which the trigger holds to a key the registry classifies operator. Written through set_work_claim_cap, an operator key''s alone. Migration 140 / SMD-3606.';

CREATE UNIQUE INDEX IF NOT EXISTS work_claim_cap_settings_one_standing ON work_claim_cap_settings ((true)) WHERE ended_at IS NULL;

-- A row is checked when written, and is history after: it changes only to end,
-- once (132's guard, for the cap).
CREATE OR REPLACE FUNCTION ob1_work_claim_cap_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bad text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_bad := ob1_work_claim_cap_refusal(NEW.cap);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = v_bad, ERRCODE = 'invalid_parameter_value';
    END IF;
    -- A setting stands when written, and names an operator key by its agent id,
    -- as set_work_claim_cap admits one: a role writing the table directly cannot
    -- name any other (132's review pass 1).
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = 'work_claim_cap_settings: a setting stands when written; it ends when the next replaces it',
        ERRCODE = 'restrict_violation';
    END IF;
    IF ob1_registry_kind(NEW.set_by_agent_id, NULL) IS DISTINCT FROM 'operator' THEN
      RAISE EXCEPTION USING MESSAGE = format('work_claim_cap_settings: set_by_agent_id %s is no key the registry classifies operator', NEW.set_by_agent_id),
        ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The whole row but the three ending columns, as jsonb: a column a later
    -- migration adds is held without editing a list here (132's shape).
    IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
       AND to_jsonb(NEW) - ARRAY['ended_at', 'ended_by', 'ended_by_agent_id']
           = to_jsonb(OLD) - ARRAY['ended_at', 'ended_by', 'ended_by_agent_id'] THEN
      -- Ended by an operator key too, by its agent id.
      IF ob1_registry_kind(NEW.ended_by_agent_id, NULL) IS DISTINCT FROM 'operator' THEN
        RAISE EXCEPTION USING MESSAGE = format('work_claim_cap_settings: ended_by_agent_id %s is no key the registry classifies operator', NEW.ended_by_agent_id),
          ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      MESSAGE = 'work_claim_cap_settings is history: a row changes only to end, once',
      ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('work_claim_cap_settings is history: %s refused (set a new cap, or clear it, with set_work_claim_cap)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_work_claim_cap_settings_guard() IS
  'Refuses a work_claim_cap_settings row whose cap ob1_work_claim_cap_refusal names (22023, in its words), one written already ended, one whose set_by_agent_id (or, ending it, ended_by_agent_id) the registry does not classify operator (42501), an UPDATE other than a standing row ending once (ended_at, ended_by, ended_by_agent_id), and every DELETE and TRUNCATE — for the owner too. Migration 140 / SMD-3606.';

CREATE OR REPLACE TRIGGER work_claim_cap_settings_history
  BEFORE INSERT OR UPDATE OR DELETE ON work_claim_cap_settings
  FOR EACH ROW EXECUTE FUNCTION ob1_work_claim_cap_settings_guard();
CREATE OR REPLACE TRIGGER work_claim_cap_settings_no_truncate
  BEFORE TRUNCATE ON work_claim_cap_settings
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_work_claim_cap_settings_guard();

-- The claims group's grant, carried to the roles that hold it already (132's
-- carry): every claim reads this table from here on, so a role granted the
-- group before 140 would fail every claim_work until `migrate.ts --grant` ran
-- again. A role holding SELECT on work_claims gets SELECT here, and one holding
-- INSERT there gets INSERT and UPDATE, as db/config.mjs's group lists them; the
-- owner holds every privilege already. A re-apply grants what is held already,
-- which changes nothing.
DO $grant$
DECLARE
  v_item record;
BEGIN
  FOR v_item IN
    SELECT DISTINCT a.grantee, a.privilege_type
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'work_claims'::regclass AND a.grantee <> c.relowner AND a.privilege_type IN ('SELECT', 'INSERT')
  LOOP
    EXECUTE format('GRANT %s ON work_claim_cap_settings TO %s',
                   CASE v_item.privilege_type WHEN 'SELECT' THEN 'SELECT' ELSE 'INSERT, UPDATE' END,
                   CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END);
  END LOOP;
END
$grant$;

-- ---------------------------------------------------------------------------
-- ob1_work_claim_cap — the standing cap, under the builtin
-- ---------------------------------------------------------------------------
-- STABLE, as 132's reader: a prepared claim_work takes a new cap at its next
-- call.
CREATE OR REPLACE FUNCTION ob1_work_claim_cap()
RETURNS integer
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_set work_claim_cap_settings;
  v_bad text;
BEGIN
  SELECT * INTO v_set FROM work_claim_cap_settings WHERE ended_at IS NULL;
  IF NOT FOUND THEN
    RETURN ob1_work_claim_cap_builtin();
  END IF;
  -- Checked on every read, not only when written: a later migration may narrow
  -- the range under a stored cap. Raised, never skipped: a claim capped by a
  -- fallback would be capped by a value the operator did not choose and say
  -- nothing (132's principle, the maintainer 2026-11-11).
  v_bad := ob1_work_claim_cap_refusal(v_set.cap);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('the operator''s work-claim cap (set %s by %s) is refused, so no claim is capped: %s',
                       to_char(v_set.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_set.set_by, v_bad),
      HINT = 'Set it again, or clear it with SELECT set_work_claim_cap(<cap>, <actor>) in psql, an operator key',
      ERRCODE = 'data_exception';
  END IF;
  RETURN v_set.cap;
END
$$;
COMMENT ON FUNCTION ob1_work_claim_cap() IS
  'The per-holder cap on live work claims claim_work enforces: the standing operator setting (work_claim_cap_settings), or ob1_work_claim_cap_builtin() when none stands. A stored cap ob1_work_claim_cap_refusal names raises 22000 naming the setting, so every new claim fails rather than be capped by a value the operator did not choose (a renewal, which does not read the cap, is unaffected). Migration 140 / SMD-3606.';

-- ---------------------------------------------------------------------------
-- set_work_claim_cap — the operator's write
-- ---------------------------------------------------------------------------
-- One writer at a time, by a transaction advisory lock taken before the
-- standing row is read (132's set_priority_weights).
CREATE OR REPLACE FUNCTION set_work_claim_cap(p_cap integer DEFAULT NULL, p_actor jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_who  record;
  v_kind text;
  v_bad  text;
  v_old  work_claim_cap_settings;
  v_new  work_claim_cap_settings;
  v_now  timestamptz;
BEGIN
  SELECT * INTO v_who FROM ob1_work_claim_actor(p_actor, 'set_work_claim_cap');
  -- The operator's kind by its agent id alone: a name is anyone's to write in
  -- an envelope, so it lends no kind (SMD-2608's rule, as 115's forced release
  -- reads it).
  v_kind := CASE WHEN v_who.agent_id IS NULL THEN NULL ELSE ob1_registry_kind(v_who.agent_id, NULL) END;
  IF v_who.agent_id IS NULL OR v_kind IS DISTINCT FROM 'operator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR', 'key', v_who.name, 'kind', v_kind,
      'message', format('only an operator key, named by its agent id, may set the work-claim cap; %s is %s', v_who.name,
                        CASE WHEN v_who.agent_id IS NULL THEN 'named by its name alone' ELSE COALESCE(v_kind, 'unclassified') END));
  END IF;
  IF p_cap IS NOT NULL THEN
    v_bad := ob1_work_claim_cap_refusal(p_cap);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_CAP', 'message', v_bad);
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:work-claim-cap', 0));
  v_now := clock_timestamp();
  SELECT * INTO v_old FROM work_claim_cap_settings WHERE ended_at IS NULL FOR UPDATE;
  IF v_old.cap IS NOT DISTINCT FROM p_cap THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'cap', p_cap, 'previous', p_cap,
      'set_at', v_old.set_at, 'set_by', v_old.set_by);
  END IF;
  IF v_old.id IS NOT NULL THEN
    UPDATE work_claim_cap_settings SET ended_at = v_now, ended_by = v_who.name, ended_by_agent_id = v_who.agent_id
     WHERE id = v_old.id;
  END IF;
  IF p_cap IS NOT NULL THEN
    INSERT INTO work_claim_cap_settings (cap, set_by, set_by_agent_id, set_at)
    VALUES (p_cap, v_who.name, v_who.agent_id, v_now)
    RETURNING * INTO v_new;
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', true, 'cap', p_cap, 'previous', v_old.cap,
    'set_at', CASE WHEN p_cap IS NULL THEN NULL ELSE v_new.set_at END, 'set_by', CASE WHEN p_cap IS NULL THEN NULL ELSE v_new.set_by END);
END
$$;
COMMENT ON FUNCTION set_work_claim_cap(integer, jsonb) IS
  'The operator sets the per-holder cap on live work claims claim_work enforces. Only a key the registry classifies operator, named by its agent id in p_actor (a name alone lends no kind); any other answers {ok: false, error: NOT_OPERATOR, key, kind, message}. A cap ob1_work_claim_cap_refusal names answers {ok: false, error: BAD_CAP, message}. NULL clears it, so ob1_work_claim_cap_builtin() stands. Otherwise {ok: true, changed, cap, previous, set_at, set_by}: the standing row ends and the new one is written, or nothing when the cap is the one standing (changed false). Migration 140 / SMD-3606.';

-- ---------------------------------------------------------------------------
-- work_claim_cap_setting — the standing cap, for brain_info
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work_claim_cap_setting()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_set work_claim_cap_settings;
BEGIN
  SELECT * INTO v_set FROM work_claim_cap_settings WHERE ended_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('cap', ob1_work_claim_cap_builtin(), 'source', 'builtin');
  END IF;
  RETURN jsonb_build_object('cap', v_set.cap, 'source', 'operator',
    'set_at', to_char(v_set.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'set_by', v_set.set_by,
    'refused', ob1_work_claim_cap_refusal(v_set.cap));
END
$$;
COMMENT ON FUNCTION work_claim_cap_setting() IS
  'The standing per-holder claim cap for brain_info: {cap, source: builtin} when none is set, else {cap, source: operator, set_at, set_by, refused} where refused is ob1_work_claim_cap_refusal''s word on it or null. Never raises, unlike ob1_work_claim_cap(). Migration 140 / SMD-3606.';

-- ---------------------------------------------------------------------------
-- ob1_work_claim_holder_lock — one new claim at a time per holder
-- ---------------------------------------------------------------------------
-- The holder: its key's agent id when it has one (two sessions of one key share
-- the cap), its name alone when it does not. Keyed apart from the per-ticket
-- lock (115's 'ob1:work-claim:'), and always taken after it, so the two never
-- deadlock.
CREATE OR REPLACE FUNCTION ob1_work_claim_holder_lock(p_name text, p_agent_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('ob1:work-claim-holder:' || COALESCE(p_agent_id::text, 'name:' || p_name), 0))
$$;
COMMENT ON FUNCTION ob1_work_claim_holder_lock(text, uuid) IS
  'A transaction advisory lock on one holder — its agent id, or its name when it has none — so claim_work counts the holder''s live claims and inserts under one lock, atomic against the same holder''s concurrent claims on other tickets. Taken after the per-ticket lock (115), a consistent order, so the two never deadlock. Migration 140 / SMD-3606.';

-- ---------------------------------------------------------------------------
-- ob1_work_claim_holder_live_count — the holder's live claims
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_work_claim_holder_live_count(p_name text, p_agent_id uuid, p_now timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
  SELECT count(*)::int FROM work_claims c
   WHERE c.released_at IS NULL AND c.expires_at > p_now
     AND CASE WHEN p_agent_id IS NULL
              THEN c.holder_agent_id IS NULL AND c.holder_name = p_name
              ELSE c.holder_agent_id = p_agent_id END
$$;
COMMENT ON FUNCTION ob1_work_claim_holder_live_count(text, uuid, timestamp with time zone) IS
  'How many LIVE claims a holder holds — unreleased and unexpired as of p_now, the "free" count 115 defines, so a lapsed claim does not count. The holder is its agent id when it has one (two sessions of one key counted as one holder), its name alone when it does not. claim_work counts them under ob1_work_claim_holder_lock before it inserts. Migration 140 / SMD-3606.';

-- ---------------------------------------------------------------------------
-- claim_work — 115's, with the per-holder cap on a new claim
-- ---------------------------------------------------------------------------
-- 115's body unchanged but for the cap block marked SMD-3606 below: a new claim
-- (past the renewal branch, which changes no count and is exempt) is refused
-- CLAIM_LIMIT at or above the holder's cap, counted under a per-holder lock.
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
    UPDATE work_claims SET expires_at = v_now + v_lease, renewed_at = v_now, label = COALESCE(v_label, label)
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
  'Claims a ticket, or one piece of it, under a lease, so two agents never build one change (115, SMD-3597). The caller''s own claim on exactly this work (key and token) is renewed, not refused, and reads no cap; any other live claim on the same work refuses it WORK_CLAIMED; a lapsed claim on exactly this work is taken over. A NEW claim past the holder''s cap on live claims (ob1_work_claim_cap(), counted under a per-holder lock) is refused CLAIM_LIMIT (SMD-3606, migration 140). Returns {outcome, code, message, claim, held_by, token}; token once, on a claim. Migration 140 redefines 115''s to add the cap.';
