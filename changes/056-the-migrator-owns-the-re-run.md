# 56. The migrator owns the re-run — `--reapply` re-runs every recorded migration in one transaction, and migration 030 takes back a label whose only evidence is an acceptance (SMD-1193)

`db/migrations/030_label_from_claims_excludes_accepted.sql`, `db/migrate.ts`,
`db/config.mjs`, `db/reembed.ts`, `db/test-upgrade.ts` and
`server-portable/preflight.ts` (Linear SMD-1193, filed by change 39's first and
second review passes). One migration, 030: no column, no function, two UPDATEs
of `thoughts.embedding_model` in one DO block.

**The finding.** Migration 021's evidence backfill labels a thought from its
latest *succeeded* claim row under a key naming a model, when nothing has
written the thought since (`updated_at <= finished_at`). It was written before
change 39, has no caveat filter, and — applied and hashed — is never edited.
Since change 39 a succeeded row can be `--accept-failed`'s acceptance of a
*failure*: the row says succeeded, the caveat says `kept the vector it had`, and
the thought's vector is, by decision, **not** at that key's model. On an applied
brain nothing runs that body again — except a re-run of the file: the remedy
`reembed.ts` printed for a `--baseline`'d brain whose `update_thought` body is
older than 021 (paste the body, substituting the width), and now the migrator's
`--reapply`. Over an accepted row whose thought is unlabelled (a pre-021 vector
nothing vouched for — the common case for an old thought) the block labels the
thought at the key's model; from then on the pool never takes it, `vector
models` counts it at the model, and no reader cross-checks the caveat against
the label. The wrong vector is invisible to both readers for good. Change 39
closed the *upgrade* path (`--accept-failed` refuses a schema that is not 021's
whole) and made the remedy say to return accepted rows first — a precondition
the operator could not meet on that brain: returning an accepted row is a run
(`--retry-fallbacks`), a run refuses that schema, and `--retire` takes only a
superseded key. The ticket's alternative, a re-run that *refuses* while
accepted rows stand, would deadlock the same way and is not built.

**The first commit, and what the review did to it.** The first shape was
`--reapply <start>` — re-run the named recorded migration and every recorded
one after it — with 021's `DO $bf$ … $bf$;` block split out by a regex and a
config.mjs statement (021's rule with accepted rows excluded) run in its place,
the rest of the file verbatim. A high-effort review pass took it apart, and the
findings were right: a start point is safe only when everything before it is
really present, which nothing checks — preflight's 023 remedy said `--reapply
023` on a brain whose schema stops at 020, 025's `upsert_thought` body creates
fine (plpgsql resolves a column when the function first *runs*) and the next
capture fails on the column 021 never added; the same brain's 021 remedy fails
on its first file, since the statement reads `thought_work_claims` (015). A
failure part-way through the range left objects at an *older* definition than
before the command (022's `upsert_thought` without 025's provenance; the
4-argument `match_thoughts` 014 recreates beside 020's), with nothing to say so.
The exclusion was keyed on *re-run*, so a first apply of 021 by the migrator
over accepted rows — a hand-applied schema adopted by README §4's "just run
them" — still trusted them. The count printed beside the labelled rows counted
the claim table, not what the exclusion changed. And a rule corrected inside
the migrator, for the re-run path only, left every brain already mislabelled by
the old paste wrong for good, as a `startsWith("021_")` branch in a loop the
tenth review pass of change 21 had scrubbed of filenames. So the shape changed
in all three places, below.

**`--reapply`: every migration, one transaction.** No start: the migrator
re-runs every migration — recorded or pending — in order, in one transaction
with a 10 s `lock_timeout` from its first statement; recorded rows stay as they
are (rows, shas and `applied_at` — asserted) and pending ones are recorded in
the same transaction. Every file is idempotent (`test-upgrade` [3] re-applies
the whole set over itself), so the run restores the latest definition of
everything, and a body that reads what an earlier file installs finds it there.
One transaction, so a failure part-way rolls back and the schema is as it was;
the output says so and says to run it again. Judged before `BEGIN`: a recorded
file whose sha differs from the ledger's (the plain run's drift check reports a
drifted file and moves on, which for a re-run would skip one file's definitions
and restore the next one's over whatever the skipped one left); the pgvector
floor; a shell configured differently from the brain (006 and 013 write their
`INSERT … ON CONFLICT DO UPDATE` into `ob1_config` again — a re-run from a shell
still carrying model A would flip a brain switched to B back to A, silently,
and every reader of the record with it; the model and the chunk-context flag,
not the width, which is the column's own and 006's to judge); and an accepted
row under a *suffixed* key standing over an unlabelled thought (below). Every
refusal is reported, not the first, and `--dry-run` makes the same judgements
and says "would refuse", so a green dry run is never followed by a red run.
`--baseline` beside it is refused. Every argument is accounted for — a flag the runner does not have, a
value where no flag takes one, or a flag given twice (`--url A --url B` ran
against A), is refused rather than dropped, since `--reapply=021` or a misspelt
flag was otherwise a silent plain run that exited 0. The banner says to stop
the server and the workers first and what a re-run repeats from the current
shell: 001 and 003 take ACCESS EXCLUSIVE on `thoughts`, 011 builds the trigram
index when `OB1_TRGM_INDEX` is on and it is absent, 023's call runs again and
locks `thoughts` (`OB1_BACKFILL_LIMIT` bounds it), 025 re-validates its
constraints. `--dry-run` says `would re-apply` and judges the floor as the run
does; the summary counts re-applied apart from applied; the seeds check runs
after the commit for every file that seeds, since a brain adopted with
`--baseline` never had the migrator run 014. No file is named in the loop.

**Migration 030: the corrected rule, applied once to every brain.** 021 cannot
change, so its successor does two things in one DO block, 001's `updated_at`
trigger held as 021 holds it (no row's `updated_at` moves and no audit row is
written — asserted). First, a label whose *only* evidence is an acceptance goes
back to NULL: the thought's latest succeeded row under a key naming a model is
an accepted one under the model's **own** key (exactly `reembed:<model>@<dim>`,
no suffix), the thought is labelled with that key's model, has a vector, and
nothing has written it since the row was *enqueued* — not 021's `finished_at`,
and not the claim either: the pool is built from the rows not at the model, so
a thought the pool took was not at it *then*, and a label saying it is, with
nothing written since, can only be 021's block having trusted the acceptance;
anything written after the enqueue is a server's or the worker's, and its label
is theirs — a capture at the model landing between the enqueue and the claim
(the worker re-embeds regardless, may fail, and `--accept-failed` accepts a
thought already at the target whatever its timestamps), a head window the
worker wrote through `update_thought` before the row's outcome was chosen, an
edit or re-capture since. Every accepted own-key row at the thought's latest
`finished_at` counts, not one of a tie: two releases in one transaction share
`now()`, 021 picks one without a tiebreak, and a reader that picked the other
would leave 021's label standing. Second, 021's rule with accepted rows excluded from the claim rows it
reads — `NOT (c.last_error IS NOT NULL AND starts_with(c.last_error,
'{{ACCEPTED_CAVEAT_PREFIX}}'))`, the prefix substituted from config.mjs's one
spelling like every other template value, the `IS NOT NULL` because
`starts_with(NULL, …)` is NULL and `NOT NULL` is not true — applied to
unlabelled rows only, so the latest row *before* an acceptance decides: an
earlier pass that did write the vector labels the thought at that pass's model,
exactly the vector the acceptance kept, and a thought with no such row stays
NULL. What it leaves: an acceptance under a *suffixed* key is not read against
the label — a backfill key pools thoughts at the model too, so such a label may
be the server's own, and the two cannot be told apart; 030 writes no new label
from one, and because 021's block, re-run as written, *would*, the migrator
refuses `--reapply` while such a row stands over an unlabelled thought, naming
the rows and a way back the schema allows: on 021's whole, `reembed.ts --job
<key> --retry-fallbacks` or `--retire <key>`; on an older schema, where
`reembed.ts` refuses to run and `--accept-failed` could not have written the
row, the statement `--retry-fallbacks` would run, per row — otherwise the tool
loops the operator between two refusals. The claim-key grammar 030 and that
query read is `config.mjs`'s, as two template values and two constants, and
the latest row is chosen by `finished_at` and then by key, since two rows
released in one transaction share `now()` and which wins decides whether a
label is taken back. Reached after 021 in the same
`--reapply` transaction, and pending on every brain at its next plain run, so a
brain that followed the old paste is corrected too. The rule for any successor that labels from claim rows
is stated in the file and in `reembed.ts`'s header: an accepted row is not
evidence; 030 is its spelling.

**The remedies name the command.** `reembed.ts`'s ledgered 021 refusal says
`cd db && bun migrate.ts --url … --reapply`, what the re-run does with 021 and
030, and to stop the writers first; `--status`, which reads and answers on any
schema and is what the operator reads first, now prints `a run would refuse: …`
with it. Preflight's three paste remedies — 023's `backfill_content_fingerprints`
absent under a ledger that says 023, and 014's body under a ledger that says
014, in both branches — name it too; the ALTER FUNCTION that puts 014's SET
clause back is a statement, not a paste of a file, and stays.

**Review, second pass (high), triaged — the first stop signal.** Every finding
was a seam of the first pass's reshape, and most were right: 030's first
statement bounded on `finished_at` and would have taken back the label a
worker itself wrote between the claim and the release (fixed, `claimed_at`,
and [8] plants that row); the one transaction covered recorded files only, so
a ledger hole had an earlier-numbered pending file apply *after* the re-run
over what it restored, and 030 — pending on every existing brain — ran in a
second transaction while the remedy said "the same one" (fixed: every file,
pending ones recorded inside); 006 and 013 would re-record `ob1_config` from
the shell with no line saying so (refused); a suffixed-key acceptance over an
unlabelled thought would be labelled by 021's block and left by 030 (refused,
listing the rows); no `lock_timeout` before 023's, so an idle session's ACCESS
SHARE froze the re-run and every reader behind 001's ACCESS EXCLUSIVE for ever
(a 10 s `SET LOCAL` from the first statement — which made the atomicity
testable: [7] holds a lock and watches the run fail at 001 and roll back);
`--dry-run` promised a re-apply the run would refuse on the floor (fixed); the
seeds check skipped re-applied files (fixed); 011 rebuilds the trigram index on
a re-run when the shell says on and it is absent (said in the banner and both
comments); `--url` twice ran against the first (refused). Not taken: one
`scanArgs()` shared with `reembed.ts` — its scanner has shapes this one does
not need, and folding them is a change to that tool.

**Review, seventh pass (high), at the user's call, triaged.** The sixth's
extension had a hole of its own: the gate's own-key exclusion assumed 030
would run after 021, but on a plain run with a hole at 021 *alone* 030 is
recorded and skipped, so 021 would have rewritten exactly the labels 030 took
back — the exclusion applies only when 030 runs in the same invocation, the
message says why, and [7] reads the refusal with 030 recorded. `--baseline`,
which executes no SQL, was refused on claim-row data it could never act on
(guarded). The gate's own reads took ACCESS SHARE with no timeout of their own,
before the transaction's `SET LOCAL` existed, so an idle ACCESS EXCLUSIVE
holder froze the re-run at the checks — the freeze the timeout was added to
prevent; ten seconds around the reads, reset after, and [7] holds that lock
and reads the refusal. Preflight's new `applyOr` collapsed "the ledger could
not be read" into "not recorded", printing the plain "apply 021" loop for a
role without SELECT on the ledger; one `ledgerRemedy(migration, apply)` knows
the unread case as the 023 remedy does, and the ledger is read whole rather
than through a hand-kept list of prefixes that had already drifted from its
comment. The banner announced a run before the refusals were printed (after
them now). A bare `vector` column read as `vector(-1)` with the remedy "set
the width to -1" (named for what it is). The hazards query wrapped the shared
rows in the very window the sixth pass had removed for cost — the accepted
rows are picked first and "latest" is a `NOT EXISTS`, the review's measured
115 ms to 7 ms. `requeue()`'s SET list was spelled four times (one
`REQUEUE_SET_SQL`, read by `reembed.ts`, the printed statement and the test).
**Ticketed: SMD-1421** — the reviewers' higher altitude, proposed twice: a
snapshot of the labels around 021's replay that makes 030's rule the only
rule and removes the gate, the way back and the plain-run refusal; a redesign
this late was not this PR's (done in change 61). Left as a tidy-up: the
`startsWith("021_")` literal.

A boyscout commit took what the passes cut for space, no behaviour change:
`reembed.ts` spelled the run's refusal (`refusalJob ?? refusalTtl ??
refusal021`) three times, one `refusalForRun` now; the re-run command was
spelled at five sites in `preflight.ts` and `reembed.ts`, `REAPPLY_COMMAND` in
`config.mjs` now; the migrator's gate declared a `drifted` inside the scope of
the loop's `drifted`; the loop's dry-run comment credited itself with a floor
judgement the checks make first; the pre-021 way back said "predates 021" where
only the eight-argument `update_thought` was missing, and names which.

**Review, sixth pass (high), at the user's call, triaged.** The accepted-row
gate ran only under `--reapply`, so a *plain* run applying a pending 021 over a
live corpus — a brain built by hand through 021 and adopted by README §4's
"just run them", or a ledger hole — ran the block as written and 030 could not
take those labels back: the gate runs whenever 021 will, and the plain run says
"refusing to apply 021" ([7] deletes 021's ledger row and reads it). The own
key was recomposed with a cast of the width to bigint, so a hand-written width
past bigint raised out of 030 and the gate — a regex now, the canonical
spelling (`(0|[1-9][0-9]*)`, no suffix), never a cast. The `latest` window
column in the shared rows made the subquery a barrier the planner could not
push the rare `accepted AND own_key` through, so 030's first statement
evaluated the regexes over every succeeded row (55× at 100k rows, measured):
the column is the gate's own, wrapped around the shared text. Preflight's
`edit signature`, `vector models` and `atomic capture` remedies still said
"apply 021" and "apply 022" where the ledger records them — a loop on the
baselined brain, which now names `--reapply` as 014's and 023's do. The
argument scanner echoed `--url=postgres://user:PASSWORD@…` into the log
(the shape, not the value, now). `chunk_context` was refused as a differing
record while 013 says the flag may be flipped and the record is "what was
configured when the schema was last migrated" — re-recording it is the update,
so only the model is compared. The pre-`BEGIN` reads had no try/catch (a
refusal naming the error now, not a stack trace with the connection open); the
pre-021 way back capped its statements at fifty with no marker (one statement
per key, every row); the constants substituted into 030 — the grammar, the
prefix, the rows — change what a pending 030 does with no drift signal, so
`test-schema` pins the literals and the constants say so; 030's header names
the trigger-off hand label it cannot tell from 021's. Left as tidy-ups: the
banner on stdout before refusals on stderr, the duplicated requeue spelling,
the plain loop's dead dry-run branches.

**Review, fifth pass (high), at the user's call, triaged.** Three of its
findings were consequences of the fourth's canonical-width change, and they
were right: the SQL grammar had become narrower than 021's hashed `[0-9]+`, so
an accepted row under a leading-zero key was evidence to 021 and invisible to
the gate and to 030 — the gate's invariant broken by the fix meant to keep it;
and tightening `parseReembedKey` had silenced three refusals (`--job
reembed:other@01024` ran as a pass to the shell's model, `--retire` no longer
knew the current key, preflight's advice flipped). Both are 021's grammar
again, byte for byte; "the model's own key" is the canonical spelling on both
sides, the SQL recomposing the key from its captures as `poolModelFor`
compares it. 030's first statement required the acceptance to be the thought's
*latest* row, so a paste's mislabel refused and accepted again under another
model's own key kept the wrong label for good — any accepted own-key row for
the label's model counts now, since a later acceptance under another key
vouches for nothing about this label and a later real pass moved `updated_at`
past the bound; [8] plants that row. The width joins the pre-`BEGIN`
judgements, read from the column (006 refused it inside the transaction, after
a green dry run). Smaller: the `update_thought` probe is asked only where the
vector type resolves (PG15 without pgvector raised on parsing the signature);
the label column is read by relation, not by name across every schema the role
sees; the printed requeue statement is `requeue()`'s (the attempts reset,
`claimed_at` kept); `explainFailure` knows which mode it speaks for (the
pgvector remedy's last sentence and the lock-timeout line differ); two latent
type errors — a `let` narrowed to `null` across a callback, and the missing
declarations in `config.d.mts` — are gone; the dead template values with them.
Left as tidy-ups: the fragment evaluated twice in 030, the unbounded hazard
query, the duplicated `requeue()`/`wayBack` and argument-scanner spellings, the
`drifted` shadow, and the plain loop's dry-run floor branch.

**Review, fourth pass (high), at the user's call, triaged.** The loop had
ended; this pass found four defects worth the name in the third's seams, and
took them. 030's first statement bounded on the claim, so a correct label the
server wrote *between a row's enqueue and its claim* — the pool took the
thought unlabelled, a capture at the model landed, the worker failed, the
operator accepted, which `--accept-failed` allows for a thought at the target
whatever its timestamps — would have been taken back for good, with the
standing acceptance keeping the thought out of every pool: the bound is the
enqueue now, and [8] plants the row. 030 was the first pending file to read
015's table and 021's column, so a *plain* run on the very brain this change is
for failed at 030 with a bare "does not exist" — and the compose stack gates
the server on the migrator: 030 opens with a prerequisite check that raises
with what is missing and the `--reapply` command as its HINT (ASCII only: Bun
hands a HINT holding a non-ASCII character back one letter per NUL), and [7]
runs the plain migrator on the baselined brain and reads it. The `--reapply`
gate encoded one case — a suffixed key — where the definition is the
difference of the two rules: whatever 021 labels (its bound the release) that
030 does not take back (its bound the enqueue) is refused, which also closes
the own-key row written between the claim and the release; and it takes every
accepted row at the latest time, as 030 does, since 021 picks one of a tie
without saying which. The claim rows both read are one text now,
`CLAIM_EVIDENCE_ROWS_SQL` in `config.mjs`, a template value for 030 and a
constant for the gate — the third hand-spelling is gone, and with it the
quoting seam. Smaller: a leading-zero width (`@08`) made the SQL grammar call a
key the model's own while `parseReembedKey` did not (both refuse it now);
`has_edit` lacked 018's sentinel test that `reembed.ts`'s probe has; the
re-run's catch lacked the plain run's hnsw decode (one `explainFailure` for
both, printing a raised HINT too); 030 returns before the trigger hold's lock
when no succeeded row names a model. Left, and said in 030's header: a label
021's block wrote that a metadata-only edit has since moved past the enqueue
stands, since `update_thought` keeps the label when no content arrives and
nothing here tells such an edit from a re-capture — the alternative is a second
evidence rule over 008's audit rows. Left as tidy-ups: the refusal precedence
spelled three times in `reembed.ts`, the remedy command at seven sites, the
argument scanner, and the plain loop's drift and floor branches, unreachable
under `--reapply --dry-run` now that the pre-check exits first.

**Review, third pass (high), triaged — the second consecutive stop signal, so
the loop ends there.** Every finding was a seam of the second pass's fixes, and
most were right: the suffixed-key refusal named two `reembed.ts` commands that
tool refuses on the very brain the re-run is for (fixed: the way back follows
the schema); `--dry-run` under `--reapply` printed the live banner and skipped
the record and hazard checks, so a green dry run preceded a red run (fixed: one
pre-check for both, every refusal reported); the pgvector floor's remedy said
"migrations before it are applied and recorded" when nothing had run (fixed);
the width was compared against `ob1_config` when the column is the authority
and 006 judges it (dropped); the hazard list said `50+` at exactly fifty and
derived its keys from the truncated rows (no limit; fifty shown, the rest
counted); `DISTINCT ON … ORDER BY finished_at DESC` had no tiebreak, and 030 is
the first consumer whose outcome depends on *which* row wins (the key); the
claim-key regexes were spelled inline eight times across 030 and the hazard
query (two constants in `config.mjs`, two template values); `reembed.ts --status
--dry-run` printed the refusal twice and `--status` judged only 021 where a run
judges three (fixed); test [7] stripped `OB1_CHUNK_CONTEXT` from the child's
shell after applying the schema with the parent's, so a developer with the flag
on saw the new refusal fire (fixed); the README's FORK pointer list and its
`test-schema` count were behind (fixed). Not taken: pre-filtering 030's three
scans to candidate thoughts (a few seconds, once; 021's shape); a configurable
lock timeout to spare CI ten seconds; 028's column comment, which still presents
021's trust as the standing exception (a comment is hashed with its file, and
030 adds none).

**Not done here.** `db/README.md`'s migrations table stops at 023, and a row
for 030 alone would mislead; its FORK pointer list names 030. The argument
scanner is the migrator's own, a third hand-rolled copy beside `reembed.ts`'s
and `extract-entities.ts`'s.

Verified: `test-upgrade` [7] builds the brain the ticket describes — the schema
applied through 020, then `migrate.ts --baseline` so the ledger says every
migration — plants four thoughts written two hours ago and the claim rows (a
plain succeeded row an hour later; an accepted row with the failure's own
timestamps; an earlier pass's plain row under its key and the acceptance under
the new key over the same thought), and asserts `reembed.ts --status` names the
command and not the paste; `--dry-run` counts every recorded file and writes
nothing; the run's banner and summary; the labels (`stub-embed`, NULL,
`earlier-model`, NULL — 021's block labelled the accepted thought and 030 took
it back, in one transaction); no `updated_at` moved, no audit row, the trigger
enabled after; the recorded ledger rows untouched and the one deleted row (022,
a ledger hole) recorded, the file applied in its place; the eight-argument
`update_thought` alone and the 3-argument `upsert_thought` carrying 022's
sentinel *and* 025's provenance; and the refusals, each with nothing written —
a shell whose model differs from the record, an acceptance under a suffixed key
over an unlabelled thought (naming the row; returned to its pool, the run goes
and the thought stays NULL), a session holding a lock on `thoughts` (the run
fails at 001 within the lock timeout and rolls back whole), a value beside the
flag, a flag the runner does not have, `--baseline` beside it, a drifted
recorded file; and that the re-applied schema has a fresh apply's columns and
functions; that `--dry-run` from a differing shell says "would refuse"; and
that a plain run on the baselined brain, 030 pending, fails at 030 naming what
is missing and `--reapply`; that a shell whose width differs from the column
is refused before `BEGIN`, dry run included; that a plain run with 021
pending is refused on the same accepted rows, and with 030 recorded on the
own-key acceptance too; and that an exclusive lock on `thoughts` fails the
checks before the run within their own timeout. [8] applies 030 onto a
populated 029 holding twelve labels — a
paste's mislabel (back to NULL), a real pass's label with a later acceptance
under another model's key (stays), an acceptance under a suffixed key (stays),
a mislabel edited since (stays), a head window the worker wrote between the
claim and the failure (stays), a capture the server made between the enqueue
and the claim (stays — the bound is the enqueue), a paste's mislabel refused
and accepted again under another model's own key (back to NULL — the later
acceptance is the latest row and vouches for nothing about the label), an
unlabelled thought with an earlier pass then an acceptance (labelled at the
earlier pass),
a mislabel with an earlier pass (taken back and relabelled at it, in the one
block), a plain row (labelled), a label with no claim row (not read) — no
`updated_at` moved, no audit row, the trigger enabled, and a second apply a
no-op. `test-preflight` pins the 023 and 014 wordings; `test-schema` [29] pins
the literals 030 is substituted with. `test-upgrade` 106/106,
`test-preflight` 174/174, `test-schema` 644/644, `test-live` 419/419, `tsc`
clean, fork checker PASS (on the tree with SMD-1304's and SMD-1294's changes
merged in). Upstream status:
**not applicable** — the migrator, `reembed.ts` and preflight are the fork's
(changes 11 and 29).
