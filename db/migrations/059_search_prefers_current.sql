-- =============================================================================
-- Migration 059: search_thoughts_current — the hybrid search with settled and
--                superseded thoughts ranked below current ones, on request
--                (SMD-2255, SMD-2074's second consumer)
-- =============================================================================
--
-- WHY
--   058 made a thought's lifecycle, blockers and supersession one SQL read,
--   node_state, and graph-centrality its first reader. Ordinary search still
--   ranks a completed ticket, or a thought a newer one supersedes, exactly
--   like live work — on the dogfood brain 41% of the OB1 footprint is Done
--   work (SMD-1994's census). 025 decided supersession is LABELLED, not
--   demoted, and named evals/eval-supersession.ts as the instrument any
--   demotion must pass; SMD-1720 found a resolving read changes what counts
--   as relevant rather than improving ranking. So this is OPT-IN: the default
--   search is unchanged (the server calls search_thoughts_hybrid itself when
--   the caller does not ask), and 025's label stands for every caller who
--   does not. This function is the exception a caller asks for.
--
--   Priced before this file was written (eval-supersession.ts's second
--   section, a TypeScript oracle over the hybrid and node_state; the rule
--   pre-registered): CURRENT-version MRR +0.052 and LIVE-ticket MRR +0.194
--   over the default, demote above exclude on the PREVIOUS-version question,
--   every control holding. The costs, disclosed, at the tool's threshold 0:
--   TOPICAL -0.127, a note filed under a Done ticket -0.292, the settled
--   ticket itself -0.161, a settled ticket looked up by its key -0.750
--   (sparse) and -0.500 (dense). Those are small windows — the eval's topics
--   admit five rows at threshold 0, so a demoted row drops a rank or two. At
--   threshold -1, where the window fills as it does on a real brain, demote
--   equals exclude for the top N in every cell (PREVIOUS -0.449, NOTE -0.524,
--   SETTLED -0.380, a settled key -1.000): once the window holds N current
--   rows, a demoted one is out of the top N (first review pass).
--
-- WHAT
--   * search_demote_weight() — IMMUTABLE 0.25: what a demoted thought's fused
--     score is multiplied by. Pre-registered, one weight, exact in binary
--     (graph-centrality's DONE_WEIGHT's shape); the one place it is written —
--     the tool's description is held to it by a test.
--   * search_thoughts_current(...) — search_thoughts_hybrid's seven
--     parameters, and its eleven columns, then:
--       fused    — the hybrid's own score, before the weight (score is
--                  fused × the weight, monotone in the returned rank);
--       demoted  — why a row was weighted: its ticket's status_type
--                  (completed, canceled) and/or 'superseded'; NULL when not;
--       window_rows, window_known, window_demoted, window_synced_at,
--       window_exact — every row: how many rows the window held, how many
--                  carry a lifecycle, how many were demoted, the latest source
--                  watermark among them (SMD-2074's coverage and freshness),
--                  and whether the top N is exact (below).
--     A row is DEMOTED when node_state says its ticket is settled (open =
--     false: completed or canceled, by 058's ticket-head rule — a note filed
--     under a Done ticket reads the ticket's lifecycle) or that a newer
--     thought supersedes it (superseded_by). The weight applies once when
--     both hold. Neither blocked nor a missing or unknown status (open IS
--     NULL) demotes a row — such a row is still demoted if it is superseded.
--
--   The window. The hybrid is asked for its top W = min(100, 4N) — N
--   clamped to 1..100 as 017 clamps it, a second copy test-schema [55]
--   holds to the hybrid's — each row weighted, the window re-sorted and cut
--   to N. Ties go to the current row, then to the hybrid's own order (WITH
--   ORDINALITY): on a query that is only literals every row without one
--   scores 0, and 0 × 0.25 is 0, so without that tie-break the demoted rows
--   stayed among the current ones and were marked as ranked below them
--   (first review pass). The top N equals
--   the weight applied over the WHOLE admitted list whenever the window held
--   that whole list or at least N undemoted rows: every row outside the
--   window has a fused score at most any row inside it, so it can outrank no
--   undemoted row it follows. window_exact says so on every row. "The whole
--   list" is the hybrid's as asked at W, and the hybrid is not the same list
--   at every count: a literal
--   hit the vector arm did not reach is priced without its meaning (017), so
--   asked at N the hybrid can rank below a row it ranks above at W; and above
--   041's exact branch (a filter matching at most 1,000 thoughts, or a small
--   brain) the index walk's candidates grow with the count asked. So with
--   nothing to demote this function is the hybrid's first N at W — the
--   hybrid at N itself for a query with no identifier on the exact branch
--   (test-schema [55]).
--
--   What 0.25 does under the hybrid's fusion. A vector-only row at rank r
--   scores 1/(60+r); a demoted row at rank r0 falls below every current row
--   up to rank 4·r0 + 179 — past every rank the window holds. So in practice
--   every current match in the window ranks first, then the demoted ones in
--   their own order; any weight below about 0.38 would give that order. The
--   weight bites only against an exact-literal hit: a demoted row carrying
--   the query's identifier keeps 0.25 of its needle bonus, so a settled
--   ticket looked up by its key can fall out of the top N — 017's "a literal
--   hit is never below the meaning results" does not hold for a demoted hit.
--   The tool says so: to look a finished ticket up by its key, leave the
--   flag off.
--
--   node_state is joined as node_state(NULL), which the planner inlines (a
--   sub-select as its argument would not be); the ids narrow the rows, not
--   the work (058), and only open, superseded_by, status_type and synced_at
--   are read, so its dependency joins are removed from the plan — test-schema
--   [55] reads the plan.
--
--   The query log. arm gains 'current': a search_thoughts call with
--   prefer_current is logged as arm current, so db/tier.ts replays it through
--   this function. No new column — the log is read from the stable brain by a
--   canary's replay, and a column every insert writes would fail every insert
--   on a brain without this file.
--
--   What it costs, measured (db/bench-hybrid.ts's prefer_current arm): +10.7
--   ms over the hybrid's 1.1 at 10,000 thoughts, +129 ms at 100,000, +2.8 ms
--   over 2.4 on the 945-thought dogfood brain — node_state computes the whole
--   brain's lifecycle on every call (058: the ids narrow the rows, not the
--   work). The budget pre-registered for it — at most the hybrid's own median
--   at 10,000 — was MISSED, and the flag shipped opt-in on the maintainer's
--   call, the cost stated here, in the tool's description of the flag and in
--   both READMEs; SMD-2256 narrows node_state for a list of ids under the same
--   signatures. The numbers are one machine's: a second run measured +18.8 ms
--   over 1.6 at 10,000 (first review pass) — over budget either way.
--
-- SAFETY
--   Additive: two functions and a widened CHECK. STABLE; LANGUAGE sql with a
--   STRING body (not BEGIN ATOMIC: a recorded dependency on node_state would
--   stop 058's drop-before-create under --reapply); SET jit = off, 017's and
--   040's clause for the hybrid it wraps; SECURITY INVOKER, no GRANT (EXECUTE
--   is PUBLIC). The caller's role needs what node_state needs — SELECT on
--   thoughts and thought_facets (the capture group) and on thought_sources,
--   which db/config.mjs ROLE_GRANTS gives the server group from this file on.
--   The wrapper is dropped before it is created, as 058's three are: its
--   RETURNS TABLE is a contract, a later reshape is DROP and CREATE, and
--   --reapply replays this file over it. MINOR under the version rules.
--
-- Expected outcome
--   SELECT id, demoted FROM search_thoughts_current(<vec>, 'q', 0, 10) lists
--   the hybrid's top ten with current thoughts first.
-- Dependencies: 017/027 (search_thoughts_hybrid), 045 (query_log.arm), 058
--   (node_state).
-- =============================================================================

-- Each prerequisite named on its own, as 058 names its two. Driven by
-- test-upgrade.ts [20l].
DO $g$
BEGIN
  IF to_regprocedure('search_thoughts_hybrid(vector, text, float, int, jsonb, float, float)') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 059 needs 027 (search_thoughts_hybrid, seven arguments); this schema lacks it',
      -- ASCII only: Bun's client hands a HINT holding a non-ASCII character back mis-decoded (030's fourth review pass).
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF to_regprocedure('node_state(uuid[])') IS NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 059 needs 058 (node_state); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'query_log' AND column_name = 'arm') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 059 needs 045 (query_log.arm); this schema lacks it',
      HINT = 'The ledger records the migrations but the schema is older (adopted with --baseline?). Re-apply every migration in one transaction: cd db && bun migrate.ts --url <url> --reapply',
      ERRCODE = 'invalid_schema_definition';
  END IF;
END
$g$;

-- ---------------------------------------------------------------------------
-- The weight
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION search_demote_weight()
RETURNS float
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 0.25::float $$;

COMMENT ON FUNCTION search_demote_weight() IS
  'What search_thoughts_current multiplies a settled or superseded thought''s fused score by: 0.25, pre-registered, one weight, exact in binary. The one place it is written. Migration 059 / SMD-2255.';

-- ---------------------------------------------------------------------------
-- search_thoughts_current — the hybrid, current thoughts first
-- ---------------------------------------------------------------------------
-- Dropped before it is created: its RETURNS TABLE is a contract (the trap 058
-- names), and a replay must re-create it in this file's shape.
DROP FUNCTION IF EXISTS search_thoughts_current(vector, text, float, int, jsonb, float, float);

CREATE FUNCTION search_thoughts_current(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb,
  recency_weight   float   DEFAULT 0.0,
  half_life_days   float   DEFAULT 90.0
)
RETURNS TABLE (
  id               uuid,
  content          text,
  metadata         jsonb,
  created_at       timestamptz,
  similarity       float,
  matched_needles  text[],
  needles          text[],
  needle_counts    int[],
  common_needles   text[],
  literal_only     boolean,
  score            float,     -- fused × the weight: the rank's own score
  fused            float,     -- the hybrid's score, before the weight
  demoted          text[],    -- the status_type and/or 'superseded' that weighted it; NULL when not
  window_rows      int,       -- every row: the window's size
  window_known     int,       -- every row: how many in the window carry a lifecycle
  window_demoted   int,       -- every row: how many in the window were demoted
  window_synced_at text,      -- every row: the latest source watermark in the window
  window_exact     boolean    -- every row: the top N is the whole admitted list, weighted
)
LANGUAGE sql
STABLE
SET jit = off
AS $$
  WITH n AS (SELECT least(greatest(coalesce(match_count, 10), 1), 100) AS v_count),
  win AS (
    SELECT h.*, least(100, 4 * n.v_count) AS w
      FROM n, search_thoughts_hybrid(query_embedding, query_text, match_threshold, least(100, 4 * n.v_count),
                                     filter, recency_weight, half_life_days)
           WITH ORDINALITY AS h(hid, hcontent, hmetadata, hcreated_at, hsim, hmatched, hneedles, hcounts, hcommon, hliteral, hfused, ord)),
  st AS (
    SELECT win.*, s.status_type, s.synced_at, s.open,
           coalesce(s.open = false, false) AS settled,
           s.superseded_by IS NOT NULL AS superseded
      FROM win LEFT JOIN node_state(NULL) s ON s.thought_id = win.hid),
  agg AS (
    SELECT count(*)::int AS rows_,
           count(*) FILTER (WHERE open IS NOT NULL)::int AS known,
           count(*) FILTER (WHERE settled OR superseded)::int AS dem,
           max(synced_at) FILTER (WHERE open IS NOT NULL) AS synced,
           max(w) AS w
      FROM st)
  SELECT st.hid, st.hcontent, st.hmetadata, st.hcreated_at, st.hsim, st.hmatched, st.hneedles, st.hcounts, st.hcommon, st.hliteral,
         (st.hfused * CASE WHEN st.settled OR st.superseded THEN search_demote_weight() ELSE 1 END)::float,
         st.hfused::float,
         nullif(array_remove(ARRAY[CASE WHEN st.settled THEN st.status_type END,
                                   CASE WHEN st.superseded THEN 'superseded' END], NULL), '{}'),
         a.rows_, a.known, a.dem, a.synced,
         (a.rows_ < a.w OR a.rows_ - a.dem >= (SELECT v_count FROM n))
    FROM st CROSS JOIN agg a
   ORDER BY 11 DESC, (st.settled OR st.superseded), st.ord
   LIMIT (SELECT v_count FROM n)
$$;

COMMENT ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float) IS
  'search_thoughts_hybrid with settled and superseded thoughts ranked below current ones, for search_thoughts'' opt-in prefer_current: over the hybrid''s top min(100, 4N), a thought node_state (058) says is settled (its ticket completed or canceled — a note under a Done ticket included) or superseded weighs search_demote_weight() (0.25) of its fused score, once; the window is re-sorted (ties to the current row, then the hybrid''s order) and cut to N. In practice every current match in the window ranks first; an exact-literal hit on a demoted thought is demoted too. Blocked or unknown status does not demote a thought (superseded still does). Returns the hybrid''s columns, then fused, demoted (why), and on every row the window''s size, lifecycle coverage, demoted count, latest source watermark and whether the top N is exact. Migration 059 / SMD-2255 (SMD-2074).';

-- ---------------------------------------------------------------------------
-- The query log: arm 'current'
-- ---------------------------------------------------------------------------
ALTER TABLE query_log DROP CONSTRAINT IF EXISTS query_log_arm_check;
ALTER TABLE query_log ADD CONSTRAINT query_log_arm_check CHECK (arm IS NULL OR arm IN ('hybrid', 'keyword', 'current'));

COMMENT ON COLUMN query_log.arm IS
  'Which retrieval arm served a search row: hybrid (search, search_thoughts — the vector arm fused with the exact-literal arm, migration 017), keyword (search_thoughts_keyword — exact substring, migration 012) or current (search_thoughts with prefer_current — the hybrid with settled and superseded thoughts ranked below current ones, migration 059, SMD-2255). NULL on an action row. The tool column names the MCP tool; arm names the retrieval path, so a per-arm report can group across tools and tell two arms of one tool apart (SMD-1490, for SMD-1735/1737). Keyword searches are logged from SMD-1490 on — 034 logged only the semantic path, and the search tools now share one search operation that is the single writer.';
