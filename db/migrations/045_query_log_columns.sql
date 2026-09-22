-- =============================================================================
-- Migration 045: the query_log column set — a tier the writer stamps and the
--                retrieval arm a search ran, beside the filter 034 carried but
--                nothing populated (SMD-1490)
-- =============================================================================
--
-- WHY
--   034 (SMD-1295) gave query_log a `filter jsonb` column and the store threaded
--   it end to end, but all three search tools passed `filter: {}` unconditionally
--   — no tool exposed a filter — so the column was permanently `{}`, a field
--   nothing wrote. SMD-1490 owns the log's column set. It exposes a real metadata
--   filter on the search tools (server-portable/index.ts) so the column is
--   populated, and settles the two columns the log was missing:
--
--     * `arm` — which retrieval path served a search row: `hybrid` (search,
--       search_thoughts — the vector arm fused with the exact-literal arm, 017)
--       or `keyword` (search_thoughts_keyword — exact substring, 012). `tool`
--       names the MCP tool; `arm` names the path, so a per-arm report
--       (SMD-1735/1737) can group across tools and, when one tool later runs
--       more than one arm, tell them apart. NULL on an action row. Keyword
--       searches are logged from SMD-1490 on (034 logged only the semantic path);
--       the single search operation the tools now share is the one writer.
--
--     * `tier` — which pipeline tier's server wrote the row: stable | canary |
--       working, or NULL for a plain brain that sets no OB1_TIER (SMD-1806). The
--       three brains are one corpus read through three schemas with one writer
--       per tier; the canary refreshes from stable's dump and replays stable's
--       log, so it must tell a stable-written row from its own. The value is the
--       server's OB1_TIER at write time — supplied here so SMD-1806's canary
--       tier consumes a column that already exists and is populated.
--
--   The `filter` column already exists (034); this migration only documents it
--   now that it carries data. No index on the two new columns — the log's
--   hot-path and prune indexes are SMD-1492's.
--
-- WHAT
--   * A guard first, 043's shape: on a schema without 034's table both ALTERs
--     would fail bare. The brain that meets this is one adopted with --baseline
--     whose ledger records 034 but whose schema never had it; the file refuses up
--     front naming 034 and --reapply. db/test-upgrade.ts drives the pending file.
--   * ADD COLUMN IF NOT EXISTS tier / arm, each with an inline CHECK admitting
--     NULL and its enumerated values — additive and idempotent (a re-run skips
--     the column and its CHECK together).
--   * COMMENT ON COLUMN for tier, arm and filter (034 left filter uncommented).
--     043's query_log.tool and table comments are NOT re-issued here — [42]
--     asserts their live text, and this file changes neither the cite contract
--     nor 034's table description; the arm column's own comment states that
--     keyword is logged now.
--
-- SAFETY
--   Additive. Two nullable columns added to `query_log`; no column altered or
--   dropped, no function body, no ACL, no CHANGE to 034's or 043's comments or
--   constraints. Idempotent: ADD COLUMN IF NOT EXISTS, and the inline CHECKs ride
--   with the column so a second run adds nothing. The export join, the
--   utilization report and prune_query_log are unaffected — they read neither new
--   column. A MINOR change under the version rules (an additive migration).
-- =============================================================================

DO $qc$
BEGIN
  IF to_regclass('query_log') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 045 needs 034 (query_log); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$qc$;

ALTER TABLE query_log
  ADD COLUMN IF NOT EXISTS tier text
    CHECK (tier IS NULL OR tier IN ('stable', 'canary', 'working'));

ALTER TABLE query_log
  ADD COLUMN IF NOT EXISTS arm text
    CHECK (arm IS NULL OR arm IN ('hybrid', 'keyword'));

COMMENT ON COLUMN query_log.tier IS
  'Which pipeline tier''s server wrote the row: stable, canary or working, or NULL for a plain brain that sets no OB1_TIER (SMD-1806). The three brains are one corpus read through three schemas with one writer per tier; the canary refreshes from stable''s dump and replays stable''s log, so it must tell a stable-written row from its own. The value is the server''s OB1_TIER at write time.';

COMMENT ON COLUMN query_log.arm IS
  'Which retrieval arm served a search row: hybrid (search, search_thoughts — the vector arm fused with the exact-literal arm, migration 017) or keyword (search_thoughts_keyword — exact substring, migration 012). NULL on an action row. The tool column names the MCP tool; arm names the retrieval path, so a per-arm report can group across tools and tell two arms of one tool apart (SMD-1490, for SMD-1735/1737). Keyword searches are logged from SMD-1490 on — 034 logged only the semantic path, and the search tools now share one search operation that is the single writer.';

COMMENT ON COLUMN query_log.filter IS
  'The metadata containment filter a search ran with (jsonb; the search applies metadata @> filter). Populated from the search tools'' filter argument (SMD-1490); {} is unfiltered, and an absent or empty argument normalises to {} at the tool boundary. The argument is a shallow object — top-level keys mapping to a scalar or an array of scalars — so the containment stays GIN-indexable (SMD-1625 is the row-level-security cost of exposing it). NULL on an action row.';
