# compat/supabase-sql

A `supabase-js`-shaped client that speaks SQL directly. Phase 2 of the migration,
for everything outside the core server.

## Why this exists

54 files outside `server-portable/` call PostgREST through `supabase-js`, across
33,000 lines — mostly community recipes and integrations. Hand-porting them to SQL
is weeks of work, and it would fork every one of them away from upstream
permanently.

The API they use is small and closed, though: about twenty methods. So instead of
rewriting the files, this reimplements the surface they call. A file migrates by
changing one import.

## Prerequisites

- [Bun](https://bun.sh) 1.4+ — the shim uses Bun's built-in Postgres client
- A Postgres with the Open Brain schema (see `../../db/`)
- podman or docker to run the tests

## Steps

### 1. Migrate a file

```bash
bun scripts/migrate-to-sql-shim.ts                    # triage, no writes
bun scripts/migrate-to-sql-shim.ts --apply --all      # rewrite every eligible file
bun scripts/migrate-to-sql-shim.ts --revert <file>    # undo, byte-for-byte
```

The rewrite is one line; a file that still reaches `Deno.*` is refused at triage and ported by hand first (step 3):

```diff
- import { createClient } from "@supabase/supabase-js";
+ import { createClient } from "../../compat/supabase-sql/index.ts";
```

A file written for the shim by hand — one that spoke PostgREST through `fetch` and was ported (`recipes/brain-backup/backup-brain.mjs`, `recipes/lint-sweep/lint-sweep.js`, SMD-2144; `recipes/thought-enrichment`'s three scripts through their `lib/brain.mjs`, SMD-2139) — is told apart by the missing `MIGRATED OFF SUPABASE` banner alone (each carries an `// ob1-fork` header, which is description, not the test): the triage lists it as a hand port and `--revert`, with or without a path, names it and leaves it alone — it has no supabase-js import to go back to.

### 2. Point it at Postgres

The environment variable **names do not change**, so the code does not either. Set
`SUPABASE_URL` to a `postgres://` connection string. `SUPABASE_SERVICE_ROLE_KEY` is
accepted and ignored — with SQL the credentials live in the URL.

Passing a `https://…supabase.co` URL fails immediately with an explanation rather
than at the first query.

### 3. Run a migrated server under Bun

A migrated server was written for upstream's Edge Function host — `Deno.env.get` for its
environment, `Deno.serve` at the end — and the shim imports `bun`, so until
SMD-1799 such a file also took `compat/deno-on-bun.ts`, a polyfill for those two
members, as its first import (SMD-1480, FORK.md change 74). The servers are
Bun-native now: `process.env` for the environment and, at the tail, the shape the
core server had (`||`: an empty `PORT` is unset, not port 0), with the listen address
`OB1_LISTEN_HOST` names, every address unset (`listenOn` from `_shared/auth.ts`, SMD-3323) —

```ts
export default {
  port: Number(process.env.PORT || 8000),
  ...listenOn(process.env.OB1_LISTEN_HOST),
  fetch: app.fetch,
};
```

— which Bun serves when the file is the entry module (`PORT` 8000 unset, Deno's
old default — a port podman's `gvproxy` also holds on macOS, so the examples say
`PORT=8787`), and which a test imports as `default.fetch` without listening (the
import reads `OB1_LISTEN_HOST`, so a value that is no IP address throws there too). A
file that still reaches `Deno.*` fails at the call under Bun, is refused by the
codemod's triage, and fails check 11 of `scripts/check-fork-consistency.ts`.
Then, from a checkout:

```bash
(cd extensions && bun install)     # once: the pinned hono, zod and MCP SDK the servers import

SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' \
PORT=8787 bun --no-install extensions/home-maintenance/index.ts         # an extension

SUPABASE_URL='postgres://…' MCP_ACCESS_KEYS='…' \
PORT=8787 bun --no-install integrations/agent-memory-api/index.ts       # a recipe or integration
```

An extension sits beside `extensions/node_modules` and resolves its packages from
there. A recipe or integration resolves the same pinned install through
`recipes/node_modules` and `integrations/node_modules`, committed links to
`../extensions/node_modules`, so the one `bun install` above serves every server
from any working directory (SMD-1991). `NODE_PATH`, which these commands used
to set, does not reach the MCP SDK's `exports` subpaths under Bun.
`--no-install` makes a skipped install fail the start, naming the package.
Without it, Bun downloads whatever version npm serves when it finds no
`node_modules` above the file, and a link whose target was never installed
counts as none. The other variables are the ones the file's README has
its Supabase deploy set as secrets, passed as environment instead; each README's
callout gives its own line. `SUPABASE_SERVICE_ROLE_KEY` is read and ignored by
every server. An extension's `schema.sql` applies to
a plain Postgres as it is: the RLS policies on `auth.uid()` upstream's carried
are gone (SMD-1810), so no stub function precedes it. Check 11 of `scripts/check-fork-consistency.ts` holds
every code file under the category directories and docs/ to no `Deno` (the seven Edge Function files it excepted left with SMD-1800), and every shim-importing file to no
`jsr:`/`npm:`/URL specifier, through the files it imports — and
`extensions/test-auth.ts` starts each one under `bun` and answers it over its port
in CI. The codemod's `KEEP` list — a file that deploys where PostgREST is present
and `bun` is not — is empty since SMD-1800 retired its one entry with its recipe.

### 4. Run the tests

```bash
cd compat/supabase-sql && bun run test
```

## Expected outcome

`295 assertions: 295 passed, 0 failed` and `PASS`. A migrated file behaves
identically: same `{ data, error }` shape, same SQLSTATE codes, same row counts.
`extensions/test-tools.ts` then drives every tool of the seven MCP servers with
a schema of their own — the extensions, forty-five tools — against those
schemas, and `extensions/test-writes.ts` the servers
that need the model provider stubbed (agent-memory-api's nine routes,
the two consolidation workers, smart-ingest): the migrated
files this shim is judged by.

## What is supported

| | |
| --- | --- |
| Verbs | `from` `select` `insert` `update` `upsert` `delete` `rpc` |
| Filters | `eq` `neq` `gt` `gte` `lt` `lte` `like` `ilike` `is` `in` `contains` `match` `or` `not` — `.or()` with `and(…)`, `or(…)`, `not.and(…)` grouping to any depth and `col.in.(a,b)` lists (SMD-1798) |
| Filter columns | a column, or PostgREST's JSON path — `metadata->>key`, `meta->a->>key` — in the comparison filters, `is`, `in`, `match`, `.or()` terms and `.order()`; not `.contains()`, which is containment with the column's own operator |
| Modifiers | `order` `limit` `range` `single` `maybeSingle` `count` `head` |
| Embedding | `relation (cols)`, `alias:fk_column (cols)`, `relation(*)`, nested to any depth — through the foreign key the catalog finds; many-to-one an object or `null`, one-to-many an array or `[]`; `relation!inner (…)` keeps only the rows that have an embedded row (an `EXISTS`, nested with the embeds), `relation!fk_name (…)` and `relation!fk_column (…)` choose the key where two join the tables, from either side; a table embedded in itself is its children (SMD-1798) |
| Arrays | a JavaScript array is bound by the column's or the function argument's declared type: an array literal for `text[]`, JSON for `jsonb`, JSON text for `vector` |

Behaviours that are easy to get wrong and are pinned by tests: `range()` is
inclusive at both ends; `.in([])` selects nothing; `.single()` on zero rows is an
error with code `PGRST116` while `.maybeSingle()` is `null`; `.contains()` is `@>`
with the column's operator — array containment on `text[]`, jsonb containment on
`jsonb` — and `.or()` takes `cs` the same way; `.not(col, op, v)` is `IS NOT` for
`is` and `NOT (…)` otherwise; errors resolve as `{ error }` rather than throwing,
and the error is a `PostgrestError`, an `Error` subclass carrying `code`, so a
file's `throw error` renders the database's message; a JSON path compares
the key's *text*, so a number against `meta->>score` is a text comparison
(`"5" >= "20"`), as it is through PostgREST — a numeric comparison on a JSON
key is an `.rpc()`; and a `timestamptz` arrives as an ISO string
(`toISOString()`'s form), as PostgREST's JSON has it, not as the Date Bun hands
back — a migrated file's `created_at.slice(0, 10)` works (FORK.md change 73,
SMD-1544). A `date` column is the bare date PostgREST gives, `2026-09-16`, from
a table's rows, a `RETURNS TABLE` function's and a `date[]` (change 77; five
extension tools read one). A `timestamp without time zone` column is still a
`Z` instant where PostgREST gives a zone-less datetime; `.slice(0, 10)` agrees,
an equality does not — no migrated file reads one.

Five places the shim answered what PostgREST does not, each a silent wrong
answer until SMD-1602 pinned them: `{ count: "exact" }` without `head` is the
total over the whole `WHERE` (the page carries `count(*) OVER ()`; an empty
page past the end runs the count query PostgREST runs), not the page's size;
`.single()` — and `.maybeSingle()` — over several rows is `PGRST116`, not an
arbitrary first row; `{ head: true }` without a count is `data: null` and no
count, not the table; an upsert's conflict target is `onConflict`'s columns
or the table's primary key (a table with neither is refused, naming the
option), never the payload's first key, and every payload column is assigned
from `EXCLUDED`, so the statement always returns the row — unless
`ignoreDuplicates: true` asks for `DO NOTHING`, which leaves a conflicting row
as it is and returns none, as `Prefer: resolution=ignore-duplicates` does
(unread until SMD-1798's first review pass; repo-learning-coach's progress
upsert, retired since with SMD-2923, had reset a learner's row on every sync);
and `.rpc()`'s shape
is what the function declares (`pg_proc.proretset`): a set-returning function
is rows even when one row of one column came back, `RETURNS SETOF <scalar>` a
bare list, a scalar function its value, a function returning one composite row
that row as an object. An array column is read through `to_json`, which is
PostgREST's own rendering: a `uuid[]` a list of strings (Bun left it as the
literal text `{…}`), a `real[]` holding a `NULL` a list with a `null` (Bun's
binary decoder refused the column outright, so the query log's `result_scores`
never landed through this shim).

The shim never sends a `*` it can name (SMD-3329). Bun prepares each statement
and keeps it, and a `*` over a table a migration widens, or a function it drops
and makes again with one more OUT column, re-analyses to a different result
type: Postgres then refuses the cached plan (0A000, "cached plan must not change
result type") on every call until the process restarts. So a table's `*` — in
`.select("*")`, a bare `.select()` and a write's `RETURNING` — is spelled out
from the catalog's map, array columns through `to_json`, with the table's
shape read beside the rows — its oid, its attribute count and a digest of its
columns' types — so the call after a column is added, a table is rebuilt under
its name or a column is retyped has it; a name read from the catalog is quoted as Postgres quotes it, so a
column named `my col` reads too. `.rpc()` names the columns the function
declares (`RETURNS TABLE`, OUT parameters, the table of `RETURNS SETOF
<table>`), and reads `*` for an unnamed OUT parameter, which has no name.

A column dropped, or an OUT column renamed, is a 42703 that Postgres places
(its error's `position`, in characters, or in bytes on a `SQL_ASCII` server)
inside the list the shim wrote: the shim reads the catalog again and runs the
call once more, so the caller sees no error. Postgres refuses the column before
it executes anything, so nothing runs twice. A 42703 it places anywhere else — a
filter's column, a payload key, an update's `SET`, a column inside an embed, the
count query of a page past the end — is the caller's: answered once, and the
42703 itself causes no re-read. One raised inside a function body or a trigger
carries no place in the statement and is never retried, so a body that advanced
a sequence is not run again.

When Postgres refuses a statement's cached plan (0A000) — a column retyped, or
dropped and added again with another type; a function the catalog read as a
scalar since made again with columns; overloads that disagree, one made again —
the shim reads the catalog again and runs the call once more as a new
statement: a generation number, a trailing comment, kept per table or function
and URL, since a fresh read may spell the same text and Bun keeps a prepared
statement under its text, with its old plan and the parameter types it was
first given. A 42703 in the shim's own list does the same, and so does a
changed shape read beside a star's rows, so a statement that binds a retyped
column as a parameter is made new too. Later calls reuse the new statement; the
calls one change refused at once forget the map, and move the generation, once. Only the plan
cache's own refusal counts (the error's routine, `RevalidateCachedQuery`, with
no function's context on it), which comes before the statement runs; a 0A000 a
running body raised is never retried. A function the catalog read as a scalar
and made again with columns, met on a connection that had not prepared its
statement, fails nothing: that call's rows are shaped by the old read, and the
next call's by a fresh one. An embed's `(*)` stays a star: its rows reach the
caller as one json column, whose type a new column does not change.

Not mended until the process restarts, as before: a table read only through
statements that bind a retyped column as a parameter, with no read of its `*`
that returns rows to carry the new shape (Postgres refuses the old parameter
type before any plan is refused); a function whose argument was retyped (the
same, through `.rpc()`); a column retyped in a table read with no parameters at
all, which Bun never prepares, until a read of its `*` carries the shape back.
Statements a generation leaves behind stay prepared on their connections.

## What is deliberately refused

Each of these throws with an explanation instead of guessing:

- **An embed the catalog cannot join** — a relation with no foreign key to the
  table it sits in, or with two and no hint (name the column, `alias:fk_column
  (…)`, or the key, `relation!fk_name (…)`), a hint that names no key, and the
  two ambiguities PostgREST refuses too: a column hint that is a key column of
  both tables, and a key column named like a table that another key joins. A
  self-reference is named by its column, never by its constraint (PostgREST's
  PGRST200): `nodes!parent_id (…)`, or `nodes (…)` bare, is the children;
  `parent_id (…)` is the parent. Nested embeds (`applications!inner(*,
  job_postings!inner(*, companies!inner(*)))`), the hints `!inner`, `!fk_name`,
  `!fk_column` (the base's own key column, or the relation's from the
  referenced side) and `!left`, and an embed on the row a write returns
  (`.insert(row).select("*, companies (id, name)")`) are served since SMD-1798
  (the table above).
- **An order, limit or range on an embedded resource** — `.order("due", {
  foreignTable: "tasks" })`, `.limit(3, { referencedTable: "tasks" })`: the embed
  returns every row; order or cut them in the file, or ask in a second query.
  Applied to the base table instead it would be a silent wrong answer, so it is
  refused at the call and the codemod blocks it.
- **A filter on an embedded column** — `.neq("thoughts.sensitivity_tier", …)`
  beside `thoughts!inner(…)`: the dotted name is refused as an identifier. Read
  the embedded rows and filter them, or ask in two queries.
- **A JSON path ending in `->`** — `meta->flag` yields jsonb, and what a bound value
  means against it depends on the value's JavaScript type. End the path in `->>`
  for the key's text, or use `.contains()`. An array index (`->0`), and a path in
  a select list, a payload or a conflict target, are refused too.
- **Type-only imports** — `import type { Session, User } from "@supabase/supabase-js"`.
  The shim exports different types.
- **`.auth`, `.storage`, `.channel`, `.functions.invoke`** — nothing here uses them.

The codemod treats all of these as blockers and refuses to touch those files.

## Safety

Identifiers cannot be parameterised in Postgres, so table and column names are
validated against `^[A-Za-z_][A-Za-z0-9_]*$` and quoted; anything else throws. A
JSON path's keys are held to the same shape and rendered as quoted string
literals (`"meta"->>'key'`). Values always travel as bound parameters — against
a path, cast to text, so a number or a null in an `.in()` list compares as its
text where a plain text column would refuse the integer; an array for an array
column as one parameter holding the array literal, its elements quoted and
escaped, cast to the declared type. A test asserts that a value containing
`'; DROP TABLE …` is stored as data and the table survives.

`createClient` refuses a value that is not a `postgres://` URL by its shape
alone — its scheme (`got a "mysql:" URL`), or that it has none — and never
repeats any of the value: the hand-ported recipes pass the connection string
here, so a mistyped scheme quoted back would print the role's password
(SMD-2263). It trims the value first, so a stray space or newline from an env
file is no refusal.

## The catalog

PostgREST knows the schema; a supabase-js caller leans on that without knowing
it. The shim reads the same three things once per name per process, cached by
connection URL: a table's column types (`pg_attribute` — which columns are
arrays, which jsonb), its foreign keys in both directions (`pg_constraint`), and
a function's argument names and types (`pg_proc`). Bun's driver serialises a
parameter by the type the server describes for it and has no array-literal
form, so a JavaScript array reached a `text[]` column as its `String()` (`a,b`,
`""` for `[]`) and was refused as malformed — while the same array into a `jsonb`
column beside it was right. Value shape cannot decide that (`tags TEXT[]` and
`instructions JSONB` take the same `string[]`); the column's declared type does.
A table's columns are re-read when the caller names one the map lacks; when a
query that named a column remembered as absent runs, or fails another way (the
column is there now); when the shape read beside a star's rows moves (a column
added, a table rebuilt under its name, a column retyped; a call must return rows
to carry it); when the shim's own list names one since dropped, which `.rpc()`
also does for the table a `RETURNS SETOF` returns; or when Postgres refuses a
statement's cached plan. A function's are re-read when one of its declared
columns is gone, when a changed plan is refused, or when a scalar's row comes
back with other columns. Anything else — a foreign key added, a column added to
a `RETURNS TABLE`, a column added to a `RETURNS SETOF`'s table until a read of
that table notices the shape — is not seen until the process restarts, as with
PostgREST's own cache. `toSQL()` reads the catalog too, so it is a promise.

Clients on one connection URL share one pool. The vendored servers build a
client inside each request and close none — an Edge Function's shape — and
under Bun a pool per request held its connection for the life of the process
(84 after the tool suite's calls, against a default limit of 100).

## Two gotchas worth knowing

**Bun reports SQLSTATE in `errno`, not `code`.** PostgREST puts it in `code`, and
recipes branch on `error.code === "23505"`. The shim maps it across; without that
every such branch silently stops matching.

**Never pre-stringify a jsonb value.** Bun binds a JS string to a `jsonb` parameter
as a JSON *scalar string*, so `meta @> '{"a":1}'` compares object to string and
returns zero rows with no error. `.contains()` binds the object. This is the same
trap `db/migrations/005` rejects at the database, and the shim hit it during
development — the test caught it.

## Caveats

- **Bun only.** It uses `Bun.sql`. Node needs a driver swap; Cloudflare Workers
  cannot pool connections at all. The servers on it run as `bun <file>` (step 3).
- **Most migrated recipes and integrations are not individually tested.** Most
  need live credentials — Gmail, Slack, Readwise. The shim is tested; each
  migrated file is verified to parse; `extensions/test-writes.ts` drives the
  writers among them against a real Postgres (the bio worker, the one that
  filters on a JSON path, found the two gaps change 73 closed); and
  `extensions/test-tools.ts` drives every tool of the seven MCP servers with a
  schema of their own — forty-five tools since SMD-2920 retired ob-graph's ten — against those
  schemas (change 74's review had found seven of the first twenty-nine
  failing on the shim — no `.not()`, a JavaScript array bound as its `String()`,
  four embedded selects the codemod's blocker regex let through — and driving
  every argument branch found two more; change 77 closed them all). Exercise
  the recipes and integrations you actually run before trusting them.
- **`insert()` with heterogeneous rows** fills missing keys with `NULL` rather than
  letting the column default apply, because a multi-row `INSERT` needs one column
  list.
- **Timestamps are strings.** A `Date` Bun hands back is rendered as its ISO
  string, as PostgREST's JSON has it (FORK.md change 73); a consumer that wants a
  `Date` does `new Date(row.x)`, as the shim-migrated extensions already do.
- **JSON-path keys are identifier-shaped.** `meta->>café` and `meta->>a$b` are
  refused here; PostgREST accepts both. Nothing in the tree uses such a key.

## Related

- `../../scripts/migrate-to-sql-shim.ts` — the codemod
- `../../extensions/test-tools.ts` — every extension tool on the shim, driven against Postgres
- `../../server-portable/store-sql.ts` — the core server's own SQL layer
- `../../db/` — the schema these queries run against
