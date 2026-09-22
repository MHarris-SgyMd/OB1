# 81. Quantised vector indexes at the shipped width, measured on real vectors — halfvec adopted for `match_thoughts` (migration 039), binary declined (SMD-1501)

At the shipped width — 1,024 dimensions, `qwen3-embedding:4b` truncated — a
ten-million-row brain's two HNSW indexes were argued to be "roughly four
times" the 5.4 GB + 1.1 GB change 28 measured at 64 dimensions. pgvector 0.7+
indexes `halfvec` (half the bytes) and binary-quantised vectors (a
thirty-second), and the published results at equal recall are build times cut
by an order of magnitude and footprints by up to twelve times, with a rerank of
the candidates on the full vectors giving recall back. Nothing in the fork had
measured either, and change 28's random 64-dimensional bench cannot answer a
recall question. The ticket's shape was a measurement rather than a switch:
`match_thoughts` has two candidate CTEs merged by MAX per thought, a rerank
would have to sit between the CTEs and the merge on both sides, the exact
branch reads no index, and `evals/eval-filtered.ts`'s unfiltered control
exists to notice the default path's rows moving.

**The harness (`evals/eval-quant.ts`).** The real vectors this fork holds at
1,024 dimensions are the two LongMemEval corpora `eval-longmemeval.ts` loaded:
S under the shipped model (19,825 whole vectors and 56,267 windows — the two
tables `match_thoughts` scans, 76,092 vectors) and M under
`qwen3-embedding:0.6b` at the same width (51,660 and 145,705: 197,365). The
ticket asked for 100,000 rows and the largest the corpus allows; these bracket
it, and no third real corpus at this width exists on the machine (embedding
100,000 more sessions at 4b is days). The harness copies a corpus, rows only,
into a throwaway database under the tree's schema (kept under `OB1_PG_KEEP`,
re-migrated on reuse), embeds the 470 questions with the corpus's model, takes
an exact pass with no vector index in existence — exact in the function's own
shape, the true nearest `v_fetch` per side merged by MAX, which is what a
perfect index would return; not the ten highest MAX scores over every row,
which the two-CTE shape does not compute, and the report counts on how many
questions the two differ: on none of the 470, on either corpus — and then
builds each arm's two indexes alone — timed under one `maintenance_work_mem`
and worker count,
sized, dropped before the next — and runs the function's unfiltered statement
with only the candidate ORDER BY changed, under the function's own SET clauses,
at `hnsw.ef_search` 40 / 100 / 400. The arm the deployed function walks goes
last, under the shipped index names, and a CONTROL holds the function itself
to that arm's mirrored statement question for question (0 of 470 differed,
both corpora, both before and after 039). LongMemEval's own per-question
filter matches a few hundred thoughts and routes every question to the exact
branch, so the harness as run never touched the HNSW index; the measurement
is the unfiltered default path, `match_count` 10, where the index is used.

Three arms: `vector` (001/007's `hnsw (embedding vector_cosine_ops)`);
`halfvec` (`hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)`, the query
cast to match, the candidates' similarity recomputed on the full vector — the
heap row is read anyway); `binary` (`hnsw ((binary_quantize(embedding)::bit(1024))
bit_hamming_ops)`, each CTE taking `v_fetch × R` candidates by Hamming distance
and reranking them by full-vector cosine to `v_fetch`, R = 1, 2, 4, 10 — 400
candidates at the default count is the ticket's `v_fetch × k`). Scored:
recall@10 against the exact ten; how often one of the question's gold sessions
is among the ten with the whole corpus as haystack (the exact pass is the
ceiling: 46.2% on S, 34.5% on M — a session whose text twins another's shares
its row); whether the ten are the identical list the vector arm returns at the
same `ef_search`; the round trip's median and p95 after one untimed pass.
Each corpus was built and measured twice (`quant-*.log` in the session
scratchpad; the tables are the second pass, the first is quoted where it
differs).

**What the pages hold.** At 1,024 dimensions a float4 vector is 4,096 bytes
plus its neighbour lists, and pgvector packs an index page by whole elements:
two do not fit an 8 KB page, so every vector costs the index a page — 8.2 KB
per row on both tables, both corpora (155 MB for 19,825 thoughts; 404 MB for
51,660). Three halfvec elements fit a page (2.75 KB per row); a binary element
is 128 bytes and a page holds twenty (0.4 KB). So the shipped index at ten
million rows is near 80 GB before the chunks', not "four times 5.4 GB", and
halfvec is not half of it but a third.

**Results, `ef_search` 40 (the default, which the function leaves alone).**

| arm | candidates per CTE | S recall@10 | M recall@10 | S gold-hit | M gold-hit | same list as vector, S / M | S ms | M ms | index bytes | build s, S / M |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vector (001/007) | 40 | 0.984 | 0.971 | 46.2% | 33.8% | 100% / 100% | 4.13 | 4.22 | 577 MB / 1,482 MB | 13.9 / 28.7 |
| **halfvec (039)** | 40 | 0.974 | 0.970 | 45.5% | 33.6% | 93.4% / 95.3% | 3.12 | 4.08 | 193 MB / 494 MB (33%) | 7.9 / 18.5 |
| binary | 40 | 0.955 | 0.939 | 46.0% | 33.4% | 69.6% / 68.3% | 1.80 | 3.08 | 31 MB / 79 MB (5%) | 2.5 / 7.3 |
| binary | 80 → 40 | 0.980 | 0.973 | 46.2% | 34.3% | 83.0% / 79.1% | 3.07 | 4.09 | " | " |
| binary | 160 → 40 | 0.993 | 0.991 | 46.0% | 34.5% | 86.6% / 82.8% | 5.63 | 7.92 | " | " |
| binary | 400 → 40 | 0.998 | 0.997 | 46.2% | 34.5% | 88.9% / 83.6% | 13.25 | 17.44 | " | " |

The `ef_search` sweep for the two contenders (S / M):

| arm | ef_search 40 | 100 | 400 | ms at 40 / 100 / 400 |
| --- | --- | --- | --- | --- |
| vector | 0.984 / 0.971 | 0.996 / 0.989 | 0.999 / 0.998 | 4.1 / 6.4 / 18.1 — 4.2 / 6.5 / 17.4 |
| halfvec | 0.974 / 0.970 | 0.993 / 0.989 | 0.999 / 0.999 | 3.1 / 4.1 / 9.1 — 4.1 / 6.1 / 14.8 |

The first pass had put halfvec at 0.981 / 0.971 and vector at 0.983 / 0.973
(S / M): an HNSW graph built in parallel differs build to build, and a
hundredth of recall is that spread; latencies moved by about a quarter between
passes on a machine shared with other sessions' containers. A third pass
after 039 landed, with `match_thoughts` itself now the halfvec arm's control
(0 of 470 differ on either corpus): halfvec 0.980 / 0.971 against vector
0.984 / 0.973, the function's own median 3.1 / 3.8 ms. Every gold-hit
figure is within a point of the exact pass's ceiling under every arm — on a
haystack of the whole corpus the LongMemEval questions are not what
distinguishes these indexes; recall against the exact answer is.

**The decision.** The bar, set before the runs: an arm is worth a migration
only if, at the default `ef_search` on both corpora, its recall@10 is within
0.02 of the vector index's, its median latency no more than 1.2× the vector
index's, and its bytes at most 60% of the vector index's. **halfvec clears
it** on every axis: recall within the build-to-build spread at every
`ef_search`, faster or equal (the walk reads a third of the pages), a third
of the bytes, builds in 57–64% of the time. **Binary is declined, and not on
the numbers alone.** Without a rerank it loses three hundredths of recall
(0.939 against 0.971 on M — under the bar, and 68% identical lists). Reranked
at 80 → 40 it meets every number the bar asks: recall within four thousandths
on both corpora, latency at the vector index's, 5% of the bytes. Reranked
further (160 → 40) it passes the vector index's recall at 1.4–1.9× its
latency, because the rerank reads every candidate's full vector out of TOAST
and the two-CTE shape pays it twice, once a side. What decides against it is
what the ticket's own framing named: a rerank is a change to the function's
body — a subquery and a second candidate depth to size inside each of the
four walk CTEs, a second knob beside `ef_search` — and it returns the
identical ten rows on only 79–83% of questions, where halfvec clears the bar
with a cast and 93–95%. Binary at 80 → 40 is the arm for a brain whose
halfvec index no longer fits in memory, and a decision to make on that
brain's numbers with this harness; for the default path today halfvec
dominates vector.

**Migration 039.** Two things, in one file (its header has the rest). The
two HNSW indexes are rebuilt over `(embedding::halfvec(D))` with
`halfvec_cosine_ops` **under their names** — built under a staging name,
001/007's index dropped, the staging index renamed — so preflight,
`test-live.ts` [5]/[5c], `bench-hnsw.ts` and `bench-plan.ts`, which match
plans on `Index Scan using thoughts_embedding_idx`, read as they did. A
re-run finds the shipped name already over halfvec, of this shape and valid,
and does nothing (a valid index of another shape that names halfvec — an
IVFFlat over the cast — is refused by name, with the staging build as the
remedy, rather than taken for done); a staging index built beforehand by hand — `CREATE INDEX CONCURRENTLY
thoughts_embedding_halfvec_idx …`, the path for a brain where a plain CREATE
INDEX would hold writers too long (about 100 µs a row under
`maintenance_work_mem` 2GB with four workers, the graph in memory: a couple
of minutes at a million rows, some twenty at ten million) — is adopted when
valid and of this shape, refused by name when of another, and dropped first
when INVALID; an INVALID index under the shipped name is rebuilt rather than
kept. And `match_thoughts` is 038's body
with the two walk branches' four ORDER BYs cast on both sides,
`embedding::halfvec(D) <=> query_embedding::halfvec(D)`, the index's
expression token for token; the similarity stays `1 - (embedding <=>
query_embedding)` on the full vector, so the threshold, the merge and the
exact branch — which reads no index and casts nothing — are on one scale. The
stored vectors do not change: `reembed.ts`, the servers and every writer are
untouched, and the expression index keeps itself on every write.
`search_thoughts_hybrid` calls `match_thoughts` by name and inherits.

**Applying it.** 039 is the first bulk graph build most brains meet — 001 and
007 indexed an empty table that then grew row by row — and neither the file
nor `migrate.ts` sets `maintenance_work_mem`, so the compose stack's migrate
service and a `bun db/migrate.ts` from a shell build under the server's
64 MB and two workers: pgvector keeps the graph in memory while it fits
(some 25,000 vectors at this width, 2.5 KB each) and finishes the rest in its
on-disk phase, many times slower, with a NOTICE no driver here surfaces
(review pass 2). The rule, in the header, `db/README.md` and
`deploy/README.md`: 2.5 KB × the vectors across both tables — 250 MB per
100,000, 2.5 GB per million — set on the migrating role before the run,
`/dev/shm` to hold it under parallel workers; `migrate.ts` now prints the
vector count and the setting in force just before 039 runs. The file lifts
`statement_timeout` for its own transaction (a platform's per-role timeout
would cancel a build of minutes and roll the file back after the work), and
its DROP and RENAME take ACCESS EXCLUSIVE, so a held reader past the
migrator's `lock_timeout` aborts the file — the by-hand staging indexes
survive that rollback, the plain build does not. And preflight gains a check,
`walk index`, for the one failure state 039 creates and nothing else sees: a
body that orders by the cast over an index that is not over it, or the
reverse, or an INVALID index under the name — every walk a sequential scan
under `enable_seqscan = off`, exact at 019's cost, with `proconfig` intact and
the ledger recording 039. It reads the body's ORDER BY and each index's
definition and validity from the catalog and names the re-apply as the
remedy.

**What moved, and what it costs.** The default path's rows: at `ef_search`
40 the identical ten on 93% of S's questions and 95% of M's, recall within a
hundredth, gold sessions within a point. `evals/eval-filtered.ts`'s
unfiltered control, re-run on the 576-issue Linear corpus with 039 in the
after arm: 599 of 601 queries return the identical rows before and after, and
the mean overlap rounds to 100.0% — two lists differ by a row each, the
index's approximation and the intended change. The one thing that gets slower is a statement nobody
in the runtime sends: `ORDER BY embedding <=> q` on the raw column, from
psql or a recipe's own SQL, had the vector index and now has a sequential
scan — exact, 10–100 ms per hundred thousand rows at this width — because the
cast is the index's key (`test-live.ts` [5] holds both plans). An earlier
definer re-applied by hand (038, 020) puts a raw-column body over the halfvec
index and gets that scan on every walk; preflight's remedies now name 039 as
`match_thoughts`' last definer.

One thing did move, and the first draft of this section misread it.
`test-live.ts` [5b] calls the function under a 99% filter on 2,000 random
unit vectors at 1,024 dimensions, and its ten-query overlap with the exact
top-10 fell from at least 85 of 100 under the vector index to 79–83 under
halfvec, three runs running. Measured per query through the function over
100 queries on that fixture: under the vector index every call returned all
ten exact ids; under halfvec the first five calls of the session lost two to
six ids each and the ninety-five after them lost none, on every build. That
is not precision, it is plpgsql's plan cache: EXPLAIN of the function's own
walk statement shows the vector index priced out of the plan on this fixture
— both the custom and the generic plan read the GIN bitmap, which is exact —
while the halfvec index, a third of the pages, wins the custom plans the
first five calls get (an Index Scan, 2.6 ms, and the walk's recall on random
vectors, about 7 of 10 at `ef_search` 40 under either index) and loses to
the bitmap again once the generic plan is adopted (9.7 ms, exact). A cheaper
index moved a plan that sat on the edge; the walk itself is what it was.
[5b] now sums fifty queries against a 90% floor and says so; the 039 header
carries it as a failure mode; `bench-hnsw.ts`'s section A, which walks by
construction, is re-measured below.

**What the suites found on the way.** `test-schema.ts` [21] — 020's blend,
"identical at weight 0" — compared the shipped function with 019's installed
under another name, over a fixture of 200 rows each on its own axis: every
row nearly equidistant from every other, a graph the HNSW walk reached 34 of
200 rows of under *either* index. The section passed for a year because both
functions walked the same graph; under 039 the comparison function had no
index, scanned exactly, and the two disagreed. The fixture now spreads each
row's remainder over 32 shared axes (the walk reaches all 200, asserted), and
the comparison function takes 039's cast so the two walk the same index. New:
[38] holds the swap's every case (re-run, 001 re-applied, a hand rebuild, a
staging index adopted) and pairs the body's cast with the plan — an Index
Scan under the body's ORDER BY, none under the raw column's; [4] reads the
halfvec expression; [8e] and [20] pin 039 as the last definer, and [20]
compares the CTEs to 014's with the cast taken out. `test-upgrade.ts` [17]
applies 039 onto a populated 038: no row, signature or privilege moves, the
walk agrees with the exact answer before and after, a re-apply keeps the
index OIDs, and an INVALID staging index is rebuilt (made by flipping
`pg_index.indisvalid`, which PGlite refuses and a server allows).
`test-live.ts` [5d] applies the last definer before it drops the index — 039's
swap would otherwise build one over its 25,000 rows. And the first CI run of
this branch failed ten assertions of `test-schema.ts` [17b] — the hybrid
search's three-row fixture — with `match_thoughts` returning the near match
and the distant note but not the exact match at cosine 1.0, on a run that
passed locally every time. The likeliest cause: PGlite never vacuums, so by
[17b] the HNSW index holds the thousands of rows every earlier section
deleted, and whether a walk through those dead elements reaches every live
row turns on the level each insert drew at random — inferred from the
symptom rather than shown, since a local probe with 2,500 dead elements over
four seeds returned all three rows each time. The two three-row sections
([17b], [26]) now VACUUM after their DELETE, so the vector arm is measured
over the rows it is given whatever the cause was. Any HNSW index between
deletes and a vacuum has the same exposure, and had it before this change.
922 / 501 / 210 assertions.

**The bench.** `bench-hnsw.ts`'s after arm applies the whole tree, so from
this change its section A recall and every walk tier are the halfvec index's
at 64 dimensions. A corpus kept under an earlier tree (change 72) does NOT
take 039 on its next reuse: the marker's physical fingerprint covers the two
HNSW indexes by relfilenode, and 039's swap is a new relation under the old
name, which the fingerprint would read as `rewritten` — by design, since the
marker's section L sizes and build times would describe a graph that no
longer exists. The bench reads the migrator's dry run before the live run and
refuses a reuse on which 039 is pending there, before anything is built
(the alternative was the rebuild inside `migrate.ts` under the server's
default `maintenance_work_mem`, hours at ten million rows, and then the
refusal; `test-bench-reuse.ts` [7] holds it). Remove the kept volume and
build the corpus again under this tree (`db/README.md` names the command;
the ten-million-row volume `hnsw10m` on the development machine is such a
corpus). A fresh run at the two large scales then prints the halfvec
index's sizes and build times in section L where change 28's table holds the
vector index's. Run at the two published scales under 039, section A's
after arm reads 8.3 of 10 in the exact top-10 at `ef_search` 40 and 10.0 at
400 for 10,000 rows, 4.8 and 9.6 for 100,000 — change 28's table has
8.2 / 10.0 and 5.0 / 9.5 under
the vector index, the difference inside a pass's spread — at 1.31 and 1.91 ms
for the default path (1.82 and 3.25 there, on a different day's machine).
Change 28's tables stand; section L still records the before arm's vector
index sizes, and at 64 dimensions a float4 vector is 256 bytes, so the
page-packing gain above is smaller there and unmeasured.

**Follow-ups.** halfvec's HNSW ceiling is 4,000 dimensions where vector's is
2,000, and `qwen3-embedding:4b`'s native 2,560 would fit — but 001 still
builds the vector index first at the column's width, so `config.mjs`'s
ceiling stays 2,000; lifting it means 001's index becoming conditional, a
change of its own. SMD-1465 (size `ef_search` on real vectors) has its
unquantised baseline in the sweep table above.

**Review.** Three high-effort passes, each a fresh reviewer over the saved
diff with its own lens, each triaged and verified by the suites. Pass 1
(correctness and teeth) found the decision prose contradicting its own
table, the [5b] regression misread as fp16 when it was the plan cache, an
exact reference that was not exact by construction, the swap block trusting
names, the DROP's lock, and a harness that could be pointed at its own
source. Pass 2 (the operator and the upgrade path) found the kept bench
corpus's dead end, the build under the server's default memory, the failure
state preflight could not see, "exact" over-claimed, and the shipped-name
check weaker than the staging one. Pass 3 opened on pass 2's fixes — the
bench should refuse before the build rather than document it, the new
preflight scenarios left two branches undriven, the migrator's count came
from the wrong statistic, the shipped-name remedy dropped the live index,
the same-source guard compared hostnames literally — the stop signal, and
each was fixed. Declined: a `cteLimit` parameter on the harness's statement
builder in place of the string split that makes the true-MAX statement — the
pass itself said nothing breaks today, and the split is one line beside its
reason.

Upstream status: **not applicable** — upstream's `match_thoughts` is the
guide's single-table function over a Supabase index. **Unfiled.** Reproduce:
`cd evals && OB1_EVAL_QUANT_SOURCE=<a LongMemEval database> OB1_EVAL_LME=<its
file> OB1_EVAL_EMBED=<its model>@1024 OB1_PG_KEEP=quant OB1_PG_SHM_SIZE=3g
../db/with-postgres.sh bun eval-quant.ts --plans`; `bun db/test-schema.ts`
[38]; `./with-postgres.sh bun test-upgrade.ts` [16].
