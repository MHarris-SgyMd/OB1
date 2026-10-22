# A claim about a subject goes stale with the subject: read against the subject's own timeline, and a pair that shares only a third subject is distinct (SMD-3203)

An architecture decision record. **The direction was decided 2026-10-22 by the maintainer**: a thought's claim about a subject is read against that subject's own timeline when the thought is read, and nothing is written between two thoughts because they report the same subject. Two thoughts about different subjects that share only a third are distinct. Code artifacts are the next subject to get a timeline, a spike first.

The decision table marks which rows are that direction, which follow from it, which are built, and which a child ticket settles.

## Why

SMD-3116's 27-pair check (2026-10-21, its pair 16) found two thoughts that relate only through a third subject:
- the earlier one, a session about SMD-2101, says SMD-2101 is blocked by SMD-2310, and that SMD-2310 waits on SMD-2283 and SMD-2284;
- the later one, a session on SMD-1931, ends by answering a question about SMD-2310: its two blockers are Done.

Neither thought's own subject is SMD-2310. Labelled pairwise, as "the later one resolves the earlier", the relation has three faults:
- **It misleads.** It reads as the later thought settling the earlier one's subject, and it doesn't: SMD-2101 is still blocked.
- **It grows as pairs.** Every two thoughts that report one subject's state at different times become a relation: up to N(N−1)/2 for N mentions, where the truth is one timeline.
- **It repeats what the brain holds.** Board-sync's ticket heads have both blockers' statuses.

For tickets the brain already reads it the other way, when a thought is read:
- **SMD-2540's label** (`server-portable/stated-status.ts`, migrations 095 and 098) takes the ticket keys a thought names and the time it was written. It sets each ticket's status at that time, from `thought_audit`'s history, beside its head now (migration 068), and labels the hit: `⚠ Moved since written: SMD-2306 In Progress → Done`. The hit's rank is unchanged.
- **Migration 077** (SMD-2271) ranks a thought about settled work lower under `prefer_current`, with the reason shown. Nothing is written to the thought: when a ticket completes, the next search reads it.
- **Neither parses what the thought says.** SMD-2540's eval measured readings that parse a stated status word, at precision 0.567 and 0.500, and dropped them: "The text pattern is dead: it reads reported speech" (`evals/README.md`).

The question was how far that shape goes beyond tickets, and what consolidation records meanwhile.

## The decision

| # | Decided | Status | Chosen over |
|---|---|---|---|
| 1 | **A thought's claim about a subject is read against the subject's own timeline, when the thought is read.** The subject's state when the thought was written is set beside its state now, and the hit is labelled. Nothing is written for the pair or the row. | the maintainer's direction (2026-10-22); built for tickets (SMD-2540, 077) | a relation between every two thoughts that report one subject; parsing the state a thought states |
| 2 | **Two thoughts about different subjects that share only a third subject are distinct.** The pass's verdict concerns the pair's own subjects. | the maintainer's decision (2026-10-22) | a relation naming the third subject in its payload (a new key, a writer change, a new decide version and a re-judge); recording nothing, not even distinct |
| 3 | **Decide mode proposes no supersession through a third subject.** The writer's quotes concern the earlier thought's own subject. | follows from 2; the build is SMD-3203's item 3, which waits until the shape recurs (the maintainer, 2026-10-22) | the writer quoting any subject the two thoughts share |
| 4 | **SMD-3116's via slot is a labelling device** for review and measurement. No relation stores it. | follows from 2 | a `via` key in the relation payload |
| 5 | **A subject has a timeline when the brain can read its state at a past time without another thought.** Tickets do, from board-sync's heads and `thought_audit`'s history. | built for tickets (068, 095, 098) | a subject's state taken from the thoughts that mention it |
| 6 | **Code artifacts are the next subject to get a timeline**, a spike first. A note that names a file, a function, a table or a migration is read against when that artifact changed. | the maintainer's decision (2026-10-22); SMD-3207's spike, with its bar fixed before the run | deployed brains; pull requests through a GitHub sync; tickets alone until SMD-1729's claim log |
| 7 | **Deployed brains, pull requests and other entities wait.** | follows from 6, and from their share measured below | building a timeline for each now |

Code artifacts are entities, by the maintainer's decision of 2026-09-24 recorded in `evals/README.md`. Files, scripts, tables, functions, environment variables, branches and CI jobs enter 016's graph as tools.

## Measured

### Labelled pairs, read again (2026-10-21)

These are SMD-3116's 95 relabelled decide-v1 proposals and SMD-3151's 61 blind-labelled canary pairs: 156 pairs, 138 of them with a settling primary label. Each thought's own subject was read from its header: a ticket row's id, a session summary's tickets, or the ticket a change record cites. The 28 settling pairs whose two subjects differ were read by hand:
- **full**, a third subject peripheral to both, each thought relaying its state: 1 (pair 16);
- **half**, one thought's own subject relayed in passing by the other: 1;
- **direct**: 26. These are a session working another ticket, a different ticket's change fixing this one's problem, an ADR changing a design it names, or a session's own open item settled later.

### A fresh blind sample of standing relations (2026-10-22)

The bars were fixed on SMD-3203 before the draw. The sample is 40 evolves, 40 related and 20 distinct, taken from the canary's 4,356 standing `@p4d3` relation facets in a pre-registered md5 order and read blind. The scorer was fixed before any label, and every label before the stored word was seen.

| Stored word | direct | half | full | none |
|---|---|---|---|---|
| evolves (40) | 29 | 2 | 0 | 9 |
| related (40) | 33 | 3 | 0 | 4 |
| distinct (20) | 4 | 1 | 1 | 14 |

- **5 of the 80 evolves and related pairs run through a third subject:** 6.2%, with a Wilson 95% interval of 2.7–13.8. All five are half. The decision rule fixed with the bars left a share between 5% and 10% to the maintainer.
- **The one full pair** has pair 16's shape. It is stored as distinct, which row 2 makes the rule.
- **The via subjects,** 7 across the three words, are tickets 3, a deployed brain 1, code artifacts 2 and a method 1. No pull request, release or metric appears.
- **Across all 238 labelled pairs,** the full shape occurs twice and the half shape six times.

### What each subject has today (main, 2026-10-22)

| Subject | Identity | State at a past time | Where |
|---|---|---|---|
| Ticket | `metadata.issue` or `ticket`, one head per issue | yes: the head, and status history in `thought_audit` | 068; 095 and 098; `server-portable/stated-status.ts` |
| Code artifact | an entity (016), or a path in a thought's text | not in the brain as a timeline today. The fork's change records name the files they change (SMD-3006 ingests them), and git holds the rest. | 016; SMD-3006 and SMD-3011 |
| Deployed brain | its tier and compose project | its own database's: `schema_migrations` and `ob1_config.schema_version`. Its commit and server version exist only in the running process. | `server-portable/brain-info.ts`; `db/brain-compare.ts` |
| Other entity | 016's type and normalized name | none: no status, validity or supersession column | 016 |
| Pull request | none | none | none |

## What this amends

- **SMD-3116's via slot** (in its description, 2026-10-21) records a relation's third subject for review. Row 4 keeps it there.
- **SMD-3203's item 3,** decide mode treating a mediated pair, waits. Row 3 says what it builds when it comes.

## The path

1. This record.
2. **The spike,** SMD-3207:
   - read the code artifacts a note names;
   - take each artifact's change times, from the change records or from git;
   - label a hit `Changed since written: …`;
   - measure it on the canary, which holds the codebase, against a bar fixed before the run.

   The spike also decides how an artifact is named and at what grain.
3. If the spike passes, the label is built beside SMD-2540's, and applied only when a thought is read.
4. SMD-3203's item 3, when the shape recurs.

## Not decided here

- **How a code artifact is found in a note** (an entity mention, a path in the text, or both), **at what grain** (a file or a function), **and whether its timeline comes from the change records or from git.** The spike settles these.
- **Whether a moved label ever demotes.** For tickets, that is SMD-3054's measurement.
- **Timelines for deployed brains and pull requests.** Another brain's state is an HTTP read through the edge (SMD-2872).
- **Entities' state in general,** which would come from claims about them in SMD-1729's claim log.

## Related

- SMD-3116: the typed labels, and the via slot.
- SMD-2540 and SMD-3054: a ticket's stated status, labelled and maybe demoted.
- SMD-2271: transitive freshness, migration 077.
- SMD-1729: the claim log; `docs/event-log-as-truth.md` (SMD-1997).
- SMD-3006 and SMD-3011: the brain learns its own codebase, and then any repo's.
- SMD-2872: `docs/one-brain-per-stack.md`, where brains reach each other through the edge.
- SMD-2937: consolidation and genre.
