# Claim validity: a thought's state on three axes, read from the records that already exist (SMD-3887)

An architecture decision record. **Proposed on 2026-11-19.** The maintainer decided two rows before it was drafted: a thought no record speaks against reads **unchallenged**, not unknown and not supported (row 3); and a `pr:` or `version:` subject key takes its repository from the pull request's URL or from a brain setting (row 13). Every other row is proposed here, and the ticket asks for the maintainer's review of this record before the read is built. Nothing here is built yet. "Order" maps each row to the pull request or ticket that builds it.

## Terms

- **Thought:** a row of `thoughts`. A ticket row (board-sync's, `metadata.issue`) is a thought too; its lifecycle is the board's, read through `node_state` (058, 068), and this record does not restate it.
- **Record:** a table, column or facet that already says something about a thought: a pointer, a proposal, a relation, a citation, a lineage row, an audit event.
- **Version:** which text of a thought a record was made on: the thought's id with its `content_fingerprint` (003), or one audit event's `seq` (050).
- **Axis:** one question asked of a thought. This record keeps three: **validity** (does it still hold), **review** (did someone decide on it), **freshness** (have the views derived from it caught up). Each has its own states, read from its own records.
- **Settled part:** a statement inside a thought that a later thought settles, while the thought itself still stands. SMD-4446 builds its store (decided on SMD-3340, 2026-11-19). Nothing stores one today.
- **Challenge:** a record that says a thought may not hold: a pending or stale supersession proposal that names it as the side that falls, or as one side of an undirected conflict.

## Why

Whether a thought still holds is answered on main by several records, each in its own words, and no read puts them together:

- **The `supersedes` pointer** (025), on the newer thought. It is shown as `⚠ Superseded by a newer thought` (`server-portable/render.ts:786`, `:1001`, `:1128`), and `node_state.superseded_by` (068's `ob1_superseded_by`) demotes the older thought under `prefer_current` (059; 075 and 077 carry that demotion in today's bodies).
- **Supersession proposals** (029): `pending`, `accepted`, `rejected`, and since 063 `stale`. A pending conflict leaves both sides reading plain in search and fetch. The write-path eval's reader marks a thought contested by reading the proposal list itself (`evals/write-path.ts`).
- **Judged relations** (084, 102): `related`, `evolves`, `duplicate`, `distinct`, and thread edges (120), which are `evolves` with a subject key.
- **Citation facets** (042): active, expired or superseded, detached when their source is deleted.
- **The lineage mark** (063): `derivations.stale_since` and `stale_reason`.
- **"Moved since written"** (SMD-2540, `render.ts:793`), for the tickets a note names.
- **The event's valid window** (046): `thought_audit.valid_from` and `valid_until`. SMD-2011 owns it.

The tickets filed beside this one, SMD-3895 to SMD-3903, would each invent their own words for these states. SMD-3900 needs to leave out what is not fit to act on, and it is blocked until a read says what that is.

Three questions are not kept apart in words. One thought can be unchallenged, never reviewed and out of date at once: no proposal contests it, no one has decided on it, and its entities were extracted from a text that has since been edited. A single word for all three would hide two of them.

Versions exist and are never named for a claim. A record that says "thought X" without the version it read cannot tell a later reader whether it still applies.

## Measured

Stable, 2026-11-19, read-only queries on `open-brain-postgres-1` (v2.2.0, migration 147). The queries are in this record's ticket.

| What | Count |
| --- | --- |
| Thoughts | 4,347 |
| ... ticket rows (`metadata.issue`) | 1,419 |
| ... notes (everything else) | 2,928 |
| Thoughts holding a `supersedes` pointer / thoughts a pointer names (several may name one; here none do) | 706 / 706 |
| ... the newer thought written by `session-hook` | 680 |
| ... both sides written by the same key | 700 |
| Supersession proposals: pending / accepted / rejected / stale | 2 / 2 / 127 / 0 |
| Notes under a pending proposal | 4 |
| Notes any validity record speaks for (a pointer on either side, any proposal, a citation) | 1,352 of 2,928 |
| ... by writer kind: agent / ingested | 1,326 of 2,201 / 26 of 727 |
| Citation facets | 0 |
| Audit events with `valid_from` or `valid_until` set | 0 of 17,259 |
| Standing judged relations (related / evolves / distinct) | 2,922 / 1,581 / 3,199 |
| ... either side edited since judged | 1,526 of 7,702 |
| Standing thread edges (`evolves`, origin `thread`) | 2,495 |
| Lineage rows marked stale (`stale_since` set) | 0 |
| Lineage artifacts whose input's fingerprint has moved: entities / relation / proposal / metadata | 672 / 1,586 / 66 / 10 (2,334 in all) |
| Standing subject keys: `ticket:` / `pr:` / `phrase:` / `version:` (facets, distinct keys) | 4,119, 1,679 / 111, 82 / 51, 37 / 22, 10 |

What the counts say:

- **Supersession on this brain is mostly revision, not contradiction.** 680 of the 706 pointers are the session hook replacing its own earlier summary of a session (a compaction's checkpoint, then the session's end). The pointer says "a newer text of this replaced it", which is what superseded means here, and it rarely says "this was found wrong".
- **Most notes have no record bearing on whether they hold.** 1,576 of 2,928 notes have no pointer, no proposal and no citation. If "no record" read unknown, half the brain would be unknown, and every ingested note but 26.
- **Nothing reads supported today.** No citation facet exists: `record_citation` (042) has no caller.
- **Freshness cannot be read from the mark.** No lineage row is marked stale, yet 2,334 derived artifacts were made on a text that has since moved: 672 entity extractions, 66 proposals, 10 tag sets and 1,586 relations. The relation count is every relation's lineage, standing or closed, judged or thread, so it is larger than the 1,526 standing judged relations edited since judged. That is by design: 063's own column comment says `stale_since` is "Not staleness — that is the fingerprint read — but the request" for a re-run. The relations read already compares fingerprints (`server-portable/store-sql.ts`), and labels the result `edited since judged` (`render.ts:1051`).
- **No event declares a valid window.** The server's write event carries `trust` only (`server-portable/store.ts`, `WriteEvent`), so 046's columns are empty.

## The decision

| # | Decided | Status | Chosen over |
|---|---|---|---|
| 1 | **Three axes per thought: validity, review, freshness.** Each is read from its own records and none is inferred from another. A read that reports one reports all three. | proposed here | one combined state; validity alone, with review and freshness as notes on it |
| 2 | **Validity has six states,** read in this order of precedence: **superseded**, **contested**, **unresolved**, **supported**, **unchallenged**, **unknown** (the table below). A state the records read can establish stands even when another record could not be read. A state that rests on an absence (supported, unchallenged) becomes **unknown** when any record that could have spoken against it was not read. | proposed here | the ticket's list as written, with "under review" a validity state (it is the review axis's, row 5); "unresolved" for a pending undirected conflict (that is contested, with its direction) |
| 3 | **A thought no record speaks against, and none for, reads unchallenged.** Unchallenged is not supported: it says the records were read and none contests the thought, never that anything backs it. Unknown is kept for what could not be read. | **decided by the maintainer (2026-11-19)** | unknown for every thought no record speaks for (on stable, 1,576 of 2,928 notes) |
| 4 | **Each move between validity states names the record that makes it and who may write that record** (the transitions table below). The actor is the key, stamped by the database (050, 114), never a payload's claim. The read moves nothing: it reads the records as they stand. | proposed here | a validity column on `thoughts`, written on each move; a state machine with its own table |
| 5 | **Review has five states, in this order of precedence: pending, decided, checked, unchecked, none.** **Pending:** a proposal naming the thought awaits a decision, `pending` or `stale` (a stale row is undecided: 063's check holds `reviewed_at` null for both). **Decided:** a key accepted or rejected one, and none is pending; the read gives the newest decision's key, its kind (114's stamp), and whether it was the pass's own settle (067's `settled by the pass:`) or a key's review. **Checked:** the thought is a deliverable (134) with a verification, `verified` or `corrected` as its outcome, named beside the state; the read says whether its checkpoint is the thought's current text only when the checkpoint is a content fingerprint (a commit checkpoint cannot be compared). **Unchecked:** the thought is a deliverable still `unverified`. **None:** no proposal names it and it is no deliverable. Every decision and check is listed. | proposed here | review folded into validity (an accepted proposal already moves validity, and the reviewer is the review axis's fact) |
| 6 | **Freshness is the fingerprint read, per derived kind, over the artifacts that still stand.** It reads each lineage row with the thought among its inputs (chunks, entities, metadata, vector, subject, relation, proposal, section) whose artifact is a current view of the thought: a standing relation or subject facet, a `pending` or `stale` proposal, and every row of the other kinds. A closed facet and a decided proposal are history, which no re-run rewrites (067 keeps a key's decision), and are not read for freshness. Each kind read is **stale** when an input's fingerprint no longer matches its input's text and no re-run is asked; **requested** when a rebuild has asked for a re-run (`stale_since` set), whether or not the text moved (a forced rebuild asks on an unmoved text); **legacy** when the row is 061's backfill (`legacy: true`) and its fingerprints still match; **current** otherwise. The fingerprint read wins: a legacy row whose text moved reads stale. The thought's freshness is the worst of its kinds in that order (stale, requested, legacy, current), every kind listed; a thought with no such lineage row reads **none**. A stale kind no pool re-runs (the tags and a generated section: 063 marks them for the operator) says so, so a reader knows only an operator's rebuild clears it. | proposed here | reading `stale_since` alone, which on stable reads all 2,334 moved artifacts as current |
| 7 | **A version is a thought's id with its `content_fingerprint`; an event's version is its audit `seq`.** The read returns both for each thought: its fingerprint now, and the `seq` of the newest event in its log, of any kind. A record written after this one that cites a thought names the id with its fingerprint, never a bare id. Today `derivations`, `supersession_proposals` and `thought_forgotten` do; a citation's `source_id`, a relation's `target` (its lineage row holds the fingerprints), `thought_audit.cites` and `deliverable_events.spec_ref` do not, and are read as unversioned. | proposed here | the audit `seq` as the only version (a seq names one write, and a write that changes only metadata leaves the text as it was, so two seqs can name one text); a version number per thought |
| 8 | **A revision trigger record has six fields:** what started it (an edit, a pointer set or cleared, an accepted proposal, a lapse, a forget, a trust change); the versions it touched, before and after; the reason, free text as 063's `stale_reason` is (a forget, an edit, a trust change, an operator's sweep; SMD-3901 decides whether to close the set); the actor, from the key; the scope (the thoughts and derived kinds it reached); and when. This record fixes the fields. SMD-3901 builds the record. | proposed here | each revision ticket defining its own trigger shape |
| 9 | **A judge's number is raw model output, and a read says so.** A proposal's `confidence` (029) and a relation's `payload.confidence` (084) are uncalibrated. A relation's is the word's token probability where the endpoint returns a distribution covering at least half the mass (`MIN_COVERED`), else the number the model wrote, and a `related` folded with `evolves` holds the two words' sum (`relationConfidence`, `server-portable/consolidate.ts`). SMD-1809's `evals/eval-calibration.ts` measures the proposal's number against reviewers' decisions; nothing measures a relation's, and no read applies either measurement. The new read returns each under `judge` with `calibrated: false`. The existing listings (`render.ts:1051`, `:1245`) keep their text until a ticket changes them. | proposed here | rewording the existing listings in this ticket (a change to a default read's output, which this ticket's Verify rules out) |
| 10 | **Identity is not validity.** A thought's subject facets (111, 130), the sweep's keyed attempts, its thread edges (120) and its judged `related`, `evolves`, `duplicate` and `distinct` relations say what a thought is about and what it sits beside. None says whether it holds, and none moves its validity. Code-artifact timelines (SMD-3207) and the work-thread read (SMD-3306) stay with their tickets. | proposed here | an `evolves` read as "superseded in part" (an evolves "settles nothing", SMD-3116's definition) |
| 11 | **The read stands beside `node_state`, and does not extend it.** `node_state` is the one read search ranks by: `search_thoughts_current` inlines it, and test-schema reads that plan (059). A column added to it changes its `RETURNS TABLE` and re-creates every function that reads it. The validity read labels and ranks nothing. It reads superseded from the same projection (`ob1_superseded_by`, 068), so the two never disagree. | proposed here | new `node_state` columns, read by search |
| 12 | **One read-scoped operation, `validity`, over REST and MCP alike,** backed by one SQL function. It takes up to 100 thought ids and returns, per thought: its version, each axis's state, the records each state was read from, the judges' numbers under `judge`, and what it could not read (`unread`, by record kind). An id that is not a thought answers not found; a forgotten one answers forgotten (139's ledger), with no text. It labels only: no default read's output and no ranking changes. | proposed here; the names are the plan's | a flag on `search` and `fetch` (that is SMD-3900's eligible mode, built on this read); a read per axis |
| 13 | **A `pr:` or `version:` subject key names its repository:** `pr:<owner>/<repo>#<n>` and `version:<owner>/<repo>@v<n>.<n>…`, the owner and repository lowercased. The repository comes from the pull request's URL when the thought's text has one, else from a brain setting the operator sets. A brain with no setting keeps today's unscoped keys, and both shapes stay valid. Setting it maps the brain's unscoped keys to it, with their threads kept (the plan says how). `ticket:` keys keep their shape: the team prefix scopes them. | **decided by the maintainer (2026-11-19)**: the repository from the URL or a brain setting | leaving keys unscoped until a second repository is ingested (SMD-3011); naming this repository in a migration every brain runs |

### Validity states

| State | Read from | Means |
|---|---|---|
| **superseded** | A standing `supersedes` pointer names it (`ob1_superseded_by`, 068) | Another thought replaced it whole: usually a newer one, but a reviewer's accept can point the older thought at the newer (036's direction). The read names the superseding thought, the key that wrote the pointer and whether a reviewed proposal did. |
| **contested** | A `pending` proposal names it as the side that falls (the older for `newer_supersedes_older`, the newer for `older_supersedes_newer`, either side of a `conflict_undirected`), and both texts are as judged | A judge said it may not hold, and no one has decided. The read gives the proposal, its verdict and its judge's number. |
| **unresolved** | A `pending` or `stale` proposal names it as the side that falls, and the challenge cannot be read as standing: a side's text has moved since it was judged (its fingerprint differs from the one the proposal holds, as 036's `EDITED_SINCE` reads it; an unknown fingerprint counts as unchanged), or the row is `stale` (a rebuild, forced or on a moved text, asked the pass to judge it again: 063, 067) | A challenge stands on a text that is not the one it was made on, or awaits a fresh judgement. The read says which. The stored status alone would miss most of these: nothing calls `rebuild_derived` on an edit (its callers are `db/rebuild.ts`, sleep's orphans-only sweep and `forget_thought`), so a pending proposal on an edited text stays `pending`. |
| **supported** | An active citation (042) on it whose source stands, is not superseded and is not contested | Something backs it. On stable today, nothing: there are no citations. |
| **unchallenged** | Every record above was read and none applies | The records were read and none contests it (row 3). |
| **unknown** | A record that could have applied was not read | The read cannot say. It names what it did not read. |

A **partly settled** mark joins when SMD-4446's store lands: an accepted settled part says a statement in the thought no longer holds, while the thought stands. It sits beside the state, never in place of it, as SMD-4446 decides ("a part never sets `supersedes` and never demotes a thought").

### Transitions

Each move is made by a record, and the read follows the record. "Write key" means a key of write scope at the door (`server-portable/tools.ts`); the SQL functions record the scope and mostly do not gate on it (049), with the exceptions named.

| Move | Record | Written by | Who may |
|---|---|---|---|
| → superseded | a pointer set on the newer thought | `upsert_thought` (capture's `supersedes`, 080); `update_thought` (099); an accepted proposal, through `update_thought` (036) | a write key. A capture key only onto its own capture that no other key has taken and that nothing supersedes yet (`ob1_check_capture_pointer`, 092, refuses with OB004); the server then drops the pointer and writes the capture without it |
| superseded → the state below it | the pointer cleared | `update_thought` with `supersedes: null` (099); a reject of the accepted proposal that wrote it (036 clears that pointer, and only that one); a lapse (104); the newer thought deleted (025's `ON DELETE SET NULL`) | a write key; a lapse is the trigger's, when another key takes the capture key's thought |
| → contested | a proposal recorded `pending` | `record_supersession_proposal` (063), from the consolidation pass | the pass's key |
| contested → superseded | the proposal accepted, and its pointer written | `review_supersession_proposal` (036) | any write key, an agent's included (SMD-3338); the reviewer is stamped from the key (114). The side that falls is the one the reviewer's direction names: an accept may go against the verdict, and an undirected verdict needs a direction (036's `p_direction`), so the contested side can end up the superseding one |
| contested → the state below it | the proposal rejected | `review_supersession_proposal` (036) | any write key. The pass never settles a pending row (067 settles a stale one only) |
| contested → unresolved | a side's text edited: its fingerprint moves away from the one the proposal holds | `update_thought` (099) | a write key; the proposal's row is unchanged, and the read compares fingerprints |
| contested → unresolved | the proposal marked `stale` | `rebuild_derived` (067), on a moved text or under `p_force` on an unmoved one | the database, on an operator's rebuild (`db/rebuild.ts`) |
| a lower state → unresolved | a rejection the pass itself made (`settled by the pass:`) reopened as `stale` | `rebuild_derived` (067), as above | the database, on a rebuild's request. A key's rejection is kept |
| unresolved → contested, or the state below it | the pass judges a `stale` row's pair again: the row replaced `pending` with the texts' current fingerprints, or settled `rejected`. A `pending` row on a moved text is not re-judged until a rebuild marks it `stale` | `record_supersession_proposal`; `settle_supersession_proposal` (067) | the pass's key |
| unresolved → superseded, or the state below it | a reviewer decides the row: an accept, or a reject | `review_supersession_proposal` (036) | any write key. An accept needs `p_force` whenever a side's text moved since judged, `pending` and `stale` alike (036's `EDITED_SINCE`); a row made stale by a forced rebuild on unmoved texts needs none |
| contested or unresolved → the state below it | the other side deleted or forgotten: the proposal goes with it | 029's `ON DELETE CASCADE` on both sides | whoever may delete or forget that thought (a write key) |
| → supported, and back | a citation recorded, expired, superseded or detached | `record_citation` (042); 042's delete guard | no caller writes a citation today |
| any → gone | the thought forgotten | `forget_thought` (139, 144) | a write key. The read answers forgotten, from `thought_forgotten`, and returns no text |

A deleted thought (`delete_thought`, 060) is not a state: the read answers not found, as `fetch` does.

## The shape

The read is one SQL function and one core operation. Its names and file layout are the plan's, in PR 2. Its answer, per thought:

```json
{
  "id": "…",
  "version": { "fingerprint": "…", "seq": 1234 },
  "validity": { "state": "contested", "records": [ { "kind": "proposal", "id": "…", "status": "pending", "verdict": "newer_supersedes_older", "falls": "this", "judge": { "confidence": 0.83, "calibrated": false } } ] },
  "review": { "state": "pending", "decisions": [] },
  "freshness": { "state": "stale", "kinds": [ { "kind": "entities", "state": "stale", "produced_by": "…", "moved": ["…"] }, { "kind": "vector", "state": "current" } ] },
  "unread": []
}
```

An id the caller gives twice is answered once. An id beyond the cap is refused, naming the cap.

## What this reverses or amends

- **Nothing that is built.** No default read changes. `node_state`, `prefer_current` and every label keep their behaviour.
- **SMD-3887's own list of states** is amended: "under review" moves to the review axis (row 5), and "unresolved" means a challenge that cannot be read as standing (a side's text moved since it was judged, or the row is `stale`), not an undirected conflict (row 2).
- **The subject key shapes** in `subject_key_valid` (111) and `server-portable/subject.ts` gain the repository (row 13). `docs/subject-anchored-claims.md` names no key shapes, and is unchanged.

## Order

| Piece | Builds | Depends on |
|---|---|---|
| SMD-3887 PR 1 | This record | — |
| SMD-3887 PR 2 | Rows 1 to 7, 9, 11 and 12: the SQL function, the `validity` operation over REST and MCP, its tests | the maintainer's review of this record |
| SMD-3887 PR 3 | Row 13: the brain setting, the key shapes in `subject_key_valid` (111) and `server-portable/subject.ts`, the sweep's URL read, the mapping of existing keys with their threads | — (independent of PR 2) |
| SMD-3901 | Row 8's revision trigger record | PR 2 |
| SMD-3900 | The eligible mode and the revalidation read, over this read | PR 2 |
| SMD-4446 | The settled-part store; the partly settled mark joins the read when it lands | — |
| SMD-2011 | The valid window on `thoughts`; the read gains it as one more input when it lands | — |

## Not decided here

- **What is fit to act on.** Whether an unchallenged thought, or a fresh one, is eligible is SMD-3900's decision, over this read.
- **The valid window.** Assertion time and valid time are SMD-2011's: columns projected from 046's window, a valid-now flag and a `valid_at` read. This record names the window as one input to come, and repeats none of that work.
- **"Moved since written."** It reads a subject's timeline against a thought's age (`docs/subject-anchored-claims.md`, row 1), not the thought's own validity, and SMD-2540's eval found that reading what a note states about a ticket is not reliable (precision 0.500 to 0.567). It stays a label where it is.
- **Calibrating the judges.** Row 9 says the numbers are raw. Mapping them onto measured rates is a ticket of its own, from SMD-1809's ledger.
- **Rewording the existing listings.** The proposal listing's `[confidence 0.83]` and the relations read's `confidence 0.83` keep their text here.
- **Provenance and support structure.** How a thought's content was obtained (SMD-3895) and which sources suffice for a conclusion (SMD-3896) use this record's words, and decide their own records.

## Related

- SMD-1729 (the claim-log parent).
- SMD-3895 to SMD-3898 and SMD-3900 to SMD-3903 (the tickets that use these words); SMD-3900 and SMD-3901 build on the read.
- SMD-2011 (the valid window); SMD-4446 and SMD-3340 (settled parts); SMD-3306 (threads); SMD-3011 (a second repository); SMD-1809 (calibration); SMD-2074 (`node_state`); SMD-3338 (who may review a proposal).
- `docs/event-log-as-truth.md`: the log of record, and the versions it carries. `docs/subject-anchored-claims.md`: subjects and their timelines. `docs/priority.md`: the same shape of record, for priority.
