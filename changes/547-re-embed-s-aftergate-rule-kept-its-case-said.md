# 547. Re-embed's afterGate rule kept: its case said in the loop's docblock, and its row driven by the scheduler's own gate, not one that breaks Admit's contract (SMD-4401)

**Problem.** `db/claim-loop.ts`'s loop takes an optional `afterGate`, which only re-embed passes: a worker through the admit gate claims nothing once the follower has seen the record's model move. SMD-4352 PR 3 wrote its first row and recorded that the rule was reached only past a gate that does not reject when its signal aborts. That row's gate held a worker and resolved after the abort, which `db/lease.ts`'s `Admit` contract forbids: a gate a worker waits at "must reject, never resolve, once its signal aborts". So the row held the rule with a gate no caller may write, and the ticket asked whether the rule should go.

**Decision.** The maintainer's, 2026-11-18: keep it, fix the row.

**What the rule decides.** The record's read before each claim (`beforeClaim`) ends a worker that finds the record still moved. `afterGate` decides the case that read cannot: one worker sees the record moved while another is mid-thought, and the record is moved back before the second is through the gate again. The follower ends all the same, and the second worker claims no more.

The ticket, as filed, said only a gate outside the contract, or an open one that answers late, reaches the rule. That was wrong too. The loop reads `afterGate` after every pass of a gate, a wait or not, so a worker mid-thought under an open gate reaches it at its next pass. It is not read where there is no gate: an ungated follower's second worker re-embeds on under the record it reads.

**Change.**

- **The docblock.** `afterGate`'s in `claim-loop.ts` says when it is asked and which case it decides. Re-embed's line says the same in its own words. It said "after a wait at the admit gate", which the code never required.
- **The row.** [9f]'s row runs a two-worker follower under `liveGate()`, open throughout. The first call to arrive takes 1.5 s and the rest 4 s. The record is moved while both are in flight; the quick worker reads it and ends the drain, which the row sees on the signal the gate was asked with; the record is moved back. The slow worker's thought lands, and no call is made after the move is seen. The row's follower has a 30 s call timeout, the section's being 2 s.
- **SMD-4352's record.** Its row's description and its finding on `afterGate` are corrected, each saying what it said before.

No engine behaviour changes.

**What the row found out.**

- **The first rewrite's mutant lived.** Under the section's 2 s call timeout, the 4 s call ended as a deadline. Its probe was cut short by the drain's end, and the worker stopped there, before the gate, with the rule or without it. The row passed and proved nothing until the mutant was run (caught: mutant).

**Verify.** `afterGate: () => false`, run against test-live's long shard, fails this row and no other: the worker re-embeds what is left (caught: mutant). The long shard is at 373 assertions, as on main: the row replaces one. `db/test-engines.ts`, which holds the loop's own two rows for the option, passes, 738 of 738.

**Cost.** The row takes about 5 s where the one it replaces took about 1 s: its slow call is 4 s. The long shard ran 452 s in parity with it, 446 s before.

**Not in this PR.** An ungated follower has no such rule. Whether it should is SMD-4413.
