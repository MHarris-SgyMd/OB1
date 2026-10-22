# Subject-anchored claims: a claim is read against its subject's own timeline (SMD-3203)

An architecture decision record. **Decided 2026-10-22 by the maintainer**: a thought's claim about a subject is read against that subject's own timeline when the thought is read, as SMD-2540 already does for tickets. A pair of thoughts linked only by a subject that neither is about is recorded as distinct, never joined through it. Code artifacts are the next subject to get a timeline, a spike first (SMD-3207).

The decision table marks which rows the maintainer decided, which follow from them, which this record proposes, and which are built.

## Terms

- **A thought's own subject** is its main topic: a ticket, a pull request, a release, a deployed brain, a metric, a document or a piece of work.
- **A third subject** of a pair is a subject that is neither thought's own.
- **The four paths** were defined on SMD-3203 before the blind sample was drawn:
  - **direct:** the pair shares its own subject, or one thought is about the other's subject;
  - **half:** what relates them is one thought's own subject, and the other only relays it in passing;
  - **full:** what relates them is peripheral to both, and each relays or mentions the same third subject;
  - **none:** they share no specific subject, only words or an area.
- **Mediated** means half or full. Only a full pair runs through a third subject.
- **Settling:** a pair whose primary typed label (SMD-3116) is corrects, reverses, revises, withdraws, resolves, implements, updates or prioritizes, so that the later thought outdates part of the earlier.
- **The pass:**
  - The consolidation pass judges candidate pairs of near neighbours.
  - In decide mode (SMD-3115), H2O-Lightning-4B gives each verdict, and a writer drafts a supersession proposal for a pair it calls outdates.
  - A pair it does not propose may get a standing relation facet: related, evolves or duplicate (migration 084), or distinct (migration 102, SMD-3117).
  - The canary ran decide version 1 (pass key `@p4d1`) until 2026-10-21, and version 3 (`@p4d3`, SMD-3151) since. Version 2 was measured and shelved.

## Why

SMD-3116's 27-pair check (2026-10-21, its pair 16) found two thoughts that relate only through a third subject:
- the earlier one, a session about SMD-2101, says SMD-2101 is blocked by SMD-2310, and that SMD-2310 waits on SMD-2283 and SMD-2284;
- the later one, a session on SMD-1931, ends by reporting that SMD-2310's two blockers are Done.

SMD-2310 and its blockers are neither thought's own subject. For the first thought they are a dependency of its ticket. For the second they are its closing answer. Labelled pairwise, as "the later one resolves the earlier", the relation has three faults:
- **It misleads.** It reads as the later thought settling the earlier one's subject, and it doesn't: when the later one was written, on 2026-10-08, SMD-2310 had not started, so SMD-2101 was still blocked by it.
- **It grows as pairs.** Every two thoughts that report one subject's state at different times become a relation: up to N(N−1)/2 for N mentions, where the truth is one timeline.
- **It repeats what the brain holds.** Board-sync's ticket heads have both blockers' statuses.

For tickets the brain already reads it the other way, when a thought is read:
- **SMD-2540's label** (`server-portable/stated-status.ts`, migrations 095 and 098) takes the ticket keys a thought names and the time it was written. It sets each ticket's status at that time, from `thought_audit`'s history, beside its head now (migration 068), and labels the hit: `⚠ Moved since written: SMD-2306 In Progress → Done`. The hit's rank is unchanged.
- **Migration 077** (SMD-2271) ranks a thought about settled work lower under `prefer_current`, with the reason shown. Nothing is written to the thought: when a ticket completes, the next search reads it.
- **Neither reads the status a thought states.** Each takes only the ticket keys it names. SMD-2540's eval measured readings of a stated status word, at precision 0.567 and 0.500, and dropped them: "The text pattern is dead: it reads reported speech" (`evals/README.md`).

The question was how far that shape goes beyond tickets, and what consolidation records meanwhile.

## The decision

| # | Decided | Status | Chosen over |
|---|---|---|---|
| 1 | **A thought's claim about a subject is read against the subject's own timeline, when the thought is read.** The subject's state when the thought was written is set beside its state now, and the hit is labelled. Reading the timeline writes nothing. | decided by the maintainer (2026-10-22); built for tickets (SMD-2540, 077) | related, evolves or a supersession between two thoughts only because each reports the same third subject; reading the state a thought states |
| 2 | **A pair whose only link is a third subject is distinct.** The pass's verdict concerns the pair's own subjects. Two thoughts about different tickets that each report a third ticket's state, or its blockers' as in pair 16, are not joined through it. | decided by the maintainer (2026-10-22) | a relation naming the third subject in its payload (a new key, a writer change, a new decide version and a re-judge); recording nothing, not even distinct |
| 3 | **Decide mode proposes no supersession through a third subject.** | proposed here. Its build, SMD-3203's item 3, waited for this record (the maintainer, 2026-10-22); whether to build it is not decided here | a proposal whose only evidence is a third subject's state |
| 4 | **SMD-3116's via slot is a labelling device** for review and measurement. No relation stores it. | follows from 2 | a `via` key in the relation payload |
| 5 | **A subject has a timeline when its state at a past time can be read from a record of the subject itself,** not from the thoughts that mention it. For a ticket, that record is its board-sync row (068's head) and the row's audit history. | proposed here; built for tickets (068, 095, 098) | a subject's state taken from the thoughts that mention it |
| 6 | **Code artifacts are the next subject to get a timeline**, a spike first. A note that names a code artifact is read against when the artifact changed. What counts as an artifact, and at what grain, is the spike's to settle. | decided by the maintainer (2026-10-22); the spike is SMD-3207, its bar to be fixed before the run | deployed brains; pull requests through a GitHub sync; tickets alone until SMD-1729's claim log |
| 7 | **Deployed brains, pull requests and other entities wait.** | follows from 6 | building a timeline for each now |

Code artifacts are entities by the maintainer's decision of 2026-09-24 (`evals/README.md`, where rubric v2 counts them). Files, scripts, tables, functions, environment variables, branches and CI jobs belong in the brain's graph as tools (or as projects, for a directory of work).

## Measured

### Labelled proposals, read again (2026-10-22)

The 156 pairs are SMD-3116's 95 relabelled decide-version-1 proposals and SMD-3151's 61 blind-labelled canary proposals. 138 of them are settling.
- **Reading the headers.** Each thought's own subject was read from its header: a ticket row's id, a session summary's tickets, the ticket a change record cites, or the first ticket key in a note's first 160 characters.
- **Same header.** The 110 settling pairs that share a header ticket count as direct, unread.
- **The other 28 were read by hand.** In 18 of them the headers name different tickets; in 10, a header names none:
  - full: 1 (pair 16);
  - half: 1;
  - direct: 26. Each is one of four kinds: a session whose header names another ticket but which worked this one; a different ticket's change fixing this one's problem; an ADR changing a design it names; or a session's own open item settled later.

So 2 of the 138 settling pairs (1.4%) are mediated, and 1 (0.7%) runs through a third subject. Both are floors, since the 110 same-header pairs were not read: a header naming several tickets could hide a third subject both share. The 18 non-settling pairs were not classified.

### A new blind sample of standing relations (2026-10-22)

The method and bars were fixed on SMD-3203 before the draw.
- **The draw:** 40 evolves, 40 related and 20 distinct, from the canary's 4,356 standing `@p4d3` facets with those words (1,050 evolves, 923 related, 2,383 distinct). Each set was taken in `md5('smd3203-mediated-2026-10-22:' || facet id)` order, lowest first, skipping 6 pairs read in SMD-3116's and SMD-3151's samples.
- **The blinding:** the scorer was fixed before any label, and every label was written before the key was opened. There was one rater.
- **The labelling:** two siblings in one component, and a precedent cited as the basis, counted as direct; a citation the two merely share counted as none.
- **The record:** the texts and labels stay local, as brain text.

| Stored word | direct | half | full | none |
|---|---|---|---|---|
| evolves (40) | 29 | 2 | 0 | 9 |
| related (40) | 33 | 3 | 0 | 4 |
| distinct (20) | 4 | 1 | 1 | 14 |

- **5 of the 80 evolves and related pairs are mediated:** 6.25%, with a Wilson 95% interval of 2.7–13.8%. All five are half, so none runs through a third subject.
- **The decision rule** fixed with the bars: at 10% or more, item 3 would be built next, beside the ADR; under 5%, item 3 would wait and the ADR come first; between, the maintainer decides. The point estimate fell between, and the interval spans all three bands. The maintainer chose the ADR first, with item 3 waiting.
- **The one full pair** has pair 16's shape: two thoughts about different subjects each relay a third ticket's state at a different time. It is stored as distinct, as row 2 makes the rule.
- **The via subjects** of the 7 mediated pairs across the three words (6 half, 1 full) are tickets 3, a deployed brain 1, code artifacts 2 (a table and a function) and a method 1. No pull request, release or metric appears.
- **The 6 half pairs are stored as related (3), evolves (2) and distinct (1).** What the pass should record for a half pair is not decided here.

### What each subject has today (main, 2026-10-22)

| Subject | Identity | State at a past time | Where |
|---|---|---|---|
| Ticket | its key, as `metadata.issue` on its board-sync rows; 068 keeps one head per key | yes: the head now, and the status history in `thought_audit` | 068; 095 and 098; `server-portable/stated-status.ts` |
| Code artifact | an entity (016), or a path in a thought's text | not in the brain. No source there has both a file and when it changed: the fork's change records name files in their prose but are stored with their ingest time, and the commit source carries each commit's author date but no file list (`db/ingest-records.ts`). Git has both. | 016; SMD-3006 and SMD-3011 |
| Deployed brain | its tier and compose project | `schema_migrations` records when each migration was applied, and `ob1_config.schema_version` holds only the current value. The commit its image was built from is known only to the running process. | `server-portable/brain-info.ts`; `db/brain-compare.ts` |
| Other entity | 016's type and normalized name | none: no status, validity or supersession column | 016 |
| Pull request | none | none | none |

## What this amends

- **SMD-3203's title** proposed superseding such a claim on its subject's timeline. Row 1 reads the timeline instead, and writes nothing.
- **SMD-3116's via slot,** in its method, records a relation's third subject for review. Row 4 keeps it there.
- **SMD-3203's item 3,** decide mode treating a mediated pair, waited for this record (the maintainer, 2026-10-22). Row 3 says what it would build; whether to build it is not decided here.

## The path

1. This record.
2. **SMD-3207, the spike:**
   - read the code artifacts a note names;
   - take each one's change times from git, or from the commit source extended with file lists;
   - count a change only after a settling window. SMD-2540 leaves a ticket unlabelled when it already held its current status type an hour after the note: that is the writer's own move reaching the brain late. A session's own commits land beside its summary the same way;
   - label a hit `Changed since written: …`;
   - measure it on the canary, against a bar fixed before the run. The canary holds the change records and commits that SMD-3006 ingested, as canary-only rows.
3. If the spike passes, the label is built beside SMD-2540's, and applied only when a thought is read.
4. SMD-3203's item 3, only if a measured share makes it worth a new decide version.

## Not decided here

- **How a code artifact is found in a note** (an entity mention, a path in the text, or both), **at what grain** (a file or a function), **and from which source.** SMD-3207 settles these.
- **What the pass records for a half pair.** In the sample it had stored related, evolves or distinct.
- **Whether to build row 3** (SMD-3203's item 3).
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
