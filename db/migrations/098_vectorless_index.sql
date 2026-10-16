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
--   readers) counts the same predicate. No index read it: each was a scan of
--   every row, 0.9 ms at 2,000 thoughts and 5.3 ms at 20,000 with every row
--   vectored ("Rows Removed by Filter: 20000"), linear in the thought count
--   on the way to the 1B horizon (SMD-2754, SMD-2758).
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
--   it (SHARE): one read of every row, entries for the vectorless ones only
--   — seconds on a brain of a few hundred thousand thoughts. A brain far
--   past that can build it by hand first, CONCURRENTLY under this name, and
--   this statement then finds it — a VALID one: an interrupted CONCURRENTLY
--   build leaves an INVALID index under the name, which IF NOT EXISTS
--   accepts and the planner ignores (drop it and build again). 074 says the
--   same of its index.
--
--   Needs nothing past 001 (thoughts, its embedding). Re-applied, IF NOT
--   EXISTS makes it a no-op.
-- =============================================================================

CREATE INDEX IF NOT EXISTS thoughts_vectorless_idx ON thoughts (id) WHERE embedding IS NULL;

COMMENT ON INDEX thoughts_vectorless_idx IS
  'The thoughts with no vector, in id order: the vector mender''s page (listVectorless, both forms) and brain_info''s vectorless count read it. Migration 098 / SMD-3056.';
