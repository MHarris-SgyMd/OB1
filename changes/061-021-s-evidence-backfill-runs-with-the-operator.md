# 61. 021's evidence backfill runs with the operator's acceptances out of its sight — a view of the claim table shadows the real one for that file, and no gate refuses the run (SMD-1421)

`db/migrate.ts`, `db/config.mjs`, `db/config.d.mts`, `db/reembed.ts`,
`db/test-upgrade.ts`, `db/test-support.ts`, `db/README.md` and
`scripts/check-fork-consistency.mjs` (Linear SMD-1421, filed by change 56's
sixth and seventh review passes). No migration: 030 stands as it is, and the
correction it cannot make becomes the migrator's.

**The finding.** Change 56 gave `migrate.ts` a gate: before 021's evidence
backfill ran — under `--reapply`, or on a plain run with 021 pending — it
refused when an accepted claim row stood that the block would label an
unlabelled thought from and 030 would not take back, listed the rows, and
printed a way back that spent the acceptance (`reembed.ts --job <key>
--retry-fallbacks`, `--retire <key>`, or the statement `--retry-fallbacks`
runs, on a schema `reembed.ts` refuses). Seven review passes found a seam in it
each — the bound, the grammar, the tie, the plain path, 030 not following, the
lock — because the gate was the *difference* of two rules, 021's and 030's, and
every case either rule had was a cell the gate had to enumerate by hand. The
sixth and seventh passes proposed the same higher altitude: the migrator holds
the one fact 030, hashed and applied, cannot — the labels *before* 021's replay.

**What this does.** One helper, `applyShadowed`, runs every file, and runs
021 with the operator's acceptances out of its sight. Before the file, a temp
*view* named `thought_work_claims` is created over the real table without the
accepted rows — `ACCEPTED_CLAIM_SQL`, the predicate 030's evidence rows carry,
spelled once; a view, not a copy, so nothing is materialised and the block
reads the claim rows as they stand when it runs. An unqualified name resolves
in `pg_temp` before any schema on the search path, and 021's block is a `DO`
block, resolved when it runs, so it reads the view and labels from the latest
row that is *not* an acceptance, or not at all: 030's rule, by 021's own text,
with no second spelling and nothing wrong ever written. The view is dropped
right after the file in the same
transaction, so 022 onward read the real table. `pg_temp` is searched first
for relations exactly when the path does *not* list it — listed first, it is
also where `CREATE` puts things, functions included — so a role's path that
lists it has it removed for the transaction, the path is otherwise left alone,
and that the name resolves to the copy is checked before the file runs.
Creation targets are then unaffected. The view takes ACCESS SHARE on the claim table, as 021's
block did, and nothing on `thoughts` before 021's own ADD COLUMN: no lock the
file alone never took. The run says beside 021's line how many thoughts the
block labelled — zero included, read from the transaction's own statistics
(`pg_stat_xact_user_tables`), so nothing reads `thoughts` before the file.
Judged before any SQL, both modes: the role may create a temp table. The
loader refuses a set without 021 and two files sharing a number, since the
file is named whole; the fork checker refuses the second on every push, where
the collision is made.

**What went.** The hazards query, both arms of the way back, the `has_edit`
and signature probe, the claim-table probe, the "030 recorded" branch, the
plain-run refusal and `runs021`/`runs030` — about a hundred lines of
`migrate.ts` — and `REQUEUE_SET_SQL`'s second reader (`reembed.ts` keeps the
constant). The re-run keeps its four judgements before `BEGIN` — drift, the
pgvector floor, the column's width, `ob1_config`'s model against the shell —
and the checks' own lock timeout now guards the `ob1_config` read alone. The
operator never spends an acceptance to re-apply: the suffixed-key acceptance,
the own-key acceptance over a thought written since its enqueue, and the hole
at 021 with 030 recorded — the three cases change 56 refused — end with the
thought unknown and the acceptance standing. `reembed.ts`'s ledgered remedy and
`db/README.md` §5 say so.

**Why the input and not the output.** Four review passes bracketed 021's
*output* instead — a snapshot of the unlabelled ids before the file, a
set-back under a held trigger after it, and 030's rule applied to the rows set
back: first as a copied constant, then as 030's own text run inline, then
deferred to 030's own place, then inline on plain runs only — and each pass
found a seam in the bracket: the lock upgrade from the snapshot's read to the
file's ALTER; the claim row committed between snapshot and block; 030's
current text run past its drift check; a `WHERE false` that still named an
absent column; an early return that skipped 030's first statement; a SHARE
lock that needed UPDATE where the file needed SELECT. The fifth pass proposed
the shadow and verified it against 021's actual block on a throwaway Postgres:
nothing to set back, nothing to report but a count, no lock the file did not
take, no second code path. What it costs: a tie on `finished_at` between two
plain rows is 021's unnamed pick rather than 030's `work_type` tie-break, and a
label from before 021 that 030's first statement would take back — a paste of
the body over an acceptance — waits for 030's own run, which on a hole at 021
alone is the re-run. The ticket's sketch, which kept a label whenever *any*
non-accepted row at that model supported it, is wrong in one shape (plain rows
at M then E, then an acceptance at M: 021 writes M from the acceptance, the
sketch keeps it, E is right); the shadow has no such case, since 021 reads the
latest non-accepted row.

**Review, first pass (high), triaged.** The snapshot's read took ACCESS SHARE
on `thoughts` before 021's ADD COLUMN asked for ACCESS EXCLUSIVE — a lock
upgrade the file alone never did — so on a plain run with the server still up
a label written in that window would be set back as if 021 had written it, and
two migrators would deadlock; the bracket now takes 021's lock first, and
within 10 s (the plain loop had no timeout, and the removed checks were the
only fail-fast a plain run with 021 pending had — [7] holds the lock and reads
the failure at 021 with nothing recorded). The count line said every set-back
label was "from an acceptance" when the count is the rows the rule disagreed
with 021 on — 021's unnamed pick of a tie included — and the count itself was
read from an undeclared `count` field on Bun's result; it is now `WITH changed
AS (UPDATE … RETURNING 1) SELECT count(*)`, `reembed.ts`'s idiom, and the line
says "set by 030's rule instead". The snapshot was corpus-sized and built even
where no succeeded claim row names a model; the bracket short-circuits on
030's own test and snapshots only thoughts with such a row (a thought without
one is labelled by neither side, so the writes and the count are unchanged).
The rule was spelled twice in one UPDATE (the SET and the predicate) — a
derived table computes it once. The `startsWith("021_")` literal was doubled
by a scalar slot; the re-run collects a map and `sql.begin` returns the plain
run's value. The checks' own lock timeout had lost its only test with the
gate; [7] locks `ob1_config` and reads "could not be judged". A stale comment
in [7] still called the gate current. **Ticketed: SMD-1434** — the altitude
above this one: a plain run applies a pending file after recorded later
siblings (a ledger hole) with no judgement, and 021's body over 022's and
025's `upsert_thought` is only the case this ticket's fixture happens to show;
the loop can refuse, or warn under `--dry-run`, and name `--reapply`.

**Review, second pass (high), triaged.** The bracket locked `thoughts` and not
the claim table, so a claim row committed between the snapshot and 021's block
— `--accept-failed`'s UPDATE is a separate autocommit statement needing only
ROW EXCLUSIVE — was evidence the block read and the snapshot never saw, and
its label stood; the claim table is locked SHARE after `thoughts` (reembed.ts's
start takes them the other way round, and the banner says to stop the workers
first). The first pass's 10 s applied to 021 alone, overriding a role's
default for one file while every other plain-run file had none; every
transaction the migrator opens now sets one `LOCK_TIMEOUT_S`, quoted by every
message that names it, and the plain arm of the lock message says so. The
first pass's `LATEST_UNACCEPTED_CLAIM_SQL` was a second executable spelling of
030's second statement, held equal to the file only by an indentation-sensitive
pin; the bracket now sets 021's labels aside and runs 030's own substituted
text, so the rule has one spelling and the constant, its declaration and the
pin are gone (the reviewer's measured cost of the join it replaced — the claim
table read whole under the exclusive lock — is now 030's own, stated in the
comment). The count line became a report: how many thoughts 021 labelled, how
many 030's rule changed, and the first fifty rows with both labels, since the
label is not an edit and nothing else records them. `reembed.ts`'s "Saying I
know" still credited the re-run's correction to 030 alone, and README §5 said
030 corrects "what a paste left" when it corrects the own-key labels only.
The docblock claimed the bracket's evidence test was 030's early-return test,
which differs (`finished_at IS NOT NULL`); it is 021's. The tri-state return,
its cast and `Number()` went (`Promise<Bracket>`, empty for other files). [7]
hoists `labels()`, adds `recorded021()`, and splits the hole assertion so a
failing regex prints the run.

**Review, third pass (high), triaged.** On a plain run with a hole at 021 the
bracket ran 030's *current* text before the loop reached 030's drift check, so
an edited-after-apply 030 ran and committed — refused before anything runs,
both modes, and [7] edits the ledger's sha and reads the refusal and the dry
run's. 030 was found by `startsWith("030_")`, which any second 030_*.sql
sorting first would satisfy (the fork has renumbered twice; a sibling branch
carries a 030 today): both files are named whole, and the loader refuses two
files sharing a number. The inline run of 030's whole text had its first
statement re-decide labels from *before* 021 with no report, beside a 030
line that said "already applied" — and ran 030 twice on every ordinary
upgrade: 030's text now runs inline only where the ledger records 030 and the
run would skip it, with every prior label noted first and a second delta
reported ([7] plants a paste's mislabel and reads it); otherwise 021's labels
are set aside for 030's own place, where the report is printed from a session
temp table. A TEMP-revoked role failed the bracket with a bare 42501 after
015–020 had committed, and a set without 030 threw inside 021's transaction:
both judged before any SQL (the second at load), both modes. A deadlock with a
worker's start (the docblock said "detected, not waited on") had no remedy
line; 40P01 has one. The count line's clause "an acceptance is not evidence"
had come back after the first pass removed it (a tie has none) — gone, and
"every acceptance stands" became "no claim row is touched". The README said
the run lists the rows while the code listed fifty — every row now. Change
57's file list named `test-schema.ts` (untouched after the second pass) and
missed `config.d.mts`.

**Review, fourth pass (high), at the user's call, triaged.** The third pass's
inline note of the labels from before 021 named the column in a `WHERE false`
query — resolved when the statement is parsed, so every plain run of a
`--baseline`'d brain with a hole at 021 and no column yet failed at 021; a
`NULL::text` there, and [9] runs that brain. The third pass's handoff — 021's
labels set aside for 030's own place — left every label 021 wrote, the right
ones too, committed NULL across 022–029's separate transactions on a plain
upgrade, where a worker's pool reads NULL as work; a plain run now decides
them inside 021's transaction (030's text runs again at its own place if
pending, idempotent, once in a brain's life), and only the re-run, one
transaction, defers — which also closes the report a dying run lost with its
session table and the count a live server could skew between the two
transactions. The bracket's judgements exited before the re-run's were
collected, against the "every refusal, one dry run" contract: one list, one
tail. The plain run took locks 021 alone never did — the claim table's against
writers, the other way round from a worker's enqueue — with no note to stop
the workers (the banner is the re-run's) and a deadlock line naming a re-embed
start that cannot run on a pre-021 schema: the plain run says so before it
applies 021, the banner and README name the lock, the lock messages name the
claim table, the deadlock line names an enqueue. The load-time check was
one-directional (a renamed 021 ran bare): both files or neither. The pre-021
label note copied every labelled thought; bounded to those with an own-key
acceptance, the only rows 030's first statement can change. [9] is new: the
plain run with the column absent, then with both files pending — the ordinary
upgrade path, which no test had run through the bracket.

**Review, fifth pass (high), at the user's call, triaged.** The fourth pass's
`wrote === 0` early return sat before the inline run of 030's text, so the
labels from before 021 it promised to re-decide were re-decided only when 021
had labelled something else — and the same return left an empty temp table
for the re-run's 030 to report "decided 0 labels" from. `LOCK TABLE … IN SHARE
MODE` needs UPDATE on the claim table where 021's block needed SELECT: a
read-only migrator role would have failed 021 with a bare 42501. The pre-021
note was itemised on a plain run and swallowed on the re-run. A deadlock's
victim is whichever waiter's timer fires first — the worker, most likely — so
the 40P01 line held for one of two victims. The per-row list had lost its
cap. Every one of these was the bracket's, and the reviewer proposed the
altitude above them, verified: shadow the claim table for 021's block with a
copy that carries no acceptance. Taken — the bracket, its types, its report,
its three temp tables, the claim-table lock, the plain-run note, the 030-drift
pre-check and the both-files check are gone; kept are the TEMP refusal (the
copy needs it), the loader's duplicate-number refusal, `LOCK_TIMEOUT_S`, one
list of refusals, the lock messages, a deadlock line that names no order.
`ACCEPTED_CLAIM_SQL` is the acceptance predicate spelled once, for 030's
evidence rows and the copy alike. [7] and [9] share one fixture and one
exit-tail helper; [7]'s 030-drift case went with the pre-check. Running the
suite found one more: named *first* in the search path, `pg_temp` is also
where `CREATE` puts things, functions included, and 021's `update_thought`
landed there and vanished with the transaction — so the path is left alone,
or stripped of `pg_temp` where a role lists it, and the shadow is checked
rather than arranged.

**Review, sixth pass (high), at the user's call, triaged.** Nothing checked
that 021 was in the set: a renamed file ran bare, reading the acceptances,
with no line saying so — refused at load. The labelled count was two
`count(*)` scans of `thoughts`, the first taking ACCESS SHARE before the
file's ADD COLUMN asked for ACCESS EXCLUSIVE — the lock upgrade the first pass
had removed, back on the plain path, and [7]'s held-lock case was timing out
on the count, not the ALTER; the count is now the transaction's own
`n_tup_upd` on `thoughts`, before and after, O(1) and no read of the table.
The line printed only for a non-zero count, so "shadow ran, nothing to label",
"ran bare, no claim table" and "older migrator" were one silence — printed at
zero too. A `DROP TABLE IF EXISTS` of the temp name was dead, and in the one
state it seemed to guard (a pooled connection handed over with such a table)
it broke the copy's source, resolved before the drop: gone, and that state is
refused. The copy carried every column of every claim row; the four the block
reads. The TEMP refusal led with acceptances on a fresh database with no claim
table; it leads with the privilege, and [9] exercises it with a role that has
none. The duplicate-number rule lived only in the runner, at every operator's
and compose start's expense; the fork checker carries it too, on every push.
Two README lines and this section's heading still described the bracket. [9]
plants a suffixed-key acceptance and rebuilds the brain for the both-pending
run, so the column is truly absent there.

**Review, seventh pass (high), at the user's call, triaged.** The
stale-temp-relation refusal keyed off the schema the *unqualified* name
resolved to, so a role path listing `pg_temp` last skipped it and the CREATE
died bare; it asks `pg_temp` by name. The copy was a materialised CTAS of
every non-accepted claim row — ~15 MB per 200k rows, written and scanned
under 001's exclusive lock on the re-run — with a snapshot window between the
copy and the block through which a worker's release, committed between, was
evidence bare 021 read and the copy lacked; a temp *view* over the real table
shadows identically, materialises nothing, and the block reads the rows as
they stand. [9]'s role fixture had no guard against a leftover and no
`finally`, so an interrupted run left the cluster's `PUBLIC` without TEMP and
every later run dying on "role already exists"; guarded both ways, the URL
built with `new URL()` and asserted to differ. `LOCK_TIMEOUT_S` was applied
by three mechanisms — a SET/RESET bracket around the checks and a `SET LOCAL`
in each of two `begin`s — while the ledger reads and the TEMP probe ran with
none; one session `SET` after the connection opens, the constant moved to
`config.mjs` so `test-upgrade` derives its three lock regexes from it, and
the three lock messages share one opening. The search-path strip split on
bare commas, mis-rewriting a quoted name holding one; a quote-aware split.
`standing()` hand-spelled the acceptance predicate the same diff had made one
constant; it uses `ACCEPTED_CLAIM_SQL`. A `!/030 decided/` clause guarded
against a printer the fifth pass deleted; the assertion is positive — 030's
line is followed by the summary. The 021 case leaked into the loops through a
tri-state and a `.some()` the load guard had made vacuous; the helper returns
the line to print and the loops print what a file returned. The
duplicate-number rule was spelled twice, in the runner and the checker;
`config.mjs` exports `duplicateMigrationNumber`, and both call it. **Declined:**
an environment override of the lock timeout so the suite's three 10 s waits
run in 3 s — a production knob for the migrator bought with test time, where
the three waits exercise three real lock paths.

**Review, eighth pass (high), at the user's call, triaged.** Main had moved:
SMD-1023 landed migration 031 and changes 57–59, and this ticket's test section
asserted 030 was the last file — merged (this section is 61 after a second
merge, its test section [11]), and the one assertion that assumed 030 was
last now asks that no note follows 030's line. The seventh pass's session-level `SET lock_timeout` does
not follow the migrator's transactions through a transaction-mode pooler,
where the freeze it prevents comes back silently; one `begin` sets it LOCAL
inside every transaction as well, and README §5 says to connect directly.
`duplicateMigrationNumber` judged only `NNN_*.sql` names, so `021-fix.sql`
would have sorted before 021 and run at its number unrefused by runner and
checker alike; `migrationNameProblem` refuses a .sql not so named, and two
sharing a number. `LOCK_TIMEOUT_S` claimed to be the one number when 023's
hashed body sets 10 s for a transaction that under `--reapply` is the whole
run's tail — the comment says so, and why the value is ten and only ten.
`test-support`'s `applyMigrations` applies 021 bare, acceptances in sight,
and said nothing; its docblock names the divergence and where to plant. The
search-path strip had four moving parts, a dead restore on plain runs and no
test: one unconditional `set_config` to the path without `pg_temp`, and [11]'s
both-pending run sets the database's path to list `pg_temp` last. The design
docblock had come unstuck from `applyShadowed` behind two helpers; moved. A
dead `href !== URL_` assertion went. [7], [9] and [11] share one `migrate`,
the fixture gained `accept()` for the five spellings of an acceptance row, and
`build()` uses `resetSchema`. **Weighed and declined:** rewriting 021's
`FROM thought_work_claims c` in the substituted text to a filtered subquery,
which would remove the view, the two probes, the search-path strip and the
TEMP refusal. The template's placeholders are declared in the file; a
run-time rewrite of a hashed statement's text is an invisible edit to a file
the repo says is never edited, and the migrator would then be running a body
no reader of the file can see. The view leaves the text intact and changes
only what a name resolves to, which Postgres supports by design; the catalog
machinery is the price of that honesty.

**Not done here.** 030's header describes the gate it was written beside; the
file is applied and hashed, so the description stands as history, and this
section and README §5 carry the current shape. A plain run applying 021 alone
over a later schema (a ledger hole) still puts 021's `upsert_thought` body over
022's and 025's — preflight's `atomic capture` names that state and
`--reapply`, and [7] now shows the re-run restoring it (SMD-1434 holds the
plain run's judgement of a ledger hole).

**Boyscout.** What the passes cut for space, in the files this change touched,
no behaviour changed: `applyShadowed`'s docblock states the mechanism and
points here for the passes, rather than carrying three of them; the fixture
spells the claim keys with `reembedKey()`, the function that owns the shape;
[7]'s column probe is `column()`, defined once before its first use.

Verified: `test-upgrade` [7] plants the suffixed-key acceptance and the own-key
acceptance over a thought written since its enqueue *before* the re-run, and
asserts the run goes with no refusal, the six labels (`stub-embed`, NULL,
`earlier-model`, NULL, NULL, NULL), every acceptance standing, and the line
beside 021 — two thoughts labelled, the acceptances out of its sight, nothing
beside 030; that an exclusive lock on `ob1_config` fails the checks before the
run within their own timeout; then deletes 021's ledger row with 030 recorded,
plants a fifth acceptance under a suffixed key and a paste's mislabel from
before 021 over an own-key acceptance, and asserts a held lock on `thoughts`
fails the plain run's 021 within the run's 10 s with nothing recorded, that
the plain run then applies 021 — exit 0, 030 skipped as recorded, the line
saying zero labelled since every unlabelled thought's rows are acceptances,
the paste's label standing since 030 did not run, every other label as the
re-run left it, 021 recorded, the trigger enabled — and that a second
`--reapply` labels nothing at 021 while 030 at its own place takes the paste's
label back. [9] builds a brain through 020 with the same fixture and a
suffixed-key acceptance, baselines it, opens a hole at 021 and asserts the
plain run applies 021 with the column absent — two labelled, every
acceptance-only thought unknown — then rebuilds it, adds a fresh own-key
acceptance, opens holes at 021 and 030 both and asserts the ordinary upgrade
applies both with the column truly absent and leaves the rule's labels; and
that a role without TEMP is refused before anything runs, dry run included,
with the GRANT. The hazard refusals went with the gate; the rest of [7] and
all of [8] are unchanged. Not exercised: the loader's two refusals (a set
without 021, two files sharing a number), the checker's duplicate-number rule,
the 40P01 line, the shadow refusal (the view always shadows on the test role's
path), the stale-temp-relation refusal and the quoted comma in a search path.
[11]'s both-pending run lists `pg_temp` last on the database's path, so the
strip is exercised. `test-upgrade` 133/133,
`test-schema` 749/749, `test-preflight` 191/191 (main's 031 and 032 merged
in), `test-live` 419/419, `tsc` clean, fork checker PASS. Upstream status: **not
applicable** — the migrator and `reembed.ts` are the fork's (changes 11 and
29).
