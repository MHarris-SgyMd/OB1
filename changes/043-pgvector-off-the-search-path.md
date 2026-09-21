# 43. pgvector off the search path — the runner heals its own session, preflight names the persistent fix (SMD-1247)

Migration 001 runs `CREATE EXTENSION IF NOT EXISTS vector` unqualified, then
declares `embedding vector({{EMBEDDING_DIM}})` and `USING hnsw (embedding
vector_cosine_ops)`, also unqualified. On a database where pgvector is **already
installed into a schema that is not on the connection's `search_path`**, the
`IF NOT EXISTS` finds it and does nothing, and then the type and the operator
class do not resolve. This is how Supabase ships pgvector — an `extensions`
schema — and several managed providers do the same. The failure the user gets is
`type "vector" does not exist` on a database that demonstrably has pgvector,
which is about as confusing as this class of error gets. Upstream
[#319](https://github.com/NateBJones-Projects/OB1/issues/319) (open since
2026-07-01) reports exactly this; their guidance is paste-into-the-dashboard SQL
and their rules put the core schema out of scope, so they cannot fix it. The
migration chain is ours.

The whole test matrix missed it: `with-postgres.sh` and the CI service container
both run `pgvector/pgvector:0.8.6-pg16`, which installs the extension into
`public`, on the path. A user on stock pgvector never sees it; the population
this hits is precisely the one the fork is for.

**The runner heals its own session.** A shared `alignVectorSearchPath` (in
`db/config.mjs`, so `migrate.ts` and the test path cannot disagree) resolves the
extension's schema and, only when the bare `vector` type does not resolve, adds
that schema to the session's `search_path` before any migration runs. It is a
`set_config(…, false)`, session scope, and it survives into each per-migration
transaction on the same connection; a no-op where `vector` already resolves, and
where pgvector is not installed at all (001 then creates it on the path). One
place covers every migration, where schema-qualifying would spread across 001,
002, 014, 019, 020, 021 and every future one and fail the same way at the first
missed site. `applyMigrations` calls it too, so every test-built schema is
off-path-safe.

**It does not persist, and that is deliberate.** The runner changes only its own
session — no `ALTER DATABASE`, no `ALTER ROLE`. `ALTER DATABASE … SET
search_path` would fix the server too (migrate connects to the same database),
and the hnsw-bound seeding sets a precedent for the runner writing database-level
settings — but `search_path` changes name resolution for **every** role and
application on that database, where the hnsw bounds touch only Open Brain's
searches. On a managed database where pgvector is deliberately off-path, forcing
a global `search_path` is more than a schema migrator should assume. So the
runner heals its run; the operator owns the persistent policy, and preflight
names it. (Considered and recorded, per the ticket; a review pass may revisit.)

**Preflight catches the server.** The server's connection is a separate session,
so a healed migration does not mean a working server: a `match_thoughts` call
from a session without the schema on its path fails at runtime. A new `vector
extension` check — first in the direct-SQL block and in `DIRECT_CHECKS` — reads
the catalog (`to_regtype('vector')`, which returns NULL rather than raising when
the type is off-path, so an off-path database reports cleanly instead of taking
the later checks down with it) and, when the type does not resolve, **fails**
naming the schema pgvector is in, the role and database, and the exact fix. It
tells apart the two ways the type goes unresolvable, because they take different
fixes: an off-path schema wants `ALTER ROLE <role> SET search_path = …, <schema>`
(least-scoped) or `ALTER DATABASE <db> SET search_path = …`; a schema this role
has no `USAGE` on wants a `GRANT`, which `SET search_path` alone would not repair
(`has_schema_privilege` distinguishes them). A database where pgvector is not
installed at all is a **skip**, not a fail — migration 001 creates it, and the
schema check already fails an un-migrated database. The search_path remedy notes
it adds a setting beside the `hnsw.*` walk bounds rather than replacing them —
verified: after the fix, `pg_db_role_setting` carries `search_path` and the
seeded `hnsw.max_scan_tuples` / `hnsw.scan_mem_multiplier` side by side.

**Verified.** `db/test-search-path.ts`, twenty-two assertions against a real
server, relocates pgvector into a schema off the path and asserts, in order: the
type genuinely does not resolve for a fresh session while the extension is
installed; the chain applies incrementally off-path (the upgrade shape, a row
written between each migration) and `thoughts.embedding` carries the relocated
type; `migrate.ts` exits 0, says it added the schema to its session, builds the
schema, and a fresh session **still** cannot resolve `vector` (proving it did not
ALTER the database); preflight exits 1 naming the schema and both remedies; a
role with no `USAGE` on that schema is told to `GRANT`, not to set the path; and
`ALTER DATABASE … SET search_path` then makes preflight pass, with the hnsw bound
sitting beside it. The suite restores pgvector to `public` in a `finally`, which
`ci-parity.sh` needs since it shares one Postgres — the full parity run stays
green with the suite in the sequence. `test-preflight` [4] now expects `vector
extension` to be the first direct check named on an unreachable database.
`tsc --noEmit` is clean and the Workers bundle still builds
(`wrangler deploy --dry-run`, 272 KiB gzipped — preflight is not in the bundle).

**Not done here.** The server does not auto-configure its own connection
`search_path` (a `connection: { search_path }` option would need the schema
resolved before connecting); preflight names the operator's fix instead.
Schema-qualifying the migrations rather than healing the session — rejected above
for the missed-site failure mode. `test-schema.ts` (PGlite) does not cover this:
PGlite loads pgvector onto its own path and cannot reproduce the off-path shape.

Upstream status: #319 open; the fix cannot land in their core schema. **Unfiled.**
