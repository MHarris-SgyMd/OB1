# 35. Preflight sees an unfinished re-embed — and a pass starts as one transaction

`server-portable/preflight.ts`, `db/reembed.ts`, `db/config.mjs` (Linear
SMD-1024, named "not done" by change 29 and made a ticket by its second review
pass). `reembed.ts --switch-model` records the new model in `ob1_config` before
the first row is re-embedded, on purpose: that is what lets a server configured
for the new model pass preflight and be switched while the pass runs, and lets
a later run resume the same key. The cost was what preflight then said. It
compared the configured model with the recorded one and reported `matching` —
for a pass that died at 5%, or was never re-run after `--retry-failed`, leaving
a server that passed every check while most of its vectors were another model's
and every search ranked across the two. `--status` said so, but only when
someone ran it.

**The signal is the claim table, not a marker.** The ticket offered two: a
marker row in `ob1_config` (`reembed_in_progress = <key>`, written at start and
cleared at completion) or an inference from the claim counts. The counts won.
Migration 015's fourth principle already makes terminal rows *the record of the
pass*; a marker would be a second record that can disagree with the first — the
process that drained the pool dies before clearing it, two processes finish at
once, an operator clears rows by hand — and needs a clearing protocol across
concurrent processes. The rule is one line, `passUnfinished` in
`db/config.mjs`: **a pass is unfinished while any row under its key is pending,
leased or failed.** Succeeded rows with a caveat (change 34) are finished.
Thoughts with no row under the key are not a signal on their own — after a
completed switch every new capture is one, for ever — and are reported as detail
while a pass is unfinished. Preflight reads every key with the tool's prefix
(`reembed:`), so a backfill under `--job` is reported by its key too; extraction
keys are excluded because 016's trigger keeps that pool fed between worker runs.
A new check, `re-embed pass`, sits directly under `embedding contract`, whose
`matching` stays literally true of the record; the line beneath qualifies it, as
a warning — the server answers, ranking across the old and the new vectors —
with the counts and the command that finishes the pass (`--retry-failed` named
while rows are failed, `--status` for where it stands). Before migration 015
there is nothing to read and the check says so rather than warning.

**What the counts could not see, until the start was one transaction.** The
ticket's own crash: the `ob1_config` write succeeds, the connection drops during
`enqueue_thoughts`, the operator forgets. That left a record naming the new
model with *no* claim rows, which no reading of the claim table could tell from
a fresh install. `reembed.ts` now writes the record, the rows the retry flags
return, and the pool in one transaction; a run that dies between them leaves
either both or neither, and `test-live.ts` [9] kills a run just after it prints
the record (the stub freezes every request but the probe, so nothing is
written) and asserts the whole pool is there for preflight to report. Reading
the start with that in mind found a second gap: **switching back to a model
used before did nothing.** The key `reembed:<model>@<dim>` still held the
earlier pass's terminal row for every thought that existed then,
`enqueue_thoughts` skipped them by primary key, and the run reported "Nothing to
do", exit 0, while every vector was the other model's — a state preflight would
have called finished, whatever signal it read. A model change now starts the
key's pool over inside the same transaction: every succeeded or failed row
returns to pending (rows another process holds are left to it), the run says
how many, and `--dry-run` reports it in its `would:` line.

**The two agree by sharing the words.** `formatPassCounts` in `db/config.mjs`
is the phrase `--status` and the end of a run print ("38 thoughts — 35
succeeded (1 with a caveat), 3 failed, 0 in flight, 0 pending, 0 not yet in the
pool") and the phrase preflight embeds; `reembed.ts` prints `preflight will warn
until this finishes:` with it whenever the rule holds at the end of a run or
under `--status`, so an operator reading either sees one account. A `--job` key
without the prefix is accepted — rows under an existing bare key must stay
reachable — and noted once: preflight will not report it. `test-preflight.ts`
[5] writes the states to the claim table as the tool would leave them: mid-pass
warns with the counts and `--json` carries it; a capture during the pass is
counted as not yet pooled; a finished pass with such a capture is finished; a
leased row is in-flight work; a backfill under another key is reported by its
key; a fresh install and a schema before 015 are not warnings. [9] runs
preflight itself at four points and switches the model back at the end.

**What the first review pass found, and what it changed.** Ten findings,
triaged; eight fixed, one to a ticket, one stated as a limit. The largest were
about the restart and about the remedies preflight prints. A switch abandoned
and reverted — A to B dies at 5%, the operator goes back to A and finishes —
left B's key with pending rows for ever, and the remedy printed for it,
`--job reembed:B@d`, would have made `reembed.ts` write A's vectors and record
them as B's, since the tool takes its model from the shell and never from the
key. Two changes: `reembed.ts` refuses a `--job` whose `reembed:<model>@<dim>`
names a model or width other than the configured one (`parseReembedKey`, one
parser for both files), and preflight tells a pass to a model that is no longer
the recorded one — "a switch that was abandoned or reverted" — with its two real
remedies, completing that switch in its own environment or retiring its record
(the hand `DELETE` that 015 documents; change 39 gives it a flag, `--retire`). The
configured key's remedy now carries `--switch-model` when the record disagrees
with the configuration, which is the only case where the tool would have
refused the command preflight printed. The restart was scoped to this job and
skipped a lease that had expired with no live holder: switching back with a
`--job` backfill key moved the record and left the default key's terminal rows
to report "Nothing to do", and a row a dead worker of the earlier pass had used
its attempts on was reaped as failed for that pass's reason. It now returns
every terminal row and every expired lease under this job, and also when
`ob1_config` records no model at all; a record moved by hand is stated as not a
change the tool can see. (This pass also extended the restart to every key of
the configured model; the second pass took that back — below.) A `--dry-run` without
`--switch-model` printed the restart as its plan when the run would have
refused; it says "would: refuse without --switch-model; with it: …". The
retry flags under a model change printed a count that was zero by
construction; they say the change subsumed them. A requeue of a hundred
thousand rows left the statistics describing the finished pass, since
`enqueue_thoughts` analyses only when it added rows; the transaction analyses
after a requeue that added nothing. And the run says, when it recorded the
model and thoughts were captured meanwhile, that a server not yet switched left
them on the previous model's vectors and a re-run brings them over — the one
state neither preflight nor `--status` can see afterwards, since a vector
carries no model. In the tests, the killed run's probe had pre-satisfied "the
provider was asked for the configured model"; the set is cleared. Suites after:
live 204, preflight 79.

**A second pass, and the stop.** Its top finding was in the first pass's own
code — the `--switch-model` term for an unfinished key that names no model was
an expression that could never be true, so a key like `reembed:nightly` under a
record that disagreed with the configuration got a command the tool refused —
which is the signal the loop is polishing its additions rather than finding new
ground. Applied, all small, and one taken back. The first pass's restart
returned the rows of every key of the configured model, and a `--switch-model`
run under a backfill key then re-embedded the corpus and left the default key's
whole pool pending for preflight to demand a second pass over vectors already
at the model; the restart is this job's rows again, and the header says why the
other keys are left: once the pass has finished the corpus is at the model,
which is what their finished rows say. Returning expired leases put the start
in the path of a concurrent worker's reaper, which takes the same rows, and a
deadlock the server resolves against this side ended the tool with an uncaught
rejection; the transaction is caught, rolled back whole, and says so with
"run again". A missing `embedding_dim` row made every backfill of the
configured model "a switch that was abandoned" (`dim !== Number(undefined)`);
only a present width is compared. A key at another width of the same model was
offered "finish that switch", which the column-width check refuses
deterministically; it is described as one no run can finish, with retiring the
record as its only remedy. The "preflight will warn" line printed for a key
without the prefix, which the tool had just said preflight cannot see; it says
that instead. The `--job` refusal ran before `--status` and `--dry-run` could
be exempted, so the very key preflight reported could not be inspected without
changing the shell; it joins the other refusals, where `--status` answers and
`--dry-run` reports it. The key's shape — prefix, builder, parser — is defined
once in `db/config.mjs` and both files use it. Kept, with the reason: the
restart resets `attempt_count` on an expired lease as on any row it returns,
because a model change is a new pass, not the reaper continuing the old one.
Ticket: a vector carries no model, so the claim table is a proxy that vanishes
when rows are cleared — SMD-1068 weighs a per-row `embedding_model` column.
Suites after: live 207, preflight 83. Then the tidy-ups the passes had cut for
space, while the files were open: the counts type was declared three times
(`reembed.ts`, `preflight.ts`, `config.d.mts`) and is imported from the one
declaration; the two retry flags were qualified by `!recordModel` five times
and are decided once; the spawn-and-collect body five suites had written is
`runScript` in `db/test-support.ts`; and the prefix scan in preflight says why
it is a scan.

**Not done here.** The PostgREST branch cannot read the claim table, as it
cannot read anything else the schema checks read; per-row lease renewal
(SMD-1023); extraction passes; an acknowledgement path for a row the provider
refuses permanently, which otherwise keeps the warning alive on every start
(SMD-1067 — done in change 39: `--accept-failed` under the caveat rule, and
`--retire` for a superseded key); a thought captured by a not-yet-switched server after the
record moved, which has the old model's vector and no claim row, and is
indistinguishable from a new-model capture once the pass is finished — the run
says so at its end, and the operator's step is to switch the server first;
recording the model per row, which would make the check exact (SMD-1068 —
done in change 38, which retires that paragraph: the rows say which model they
are at, and a re-run takes exactly them).
