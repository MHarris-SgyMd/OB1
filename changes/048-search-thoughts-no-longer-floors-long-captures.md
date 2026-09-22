# 48. `search_thoughts` no longer floors long captures out of the results — admission is relative to the top match, not an absolute 0.5 cosine (SMD-1300)

`search_thoughts` and the ChatGPT-compat `search` both handed
`search_thoughts_hybrid` a threshold of **0.5**, and 020's final clause admitted a
row only if it contained a query needle **or** its raw cosine cleared that floor.
That constant is right for the one corpus every prior eval used — short tracker
issues, where a matching pair clears 0.5 with room — and wrong for a **long**
capture. A short question scores 0.2–0.4 cosine against a 2,600-token transcript,
so the floor removed the **right answer**, silently: fewer rows, all plausible.

**Measured, not asserted.** On LongMemEval-S (SMD-1039, 470 questions,
`qwen3-embedding:0.6b`), a `db/../evals/sweep-floor.ts` swept absolute thresholds
and a relative cutoff by document length. Strict recall_all@5:

| admission rule | ALL | >3k-token gold docs | mean rows | short@5 (lost a gold) |
| --- | --- | --- | --- | --- |
| absolute floor 0.5 (shipped) | 45.3% | 36.1% | 1.1 | 467 (256) |
| no floor (threshold −1) | 87.7% | 84.7% | 5.0 | 0 (0) |
| **relative cutoff, f = 0.5** | **87.4%** | 84.4% | 4.3 | 119 (**1**) |

The floor's damage is entirely on long documents — the `<1k`-token bucket is 100%
under every rule. An absolute cosine floor **cannot** be right for both a
125-token note and a 2,600-token transcript under one model, and 021 lets the
model (hence the similarity scale) differ per row. So the fix is not a smaller
constant.

**Migration 027** redefines `search_thoughts_hybrid` (same signature, so a plain
`CREATE OR REPLACE` — the ACL is preserved, no DROP) with one changed clause: a
keyword hit is exempt as before; a scored row is admitted when it is **within
half of the top candidate's raw cosine** (`v_relfloor` 0.5) *and* clears the
caller's absolute `match_threshold`. This adapts to scale on its own — a 0.8-top
tracker query keeps rows ≥0.4, a 0.3-top transcript keeps the 0.19 gold — with no
per-model constant. The tools (`server-portable/index.ts`) **stop sending 0.5**;
they send **0**, so the relative cutoff governs — and `search`, which took no
threshold at all before, now follows the fix (the ticket's step 3). A **negative**
`match_threshold` disables the relative cutoff too and returns the raw ranked list
— the sentinel this codebase already uses everywhere for "no floor" (the eval's
−1 arm, `match_thoughts` parity). `similarity` (the `% match` shown) is still the
raw cosine; only *admission* changed. `match_thoughts` is untouched — the tools
reach it only through the fused function.

The shipped arm lands at **87.4%** — within 0.5 pt of the no-floor ceiling —
where the old floor sat at 45.3%. Its 119 short calls at k=5 (returning fewer rows
than asked) are the relative cutoff **trimming filler**: only **1** drops a gold
session, versus 256 for the floor. That is the honest distinction between the
cutoff working and the bug: the floor lost the answer, the cutoff trims the noise.

Verified by `test-schema` [26] and `test-live` [15] (027 is the last definer, the
`ob1:relative-floor` sentinel is present, a sub-0.5 top row is returned at
threshold 0 and trimmed at 0.5, the `%` stays the raw cosine), plus the
LongMemEval arm above; all 19 `ci-parity` suites green.

The short-corpus precision cost was measured too, on the 576-issue Linear corpus
(`eval-hybrid.ts` and `decoy-admission.ts`, `qwen3-embedding:4b`). `eval-hybrid`'s
control passed on all 749 queries and the four sets' rank-1 is healthy (identifier
98%, semantic 84%, mixed 92%, decoy 83%) — the floor is not what ranks, so the
adversarial decoy set (a wrong identifier appended) is unaffected. `threshold 0.5`
on the 027 function reproduces the old absolute floor exactly (`sim > 0.5` implies
`sim ≥ 0.5·top`), so it is the honest before; `threshold 0` is the shipped
relative cutoff. Between them, **rank-1 is unchanged (84.3%)** — the cutoff never
displaces the top answer — and the cost is **~0.7 more non-target rows per
ten-result query** (mean non-target 8.30 → 9.02), because at a dominant top of
~0.8 it keeps rows ≥0.4 where the floor kept ≥0.5. A little more fill below the
answer, in exchange for the 45→87% recall on long captures; a bounded,
non-adversarial cost, not the decoy admission the floor was feared to unmask.

Upstream status: **not applicable** — a fork-internal correction to the fork's own
017/020 fusion. Downstream follow-ups filed from the remaining LongMemEval gaps:
SMD-1301 (candidate window), SMD-1302 (temporal/date-aware retrieval), SMD-1303
(a natural-language keyword arm), SMD-1304 (a reranker re-look). **Unfiled**
upstream.
