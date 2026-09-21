# 87. The composed match, measured — stores as complements, not substitutes: a scalable ANN does cheap deep coarse recall, Postgres does the exact rerank/fuse over the small candidate set, and that recovers recall a single ANN pass loses at scale while adding precision the ANN can't express (SMD-1707)

Change 86 (SMD-1696) closed by naming the axis it had not measured. Changes 79, 82
and 86 all raced stores as **substitutes** — each doing the whole match and returning
the rows, the id→row hop treated as cost to minimise (82) or eliminate (86). None
measured stores as **complements**: a **composed** match where a scalable ANN engine
does cheap coarse recall and Postgres does the exact rerank/fusion over the small
candidate set, the hop reframed as the *precision stage*. This measures that shape,
on the same harness and the same exact-cosine oracle. Like changes 31, 53, 55, 59,
79, 82 and 86 it ships no runtime change; the numbers are in evals/README.md, under
"Does the store matter?".

`evals/store-composed.ts` drives two stages against one oracle (K = 10): **stage 1**,
a coarse ANN over K′ ≫ k candidates from LanceDB (the change-82 store); **stage 2**,
an exact rerank/fuse in Postgres over just those K′ refs — exact cosine (MIN over a
ref's windows), an exact metadata filter, an optional recency blend (change-20's
`recency_score`, inlined) and an optional keyword arm fused with the vector *rank* by
symmetric RRF over `docs.tsv` (both terms on the RRF scale, as search_thoughts_hybrid
fuses them). The rerank has no `ORDER BY` over the vector index, so it is exact within the candidate set and its cost is bounded by
|cand| = K′, not by N. Comparators: the substitute (vector-only ANN@k at depth 50),
a single-store Postgres hybrid (vector ⋈ FTS RRF over the whole table), a
pg-HNSW-coarse control, and the exact oracle. K′ is swept.

**On a small corpus there is nothing to recover.** On the real corpus (601 issues,
963 points, 1024-dim, 150 queries) the ANN is already exact — the substitute gets
100% recall@10 unfiltered — so the composition matches it and the K′ sweep only
shows the mechanism warming up (K′=10 → 78%, K′=25 → 99%, K′=50 → 100%). The recall
win is a scale phenomenon.

**At 1M rows the composition's real shape appears — and it is deep coarse recall,
not the rerank alone, that recovers recall.** The single ANN pass loses recall at
scale (substitute 60% unfiltered, nDCG 0.72). At the headline K′=200 the composed
match *ties* it (60%) — the exact rerank only re-orders the candidate set, and the
true top-10 neighbours are simply absent from a 200-candidate ANN pool 40% of the
time. Recall moves only as K′ deepens: **83% at K′=500, 92% at K′=1000**, approaching
the oracle's 100% at 21.7 ms total versus the oracle's 30.1 ms full scan. So the
quality win is *deep coarse recall + exact ordering* — a quality/latency dial, not a
free lunch: the rerank makes a deep-but-approximate set precisely ordered, but the
set is made deep by paying stage-1 cost. This sharpens change 86's thesis: the
precision stage is where a second store earns its place, but it only pays once the
coarse stage recalls enough to rerank.

**The coarse store's filtering quality is load-bearing.** On selective filters the
pg-HNSW-coarse control collapses (real corpus: portal 32%, t07 14%; 1M: 41/32/17/2%
across the tiers) — pgvector's post-filter is the SMD-968 hazard, and stage 2's exact
filter cannot recover rows the coarse stage never surfaced. LanceDB coarse
prefilters and holds filtered recall on the *selective* tiers (t10/t1/t01 = 100% at
1M), at a latency cost (~40 ms p50); the non-selective t50 tier sits at the
substitute's 71% — a scale recall loss the prefilter does not fix, since half the
corpus passing the filter is the same coarse-recall problem as the unfiltered arm. A
composed match is only as good as what its recall tier surfaces.

**The composed total beats the ~O(N) full scan and its edge widens with N; the rerank
stage's wall-clock is cache-bound and run-to-run volatile — the scale claim, corrected
by re-running the committed code.** The a-priori guess was that the stage-2 rerank
would be N-independent. It is not: it reads a bounded K′ rows, but at 10M those K′
heap fetches hit a heap that exceeds RAM, so its wall-clock is dominated by cache/OS
load and *swings between runs*. Two runs of the committed code, at K′=1000: rerank
6.5 ms at 1M, then **36.5 ms and 108.5 ms** at 10M — a ~6×–17× jump for 10× the data,
not the clean sub-linear the first cut claimed. What is stable is the full scan
(≈30 ms → ≈370 ms, a clean ~O(N), ~12×) and the direction: the **composed total**
(coarse ANN + rerank) at K′=1000 was 21.7 ms at 1M (≈1.4× cheaper than the full scan)
and 72–155 ms at 10M (2.5–5.1× cheaper across the two runs) — the system's edge over
the full scan widens with N even though the rerank stage's own scaling is volatile.
The coarse ANN is the part that grows most with N and is the shardable half; sharding
it would improve the system edge further, but that is asserted, not measured here. So
coarse-recall → exact-rerank scales where the full scan does not — not because the
rerank is flat (it is neither flat nor reliably sub-linear), but because the
bounded-candidate total stays well under the ~O(N) scan. (At 10M the filtered read is
dominated by the coarse stage's prefilter, ~237–259 ms p50 substitute / ~267–298 ms composed
for Lance's filtered arms (the mean over all filtered arms — the per-tier split is
unavailable at 10M, where the oracle is skipped) — the recall tier's filter cost is the scale wart, as in
change 86's read-model filtered reads.)

**The rerank stage adds precision the ANN cannot express, quantified.** Judged
against the objective each serves (not the pure-cosine oracle): against an exact
recency-blended oracle (w=0.3, 90-day half-life), the ANN substitute and the
pure-cosine composition both scored 18%, while folding recency into the rerank
recovered **73%** at ~3.8 ms — the exact stage serves the recency objective the vector
store cannot. (It caps below 100% because the cosine coarse stage does not surface
every recency-optimal row — the same binding-constraint lesson; deeper K′ raises it.)
Folding the keyword signal into the rerank moved the composed top-k onto the
whole-table hybrid it reproduces (**80% → 94% top-10 overlap**) — the composed keyword
arm fuses the vector rank and keyword rank by symmetric RRF, the same fusion
search_thoughts_hybrid runs over the whole table, so the bounded-candidate rerank
reproduces the full-table hybrid's ranking.

**Verdict — the multi-store win is composition, and it is real but conditional.**
Where a single ANN pass loses recall at scale (1M+), deep coarse recall + exact
rerank recovers it toward exact quality (92% of the oracle at K′=1000, measured at
1M — where the composed total was ~1.4× cheaper than the full scan), and the rerank
adds precision the ANN cannot express, over a bounded K′-row candidate set whose
advantage over the full scan *grows* with N (composed-total edge ~1.4× at 1M → 2.5–5.1×
at 10M, where recall itself was skipped). This is the id→row hop reframed as the
precision stage, exactly as change 86 predicted — stores as
complements, a **recall tier** (the scalable ANN) plus a **precision tier**
(Postgres). The conditions are the finding as much as the win: it needs deep coarse
recall (K′ large → stage-1 cost grows and must shard), the coarse store's filtering
quality is load-bearing, and a small corpus has nothing to recover. **Not built** —
a composed retrieval path in the product is a separate scoped issue if a bar clears;
this closes the second of the two axes change 86 named (SMD-1697, where the single
store stops fitting, is the other, still open). Stage 3 (a cross-encoder / LLM
reranker over stage 2) was left out: the rerank spikes already measured it
flat-to-negative and it is a heavy out-of-process dependency. (LanceDB is Apache-2.0
and the fork is FSL-1.1-MIT — SMD-1038's guardrail — a dependency of an eval, not the
product.)

**Upstream status:** not applicable — the store comparison is this fork's eval.
