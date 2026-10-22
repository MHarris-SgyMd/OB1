# Subject-anchored claims: a claim is read against its subject's own timeline (SMD-3203)

An architecture decision record. **Decided 2026-10-22 by the maintainer**: two thoughts linked only by a subject that neither is about are distinct, and that subject's staleness is shown when either thought is read, from the subject's own timeline, as SMD-2540 does for the tickets a thought names. A pair in which one thought names the other's subject only in passing is related at most. Code artifacts are the next subject to get a timeline, a spike first (SMD-3207). The pass change SMD-3203 proposed, its item 3, waited until this record said what consolidation writes for a mediated pair, and this record now says it. By the rule fixed before a second blind rater ran, its count, 53 of the 80 evolves and related relations sampled, puts item 3 next.

The decision table marks which rows the maintainer decided, which follow from them, which this record proposes, and which are built.

## Terms

- **The bars** are the method and decision rule fixed on SMD-3203 (comment 9f10f975) before the blind sample was drawn.
- **A thought's own subject** is its main topic. The bars listed a ticket, a pull request, a release, a deployed brain, a metric, a document or a piece of work; the labels also found a table, a function and a technique.
- **A third subject** of a pair is a subject that is neither thought's own.
- **The four paths,** as the bars define them:
  - **direct:** the pair shares its own subject, or one thought is about the other's subject;
  - **half:** what relates them is one thought's own subject, and the other only relays it in passing;
  - **full:** what relates them is peripheral to both, and each relays or mentions the same third subject;
  - **none:** they share no specific subject, only words or an area.
- **Mediated** means half or full. Only a full pair runs through a third subject.
- **Settling:** a pair whose primary typed label (SMD-3116) is corrects, reverses, revises, withdraws, resolves, implements, updates or prioritizes, so that the later thought outdates part of the earlier.
- **SMD-3116's via slot** is part of a pair's label: the third subject the pair relates through, as in `resolves, via SMD-2310's blockers`.
- **The pass:**
  - The consolidation pass judges candidate pairs of near neighbours, and keeps a floor: its minimum confidence.
  - In decide mode (SMD-3115), H2O-Lightning-4B gives each verdict. For a pair it calls outdates, a writer drafts a supersession proposal; under version 3, only when P(outdates) clears the floor.
  - A pair it does not propose may get a standing relation facet: related, evolves or duplicate (migration 084), or distinct (migration 102, SMD-3117). A relation is stored only when the verdict clears the floor: for related, evolves or duplicate, the three words' combined probability; for distinct, its own. Below it, the pair's edge closes.
  - The canary ran decide version 1 (pass keys ending `@p4d1`) until 2026-10-21, and version 3 (`@p4d3`, SMD-3151) since. Version 2 was measured and shelved.
- **SMD-3203's item 3** is the pass change the ticket proposed: decide mode treating a mediated pair explicitly, which needs a new decide version and a re-judge.

## Why

SMD-3116's 27-pair check (2026-10-21, its pair 16) found two thoughts that relate only through a third subject:
- the earlier one, a session about SMD-2101, says SMD-2101 is blocked by SMD-2310, and that SMD-2310 waits on SMD-2283 and SMD-2284;
- the later one, a session on SMD-1931, ends by reporting that SMD-2310's two blockers are Done.

SMD-2310 and its blockers are neither thought's own subject. For the first thought they are a dependency of its ticket. For the second they are what its last question asked about. Labelled pairwise, as "the later one resolves the earlier", the relation has three faults:
- **It misleads.** It reads as the later thought settling the earlier one's subject, and it doesn't: SMD-2310 stayed open until 2026-10-09, so when the later session ended, on 2026-10-08, SMD-2101 was still blocked by it.
- **It grows as pairs.** Every two thoughts that report one subject's state at different times become a relation: up to N(N−1)/2 for N mentions, where the truth is one timeline.
- **It repeats what the brain holds.** Board-sync's ticket heads have both blockers' statuses.

For tickets the brain already reads it the other way, when a thought is read:
- **SMD-2540's label** (`server-portable/stated-status.ts`, migrations 095 and 098) takes the ticket keys a thought names and the time it was written.
  - It sets each ticket's status type at that time, from the audit history of the rows carrying its key, beside its head now (migration 068).
  - When the type has moved, and the ticket did not already hold its current type an hour after the note, the hit is labelled: `⚠ Moved since written: SMD-2306 In Progress → Done`. The hit's rank is unchanged.
  - A ticket row, a note filed under a ticket and a superseded thought are not checked, nor are keys past the first 50.
- **Migration 077** (SMD-2271) ranks a thought about finished work lower under `prefer_current`, from its tickets' status now, with the reason shown. Nothing is written to the thought: when a ticket completes, the next search reads it.
- **Neither reads the status a thought states.** From the text, each takes only the ticket keys it names, and SMD-2540 the session's end time. SMD-2540's eval measured readings of the stated status, at pooled precision 0.567 and 0.500 (and 0.750 where it only filtered the moved reading), and shipped none: "The text pattern is dead: it reads reported speech" (`evals/README.md`).

The question was how far that shape goes beyond tickets, and what consolidation records meanwhile.

## The decision

| # | Decided | Status | Chosen over |
|---|---|---|---|
| 1 | **A thought's claim about a subject is read against the subject's own timeline, when the thought is read.** The subject's state when the thought was written is set beside its state now, and the hit is labelled. Reading the timeline writes nothing. | proposed here; decided by the maintainer (2026-10-22) for a pair's third subject (row 2); for code artifacts, a spike first (row 6); built for tickets (SMD-2540) | relating two thoughts pairwise because each reports the same third subject, as pair 16 was labelled; reading the state a thought states (SMD-2540's eval) |
| 2 | **A full pair is distinct, and a half pair is related at most.** The pass's verdict concerns the pair's own subjects. Two thoughts about different tickets that each report a third ticket's state, or its blockers' as in pair 16, are not joined through it. In a half pair one thought names the other's subject only in passing, so neither continues nor settles the other's own subject: evolves and the settling labels overstate it, and related or distinct is right. Like any relation, it is stored only when the verdict clears the pass's floor. | decided by the maintainer (2026-10-22); not built: SMD-3203's item 3 would build it | for a full pair, a relation naming the third subject in a new payload key (a writer change, a new decide version and a re-judge), or recording nothing, not even distinct; for a half pair, always distinct, as a full pair is, or leaving it open |
| 3 | **Decide mode proposes no supersession through a third subject.** | proposed here; not built: SMD-3203's item 3 would build it | a proposal whose only evidence is a third subject's state |
| 4 | **SMD-3116's via slot is a labelling device** for review and measurement. No relation stores a third subject. | follows from 2 | a `via` key in the relation payload |
| 5 | **A subject has a timeline when its state at a past time can be read from a record of the subject itself,** not from the thoughts that mention it. For a ticket, that record is its board-sync rows: 068's head, and the audit history of the rows carrying its key (095). | proposed here; built for tickets (068, 095, 098) | a subject's state taken from the thoughts that mention it |
| 6 | **Code artifacts are the next subject to get a timeline**, a spike first. A note that names a code artifact is read against when the artifact changed. Whether that is a file, a function or both, and how one is found in a note, is for the spike to decide. | decided by the maintainer (2026-10-22); the spike is SMD-3207, its bar to be fixed before the run | deployed brains; pull requests through a GitHub sync; tickets alone until SMD-1729's claim log |
| 7 | **Deployed brains, pull requests and other entities wait.** | follows from 6 | building a timeline for each now |

Code artifacts are entities by the maintainer's decision of 2026-09-24 (`evals/README.md`, where rubric v2 counts them). Files, scripts, tables, functions, environment variables, branches and CI jobs belong in the brain's graph as tools (or as projects, for a directory of work).

## Measured

### Labelled proposals, read again (2026-10-22)

The 156 pairs are SMD-3116's 95 relabelled decide-version-1 proposals and SMD-3151's 61 blind-labelled canary proposals. 138 of them are settling.
- **Reading the headers.** Each thought's own subject was read from its header: a ticket row's key, a session summary's tickets, the ticket a change record cites, or the first ticket key in a note's first 160 characters.
- **Same header.** The 110 settling pairs that share a header ticket count as direct, unread.
- **The other 28 were read by hand.** In 18 of them the headers name different tickets; in 10, a header names none:
  - full: 1 (pair 16);
  - half: 1;
  - direct: 26. By the first rater's reading, not recorded pair by pair, they are of four kinds: a session whose header names another ticket but which worked this one; a different ticket's change fixing this one's problem; an ADR changing a design it names; or a session's own open item resolved later.

So 2 of the 138 settling pairs (1.4%) are mediated, and 1 (0.7%) runs through a third subject. Both are floors, since the 110 same-header pairs were not read: a header naming several tickets could hide a third subject both share. The 18 non-settling pairs were not classified.

### A new blind sample of standing relations (2026-10-22)

The method and bars were fixed on SMD-3203 before the draw.
- **The draw:** 40 evolves, 40 related and 20 distinct, from the canary's 4,356 standing `@p4d3` facets with those words (1,050 evolves, 923 related, 2,383 distinct). Each set was taken in `md5('smd3203-mediated-2026-10-22:' || facet id)` order, lowest first, skipping pairs read in earlier samples: 6 were skipped, all from SMD-3116's.
- **The blinding:** each rater's scoring script was fixed before that rater's first label, and every pair was labelled before the file holding its stored word was opened.
- **The record:** the texts and labels stay local, as brain text.

#### The first rater

| Stored word | direct | half | full | none |
|---|---|---|---|---|
| evolves (40) | 29 | 2 | 0 | 9 |
| related (40) | 33 | 3 | 0 | 4 |
| distinct (20) | 4 | 1 | 1 | 14 |

- **5 of the 80 evolves and related pairs are mediated:** 6.25%, with a Wilson 95% interval of 2.7–13.8%. All five are half, so none runs through a third subject, under the conventions below.
- **Six pairs turned on conventions set while labelling, not with the bars.**
  - Counted as direct: two pairs of tickets on one component, and two pairs where one thought extends the other's mechanism and cites it as its basis.
  - Counted as none: two pairs that share only a citation of the same ticket.
  - In three of the six, each thought mentions the same third ticket, which the bars' full covers: one of the component pairs, which also relays that ticket's state, and both citation pairs. All three are stored as evolves. Read that way, the share is 8 of 80 (10.0%, interval 5.2–18.5%), on the 10% line.
  - Read as mediated, all six would make it 11 of 80 (13.75%, interval 7.9–23.0%).
  - The labels record no convention field, so other calls may rest on similar readings.
- **The decision rule** fixed with the bars: at 10% or more, item 3 would be built next, beside this record; under 5%, item 3 would wait and this record come first; between, the maintainer decides. The 6.25% fell between, and the interval spans all three bands. The maintainer chose this record first, with item 3 waiting, and kept that choice when four of the six pairs were disclosed.
- **The one pair labelled full** has pair 16's shape: two thoughts about different subjects each relay a third ticket's state at a different time. It is stored as distinct, as row 2 makes the rule.
- **What the 7 mediated pairs relate through** (6 half, 1 full; for a half pair, one thought's own subject): tickets 3, a deployed brain 1, code artifacts 2 (a table and a function) and a technique 1. No pull request, release or metric appears.
- **The 6 half pairs are stored as related (3), evolves (2) and distinct (1).** Under row 2, the two stored as evolves overstate their pairs.

#### The second rater

A second blind rater, a separate model instance, labelled the same 100 pairs by the bars' wording alone, without the conventions: the maintainer's choice once all six were disclosed. Its method, and the rule applied to its count, were fixed on SMD-3203 before its first label (comment d6a37789).

| Stored word | direct | half | full | none |
|---|---|---|---|---|
| evolves (40) | 8 | 15 | 13 | 4 |
| related (40) | 13 | 15 | 10 | 2 |
| distinct (20) | 0 | 0 | 7 | 13 |

- **53 of the 80 evolves and related pairs are mediated:** 66.25%, with a Wilson 95% interval of 55.4–75.7%; 23 full and 30 half. By the rule, item 3 is built next.
- **The two raters agree little better than chance on which pairs are mediated:** on 32 of the 80 (κ 0.07). On the four paths over all 100, they agree on 46 (κ 0.32). In each of the 48 pairs they split on, the first rater said direct or none and the second half or full; the second counted all five of the first rater's mediated pairs as mediated too.
- **The second rater read the bars' words more widely.**
  - It took "peripheral to both" as "neither thought's own subject": a component that a ticket changes is a third subject, and a shared eval corpus, suite or check makes a pair full.
  - It counted a thought that changes, tests or hardens another's deliverable as relaying that subject "in passing", which makes a pair half.
  - The bars' words admit both readings.
- **What its mediated pairs relate through,** across the three words: tickets 30, other 28, a deployed brain 1, a pull request 1.

### What each subject has today (main, 2026-10-22)

| Subject | Identity | State at a past time | Where |
|---|---|---|---|
| Ticket | its key, as `metadata.issue` on its board-sync rows; 068 keeps one head per key | yes: the head now, and the status history in `thought_audit` | 068; 095 and 098; `server-portable/stated-status.ts` |
| Code artifact | an entity (016), or a path in a thought's text | not from a record of the artifact itself. A session summary lists up to 20 files edited in the span it covers, with that span's window, from the capture hook's edit events; but it is a thought that mentions the files. The fork's change records name files in their prose and carry their ingest time. The ingester's commit source, run on neither brain, carries author dates and no file list. Git has both. | 016; `recipes/session-capture-hook/session-capture.mjs`; `db/ingest-records.ts`; SMD-3006 and SMD-3011 |
| Deployed brain | its tier and compose project | `schema_migrations` records when each migration was applied, and `ob1_config.schema_version` holds only the current value. No table records the commit its image was built from; the running server reports it. | `server-portable/brain-info.ts`; `db/brain-compare.ts` |
| Other entity | 016's type and normalized name | none: no status, validity or supersession column | 016 |
| Pull request | none | none | none |

## What this amends

- **SMD-3203's title** proposed superseding a claim about a third subject on that subject's timeline. Row 1 reads the timeline instead, and writes nothing.
- **SMD-3116's via slot** marked a pair that relates through a third subject, until this record carried it. Row 2 now records such a pair as distinct, and row 4 keeps the slot for review. The blind sample also gave half pairs a via subject, which is one thought's own subject.
- **SMD-3203's item 3,** decide mode treating a mediated pair explicitly, waited until this record said what consolidation writes for a mediated pair (the maintainer, 2026-10-22). Row 2 now says it for both shapes, so the wait is over, and the second rater's count puts item 3 next.

## The path

1. This record.
2. **SMD-3207, the spike:**
   - read the code artifacts a note names;
   - take each one's change times from git, or from the commit source extended with file lists;
   - ignore a change made within a window after the note. SMD-2540 skips a ticket that already held its current status type an hour after the note: that is the writer's own move reaching the brain late. A session's own commits land beside its summary the same way;
   - label a hit `Changed since written: …`;
   - measure it on the canary, against a bar fixed before the run. The canary holds the fork's change records, which SMD-3006 ingested, as canary-only rows; it holds no commits.
3. If the spike passes, the label is built beside SMD-2540's, and applied only when a thought is read.
4. SMD-3203's item 3, next by the rule: rows 2 and 3 in decide mode, with a new decide version and a re-judge. Proposed here: two raters applying the bars' words agreed little better than chance on which pairs are mediated, so item 3 first fixes a test of a third subject and measures how well raters agree on it, before decide mode applies rows 2 and 3.

## Not decided here

- **How a code artifact is found in a note** (an entity mention, a path in the text, or both), **at what grain** (a file or a function), **and from which source.** SMD-3207 decides these.
- **How the pass tells a third subject from a pair's own.** The bars' words did not settle it between two raters; item 3's first step is proposed in the path.
- **Whether a moved label ever demotes.** For tickets, that is SMD-3054's measurement.
- **Timelines for deployed brains and pull requests.** Another brain's state is an HTTP read through the edge (SMD-2872).
- **Entities' state in general,** which would come from claims about them in SMD-1729's claim log.

## Related

- SMD-3116: the typed labels, and the via slot.
- SMD-3115, SMD-3117 and SMD-3151: decide mode, distinct recorded (migration 102), and decide version 3.
- SMD-2540 and SMD-3054: a ticket's stated status, labelled and maybe demoted.
- SMD-2271: transitive freshness, migration 077.
- SMD-1729: the claim log; `docs/event-log-as-truth.md` (SMD-1997).
- SMD-3006 and SMD-3011: the brain learns its own codebase, and then any repo's.
- SMD-2872: `docs/one-brain-per-stack.md`, where brains reach each other through the edge.
- SMD-2937: consolidation and genre.
