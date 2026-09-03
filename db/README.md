# db — the core schema, as migrations

Phase 1 of the Supabase migration. The Open Brain core schema currently exists as
**prose inside a markdown guide** (`docs/01-getting-started.md`, steps 2.2–2.6),
where nothing can apply it, version it, or check it. This directory is that DDL
made executable.

Nothing here is Supabase-specific. It targets any Postgres 15+ with pgvector.

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- To apply against a real database: Postgres 15+ with the `vector` extension
  available (RDS, Aurora, Neon, Cloud SQL, Timescale, or self-hosted)
- To run `test-schema.ts`: nothing else. It uses PGlite, which is real PostgreSQL
  17 compiled to WASM — no daemon, no container.
- To run `test-live.ts`: podman or docker, for a throwaway container
- To run `test-upgrade.ts` or `bench-trgm.ts`: the same, and for the benchmark a
  few minutes — it builds tables up to 100,000 rows

## Steps

### 1. Install

```bash
cd db && bun install
```

### 2. Check what would run

```bash
bun migrate.ts --url postgres://user:pass@host:5432/dbname --dry-run
```

### 3. Apply

```bash
bun migrate.ts --url postgres://user:pass@host:5432/dbname
# or: DATABASE_URL=... bun migrate.ts
```

Each migration runs in its own transaction and is recorded in `schema_migrations`,
so re-running is a no-op and a failure part-way resumes rather than restarting.

### 4. Adopting an existing database

If your `thoughts` table was created by hand from the guide, you have two options.
Every migration is individually idempotent, so you can simply run them — nothing
will be duplicated. Or record them as applied without executing:

```bash
bun migrate.ts --url ... --baseline
```

## Expected outcome

`bun test-schema.ts` prints `78 assertions: 78 passed, 0 failed` and `PASS`.
Against a real database, `bun migrate.ts` reports eleven migrations applied, and
`\d thoughts` shows seven columns and six indexes — five of our own plus the
primary key, which `\d` also lists.

## The migrations

| File | What | Source |
| --- | --- | --- |
| `001_core_schema.sql` | `thoughts` table, three indexes, `updated_at` trigger | Guide step 2.2 |
| `002_match_thoughts.sql` | Semantic search RPC | Guide step 2.3 |
| `003_content_fingerprint.sql` | Fingerprint column, unique partial index, `upsert_thought` | Guide step 2.6 |
| `004_upsert_thought_with_embedding.sql` | 3-arg atomic-capture overload | This fork |
| `005_reject_non_object_payload.sql` | Reject a non-object `p_payload` instead of silently storing `{}` | This fork |
| `006_embedding_config.sql` | Record the embedding contract so preflight can catch a later disagreement | This fork |
| `007_thought_chunks.sql` | `thought_chunks` table, 4-arg capture overload, `match_thoughts` over both tables | This fork |
| `008_thought_audit.sql` | Append-only `thought_audit`, enforced by trigger; audit written inside the mutating transaction | Ported from `schemas/thought-audit` |
| `009_update_delete_thought.sql` | `update_thought` / `delete_thought`; recomputes the fingerprint and replaces chunks, atomic `if_unchanged_since` | Ported from `integrations/*-thought-mcp` |
| `010_agent_identity.sql` | `ob1_agents` / `ob1_agent_keys`, `resolve_agent`, `revoke_agent_key`; `thought_audit.canonical_agent_id` | Ported from `schemas/per-agent-identity` |
| `011_text_search_trgm.sql` | `pg_trgm` plus a trigram GIN index on `thoughts.content`, for leading-wildcard `ILIKE` | Ported from `schemas/text-search-trgm` |

## What changed relative to the guide

Four deliberate differences. Each is a portability fix, not a behaviour change.

**Indexes are named.** The guide writes `create index on thoughts …`, letting
Postgres auto-assign names — which cannot be made idempotent. The names used here
(`thoughts_embedding_idx`, `thoughts_metadata_idx`, `thoughts_created_at_idx`) are
exactly what Postgres would have chosen, so a database built from the guide already
satisfies them and will not grow duplicates.

**`IF NOT EXISTS` throughout.** The guide's step 2.6 is unguarded, so applying core
setup and then `recipes/content-fingerprint-dedup` — which ships the same DDL —
fails on both the `ALTER TABLE` and the `CREATE UNIQUE INDEX`.

**The RLS policy is dropped.** The guide enables row-level security on `thoughts`
with `USING (auth.role() = 'service_role')`. Both halves are Supabase-managed:
`auth.role()` comes from GoTrue and `service_role` is a Supabase role. Neither
exists elsewhere. It also never did anything — the service role has `BYPASSRLS`,
so the policy never evaluated. Re-add real RLS against your own claim if you
introduce multi-tenancy; do not port this one.

**No `GRANT … TO service_role`.** Grant to whichever role your application
connects as.

## Extensions

The core schema needs **`vector`** and, since migration 011, **`pg_trgm`**.
`gen_random_uuid()` has been a Postgres built-in since 13 and `sha256()` since 11,
so `pgcrypto` is not required — despite five files elsewhere in the repo creating
it.

The two extensions differ in what they demand of the role applying the migration.
`pg_trgm` is a *trusted* extension from PostgreSQL 13 onward, so a database owner
can create it without superuser. `vector` is not, and 001 already needs the
stronger privilege — so 011 adds no requirement that was not already there.

## Benchmarking the trigram index

`bench-trgm.ts` measures what migration 011 costs and buys, because the number
SMD-925 arrived with was measured on somebody else's brain and does not transfer.

```bash
./with-postgres.sh bun bench-trgm.ts
OB1_BENCH_CORPUS=/path/to/corpus.json ./with-postgres.sh bun bench-trgm.ts
```

Without a corpus it generates from a built-in vocabulary. Pointed at one it builds
a bigram model of that text and samples from it, so the trigram distribution
resembles the real one — duplicating rows verbatim would collapse the index's
distinct-gram count and flatter it enormously. The corpus is only ever read.

Markers are planted at known frequencies (5 rows, 10%, 90%) so selectivity is a
controlled variable, and the two-character probe matches exactly the same rows as
the rare-word probe — so the sub-trigram limit is isolated from selectivity rather
than confounded with it. The number of matched rows is printed alongside each
timing, because a probe that accidentally matches nothing otherwise looks like the
best result in the table.

The headline result on our own data, and the reason the migration header is as
long as it is: **the crossover is somewhere between 1,000 and 10,000 rows.** Below
it the index is not slower, it is simply never chosen. Above it a 5-row `ILIKE`
improves by 380x at 10,000 rows and 1280x at 100,000 — but a word in 10% of rows
gets only ~8x at either size, and a common word and any sub-trigram pattern are
unaffected at every scale.

Two things the script has to do that are easy to leave out, both of which produced
confidently wrong numbers first:

- **Drop the index before the baseline arm.** Since 011 landed, `resetSchema`
  builds it, so "before" is no longer the default state of a fresh schema.
- **`VACUUM`, not just `ANALYZE`, between the arms.** The write-amplification arm
  leaves thousands of dead tuples that only the second read arm has to scan past,
  and GIN's pending list — which every query scans in full on top of the index —
  is only flushed by a vacuum. Skipping it reported the index as consistently
  *slower* at 97 rows, which was entirely an artifact of the measurement.

## Testing

Two suites, because one of them cannot reach everything.

```bash
bun test-schema.ts                    # 69 assertions, PGlite, no container
./with-postgres.sh bun test-live.ts   # 30 assertions, real server, throwaway container
```

`with-postgres.sh` starts `pgvector/pgvector:pg16`, exports `DATABASE_URL`, runs
the command and removes the container on exit. It prefers podman (including the
macOS `/opt/podman/bin` location that is often off `PATH`) and falls back to
docker. CI does not use it — GitHub Actions supplies the database as a service
container.

### What only the live suite can catch

- **The migration runner.** `migrate.ts` talks to a server over TCP with `Bun.sql`.
  PGlite is not a server, so the ledger, `--dry-run`, `--baseline` and drift
  detection were untested until `test-live.ts` existed.
- **Driver-level parameter binding.** The double-encoding bug below is invisible to
  a test that writes SQL literals. It only appears when a client binds a JS value
  to a `jsonb` parameter.
- **The planner.** Whether HNSW is actually chosen, rather than merely present.

### What test-schema.ts asserts

`bun test-schema.ts` applies every migration to a real PostgreSQL 17 in-process and
asserts 78 properties, including:

- every migration applies, **and applies twice without error**
- the table shape and all five index access methods match the guide, and the
  trigram index is not merely present but reachable — with `enable_seqscan` off
  the planner picks it for a leading-wildcard `ILIKE`, which a bare `gin (content)`
  would not satisfy
- both `upsert_thought` overloads resolve — the 3-arg form has no default on
  `p_embedding`, because a default would make the 2-arg call ambiguous and break
  every existing caller with `function is not unique`
- fingerprint dedup normalises whitespace and case, and merges metadata rather
  than overwriting it
- the atomic overload stores an embedding in one statement, and a `NULL` embedding
  on re-capture does not blank an existing vector
- `match_thoughts` orders by cosine similarity, honours `match_count`, and filters
  by `jsonb` containment
- the threshold comparison is **strict** — a row whose similarity exactly equals
  the threshold is excluded. Anyone reimplementing this in raw SQL must keep the
  strict `>` or result counts change silently.
- no `auth.uid()`, `auth.role()`, `service_role` grant, or RLS survives
- a non-object `p_payload` raises rather than silently storing `{}`

### The double-encoding trap

Both overloads read metadata as `COALESCE(p_payload->'metadata', '{}')`. The `->`
operator returns NULL for anything that is not a JSON object, so a caller that
passes a JSON *string* stored empty metadata and got a success back — content and
embedding written correctly, metadata gone.

Client libraries differ on this. `Bun.sql` binds a JS string to a `jsonb`
parameter as a JSON string (`jsonb_typeof = 'string'`), not an object; pass a JS
object instead. Upstream has already fixed this same class twice, in
`thought-enrichment` and `add_household_item`.

Migration 005 makes it raise. Valid calls — an object, `NULL`, or the `'{}'`
default — are unaffected.

## Caveats

- **Not yet run against a managed Postgres.** Verified against PGlite (PostgreSQL 17
  in WASM) *and* a real `pgvector/pgvector:pg16` container, but neither is RDS or
  Neon. Run `--dry-run` first against the real target.
- **HNSW index build time is not represented.** On an empty table it is instant; on
  a populated one it is not. Build it after a bulk load, not before.
- **Data migration is not covered here.** These migrations create the schema. Moving
  rows is `pg_dump --data-only` plus a re-embed if the model family changes.

## Related

- `../FORK.md` — what this fork changes and why
- `../server-portable/` — the runtime-neutral server (Phase 3)
- `docs/01-getting-started.md` — the original prose the schema was extracted from
