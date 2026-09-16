-- ============================================================================
-- 036 — match_thoughts samples the heap before it counts the filter: the
--        capped GIN collection every filtered call opened with is skipped
--        when eight random pages already show the filter far too broad for
--        the exact branch (SMD-1463)
--
-- requires: pgvector >= 0.8.0
--   (match_thoughts is redefined here with 014's and 019's SET clauses, so
--   this file declares the same floor; db/migrate.ts reads the line)
--
-- Why
--   Every filtered call since 014 opens with the routing statement —
--
--     SELECT array_agg(id) FROM (SELECT id FROM thoughts
--       WHERE metadata @> filter AND <scoreable> LIMIT v_exact + 1) s
--
--   — to decide between the exact branch (at most v_exact matching thoughts,
--   scored by primary key) and the HNSW walk. GIN builds its whole bitmap for
--   the filter before the first row comes back, so the LIMIT caps the heap
--   fetches and nothing else: the statement costs the number of MATCHING
--   rows, about 50 ns each, whatever it returns. 014's header said so and
--   measured 2.5 ms at 50% of 100,000 rows; SMD-1018 measured it at scale
--   (db/bench-hnsw.ts section C, FORK.md change 28 "At scale"):
--
--     rows          route, 50% filter   the 50% tier's whole call
--     10,000            0.8 ms            2.4 ms
--     100,000           3.0 ms            8.3 ms
--     1,000,000        27 ms             38.6 ms
--     10,000,000      240 ms            268 ms
--
--   At ten million rows it is nine tenths of the broadest tier's latency,
--   and at 10% (~50 ms of ~150) a third. The walk that follows needs some
--   eighty tuples at 50%. 014's header named the mitigation —
--   estimate the match count first, run the collection only when the
--   estimate is plausibly under the threshold — and declined it for want of
--   a number; SMD-1018's tables are the number, and this file is the
--   mitigation. Nothing else moves: the threshold, the three branches, the
--   walk's bounds and the plan mode are SMD-1464's questions, and one
--   mechanism per migration is the rule.
--
-- What
--   On a heap of at least {{ROUTE_ESTIMATE_MIN_PAGES}} pages (64 MB), a
--   filtered call first reads {{ROUTE_SAMPLE_PAGES}} random pages of
--   `thoughts` through TABLESAMPLE SYSTEM and counts the sampled rows that
--   pass the filter and carry a vector, the distinct pages those rows sit on,
--   and the distinct pages the sample reached. The collection is skipped —
--   the call goes straight to the walk — only when all three hold:
--
--     1. hits x pages >= 10 x v_exact x pages_seen
--        The sample scaled to the table says the filter matches at least ten
--        times the exact threshold. Ten is the bias the ticket asked for: a
--        filter has to look far too broad before the cheap exact branch is
--        given up.
--     2. hits >= 8
--        A floor on the evidence. At ten million rows condition 1 is met by
--        one sampled row (8 pages of some 526,000 are one 65,000th of the
--        table; one hit scales to 65,000, sixty-five times the threshold),
--        and one row is luck. Eight rows from a filter matching exactly
--        v_exact thoughts has probability ~1e-19 there; from one matching 1%
--        of the table, about two in a thousand measured (Cost below: 2 of
--        1,000 draws) — the Poisson figure is two in ten thousand, and
--        SYSTEM's page-level variance is the difference (Design).
--     3. hit_pages >= 3
--        SYSTEM sampling is by page. A filter whose matches sit together on
--        disk — one import, one day's captures, everything with one tag
--        written in one session — shows the sample either a page full of hits
--        or nothing, and a full page (20 rows at the bench's width, 65–80 at
--        the shipped width with short content) passes conditions 1 and 2 on
--        its own. Three different pages means three separate draws landed on
--        the filter; for a contiguous run of v_exact rows that is
--        C(8,3) x (run pages / heap pages)^3: about 1e-5 at the floor,
--        6e-8 at a million rows, 6e-11 at ten million. The layout the three
--        conditions are WEAKEST against sits between uniform and contiguous:
--        a few matches a page over hundreds of pages (a tag on four captures
--        a day for most of a year), where three sampled pages already hold
--        eight hits. For v_exact rows four to a page that is C(8,3) x (250 /
--        heap pages)^3 — about 2e-3 at the floor, 7e-6 at a million rows,
--        7e-9 at ten million. Measured on a 6,826-page heap (the formula
--        says 2.8e-3 there), 995 such rows were skipped 13 times in 20,000
--        draws, 6.5e-4: condition 1 is marginal with exactly three hit pages
--        — twelve hits scale to just over ten times the threshold and fail
--        it whenever the draw reached nine pages or more. `hit_pages >= 4`
--        would take the bound to C(8,4) x f^4, about 6e-5 at the floor
--        (1.3e-4 on the 6,826-page heap, where 4 of 20,000 draws — 2e-4 —
--        were measured), at the price of two to three points of the broad
--        filters' skip rate; that is the knob if the band matters.
--
--   Anything less runs the collection exactly as before this file — the same
--   statement token for token, indented two spaces further inside the IF
--   (db/test-schema.ts [20] compares it with 014's, whitespace collapsed),
--   and the same routing after it. So a filter the gate lets through costs
--   what it always cost plus the sample; a filter the gate skips costs the
--   sample and the walk, minus the bitmap. The exact branch remains the
--   answer for every filter at or under the threshold up to the probabilities
--   above — about 1e-5 or less for uniform or contiguous matches at any
--   size the gate runs at, about 2e-3 for the thin-spread layout at the
--   floor and falling as the cube of the heap — and the measurement below
--   found none
--   in a thousand draws at each of five such filters, and the thirteen above
--   in twenty thousand at the sixth.
--
--   Under the floor nothing changes. The floor is the point where the bitmap
--   can cost more than the sample: at 50 ns a matching row, a heap of
--   {{ROUTE_ESTIMATE_MIN_PAGES}} pages — some 160,000 rows at the bench's
--   width, fewer with long content, more at the shipped width with short
--   content — puts the collection at 4 ms for a 50% filter and 8 for one
--   matching everything, against a sample that costs about 0.15 ms on every
--   filtered call. A brain of a few thousand thoughts, which is every real
--   brain today, never reads the sample; its empty-filter probe stays the
--   one GIN probe 014 made it. The floor and the page count are config.mjs
--   constants (ROUTE_ESTIMATE_MIN_PAGES, ROUTE_SAMPLE_PAGES) templated into
--   this file, so the bench, the tests and this header read one value;
--   they are not operator knobs, and a suite lowers the floor only to reach
--   the gate on a small table.
--
--   The unfiltered path is untouched except for two locals computed at entry
--   (the heap's page count from pg_relation_size, and the sample share) —
--   a few microseconds. search_thoughts_hybrid calls match_thoughts by name
--   and inherits the gate. The signature, the return shape, ROWS 10 and the
--   two SET clauses are 020's and 019's, carried. So are 020's DROP of the
--   4-argument form and its replay of that form's privileges onto the new
--   one: this file is now the last definer of match_thoughts, which is what
--   preflight's remedy and the suites' restoreShipped apply ALONE over a
--   database where an earlier file was re-applied by hand — 014 or 019 put
--   the 4-argument form back beside 020's, and every 4-argument call is then
--   "function is not unique" (test-schema [20]); a REVOKE an operator made
--   on the old form would otherwise come back as the CREATE's defaults
--   ([21]). On a database in order — 020 applied, one function — the DROP
--   finds nothing, the capture reads an empty ACL, and CREATE OR REPLACE
--   over the same signature keeps the function's privileges as they are.
--
-- Design — why a sample, and why this sample
--   * Not the planner's estimate. The ticket offered `pg_class.reltuples x
--     the planner's @> selectivity` first. Measured on a 500,000-row corpus
--     with the bench's metadata shape (EXPLAIN of the predicate, 0.7 ms a
--     call): 297,980 for a filter matching 249,623 rows, 50,505 for 49,994,
--     10,101 for 5,007 — and 50 for every filter under that: 479 rows, 52,
--     895, a 1,000-row cluster and one matching nothing, all 50. jsonb has no
--     per-key statistics; `@>` is priced from the column's most-common WHOLE
--     values, which on the bench's few metadata shapes covers the broad
--     filters and on a real brain, where every row's metadata differs by a
--     timestamp or a title, covers none — every filter gets the default, one
--     per cent of the table. At ten million rows that is 100,000 for a filter
--     matching five, which would send every thin filter to the walk: the
--     opposite of the bias asked for. And it costs five times the sample.
--   * TABLESAMPLE SYSTEM, not BERNOULLI. BERNOULLI decides per row and reads
--     every page; SYSTEM decides per page and reads {{ROUTE_SAMPLE_PAGES}} of
--     them: 0.10 / 0.14 / 0.24 / 0.39 ms of execution for 4 / 8 / 16 / 32
--     pages on the 500,000-row corpus, the same for the 50% filter and the
--     empty one (the cost is the rows read, not the rows that pass). SYSTEM
--     is not free of the heap's size, though: it DECIDES per page by hashing
--     every block number against its cutoff, so the statement carries about
--     2 ns per heap page besides the eight pages' rows — measured with one
--     row a page and every page in shared_buffers, 0.04 ms at 2,000 pages,
--     0.09 at 20,000, 0.46 at 200,000; at ten million rows' 526,000 pages
--     that is the millisecond the
--     bench shows, whatever the buffer pool holds (the "large heap" failure
--     mode below, and SMD-1526). Eight pages: a 10% filter puts sixteen
--     expected hits in 160 sampled rows and was skipped in 908 of 1,000
--     draws, a 50% filter in 984; sixteen pages bought 998 and 1,000 for
--     0.1 ms more on every filtered call, and the empty filter's probe costs
--     0.012 ms, so the sample is already the larger part of that call. The
--     10% misses are mostly draws with fewer than eight hits — SYSTEM picks a
--     binomial number of pages, and two hits a page compound that variance —
--     then, on a heap near the floor, condition 1, and last fewer than three
--     pages (1,109 / 345 / 45 of 1,499 misses in 20,000 draws on a 6,826-page
--     heap). No REPEATABLE seed: a fixed seed reads the same pages every
--     call, which is a warm cache and a systematically wrong sample of a
--     clustered filter; a fresh draw is unbiased.
--   * The hit is `metadata @> filter AND embedding IS NOT NULL`, not the
--     collection's `OR EXISTS (chunk)`. Inside a SELECT-list expression the
--     EXISTS became a hashed subplan — the planner built a hash of the whole
--     chunk table before the sample scan started: 18 ms — where the
--     collection's WHERE-clause EXISTS is an index probe per row that lacks a
--     vector. A thought with chunks and no vector is a row 021's re-embed has
--     not reached; not counting it lowers the estimate, which biases towards
--     running the collection, which counts it (the exact branch's answer is
--     unchanged: [8d]).
--   * The page numbers are `(ctid::text::point)[0]`: core Postgres has no
--     cheaper cast from tid to a block number, and 160 conversions cost under
--     a tenth of a millisecond.
--   * pg_relation_size, not relpages. relpages is a statistic — 0 on a table
--     never analysed (the load path: a bulk import, then queries before
--     autovacuum), which would put the share at 100% and sample the whole
--     heap. pg_relation_size is exact and is one stat() call per segment.
--     to_regclass rather than a `'thoughts'::regclass` literal: the literal
--     binds the OID when the statement is planned and plpgsql caches the
--     plan, so a suite that drops and recreates the table in one session
--     would size a table that no longer exists (NULL, one page, 100%).
--     to_regclass resolves on every call; the cached `FROM thoughts` plans
--     re-resolve only when their relation is dropped, so a relation that
--     SHADOWS the name after the plans are cached — a temp table named
--     thoughts — is what gets sized while the statements still read the
--     real one (measured: 8 pages sized, 25,778 heap blocks sampled at floor
--     0). Under the shipped floor a smaller shadow switches the gate off for
--     that session, which is the safe side; a fresh session sees one table.
--   * The gate is three conditions in plpgsql over three counts from one
--     statement, not a CASE inside the collection: the collection is 014's
--     text and [20] holds it token for token; and a reader of this body should
--     be able to see the rule without reading a query plan.
--
-- Failure modes, each with its cost
--   * An unlucky sample skips a filter at or under the threshold. The call
--     goes to the walk: correct, complete where the walk completes (every
--     tier under 1% of a ten-million-row table was served exactly by the
--     GIN index under the walk branch in SMD-1018's runs), slower (9 ms
--     against 6 for a 900-row filter at a million rows), and at a million
--     rows in the half-to-one-per-cent band it can walk HNSW and return
--     short under the seeded bounds (FORK.md change 28). Probability: for
--     uniformly placed matches, Poisson — at the floor a threshold filter
--     puts one expected row in the sample and needs ten (condition 1), 1e-7;
--     at ten million rows 0.016 expected and needs eight, ~1e-19. For a
--     contiguous run, condition 3's C(8,3) x f^3 above. Measured: 0 of
--     1,000 draws at each of a 895-row uniform filter, a 1,000-row
--     contiguous one, 479 rows, 52, and none, on 500,000 rows.
--   * A count above the default. Every rate and bound above is the default
--     count's, where v_exact is 1,000. v_exact grows with match_count
--     (GREATEST(v_base x 4, 1000): 1,600 at 100, 8,000 at the ceiling of
--     500), and condition 1 grows with it: at the ceiling near the floor it
--     needs about ten hits a page, so a 10% filter is not skipped there at
--     all (measured: 0 of 2,000 draws on a 9,546-page heap, against 97% at
--     the default count) — the collection runs as before this file, plus
--     the sample; the 50% filter is still skipped (98.65%). The contiguous
--     bound scales too: v_exact rows are 400 pages at the ceiling, not 50,
--     so C(8,3) x f^3 is about 6e-3 at the floor (measured 8e-4 on 9,546
--     pages: 16 of 20,000 draws), and a wrongly skipped 8,000-row filter
--     went to the walk, whose direct CTE at LIMIT 2,000 the planner served
--     from the GIN bitmap with a top-N sort — exact, 2,000 rows, in every
--     one of the measured draws. Cost, not answers, in every case run.
--   * The sample runs the collection on a filter that is broad. That is the
--     cost before this file — 5.6 ms for the 10% filter, 12.6 for 50% at
--     500,000 rows — plus about 0.15 ms. It happens by design for a clustered
--     broad filter (a 10,000-row contiguous run was skipped once in 1,000
--     draws: eight pages rarely land on three of the run's 500) and for a
--     moderately broad uniform one (a 5,007-row filter, five times the
--     threshold, twice in 1,000).
--   * The same call, twice, routes two ways at the boundary. The sample is
--     random per call, so a filter near ten times the threshold is
--     collected on one call and walked on the next. Both answers are the
--     function's own — the walk is what the collection would have chosen
--     for a filter that broad — and the function was already STABLE only up
--     to the index's approximation.
--   * A bloated heap. pg_relation_size counts dead and empty pages. Dead
--     tuples on a sampled page mean fewer hits for the same page count: less
--     evidence, more collections. EMPTY sampled pages are the other way:
--     `pages_seen` counts the pages that returned a row, not the pages
--     sampled, so an empty page drops out of the denominator and the scaled
--     estimate is biased UP. A thin filter is still protected by
--     conditions 2 and 3, which do not scale — but on a heap three quarters
--     empty at the floor, v_exact rows are a larger share of what is live,
--     and the uniform bound moves from ~1e-7 to ~3e-5. Empty pages also drop
--     out of hit_pages, so on such a heap condition 3 fails most draws and
--     the BROAD filters get their collection back: measured with the middle
--     three quarters of a 200,000-row table deleted and plain-VACUUMed, the
--     50% filter was skipped in 309 of 1,000 draws and the 10% filter in
--     154 (984 and 960 on the same 200,000-row table before the delete) —
--     the pre-036 cost returns, nothing worse. VACUUM FULL restores the
--     density; SMD-1526's TID-range sample would count sampled pages exactly.
--     A heap that is large in pages but few in rows (long content, TOASTed
--     metadata) reaches the gate at fewer rows, where the collection
--     was cheaper — and pays the sample to learn it. The other direction —
--     short content at the shipped width, 65–80 rows a page — gives the
--     sample four times the rows and the gate four times the evidence, at
--     about two and a half times the per-row cost (~0.35 ms; Cost below).
--   * Wide metadata. A metadata value past the TOAST threshold is detoasted
--     for each sampled row; 160 detoasts. The collection's recheck pays the
--     same per fetched row and always did.
--   * A large heap. The sample's cost grows with the heap — about 2 ns per
--     page for SYSTEM's per-block decision (Design above) — not with what the
--     buffer pool holds: 0.1 ms at 100,000 rows, 0.2 at a million, 1.0–1.1
--     at ten million (the bench, every arm; the empty filter's call went from
--     0.27 ms to 1.31 there), and by that slope some 10 ms at a hundred
--     million, on every filtered call including the empty-filter shape one
--     integration sends on every call. The 50% tier went from 241 ms to 13
--     on the same table, so the trade holds at ten million, but the ticket's
--     "no more than the empty probe costs today" holds only up to about a
--     million rows, and sizing shared_buffers does not change it (the term
--     was measured with every page warm in shared_buffers). The fix is a
--     different
--     sampling statement, not a setting: eight TID range probes — draw eight
--     block numbers and read `ctid >= '(b,0)' AND ctid < '(b+1,0)'` for each,
--     a TID Range Scan since PostgreSQL 14 — cost eight page reads whatever
--     the heap, and count the pages sampled exactly (the bloat bullet). That
--     is SMD-1526; a brain past a million rows that sends the empty filter
--     on every call is the one that wants it.
--   * The table is under the floor. Nothing here runs; the header's Why is
--     the cost, at most a few milliseconds on the broadest filter.
--   * Statistics have nothing to do with it: nothing here reads pg_statistic
--     or reltuples, so a bulk-loaded table that autovacuum has not reached
--     is gated like any other.
--   * A generic plan. plpgsql may plan the sample statement with v_pct as a
--     parameter; the plan is a Sample Scan under an aggregate whichever mode
--     it gets, with no join for an estimate to misprice. In practice the
--     generic plan is never adopted: the planner prices an unknown sample
--     share as 10% of the heap (rows=20,020, cost 9,208 at 10,001 pages,
--     against the custom plan's rows=160, cost 45), and plpgsql keeps custom
--     plans when the generic one costs more than their average — measured
--     through auto_explain on eight consecutive calls, every one custom, no
--     JIT, and no step in latency after the fifth call. bench-hnsw.ts
--     section C explains the statement with the share as a literal, which is
--     the plan the function gets.
--
-- Cost, measured
--   500,000 rows of the bench's shape on this file's development machine
--   (Apple M5 Pro, podman VM, pgvector 0.8.6, execution time from EXPLAIN
--   ANALYZE, median of 40, enable_seqscan off as the function has it):
--
--     the sample, 8 pages                        0.14 ms   any filter
--       (the rows on eight pages — 20 a page here, 160 rows; at the shipped
--        width with short content the vectors are TOASTed and a page holds
--        ~65–80 rows, so the same eight pages are ~600 rows and ~0.35 ms,
--        db/test-live.ts [5d] prints it beside the collection on its table —
--        plus ~2 ns per heap page: 0.05 ms of the 0.14 here, a millisecond
--        at ten million rows; Design and the "large heap" failure mode)
--     the collection, 50% filter (249,623 rows)  12.6 ms
--     the collection, 10% (49,994)                5.6 ms
--     the collection, 1% (5,007)                  1.8 ms
--     the collection, 895 rows                    1.2 ms
--     the collection, 52 rows                     0.25 ms
--     the collection, nothing                     0.012 ms
--     the two locals at entry                     0.005 ms
--
--   Through the function, db/bench-hnsw.ts before and after this file on the
--   same machine (FORK.md change 68 has the tables; section C prints the
--   sample's own cost beside the collection's at every scale): the 50% tier
--   241 ms → 13 at ten million rows and 36.5 → 10.4 at a million, the 10%
--   tier 138 → 45 and 47 → 37, the thin tiers unchanged but for the sample
--   (within the pass-to-pass spread at a million rows, about a millisecond
--   more at ten million), the empty filter 0.21 → 0.43 ms at a million rows
--   and 0.27 → 1.31 at ten million (the per-page term — the "large heap"
--   failure mode above).
--
-- What a successor must carry
--   019's list, unchanged — `SET hnsw.iterative_scan = relaxed_order`, `SET
--   enable_seqscan = off`, `ROWS 10`, the `ob1:filter-inside-scan` sentinel
--   in the body, the pgvector floor line; 020's DROP of the 4-argument form
--   with the ACL capture before it and the replay after (above: the last
--   definer is applied alone); and, if it keeps the gate, the two template
--   constants — a redefinition that pastes this body with the literals baked
--   in still works, and then drifts the day config.mjs moves — and the
--   estimate as ONE statement over locals declared at entry (v_pages, v_pct
--   with the constants inline), which test-support's routingAt and
--   extractBody read for test-schema [8e] and bench-hnsw.ts section C. A
--   successor
--   that removes the gate should say why in its header and expect FORK.md
--   change 68's tables to come back.
--
-- Prerequisites
--   Migration 020 (the signature this file redefines). pgvector 0.8.0 or
--   later, as 014. Applied by `bun db/migrate.ts`.
--
-- Expected outcome
--   `match_thoughts` returns what 020's returned for every call, up to the
--   skip probabilities under Failure modes (a wrongly skipped thin filter
--   gets the walk's answer, correct where the walk completes); on a heap of
--   {{ROUTE_ESTIMATE_MIN_PAGES}} pages or more, a filter matching a large
--   share of the table no longer pays for a bitmap over every matching row
--   before the walk begins, and the call's latency drops by that share
--   (db/bench-hnsw.ts sections B and C, before and after). pg_proc.prosrc
--   carries the sentinel, TABLESAMPLE SYSTEM and the two constants;
--   db/test-schema.ts [8e] and db/test-live.ts [5d] hold the gate.
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
  -- The gate on that collection (036). The heap's size in pages, exact and
  -- cheap (pg_relation_size is a stat of the main fork; to_regclass resolves
  -- the name on every call, so a cached plan never holds a dropped table's
  -- OID — the header says what a temp table shadowing the name does), and
  -- the share of it that puts
  -- {{ROUTE_SAMPLE_PAGES}} pages into the sample. Both are computed at entry
  -- — a few microseconds, on the unfiltered path too — so the estimate
  -- statement below stands alone with its locals substituted, which is how
  -- db/bench-hnsw.ts section C reads it out of the catalog.
  v_pages      bigint  := GREATEST(pg_relation_size(to_regclass('thoughts')) / current_setting('block_size')::int, 1);
  v_pct        float   := LEAST(100.0, 100.0 * {{ROUTE_SAMPLE_PAGES}} / v_pages);
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
  -- broadest and the empty filter for that reason. Since 036 that collection
  -- is gated: on a heap of {{ROUTE_ESTIMATE_MIN_PAGES}} pages or more, a
  -- sample of {{ROUTE_SAMPLE_PAGES}} pages is read first, and when it shows
  -- the filter matching far more than v_exact thoughts the collection is not
  -- run at all — the walk is the answer for such a filter, and the bitmap it
  -- would have built costs the number of matching rows (this file's header
  -- has the measurement and the three conditions). At most v_exact matching:
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
    -- The gate (036). On a heap large enough for the collection below to cost
    -- more than a sample of it, read {{ROUTE_SAMPLE_PAGES}} random pages —
    -- TABLESAMPLE SYSTEM picks whole pages, so the read is a handful of
    -- buffers whatever the table holds, plus ~2 ns a heap page for the
    -- per-block decision (the header's Design and "large heap" bullets) —
    -- and count the rows that pass the filter and carry a vector, the pages
    -- those rows sit on, and the pages the sample reached. A row with a
    -- vector, not the collection's "vector or chunks": the EXISTS probe
    -- inside an expression became a hashed
    -- subplan over the whole chunk table (18 ms measured, against 0.15 for
    -- the sample), and counting fewer scoreable rows than there are only
    -- biases the gate towards running the collection, which is the safe
    -- side. The page numbers come from ctid; SYSTEM sampling is by page, so
    -- a filter whose matches sit together on disk shows up as one page full
    -- of hits or none, and the third condition below is what catches that.
    IF v_pages >= {{ROUTE_ESTIMATE_MIN_PAGES}} THEN
      SELECT count(*) FILTER (WHERE s.hit), count(DISTINCT s.blk) FILTER (WHERE s.hit), count(DISTINCT s.blk)
        INTO v_hits, v_hit_pages, v_pages_seen
      FROM (
        SELECT (t.metadata @> filter AND t.embedding IS NOT NULL) AS hit,
               (t.ctid::text::point)[0] AS blk
        FROM thoughts t TABLESAMPLE SYSTEM (v_pct)
      ) s;
      -- Skip the collection only when all three hold: the sample, scaled to
      -- the table (hits x pages / pages seen), puts the filter at ten times
      -- the exact threshold or more; at least eight sampled rows passed, so
      -- one or two lucky rows on a huge table cannot decide; and they sit on
      -- at least three different pages, so one page of clustered matches
      -- cannot either. Anything less runs the collection, as before 036: a
      -- filter the gate lets through costs what it always cost, a filter it
      -- wrongly skipped would go to the walk, which is correct but slower
      -- for a thin filter and, at a million rows, can return short — so the
      -- rule is built to make the second mistake rare (the header has the
      -- arithmetic, the measured rates, and the one layout it is weakest
      -- against).
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
