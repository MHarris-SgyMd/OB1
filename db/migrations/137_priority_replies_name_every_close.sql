-- =============================================================================
-- Migration 137: a priority write names every statement it closed, and the
--                item it was asked about (SMD-4238)
-- =============================================================================
--
-- WHY
--   133 made a ticket and its own board-sync rows one item to the writers:
--   a key's new statement on either closes every open statement the key
--   holds across them, and a clear naming either closes them all. The
--   answers still named one statement: assert_priority's `replaced` and
--   clear_priority's `assertion` are the newest closed. A key with two open
--   statements in one pool (a thought that became the ticket's row late, a
--   by-name statement beside a by-id one) heard of one. And clear_priority's
--   answer did not say which item was asked, so the server read the closed
--   statement's item as the one named: a clear on ticket PRB-60 that closed
--   the key's statement on its row answered "Cleared your statement on
--   thought …", and the winner was placed relative to the row.
--
-- WHAT
--   * assert_priority and clear_priority (133's, carried whole) gain two
--     keys in every answer: `item`, the item named as ob1_priority_item keys
--     it, and `closed`, every statement the call closed, newest first ([]
--     when it closed none). `replaced` and `assertion` stay, the newest of
--     `closed`, for a reader of the old keys.
--   * ob1_priority_closed_json(ids): the statements with those ids as 116's
--     ob1_priority_json renders each, newest first.
--   * `closed` holds what the call's own UPDATE closed. A statement that a
--     delete closed between the call's read and its write (136's trigger
--     takes no priority lock) is not among them, and assert_priority's
--     `replaced` is the newest statement still open when locked (review
--     pass 1: 133 locked the newest read, which such a delete may have
--     closed, so `replaced` could name one the call never closed).
--
--   NOT CHANGED. A set that checked its item exists before a delete
--   committed still writes its statement on the deleted item, which
--   ob1_close_orphan_priorities() closes: 136's choice, kept (the
--   maintainer, review pass 2). A re-check after the lock would narrow the
--   gap, not close it: a delete landing after the re-check leaves the same.
--
-- SAFETY
--   Two functions replaced with their signatures and return types; one new
--   STABLE SQL function. No table, grant or row changes. The answers only
--   gain keys. MINOR under FORK.md's version rules. test-schema [124],
--   test-upgrade [20cb].
--
-- Prerequisites
--   What the carried bodies call: 115 (ob1_work_claim_text), 116
--   (priority_assertions, ob1_priority_json and the writers' helpers), 117
--   (ob1_item_lock, ob1_envelope_plugin, ob1_priority_owns_item), 122
--   (ob1_priority_open) and 133 (ob1_priority_lock, ob1_priority_lock_key,
--   ob1_priority_winner, ob1_priority_project). Applied by
--   `bun db/migrate.ts`. Re-applied: the functions are replaced as they
--   were.
-- =============================================================================

-- Refused up front, by name, on a schema the ledger records but does not
-- hold (052's shape).
DO $qc$
DECLARE
  v_need text[][] := ARRAY[
    ARRAY['ob1_work_claim_text(text, integer, text)', '115 (ob1_work_claim_text)'],
    ARRAY['ob1_priority_item(text, text)', '116 (ob1_priority_item)'],
    ARRAY['ob1_priority_item_exists(text, text)', '116 (ob1_priority_item_exists)'],
    ARRAY['ob1_priority_isolation(text)', '116 (ob1_priority_isolation)'],
    ARRAY['ob1_priority_tier(boolean, boolean, text)', '116 (ob1_priority_tier)'],
    ARRAY['ob1_priority_json(priority_assertions)', '116 (ob1_priority_json)'],
    ARRAY['ob1_priority_is_maker(priority_assertions, text, uuid)', '116 (ob1_priority_is_maker)'],
    ARRAY['ob1_priority_actor(jsonb, text)', '116 (ob1_priority_actor)'],
    ARRAY['ob1_item_lock(uuid)', '117 (ob1_item_lock)'],
    ARRAY['ob1_envelope_plugin(text)', '117 (ob1_envelope_plugin)'],
    ARRAY['ob1_priority_owns_item(text, text, uuid, text)', '117 (ob1_priority_owns_item)'],
    ARRAY['ob1_priority_open(text, text)', '122 (ob1_priority_open)'],
    ARRAY['ob1_priority_lock_key(text, text)', '133 (ob1_priority_lock_key)'],
    ARRAY['ob1_priority_lock(text, text)', '133 (ob1_priority_lock)'],
    ARRAY['ob1_priority_winner(text, text)', '133 (ob1_priority_winner)'],
    ARRAY['ob1_priority_project(text, text)', '133 (ob1_priority_project)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 137 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_priority_closed_json
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_priority_closed_json(p_ids uuid[])
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(ob1_priority_json(a) ORDER BY a.seq DESC), '[]'::jsonb)
    FROM priority_assertions a
   WHERE a.id = ANY(p_ids)
$$;
COMMENT ON FUNCTION ob1_priority_closed_json(uuid[]) IS
  'The statements with these ids, each as ob1_priority_json renders it, newest first (by seq); [] for none. The `closed` list of assert_priority''s and clear_priority''s answers. Migration 137 / SMD-4238.';


-- ---------------------------------------------------------------------------
-- assert_priority
-- ---------------------------------------------------------------------------
-- 133's, but its answer names the item named and every statement it closed.
CREATE OR REPLACE FUNCTION assert_priority(
  p_kind         text,
  p_key          text,
  p_level        int,
  p_due_at       timestamptz DEFAULT NULL,
  p_not_before   timestamptz DEFAULT NULL,
  p_due_ref_kind text        DEFAULT NULL,
  p_due_ref_key  text        DEFAULT NULL,
  p_reason       text        DEFAULT NULL,
  p_inferred     boolean     DEFAULT false,
  p_actor        jsonb       DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item     record := ob1_priority_item(p_kind, p_key);
  v_named    jsonb;
  v_closed   uuid[] := '{}';
  v_ref_kind text;
  v_ref_key  text;
  v_open     int;
  v_reason   text   := ob1_work_claim_text(p_reason, 1000, 'a reason');
  v_who      record;
  v_now      timestamptz;
  v_id       uuid   := gen_random_uuid();
  v_mine     boolean;
  v_plugin   text;
  v_tier     smallint;
  v_own      uuid[];
  v_old      priority_assertions;
  v_row      priority_assertions;
  v_win      priority_assertions;
BEGIN
  v_named := jsonb_build_object('kind', v_item.kind, 'key', v_item.key);
  IF p_level IS NULL OR p_level < 0 OR p_level > 5 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('a priority level is 0 (none) to 5 (critical); %s is not', COALESCE(p_level::text, 'NULL')),
      ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_due_at IS NOT NULL AND p_not_before IS NOT NULL AND p_not_before > p_due_at THEN
    RAISE EXCEPTION USING MESSAGE = 'not_before is after due_at: the item could not start before it is due', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_due_ref_kind IS NULL) <> (p_due_ref_key IS NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'a due reference takes both a kind and a key, or neither', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_due_ref_kind IS NOT NULL THEN
    SELECT r.kind, r.key INTO v_ref_kind, v_ref_key FROM ob1_priority_item(p_due_ref_kind, p_due_ref_key) r;
    IF v_ref_kind = v_item.kind AND v_ref_key = v_item.key THEN
      RAISE EXCEPTION USING MESSAGE = 'an item''s due reference may not name itself', ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  PERFORM ob1_priority_isolation('assert_priority');
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'assert_priority');
  v_tier := ob1_priority_tier(p_inferred, v_who.source, v_who.trust);

  -- Fail closed: the envelope states a scope that may write, write or capture
  -- (116's review pass 1).
  IF v_who.scope IS DISTINCT FROM 'write' AND v_who.scope IS DISTINCT FROM 'capture' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'READ_ONLY_KEY',
      'message', format('%s states no write or capture scope, so it may not state a priority', v_who.name),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL, 'item', v_named, 'closed', '[]'::jsonb);
  END IF;

  -- The pool's lock (a ticket's row locks as its ticket), before any read.
  PERFORM ob1_priority_lock(v_item.kind, v_item.key);
  -- A capture-only key states a priority only on a thought its agent captured
  -- and nobody has taken (082), or an open item it opened and nobody else has
  -- changed or its plugin's row stands for (117), and takes its due time only
  -- from another such item. Asked once, under the item's lock, a share lock on
  -- the thoughts' rows and the open items' own advisory locks (a take in flight
  -- is waited for: an item writer takes its item's lock first; a row lock
  -- would need UPDATE on open_items, which the priority group does not grant —
  -- 117's review pass 1), and before any existence answer, refused alike for an
  -- item that is not there (116's review passes 1, 2 and 5). A ticket or an
  -- entity is refused first: its key is no thought's or open item's id.
  IF v_who.scope = 'capture' THEN
    IF v_item.kind NOT IN ('thought', 'item') OR (v_ref_kind IS NOT NULL AND v_ref_kind NOT IN ('thought', 'item')) THEN
      v_mine := false;
    ELSE
      -- The items' locks first, in id order, then the thoughts' share lock: the
      -- order the item writers take them in (an item's lock, then its evidence
      -- thought's), so no two calls wait on each other (117's review pass 2).
      PERFORM ob1_item_lock(k)
         FROM unnest(ARRAY[CASE WHEN v_item.kind = 'item' THEN v_item.key::uuid END, CASE WHEN v_ref_kind = 'item' THEN v_ref_key::uuid END]) AS k
        WHERE k IS NOT NULL
        ORDER BY k;
      PERFORM 1 FROM thoughts t
       WHERE t.id IN (CASE WHEN v_item.kind = 'thought' THEN v_item.key::uuid END, CASE WHEN v_ref_kind = 'thought' THEN v_ref_key::uuid END)
       FOR SHARE;
      v_plugin := ob1_envelope_plugin('assert_priority');
      v_mine := ob1_priority_owns_item(v_item.kind, v_item.key, v_who.env_agent_id, v_plugin)
                AND (v_ref_kind IS NULL OR ob1_priority_owns_item(v_ref_kind, v_ref_key, v_who.env_agent_id, v_plugin));
    END IF;
    IF NOT v_mine THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_YOURS',
        'message', format('%s is a capture-only key: it may state a priority only on a thought it captured or an open item it opened (or its plugin''s row stands for), and take a due time only from another', v_who.name),
        'assertion', NULL, 'replaced', NULL, 'winner', NULL, 'item', v_named, 'closed', '[]'::jsonb);
    END IF;
  END IF;
  v_now := clock_timestamp();

  IF NOT ob1_priority_item_exists(v_item.kind, v_item.key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', format('no %s %s in this brain', CASE WHEN v_item.kind = 'item' THEN 'open item' ELSE v_item.kind END, v_item.key),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL, 'item', v_named, 'closed', '[]'::jsonb);
  END IF;
  IF v_ref_kind IS NOT NULL AND NOT ob1_priority_item_exists(v_ref_kind, v_ref_key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', format('the due reference names no %s %s in this brain', CASE WHEN v_ref_kind = 'item' THEN 'open item' ELSE v_ref_kind END, v_ref_key),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL, 'item', v_named, 'closed', '[]'::jsonb);
  END IF;
  -- Nor its own pool: a ticket and its own rows are one item, and the read
  -- would follow the reference back to this statement (review pass 2). Asked
  -- here, past the capture rule, as membership is the brain's to say.
  IF v_ref_kind IS NOT NULL AND ob1_priority_lock_key(v_ref_kind, v_ref_key) = ob1_priority_lock_key(v_item.kind, v_item.key) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'an item''s due reference may not name itself: a ticket and its own rows are one item',
      ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The maker's open statements across the pool: one, but two where one was
  -- made by name before the key had an id and one after, or where a thought
  -- became the ticket's row after both were made (every one closes below).
  -- The newest is v_old.
  v_own := ARRAY(SELECT o.id FROM ob1_priority_open(v_item.kind, v_item.key) o
                  WHERE ob1_priority_is_maker(o, v_who.name, v_who.agent_id));
  -- Still open when locked (review pass 1): 136's delete trigger takes no
  -- priority lock, so it may have closed one of v_own since it was read; a
  -- row lock waited on returns the closed row, which the closing UPDATE
  -- below then skips, and `replaced` would name a statement this call never
  -- closed. How many of v_own are still open is counted after the lock, for
  -- the `unchanged` test (review pass 2: the count read before it made a
  -- restatement of the one left open a write).
  SELECT * INTO v_old FROM priority_assertions a
   WHERE a.id = ANY(v_own) AND a.closed_at IS NULL
   ORDER BY a.seq DESC LIMIT 1
   FOR UPDATE;
  SELECT count(*)::int INTO v_open FROM priority_assertions a WHERE a.id = ANY(v_own) AND a.closed_at IS NULL;

  -- The same statement again, on the item named, is no change (116's review
  -- passes 1 and 4); the same words on another item of the pool move it.
  IF v_open = 1 AND v_old.item_kind = v_item.kind AND v_old.item_key = v_item.key
     AND (v_old.level, v_old.due_at, v_old.not_before, v_old.due_ref_kind, v_old.due_ref_key, v_old.reason, v_old.inferred, v_old.tier,
          v_old.maker_name, v_old.maker_agent_id, v_old.maker_kind, v_old.maker_trust, v_old.maker_scope, v_old.maker_source)
         IS NOT DISTINCT FROM (p_level::smallint, p_due_at, p_not_before, v_ref_kind, v_ref_key, v_reason, COALESCE(p_inferred, false), v_tier,
                               v_who.name, v_who.agent_id, v_who.kind, v_who.trust, v_who.scope, v_who.source) THEN
    v_win := ob1_priority_winner(v_item.kind, v_item.key);
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL, 'message', NULL,
      'assertion', ob1_priority_json(v_old), 'replaced', NULL,
      'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END,
      'item', v_named, 'closed', '[]'::jsonb);
  END IF;

  -- Every one this call closes, kept for the answer. v_old is held FOR UPDATE
  -- and was open when locked, so it is among them; another of v_own that a
  -- delete closed meanwhile is not.
  IF v_old.id IS NOT NULL THEN
    WITH c AS (
      UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'replaced', closed_by = v_id
       WHERE a.id = ANY(v_own) AND a.closed_at IS NULL
      RETURNING a.id)
    SELECT COALESCE(array_agg(c.id), '{}') INTO v_closed FROM c;
    SELECT * INTO v_old FROM priority_assertions WHERE id = v_old.id;
  END IF;
  INSERT INTO priority_assertions (id, item_kind, item_key, level, due_at, not_before, due_ref_kind, due_ref_key, reason, inferred,
                                   maker_name, maker_agent_id, maker_kind, maker_trust, maker_scope, maker_source, tier, asserted_at)
  VALUES (v_id, v_item.kind, v_item.key, p_level, p_due_at, p_not_before, v_ref_kind, v_ref_key, v_reason, COALESCE(p_inferred, false),
          v_who.name, v_who.agent_id, v_who.kind, v_who.trust, v_who.scope, v_who.source, v_tier, v_now)
  RETURNING * INTO v_row;

  -- Every item whose statement closed, and the item named, made current.
  PERFORM ob1_priority_project(t.item_kind, t.item_key)
     FROM (SELECT DISTINCT a.item_kind, a.item_key FROM priority_assertions a WHERE a.id = ANY(v_own)
           UNION SELECT v_item.kind, v_item.key) t
    ORDER BY t.item_kind, t.item_key;
  v_win := ob1_priority_winner(v_item.kind, v_item.key);
  RETURN jsonb_build_object('outcome', 'asserted', 'code', NULL, 'message', NULL,
    'assertion', ob1_priority_json(v_row),
    'replaced', CASE WHEN v_old.id IS NOT NULL THEN ob1_priority_json(v_old) END,
    'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END,
    'item', v_named, 'closed', ob1_priority_closed_json(v_closed));
END;
$$;
COMMENT ON FUNCTION assert_priority(text, text, int, timestamptz, timestamptz, text, text, text, boolean, jsonb) IS
  'States that an item (p_kind thought, ticket, entity or item; p_key) matters at p_level (0 none to 5 critical), optionally due at p_due_at, not startable before p_not_before (never after p_due_at), or taking the due time of another item (p_due_ref_kind, p_due_ref_key), with p_reason; p_inferred lowers the maker''s tier to 4. The maker is the key p_actor names, its kind, trust, scope and source declaration the registry''s at the write, never an argument''s; its tier follows decision 4. The maker''s open assertions on the item''s pool — a ticket and its own rows are one item (122) — close as replaced; the same statement again on the same item is unchanged, nothing written. Returns jsonb {outcome: asserted | unchanged | refused, code, message, assertion, replaced, winner, item, closed}: refused READ_ONLY_KEY (an envelope stating no write or capture scope), ITEM_NOT_YOURS (a capture-only key on anything but a thought its agent captured and nobody took or an open item it opened and nobody else changed, or a due reference to one — asked before existence, and answered alike for an item that is not there), or ITEM_NOT_FOUND (the item, or the due reference). `item` is the item named, as ob1_priority_item keys it; `closed` is every statement it closed, newest first ([] when it closed none), and `replaced` the newest of them; the winner, the pool''s (ob1_priority_winner), is shown to a write key alone. With both p_due_at and a due reference, p_due_at is the item''s due time (decision 5). Raises for no maker, a malformed argument, or a transaction above READ COMMITTED. Migration 116 / SMD-3663; open items, migration 117 / SMD-3665; across a ticket''s pool, migration 133 / SMD-4127; the item named and every statement closed, migration 137 / SMD-4238.';

-- ---------------------------------------------------------------------------
-- clear_priority
-- ---------------------------------------------------------------------------
-- 133's, but its answer names the item named and every statement it closed.
CREATE OR REPLACE FUNCTION clear_priority(
  p_kind  text,
  p_key   text,
  p_actor jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item   record := ob1_priority_item(p_kind, p_key);
  v_named  jsonb;
  v_closed uuid[] := '{}';
  v_who  record;
  v_now  timestamptz;
  v_own  uuid[];
  v_row  priority_assertions;
  v_win  priority_assertions;
BEGIN
  v_named := jsonb_build_object('kind', v_item.kind, 'key', v_item.key);
  PERFORM ob1_priority_isolation('clear_priority');
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'clear_priority');
  IF v_who.scope IS DISTINCT FROM 'write' AND v_who.scope IS DISTINCT FROM 'capture' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'READ_ONLY_KEY',
      'message', format('%s states no write or capture scope, so it may not clear a priority', v_who.name), 'assertion', NULL, 'winner', NULL,
      'item', v_named, 'closed', '[]'::jsonb);
  END IF;
  PERFORM ob1_priority_lock(v_item.kind, v_item.key);
  v_now := clock_timestamp();
  -- Only the caller's own: a maker clears what it stated, and nothing another
  -- key did — every open one across the pool, by id or by its name from
  -- before it had one.
  v_own := ARRAY(SELECT o.id FROM ob1_priority_open(v_item.kind, v_item.key) o
                  WHERE ob1_priority_is_maker(o, v_who.name, v_who.agent_id));
  -- Every one this call closes, kept for the answer (one that a delete closed
  -- meanwhile is not among them); v_row is the newest.
  WITH c AS (
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'cleared'
     WHERE a.id = ANY(v_own) AND a.closed_at IS NULL
    RETURNING a.id)
  SELECT COALESCE(array_agg(c.id), '{}') INTO v_closed FROM c;
  SELECT * INTO v_row FROM priority_assertions a WHERE a.id = ANY(v_closed) ORDER BY a.seq DESC LIMIT 1;
  IF v_row.id IS NOT NULL THEN
    PERFORM ob1_priority_project(t.item_kind, t.item_key)
       FROM (SELECT DISTINCT a.item_kind, a.item_key FROM priority_assertions a WHERE a.id = ANY(v_own)) t
      ORDER BY t.item_kind, t.item_key;
  END IF;
  v_win := ob1_priority_winner(v_item.kind, v_item.key);
  -- A capture key is shown no winner: its reply would otherwise read another
  -- key's statement — its reason, its maker — on any item, and say the item
  -- exists, which assert_priority's refusal keeps from it (116's review pass 2).
  RETURN jsonb_build_object('outcome', CASE WHEN v_row.id IS NULL THEN 'nothing_to_clear' ELSE 'cleared' END,
    'code', NULL, 'message', NULL,
    'assertion', CASE WHEN v_row.id IS NOT NULL THEN ob1_priority_json(v_row) END,
    'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END,
    'item', v_named, 'closed', ob1_priority_closed_json(v_closed));
END;
$$;
COMMENT ON FUNCTION clear_priority(text, text, jsonb) IS
  'Closes the caller''s own open assertions on an item''s pool — a ticket and its own rows are one item (122) — as cleared, with none after; another key''s are untouched. Returns jsonb {outcome: cleared | nothing_to_clear | refused, code, message, assertion, winner, item, closed}: refused READ_ONLY_KEY (an envelope stating no write or capture scope). `item` is the item named, as ob1_priority_item keys it; `closed` is every statement it closed, newest first ([] when it closed none), and `assertion` the newest of them; the winner, the pool''s, is shown to a write key alone, never to a capture key. The item need not exist (a statement on a thought since removed can still be cleared). Raises for no maker, a malformed item, or a transaction above READ COMMITTED. Migration 116 / SMD-3663; across a ticket''s pool, migration 133 / SMD-4127; the item named and every statement closed, migration 137 / SMD-4238.';

