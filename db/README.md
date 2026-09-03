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
- To run `test-upgrade.ts`, `bench-trgm.ts` or `bench-keyword.ts`: the same, and
  for the benchmarks a few minutes — they build tables up to 100,000 rows

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

`--baseline` is all-or-nothing: it marks **every** migration not already in the
ledger as applied, without running any of them. That is what adoption wants, and
it is the wrong tool for recording a single migration you applied by hand — on a
database sitting at 009 it would mark 010 applied too, and the agent registry
would never be created. For one migration, insert the one `schema_migrations`
row; `--dry-run` prints the `sha256` to use beside each name.

## Expected outcome

`bun test-schema.ts` prints `108 assertions: 108 passed, 0 failed` and `PASS`.
Against a real database, `bun migrate.ts` reports twelve migrations applied, and
`\d thoughts` shows seven columns and six indexes — five of our own plus the
primary key, which `\d` also lists. Five with `OB1_TRGM_INDEX=off`.

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
| `011_text_search_trgm.sql` | `pg_trgm`, plus a trigram GIN index on `thoughts.content` for leading-wildcard `ILIKE`. On by default since 012 gave it a caller; `OB1_TRGM_INDEX=off` omits it | Ported from `schemas/text-search-trgm` |
| `012_search_thoughts_keyword.sql` | `search_thoughts_keyword` — exact substring search with occurrence counts, true `total_count` and stable paging | This fork |

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

`pg_trgm` is created unconditionally. The index it exists for was opt-in until
migration 012 gave it a caller — `search_thoughts_keyword` — and is now **on by
default**, with `OB1_TRGM_INDEX=off` to omit it. The extension alone is inert:
catalog rows, no storage on the table and no cost on any write. Creating it
regardless is what makes enabling the index later a single statement instead of a
statement plus a privilege.

The flag is read only when 011 **applies**. Flipping it afterwards and re-running
the migrator does nothing, so `preflight.ts` compares the setting against
`pg_indexes` on every boot and prints the one statement to run. Every deployment
that applied 011 before this change is in that state by default: keyword search
works and sequentially scans until the index is built.

The two extensions differ in what they demand of the role applying the migration.
Measured on PG16 (`pg_available_extension_versions.trusted`), `pg_trgm` is a
*trusted* extension and `vector` is not — so a database owner can create pg_trgm
without superuser, while 001 already needs the stronger privilege. 011 adds no
requirement that was not already there.

## Benchmarking the trigram index and the keyword function

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
improves by ~350x at 10,000 rows and ~1370x at 100,000 — but a word in 10% of rows
gets only 8-9x at either size, and a common word and any sub-trigram pattern are
unaffected at every scale. The full table, with the write cost beside it, is in
the header of `migrations/011_text_search_trgm.sql`.

### bench-keyword.ts

`bench-trgm.ts` measures a bare `content ILIKE '%needle%'`. `bench-keyword.ts`
measures the three things migration 012 added on top of it, none of which the
earlier benchmark can speak to:

```bash
./with-postgres.sh bun bench-keyword.ts
```

**Whether an escaped pattern still reaches the index.** `search_thoughts_keyword`
escapes `_` and `%` before wrapping the needle, because unescaped they are ILIKE
wildcards and `upsert_thought` would also match `upsert-thought`. But `_` is the
most common character in the identifiers the feature exists to find, and nothing
had checked that pg_trgm can extract grams across `\_`. It can: the index is used
at 10,000 and 100,000 rows, on the first call and on twelve more.

Those twelve extra calls are there because plpgsql may switch to a **generic
plan** after five executions of the same statement, built without knowing the
pattern. If one ever chose a sequential scan the function would be fast five
times and then far slower for the rest of the session, which no single-shot
timing can see. At 1,000 rows the first call sequentially scans and the next
twelve use the index — reproducibly, and it does not matter: below the crossover
both plans cost 2.9 ms and the planner is entitled to pick either.

That column reports a count rather than a verdict on purpose. Its first version
compared the twelve calls against the single probe before them and printed
`NO — PLAN CHANGED` at 1,000 rows, which was true and meaningless.

That is established from `pg_stat_user_indexes.idx_scan` read before and after the
call, not from a plan — `EXPLAIN` of a plpgsql function shows a Function Scan and
says nothing about what happens inside it. The first version of that check read
the counter immediately and reported "index not used" at every scale, while the
timings said 0.59 ms for a query a sequential scan does in 267 ms. Statistics are
flushed at most once a second; `pg_stat_force_next_flush()` fixes it. The
measurement was wrong, not the function.

**What the extras cost.** `total_count` is within noise of free, which is what the
migration header argues: the ordering already materialises the whole match set, so
the window adds no scan. The whole function is ~0.1 ms over the bare pattern at
100,000 rows.

**The ceiling.** A needle in ~10% of rows costs 75 ms at 100,000. Keyword search
is fast for what it is for — exact, rare strings — and unremarkable otherwise.

A decoy is planted that only an *unescaped* pattern can match, so a regression in
the escaping doubles the row count and the script refuses to print rather than
reporting a faster wrong query.

### Two things bench-trgm.ts has to do

Both easy to leave out, and both produced confidently wrong numbers first:

- **Drop the index before the baseline arm.** Since 011 landed, `resetSchema`
  builds it, so "before" is no longer the default state of a fresh schema.
- **Never write to the table between the two read arms.** The first version
  measured reads, then ran the write-amplification arm, then measured reads
  again — so the second arm scanned a heap the first never saw (770 KB against
  200 KB, for the same 97 live rows, because `VACUUM` reclaims tuples but only
  returns *trailing* pages). Patching that with a vacuum just moved the bias
  around: a plain `VACUUM` left the bloat, `VACUUM FULL` compacted below the
  baseline, and applying `VACUUM FULL` to both arms rewrote a 60 MB table and
  exhausted the container's 64 MB `/dev/shm` at the largest scale. The script now
  runs three passes over three freshly loaded tables — one for reads, one per
  write arm — so there is nothing to compact and nothing to correct for.

## Testing

Two suites, because one of them cannot reach everything.

```bash
bun test-schema.ts                    # 108 assertions, PGlite, no container
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
asserts 108 properties, including:

- every migration applies, **and applies twice without error**
- the table shape and every index access method match the guide
- the trigram index is **present** under the shipped default, and the flag gates
  it in both directions — a flag whose two states produce the same schema is not
  a flag, and asserting only the on-direction would pass against a migration that
  ignored the flag entirely. When present it is not merely there but reachable:
  with `enable_seqscan` off the planner picks it for a leading-wildcard `ILIKE`,
  which a bare `gin (content)` would not satisfy
- `search_thoughts_keyword` is exact (`upsert_thought` does not match
  `upsert-thought`, `100%` is not a wildcard), counts occurrences, reports a
  `total_count` that agrees with an independent `count(*)`, and returns the right
  rows for a two-character needle the index structurally cannot serve
- **paging is stable when the plan changes underneath it.** The obvious version of
  that test — page six tied rows and look for repeats — passes whether or not the
  `ORDER BY` has a unique final key, because at that size Postgres returns ties in
  the same order every time. The real test alternates `enable_seqscan` between
  pages over 400 tied rows. Measured with the tiebreak removed: 2 repeats, 398 of
  400 covered. With it: 0 and 400
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
