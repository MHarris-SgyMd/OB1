-- ============================================================================
-- 014 — match_thoughts: the metadata filter reaches the index scan, and the
--        candidate LIMIT means what it says
--
-- requires: pgvector >= 0.8.0
--   (read by db/migrate.ts: the floor is judged against the server's library
--   before anything runs, and a later migration that redefines match_thoughts
--   with the same SET clause declares the same line rather than being named in
--   the migrator)
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
--     50%                 10.0        7.9               0/50
--     10%                  5.4        5.0               1/50
--      1%                  0.9        0.9              24/50
--      0.1% (9 rows)        0.1        0.1              46/50
--
--   After: 10.0 returned at every tier that has 10 rows, 10.0 in the exact
--   top-10 at 10% and below, 9.4 at 50%, 0 empty. At 100,000 rows the before
--   column is the same shape (29 of 50 empty at 1%, 48 of 50 at 0.1%) and the
--   after column is complete at 1% and thinner, while at 50% and 10% it holds
--   6.4 and 8.8 of the exact top-10 against 007's 4.7 and 3.8. That residue is
--   the HNSW approximation: random uniform vectors are the index's hardest
--   case, the approximation was always there, and the iterative scan improves
--   it because it keeps going. Thin filters cost less than an unfiltered call:
--   at 100,000 rows 0.19 ms for a filter matching nothing, 0.28 ms for one
--   matching 6 rows, 0.63 for 90, 2.6 for 998 (the exact branch below); broad
--   ones 2.9 ms (50%) and 9.1 ms (10%), the walk. Asking for the ceiling, 500
--   rows unfiltered, costs 6.5 ms at 10,000 rows and 27 ms at 100,000. The
--   full tables, and the real-corpus measurement, are in FORK.md change 28.
--
-- Design
--   * The filter moves INSIDE both CTEs, so the HNSW scan applies it to each
--     candidate as it is produced and keeps scanning until `v_fetch` rows pass.
--     For `thoughts` that is a plain predicate on the scan. For `thought_chunks`
--     it is a join to the parent row, because the chunk carries no metadata of
--     its own — which is what 007 said the filtered case would need, and never
--     did. The unfiltered path is its own branch with no predicate and no join.
--
--   * A filter matching at most v_exact thoughts (GREATEST(v_fetch * 4, 1000))
--     is answered EXACTLY, from the matching rows and their chunks, with no
--     index walk: one capped GIN count decides, then a GIN lookup and index
--     probes into thought_chunks with the matched ids score everything that
--     matches.
--     Two things made this necessary rather than nice. A filter no row can
--     pass — the shape one integration sends on every call — made the
--     walk-only draft run each CTE to the scan bound and return the same empty
--     answer 007 gave in 40 candidates, at 60+ ms and up to 32 MB per scan
--     (tenth review pass); it now costs one GIN probe. And the planner's
--     choice between the GIN index and the walk for a thin filter on a large
--     table varied between bench runs on identical data (2 ms one run, 190 ms
--     the next, at 100,000 rows) — the exact branch takes that choice away for
--     every filter under the threshold. Above it the walk has at least v_exact
--     rows to find its v_fetch among, so it visits about v_fetch * N / v_exact
--     tuples — N / 25 at the default count — and the seeded bounds are its
--     ceiling on tables past ~2.5 million rows (N / 4 at match_count 500, so
--     ~400,000 rows there). db/bench-hnsw.ts section D runs the walk's own
--     statement on the thin filters to show the bounds working when it is
--     reached.
--
--   * Two RETURN QUERY branches, one per path. Drafts three through eight kept
--     one query text with `v_unfiltered OR metadata @> filter` and then paid
--     for it in layers: the OR against a parameter hid the GIN index from the
--     generic plan, so the function had to force custom plans
--     (`plan_cache_mode`), so the chunk join had to be LEFT for join removal to
--     fire when the OR folded, so the next author needed a paragraph about why
--     a boolean local was load-bearing. The ninth review pass named the OR as
--     the root. With `metadata @> filter` plain, the planner has the GIN index
--     whichever plan mode plpgsql picks — the custom plan uses it on both
--     sides; the generic plan, where the filter is a parameter, uses it for
--     the direct side and walks the chunk index for the other, complete either
--     way (db/bench-hnsw.ts section C) — so the choice is latency, not recall,
--     and the function declares none. The two branches differ only in the
--     predicate and the chunk-side join. db/test-schema.ts [8b] holds both to
--     the same answer on the same rows.
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
--     The rule does NOT apply at CALL time, though the eighth draft of this
--     header said it did. CREATE FUNCTION and ALTER DATABASE validate a SET
--     clause up front and refuse an unknown `hnsw.*` placeholder to a
--     non-superuser; function ENTRY applies proconfig through the ordinary
--     set_config path, where the placeholder is a user-settable variable that
--     pgvector converts when the body's `<=>` loads the library. Reproduced in
--     the tenth review pass: a non-superuser owner and a plain reader, each in
--     a fresh session whose FIRST statement fed an existing `embedding` column
--     value into match_thoughts uncast, got their rows with relaxed_order in
--     force, while CREATE with the same clause in the same cold session was
--     refused. No caller needs to cast or pre-load anything.
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
--     returned everything. With both bounds
--     seeded at database level — and the bench's session reconnected to read
--     them, which an earlier draft's RESET ALL had not done; the sixth review
--     pass caught that — db/bench-hnsw.ts section D runs the walk branch's own
--     statement on the thin filters at 100,000 rows (the function itself never
--     walks for them, see the exact branch) and the walk completes: 90
--     matching rows → 10 of 10, 6 → 6 of 6, nothing → nothing, about 60 ms
--     each. Since the walk is taken only above v_exact matching rows, it
--     visits about v_fetch * N / v_exact tuples — N / 25 at the default count,
--     N / 4 at match_count 500 — so 100,000 covers tables to ~2.5 million rows
--     at the default count and ~400,000 at the ceiling; pgvector's default of
--     20,000 covers 500,000 and 80,000. Above the threshold which plan the
--     walk gets is the planner's, and it does not matter for the answer: at
--     100,000 rows the 10% tier ran 7.7 ms under the custom plan (HNSW on both
--     sides) and 7.8 ms under the generic (GIN for thoughts, HNSW for chunks),
--     the same rows, because the walk is iterative and bounded. Below it there
--     is no plan to pick — the exact branch is a GIN lookup and index probes,
--     0.2–2.7 ms at 100,000 rows under either mode — where the ninth draft's
--     walk-or-GIN choice for the same tiers had varied between 0.7 and 190 ms
--     on the same seeded data from one run to the next.
--
--     Why database level. The third and fourth drafts declared them as
--     function-level SETs and then built machinery to compensate: a SET on the
--     function overrides any database- or role-level value, and CREATE OR
--     REPLACE rewrites proconfig, so an operator's tuning had nowhere durable to
--     live except a template variable threaded through config, compose, tests
--     and preflight. The fifth review pass named that for what it was. One
--     `ALTER DATABASE ... SET` by the owner is the whole tuning surface: every
--     session honours it, no redefinition of the function touches it, and this
--     migration only seeds a value where nothing EVERY ROLE sees has set one —
--     server configuration (ALTER SYSTEM, postgresql.conf, a managed parameter
--     group) or the database. Precedence is role > database > server: a
--     database-level seed would silently undo an operator's ALTER SYSTEM, so
--     that is respected; it cannot touch a role-level value, and a role-level
--     value reaches one role, so that is no reason to leave every other role
--     at pgvector's defaults (the ninth draft's `source <> 'default'` test let
--     an ALTER ROLE on the migrating role do exactly that; tenth review pass).
--     The cost is that the
--     migrating role must own the database to seed the defaults; where it does
--     not, the DO block warns with the two statements and the migration still
--     applies — the fix does not depend on the bounds, only the depth of a rare
--     walk does. Sessions read database-level settings at connect, so a running
--     server picks up a change when its pool reconnects.
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
--   * match_count is now load-bearing for cost, and is clamped INSIDE the
--     function, as 012 clamps its p_limit — to {{MATCH_COUNT_CEILING}}, the
--     largest count any caller in the repo sends (enhanced-mcp asks for up to
--     500 under a date filter; rest-api and agent-memory-api up to 200), so no
--     caller's post-filter headroom is cut. 007 capped each CTE at ~40
--     candidates whatever was asked; this function honours v_fetch, so an
--     unclamped call with match_count 5000 would walk each CTE to 20,000
--     passing candidates and group 40,000 rows. Both servers' search_thoughts
--     tools bound their own `limit` to 100 — a choice about what to hand a
--     model — but the callers who send a filter are outside that bound. The
--     ceiling is measured (db/bench-hnsw.ts section A times asked-500), and a
--     count above it raises a NOTICE naming the cut, for the callers whose
--     driver surfaces notices; an earlier draft's 100 was neither measured nor
--     signalled and cut two integrations short (tenth review pass). 0 and
--     negative counts return 1 row, NULL returns 10. db/test-schema.ts [8b]
--     asserts the edges; db/test-live.ts [5b] asserts the ceiling.
--
--   * Memory. The walk's memory bound is work_mem * scan_mem_multiplier per
--     scan node — two per filtered call, one per CTE — per backend: 32 MB each
--     at the default 4 MB work_mem, though the 100,000-tuple cap binds first at
--     roughly 21 MB. With the server's default pool of ten, ten concurrent broad
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
--   setting so preflight and the schema test can see it, and the database
--   records the two bounds unless something had already set them anywhere.
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
-- Scoped to this call and restored on exit. Requires pgvector >= 0.8.0, and the
-- CREATE fails on anything older rather than producing a function that quietly
-- stops at the first ef_search candidates. The walk's two BOUNDS are
-- deliberately not here: a function-level SET would override the database-level
-- values seeded below, which are the operator's tuning knob.
SET hnsw.iterative_scan = relaxed_order
AS $$
DECLARE
  -- Clamped here, as 012 clamps its p_limit: the cost of a call is now
  -- proportional to match_count (the iterative scan honours v_fetch), and the
  -- callers who send a filter are direct SQL and PostgREST — outside the zod
  -- clamp the two servers apply. Three edges change from 007, deliberately:
  -- 0 returns 1 row (was 0), a negative count returns 1 row (was an error),
  -- NULL returns 10 (was LIMIT NULL, the whole candidate set). The ceiling,
  -- {{MATCH_COUNT_CEILING}}, is the largest count any caller in the repo sends
  -- (enhanced-mcp, 500 under a date filter) — an earlier draft's 100 cut two
  -- integrations' post-filter headroom short with no signal (tenth review
  -- pass) — and it is measured: db/bench-hnsw.ts section A times asked-500.
  -- A count above it is cut to it and a NOTICE says so, for the callers whose
  -- driver surfaces notices; the others get the ceiling's rows, which is more
  -- than 007 ever returned.
  v_count      int     := LEAST(GREATEST(COALESCE(match_count, 10), 1), {{MATCH_COUNT_CEILING}});
  v_fetch      int     := GREATEST(v_count * 4, 20);
  -- Filters matching at most this many thoughts are answered EXACTLY, from the
  -- matching rows and their chunks, with no index walk at all (see the
  -- filtered branches below). v_fetch * 4 for the counts where the walk would
  -- have to find nearly every matching row anyway; 1,000 as a floor because a
  -- thousand parents and their chunks are a few thousand distance
  -- computations — milliseconds at any width — and no walk is cheaper.
  v_exact      int     := GREATEST(v_fetch * 4, 1000);
BEGIN
  IF match_count > {{MATCH_COUNT_CEILING}} THEN
    RAISE NOTICE 'match_thoughts: match_count % clamped to {{MATCH_COUNT_CEILING}}', match_count;
  END IF;
  -- ob1:filter-inside-scan — a CONTRACT SENTINEL, not prose. It lives in the
  -- BODY (pg_proc.prosrc), which every CREATE OR REPLACE rewrites, so it says
  -- something about the function actually installed. (An earlier draft put a
  -- marker in COMMENT ON FUNCTION; pg_description is keyed on the OID that a
  -- replace preserves, so a successor that omitted its own COMMENT inherited
  -- the claim.) A later migration that redefines match_thoughts and keeps the
  -- filter inside the candidate scan carries this line; one that reintroduces
  -- a post-LIMIT filter must not. preflight reads it, and on the SQL store
  -- also probes the NULL-filter behaviour beside it; db/test-schema.ts [8b]
  -- asserts it.
  --
  -- Three branches, not one query with `v_unfiltered OR metadata @> filter`.
  -- Earlier drafts kept a single text and paid for it: the OR against a
  -- parameter hid the GIN index from the generic plan, which then needed
  -- `plan_cache_mode = force_custom_plan` on the function, which needed a
  -- LEFT JOIN whose removal depended on the OR folding to true, which needed
  -- a paragraph of invariants for the next author. With the predicate a plain
  -- `metadata @> filter` the planner has the GIN index whichever plan mode
  -- plpgsql picks, and none of that is load-bearing.
  --
  -- The filtered case then splits on how many thoughts match, counted through
  -- the GIN index and capped at v_exact + 1 so the count costs at most that
  -- many heap fetches. At most v_exact matching: score those rows and their
  -- chunks directly — exact, no index walk, and a filter matching NOTHING
  -- (the shape one integration sends on every call) costs one GIN probe and
  -- returns empty, where the walk-only draft ran to the scan bound and
  -- returned the same empty answer at 60+ ms (tenth review pass). More than
  -- v_exact matching: the HNSW walk with the predicate inside the scan, which
  -- has at least v_exact rows to find its v_fetch among, so it visits about
  -- v_fetch * N / v_exact tuples — N / 25 at the default count — and the
  -- database-level bounds are its ceiling on tables past ~2.5 million rows.
  -- db/test-schema.ts [8b]/[8c] hold all three branches to the exact answer on
  -- the same rows.
  IF filter IS NULL OR filter = '{}'::jsonb THEN
    -- Unfiltered. A NULL filter is unfiltered: 007 evaluated
    -- `NULL = '{}' OR metadata @> NULL`, which excluded every row.
    RETURN QUERY
    WITH direct AS (
      SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
      FROM thoughts t
      WHERE t.embedding IS NOT NULL
      ORDER BY t.embedding <=> query_embedding
      LIMIT v_fetch
    ),
    chunked AS (
      SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
      FROM thought_chunks c
      ORDER BY c.embedding <=> query_embedding
      LIMIT v_fetch
    ),
    best AS (
      SELECT u.tid, MAX(u.sim) AS sim
      FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
      GROUP BY u.tid
    )
    SELECT t.id, t.content, t.metadata, b.sim, t.created_at
    FROM best b
    JOIN thoughts t ON t.id = b.tid
    WHERE b.sim > match_threshold
    ORDER BY b.sim DESC
    LIMIT v_count;
  ELSIF (SELECT count(*) FROM (SELECT 1 FROM thoughts t WHERE t.metadata @> filter LIMIT v_exact + 1) s) <= v_exact THEN
    -- Thin filter: the exact answer over the matching rows. `matched` is read
    -- twice, so Postgres materialises it — one GIN lookup. The chunk side
    -- probes thought_chunks_thought_id_idx with the matched ids as an ARRAY:
    -- with the matched set capped at v_exact, index probes are the right plan
    -- by construction, and the array form is the one the planner cannot turn
    -- into a scan of the whole chunk table — written as a join (or a LATERAL,
    -- which it pulls back up into one) its default 1% estimate for `@>` chose a
    -- sequential scan plus hash instead: measured at 100,000 rows, 6–11 ms for
    -- a filter matching 6–998 thoughts, a cost that grows with the table and
    -- not with the match. No ORDER BY over an index and no LIMIT inside the
    -- CTEs: nothing here can walk.
    RETURN QUERY
    WITH matched AS (
      SELECT t.id, t.embedding
      FROM thoughts t
      WHERE t.metadata @> filter
    ),
    direct AS (
      SELECT m.id AS tid, 1 - (m.embedding <=> query_embedding) AS sim
      FROM matched m
      WHERE m.embedding IS NOT NULL
    ),
    chunked AS (
      SELECT k.thought_id AS tid, 1 - (k.embedding <=> query_embedding) AS sim
      FROM thought_chunks k
      WHERE k.thought_id = ANY ((SELECT array_agg(m.id) FROM matched m)::uuid[])
    ),
    best AS (
      SELECT u.tid, MAX(u.sim) AS sim
      FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
      GROUP BY u.tid
    )
    SELECT t.id, t.content, t.metadata, b.sim, t.created_at
    FROM best b
    JOIN thoughts t ON t.id = b.tid
    WHERE b.sim > match_threshold
    ORDER BY b.sim DESC
    LIMIT v_count;
  ELSE
    -- Broad filter: the walk. The predicate sits INSIDE each candidate CTE,
    -- so the scan applies it to every candidate it produces and keeps going
    -- until v_fetch pass — the iterative scan declared above is what lets it
    -- keep going. The chunk side joins its parent row for the metadata; a
    -- join rather than EXISTS because inside an OR (an earlier shape) EXISTS
    -- became a hashed subplan — one full pass over thoughts per call — and a
    -- join is one primary-key lookup per candidate.
    RETURN QUERY
    WITH direct AS (
      SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
      FROM thoughts t
      WHERE t.embedding IS NOT NULL
        AND t.metadata @> filter
      ORDER BY t.embedding <=> query_embedding
      LIMIT v_fetch
    ),
    chunked AS (
      SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
      FROM thought_chunks c
      JOIN thoughts p ON p.id = c.thought_id
      WHERE p.metadata @> filter
      ORDER BY c.embedding <=> query_embedding
      LIMIT v_fetch
    ),
    best AS (
      SELECT u.tid, MAX(u.sim) AS sim
      FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
      GROUP BY u.tid
    )
    SELECT t.id, t.content, t.metadata, b.sim, t.created_at
    FROM best b
    JOIN thoughts t ON t.id = b.tid
    WHERE b.sim > match_threshold
    ORDER BY b.sim DESC
    LIMIT v_count;
  END IF;
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
  v_dblevel  text[];
BEGIN
  -- "Set" means set somewhere EVERY role sees it: server configuration
  -- (postgresql.conf, ALTER SYSTEM, a managed parameter group, the command
  -- line, the environment) or the database itself. Precedence is role >
  -- database > server, so a database-level seed would silently undo an
  -- operator's ALTER SYSTEM (ninth review pass) but cannot touch a role-level
  -- value — and a role-level value reaches only that role, so it is no reason
  -- to leave every other role at pgvector's defaults (tenth review pass: the
  -- ninth's `source <> 'default'` test let an ALTER ROLE on the migrating role
  -- suppress the seed for everyone else). Two signals, because each misses a
  -- case the other catches: pg_settings.source reports where THIS session
  -- resolved the value from when it connected (the SELECT '[1]'::vector at the
  -- top of this file made hnsw.* visible there), and cannot see an ALTER
  -- DATABASE made since — by an operator earlier in this session, or by this
  -- block on a previous run — which pg_db_role_setting can. The source list is
  -- SHARED_SETTING_SOURCES in db/config.mjs, substituted here.
  SELECT s.setconfig INTO v_dblevel
  FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
  WHERE d.datname = v_db AND s.setrole = 0;

  IF NOT EXISTS (SELECT 1 FROM pg_settings WHERE name = 'hnsw.max_scan_tuples' AND source IN ({{SHARED_SETTING_SOURCES}}))
     AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(v_dblevel, '{}')) c WHERE c LIKE 'hnsw.max_scan_tuples=%') THEN
    EXECUTE format('ALTER DATABASE %I SET hnsw.max_scan_tuples = {{HNSW_SEED_MAX_SCAN_TUPLES}}', v_db);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_settings WHERE name = 'hnsw.scan_mem_multiplier' AND source IN ({{SHARED_SETTING_SOURCES}}))
     AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(v_dblevel, '{}')) c WHERE c LIKE 'hnsw.scan_mem_multiplier=%') THEN
    EXECUTE format('ALTER DATABASE %I SET hnsw.scan_mem_multiplier = {{HNSW_SEED_SCAN_MEM_MULTIPLIER}}', v_db);
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Any failure here — insufficient_privilege from a non-owner role, a hosted
  -- platform's policy refusing ALTER DATABASE, an event trigger — leaves the
  -- bounds at pgvector's defaults and the FIX intact. The header calls the
  -- seeding optional, so the block must not abort the transaction that also
  -- carries the function. The migrator reads pg_db_role_setting afterwards and
  -- prints these statements; preflight warns while they are unset.
  RAISE WARNING USING
    MESSAGE = format('match_thoughts: could not seed the database-level HNSW scan bounds (%s: %s).', SQLSTATE, SQLERRM),
    HINT = format('Run as the database owner, in one session: SELECT ''[1]''::vector; ALTER DATABASE %I SET hnsw.max_scan_tuples = {{HNSW_SEED_MAX_SCAN_TUPLES}}; ALTER DATABASE %I SET hnsw.scan_mem_multiplier = {{HNSW_SEED_SCAN_MEM_MULTIPLIER}};  (the SELECT loads pgvector so a non-superuser may set hnsw.* settings)', v_db, v_db);
END $$;

COMMENT ON FUNCTION match_thoughts(vector, float, int, jsonb) IS
  'Semantic search over whole-thought vectors and chunk vectors, deduplicated to one row per thought scored by its best evidence. The metadata filter is applied inside the index scan (iterative HNSW scan, pgvector >= 0.8), so a selective filter does not silently empty the result.';
