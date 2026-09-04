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
--      68 to 79. 007's header calling the factor "a recall budget, not a guess"
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
--     50%                 10.0        7.7               0/50
--     10%                  5.4        5.0               0/50
--      1%                  0.8        0.8              25/50
--      0.1% (9 rows)        0.1        0.1              46/50
--
--   After: 10.0 returned at every tier that has 10 rows, 10.0 in the exact
--   top-10 at 10% and below, 9.4 at 50%, 0 empty. At 100,000 rows the before
--   column is the same shape (27 of 50 empty at 1%, 49 of 50 at 0.1%) and the
--   after column is complete at 1% and thinner, while at 50% and 10% it holds
--   6.0 and 9.0 of the exact top-10 against 007's 4.4 and 3.9. That residue is
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
--     recall this migration exists to fix. That validation needs pgvector's
--     library LOADED in the session, which is why the file opens with
--     `SELECT '[1]'::vector` — earlier drafts credited the `vector(N)` typmod
--     in the signature with forcing the load, and that was true only for a
--     superuser: Postgres checks a function's SET clauses before it resolves its
--     parameter types, and a non-superuser owner in a session that had not yet
--     touched pgvector was refused with "permission denied to set parameter".
--     The seventh review pass reproduced it on the upgrade path; the explicit
--     load is the fix, and every printed ALTER DATABASE remedy carries it too.
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
--     iterative HNSW walk does everything: 210–295 ms for a thin or empty
--     filter at 100,000 rows (db/bench-hnsw.ts section D). plpgsql switches to
--     the generic plan after five calls whenever its estimate is not costlier,
--     per connection, and the pool has ten of them. Forcing the custom plan
--     costs replanning on every call — measured at 100,000 rows as 1.49 ms
--     against 1.56 ms for the default unfiltered search, i.e. nothing
--     distinguishable — and takes the cliff off the table rather than betting
--     on the estimate. The planner still picks the HNSW walk for some filters
--     even with the constant known, and not always the same way: at 100,000
--     rows the 1% tier went to the walk in one run (41 ms) and to the GIN
--     index in the next (2 ms), complete either way; the 0.1% tier went to the
--     GIN index at 0.7 ms in both.
--
--   * The two bounds on the walk — hnsw.max_scan_tuples = 100000 and
--     hnsw.scan_mem_multiplier = 8 — are seeded ONCE at database level by the
--     DO block after the function, not declared on the function. pgvector stops
--     an iterative scan at EITHER the tuple cap or when the scan's memory
--     exceeds work_mem * scan_mem_multiplier (4 MB * 1 by default, about 19,000
--     visited tuples at ~215 bytes each). The first draft of this migration set
--     only the tuple cap; the second review pass caught that the memory bound
--     was the one actually stopping the scan, which is why raising the cap from
--     20,000 to 400,000 had changed nothing. Measured at 100,000 rows with the
--     generic plan forced, tuple cap 100,000: with the multiplier at its default
--     a filter with 15 matching rows returned 6.3 of 10 asked and one with 110
--     rows returned 42 of 50 — short, silently; with the multiplier at 8 both
--     returned everything, at ~300 ms for the full walk. With both bounds
--     seeded at database level — and the bench's session reconnected to read
--     them, which an earlier draft's RESET ALL had not done; the sixth review
--     pass caught that — db/bench-hnsw.ts section D forces the walk at 100,000
--     rows and it completes: 90 matching rows → 10 of 10 in 211 ms, 6 → 6 of 6
--     in 289 ms, nothing → nothing in 294 ms. The bound needed is roughly
--     v_fetch / selectivity, so pgvector's default covers a 0.1% filter only
--     to match_count 5 on a million rows; 100,000 covers 25. With the custom
--     plan forced, the walk is reached only when the planner still prefers the
--     HNSW index under a filter, so these are a floor under a path that is now
--     rarely taken — but they are the reason that path returns everything when
--     it is.
--
--     Why database level. The third and fourth drafts declared them as
--     function-level SETs and then built machinery to compensate: a SET on the
--     function overrides any database- or role-level value, and CREATE OR
--     REPLACE rewrites proconfig, so an operator's tuning had nowhere durable to
--     live except a template variable threaded through config, compose, tests
--     and preflight. The fifth review pass named that for what it was. One
--     `ALTER DATABASE ... SET` by the owner is the whole tuning surface: every
--     session honours it, no redefinition of the function touches it, and this
--     migration only seeds a value where none exists. The cost is that the
--     migrating role must own the database to seed the defaults; where it does
--     not, the DO block warns with the two statements and the migration still
--     applies — the fix does not depend on the bounds, only the depth of a rare
--     walk does. Sessions read database-level settings at connect, so a running
--     server picks up a change when its pool reconnects.
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
--   * match_count is now load-bearing for cost, and is clamped to 1–100 INSIDE
--     the function, as 012 clamps its p_limit. 007 capped each CTE at ~40
--     candidates whatever was asked; this function honours v_fetch, so an
--     unclamped call with match_count 5000 would walk each CTE to 20,000
--     passing candidates and group 40,000 rows. Both servers' search_thoughts
--     tools also bound `limit` to 1–100, but the callers who send a filter —
--     direct SQL, PostgREST, the community integrations — are outside that
--     bound, and one of them sends match_count 150 with a filter no row's
--     metadata matches literally, which under an unclamped 014 is a full walk
--     per call. What the clamp costs: integrations that requested 200–500 rows
--     as headroom for their own client-side post-filter (rest-api by date,
--     agent-memory-api by scope) now get 100 — more than 007 ever returned,
--     but less than they asked for, and without a signal. 0 and negative
--     counts return 1 row, NULL returns 10. db/test-schema.ts [8b] asserts the
--     edges; db/test-live.ts [5b] asserts the ceiling.
--
--   * Memory. The walk's memory bound is work_mem * scan_mem_multiplier per
--     scan node — two per filtered call, one per CTE — per backend: 32 MB each
--     at the default 4 MB work_mem, though the 100,000-tuple cap binds first at
--     roughly 21 MB. With the server's default pool of ten, ten concurrent thin
--     filters can transiently take 430–640 MB across the pool on top of
--     shared_buffers. Raising work_mem for other reasons raises this with it;
--     raising the multiplier does too. Size the container for it, or lower the
--     multiplier where memory is tighter than latency.
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
--   `hnsw.max_scan_tuples`; `pg_proc.proconfig` for it records the iterative-scan
--   setting and the forced plan mode so preflight and the schema test can see
--   them, and `pg_db_role_setting` for the database records the two bounds
--   unless an operator had already set them.
-- ============================================================================

-- Load pgvector's library into THIS session before the CREATE below. The SET
-- clauses name hnsw.* settings, and Postgres validates them before it resolves
-- the vector(N) parameter types — so in a session that has not yet touched
-- pgvector, a role that is not a superuser is refused with "permission denied
-- to set parameter" (the hnsw prefix is reserved and, unloaded, unknown). A
-- superuser may set unknown placeholders and never sees it; every earlier
-- verification of this migration ran as one. Fresh installs passed only because
-- 001 had loaded the library in the same session. One cast is enough.
SELECT '[1]'::vector;

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
-- Both are scoped to this call and restored on exit. The first requires
-- pgvector >= 0.8.0, and the CREATE fails on anything older rather than
-- producing a function that quietly stops at the first ef_search candidates.
-- The second is what keeps the filtered path off the iterative walk in the
-- first place. The walk's two BOUNDS are deliberately not here: a function-level
-- SET would override the database-level values seeded below, which are the
-- operator's tuning knob. The header has the measurements behind each.
SET hnsw.iterative_scan = relaxed_order
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  -- Clamped here, as 012 clamps its p_limit: the cost of a call is now
  -- proportional to match_count (the iterative scan honours v_fetch), and the
  -- callers who send a filter are direct SQL and PostgREST — outside the zod
  -- bound the two servers apply. Three edges change from 007, deliberately:
  -- 0 returns 1 row (was 0), a negative count returns 1 row (was an error),
  -- NULL returns 10 (was LIMIT NULL, the whole candidate set). Counts above
  -- 100 are cut to 100: some integrations ask for up to 200 or 500 as headroom
  -- for a client-side post-filter (rest-api by date, agent-memory-api by
  -- scope) and lose that headroom here — still far more than 007's effective
  -- cap near 80, and a later migration can raise the ceiling if one needs it.
  v_count      int     := LEAST(GREATEST(COALESCE(match_count, 10), 1), 100);
  v_fetch      int     := GREATEST(v_count * 4, 20);
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
    -- join the default ten-row search costs what 007's did — 0.86 → 0.75 ms at
    -- 10,000 rows, 1.38 → 1.35 ms at 100,000 (db/bench-hnsw.ts, A).
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
  LIMIT v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- The walk's two bounds, seeded ONCE at database level
--
-- pgvector stops an iterative scan at whichever comes first: hnsw.max_scan_tuples
-- (default 20,000) or a memory bound of work_mem * hnsw.scan_mem_multiplier
-- (default 4 MB * 1, about 19,000 visited tuples). Both defaults leave a thin
-- filter returning short; the header has the measurements behind 100000 and 8.
--
-- They are set on the DATABASE, not on the function, and only when nothing has
-- set them yet. A function-level SET would win over any database- or role-level
-- value and would be rewritten by every CREATE OR REPLACE of match_thoughts, so
-- an operator's tuning could live nowhere durable. Here it lives in
-- pg_db_role_setting: one `ALTER DATABASE ... SET hnsw.max_scan_tuples = N` by
-- the owner is honoured by every session, survives every redefinition of the
-- function, and is never overwritten by re-running this migration. Sessions
-- pick database-level settings up at connect, so a running server sees a new
-- value after its pool reconnects (a restart does it).
--
-- ALTER DATABASE needs the database's owner (or a superuser). Where the
-- migrating role is neither — some hosted platforms — this raises a WARNING
-- with the two statements to run, and the migration still applies: the fix
-- above does not depend on the bounds, only the depth of a rare walk does.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_db       text := current_database();
  v_existing text[];
BEGIN
  SELECT s.setconfig INTO v_existing
  FROM pg_db_role_setting s
  JOIN pg_database d ON d.oid = s.setdatabase
  WHERE d.datname = v_db AND s.setrole = 0;

  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(v_existing, '{}')) c WHERE c LIKE 'hnsw.max_scan_tuples=%') THEN
    EXECUTE format('ALTER DATABASE %I SET hnsw.max_scan_tuples = 100000', v_db);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(COALESCE(v_existing, '{}')) c WHERE c LIKE 'hnsw.scan_mem_multiplier=%') THEN
    EXECUTE format('ALTER DATABASE %I SET hnsw.scan_mem_multiplier = 8', v_db);
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING USING
    MESSAGE = format('match_thoughts: could not seed the database-level HNSW scan bounds (%s).', SQLERRM),
    HINT = format('Run as the database owner, in one session: SELECT ''[1]''::vector; ALTER DATABASE %I SET hnsw.max_scan_tuples = 100000; ALTER DATABASE %I SET hnsw.scan_mem_multiplier = 8;  (the SELECT loads pgvector so a non-superuser may set hnsw.* settings)', v_db, v_db);
END $$;

-- `[filter-inside-scan]` is a CONTRACT MARKER, not prose: preflight decides
-- whether this function has 014's semantics — the metadata filter applied inside
-- the candidate scan — by looking for it here, not by grepping the body for a
-- local variable's name. A later migration that redefines match_thoughts and
-- keeps that property must carry the marker into its own COMMENT; one that
-- reintroduces a post-LIMIT filter must not. db/test-schema.ts [8b] asserts it.
COMMENT ON FUNCTION match_thoughts(vector, float, int, jsonb) IS
  '[filter-inside-scan] Semantic search over whole-thought vectors and chunk vectors, deduplicated to one row per thought scored by its best evidence. The metadata filter is applied inside the index scan (iterative HNSW scan, pgvector >= 0.8), so a selective filter does not silently empty the result.';
