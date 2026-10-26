-- =============================================================================
-- Migration 112: a thought's client_key — one thought per key, so a write
--                copied from another brain names its thoughts as that brain
--                did (SMD-3314)
-- =============================================================================
--
-- WHY
--   The canary is a brain of its own (SMD-2872), and the operator's and
--   agents' writes reach it by a client that repeats each write there
--   (SMD-3314's fan-out). A thought captured on each brain separately gets
--   two ids, and an edit, a delete or a `supersedes` names a thought by the
--   id the first brain gave it. capture_thought's `client_key` keeps that id
--   on the copy, as metadata.client_key, and the servers resolve a name to
--   the thought with that id, else the one keeping it as its key
--   (server-portable/core/writes.ts). A key must name one thought, or a
--   name resolves to whichever row a plan reads first.
--
-- WHAT
--   A unique partial btree on thoughts ((metadata->>'client_key')), WHERE
--   that value IS NOT NULL: one live thought per key, and the servers' read
--   of a key (thoughtsNamed, an equality, which implies the predicate) walks
--   it. Only keyed rows enter it — a copy the fan-out made — so it stays
--   small. Metadata, not a column: the event carries the row's metadata
--   (055, 060), so a replay keeps the key with no change to the projector;
--   capture_thought's own argument sets it, the servers refuse it in a
--   caller's `metadata` or `metadata_patch` (RESERVED_META), and a
--   re-capture's merge (080) onto a row keeping another key is not sent the
--   new one. A deleted thought's row is gone, and its key with it.
--
--   A key is set once: a trigger on thoughts (ob1_client_key_set_once)
--   refuses a write that would give a keyed row another key — a re-capture's
--   merge of a second copy of the text racing past the servers' read — in the
--   write's own transaction, so its event goes with it; the servers then
--   capture it without the key and say so (`held`). Taking a key away is not
--   refused. A replay of events from before 112 that moved a caller's key
--   would meet it, and say so by name.
--
--   Rows that already share a value are refused by name before the build:
--   until this file a caller's metadata could set `client_key` like any key
--   of its own (SMD-2014), and two such rows would fail the build with
--   Postgres's bare duplicate-key error.
--
--   Built inside the migrator's transaction, so writes to thoughts wait for
--   it (SHARE): one read of the heap, entries for the keyed rows only, as
--   100's vectorless index. A brain past millions of rows can build it by
--   hand first, CONCURRENTLY under this name and in this shape, and the
--   file then keeps it. Anything else under the name in thoughts' schema is
--   refused, naming it and the statement that clears it (100's rule): IF
--   NOT EXISTS alone would accept an INVALID index, which the planner
--   ignores and which enforces nothing.
--
--   No grant: the readers' SELECT on thoughts is the index's, and the
--   capture group's INSERT and UPDATE on thoughts already write metadata.
--
--   ob1:client-key-one-thought — a CONTRACT SENTINEL, not prose (the 014
--   convention).
--
--   Needs nothing past 001 (thoughts, its metadata). Re-applied, the index
--   is found in its shape and kept: a no-op.
-- =============================================================================

DO $clientkey$
DECLARE
  v_oid   oid;
  v_kind  "char";
  v_def   text;
  v_valid boolean;
  v_on    oid;
  v_ns    oid := (SELECT relnamespace FROM pg_class WHERE oid = 'thoughts'::regclass);
  v_dup   text;
  v_dups  int;
BEGIN
  SELECT c.oid, c.relkind, pg_get_indexdef(c.oid), i.indisvalid, i.indrelid INTO v_oid, v_kind, v_def, v_valid, v_on
    FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname = 'thoughts_client_key_unique' AND c.relnamespace = v_ns;
  IF v_oid IS NULL THEN
    -- ob1:client-key-one-thought
    SELECT count(*)::int, min(k) INTO v_dups, v_dup
      FROM (SELECT metadata->>'client_key' AS k FROM thoughts WHERE metadata->>'client_key' IS NOT NULL
             GROUP BY 1 HAVING count(*) > 1) d;
    IF v_dups > 0 THEN
      RAISE EXCEPTION 'migration 112: % metadata.client_key value(s) are kept by more than one thought (the first: %) — a caller''s metadata set them before 112 reserved the key. Keep one thought per value: remove the key from the others (SELECT id FROM thoughts WHERE metadata->>''client_key'' = <value>; then UPDATE thoughts SET metadata = metadata - ''client_key'' WHERE id = <each but one>) and re-run.', v_dups, left(v_dup, 80)
        USING ERRCODE = 'unique_violation';
    END IF;
    CREATE UNIQUE INDEX thoughts_client_key_unique ON thoughts ((metadata->>'client_key')) WHERE (metadata->>'client_key') IS NOT NULL;
    v_oid := (SELECT oid FROM pg_class WHERE relname = 'thoughts_client_key_unique' AND relnamespace = v_ns);
  ELSIF v_kind <> 'i' OR v_on <> 'thoughts'::regclass OR v_def !~ '^CREATE UNIQUE INDEX thoughts_client_key_unique ON .+ USING btree \(\(\(metadata ->> ''client_key''::text\)\)\) WHERE \(\(metadata ->> ''client_key''::text\) IS NOT NULL\)$' THEN
    RAISE EXCEPTION 'migration 112: thoughts_client_key_unique exists but is not a unique btree on thoughts ((metadata->>''client_key'')) WHERE that value IS NOT NULL — %. Drop it (an index: DROP INDEX CONCURRENTLY, which leaves writes to thoughts running) and re-run: the file builds it.', COALESCE(v_def, 'a relation of kind ' || v_kind::text)
      USING ERRCODE = 'object_not_in_prerequisite_state';
  ELSIF NOT v_valid THEN
    RAISE EXCEPTION 'migration 112: thoughts_client_key_unique exists but is INVALID — a CONCURRENTLY build or drop that did not finish, or a build still running (pg_stat_progress_create_index lists a running one); it enforces nothing and the planner reads nothing from it. Once no build is running, finish it with REINDEX INDEX CONCURRENTLY thoughts_client_key_unique, or DROP INDEX CONCURRENTLY thoughts_client_key_unique, and re-run.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  EXECUTE format('COMMENT ON INDEX %s IS %L', v_oid::regclass,
    'One thought per metadata.client_key: the key capture_thought keeps on a write copied from another brain (that brain''s id for it), which update_thought, delete_thought and the pointers resolve when no thought has the name as its id. Migration 112 / SMD-3314.');
END
$clientkey$;

-- A key is set once (review pass 2): a write that would give a keyed row
-- another key is refused, never applied. 080's re-capture merges a write
-- key's metadata over the row's (old || new), so two keyed copies of one text
-- racing past the servers' read of the row would move the first key off its
-- thought; the index cannot see it, the two keys being different. Refused in
-- the transaction that appends the write's event (060), so the event goes with
-- it and the log and the row stay one. Taking a key away (a raw writer's
-- `metadata - 'client_key'`) is not refused.
-- ob1:client-key-set-once
CREATE OR REPLACE FUNCTION ob1_client_key_set_once() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.metadata->>'client_key' IS NOT NULL AND NEW.metadata->>'client_key' IS DISTINCT FROM OLD.metadata->>'client_key' THEN
    RAISE EXCEPTION 'client_key is set once: thought % keeps %, and a write gave it %', OLD.id, left(OLD.metadata->>'client_key', 80), left(NEW.metadata->>'client_key', 80)
      USING ERRCODE = 'integrity_constraint_violation', HINT = 'capture without the key, or name the thought by the key it keeps (migration 112)';
  END IF;
  RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION ob1_client_key_set_once() IS
  'BEFORE UPDATE OF metadata on thoughts, for a row already keeping a client_key: refuses a write that gives it another key (taking it away is not refused). The servers answer such a capture as held and write it without the key. Migration 112 / SMD-3314.';
DROP TRIGGER IF EXISTS thoughts_client_key_set_once ON thoughts;
CREATE TRIGGER thoughts_client_key_set_once BEFORE UPDATE OF metadata ON thoughts
  FOR EACH ROW WHEN (OLD.metadata->>'client_key' IS NOT NULL) EXECUTE FUNCTION ob1_client_key_set_once();
