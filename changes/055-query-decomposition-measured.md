# 55. Query decomposition, measured — it fixes what the SMD-1301/1302/1304 nulls blamed, and strict@5 still barely moves (SMD-1318)

Change 53 declined three levers and named the fourth — query decomposition — "the
more fundamental lever". This change measures it, and like change 53 it ships **no
runtime change**: the fundamental lever is declined for the default path too,
because the measurement corrects the premise every prior null shared. The harness
is `evals/query-decompose.ts`, off the same persisted `eval-longmemeval.ts` load.

The shared premise was: a multi-hop counting/comparison question ("how many days
between X and Y", "which came first, X or Y") needs 2–3 distinct gold sessions in
the top five, but **one blended query vector is the average of several events**,
so each event's session lands mid-pool and no reorder of that one pool recovers
the set. The fix follows directly and is the standard 2025–26 multi-hop RAG
pipeline: retrieve with **several** vectors — decompose the question into
single-fact sub-questions, retrieve top-k per sub-question, union, fuse. Every arm
runs the identical pipeline (decompose → per-sub-query top-k → fuse → take five
distinct sessions); the baseline's decomposer returns the question whole, so a
question left atomic reuses the baseline pool unchanged — the harness confirms it
routes every atomic question through that path (146/146 LLM, 207/207 heuristic;
true by construction, not an independent replication). An LLM (`qwen2.5:7b`,
temperature 0) splits cleanly and fires on 41% of the 248 multi-session + temporal
questions (mean 2.25 sub-questions).

Strict recall_all@5, versus baseline 79.3% / 79.5% and the top-30 oracle 99.2% /
95.3% (`subk` = 20, MS / temporal):

| fusion of the sub-query pools | heuristic | LLM |
| --- | --- | --- |
| RRF (k₀ = 60) | 79.3% / 76.4% | 79.3% / 76.4% |
| round-robin | **81.0%** / 79.5% | 80.2% / 78.7% |
| max-sim pooling | 79.3% / 79.5% | **81.0%** / 78.0% |

(The RRF row is identical for the two arms — verified by re-running each, not a
duplicated cell: the two arms diverge under round-robin and max-sim, so the
harness does distinguish them; RRF's flat k₀ = 60 weighting simply makes it a poor
fusion here.)

**It corrects the ticket's premise, and it is not enough.** The premise was that
one blended vector ranks each event mid-pool — but **coverage is not the
bottleneck**. On the fired questions the decomposed union covers 100% / 96.2% of
the golds, and one blended query at the baseline depth (30) reaches exactly the
same 100% / 96.2% on those questions. At *equal* per-query depth (`subk` 20) the
union does edge out one query (blended 98.0% / 92.3%) — several vectors retrieve
marginally more than one for the same budget, but no further than one *deeper*
query already goes. And ~83% of the fired questions' golds already sit at rank ≤ 2
in the blended pool individually. What an LLM split changes is per-event **rank** — the share of
golds at rank 0 of their best sub-pool rises from **39% to 61%** (multi-session)
and 38% to 61% (temporal), with the deep tail shrinking. Yet strict@5 gains at most
+1.7 points and is flat-to-negative on temporal; RRF *regresses* temporal, because
it sums shared appearances, so a topical distractor in two sub-pools outscores each
event's single-pool gold. `subk` 10 → 30 barely moves strict — the bottleneck is
not scan depth.

The reason is that **the miss was never "each event is mid-pool" — it is set
assembly.** With coverage already there and each gold individually near the top,
the failure is fitting 2–3 mutually-competing golds plus distractors into five
slots of one ranking. Decomposition removes gold-vs-gold competition (each gold in
its own pool) but the merge re-introduces gold-vs-distractor competition, and no
dumb fusion can tell each sub-pool's one gold from its topical neighbours. That
discrimination is exactly a reranker's single-hop strength (any-hit ~99%, change
53) — which is why a reranker *destroys* a pre-decomposition multi-hop set yet
belongs **after** decomposition, on the single-hop sub-pools. So decomposition
alone is declined for the default path (a marginal strict gain at the cost of an
LLM call plus N retrievals per query, on a local-by-default fork), and the
measured, motivated follow-up is **decompose-then-rerank** — lift each sub-pool's
gold to rank 0, then interleave — whose headroom is the 39% of golds not yet
there. Like the reranker (change 53), that belongs on a *hard* held-out corpus,
not only LongMemEval. **(That prediction was measured in change 59 and declined:
reranking one pool is the lever, not decomposition — and how you combine the
sub-pools makes no significant difference, on two corpora. Assembly was never the
bottleneck. Change 59 measured on LongMemEval-M — harder, but the SAME 500 questions,
not held out — which validated the *premise* of this advice; a hard HELD-OUT corpus
is still change 59's open follow-up.)**

Upstream status: **not applicable** — a fork-internal measurement of the fork's
own retrieval. **Unfiled** upstream. Reproduce: a persisted `eval-longmemeval.ts`
load, then `bun evals/query-decompose.ts` (see `evals/README.md`).
