# 30. Entities and relationships — a structured layer, and what a 7B model gets right

Migration 016, `db/extract-entities.ts` and `server-portable/entities.ts`
(Linear SMD-947). Every thought was opaque text plus the `metadata` the capture
model attached; nothing recorded that two thoughts mention the same person or
that one system depends on another, so "everything touching X, and what X
connects to" could not be asked. This was built as the prerequisite for SMD-948
(GraphRAG — measured in change 31 and not built), and is the second consumer of
change 29's lease table.

**A rewrite, not a port, as the ticket predicted.** `schemas/entity-extraction`
carries 36 Supabase couplings and an Edge Function worker. What survived is the
shape — typed entities, evidence-bearing mentions, edges with confidence — and
the worker's two good ideas, the untrusted-content delimiter with escaped close
tags and the injection instruction. What changed, each with a reason in the
migration header: **evidence is the edge** (one row per thought, from, to,
relation; support is a count; a deleted thought's edges go by foreign key and no
counter drifts), **no queue table** (a trigger enqueues into
`thought_work_claims`; `claim_thoughts` is the claim), **re-extraction converges
by construction** (`record_thought_entities` replaces a thought's rows and
prunes what nothing references), and nothing for Supabase.

**The resolution rule is decided, written down and tested — and it is strict.**
"Postgres" and "postgres" are one entity; "Postgres" and "PostgreSQL" are two.
`normalize_entity_name` is NFKC, lower case, surrounding punctuation stripped,
whitespace collapsed, and nothing fuzzier is ever applied automatically. The
alternatives — trigram merging, or asking the model to canonicalise against the
existing table — make the result depend on processing order and merge "Anita"
with "Anika" as readily as the two Postgres spellings; a wrong merge is far
harder to undo than a duplicate is to merge. Aliases the model volunteers are
recorded and never used to resolve; `merge_entities` is the human step, and it
refuses across types. The corpus run below reports what the strict rule leaves
behind, as a count.

**The cost is opt-in, and the trigger makes it so.** Extraction is an LLM call
per thought, recurring. Migration 016's trigger enqueues only when
`ob1_config.entity_extraction_key` is set, and only the worker sets it, on its
first run — so the migration adds one catalog lookup per capture to a
deployment that never runs the worker, and nothing more. The worker takes
`--dry-run` to count before sending, `--limit` to look at twenty before
committing to thousands, and `--follow` to keep extracting new captures as a
long-running process.

**The worker authenticates like any client.** `OB1_WORKER_KEY` is a raw key
whose hash is in `MCP_ACCESS_KEYS`; the run resolves it through change 23's
`resolve_agent` to a stable agent id that every mention and edge carries, and a
revoked key refuses to run. The ticket expected the worker to appear in
`thought_audit` under that id; it does not, because it never mutates `thoughts`
— the edit and delete that feed it are audited as the tools that made them, and
`test-live.ts` [10] asserts zero audit rows from the worker beside the agent id
on every row it did write.

**What the model gets right, on labelled captures.** `evals/eval-entities.ts`
scores fourteen captures through the real write path and the real rule, over
(type, normalised name). `qwen2.5:7b` at temperature 0:

| prompt shape | precision | recall | injection obeyed |
| --- | ---: | ---: | --- |
| one user message, rules and content (upstream's) | **0.68** | **0.84** | yes |
| rules as system message, content as user message | 0.51 | 0.76 | yes |

The second row is the textbook defence against an instruction embedded in the
content, and it was measured rather than adopted: it cost accuracy and stopped
nothing. So the single message ships, and the weakness is written down in three
places — **a 7B model follows an instruction written into a thought**, and the
eval keeps the case so a model that does better shows it. The other forbidden
hit is "the dentist on Ashworth Road" giving `dentist` as a person. The misses
are dominated by the model returning "Postgres" where the label wants
"PostgreSQL" — the duplicate the rule will not merge — and the extras are mostly
defensible against a strict label set ("observability migration" as a project).
Run to run at temperature 0 the score moved by one marginal extra, so these are
±0.02.

**The full pass, on the real corpus.** 441 Linear issues, 589,948 characters,
`qwen2.5:7b` on Ollama on this machine, through the worker itself:

| run | workers | per-call timeout | wall clock | per thought | timed out |
| --- | ---: | ---: | ---: | ---: | ---: |
| first | 2 | 120 s | 4,941 s (82 min) | 11.2 s | 21 of 441 |
| second | 1 | 300 s | 6,793 s (113 min) | 15.4 s | 11 of 441 |
| third | 2 | 300 s | 6,480 s (108 min) | 14.7 s | 19 of 441 |

The first run's 9,870 s of model time inside a 4,941 s wall clock was read as
two calls queueing behind each other on a one-at-a-time Ollama, and the worker
briefly defaulted to one worker on that reading. The second run appeared to
refute it — one worker was 37% slower — and this section said so. The third
run (change 31, made to refresh the extraction dump) is the like-for-like pair
the first two were not, same timeout and twice the workers, and it is 4.6%
faster, not 37%: the earlier gap was the timeout budget, 120 s against 300 s
per stuck document, and the first reading was closer to right. Ollama here
mostly serialises; two workers stay the default because they cost nothing and
recover a little. The timeouts are what they look like — long documents whose
extraction takes a 7B model minutes — not queue time, and which documents time
out varies between passes. **Roughly two hours
for 441 issues, and recurring for every capture after.** On a hosted provider
that is a bill; on this machine it is the fan.

What came out, from the second run and reproduced exactly by replaying its
dumped answers through the database in 0.8 s (the replay is how a rule change
is measured without another two hours): 2,044 entities — 861 tools, 645 topics,
447 projects, 42 people, 28 organizations, 21 places — 2,899 mentions across
427 thoughts (14 yielded nothing; median six per thought, max 47), 2,002 edges
of which 1,129 are `uses`. The most-mentioned entities are the ones an engineer
on this corpus would name: Linear, pnpm, Healthie, Auth0, Sentry, Terraform,
Slack, PostHog, GitHub. 1,767 of the 2,044 entities are mentioned by exactly
one thought: the graph is a long tail with a small connected core, which is the
shape SMD-948 had to work with — and, change 31 found, one reason it lost.

**What the strict rule leaves, and what it cost to find out.** The first run
reported 1,853 near-duplicate pairs by a loose metric (same type, trigram
similarity at least 0.6 or one name inside the other), and every one of the
fifteen closest was a separator variant — "anonymous-intake" beside "anonymous
intake", "state_of_care" beside "State of Care", "siggymd/infrastructure"
beside "SiggyMD infrastructure". Folding hyphen, underscore, slash and hash
into spaces is still a spelling rule, so the rule gained it. After that the
metric still reports 1,922 pairs, and the closest are now the ones a rule
should not decide: "Medication Course" and "Medication Courses", "Anonymous
Intake" and "anonymouse intake" (a typo), a module path against its file path,
"Engineering Cycle 2" against "Engineering Cycle 3" (not a duplicate at all).
The metric is loose on purpose — it is a review list for `merge_entities`, not
a count of errors — and the number is reported as what it is.

**Precision on the corpus, graded by hand.** The run writes a 25-thought sample
with what was extracted from each; this grading is mine, not a second
annotator's. About 60% of the extracted entities are things a person would
accept as an entity of that type — the vendors, the services, the named
projects. About a quarter are code artifacts the model typed as tools or
projects: file paths, issue identifiers (`SMD-747`), enum values
(`clinical_hold`), a Sentry event id. Identifiable and specific, so the prompt's
rules admit them, and of doubtful value in a graph. The rest, roughly 15%, are
wrong: `payer` as an organization, `provider` and `Beta users` as people, `error`
and `reason` as topics, `Claude` as a person. Confidence is 1.00 on almost
every row, so it carries no information on this model. The eleven timed-out
thoughts are the longest issues, and a re-run with `--retry-failed --timeout
900` would finish them at a cost of another hour.

**What the review pass found, and what it changed.** The orphan prune at the
end of `record_thought_entities` decided "nothing references this entity" from
its own snapshot, and under READ COMMITTED another worker could have committed
a mention a moment earlier: the prune waited on that worker's row lock,
re-checked its WHERE against the new row, but its `NOT EXISTS` still saw the
old snapshot, deleted the entity, and `ON DELETE CASCADE` took the other
worker's committed mention with it — both calls reporting ok. The entity side
of the keys is now `RESTRICT`, so that race is a foreign-key error the prune
catches and the entity stays; the prune is also scoped to the entities the
thought's own deleted rows pointed at. A NULL `content_fingerprint` (rows from
before migration 003) silenced the stale-content guard; both sides now compute
the fingerprint from the content through one function. A run under another
model's key rewrote the recorded key and mixed extractions per thought; it needs
`--switch-key`, as a re-embed needs `--switch-model`. The identity block
registered an agent under `--dry-run`, minted a phantom write-scoped agent when
`MCP_ACCESS_KEYS` was unset, and hardcoded the scope; it now requires the key
to be in `MCP_ACCESS_KEYS`, registers the record's own name and scope, and does
not run in the read-only modes. A 429 or a refused connection failed the
thought terminally and both workers marched through the pool doing the same; a
transient error now pauses and retries, and stops the worker with its leases
returned if the provider stays down. A batch of four at a 300 s timeout could
outlive a 900 s lease; the default is one thought per claim and a batch that
could outlive its lease is refused. The stale-retry re-extracted a thought the
trigger had already re-queued; it is reported as superseded and left to the
pool. A bare `--limit` meant no limit and would have sent the backlog to the
model; it is refused. Same name under two types picked an edge endpoint by heap
order; the pick is deterministic and counted. The eval skipped a thrown call
without counting its labels, inflating recall. Declined: folding the worker
into a shared framework with `reembed.ts`, which is its own change.

**A second pass, six of ten findings in the first pass's code — the stopping
signal — and two of them defects in its fixes.** The NULL-fingerprint fix was
half done: the function computed the fingerprint but the worker still passed
the raw column, so the guard was still skipped; one `COALESCE`. The prune's
exception guard was all-or-nothing, so one concurrent mention aborted a
table-wide prune and reported zero; the prune now locks its candidates
`FOR UPDATE` and deletes in a fresh statement, which is what makes it correct,
and the `RESTRICT` key stays as the loud failure if that ordering is ever lost.
The error classification treated every 4xx but 429 as the thought's fault, so
a provider rejecting a request field marked the pool failed in a minute; a 400
about the request or an auth error now stops every worker with exit 2 and marks
nothing, and a thought that reliably draws a 500 is recorded failed after the
retries instead of cycling for ever. A human merge was undone by the next
extraction that said the loser's name: `merged_from` now routes those to the
survivor, the one list that resolves. `{}` from the model parsed as nothing
found and made the thought terminal; the `entities` array is required.
`--limit` reserves at claim time so two workers cannot each take one on a
limit of one. Superseded re-queues explicitly rather than trusting the trigger.
Two test defects: a vacuous assertion (a raw `UPDATE` left the old fingerprint
so the re-capture inserted a new row) and the eval scoring a reversed
directional relation as a hit. Stopped here.

**Not done here.** A read API for the graph — the MCP tools do not expose
entities yet; SMD-948 was to decide the shape and decided (change 31) that the
shape is not retrieval, so a read API is an unticketed follow-up; a `list_thoughts` filter by
entity; injection resistance on a small model; and typed reasoning edges
between thoughts (`schemas/typed-reasoning-edges`), which the ticket names as a
later issue.
