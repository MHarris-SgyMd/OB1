-- ============================================================================
-- 074 — min_trust: match_thoughts and search_thoughts_keyword answer "at or
--        above this trust" through an index, inside 014's route — the
--        content's trust 073 stamps, read (SMD-1724)
--
-- requires: pgvector >= 0.8.0
--   (match_thoughts is redefined here with 041's SET clauses, so this file
--   declares the same floor; db/migrate.ts reads the line)
--
-- WHY
--   073 put the content's trust on every thought (metadata.trust, operator >
--   agent > ingested). A reader that wants only what the operator wrote, or
--   nothing an integration copied in, has no way to ask: 014's filter is
--   containment, and "operator or agent" is not one containment. SMD-1724's
--   Verify asks for the filter on 014's route — indexed, not a post-filter
--   over the top of a ranked list, which returns short whenever the top is
--   mostly what was excluded. The maintainer chose a parameter over a ladder
--   key folded into the filter (SMD-1724's plan, 2026-10-01).
--
-- WHAT
--   * ob1_trust_rank(text) — the ladder as a number: operator 3, agent 2,
--     ingested 1, anything else (absent, a word off the ladder) 0. IMMUTABLE,
--     so an index can be built over it.
--   * ob1_min_trust_rank(text) — a caller's min_trust as the rank to reach:
--     NULL is 0 (no constraint), a ladder word its rank, anything else
--     refused by name (invalid_parameter_value) rather than read as nothing.
--   * thoughts_trust_rank_idx — a btree over ob1_trust_rank(metadata->>'trust').
--     A min_trust with no filter collects its rows by a range of it; with a
--     filter, beside 001's GIN index.
--   * match_thoughts gains a seventh argument, min_trust text DEFAULT NULL.
--     The 6-argument form is dropped first and its privileges replayed onto
--     the new one — 020's mechanism, one form later — or every 6-argument
--     call would be "function is not unique". NULL is today's function: the
--     unfiltered path and every filtered statement 041 shipped run as they
--     were, byte for byte, so 014's route, 037/038's gate and 039's walk are
--     unmoved, and so is every reader of those statements (the benches'
--     extractor finds them first; db/test-schema.ts [20] holds them to 014's
--     and 041's text, min_trust's beside them). A min_trust takes the filtered path whatever
--     the filter (an empty filter with a min_trust is filtered), and its
--     statements stand BESIDE 041's in the same branches: the gate's sample
--     counts rows passing both, the collection reads the rank index (and the
--     GIN index when a filter is given too), the exact answer is 041's over
--     the ids collected, and the walk carries both predicates inside the
--     scan — ob1:min-trust-inside-scan.
--   * search_thoughts_keyword gains a fifth, p_min_trust text DEFAULT NULL,
--     the same way: 019's body with the rank beside the containment.
--   * A row with no trust (an unclassified key, 073) is below every
--     min_trust: min_trust 'ingested' means "labelled", not "everything".
--
-- NOT HERE
--   * search_thoughts_hybrid and search_thoughts_current — SMD-1724's PR 2b,
--     on these two; they call the forms here positionally and are unmoved.
--   * The servers' argument and the tools' label — PR 3. The stores send the
--     six (four) arguments they sent; the seventh (fifth) defaults.
--
-- Idempotent: CREATE OR REPLACE and IF NOT EXISTS throughout; a re-run finds
-- the new forms and replays nothing.
-- ============================================================================

-- Load pgvector's library into THIS session before the CREATE below: the SET
-- clause names an hnsw.* setting, which a non-superuser owner is refused for
-- until the library is loaded (014's header has the reproduction).
SELECT '[1]'::vector;

-- ---------------------------------------------------------------------------
-- 1. The ladder as a number, and a caller's min_trust read against it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ob1_trust_rank(p_trust text)
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE p_trust WHEN 'operator' THEN 3 WHEN 'agent' THEN 2 WHEN 'ingested' THEN 1 ELSE 0 END;
$$;

COMMENT ON FUNCTION ob1_trust_rank(text) IS
  'The trust ladder as a number — operator 3, agent 2, ingested 1, anything else (NULL, a word off the ladder) 0 — over metadata.trust (073). IMMUTABLE: thoughts_trust_rank_idx is built over it, and match_thoughts and search_thoughts_keyword compare it with ob1_min_trust_rank(min_trust). Migration 074 / SMD-1724.';

CREATE OR REPLACE FUNCTION ob1_min_trust_rank(p_min_trust text)
RETURNS int
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_min_trust IS NULL THEN
    RETURN 0;
  END IF;
  IF ob1_trust_rank(p_min_trust) = 0 THEN
    RAISE EXCEPTION 'min_trust must be operator, agent or ingested (or NULL for none), got %', p_min_trust
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN ob1_trust_rank(p_min_trust);
END;
$$;

COMMENT ON FUNCTION ob1_min_trust_rank(text) IS
  'A caller''s min_trust as the rank a row must reach: NULL is 0 (no constraint); operator, agent, ingested their ob1_trust_rank; anything else refused (invalid_parameter_value), never read as no constraint. A row with no trust ranks 0 and so is below every min_trust. Migration 074 / SMD-1724.';

-- ---------------------------------------------------------------------------
-- 2. The index min_trust collects by.
-- ---------------------------------------------------------------------------
-- A whole-table btree: a row of rank 0 is one entry, and a partial index
-- (rank > 0) would need every query's predicate to imply it, which a
-- parameter compared with >= does not prove to the planner. Built inside the
-- migrator's transaction, so writes to thoughts wait for it (SHARE): one read
-- of every row's metadata, seconds on a brain of a few hundred thousand
-- thoughts. A brain far past that can build it by hand first, CONCURRENTLY
-- under this name, and this statement then finds it — a VALID one: an
-- interrupted CONCURRENTLY build leaves an INVALID index under the name, which
-- IF NOT EXISTS accepts and the planner ignores (drop it and build again).
CREATE INDEX IF NOT EXISTS thoughts_trust_rank_idx ON thoughts (ob1_trust_rank(metadata->>'trust'));

-- ---------------------------------------------------------------------------
-- 3. match_thoughts(…, min_trust) — 041's body; the min_trust statements
--    beside its own.
-- ---------------------------------------------------------------------------
-- The privileges of the form this file replaces, read before the DROPs below
-- so the CREATE can be given the same ones — 020's capture, one form later:
-- the 6-argument form's (041's), else the 4-argument one's (a hand-re-applied
-- 014 or 019 alone). Empty when the 7-argument form already exists (a re-run:
-- CREATE OR REPLACE keeps its ACL and the replay does nothing).
SELECT set_config('ob1.acl_match_thoughts',
                  CASE WHEN to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float, text)') IS NOT NULL THEN ''
                       WHEN to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float)') IS NOT NULL THEN
                         COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float)')), '')
                       ELSE COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('match_thoughts(vector, float, int, jsonb)')), '') END,
                  false);

-- The older forms go first, as in 020: beside the 7-argument one each makes
-- every call of its own length ambiguous; IF EXISTS keeps this file
-- re-runnable.
DROP FUNCTION IF EXISTS match_thoughts(vector, float, int, jsonb);
DROP FUNCTION IF EXISTS match_thoughts(vector, float, int, jsonb, float, float);

CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding  vector({{EMBEDDING_DIM}}),
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb,
  -- The blend (020). 0 is today's ranking, by similarity alone; 1 ranks the
  -- candidates by age alone. Defaulted, so every caller before 020 is
  -- unchanged — and the 4-argument function is DROPPED above, because beside
  -- this one it would make their calls ambiguous (see the header).
  recency_weight   float   DEFAULT 0.0,
  half_life_days   float   DEFAULT 90.0,
  -- 074: at or above this trust (operator > agent > ingested), through
  -- thoughts_trust_rank_idx; NULL is no constraint, and a row with no trust
  -- is below every word. Defaulted, so every call before 074 is unchanged —
  -- and the 6-argument form is DROPPED above, as 020 dropped the 4.
  min_trust        text    DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  content     text,
  metadata    jsonb,
  similarity  float,       -- the raw cosine, what the threshold gates — unchanged by the blend
  created_at  timestamptz,
  score       float        -- what the rows are ordered by: similarity when the weight is 0
)
LANGUAGE plpgsql
-- STABLE, as 012's search_thoughts_keyword is: the body only reads, so the
-- planner may treat it as such and PostgREST runs its POST RPC — the form every
-- caller in the repo uses — in a READ ONLY transaction.
STABLE
-- The planner's row estimate for a call (SMD-1041). It cannot see into plpgsql
-- and assumes 1,000 rows from any set-returning function without this clause;
-- the function returns match_count rows, 10 by default. It lives HERE and not
-- in an ALTER FUNCTION because CREATE OR REPLACE resets it — see 019's header.
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
-- body has one — see 019's header for the measurement and for what was not chosen.
SET enable_seqscan = off
-- JIT off for the call (040, SMD-1624; 017's clause, for 017's reason).
-- Nothing in this body has enough rows for JIT to pay for itself — the walk
-- passes a few hundred tuples, the exact branch scores at most v_exact rows,
-- the sample reads eight pages — and what prices its statements past
-- jit_above_cost is never the work: a planner path an operator disabled adds
-- disable_cost (1e10) on PostgreSQL 14–17 and the sample was compiled on
-- every call, ~50 ms; a generic plan's flat estimate at ten million rows
-- compiled the route, exact and walk statements for 30–110 ms (FORK.md
-- change 28). 040's header has the table, and why the clause is not a plan
-- mode; the two paths pinned below are this file's, and its header says why
-- a compile and a plan are different questions.
SET jit = off
-- The two planner paths this body is built around, pinned for the call (this
-- file, SMD-1677 and SMD-1703). Every join here is a primary-key probe driven
-- by an outer the statement itself bounds — 2 x v_fetch candidates, at most
-- v_exact ids, the sample's eight blocks — so a nested loop is the plan by
-- construction, and the misestimated outer that `enable_nestloop = off`
-- exists to tame cannot occur inside this call; under that setting the
-- planner had replaced every join with a merge or hash join over the WHOLE
-- table, 1.3–2.2 s a call at a million rows, the unfiltered call included,
-- and the walk's rows changed. The sample's probe has exactly one path, a
-- TID Range Scan; on PostgreSQL 18 `enable_tidscan = off` removes it and
-- each probe scanned the whole heap. 019's argument for enable_seqscan = off
-- applied to two more paths — the header has the tables, why not a statement
-- shape, and what is deliberately NOT pinned (hashagg, sort, the rest).
SET enable_nestloop = on
SET enable_tidscan = on
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
  -- The blend's two inputs (020). The weight is clamped to [0, 1] as
  -- match_count is clamped, with a NOTICE below; NULL is 0, the ranking every
  -- caller before 020 got. The half-life is checked below: a non-positive one
  -- has no meaning and is refused rather than replaced.
  v_weight     float   := LEAST(GREATEST(COALESCE(recency_weight, 0.0), 0.0), 1.0);
  v_half       float   := COALESCE(half_life_days, 90.0);
  -- The candidate window. Under a weight it widens fourfold: the blend can
  -- only reorder the candidates the scan produced, and a recent row just
  -- outside the nearest 4 * count can be the right answer once age counts.
  -- The header prices the factor and says how it was measured. v_base is the
  -- unweighted window, which v_exact below is sized from: the exact/walk
  -- boundary does not move with the weight (second review pass).
  v_base       int     := GREATEST(v_count * 4, 20);
  v_fetch      int     := v_base * CASE WHEN v_weight > 0 THEN 4 ELSE 1 END;
  -- Filters matching at most this many thoughts are answered EXACTLY, from the
  -- matching rows and their chunks, with no index walk at all (see the
  -- filtered branches below). v_fetch * 4 for the counts where the walk would
  -- have to find nearly every matching row anyway; 1,000 as a floor because a
  -- thousand parents and their chunks are a few thousand distance
  -- computations — milliseconds at any width — and no walk is cheaper.
  v_exact      int     := GREATEST(v_base * 4, 1000);
  -- The matching thoughts' ids, at most v_exact + 1 of them — collected once,
  -- through the GIN index, and used both to ROUTE (more than v_exact means the
  -- walk) and to DRIVE the exact branch by primary key. One pass over the
  -- filter: an earlier draft counted first and re-evaluated `metadata @>
  -- filter` to build the matched set, two GIN scans and two rounds of heap
  -- fetches per call, under two snapshots (eleventh review pass).
  v_ids        uuid[];
  -- The gate on that collection (037; the sample's statement is 038's). The
  -- heap's size in pages, exact and cheap (pg_relation_size is a stat of the
  -- main fork; to_regclass resolves the name on every call, so a cached plan
  -- never holds a dropped table's OID — the header says what a temp table
  -- shadowing the name does): the range the sample draws its block numbers
  -- from. Computed at entry — a few microseconds, on the unfiltered path too
  -- — so the estimate statement below stands alone with its locals
  -- substituted, which is how db/bench-hnsw.ts section C reads it out of the
  -- catalog.
  v_pages      bigint  := GREATEST(pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int, 1);
  v_hits       int;
  v_hit_pages  int;
  v_pages_seen int;
  -- True when the sample says the filter is far too broad for the exact
  -- branch: then the collection is skipped and the walk runs at once.
  v_broad      boolean := false;
  -- 074: the rank a row must reach (0: no constraint — the statements 041
  -- shipped run, byte for byte), and the filter the min_trust statements
  -- test, an empty object when none was given.
  v_min        int     := ob1_min_trust_rank(min_trust);
  v_filter     jsonb   := COALESCE(filter, '{}'::jsonb);
BEGIN
  IF match_count > {{MATCH_COUNT_CEILING}} THEN
    RAISE NOTICE 'match_thoughts: match_count % clamped to {{MATCH_COUNT_CEILING}}', match_count;
  END IF;
  IF recency_weight < 0.0 OR recency_weight > 1.0 THEN
    RAISE NOTICE 'match_thoughts: recency_weight % clamped to %', recency_weight, v_weight;
  END IF;
  IF v_half <= 0.0 THEN
    RAISE EXCEPTION 'match_thoughts: half_life_days must be positive, got %', half_life_days
      USING ERRCODE = 'invalid_parameter_value';
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
  -- broadest and the empty filter for that reason. Since 037 that collection
  -- is gated: on a heap of {{ROUTE_ESTIMATE_MIN_PAGES}} pages or more, a
  -- sample of {{ROUTE_SAMPLE_PAGES}} pages is read first (since 038 by TID
  -- range, {{ROUTE_SAMPLE_PAGES}} page reads whatever the heap holds), and
  -- when it shows the filter matching far more than v_exact thoughts the
  -- collection is not run at all — the walk is the answer for such a filter,
  -- and the bitmap it would have built costs the number of matching rows
  -- (037's header has the rule and this file's the statement). At most v_exact matching:
  -- score those rows and their chunks directly by id — exact, no index walk,
  -- and a filter matching NOTHING (the shape one integration sends on every
  -- call) costs that one GIN probe and returns empty, where the walk-only
  -- draft ran to the scan bound and returned the same empty answer at 60+ ms
  -- (tenth review pass). More than v_exact matching: the HNSW walk with the
  -- predicate inside the scan, which has at least v_exact rows to find its
  -- v_fetch among, so it visits about v_fetch * N / v_exact tuples — N / 25
  -- at the default count — and the database-level bounds are its ceiling on
  -- tables past ~2.5 million rows. db/test-schema.ts [8b]/[8c] hold all three
  -- branches to the exact answer on the same rows; [8e] and db/test-live.ts
  -- [5d] hold the gate.
  -- ob1:min-trust-inside-scan — a CONTRACT SENTINEL, not prose (the 014
  -- convention); db/test-schema.ts [67] reads it. 074: a min_trust
  -- makes the call filtered whatever the filter, and each filtered statement
  -- below has its min_trust twin beside it — the gate's sample, the
  -- collection (by thoughts_trust_rank_idx, beside the GIN index when a
  -- filter is given too), the walk with the rank inside both candidate CTEs.
  -- The exact answer is 041's over whichever collection ran. With no
  -- min_trust nothing below differs from 041's.
  IF (filter IS NULL OR filter = '{}'::jsonb) AND v_min = 0 THEN
    -- Unfiltered. A NULL filter is unfiltered: 007 evaluated
    -- `NULL = '{}' OR metadata @> NULL`, which excluded every row.
    -- 039: the walk orders by the half-precision cast, on BOTH sides of the
    -- operator — token for token the expression thoughts_embedding_idx and
    -- thought_chunks_embedding_idx are built over since this file, or the
    -- planner has no index path and the scan below is a sequential one under
    -- enable_seqscan = off (a penalty, not a prohibition) — and scores the
    -- candidates on the full vector, so the similarity, the threshold and the
    -- merge with the chunk side mean what they meant. The broad-filter walk
    -- below does the same; the exact branch reads no index and casts nothing.
    RETURN QUERY
    WITH direct AS (
      SELECT t.id AS tid, 1 - (t.embedding <=> query_embedding) AS sim
      FROM thoughts t
      WHERE t.embedding IS NOT NULL
      ORDER BY t.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
      LIMIT v_fetch
    ),
    chunked AS (
      SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
      FROM thought_chunks c
      ORDER BY c.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
      LIMIT v_fetch
    ),
    best AS (
      SELECT u.tid, MAX(u.sim) AS sim
      FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
      GROUP BY u.tid
    )
    SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
           -- The blend (020), over the candidates above: recency_score() is the
           -- one copy of the formula, inlined by the planner. Ordered by position
           -- (a bare `score` here would be the OUT parameter), then by id so the
           -- order is total when rows share a created_at.
           recency_score(b.sim, t.created_at, v_weight, v_half)
    FROM best b
    JOIN thoughts t ON t.id = b.tid
    WHERE b.sim > match_threshold
    ORDER BY 6 DESC, t.id
    LIMIT v_count;
  ELSE
    -- The gate (037), sampling by TID range (038). On a heap large enough for
    -- the collection below to cost more than a sample of it, draw
    -- {{ROUTE_SAMPLE_PAGES}} block numbers and read each block as one TID
    -- range — `ctid >= '(b,0)' AND ctid < '(b+1,0)'`, a TID Range Scan, one
    -- page read per block whatever the heap holds — and count the rows that
    -- pass the filter and carry a vector, the pages those rows sit on, and
    -- the pages drawn. A row with a vector, not the collection's "vector or
    -- chunks": an EXISTS probe here became a hashed subplan over the whole
    -- chunk table, and counting fewer scoreable rows than there are only
    -- biases the gate towards running the collection, the safe side. The
    -- draw is DISTINCT (a block drawn twice is read and counted once), the
    -- join is LEFT (a page with no live row counts among the pages drawn),
    -- and the probe's LIMIT never cuts a page — it keeps the probe a
    -- subquery, which is what gives it a TID Range path, and caps the
    -- planner's estimate under jit_above_cost. The header has the
    -- measurements behind each, the planner paths the statement depends on
    -- (SMD-1624), and why sampling by page needs the third condition below.
    IF v_pages >= {{ROUTE_ESTIMATE_MIN_PAGES}} AND v_min = 0 THEN
      SELECT count(*) FILTER (WHERE p.hit), count(DISTINCT b.blk) FILTER (WHERE p.hit), count(DISTINCT b.blk)
        INTO v_hits, v_hit_pages, v_pages_seen
      FROM (
        SELECT DISTINCT floor(random() * v_pages)::bigint AS blk
        FROM generate_series(1, {{ROUTE_SAMPLE_PAGES}})
      ) b
      LEFT JOIN LATERAL (
        SELECT (t.metadata @> filter AND t.embedding IS NOT NULL) AS hit
        FROM thoughts t
        WHERE t.ctid >= ('(' || b.blk || ',0)')::tid
          AND t.ctid <  ('(' || b.blk + 1 || ',0)')::tid
        LIMIT 291
      ) p ON true;
      -- Skip the collection only when all three hold: the sample, scaled to
      -- the table (hits x pages / pages drawn), puts the filter at ten times
      -- the exact threshold or more; at least eight sampled rows passed, so
      -- one or two lucky rows on a huge table cannot decide; and they sit on
      -- at least three different pages, so one page of clustered matches
      -- cannot either. Anything less runs the collection, as before 037: a
      -- filter the gate lets through costs what it always cost, a filter it
      -- wrongly skipped would go to the walk, which is correct but slower
      -- for a thin filter and, at a million rows, can return short — so the
      -- rule is built to make the second mistake rare (037's header has the
      -- arithmetic and the one layout it is weakest against; this file's
      -- has the rates re-measured for the TID-range draw).
      v_broad := v_hits >= 8
                 AND v_hit_pages >= 3
                 AND v_hits * v_pages >= 10 * v_exact * v_pages_seen;
    END IF;
    -- 074: a min_trust's gate — the same sample and the same rule, a row
    -- counted when it passes the filter (an empty one when none was given)
    -- and the rank both.
    IF v_pages >= {{ROUTE_ESTIMATE_MIN_PAGES}} AND v_min > 0 THEN
      SELECT count(*) FILTER (WHERE p.hit), count(DISTINCT b.blk) FILTER (WHERE p.hit), count(DISTINCT b.blk)
        INTO v_hits, v_hit_pages, v_pages_seen
      FROM (
        SELECT DISTINCT floor(random() * v_pages)::bigint AS blk
        FROM generate_series(1, {{ROUTE_SAMPLE_PAGES}})
      ) b
      LEFT JOIN LATERAL (
        SELECT (t.metadata @> v_filter AND ob1_trust_rank(t.metadata->>'trust') >= v_min AND t.embedding IS NOT NULL) AS hit
        FROM thoughts t
        WHERE t.ctid >= ('(' || b.blk || ',0)')::tid
          AND t.ctid <  ('(' || b.blk + 1 || ',0)')::tid
        LIMIT 291
      ) p ON true;
      v_broad := v_hits >= 8
                 AND v_hit_pages >= 3
                 AND v_hits * v_pages >= 10 * v_exact * v_pages_seen;
    END IF;

    -- Only rows a branch can SCORE count towards the threshold: a thought
    -- captured through the 2-arg fallback has no vector and, until re-embedded,
    -- no chunks, so it can never be a candidate on either side. Counting those
    -- (the eleventh draft did) could route a filter with 1,200 matches of which
    -- 30 are scoreable to the walk, which then needs 40 passing rows that do not
    -- exist, runs to the scan bound and returns short — where the exact branch
    -- scores all 30 (twelfth review pass; db/test-schema.ts [8d] pins it).
    -- 014's statement, verbatim (db/test-schema.ts [20] compares it), run
    -- only when the gate above did not already decide.
    IF NOT v_broad AND v_min = 0 THEN
      SELECT array_agg(s.id) INTO v_ids
      FROM (
        SELECT t.id FROM thoughts t
        WHERE t.metadata @> filter
          AND (t.embedding IS NOT NULL OR EXISTS (SELECT 1 FROM thought_chunks k WHERE k.thought_id = t.id))
        LIMIT v_exact + 1
      ) s;
    END IF;
    -- 074: a min_trust's collection, the same scoreable rule and the same
    -- cap — by a range of thoughts_trust_rank_idx when no filter was given
    -- (an empty containment would read the whole GIN index), and with the
    -- containment beside it when one was.
    IF NOT v_broad AND v_min > 0 AND v_filter = '{}'::jsonb THEN
      SELECT array_agg(s.id) INTO v_ids
      FROM (
        SELECT t.id FROM thoughts t
        WHERE ob1_trust_rank(t.metadata->>'trust') >= v_min
          AND (t.embedding IS NOT NULL OR EXISTS (SELECT 1 FROM thought_chunks k WHERE k.thought_id = t.id))
        LIMIT v_exact + 1
      ) s;
    ELSIF NOT v_broad AND v_min > 0 THEN
      SELECT array_agg(s.id) INTO v_ids
      FROM (
        SELECT t.id FROM thoughts t
        WHERE t.metadata @> v_filter
          AND ob1_trust_rank(t.metadata->>'trust') >= v_min
          AND (t.embedding IS NOT NULL OR EXISTS (SELECT 1 FROM thought_chunks k WHERE k.thought_id = t.id))
        LIMIT v_exact + 1
      ) s;
    END IF;

    IF NOT v_broad AND COALESCE(cardinality(v_ids), 0) <= v_exact THEN
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
      SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
             -- The blend (020), over the candidates above: recency_score() is the
             -- one copy of the formula, inlined by the planner. Ordered by position
             -- (a bare `score` here would be the OUT parameter), then by id so the
             -- order is total when rows share a created_at.
             recency_score(b.sim, t.created_at, v_weight, v_half)
      FROM best b
      JOIN thoughts t ON t.id = b.tid
      WHERE b.sim > match_threshold
      ORDER BY 6 DESC, t.id
      LIMIT v_count;
    ELSIF v_min = 0 THEN
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
        ORDER BY t.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
        LIMIT v_fetch
      ),
      chunked AS (
        SELECT c.thought_id AS tid, 1 - (c.embedding <=> query_embedding) AS sim
        FROM thought_chunks c
        JOIN thoughts p ON p.id = c.thought_id
        WHERE p.metadata @> filter
        ORDER BY c.embedding::halfvec({{EMBEDDING_DIM}}) <=> query_embedding::halfvec({{EMBEDDING_DIM}})
        LIMIT v_fetch
      ),
      best AS (
        SELECT u.tid, MAX(u.sim) AS sim
        FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
        GROUP BY u.tid
      )
      SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
             -- The blend (020), over the candidates above: recency_score() is the
             -- one copy of the formula, inlined by the planner. Ordered by position
             -- (a bare `score` here would be the OUT parameter), then by id so the
             -- order is total when rows share a created_at.
             recency_score(b.sim, t.created_at, v_weight, v_half)
      FROM best b
      JOIN thoughts t ON t.id = b.tid
      WHERE b.sim > match_threshold
      ORDER BY 6 DESC, t.id
      LIMIT v_count;
    ELSE
      -- 074: a min_trust's walk — 041's, the rank beside the containment
      -- inside both candidate CTEs, so the scan keeps going until v_fetch
      -- candidates pass both. EXECUTEd, so every call is planned with its
      -- values known: as a static statement plpgsql moved it to the cached
      -- generic plan on a connection's sixth call, and that plan is a
      -- BitmapAnd of the GIN and rank indexes and a top-N sort over every
      -- passing row, not the HNSW walk — 20 ms to 450 ms a call at 50,000
      -- rows, its rows changing with it (first review pass, run on
      -- PostgreSQL 16; under plan_cache_mode = force_custom_plan it stayed at
      -- 10–36 ms). 041's own walk can take the same turn under a selective
      -- filter, SMD-2468; its statements stay as they shipped here. The
      -- text is 041's walk with the locals as parameters: $1 the query, $2
      -- the filter, $3 the rank, $4 v_fetch, $5 the threshold, $6 and $7 the
      -- blend, $8 v_count.
      RETURN QUERY EXECUTE $walk$
      WITH direct AS (
        SELECT t.id AS tid, 1 - (t.embedding <=> $1) AS sim
        FROM thoughts t
        WHERE t.embedding IS NOT NULL
          AND t.metadata @> $2
          AND ob1_trust_rank(t.metadata->>'trust') >= $3
        ORDER BY t.embedding::halfvec({{EMBEDDING_DIM}}) <=> $1::halfvec({{EMBEDDING_DIM}})
        LIMIT $4
      ),
      chunked AS (
        SELECT c.thought_id AS tid, 1 - (c.embedding <=> $1) AS sim
        FROM thought_chunks c
        JOIN thoughts p ON p.id = c.thought_id
        WHERE p.metadata @> $2
          AND ob1_trust_rank(p.metadata->>'trust') >= $3
        ORDER BY c.embedding::halfvec({{EMBEDDING_DIM}}) <=> $1::halfvec({{EMBEDDING_DIM}})
        LIMIT $4
      ),
      best AS (
        SELECT u.tid, MAX(u.sim) AS sim
        FROM (SELECT * FROM direct UNION ALL SELECT * FROM chunked) u
        GROUP BY u.tid
      )
      SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
             recency_score(b.sim, t.created_at, $6, $7)
      FROM best b
      JOIN thoughts t ON t.id = b.tid
      WHERE b.sim > $5
      ORDER BY 6 DESC, t.id
      LIMIT $8
      $walk$ USING query_embedding, v_filter, v_min, v_fetch, match_threshold, v_weight, v_half, v_count;
    END IF;
  END IF;
END;
$$;

-- Replay the old function's privileges onto the new one (see the header). The
-- setting is empty when the new form already existed before this run (a
-- re-run: CREATE OR REPLACE kept its ACL and there is nothing to replay), when
-- there was no old function, or when the old ACL was NULL — the defaults — and
-- then nothing is done. Otherwise: revoke from EVERY grantee the CREATE gave
-- the new function (PUBLIC, and whatever ALTER DEFAULT PRIVILEGES added — on
-- Supabase anon, authenticated, service_role), then grant exactly what the
-- old ACL held, grant option included.
DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_match_thoughts', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float, text) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float, text)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float, text) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float, text) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

COMMENT ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float, text) IS
  'Semantic search over whole-thought vectors and chunk vectors, deduplicated to one row per thought scored by its best evidence; ordered by `score` (recency_score: the raw `similarity` blended with 0.5 ^ (age_days / half_life_days) at recency_weight, 0 by default — similarity alone), then id. The threshold gates the raw similarity. `filter` is metadata containment (014''s route: an exact answer over the matching rows, or the HNSW walk with the predicate inside the scan). min_trust (074) keeps rows whose metadata.trust is at or above it (operator > agent > ingested; a row with none is below every word) on the same route, through thoughts_trust_rank_idx; NULL is no constraint, any other word is refused. See the 020, 014 and 074 headers.';

-- ---------------------------------------------------------------------------
-- 4. search_thoughts_keyword(…, p_min_trust) — 019's body (012's, with ROWS
--    25), the rank beside the containment; the 4-argument form dropped and
--    its privileges replayed, as 3.
-- ---------------------------------------------------------------------------
SELECT set_config('ob1.acl_search_thoughts_keyword',
                  CASE WHEN to_regprocedure('search_thoughts_keyword(text, int, int, jsonb, text)') IS NOT NULL THEN ''
                       ELSE COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('search_thoughts_keyword(text, int, int, jsonb)')), '') END,
                  false);

DROP FUNCTION IF EXISTS search_thoughts_keyword(text, int, int, jsonb);

CREATE OR REPLACE FUNCTION search_thoughts_keyword(
  p_query   text,
  p_limit   int   DEFAULT 25,
  p_offset  int   DEFAULT 0,
  p_filter  jsonb DEFAULT '{}'::jsonb,
  -- 074: at or above this trust, as match_thoughts' min_trust; NULL is none.
  p_min_trust text DEFAULT NULL
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
  -- 074: the rank a row must reach; 0 is no constraint.
  v_min     int  := ob1_min_trust_rank(p_min_trust);
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
      -- 074: min_trust, beside the containment. The trigram index drives
      -- this statement; the rank is read on the rows it returns.
      AND (v_min = 0 OR ob1_trust_rank(t.metadata->>'trust') >= v_min)
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

DO $acl$
DECLARE
  v_acl  text := current_setting('ob1.acl_search_thoughts_keyword', true);
  v_item record;
BEGIN
  IF v_acl IS NULL OR v_acl = '' THEN
    RETURN;
  END IF;
  EXECUTE 'REVOKE ALL ON FUNCTION search_thoughts_keyword(text, int, int, jsonb, text) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('search_thoughts_keyword(text, int, int, jsonb, text)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION search_thoughts_keyword(text, int, int, jsonb, text) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION search_thoughts_keyword(text, int, int, jsonb, text) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;

COMMENT ON FUNCTION search_thoughts_keyword(text, int, int, jsonb, text) IS
  'Exact substring search over thoughts.content, case-insensitive, backed by the pg_trgm index from migration 011. Returns occurrences and the true total_count. No boolean operators: the query is one literal string. p_filter is metadata containment; p_min_trust (074) keeps rows whose metadata.trust is at or above it (NULL: no constraint; a row with none is below every word). See the 012 and 074 headers.';
