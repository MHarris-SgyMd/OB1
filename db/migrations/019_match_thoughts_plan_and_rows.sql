-- ============================================================================
-- 019 — match_thoughts reaches the HNSW index at the shipped width, and both
--        search functions tell the planner how many rows they return
--
-- requires: pgvector >= 0.8.0
--   (match_thoughts is redefined here with 014's SET clause, so this file
--   declares the same floor; db/migrate.ts reads the line)
--
-- Why — the plan (Linear SMD-969; upstream NateBJones-Projects/OB1#469)
--   The upstream issue reports that even the plain `match_thoughts` shape gets
--   `Seq Scan` + `Sort` at ~9,300 rows, and only `SET LOCAL enable_seqscan =
--   off` makes the planner take `thoughts_embedding_idx`: 5.9 s and ~30,000
--   buffers per call against 180 ms and ~3,200. This fork's function has the
--   more indexable shape — the threshold is applied AFTER the `ORDER BY <=>
--   LIMIT` candidate CTEs, not inside their WHERE — and nothing had measured
--   whether that was enough. db/bench-hnsw.ts explains only the filtered
--   branches, and at 64 dimensions; db/test-live.ts [5] asserted the index is
--   REACHABLE with sequential scans disabled, which is a different question
--   from whether it is CHOSEN. The fork's rule is that a plan is measured, not
--   inferred (SMD-925), so it was measured, at the shipped width.
--
--   Measured before this migration — random unit vectors, chunk rows for one
--   thought in five, pgvector 0.8.6 with `hnsw.iterative_scan = relaxed_order`,
--   plans read from EXPLAIN (ANALYZE, BUFFERS) text, the unfiltered branch's
--   own statements (db/bench-plan.ts has the table; db/test-live.ts [5c]
--   holds it):
--
--     rows      count   as 014 plans it (thoughts / chunks)    with enable_seqscan = off
--       1,000     10    seq / seq      3.1 ms    8,026 buf   index / index   1.0 ms    1,872 buf
--       1,000     50    seq / seq      3.8 ms    8,026       index / index   2.8 ms    5,683
--      10,000     10    index / SEQ    6.4 ms   15,295       index / index   2.6 ms    3,279
--      10,000     50    seq / seq     31.5 ms   80,247       index / index   8.8 ms   11,113
--      10,000    500    seq / seq     33.9 ms   80,247       index / index  40.9 ms   54,696
--     100,000     10    index / index  3.2 ms    4,338       (the same plan)
--     100,000     50    index / index 13.8 ms   16,334       (the same plan)
--     100,000    500    seq / seq    318.8 ms  932,017       index / index 196.0 ms   44,664
--     10,000 @ 64 dims  index at every count; the chunk table seq-scans above
--                       200 candidates, correctly — 80 buffers, 0.3 ms
--
--   So the sequential scan is chosen where the HEAP is small: at the shipped
--   width that is every brain up to some tens of thousands of thoughts — the
--   chunk side at the default count (the default path's cost at 10,000 rows
--   was 6.4 ms with the chunk scan and 2.6 ms without it), both sides above
--   it — and the ceiling at every size measured. At 100,000 rows the heap
--   alone is 1,225 pages and the estimate turns for the counts callers send;
--   at the ceiling it does not, and the scan reads 932,017 buffers for 500
--   rows. The band the estimate gets wrong is the band real brains occupy —
--   upstream's report is a 9,300-row table.
--
--   The mechanism, which is why no cost knob fixes it. pg_type.typstorage for
--   `vector` is `e` (extended): a 1024-wide vector is ~4 KB, past the TOAST
--   threshold, and lives out of line. At 10,000 rows the heap is 912 kB and
--   the TOAST relation ~55 MB. The planner prices a sequential scan by heap
--   pages plus per-tuple CPU and NEVER counts the detoast reads — it estimated
--   114 pages and the scan read 66,780 buffers. The estimate is wrong in kind,
--   not by a factor. `random_page_cost = 1.1` (the SSD value, measured as an
--   arm of the bench) moves the boundary and does not remove it: at 10,000
--   rows it wins both sides at count 10 and the `thoughts` side at 50, and
--   still scans the chunk table at 50 and both tables at 500; at 1,000 rows it
--   wins one cell of six; at 100,000 it still scans the chunk table at the
--   ceiling. The chunk table loses first because it is "small" in heap pages
--   while every one of its rows is a TOASTed vector; the wider the model, the
--   longer every table stays small. At 64 dimensions the vectors are inline
--   and the planner is right, which is why the 64-dimensional bench could not
--   have seen this.
--
--   Upstream's own shape is worse still, and stays rejected: with the
--   threshold in the WHERE and the index forced, a query no row passes makes
--   the iterative scan walk to its bound — 49 ms at 10,000 rows for zero rows.
--   The threshold after the LIMIT is what makes the index scan a LIMIT.
--
-- The decision
--   `SET enable_seqscan = off` on the function, beside `hnsw.iterative_scan` —
--   upstream's remedy, taken for a stated reason: no cost constant can express
--   a cost the estimator omits, and the omission grows with width and row
--   count. It is a penalty (a disabled path costs 10^10), not a prohibition: a
--   relation with no usable index still seq-scans. Every statement in this
--   body has an index the schema guarantees — the HNSW indexes for both
--   candidate CTEs, the GIN index for the routing statement, primary-key and
--   thought_id probes for the exact branch, HNSW plus a primary-key join for
--   the walk, a primary-key join for the merge — so what the setting removes is
--   only the mis-priced alternative. On a brain of a hundred rows it costs
--   microseconds; at 100,000 rows, where the planner already chooses the
--   index at the counts callers send, it changes nothing but the ceiling. The
--   setting is scoped to the call, as 014's is.
--
--   Not chosen, and why:
--   * `random_page_cost` in deploy/compose.yaml. Measured insufficient above;
--     also a server setting a hosted Postgres may not expose, where the
--     function-level clause travels with the schema.
--   * Raising the distance function's COST so the seq scan's per-tuple price
--     reflects a detoast. It would work — the index scan pays it only for the
--     rows it returns — but it edits a catalog row pgvector owns, which
--     `ALTER EXTENSION vector UPDATE` may rewrite.
--   * `set_config('enable_seqscan', 'off', true)` inside the body. Transaction-
--     scoped, not call-scoped: it would leak into the caller's transaction and
--     into search_thoughts_hybrid's other arm, and it is a second mechanism
--     beside the SET clause the function already has.
--   * Changing the shape. There is no SQL that makes the planner see TOAST.
--
-- Why — the row estimate (Linear SMD-1041)
--   PostgreSQL cannot see into a plpgsql function and assumes a set-returning
--   one yields 1,000 rows unless it declares `ROWS n`. match_thoughts returns
--   match_count rows (10 by default, at most {{MATCH_COUNT_CEILING}});
--   search_thoughts_keyword returns p_limit (25 by default, at most 100). Any
--   SQL composing them was planned against an estimate one to two orders of
--   magnitude high. 017's header records the measured consequence: the fused
--   query's estimated cost crossed jit_above_cost, PostgreSQL JIT-compiled 112
--   expressions on every call, and search_thoughts_hybrid cost 15 ms where its
--   arms cost 1.3. 017 fixed that locally — no join to `thoughts`, `SET jit =
--   off` — and the estimate stayed wrong for every other caller: a hand-written
--   query over PostgREST, a dashboard, the next migration that composes them.
--
--   `ROWS 10` and `ROWS 25`, in the functions' own CREATE statements. Not an
--   `ALTER FUNCTION … ROWS` from 017, which the SMD-958 review passes declined
--   for a reason worth keeping: CREATE OR REPLACE resets prorows, so a hint set
--   anywhere but in the defining statement is undone by the next re-apply of
--   that statement — and db/test-schema.ts re-applies 014 on purpose. 017's
--   `SET jit = off` stays: the estimate it defended against is right now, but
--   its own argument (nothing there has enough rows for JIT to pay) still holds.
--
-- What a successor must carry
--   Both bodies below are 014's and 012's VERBATIM — a migration is a snapshot,
--   as 014 carried 007's body and 018 carried 013's — and only the clauses
--   between the signature and `AS $$` are new. A later migration that
--   redefines match_thoughts (SMD-945, the recency blend, is next) must keep:
--     * the `-- requires: pgvector >= 0.8.0` header line;
--     * `SET hnsw.iterative_scan = relaxed_order` (014: the filter inside the
--       scan is correct only under the iterative scan);
--     * `SET enable_seqscan = off` (this file: db/test-live.ts [5c] explains
--       the unfiltered branch under the function's own settings and fails
--       without it at 2,000 rows);
--     * `ROWS 10` (db/test-schema.ts [20] reads pg_proc.prorows);
--     * the `-- ob1:filter-inside-scan` sentinel in the BODY (preflight);
--     * no other SET: the walk bounds are database-level (014), and a plan mode
--       is what the benches exist to show both sides of.
--   014's DO block — the database-level seeds — is NOT repeated here. It seeds
--   once, 014 stays applied, and repeating it would be a second copy of the
--   values.
--
-- Prerequisites
--   Migrations 012 and 014. pgvector 0.8.0 or later, as 014. Applied by
--   `bun db/migrate.ts`.
--
-- Expected outcome
--   `pg_proc.proconfig` for match_thoughts records both settings; `prorows` is
--   10 for match_thoughts and 25 for search_thoughts_keyword; the unfiltered
--   branch explains as `Index Scan using thoughts_embedding_idx` and `Index
--   Scan using thought_chunks_embedding_idx` at every count and scale measured
--   (db/bench-plan.ts, 1,000 to 100,000 rows); results, signatures, return
--   shapes and the strict
--   `> match_threshold` are unchanged, and store-sql.ts / store-postgrest.ts
--   call both functions exactly as before.
-- ============================================================================

-- Load pgvector's library into THIS session before the CREATE below — 014
-- explains why: the SET clause names an hnsw.* setting, which a non-superuser
-- may set only once the library that owns the prefix is loaded. One cast.
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
-- STABLE, as 012's search_thoughts_keyword is: the body only reads, so the
-- planner may treat it as such and PostgREST runs its POST RPC — the form every
-- caller in the repo uses — in a READ ONLY transaction.
STABLE
-- The planner's row estimate for a call (SMD-1041). It cannot see into plpgsql
-- and assumes 1,000 rows from any set-returning function without this clause;
-- the function returns match_count rows, 10 by default. It lives HERE and not
-- in an ALTER FUNCTION because CREATE OR REPLACE resets it — see the header.
ROWS 10
-- Scoped to this call and restored on exit. Requires pgvector >= 0.8.0, and the
-- CREATE fails on anything older rather than producing a function that quietly
-- stops at the first ef_search candidates. The walk's two BOUNDS are
-- deliberately not here: a function-level SET would override the database-level
-- values 014 seeded, which are the operator's tuning knob.
SET hnsw.iterative_scan = relaxed_order
-- The plan (SMD-969). At the shipped width a vector is TOASTed, and the
-- planner's seq-scan estimate counts heap pages and never the detoast reads —
-- so wherever the heap is small (every brain up to some tens of thousands of
-- thoughts, and the ceiling at every size) it chose a sequential scan of the
-- chunk table and, above the default count, of `thoughts`, reading five to
-- twenty times the buffers the index reads. A penalty, not a prohibition: a
-- relation with no usable index still seq-scans, and every statement in this
-- body has one — see the header for the measurement and for what was not chosen.
SET enable_seqscan = off
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
  -- The matching thoughts' ids, at most v_exact + 1 of them — collected once,
  -- through the GIN index, and used both to ROUTE (more than v_exact means the
  -- walk) and to DRIVE the exact branch by primary key. One pass over the
  -- filter: an earlier draft counted first and re-evaluated `metadata @>
  -- filter` to build the matched set, two GIN scans and two rounds of heap
  -- fetches per call, under two snapshots (eleventh review pass).
  v_ids        uuid[];
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
  -- The filtered case then splits on how many thoughts match. Their ids are
  -- collected through the GIN index, at most v_exact + 1 of them: GIN builds
  -- its whole bitmap for the filter before the first row comes back, so what
  -- the LIMIT caps is the heap fetches (and the recheck each one carries), not
  -- the bitmap — db/bench-hnsw.ts section C explains this statement on the
  -- broadest and the empty filter for that reason. At most v_exact matching:
  -- score those rows and their chunks directly by id — exact, no index walk,
  -- and a filter matching NOTHING (the shape one integration sends on every
  -- call) costs that one GIN probe and returns empty, where the walk-only
  -- draft ran to the scan bound and returned the same empty answer at 60+ ms
  -- (tenth review pass). More than v_exact matching: the HNSW walk with the
  -- predicate inside the scan, which has at least v_exact rows to find its
  -- v_fetch among, so it visits about v_fetch * N / v_exact tuples — N / 25
  -- at the default count — and the database-level bounds are its ceiling on
  -- tables past ~2.5 million rows. db/test-schema.ts [8b]/[8c] hold all three
  -- branches to the exact answer on the same rows.
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
  ELSE
    -- Only rows a branch can SCORE count towards the threshold: a thought
    -- captured through the 2-arg fallback has no vector and, until re-embedded,
    -- no chunks, so it can never be a candidate on either side. Counting those
    -- (the eleventh draft did) could route a filter with 1,200 matches of which
    -- 30 are scoreable to the walk, which then needs 40 passing rows that do not
    -- exist, runs to the scan bound and returns short — where the exact branch
    -- scores all 30 (twelfth review pass; db/test-schema.ts [8d] pins it).
    SELECT array_agg(s.id) INTO v_ids
    FROM (
      SELECT t.id FROM thoughts t
      WHERE t.metadata @> filter
        AND (t.embedding IS NOT NULL OR EXISTS (SELECT 1 FROM thought_chunks k WHERE k.thought_id = t.id))
      LIMIT v_exact + 1
    ) s;

    IF COALESCE(cardinality(v_ids), 0) <= v_exact THEN
      -- Thin filter: the exact answer over the matching rows, driven by the ids
      -- already collected — primary-key probes for the thoughts, and
      -- thought_chunks_thought_id_idx probes for their chunks, both with the
      -- array. With the set capped at v_exact, index probes are the right plan
      -- by construction, and the array form is the one the planner cannot turn
      -- into a scan of the whole table: written as a join (or a LATERAL, which
      -- it pulls back up into one) its default 1% estimate for `@>` chose a
      -- sequential scan of the chunk table plus a hash instead — measured at
      -- 100,000 rows, 6–11 ms for a filter matching 6–998 thoughts, a cost that
      -- grew with the table and not with the match. No ORDER BY over an index
      -- and no LIMIT inside the CTEs: nothing here can walk.
      RETURN QUERY
      WITH direct AS (
        SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
        FROM thoughts t
        WHERE t.id = ANY (v_ids)
          AND t.embedding IS NOT NULL
      ),
      chunked AS (
        SELECT k.thought_id AS tid, 1 - (k.embedding <=> query_embedding) AS sim
        FROM thought_chunks k
        WHERE k.thought_id = ANY (v_ids)
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
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION search_thoughts_keyword(
  p_query   text,
  p_limit   int   DEFAULT 25,
  p_offset  int   DEFAULT 0,
  p_filter  jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id           uuid,
  content      text,
  metadata     jsonb,
  created_at   timestamptz,
  occurrences  int,
  total_count  bigint
)
LANGUAGE plpgsql
STABLE
-- The planner's row estimate for a call (SMD-1041): the default page, since
-- p_limit is 25 unless a caller says otherwise and the clamp is 100. See 019's
-- header; the body below is 012's, verbatim.
ROWS 25
AS $$
DECLARE
  -- NOT trimmed. See the whitespace note in the header: trimming turns the
  -- exact needle 'SMD-944 ' into 'SMD-944', which also matches SMD-9440, and a
  -- tool whose contract is exactness cannot silently widen the string it was
  -- given. `trim()` appears once below, only to decide whether the query is
  -- empty.
  v_needle  text := coalesce(p_query, '');
  v_lower   text;
  v_pattern text;
  -- Clamped rather than trusted. `total_count` tells the caller what it did not
  -- get, so a capped page is visible rather than silent.
  v_limit   int  := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  int  := greatest(coalesce(p_offset, 0), 0);
BEGIN
  -- No needle, no rows. Returning the whole table for an empty query would make
  -- a bug in a caller look like a very slow success. An all-whitespace query is
  -- refused for the same reason — it is a caller bug, not a request for every
  -- thought containing two spaces — but note the asymmetry this creates and is
  -- meant to create: '  ' is refused, while ' a ' searches for a space, an "a"
  -- and a space, exactly as written.
  IF trim(v_needle) = '' THEN
    RETURN;
  END IF;

  v_lower := lower(v_needle);

  -- Escape order matters: backslash first, or the escapes introduced for % and _
  -- would themselves be escaped. See the measured false matches above.
  v_pattern := '%' || replace(replace(replace(v_needle, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  WITH hits AS (
    SELECT
      t.id         AS hit_id,
      t.content    AS hit_content,
      t.metadata   AS hit_metadata,
      t.created_at AS hit_created_at,
      -- Occurrence count by subtraction: how much shorter the text gets when
      -- every copy of the needle is removed, divided by the needle's length.
      -- Both sides are computed on the lowered text, because lower() is not
      -- length-preserving for every Unicode input and mixing the two would give
      -- a fractional, occasionally negative, count.
      ((length(lower(t.content)) - length(replace(lower(t.content), v_lower, '')))
        / length(v_lower))::int AS hit_occurrences
    FROM thoughts t
    WHERE t.content ILIKE v_pattern
      -- Same containment semantics as match_thoughts, including treating an
      -- empty object as "no filter" rather than as a predicate matching
      -- everything, so the planner sees no filter at all.
      AND (p_filter IS NULL OR p_filter = '{}'::jsonb OR t.metadata @> p_filter)
  )
  SELECT
    h.hit_id,
    h.hit_content,
    h.hit_metadata,
    h.hit_created_at,
    h.hit_occurrences,
    -- Computed over the whole match set, before OFFSET and LIMIT apply.
    count(*) OVER () AS hit_total
  FROM hits h
  ORDER BY h.hit_occurrences DESC, h.hit_created_at DESC, h.hit_id
  OFFSET v_offset
  LIMIT v_limit;
END;
$$;
