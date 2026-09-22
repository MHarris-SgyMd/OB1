# 59. Decompose-then-rerank, measured on two corpora — reranking one pool is the lever, decomposition is not, and how you combine the pools makes no significant difference (SMD-1420)

Change 55 named this the "measured, motivated follow-up": rerank each sub-question's
pool before interleaving, to convert decomposition's coverage into strict@5.
Measuring it forced the real question — there are three ways to feed a decomposed
query to a cross-encoder: rerank each sub-pool and **interleave**, **merge** the
sub-pools into one candidate set and rerank once, or (change 53's arm, no
decomposition) rerank the **one blended pool** — so which, if any, wins? Like changes
31/53/55 this ships **no runtime change**. The harness `evals/decompose-rerank.ts`
emits all three pools from one dump and scores them together; the reranker
(`rerank-llm-reranker.py`) is reused unchanged.

It was run on **two** corpora, because the answer turns on headroom: LongMemEval-**S**
(~40 sessions/question) saturates once reranked, so arms can't separate;
LongMemEval-**M-cleaned** (~476 sessions/question, ~10× the haystack) has a low
baseline and real room. Fired-only strict recall_all@5 (round-robin), MemReranker-4B,
MS / temporal:

| fired-set arm | S | M |
| --- | --- | --- |
| baseline | 80.0% / 82.7% | 52.0% / 59.6% |
| decomposition-only | 82.0% / 80.8% | 62.0% / 57.7% |
| **one blended pool → rerank** | 96.0% / 78.8% | 78.0% / 78.8% |
| decompose → interleave rerank | 94.0% / 78.8% | 78.0% / 75.0% |
| decompose → merge → rerank once | 98.0% / 78.8% | 78.0% / 78.8% |
| oracle | 100.0% / 96.2% | 86.0% / 86.5% |

The S row invites a story (merge 98 > one-pool 96 > interleave 94). A **paired test
kills it.** McNemar exact on the per-question hits (fired set):

- **Reranking vs baseline** is a large, *significant* lift on multi-session for every
  pool method (S p ≈ 0.02, M p = 0.002–0.004) and on M temporal for the one-pool and
  merge arms (p = 0.021; the interleave arm's smaller M-temporal lift, 75.0%, is
  p = 0.06 — not significant); +26 points on multi on the harder M (52% → 78%). The
  reranker earns its place.
- **The pool-combination technique — interleave vs merge vs one blended pool — is not
  significant anywhere**: either corpus, either slice, either reranker (every pairwise
  p ≥ 0.375, net win/loss of 0–4 questions; **merge == one-pool *exactly* on M**). The
  S 94/96/98 spread is sampling noise, and M — with far more room (multi baseline
  miss-rate 20% on S → 48% on M), the fair test — confirms it. Decomposition does not
  separate from reranking one pool even where a real difference had every chance to
  appear.

Decomposition-**as-retrieval** does help on M (+10 multi, 52% → 62% before any
rerank — several vectors cover more of a 476-session haystack than one) but
reranking one pool subsumes it (78% ≥ 62%). And on M even the *generic*
Qwen3-Reranker-4B lifts multi significantly (52% → 72%, p = 0.021), so the multi
benefit is not purely MemReranker's benchmark-fit in the hard regime (change 53's
held-out caveat still bears on the magnitude and on temporal, where only the
calibrated model helps).

**Decision: decline decompose-then-rerank.** Decomposition is not the lever and the
pool-combination method does not matter; *reranking one pool* is the lever, and it
pays off most on hard, large-haystack retrieval. That aims the follow-up at a capable
**non-benchmark** reranker over one pool (hosted Voyage `rerank-2.5`, SMD-1319), and
it **validates SMD-1039's premise** directly: M separated rerank-from-baseline
cleanly where saturated S could not, so a hard held-out corpus is what a shippable
reranker must be judged on. Change 53's reranker decline stands; this change is why
the *next* reranker look should be one-pool on a hard corpus, not decomposition.

Upstream status: **not applicable** — a fork-internal measurement of the fork's
own retrieval. **Unfiled** upstream. Reproduce: change 55's sub-question dump, then
the three-pool dump / per-pool rerank / `--score` recipe in `decompose-rerank.ts`'s
header (all three arms — interleave, merge, one-pool — from one dump), and the
McNemar test in `evals/README.md`. The M corpus is loaded in question shards into
its own DB with a post-load `lme_q` completion pass, then scored through a slim M
file reusing the S decomposition dump — recipe in `evals/README.md`. The loader's
inability to `readFileSync` a >2 GB corpus is filed as a follow-up.
