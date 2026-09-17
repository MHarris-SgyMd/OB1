-- ============================================================================
-- 038 — match_thoughts samples the heap by TID range: 037's gate reads its
--        eight pages as eight TID Range Scans instead of a TABLESAMPLE SYSTEM
--        over the whole heap, so the sample costs eight page reads at any
--        size and counts the pages it drew (SMD-1526)
--
-- requires: pgvector >= 0.8.0
--   (match_thoughts is redefined here with 014's and 019's SET clauses, so
--   this file declares the same floor; db/migrate.ts reads the line)
--
-- If filtered search is slow with this file installed
--   This file's own cost is eight page reads on every filtered call over the
--   floor — about 0.05 ms with one row a page, about 0.3 at the shipped
--   width — and nothing that grows with the heap. Read auto_explain with
--   log_nested_statements (an EXPLAIN of the call shows only the Function
--   Scan; the body's statements are nested), or EXPLAIN the statement
--   db/test-support.ts's extractBody reads out of the body: a `JIT:` block
--   under the sample means a disabled planner path (enable_tidscan,
--   enable_nestloop, or hashagg and sort together — SMD-1624); a `Seq Scan
--   on thoughts` under the collection or the walk means row-level security
--   on the table, which costs `metadata @> filter` its GIN index since 014
--   (SMD-1625); a body carrying TABLESAMPLE means 037 was pasted over this
--   file — `bun db/migrate.ts --reapply` (preflight has no recogniser for
--   the gate's body; FORK.md change 78's operator's path). Failure modes
--   below has the first two.
--
-- Why
--   037 (SMD-1463) gates the routing count — the capped GIN collection every
--   filtered call opened with, whose cost is the number of matching rows —
--   behind a sample of the heap: `FROM thoughts t TABLESAMPLE SYSTEM (v_pct)`
--   with the share sized to {{ROUTE_SAMPLE_PAGES}} pages. SYSTEM decides page
--   by page over the WHOLE heap — it hashes every block number against its
--   cutoff — so the statement carried about 2 ns per heap page besides the
--   eight pages' rows. Measured with one row a page and every page warm —
--   in the OS page cache: the 20,000- and 200,000-page heaps exceed the
--   image's 128 MB shared_buffers — the way 037's first review pass measured
--   it (0.038 / 0.094 / 0.459 then), both statements re-run for this file,
--   and once more by the fourth review pass on a fresh container (038 0.029
--   / 0.049 / 0.054, 037 0.027 / 0.071 / 0.433):
--
--     heap pages    037's sample     this file's
--     2,000           0.036 ms         0.034 ms
--     20,000          0.075            0.048
--     200,000         0.469            0.052
--
--   At ten million rows (526,000 pages) that was a millisecond on every
--   filtered call, whatever the buffer pool held: the empty-filter shape one
--   integration sends on every call went from 0.27 ms to 1.31 in the bench
--   (FORK.md change 70's third finding), and by the slope a hundred million
--   rows would pay some 10 ms. Sizing shared_buffers does not change it.
--   037's header stated the term, its "large heap" failure mode named this
--   statement as the fix, and this file is it.
--
--   A second, smaller defect of the same statement: 037's `pages_seen` was
--   the count of distinct pages among the rows RETURNED, so a sampled page
--   with no live row — a mass delete and a plain VACUUM leave them —
--   dropped out of the denominator and the scaled estimate `hits x pages /
--   pages_seen` was biased up. Conditions 2 and 3 still protected a thin
--   filter, but the uniform bound moved from ~1e-7 to ~3e-5 on a heap three
--   quarters empty at the floor (037's "bloated heap" bullet).
--
-- What
--   The gate is 037's — floor, {{ROUTE_SAMPLE_PAGES}} pages, three conditions,
--   the collection wrapped in the same IF — and only the statement that
--   produces its three counts changes:
--
--     SELECT count(*) FILTER (WHERE p.hit),
--            count(DISTINCT b.blk) FILTER (WHERE p.hit),
--            count(DISTINCT b.blk)
--       INTO v_hits, v_hit_pages, v_pages_seen
--     FROM (SELECT DISTINCT floor(random() * v_pages)::bigint AS blk
--           FROM generate_series(1, {{ROUTE_SAMPLE_PAGES}})) b
--     LEFT JOIN LATERAL (
--       SELECT (t.metadata @> filter AND t.embedding IS NOT NULL) AS hit
--       FROM thoughts t
--       WHERE t.ctid >= ('(' || b.blk || ',0)')::tid
--         AND t.ctid <  ('(' || b.blk + 1 || ',0)')::tid
--       LIMIT 291
--     ) p ON true;
--
--   Eight block numbers are drawn from the heap's page count (v_pages, 037's
--   local, still computed at entry from pg_relation_size), made distinct, and
--   each is read as one TID range — every tuple of block b and nothing else:
--   a TID Range Scan (PostgreSQL 14 and later), one page read per block,
--   whatever the heap holds. The rows on those pages are counted as 037
--   counted them: the ones passing the filter with a vector, the distinct
--   blocks those sit on, and now the distinct blocks DRAWN — the LEFT JOIN
--   keeps a block that returned no row — which is the denominator the rule
--   always meant. v_pct goes: it was TABLESAMPLE's argument.
--
--   The draw changes shape a little. SYSTEM took a binomial number of pages
--   with mean eight and reached fewer than three about 1.4% of the time
--   (Poisson: e^-8 x 41) — the misses db/test-live.ts [5d] had to widen its
--   band for, 17 in 1,000 draws on its fixture. Eight draws with the
--   duplicates collapsed reach eight distinct pages almost always (a
--   collision among eight draws over 8,192 pages has probability ~0.3%;
--   measured, the fewest pages in 1,000 draws at the floor was 7, in 20,000
--   draws 6), so the broad filters are skipped a little more often and the
--   band in [5d] is exact — one GIN scan fewer per call, every call. The
--   rates re-measured are under Failure modes.
--
--   Everything else is 037's, token for token: the rule, the collection
--   (014's statement, db/test-schema.ts [20] compares it), the three
--   branches, 019's two SET clauses and ROWS 10, the `ob1:filter-inside-scan`
--   sentinel, the two template constants, and — this file being the last
--   definer, which preflight's remedy and the suites' restoreShipped apply
--   ALONE — 020's DROP of the 4-argument form with its ACL capture and
--   replay (037's header says why; test-upgrade [16] holds it).
--
-- Design — why this statement
--   * A TID Range Scan reads one block and stops: `ctid >= '(b,0)'` is at or
--     below every tuple of block b (offsets start at 1) and `ctid <
--     '(b+1,0)'` above them; the executor clamps a bound past the heap, so
--     the last block's upper bound and a block the heap no longer has (it
--     shrank between the sizing and the read) read nothing and cost nothing
--     — and such a block still counts among the pages drawn, which lowers
--     the estimate: the safe side. Core Postgres has no constructor from a
--     block number to a tid, so the bounds are built as text — sixteen
--     text-to-tid casts a call. The block is a bigint: as an int the draw
--     and its +1 would overflow past 2^31 pages, a 16 TB heap.
--   * The LIMIT is for the planner, twice over, and never cuts a page: an
--     8 KB page holds at most 291 tuples (MaxHeapTuplesPerPage), so no block
--     can return more. First, it keeps the probe a subquery. Without it the
--     planner pulls the LATERAL up into the join, the ctid bounds become
--     JOIN quals, and the TID Range path — which reads a relation's own
--     restrictions only — is never built: the plan was a sequential scan of
--     the whole heap under Materialize, cost 10,000,002,844 at 2,000 pages
--     (disable_cost plus the heap) under 019's enable_seqscan = off, 72 ms
--     there and 632 at 200,000
--     (measured). Second, it caps the estimate: the planner cannot see a
--     bound that is an expression over another relation's column, prices
--     the range at its default (half a per cent of the heap), and at ten
--     million rows would put the eight probes at some tens of thousands of
--     cost units — within reach of jit_above_cost (100,000) on a larger heap,
--     where JIT compiles the statement on every execution (037's third
--     finding met exactly that, 50 ms a call). With the cap each probe is
--     priced at 291 rows at most: the whole statement at 107 / 849 / 2,405
--     cost units at 2,000 / 20,000 / 200,000 pages, flat from there, and no
--     JIT at any size — while the paths it is built from are enabled; the
--     "disabled planner path" failure mode below is the exception. A build
--     with 32 KB pages could hold more tuples on a
--     dense page than the LIMIT admits; the count would then be short, the
--     estimate low, and the collection run — the safe side again.
--   * The blocks are drawn inside the statement, not in plpgsql: no extra
--     SPI round trip at entry (the unfiltered path still pays for v_pages
--     alone, as under 037), and the estimate stays ONE statement over locals
--     declared at entry — which db/bench-hnsw.ts section C reads through
--     test-support's extractBody and routingAt, and db/test-schema.ts [8e]
--     reads out of pg_proc to run against its own table with the locals
--     substituted. random() in the subquery's target list is evaluated once
--     per row of
--     generate_series (the once-only trap is a scalar subquery, an InitPlan);
--     DISTINCT collapses a block drawn twice so no page is read or counted
--     twice, and keeps that subquery a subquery too. (EXPLAIN deparses the
--     probe's bound as `floor((random() * '1191'::double precision))::bigint`,
--     which reads as if random() ran once per probe; it does not — the
--     Unique node above the probe shows loops=7 when two draws collide.)
--   * Plan mode, which 037's statement lost on. Both plan modes price this
--     statement alike — the bounds are column references under either — so
--     plpgsql adopts the generic plan after the fifth call and never replans:
--     measured through a plpgsql wrapper on a 200,000-page heap, a few
--     hundredths of a millisecond a call over the round trip in the default
--     mode (0.01–0.09 across rounds; the round trip it is measured against
--     is 0.2–0.3) against 0.14–0.22 under force_custom_plan (the replan)
--     and 0.5–0.7 for 037's statement, which was
--     priced 200x cheaper custom than generic and so replanned on every
--     call (037's "generic plan" bullet). One plan, cached, eight page reads.
--   * Not tsm_system_rows' `TABLESAMPLE SYSTEM_ROWS`, which walks a random
--     stride of blocks and stops after n ROWS: an extension the function
--     would then depend on (PGlite, where db/test-schema.ts runs, does not
--     ship it), rows rather than pages as the unit, and 037's pages_seen
--     defect unchanged. Not eight statements in a plpgsql loop: eight plans
--     and eight SPI calls where one does (eight literal arms planned in
--     0.07–0.1 ms a call, measured). Not the planner's `@>` estimate, for
--     037's reasons.
--   * pg_relation_size and to_regclass as 037: exact, one stat() call, the
--     name resolved on every call (a temp table shadowing the name: Failure
--     modes below, two shapes).
--
-- Failure modes, each with its cost
--   * An unlucky sample skips a filter at or under the threshold. As 037,
--     the call goes to the walk: correct, slower, and at a million rows in
--     the half-to-one-per-cent band it can return short (FORK.md change 28).
--     The rates, re-measured for this draw over 1,000 draws per filter on a
--     500,000-row corpus of the bench's shape (24,999 pages, 20 rows a page,
--     v_exact 1,000; 037's statement on the same corpus in brackets):
--
--       filter          matching rows   placement          skipped
--       50%                 249,851     uniform            1,000  (984)
--       10%                  49,829     uniform              987  (901)
--       10,000 rows          10,000     one contiguous run     0    (1)
--       1%                    4,915     uniform                1    (1)
--       2,000 rows            1,882     uniform                0    (0)
--       1,000 rows            1,000     one contiguous run     0    (0)
--       1,000 rows            1,000     four a page, 251 pages 0    (0)
--       900 rows                858     uniform                0    (0)
--       0.1%                    504     uniform                0    (0)
--       0.01%                    58     uniform                0    (0)
--       nothing                   0     —                      0    (0)
--
--     Every filter at or under the threshold ran the collection every time;
--     the broad ones are skipped a little more often than under 037 (the
--     draw always reaches its pages). Just under the floor — a 163,840-row
--     corpus of 8,191 pages — the same over 1,000 draws (the 20,000-draw
--     rates for the two thin layouts are the next bullet), with the 50%
--     filter 1,000 and the 10% 979 of 1,000 in one run, 961 in a re-run — a
--     knife-edge tier there, ten hits needed of a mean sixteen — (037: 993
--     and 905; 983 and 884 re-run); the contiguous 10,000 was skipped 10
--     times (037's statement: 13 of 1,000), which is not a wrong answer at
--     ten times the threshold. Every 037 figure in brackets here is one run,
--     and a re-seeded re-run moved them by up to two sigma with every
--     comparison keeping its direction.
--   * The thin-spread layout, the one 037's third condition is weakest
--     against (a few matches a page over hundreds of pages): 1,000 rows four
--     a page over 251 pages of the 8,191 were skipped 29 times in 20,000
--     draws at the floor — 1.45e-3, which is the formula's figure: C(8,3) x
--     (251 / 8,191)^3 = 1.6e-3 as a union bound, 1.44e-3 exact (a re-run:
--     34 in 20,000). 037's statement, re-run on this heap, was skipped only
--     14 times in 20,000 — under the formula's 32 — because SYSTEM's
--     variance made condition 1 fail on its larger draws (FORK.md change 78
--     has the arithmetic, and why 037's own header says 13). That accident
--     is gone, and the bound is now what 037's header computes, falling as
--     the cube of the heap (7e-6 at a million rows, 7e-9 at ten million). A
--     contiguous 1,000 rows
--     were skipped once in 20,000 (0), the 900-row uniform filter never.
--     `hit_pages >= 4` remains the knob if that band matters (C(8,4) x f^4,
--     ~6e-5 at the floor); the rule ships as 037 shipped it.
--   * A count above the default. As 037's header says: at the ceiling
--     (match_count 500, v_exact 8,000) condition 1 needs about ten hits a
--     page, so near the floor the 10% filter is never skipped (0 of 2,000 at
--     8,191 pages; 037: 0) and the 50% filter about half the time (1,169 of
--     2,000; 037: 1,212) — the collection runs as before 037, plus the
--     sample. On the 24,999-page corpus the 50% filter is skipped 1,000 of
--     1,000 at the ceiling (984), the 10% 9 (15).
--   * A bloated heap. The pages drawn now count whether or not they hold a
--     row, so an empty page lowers the estimate rather than raising it. On
--     the 500,000-row corpus with the middle three quarters deleted and
--     plain-VACUUMed (empty pages kept in the heap), the broad filters get
--     their collection back for want of hits, as under 037 — the cost before
--     037 returns, nothing worse — and the thin filters' bound is the
--     uniform one again, not the ~3e-5 the biased denominator gave (the
--     figures are in FORK.md change 78). VACUUM FULL restores the density.
--   * The eight page reads. They are the whole cost now: about 0.05 ms
--     together on a heap of one row a page, warm in the page cache, about
--     0.3 ms at the shipped width's 65–80 rows a page, each of which the
--     filter is tested against (db/test-live.ts [5d] prints it: 0.27–0.33
--     ms with the round trip on its 386-page heap; 037's sample cost the same
--     there, plus its per-page term). On a heap larger than
--     memory they are eight random reads from disk — on the order of 0.1 ms
--     each on NVMe, more on network storage — where 037 paid the same reads
--     plus its per-page term. A brain of a hundred million rows pays those
--     reads on every filtered call and nothing that grows with the heap.
--   * A generic plan. Adopted by design after the fifth call (Design above);
--     it is the plan both modes agree on, and the cap keeps it clear of JIT
--     while its paths are enabled (next bullet).
--   * A disabled planner path. Every piece of the statement has exactly one
--     viable path — a TID Range Scan for the block (enable_seqscan is
--     already off on the function), a Nested Loop for the LATERAL join
--     (nothing else takes a lateral reference), Sort/Unique or HashAggregate
--     for the DISTINCT draw. When a session, role or database turns that
--     path off (`enable_tidscan = off`, `enable_nestloop = off`, or
--     `enable_hashagg` and `enable_sort` both off) the planner still chooses
--     it and adds disable_cost, 1e10, and the statement's cost is then far
--     past jit_above_cost and its inlining and optimisation thresholds: the
--     executor JIT-compiles the sample on EVERY call. Measured through the
--     function on a 1,191-page heap with the floor lowered (review pass 3):
--     0.46 ms a call by
--     default, 41 under `enable_tidscan = off` or `enable_nestloop = off` —
--     the same plan node, the same eight buffers, the compiler's time —
--     and `ALTER DATABASE … SET enable_nestloop = off`, a spelling operators
--     do use, gives every fresh connection the 41. The tidscan and nestloop
--     sensitivities are new with this file (037's Sample Scan had neither a
--     join nor a TID path); the hashagg-and-sort one is 037's too (85 ms
--     against 81); through the shipped function over the floor on a
--     24,999-page heap (review pass 4): 0.49 / 43 / 48 / 90 ms, and 0.52
--     with tidscan off and jit off. Nothing but the plan shows it — the
--     `JIT:` block and a cost past 1e10 in auto_explain — not the
--     rows, preflight or the ledger. `SET jit = off` on the function
--     removes all three GUC triggers
--     (measured, 0.38–0.82 ms under each), but also changes what the WALK
--     pays under a generic plan, which is SMD-1464's plan-mode question;
--     pinning `enable_tidscan = on` and `enable_nestloop = on` on the
--     function overrides the operator's setting for the walk too. The
--     decision is SMD-1624; this file states the premise.
--   * Row-level security on thoughts (SMD-1625; since 014/019, unchanged
--     here). A fourth trigger of the same JIT, and the one operators
--     actually set: `jsonb_contains` is not leakproof, so under a policy
--     `metadata @> filter` cannot be an index qual, and 014's collection
--     and the walk's direct CTE become sequential scans at disable_cost,
--     JIT-compiled — 150 ms against 7 on 25,000 rows, a heap scan per
--     filtered call at scale. The probe here is unaffected in kind: the TID
--     bounds ARE leakproof, so it keeps its plan under a policy and merely
--     undercounts its hits, the safe side.
--   * A temp table shadowing the name, in two shapes (measured through
--     auto_explain). In a session that already has a temp schema, the cached
--     plans keep reading the real table while v_pages sizes the shadow —
--     037's case: the probes read blocks 0..2 of the real heap for a
--     three-page shadow. In a session whose FIRST temp table is the shadow,
--     creating it changes the effective search path, every cached plan is
--     rebuilt, and the whole call — probes, collection and walk — reads the
--     shadow. Both are the safe side: under the shipped floor a small shadow
--     switches the gate off, and a fresh session sees one table.
--   * A block past the heap, wide metadata, statistics: as 037's header
--     states them; nothing here reads pg_statistic or reltuples.
--
-- Cost, measured
--   The statement alone: the table under Why (EXPLAIN ANALYZE execution
--   time, median of 30, one row a page, every page warm in the OS page
--   cache, enable_seqscan off as the function has it; this file's
--   development machine is an Apple M5 Pro running a podman VM with pgvector
--   0.8.6 on PostgreSQL 16 at its image defaults, and the fourth review pass
--   re-ran it on a fresh container), and 0.045–0.07 ms a draw on the
--   500,000-row corpus (0.13–0.15 for
--   037's), the same for the 50% filter and the empty one: the cost is the
--   pages read, not the rows that pass. Through the function, on that
--   200,000-page heap: a few hundredths of a millisecond a call over the
--   round trip once the generic plan is adopted, against 0.5–0.7 for
--   037's. db/bench-hnsw.ts before and
--   after this file at 10,000, a million and ten million rows are FORK.md
--   change 78's tables; section C prints the sample's own cost beside the
--   collection's at every scale: 0.07–0.14 ms at 10,000 rows, 0.08–0.12 at
--   a million, 0.09–0.12 at ten million (037's: 0.04–0.14, 0.22–0.36, and
--   1.10–1.20 in a before pass that ran under load — 0.94–1.11 on the idle
--   machine across FORK.md change 70's two passes, so load barely moved
--   that
--   row). Through the function the empty filter at ten million rows
--   costs 0.36 ms — 0.27 before 037, 1.31 under it — and the 50% tier 14.4,
--   as under 037 (13.2); the thin tiers moved by the sample's saving and the
--   spread. Those are the ticket's two checks, the estimate flat across the
--   scales and the empty filter back within 0.1 ms of what it cost before 037.
--
-- What a successor must carry
--   037's list, unchanged — `SET hnsw.iterative_scan = relaxed_order`, `SET
--   enable_seqscan = off`, `ROWS 10`, the `ob1:filter-inside-scan` sentinel,
--   the pgvector floor line; 020's DROP of the 4-argument form with the ACL
--   capture before it and the replay after; the two template constants; and
--   the estimate as ONE statement over locals declared at entry (v_pages
--   with pg_relation_size, no v_pct), which db/bench-hnsw.ts section C reads
--   through test-support's routingAt and extractBody and db/test-schema.ts
--   [8e] reads out of pg_proc. If it keeps this sampling, the probe's LIMIT
--   stays with it (Design: a probe pulled up into the join is a sequential
--   scan of the heap), and so do DISTINCT on the draw and the LEFT join. A
--   successor that changes the statement's shape changes which planner
--   paths it has exactly one of, and re-derives the "disabled planner path"
--   list under Failure modes (and inherits whatever SMD-1624 pins on the
--   function). A successor that removes the
--   gate should say why in its header and expect FORK.md change 70's tables
--   to come back.
--
-- Prerequisites
--   Migration 037 (the gate this file re-samples; 037 carries 020's
--   signature). PostgreSQL 14 or later for the TID Range Scan — the fork
--   pins pgvector's pg16 image, PGlite is 17, Supabase ships 15 and 17, and
--   the suites ran green on 15, 16 and 17 — and pgvector 0.8.0 or later, as
--   014. Nothing enforces the 14. On 13 (out of support, not run here) the
--   planner's account says the CREATE would succeed and the probe, with no
--   TID Range path to take, would be a sequential scan of the heap per block
--   at disable_cost, JIT-compiled — the no-LIMIT shape under Design (72 ms at
--   2,000 pages), on every call.
--   The suites themselves need 15 (db/test-live.ts reads
--   pg_stat_force_next_flush). Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   `match_thoughts` returns what 037's returned for every call, up to the
--   skip probabilities under Failure modes; on a heap of
--   {{ROUTE_ESTIMATE_MIN_PAGES}} pages or more every filtered call pays
--   eight page reads for its sample and nothing that grows with the heap,
--   so the empty-filter call at ten million rows costs what it cost before
--   037 within 0.1 ms (db/bench-hnsw.ts sections B and
--   C, before and after). pg_proc.prosrc carries the sentinel, the TID
--   range probe and the two constants, and no TABLESAMPLE; db/test-schema.ts
--   [8e], db/test-live.ts [5d] and db/test-upgrade.ts [16] hold it.
-- ============================================================================

-- Load pgvector's library into THIS session before the CREATE below: the SET
-- clause names an hnsw.* setting, which a non-superuser owner is refused for
-- until the library is loaded (014's header has the reproduction).
SELECT '[1]'::vector;

-- The 4-argument form's privileges, read before the DROP below so the CREATE
-- can be given the same ones — 020's capture, carried because this file is now
-- the last definer and is applied alone over a hand-re-applied 014 or 019 (see
-- the header). Empty when the 6-argument form already exists (the ordinary
-- case: CREATE OR REPLACE keeps its ACL and the replay does nothing).
SELECT set_config('ob1.acl_match_thoughts',
                  CASE WHEN to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float)') IS NOT NULL THEN ''
                       ELSE COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('match_thoughts(vector, float, int, jsonb)')), '') END,
                  false);

-- The 4-argument form goes first, as in 020: beside the 6-argument one it makes
-- every 4-argument call ambiguous; IF EXISTS keeps this file re-runnable.
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
    -- {{ROUTE_SAMPLE_PAGES}} block numbers and read each block as a TID
    -- range — `ctid >= '(b,0)' AND ctid < '(b+1,0)'`, a TID Range Scan, one
    -- page read per block whatever the heap holds (037's SYSTEM sample
    -- decided page by page over the WHOLE heap and cost ~2 ns a heap page:
    -- a millisecond at ten million rows; this file's header) —
    -- and count the rows that pass the filter and carry a vector, the pages
    -- those rows sit on, and the pages drawn. A row with a vector, not the
    -- collection's "vector or chunks": the EXISTS probe inside an expression
    -- became a hashed subplan over the whole chunk table (18 ms measured,
    -- against 0.15 for the sample), and counting fewer scoreable rows than
    -- there are only biases the gate towards running the collection, which
    -- is the safe side. The draw is DISTINCT so a block drawn twice is read
    -- and counted once; the join is LEFT so a page with no live row still
    -- counts among the pages drawn (037's pages_seen counted only pages that
    -- returned a row, which biased the estimate up on a bloated heap). The
    -- probe's LIMIT never cuts a page — an 8 KB page holds at most 291
    -- tuples — and is there for the planner: it keeps the probe a subquery,
    -- so the ctid bounds stay a base restriction the TID Range path reads
    -- (pulled up into the join they become join quals, and the plan is a
    -- sequential scan under Materialize: 72 ms measured), and it caps the
    -- estimate the planner cannot make for a bound it cannot see, so the
    -- statement's cost stays far under jit_above_cost at any heap size —
    -- unless an operator has disabled a path it is built from (tidscan,
    -- nestloop, or hashagg and sort together), when disable_cost puts every
    -- call through the JIT compiler: the header's failure mode, SMD-1624.
    -- Sampling is by page, so a filter whose matches sit together on disk
    -- shows up as one page full of hits or none, and the third condition
    -- below is what catches that.
    IF v_pages >= {{ROUTE_ESTIMATE_MIN_PAGES}} THEN
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

    -- Only rows a branch can SCORE count towards the threshold: a thought
    -- captured through the 2-arg fallback has no vector and, until re-embedded,
    -- no chunks, so it can never be a candidate on either side. Counting those
    -- (the eleventh draft did) could route a filter with 1,200 matches of which
    -- 30 are scoreable to the walk, which then needs 40 passing rows that do not
    -- exist, runs to the scan bound and returns short — where the exact branch
    -- scores all 30 (twelfth review pass; db/test-schema.ts [8d] pins it).
    -- 014's statement, verbatim (db/test-schema.ts [20] compares it), run
    -- only when the gate above did not already decide.
    IF NOT v_broad THEN
      SELECT array_agg(s.id) INTO v_ids
      FROM (
        SELECT t.id FROM thoughts t
        WHERE t.metadata @> filter
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
  EXECUTE 'REVOKE ALL ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) FROM PUBLIC';
  FOR v_item IN
    SELECT DISTINCT a.grantee FROM pg_proc p, aclexplode(p.proacl) AS a
    WHERE p.oid = to_regprocedure('match_thoughts(vector, float, int, jsonb, float, float)') AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) FROM %s', quote_ident(pg_get_userbyid(v_item.grantee)));
  END LOOP;
  FOR v_item IN SELECT grantee, privilege_type, is_grantable FROM aclexplode(v_acl::aclitem[]) LOOP
    IF v_item.privilege_type = 'EXECUTE' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) TO %s%s',
                     CASE WHEN v_item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_item.grantee)) END,
                     CASE WHEN v_item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END IF;
  END LOOP;
END
$acl$;
