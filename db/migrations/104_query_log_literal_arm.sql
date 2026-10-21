-- =============================================================================
-- Migration 104: the query log's arm `literal` — a search the embedding
--                provider did not answer for is answered by the exact-literal
--                arm alone, and logged as that (SMD-2891)
-- =============================================================================
--
-- WHY
--   With the provider down, search_thoughts and the compat search failed
--   with Bun's raw "Unable to connect", though the exact-literal arm they
--   fuse needs no model (measured 2026-10-11, SMD-2887). They now call the
--   same hybrid function with no vector: match_thoughts finds nothing on
--   NULL, so the rows are the identifiers and quoted spans the query names,
--   matched exactly — no function changes. A query holding none is matched
--   as one text by search_thoughts_keyword's function instead.
--   The ticket asks that the query log say which arm actually ran. It is
--   none of the three 059 allows: `hybrid` and `current` would replay with a
--   vector, and `keyword` is another tool's search, with its paging.
--
-- WHAT
--   * query_log_arm_check gains `literal`, as 059 gained `current`.
--   * query_log.arm's comment says what it is.
--
-- WHO WRITES IT
--   server-portable/core/reads.ts's runSearch, the single writer of search
--   rows: `literal` when the provider did not answer (providerDown) for a
--   search or search_thoughts call, whichever function — prefer_current's or
--   not — answered it.
--
-- NOT HERE
--   * Replaying a literal row: db/brain-compare.ts's replayPlanFromLog takes
--     only the arms a brain whose provider answers can run, so it leaves
--     these out, as it leaves out a row with no arm.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS, ADD CONSTRAINT and COMMENT ON only.
-- No row is rewritten; the check is validated over query_log's rows, every
-- one of which already holds an allowed arm or NULL.
-- =============================================================================

DO $qc$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('query_log') AND attname = 'arm' AND NOT attisdropped) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 104 needs query_log (034) and its arm column (045); this schema lacks them',
      HINT = 'Apply db/migrations 034 and 045 first — bun migrate.ts applies every pending file in order.';
  END IF;
END
$qc$;

ALTER TABLE query_log DROP CONSTRAINT IF EXISTS query_log_arm_check;
ALTER TABLE query_log ADD CONSTRAINT query_log_arm_check CHECK (arm IS NULL OR arm IN ('hybrid', 'keyword', 'current', 'literal'));

COMMENT ON COLUMN query_log.arm IS
  'Which retrieval arm served a search row: hybrid (search, search_thoughts — the vector arm fused with the exact-literal arm, migration 017), keyword (search_thoughts_keyword — exact substring, migration 012), current (search_thoughts with prefer_current — the hybrid with settled and superseded thoughts ranked below current ones, migration 059, SMD-2255) or literal (search or search_thoughts while the embedding provider did not answer for the query — the exact-literal arm alone, through the same function with no vector, or for a query holding no literal the whole query as one text, migration 104, SMD-2891; not replayable). NULL on an action row. The tool column names the MCP tool; arm names the retrieval path, so a per-arm report can group across tools and tell two arms of one tool apart (SMD-1490, for SMD-1735/1737). Keyword searches are logged from SMD-1490 on — 034 logged only the semantic path, and the search tools now share one search operation that is the single writer.';
