# 80. The gate's sample is drawn by TID range — migration 038 reads its eight pages as eight TID Range Scans instead of a `TABLESAMPLE SYSTEM` over the whole heap, so the sample costs eight page reads at any size and counts the pages it drew (SMD-1526)

Change 70 ended on a term that grows with the table, and this removes it.
Migration 037 gates the routing count behind a sample of the heap: `FROM
thoughts t TABLESAMPLE SYSTEM (v_pct)` with the share sized to eight pages.
`SYSTEM` decides page by page over the *whole* heap — it hashes every block
number against its cutoff — so the statement carried about 2 ns per heap page
besides the eight pages' rows: a millisecond at ten million rows (526,000
pages) on every filtered call, whatever the buffer pool held. The empty-filter
shape one integration sends on every call went from 0.27 ms to 1.31 in change
70's bench, and by the slope a hundred million rows would pay some 10 ms.
Change 70's third finding measured the term, its header named this statement
as the fix, and SMD-1526 filed it with a second, smaller defect from the same
statement: `pages_seen` counted the distinct pages among the rows *returned*,
so a sampled page with no live row — a mass delete and a plain `VACUUM` leave
them — dropped out of the denominator and the scaled estimate was biased up.

**Migration 038.** The gate is 037's — the same floor, eight pages, three
conditions over three counts, the collection wrapped in the same `IF` — and
only the statement that produces the counts changes:

```sql
SELECT count(*) FILTER (WHERE p.hit), count(DISTINCT b.blk) FILTER (WHERE p.hit), count(DISTINCT b.blk)
  INTO v_hits, v_hit_pages, v_pages_seen
FROM (SELECT DISTINCT floor(random() * v_pages)::bigint AS blk FROM generate_series(1, 8)) b
LEFT JOIN LATERAL (
  SELECT (t.metadata @> filter AND t.embedding IS NOT NULL) AS hit
  FROM thoughts t
  WHERE t.ctid >= ('(' || b.blk || ',0)')::tid
    AND t.ctid <  ('(' || b.blk + 1 || ',0)')::tid
  LIMIT 291
) p ON true;
```

Eight block numbers are drawn from the heap's page count (`v_pages`, 037's
local, still computed at entry from `pg_relation_size`), made distinct, and
each is read as one TID range — every tuple of block *b* and nothing else, a
TID Range Scan (PostgreSQL 14 and later), one page read per block whatever the
heap holds. The rows on those pages are counted as 037 counted them, and the
third count is now the distinct blocks *drawn*: the `LEFT JOIN` keeps a block
that returned no row, which is the denominator the rule always meant. `v_pct`
goes; it was `TABLESAMPLE`'s argument. Everything else is carried token for
token — the rule, 014's collection ([20] compares it), 019's clauses, the
sentinel, the two template constants, and 020's `DROP` of the 4-argument form
with its ACL replay, since 038 is now the last definer that preflight's remedy
and the suites' `restoreShipped` apply alone (test-upgrade [16] holds it).

**Why this statement, and what the ticket's sketch got wrong — prototyped on
a real Postgres before the file was written.**

- *The probe needs a `LIMIT`, and it does two jobs.* The ticket's sketch was a
  `VALUES`/`generate_series` of the blocks joined `LATERAL` to the range probe.
  Written that way the planner pulls the `LATERAL` up into the join, the
  `ctid` bounds become *join* quals, and the TID Range path — which reads a
  relation's own restrictions only — is never built: the plan was a
  sequential scan of the whole heap under `Materialize`, cost 10,000,002,844
  under 019's `enable_seqscan = off`, 72 ms at 2,000 pages and 632 at
  200,000. A `LIMIT` on the probe keeps it a subquery (a subquery with a
  `LIMIT` is never pulled up), and 291 — `MaxHeapTuplesPerPage` on an 8 KB
  page — is a value no block can exceed, so it never cuts a page. It also
  caps the planner's estimate: the planner cannot see a bound that is an
  expression over another relation's column, prices the range at half a per
  cent of the heap, and uncapped that would put the eight probes at tens of
  thousands of cost units at ten million rows, within reach of
  `jit_above_cost` (100,000) on a larger heap — where JIT compiles the
  statement on every execution, the 50 ms a call change 70's third finding
  met. Capped, each probe is priced at 291 rows at most: the statement costs
  107 / 849 / 2,405 units at 2,000 / 20,000 / 200,000 pages and is flat
  from there. A build with 32 KB pages could hold more tuples on a dense page
  than the `LIMIT` admits; the count would then be short and the collection
  run — the safe side.
- *The draw is inside the statement, not in plpgsql.* The sketch drew the
  blocks in plpgsql. A `DISTINCT` subquery over `generate_series` costs no
  extra SPI round trip at entry (the unfiltered path still pays for `v_pages`
  alone, as under 037), keeps the estimate one statement over locals declared
  at entry — which is what `extractBody` and `routingAt` read for the bench,
  and what test-schema [8e] reads out of `pg_proc` to run against its own
  table — and is never pulled up either. `random()` in a target list
  is evaluated once per row of `generate_series` (the once-only trap is a
  scalar subquery, an InitPlan, which change 70 met loading its fixture);
  `DISTINCT` collapses a block drawn twice so no page is read or counted
  twice; the block is a `bigint`, since an `int` draw would overflow past 2³¹
  pages (a 16 TB heap — academic, and the wider cast is free).
- *Plan mode, which 037's statement lost on.* Both plan modes price the new
  statement alike — the bounds are column references under either — so
  plpgsql adopts the generic plan after the fifth call and never replans.
  Measured through a plpgsql wrapper on a 200,000-page heap: a few
  hundredths of a millisecond a call over the round trip in the default mode
  (0.01–0.09 across rounds, against a round trip of 0.2–0.3), 0.14–0.22
  under `force_custom_plan` (the replan), and 0.5–0.7 for 037's statement, which was priced 200× cheaper
  custom than generic and so replanned on every call. One plan, cached, eight
  page reads — while the paths the plan is built from are enabled. Turn one
  off at session, role or database level (`enable_tidscan`, `enable_nestloop`,
  or `enable_hashagg` and `enable_sort` together) and the planner still picks
  the same plan but adds `disable_cost`, 1e10, which carries the statement
  past every JIT threshold: the sample is compiled on every call, 41 ms
  against 0.46 on a 1,191-page heap, with the same plan node, the same eight
  buffers and nothing in preflight or the ledger to show it (review pass 3).
  The tidscan and nestloop sensitivities are new with 038 — 037's Sample Scan
  had neither a join nor a TID path — and the hashagg-and-sort one is 037's
  too (85 ms against 81). A function-level `SET jit = off` removes all three
  (measured) but also changes what the walk pays under a generic plan, which
  is SMD-1464's question; pinning the two `enable_*` GUCs on the function
  overrides an operator's setting for the walk as well. The decision was
  SMD-1624 (done: migration 040, change 91 — `SET jit = off` on the
  function); 038's header states the premise. Row-level security on `thoughts`
  is a fourth trigger, and the one operators actually set: `jsonb_contains`
  is not leakproof, so under a policy `metadata @> filter` cannot be an index
  qual and 014's collection and the walk's direct CTE become sequential scans
  at `disable_cost`, JIT-compiled — 150 ms against 7 on 25,000 rows — since
  014/019 and unchanged by 038, whose TID bounds are leakproof (the probe
  keeps its plan; the policy undercounts its hits, the safe side). That is
  SMD-1625.
- *The bounds are text-built tids* (`'(b,0)'::tid` is at or below every
  tuple of block *b*, offsets starting at 1; `'(b+1,0)'` above them) because
  core Postgres has no constructor from a block number; the executor clamps
  a bound past the heap, so the last block's upper bound and a block the heap
  no longer has read nothing, cost nothing, and still count among the pages
  drawn — the safe side.
- *Not* `tsm_system_rows` (an extension the function would depend on — PGlite,
  where test-schema runs, does not ship it — with rows rather than pages as
  the unit and the `pages_seen` defect unchanged); *not* eight statements in
  a plpgsql loop (eight plans and eight SPI calls where one does; eight
  literal arms planned in 0.07–0.1 ms a call); *not* the planner's `@>`
  estimate, for change 70's reasons.

**The statement alone, one row a page, every page warm in the OS page cache**
(the 20,000- and 200,000-page heaps exceed the image's 128 MB `shared_buffers`)
(`EXPLAIN ANALYZE` execution time, median of 30, `enable_seqscan` off as the
function has it; change 70's first review pass measured 037's the same way):

| heap pages | 037's sample (`TABLESAMPLE SYSTEM`) | 038's (eight TID ranges) |
| ---: | ---: | ---: |
| 2,000 | 0.036 ms | 0.034 ms |
| 20,000 | 0.075 | 0.048 |
| 200,000 | 0.469 | 0.052 |

The fourth review pass re-ran both on a fresh container with its own code:
038 0.029 / 0.049 / 0.054, 037 0.027 / 0.071 / 0.433; the planner costs 107 /
849 / 2,405 and the absence of JIT reproduced exactly.

**The rule, re-measured for this draw** — 1,000 draws per filter on a
500,000-row corpus of the bench's shape (24,999 pages, twenty rows a page,
`v_exact` 1,000), 037's statement on the same corpus and the same draws'
worth in brackets:

| filter | matching rows | placement | skipped, 038 | skipped, 037 |
| --- | ---: | --- | ---: | ---: |
| 50% | 249,851 | uniform | 1,000 | 984 |
| 10% | 49,829 | uniform | 987 | 901 |
| 10,000 rows | 10,000 | one contiguous run | 0 | 1 |
| 1% | 4,915 | uniform | 1 | 1 |
| 2,000 rows | 1,882 | uniform | 0 | 0 |
| 1,000 rows | 1,000 | one contiguous run | 0 | 0 |
| 1,000 rows | 1,000 | four a page over 251 pages | 0 | 0 |
| 900 rows | 858 | uniform | 0 | 0 |
| 0.1% | 504 | uniform | 0 | 0 |
| 0.01% | 58 | uniform | 0 | 0 |
| nothing | 0 | — | 0 | 0 |

Every filter at or under the threshold ran the collection every time over
1,000 draws, on this corpus and on one just under the floor (163,840 rows,
8,191 pages: 50% skipped 1,000 and 10% 979 of 1,000 there in one run, 961 in
a re-run — a knife-edge tier, ten hits needed of a mean sixteen — against 993
and 905, 983 and 884 re-run; the contiguous 10,000 was skipped 10 times
against 037's statement's 13, not a wrong answer at ten times the threshold).
Every bracketed 037 figure is one run; a re-seeded re-run moved them by up to
two sigma (984 → 975 on the 50% filter, 337 → 296 on the bloated heap) with
every comparison keeping its direction.
The broad filters are skipped a little more often than under 037, because the
draw always reaches its pages: `SYSTEM` took a binomial number of pages with
mean eight and reached fewer than three about 1.4% of the time (e⁻⁸ × 41) —
the misses test-live [5d] widened its band for — where eight draws with the
duplicates collapsed reached eight distinct pages in all but a few of a
thousand at the floor (the fewest seen: 7 in 1,000 draws, 6 in 20,000). The
thin-spread layout, the one condition 3 is weakest against, was skipped 29
times in 20,000 draws at the floor — 1.45e-3, which is what change 70's
formula computes — C(8,3) × (251 / 8,191)³ = 1.6e-3 as a union bound, 1.44e-3
exact (a re-run: 34 in 20,000). 037's statement, re-run
on this heap, was skipped only 14 times in 20,000 — under the formula's 32 —
because `SYSTEM`'s variance made condition 1 fail whenever its draw reached
ten pages or more (twelve hits on nine pages still scale to 10.9× the
threshold here; on 037's 6,826-page heap the cut was nine pages, which is
where its header's 13 in 20,000 came from); that accident is gone, the bound
is the formula's and falls as the cube of the heap (7e-6 at a million rows,
7e-9 at ten million), and `hit_pages ≥ 4` remains the knob if the band
matters. At the ceiling count (`v_exact` 8,000) the picture is change 70's:
near the floor the 10% filter is never skipped (0 of 2,000; 037: 0) and the
50% filter about half the time (1,169 of 2,000; 037: 1,212), so the
collection runs as before 037 plus the sample. On a heap three quarters empty
— the 500,000-row corpus with its middle deleted and plain-`VACUUM`ed, 6,250
live pages of 24,999 — the broad filters get their collection back for want of
hits under both statements alike (50% skipped 332 of 1,000 against 337, 10%
126 against 132, the thin filters 0), and the denominator is now honest:
condition 1 failed in 105 of the 50% draws under 038 where under 037 it
failed in none, because 037's `pages_seen` had shrunk to the two pages that
answered and scaled twenty hits to the whole heap.

**Through the function, before and after, on the machine change 28 describes**
(`db/bench-hnsw.ts`, the before pass as `OB1_BENCH_UPTO=037` — the function
with 037's sample — and the after pass with 038, from one tree, on the same
day). The machine was busier than for change 70's tables: seven other
Postgres containers held the VM's memory throughout, and the before arm's
own figures sit above change 70's for the same 037 body at every tier (the
empty filter 1.05 ms at a million rows against 0.43 then), so read the
million-row columns as a pair and not against change 70's. At ten million
the two columns are two machines: the before pass ran under that load (its
50% tier 132 ms against change 70's 13 for the same 037 body — the walk
reading the index from disk), while the after pass — started three times
and stopped three times mid-build, twice by the VM's OOM killer with two
other sessions' benches resident, a kept ten-million corpus among them, once
when the server dropped the connection under the same pressure — ran on the
fourth attempt six hours later
on the idle VM change 70's own passes had, and its column sits within the
spread of change 70's 037 figures everywhere but the rows this change is
about (50% 13.2 then, 14.4 now; 900 rows 10.9 and 11.1). Section B, ten
asked, median over 50 random queries:

| rows | filter | matching rows | 037: in exact top-10 | median ms | 038: in exact top-10 | median ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000,000 | 50% | 499,443 | 3.0 | 20.16 | 3.0 | 14.87 |
| 1,000,000 | 10% | 99,748 | 5.5 | 63.47 | 5.4 | 53.62 |
| 1,000,000 | 1% | 9,951 | 8.9 | 426.32 | 8.8 | 328.66 |
| 1,000,000 | 5,000 rows | 4,916 | 10.0 | 31.93 | 8.6 | 399.43 |
| 1,000,000 | 2,000 rows | 1,963 | 10.0 | 16.98 | 8.5 | 559.51 |
| 1,000,000 | 0.1% | 1,034 | 10.0 | 11.73 | 10.0 | 9.33 |
| 1,000,000 | 900 rows | 934 | 10.0 | 10.26 | 10.0 | 7.81 |
| 1,000,000 | 0.01% | 99 | 10.0 | 2.38 | 10.0 | 1.39 |
| 1,000,000 | nothing | 0 | 0.0 | 1.05 | 0.0 | 0.34 |
| 10,000,000 | 50% | 4,998,406 | 0.9 | 132.40 | 0.7 | 14.42 |
| 10,000,000 | 10% | 999,827 | 2.1 | 387.55 | 1.9 | 49.88 |
| 10,000,000 | 1% | 99,633 | 5.5 | 2,608.58 | 5.3 | 425.48 |
| 10,000,000 | 0.1% | 10,231 | 10.0 | 115.04 | 4.2 | 914.71 |
| 10,000,000 | 5,000 rows | 5,088 | 10.0 | 63.11 | 10.0 | 55.80 |
| 10,000,000 | 2,000 rows | 1,978 | 10.0 | 36.98 | 10.0 | 33.14 |
| 10,000,000 | 900 rows | 886 | 10.0 | 13.91 | 10.0 | 11.09 |
| 10,000,000 | 0.01% | 959 | 10.0 | 15.51 | 10.0 | 12.13 |
| 10,000,000 | nothing | 0 | 0.0 | 1.67 | 0.0 | 0.36 |

Section C, the two statements themselves, extracted from the deployed body and
explained (execution time under a forced custom plan / a forced generic plan /
generic with JIT off; the 10,000-row rows are the sanity passes both arms ran
first, five queries):

| rows | statement | filter | matching rows | 037: ms | 038: ms |
| ---: | --- | --- | ---: | ---: | ---: |
| 10,000 | route | 50% | 5,041 | 0.60 / 0.54 / 0.65 | 0.68 / 0.63 / 0.72 |
| 10,000 | estimate | 50% | 5,041 | 0.10 / 0.10 / 0.08 | 0.12 / 0.08 / 0.09 |
| 10,000 | estimate | 0.01% | 1 | 0.11 / 0.14 / 0.10 | 0.14 / 0.10 / 0.08 |
| 10,000 | estimate | nothing | 0 | 0.12 / 0.08 / 0.04 | 0.08 / 0.07 / 0.12 |
| 1,000,000 | route | 50% | 499,443 | 35.09 / 33.41 / 33.67 | 28.13 / 29.54 / 27.70 |
| 1,000,000 | route | 0.01% | 99 | 0.65 / 1.07 / 0.73 | 0.65 / 0.68 / 0.71 |
| 1,000,000 | route | nothing | 0 | 0.05 / 0.04 / 0.07 | 0.03 / 0.04 / 0.03 |
| 1,000,000 | estimate | 50% | 499,443 | 0.25 / 0.31 / 0.30 | 0.12 / 0.10 / 0.11 |
| 1,000,000 | estimate | 0.01% | 99 | 0.30 / 0.22 / 0.25 | 0.09 / 0.08 / 0.09 |
| 1,000,000 | estimate | nothing | 0 | 0.32 / 0.36 / 0.27 | 0.10 / 0.10 / 0.10 |
| 10,000,000 | route | 50% | 4,998,406 | 297.21 / 316.29 / 283.95 | 278.63 / 317.77 / 284.75 |
| 10,000,000 | estimate | 50% | 4,998,406 | 1.17 / 1.14 / 1.15 | 0.12 / 0.10 / 0.10 |
| 10,000,000 | estimate | 900 rows | 886 | 1.10 / 1.13 / 1.20 | 0.11 / 0.12 / 0.10 |
| 10,000,000 | estimate | nothing | 0 | 1.20 / 1.12 / 1.14 | 0.10 / 0.09 / 0.09 |

Read down the tables and three things fall out.

- **The sample's cost is flat, and the empty filter has its cost back.** The
  `estimate` row reads 0.07–0.14 ms at 10,000 rows, 0.08–0.12 at a million
  and 0.09–0.12 at ten million under 038, the same three columns for the 50%
  filter, a thin one and the empty one — against 037's 0.04–0.14, 0.22–0.36
  and 1.10–1.20 (that last from the loaded before pass; 0.94–1.11 on the
  idle machine across change 70's two passes, so load barely moved that
  row): the 2 ns a page, gone. That is the ticket's first check (within a
  factor of two across the three scales; it is within 1.6 for any one filter
  and plan mode, 2.0 across the widest pair of cells, 0.07 and 0.14). Through
  the function the empty filter at ten million rows costs 0.36 ms — 0.27
  before 037 in change 70's pass, 1.31 under 037 there and 1.67 under 037
  today — which is the ticket's second check, within 0.1 ms of the pre-037
  figure; at a million rows 0.34 in this pair (1.05 under 037 today, 0.43 in
  change 70's pass, 0.21 before 037). The standalone table above says the
  same thing without a bench: 0.052 ms at 200,000 pages against 0.469.
- **The broad tiers lose the collection on every call now.** 50% at a
  million: 20.2 ms → 14.9, 10%: 63.5 → 53.6, with the recall columns
  unchanged (3.0 and 5.4–5.5, the index's own); the `route` rows are the same
  statement at the same cost (35 → 28 ms is the day's cache), so the
  difference is the calls that no longer run it — 037 skipped the 10% filter
  nine times in ten, 038 987 in a thousand. The thin tiers moved by the
  sample's saving and the spread (900 rows 10.3 → 7.8, 0.01% 2.4 → 1.4).
- **The planner's coin, on three more tiers.** At a million rows the 2,000-
  and 5,000-row tiers were served from GIN under the walk branch in the
  before pass (10.0 of 10 at 17 and 32 ms) and walked HNSW in the after pass
  (8.5 and 8.6 at 560 and 399 ms); at ten million the 0.1% tier did the same
  (10.0 at 115 ms, then 4.2 at 915), while the 1% tier walked HNSW in both
  passes at both scales. Every one of those tiers is above the threshold and
  routed to the walk by both arms — the gate cannot skip them (condition 2
  needs eight hits, and 160 sampled rows at 0.1–0.5% hold well under one)
  and cannot choose the walk's plan, which section E shows flipping under
  the seeded bounds on the same rows (17 ms and 10.0 against 577 ms and 8.5
  at a million; 851 ms and 4.2 against 206 ms and 10.0 with `ef_search`
  raised at ten million). Change 70 met the same flip on the 1% tier between
  its own passes under a fresh `ANALYZE`; it is SMD-1464's band, with three
  more rows for it.

**What it costs where it does nothing.** Under the floor — every real brain
today — nothing changes: the body computes `v_pages` at entry as under 037 and
runs no sample. Above it, every filtered call pays eight page reads: about
0.05 ms warm with one row a page, about 0.3 at the shipped width's 65–80
rows a page, eight random reads from disk on a heap larger than memory (on
the order of 0.1 ms each on NVMe, more on network storage), and nothing that
grows with the heap.

**Not done here.** Preflight still has no recogniser for the gate's body (a
037 or a 020 pasted over 038 passes the `filtered search` check; the
operator's path below), as change 70 said — a sentinel of the gate's own is
the line for the next preflight change. The threshold, the plan mode of the
*walk* statement (which flips onto a generic plan under a recency weight at
the ceiling and changes answers; change 70's "Not done here") and the seeded
bounds are SMD-1464; `ef_search` on real vectors SMD-1465. The `hit_pages ≥
4` knob is stated, not turned. The disabled-path JIT premise was SMD-1624 (done: migration 040, change 91); row-level security, which has cost `@>` its index since 014 and is a fourth trigger of the same JIT, is SMD-1625. A hundred million rows was not run, for the
reasons change 28 gives; what this change establishes is that the sample's
cost no longer depends on it. The bench's before arm (`OB1_BENCH_UPTO=037`)
does not combine with a kept corpus — change 72's rule: a corpus built under
a schema cut at a migration is measured and dropped, never kept — so a kept
ten-million corpus at 037 is not this change's before arm; the ten-million
passes here were built fresh, and the after pass's four attempts are the
tables' paragraph.

**Verified, on the merged tree:** `db/test-schema.ts` 901/901 under PGlite, [8e] rewritten (the
TID range probe, the three load-bearing tokens — `DISTINCT`, `LEFT`, `LIMIT
291` — no `TABLESAMPLE` in the body, the floor, exactness with the gate
reached; then the statement read out of the installed body, on a compacted
heap of some sixteen pages: five draws judged by the rule and each reaching
two to eight pages, its plan TID Range Scans with no sequential scan and no
Materialize, one block drawn eight times over reporting one page and its rows
counted once — the `DISTINCT` — and, an eight-block band emptied and vacuumed
with live rows beyond it, the probe pinned to that band reporting eight pages
drawn, no hit and eight buffers touched — the `LEFT` join and the `<` bound —
where an INNER join reports none and a `<=` bound reads sixteen) and [20]'s
definer pin moved to 038;
`db/test-live.ts` 500/500 on real Postgres, [5d] now exact (the broad filter
makes exactly one GIN scan fewer per call than under 020's body, twenty of
twenty, each call on its own connection — PR #69's first CI run failed this
section at 020 2.00 a call against 038 1.50 where the same tree read 2.75 and
1.75 locally and 2.00 and 1.00 on a freshly reset schema: on one connection
plpgsql plans the first five calls custom and may switch the walk to a
generic plan from the sixth, the two plans scan the GIN index a different
number of times through the chunk join, and the arms' trajectories need not
cancel; a first execution per call gives every call the same plan on both
arms, and the failure message now prints the per-call counts; 0.27–0.33 ms a
call for the sample on its
386-page heap at the shipped width, round trip included); `db/test-upgrade.ts`
189/189, [16] new (038 onto a populated 037: no column, signature, row or
privilege moves; 014 re-applied by hand, then 038 alone, leaves one form);
`server-portable` `tsc --noEmit` and `test-preflight.ts` (205/205) clean;
`bun scripts/check-fork-consistency.mjs` PASS; `bench-hnsw.ts` before and
after at a million rows and at 10,000 (both arms' estimate rows: 037's a
`Sample Scan`, 038's a `Tid Range Scan`) and at ten million rows (the after
pass on its fourth attempt, the VM idle), above.

**Review** — five passes, two reviewers each, triaged fix / ticket / no;
the stop signal (a pass's top findings in the previous pass's own additions)
came at pass 2 and again at 4, the later passes at the user's call. What
changed the change: test-schema [8e]'s behavioural checks had run a copy of
the statement kept in the test, so an INNER join, a missing `LIMIT` and a
constant block all passed them and were caught by regexes alone — [8e] now
runs the statement read out of `pg_proc`, on a fixture vacuumed before the
load (its "emptied middle half" had been pages earlier sections left empty),
pins the probe to eight emptied blocks (an INNER join reports none drawn),
draws one block eight times over (without `DISTINCT` the hits come back
eightfold), asserts the plan (without the `LIMIT`, `Materialize` over `Seq
Scan`) and the probe's eight buffers from the scan node's own line (a `<=`
bound reads sixteen); the mutants were run and each is killed by the
assertion that names it. test-live [5d] compares raw scan counts (IEEE gets
x/20 − y/20 wrong for 52 exact deltas). What changed the documents: the
"no JIT at any size" premise (a disabled planner path adds `disable_cost`
and JIT-compiles the sample on every call, 41 ms against 0.46 — SMD-1624, the
decision between `SET jit = off` and pinning the paths, since either touches
the walk; done: migration 040, change 91); row-level security as a fourth trigger, pre-existing since 014
(`jsonb_contains` is not leakproof, 150 ms against 7 — SMD-1625); "every
page in `shared_buffers`" corrected to the OS page cache (the larger two
heaps never fit the image's 128 MB; change 70's sentence carried the same
error); the knife-edge 10% tier at the floor (979 one run, 961 the re-run);
a handful of figures quoted tighter than their spread, and the header's
first-screen block for a paged operator. What was verified without change:
the planner account re-derived from source; every header number reproduced
on a fresh container with fresh code (costs and the absence of JIT exactly,
the rates within binomial noise, the bloated heap to the digit); the
deployer's paths through `migrate.ts` including a non-superuser owner;
preflight with pasted-over bodies; the PostgREST contract byte-identical;
restricted and read-only callers; 14,000 calls under concurrent truncation
and growth; both temp-table shapes; the suites green on PostgreSQL 15, 16
and 17 with the probe planning as eight TID Range Scans on each; [8e]
flake-free over twenty runs and [5d]'s exact band over 180 isolated
iterations (3,600 calls), where 037's body missed in 6 of 30 iterations of
twenty calls — the ~1.4% per draw the header attributes to it. Filed and not fixed here: SMD-1624, SMD-1625,
SMD-1627 (`--reapply` rebuilds a missing HNSW index in dynamic shared memory
and fails under a 64 MB /dev/shm; a non-superuser cannot bootstrap where
pgvector is not trusted — both pre-existing). test-live [7] flaked six times
across the passes — four with another suite in the worktree, twice alone —
and passed on every re-run: SMD-1545's, with the concurrent-suite lead
weakened accordingly. Boyscout, after the passes: one exported `TID_PROBE`
(both bounds) where three files had their own, [8e]'s FROM clause read once
and a tautological bound dropped, two helper comments reworded for two
migrations, test-upgrade [14]'s title naming the schema it applies, the
header's cost table stated once — no behaviour change; and a second look
after CI: the body comment above the sample statement trimmed to the
mechanism, its measurements left to the header; and a third: one place in
`test-support` reads the sample statement out of a body (`SAMPLE_STATEMENT`,
`sampleStatementOf`) for [8e]'s draws and [5d]'s timing, so the last kept
copy of the statement is gone; `buffersOf` reads one node's Buffers line when
given the node; `extractBody` ignores comment lines before it looks for the
estimate.

**The operator's path, walked.** A brain at 037 with rows, upgraded by `bun
db/migrate.ts`: "038 applied, 1 applied, 37 skipped", one `match_thoughts`
carrying the TID range probe and no `TABLESAMPLE`, a filtered call answering
as before. The same brain with 037's file pasted over 038 by hand: the plain
run reports "applied 0, skipped 38" — the ledger records both and cannot see
the body — and what is lost is the per-page term coming back, a degradation
preflight's stated scope does not cover (change 70's paragraph); `migrate.ts
--reapply` re-runs every file in one transaction and the probe is back. The
PostgREST contract — six argument names, the `RETURNS TABLE` shape — is
byte-identical to 020's. The README's bench command with `OB1_BENCH_UPTO=037`
labels its arm `after (014–037)` and explains 037's estimate as a sample scan;
the default labels `after (014 on)` and explains 038's as a TID range scan.

**Upstream status:** not applicable — 014's routing statement and 037's gate
are this fork's.
