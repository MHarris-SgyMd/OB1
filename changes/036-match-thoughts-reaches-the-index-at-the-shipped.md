# 36. `match_thoughts` reaches the index at the shipped width — and both search functions say how many rows they return

Migration 019 and `db/bench-plan.ts` (Linear SMD-969 and SMD-1041; upstream
[#469](https://github.com/NateBJones-Projects/OB1/issues/469)). The upstream
issue reports that even the plain `match_thoughts` shape gets `Seq Scan` +
`Sort` at ~9,300 rows and only `SET LOCAL enable_seqscan = off` makes the
planner take `thoughts_embedding_idx` — 5.9 s and ~30,000 buffers a call
against 180 ms and ~3,200. Its headline is about `match_thoughts_recency`,
which this fork does not ship (SMD-945, change 37, ships the
candidate-then-rerank shape the issue arrives at, inside `match_thoughts`). The half that applied here had never been
measured: change 28's bench explains only the filtered branches, at 64
dimensions, and `db/test-live.ts` [5] asserted the index is *reachable* with
sequential scans disabled, which is a different question from whether it is
*chosen*. The fork's rule is that a plan is measured, not inferred (change
24), so it was measured, at 1,024 dimensions.

**The planner does not choose it where the heap is small — which is every
brain up to some tens of thousands of thoughts — and the chunk table is the
half that matters.** `db/bench-plan.ts`: random unit vectors, one thought in
five with a chunk row, the unfiltered branch's own statement read from the
catalog and explained under `EXPLAIN (ANALYZE, BUFFERS)` at 1,000, 10,000 and
100,000 rows. At 10,000 rows and the default count the `thoughts` CTE is an
index scan and the chunk CTE a **sequential scan** of 2,000 rows that touches
13,000 buffers — the whole statement 5.3 ms against 1.8 with the index. Above
the default count both sides scan: 28.8 ms and 80,317 buffers at match_count
50, against 6.5 ms and 11,143. At 1,000 rows everything seq-scans at every
count. At 100,000 rows the heap alone is ~1,500 pages, the estimate turns, and
the planner takes the index at the counts callers send on its own — and still
seq-scans at the ceiling, a million buffers and 275 ms for 500 rows against
the index's 115,000 and 170–290.
Upstream's report is a 9,300-row table: the band the estimate gets wrong is
the band real brains occupy. At 64 dimensions the planner is right at every
size, which is why the earlier bench could not have seen it.

**The mechanism, which is why no cost knob fixes it.** `pg_type.typstorage`
for `vector` is `e`: a 1,024-wide vector is ~4 KB, past the TOAST threshold,
and is stored out of line. At 10,000 rows the heap is 912 kB and the TOAST
relation 53 MB. The planner prices a sequential scan by heap pages plus
per-tuple CPU and never counts the detoast reads — it estimated 114 pages and
the scan read 66,780 buffers. The estimate is wrong in kind, not by a factor.
`random_page_cost = 1.1`, the cost-model remedy the ticket asked to weigh, was
measured as an arm of the bench: at 10,000 rows it wins both sides at
match_count 10 and the `thoughts` side at 50, and still scans the chunk table
at 50 and both tables at 500; at 1,000 rows it wins one cell of six; at
100,000 it still scans the chunk table at the ceiling. The chunk table loses
first because it is "small" in heap pages while every one of its rows is a
vector — the wider the model, the longer every table stays small. Upstream's own
shape, the threshold inside the WHERE, was measured too and is worse still:
with the index forced and no row passing, the iterative scan walks to its
bound, 49 ms for zero rows. The threshold after the LIMIT is what makes the
index scan a LIMIT, and it stays.

**The decision: `SET enable_seqscan = off` on the function**, beside 014's scan
mode — upstream's remedy, taken for a stated reason: no cost constant can
express a cost the estimator omits, and the omission grows with width and row
count. It is a penalty (a disabled path costs 10^10), not a prohibition — a
relation with no usable index still seq-scans — and every statement in the
body has an index the schema guarantees: both HNSW indexes for the candidate
CTEs, GIN for the routing statement, primary-key and `thought_id` probes for
the exact branch, HNSW plus a primary-key join for the walk, a primary-key
join for the merge. Not chosen, and why, in 019's header: `random_page_cost`
in `deploy/compose.yaml` (measured insufficient; and a server setting a hosted
Postgres may not expose, where the clause travels with the schema); raising the
distance function's `COST` (it would work — the index scan pays it only for
the rows it returns — but it edits a catalog row pgvector owns); `set_config`
inside the body (transaction-scoped, and a second mechanism). After: both
sides are an index scan at every count and scale, under both plan modes. At
the counts callers send the index wins by three to four times where the
planner was choosing the scan; at the ceiling the two plans cost about the
same at every size, with the index touching a ninth of the buffers at
100,000; at 100,000 rows and the counts callers send the setting changes
nothing, since the planner already chose the index.

**SMD-1041, folded in because it needs the same migration.** PostgreSQL
assumes 1,000 rows from a plpgsql set-returning function; `match_thoughts`
returns ten by default and `search_thoughts_keyword` twenty-five, and change 32
found the consequence — a fused query whose estimate crossed `jit_above_cost`
and was JIT-compiled on every call. 017 fixed that locally and the estimate
stayed wrong for every other caller. 019 declares `ROWS 10` and `ROWS 25` in
the functions' own `CREATE` statements — not an `ALTER FUNCTION` from 017,
which the SMD-958 passes declined because `CREATE OR REPLACE` resets `prorows`,
and `db/test-schema.ts` re-applies 014 on purpose. Both bodies are carried
verbatim, and the schema test proves it rather than saying it: [20] re-applies
014 and 012 and compares `prosrc` byte for byte, asserts the re-apply reset the
estimate to 1,000 and dropped the setting (the trap, reproduced), then
re-applies 019 and asserts both are back; a composing `EXPLAIN` estimates 10
and 25 rows. `bench-hybrid.ts`'s numbers do not move: 017's `SET jit = off`
stays, since its own argument still holds.

**Wired into CI at the smallest scale that reproduces the decision.**
`test-live.ts` [5c], over [5b]'s 2,000 rows and 400 chunk rows at the
configured width: the control first — the same statement without 019's setting
leaves at least one candidate CTE off its HNSW index, so the section is not
passing vacuously, skipped with the reason where a planner takes both unaided —
then the statement under the function's own SET clauses is an `Index Scan
using thoughts_embedding_idx` and an `Index Scan using
thought_chunks_embedding_idx` at match_count 10 and 50 under both plan modes.
The extraction (`extractBody`) and the settings loop (`applyFunctionSettings`)
moved from `bench-hnsw.ts` into `db/test-support.ts`, so the three explainers
rewrite the same text the same way; `bench-hnsw.ts`'s after arm applies 014
and every later migration, since its plans are read from the catalog and 019
redefines the function. Live suite 222, schema 366.

**Handed to SMD-945.** The recency blend's plan to graft onto the existing
structure assumed that structure gets an index scan. It does now, *because of*
the function-level setting: a redefinition must carry `SET enable_seqscan =
off`, `SET hnsw.iterative_scan = relaxed_order`, `ROWS 10`, the `requires`
line and the `ob1:filter-inside-scan` sentinel — 019's header lists the five —
and [5c] fails without the first at 2,000 rows. Change 37 carried all five.

**A first pass, triaged: nine fixes, one measurement.** Preflight checked
`match_thoughts` for 014's clause and never for 019's, and its remedy restored
only the first, so following the repo's own advice would have reinstalled the
plan defect; a `candidate scan` check reads `proconfig` and `prorows`, names
what a redefinition dropped, and gives the `ALTER FUNCTION` that puts both back
when 019 is recorded and the migration when it is not (`test-preflight.ts`
holds the three wordings, 89). [5c]'s control counted any `Seq Scan`,
including the outer merge's join over a small heap, so it could have passed
while both CTEs already index-scanned; it judges the two HNSW index names and
skips with the reason where the planner takes both unaided. The setting is
function-wide and the filtered statements never read the vector column, so
`bench-plan.ts` measures them too — the routing statement takes the GIN
bitmap under either setting (2.1 ms on a 50% filter at 100,000 rows), the
exact branch is unchanged, the walk's custom plan is the same or better (its
chunk side moves from a seq scan to its HNSW index at 10,000 rows, 18.7 to
15.6 ms), and its generic plan on a broad filter at 100,000 rows is a GIN
bitmap over 50,000 parents in both arms, which change 28 measured and this
change leaves. Buffers had been parsed from `hit=` alone, a floor once the
TOAST relation outgrows `shared_buffers`; hits and reads are summed and every
table above is re-measured (the 100,000-row seq scan touches a million
buffers, not 932,017). `eval-filtered.ts`'s after arm still applied 014 alone;
`bench-hnsw.ts` section D ran the walk outside the function's settings; [5]
issued session `SET`s on a pooled connection; `test-schema.ts` restored the
shipped function by a hard-coded `019` and now re-applies whichever migration
last defines it, read from the files. The header called `typstorage` `e`
"extended" — it is EXTERNAL, what pgvector declares — and now weighs `SET
STORAGE MAIN`, which would make the estimate right by making the heap fifty
times larger for every scan that never reads the vector. README counts.

**A second pass, and the stop.** Its top finding was in the first pass's own
change: with 019 in `eval-filtered.ts`'s after arm, the unfiltered path is an
HNSW walk where 007's function seq-scanned exactly at that corpus size, so the
control that required byte-identical rows would have failed and blamed 014 —
it reports overlap now and stops only below 80%. The rest: the bench explained
the exact branch on a 1% tier without checking the count the function routes
on (gated, as the walk was); [5c]'s "out of line" label counted every index as
TOAST; `bench-hnsw.ts` said its command reproduces the published tables while
its after arm now carries 019's clause (the caveat is in its header; 014's
header cannot change); the README's schema count was one short and both docs
said the control was asserted where it can skip; `lastDefinerOf` matched a
statement anywhere in a file, now only at the start of a line, and [20]'s pin
on 019 is stated as deliberate; preflight never read
`search_thoughts_keyword`'s estimate and read `pg_proc` and the ledger twice —
one read feeds both checks, the settings are parsed with `parseSetConfig`
rather than split on commas (in `test-schema.ts` too), and the remedy is one
`ALTER FUNCTION` per function that needs it, after any body re-apply. The four
explainers share `explainPrepared` in `db/test-support.ts`, and the bench reads
each filtered statement from the catalog once per arm instead of once per
query. Declined: a table-driven single check for every clause `match_thoughts`
must carry (two checks warn about different consequences with different
remedies, and SMD-945 adds no clause) and unifying the three plan-node
classifiers (they answer different questions). Suites after: schema 367,
live 222, preflight 92. Then the tidy-ups the passes had cut for space, while
the files were open: `bench-plan.ts` dispatched its five arms on label
strings and carried two dead fields, and is one table of what each arm sets;
the chunk-row loader it and [5b] had both written is `loadChunkRows` in
`db/test-support.ts`; and 019's header says why `ROWS` is the default page when
017 asks the keyword function for 100 per needle.

**Not done here.** The recency half of #469 (SMD-945, done in change 37); the walk's generic plan
on a broad filter at 100,000 rows, measured in change 28 and again here, which
no setting in this change addresses; `ROWS` on `search_thoughts_hybrid`
itself, which returns at most `match_count` rows and is composed by nothing in
the repo; a per-width run of `bench-hnsw.ts`, whose published tables stay at
64 dimensions.
