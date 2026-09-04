-- ============================================================================
-- 014 — match_thoughts: the metadata filter reaches the index scan, and the
--        candidate LIMIT means what it says
--
-- Why
--   Two defects in 007's match_thoughts. Both are silent: no error, fewer rows.
--
--   1. The filter ran AFTER the candidates were chosen. Each CTE took its top
--      `v_fetch` rows by distance, and only then did the outer query apply
--      `t.metadata @> filter`. A filter that matches 1% of the corpus therefore
--      saw at most 1% of 40 candidates — usually none — while hundreds of rows
--      matched. Upstream reports the same defect against the guide's original
--      function (NateBJones-Projects/OB1#417); this fork's version was worse,
--      because the explicit LIMIT capped the candidate set before the filter
--      regardless of any pgvector setting. Raising `hnsw.ef_search`, upstream's
--      one-line fix, could not have helped here.
--
--   2. The overfetch was a fiction above the default count. pgvector's HNSW scan
--      returns at most `hnsw.ef_search` rows — 40 by default — and then stops.
--      `ORDER BY embedding <=> q LIMIT 200` returns 40 rows on a 10,000-row
--      table. `v_fetch = GREATEST(match_count * 4, 20)` is 40 at the default
--      match_count and larger above it, so each CTE could never contribute more
--      than 40 candidates: with no chunk rows a caller asking for 50 got 40, and
--      with chunk rows the two sources together capped near 80 — asked 100, got
--      71 to 79. 007's header calling the factor "a recall budget, not a guess"
--      was true only at match_count <= 10.
--
--   Measured before this migration — db/bench-hnsw.ts, 10,000 random rows,
--   pgvector 0.8.6, 50 random queries per filter, 10 rows asked, against an
--   exact scan over the same rows:
--
--     filter matches   returned   in exact top-10   empty results
--     50%                 10.0        9.3               0/50
--     10%                  5.8        5.4               1/50
--      1%                  0.4        0.4              33/50
--      0.1%                0.1        0.1              45/50
--
--   After: 10.0 returned and 10.0 in the exact top-10 at every selectivity,
--   0 empty. At 100,000 rows the before column is the same shape (47 of 50
--   empty at 1%) and the after column stays at 10.0 returned with 9.1–9.8 in
--   the exact top-10 — the HNSW approximation, which was always there. The
--   full tables, and the real-corpus measurement, are in FORK.md change 28.
--
-- Design
--   * The filter moves INSIDE both CTEs, so the HNSW scan applies it to each
--     candidate as it is produced and keeps scanning until `v_fetch` rows pass.
--     For `thoughts` that is a plain Filter on the index scan. For
--     `thought_chunks` it is a join to the parent row, because the chunk carries
--     no metadata of its own — which is what 007 said the filtered case would
--     need, and never did.
--
--   * `hnsw.iterative_scan = relaxed_order`, set on the FUNCTION. This is what
--     turns the post-filter into a correct one: without it the scan hands over
--     its first `ef_search` candidates and stops, filter or no filter. A
--     function-level SET is scoped to the call and restored on exit, so nothing
--     leaks into the caller's transaction the way `SET LOCAL` would, and it does
--     not depend on a connection pool preserving session state. It is also
--     validated when the function is CREATED: on pgvector older than 0.8.0 this
--     migration fails with `unrecognized configuration parameter`, which is the
--     intended failure. A version of this function that silently ran without
--     the setting would have exactly the recall this migration exists to fix.
--
--   * `relaxed_order`, not `strict_order`. The iterative scan may yield a
--     candidate slightly out of distance order; the final `ORDER BY b.sim DESC`
--     re-sorts the merged set anyway, so strict ordering inside the scan would
--     cost more and change nothing.
--
--   * `hnsw.ef_search` is left at its default. At the default match_count,
--     `v_fetch` is 40 and the first batch already satisfies the LIMIT, so the
--     unfiltered default path is bit-identical to 007's — asserted, not assumed,
--     in db/test-schema.ts [8] and db/bench-hnsw.ts. Above the default the
--     iterative scan continues to the LIMIT instead of stopping at 40.
--
--   * `hnsw.max_scan_tuples` (default 20,000) bounds the iterative scan. A
--     filter that passes fewer than `v_fetch` rows within 20,000 visited tuples
--     returns what it found. On a corpus where a common filter matches under
--     0.2% of rows, raise it — or add a partial index — rather than lowering
--     expectations; the bench prints the row counts to show where that starts.
--
--   * A NULL filter is unfiltered. 007 evaluated `NULL = '{}'::jsonb OR
--     t.metadata @> NULL`, which is NULL, which excluded every row: a caller
--     passing NULL got zero results and no error. Neither store passes NULL
--     (both send `{}`); a hand-written PostgREST call can.
--
--   * The single query text is kept, with `v_unfiltered OR ...` rather than an
--     IF branching into two near-identical statements. Two copies of this
--     query is the defined-twice defect FORK.md keeps finding. The cost is that
--     the planner cannot use the GIN index on `metadata` for an OR against a
--     parameter, so the filter is applied by the HNSW scan (or by a sequential
--     scan when the planner prefers one at small scale). Either is exact
--     for the filter; only the vector side is approximate, as it always was.
--
--   * Signature, return shape and the strict `> match_threshold` are unchanged.
--     store-sql.ts and store-postgrest.ts call it exactly as before.
--
-- Prerequisites
--   Migration 007 (thought_chunks). pgvector 0.8.0 or later — see above.
--   Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   `match_thoughts` returns `match_count` rows whenever that many pass the
--   threshold and filter, for any filter selectivity the scan can reach within
--   `hnsw.max_scan_tuples`, and `pg_proc.proconfig` for it records the
--   iterative-scan setting so preflight and the schema test can see it.
-- ============================================================================

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding  vector({{EMBEDDING_DIM}}),
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id          uuid,
  content     text,
  metadata    jsonb,
  similarity  float,
  created_at  timestamptz
)
LANGUAGE plpgsql
-- Scoped to this call; restored on exit. Requires pgvector >= 0.8.0, and the
-- CREATE fails on anything older rather than producing a function that quietly
-- stops at the first ef_search candidates.
SET hnsw.iterative_scan = relaxed_order
AS $$
DECLARE
  v_fetch      int     := GREATEST(match_count * 4, 20);
  v_unfiltered boolean := (filter IS NULL OR filter = '{}'::jsonb);
BEGIN
  RETURN QUERY
  WITH direct AS (
    SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
    FROM thoughts t
    WHERE t.embedding IS NOT NULL
      AND (v_unfiltered OR t.metadata @> filter)
    ORDER BY t.embedding <=> query_embedding
    LIMIT v_fetch
  ),
  chunked AS (
    -- A JOIN, not an EXISTS. Inside an OR the planner cannot turn EXISTS into a
    -- semi-join, so it ran it as a hashed subplan: one full pass over `thoughts`
    -- per query to build the hash, whatever the filter. The join is one
    -- primary-key lookup per candidate the scan produces — measured, a full
    -- pass at 10,000 rows was 3x the whole query's former cost.
    SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
    FROM thought_chunks c
    JOIN thoughts p ON p.id = c.thought_id
    WHERE (v_unfiltered OR p.metadata @> filter)
    ORDER BY c.embedding <=> query_embedding
    LIMIT v_fetch
  ),
  best AS (
    SELECT u.tid, MAX(u.sim) AS sim
    FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
    GROUP BY u.tid
  )
  SELECT
    t.id,
    t.content,
    t.metadata,
    b.sim,
    t.created_at
  FROM best b
  JOIN thoughts t ON t.id = b.tid
  WHERE b.sim > match_threshold
  ORDER BY b.sim DESC
  LIMIT match_count;
END;
$$;

COMMENT ON FUNCTION match_thoughts(vector, float, int, jsonb) IS
  'Semantic search over whole-thought vectors and chunk vectors, deduplicated to one row per thought scored by its best evidence. The metadata filter is applied inside the index scan (iterative HNSW scan, pgvector >= 0.8), so a selective filter does not silently empty the result.';
