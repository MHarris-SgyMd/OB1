-- =============================================================================
-- Migration 132: the operator's priority weights, which every read takes as
--                its defaults (SMD-4193 PR 2)
-- =============================================================================
--
-- WHY
--   The maintainer chose (SMD-4193, 2026-11-10) both a call's own weights
--   (PR 1, migration 131) and an operator's setting that every read takes as
--   its defaults. Until now the defaults changed only by a migration
--   replacing ob1_priority_defaults() (128), so an operator who disagreed
--   with level first (SMD-4177) had to pass weights on every call.
--
-- WHAT
--   The maintainer chose (2026-11-11) that the setting is set by a SQL
--   function and by an operation an operator key alone may call, and that a
--   bad setting is refused when written and, if one is stored anyway, fails
--   every read loudly rather than being skipped.
--   * priority_weight_settings: the operator's settings, one row each, a
--     standing one at most (ended_at NULL). A row is history: it changes only
--     to end, once, when the next setting or a clear replaces it; a DELETE or
--     TRUNCATE is refused. Its weights are overrides by name, as a call's are
--     (131), never empty: a clear ends the standing row and writes none. Its
--     own table, not an ob1_config row: the server's roles hold SELECT alone
--     on ob1_config (db/config.mjs), and a grant to write it would let them
--     write the embedding model's row too.
--   * ob1_priority_builtin(): 128's ob1_priority_defaults() constant (127's
--     values), unchanged. A retune of the brain's own defaults now replaces
--     this function alone.
--   * ob1_priority_weights_refusal(weights): what is wrong with a set of
--     overrides, in effective_priority's own words (122's names and ranges,
--     cap against unblocks_many_at), or NULL. It mirrors effective_priority's
--     checks, as ob1_priority_span mirrors its composition: a migration that
--     changes a name or a range replaces both. test-schema [119] holds the
--     two to the same answer at each weight's edges.
--   * ob1_priority_defaults(): the built-in weights with the standing
--     setting laid over them. Every read takes it, as since 128:
--     effective_priority (the agenda, search's window and labels) and both
--     spans. A stored setting the refusal names (a later migration narrowed a
--     range, or a raw write with the trigger off) raises data_exception
--     naming the setting and the weight, so no read orders by weights the
--     operator did not choose; 22000, not 22023, so the server answers it as
--     the brain's fault and never as the caller's bad weight.
--   * set_priority_weights(weights, actor): the operator's write. Only a key
--     the registry classifies operator, named by its agent id (115's forced
--     release, SMD-2608's rule: a name alone lends no kind); any other answers
--     {ok: false, error: NOT_OPERATOR}. Weights the refusal names answer
--     {ok: false, error: BAD_WEIGHTS} in its words. NULL or {} clears.
--     Setting what stands already writes nothing ({changed: false}).
--   * priority_weight_setting(): the standing setting for brain_info, with
--     what is wrong with it, never raising.
--
-- WHO READS
--   Every role that reads an effective priority now reads the table: the
--   `priority` group (db/config.mjs) gains SELECT, INSERT and UPDATE on it,
--   which the server roles that call effective_priority already hold. As for
--   every core table a group writes, a role holding it can still write the
--   table directly; the trigger holds what a row may be, the setting standing
--   when written and an operator key's agent id on it and on its end, and the
--   function who may call it (116's convention, narrowed in review pass 1).
--
-- SAFETY
--   One new table, its key and a partial unique index, two triggers and six
--   functions; ob1_priority_defaults() replaced with the same signature and,
--   with no setting, the same answer. Nothing stored is changed. With no
--   standing row every read is as before 132. MINOR under FORK.md's version
--   rules. test-schema [119], test-upgrade [20bw].
--
-- Prerequisites
--   008 (ob1_current_actor), 046 (ob1_registry_kind), 061
--   (ob1_actor_agent_id), 116 (ob1_priority_actor), 128
--   (ob1_priority_defaults, ob1_priority_span, effective_priority reading
--   them), 131 (ob1_priority_span(jsonb)). Applied by `bun db/migrate.ts`.
--   Re-applied: the table, its indexes and rows are kept, and the functions
--   and triggers are replaced as they were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['ob1_current_actor()', '008 (ob1_current_actor)'],
    ARRAY['ob1_registry_kind(uuid, text)', '046 (ob1_registry_kind)'],
    ARRAY['ob1_actor_agent_id()', '061 (ob1_actor_agent_id)'],
    ARRAY['ob1_priority_actor(jsonb, text)', '116 (ob1_priority_actor)'],
    ARRAY['ob1_priority_defaults()', '128 (ob1_priority_defaults)'],
    ARRAY['ob1_priority_span()', '128 (ob1_priority_span)'],
    ARRAY['effective_priority(jsonb, jsonb, timestamp with time zone)', '128 (effective_priority)'],
    ARRAY['ob1_priority_span(jsonb)', '131 (ob1_priority_span(jsonb))']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 132 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_priority_builtin — the brain's own default weights
-- ---------------------------------------------------------------------------
-- docs/priority.md's weights, level first (SMD-4177, the maintainer,
-- 2026-11-09): 128's constant, moved here unchanged. See 128 for why each
-- value is what it is.
CREATE OR REPLACE FUNCTION ob1_priority_builtin()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT '{"unknown": 2, "hop": 1, "hops": 2, "soon": 0.4, "soon_days": 1, "week": 0.2, "week_days": 7, "overdue": 0.6,
           "unblocks_one": 0.1, "unblocks_many": 0.2, "unblocks_many_at": 3, "depth": 3, "cap": 50, "count_inferred": false}'::jsonb
$$;
COMMENT ON FUNCTION ob1_priority_builtin() IS
  'The brain''s own default weights (docs/priority.md decision 5, level first since SMD-4177): unknown 2, hop 1, hops 2, soon 0.4 by the end of soon_days 1, week 0.2 by the end of week_days 7, overdue 0.6, unblocks_one 0.1, unblocks_many 0.2 from unblocks_many_at 3, depth 3, cap 50, count_inferred false. ob1_priority_defaults() lays the operator''s standing setting over them. A retune replaces this function alone. Migration 132 / SMD-4193 (128''s constant, moved).';

-- ---------------------------------------------------------------------------
-- ob1_priority_weights_refusal — what is wrong with a set of overrides
-- ---------------------------------------------------------------------------
-- effective_priority's checks (122, 128) and its words, over the built-in
-- weights: it cannot read effective_priority itself, which reads
-- ob1_priority_defaults(), which reads this. A migration that changes a name
-- or a range in one replaces the other.
CREATE OR REPLACE FUNCTION ob1_priority_weights_refusal(p_weights jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  c_builtin CONSTANT jsonb := ob1_priority_builtin();
  v_w       jsonb;
  v_bad     text;
BEGIN
  IF p_weights IS NULL THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_weights) <> 'object' THEN
    RETURN 'effective_priority''s weights are a JSON object of overrides';
  END IF;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad FROM jsonb_object_keys(p_weights) k WHERE NOT c_builtin ? k;
  IF v_bad IS NOT NULL THEN
    RETURN format('not a weight: %s (the weights are %s)', left(v_bad, 200),
                  (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(c_builtin) k));
  END IF;
  v_w := c_builtin || p_weights;
  SELECT string_agg(k, ', ' ORDER BY k) INTO v_bad
    FROM jsonb_each(v_w) e(k, v)
   WHERE CASE
           WHEN k = 'count_inferred' THEN jsonb_typeof(v) <> 'boolean'
           WHEN jsonb_typeof(v) <> 'number' THEN true
           WHEN k IN ('hops', 'soon_days', 'week_days', 'unblocks_many_at', 'depth', 'cap') THEN
             v::numeric <> trunc(v::numeric) OR v::numeric < CASE WHEN k IN ('cap', 'unblocks_many_at') THEN 1 ELSE 0 END
             OR v::numeric > CASE k WHEN 'cap' THEN 1000 WHEN 'depth' THEN 5 WHEN 'hops' THEN 2 ELSE 366 END
           ELSE v::numeric < 0 OR v::numeric > 10
         END;
  IF v_bad IS NOT NULL THEN
    RETURN format('a weight out of range: %s (count_inferred a boolean; hops a whole number 0 to 2, depth 0 to 5, cap 1 to 1000, soon_days, week_days and unblocks_many_at whole numbers to 366; every other a number 0 to 10)', v_bad);
  END IF;
  IF (v_w->>'cap')::numeric < (v_w->>'unblocks_many_at')::numeric THEN
    RETURN 'a weight out of range: cap is below unblocks_many_at, so the larger unblocks term could never be reached';
  END IF;
  RETURN NULL;
END
$$;
COMMENT ON FUNCTION ob1_priority_weights_refusal(jsonb) IS
  'What is wrong with a set of priority weight overrides, in effective_priority''s words — not a JSON object, a name that is not a weight, a value out of its range, cap below unblocks_many_at — over ob1_priority_builtin(), or NULL for none (NULL weights included). It mirrors effective_priority''s checks, which it cannot call: a migration changing a name or a range replaces both. The setting''s trigger, set_priority_weights and ob1_priority_defaults() read it. Migration 132 / SMD-4193.';

-- ---------------------------------------------------------------------------
-- priority_weight_settings — the operator's settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS priority_weight_settings (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  weights           jsonb NOT NULL CHECK (jsonb_typeof(weights) = 'object' AND weights <> '{}'::jsonb),
  set_by            text NOT NULL CHECK (btrim(set_by) <> '' AND length(set_by) <= 200),
  set_by_agent_id   uuid NOT NULL,
  set_at            timestamptz NOT NULL,
  ended_at          timestamptz,
  ended_by          text CHECK (btrim(ended_by) <> '' AND length(ended_by) <= 200),
  ended_by_agent_id uuid,
  CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (ended_by_agent_id IS NULL))
);
COMMENT ON TABLE priority_weight_settings IS
  'The operator''s priority weights, which every read takes as its defaults (ob1_priority_defaults(): ob1_priority_builtin() with the standing row''s weights laid over them by name). One row per setting, at most one standing (ended_at NULL); a row changes only to end, once, when the next setting or a clear replaces it, and a DELETE or TRUNCATE is refused, so the rows say which weights stood when. weights are overrides by name, never empty, checked by ob1_priority_weights_refusal when written. set_by and ended_by name the operator key by its name then, with its agent id, which the trigger holds to a key the registry classifies operator. Written through set_priority_weights, an operator key''s alone. Migration 132 / SMD-4193.';

CREATE UNIQUE INDEX IF NOT EXISTS priority_weight_settings_one_standing ON priority_weight_settings ((true)) WHERE ended_at IS NULL;

-- A row is checked when written, and is history after: it changes only to
-- end, once.
CREATE OR REPLACE FUNCTION ob1_priority_weight_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_bad text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_bad := ob1_priority_weights_refusal(NEW.weights);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = v_bad, ERRCODE = 'invalid_parameter_value';
    END IF;
    -- A setting stands when written, and names an operator key by its agent
    -- id, as set_priority_weights admits one: a role writing the table
    -- directly cannot name any other (review pass 1).
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION USING MESSAGE = 'priority_weight_settings: a setting stands when written; it ends when the next replaces it',
        ERRCODE = 'restrict_violation';
    END IF;
    IF ob1_registry_kind(NEW.set_by_agent_id, NULL) IS DISTINCT FROM 'operator' THEN
      RAISE EXCEPTION USING MESSAGE = format('priority_weight_settings: set_by_agent_id %s is no key the registry classifies operator', NEW.set_by_agent_id),
        ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The whole row but the three ending columns, as jsonb: a column a later
    -- migration adds is held without editing a list here (116's shape).
    IF OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL
       AND to_jsonb(NEW) - ARRAY['ended_at', 'ended_by', 'ended_by_agent_id']
           = to_jsonb(OLD) - ARRAY['ended_at', 'ended_by', 'ended_by_agent_id'] THEN
      -- Ended by an operator key too, by its agent id.
      IF ob1_registry_kind(NEW.ended_by_agent_id, NULL) IS DISTINCT FROM 'operator' THEN
        RAISE EXCEPTION USING MESSAGE = format('priority_weight_settings: ended_by_agent_id %s is no key the registry classifies operator', NEW.ended_by_agent_id),
          ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
      MESSAGE = 'priority_weight_settings is history: a row changes only to end, once',
      ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION USING
    MESSAGE = format('priority_weight_settings is history: %s refused (set new weights, or clear them, with set_priority_weights)', TG_OP),
    ERRCODE = 'restrict_violation';
END;
$$;
COMMENT ON FUNCTION ob1_priority_weight_settings_guard() IS
  'Refuses a priority_weight_settings row whose weights ob1_priority_weights_refusal names (22023, in its words), one written already ended, one whose set_by_agent_id (or, ending it, ended_by_agent_id) the registry does not classify operator (42501), an UPDATE other than a standing row ending once (ended_at, ended_by, ended_by_agent_id), and every DELETE and TRUNCATE — for the owner too. Migration 132 / SMD-4193.';

CREATE OR REPLACE TRIGGER priority_weight_settings_history
  BEFORE INSERT OR UPDATE OR DELETE ON priority_weight_settings
  FOR EACH ROW EXECUTE FUNCTION ob1_priority_weight_settings_guard();
CREATE OR REPLACE TRIGGER priority_weight_settings_no_truncate
  BEFORE TRUNCATE ON priority_weight_settings
  FOR EACH STATEMENT EXECUTE FUNCTION ob1_priority_weight_settings_guard();

-- ---------------------------------------------------------------------------
-- ob1_priority_defaults — the built-in weights under the operator's setting
-- ---------------------------------------------------------------------------
-- STABLE, as 128's, so a prepared read takes a new setting at its next call.
CREATE OR REPLACE FUNCTION ob1_priority_defaults()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_set priority_weight_settings;
  v_bad text;
BEGIN
  SELECT * INTO v_set FROM priority_weight_settings WHERE ended_at IS NULL;
  IF NOT FOUND THEN
    RETURN ob1_priority_builtin();
  END IF;
  -- Checked on every read, not only when written: a later migration may
  -- narrow a range or rename a weight under a stored setting. Raised, never
  -- skipped: a read that fell back would order by weights the operator did
  -- not choose and say nothing (the maintainer, 2026-11-11).
  v_bad := ob1_priority_weights_refusal(v_set.weights);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = format('the operator''s priority weights (set %s by %s) are refused, so no effective priority is read: %s',
                       to_char(v_set.set_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), v_set.set_by, v_bad),
      HINT = 'Set them again, or clear them with {}: the set_priority_weights operation (an operator key), or SELECT set_priority_weights(<weights>, <actor>) in psql',
      ERRCODE = 'data_exception';
  END IF;
  RETURN ob1_priority_builtin() || v_set.weights;
END
$$;
COMMENT ON FUNCTION ob1_priority_defaults() IS
  'effective_priority''s default weights: ob1_priority_builtin() with the operator''s standing setting (priority_weight_settings) laid over them by name; the built-in weights alone when none stands. effective_priority reads them, a call''s own weights overriding them by name, and ob1_priority_span the largest sum they allow. A stored setting ob1_priority_weights_refusal names raises 22000 naming the setting and the weight, so every read fails rather than order by weights the operator did not choose. Migration 128 / SMD-4194; the operator''s setting, migration 132 / SMD-4193.';

-- ---------------------------------------------------------------------------
-- set_priority_weights — the operator's write
-- ---------------------------------------------------------------------------
-- One writer at a time, by a transaction advisory lock taken before the
-- standing row is read; under READ COMMITTED that read sees every setting
-- committed before the lock was granted. Above READ COMMITTED the read may
-- predate the lock, and the partial unique index refuses the second insert.
CREATE OR REPLACE FUNCTION set_priority_weights(p_weights jsonb, p_actor jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_who  record;
  v_kind text;
  v_bad  text;
  v_w    jsonb;
  v_old  priority_weight_settings;
  v_new  priority_weight_settings;
  v_now  timestamptz;
BEGIN
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'set_priority_weights');
  -- The operator's kind by its agent id alone: a name is anyone's to write
  -- in an envelope, so it lends no kind (SMD-2608's rule, as 115's forced
  -- release reads it).
  v_kind := CASE WHEN v_who.env_agent_id IS NULL THEN NULL ELSE ob1_registry_kind(v_who.env_agent_id, NULL) END;
  IF v_who.env_agent_id IS NULL OR v_kind IS DISTINCT FROM 'operator' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_OPERATOR', 'key', v_who.name, 'kind', v_kind,
      'message', format('only an operator key, named by its agent id, may set the priority weights; %s is %s', v_who.name,
                        CASE WHEN v_who.env_agent_id IS NULL THEN 'named by its name alone' ELSE COALESCE(v_kind, 'unclassified') END));
  END IF;
  v_bad := ob1_priority_weights_refusal(p_weights);
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_WEIGHTS', 'message', v_bad);
  END IF;
  v_w := NULLIF(p_weights, '{}'::jsonb);

  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:priority-weights', 0));
  v_now := clock_timestamp();
  SELECT * INTO v_old FROM priority_weight_settings WHERE ended_at IS NULL FOR UPDATE;
  IF v_old.weights IS NOT DISTINCT FROM v_w THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'weights', v_w, 'previous', v_w,
      'set_at', v_old.set_at, 'set_by', v_old.set_by);
  END IF;
  IF v_old.id IS NOT NULL THEN
    UPDATE priority_weight_settings SET ended_at = v_now, ended_by = v_who.name, ended_by_agent_id = v_who.env_agent_id
     WHERE id = v_old.id;
  END IF;
  IF v_w IS NOT NULL THEN
    INSERT INTO priority_weight_settings (weights, set_by, set_by_agent_id, set_at)
    VALUES (v_w, v_who.name, v_who.env_agent_id, v_now)
    RETURNING * INTO v_new;
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', true, 'weights', v_w, 'previous', v_old.weights,
    'set_at', CASE WHEN v_w IS NULL THEN NULL ELSE v_new.set_at END, 'set_by', CASE WHEN v_w IS NULL THEN NULL ELSE v_new.set_by END);
END
$$;
COMMENT ON FUNCTION set_priority_weights(jsonb, jsonb) IS
  'The operator sets the priority weights every read takes as its defaults: overrides by name over ob1_priority_builtin(), as a call''s own weights are; NULL or {} clears them, so the built-in weights stand. Only a key the registry classifies operator, named by its agent id in p_actor (a name alone lends no kind); any other answers {ok: false, error: NOT_OPERATOR, key, kind, message}. Weights ob1_priority_weights_refusal names answer {ok: false, error: BAD_WEIGHTS, message} in effective_priority''s words. Otherwise {ok: true, changed, weights, previous, set_at, set_by}: the standing row ends and the new one is written, or nothing when the weights are those standing (changed false). Migration 132 / SMD-4193.';

-- ---------------------------------------------------------------------------
-- priority_weight_setting — the standing setting, for brain_info
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION priority_weight_setting()
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object('weights', s.weights, 'set_at', s.set_at, 'set_by', s.set_by,
                            'refused', ob1_priority_weights_refusal(s.weights))
    FROM priority_weight_settings s
   WHERE s.ended_at IS NULL
$$;
COMMENT ON FUNCTION priority_weight_setting() IS
  'The operator''s standing priority weights as {weights, set_at, set_by, refused} — refused naming what is wrong with them in effective_priority''s words, which fails every read, else NULL — or NULL when none stands and the built-in weights are the defaults. Never raises on a bad setting: brain_info reads it to say so. Migration 132 / SMD-4193.';
