# 119. The SQL-safety guard rail is a check — a `.sql` file never destroys rows a brain already holds, read as statements rather than words by check 21 over every `.sql` git tracks, so 046's refusing trigger passes and a planted `TRUNCATE` fails by file and line (SMD-1936)

**What changed.** `db/config.mjs` gains `DESTRUCTIVE_SQL_RULES` and
`destructiveSqlIn()` beside `SUPABASE_SQL_RULES` and `supabaseIsmsIn()`, the
shape check 12 uses, declared in `config.d.mts`. Four rules over the
comment-stripped text (`stripSqlComments`, literal-aware): `drop-table` for
`DROP TABLE`; `drop-database` for `DROP DATABASE`, `DROP SCHEMA` (`DROP
SCHEMA public CASCADE` is the reset that takes every table with it) and `DROP
OWNED BY` (every table a role owns); `truncate` for a `TRUNCATE` that a table
follows — `TABLE`/`ONLY`, a bare or quoted name, a `format()` placeholder
(`%I`, `%s`, positional `%1$I`), or the closing quote or dollar tag and `||`
of dynamic SQL — and not for one that a reserved word follows (`ON`, `OR`,
`TO`, `FROM`, `AND`, `THEN`, `ELSE`, `END`, `IN`, `IS`, `WHEN`) or a comma,
which is a trigger event (`BEFORE TRUNCATE ON t`), a privilege (`GRANT
TRUNCATE ON`) or a list, nor for the bare value `TG_OP = 'TRUNCATE'`;
`unqualified-delete` for a `DELETE FROM` whose statement carries no `WHERE` of
its own — the statement read to its `;` or to the `)` that closes the CTE or
`format()` call it sits in, and a `WHERE` counted only at the top level, so
one inside a `USING` subquery qualifies nothing. Before the walk the inside of
every string literal is blanked and every quoted identifier marked
(`blankSqlLiterals`, the strip's quote rules, a dollar-quoted body scanned
within its own bounds), so a `(`, `)`, `;` or `WHERE` in a string moves no
boundary and a keyword inside `"…"` is the column name it is. A `DELETE FROM`
inside a string — `'…'`, or a `$tag$` one concatenated onward — is dynamic
SQL and is read raw, its `WHERE` concatenated on or in the same template. String literals are read, as check 12 reads them,
because `EXECUTE 'TRUNCATE ' || quote_ident(t)` runs the truncate — which
makes a statement quoted in prose (`RAISE EXCEPTION 'TRUNCATE refused'`) a
hit as well; every message says the remedy is a `--` comment or a rewording.
Line numbers are the source's, through a plpgsql body.

Check 21 in `scripts/check-fork-consistency.ts` runs twenty-eight probes and
thirty-three non-probes through the rules every run — the tree's own shapes
(046's trigger, `GRANT … TRUNCATE ON`, 034's two-line `DELETE FROM
query_log`, 016's `WHERE true` and `USING` deletes, 034's function comment),
the forms the review found (a literal carrying `)` or `;`, a `WHERE` inside
`USING`, a `RETURNING 'WHERE'`, a `"my TRUNCATE"` column, an apostrophe in a
`$$…$$` value, `has_table_privilege(…, 'TRUNCATE')`), and the neighbours the
rules must not reach (`DROP TRIGGER`, `DROP CONSTRAINT`, `ON DELETE CASCADE`,
a `FOR DELETE` policy, `truncated_at`) — and a line-number probe with a
`TRUNCATE` on line 5 of a function body; then every `.sql` git tracks or
would track (check 15's listing; 85 today; a listing that finds none fails
in words), with counted per-(file, rule) exceptions as check 7 counts them.
The list is empty. `CLAUDE.md`'s rail and `CONTRIBUTING.md`'s checklist item
5 say the rule in one sentence — a SQL file must never destroy existing rows
— name the check, and say the refusing trigger is the rule applied;
`CLAUDE.md`'s references to upstream's gate now name `fork-checks.yml`, and
its Key Files list no longer names a workflow the fork does not have.

**Why.** Both documents said "no `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`,
or unqualified `DELETE FROM` in SQL files" and nothing on this fork checked
it. Upstream's PR gate (`ob1-gate-v2.yml`, rule 5) greps the PR's changed
`.sql` files for the words on any line, comments included, and calls a
`DELETE` unqualified when its own line has no `WHERE`; the fork does not run
that gate (FORK.md's detach note), and the checker's SQL rules — 5 (a
`thoughts` column), 7 (an owned function), 12 (a Supabase-ism) — did not cover
these shapes. Read literally, the sentence fails the one file that applies
it: SMD-1730's review flagged 046's `BEFORE TRUNCATE ON thought_audit`
trigger, which refuses truncation, twice against the words, and the rail's
rewording — a refusing trigger is the rule applied — landed on `main` on
2026-09-22 with that migration. A grep would still flag that file, and 034's
two-line `DELETE`. So the rule is stated as what it means and read as
statements: what a file *runs*, not what it says. The tree today: no `.sql`
drops a table, a schema or a database; the migrations `DROP FUNCTION` (16)
and `DROP TRIGGER` (9), which the rail does not name and which destroy no
row; twenty-nine `DELETE FROM` statements, every one with a `WHERE`; no
`TRUNCATE` statement — the word appears twice in stripped SQL, both in 046,
as the trigger event and the value the trigger compares. The check passes
the tree on its first run.

The ticket asked whether a `DROP TABLE` in a migration is ever legitimate
here: no. A scratch table is 016's `CREATE TEMP TABLE … ON COMMIT DROP`, the
bench corpus and the test tables live in TypeScript, and no migration has
ever dropped a table — the dead `DROP TABLE IF EXISTS` the record of 021's
backfill mentions was `db/migrate.ts`'s. So `db/migrations/` is in scope with
no carve-out, beside the seven category directories, `docs/` and `deploy/`.
Outside the rule by its own words ("in SQL files"): SQL inside `.ts`
(compat's suite drops the tables it makes; test-schema empties the one it
owns) and the heredocs of a recipe's init `.sh`. An ignored file — the
Supabase CLI's `supabase/migrations`, a recipe's `data/` — is not the tree's,
as `.gitignore` promises of the checker. `test-schema` does not repeat the
scan: the migrations are in scope as files, and no substituted value is one
of these statements.

**Held.** Check 21's probes fail by name when a rule loosens; the tree scan
fails by file and line. Planted in a recipe's `.sql`: `TRUNCATE thoughts;`
fails at its line; the same words in a `--` comment pass; a `BEFORE TRUNCATE
ON` trigger passes; `DELETE FROM thoughts;` fails; `DELETE FROM thoughts` with
`WHERE id = $1` on the next line passes; a `DROP TABLE IF EXISTS` planted in
migration 046 fails. Mutants, each reverted: `ON|OR` cut from the `TRUNCATE`
lookahead fails 046:653 by name and three non-probes; the statement no longer
stopping at a closing `)` fails the two-CTE probe (the one-CTE probe stopped
biting once a `WHERE` counted at depth 0 only — a mutant a later fix
neutralises needs a new probe); comments no longer stripped fails five
comment lines of 036 and 046 and three probes; the `WHERE` test dropped fails
twenty-nine statements of the tree; literals blanked before matching fails
the five dynamic-SQL probes; the literal blanking, the depth-0 rule, the
dollar-body bound and the identifier mark each fail their probes when cut;
the listing matching no file fails in words; check 21 not called passes a
planted `TRUNCATE` — the call is the check.

**Review passes.** A cold read with extra shape probes beside an independent
reviewer each pass, who ran the rules against real PostgreSQL forms; the
second pass's top findings were against the first's additions, the loop's
stop signal.

| Pass | Finding | Caught | Fix |
| --- | --- | --- | --- |
| 1 | the statement walker counted a `(`, `)` or `;` inside a string literal: a CTE delete with `'('` in its `RETURNING` passed, a qualified delete with `f(')')` in its `USING` failed | run-it | literals blanked before the walk |
| 1 | a `WHERE` anywhere in the statement qualified it — `DELETE FROM thoughts USING (SELECT … WHERE y) s;` passed | run-it | `WHERE` counted at the top level only |
| 1 | `SELECT "TRUNCATE"` — a column named for the word — was a hit | run-it | a `"` before the keyword excluded it |
| 1 | `format('TRUNCATE %1$I')`, `$q$TRUNCATE $q$ \|\| t` and `DROP OWNED BY` passed | run-it | the target regex and the drop rule |
| 1 | the disk walk read gitignored files, against `.gitignore`'s promise of the checker | walkthrough | check 15's git listing |
| 1 | the closing-`)` mutant went inert once a `WHERE` counted at depth 0 only | mutant | a two-CTE probe |
| 2 | an apostrophe in a `$$…$$` value opened a literal to the end of the file: every later delete was read raw, `DELETE FROM t RETURNING 'WHERE'` passed | run-it | a dollar-quoted body blanked within its own bounds |
| 2 | the `"` exclusion was half a rule: `"my TRUNCATE"` was a hit | run-it | identifiers marked in the blanked copy, a match inside one skipped |
| 2 | a dollar tag with a digit (`$q1$`) missed; a non-probe's `;` sat after its `WHERE` and tested nothing | run-it | the tag grammar; the `;` moved before the `WHERE` |
| 3 | `$q$DELETE FROM $q$ \|\| t \|\| ' WHERE …'` was a hit — the delete was read on the blanked path, its `WHERE` in a piece the blanking hid; the blanker's tag grammar had no probe; `TRUNCATE Übersicht` missed | run-it; mutant | a `$tag$ \|\|` statement read raw; a `$q1$` probe; Unicode name classes |

**Not taken.** Blanking string literals before matching, so prose in a
`COMMENT ON … IS '…'` or a `RAISE` message never trips a rule: an `EXECUTE`
string runs, and check 12 already reads literals for the same reason; the
remedy for prose is the same as 12's, a `--` comment or a rewording (`'never
TRUNCATE this table'` is a hit; `'never truncated'` is not). A template split
across two `format()` calls — `format('DELETE FROM %I', t) || format(' WHERE
…')` — is a hit, by the same reading. `MERGE … WHEN MATCHED THEN DELETE`: the
rail names four shapes, no file here uses `MERGE`, and its delete is
qualified by the join. `DROP MATERIALIZED VIEW` and `DROP FOREIGN TABLE`:
derived or remote rows, not the brain's. A `DELETE FROM … WHERE true` refused
in spirit: 016's is on a TEMP table the function itself made, and "has a
WHERE" is a rule a contributor can read. `ALTER TABLE … DROP COLUMN` on any
table: the rail names four shapes, and check 5 holds the one table whose
columns a contribution must not touch; widening is a decision, not a check.
Applying the rules from inside `test-schema` as [10] does: the migrations are
files in check 21's scope.

**Upstream status:** not sent — upstream keeps its grep in the gate, and the
statement reading exists to pass files upstream's gate has no equivalent of.
