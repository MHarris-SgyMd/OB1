# 272. A capture-only key cannot state a ticket's lifecycle — other keys' thoughts no longer read a status it forged (SMD-2617)

**What changed.**
- **The refusal.** `core/writes.ts`' `metadataProblem` refuses a key that cannot read (the capture scope) the four ticket keys, `TICKET_META_KEYS` in `core/refusal.ts`: `issue`, `status`, `status_type` and `linear_updated_at`. The code is `REFUSED_METADATA_SHAPE` with the new problem `ticket_key`, checked with the other metadata shapes, before the embedding and extraction calls. The text names the key and the four: "Refused: `metadata.issue` states a ticket's lifecycle, which a capture-only key may not set (…) — drop it, or capture with a key that can write."
- **Both doors.** The MCP tool and the REST core's `POST /v1/thoughts` share `capture`, so both refuse it, a request forwarded under a capture key's credential included; REST answers 400.
- **The structured reply.** `REFUSED_METADATA_SHAPE` declared no facts, so a client reading values could not tell which key to drop. It now carries `problem` always, and `key` unless the key itself is malformed: a badly shaped key is the caller's raw input, and stays in the text alone.
- **The tool's description** of `metadata` names the four keys for a capture-only key, from the same rendering of `TICKET_META_KEYS` as the refusal's text.

**Why.** The capture scope promises a key it cannot alter a thought it did not write; SMD-2473 closed `supersedes` and SMD-2539 the re-capture merge. A fresh capture's own metadata still reached other thoughts through 068's ticket head. `ob1_ticket_heads_of` picks a ticket's head from any row carrying `metadata.issue`: of the rows nothing supersedes, the newest `linear_updated_at`. It does not check source, writer or trust. `node_lifecycle()` then gives every row carrying `ticket` or `issue` the head's status, and 077's `ticket_references_settled` names a summary whose central tickets' heads are all settled, which `prefer_current` demotes. SMD-2539's review pass 3 showed it on the real server: a capture key's capture with the ticket's `issue`, `status_type: "completed"` and `linear_updated_at: "9999-12-31…"` became the head, and the writer's ticket row and its note read done, ranked ×0.25 by `prefer_current`, with no event on either row. A watermark newer than the brain's, up to an hour past its clock, also moved `brain_info`'s board-sync watermark.

Board-sync's grouping reads `metadata.issue` too, so the forged row joined the ticket's group. A forged `status` that differs from Linear's makes the ticket stale, and the next pass chains the real row over it, ending the forgery while Linear's text has not moved; once it has, the pass rewrites the forged row as the ticket row and chains the real row behind it. A forged row whose `status`, `project` and labels match Linear's (labels only on a ticket without any: a capture key's values are scalars, and board-sync compares labels as a list) makes `planPass`, which judges the names on the row with the newest watermark, call the ticket unchanged, and the forged `status_type` stands.

A second route needs no `issue`. A capture key's text in board-sync's ticket-header shape is adopted by its header scan into the ticket's group, as a hand capture would be. With a far-future `linear_updated_at`, and a `status`, `project` and labels matching Linear's as above, `planPass` calls the ticket unchanged while its state, project and labels stay as they are, so Linear's edits to its text, priority or relations never reach the brain. Refusing either `linear_updated_at` or `status` closes it.

**Decisions** (the maintainer's, at the plan stage):
- **Where:** the server, for a capture-only key. A head rule that trusts only board-sync's rows has nothing on the row to key on: board-sync writes as the name `board-sync` without an agent id, a row whose text was last changed by someone else keeps that writer's name (050), and `ingest-records`' Linear adapter writes under any `--actor`. A `thought_sources` row can be missing until board-sync next fetches the ticket, and the audit row's door would have the head rule read the log on every ticket write. Making board-sync ignore rows it did not write would change its hand-capture adoption.
- **Which keys:** the four a ticket's lifecycle is read from. `issue` is the claim, and `linear_updated_at` and `status` each feed the header route above. `status_type` alone changes only how the key's own row reads; it is reserved so that the rule reads as one.
- **How:** refused, naming the key, not dropped in silence. That matches the reserved keys' refusal, and the session hook mends a metadata refusal by dropping the metadata and posting again.

**Before upgrading.** Nothing to apply; the server alone. The session-capture hook sends none of the four keys. A capture-only caller that sets `issue`, `status`, `status_type` or `linear_updated_at` in `metadata`, for a ticket or not, is refused: drop or rename the key, or give it a write key.

**Held.**
- `test-e2e-sql` [13d], the ticket's Verify, on the real server:
  - a write key captures a ticket row, a note filed under it and a session summary of the ticket;
  - a capture key's capture with each of the four keys is refused, the key and the four named in the text and the key in the structured reply; the whole forged head writes nothing, and no refused capture's text reaches the model stub, which the capture key's accepted note does reach;
  - the head is still the writer's row, the ticket row and both notes read started and open, the summary references nothing settled, and `prefer_current` does not demote it.
- `test-rest-sql` [6] and [6b]: a capture key's `status_type` is a 400 naming `ticket_key` and the key, and so is one forwarded under its credential; a write key's ticket row is a creation; a reserved key's and an over-long value's refusals name the key, and a bad key's carries the rule alone.
- `test-rest` [2]: the capture body's `metadata` description names the bound and each ticket key.
- Drop-the-mechanism and invert-the-condition mutants: 9 before review, 5 on pass 1, 4 on pass 2 and 2 on pass 3, each killed.

**Review passes.**

| Pass | Finding | Caught | Fix |
|---|---|---|---|
| 1 | a capture-only key that captures a text first owns that row for good: after a write key's capture merges onto it, or board-sync adopts it as a ticket's row, the key can still mark it superseded | run-it | outside this path: SMD-2638 |
| 1 | a capture key that captures a record's text first keeps `ingest-records` from landing it, reported as skipped | cold read | outside this path: SMD-2639 |
| 1 | the summary leg of [13d] could not fail: a summary naming the ticket once in its body is never demoted, forged head or not | cold read | the summary opens with its session header, which makes the ticket central |
| 1 | the structured reply's `key` rule, the four keys' list in the text, and the check before the model calls were held by no test | mutant | one assertion each |
| 1 | the tool description wrote the four keys out a second time | cold read | built from `TICKET_META_KEYS` |
| 2 | a forwarded capture key, the tool description and an over-long value's reply were held by no test, and the no-model-call check had no positive control | mutant | one assertion each |
| 3 | a capture key's `metadata.importance` decides the weekly digest: ten captures rank every other key's thought out of it | run-it | outside this path: SMD-2653 |
| 3 | the structured reply left out the key of a well-formed key's bad value, for no reason the comment gave | cold read | the key unless it is itself malformed |

**Not taken.**
- **A forged row already in a brain** is not looked for: the shipped hook never sends these keys. The audit row names the key, not its scope; such a row is found by its audit rows' `canonical_agent_id` against `ob1_agent_keys.scope = 'capture'`, or its `actor_name` against the keys `MCP_ACCESS_KEYS` gives the capture scope; both read each key's scope now, not at the write. Before 080 a capture key's re-capture could also have merged `issue` onto another key's row, as an `update` event.
- **A capture key's pasted ticket header, or a capture of a ticket's next text,** is still adopted by board-sync as a hand capture is, and the capture key can still mark the adopted row superseded (SMD-2638).
- **`source: "linear"` and `project`** stay open. Without `issue` they change only the key's own row: its genre, and a name read only for rows in a ticket's group.
- **A capture key's near-duplicates** queue consolidation proposals that its row supersede other keys' older thoughts; each needs a reviewer's accept.
- **`importance`** stays open: the weekly digest ranks on it from any row (SMD-2653).
- **An items file's facets** (SMD-2227) and **a capture key's text in the shared entity graph** (SMD-2618) are other doors.

**Follow-ups.** SMD-2638 (a capture key's ownership survives another key's write), SMD-2639 (ingest-records skips a squatted record), SMD-2653 (a capture key's `importance` decides the weekly digest).

**The version.** PATCH: no schema change, and `metadata` keeps its meaning. The one client it can break is a capture-only key that sets one of the four for its own purpose; Before upgrading names it, and the refusal names the key, so it fails loudly. A write key's captures and every other reply are unchanged, but for the facts a metadata refusal's structured reply now carries.
