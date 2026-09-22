# 88. The knowledge-update slice was already reported and is the best one — and the number cannot see the failure MERIT means: the shipped read puts the stale value first on half the questions, and the resolving read, fed perfect chains, fixes that by changing what counts as relevant (SMD-1720)

SMD-1720 read MERIT's hardest tier — a fact updated later, embedding retrieval
at 0.30–0.95 success, update-on-write stores at 0.70–1.00 — against the fork's
`supersedes` column (025), which labels a superseded hit and never follows the
chain, and asked first for LongMemEval's knowledge-update slice on its own,
which it took to be unreported. It was reported: change 48's tables carry it at
**97.2% (4b) / 98.6% (0.6b)** strict recall_all@5, the best slice on both models,
so by the ticket's own step one it closes with the number. This change is what
was measured on the way to closing it. Like changes 31, 53, 55, 59, 79, 82, 86
and 87 it ships **no runtime change**; the harness is a third arm set in
`evals/eval-longmemeval.ts` (`OB1_EVAL_LME_ARMS=current`) and the numbers are in
evals/README.md under "The knowledge-update slice".

**The number answers the benchmark's question, not the reader's.** Every one
of the 72 knowledge-update questions has exactly two gold sessions — one states
a value, a later one updates it, median 50 days apart — and strict recall_all
counts the question when *both* are in the top five. A reader handed the stale
value first scores the same as one handed the update. So the arm set keeps the
rank of each gold and scores both frames over the same calls: `both` (strict),
`current-in`, `current-first` (the update in the top k and above the stale
session, or the stale one absent), `current@1`, `stale-only`; a control refuses
a question without two golds dated apart; every arm is paired with the shipped
order per question with McNemar's exact test, as change 59 reported.

**The shipped read is a coin flip on which value comes first.** `match_thoughts`
puts the update above the stale session on **38 of 72** questions on the 4b
(52.8%) and **33 of 72** on the 0.6b (45.8%); in almost every miss the stale
row is the top hit and the update second. Both are retrieved on 97–99%, so the
strict number is high and the reader's number is MERIT's range, reproduced on a
public corpus through the fork's own write and read path. Nothing above this
section could have shown it.

**The date is not the lever, again.** 020's blend as a caller can send it
(`recency_weight` 0.3, the half-life fixed at 90 days) is a byte-identical
no-op on rows three years old: a 2023 session has a recency near 10⁻⁴ and so
does the one a week newer. A half-life of 3,650 days moves one question
(p=1.000). Age alone — under the history filter `match_thoughts` blends every
row of the history and cuts to k, so the arm is the five newest sessions in it —
puts newer, unrelated sessions ahead of both golds — current-first 29.2%, strict 2.8%, +10 / −27
against the shipped order (p=0.008). Change 53 found the same on the temporal
slice; the update is not the most recent session in a history, it is the most
recent *about this*, and only a signal that reads the texts can know it.

**The resolving read, priced as an oracle.** The corpus carries **0**
`supersedes` pointers — nothing populates them: the consolidation pass (change
54) has not run on these loads, and at one thought per session it would judge
whole conversations — so the ticket's read (walk each hit forward to the head
of its chain, return the head at the hit's rank, list a session once) cannot be
measured as an arm. It is measured as its upper bound instead: each question's
gold pair held in memory as that question's chain, as if a reviewer had accepted
exactly the right proposals (a store that carries pointers is walked as it is). Fed those, it puts the update first on **every** question (+34 / −0
on the 4b, +39 / −0 on the 0.6b, p<0.001), at rank one on 94–97% — and scores
**0% on strict recall**, because it hands back one session where the benchmark
wants two. With the forward walk removed (the mutant) the arm is the shipped
order on every question, +0 / −0: the walk is the whole effect.

**What that means.** The read is a change of relevance definition, not a
ranking improvement — the same split `eval-supersession.ts` found on the seeded
corpus (change 46: topical relevance +0.000, current-version relevance +0.333),
now on the public one. And the benchmark is right to want both sessions: 14 of
the 72 questions carry a cue like *previous*, *before*, *initially*, about ten
of them ask for the value the update replaced ("What was my previous frequent
flyer status", "Where did I initially keep my old sneakers" — asked beside
"Where do I currently keep"), and one asks for both. A read that resolves by
default answers those from a row it has hidden.

**Decision: not built.** The read is deterministic given chains — a hit in a
chain is replaced, one outside it is not — so building it would measure nothing
the oracle has not; what is missing is chains, and no measured corpus carries an
accepted one. When one does, the read belongs behind an opt-in flag on the
search functions (`p_resolve`, default off), with a `superseded_by_chain: n`
label on a replaced hit, and never as the default — the benchmark's own
previous-value questions are the case against a default, and 025's decision
(label, do not exclude) stands. The reader has the pieces today: the
`⚠ Superseded by a newer thought — ID …` label names the head one read away,
and `Captured:` dates every hit. What would move the reader's number without a
chain is a reranker that reads the two texts and picks the later state — the
one-pool rerank change 59 found to be the lever — on this slice with this arm
set. That is a follow-up, filed against SMD-1319's reranker.

Also in this change: whichever phase reads the session→thought map first
rebuilds a missing one from each row's `metadata.lme_sid` under the run's
model (the four fingerprint twins matched by fingerprint, their questions
re-merged) and says so — both S maps had gone with `/tmp`, and the alternative
was a 14-hour reload. And a loader defect the second review pass found by
reading: the envelope carried `lme_q` and `lme_sid` onto a twin's existing
row, where `upsert_thought`'s key-wise metadata merge replaced the first
session's questions before the loader's union could keep them. The ids are now
written after the upsert, the union always, the id and date only for a row the
session created. The audit trail (008) shows the four overwrites on each S
store, ten questions losing one distractor session each and none losing a gold
one, so change 48's tables stand; the rebuild's merge repaired the rows, and
re-loading a twin session through the fixed loader leaves the row's id,
questions and date as they were.

Tidied after the third pass, while the file was open, no behaviour change: the
isolation filter and the two k values live once at module scope, the control
that turns returned ids into this history's sessions is one function both
scorers call, and the resolve arm walks the shipped arm's ids for the same
question and k instead of fetching the same list again. Tables identical.

Two items the passes had declined were then applied on request. The rebuild
matches a twin's session by a fingerprint computed client-side, one query for
the store's fingerprints instead of one round trip per unmapped session — and
the first run of it showed why the rule is checked against the store before it
is used: JavaScript's `\s` and `toLowerCase` are not 003's rule. Postgres's
`\s` leaves U+00A0, U+202F and U+FEFF alone and its `lower` turns İ into a
plain i; the naive spelling disagreed on 47 of 19,825 rows and the run fell
back to the server lookup, tables unchanged. The class now mirrors Postgres's
and agrees on every row, and a disagreement on any future store still sends
the twins to the server. And the `current` set refuses a gold session whose
row also stands for a session dated differently, since the recency arms read
the row's one date — never true here (the date leads the text a twin shares),
now checked.

**Upstream status:** not applicable — the eval is this fork's.
