# 29. A lease per thought, and the re-embed that proves it

Migration 015 and `db/reembed.ts` (Linear SMD-946). Every bulk pass over the
corpus was single-threaded or racy: two workers that both select "the next
unprocessed thoughts" pick overlapping rows, and a script that walks the table
once cannot be resumed after it dies. Changing the embedding model — which
`db/config.mjs` has said since change 15 means re-embedding every row — had no
tool at all. Three earlier changes deferred a backfill to this ticket by name
(013's header, change 27's whole-content vector, the README's chunk-context
section).

**The table.** `thought_work_claims`, ported from `schemas/thought-work-claims`:
one row per (thought, job key). `enqueue_thoughts` builds the pool,
`claim_thoughts` hands out batches under a TTL lease, `release_thought` and
`release_claims_for_worker` finish or hand back. Four departures from
upstream, each argued in the header; three are below and the fourth is that
terminal rows stay, as the record of the pass, and block re-enqueue. The database picks the batch with `SELECT
… FOR UPDATE SKIP LOCKED` — upstream's workers chose their own candidate ids and
the claim only arbitrated, so every worker selected the same newest page and
the losers backed off, a symptom its own README lists under Troubleshooting.
The ticket's framing needed one correction on the way: upstream's claim is
race-safe as it stands (the primary key and `ON CONFLICT DO NOTHING` let exactly
one inserter win); what `SKIP LOCKED` buys is selection that does not contend,
and the status predicate re-evaluated under READ COMMITTED is what keeps a
lease committed a moment earlier from being handed out twice. Both are needed
and the header says which does what. Second, an expired lease returns to the
pool rather than being deleted, so `attempt_count` and `last_error` survive,
and after three expiries a row is marked failed — a thought that kills every
worker that touches it must not cycle for ever. Third, nothing for Supabase.

**The proof is concurrent, because a sequential one passes against a broken
implementation** — the ticket's own warning, and true: on PGlite's single
connection two claims in a row are disjoint whether or not `SKIP LOCKED` does
anything. `db/test-live.ts` [8] holds ten leases open in one transaction while
another connection claims under a 2 s `lock_timeout` that a wait would trip,
then races four workers on four connections through a 600-row pool and asserts
on ids: none claimed twice, the union exactly the pool. A worker dies on a 1 s
lease and a second worker receives its rows after expiry, on attempt 2; the
dead one, back late, cannot release them.

**The claim's cost was not flat, and the first measurement said so.** The first
draft took "any sixteen pending rows", and at 100,000 rows in a container the
claim went from 0.48 ms at the start of the pass to 2.90 ms at the end —
`VACUUM` at the halfway point changing nothing, which ruled out the dead index
entries the draft header had blamed. The planner was serving it with a
sequential scan that stops after sixteen hits: the cheapest estimate, correct at
the start, and linear in the done rows by the end because they sit at the front
of the heap. `ORDER BY enqueued_at` over a partial index on the pending rows
makes a sequential scan sort the whole pool, so the index wins whatever the
statistics say: 0.48 ms first hundred, 0.56 ms at 50,000 done, 0.47 ms last
hundred, against a 0.15 ms round trip. [8] asserts the plan and the ratio at
10,000 rows. The other planner trap — a large enqueue leaving statistics that
describe the table before it — is closed by an `ANALYZE` inside
`enqueue_thoughts` whenever it added rows, so every consumer gets it rather than
the one that knew to wait a minute for autovacuum.

**The consumer.** `db/reembed.ts` walks the corpus through the claims with N
workers, resumes where it stopped, and re-embeds *exactly as a capture would*,
because the server's embedding path is now `server-portable/embed.ts` and both
call it. That extraction is the one change to the server here and it is a pure
move: chunking, the blurb rule, the prompt template, the whole-content-then-
head-window fallback and the width check are unchanged in what they decide, and
the six suites that exercise them pass unchanged. A second copy in a script
would have been this fork's recurring defect — a value defined twice — with the
value being every stored vector. The write goes through `update_thought`, so
chunks are replaced wholesale as on an edit, an `if_unchanged_since` race
re-reads instead of letting a stale vector win, and the tool is also the
backfill the three earlier changes deferred: a long thought captured before
change 27 gets its whole-content vector, and a corpus captured under one
`OB1_CHUNK_CONTEXT` setting is brought to the current one under a job key of
its own (`--job`).

**Same width only.** `thoughts.embedding` is `vector(N)` and N is baked into
two columns, two HNSW indexes and every function signature. The tool refuses a
configured width that differs from the column's, because a width change is a
migration that does not exist yet, not a re-embed. A model change needs
`--switch-model` and records the new model in `ob1_config` first, so a server
configured for it passes preflight and can be switched; until the pass finishes
searches mix two models' vectors, `--status` says how far along it is, and a
re-run adds anything captured meanwhile. Failed rows are terminal until
`--retry-failed`; the run exits 1 while any remain and names them.

**The audit premise in the ticket was false.** SMD-946 says a re-embed is an
update, so a bulk pass writes an audit row per thought and doubles the audit
table — "correct and wanted, note it, do not suppress it." Migration 008's
trigger diffs the embedding's *presence*, not its value: a vector replaced by a
vector is `{}`, and `{}` was ruled not-an-event when 008 stopped a repeated
import from writing ten thousand empty rows. So a full re-embed writes no audit
rows for rows that had a vector, and exactly one for a row that had none.
`test-live.ts` [9] asserts one row for thirty-eight thoughts (thirty-four when
this was written; changes 33 and 34 added two each). Nothing was
suppressed; the trigger never recorded this, and the claim row — job key,
worker, attempts, error, times — is the per-thought record of the pass. Making
the trigger record vector changes would be a new migration and would reintroduce
the doubling the ticket worried about; it is left as a decision rather than made
in passing.

**What the first review pass found, and what it changed.** Two defects that
predate this change and that the extraction put in the touched code. The prompt
templates were applied with `String.replace` and a string replacement, which
reads `$&`, `$'` and `$$` in the thought's text as substitution patterns — a
price written `$$5` embedded as `$5`, and a query containing `$&` became the
template's placeholder; fixed once, in `db/config.mjs`, which `embed.ts` now
calls instead of keeping its own copy. And `OB1_CHUNK_OVERLAP=""` resolved to
zero overlap rather than the 150 default, while `deploy/compose.yaml` forwards
every optional variable as `${VAR:-}` — so **every long capture made through
the compose stack was windowed with no overlap**, and a re-embed from a shell
would have re-windowed them differently. Empty now means unset, as
`db/config.mjs` always said; the re-embed is the backfill. In the new code: the
whole-content fallback latched on any 4xx, so one 429 in a bulk pass would have
downgraded every later long thought to its head window while recording success
— it latches on 400 and 413 only now, and the pass counts the fallbacks it did
make; a worker's `finally` returned its leases only on a signal, so a database
error stranded them for the TTL and a re-run reported nothing to do with exit 0
— it releases unconditionally now, and a run exits 1 while any row is leased;
a window whose blurb failed under `OB1_CHUNK_CONTEXT=on` was recorded succeeded
and terminal — it is a failure now, so `--retry-failed` can revisit it;
`--retry-failed` did not reset the attempt count; a second Ctrl-C could not end
a run parked on a hung provider. `test-thoughts.ts` [7] and `test-live.ts` [9]
cover each. Three findings went to tickets rather than code: the fallback as a
per-row outcome (SMD-1021 — fixed in change 34), `update_thought` refusing unchanged content that
duplicates a pre-fingerprint row (SMD-1022 — fixed in change 33), and lease
renewal (SMD-1023).

**A second pass, and the stopping signal.** Three of its ten findings were in
code the first pass added, which is the sign the loop is converging rather than
finding new ground; what it added was small. The stale-read guard was passed the
raw `updated_at`, which 001 leaves nullable, so a row loaded around
`upsert_thought` had no guard at all — the worker now selects the
`COALESCE(updated_at, created_at)` the guard compares against. A blurb failure
under chunk context was declared before the write, leaving the old model's
vector in place; the write comes first now and the claim is what fails. A
transient failure of the whole-content call (429, 5xx) stored the head window
and recorded success — terminal, unreachable by `--retry-failed` — while the
same failure on a window embedding was retryable; `embedCapture` now reports
whether the provider has refused the length outright, and the pass records the
transient case failed with the head window stored. A run whose every worker
stopped on a database error exited 0 with rows pending; it exits 1. A
`release_thought` that returned false for a deleted thought was reported as a
lease problem. The chunk-context template fill moved into `db/config.mjs` and
`evals/eval-contextual.ts` uses it, so the harness prompts as the server does.
The 1 s lease in the live suite became 2 s. Writing the new model into
`ob1_config` before the pass stays as it is — it is what lets the server be
switched, and a later run resumes the same key — and preflight not seeing an
incomplete pass is SMD-1024 (fixed in change 35).

**Not done here.** Preflight did not report an incomplete pass (`--status`
did; change 35 made preflight do so); a width-changing migration; the
entity-extraction consumer (SMD-947), which this exists for. `deploy/compose.yaml` does not run the tool — it needs
the provider, and runs from a checkout.
