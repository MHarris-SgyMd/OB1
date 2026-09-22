# 77. The SQL shim reads the catalog — arrays bound by their column's type, `.not()`, one hop of resource embedding, an `Error` for an error, one pool per URL — and `test-tools.ts` drives all twenty-nine extension tools against Postgres (SMD-1588)

`compat/supabase-sql/index.ts`, `compat/supabase-sql/test-compat.ts`,
`compat/supabase-sql/README.md`; `scripts/migrate-to-sql-shim.mjs`;
`extensions/test-tools.ts` (new), `extensions/package.json`,
`extensions/test-writes.ts` (its header); the four extension READMEs and the
deploy primitive; `.github/workflows/fork-checks.yml` (one step) (Linear
SMD-1588, filed from change 74's second review pass).

Fix 13 moved the five extension servers onto the shim by changing one import
line each and never drove a tool. Change 74's running reviewer did — five
schemas applied, every tool called through `tools/call` — and seven failed
on the shim itself: the shim had no `.not()` (two tools), four tools selected
a PostgREST embed the codemod's blocker regex had let through because it
wanted the relation flush against its parenthesis (`maintenance_tasks (` and
`recipes:recipe_id (` are not), and `crm_add_contact` with `tags: []` was
`22P02 malformed array literal: ""` because Bun serialises a JavaScript array
as its `String()`. Two more tools rendered every error as `[object Object]`,
the shim's error being a plain object where supabase-js's extends `Error`.
Driving every argument branch here found two more paths nobody had reached:
a tag filter through `.contains()` on a `text[]` column (`text[] @> jsonb` has
no operator — three tools), and an ingredient filter through `.or()`'s `cs`,
an operator the shim's `.or()` did not know. And the drive itself surfaced a
defect outside the ticket's list that would have stopped every one of these
servers after about ninety-five calls: each request handler calls
`createClient` and closes nothing — a Supabase Edge Function's shape, where an
invocation dies with its client — and under Bun (change 74) each client's
pool held its connection for the life of the process. The suite's eighty-odd
calls left 84 connections open against Postgres's default limit of 100.

**The mechanism.** PostgREST knows the schema; a supabase-js caller leans on
that without knowing it, and value shape cannot stand in — meal-planning's
`add_recipe` inserts `tags: string[]` into `TEXT[]` beside `instructions:
string[]` into `JSONB` in one statement. Probed on Bun 1.4.0 against a real
Postgres: the driver serialises a parameter by the type the server describes
for it and has no array-literal form, so a JS array reaches `text[]` as `a,b`
(`""` for `[]`), reaches `jsonb` as JSON, and an `int[]` fails inside the wire
protocol (`08P01`). So the shim reads what PostgREST reads, once per name per
process, cached by connection URL (the servers make a client per request): a
table's column types with their category (`pg_attribute` joined to `pg_type`),
its foreign keys in both directions with their column lists (`pg_constraint`
with `conkey`/`confkey` unnested in order), and each overload of a function's
IN-argument names, types and type categories (`pg_proc`; `proargmodes` keeps
a `RETURNS TABLE` function's OUT columns out of the name list — they follow
the IN arguments in `proargnames`, so the filter matters only to a caller
naming one). From that: a JS array in a
payload becomes a Postgres array literal — elements double-quoted, `\` and `"`
escaped, `NULL` for null, nested arrays recursively, an object its JSON — bound
with a cast to the declared type (`$2::text[]`); a `vector` column or argument
takes JSON text, the form `.rpc()` always sent an embedding in (the numeric-
array heuristic stays as the fallback where overloads disagree or the function
is unknown); `.contains()` is `@>` with the column's own operator, an array
literal against an array column and the bound object against jsonb;
`.or()` takes `cs`, the value parsed to JSON for a jsonb column (a string
would bind as a JSON scalar — the 005 trap) and passed as PostgREST's `{a,b}`
text for an array column; `.not(col, op, v)` is `IS NOT` for `is` and
`NOT (…)` around everything else, which is PostgREST's rendering too (`not.eq.1`
is `NOT (x = 1)`, not `x <> 1` — they differ on NULL). Every filter is now a
closure rendered at compile time with the column map in hand, `build()` is
async `compile()`, `toSQL()` is a promise, and a catalog read that fails (the
database unreachable) resolves as `{ error }` like any other runtime failure
while the shim's own refusals still throw — except inside `.or()`, where a
term the shim cannot serve is PostgREST's 400 (pass 3), because four tools
build that expression from a user's text.

One hop of embedding, from the select list parsed at the call — top-level
commas, `*`, columns, `[alias:]relation (cols|*)`, whitespace anywhere. The
relation is a foreign-key column of the table (`recipes:recipe_id (…)`:
many-to-one through that key, keyed by the alias or the column) or a table
with exactly one foreign key between the two, in either direction (this
table's key to it: many-to-one; its key to this table: one-to-many).
Many-to-one is a correlated `row_to_json` subquery — an object, `NULL` when
the key is; one-to-many a `json_agg` under `COALESCE(…, '[]')` — an array,
`[]` when empty: PostgREST's shapes and keys. The embedded table is aliased
`__e` so a self-reference still names the outer row by the table's name, and
multi-column keys join pairwise. Refused, each naming why: a nested embed, an
embedding hint (`!inner`, `!fk_name`), a relation with no key to the table or
with two (name the column), an embed in a `RETURNING` list, a JSON path or an
aggregate inside one. An embedded row arrives with Postgres's own spellings
(`2026-09-20` for a date, `+00:00` for a timestamp), as PostgREST's does.

The error is `PostgrestError extends Error` with `code`, `details` and `hint`,
so meal-planning's `if (error) throw error` hands the MCP SDK an `Error` whose
message is the database's (`error instanceof Error ? error.message :
String(error)` in the SDK is where `[object Object]` came from). Clients on
one connection URL share one pool, counted, the first client's `max` sizing
it; `close()` releases a hold and the pool closes with the last. The codemod's
embed blocker is now the shim's refusals spelled as regexes — a nested embed
(a parenthesis inside the embed), a hint (`!` after a relation) — so a one-hop
embed no longer blocks, the three servers migrated with one are re-applied by
the round trip, and `job-hunt`, `enhanced-mcp` and `ob-graph` stay blocked
for what they actually use. `agent-memory-api`, blocked until now by two
one-to-many `child(*)` embeds the shim serves, would have become eligible and
been migrated by the next `--apply --all`; it is in `KEEP` with the reason —
deployed as the Edge Function its README describes, typechecked as one by the
deno job, started as one by `test-auth.ts` — and moving it is its own change.

`extensions/test-tools.ts` is the drive the ticket asked for and change 74's
lesson (a "runs under Bun" claim needs the tools driven, not the process
started). Each of the five servers is imported under the stand-in for Deno's
two globals that `test-auth.ts` and `test-writes.ts` use, against the fork's
migrations (`crm_link_thought` reads `thoughts`, so a thought is planted
through `upsert_thought`) plus the four `schema.sql` files applied as their
READMEs' Step 1 says, after the two `auth.*` stubs, dropped again at the end
because CI shares one Postgres across the job. Every tool is called with the
arguments its schema describes — each optional filter on its own, each error
path the tool documents — and the reply is read: the row a write stored
(`tags` as an array, `details` as an object), the rows a read chose, the
embedded relation as an object or `null`, the trigger's effect (`next_due`
ninety days on from the log's time, `last_contacted` from the interaction),
the shopping list aggregated from two recipes' embedded ingredients, the
message a failure carries (`invalid input syntax for type uuid`, a CHECK
constraint's name, `.single()`'s PGRST116 text). The drift guard: each
server's `tools/list` under a write key is exactly the set driven, and every
extension file that imports the shim is among the five. The count is
twenty-nine, not the twenty-five the ticket, change 74 and the READMEs said:
the four `index.ts` files carry twenty-five and the shared meal-planning
server four more, one of which (`view_meal_plan`) was already among the seven
failing. The section before the drift guard reads `pg_stat_activity` and
holds the connection count at twenty or fewer — a handful against 84 — after
eighty-odd requests that each built a client. The suite runs last in the
data-layer job, after `test-writes.ts`.

**Decisions.** *Introspection, not shape:* the ticket's sketch said "decide by
the value shape as PostgREST does"; PostgREST decides by the column's type,
and shape cannot separate `tags` from `instructions` in the same insert. The
cost is one catalog query per table, function or foreign-key set per process,
and `toSQL()` becoming a promise (two call sites, both in `test-compat.ts`).
*Serve one hop, not refuse:* the ticket offered either; refusing would have
left four tools broken or forked three vendored files away from upstream to
rewrite their selects, which is the outcome fix 13 exists to avoid. What is
not one hop is refused at the call with the hint form named, and the codemod
refuses the two refusals a regex can see (a nested embed, a hint); whether a
relation has one foreign key or two is the catalog's to say, at the first call. *The pool is in scope:* it is a shim change, it was found
by the ticket's own drive, and a server that dies after ninety-five calls does
not serve its tools; the fix is a map and a counter. *`vector(N)` columns
too:* the vector rule matches `format_type`'s typmod form, so a number array
into a `vector` column now binds as JSON text through a table verb as well —
`test-writes.ts`'s header had named the old failure ("invalid input syntax for
type vector" at the shim, before its column assertions) as a limit of its
fixture; the fixture now matches PostgREST, and the assertions name the stale
columns as the labels say. *Twenty-nine:* recorded, not corrected backwards —
change 74's prose keeps its count with a note.

**Verified:** `../../db/with-postgres.sh bun test-compat.ts` 131/131 (84
before; 144 after pass 1, 152 after pass 2, 165 after pass 3, 177 after pass
4 — the passes' pins are listed in their paragraphs): [14] `.not()` on `is`, `eq`, `in`, `in []`, `ilike`, `cs`, the two
renderings in `toSQL()`, an unknown operator refused; [15] `[]` and
`["ai", "with, comma", "quo\"te"]` into `text[]` beside an array into `jsonb`
in one insert, an update, `.contains()` on both column kinds and with
PostgREST's literal, `.or()`'s `cs` on both, a `text[]` rpc argument with
`["ai"]` and with `[]`, the cast in the generated SQL; [16] `error instanceof
Error`, `instanceof PostgrestError`, the SQLSTATE, `String(error)`, the shim's
own PGRST116 and an rpc's 42883; [17] many-to-one by table with a column list
across lines, by key column with and without an alias, one-to-many with `(*)`,
`null` and `[]`, an embed under `.single()`, the correlated subquery in
`toSQL()`, and eight refusals; [1] two clients share a pool and closing one
twice leaves the other's open. `../db/with-postgres.sh bun test-tools.ts`
114/114 (117 after pass 1, 121 after pass 2, 122 after passes 3 and 4) — 29
tools, every argument branch, the drift guard, the connection count. Six mutations of the shim, each restored from saved text: `.not()`
removed → 5 named failures in the tool suite (the two tools' `.not is not a
function`), 1 in compat; the array literal removed → 50 and 17 (`malformed
array literal: "quick,vegetarian"`, `""`; the first run read 25 because a
null body threw past the tally — every `.body` read is optional now);
embedding refused → 20 and 2; the
error a plain object → 2 and 4 (`[object Object]` in both tools' text); `cs`
removed → 6 (compat aborted at `[4]`'s `.contains()`, which throws outside a
try — the tool suite carried the tally); `cs` always jsonb → 4 and 4
(`operator does not exist: text[] @> jsonb`). The connection probe: 84 held
before the shared pool, the assertion at ≤ 20 after (pass 1; 12 before it). `bun
scripts/migrate-to-sql-shim.mjs` triage: the three embed files no longer
blocked, `job-hunt` on nesting and a hint, `enhanced-mcp` and `ob-graph` on a
hint, `agent-memory-api` under `KEEP` with its reason; `--revert` then
`--apply --all` 23/23, the tree byte-identical. `bun test-auth.ts` 709/709
(every server still starts under `bun` and answers); `../db/with-postgres.sh
bun test-writes.ts` 186/186; `../db/with-postgres.sh bun
test-store-postgrest.ts` green in `server-portable` (the shim is its
fixture); `bunx tsc --noEmit` in `compat/supabase-sql` clean; `bun
scripts/check-fork-consistency.mjs` PASS. The ticket's verify — every extension
tool answers against a Postgres carrying the five schemas, `crm_add_contact`
with `tags: []` and `["a"]` stores an array, `search_maintenance_history`
returns the task nested as PostgREST would, the codemod refuses or the shim
serves every embed whatever the spacing or alias, `test-compat.ts` pins
`.not()`, array binding and `error instanceof Error` — is the two suites.

**Not done here.** `agent-memory-api` onto the shim (servable now; `KEEP` says
why not here). A second hop of embedding, `!inner`, a named foreign key, an
embed in a `RETURNING` list, a filter on an embedded column
(`.neq("thoughts.sensitivity_tier", …)`, `enhanced-mcp`) — refused, with the
files that use them still blocked by the codemod. A column DROPPED under a running server, or one
whose type changes, is not seen until the process restarts (a column added is
— pass 1); PostgREST's cache has none but a reload either. A `timestamp
without time zone` column still arrives as a `Z` instant (change 73's rule;
the `date` case is closed for a table's rows, a function's and an array's —
passes 1 and 2). `uuid[]` columns arrive as Postgres's literal text (`{…}`),
`int[]` as a list (pass 1), a `bytea` as Bun's `Buffer` — no migrated file
reads any of them. VARIADIC arguments cannot be called by name in Postgres, so
`.rpc()` cannot reach one; nothing in the tree is variadic. `test-compat.ts`'s
`[4]` block has no try, so a refusal thrown inside it ends the run without a
tally (seen under the `cs` mutant); the tool suite's blocks and `[12]`–`[18]`
do. Pre-existing divergences the review found and this change leaves, filed
as one ticket: `count: "exact"` without `head` answers the page size;
`.single()` with several rows returns the first; `head: true` without a count
streams every row; upsert's default conflict target is the payload's first
key and its EXCLUDED filter reads the target unsplit; `.rpc()` collapses any
one-row, one-column result to a scalar (SMD-1602). The two
extensions still on supabase-js (`family-calendar`, `job-hunt`) are not driven
— they do not run on the fork's shim, and their PostgREST is Supabase's.

**Review pass 1** (a reading reviewer and a running one, the latter in its
own worktree; twenty-five items between them, sixteen taken, seven filed,
two declined). The running reviewer reproduced every tally, drove
`home-maintenance` for real over HTTP (the embed an object on the wire), ran
nine more mutations — four survived: the memo (performance only, +25% on the
tool suite without it), the `::type` cast (pinned by its spelling in `[15]`,
redundant to Postgres in the driven paths), the `proargmodes` filter (matters
only to a caller naming an OUT column), the literal's quote escaping in the
tool suite alone (compat's `[15]` catches it) — and probed twenty edge shapes.
Taken: a `date` column arrived as a `Z` instant from the base row while the
same column inside an embed arrived as `2026-09-20`, and five tools read one
(`week_start`, `follow_up_date` …) — `jsonShaped` has the column map now and
gives the bare date; the comparison filters and `.in()` bypassed `bound()`, so
`.eq("tags", ["ai"])` still hit the `String()` bug — routed through it; an
EMPTY catalog answer was memoised for the process's life (a server that took
one request before its `schema.sql` was applied bound every array raw until
restarted) — an empty map is not kept, a named column the map lacks re-reads
the table (`ALTER TABLE … ADD COLUMN` under a running server), and `close()`
drops the URL's store with its pool; foreign keys were matched by bare
`relname`, so a same-named table behind the visible one on the search path
could be counted and then joined as the visible one — the read is restricted
to `pg_table_is_visible`; `.or()` split on every comma, and four tools
interpolate user text into their expression (`search_recipes` an ingredient
into a `cs` value, `search_household_items` a query into four ILIKE terms) —
a comma inside brackets, braces or quotes now stays with its value, and a
term the split still breaks resolves as `{ error }` with PostgREST's
`PGRST100`, reaching the tool's own error handling instead of throwing past
it; `not in []` rendered `TRUE`, which kept NULL rows PostgREST's
`NOT (x = ANY('{}'))` drops — `IS NOT NULL`; `bound()` tested `endsWith("[]")`
where `cs` tested the type category — a domain over `text[]` took different
branches — both read the category, the rpc read carries categories too; a
one-to-one (unique referencing column) rendered as a list where PostgREST
gives the row or null — `pg_index` decides; a self-referencing table by name
was refused as "more than one foreign key" (one constraint counted from both
sides) — refused as itself, naming the column form; an embed on a missing
table threw about foreign keys where the same select without it resolved
`42P01` — the embed is left out so the database reports the table; an `int[]`
column came back as Bun's `Int32Array` (`{"0":1}` in JSON) — a list; the
tool suite's "90 days on" expectation was the client's millisecond sum where
the trigger's interval is calendar arithmetic in the database's zone (an hour
off across a DST edge under `America/Los_Angeles`) — the database's own sum;
the connection bound had no headroom (Bun opens the pool eagerly to `max`, so
12 was the arithmetic) — twenty, the teeth being 84; the READMEs name
`OB1_PG_POOL` and what ten per server costs; and the doc claims corrected
above (the codemod's "same set", the `date` sentence, twenty-five, "last
section"). Filed: the pre-existing divergences listed under Not done here.
Declined: widening `Result.error` to `PostgrestError | null` (a typing change
for consumers, boyscout territory); a `uuid[]` literal parser (nothing reads
one). Pins: `[4]` the broken term as `{ error }`; `[13]` the bare date;
`[14]` `not in []` against a NULL kind; `[15]` `.eq()` and `.in()` with arrays,
commas inside `cs` values, `int[]`; `[17]` one-to-one, self-reference by name
and by column, the missing table; `[18]` a late table and a late column; the
tool suite: `week_start` bare, a comma in an ingredient and in a household
query, `follow_up_date` equal to the bare date. `test-compat.ts` 144/144 (131
after the change, 84 before); `test-tools.ts` 117/117.

**Review pass 2** (the same two shapes; eighteen items, thirteen taken, the
rest noted). The stop signal fired on its face — eight of the reader's ten
and every one of the runner's findings sat in pass 1's additions — and the
top two were consecutive seams in one of them, so the mechanism was the
finding: pass 1's comma split for `.or()` counted brackets and quotes found
INSIDE a plain value, so an unbalanced `(`, `]` or `"` in user text (`Kitchen
(main`, `12" pipe`) swallowed the remaining terms into the first value's
literal and `search_household_items` answered no rows with no error where
the change's first commit had answered the row — a regression, measured
against df86661 — while `and (` anywhere in user text still threw the
nested-grouping refusal out of the handler. `.or()` is a term parser now: a
column (a name or a JSON path) to the first dot, an operator to the next,
then a value that is a balanced `[…]`/`{…}` group when it starts with one, a
double-quoted string when it starts with `"` (PostgREST's quoting), or plain
text to the next comma with nothing else structural in it; a term whose
column is not column-shaped (what a comma in a plain value leaves behind), or
a group nothing closes, is the `PGRST100` `{ error }`; grouping is refused
only where a term begins. Also taken: pass 1's `ArrayBuffer.isView` rule ate
a `bytea` column's `Buffer` — it applies to an array column only; `date[]`
and `timestamptz[]` elements were Dates — shaped by element as the scalar
is; a function's rows had no column map, so `crm_search_contacts` gave
`follow_up_date` as an instant through `crm_search_contacts_fts` and as the
bare date through the ILIKE fallback, the shape changing with whether
`to_tsquery` accepted the query — each overload carries its OUT columns
(`proallargtypes` by `proargmodes`) and the rows take that map; a column the
schema lacks re-read `pg_attribute` on every call for the process's life
(200 reads for 200 calls, 2.5× the time, no coalescing under concurrency) —
a fresh read that still lacks the name remembers it as absent, forgotten
when a later read finds new columns; the one-to-one test reads a valid
index's key columns only (`indisvalid`, `indnkeyatts`; an `int2vector`
cast is zero-based, so the first attempt's `[1:n]` slice dropped the first
key and the pin caught it); the RETURNING refusal is checked after the
missing-table skip; two pass-1 additions the runner proved load-bearing by
mutation but nothing pinned — foreign keys among visible tables only (a
same-named table in a hidden schema with the key the visible one lacks was
joined as the visible one without the predicate), and array binding by type
category (a `DOMAIN` over `text[]`) — have their pins; the tool suite's
comment that Bun opens a pool lazily was wrong (it opens to `max`; the
FORK sentence was right); the Verified block's superseded numbers. Noted,
no change: the STORES clear on `close()` is dead in production (no server
closes) and fires in tests and scripts; the connection bound is 20 against
an observed 12; the 90-day pin's database-zone case is exercised only
outside CI's UTC container. Pins: `[4]` a quote, a parenthesis and `and (`
inside plain values, an unclosed group, PostgREST's quoted form; `[13]` the
date through a function; `[15]` the domain; `[17]` the hidden table; `[18]`
the typo's 42703 twice; the tool suite: an unclosed quote and parenthesis as
pattern text, an exact name through the four-term `.or()`, `follow_up_date`
one shape through the function. `test-compat.ts` 152/152; `test-tools.ts`
121/121. The stop signal holds on the original mechanism: nothing the pass
found there is above LOW; the one mechanism whose seams recurred is replaced.

**Review pass 3** (the same two shapes, aimed at the seams between the rules
passes 1 and 2 added — the case the house rule says earns a pass after the
stop signal; twenty items, sixteen taken). Both reviewers found the same two
seams, in pass 2's additions. The absent-name memo undid pass 1's
add-a-column rule for a column ever named before it existed: the name sat in
`absent`, no re-read followed the migration, and the array bound raw — the
22P02 this change exists to remove — for the process's life (executed:
reads stayed at two across the `ALTER`). The failure path knows when the map
disagreed with the schema, so a query that named an absent column and then
failed with anything but "undefined column" forgets the table's map, and so
does one that RAN (a `date` column added after it was first named would
otherwise shape as an instant, silently): one failed call after the
migration, not a restart — `[18]` pins the 22P02 then the success. And the
term parser's grouping refusal fired at every term start, where a comma in
user text makes one: `Sofa, and (chairs)` threw the refusal out of
`search_household_items` on the real server, `v1, v1.2.3 pipe` an "operator
2" refusal, `a, meta.cs.junk` the JSON-parse refusal — and
`professional-crm` has no `try/catch` at all. Grouping is refused only where
the file's own expression begins; every refusal a comma-made term raises in
`term()` is the `PGRST100` `{ error }`, so an unknown operator in the file's
own text is the 400 now too (`or()` cannot tell the two apart, and PostgREST
answers 400 to both); `col.not.op.value`, PostgREST's negation inside
`.or()`, parses. Also taken: pass 2's two household pins were vacuous — an
unbalanced `(` and `"` in a query that matches nothing is 0 rows under the
swallowing splitter too — replaced by an item named `Kitchen (main) 12" tap`
found by `Kitchen (main` and by `12" tap` (0 under pass 1's splitter, 1 under
the parser; the runner verified both ways); four pass-2 rules that survived
mutation with no assertion have one each — the `bytea` guard, `date[]`
elements, `indisvalid`, the index's key columns (`INCLUDE (note)` on the
unique index still a one-to-one, an invalidated index not); `RETURNS SETOF
<table>` rows and a scalar result were unshaped (`proargnames` is NULL) —
the overload carries its return type, a table's rows take that table's map,
a scalar its one column, and candidates agree only when their shapes are
equal (one with no OUT columns beside one with some had passed the check
vacuously); twenty concurrent callers missing the same name each dropped
the memo and re-read (20 reads) — only the caller whose map is still current
drops it; the absent set is bounded at 64 names (a comma in user text can
inject a well-formed term with any column name); the typed-array rule works
without a column map too (a function's rows), sparing a byte view; the
README's `date` paragraph and the header's cache sentence said the pre-pass-1
rule. Noted, no change: a plain value keeps its surrounding whitespace and a
value beginning with `{`, `[` or `"` is read as a group or a quoted string
(PostgREST's reading; every user-text call site prefixes `%`); a DOMAIN over
`date[]` shapes by the type's name where `bound()` reads the category (no
such column anywhere); the empty broken term's message names nothing (a
leading or doubled comma — PostgREST 400s too). Pins: `[4]` grouping words,
an operator, an `in` and a bad `cs` value after a comma as the 400, grouping
at the start still a throw, `not.`; `[13]` `SETOF` and a scalar date; `[15]`
`date[]`, `bytea`; `[17]` `INCLUDE`, an invalid index; `[18]` the late column
named early. `test-compat.ts` 165/165; `test-tools.ts` 122/122. Every top
finding again sat in the previous pass's additions, and the two mechanisms
pass 2 added have each had their seam closed once.

**Review pass 4** (the same two shapes, at the user's call; fourteen items,
ten taken). Both reviewers found the seam pass 3's forget-on-success rule
opened: `.in(col, [])` renders `FALSE` without the column, so on a column
the table lacks it RAN, the rule forgot the absent memo the same call had
built, and the next call re-read the catalog — measured at two reads per
call for ever, against two in total under pass 2 — and one such call
poisoned the table's memo for every other query. A column that never
reaches the SQL is not one the query names: `in.()`'s positive form returns
before the name is recorded. Its pin counts the reads through a spy on the
pool's `unsafe()` (two calls, zero reads; a typo, one read then none) — the
first pin had asserted only the empty answer, which the defect also gave.
The reader then found the rule's own comment broader than its code, in the
original change: a column that appears only in the select list, or only in a
`*` row, never passed through `names()`, so a `date` column added under a
running server shaped as an instant on every read (measured) — the select
list names its columns now, and a returned row carrying a key the map does
not know forgets the table for the next call. The runner found the absent
set losing names under concurrency (pass 2's bookkeeping: read before the
await, written after — twenty concurrent callers naming twenty missing
columns kept one; nineteen re-reads followed) — one set per table, made
before the await, pinned by count. And one original-mechanism defect with a
wrong answer and no error: two overloads sharing an argument's name but not
its type (`tagged(search_tags text[])` beside `tagged(search_tags text)`, in
one schema or across two visible ones) made `typeOf` give up, the array went
as `"a,b"`, and Postgres chose the text overload — the value's shape now
tells the candidates apart as PostgREST's JSON body does (an array fits an
array, json or vector parameter; an object json), and the cast then resolves
the call. Also taken: an `undefined` payload value was written as NULL where
supabase-js's JSON drops the key and Postgres applies the DEFAULT (a `NOT
NULL DEFAULT` column was a 23502) — dropped from the column list and the SET
list; a function returning a standalone composite type was unshaped
(`relkind 'c'`); the typed-array rule without a map, the cap and the
coalescing have their pins (overloads that disagree, a counted shared
re-read); the header's error convention and the Mechanism paragraph name
`.or()`'s exception; the `cs` message says when the column is not the
table's; the ticket for the pre-existing divergences is named. Noted, no
change: the shapes-equality check is a tidy-up of the agreement rule, not a
closed defect (the runner could not make the old check misbehave); `RETURNS
SETOF <scalar>` answers `[{fn: v}, …]` where PostgREST may answer bare
scalars (unverified, nothing in the tree); a JSON path the file wrote wrong
inside `.or()` is the 400 where the same path outside it throws — the
undecidable case, now stated. Pins: `[2]` the DEFAULT applied, the SET list;
`[13]` the composite type, overloads that disagree; `[15]` the array-typed
overload chosen, the text one for a string; `[18]` the read counts, the
select-list and `*` columns seen. `test-compat.ts` 177/177; `test-tools.ts`
122/122. The two silent wrong values were in the original change, found by
reading the rule pass 3 wrote against the header's claim; the loop stops
here — the reviewers said so too.

**Boyscout.** The passes' cut-for-space tidy-ups in the files this change
touched, no behaviour changed: the no-op `this.op = "select"` line is its
comment alone; `cs` trims and quotes the column once instead of in the
closure; `toSQL()`'s comment says it rejects where `execute()` would resolve
`{ error }` (an `.or()` term that is the 400); `arrayLiteral`'s comment names
`undefined` beside `null`; `Result<T>`'s comment says the error is a
`PostgrestError` at runtime while the type stays what migrated files were
written against; two `SQL` instances the compat fixtures opened for one raw
statement each are closed; the tool suite's misplaced drift-guard banner sits
above its section, and two labels say what their assertion checks (a zod
refusal is `Invalid arguments`, which a database's `invalid input syntax`
would not have matched; "an empty list", not "before the log query", which a
count cannot tell). Left as they are, with the reason: `close()`'s
`POOLS.get(…) === this.pool` guard, called unreachable — harmless, and
"unreachable" has been wrong before; `catch()`/`finally()` re-running the
query after an `await` (pre-existing; memoising `execute()` would change
what a second `await` sees); the upsert's `EXCLUDED` filter reading the
target unsplit (SMD-1602's, a behaviour change); `forget()` leaving the
foreign-key memo (a table's keys change more rarely than its columns, and
dropping them is a read, not a tidy); `.or()`'s 400 messages carrying the
developer's hint to a user (PostgREST's do too); `meal-planning`'s
`search_recipes` being the one driven tool with no `try/catch` — upstream's
text, named here so the next reader knows which tool a thrown error would
leave to the SDK.

**Upstream status:** not applicable — the shim, the codemod and the suite are
fork-only, and the five servers' own text is untouched (the embeds, the
`.not()` calls and the array payloads are upstream's spelling, now served).
