# 53. The post-floor recall levers, measured — the candidate window, an event-date signal, and a reranker all declined (SMD-1301 / 1302 / 1304)

With SMD-1300's floor gone (change 48), two LongMemEval slices carry almost all
the remaining strict recall_all@5 misses: **multi-session (79.3%)** and
**temporal-reasoning (79.5%)**, both on `qwen3-embedding:0.6b`. Three tickets
proposed three fixes. This change is the measurement that answered them — and,
like change 31 (GraphRAG), it ships **no runtime change**: all three are
declined or redirected, on the corpus that has the headroom to show a gain. The
harness is `evals/rerank-spike.ts` (and `evals/rerank-crossencoder.py` for the
one arm that needs a torch env); it reruns off a persisted eval-longmemeval load.

The premise the three share is real: the golds **are** in the candidate pool.
A perfect reorder of the top-30 pool — the oracle — would reach:

| | multi-session @5 | temporal @5 |
| --- | --- | --- |
| baseline (vector similarity, top-5) | 79.3% | 79.5% |
| oracle @10 (perfect rerank of top-10) | 92.6% | 86.6% |
| oracle @20 | 96.7% | 91.3% |
| oracle @30 | 99.2% | 95.3% |

So the second and third gold sessions sit at ranks 6–20; something must
**reorder** them into the five. Nothing available does. (The baseline here is the
pure-vector arm — `match_thoughts` at threshold −1, the pool the rerankers reorder;
the shipped fused path sits within one question of it, temporal 78.7% / 79.5%, so
it is a fair and slightly conservative bar. The reranker table below uses the same
baseline.)

**SMD-1301, the candidate window — a no-op.** The hypothesis: `search_thoughts_hybrid`
ties the vector arm's fan-in and the final `LIMIT` to the same `v_count`, so a
caller asking for 5 scans only ~5 deep; widen the fan-in and the close-behind gold
becomes a candidate. Measured by calling the shipped function at `match_count = N`
(fan-in N, fused over N) and taking the first 5:

| fan-in N | multi-session @5 | temporal @5 |
| --- | --- | --- |
| 5 | 79.3% | 78.7% |
| 10 | 79.3% | 78.7% |
| 20 | 79.3% | 78.7% |
| 50 | 79.3% | 78.7% |
| 100 | 79.3% | 78.7% |

**Byte-identical at every depth.** At the default `recency_weight` 0 the vector
arm is ranked by similarity, so admitting more rows below the five never reorders
the five: the top-5 of a 100-deep pool equals the top-5 of a 5-deep pool. (The
keyword arm fires on 12 of 248 questions and perturbs at most one of them — which
is why the shipped hybrid sits at temporal 78.7% while the pure-vector baseline in
the tables below is 79.5%, a one-question gap that does **not** move with the
window. That constant offset is the keyword arm and the threshold, not the fan-in.)
The k=10 "recovery to 92.6%" the ticket cited is simply *returning more rows*, not
scanning deeper. A wider window is only useful to something that reorders it —
which is SMD-1304's job, and it too fails below.

**SMD-1302, an event-date signal — noise to harm.** The temporal slice's date
"leads the session text and the embedding does not weight it." But the actual
questions do not turn on a date to match: only **4%** name an explicit date, while
**79%** are "how many days/weeks ago", "which came first", "how many between X and
Y" — topical retrieval, then date arithmetic **on the answer**. The gold session
is no closer to `question_date` than a distractor (closer 19% / farther 23% / tie
58%; mean gaps 25 vs 24 days). A proximity-to-`question_date` blend, swept over
weight × half-life, gains at most **+2 questions of 248** at one weight (`w=0.1`,
half-life 90d — about one per slice) and **hurts** at any real weight (`w=0.3`,
half-life 7d drops multi-session to
65%) — a recency-shaped signal, exactly what SMD-945 already measured as harmful
to ranking and shipped at weight 0. The date leads the text for the reader and the
answer step; it is not a retrieval signal here.

**SMD-1304, a reranker — the story that reversed twice.** The GBrain-notes
decline (change 31's neighbourhood) was measured on the *tracker* corpus the
baseline saturates, where a reranker had nothing to reorder. LongMemEval gives one
headroom (the oracle above) and a public number: GBrain 93.40% → 95.53% all-types
with a hosted Voyage reranker on. Every reranker within reach was tried against the
top-30 pool — strict recall_all@5, with **any-hit@5** beside it:

| reranker of the top-30 pool | MS strict | MS any-hit | temporal strict | temporal any-hit |
| --- | --- | --- | --- | --- |
| baseline (no rerank) | 79.3% | 96.7% | 79.5% | 92.9% |
| bge-m3, bi-encoder cosine | 81.8% | — | 75.6% | — |
| qwen2.5:7b, general-LLM listwise | 27.3% | 87.6% | 40.9% | 85.8% |
| bge-reranker-v2-m3, cross-encoder | 66.9% | 94.2% | 71.7% | 92.1% |
| Qwen3-Reranker-4B, cross-encoder | 66.1% | 99.2% | 70.1% | 96.1% |
| **MemReranker-4B**, reasoning-calibrated | **89.3%** | 99.2% | **81.9%** | 96.9% |

**First: generic rerankers hurt, and the metrics move in opposite directions.**
Every cross-encoder posts a *higher* any-hit than the baseline (Qwen3-Reranker
99.2%) while posting a *lower* strict — and the stronger the model, the wider that
gap. That is the whole mechanism in one line: a cross-encoder is elite at
surfacing *one* relevant session and, for exactly that reason, packs the top-5 with
the single dominant gold plus its most-on-topic neighbours, squeezing the *second*
gold out. The misses are multi-hop **counting/comparison** questions ("how many
days between X and Y") where every session on the topic is equally relevant, so a
sharper relevance judge collapses set-coverage rather than helping it. It is a
depth-vs-breadth trade: reranking optimises depth, strict recall_all@k needs
breadth.

**Then: the same architecture, retrained, reverses it.** MemReranker-4B is
Qwen3-Reranker-4B after reasoning/calibration distillation — same weights lineage,
same yes/no scoring — and it lifts multi-session **66.1% → 89.3%** (+23 over its own
base, +10 over the baseline) while keeping any-hit at 99.2%. So the failure was
never the architecture; it was the training objective. Trained *not* to concentrate,
a reranker keeps the "find a gold" strength and recovers the set.

**But held-out, the gain does not travel.** MemReranker used LongMemEval as one of
its *evaluation* benchmarks, so that +10pt is suspect. Tested on a genuinely
off-distribution corpus — the 601-issue Linear tracker (team SMD, completed) with
the hand-labelled `evals/graphrag-questions.json` multi-hop set, which MemReranker
never saw — the LongMemEval result **does not reproduce**:

| reranker, held-out Linear corpus | multi-hop @5 | aggregation @5 |
| --- | --- | --- |
| baseline (vector) | 100% (17/17) | 29% (2/7) |
| Qwen3-Reranker-4B | 100% (17/17) | 29% (2/7) |
| MemReranker-4B | 94% (16/17) | 43% (3/7) |

MemReranker is about **neutral** here (+1 aggregation, −1 multi-hop); the generic
Qwen3-Reranker is *perfectly* neutral, not harmful — because these multi-hop
questions are easy (baseline 100%), their golds robustly top-ranked, so there is no
marginal second gold to drop. The catastrophic LongMemEval harm is therefore a
*difficulty* effect (marginal golds at rank 3–4), not a universal property of
cross-encoders; and MemReranker's +10 is largely **benchmark-specific**. The one
held-out task with real headroom (aggregation set-coverage) gives it a whisker over
its base model (+1 of 7) — a faint sign its calibration does *something*
off-distribution, but nothing bankable.

**Decision.** No candidate-window knob, no event-date blend, no reranker in the
default path. Generic rerankers are neutral-to-harmful (harm concentrated on *hard*
multi-hop). A reasoning-calibrated local reranker (MemReranker-4B, Apache-2.0, so
the reasoning-aware option is local and free, not only the hosted Voyage) posts a
large LongMemEval gain that a held-out corpus does **not** confirm — so it stays
unshipped pending a *hard* multi-hop held-out test, which the tracker corpus (too
easy) cannot provide. Even confirmed it is 4B/≈9 s-per-query on this hardware, an
opt-in at most, never the 1.3 ms default. Query decomposition (SMD-1318) remains
the more fundamental lever — it turns a breadth problem into single-hop depth
problems, where a reranker's strength finally applies. SMD-1302 and SMD-1301 are
redirected/closed with these numbers; SMD-1304's decline stands, now with the
reranker landscape mapped rather than assumed.

Upstream status: **not applicable** — a fork-internal measurement of the fork's
own 017/020 retrieval. **Unfiled** upstream. Reproduce: a persisted
`eval-longmemeval.ts` load, then `bun evals/rerank-spike.ts` (see
`evals/README.md`).
