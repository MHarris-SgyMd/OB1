# 258. prefer_current reads the tickets a thought is about, not only its own lifecycle (SMD-2271)

**What changed.** Two PRs: the measurement, then the ranking.
- PR 1, `evals/eval-transitive-freshness.ts` and
  `evals/fixtures/transitive-freshness-labels.json` — a thought's ticket
  references (central: `metadata.topics`, `metadata.action_items` and a
  session summary's header key; body: every key in its text), six candidate
  rules for demoting a thought with no lifecycle of its own, and 059's re-sort
  with the transitive reason beside the reflexive one, as a TypeScript oracle
  scored read-only against a brain. 80 hits labelled stale, current or
  neutral (ids and numbers only), two graders per round given the rubric, the
  text and the tickets' statuses and nothing of the rules: round 1 49 hits
  (κ 0.876; four adjudicated by the author), round 2 25 (1.000), round 3 6
  (κ 0.250; two settled by a third blind grader). `--self-check` in Fork Checks.
- PR 2, migration 077 — `ticket_references(content, metadata)` lists the keys a
  thought names, between ASCII lookarounds so it reads them as JavaScript's
  `\b` does; `ticket_references_settled` applies the chosen rule over 068's
  ticket heads (an open ticket named anywhere vetoes; else known central keys
  decide, all settled; else three or more known keys in the text, all
  settled); `search_thoughts_current` demotes such a thought — the same weight,
  once — and says `references settled work (SMD-…)`. Its columns, its
  7-argument form and both forms' privileges are unchanged; nothing is stored.
  The rule's code moved to `evals/transitive-freshness.ts` (no imports), which
  test-schema [69] imports; `--sql-check` holds 077 to it on a brain at 077.
- The server: the structured reply's `demoted` gains the token
  `references_settled`; the window note reads "settled, superseded or about
  finished tickets"; the flag's description says what it now demotes;
  preflight's hand-apply hints that name 075 go on to 077, whose body a lone
  075 re-apply would replace.

**Why.** `prefer_current` (059) demotes a thought by its own lifecycle. A
session summary has none, and its one `supersedes` slot holds its own
checkpoint chain, so on "what should we work on next" the brain returned
summaries recommending finished tickets above the tickets' own Done rows.

**Measured after.** The first registration failed: its four rules (central,
central without the header key, central with a body-share fallback, body share
alone) each flipped the measured case and each demoted a hit both graders call
current, every one naming an open ticket. The second, with an open veto,
written before it ran: `central+share-veto` qualifies and wins over
`central-veto` (H1–H4 stale hits 8 against 11; 17 under shipped search), no
labelled current hit demoted in any of its windows, the plan's rank unchanged.
It moves 146 of the 563 lifecycle-less thoughts nothing supersedes. The
held-out queries share most hits with P1–P4 (outside every P/C window both veto
rules leave 0 stale hits, shipped search 1), so their stale comparison is not
out-of-sample evidence; the round-2/3 current hits no veto rule demotes are.
On a copy of the dogfood brain migrated to 077, `--sql-check`: the SQL equals
the rule on all 1,464 thoughts and the ranking the oracle on all 12 queries.
Cost on that copy (480 interleaved pairs): +5.1 ms per prefer_current search
(paired median, +6.0 at p90) over 075's 4.5 ms; the hybrid alone 1.7 ms.

**Held.** test-schema [69]: the two functions' contract; the SQL against the
rule on 10 hand cases and a 400-case seeded fuzz (a key beside `é` or `_`, the
header past line one, topics that are not strings, lower case); who is demoted
and why, the weight once, the veto, a ticket row's and a note's own lifecycle
first; one ticket's completion moves exactly the two thoughts naming it and
writes none (no audit row, no `updated_at`); an operator's REVOKE kept.
test-upgrade [20aa]: refused without 068 or 075, naming each; onto a populated
brain at 076 every other row answers as before and nothing moves; a re-apply a
no-op. test-server and test-e2e-sql: the reason's line, the token, the note,
a summary demoted over MCP. The eval's self-check kills 21 mutants; dropping
the veto from 077's SQL fails `--sql-check` on 583 thoughts and 11 queries.

**Review passes.** PR 1's first pass (definitions, run-it, cold read) changed
no verdict; its table:

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | "held out" queries mostly re-surface P/C hits; the stale gain is not out-of-sample | cold read | stated; H stale@10 also outside every P/C window |
| 1 | (b) saw labelled rows only; a demoted unlabelled window row passed | cold read | verdict withheld until every demoted row is labelled (round 3) |
| 1 | the census counted superseded rows (already demoted) as moved | cold read | excluded: 208 → 146 |
| 1 | (b)'s amendment unmarked; each registration coded with the other's scope; (a)/(c) true when the baseline lacked the row | run-it, cold read | marked; per-registration scope; n/a |
| 1 | the self-check passed with the fixture deleted or labels decoded shifted; tie-breaks, dedupe and pick untested | mutant | each held |

**Not taken.** A stored reference table kept by triggers (068's shape) would
take the +5.1 ms off the read at a write-time cost; not built until the read
cost matters. A set-based pass over the window saved about 2 ms of it on the
copy, at a second copy of the rule. Re-deriving a stale summary (SMD-2243's
pool). Stale hits remain (14 of 21 on P1–P4) where a summary also names an open
ticket; a finished plan with no key is invisible; the header key couples the
rule to the session hook's format.
