-- =============================================================================
-- Migration 133: a ticket and its own rows are one item to the writers too —
--                a maker's new statement on either closes its statement on
--                the other, a clear closes both, and the history, the winner
--                and priority_of read them together (SMD-4127)
-- =============================================================================
--
-- WHY
--   122's effective_priority reads a ticket and its own rows (board-sync's
--   rows of it) as one item: the statements on each are one pool, and each
--   maker's newest counts. 116's writers still keyed a statement by its exact
--   (kind, key), so one maker could hold an open statement on ticket PRB-60
--   and another on PRB-60's row. clear_priority('ticket', 'PRB-60') closed
--   only the first, and the read then showed the maker's older statement on
--   the row again: a stance the maker had replaced and then meant to
--   withdraw. The maintainer chose (SMD-3667's review pass 5) that the read
--   takes each maker's newest across the pool, and that the writers follow
--   here.
--
-- WHAT
--   THE POOL is 122's: a ticket's own statements and those on each of its own
--   rows (ob1_ticket_rows), whether the ticket or a row is named; any other
--   item is a pool of one. ob1_priority_pool_items(kind, key) lists its
--   items.
--   * ob1_priority_lock_key(kind, key): the pool's key, its subject's
--     (122's ob1_priority_subject) as 'kind:key'; a thought key that is no
--     uuid, as only a raw write leaves, its own (review pass 2: the rebuild
--     repairs raw writes, and ob1_priority_subject casts a thought's key).
--   * ob1_priority_lock(kind, key): the lock of that key, so a write on a
--     ticket and one on its row take one lock, before either reads. For any
--     item that is no ticket's row the lock is 116's, the same key.
--   * assert_priority (117's, as it was but for the pool): the maker's open
--     statements across the pool close as replaced by the new one, wherever
--     they stand. The same statement again is `unchanged` only when the
--     maker's one open statement in the pool is on the item named and says
--     the same; the same words on another item of the pool move it there.
--     `replaced` is the newest it closed. A due reference into the item's own
--     pool is refused as one naming the item itself (review pass 2: the read
--     followed it back to the same statement and found no due time).
--   * clear_priority: closes the maker's open statements across the pool.
--     `assertion` is the newest it closed.
--   * ob1_priority_winner(kind, key): 122's ob1_priority_counted with tier
--     4 counted, the pool rule's one copy (review pass 2; the projection and
--     its drift check keep 116's rule for one exact item): over the pool,
--     each maker's newest alone, then 116's rule (the lowest tier, then the
--     later written). Both writers' replies, priority_of and the server's
--     priority record name it.
--   * ob1_priority_project(kind, key): one item's projection row, as 116
--     made it. priority_current stays keyed by the exact (kind, key), and
--     its drift check with it: each writer re-projects every item whose
--     statement it closed. Its winner is that item's own, not the pool's:
--     no read joins it.
--   * ob1_rebuild_priority_projection: 116's, but the drifted items taken
--     in the order of their locks' keys, each item's subject first (review
--     pass 1: by item, a row of ZZZ-1 sorted before ticket BBB-1 and took
--     ZZZ-1's lock first, so two rebuilds could deadlock), each locked by the
--     key it was sorted by (review pass 3: read again, a row recorded
--     meanwhile would move its lock out of the order).
--   * priority_of: each item's open statements across its pool, the winner
--     ob1_priority_winner names first and the rest in the rule's order, its
--     level the item's (review pass 1: 116's "the winner its first" held,
--     where a maker's older statement could have sorted ahead).
--   * priority_history: every statement across the pool, closed ones
--     included, in the order written. Each statement names its own item.
--   * ON UPGRADE: where one maker already holds two or more open statements
--     across a ticket and its rows, each older one closes as replaced by its
--     newest, and each item is re-projected. A maker is as the writers match
--     one (116's is_maker): its agent id, a statement made by name before the
--     key had an id taking the id the registry now gives that name (review
--     pass 3: by maker_key alone the two stayed open, and the read counted
--     both).
--   * ob1_priority_counted's comment: 122's no longer needs to say a clear
--     reaches only the item it names.
--
--   NOT CHANGED. A thought that becomes a ticket's row after statements were
--   made on it and on the ticket (board-sync recording the row later) joins
--   the pool with both standing: the read takes the maker's newest, and the
--   maker's next write closes both. So does a write racing that recording:
--   its lock is the subject read before the row is committed (review pass
--   1), and so does a writer still running 116's body while this file
--   applies, its statement committed after the upgrade's closing read
--   (review pass 2). A statement made before 133 whose due reference names
--   its own pool, which writers now refuse, stays open, and the read finds
--   no due time through it, as before: closing it would withdraw a stance
--   its maker took, so its maker restates it (review pass 4). A check that
--   finds each of these is SMD-4239. 116's one-open
--   index stays per exact
--   item: membership is a read of thought_sources and thoughts, which no
--   index can hold.
--
-- WHO READS
--   Each writer and reader asks a thought or a ticket for its pool, so it
--   reads thought_sources (and thoughts, the capture group's), as 122's read
--   does. The `priority` group (db/config.mjs) gains SELECT on
--   thought_sources, table-wide (the maintainer, 2026-11-11: a role making
--   these calls reads thoughts, whose content carries the source's text),
--   and this file grants it to each role holding SELECT or INSERT on
--   priority_assertions and SELECT on thoughts already, as 132 carried its
--   table, so no such role's calls fail on the upgrade: a reader's
--   priority_history on a ticket asks the pool too (review pass 4: said as
--   the predicate reads). A role reading priorities without thoughts, which
--   could make no call on a ticket or a thought before either, is given
--   nothing (review pass 3). An entity or
--   an open item reads neither.
--
-- CONCURRENCY
--   One lock per pool, the subject's: two writers on one ticket's pool wait
--   on each other whichever item each names, and a writer never holds two
--   pools' locks. The rebuild holds many, taken in their subjects' order,
--   so two rebuilds take them in one order and cannot deadlock either.
--
-- SAFETY
--   Two new functions; eight replaced with their signatures (ob1_priority_lock
--   now PL/pgSQL); no table changed. Rows change only by closing the windows
--   of statements their own maker had already replaced. MINOR under FORK.md's
--   version rules. test-schema [120], test-upgrade [20bx].
--
-- Prerequisites
--   053 (thought_sources), 116 (priority_assertions and its helpers), 117
--   (assert_priority's open items: ob1_item_lock, ob1_envelope_plugin,
--   ob1_priority_owns_item), 122 (ob1_priority_subject, ob1_priority_open,
--   ob1_ticket_rows, ob1_ticket_row_of, ob1_priority_counted). Applied by
--   `bun db/migrate.ts`. Re-applied: the functions are replaced as they
--   were; the upgrade's closing finds nothing left to close.
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
    ARRAY['ob1_priority_projection_drift()', '116 (ob1_priority_projection_drift)'],
    ARRAY['ob1_priority_is_maker(priority_assertions, text, uuid)', '116 (ob1_priority_is_maker)'],
    ARRAY['ob1_priority_actor(jsonb, text)', '116 (ob1_priority_actor)'],
    ARRAY['ob1_item_lock(uuid)', '117 (ob1_item_lock)'],
    ARRAY['ob1_envelope_plugin(text)', '117 (ob1_envelope_plugin)'],
    ARRAY['ob1_priority_owns_item(text, text, uuid, text)', '117 (ob1_priority_owns_item)'],
    ARRAY['ob1_priority_subject(text, text)', '122 (ob1_priority_subject)'],
    ARRAY['ob1_priority_open(text, text)', '122 (ob1_priority_open)'],
    ARRAY['ob1_ticket_rows(text)', '122 (ob1_ticket_rows)'],
    ARRAY['ob1_ticket_row_of(uuid)', '122 (ob1_ticket_row_of)'],
    ARRAY['ob1_priority_counted(text, text, boolean)', '122 (ob1_priority_counted)']];
  i int;
BEGIN
  FOR i IN 1 .. array_length(v_need, 1) LOOP
    IF to_regprocedure(v_need[i][1]) IS NULL THEN
      RAISE EXCEPTION USING
        MESSAGE = format('migration 133 needs %s; this schema lacks it', v_need[i][2]),
        -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
        HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
        ERRCODE = 'invalid_schema_definition';
    END IF;
  END LOOP;
  IF to_regclass('thought_sources') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 133 needs 053 (thought_sources); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

-- ---------------------------------------------------------------------------
-- ob1_priority_pool_items — the items whose statements are one item's
-- ---------------------------------------------------------------------------
-- 122's pool, as items rather than open statements: a ticket and each of its
-- own rows when the item is a ticket or a ticket's row, else the item alone.
-- PL/pgSQL, one branch per case, so an entity or an open item reads no
-- thought table (a SQL function's CASE checks every branch's table: 117's
-- review pass 2).
CREATE OR REPLACE FUNCTION ob1_priority_pool_items(p_kind text, p_key text)
RETURNS TABLE (item_kind text, item_key text)
LANGUAGE plpgsql
STABLE
ROWS 3
AS $$
DECLARE
  s record;
BEGIN
  s := ob1_priority_subject(p_kind, p_key);
  IF s.kind = 'ticket' THEN
    item_kind := 'ticket';
    item_key := s.key;
    RETURN NEXT;
    -- The asked row is among them: ob1_ticket_row_of maps a thought only as
    -- ob1_ticket_rows finds it (122).
    RETURN QUERY SELECT 'thought'::text, r FROM ob1_ticket_rows(s.key) r;
  ELSE
    item_kind := p_kind;
    item_key := p_key;
    RETURN NEXT;
  END IF;
END;
$$;
COMMENT ON FUNCTION ob1_priority_pool_items(text, text) IS
  'The items whose statements are one normalised item''s: for a ticket or a ticket''s own row, the ticket and every row of it (122''s ob1_ticket_rows); for any other item, itself. What priority_history reads. Migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- ob1_priority_lock_key / ob1_priority_lock — the pool's key and its lock
-- ---------------------------------------------------------------------------
-- The subject's 'kind:key': a ticket's row is its ticket's. A thought key
-- that is no uuid is no ticket's row (122's ob1_ticket_row_of takes a uuid):
-- only a raw write leaves one, and the rebuild that repairs it must not
-- raise on it (review pass 2).
CREATE OR REPLACE FUNCTION ob1_priority_lock_key(p_kind text, p_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  s record;
BEGIN
  IF p_kind = 'thought' AND p_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN p_kind || ':' || p_key;
  END IF;
  s := ob1_priority_subject(p_kind, p_key);
  RETURN s.kind || ':' || s.key;
END;
$$;
COMMENT ON FUNCTION ob1_priority_lock_key(text, text) IS
  'One item''s pool, as the key its lock takes: its subject''s ''kind:key'' (122''s ob1_priority_subject: a ticket''s own row is its ticket); a thought key that is no uuid, which only a raw write leaves, its own. Two items are one item to the writers when their keys are equal. Migration 133 / SMD-4127.';

-- 116's hash of the pool's key: a ticket's row locks as its ticket, so a
-- writer naming either waits on one naming the other. Any other item's lock
-- is the one 116 took.
CREATE OR REPLACE FUNCTION ob1_priority_lock(p_kind text, p_key text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ob1:priority:' || ob1_priority_lock_key(p_kind, p_key), 0));
END;
$$;
COMMENT ON FUNCTION ob1_priority_lock(text, text) IS
  'Takes the transaction advisory lock on one item''s assertions — its pool''s (ob1_priority_lock_key): a ticket''s own row locks as its ticket, so the writers on a ticket and on its rows take one lock before they read. Any other item''s lock is 116''s. Migration 116 / SMD-3663; the pool''s, migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- ob1_priority_winner — the pool's winner
-- ---------------------------------------------------------------------------
-- 122's ob1_priority_counted with tier 4 counted, as 116's winner counted
-- it: each maker's newest across the pool alone, then the lowest tier, then
-- the later written. The pool rule's one copy (review pass 2); the
-- projection keeps 116's for one exact item. NULL when none is open.
CREATE OR REPLACE FUNCTION ob1_priority_winner(p_kind text, p_key text)
RETURNS priority_assertions
LANGUAGE sql
STABLE
AS $$
  SELECT * FROM ob1_priority_counted(p_kind, p_key, true)
$$;
COMMENT ON FUNCTION ob1_priority_winner(text, text) IS
  'The winning open assertion on one normalised item (decision 4): 122''s ob1_priority_counted with tier 4 counted — over its pool, a ticket and its own rows as one, each maker''s newest alone: the lowest tier, then the newest within it, the later written (seq). NULL when none is open. Migration 116 / SMD-3663; over the pool, migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- ob1_priority_project — one exact item's projection row
-- ---------------------------------------------------------------------------
-- 116's, with the exact item's winner read here: priority_current stays keyed
-- by (kind, key), as its drift check computes it, while ob1_priority_winner
-- now reads the pool.
CREATE OR REPLACE FUNCTION ob1_priority_project(p_kind text, p_key text)
RETURNS priority_assertions
LANGUAGE plpgsql
AS $$
DECLARE
  w priority_assertions;
  n int;
BEGIN
  SELECT a.* INTO w FROM priority_assertions a
   WHERE a.item_kind = p_kind AND a.item_key = p_key AND a.closed_at IS NULL
   ORDER BY a.tier, a.seq DESC
   LIMIT 1;
  IF w.id IS NULL THEN
    DELETE FROM priority_current WHERE item_kind = p_kind AND item_key = p_key;
    RETURN NULL;
  END IF;
  SELECT count(*)::int INTO n FROM priority_assertions WHERE item_kind = p_kind AND item_key = p_key AND closed_at IS NULL;
  INSERT INTO priority_current (item_kind, item_key, winner_id, level, tier, maker_name, asserted_at, open_count)
  VALUES (p_kind, p_key, w.id, w.level, w.tier, w.maker_name, w.asserted_at, n)
  ON CONFLICT (item_kind, item_key) DO UPDATE
     SET winner_id = EXCLUDED.winner_id, level = EXCLUDED.level, tier = EXCLUDED.tier,
         maker_name = EXCLUDED.maker_name, asserted_at = EXCLUDED.asserted_at, open_count = EXCLUDED.open_count;
  RETURN w;
END;
$$;
COMMENT ON FUNCTION ob1_priority_project(text, text) IS
  'Makes one exact item''s priority_current row current — the winner among the statements on that (kind, key) alone and their open count, or no row when none is open — and returns that winner (NULL for none). priority_current is keyed by the exact item, as its drift check computes it; ob1_priority_winner reads the pool. Called by the writers under the pool''s lock, for every item whose statement they closed. Migration 116 / SMD-3663; the exact item''s winner read here since ob1_priority_winner reads the pool, migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- ob1_rebuild_priority_projection — the drifted items in their locks' order
-- ---------------------------------------------------------------------------
-- 116's, but ordered by each item's subject, the key ob1_priority_lock now
-- takes: by (kind, key) a row of ZZZ-1 came before ticket BBB-1 and took
-- ZZZ-1's lock first, so two rebuilds holding their locks to commit could
-- each wait on the other.
CREATE OR REPLACE FUNCTION ob1_rebuild_priority_projection()
RETURNS TABLE (written int, deleted int)
LANGUAGE plpgsql
AS $$
DECLARE
  r        record;
  w        priority_assertions;
  v_before text;
  v_after  text;
BEGIN
  PERFORM ob1_priority_isolation('ob1_rebuild_priority_projection()');
  written := 0;
  deleted := 0;
  -- Item by item under each item's pool's lock, the subjects in key order:
  -- one order for every rebuild, and a writer holds one pool's lock alone.
  -- Each locked by the key it was sorted by, read once (review pass 3).
  FOR r IN SELECT d.item_kind, d.item_key, ob1_priority_lock_key(d.item_kind, d.item_key) AS lock_key
             FROM (SELECT DISTINCT x.item_kind, x.item_key FROM ob1_priority_projection_drift() x) d
            ORDER BY 3, 1, 2 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('ob1:priority:' || r.lock_key, 0));
    -- Counted only if still wrong under the lock: a writer may have fixed it
    -- since the drift was read (116's review pass 4).
    SELECT row(c.winner_id, c.level, c.tier, c.maker_name, c.asserted_at, c.open_count)::text INTO v_before
      FROM priority_current c WHERE c.item_kind = r.item_kind AND c.item_key = r.item_key;
    w := ob1_priority_project(r.item_kind, r.item_key);
    SELECT row(c.winner_id, c.level, c.tier, c.maker_name, c.asserted_at, c.open_count)::text INTO v_after
      FROM priority_current c WHERE c.item_kind = r.item_kind AND c.item_key = r.item_key;
    IF v_before IS DISTINCT FROM v_after THEN
      IF w.id IS NOT NULL THEN written := written + 1; ELSE deleted := deleted + 1; END IF;
    END IF;
  END LOOP;
  RETURN NEXT;
END
$$;
COMMENT ON FUNCTION ob1_rebuild_priority_projection() IS
  'Reconciles every item the drift check names, each under its pool''s lock, the items in their subjects'' order (the locks'' keys), and returns how many rows it wrote and deleted — zeros when the projection was exact. Refuses to run outside READ COMMITTED. The repair after a raw write to priority_assertions. Migration 116 / SMD-3663; in its locks'' order, migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- assert_priority
-- ---------------------------------------------------------------------------
-- 117's, but the maker's statements read, closed and re-projected across the
-- item's pool, and the winner the pool's.
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
  v_ref_kind text;
  v_ref_key  text;
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
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
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
        'assertion', NULL, 'replaced', NULL, 'winner', NULL);
    END IF;
  END IF;
  v_now := clock_timestamp();

  IF NOT ob1_priority_item_exists(v_item.kind, v_item.key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', format('no %s %s in this brain', CASE WHEN v_item.kind = 'item' THEN 'open item' ELSE v_item.kind END, v_item.key),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
  END IF;
  IF v_ref_kind IS NOT NULL AND NOT ob1_priority_item_exists(v_ref_kind, v_ref_key) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'ITEM_NOT_FOUND',
      'message', format('the due reference names no %s %s in this brain', CASE WHEN v_ref_kind = 'item' THEN 'open item' ELSE v_ref_kind END, v_ref_key),
      'assertion', NULL, 'replaced', NULL, 'winner', NULL);
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
  SELECT * INTO v_old FROM priority_assertions a
   WHERE a.id = ANY(v_own)
   ORDER BY a.seq DESC LIMIT 1
   FOR UPDATE;

  -- The same statement again, on the item named, is no change (116's review
  -- passes 1 and 4); the same words on another item of the pool move it.
  IF cardinality(v_own) = 1 AND v_old.item_kind = v_item.kind AND v_old.item_key = v_item.key
     AND (v_old.level, v_old.due_at, v_old.not_before, v_old.due_ref_kind, v_old.due_ref_key, v_old.reason, v_old.inferred, v_old.tier,
          v_old.maker_name, v_old.maker_agent_id, v_old.maker_kind, v_old.maker_trust, v_old.maker_scope, v_old.maker_source)
         IS NOT DISTINCT FROM (p_level::smallint, p_due_at, p_not_before, v_ref_kind, v_ref_key, v_reason, COALESCE(p_inferred, false), v_tier,
                               v_who.name, v_who.agent_id, v_who.kind, v_who.trust, v_who.scope, v_who.source) THEN
    v_win := ob1_priority_winner(v_item.kind, v_item.key);
    RETURN jsonb_build_object('outcome', 'unchanged', 'code', NULL, 'message', NULL,
      'assertion', ob1_priority_json(v_old), 'replaced', NULL,
      'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
  END IF;

  IF v_old.id IS NOT NULL THEN
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'replaced', closed_by = v_id
     WHERE a.id = ANY(v_own) AND a.closed_at IS NULL;
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
    'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
END;
$$;
COMMENT ON FUNCTION assert_priority(text, text, int, timestamptz, timestamptz, text, text, text, boolean, jsonb) IS
  'States that an item (p_kind thought, ticket, entity or item; p_key) matters at p_level (0 none to 5 critical), optionally due at p_due_at, not startable before p_not_before (never after p_due_at), or taking the due time of another item (p_due_ref_kind, p_due_ref_key), with p_reason; p_inferred lowers the maker''s tier to 4. The maker is the key p_actor names, its kind, trust, scope and source declaration the registry''s at the write, never an argument''s; its tier follows decision 4. The maker''s open assertions on the item''s pool — a ticket and its own rows are one item (122) — close as replaced; the same statement again on the same item is unchanged, nothing written. Returns jsonb {outcome: asserted | unchanged | refused, code, message, assertion, replaced, winner}: refused READ_ONLY_KEY (an envelope stating no write or capture scope), ITEM_NOT_YOURS (a capture-only key on anything but a thought its agent captured and nobody took or an open item it opened and nobody else changed, or a due reference to one — asked before existence, and answered alike for an item that is not there), or ITEM_NOT_FOUND (the item, or the due reference). `replaced` is the newest it closed; the winner, the pool''s (ob1_priority_winner), is shown to a write key alone. With both p_due_at and a due reference, p_due_at is the item''s due time (decision 5). Raises for no maker, a malformed argument, or a transaction above READ COMMITTED. Migration 116 / SMD-3663; open items, migration 117 / SMD-3665; across a ticket''s pool, migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- clear_priority
-- ---------------------------------------------------------------------------
-- 116's, but the maker's statements closed across the item's pool.
CREATE OR REPLACE FUNCTION clear_priority(
  p_kind  text,
  p_key   text,
  p_actor jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_item record := ob1_priority_item(p_kind, p_key);
  v_who  record;
  v_now  timestamptz;
  v_own  uuid[];
  v_row  priority_assertions;
  v_win  priority_assertions;
BEGIN
  PERFORM ob1_priority_isolation('clear_priority');
  SELECT * INTO v_who FROM ob1_priority_actor(p_actor, 'clear_priority');
  IF v_who.scope IS DISTINCT FROM 'write' AND v_who.scope IS DISTINCT FROM 'capture' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'READ_ONLY_KEY',
      'message', format('%s states no write or capture scope, so it may not clear a priority', v_who.name), 'assertion', NULL, 'winner', NULL);
  END IF;
  PERFORM ob1_priority_lock(v_item.kind, v_item.key);
  v_now := clock_timestamp();
  -- Only the caller's own: a maker clears what it stated, and nothing another
  -- key did — every open one across the pool, by id or by its name from
  -- before it had one.
  v_own := ARRAY(SELECT o.id FROM ob1_priority_open(v_item.kind, v_item.key) o
                  WHERE ob1_priority_is_maker(o, v_who.name, v_who.agent_id));
  WITH closed AS (
    UPDATE priority_assertions a SET closed_at = v_now, close_reason = 'cleared'
     WHERE a.id = ANY(v_own) AND a.closed_at IS NULL
    RETURNING a.*)
  SELECT * INTO v_row FROM closed ORDER BY seq DESC LIMIT 1;
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
    'winner', CASE WHEN v_win.id IS NOT NULL AND v_who.scope = 'write' THEN ob1_priority_json(v_win) END);
END;
$$;
COMMENT ON FUNCTION clear_priority(text, text, jsonb) IS
  'Closes the caller''s own open assertions on an item''s pool — a ticket and its own rows are one item (122) — as cleared, with none after; another key''s are untouched. Returns jsonb {outcome: cleared | nothing_to_clear | refused, code, message, assertion, winner}: refused READ_ONLY_KEY (an envelope stating no write or capture scope). `assertion` is the newest it closed; the winner, the pool''s, is shown to a write key alone, never to a capture key. The item need not exist (a statement on a thought since removed can still be cleared). Raises for no maker, a malformed item, or a transaction above READ COMMITTED. Migration 116 / SMD-3663; across a ticket''s pool, migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- priority_of / priority_history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION priority_of(p_items jsonb)
RETURNS TABLE (item_kind text, item_key text, level smallint, winner jsonb, assertions jsonb)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION USING MESSAGE = 'priority_of takes a JSON array of {kind, key}', ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION USING MESSAGE = format('priority_of reads at most 1000 items at once; %s were given', jsonb_array_length(p_items)), ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH asked AS (
    SELECT DISTINCT ON (n.kind, n.key) n.kind, n.key, e.ord
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(v, ord)
      CROSS JOIN LATERAL ob1_priority_item(e.v->>'kind', e.v->>'key') AS n
     ORDER BY n.kind, n.key, e.ord)
  -- One statement, so one snapshot: the pool's winner (ob1_priority_winner,
  -- the rule's one copy) first, as 116 answered, then the rest of its open
  -- statements in the rule's order; the level the winner's.
  SELECT q.kind, q.key, w.level, CASE WHEN w.id IS NOT NULL THEN ob1_priority_json(w) END, l.list
    FROM asked q
    CROSS JOIN LATERAL ob1_priority_winner(q.kind, q.key) AS w
    CROSS JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(ob1_priority_json(a) ORDER BY a.id IS NOT DISTINCT FROM w.id DESC, a.tier, a.seq DESC), '[]'::jsonb) AS list
        FROM ob1_priority_open(q.kind, q.key) a) AS l
   ORDER BY q.ord;
END;
$$;
COMMENT ON FUNCTION priority_of(jsonb) IS
  'For a JSON array of {kind, key} (at most 1000; an item asked twice answered once, at its first place), one row per item in the order asked: its kind and key normalised, the winning level, the winner (ob1_priority_winner''s rule: over the item''s pool, a ticket and its own rows as one, each maker''s newest alone), and every open assertion across the pool, the winner first, then the rest in the rule''s order (tier, then the later written). An item nobody stated a priority on has a NULL level and winner: unknown, not low (decision 3). One statement, so a reply never contradicts itself. Raises on a malformed item. Migration 116 / SMD-3663; over the pool, migration 133 / SMD-4127.';

CREATE OR REPLACE FUNCTION priority_history(p_kind text, p_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(ob1_priority_json(a) ORDER BY a.seq), '[]'::jsonb)
    FROM ob1_priority_item(p_kind, p_key) i
    CROSS JOIN LATERAL ob1_priority_pool_items(i.kind, i.key) p
    JOIN priority_assertions a ON a.item_kind = p.item_kind AND a.item_key = p.item_key
$$;
COMMENT ON FUNCTION priority_history(text, text) IS
  'Every assertion on one item''s pool — a ticket and its own rows are one item (ob1_priority_pool_items) — closed ones included, in the order written (seq), as a jsonb array, each naming its own item: the record of who said it mattered and when that stopped. Raises on a malformed item. Migration 116 / SMD-3663; over the pool, migration 133 / SMD-4127.';

COMMENT ON FUNCTION ob1_priority_counted(text, text, boolean) IS
  'The open assertion a composed read counts for a normalised item: 116''s rule (the lowest tier, then the later written) over its pool (ob1_priority_open: a ticket and its rows as one), each maker''s newest statement alone, tier 4 (inferred) left out unless p_inferred (docs/priority.md decision 5). All NULL for none. Since 133 the writers close a maker''s statements across the pool, so a maker holds two only where a thought became a ticket''s row after both were made. Migration 122 / SMD-3667; migration 133 / SMD-4127.';

-- ---------------------------------------------------------------------------
-- On upgrade: a maker's older statements across one pool closed
-- ---------------------------------------------------------------------------
-- Where one maker holds two or more open statements across a ticket and its
-- own rows, each older one closes as replaced by its newest; each item is
-- re-projected. A maker as the writers match one (116's is_maker): its agent
-- id, a by-name statement taking the id the registry gives its name now. A
-- re-apply finds nothing left to close.
DO $close$
DECLARE
  r     record;
  v_now timestamptz := clock_timestamp();
BEGIN
  FOR r IN
    WITH open AS (
      SELECT a.id, a.seq, a.item_kind, a.item_key,
             COALESCE(COALESCE(a.maker_agent_id, (SELECT g.canonical_agent_id FROM ob1_agents g WHERE g.label = a.maker_name))::text,
                      'name:' || a.maker_name) AS maker,
             CASE WHEN a.item_kind = 'ticket' THEN a.item_key ELSE ob1_ticket_row_of(a.item_key::uuid) END AS ticket
        FROM priority_assertions a
       WHERE a.closed_at IS NULL
         AND (a.item_kind = 'ticket'
              OR (a.item_kind = 'thought' AND a.item_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))),
    ranked AS (
      SELECT o.*, first_value(o.id) OVER w AS newest, row_number() OVER w AS rn
        FROM open o
       WHERE o.ticket IS NOT NULL
      WINDOW w AS (PARTITION BY o.ticket, o.maker ORDER BY o.seq DESC))
    SELECT k.id, k.newest, k.item_kind, k.item_key FROM ranked k WHERE k.rn > 1 ORDER BY k.ticket, k.seq
  LOOP
    UPDATE priority_assertions SET closed_at = v_now, close_reason = 'replaced', closed_by = r.newest
     WHERE id = r.id AND closed_at IS NULL;
    PERFORM ob1_priority_project(r.item_kind, r.item_key);
  END LOOP;
END
$close$;

-- ---------------------------------------------------------------------------
-- The priority group's new grant, carried
-- ---------------------------------------------------------------------------
-- Every priority call on a thought or a ticket now reads thought_sources for
-- the pool, as 122's read did: the group (db/config.mjs) gains SELECT on it,
-- granted here to each role holding SELECT or INSERT on priority_assertions,
-- a reader's or a writer's, and SELECT on thoughts already (132's carry), so
-- no such role's priority calls fail on the upgrade; a role without thoughts
-- could make no call on a ticket or a thought before, and is given nothing
-- (review pass 3). The owner holds it already; a re-apply grants what is
-- held, which changes nothing.
DO $grant$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT a.grantee
      FROM pg_class c, aclexplode(c.relacl) AS a
     WHERE c.oid = 'priority_assertions'::regclass AND a.grantee <> c.relowner AND a.privilege_type IN ('SELECT', 'INSERT')
       AND CASE WHEN a.grantee = 0
                THEN EXISTS (SELECT 1 FROM pg_class t, aclexplode(t.relacl) AS x
                              WHERE t.oid = 'thoughts'::regclass AND x.grantee = 0 AND x.privilege_type = 'SELECT')
                ELSE has_table_privilege(a.grantee, 'thoughts', 'SELECT') END
  LOOP
    EXECUTE format('GRANT SELECT ON thought_sources TO %s',
                   CASE WHEN v_role.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_role.grantee)) END);
  END LOOP;
END
$grant$;
