# 318. The board-findings poster skips pairs of closed tickets and comments on the open side (SMD-2932)

**What changed.**
- **`db/board-findings.ts` selection.** It reads each side's current status from 068's `ob1_ticket_head`, through its key `md5(issue)::uuid`. A ticket is closed when its head's `status_type` is `completed`, `canceled` or `duplicate`; Linear gives Duplicate a type of its own, so `canceled` alone missed it. When the head carries no status (a hand capture superseding the Linear row becomes the head under 068's rule), the ticket's newest Linear row decides; a ticket with no status anywhere counts as open, and an unknown never reads as NULL. A pair of closed tickets is left out of the pair rule, so it is not posted until either ticket reopens.
- **Placement.** A finding carries `olderClosed` and `newerClosed`. `groupFindings` puts the comment on the newer ticket of the best finding, as before, unless that ticket is closed and the other is open; then it goes on the open one. The record's `posted_on` follows.
- **Grants.** `findingsSchemaProblem` names `ob1_ticket_head` among the capture group's reads.
- **Unchanged:** the record's key, the marker, the cap and the egress gate. `brain_info`'s board counts still count every board pair.
- **Docs:** the poster's header, and db/README.md's findings section.

**Why.** A read-only dry run on the dogfood stable, after its first sleep cycle (1,577 relations), would have commented on 568 pairs at 5 a day:
- 197 had both tickets closed, including 9 of the top 20;
- 281 had one closed, and the comment could land on the closed one.

A comment asking someone to link two finished tickets is the least useful kind, and each spends a slot open work could use.

**Tests.**
- **db/test-board-findings.ts** (2 new): placement for both open, newer closed with older open, older closed, and both closed; read on the pair's best finding.
- **db/test-live.ts [41]** (3 new):
  - two closed tickets (completed, duplicate) get no request and no row, and are not selected;
  - a canceled newer ticket with an open older one gets its comment on the older, with `posted_on` set to it;
  - one of the closed pair reopened is posted, on the reopened ticket;
  - a closed ticket whose head is a hand capture with no status is still closed, so a pair of closed tickets stays unposted;
  - a role without SELECT on `ob1_ticket_head` is told so.
- **Mutants:** 11, all killed:
  - the filter dropped;
  - one closed ticket enough to skip a pair;
  - placement ignored, or ignoring the older side;
  - each closed type left out in turn (completed, canceled, duplicate);
  - the older flag read from the newer side;
  - the newest-Linear-row fallback dropped;
  - an unknown status read as NULL;
  - the grant check dropped.

**Measured after.** A read-only dry run on stable with this branch's code: 373 pairs, from 568 (the sleep scheduler judged one more pair during review). Checked against `ob1_ticket_head`: none has both tickets closed, and none is placed on a closed ticket while the other is open. 282 have one ticket closed, commented on the open one; 91 have both open. All 197 pairs dropped have both heads closed. 73 comments moved to the other ticket. Every head lookup is a primary-key probe (about 47 ms on stable).

The first run of this branch counted only `completed` and `canceled` and found 390 pairs. The difference was Duplicate tickets, whose type is `duplicate`. That run is why the closed set has three types, and why [41] has one fixture of each.

**Review pass.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | A hand capture carrying `issue` that supersedes a closed ticket's Linear row becomes its head under 068's rule, with no status, so the ticket read open and a pair of closed tickets could be posted on one of them (no stable head is non-Linear today). The newest Linear row decides when the head has no status, and an unknown never reads as NULL | run-it | this commit |
| 1 | 058's `node_settled_types()` is `{completed, canceled}`, so the poster's set is a third definition of settled; filed as SMD-2935 | cold read | SMD-2935 |
| 1 | The "Measured after" counts did not add up (a parse dropped the log's first comment); the README's Grants bullet, a source comment and the header's wrap | cold read | this commit |

**Follow-ups.** SMD-2935: 058's `node_settled_types()` lacks `duplicate`, so node_state and graph-centrality read stable's 16 Duplicate tickets as unsettled. Once it holds the type, `closed()` reads it, and there is one definition of settled.
