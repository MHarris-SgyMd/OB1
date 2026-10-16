-- =============================================================================
-- Migration 098: the thoughts with no vector, by an index of their own — the
--                vector mender's page and brain_info's vectorless count read
--                it, not the whole table (SMD-3056)
-- =============================================================================
--
-- WHY
--   SMD-2889's vector mender (server-portable/core/mend.ts) reads a page of
--   `thoughts WHERE embedding IS NULL` in id order on every tick, from each
--   server, and brain_info's vectorless count (keyed /health among its
--   readers) counts the same predicate. No index read it: the count read
--   every row, and so did the page whenever none waited past its cursor —
--   a healthy brain's every tick, and each sweep's tail — 0.9 ms over
--   stable's 2,023 thoughts, 2-4 ms at 100,000: the cost of the thought
--   count, not of the rows waiting, on the way to the 1B horizon (SMD-2754,
--   SMD-2758).
--
-- WHAT
--   A partial btree on thoughts (id), WHERE embedding IS NULL: the page's
--   order and its predicate in one index, so both of listVectorless's forms
--   (no cursor; id > cursor) walk it from where they start and stop at the
--   page, and the count reads it alone. It holds only the rows still waiting
--   for a vector, so it stays a few pages on a healthy brain: a capture with
--   its vector and every vectored row never enter it, and a mend's write is
--   a row version that leaves it (the old entry goes at the next vacuum).
--   HOT updates are unchanged: embedding is already an indexed column (the
--   HNSW index's expression), and a column in an index's predicate counts
--   the same. No column of thoughts changes, and no grant: the readers'
--   SELECT on thoughts is the index's.
--
--   Built inside the migrator's transaction, so writes to thoughts wait for
--   it (SHARE): one read of the heap, entries for the vectorless ones only
--   — 64-86 ms at a million thoughts, measured (340 MB of heap; the null
--   test reads no vector's TOAST). A brain of hundreds of millions can
--   build it by hand first, CONCURRENTLY under this name and
--   in this shape, and the file then keeps it. Anything else under the name
--   is refused, naming it, rather than recorded as applied: IF NOT EXISTS
--   alone would accept an INVALID index (an interrupted CONCURRENTLY build,
--   which the planner ignores) or one of another shape, and the mender
--   would go on reading every row with nothing saying so (review pass 1).
--
--   Needs nothing past 001 (thoughts, its embedding). Re-applied, the index
--   is found in its shape and kept: a no-op.
-- =============================================================================

DO $vectorless$
DECLARE
  v_kind  "char";
  v_def   text;
  v_valid boolean;
BEGIN
  SELECT c.relkind, pg_get_indexdef(c.oid), i.indisvalid INTO v_kind, v_def, v_valid
    FROM pg_class c LEFT JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.oid = to_regclass('thoughts_vectorless_idx');
  IF v_kind IS NULL THEN
    CREATE INDEX thoughts_vectorless_idx ON thoughts (id) WHERE embedding IS NULL;
  ELSIF v_kind <> 'i' OR v_def !~ '^CREATE INDEX thoughts_vectorless_idx ON (\w+\.)?thoughts USING btree \(id\) WHERE \(embedding IS NULL\)$' THEN
    RAISE EXCEPTION 'migration 098: thoughts_vectorless_idx exists but is not a btree on thoughts (id) WHERE embedding IS NULL — %. Drop it and re-run: the file builds it.', COALESCE(v_def, 'a relation of kind ' || v_kind::text)
      USING ERRCODE = 'object_not_in_prerequisite_state';
  ELSIF NOT v_valid THEN
    RAISE EXCEPTION 'migration 098: thoughts_vectorless_idx exists but is INVALID — a CONCURRENTLY build that did not finish, or one still running; the planner reads nothing from it. Once no build is running, drop it (DROP INDEX thoughts_vectorless_idx) and re-run, or build it again CONCURRENTLY first.'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$vectorless$;

COMMENT ON INDEX thoughts_vectorless_idx IS
  'The thoughts with no vector, in id order: the vector mender''s page (listVectorless, both forms) and brain_info''s vectorless count read it. Migration 098 / SMD-3056.';
