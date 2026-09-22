# 54. A pass that proposes which thoughts supersede which — reviewed one at a time, never applied unreviewed (SMD-1294)

Change 46 gave `thoughts` a `supersedes` column and `capture_thought` a way to
set it, and nothing populated it except a caller who already knew the answer at
capture time. So a decision captured in March and its reversal in June sat side
by side, both ranking on cosine alone (change 37's recency blend is off by
measurement), and `search_thoughts` handed a caller both with no signal that one
was dead — the state GraphRAG-style systems call unconsolidated, and the largest
capability gap between this fork and GBrain, whose public design runs the fix as
an overnight job: sample nearby pairs, ask a model whether they conflict, surface
the result for review rather than acting on it. The fork had every ingredient of
that loop and none of the loop: 015's leases, 016's shared entities, 025's
column, a resident metadata model.

**The one rule, enforced structurally.** The pass writes **migration 029**'s
`supersession_proposals` and never `thoughts`. `thoughts.supersedes` is written
by one function, `review_supersession_proposal(id, 'accept')` — an operator's
call, one proposal at a time, under the audit trigger with the reviewer as actor
— so reversing a wrong supersession is one `--reject` and nothing is ever applied
because a model said so. Both GBrain's docs and the review of change 46 arrive at
this rule; the ticket's words were "the machine proposes, someone confirms".

**Which pairs are judged, and why each restriction.** `consolidation_candidates`
pairs a thought with the older thoughts that **share an extracted entity** (a
conflict is about a subject both name, and the judge cost is per pair, so the
cheap signal narrows the pool before the expensive one), captured **at least a
UTC calendar day earlier** (a pair is reached from its newer side once, with no
"already judged" memory needed; an import's burst is not compared with itself; a
same-day contradiction is not found, stated rather than hidden), **nearest by
exact cosine** over that join, at or above a floor, at most k — with pairs already
proposed in any state and thoughts already superseded on either side left out.
The ticket said "by `search_thoughts_hybrid`"; the keyword arm has nothing to add
when the query is a whole document, and an HNSW walk filtered to "shares an
entity" is the filtered-scan shape change 28 exists to avoid — the join is tens
of rows and the exact cosine is cheaper than the index. The shared-entity rule
makes extraction a prerequisite, so the worker's pool is **thoughts with
entities and no row under the key**, rebuilt on every run and every `--follow`
poll: no trigger, because a trigger on `thoughts` would judge a capture before
016's worker reached it and leave a terminal claim row behind.

**The judge.** `server-portable/consolidate.ts` holds one prompt: thought A
(older) and B (newer), dated, and one question — agree, unrelated, or conflict,
and for a conflict which is *current*, decided from what the texts say and never
from the dates (the ticket's "prefer the later one only when the content itself
says the earlier is superseded"). A conflict whose texts do not say is recorded
`conflict_undirected` for the reviewer to direct. Only conflicts become rows,
each carrying its direction, confidence, the judge's one-sentence reason (what a
reviewer reads first), the cosine, and the pass key
`consolidate:<model>@p<prompt version>` — the judge model on the row as 021 puts
the embedding model beside the vector (SMD-1254). Acceptance refuses what would
leave the column wrong: a pointer at a third thought (`ALREADY_SUPERSEDES` — the
column holds one predecessor, and which is the reviewer's call) or one that
would close a loop (`WOULD_CYCLE`); an undirected verdict needs `--direction`;
and the verdict is about the texts as judged — each proposal records 016's
fingerprint of both texts as the judge saw them, the queue marks a thought
edited since, and accepting such a pair is refused (`EDITED_SINCE`) unless the
reviewer, reading both texts as they are now, passes `--force`. An acceptance
that writes the pointer moves the superseding thought's `updated_at`, which a
client's `if_unchanged_since` and 021's evidence rule read as an edit. Rejecting an accepted proposal undoes its own write while
it still stands. A decided pair is never proposed again, whatever happens to the
claim table. Nothing a capture controls reaches the judge outside the two
delimited blocks, and nothing a thought contains reaches a reviewer's terminal
or client with its control characters intact.
`stale_entities` is the pass's second output — subjects nothing has mentioned
within a window — printed by `--stale` and acted on by nobody.

**One departure from the ticket, stated.** Work item 3 asked that acceptance
call `update_thought`. It cannot: `update_thought` has no provenance parameter
(change 46 left post-hoc provenance edits as a follow-up), and adding one is a
redefinition of the edit signature — DROP and re-create with the ACL replayed,
the constant, preflight's `edit signature`, both stores, the MCP tool — a second
mechanism. So the accept function sets `ob1.actor` as 009's functions do, locks
the superseding row and writes the column in one UPDATE; 025's audit trigger
diffs `supersedes`, so the change is recorded with the reviewer as actor exactly
as an edit would be. The envelope on `update_thought` is **SMD-1323**, and when
it lands the accept path should call it. (It landed as change 60, migration
032: the accept and reject paths call `update_thought`, and the UPDATE is gone.)

**Measured** (`evals/eval-consolidate.ts`, `evals/README.md`), on the 576-issue
Linear corpus with `qwen2.5:7b` as judge, the entity graph from 016's worker
(525 of 576 extracted; 51 of the longest documents time out under the 7B model —
016's known tail — and with 4 that extracted to nothing, 55 carry no entities and
are outside this pass), and 98
hand-labelled pairs drawn from every cross-reference carrying supersession
language (6 conflicts, 79 agree, 13 unrelated):

| | |
| --- | --- |
| candidate pairs at k=3, cosine ≥ 0.6 (the shipped defaults) | 517 over 243 thoughts — 0.99 judge calls per thought with entities; 1,198 at k=5/0.5, 2,815 at k=10/0 |
| the shared-entity rule against cosine alone at the same k and floor | 517 against 1,090 pairs — the rule hands the judge 47% |
| the full pass | 21.3 min wall, 4.9 s of model time per pair, ~1,750 estimated prompt tokens per call (~1.6M per thousand thoughts) |
| verdicts | 441 unrelated, 63 agree, **13 conflict → 13 proposals** (10 without a direction) |
| the 13 proposals, graded by hand | **6 real, 7 not** — 46% precision, about 2 proposals per hundred thoughts |
| the judge on the 98 labelled pairs, called directly | conflict precision 29% (2/7), recall 33% (2/6); 87 of 92 non-conflicts left alone |
| labelled conflicts the pass could reach | 1 of 6 at the shipped k and floor; 3 of the 6 pairs' issues are among the 51 unextracted, and the pass proposed 0 of 6 |

**What it says, and the decision.** The ticket's shipping test was "false-positive
`conflict` low enough that a reviewer is not drowned; the number is chosen from
the measurement". At two proposals per hundred thoughts, half of them real, a
reviewer is not drowned — the pass ships, **default off** (nothing runs until
`db/consolidate.ts` is invoked), with k=3 and a 0.6 floor chosen from the table
as the point where the judge costs about one call per thought, the same order as
extraction. What it does not do is find much: the 7B judge's recall on genuine
reversals in long tracker documents is a third, its confidence is uninformative
(0.8 on nearly every verdict, so the confidence floor filtered nothing), and the
shared-entity rule inherits extraction's blind spot on exactly the long decision
documents where the labelled conflicts live. The true conflicts it did find —
a billing-bypass flag decoupled from the flag that used to control it, a
tool-version source of truth replaced by another, a scope revised — are the
kind the ticket named. A stronger judge and the 016 tail are the two levers,
and neither is this change's mechanism; the eval is the instrument for both.

Verified by `test-schema` [28] (the candidate rule's every exclusion, the one
write, the review path's states and refusals with the audit row, the queue,
staleness), `test-live` [16] (the worker end to end against a stub judge: the
audited accept under the key's name, the reject that clears, a cleared claim
table not re-proposing a decided pair, the pool picking up a thought extracted
since), `test-store-sql`/`-postgrest` [10], `test-preflight`'s `consolidate
pass` line, and the four suites that count the tool surface (ten now, seven
read-only). Three review passes, triaged in full: the second's top finding was
the first's fix (the stop signal); the third, with the operator's and the
adversary's lenses, found the prompt's header line, the missing staleness guard
and the unstripped control characters above; a fourth, over the third's seams,
moved the fingerprint to the text the judge was sent and pinned the tool's
rendering and the CLI's `--force` path. All suites green.

Upstream status: **not applicable** — upstream has no proposal table, no worker
and no `supersedes` writer beyond capture; the shape is GBrain's, the parts are
the fork's. **Unfiled** upstream.
