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
node scripts/migrate-to-sql-shim.mjs                    # triage, no writes
node scripts/migrate-to-sql-shim.mjs --apply --all      # rewrite every eligible file
node scripts/migrate-to-sql-shim.mjs --revert <file>    # undo, byte-for-byte
```

The rewrite is one line:

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

### 3. Run the tests

```bash
cd compat/supabase-sql && bun run test
```

## Expected outcome

`61 assertions: 61 passed, 0 failed` and `PASS`. A migrated file behaves
identically: same `{ data, error }` shape, same SQLSTATE codes, same row counts.

## What is supported

| | |
| --- | --- |
| Verbs | `from` `select` `insert` `update` `upsert` `delete` `rpc` |
| Filters | `eq` `neq` `gt` `gte` `lt` `lte` `like` `ilike` `is` `in` `contains` `match` `or` |
| Modifiers | `order` `limit` `range` `single` `maybeSingle` `count` `head` |

Behaviours that are easy to get wrong and are pinned by tests: `range()` is
inclusive at both ends; `.in([])` selects nothing; `.single()` on zero rows is an
error with code `PGRST116` while `.maybeSingle()` is `null`; `.contains()` is jsonb
`@>`; errors resolve as `{ error }` rather than throwing.

## What is deliberately refused

Each of these throws with an explanation instead of guessing:

- **Resource embedding** — `.select("*, other_table(*)")` needs foreign-key
  introspection to become a join. Four files use it.
- **Nested `.or()`** — `or(and(a.eq.1,b.eq.2),c.eq.3)` needs a real parser. The flat
  form, which is the only one this repo uses, works.
- **Type-only imports** — `import type { Session, User } from "@supabase/supabase-js"`.
  The shim exports different types.
- **`.auth`, `.storage`, `.channel`, `.functions.invoke`** — nothing here uses them.

The codemod treats all of these as blockers and refuses to touch those files.

## Safety

Identifiers cannot be parameterised in Postgres, so table and column names are
validated against `^[A-Za-z_][A-Za-z0-9_]*$` and quoted; anything else throws.
Values always travel as bound parameters. A test asserts that a value containing
`'; DROP TABLE …` is stored as data and the table survives.

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
  cannot pool connections at all.
- **The migrated files are not individually tested.** Most need live credentials —
  Gmail, Slack, Readwise. The shim is tested; each migrated file is verified only
  to parse. Exercise the ones you actually run before trusting them.
- **`insert()` with heterogeneous rows** fills missing keys with `NULL` rather than
  letting the column default apply, because a multi-row `INSERT` needs one column
  list.

## Related

- `../../scripts/migrate-to-sql-shim.mjs` — the codemod
- `../../server-portable/store-sql.ts` — the core server's own SQL layer
- `../../db/` — the schema these queries run against
