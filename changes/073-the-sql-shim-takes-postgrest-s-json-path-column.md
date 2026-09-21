# 73. The SQL shim takes PostgREST's JSON-path column and hands a timestamp back as a string — `consolidation-bio` runs on the fork, and `test-writes.ts` drives both of its write paths (SMD-1544)

`compat/supabase-sql/index.ts`, `compat/supabase-sql/test-compat.ts`,
`compat/supabase-sql/README.md`; a header on
`integrations/consolidation-workers/bio/index.ts` and its README;
`extensions/test-writes.ts`; comments in `server-portable/store.ts` and
`server-portable/test-store-postgrest.ts` (Linear SMD-1544, filed from change
71's third review pass).

Change 71's running reviewer drove the bio worker for real and found it
could not be driven: `gatherSourceThoughts()` filters on
`.is("metadata->>generated_by", null)` and `findExistingProfile()` on three
`.eq("metadata->>…")` equalities, and the shim's `ident()` — which holds
every column name to `^[A-Za-z_][A-Za-z0-9_]*$` and quotes it — threw on the
path. On the fork, then, the worker answered 500 at its first query and had
never reached `upsertProfile()`: the rewrite through `update_thought` (change
69), the embedded first run through the 3-argument `upsert_thought`, the
sidecar and the actor (change 71) were held by `test-writes.ts`'s text guards
alone. The worker is the only shim-migrated file that filters on a JSON path
(`metadata-norm` does too, and stays on supabase-js for its nested `.or()`).
Driving it found a second gap the ticket had not named: Bun.sql hands a
`timestamptz` back as a `Date`, PostgREST as a JSON string, and the worker's
prompt does `created_at.slice(0, 10)` — a 500 at the prompt, one step past
the first.

**The mechanism.** A filter or ORDER BY column goes through `column()`, which
accepts a plain identifier as before or PostgREST's path
`col(->key)*->>key`, the column quoted as an identifier and every key —
identifier-shaped, held to it — as a string literal:
`"metadata"->>'generated_by'`. The path's result is text, so the bound value
is cast to it (`= $1::text`): PostgREST renders the value as an unknown
literal against a text expression, which is a text comparison, and without
the cast Bun binds a JavaScript number as an integer and Postgres has no
`text >= integer` — the probe that decided it. `.eq/.neq/.gt/.gte/.lt/.lte/
.like/.ilike/.is/.in/.match`, an `.or()` term and `.order()` take the path;
`.contains()` does not (its operator is jsonb's; containment under a key is
`.contains("meta", { key })`), and `ident()` still holds a select list, an
insert or update payload key, a conflict target, a table, a function and its
argument names. Rows from a table verb and from `rpc()` pass through
`jsonShaped()`: a `Date` with a finite time becomes its `toISOString()`
string; everything else — the number ±Infinity Bun gives an infinite
timestamp, a simple query's `Date(NaN)` for a BC date (the parameterised
case is under Decisions), numerics as text — stays as Bun returns it, which
`server-portable/store.ts`'s `isoTimestamp` already knows. The walk costs
about 75 ns a row and doubles a Date-heavy projection's client time (25 ms
against 13 for 20,000 rows of three timestamps — the second pass's runner
measured it); a row without a `Date` is returned as the same object.
`test-compat.ts` pins both: [12] a path in the comparison filters, `is`,
`in`, `match`, `.or()` and `.order()`, a nested `meta->a->>b`, `is(null)`
selecting the rows without the key, a number comparing as text, the
generated SQL's shape, and seven refusals (`.contains()` among them); [13] a
timestamp as a string on a
one-row, a many-row and a set-returning function's result, a NULL staying
null. `test-writes.ts` drives the worker: seven sources planted through the
function with their enhanced columns set beside it; `POST /?name=Test`
gathers exactly the two person notes and the one decision it should — the
restricted note, the minor decision and a note an earlier bio run generated
are kept out, the last by the path filter — dates each in the prompt from a
string, stores the profile through the 3-argument form, judged column by
column with the enhanced columns, the metadata, 008's `capture` row naming
the key and the worker, and a `consolidation_log` row; a second run finds
the profile through three path equalities, keeps the profile row itself out
of its sources, feeds it to the prompt and rewrites it through
`update_thought`, judged against the oracle edit with 022's planted windows
gone and a `model-before` label replaced; another subject gets its own row,
a dry run writes and logs nothing, a first run whose text a row already
holds answers that row as not created and leaves its hand-set columns (the
function's `existed`), a name with no sources is 404. The worker
leaves the read set: its header names SMD-1544, the per-ticket header guard
holds it in the driven set for all three tickets, and the eight text guards
the drive now proves are gone — the Anthropic-only refusal stays read,
because the worker reads its keys at import.

**Decisions.** A path ending in `->` is refused, not rendered: it yields
jsonb, and what a bound value means against it depends on the value's
JavaScript type and Bun's binding — the probe answered `"meta"->'owner' =
$1` one row for `"ann"` and none for `'"ann"'`, which is not PostgREST's
reading (it parses the value as JSON) — so the message names `->>` for the
key's text and `.contains()` for containment; nothing in the tree uses the
form. The string form is `toISOString()`'s (`Z`, milliseconds), not
Postgres's own (`+00:00`, microseconds) that PostgREST would give: both
parse, both slice to the same date, and a consumer comparing the spellings
had a bug on either client; the store's helper normalises both to the
same result, and its tests say which form the fixture now hands it. Only a
finite `Date` is reshaped, so ±Infinity and a simple query's `Date(NaN)` for
a BC date reach the store as before; a parameterised query's BC date is a
finite extended-year Date to Bun and becomes `-000043-03-15T00:00:00.000Z`,
which the helper reads to the same result. The rule is timestamptz-shaped:
a `date` or a zone-less `timestamp` column arrives as a `Z` instant where
PostgREST spells `2026-09-16` or a zone-less datetime — `.slice(0, 10)`
agrees, an equality against the bare date does not, and no shim-migrated
file reads one; said in the shim and its README rather than implied away.
The sources are planted through
`upsert_thought` and a raw update of the enhanced columns, not a raw
`INSERT`: `test-writes.ts` is check 10's counted exception for one line, its
`plant()`, and a second insert of content would fail the count. The bio
worker's log table is created from `schemas/entity-extraction/schema.sql`'s
own `CREATE TABLE` alone rather than by applying that sidecar: its other
tables include a `thought_entities` migration 016 owns, and the suite's
teardown drops every table a sidecar creates. The comments in `store.ts` and
`test-store-postgrest.ts` that described the shim handing back a `Date`
are corrected here rather than left to describe the old behaviour.

**Review pass 1** (a reading reviewer and a running one, the latter in its
own worktree with PostgREST v12.2.3 beside the database; nineteen findings,
one MEDIUM: nine fixed, the rest noted). The first-run `existed` branch —
a concurrent run's row, or a hand-captured one holding the profile's text —
lost its text guard to the drive and gained no drive: the stub's next
profile text is predictable, so the test plants that row typed by hand and
asserts the worker answers it as not created with its columns kept. The
shim's header and README said the path works "in every filter" —
`.contains()` still refuses it, rightly (its operator is jsonb's) — and that
the bio worker was "the first shim-migrated file to run against a real
database" (the REST APIs and the receiver have run under this suite since
change 69); both corrected, a `.contains()` refusal pinned. The `date` and
zone-less-timestamp shapes and the parameterised BC date are said, above.
The two headers that called the string "the one PostgREST would" say "as
PostgREST does". `test-compat.ts` [12] and [13] read a result's error
before its rows and hold a throw as one counted failure — with the cast
removed the suite had died in a `TypeError` before its tally. A CI comment
counted two sidecars. Noted, not fixed: `.is(path, true)` is 42804 on
either client; whitespace around a path is trimmed here where PostgREST
would 400; a bound `null` against a path is `= NULL::text`, no rows, as
PostgREST's `eq.null`; `.in(path, [])` returns `FALSE` before the column is
read, as before. The running reviewer verified against PostgREST itself
what the README claims of it: `meta->>score=gte.20` matches `25` and `"5"`
and not `"100"`; `meta->owner=eq.ann` is 400 `22P02` while `eq."ann"`
matches — the JSON reading that is the reason the shim refuses a `->`
ending; `or` and `order` with a path agree.

**Review pass 2** (the same two reviewers; sixteen findings, none above
LOW in the code, one MEDIUM about the merge). The stop signal: the top findings
were pass 1's own residue — the Mechanism paragraph still said "every
filter" after the header and README had been corrected, its BC-date clause
had not been brought in line with the Decisions sentence pass 1 added, and
the Verified paragraph credited pass 1's runner with a named failure that
only pass 1's error-first read produces; all three corrected above, and
the runner re-ran the mutation (three named failures, a tally). The README's
Safety paragraph, left with one unwrapped line, says now that a number or a
null in an `.in()` list against a path compares as text where a plain text
column refuses the integer (the runner's live probe). The runner also
confirmed each pass-1 fix under mutation — the `existed` drive fails loudly
when the early return is removed, moved after the sidecar, or reported as
created, and when the predicted text is off by one run; `rowsOf` cannot
pass vacuously (no `.length === 0` pin in [12]/[13]) — measured
`jsonShaped()`'s cost (above), and found that the four shim-migrated
extensions parse (`new Date(row.x)`) or pass through the timestamps they
read, none holding a `Date` instance. The MEDIUM is not in this branch:
`origin/main` has taken
FORK change 72 for SMD-1493 while this was in review, so this section is 73
at the merge, renumbered with the pattern change 71 used.

**Review pass 3** (the same two reviewers; eleven findings, all LOW or
INFO, none in the code — the stop signal held). Pass 2's paragraph had
counted one reviewer's findings and said "this pass's error-first read" of
a read that is pass 1's, twice; corrected. The README's Caveats gain the
one behaviour change every migrated file sees — a timestamp is a string —
where a maintainer looks for differences from supabase-js, and the limit
that a key with a non-ASCII letter or a `$` is refused where PostgREST
accepts it; the Not-done-here list names `.contains()` with a path. The
runner rehearsed the merge: `origin/main` conflicts in FORK.md alone (its
ten changed files meet this branch's ten there only), and on the merged
tree — main's FORK, this branch's code, main's `test-support.ts` and
`with-postgres.sh` under every suite — `test-compat` 84, `test-writes`
186, `test-store-postgrest` 86, `test-auth` 643, `db/test-upgrade.ts`
178, `db/test-schema.ts` 869, the checker PASS; it re-measured the two
mutants below (four, five), confirmed a Date-free row is returned as the
same object, that a keyword key (`meta->>select`) renders as a literal and
works, and that `.order()` with `nullsFirst` and `.range()` compose with a
path filter. The renumber the merge owes is counted: this branch's
mentions of the number in eight files, one of them line-wrapped in the
shim's header, and one sentence in this section that must not be touched.

**Boyscout.** The shim's header counted "about twenty methods … ten
filters, and five modifiers" and "three of the 54 files" using resource
embedding; the README tables thirteen filters and seven modifiers, and the
codemod refuses four files for embedding today — the header says so. The
empty `.in()` list's early return says why an unrenderable column is not
refused there (the column is never read). No behaviour changed.

**Verified:** `../../db/with-postgres.sh bun test-compat.ts` 84/84 (61
before; [12] and [13] new); `../db/with-postgres.sh bun test-writes.ts`
186/186 under podman (157 before: eight bio text guards gone, the header
guard's third ticket and the drive added); with `jsonShaped()` removed the
bio block fails four assertions — the first `POST` answers 500 at the
prompt's `.slice` and the run ends there — and with `column()` reduced to
`ident()` the ticket's own 500 returns at the first query (five) — both
re-measured after pass 1, the later assertions skipping inside their
`if`; the two running reviewers' mutations each caught by name: the `::text`
cast (three, the `gte` pins and the SQL's shape — pass 1's runner saw the
`TypeError` pass 1's error-first read replaced, pass 2's the tally),
`column()` reduced to `ident()` in the shim suite (one counted `[12] threw`,
no crash), the `->` refusal (two), `jsonShaped()` off either site ([13]'s
one-row, many-row and rpc pins), the worker's `generated_by` filter (five),
its `subject` equality (three), its actor on either path and its first-run
sidecar (one each); `bun test-store-postgrest.ts` 86/86, the store still
normalising what the fixture hands it; `bun test-auth.ts` 643/643; `bunx tsc --noEmit` in `compat/supabase-sql` clean (PR #61's first CI run caught a helper typed `Promise` where a query builder is `PromiseLike`); `bun
scripts/check-fork-consistency.mjs` PASS; the codemod round-trips (24
reverted, 24 re-applied, the tree clean) and triages as before (the shim's
new column form changes no file's eligibility — the one nested `.or()`
stays a blocker). The ticket's verify — `POST /` to the bio worker under
test-writes' prelude answers 200 with a stored profile; `test-compat.ts`
holds the JSON-path filter; test-writes drives bio on both paths — is the
suite.

**Not done here.** SMD-1480 (deployability: the worker still imports the
Bun-only shim and reads `Deno.env`; it runs under `test-writes.ts`'s stand-in,
not under `supabase functions deploy`) — done in change 74. A path ending in `->`, an array
index, a key with a non-ASCII letter or a `$` (PostgREST takes both), a path
in a select list, and `.contains()` with a path (containment under a key is
`.contains("meta", { key })`) stay refused until a file needs one. The
other shapes a PostgREST consumer might read differently — numerics as text,
`int8` — are left as Bun gives them; nothing driven has needed more.
`metadata-norm`'s `metadata->>confidence` term would parse now, and its
nested `.or()` keeps it off the shim. SMD-1541 (done in change 103) and SMD-1525 as before.

**Upstream status:** not applicable — the shim is this fork's (fix 13); the
worker's `created_at.slice(0, 10)` is correct over PostgREST. **Unfiled.**
