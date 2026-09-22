# 98. The cite shape is stated at the table — `query_log.tool`'s two shapes, and the table's cite clause, carry a COMMENT (SMD-1749)

Change 90 gave `query_log.tool` a second shape on an action row. 034 (change 65)
had one: a plain tool name — `fetch`, `update_thought`, `delete_thought` — says
the caller opened or touched the target, click-through relevance. Since change
90, `<writer>/<pointer>` — `capture_thought/derived_from`,
`capture_thought/supersedes`, `update_thought/supersedes` — says the writer
named the target as its source and the database accepted the pointer: a
**cite**, MERIT's memory-utilization signal. `evals/utilization.ts` splits the
two on the first slash — a non-empty name either side is a cite, a slash at
either end is not — so a new writer that cites names itself the same way and is
counted without a code change. Neither this server's tool names nor the MCP
tool-name grammar (`[A-Za-z0-9._-]`, the spec's SHOULD, which the SDK enforces
as a warning) carry a slash, so the two shapes do not collide here — the
server's rule, not a protocol guarantee: a foreign tool logged under a slashed
name would read as a cite, and `utilization.ts` reports a plain name it does not
know as unknown (`OPEN_TOOLS`) rather than folding it in. The contract lived in
`server-portable/index.ts`'s comment beside the writer, `utilization.ts`'s
header, `evals/README.md` and change 90's section. The **schema said nothing**:
034 wrote no `COMMENT ON COLUMN` for `tool` at all — the three names are a SQL
comment in the file, invisible to a reader of the live table — and its `COMMENT
ON TABLE` says "one per follow-up fetch/edit/delete of a returned id". A reader
of the table (`\d+`, a future writer of action rows, an operator auditing what
personal data the table holds) was told three plain names and nothing about the
rows a cite writes. 034 is applied and is not edited after the fact
(`migrate.ts` hashes the file; the ledger would read an edit as drift). The
repo's mechanism for stating a contract on a column is a `COMMENT` in a new
migration, as 028 (change 49) did for `thought_work_claims.last_error`; change
90's third review pass proposed it and declined it there as a second mechanism
in a PR about a log convention.

**Migration 043** is a guard and the two statements, and nothing else. The guard
is 031's shape: on a schema without 034's table both statements would fail bare
(`relation "query_log" does not exist`), and the brain that meets this is one
adopted with `--baseline` whose ledger records 034 but whose schema never had it
— a guide-built brain, or one baselined and never re-applied — where a plain
run, the compose stack's, gates the server and would stop with no remedy named;
the file refuses up front naming 034 and `--reapply`, as 031 does for 015. Then
an idempotent `COMMENT ON COLUMN query_log.tool` carrying the **data contract**:
on a search row, the search tool; on an action row, one of two shapes — a plain
name is an open, `<writer>/<pointer>` is a cite — with what each means, the
three cite values written today, the rule as the column's (a non-empty name
either side of the first slash is a cite, whatever the writer; a slash at either
end is not — `citePointerOf`'s rule, as [39] holds it) and why the shapes cannot
collide. *When* a cite is logged (a pointer the database accepted, so never a
re-capture — 035 writes no pointer), *which* writers cite, and *how* an action
is attributed to a search are the server's and the readers' contract and change
with them, so the comment points at `index.ts` and `utilization.ts`'s header for
them rather than restating them — 028's shape, and the lesson its four passes
paid for. And `COMMENT ON TABLE query_log` re-issued with 034's text kept whole
and one clause added beside fetch/edit/delete: or a write that cited a returned
id as its source, naming the shape and the ticket. No DDL on data, no function
change, no ACL change, no placeholder, no `CHECK` change: 034's `tool <> ''` is
the only constraint on the column and a slashed name satisfies it. The export
join, the utilization report and the server are unaffected; `test-upgrade`'s
shape comparison (columns and function signatures) does not see a comment.
Neither `COMMENT` literal carries `--` — 028's convention, from when
`test-schema` [10] stripped that sequence to end of line; the scan is
literal-aware since change 93 (SMD-1796), so the guard's HINT naming two flags,
as 030's and 031's do, is no longer even a consideration, and [42] keeps the
convention as an assertion of the live text.

The trap a successor must not fall into is 028's: a re-issued `COMMENT` replaces
the description, so any migration that re-comments `query_log` or
`query_log.tool` and re-issues 034's text would silently drop the cite clause.
`test-schema` **[42]** asserts the **live** text of both comments
(`col_description`, `obj_description`) after every file has applied — both name
`<writer>/<pointer>`; the column's gives both shapes, what a cite is, the rule
as the column's and where the readers are; the three cite values and three plain
names it gives are the ones `index.ts` writes today, hard-coded as [39]
hard-codes them (so a renamed writer that stranded the applied text fails here,
and the fix is a migration, not an edit); the table's keeps 034's six sentences
whole and adds the clause; neither carries `--` — and exercises the shape once:
a cite row inserted under the documented `tool` lands (034's only constraint on
the column) and reads back as a cite. Anchored on the rule's words, no migration
number pinned, so a compliant successor passes and a lossy one fails whichever
file it is.

Two mutants bite: 034's table text re-issued verbatim fails the clause
assertion; the column statement dropped fails the first assertion of the section
(a first cut of that mutant removed the header's *mention* of the statement
instead of the statement and passed 992/992 — the cut was wrong, not the test).
`test-upgrade` **[20]** drives the guard against real Postgres: a schema through
033 baselined at a ledger through 043, 043's row deleted, and a plain run fails
at 043 naming 034 and `--reapply` and records nothing; then 034's table applied
and the same pending file lands, both live comments naming the shape. The first
run of that suite tripped its own window guard — [7] holds that 030 is among the
last N migrations "to force this note to be re-read" whenever a migration lands
past it — so the note was re-read (043 needs only 034 and is recorded by the
baseline with it, so it never becomes [7]'s plain-run failure point), 043 added
to it and the window widened by one, as the guard asks. The same first run also
refused `--reapply` because 043's hash had changed under it: the mutant script
was rewriting the file while the suite hashed it — a race between two of this
section's own checks, not a defect; the suite was re-run alone.

The re-run found a real one: [20] passed its `--baseline` and then watched the
plain run *apply* 043 — exit 0, one applied, thirty-nine skipped — on a schema
built "without 034". It was not without it. `test-support`'s schema reset drops
a fixed list of tables and functions, and 034's `query_log` and
`prune_query_log` were never added to it, so every reset since change 65 had
carried the previous section's log table across the boundary; nothing before
this section asked for a brain that lacked it, and the by-hand reproduction in a
fresh container fired the guard exactly as written. The two names are in the
lists now, with the reason at the entry — and a second pass, listing what
survives a reset on a fully applied brain, found three more:
`thought_stats_summary()` (024), `find_derivatives` (025) and `trace_provenance`
(025/026), never dropped either. Those are listed too, and `test-upgrade`
**[21]** now asks the catalog the same question after every run — a reset of a
full brain leaves no non-extension relation, function or type in `public` — so
the next name a migration adds without a line in the list fails there rather
than in whichever section happens to need the object gone. Deriving the lists
from the migrations instead (`config.mjs` already reads the owned function set
from them for the vendored-SQL check) is **SMD-1819**; the tooth makes the
hand-kept list safe until then.

With the reset fixed, the guard's own mutant bites: the `DO` block removed,
[20]'s plain run fails with the bare `relation "query_log" does not exist` and
the assertion that wants the named message and the remedy fails on it.

The typed record of what a write cited is SMD-1730's event shape (Phase 1a of
SMD-1729); when it lands, the migration that carries it should re-issue this
column's comment to point at it — the ticket's note, carried in 043's header.

**Not done here.** A shared helper for the catalog reads that [42] and
`test-upgrade` [20] each spelled (a first review pass counted six copies of the
`col_description` join across the two suites) was declined in that pass because
the two suites read through two clients — PGlite's `db.query` and Bun's `sql` —
and a helper would take a query callback to save two lines. A third pass pointed
out that a SQL *string* needs no callback: both clients take text with
positional parameters. So `test-support` now exports `COLUMN_COMMENT_SQL` and
`TABLE_COMMENT_SQL` and both sections read through them — and so do [27] and
[31], the two earlier pure reads (a fourth pass: "the diff is the moment the
copies are all in view"); [26]'s read joins `information_schema` for the
column's type and stays its own. Still not done: `test-upgrade`'s `shape()`
decides "is this ours?" by a hand list of eighteen pgvector name prefixes where
[21] asks `pg_depend`; changing the predicate every upgrade section compares on
is not this ticket's, and is noted on SMD-1819. A generic mapping in
`migrate.ts` — a pending file failing with `42P01`/`42883` on a ledger that
records earlier files gets the baseline hint once, retiring the block 030, 031
and 043 each paste — is **SMD-1811** (the same pass's altitude finding); 043
keeps its guard.

**One review pass** so far (a cold reader over the diff and the operator's path
walked: a fresh brain migrated by the runner, a second plain run, a `--reapply`,
both live texts read back through psql with no quoting artifact and by a role
holding only SELECT on the table). The cold reader found the number taken: while
this branch was in review, main merged SMD-1624 (PR #82, migration 040, change
91) and SMD-1328 (PR #83, also claiming change 91), so this migration moved to
041, `test-upgrade`'s section to [19], [7]'s window to twelve and this section
to 93 (a second merge moved each once more — the fifth pass, below) — and main's
own duplicate is repaired in the merge: SMD-1624 merged first and carries three
code pointers to 91, so it keeps 91; SMD-1328's section is renumbered **92** and
moved after it (its heading was its only reference). The same pass caught the
column comment stating the rule as "any value containing a slash is a cite"
where `citePointerOf` — the reader the comment points at — treats a slash at
either end as an open and [39] asserts exactly that; the applied text now states
the reader's rule (a non-empty name either side of the first slash), and [42]
anchors on it. And it trimmed [42]: the loops over the six tool names had
re-asserted `citePointerOf`'s results — a second copy of [39]'s tooth under a
label that blamed the migration text — and now ask only that the applied text
names them.

**Second pass** (a cold reader over the merged branch; the run-it arm walked an
upgrade — a brain built by main's own runner and files, then this branch's
runner over it: the file applied, forty skipped, no hash refusal, `--dry-run`
quiet, preflight's query-log line reading the shape — and the three
server-portable suites that share the reset on the merged tree). Its findings,
all taken: the reset list's three other omissions and [21], above; the
`test-support` entry's pointer to "[18]", which the merge had renumbered
everywhere else; the column comment's "an MCP tool name cannot contain a slash",
a protocol impossibility the spec does not promise (a SHOULD, a warning in the
SDK) — stated now as the server's rule with what a foreign slashed name would
read as and where an unknown plain name is reported; [42]'s two shape assertions
had anchored on dot-all spans that could reach the other sentence, so a re-issue
that *inverted* the meanings would have passed — each shape is anchored inside
its own sentence now; and its plain-name loop had matched the word anywhere in
the prose ("follow-up fetch" would do), so the two enumerated lists are asserted
as strings beside their shapes instead. [20] left a ledger ahead of its schema,
so [21] began from a full brain of its own (the fourth pass has [20] complete
its own instead). The guard paste was surfaced again and stays SMD-1811's.

**Third pass** (a cold reader; the run-it arm ran the two mutants the second
pass's anchors claim to catch — the two meanings inverted in a re-issue fails
three of [42]'s assertions, the plain-name list dropped with the words kept in
prose fails one — and the two remaining suites that reset through
`test-support`, `test-search-path` and `test-bench-reuse`, on the grown lists).
The reader found [21]'s sweep blind to the object kinds a future migration is
most likely to add: its relation query stopped at `r`, `v`, `m` and `S`, so a
partitioned or foreign table and the relation behind a standalone composite
type were invisible, and its type query excluded every composite — a table's
row type and a `CREATE TYPE … AS` alike. The sweep now reads every relation
kind and the four type kinds no relation backs, excepts an extension's
members by `pg_depend`'s (classid, objid) pair rather than `objid` alone, and
proves itself first: five probes of the uncovered kinds are planted beside the
fork's objects, each must be seen after the reset, then dropped by hand, and
the sweep must come back empty. Two inventories had not followed: the
README's second count line still said 973, and this file's list of new files
stopped at 040. And the helper decline was reversed, above.

**Fourth pass** (a cold reader who ran both suites; the run-it arm regressed
[21]'s sweep to the second pass's kinds and watched the planted-probe assertion
fail on exactly the composite type and the partitioned table, so the self-check
has teeth). Nothing touched the migration or its contract. The sweep's exception
for an extension's members was too narrow in the other direction: an extension's
composite type records its membership on the type, not on the relation behind
it, and a sequence behind an extension table's serial column records only its
ownership of the column, so an image that gained such an extension would have
failed [21] on a reset that dropped everything of the fork's — a relation is
excepted now when it, its row type or its owning table is an extension's. [21]
had also built the full brain it then dropped, twice over; [20] completes its
own brain now (035 onward are on the ledger already) and [21] starts from it.
`test-schema` [10]'s header still denied that any migration puts `--` inside a
string literal, three RAISE HINTs after that stopped being true; the pass
corrected it — and main's change 93 then made the strip literal-aware and
rewrote that header, so the correction was overtaken in the next merge and
main's text stands. Two `String(…)` wrappers over values already typed as
strings are gone. A claim that CI runs neither `test-upgrade` nor its container
was checked and does not hold: the "Schema against real Postgres" job runs it.

**Fifth pass** (a cold reader; the run-it arm planted a serial table, its
sequence, a loose sequence and a view beside the fork's objects and ran [21]'s
relation sweep over the reset: all four seen, nothing excepted — the
ownership path the fourth pass added excepts only what an *extension's* table
owns, and on this image the exception hides nothing). Main had moved again:
SMD-1796 (PR #84) took change 93 and `test-schema` [40], SMD-1677 (PR #86)
took migration 041, change 94 and `test-upgrade` [19] — and repaired the
duplicate 91 the same way this branch had. So, a second time: this migration
is **043**, this section **98**, its `test-schema` section **[42]**, its
`test-upgrade` sections **[20]** and **[21]**, [7]'s window thirteen; the
guard's message, both suites' regexes, the reset list's two pointers, the
README's ledger and the inventory line follow. Two tickets took the next
number in one afternoon, then two more overnight: the renumber trap SMD-1804
means to retire. The same pass's cold read, over the mid-merge tree, found
the collision first and four things besides, all taken: [20]'s
brain-completing apply was open-ended (`>= "035"`), so it re-applied the file
under test bare a second time and, on the merged tree, main's 041 too — bounded
at the file under test now; [21]'s ownership exception followed only a serial
column's `'a'` dependency, so a sequence behind an extension table's
*identity* column would have read as a survivor — `'i'` too; this file's and
the migration header's "splits the two on the slash alone" contradicted the
literal they introduce, and say the literal's rule now; and the three
function-comment reads in `test-schema` ([27], [31], [36]) go through a
sibling `FUNCTION_COMMENT_SQL`, one of them losing a bare `.rows[0].d` that
threw where the others fail softly. One finding changed [21]'s shape: it
swept the whole of `public`, and CI's data-layer job runs five
server-portable suites before `test-upgrade` on one database, so a stray
object another suite left would have failed it blaming the drop lists. A
survivor is the fork's when some migration names it — that fails the
section; one no migration names is reported in the label as another suite's
and does not.

**Before the push**, a third time. Main had taken SMD-1712 (PR #85: migration
042, change 95, `test-schema` [41]), SMD-1803 (PR #87, change 96) and SMD-1797
(PR #88, change 97) since the second merge, so this migration is **043**, this
section **98**, its `test-schema` section **[42]**, and [7]'s window fourteen;
the `test-upgrade` sections stay [20] and [21], since none of the three added
one. The fifth pass's paragraph above says the numbers as they stood after the
second merge; every pointer in the files says these. Three renumbers in one
review is the case for SMD-1804.

**Upstream status:** not sent — the query log is this fork's (change 65).
