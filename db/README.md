# db — the core schema, as migrations

Phase 1 of the Supabase migration. The Open Brain core schema currently exists as
**prose inside a markdown guide** (`docs/01-getting-started.md`, steps 2.2–2.6),
where nothing can apply it, version it, or check it. This directory is that DDL
made executable.

Nothing here is Supabase-specific. It targets any Postgres 15+ with pgvector 0.8.0 or
later — migration 014 declares HNSW settings that older pgvector rejects.

## Prerequisites

- [Bun](https://bun.sh) 1.4+
- To apply against a real database: Postgres 15+ with the `vector` extension at 0.8.0+
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

`bun test-schema.ts` prints `187 assertions: 187 passed, 0 failed` and `PASS`.
Against a real database, `bun migrate.ts` reports fifteen migrations applied, and
`\d thoughts` shows seven columns and six indexes — five of our own plus the
primary key, which `\d` also lists. Five with `OB1_TRGM_INDEX=off`. `\d
thought_chunks` shows five columns since 013 added `context`.

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
| `013_chunk_context.sql` | `thought_chunks.context` for a situating blurb, carried through both chunk writers. Off by default and measured off — see below | This fork, from Anthropic's Contextual Retrieval |
| `014_filtered_match_thoughts.sql` | `match_thoughts` applies the metadata filter inside the HNSW scan (iterative scan, pgvector 0.8+) instead of after the candidate LIMIT, answers a filter matching at most ~1,000 thoughts exactly with no index walk at all, and honours `match_count` above the default up to a ceiling of 500. The walk's two bounds (`hnsw.max_scan_tuples = 100000`, `hnsw.scan_mem_multiplier = 8`) are seeded once at database level and never overwritten, so `ALTER DATABASE … SET` is the tuning knob and survives every redefinition. Requires pgvector 0.8.0; the migrator refuses 014 up front on an older library | This fork; upstream #417 |
| `015_thought_work_claims.sql` | `thought_work_claims` — one lease per (thought, job key) so parallel workers divide a bulk pass without overlap. `enqueue_thoughts` builds the pool, `claim_thoughts` hands out batches with `FOR UPDATE SKIP LOCKED` under a TTL, expired leases return to the pool (and are marked failed after three), `release_thought` / `release_claims_for_worker` finish or hand back. Terminal rows are the record of the pass, so a re-run does only what is new. `reembed.ts` is the consumer — see below | Ported from `schemas/thought-work-claims` |

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

## Chunk context, and why it is off

Migration 013 adds `thought_chunks.context`: a short generated blurb naming what
a window is about, prepended to it before embedding. It is Anthropic's Contextual
Retrieval, and `OB1_CHUNK_CONTEXT` defaults to **off** because it was measured
rather than adopted.

`evals/eval-contextual.ts` scores it over the 15 documents in the 441-issue
corpus that reach the chunking threshold, using 37 queries that name a document's
subject and ask for a detail living in exactly one window — the query the
technique exists for, and one a title-as-query benchmark cannot pose. Against the
bare windows the server stores today, on the default `qwen3-embedding:4b`:

| arm | MRR | helped | hurt |
| --- | ---: | ---: | ---: |
| bare windows (before change 27) | 0.904 | — | — |
| whole content + windows (**today**) | 0.935 | 3 | 0 |
| a blurb per window (Anthropic) | 0.826 | 1 | 8 |
| a 20-word blurb per window | 0.847 | 0 | 5 |
| one blurb per document | 0.759 | 1 | 13 |

Helped/hurt are paired counts against the baseline row. Against what the server
actually stores today the gap is wider still — 0.935 against 0.867 for the best
contextual arm — because keeping the whole-content vector already helped the
queries a blurb was meant to.

**The mechanism is measured, not inferred.** The same harness compares each query
against the exact window it was written for: prepending a blurb moves that window
*away* from its own query, by 0.034 with a full blurb (lower on 32 of 37) and
0.014 with a 20-word one (27 of 37). The loss tracks blurb length. A fixed-size
vector has less room for the sentence that actually answers.

**It ships as a flag because the sign belongs to the model, not the technique.**
The same harness on `embeddinggemma` — 768 dimensions against 1024, and a real
2048-token ceiling — reports a blurb per window at **+0.041**, helping 5 and
hurting 4. A weaker window vector has more to gain from the extra subject signal
than it loses to dilution. Measure before turning it on.

The column exists whether or not the flag does, because it is the only way to
tell the two kinds of chunk apart: a window is not a substring of its parent
(`chunkContent` joins paragraph segments with a space), so nothing is recoverable
by comparing text. `preflight.ts` counts both and reports a corpus captured under
both settings. Turning the flag on without applying 013 is a **failure** at
startup, not a warning: the functions from 007 and 009 would not select the key.
The blurb still reaches the vector — the server composes the embedded text before
the database sees it — so what is dropped is the record, and with it any way to
tell a contextualized chunk from a bare one afterwards.

The backfill is `reembed.ts` (next section): a pass under a job key of your own
naming re-embeds every thought exactly as a capture would under the current
setting, so flipping the flag and running it brings the whole corpus to one
kind of chunk.

The same applies to the whole-content vector that change 27 restored: a long
thought captured before it still has its head window in `thoughts.embedding`,
and re-capturing — or the same pass — is what upgrades it. Preflight does
**not** report that split, unlike the chunk-context one, because it cannot be
told apart from a legitimate state — a provider that refuses over-length input
falls back to the head window for every long capture, forever, and a check that
nags a correct deployment is worse than no check.

## Re-embedding, and bulk passes in general

Migration 015 adds `thought_work_claims`, ported from
`schemas/thought-work-claims`, and `reembed.ts` is the first thing built on it.

**Why a table.** Any pass over the whole corpus — re-embedding after a model
change, entity extraction, a chunk-context backfill — was one process walking
the table with no record of where it got to, or several processes each
selecting "the next unprocessed rows" and picking the same ones. The table is
the pool and the record: `enqueue_thoughts(key)` adds every thought (or a list
of ids) as `pending` rows under a job key; `claim_thoughts(key, worker, batch,
ttl)` hands out up to `batch` of them with `FOR UPDATE SKIP LOCKED` under a
lease, so two workers claiming at the same moment receive disjoint sets;
`release_thought` marks one `succeeded` or `failed`, and only the holder may;
`release_claims_for_worker` hands a stopping worker's rows straight back. A
worker that dies keeps nothing: when its lease expires the next claim returns
the rows to the pool with the attempt counted, and after three expiries a row
is marked failed rather than handed out again. Terminal rows stay, so running
a pass twice does nothing for the rows already done and picks up the thoughts
captured since.

Three things differ from upstream's version, each with a reason in the
migration header: the database picks the batch (upstream's workers chose
candidates themselves and mostly collided), an expired lease returns to the
pool rather than being deleted (so `attempt_count` and `last_error` survive),
and there is nothing for Supabase — no grants, no RLS, no `NOTIFY pgrst`.

**The job key names the target.** `reembed:qwen3-embedding:4b@1024`, not
`reembed`. Passes with different keys share nothing but the table, so a re-embed
and an extraction pass run at once, and a later re-embed to a third model is a
fresh pool rather than a no-op against the first one's terminal rows.

### `reembed.ts`

```bash
OB1_EMBEDDING_MODEL=bge-m3 bun reembed.ts --url postgres://… --switch-model
bun reembed.ts --url … --status              # where the pass stands
bun reembed.ts --url … --dry-run             # what a run would do; writes nothing
bun reembed.ts --url … --job reembed:x@1024:ctx   # a backfill under the same model
bun reembed.ts --url … --retry-failed        # failed rows back into the pool first
#   --workers N (2)   --batch N (8)   --ttl SECONDS (900)
```

It reads the same variables the server does — model, width, provider URL and
key, chunk sizing, chunk context — through the same function
(`server-portable/embed.ts`, lifted out of the server for exactly this reason),
so what it stores is byte-for-byte what a capture would store. Each thought is
re-embedded and written through `update_thought`, which replaces the chunk rows
wholesale as an edit does. A thought edited between the claim and the write is
re-read and embedded again; one deleted mid-pass is skipped.

**Changing model.** Same width only: `thoughts.embedding` is `vector(N)` and N
is baked into two columns, two HNSW indexes and every function signature, so a
width change is a migration that does not exist yet, and the tool refuses a
configured width that differs from the column's. When the configured model
differs from the one `ob1_config` records, the run needs `--switch-model`, and
the first thing it does is record the new model — from that moment a server
configured for it passes preflight and should be switched. Until the pass
finishes, searches mix vectors from two models; `--status` says how far along
it is, and a re-run adds anything captured meanwhile.

**What the audit log records: almost nothing, on purpose.** Migration 008's
trigger diffs the embedding's *presence*, not its value, so a vector replaced
by a vector is `{}` and `{}` is not an event. A full re-embed therefore does not
double `thought_audit`; only a row that had no vector and gains one is audited,
with `reembed` as the actor and the job key as the session. The claim row is
the per-thought record of the pass. SMD-946 expected one audit row per thought;
`test-live.ts` [9] asserts the count is unchanged, so the expectation is written
down as corrected rather than quietly unmet. Every re-embedded row's
`updated_at` does move, because the row was updated.

**Cost.** Dominated by the provider. The claim itself is flat across the pass —
0.48 ms for the first hundred of a 100,000-row pool and 0.47 ms for the last,
against a 0.15 ms round trip — and the header of 015 has the table showing what
the first draft cost instead (2.90 ms by the end, unchanged by `VACUUM`): the
planner served "any sixteen pending rows" with a sequential scan that stops at
sixteen hits, and the done rows accumulate at the front of the heap. Ordering
by `enqueued_at` over a partial index is what makes the index the cheapest
estimate whatever the statistics say. The lease is stamped per claim, so it has
to outlast the whole batch: the defaults leave close to two minutes per
thought.

**Writing another consumer.** The loop is: `enqueue_thoughts` once, then per
worker `claim_thoughts` → do the work → `release_thought` per row, and
`release_claims_for_worker` on shutdown. Give every process a globally unique
worker id (hostname, pid and a random suffix — `release_claims_for_worker`
matches on it alone). Entity extraction (SMD-947) is the next pass expected to
use it.

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

### bench-hnsw.ts

What a filtered `match_thoughts` returns against an exact scan of the same rows,
and whether the candidate LIMIT above the default count is honoured. Random
64-dimensional vectors with filter tiers planted at 50%, 10%, 1% and 0.1%; the
function as shipped by 001–013, then 014 applied onto the same rows.

```bash
./with-postgres.sh bun bench-hnsw.ts
OB1_BENCH_SCALES=10000,100000 ./with-postgres.sh bun bench-hnsw.ts
./with-postgres.sh bun bench-hnsw.ts --plans     # print the full plans
```

Queries are random vectors, not perturbed copies of a target. A perturbed copy
makes the target the global nearest neighbour, which no post-filter can lose;
the first draft did that and reported perfect recall for a function that returns
nothing at 1%. The exact answer is computed once per query and tier and both
arms are scored against it. Two tiers exist for the scan's failure shape rather
than the filter's: one with fewer matching rows than the candidate budget, and
one matching nothing — under 014 both take the exact branch, which is the
point. Section A also times asking for the function's ceiling (500 rows).
Section C reads the live function body from the catalog, extracts each
filtered branch's statement with its plpgsql variables rewritten as parameters,
and EXPLAINs it under both custom and generic planning on the filter the
function routes to it (the walk on 10%, the exact branch on 1%), because
plpgsql may use either plan. Section D runs the walk's own statement on the
thin and empty filters — which the function never walks for — under a forced
generic plan, to show what the seeded scan bounds do when the walk is reached
on a table large enough to reach it. The headline table is in the header of
`migrations/014_filtered_match_thoughts.sql`; the real-corpus version is
`evals/eval-filtered.ts`.

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

**The ceiling.** A needle in ~10% of rows costs 79 ms at 100,000; one matching
*every* row costs 731 ms, and no index helps there. The second number is the one
an operator needs — it is the worst case any caller can reach, including by
accident with a one-character needle — and an earlier version of this script
printed only the first and called it the ceiling. Keyword search is fast for what
it is for, exact rare strings in single-digit milliseconds, and unremarkable
otherwise.

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
bun test-schema.ts                    # 187 assertions, PGlite, no container
./with-postgres.sh bun test-live.ts   # 98 assertions, real server, throwaway container
```

`with-postgres.sh` starts `pgvector/pgvector:0.8.6-pg16`, exports `DATABASE_URL`, runs
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
- **Filtered recall at scale.** [5b] loads 1,000 random rows through a real HNSW
  index, tags 1% of them, and asserts a filtered `match_thoughts` returns exactly
  what a full scan returns. Under 007 that filter returned almost nothing.
- **Concurrent claims.** [8] holds ten leases open in one transaction while
  another connection claims under a 2 s `lock_timeout` — a wait would fail it —
  then races four workers on four connections through a 600-row pool and
  asserts on ids: none claimed twice, the union exactly the pool. A worker
  "dies" on a 1 s lease and a second worker receives its rows after expiry,
  on their second attempt. PGlite has one connection, so two sequential claims
  there are disjoint whether or not `SKIP LOCKED` does anything.
- **The re-embed, end to end.** [9] runs `reembed.ts` as a subprocess against a
  stub provider: refused without `--switch-model`, then two workers over
  thirty-three rows including a chunked one, a poisoned one and one with no
  vector; asserts every vector, the chunk rows, one audit row rather than
  thirty-two, `ob1_config`, `--status`, a re-run that processes only a later
  capture, and `--retry-failed`.

### What test-schema.ts asserts

`bun test-schema.ts` applies every migration to a real PostgreSQL 17 in-process and
asserts 148 properties, including:

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
- **the filter is applied inside the candidate scan** (migration 014): with sixty
  nearer rows of one kind in front of them, both rows of the filtered kind come
  back — including one reachable only through its chunk — a NULL filter is
  unfiltered, `match_count = 50` returns 50, the ceiling is the one
  `config.mjs` defines, and `pg_proc.proconfig` carries
  `hnsw.iterative_scan=relaxed_order` and nothing else — not the two walk
  bounds, which live on the database so `ALTER DATABASE` tuning is never
  overridden, and not a forced plan mode, which the branch-per-path body made
  unnecessary. A later `CREATE OR REPLACE` that drops the SET clause, or adds a
  bound or a plan mode to the function, fails here rather than in search. The
  exact branch is held to the unfiltered answer on the same rows, and [8c]
  holds the walk branch — reached only above 1,000 matching rows — to an exact
  scan, and [8d] that rows with no vector and no chunks do not count towards
  that threshold; the bounds' seeding is asserted, that re-applying 014 leaves an
  operator's database-level value alone, and that a value set only for the
  session (standing in for `ALTER ROLE`) does not stop the seed
- no `auth.uid()`, `auth.role()`, `service_role` grant, or RLS survives
- a non-object `p_payload` raises rather than silently storing `{}`
- `thought_chunks.context` exists and is nullable, and **both** functions that
  write chunk rows carry it through. Checking only `upsert_thought` would pass
  against a migration that strips context on the first edit
- `thought_work_claims`' state machine: the pool is idempotent to build, an
  unknown id fails the foreign key rather than being skipped, only the holder
  can release and only once, a clean shutdown returns rows without counting an
  attempt, an expired lease is handed out again with the attempt counted and
  is marked failed after three, a deleted thought takes its claims with it,
  and the `CHECK` refuses a claimed row without a lease

One thing this suite deliberately does NOT assert: that a context survives a
capture, an edit and a payload that omits it. Writing chunk rows through the
4-argument `upsert_thought` crashes PGlite's WASM build in this process —
`received invalid response: 0` when the payload is bound as a parameter, `Out of
bounds memory access` when it is inlined — and it reproduces with migrations
001-012 applied and no 013, at any position in the file, on a second instance as
well as the shared one. So it is the harness rather than the migration, and the
round trip is asserted in `test-live.ts` [7] against a real server instead.

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
  in WASM) *and* a real `pgvector/pgvector:0.8.6-pg16` container, but neither is RDS or
  Neon. Run `--dry-run` first against the real target.
- **HNSW index build time is not represented.** On an empty table it is instant; on
  a populated one it is not. Build it after a bulk load, not before.
- **Data migration is not covered here.** These migrations create the schema. Moving
  rows is `pg_dump --data-only`, plus `bun reembed.ts --switch-model` if the model
  family changes at the same width.

## Related

- `../FORK.md` — what this fork changes and why
- `../server-portable/` — the runtime-neutral server (Phase 3)
- `docs/01-getting-started.md` — the original prose the schema was extracted from
