# 57. A lease outlasts a missed heartbeat, not a batch — `renew_claims`, and the one rule the three workers share (SMD-1023)

Change 29's `claim_thoughts` stamped one `ttl_expires_at` per call, for every
row in the batch, and nothing could move it. So a lease had to outlast the whole
batch: the eighth row of a batch of eight is not started until the seven before
it finish, and its clock has run since the claim. 015's header said so, and
every consumer carried the coupling as arithmetic of its own — `reembed.ts` grew
its default lease to `--batch` × `OB1_LLM_TIMEOUT` and refused a shorter one
(change 34), `extract-entities.ts` and `consolidate.ts` refused a batch ×
timeout above the lease and defaulted to one thought per claim so the product
stayed small (changes 30 and 54). When a batch overran anyway, the next claim by
any worker returned its unfinished rows to the pool, a second worker took and
repeated them, the first's `release_thought` returned false, and after three
expiries the reaper marked the row failed — a cap written for a thought that
kills every worker that touches it, applied to a healthy row that was slow.
`reembed.ts`'s header called its arithmetic "a stand-in for per-row lease
renewal (SMD-1023)". This is the renewal.

**Migration 031: `renew_claims(work_type, worker_id, ttl_seconds)`.** Every row
the worker holds under the key — status `claimed`, `worker_id` its own — has its
deadline moved to `now() + ttl`, never backward (`GREATEST` with the current
one), and the ids renewed are returned. Nothing else changes: `claim_thoughts`,
`release_thought` and `release_claims_for_worker` are as 015 wrote them,
`test-schema` [30] asserts 015 is still the last file to define the first two,
and the claim stays the single locking pass upstream kept it as when it left
renewal out. A pending row, a terminal row and another worker's row are not the
caller's to renew and are not returned. A lease past its deadline that no claim
has yet reaped is still the holder's — the reaper runs at the start of
`claim_thoughts` and nowhere else — and is renewed; a renewal and a reaper
reaching the row together contend on its lock, and the loser re-evaluates its
predicate on the winner's version under READ COMMITTED, so the row ends
renewed-and-held or pending-and-unrenewed, never both. The ids returned are the
rows still held: one of the batch not among them is no longer this worker's —
reaped, requeued by an edit, or deleted — and the caller reads the row to learn
which. One column comment beside it, on `ttl_expires_at`, says what the lease
means since 031; neither literal spells a flag with its dashes, which
`test-schema` [10] requires and [30] asserts of the live text. The file opens as
030 does: a brain adopted with `--baseline` whose schema lacks 015 is refused up
front, 015 and `--reapply` named, where a plain run would otherwise have passed
the `CREATE FUNCTION` (plpgsql resolves the table at first run) and failed at
the column comment with a bare "does not exist"; `test-upgrade` [9] drives it.

**The heartbeat, once.** `db/lease.ts` is the implementation the three workers
share, as `consolidation_pool()` was change 54's one pool rule: a timer per
worker that calls `renew_claims` every `--heartbeat` seconds while the worker
holds rows and sends nothing while it holds none; a `held` set that `claimed()`
fills after each claim and the loop removes each row from BEFORE its release
goes out, so a beat in flight across a release does not read the released row as
lost; a `lost` set for the ids a beat found no longer the worker's, which the
loop skips rather than repeating the provider's work and the summary counts.
Three guards keep that verdict honest. A claim bumps a generation the beat
compares on return, so an id released and won back inside one round trip is not
read as lost. `claimed()` takes its ids out of `lost`, since a claim returning
an id is proof the lease is this worker's again (016's edit trigger requeues a
row mid-extraction and a near-empty pool hands it straight back), and an id lost
for ever would be skipped while held, returned by the `finally` and reported
pending. `stop()` voids a beat still in flight, so the `finally`'s return of the
leases is not read as the loss of every one of them. And a row a beat finds gone
is not assumed reaped: the loop asks the row (`lostReason`) — deleted is counted
with the deleted; back in the pool (reaped, or requeued by an edit) is said so;
another worker's names the worker; and a row the reaper marked failed while this
worker held it — 015's reaper leaves `worker_id` as it was, so the row still
names this worker — says so and names `--retry-failed`. Beats never overlap (a
tick that finds one in flight is skipped) and the timer is unref'd, so it holds
no process open. The three workers wire it identically: started beside the
worker id, `claimed()` after the claim, each row removed before its release,
stopped in the `finally` that returns the leases, and the beats summed into the
run's summary; the lost-at-top step — ask the row, print, say which count — is
one function, `reportLost`, so the three cannot drift on it. Each opens a pool
of one connection per worker and one spare, and says beside the number that the
spare is what keeps the leases alive while every worker is parked on a lock or a
long statement (the case 023's header warned of), so long as each beat reaches a
row before a claim's reaper does — the row-lock race above. A beat that fails is
reported once per run of failures and the leases hold from the last one that
answered; a process that cannot reach the database cannot beat, and its rows
return to the pool as a dead worker's would, which is the right reading of it.

**The rule that replaces "the TTL must cover the batch".** `--ttl` ≥ 2 ×
`--heartbeat`, so one delayed beat cannot lapse a lease. A pair under it is
refused before anything is claimed — exit 2, the arithmetic shown; `reembed.ts
--status` answers regardless, as before — and a lease given without a heartbeat
derives one of a third of itself, at most 60 s and at least 1 s, so any lease of
two seconds or more fits and only a one-second lease has no pair (its refusal
names the lease alone, and says the heartbeat was derived rather than quoting a
flag the operator never passed). Both flags are bounded where the runtime bounds
them, and refused above with the reason: a lease over 2,147,483,647 s would fail
every claim on its signature (`--dry-run` had accepted one and the run then
failed on every claim), a heartbeat over 2,147,483 s would overflow the timer
into a beat every millisecond (measured: 1,411 beats in a second and a half).
`--dry-run` in all three workers prints the lease and heartbeat a run would use;
`--status` in all three names each holder, its rows, its earliest deadline and
the remedy for a dead one (`release_claims_for_worker`), which only `reembed.ts`
did before. A row whose lease is found gone at release is counted with the rows
the worker lost, not the ones it finished, so two workers' summaries add up to
the pass, and the provider's answer for it is printed marked unrecorded rather
than dropped. Every line about a lease found gone states what the worker
observed and the causes it cannot tell apart — a lapse, a hand release, an
edit's requeue — rather than asserting one; `release_claims_for_worker` issued
against a live holder is the case that made the first wording false. A worker id
is text any claimant wrote, and is cleaned before it reaches a terminal, as
change 54's rule for database text requires. `--ttl` now means one thing: how
long a dead worker's rows stay out of the pool. Nothing about the batch, the
timeout or the calls a thought costs sizes it, and the three refusals that did —
`reembed.ts`'s derived floor with its long-lease warning,
`extract-entities.ts`'s `--batch × --timeout`, `consolidate.ts`'s `--batch × --k
× --timeout` — are gone. The reaper's cap keeps the meaning 015 gave it: under a
heartbeating worker a lease lapses only when the beats stop reaching the
database for a whole lease, so a row expired three times is one whose worker
died three times on it, not one that was slow.

**Proof.** `test-live` [8e]: a worker on a 5 s lease beats at 4.5 s; a claim at
5.5 s — past the original deadline — gets only the unclaimed rows and the
worker's release succeeds; it beats once more and stops; a claim before the
renewed deadline gets nothing and one after it receives its three rows on their
second attempt, every row ending succeeded and none failed. [8a] and [8b] hold
as they were: the claim is untouched. [9] runs `reembed.ts` end to end with
every embedding taking 600 ms, sixteen per claim, a 6 s lease and a 1 s
heartbeat: two workers re-embed all forty-two thoughts in batches near ten
seconds long (a batch that fit inside the lease would pass with renewal a no-op,
so the batch is sized to outlast it), no row reaches a second worker, no release
finds its lease gone, none is lost, every claim row succeeded on its first
attempt — the ticket's first Verify bullet, which no arithmetic could pass; its
summary counts the beats, and the test holds them at ten or more. [9] then takes
a one-worker run's batch from under it by hand: the row in hand learns it at
release, the rest at a beat or their release, every stolen row is counted lost
and none finished, the worker finishes the rest and exits 1 naming the rows
still leased, and `--status` names the thief. [10] and [16] run their first pass
under a 6 s lease beating every second, with answers slowed to 400 and 700 ms,
so the beats fire in the other two workers — the count in each summary says they
did — and assert the old refusals are gone (a batch of four at a 300 s timeout
is a `--dry-run` that exits 0) and the new one holds. `test-schema` [30] owns
the state machine on one connection: the holder's rows and no others, never
backward, expired-not-reaped is still held, reaped is not, 015's CHECK still in
force under the new writer, both comments' text. A beat is one `UPDATE` through
015's partial worker index — [8e] asserts the plan reads it, as [8d] asserts the
claim's reads the pending one — and prints its round trip: a few milliseconds on
the function's first call, the plan included, and under a millisecond after.

**What did not change, and why.** The default lease stays 900 s: shorter is now
safe — a dead worker's rows return in `--ttl`, not `--ttl` plus the batch — but
the default is the operator's to lower and the ticket did not ask.
`extract-entities.ts` and `consolidate.ts` keep one thought per claim for the
reason that survives: a claim costs half a millisecond against a model call of
seconds, so a bigger batch buys nothing and a dead worker holds fewer rows. The
read-only modes never beat, since they never claim. 028's comments on
`last_error` and `release_thought` stand as applied — nothing here redefines
either function, which is the case 028's header said a successor must mind.

Upstream status: **not applicable** — upstream's `schemas/thought-work-claims`
left mid-batch renewal out deliberately, to keep the claim one atomic statement,
and its table is not this one (change 29's four departures). A separate renewal
function keeps the property upstream wanted and could be offered against its
schema; **unfiled** upstream.
