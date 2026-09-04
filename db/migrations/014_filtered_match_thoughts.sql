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
--      69 to 77. 007's header calling the factor "a recall budget, not a guess"
--      was true only at match_count <= 10.
--
--   Who this reached. The server's own search_thoughts tool has no filter
--   input and passes `{}` on every call (server/index.ts and
--   server-portable/index.ts both), so defect 1 never touched first-party
--   search. It reached direct SQL callers, PostgREST RPC callers, and community
--   code that sends a filter of its own — integrations/enhanced-mcp's
--   `metadata_filter`, recipes/local-brain-no-mcp's search function. Defect 2
--   did reach first-party callers, above match_count 10.
--
--   Measured before this migration — db/bench-hnsw.ts, 10,000 random rows,
--   pgvector 0.8.6, 50 random queries per filter, 10 rows asked, against an
--   exact scan over the same rows:
--
--     filter matches   returned   in exact top-10   empty results
--     50%                 10.0        8.0               0/50
--     10%                  5.4        4.9               0/50
--      1%                  0.8        0.8              25/50
--      0.1% (9 rows)        0.1        0.1              46/50
--
--   After: 10.0 returned at every tier that has 10 rows, 10.0 in the exact
--   top-10 at 10% and below, 9.4 at 50%, 0 empty. At 100,000 rows the before
--   column is the same shape (28 of 50 empty at 1%, 49 of 50 at 0.1%) and the
--   after column is complete at 1% and thinner, while at 50% and 10% it holds
--   6.6 and 8.7 of the exact top-10 against 007's 4.7 and 3.6. That residue is
--   the HNSW approximation: random uniform vectors are the index's hardest
--   case, the approximation was always there, and the iterative scan improves
--   it because it keeps going. The full tables, and the real-corpus
--   measurement, are in FORK.md change 28.
--
-- Design
--   * The filter moves INSIDE both CTEs, so the HNSW scan applies it to each
--     candidate as it is produced and keeps scanning until `v_fetch` rows pass.
--     For `thoughts` that is a plain Filter on the index scan. For
--     `thought_chunks` it is a LEFT JOIN to the parent row, because the chunk
--     carries no metadata of its own — which is what 007 said the filtered case
--     would need, and never did. LEFT so that the unfiltered path can drop the
--     lookup entirely (see the body); it is result-identical because every
--     chunk has exactly one parent.
--
--   * `hnsw.iterative_scan = relaxed_order`, set on the FUNCTION. This is what
--     turns the post-filter into a correct one: without it the scan hands over
--     its first `ef_search` candidates and stops, filter or no filter. A
--     function-level SET is scoped to the call and restored on exit, so nothing
--     leaks into the caller's transaction the way `SET LOCAL` would, and it does
--     not depend on a connection pool preserving session state. It is also
--     validated when the function is CREATED: on pgvector older than 0.8.0 this
--     migration fails with
--       invalid configuration parameter name "hnsw.iterative_scan"
--       DETAIL: "hnsw" is a reserved prefix.
--     which is the intended failure (reproduced on 0.7.4). A version of this
--     function that silently ran without the setting would have exactly the
--     recall this migration exists to fix. The validation happens because the
--     `vector({{EMBEDDING_DIM}})` parameter forces pgvector's library to load
--     before the SET is checked; a bare `vector` argument would not, and on an
--     old server the SET would then be stored as an unvalidated placeholder.
--     Keep the typmod in the signature.
--
--   * `relaxed_order`, not `strict_order`. The iterative scan may yield a
--     candidate slightly out of distance order; the final `ORDER BY b.sim DESC`
--     re-sorts the merged set anyway, so strict ordering inside the scan would
--     cost more and change nothing.
--
--   * `hnsw.ef_search` is left at its default. At the default match_count,
--     `v_fetch` is 40 and the first batch already satisfies the LIMIT, so the
--     unfiltered default path returns the same rows as 007's — asserted, not
--     assumed, row for row on 441 real queries by evals/eval-filtered.ts, which
--     exits non-zero if any differ, and by row count in db/bench-hnsw.ts. Above
--     the default the iterative scan continues to the LIMIT instead of stopping
--     at 40.
--
--   * `plan_cache_mode = force_custom_plan`, so the filter is always a constant
--     when this body is planned. That matters because the two plans the OR
--     admits are not close: under a custom plan `false OR metadata @> {...}`
--     folds and the planner can route a thin filter to the GIN index on
--     `metadata` and sort the few matches — exact, sub-millisecond; under a
--     generic plan the OR against a parameter rules the GIN index out and the
--     iterative HNSW walk does everything: 200–270 ms for a thin or empty
--     filter at 100,000 rows (db/bench-hnsw.ts section D). plpgsql switches to
--     the generic plan after five calls whenever its estimate is not costlier,
--     per connection, and the pool has ten of them. Forcing the custom plan
--     costs replanning on every call — measured at 100,000 rows as 1.49 ms
--     against 1.56 ms for the default unfiltered search, i.e. nothing
--     distinguishable — and takes the cliff off the table rather than betting
--     on the estimate. The planner still picks the HNSW walk for some filters
--     even with the constant known: at 100,000 rows the 1% tier went that way
--     and cost 41 ms, complete; the 0.1% tier went to the GIN index at 0.7 ms.
--
--   * `hnsw.max_scan_tuples = 100000` and `hnsw.scan_mem_multiplier = 8`, the
--     two bounds on the walk when it does happen. pgvector stops an iterative
--     scan at EITHER: the tuple cap, or when the scan's memory exceeds
--     work_mem * scan_mem_multiplier (4 MB * 1 by default, about 19,000 visited
--     tuples at ~215 bytes each). The first draft of this migration set only
--     the tuple cap, and the second review pass caught that the memory bound
--     was the one actually stopping the scan — which is why raising the cap
--     from 20,000 to 400,000 had changed nothing. Measured at 100,000 rows with
--     the generic plan forced, tuple cap 100,000: with the multiplier at its
--     default a filter with 15 matching rows returned 6.3 of 10 asked and one
--     with 110 rows returned 42 of 50 — short, silently; with the multiplier at
--     8 both returned everything, at ~300 ms for the full walk. With both
--     bounds in place, db/bench-hnsw.ts section D forces the walk at 100,000
--     rows and it completes: 90 matching rows → 10 of 10 in 196 ms, 6 → 6 of 6
--     in 272 ms, nothing → nothing in 268 ms. The bound needed is roughly
--     v_fetch / selectivity, so pgvector's default covers a 0.1% filter only
--     to match_count 5 on a million rows; 100,000 covers 25.
--     With the custom plan forced above, the walk is reached only when the
--     planner still prefers the HNSW index under a filter, so these are a floor
--     under a path that is now rarely taken — but they are the reason that path
--     returns everything when it is.
--
--   * Two invariants the body leans on, stated because SMD-945 and SMD-958 will
--     rewrite it. First, `v_unfiltered` is a BOOLEAN LOCAL, not a rewrite of
--     the filter: under the forced custom plan it is a known constant, so on
--     the default path `true OR …` folds away and the chunk-side join can be
--     removed, and on the filtered path `false OR …` leaves a strict predicate
--     the planner can route to the GIN index. A tempting simplification —
--     `WHERE t.metadata @> COALESCE(filter, '{}')` — is wrong twice: it drops
--     every row whose metadata is NULL or not an object from UNFILTERED search
--     (`NULL @> '{}'` is NULL, `'[1]' @> '{}'` is false), and with no
--     containment statistics the planner would route the default path to the
--     GIN bitmap and lose the join removal. Second, therefore: `thoughts.metadata`
--     is nullable and unconstrained (001 declares `jsonb DEFAULT '{}'` with no
--     NOT NULL and no jsonb_typeof CHECK; 004 stores `p_payload->'metadata'`
--     unchecked; the `||` merges in 005 and 013 can turn an object into an
--     array). The unfiltered path must not care. db/test-schema.ts [8b] plants a
--     NULL row and an array row and asserts both come back unfiltered.
--
--   * `v_fetch := GREATEST(match_count * 4, 20)` is 007's factor, kept on
--     purpose. 007 justified it as a recall budget against the ef_search cap,
--     which no longer applies; the reasons it still earns its place are that
--     under relaxed_order the CTE has no Sort node — `LIMIT v_fetch` slices an
--     approximately ordered yield, and the slack is what absorbs candidates the
--     scan delivers slightly out of order — and that the chunked CTE's rows
--     collapse to one per thought, so several of its candidates are the same
--     answer. The cost is real on the walk path: the scan finds 4x the
--     filter-passing rows the caller asked for, and the tuple-cap arithmetic
--     above inherits the factor. Sizing it differently (smaller on `direct`,
--     chunk-count-based on `chunked`) is a follow-up with its own measurement,
--     which must include the unfiltered row-identity control the eval runs.
--
--   * These are function-level SETs, and CREATE OR REPLACE FUNCTION rewrites
--     proconfig wholesale, so an operator's `ALTER FUNCTION ... SET
--     hnsw.max_scan_tuples = 400000` is discarded by the next redefinition of
--     match_thoughts without any error — and the function's own SET overrides
--     a database- or role-level value. A tuned bound therefore has to be
--     re-applied after every migration that touches this function, or carried
--     into that migration. db/test-schema.ts [8b] pins the shipped values so a
--     change to them is deliberate.
--
--   * A NULL filter is unfiltered. 007 evaluated `NULL = '{}'::jsonb OR
--     t.metadata @> NULL`, which is NULL, which excluded every row: a caller
--     passing NULL got zero results and no error. Neither store passes NULL
--     (both send `{}`); a hand-written PostgREST call can.
--
--   * The single query text is kept, with `v_unfiltered OR ...` rather than an
--     IF branching into two near-identical statements. Two copies of this
--     query is the defined-twice defect FORK.md keeps finding. The planner then
--     has two ways to run it, and db/bench-hnsw.ts shows both: under a CUSTOM
--     plan (plpgsql's first five calls, and after that whenever the generic
--     estimate is costlier) the parameter is a known constant, `false OR …`
--     folds away, and the planner may pick the GIN index on `metadata` and sort
--     the matches — exact, and cheap when the filter is selective. Under a
--     GENERIC plan the OR against a parameter rules the GIN index out and the
--     filter is applied by the iterative HNSW scan. Either is exact for the
--     filter; only the vector side is approximate, as it always was. The
--     `plan_cache_mode` SET above keeps this function on the first shape; the
--     two scan bounds are about the second.
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
-- All four are scoped to this call and restored on exit. The first requires
-- pgvector >= 0.8.0, and the CREATE fails on anything older rather than
-- producing a function that quietly stops at the first ef_search candidates.
-- The two bounds travel with the mode — the tuple cap is only the operative
-- bound if the memory bound is above it — and the plan mode is what keeps the
-- filtered path off the iterative walk in the first place. The header has the
-- measurements behind each value and says when to change them.
SET hnsw.iterative_scan = relaxed_order
SET hnsw.max_scan_tuples = 100000
SET hnsw.scan_mem_multiplier = 8
SET plan_cache_mode = force_custom_plan
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
    -- A join, not an EXISTS. Inside an OR the planner cannot turn EXISTS into a
    -- semi-join, so it ran it as a hashed subplan: one full pass over `thoughts`
    -- per query to build the hash, whatever the filter. The join is one
    -- primary-key lookup per candidate the scan produces — measured, a full
    -- pass at 10,000 rows was 3x the whole query's former cost.
    --
    -- A LEFT join, because it is result-identical (007 declares thought_id
    -- NOT NULL REFERENCES thoughts, so every chunk has exactly one parent) and
    -- it lets the planner drop the lookup on the unfiltered path: under the
    -- custom plan this function forces, `true OR p.metadata @> filter` folds
    -- to true, `p` is then referenced only in the ON clause against its primary
    -- key, and join removal deletes it. With a real filter the predicate is
    -- strict and the planner reduces it back to an inner join. An inner join
    -- here paid the lookup on every default search for nothing; with the LEFT
    -- join the default ten-row search costs what 007's did — 0.73 ms before
    -- and after at 10,000 rows, 1.62 → 1.45 ms at 100,000 (db/bench-hnsw.ts, A).
    SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
    FROM thought_chunks c
    LEFT JOIN thoughts p ON p.id = c.thought_id
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
