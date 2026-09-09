-- ============================================================================
-- 020 — match_thoughts blends recency into its ranking, after the candidate
--        scan, opt-in — and search_thoughts_hybrid carries the weight through
--
-- requires: pgvector >= 0.8.0
--   (match_thoughts is redefined here with 014's and 019's SET clauses, so
--   this file declares the same floor; db/migrate.ts reads the line)
--
-- Why (Linear SMD-945; the recency half of upstream #469)
--   match_thoughts ranks on cosine similarity alone, so age carries no weight:
--   two thoughts of equal fit rank identically whether one was captured
--   yesterday or two years ago. For an evergreen reference brain that is right;
--   for an active working brain — where "what was I doing about X" almost
--   always means recently — it is not, and the failure is quiet: the results
--   look plausible, they are just stale.
--
--   The idea is upstream's (schemas/recency-boosted-match-thoughts):
--
--     recency = exp(-age_days / half_life_days)
--     score   = similarity * (1 - recency_weight) + recency * recency_weight
--
--   with recency_weight defaulting to 0, so the default ranking is today's.
--   The code is not usable as written, and this fork's match_thoughts is why:
--   upstream's variant reads `public.thoughts` alone, which drops the chunk
--   retrieval 007 added (a long capture findable by any part of it), and it
--   puts the threshold and the blend into the scan — `WHERE similarity >=
--   threshold ORDER BY blended` — which is not a shape HNSW serves, so every
--   call becomes a distance computed for every row. Migration 019 measured
--   what that costs at the shipped width. So the blend is grafted onto the
--   body 014 and 019 built, and the access path does not move:
--
--   * The three candidate CTEs are 019's, byte for byte: `ORDER BY embedding
--     <=> query LIMIT v_fetch` over both tables, the filter inside the scan,
--     the exact branch for a thin filter. Only the final SELECT of each branch
--     changes — `ORDER BY` the blended score instead of the raw similarity —
--     and the blend is computed over the candidates the scan already
--     produced, at most 2 * v_fetch rows.
--   * The threshold gates the RAW similarity, as upstream's does: a high weight
--     cannot surface an irrelevant recent row, only reorder relevant ones.
--   * The exact branch scores every matching row, so under a filter it
--     answers exactly the blend is exact too.
--
-- The window
--   The blend can only reorder the candidate set, and the candidate set is the
--   v_fetch nearest by similarity. A row just outside it can be the right
--   answer under a weight: a recent row of similarity s enters the top k when
--   s * (1 - w) + w exceeds the k-th blended score, and whether any such row
--   exists depends on the data, not on a constant. So under a weight the
--   over-fetch widens fourfold — GREATEST(4 * count, 20) becomes 16 * count,
--   at least 80 — and the cost of a weighted call is that of an unweighted one
--   at four times the count (db/bench-plan.ts times it; at the default count
--   and 10,000 rows, both candidate CTEs stay Index Scans and the call goes from 1.8 ms and
--   3,434 buffers to 5.1 ms and 9,558; at count 50 from 6.3 to 16.9 ms, at the
--   ceiling from 33 to 79 ms; at 100,000 rows from 2–3 ms to 8, from 12–14 to
--   84, and from 170 to 365 at the ceiling). That factor is a heuristic, and it is
--   measured: evals/eval-recency.ts compares the function's top N against an
--   exact blended ranking of the whole corpus (a sequential scan), and the
--   top N the un-widened window would have given — on 486 queries at every
--   weight and half-life below, the function's top N was the oracle's in
--   every cell (100.0% overlap at 10 and at 100 results), where the 4 * count
--   window fell to 95% at weight 0.2 over 30 days, 92% at 0.3 and 85% at
--   weight 1. The adaptive
--   alternative — fetch, check the bound above, widen and fetch again — was
--   weighed and declined: it runs the index scan twice on the calls that need
--   it, or moves the candidate CTEs out of the RETURN QUERY blocks that
--   db/test-live.ts [5c] and both benches read from the catalog to prove the
--   plan. v_exact derives from v_fetch and widens with it: more filters are
--   answered exactly under a weight, which is correct and bounded.
--
-- The signature, and why the old one is dropped
--   Two parameters, both defaulted — `recency_weight float DEFAULT 0.0`,
--   `half_life_days float DEFAULT 90.0` — so every existing call is unchanged.
--   NOT a second overload beside the 4-argument function: a 6-argument
--   function with defaults beside a 4-argument one makes every 4-argument
--   call — both servers, search_thoughts_hybrid, every PostgREST caller —
--   fail with "function is not unique", the ambiguity 004's header names for
--   upsert_thought. So this file DROPs the 4-argument function first and
--   defines the 6-argument one, and there is one match_thoughts. A hand
--   re-apply of an earlier migration (007, 014, 019) would put the 4-argument
--   form back beside this one and break every 4-argument caller; preflight's
--   `search signatures` check reports two overloads as a failure with the DROP
--   as the remedy, and a database whose functions predate this file as one
--   with this file as the remedy. The same is done for search_thoughts_hybrid, which passes the
--   two parameters through and gets two of its own; its 5-argument form is
--   dropped. Both COMMENT ON FUNCTION are re-issued, since a DROP loses them.
--
-- `score` beside `similarity`
--   The return shape gains a sixth column, `score`: the blended value the rows
--   are ordered by, equal to `similarity` when the weight is 0. `similarity`
--   stays the raw cosine, for three reasons. It is what the threshold gates,
--   so a caller reading it against the threshold reads the right number. It is
--   what the tools show as "% match", which must not read a recency bonus as
--   relevance. And it is what search_thoughts_hybrid's probe computes for a
--   keyword hit outside the vector window — 017's header marks that probe as
--   the one copy of match_thoughts' scoring rule that a change must mirror;
--   with `similarity` unchanged there is nothing to mirror, and the tiebreak
--   among exact hits still compares one quantity. The hybrid's vector arm
--   ranks on `score` — 017 ranked it by `similarity` inside the function,
--   which would have undone the blend for every first-party search — and
--   everything else in 017's body is verbatim.
--
-- Inputs
--   recency_weight NULL is 0; outside [0, 1] it is clamped, with a NOTICE, as
--   014 clamps match_count — an over-eager 5.0 ranks by age alone rather than
--   failing the call. half_life_days NULL is 90; a non-positive half-life has
--   no meaning and raises invalid_parameter_value. A thought with no
--   created_at (the column has a default; a hand-written row can NULL it)
--   scores as infinitely old. now() is what the function sees for the whole
--   call; it is STABLE, as before.
--
-- Measured (evals/eval-recency.ts, the 486-issue corpus rebuilt on 2026-09-08
-- with each issue's creation date, qwen3-embedding:4b @ 1024)
--   The task is eval-real's — each issue's title as the query, its body the
--   document — so the right answer is the issue itself whatever its age, and
--   the number is what a weight COSTS on a relevance task; this corpus has no
--   ground truth for "what was I doing about X", so it cannot show a weight
--   helping. Issues are 0–183 days old, median 82. At the tools' setting (10
--   results, threshold 0.5), R@1 / MRR:
--
--     weight  half-life     R@1    MRR   top-1 changed (of 486)
--        0       —          84%   0.899      0
--       0.1    365 d        83%   0.890     15
--       0.1     90 d        80%   0.870     36
--       0.2    365 d        81%   0.878     34
--       0.2     90 d        69%   0.775    113
--       0.3     90 d        45%   0.576    238
--       0.5     90 d        27%   0.366    335
--       1        any         6%   0.158    450
--
--   Every weight lowers MRR here — gently over a long half-life, steeply over
--   a short one — because the corpus is time-ordered engineering work and the
--   query names one issue. At 0.2 over 90 days, 9 answers moved up and 113
--   down. So the default stays 0, as the ticket said it should if this was
--   the result, and a caller who knows their brain is a working log opts in.
--   The control passed on every query: at weight 0 the function returned
--   019's rows in 019's order, and score equalled similarity.
--
-- Exposure
--   search_thoughts takes `recency_weight` (0–1, default 0; the half-life stays
--   the function's 90 days for the tool). The ChatGPT-compat `search` cannot
--   grow a parameter and sends 0, by the measurement above: no weight helped
--   here, and that surface has no caller who could turn one off. Direct and
--   PostgREST callers pass both by name.
--
-- What a successor must carry
--   The match_thoughts body below is 019's with the DECLARE, the two input
--   checks and the three final SELECTs changed, and nothing else — the
--   candidate CTEs are 019's byte for byte, which db/test-schema.ts [21]
--   holds. A later migration that redefines match_thoughts must keep 019's
--   five items — the `-- requires: pgvector >= 0.8.0` header line, `SET
--   hnsw.iterative_scan = relaxed_order`, `SET enable_seqscan = off`, `ROWS
--   10`, the `-- ob1:filter-inside-scan` sentinel in the BODY, no other SET —
--   and now also: the 6-argument signature (dropping it means dropping the
--   6-argument form, not adding a seventh overload), the `score` column, and
--   the raw `similarity`. search_thoughts_hybrid's body is 017's with the
--   signature, the match_thoughts call and the rank's ORDER BY changed; a
--   successor keeps `SET jit = off` and the 7-argument signature. 014's DO
--   block — the database-level seeds — is not repeated here, as 019 did not.
--
-- Prerequisites
--   Migrations 017 and 019. pgvector 0.8.0 or later, as 014. Applied by
--   `bun db/migrate.ts`. After it, every caller must send the new arguments
--   or rely on the defaults; the 4-argument function no longer exists.
--
-- Expected outcome
--   One match_thoughts, `match_thoughts(vector, float, int, jsonb, float,
--   float)`, ROWS 10, proconfig with both settings; one search_thoughts_hybrid
--   with seven arguments. `SELECT * FROM match_thoughts(q)` returns six
--   columns and the same rows in the same order as before. With a weight, the
--   same candidate scan (db/test-live.ts [5c] explains it with 0.3) and a
--   different order.
-- ============================================================================

-- Load pgvector's library into THIS session before the CREATE below — 014
-- explains why: the SET clause names an hnsw.* setting, which a non-superuser
-- may set only once the library that owns the prefix is loaded. One cast.
SELECT '[1]'::vector;

-- The 4-argument function goes first. Beside the 6-argument one it would make
-- every 4-argument call ambiguous (see the header); IF EXISTS keeps this file
-- re-runnable. Nothing depends on it in the catalog — plpgsql resolves the
-- name at call time — and search_thoughts_hybrid is redefined below to call
-- the new form.
DROP FUNCTION IF EXISTS match_thoughts(vector, float, int, jsonb);

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
  half_life_days   float   DEFAULT 90.0
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
  -- The header prices the factor and says how it was measured.
  v_fetch      int     := GREATEST(v_count * 4, 20) * CASE WHEN v_weight > 0 THEN 4 ELSE 1 END;
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
    SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
           -- The blend (020): raw similarity weighted against exp(-age / half-life),
           -- over the candidates above. A NULL created_at is infinitely old — said
           -- with a CASE, since GREATEST would drop the NULL and call it brand new.
           b.sim * (1 - v_weight)
             + CASE WHEN t.created_at IS NULL THEN 0
                    ELSE exp(-GREATEST(extract(epoch FROM (now() - t.created_at)), 0) / 86400.0 / v_half) END * v_weight
    FROM best b
    JOIN thoughts t ON t.id = b.tid
    WHERE b.sim > match_threshold
    ORDER BY 6 DESC
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
      SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
             -- The blend (020): raw similarity weighted against exp(-age / half-life),
             -- over the candidates above. A NULL created_at is infinitely old — said
             -- with a CASE, since GREATEST would drop the NULL and call it brand new.
             b.sim * (1 - v_weight)
               + CASE WHEN t.created_at IS NULL THEN 0
                      ELSE exp(-GREATEST(extract(epoch FROM (now() - t.created_at)), 0) / 86400.0 / v_half) END * v_weight
      FROM best b
      JOIN thoughts t ON t.id = b.tid
      WHERE b.sim > match_threshold
      ORDER BY 6 DESC
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
      SELECT t.id, t.content, t.metadata, b.sim, t.created_at,
             -- The blend (020): raw similarity weighted against exp(-age / half-life),
             -- over the candidates above. A NULL created_at is infinitely old — said
             -- with a CASE, since GREATEST would drop the NULL and call it brand new.
             b.sim * (1 - v_weight)
               + CASE WHEN t.created_at IS NULL THEN 0
                      ELSE exp(-GREATEST(extract(epoch FROM (now() - t.created_at)), 0) / 86400.0 / v_half) END * v_weight
      FROM best b
      JOIN thoughts t ON t.id = b.tid
      WHERE b.sim > match_threshold
      ORDER BY 6 DESC
      LIMIT v_count;
    END IF;
  END IF;
END;
$$;

-- The 5-argument fused function goes the same way, for the same reason.
DROP FUNCTION IF EXISTS search_thoughts_hybrid(vector, text, float, int, jsonb);

CREATE OR REPLACE FUNCTION search_thoughts_hybrid(
  query_embedding  vector({{EMBEDDING_DIM}}),
  query_text       text,
  match_threshold  float   DEFAULT 0.7,
  match_count      int     DEFAULT 10,
  filter           jsonb   DEFAULT '{}'::jsonb,
  -- Passed through to match_thoughts (020); the vector arm's rank is then the
  -- blended order. Defaulted, and the 5-argument function is DROPPED above for
  -- the reason 020's header gives.
  recency_weight   float   DEFAULT 0.0,
  half_life_days   float   DEFAULT 90.0
)
RETURNS TABLE (
  id               uuid,
  content          text,
  metadata         jsonb,
  created_at       timestamptz,
  similarity       float,     -- NULL for a keyword hit with no vector and no chunks
  matched_needles  text[],    -- the needles this row contains, in query order
  needles          text[],    -- every row: the needles the keyword arm was asked for
  needle_counts    int[],     -- every row: how many thoughts contain each of `needles` (0 = none), so a hit cut by match_count is not reported as absent
  common_needles   text[],    -- every row: extracted, but its page was not its whole match set (more than 100 thoughts today), so not used
  literal_only     boolean,   -- every row: the query had nothing to embed, so the vector arm's rank was not scored
  score            float
)
LANGUAGE plpgsql
STABLE
-- Scoped to this call, like 014's hnsw setting. See "what this query must not
-- do" in 017's header: the planner prices JIT off an estimate that is three
-- orders of magnitude high here, and paid 14 ms of compilation per call for it.
SET jit = off
AS $$
DECLARE
  -- RRF's conventional constant. A rank-1 hit is worth 1/61; presence of one
  -- needle is worth the same.
  k              constant int := 60;
  -- Clamped rather than trusted, to the bound the tools enforce. It is also the
  -- vector arm's window: the rows match_thoughts would return for this call are
  -- the rows whose rank counts (see 017's header for the measurement behind that).
  v_count        int    := least(greatest(coalesce(match_count, 10), 1), 100);
  -- Coalesced like the other two: an explicit NULL from a hand-written RPC
  -- would otherwise make `sim > NULL` unknown and drop every vector-only row.
  v_threshold    float  := coalesce(match_threshold, 0.7);
  v_filter       jsonb  := coalesce(filter, '{}'::jsonb);
  v_all          text[] := extract_search_needles(query_text);
  v_residual     text   := coalesce(query_text, '');
  v_literal_only boolean;
  v_needle       text;
BEGIN
  -- The gate. Remove every extracted needle (and the quotes that marked one)
  -- from the query; if the English parser keeps no lexeme of what is left,
  -- there was nothing to embed and the vector arm's rank is not scored.
  -- Longest needle first, and lower-cased on both sides. The needles were
  -- de-duplicated case-insensitively keeping the first spelling, so a second
  -- spelling ("smd-944" after "SMD-944") or a needle that is a prefix of
  -- another ("ERR_TIMEOUT" removed before "ERR_TIMEOUT_LONG") would otherwise
  -- leave fragments the parser keeps as lexemes, and the gate would open for a
  -- query that is nothing but literals (review pass). The parser is
  -- case-insensitive, so lowering the residual changes nothing else.
  v_residual := lower(v_residual);
  FOR v_needle IN SELECT n FROM unnest(v_all) AS n ORDER BY length(n) DESC LOOP
    v_residual := replace(v_residual, lower(v_needle), ' ');
  END LOOP;
  -- The quote characters around a span are left in: the parser keeps no lexeme
  -- for punctuation, so stripping them changed nothing (review pass).
  v_literal_only := cardinality(v_all) > 0 AND length(to_tsvector('english', v_residual)) = 0;

  RETURN QUERY
  WITH
  -- Keyword arm: the full page per needle, with total_count deciding whether
  -- that page is the whole match set. `ord` keeps query order for the arrays.
  -- The row's columns ride along: both arms already return the whole row, so
  -- nothing below joins `thoughts` again (see "what this query must not do").
  -- Before a needle is paged, a probe asks whether it has more matches than a
  -- page holds: the 101st matching row, found and abandoned, not counted.
  -- 012's page materialises its whole match set to count it exactly — the
  -- 731 ms per 100,000 rows its header prices for a needle in every row — and
  -- for a common needle that page would only be discarded below. The pattern
  -- is escaped exactly as 012 escapes it, and db/test-schema.ts [17b] plants
  -- a decoy only an unescaped pattern matches so the two cannot drift.
  probe AS (
    SELECT n.needle, n.ord,
           EXISTS (SELECT 1 FROM thoughts t
                   WHERE t.content ILIKE '%' || replace(replace(replace(n.needle, '\', '\\'), '%', '\%'), '_', '\_') || '%'
                     AND (v_filter = '{}'::jsonb OR t.metadata @> v_filter)
                   OFFSET 100 LIMIT 1) AS common
    FROM unnest(v_all) WITH ORDINALITY AS n(needle, ord)
  ),
  kw AS (
    SELECT p.needle, p.ord, h.id AS hit_id, h.content AS hit_content, h.metadata AS hit_metadata,
           h.created_at AS hit_created_at, h.total_count
    FROM probe p
    CROSS JOIN LATERAL search_thoughts_keyword(p.needle, 100, 0, v_filter) AS h
    WHERE NOT p.common
  ),
  -- A needle is USED when the probe found no 101st row AND its page is its
  -- whole match set — the rows that came back equal total_count — and COMMON
  -- otherwise. The second test is the completeness itself rather than the page
  -- constant, so a change to 012's clamp cannot silently make the probe's 100
  -- wrong: it would only make the probe late, never the rule.
  kw_needles AS (
    SELECT p.needle, p.ord, p.common, coalesce(max(k2.total_count), 0) AS total, count(k2.hit_id) AS fetched
    FROM probe p
    LEFT JOIN kw k2 ON k2.needle = p.needle
    GROUP BY p.needle, p.ord, p.common
  ),
  used AS (
    SELECT coalesce(array_agg(kn.needle ORDER BY kn.ord) FILTER (WHERE NOT kn.common AND kn.fetched = kn.total), '{}'::text[]) AS needles,
           coalesce(array_agg(kn.total::int ORDER BY kn.ord) FILTER (WHERE NOT kn.common AND kn.fetched = kn.total), '{}'::int[])  AS counts,
           coalesce(array_agg(kn.needle ORDER BY kn.ord) FILTER (WHERE kn.common OR kn.fetched < kn.total), '{}'::text[]) AS common
    FROM kw_needles kn
  ),
  hits AS (
    SELECT k3.hit_id,
           array_agg(k3.needle ORDER BY k3.ord) AS matched,
           (array_agg(k3.hit_content))[1]  AS hit_content,
           (array_agg(k3.hit_metadata))[1] AS hit_metadata,
           min(k3.hit_created_at)          AS hit_created_at
    FROM kw k3
    JOIN kw_needles kn ON kn.needle = k3.needle AND NOT kn.common AND kn.fetched = kn.total
    GROUP BY k3.hit_id
  ),
  -- Vector arm: ranks over the N rows match_thoughts would return, whatever
  -- their similarity — the threshold is applied below, after the exact hits
  -- have been exempted from it. Ranked by match_thoughts' own `score` (020:
  -- the recency blend, equal to the similarity at weight 0), so the order the
  -- semantic tool would show is the order that counts here; `vsim` stays the
  -- raw similarity, which is what the threshold and the tiebreak read.
  vec AS (
    SELECT m.id AS vid, m.content AS vcontent, m.metadata AS vmetadata, m.created_at AS vcreated_at,
           m.similarity AS vsim,
           row_number() OVER (ORDER BY m.score DESC, m.id) AS rnk
    FROM match_thoughts(query_embedding, -1.0, v_count, v_filter, recency_weight, half_life_days) AS m
  ),
  cand AS (
    SELECT v.vid AS cid FROM vec v
    UNION
    SELECT h.hit_id FROM hits h
  ),
  scored AS (
    SELECT
      c.cid,
      coalesce(v.vcontent,    h.hit_content)    AS content,
      coalesce(v.vmetadata,   h.hit_metadata)   AS metadata,
      coalesce(v.vcreated_at, h.hit_created_at) AS created_at,
      -- A keyword hit outside the vector window is scored directly, by the
      -- rule match_thoughts uses: best of the thought's own vector and its
      -- chunks. THIS IS A SECOND COPY OF THAT RULE, and the one place a change
      -- to match_thoughts' `similarity` must be mirrored. 020's recency blend
      -- did not change it, deliberately: the blend is a separate `score`
      -- column and `similarity` stays the raw cosine, so an in-window row and
      -- a keyword-only row still carry the same quantity and the tiebreak
      -- among exact hits compares like with like. db/test-live.ts [11] reaches
      -- this path with a window of one and holds it to match_thoughts' number.
      coalesce(
        v.vsim,
        (SELECT max(1 - (x.e <=> query_embedding))
         FROM (SELECT t2.embedding AS e FROM thoughts t2 WHERE t2.id = c.cid AND t2.embedding IS NOT NULL
               UNION ALL
               SELECT ch.embedding FROM thought_chunks ch WHERE ch.thought_id = c.cid) AS x)
      ) AS sim,
      h.matched,
      (CASE WHEN v.rnk IS NOT NULL AND NOT v_literal_only THEN 1.0 / (k + v.rnk) ELSE 0.0 END)
        + coalesce(cardinality(h.matched), 0) * (1.0 / (k + 1)) AS fused
    FROM cand c
    LEFT JOIN vec  v ON v.vid    = c.cid
    LEFT JOIN hits h ON h.hit_id = c.cid
  )
  SELECT
    s.cid, s.content, s.metadata, s.created_at,
    s.sim::float,
    coalesce(s.matched, '{}'::text[]),
    u.needles,
    u.counts,
    u.common,
    v_literal_only,
    s.fused::float
  FROM scored s
  CROSS JOIN used u
  WHERE s.matched IS NOT NULL OR s.sim > v_threshold
  ORDER BY s.fused DESC, s.sim DESC NULLS LAST, s.created_at DESC, s.cid
  LIMIT v_count;
END;
$$;

-- Re-issued: a DROP loses the COMMENT (007's and 017's), and the description
-- below is a description, not a marker — the sentinel in the body is that.
COMMENT ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) IS
  'Semantic search over whole-thought vectors and chunk vectors, deduplicated to one row per thought scored by its best evidence; ordered by `score`, which blends the raw `similarity` with exp(-age_days / half_life_days) at recency_weight (0 by default: similarity alone). The threshold gates the raw similarity. See the 020 header.';

COMMENT ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float) IS
  'match_thoughts and search_thoughts_keyword fused: reciprocal rank on the vector arm (in match_thoughts'' own order — its `score`, the recency blend at recency_weight, similarity alone at 0), presence per matched needle on the keyword arm, each hit''s own cosine similarity as the tiebreak. Needles come from extract_search_needles(query_text). Fixed top-N (no paging); a query with no needle returns match_thoughts'' rows in match_thoughts'' order, ties in score broken by id. See the 017 and 020 headers.';
