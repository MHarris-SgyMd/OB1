# 39. The operator's way to say "I know" — `--accept-failed` under the caveat rule, `--retire` for a superseded key, and preflight names both

`db/reembed.ts` and `server-portable/preflight.ts` (Linear SMD-1067, filed by
change 35's first review pass). No migration. Since change 35 preflight reports
a re-embed pass unfinished while any row under its key is pending, leased or
**failed**, and the container runs preflight on every start. Right for a row a
retry can fix; endless for one the provider refuses permanently — a content
filter that rejects one thought on every attempt — where `--retry-failed`
re-fails it every time and the row keeps the vector it had. Change 34 covered
the permanent *over-length* refusal (a 413 → succeeded, the head window stored,
the refusal on the row as a caveat); a permanent *content* refusal has no
partial result to store, and the only silencers were deleting the thought or
clearing its claim row by hand — the "permanent warning nobody can clear" that
preflight's own filtered-search check refuses to be. The same shape once more: a
key whose model is no longer the recorded one (a switch abandoned or reverted)
was reported with a hand `DELETE FROM thought_work_claims WHERE work_type = …`
as one of its two remedies.

**`--accept-failed <thought-id…>`, under change 34's rule.** The failed row
becomes succeeded with the caveat `kept the vector it had; accepted by the
operator: <the failure>` — `ACCEPTED_CAVEAT_PREFIX` in `db/config.mjs`, the one
spelling both tools read — and the row's timestamps stay the *failure's*: the
bound below is measured from `claimed_at`, the moment the attempt read the
content the provider refused, not from the acceptance (first review pass:
stamping its time would have spoken for content edited between the two, which
the caveat never described) nor from the release (second pass: an edit landing
while the provider was still refusing would have hidden behind it). The rule is
unchanged: a succeeded row's `last_error` is what the worker could not do, here
what the operator has accepted it will not do. No fifth status (015's CHECK
would need a migration for four lines of value), no column. Per row, by id;
`--all` exists and is explicit, says that a provider outage accepted that way
hides itself, and takes no ids beside it. An id that is not a *failed* row
under the job — succeeded, pending, leased, or no row — refuses the whole
command with each id's state, and nothing is written; so does a shell whose
model is not the recorded one (the failed rows under its key are a pass that
has not recorded itself: run it with `--switch-model`, and accept what it
leaves); so does a schema that is not 021's whole — the same refusal a run
makes — because 021's evidence backfill trusts every succeeded row under a key
naming a model, an accepted row included, and would label the thought at a model
whose pass never wrote its vector (the remedy that re-runs 021's body on a
`--baseline`'d brain now says to return accepted rows first); and so does a
failed row whose thought has *no vector*, passed over and said under `--all`,
since acceptance keeps a vector and a thought with none would vanish from search
with nothing left to say so; and so does a failed row whose thought was written
since the attempt read it while not at the target — the acceptance would be void
as written, every reader applying the bound below, and the next run would spend
it (third pass; a thought at the target, its head window the worker's own write,
is accepted whatever its timestamps). Every argument is accounted for: an id
after another flag, a flag the tool does not have, a flag given twice, or a flag
that takes a value followed by another flag, is refused rather than dropped or
read as the value (second pass — `--accept-failed a --dry-run b` accepted one
row and exited 0; third — `--job --switch-model` would have backfilled the
corpus under the key `--switch-model`). `--status`
counts them inside the caveat parenthesis ("37 succeeded (2 with a caveat, 1
accepted by the operator)") and lists them among the caveats; every list of
failed rows names the flag; `--retry-fallbacks` returns them like any caveat,
which spends the acceptance — `requeue` clears `last_error`, a second refusal
fails the row again, and the operator accepts again or not.

**What acceptance means to the two readers, and its bound.** This is where the
ticket met change 38. Since 021 the rows say which model they are at, and
`reembed.ts`'s data rule returns any succeeded row whose thought is not at the
target to the pool on every run — which an accepted row's thought is, by
decision; and preflight's `vector models` warns about every vector at another
model. Left alone, the next plain run would have un-accepted the row and the
label would have kept the warning alive by another route. So both readers
honour the acceptance: the data rule leaves an accepted row (`NOT (accepted AND
updated_at <= finished_at)`, under either key shape), and `vector models` counts
its vector as detail — "41 at stub-embed, 1 at another model accepted by the
operator (old-model: 1)", an ok — a warning counting only the un-accepted. Each
ONLY WHILE NOTHING HAS WRITTEN THE THOUGHT SINCE THE ATTEMPT READ IT:
`updated_at <= claimed_at` (`finished_at` for a row never claimed, and a
hand-written row with neither is never standing rather than NULL — third pass),
the shape of the bound 021 gave its backfill and change 38's fifth review pass
gave the data rule under a backfill key. An edit, or a re-capture, is a new question, and the
row returns to the pool as any moved row does (a metadata-only edit reopens it
too: one evidence rule, not two). Preflight counts an acceptance only under the
recorded model's *own* key (`ACCEPTED_BY_MODEL_SQL`; a backfill key's acceptance
tells the backfill, while the own pass pools the thought by its label whatever
another key accepted — counting it would have silenced the check while the own
pass re-failed the thought on every run, first review pass): an acceptance
under B's key says "stays where it is while the corpus moves to B", and after a
move to C it says nothing — C's own pass has no row for the thought, pools it,
and it is accepted under C's key or not. The claim table may lower that warning
because the acceptance *is* the operator's word about exactly those vectors;
clear the table and the warning returns, which is right — the acknowledgement
was deleted. Everything else sees the succeeded row it is: `enqueue_thoughts`
skips it by primary key, `--retry-failed` does not see it, a model change under
the model's own key restarts failed rows and expired leases and leaves it;
under a backfill key every terminal row restarts, accepted included, as before.

**`--retire <key>`.** One qualified `DELETE`, in TypeScript, of a *superseded*
pass's rows — a key whose `reembed:<model>@<dim>` is not the recorded model,
the recorded model at another width (which nothing can complete), or a
`reembed:` key naming no model (an abandoned backfill) — printed by preflight
as the remedy in place of the hand statement. Refused, with nothing written: a
key without the prefix (another tool's pass), a key naming the recorded model —
or this shell's, when nothing is recorded — at the column's width, suffix or
not, whose pass can be finished or its
failed rows accepted (both tools judge a key's width by the *column's*, before
any record — a pass runs at the column's width and no other, so a hand-edited
record must not make the one finishable key superseded — and the current model
is the record's, or this server's when nothing is recorded, in both: second and
third passes, where this server's configured width had stood in for a column
preflight never read, and where preflight with nothing recorded sent a stale key
to "finish it under X"), a key with a live lease (a pass under it is running —
the check and the DELETE are one transaction over the key's locked rows, the
DELETE bounded to those rows and the record's row read `FOR UPDATE` inside, so a
`--switch-model` back to that model either committed first and is seen or waits
— second pass read it plainly, and a switch that locked none of the key's rows
could commit unseen in between, third), and a key with no rows (a typo is the
likelier cause). It prints what it removed, judged against the current model
rather than this shell's, worded by what the pass did, and
then the corpus by model: the vectors the retired pass wrote are still at its
model, and `vector models` reports them until they are re-embedded — the truth
the rows keep once the record is gone. Both flags are maintenance modes like
`--status`: the claim table and nothing else, no provider, no model recorded;
they combine with `--dry-run` and with nothing else. Preflight's `re-embed
pass` remedies name both: `--accept-failed <thought-id…>` under the key's own
`--job`, beside `--retry-failed`, wherever a key has failed rows and the remedy
does not carry `--switch-model` (the tool refuses the two together, and refuses
acceptance under a model change — the switch first, then what it leaves); and
`--retire <key>` in the superseded and other-width branches — and a configured
key the record has moved on from is a superseded key too, judged before the
configured-key branch, so its operator gets both remedies rather than "finish
it" alone (third pass). `--status` and a run predict preflight's second `vector
models` warning too — no vector known to be at the model, its vectors all
accepted or unlabelled — so the two tools still never disagree; and the hint
under a list of failed rows names what *this* shell can do — `--retire` for a
key naming another model, `--accept-failed` after the switch under a model
change.

**Verify, as the ticket asked.** `test-live.ts` [9]: the poisoned row that never
recovers — `--accept-failed` with no ids refuses listing the three failed rows
and both forms, an id whose row is succeeded refuses the whole command, a run
flag beside it refuses, `--dry-run` says what it would accept; accepted, the row
is succeeded with the caveat naming the failure, keeps its vector, is counted
inside the caveat count and listed by `--status`, refuses a second acceptance,
`--retry-failed` re-embeds the other two and does not see it, and
`--retry-fallbacks` returns it with the head-window row and re-embeds both.
Then the seam with 021, under the model's own key: one of the two rows the old
server wrote is the poisoned text, so the plain run re-embeds one and is
refused the other, which keeps the old server's vector and label; preflight
warns from the claim row (naming `--accept-failed`) and from the label;
accepted, preflight says `none unfinished` and `41 at stub-embed, 1 at another
model accepted by the operator (old-model: 1)` as an ok; a plain run has
nothing to do — the data rule stops at the operator's word; the old server
saves metadata on it, and `--dry-run` says the row returns and preflight warns
again; once the provider relents the run re-embeds it. `--retire`: an abandoned
switch's key is reported with `--retire` and no DELETE; the recorded model's
key, another tool's key, an empty key and a key with a live lease are refused;
`--dry-run --retire` of the suite's key says what it would remove; the
superseded key's two rows are removed and preflight has nothing left.
`test-preflight.ts` [5]: the configured key's remedy names `--accept-failed`;
the superseded and other-width remedies name `--retire` and no DELETE; an
accepted row's vector is detail beside the recorded model's, a second
un-accepted row at that model warns counting only itself, and an edit since the
acceptance is no longer spoken for. Suites: live 286, preflight 123; schema 462
at both widths, upgrade 27; the rest unchanged (before the pass below).

**A first pass, triaged.** Ten findings, all fixed, none ticketed — each a seam
between the acceptance and a rule that already read the row. The acceptance
test inside the data rule was `NOT (starts_with(last_error, …) AND …)`, and
`starts_with(NULL, …)` is NULL: every ordinary succeeded row's predicate went
NULL, so a thought that moved before its claim was released was never returned
— now `last_error IS NOT NULL AND …`, and the live suite constructs that row.
Acceptance stamped `finished_at = now()`, so an edit between the failure and the
acceptance was covered by a caveat that never described it — the failure's own
`finished_at` stays. `ACCEPTED_BY_MODEL_SQL` matched keys by model name, so an
acceptance under a backfill key silenced `vector models` while the own key
re-failed the thought — the own key only. A corpus with zero vectors at the
recorded model and every foreign one accepted fell through to ok — `at === 0`
warns whatever is accepted. `--accept-failed` ran on a pre-021 schema, where
021's backfill would then trust the accepted row — refused. `--all` beside ids
took every failed row — refused. The counts called a row accepted by prefix
while both readers applied the bound — the counts apply it too. `--retire` with
no width recorded refused every width while preflight sent the operator to a
`--job` the tool refuses — the column's width stands in, in both. With no model
recorded the configured shell's own key was retireable, and the lease check and
the DELETE were two statements — this shell's model counts, and the two are one
transaction over the key's locked rows. The accepted rows were listed from the
SELECT before the UPDATE — from its `RETURNING`. Cut for space by the pass and
left for the tidy-up: the inline copy of `notAtTarget()` inside the data rule.
Suites after: live 293, preflight 126.

**A second pass, triaged.** Ten more, all fixed, none ticketed; the top one was
in the first pass's own addition — the bound — which by the stop rule of
change 38 is the signal, and by its exception (the bound is read by three
rules) is why a third pass is worth asking for. `finished_at` is the release's
time, and the failed attempt read the content at `claimed_at`: an edit landing
while the provider was still refusing was covered — the bound is `claimed_at`
now, everywhere it is written, and the live suite dates a claim back to show
the acceptance drop. Accepting a failed row whose thought has no vector wrote
"kept the vector it had" onto nothing and silenced the last signal that the
thought is invisible to search — refused by id, passed over and said under
`--all`. The remedy that re-runs 021's body on a `--baseline`'d brain would have
had its backfill trust an accepted row — the remedy says to return them first,
and acceptance now needs 021's schema whole, as a run does. `--retire`
protected this shell's configured model unconditionally, so the shell that ran
an abandoned switch could not retire it — the record's model is current, this
shell's only when nothing is recorded. Preflight substituted this server's
`OB1_EMBEDDING_DIM` for a column width it never read — it reads it now.
`values()` stopped at the next flag, so `--accept-failed a --dry-run b`
accepted one row — every argument is accounted for. `--retire`'s DELETE took
rows committed after its lock, so a `--switch-model` back to that model landing
between the two lost its pool — the DELETE is bounded to the locked rows and
the record re-read inside. reembed.ts predicted only one of preflight's two
`vector models` warnings — both now. The `--accept-failed` clause preflight
printed carried neither the key's `--job` nor the `--switch-model` context, so
for a backfill key it accepted under the wrong key and beside a switch it was a
command the tool refuses — under the key, and omitted beside a switch. Cut for
space by the pass and left for the tidy-up: the bound spelled four times, the
inline copy of `notAtTarget()`, two vocabularies for one corpus line, the
`O(F²)` filter under `--all`, `--retire` materialising every row to count by
status. Suites after: live 298, preflight 128.

**A third pass, triaged.** Ten more, all fixed, none ticketed; the top one was
again in the previous pass's own addition — the argument scanner — and three of
the rest were cells of the same tables the first two passes had drawn (the
width authority, the current model, the bound's NULLs). The scanner read a flag
as another flag's value: `--job --switch-model` backfilled the corpus under the
key `--switch-model` — a value must be one, and a flag given twice is refused
rather than its second list dropped. `--retire` and preflight judged a key's
width by the record before the column, so a hand-edited record made the one
finishable key superseded — the column first, in both. The record re-read inside
`--retire`'s transaction was a plain read: a `--switch-model` back to that model
that locked none of the key's rows committed unseen between the lock and the
DELETE — the record's row is read `FOR UPDATE`. Preflight's "another model"
test required a recorded model while `--retire` fell back to the shell's, so
with nothing recorded a stale key was sent to "finish it under X" — the same
fallback in both. `--accept-failed` wrote an acceptance every reader would treat
as void when the thought had been written since the attempt read it — refused,
with `--retry-failed` named, for a thought not at the target. The corpus line
after a `--retire` was judged against this shell's model, so the shell that ran
the abandoned switch was told the whole corpus was elsewhere — against the
current model, and "wrote no vector" when it wrote none. A configured key the
record had moved on from got "finish it" alone — the superseded branch first.
The failed-rows hint offered `--accept-failed` under `--status` in the two
states the tool refuses it — it names `--retire` or the switch there. A
hand-written accepted row with neither timestamp evaluated NULL in every reader
and was never returned — `-infinity`, so it is consistently not standing. Cut
for space and left for the tidy-up: the standing predicate spelled three times,
the width read twice, the flag-arity table beside `flag()`/`values()`, the UUID
regex `store-sql.ts` already has, dead `values("all")`. Suites after: live 303,
preflight 131.

**Tidy-up, while the files were open.** No behaviour change. The standing bound
is spelled once in `reembed.ts` (`standingBound()`, for a thought aliased `x`
beside an unaliased claim row, which is how every reader there joins the two —
the acceptance query is re-aliased to match) and once more in `config.mjs` for
preflight and the corpus query, where the aliases differ; the data rule's
own-key branch reuses `notAtTarget()` instead of its inline copy; the flag-arity
table sits beside `flag()`, `has()` and `values()`; the dead `values("all")`
test is gone (the scanner refuses anything after `--all`); the chosen rows are
filtered by a set; the comment that said a reaped lease lacks `finished_at`
says what 015 does. Left: `store-sql.ts`'s UUID pattern is inline, not
exported, and that file is not this change's to touch; `--retire` reads the
key's rows rather than counting them, because the lock and the bounded DELETE
need them; the corpus line's wording differs between the two tools, and
changing it is a change in what they print.

**Not done here.** An acceptance under a backfill key is spent by a model change
(every terminal row restarts there, as before 021), so a corpus whose history is
under `reembed:nightly` re-asks every accepted row on a switch. 021's evidence
backfill is applied and never edited, and trusts a succeeded row whatever its
caveat: the gate on 021 closes the upgrade path, and a hand re-run of 021's body
over accepted rows whose thought is unlabelled is the case that remains, said in
`reembed.ts`'s header (done in change 56: the migrator owns the re-run, and
migration 030 takes back a label whose only evidence is an acceptance). The
extraction worker has no acknowledgement path of its own — its failed rows are
016's, and preflight does not read them.
