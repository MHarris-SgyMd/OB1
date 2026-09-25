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
core server has (`||`: an empty `PORT` is unset, not port 0) —

```ts
export default {
  port: Number(process.env.PORT || 8000),
  fetch: app.fetch,
};
```

— which Bun serves when the file is the entry module (`PORT` 8000 unset, Deno's
old default — a port podman's `gvproxy` also holds on macOS, so the examples say
`PORT=8787`), and which a test imports as `default.fetch` without listening. A
file that still reaches `Deno.*` fails at the call under Bun, is refused by the
codemod's triage, and fails check 11 of `scripts/check-fork-consistency.ts`.
Then, from a checkout:

```bash
(cd extensions && bun install)     # once: the pinned hono, zod and MCP SDK the servers import

SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' \
PORT=8787 bun extensions/home-maintenance/index.ts                      # an extension

NODE_PATH=extensions/node_modules SUPABASE_URL='postgres://…' MCP_ACCESS_KEYS='…' \
bun integrations/delete-thought-mcp/index.ts                             # a recipe or integration
```

An extension sits beside `extensions/node_modules` and resolves its packages from
there; a recipe or integration does not, and `NODE_PATH` points it at the same
pinned install for `hono`, `zod` and `@hono/mcp` (only the servers that import
them need it — the workers, the APIs on their own key and the webhook receiver
import nothing but the shim and their own files). The MCP SDK's `exports`
subpaths Bun does not resolve through `NODE_PATH`: an SDK-importing recipe or
integration starts because Bun fetches the package into its own cache on first
start — unpinned, with npm egress once — until SMD-1991 gives those directories
an install of their own. The other variables are the ones the file's README has
its Supabase deploy set as secrets, passed as environment instead; each README's
callout gives its own line. `SUPABASE_SERVICE_ROLE_KEY` is read and ignored by
every server but `work-operating-model-activation`, which refuses to start
without it — set it to any value there. An extension's `schema.sql` carries
Supabase RLS policies on `auth.uid()`; its README's Step 1 gives the two stub
functions a plain Postgres needs before the file runs. Check 11 of `scripts/check-fork-consistency.ts` holds
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

`257 assertions: 257 passed, 0 failed` and `PASS`. A migrated file behaves
identically: same `{ data, error }` shape, same SQLSTATE codes, same row counts.
`extensions/test-tools.ts` then drives every tool of the eight MCP servers with
a schema of their own — seven extensions and the ob-graph recipe, fifty-five
tools — against those schemas, and `extensions/test-writes.ts` the servers
that need the model provider stubbed (enhanced-mcp's thirteen tools,
agent-memory-api's nine routes, the two consolidation workers): the migrated
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
upsert had reset a learner's row on every sync); and `.rpc()`'s shape
is what the function declares (`pg_proc.proretset`): a set-returning function
is rows even when one row of one column came back, `RETURNS SETOF <scalar>` a
bare list, a scalar function its value, a function returning one composite row
that row as an object. An array column is read through `to_json`, which is
PostgREST's own rendering: a `uuid[]` a list of strings (Bun left it as the
literal text `{…}`), a `real[]` holding a `NULL` a list with a `null` (Bun's
binary decoder refused the column outright, so the query log's `result_scores`
never landed through this shim). On a table with an array column a `*` is
therefore spelled out from the catalog's map, `pg_class.relnatts` read beside
the rows so a column added under a running client is still seen on the next
call; a table without one keeps `SELECT *`.

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
  the embedded rows and filter them, or ask in two queries (enhanced-mcp's
  `graph_search` does).
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
A schema change after the first query is not seen until the process restarts,
as with PostgREST's own cache. `toSQL()` reads the catalog too, so it is a
promise.

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
  `extensions/test-tools.ts` drives every tool of the eight MCP servers with a
  schema of their own — fifty-five tools since SMD-1798 — against those
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
