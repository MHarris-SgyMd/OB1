# 93. The community schemas apply on plain Postgres — twelve `schemas/*.sql` stop granting to Supabase's roles and enabling RLS for them, and `migrate.ts --grant` learns their tables, sequences and functions as a `community` group; one rule refuses the constructs' return in `schemas/` and `db/` (SMD-1796)

Seventeen SQL files live under `schemas/`. Applied to a brain built by
`db/migrate.ts` with no Supabase role present — the fork's deploy — **twelve
stopped at their first statement naming one**: `role "service_role" does not
exist`, or `"authenticated"`, or `"anon"` (measured by applying each to a
migrated PGlite brain, which is now test-schema [40]). Two more failed only
because a prerequisite had (readwise-books filters on enhanced-thoughts'
`source_type`; typed-reasoning-edges alters entity-extraction's `edges`), and
wiki-pages for `CREATE EXTENSION pgcrypto`, which PGlite does not ship and
which the file needs only for `gen_random_uuid()`, a core function since
Postgres 13. Where an operator had created the roles to get past the GRANTs,
the files' `ENABLE ROW LEVEL SECURITY` with a policy `FOR service_role` did
the quieter thing: the role they actually connect as is not the table's owner
and has no `BYPASSRLS`, so RLS with no policy for it denied it every row —
`thought_audit` included, and 008's audit trigger with it. Smart-ingest's two
policies on `auth.uid()` and its guarded foreign key into `auth.users` were the
same fact in GoTrue's schema. `db/migrations/` has been clean of all this since
001 (test-schema [10] held it there); the community tree was not.

**The statements are gone from the twelve files**, each left with a note at the
cut saying what stood there, why it fails off Supabase, and where the grant now
lives. What stays is what plain Postgres understands: the `REVOKE … FROM
PUBLIC` on the eight SECURITY DEFINER functions and wiki RPCs (a function so
revoked is callable only by a role granted it — upstream's intent, kept), the
`NOTIFY pgrst` lines (harmless anywhere), and the comments. Functions upstream
granted to `authenticated, service_role` without revoking PUBLIC lose the grant
and nothing else: EXECUTE was PUBLIC's throughout. Wiki-pages loses the
extension line; smart-ingest loses the `auth.users` foreign key (a
single-operator brain has no `auth.users`; `user_id` stays a nullable uuid).

**The grant path is `migrate.ts --grant`, widened.** `db/config.mjs`'s
`ROLE_GRANTS` gains a `community` group — 25 tables, 6 sequences, 8 functions,
each row naming the `schemas/` file — and its rows now come in three kinds:
`table`, `sequence` and `function` (the function with its argument types, as
GRANT and `to_regprocedure` take them). Two facts Supabase's default privileges
had hidden decide which rows exist beyond the tables, both measured in [40]
rather than recalled: an INSERT into a `BIGSERIAL` table is refused on the
sequence (`permission denied for sequence ingestion_jobs_id_seq`) with the
table fully granted, so the six serial sequences are listed by name (upstream's
entity-extraction granted `ALL SEQUENCES IN SCHEMA public`); an INSERT into the
identity-column table (`wiki_section_revisions`) gets past privileges to its
NOT NULL columns with no sequence grant, so the seventh is not. The privileges
are upstream's own for its service role (`GRANT ALL` read as the four DML
verbs; the audit and revision tables keep `SELECT, INSERT`), merged per object
across groups — `thought_audit` is 008's table with `capture`'s INSERT and the
`SELECT` upstream gave beside it; `thought_entities` is 016's, the one name
upstream's entity-extraction shares with the migration, so its row carries
`extraction`'s privileges exactly and reaches no new table. `--grant`
checks presence per kind through one statement both it and the suites run
(`grantPresenceSql`: `to_regclass` for tables and sequences, `to_regprocedure`
for functions), grants what exists, and names the rest as "not yet present,
skipped" — so it runs before a community schema is applied, and again after.
Presence is per object, not per file, so the two rows whose tables a migration
also creates are issued on every migrated brain — `thought_audit` gains the
`SELECT`, `thought_entities` nothing — which is how test-preflight's `--grant`
assertion found the merge: `GRANT SELECT, INSERT ON thought_audit`, not
`GRANT INSERT`. A fourth kind, `view`, carries author-session-id.sql's
`thought_provenance`: GRANT and `to_regclass` take a view as a table, DROP
TABLE does not, and a role's `SELECT` on `thoughts` does not reach a view over
it.
`db/README.md`'s grants table gains the rows, and check-fork-consistency's
grants check now requires every view, sequence and function named there too.

**One rule keeps the constructs out**, in two places from one spelling.
`config.mjs`'s `SUPABASE_SQL_RULES` — `service_role`; `TO`/`FROM` lists ending
in `authenticated` or `anon`; `auth.uid()`, `auth.role()`, `auth.jwt()`,
`auth.users`; a `supabase_` name; `ENABLE ROW LEVEL SECURITY` or `CREATE
POLICY` — matched over the whole of `stripSqlComments`' output, one hit per rule
and line, so a statement broken across lines is a hit. That strip is
literal-aware: `--` and slash-star comments go, string literals and quoted
identifiers stay, and a dollar-quoted body is scanned within with its own
comments stripped, newlines kept so a hit's line number is the file's. String
literals are scanned, not skipped: `EXECUTE 'GRANT … TO service_role'` runs the
grant as surely as the bare statement (recipes/brain-health-monitoring grants
that way). A header quoting a forbidden statement to explain its absence is
therefore not a hit, and a statement is — the property test-schema [10] has
wanted since migration 012's header first tripped its predecessor, now without
the "no migration puts `--` in a literal" assumption: **SMD-1316 is closed by
this.** check-fork-consistency check 12 runs the rules over every `.sql` under
`schemas/` and `db/`, no exceptions; [10] runs them over the migrations from
inside the suite; [40] over `schemas/`, with a probe of the three shapes the
old strip could not tell apart (a literal's `--` followed by a statement, a
body's comment, a body's EXECUTE string).

**Tests.** test-schema [40], on a second PGlite so the files' trigger on
`thoughts` and new columns meet none of the suite's other sections: every file
applies in prerequisite order with no Supabase role; every community object is
present by `--grant`'s probe; every table the files created is in the group
(23 created of 25 listed — the two pre-existing named), every serial sequence
and no identity one, every function `REVOKE`d `FROM PUBLIC` and nothing else;
then a role with nothing, whose `INSERT … DEFAULT VALUES` into every community
table answers 42501 before any grant (the drop-the-mechanism mutant, run
first), is still refused on exactly the six serial tables with the tables
alone granted, and is refused nowhere with the whole group — reads every
table, takes a value from every sequence, may EXECUTE every function, and
cannot UPDATE the revision history. test-live [18], the half PGlite cannot do:
`--grant --dry-run` over TCP names every community object as not yet present
before the files, the seventeen apply over TCP, `--grant` then issues all of it
with nothing skipped, and a LOGIN role connecting as itself inserts, takes
sequence values, executes, calls `wiki_upsert_page` for real and cannot rewrite
revisions. `dropSchema` drops the community tables with the rest so the next
run starts clean. Seventeen README files (the sixteen schemas' and the
template's): the "open the Supabase SQL Editor and paste" step is `psql "$DATABASE_URL" -f schema.sql` then `bun migrate.ts
--grant <role>` (or "nothing to grant" where the file adds only functions or an
index), and every sentence that said `service_role` holds something now says
what the fork does instead.

**Not done here.** Thirteen more SQL files carry the same constructs under
`extensions/` (five) and `recipes/` (eight) — mostly per-user `auth.uid() =
user_id` policies, which are a design question (SMD-1716's operator model
against per-user rows), not a cut; check 12 does not reach those directories,
and their ticket is SMD-1795's next sub-issue. The READMEs' later steps still
say "verify in Database → Functions" and "test from the SQL Editor" — Supabase
dashboard verification, which SMD-1802's docs pass owns. `migrate.ts` does not
apply community schemas; `psql -f` does, and `--grant` follows.

**Review, first pass** (one cold reviewer beside the author's read, over the
commit). Fixed: the community `SELECT` on `thought_audit` was justified by
"the readers author-session-id.sql adds", which read `thoughts`, not the audit
table — the grant stays as upstream's, the reason is corrected in three places
(caught: reading the two files the claim named); that same file's view,
`thought_provenance`, was in no row, so a granted role got `permission denied
for view` — a `view` kind, a row, and [40]/[18] probe it (caught: the reviewer
asking what a role's `SELECT` on `thoughts` does not reach); the
`thought_entities` community row carried `UPDATE`, which — issued on every
migrated brain by name — widened 016's own `extraction` grant on brains that
never applied upstream's file; it is now that row's privileges exactly (caught:
comparing the two rows' verbs); `stripSqlComments` read `E'\''` as two quotes,
flipping literal parity for the rest of a file — 016 already carries an
E-string (caught: an adversarial input the reviewer fed the stripper); the rules
ran per line, so `to\n  authenticated` and `ENABLE ROW LEVEL\n  SECURITY`
passed — they run over the whole stripped text now, quoted API roles included,
and [40]'s probe grew the three shapes (caught: the same probing); the README
said "four" schemas use `BIGSERIAL` where three do; `--grant`'s skipped list
joined function signatures with the `", "` their argument lists contain; a
dangling sentence in thought-audit's note; enhanced-thoughts' header called
the "do NOT grant to `anon`" notes a posture that PUBLIC already includes on
plain Postgres. Declared, not changed: [18]'s restore does not remove the
indexes the files build on migration-owned tables (dropSchema does, next run;
a kept database keeps them — said in the comment); the rules do not name every
Supabase-ism (`net.http_post`, `vault.`, `current_setting('request.jwt…')`),
none of which the tree carries; a `FROM anon` table alias would be a false
positive; `TABLES` in test-support skips its two duplicates now. No finding
became a ticket.

**Review, second pass** (a second cold reviewer, given the first pass's
findings, beside the author's re-read of what that pass added). Its findings
sat in the first pass's additions, which is the stop signal: three sentences
still said the rules ran "per line" after that pass moved them to the whole
text (config's rule doc, the type declaration, this section — caught: reading
the doc against the code); the row type's doc named three kinds where the type
declares four; the live section's comment on the indexes its restore cannot
remove miscounted them twice over — enhanced-thoughts builds five on `thoughts`,
not four, and provenance-chains one nobody had named (caught: grepping every
`CREATE INDEX` in the files against the migrations' own names); the
entity-extraction note said a trigger "fires as the table's owner set it up",
where Postgres checks EXECUTE on a trigger function at CREATE TRIGGER, not when
it fires — right conclusion, wrong mechanism; test-support's drop-list header
says a table with a foreign key must precede `thoughts`, and the community
tables it now appends follow it — harmless, since the CASCADE cuts the
constraints, and the comment says so now. The author's own re-read added the
view to every sentence that listed the kinds, and to the live section's
dry-run assertion. By-catch, pre-existing: thought-audit's file builds
`thought_audit_session_id_idx`, the same column and predicate as 008's
`thought_audit_session_idx` under another name, so on a migrated brain it adds
a redundant index — its README says so now; the file is upstream's. Declared:
a hit that spans lines is reported at the line its statement starts on. No
finding became a ticket.

**Review, third pass** (at the user's call after the stop signal; a third
cold reviewer, given both passes' findings and pointed at what they had not
read — `--grant`'s runtime path, the real files under the stripper, the notes'
counts). One finding of substance, outside every previous addition, so the
second pass's stop call was early: **`--grant` could report "Granted … over N
object(s)" having granted nothing.** Postgres lets a role that holds a
privilege without grant option issue the GRANT; it answers `WARNING: no
privileges were granted` and the statement succeeds as a no-op, a notice the
driver does not surface, and the transaction commits — measured in PGlite, a
role with SELECT alone "grants" INSERT to another and `has_table_privilege`
says false (caught: run-it). Pre-existing since change 62, made likelier by
the community group: the natural sequence is an admin applying `psql -f
schema.sql`, then the server's own role — itself `--grant`ed earlier, so
holding privileges without grant option — granting a worker. `--grant` now
runs `grantVerifySql` after its GRANTs in the same transaction — one row per
privilege, USAGE on the schema included, through `has_table_privilege`,
`has_sequence_privilege`, `has_function_privilege` — and rolls back naming
what the role does not hold and whom to connect as; a grantor's own 42501
gets the same hint; `mergedGrants` is the one list both the statements and
the check are built from; [40] drives the check with the tables alone granted
and reproduces the silent no-op with a weak grantor (held: test-schema [40]).
Also fixed: the thought-audit README's optional third step applied
`author-session-id.sql` after `--grant` and never said to run it again, so
its view was as unreadable as before the first pass's fix — the step now
says so and the file carries a note (caught: walkthrough); the
entity-extraction note still said five tables with four verbs after the
mention row lost `UPDATE`; the grants table's header said "Table (migration)"
over views, sequences, functions and files; thought-work-claims' and
provenance-chains' READMEs kept an "executable by `service_role` only"
outcome; the skipped-list hint did not say that a function existing under
another argument list is skipped the same way (caught: cold-read). And the
two review-pass commits had written their mechanisms mid-bullet, so
`scripts/mechanism-yield.mjs` counted them implicit — their bodies are
reworded to end each bullet in the tag, before the push (caught: run-it;
held: mechanism-yield.mjs). No finding became a ticket.

**Review, fourth pass** (a fourth cold reviewer, aimed at what the third
added). Every finding sat in the third pass's additions — the stop signal,
this time by its own rule. Fixed: the verify's rollback path — the throw
inside Bun's `begin`, the rollback, the thrown message reaching the outer
catch — was reasoned about, not run; test-live [18] now runs `--grant`
connected as its granted LOGIN role (every privilege held, none with grant
option) against a third role and reads exit 1, the "were not granted" line
naming that role, no 42501 hint, and the third role holding nothing (caught:
cold-read; held: test-live [18]); [40]'s weak-grantor cleanup dropped the
grantee role without revoking its privileges first, so had the GRANT ever
taken effect the DROP ROLE would have aborted the suite instead of recording
one failure (caught: run-it); `--dry-run` kept the short skipped hint after
the live path's grew — one string now; `db/README.md` said nothing of the
verify — one sentence; thought-work-claims' README implied an EXECUTE grant
gates 015's RPCs, which revoke nothing from PUBLIC — what a caller needs is
the `worker` group's table privileges; the FORK-paragraph bullets in two pass
commits carried no tag and counted as implicit findings — folded into the
bullets before them. Noted, no change: a fresh role holds USAGE on `public`
through PUBLIC on stock Postgres, so the verify's schema row bites only on a
hardened database; two `run-it` tags on grep-driven index comparisons are
closer to a tooling-assisted cold read.

**Tidied while the files were open.** The listing of the community SQL files
in prerequisite order lived twice, in test-schema [40] and test-live [18];
it is test-support's `communitySchemaFiles()` now, with the order's reasons in
one docblock. The template README's install step had grown into one run-on
sentence; it is the two steps every schema README has. Wiki-pages' three
identical parentheticals after its REVOKEs point at the note above them
instead of repeating it. No behaviour change; the blank-line runs the diff
touches are the files' own.

**Upstream status:** the twelve files now differ from upstream's in their
grant/RLS sections (plus wiki-pages' extension line and smart-ingest's foreign
key), which a rebase will show as conflicts wherever upstream edits those
sections — the cost this fork already carries for the four files change 58 cut.
Upstream's own path needs none of this: on Supabase the roles exist and
`service_role` bypasses RLS. The literal-aware strip and the rule are
portable; the grant group is the fork's.
