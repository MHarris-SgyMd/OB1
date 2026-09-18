# FORK.md — what diverges from upstream, and why

This is a fork of [NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1)
(Open Brain). It is **not** a hard fork. Upstream is alive and we intend to keep
taking from it; this file exists so the delta stays small, legible, and easy to
rebase.

**What this fork is for:** running Open Brain without Supabase. Upstream assumes a
supabase.com project — hosted Postgres, an Edge Function, SQL pasted into a
dashboard, `supabase secrets set`. This fork runs the same six MCP tools and the
same schema on infrastructure you control.

There is **no Supabase project to migrate from** here; this was built as a
greenfield alternative, not a data migration. Nothing in this fork moves rows out
of Supabase, and there is no cutover step. **Start at [`SETUP.md`](SETUP.md).**

The upstream Supabase path still works and is untouched — `server/` is the
original Deno Edge Function build. Read this file before changing anything there.

---

## The pin

| | |
| --- | --- |
| Upstream baseline | `9543c29a3e44a210ce278392b9fac11248997461` |
| Upstream date | 2026-08-30 |
| Git tag | `upstream-pin-9543c29` |
| Patch branch | `siggymd/fork-baseline` |

Upstream publishes **no releases and no tags** — there is no stable version to
track, and the setup guide has users `curl` `main` straight into production. The
tag above is our substitute for a release: it is the exact upstream tree our
patches apply to.

**Never deploy from upstream `main`.** Deploy from this branch.

### Deploying

For a non-Supabase deployment, see [`SETUP.md`](SETUP.md) — that is the intended
path. The rest of this section covers deploying the original Supabase Edge
Function build, which is still supported.

The upstream guide tells you to fetch `server/index.ts` from `main`, unpinned:

```bash
# DON'T — this is whatever is on upstream main at that moment
curl -o supabase/functions/open-brain-mcp/index.ts \
  https://raw.githubusercontent.com/NateBJones-Projects/OB1/main/server/index.ts
```

Deploy from a checkout of this fork instead:

```bash
git checkout siggymd/fork-baseline
cp server/index.ts server/deno.json supabase/functions/open-brain-mcp/
supabase functions deploy open-brain-mcp --no-verify-jwt
```

### Required migration

`db/migrations/004_upsert_thought_with_embedding.sql` must be applied for
the atomic capture path. Without it `capture_thought` still works — it falls back
to the old two-step write and logs a warning — but you keep the failure mode the
migration exists to remove. Apply the whole set with `cd db && bun migrate.ts`.

---

## What we changed

Eighty-eight numbered changes on top of the pin. Seven fix defects found in an
audit of the pinned tree; the rest are migration work — a runtime-neutral build
(Phase 3), the core schema as applicable migrations (Phase 1), and a swappable
data layer (Phase 2). Nine (changes 31, 53, 55, 59, 79, 82, 86, 87 and 88) ship no runtime change at
all: each is a measurement that decided against building something.

The table below covers changes 1–17, which landed before this file grew prose
sections. Changes **18–88 are the numbered `###` sections** further down, which is
where the reasoning for anything recent lives.

| # | Commit | What | Upstream status |
| --- | --- | --- | --- |
| 1 | `[fork] server: align stateless test…` | The only core-server test asserted HTTP 401 for auth failure; the server has returned HTTP 200 + a JSON-RPC `-32001` envelope since upstream PR #243 (2026-05-22). The test passed while encoding the opposite of production. | **Unfiled** |
| 2 | `[fork] server: pin test deps…` | `deno.json` pinned exact; `package.json` used carets with no lockfile, so tests ran against different library versions than the deployed function. | **Unfiled** |
| 3 | `[fork] server: paginate thought_stats…` | Reported a corpus-wide total beside aggregates computed from only the first 1000-row Supabase page. | [Issue #470](https://github.com/NateBJones-Projects/OB1/issues/470), open |
| 4 | `[fork] server: stop extractMetadata swallowing…` | No `r.ok` check; an expired API key produced a "successful" capture tagged `uncategorized`. | **Unfiled** |
| 5 | `[fork] server: …capture atomically` | Row committed first, embedding attached by a second call. A failure between left a thought stored but invisible to semantic search. | **Unfiled** ([PR #122](https://github.com/NateBJones-Projects/OB1/pull/122) closed as out of scope) |
| 6 | `[fork] docs: make fingerprint setup re-runnable…` | Core setup and `recipes/content-fingerprint-dedup` shipped the same unguarded DDL, so following both in order errored. Plus three links to paths that do not exist. | **Unfiled** |
| 7 | `[fork] ci: run the tests…` | Upstream invokes no test from any workflow. Adds fork CI and a repo-wide consistency checker; fixes the 14 metadata violations it found. | **Unfiled** |
| 8 | `[fork] server-portable: runtime-neutral build` | New parallel `server-portable/` targeting Bun, Node, Cloudflare Workers and Deno Deploy. Two changes from `server/index.ts`: no Deno globals, and env read lazily. Its test suite **imports the real server**, so the drift class the guards detect cannot occur. | **Unfiled** |
| 9 | `[fork] db: core schema as applicable migrations` | The core schema existed only as prose in `docs/01-getting-started.md`. `db/migrations/` makes it executable, idempotent and versioned, with the Supabase-isms removed and a runner. Verified against real PostgreSQL 17 + pgvector via PGlite — 49 assertions, no daemon needed. | **Unfiled** |
| 10 | `[fork] db: live suite against a real Postgres server` | PGlite cannot reach the migration runner, driver-level jsonb binding, or the planner. Adds `test-live.ts` plus `with-postgres.sh` (podman first) and a CI service container. | **Unfiled** |
| 11 | `[fork] server-portable: swappable data layer` | Phase 2. Every DB call goes through `ThoughtStore`; `store-sql.ts` talks to Postgres directly via `Bun.sql`, `store-postgrest.ts` keeps the old path for cutover and for Workers. Verified end to end over MCP with no Supabase present. | **Unfiled** |
| 12 | `[fork] deploy: preflight gate and a full stack with no Supabase` | Phase 4. A misconfigured server used to start, answer the handshake, pass every liveness probe and fail on first real use. `preflight.ts` gates the container entrypoint; `deploy/compose.yaml` runs Postgres + migrations + server with no Supabase CLI; `smoke.sh` verifies any deployment over MCP. | **Unfiled** |
| 13 | `[fork] compat: a supabase-js-shaped client that speaks SQL` | 54 non-core files call PostgREST across 33k lines. Rather than rewrite them, `compat/supabase-sql` reimplements the ~20 methods they use, so 24 migrated by changing one import. Refuses resource embedding, nested `.or()`, type-only imports and `.auth`/`.storage` rather than faking them. | **Unfiled** |
| 14 | `[fork] server-portable: named, scoped, hashed access keys` | Replaced one shared plaintext key with `name:scope:sha256` entries, timing-safe comparison, and independent revocation. A read-scoped key does not merely fail to write — `capture_thought` is never registered for it, so it is absent from `tools/list`. `keygen.ts` mints them. Legacy `MCP_ACCESS_KEY` still works, with a preflight warning. | **Unfiled** |
| 15 | `[fork] db + server: the embedding contract is configurable` | `vector(1536)` was hard-coded in four migrations. Migrations are now templates, `OB1_EMBEDDING_DIM`/`OB1_EMBEDDING_MODEL` choose the pair, the choice is recorded in `ob1_config`, and preflight fails on a mismatch. Catches `text-embedding-3-large` at 3072, which exceeds pgvector's HNSW limit and would silently make every search a full scan. | **Unfiled** |
| 16 | `[fork] server: the model provider is configurable, including fully local` | Both per-capture calls (embedding, metadata extraction) now go to `OB1_LLM_BASE_URL` with `OB1_EMBEDDING_MODEL` and `OB1_METADATA_MODEL`; the credential is omitted for a loopback endpoint. A `local-models` compose profile runs Ollama so nothing about a captured thought leaves the host. | **Unfiled** |
| 17 | `[fork] evals: choose the local models by measurement` | The local defaults were picked by size. `evals/` benchmarks retrieval and extraction against real Ollama; `nomic-embed-text` placed 5th of 7 and `llama3.2` reproduced its production faults. Defaults are now `embeddinggemma` + `qwen2.5:7b`. | **Unfiled** |

### Files we own

Rebase conflicts will only ever come from these:

```
server/index.ts                  # fixes 3, 4, 5
server/package.json              # fix 2
server/bun.lock                  # fix 2
server/test-stateless.mjs        # fix 1
server/test-stats-pagination.mjs # fix 3   (new file)
server/test-capture-atomicity.mjs# fix 5   (new file)
db/migrations/                   # fix 9   (moved here from server/ in fix 9)
.github/metadata.schema.json     # fix 7   (3 additive optional fields)
.github/workflows/fork-checks.yml# fix 7   (new file)
scripts/check-fork-consistency.mjs # fix 7 (new file)
scripts/mechanism-yield.mjs      # SMD-1711 (new file — review-pass yield report, not a gate); window and attribution fixed SMD-1728
server-portable/                 # fix 8   (new dir — parallel, does not touch server/)
db/                              # fix 9   (new dir — schema, runner, tests)
deploy/                          # fix 12  (new dir — compose stack, smoke test)
compat/supabase-sql/             # fix 13  (new dir — the shim)
SETUP.md                         # fix 15  (new file — the greenfield setup guide)
server-portable/auth.ts          # fix 14  (new file)
server-portable/keygen.ts        # fix 14  (new file)
db/config.mjs                    # fix 15  (new file)
db/migrations/006_*.sql          # fix 15  (new file)
server-portable/test-local-provider.ts # fix 16 (new file)
evals/                           # fix 17  (new dir — retrieval + extraction benchmarks)
db/config.d.mts                  # fix 19  (new file — types for config.mjs; .d.mts, not .d.ts)
db/migrations/007_*.sql          # fix 18  (new file — thought_chunks)
db/migrations/008_*.sql          # fix 21  (new file — thought_audit)
db/migrations/009_*.sql          # fix 22  (new file — update/delete)
db/migrations/010_*.sql          # fix 23  (new file — agent identity)
server-portable/agents.ts        # fix 23  (new file — resolve + cache the agent id)
server-portable/test-agents.ts   # fix 23  (new file)
db/test-upgrade.ts               # fix 23  (new file — migrations applied incrementally)
db/migrations/011_*.sql          # fix 24  (new file — trigram index on content)
db/bench-trgm.ts                 # fix 24  (new file — measures what 011 costs and buys)
evals/build-linear-corpus.ts     # fix 25  (new file — rebuilds the real corpus)
evals/env.ts                     # fix 25  (new file — .env credentials, never printed)
server-portable/test-update-delete.ts # fix 22 (new file)
server-portable/test-audit.ts    # fix 21  (new file)
db/test-support.ts               # fix 20  (new file — schema lifecycle, assert)
db/ci-parity.sh                  # fix 20  (new file — CI's order, one shared Postgres)
server-portable/chunk.ts         # fix 18  (new file)
server-portable/thoughts.ts      # fix 20  (new file — pure rules, lifted for testing)
server-portable/test-support.ts  # fix 20  (new file — the MCP client)
server-portable/test-thoughts.ts # fix 20  (new file)
db/migrations/012_*.sql          # fix 26  (new file — search_thoughts_keyword)
db/bench-keyword.ts              # fix 26  (new file — index reach and plan-cache probe)
evals/eval-keyword.ts            # fix 26  (new file — where vector search misses)
db/migrations/013_*.sql          # fix 27  (new file — thought_chunks.context)
evals/eval-contextual.ts         # fix 27  (new file — contextual retrieval, measured)
db/migrations/014_*.sql          # fix 28  (new file — the filter inside the scan)
db/bench-hnsw.ts                 # fix 28  (new file — filtered recall against an exact scan)
evals/eval-filtered.ts           # fix 28  (new file — the same, on the real corpus)
db/migrations/015_*.sql          # fix 29  (new file — thought_work_claims)
db/reembed.ts                    # fix 29  (new file — the parallel, resumable re-embed)
db/migrations/016_*.sql          # fix 30  (new file — entities, mentions, edges, the trigger)
db/extract-entities.ts           # fix 30  (new file — the extraction worker)
server-portable/entities.ts      # fix 30  (new file — the prompt and the parsing rules)
evals/eval-entities.ts           # fix 30  (new file — labelled precision/recall, and the corpus run)
evals/eval-graphrag.ts           # fix 31  (new file — graph retrieval against the vector baseline)
evals/graphrag-questions.json    # fix 31  (new file — the multi-hop question set)
evals/linear-corpus.ts           # fix 31  (new file — the corpus/dump contract eval-entities and eval-graphrag share)
db/migrations/017_*.sql          # fix 32  (new file — search_thoughts_hybrid and extract_search_needles)
db/bench-hybrid.ts               # fix 32  (new file — both indexes reached through the fused function)
evals/eval-hybrid.ts             # fix 32  (new file — four query sets, the arms and the variants)
evals/identifiers.ts             # fix 32  (new file — the identifier rule eval-keyword and eval-hybrid share)
db/migrations/018_*.sql          # fix 33  (new file — update_thought: an unchanged edit is never a duplicate)
db/migrations/019_*.sql          # fix 36  (new file — match_thoughts reaches the index at the shipped width; ROWS on both search functions)
db/bench-plan.ts                 # fix 36  (new file — the unfiltered plan at the real width)
db/migrations/020_*.sql          # fix 37  (new file — match_thoughts blends recency after the candidate scan; search_thoughts_hybrid carries the weight)
evals/eval-recency.ts            # fix 37  (new file — what a weight costs on the corpus, and the window against an exact oracle)
db/migrations/021_*.sql          # fix 38  (new file — thoughts.embedding_model: a vector carries the model that produced it; both writers carry it)
db/migrations/022_*.sql          # fix 40  (new file — a re-capture's windows stay while the label vouches for them; the 3-argument upsert_thought redefined)
db/migrations/023_*.sql          # fix 41  (new file — 003's missing backfill: every legacy singleton, and the oldest of each twin group, takes its fingerprint once; ob1_fp_backfill_idx)
server-portable/embed.ts         # fix 29  (new file — the capture's embedding path, lifted from index.ts)
server-portable/test-chunk-context.ts # fix 27 (new file)
evals/lib.ts                     # fix 20  (new file — shared embedding path)
evals/bench.ts                   # fix 20  (new file — compare a model to the record)
evals/baselines.json             # fix 20  (new file — recorded results)
.dockerignore                    # fix 20  (new file — root build context)
scripts/migrate-to-sql-shim.mjs  # fix 13  (new file — the codemod); change 74 (the runtime line, the KEEP list); change 77 (the embed blockers are the shim's refusals; agent-memory-api kept)
<23 recipe/integration files>    # fix 13  (one import line each; revert with the codemod; 24 until change 74 put the local-brain client back)
<7 extension servers>            # change 64 (keys through extensions/_shared/auth.ts; the tools that write gated)
extensions/_shared/auth.ts       # change 64 (new file — server-portable/auth.ts byte for byte; the test holds them equal)
extensions/test-auth.ts          # change 64 (new file — the seven servers under scoped keys); change 67 widened it to every vendored server; change 74 starts every server on the shim under bun
extensions/package.json          # change 64 (new file — test deps pinned to the extensions' deno.json)
extensions/bun.lock              # change 64 (new file)
<17 vendored files>              # change 67 (thirteen servers and samples onto scoped keys through _shared/auth.ts; four onto a timing-safe compare, one through the same module)
recipes/_shared/auth.ts          # change 67 (new file — server-portable/auth.ts byte for byte)
recipes/editorial-policy/_shared/auth.ts            # change 67 (new file — the same)
recipes/edge-function-cost-optimization/examples/_shared/auth.ts  # change 67 (new file — the same)
integrations/_shared/auth.ts     # change 67 (new file — the same)
integrations/consolidation-workers/_shared/auth.ts  # change 67 (new file — the same, beside the workers' existing _shared/)
<9 vendored files>               # change 69 (a thought's content and vector through update_thought / the 3-argument upsert_thought; the enhanced columns beside them)
extensions/test-writes.ts        # change 69 (new file — every vendored writer driven against Postgres, its row against update_thought's)
<8 vendored files>               # change 71 (a captured thought through the 3-argument upsert_thought instead of a raw INSERT; three more say they bypass it)
compat/supabase-sql/index.ts     # change 73 (PostgREST's JSON-path column in filters and order; a timestamp back as a string — the bio worker runs on the fork); change 77 (the catalog: arrays by declared type, .not(), one-hop embedding, PostgrestError, one pool per URL)
compat/deno-on-bun.ts            # change 74 (new file — Deno's two globals on Bun, for the servers on the shim)
<16 vendored files>              # change 74 (one import line each — compat/deno-on-bun.ts first; four swap Supabase's jsr: types import for it)
extensions/test-tools.ts         # change 77 (new file — every tool of the five extension servers on the shim, driven against Postgres with their schemas)
db/test-bench-reuse.ts           # change 76 (new file — the kept bench corpus's oracle cache held to the computation, on one index)
db/bench-oracle.ts               # change 76 (new file — the cache's pure part: what of a marker's entry a run may trust; test-schema [37])
db/migrations/039_*.sql          # change 81 (new file — the two HNSW indexes over embedding::halfvec under their names; match_thoughts' walk branches order by the cast)
evals/eval-quant.ts              # change 81 (new file — vector, halfvec and binary-with-rerank measured on real vectors at the shipped width; test-schema [38], test-upgrade [16])
<4 vendored MCP servers, 1 sample> # change 78 (a McpServer built per request — per session in the cost recipe's after sample — in place of one shared and connect()ed to a fresh transport each time)
<17 pin sites, 3 lockfiles>      # change 83 (@hono/mcp 0.1.1 → 0.1.5: the transport lets go of each POST it has answered; the after sample's sweep closes the transports it drops)
<19 pin sites, 3 lockfiles, 15 servers, 20 SDK importers> # change 84 (SDK 1.30.0, @hono/mcp 0.3.2, hono 4.13.8, zod 4.6.5 together; the Accept patches removed; an @ts-types pragma on every SDK import so Deno types it)
docs/01-getting-started.md       # fix 6
recipes/content-fingerprint-dedup/README.md  # fix 6
recipes/email-history-import/README.md       # fix 6
recipes/gmail-smart-pull/README.md           # fix 6
dashboards/open-brain-dashboard-next/README.md # fix 6
integrations/open-brain-rest/metadata.json   # fix 7
recipes/world-model-diagnostic-activation/metadata.json # fix 7
skills/world-model-diagnostic/metadata.json  # fix 7
```

`recipes/lint-sweep`, `recipes/weekly-digest` and `extensions/professional-crm`
are deliberately **unmodified** — their violations were resolved by widening
`.github/metadata.schema.json` instead, so the contributor credit and env-var
manifests they carry survive a rebase untouched.

`server/index.ts` is the only file where a conflict is likely to need thought.
It has changed **9 times in upstream's entire history** and not since June.

### Drift guards

The Node test suites cannot import `server/index.ts` (it reads `Deno.env` at
module scope and imports from `jsr:`), so they mirror its logic. A silent mirror
is exactly how fix 1's bug happened, so **every suite under `server/` opens with a
drift guard** that reads `index.ts` as text and fails if the behaviour it asserts
is no longer what the server implements. Each guard was verified against the
pre-fix source.

If you change `server/index.ts`, expect the guards to tell you. That is the point.

`server-portable/` needs none of this. Its env is read lazily, so `test-server.ts`
imports the server and asserts against the running handler — there is nothing to
drift from. That is the strongest argument for eventually making it the primary
build.

### 18. Long captures stay searchable — `thought_chunks`

A capture longer than the provider's per-request batch was embedded only in part.
The text was stored whole and `fetch` returned it whole, but `search_thoughts`
could not find the note by anything said in its second half — silently, with no
error on either the write or the search. Measured: a 4000-token note whose
conclusion is in its final sentence was retrieved at chance.

Migration 007 adds `thought_chunks`, and `capture_thought` now splits content
above `OB1_CHUNK_TOKENS` (1200) into overlapping windows and embeds each. Notes:

- **`thoughts` is untouched** — no new columns, so the core guard rail holds — and
  existing rows keep working with no re-embedding. Chunks are extra evidence, never
  a replacement.
- **Short thoughts write no chunk rows at all.** Both corpora measured in `evals/`
  average under 500 tokens, so the common case pays nothing.
- For chunked content `thoughts.embedding` became the *first chunk's* vector, not
  the whole content's, because embedding the whole thing would be an over-batch
  request that Ollama answers by silently truncating. **Superseded by change 27**,
  which measured the ceiling instead of assuming it and found the configured
  default reads a 15,812-character document whole. It is the whole-content vector
  again, best-effort, with the head window as the fallback.
- `match_thoughts` searches both tables and deduplicates to one row per thought,
  scored by its best evidence. Each side takes its own indexed top-K rather than
  scoring every row, because the obvious formulation cannot use an HNSW index.
- `ON DELETE CASCADE`, so a deleted thought cannot leave orphan vectors still
  answering searches.

`server-portable/test-chunking.ts` asserts the case that used to fail, with a stub
provider that *refuses* over-batch input rather than truncating it, so removing
chunking fails loudly instead of quietly regressing. Measured for real in
`evals/eval-chunking-e2e.ts` — the actual server against actual Ollama and
Postgres — where documents of ~4.6K and ~9.2K tokens go from 1/4 (chance) to 4/4.

Two gaps this closed on the way. The PostgREST store had **no test at all**, so
its RPC argument shapes were unverified until chunking added a fourth one;
`test-store-postgrest.ts` now covers it using `compat/supabase-sql` as the
fixture. That immediately found a real bug in the shim: a numeric array bound to a
`vector` parameter became a Postgres array literal, which pgvector rejects, so
**every** `.rpc()` call passing an embedding through the shim was broken.

---

## Checking CI on this fork

Two traps, both of which cost real time.

**`gh` defaults to the parent repo.** In a fork, `gh run list` resolves to
`NateBJones-Projects/OB1` and reports nothing for our branches, which reads exactly
like "no runs" rather than "wrong repository". Fix it once per clone:

```bash
gh repo set-default MHarris-SgyMd/OB1
gh run list --branch siggymd/db-migrations          # now the fork
```

Eight commits went out on a red CI because of this. Only `Fork Checks` ever runs
here; the other eleven inherited workflows are PR- and issue-triggered against
upstream and never fire on a branch push.

**Running the suites individually cannot catch state leaking between them.**
`db/with-postgres.sh` starts a fresh container per invocation, so anything one
suite leaves behind is invisible; CI reuses one Postgres service across every
step. That difference hid a real failure: `DROP TABLE thoughts CASCADE` removes the
foreign-key constraint on `thought_chunks`, not the table, so a stale chunk table
survived at the previous suite's vector width and the next suite died on a
dimension mismatch. Every suite now drops `thought_chunks` first, and

```bash
./db/ci-parity.sh
```

runs them all in CI's order against one shared database. Use it before pushing.

### 19. Default embedding model → `qwen3-embedding:4b` at 1024 dimensions

Measured best on a real corpus: **0.903 MRR against `embeddinggemma`'s 0.873 over
441** real issues with full descriptions and comment threads, and the only local
model that embeds a long capture whole. Costs ~5x the embedding latency and 2.5 GB.

Those figures replace 0.933/0.914 and "~3x", measured over 97 issues that had been
silently truncated to ~500 characters at ingestion. The ranking survived and the
ranking survived; the latency multiple did not — see fix 25.

**This is a breaking change for an existing install.** The width moves from 768 to
1024, so it needs a schema migration and a re-embed of every row. `preflight.ts`
refuses to serve against a mismatch rather than letting search quietly degrade, so
an install that skips this fails loudly. Staying put is a supported choice — set
`OB1_EMBEDDING_MODEL` and `OB1_EMBEDDING_DIM` explicitly and nothing changes.

Two things had to be built first, and the second is why this was not a one-line
change:

- **Truncation is now automatic for known-MRL models.** `qwen3-embedding:4b` is
  2560 dimensions natively, above pgvector's 2000 HNSW ceiling, so the default
  would otherwise refuse every capture. `OB1_EMBEDDING_DIMENSIONS` still defaults
  to off for anything not in `MRL_MODELS` or of unknown native width — the opt-in
  exists to stop silent truncation of models never trained for it, and that
  property is unchanged.
- **Asymmetric prompting.** Qwen3-Embedding is trained to see queries and
  documents differently, and the server had one code path for both. Prompted it
  scores 0.933; bare, **0.860** — worse than the model it replaces. Switching the
  default without this would have been a regression dressed as an upgrade.
  Both numbers are from the 97-issue corpus and this pair has not been re-run on
  the rebuilt one; the ordering is not in question, the absolute values are old.
  Templates live in `db/config.mjs` keyed by model, so changing model changes
  prompt and preflight's existing model-change check already covers it.
  `embeddinggemma` gains 0.002 from its own format and nomic's prefixes measurably
  hurt, so neither is listed — the table is per-model, not global.

`scripts/check-fork-consistency.mjs` now fails if `deploy/compose.yaml`'s
`${VAR:-fallback}` values drift from `db/config.mjs`. Compose substitutes those
before the process starts, so a stale fallback silently overrides the code default
rather than deferring to it.

### Considered and not built: a second retrieval tier

An LLM reranker over the embedding search's top-5, escalated only when the cosine
margin says tier 1 is unsure. Measured well when tier 1 was `embeddinggemma`:
86% → 91% Recall@1 on 97 real issues, five queries fixed, **none broken**.

Re-measured after the default moved to `qwen3-embedding:4b@1024`, it no longer
justifies itself. Tier 1 alone now reaches 90%, the reranker adds three points
rather than five, and it is no longer regression-free — against a stronger embedder
it demotes a correct answer, because it sometimes knows less than the embedder
does. Worse, `qwen2.5:7b` in that role takes Recall@1 *down* two points, so the
feature is only correct with an 18 GB model resident alongside the embedder.

Three points for a 15x latency increase and a footgun is not a default. The
harnesses stay (`evals/eval-cascade.ts`), so a corpus that behaves differently can
re-derive it. Full numbers in `evals/README.md`.

### A second vector store beside Postgres: the shape, and the bar it would have to clear

Every retrieval change since the pin has been made inside Postgres — the filter
pushed into the scan (SMD-968, migration 014), the keyword arm (migration 012),
contextual chunks (migration 007), hybrid ranking (SMD-958, migration 017),
GraphRAG measured and declined (change 31). The single transactional store was
argued for and never weighed against the alternative it rules out: a dedicated
vector database — Qdrant, Weaviate, LanceDB, or pgvectorscale's DiskANN inside
this same Postgres — holding the vectors while Postgres keeps the rows. Change
11's "swappable data layer" swaps *how* the server reaches Postgres (SQL or
PostgREST); it does not swap *what* holds the vectors. This section writes that
alternative down.

It is written **before** SMD-1037's numbers exist, on purpose. SMD-1037 measures
pgvector against a dedicated store and a different in-engine index on this
corpus; SMD-1038 (this section) fixes, in advance, the shape a second store would
take here and the bar its numbers would have to clear — so the decision is made
against a design and a pre-registered threshold rather than under the pull of one
benchmark. It is not "not built" — that verdict is SMD-1037's to reach; it is the
contract SMD-1037's result is read against.

**The seam is `ThoughtStore` (`server-portable/store.ts`), and only some of it
moves.** A second store would own the vector-search reads and the vector writes,
nothing else:

- **Moves:** `matchThoughts` (the top-k vector scan, including the metadata
  filter migration 014 pushed *into* the scan), the vector arm of
  `hybridThoughts` (migration 017), and the vector writes inside
  `captureThought`, `updateThought` and `deleteThought` — the `embedding` on
  the row and the per-window vectors in `thought_chunks` (migration 007).
  Moving the vector arm out also moves 017's fusion out of SQL: what is one
  statement over one snapshot today becomes an external vector query merged
  with the Postgres keyword arm in application code.
- **Stays in Postgres:** `keywordThoughts` (a match over `thoughts.content`,
  migration 012), `getThought` / `listThoughts` / `countThoughts` /
  `statsSummary` / `pageThoughtMeta`, `resolveAgent` and the work-claim tables
  (SMD-946), `traceProvenance` / `findDerivatives` / `supersededAmong` /
  `listSupersessionProposals` (migrations 025/029), `logSearch` / `logAction`
  (the query log, SMD-1295, migration 034), and every non-vector table:
  `thought_audit`, `thought_work_claims`, the entity tables, `ob1_config`.

The split is the point: the store holds one column of one table plus the
vectors of one child table, and everything that makes a thought *usable* — its
text, its history, its provenance, its ACL, its filters — stays in the engine
that already serves them in one snapshot.

**Consistency — every case, with a handling or an owned gap.** Today a capture is
one transaction: `upsert_thought` writes the row and replaces its chunks
together (SMD-1175, migration 022), so a reader never sees a thought
without its vector or a vector without its thought. Split across two stores,
one write lands first.

- *Capture atomicity.* Postgres is the source of truth and commits first; the
  vector write follows and is retried to completion (an outbox row in the same
  Postgres transaction, drained by a worker in per-thought order — or carrying
  the row's version so a stale write loses to a newer one — is the standard
  shape). Between the two, a reader can fetch the thought by id and
  keyword-match it, but the vector search cannot yet return it. Accepted gap:
  vector visibility lags row visibility by the drain interval; the row is
  never orphaned because the outbox row shares its transaction. The reverse
  orphan — a vector for a row that rolled back — cannot occur, because the
  vector write is keyed off a committed outbox row.
- *`updateThought` / `deleteThought`.* A content edit re-embeds and must
  overwrite the external vector; a delete must remove it. In Postgres today
  the chunk vectors are `ON DELETE CASCADE` (migration 007) — a foreign key
  does this for free. A second store has no such key: the delete becomes a
  second, non-transactional call, and a crash between them leaves a vector
  whose row is gone (a search hit that resolves to nothing). Handling: the
  same outbox drains deletes and re-embeds; and because content is always read
  from Postgres — in the two-store shape the vector store returns ids and
  Postgres resolves the rows — a stale vector id resolves to no row and drops
  the hit rather than returning wrong content. The one way a vector outlives
  its row for good is a delete overtaken by a lagging re-embed of the same id
  — which is exactly what the per-thought ordering above rules out; without it
  the orphan can hold a top-k slot that resolves to nothing, so the query
  returns short (the bounded shape change 28 already accepts), never wrong.
  The reader is never lied to, only under-served until the drain catches up.
- *Bulk re-embed (SMD-946).* A model change rebuilds every vector. Against an
  external index this is an index rebuild in the second store, not just an
  `UPDATE` — and `preflight` (SMD-1024), which reads claim counts to know a
  re-embed is unfinished, would have to check the *two* stores agree: same vector
  count, same `embedding_model`. A store whose index build time is a large
  multiple of the `UPDATE` makes a model change a maintenance window rather than
  a background pass — which is itself one of the adoption-bar failure modes below.
- *Metadata filters.* This is the migration-014 hazard restated. Filters live in
  Postgres columns; a second store must either mirror them as payload (and now
  two systems must agree on every metadata write) or apply them after its vector
  LIMIT — which is *exactly* the post-LIMIT filter that silently lost recall and
  cost this fork migration 014. Any second store that filters after the fact
  reintroduces the bug migration 014 fixed; only a store that filters *inside* its
  scan, with the payload kept in sync on every write, is admissible.
- *Cloudflare Workers.* They reach Postgres through PostgREST today
  (`store-postgrest.ts`). A second store means a second client and a second set
  of credentials in the Worker, and the atomicity story above has to hold across
  a network the Worker does not control. Accepted cost: the Worker path carries
  two backends or does not get the second store at all.

**The bar, in SMD-1037's own terms.** A second store is added only if SMD-1037
reports at least one of:

1. a **recall gap against exact** at a filter tier the product actually uses
   (SMD-1037's filter tiers span 36% down to 0.7% selectivity) — pgvector
   materially below the comparator where a real deployment filters, not in the
   abstract;
2. a **latency gap** (p95) at a row count **within a stated multiple of the
   largest real deployment** — a crossover a real corpus reaches, not a
   synthetic-bench extreme (SMD-1018 seeds to 10M) no deployment approaches —
   and measured end to end: in the two-store shape every vector read is an
   external ANN query *plus* a Postgres resolve of the returned ids to rows, so
   the store's own scan time is not the number that decides it;
3. an **index build time** for a re-embed so much worse in pgvector that a model
   change is impractical — the SMD-946 rebuild turning from a background pass
   into a window.

What is pre-registered here is the three dimensions and their direction, not a
mood. The magnitudes — how many recall points count as "material", the latency
multiple, the build-time ceiling — are pinned to SMD-1037's *baseline* (pgvector's
own recall and latency at each tier and size) and fixed before its comparator
numbers are read, so "material" is a delta against a number set in advance, never
a judgment reached once the comparator's result is in view. That is the whole
point of writing this before the measurement.

And, written down before the numbers so it cannot be argued away after: what does
**not** justify a second store —

- an **unfiltered-only** win. Almost every vendor benchmark is unfiltered top-k;
  this product filters. A win that appears only without a filter is measuring a
  query the product rarely runs.
- a win at a **row count no deployment approaches**. If the crossover is past the
  largest corpus in sight, it is a future ticket, not a present one.
- a win that **disappears once the hybrid round trip is counted**. In Postgres a
  hybrid query is one statement over one snapshot; across two stores it is two
  round trips and a merge (SMD-1037 counts these). A vector-only win that a
  two-store hybrid gives back at the merge is not a win.

**The Postgres-internal ladder comes first.** Before a second engine, the same
question is asked of a different index in the *same* engine, where none of the
consistency cost above applies: pgvectorscale's StreamingDiskANN in place of
HNSW; partitioning `thoughts` / `thought_chunks` by agent or by month so a
scan touches less; a covering index over the filter columns so the filtered
path (SMD-968) reads fewer heap pages. The fork is already on this ladder:
SMD-1463 (in flight) gates 014's GIN routing count behind a match estimate,
cutting the filtered path's per-call cost at ten million rows before any
second engine is weighed. SMD-1037 measures one in-engine comparator alongside
the external one precisely to place the crossover on this ladder — a second
store wins only where the in-engine rungs have run out, not merely where
HNSW-in-Postgres loses to DiskANN-anywhere.

**Guardrails in view.** A second store must not drop the `thoughts.embedding`
column: the SQL/PostgREST fallback and every migration that reads it depend on it
staying, and it remains the source of truth a rebuild re-derives the external
index from. Candidate stores carry different licences (Qdrant Apache-2.0,
Weaviate BSD-3, LanceDB Apache-2.0, pgvectorscale PostgreSQL-licensed); the
fork's FSL-1.1-MIT terms stay in view when one is named, and an in-engine index
avoids the question entirely.

SMD-1037 measures. This section decides what the measurement is allowed to
change: nothing, unless a bar above is cleared, and then only as a scoped
implementation issue with its own tests and rollback — never by dropping the
column the rest of the fork stands on.

### The recurring defect in this fork: a value defined twice

Worth naming, because it has now caused five separate failures and every one
looked different on the surface:

| what was duplicated | how it failed |
| --- | --- |
| embedding prompts (harness vs `config.mjs`) | benchmark measured an instruction the server never sends |
| truncation rule (`index.ts`, `preflight.ts`, `config.mjs`) | container crashlooped on a valid default |
| schema reset across 9 test files | stale `thought_chunks` broke a later suite in CI only |
| compose `${VAR:-fallback}` vs `config.mjs` | a stale fallback would silently override the code default |
| **preflight's own copy of the defaults** | **the gate validated a configuration that was never going to run** |
| `applyPrompt` (server vs `evals/lib.ts`) | introduced *while fixing* this same pattern, one commit earlier |

The last one is the worst of them and survived until a deliberate look for it.
`preflight.ts` exists to refuse to serve when misconfigured, and it held its own
`"openai/text-embedding-3-small"` and `1536`, so after the default moved it checked
`text-embedding-3-small @ 1536` while the server ran `qwen3-embedding:4b @ 1024`.
Invisible in the container, because compose sets every one of those explicitly.

The last row is the instructive one: it was introduced one commit after this
section was written, by the person who wrote it, in a commit whose subject was
removing duplication. Naming a pattern does not stop you repeating it — only a
check does, which is why the row above it is now enforced by
`scripts/check-fork-consistency.mjs` rather than by intent.

The pattern is consistent enough to be a rule: **a default that appears in two
files will be wrong in one of them, and the copy that goes stale is the one nobody
runs directly.** Everything provider-facing now resolves through `db/config.mjs`,
and `scripts/check-fork-consistency.mjs` fails the build when compose, the
embedding model, the metadata model and the base URL stop agreeing.

The same rule applies to the suites. Three of them read a shipped default instead
of pinning their own, so changing the default broke tests that were testing
something else entirely — `test-e2e-sql` matched a provider by the literal string
`openrouter.ai`, `test-preflight` hardcoded `1536`, `test-embedding-dimensions`
keyed a stub off exact input text. A suite should pin what it does not test.

### 20. Shared scaffolding, and pure logic lifted out of `index.ts`

A refactor pass over code this fork owns entirely — `server-portable/`, `db/`,
`evals/`, `compat/` are all new directories, so none of this can conflict on a
rebase. It found two live defects before it removed a line, which is recorded
above; what follows is the extraction itself.

**`db/test-support.ts`** — `dropSchema()`, `applyMigrations()`, `resetSchema()`,
`createAssert()` with `skip()`, and `requireDatabaseUrl()`. Nine suites had their
own schema reset, eleven their own counting assert. Drop and apply are separate
exports because `db/test-live.ts` only drops (it applies later, since `migrate.ts`
is what it tests) and `test-preflight.ts` asserts the un-migrated state in between
— two steps beat an option that exists for one caller. `dropSchema()` owns a
function list as well as a table list, which closed a latent bug: `test-live` had
never dropped the 4-argument `upsert_thought` migration 007 added, so its reset
left one behind, masked by `CREATE OR REPLACE`.

**`server-portable/test-support.ts`** — the MCP client five suites carried,
including the SSE fallback that is easy to omit when copying and only fails on
transports that use it.

**`evals/lib.ts`** — the spec grammar (`model[!bare|!gemma][@dims]`), prompt
application, the embedding call and cosine. Four harnesses had their own `embed`
and were sending **three different query instructions**, none of them the server's.
Since the same model scores 0.938 prompted and 0.860 bare, that made their numbers
incomparable to each other as well as to production.

**`server-portable/thoughts.ts`** — `normaliseType`, `thoughtTitle`, `thoughtUrl`.
Extracted for testability, not size: `index.ts` exports only its fetch handler, so
these were reachable only by booting a server, stubbing a provider and driving a
capture over JSON-RPC, once per case. Nobody writes seven of those to check an
alias table, so nobody wrote any — the table had been shipping unverified since it
was added, and it exists because llama3.2 really did return `action_item`.
`thoughtUrl` now takes its base as an argument instead of reading the environment,
which is what lets the file be tested without one. `test-thoughts.ts` adds 40
assertions and needs neither database nor provider.

**Not split:** the six `registerTool` blocks are 430 of `index.ts`'s remaining 947
lines. They are schema plus handler, cohesive, and already driven end to end over
MCP. Splitting them would be motivated by a line count.

**The codebase got slightly bigger, not smaller**, and it is worth being straight
about that. Measured across the five refactor commits, excluding markdown:

| | added | removed | net |
| --- | --- | --- | --- |
| existing suites and harnesses | 103 | 487 | **−384** |
| new shared modules and tests | 467 | 9 | **+458** |
| | | | **+74** |

So 384 lines of duplication genuinely left the callers, and 458 arrived in five new
files — of which 79 are `test-thoughts.ts`, coverage that did not exist before, and
much of the rest is the comments explaining why each helper is shaped as it is. A
line count was never the case for this: the case is that adding a table to the
schema used to mean nine edits and now means one, and that four harnesses can no
longer disagree about what prompt they send.

Every suite reports exactly the count it reported before the pass — 63, 30, 37, 30,
31, 15, 13, 10, 21, 61, plus 43, 41 and the new 40 — which is the only check that
means anything when the thing being refactored is the tests.

One process note, since it cost four reverts. Regex-over-the-file replacement
failed three times: twice by over-matching into unrelated code, once by silently
not matching and leaving dead code beside an unused import. What worked every time
was line-anchored — locate the declaration, walk to its boundary by brace column,
assert the span contains nothing unexpected, and refuse the file otherwise.

### 21. Every mutation is recorded — `thought_audit`

Ported from `schemas/thought-audit` as migration 008 (Linear SMD-926). Nothing
recorded who changed what, and audit only ever describes events that happened
after it existed — so every capture made before this was permanently
unattributed. That asymmetry is why it is core rather than an extension.

Three departures from the extension, each a correctness fix rather than a
preference:

- **Append-only is enforced by a trigger, not by grants.** Upstream grants
  `SELECT, INSERT` to `service_role` and withholds `UPDATE`/`DELETE`. That works
  on Supabase, where the application role does not own the table. Off Supabase
  the application owns the schema, and **an owner's privileges cannot be
  revoked** — so the grant approach would have offered no protection while
  appearing to. A `BEFORE UPDATE OR DELETE` trigger refuses both for every role.
- **No RLS, no `service_role`**, consistent with migration 004's precedent and
  with what `db/test-schema.ts` already asserts.
- **The audit row is written inside the mutating transaction.** Upstream
  describes audit writes as "fire-and-forget… failures here never block the main
  operation", which for an audit log means silently losing the events it exists
  to record. A trigger on `thoughts` cannot fail separately from the mutation,
  and it covers every path in — including the tools SMD-927 will add.

The actor reaches the trigger on a transaction-local setting (`ob1.actor`, set
with `set_config(..., true)`), carrying the access key's *name* from `auth.ts`.
Transaction-local rather than session-level so it cannot leak to the next request
on a pooled connection — `test-audit.ts` asserts that directly. `actor_name` is a
first-class column rather than a key in `actor_context` so SMD-928 can promote it
to a canonical id: promoting a column is a migration, promoting a JSON key is
archaeology. Fix 23 did exactly that, adding `canonical_agent_id` beside it
rather than replacing it — the name records what the agent was *called* at the
time of writing, which a later rename would otherwise erase.

`thought_id` is deliberately not a foreign key, so audit rows outlive their
subject — the delete event being the one most worth keeping.

The actor rides in `p_payload`, which has been an **envelope** since migration
004 — that function reads only `p_payload->'metadata'` and ignores every other
key — so `p_payload.actor` needed no new overload and works identically on both
stores. The first version set the setting from `store-sql.ts` alone, which left
every audit row written through PostgREST with a NULL actor: present, plausible,
and wrong. `test-store-postgrest.ts` now asserts attribution on that path, and
that the actor does not leak into the thought's own metadata.

Redefining `upsert_thought` from a later migration has one trap worth naming:
`CREATE OR REPLACE` takes the whole body, so **every change made to it in
between is silently reverted**. Writing 008 without migration 005's
payload-validation guard dropped it, and `db/test-schema.ts` caught it on the
next run. Anything redefining that function again must carry both 005's guard
and 008's actor setting forward.

Two things a second review pass caught, both the same shape — the feature
working while quietly doing the wrong thing:

**A duplicate re-capture was logged as an update that changed nothing.** The
fingerprint dedup exists so a bulk re-import is idempotent, and a re-capture of
identical content takes the `ON CONFLICT` branch, moving `updated_at` and nothing
else. That wrote one audit row per duplicate with an empty diff, so re-running a
10,000-thought import produced 10,000 rows saying nothing happened — unbounded
growth on the operation designed to be repeatable, and a log too noisy to answer
the question it exists for. The trigger now returns early when the diff is empty:
`updated_at` moving alone is bookkeeping, not history.

**`preflight.ts` reported OK on a database with no audit table.** Captures
succeeded and went unrecorded, and the only symptom was history that never
existed. Now a `fail`, matching how migration 004's absence is treated — and it
checks the *trigger*, not the table, because the table alone would pass while
nothing wrote to it. Serving unaudited for a week is a week that cannot be
reconstructed, which is worse than a crashloop because it is invisible.

One incidental finding, recorded because it changed the implementation: **Bun's
Postgres client returns the `HINT` field as UTF-16 bytes with interleaved nulls**
(`"T\0o\0 \0p\0r\0u\0n\0e\0…"`). Guidance put in `USING HINT` is unreadable to
the runtime this server uses, so it lives in the exception message instead. A
hint nobody can read is worse than none, because it looks like it worked.

### 22. `update_thought` and `delete_thought` — a captured mistake was permanent

Ported from `integrations/update-thought-mcp` and `delete-thought-mcp` as
migration 009 plus two tools (Linear SMD-927). The surface could write and read
but never correct or remove: a typo, a mis-captured secret, a duplicate the
fingerprint missed, all permanent through the documented interface.

**Two defects in the extension were fixed rather than ported.**

`update-thought-mcp` issues a plain UPDATE of content and metadata and **never
recomputes `content_fingerprint`**, leaving it describing text the row no longer
holds. Dedup then breaks in both directions: re-capturing the OLD text hits the
stale fingerprint and merges into the edited row, and capturing the NEW text
finds no match and creates a duplicate of it. Migration 003's entire purpose,
undone by one edit.

Its concurrency guard is also **a race**: it SELECTs `updated_at`, compares in
application code, then UPDATEs, so a writer committing in between causes exactly
the lost update `if_unchanged_since` exists to prevent. Here the comparison is a
predicate in the UPDATE's own WHERE clause.

Two things this fork needs that upstream has no equivalent for: a content change
replaces the `thought_chunks` from migration 007 — otherwise the search index
still describes the previous text, findable by words that are gone and not by the
ones that are there — and both tools are gated on write scope, so a read key does
not see them in `tools/list` at all.

The delete is **hard**, which is only defensible because migration 008 preserves
`previous_content` before the row goes. Without that it should have been a soft
delete, and the issue said so.

`capture_thought` now returns the new id. It did not before, which was invisible
until these two tools existed — an agent that captured a typo had no id to correct
it with and had to search for its own thought.

Refusals are results, not exceptions: `NOT_FOUND`, `STALE_READ` and
`DUPLICATE_CONTENT` come back as values with a message saying what to do, because
at the tool boundary a thrown error is indistinguishable from a fault.

A third defect, found reviewing rather than writing, and the worst of them: the
`if_unchanged_since` guard **refused every correct caller**. Postgres keeps
`timestamptz` to the microsecond and JavaScript's `Date` keeps milliseconds, so a
client reading `12:01:53.133566` and passing back `12:01:53.133` was told
`STALE_READ` on a thought nobody had touched. Both sides are now truncated to
milliseconds, at the cost of a sub-millisecond window in which two writers could
both pass — against a guard that otherwise refuses everything.

The original test could not have caught it: it asserted a refusal in a case where
there genuinely *had* been an intervening edit, so it passed while the guard was
refusing indiscriminately. `[5b]` now asserts that reading and immediately writing
back succeeds, and `[5c]` that two writers racing on the same `if_unchanged_since`
produce exactly one winner — the assertion that separates a real atomic guard from
upstream's read-then-write race, which passes any sequential test.

Two tooling gaps this shook out. `db/ci-parity.sh` **only ran the
Postgres-backed suites**, so `test-server`, `test-auth` and `test-thoughts` were
never part of the local gate — and three stale tool-count assertions in them
reached a pull request while this script reported all green. It now runs
everything CI runs, which is what it was always claiming to be. It also judged a
suite failed if its output contained `error:` anywhere — and a suite that tests error messages says
"tool error" in its own assertion labels, so `test-update-delete` was reported
failed while passing 27/27. It now reads the tally rather than the prose.

### 23. A stable agent identity — `ob1_agents`

Ported from `schemas/per-agent-identity` as migration 010 plus `agents.ts`
(Linear SMD-928). Start with the unflattering part, because it changes the
size of the feature.

**The property the extension exists to provide, this fork already had.** Its
pitch is that rotating an agent's key must not orphan its history. Migration 008
records `thought_audit.actor_name` — the *name* of the access key, never its
digest — so swapping the hash in `laptop:write:<sha256>` already left every prior
row correctly attributed. Nothing needed to change for rotation to survive.

What binding to a name does **not** survive, and what 010 actually buys:

1. **A rename.** `laptop` becomes `macbook` and the history is stranded under a
   name nothing points at. Nothing records that they are one agent, and after the
   fact nothing ever can.
2. **Name reuse.** Retire `laptop`, hand the name to an unrelated client six
   months later, and two agents' histories silently merge.
3. **A typo.** `actor_name` is free text arriving from an environment variable.
   `labtop:write:…` invents an agent indistinguishable from a real one.
4. **Revocation as an event.** `MCP_ACCESS_KEYS` holds only currently-valid keys.
   It is a configuration, not a history: deleting the line is the whole record.
5. **Revoking without a redeploy.** Killing a leaked key meant editing a secret
   and restarting.

So the honest framing is not "attribution now survives rotation" but "attribution
now survives a *rename*, distinguishes reuse, and leaves a record of the
credential itself".

**The environment stays the authenticator.** Upstream's design has the server
hash a presented key and ask the database whether it is valid. Doing that here
would give the deployment two sources of truth for which keys work, and the
failure mode of disagreement is a key that authenticates against one and not the
other. `auth.ts` is unchanged in what it decides: the env says whether a key is
valid and what scope it has, with no database round trip, so `tools/list` still
answers against a dead Postgres. The registry answers only *who* the key belongs
to — plus one veto, `revoked_at`, which can only ever be **more** restrictive than
the environment, never less. That direction is what makes a second gate safe
rather than a second source of truth.

**Name and digest together, so a rename and a rotation are distinguishable.**
The digest is what stays constant when the name changes; the name is what stays
constant when the key is rotated. `resolve_agent(hash, label, scope)` holds both:
hash known and label new is a rename, label known and hash new is a rotation, and
both preserve the id. Registration happens on first sight, so an existing
deployment needs no admin step — the registry fills itself as clients connect.

One ambiguity is stated rather than hidden: renaming **and** rotating in the same
step is indistinguishable from a new agent and is treated as one, because both
identifiers changed at once and nothing is left to join on. Do the two separately
and the chain holds.

Departures from the extension, each a consequence of running off Supabase:

- **No `SECURITY DEFINER`.** Upstream's lookup RPC is a definer function so a
  low-privilege `service_role` can read a table it has no rights to. Here the
  application connects as the role that *owns* those tables, so a definer
  function grants nothing it does not already hold — while adding the
  `search_path` attack surface that makes `SECURITY DEFINER` worth avoiding when
  it buys nothing. Migrations 004 and 008 set the precedent; `db/test-schema.ts`
  enforces it.
- **No RLS, no `service_role` grant, no `REVOKE … FROM PUBLIC`.** A policy that
  never evaluates is not security, it is the appearance of it.
- **One field for revocation, not two.** Upstream carries `active boolean` *and*
  `revoked_at timestamptz` with a CHECK keeping them consistent — two columns
  encoding one fact, which is the pair that drifts the first time something
  updates one and not the other. `revoked_at IS NULL` means active.
- **Prefixed names.** `openbrain_agents` becomes `ob1_agents`, matching
  `ob1_config`. `agents` unqualified is too generic for a database that may not
  belong exclusively to this application.

**Failure is not a refusal.** If the registry is unreachable — or migration 010
simply has not been applied — `agents.ts` returns no id rather than throwing, and
attribution falls back to the key's name, exactly where it was before 010.
Denying instead would buy nothing: with the registry down every tool this server
exposes is also down, since they all read the same database. A *definitive*
`REVOKED`, by contrast, is an answer, and it is enforced at the request boundary
so a revoked read-only key cannot read either — a leaked connector URL being the
likeliest thing anyone ever revokes. Failed lookups are cached for ten seconds so
a dead database costs one connection attempt per interval rather than one per
request.

Successful resolutions are cached for `OB1_AGENT_CACHE_TTL_MS` (default 60s),
which *is* the delay between setting `revoked_at` and the key stopping — the one
number an operator revoking a leaked credential cares about. The cache is keyed
by digest **and** name: keyed on the digest alone, the first request after a
rename would return the cached entry, the rename would never reach the database,
and `ob1_agents` would keep the stale label until the TTL happened to lapse.

Two small things this shook out elsewhere. `auth.ts` now **rejects two key names
sharing one digest** — dead config before, a genuine ambiguity once a digest
identifies an agent. And the actor is serialised through one `actorPayload()`
rather than passed through: the trigger reads `actor->>'agent_id'` while the
TypeScript field is `agentId`, so passing the object unchanged type-checks, runs
without error, and writes NULL into `canonical_agent_id` on every row. Reverting
that one call fails eight assertions in `test-agents.ts`, which is the only
reason to trust the rest of them.

A review pass found two defects and one untested claim, all the same shape —
something asserted in prose that nothing held:

- **`OB1_AGENT_CACHE_TTL_MS=0` did not mean what it says.** Documented in three
  places as "resolve on every request", it capped *failed* lookups at a fixed
  ten seconds regardless — quietly false for exactly the answers an operator
  setting 0 is trying to observe. The failure TTL is now bounded by the
  configured one, so 0 means 0 and any nonzero value still caps a dead database
  at ten seconds.
- **`resolve_agent` reported `created: true` when it had not created anything.**
  Two callers racing on an unregistered key both took the `ON CONFLICT` path and
  both claimed to have made the agent. `RETURNING (xmax = 0)` is true only for a
  row the statement actually inserted.
- **Nothing tested the upgrade.** Every suite calls `resetSchema`, which builds
  all ten migrations against an empty database — the one situation a real
  deployment is never in. A migration that only worked on an empty table would
  have passed the entire gate. `db/test-upgrade.ts` now applies them one at a
  time onto a database with rows already in it, asserts the incremental schema
  matches a from-scratch one, and covers 010-onto-populated-009 specifically:
  prior rows read NULL, the append-only trigger still refuses UPDATE after the
  `ALTER`, and re-applying adds nothing. `test-agents [11b]` covers the other
  half — the new server against a database still at 009, where the point is not
  that the lookup fails but that the request behind it still succeeds.

Also dropped a partial index copied from upstream: on a table holding one row
per configured credential, indexing the active subset of a set Postgres would
sequentially scan anyway is maintenance with no reader.

`preflight` treats a missing registry as a **warning**, where a missing audit
trigger is fatal. The distinction is not squeamishness: without audit, history is
lost and cannot be reconstructed; without 010, every mutation is still attributed
by key name, exactly as before. Refusing to start over a feature whose absence
degrades cleanly would make applying a migration a hostage situation.

To revoke a key without touching the environment, take the digest from
`MCP_ACCESS_KEYS` and run:

```sql
SELECT revoke_agent_key('<the sha256 from your config>', 'found in a shell history file');
```

It is idempotent, and a repeat call keeps the first timestamp **and** the first
reason — the second reason is invariably the vaguer of the two, because whoever
writes it already believes the key is dead.

### 24. A trigram index on `thoughts.content` — and what it is worth

Ported from `schemas/text-search-trgm` as migration 011 (Linear SMD-925). The
executable part is a `CREATE EXTENSION` and a `CREATE INDEX` behind a flag, with
no API surface. So the interesting part is not the change. It is that measuring
it contradicted the issue on three points, that measuring it correctly took
several tries, and that the measurement is what turned it into a flag.

**The number did not transfer, and then it overshot.** SMD-925 quotes upstream:
a rare-word `ILIKE` falling from ~8s to ~100–150ms on an 89,000-row brain, about
50x. `db/bench-trgm.ts` reproduces that measurement here, on rows sampled from a
bigram model of our own corpus so the trigram distribution is ours rather than a
synthetic one, with markers planted at known frequencies so selectivity is a
controlled variable rather than an accident of the text:

| rows | table | rare (5 rows) | selective (10%) | common (90%) | two-char (5 rows) |
| ---: | ---: | --- | --- | --- | --- |
| 97 | 168 KB | 0.25 → 0.26 ms | 0.25 → 0.25 ms | no change | no change |
| 1,000 | 736 KB | 2.57 → 2.68 ms | 2.66 → 2.68 ms | no change | no change |
| 10,000 | 6.4 MB | 26 → 0.08 ms (**347x**) | 27 → 3.20 ms (8.5x) | no change | no change |
| 100,000 | 63.1 MB | 267 → 0.20 ms (**1355x**) | 276 → 34 ms (8.1x) | no change | no change |

One run's verbatim output, not an average — across runs the ratios move a few
percent. Read the order of magnitude and the plan change, not the last digit.

Four things that table says and the quoted one-liner does not:

1. **There is a crossover, and it is between 1,000 and 10,000 rows.** A seq scan
   costs what the table weighs, so the whole benefit is a function of scale.
   Below the crossover the planner correctly ignores the index — it is not
   slower, it is simply never chosen. Our corpus is 97 rows and 45 KB.
2. **Above it, upstream undersold.** ~1350x rather than 50x at high selectivity,
   because the win grows with the table.
3. **But selectivity matters more than scale.** Ten percent of rows is still a
   "rare word" by any ordinary reading, and it gets 8-9x, not ~1350x — and that
   ratio barely moves between 10,000 rows and 100,000. Ninety percent gets
   nothing: the planner correctly declines, because pulling most of the heap
   through a bitmap is worse than scanning it.
4. **A two-character pattern gets nothing in principle.** pg_trgm indexes
   three-character grams, so there is nothing to look up. The controlled version
   of that claim: the two-char probe matches *exactly the same five rows* as the
   rare probe, and at 100,000 rows takes 267 ms against the rare probe's 0.20 ms.
   Same rows, same table, one character too short.

**"The only cost is index build time" is wrong.** That is the issue's argument
for doing it now rather than later. Build time is the one-off; the recurring
costs are storage and write amplification:

- **~61 MB per 100,000 thoughts** — very nearly the size of the table itself,
  because ~500 characters of prose produce ~500 trigrams and almost all of them
  are distinct across a corpus.
- **Roughly +70 to +95 µs per row inserted** across runs, and flat as the table
  grows. On a bare content `INSERT` that is 4x to 6x. The multiple overstates the real
  effect — a capture also embeds and inserts into HNSW, so this lands on top of a
  much larger number — but the microseconds are paid on every capture forever.
- **A vacuum dependency.** GIN buffers new entries in a pending list that every
  query scans in full on top of the index, so a busy table's lookups sit between
  the two columns above until it is vacuumed.

The half of the argument that *does* hold is the build lock. `CREATE INDEX`
without `CONCURRENTLY` blocks writes for the length of the build (~5s at
100,000 rows here), and that is the one cost that genuinely only grows. `CONCURRENTLY` is not available: `migrate.ts`
wraps each file in a transaction and `CREATE INDEX CONCURRENTLY` may not run
inside one. An operator upgrading a large live brain should expect captures to
block for that long. Building it by hand with `CREATE INDEX CONCURRENTLY` avoids
the lock, but recording that afterwards means inserting the single
`schema_migrations` row — **not** `--baseline`, which marks *every* unapplied
migration as applied and would silently skip 010 on a database sitting at 009.

**The caveat that outranks all of the above: no core query can reach it.**
`search_thoughts_text`, the function this index was written to accelerate, lives
in `schemas/enhanced-thoughts` and has not been promoted. This fork's core has no
`ILIKE` against `thoughts.content` at all — search is `match_thoughts` (vector),
`list_thoughts` filters on `metadata`, and `fetch` is a lookup by id. So today the
index is reachable only by a deployment that also installed `enhanced-thoughts`,
or by whatever keyword-search path core grows later.

**So the index shipped opt-in, and off by default.** `OB1_TRGM_INDEX=on` built
it; unset left the extension in place and the index out. That resolved the
tension directly rather than arguing around it: a stock deployment paid nothing
for a capability it could not reach.

> **Superseded by §26.** Migration 012 added `search_thoughts_keyword`, which is
> exactly the core query this section says does not exist. The one argument for
> off no longer holds, and the default is now **on**. Everything above about what
> the index costs is unchanged and still true — a small brain now pays it for no
> read benefit, which §26 states plainly and which `OB1_TRGM_INDEX=off` reverts.

The extension is created either way, deliberately. On its own it is inert —
catalog rows, no storage on the table, no cost on any write — and having it
present is what makes enabling the index later a single statement rather than a
statement plus a privilege the application role may not have.

**The sharp edge, and what catches it.** The flag is read when 011 *applies*.
Migrations run once and are recorded in `schema_migrations`, so setting
`OB1_TRGM_INDEX=on` against a database that already has 011 and re-running the
migrator prints `applied 0, skipped 11` and builds nothing. That is a silent
no-op on an explicit instruction, so `preflight.ts` compares the setting against
`pg_indexes` and reports the disagreement in either direction, with the statement
that fixes it:

```
⚠  trigram index  OB1_TRGM_INDEX is on but idx_thoughts_content_trgm does not exist
                  → CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_thoughts_content_trgm
                      ON thoughts USING gin (content gin_trgm_ops);
```

A warning, never a failure: the index changes how fast a pattern match runs,
never what it returns. The inverse — an index present while the flag is off — is
reported too, because that one is costing every capture for something the
configuration says it does not want.

Adding the flag meant adding a third `{{...}}` variable to the migration
templates, and substitution was implemented **three times**: `migrate.ts`,
`db/test-support.ts` and `db/test-schema.ts`, the latter two as bare
`.replace()` chains. A `.replace()` cannot fail on a variable it has never heard
of — it leaves `{{TRGM_INDEX}}` in the SQL and Postgres reports a syntax error
with no hint where it came from. This is the fork's named recurring defect, so
substitution now lives once in `db/config.mjs` and throws on an unknown variable
by name.

**Measuring it was harder than building it.** The executable part of the
migration is six lines; the file is 112, almost all of it the reasoning below. The
benchmark produced three confidently wrong answers before it produced a right
one, and all three are the same species of mistake — a difference between the
arms that is not the thing being measured:

| what was wrong | what it reported |
| --- | --- |
| the baseline arm ran against a schema that already had the index (011 builds it, and every suite resets through the migrations) | no improvement at any scale |
| the write arm left ~6,000 dead tuples that only the *second* read arm had to scan past, and GIN's pending list is only flushed by a vacuum, not an analyze | the index "1.4x **slower**" at 97 rows, reproducibly |
| the "medium selectivity" probe searched for a real word instead of a planted one, and at 1,000 rows matched **zero** rows | a 190x speedup for a query returning nothing |

The third is the one worth keeping in mind, because it is the one that looks like
a result. A benchmark that prints a number always prints a number; the only
defence is to make the thing you are varying the only thing that differs, and to
print enough alongside it — matched row counts, the plan node — to notice when it
is not. The two-character probe is the finished form of that: it matches exactly
the same five rows as the rare-word probe, so the ~1,300x gap between them at
100,000 rows is attributable to pattern length and to nothing else.

**On testing an index.** Asserting `USING gin` passes for `gin (content)`, which
is a perfectly valid index that pg_trgm cannot use. So `test-schema.ts` asserts
the opclass, and then asks the narrower question that actually matters: with
`enable_seqscan` off, does the planner *reach* for this index for a leading-
wildcard `ILIKE`? Sabotaging the opclass to `gin (to_tsvector('simple', content))`
fails both assertions, which is how we know they exclude the failure rather than
confirm the hope. The suite also asserts a two-character pattern still returns the
right rows — unindexable is fine, silently wrong is not.

One toolchain note: `test-schema.ts` runs on PGlite, which ships contrib
extensions as separate bundles that must be handed in at construction. Without
`extensions: { vector, pg_trgm }` the `CREATE EXTENSION` in 011 does not
gracefully skip — it raises, and the migration fails to apply.

### 25. The benchmark corpus was truncated, and nobody knew

Every retrieval number this fork published came from `/tmp/linear-corpus.json`, a
file built ad hoc in a session nobody kept. Inspecting it turned up two defects.

**Truncated at ~500 characters.** Documents topped out at 483, 80 of 97 sat in the
400–490 band, and **78 of 97 did not end on sentence punctuation** — SMD-775 cuts
off mid-clause at "More importantly, the". A cap had been applied at ingestion and
nothing recorded it.

**No comments.** Fields were `id`, `title`, `text`, `labels`. On a real tracker
the decision and the pushback live in the thread, not the description.

Both narrowed the conclusions more than they looked. `qwen3-embedding:4b` was
chosen partly as "the only local model that embeds a long capture whole" — on
inputs where that cannot show. And nothing reached the 1200-token chunking
threshold, so migration 007's `thought_chunks` had no real documents to work on:
an artifact of the truncation, not a property of Linear issues.

`evals/build-linear-corpus.ts` replaces it, fetching full descriptions plus
comment threads over Linear's GraphQL API:

| | old | new |
| --- | ---: | ---: |
| documents | 97 | 441 |
| chars p50 / p90 / max | 446 / 447 / 483 | 810 / 2,789 / **15,812** |
| with comments | 0 | 131 (318 total) |
| over the 1200-token chunk threshold | **0** | **15** |

Re-running the head-to-head changed one number that mattered and confirmed
another:

| | old (97, truncated) | rebuilt (441) | rebuilt, ≥120 chars (423) |
| --- | ---: | ---: | ---: |
| qwen3-embedding:4b | 0.933 | 0.903 | **0.914** |
| embeddinggemma | 0.914 | 0.873 | **0.894** |
| gap | 0.019 | 0.030 | **0.020** |
| latency | "~3x" | ~5x | **~5x** (106.8s vs 20.5s) |

The ranking survived, so the default stands. The latency claim did not: "~3x" was
measured on 500-character stubs and the real multiple on full documents is about
five. Corrected in `db/config.mjs`, `SETUP.md` and above.

**The third column is the interesting one, and it cost me a conclusion.** On the
441-document build the gap looks like it doubled, 0.019 → 0.030, and the obvious
reading is that the long-capture advantage finally showed up. It did not.
Eighteen documents are under 120 characters — three of them 3, 15 and 21 — and a
body that short cannot encode its own title, so those queries are unanswerable by
construction. They were the top three misses for **both** models. Excluding them
gives a gap of 0.020, indistinguishable from the truncated corpus's 0.019:
`embeddinggemma` simply handles degenerate rows worse, and that read as a margin.

So the honest summary is duller than the first draft of this section. Fixing the
corpus did **not** reveal a hidden advantage for the bigger model. It confirmed
the ranking, corrected the latency claim by a factor of nearly two, and left the
"embeds a long capture whole" argument exactly where it was: an argument from
architecture, unsupported by measurement. Which is worth writing down, because
the exciting version was live in three files for about an hour.

Both absolute scores fell, and that is arithmetic rather than regression: ranking
one document first out of 441 is harder than out of 97. **The two sets are not
comparable in either direction.**

Only that head-to-head was re-run. The prompted-vs-bare finding (0.933 against
0.860) and every extraction number are still old-corpus and are now labelled as
such where they appear — kept because those gaps are far too large to be
artifacts, flagged because the absolute values are stale.

Three things the builder does deliberately:

- **Keeps the title out of the document text.** `eval-real.ts` uses the title as
  the query, so including it would place the query verbatim inside its own answer
  and inflate every score. The old corpus got this right; it would have been easy
  to lose.
- **Refuses to write inside the repository**, independently of `.gitignore`. This
  repo is public and the corpus is internal healthcare-company engineering data.
  `.gitignore` only protects patterns someone remembered to add, and a committed
  corpus is not a mistake you undo in the next commit.
- **Never prints a credential.** `evals/env.ts` loads keys from a gitignored
  `.env` and reports which files it read and which key *names* each supplied. A
  loader that echoes values puts secrets in a scrollback, then a CI log, then a
  screenshot.

One caveat carried into the new numbers: `eval-real.ts` embeds whole documents and
Ollama's default batch is 2048 tokens, so the 15 documents above it are silently
cut at embed time. Both models suffer it equally so the comparison holds, but the
long-document tail is under-measured — the exact failure `chunk.ts` exists to fix,
appearing inside the benchmark that measures it.

### 26. Keyword search — `search_thoughts_keyword`, and why not tsvector

Migration 012 (Linear SMD-944). Retrieval in this fork was purely semantic:
`search_thoughts` and the ChatGPT-compat `search` both call `match_thoughts`,
`list_thoughts` filters on `metadata`, `fetch` is a lookup by id. Nothing matched
the literal text of `thoughts.content`, so a caller who knew the exact string —
an error code, a ticket key, a commit SHA, a symbol name — had no way to ask for
it.

**The gap, measured.** `evals/eval-keyword.ts` takes tokens that appear in
exactly one document *by substring* and are identifier-shaped, over 441 real
issues, and asks both instruments where the containing document lands.
Embeddings from `qwen3-embedding:4b` with the server's own query prompt:

| instrument | R@1 | not in top-10 | MRR |
| --- | --- | --- | --- |
| vector (`qwen3-embedding:4b`) | 10% | 37/60 | 0.201 |
| keyword (`search_thoughts_keyword`) | 100% | 0/60 | 1.000 |

The keyword row is 100% **by construction** and proves nothing on its own — every
query is unique to one document, so a correct substring search cannot do worse.
It is there to show that the vector row is not. Sliced by what the token looks
like, because the first run's deepest misses were all slash-joined English words
(`disabled/replaced`, `UI/API`) and letting those carry the headline would have
been flattering:

| shape | n | R@1 | not in top-10 |
| --- | --- | --- | --- |
| digit or underscore — `SMD-506`, `temporal_activity` | 27 | 7% | 16/27 |
| slash or dot — `UI/API`, `db/config.mjs` | 28 | 7% | 19/28 |
| interior capitals — `getUserById` | 5 | 40% | 2/5 |

The first row is the case the issue is actually about, and it is no better than
the weak one. The embedding ranked `additional_notes` 277th of 441.

**Substring, not tsvector — and that is the decision, not an omission.**
`schemas/enhanced-thoughts` answers this with `to_tsvector` plus an ILIKE
fallback. Measured against the queries this feature exists for:

| query | tsvector | ILIKE |
| --- | --- | --- |
| `upsert_thought` | hit | hit |
| `ERR_POSTGRES_SERVER_ERROR` | hit | hit |
| `PGRST202` | hit | hit |
| `SMD-944` | hit | hit |
| `PGRST` inside `PGRST202` | **miss** | hit |
| `9543c29` inside `9543c29ab` | **miss** | hit |

tsvector is better than a first guess suggests: `websearch_to_tsquery` turns an
underscored identifier into a *phrase* query, so "we upsert the thought later" is
correctly not a hit for `upsert_thought`. It handles four of six, with ranking,
boolean operators and a far smaller index.

It is still wrong here, because everything it matches, it matches at token
granularity — and token-granularity word overlap is the closest thing to what the
embedding already does, and does better. The capability keyword search uniquely
adds is exactness and sub-token reach. Choosing tsvector spends a new subsystem,
and a second GIN index with a second per-capture write cost, on the half of the
problem that was already covered.

What that costs, stated rather than left to be discovered: no boolean operators,
a multi-word query means literal adjacency, and no relevance ranking beyond
occurrence count and recency.

**Escaping is a correctness issue, not a detail.** `_` and `%` are ILIKE
wildcards, and `_` is the most common character in the identifiers this exists to
find. Unescaped, `ILIKE '%upsert_thought%'` also matches `upsert-thought` and
`upsertXthought` — a tool whose contract is exactness returning approximate rows
with no signal. That raised a question nothing had answered: can pg_trgm still
extract grams from a pattern containing `\_`? It can — `db/bench-keyword.ts`:

| rows | first call | index used in 12 more | equivalent query |
| --- | --- | --- | --- |
| 1,000 | seq | 12/12 | Seq Scan |
| 10,000 | index | 12/12 | Bitmap Heap Scan |
| 100,000 | index | 12/12 | Bitmap Heap Scan |

The twelve extra calls exist because plpgsql may switch to a **generic plan**
after five executions of the same statement, built without knowing the pattern.
If one ever chose a sequential scan the function would be fast five times and
then far slower for the rest of the session — a regression no single-shot timing
can see. It does not happen. The 1,000-row row disagrees with itself,
reproducibly, and that is fine: below the crossover both plans cost 2.9 ms, so
the planner is entitled to pick either and does.

**Not trimming the query is also a correctness issue,** and the test suite found
it rather than the design. An earlier version trimmed the needle, so searching for
`SMD-944 ` — trailing space deliberate, to exclude the longer key — silently
became a search for `SMD-944` and returned `SMD-9440` too. The needle is now
matched exactly as given; `trim()` appears once, only to reject an all-whitespace
query. The cost is that a pasted string with a stray space finds nothing, so the
tool says so when the query it was handed has one.

**A stable page boundary, and a test that did not test it.** Every `ORDER BY`
feeding `OFFSET`/`LIMIT` needs a unique final key or the sort is not total and
Postgres may order ties differently between the executions that fetch page 1 and
page 2 — duplicating one row and dropping another. Upstream's `ORDER BY rank
DESC, created_at DESC` has no unique key. Ours ends in `id`.

The obvious test for that — page six tied rows two at a time, look for repeats —
**passes with the tiebreak deleted.** At that size Postgres picks one plan and
returns ties in the same physical order every time, so the test confirms what you
hoped rather than excluding the failure. What discriminates is varying the *plan*
between pages: with a total sort order the result is plan-independent, without
one a bitmap heap scan and a sequential scan disagree. Measured over 400 tied
rows with `enable_seqscan` alternating — tiebreak removed: 2 repeats, 398 of 400
covered. With it: 0 and 400.

**`total_count` is the true count**, `count(*) OVER ()`, not upstream's capped
2000+500 reported as if it were a total. It is nearly free *here specifically*
because the ordering already materialises the whole match set: an unordered
`LIMIT` could stop early, a sorted one cannot. That was an argument until
`bench-keyword.ts` priced it — 0.51 ms with the window against 0.51 ms without,
at 100,000 rows.

**The default flip, with the unflattering half first.** `OB1_TRGM_INDEX` now
defaults to **on**, because the sole argument for off was "no core query can reach
it" and 012 is that query. Nothing about the cost changed: below ~10,000 rows the
index does nothing at all, and every capture pays ~70–95 µs and about as much
storage as the table. A small brain now pays that for no read benefit. It stays a
flag for exactly that reason — `OB1_TRGM_INDEX=off` before the first migration run
restores the old behaviour, and keyword search still returns the right rows
without it, by the sequential scan the planner would have chosen at that size
anyway. Above the crossover the trade is not close: 267 ms against 0.20 ms.

Every deployment that applied 011 before this change is now in the mismatched
state by default — the flag wants the index, the ledger says 011 is done, and no
index exists. `preflight.ts` says so on every boot, with the one statement to run.

**One instrument failure worth recording,** since §24 and §25 are both about that.
`bench-keyword.ts` establishes that the *function* uses the index by reading
`pg_stat_user_indexes.idx_scan` before and after the call — `EXPLAIN` of a plpgsql
function shows a Function Scan and nothing about what happens inside it. The first
version read the counter immediately and reported "index not used" at every scale,
while its own timing column said 0.59 ms for a query a sequential scan does in
267 ms. Statistics flush at most once a second. The two columns contradicting each
other is what caught it; a script that printed only the counter would have been
believed.

### 27. Contextual retrieval, measured — and the whole-content vector it found

Migration 013 (Linear SMD-951). The issue asked for Anthropic's Contextual
Retrieval: generate a short blurb naming what each window of a long capture is
about, prepend it before embedding, so a window reading "we settled on thirty
minutes, anything longer needs sign-off" carries which system it concerns. Their
published result is roughly a 35% reduction in top-20 retrieval failure.

**It is worse here, and the flag ships off.** `evals/eval-contextual.ts`, 441
real issues, the 15 that reach the 1200-token chunking threshold, 37 queries that
name a document's subject and ask for a detail living in exactly one window:

| arm | MRR | helped | hurt |
| --- | ---: | ---: | ---: |
| bare windows (the server before this change) | 0.904 | — | — |
| a blurb per window (Anthropic) | 0.826 | 1 | 8 |
| a 20-word blurb per window | 0.847 | 0 | 5 |
| one blurb per document | 0.759 | 1 | 13 |

Helped/hurt are paired counts, because at 37 queries a mean can move on one of
them and an average alone would not say which.

**The task in the existing harness could not have found this.** `eval-real.ts`
uses the issue title as the query, and a title describes a whole document, so a
whole-document vector answers it best and every arm lands within a document or
two of every other — 0.917 against 0.922 against 0.956, in the direction that
flatters the change. Building the eval on that would have shipped contextual
retrieval as a small win. The detail query is the one the technique exists for,
and it is generated from the title plus ONE window, never the whole document, so
the detail half comes from the window itself and the bare arm gets the strongest
advantage available. Biased against the change on purpose.

**The mechanism is measured, not inferred.** The same harness compares each query
against the exact window it was written for. A blurb moves that window *away*
from its own query: −0.0338 with a full blurb (lower on 32 of 37), −0.0144 with a
20-word one (27 of 37). The loss tracks blurb length. A fixed-size vector has
less room for the sentence that actually answers. That also explains the 20-word
prompt in `db/config.mjs` — the first run's blurbs ran to a median of 388
characters and every one opened "This chunk outlines…", identical text in front
of every window in the corpus. Tightening it made the technique *less bad*, not
good.

**It ships as a flag anyway, because the sign belongs to the model.** Same
harness, same corpus, same blurbs, on `embeddinggemma`: a blurb per window scores
**+0.041**, helping 5 and hurting 4. 768 dimensions against 1024, and a real
ceiling. A weaker window vector has more to gain from the extra subject signal
than it loses to dilution. So `thought_chunks.context` and `OB1_CHUNK_CONTEXT`
exist, default off, with the table beside them.

**Two premises in the issue turned out to be false, and checking them is what
produced the change that pays.** The issue says the harness is already truncating
those 15 documents at Ollama's 2048-token batch. It is not — not for the
configured model. `eval-contextual.ts` finds the ceiling by bisecting for the
shortest prefix that embeds to a bit-identical vector, no tokeniser involved, and
`qwen3-embedding:4b` read all 15,812 characters of the longest document in the
corpus. `embeddinggemma` stops at ~8,150 and `bge-m3` at ~7,530, so the premise
was true of the model migration 007 was written against and not of the default
that replaced it.

Which exposed the real defect. `embedCapture` set `thoughts.embedding` to the
**first window's** vector for a chunked capture, deliberately, to avoid an
over-batch request. On a provider that reads the whole document that threw away a
better vector for free:

| arm | detail-query MRR | helped | hurt |
| --- | ---: | ---: | ---: |
| MAX over bare windows (before) | 0.904 | — | — |
| whole content AND bare windows (now) | **0.935** | **3** | **0** |

Worth noting that migration 007's own header has said `thoughts.embedding` is
"the whole-content embedding, truncated by the provider exactly as before" since
the day it landed, while `index.ts` stored the head window. The schema's
documentation and the server's behaviour had disagreed for the whole life of the
feature, and neither was wrong enough to fail anything. This change makes the
code match what the migration always claimed.

+0.020 with none worse on `embeddinggemma` too, where the whole-content vector
*is* truncated — a head-truncated vector is a longer head than the first window,
not a worse one. The cost is one extra provider call on the 3.4% of captures long
enough to chunk, and it is best-effort: a provider that REFUSES over-length input
rather than truncating it (hosted APIs do; Ollama does not) falls back to the old
head-window behaviour, and latches so it is not asked again for the life of the
process. `test-chunking.ts` asserts **exactly one** such probe across four long
captures — `<= 1` would pass whether the latch works or the probe never happens.

**Failure policy, and why the column exists.** A blurb that cannot be generated
degrades to a bare window rather than failing the capture: one flaky local model
call must not lose a thought, which is the whole point of migration 008's atomic
capture. The usual objection is that this silently produces an inconsistent
corpus, and the answer is the column rather than the policy —
`thought_chunks.context` is NULL for a bare window, the capture response says how
many went in bare, and `preflight.ts` counts both across the corpus and reports a
brain captured under both settings. Turning the flag on without migration 013 is
a startup **failure**, not a warning: 007 and 009's functions would not select
the key. The blurb still reaches the vector — the server composes the embedded
text before the database sees anything — so what is lost is the record, and with
it any way to tell a contextualized chunk from a bare one ever again.

**A defect the review found next door.** `deploy/compose.yaml` forwards an
explicit whitelist of environment variables, not the whole environment, so a
setting present in `.env` and absent from the `environment:` block reaches
nothing — the operator sets it, restarts, and the stack behaves exactly as
before, with no error and a `.env.example` that documents the setting as real.
Six variables were in that state, including the one added here:
`OB1_CHUNK_CONTEXT`, `OB1_CHUNK_TOKENS`, `OB1_CHUNK_OVERLAP`,
`OB1_EMBEDDING_DIMENSIONS`, `OB1_LLM_API_KEY` and `OB1_AGENT_CACHE_TTL_MS`. All
six are forwarded now, and `scripts/check-fork-consistency.mjs` fails on a
seventh: a variable documented in `.env.example` and mentioned nowhere in
compose. Deliberately one-directional — compose legitimately sets things the
example does not mention, because those are properties of the stack rather than
choices anyone makes in `.env`.

**One harness limit worth recording.** The behavioural half of the migration test
lives in `db/test-live.ts` rather than `test-schema.ts` because PGlite cannot run
it: writing chunk rows through the 4-argument `upsert_thought` crashes the WASM
build in-process — `received invalid response: 0` bound as a parameter, `Out of
bounds memory access` inlined — and it reproduces with migrations 001-012 applied
and no 013, at any position in the file, on a second instance as well as the
shared one. It is the harness, not the migration, and the round trip belongs
against a real server anyway.

### 28. A filtered search reaches the index — and the overfetch that never did

Migration 014 (Linear SMD-968; upstream
[#417](https://github.com/NateBJones-Projects/OB1/issues/417)). The issue
reports that `match_thoughts` loses recall under a metadata filter: pgvector's
HNSW scan hands over its first `hnsw.ef_search` candidates — 40 by default — and
a filter applied after that sees only those 40. Upstream's fix is one line,
`SET LOCAL hnsw.ef_search = 200`.

**That line could not have fixed this fork.** 007's function took each
candidate CTE's top `v_fetch` rows by distance — `LIMIT GREATEST(match_count *
4, 20)` — and applied `t.metadata @> filter` to the merged result afterwards. The
explicit LIMIT capped the candidate set before the filter ran, whatever
`ef_search` said. A filter matching 1% of the corpus saw 1% of 40 candidates.

**Who it reached, stated plainly because the first two drafts of this section
overstated it.** The server's own `search_thoughts` has no filter input and
passes `{}` on every call, in both `server/index.ts` and `server-portable/`.
So the filtered-recall defect never touched first-party search; it reached
direct SQL callers, PostgREST RPC callers, and community code that sends its own
filter — the enhanced-mcp integration's `metadata_filter`, the local-brain
recipe's search function. The overfetch defect below did reach first-party
callers, above ten results. The third review pass caught the framing; the
Linear ticket carries the same correction.

**Measured first, on random vectors.** `db/bench-hnsw.ts`, 64-dimensional unit
vectors, planted filter tiers, 10 rows asked, against an exact scan of the same
rows with index scans disabled:

| rows | filter matches | before: returned | in exact top-10 | empty | after: returned | in exact top-10 | empty |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 50% | 10.0 | 7.9 | 0/50 | 10.0 | 9.3 | 0/50 |
| 10,000 | 10% | 5.4 | 4.9 | 1/50 | 10.0 | 10.0 | 0/50 |
| 10,000 | 1% | 0.8 | 0.8 | 23/50 | 10.0 | 10.0 | 0/50 |
| 10,000 | 0.1% (9 rows) | 0.1 | 0.1 | 46/50 | 9.0 | 9.0 | 0/50 |
| 100,000 | 50% | 10.0 | 4.5 | 0/50 | 10.0 | 6.3 | 0/50 |
| 100,000 | 10% | 6.0 | 3.9 | 0/50 | 10.0 | 8.9 | 0/50 |
| 100,000 | 1% | 0.5 | 0.5 | 28/50 | 10.0 | 10.0 | 0/50 |
| 100,000 | 0.1% | 0.1 | 0.1 | 47/50 | 10.0 | 10.0 | 0/50 |
| 100,000 | 0.01% (6 rows) | 0.0 | 0.0 | 50/50 | 6.0 | 6.0 | 0/50 |

Two things in the after column are not the fix. The 6.3 and 8.9 at 100,000
rows for the broad filters are the HNSW approximation — random uniform vectors
are the index's hardest case, and 007 scored 4.5 and 3.9 on the same rows; the
iterative scan improves it because it keeps going, but `ef_search` is unchanged
and so is the index. And the two thinnest rows return fewer than ten because
fewer than ten exist; they are there to show the scan reaching past its
candidate budget for every matching row and finding them all.

**These tables were measured seven times.** The first bench's random generator was an
LCG multiplied in doubles; past 2^53 its low bits are rounding noise and the
stream repeats every 10,466 draws, so at 100,000 rows the corpus held ~10,000
distinct vectors stored up to ten times each and every "random" query was
bit-identical to a stored row — the query-is-its-own-nearest-neighbour confound
this bench's header says its design avoids. The second review pass found it.
The generator is now mulberry32 in 32-bit arithmetic, the bench refuses to run
if any query lies within cosine 0.99 of a stored row (it prints the nearest,
0.56–0.59 here), and every number in this section is from the re-measurement.
The shape of the finding did not change; the broad-filter approximation, the
default path's cost and the scan bound's behaviour did, and are reported as
re-measured. The third measurement came after the sixth review pass found that
the bench's session predated the migration that seeds the walk bounds at
database level, and `RESET ALL` does not fetch those — so the bounds section D
claimed to exercise were not in force. The bench now reconnects and asserts the
session sees them before measuring. The fourth came after the ninth pass
replaced the body's OR with two branches; the fifth after the tenth added the
exact branch and raised the ceiling (below); the sixth after the eleventh
folded the routing count into that branch; the seventh after the twelfth made
that count ignore rows nothing can score. The recall columns have moved by at
most 0.2 since the second; the latencies have moved a great deal, and the
tables are from the seventh run.

**Then on the real corpus.** `evals/eval-filtered.ts`, the 441 issues with their
real labels, stored the way the server stores them (whole-content vector plus
bare windows), searched through the deployed function in a real Postgres. The
query is a document's title; the filter is a label that document does **not**
carry; the right answer is the exact top-10 within the label:

| filter | share of corpus | before: returned | in exact top-10 | empty | after: returned | in exact top-10 | empty |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `api` | 36% | 9.9 | 8.5 | 0/60 | 10.0 | 10.0 | 0/60 |
| `web` | 14% | 6.4 | 5.8 | 0/60 | 10.0 | 10.0 | 0/60 |
| `portal` | 4.5% | 1.6 | 1.6 | 31/60 | 10.0 | 10.0 | 0/60 |
| `design` | 2.7% | 2.0 | 1.9 | 0/60 | 10.0 | 10.0 | 0/60 |
| seeded 10% | 8.4% | 4.3 | 3.7 | 0/60 | 10.0 | 10.0 | 0/60 |
| seeded 2% | 0.7% | 0.2 | 0.2 | 48/60 | 3.0 | 3.0 | 0/60 |

Paired: 306 of 360 filtered queries improved, none worsened. (The seeded 2% tier
landed on three documents, so three is the whole answer; 007 found none of them
on 48 of 60 queries.) Filtered to a label the document
**does** carry, the target's rank is unchanged on all 316 queries — MRR 0.938
both ways — and the other nine rows go from 7.9 to 9.9 in the exact top-10.
Unfiltered, all 441 queries return identical rows before and after; the run
exits non-zero if they do not.

**Why the query design matters, and the draft that got it wrong.** A query
formed by perturbing the target's own vector makes the target the global nearest
neighbour, which no post-filter can lose. The first draft of the bench did that
and reported 50/50 recall for a function that returns nothing at 1%. Title
queries have the same property on this corpus: the target is the global nearest
neighbour of its title (MRR 0.90), so "does the title still find its document
under a filter" would have called the defect harmless. The task a filter exists
for is "things about X among my `portal` issues", where the best `portal` match
is not the global best match — so the eval filters to a label the query's
document lacks and scores against the exact answer within it.

**What changed.**

- The filter moves inside both CTEs. For `thoughts` it is a plain Filter on the
  index scan. For `thought_chunks` it is a **join** to the parent row, not an
  EXISTS: inside an OR the planner cannot turn EXISTS into a semi-join and ran it
  as a hashed subplan — one full pass over `thoughts` per query, whatever the
  filter. Measured, that alone made the new function 3x the old one's latency at
  10,000 rows. The join is one primary-key lookup per candidate, and it exists
  only in the walk branch; the unfiltered branch has no predicate and no join.
- **A thin filter is answered exactly, with no index walk.** The function
  collects the matching thoughts' ids through the GIN index, at most the
  threshold plus one of them, and when at most `GREATEST(v_fetch * 4, 1000)`
  match it scores those rows and their chunks directly by id — primary-key
  probes and chunk-index probes with that array, one pass over the filter (the
  tenth-pass draft counted first and re-evaluated the predicate to build the
  matched set; the eleventh folded the two into one). Only rows a branch can
  score count towards the threshold: a thought captured through the 2-arg
  fallback has no vector and no chunks, and the twelfth pass found that
  counting those could send a filter with 1,200 matches and 30 scoreable rows
  to the walk, which needs 40 passing rows that do not exist and returns short
  at the bound; `test-schema.ts` [8d] pins the exclusion with a walk clamped to
  one tuple. The tenth review pass forced the branch: the
  enhanced-mcp integration sends `exclude_restricted: true` on every semantic
  call and nothing writes that key, so every one of its calls matched nothing,
  and the walk-only body ran each CTE to the scan bound to return the same
  empty answer 007 gave in 40 candidates — 60+ ms and up to 32 MB per scan,
  per call. It now costs one GIN probe. The same branch takes the planner's
  knife-edge away for every thin filter on a large table (the 2 ms / 190 ms
  variance below was that edge). Above the threshold the walk has at least
  that many rows to find its candidates among, so it visits about `N / 25`
  tuples at the default count and the seeded bounds are its ceiling on tables
  past ~2.5 million rows; bench section D runs the walk's own statement on the
  thin filters to show the bounds working when it is reached. (Measured at a
  million and ten million rows by SMD-1018, below: the planner serves those
  filters from the GIN index and the bounds are never what binds through the
  function.)
- **A `RETURN QUERY` branch per path, not an OR.** Drafts three through eight kept
  a single query text with `v_unfiltered OR metadata @> filter` and paid for it
  in layers: the OR against a parameter hid the GIN index from the generic plan,
  so the function had to force custom plans (`plan_cache_mode`), so the chunk
  join had to be LEFT for join removal to fire when the OR folded, so the next
  author needed a paragraph about why a boolean local was load-bearing — and
  the "forcing the custom plan is free" number was never re-measured with its
  neighbours. The ninth review pass named the OR as the root. With the
  predicate a plain `metadata @> filter` in its own branch, the planner has
  the GIN index whichever plan mode plpgsql picks, picking is a latency choice
  rather than a recall one (the plans are below), and the only function-level
  SET is the scan mode. The two texts differ in the predicate and the
  chunk-side join and nothing else; `test-schema.ts` holds them to the same
  answer on the same rows. The earlier objection — a query
  defined twice — is real and was judged smaller than what the single text
  cost.
- `hnsw.max_scan_tuples = 100000` **and** `hnsw.scan_mem_multiplier = 8`. The
  first pass of this change set only the tuple cap and reported that raising it
  from 20,000 to 400,000 changed nothing; the second review pass found why:
  pgvector also stops the iterative scan when its memory passes
  `work_mem * scan_mem_multiplier`, 4 MB by default, about 19,000 visited
  tuples — so the tuple cap was never the operative bound. Re-measured with
  valid data (below), the memory bound left a 15-row filter at 6.3 of 10 and a
  110-row filter at 42 of 50 under the generic plan; with the multiplier at 8
  both complete. Arithmetic for the cap: `v_fetch / selectivity`; pgvector's
  default covers a 0.1% filter to `match_count` 5 on a million rows, 100,000
  covers 25 — arithmetic that SMD-1018 measured at a million and ten million
  rows and retired; the "At scale" section at the end of this change has what
  the bounds actually buy. They are seeded ONCE at **database** level by a DO block in the
  migration, and only where nothing has set them — not declared on the function.
  The third and fourth drafts put them on the function and then built a
  compensating layer: a function-level SET overrides any database or role value
  and is rewritten by every `CREATE OR REPLACE`, so an operator's tuning had
  nowhere durable to live except a template variable threaded through config,
  compose, tests and preflight, each of which then needed its own validation.
  The fifth review pass named that for what it was. One `ALTER DATABASE … SET`
  by the owner is now the whole tuning surface: every session honours it, no
  redefinition of the function touches it, and re-running 014 leaves it alone —
  `test-schema.ts` asserts both the seeding and the leaving-alone. Where the
  migrating role does not own the database the DO block warns with the two
  statements and the migration still applies; the fix does not depend on the
  bounds, only the depth of a rare walk does.
- `match_count` is clamped inside the function, as 012 clamps its `p_limit` —
  to 500, the largest count any caller in the repo sends (enhanced-mcp asks for
  up to 500 under a date filter, rest-api and agent-memory-api up to 200), and
  `search_thoughts` bounds its own `limit` to 1–100 in both servers, as the
  keyword tool already did. 007 capped each CTE near 40 candidates whatever
  was asked; this function honours `v_fetch`, so an unbounded count became
  unbounded scan work — `limit: 5000` would walk each CTE to 20,000 passing
  candidates — and the callers who send a filter are outside the servers'
  bound. What the clamp changes, named: 0 and negative counts return one row,
  NULL returns ten, a count above 500 returns 500 and raises a NOTICE saying
  so. The fourth pass asked for the tool bound, the sixth for the clamp, the
  seventh for the edges to be stated and tested, and the tenth found the
  ceiling — 100, borrowed from 012 without 012's `total_count` — unmeasured and
  cutting two integrations' post-filter headroom with no signal; it is now the
  callers' maximum, timed in bench section A, and one definition in
  `config.mjs` templated into the body.
- The function body carries a contract sentinel, `-- ob1:filter-inside-scan`,
  and preflight decides whether the deployed body has 014's semantics by that
  sentinel plus a behavioural probe (a NULL filter returns a row under 014 and
  nothing under any earlier body) rather than by grepping for a local
  variable's name. The seventh pass moved the marker off the local's name and
  into `COMMENT ON FUNCTION`; the eighth caught that a replace preserves the
  OID `pg_description` is keyed on, so a successor that forgot its own COMMENT
  inherited the claim — hence the body, which every replace rewrites, and the
  probe. A successor that keeps the in-scan filter carries the sentinel; one
  that reintroduces a post-LIMIT filter must not — and a successor that keeps
  the sentinel but changes how a NULL filter is treated gets its own verdict
  from the probe rather than the pre-014 remedy, which would have re-run 014
  over it (ninth pass). Preflight also warns whenever the walk bounds are set
  nowhere — judged by `pg_settings.source`, so a value from `ALTER SYSTEM`, a
  parameter group or `ALTER ROLE` counts as set, and an operator who lowered one
  on purpose is tuning, not failing — however 014 was recorded: `--baseline`
  never runs the DO block and a non-owner cannot. The seed guard in 014 and the
  migrator's check ask a narrower question — set where EVERY role sees it,
  meaning server configuration or the database — because precedence is role >
  database > server: a database-level seed would silently undo an operator's
  `ALTER SYSTEM` (verified; the eighth-pass guard, which looked only for a
  database-level row, would have), but it cannot touch a role-level value, and
  a role-level value reaches one role. The ninth-pass guard counted any
  non-default source, so an `ALTER ROLE` on the migrating role suppressed the
  seed for everyone else, silently (tenth pass); `test-schema.ts` now sets the
  value in the session and asserts the seed still lands. Preflight keeps the
  wider question, since for the server's own connection a role-level value is
  in force. One limit, named in the header and `.env.example`: the migrating
  session sees server configuration as of its connect, so an `ALTER SYSTEM`
  that has not been reloaded looks unset and is seeded over; reload before
  migrating (eleventh pass). And the migrator's own check did not run at all
  for one commit — it bound two JS arrays into `= ANY(...)` bare, which Bun
  sends as comma-joined text, so every run fell into the catch that turns an
  error into a soft warning and the remedy it exists to print was unreachable;
  the live test asserted only the exit code and "applied N". It now binds
  through `sql.array`, reads the seeded names from the migration's own text,
  and the live test asserts neither warning appears.
- The function-level SET is NOT a problem at call time, though the eighth pass
  documented it as one and prescribed casting the argument. CREATE FUNCTION
  and ALTER DATABASE validate a SET clause up front and refuse an unknown
  `hnsw.*` placeholder to a non-superuser; function entry applies `proconfig`
  through the ordinary set_config path, where the placeholder is user-settable
  and pgvector converts it when the body's `<=>` loads the library. The tenth
  pass reproduced it: a non-superuser owner and a plain reader, each in a
  fresh session whose first statement fed an existing `embedding` value into
  match_thoughts uncast, got their rows with `relaxed_order` in force, while
  CREATE with the same clause in the same cold session was refused. The header
  now says so; nothing in the repo had tested the earlier claim.
- `hnsw.iterative_scan = relaxed_order`, declared as a **function-level SET**.
  This is what makes an in-scan filter correct: without it the scan stops at its
  first `ef_search` candidates, filter or no filter. A function-level SET is
  scoped to the call and restored on exit — nothing leaks into the caller's
  transaction as `SET LOCAL` would, and nothing depends on a pool preserving
  session state. It is also validated at CREATE: on pgvector before 0.8.0 the
  migration fails with `invalid configuration parameter name
  "hnsw.iterative_scan"` — pgvector reserves the prefix — which is the intended
  failure, reproduced on 0.7.4. That validation needs pgvector's library loaded
  in the session, and the migration now loads it explicitly with a
  `SELECT '[1]'::vector` on its first line. Earlier drafts credited the
  `vector(N)` typmod in the signature with forcing the load; that was true only
  for a superuser. Postgres checks a function's SET clauses before it resolves
  its parameter types, and a non-superuser owner — Supabase's `postgres` role,
  Neon, an RDS master user — in a session that had not yet touched pgvector was
  refused with `permission denied to set parameter "hnsw.iterative_scan"` on
  the upgrade path. Fresh installs passed because 001 had loaded the library in
  the same session; every verification here ran as a superuser and never saw
  it. The seventh review pass reproduced it. Every printed `ALTER DATABASE`
  remedy now carries the same load. A version of this function that silently
  ran without the setting would have exactly the recall 014 exists to fix.
- `relaxed_order`, not `strict_order`: the final `ORDER BY b.sim DESC` re-sorts
  the merged candidates anyway.
- `hnsw.ef_search` is left alone. At the default `match_count`, `v_fetch` is 40
  and the first batch satisfies the LIMIT, so the default unfiltered path returns
  the same rows — asserted row for row on 441 real queries by the eval's
  unfiltered control, which exits non-zero on any difference, and by row count
  in the bench.
- A NULL filter is unfiltered. 007 evaluated `NULL = '{}' OR metadata @> NULL`,
  which excluded every row.
- The plans, read from the deployed body (bench section C). The exact branch
  has one shape under either plan mode: a GIN bitmap on `thoughts` for the
  matched set, then index probes into `thought_chunks` with the matched ids as
  an array — the array form is what keeps the planner off a scan of the whole
  chunk table; written as a join, or as a LATERAL that Postgres pulls back up
  into one, its fixed 1% estimate for `@>` chose a sequential scan plus hash,
  6–11 ms at 100,000 rows and growing with the table rather than the match
  (two intermediate runs of this bench measured exactly that). The walk branch
  under the custom plan walks the HNSW index on both sides; under the generic
  plan, where the filter is a parameter, the `thoughts` side takes the GIN
  index and the chunk side walks its own HNSW index and looks each candidate's
  parent up. Both are exact for the filter, because the walk is iterative and
  bounded.

**The second defect the mechanism predicted.** `ORDER BY embedding <=> q LIMIT
200` returns 40 rows on a 10,000-row table, because the scan returns at most
`ef_search` and stops. So `v_fetch` above 40 was never honoured: with no chunk
rows `match_count = 50` returned 40, and with chunks the two CTEs together capped
near 80 — asked 100, got 68 to 79. 007's header calling the factor "a recall
budget, not a guess" was true only at `match_count <= 10`. The iterative scan
fixes this too: asked 100, got 100; asked 500 — the ceiling — got 500, in
6.8 ms at 10,000 rows and 28 ms at 100,000. (007 returned 69–77 for that ask
at 100,000 rows, and 500 at 10,000 only because the planner abandoned the
index for a sequential scan.)

**Cost, and the plan it no longer depends on.** The default path — unfiltered,
ten rows, what every first-party caller sends — costs what it did within the
run-to-run noise of this machine: median 0.62 → 0.67 ms at 10,000 rows and
1.26 → 1.37 ms at 100,000 in the seventh run, 0.61 → 0.61 and 1.32 → 1.28 in
the fifth; its branch has no predicate and no join. A thin filter — at most
1,000 matching thoughts, the exact branch — costs less than an unfiltered call:
at 100,000 rows 0.18 ms for a filter matching nothing, 0.24 ms for one matching
6 rows, 0.51 for 90, 2.6 for 998; at 10,000 rows 0.17–0.41 ms. The walk-only
body had paid 60+ ms for the never-matching case, and between 0.7 and 190 ms
for the thin tiers depending on which plan the planner's statistics sample
happened to favour that run (the ninth pass documented the variance; one run
took the 1% and 0.1% tiers to the GIN index at 2.2 and 0.7 ms, the next walked
both sides at 44 and 190 ms, same seeded data). There is no plan to favour now:
section C shows the exact branch as a GIN bitmap on `thoughts` and index probes
into `thought_chunks` under both plan modes. The statement every filtered call
runs first — the capped collection of matching ids that routes between the
branches — is explained on its own: 0.01 ms for the empty filter, and for the
50% filter at 100,000 rows 2.5 ms under either plan mode as a GIN bitmap over
50,000 matches, because GIN builds the whole bitmap before the LIMIT can stop
anything; that cost grows with the matches, and SMD-1018 measures it from a
million rows up (the previous run had seen the custom plan take a sequential
scan with a LIMIT at 0.4 ms for the same tier; the twelfth pass's scoreability
predicate tipped the estimate to the bitmap — the planner's choice, complete
either way). Broad filters take the walk: 1.6 ms at 10,000 rows for the 50%
and 10% tiers, 5.0 ms (50%) and 9.0 ms (10%) at 100,000, where section C shows
the custom plan walking both sides (7.9 ms) and the generic plan taking GIN for
`thoughts` and walking the chunk index (7.8 ms) — the same rows either
way, since the walk is iterative and bounded, and the function declares no plan
mode. Section D runs the walk's own statement on the thin and empty filters at
100,000 rows: about 63 ms each, every matching row returned, because both scan
bounds are in force (seeded at database level, the session reconnected to read
them). That is what the function no longer pays for those filters, and what
the bounds buy when a table large enough to walk for them arrives — past ~2.5
million rows at the default count, ~400,000 at the ceiling of 500, said the
arithmetic; the "At scale" section below has the measurement, which is not
that.

**Around it.** `deploy/compose.yaml`, `db/with-postgres.sh` and the CI service
containers now pin `pgvector/pgvector:0.8.6-pg16` instead of the floating `pg16`
tag, since 014 has a version floor. `preflight.ts` decides on the function's
BODY first — by the `ob1:filter-inside-scan` sentinel in the function source,
confirmed by a NULL-filter probe when there is a row to probe with — because no
setting can repair 007's LIMIT-before-filter, and only then on whether an
iterative scan is
in force, from the function's own SET clause or inherited from the database or
role. The version is consulted last, to explain an absence or to advise
`ALTER EXTENSION vector UPDATE` where the catalog record lags a working library
(the `hnsw.*` settings come from the loaded library, not from
`pg_extension.extversion`; a new binary over an old volume runs 014 correctly
while the catalog says 0.7.x, reproduced by the second review pass). The lookup
matches its siblings (name, namespace, argument count) rather than casting a
signature through `search_path`, the remedy is worded by the ledger since
"apply 014" is a no-op when 014 is recorded and a redefinition dropped the
clauses, the effective walk bounds are printed, and the whole check has its own
error boundary so a hardened server that hides `pg_available_extensions` costs
one warning rather than every check after it. On the PostgREST store, where the
catalog cannot be read, it probes: one RPC with a NULL filter returns a row
under 014's body and nothing under any earlier one — after confirming some row
has an embedding at all, and treating a failed probe as a skip rather than
evidence. (The first version was an unconditional warning that could never be
cleared; passes three, four and five each caught a case.) The migrator judges
the pgvector library version up front and refuses 014 itself, in `--dry-run`
too, while still applying earlier pending migrations and still seeding the
ledger under `--baseline`, and after 014 it reads `pg_db_role_setting` and
prints the two `ALTER DATABASE` statements when a non-owner role could not seed
the bounds — the DO block's WARNING is real but this client surfaces none. The
destructive guard the evals carried — refuse to drop a schema on a host that is
not this machine — lives in `dropSchema` now, and the one eval that drops
tables itself calls it. "This machine" means loopback, and nothing wider: the
fifth pass suggested sharing preflight's local-endpoint
predicate, which accepts RFC1918 and compose service names, and the sixth
caught that a LAN-hosted stack holding a real database is the documented
topology — so that widening is reverted. An EMPTY host is refused, because the
client resolves it through `PGHOST`. It honours the old
`OB1_EVAL_ALLOW_REMOTE_DB=1` alongside `OB1_ALLOW_REMOTE_DB=1`.
`test-schema.ts` [8b]
arranges sixty nearer rows in front of the filtered ones and asserts both come
back, including one reachable only through its chunk; `test-live.ts` [5b] asserts
a 1% filter over 1,000 random rows agrees with an exact scan on a real server.

**At scale — a million and ten million rows (SMD-1018).** Everything above
this line was measured at 10,000 and 100,000 rows, and the header's claims
past that — the seeded cap "covers tables to ~2.5 million rows at the default
count", the walk "visits about `v_fetch × N / v_exact` tuples", the routing
count's cost "grows with the matches" — were arithmetic. The bench now loads a
million and ten million rows (`OB1_BENCH_SCALES`), and the arithmetic did not
survive contact with the planner. Machine, for every number below: Apple M5
Pro host, podman libkrun VM with 8 vCPUs and 14.8 GB, `pgvector/pgvector:0.8.6-pg16`
(PostgreSQL 16.15) at its image defaults — `shared_buffers` 128 MB,
`work_mem` 4 MB — so the ten-million-row index lives in the VM's page cache,
not in Postgres's buffers. The 64-dimensional random corpus is the one above —
the vectors, the queries and the share tiers' membership at the two published
scales are exactly the published run's (nearest query-to-row cosine 0.560 and
0.588, as before), though each row's metadata now also carries the fixed-count
tiers it fell into, so the heap and the GIN index are a little wider — streamed
from the same generator in two passes so nothing holds a million vectors in
memory. The before arm runs at the published scales only; above them the
question is about the shipped function.

**Three full passes were run, and the tables are the third's — except the
two published scales, re-measured twice more after the third review pass
found the after arm's index full of dead twins (below); their rows are the
last pass's.** Latencies on this VM run two to two and a half times the
lines published above for the same tiers and vary by about 30% from pass to
pass (the before arm's default path at 100,000 rows: 2.4 ms in one pass, 3.3
in the next, against the published 1.26); the after arm's default path
matches the before arm's within that spread, as it did in the published run,
and the recall columns reproduce within 0.5. Between passes the recall
figures agreed within 0.3 — with one exception that turned out to be the
finding: for filters matching roughly half a percent to one percent of
the table, the planner's choice between the GIN index and the HNSW walk
flipped from pass to pass, at a million rows and at ten million, on the same
rows under a fresh `ANALYZE` each time. Where a cell below has two values,
that is why.

*The load.* Bun's SQL driver has no COPY protocol (a `COPY … FROM STDIN` hangs),
so rows go in as multi-row INSERTs into a table whose secondary indexes have
all been dropped and whose user triggers are disabled — 008's audit trigger
would otherwise write a row per row at every scale (it is in 001–013, so the
published run's `thought_audit` held a row per thought where this run's is
empty; nothing after 014 reads it), and 016's extraction trigger only above
100,000 rows, since the before arm loads under 001–013 and the whole schema
is applied above; what remains per row during the INSERTs is the heap and the
primary key, the same under either schema — the set of indexes rebuilt
afterwards is not, 023's and 025's three existing only under the whole one,
which is what the "other indexes" column counts — and only the INSERT
round-trips are timed. One
more thing the arms did differently, found by the third review pass and
fixed before the published-scale tables below were re-measured: at the two
published scales the after arm applies 023 onto the loaded rows, and 023's
apply-time fingerprint backfill rewrites every one of them (none carries a
fingerprint, and the column is indexed, so the update is not HOT) — a second,
identical HNSW entry per row beside a dead twin, which no VACUUM removed, so
the earlier passes measured the 10,000- and 100,000-row tables on a graph
half full of dead tuples that the large scales, whose schema is applied to an
empty table, never had. The after arm now VACUUMs after its migrations, and
the two scales were re-measured, twice — once after a plain VACUUM, once
after the VACUUM FULL the code now runs, which rewrites the heap and rebuilds
every index from scratch, the state the load produced, with the dead-tuple
count asserted at zero. The recall floor did not move (8.2 and 5.0 of 10
against 8.3 and 5.0: dead entries are skipped, not scored). What moved, in
both re-measurements, were the calls that read the GIN bitmap over the table
— the 50% tier 8.3 ms against 16.2 at 100,000 rows, its routing count 3.0
against 11 — while the default path and the ceiling moved by less than the
pass-to-pass spread. The published lines above predate 023, so they never had
the twins; what separates this VM from them is the machine and the day. The indexes are built afterwards with
`maintenance_work_mem` sized for the graph. The parallel build keeps the graph
in dynamic shared memory, which a container gets 64 MB of by default — the
first attempt failed at a million rows with "could not resize shared memory
segment … No space left on device" — so `with-postgres.sh` now takes
`OB1_PG_SHM_SIZE`. At ten million rows the graph fit in 9 GB (the container
peaked at 10.0 GB; pgvector's "graph no longer fits" NOTICE never fired) and
built in nineteen minutes. The bench's section L, as printed (the two large
runs with `OB1_PG_SHM_SIZE=4g` and `OB1_PG_SHM_SIZE=11g
OB1_BENCH_MAINTENANCE_MEM=9GB`, as the README's commands say; the count in
the "other indexes" column is the schema's — four under 001–013, seven under
the whole set — and was added to the printout after the two large runs):

| rows | source | oracle | schema | insert s | rows/s | chunk rows | chunk s | thoughts MiB | thoughts HNSW MiB | build s | chunks MiB | chunks HNSW MiB | build s | other indexes s (count) | maintenance_work_mem | workers |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| 10,000 | loaded | computed | 001–013 | 0 | 47,123 | 4,000 | 0 | 4 | 5 | 2 | 1 | 1 | 0 | 0 (4) | 256MB | 4 |
| 100,000 | loaded | computed | 001–013 | 2 | 46,782 | 40,000 | 0 | 38 | 54 | 8 | 13 | 11 | 2 | 0 (4) | 256MB | 4 |
| 1,000,000 | loaded | computed | whole | 21 | 47,624 | 400,000 | 4 | 391 | 544 | 111 | 125 | 109 | 28 | 6 (7) | 977MB | 4 |
| 10,000,000 | loaded | computed | whole | 207 | 48,412 | 4,000,000 | 30 | 3907 | 5437 | 1134 | 1250 | 1099 | 327 | 63 (7) | 9GB | 4 |

The index is 1.4× its heap at this width and about 570 bytes a row (the
sizes are MiB; the heap is 410 bytes a row); the build
runs at ~9,000 rows a second in memory. A hundred million rows was not run:
by these slopes it is a 39 GB heap, a 54 GB index, 23 GB of chunks and their
index, a graph that wants ~90 GB of `maintenance_work_mem` to build in memory
(or pgvector's far slower on-disk phase), and about three hours of build — a
machine with 128 GB and 200 GB of fast disk. Nothing below is stated past ten
million except as that extrapolation.

*The unfiltered default path, and the floor under everything.* Ten rows asked,
no filter, median over 50 random queries, and — new in this run — the rows
scored against an exact scan of the whole table, at pgvector's default
`ef_search` of 40 and again at 400:

| rows | median ms, asked 10 | median ms, asked 500 | in exact top-10 (ef_search 40) | at ef_search 400 | median ms at 400 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 1.82 | 15.3 | 8.2 | 10.0 | 4.7 |
| 100,000 | 3.25 | 54.8 | 5.0 | 9.5 | 13.4 |
| 1,000,000 | 6.95 | 181 | 2.2 | 6.8 | 41.7 |
| 10,000,000 | 17.7 | 224 | 0.5 | 2.9 | 49.0 |

The default path costs about 2× per decade of rows and is 18 ms at
ten million; the ceiling of 500 rows is a quarter of a second (0.7 s and 1.2 s in the two earlier passes — the widest spread in these runs) there. But the
recall column is the finding: at the default `ef_search` the index returns
**two of the true ten** at a million random rows and one in twenty at ten
million, and every filtered figure below sits under that floor — a 50% filter
cannot beat the index with no filter in the way. Raising `ef_search` tenfold
recovers most of it for 6× the latency. This is the "recall at these scales
is a floor" caveat the ticket carried, now with a number on it: random
uniform vectors in 64 dimensions are HNSW's worst case (every distance is
nearly the same distance), a real embedding corpus is clustered and will do
better, and how much better is a measurement on real vectors this run cannot
make (SMD-1039's corpus is the place; SMD-1465 is the question). What it can
say is that nothing in `match_thoughts` sets `ef_search`, so at whatever
scale a real brain's recall turns, the knob is a session or database setting
away and costs what the last column says.

*Filtered, through the function.* Ten asked, 50 queries, the tiers above
plus three fixed at 900, 2,000 and 5,000 matching rows wherever that is under
half the table (so not 5,000 at 10,000 rows), so the same filter can be
followed as the table grows. The `matches` column is
what was actually planted (a row count is a coin per row). At a million rows,
with the plan the function got this pass, and in brackets what the same tier
did in the two passes where the planner walked HNSW for it:

| filter | matches | returned | in exact top-10 | median ms | how the function answered |
| --- | ---: | ---: | ---: | ---: | --- |
| 50% | 499,443 | 10.0 | 3.0 | 38.6 | route ~27 ms, then the HNSW walk |
| 10% | 99,748 | 10.0 | 5.9 | 48.1 | route ~5 ms, then the HNSW walk |
| 1% | 9,951 | 10.0 | 10.0 (9.0–9.2) | 32.8 (279–287) | the "walk" branch served by GIN — exact (passes 1–2: the HNSW walk) |
| 5,000 rows | 4,916 | 10.0 | 10.0 (8.8) | 20.3 (352–368) | the same (passes 1–2: the HNSW walk) |
| 2,000 rows | 1,963 | 10.0 | 10.0 | 12.1 | the "walk" branch served by GIN — exact, all three passes |
| 0.1% | 1,034 | 10.0 | 10.0 | 9.0 | the same |
| 900 rows | 934 | 10.0 | 10.0 | 8.7 | the exact branch |
| 0.01% | 99 | 10.0 | 10.0 | 1.2 | the exact branch |
| nothing | 0 | 0.0 | — | 0.3 | one GIN probe |

And at ten million:

| filter | matches | returned | in exact top-10 | median ms | how the function answered |
| --- | ---: | ---: | ---: | ---: | --- |
| 50% | 4,998,406 | 10.0 | 0.8 | 268 | route ~240 ms of it, then the HNSW walk |
| 10% | 999,827 | 10.0 | 1.9 | 151 | route ~50 ms, then the HNSW walk |
| 1% | 99,633 | 10.0 | 10.0 (6.0) | 753 (1,450) | the "walk" branch served by GIN — exact, and slow (pass 2: the HNSW walk) |
| 0.1% | 10,231 | 10.0 | 10.0 | 97 | the same, all three passes |
| 5,000 rows | 5,088 | 10.0 | 10.0 | 52 | the same |
| 2,000 rows | 1,978 | 10.0 | 10.0 | 30 | the same |
| 0.01% | 959 | 10.0 | 10.0 | 10.6 | the exact branch |
| 900 rows | 886 | 10.0 | 10.0 | 9.4 | the exact branch |
| nothing | 0 | 0.0 | — | 0.2 | one GIN probe |

**What the arithmetic got wrong.** The header modelled the walk branch as an
HNSW walk that visits `v_fetch × N / matches` tuples and is cut by the seeded
bounds when that exceeds 100,000 — so at ten million rows a filter matching
2,000 thoughts (200,000 tuples by the formula) should have returned short
under the seed and complete only under a larger one. It returned 10 of 10 in
about 30 ms under the seed, under pgvector's defaults, and under any bound at
all, in every pass, because the planner never walked HNSW for it: with the
filter's selectivity in view (custom plan) it took the GIN index for the
`thoughts` side and the parent's GIN index for the chunk side, sorted the
matches by distance, and answered exactly. Section C reads that off the
deployed body at every scale, and section E runs every walk tier through the
function under the seeded bounds, under pgvector's defaults (`20000 / 1`) and
under the seed with `ef_search` raised — the ticket's own verification,
"returns exact under the seeded bounds and short under the defaults", asked
of the function rather than of a statement extracted from it — beside the
exact branch's own statement with its floor lifted to cover the same tier.
The third pass's section E, with the earlier passes' HNSW-walk cells in
brackets where the plan differed. The seeded column is section B's call for
the same tier made again later in the same session, as the paired control for
the other settings; where it reads under B's median, the difference is cache
warmth:

| rows | filter | matches | "walk visits" by the formula | seeded: in exact top-10 / ms | defaults: in exact top-10 / ms | ef_search 400: in exact top-10 / ms | exact branch, floor lifted: in exact top-10 / ms |
| ---: | --- | ---: | ---: | --- | --- | --- | --- |
| 1,000,000 | 0.1% | 1,034 | 38,685 | 10.0 / 8.5 | 10.0 / 9.6 | 10.0 / 9.8 | 10.0 / 9.3 |
| 1,000,000 | 2,000 rows | 1,963 | 20,377 | 10.0 / 15.2 | 10.0 / 13.7 | 10.0 / 12.5 | 10.0 / 15.6 |
| 1,000,000 | 5,000 rows | 4,916 | 8,137 | 10.0 / 22.6 (8.8 / 332) | 10.0 / 20.7 (**4.9** / 116) | 10.0 / 21.7 (8.9 / 364) | 10.0 / 28.4 |
| 1,000,000 | 1% | 9,951 | 4,020 | 10.0 / 37.9 (9.2 / 283) | 10.0 / 41.2 (**5.5** / 119) | 10.0 / 41.8 (9.2 / 322) | 10.0 / 70.9 |
| 1,000,000 | 10% | 99,748 | 401 | 5.9 / 67.0 | 5.9 / 65.7 | 6.6 / 91.9 | 10.0 / 784 |
| 1,000,000 | 50% | 499,443 | 80 | 3.0 / 40.9 | 3.0 / 38.1 | 6.4 / 66.0 | — |
| 10,000,000 | 2,000 rows | 1,978 | 202,224 | 10.0 / 30.1 | 10.0 / 31.7 | 10.0 / 31.0 | 10.0 / 18.6 |
| 10,000,000 | 5,000 rows | 5,088 | 78,616 | 10.0 / 51.7 | 10.0 / 52.3 | 10.0 / 51.4 | 10.0 / 42.0 |
| 10,000,000 | 0.1% | 10,231 | 39,097 | 10.0 / 93.5 | 10.0 / 92.5 | 10.0 / 92.4 | 10.0 / 119 |
| 10,000,000 | 1% | 99,633 | 4,015 | 10.0 / 708 (6.0 / 1,463) | 10.0 / 713 (**2.7** / 368) | 10.0 / 719 (6.2 / 1,572) | 10.0 / 944 |
| 10,000,000 | 10% | 999,827 | 400 | 1.9 / 125 | 1.9 / 124 | 2.5 / 158 | — |
| 10,000,000 | 50% | 4,998,406 | 80 | 0.8 / 230 | 0.8 / 233 | 2.9 / 268 | — |

Read across a row and four things fall out.

- **Between about half a percent and one percent of the table, the walk
  branch is on the planner's edge, and which side it lands on is decided by
  the statistics sample.** At a million rows the 5,000-match and 10,000-match
  tiers walked HNSW in two passes (332 ms and 283 ms for 8.8 and 9.2 of 10)
  and were served from the GIN index in the third (23 and 38 ms for 10 of
  10); at ten million the 1% tier was served from GIN in two passes (753 and 794 ms for 10 of 10) and walked HNSW in one (1,450 ms for 6.0). Same rows, same statistics
  target, a fresh `ANALYZE` each time. The GIN side of the coin is exact and
  an order of magnitude cheaper; the HNSW side is approximate, slower, and the
  only place the seeded bounds do anything.
- **The seeded bounds matter on that HNSW side, and nowhere else.** In the
  passes that walked, the same tiers lost three to four points of recall
  under pgvector's defaults (8.8 → 4.9, 9.2 → 5.5, and 6.0 → 2.7 at ten
  million) and kept them under the seed. Which of the two bounds bit is
  inferred, not measured: section E moves both together (`20000 / 1` against
  `100000 / 8`), and the formula that says 4,000–8,000 tuples sit well under
  the default cap of 20,000 is the formula this section retires — pgvector
  counts every tuple the scan emits, filter-rejected ones included, so the
  cap may be what bit. The second review pass of 014 measured the memory
  bound binding first at 100,000 rows (`work_mem × 1` is 4 MB; the visited
  set is graph nodes, not emitted tuples), which is the reading here too, and
  two arms that move one bound each (SMD-1464) would settle it. Either way
  the header's "pgvector's default covers 500,000 rows at the default count"
  is wrong in the direction that matters, and the seed covers the case.
  Everywhere else nothing binds:
  every thinner tier is served by GIN whatever the bounds say, and the broad
  tiers (10%, 50%) need a few hundred tuples and are bound by nothing but
  `ef_search`. **Neither seed should scale with the table**; what they buy is
  the HNSW side of that band, and they buy it.
- **The exact branch with its floor lifted is exact, and its cost is the
  match count: 6–8 µs a matching row at a million rows** (28 ms for 4,916,
  71 ms for 9,951 — primary-key probes into a heap that fits in the page
  cache), and 9–17 µs at ten million across the passes (42 ms for 5,088 and
  944 ms for 99,633 in the third; 165 ms for 10,231 in the second), where the
  heap no longer sits in Postgres's buffers. That puts it well under the HNSW walk in the
  band (28 against 332, 71 against 283) and a little over the GIN-served walk
  (28 against 23, 71 against 38), and far over either at 100,000 matches
  (784 ms against 67 for the 10% tier at a million rows). So raising the
  threshold from 1,000 to about 10,000 is not a universal win but a hedge: it
  takes the band off the planner's coin at the cost of a few tens of
  milliseconds on the GIN side, and it should not scale with the table. That
  is a decision with a migration behind it, not a bench's to make; the
  numbers are in SMD-1464, and the header's arithmetic is retired here either
  way.
- **The recall the walk loses on broad filters is the index's, not the
  filter's.** 10% and 50% at a million rows score 5.9 and 3.0; the unfiltered
  default path scores 2.2 on the same corpus. The iterative scan keeps going
  for a filter and finds a little more than the plain scan does — which is the
  fix working — and `ef_search` at 400 lifts both tiers to 6.4–6.6. A brain
  that large wants a larger `ef_search`, whatever it does about filters, and
  the measurement to size it is on real vectors (above).

*Two costs that do grow with the table, measured.* The routing statement —
the capped GIN collection every filtered call runs first — builds its whole
bitmap before the `LIMIT v_exact + 1` can stop anything, and at 50% that is
0.8 ms at 10,000 rows, 3.0 at 100,000, 27 at a million and 240 at ten
million: about 50 ns a matching row, linear, paid by every broad filtered call
before the walk starts, and at ten million it is nine tenths of the 50%
tier's whole latency. The mitigation the twelfth review pass declined for want
of a number — estimate the match count from `pg_class.reltuples` and the
planner's `@>` selectivity, or a `TABLESAMPLE`, and run the capped collection
only when the estimate is plausibly under the threshold — now has its number
and is SMD-1463 (done: migration 037, change 70). And the plan mode: plpgsql runs a statement's first five
executions on custom plans and may switch to a generic one after; for the walk
branch the generic plan has the filter as a parameter and a flat estimate, and
section C shows what that costs at a million rows — the 50% tier 292 ms
generic against 15 custom (a GIN bitmap over 499,443 rows sorted by distance,
where the custom plan walked HNSW for 80 tuples), the 0.1% tier 360 ms
against 6 (the chunk side walking its HNSW index through some twenty thousand
parent lookups where the custom plan took the parent's GIN bitmap).
At ten million the generic plan for the 50% walk takes **11.6 seconds** (a
GIN bitmap over 4,998,406 rows — hundreds of thousands of its heap blocks
lossy under 4 MB of `work_mem`, every one rechecked — sorted by distance, on
both sides) where the custom plan walks HNSW in 15 ms, and `jit = off`
changes nothing there (11.7 s): that cost is the bitmap. Every other generic
plan at ten million carries 30–110 ms its custom twin does not — the routing
count on the EMPTY filter 31 ms against 0.03, the exact branch 108 against
24, the 2,000-row walk 136 against 20 — and with `jit = off` those become
0.03, 11 and 23: **it is JIT.** The generic plan's flat estimate carries these
statements' costs past `jit_above_cost` (100,000) somewhere between a million
rows (where the same generic route on the empty filter costs 0.02 ms) and ten
million, and every call then compiles its expressions, the way 017 found
`search_thoughts_hybrid` doing (15 ms where its arms cost 1.3). The second
pass of this bench could only infer that, because its EXPLAIN ran with
`COSTS OFF`, which also suppresses the JIT summary; the explainers now print
costs and section C carries the `jit = off` arm. One more thing the harness
change moved: the shared rewrite now splices the routing collection into the
exact branch as one materialized CTE where it had spliced a scalar subquery
per `v_ids` reference — two GIN collections per call where the function runs
one — so `bench-plan.ts`'s filtered `exact` rows and section C's exact rows
read one collection fewer than 019's header publishes for the same tier
("5.4–6.5 ms for 936 matching rows at 100,000"); the function did not change,
the harness did, and 019 is checksummed, so the note lives here and in
bench-plan's header. Every session of this bench stayed on custom plans throughout
— the medians above are the custom plans' — but the choice is the planner's
estimate against its own average, made per session after five calls, and a
session that lands on the generic plan pays these numbers on every filtered
call. 014 removed the function-level `plan_cache_mode` on purpose (the ninth
review pass, above); whether it comes back is part of SMD-1464.

*Section D at scale.* The walk's own statement forced onto every tier under
the threshold and the empty filter, where it has next to nothing to find:
29 ms for ~1,000 matches and 145–147 ms for 90 or fewer at 100,000 rows,
395 ms (900 matches), 1,193 ms (99) and 1,065 ms (none) at a million, and
85–99 ms at ten million — the bounds hold it to about a second whatever the
table, which is what they are for, and the function never sends those filters
there.

*What was not corrected, and where the correction lives.* The ticket asked
for 014's header to be corrected where its arithmetic does not hold. It does
not hold, and the header is not edited: migrations are append-only and
checksummed — the migrator prints `ALREADY APPLIED BUT FILE CHANGED` and exits
non-zero on any edited migration (change 56 made `--reapply` refuse the same
way), so a comment fix in 014 would cost every deployment a hand edit of
`schema_migrations`. The correction is this section, the bench's own header,
and a line in the header of the next migration that redefines
`match_thoughts`; 019 and 020 carry 014's body comment ("the seeded bounds
are its ceiling on tables past ~2.5 million rows") verbatim, as snapshots do,
and the redefinition retires it there.

**Not done here.** A hundred million rows (above: the machine it needs). The
recall floor on real embeddings rather than random vectors, and the
`ef_search` that follows from it (SMD-1465). SMD-969 asked whether the
*unfiltered* candidate scan reaches the HNSW index at scale: at 64 dimensions
it does at every scale here (section A's row counts and the default path's
slope, 1.8 → 3.3 → 7.0 → 17.7 ms), and at the shipped width change 36
measured it to 100,000 rows, where the answer was no until 019; the shipped
width at a million rows is 4 GB of vectors a run this bench has not made.
SMD-958 (change 32) built beside this body and SMD-945 (change 37) redefined
it on this body; neither reintroduced the post-filter.

### 29. A lease per thought, and the re-embed that proves it

Migration 015 and `db/reembed.ts` (Linear SMD-946). Every bulk pass over the
corpus was single-threaded or racy: two workers that both select "the next
unprocessed thoughts" pick overlapping rows, and a script that walks the table
once cannot be resumed after it dies. Changing the embedding model — which
`db/config.mjs` has said since change 15 means re-embedding every row — had no
tool at all. Three earlier changes deferred a backfill to this ticket by name
(013's header, change 27's whole-content vector, the README's chunk-context
section).

**The table.** `thought_work_claims`, ported from `schemas/thought-work-claims`:
one row per (thought, job key). `enqueue_thoughts` builds the pool,
`claim_thoughts` hands out batches under a TTL lease, `release_thought` and
`release_claims_for_worker` finish or hand back. Four departures from
upstream, each argued in the header; three are below and the fourth is that
terminal rows stay, as the record of the pass, and block re-enqueue. The database picks the batch with `SELECT
… FOR UPDATE SKIP LOCKED` — upstream's workers chose their own candidate ids and
the claim only arbitrated, so every worker selected the same newest page and
the losers backed off, a symptom its own README lists under Troubleshooting.
The ticket's framing needed one correction on the way: upstream's claim is
race-safe as it stands (the primary key and `ON CONFLICT DO NOTHING` let exactly
one inserter win); what `SKIP LOCKED` buys is selection that does not contend,
and the status predicate re-evaluated under READ COMMITTED is what keeps a
lease committed a moment earlier from being handed out twice. Both are needed
and the header says which does what. Second, an expired lease returns to the
pool rather than being deleted, so `attempt_count` and `last_error` survive,
and after three expiries a row is marked failed — a thought that kills every
worker that touches it must not cycle for ever. Third, nothing for Supabase.

**The proof is concurrent, because a sequential one passes against a broken
implementation** — the ticket's own warning, and true: on PGlite's single
connection two claims in a row are disjoint whether or not `SKIP LOCKED` does
anything. `db/test-live.ts` [8] holds ten leases open in one transaction while
another connection claims under a 2 s `lock_timeout` that a wait would trip,
then races four workers on four connections through a 600-row pool and asserts
on ids: none claimed twice, the union exactly the pool. A worker dies on a 1 s
lease and a second worker receives its rows after expiry, on attempt 2; the
dead one, back late, cannot release them.

**The claim's cost was not flat, and the first measurement said so.** The first
draft took "any sixteen pending rows", and at 100,000 rows in a container the
claim went from 0.48 ms at the start of the pass to 2.90 ms at the end —
`VACUUM` at the halfway point changing nothing, which ruled out the dead index
entries the draft header had blamed. The planner was serving it with a
sequential scan that stops after sixteen hits: the cheapest estimate, correct at
the start, and linear in the done rows by the end because they sit at the front
of the heap. `ORDER BY enqueued_at` over a partial index on the pending rows
makes a sequential scan sort the whole pool, so the index wins whatever the
statistics say: 0.48 ms first hundred, 0.56 ms at 50,000 done, 0.47 ms last
hundred, against a 0.15 ms round trip. [8] asserts the plan and the ratio at
10,000 rows. The other planner trap — a large enqueue leaving statistics that
describe the table before it — is closed by an `ANALYZE` inside
`enqueue_thoughts` whenever it added rows, so every consumer gets it rather than
the one that knew to wait a minute for autovacuum.

**The consumer.** `db/reembed.ts` walks the corpus through the claims with N
workers, resumes where it stopped, and re-embeds *exactly as a capture would*,
because the server's embedding path is now `server-portable/embed.ts` and both
call it. That extraction is the one change to the server here and it is a pure
move: chunking, the blurb rule, the prompt template, the whole-content-then-
head-window fallback and the width check are unchanged in what they decide, and
the six suites that exercise them pass unchanged. A second copy in a script
would have been this fork's recurring defect — a value defined twice — with the
value being every stored vector. The write goes through `update_thought`, so
chunks are replaced wholesale as on an edit, an `if_unchanged_since` race
re-reads instead of letting a stale vector win, and the tool is also the
backfill the three earlier changes deferred: a long thought captured before
change 27 gets its whole-content vector, and a corpus captured under one
`OB1_CHUNK_CONTEXT` setting is brought to the current one under a job key of
its own (`--job`).

**Same width only.** `thoughts.embedding` is `vector(N)` and N is baked into
two columns, two HNSW indexes and every function signature. The tool refuses a
configured width that differs from the column's, because a width change is a
migration that does not exist yet, not a re-embed. A model change needs
`--switch-model` and records the new model in `ob1_config` first, so a server
configured for it passes preflight and can be switched; until the pass finishes
searches mix two models' vectors, `--status` says how far along it is, and a
re-run adds anything captured meanwhile. Failed rows are terminal until
`--retry-failed`; the run exits 1 while any remain and names them.

**The audit premise in the ticket was false.** SMD-946 says a re-embed is an
update, so a bulk pass writes an audit row per thought and doubles the audit
table — "correct and wanted, note it, do not suppress it." Migration 008's
trigger diffs the embedding's *presence*, not its value: a vector replaced by a
vector is `{}`, and `{}` was ruled not-an-event when 008 stopped a repeated
import from writing ten thousand empty rows. So a full re-embed writes no audit
rows for rows that had a vector, and exactly one for a row that had none.
`test-live.ts` [9] asserts one row for thirty-eight thoughts (thirty-four when
this was written; changes 33 and 34 added two each). Nothing was
suppressed; the trigger never recorded this, and the claim row — job key,
worker, attempts, error, times — is the per-thought record of the pass. Making
the trigger record vector changes would be a new migration and would reintroduce
the doubling the ticket worried about; it is left as a decision rather than made
in passing.

**What the first review pass found, and what it changed.** Two defects that
predate this change and that the extraction put in the touched code. The prompt
templates were applied with `String.replace` and a string replacement, which
reads `$&`, `$'` and `$$` in the thought's text as substitution patterns — a
price written `$$5` embedded as `$5`, and a query containing `$&` became the
template's placeholder; fixed once, in `db/config.mjs`, which `embed.ts` now
calls instead of keeping its own copy. And `OB1_CHUNK_OVERLAP=""` resolved to
zero overlap rather than the 150 default, while `deploy/compose.yaml` forwards
every optional variable as `${VAR:-}` — so **every long capture made through
the compose stack was windowed with no overlap**, and a re-embed from a shell
would have re-windowed them differently. Empty now means unset, as
`db/config.mjs` always said; the re-embed is the backfill. In the new code: the
whole-content fallback latched on any 4xx, so one 429 in a bulk pass would have
downgraded every later long thought to its head window while recording success
— it latches on 400 and 413 only now, and the pass counts the fallbacks it did
make; a worker's `finally` returned its leases only on a signal, so a database
error stranded them for the TTL and a re-run reported nothing to do with exit 0
— it releases unconditionally now, and a run exits 1 while any row is leased;
a window whose blurb failed under `OB1_CHUNK_CONTEXT=on` was recorded succeeded
and terminal — it is a failure now, so `--retry-failed` can revisit it;
`--retry-failed` did not reset the attempt count; a second Ctrl-C could not end
a run parked on a hung provider. `test-thoughts.ts` [7] and `test-live.ts` [9]
cover each. Three findings went to tickets rather than code: the fallback as a
per-row outcome (SMD-1021 — fixed in change 34), `update_thought` refusing unchanged content that
duplicates a pre-fingerprint row (SMD-1022 — fixed in change 33), and lease
renewal (SMD-1023).

**A second pass, and the stopping signal.** Three of its ten findings were in
code the first pass added, which is the sign the loop is converging rather than
finding new ground; what it added was small. The stale-read guard was passed the
raw `updated_at`, which 001 leaves nullable, so a row loaded around
`upsert_thought` had no guard at all — the worker now selects the
`COALESCE(updated_at, created_at)` the guard compares against. A blurb failure
under chunk context was declared before the write, leaving the old model's
vector in place; the write comes first now and the claim is what fails. A
transient failure of the whole-content call (429, 5xx) stored the head window
and recorded success — terminal, unreachable by `--retry-failed` — while the
same failure on a window embedding was retryable; `embedCapture` now reports
whether the provider has refused the length outright, and the pass records the
transient case failed with the head window stored. A run whose every worker
stopped on a database error exited 0 with rows pending; it exits 1. A
`release_thought` that returned false for a deleted thought was reported as a
lease problem. The chunk-context template fill moved into `db/config.mjs` and
`evals/eval-contextual.ts` uses it, so the harness prompts as the server does.
The 1 s lease in the live suite became 2 s. Writing the new model into
`ob1_config` before the pass stays as it is — it is what lets the server be
switched, and a later run resumes the same key — and preflight not seeing an
incomplete pass is SMD-1024 (fixed in change 35).

**Not done here.** Preflight did not report an incomplete pass (`--status`
did; change 35 made preflight do so); a width-changing migration; the
entity-extraction consumer (SMD-947), which this exists for. `deploy/compose.yaml` does not run the tool — it needs
the provider, and runs from a checkout.

### 30. Entities and relationships — a structured layer, and what a 7B model gets right

Migration 016, `db/extract-entities.ts` and `server-portable/entities.ts`
(Linear SMD-947). Every thought was opaque text plus the `metadata` the capture
model attached; nothing recorded that two thoughts mention the same person or
that one system depends on another, so "everything touching X, and what X
connects to" could not be asked. This was built as the prerequisite for SMD-948
(GraphRAG — measured in change 31 and not built), and is the second consumer of
change 29's lease table.

**A rewrite, not a port, as the ticket predicted.** `schemas/entity-extraction`
carries 36 Supabase couplings and an Edge Function worker. What survived is the
shape — typed entities, evidence-bearing mentions, edges with confidence — and
the worker's two good ideas, the untrusted-content delimiter with escaped close
tags and the injection instruction. What changed, each with a reason in the
migration header: **evidence is the edge** (one row per thought, from, to,
relation; support is a count; a deleted thought's edges go by foreign key and no
counter drifts), **no queue table** (a trigger enqueues into
`thought_work_claims`; `claim_thoughts` is the claim), **re-extraction converges
by construction** (`record_thought_entities` replaces a thought's rows and
prunes what nothing references), and nothing for Supabase.

**The resolution rule is decided, written down and tested — and it is strict.**
"Postgres" and "postgres" are one entity; "Postgres" and "PostgreSQL" are two.
`normalize_entity_name` is NFKC, lower case, surrounding punctuation stripped,
whitespace collapsed, and nothing fuzzier is ever applied automatically. The
alternatives — trigram merging, or asking the model to canonicalise against the
existing table — make the result depend on processing order and merge "Anita"
with "Anika" as readily as the two Postgres spellings; a wrong merge is far
harder to undo than a duplicate is to merge. Aliases the model volunteers are
recorded and never used to resolve; `merge_entities` is the human step, and it
refuses across types. The corpus run below reports what the strict rule leaves
behind, as a count.

**The cost is opt-in, and the trigger makes it so.** Extraction is an LLM call
per thought, recurring. Migration 016's trigger enqueues only when
`ob1_config.entity_extraction_key` is set, and only the worker sets it, on its
first run — so the migration adds one catalog lookup per capture to a
deployment that never runs the worker, and nothing more. The worker takes
`--dry-run` to count before sending, `--limit` to look at twenty before
committing to thousands, and `--follow` to keep extracting new captures as a
long-running process.

**The worker authenticates like any client.** `OB1_WORKER_KEY` is a raw key
whose hash is in `MCP_ACCESS_KEYS`; the run resolves it through change 23's
`resolve_agent` to a stable agent id that every mention and edge carries, and a
revoked key refuses to run. The ticket expected the worker to appear in
`thought_audit` under that id; it does not, because it never mutates `thoughts`
— the edit and delete that feed it are audited as the tools that made them, and
`test-live.ts` [10] asserts zero audit rows from the worker beside the agent id
on every row it did write.

**What the model gets right, on labelled captures.** `evals/eval-entities.ts`
scores fourteen captures through the real write path and the real rule, over
(type, normalised name). `qwen2.5:7b` at temperature 0:

| prompt shape | precision | recall | injection obeyed |
| --- | ---: | ---: | --- |
| one user message, rules and content (upstream's) | **0.68** | **0.84** | yes |
| rules as system message, content as user message | 0.51 | 0.76 | yes |

The second row is the textbook defence against an instruction embedded in the
content, and it was measured rather than adopted: it cost accuracy and stopped
nothing. So the single message ships, and the weakness is written down in three
places — **a 7B model follows an instruction written into a thought**, and the
eval keeps the case so a model that does better shows it. The other forbidden
hit is "the dentist on Ashworth Road" giving `dentist` as a person. The misses
are dominated by the model returning "Postgres" where the label wants
"PostgreSQL" — the duplicate the rule will not merge — and the extras are mostly
defensible against a strict label set ("observability migration" as a project).
Run to run at temperature 0 the score moved by one marginal extra, so these are
±0.02.

**The full pass, on the real corpus.** 441 Linear issues, 589,948 characters,
`qwen2.5:7b` on Ollama on this machine, through the worker itself:

| run | workers | per-call timeout | wall clock | per thought | timed out |
| --- | ---: | ---: | ---: | ---: | ---: |
| first | 2 | 120 s | 4,941 s (82 min) | 11.2 s | 21 of 441 |
| second | 1 | 300 s | 6,793 s (113 min) | 15.4 s | 11 of 441 |
| third | 2 | 300 s | 6,480 s (108 min) | 14.7 s | 19 of 441 |

The first run's 9,870 s of model time inside a 4,941 s wall clock was read as
two calls queueing behind each other on a one-at-a-time Ollama, and the worker
briefly defaulted to one worker on that reading. The second run appeared to
refute it — one worker was 37% slower — and this section said so. The third
run (change 31, made to refresh the extraction dump) is the like-for-like pair
the first two were not, same timeout and twice the workers, and it is 4.6%
faster, not 37%: the earlier gap was the timeout budget, 120 s against 300 s
per stuck document, and the first reading was closer to right. Ollama here
mostly serialises; two workers stay the default because they cost nothing and
recover a little. The timeouts are what they look like — long documents whose
extraction takes a 7B model minutes — not queue time, and which documents time
out varies between passes. **Roughly two hours
for 441 issues, and recurring for every capture after.** On a hosted provider
that is a bill; on this machine it is the fan.

What came out, from the second run and reproduced exactly by replaying its
dumped answers through the database in 0.8 s (the replay is how a rule change
is measured without another two hours): 2,044 entities — 861 tools, 645 topics,
447 projects, 42 people, 28 organizations, 21 places — 2,899 mentions across
427 thoughts (14 yielded nothing; median six per thought, max 47), 2,002 edges
of which 1,129 are `uses`. The most-mentioned entities are the ones an engineer
on this corpus would name: Linear, pnpm, Healthie, Auth0, Sentry, Terraform,
Slack, PostHog, GitHub. 1,767 of the 2,044 entities are mentioned by exactly
one thought: the graph is a long tail with a small connected core, which is the
shape SMD-948 had to work with — and, change 31 found, one reason it lost.

**What the strict rule leaves, and what it cost to find out.** The first run
reported 1,853 near-duplicate pairs by a loose metric (same type, trigram
similarity at least 0.6 or one name inside the other), and every one of the
fifteen closest was a separator variant — "anonymous-intake" beside "anonymous
intake", "state_of_care" beside "State of Care", "siggymd/infrastructure"
beside "SiggyMD infrastructure". Folding hyphen, underscore, slash and hash
into spaces is still a spelling rule, so the rule gained it. After that the
metric still reports 1,922 pairs, and the closest are now the ones a rule
should not decide: "Medication Course" and "Medication Courses", "Anonymous
Intake" and "anonymouse intake" (a typo), a module path against its file path,
"Engineering Cycle 2" against "Engineering Cycle 3" (not a duplicate at all).
The metric is loose on purpose — it is a review list for `merge_entities`, not
a count of errors — and the number is reported as what it is.

**Precision on the corpus, graded by hand.** The run writes a 25-thought sample
with what was extracted from each; this grading is mine, not a second
annotator's. About 60% of the extracted entities are things a person would
accept as an entity of that type — the vendors, the services, the named
projects. About a quarter are code artifacts the model typed as tools or
projects: file paths, issue identifiers (`SMD-747`), enum values
(`clinical_hold`), a Sentry event id. Identifiable and specific, so the prompt's
rules admit them, and of doubtful value in a graph. The rest, roughly 15%, are
wrong: `payer` as an organization, `provider` and `Beta users` as people, `error`
and `reason` as topics, `Claude` as a person. Confidence is 1.00 on almost
every row, so it carries no information on this model. The eleven timed-out
thoughts are the longest issues, and a re-run with `--retry-failed --timeout
900` would finish them at a cost of another hour.

**What the review pass found, and what it changed.** The orphan prune at the
end of `record_thought_entities` decided "nothing references this entity" from
its own snapshot, and under READ COMMITTED another worker could have committed
a mention a moment earlier: the prune waited on that worker's row lock,
re-checked its WHERE against the new row, but its `NOT EXISTS` still saw the
old snapshot, deleted the entity, and `ON DELETE CASCADE` took the other
worker's committed mention with it — both calls reporting ok. The entity side
of the keys is now `RESTRICT`, so that race is a foreign-key error the prune
catches and the entity stays; the prune is also scoped to the entities the
thought's own deleted rows pointed at. A NULL `content_fingerprint` (rows from
before migration 003) silenced the stale-content guard; both sides now compute
the fingerprint from the content through one function. A run under another
model's key rewrote the recorded key and mixed extractions per thought; it needs
`--switch-key`, as a re-embed needs `--switch-model`. The identity block
registered an agent under `--dry-run`, minted a phantom write-scoped agent when
`MCP_ACCESS_KEYS` was unset, and hardcoded the scope; it now requires the key
to be in `MCP_ACCESS_KEYS`, registers the record's own name and scope, and does
not run in the read-only modes. A 429 or a refused connection failed the
thought terminally and both workers marched through the pool doing the same; a
transient error now pauses and retries, and stops the worker with its leases
returned if the provider stays down. A batch of four at a 300 s timeout could
outlive a 900 s lease; the default is one thought per claim and a batch that
could outlive its lease is refused. The stale-retry re-extracted a thought the
trigger had already re-queued; it is reported as superseded and left to the
pool. A bare `--limit` meant no limit and would have sent the backlog to the
model; it is refused. Same name under two types picked an edge endpoint by heap
order; the pick is deterministic and counted. The eval skipped a thrown call
without counting its labels, inflating recall. Declined: folding the worker
into a shared framework with `reembed.ts`, which is its own change.

**A second pass, six of ten findings in the first pass's code — the stopping
signal — and two of them defects in its fixes.** The NULL-fingerprint fix was
half done: the function computed the fingerprint but the worker still passed
the raw column, so the guard was still skipped; one `COALESCE`. The prune's
exception guard was all-or-nothing, so one concurrent mention aborted a
table-wide prune and reported zero; the prune now locks its candidates
`FOR UPDATE` and deletes in a fresh statement, which is what makes it correct,
and the `RESTRICT` key stays as the loud failure if that ordering is ever lost.
The error classification treated every 4xx but 429 as the thought's fault, so
a provider rejecting a request field marked the pool failed in a minute; a 400
about the request or an auth error now stops every worker with exit 2 and marks
nothing, and a thought that reliably draws a 500 is recorded failed after the
retries instead of cycling for ever. A human merge was undone by the next
extraction that said the loser's name: `merged_from` now routes those to the
survivor, the one list that resolves. `{}` from the model parsed as nothing
found and made the thought terminal; the `entities` array is required.
`--limit` reserves at claim time so two workers cannot each take one on a
limit of one. Superseded re-queues explicitly rather than trusting the trigger.
Two test defects: a vacuous assertion (a raw `UPDATE` left the old fingerprint
so the re-capture inserted a new row) and the eval scoring a reversed
directional relation as a hit. Stopped here.

**Not done here.** A read API for the graph — the MCP tools do not expose
entities yet; SMD-948 was to decide the shape and decided (change 31) that the
shape is not retrieval, so a read API is an unticketed follow-up; a `list_thoughts` filter by
entity; injection resistance on a small model; and typed reasoning edges
between thoughts (`schemas/typed-reasoning-edges`), which the ticket names as a
later issue.

### 31. GraphRAG, measured — and not built

`evals/eval-graphrag.ts` and `evals/graphrag-questions.json` (Linear SMD-948).
No migration, no server change, no new tool: this change is a measurement and
the decision it supports. The ticket asked whether retrieval over change 30's
entity graph beats the vector search the product ships, warned that GraphRAG's
published wins are on corpora unlike ours, that community summaries are a
standing cost, and that a measured "not worth it at our scale" would be a
successful outcome. It is the outcome.

**The question set came first**, as the ticket required, so the graph was
judged on questions written without it: 27 over the 441-issue Linear corpus,
each answered by two or more documents, labelled by hand from the issue bodies
— seventeen multi-hop, seven aggregation, three about the shape of the corpus,
89 expected documents. Only the questions are committed; the corpus is internal
and stays in `/tmp`. The metric is retrieval, did the expected documents come
back in the top K, because any answer is generated from what came back.

**Five arms, no framework.** Vector (`match_thoughts`); a local graph walk
written in one SQL statement over `ob1_entities`, `thought_entities` and
`ob1_entity_edges` — question entities found by the extraction prompt, the
product's resolution rule, trigram similarity and a whole-word literal match
(more generous than the product's rule, on purpose), IDF-weighted, one hop at
0.3 with the same rarity cap on hop targets, thoughts ranked by summed entity
weight; reciprocal-rank fusion of those two;
global mode — label-propagation communities over co-mention weights, one
generated summary each, question matched to summaries, thoughts of the best
two communities vector-ranked; and `search_thoughts_keyword` (change 26) with
the needle a person would type, on the ten questions that have one. The graph
is replayed from a dumped extraction pass, so the eval does not repeat the
two-hour extraction; the pass scored here was re-run after the review pass
below so that the dump's fingerprints verify against the loaded text.

**Vector wins every comparison.** Recall@10 0.98 and 25 of 27 questions
complete, every multi-hop question among them; the local graph 0.51 and 7,
losing on 20 questions and winning on none; fusion 0.92 and 21 — mixing the
graph in makes vector worse on five questions and better on none; global 0.50,
half the baseline and near zero on the corpus-level questions. At K = 5 the
order is the same and the gaps are wider. The reasons are in
`evals/README.md`: the question-side and document-side extractions do not
agree on names; 1,739 of 2,004 entities are mentioned once, so a hop reaches
nothing; common seeds
dominate until removed and removing them leaves recall unchanged; communities
depend on the node visiting order (18, 6 and 17 from the same graph until the
order was pinned to the table's unique key). A review pass found the first
version of the harness generous to its own conclusion in small ways — MRR taken
over the whole returned list, a substring seed match that read "Expo" out of
"exposes", hubs re-entering through the hop, an unordered title list feeding
each community summary — and fixing them moved the graph arm by a point or
two and the global arm from 0.25–0.33 to 0.57 on the first dump (0.50 on the
re-extracted one). The same pass found the corpus loader hashing the wrong
text for its fingerprints — `'\s+'` in a Bun `sql` template literal reaches
Postgres as `'s+'` — in this harness and in the entity eval it was copied
from; both call `content_fingerprint_of()` now, and the corpus was
re-extracted so the dump verifies. The decision did not move.

**The set was too easy for vector, and that is the finding, not a flaw in the
set.** Documents about one feature in a tracker share vocabulary — the backend
issue and the client issue consuming it name the same endpoint and field — so
the documents a multi-hop question combines are already near neighbours of the
question. GraphRAG earns its cost where documents are joined by an entity and
nothing else; on this corpus those questions were hard to find, which is
itself the answer to whether the corpus is the kind that needs a graph.

**Where vector misses, keyword mostly has it.** The only misses are two of the
six `Decision:` records and two of the eight `Promote …` issues, both series
named by a literal string; `search_thoughts_keyword` returns the first set
complete and half of the second, scored by the same rule as every arm. The
headroom that exists is a ranking problem inside a tool that ships, not a case
for a graph.

**Decision: not built.** No graph retrieval mode, no fusion step, no build
ticket. The entity layer stays for what it is for — "what does X connect to",
an entity filter, the UI a graph makes possible — and because a corpus of a
different shape, people and projects across many sources with little shared
wording, could measure differently. That is a re-run of `bun run graphrag`
against that corpus's own question set, and the rule for reading it does not
change: the graph has to beat `match_thoughts` on questions someone actually
asked. SMD-1039 asks that question of a literature corpus with a published
question set, where the failure mode these techniques target does exist; a
win there is a reason to re-ask the product question on a corpus of the
product's shape, not a reason to build.

### 32. Hybrid ranking — one fused search behind `search` and `search_thoughts`

Migration 017 (Linear SMD-958). Since change 26, retrieval was two disjoint
tools: `search_thoughts` and the ChatGPT-compat `search` called `match_thoughts`,
and `search_thoughts_keyword` was exact substring. 012 chose that deliberately
and left two things open. A query that is partly a literal and partly a
description — "the scheduler timeout around `ERR_POSTGRES_SERVER_ERROR`" — was
served badly by both, and nothing routed. And the compat `search` could never
reach keyword search at all: ChatGPT matches on the exact `search`/`fetch`
shapes, so that tool cannot grow a `mode` parameter, and for an identifier it
got what 012 measured — 37 of 60 not in the top ten. A third tool fixes
neither; fusing behind the tools that exist does. `search_thoughts_hybrid` is
what both now call; `search_thoughts_keyword` stays as the exact tool with its
paging and its true `total_count`.

**The fusion is asymmetric, and each half has a reason.** Reciprocal rank
fusion on the vector arm — `1/(60 + rank)`, the conventional constant — because
a cosine similarity and an occurrence count are not commensurable and score
blending would need a normalisation nobody can justify. But not RRF on the
keyword arm: `search_thoughts_keyword` orders by occurrences then recency, which
is a stable page order and not a relevance order, and RRF would read its rank
positions as evidence. So the keyword arm contributes *presence*: each literal
a row contains is worth exactly a rank-1 hit, `1/61`, and two literals beat one.
Among rows the keyword arm found, the order is the vector's judgement — each
hit's own cosine similarity, computed directly (a primary-key probe, best of
the thought's vector and its chunks, the rule `match_thoughts` uses), as the
tiebreak. A row both arms return therefore outranks any row only one returns,
and **a query with no identifier in it returns `match_thoughts`' rows in
`match_thoughts`' order** — up to ties in similarity, which `match_thoughts`
leaves to the plan and this function breaks by id — asserted in
`db/test-schema.ts` at three thresholds.

**The needles come from one rule, in SQL.** `extract_search_needles` takes
quoted or backticked spans as written, then identifier-shaped tokens — a digit
or underscore but not a bare number, an interior slash or dot, an interior
capital — three to 64 characters, de-duplicated, at most eight. Ordinary words
are left to the vector arm: `harpsichord` has an embedding, `PGRST202` does
not. A needle found in more than 100 thoughts is reported as common and not
used: 100 is the keyword page cap, so within it the presence boost lands on
every row containing the literal, and above it on an arbitrary hundred.

**The gate.** Embedding `SMD-506` alone is noise — 012 measured the containing
thought at rank 150. When the query minus its needles has nothing the English
text-search parser keeps as a lexeme, the vector arm's rank term is dropped;
exact hits come first and the rest follow by similarity. With a content word
left, the arms are peers. Without the gate an identifier query ties its exact
hit against the vector's meaningless top row and the similarity tiebreak hands
first place to the noise: measured, MRR 0.925 at ten results and 0.850 at a
hundred, against 1.000 with it.

**The eval came before the ranker, because the existing one could not judge
it.** `evals/eval-keyword.ts` selects tokens unique to one document, so any
fusion containing the keyword arm scores ~100% there, good blend or bad.
`evals/eval-hybrid.ts` builds four sets from the 441-issue corpus, each
mechanically and each stated: **identifier** (eval-keyword's 60, the token
alone), **semantic** (eval-real's 441, title → body), **mixed** (38: documents
vector misses at rank 1 on their title, plus an identifier from the body found
in 2–30 documents and absent from the document vector wrongly ranked first),
**decoy** (60: documents vector gets right at rank 1, plus a token unique to a
*different* document). Every arm and six variants answer the same 599 queries;
a control asserts the shipped function's order equals the harness's fusion on
every one, and that every identifier query is hapax to the SQL function. At
the tools' own setting — ten results, threshold 0.5:

| set | n | arm | R@1 | R@5 | not in top-10 | MRR |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| identifier | 60 | vector | 10% | 15% | 51 | 0.116 |
| | | keyword | 100% | 100% | 0 | 1.000 |
| | | **hybrid** | **100%** | **100%** | **0** | **1.000** |
| semantic | 441 | vector | 83% | 97% | 8 | 0.894 |
| | | keyword | 10% | 13% | 376 | 0.111 |
| | | **hybrid** | **83%** | **97%** | **9** | **0.895** |
| mixed | 38 | vector | 47% | 89% | 1 | 0.656 |
| | | keyword | 26% | 84% | 0 | 0.503 |
| | | **hybrid** | **95%** | **100%** | **0** | **0.974** |
| decoy | 60 | vector | 88% | 98% | 0 | 0.930 |
| | | keyword | 7% | 7% | 56 | 0.067 |
| | | **hybrid** | **75%** | **98%** | **0** | **0.850** |

Hybrid matches keyword on the identifier set, matches vector on the semantic
set (one more miss in 441 at ten results, one more at a hundred), and on the
mixed set — the case the ticket was about — takes R@1 from 47% to 95%, above
either arm on twelve queries and below neither on any.

**The decoy set is the cost, and it is stated rather than tuned away.** A
strong semantic match with a wrong identifier appended loses first place 15
times in 60, to the document that contains the identifier *and* is among the
ten nearest by meaning — "both arms" beating "one" as designed. R@5 does not
move. Whether that is wrong depends on which half the person meant, and the
function cannot know; what it can do is say so, and every row carries the
needles it matched.

**The window is N, and the eval chose it.** The first draft over-fetched the
vector arm to `least(100, greatest(4N, 40))`, the usual RRF precaution against
cutting a winner before fusion. The precaution does not apply here — keyword
hits carry their own similarity, so nothing outside the window is lost — and it
had a cost: "both arms" at F = 40 meant "contains the literal and is among the
9% nearest", which promoted the decoy 19 times in 60 and put one more semantic
query out of the top ten. At F = N it means "contains the literal and the
semantic tool would have returned it". Every other set was unchanged or better.
Plain RRF over both lists, the fusion the ticket named as the one not to
inherit, was measured beside it: 0.867 on semantic against 0.894, 0.947 on
mixed against 0.974, 0.925 on identifier against 1.000. Rarity-weighted
presence (`ln(T/df)/ln(T)`) was measured too: one semantic miss fewer in 441
and nothing else. It is not shipped.

**No paging, on purpose.** 012's `total_count` is exact and cheap because its
ordering already materialises the whole match set; a fused result's total is
the size of a union neither arm knows without running unbounded. Rather than
report a number that is not a count, the shape has no total and no offset; the
tool description says so and points at the exact tool for paging. Fixed top-N,
N clamped to 1–100.

**Both indexes are reached through the wrapper, and the bench found the one
thing reading could not.** `db/bench-hybrid.ts`, 10,000 rows, reads
`pg_stat_user_indexes.idx_scan` for the HNSW and trigram indexes before and
after thirteen calls (the generic-plan probe from change 26): both counters
advance by thirteen. A control plants a decoy only an unescaped pattern would
match and refuses to time a wrong result. Its first run then showed the fused
call at **15 ms where its two arms cost 1.3 ms together.** Neither arm was
slow. The planner cannot see into a plpgsql function and estimates 1,000 rows
from each function scan; the first draft joined `thoughts` at the end for the
row's columns, so the estimate was a ~6,000-row hash join over the whole table,
and its cost — 216,000 against a real few hundred — crossed `jit_above_cost`.
PostgreSQL JIT-compiled 112 expressions on every call; `auto_explain` with
nested statements showed "Functions: 112", and nothing at the SQL level did.
Two changes, both kept: the function no longer joins `thoughts` (both arms
already return the row, so only a keyword hit outside the vector window touches
the table, by primary key), and it runs with `jit = off`, scoped to the call
like 014's hnsw setting — nothing in it has enough rows for compilation to pay.
After: fused with one needle 1.08 ms against 0.47 + 0.28 for the arms
separately; a query with no needle 0.75 ms against 0.41 for `match_thoughts`
alone, so every ordinary semantic search pays about a third of a millisecond
for the needle rule, the stopword test and the wrapper. A needle in a tenth of
the rows is probed as common and never paged: 1.11 ms, against the 5.12 ms
keyword page it no longer fetches. The trigram counter advances twice per call
with a needle — once for the probe, once for the page.

**What changed for callers.** `search` and `search_thoughts` are hybrid; their
descriptions say what is matched literally. `search_thoughts` renders
`Contains: …` on a matched row, reports `exact match, no vector` for a keyword
hit that has no embedding yet, and leads with the literals it searched for
exactly, the ones no thought contains, the ones too common to use, and whether
the query was literal-only. A third store type,
`ThoughtHybridMatch`, with `similarity` nullable — a shared normaliser keeps
both stores from turning "no vector" into "orthogonal" (`Number(null)` is 0).
`preflight.ts` fails on a database that stops at 016, because the two most-used
tools now need 017. SMD-945 (recency) landed in change 37, in `match_thoughts`
as planned; the fused function ranks its vector arm on `match_thoughts`' `score`,
so rows in the window inherit the blend through their rank — the keyword arm is
boolean here, so age is never counted twice. One
place must be mirrored: a keyword hit outside the window is scored by 017's own
copy of the best-of-vector-and-chunks rule, and the header marks it.

**One review pass, triaged.** Ten confirmed findings; eleven fixes, two tickets,
three declined. The one that mattered most was not in the new code: four
comment lines added to migration 012's header changed its hash, and
`migrate.ts` reports an applied migration whose file changed as drift and exits
1 — every deployed database would have failed its next migrator run while fresh
CI containers passed. 012 is byte-identical to `main` again. The rest: the
hybrid presence check lived only on the SQL branch of preflight while
PostgREST is the default store, so it now probes the function over PostgREST
with an RPC; the literal-only gate stripped needles case-sensitively and
shortest-first, so `SMD-944 smd-944` or `ERR_TIMEOUT ERR_TIMEOUT_LONG` left
lexemes behind and opened the gate — needles are now removed longest-first on
lower-cased text; `e.g.` and `i.e.` passed the identifier test after their
trailing dot was stripped — a dotted or slashed token now needs two characters
together somewhere; the tool header said "Matched exactly on" for a literal no
thought contained — it says "Searched exactly for" and names the absent ones;
`test-support.ts`'s drop list lacked the two new functions; the `threshold`
parameter's narrowed meaning is described; a NULL threshold is coalesced like
the other parameters; the common-needle rule is written as the completeness
test (rows fetched = `total_count`) rather than the constant 100; the eval's
decoy builder guards an empty identifier set; the vector-cache override is a
prefix so two text rules cannot share one file; and the stride sampler has one
definition. Tickets: SMD-1040 (`PostgrestStore.matchThoughts` is still a bare
cast, so `created_at` differs in format between stores on the vector path;
done in change 52) and
SMD-1041 (declare `ROWS` on `match_thoughts` and `search_thoughts_keyword` in
their own migrations — a hint set from 017 would be reset by the next
re-apply of 014; done in change 36). Declined: rewriting the CTEs as a FULL OUTER JOIN, moving
`eval-graphrag.ts` onto the shared vector cache in this PR, and de-duplicating
the standalone benches' helpers. The numbers above did not move.

**A second pass, triaged: ten fixes, none ticketed.** The tool's header
derived "no thought contains X" from the page it had, so a literal whose only
hit was cut by `limit` was reported absent — the function now returns
`needle_counts` beside `needles`, and the tool tells absent from "outside the
top N" by the count. The tool descriptions promised an exact hit "whatever its
similarity"; they now state the real contract (rare enough to match, within
the limit) and no longer hard-code the page size. A quoted span over 64
characters was rejected as a needle and also blanked before the identifier
pass, so a pasted error message in quotes lost its `ERR_*` code — only an
accepted span is blanked now. An empty result said nothing about why; the tool
makes one more call at no threshold to report an absent or too-common literal.
An only-common literal-only query printed two contradictory notes. The eval
harness's copy of the needle rule and the gate had drifted from the SQL
without the control noticing, because no query exercised the difference — it
reads `needles`, `common_needles` and `literal_only` from the function now. A
non-numeric cap emptied the sets instead of meaning no cap. `eval-graphrag.ts`
moved onto the shared vector cache after all (verified against its dump; same
numbers). The dead quote-stripping line in the gate is gone. And the PostgREST
store gained the `hybridThoughts` conformance test it lacked — which
immediately found that the SQL-backed compat client hands an `int[]` back as a
typed array, for which `Array.isArray` is false, so `needleCounts` was empty
on that path until the normaliser accepted array-likes. Declined: `ALTER
FUNCTION … ROWS` inside 017 (SMD-1041; a re-apply of 014 would reset it — done
in change 36),
and three cosmetic duplications.

**A third pass, triaged: ten fixes, and the stop.** Three were behaviour.
Ordinals and units — `1st`, `3pm`, `24h`, `10x` — passed the digit rule, and as
substrings sat in every `21st`; reproduced, six junk rows pushed the right
answer from second to eighth. They are excluded. A common needle was paged and
then discarded, and 012's page materialises its whole match set to count it,
so a quoted `"the"` on a large brain would have paid 012's worst case for
nothing; a probe for a 101st matching row now runs first, and a quoted span the
English parser keeps nothing of is not a needle at all. Preflight blamed 017
for a missing 012, because the error text is the same and the PostgREST branch
never checked 012; it probes the keyword function first and names the right
migration, and the 017 check has the test the 012 check always had. The rest
was wording made true — an exact hit is ranked *with* the strongest semantic
results, not ahead of them; "row for row" holds up to similarity ties, which
`match_thoughts` leaves to the plan and this function breaks by id; recency
from SMD-945 is inherited only inside the vector window, and the probe that
scores a keyword hit outside it is marked as the copy that must be mirrored —
plus two harness controls that could report the wrong thing, the mixed set's
appended token now checked against the product's rule, and stale numbers in
this file and `db/README.md`. Nothing in this pass touched the fusion itself,
which is the signal to stop reviewing and open the PR.

### 33. An unchanged edit is never a duplicate — the re-embed stops failing legacy twins

Migration 018 (Linear SMD-1022, found by the first review pass of change 29).
`update_thought` ran its duplicate check whenever `p_content` was given: another
row carrying the same fingerprint meant `DUPLICATE_CONTENT`. The check assumed
the text was new. `db/reembed.ts` passes each row its own unchanged text,
because that is the only way to make `update_thought` replace the embedding and
the chunk rows — and for one class of row the check then refused the row's own
text. Migration 003 added `content_fingerprint` with a partial unique index and
no backfill, so a brain from before it can hold two rows that normalise to the
same text, both with NULL fingerprints; a load that inserted into `thoughts`
directly leaves the same state. Re-embedding the first of the pair gave it a
fingerprint as a side effect. Re-embedding the second found the first and was
refused: failed, exit 1, and `--retry-failed` reproduced it on every run while
`ob1_config` already recorded the new model. Rows from before 003 are the
common case for any brain that predates this fork.

**One writer stays one writer.** The alternative was a dedicated
`reembed_thought` that sets the vector and replaces the chunks without touching
content or fingerprint. It would have copied the stale-read guard, the actor
setting and the chunk replacement out of `update_thought` — a value defined
twice, the defect this fork keeps removing, with every stored vector as the
value. Instead `update_thought` is redefined with one rule: when the new text
normalises to what the row already holds, the edit cannot create a duplicate
that was not already there, so it is not refused. If another row already holds
that key, this row's fingerprint is set to NULL — whatever a raw update around
the function may have left there — so the partial index is never violated, and
the result names the holder: `duplicate_of` when its text is the same, a twin;
`fingerprint_held_by` when its key is stale and this row cannot take the
fingerprint it should have. Otherwise the fingerprint
is written: the backfill 003 never had, one row at a time, now stated rather
than incidental. Editing a thought *into* another thought's text is refused
exactly as before. The hash rule comes from 016's `content_fingerprint_of`
rather than a third inline copy, and 008's actor, 009's millisecond-truncated
guard in the UPDATE itself and 013's `context` are carried forward — the trap
008's header records, checked by name in `pg_proc` by `test-schema.ts` [19].

**The race, closed where it lives.** Two workers reaching the two rows of a
pair at the same moment both passed the check — the first's fingerprint was
uncommitted — and the second then blocked on the unique index and raised
`duplicate key value violates unique constraint "idx_thoughts_fingerprint"`
when the first committed: measured, with the lock line removed. `update_thought`
now takes a transaction-scoped advisory lock on the fingerprint before the
check, for every content write through it that would take a key the row does
not already own, so two edits to one text are serialised and the lookup that
follows is authoritative under READ COMMITTED — the default, and stated as the
precondition it is. `test-live.ts` [6b]
holds the first twin's transaction open on one connection, shows the second
waiting on the *advisory* lock in `pg_locks` rather than on a transaction id,
and gets ok with `duplicate_of` once the first commits. The same lock turns
009's documented race for a genuine edit — two rows edited into the same new
text at once — into `DUPLICATE_CONTENT` instead of a constraint error. It
covered edits only until change 63: `upsert_thought` wrote fingerprints without
it, so a capture of text X committing while an edit to X was in flight still
ended in the edit raising the unique violation, exactly as before this change
(migration 033 takes the same lock in both capture forms). One lock per
edit; deadlock would need a transaction that calls `update_thought` twice with
different texts while another does the reverse, which no caller does.

**What the pass does with it.** `reembed.ts` requires 018 (exit 2 naming the
migration otherwise — a pass against 013's body fails every legacy twin for
ever), says per row when it found a pair, and prints every group of thoughts
sharing one normalised text at the end of a run and under `--status`: one query
over the corpus, hashing every row's text rather than trusting the column, so the
list is the same before, during and after a pass. Both rows are re-embedded;
only one carries the fingerprint, so a later capture of that text merges into
it and not the other. Whether they should be one thought is the operator's
call, and nothing is written to the claim row — that per-row-outcome decision
belonged to SMD-1021, change 34. The `update_thought` tool appends the same note to its
reply, and `normaliseMutation` carries `duplicateOf` for both stores. Stated in
018's header and not fixed: `upsert_thought` capturing text equal to a legacy
NULL-fingerprint row still creates a second row, since `ON CONFLICT` cannot see
a NULL; the pairs query surfaces those too. `test-schema.ts` [19] (at the
default width and at 8), `test-live.ts` [6b] and a legacy pair in [9]'s
fixture, `test-update-delete.ts` [8b].

**A first review pass, triaged: eight fixes, one ticket.** Two were behaviour.
The migration-018 check in `reembed.ts` sat above the read-only branch, so
`--status` and `--dry-run` refused to run on a brain at 017 — a report command
demanding a schema write; it runs only before a pass now. And the CASE that
kept "the row's fingerprint, necessarily NULL" when a duplicate was found kept
whatever was there: a raw update around `update_thought` (upstream's pre-009
path never recomputed the column) leaves a hash describing text the row no
longer holds, and 013 at least refused that row where 018 accepted it and kept
the hash. It writes NULL now, which is what the comment claimed, and [19] plants
the stale case. The rest: the duplicate predicate was written twice behind an
IF/ELSE — one lookup after the lock, one condition for the refusal; the
`duplicates` counter disagreed with the group count by construction (a pair's
first row is never reported) and is gone; `reembed.ts` asked for the field
name `duplicate_of` in `prosrc` where the repo's convention is a contract
sentinel, so 018 carries `ob1:unchanged-edit-not-duplicate` and the pass, and
[19], ask for that; [6b]'s connection A had no `.catch`, so a throw there
would have ended the suite before the tally; and the claim that "writers of one
fingerprint are serialised" was scoped to what is true — edits, under READ
COMMITTED, with `upsert_thought` uncovered — here, in the header, the COMMENT
and `db/README.md`. To a ticket: the one-shot fingerprint backfill 003 never
had (SMD-1042, done in change 41), feasible now that `content_fingerprint_of` exists and the
right fix for every legacy singleton a pass never visits, but a data migration
with its own questions about a full-table hash inside one transaction.

**A second pass, triaged: eight fixes, one ticket, one declined.** Two were
behaviour and both were about trusting a read. "Unchanged" was decided from a
row read without a lock, so a caller passing no `if_unchanged_since` could
read X, have another edit commit Y, and write X back over it as an unchanged
edit — the interleaving 013 refused; the row is read `FOR UPDATE` now, before
the advisory lock, which also puts the two locks in one order and removes the
deadlock a transaction holding a row could have met from one ordinary
concurrent edit. And the lookup trusted the other row's stored hash: a row
whose column still said hash(X) while its text was something else was reported
as the twin, and the operator sent to delete the wrong row. The holder's text is
hashed again; `duplicate_of` means the same text, and a stale holder is
reported as `fingerprint_held_by` instead, with [19] planting both sides of the
stale case. The rest: the pairs report groups by the hash of every row's text
rather than the column, so a stale row is bucketed by what it says and the list
really is the same across a pass; `--status` on a brain at 015 crashed on the
016 function the report needs and now says so in one line; [6b] counts advisory
waiters for B's own backend rather than the whole server; the lock, the second
hash and the lookup are skipped when the locked row already owns the key, which
the unique index makes safe and which is every fingerprinted row a pass
visits; and this section's design paragraph, which still said "left as it is".
To a ticket: taking the same lock in `upsert_thought` (SMD-1043), which would
make "writes of one fingerprint are serialised" simply true and delete the
disclaimers, but redefines two capture overloads on the hot path. Declined:
not writing the fingerprint on an unchanged edit at all — it would leave every
legacy singleton unfingerprinted until SMD-1042 ships (change 41), and a recapture would
create a second row where 013 already merged; the header now states that
arrival order is the ownership rule until SMD-1042 replaces it (change 41 does: oldest by `created_at`, then id).

**A third pass, triaged: ten fixes, and the stop.** Nothing in the rule
itself. Two were in the pass: "DUPLICATE_CONTENT cannot reach here" was false
— `updated_at` is the editing transaction's start time at millisecond
precision, so an edit that began before the worker's read and committed after
it passes the guard, and the worker's text is then a change into another row's
— so the pass treats it as it treats STALE_READ, re-read and retry; and the
pairs report, made to hash every row's text in the second pass, ran on every
`--status`, which is asked repeatedly during a pass, so on a large brain a
cheap probe appeared to hang — it hashes only the rows without a fingerprint
again, and the stale key it would have caught is reported by the pass itself
through `fingerprint_held_by`. The probe for 018 matches the exact signature
the pass calls rather than the name, consults the ledger so a brain adopted
with `--baseline` is told to re-run the body rather than told to apply a
migration the migrator will skip, and `--dry-run` reports the refusal a run
would make instead of a worker plan. Two claims made true: a transaction
holding locks from an earlier call can still deadlock against one ordinary
edit — lock order is per call — and a refused call now returns with the row
locked until the caller's transaction ends, where 013 held nothing. The
`duplicate_of` note no longer asserts that both rows predate deduplication,
since a fresh capture merged around a legacy row produces the same result; it
says what is known and asks the reader to read both before deleting. A
vacuous assertion in `test-update-delete.ts` [8b] and two stale numbers in
this file. Nothing here touched `update_thought`'s rule, which is the signal
to stop reviewing and open the PR. Then the tidy-ups the three passes had cut
for space, since the files were open: 018 reports the twin or the stale holder
straight from the lookup's two columns instead of copying them into two more
variables, the pass says the two things 018 reports in one place, the pairs
query counts with a window instead of a second scan of its own CTE, and the
tool's note lives beside `explainRefusal`, which is where a reader looks for
what the tool says about an edit.

### 34. The head window is recorded on the row — and a provider call cannot hang for ever

`server-portable/embed.ts` and `db/reembed.ts` (Linear SMD-1021, found by the
first review pass of change 29 and deliberately not decided there). A long
thought is embedded whole and in windows, and when the whole-content call fails
the head window's vector stands in for it. The server accepts that silently by
design (change 27: a provider that refuses over-length input must not fail a
capture that used to succeed). The re-embed runs the same function over every
row, and there the silence was a defect of a different size: a row that fell
back was written and released `succeeded`, the claim row is terminal, and the
backfill the tool promises — a long thought captured before change 27 gets its
whole-content vector — was defeated for every affected row with one line on
stderr. Change 29's second pass had already made the *transient* case a failure
(`--retry-failed` revisits it); what remained was the *refusal* — a 413, or a
400 whose own words name the length: a hosted API that will not take input that
long — which is the provider's final answer and was recorded as an unqualified
success.

**The decision: a caveat on a succeeded row, not a new status.** `release_thought`
already stores `p_error` whatever the status, so the rule cost no migration then
(change 49 later spent one to state it on the column):
**a succeeded row's `last_error`, when set, is what the worker could not do** —
the write stands, and this is what it fell short of. A refused row is released
`succeeded` with the provider's status and message on it and the flag that
revisits it; `--status` and the end of a run count them ("35 succeeded (1 with
the head window)") and list them from the record rather than from a counter, so
two processes' views agree; `--retry-fallbacks` returns them to the pool for the
day the provider or its input limit changes. A fifth status would have meant a
migration altering the CHECK, redefining `release_thought` and every consumer's
counts, for a row whose write did succeed. The exit code is unchanged by them:
the vector stored is what a capture would have stored.

**The pass asks every long thought itself.** The server's embedder remembers a
refusal for the life of the process — one wasted probe per process on the
interactive path, and `test-chunking.ts` [1] still asserts exactly one across
four captures. In a pass that memory was wrong twice over: its purpose is the
whole-content vector, and a 413 is about *that* input's length, so a shorter
long thought may well be accepted — remembering one row's refusal gave every
later long row a head window it was never asked about, under a reason that was
another row's, and `--retry-fallbacks` could never have retried anything after
the first. `createEmbedder` takes `rememberRefusal`; the pass passes false and
pays one refused round trip per long row, answered before any embedding is
computed. `EmbeddedCapture` carries `wholeContentError`, the provider's words,
which is what lands on the claim row.

**A call that never returns.** Neither fetch in `embed.ts` had a timeout, so a
hung provider parked a worker until the second Ctrl-C the first pass added, and
its lease expired under it. Both carry `AbortSignal.timeout` now, from
`OB1_LLM_TIMEOUT` (seconds, default 120 — generous on purpose: what it exists
for is the call that never returns, not the slow one). A timeout on a window or
a short thought fails the row naming the setting; on the whole-content call it
is a transient fallback, with the timeout in the row's error. The server reads
the same variable; `deploy/.env.example` documents it and `compose.yaml`
forwards it, as the consistency check requires. The metadata-extraction fetch in
`index.ts` is not this code path and is left as it is.

**Verified** in `test-live.ts` [9], extended rather than given a suite of its own:
a third long thought refused whole with a 413 every time ends succeeded with its
head window and the refusal on its row, is listed under `--status`, costs the
other two long thoughts nothing, and gets its whole-content vector from
`--retry-fallbacks` once the stub relents; a short thought whose first request
is never answered fails with `timed out after 2 s (OB1_LLM_TIMEOUT)` while the
run finishes. `test-chunking.ts` [1b] drives a pass-shaped embedder over the
refusing stub — three long captures, three probes, each with its own 400 — and
over a request that never returns, both for a short call and for a whole-content
one. `test-thoughts.ts` [7] pins the variable's resolution: unset, empty, zero
and non-numeric are the default. Suites: live 184, chunking 27, thoughts 64.

**What the first review pass found, triaged.** Eight fixes, one ticket, one
declined. The metadata-extraction call in `index.ts` was left without a timeout
as "not this code path" — but a capture awaits it and the embedding together, so
a chat call that never returned still held the capture and discarded the
embedding that had finished under its bound; it carries the same signal now and
a timeout is one more recorded reason the tags can be missing. The timeout's
rewrap was attached to the fetch promise alone, so a deadline that passed while
the body was still arriving surfaced as the bare "The operation timed out"
without the seconds or the knob — the whole exchange is inside one try now, and
`test-chunking.ts` [1b] streams a body that never ends. A row refused whole
*and* missing a blurb was failed with the blurb error and the refusal written
nowhere; everything a row has to say is collected before the outcome is chosen.
The provider's error body went uncapped into the caveat and onto the claim row;
one cap at the source, shared with the worker's catch. `counts()` read the
status counts and the caveat count in two statements, so `--status` mid-pass
could show more head-window rows than succeeded rows; one `FILTER` on the
grouped query. The lease arithmetic I had stated and not enforced — eight rows
at 120 s exceed the 900 s lease, and three expiries mark a row failed although
every write succeeded — is enforced as `extract-entities.ts` enforces its own:
the default lease grows to the product when that is longer, an explicit `--ttl`
below it exits 2, and [9] asserts the refusal. The timeout gave the interactive
path a *transient* cause of head-window fallback that the reply did not mention
(a whole-content call that used to wait now times out); the capture and edit
replies say so, as they already do for chunks without context, while a
refusal stays silent as change 27 decided — `test-chunking.ts` [0] drives a 503
through the server before [1]'s 400 can latch. And the default's rationale now
says the budget is per request but the queue is shared, so against a provider
that serves one request at a time the last window is timed against the whole
queue. The caveat rule lived in the tool and this file and not on the column
(015 cannot be edited, and a comment-only migration was judged a second
mechanism): SMD-1052, to ride with SMD-1043's redefinition. That was the wrong
ride — 1043 is `upsert_thought`'s advisory lock and never touches the claim
table — so the judgement was reversed and it landed alone as migration 028
(change 49). Declined: dropping the server's
latch or latching on the shortest refused length — change 27 measured and
decided that latch and its test still holds. The reason first recorded here,
that a length latch "infers one row's answer from another's", was wrong and the
second pass said so: a 413 at length L does imply refusal for every longer
input under one model. The honest reservations are that `estimateTokens` is
not the provider's tokenizer and that a bare 400 is not about length; the
latch's shape is SMD-1054.

**A second pass, triaged: nine fixes and one ticket.** The derived default
lease could be fractional — `OB1_LLM_TIMEOUT=120.3` is legal — and
`claim_thoughts` takes an integer, so every worker's first claim would have
failed on the function's signature and the run re-embedded nothing while
`--dry-run` printed "962.4 s leases"; whole seconds now, and [9] runs a dry run
at 120.3 and reads the lease back. The metadata call's rewrap closed after
`fetch()`, the defect the first pass had fixed in `getEmbedding` — a deadline
passing during the body was recorded as `invalid_response_body`. Rather than
fix it a third time by hand, every provider call now goes through one function
in `embed.ts` (`providerCall`: URL, headers, signal, the timeout's name, the
status attached, the body capped, the JSON parsed), raising a `ProviderError`
whose `kind` tells a timeout from a refused status from a body that is not
JSON; the three call sites keep their own degradation and lose their own
copies of the mechanics, and `test-chunking.ts` [0] streams a chat body that
never ends and reads `provider_timeout` back off the reply. The lease floor
covered one embed per row while `processRow` re-embeds up to three times after
a concurrent edit; the default now carries one row's worth of slack and the
header says the arithmetic stands in for per-row renewal (SMD-1023). The lease
check ran before the read-only branch, so a monitor's `--status --ttl 600`
exited 2 with the lease lecture and no counts; it is exempt as the model-change
refusal is, and `--dry-run` reports it as a refusal a run would make. A blurb
that timed out reached the row as "fix the metadata model" — `EmbeddedCapture`
carries the distinct reasons and the row names them. Any 400 on the
whole-content call was recorded as a length refusal, a permanent and "correct"
outcome, while `extract-entities.ts` already read the message; one
`refusesLength` in `embed.ts` is the rule for both. The reply's "search chunks
are complete" could follow a note saying their context was missing; it says
every chunk has its vector. `PROVIDER_ERROR_CHARS` reached the two literals it
had missed. Suites after: live 184, chunking 27.

**A third pass, and the stop.** Its top finding was in the second pass's
`providerCall`, which is the signal: the loop is polishing its own additions,
not finding new ground in the rule. Applied, all small. The body read sat in
the same try as the fetch and a non-timeout failure there was rethrown raw, so
a connection reset while a 413's body streamed lost the status — a refusal
became a transient, and in the metadata call the raw error skipped the
fallback and failed the capture that fallback exists to save; the status is
kept from the moment the headers arrive, and a body that fails to arrive is
empty. `refusesLength` read the whole message, which carries the base URL, so
a host named "tokens" would have made every 400 permanent; it reads the
provider's body, its error code first (`context_length_exceeded`), then its
words, and `ProviderError` carries that body apart from the message. Sharing
that rule with `extract-entities.ts` had silently moved a 413 there from "stop
every worker" to "fail this thought"; restored — an extraction request is the
same shape for every thought. The header and README still said "400 or 413"
where the code had come to mean "413, or a 400 that says so", and the
transient message now says the 400 it got was not a stated refusal of the
length, so an operator whose provider answers every long input with a bare 400
can read why `--retry-failed` reproduces it. The derived lease has no upper
bound and a slow local model at `OB1_LLM_TIMEOUT=600` with context on derives
three hours, which is how long a dead worker's batch waits — said at startup
whenever the derivation lengthened it, with `--batch` as the knob; the
refusal's wording no longer calls the floor the worst case, since a re-read
after a concurrent edit is a row's worth more. Blurb-rejection reasons carried
per-window lengths, so the deduplication did nothing and a forty-window row
wrote forty copies; the lengths go to the log and the row carries at most
three distinct reasons. The caveat count and list were worded as the head
window's when the rule is general — "with a caveat", "carry a caveat", and
each row's text says which — so a later caveat of another kind is counted
truthfully. Three operator-facing descriptions of `OB1_LLM_TIMEOUT` omitted
the metadata call; the claim that every provider call goes through
`providerCall` was narrowed to the server's and this pass's — `extract-entities.ts`
keeps its own per-call `--timeout` and preflight its one-shot probes. Nothing
here touched the caveat rule, the pass's per-row decision or the timeout. Then
the tidy-ups the passes had cut for space, while the files were open: the four
hand-rolled "empty, non-numeric or out of range means the default" tests in
`resolveEmbedConfig` are one `numberOr`; `embedCapture` reports one refusal
variable rather than a second flag OR-ed with the first, and carries the error
as a plain field; the two stubs that never answer share `neverAnswers` in
`db/test-support.ts`, which is where the two things a test has to know about
such a stub are written down; and the two functions in `index.ts` that built
the provider URL and headers, dead once the metadata call went through
`providerCall`, are gone. The 300-character caps in `entities.ts` and on
`extract-entities.ts`'s configuration error stay: they bound a stderr line,
not a stored value.

**Not done here.** A bounded in-call retry of a transient whole-content failure
(a 429 wants a backoff a single retry does not give; the failed-row path is
tested and stands).

### 35. Preflight sees an unfinished re-embed — and a pass starts as one transaction

`server-portable/preflight.ts`, `db/reembed.ts`, `db/config.mjs` (Linear
SMD-1024, named "not done" by change 29 and made a ticket by its second review
pass). `reembed.ts --switch-model` records the new model in `ob1_config` before
the first row is re-embedded, on purpose: that is what lets a server configured
for the new model pass preflight and be switched while the pass runs, and lets
a later run resume the same key. The cost was what preflight then said. It
compared the configured model with the recorded one and reported `matching` —
for a pass that died at 5%, or was never re-run after `--retry-failed`, leaving
a server that passed every check while most of its vectors were another model's
and every search ranked across the two. `--status` said so, but only when
someone ran it.

**The signal is the claim table, not a marker.** The ticket offered two: a
marker row in `ob1_config` (`reembed_in_progress = <key>`, written at start and
cleared at completion) or an inference from the claim counts. The counts won.
Migration 015's fourth principle already makes terminal rows *the record of the
pass*; a marker would be a second record that can disagree with the first — the
process that drained the pool dies before clearing it, two processes finish at
once, an operator clears rows by hand — and needs a clearing protocol across
concurrent processes. The rule is one line, `passUnfinished` in
`db/config.mjs`: **a pass is unfinished while any row under its key is pending,
leased or failed.** Succeeded rows with a caveat (change 34) are finished.
Thoughts with no row under the key are not a signal on their own — after a
completed switch every new capture is one, for ever — and are reported as detail
while a pass is unfinished. Preflight reads every key with the tool's prefix
(`reembed:`), so a backfill under `--job` is reported by its key too; extraction
keys are excluded because 016's trigger keeps that pool fed between worker runs.
A new check, `re-embed pass`, sits directly under `embedding contract`, whose
`matching` stays literally true of the record; the line beneath qualifies it, as
a warning — the server answers, ranking across the old and the new vectors —
with the counts and the command that finishes the pass (`--retry-failed` named
while rows are failed, `--status` for where it stands). Before migration 015
there is nothing to read and the check says so rather than warning.

**What the counts could not see, until the start was one transaction.** The
ticket's own crash: the `ob1_config` write succeeds, the connection drops during
`enqueue_thoughts`, the operator forgets. That left a record naming the new
model with *no* claim rows, which no reading of the claim table could tell from
a fresh install. `reembed.ts` now writes the record, the rows the retry flags
return, and the pool in one transaction; a run that dies between them leaves
either both or neither, and `test-live.ts` [9] kills a run just after it prints
the record (the stub freezes every request but the probe, so nothing is
written) and asserts the whole pool is there for preflight to report. Reading
the start with that in mind found a second gap: **switching back to a model
used before did nothing.** The key `reembed:<model>@<dim>` still held the
earlier pass's terminal row for every thought that existed then,
`enqueue_thoughts` skipped them by primary key, and the run reported "Nothing to
do", exit 0, while every vector was the other model's — a state preflight would
have called finished, whatever signal it read. A model change now starts the
key's pool over inside the same transaction: every succeeded or failed row
returns to pending (rows another process holds are left to it), the run says
how many, and `--dry-run` reports it in its `would:` line.

**The two agree by sharing the words.** `formatPassCounts` in `db/config.mjs`
is the phrase `--status` and the end of a run print ("38 thoughts — 35
succeeded (1 with a caveat), 3 failed, 0 in flight, 0 pending, 0 not yet in the
pool") and the phrase preflight embeds; `reembed.ts` prints `preflight will warn
until this finishes:` with it whenever the rule holds at the end of a run or
under `--status`, so an operator reading either sees one account. A `--job` key
without the prefix is accepted — rows under an existing bare key must stay
reachable — and noted once: preflight will not report it. `test-preflight.ts`
[5] writes the states to the claim table as the tool would leave them: mid-pass
warns with the counts and `--json` carries it; a capture during the pass is
counted as not yet pooled; a finished pass with such a capture is finished; a
leased row is in-flight work; a backfill under another key is reported by its
key; a fresh install and a schema before 015 are not warnings. [9] runs
preflight itself at four points and switches the model back at the end.

**What the first review pass found, and what it changed.** Ten findings,
triaged; eight fixed, one to a ticket, one stated as a limit. The largest were
about the restart and about the remedies preflight prints. A switch abandoned
and reverted — A to B dies at 5%, the operator goes back to A and finishes —
left B's key with pending rows for ever, and the remedy printed for it,
`--job reembed:B@d`, would have made `reembed.ts` write A's vectors and record
them as B's, since the tool takes its model from the shell and never from the
key. Two changes: `reembed.ts` refuses a `--job` whose `reembed:<model>@<dim>`
names a model or width other than the configured one (`parseReembedKey`, one
parser for both files), and preflight tells a pass to a model that is no longer
the recorded one — "a switch that was abandoned or reverted" — with its two real
remedies, completing that switch in its own environment or retiring its record
(the hand `DELETE` that 015 documents; change 39 gives it a flag, `--retire`). The
configured key's remedy now carries `--switch-model` when the record disagrees
with the configuration, which is the only case where the tool would have
refused the command preflight printed. The restart was scoped to this job and
skipped a lease that had expired with no live holder: switching back with a
`--job` backfill key moved the record and left the default key's terminal rows
to report "Nothing to do", and a row a dead worker of the earlier pass had used
its attempts on was reaped as failed for that pass's reason. It now returns
every terminal row and every expired lease under this job, and also when
`ob1_config` records no model at all; a record moved by hand is stated as not a
change the tool can see. (This pass also extended the restart to every key of
the configured model; the second pass took that back — below.) A `--dry-run` without
`--switch-model` printed the restart as its plan when the run would have
refused; it says "would: refuse without --switch-model; with it: …". The
retry flags under a model change printed a count that was zero by
construction; they say the change subsumed them. A requeue of a hundred
thousand rows left the statistics describing the finished pass, since
`enqueue_thoughts` analyses only when it added rows; the transaction analyses
after a requeue that added nothing. And the run says, when it recorded the
model and thoughts were captured meanwhile, that a server not yet switched left
them on the previous model's vectors and a re-run brings them over — the one
state neither preflight nor `--status` can see afterwards, since a vector
carries no model. In the tests, the killed run's probe had pre-satisfied "the
provider was asked for the configured model"; the set is cleared. Suites after:
live 204, preflight 79.

**A second pass, and the stop.** Its top finding was in the first pass's own
code — the `--switch-model` term for an unfinished key that names no model was
an expression that could never be true, so a key like `reembed:nightly` under a
record that disagreed with the configuration got a command the tool refused —
which is the signal the loop is polishing its additions rather than finding new
ground. Applied, all small, and one taken back. The first pass's restart
returned the rows of every key of the configured model, and a `--switch-model`
run under a backfill key then re-embedded the corpus and left the default key's
whole pool pending for preflight to demand a second pass over vectors already
at the model; the restart is this job's rows again, and the header says why the
other keys are left: once the pass has finished the corpus is at the model,
which is what their finished rows say. Returning expired leases put the start
in the path of a concurrent worker's reaper, which takes the same rows, and a
deadlock the server resolves against this side ended the tool with an uncaught
rejection; the transaction is caught, rolled back whole, and says so with
"run again". A missing `embedding_dim` row made every backfill of the
configured model "a switch that was abandoned" (`dim !== Number(undefined)`);
only a present width is compared. A key at another width of the same model was
offered "finish that switch", which the column-width check refuses
deterministically; it is described as one no run can finish, with retiring the
record as its only remedy. The "preflight will warn" line printed for a key
without the prefix, which the tool had just said preflight cannot see; it says
that instead. The `--job` refusal ran before `--status` and `--dry-run` could
be exempted, so the very key preflight reported could not be inspected without
changing the shell; it joins the other refusals, where `--status` answers and
`--dry-run` reports it. The key's shape — prefix, builder, parser — is defined
once in `db/config.mjs` and both files use it. Kept, with the reason: the
restart resets `attempt_count` on an expired lease as on any row it returns,
because a model change is a new pass, not the reaper continuing the old one.
Ticket: a vector carries no model, so the claim table is a proxy that vanishes
when rows are cleared — SMD-1068 weighs a per-row `embedding_model` column.
Suites after: live 207, preflight 83. Then the tidy-ups the passes had cut for
space, while the files were open: the counts type was declared three times
(`reembed.ts`, `preflight.ts`, `config.d.mts`) and is imported from the one
declaration; the two retry flags were qualified by `!recordModel` five times
and are decided once; the spawn-and-collect body five suites had written is
`runScript` in `db/test-support.ts`; and the prefix scan in preflight says why
it is a scan.

**Not done here.** The PostgREST branch cannot read the claim table, as it
cannot read anything else the schema checks read; per-row lease renewal
(SMD-1023); extraction passes; an acknowledgement path for a row the provider
refuses permanently, which otherwise keeps the warning alive on every start
(SMD-1067 — done in change 39: `--accept-failed` under the caveat rule, and
`--retire` for a superseded key); a thought captured by a not-yet-switched server after the
record moved, which has the old model's vector and no claim row, and is
indistinguishable from a new-model capture once the pass is finished — the run
says so at its end, and the operator's step is to switch the server first;
recording the model per row, which would make the check exact (SMD-1068 —
done in change 38, which retires that paragraph: the rows say which model they
are at, and a re-run takes exactly them).

### 36. `match_thoughts` reaches the index at the shipped width — and both search functions say how many rows they return

Migration 019 and `db/bench-plan.ts` (Linear SMD-969 and SMD-1041; upstream
[#469](https://github.com/NateBJones-Projects/OB1/issues/469)). The upstream
issue reports that even the plain `match_thoughts` shape gets `Seq Scan` +
`Sort` at ~9,300 rows and only `SET LOCAL enable_seqscan = off` makes the
planner take `thoughts_embedding_idx` — 5.9 s and ~30,000 buffers a call
against 180 ms and ~3,200. Its headline is about `match_thoughts_recency`,
which this fork does not ship (SMD-945, change 37, ships the
candidate-then-rerank shape the issue arrives at, inside `match_thoughts`). The half that applied here had never been
measured: change 28's bench explains only the filtered branches, at 64
dimensions, and `db/test-live.ts` [5] asserted the index is *reachable* with
sequential scans disabled, which is a different question from whether it is
*chosen*. The fork's rule is that a plan is measured, not inferred (change
24), so it was measured, at 1,024 dimensions.

**The planner does not choose it where the heap is small — which is every
brain up to some tens of thousands of thoughts — and the chunk table is the
half that matters.** `db/bench-plan.ts`: random unit vectors, one thought in
five with a chunk row, the unfiltered branch's own statement read from the
catalog and explained under `EXPLAIN (ANALYZE, BUFFERS)` at 1,000, 10,000 and
100,000 rows. At 10,000 rows and the default count the `thoughts` CTE is an
index scan and the chunk CTE a **sequential scan** of 2,000 rows that touches
13,000 buffers — the whole statement 5.3 ms against 1.8 with the index. Above
the default count both sides scan: 28.8 ms and 80,317 buffers at match_count
50, against 6.5 ms and 11,143. At 1,000 rows everything seq-scans at every
count. At 100,000 rows the heap alone is ~1,500 pages, the estimate turns, and
the planner takes the index at the counts callers send on its own — and still
seq-scans at the ceiling, a million buffers and 275 ms for 500 rows against
the index's 115,000 and 170–290.
Upstream's report is a 9,300-row table: the band the estimate gets wrong is
the band real brains occupy. At 64 dimensions the planner is right at every
size, which is why the earlier bench could not have seen it.

**The mechanism, which is why no cost knob fixes it.** `pg_type.typstorage`
for `vector` is `e`: a 1,024-wide vector is ~4 KB, past the TOAST threshold,
and is stored out of line. At 10,000 rows the heap is 912 kB and the TOAST
relation 53 MB. The planner prices a sequential scan by heap pages plus
per-tuple CPU and never counts the detoast reads — it estimated 114 pages and
the scan read 66,780 buffers. The estimate is wrong in kind, not by a factor.
`random_page_cost = 1.1`, the cost-model remedy the ticket asked to weigh, was
measured as an arm of the bench: at 10,000 rows it wins both sides at
match_count 10 and the `thoughts` side at 50, and still scans the chunk table
at 50 and both tables at 500; at 1,000 rows it wins one cell of six; at
100,000 it still scans the chunk table at the ceiling. The chunk table loses
first because it is "small" in heap pages while every one of its rows is a
vector — the wider the model, the longer every table stays small. Upstream's own
shape, the threshold inside the WHERE, was measured too and is worse still:
with the index forced and no row passing, the iterative scan walks to its
bound, 49 ms for zero rows. The threshold after the LIMIT is what makes the
index scan a LIMIT, and it stays.

**The decision: `SET enable_seqscan = off` on the function**, beside 014's scan
mode — upstream's remedy, taken for a stated reason: no cost constant can
express a cost the estimator omits, and the omission grows with width and row
count. It is a penalty (a disabled path costs 10^10), not a prohibition — a
relation with no usable index still seq-scans — and every statement in the
body has an index the schema guarantees: both HNSW indexes for the candidate
CTEs, GIN for the routing statement, primary-key and `thought_id` probes for
the exact branch, HNSW plus a primary-key join for the walk, a primary-key
join for the merge. Not chosen, and why, in 019's header: `random_page_cost`
in `deploy/compose.yaml` (measured insufficient; and a server setting a hosted
Postgres may not expose, where the clause travels with the schema); raising the
distance function's `COST` (it would work — the index scan pays it only for
the rows it returns — but it edits a catalog row pgvector owns); `set_config`
inside the body (transaction-scoped, and a second mechanism). After: both
sides are an index scan at every count and scale, under both plan modes. At
the counts callers send the index wins by three to four times where the
planner was choosing the scan; at the ceiling the two plans cost about the
same at every size, with the index touching a ninth of the buffers at
100,000; at 100,000 rows and the counts callers send the setting changes
nothing, since the planner already chose the index.

**SMD-1041, folded in because it needs the same migration.** PostgreSQL
assumes 1,000 rows from a plpgsql set-returning function; `match_thoughts`
returns ten by default and `search_thoughts_keyword` twenty-five, and change 32
found the consequence — a fused query whose estimate crossed `jit_above_cost`
and was JIT-compiled on every call. 017 fixed that locally and the estimate
stayed wrong for every other caller. 019 declares `ROWS 10` and `ROWS 25` in
the functions' own `CREATE` statements — not an `ALTER FUNCTION` from 017,
which the SMD-958 passes declined because `CREATE OR REPLACE` resets `prorows`,
and `db/test-schema.ts` re-applies 014 on purpose. Both bodies are carried
verbatim, and the schema test proves it rather than saying it: [20] re-applies
014 and 012 and compares `prosrc` byte for byte, asserts the re-apply reset the
estimate to 1,000 and dropped the setting (the trap, reproduced), then
re-applies 019 and asserts both are back; a composing `EXPLAIN` estimates 10
and 25 rows. `bench-hybrid.ts`'s numbers do not move: 017's `SET jit = off`
stays, since its own argument still holds.

**Wired into CI at the smallest scale that reproduces the decision.**
`test-live.ts` [5c], over [5b]'s 2,000 rows and 400 chunk rows at the
configured width: the control first — the same statement without 019's setting
leaves at least one candidate CTE off its HNSW index, so the section is not
passing vacuously, skipped with the reason where a planner takes both unaided —
then the statement under the function's own SET clauses is an `Index Scan
using thoughts_embedding_idx` and an `Index Scan using
thought_chunks_embedding_idx` at match_count 10 and 50 under both plan modes.
The extraction (`extractBody`) and the settings loop (`applyFunctionSettings`)
moved from `bench-hnsw.ts` into `db/test-support.ts`, so the three explainers
rewrite the same text the same way; `bench-hnsw.ts`'s after arm applies 014
and every later migration, since its plans are read from the catalog and 019
redefines the function. Live suite 222, schema 366.

**Handed to SMD-945.** The recency blend's plan to graft onto the existing
structure assumed that structure gets an index scan. It does now, *because of*
the function-level setting: a redefinition must carry `SET enable_seqscan =
off`, `SET hnsw.iterative_scan = relaxed_order`, `ROWS 10`, the `requires`
line and the `ob1:filter-inside-scan` sentinel — 019's header lists the five —
and [5c] fails without the first at 2,000 rows. Change 37 carried all five.

**A first pass, triaged: nine fixes, one measurement.** Preflight checked
`match_thoughts` for 014's clause and never for 019's, and its remedy restored
only the first, so following the repo's own advice would have reinstalled the
plan defect; a `candidate scan` check reads `proconfig` and `prorows`, names
what a redefinition dropped, and gives the `ALTER FUNCTION` that puts both back
when 019 is recorded and the migration when it is not (`test-preflight.ts`
holds the three wordings, 89). [5c]'s control counted any `Seq Scan`,
including the outer merge's join over a small heap, so it could have passed
while both CTEs already index-scanned; it judges the two HNSW index names and
skips with the reason where the planner takes both unaided. The setting is
function-wide and the filtered statements never read the vector column, so
`bench-plan.ts` measures them too — the routing statement takes the GIN
bitmap under either setting (2.1 ms on a 50% filter at 100,000 rows), the
exact branch is unchanged, the walk's custom plan is the same or better (its
chunk side moves from a seq scan to its HNSW index at 10,000 rows, 18.7 to
15.6 ms), and its generic plan on a broad filter at 100,000 rows is a GIN
bitmap over 50,000 parents in both arms, which change 28 measured and this
change leaves. Buffers had been parsed from `hit=` alone, a floor once the
TOAST relation outgrows `shared_buffers`; hits and reads are summed and every
table above is re-measured (the 100,000-row seq scan touches a million
buffers, not 932,017). `eval-filtered.ts`'s after arm still applied 014 alone;
`bench-hnsw.ts` section D ran the walk outside the function's settings; [5]
issued session `SET`s on a pooled connection; `test-schema.ts` restored the
shipped function by a hard-coded `019` and now re-applies whichever migration
last defines it, read from the files. The header called `typstorage` `e`
"extended" — it is EXTERNAL, what pgvector declares — and now weighs `SET
STORAGE MAIN`, which would make the estimate right by making the heap fifty
times larger for every scan that never reads the vector. README counts.

**A second pass, and the stop.** Its top finding was in the first pass's own
change: with 019 in `eval-filtered.ts`'s after arm, the unfiltered path is an
HNSW walk where 007's function seq-scanned exactly at that corpus size, so the
control that required byte-identical rows would have failed and blamed 014 —
it reports overlap now and stops only below 80%. The rest: the bench explained
the exact branch on a 1% tier without checking the count the function routes
on (gated, as the walk was); [5c]'s "out of line" label counted every index as
TOAST; `bench-hnsw.ts` said its command reproduces the published tables while
its after arm now carries 019's clause (the caveat is in its header; 014's
header cannot change); the README's schema count was one short and both docs
said the control was asserted where it can skip; `lastDefinerOf` matched a
statement anywhere in a file, now only at the start of a line, and [20]'s pin
on 019 is stated as deliberate; preflight never read
`search_thoughts_keyword`'s estimate and read `pg_proc` and the ledger twice —
one read feeds both checks, the settings are parsed with `parseSetConfig`
rather than split on commas (in `test-schema.ts` too), and the remedy is one
`ALTER FUNCTION` per function that needs it, after any body re-apply. The four
explainers share `explainPrepared` in `db/test-support.ts`, and the bench reads
each filtered statement from the catalog once per arm instead of once per
query. Declined: a table-driven single check for every clause `match_thoughts`
must carry (two checks warn about different consequences with different
remedies, and SMD-945 adds no clause) and unifying the three plan-node
classifiers (they answer different questions). Suites after: schema 367,
live 222, preflight 92. Then the tidy-ups the passes had cut for space, while
the files were open: `bench-plan.ts` dispatched its five arms on label
strings and carried two dead fields, and is one table of what each arm sets;
the chunk-row loader it and [5b] had both written is `loadChunkRows` in
`db/test-support.ts`; and 019's header says why `ROWS` is the default page when
017 asks the keyword function for 100 per needle.

**Not done here.** The recency half of #469 (SMD-945, done in change 37); the walk's generic plan
on a broad filter at 100,000 rows, measured in change 28 and again here, which
no setting in this change addresses; `ROWS` on `search_thoughts_hybrid`
itself, which returns at most `match_count` rows and is composed by nothing in
the repo; a per-width run of `bench-hnsw.ts`, whose published tables stay at
64 dimensions.

### 37. `match_thoughts` blends recency into its ranking — opt-in, after the candidate scan, and measured to cost something here

Migration 020, `evals/eval-recency.ts`, and `recency_weight` on
`search_thoughts` (Linear SMD-945; the recency half of upstream
[#469](https://github.com/NateBJones-Projects/OB1/issues/469)). `match_thoughts`
ranked on cosine similarity alone, so two thoughts of equal fit ranked
identically whether one was captured yesterday or two years ago — right for a
reference brain, wrong for a working one, and quiet either way. Upstream's
`schemas/recency-boosted-match-thoughts` has the formula — `score = similarity ·
(1 − w) + 0.5^(age_days / half_life) · w`, `w` defaulting to 0 (upstream writes
`exp(−age / half_life)`, an e-folding time under a parameter named half-life;
here the name is true) — and, as written, two regressions against this fork's
function: it reads `thoughts` alone (change
18's chunk retrieval gone) and puts the threshold and the blend into the scan
(no `ORDER BY <=> LIMIT`, so no HNSW index — the cost change 36 measured). So
the blend is grafted onto the body changes 28 and 36 built, and the access path
does not move: the three candidate CTEs are 019's byte for byte (`test-schema`
[20] compares them against a re-applied 014), only each branch's final SELECT
orders by the blended score, the threshold still gates the raw similarity, and
the exact branch — every matching row scored — makes a thin filter's blend
exact. The plan is held where change 36 holds it: `test-live` [5c] explains the
statement with `recency_weight = 0.3` and finds both HNSW indexes and a
candidate window of 160.

**Two facts found while planning shaped the work more than the formula did.**
The signature had to change, and a second overload beside the 4-argument
function is the ambiguity change 5's migration (004) warns about: with both
present, every 4-argument call — both stores, 017's fused function, every
PostgREST caller — fails with `function is not unique`. So 020 **drops** the
4-argument function and defines the 6-argument one (`recency_weight float
DEFAULT 0`, `half_life_days float DEFAULT 90`), and does the same to
`search_thoughts_hybrid`, which passes the weight through; every place that
spelled the old signatures (`dropSchema`'s list, `extractBody`, preflight's
catalog reads, the fixtures' `ALTER FUNCTION`) now reads one constant in
`db/config.mjs`, and `extractBody` resolves the function by name so the
benches' before arms still read 014's. And 017 re-ranked the vector arm by
`similarity` *inside* the fused function, which would have undone the blend for
every first-party search. So `match_thoughts` returns the blended value as a new
**`score`** column — equal to `similarity` at weight 0 — `similarity` stays the
raw cosine (the threshold's quantity, the tools' "% match", and what 017's
keyword-hit probe computes, so nothing has to be mirrored), and the hybrid
ranks on `score`.

**The window.** The blend can only reorder the candidates the scan produced,
and no fixed window is exact: a recent row of similarity *s* just outside the
nearest 4N enters the top *k* when *s(1−w)+w* beats the *k*-th blended score,
which depends on the data. Under a weight the over-fetch widens fourfold (16N,
at least 80), and the factor is measured rather than assumed: `eval-recency.ts`
compares the function's top N against an exact blended ranking of the whole
table, and against the top N the un-widened window would have given. On 486
queries at every weight and half-life the function matched the oracle in
every cell, where the 4N window fell to 96% at 0.2 over 30 days, 93% at 0.3
and 85% at weight 1. Read with the corpus's size: at 10 results the widened
window is a third of the 486-row table, and at 100 results it *is* the table,
so that cell can only agree with the oracle. What the corpus shows is that 4N
loses rows the formula ranks first and 16N did not, at its size; on a brain of
tens of thousands the window is a fraction of a percent of the table, and the
contract is a re-ranking of the nearest candidates, not an exact blended
ranking of the table — the header says so. The exact/walk threshold does not
widen with the window: `v_exact` is sized from the unweighted 4N, so a filter
routes the same way at every weight. The adaptive alternative
(fetch, check the bound, widen, fetch again) was declined: it either runs the
index scan twice or moves the candidate CTEs out of the `RETURN QUERY` blocks
that [5c] and both benches read from the catalog. What a weighted call costs
is in `bench-plan.ts`'s new arm: at the default count and 10,000 rows,
both candidate CTEs stay Index Scans and the call goes from 1.8 ms and 3,434
buffers to 5.1 ms and 9,558; at count 50 from 6.3 to 16.9 ms; at the ceiling
from 33 to 79 ms; at 100,000 rows, 2–3 ms become 8 at the default count, 12–14
become 84 at count 50 and 170 become 365 at the ceiling, every cell still two
`Index Scan`s.

**Measured, and left off by default.** The corpus was rebuilt with each
issue's creation date (`build-linear-corpus.ts` records it; the `/tmp` copy had
gone), 486 issues, 0–183 days old, median 82. The task is `eval-real`'s — title
finds body — so the right answer is the issue whatever its age, and the number
is what a weight *costs* on a relevance task; this corpus has no ground truth
for "what was I doing about X" and cannot show a weight helping. At the tools'
setting (10 results, threshold 0.5) every weight lowered MRR: 0.899 at 0 →
0.894 at 0.1 over 365 days, 0.879 at 0.1 over 90, 0.811 at 0.2 over 90 (8
answers moved up, 88 down), 0.667 at 0.3, 0.158 at 1. The ticket said what to
do with that result, and it is done: the default stays 0, `search_thoughts`
takes `recency_weight` (0–1; the half-life stays 90 days for the tool) for a
caller who knows their brain is a working log, and the ChatGPT `search`, which
cannot take a parameter, sends a fixed 0 with the measurement as the reason.
The control ran before any table was printed: at weight 0 the shipped
function returned 019's rows in 019's order, and `score` equalled `similarity`,
on every query at both settings.

**Held, in the ticket's words.** `test-schema` [21]: backward compatibility
*exactly* — 019's own function installed from its file under another name, and
on a fixed corpus reaching the unfiltered and the exact branch the new one
returns the same rows, ids and similarities, over eighteen calls, with `score`
equal to `similarity`; chunks still found through the recency path; the blend
does something — two rows swap as the weight crosses the formula's *w** =
δ / (δ + r₂ − r₁), asserted on both sides, and a 30-day half-life moves *w**
where the formula says, so one weight gives opposite orders under the two
half-lives; the threshold gates raw similarity (a brand-new orthogonal row is
not surfaced at weight 1); weights clamped, a non-positive half-life refused, a
NULL `created_at` infinitely old (the first draft's `GREATEST` swallowed the
NULL and called the row brand new — the test caught it); the widened window
observable, a recent row ranked 61st by similarity coming first under a
weight; the hybrid following the weighted order with its `similarity` still
the cosine; infinite timestamps scored at both ends and never subtracted at
weight 0; ties broken by id through a LIMIT; the fused search under a weight
and a threshold returning the newest row *above* the threshold; a literal-only
query ordered by the blend; and the ACL replayed across the DROP. [20] keeps
019's expectations for the keyword function and adds
the new trap: re-applying 014 puts the 4-argument form back beside 020's, and a
4-argument call is then `function is not unique`. Preflight gains a `search
signatures` check that fails a database whose functions predate 020 (the
server sends the new arguments) and one with an earlier form re-created beside
020's, with the `DROP` as the remedy; its 014 and 019 checks read whichever
form is there and name it in their `ALTER FUNCTION`. Both stores send all the
arguments on every call and map `score`; `test-store-sql`, `test-store-postgrest`
and the e2e suite each age a row and watch it drop. Suites: schema 423 (both
widths), live 230, preflight 101, sql 56, e2e 62.

**A first pass, triaged: eight fixes and two corrections to what the docs
claimed.** The parameter was named `half_life_days` and the formula was
`exp(−age / half_life)` — an e-folding time, 0.37 at the half-life, upstream's
mistake carried over; it is `0.5^(age / half_life)` now, the tool text ("halves
every 90 days") is true, and every number above was re-measured (the slower
decay costs a little less: 0.811 rather than 0.775 at 0.2 over 90 days). The
formula was inlined three times in the body and twice more in the harnesses;
`recency_score()` — a SQL function the planner inlines — is the one copy, called
by `match_thoughts`, by the hybrid for the keyword hits it scores itself, and by
the eval's oracle (which therefore measures the window, not the arithmetic;
[21] holds the arithmetic against the formula written out in TypeScript). It
also carries the fix for a row with an infinite `created_at`: the first draft
computed `now() − created_at` for every candidate at every weight, which
PostgreSQL 16 — the pinned server, though not PGlite — refuses for `±infinity`,
so a hand-written row would have broken `match_thoughts` at weight 0 where 019
answered fine; the CASE now never evaluates the age at weight 0. Three more in
the hybrid: under a weight it passes the caller's threshold to `match_thoughts`
instead of −1, because recent sub-threshold rows could fill the N slots and be
dropped by the threshold below, leaving older above-threshold rows that never
entered the window — `search_thoughts` answering "nothing" for a query the
unweighted call answers; its tiebreak among equal fused scores is the blended
value rather than the raw similarity, which for a literal-only query (the gate
gives the vector arm no vote) was the whole order, so the weight chose the rows
and then did not order them; and `match_thoughts`' own `ORDER BY` gained `id`
as a second key, since rows sharing a `created_at` tie exactly at weight 1 and
019 left which survive the LIMIT to the plan. Two on the deployment path: a
`DROP FUNCTION` loses the function's ACL, so an operator's `REVOKE EXECUTE
FROM anon` on the old form would have been silently undone on Supabase — 020
reads each old ACL before its DROP and replays it after the CREATE, and [21]
proves it; and the `search signatures` check ran only on the SQL store, so on
the default PostgREST store two overloads went undetected while every
4-argument caller failed — preflight now probes PostgREST as such a caller
would, with four named arguments, which only two overloads make ambiguous. The
e2e assertion that the aged row still shows "100.0% match" had an operator
precedence that made it always true; it reads the row's own header line now.
And the window claim above was stated as support at both settings when at 100
results the window was the whole 486-row table; it is stated for what it is.
And one thing the pass did not find but the run did: `db/with-postgres.sh`
removed its container and not the anonymous volume the postgres image declares,
so 776 of them — 79 GB — had accumulated and the podman VM ran out of disk
mid-bench; it removes both now.

**A second pass, and the stop.** Every one of its ten findings was about the
first pass's own additions, which is the signal this fork stops reviewing on;
all ten were fixed. The ACL replay revoked only PUBLIC before re-granting, so
the grants `ALTER DEFAULT PRIVILEGES` puts on a fresh function — on Supabase,
anon, authenticated, service_role — survived, and an operator's `REVOKE` on
anon came back: the regression the block exists to prevent. It revokes every
grantee the CREATE handed out now, then grants exactly the old ACL, grant
option included; and it runs only on the run that *creates* the new form,
because a re-run over the two-form state read the 4-argument form's ACL and
stamped it over a hardened 6-argument one. [21] holds four cases with a test
role and default privileges (PGlite has both). Under a weight the hybrid passes
the threshold, so a keyword hit below it left the window at any rank, tied a
rank-1 vector-only row at exactly 1/(k+1) and lost on similarity — "exact hits
first" broken by the threshold; such a hit now carries the rank just past the
window, ahead of every vector-only row and behind a hit the window holds, and
nothing changes at weight 0. A hit with no vector and no chunks had a NULL
blended tiebreak and sorted last at every weight, so at weight 1 a thought
captured today through the 2-arg fallback ranked below a three-year-old hit;
under a weight it is scored by age alone. The PostgREST signature probe said ok
on a database whose only `match_thoughts` predated 020 (a 4-argument call
resolves against the old form too); it probes with 020's arguments first.
`v_exact` inherited the fourfold widening — 32,000 parents scored exactly at
the ceiling under a weight, and the exact/walk boundary moving with the weight
— and is sized from the unweighted window now. The rest: [21]'s second ACL
assertion observed the test's own grant; the eval's narrow-window arm
re-implemented the blend in TypeScript and is the same `recency_score()` over
the nearest 4N in SQL; a cache variant outside its helper's type; the bench's
"after (019)" arms measure the deployed function and are named so; the tool
comment's pre-half-life numbers; a hedged preflight assertion. Then the
tidy-ups the passes had cut for space, while the files were open: preflight's
020 remedy was one sentence written five times and its PostgREST `missing()`
test was defined inside one block and needed by another — both live once now,
and the filtered-search probe's skip line names the `search signatures` check
when the function cannot be resolved at the shape the store sends, rather than
the catalog hint; the two stores each wrote the function's defaults (0 and 90)
twice — `RECENCY_DEFAULTS` in `store.ts` is the one copy; and `bench-plan.ts`
had its own by-name lookup of `match_thoughts` beside `test-support.ts`'s, which
is exported and used instead.

**Not done here.** A default weight for the ChatGPT `search` other than 0 —
the measurement above is the reason, and an operator who wants one has no knob;
if one is wanted it is an environment default, not a constant. `ROWS` on
`search_thoughts_hybrid` (change 36's note stands). A recency eval with ground
truth for "what was I doing about X", which this corpus cannot supply.

### 38. A vector carries its model — `thoughts.embedding_model`, written with the vector, read by preflight and the re-embed

Migration 021, `db/reembed.ts`, `server-portable/preflight.ts`, both stores
(Linear SMD-1068, filed by change 35's second review pass and named under its
"Not done here"). Change 35 taught preflight to see an unfinished re-embed from
the claim table: a pass is unfinished while any row under its key is pending,
leased or failed. That is a proxy for a fact the schema never stored, and it
vanishes when the rows do — migration 015's fourth principle and preflight's
own remedy for a superseded key both tell the operator to `DELETE FROM
thought_work_claims`. A pass to B dies at 5%, the operator clears its rows to
start over and is interrupted: `embedding contract … matching`, `re-embed pass
… none unfinished`, 95% of vectors another model's, and nothing left in the
database could ever say so. The same blindness made `reembed.ts` end every
switch with a paragraph about thoughts captured meanwhile by a server not yet
switched, which "nothing here can tell" from new-model captures.

**One nullable column, written by the statement that writes the vector.**
`thoughts.embedding_model text`: the model's name exactly as
`OB1_EMBEDDING_MODEL` gives it — the string `ob1_config.embedding_model`
records, so "at the recorded model" is string equality. The rule is that *the
label follows the vector*: `upsert_thought` writes it beside the vector and on
a re-capture keeps it with a kept vector or takes the caller's with a new one;
`update_thought` leaves it without content, sets it NULL with content and no
vector, writes the caller's with a vector. NULL is *unknown*, not "the
default": every row from before 021, every raw INSERT, the PostgREST two-step
fallback, every capture from an older server; and a row with no vector has no
label, whatever its writer named. Stamping the recorded model on every
existing row would be exactly the guess the column exists to stop making, on
the one day (021's) the corpus may well be at two models — so the only
backfill is the one there is evidence for: a row a finished pass wrote,
released as succeeded under a key naming the model, and not written since
(`updated_at <= finished_at`) is labelled from its latest such claim; a key
naming no model is no evidence, and everything else stays NULL. `thought_chunks`
gets no column: a chunk's vector is written in the same
statement as its parent's from one `embedCapture()`, so the parent's label is
the chunks'. No index: the readers are a grouped count per server start and a
scan per re-embed run. 008/010's audit trigger diffs content, metadata and the
vector's presence, so a label change is not an event and a re-embed still
writes no audit row — asserted, in `test-schema.ts` [22] and `test-live.ts`
[9].

**The label comes from the caller, never from `ob1_config`.** The server knows
the model it embedded with and `ob1_config` knows the model the corpus is being
moved to; they differ exactly during a switch, because `--switch-model` records
the new model first, on purpose. A writer reading `ob1_config` would stamp the
new model on a not-yet-switched server's old vectors — the one case the column
is for. So `index.ts` passes the embedder's model on capture and on an edit with
content; `reembed.ts` passes its own.

**Two writers, two mechanisms, and 004's rule is the reason.** `upsert_thought`
has three overloads and 004's header forbids a default on any of them (a
defaulted fourth parameter beside the 4-argument chunk form makes an untyped
4-argument call ambiguous); its `p_payload` has been an envelope since 004 and
008 put the actor there for this exact constraint — so the label rides as
`p_payload.embedding_model`, both stores, no signature change, only the
3-argument body redefined. `update_thought` has one form, no envelope and every
parameter but the id defaulted, so it gains `p_embedding_model text DEFAULT
NULL` as an eighth parameter — and the 7-argument form is **dropped** first, as
020 did for the search functions: `CREATE OR REPLACE` with a new parameter
leaves the old form beside it and every call with seven arguments or fewer is
"function is not unique". 020's ACL capture-and-replay runs across the drop,
`COMMENT ON FUNCTION` is re-issued, and `UPDATE_THOUGHT_SIGNATURE` in
`db/config.mjs` is the one spelling — `reembed.ts` resolves the body it will
call by it (018's sentinel, now on the eight-argument form), `test-support`
drops both forms on a reset, preflight reads the forms beside it. The migration
is generated from 008's and 018's bodies with anchored edits, so the carried
text — 005's guard, the actor, 009's guard, 013's context, 018's `FOR UPDATE`,
advisory lock, `content_fingerprint_of` and sentinel — cannot drift.

**What reads it.** Preflight gains two checks. `vector models`, directly under
`embedding contract`: the corpus grouped by label — every labelled vector at
the recorded model is ok (unlabelled ones reported as detail: unknown, not
wrong); vectors at another model are a warning naming each model and its
count, with the `reembed.ts` command as the remedy and `--switch-model` in it
when the record disagrees with the configuration; the column absent under this
server is a failure, because every capture would drop the label and every edit
would fail. `edit signature`, beside `search signatures`: the eight-argument
`update_thought` present and alone — 018 re-applied by hand beside it fails
with the exact `DROP FUNCTION`, in its place fails naming 021; over PostgREST
the probe is `update_thought` with an id no row has, which answers `NOT_FOUND`
from its `FOR UPDATE` read and writes nothing. `re-embed pass` keeps its rule
(`passUnfinished` stays claims-only — the data view is the new check), but its
"not yet in the pool" now counts the thoughts *not at the key's model* with no
row, because that is what a run adds. And `reembed.ts` builds its pool from the
rows: `enqueue_thoughts` is given the ids `WHERE embedding_model IS DISTINCT
FROM <target>`, so a thought already at the target with no row is finished and
is never re-embedded "harmlessly" (a provider call each); and on *every* run a
succeeded row whose thought is not at the target returns to the pool — the row
says done, the thought says otherwise, the data wins. That is what retires the
"nothing here can tell" paragraph: a capture or edit by a server still on the
old model, before or after the pass finished, is found by the next run because
its row says which model it is at. Failed rows stay terminal (the failure
policy; `--retry-failed`) and caveat rows are at the target (the head window is
the target model's vector), so neither is touched; the model-change start-over
is kept as the rule for failed rows and expired leases of an earlier pass.
`--status` and a run print the corpus by model. A run requires 021 and says so
(the 018 probe became the 021 probe); `--status` and `--dry-run` answer on an
older schema.

**A first pass, triaged — ten findings, all fixed.** The largest was the cost
of NULL: with every pre-021 row unlabelled, the first plain run after upgrading
would have re-embedded a whole corpus a finished pass had already proved was
at the model — NULL is "not at the target", rightly — while the docs promised
"exactly those two". The evidence-based backfill above is the answer, and a
run says how many unlabelled rows its pool holds before it starts. The
documented same-model backfill (`--job reembed:<model>@<dim>:ctx` after a
chunk setting flips) had come to pool nothing, since every rule keyed on the
label: a `--job` key is a backfill whose reason is not the model, and pools
every thought under its key as before, while the model's own key pools by the
label; preflight counts "not yet in the pool" by the same shape, so a key
naming no model is no longer counted against the recorded model while the
tool counts against its own. `vector models` judged the rows against the
record but prescribed `--switch-model` from this shell, which when the record
and the configuration disagree records *this* model and re-embeds the rows at
the recorded one — reverting the switch whose finished rows are the majority;
the remedy gives both directions now. "Not at the target" ignored a row with no
vector whose stale label named the target, so it was never pooled while the
header promised the pass would give it one — the predicate says `embedding IS
NULL OR`; and `upsert_thought`'s INSERT branch wrote a label beside a NULL
vector, contradicting the rule, so it writes none. On a model change the
start-over still returned every succeeded row and re-embedded thoughts the
rows said were already at the target; it returns the failed rows and expired
leases, and the data rule owns the succeeded ones on every run — [9]'s
switch-back now moves the rows too, and asserts that a record moved by hand
alone re-embeds no finished row. `--status` said nothing about what
preflight's new check would say; it does, when the record and the
configuration agree. `--dry-run` counted a caveat row whose thought had moved
twice, under the data rule and `--retry-fallbacks`; it counts the caveats the
data rule leaves. And PostgREST answers PGRST202 both for a missing function
and while its schema cache predates the migration, so the 020 and 021 PostgREST
remedies carry the `NOTIFY pgrst, 'reload schema'` hint. Suites after: schema
462, live 249, upgrade 24, preflight 116.

**A second pass, and the stop.** Its top finding was in the first pass's own
addition — the evidence-based backfill's `UPDATE` fired 001's `updated_at`
trigger, so every row it labelled read as edited at the migration instant, and
a client holding a pre-migration read would have been told `STALE_READ` on its
next edit of a row nothing changed — which is the signal this fork stops
reviewing on. Nine were fixed and one is a ticket. The trigger is held off for that one
statement, and `test-upgrade.ts` [4] asserts no `updated_at` moved and no audit
row was written. The first pass had narrowed the start-over to failed rows and
expired leases but left `--retry-fallbacks` gated on "not a model change" with a
message saying the change had returned every terminal row; a caveat row is
neither failed nor a lease, so the flag was silently ignored under
`--switch-model` — it is honoured on every run, and the message reports the
count. Whether a key is a model's own or a backfill, and which model it pools
against, was decided by two rules — `reembed.ts` against the configured model,
preflight against the key's — so `--status` for a key naming another model
printed a different "not yet in the pool" than preflight; `poolModelFor` in
`db/config.mjs` is the one rule, and the tool judges the rows against the
key's model, which for a run is the configured one since a foreign key is
refused. The count of unlabelled rows a run would pool was read after the
start had pooled them, so the run never printed it while `--dry-run` did; it
is read from the pool's pending rows once they exist. The PostgREST two-step
fallback replaced a vector without its label, which on a re-capture of a
labelled row left the one state nothing can see — a label beside another
model's vector; it writes both. The end-of-run paragraph told a backfill's
operator to switch a server that was fine, because under a backfill key every
capture made meanwhile is unpooled whatever model it is at; the two key shapes
get two sentences. The `--status` note about preflight's `vector models` line
was gated on the record and configuration agreeing *before* a run that then
recorded the model, so a switch's end never printed it; agreement is judged as
it stands. The Supabase Edge Function server under `server/` captured with no
label, so every row it wrote after 021 was "unknown" and re-embedded by the
next pass; it names its model in the envelope now (six lines), and the corpus
lines in both tools say "model unknown" rather than dating the row. And the
backfill's pool went through the id-array branch of `enqueue_thoughts`
(materialising every id for a DISTINCT that primary keys never need); a
backfill takes 015's set-based branch again. One finding was pre-existing and
is a ticket, not a fix: a chunkless re-capture through the 3-argument
`upsert_thought` replaces the parent's vector and label and leaves 007's chunk
rows from the previous vector (SMD-1175); 021's header no longer claims the
parent's label is the chunks' on that path (done in change 40). Suites after: schema 462, live 249,
upgrade 27, preflight 116; the three `server/` suites 47, 30, 36.

**A third pass, asked for after the stop.** Its top finding was again in the
first pass's additions — the data rule met the backfill's limit: 021 can label
nothing from a key naming no model, so the first run under an existing bare
`--job` key after upgrading found every succeeded row's thought unlabelled,
"not at the target", and returned the whole corpus to the pool — the cost the
backfill was added to avoid. Under a backfill key the data rule now returns a
finished row only when its thought's label names another model or its vector
is gone; an unlabelled row is left to its finished row there, since a
backfill's reason is not the model. Nine more, all fixed: the `--baseline`
remedy told an operator to re-run 021's body by hand, whose DISABLE/ENABLE
TRIGGER pair a failure under autocommit would separate — it says one
transaction, and preflight gained an `updated_at trigger` check with the
one-line remedy; `vector models` said ok for the migration's own motivating
corpus (a switch that died, its claim rows cleared, every vector unlabelled,
none known to be at the model the record names) — it warns, with the pass as
the remedy; 021's header claimed its trigger toggle held a lock only for the
statement between, when the migrator runs the file as one transaction and
every lock it takes is held to the commit — the header says so, and the
backfill evaluates its key regex once rather than twice per claim row; the
evidence rule trusted every succeeded claim under a model's key, but between
changes 29 and 35 `reembed.ts` accepted a `--job` naming another model than
the shell's — the header names the window and the step for a brain that ran
such a job; the Edge Function server's two-step fallback replaced a vector
without its label (the second pass had patched its capture and not its
fallback), and the portable store's fallback had been made to fail outright on
a schema without the column — both write the label and, refused the column,
attach the vector alone as before; the same-model message still called every
run "a backfill" when the model's own key pools only the rows not at it — it
says what the run pools and names the suffix key; `--dry-run`'s unlabelled
count omitted an expired lease a model change would return; and preflight
scanned `thoughts` once per finished key for a number it never prints — only
unfinished keys are counted. Suites after: preflight 118.

**A fourth pass.** Its top finding was again made of the earlier passes'
additions: under a backfill key, `--switch-model` recorded the new model and
re-embedded nothing — the narrowed start-over returned only failed rows and
expired leases, the key's data rule trusted every finished row's unlabelled
thought, and `enqueue_thoughts` skipped every thought with a row — so a brain
whose history was under `reembed:nightly` ended a model change with "Nothing to
do" and every vector the old model's. Under a backfill key every terminal row
returns on a model change, as before 021: that key cannot judge by label, and
the model's own key keeps the narrow rule. Eight more fixed: the `--dry-run`
count of caveat rows used the own key's notion of "moved" while the run used
the backfill's, and its count of unlabelled rows was a second hand-inverted
copy of the requeue rules that counted rows the run never touched — both now
derive from the start's own predicates, and the data rule's count is net of the
rows the start-over takes first; the `updated_at trigger` check was nested
inside the corpus scan's `try`, so a scan that failed hid it — it has its own,
before the scan; the backfill's DISABLE / UPDATE / ENABLE were three
statements, which a hand run under autocommit could separate — they are one
`DO` block, and the "run it as one transaction" remedy text went with the
hazard; the Edge Function server's capture test mirrored the write path
without the label and its drift guard did not name the new lines — both do;
`--status` for a key naming another model printed counts judged against the
key's model, a corpus line judged against the shell's and a preamble about
neither — every line is judged against the key's model and the preamble says
so; and the Edge Function server's label was a hard-coded spelling where
preflight compares by string equality with the record — it reads
`OB1_EMBEDDING_MODEL` with that spelling as the default. Two findings are the
boyscout's: the envelope built identically in both stores and the model
threaded beside the vector rather than on `EmbeddedCapture`, and the
corpus-by-model query and reduction duplicated between `reembed.ts` and
preflight. Suites unchanged in count.

**A fifth pass.** Seven fixed, three declined with the reason. The backfill
key's trust in a finished row was unbounded: a NULL label beside one was
"still at the target" for ever, although after 021 every row the tool finishes
is labelled, so a NULL there is a later foreign write — an un-upgraded server's
re-capture that a recurring backfill would then never re-embed. The trust is
bounded by 021's own evidence rule: `updated_at <= finished_at`, or the row
returns. The `--dry-run` caveat count under a backfill key on a model change
counted rows the start-over takes first; every count is now an exact
complement of the requeue predicates it stands beside. The `--status` note
about preflight's line was gated on the record agreeing with the *shell*
while the rows were judged against the *key's* model; both tools now judge
against one target, and a suffixed foreign key (`reembed:y@d:ctx`) is judged
against y as an own-shape one is. The own key's model change — the narrow
start-over and the data rule together — was never exercised, since every
`--switch-model` in the live suite runs under its backfill key; [9] now
switches back under the model's own key too, and asserts that only the two
relabelled rows return. The end-of-run paragraph blamed "a server on another
model" for rows that had no vector or no label; it names the three causes.
And the Edge Function server's label, a knob since the fourth pass, is checked
against the column's width once per vector, with the two named. Declined: the
backfill's `updated_at` rule treats a metadata-only edit as a write that
invalidates the pass's vector — it could be refined from the audit log, but a
raw vector write leaves no audit row either, and a rule that re-embeds a row it
need not is the right side of that line; the two-step fallback's retry without
the label also fires for a stale PostgREST schema cache and stores an
unlabelled vector — a defined state the pass re-embeds; and the in-repo
integrations (`enhanced-mcp` as well as `update-thought-mcp`) replace a vector
with a raw update and leave the label stale — outside this change, named
below. Suites after: live 252; `server/` 47, 30, 38. Then the tidy-ups the
passes had cut for space, while the files were open: the `p_payload` envelope
was built identically in both stores — `captureEnvelope` in `store.ts` beside
`actorPayload` is the one copy — and the model was re-read from the
configuration at every call site beside a vector the embedder had just
produced; `EmbeddedCapture` carries `model`, and the server and `reembed.ts`
pass that. The corpus-by-model query and its arithmetic were written in
`reembed.ts` and in preflight; `CORPUS_BY_MODEL_SQL` and
`summariseCorpusByModel` in `db/config.mjs` are the one copy. Preflight's two
PostgREST probes each created a client, and one remedy string was written
where `APPLY_021` was; `test-preflight.ts` wrote the regex-escape idiom nine
times, and has `rx()`. The ACL replay block's third copy stays: a migration
file cannot share text with another, and a SQL helper for it would be a fourth
thing to carry.

**Found on the way.** The schema probe asked `to_regclass('schema_migrations')
IS NOT NULL AND EXISTS (SELECT … FROM schema_migrations)` in one statement, and
Postgres resolves the relation when it parses the statement, whatever the `AND`
would have short-circuited — so a schema applied by hand, with no ledger,
crashed `reembed.ts` at that probe. The ledger is asked in a second statement,
only when it exists.

**Held in the tests.** `test-schema.ts` [22]: the column and its comment; the
label written from the envelope, NULL without it and through the 2-argument
form; a re-capture with a vector relabels, one without keeps vector and label,
a metadata-only one too; `update_thought` relabels with a vector, blanks with
content and no vector, leaves a metadata-only edit, and resolves a 7-argument
call through the default; no audit row for a re-embed or a label-only change;
one `update_thought` of eight parameters carrying 018's body by name, 021 the
last definer of both writers and 010 still of the audit trigger; 018 re-applied
puts a second form beside it and a 7-argument call is `not unique` until 021 is
re-applied; and the ACL across the drop — [21]'s four cases for this function.
`test-upgrade.ts` [4]: 021 onto a populated 020 — rows before read NULL, a
capture and a re-embed after carry the label, the 7-argument form is gone,
re-applying is a no-op. `test-live.ts` [9]: every re-embedded row carries the
model that produced its vector; then the ticket's case — a server still on the
old model re-captures one text and captures a new one after the pass finished:
preflight `vector models` warns `2 at old-model` from the rows while `re-embed
pass` says none unfinished, `--status` prints the corpus by model and counts
one thought not yet in the pool (the switched server's capture, at the target,
is not counted), `--dry-run` says the finished row returns and the new one is
added, a plain re-run re-embeds exactly those two and says nothing about
guessing, the switched server's capture never enters the pool. The switch-back
at the end re-embeds 41 rather than 42 for the same reason. `test-preflight.ts`
[5]: rows at two models with an empty claim table warn with the counts and the
pass as the remedy, `--json` carries it; a corpus wholly at the recorded model
is ok with the unlabelled row as detail; the record on another model puts
`--switch-model` in the remedy; the column dropped fails naming 021 and 021
re-applied brings it back unlabelled; 018 beside 021 fails with the exact DROP,
018 in its place fails naming 021. The store suites and the e2e suite assert the
label on capture and on an edit, on both stores. Suites after: schema 461 at
both widths, live 245, upgrade 20, preflight 115, sql 59, e2e 63, postgrest 43,
update-delete 39 (before the pass below).

**Not done here.** Chunk rows left by a chunkless re-capture through the
3-argument `upsert_thought`, which predate this change (SMD-1175) — done in
change 40; the community integrations `update-thought-mcp` and `enhanced-mcp`, which write
content and vector with a raw update around `update_thought` and so leave a
stale label as they leave a stale fingerprint — done in change 69, with seven
more files the check found. A label for the rows no finished pass
vouches for — there is no fact to backfill from; the first pass over them
labels them, and says how many before it runs. `--accept-failed` and
`--retire` (SMD-1067) — done in change 39, where accepting a row means exactly
that: it stays at the old model, the caveat says so, and both readers of the
row honour it while nothing has written the thought since.

### 39. The operator's way to say "I know" — `--accept-failed` under the caveat rule, `--retire` for a superseded key, and preflight names both

`db/reembed.ts` and `server-portable/preflight.ts` (Linear SMD-1067, filed by
change 35's first review pass). No migration. Since change 35 preflight reports
a re-embed pass unfinished while any row under its key is pending, leased or
**failed**, and the container runs preflight on every start. Right for a row a
retry can fix; endless for one the provider refuses permanently — a content
filter that rejects one thought on every attempt — where `--retry-failed`
re-fails it every time and the row keeps the vector it had. Change 34 covered
the permanent *over-length* refusal (a 413 → succeeded, the head window stored,
the refusal on the row as a caveat); a permanent *content* refusal has no
partial result to store, and the only silencers were deleting the thought or
clearing its claim row by hand — the "permanent warning nobody can clear" that
preflight's own filtered-search check refuses to be. The same shape once more: a
key whose model is no longer the recorded one (a switch abandoned or reverted)
was reported with a hand `DELETE FROM thought_work_claims WHERE work_type = …`
as one of its two remedies.

**`--accept-failed <thought-id…>`, under change 34's rule.** The failed row
becomes succeeded with the caveat `kept the vector it had; accepted by the
operator: <the failure>` — `ACCEPTED_CAVEAT_PREFIX` in `db/config.mjs`, the one
spelling both tools read — and the row's timestamps stay the *failure's*: the
bound below is measured from `claimed_at`, the moment the attempt read the
content the provider refused, not from the acceptance (first review pass:
stamping its time would have spoken for content edited between the two, which
the caveat never described) nor from the release (second pass: an edit landing
while the provider was still refusing would have hidden behind it). The rule is
unchanged: a succeeded row's `last_error` is what the worker could not do, here
what the operator has accepted it will not do. No fifth status (015's CHECK
would need a migration for four lines of value), no column. Per row, by id;
`--all` exists and is explicit, says that a provider outage accepted that way
hides itself, and takes no ids beside it. An id that is not a *failed* row
under the job — succeeded, pending, leased, or no row — refuses the whole
command with each id's state, and nothing is written; so does a shell whose
model is not the recorded one (the failed rows under its key are a pass that
has not recorded itself: run it with `--switch-model`, and accept what it
leaves); so does a schema that is not 021's whole — the same refusal a run
makes — because 021's evidence backfill trusts every succeeded row under a key
naming a model, an accepted row included, and would label the thought at a model
whose pass never wrote its vector (the remedy that re-runs 021's body on a
`--baseline`'d brain now says to return accepted rows first); and so does a
failed row whose thought has *no vector*, passed over and said under `--all`,
since acceptance keeps a vector and a thought with none would vanish from search
with nothing left to say so; and so does a failed row whose thought was written
since the attempt read it while not at the target — the acceptance would be void
as written, every reader applying the bound below, and the next run would spend
it (third pass; a thought at the target, its head window the worker's own write,
is accepted whatever its timestamps). Every argument is accounted for: an id
after another flag, a flag the tool does not have, a flag given twice, or a flag
that takes a value followed by another flag, is refused rather than dropped or
read as the value (second pass — `--accept-failed a --dry-run b` accepted one
row and exited 0; third — `--job --switch-model` would have backfilled the
corpus under the key `--switch-model`). `--status`
counts them inside the caveat parenthesis ("37 succeeded (2 with a caveat, 1
accepted by the operator)") and lists them among the caveats; every list of
failed rows names the flag; `--retry-fallbacks` returns them like any caveat,
which spends the acceptance — `requeue` clears `last_error`, a second refusal
fails the row again, and the operator accepts again or not.

**What acceptance means to the two readers, and its bound.** This is where the
ticket met change 38. Since 021 the rows say which model they are at, and
`reembed.ts`'s data rule returns any succeeded row whose thought is not at the
target to the pool on every run — which an accepted row's thought is, by
decision; and preflight's `vector models` warns about every vector at another
model. Left alone, the next plain run would have un-accepted the row and the
label would have kept the warning alive by another route. So both readers
honour the acceptance: the data rule leaves an accepted row (`NOT (accepted AND
updated_at <= finished_at)`, under either key shape), and `vector models` counts
its vector as detail — "41 at stub-embed, 1 at another model accepted by the
operator (old-model: 1)", an ok — a warning counting only the un-accepted. Each
ONLY WHILE NOTHING HAS WRITTEN THE THOUGHT SINCE THE ATTEMPT READ IT:
`updated_at <= claimed_at` (`finished_at` for a row never claimed, and a
hand-written row with neither is never standing rather than NULL — third pass),
the shape of the bound 021 gave its backfill and change 38's fifth review pass
gave the data rule under a backfill key. An edit, or a re-capture, is a new question, and the
row returns to the pool as any moved row does (a metadata-only edit reopens it
too: one evidence rule, not two). Preflight counts an acceptance only under the
recorded model's *own* key (`ACCEPTED_BY_MODEL_SQL`; a backfill key's acceptance
tells the backfill, while the own pass pools the thought by its label whatever
another key accepted — counting it would have silenced the check while the own
pass re-failed the thought on every run, first review pass): an acceptance
under B's key says "stays where it is while the corpus moves to B", and after a
move to C it says nothing — C's own pass has no row for the thought, pools it,
and it is accepted under C's key or not. The claim table may lower that warning
because the acceptance *is* the operator's word about exactly those vectors;
clear the table and the warning returns, which is right — the acknowledgement
was deleted. Everything else sees the succeeded row it is: `enqueue_thoughts`
skips it by primary key, `--retry-failed` does not see it, a model change under
the model's own key restarts failed rows and expired leases and leaves it;
under a backfill key every terminal row restarts, accepted included, as before.

**`--retire <key>`.** One qualified `DELETE`, in TypeScript, of a *superseded*
pass's rows — a key whose `reembed:<model>@<dim>` is not the recorded model,
the recorded model at another width (which nothing can complete), or a
`reembed:` key naming no model (an abandoned backfill) — printed by preflight
as the remedy in place of the hand statement. Refused, with nothing written: a
key without the prefix (another tool's pass), a key naming the recorded model —
or this shell's, when nothing is recorded — at the column's width, suffix or
not, whose pass can be finished or its
failed rows accepted (both tools judge a key's width by the *column's*, before
any record — a pass runs at the column's width and no other, so a hand-edited
record must not make the one finishable key superseded — and the current model
is the record's, or this server's when nothing is recorded, in both: second and
third passes, where this server's configured width had stood in for a column
preflight never read, and where preflight with nothing recorded sent a stale key
to "finish it under X"), a key with a live lease (a pass under it is running —
the check and the DELETE are one transaction over the key's locked rows, the
DELETE bounded to those rows and the record's row read `FOR UPDATE` inside, so a
`--switch-model` back to that model either committed first and is seen or waits
— second pass read it plainly, and a switch that locked none of the key's rows
could commit unseen in between, third), and a key with no rows (a typo is the
likelier cause). It prints what it removed, judged against the current model
rather than this shell's, worded by what the pass did, and
then the corpus by model: the vectors the retired pass wrote are still at its
model, and `vector models` reports them until they are re-embedded — the truth
the rows keep once the record is gone. Both flags are maintenance modes like
`--status`: the claim table and nothing else, no provider, no model recorded;
they combine with `--dry-run` and with nothing else. Preflight's `re-embed
pass` remedies name both: `--accept-failed <thought-id…>` under the key's own
`--job`, beside `--retry-failed`, wherever a key has failed rows and the remedy
does not carry `--switch-model` (the tool refuses the two together, and refuses
acceptance under a model change — the switch first, then what it leaves); and
`--retire <key>` in the superseded and other-width branches — and a configured
key the record has moved on from is a superseded key too, judged before the
configured-key branch, so its operator gets both remedies rather than "finish
it" alone (third pass). `--status` and a run predict preflight's second `vector
models` warning too — no vector known to be at the model, its vectors all
accepted or unlabelled — so the two tools still never disagree; and the hint
under a list of failed rows names what *this* shell can do — `--retire` for a
key naming another model, `--accept-failed` after the switch under a model
change.

**Verify, as the ticket asked.** `test-live.ts` [9]: the poisoned row that never
recovers — `--accept-failed` with no ids refuses listing the three failed rows
and both forms, an id whose row is succeeded refuses the whole command, a run
flag beside it refuses, `--dry-run` says what it would accept; accepted, the row
is succeeded with the caveat naming the failure, keeps its vector, is counted
inside the caveat count and listed by `--status`, refuses a second acceptance,
`--retry-failed` re-embeds the other two and does not see it, and
`--retry-fallbacks` returns it with the head-window row and re-embeds both.
Then the seam with 021, under the model's own key: one of the two rows the old
server wrote is the poisoned text, so the plain run re-embeds one and is
refused the other, which keeps the old server's vector and label; preflight
warns from the claim row (naming `--accept-failed`) and from the label;
accepted, preflight says `none unfinished` and `41 at stub-embed, 1 at another
model accepted by the operator (old-model: 1)` as an ok; a plain run has
nothing to do — the data rule stops at the operator's word; the old server
saves metadata on it, and `--dry-run` says the row returns and preflight warns
again; once the provider relents the run re-embeds it. `--retire`: an abandoned
switch's key is reported with `--retire` and no DELETE; the recorded model's
key, another tool's key, an empty key and a key with a live lease are refused;
`--dry-run --retire` of the suite's key says what it would remove; the
superseded key's two rows are removed and preflight has nothing left.
`test-preflight.ts` [5]: the configured key's remedy names `--accept-failed`;
the superseded and other-width remedies name `--retire` and no DELETE; an
accepted row's vector is detail beside the recorded model's, a second
un-accepted row at that model warns counting only itself, and an edit since the
acceptance is no longer spoken for. Suites: live 286, preflight 123; schema 462
at both widths, upgrade 27; the rest unchanged (before the pass below).

**A first pass, triaged.** Ten findings, all fixed, none ticketed — each a seam
between the acceptance and a rule that already read the row. The acceptance
test inside the data rule was `NOT (starts_with(last_error, …) AND …)`, and
`starts_with(NULL, …)` is NULL: every ordinary succeeded row's predicate went
NULL, so a thought that moved before its claim was released was never returned
— now `last_error IS NOT NULL AND …`, and the live suite constructs that row.
Acceptance stamped `finished_at = now()`, so an edit between the failure and the
acceptance was covered by a caveat that never described it — the failure's own
`finished_at` stays. `ACCEPTED_BY_MODEL_SQL` matched keys by model name, so an
acceptance under a backfill key silenced `vector models` while the own key
re-failed the thought — the own key only. A corpus with zero vectors at the
recorded model and every foreign one accepted fell through to ok — `at === 0`
warns whatever is accepted. `--accept-failed` ran on a pre-021 schema, where
021's backfill would then trust the accepted row — refused. `--all` beside ids
took every failed row — refused. The counts called a row accepted by prefix
while both readers applied the bound — the counts apply it too. `--retire` with
no width recorded refused every width while preflight sent the operator to a
`--job` the tool refuses — the column's width stands in, in both. With no model
recorded the configured shell's own key was retireable, and the lease check and
the DELETE were two statements — this shell's model counts, and the two are one
transaction over the key's locked rows. The accepted rows were listed from the
SELECT before the UPDATE — from its `RETURNING`. Cut for space by the pass and
left for the tidy-up: the inline copy of `notAtTarget()` inside the data rule.
Suites after: live 293, preflight 126.

**A second pass, triaged.** Ten more, all fixed, none ticketed; the top one was
in the first pass's own addition — the bound — which by the stop rule of
change 38 is the signal, and by its exception (the bound is read by three
rules) is why a third pass is worth asking for. `finished_at` is the release's
time, and the failed attempt read the content at `claimed_at`: an edit landing
while the provider was still refusing was covered — the bound is `claimed_at`
now, everywhere it is written, and the live suite dates a claim back to show
the acceptance drop. Accepting a failed row whose thought has no vector wrote
"kept the vector it had" onto nothing and silenced the last signal that the
thought is invisible to search — refused by id, passed over and said under
`--all`. The remedy that re-runs 021's body on a `--baseline`'d brain would have
had its backfill trust an accepted row — the remedy says to return them first,
and acceptance now needs 021's schema whole, as a run does. `--retire`
protected this shell's configured model unconditionally, so the shell that ran
an abandoned switch could not retire it — the record's model is current, this
shell's only when nothing is recorded. Preflight substituted this server's
`OB1_EMBEDDING_DIM` for a column width it never read — it reads it now.
`values()` stopped at the next flag, so `--accept-failed a --dry-run b`
accepted one row — every argument is accounted for. `--retire`'s DELETE took
rows committed after its lock, so a `--switch-model` back to that model landing
between the two lost its pool — the DELETE is bounded to the locked rows and
the record re-read inside. reembed.ts predicted only one of preflight's two
`vector models` warnings — both now. The `--accept-failed` clause preflight
printed carried neither the key's `--job` nor the `--switch-model` context, so
for a backfill key it accepted under the wrong key and beside a switch it was a
command the tool refuses — under the key, and omitted beside a switch. Cut for
space by the pass and left for the tidy-up: the bound spelled four times, the
inline copy of `notAtTarget()`, two vocabularies for one corpus line, the
`O(F²)` filter under `--all`, `--retire` materialising every row to count by
status. Suites after: live 298, preflight 128.

**A third pass, triaged.** Ten more, all fixed, none ticketed; the top one was
again in the previous pass's own addition — the argument scanner — and three of
the rest were cells of the same tables the first two passes had drawn (the
width authority, the current model, the bound's NULLs). The scanner read a flag
as another flag's value: `--job --switch-model` backfilled the corpus under the
key `--switch-model` — a value must be one, and a flag given twice is refused
rather than its second list dropped. `--retire` and preflight judged a key's
width by the record before the column, so a hand-edited record made the one
finishable key superseded — the column first, in both. The record re-read inside
`--retire`'s transaction was a plain read: a `--switch-model` back to that model
that locked none of the key's rows committed unseen between the lock and the
DELETE — the record's row is read `FOR UPDATE`. Preflight's "another model"
test required a recorded model while `--retire` fell back to the shell's, so
with nothing recorded a stale key was sent to "finish it under X" — the same
fallback in both. `--accept-failed` wrote an acceptance every reader would treat
as void when the thought had been written since the attempt read it — refused,
with `--retry-failed` named, for a thought not at the target. The corpus line
after a `--retire` was judged against this shell's model, so the shell that ran
the abandoned switch was told the whole corpus was elsewhere — against the
current model, and "wrote no vector" when it wrote none. A configured key the
record had moved on from got "finish it" alone — the superseded branch first.
The failed-rows hint offered `--accept-failed` under `--status` in the two
states the tool refuses it — it names `--retire` or the switch there. A
hand-written accepted row with neither timestamp evaluated NULL in every reader
and was never returned — `-infinity`, so it is consistently not standing. Cut
for space and left for the tidy-up: the standing predicate spelled three times,
the width read twice, the flag-arity table beside `flag()`/`values()`, the UUID
regex `store-sql.ts` already has, dead `values("all")`. Suites after: live 303,
preflight 131.

**Tidy-up, while the files were open.** No behaviour change. The standing bound
is spelled once in `reembed.ts` (`standingBound()`, for a thought aliased `x`
beside an unaliased claim row, which is how every reader there joins the two —
the acceptance query is re-aliased to match) and once more in `config.mjs` for
preflight and the corpus query, where the aliases differ; the data rule's
own-key branch reuses `notAtTarget()` instead of its inline copy; the flag-arity
table sits beside `flag()`, `has()` and `values()`; the dead `values("all")`
test is gone (the scanner refuses anything after `--all`); the chosen rows are
filtered by a set; the comment that said a reaped lease lacks `finished_at`
says what 015 does. Left: `store-sql.ts`'s UUID pattern is inline, not
exported, and that file is not this change's to touch; `--retire` reads the
key's rows rather than counting them, because the lock and the bounded DELETE
need them; the corpus line's wording differs between the two tools, and
changing it is a change in what they print.

**Not done here.** An acceptance under a backfill key is spent by a model change
(every terminal row restarts there, as before 021), so a corpus whose history is
under `reembed:nightly` re-asks every accepted row on a switch. 021's evidence
backfill is applied and never edited, and trusts a succeeded row whatever its
caveat: the gate on 021 closes the upgrade path, and a hand re-run of 021's body
over accepted rows whose thought is unlabelled is the case that remains, said in
`reembed.ts`'s header (done in change 56: the migrator owns the re-run, and
migration 030 takes back a label whose only evidence is an acceptance). The
extraction worker has no acknowledgement path of its own — its failed rows are
016's, and preflight does not read them.

### 40. A re-capture's windows stay while the label vouches for them — migration 022 redefines the 3-argument `upsert_thought`

`db/migrations/022_capture_replaces_chunks.sql` and `server-portable/preflight.ts`
(Linear SMD-1175, filed by change 38's second review pass). `upsert_thought(text,
jsonb, vector)` — 004's atomic capture, last redefined by 021 — replaced the
parent's vector and label on a re-capture of the same normalised text and never
touched `thought_chunks`. Only the 4-argument form (007, 013) and
`update_thought` (009, 018, 021) replace chunk rows, and every caller routes a
capture that produced no windows to the 3-argument form: both stores
(`chunks.length ? 4-arg : 3-arg` — a deployment stopped before 007 has no
4-argument form, and no 022 either) and the Supabase Edge Function server,
which never makes windows. So a
thought first captured with windows and re-captured through a path that made
none — the Edge server, or `server-portable` after `OB1_CHUNK_TOKENS` grew or
the provider's window changed so the text fits one call — kept the windows of
the vector it no longer had, and `match_thoughts` found it by them. Silently:
no error on the write, none on the search. Pre-existing since 007; since 021
also invisible: the re-capture labels the parent at the new model, so `vector
models` reports it at the target and the re-embed's pool skips it — old-model
windows under a parent that says it is at the new model.

**The windows stay while the label vouches for them.** Migration 022 redefines
the 3-argument body — 021's, 005's guard and 008's actor and 021's label carried
— when a vector arrives, reading the row the capture lands on `FOR NO KEY
UPDATE` before the write, and adding one block after it: when the row was there
to lock and its label does not vouch for the windows, `DELETE FROM
thought_chunks WHERE thought_id = v_id`. Locked, because under READ COMMITTED
an `ON CONFLICT DO UPDATE` lands on whatever row holds the fingerprint when it
runs — one a concurrent transaction committed after this one's snapshot
included — so a label read without the lock could be the row's label before an
edit that changed it; `update_thought` locks the row `FOR UPDATE` (018), which
conflicts with this lock, so the two are ordered either way. `FOR NO KEY
UPDATE` and not `FOR UPDATE`, because every foreign key onto `thoughts(id)`
holds `FOR KEY SHARE` on the parent while its inserting transaction is open and
`FOR UPDATE` is the one row lock that conflicts with it: `reembed.ts` enqueues
a corpus in one transaction, and with `FOR UPDATE` a re-capture of any existing
text waited out the whole enqueue (4 s against a small held one in the third
pass's measurement, 1 ms with this lock). Two shapes the row lock cannot cover
— two first captures of one text racing, and an edit moving another row onto
this text — find no row to lock, and remove nothing: the other writer's windows
stay, as under 021, at another model the SMD-1175 state for that race only;
SMD-1043's advisory lock on the fingerprint, which `update_thought` already
takes, makes the read find the row and closes both (done in change 63). The label vouches exactly
when the
row's vector was labelled with a model and the arriving vector is labelled with
the same one: the windows were written in the same call as the vector before,
by that model (021's rule), and 003's fingerprint says the text is the same, so
they are still that model's vectors of windows of this text — a note windowed
by `server-portable` and re-saved through the Edge server at the same model
keeps the tail-anchored recall 007 added. Any other case removes them: a label
unknown on either side (a vector from before 021, a caller naming no model), or
another model. No vector arriving keeps vector, label and windows alike. The
rule lives in the one body every caller reaches — both stores, the Edge server,
any PostgREST integration calling the RPC by name — rather than in two stores
taught to always call the 4-argument form with `'[]'`, which would have left
`server/index.ts` and every third-party caller as they were. Why not
unconditional, as the 4-argument form and `update_thought` are: those callers
*send* windows, or send content that may have changed, so the windows are
theirs to supply; a chunkless re-capture of the same text supplies nothing
about them, and the label is the one fact in the row that says whether they
are still the vector's. The 4-argument form is not redefined: it delegates to
this one and then replaces the windows with the caller's whatever the label,
and 013 stays its last definer. Considered and not built: a trigger on
`thoughts` — `AFTER UPDATE OF embedding`, when the vector or label changed and
the old label does not vouch — which would see the row's old label as `OLD`
for every writer, with no lock and no sentinel. The two writers that send
windows already replace them wholesale, so the trigger would run beside their
DELETE on every edit and every re-embedded row; the rule is about the one
writer that sends nothing about the windows, and it also fires on a raw
UPDATE of the vector, which 021 leaves to the operator on purpose. If a fourth
writer ever needs the rule, the trigger is where it goes. No backfill: a
window left before 022 cannot be told from a live one; a `--job` pass
regenerates every thought's windows through `update_thought`, and the header
says so.

**What it costs.** When a vector arrives, one probe on 003's unique index — on
the row the INSERT is about to lock anyway — and, on a re-capture whose label
does not vouch, one DELETE bounded by `thought_id` on 007's index; a fresh
insert runs the probe and nothing else, a capture with no vector neither. Two
consequences of "unknown vouches for nothing" are decided on purpose and said
in the header: a row 021 left unlabelled loses its windows on its first
chunkless re-capture at any model, the same one included — keeping them would
be SMD-1175's case for exactly those rows, and the remedy is the pass 021
already asks for, which labels and re-windows them; and "the same model" is
021's string equality, so two servers spelling one model two ways are two
models to this rule as to `vector models`. The first
version ran the DELETE on every vectored capture, fresh inserts included, and
was measured so at 1,024 dimensions, 2,000 operations per line, two rounds each
side on one container: fresh 3-argument captures 0.9–1.4 ms each at 021 and
1.2–1.4 ms at 022; re-captures 1.3–1.6 ms and 1.2–1.4 ms; re-captures with no
vector 0.35–0.46 ms and 0.32–0.38 ms. Inside the run-to-run spread, on either
side of it; this version does less.

**The sentinel, the privilege, and preflight.** The body carries
`ob1:vector-replaces-chunks`, a contract sentinel in 014's convention: 021
re-applied by hand puts 021's body back — `CREATE OR REPLACE`, no error, and the
defect with it — and nothing else would say so. Over a direct connection
preflight's `atomic capture` check reads every `upsert_thought` form in one
schema-qualified catalog read and warns without the sentinel, naming 022 — a
warning, not a refusal: captures work, and search is merely over-inclusive. A
missing 3-argument form names 022, its last definer, not 004 (whose body would
drop 005's guard, 008's actor, 021's label and 022's rule); a missing
2-argument form names 005. The function is SECURITY INVOKER, so the DELETE runs
as the calling role: a role that only ever captured chunklessly never needed
DELETE on `thought_chunks` (007's 4-argument form and `update_thought` did),
and does from here — a check of its own (`chunk delete privilege` then;
since SMD-1226 the wider `write privileges`) reads
`has_table_privilege` for the connection's role wherever the table exists,
schema-qualified (the bare name resolves through `search_path` and raises for a
relation it cannot see), and refuses to start without it, printing the GRANT.
Two facts, two remedies, so a body from before 022 and a role without the
privilege are both said at once rather than the second surfacing only after
the first is fixed. Over PostgREST neither is reachable, and both checks say
so as skips.

**Verify, as the ticket asked.** `test-live.ts` [7]: a thought at `old-model`
with two windows, found by its second; re-captured through the 3-argument form
at the same model → the windows stay and the thought is found by the window and
by the new vector; at another model → no windows, no longer found by the old
window's axis, found by the new vector's; a re-capture with no vector keeps the
windows, vector and label whatever label it names. `test-chunking.ts` [5b]: a
text over today's window and under the provider's batch with a sentinel at
each end — the whole-content vector on the first's axis, the second window
alone on the other's, so the ending is answered by the window or not at all —
captured through the server as two windows and found by both; the same text
embedded with the window at the batch makes no windows, written through the
store at the same model keeps the windows and the ending still answers, at
another model leaves none and the ending no longer does (the server snapshots
its environment on its first request, so the grown window runs the embedding
path with the new configuration, as the suite already does for a changed
setting). `test-store-sql.ts` [6] and `test-store-postgrest.ts` [6]: the
store's routing to the 3-argument form keeps the windows at the same model and
leaves none at another, on both stores, and none over an unknown label on the
PostgREST one. `test-schema.ts` [23]: the rule through a planted window (PGlite
cannot run the 4-argument insert) — same model keeps, another removes, no model
on either side removes, no vector keeps — the sentinel and the locked read in
the body with 021's carried parts, the 4-argument form still 013's, three
overloads, 022
the last definer of `upsert_thought`, and the trap: 021 re-applied leaves the
windows again, 022 re-applied removes them. `test-upgrade.ts` [5]: 022 onto a
populated 021 — the defect shown at 021, after 022 a same-model re-capture
keeps the window and another model's removes it, no column or signature
changed, the window left before 022 left where it was, a re-apply a no-op.
`test-preflight.ts` [5]: 021 re-applied over 022 warns naming 022, 022
re-applied is ok, the 3-argument form dropped is refused naming 022 and not
004, and a capturing role without DELETE on `thought_chunks` is refused with
the GRANT and starts once granted. Suites after: schema 483 at both widths,
live 308, upgrade 36, preflight 138, chunking 35, sql 62, postgrest 46.

`test-live` [7]'s three found-by assertions (five `foundAt` calls, two of them
window reads at axis 2) go through `match_thoughts`'s filtered branch since
SMD-1574: a metadata key only the re-captured thought carries, so 014 scores
it and its chunks by id and no walk decides — the section no longer exercises
the HNSW path at all. Read unfiltered, the same-model assertion missed the
freshly moved vector in five CI attempts on three trees that touched nothing
under `db/`, and four times in thirty-seven local runs; the ticket's own
reading — ten live rows tied at the axis — was wrong, since [7] starts from an
emptied table and has three thoughts and four chunk rows under a returned
limit of ten and a candidate window of forty. What the dumps showed, what was
measured and what still reads the walk are in "Known issues we did NOT fix"
under SMD-1632; [5b] holds the walk's recall on random vectors, [5c] its plan.
Three review passes and a boyscout, all prose: the accounting of runs, the
hedges on what was shown, and this note cut to its place.

**A first pass, triaged.** Its top finding was the rule itself: the first
version deleted the windows on every vectored re-capture, and on the path the
header names — a `server-portable`-windowed note re-saved from Claude Desktop
at the *same* model — that lost the ending from search, silently, for a
thought whose windows were still valid. The label vouches now (above). The
rest: the DELETE runs as the calling role and nothing said so (the Safety
block, and preflight's privilege check); over the default PostgREST store the
check printed nothing rather than a skip; a missing 3-argument form sent the
operator to 004; `to_regprocedure` resolved through the session's
`search_path` (a NULL on PG16, a raise on PG15 that took every later check with
it) where one schema-qualified read serves; the chunking test's two search
assertions were satisfied by the whole-content vector alone; the live test
raised the suite's floor on the width to 10; the preflight suite's first
assertion matched the warn line too; a symbol rename had rewritten a comment;
and [22]'s restore of `update_thought` re-ran 021 over 022's body, which the
helper's own rule — pass both names — covers. Two findings were refuted by the
pass itself: the `xmax` distinction (the probe is measured inside noise) and
`content_fingerprint_of` in this body (SMD-1043's, said in the header).

**A second pass, triaged.** Its top finding was in the first pass's addition:
the label was read at the statement's snapshot, in a CTE, and under READ
COMMITTED the `ON CONFLICT` lands on the row as committed when it runs — an
`update_thought` at model B writing B's windows between the read and the write
would have had them removed by a capture that read "A". The read is `FOR
UPDATE` now (above), and `v_existed` is gone with the CTE: `(old = new) IS NOT
TRUE` is the whole condition, and it runs the DELETE in the racing-first-
captures case the flag would have skipped. The rest: `has_table_privilege` by
bare name resolved through `search_path` and would have raised into the block's
catch, silencing every later check — qualified and guarded with `to_regclass`,
and split into its own check with its own remedy; the migration's title and
Expected outcome, and this change's heading, still stated the first version's
rule; the role fixture created a cluster-wide role with no guard and no
`finally`, and swapped credentials into a URL that might carry none — guarded,
`finally`, and a skip; the PostgREST store test proved only the unknown-label
case, so the claim about both stores was wider than the tests; [23] pinned the
whole block's text with whitespace-sensitive regexes beside a sentinel that
exists so the contract is a marker — shrunk to the sentinel and the lock. The
trigger alternative is recorded above with the reasons. Refuted by the pass
itself: "apply 022 alone" as a remedy (the `vector models` failure fires first
on a pre-021 schema), the `IS NULL` arm as a defect (the documented
trade-off), and the Edge server's GRANT (Supabase's defaults, or 008's audit
trigger fails first).

**A third pass, asked for after the stop.** Its top findings were in the second
pass's additions. The locked read was `FOR UPDATE`, the one row lock that
conflicts with the `FOR KEY SHARE` every foreign key onto `thoughts` holds, so
a re-capture blocked behind an open `enqueue_thoughts` for its whole duration
(reproduced by the pass) — `FOR NO KEY UPDATE` now, ordered against
`update_thought` and nothing else. The DELETE ran on every fresh insert, which
needs the privilege before Postgres looks for rows, and made two races the lock
cannot cover destructive — a `FOUND` flag after the read bounds it to a
re-capture, so those races remove nothing, as under 021, until SMD-1043's lock
closes them (change 63); the read itself runs only when a vector arrives. The remedy for a
missing 2-argument form re-applied 005, which redefines the 3-argument body too
— it says "then 022", and the missing form is a warning, since this server
never calls it. The GRANT remedy quotes the role; the privilege check's ok text
says what it checked, DELETE and nothing more; the fixture skips where the
connection cannot create a role; [22]'s two other restores of `update_thought`
name both writers. Two findings were trade-offs the tests already lock in, and
are now said as such above rather than changed: an unknown row label removes
the windows, and the label is a string.

**Tidy-up, while the files were open.** No behaviour change. `test-schema.ts`
asked "how many functions of this name" through five identical closures, one
per section; `functionsNamed()` at file scope is the one copy (section [16]'s
`count`, which takes a table and a WHERE clause, is a different helper and
stays). Preflight's privilege query resolved `thought_chunks` twice; once, in a
subquery. `test-upgrade.ts` [5]'s first
assertion read the window count and the label twice each, the printed value a
second read. Left: the chunk-count closures in the store and chunking suites
count different rows by different joins, and a shared helper would carry the
join as a parameter — more to read than it saves.

**Not done here.** Windows left before 022 — no backfill, since nothing can tell
them from live ones; a `--job` pass is the remedy, and a brain upgraded through
021 that has not run a pass should run one before re-saving long notes from a
chunkless server. SMD-1043's advisory lock in both inserting overloads
(change 63, migration 033) redefines this body and carries the locked read with its `FOUND`, the
block and the sentinel forward, as 022's header lists; its fingerprint lock
also closes the two races above. `server/index.ts` is
unchanged: the migration fixes its path. The 4-argument form's body has no
sentinel and no check; a hand re-apply of 007 over 013 would drop the context
column from the chunk insert, which preflight's `chunk context` check reads
from the rows rather than the body.

### 41. 003's missing half — migration 023 fingerprints every legacy singleton, and the oldest of each twin group, once

`db/migrations/023_content_fingerprint_backfill.sql` and
`server-portable/preflight.ts` (Linear SMD-1042, filed by change 33's first
review pass). Migration 003 added `content_fingerprint` with a partial unique
index and no backfill, and its header gave no reason. Every row from before it
carries NULL, and so does every row a load inserted around `upsert_thought` —
the getting-started guide's hand-pasted schema is exactly such a brain. So a
capture of a legacy row's text inserted a SECOND row: `ON CONFLICT` cannot see a
NULL, the capture succeeded, search returned both, and every later capture of
that text merged into the new row while the old one stayed. 018 states this and
does not fix it; its only backfill is one row at a time, on the rows a re-embed
pass visits, and a brain that never switches model keeps every pre-003 singleton
unfingerprinted for ever. 018's header deferred the ownership rule here in so
many words — "whichever edit committed first, until SMD-1042 states a rule
(oldest by `created_at`) and applies it to the rest".

**The rule: the oldest takes the key, when the key is free.** A row without a
fingerprint takes `content_fingerprint_of(content)` (016's function, byte-
identical to 003's inline rule) when no row holds that key and it is the oldest
of the NULL rows that hash to it — `created_at`, then id, NULL `created_at` (a
raw load may leave it) last: the order `reembed.ts`'s pairs list prints a group
in — and the list now marks the row holding the key, so what 023 decided is
readable there (a fingerprinted row keeps the key whatever its age). A legacy
singleton — the common case — is fingerprinted and a capture of its text merges
into it from then on. True twins end with exactly one fingerprinted and the rest
NULL, the state 018 leaves after a pass, so `duplicate_of` and the pairs list
keep meaning what they meant. A NULL row whose key another row holds — the same
text under a fingerprint, or a stale key left by a raw update of content (018's
`fingerprint_held_by` case) — stays NULL: the key is taken, whatever the
holder's text, and 018 decided that. No existing key is touched, right or stale.
Not the community recipe's rule: `recipes/fingerprint-dedup-backfill` strips
punctuation, possessives and plurals before hashing, so its fingerprints never
match capture's; a brain that ran it holds stale keys, and 023 leaves them.

**A function, so the remedy is one statement.** The rule lives in
`backfill_content_fingerprints(p_limit integer DEFAULT NULL)`, and the file
calls it once. 021's backfill is an inline `DO` block; this one is a function
because it is needed again — a load that inserts into `thoughts` directly after
023 leaves NULL rows again, and the remedy is then `SELECT
backfill_content_fingerprints();`, one statement preflight can name rather than
a body to paste (the remedy shape SMD-1193 found wanting). Re-applying the file
re-runs it and it writes nothing: it hashes only the rows whose fingerprint is
NULL and whose key is free. `p_limit` is for the by-hand path — batches until it
returns 0, and the `NOT EXISTS` sits inside the limited set so 0 means none
remain (`p_limit` is at least 1; 0 is refused). It returns the rows it found
waiting — each written unless a writer settled it while the call waited for the
lock, and a row settled that way is no longer waiting — so a loop until 0 is
exact. The scan runs before the lock, at ACCESS SHARE, into a temporary table
dropped with the transaction; under the lock the rows found are re-checked by
index — still NULL, still the text that was hashed, the key still free — so a
batch costs its writers the batch's own writes and never a rescan of every NULL
row, and a raw edit of content in the window is never given a key for text it
no longer holds. The file's own call takes `{{BACKFILL_LIMIT}}` — NULL unless
`OB1_BACKFILL_LIMIT` is in the migrator's environment at that invocation, the
channel `{{TRGM_INDEX}}` already uses, validated in `config.mjs` and forwarded by
the compose migrate service.

**One transaction, and the lock is the point.** Once the scan has found rows,
the function takes `LOCK TABLE thoughts IN EXCLUSIVE MODE`, held to commit — a
no-op re-run takes no lock at all — and the lock is what
makes the rule exact. A concurrent `upsert_thought` of a legacy singleton's text
cannot insert a fingerprinted row under the backfill and leave the UPDATE to
raise 23505: the INSERT waits, then lands `ON CONFLICT` on the row 023 just
fingerprinted and merges — the defect fixed in the same instant it would have
struck. A concurrent `update_thought` — a re-embed pass reaching a legacy twin —
waits at its `SELECT … FOR UPDATE`, because ROW SHARE conflicts with EXCLUSIVE,
and its holder lookup then sees the committed key and answers `duplicate_of`.
The trigger hold alone would take only SHARE ROW EXCLUSIVE, which ROW SHARE does
not conflict with: under that lock the edit passes its lookup, waits at its
UPDATE, and raises 23505 after the commit — the symptom 018 removed, back for
the duration of the upgrade. Reads proceed throughout. A write in flight before
the LOCK holds it up until that write commits, bounded by a transaction-local
`lock_timeout` of 10 s, so an idle-in-transaction writer fails the migration
(re-run it) rather than queueing every other writer behind the wait. The
re-check needs READ COMMITTED, which is the default and what `migrate.ts` runs
at, as 018's header says of its lock; under REPEATABLE READ the unique index
gives the answer instead — 23505, the file rolls back whole, a re-run succeeds.
Every writer into a table that references `thoughts` waits on the lock — the
foreign-key check takes ROW SHARE — so both 015 consumers park for its duration
and their leases expire: a re-embed pass at `update_thought`'s `FOR UPDATE`, an
entity-extraction worker at its insert. The header says to stop both first, or
batch under the lease. The
`updated_at` trigger is held off for the UPDATE as 021 holds it: the fingerprint
is not an edit, and two rules read that column — 021's `updated_at <=
finished_at` evidence and 018's `if_unchanged_since` guard. 008's audit trigger
diffs content, metadata and the vector's presence, so a fingerprint-only UPDATE
writes no audit row; 016's entity trigger fires on `UPDATE OF content` only.

**What it costs.** `content_fingerprint` is indexed, so the UPDATE is never HOT:
every row written is a new tuple entered into every index on `thoughts`, the
HNSW index included — 021's backfill is not a precedent, `embedding_model` is
unindexed and that UPDATE was HOT. Measured on the test container at 1,024
dimensions, 20,000 legacy rows with random vectors beside 20,000 fingerprinted
ones: the whole-corpus call 59 s — 3.0 ms a row, and the HNSW index is the cost,
since the same call with that index dropped takes 0.36 s; a `p_limit` batch of
1,000 2.0 s; the no-op re-run 8 ms, taking no lock. About five minutes of
waiting writers per 100,000 legacy rows. `migrate.ts` sets no `statement_timeout`, so a server
default applies; the header says to apply the migration in a quiet window, and
gives a brain with millions of legacy rows the batch path without a hand-edited
file: `OB1_BACKFILL_LIMIT=10000 bun migrate.ts` (one batch, and the ledger row),
then `SELECT backfill_content_fingerprints(10000)` until it returns 0, each call
its own transaction — preflight decides "pending" from the rows, not the ledger,
and warns until the loop is done. The migration builds `ob1_fp_backfill_idx`, a
partial expression index on `(content_fingerprint_of(content), created_at, id)
WHERE content_fingerprint IS NULL`: the scan is an ordered walk of exactly the
rows waiting, a batch's LIMIT stops it early instead of every call rehashing and
sorting every NULL row still waiting, preflight's probe on every start reads it
rather than the heap, and on a fingerprinted brain it is empty — `upsert_thought`
always writes the key, and the backfill moves rows out of it.

**Preflight.** `fingerprint backfill`, over a direct connection: a thought
without a fingerprint whose text no row holds is a warning — naming 023 where the
function does not exist, and where it does the one statement and its batched
form, claiming no cause it cannot read (a batched upgrade still running looks
the same as a raw load), as the table's
owner (the function holds the trigger, so it needs the owner; preflight reads
the owner from `pg_class`), or — where the ledger already says 023 and the
function is absent, a brain adopted with `--baseline` — the body by hand, since
the migrator would skip the file; NULL rows that each share their text with the
row holding the key — twins, or a stale key — are ok, pointing at the pairs
list; no NULL row is ok, said as "missing", since a stale key on a row that has
one doubles on capture too and is not read here. Presence is read from the
catalog first, so a brain before 003 or 016 is a skip, not a raise; the
`EXISTS` stops at the first pending row, so a brain before 023 answers at once.
Over PostgREST a skip, beside `atomic capture` and `write privileges`;
and the direct-connection block's checks are now one list, so a connection that
fails between two of them leaves the first unreported carrying the error and
every later one saying it was not reached — never a second row for a check that
already reported. A warning, not a failure: captures work, they double.

**Verify, as the ticket asked.** `db/test-upgrade.ts` [6]: 023 onto a populated
022 — at 022 a capture of a legacy row's text inserts a second row; after 023
exactly the singletons and the older twin carry fingerprints, the row whose text
a captured row holds stays NULL, no `updated_at` moves, no audit row, the
trigger is enabled again, the schema gains one function and no column, a
capture of the former singleton's text merges, and a re-apply writes nothing.
`db/test-schema.ts` [24]: the rule through planted rows — a singleton, twins
dated apart, a pair whose older row has no `created_at`, a row whose text a
captured row holds, a row whose key a stale holder carries — three written, the
rest NULL and the stale key untouched; a capture merges; an unchanged edit of
the newer twin names the older as `duplicate_of`; `p_limit` batches, the third
returning 0 with the blocked rows still there; [2] re-applies 023 as a no-op.
`db/test-live.ts` [6c], on a real server: the backfill held open on one
connection, a capture of the singleton's text and a re-embed of the newer twin
on two others — `pg_locks` shows both waiting on the *relation* lock; once the
first commits the capture returns the singleton's id and the edit is told
`duplicate_of`, not 23505; `reembed.ts --status` lists the same one group before
and after. `server-portable/test-preflight.ts` [5]: the warning with the
one-statement remedy naming the owner, the ok once run, the twin as ok, and the
function dropped as a warning naming the migration until 023 is re-applied.

**A first pass, triaged: ten fixes, one ticket.** The scan ran under the table
lock, so the header's batch path for millions of rows rescanned every NULL row
per batch, writers waiting — the scan now runs before the lock at ACCESS SHARE
into a temporary table, and the rows found are re-checked under the lock by
index. The header, the README and this section said the first id the pairs
list prints is the row that takes the key, which is false where a fingerprinted
row already held it — the list now marks the holder and the claim is scoped.
The batch path itself was "run the file by hand up to its last line" — the call
reads `ob1.backfill_limit` instead. `p_limit` 0 returned 0 with everything
still waiting — refused, before the lock. The re-check's argument needs READ
COMMITTED and did not say so; a re-embed pass running during the upgrade parks
every worker until its leases expire, unsaid — both in the header now. In
preflight: an ok that said "every thought carries a fingerprint" while a stale
key doubles on capture as a NULL does, narrowed to "missing" with what is not
read; the "apply 023" remedy on a `--baseline`d brain whose ledger already says
023, now the body by hand as `reembed.ts` says for 021; a skip branch for a
missing table that could not be reached, since the same statement referenced
the table — presence read from the catalog first; and the block's outer catch
reported only `atomic capture`, so a failed catalog connection silenced this
check and `write privileges` — both say so now. To a ticket: a census of
stale keys (a brain that ran the community recipe holds one on every row), which
means hashing every fingerprinted row and belongs to a command, not a start.

**A second pass, triaged: nine fixes, one ticket, and the stop.** The top
finding was in the first pass's own addition: the re-check under the lock asked
whether the row was still NULL and the key still free, not whether the row's
text still hashed to the key found — a raw edit of content in the window would
have been given a stale key by the migration itself. It asks now. The pairs
list's new mark grouped a stale-key holder with the NULL row it blocks and
advised deleting the unmarked row, the only one carrying the text — the holder
is marked STALE and the advice says re-save it, delete nothing; and "the next
pass gives it to the oldest" was 018's arrival order misdescribed. The
`fingerprint backfill` warning claimed the pending rows were loaded since 023,
which a batched upgrade still running contradicts, and prescribed the unbounded
call — neutral now, with the batched form beside it; its ledger probe raised
for a role without SELECT on the ledger — guarded; its count of NULL rows was
an unbounded heap scan on every start — bounded at 10,001. The outer catch
still added `atomic capture` unconditionally and covered two names — one list
of the block's checks drives it. The header named only a re-embed pass to stop,
where every foreign-key writer waits — both 015 consumers now. The batch loop's
scanning is the square of the corpus over the batch, unsaid — said, with the
expression index that makes each call an ordered walk. To a ticket: a BEFORE
INSERT trigger computing the fingerprint a raw INSERT omits, which closes the
door 023 sweeps behind — a second mechanism, weighed in the header.

**A third pass, triaged: ten fixes, and the stop held.** The top finding was
again in the previous pass's own addition: the check list the outer catch now
reads blamed the wrong check when one of the block's checks could end without
reporting — `candidate scan` where `match_thoughts` is undefined, `embedding
contract` where `ob1_config` has no width row — so both report now, and an error
after every check has reported is no longer dropped. The batch limit was a
persistent role-level setting read unvalidated — a typo failed the migration
with a message naming neither, and a forgotten RESET batched every later run
under that role — so it is `OB1_BACKFILL_LIMIT`, the migrator's run-scoped
substitution channel, validated in `config.mjs`. The `fingerprint backfill`
probe hashed every NULL row on every start in the steady state 023 leaves —
bounded to the first 10,001, and the ok says how far it looked; its ledger
presence and read were a third copy of a fact the block already held — one read,
hoisted, that every ledger-aware remedy shares. The pairs list's advice for a
stale holder assumed one unmarked row where twins a stale holder blocked are
two — reworded, and the header says so. Each batch call must be its own
transaction and the header, COMMENT and remedy did not say so — they do; "takes
no lock at all" was imprecise — it takes no table lock. The holder probe ran
once per NULL row rather than once per key — after `DISTINCT ON` now. And the
list itself is kept in step with the block by a test that reads the source and
proves an unreachable database names every check.

**A fourth pass, triaged: nine fixes, one ticket, and the stop held.** The top
finding was in the third pass's own addition: the batch-limit resolver ran at
module scope in `config.mjs`, which the servers, preflight and `reembed.ts` all
import — a malformed value for a migrator-only setting would have stopped every
one of them at import, the gate meant to name the problem first. It resolves
inside `migrationValues()` now, where only the migrator and the schema tests
ask; it caps at int4, since a larger literal typed bigint would have matched no
overload; the test harnesses pin it, since the shell's value changed what a
suite applied; the compose migrate service forwards it and `.env.example` names
it, since under compose the documented path had silently done nothing; the
migrator prints the value in force; and "run-scoped" says what it means — the
environment at that invocation, a `.env` beside the migrator included. The
`--baseline` remedy said "re-run the body", whose last line is the template
placeholder — it says to substitute NULL, and says so too where the role cannot
read the ledger, instead of a remedy the migrator would skip. The capped ok
claimed "the first 10,000" and stayed ok while a waiting row could sit beyond
the sample — it says what it sampled, what it did not read, and the statement
that settles it. The check list's test guarded set equality where the catch
depends on order — order now, with the anchors asserted. And the partial
expression index the header prescribed as a hand step is built by the
migration: the steady-state cost of the probe on every start was a heap pass,
and is an index walk. To a ticket: a trigger that NULLs a key not equal to its
row's own hash, which would make the stale-key state unrepresentable and retire
the prose that explains it — a second mechanism, weighed in the header beside
the fingerprint-computing one.

**Tidy-up, while the files were open.** No behaviour change. `plantLegacyRow`
and `updatedAtTriggerState` in `db/test-support.ts` for the fixture and the
catalog probe two suites had verbatim; `test-schema.ts`'s `fpOf` at file scope
instead of in two sections; the count `test-upgrade.ts` [6] and `test-schema.ts`
[24] named "written" named "found", as the function documents it; one detail
prefix for `fingerprint backfill`'s two warnings; and `db/README.md`'s 022 bullet
saying `FOR UPDATE` where the body, its header and the test all say `FOR NO KEY
UPDATE`.

**Not done here.** A BEFORE INSERT trigger that computes the fingerprint a raw
INSERT omits, and its sibling that NULLs a stale key (tickets, above). SMD-1043's advisory lock in both inserting
`upsert_thought` overloads (done in change 63) — 023 redefines no function, and a capture racing an edit outside the
backfill's transaction still ended as 018's header says until then. Deleting the extra twin
stays the operator's call (`delete_thought`; the pairs list names them). 018's
file is applied and hashed, so its disclaimers deferring to SMD-1042 stay as
written; `db/README.md` is what moves. The function carries no sentinel — it is
new and has no successor; SMD-1227 tables the sentinels.

### 42. OAuth discovery is a 404 — `/.well-known/*` is answered before the auth catch-all, so the claude.ai connector proceeds on the key (SMD-1246)

Before it opens a custom connector, claude.ai fetches
`/.well-known/oauth-protected-resource` (RFC 9728). A **404** there means "no
OAuth here, treat the resource as public", and the connector proceeds on the key
it was given. A **401** means "protected", and the client falls back to OAuth 2.1
Dynamic Client Registration (RFC 7591) — which, against a server with no OAuth,
fails with *"Couldn't register with Open Brain's sign-in service."* Upstream
[#340](https://github.com/NateBJones-Projects/OB1/issues/340) (2026-09-05)
diagnosed this on the Supabase path: the API gateway special-cases that one path
and answers 401 before the Edge Function sees the request, so nothing inside
`open-brain-mcp` can fix it, and the reporter's verified workaround is a
Cloudflare Worker in front that returns 404 for the prefix.

`server-portable` had the same defect by a different door. `app.all("*")` caught
every path, so the discovery GET went through `authenticate()`. With no key it
got HTTP 200 and a JSON-RPC `-32001` envelope — fix 1's answer, right for an MCP
request and wrong for this one. With a key — which IS the URL-only connector's
shape: the SDK copies the connector URL's query onto its path-aware discovery
GET (`client/auth.js`, `url.search = issuer.search`), a fact this paragraph got
wrong until change 75's review — it
authenticated, cost an agent-registry resolve, and was handed to
`StreamableHTTPTransport`, which opened an SSE stream nothing wrote to or
closed: the response never completed (SMD-1259, found by this change's review
pass; closed by change 75). Neither is 404. Nothing exercised the path: no test
named `.well-known`, and `deploy/smoke.sh` only ever POSTed to the endpoint.
Local Claude Code over `x-brain-key` never asks, which is why it stayed
invisible in development.

**The change is one route.** `app.all("/.well-known/*", …)` returns `Not Found`
404 with the CORS headers, placed between the `OPTIONS` preflight handler and the
catch-all so it runs before `authenticate()` and the agent resolve — the answer is
a fact about the server, not the caller. The route's comment carries the two
ordering rules (why it sits where it does, and that a later `/.well-known/` route
must sit above it); they are not repeated here.

**Verified.** `test-server.ts` [11], twenty-seven assertions against the real
server: nine rows — four discovery paths including the exact one upstream saw
Supabase answer, then the bare document under a wrong key, the right key in the
header and the right key in `?key=`, then POST and the OPTIONS preflight —
each asserted for status, CORS and a body that is not a JSON-RPC envelope, by the
same rule [4]–[10] use. Every probe carries one 2-second abort that covers the
body read, and a transport error is reported by its own name, so a regression
fails its assertions with a stable count instead of hanging on the catch-all's
stream or crashing the suite; drilled by deleting the route. `deploy/smoke.sh`
check 2 probes the **origin root** — where RFC 9728 puts the document and where
claude.ai looks, with the server's path as a suffix when the URL carries one —
with no key and following redirects, as the SDK client does, and naming the URL
and code that missed; the base URL must carry a scheme and no query string, or
the script refuses it rather than derive the wrong origin. It was the
one check a Supabase deployment cannot pass, and that failure is real; change
75's checks 3 and 4 are the others.
`tsc --noEmit` is clean and the Workers bundle still builds
(`wrangler deploy --dry-run`, 272 KiB gzipped).

**Not verified: a live connector.** The only check that closes the ticket is a
real claude.ai custom connector completing the handshake against a deployed fork
server. That has not been run. It is also the first live exercise the Workers
target would get; the known-issues entry below still stands.

**Not done here.** Serving real RFC 9728 protected-resource metadata, or OAuth
itself — #216 and PR #238 remain the real fix for the key riding in the URL; this
change says only "there is no OAuth here", which is what the client needs to hear
to proceed on a key. Refusing other non-MCP paths: `server-portable` mounts the
transport at every path, and both shipped targets (compose, Workers) serve at
`/`, so a mount point plus Hono's `notFound` is available and would make this
route one case of a general rule rather than an exception above a catch-all.
That is a design decision, and it sits with the **method** axis the review passes
found — an authenticated GET anywhere costs an agent-registry resolve and then
hangs on an SSE stream the per-request transport never closes, because the
Accept patch stamps `text/event-stream` on every method (upstream #424; their PR
#425 answers GET with 405). Both are SMD-1259, a second mechanism, not this one;
the method axis is closed by change 75, which answers GET with 405 before
`authenticate()`. The path axis (a mount point) stays open there too.
The concrete reason the path axis waits: a mount at `/` makes the connector URL
the mount point, and a proxy that forwards under an unstripped prefix — the shape
`deploy/README.md` already anticipates — would then 404 the MCP endpoint itself.
That is a deployment-contract change, not a route. A
server mounted under a path prefix needs its proxy to route `/.well-known/` to it
or 404 it there: discovery lives at the origin root, so this route can only answer
what reaches it. `SETUP.md` gains no per-client connection notes yet; the ticket
names them as a follow-on once a connector has been seen to work.

Upstream status: #340 open; the fix cannot land in their server. **Unfiled.**

### 43. pgvector off the search path — the runner heals its own session, preflight names the persistent fix (SMD-1247)

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

### 44. The read tools print the thought id, so `update_thought` and `delete_thought` can reach what a search found (SMD-1248)

`search_thoughts` and `list_thoughts` rendered human-readable prose with no id
in it — `search_thoughts` a `--- Result N (x% match) ---` block, `list_thoughts`
a `N. [date] (type - tags)` line and the content. The id was on every row (the
store selects it, and the ChatGPT-compat `search` tool returns `{id, title,
url}`), but the two tools an agent actually reaches for to find a thought never
emitted it. Upstream files this as
[#457](https://github.com/NateBJones-Projects/OB1/issues/457), where it is only a
citation annoyance because upstream has no edit or delete. **Here it disables two
of our own tools:** we added `update_thought` and `delete_thought` in migration
009 and both take an id, so a thought found by search could not be edited or
deleted at all — the caller had to fall back to the compatibility tool meant for
ChatGPT citations. `capture_thought` was already given its id back for exactly
this reason; the comment there says so in as many words. The reasoning was
applied to the write path and not the read path.

**An `ID: <uuid>` line per hit**, in both renderings — a prose line, the smaller
of the two shapes the ticket weighed (JSON, as `search` uses, would rewrite the
whole output and the prose assertions in `test-e2e-sql.ts`), costing ~40
characters against a budget `search_thoughts` already manages with its `limit`
and truncation note. The label and placement follow the tree's own precedent:
**`search_thoughts_keyword` already prints `ID: <uuid>` in its result header**,
and it shares `search_thoughts`'s exact `--- Result N ---` block — so
`search_thoughts` prints the id the same way, in the header group, and the three
read tools now read alike. `list_thoughts`'s compact format has no header group,
so its `ID:` line trails the item. `list_thoughts` did not carry the id at all
(`listThoughts` selected `content, metadata, created_at` in both stores and
`ThoughtListItem` had no `id`), so the column was added to the two `SELECT`s and
the shared type; `search_thoughts` already had `t.id` from the hybrid match.
`update_thought` and `delete_thought` descriptions (and their `id` argument) now
name where the id comes from — before this they described an id with no reachable
source. (The ticket suggested a *trailing* `id:` line; a first review pass moved
it to the header and cased it `ID:` to match `search_thoughts_keyword`, since the
divergence between three sibling read tools was a worse cost than the ticket's
literal wording.)

**Verified.** `test-e2e-sql.ts` gains a walk that could not be written before:
capture a thought, find it through `search_thoughts`, `update_thought` aimed at
the id the search printed, then a search that shows the edit; then `list_thoughts`
→ `delete_thought` for the other read tool, asserting the id is the same one
search returned. The existing prose assertions — zero-hit, absent-literal,
truncation, the compat pair — all still hold (69 assertions pass). Store
conformance (`test-store-sql`, 62) and the server unit suite (71) stay green;
`tsc --noEmit` is clean.

Upstream status: #457 open; a citation-only issue there, a disabled-tool issue
here. **Unfiled.**

### 45. `thought_stats` aggregates in SQL — the whole corpus in one statement, not a 100-page walk that goes wrong past 100,000 rows (SMD-1249)

`thought_stats` computed its aggregates in application code: the tool looped
`store.pageThoughtMeta(offset, 1000)` and tallied type/topic/people counts in JS,
up to a `STATS_MAX_ROWS = 100,000` ceiling, then set `truncated = true` and
returned anyway. Two things were wrong, and only one was speed. **The cap was a
correctness cliff.** Past 100,000 thoughts the breakdowns came from an arbitrary
newest-100k prefix while `Total thoughts` was the real total — a corpus-wide
number beside partial aggregates, a one-line note the only tell. That is the same
defect shape fork fix 3 (SMD-970, upstream
[#470](https://github.com/NateBJones-Projects/OB1/issues/470)) removed from
Supabase's silent 1000-row page: fix 3 made the boundary explicit and visible; it
did not delete it, it moved it to 100k. **And the reason for the walk was gone on
this path.** The old comment said the ceiling kept a very large brain from
exhausting the Edge Function's time budget — but there is no Edge Function here;
`store-sql.ts` talks to Postgres directly over `Bun.sql`, and Postgres aggregates
the whole table in one statement.

**Migration 024 adds `thought_stats_summary()`** — `STABLE`, `LANGUAGE sql`,
returning `{total, first_ts, last_ts, types{}, topics{}, people{}}` over CTEs that
`min`/`max`/`count` and unnest `jsonb_array_elements_text(metadata->'topics')` and
`->'people'`. Adapted from upstream's
`recipes/edge-function-cost-optimization` migration, which has exactly this
function — **only** that function, not its 3-arg `upsert_thought(text, jsonb,
vector)`, which overlaps 004/007/022 where 022's chunk-replacement semantics are
load-bearing and further along than theirs. Two robustness fixes over the
upstream shape, to match the tool's JS exactly: the topic/people arms unnest only
when the value is genuinely a JSON array (`jsonb_typeof = 'array'`, the SQL
equivalent of `Array.isArray`), so one malformed row — topics as a bare string —
cannot raise and fail the whole summary; and a JSON `null` inside an array is
dropped before `jsonb_object_agg`, which rejects a NULL key. `ROWS` is
deliberately **absent** (019 declared it on the set-returning search functions;
this returns a scalar jsonb), and there is no `SET search_path` clause because the
body never touches the `vector` type (SMD-1247 does not reach it).

**The interface now says the two stores differ.** `ThoughtStore` gains
`statsSummary(): Promise<ThoughtStats>`. The SQL store runs the function — whole
corpus, `aggregated === total`, no cap, so the tool never prints a truncation note
on this path. The PostgREST store (Workers, no server-side aggregation) keeps the
page walk, and the `STATS_PAGE_SIZE`/`STATS_MAX_ROWS`/truncation logic **moved out
of the tool and into that store**, the only path that still needs it; its
`aggregated` can be `< total` and the tool says so. The tool itself is now thin:
one `statsSummary()` call and the same rendering as before — `test-e2e-sql.ts` [6]
(unchanged) proves the output contract held.

**The plan, measured not assumed** (the fork's rule, SMD-925). The unnest arms
full-scan `thoughts` — a HashAggregate over a Seq Scan up to ~10,000 rows, a
parallel Finalize GroupAggregate above — and that is the right cost for a tool
called once by a human, never in a loop; the heap it scans is small, inline
jsonb, nothing like `match_thoughts`' TOASTed-vector detoast cost in 019.
`db/bench-stats.ts` measures it against the walk it replaces (median of 5,
content-only rows):

| rows | function | page walk | walk round trips |
| ---: | ---: | ---: | ---: |
| 1,000 | 1.15 ms | 1.03 ms | 2 |
| 10,000 | 7.79 ms | 9.13 ms | 11 |
| 100,000 | 91.1 ms | 286.1 ms | 101 |

Below ~10,000 rows it is a wash on wall-clock — one aggregate has a fixed cost the
walk's first small page does not — and the win there is one round trip instead of
many and no cap, not raw speed. At 100,000 it is ~3× and one round trip against
101; **past** 100,000, where the old walk capped, the walk is not merely slower
but wrong, and this path stays correct.

**Verified.** `test-live.ts` [12] seeds a known corpus and proves the function
equals the page walk on `total`/`types`/`topics`/`people`, drops a JSON-null array
element and skips a non-array `topics` without raising, handles the empty corpus
(zero, null date range, empty maps), and — the ticket's key check — shows a walk
capped below the corpus disagreeing with the whole-corpus function, so the old
truncation is proven real without seeding 100k rows; an `EXPLAIN` there asserts
the full scan. `test-store-sql` [5b] and `test-store-postgrest` [8] cover each
store's `statsSummary`; a new preflight `stats summary` check fails a database
stopped at 023 with the tool registered but no function behind it (modelled on
the `keyword search`/`hybrid search` checks, `test-preflight` covers present and
missing). All 19 ci-parity suites green; `tsc --noEmit` clean.

Upstream status: #470 is the same defect shape as SMD-970, which tracks dropping
fork fix 3 if upstream ever lands theirs; this ticket is the opposite direction —
it moves the computation somewhere upstream cannot follow, because upstream has no
direct SQL path — and does not close SMD-970. **Unfiled** upstream.

### 46. Derivation and supersession: what a thought was built from, and which it replaces (SMD-1253)

A row in `thoughts` could say **who** wrote it (008/010) and **what it mentions**
(016's entity edges, entity-to-entity), but nothing said what it was **derived
from** or that one thought **replaces** another. Fine while every row is an atomic
capture; wrong the moment a derived artifact — a digest, a consolidation, a
synthesis — is captured back, because the derived row is then indistinguishable
from a first-hand one and `match_thoughts` ranks last month's superseded digest
beside today's. This was the last of upstream's sixteen schemas the fork had not
absorbed — "the one real capability gap" (the upstream survey).

**Designed as one mechanism per fact, which was the whole instruction.** Upstream
ships two overlapping schemas: `schemas/provenance-chains` (columns on `thoughts`)
and `schemas/typed-reasoning-edges` (a `thought_edges` table whose six relation
types include `supersedes`). Both claim supersession — a column and an edge row —
and absorbing both would rebuild the two-mechanisms-for-one-fact defect 021/022
spent two tickets removing. So supersession is ONE thing: **the `supersedes`
column.** `thought_edges` is **not** built — there is no reasoning-edge classifier
here to write supports/contradicts/depends_on rows, and a table with no producer
is the speculative graph the SMD-948 GraphRAG spike measured and declined; it
stays the later ticket change 30 already named it.

**Migration 025** adds two nullable columns to `thoughts`: `derived_from jsonb`
(an array of source thought ids) with a `jsonb_typeof = 'array'` CHECK, and
`supersedes uuid REFERENCES thoughts(id) ON DELETE SET NULL`. **SET NULL** is the
one delete action that fits the fork's hard-delete-plus-audit design (008/009): a
superseded thought stays deletable, its content preserved in the append-only audit
delete row, and clearing the successor's pointer is itself audited — RESTRICT would
break delete, CASCADE would delete the *successor*. A GIN index on `derived_from`
(reverse lookup) and a partial index on `supersedes`.

**Deliberate departures from upstream's shape, take-the-shape-not-the-files.**
No `SECURITY DEFINER`, no `service_role` grant, no RLS, no `NOTIFY pgrst` — the
functions are plain, as everything off Supabase is (`db/README.md`). The
`sensitivity_tier` redaction branch is **dropped**: this fork has no tier, no RLS,
and an owner connection with BYPASSRLS, so a tier with nothing enforcing it is the
same theater as the RLS policy the README says not to port; if a tier ever
arrives it is SMD-950's. `derivation_method` stays in `metadata` (no FK/index/query
need; upstream itself reads `type`/`source_type` from metadata), so only the two
load-bearing facts are columns.

**Validation is the write path's job, or it is an untrusted-input hole** (the
ticket's words). A per-element UUID check cannot be a table CHECK (no subqueries),
so `upsert_thought` — redefined here, carrying 022's whole body forward verbatim
(005's guard, 008's actor, 021's label, 022's `FOR NO KEY UPDATE` read and chunk
sentinel) — reads `derived_from`/`supersedes` from the payload envelope and
**refuses** a `derived_from` that is not an array of *existing* thought ids.
`supersedes`' existence is the self-FK's. Both ride the envelope like the actor
(008) and the model (021), so capture sets them and both stores stay in sync; a
bare re-capture adds provenance but never clears it (that is `update_thought`'s, a
follow-up — landed as change 60, migration 032; and since change 66, migration
035, a re-capture adds none either: provenance lands on a first capture only,
and the return says `existed`). Capture is the only write path this change gives provenance —
`capture_thought` grows optional `derived_from`/`supersedes` inputs.

**Read-back both ways.** `trace_provenance(id)` walks UP the `derived_from` chain
(ancestors, cycle-guarded, depth/node-capped); `find_derivatives(id)` looks DOWN
it. Both back new `ThoughtStore` methods on both stores (plain functions, so
PostgREST calls them too). No MCP tool exposes them yet — 016's entity graph
exposed none either — that is a follow-up.

**What retrieval does with it: measured, then LABEL only.** A `supersedes` column
no search reads buys nothing, and the choice — exclude, down-weight, or label —
"needs an eval the way 020's recency blend did." `evals/eval-supersession.ts` seeds
a corpus through the real write path with superseded twins, then compares
label-only against excluding the twin (a TypeScript oracle, so no shipped search
signature changed to ask the question), under two definitions of relevance:

| relevance | label-only | exclude | Δ MRR |
| --- | ---: | ---: | ---: |
| TOPICAL (any version of the topic — the fork's title→body task) | 1.000 | 1.000 | +0.000 |
| CURRENT (only the non-superseded version) | 0.667 | 1.000 | +0.333 |

On the topical task the fork measures against, the numbers **do not move** — a
superseded thought is still about its subject, so removing it can only cost, never
help, the same reason 020's recency blend was measured to hurt and left at zero.
So, exactly as the ticket says to when the numbers do not move, **the ranking
change does not ship**: supersession is **labelled**, not excluded. `search_thoughts`
and `list_thoughts` mark a returned hit a newer thought supersedes and name the
replacement (a store-side lookup over the `supersedes` column, no search-function
surgery — mirroring the `ID:` line of SMD-1248). The label serves the
current-version reader — who the eval shows exclusion would help — without a
ranking change the topical task cannot justify. An exclude/down-weight is a
follow-up; the eval is the instrument to justify it.

**Verified.** `test-live.ts` [13] round-trips a three-thought chain through
`upsert_thought`, traces it both directions, forces a cycle by a raw UPDATE and
shows the guard terminates it, and proves a deleted parent behaves as 008/009 say:
the child survives, its `supersedes` is SET NULL, the delete is audited with the
prior content and provenance in full, and the SET NULL is itself audited on the
child — an update the pre-025 diff could not see. A malformed or non-existent
`derived_from` is refused at the write, leaving no row. `test-schema.ts` [25]
asserts the columns (ten now), the FK's SET NULL, the CHECK, and both functions;
`test-store-sql`/`test-store-postgrest` [9] cover the capture, read-back and label
lookup on each backend; `test-preflight` covers a new `provenance` check that fails
a database stopped at 024 (the old `upsert_thought` would drop the envelope keys
silently). All 19 ci-parity suites green; `eval-supersession.ts` green; `tsc
--noEmit` clean.

Upstream status: absorbs the *shape* of `schemas/provenance-chains`; declines
`schemas/typed-reasoning-edges` (deferred) and the `sensitivity_tier` branch.
Downstream follow-ups the ticket names: `smart-ingest`'s reconcile vocabulary
(`append_evidence`/`create_revision`), an MCP read API for the chain, post-hoc
provenance edits, and the evidence-versus-instruction trust model (SMD-950).
**Unfiled** upstream.

### 47. `trace_provenance` bounds its work, not only its output — a dense derivation DAG no longer expands multiplicatively (SMD-1288)

025's `trace_provenance` walked UP the `derived_from` chain with a `WITH RECURSIVE
… UNION ALL` and an outer `ORDER BY depth, thought_id LIMIT node_cap`. Its guards
were real but partial: the per-path `visited` array bounded **cycles**, and the
outer `LIMIT` bounded **output** — neither bounded the **work** in between. The
reason is structural: a recursive CTE's `visited` is *per-path*, so two branches
that reach the same node both keep going. On a cycle-free but **dense** DAG — a
thought whose `derived_from` fans out to several sources, each fanning out again,
sources reused across branches — that expands to `~fanout^depth` **paths** (a
5-way derivation ten deep is ~10M), all materialised by the `UNION ALL` before the
outer `LIMIT` could trim a single row. No shipped writer produces such a row
(`upsert_thought` validates `derived_from`, real syntheses have small fan-out;
`update_thought` does not touch the column) — it takes a hand-written DAG — so
025's review found it MEDIUM-adversarial and its header named SMD-1288 as the fix.

**The fix changes the shape.** No clamp bolted onto a recursive CTE can fix this,
because the CTE cannot share a visited set across sibling branches. So
**migration 026** redefines `trace_provenance` as an iterative, level-by-level
breadth-first walk in plpgsql carrying a **walk-global `seen` set**: a node enters
`seen` — and so the frontier — at most once, so its `derived_from` is scanned at
most once: the **multiplicative `fanout^depth` blow-up is gone**. The residual
work is the reachable edges, each paying a membership test against the `seen` set
(`= ANY`), whose size the node cap bounds — linear in the graph, not exponential
in its depth. (Not the strict `O(V+E)` a hashed visited set would give — an array
membership check is `O(|seen|)` per edge — but `|seen|` is cap-bounded and it
measures fine: a 2,000-way fan-out traces in ~8 ms.) The loop also stops the
moment the node cap is reached, so a graph larger than the cap costs the cap, not
the graph. (The ticket's option 1 — a walk-global visited via a different shape —
plus option 2, terminate past `node_cap`. Option 3, a `statement_timeout`
backstop, is declined: once the blow-up is structurally gone and the loop is
cap-terminated, a timeout would mask a regression, not add a guarantee.)

**Measured**, one shared Postgres, via `db/measure-1288.ts` (each layer derives
from every node of the next, so root→leaf paths = `fanout^depth`, distinct nodes =
`fanout*depth+1`):

| dense DAG | OLD (025 per-path CTE) | NEW (026 walk-global BFS) |
|---|---|---|
| fan-out 4, 8 layers — 33 nodes, ~65,536 paths | ~202 ms, cap spent on duplicate *shallow* paths (deep layers never reached) | ~3.4 ms, 117 edge-rows covering **all 33** distinct nodes |
| fan-out 6, 10 layers — 61 nodes, ~60M paths | did not finish — killed by a 20 s guard timeout | ~3.8 ms |

Two things there: the speed (`fanout^depth` paths → linear in the reachable
graph), and a **completeness** fix — the old outer `LIMIT` counted duplicate
paths, so on a dense graph it capped out among
shallow repeats and never surfaced the deep distinct ancestors; the new walk emits
each derivation edge once, so under one row budget it reaches every distinct node
when the edges fit the cap (fan-out 4: 117 edge-rows for 33 nodes, under 250) and
otherwise reaches far deeper than the old shallow duplicates did (fan-out 6 has
~330 edges, so the 250-row cap stops it partway — many layers below where the old
walk's third-layer duplicates ran out). The cap bounds returned rows (one per
edge), not distinct nodes.

**The output contract holds** (Verify): same signature, same `RETURNS TABLE`, same
clamps. The linear chain still returns child@0 / parent@1 / grandparent@2, all
`cycle=false`; a forced cycle still yields a `cycle=true` row and a bounded count
(`test-live` [13], kept verbatim). One deliberate ordering change: rows stay
depth-ascending, but within a depth 026 emits tree edges before repeat markers
(then by id) rather than 025's pure id order, so a truncating node cap keeps real
ancestors over repeat markers; no caller depends on within-depth order (no MCP
tool exposes the walk yet). The `cycle` flag is refined to fit a
global-visited walk and is *more* correct on a DAG: a **diamond** (two direct
sources sharing a grandparent — the common dense shape) reaches the shared ancestor
twice within one level, and because `seen` is a start-of-level snapshot both edges
read `cycle=false` from their two distinct parents (025's per-path output) while
the node is expanded once. A true back-edge to an earlier level is `cycle=true` and
not re-expanded. The one honest imprecision: a DAG re-convergence at a *greater*
depth is also flagged `cycle=true` — a global-visited walk cannot tell it from a
real cycle without the per-path ancestry that is exactly the blow-up being removed;
it only ever over-flags a repeat, never loops, never drops a distinct ancestor.

Only `trace_provenance` changes. `find_derivatives` (a single-level `@>` lookup),
`upsert_thought`, the audit trigger, and the two columns are untouched, and the
store interface is unchanged (the fix is entirely below it). New coverage:
`test-live` [14] (a dense DAG through the real write path — every distinct ancestor
reached, no path explosion, a diamond's every edge kept, no false cycle),
`test-schema` [25] (026 is the last definer, the body carries the
`ob1:provenance-walk-bounded` sentinel and no longer uses a recursive CTE). All 19
`ci-parity` suites green; `db/measure-1288.ts` is the standalone measurement tool,
outside `ci-parity` like `bench-plan.ts` (it needs a real Postgres and provokes a
timeout).

Upstream status: **not applicable** — upstream's `provenance-chains` is a schema
sketch, not this iterative walk; this is a fork-internal bound on the fork's own
025. Downstream follow-up unchanged (an MCP read API for the chain, still
SMD-1253's deferred item). **Unfiled** upstream.

### 48. `search_thoughts` no longer floors long captures out of the results — admission is relative to the top match, not an absolute 0.5 cosine (SMD-1300)

`search_thoughts` and the ChatGPT-compat `search` both handed
`search_thoughts_hybrid` a threshold of **0.5**, and 020's final clause admitted a
row only if it contained a query needle **or** its raw cosine cleared that floor.
That constant is right for the one corpus every prior eval used — short tracker
issues, where a matching pair clears 0.5 with room — and wrong for a **long**
capture. A short question scores 0.2–0.4 cosine against a 2,600-token transcript,
so the floor removed the **right answer**, silently: fewer rows, all plausible.

**Measured, not asserted.** On LongMemEval-S (SMD-1039, 470 questions,
`qwen3-embedding:0.6b`), a `db/../evals/sweep-floor.ts` swept absolute thresholds
and a relative cutoff by document length. Strict recall_all@5:

| admission rule | ALL | >3k-token gold docs | mean rows | short@5 (lost a gold) |
| --- | --- | --- | --- | --- |
| absolute floor 0.5 (shipped) | 45.3% | 36.1% | 1.1 | 467 (256) |
| no floor (threshold −1) | 87.7% | 84.7% | 5.0 | 0 (0) |
| **relative cutoff, f = 0.5** | **87.4%** | 84.4% | 4.3 | 119 (**1**) |

The floor's damage is entirely on long documents — the `<1k`-token bucket is 100%
under every rule. An absolute cosine floor **cannot** be right for both a
125-token note and a 2,600-token transcript under one model, and 021 lets the
model (hence the similarity scale) differ per row. So the fix is not a smaller
constant.

**Migration 027** redefines `search_thoughts_hybrid` (same signature, so a plain
`CREATE OR REPLACE` — the ACL is preserved, no DROP) with one changed clause: a
keyword hit is exempt as before; a scored row is admitted when it is **within
half of the top candidate's raw cosine** (`v_relfloor` 0.5) *and* clears the
caller's absolute `match_threshold`. This adapts to scale on its own — a 0.8-top
tracker query keeps rows ≥0.4, a 0.3-top transcript keeps the 0.19 gold — with no
per-model constant. The tools (`server-portable/index.ts`) **stop sending 0.5**;
they send **0**, so the relative cutoff governs — and `search`, which took no
threshold at all before, now follows the fix (the ticket's step 3). A **negative**
`match_threshold` disables the relative cutoff too and returns the raw ranked list
— the sentinel this codebase already uses everywhere for "no floor" (the eval's
−1 arm, `match_thoughts` parity). `similarity` (the `% match` shown) is still the
raw cosine; only *admission* changed. `match_thoughts` is untouched — the tools
reach it only through the fused function.

The shipped arm lands at **87.4%** — within 0.5 pt of the no-floor ceiling —
where the old floor sat at 45.3%. Its 119 short calls at k=5 (returning fewer rows
than asked) are the relative cutoff **trimming filler**: only **1** drops a gold
session, versus 256 for the floor. That is the honest distinction between the
cutoff working and the bug: the floor lost the answer, the cutoff trims the noise.

Verified by `test-schema` [26] and `test-live` [15] (027 is the last definer, the
`ob1:relative-floor` sentinel is present, a sub-0.5 top row is returned at
threshold 0 and trimmed at 0.5, the `%` stays the raw cosine), plus the
LongMemEval arm above; all 19 `ci-parity` suites green.

The short-corpus precision cost was measured too, on the 576-issue Linear corpus
(`eval-hybrid.ts` and `decoy-admission.ts`, `qwen3-embedding:4b`). `eval-hybrid`'s
control passed on all 749 queries and the four sets' rank-1 is healthy (identifier
98%, semantic 84%, mixed 92%, decoy 83%) — the floor is not what ranks, so the
adversarial decoy set (a wrong identifier appended) is unaffected. `threshold 0.5`
on the 027 function reproduces the old absolute floor exactly (`sim > 0.5` implies
`sim ≥ 0.5·top`), so it is the honest before; `threshold 0` is the shipped
relative cutoff. Between them, **rank-1 is unchanged (84.3%)** — the cutoff never
displaces the top answer — and the cost is **~0.7 more non-target rows per
ten-result query** (mean non-target 8.30 → 9.02), because at a dominant top of
~0.8 it keeps rows ≥0.4 where the floor kept ≥0.5. A little more fill below the
answer, in exchange for the 45→87% recall on long captures; a bounded,
non-adversarial cost, not the decoy admission the floor was feared to unmask.

Upstream status: **not applicable** — a fork-internal correction to the fork's own
017/020 fusion. Downstream follow-ups filed from the remaining LongMemEval gaps:
SMD-1301 (candidate window), SMD-1302 (temporal/date-aware retrieval), SMD-1303
(a natural-language keyword arm), SMD-1304 (a reranker re-look). **Unfiled**
upstream.

### 49. The caveat rule is stated at the table — `thought_work_claims.last_error` on a succeeded row, and `release_thought`'s `p_error`, carry a COMMENT (SMD-1052)

Change 34 gave `thought_work_claims.last_error` a second meaning: on a
**succeeded** row, when set, it is a **caveat** — the write stands, and this is
what the worker could not do (a long thought stored with its head window's vector
because the provider refused the whole content; since change 39, a failure the
operator accepted with `--accept-failed`). `db/reembed.ts` reads every such row
as one shape — `withCaveat()` for the list, `--retry-fallbacks` and the
end-of-run count, a `FILTER` of the same shape in `--status`'s `counts()` —
and its header and `db/README.md` state the rule. The **schema said nothing**:
015 commented `work_type`, `worker_id` and `attempt_count` and not this column,
and `release_thought`'s comment said only "Mark one claim succeeded or failed" —
nothing about `p_error`, which it stores whatever the status. A reader of the
table (`\d+`, a future consumer of the claim table) had no way to learn that any
note on a succeeded row is read as the caveat. `extract-entities.ts` under its
own key is not swept today — but only because it releases success with NULL:
`reembed.ts`'s readers are scoped to the key it is *run* with, and `--job`
accepts any key that names no model (a warning when it lacks the prefix; a key
naming another model or width is refused), so the day someone pointed `--job` at
another tool's bare key its noted rows would go back to the pool. Preflight's
re-embed pass check is scoped to the `reembed:` prefix instead. SMD-1311 would
make `--retry-fallbacks` refuse a key without the prefix.

**Migration 028** is the two statements, and nothing else: an idempotent
`COMMENT ON COLUMN thought_work_claims.last_error` carrying the **data contract**
— failed: why it failed; succeeded, when set: a caveat, the write stands; NULL is
a clean success; the rule as the column's (readers treat any note on a succeeded
row as the caveat, so a consumer stores nothing else there on success); and the
one consumer of succeeded rows that does *not* read the column, 021's evidence
backfill, which trusts a succeeded row whatever its caveat (the reason
`reembed.ts`'s baseline remedy says to `--retry-fallbacks` or `--retire` first).
Which readers, under which keys, what bounds an acceptance and when a caveat row
returns to the pool are the **tools'** contract and change with the tools, so the
comment points at `reembed.ts`'s header ("The head window, recorded", "Saying I
know") and `db/README.md` for them rather than restating them. And
`release_thought`'s `COMMENT ON FUNCTION` re-issued with 015's text kept whole
and one sentence added: `p_error` is stored in `last_error` whatever `p_status`
is, and what it means on success. No DDL on data, no body change, no ACL change,
no placeholder. The ticket named SMD-1043's redefinition as the ride; 1043 is
`upsert_thought`'s advisory lock and never touches the claim table, 023's
backfill landed without it, and nothing filed today redefines `release_thought`
(SMD-1023's lease renewal is the nearest, and it is about the claim), so the
comments travel alone — a docs-only migration is heavy for two statements, and
the alternative was the rule staying where a reader of the schema cannot see it.
Spellings the comment deliberately avoids: the acceptance prefix is named by its
constant (`ACCEPTED_CAVEAT_PREFIX`) rather than quoted, since an applied comment
cannot follow a rewording; no flag is spelled, since `test-schema` [10] strips
`--` to end of line before scanning the migrations and holds that no file puts
that sequence inside a string literal (SMD-1316 would make that strip
literal-aware); and code identifiers stop at two file names, two section titles
and that constant.

The trap a successor must not fall into: `CREATE OR REPLACE FUNCTION` keeps a
function's comment, but any migration that redefines `release_thought` and
re-issues 015's one-sentence `COMMENT` would silently drop the `p_error` sentence.
So `test-schema` [27] asserts the **live** text of both comments
(`col_description`, `obj_description`) after every file has applied — anchored
on the rule's words rather than clause order, no migration number pinned, so a
compliant successor passes and a lossy one fails whichever file it is; 015's
text is checked whole, not its middle clause; the no-`--` rule is asserted of
the live text — and the two facts the comments add, exercised: a succeeded
release with `p_error` stores it, one with NULL leaves the column NULL ([15]
already covers the failed release and the holder rule). Green at both widths;
`test-upgrade` green (the shape comparison of columns and signatures is
unaffected by a comment).

**Four review passes**, and the count is the lesson. The first (medium) found a
pinned migration number, a quoted prefix, dashes in a literal and a wrong ticket
named as the successor, each fixed — and its own fix narrowed the rule to "never
swept under its own key", a false reason. The second (medium) found nothing. The
third (high) caught that false reason, that "one predicate" overstated
`counts()`, that the acceptance bound and 021's backfill were missing, and that
the 015 check was partial — fixed — and filed SMD-1311, SMD-1312 (one exported
spelling of the caveat predicate) and SMD-1313 (a generic last-issued-COMMENT
test); but its own wording of the data rule ("an edited caveat row returns flag
or not") was wrong too: `doneButNotAtTarget()` returns a row only when its thought
is *not at the target*, and a head-window caveat re-captured through the server is
relabelled at the target and stays. The fourth (high) confirmed that, found the
replacement sentence wrong again in two smaller ways (the NULL-label case, a
"key's target" a backfill key lacks), and made the point that settled the shape:
reader behaviour is the tools' contract, it changes (SMD-1311 already would), and
a hashed literal cannot follow it. Three passes had each mis-stated a reader
detail in text `migrate.ts` forbids editing once applied. So the applied comment
now carries the data contract and a pointer, and the reader mechanics live where
they can be corrected. The fourth pass also found `ACCEPTED_CAVEAT_PREFIX`'s doc
comment still naming the `finished_at` bound SMD-1067's second pass replaced with
`claimed_at` (pre-existing; fixed, one line) and that the `--job` acceptance was
overstated (a key naming another model is refused). Not taken: `db/README.md`'s
"asserts 505 properties" is stale (565 now) and has been since SMD-944, a count
no PR maintains.

Upstream status: **not applicable** — the claim table is the fork's (015).

### 50. The chunk limit follows the model's window, not a constant — captures over 4096 tokens windowed at 1200 under the default, 1200/1200 for a 2048-token model (SMD-1305)

`server-portable/chunk.ts` split a capture into overlapping windows once its
estimate passed `DEFAULT_MAX_TOKENS = 1200`, one constant for every model. The
constant had a reason — Ollama embeds a request in one batch, the default batch
is 2048 tokens, and the tokenless estimate needs headroom under it — and the
reason did not apply to the default model. `qwen3-embedding:4b` embedded the
longest LongMemEval session, 19,544 estimated tokens, whole (`prompt_eval_count`
18,919; the 0.6b the same), so the load windowed 15,743 of 19,829 sessions the
model would have embedded in one piece: 56,267 chunk rows, 2.12× the tokens,
about seven of the 13.9 hours. At the other end, `granite-embedding`'s window is
512, so its 1200-token windows were being cut silently — the failure the windows
exist to prevent.

**Measured, not asserted** — and without a reload. A load with no windows writes
the same whole vector (the same text under the same model and prompt; checked on
40 random rows per model, cosine 1.000000 to a fresh embedding, alone or batched),
so the store's whole vectors *are* that load. `evals/eval-longmemeval.ts` with
`OB1_EVAL_LME_ARMS=windows` fetches every thought in a question's history with its
whole-vector similarity and its best window's in one exact scan and ranks each
arm as a rule over those two numbers; a `windows` phase embeds windows at another
limit into a side table so a second window size could be scored beside the
shipped one. Strict recall_all@5, 470 questions:

| | no windows | 1200-token windows above 1200 (shipped) | 1200-token windows above 4096 (derived) | 4096-token windows above 4096 | tokens embedded |
| --- | --- | --- | --- | --- | --- |
| qwen3-embedding:4b | 88.7% | **89.6%** | **88.9%** | 88.7% | 1.00× / 2.12× / 1.29× / 1.25× |
| qwen3-embedding:0.6b | 86.6% | 87.9% | 87.4% | 86.8% | |

Every point the windows buy sits above 2048 estimated tokens and most of it
above 4096, where the whole vector alone loses 1.8 (4b) and 3.6 (0.6b); the
windows alone score 85.5%, so the whole vector is the signal and the windows a
complement. And **window size matters where coverage does not**: 4096-token
windows over the same 2,615 long sessions bought nothing. The synthetic tail test
(`eval-longctx.ts`, now with `OB1_EVAL_WINDOWS`) is 4/4 for both models with or
without windows and cannot see any of this.

**The rule.** `db/config.mjs` carries `KNOWN_MODEL_WINDOW` beside
`KNOWN_MODEL_DIMS` — the tokens each model embeds in one request, measured by
`prompt_eval_count`; a hosted model has no entry until it is measured, since a
document states the model's maximum and not the serving provider's — and
`resolveChunkTokens` derives two numbers at the shipped ratio (1200 of 2048):
the estimated length a capture is windowed above, capped at
`MAX_WHOLE_TOKENS = 4096` where the whole vector was measured to stop holding,
and the window size, never above 1200. A 2048-token model gets 1200 and 1200,
exactly what it had. `granite-embedding` gets 300 and 300, with the overlap
scaled to 37 (the review pass found 150 against a 300-token window carried
nothing). The qwen models window
only past 4096, at 1200 a window: under the 4b 88.9% against the shipped 89.6%
(three questions in 470), 94.9% against 94.9% at k=10, for 61% of the tokens and
a quarter of the chunk rows — about five hours of a fourteen-hour import. A model
the table does not know keeps 1200 for both. **Upgrading a store changes nothing
already written**: a row's 1200-token windows stay (022 keeps them while the
label vouches for the vector), an edit through `update_thought` regenerates
them under the rule (none for a 3,000-token thought), and the own-key re-embed
pass skips rows already at the model — so the chunk table does not shrink until
a backfill pass, `bun reembed.ts --url $DATABASE_URL --job reembed:<model>@<dim>:window`,
regenerates every row's windows. A mixed store in the meantime is scored by
`match_thoughts`' best-of as before; the eval's 2049–4096 row puts the cost of
windowed distractors beside an unwindowed gold at one question. `OB1_CHUNK_TOKENS` still sets both,
so the shipped behaviour is one variable away. `chunkContent` takes the threshold
apart from the window size; `embed.ts` resolves the rule through `config.mjs` so
the server, `reembed.ts` and preflight cannot disagree about it; preflight's
`chunk window` line prints the rule and its source, and warns when an explicit
limit is over the model's window or over the headroom under it (the ratio the
constant fixes). Found in passing: `chunkContent`'s segmenter
read the default limit rather than the caller's — invisible at 1200, wrong either
side of it.

The price of the default is two or three questions in 470 on a corpus of
2,600-token sessions, stated as such in `evals/README.md` with the caveats (two
models, one corpus, the cap is one number, 600- and 2,000-token windows
unmeasured). Verified by `test-thoughts` [7] (the rule per model, the override,
the chunker's threshold) and `test-preflight` [3b] (the five lines); all suites
green.

Upstream status: **not applicable** — the windows are the fork's own (change 007
and after). **Unfiled** upstream.
### 51. Two vendored recipes stop handing untrusted content a shell — `gmail-smart-pull`'s Codex branch is deleted as upstream deleted `atomizer`'s, `life-engine`'s allowlist is scoped, and a standing check holds the line (SMD-1251)

Both lived in this tree at the pin; both would have carried our name the first
time anyone ran them.

**`recipes/gmail-smart-pull/scripts/lib/atomize-text.mjs`** spawned the Codex
CLI over Gmail message bodies — attacker-supplied text by definition. Two
problems stacked. Both CLI spawns used `shell: true` with the binary path taken
from an environment variable, an injection surface independent of anything the
model does. And `GMAIL_ATOMIZE_CODEX_BYPASS=1` appended Codex's
sandbox-bypass flag: one environment variable turned email-body-driven model
output into unsandboxed local execution. The comment above it was careful — the
flag was "deliberately not passed by default" — and the result was a
prompt-injection → local-code-execution primitive one `export` away. The
decisive fact: **upstream had already removed this exact path from the sibling
recipe.** `recipes/atomizer`'s README and module header both document that the
identical `codex` provider was deleted "because the LLM is fed arbitrary
user-controlled memory/email text". Upstream fixed one copy and missed the
other; we inherited the one they missed.

The fix follows the precedent: the `codex` provider is **deleted** — the
function, its nested-session guard, its dispatch branch and its entry in the
known-provider set — so `--atomize-provider=codex` is now "unknown provider",
and the recipe's own header and README say why in the words the atomizer used.
The remaining `claude-cli` spawn drops `shell: true`: it was already an argv
array with the prompt on stdin, so nothing on the command line is interpreted
now, and the path from `CLAUDE_CLI_PATH` is executed as given. The cost is said
rather than hidden: the variable must now be a bare executable path (nothing
expands `~`, `$VAR` or a trailing flag), and on Windows it must name the native
`claude.exe` — without a shell the bare name resolves only to `.com`/`.exe`, so
the npm `claude.cmd` shim is not found (`ENOENT`), and a `.cmd`/`.bat` the
variable points at is refused (`EINVAL`, which Node **throws synchronously**
from `spawn()` rather than emitting — the review pass caught a first version
whose hint lived only in the `error` handler and could never fire). Both roads
now lead to one `describeSpawnError`, keyed on `win32` and either code, which
also tells a user who never set the variable that `claude` is not on PATH
rather than that their variable is malformed, hedges the set-but-missing case
("names a file that does not exist"), covers `EACCES`/`ENOTDIR` (a directory,
no exec bit), and — since the npm install ships **no** `.exe` — names
Anthropic's native Windows installer as the route to a `claude.exe`; the
README's troubleshooting has the entry, and the `ATOMIZE_DEBUG=1` switch that
reveals a withheld `Not logged in`. `pull-gmail.mjs` itself refuses a
misconfigured atomizer **once at startup** — an unknown provider (a stale
`GMAIL_ATOMIZE_PROVIDER=codex`), a missing key for an HTTP provider, or the CLI
inside a Claude Code session, through one `assertProviderReady` the atomizer
also calls per call — rather than degrading every long email to a whole-email
record with exit 0; `--list-labels`, the documented first step, is not gated.
Its Windows browser opener was `cmd /c start "" <url>`, a cmd.exe spawn that
read the OAuth URL's `&` as a command separator; it is `rundll32`'s URL handler
now, with the `error` listener a missing opener on a headless box needs. Its
per-email log logs a spawn failure whole (paths and errno text, marked
`safeToLog`) and cuts everything else at 160 characters, since an HTTP
provider's error can echo the response body and a parse failure quotes the
model's output. `recipes/atomizer/lib/claude-cli.mjs`
had the same `shell: true` on the same shape of spawn and gets the same fix, so
the ticket's verify grep is clean rather than carrying an exception for the
sibling.

**`recipes/life-engine/README.md`** recommended a `.claude/settings.json` that
allowed `Bash(*)`, offered `--dangerously-skip-permissions` as a testing option
in a table and a shell line, and defended the wildcard with: scoped patterns
"are fragile because the LLM may vary its exact command syntax", and "Rule 11
(prompt injection guard) prevents dangerous Bash execution from external
triggers". That defends a shell allowlist with a prompt rule addressed to the
model being injected — and Life Engine ingests Telegram or Discord messages, a
weather API response and calendar events on every cycle. The section is
rewritten: the skill now runs exactly **one** shell command, the `date` anchor,
and the allowlist carries that command as one **exact-match** rule plus
`WebFetch(domain:api.open-meteo.com)` — the weather check goes through Claude
Code's own fetch tool, not `curl`, so the coordinates can live in
`life_engine_state` and never touch the allowlist. Two review passes got here.
The first version used prefix rules, and the first pass pointed out that a
prefix rule approves whatever follows the prefix — `curl` takes several URLs and
`-d @file` in one command, so
`Bash(curl -s "https://api.open-meteo.com/v1/forecast:*)` was an exfiltration
path one injected message wide (which is also what Claude Code's own
permissions documentation says about argument-constraining `curl` patterns).
The second version made both rules exact-match, and the second pass pointed out
that the skill, three lines below its new "run exactly as written", still told
the model to substitute the operator's coordinates into the URL — a string an
exact rule can never approve, so every morning briefing would have paused on a
prompt, the exact failure Step 6 exists to prevent — and that the three
byte-identical `curl` strings (two in the README, one in the skill) were
hand-synchronised with nothing checking them. Taking `curl` out of the picture
resolves both. The skill tells the model to run the `date` anchor exactly as
written; the callout says **what actually breaks** (a rephrased `date` pauses
the loop on a prompt — tighten the skill or add the exact variant; never a
prefix rule on a network client or interpreter, which the consistency check
refuses; never a wildcard); and the skip-permissions option is gone from the
table, the shell line and the later pointer. The `--allowedTools` form passes
each rule as its own single-quoted argument.

**The general rule, written down.** The community tree is vendored from
upstream wholesale, so we ship its worst advice with its best. The decision
this ticket asked for is taken as: **audit once, hold the delta, and let a
standing check carry the audit** — "Vendored content" above, beside the rebase
procedure it governs. `scripts/check-fork-consistency.mjs` gains check 6: every
**non-binary** file under the seven contribution directories — text by
construction, so an extensionless `Dockerfile` or `Procfile`, a
`settings.json.example` and a Python recipe are all read — is checked for five
**mechanisms**, not the spellings the two fixed files happened to use: Codex's
sandbox-bypass flag and its aliases (`--yolo`, `danger-full-access`,
`--ask-for-approval never`); Claude Code's skip-permissions flag or
`bypassPermissions` mode; every allow-rule shape that grants all of `Bash` (the
wildcard forms, a quoted bare `"Bash"`, a line that is only `Bash`, a YAML
`allowed-tools:` or `--allowedTools` carrying the bare token); a `Bash` prefix
rule on a network client or interpreter (`curl`, `wget`, `sh`, `node`,
`python`… followed by `:*` — everything after the prefix is approved); and a
spawn through a shell in any spelling (the `shell:` option with a non-false
value, including the `process.platform === "win32"` workaround the Windows
prose invites; `exec`/`execSync` called, imported from `child_process` or
wrapped in `promisify`, which always use one; `os.system`/`os.popen`; an
explicit `sh -c`/`-lc`, `cmd /c` or `powershell -Command` argv in a `spawn`,
`Bun.spawn` or `Deno.Command`). Files git ignores are skipped — the gmail
recipe writes its packs and OAuth state under `recipes/gmail-smart-pull/data/`
by default, full email bodies, and `recipes/*/data/` is now in `.gitignore` —
so untrusted text a recipe pulled onto a maintainer's machine cannot decide
whether the tree passes, and cannot be committed by a stray `git add -A`. A hit
fails CI with the file, the line and the rule. Two shapes are read across lines rather
than per line: a quoted bare `"Bash"` counts only inside an `allow` list,
however it is printed — so a pretty-printed `deny` list, a hook `matcher`, a
`metadata.json` `tools` entry or prose naming the tool in quotes is not it, and
a `deny` on the same line as an `allow` does not excuse the allow; and in code
files the `shell` option is flagged with *any* value but `false` (`shell:
isWin,` on its own line included), where in prose and YAML it needs a code
value so a `shell: bash` step key is not it. The prefix rule catches the glob
spelling too — `Bash(curl *)`, `Bash(curl -s *api.open-meteo.com*)` — which
Claude Code 2.1 now labels the current form and `:*` the legacy one; and the
Codex pattern catches `approval_policy = "never"`, the config key behind the
flags. Exceptions are per **file and pattern and counted**: the atomizer's
README warning and module header are exempt from the bypass-flag pattern for
exactly one line each, because they name it to say it was deleted, and are
scanned for everything else — one more line naming the flag (a rebase re-adding
a usage block beside the warning) fails, one fewer (the prose rewritten) fails
too. Probe lists run against the patterns on every invocation through the same
machinery the scan uses: fifty-five strings the five must catch (two of them
code-file-only), and twenty-five ordinary lines they must not — this repo's own
prose, a regex `.exec(`, `shell: false`, "Restart your shell:", a GitHub
Actions `shell: bash` step, a pretty-printed `deny` list, a hook's `tool_name
=== "Bash"`, a `metadata.json` `tools` entry, `Bash(git status:*)`. The first pass's version had a file-wide exception (the
excepted module could regain a real shell spawn unnoticed), four literal
patterns, an extension allowlist that skipped `.py`, `.example` and every
extensionless file, `\` separators in the exception keys on Windows, a
`_template` substring filter that would have hidden a contribution named
`prompt_template`, and a hand-rolled walk; the second pass's version had a
whole-file liveness test that an anchored pattern could never satisfy, and
found the `cmd /c start` browser opener in `pull-gmail.mjs` itself — a cmd.exe
spawn that read the OAuth URL's `&` as a command separator, now `rundll32`'s URL
handler with no shell; the third pass's version had patterns that fired on
ordinary prose ("Restart your shell:", `codex exec (the CLI)`) and on the deny
lists and hook matchers that narrow Bash, missed the kebab `--allowed-tools`, a
YAML `- Bash` list item, `--ask-for-approval=never`, `sh -lc`, an imported
`exec`, and scanned the recipe's own pulled email packs; the fourth pass's
version listed ignored files repo-wide through a 1 MiB buffer and swallowed the
overflow into an empty set (a maintainer with a built dashboard would have had
the skip switch itself off silently — now scoped to the seven directories,
unbounded, and loud on failure), guarded the quoted `"Bash"` with a whole-line
lookahead that was both a false negative and a false positive, matched only
the legacy `:*` prefix spelling, missed `approval_policy`, and kept a
display-time `_template` filter whose only live effect was to hide a check-5
hit in a template SQL file every contributor copies (deleted; the placeholder
link it excused has not been produced since the filter was written). Paths are
normalised to `/`, the scan walks
`contributionDirs()`, and check 5 shares the line scanner. Proven each time:
probe files with the new spellings (seven hits on the last, an extensionless
`Dockerfile` among them), a usage block appended beside the excepted warning
(caught by count), the warning rewritten (caught as stale), then the tree: 118
contributions, no violations. The new prose in this fork names none of the
strings literally — the consistency check caught this change's own callout
spelling a forbidden prefix rule as an example, and it now describes it
instead.

Three `metadata.json` files take a patch version and today's date
(`gmail-smart-pull` 1.0.1, `atomizer` 1.0.1, `life-engine` 1.1.1); authorship
is unchanged, the content is upstream's with a fork delta. Two high-effort
review passes, ten findings each. The first: the prefix rule, the dead `EINVAL`
hint, the PATHEXT/`ENOENT` shape of the common Windows failure, the file-wide
exception, the four-literal narrowness, the unpinned `date` anchor, the
`_template` substring filter, the `\` separator in exception keys, and the
duplicated walk/scan prologue. The second: the skill's coordinate substitution
that an exact rule could never approve (above), the atomizer copy's missing
stdin `error` listener (a failed spawn or an early exit with a long prompt was
an uncaught exception, now the same one-line guard the gmail copy has), the
liveness test that an anchored pattern could never pass, the narrowness of the
spawn and allow patterns and the `cmd /c` opener they missed, the whole-file
exception, `pull-gmail.mjs` storing an unknown `--atomize-provider` (or the
undocumented `GMAIL_ATOMIZE_PROVIDER`) and degrading per email with exit 0 — it
now refuses at startup, and the variable is in the README's table — the
extension allowlist, the 160-character log slice that cut the Windows hint in
half (400 now; the hint carries no email text), and the not-found hint telling
a user who never set `CLAUDE_CLI_PATH` that their variable was malformed (it
now says `claude` is not on PATH). A third pass, ten more, most of them edges
of the second's own fixes — the stop-signal shape — and each real: the browser
opener's missing `error` listener (a headless box without `xdg-open` would have
died before the callback server listened), the check scanning the recipe's own
pulled email packs under `data/` (untrusted text deciding a maintainer's local
result; not gitignored either), the three allow shapes and eight spawn/bypass
spellings the widened patterns still missed, the patterns that fired on
ordinary prose and on deny lists, the 400-character log slice whose premise
("provider errors are redacted at source") was false for the HTTP providers and
the parser, the startup guard closing one of four configuration errors and
blocking `--list-labels`, the Windows prose naming a `claude.exe` the npm
install never provides, and the set-but-missing hint asserting the value was
malformed. A fourth pass, ten more, again edges of the third's own fixes — the
second consecutive stop signal, so the loop ends here: the ignored-file skip's
silent overflow, the `_template` filter, the quoted-`"Bash"` lookahead, the
`shell: isWin` and namespaced `execSync` and `/bin/sh` spellings, the glob
prefix form, `approval_policy`, the `ATOMIZE_DEBUG=1` detail still cut by the
160-character slice (it is the opt-in whose purpose is those snippets; marked
safe to log when on), the errno table giving `EINVAL` the "does not exist"
remedy and `ENOTDIR` the "no exec bit" one (branched on the code first now,
with a trailing-slash hint), the `.gitignore` comment promising cover for an
atomizer data root that resolves from the current directory (`/data/atomic-
memories/` added), and the atomizer's hint table lacking the `safeToLog` mark
its own slicing callers would need (hoisted to an exported
`describeSpawnError` mirroring the gmail copy). All fixed here, except the one
every pass named: the duplication between the two recipes' Claude-CLI spawns
(two `buildCleanEnv`, two `STRIP_KEYS`, two spawn wrappers, two
`describeSpawnError`s, each patched four times this ticket) is SMD-1317. The
gmail copy's error also stops putting stderr and stdout (email text) into the
run's log by default, behind the same `ATOMIZE_DEBUG=1` switch the atomizer
uses. A boyscout commit took the tidy-ups the passes cut for space: the script's
env header names every variable it reads (`GMAIL_ATOMIZE_PROVIDER`,
`CLAUDE_CLI_PATH`, `ATOMIZE_DEBUG`, the two directory overrides), the startup
refusal exits 1 like the file's other refusals, the per-provider key checks
that `assertProviderReady` made unreachable are gone, the README says the
`--dry-run` preview needs the provider's key, and check 5's walk from the
repo root no longer descends `.claude/worktrees`. Upstream status:
**contributable in principle** — these are recipe files, not the core server —
but issue #482 reports the upstream gate failing every fork-originated PR; the
atomizer precedent says upstream would take the deletion. **Unfiled** upstream.

### 52. The PostgREST store maps every row it returns — one `isoTimestamp`, one normaliser per row shape, shared with the SQL store (SMD-1040)

`server-portable/store-postgrest.ts`'s `matchThoughts` returned
`(data ?? []) as ThoughtMatch[]`: the client's own row under a type that says
`created_at: string` in ISO form. The SQL store has always mapped the same row
through `new Date(...).toISOString()`; so had this store's two younger methods,
`keywordThoughts` (after a review caught a locale-formatted date on it) and
`hybridThoughts` (mapped from the day it arrived, change 32). The oldest method
was never revisited. The SMD-958 review named it (finding T12) and it was
ticketed rather than fixed, because by then nothing in the product read it:
`search` and `search_thoughts` go through `hybridThoughts`, and the only
remaining caller, `preflight.ts`'s 014 and 020 probes, reads row counts. That
is also why no test noticed: `test-store-postgrest` [3] asserted count, content
and similarity on a `matchThoughts` row, and the format assertion lived in [3b]
and [3c], on the two methods already fixed.

Measured before fixing, over `compat/supabase-sql` — the fixture the suite
uses, which is real SQL through Bun's driver — the row's `created_at` was a
`Date` object, not a string at all; `JSON.stringify` hid it (a Date serialises
to ISO), and a template string showed
`Mon Sep 14 2026 11:27:09 GMT-0500 (Central Daylight Time)`. Over PostgREST
itself the same column is a JSON string in Postgres's own form,
`2026-09-14T16:27:09.123456+00:00` — a string, but not the one the SQL store
returns for the same row. Both are the class of difference that survives every
test asserting presence.

**The first commit was the ticket's shape** — one `normaliseMatchRow` in
`store.ts` beside `normaliseHybridRow`, both stores calling it — and left the
keyword mappers as two inline copies because "they agree today and both suites
assert their format". **A review pass (high effort, triaged) found that fix
narrower than its own mechanism, and one input it broke on.** Fixed here:

- `matchThoughts` was not the last bare cast. `getThought`, `listThoughts` and
  `pageThoughtMeta` on the PostgREST store were casts of the same kind, and
  `getThought` is the one the `fetch` tool prints verbatim — so the
  store-dependent wire format the ticket says it closes was still open on the
  one read path a user sees, while the fix had landed on the method only
  preflight counts. Now `normaliseThoughtRecord`, `normaliseListItem` and
  `normaliseThoughtMeta`, in `store.ts`, called by both stores; the SQL store's
  inline copies of each are gone.
- The keyword mappers are folded too (`normaliseKeywordRow`). The reviewer's
  argument was exact: "they agree today and both suites assert their format"
  is verbatim the state T12 found `matchThoughts` in, and the PR was already
  editing both files at the method above.
- `toISOString` throws on an infinite timestamp, which the column allows and
  migration 020 ranks by design (`test-schema` plants both infinities). The
  bare cast passed such a row through; the new normaliser would have aborted
  the whole result array on it, and both preflight probes would have degraded
  to `skip`. One `isoTimestamp` now formats every timestamp the stores return:
  a finite one as `toISOString`, an infinite one in Postgres's own spelling on
  either client (Bun hands back the number `±Infinity`, PostgREST the string).
  `test-store-postgrest` [3d] plants a row dated `infinity` and reads it back
  through `matchThoughts`, `getThought`, `listThoughts` and `pageThoughtMeta`.
- The first commit's `typeof score === "number"` assertion could not fail:
  `typeof NaN` is `"number"`, so a dropped or renamed column under `Number()`
  passes it. `Number.isFinite` now, there and on the pre-existing [3c] line.
- No suite can produce PostgREST's `+00:00` string — the fixture hands the store
  a Date — so [3] feeds `isoTimestamp` that string, the space-separated form,
  a Date, and both spellings of both infinities, and asserts the output.
- The ISO regex was spelled three times in one suite while the other asserted
  `endsWith("Z")`, a weaker rule; the two suites held different contracts on
  the shared normaliser's output. `db/test-support.ts` exports `ISO_RE`
  (`toISOString`'s exact shape, three fraction digits) and both use it. The
  first commit's prose that the PostgREST suite "now asserts what
  `test-store-sql` [3] always has" was wrong on both counts and is gone.
- The history above was told four times — a docblock, a call-site comment, a
  test comment and this section. It is told here; the code says the mechanism
  (`isoTimestamp`'s docblock names the two clients' shapes and points here).

**A second pass (high effort, triaged) found the first pass's rules meeting
each other, and two more casts.** Fixed:

- The pass-1 normaliser made a NEW divergence on the field this ticket
  unifies. A NULL `created_at` is legal (001 has no `NOT NULL`; 020 and 023
  name the state), sorts first under `ORDER BY created_at DESC`, and the
  PostgREST store's stats walk takes the first row of the first page as the
  newest thought — so `isoTimestamp(null)`'s epoch was reported as the
  corpus's newest date, `<real> → 1/1/1970`, where before the bare cast
  passed JSON null through and the tool omitted the range, and where the SQL
  store's 024 `min`/`max` ignore NULLs. `ThoughtMeta.created_at` is
  `string | null` — the one place in the interface, since only the walk reads
  it — and the walk skips undated rows when picking the range.
  `test-store-postgrest` [8] plants one and checks the range against SQL's
  `min`/`max`.
- `isoTimestamp` threw on anything Date could not parse, from inside `.map()`
  over every row of four read methods that used to be casts — so one row with
  a BC date or a year past ±275760 (Postgres accepts to 294276) would have
  failed `list_thoughts`, `fetch`, the stats walk and both preflight probes
  outright. The rule is now the one the infinities already had: a value with
  no ISO form keeps Postgres's own text, one odd row stays one odd row.
  `undefined` still throws — the column is missing from the row, a SELECT
  bug. [3] feeds it a BC date and `undefined`.
- `normaliseMutation` still formatted `updated_at` and `current_updated_at`
  with `String()`, two hundred lines under a docblock saying nothing else may
  format a timestamp — so `update_thought` printed `+00:00` where `fetch` now
  prints ISO for the same column. Both take `isoTimestampOrNull`; passing the
  ISO value back as `if_unchanged_since` is safe because 021 compares at
  millisecond precision on both sides. `revokedAt` too.
- The PostgREST `getThought` had no `UUID_RE` guard: a malformed id was a raw
  Postgres cast error on one store and `null` on the other, through `fetch`.
  `UUID_RE` moves to `store.ts` (both stores had their own copy) and the guard
  mirrors the SQL store's.
- `traceProvenance` and `findDerivatives` were byte-identical inline mappers
  in both stores, one row shape short of the mechanism — pass 1 edited their
  `created_at` line in all four copies without noticing. `normaliseDerivative`
  and `normaliseProvenanceNode` join the others.
- The normalisers re-spelled the id/content/metadata/created_at quartet five
  times; they compose `normaliseListItem` now, so SMD-1328's decision is one
  edit. The nullable rule was spelled twice with two different null tests
  (`t ?` and `== null`); `isoTimestampOrNull` is the one spelling.
- The one `typeof score === "number"` pass 1 missed (the recency-weighted
  line of [3c]) is `Number.isFinite`; [3d] plants its row through
  `test-support`'s `plantLegacyRow` rather than a third copy of the INSERT
  (the helper's `createdAt` accepts `null` for [8]); the `ISO_RE` block had
  landed between `createAssert`'s JSDoc and `createAssert`.

Ticketed, folded into SMD-1328: what the tools PRINT for a timestamp with no
ISO form. `isoTimestamp`'s sentinels are text a Date cannot parse, and five
readers (`Captured:` twice, the list prefix, the fetch/search title, the
stats range) do `new Date(x).toLocaleDateString()`, which prints
"Invalid Date" — on the SQL store that replaces a hard error with silently
wrong text on a row only raw SQL can create. NULL → epoch and sentinel →
"Invalid Date" are one decision, null under a widened type or a display
helper at five sites, and it is that ticket's. Declined in pass 1 and still: a
per-method conformance sweep over the whole `ThoughtStore` interface — with
every read method on a `store.ts` normaliser and [3d] reading each back, it
would re-assert what [3d] asserts.

**A third pass (high effort, triaged) — the second consecutive stop signal:
its top findings were pass 2's own rules meeting each other, so the loop ends
here.** Fixed:

- `isoTimestampOrNull` tested `== null`, so `undefined` — a column missing
  from the row, which `isoTimestamp` throws on by rule — became `null` for
  every nullable column: a dropped `updated_at` in a SELECT, or 024 renaming
  `last_ts`, would have printed a null edit time or an empty stats range with
  every suite green. It tests `=== null` now; `normaliseMutation`'s pre-018
  envelope, the one place absence is legitimate, says so explicitly.
- Pass 2 wrapped the SQL suite's page-walk comparisons in `String()` to
  satisfy the widened type, which made them vacuous (`"null"` sorts above
  every digit). [5] asserts every page row's `created_at` is non-null ISO.
- [3d] asserted the infinity row by position (`list[0]`, `page[0]`), which a
  NULL — sorting above +infinity under DESC — would displace; by id and by
  value now. Its plant-to-delete span is a `try/finally`, so a thrown store
  call cannot leak the row into the next run. [8]'s oracle was a second
  formatter (`new Date(x).toISOString()`, which throws on the infinity and
  fabricates on an empty range); it is `isoTimestampOrNull`.
- Deleting the two local `UUID_RE`s left each file's JSDoc for it sitting
  above the class declaration; gone, the useful sentence moved onto the
  export. `normaliseProvenanceNode` renamed a key, ran the derivative
  normaliser, destructured the id back out and spread the rest AFTER its
  explicit fields, an overwrite direction TypeScript would not flag; a shared
  `derivationFields` is spread first in both. The stats walk's null-skip loop
  folds into the tally loop it duplicated.

Corrected, not fixed: `isoTimestamp`'s docblock said a value with no ISO form
comes out "the same on both clients". It does not. Verified live by the
reviewer: for a BC date or a year past ±275760, Bun's driver hands the SQL
store `Date(NaN)` (or, on a parameterised query, an extended-year Date whose
`toISOString` fails `ISO_RE`) before the store sees it, so the SQL store
returns JS's "Invalid Date" where PostgREST's text survives. The docblock
says so and names the remedy (`created_at::text` beside the column). Folded
into SMD-1328 with two more facts the reviewer surfaced: this PR changed
the default store's answer for an undated row from JSON null to the epoch
string — parity with the SQL store's long-standing behaviour, but a visible
change (`fetch`'s `metadata.created_at`, the search citation title) that
had gone unannounced; and no test pins what the tools print for a sentinel,
so the eventual fix has nothing to flip. Ticketed: SMD-1336 — the PostgREST
store's client-side stats walk mimics 024 rule by rule (this ticket added
the NULL-skip), but `thought_stats_summary()` is a plain zero-arg jsonb
function it could call over `rpc`, with the walk kept only as the pre-024
fallback; 024's "PostgREST cannot aggregate server-side" premise looks
false. Declined: pinning "Invalid Date" in `test-server` as expected output
(pinning a bug), and widening `ThoughtListItem.created_at` here (SMD-1328's
decision, five reader sites).

**A fourth pass, at the user's call.** Its top three findings were the three
already ticketed (SMD-1328 twice, SMD-1336) — the loop had ended — and the
rest were tidy-ups worth taking in files the PR was already in:

- The stats page walk ordered by `created_at DESC` alone across up to 100
  separate `range()` requests. `created_at` is transaction-fixed, so a
  multi-row INSERT gives thousands of equal values, and a walk over an
  unstable order can count a tied row twice or never. Both stores' page
  queries break ties on `id` (pre-existing; the PR had rewritten the block
  around it).
- `isoTimestampOpt` for the keys an envelope may omit (`updated_at` before
  018, `revoked_at` when not revoked) — the one place `== null` is the right
  test, spelled once instead of three times. The SQL store's `statsSummary`
  had optional keys and an empty-object fallback that `isoTimestampOrNull`
  would now throw on; 024 guarantees every key, so the tolerance is gone
  rather than left to mislead.
- `db/reembed.ts` kept its own copy of the uuid regex for `--accept-failed`;
  it imports the stores' `UUID_RE` now, so the CLI refuses exactly the ids
  the stores answer null for. The PostgREST file header still said the store
  was "unchanged in substance"; it names the mapping layer. [3d]'s `finally`
  comment claimed to protect the next run, which `resetSchema` already does;
  it protects later sections of this run, and [8] has the same contract.

Ticketed: SMD-1338 — the malformed-id rule is enforced per store read method
while `update_thought` and `delete_thought` take a bare `z.string()` and hand
it to Postgres; validate once at the tool boundary.

A boyscout commit took what `--noUnusedLocals` finds in the touched files: an
unused `MutationError` type import in each store, two path imports in the
PostgREST suite for a migrations directory it no longer computes, and the SQL
suite's hand-rolled template substitution (`HERE`, `MIGRATIONS`, `subst()`
and its docblock), superseded by `resetSchema` and never read.

Verified: `test-store-postgrest` 77/77 (60 before this ticket; the first
commit's format assertion, run against `main`'s store, reported
`got object Mon Sep 14 2026 11:27:09 GMT-0500 (Central Daylight Time)` and
failed the suite 59/60), `test-store-sql` 83/83, `test-update-delete` and
`test-agents` unchanged, `test-server` 71/71, `tsc` clean. Upstream status:
**not applicable** — `server-portable/` and its two stores are the fork's
(change 11).
### 53. The post-floor recall levers, measured — the candidate window, an event-date signal, and a reranker all declined (SMD-1301 / 1302 / 1304)

With SMD-1300's floor gone (change 48), two LongMemEval slices carry almost all
the remaining strict recall_all@5 misses: **multi-session (79.3%)** and
**temporal-reasoning (79.5%)**, both on `qwen3-embedding:0.6b`. Three tickets
proposed three fixes. This change is the measurement that answered them — and,
like change 31 (GraphRAG), it ships **no runtime change**: all three are
declined or redirected, on the corpus that has the headroom to show a gain. The
harness is `evals/rerank-spike.ts` (and `evals/rerank-crossencoder.py` for the
one arm that needs a torch env); it reruns off a persisted eval-longmemeval load.

The premise the three share is real: the golds **are** in the candidate pool.
A perfect reorder of the top-30 pool — the oracle — would reach:

| | multi-session @5 | temporal @5 |
| --- | --- | --- |
| baseline (vector similarity, top-5) | 79.3% | 79.5% |
| oracle @10 (perfect rerank of top-10) | 92.6% | 86.6% |
| oracle @20 | 96.7% | 91.3% |
| oracle @30 | 99.2% | 95.3% |

So the second and third gold sessions sit at ranks 6–20; something must
**reorder** them into the five. Nothing available does. (The baseline here is the
pure-vector arm — `match_thoughts` at threshold −1, the pool the rerankers reorder;
the shipped fused path sits within one question of it, temporal 78.7% / 79.5%, so
it is a fair and slightly conservative bar. The reranker table below uses the same
baseline.)

**SMD-1301, the candidate window — a no-op.** The hypothesis: `search_thoughts_hybrid`
ties the vector arm's fan-in and the final `LIMIT` to the same `v_count`, so a
caller asking for 5 scans only ~5 deep; widen the fan-in and the close-behind gold
becomes a candidate. Measured by calling the shipped function at `match_count = N`
(fan-in N, fused over N) and taking the first 5:

| fan-in N | multi-session @5 | temporal @5 |
| --- | --- | --- |
| 5 | 79.3% | 78.7% |
| 10 | 79.3% | 78.7% |
| 20 | 79.3% | 78.7% |
| 50 | 79.3% | 78.7% |
| 100 | 79.3% | 78.7% |

**Byte-identical at every depth.** At the default `recency_weight` 0 the vector
arm is ranked by similarity, so admitting more rows below the five never reorders
the five: the top-5 of a 100-deep pool equals the top-5 of a 5-deep pool. (The
keyword arm fires on 12 of 248 questions and perturbs at most one of them — which
is why the shipped hybrid sits at temporal 78.7% while the pure-vector baseline in
the tables below is 79.5%, a one-question gap that does **not** move with the
window. That constant offset is the keyword arm and the threshold, not the fan-in.)
The k=10 "recovery to 92.6%" the ticket cited is simply *returning more rows*, not
scanning deeper. A wider window is only useful to something that reorders it —
which is SMD-1304's job, and it too fails below.

**SMD-1302, an event-date signal — noise to harm.** The temporal slice's date
"leads the session text and the embedding does not weight it." But the actual
questions do not turn on a date to match: only **4%** name an explicit date, while
**79%** are "how many days/weeks ago", "which came first", "how many between X and
Y" — topical retrieval, then date arithmetic **on the answer**. The gold session
is no closer to `question_date` than a distractor (closer 19% / farther 23% / tie
58%; mean gaps 25 vs 24 days). A proximity-to-`question_date` blend, swept over
weight × half-life, gains at most **+2 questions of 248** at one weight (`w=0.1`,
half-life 90d — about one per slice) and **hurts** at any real weight (`w=0.3`,
half-life 7d drops multi-session to
65%) — a recency-shaped signal, exactly what SMD-945 already measured as harmful
to ranking and shipped at weight 0. The date leads the text for the reader and the
answer step; it is not a retrieval signal here.

**SMD-1304, a reranker — the story that reversed twice.** The GBrain-notes
decline (change 31's neighbourhood) was measured on the *tracker* corpus the
baseline saturates, where a reranker had nothing to reorder. LongMemEval gives one
headroom (the oracle above) and a public number: GBrain 93.40% → 95.53% all-types
with a hosted Voyage reranker on. Every reranker within reach was tried against the
top-30 pool — strict recall_all@5, with **any-hit@5** beside it:

| reranker of the top-30 pool | MS strict | MS any-hit | temporal strict | temporal any-hit |
| --- | --- | --- | --- | --- |
| baseline (no rerank) | 79.3% | 96.7% | 79.5% | 92.9% |
| bge-m3, bi-encoder cosine | 81.8% | — | 75.6% | — |
| qwen2.5:7b, general-LLM listwise | 27.3% | 87.6% | 40.9% | 85.8% |
| bge-reranker-v2-m3, cross-encoder | 66.9% | 94.2% | 71.7% | 92.1% |
| Qwen3-Reranker-4B, cross-encoder | 66.1% | 99.2% | 70.1% | 96.1% |
| **MemReranker-4B**, reasoning-calibrated | **89.3%** | 99.2% | **81.9%** | 96.9% |

**First: generic rerankers hurt, and the metrics move in opposite directions.**
Every cross-encoder posts a *higher* any-hit than the baseline (Qwen3-Reranker
99.2%) while posting a *lower* strict — and the stronger the model, the wider that
gap. That is the whole mechanism in one line: a cross-encoder is elite at
surfacing *one* relevant session and, for exactly that reason, packs the top-5 with
the single dominant gold plus its most-on-topic neighbours, squeezing the *second*
gold out. The misses are multi-hop **counting/comparison** questions ("how many
days between X and Y") where every session on the topic is equally relevant, so a
sharper relevance judge collapses set-coverage rather than helping it. It is a
depth-vs-breadth trade: reranking optimises depth, strict recall_all@k needs
breadth.

**Then: the same architecture, retrained, reverses it.** MemReranker-4B is
Qwen3-Reranker-4B after reasoning/calibration distillation — same weights lineage,
same yes/no scoring — and it lifts multi-session **66.1% → 89.3%** (+23 over its own
base, +10 over the baseline) while keeping any-hit at 99.2%. So the failure was
never the architecture; it was the training objective. Trained *not* to concentrate,
a reranker keeps the "find a gold" strength and recovers the set.

**But held-out, the gain does not travel.** MemReranker used LongMemEval as one of
its *evaluation* benchmarks, so that +10pt is suspect. Tested on a genuinely
off-distribution corpus — the 601-issue Linear tracker (team SMD, completed) with
the hand-labelled `evals/graphrag-questions.json` multi-hop set, which MemReranker
never saw — the LongMemEval result **does not reproduce**:

| reranker, held-out Linear corpus | multi-hop @5 | aggregation @5 |
| --- | --- | --- |
| baseline (vector) | 100% (17/17) | 29% (2/7) |
| Qwen3-Reranker-4B | 100% (17/17) | 29% (2/7) |
| MemReranker-4B | 94% (16/17) | 43% (3/7) |

MemReranker is about **neutral** here (+1 aggregation, −1 multi-hop); the generic
Qwen3-Reranker is *perfectly* neutral, not harmful — because these multi-hop
questions are easy (baseline 100%), their golds robustly top-ranked, so there is no
marginal second gold to drop. The catastrophic LongMemEval harm is therefore a
*difficulty* effect (marginal golds at rank 3–4), not a universal property of
cross-encoders; and MemReranker's +10 is largely **benchmark-specific**. The one
held-out task with real headroom (aggregation set-coverage) gives it a whisker over
its base model (+1 of 7) — a faint sign its calibration does *something*
off-distribution, but nothing bankable.

**Decision.** No candidate-window knob, no event-date blend, no reranker in the
default path. Generic rerankers are neutral-to-harmful (harm concentrated on *hard*
multi-hop). A reasoning-calibrated local reranker (MemReranker-4B, Apache-2.0, so
the reasoning-aware option is local and free, not only the hosted Voyage) posts a
large LongMemEval gain that a held-out corpus does **not** confirm — so it stays
unshipped pending a *hard* multi-hop held-out test, which the tracker corpus (too
easy) cannot provide. Even confirmed it is 4B/≈9 s-per-query on this hardware, an
opt-in at most, never the 1.3 ms default. Query decomposition (SMD-1318) remains
the more fundamental lever — it turns a breadth problem into single-hop depth
problems, where a reranker's strength finally applies. SMD-1302 and SMD-1301 are
redirected/closed with these numbers; SMD-1304's decline stands, now with the
reranker landscape mapped rather than assumed.

Upstream status: **not applicable** — a fork-internal measurement of the fork's
own 017/020 retrieval. **Unfiled** upstream. Reproduce: a persisted
`eval-longmemeval.ts` load, then `bun evals/rerank-spike.ts` (see
`evals/README.md`).

### 54. A pass that proposes which thoughts supersede which — reviewed one at a time, never applied unreviewed (SMD-1294)

Change 46 gave `thoughts` a `supersedes` column and `capture_thought` a way to
set it, and nothing populated it except a caller who already knew the answer at
capture time. So a decision captured in March and its reversal in June sat side
by side, both ranking on cosine alone (change 37's recency blend is off by
measurement), and `search_thoughts` handed a caller both with no signal that one
was dead — the state GraphRAG-style systems call unconsolidated, and the largest
capability gap between this fork and GBrain, whose public design runs the fix as
an overnight job: sample nearby pairs, ask a model whether they conflict, surface
the result for review rather than acting on it. The fork had every ingredient of
that loop and none of the loop: 015's leases, 016's shared entities, 025's
column, a resident metadata model.

**The one rule, enforced structurally.** The pass writes **migration 029**'s
`supersession_proposals` and never `thoughts`. `thoughts.supersedes` is written
by one function, `review_supersession_proposal(id, 'accept')` — an operator's
call, one proposal at a time, under the audit trigger with the reviewer as actor
— so reversing a wrong supersession is one `--reject` and nothing is ever applied
because a model said so. Both GBrain's docs and the review of change 46 arrive at
this rule; the ticket's words were "the machine proposes, someone confirms".

**Which pairs are judged, and why each restriction.** `consolidation_candidates`
pairs a thought with the older thoughts that **share an extracted entity** (a
conflict is about a subject both name, and the judge cost is per pair, so the
cheap signal narrows the pool before the expensive one), captured **at least a
UTC calendar day earlier** (a pair is reached from its newer side once, with no
"already judged" memory needed; an import's burst is not compared with itself; a
same-day contradiction is not found, stated rather than hidden), **nearest by
exact cosine** over that join, at or above a floor, at most k — with pairs already
proposed in any state and thoughts already superseded on either side left out.
The ticket said "by `search_thoughts_hybrid`"; the keyword arm has nothing to add
when the query is a whole document, and an HNSW walk filtered to "shares an
entity" is the filtered-scan shape change 28 exists to avoid — the join is tens
of rows and the exact cosine is cheaper than the index. The shared-entity rule
makes extraction a prerequisite, so the worker's pool is **thoughts with
entities and no row under the key**, rebuilt on every run and every `--follow`
poll: no trigger, because a trigger on `thoughts` would judge a capture before
016's worker reached it and leave a terminal claim row behind.

**The judge.** `server-portable/consolidate.ts` holds one prompt: thought A
(older) and B (newer), dated, and one question — agree, unrelated, or conflict,
and for a conflict which is *current*, decided from what the texts say and never
from the dates (the ticket's "prefer the later one only when the content itself
says the earlier is superseded"). A conflict whose texts do not say is recorded
`conflict_undirected` for the reviewer to direct. Only conflicts become rows,
each carrying its direction, confidence, the judge's one-sentence reason (what a
reviewer reads first), the cosine, and the pass key
`consolidate:<model>@p<prompt version>` — the judge model on the row as 021 puts
the embedding model beside the vector (SMD-1254). Acceptance refuses what would
leave the column wrong: a pointer at a third thought (`ALREADY_SUPERSEDES` — the
column holds one predecessor, and which is the reviewer's call) or one that
would close a loop (`WOULD_CYCLE`); an undirected verdict needs `--direction`;
and the verdict is about the texts as judged — each proposal records 016's
fingerprint of both texts as the judge saw them, the queue marks a thought
edited since, and accepting such a pair is refused (`EDITED_SINCE`) unless the
reviewer, reading both texts as they are now, passes `--force`. An acceptance
that writes the pointer moves the superseding thought's `updated_at`, which a
client's `if_unchanged_since` and 021's evidence rule read as an edit. Rejecting an accepted proposal undoes its own write while
it still stands. A decided pair is never proposed again, whatever happens to the
claim table. Nothing a capture controls reaches the judge outside the two
delimited blocks, and nothing a thought contains reaches a reviewer's terminal
or client with its control characters intact.
`stale_entities` is the pass's second output — subjects nothing has mentioned
within a window — printed by `--stale` and acted on by nobody.

**One departure from the ticket, stated.** Work item 3 asked that acceptance
call `update_thought`. It cannot: `update_thought` has no provenance parameter
(change 46 left post-hoc provenance edits as a follow-up), and adding one is a
redefinition of the edit signature — DROP and re-create with the ACL replayed,
the constant, preflight's `edit signature`, both stores, the MCP tool — a second
mechanism. So the accept function sets `ob1.actor` as 009's functions do, locks
the superseding row and writes the column in one UPDATE; 025's audit trigger
diffs `supersedes`, so the change is recorded with the reviewer as actor exactly
as an edit would be. The envelope on `update_thought` is **SMD-1323**, and when
it lands the accept path should call it. (It landed as change 60, migration
032: the accept and reject paths call `update_thought`, and the UPDATE is gone.)

**Measured** (`evals/eval-consolidate.ts`, `evals/README.md`), on the 576-issue
Linear corpus with `qwen2.5:7b` as judge, the entity graph from 016's worker
(525 of 576 extracted; 51 of the longest documents time out under the 7B model —
016's known tail — and with 4 that extracted to nothing, 55 carry no entities and
are outside this pass), and 98
hand-labelled pairs drawn from every cross-reference carrying supersession
language (6 conflicts, 79 agree, 13 unrelated):

| | |
| --- | --- |
| candidate pairs at k=3, cosine ≥ 0.6 (the shipped defaults) | 517 over 243 thoughts — 0.99 judge calls per thought with entities; 1,198 at k=5/0.5, 2,815 at k=10/0 |
| the shared-entity rule against cosine alone at the same k and floor | 517 against 1,090 pairs — the rule hands the judge 47% |
| the full pass | 21.3 min wall, 4.9 s of model time per pair, ~1,750 estimated prompt tokens per call (~1.6M per thousand thoughts) |
| verdicts | 441 unrelated, 63 agree, **13 conflict → 13 proposals** (10 without a direction) |
| the 13 proposals, graded by hand | **6 real, 7 not** — 46% precision, about 2 proposals per hundred thoughts |
| the judge on the 98 labelled pairs, called directly | conflict precision 29% (2/7), recall 33% (2/6); 87 of 92 non-conflicts left alone |
| labelled conflicts the pass could reach | 1 of 6 at the shipped k and floor; 3 of the 6 pairs' issues are among the 51 unextracted, and the pass proposed 0 of 6 |

**What it says, and the decision.** The ticket's shipping test was "false-positive
`conflict` low enough that a reviewer is not drowned; the number is chosen from
the measurement". At two proposals per hundred thoughts, half of them real, a
reviewer is not drowned — the pass ships, **default off** (nothing runs until
`db/consolidate.ts` is invoked), with k=3 and a 0.6 floor chosen from the table
as the point where the judge costs about one call per thought, the same order as
extraction. What it does not do is find much: the 7B judge's recall on genuine
reversals in long tracker documents is a third, its confidence is uninformative
(0.8 on nearly every verdict, so the confidence floor filtered nothing), and the
shared-entity rule inherits extraction's blind spot on exactly the long decision
documents where the labelled conflicts live. The true conflicts it did find —
a billing-bypass flag decoupled from the flag that used to control it, a
tool-version source of truth replaced by another, a scope revised — are the
kind the ticket named. A stronger judge and the 016 tail are the two levers,
and neither is this change's mechanism; the eval is the instrument for both.

Verified by `test-schema` [28] (the candidate rule's every exclusion, the one
write, the review path's states and refusals with the audit row, the queue,
staleness), `test-live` [16] (the worker end to end against a stub judge: the
audited accept under the key's name, the reject that clears, a cleared claim
table not re-proposing a decided pair, the pool picking up a thought extracted
since), `test-store-sql`/`-postgrest` [10], `test-preflight`'s `consolidate
pass` line, and the four suites that count the tool surface (ten now, seven
read-only). Three review passes, triaged in full: the second's top finding was
the first's fix (the stop signal); the third, with the operator's and the
adversary's lenses, found the prompt's header line, the missing staleness guard
and the unstripped control characters above; a fourth, over the third's seams,
moved the fingerprint to the text the judge was sent and pinned the tool's
rendering and the CLI's `--force` path. All suites green.

Upstream status: **not applicable** — upstream has no proposal table, no worker
and no `supersedes` writer beyond capture; the shape is GBrain's, the parts are
the fork's. **Unfiled** upstream.

### 55. Query decomposition, measured — it fixes what the SMD-1301/1302/1304 nulls blamed, and strict@5 still barely moves (SMD-1318)

Change 53 declined three levers and named the fourth — query decomposition — "the
more fundamental lever". This change measures it, and like change 53 it ships **no
runtime change**: the fundamental lever is declined for the default path too,
because the measurement corrects the premise every prior null shared. The harness
is `evals/query-decompose.ts`, off the same persisted `eval-longmemeval.ts` load.

The shared premise was: a multi-hop counting/comparison question ("how many days
between X and Y", "which came first, X or Y") needs 2–3 distinct gold sessions in
the top five, but **one blended query vector is the average of several events**,
so each event's session lands mid-pool and no reorder of that one pool recovers
the set. The fix follows directly and is the standard 2025–26 multi-hop RAG
pipeline: retrieve with **several** vectors — decompose the question into
single-fact sub-questions, retrieve top-k per sub-question, union, fuse. Every arm
runs the identical pipeline (decompose → per-sub-query top-k → fuse → take five
distinct sessions); the baseline's decomposer returns the question whole, so a
question left atomic reuses the baseline pool unchanged — the harness confirms it
routes every atomic question through that path (146/146 LLM, 207/207 heuristic;
true by construction, not an independent replication). An LLM (`qwen2.5:7b`,
temperature 0) splits cleanly and fires on 41% of the 248 multi-session + temporal
questions (mean 2.25 sub-questions).

Strict recall_all@5, versus baseline 79.3% / 79.5% and the top-30 oracle 99.2% /
95.3% (`subk` = 20, MS / temporal):

| fusion of the sub-query pools | heuristic | LLM |
| --- | --- | --- |
| RRF (k₀ = 60) | 79.3% / 76.4% | 79.3% / 76.4% |
| round-robin | **81.0%** / 79.5% | 80.2% / 78.7% |
| max-sim pooling | 79.3% / 79.5% | **81.0%** / 78.0% |

(The RRF row is identical for the two arms — verified by re-running each, not a
duplicated cell: the two arms diverge under round-robin and max-sim, so the
harness does distinguish them; RRF's flat k₀ = 60 weighting simply makes it a poor
fusion here.)

**It corrects the ticket's premise, and it is not enough.** The premise was that
one blended vector ranks each event mid-pool — but **coverage is not the
bottleneck**. On the fired questions the decomposed union covers 100% / 96.2% of
the golds, and one blended query at the baseline depth (30) reaches exactly the
same 100% / 96.2% on those questions. At *equal* per-query depth (`subk` 20) the
union does edge out one query (blended 98.0% / 92.3%) — several vectors retrieve
marginally more than one for the same budget, but no further than one *deeper*
query already goes. And ~83% of the fired questions' golds already sit at rank ≤ 2
in the blended pool individually. What an LLM split changes is per-event **rank** — the share of
golds at rank 0 of their best sub-pool rises from **39% to 61%** (multi-session)
and 38% to 61% (temporal), with the deep tail shrinking. Yet strict@5 gains at most
+1.7 points and is flat-to-negative on temporal; RRF *regresses* temporal, because
it sums shared appearances, so a topical distractor in two sub-pools outscores each
event's single-pool gold. `subk` 10 → 30 barely moves strict — the bottleneck is
not scan depth.

The reason is that **the miss was never "each event is mid-pool" — it is set
assembly.** With coverage already there and each gold individually near the top,
the failure is fitting 2–3 mutually-competing golds plus distractors into five
slots of one ranking. Decomposition removes gold-vs-gold competition (each gold in
its own pool) but the merge re-introduces gold-vs-distractor competition, and no
dumb fusion can tell each sub-pool's one gold from its topical neighbours. That
discrimination is exactly a reranker's single-hop strength (any-hit ~99%, change
53) — which is why a reranker *destroys* a pre-decomposition multi-hop set yet
belongs **after** decomposition, on the single-hop sub-pools. So decomposition
alone is declined for the default path (a marginal strict gain at the cost of an
LLM call plus N retrievals per query, on a local-by-default fork), and the
measured, motivated follow-up is **decompose-then-rerank** — lift each sub-pool's
gold to rank 0, then interleave — whose headroom is the 39% of golds not yet
there. Like the reranker (change 53), that belongs on a *hard* held-out corpus,
not only LongMemEval. **(That prediction was measured in change 59 and declined:
reranking one pool is the lever, not decomposition — and how you combine the
sub-pools makes no significant difference, on two corpora. Assembly was never the
bottleneck. Change 59 measured on LongMemEval-M — harder, but the SAME 500 questions,
not held out — which validated the *premise* of this advice; a hard HELD-OUT corpus
is still change 59's open follow-up.)**

Upstream status: **not applicable** — a fork-internal measurement of the fork's
own retrieval. **Unfiled** upstream. Reproduce: a persisted `eval-longmemeval.ts`
load, then `bun evals/query-decompose.ts` (see `evals/README.md`).
### 56. The migrator owns the re-run — `--reapply` re-runs every recorded migration in one transaction, and migration 030 takes back a label whose only evidence is an acceptance (SMD-1193)

`db/migrations/030_label_from_claims_excludes_accepted.sql`, `db/migrate.ts`,
`db/config.mjs`, `db/reembed.ts`, `db/test-upgrade.ts` and
`server-portable/preflight.ts` (Linear SMD-1193, filed by change 39's first and
second review passes). One migration, 030: no column, no function, two UPDATEs
of `thoughts.embedding_model` in one DO block.

**The finding.** Migration 021's evidence backfill labels a thought from its
latest *succeeded* claim row under a key naming a model, when nothing has
written the thought since (`updated_at <= finished_at`). It was written before
change 39, has no caveat filter, and — applied and hashed — is never edited.
Since change 39 a succeeded row can be `--accept-failed`'s acceptance of a
*failure*: the row says succeeded, the caveat says `kept the vector it had`, and
the thought's vector is, by decision, **not** at that key's model. On an applied
brain nothing runs that body again — except a re-run of the file: the remedy
`reembed.ts` printed for a `--baseline`'d brain whose `update_thought` body is
older than 021 (paste the body, substituting the width), and now the migrator's
`--reapply`. Over an accepted row whose thought is unlabelled (a pre-021 vector
nothing vouched for — the common case for an old thought) the block labels the
thought at the key's model; from then on the pool never takes it, `vector
models` counts it at the model, and no reader cross-checks the caveat against
the label. The wrong vector is invisible to both readers for good. Change 39
closed the *upgrade* path (`--accept-failed` refuses a schema that is not 021's
whole) and made the remedy say to return accepted rows first — a precondition
the operator could not meet on that brain: returning an accepted row is a run
(`--retry-fallbacks`), a run refuses that schema, and `--retire` takes only a
superseded key. The ticket's alternative, a re-run that *refuses* while
accepted rows stand, would deadlock the same way and is not built.

**The first commit, and what the review did to it.** The first shape was
`--reapply <start>` — re-run the named recorded migration and every recorded
one after it — with 021's `DO $bf$ … $bf$;` block split out by a regex and a
config.mjs statement (021's rule with accepted rows excluded) run in its place,
the rest of the file verbatim. A high-effort review pass took it apart, and the
findings were right: a start point is safe only when everything before it is
really present, which nothing checks — preflight's 023 remedy said `--reapply
023` on a brain whose schema stops at 020, 025's `upsert_thought` body creates
fine (plpgsql resolves a column when the function first *runs*) and the next
capture fails on the column 021 never added; the same brain's 021 remedy fails
on its first file, since the statement reads `thought_work_claims` (015). A
failure part-way through the range left objects at an *older* definition than
before the command (022's `upsert_thought` without 025's provenance; the
4-argument `match_thoughts` 014 recreates beside 020's), with nothing to say so.
The exclusion was keyed on *re-run*, so a first apply of 021 by the migrator
over accepted rows — a hand-applied schema adopted by README §4's "just run
them" — still trusted them. The count printed beside the labelled rows counted
the claim table, not what the exclusion changed. And a rule corrected inside
the migrator, for the re-run path only, left every brain already mislabelled by
the old paste wrong for good, as a `startsWith("021_")` branch in a loop the
tenth review pass of change 21 had scrubbed of filenames. So the shape changed
in all three places, below.

**`--reapply`: every migration, one transaction.** No start: the migrator
re-runs every migration — recorded or pending — in order, in one transaction
with a 10 s `lock_timeout` from its first statement; recorded rows stay as they
are (rows, shas and `applied_at` — asserted) and pending ones are recorded in
the same transaction. Every file is idempotent (`test-upgrade` [3] re-applies
the whole set over itself), so the run restores the latest definition of
everything, and a body that reads what an earlier file installs finds it there.
One transaction, so a failure part-way rolls back and the schema is as it was;
the output says so and says to run it again. Judged before `BEGIN`: a recorded
file whose sha differs from the ledger's (the plain run's drift check reports a
drifted file and moves on, which for a re-run would skip one file's definitions
and restore the next one's over whatever the skipped one left); the pgvector
floor; a shell configured differently from the brain (006 and 013 write their
`INSERT … ON CONFLICT DO UPDATE` into `ob1_config` again — a re-run from a shell
still carrying model A would flip a brain switched to B back to A, silently,
and every reader of the record with it; the model and the chunk-context flag,
not the width, which is the column's own and 006's to judge); and an accepted
row under a *suffixed* key standing over an unlabelled thought (below). Every
refusal is reported, not the first, and `--dry-run` makes the same judgements
and says "would refuse", so a green dry run is never followed by a red run.
`--baseline` beside it is refused. Every argument is accounted for — a flag the runner does not have, a
value where no flag takes one, or a flag given twice (`--url A --url B` ran
against A), is refused rather than dropped, since `--reapply=021` or a misspelt
flag was otherwise a silent plain run that exited 0. The banner says to stop
the server and the workers first and what a re-run repeats from the current
shell: 001 and 003 take ACCESS EXCLUSIVE on `thoughts`, 011 builds the trigram
index when `OB1_TRGM_INDEX` is on and it is absent, 023's call runs again and
locks `thoughts` (`OB1_BACKFILL_LIMIT` bounds it), 025 re-validates its
constraints. `--dry-run` says `would re-apply` and judges the floor as the run
does; the summary counts re-applied apart from applied; the seeds check runs
after the commit for every file that seeds, since a brain adopted with
`--baseline` never had the migrator run 014. No file is named in the loop.

**Migration 030: the corrected rule, applied once to every brain.** 021 cannot
change, so its successor does two things in one DO block, 001's `updated_at`
trigger held as 021 holds it (no row's `updated_at` moves and no audit row is
written — asserted). First, a label whose *only* evidence is an acceptance goes
back to NULL: the thought's latest succeeded row under a key naming a model is
an accepted one under the model's **own** key (exactly `reembed:<model>@<dim>`,
no suffix), the thought is labelled with that key's model, has a vector, and
nothing has written it since the row was *enqueued* — not 021's `finished_at`,
and not the claim either: the pool is built from the rows not at the model, so
a thought the pool took was not at it *then*, and a label saying it is, with
nothing written since, can only be 021's block having trusted the acceptance;
anything written after the enqueue is a server's or the worker's, and its label
is theirs — a capture at the model landing between the enqueue and the claim
(the worker re-embeds regardless, may fail, and `--accept-failed` accepts a
thought already at the target whatever its timestamps), a head window the
worker wrote through `update_thought` before the row's outcome was chosen, an
edit or re-capture since. Every accepted own-key row at the thought's latest
`finished_at` counts, not one of a tie: two releases in one transaction share
`now()`, 021 picks one without a tiebreak, and a reader that picked the other
would leave 021's label standing. Second, 021's rule with accepted rows excluded from the claim rows it
reads — `NOT (c.last_error IS NOT NULL AND starts_with(c.last_error,
'{{ACCEPTED_CAVEAT_PREFIX}}'))`, the prefix substituted from config.mjs's one
spelling like every other template value, the `IS NOT NULL` because
`starts_with(NULL, …)` is NULL and `NOT NULL` is not true — applied to
unlabelled rows only, so the latest row *before* an acceptance decides: an
earlier pass that did write the vector labels the thought at that pass's model,
exactly the vector the acceptance kept, and a thought with no such row stays
NULL. What it leaves: an acceptance under a *suffixed* key is not read against
the label — a backfill key pools thoughts at the model too, so such a label may
be the server's own, and the two cannot be told apart; 030 writes no new label
from one, and because 021's block, re-run as written, *would*, the migrator
refuses `--reapply` while such a row stands over an unlabelled thought, naming
the rows and a way back the schema allows: on 021's whole, `reembed.ts --job
<key> --retry-fallbacks` or `--retire <key>`; on an older schema, where
`reembed.ts` refuses to run and `--accept-failed` could not have written the
row, the statement `--retry-fallbacks` would run, per row — otherwise the tool
loops the operator between two refusals. The claim-key grammar 030 and that
query read is `config.mjs`'s, as two template values and two constants, and
the latest row is chosen by `finished_at` and then by key, since two rows
released in one transaction share `now()` and which wins decides whether a
label is taken back. Reached after 021 in the same
`--reapply` transaction, and pending on every brain at its next plain run, so a
brain that followed the old paste is corrected too. The rule for any successor that labels from claim rows
is stated in the file and in `reembed.ts`'s header: an accepted row is not
evidence; 030 is its spelling.

**The remedies name the command.** `reembed.ts`'s ledgered 021 refusal says
`cd db && bun migrate.ts --url … --reapply`, what the re-run does with 021 and
030, and to stop the writers first; `--status`, which reads and answers on any
schema and is what the operator reads first, now prints `a run would refuse: …`
with it. Preflight's three paste remedies — 023's `backfill_content_fingerprints`
absent under a ledger that says 023, and 014's body under a ledger that says
014, in both branches — name it too; the ALTER FUNCTION that puts 014's SET
clause back is a statement, not a paste of a file, and stays.

**Review, second pass (high), triaged — the first stop signal.** Every finding
was a seam of the first pass's reshape, and most were right: 030's first
statement bounded on `finished_at` and would have taken back the label a
worker itself wrote between the claim and the release (fixed, `claimed_at`,
and [8] plants that row); the one transaction covered recorded files only, so
a ledger hole had an earlier-numbered pending file apply *after* the re-run
over what it restored, and 030 — pending on every existing brain — ran in a
second transaction while the remedy said "the same one" (fixed: every file,
pending ones recorded inside); 006 and 013 would re-record `ob1_config` from
the shell with no line saying so (refused); a suffixed-key acceptance over an
unlabelled thought would be labelled by 021's block and left by 030 (refused,
listing the rows); no `lock_timeout` before 023's, so an idle session's ACCESS
SHARE froze the re-run and every reader behind 001's ACCESS EXCLUSIVE for ever
(a 10 s `SET LOCAL` from the first statement — which made the atomicity
testable: [7] holds a lock and watches the run fail at 001 and roll back);
`--dry-run` promised a re-apply the run would refuse on the floor (fixed); the
seeds check skipped re-applied files (fixed); 011 rebuilds the trigram index on
a re-run when the shell says on and it is absent (said in the banner and both
comments); `--url` twice ran against the first (refused). Not taken: one
`scanArgs()` shared with `reembed.ts` — its scanner has shapes this one does
not need, and folding them is a change to that tool.

**Review, seventh pass (high), at the user's call, triaged.** The sixth's
extension had a hole of its own: the gate's own-key exclusion assumed 030
would run after 021, but on a plain run with a hole at 021 *alone* 030 is
recorded and skipped, so 021 would have rewritten exactly the labels 030 took
back — the exclusion applies only when 030 runs in the same invocation, the
message says why, and [7] reads the refusal with 030 recorded. `--baseline`,
which executes no SQL, was refused on claim-row data it could never act on
(guarded). The gate's own reads took ACCESS SHARE with no timeout of their own,
before the transaction's `SET LOCAL` existed, so an idle ACCESS EXCLUSIVE
holder froze the re-run at the checks — the freeze the timeout was added to
prevent; ten seconds around the reads, reset after, and [7] holds that lock
and reads the refusal. Preflight's new `applyOr` collapsed "the ledger could
not be read" into "not recorded", printing the plain "apply 021" loop for a
role without SELECT on the ledger; one `ledgerRemedy(migration, apply)` knows
the unread case as the 023 remedy does, and the ledger is read whole rather
than through a hand-kept list of prefixes that had already drifted from its
comment. The banner announced a run before the refusals were printed (after
them now). A bare `vector` column read as `vector(-1)` with the remedy "set
the width to -1" (named for what it is). The hazards query wrapped the shared
rows in the very window the sixth pass had removed for cost — the accepted
rows are picked first and "latest" is a `NOT EXISTS`, the review's measured
115 ms to 7 ms. `requeue()`'s SET list was spelled four times (one
`REQUEUE_SET_SQL`, read by `reembed.ts`, the printed statement and the test).
**Ticketed: SMD-1421** — the reviewers' higher altitude, proposed twice: a
snapshot of the labels around 021's replay that makes 030's rule the only
rule and removes the gate, the way back and the plain-run refusal; a redesign
this late was not this PR's (done in change 61). Left as a tidy-up: the
`startsWith("021_")` literal.

A boyscout commit took what the passes cut for space, no behaviour change:
`reembed.ts` spelled the run's refusal (`refusalJob ?? refusalTtl ??
refusal021`) three times, one `refusalForRun` now; the re-run command was
spelled at five sites in `preflight.ts` and `reembed.ts`, `REAPPLY_COMMAND` in
`config.mjs` now; the migrator's gate declared a `drifted` inside the scope of
the loop's `drifted`; the loop's dry-run comment credited itself with a floor
judgement the checks make first; the pre-021 way back said "predates 021" where
only the eight-argument `update_thought` was missing, and names which.

**Review, sixth pass (high), at the user's call, triaged.** The accepted-row
gate ran only under `--reapply`, so a *plain* run applying a pending 021 over a
live corpus — a brain built by hand through 021 and adopted by README §4's
"just run them", or a ledger hole — ran the block as written and 030 could not
take those labels back: the gate runs whenever 021 will, and the plain run says
"refusing to apply 021" ([7] deletes 021's ledger row and reads it). The own
key was recomposed with a cast of the width to bigint, so a hand-written width
past bigint raised out of 030 and the gate — a regex now, the canonical
spelling (`(0|[1-9][0-9]*)`, no suffix), never a cast. The `latest` window
column in the shared rows made the subquery a barrier the planner could not
push the rare `accepted AND own_key` through, so 030's first statement
evaluated the regexes over every succeeded row (55× at 100k rows, measured):
the column is the gate's own, wrapped around the shared text. Preflight's
`edit signature`, `vector models` and `atomic capture` remedies still said
"apply 021" and "apply 022" where the ledger records them — a loop on the
baselined brain, which now names `--reapply` as 014's and 023's do. The
argument scanner echoed `--url=postgres://user:PASSWORD@…` into the log
(the shape, not the value, now). `chunk_context` was refused as a differing
record while 013 says the flag may be flipped and the record is "what was
configured when the schema was last migrated" — re-recording it is the update,
so only the model is compared. The pre-`BEGIN` reads had no try/catch (a
refusal naming the error now, not a stack trace with the connection open); the
pre-021 way back capped its statements at fifty with no marker (one statement
per key, every row); the constants substituted into 030 — the grammar, the
prefix, the rows — change what a pending 030 does with no drift signal, so
`test-schema` pins the literals and the constants say so; 030's header names
the trigger-off hand label it cannot tell from 021's. Left as tidy-ups: the
banner on stdout before refusals on stderr, the duplicated requeue spelling,
the plain loop's dead dry-run branches.

**Review, fifth pass (high), at the user's call, triaged.** Three of its
findings were consequences of the fourth's canonical-width change, and they
were right: the SQL grammar had become narrower than 021's hashed `[0-9]+`, so
an accepted row under a leading-zero key was evidence to 021 and invisible to
the gate and to 030 — the gate's invariant broken by the fix meant to keep it;
and tightening `parseReembedKey` had silenced three refusals (`--job
reembed:other@01024` ran as a pass to the shell's model, `--retire` no longer
knew the current key, preflight's advice flipped). Both are 021's grammar
again, byte for byte; "the model's own key" is the canonical spelling on both
sides, the SQL recomposing the key from its captures as `poolModelFor`
compares it. 030's first statement required the acceptance to be the thought's
*latest* row, so a paste's mislabel refused and accepted again under another
model's own key kept the wrong label for good — any accepted own-key row for
the label's model counts now, since a later acceptance under another key
vouches for nothing about this label and a later real pass moved `updated_at`
past the bound; [8] plants that row. The width joins the pre-`BEGIN`
judgements, read from the column (006 refused it inside the transaction, after
a green dry run). Smaller: the `update_thought` probe is asked only where the
vector type resolves (PG15 without pgvector raised on parsing the signature);
the label column is read by relation, not by name across every schema the role
sees; the printed requeue statement is `requeue()`'s (the attempts reset,
`claimed_at` kept); `explainFailure` knows which mode it speaks for (the
pgvector remedy's last sentence and the lock-timeout line differ); two latent
type errors — a `let` narrowed to `null` across a callback, and the missing
declarations in `config.d.mts` — are gone; the dead template values with them.
Left as tidy-ups: the fragment evaluated twice in 030, the unbounded hazard
query, the duplicated `requeue()`/`wayBack` and argument-scanner spellings, the
`drifted` shadow, and the plain loop's dry-run floor branch.

**Review, fourth pass (high), at the user's call, triaged.** The loop had
ended; this pass found four defects worth the name in the third's seams, and
took them. 030's first statement bounded on the claim, so a correct label the
server wrote *between a row's enqueue and its claim* — the pool took the
thought unlabelled, a capture at the model landed, the worker failed, the
operator accepted, which `--accept-failed` allows for a thought at the target
whatever its timestamps — would have been taken back for good, with the
standing acceptance keeping the thought out of every pool: the bound is the
enqueue now, and [8] plants the row. 030 was the first pending file to read
015's table and 021's column, so a *plain* run on the very brain this change is
for failed at 030 with a bare "does not exist" — and the compose stack gates
the server on the migrator: 030 opens with a prerequisite check that raises
with what is missing and the `--reapply` command as its HINT (ASCII only: Bun
hands a HINT holding a non-ASCII character back one letter per NUL), and [7]
runs the plain migrator on the baselined brain and reads it. The `--reapply`
gate encoded one case — a suffixed key — where the definition is the
difference of the two rules: whatever 021 labels (its bound the release) that
030 does not take back (its bound the enqueue) is refused, which also closes
the own-key row written between the claim and the release; and it takes every
accepted row at the latest time, as 030 does, since 021 picks one of a tie
without saying which. The claim rows both read are one text now,
`CLAIM_EVIDENCE_ROWS_SQL` in `config.mjs`, a template value for 030 and a
constant for the gate — the third hand-spelling is gone, and with it the
quoting seam. Smaller: a leading-zero width (`@08`) made the SQL grammar call a
key the model's own while `parseReembedKey` did not (both refuse it now);
`has_edit` lacked 018's sentinel test that `reembed.ts`'s probe has; the
re-run's catch lacked the plain run's hnsw decode (one `explainFailure` for
both, printing a raised HINT too); 030 returns before the trigger hold's lock
when no succeeded row names a model. Left, and said in 030's header: a label
021's block wrote that a metadata-only edit has since moved past the enqueue
stands, since `update_thought` keeps the label when no content arrives and
nothing here tells such an edit from a re-capture — the alternative is a second
evidence rule over 008's audit rows. Left as tidy-ups: the refusal precedence
spelled three times in `reembed.ts`, the remedy command at seven sites, the
argument scanner, and the plain loop's drift and floor branches, unreachable
under `--reapply --dry-run` now that the pre-check exits first.

**Review, third pass (high), triaged — the second consecutive stop signal, so
the loop ends there.** Every finding was a seam of the second pass's fixes, and
most were right: the suffixed-key refusal named two `reembed.ts` commands that
tool refuses on the very brain the re-run is for (fixed: the way back follows
the schema); `--dry-run` under `--reapply` printed the live banner and skipped
the record and hazard checks, so a green dry run preceded a red run (fixed: one
pre-check for both, every refusal reported); the pgvector floor's remedy said
"migrations before it are applied and recorded" when nothing had run (fixed);
the width was compared against `ob1_config` when the column is the authority
and 006 judges it (dropped); the hazard list said `50+` at exactly fifty and
derived its keys from the truncated rows (no limit; fifty shown, the rest
counted); `DISTINCT ON … ORDER BY finished_at DESC` had no tiebreak, and 030 is
the first consumer whose outcome depends on *which* row wins (the key); the
claim-key regexes were spelled inline eight times across 030 and the hazard
query (two constants in `config.mjs`, two template values); `reembed.ts --status
--dry-run` printed the refusal twice and `--status` judged only 021 where a run
judges three (fixed); test [7] stripped `OB1_CHUNK_CONTEXT` from the child's
shell after applying the schema with the parent's, so a developer with the flag
on saw the new refusal fire (fixed); the README's FORK pointer list and its
`test-schema` count were behind (fixed). Not taken: pre-filtering 030's three
scans to candidate thoughts (a few seconds, once; 021's shape); a configurable
lock timeout to spare CI ten seconds; 028's column comment, which still presents
021's trust as the standing exception (a comment is hashed with its file, and
030 adds none).

**Not done here.** `db/README.md`'s migrations table stops at 023, and a row
for 030 alone would mislead; its FORK pointer list names 030. The argument
scanner is the migrator's own, a third hand-rolled copy beside `reembed.ts`'s
and `extract-entities.ts`'s.

Verified: `test-upgrade` [7] builds the brain the ticket describes — the schema
applied through 020, then `migrate.ts --baseline` so the ledger says every
migration — plants four thoughts written two hours ago and the claim rows (a
plain succeeded row an hour later; an accepted row with the failure's own
timestamps; an earlier pass's plain row under its key and the acceptance under
the new key over the same thought), and asserts `reembed.ts --status` names the
command and not the paste; `--dry-run` counts every recorded file and writes
nothing; the run's banner and summary; the labels (`stub-embed`, NULL,
`earlier-model`, NULL — 021's block labelled the accepted thought and 030 took
it back, in one transaction); no `updated_at` moved, no audit row, the trigger
enabled after; the recorded ledger rows untouched and the one deleted row (022,
a ledger hole) recorded, the file applied in its place; the eight-argument
`update_thought` alone and the 3-argument `upsert_thought` carrying 022's
sentinel *and* 025's provenance; and the refusals, each with nothing written —
a shell whose model differs from the record, an acceptance under a suffixed key
over an unlabelled thought (naming the row; returned to its pool, the run goes
and the thought stays NULL), a session holding a lock on `thoughts` (the run
fails at 001 within the lock timeout and rolls back whole), a value beside the
flag, a flag the runner does not have, `--baseline` beside it, a drifted
recorded file; and that the re-applied schema has a fresh apply's columns and
functions; that `--dry-run` from a differing shell says "would refuse"; and
that a plain run on the baselined brain, 030 pending, fails at 030 naming what
is missing and `--reapply`; that a shell whose width differs from the column
is refused before `BEGIN`, dry run included; that a plain run with 021
pending is refused on the same accepted rows, and with 030 recorded on the
own-key acceptance too; and that an exclusive lock on `thoughts` fails the
checks before the run within their own timeout. [8] applies 030 onto a
populated 029 holding twelve labels — a
paste's mislabel (back to NULL), a real pass's label with a later acceptance
under another model's key (stays), an acceptance under a suffixed key (stays),
a mislabel edited since (stays), a head window the worker wrote between the
claim and the failure (stays), a capture the server made between the enqueue
and the claim (stays — the bound is the enqueue), a paste's mislabel refused
and accepted again under another model's own key (back to NULL — the later
acceptance is the latest row and vouches for nothing about the label), an
unlabelled thought with an earlier pass then an acceptance (labelled at the
earlier pass),
a mislabel with an earlier pass (taken back and relabelled at it, in the one
block), a plain row (labelled), a label with no claim row (not read) — no
`updated_at` moved, no audit row, the trigger enabled, and a second apply a
no-op. `test-preflight` pins the 023 and 014 wordings; `test-schema` [29] pins
the literals 030 is substituted with. `test-upgrade` 106/106,
`test-preflight` 174/174, `test-schema` 644/644, `test-live` 419/419, `tsc`
clean, fork checker PASS (on the tree with SMD-1304's and SMD-1294's changes
merged in). Upstream status:
**not applicable** — the migrator, `reembed.ts` and preflight are the fork's
(changes 11 and 29).

### 57. A lease outlasts a missed heartbeat, not a batch — `renew_claims`, and the one rule the three workers share (SMD-1023)

Change 29's `claim_thoughts` stamped one `ttl_expires_at` per call, for every
row in the batch, and nothing could move it. So a lease had to outlast the whole
batch: the eighth row of a batch of eight is not started until the seven before
it finish, and its clock has run since the claim. 015's header said so, and
every consumer carried the coupling as arithmetic of its own — `reembed.ts` grew
its default lease to `--batch` × `OB1_LLM_TIMEOUT` and refused a shorter one
(change 34), `extract-entities.ts` and `consolidate.ts` refused a batch ×
timeout above the lease and defaulted to one thought per claim so the product
stayed small (changes 30 and 54). When a batch overran anyway, the next claim by
any worker returned its unfinished rows to the pool, a second worker took and
repeated them, the first's `release_thought` returned false, and after three
expiries the reaper marked the row failed — a cap written for a thought that
kills every worker that touches it, applied to a healthy row that was slow.
`reembed.ts`'s header called its arithmetic "a stand-in for per-row lease
renewal (SMD-1023)". This is the renewal.

**Migration 031: `renew_claims(work_type, worker_id, ttl_seconds)`.** Every row
the worker holds under the key — status `claimed`, `worker_id` its own — has its
deadline moved to `now() + ttl`, never backward (`GREATEST` with the current
one), and the ids renewed are returned. Nothing else changes: `claim_thoughts`,
`release_thought` and `release_claims_for_worker` are as 015 wrote them,
`test-schema` [30] asserts 015 is still the last file to define the first two,
and the claim stays the single locking pass upstream kept it as when it left
renewal out. A pending row, a terminal row and another worker's row are not the
caller's to renew and are not returned. A lease past its deadline that no claim
has yet reaped is still the holder's — the reaper runs at the start of
`claim_thoughts` and nowhere else — and is renewed; a renewal and a reaper
reaching the row together contend on its lock, and the loser re-evaluates its
predicate on the winner's version under READ COMMITTED, so the row ends
renewed-and-held or pending-and-unrenewed, never both. The ids returned are the
rows still held: one of the batch not among them is no longer this worker's —
reaped, requeued by an edit, or deleted — and the caller reads the row to learn
which. One column comment beside it, on `ttl_expires_at`, says what the lease
means since 031; neither literal spells a flag with its dashes, which
`test-schema` [10] requires and [30] asserts of the live text. The file opens as
030 does: a brain adopted with `--baseline` whose schema lacks 015 is refused up
front, 015 and `--reapply` named, where a plain run would otherwise have passed
the `CREATE FUNCTION` (plpgsql resolves the table at first run) and failed at
the column comment with a bare "does not exist"; `test-upgrade` [9] drives it.

**The heartbeat, once.** `db/lease.ts` is the implementation the three workers
share, as `consolidation_pool()` was change 54's one pool rule: a timer per
worker that calls `renew_claims` every `--heartbeat` seconds while the worker
holds rows and sends nothing while it holds none; a `held` set that `claimed()`
fills after each claim and the loop removes each row from BEFORE its release
goes out, so a beat in flight across a release does not read the released row as
lost; a `lost` set for the ids a beat found no longer the worker's, which the
loop skips rather than repeating the provider's work and the summary counts.
Three guards keep that verdict honest. A claim bumps a generation the beat
compares on return, so an id released and won back inside one round trip is not
read as lost. `claimed()` takes its ids out of `lost`, since a claim returning
an id is proof the lease is this worker's again (016's edit trigger requeues a
row mid-extraction and a near-empty pool hands it straight back), and an id lost
for ever would be skipped while held, returned by the `finally` and reported
pending. `stop()` voids a beat still in flight, so the `finally`'s return of the
leases is not read as the loss of every one of them. And a row a beat finds gone
is not assumed reaped: the loop asks the row (`lostReason`) — deleted is counted
with the deleted; back in the pool (reaped, or requeued by an edit) is said so;
another worker's names the worker; and a row the reaper marked failed while this
worker held it — 015's reaper leaves `worker_id` as it was, so the row still
names this worker — says so and names `--retry-failed`. Beats never overlap (a
tick that finds one in flight is skipped) and the timer is unref'd, so it holds
no process open. The three workers wire it identically: started beside the
worker id, `claimed()` after the claim, each row removed before its release,
stopped in the `finally` that returns the leases, and the beats summed into the
run's summary; the lost-at-top step — ask the row, print, say which count — is
one function, `reportLost`, so the three cannot drift on it. Each opens a pool
of one connection per worker and one spare, and says beside the number that the
spare is what keeps the leases alive while every worker is parked on a lock or a
long statement (the case 023's header warned of), so long as each beat reaches a
row before a claim's reaper does — the row-lock race above. A beat that fails is
reported once per run of failures and the leases hold from the last one that
answered; a process that cannot reach the database cannot beat, and its rows
return to the pool as a dead worker's would, which is the right reading of it.

**The rule that replaces "the TTL must cover the batch".** `--ttl` ≥ 2 ×
`--heartbeat`, so one delayed beat cannot lapse a lease. A pair under it is
refused before anything is claimed — exit 2, the arithmetic shown; `reembed.ts
--status` answers regardless, as before — and a lease given without a heartbeat
derives one of a third of itself, at most 60 s and at least 1 s, so any lease of
two seconds or more fits and only a one-second lease has no pair (its refusal
names the lease alone, and says the heartbeat was derived rather than quoting a
flag the operator never passed). Both flags are bounded where the runtime bounds
them, and refused above with the reason: a lease over 2,147,483,647 s would fail
every claim on its signature (`--dry-run` had accepted one and the run then
failed on every claim), a heartbeat over 2,147,483 s would overflow the timer
into a beat every millisecond (measured: 1,411 beats in a second and a half).
`--dry-run` in all three workers prints the lease and heartbeat a run would use;
`--status` in all three names each holder, its rows, its earliest deadline and
the remedy for a dead one (`release_claims_for_worker`), which only `reembed.ts`
did before. A row whose lease is found gone at release is counted with the rows
the worker lost, not the ones it finished, so two workers' summaries add up to
the pass, and the provider's answer for it is printed marked unrecorded rather
than dropped. Every line about a lease found gone states what the worker
observed and the causes it cannot tell apart — a lapse, a hand release, an
edit's requeue — rather than asserting one; `release_claims_for_worker` issued
against a live holder is the case that made the first wording false. A worker id
is text any claimant wrote, and is cleaned before it reaches a terminal, as
change 54's rule for database text requires. `--ttl` now means one thing: how
long a dead worker's rows stay out of the pool. Nothing about the batch, the
timeout or the calls a thought costs sizes it, and the three refusals that did —
`reembed.ts`'s derived floor with its long-lease warning,
`extract-entities.ts`'s `--batch × --timeout`, `consolidate.ts`'s `--batch × --k
× --timeout` — are gone. The reaper's cap keeps the meaning 015 gave it: under a
heartbeating worker a lease lapses only when the beats stop reaching the
database for a whole lease, so a row expired three times is one whose worker
died three times on it, not one that was slow.

**Proof.** `test-live` [8e]: a worker on a 5 s lease beats at 4.5 s; a claim at
5.5 s — past the original deadline — gets only the unclaimed rows and the
worker's release succeeds; it beats once more and stops; a claim before the
renewed deadline gets nothing and one after it receives its three rows on their
second attempt, every row ending succeeded and none failed. [8a] and [8b] hold
as they were: the claim is untouched. [9] runs `reembed.ts` end to end with
every embedding taking 600 ms, sixteen per claim, a 6 s lease and a 1 s
heartbeat: two workers re-embed all forty-two thoughts in batches near ten
seconds long (a batch that fit inside the lease would pass with renewal a no-op,
so the batch is sized to outlast it), no row reaches a second worker, no release
finds its lease gone, none is lost, every claim row succeeded on its first
attempt — the ticket's first Verify bullet, which no arithmetic could pass; its
summary counts the beats, and the test holds them at ten or more. [9] then takes
a one-worker run's batch from under it by hand: the row in hand learns it at
release, the rest at a beat or their release, every stolen row is counted lost
and none finished, the worker finishes the rest and exits 1 naming the rows
still leased, and `--status` names the thief. [10] and [16] run their first pass
under a 6 s lease beating every second, with answers slowed to 400 and 700 ms,
so the beats fire in the other two workers — the count in each summary says they
did — and assert the old refusals are gone (a batch of four at a 300 s timeout
is a `--dry-run` that exits 0) and the new one holds. `test-schema` [30] owns
the state machine on one connection: the holder's rows and no others, never
backward, expired-not-reaped is still held, reaped is not, 015's CHECK still in
force under the new writer, both comments' text. A beat is one `UPDATE` through
015's partial worker index — [8e] asserts the plan reads it, as [8d] asserts the
claim's reads the pending one — and prints its round trip: a few milliseconds on
the function's first call, the plan included, and under a millisecond after.

**What did not change, and why.** The default lease stays 900 s: shorter is now
safe — a dead worker's rows return in `--ttl`, not `--ttl` plus the batch — but
the default is the operator's to lower and the ticket did not ask.
`extract-entities.ts` and `consolidate.ts` keep one thought per claim for the
reason that survives: a claim costs half a millisecond against a model call of
seconds, so a bigger batch buys nothing and a dead worker holds fewer rows. The
read-only modes never beat, since they never claim. 028's comments on
`last_error` and `release_thought` stand as applied — nothing here redefines
either function, which is the case 028's header said a successor must mind.

Upstream status: **not applicable** — upstream's `schemas/thought-work-claims`
left mid-batch renewal out deliberately, to keep the claim one atomic statement,
and its table is not this one (change 29's four departures). A separate renewal
function keeps the property upstream wanted and could be offered against its
schema; **unfiled** upstream.

### 58. Vendored SQL stops replacing what the migrations own — four files cut where they redefined `upsert_thought`, `trace_provenance` and `release_thought`, preflight names a replaced body, and check 7 holds the line (SMD-1250)

**The problem.** The community tree is vendored verbatim, and three of its
files carried `CREATE OR REPLACE FUNCTION public.upsert_thought(p_content
TEXT, p_payload JSONB DEFAULT '{}')` while presenting themselves as additive
sidecars: `schemas/enhanced-thoughts/schema.sql` and two drafts under
`docs/drafts/`. Against upstream's brain that was roughly true — upstream's
`upsert_thought` is the guide's. Against a brain built by `db/migrate.ts` it is
a replacement: `CREATE OR REPLACE` on a matching signature puts the new body
where 005's was, with no error, and a payload that is not a JSON object — the
double-encoding trap 005 closed — is emptied silently again for every caller of
the 2-argument form (PostgREST callers by name, the two-step fallback; the SQL
store calls the 3-argument form and was not touched by these three). Nothing
would have said so: preflight's body checks read sentinels, and 005's body
predates the convention.

**The scan found worse.** Check 7 run over the tree as vendored, before any
fix, lists 35 statements in 16 files under the rule as shipped: 24 violations
in 8 sidecar files, and 11 statements in the 8 bootstrap files the exceptions
cover (23 and 11 under its first draft, before `COMMENT ON FUNCTION` joined
it). Beyond the ticket's three:
`schemas/provenance-chains/schema.sql` defines `trace_provenance(uuid, int,
int)` and `find_derivatives(uuid, int)` — the argument lists 025 and 026 use.
Run against a migrated brain (the fourth review pass did), both `CREATE OR
REPLACE`s fail on the return type — upstream's `RETURNS TABLE` differs — and
the SQL editor rolls the paste back; statement by statement, what lands
silently is its `COMMENT ON COLUMN thoughts.derived_from` and `supersedes`
over 025's contract comments and a second copy of 025's array `CHECK`; after
the `DROP FUNCTION`s its own README's rollback runs, the two bodies install —
upstream's per-path recursive walk over 026's bounded one, the twenty-second
timeout change 47 removed — and the migrator's `--reapply` then fails on the
same return type until both are dropped again. `schemas/thought-work-claims/schema.sql`
defines `release_thought` and `release_claims_for_worker` under 015's exact
signatures and replaces both bodies with no error (run: every worker release
then fails 015's CHECK, since upstream's leaves the lease set, and a clean
shutdown deletes the worker's rows instead of returning them to the pool),
adds a `claim_thoughts` overload beside 015's (an id list in, where 015's
takes a pool name), and re-comments 015's table and columns and 028's
`release_thought`. And
`recipes/edge-function-cost-optimization/migrations/20260417_edge_fn_optimizations.sql`
— "additive (no schema changes)" by its README — defines `thought_stats_summary()`
over 024's (run: `thought_stats` then raises `field name must not be null`
on the first thought whose topics hold a null element, which 024's body
drops) and `upsert_thought(text, jsonb, vector)`, the 3-argument capture
every write on the SQL path runs, with a body from 2026-04 that has none of
005's guard, 008's actor, 021's label, 022's window rule or 025's provenance
envelope: one paste, and every capture after it wrote a row missing all five.
The remaining hits were files that create a brain rather than add to one — the
getting-started guide, a recipe's Neon SQL, a Kubernetes init script and the
ConfigMap carrying it, a local-Postgres recipe's two init scripts, and the
fingerprint recipe's README, which is where 003's statement came from.

**The posture, decided.** The ticket offered three: fence the files, refuse at
the database, delete them. Taken under the standard change 51 wrote down —
audit once, hold the delta, a standing check carries it — with one rule per
kind of file. A **sidecar**, a file that adds to an existing brain, has its
redefining statements **cut** and a header naming the migration that owns each
function and why the cut is safe: enhanced-thoughts loses its section 6 (its
README never mentioned the upsert; the columns are filled by the file's own
backfill, and a capture does not update them — the README says so now);
provenance-chains loses sections 5 and 6, its two comments on 025's columns
and its copy of 025's array `CHECK` under another name (the metadata-merge
helpers, which have no counterpart in the migrations, stay; the README's
example calls run against 025's and 026's functions, and the README now says
what those return and do not do — the fork's columns, no tier redaction,
`SECURITY INVOKER` — where upstream's text promised redaction; its rollback no
longer drops the two functions, 025's two columns or 025's two indexes); the
cost-optimization
migration loses both functions and now says why, with the recipe's Edge Function
steps standing and its step 1 rewritten; and thought-work-claims, every
statement of which targets 015's table, becomes a stub — its README carries the
reason at the top and its rollback, which would have dropped 015's table with
the three workers' state in it, is replaced by that reason. The two
`docs/drafts/` SQL files are **deleted**: upstream's scratch space, nothing here
depends on them, and the one recipe README that linked the base draft as "the
canonical thoughts schema this recipe mirrors" points at `db/migrations/`
instead. A file that **creates a brain** is **excepted**, per file and function
and counted, with the reason beside it in the checker: the guide (SETUP.md
already sends this fork's readers past it), the Neon, Kubernetes and
local-Postgres bootstraps, and the fingerprint recipe's README, which gains a
note above its Step 2 saying what pasting it onto a migrated brain would do.

**Check 7.** `scripts/check-fork-consistency.mjs` reads the owned set from
`db/migrations/` — every `CREATE [OR REPLACE] FUNCTION` at the start of a line,
dollar-quoted bodies and then comments stripped first, with the file that last
defines it: 36 names today, never typed, through `ownedFunctionsIn` in
`db/config.mjs`, and `test-schema` reads the same set and holds it to 36 or
more (a smaller set is a reader that lost definitions, not a migration gone) —
and fails any `CREATE`, `DROP` or `ALTER` of a `FUNCTION`, `PROCEDURE` or
`ROUTINE`, or a `COMMENT ON` one, naming an owned function at the start of a
line, bare or schema-qualified, quoted or not (the quoting a Supabase dashboard
export emits), the name on the line after the keyword allowed, in every
non-binary, non-ignored file under the seven category directories whole —
their root READMEs and `_template`s included, which the per-contribution walk
the other checks use skips — and `docs/`. A second owned set, read the same
way, is the `thoughts` columns whose `COMMENT` a migration writes (three: 021's
`embedding_model`, 025's `derived_from` and `supersedes`), and a vendored
`COMMENT ON COLUMN` of one fails too — the one statement upstream's
provenance-chains file did land silently. The rules are two regexes,
`coreFunctionStatement` and `coreColumnCommentStatement` in `db/config.mjs`,
multiline and tested against a whole text, and `test-schema` [31] applies
both to the fixed enhanced-thoughts file. By name, not signature: a
matching signature is the silent replacement, and an overload beside an owned
function is the ambiguity 004's header names. `COMMENT` because 028 and 031
carry a data contract in a function's comment, which a vendored `COMMENT ON`
overwrites as silently as `CREATE OR REPLACE` overwrites the body. Fifteen
strings the function rule must catch and thirteen it must not — a `GRANT`, a
`REVOKE`, a `COMMENT ON COLUMN` of an unowned column, a `SELECT`, a header
comment quoting a statement, `update_updated_at_column()`,
`match_thoughts_recency(`, `upsert_thought_v2(` — and two the column rule
must catch and three it must not, run through the scan's own machinery on
every invocation, and exceptions are
counted as check 6's are. Proven: a probe file with a definition, a drop and a
comment failed on three lines; one line appended beside the excepted statement
in the fingerprint README failed as "covers 1 line(s) but 2 match"; the fourth
pass's probes — mixed case, a `.sql.example`, the deleted draft re-added, a
README fence, CRLF, a BOM, the name on the next line — each failed; the fixed
tree passes, 118 contributions, no violations. Known and accepted: a `DROP
FUNCTION a(), b()` list and dynamic SQL (`EXECUTE 'CREATE …'` in a DO block)
are not caught — no vendored file writes either.

**Preflight names the body, and the migration that owns it.** `atomic capture`
read the 3-argument body's sentinel and nothing else; two of its remedies named
022 as the last definer of the 3-argument form, and 025 has been that since
change 46 — so the remedy itself would have put 022's body over 025's, dropping
the provenance envelope silently, the exact class this change is about. Now:
the 3-argument form missing is a refusal naming 025; a 3-argument body without
022's sentinel warns naming 004, 005, 008 or 021 re-applied without 025 after
them, or the cost-optimization recipe's overload, remedy 025; a body with 022's sentinel but without 025's envelope
(022 re-applied by hand — a state preflight passed as shipped before) warns
naming 025; a 2-argument body without 005's guard (the guide, the fingerprint
recipe's Step 2, or a schema that mirrors columns on write, pasted onto a
migrated brain) warns naming 005 and then 025 again, since 005's file
redefines the 3-argument form too; and the ok says both bodies are the shipped
ones. `provenance` reads `trace_provenance`'s body for 026's
`ob1:provenance-walk-bounded` and warns, naming 026, when it is gone — 025
re-applied by hand or the vendored provenance-chains schema. The two
recognisers, `UPSERT_TWO_ARG_SHIPPED_RE` and `UPSERT_THREE_ARG_SHIPPED_RE`, live
in `db/config.mjs`: each is the one clause that migration added and no earlier
body has (005's `jsonb_typeof(p_payload) <> 'object'`, 025's
`p_payload->'derived_from'`), where the migrations have no sentinel and cannot
gain one (a hashed file). The two forms are picked by signature, not arity —
a vendored bootstrap's `upsert_thought(text, vector, jsonb)` is a third
3-argument form, and reading whichever the catalog returned first judged a
healthy brain by the wrong body — with the signature built from `pg_type`'s
names rather than `regprocedure`'s text, which schema-qualifies `vector` when
pgvector is off the search path (the shape change 43's check already fails)
and would have called a present form missing; any other overload is named in
the detail. The 2-argument verdict rides every 3-argument state, the refusal
included. `test-search-path` [4] holds the signature pick to the off-path
shape — the refusal it would otherwise have raised there is what the second
review pass found. The 2-argument body is judged on its own and said beside
whichever 3-argument state fires, with 005-then-025 as the remedy, so a brain
with both replaced hears it once rather than on the run after the first
remedy. Two more bodies the fourth pass replaced on a real brain gained a
recogniser and a check: `stats summary` warns when `thought_stats_summary`'s
body lacks 024's type guard on the topics array (the recipe's body raises on a
null element), and a new `work claims` check fails when `release_thought`'s or
`release_claims_for_worker`'s body does not clear the lease as 015's CHECK
requires (upstream's thought-work-claims paste; every worker release would
fail), names any overload of the four claim names no migration defines with
its `DROP`, and skips before 015. The `provenance` remedies are ledger-aware
now and say to `DROP` both functions first when the body present returns
other columns, since the migrator's re-run otherwise fails on the return type
— the fourth pass ran that remedy and watched it fail. The re-run remedy
every ledger-aware check shares no longer blames `--baseline` alone: its
parenthetical names a body put there or removed from outside the migrations.
Over PostgREST none of this is reachable, and the skip says so as before.

**Proof.** `test-schema` [31] reads the owned set as the checker does and pins
the three last definers preflight's remedies spell (`upsert_thought` 025,
`trace_provenance` 026, `release_thought` 015 — when one moves, so must the
remedy), holds both recognisers against the shipped bodies, then applies the
fixed `schemas/enhanced-thoughts/schema.sql` whole to the migrated brain
(Supabase's roles created first, since its `GRANT`s name them) and asserts every
owned body and overload is byte for byte as the migrations left them while the
file's own columns and functions arrive and a double-encoded payload is still
refused; then what upstream's file did — 003's body over 005's raises nothing,
changes exactly one owned body, and the double-encoded payload is emptied
silently again — and what the recogniser is for: 022 over 025 keeps the
sentinel and drops the envelope; then the last definers re-applied put every
body back. `test-preflight` drives each warning and its remedy against real
Postgres: 021 over 025, 022 over 025, 003 over 005, 003 and 021 together (one
warning naming both bodies, remedy 005 then 025), 005 alone (a pre-022
3-argument body with the 2-argument one right, which is why the remedy says
"then 025 again"), the form dropped (remedy 025, not 004, not 022), 025 over
026 for `provenance`; and, from the fourth pass, a stats body that is not 024's, a release body that is not 015's, a stray claim overload named with its `DROP`; 683 and 188 assertions. `check-fork-consistency` passes
the fixed tree and failed the probes above.

**Not done, and why.** Vendored `COMMENT ON COLUMN`, `DROP INDEX` and `ADD
CONSTRAINT` over 025's columns are a column-level owned set — cut here where
found (two comments, two index drops, one duplicate `CHECK`), with
provenance-chains keeping two `CHECK`s on the two columns 025 declined; check
5 covers an unguarded `ADD COLUMN`, and the rest waits for a ticket that reads
columns and indexes from the migrations as this one reads functions.
`thought_stats_summary` and
`release_thought` have no recogniser: nothing in 024's or 015's body is a
clause a vendored body would lack by construction, so check 7 is their guard
and SMD-1227's table of sentinels the way to more. The getting-started guide
keeps its three statements unfenced in the text — SETUP.md is the fork's
front door and says to read it instead — and preflight is the guard for a
reader who pastes it anyway.

Upstream status: **unfiled** — the three files disagree with each other there
too (the ticket's finding: `enhanced-thoughts` declares `importance SMALLINT
DEFAULT 3` and its own upsert writes a default of 50 clamped to 0–100), and
which body an upstream brain ends up with depends on the order the user pasted
recipes in. A note could be offered.

### 59. Decompose-then-rerank, measured on two corpora — reranking one pool is the lever, decomposition is not, and how you combine the pools makes no significant difference (SMD-1420)

Change 55 named this the "measured, motivated follow-up": rerank each sub-question's
pool before interleaving, to convert decomposition's coverage into strict@5.
Measuring it forced the real question — there are three ways to feed a decomposed
query to a cross-encoder: rerank each sub-pool and **interleave**, **merge** the
sub-pools into one candidate set and rerank once, or (change 53's arm, no
decomposition) rerank the **one blended pool** — so which, if any, wins? Like changes
31/53/55 this ships **no runtime change**. The harness `evals/decompose-rerank.ts`
emits all three pools from one dump and scores them together; the reranker
(`rerank-llm-reranker.py`) is reused unchanged.

It was run on **two** corpora, because the answer turns on headroom: LongMemEval-**S**
(~40 sessions/question) saturates once reranked, so arms can't separate;
LongMemEval-**M-cleaned** (~476 sessions/question, ~10× the haystack) has a low
baseline and real room. Fired-only strict recall_all@5 (round-robin), MemReranker-4B,
MS / temporal:

| fired-set arm | S | M |
| --- | --- | --- |
| baseline | 80.0% / 82.7% | 52.0% / 59.6% |
| decomposition-only | 82.0% / 80.8% | 62.0% / 57.7% |
| **one blended pool → rerank** | 96.0% / 78.8% | 78.0% / 78.8% |
| decompose → interleave rerank | 94.0% / 78.8% | 78.0% / 75.0% |
| decompose → merge → rerank once | 98.0% / 78.8% | 78.0% / 78.8% |
| oracle | 100.0% / 96.2% | 86.0% / 86.5% |

The S row invites a story (merge 98 > one-pool 96 > interleave 94). A **paired test
kills it.** McNemar exact on the per-question hits (fired set):

- **Reranking vs baseline** is a large, *significant* lift on multi-session for every
  pool method (S p ≈ 0.02, M p = 0.002–0.004) and on M temporal for the one-pool and
  merge arms (p = 0.021; the interleave arm's smaller M-temporal lift, 75.0%, is
  p = 0.06 — not significant); +26 points on multi on the harder M (52% → 78%). The
  reranker earns its place.
- **The pool-combination technique — interleave vs merge vs one blended pool — is not
  significant anywhere**: either corpus, either slice, either reranker (every pairwise
  p ≥ 0.375, net win/loss of 0–4 questions; **merge == one-pool *exactly* on M**). The
  S 94/96/98 spread is sampling noise, and M — with far more room (multi baseline
  miss-rate 20% on S → 48% on M), the fair test — confirms it. Decomposition does not
  separate from reranking one pool even where a real difference had every chance to
  appear.

Decomposition-**as-retrieval** does help on M (+10 multi, 52% → 62% before any
rerank — several vectors cover more of a 476-session haystack than one) but
reranking one pool subsumes it (78% ≥ 62%). And on M even the *generic*
Qwen3-Reranker-4B lifts multi significantly (52% → 72%, p = 0.021), so the multi
benefit is not purely MemReranker's benchmark-fit in the hard regime (change 53's
held-out caveat still bears on the magnitude and on temporal, where only the
calibrated model helps).

**Decision: decline decompose-then-rerank.** Decomposition is not the lever and the
pool-combination method does not matter; *reranking one pool* is the lever, and it
pays off most on hard, large-haystack retrieval. That aims the follow-up at a capable
**non-benchmark** reranker over one pool (hosted Voyage `rerank-2.5`, SMD-1319), and
it **validates SMD-1039's premise** directly: M separated rerank-from-baseline
cleanly where saturated S could not, so a hard held-out corpus is what a shippable
reranker must be judged on. Change 53's reranker decline stands; this change is why
the *next* reranker look should be one-pool on a hard corpus, not decomposition.

Upstream status: **not applicable** — a fork-internal measurement of the fork's
own retrieval. **Unfiled** upstream. Reproduce: change 55's sub-question dump, then
the three-pool dump / per-pool rerank / `--score` recipe in `decompose-rerank.ts`'s
header (all three arms — interleave, merge, one-pool — from one dump), and the
McNemar test in `evals/README.md`. The M corpus is loaded in question shards into
its own DB with a post-load `lme_q` completion pass, then scored through a slim M
file reusing the S decomposition dump — recipe in `evals/README.md`. The loader's
inability to `readFileSync` a >2 GB corpus is filed as a follow-up.

### 60. `update_thought` takes provenance — `supersedes` and `derived_from` can be set, changed and cleared through the one edit function, and the review path writes through it (SMD-1323)

Change 46 put `derived_from` and `supersedes` on `thoughts` and let
`capture_thought` set them through the payload envelope, and deferred the other
half in the function's own body: a re-capture *adds* provenance and never
clears it — "removing or changing provenance is `update_thought`'s job (a
follow-up)". Nothing took the follow-up. A supersession recorded wrong at
capture had two ways out, a raw `UPDATE` or `delete_thought`; and when change
54 needed to write `supersedes` on an accepted proposal, its ticket's
"accepting one calls `update_thought`" could not be honoured, so
`review_supersession_proposal` set `ob1.actor`, locked the row and wrote the
column in one `UPDATE` of its own — the audit outcome the same as an edit's,
018's "one writer stays one writer" bent by one function, and 029's header
saying so.

**Migration 032.** `update_thought` gains a ninth, defaulted parameter,
`p_provenance jsonb` — the envelope shape `upsert_thought` has read since 025,
`{"supersedes": <uuid> | null, "derived_from": [<uuid>…] | null}`. An absent
key leaves its column alone; a JSON null clears it; a value sets it, validated
as 025 validates at capture. The 8-argument form is **dropped first** and its
ACL replayed onto the new one (021's mechanism, 020's block), since an overload
beside it would make every call with eight arguments or fewer `function is not
unique` — and 018's 7-argument form is dropped `IF EXISTS` too, so a brain
where 018 was re-applied by hand ends with one function. 021's body is carried
forward verbatim (`test-schema` [32] reads each earlier migration's piece out
of `pg_proc` by name, as [19] and [22] do). Three things the redefinition adds:

- **`validate_derived_from(jsonb)`**, 025's element rule as one function —
  null, JSON null and `[]` are NULL; otherwise an array whose every element is
  a UUID string naming an existing thought, returned lowercased, de-duplicated
  and sorted, or one of 025's three exceptions. `upsert_thought` keeps its
  inline copy until its next redefinition (SMD-1043, change 63) takes this one — the
  shape 016's `content_fingerprint_of` took, with 018 the first caller — and
  [32] holds the two equal meanwhile, input by input, message by message.
- **The `supersedes` checks.** Shape by regex (an exception, as capture);
  existence answered as a refusal, `SUPERSEDES_NOT_FOUND`, where the ticket
  said "by the self-FK" — the cycle walk reads the target's row anyway, so the
  answer is free, and the function's contract is refusals as objects
  (`NOT_FOUND`, `STALE_READ`, `DUPLICATE_CONTENT`), where a 23503 at the tool
  boundary is the opaque error 009 removed; the FK still stands behind it for
  the race and for every other writer. And 029's cycle walk, moved here:
  `WOULD_CYCLE` when the target is the thought itself or the chain of pointers
  from the target reaches it, bounded at 1000 steps. A supersedes write takes
  029's advisory lock **before** the row lock, so every path acquires in one
  order — supersession lock, row, fingerprint lock (change 63 moves the
  fingerprint lock before the row, for every writer) — and a hand edit and an
  acceptance are serialised with each other; the header states the order and
  why no pair crosses.
- **`review_supersession_proposal` redefined** (029's body) to call
  `update_thought`: accept passes `{"supersedes": <older>}` on the superseding
  thought, reject passes `{"supersedes": null}` when the pointer it wrote still
  stands. Its own `UPDATE`s of `thoughts` and its walk are gone; a refusal
  `update_thought` returns comes back through the proposal with the pair
  named, so `consolidate.ts --accept` prints the same sentence. The
  proposal-level rules — `DIRECTION_REQUIRED`, `ALREADY_ACCEPTED`,
  `EDITED_SINCE`, `ALREADY_SUPERSEDES`, `pointer_written`, "undo only your own
  write" — are untouched, and [28] passes over the new body unchanged.

A provenance-only edit is an edit: the row is locked, `if_unchanged_since` is
a predicate on the write, `updated_at` moves, and the audit row carries the
diff with the actor — what 029's `UPDATE` did under the triggers, now by the
one path. Content, vector, label, fingerprint and windows are untouched unless
`content` arrived. `derived_from` through the envelope **replaces** the array;
a merge would be a second verb, and 025's re-capture already does "add if
empty" (until change 66, which drops the fill).

**The row lock is `FOR NO KEY UPDATE` now, not 018's `FOR UPDATE`** — the one
line of 018's this migration changes, found by the first review pass. Writing
`supersedes` is the first time `update_thought` writes a foreign-key column,
and the FK check takes `FOR KEY SHARE` on the *target* row: a fourth lock, on
another row, taken last. `KEY SHARE` conflicts with `FOR UPDATE` and not with
`FOR NO KEY UPDATE`. So under 018's lock: A edits Q with content T and
`supersedes` Z (holds the supersession lock, Q, the fingerprint lock for T); B
edits Z with content T (holds Z, waits on the fingerprint lock); A's `UPDATE`
waits for `KEY SHARE` on Z — a deadlock, and one caller gets 40P01 where 018
promised `DUPLICATE_CONTENT`. `FOR NO KEY UPDATE` still conflicts with itself,
with `FOR UPDATE` and with `FOR SHARE`, so two edits of one row serialise as
before, 022's read in `upsert_thought` is still ordered against it, and
`delete_thought` still waits; the id never changes, so `KEY SHARE` is the only
lock it lets through. `test-live` [6d] holds both arms: a `FOR UPDATE` holder
in B's place deadlocks, the function does not.

**Callers.** `UPDATE_THOUGHT_SIGNATURE` names the 9-argument form and
`SUPERSEDED_SIGNATURES` the 8-argument one (the schema reset drops it, as a
test re-applies 021). Both stores send `p_provenance` — `provenanceEnvelope()`
in `store.ts` builds it for the SQL positional call and the PostgREST named one
alike, so an absent key reaches the function absent (null means *clear* there)
and an edit naming nothing sends NULL. `reembed.ts`'s positional eight resolve
through the default; its refusal names the nine-argument form and asks the
ledger about 032 when the column is there and the body is not. Preflight's
`edit signature` reads for the 9-argument form alone, over both connections:
018's or 021's form beside it fails the start with the exact `DROP` — the state
SMD-1323's verify names, and the one 021 re-applied by hand puts a brain in —
and a form from before 032 fails naming 032. The MCP `update_thought` tool
takes `supersedes`: an id sets, `null` clears, omitted leaves, and a
supersedes-only edit is no longer "would do nothing"; the two refusals are
explained in the tool's words, and a value that is not an id is refused at the
tool before the database sees it. `derived_from` is not offered on the tool —
an edit to a synthesis's source list is a store-level operation with no client
asking for it yet; the stores take it.

**Every checkout that runs against the brain upgrades together** (the second
review pass). A pre-032 checkout's preflight refuses a 032 database with a
message naming 021 (it looks for the 8-argument form and finds none), its
`reembed.ts` refuses the same way and sends the operator to `--reapply` — and a
pre-032 `migrate.ts --reapply` re-runs 001–031, where 021 re-creates the
8-argument form *beside* 032's: the two-form state above, every call with eight
arguments or fewer `function is not unique`, until a 032 checkout re-applies.
The compose stack is in lockstep; a hand-run server, a second workstation or a
Supabase brain migrated from one laptop and served from another is not.
`server-portable/README.md` §4 says so. The migrator cannot see the hazard
today — it reads the directory, never a ledger row with no file — and refusing
`--reapply` when the ledger names a file the checkout lacks is SMD-1451.

**Verify.** `test-schema` [32]: one function of nine parameters, neither older
form beside it, 032 the last definer of the three names it touches, every
earlier migration's piece in the body by name; set, leave, replace and clear
for both keys with the audit row per change and nothing else moved; a ghost, a
self-pointer, a direct loop and a loop through a chain refused with nothing
written; the four exceptions; the envelope double-encoded refused as 005
refuses a payload; `if_unchanged_since` guarding a provenance edit;
`validate_derived_from` against `upsert_thought`'s inline copy on four inputs;
the review path's acceptance producing `update_thought`'s audit row and its
`WOULD_CYCLE` naming the pair; 021 re-applied leaving the 8-argument form
beside the 9-argument one (an 8-argument call `not unique`), 032 dropping it,
and a revoke and a grant on the 8-argument form carried across the `DROP`.
[22] and [23] follow the last definer ([23] restores `update_thought` after
its 021 re-apply, which now matters). `test-preflight`: the 9-argument form
alone ok; 018 beside it, then 021 beside it, each refused with its own `DROP`
and only that one; 018's form alone and 021's form alone each refused naming
032. Both store suites round-trip set, leave, clear and the two refusals as the
union rather than a throw. `test-update-delete` [9] drives the tool: set with
the reply naming the pointer and the audit row under the key's name, a loop
and a ghost refused in the tool's words, omit leaves, null clears.
`test-live` [16] is unchanged in outcome; [6d] holds the lock-order arms.
`test-upgrade` [10] applies 032 through the migrator onto a populated 031
with a hardened 8-argument form: one 9-argument function afterwards, the ACL
carried, no row and no audit row moved, an 8-argument positional call still
resolving, the envelope clearing a capture-time pointer, a re-run a no-op —
and [7]'s `--reapply` assertion follows the arity (the first review pass found
it still saying eight; CI runs that suite). Green: `test-schema`
749/749, `test-preflight` 191/191, `test-upgrade` 119/119,
`test-live` 457/457, `test-store-sql`, `test-store-postgrest`,
`test-update-delete`, `test-e2e-sql`, `tsc`, the consistency checker.

**Not done, and why.** `upsert_thought` still carries its inline copy of the
derived_from rule — switching it is a redefinition of the other function, which
SMD-1043 owns (change 63 does); whichever of the two lands second carries the first's body. No
`derived_from` input on the MCP tool (above). The three audit reads in the test
suites that ordered by the audit table's uuid key now order by `created_at` —
one of them, [28]'s, was a latent flake this section's twin assertion exposed.
[32]'s reads later left `created_at` too (SMD-1514): separate transactions do
not promise distinct values of it — PGlite's clock has millisecond grain
(change 65's [34] note, SMD-1498) — so each read is now the set difference of
the thought's audit ids across the one write, and the `updated_at` compare
sleeps 2 ms first, since 001's trigger re-stamps the column on any UPDATE and
disabling it would disarm what [9] tests; [9]'s own compare, `>=` across two
statements, passed with the trigger dropped and now sleeps the same 2 ms and
asserts `>`. [28]'s read is unordered and asserts what makes it safe: its
thought has one update row when it is read.

Upstream status: **not applicable** — upstream's `update_thought` (the
`integrations/*-thought-mcp` recipe 009 ported) has neither the provenance
columns nor the review table.

### 61. 021's evidence backfill runs with the operator's acceptances out of its sight — a view of the claim table shadows the real one for that file, and no gate refuses the run (SMD-1421)

`db/migrate.ts`, `db/config.mjs`, `db/config.d.mts`, `db/reembed.ts`,
`db/test-upgrade.ts`, `db/test-support.ts`, `db/README.md` and
`scripts/check-fork-consistency.mjs` (Linear SMD-1421, filed by change 56's
sixth and seventh review passes). No migration: 030 stands as it is, and the
correction it cannot make becomes the migrator's.

**The finding.** Change 56 gave `migrate.ts` a gate: before 021's evidence
backfill ran — under `--reapply`, or on a plain run with 021 pending — it
refused when an accepted claim row stood that the block would label an
unlabelled thought from and 030 would not take back, listed the rows, and
printed a way back that spent the acceptance (`reembed.ts --job <key>
--retry-fallbacks`, `--retire <key>`, or the statement `--retry-fallbacks`
runs, on a schema `reembed.ts` refuses). Seven review passes found a seam in it
each — the bound, the grammar, the tie, the plain path, 030 not following, the
lock — because the gate was the *difference* of two rules, 021's and 030's, and
every case either rule had was a cell the gate had to enumerate by hand. The
sixth and seventh passes proposed the same higher altitude: the migrator holds
the one fact 030, hashed and applied, cannot — the labels *before* 021's replay.

**What this does.** One helper, `applyShadowed`, runs every file, and runs
021 with the operator's acceptances out of its sight. Before the file, a temp
*view* named `thought_work_claims` is created over the real table without the
accepted rows — `ACCEPTED_CLAIM_SQL`, the predicate 030's evidence rows carry,
spelled once; a view, not a copy, so nothing is materialised and the block
reads the claim rows as they stand when it runs. An unqualified name resolves
in `pg_temp` before any schema on the search path, and 021's block is a `DO`
block, resolved when it runs, so it reads the view and labels from the latest
row that is *not* an acceptance, or not at all: 030's rule, by 021's own text,
with no second spelling and nothing wrong ever written. The view is dropped
right after the file in the same
transaction, so 022 onward read the real table. `pg_temp` is searched first
for relations exactly when the path does *not* list it — listed first, it is
also where `CREATE` puts things, functions included — so a role's path that
lists it has it removed for the transaction, the path is otherwise left alone,
and that the name resolves to the copy is checked before the file runs.
Creation targets are then unaffected. The view takes ACCESS SHARE on the claim table, as 021's
block did, and nothing on `thoughts` before 021's own ADD COLUMN: no lock the
file alone never took. The run says beside 021's line how many thoughts the
block labelled — zero included, read from the transaction's own statistics
(`pg_stat_xact_user_tables`), so nothing reads `thoughts` before the file.
Judged before any SQL, both modes: the role may create a temp table. The
loader refuses a set without 021 and two files sharing a number, since the
file is named whole; the fork checker refuses the second on every push, where
the collision is made.

**What went.** The hazards query, both arms of the way back, the `has_edit`
and signature probe, the claim-table probe, the "030 recorded" branch, the
plain-run refusal and `runs021`/`runs030` — about a hundred lines of
`migrate.ts` — and `REQUEUE_SET_SQL`'s second reader (`reembed.ts` keeps the
constant). The re-run keeps its four judgements before `BEGIN` — drift, the
pgvector floor, the column's width, `ob1_config`'s model against the shell —
and the checks' own lock timeout now guards the `ob1_config` read alone. The
operator never spends an acceptance to re-apply: the suffixed-key acceptance,
the own-key acceptance over a thought written since its enqueue, and the hole
at 021 with 030 recorded — the three cases change 56 refused — end with the
thought unknown and the acceptance standing. `reembed.ts`'s ledgered remedy and
`db/README.md` §5 say so.

**Why the input and not the output.** Four review passes bracketed 021's
*output* instead — a snapshot of the unlabelled ids before the file, a
set-back under a held trigger after it, and 030's rule applied to the rows set
back: first as a copied constant, then as 030's own text run inline, then
deferred to 030's own place, then inline on plain runs only — and each pass
found a seam in the bracket: the lock upgrade from the snapshot's read to the
file's ALTER; the claim row committed between snapshot and block; 030's
current text run past its drift check; a `WHERE false` that still named an
absent column; an early return that skipped 030's first statement; a SHARE
lock that needed UPDATE where the file needed SELECT. The fifth pass proposed
the shadow and verified it against 021's actual block on a throwaway Postgres:
nothing to set back, nothing to report but a count, no lock the file did not
take, no second code path. What it costs: a tie on `finished_at` between two
plain rows is 021's unnamed pick rather than 030's `work_type` tie-break, and a
label from before 021 that 030's first statement would take back — a paste of
the body over an acceptance — waits for 030's own run, which on a hole at 021
alone is the re-run. The ticket's sketch, which kept a label whenever *any*
non-accepted row at that model supported it, is wrong in one shape (plain rows
at M then E, then an acceptance at M: 021 writes M from the acceptance, the
sketch keeps it, E is right); the shadow has no such case, since 021 reads the
latest non-accepted row.

**Review, first pass (high), triaged.** The snapshot's read took ACCESS SHARE
on `thoughts` before 021's ADD COLUMN asked for ACCESS EXCLUSIVE — a lock
upgrade the file alone never did — so on a plain run with the server still up
a label written in that window would be set back as if 021 had written it, and
two migrators would deadlock; the bracket now takes 021's lock first, and
within 10 s (the plain loop had no timeout, and the removed checks were the
only fail-fast a plain run with 021 pending had — [7] holds the lock and reads
the failure at 021 with nothing recorded). The count line said every set-back
label was "from an acceptance" when the count is the rows the rule disagreed
with 021 on — 021's unnamed pick of a tie included — and the count itself was
read from an undeclared `count` field on Bun's result; it is now `WITH changed
AS (UPDATE … RETURNING 1) SELECT count(*)`, `reembed.ts`'s idiom, and the line
says "set by 030's rule instead". The snapshot was corpus-sized and built even
where no succeeded claim row names a model; the bracket short-circuits on
030's own test and snapshots only thoughts with such a row (a thought without
one is labelled by neither side, so the writes and the count are unchanged).
The rule was spelled twice in one UPDATE (the SET and the predicate) — a
derived table computes it once. The `startsWith("021_")` literal was doubled
by a scalar slot; the re-run collects a map and `sql.begin` returns the plain
run's value. The checks' own lock timeout had lost its only test with the
gate; [7] locks `ob1_config` and reads "could not be judged". A stale comment
in [7] still called the gate current. **Ticketed: SMD-1434** — the altitude
above this one: a plain run applies a pending file after recorded later
siblings (a ledger hole) with no judgement, and 021's body over 022's and
025's `upsert_thought` is only the case this ticket's fixture happens to show;
the loop can refuse, or warn under `--dry-run`, and name `--reapply`.

**Review, second pass (high), triaged.** The bracket locked `thoughts` and not
the claim table, so a claim row committed between the snapshot and 021's block
— `--accept-failed`'s UPDATE is a separate autocommit statement needing only
ROW EXCLUSIVE — was evidence the block read and the snapshot never saw, and
its label stood; the claim table is locked SHARE after `thoughts` (reembed.ts's
start takes them the other way round, and the banner says to stop the workers
first). The first pass's 10 s applied to 021 alone, overriding a role's
default for one file while every other plain-run file had none; every
transaction the migrator opens now sets one `LOCK_TIMEOUT_S`, quoted by every
message that names it, and the plain arm of the lock message says so. The
first pass's `LATEST_UNACCEPTED_CLAIM_SQL` was a second executable spelling of
030's second statement, held equal to the file only by an indentation-sensitive
pin; the bracket now sets 021's labels aside and runs 030's own substituted
text, so the rule has one spelling and the constant, its declaration and the
pin are gone (the reviewer's measured cost of the join it replaced — the claim
table read whole under the exclusive lock — is now 030's own, stated in the
comment). The count line became a report: how many thoughts 021 labelled, how
many 030's rule changed, and the first fifty rows with both labels, since the
label is not an edit and nothing else records them. `reembed.ts`'s "Saying I
know" still credited the re-run's correction to 030 alone, and README §5 said
030 corrects "what a paste left" when it corrects the own-key labels only.
The docblock claimed the bracket's evidence test was 030's early-return test,
which differs (`finished_at IS NOT NULL`); it is 021's. The tri-state return,
its cast and `Number()` went (`Promise<Bracket>`, empty for other files). [7]
hoists `labels()`, adds `recorded021()`, and splits the hole assertion so a
failing regex prints the run.

**Review, third pass (high), triaged.** On a plain run with a hole at 021 the
bracket ran 030's *current* text before the loop reached 030's drift check, so
an edited-after-apply 030 ran and committed — refused before anything runs,
both modes, and [7] edits the ledger's sha and reads the refusal and the dry
run's. 030 was found by `startsWith("030_")`, which any second 030_*.sql
sorting first would satisfy (the fork has renumbered twice; a sibling branch
carries a 030 today): both files are named whole, and the loader refuses two
files sharing a number. The inline run of 030's whole text had its first
statement re-decide labels from *before* 021 with no report, beside a 030
line that said "already applied" — and ran 030 twice on every ordinary
upgrade: 030's text now runs inline only where the ledger records 030 and the
run would skip it, with every prior label noted first and a second delta
reported ([7] plants a paste's mislabel and reads it); otherwise 021's labels
are set aside for 030's own place, where the report is printed from a session
temp table. A TEMP-revoked role failed the bracket with a bare 42501 after
015–020 had committed, and a set without 030 threw inside 021's transaction:
both judged before any SQL (the second at load), both modes. A deadlock with a
worker's start (the docblock said "detected, not waited on") had no remedy
line; 40P01 has one. The count line's clause "an acceptance is not evidence"
had come back after the first pass removed it (a tie has none) — gone, and
"every acceptance stands" became "no claim row is touched". The README said
the run lists the rows while the code listed fifty — every row now. Change
57's file list named `test-schema.ts` (untouched after the second pass) and
missed `config.d.mts`.

**Review, fourth pass (high), at the user's call, triaged.** The third pass's
inline note of the labels from before 021 named the column in a `WHERE false`
query — resolved when the statement is parsed, so every plain run of a
`--baseline`'d brain with a hole at 021 and no column yet failed at 021; a
`NULL::text` there, and [9] runs that brain. The third pass's handoff — 021's
labels set aside for 030's own place — left every label 021 wrote, the right
ones too, committed NULL across 022–029's separate transactions on a plain
upgrade, where a worker's pool reads NULL as work; a plain run now decides
them inside 021's transaction (030's text runs again at its own place if
pending, idempotent, once in a brain's life), and only the re-run, one
transaction, defers — which also closes the report a dying run lost with its
session table and the count a live server could skew between the two
transactions. The bracket's judgements exited before the re-run's were
collected, against the "every refusal, one dry run" contract: one list, one
tail. The plain run took locks 021 alone never did — the claim table's against
writers, the other way round from a worker's enqueue — with no note to stop
the workers (the banner is the re-run's) and a deadlock line naming a re-embed
start that cannot run on a pre-021 schema: the plain run says so before it
applies 021, the banner and README name the lock, the lock messages name the
claim table, the deadlock line names an enqueue. The load-time check was
one-directional (a renamed 021 ran bare): both files or neither. The pre-021
label note copied every labelled thought; bounded to those with an own-key
acceptance, the only rows 030's first statement can change. [9] is new: the
plain run with the column absent, then with both files pending — the ordinary
upgrade path, which no test had run through the bracket.

**Review, fifth pass (high), at the user's call, triaged.** The fourth pass's
`wrote === 0` early return sat before the inline run of 030's text, so the
labels from before 021 it promised to re-decide were re-decided only when 021
had labelled something else — and the same return left an empty temp table
for the re-run's 030 to report "decided 0 labels" from. `LOCK TABLE … IN SHARE
MODE` needs UPDATE on the claim table where 021's block needed SELECT: a
read-only migrator role would have failed 021 with a bare 42501. The pre-021
note was itemised on a plain run and swallowed on the re-run. A deadlock's
victim is whichever waiter's timer fires first — the worker, most likely — so
the 40P01 line held for one of two victims. The per-row list had lost its
cap. Every one of these was the bracket's, and the reviewer proposed the
altitude above them, verified: shadow the claim table for 021's block with a
copy that carries no acceptance. Taken — the bracket, its types, its report,
its three temp tables, the claim-table lock, the plain-run note, the 030-drift
pre-check and the both-files check are gone; kept are the TEMP refusal (the
copy needs it), the loader's duplicate-number refusal, `LOCK_TIMEOUT_S`, one
list of refusals, the lock messages, a deadlock line that names no order.
`ACCEPTED_CLAIM_SQL` is the acceptance predicate spelled once, for 030's
evidence rows and the copy alike. [7] and [9] share one fixture and one
exit-tail helper; [7]'s 030-drift case went with the pre-check. Running the
suite found one more: named *first* in the search path, `pg_temp` is also
where `CREATE` puts things, functions included, and 021's `update_thought`
landed there and vanished with the transaction — so the path is left alone,
or stripped of `pg_temp` where a role lists it, and the shadow is checked
rather than arranged.

**Review, sixth pass (high), at the user's call, triaged.** Nothing checked
that 021 was in the set: a renamed file ran bare, reading the acceptances,
with no line saying so — refused at load. The labelled count was two
`count(*)` scans of `thoughts`, the first taking ACCESS SHARE before the
file's ADD COLUMN asked for ACCESS EXCLUSIVE — the lock upgrade the first pass
had removed, back on the plain path, and [7]'s held-lock case was timing out
on the count, not the ALTER; the count is now the transaction's own
`n_tup_upd` on `thoughts`, before and after, O(1) and no read of the table.
The line printed only for a non-zero count, so "shadow ran, nothing to label",
"ran bare, no claim table" and "older migrator" were one silence — printed at
zero too. A `DROP TABLE IF EXISTS` of the temp name was dead, and in the one
state it seemed to guard (a pooled connection handed over with such a table)
it broke the copy's source, resolved before the drop: gone, and that state is
refused. The copy carried every column of every claim row; the four the block
reads. The TEMP refusal led with acceptances on a fresh database with no claim
table; it leads with the privilege, and [9] exercises it with a role that has
none. The duplicate-number rule lived only in the runner, at every operator's
and compose start's expense; the fork checker carries it too, on every push.
Two README lines and this section's heading still described the bracket. [9]
plants a suffixed-key acceptance and rebuilds the brain for the both-pending
run, so the column is truly absent there.

**Review, seventh pass (high), at the user's call, triaged.** The
stale-temp-relation refusal keyed off the schema the *unqualified* name
resolved to, so a role path listing `pg_temp` last skipped it and the CREATE
died bare; it asks `pg_temp` by name. The copy was a materialised CTAS of
every non-accepted claim row — ~15 MB per 200k rows, written and scanned
under 001's exclusive lock on the re-run — with a snapshot window between the
copy and the block through which a worker's release, committed between, was
evidence bare 021 read and the copy lacked; a temp *view* over the real table
shadows identically, materialises nothing, and the block reads the rows as
they stand. [9]'s role fixture had no guard against a leftover and no
`finally`, so an interrupted run left the cluster's `PUBLIC` without TEMP and
every later run dying on "role already exists"; guarded both ways, the URL
built with `new URL()` and asserted to differ. `LOCK_TIMEOUT_S` was applied
by three mechanisms — a SET/RESET bracket around the checks and a `SET LOCAL`
in each of two `begin`s — while the ledger reads and the TEMP probe ran with
none; one session `SET` after the connection opens, the constant moved to
`config.mjs` so `test-upgrade` derives its three lock regexes from it, and
the three lock messages share one opening. The search-path strip split on
bare commas, mis-rewriting a quoted name holding one; a quote-aware split.
`standing()` hand-spelled the acceptance predicate the same diff had made one
constant; it uses `ACCEPTED_CLAIM_SQL`. A `!/030 decided/` clause guarded
against a printer the fifth pass deleted; the assertion is positive — 030's
line is followed by the summary. The 021 case leaked into the loops through a
tri-state and a `.some()` the load guard had made vacuous; the helper returns
the line to print and the loops print what a file returned. The
duplicate-number rule was spelled twice, in the runner and the checker;
`config.mjs` exports `duplicateMigrationNumber`, and both call it. **Declined:**
an environment override of the lock timeout so the suite's three 10 s waits
run in 3 s — a production knob for the migrator bought with test time, where
the three waits exercise three real lock paths.

**Review, eighth pass (high), at the user's call, triaged.** Main had moved:
SMD-1023 landed migration 031 and changes 57–59, and this ticket's test section
asserted 030 was the last file — merged (this section is 61 after a second
merge, its test section [11]), and the one assertion that assumed 030 was
last now asks that no note follows 030's line. The seventh pass's session-level `SET lock_timeout` does
not follow the migrator's transactions through a transaction-mode pooler,
where the freeze it prevents comes back silently; one `begin` sets it LOCAL
inside every transaction as well, and README §5 says to connect directly.
`duplicateMigrationNumber` judged only `NNN_*.sql` names, so `021-fix.sql`
would have sorted before 021 and run at its number unrefused by runner and
checker alike; `migrationNameProblem` refuses a .sql not so named, and two
sharing a number. `LOCK_TIMEOUT_S` claimed to be the one number when 023's
hashed body sets 10 s for a transaction that under `--reapply` is the whole
run's tail — the comment says so, and why the value is ten and only ten.
`test-support`'s `applyMigrations` applies 021 bare, acceptances in sight,
and said nothing; its docblock names the divergence and where to plant. The
search-path strip had four moving parts, a dead restore on plain runs and no
test: one unconditional `set_config` to the path without `pg_temp`, and [11]'s
both-pending run sets the database's path to list `pg_temp` last. The design
docblock had come unstuck from `applyShadowed` behind two helpers; moved. A
dead `href !== URL_` assertion went. [7], [9] and [11] share one `migrate`,
the fixture gained `accept()` for the five spellings of an acceptance row, and
`build()` uses `resetSchema`. **Weighed and declined:** rewriting 021's
`FROM thought_work_claims c` in the substituted text to a filtered subquery,
which would remove the view, the two probes, the search-path strip and the
TEMP refusal. The template's placeholders are declared in the file; a
run-time rewrite of a hashed statement's text is an invisible edit to a file
the repo says is never edited, and the migrator would then be running a body
no reader of the file can see. The view leaves the text intact and changes
only what a name resolves to, which Postgres supports by design; the catalog
machinery is the price of that honesty.

**Not done here.** 030's header describes the gate it was written beside; the
file is applied and hashed, so the description stands as history, and this
section and README §5 carry the current shape. A plain run applying 021 alone
over a later schema (a ledger hole) still puts 021's `upsert_thought` body over
022's and 025's — preflight's `atomic capture` names that state and
`--reapply`, and [7] now shows the re-run restoring it (SMD-1434 holds the
plain run's judgement of a ledger hole).

**Boyscout.** What the passes cut for space, in the files this change touched,
no behaviour changed: `applyShadowed`'s docblock states the mechanism and
points here for the passes, rather than carrying three of them; the fixture
spells the claim keys with `reembedKey()`, the function that owns the shape;
[7]'s column probe is `column()`, defined once before its first use.

Verified: `test-upgrade` [7] plants the suffixed-key acceptance and the own-key
acceptance over a thought written since its enqueue *before* the re-run, and
asserts the run goes with no refusal, the six labels (`stub-embed`, NULL,
`earlier-model`, NULL, NULL, NULL), every acceptance standing, and the line
beside 021 — two thoughts labelled, the acceptances out of its sight, nothing
beside 030; that an exclusive lock on `ob1_config` fails the checks before the
run within their own timeout; then deletes 021's ledger row with 030 recorded,
plants a fifth acceptance under a suffixed key and a paste's mislabel from
before 021 over an own-key acceptance, and asserts a held lock on `thoughts`
fails the plain run's 021 within the run's 10 s with nothing recorded, that
the plain run then applies 021 — exit 0, 030 skipped as recorded, the line
saying zero labelled since every unlabelled thought's rows are acceptances,
the paste's label standing since 030 did not run, every other label as the
re-run left it, 021 recorded, the trigger enabled — and that a second
`--reapply` labels nothing at 021 while 030 at its own place takes the paste's
label back. [9] builds a brain through 020 with the same fixture and a
suffixed-key acceptance, baselines it, opens a hole at 021 and asserts the
plain run applies 021 with the column absent — two labelled, every
acceptance-only thought unknown — then rebuilds it, adds a fresh own-key
acceptance, opens holes at 021 and 030 both and asserts the ordinary upgrade
applies both with the column truly absent and leaves the rule's labels; and
that a role without TEMP is refused before anything runs, dry run included,
with the GRANT. The hazard refusals went with the gate; the rest of [7] and
all of [8] are unchanged. Not exercised: the loader's two refusals (a set
without 021, two files sharing a number), the checker's duplicate-number rule,
the 40P01 line, the shadow refusal (the view always shadows on the test role's
path), the stale-temp-relation refusal and the quoted comma in a search path.
[11]'s both-pending run lists `pg_temp` last on the database's path, so the
strip is exercised. `test-upgrade` 133/133,
`test-schema` 749/749, `test-preflight` 191/191 (main's 031 and 032 merged
in), `test-live` 419/419, `tsc` clean, fork checker PASS. Upstream status: **not
applicable** — the migrator and `reembed.ts` are the fork's (changes 11 and
29).

### 62. A capturing role's grants are documented and checked for the whole capture path, not `thoughts` alone — one list, a widened preflight check, and `migrate.ts --grant` (SMD-1226)

Every function this fork adds is `SECURITY INVOKER` (the policy 010, 012 and 015
state, and the default the capture writers in 005/007/008/022/025 rely on), so
the writes they make run as the connecting role — and since 007 they reach past
`thoughts`: a windowed capture INSERTs `thought_chunks` (and since 022 DELETEs
them on a re-capture the label does not vouch for), an edit with content replaces
those rows, and 008's trigger INSERTs `thought_audit` on every capture. A role
granted `SELECT, INSERT, UPDATE, DELETE ON thoughts` alone — exactly what the
getting-started guide's grant step gives — therefore captures **nothing** on a
self-hosted brain: its first windowed capture fails on `thought_chunks`, its
first capture of any kind on the audit trigger. Upstream never hit it because
Supabase's `service_role` holds default privileges on the public schema; the
non-Supabase path is where it bites. Found by change 58's (SMD-1175's) review
passes, when 022 added a DELETE to the 3-argument path and the privilege class
surfaced — the gap for the audit and chunk-insert writers predated it.

`db/config.mjs`'s `ROLE_GRANTS` is now the single spelling: the tables and
privileges the fork's writers need, grouped by role (`capture`, `server`, `worker`,
`extraction`), each naming the migration that introduced it. Three consumers read
it, so none can drift from the others:

* Preflight's **`write privileges`** check (renamed from `chunk delete privilege`,
  which checked DELETE on `thought_chunks` alone) reads `CAPTURE_WRITES` — the
  `capture` group flattened — and refuses a server role missing any of it,
  naming each missing privilege in `ROLE_GRANTS` order with its GRANT (quoted
  role, schema-qualified `has_table_privilege`, gated on table presence so a
  brain before 007/008 is a skip not a raise). It stays a refusal: a role that
  cannot INSERT `thought_audit` fails every capture. One conditional addition
  (found by the second and third review passes): 016 adds a trigger on `thoughts`
  that runs as the caller on every capture and content-edit — it reads
  `ob1_config` always, and upserts a `thought_work_claims` row while
  `entity_extraction_key` is set. So the check reads `pg_trigger`: when the
  trigger is present it folds `ob1_config` SELECT into the refusal set (a role
  without it fails every capture in the trigger, even with extraction off), and
  when the key is set it adds `thought_work_claims` INSERT/UPDATE too. A server
  role that never runs a worker is thus refused at start-up on an extraction
  brain instead of being blessed and then failing every capture. The `server`
  group
  (`ob1_config` read, and the agent tables — `resolve_agent` is SECURITY INVOKER
  and *upserts* them, so they get the writes, not just `SELECT`, which the
  ticket's own list had wrong) is documented and granted but not enforced:
  attribution and preflight's config read degrade to a warn without it, not a
  failed capture. Over PostgREST it is a skip, as the old check
  was: table privileges are read over a direct connection.
* **`migrate.ts --grant <role>`** issues the whole documented set — `USAGE ON
  SCHEMA public` plus every group, for the tables that exist — in one
  transaction. Guarded like `--baseline`: it records nothing in the ledger and is
  refused beside `--baseline`/`--reapply`. It never creates a role or sets a
  password (a missing role is an error naming `CREATE ROLE`), so no credential
  passes through it; `--grant --dry-run` prints the statements for a role you
  would rather grant by hand. There are no sequences to grant — every table's
  primary key is a `uuid` or a natural key.
* **`db/README.md`**'s "Grants for a capturing role" is the human table, and the
  getting-started guide's grant step points a self-hoster at it. A
  check-fork-consistency check (the config↔docs parity check beside change 58's
  check 7) asserts the README names every table `ROLE_GRANTS` requires, in
  backticks, so a table added to a group in config without a README line fails
  CI rather than a self-hoster's first capture.

No schema, migration or runtime-server change — a documentation, preflight and
migrator change. `test-preflight.ts [5]` proves it end to end: a role with
`thoughts` and `SELECT` everywhere is refused, each missing write named with its
GRANT; after `migrate.ts --grant` a real windowed capture and an edit with
content run through the role, its chunk and audit rows landing.

Upstream status: **not applicable** — a self-hosting concern the Supabase path
does not have. **Unfiled** upstream. Reproduce: on a migrated brain, `CREATE ROLE
r LOGIN; GRANT SELECT, INSERT, UPDATE, DELETE ON thoughts TO r; GRANT SELECT ON
ALL TABLES IN SCHEMA public TO r;` then run preflight as `r` (refused, naming the
chunk and audit writes), `bun db/migrate.ts --grant r` (granted), preflight again
(ok), and a windowed `upsert_thought` through `r`.

### 63. A capture takes the fingerprint lock too — migration 033 redefines both inserting `upsert_thought` forms, so writers of one text are serialised whichever function they come through (SMD-1043)

Change 33 serialised `update_thought` calls that would take a fingerprint key on
an advisory lock, so two edits into the same text get `DUPLICATE_CONTENT`
instead of racing to the unique index — and scoped the claim honestly: the lock
covered edits only. `upsert_thought` wrote fingerprints without it, so a capture
of text X committing while an edit to X sat between its lookup and its UPDATE
still raised `duplicate key value violates unique constraint
"idx_thoughts_fingerprint"` — at the MCP boundary as `update_thought failed:
…`, in `reembed.ts` as a failed claim whose remedy was `--retry-failed`. Six
disclaimers said so (018's header and COMMENT, `db/README.md`, `reembed.ts`
twice, change 33), and SMD-1022's second review pass ticketed the fix rather
than fold in a redefinition of two capture overloads. Change 40 then named two
more shapes its row lock could not cover — two first captures of one text
racing, and an edit moving another row onto a text as it is captured — where
the capture's label read found no row and left a re-capture's windows as they
were; change 60 a third, a re-capture filling a NULL `supersedes` pointer
without the supersession lock. Four symptoms, one fact: the capture path took
no lock a concurrent writer of the same text also takes.

**Migration 033.** Both inserting overloads — the 2-argument body from 005, the
3-argument body from 025; 013's 4-argument form delegates to the latter and is
not redefined — take `pg_advisory_xact_lock(hashtextextended(v_fingerprint,
0))` before anything reads or writes the row the text lands on: before 022's
`FOR NO KEY UPDATE` label read in the 3-argument form, before the INSERT in
both. Spelled exactly as 018 spells it, so the same key is the same lock —
`test-schema` [33] holds the three bodies to one string rather than a
`lock_fingerprint(text)` helper, which the ticket floated and which would have
meant redefining `update_thought` a third time to call it. Four more things
ride the redefinition, three of them a rule that already had one owner
elsewhere:

- **`update_thought` takes the fingerprint lock before its row.** Whenever
  content arrives, not after the row read and only when the row does not
  already own the key, as 018 wrote — the first review pass's finding, below.
  018's shortcut stays for the second hash and the lookup; only the lock is
  unconditional and early. 032's body otherwise verbatim under 032's
  signature, with 032's DROP-and-replay of the 8- and 7-argument forms
  carried so a hand re-apply of 021 or 018 is undone by the last definer.
- **The supersession lock, first.** When the envelope names `supersedes`, the
  3-argument form takes 029's `hashtext('ob1:supersession-review')` before the
  fingerprint lock, so a re-capture filling a NULL pointer is ordered against
  `update_thought`'s cycle walk and the review path's write (change 60's
  carry-forward). Until change 66: migration 035 drops the fill and, with it,
  this lock from the capture path — 033's "what a successor must carry" list
  is superseded by 035's.
- **One copy of each rule.** `derived_from` is validated through 032's
  `validate_derived_from` — 025's inline copy is gone, and the refusals lose
  their `upsert_thought:` prefix — and both forms hash through 016's
  `content_fingerprint_of`, the last two inline copies of 003's rule.
- **The 2-argument form attributes.** It reads `p_payload.actor` into
  `ob1.actor` as the 3-argument form has since 008. It never did — 008
  redefined only the 3-argument body — so a capture through PostgREST's
  two-step fallback, the one caller of this form, wrote an unattributed audit
  row. The one thing here that is not a lock; `test-upgrade` [12] shows the
  NULL actor at 032 and the name at 033.

**Lock order.** Every writer of `thoughts` now acquires in one order —
supersession lock, fingerprint lock, row — or a suffix of it, and takes at most
one lock of each class. A capture naming `supersedes`: supersession →
fingerprint → the row the text lands on (until change 66: fingerprint → row,
like a capture without). A capture without: fingerprint → row.
`update_thought` with content: supersession (when named) → fingerprint → the
edited row; without content: supersession → row. The review path: the proposal
row `FOR UPDATE` → supersession → the superseding row → `update_thought`
without content, re-entrant on both. The FK check a `supersedes` write makes
takes `KEY SHARE` on the target last, which does not conflict with `FOR NO KEY
UPDATE` (change 60), and the capture's row lock is `FOR NO KEY UPDATE` (022),
so the foreign keys never enter a cycle among these. One total order, one lock
per class per transaction: no two of these writers can each hold what the
other waits for. Outside the order: `delete_thought`, below. 023's `LOCK TABLE
… IN EXCLUSIVE MODE` is a table lock,
ordered against every INSERT and row lock and not against an advisory lock,
and the backfill takes none, so the two cannot deadlock either — the review
pass ran that three-way as well. READ COMMITTED throughout, as 018 and 023
already require: the waiter's read runs after the holder's commit and sees its
row, which is exactly where 022 said the lock was needed for its rule to
apply.

**A first review pass, triaged: two fixes, three tidy-ups.** The first version
of this change left `update_thought` at 018's order — row, then the fingerprint
lock, and only when the row did not own the key — and argued the capture's
fingerprint → row could not cross it: the row a capture waits for under the
lock for X is the row that *owns* X, and an edit of that row into X skips the
lock. True of any two transactions, and the pass reproduced a cycle of four
against a real server: R owns Y and R′ owns X; edit(R → X) holds R and waits on
the lock for X; capture(X) holds that lock and waits on R′ for its label read;
edit(R′ → Y) holds R′ and waits on the lock for Y; capture(Y) holds that lock
and waits on R. Two edits swapping two rows' texts while both texts are
re-captured, all inside one statement's duration — rare, but a hard cycle
Postgres breaks with 40P01 in one of the four, and before this change nothing
could deadlock at all, since the captures held no lock. Rather than state a
residue, the edit's order moved: `update_thought` takes the fingerprint lock
first whenever content arrives, so every writer's order is the same and there
is nothing left to cross; `test-live` [6f] runs the four by hand in 018's order
and gets the deadlock, then through the shipped functions and does not. The
other fix was numbering: PR #40 had merged meanwhile and taken change 61 and
`test-upgrade` [11], so this is 62 and [12]. The tidy-ups: 032's
`COMMENT ON FUNCTION validate_derived_from` still said `upsert_thought` carried
the rule inline, and is re-issued here; preflight's "025 re-applied by hand puts
it back" is the wrong cause on the brain every operator has the morning of the
upgrade — 033 pending, not re-applied — so the parenthetical follows the
ledger; and a [33] assertion that read the last definer from the *files* to
"prove" a catalog state now reads `pg_proc`.

**A second pass, triaged: the stop signal, one residue named, two lines.** Its
top finding was in the first pass's prose, not its code: the new proof said
*every* writer of `thoughts` is in the order, and `delete_thought` is not. 009's
DELETE holds the thought `FOR UPDATE` while 029's `ON DELETE CASCADE` reaches
the proposals that name it; an acceptance locks the proposal row first (029's
order, which the first pass's list also left out), then the supersession lock,
the superseding row, and asks `KEY SHARE` on the thought being deleted. Two
shipped functions, a cycle of two — reproduced 23 times in 40 against a real
server, the delete the victim each time; a plain edit naming `supersedes`
against the same delete 0 in 40 (0 in 60 on the third pass — and not, as
this paragraph first said, because it holds no proposal row: the delete's SET
NULL cascade does wait on the edited row, and no cycle forms because the FK
check takes `KEY SHARE` on the target only when the pointer *changes*, and a
changed pointer names another row than the one being deleted). Pre-existing
since 029/032 and not this change's to fix — the fix is a `delete_thought`
that takes the supersession lock first, **SMD-1462**, which also carries the
smaller thing the probe saw (a target deleted between `update_thought`'s walk
and its UPDATE surfaces as 23503, not `SUPERSEDES_NOT_FOUND` as 032's COMMENT
promises). The proof is scoped to the writers it names, here and in the
header; the review path's order is stated with the proposal row first; and
§60's pointer to this change said 61. Everything the first pass added — the
moved lock (the two bodies diffed mechanically: one block moved, nothing else),
the carried DROP block (032's identical first `WHEN`, so an existing 9-argument
form's ACL is never touched), [6f]'s waits, `pre033()`'s three branches — was
verified and held.

**Closed, and not.** Closed: a capture racing an edit to the same text (the edit
is told, not refused); two first captures of one text (the second finds the
first's row and 022's rule decides its windows); an edit moving a row onto a
text as it is captured (likewise); a capture filling a NULL pointer while an
edit walks the chain (ordered now). Not closed, and stated in the header: a
re-capture filling a NULL `supersedes` pointer is not *walked* for a loop — R
with no pointer, X superseding R, then R's text captured naming X, one after
another with no race, writes R → X → R. 025's "add if empty" never walked; the
lock orders the fill against the walk, it does not add one. `trace_provenance`
is cycle-guarded, so the cost is two rows both labelled superseded; [33] writes
the loop and shows `update_thought`'s walk seeing it (as of this change; since
change 66 that case is [35]'s and asserts the reverse), and **SMD-1453** holds
whether the fill should walk, refuse, or go — change 60's envelope makes "go"
possible (gone, in change 66: migration 035 drops the fill, and with it the
supersession lock from the capture path). Also unchanged on purpose: 022's
"unknown vouches for nothing" for a caller sending a vector and no label
(SMD-1245's question), and the 2-argument
form's silence on `derived_from` / `supersedes`.

**The sentinel, and the preflight.** Both bodies carry
`ob1:capture-takes-fingerprint-lock` (014's convention). `atomic capture` reads
it over a direct connection beside 022's sentinel and 025's clause, so the
warning now grades a stale 3-argument body four ways — before 022, before 025,
before 033, or missing (five, with before 035, since change 66) — and a stale
2-argument body two ways — before 005 (no guard) or before 033 (005's guard,
no lock) — and the remedy is one file in every case, since 033 is the last
definer of both forms (035 since change 66); the "apply 005, then 025 again"
two-step is gone. `test-preflight` walks 021, 022, 025, 003 and 005 re-applied
by hand over 033 (over 035, with 033 in the walk, since change 66) and asserts
each warning's text and its one remedy.

**Where the disclaimers went.** 018's file is applied and hashed by the ledger,
so its header and COMMENT stay as written and 033 re-issues the COMMENT on
`update_thought` without the clause; `db/README.md`'s 018 row and re-embed
paragraph, `reembed.ts`'s header and its `processRow` comment now say what is
true (a load that inserted the text around `upsert_thought` can still raise
the violation; a capture cannot), and change 33 above carries a note.

**Cost.** One advisory lock acquire per capture — a shared-memory hash entry, no
I/O. Measured at the shipped width (1,024 dimensions), 2,000 operations per
line, four arms in alternating order — 032, 033, 032, 033 — each on a fresh
schema, so the table and the HNSW index grow the same way inside every arm (a
first version ran the rounds on one growing table, and every later round was
slower whatever the body: the index, not the lock). The first arm was the cold
container and is discarded (5.2 ms for a 2-argument capture that costs 0.4–0.8
ms warm). Warm, per operation: fresh 2-argument capture 0.80 ms at 032, 0.39
and 0.68 ms at 033; fresh 3-argument capture with a vector 5.8 ms at 032, 5.0
and 5.7 ms at 033 (the HNSW insert is the cost); re-capture without a vector
2.3–2.7 ms at 032, 2.0–3.0 ms at 033; re-capture with a vector at the same
label 2.2–2.6 ms at 032, 2.2–3.4 ms at 033. Inside the run-to-run spread on
every line, on either side of it. One cost is a ceiling rather than a
per-operation figure, and the third pass measured it: a capture *naming*
`supersedes` holds the one brain-wide supersession key from before its label
read to commit, HNSW insert included, so such captures have no parallelism
among themselves — 200 concurrent at 1,024 dimensions took 1,388 ms, 6.9 ms
each, exactly the serial per-call cost; 50 concurrent ran 3.4–4.4× slower than
the same 50 without `supersedes`. About 145 pointer-naming captures a second at
the shipped width, whatever the worker count; a consolidation or import
pipeline that writes pointers is bounded by it. A fresh row cannot close a
loop — only the ON CONFLICT fill can — but which a capture is becomes known
only under the fingerprint lock, and the supersession lock must precede that
one, so the lock cannot be narrowed without changing the fill; SMD-1453 holds
that question together with the fill's (answered in change 66: the fill goes,
the lock with it, and 200 concurrent pointer-naming captures take what 200
plain ones do).

**A third pass, at the user's call, run rather than read: two documentation
findings, nothing that fails.** The migrator applied 033 onto a populated
032-ledger brain (one applied, bodies and ledger sha right, no row or audit row
moved), `--reapply` re-ran all thirty-three in one transaction and left
`update_thought` one function with the lock before its row, `--dry-run` saw
nothing pending and no drift; preflight on the day-of-upgrade brain said
"migration 033 is not yet applied" from the ledger branch the fixture cannot
reach, and "025 re-applied by hand puts it back" once the ledger recorded 033;
twenty concurrent captures of one text with twenty concurrent edits into it
through the SQL store gave one row, twenty merged keys, twenty
`DUPLICATE_CONTENT`s, nothing thrown; twenty two-argument captures audited
twenty distinct actors; `reembed.ts` over thirty raw legacy-twin pairs with
four workers finished with no failed claim and thirty `duplicate_of` groups;
sixty raced delete-versus-edit pairs gave no 40P01 (the accept-versus-delete
control gave 14 of 20, SMD-1462 as stated). The two findings are above: the
serialisation ceiling the Cost section omitted, and the wrong "why" in the
second pass's residue sentence.

**Verified.** `test-schema` [33] (791): three overloads and one
`update_thought`, the lock spelled once across the three bodies, the
acquisition order read by position in the source (supersession, fingerprint,
the label read, the INSERT; supersession, fingerprint, the row in
`update_thought`), no inline copy of either rule left, every earlier piece by
name, a 2-argument capture attributed, no advisory lock held after a call, the
residue loop written and seen by the walk (as of this change — [35] holds the
reverse since change 66), and the trap — 025 re-applied puts
an unlocked 3-argument body back, 005 both, 032 puts 018's order back in
`update_thought`, 033 restores all three; [22], [23], [31] follow the last
definer. `test-live` [6f] (479): the four-way, by hand in 018's order to the
deadlock, then through the shipped functions to two `DUPLICATE_CONTENT`s with
both edits holding nothing while they wait. [6e]: a 2-argument capture of X held open
while an edit of another row into X waits on the *advisory* lock in `pg_locks`
and is told `DUPLICATE_CONTENT` when the capture commits, one row holding X; a
first 4-argument capture with a window held open while a chunkless re-capture
waits on the same lock, the window kept at the same label and gone at another;
a capture naming `supersedes` waiting on the supersession lock while one
naming none is not (as of this change; arm 3 asserts the reverse since change
66). `test-upgrade` [12] (147): 033 onto a populated 032 — no
column, signature, row, window or audit row moves, the 3-argument form's
hardened ACL is kept across `CREATE OR REPLACE`, `update_thought` one function
with the lock before its row where 032's had it after, a same-model re-capture
keeps its window and pointer, the 2-argument form resolves and attributes, a
re-run is a no-op. `test-preflight` (192), both store suites, `test-e2e-sql`,
`test-update-delete`, `test-audit`, `tsc`, the consistency checker.

Upstream status: **not applicable** — upstream's `upsert_thought` (the
getting-started guide's, and the fingerprint recipe's) has no fingerprint lock
in either function, and upstream has no `update_thought` that takes one.

### 64. The vendored extensions authenticate the way the core server does — named, scoped, hashed keys through `server-portable/auth.ts`, a read-scoped key never given the tools that write, and check 8 refuses a credential compared with `===` (SMD-1252)

`server-portable/auth.ts`, `server-portable/index.ts`, the seven extension
servers (`extensions/family-calendar`, `home-maintenance`,
`household-knowledge`, `job-hunt`, `meal-planning` — `index.ts` and
`shared-server.ts` — and `professional-crm`), their `.env.example`s,
`extensions/_shared/auth.ts`, `extensions/_template/AGENT_SPEC.md`,
`extensions/README.md`, `extensions/test-auth.ts`, `extensions/package.json`,
`extensions/bun.lock`, the READMEs of `home-maintenance`,
`household-knowledge`, `meal-planning` and `professional-crm`,
`server-portable/README.md`, `server-portable/keygen.ts`,
`primitives/deploy-edge-function/README.md`, `primitives/shared-mcp/README.md`,
`primitives/remote-mcp/README.md`, `primitives/troubleshooting/README.md`,
`scripts/check-fork-consistency.mjs` and `.github/workflows/fork-checks.yml`
(Linear SMD-1252, filed by the 2026-09 upstream survey). No migration.

**The finding.** Fix 14 gave the core server named, scoped, SHA-256-hashed
access keys, timing-safe comparison, revocation one key at a time, and a
read-scoped key for which `capture_thought` is never registered. None of it
reached the extensions the curated learning path tells a user to deploy. Seven
servers carried the same two lines — `const expected =
Deno.env.get("MCP_ACCESS_KEY"); if (!key || key !== expected)` — and then ran
as the service role: one shared plaintext secret, compared byte by byte, no
scope, no revocation short of re-keying every client, and full write access on
a key accepted from a URL query string, the form Claude Desktop's connectors
need and the form that lands in access logs and browser history. They were
weaker than the core server was before fix 14, under the repository whose one
loudest claim is the hardened auth path.

**Adopt, not delete.** The ticket offered three postures and asked that the
third — leave them — be rejected explicitly. Deleting the extensions was
arguable: they are upstream's teaching path and they still read their
environment through `Deno.env`. But fix 13 had already migrated five of the
seven onto the SQL shim by a relative import into the fork's tree, so the
extensions are already the fork's to keep working, and the same relative
import is all "adopt" costs. Each of the seven now imports
`authenticateRequest` and `canWrite` from `../_shared/auth.ts`, reads
`MCP_ACCESS_KEYS` beside the legacy `MCP_ACCESS_KEY` (the shared meal-planning
server its own `MCP_HOUSEHOLD_ACCESS_KEYS` / `MCP_HOUSEHOLD_ACCESS_KEY`), and
answers 401 with no principal. `extensions/_shared/auth.ts` is
`server-portable/auth.ts` **byte for byte** — a copy, not a re-export, because
a Supabase Edge Function is bundled from `supabase/functions/` and `_shared/`
beside the function is the one place a shared module can live; the deploy
primitive's Step 2 downloads it once for every extension. The fork's recurring
defect is a value defined twice, so the test fails the moment the two files
differ, and the module was made runtime-neutral in the one place it was not —
`Buffer` is imported from `node:buffer` rather than assumed a global — so the
copy runs on Deno as it is. Seven copies of the compare became one consumer
each of the tested path, and the legacy key, still accepted, is compared by
digest now.

**The tools that write are gated, not refused.** As `index.ts` registers
`capture_thought` only `if (canWrite(principal))`, each extension builds its
`McpServer` per request and registers each tool that inserts, updates,
upserts or deletes only for a write-scoped principal — twenty-four of the
forty-five tools across the seven servers, classified by what each body (or,
in `job-hunt`, its handler) does to the database, not by its name
(`generate_shopping_list` writes; `crm_search_contacts` calls an RPC that
reads). A read-scoped key does not see them in `tools/list`, and a call names
a tool that does not exist (`-32602`), before any handler runs. The shared
meal-planning server's `mark_item_purchased` is gated too, and its README says
to mint the household member's key read-scoped unless they should check items
off — the scope is the decision, made where the key is minted.

**Where the key may travel is spelled once.** `auth.ts` gains
`presentedKeys(req)` — `x-brain-key` (the core server's header),
`x-access-key` (the extensions'), `?key=`, `Authorization: Bearer` — and
`authenticateRequest(req, cfg)`, the first presented key that **authenticates**.
Every form, not the first present: a gateway with "verify JWT" on, the Supabase
SDK and `mcp-remote --header` each put a token of their own in `Authorization`
beside the `?key=` the client means, and the first version of this change
(which took the first form present, bearer ahead of the query) would have
hashed the gateway's token and refused the request — the extensions read
`?key=` first before, so that was a regression, and the review pass caught it.
`index.ts` reads through the same function, so the core server now also
accepts the extensions' header and a bearer token, and its CORS preflight
allows `x-access-key`; the two primitives that told a user the two servers
wanted different headers "to avoid confusion" say instead that this fork's
server and the extensions take any of the forms, and that `server/index.ts`,
upstream's Edge Function the getting-started guide deploys, still takes
`x-brain-key` or `?key=` alone.

**What a user is told.** The deploy primitive's Step 3 mints a key — `bun
keygen.ts` from the checkout, or `openssl rand -hex 32` and `shasum -a 256` by
hand, with a PowerShell equivalent that runs on 5.1 — and sets the **hash** as
`MCP_ACCESS_KEYS=name:scope:hash`, the key going only into the connector URL;
the legacy secret is named as still working and as the thing to move off. The
troubleshooting primitive's 401 entry knows about a hash pasted where the key
goes and a read-scoped key that "cannot see" a tool. `extensions/README.md`
gains an "Access Keys" section; each `.env.example` shows the new form with the
old one commented; the extension template (`_template/AGENT_SPEC.md`) and the
shared-server primitive's sample — the two files the next extension is copied
from — build the server per principal and never compare a key themselves.

**The test.** `extensions/test-auth.ts` imports the seven servers **as
deployed**, under a stand-in for the two Deno globals they use: `Deno.env.get`
hands the process environment through and `Deno.serve` captures the fetch
handler instead of listening. No database — the SQL shim and supabase-js both
connect lazily and nothing here reaches a tool that queries (each server's
client is built per request, so the test sets the URL shape that server's
client accepts per request too). For each server it
makes the assertions `server-portable/test-auth.ts` makes for the core: a
write-scoped key sees every tool; a read-scoped key sees exactly the reads and
each write is absent, not refused; a read-scoped call of a write tool is told
the tool does not exist; a wrong key, no key, and the **hash** are refused
with 401; the write key removed from `MCP_ACCESS_KEYS` stops working while the
read key keeps working; the legacy single key authenticates as write and a
wrong one is refused; no keys configured refuses everything. Then, once, the
four forms a key may travel in, a gateway's bearer token beside a right
`?key=` and a stale `x-brain-key` beside a right `x-access-key` (neither
shadows the key the client means), three wrong forms refused as one, and the
unauthenticated GET health check. Then the drift guards: `_shared/auth.ts`
is byte for byte `server-portable/auth.ts`; every `server.tool(` a file
registers is classified in the test's table, exactly the writes are gated,
each write's body or handler does write and each read's does not, the key is
read through the shared module and the old `c.req.query("key")` /
`x-access-key` spelling is gone, and each extension's `deno.json` exists and
pins what `extensions/package.json` installs (one set of versions, six
identical copies, the same versions `server-portable` pins). That
`package.json` is test-only; `bun install` puts `node_modules` under
`extensions/`, which `contributionDirs()` now skips as it skips `_template`
and `_shared` — a gitignored install and the shared module are not
contributions. The test runs in CI inside the "Portable server" job — one of
the nine checks `main`'s ruleset requires, so a red run blocks a merge; a job
of its own, as the first version had, would not have — and the `deno check`
job now also checks the two extensions Deno can resolve (`family-calendar`
and `job-hunt`, still on supabase-js) as deployed, through
`../_shared/auth.ts`. 243 assertions.

**Check 8 holds the line.** `scripts/check-fork-consistency.mjs` gains the
third rule under "Vendored content" above: a value read from the environment
under a credential's name (`…KEY`, `…SECRET`, `…TOKEN`, `…PASSWORD`) is never
compared with an equality operator — strict or loose, on either side, read
inline in any wrapping (`!== Deno.env.get("MCP_ACCESS_KEY")`, `!==
(Deno.env.get(…) ?? "")`, `Deno.env.get(…)!.trim() ===`) or through an
identifier the file binds from a statement containing such a read (`const
expected = Deno.env.get(…)`, `const KEY = String(process.env.KEY ?? "").trim()`,
`expected ??= …`, `const { API_TOKEN } = process.env`, `const { API_TOKEN:
expected } = process.env`, Python's `os.environ`), the bound name bare or
wrapped (`expected.trim()`, `String(expected)`, `(expected ?? "")`), the read
spelled `Deno.env.get`, `process.env`, `Bun.env`, Hono's `c.env`,
`import.meta.env`, a bare `env(…)`/`env.X` or `os.environ` — in every non-binary,
non-ignored file under the seven category
directories and `docs/`, prose included, since a README's code block is what
the next extension is copied from. Not a compare of the credential: `.length`
(a timing-safe compare guards its lengths first), a call or an index on it,
`typeof`, or a literal on the other side — nullish or empty (`if (KEY ===
undefined)` is a presence check) or a string (`if (KEY === "your-key-here")` is
a placeholder check, a different smell). A name bound from a credential read
is the credential for the **whole file**: every compare of it counts, wherever
it sits. That is a decision, not an oversight — three passes tried to except a
re-declared name (a loop variable, a parameter, a destructure), and each found
the previous pass's scoping both silencing real compares and failing ordinary
code; the fourth pass took the altitude, below. `key`, `token` and `secret`
are common names and the vendored tree binds each from the environment
somewhere, so an upstream rebase can trip this on an ordinary loop — in the
open, answered with a rename or a counted exception; a miss would be silent.
Outside the rule, and the header
says so: `.includes`, `Object.is`, `switch`, `.localeCompare`, a compare
through a class field or an object property, a helper that returns the key,
several declarators on one statement, a read through `Deno.env.toObject()`
into a variable. Forty-seven probes the rule must catch — every line of a
probe that carries a compare, so a two-route probe is two catches — and
twenty-one it must not run on every invocation, through the same function
the scan uses. Its first run found the
mechanism in **seventeen
more vendored files** — ten MCP servers with the extensions' exact shape
(`ob-graph`, `work-operating-model-activation`, `delete-thought-mcp`,
`update-thought-mcp`, `kubernetes-deployment`, `entity-extraction-worker`, the
two consolidation workers, `agent-memory-api`, `open-brain-rest`), the
editorial-policy auditor and a walkthrough's screenshot stub under other
names, three webhook-secret echoes (Readwise's in the body, Telegram's header
in a recipe and a README), and both halves of the edge-function-cost recipe's
before/after teaching pair — and each is listed in
`CREDENTIAL_COMPARE_EXCEPTIONS` for exactly the one line it has today, with
SMD-1455 as the reason. One fixed drops out as stale and fails until its entry
is removed; one added beside it fails. The ticket's verify grep —
`req.query("key")` under `extensions/`, `recipes/`, `integrations/` — returns
three results, all in files SMD-1455 names.

**What did not change, and why.** The extensions still answer a bare HTTP 401
where the core server answers a JSON-RPC `-32001` envelope for the strict
hosts that tear a connection down on 4xx (change 1); that envelope's helpers
live in `index.ts`, the ticket asked for scopes, hashing and revocation, and
moving the envelope is a second mechanism. Revocation here is a line removed
from `MCP_ACCESS_KEYS`, which is what fix 14 meant by it; the registry-level
revocation change 23 added (`ob1_agents`) runs through the core server's store
and is not reached from an extension's own client. The extensions still read
their environment through `Deno.env` and end in `Deno.serve`, as fix 13 left
them — the test stands in for both rather than porting the files further from
upstream. The deploy primitive still downloads `index.ts` from upstream's
`main` by raw URL — and the first review pass's `_shared/auth.ts` download
pointed there too, where the file does not exist (a 404 body would have been
written over the module, and the `index.ts` fetched beside it was upstream's,
reading a secret Step 3 now tells the user not to set). The primitive
downloads from this fork's `main` now, all twelve URLs — the update section
refetches the pins and the shared module beside the server, since a server
may start using something the module gained — and says which two extensions
deploy by it: `family-calendar` and `job-hunt`, still on supabase-js. The
other four import the SQL shim, which imports `bun`, while still reading
`Deno.env`: as they stand they neither bundle as an Edge Function nor run
under Bun, which is fix 13's consequence and now SMD-1480's ticket; the
primitive's list, its Step 2 and the four READMEs' five deployment tables say so
rather than leaving a reader to discover it at `supabase functions deploy`.
The module is a `_shared/` copy the recipe downloads, not an import across the
tree the bundle cannot follow, so those two stay deployable.
`server/index.ts`, upstream's Edge Function, keeps its own compare: it is
outside the seven directories, outside the vendored-tree standard, and the
fork's hardened server is `server-portable/`.

**Review, first pass** (triaged; eleven findings, ten taken, one folded in).
The precedence defect above; the `_shared/` copy above, where the first
version imported `../../server-portable/auth.ts` and would have failed
`supabase functions deploy` for all seven; the two primitives' claim that the
"core server" takes either header, when the core server the getting-started
guide deploys is `server/index.ts`; check 8's destructure branch, which bound
the *env* name of a renamed destructure and so missed `const { MCP_ACCESS_KEY:
expected } = process.env` while the header claimed the form; the six spellings
the pass probed past the rule (`c.env`, `Bun.env`, a wrapped read, `String(…)`,
`??=`, a wrapped inline compare), all caught now with probes; a string literal
on the far side flagging a placeholder check; the test's per-server URL shape
that every request ignored (the client is built per request, so the last
server's shape governed all seven — supabase-js happened to accept a
`postgres://` URL); the core server's CORS preflight not allowing the header
the docs now say it takes; `deno.json` missing aborting the run instead of
failing an assertion; and the nit that `vercel-neon-telegram/src/lib/auth.ts`
already compares timing-safe too. Folded in: `sha256sum` beside `shasum` in
the by-hand recipe. Verified true and not reported: the 24/45 split, the
`-32602` shape, the Accept patch's interaction with `c.req.raw`, and that a
*registered* write tool called with `{}` answers "Invalid arguments", so the
read-key call assertion discriminates.

**Review, second pass** (triaged; nine findings, all taken). The download
URL above — the one defect, since a user following the primitive would have
ended at 401 with a 404 body for a module. The extensions' test ran in a CI
job of its own, which `main`'s ruleset does not require, so the only thing
exercising five of the seven servers could go red and a merge still land; it
runs inside the required "Portable server" job now. Check 8 bound a name
file-wide, so an upstream rebase adding `for (const token of tokens)` to a file
that reads `GITHUB_TOKEN` would have failed CI with a message about a
credential compare — a name declared again between binding and compare is
another variable then, with the three shadow shapes as non-probes and a
compare-before-shadow as a probe (the third pass found that rule too broad,
the fourth removed it — below). The same pass probed wrappers the rule
accepted on an inline read but not on a bound name (`expected.trim()`,
`String(expected)`, `(expected ?? "")`), template quotes in the read,
`import.meta.env`, and a suffixed name (`MCP_ACCESS_KEY_V2`) — all caught now;
the spellings it does not chase are listed in the header rather than implied
by "mechanism". The test's write detector knew the four table verbs and not
`.rpc(`, so a tool writing through a stored function, classified as a read,
would have passed "does not write" — an RPC is a write unless named in
`RPC_READS` (`crm_search_contacts_fts` is the one). The test never sent a
request without an `Accept` header, so the six servers' patch of `c.req.raw`
ahead of the key read ran in production and never in CI; it does now, with a
right key and a wrong one. And three doc nits: `cd server-portable && bun
keygen.ts` given to a reader standing in their Supabase project folder (a
subshell into the checkout now, in both primitives); the household-member
prose promising "check off grocery items" beside advice to mint that member a
read-scoped key (the promise is conditioned on the scope now, in both files);
`enhanced-mcp` compares through `crypto.subtle.timingSafeEqual` first, the XOR
loop is its fallback. Verified sound by the pass and not reported: the bearer
regex, dedup and empty-drop; the legacy path with an empty key list and with
both forms set; `?key=` decoding unchanged from Hono's `query()`; all
twenty-four writes gated and every read free of writes; env isolation between
the six and the shared server; `.gitignore`, the lockfile and `--frozen-lockfile`.

**Review, third pass** (triaged; ten findings, all taken, one ticket filed).
Main had moved — SMD-1226 landed as change 62 — so this section is 63 after a
merge, and the number is spelled in fourteen lines of twelve files outside
this one (the seven server headers, both copies of the auth module — byte
identity held — the checker's three, the test, the test's `package.json`).
The second pass's shadow
rule silenced real compares: it took any redeclaration anywhere between the
file's *first* `N =` and the compare, so an arrow parameter in another
function, a loop whose block had closed, a `let` above the credential binding
and a second binding of the same name in a second route each hid the
extensions' exact original shape. The pass rewrote the rule — bindings by
position, the nearest preceding one governing, a shadow governing only while
its block was open by a brace walk — with six probes for the misses, and the
probe check asks that every compare line be caught rather than any (the
fourth pass then removed the shadow rule altogether — below). The deploy
primitive contradicted itself and four READMEs: its list and their five tables
still sent a reader to deploy servers that import `bun`, and "run from a
checkout" described nothing that works — SMD-1480 filed; callouts above each
table and in the primitive's list. Its update section refetched `index.ts`
alone, so a module change or a pin bump never reached a deployed function —
it fetches all three now. The CI `deno check` of the two extensions had never
run anywhere: Deno 2.9.6 turned out reachable through the npm launcher under
Bun (`bun ~/.bun/install/global/node_modules/deno/bin.cjs`), and both files
check clean as CI runs them. The test's write detector saw only a
double-quoted `.rpc("…")`; any `.rpc(` is a write now unless its literal is in
`RPC_READS`, and a tool's block is sliced from its registration rather than
the first place its name is quoted. Prose: the Step 2 callout split a sentence
from its code block; "a destructure" as a shadow shape covered only array
destructures (object ones count now); `server-portable/README.md`'s
configuration block named only the legacy secret; FORK and the header
disagreed on `env.X`. Verified sound by the pass and not reported: the copy
byte-identical; `?key=` surviving the rebuilt request in all six; the shared
server's env isolation; job-hunt's handler slicing; the workflow's step order.

**Review, fourth pass** (triaged; nine findings; the altitude taken). The
reviewer was asked to attack the shadow rule and broke it a third time, in
both directions: a braceless shadow (`for (…) if (…)`, `list.some((key) =>
…)`) governed to the end of the enclosing block and silenced every later
compare of the credential, including the extensions' exact original shape one
callback later; a `const`/destructure shadow, which opens no block, took the
next braced statement as its block and failed an ordinary function; a
for-header with braces in its iterable ended the scope before the body; a
compare textually above every binding could never consult a shadow; `key =>`
inside a string was a shadow, `{` inside a string a block. Every one of these
is scope, and scope in regex over unparsed text — README code blocks and
Python among the inputs — is not a thing to get right by another patch. So
the shadow rule is gone (both helpers and the position bookkeeping with it):
a name bound from a credential read is the credential for the whole file, the
five shadow non-probes became probes the rule must catch, and the header and
this section say why — a false positive fails CI in the open and is answered
with a rename or a counted exception, a miss is silent, and the vendored tree
had no hits under the whole-file rule when the second pass introduced the
exception for a hypothetical. The lesson is change 56's again: when
consecutive passes find seams in one mechanism, the mechanism is the finding.
Also taken: a ternary after the credential (`key === expected ? ok() :
deny()`) was excluded with `expected?.x` — only `?.` is an access now; a
binding broken over two lines (`const expected =\n  Deno.env.get(…)`) was not
a binding; the test's handler detection matched any `handle…` word in a
tool's block and is anchored on the `wrap(() => handleX(` call now. Stated
in the header as outside the rule rather than fixed: braces or `=>` inside a
string, comment or regex literal. Verified sound by the pass: the twelve
URLs, the fourteen renumbered places, the counts, the copy's identity, the
seven servers' diffs, `RPC_READS`, and that a missing registration fails two
assertions rather than aborting the run.

**Review, fifth pass** (triaged; ten findings, one defect — at the merge
boundary — nine gaps and nits, and none of the fourth pass's fixes among
them: the stop signal). Main had moved again — SMD-1043 landed as change 63
— so this section is 64 after a second merge, the number spelled in the same
fourteen lines. Check 8 did not read Hono's `env(c)` adapter form, the
canonical environment read for a Hono server on Workers or Deno — the stack
these servers use; it does, with two probes, and the header's "outside the
rule" list gained the three spellings the pass named (a read by a non-literal
name, a parenthesised bound name, a shell test) beside the string-literal
braces. The by-hand PowerShell recipe minted a 256-bit secret with
`Get-Random`, which Microsoft documents as not cryptographically secure; it
uses `RandomNumberGenerator` now, still on 5.1. `auth.ts`'s docblock — the
extensions' contract text now, in two copies — still said `capture_thought`
was the only tool that writes, three changes after `update_thought` and
`delete_thought` joined it, and `keygen.ts` said the same to every reader of
a read-scoped key; both name the set. The shared-server primitive's
troubleshooting still told a user to match the URL key against the secret,
which holds its hash. Two assertions asked only for a count where the sorted
list was already in hand; the drift guards recognise `server.registerTool(`,
the SDK's current name and the template's, so an eighth extension can join
the table. Recorded, not changed: where the whole-file rule will bite first on
a rebase — `recipes/entity-wiki/generate-wiki.mjs` and
`recipes/typed-edge-classifier/classify-edges.mjs` bind `key` from a
credential read and use it a dozen times each, the five
`integrations/*/_shared/helpers.ts` bind `apiKey`; an appended
`if (row.key === key)` fails CI in each, a `for (const key of keys) if (key
=== "id")` does not. Verified sound by the pass: the misses probed (`==`,
`!(a !== b)`, a template literal, Python's `getenv` with a default, `as
string`); all seventeen exceptions matching exactly the intended compare
line; the 24/45 split by every write verb; "Portable server" among the nine
required contexts; the lockfile version; the Step 3 hash matching Node's.

**Review, sixth pass** (at the maintainer's call, past the stop signal;
nothing above gap level). The reviewer ran rather than read: the deploy
layout the `_shared/` decision rests on, reproduced offline — `index.ts`,
`deno.json` and `_shared/auth.ts` copied where the primitive's Step 2 puts
them, and `deno check` resolves `../_shared/auth.ts` from there; a
write-scoped key calling a write tool against a closed port — the tool is
registered and reaches the shim, answers "Failed to connect" in 13 ms, and
neither the URL, the user, the database, the password, the service key nor
the key itself appears in the response, while the read key is told the tool
does not exist; check 8 over every scanned file with the exceptions off —
exactly the seventeen files at exactly the seventeen lines, each the
credential compare itself and not a shadow-name compare the count could hide;
and sixteen further spellings caught. The one gap: two sample prompts — the
meal-planning README's "Mark chicken breast as purchased" and the
shared-server primitive's "Add milk and eggs" — sat directly under the advice
to mint the household member's key read-scoped, and would fail under it; each
says so in place now. Nits: this section's file list omitted five files the
diff touches; "fourteen places" enumerated twelve files (fourteen lines, the
checker carrying three); `authenticateRequest`'s docblock said the work
depended on nothing the server holds when it also depends on which of the
client's own forms authenticated; Go's `os.Getenv` was not a read (it is,
with two probes — none of the scanned roots hold a Go file today). History,
read as a whole: the implementation commit's claims each fix corrected are
corrected within the same eight messages.

**Boyscout.** What the passes cut for space, in the files this change
touched, no behaviour changed: the seven servers' auth comment is rewrapped
(two passes had edited its first line and left one at 130 columns); the
checker's non-probe for the servers' own call spells the call they make today
(`authenticateRequest(c.req.raw, …)`, not the first pass's
`authenticate(presentedKey(…))`); `extensions/package.json` drops
`@types/bun`, which nothing in the directory type-checks against, and says so.

**Not done here.** SMD-1455 holds the seventeen excepted files; SMD-1480 the
five extensions that import the shim and read `Deno.env`, which as they stand
neither deploy nor run (done in change 74) — CI's `deno check` covers `server/index.ts` and the two
extensions on supabase-js, and the runtime test is what exercises all seven.
The three vendored files that already compare timing-safe on their own
(`integrations/rest-api` by a hand-rolled XOR loop, `enhanced-mcp` by
`crypto.subtle.timingSafeEqual` with that loop as its fallback,
`recipes/vercel-neon-telegram/src/lib/auth.ts` by `node:crypto`'s) are neither
hits nor consumers of the module.

Verified: `extensions/test-auth.ts` 243/243; `server-portable/test-auth.ts`
59/59 and `test-server.ts` 73/73 with `index.ts` reading through
`authenticateRequest`; `tsc` clean; the Cloudflare Workers dry-run builds with
the `node:buffer` import; fork checker PASS with check 8's probes, widened,
and the seventeen counted exceptions unchanged; `deno check
--node-modules-dir=none index.ts ../job-hunt/index.ts` from
`extensions/family-calendar` clean under Deno 2.9.6, as CI runs it. Upstream
status: **not applicable** — the auth
module is fix 14's and the extensions are vendored; upstream's own
`integrations/enhanced-mcp/README.md` already refuses the URL query form for
its key.



### 65. An opt-in query log turns real use into a replayable eval, and a CI gate holds a recall floor against the searches people actually ran (SMD-1295)

Every retrieval decision this fork has shipped is measured on one corpus the
baseline already saturates — 441 Linear issues, recall@10 0.98 — so the reranker
cascade, hybrid fusion, contextual chunks and GraphRAG all came out neutral or
worse there, and each write-up (and change 30, SMD-1041) names the corpus as the
reason. The other ground truth a real brain produces on every request — the query
someone typed, and which returned thought they opened next — the server used to
discard. This change records it, behind a flag, and gates PRs on it.

**The log (migration 034, `query_log`).** Off by default; `OB1_QUERY_LOG=on`
makes the two search tools write one row per call (query text, `match_count`,
`threshold`, `recency_weight`, `filter`, and the ids returned in rank order with
scores) and the three action tools (`fetch`, `update_thought`, `delete_thought`)
write one row per touch of a *returned* id. Nothing reads it on the hot path; the
write is best-effort — a failure is swallowed so it can never fail a search or a
capture — and it is a new table off the capture path, no trigger, no `thoughts`
change. A search and the action that followed are **not** joined at write time:
there is no request/session token in the MCP handlers (008's actor envelope has a
`session` slot nothing populates), so the link is recovered at export by the only
keys both rows share — the acting agent (010) and the returned id, within a
window — a NULL agent its own bucket, not a wildcard. `prune_query_log(p_keep_days)`
is the retention window (default 30, `OB1_QUERY_LOG_RETENTION_DAYS`; the DELETE
always bounded by `logged_at`), part of this version because the log is personal
data at rest — every query typed. The bound is strict: a row logged in the
prune's own transaction shares its `now()` and stays, and `test-schema` [34]
asserts that with insert and prune in one transaction (SMD-1498 — the section
had assumed each statement's `now()` is later than the last's, which PGlite's
millisecond clock does not promise, and its wipe assertion flaked once). The
window's unit is asserted too (SMD-1515): the section had checked the default
over rows hours old and rows going only at 0, which a body counting hours
passes; now a row half a day past 30 days goes and one half a day inside
stays under the default — half a day, since rows a whole day out sit on a 31-
or 29-day bound whenever the insert and the prune share a `now()`, and the
tick then decides whether such a window is caught.
`db/config.mjs`'s `QUERY_LOG` is the one spelling of the flag, names, tool sets
and retention, read by the server, preflight and the tests; a `querylog` grant
group (query_log `INSERT`, since 034) means a self-hosted role that runs
`--grant` can turn the flag on and have it work — documented, but not enforced,
since preflight cannot read a server env flag and the log is off by default.

**Export → replay → gate (`evals/`).** `export-queries.ts` reads the log and
writes a fixture of query text and ids (`query`, `relevant` = the touched ids,
`baseline` = the recorded ranking): no *thought content* leaves the brain, so it
is committable — but the `query` strings are the searcher's own words, personal
data, so committing an export fixture from a real brain commits real queries (a
maintainer's call). `scripts/check-fork-consistency.mjs` check 9 is the guard: an
allowlist, not a denylist of field names, so every committed string must be a
thought id or free text under a known key (`query`/`note`) — a thought body, an
array of chunks, or a content-derived `title` all fail closed. The attribution is
click-through relevance — a proxy, a fetch can be a wrong guess — and it collapses
distinct callers who typed the same query, and every anonymous caller (a NULL
agent) into one bucket; kept beside the hand-labelled sets, not instead of them. `eval-replay.ts` replays a fixture through the shipped
`search_thoughts_hybrid` over the live corpus and reports recall@k / MRR against
`relevant` and rank drift against `baseline`, in `eval-real.ts`'s table shape.
`db/test-replay.ts` is the CI gate (job *Retrieval replay gate*): offline PGlite,
no model or key, ~0.5 s, replaying a committed **content-free** synthetic fixture
(`build-replay-fixture.ts` — seeded vectors and ids) through `match_thoughts` and
failing when mean recall@5 drops past the fixture's floor. It proves the floor has
teeth by replaying random query vectors and watching recall collapse (0.154 <
0.8), so a scrambling regression fails it without a git-revert to stage one.

Upstream status: **not applicable** — a fork-only measurement mechanism; the log
is a self-hosting feature and the gate is fork CI. **Unfiled** upstream.
Reproduce: `OB1_QUERY_LOG=on`, capture then `search_thoughts` then `fetch` a
returned id, and `SELECT kind, tool FROM query_log` shows the two rows;
`bun db/test-replay.ts` runs the gate offline.

### 66. A re-capture writes no provenance — migration 035 drops 025's "add if empty" from the capture path, so no capture can close a supersession loop and none takes the supersession lock (SMD-1453)

Change 46 (migration 025) let the 3-argument `upsert_thought` fill a NULL
`derived_from` or `supersedes` on a re-capture of the same text —
`COALESCE(thoughts.x, EXCLUDED.x)`, add if empty, never change: the fill —
because `update_thought` then had no way to set provenance after the fact. It
never asked whether the pointer it filled closed a loop: change 54's cycle walk
(migration 029) was the review path's, change 60 (migration 032) moved it into
`update_thought`, and the capture path had none. So R with no pointer, X
superseding R, then a capture of R's text naming `supersedes` X — sequentially,
no race — wrote R → X → R, and both rows read as superseded. Change 63
(migration 033) took the supersession lock around the fill to order it against
the walk, stated the residue in its header, wrote the loop in `test-schema`
[33], and measured what the lock cost: a capture *naming* `supersedes` held the
one brain-wide key from before its label read to commit, HNSW insert included —
about 145 such captures a second at 1,024 dimensions whatever the worker count,
a ceiling. The lock existed only for the fill, but which of the two a capture
is becomes known only under the fingerprint lock, so 033's order made every
capture naming `supersedes` take it.

SMD-1453 offered three: walk the fill (a refusal on the capture path, the lock
and its ceiling kept), refuse the fill (a dedup of text that exists raises), or
drop it. **Migration 035 drops it.** Change 60's envelope — migration 032's
`p_provenance` on `update_thought`, an object naming `derived_from` and
`supersedes` — has been the way to set, change and clear provenance on an
existing thought since it landed, walked, audited, one function; so the fill's
reason is gone, and the rule has one owner. A capture of text that is already
there is a dedup: it merges as 021 and 022 say; it does not decide what the
existing thought derives from or replaces. And the caller is told, not
surprised: the return carries `existed`.

**Migration 035.** The 3-argument form's `ON CONFLICT` clause no longer sets
`derived_from` or `supersedes`; a fresh INSERT writes both from the envelope
as 025 did, a re-capture leaves both columns as they were whatever the envelope
names. Validation is unchanged and runs before the write is known to be a
dedup, so a malformed reference is refused either way — a `derived_from`
naming no thought included; a well-formed `supersedes` naming no thought is
the FK's, which runs on the INSERT only (see "Closed, and not"). The
supersession lock leaves the capture path — with no pointer ever written onto
an existing row there is nothing for it to order. The return is `{id,
fingerprint, existed, supersedes}`: `existed` true means the text was already
there, the metadata merged, the vector and windows moved by 021/022, and any
provenance named not written; `supersedes` is the row's pointer after the
write, so a caller told the text existed can say what stands. `existed` is "a
row held this fingerprint when the locked read ran": a writer that bypasses the
fingerprint lock can make the merge report false (the class 018, 023 and 033
already exclude), and a legacy row with a NULL fingerprint is not found. Also,
022's `FOR NO KEY UPDATE` label read runs for every capture now, not only with
a vector, so the flag is right for a vectorless capture too. The 2-argument
body is carried verbatim from 033 so 035 is the last definer of both inserting
forms and preflight keeps one remedy; `update_thought` is not redefined — 033
stays its last definer, with the order 033 gave it. 032's `COMMENT ON
review_supersession_proposal` said "a capture's add-if-empty through
upsert_thought aside", and is re-issued here with the aside replaced by the
rule, as 033 re-issued `update_thought`'s.

**Callers.** Nothing changes its call. 013's 4-argument form returns `v_result
|| {"chunks": n}`, so both keys pass through to both servers, and
`CaptureResult` carries them. The `capture_thought` tool's reply says what
stands when the caller sent `supersedes` and the text existed — it already
supersedes what was named, currently supersedes another (`update_thought` would
replace it), was named as its own predecessor, or holds no pointer and
`update_thought`'s `supersedes` records it "if that thought exists and closes
no loop"; the edit is named only where it would record or replace — and says
the tools cannot set `derived_from` on an existing thought when that was sent.
Two things at the same boundary are older than this change and follow it: the
tool pre-checks `derived_from`'s shape as it pre-checked `supersedes`', before
the two model calls are paid (since 032 a non-id element was refused only at
the write); and a first capture naming a thought that does not exist is refused
in the tool's words rather than Postgres's foreign-key text (since 025).

**Why a capture needs no supersession lock.** The lock serialises writers of
the `supersedes` column so that `update_thought`'s walk reads pointers no
concurrent writer is changing. A capture now writes that column on a fresh
row only, and a fresh row cannot be part of a loop: a loop through it needs
some row's pointer to reach it, and until this transaction commits no other
transaction can see its id to name it (READ COMMITTED; the FK would refuse an
id that is not there). A walk running meanwhile reads the committed graph,
which the fresh row is not yet in; once it is, it is a leaf pointing at an
existing row. The `KEY SHARE` its FK check takes on the target does not
conflict with `update_thought`'s `FOR NO KEY UPDATE` (change 60) and is taken
last; `delete_thought`'s `FOR UPDATE` on the target does conflict, and the
capture waits for the delete and fails its FK check — 23503, the outcome
before this change too, and SMD-1462's to word. Change 63's order for every
writer — supersession, fingerprint, row — stands; the capture path takes the
suffix fingerprint → row, and `test-live` [6f]'s four writers on two texts
finish as before.

**Five review passes, triaged.** The first (three reviewers: the SQL, the
callers and tests, the prose) found no schema defect. Its SQL reviewer ran
eight workers of captures, edits and review decisions over a seeded brain with
and without deletes: no loop of any length, no deadlock without deletes, and
with them only SMD-1462's review-versus-delete cycle, never raised in a capture
or an edit; the unconditional read against 023's `LOCK TABLE` held under a real
backfill with fifty concurrent vectorless captures. It found the re-capture
naming a `supersedes` that names no thought (stated under "Closed, and not"),
one reply condition, and wording. The second found the number — main had taken
migration 034 and changes 64 and 65 meanwhile, so this is 035, change 66 and
`test-schema` [35] — and the one thing the reply could not know: built from the
caller's inputs alone, it advised recording a pointer the thought already held,
replacing one without saying so, or an edit `update_thought` refuses; the
return's `supersedes` and the reply's four shapes are its fix. The third was
the stop signal: the second pass's `RETURNING` had moved the anchor [35]
sliced the `ON CONFLICT` clause by, so an assertion passed on an empty tail —
the anchors are guarded now — and the reply compared ids case-sensitively
against Postgres's lower-case text. The fourth took another altitude: hostile
inputs at the tool boundary (the two pre-existing items under "Callers", an
empty `derived_from` firing the note, and advice that could name an edit
refused for a loop as well as for a missing thought — it carries the condition
now); the operator who skipped a week — a brain at 032 with filled pointers, a
loop, an accepted proposal, a legacy row and windows, upgraded through 033,
034 and 035 in one run, `--reapply`, then 025, 033 and 034 re-applied by hand
and `--reapply` again, byte-identical to a fresh install in every function
body, ACL and COMMENT, two hundred captures, two hundred edits and fifty
reviews with a backfill mid-way giving no deadlock and no loop; and a cold
read, which caught a renumber miss hidden by a line wrap and the seams four
passes had spliced. The fifth enumerated every input cell of the capture tool
and drove each through the server — no false reply, every advised edit warned
of the two conditions under which it is refused — ran every CI step locally,
codemod round trip included, and read this section whole, which is why it is
this length.

**Closed, and not.** Closed: the capture path cannot write a supersession
loop by any sequence — a loop now needs a writer outside the two functions
(raw SQL) — and the ceiling with it. No longer refused, and stated: a
re-capture naming a `supersedes` that names no thought, or one whose chain
reaches this thought — the FK and the walk ran only where a pointer is
written, and a re-capture writes none (a first capture's FK still refuses a
missing target) — so `existed` comes back true and no provenance is written
(the dedup's own merge runs: metadata, `updated_at`), and `update_thought`,
which the reply names with the condition spelled out, refuses it by name
(`SUPERSEDES_NOT_FOUND`, `WOULD_CYCLE`); the caller learns one step later, not
never. Changed, and stated: 025's "a re-capture may add provenance the row did
not have" is gone; a caller that later wants to record what a captured thought
supersedes calls `update_thought` with the envelope. Not this change's:
`delete_thought` outside the lock order (SMD-1462); the 2-argument form's
silence on the envelope's provenance (PostgREST's two-step fallback has
dropped it since 025); `derived_from`, an array with no acyclicity rule
anywhere, which `trace_provenance` is cycle-guarded against (change 47); a
`derived_from` id naming no thought still refused in Postgres's words; 022's
"unknown vouches for nothing" (SMD-1245). No data changes: a pointer a
re-capture filled before 035 stays, loop or not — no shipped code sends
`supersedes` on its own, but `capture_thought` forwards a caller's, so a loop is
possible wherever a client re-captured existing text naming one; the header
gives a query that finds a two-row loop, one row per loop, and the envelope's
`{"supersedes": null}` to clear one.

**The sentinel, and the preflight.** The 3-argument body carries
`ob1:re-capture-writes-no-provenance` beside 022's and 033's. `atomic capture`
reads it and grades a stale 3-argument body five ways now — before 022, 025,
033, 035, or missing — with 035 the one remedy; the cause follows the ledger
as change 63 made it, and says both halves when the ledger records 033 but not
035 and the body lacks 033's lock (025 re-applied by hand *and* 035 pending).
`test-preflight` adds 033 re-applied by hand over 035 to the walk.

**Cost.** Less, and measured with change 63's design — alternating arms each
on a fresh schema, 033, 035, 033, 035, the cold first arm discarded — at 1,024
dimensions, HNSW, a 300-row corpus, the SQL store with 64 connections: 50
concurrent captures naming `supersedes` against 50 naming none, medians of
four rounds, 292.6 vs 91.3 ms and 284.4 vs 87.7 ms at 033 (3.2×), 94.2 vs
79.7 ms and 73.6 vs 74.0 ms at 035 (1.2×, 1.0×); 200 concurrent naming
`supersedes` 1,650.7 and 1,358.6 ms at 033, 342.2 and 308.4 ms at 035 —
inside the plain arms' own spread (200 naming none: 410.9 / 317.2 ms at 033,
346.8 / 334.5 ms at 035); one serial capture naming `supersedes` 7.30 / 6.75
ms at 033, 7.22 / 6.27 ms at 035. The per-call cost is the HNSW insert either
way; the lock only took the parallelism. More: one index probe per vectorless
3-argument capture, under the fingerprint lock, on the partial unique index the
INSERT's arbitration reads anyway.

**Verified.** `test-schema` [35] (841): 035 the last definer of
`upsert_thought` and 033 of `update_thought`; the 3-argument body read from
`pg_proc` — 035's sentinel beside the two before it, no supersession lock, an
`ON CONFLICT` clause that sets neither column while the INSERT lists both, the
row read unconditional, `existed` and the row's `supersedes` returned, 022's
DELETE condition kept; a first capture writes provenance with `existed: false`;
a re-capture naming other provenance leaves the row's, one over a row with none
fills nothing, a vectorless one says `existed: true`; validation still refuses
a malformed envelope on a dedup; SMD-1453's sequence writes no loop and
`update_thought` refuses the same pointer; a capture naming `supersedes` holds
one advisory lock inside its transaction; both COMMENTs; the trap — 033
re-applied by hand puts the fill and the lock back and writes the loop, 035
restores. [22], [23], [31], [33] follow the last definer ([33]'s own trap had
restored `update_thought` by re-applying 033's whole file, which put 033's
capture bodies back for every section after it; it restores both names now).
The 4-argument pass-through is read from 013's source there and called on a
real server in `test-live` [13]: PGlite aborts with a WASM out-of-bounds on a
windowed capture through that form, at 033 as at 035. `test-live` (482): [6e]
arm 3, a capture naming `supersedes` completes while another connection holds
the supersession lock, its pointer written on its fresh row — where at 033 it
waited; [13], a re-capture naming provenance over a row with none fills nothing
and says `existed` with the pointer that stands, the envelope records it, and
`existed` rides beside `chunks` through the 4-argument form. `test-upgrade`
[13] (162): 035 onto a populated 033 whose re-capture had just written the
loop — no column, signature, row, audit row or ACL moves, the loop stays, the
2-argument body and `update_thought` byte-identical before and after, the next
such re-capture fills nothing, the loop is cleared through the envelope and
cannot be re-written, a re-run is a no-op. `test-e2e-sql` [7] (94): the reply's
four `supersedes` shapes and `derived_from` alone through the server, upper-case
ids, both refusals the advice warns of, both pre-checks. `test-preflight`
(205), `test-search-path`, both store suites (each asserting the two keys),
`test-update-delete`, `test-audit`, `tsc`, the consistency checker.

Upstream status: **not applicable** — upstream's `upsert_thought` writes no
provenance at all.

### 67. The vendored recipes and integrations authenticate the way the extensions do — seventeen files off a plaintext `===`: thirteen servers and samples onto scoped keys through a `_shared/auth.ts`, four onto a compare of digests (one of them through the same module), and check 8's exception list empty (SMD-1455)

`server-portable/auth.ts` (one export added, the consumers paragraph), its six
copies — `extensions/_shared/auth.ts`, and the new `recipes/_shared/auth.ts`,
`recipes/editorial-policy/_shared/auth.ts`,
`recipes/edge-function-cost-optimization/examples/_shared/auth.ts`,
`integrations/_shared/auth.ts` and
`integrations/consolidation-workers/_shared/auth.ts` — the seventeen files
check 8 held by count: `recipes/ob-graph/index.ts`,
`recipes/work-operating-model-activation/index.ts`,
`recipes/editorial-policy/auditor/index.ts`,
`recipes/edge-function-cost-optimization/examples/before/per-request-server.ts`
and `examples/after/index.ts` (with `examples/after/server.ts`),
`recipes/vercel-neon-telegram/src/app/api/telegram/route.ts` (with
`src/lib/auth.ts`), `integrations/delete-thought-mcp/index.ts`,
`integrations/update-thought-mcp/index.ts`,
`integrations/kubernetes-deployment/index.ts` (with its `Dockerfile`,
`k8s/openbrain.yml` and `k8s/secrets.yml.example`),
`integrations/entity-extraction-worker/index.ts`,
`integrations/consolidation-workers/bio/index.ts` and
`metadata-norm/index.ts`, `integrations/agent-memory-api/index.ts`,
`integrations/open-brain-rest/index.ts`, `integrations/readwise-capture/index.ts`,
`integrations/telegram-capture/README.md`,
`docs/walkthroughs/ob1-agent-dashboard/demo-rest-server.mjs`.

With them: the READMEs of those servers and `recipes/editorial-policy/schedule.sql`;
`primitives/deploy-edge-function/README.md`; `extensions/test-auth.ts`,
`extensions/package.json` and `extensions/README.md`;
`server-portable/test-auth.ts`; `integrations/.dockerignore`;
`integrations/consolidation-workers/deno.json`; `recipes/ob-graph/.env.example`;
`recipes/openclaw-agent-memory/README.md` and its
`contracts/recall-response.schema.json`;
`dashboards/open-brain-dashboard-next/README.md` and
`open-brain-dashboard-pro/README.md`; `scripts/check-fork-consistency.mjs` and
`.github/workflows/fork-checks.yml` (Linear SMD-1455, filed from change 64's
implementation; the ticket's own text says "change 62", which is the
capturing-role grants — 64 is meant). No migration.

**The finding.** Change 64 made the seven extension servers consumers of the
core server's auth module and gave the fork checker check 8: a value read from
the environment under a credential's name is never compared with an equality
operator. The rule's first run found the same compare in seventeen more
vendored files, and change 64 listed each in `CREDENTIAL_COMPARE_EXCEPTIONS`
for exactly the one line it had, with this ticket as the reason. By what they
compared: ten MCP servers, HTTP APIs and workers comparing a URL-query or
header key with `MCP_ACCESS_KEY` and then running as the service role — the
extensions' shape exactly; two more under another name (`AUDITOR_ACCESS_KEY`,
the dashboard walkthrough's `OB1_DASHBOARD_DEMO_KEY`); three webhook receivers
comparing a secret the caller echoes (Readwise's payload field, Telegram's
secret-token header, twice); and the cost recipe's before/after teaching pair
— the "after" teaching the compare too.

**Adopt, as change 64 did — and where the module lives.** The ticket's sketch
said to import `server-portable/auth.ts` by relative path, the shape fix 13's
shim import has. Change 64's first review pass had already found why not: a
Supabase Edge Function is bundled from `supabase/functions/`, and an import
that leaves it does not deploy. Four of the seventeen deploy today —
`ob-graph`, `agent-memory-api` and `metadata-norm` on supabase-js through their
`deno.json`, `kubernetes-deployment` from a Dockerfile — and the rest
already import the SQL shim across the tree (fix 13; the state SMD-1480
records for five extensions).

So the module is a `_shared/auth.ts` beside each
server, imported as `../_shared/auth.ts` — every function deploys one level
under `supabase/functions/`, and that is the one import it can resolve there —
which in this repository puts a copy in each directory that holds a function
directory: `recipes/_shared/`, `integrations/_shared/`, the consolidation
workers' own `_shared/` (already their deploy-time shared directory beside
`helpers.ts` and `network.ts`), `recipes/editorial-policy/_shared/` for the
auditor and `recipes/edge-function-cost-optimization/examples/_shared/` for the
two samples. Six copies of one file, each byte for byte
`server-portable/auth.ts`; `bun run sync-auth` in `extensions/` rewrites them
all, and the test fails if any differs or the tree, the list and the command
disagree. The deploy primitive says any one of them serves. (The implementation
had the auditor and the samples reach the category copy by `../../` and
`../../../`, which resolves in this tree and not in a deployed layout — the
third pass's deployer found it.) The Kubernetes image is built with
`integrations/` as its context so the copy is inside it, the Dockerfile
mirroring the repository layout; the README's build line changed. Each
converted file carries an `ob1-fork (SMD-1455)` header naming the module and
this change; the three that deploy under Deno with no `_shared/` of their own
— `ob-graph`, `agent-memory-api`, `kubernetes-deployment` — add that the
`_shared` import is the file's first from outside its own directory, as the
ticket asked and as fix 13's codemod does.

**What each server became.** Each imports `authenticateRequest` and `canWrite`
(the ticket wrote `authenticate` and `presentedKey`; change 64's
`authenticateRequest` is the one that tries every presented form). The MCP
servers register a tool that writes only `if (canWrite(principal))`, as the
extensions do. Where a server was built per
request (`ob-graph`, `kubernetes-deployment`'s `buildServer()`, the "before"
sample) the principal is a parameter; where it was a module singleton
(`delete-thought-mcp`, `update-thought-mcp`, `work-operating-model-activation`)
`buildServer(principal)` runs once per key scope and `serverFor(principal)`
hands back the cached one — two servers at most, not one per request, which is
the property those files and the cost recipe care about (undone by change 78:
a server shared across requests is connect()ed to a fresh transport each time
and answers on the wrong one; `buildServer(principal)` runs per request now,
and the cost recipe's sample per session). A server with no
tool for a read-scoped principal (the two single-tool integrations) still
declares a tools capability and lists an empty set — the SDK wires `tools/list`
only when a tool is registered, and a client whose listing fails shows a broken
connector, not an empty one; a call is still told the method does not exist.

The two HTTP APIs resolve the principal in one `app.use("*")` middleware
and put a `requireWrite` middleware on the routes that write — for
`agent-memory-api` write-back, usage reporting and review; for
`open-brain-rest` the thought `PUT` and `DELETE`, capture, reflection and
ingest — answering 403 with the reason before the route parses a body. A
recall is a read: under a write-scoped key it records itself — a trace row and
its items, which the usage route later marks used or ignored, and that route
is a write — and under a read-scoped key it records nothing and returns
`request_id: null`, so a leaked read key cannot fill the trace tables with its
payloads either (the first review pass; the implementation had let it).

The three integration workers keep their fail-closed 503 when no key is
configured (the auditor, which never had one, answers 401) and let a
read-scoped key do the one thing that writes nothing: a dry run
(`?dry_run=true`, or the auditor's `dry_run` body flag); anything else is 403.
The consolidation workers' undocumented `x-mcp-key` header went, and — after
the third pass — so did the auditor's undocumented `x-auditor-key`: neither
appeared in any README or in the schedule, so neither was a rule a caller
could learn, and the module's four documented forms replace them. The auditor
keeps its own names, `AUDITOR_ACCESS_KEYS` with the older `AUDITOR_ACCESS_KEY`
still accepted, because `schedule.sql` and every deployed cron URL already
carry them; it hands them to the module under its `MCP_ACCESS_KEYS` and
`MCP_ACCESS_KEY` slots, which is why its legacy-key principal is named
`MCP_ACCESS_KEY`.
Every server reads its keys per request, where they are used, so a rotation
takes effect without a restart and the test can set and unset them. The
"after" sample's session map remembers the scope a session was minted under:
a session id is not a credential, so a read key presenting a write session's
id gets a fresh read-scoped session, not the write surface.

**The webhook secrets.** A secret the caller echoes has no name and no scope,
so there is no principal to give — the fix is a timing-safe compare, and it
lives in one place: `auth.ts` gained `secretMatches(presented, expected)`,
which hashes both sides and compares the digests with `timingSafeEqual`, so
neither the secret's length nor its prefix reaches the response time and an
empty value on either side is a refusal. `readwise-capture` uses it through
`integrations/_shared/auth.ts`. The Next.js recipe's route uses a
`secretMatches` added to its own `src/lib/auth.ts`, beside the
`timingSafeEqual` it already had for the access key — a Next.js app does not
import this fork's server. The module refuses anything that is not a string
before hashing, so a payload field shaped by the caller is refused, not thrown
on; on `main`, Readwise admitted a body with no `secret` field whenever the
secret was unset — `undefined !== undefined` is false — which this closes.
The Telegram README's sample handler — pasted into
a fresh Supabase project, where nothing else of this fork exists — and the
dashboard walkthrough's Node stub each carry a five-line `node:crypto` version:
the two calls `_shared/auth.ts` makes, proven on the target runtime. (The
implementation had given the sample a Web Crypto one on
`crypto.subtle.timingSafeEqual`, a Deno 1 extension Deno 2 removed; on
Supabase's runtime every webhook would have thrown inside the handler's `try`
and answered 500. The first review pass ran it under Deno 2.9.6 and found it;
`enhanced-mcp` feature-detects the same call, which is why it had never shown.)

**The test.** `extensions/test-auth.ts` is now the one test for every vendored
server under scoped keys: the seven extensions and the twelve recipes and
integrations it can import, plus the webhook receiver, run as deployed under
the stand-in for Deno's two globals — `Deno.serve({ port }, handler)` now
captured too — and, for the recipes and integrations, under a Bun loader that
reads their Deno specifiers: a `jsr:` type-only import is dropped,
`npm:pkg@version` becomes `pkg`, the Deno postgres driver becomes a stub that
never connects, and a bare package name resolves from `extensions/`' install,
since theirs is a deno.json. (Bun's runtime `onResolve` is not consulted for a
`jsr:` or bare specifier at all — the first two attempts recursed or fell
through — so the loader rewrites the source instead.) Each MCP server gets the
extensions' assertions; each HTTP API: a read key passes a read route and is
told 403 by every write route before it parses anything, a write key passes
them all; each worker: a read key is refused a real run and allowed a dry run;
the receiver: the right secret admits, a wrong, missing, non-string or
digest-for-secret one is refused. No database — a handler that must query
before it can answer is pointed at a port nothing listens on and refused at
once. Then the drift guards, widened: every mounted route classified and
exactly the writes take `requireWrite`, a route's reach including the
file-level functions it calls; `.delete()` a table verb only with no argument
(`searchParams.delete("page")` had made two reads writes); raw `INSERT INTO`
counts for the Kubernetes server's SQL; the read's own trace inserts allowed
by table name and only behind a `canWrite` check; the six copies identical,
the tree, the list and the sync command agreeing;
every `npm:` pin in a recipe's or integration's deno.json for a package the
test installs matching it exactly, scoped names included; and the six files it
cannot run — the "after" sample's two files, whose tool modules are not in the
repository, the Next.js route and its lib, the README, the stub — say the
same thing in their text. 643 assertions.

**Check 8.** The exception list is empty; the shape stays, the header says why,
and the failure message names both places a fix can go — the `_shared/auth.ts`
beside the file, or `secretMatches()` for a secret the caller echoes. Said in
the rule's text too: a compare routed through a function is outside the rule
by design, because the operator is what it catches and a call is where the
timing-safe compare lives. The third and fourth passes widened the rule by
one clause: an object bound from a statement that reads a credential from the
environment — `const keys = { MCP_ACCESS_KEY: Deno.env.get(…) }`, on one line
or many, the shape the workers here bind their keys in, which the binding rule
alone did not follow into — has its credential-named properties, bracket reads
and destructured names treated as the credential. (The third pass's clause
had fired on any object's upper-case credential-suffixed property —
`opts.MAX_TOKENS`, `table.PRIMARY_KEY` — no hit in the tree today and a false
positive the first such compare would have paid; the fourth anchored it.) Four
probes and six non-probes hold it.

**Docs.** Each converted server's README: the secret is `MCP_ACCESS_KEYS`
(`name:scope:sha256`, minted as the deploy primitive's Step 3 shows, the older
single key still accepted), the `_shared/auth.ts` copy is downloaded or copied
beside the function, and the tools or routes that need a write-scoped key are
named. The two thought integrations' download URLs pointed at upstream, where
the file they now import does not exist; they point at this fork's `main`. The
deploy primitive says the category copies are the same file. The auditor's
`schedule.sql` says the URL carries the key and the secret its hash, and that
the schedule needs write scope. The Kubernetes manifests take
`MCP_ACCESS_KEYS` from a `mcp-access-keys` secret with an example entry.

**What did not change, and why.** `server/index.ts`, upstream's Edge
Function, keeps its compare: outside the check's directories and the
vendored-tree standard, as the ticket says. `integrations/rest-api` and
`enhanced-mcp` keep their hand-rolled timing-safe loops: not hits, and not
this ticket. The servers still answer a bare 401 rather than the core's
JSON-RPC envelope, for change 64's reason. The shim-importing files among the
seventeen still neither bundle as an Edge Function nor run under Deno, fix
13's consequence, unchanged here — SMD-1480 records it for five extensions and
now carries a comment widening it to these. Read scope on the workers means a
dry run, which still spends LLM calls; that is a cost, not a write. The three
module-singleton MCP servers still, at this change, `connect()`ed one cached
`McpServer` to a fresh transport per request, as they did on main: the SDK overwrites the
transport on connect and captures it when a message arrives, so two concurrent
requests to one of them can cross responses — a pre-existing defect the
per-scope cache neither causes nor cures (SMD-1497 held it; change 78 builds
each server per request, and found `enhanced-mcp` a fourth); the "after"
sample's one transport per session was the shape this paragraph first called
correct — it shared one server per scope across sessions and hung every
session but the last minted; change 78 builds its server per session.

**Review, first pass** (triaged; two reviewers, nineteen findings — one HIGH,
four MED, the rest low — twelve fixed, one filed, the rest noted or declined).
The HIGH and one MED are above: the Telegram sample on an API Deno 2 removed,
and a read-scoped recall that stored its payload. The two single-tool
integrations declare an empty tools list rather than no capability (both
reviewers). The test's pin guard had a regex that skipped every scoped package
— `@hono/mcp`, `@modelcontextprotocol/sdk`, `@supabase/supabase-js` were
never compared — and the corrected guard found the one drift it had hidden:
the consolidation workers pinned `@supabase/supabase-js@2`, an unpinned major,
and `metadata-norm` bypassed the import map with an inline `npm:` specifier;
both pin 2.47.10 now, through the map. The test dialled the network once — a
write probe on `agent-memory-api` passed its schema (both fields default) and
queried supabase-js at `stub.invalid`, a resolver lookup the docblock said
never happens; that server is pointed at a refused port like the other. The
read-key write probes send a body no route could parse, so the 403 is proven
to come from the gate; `passed()` no longer counts a refusal by another status;
the postgres stub has a per-process name and is removed after the imports; the
loader's filter is anchored to this checkout. Counts corrected: thirteen files
take a principal from the module (both cost samples among them) and four compare
digests — `readwise-capture` through the module's `secretMatches`, so fourteen
of the seventeen import a copy; the Next.js route through its own, the README
sample and the stub inline; twelve importable vendored servers, six text-only
files. The "after"
sample says its cached `principal` is the first caller's for that scope and is
for `canWrite()` only; the header note that said "the import above" sat above
the import; the Docker context gained a `.dockerignore` so the whole
`integrations/` tree does not ship to the daemon; `ob-graph`'s `.env.example`
led with the single key; the consolidation README's tree and change 64's prose
in `extensions/package.json` and `extensions/README.md` name the widened test.
Noted, not changed: `primitives/remote-mcp` and `docs/` do not mention
`MCP_ACCESS_KEYS` (change 64's gap, carried — every converted README points at
the deploy primitive's Step 3); the download URL for `integrations/_shared/auth.ts`
answers 404 on `main` until this merges, as any doc pointing at `main` does.

**Review, second pass** (triaged; two reviewers, thirteen findings, nine fixed,
the rest noted — and the two at the top were consequences of the first pass's
recall fix: the stop signal). A read-scoped recall's `request_id: null` broke
the published v1 response contract,
`recipes/openclaw-agent-memory/contracts/recall-response.schema.json`, which
required a non-empty string; the contract allows null and says when, and the
agent-memory README's endpoint table and smoke section say a read key gets no
trace and the harness needs a write key. Two of the first pass's guards were
fooled by mutation, run rather than reasoned: the recall guard accepted a
`canWrite` check with a no-op body — it requires the check to precede the trace
insert and to return — and the pin guard passed an unversioned or non-npm
specifier (`npm:hono`, a `jsr:` or URL import would deploy on latest while the
test ran the pin) — it requires the exact pin whatever the spelling. Also run:
five other mutations against the servers and a deno.json, each caught by the
test (and the Telegram revert by check 8 as well); the Docker build from
`integrations/` succeeds and `deno check` inside the image resolves
`../_shared/auth.ts`; an SDK probe of the empty-tools server answers `{ tools:
[] }` and -32601 on a call, as this section says; every shim-importing file's
`deno check` errors are the shim's (fix 13) or `main`'s own, none inside this
branch's hunks (the fourth pass found three that were, hidden among the
shim's, and fixed them; two casts in `work-operating-model-activation` are
`main`'s);
two overlapping requests to a module singleton hang on `main` and here alike —
SMD-1497 has the trigger, any two, not a burst (closed by change 78). Text: `metadata-norm` deploys
through its `deno.json`, not an inline specifier; fourteen importers, not
thirteen; the Verified line's count; two non-probes record spellings the rule
must keep ignoring (a property of a bound principal, a `typeof` beside a bound
secret); the Next.js dashboard README told users to enter `MCP_ACCESS_KEY`
against `open-brain-rest`, converted here. Noted, not changed:
`consolidation-workers/deno.json`'s `check` task still names `bio/index.ts`,
whose shim import fails it (SMD-1480; CI checks `metadata-norm` alone — the
task names `metadata-norm` alone since change 74);
`readwise-capture` answers an empty body 200 before the secret check —
upstream's accommodation of Readwise's Test Webhook button, unchanged.

**Review, third pass** (past the stop signal, at the user's call; two
reviewers — one walking every README as a deployer, one adversarial on the
module and the rule — seventeen findings, sixteen fixed). The deployer found
what the reading passes had not. A function deploys one level under
`supabase/functions/`, so its import must be `../_shared/auth.ts` wherever the
file sits in this repository: the auditor's `../../` and the samples'
`../../../` resolved in the tree and not in the README's layout
(`supabase/_shared/`, outside the bundle). Every server imports
`../_shared/auth.ts` now and two more copies sit where those files are — six,
held identical by the test, which also asserts the tree, its list and `bun run
sync-auth` agree. The first pass's `metadata-norm` change — the bare specifier
through `deno.json` — had made the one consolidation worker that deployed on
`main` undeployable by its README, which copied the folder without the
`deno.json`; the README copies it for both workers, and copies `_shared/` file
by file, since `cp -r` into an existing `_shared/` — which every other README
now creates — nests. Every `supabase secrets set MCP_ACCESS_KEYS="one:entry"`
example said, in effect, drop every other client's key: the secret is
project-wide, and each README says to set the whole list. The
shim-importing READMEs — seven then, eight with `readwise-capture`'s in the
fourth pass — carry the extensions' SMD-1480 callout above their deploy
steps. The rule: check 8 was silent on the shape this change introduced
— `if (provided === keys.MCP_ACCESS_KEY)` after the workers' `keys` object —
in both its one-line and multi-line forms; the property clause above.
`secretMatches` refuses a non-string in the module rather than trusting each
caller (readwise's guard went with it) and has a unit test in the core
server's suite. Smaller: the auditor's undocumented `x-auditor-key` header went;
a malformed `MCP_ACCESS_KEYS` entry is dropped without a log in every vendored
server, as in change 64 — the deploy primitive's troubleshooting says so and
what to check; the editorial README had a sentence of prose inside the
secret's value and mixed path roots in its copy lines; the Kubernetes README's
expected tool count says three for a read key; the harness says how to add a
server, silences a handler's `console.error` for the length of a request,
accepts single-quoted specifiers, and dropped a parameter never passed. Noted:
the auditor's legacy-key principal is named `MCP_ACCESS_KEY` though its
variable is `AUDITOR_ACCESS_KEY` — a logging name, never logged; the exceptions
mechanism has nothing to exercise it while the list is empty.

**Review, fourth pass** (at the user's call; two reviewers — one re-running
the deployer simulation against every README after the third pass's six-copy
change and mutating its new guards, one reading the whole diff as its merger —
thirteen findings, two of them one defect seen twice; nine fixed, the rest
noted). `readwise-capture`'s README had never been given the `_shared/auth.ts`
copy step — the implementation moved its secret compare onto the module, and
three passes of READMEs walked past the one that was not an MCP server or a
worker; it has the step and the SMD-1480 callout, the eighth. The
work-operating-model conversion lost a type narrowing: the module-scope throw
that made `DEFAULT_USER_ID` a `string` for the old top-level tool bodies does
not reach the hoisted `buildServer()` they moved into, three `deno check`
errors the second pass's "none inside this branch's hunks" had missed (the
shim's errors hid them) — a `?? ""` at the declaration, since the throw already
refuses the empty string. The cost recipe's README tree named `../_shared/auth.ts`
and never told the reader to place it, nor the `deno.json` beside `index.ts`,
and still said `register(server)`. The consolidation README's `cp -r` of the
two function directories nested on a second run as its `_shared/` copy had;
files are copied one by one, and the `deno.json` sentence says which worker
needs it today. The third pass's check-8 clause fired on any object's
upper-case credential-suffixed property — `opts.MAX_TOKENS`, `table.PRIMARY_KEY`,
`this.API_KEY` — with no hit in the tree today and a red build waiting for the
first; it is anchored to objects bound from an environment read, follows
bracket reads and destructures out of them, and the helper-returned object is
back outside the rule where the header always said it was. Text: this section's
opening still counted four copies and described readwise's removed string
check; the Verified line's core count; `metadata-norm`'s note claimed a first
outside import it never had (its `_shared/` helpers came first); the Kubernetes
note said Supabase bundles what Docker copies; the other dashboard README named
the single key against `open-brain-rest`. Run and held: every README layout
assembled literally and `deno check`ed — clean for the four that deploy, the
shim's errors alone for the rest (plus two casts `main` already had in
`work-operating-model-activation`); five mutations of the third pass's guards
each caught; `docker build` from `integrations/` with the image holding exactly
three files; a bisect across the four commits before this one green at each.

**Review, fifth pass** (at the user's call; two reviewers — one adversarial on
the fourth pass's own changes and the rule's edges, one auditing this section
against the tree as the record a later reader trusts — twenty-three items,
none above low; twenty-one fixed). The rule: an object literal that never
closes bound its name to everything read below it — the brace walk now binds
nothing when it runs off the end; a bracket read behind `?.` is followed; the
header names what the clause does not follow (a property assigned after the
object was made, a nested property). The checker had been decoding a 71 MB
walkthrough video as text on every run; media extensions are binary now. Two
header notes read wrong after the fourth pass (the Kubernetes note gave its
reason twice, `metadata-norm`'s "Deploy it" pointed at the test), and the
"after" sample's first line still said "singleton". The record: this section
said all four workers kept a fail-closed 503 — the auditor never had one and
answers 401, as the test encodes; said a read-scoped recall "returns no
request id" where the API returns `request_id: null`; counted the seven
extensions' 243 assertions "among" today's 643, which was change 64's whole
suite, not a separable subset; and its title read as an importer count when
fourteen files import a copy. Two deviations from the ticket's sketch were
unrecorded — `authenticateRequest` for its `presentedKey`, and the ticket's
"change 62" for 64 — and three decisions were taken without being written
down: why the undocumented headers went, why the auditor keeps its own env
names, and that every converted file carries the fork header the ticket asked
of four. The three longest paragraphs are split where a topic changes, with
history moved behind the current fact. Noted, not changed: `readwise-capture`'s
README says both "no redeploy is needed" and "redeploy" about a rotated secret,
and frames an update as fetching `index.ts` alone — `main`'s prose, outside
this ticket.

**Boyscout.** What the passes cut for space, in the files this change
touched, no behaviour changed: two lines of this section rewrapped;
`readwise-capture`'s README no longer tells a reader to redeploy after
rotating a secret it also says is read at runtime, and its update note names
`_shared/auth.ts` beside `index.ts`; `auth.ts`'s docblock counts the vendored
servers' write tools beside the extensions' (six copies follow); the test's
Deno stand-in and postgres stub lines are wrapped.

**Not done here.** SMD-1228 holds the last rule of the vendored-tree standard
(integrations writing around `update_thought`) — done in change 69. SMD-1480 held the
deployability of everything that imports the shim — done in change 74. `recipes/vercel-neon-telegram`'s
`validateAccessKey` guards the lengths before its `timingSafeEqual`, a small
length leak the ticket did not name and this change did not touch.

**Verified:** `extensions/test-auth.ts` 643/643 (243 at change 64);
`server-portable/test-auth.ts` 67/67, `test-server.ts` 73/73,
`tsc --noEmit` clean, the Cloudflare Workers dry-run build; `deno check
--node-modules-dir=none` clean under Deno 2.9.6 for `ob-graph`,
`agent-memory-api`, `consolidation-workers/metadata-norm` and
`kubernetes-deployment`, each from its own directory — the four CI now checks;
`bun scripts/check-fork-consistency.mjs` PASS with the exception list empty
(52 probes, 30 non-probes, no vendored hit). The ticket's verify grep —
`req.query("key")` under `extensions/`, `recipes/`, `integrations/` — returns
nothing.

**Upstream status:** not applicable — the compares are upstream's; the module
they now use is this fork's.

### 68. delete_thought joins the writers' lock order, closing a deadlock between an accept and a delete of the superseded thought (SMD-1462)

Change 63 (SMD-1043, migration 033) put every writer of `thoughts.supersedes`
on one lock order — the supersession advisory lock
`hashtext('ob1:supersession-review')`, then the fingerprint lock, then the row —
and its second review pass named the one writer left outside it: `delete_thought`
(migration 009). The function took no advisory lock. Its `DELETE` holds the
thought's row, and change 54's (SMD-1294, migration 029) `ON DELETE CASCADE` from
`thoughts` onto `supersession_proposals` reaches every proposal that names the
row and waits to remove it.

**The cycle, both shipped functions.** `review_supersession_proposal(P, 'accept')`
locks the proposal row `P` `FOR UPDATE`, takes the supersession lock, locks the
superseding thought `S` `FOR NO KEY UPDATE`, then writes `S.supersedes = Z`
through `update_thought`, whose FK check (`thoughts_supersedes_fkey`, change 25 /
migration 025) takes `KEY SHARE` on the superseded thought `Z`. Meanwhile
`delete_thought(Z)` holds `Z` and, through the cascade, waits on `P`; the review
holds `P` and waits on `KEY SHARE` of `Z`. 033's pass reproduced it 23 times in
40 against a real server, the delete the `40P01` victim each time — pre-existing
since 029/032, and 033's header and change 62 stated it as the residue outside
the order rather than claiming the order was universal.

**The fix (migration 036) — two changes, and running it proved both are
needed.** `delete_thought` takes
`pg_advisory_xact_lock(hashtext('ob1:supersession-review'))` before its `DELETE`
— the identical key the review, `update_thought` and `upsert_thought` take, one
hash entry, transaction-scoped, taken unconditionally because the function cannot
know whether a proposal names the row before it is gone. The ticket proposed that
alone and warned that reordering the review's proposal-row lock "is not enough on
its own". The live race (`db/test-live.ts` [6g]) showed the delete-side lock is
not enough on its own either: with only `delete_thought` fixed it deadlocked 10
of 40 during the build, because `review_supersession_proposal` locks the proposal
row `P` **before** it reaches the advisory lock (029/032), so a delete holding the
lock waits on `P` through the cascade while a review holding `P` waits on the lock
— the same cycle, one row along. (The shipped [6g] guards the reorder through its
no-deadlock arm rather than reproducing that intermediate state.) So the second change: `review_supersession_proposal` takes the
advisory lock **before** it locks `P`, for accept and reject alike. Now a delete
and a review contend on the lock first, and whichever wins runs to commit — the
review writing its pointer, or the delete removing `Z` and cascading `P` — before
the other touches a row. Forty tries, no `40P01`. Both bodies are otherwise 009's
and 032's verbatim (the review keeps its two `update_thought` calls and its
no-UPDATE, no-walk shape); both signatures are unchanged, so the stores and tools
call them as before.

**The 23503 the same lock closes.** 033's probe found a second, smaller thing: a
supersedes target deleted between `update_thought`'s existence walk (the plain
`SELECT` that answers `SUPERSEDES_NOT_FOUND`) and its `UPDATE` (where the FK
fires) surfaced as a raw `23503 thoughts_supersedes_fkey`, not the
`SUPERSEDES_NOT_FOUND` its COMMENT promises "for a target deleted in the instant".
The delete-side lock closes that window from the same edge: `update_thought`
holds the supersession lock across **both** its walk and its `UPDATE` whenever
`supersedes` is named (033), and `delete_thought` now contends on it, so a
through-the-functions delete cannot slip between the two. Update-first: the walk
sees `Z`, the `UPDATE` takes `KEY SHARE` on a `Z` still there, and the delete's
`ON DELETE SET NULL` (025's FK) clears the pointer afterwards. Delete-first: the
walk, under a fresh `READ COMMITTED` snapshot, finds `Z` gone and returns
`SUPERSEDES_NOT_FOUND`. Either way, no 23503 — the COMMENT's promise is honoured,
not tightened, so `update_thought`'s 280-line body stays 033's byte for byte. A
raw `DELETE FROM thoughts` around the function takes no advisory lock and could
still race the walk into a 23503, exactly as a raw content `UPDATE` around
`update_thought` escapes the fingerprint lock (033's header): the order is a
contract among the shipped functions.

No runtime, store or preflight change — two SQL functions redefined, each
carrying its prior body with only the lock relocated. The `delete_thought(uuid,
jsonb)` COMMENT names the new lock. `db/test-live.ts` [6g] races forty accepts
against forty deletes: the pre-036 lockless delete (009's body by hand) deadlocks,
the shipped pair does not and its cascade still removes the proposal; [6h] races
`update_thought` naming supersedes against a delete of that target forty times and
sees never a raw 23503, always `SUPERSEDES_NOT_FOUND` or a clean write.
`db/test-schema.ts` [36] pins 036 as the last definer of both functions and each
lock before its contended row.

Upstream status: **not applicable** — the deadlock is between two fork functions
(029/032's supersession review and 009's delete) that upstream does not have.
**Unfiled** upstream. Reproduce: `./with-postgres.sh bun db/test-live.ts` and
read [6g]/[6h].

### 69. The vendored writers of a thought's content and vector go through the functions that own them — nine files off a raw update of `thoughts`: edits through `update_thought`, captures through the 3-argument `upsert_thought`, the enhanced columns beside them, and check 10 holds it (SMD-1228)

`integrations/update-thought-mcp/index.ts`, `integrations/enhanced-mcp/index.ts`
(and its `_shared/helpers.ts`), `integrations/agent-memory-api/index.ts`,
`integrations/open-brain-rest/index.ts`, `integrations/rest-api/index.ts` (and
its `_shared/helpers.ts`), `integrations/consolidation-workers/bio/index.ts`
(and the workers' `_shared/helpers.ts`),
`recipes/repo-learning-coach/server/brain.ts`,
`recipes/provenance-chains/mcp-tools.ts`, the sample in
`integrations/telegram-capture/README.md`; `scripts/check-fork-consistency.mjs`
(check 10); `extensions/test-writes.ts` (new); their READMEs; the CI workflow
(Linear SMD-1228, named under change 38's "Not done here"). The
ticket named three integrations that updated a thought's `content` or
`embedding` with a raw PostgREST `.update(…)` on `thoughts` rather than
through `update_thought`. Check 10's first run over the seven category
directories and `docs/` found nine files with eleven such statements: the two
MCP servers (`update-thought-mcp`'s one tool; `enhanced-mcp`'s `update_thought`),
three HTTP APIs (`agent-memory-api`'s write-back, `open-brain-rest`'s capture
and edit, `rest-api`'s edit and enrich), a worker (`consolidation-bio`'s
profile rewrite), a recipe's server (`repo-learning-coach`'s capture), a
recipe's paste-in snippet (`provenance-chains`' `capture_derived_thought`) and
a README's sample (`telegram-capture`'s edit path). Every rule this fork put
into the writers was bypassed by each: 003/018's `content_fingerprint` left
describing the previous text — the row 018's `fingerprint_held_by` report
exists for; 021's `embedding_model` left describing the previous vector, or
NULL where the vector was written after a 2-argument `upsert_thought` — 021's
header calls a raw vector write "the operator's", and these are shipped
tools; 022's chunk rows of the previous vector left under the new one — 022's
"the three writers leave no new stale set" held for the three alone; and no
actor set for 008's audit row. The upstream survey added a third failure
mode (upstream #379), and the audit confirmed it twice over: `enhanced-mcp`
and `rest-api` read `thought_id`, or digits only, from `upsert_thought`'s
return — this fork's returns `id`, a UUID — so every capture through them
threw *after* the row was written; both put the vector inside `p_payload` of
the 2-argument form, where the fork's function does not look, so no capture
through either had stored a vector at all; and `rest-api`'s `/thought/:id`
routes matched `\d+`, so none could reach a row here.

**The rule, and where it differs from the ticket's sketch.** Every write of a
thought's content or vector goes through the function that owns the row's
invariants. An edit is one `.rpc("update_thought", { p_id, p_content,
p_metadata_patch, p_embedding, p_embedding_model[, p_if_unchanged_since] })`
— named arguments, so the ticket's "021's eight-argument form" is moot: the
function has taken nine since migration 032 (change 60), and a caller that
names what it passes never spells an arity. A capture is one
`.rpc("upsert_thought", { p_content, p_payload: { metadata, embedding_model },
p_embedding })` — the 3-argument form, vector and label in the same statement,
where four of these files called the 2-argument form and wrote the vector
after it. The columns the functions do not know — `type`, `importance`,
`sensitivity_tier`, `quality_score`, `source_type`, `status`, which
`schemas/enhanced-thoughts` adds and upstream's removed schema section used
to mirror (change 58) — are written beside the call by one raw update that
carries neither content nor vector: outside the rule by construction, and
nothing it writes goes stale. Metadata that these files read, spread and
wrote back whole now rides `p_metadata_patch`, which is `metadata || patch`
under the function's row lock — the same result, without the read. The
label is the caller's, as 021 requires: the four files that hard-coded
OpenRouter's model name pass it as a constant, `repo-learning-coach` passes
`OPENROUTER_EMBEDDING_MODEL`, and the three `_shared/helpers.ts` gained
`embeddingModelUsed()` — OpenRouter's name when that key is configured
(`embedText()`'s first choice), else OpenAI's under the same `openai/`
prefix, so one model has one label whichever path served it. The
provenance snippet's `derived_from` and `supersedes` ride the envelope (025)
and are validated there; its own `derivation_layer`/`derivation_method`
follow by an update of those two; on a re-capture of existing text the
function leaves that row's pointers as they were (change 66), where the
snippet's raw update overwrote them and its comment called that intended.
Migration 035's return — `id`, `fingerprint`, `existed` — is read beside
upstream's shape in both files that misread it, and `rest-api`'s `validateId`
and routes take a UUID or digits.

**File by file.** `update-thought-mcp`: the read before the write is gone —
it served a concurrency check the function makes under the row's lock (009's
point, and the race upstream's version has) and a metadata spread the patch
replaces; `NOT_FOUND`, `STALE_READ` (with the function's
`current_updated_at`) and `DUPLICATE_CONTENT` are the tool's three refusals,
and `duplicate_of`/`fingerprint_held_by` are reported as notes.
`enhanced-mcp`: `update_thought` takes the thought's UUID (the file's other
tools still take upstream's integer ids — SMD-1525), its own SHA-256 of the
normalised text no longer travels with the row (the function computes 003's),
and `brain_capture_thought` reads both return shapes and reports the
function's fingerprint. `agent-memory-api`: the write-back's thought is one
3-argument call. `open-brain-rest`: capture and edit both; an edit into text
another thought holds answers 409. `rest-api`: capture, edit and enrich; an
enrich passes the row's own text back — an unchanged edit, which 018 never
refuses — so the new vector takes its label and the previous vector's windows
go; an edit whose embedding call failed leaves the row without a vector and
without a label, not with the old vector under the new text — 021's rule,
and what the raw update used to leave — answers `embedding_updated: false`
with a message naming the enrich route, which refills it.
`consolidation-bio`: the profile's text and a vector the worker now makes
for it (its `_shared/helpers.ts` had `embedText`; the label helper joined
it) through `update_thought` — the profile is searchable, and a vector
`db/reembed.ts` gave the row between runs is replaced, not blanked; an
embedding failure fails the run and the previous profile stands.
`repo-learning-coach` and the provenance snippet: the 3-argument form; the
snippet resolves each well-formed `derived_from` ref against `thoughts`
first, because the function refuses a whole capture for a ref that names no
thought (032's `validate_derived_from`) where the raw update wrote the ghost
pointer unchecked — a deleted parent is `unresolved_refs` now, and the
capture lands. The Telegram sample: the edit branch through `update_thought`,
the model a named constant. The enhanced columns are written for a FRESH row
only: a re-capture of stored text leaves them, since both `_shared` files'
tier rule is escalation-only and a hand-set importance is the owner's — as
the function leaves that row's pointers (change 66).

**Check 10.** The mechanism, not the nine files' spelling: a PostgREST table
verb that replaces columns — `.update(` or `.upsert(` — on `thoughts`
(`.from("thoughts")` in either quote, Python's `.table("thoughts")`, line
breaks allowed before the verb) whose payload carries a `content` or
`embedding` KEY — an object literal (quoted, bare or computed key, the
shorthand `{ embedding }`, an array of literals for an upsert, an
`Object.assign(…)` of literals), or an identifier the file binds to one
anywhere (`const update = { embedding, … }`, `Object.assign(patch, { … })`,
`updates.content = …`, `patch["embedding"] = …`, the block walked); a key,
not a value (`summary: content` is not one), at the literal's top level
(`{ metadata: { content } }` is a metadata write); a row type on the client
and a line comment before the verb do not hide it — and the SQL form,
`UPDATE [ONLY] thoughts … SET` with either column assigned in the SET list
before its WHERE, or named in the tuple form `SET (…) = (…)`, `public.`,
quoted identifiers and an alias allowed. Word-bounded: `content_fingerprint
=` and `embedding_model =` are other columns. In every non-binary,
non-ignored file under the seven category directories and `docs/`, prose
included. Outside the rule, and said so: an `.insert(` (a fresh row around
the functions — no fingerprint, no label — is a different defect, SMD-1524 —
in the rule since change 71), a metadata-only update, a payload spread from another object, one that
arrives as a function's return value or parameter, a builder split across
statements, a table name held in a variable, Python's `dict(content=…)`, a
hand-built REST `PATCH` (none in the tree), and the remedy itself — the
dataflow cases are what the test is for. Thirty-five probes — one per
statement the audit found, in its own shape, plus the forms a rebase could
bring and the review passes' escapes — and twenty-seven non-probes run
on every invocation through the scan's own function; exceptions are per file
and counted, as checks 6–8's are, for a file whose README says it bypasses
the functions and what it leaves stale; the list is empty. A name bound to a
payload is one for the whole file, as check 8's bound credential is, and a
hit on a second, cleaner send of the same name is answered with a rename.
The checker's header now also names check 9 (change 65's fixture
redaction), which it had not.

**The test.** `extensions/test-writes.ts` (110 assertions), in the required
"SQL data layer against real Postgres" job, last: each writer that can run is
imported as deployed — the stand-in for Deno's two globals and the loader for
Deno's specifiers from `test-auth.ts`, plus one rewrite, `@supabase/supabase-js`
to `compat/supabase-sql`, so the two servers still on supabase-js run their
PostgREST calls as SQL against the same throwaway database — with the model
provider stubbed to a unit vector keyed off the text. The database is the
fork's migrations plus the two sidecars the writers assume,
`schemas/enhanced-thoughts` and `schemas/agent-memory`, applied as shipped
(Supabase's three roles created first, as the sidecar's header says), their
tables and functions dropped before the apply and again at the end whether
or not the run finished, because CI shares one Postgres across the job (the
roles, and the columns and indexes the enhanced sidecar adds to `thoughts`,
stay until the next suite's reset drops the table — nothing a later suite
reads; `db/ci-parity.sh` runs this suite in the same seat). For
each edit a row is planted as an older write left it — text, fingerprint, a
vector under its own label, two chunk rows of that vector — the writer edits
it, and the row is judged column by column and against a twin `update_thought`
edited directly with the same inputs: fingerprint of its own text, label,
vector, chunk count. Each capture's row is judged for the 3-argument form's
work. Also driven: `update-thought-mcp`'s `STALE_READ`, `NOT_FOUND` and
`DUPLICATE_CONTENT`, and a metadata-only edit leaving vector, label and
fingerprint alone; `enhanced-mcp`'s and `rest-api`'s captures returning a UUID
id rather than throwing; `rest-api`'s enrich relabelling and clearing planted
windows; a `rest-api` edit while the embeddings endpoint answers 500 leaving
the new text with no vector and no label and answering `embedding_updated:
false`, then the next edit re-embedding; a re-capture through `rest-api` and
`open-brain-rest` answering the same id as updated and leaving a hand-set
tier and importance; the enhanced columns landing beside each fresh capture.
The snippet, the sample and the worker are read, not run — a paste-in with
free variables, a README, and a run that needs an LLM pass over person notes
— and a guard holds the set of `.ts` files naming this change equal to the
set driven or read. One limit, stated in the file: the SQL shim binds a JS
number array as a Postgres array literal, so a regression to a raw `.update({
embedding })` with a `number[]` fails at the shim rather than at the column
assertions — loudly, not where the labels say — where PostgREST would coerce
it and the assertions would name the stale columns (they do for the vector
spelled as text).

**The width, and the label, are the operator's.** Every writer here embeds
with `openai/text-embedding-3-small`, 1536 wide — upstream's Supabase brain's
model — and now hands that vector to a function declared at the brain's
width. This fork's default is `qwen3-embedding:4b` at 1024 (`db/config.mjs`),
where the function refuses the vector and the whole capture or edit fails,
where the raw write failed the same way (`repo-learning-coach` saved the
thought and then threw; `consolidation-bio`'s first insert has no vector, so
its rewrites failed only from this change on) or had its error ignored
(`agent-memory-api` created the memory row over an unembedded thought). Loud
is right, and nothing here makes a vendored writer width-aware: each README
says the brain must be at `OB1_EMBEDDING_MODEL=openai/text-embedding-3-small`
and `OB1_EMBEDDING_DIM=1536`, and the test pins that width and says why. The
label the writers pass must equal the configured model's spelling for the
re-embed's pool to leave the rows alone (change 38's `poolModelFor`); the
helpers spell it `openai/…` whichever provider served it, and the README
sentence names the spelling.

**Decisions.** Updates, not inserts: the ticket's rule and the carry-forward
comment named the update, and an insert leaves nothing *stale* — it leaves
the pre-003 shape the backfills repair; six sites are filed as SMD-1524 with
the widening of check 10 they need — done in change 71, which found eight.
The enhanced columns stay a raw update
beside the function rather than a payload key: the function never read them,
and adding them would put a vendored schema's columns into a core function.
`rest-api`'s failed-embedding edit blanks the vector rather than keeping the
old one — the function's rule, stated in its README and in the response.
`enhanced-mcp`'s read tools keep their integer ids (SMD-1525): the ticket was
about writes. The top-level `type`/`importance`/… keys those two files put in
`p_payload` are dropped, since the fork's function ignored them and the
sidecar update carries them now. `update-thought-mcp` embeds before the
function can answer `NOT_FOUND`, where its old read refused first: one
provider call per misaddressed edit, not worth a read the function repeats.

**Review pass 1, triaged.** Two reviewers, one reading and one running
(mutating the converted files back and the rule's spellings, two runs on one
container, real PostgREST against the schema). Fixed: `consolidation-bio`
rewrote the profile with no vector, which would have blanked the one a
re-embed pass gave the row every run (HIGH); `rest-api`'s edit answered a
bare 200 when the embedding call failed and the row had lost its vector; the
provenance snippet's envelope made a ghost `derived_from` ref refuse the whole
capture, and its comment said the opposite; the three captures' sidecar
update ran on a re-capture too, downgrading a stored tier; the rule matched
`content` as a value and inside a nested object, and missed a row type on the
client, a comment before the verb, `Object.assign`, array payloads, a
computed key, `UPDATE ONLY`, quoted identifiers and the tuple form; the test
aborted without its teardown on a failed capture, and the orphaned
`agent_memories` row made the next run's write-back short-circuit on its
idempotency key; `db/ci-parity.sh` did not run the suite; the probe list
lacked the worker's statement and miscounted the files. Not fixed, and said
where: the shim's table verbs bind a `number[]` as an array literal
(pre-existing; every vendored `.insert({ embedding })` through the shim has
it — carried to SMD-1524, where the inserts left the table verbs and the
binding stayed); a name bound to a payload is one for the whole
file (check 8's stance); the embed-before-`NOT_FOUND` cost. Run for real:
PostgREST resolves `{p_content, p_payload, p_embedding}` to the 3-argument
form, a JSON `null` vector included, and 013's 4-argument form is never a
candidate; a stale `p_if_unchanged_since` answers `STALE_READ`; the vector
inside the 2-argument payload stores no vector (#379, reproduced).

**Review pass 2, triaged — the stop signal.** Eleven of the two reviewers'
findings were in the first pass's own additions. Fixed: `consolidation-bio`'s
gate admitted an Anthropic-only configuration that `embedText()` then
refused after the LLM call was paid for — refused at the gate now, and the
README says which keys embed; the two capture responses reported the tier and
type this call detected on a re-capture whose columns it had, by the first
pass's rule, left alone — they read the row back; check 10's verb line was
computed with a precedence slip that reported an `upsert` chain on the line
before its verb (the probe check counted hits only; it holds the line now),
its block walk read a brace inside a string as structure, its gap allowed a
line comment but not a block comment, its verb took no type argument, its
inline `Object.assign` branch read nested literals, and its SQL list took a
`CASE WHEN content =` compare as an assignment; `enhanced-mcp`'s fresh-row
gate had no test (a re-capture is driven); the test lost its tally when the
body threw; the bio worker's text guard admitted an embedding of the wrong
text; this section counted two helper files where three changed. Named, not
changed: the width and label paragraph above, which the second reading pass
found unsaid; a string value carrying `, content:` still reads as a key (the
rule reads prose by design); `+=` on a payload property is bound now.

**Boyscout.** What the passes cut for space, in the files this change
touched, no behaviour changed: check 10's key rule loses a dead alternative
(a literal's block always ends in its bracket, so a key is never last) and
its "outside the rule" list names the type-asserted, conditional and two-hop
payloads the second running pass found; `update-thought-mcp`'s `STALE_READ`
message says "unknown" rather than `undefined` when the row moved between
the function's check and its write (033's post-UPDATE return carries no
timestamp); this section's Verified paragraph is rewrapped and names the
third Deno check.

**Not done here.** SMD-1524 (six raw inserts of content and vector, and check
10's widening to them) — done in change 71. SMD-1525 (`enhanced-mcp`'s read tools cannot address
a UUID row). SMD-1480 held the deployability of `update-thought-mcp`,
`open-brain-rest`, `rest-api` and `consolidation-bio`, which import the shim —
done in change 74; their behaviour is exercised by `test-auth.ts` and
`test-writes.ts` under Bun.
`server/index.ts`, upstream's Edge Function, is untouched. The `docs/` READMEs
that show a SQL `UPDATE thoughts SET metadata …` are metadata-only and outside
the rule.

**Verified:** `bun scripts/check-fork-consistency.mjs` FAILED with check 10's
eleven hits in nine files before the conversions and PASS after, exception
list empty (35 probes, 27 non-probes, each probe caught on its verb's line);
`../db/with-postgres.sh bun test-writes.ts` 110/110 under podman, twice on
one container and after an aborted run; `bun test-auth.ts` 643/643 on the
converted files; `deno check --node-modules-dir=none` clean under Deno 2.9.6
for `enhanced-mcp`, `agent-memory-api` and `consolidation-workers/metadata-norm`
(the edited helpers' other importer), the three that resolve under Deno;
every shim-migrated file still parses, and the codemod round-trips — PR #55's
first CI run failed that step alone: `migrate-to-sql-shim.mjs` rewrites every
quoted `@supabase/supabase-js` it finds, and the test's loader compared a
specifier to that literal; it matches by regex now, the codemod unchanged.
The ticket's verify — the check fails
on the files today and passes after; an edit through each leaves
`content_fingerprint`, `embedding_model` and `thought_chunks` as
`update_thought` would, one round trip each against `with-postgres.sh` — is
the test.

**Upstream status:** not applicable — the raw writes are upstream's, the
functions they now call are this fork's. Upstream #379 reports the
return-shape half against its own tree; the two files that misread the
return here read both shapes now.



### 70. The routing count is gated by a sample of the heap — migration 037 reads eight random pages before 014's capped GIN collection and skips it when the sample says the filter is far too broad for the exact branch (SMD-1463)

Change 28's "At scale" section ended on two costs that grow with the table, and
this is the first of them. Every filtered `match_thoughts` call since migration
014 opened with the routing statement — `SELECT array_agg(id) FROM (SELECT id
FROM thoughts WHERE metadata @> filter AND <scoreable> LIMIT v_exact + 1)` —
to decide between the exact branch and the HNSW walk. GIN builds its whole
bitmap for the filter before the first row comes back, so the `LIMIT` caps the
heap fetches and nothing else: the statement costs the number of *matching*
rows, about 50 ns each, whatever it returns. SMD-1018 measured it through
`db/bench-hnsw.ts` section C on the 50% tier: 0.8 ms at 10,000 rows, 3.0 at
100,000, 27 at a million, 240 at ten million — nine tenths of that tier's
whole call at ten million, where the walk that follows needs some eighty
tuples. The twelfth review pass of 014 had named the mitigation — estimate the
match count first, run the collection only when the estimate is plausibly
under the threshold — and declined it for want of a number. The ticket's
brief: bias the guess towards running the collection (a wrong estimate that
runs it costs what today costs; one that skips it sends a thin filter to the
walk, which is correct but slower and, at a million rows, can return short),
keep the empty filter at one GIN probe, and hold `test-schema` [8b], [8c] and
[8d]. The last held up to about a million rows; the third finding below says
where and why not beyond.

**Migration 037.** On a heap of at least 8,192 pages (64 MB), a filtered call
first reads eight random pages of `thoughts` through `TABLESAMPLE SYSTEM` and
counts three things: the sampled rows that pass the filter and carry a vector
(`hits`), the distinct pages those rows sit on (`hit_pages`), and the distinct
pages the sample reached (`pages_seen`). The collection is skipped — the call
goes straight to the walk — only when all three hold:

1. `hits × pages ≥ 10 × v_exact × pages_seen` — the sample, scaled to the
   table, puts the filter at ten times the exact threshold or more. Ten is the
   bias.
2. `hits ≥ 8` — a floor on the evidence. At ten million rows the first
   condition is met by a single sampled row (eight pages of some 526,000 are
   one sixty-five-thousandth of the table; one hit scales to 65,000), and one
   row is luck. Eight from a filter matching exactly `v_exact` thoughts there
   has probability about 1e-19; from one matching 1% of the table, about two
   in a thousand measured (the table below: 2 of 1,000 draws) — the Poisson
   figure is two in ten thousand, and `SYSTEM`'s page-level variance is the
   difference.
3. `hit_pages ≥ 3` — `SYSTEM` sampling is by page, so a filter whose matches
   sit together on disk (one import, one day's captures, one tag written in
   one session) shows the sample a page full of hits or nothing, and one full
   page passes the first two conditions by itself. Three different pages means
   three separate draws landed on the filter; for a contiguous run of
   `v_exact` rows that is C(8,3) × (run pages / heap pages)³ — about 1e-5 at
   the floor, 6e-8 at a million rows, 6e-11 at ten million. The layout the
   rule is weakest against sits between those two: a few matches a page over
   hundreds of pages — a tag on four captures a day for most of a year —
   where three sampled pages already hold eight hits. For `v_exact` rows four
   to a page that is C(8,3) × (250 / heap pages)³: about 2e-3 at the floor,
   7e-6 at a million rows, 7e-9 at ten million. The first review pass found
   the layout; measured on a 6,826-page heap, where the formula says 2.8e-3,
   995 such rows were skipped 13 times in 20,000 draws — 6.5e-4, under the
   bound because condition 1 is marginal with exactly three hit pages
   (twelve hits scale to barely ten times the threshold and fail it whenever
   the draw reached nine pages). The second pass corrected the figures here,
   which had quoted that measurement as the formula's output. `hit_pages ≥ 4`
   would make the bound C(8,4) × f⁴, about 6e-5 at the floor (1.3e-4 on the
   6,826-page heap, where 4 of 20,000 draws — 2e-4 — were measured), at two to
   three points of the broad filters' skip rate — the knob if that band
   matters; the rule ships as measured.

Anything less runs the collection exactly as before — the same statement,
token for token, indented two spaces further inside an `IF` (test-schema [20]
compares it with 014's, whitespace collapsed) — and the same routing after it. Under the floor nothing
runs but that collection: a brain of a few thousand thoughts never reads the
sample, and its empty-filter probe stays the one GIN probe 014 made it. The
page count and the floor are `config.mjs` constants (`ROUTE_SAMPLE_PAGES`,
`ROUTE_ESTIMATE_MIN_PAGES`) templated into the file, so the header, the bench
and the tests read one value; they are not operator knobs, and a suite lowers
the floor only to reach the gate on a small table (`SchemaOptions.routeEstimateMinPages`).
The threshold, the three branches, the walk's bounds and the plan mode are
untouched — SMD-1464's questions. 037 is now the last definer of
`match_thoughts`, which is what preflight's remedy and the suites'
`restoreShipped` apply *alone*, so it carries 020's `DROP` of the 4-argument
form and 020's replay of that form's privileges onto the new one: a hand
re-apply of 014 or 019 puts the 4-argument form back beside the 6-argument one
and every 4-argument call is "function is not unique"; the first draft of this
file left that to 020 and test-schema [8c] found the two forms at once. On a
database in order the `DROP` finds nothing, the capture reads an empty ACL, and
`CREATE OR REPLACE` over the same signature keeps the function's privileges
(test-upgrade [14] holds both directions). The same review found the mirror
image in preflight's signature remedy: "apply 020" re-installs 020's
`search_thoughts_hybrid` too, without change 48's relative floor — test-live
[5d]'s first run did exactly that and [15] failed behind it — so the remedy
now names 020, then 027 and 037, the last definers of the two functions.

**Why a sample, and why this one — measured on a 500,000-row scratch corpus of
the bench's shape before the file was written.**

- *Not the planner's estimate*, which the ticket offered first. An `EXPLAIN`
  of the predicate costs 0.7 ms and said 297,980 for a filter matching 249,623
  rows, 50,505 for 49,994, 10,101 for 5,007 — and 50 for every filter under
  that: 479 rows, 52, 895, a 1,000-row cluster and one matching nothing, all
  50. jsonb has no per-key statistics; `@>` is priced from the column's
  most-common *whole* values, which on the bench's few metadata shapes covers
  the broad filters and on a real brain, where every row's metadata differs by
  a timestamp or a title, covers none — every filter gets the default, one per
  cent of the table, which at ten million rows is 100,000 for a filter
  matching five and would send every thin filter to the walk: the opposite of
  the bias asked for.
- *`TABLESAMPLE SYSTEM`, not `BERNOULLI`*: `BERNOULLI` decides per row and reads
  every page; `SYSTEM` decides per page and reads eight — 0.10 / 0.14 / 0.24 /
  0.39 ms of execution for 4 / 8 / 16 / 32 pages, the same for the 50% filter
  and the empty one, because the cost is the rows read, not the rows that
  pass. Eight pages: a 10% filter puts sixteen expected hits in 160 sampled
  rows and was skipped in 908 of 1,000 draws, a 50% filter in 984 (the misses
  are mostly draws with fewer than eight hits — `SYSTEM` picks a binomial
  number of pages, and two hits a page compound that variance; on a
  6,826-page heap the first review pass counted 1,109 such, 345 that failed
  condition 1 at that small heap, and 45 that reached fewer than three pages,
  of 1,499 misses in 20,000 draws); sixteen pages bought 998 and 1,000 for
  0.1 ms more on every
  filtered call, and the empty filter's own probe is 0.012 ms, so the sample
  is already the larger part of that call. No `REPEATABLE` seed: a fixed seed
  reads the same pages every call, which is a warm cache and a systematically
  wrong sample of a clustered filter.
- *The hit is `metadata @> filter AND embedding IS NOT NULL`*, not the
  collection's `OR EXISTS (chunk)`: inside a SELECT-list expression the
  `EXISTS` became a hashed subplan — the planner built a hash of the whole
  chunk table before the sample scan started, 18 ms — where the collection's
  WHERE-clause `EXISTS` is an index probe per row that lacks a vector. Not
  counting a chunk-only row lowers the estimate, which biases towards running
  the collection, which counts it; [8d]'s answer is unchanged.
- *`pg_relation_size`, not `relpages`*: `relpages` is a statistic, 0 on a table
  never analysed — a bulk import queried before autovacuum reaches it — which
  would put the share at 100% and sample the whole heap (the prototype did
  exactly that, once). `to_regclass('thoughts')` rather than a `regclass`
  literal, which binds the OID at plan time and would size a table a suite
  has since dropped and recreated.
- *The floor* is where the bitmap can cost more than the sample: at 50 ns a
  matching row, 8,192 pages — some 160,000 rows at the bench's width, fewer
  with long content, more at the shipped width with short content (the
  vectors are TOASTed, so the heap holds ~65–80 rows a page there) — puts the
  collection at 4 ms for a 50% filter against a sample of 0.15 ms on every
  filtered call.

**The rule, tried a thousand times per filter on that corpus** (24,999 pages,
`v_exact` 1,000; `skip` is how many of 1,000 draws met all three conditions):

| filter | matching rows | placement | skipped, 8 pages | skipped, 16 pages |
| --- | ---: | --- | ---: | ---: |
| 50% | 249,623 | uniform | 984 | 1,000 |
| 10% | 49,994 | uniform | 908 | 998 |
| 10,000 rows | 10,000 | one contiguous run | 1 | 3 |
| 1% | 5,007 | uniform | 2 | 19 |
| 2,000 rows | 2,012 | uniform | 0 | 0 |
| 1,000 rows | 1,000 | one contiguous run | 0 | 0 |
| 900 rows | 895 | uniform | 0 | 0 |
| 0.1% | 479 | uniform | 0 | 0 |
| 0.01% | 52 | uniform | 0 | 0 |
| nothing | 0 | — | 0 | 0 |

Every filter at or under the threshold — the five bottom rows, the contiguous
1,000 among them — ran the collection every time on that corpus; the
thin-spread layout, measured separately on a 6,826-page heap, is the exception
condition 3 describes above. The two filters between one
and ten times the threshold (5,007 and the contiguous 10,000) were skipped
once or twice in a thousand, and a skip there is not a wrong answer: both are
above the threshold, so the collection would have routed them to the walk
anyway. The broad filters, where the collection costs, were skipped nine
times in ten or better.

**Through the function, before and after, on the machine change 28 describes**
(Apple M5 Pro, podman VM, 8 vCPUs, 14.8 GB, pgvector 0.8.6 at its image
defaults; `db/bench-hnsw.ts`, the before pass from the tree without 037 and
the after pass with it — reproducible from one tree as `OB1_BENCH_UPTO=035`
against the default, which the bench gained for this). Section B, ten asked,
median over 50 random queries:

| rows | filter | matching rows | before: in exact top-10 | median ms | after: in exact top-10 | median ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 100,000 | 50% | 49,991 | 6.6 | 6.85 | 6.4 | 5.54 |
| 100,000 | 10% | 10,116 | 8.6 | 12.45 | 8.8 | 10.10 |
| 100,000 | 1% | 998 | 10.0 | 3.17 | 10.0 | 2.66 |
| 100,000 | 0.1% | 90 | 10.0 | 0.55 | 10.0 | 0.57 |
| 100,000 | 900 rows | 910 | 10.0 | 3.03 | 10.0 | 2.44 |
| 100,000 | 0.01% | 6 | 6.0 | 0.23 | 6.0 | 0.25 |
| 100,000 | nothing | 0 | 0.0 | 0.19 | 0.0 | 0.21 |
| 1,000,000 | 50% | 499,443 | 2.8 | 36.54 | 2.8 | 10.38 |
| 1,000,000 | 10% | 99,748 | 5.2 | 47.06 | 5.4 | 37.26 |
| 1,000,000 | 1% | 9,951 | 10.0 | 31.06 | 8.8 | 242.44 |
| 1,000,000 | 0.1% | 1,034 | 10.0 | 8.17 | 10.0 | 6.31 |
| 1,000,000 | 900 rows | 934 | 10.0 | 6.42 | 10.0 | 4.34 |
| 1,000,000 | 0.01% | 99 | 10.0 | 0.95 | 10.0 | 1.16 |
| 1,000,000 | nothing | 0 | 0.0 | 0.21 | 0.0 | 0.43 |
| 10,000,000 | 50% | 4,998,406 | 0.9 | 240.87 | 0.8 | 13.22 |
| 10,000,000 | 10% | 999,827 | 2.1 | 138.07 | 2.1 | 45.18 |
| 10,000,000 | 1% | 99,633 | 5.8 | 545.81 | 10.0 | 726.15 |
| 10,000,000 | 0.1% | 10,231 | 10.0 | 97.11 | 10.0 | 92.60 |
| 10,000,000 | 900 rows | 886 | 10.0 | 9.83 | 10.0 | 10.93 |
| 10,000,000 | 0.01% | 959 | 10.0 | 9.26 | 10.0 | 11.50 |
| 10,000,000 | nothing | 0 | 0.0 | 0.27 | 0.0 | 1.31 |

Section C, the two statements themselves, extracted from the deployed body and
explained (execution time): the collection under a forced custom plan; the
sample from the first after pass's JIT-off arm, because its other two arms
were mispriced by the extraction the third finding describes — the corrected
bench prices all three within 0.05 ms of each other (1.11 / 1.09 / 1.07 at
ten million), so the column is the sample's cost, not a plan mode's:

| rows | filter | matching rows | route (the collection): before ms | after ms | estimate (the sample): after ms |
| ---: | --- | ---: | ---: | ---: | ---: |
| 100,000 | 50% | 49,991 | 2.70 | 2.54 | 0.11 |
| 100,000 | 0.01% | 6 | 0.04 | 0.04 | 0.09 |
| 100,000 | nothing | 0 | 0.01 | 0.02 | 0.14 |
| 1,000,000 | 50% | 499,443 | 25.40 | 24.05 | 0.22 |
| 1,000,000 | 0.01% | 99 | 0.65 | 0.60 | 0.19 |
| 1,000,000 | nothing | 0 | 0.02 | 0.01 | 0.21 |
| 10,000,000 | 50% | 4,998,406 | 250.45 | 217.14 | 0.94 |
| 10,000,000 | 900 rows | 886 | 5.55 | 5.72 | 1.04 |
| 10,000,000 | nothing | 0 | 0.02 | 0.03 | 0.99 |

Read down the tables and four things fall out.

- **The broad tiers lose the collection, and at ten million rows that is
  most of the call.** 50% at ten million: 241 ms → 13, the 250 ms bitmap
  gone; at a million 36.5 → 10.4. 10%: 138 → 45 and 47 → 37 — the gate
  skips a 10% filter nine times in ten (the misses are mostly draws with
  fewer than eight hits; the page count is binomial and two hits a page
  compound its variance), and the walk that follows costs what it always
  cost. The recall columns are the index's and did not move (0.8
  and 2.1 at ten million, 2.8 and 5.4 at a million — change 28's floor).
- **The thin tiers and the exact branch are unchanged, plus the sample.**
  900 rows: 9.8 → 10.9 ms at ten million, 6.4 → 4.3 at a million (cache
  warmth; the same tier ran 5.7–9.3 across change 28's passes); every one
  returned 10 of 10 in the exact top-10 before and after, as [8b]–[8e] and
  [5d] hold them to.
- **The empty filter pays the sample, and the sample's cost grows with the
  heap — about 2 ns a page — not with what the buffer pool holds.** 0.21 →
  0.43 ms at a million rows (50,000 pages), 0.27 → 1.31 at ten million
  (526,000). This section's first draft blamed uncached page reads against
  the image's 128 MB `shared_buffers`; the first review pass read the
  bench's own section C the other way (0.11 / 0.21 / 0.99 ms at 5,000 /
  50,000 / 500,000 heap pages is a line — a tenth of a millisecond for the
  eight pages' rows plus ~2 ns a page — not a cache effect) and the
  measurement agreed: one row a page, every page warm in
  the OS page cache (the larger two heaps exceed the image's 128 MB
  `shared_buffers`; change 80's fourth review pass), the statement costs 0.038 ms at 2,000 pages, 0.094 at
  20,000, 0.459 at 200,000. `TABLESAMPLE SYSTEM` decides per page by hashing
  every block number against its cutoff, so the eight page reads are the
  small part. So the ticket's "the estimate must not cost more than the
  0.01–0.2 ms the empty filter does today" holds up to about a million rows
  and not beyond: on this VM at ten million the shape enhanced-mcp sends on
  every call costs a millisecond more, against 228 ms less on the 50% tier
  and 93 less on the 10%, and by the slope a hundred million rows would pay
  10 ms on every filtered call. Sizing `shared_buffers` does not change it;
  a different sampling statement does — eight TID range probes, eight page
  reads whatever the heap, which also counts sampled pages exactly where
  `pages_seen` today misses an empty one — and that is SMD-1526 (done:
  migration 038, change 80). The bench's own
  `estimate` row at ten million read 60 ms under both plan modes and 0.94
  with JIT off, which is why the table's last column is the JIT-off figure:
  the extraction had substituted the sample share as its declaring
  expression (`pg_relation_size` is volatile), the planner could not size
  the sample scan and priced a scan of the whole heap, and that estimate
  crossed `jit_above_cost` — the function's own custom plan knows the
  parameter's value and pays none of it, which the 1.31 ms call is the proof
  of. The bench now substitutes the evaluated share (`routingAt` returns it),
  and a second ten-million-row after pass with that fix priced the row at
  1.11 / 1.09 / 1.07 ms across the three arms on the 50% filter and
  0.99 / 1.03 / 1.07 on the empty one, with section B reproducing within the
  spread (50% 13.3 ms, 10% 42.6, the empty filter 1.33).
- **The 1% tier is the planner's coin, as before.** At a million rows it was
  served from GIN under the walk branch in the before pass (31 ms, 10 of 10)
  and walked HNSW in the after pass (242 ms, 8.8 of 10); at ten million GIN
  served it both times (546 and 726 ms). Change 28 found the same flip
  between its own passes on the same rows under a fresh `ANALYZE`; the gate
  is not in it — a filter at 1% of a million rows (9,951) is skipped twice
  in a thousand draws, and either way the collection routed it to the walk
  branch, whose plan the coin decides. That band is SMD-1464's.

**What it costs where it does nothing.** Under the floor — 10,000 and 100,000
rows in the bench, every real brain today — the body computes two locals at
entry (the heap's page count and the sample share, ~5 µs) and nothing else
changes; the 100,000-row rows above differ by the pass-to-pass spread. Above
it, every filtered call pays the sample: 0.2 ms at a million rows and about a
millisecond at ten million, growing with the heap (the third finding above),
and the thin tiers move by less than the spread.

**Not done here.** A recency-weighted call at the ceiling count flips the
WALK statement (014's, not this change's) onto plpgsql's generic plan after
five costly custom plans, and the flipped plan — a GIN bitmap with a top-N
sort — answers a broad filter with the exact top-n where the custom plan's
HNSW walk answered approximately: identical calls from two sessions differ in
their rows, not only their cost. The fourth review pass met it in a
concurrency run (218 differing answers across 800 calls, 0 under
`plan_cache_mode = force_custom_plan`) and traced every difference to that
flip; the sample statement stayed on custom plans throughout. It is
SMD-1464's plan-mode question, with one more fact for it. Preflight has no
recogniser for 037's body (a 020 paste
under a 037 ledger passes; the operator's path above), as it has none for
027's: a `TABLESAMPLE SYSTEM (v_pct)` regex or a sentinel of 037's own would
give the `filtered search` check a "037's body" detail, the way `atomic
capture` names 035's — a line for the next preflight change, not this one.
The sample's per-page cost and its `pages_seen` denominator
are SMD-1526 (TID range probes in place of `TABLESAMPLE SYSTEM`: eight page
reads whatever the heap, sampled pages counted exactly — done: migration 038,
change 80). The threshold, the
plan mode and which of the two seeded bounds bites are SMD-1464; `ef_search`
on real vectors is SMD-1465. One thing
the prototype saw in passing belongs with SMD-1464: with `enable_seqscan` on,
the planner ran the 50% collection as a sequential scan with a `LIMIT` — 1.3 ms
against 12.6 for the GIN bitmap it takes under 019's `enable_seqscan = off` —
so 019's setting, right for the vector CTEs it was measured on, is what makes
the collection's cost the bitmap's on a broad filter; a `LIMIT`-shaped
alternative for that one statement is a plan question, not this change's, and
its estimate would rest on the same `@>` selectivity this change found
uninformative on real metadata. A hundred million rows was not run, for the
reasons change 28 gives.

**Verified:** `db/test-schema.ts` 868/868 under PGlite on the merged tree, [8e] new (the
shape, the floor, exactness with the gate reached at floor 0) and [20]'s
definer pin moved to 037; `db/test-live.ts` 500/500 on real Postgres, [5d]
new (25,000 rows at the configured width, the gate reached, the broad filter
makes one GIN scan fewer per call than under 020's body and the thin filter
the same, both exact); `db/test-upgrade.ts` 173/173, [14] new (037 onto a
populated 035: no column, signature, row or privilege moves; 014 re-applied by
hand, then 037 alone, leaves one form); `server-portable` `tsc --noEmit` clean;
`bun scripts/check-fork-consistency.mjs` PASS (check 7 reads 037 as
`match_thoughts`' owner from the files); `bench-hnsw.ts` before and after at
100,000, 1,000,000 and 10,000,000 rows, above. Three review passes, two
reviewers each. Pass 1 (SQL and TypeScript): the sample's cost model (~2 ns a
heap page, not eight uncached reads), the thin-spread layout's skip bound,
and the bloat bullet's direction (an empty sampled page inflates the estimate
rather than deflating it) — all stated above, SMD-1526 filed; on the
TypeScript side nothing above LOW — an [8e] assertion that passed by the
punctuation of a comment, a catch-all in the bench that would have read a
rewrite failure as "before 037", cleanup-on-failure in [5d] and [8e], a stale
change number on the README line this change extended (034 is change 65), the
older missing-hybrid remedy still stopping at 020, `OB1_BENCH_UPTO` accepting
a prefix before 014. Pass 2 (docs and run-it): pass 1's thin-spread figures
had quoted the measurement as the formula's output (corrected above), the 10%
misses' cause named, `config.mjs` and the body comment repriced; every claim
tried on a real Postgres — custom plans on every call (the generic plan is
priced 200× the custom one and never adopted), NULL and array metadata, empty
and floor-sized tables, a SELECT-only role in a READ ONLY transaction, the
hybrid, `migrate.ts` apply / re-run / `--reapply` — no defect; the
bloated-heap measurement and the generic-plan sentence added; [8e] judges
five draws by the rule. Pass 3 (operator walkthrough and a coherence read of
the documents): the `hit_pages ≥ 4` bound had repeated pass 1's error
(6e-5 at the floor, not the measured 2e-4), the 1% filter's "two in ten
thousand" was the Poisson figure where the table shows two in a thousand,
this paragraph described one pass, the header narrated its own review
history — all rewritten; the operator's path is the next paragraph. Pass 4
(adversarial run-it and a fresh-eyes read of the TypeScript): 800 concurrent
filtered calls on sixteen connections with no error, deadlock or answer the
collection's route would not have given (0 differences under pinned plans);
exact-branch recall 1.000 across match_count 10 / 100 / 500 with and without
a recency weight; every odd filter shape and a table moved to another schema
behave as 020; [5d] costs 11 s of the 94 s suite. Two header sentences added
— the bounds are the default count's (at the ceiling, condition 1 keeps the
10% filter's collection near the floor), and a temp table shadowing the name
is sized while the cached plans read the real one, the safe side under the
floor — and [5d]'s cleanup no longer masks the section's own error.

**The operator's path, walked in pass 3.** A brain at 035 with rows, upgraded
by `bun db/migrate.ts`: "037 applied, 1 applied, 35 skipped", one
`match_thoughts` carrying the sample, the two SET clauses and `ROWS 10`;
preflight run as the compose stack runs it reports `search signatures`,
`filtered search`, `candidate scan`, `hybrid search`, `atomic capture` and
`migration ledger` all ok, nothing attributable to 037. The same brain with
020's file pasted over 037 by hand: preflight still reports ok — it has no
recogniser for 037's body (nor for 027's), the ledger records both, and both
020 bodies answer every call correctly, so what is lost is 037's cost bound
and 027's ranking floor, a degradation preflight's stated scope does not
cover; the ledgered remedy it prints for every stale-body state,
`migrate.ts --reapply`, restores both. A brain built by hand from the guide
and adopted with `--baseline`: preflight fails loudly on `filtered search`
and `hybrid search`, and following the printed remedies ends at 037 and 027
with every check ok. The PostgREST contract — six argument names, the
`RETURNS TABLE` shape — is byte-identical to 020's. The README's two bench
commands run and label their arms `after (014–035)` (no estimate row, the
"declares no sample share" note) and `after (014 on)` (three estimate rows).

**Upstream status:** not applicable — 014's routing statement is this fork's.

### 71. The vendored captures that inserted a thought go through the 3-argument `upsert_thought` — eight files off a raw `INSERT` into `thoughts`, three deployments with a database of their own say they bypass it, and check 10 holds the insert (SMD-1524)

`integrations/readwise-capture/index.ts`,
`integrations/consolidation-workers/bio/index.ts` (its first run),
`recipes/editorial-policy/auditor/index.ts`,
`recipes/adaptive-capture-classification/capture-with-gating.ts`,
`recipes/local-ollama-embeddings/embed-local.py`,
`recipes/readwise-import/import-readwise.py`, the samples in
`integrations/telegram-capture/README.md` and
`integrations/slack-capture/README.md`; headers on
`integrations/kubernetes-deployment/index.ts`,
`recipes/vercel-neon-telegram/src/lib/db.ts` and
`recipes/schema-aware-routing/index.ts`; `scripts/check-fork-consistency.mjs`
(check 10); `extensions/test-writes.ts`; their READMEs and
`recipes/local-brain-no-mcp/README.md` (Linear SMD-1524, filed from change
69's audit). Change 69 moved every vendored *update* of a thought's `content`
or `embedding` onto the functions and drew its rule at the update, because an
update leaves something *stale*; it named the other door and left it: a raw
`INSERT` of a fresh row with content, or content and a vector, around the
3-argument `upsert_thought`. The ticket named six sites. Check 10's first run
with the insert in its rule found eight hits in eight files — the two the
ticket's grep had not reached being `editorial-policy`'s auditor, which
stored every weekly report as a raw row, and `schema-aware-routing`, which
turned out to write a database of its own — and a hand search found two
more the rule cannot see: the readwise backfill's batch insert of a list
built by comprehension, and the Ollama recipe's `POST /rest/v1/thoughts`.
What a raw insert leaves is not stale but *missing*: `content_fingerprint`
NULL — 003's rule is in the functions, 016's trigger does not fill it, so the
row is invisible to dedup until 023's backfill runs, and a later capture of
the same text through `upsert_thought` makes a twin, which is the duplicate
the fork's whole fingerprint machinery exists to refuse; `embedding_model`
NULL — 021's vector of unknown model, which the re-embed pool treats as not at
the target and re-embeds; and, where the writer holds a key, no name for
008's audit row — the functions record an actor the caller passes, a raw
insert has nowhere to pass one. Two of the eight
were worse than the shape: the bio worker's first run computed its own
fingerprint and stored **no vector at all** (the comment said `upsert_thought`
would drop the enhanced columns, which is true, and is what the sidecar
update change 69 gave the rewrite path is for), so the first profile was
unsearchable until a re-embed pass reached it; and the classification
recipe's example inserted `tags`, `project` and `due_date` as columns
`thoughts` has never had, so it failed on any brain.

**The mechanism** is change 69's, on the capture side. A capture is one call
to the 3-argument `upsert_thought(p_content, p_payload, p_embedding)` with
`embedding_model` in the payload — the function writes the text, its
fingerprint, the vector and the vector's label in one statement under 033's
lock order, sets 008's actor from `p_payload.actor` when the caller names one,
and answers `{id, fingerprint, existed, supersedes}`; a text the brain already holds comes back `existed` with its
metadata merged and its vector replaced, which is what a re-sent webhook or a
re-run backfill should do, and what a raw insert could not (the readwise
backfill bisected its batches to find the row a unique violation aborted
them on — gone with the batch). The enhanced-thoughts columns the function
does not know (`source_type`, `type`, `importance`) follow by an update that
carries neither content nor vector — for the bio worker on a fresh row only
(`existed` skips it), for the receiver and the backfill wherever the columns
are NULL (the second pass, below) — so a re-capture leaves a hand-set tier
alone, change 69's escalation-only stance. Where the writer makes no vector — the auditor's report, the
classification example — `{p_content, p_payload}` resolves to the 2-argument
form and the row waits, labelled NULL as a vectorless row should be, for a
re-embed pass; the files say so, and say that this form answers `{id,
fingerprint}` only — no `existed` — so a vectorless writer that wants a
fresh-row gate must pass the 3-argument form with a JSON `null` vector (the
review pass ran both through real PostgREST). The readwise receiver and the auditor are
driven in `test-writes.ts` (the receiver behind a stubbed Readwise book
lookup and the `readwise-books` sidecar, now the third the suite applies and
drops); the bio worker's first run, the classification example, the two
Python recipes and the two README samples are read by regex there. Per
file: `readwise-capture` — one call with the label constant the file now
names, the sidecar per column where it is NULL, `existed` answered `ok` and
the book counter still incremented; `consolidation-bio` — the first run embeds the
profile as the rewrite path does and captures it whole, a concurrent run's
`existed` row reported as not created and left its columns,
`computeContentFingerprint` no longer imported; `editorial-policy` — the
report through the 2-argument form, its window timestamps keeping two reports
two rows; `adaptive-capture-classification` — the 2-argument form with the
classifier's fields in metadata, and the note that the capture MCP tool is
the better call there; `embed-local.py` — `POST /rest/v1/rpc/upsert_thought`
with the Ollama model's bare name as the label (the spelling
`OB1_EMBEDDING_MODEL` uses for an Ollama model, so `db/reembed.ts` sees these
rows as at its target or not), `existed` reported per thought, and the
"ALTER the column" advice answered by a fork note (the width is
`db/config.mjs`'s); `import-readwise.py` — one call per row, the bisection
and its `APIError` gone, `existed` counted as already present, the sidecar
per fresh row, a slower backfill said in the README; the two samples — the
3-argument call with the label constant, Slack's sample gaining the constant
Telegram's already had.

**Check 10** widens to the insert: a PostgREST `.insert(` on `thoughts` whose
payload carries either key — a literal, an array of literals, a bound name,
and a name filled one literal at a time by `x.push({ … })` or Python's
`x.append({ … })`, a binding form the update rule did not need — and the SQL
`INSERT INTO [public.]thoughts [[AS] alias] (<columns>)` whose column list
names `content` or `embedding` (quoted or not; word-bounded, so
`content_fingerprint` and `embedding_model` are the other columns they are;
`INSERT … SELECT` with a list caught, `VALUES` or `SELECT` without one
outside the rule, said so). The one insert the non-probe list carried as
"outside" moved to the probes, joined by thirteen more — each site's own
shape and the forms a rebase could bring — and ten non-probes: another
table's insert with a `content` column, the other columns, no column list,
a metadata-only row, the remedy, prose naming the statement, the
comprehension the rule cannot see. Sixty-one probes, forty-one non-probes
(eleven and four from the review passes), each probe held to its verb's line. **Exceptions, seven, the list's first
entries** — none a bypass a fix here could remove, each a file whose header
or README says what its rows lack: three deployments whose database is their
own, built from the guide's shape, where the fork's functions are not —
`kubernetes-deployment` (its own Postgres in the cluster, `k8s/init.sql`),
`vercel-neon-telegram` (Neon, `sql/001-create-thoughts.sql`) and
`schema-aware-routing` (a five-table project from its README's SQL, a
`thoughts` with `domain`/`status`/`source` columns) — the first two the same
files check 7 excepts for creating a brain rather than adding to one; the two
guides that show upstream's `upsert_thought` body and the `local-brain-no-mcp`
container init that shows its own, where the `INSERT` is the function's; and
`test-writes.ts` itself, which plants a row as an older write left it,
fingerprint and label by hand, for the writer under test to move whole. The
Kubernetes and Neon READMEs say how to get a fork-shaped brain there instead
(apply `db/migrations/` in place of the init script; backfill and re-embed
data moved across); the routing README says to capture through the function
and keep its three columns in metadata.

**Decisions.** The three own-database deployments are excepted, not
converted: routing their captures through a function their database does not
have would break them, and replacing their init scripts with the fork's
migrations is a deployment change beyond a write audit — each README says
the path. The shim's table verbs still bind a `number[]` as a Postgres array
literal (change 69's carried finding): after this change no vendored table
verb carries a vector, so the dependence is gone rather than the binding
fixed, and the binding stays because the shim cannot tell a vector from an
`int[]` column by the array's shape — `rpc()` can, because a function
parameter is typed. The readwise backfill stores one row per call rather
than a batch: PostgREST has no batch RPC, a duplicate is now the function's
answer rather than a violation to bisect for, and the cost — a few minutes
per ten thousand highlights against a batch of twenty-five — is the
backfill's to bear, said in its README. The Ollama label is the model's bare
name, not `ollama/<name>`: the fork spells `OB1_EMBEDDING_MODEL` that way
(`qwen3-embedding:4b`), and a label the re-embed pool does not recognise as
its target is a row it re-embeds. The bio worker's first run pays for an
embedding it did not before — the rewrite path already did, and an
unembedded profile is one nobody finds. The two vectorless captures use the
2-argument form by omission rather than passing a JSON `null` vector: the
form is the function's own, and the label rule (NULL with no vector) holds
either way. `INSERT INTO thoughts VALUES (…)` without a column list stays
outside the rule: the statement does not say which columns it writes, and
none is in the tree.

**Review pass 1** (a reading reviewer and a running one, the latter in its
own worktree with real PostgREST v12.2.3 beside the database; eleven
findings, none above MEDIUM: eight fixed, two noted, one informational). The
readwise backfill read the
function's reply with `isinstance(data, dict) else {}` and skipped any other
shape as "already present" — a client wrapping the reply in a list or a
string would have stored every row and written no sidecar, silently; the
reply is unwrapped from those two shapes now and a reply naming no id raises
(both reviewers, independently; the running one confirmed postgrest-py's
current shape is the dict). The backfill's sidecar was one update per row —
two round trips per highlight, and the README's "a few minutes per 10K"
undercounted by an order — and is one update per batch over the fresh ids
now, the README saying ten to twenty minutes. The classification example's
comment and README promised the enhanced `type` column and wrote only
metadata; reworded, with the 3-argument-with-null path named for a writer
that wants a fresh-row gate. The receiver's book counter still counts an
`existed` highlight (Readwise's semantics) — said in the README. The Ollama
recipe's summary counted an `existed` row as ingested; a separate line now,
and its own `metadata.embedding_model` key explained beside the column. A
`-- comment` inside a multi-line SQL column list read as a column; stripped,
one probe and one non-probe added (50/37). The bio guards in the test
matched one spelling of the call; they hold the three arguments in any
order, and the header says the guards are spelling-sensitive by design. Not
fixed, and said: `computeContentFingerprint` in the workers' helpers has no
importer left outside the helpers (the boyscout found they call it
themselves — it stays); check 10 catches a column-listed `INSERT INTO
thoughts (content)` in a comment or README sentence, by design. Run for
real: the shim and PostgREST both resolve `{p_content, p_payload}` to the
2-argument form and `{…, p_embedding: null}` to the 3-argument one, the
latter answering `existed`; a 768-wide vector is refused with SQLSTATE 22000
(HTTP 400), so the recipes' status checks report it per thought; a restored
raw insert in the receiver fails check 10 at its line and two test
assertions — as `500` from the shim's array binding, the limit change 69's
header states, not by naming the columns; five runs on one container, and a
run after a SIGKILL, all green; `dropSidecars` drops the readwise-books
table and both functions.

**Review pass 2** (the same two lenses; seven findings, two MEDIUM, both in
the original change — the running reviewer's top finding was in pass 1's
batching, so the passes' fixes are among the top findings but not all of
them). The fresh-row gate met the dedupe filter: `readwise-capture` and the
backfill check for a row by `source_type = 'readwise'`, and wrote
`source_type` only when the function said the row was fresh — so a first
write interrupted between the function and that update (a crash, a 500 and
Readwise's retry, the backfill's new `raise` after earlier rows of the batch
were stored) left a row the dedupe could not see, which the re-capture then
found `existed` and left without its columns for good — before the change
the retry made a duplicate row, after it a permanently half-shaped one. The
sidecar is written `WHERE source_type IS NULL` now, on every capture: a
fresh row takes it, the interrupted row takes it on the re-capture, a
complete row is left alone; the backfill writes it in a `finally`, so the
rows stored before a refused reply take theirs before the error propagates
(the running reviewer traced the raise path; the reading one the retry). The
test interrupts a first write by hand and re-captures. The second MEDIUM was
prose: every converted file, its README and this section said "the audit
actor (008) is written with the text", and none of the writers named one —
the functions set `ob1.actor` only from `p_payload.actor` (or
`update_thought`'s `p_actor`), and change 69's five servers, which hold a
principal, pass none either, so their headers' "the actor reaches the audit"
has been false since change 69. Here: the two writers that authenticate a
key — `consolidation-bio` (both paths) and the auditor — pass `{name:
principal.name}`, and the test reads 008's row for the auditor's report
(`actor_name = MCP_ACCESS_KEY`); the writers without a key (the receiver,
the two scripts, the example, the two samples) say they name none, which is
008's own distinction for a write without a key, and the test reads the
receiver's audit row as NULL. Change 69's five are SMD-1541. Smaller: the
UPDATE rule read a `-- comment` after a comma in a SET list as defeating the
target match while pass 1's INSERT rule stripped it (asymmetry) — both rules
blank line and block comments now, two probes and two non-probes (52/39); a
`;` inside a string argument or a payload built into a variable first fails
the bio text guards, within the header's stated sensitivity; pass 1's count
sentence said nine fixed of eleven — eight fixed, two noted, one
informational; the receiver's `existed` merge carries the latest highlight's
id, said in the code. Run for real: the batched sidecar over PostgREST
(`PATCH /thoughts?id=in.(…)` → 204; an empty `in.()` touches nothing);
postgrest-py 2.31's rpc reply is the dict; the classification example's old
insert fails `42703` on a plain fork brain and on one with the enhanced
schema, so "failed on any brain" holds; two runs on one container green.

**Review pass 3** (the same two lenses; eight findings, the top ones in the
passes' own additions and one pre-existing — the stop signal). Check 10's
comment handling, added in passes 1 and 2, blanked a comment AFTER the
statement's boundary had been found, so a comment's own text still ended the
list: `SET metadata = $1, -- v2; was v1` stopped the SET list at the
comment's `;`, `-- where content lives` at its "where", and a paren inside a
comment in an INSERT column list broke the list match — three false
negatives from mundane comments (both reviewers; the running one ran them).
The rules find the statement's head in the text and read the list from a
copy blanked from the head onward — line and block comments, and the text of
single-quoted strings, replaced by spaces with newlines kept, the string
state starting at the head where the text is SQL, so a quote in the prose
before it opens nothing; six probes and two non-probes (58/41), among them a
dash pair and a `content =` inside a string beside a real target. The heal
filter was one update WHERE `source_type IS NULL` writing both columns, so a
row another path captured first, typed by hand and without a `source_type`,
had its type overwritten to `reference` on the re-capture (the running
reviewer made one); the heal is per column now — `source_type` where it is
NULL, `type` where it is NULL — in the receiver and the backfill, and the
test hand-sets a type on a row without `source_type` and re-captures. The
backfill's `finally` let a failing sidecar update bury the loop's own error
(the reading reviewer; the running one saw the chained traceback) — the
loop's error is tracked and stays the one raised, the sidecar's a warning;
the sidecar's own failure on a clean loop still raises (a fake client for
all four cases). Prose: the receiver's header, README and this section still
said "on a fresh row only" from before pass 2; said per writer now. Run for
real: the actor plumbing end to end over the shim and PostgREST — a
3-argument call with `actor` names it on 008's `capture` row with
`actor.source` over `metadata.source`, `update_thought` with `p_actor` as a
JS object binds as jsonb (005's guard silent) and names it on the `update`
row, the 2-argument call names it too; `PATCH …&source_type=is.null` updates
the NULL row once. **Pre-existing, found by driving the bio worker for
real:** the SQL shim's `ident()` refuses a JSON-path filter column
(`metadata->>generated_by`), so `consolidation-bio` as shipped on the fork
answers 500 at its first query and never reaches `upsertProfile` — the
reason it can only be read here, not driven; the shim fix and the drive are
SMD-1544 — done in change 73, which found a second gap (a `Date` where
PostgREST gives a string) one step past the first. A fresh worktree needs `bun install` in `extensions/` before
`test-writes.ts` (eight MCP assertions fail without the packages); CI
installs.

**Review pass 4** (the same two lenses; six findings, all LOW or
informational, the top ones in pass 3's blanker — the stop signal holding).
The blanker read a backslash-escaped quote inside an `E'…'` string as the
string's close and reopened one over the target that followed, and read a
dash pair inside a `"quoted identifier"` as a line comment — two false
negatives, both theory-grade for the tree (no E-string, no dashed identifier
near a `thoughts` statement) and both confirmed by running the blanker; an
E-string's backslash skips its next character and a quoted identifier is
read whole now, three probes (61/41): the doubled quote, the E-string, the
dashed identifier, each beside a real target. The 4000-character window is
named in its comment (the tree's longest statement is under 400). One
per-file clause above still said "the sidecar on a fresh row" for the
receiver — pass 2's fix overtook it; said per column. Run for real: the
per-column heal over PostgREST leaves a hand-set type and fills
`source_type`, and a repeated PATCH touches nothing; a row another tool
labelled (`source_type = 'mcp'`) keeps its label and, since the receiver's
dedupe looks for readwise rows only, is re-sent to the function on every
delivery — one row throughout, one `update` audit row per delivery — said in
the README now; the backfill's `finally` under a KeyboardInterrupt writes
the stored rows' columns and re-raises, under a clean loop with a failing
first column raises the sidecar's error with the second column unwritten
(the next run heals both), under a double failure raises the loop's error
with one warning; the checker's scan is no slower for the per-head slice
(0.7 s either way); `deno check` on the receiver shows the shim typings
only. Two runs on one container green.

**Boyscout.** The passes' cut-for-space tidy-ups in the files this change
touched, no behaviour changed: the Ollama recipe's usage text, `--dry-run`
help and README still said "insert" for what is a store through the
function; the readwise backfill's README opening and one troubleshooting
heading the same; the test's sidecar comment counted two files where there
are three; the probe list's doc comment named the updates alone. The
`computeContentFingerprint` pass 1 marked for removal is called by the
helpers file itself (the workers' shared copy computes a fingerprint for its
own structured-capture path), so it stays; the pass-1 note above says so.

**Not done here.** SMD-1544 (the shim refuses a JSON-path filter column, so
`consolidation-bio` cannot run on the fork; with that fixed, bio joins the
driven set) — done in change 73. SMD-1541 (change 69's five servers hold a principal and
pass no actor to `update_thought`/`upsert_thought`; their headers claim the
actor reaches the audit). SMD-1525 (`enhanced-mcp`'s read tools address rows by
integer id). SMD-1480 (deployability of the shim-importing writers —
`readwise-capture`, `consolidation-bio` and the auditor among them; their
behaviour is exercised by `test-auth.ts` and `test-writes.ts` under Bun) —
done in change 74. A
fork-shaped brain for the Kubernetes and Neon deployments is theirs to take
up; the READMEs name the path. `db/`'s and `evals/`' own `INSERT INTO
thoughts` statements are the fork's fixtures and benches, outside the scan
as they were for the update rule.

**Verified:** `bun scripts/check-fork-consistency.mjs` FAILED with check 10's
eight hits in eight files before the conversions and PASS after (61 probes,
41 non-probes, each probe caught on its verb's line; seven exceptions, each
matching its one line); `../db/with-postgres.sh bun test-writes.ts` 157/157
under podman — the receiver's capture judged column by column, its retry
answered `duplicate` before any write, the same passage highlighted again one
row with the newer highlight id and a hand-set tier kept, the book cached and
counted, a wrong secret writing nothing, the auditor's report fingerprinted,
vectorless and unlabelled with its findings in metadata; `bun test-auth.ts`
643/643 on the converted receiver and auditor; the two Python recipes compile
(`py_compile`); the four converted `.ts` files parse under Bun (all four
import the SQL shim, so `deno check` does not reach them, as change 69
found); the codemod round-trips. The ticket's verify — check 10 fails on the
six today and passes after; a capture through `readwise-capture` leaves
`content_fingerprint`, `embedding_model` and no chunk rows as the 3-argument
`upsert_thought` leaves them, one round trip — is the check's before/after
and the test.

**Upstream status:** not applicable — the raw inserts are upstream's, the
function they now call is this fork's. The classification example's
nonexistent columns and the bio worker's vectorless first row are upstream
defects on their own terms; **unfiled** upstream.

### 72. A loaded bench corpus outlives the run — `OB1_PG_KEEP` keeps the container and a named volume, and `bench-hnsw.ts` reuses the corpus it finds there, checked and re-migrated, instead of rebuilding it (SMD-1493)

A `bench-hnsw.ts` pass at ten million rows is about forty minutes, and thirty of
them are the load and the index builds (change 28, "At scale": 207 s of
INSERTs, 1,134 s for the thoughts HNSW index, 327 s for the chunk index, 63 s
for the rest). The corpus is deterministic — the same scale is the same rows —
and SMD-1018's three passes rebuilt an identical table three times before
measuring anything: an hour and a half spent on what the first pass had built.
`with-postgres.sh` starts a throwaway container and removes it, with its
anonymous volume, on exit; nothing survives a run by design (776 leftover
volumes, 79 GB, once filled a podman VM — change 20's review pass).

**The container (`db/with-postgres.sh`).** `OB1_PG_KEEP=<name>` mounts a
*named* volume, `ob1-pg-keep-<name>`, at the data directory and otherwise runs
as every run does — a fresh container, `stop`ped on exit with two minutes for
Postgres to checkpoint a large database cleanly (the runtimes' default ten
seconds would SIGKILL it into crash recovery on the next start) and then removed
with `rm -v`, which removes *anonymous* volumes only on both runtimes, so the
named one survives and the exit line prints the one command that removes it.
The next run under the same name mounts it again; the image, shared memory and
port given then apply, as on any run (the first draft `start`ed the kept
container instead, which froze all three at creation and put the random port
back in the way of "address already in use" — the review pass had the simpler
shape). The container carries the name too, so a second invocation while the
first is running is refused before anything starts — sharing would let
whichever exited first stop the database under the other — and a stopped shell
an interrupted run left behind is removed (its data is in the volume). Under
the variable the readiness wait is thirty minutes rather than one: a kept
ten-million-row data directory may start into crash recovery and replay WAL
for minutes, and giving up would stop it mid-replay and start the next run
over. Cleanup touches only a container this invocation started. Without the
variable the script does what it did: a fresh container, removed on exit, no
volume behind it.

**The corpus (`db/bench-hnsw.ts`).** A scale above the before arm's (100,000
rows — below it the before arm needs 001–013 under the rows and a build is
seconds) is applied through **`migrate.ts`** now, not `applyMigrations`' bare
apply, so the migrator's ledger records what the schema is; and once the load
and every build have finished the bench writes one marker row
(`bench_hnsw_corpus`: the scale, the parameters that shape the rows — width,
tiers and their shares, the chunked share — the tier match counts it counted as
it generated, and section L's numbers). An interrupted load leaves no marker and
nothing reads as a corpus (the oracle's premise — every chunk carries its
parent's vector — is checked on the build, before the marker, and on a reuse
only when the ledger differs from the one the marker says it last passed under,
since that join over every chunk row costs a minute at ten million rows and a
migration applied onto the table is the one way a kept chunk vector can
change). The next run at
that scale finds the marker and, in this order, (1) counts both tables against
the marker and regenerates the corpus's first and last rows from the seed,
comparing the tiers exactly and the vectors to float32 — a generator change or
a foreign table cannot pass as the corpus, and is refused before the migrator
walks it; (2) reads the ledger against the tree and refuses a name the ledger
records that no file carries — a corpus migrated from another branch, which the
runner would not notice; (3) runs `migrate.ts --dry-run` and refuses on its
`DRIFTED` before anything runs — a plain run reports a recorded file edited
since, but only after applying every pending file around it, which on a kept
corpus would land a migration and then say "nothing was measured" — then
`migrate.ts` itself, so a migration added since the build is **applied onto
the corpus** (as onto a real brain that size, which is the measurement wanted),
the files it recorded read back from the ledger rather than scraped from its
output — and refuses the corpus if those files *rewrote rows* (the update and
delete counters moved), since a heap at twice its pages and HNSW graphs of
repaired twins are not the bulk-built state the marker's sizes describe, and
the `VACUUM FULL` that would restore it is the rebuild the reuse exists to
avoid; (4) reads both HNSW relations into the page cache (`pg_prewarm`, best
effort), so the walks time the same cache a fresh build leaves; (5) takes this
run's queries' confound from the exact whole-table pass section A already runs
(the build's client-side check covered the build's queries; an index probe
would see only its first `ef_search` candidates) and re-checks the oracle's
premise whenever the ledger differs from the one the marker says it last passed
under; then goes on to the oracle. Section L
gains a `source` column — `loaded`, or `reused (built <when>)` (change 76 adds where the exact oracle's answers came from) with the build's
own numbers — and the run says which it did, what it counted and which files it
applied, so a report never silently mixes a fresh build's load line with a
reused corpus. A kept database holds **one** corpus: a run asking for another
scale than the one an *earlier* run kept is refused before anything is dropped,
naming the three ways past (reuse it, run the other scale without `OB1_PG_KEEP`
or under another name, or remove the volume) — a corpus this run built itself
is this run's to replace, so the header's two-scale command keeps the last (the
first draft refused its own second scale, after building and measuring the
first: review pass); a corpus of the right scale built from other parameters is
rebuilt, said aloud. The loopback guard every destructive statement used to
inherit from `resetSchema` is asked once, up front, since the kept paths drop a
marker table and run the migrator without it. `test-support.ts` gained
`migratorEnv()` (test-upgrade's local copy, shared), `runMigrator()` (the spawn
three files spelled for themselves) and `ledgerStrangers()`; `test-upgrade.ts`
[15] holds the last one's contract — a bare apply has no ledger, the migrator's
names only the tree's files, a stranger is reported by name where a plain
`migrate.ts` run skips everything and exits 0. That the migrator itself never
looks for a recorded name it has no file for — so `--reapply`'s "every recorded
migration" is silently short on such a brain — is SMD-1504's, not this
change's: a bench ticket does not change what the migrator refuses.

**Measured.** At ten million rows (the README's command: `OB1_PG_SHM_SIZE=11g
OB1_BENCH_MAINTENANCE_MEM=9GB`, 50 queries, the same VM as change 28's
"At scale"): the run that built the corpus took **37 min 9 s** end to end —
206 s of inserts, 1,059 s and 267 s for the two HNSW indexes, 60 s for the
rest, the numbers change 28's third pass records — and the run that reused it
**7 min 24 s**, against the ticket's fifteen: `10,000,000 thoughts and
4,000,000 chunk rows counted, rows 0 and 9,999,999 regenerated from the seed
and matched`, `schema already at the tree's; nothing applied`, the confound
0.656 from the exact pass, section L reading `reused (built …)` with the
first run's numbers. The two runs' recall columns are identical (0.6 / 3.4 of
ten unfiltered at `ef_search` 40 / 400; 0.7 at 50%, 5.1 at 1%) and their
latencies sit inside the ~30% pass-to-pass spread change 28 reports (the
default path 7.8 against 10.1 ms), so the fresh container's cold index, once
warmed by the untimed pass, does not show in the tables. Of the seven
minutes, the exact oracle — 500 exact scans of ten million rows — is most,
which is why caching its answers in the marker is the first cut-for-space
item below. At a million rows: the fresh kept run 6 min 49 s, the reuse 3 min
45 s. At 150,000 rows (the
smallest kept scale; 3 queries): a fresh kept run 27 s, the reuse 5 s, with
`150,000 thoughts and 60,000 chunk rows counted, rows 0 and 149,999 regenerated
from the seed and matched` and `schema already at the tree's; nothing applied`.
With a pending probe file in the tree (numbered after its last) the reuse
printed `migrations applied onto it this run: …` and went on; with that file
edited after being recorded and a second probe pending beside it, the run was
refused on the dry run's `DRIFTED 1` and the second probe was never applied;
with the file removed from the tree, the bench refused on the ledger's stranger
by name. A run asking for 10,000 rows against a kept 150,000 was refused before
anything was dropped (exit 2); a run over 150,000 and 200,000 rows in one
throwaway container built both, the second replacing the first. A second
invocation under a name in use was refused with the owner named. The default
command left `podman volume ls` at the same count before and after. The first
two reuse runs each failed on a driver fact: a JSON **string** bound to a
`$n::jsonb` parameter is JSON-encoded once more by Bun's driver and lands as a
jsonb string, which `@>` never matches — the double-encoding the README's
live-suite section already names, met from the other side (bind objects); and
jsonb hands an object back with its keys in its own order, so a round trip's
text is not the text that went in (compare a key-sorted serialisation).

**Second review pass, on the seams the first pass's fixes made.** The
container is now stopped and removed by the ID `run` returned, not by name —
under a shared name a removal by name after our own `stop` could take a
container another invocation created meanwhile — and a namesake in any state
but exited is refused, since podman reports `stopping` (another invocation's
exit checkpointing the database, up to two minutes) as not running; the
cleanup flag is raised *before* `run`, because a `run` that creates the
container but fails to bind its port leaves the container and, without
`OB1_PG_KEEP`, the anonymous volume the `-v` exists for (reproduced by the
reviewer: one volume per failed run, the 79 GB leak in miniature); the
readiness wait breaks out at once when the container has exited, so a kept
data directory the image cannot open prints its logs in a second rather than
after thirty minutes of dots; the removal hint prints the runtime as found,
since `/opt/podman/bin/podman` is chosen exactly when `podman` is not on
`PATH`; and an interrupt exits through the EXIT trap once. In the bench the
one-corpus rule is judged against the *whole* run before the loop — the
per-scale refusal, added by the first pass, would have measured a kept scale
in full and then refused the run's second scale with every section unprinted —
and a run under `OB1_PG_KEEP` that puts a small scale after a large one is
refused up front, since the small scale would drop the corpus and keep nothing;
the regenerated rows and counts run *before* the migrator on a reuse, so a
table that is not the generator's is refused before a pending backfill walks
ten million rows; the chunk-vector check runs on a reuse that applied a
migration (the one way a kept chunk vector can change); the marker carries a
format number beside the parameters, so a marker an earlier bench wrote
rebuilds aloud instead of passing every check and failing in the report; the
marker table joined `dropSchema`'s list, so a suite run in a kept database
cannot leave a marker over rows that are gone; and both paths run the queries
once untimed before section A, since a kept index in a new container is cold
where a freshly built one is warm. Two ledger reads became one
(`ledgerNames`), the row recipe one function shared by the load and the
regenerated rows, and the reviewer's altitude finding — that `migrate.ts`
itself should check drift and strangers before applying anything, which would
retire both the bench's dry run and `ledgerStrangers` — is SMD-1504's. Cut
for space: caching the exact oracle's answers in the marker (the bulk of a
reuse's remaining minutes at ten million rows), not measured.

**Third pass.** The stop signal — the previous pass's additions as the top
findings — fired at the second pass and again here, and the shape of the
findings said why: three rules for which scale a kept database holds, keyed
three ways (the marker, the environment, the per-scale marker), and an
ownership rule in the script keyed by a flag and a name. Both became one
invariant. In the script the container is *created* and *started* as two
steps and cleanup touches only the ID `create` returned, never the name — the
flag went, and with it the case where an invocation that lost a name race
stopped the other's container through the name fallback; a namesake in any
state but exited is refused with the removal named, since `created` is either
another invocation between its two steps or a shell whose start failed, and
the two cannot be told apart from outside; the data-directory mount is read
from the image's `PGDATA` (`/var/lib/postgresql/<major>/docker` from the pg18
images, where a mount at the old path would keep an empty volume); the
interrupt trap is disarmed before the stop so a Ctrl-C during the checkpoint
cannot skip the removal and the hint, which now prints before the stop. In
the bench, under `OB1_PG_KEEP` a run is exactly one scale above the before
arm's, judged where the list is parsed — a descending list had built the
large corpus and then replaced it "by design", a small-scale-only run had
kept a volume nothing would reuse, a duplicated scale had reused a marker
written seconds earlier; the marker is written in one transaction (a table
with no row read as "no corpus" and would have let a small-scale run drop what
it stood over); the marker records the ledger the oracle's premise last passed
under, so a check that threw after a file was recorded is not skipped by the
re-run; a reuse that applied files `VACUUM ANALYZE`s both tables, since a
migration of 023's kind leaves a dead index entry per row and the build's
statistics; and this run's queries are confound-checked through the index,
since a build with three queries said nothing about a reuse with fifty. The
header's count and the check order in two paragraphs were brought up to the
code. Cut for space: caching the exact oracle in the marker; `migrationFiles()`
shared across the seven directory listings; the marker's `scale`/`builtAt`
held twice.

**Fourth pass, at the author's call.** The exited-namesake removal went by the
ID the status was read from, not the name — a forced removal by name would
have taken whatever held the name at that instant, another invocation's
freshly created container included, the race the ID rule exists to close; the
interrupt disposition inside cleanup is *ignore*, not default (reset, a second
Ctrl-C during the two-minute stop killed the client and the shell before the
removal — reproduced on bash 3.2); without `OB1_PG_KEEP` a container whose ID
never reached the shell is removed by the per-process name, so an interrupt
that cuts the `create` short leaves no anonymous volume; the `PGDATA` read
fails loudly rather than defaulting under `set -e`; `--stop-timeout 120` rides
on the container so an operator's own `stop` checkpoints too. In the bench
the vacuum and the oracle-premise re-check share one key, the ledger against
the one the marker was last verified under (a run interrupted between the
migrator's commits and the vacuum would otherwise leave the next run timing
dead index entries with "nothing applied" printed); a reuse's confound comes
from the exact whole-table pass section A already runs, not an index probe
that sees its first forty candidates; a kept corpus of the right scale built
from other parameters is *refused* with the remedies, as a scale mismatch is,
rather than rebuilt behind one log line; the kept-table checks refuse in the
named-remedy form rather than throwing; the fresh path skips the dry run and
words its refusal for an empty database; and "before a container is asked for"
became "before anything is connected to or dropped", which is what is true
under `with-postgres.sh`.

**Fifth pass, on the tree merged with main** (PR #47's fourth and fifth
passes, changes 66 and 67). The stale namesake's status and ID now come from
one inspect and the removal goes by that ID (two reads by name were a second
snapshot, and a name gone between them aborted under `set -e`); the data path
is pinned with `-e PGDATA` rather than discovered from the image, which
retires the pre-pull, the environment parse and the silent default the
discovery needed; `--stop-timeout 120` rides only on a kept container, since
podman's `rm -f` honours it and a throwaway container should go at once; the
readiness wait ends only on an explicit `Running=false`, not on a failed
inspect, so one transient runtime error cannot stop a thirty-minute recovery.
In the bench the marker format is 2 (main's `otherIndexes` in section L) and a
format mismatch is documented as the refusal it is; a reuse whose migrations
rewrote rows is refused rather than plain-vacuumed and measured — main's
fourth pass found plain `VACUUM` leaves the heap doubled and the graphs as
repaired twins, and its `VACUUM FULL` at ten million rows is the rebuild the
reuse exists to avoid; both HNSW relations are prewarmed on a reuse, since the
untimed pass over the default call had warmed only the query vectors'
neighbourhoods; the confound comes from one exact pass on both paths through
one `oracle()` (the duplicate whole-table scan went); and the two paragraphs
above say the ledger-keyed re-check and the exact-pass confound the code does.

**Sixth pass.** Three defects the reviewers reproduced. Readiness is now TCP
readiness (`pg_isready -h 127.0.0.1`): over the unix socket the entrypoint's
initdb-time temporary server answers for about 200 ms before the real one is
up, a client that connected then failed, and under `OB1_PG_KEEP` the exit that
followed stopped the container mid-initialisation and left a volume the
entrypoint thereafter treated as initialised. The container's state is asked
on every readiness miss, not only after a runtime exec error: docker's `exec`
on a non-running container exits 1, the code `pg_isready` gives for
"starting", so under docker the fast fail on an unreadable kept volume had
been dead and the wait ran the full thirty minutes. The row-rewrite refusal is
recorded in the marker (`rewritten`) before it exits, since the ledger has
already advanced and the next run would otherwise find nothing pending and
measure the repaired graph; the counts and the two regenerated rows are
checked again after the migrator. Then the smaller items: the exact oracle
selects the distance under an alias the `ORDER BY` names — `1 - (…)` beside
the bare distance was two expressions to the planner and it evaluated the
distance twice per row, 12–15% of every exact scan; `pg_prewarm` runs after the
oracle (which streams the heap and would evict what was read before it) and
just before section A; a marker of a shape this bench cannot read is a
refusal with the remedy, not a stack trace; `migratorEnv` is an allowlist —
every `OB1_*` variable dropped, the fixture's three set — where the denylist
had one dead name and let a chunk-context choice through; the marker's scale
and build time live once, in `stats`, and comparisons use `Bun.deepEquals`;
the marker is written only under `OB1_PG_KEEP`, so a throwaway multi-scale run
no longer says "replacing"; test-upgrade's four remaining hand-spelled
migrator spawns use `runMigrator`; and the bench's dry run and
`ledgerStrangers` are labelled the stand-ins for SMD-1504 they are.

**Seventh pass.** The rewrite check had compared the row counters against
this run's own first read, which three findings got past: a migrator that
committed a rewriting file and failed on the next exited through the refusal
before the comparison, a statistics flush that landed after the read left the
delta at zero, and a rewrite without DML — a column type change, a re-created
index — moved no counter at all. One durable fingerprint replaces it: at the
build the marker records, for the two heaps and the two HNSW indexes, the
cumulative insert-update-delete counters and the file each relation lives in
(`relfilenode`, which DML never changes and a rewrite always does); a reuse
compares the current state against the build's, refuses on any movement and
records the refusal, so the run after an interrupted migrator catches what
the interrupted one could not; a counter that went *down* is a statistics
reset after a crash recovery, said and not refused, since the files still
vouch. That subsumed the second count-and-rows check. The marker is read once,
before the loop, and every rule about it is judged there — the in-loop read,
its second refusal family and six non-null assertions went; a duplicated
scale is folded at parse. The exact oracle runs under the build's worker
count (`max_parallel_workers_per_gather`, the image's cap is two) — a setting,
not a measured saving. The skip self-check exercises the shared row recipe
rather than a hand-spelled copy of it; a marker's `stats` are checked for
every field section L reads by name (a compiler-held list), not by the format
number, whose comment now says what it is for; `substitute` pins the
chunk-context default as it pins the trigram one, so a fixture applied bare
and through the migrator agree on what 013 records; test-upgrade's [7] no
longer describes a refusal the migrator does not make.

**Eighth pass.** The fingerprint compared against the build alone had one
blind spot the reviewer built: after a crash recovery resets the statistics
(the ten-million-row counters read zero), a full-table rewrite lands them back
on the build's figure and the files are unchanged, so nothing moved. The
comparison is now made twice — against the build, for what earlier runs did,
and against this run's own read before the migrator, for what this run's
files did — and the refusal records the evidence (what moved, since when)
rather than this run's file list, which had blamed whichever file happened to
run last for a rewrite an earlier, interrupted migrator committed. The
prewarm runs on both paths: the oracle streams the heap some five hundred
times, so at ten million rows a freshly built index is no warmer than a
reused one by section A, and the per-query warm pass — which had made
section A a repeat-query figure — went. In the script, an interrupt is noted
and the command's own exit status stands (the trap had replaced a clean exit
with 130 whenever a signal reached the wrapper, a psql cancel included); a
container created and never started — an interrupt inside the tens of
milliseconds between `create` and the ID reaching the shell, reproduced — is
removed by its inspected ID instead of refusing that name for ever; a new
kept volume gets the ordinary one-minute wait, the thirty minutes being for a
data directory with WAL to replay; the refusal's pasted removal is `rm -fv`.
Smaller: the relation names come from one list (`HNSW_INDEXES`), bound as an
array; `scale` is a generated column of the payload; readMarker's shape check
carries the kept-scale rule, so the loop's reuse test is one term; the
build's confound stays the accumulator's, said so; test-schema pins the
chunk-context default too. The denylist copies left in test-live,
test-search-path and measure-1288 predate this change and are on the boyscout
list.

**Ninth pass.** Two mechanisms rebuilt at the root rather than patched. The
interrupt handling: the eighth pass's note-only traps had made a signal to
the wrapper before its command ran vanish — a `kill` during a thirty-minute
readiness wait set a flag nothing read, the wait ran out, the bench started
and the wrapper exited 0 — and its status remap reported any non-zero exit
after any signal as 130 (reproduced under bash 3.2). Now the trap acts
(`exit 130`/`143`) until the command runs, when it becomes a no-op body — not
an empty string, which a child inherits as "ignore" and never sees the
signal — and the command's own status carries out through the EXIT trap. The
fingerprint: the counters half is lost to a crash recovery, so a rewrite that
committed before a recovery and was never judged (the run died before its
own comparison) left counters below the build's, said and not refused, with
the file unchanged — invisible. Each relation's main-fork size joined the
record: DML over the rows grows it, nothing resets it, and growth past a
tenth of the build's is the refusal; the counters are no longer
load-bearing, which also covers a server with `track_counts` off (said when
seen). Then: a marker table that exists with no row is a refusal, not "no
corpus" (the fresh path would have dropped what stood under it); the marker
is written after the exact pass's confound gate, so a refused build leaves
nothing to reuse, and that gate refuses in the named form rather than
throwing; the loop's tail is one `if (kept)`/`else` with no non-null
assertions, and the dead `!beforeArm` on the marker write went with it. The
spawned migrator runs with `--no-env-file`: Bun loads `db/.env` into a child
for every variable the passed environment lacks — every `OB1_*` name after
the strip — so the allowlist had a hole the size of the file the fork
documents as the migrator's own (reproduced); `runMigrator` takes an
optional environment and the three suites still spelling the spawn use it;
one `migrationFiles()` lists the directory for the bare apply, the ledger
comparison and test-upgrade's count.

**Tenth pass, on the tree merged with main again** (changes 68–70; this
section became 71, its test case [15]; main's `OB1_BENCH_UPTO` applies bare
on the whole-schema path and is refused with `OB1_PG_KEEP`, since a schema
cut at a migration is not one the ledger describes). Two things at the root.
The marker records the build's transaction id, and a reuse counts the rows of
either table whose `xmin` is newer — exact at any share and blind to a
statistics reset, where a subset backfill committed on an earlier interrupted
run had grown the heap by less than the tolerance and moved counters a
recovery then zeroed; with that, the ledger-keyed re-check of the oracle's
premise went, since no row written since the build is the premise's proof.
And the database-level HNSW bounds in force are compared with the tree's
seeds on both paths: a kept database carries the `ALTER DATABASE` its build's
014 ran, the migrator skips a recorded 014 and 014's guard leaves a seed in
place, so a config-only change to `HNSW_SEEDS` would have walked under the old
bound while section E's header named the new one. Then: `--no-env-file`
rides on every `bun` spawn `runScript` makes with its own environment, not
only the migrator's (test-live's re-embed worker with a stripped shell was
the reachable case); `dropSchema` refuses a database holding a kept corpus
unless `OB1_DROP_KEPT_CORPUS=1` names the intent, so a suite run under a kept
name cannot drop thirty minutes of build in silence; the kept-table checks
throw a tagged error and anything else — a dropped connection, a timeout —
is rethrown rather than blamed on the corpus; the script's comment says what
its `created` arm does and the kept hint prints only for a container that
started; the marker's `stats.confound` is documented as the exact pass's
value; the reuse assigns its stats once.

**Boyscout, while the files were open** (what the passes cut for space, no
behaviour change): the script's stop timeout is one constant where it had
been spelled three ways; test-upgrade's [7] reads `MIGRATOR_ENV` where an
alias of it stood; the marker constant says why its name is spelled out in the
tagged templates; two comments that narrated which review run found what say
the fact instead; change 28's section L table gained the `source` column the
bench now prints, every row `loaded`; the README's thirty-minute wait is said
to be a kept volume's that already exists; a second look folded the script's
four removals into one `discard` and let the README count the thirty minutes
as the 1,800 tries they are. Left as they were, being either behaviour or
beyond the touched files: caching the exact oracle's answers in the marker
(the bulk of a reuse's remaining minutes at ten million rows — SMD-1562), and
test-live's own stripped-shell spawns for the re-embed worker and preflight,
which predate this change.

Upstream status: **not applicable** — a fork-only bench harness. **Unfiled**
upstream. Reproduce: `OB1_PG_KEEP=x OB1_BENCH_SCALES=150000 ./with-postgres.sh
bun bench-hnsw.ts` twice; the second run's section L says `reused`.

### 73. The SQL shim takes PostgREST's JSON-path column and hands a timestamp back as a string — `consolidation-bio` runs on the fork, and `test-writes.ts` drives both of its write paths (SMD-1544)

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
nested `.or()` keeps it off the shim. SMD-1541 and SMD-1525 as before.

**Upstream status:** not applicable — the shim is this fork's (fix 13); the
worker's `created_at.slice(0, 10)` is correct over PostgREST. **Unfiled.**

### 74. The servers on the SQL shim run under Bun — `compat/deno-on-bun.ts` is the second one-line change, the codemod writes it, check 11 holds it, and `test-auth.ts` starts all sixteen (SMD-1480)

`compat/deno-on-bun.ts` (new); `scripts/migrate-to-sql-shim.mjs`; one import
line in sixteen vendored files — `extensions/home-maintenance`,
`household-knowledge`, `meal-planning` (`index.ts` and `shared-server.ts`) and
`professional-crm`; `integrations/consolidation-workers/bio`,
`delete-thought-mcp`, `entity-extraction-worker`, `open-brain-rest`,
`readwise-capture`, `rest-api`, `smart-ingest` and `update-thought-mcp`;
`recipes/editorial-policy/auditor`, `work-operating-model-activation` and the
cost recipe's "before" sample — and `recipes/local-brain-no-mcp/functions/
_shared/db.ts` back on supabase-js; `scripts/check-fork-consistency.mjs`
(check 11); `extensions/test-auth.ts`; `compat/supabase-sql/README.md` and
`tsconfig.json`; the four extension READMEs and their `metadata.json`, the
deploy primitive, ten recipe and integration READMEs (`rest-api`'s and
`smart-ingest`'s gain the callout the other eight had),
`integrations/consolidation-workers/deno.json`, two comments in
`.github/workflows/fork-checks.yml`, `extensions/test-writes.ts`'s header
(Linear SMD-1480, filed from change 64's third review pass and widened by
comment from change 67).

Fix 13's codemod moved a file off supabase-js by changing one import line, and
the shim it moved it onto imports `bun`. The files it moved were written as
Supabase Edge Functions: they read their environment through `Deno.env.get`
and end in `Deno.serve`. So one line left them running nowhere — not under
Deno, which cannot resolve `bun`; not under Bun, which has no `Deno` — and
that state held for sixteen files: the five extension servers the ticket
names, the nine recipes and integrations change 67's comment widened it to,
and `rest-api` and `smart-ingest`, on the shim with a key compare of their
own. Changes 64, 67, 69, 71 and 73 each exercised them under the tests' two-
line stand-in for those globals, which is the only way they ran at all, and
twelve READMEs and the deploy primitive sent a reader to `supabase functions
deploy` above a callout saying it would fail. The ticket offered a revert; this fork's stated purpose
is running Open Brain without Supabase, fix 13 put these files on the shim for
exactly that, and change 73 had just made `consolidation-bio` run on it — so
the migration is finished instead, for every file on the shim, by the
mechanism fix 13 already owns.

**The mechanism.** `compat/deno-on-bun.ts`, imported first, installs
`globalThis.Deno` where none exists, with exactly the two members these files
use: `env.get(name)` reads `process.env`, and `serve(handler)` /
`serve({ port, hostname }, handler)` is `Bun.serve` on the option's port, else
`PORT`, else 8000 (Deno's default), printing Deno's `Listening on http://…/`
line and returning an object with Deno's `finished`, `shutdown()` and `addr`.
Anything else on `Deno` stays undefined, so a file that starts using
`readTextFile`, `args` or `exit` fails at the call under Bun with its name —
not on a quiet emulation of another runtime's semantics. Where `Deno` already
exists — on Deno itself, and under `test-auth.ts` and `test-writes.ts`, whose
stand-in captures the handler instead of listening and is installed before
any server is imported — the module does nothing. The codemod writes the line:
`--apply` adds `import "…/compat/deno-on-bun.ts";` before a migrated file's
first import statement when the file uses a `Deno.` member (ES modules
evaluate imports in order, and a helper whose module body reads `Deno.env`
before the polyfill has run is a `ReferenceError` at startup), and where the
file's first import was Supabase's type-only `import
"jsr:@supabase/functions-js/edge-runtime.d.ts";` — a specifier Bun does not
resolve; four of the sixteen had it — that line becomes the polyfill import
with the original recorded beside it (`// ob1-original-types:`), so the
position is kept; `--revert` undoes both byte for byte, and `--apply --all`
completes a file migrated before the line existed, so revert-then-apply is
still the identity (23 reverted, 23 re-applied, the tree unchanged). A `KEEP`
list beside the blockers names the one file the shim can resolve but must not
take: the local-brain recipe's client runs inside that recipe's own
self-hosted Supabase stack — `setup.sh` symlinks its `functions/` into the
stack's edge runtime — where PostgREST is present and `bun` is not; it is back
on `jsr:@supabase/supabase-js@2`, and the triage report says why. A recipe or
integration has no `node_modules` on its path; `NODE_PATH=extensions/
node_modules` (Bun honours it — probed) points the five that import `hono` or
the MCP SDK at the install `extensions/package.json` already pins to their
`deno.json` files, and the workers, the two APIs and the webhook receiver
import nothing but the shim and their own files. Check 11 holds the state: a
file under the seven category directories or `docs/` that imports the shim
and — itself or through the relative imports it evaluates, transitively — uses
a `Deno.` member has the polyfill as its first import statement; no member
beyond `env.get` and `serve` appears in the file or its imports; no `jsr:`,
`npm:` or URL specifier remains (`node:` is fine); comments and string
contents blanked first, line numbers kept; twelve probes, three through a
dependency, six non-probes, no exceptions. And `test-auth.ts` proves the run:
every file in the tree that imports the shim and calls `Deno.serve` — a glob,
so a newly migrated server joins or the guard fails — is started as a child
process, `bun <file>` with the environment its README documents and
`PORT=0`, the port read from the polyfill's `Listening on` line; then asked
over HTTP for the one thing that proves it is that server authenticating —
an MCP server's `tools/list` under a write key is its full tool list, an
API's read probe passes under a read key, a worker dry-runs under one, the
receiver admits its secret, the two APIs on their own key pass their gate —
refused with a wrong key, still running afterwards, then stopped. Sixteen
starts, four assertions each, in the required Portable-server job, no
database; the child's exit is awaited beside the read, so a crash fails at
once, and the child is stopped before its stderr is read, so a silent one
fails at the deadline rather than hanging the job.

**Decisions.** *Finish, not revert:* above. *A polyfill, not a per-file
seam:* the ticket sketched `server-portable/index.ts`'s pattern — env through
one accessor, `export default { fetch }` — which is right for a file the fork
owns and wrong for sixteen it vendors: the sixteen entries hold 96
`Deno.env.get` reads and 16 `Deno.serve` calls, and the four
`_shared/helpers.ts` modules and `network.ts` behind them 65 more reads,
every one a line the next rebase conflicts on, where the polyfill is one
line the codemod owns and reverts, the same standard fix 13 set (a probe first: an unmodified
`home-maintenance/index.ts` under `bun --preload` of the two globals
answered `tools/list` with its four tools and 401 to a wrong key). *Two
members, no more:* the polyfill is a statement of what these files use, and
the loud failure at any other member is the point — an emulated
`Deno.readTextFile` that differed from Deno's in one respect would be the
fork's recurring defect, a value defined twice. *First import:* a second
import ahead of it is a race the file's own order decides; check 11 names the
line. *In the `jsr:` line's place:* a byte-exact round trip needs the
position, and the swapped line is Bun's one unresolvable specifier in these
files — a type-only import, so Deno lost nothing either. *`KEEP`, not a
blocker regex:* nothing in the local-brain client's text says where it runs;
its deployment does, so the codemod names the file and the reason. *`NODE_PATH`,
not a `package.json` per category:* `extensions/package.json` already pins
what the servers' `deno.json` files pin and `test-auth.ts` holds the two
equal; a second install under `integrations/` and a third under `recipes/`
would be two more copies of that pin to drift. *`SUPABASE_URL` still carries
the Postgres URL:* fix 13's documented convention (the codemod's banner says
it); renaming the variable is the per-file rewrite the one-line philosophy
exists to avoid, and every README's run line says what the variable holds.
*`rest-api` and `smart-ingest` in scope:* the ticket and its comment count
fourteen; the tree has sixteen on the shim, and the drift guard is over the
tree, not a list. *The tests keep their stand-in:* they need the handler, not
a port, and the polyfill yielding to an existing `Deno` is what lets both be
true; only the last section of `test-auth.ts` runs the polyfill, and it runs
it as a user would. *`PORT=0`:* the OS picks a free port and the polyfill
reports it, which is what Deno's `Listening on` line is for — no probe, no
race. *`metadata.json`'s `tools`:* `Bun 1.4+` for the four, `Supabase CLI`
for the two that deploy by the primitive.

**Review pass 1** (a reading reviewer and a running one, the latter in its
own worktree with podman; twenty-nine items between them, three HIGH — two
of them one defect seen by both — five MED, nineteen taken). The running reviewer broke the new test section both
ways a child process can go wrong. A child that crashed at startup — the
polyfill with `serve` removed — was reported only after the full thirty-second
deadline, at 100% CPU, sixteen times over (eight minutes), with `exit null`
and a code frame where the error text should be: `reader.read()` answers
`{ done: true }` at once after the child's stdout hits EOF, so the loop spun
eleven million times, and Bun sets `exitCode` only when `exited` settles,
which the loop never awaited. And a healthy child whose `Listening on` line
did not match the regex hung the suite past fifteen minutes and left an
orphan: the failure message read the child's stderr to EOF while the child
was alive (the reading reviewer saw the same line). Now the loop races the
child's `exited` beside the read and a tick, drains once at EOF, kills the
child before reading stderr, surfaces the line containing `error` rather than
the frame above it, and names the deadline it waited — a crash fails in under
a second with `TypeError: Deno.serve is not a function`, sixteen crashes in
one, an unmatched port line at the deadline with no orphan, each re-run under
the mutation. A polyfill made to install over the tests' stand-in killed the
suite at the first import with a stack and no tally (port 8000 taken or not):
the import loop is a counted failure now, and an assertion after it says the
stand-in is still `Deno` — the identity the whole in-process section rests
on (709 assertions). The documented port was wrong for the fork's own
machine: podman's `gvproxy` holds `*:8000` on macOS, so `PORT` unset answered
`Is port 8000 in use?` on the first try; the polyfill keeps Deno's default,
the examples say `PORT=8787` (the shared meal-planning server 8788) and each
callout says why to set one. The reading reviewer found the two README
claims that would have failed a reader: every extension `schema.sql` creates
RLS policies on Supabase's `auth.uid()` (meal-planning's on `auth.jwt()`
too), which the fork's Postgres does not have, so the new `psql -f` step
died at the first policy — Step 1 now creates the two stub functions first
and says the table owner is not subject to the policies while the server
scopes rows by `DEFAULT_USER_ID` itself; and `work-operating-model-activation`
refuses to start without `SUPABASE_SERVICE_ROLE_KEY`, which its callout said
to leave unset — the callout says to set any value, and the test's spawns no
longer inherit the variable from the process, so "may be left unset" is what
the other fifteen starts prove. Check 11 widened at the running reviewer's
probes: a bare `Deno` — aliased (`const D = Deno`), bracketed
(`Deno["env"]`), destructured — is a use the rule cannot follow and is
refused as one; a dynamic `import("jsr:…")` is a specifier too; four probes
added and a non-probe widened (`globalThis.Deno.env.get`, a relative dynamic
import). The codemod, given a `jsr:` types import that was not the first
import, had swapped it in place — second — and left a second such line
alone; it puts the polyfill first in every layout now and turns any other
types import into the recorded comment, round trip identical on both
constructed files. Smaller: `PORT=""` was port 0, a random port, silently —
empty is unset now; `Deno.serve({ port, handler })`, Deno's options-only
form, is accepted; the reader is cancelled rather than released around a
pending read; the codemod's `Deno.` test reads comments (a harmless extra
line, said so) and check 11's import statements end at `;` (a semicolon-less
import would be a silent miss, said so). This section's counts were wrong
and are fixed: 96 reads and 16 serves in the entries and 65 in the helper
modules, not "64 and 64"; twelve READMEs and the primitive carried the
callout, not fourteen; ten recipe and integration READMEs were edited, not
nine; and the by-hand probe of an unmodified extension ran with the globals
preloaded, so "fails at `Deno is not defined`" was not observed and is not
claimed. The four extension credential trackers gain a Postgres URL line.
Not taken: the migrated files' banner still says `node scripts/…` while the
header says `bun` (rewriting 23 banners for a word; node runs it too); the
bio worker's dry run under a write key answers 404 without a `?name=`, past
the gate as the test counts it; `deno check` of the local-brain recipe's
`capture/index.ts` fails in its `embed.ts` on a parameter property —
pre-existing at the pin, not this change (its `db.ts`, back on supabase-js,
checks clean).

**Review pass 2** (the same two reviewers; twenty-one items between them,
one HIGH, three MED; sixteen taken, one filed). **The stop signal, for this
change's mechanism:** every finding in the polyfill, the codemod, check 11
and the test was polish on pass 1's additions — the deadline constant printed
as its own source text (a double-quoted string inside the template), the
error-line picker preferring `throw new Error(` to the `error:` line below
it, a child that printed its port and then exited crashing the suite with no
tally where the probe's `fetch` threw (a counted failure now, re-run under the
mutation), the postgres stub left in `/tmp` on the import-failure path,
`--revert` turning a person's `// ob1-original-types: …` comment into an
import (the record is a `jsr:` specifier and only that is restored, the
constructed layout round-trips identical now), a backtick dynamic import
unread (read now; one with `${…}` is not a literal), the blanker's template
literals and the two runtime-detection idioms stated as limits, the ten
callouts saying "set one" above command lines that set no port (they say
`PORT=8787` now), the README's `CREATE OR REPLACE FUNCTION auth.uid()` — which
on a real Supabase database would have replaced GoTrue's function with one
returning NULL and broken row-level security across the project — a plain
`CREATE` now, refused where the function exists, with the warning before the
command, and pass 1's own tallies (twenty-nine items, not thirty-two). The
running reviewer confirmed pass 1's two fixes load-bearing: with the `exited`
race removed the busy-spin returns (sixteen crashes in 49 s at a 3 s
deadline); with it, 1.1 s. And it re-ran the codemod's four odd layouts
(identical) and the mutations (a)–(c) (as pass 1 left them).

**The one HIGH is not this change's.** The running reviewer did what no pass
before it had: it applied the five `schema.sql` files to a real Postgres
(after the README's two stubs — they apply cleanly, RLS on, connected as the
owner), started each server under `bun`, and called all twenty-five
extension tools through `tools/call` with a real key. Seven fail, on three
gaps in the shim that predate this ticket — fix 13 migrated these files and
never drove them: the shim has no `.not()` (two tools: `get_upcoming_
maintenance`, `crm_get_follow_ups` — the only two calls in the tree); four
tools select a PostgREST embed the codemod's blocker regex let through, since
it wants the table name flush against the parenthesis and `maintenance_tasks (`
and `recipes:recipe_id (` are not (`search_maintenance_history`,
`get_meal_plan`, `generate_shopping_list`, the shared `view_meal_plan`) — so
fix 13's "four of the 54 files use embedding" undercounts; and a JavaScript
array binds as its `String()`, so `crm_add_contact` with `tags: []` is `22P02
malformed array literal: ""`. Two more tools' error paths render `[object
Object]` because the shim's error is a plain object where supabase-js's
extends `Error`. The write path works — `add_maintenance_task` stores the row
under the configured `user_id` — so a fork user could add tasks and never
list what is due. That is a second mechanism (three shim features and the
codemod's blocker, with a tool-level drive to hold them), and it is filed as
SMD-1588 with the evidence; here, the four extension READMEs name their
failing tools above the Connect step (household-knowledge's all ran), the
primitive and the shim README carry the count once, and this section's claim
is the exact one: the servers start, authenticate and answer over the port —
eighteen of twenty-five tools work end to end, seven wait on SMD-1588 (done in
change 77, which also found the count was twenty-nine: the shared meal-planning
server's four had not been counted).

**Boyscout.** The passes' cut-for-space tidy-ups in the files this change
touched, no behaviour changed: the test's deadline is one constant for the
section rather than one per child; the CI step that runs the checker names
what it checks through check 11 (it stopped at check 8); this section's
counts of check 11's probes read the arrays as pass 1 left them (twelve,
three through a dependency, six non-probes; "eight" and "eleven" were the
implementation's) and pass 1's paragraph says what it added (four probes and
one widened non-probe, not "two non-probes"). Left as they are, with the
reason: the migrated files' banner says `node scripts/…` while the codemod's
header says `bun` — 23 upstream-owned files for a word, and node runs it; the
extension credential trackers' Supabase lines beside the new Postgres URL
line — upstream's teaching path.

**Verified:** `bun test-auth.ts` 709/709 (643 before: sixteen starts × four
assertions, the tree guard, and the stand-in's identity after every import); every one of the sixteen — the five
extension servers, the sample, `work-operating-model-activation`, the two
thought servers, `open-brain-rest`, the auditor, the two workers,
`readwise-capture`, `rest-api`, `smart-ingest` — starts under `bun`, says its
port, answers its probe and is still running (the auditor's dry run under a
read key answers 500 against the refused stub database, past the gate as in
the in-process section); before the change an unmodified integration under `bun` failed at its
`jsr:` import and an unmodified extension served only under `bun --preload`
of the two globals — the two starts probed by hand; `bun scripts/check-fork-consistency.mjs`
PASS with check 11's fifteen probes, and six mutations of the tree each caught
on the right file and line — the runtime line removed, the line moved after
`hono`, `Deno.exit` in an entry, `Deno.args` in a `_shared/helpers.ts` reached
through its entry, the `jsr:` line restored beside the polyfill, `npm:hono`
as a specifier (a lesson from the mutant run: `git checkout --` restored the
mutated files to HEAD and wiped the branch's own uncommitted lines with them
— restore a mutation from the saved text, never from git, on a dirty tree);
after pass 1, the test's own failure modes re-run under mutation — `serve`
removed from the polyfill: sixteen named failures in 0.9 s with the
`TypeError` text; the polyfill installing over the stand-in: one counted
failure with a tally in 0.1 s; the port line unmatched under a two-second
deadline: sixteen failures in 33 s, no orphan — and the codemod's two odd
layouts (a `jsr:` types import second; two of them) each round-trip
identical with the polyfill first; after pass 2, a child that exits after
its port line is one counted failure, a human-written
`// ob1-original-types:` line survives `--revert`, and the running
reviewer's end-to-end run stands as the measure of what works: five schemas
applied, sixteen servers started, eighteen of twenty-five extension tools
answering, the seven that do not named in their READMEs and in SMD-1588;
`../db/with-postgres.sh bun test-writes.ts` 186/186 (the bio worker and the
other drivers unchanged under the stand-in); `bunx tsc --noEmit` in
`compat/supabase-sql` clean with `../deno-on-bun.ts` in its include;
`../../db/with-postgres.sh bun test-compat.ts` 84/84; the codemod round-trips
(23 reverted, 23 re-applied, the tree byte-identical, the local-brain client
kept) and its triage report marks a migrated file lacking the line with `!`
and prints the `KEEP` reason under "Needs a human". The ticket's verify —
each of the five starts under Bun and answers `tools/list` with a scoped key,
in CI; `test-auth.ts` still passes, and its stand-in is now the test's
convenience rather than the files' only runtime — is the suite.

**Not done here.** SMD-1588: the shim's `.not()`, array binding and error
class, the codemod's embed blocker (a space or an alias before the
parenthesis), the one-hop embed or an honest refusal for the three servers
already on the shim, and a drive of every extension tool against Postgres —
seven of twenty-five fail today, named in the READMEs (done in change 77). Deno deployability of a shim-importing file: the shim is
Bun's `SQL`, and a Deno-capable shim would be a second client to hold equal
to the first — the files that must deploy to Supabase stay on supabase-js
(`family-calendar`, `job-hunt`, `ob-graph`, `agent-memory-api`,
`metadata-norm`, `kubernetes-deployment`, the local-brain client). A compose
service per extension in `deploy/`: each server is one `bun` process on one
port, and `SETUP.md`'s TLS proxy is where a hosted client reaches it; the
READMEs say so. The extension READMEs' Supabase-shaped prose outside the run
step — credential trackers naming a project ref, RLS steps that assume
`auth.jwt()` — is upstream's teaching path and is left as it is beyond the
prerequisites, the schema step and the user-id step. The `Deno.serve` return
object carries `finished`, `shutdown()` and `addr` and nothing else of
Deno's `HttpServer`; no file on the shim reads even those. `rest-api` and
`smart-ingest` keep their own single-key compare (check 8 passes it; SMD-1455
left them). SMD-1541 and SMD-1525 as before.

**Upstream status:** not applicable — the shim, the codemod and the polyfill
are this fork's (fix 13); upstream's copies of these files deploy to
Supabase on supabase-js, which is what `--revert` restores. **Unfiled.**

### 75. The MCP endpoint answers GET with 405 before `authenticate()` — an authenticated GET no longer opens an SSE stream nothing writes to or closes (SMD-1259)

`server-portable/index.ts`, `server-portable/test-server.ts` ([13]),
`deploy/smoke.sh` (check 3), `deploy/README.md`, `SETUP.md` (Linear SMD-1259,
filed from change 42's first review pass; upstream
[#424](https://github.com/NateBJones-Projects/OB1/issues/424)).

**The defect.** `app.all("*")` handled every method. Beneath it the Accept patch
— upstream's #33 fix, written for POSTs from Claude Desktop connectors that omit
the header — set `Accept: application/json, text/event-stream` on GETs too, and
`StreamableHTTPTransport.handleRequest` then took an authenticated GET as a
request to open the standalone SSE stream. The transport here is built per
request and is sessionless: nothing ever wrote a message to that stream or
closed it. The response was `200 text/event-stream`, its headers flushed at
once, its body a `ping` event every 30 s from the transport's keep-alive and
nothing else, until the client hung up — or, on Bun alone, until its 10 s
per-connection idle reset beat the ping (SMD-1259 measured 10–12 s there). On
Node and Workers nothing on the server side ended it: an uptime checker
configured with the key parked one connection per probe, indefinitely. Each
such GET first cost an agent-registry resolve and a server build. Change 42's review reproduced it three ways:
`GET /?key=…`; `GET //.well-known/…?key=…` (a trailing slash on the base URL
doubles the slash, which Hono does not match to `/.well-known/*`); and
`GET /.Well-Known/…` (Hono matches case-sensitively). Upstream #424 reports the
same hang from mcp-remote, whose handshake GET waited 60 s for it. Any holder of
a key — a browser opening the connector URL the docs hand out, an uptime checker
configured with the key, a client echoing `?key=` on GET — could park
connections at will, and nothing rate-limited it.

**The change.** The route table now says what the endpoint serves. The MCP
handler is registered with `app.on(MCP_METHODS, "*", …)` for `["POST"]` alone,
and Hono's `notFound` answers whatever no route matched with
`405 Method Not Allowed`, `Allow: POST, OPTIONS` and the CORS headers —
before `authenticate()`, so no key shape reaches the agent registry or builds a
server, and the answer is the same for no key, a wrong key and a revoked one; it
is about the method, not the caller. 405 and not 404 because the handler serves
POST at every path: an unmatched request is always a method the endpoint does
not serve, never an unknown path. `notFound` rather than a trailing
`app.all("*")` (the second pass's shape) so that a route registered later is not
silently shadowed by dispatch order — the third review pass verified the two
byte-identical across every method and both odd paths. That 405 is the
Streamable HTTP transport's documented answer from a server that offers no
server-initiated stream. HEAD,
PUT and PATCH land there (the transport's own 405 for PUT and PATCH came after
auth and named `GET` in its `Allow`), and so does DELETE. The first draft kept
DELETE on the premise that the SDK client sends it from `terminateSession()` and
accepts 200 or 405; the first review pass read the client and found the premise
true and irrelevant: `terminateSession()` returns before sending anything when
it holds no session id, the id comes from an `mcp-session-id` response header —
which this server strips from every response — or from a `sessionId` the
application passes to the transport's constructor, so the only DELETE that can
arrive is from a client an application seeded by hand, and it accepts the 405 by
spec. A keyed DELETE bought a resolve and a server build for a transport with
nothing to close. One list — `MCP_METHODS` — registers the handler and names the
405's `Allow`, so the two cannot drift; the first draft had a string beside a
hand-written boolean, which the review named as a value defined twice. The CORS
`Access-Control-Allow-Methods` is left as it was on main, `GET, POST, OPTIONS,
DELETE`, on purpose: it answers a different question — what a browser may send
so that it can hear our answer — and the first review pass's version, which
derived it from the served list, would have turned a browser-hosted client's
DELETE (or a preflighted GET carrying `mcp-protocol-version`; GET itself is
CORS-safelisted, but a preflight still happens for the header) into a network
error where the server would have said 405. The second pass caught that.

**A contract change for health checks, and its remedy.** A keyless `GET /` or
`HEAD /` used to get the 200 JSON-RPC refusal; it now gets 405. A
platform-default HTTP probe — Kubernetes `httpGet`, a load balancer's target
check, an uptime monitor — can only GET and expects 2xx, so aimed at `/` it
would mark a healthy server down. So `GET /health` is a route of its own,
registered between `/.well-known/*` and the MCP handler, before
`authenticate()`: `ok`, 200, no key needed, a key ignored; Hono routes HEAD to
it as GET, so a HEAD probe gets a bodiless 200. It says the process is serving
and nothing else — readiness (is the database reachable) stays preflight's job
at the entrypoint, as the Dockerfile comment records. The third review pass
found the second pass's route an exact root match: behind the unstripped proxy
prefix `deploy/README.md` and change 42 already anticipate, `GET /mcp/health`
got the 405 — the very outcome the route was added to prevent — and so did
`/health/`. The route is now a GET handler on `*` that tests the path for
`health` as its last segment, optional trailing slash, and calls `next()`
otherwise (which lands on the 405). A route pattern was tried first —
`/:prefix{.+}/health` — and in `test-server.ts` matched `/mcp/health` and
`/a/b/health` but not `/functions/v1/open-brain-mcp/health`. Three passes
stated three mechanisms for that, and the fifth is the one driven directly
against the project's Hono 4.9.2 with each router named: the RegExpRouter
accepts `/:prefix{.+}/health` on its own and matches four segments; what makes
it throw `UnsupportedPathError` at registration is a `:param` route sharing the
root node with a static route — `/.well-known/*` here, or a plain `/health` —
regex or no regex; SmartRouter then falls back to the TrieRouter, and the
TrieRouter miscounts a `{.+}` prefix of three or more segments (its segment
counter matches one slash where it should match all). The scratch apps that
"matched every depth" in passes 3 and 4 were loading Hono 4.13.8 from Bun's
global cache, not the project's 4.9.2 — a scratch file outside the package
resolves `hono` elsewhere. The lesson holds either way: the pattern's reach
depends on router internals and on which Hono answers, and testing the path
depends on neither. The name is exact after Hono's decodeURI: `/healthz`,
`/Health` and `/health/x` are not it; `/he%61lth` is; an encoded slash `%2F`
stays encoded and is not a slash, so `/health%2F` and `/health//` are refused
while `/health/` and `//health` pass — one trailing slash, and an empty segment
is tolerated. The breadth — `health` under any prefix — stands in for a
base-path setting the server does not have; the mount change 42 defers would
match `${base}/health` exactly and should narrow it. `POST /health` is the MCP
endpoint, as POST at every path is, and a PUT or DELETE at a health path gets
its 405 with `Allow: GET, HEAD, POST, OPTIONS` — the health resource's methods,
which include the endpoint's, derived from the same list (the fourth pass wrote
`GET, HEAD, OPTIONS` and contradicted its own sentence about POST). The
image's `HEALTHCHECK` keeps POSTing to the endpoint, which also proves the MCP
path serves; `deploy/README.md` points platform probes at `<base>/health` and
says a browser opening the connector URL sees `Method Not Allowed`, which is
expected. Nothing in the tree GETs the endpoint for liveness (checked: the
Dockerfile, `compose.yaml`, `smoke.sh`, the workflows; the Kubernetes
integration uses a `tcpSocket` probe).

**What the ticket's smallest fix would have missed.** SMD-1259's second review
pass offered a method condition on the Accept patch as the minimal fix. Read
against the SDK client (`@modelcontextprotocol/sdk` 1.24.3,
`_startOrAuthSse`): the client sets `Accept: text/event-stream` on its own GET,
so the transport would have opened the stream for it whether or not the patch
ran. The patch is left as it was, with a comment saying only POST now reaches
it. The guard is the fix; gating the patch as well would have been a second
mechanism with no observable behaviour left to test.

**What the client does with a 405.** Read in the SDK source, not asserted:
`_startOrAuthSse` cancels the body and returns on 405 — the comment there reads
"indicates that the server does not offer an SSE stream at GET endpoint … an
expected case that should not trigger an error" — and any other non-2xx is a
`StreamableHTTPError` it reports through `onerror`. mcp-remote wraps this
client. A live connector has not been seen to do it; see below.

**Verified.** `test-server.ts` [13], 64 assertions against the real
server: eleven fetch rows — GET under no key, a wrong key, the right key in the
header and in `?key=`, GET carrying the SDK client's own headers, HEAD, PUT,
PATCH, DELETE with and without a key, and the case-variant discovery path — each
asserted for 405, an `Allow` naming the served methods, CORS, and a body that
is not a JSON-RPC envelope; the doubled-slash path handed to `worker.fetch` as
a `Request` object, because Bun's `fetch()` collapses `//` to `/` on the wire
and a fetch row probed the 404 route instead (found when that row failed) — an
earlier draft wrote the request line over a raw socket to prove Bun.serve's
parser passes `//` through, which the sixth pass called a harness property and
not a repo contract, production being Deno and Workers; `/health` → 200 with
CORS bare, with a key, as HEAD, with a trailing slash, under a one-segment and
under the Supabase-shaped three-segment prefix; `/healthz`, `/Health`,
`/health/x`, `/a/healthz` → 405 or 404 — route exactness, not a status
contract, since what a stray GET gets is the deferred path-axis decision, but
one of the two refusals and nothing else, because the third pass's `!== 200`
would have passed the abort marker, which is a hang, the one outcome the block
exists to refuse (the fourth pass reproduced it with a wrapped `fetch`);
`PUT /health` → 405 with `Allow: GET, HEAD, POST, OPTIONS`, and `POST /health`
with the key → the transport's `initialize` result (a keyless row would have
been satisfied by the JSON-RPC refusal, which the sixth pass caught). The sixth
pass also asked whether that health-path `Allow` — a second evaluation of
`HEALTH_PATH`, for a request nothing sends — is worth its seam; it is kept,
because an `Allow` that omits GET at a path that serves GET is a false
statement, and the cost is one regex test on a refusal path. A base-path
setting would make both the route and this branch exact; that is the mount
change 42 defers. The exact CORS method list lives in [3], where the preflight is
now probed through the same abortable helper, whose body parse sits outside the
transport try so a non-JSON body reports the status the server sent rather than
`SyntaxError`; POST reaching the transport is [7], which also sends
`Accept: text/event-stream` alone and gets 200 — the Accept patch now supplies
whichever of the two tokens the transport requires is missing, where it used to
test only the SSE token and let that POST through to a 406 after paying the
resolve and the build (change 84 removed the patch: at `@hono/mcp` 0.3.x the
transport takes either token, or none, and [7] sends all three forms
unpatched). Drilled by restoring the pre-change shape — the handler on
`app.all` and the `notFound` removed — 34 of 151 assertions fail: the
fetch rows holding a valid GET fail as `TimeoutError`; the doubled-slash row as
a 200 (the stream's headers flush at once; it is the body that never ends, and
that row reads only the status); the rows without a key as 200 with an envelope; HEAD, PUT and PATCH
by an `Allow` that names GET, from the transport's own 405 after auth; the keyed
DELETE by the transport's 200; the four near-miss paths and `PUT /health` by
the 200 refusal; `/health` keeps passing, being its own route. The
suite's 2 s abort on every routing probe stays: it is what turns the failure
mode this change closes into a red assertion instead of a stuck CI job, so it is
the test's teeth, not scaffolding to retire. `deploy/smoke.sh` check 3 GETs the
endpoint and expects 405; check 4 GETs `<base>/health` and expects the body
`ok` — right whether or not the proxy strips its prefix, by the path test
above. The body and not the status, because a 200 there proves nothing: a
server with no health route (upstream's, say) answers a keyless GET with a 200
JSON-RPC refusal, and a proxy that redirects unknown paths to a landing page
answers 200 too — the fifth pass's status-only check passed on both, while
three documents claimed a Supabase deployment fails it. Two checks, because
they are two contracts with two remedies (the fourth pass bundled them into one
tally to keep the count at eight, a constraint it had itself dissolved by moving
the count literal into one file). Both **with no key**. No key, because both answers come before `authenticate()` so a key proves
nothing, and because the script's status helper follows redirects with `-L`, on
which curl forwards a custom header to whatever host comes next — the first
draft sent the key, and behind a redirecting front proxy it would have landed in
a third party's access log. A 200 from the endpoint is the guard missing or a
front proxy answering `GET /` itself, and the message says both; a hang would
also read as 200 under `--max-time`, since the stream's headers flush before the
body stalls (the first draft said `000`, which curl prints only when no status
line arrives at all). Check 2's comment now says why a keyless discovery probe
suffices — the route answers before auth whether or not the key rides along —
rather than the false claim that the connector sends none. The former checks
3–7 are now 5–9. No document carries the count any more: `deploy/README.md`
says the summary ends with `0 failed` and exits 0, and `SETUP.md` points there.
This change bumped seven to eight by hand in two files before the fourth pass
noticed, then eight to nine in one, before the sixth pass asked why a number
the script computes is copied anywhere. `SETUP.md`'s tool counts (ten for a
write key, seven for a read key; three tools gated, not two) are corrected
where they contradicted each other eight lines apart, and
`server-portable/README.md`'s suite count and bundle size, stale since [11]
landed, now match the run, and are the only current copies of either number
(the dated run records in changes 42 and 43 keep theirs) — `SETUP.md` and the
known-issues entry below point there.
`tsc --noEmit` clean; the Workers bundle builds (`wrangler deploy --dry-run`,
281 KiB gzipped). The compose stack's smoke run is CI's `deploy-stack` job.

**Tidied while the files were open** (boyscout, after the sixth pass; no
behaviour change, the suite count unchanged): the two 405 header sets are built
once instead of spread per refusal; the test's probe deadline is one constant
where it was the literal `2000` twice; and the per-row refusal triple that [11]
and [13] each spelled out is one `expectRefusal()` helper beside `probe()`. Two
cut-for-space items were left alone because they change behaviour: an `Allow`
on the OPTIONS answer, and Hono's `cors()` middleware in place of the
hand-spread header (its preflight answers 204 where [3] asserts 200) — the
latter is a ticket if anyone wants it.

**Not verified: a live connector.** The same standing as change 42: a real
Claude Desktop connector, a claude.ai connector and mcp-remote against a deployed
build of this `main`, each completing `initialize` and listing tools. The SDK
reading above says they will. It is not the same as seeing it.

**Not done here.** The path axis — mounting the transport at a path and letting
Hono's `notFound` answer `/favicon.ico` and `/robots.txt` — remains the
deployment-contract decision change 42 describes; `/health` no longer waits on
it. Today those stray paths get the 405 like any other GET, which is a complete
answer if not the most descriptive one.
`server/index.ts`, the Deno Edge Function upstream deploys, carries the same
Accept patch and no method guard; it is upstream's file, and #424's PR #425 is
their fix for it. A Supabase deployment therefore fails smoke checks 3 and 4 as
it fails check 2, and for as real a reason: with a key, its GET hangs, and it
has no `/health` — its keyless GET there gets the 200 JSON-RPC refusal, which
is why check 4 reads the body.

Upstream status: #424 open, PR #425 open. **Unfiled** by us.

### 76. The kept bench corpus answers the exact oracle from its marker — `bench-hnsw.ts` records the exact pass's answers when it builds, and a reuse takes the first Q of them and computes only what the marker lacks (SMD-1562)

Change 72 made a `bench-hnsw.ts` pass at ten million rows reusable: 37 min 9 s
for the run that built the corpus, 7 min 24 s for the one that reused it. Most
of the seven minutes was the exact oracle — for each of the eight tiers and
once over the whole table, for each of fifty queries, an exact scan of ten
million rows with the vector index kept out of the plan: about 450 full scans.
Its answers are a pure function of the corpus (the seed and the scale), the
query count and K — the same on every reuse, and recomputed on every reuse.
Change 72's eighth and ninth review passes named it as the first thing cut for
space, and its boyscout left it out as new behaviour.

**The cache (`db/bench-hnsw.ts`).** The marker gains one field, `oracle`: a
map from the *shape* of the exact pass — a digest of the oracle's statement
in both filter forms (K inside it), the tier filter's form, a probe of how a
vector is rendered into its literal, and a probe of the server's distance
kernel — to that shape's entry: a digest of each query's literal, in
order, and for each tier key and the whole table one answer per query, the
exact top-K ids in distance order and the nearest row's cosine (the whole
table's is the confound the run prints). A build writes it with the marker,
after the exact pass — the marker was already written last, once the pass's
own confound gate had passed, so a refused build still leaves nothing. A
reuse looks up its own shape's entry, checks it whole (one well-formed answer
per query for every key: distinct ids, exactly as many as the exact answer
holds — K, or every matching row where fewer match — and a finite cosine),
and
takes answers from the front while the entry's query digests match its own:
the queries are drawn from the seeded stream after the rows' draws, so the
first Q of a longer run's queries *are* a shorter run's, and a run asking
fewer needs nothing computed. A run asking more computes the queries the
entry lacks — per key, only those — and writes its entry back whole, merged
into the map beside other shapes' entries; an entry answering for every query
is left as it is. Before anything is computed the plan the statement gets on
this server is read once, and a plan that reaches the vector index is
refused: the pass is exact because `enable_indexscan` is off and
`enable_seqscan` on, and an approximate pass written under a shape that
vouches for it would be trusted by every later reuse. The confound is the
largest nearest-cosine over this run's whole-table answers, the marker's and
the computed alike, and the gate on it stays. No new invalidation: the
answers are valid exactly while the rows are, and they ride inside the marker
whose physical fingerprint a reuse judges first — every refusal (another
scale, other parameters, a `rewritten` corpus, counts or regenerated rows
that differ, a ledger stranger, a drifted migration, a relation that moved,
a row written since the build's transaction id) exits before the oracle is
consulted. A marker without an entry for this shape — written before this
change, or by a tree whose statement differs — or whose digests stop
matching is computed for and extended, not refused: the answers are
derivable, the thirty-minute build is not, and `MARKER_FORMAT` stays at 2
because the cache names its own inputs. Answers are written back only under
`OB1_PG_KEEP` (a persistent database reached some other way is not this
bench's to mark), and the run says which: `corpus kept: marker written`,
`marker extended: … (had n, m of them this run's)`, or `not kept`. The oracle
hands its ids back in distance order (the marker's form) and the arms score
against those lists; the run line says `reused from the marker (…)`, `n of Q
queries from the marker, computing the rest` or nothing, as before; and
section L gains an `oracle` column — `computed`, `reused`, or `n of Q
reused, the rest computed` — beside `source`, since the heap is warmer after
a computed pass and latencies compare between rows with the same value. At
ten million rows and fifty queries an entry is nine keys × fifty × ten
uuids, under 200 KB of jsonb.

**Held to the computation (`db/test-bench-reuse.ts`, new).** The claim that
matters is that what a reuse takes from the marker is what it would have
computed, and two builds cannot test it — the parallel HNSW build gives two
graphs, and two recall figures — so the suite runs the bench eight times
against one database at 150,000 rows (the smallest kept scale) and compares
on one index: a build with five queries; a reuse with three (all the
marker's); the marker's answers removed, as a marker from before this change
has none, and three again (computed, the marker extended) — sections A, B, D
and E equal the previous run's, timings aside, and the confound agrees; one
whole-table answer given a duplicated id, and three again (the entry
discarded, computed, written back whole); the entry's second query digest
changed, and three again (one from the marker, two computed); six (three
from the marker, three computed, the marker extended to six); six again (all
the marker's, the tables as the run that extended it); then the corpus
marked `rewritten` as a refused reuse leaves it, and a run refused before
the oracle is consulted. It runs under `with-postgres.sh` like every
suite and tells only the bench it spawns that the database is kept — to the
bench, "kept" is the variable and the marker row, and the volume is the
wrapper's concern, held by change 72 — so the throwaway container is the kept
database for the runs and nothing outlives the suite; it drops its
marker table on the way out and takes about three minutes, which is why it
is in neither CI nor `ci-parity.sh`. A mutant that takes the *last* answers
the marker holds instead of the first fails exactly the equality.

**First review pass.** The cache named the rows it was valid for (through the
marker's fingerprint) but not the queries or the oracle's statement it was a
function of; it now carries a digest of each query vector and an
`ORACLE_SHAPE` number beside K, and a reuse takes answers from the front only
while the digests match its own queries — a changed stream, another K or
shape, or a malformed field answers for nothing and is computed for, and
each element is checked to be an answer before any is trusted (a marker
edited by hand would otherwise have been a bare `TypeError` after the
fingerprint was paid, or a silent recall of zero). The answers are one
record per (key, query), `{ids, top}`, where the confound had been a parallel
array aligned only by the loop that filled it; the three-way state — every
answer the marker's, some, none — is named once and rendered from there; the
spread over Q arguments that would have died at a million queries is a
reduce; and the marker line says what the marker had and how many of them
were this run's, where it had said `had none` for a record it was replacing.
The suite, which then drove `with-postgres.sh` itself under a kept name,
gained what that lifecycle needed: `--no-env-file` reaching a bun fronted by
the wrapper (it was loading `db/.env` for every `OB1_*` name the suite had
just stripped; reproduced with a flag in the file), removal of the container
and volume on an interrupt, the volume named up front, a thrown stop turned
into a failure with a tally rather than a stack trace, and one helper for
the two scored-table comparisons that carries the rows guard to both sites.

**Second pass.** The shape number was a hand-bumped integer standing in for
the statement's identity, which an edit to the statement would not bump; the
oracle's SQL is one function now, and `shape` is a digest of it rendered over
placeholders (both filter forms and the tier filter's), so a tie-break or
another operator recomputes on its own. `markerAnswers` hands back the
answers it validated rather than counts the caller re-derives through two
non-null assertions; the three-way state is one value the four renderings
index; the extension write is gated on `OB1_PG_KEEP` as the first write is
(a persistent database reached some other way is marked by neither). And a
second round on the suite's kept-volume lifecycle: the interrupt handler had
been fire-and-forget beside a main flow that did not know it had fired, the
runtime was a second copy of the wrapper's pick, the environment strip took
the wrapper's own knobs with it, `runScript` matched only a leading `bun`;
each was fixed (and the interrupt verified in run 1 and a later run: exit
130, nothing left), the build's workers and memory pass through the strip,
which is `shellWithoutOb1()` shared with `migratorEnv`, `scored()` gates on
the section letter by regex (the empty section had matched
`"ABDE".includes`), and the catch keeps the stack.

**Third pass — the mechanism was the finding.** Three passes in a row had
found seams in the suite's container-and-volume lifecycle (the runtime it
parsed from the wrapper's banner was a basename the wrapper itself may not
have on `PATH`, so the removal would have thrown inside `finally` on the very
macOS layout the README names), and what the bench means by "kept" is a
variable and a marker row: the suite now runs under one ordinary
`with-postgres.sh` container and tells only the bench it spawns that the
database is kept. Six kept volumes, the interrupt handler, the runtime pick
and the argv heuristic in `runScript` (back to a command that *is* bun, by
basename) went with it; the suite drops its marker table on the way out, so
it could join `ci-parity.sh` and stays out only for its three minutes. In
the bench: the marker's `oracle` is a map keyed by statement shape, each
tree writing its own entry beside the others' (`jsonb_build_object` over the
existing map) rather than over them — a kept volume outlives branches, and
two trees that disagree on the statement would otherwise have recomputed the
pass on every switch; the per-query digest covers the literal the server
parsed, not the doubles it was rendered from; an answer is at most K
distinct ids (a duplicated or overlong list had passed and skewed the
denominator); `markerAnswers` returns how many the entry held, so the
marker's line no longer reads a raw field the helper had rejected; the
three-way state is one `note` the run line, the cell and the confound's
parenthetical are read from, and the cell says `computed … not kept (no
OB1_PG_KEEP)` where the answers went nowhere, instead of `extended`; and the
arms take the answers themselves (`ids.includes` over lists of at most ten)
where a second copy as sets had stood behind eight non-null assertions.

**Fourth pass.** Two things at the root. The suite's exit dropped the marker
table unconditionally — under a kept name it would have dropped a kept
corpus's marker, the one witness `dropSchema` has, after run 1 was refused
for asking another scale; it now refuses a database that already holds a
marker and drops only the one it planted, on a normal exit and on a signal
(Bun runs no `finally` on one), through a connection it opens only after
the throwaway-database guard the other suites' resets go through. And the
oracle's exactness rested on `enable_indexscan = off` alone, unasserted:
with `enable_seqscan` also off — 019's setting on `match_thoughts`, or a
database- or role-level one — the planner reaches for the HNSW index again
(EXPLAIN on the bench's image), and this change raises the stakes, since an
approximate pass would be kept under a shape that vouches for it; the scan
now sets both, the settings are in the shape, and the plan is read once per
scale and refused, in the named form, if it touches the index (reproduced by
forcing `enable_seqscan` off: the refusal quotes the `Index Scan using
thoughts_embedding_idx` line). Then: `amendOracle` merges into
the map only where the map is an object (`||` on a hand-cleared `null` built
an array and killed the cache from then on); the shape digests a rendering
probe of `lit`, so two trees that agree on the statement and differ in the
literal — a last-ulp change in the generator, a formatter — hold two
entries instead of overwriting each other's; section L's `oracle` is its own
column, decided by provenance alone (`computed`, `reused`, `n of Q reused,
the rest computed`), and where the answers went is the marker lines' to say,
with a line for the reuse that was not kept; an entry carries only its
queries and answers, its key being the shape; the prewarm comment no longer
claims a heap warmed by a pass a reuse does not run, and says which rows'
latencies compare; the suite asserts every scored section is present rather
than a row count both reports could lack a section under; and this
section's lead now describes the shipped mechanism rather than the first
draft with the passes as errata.

**Fifth pass, on the tree merged with main** (SMD-1544 took change 73; this
section became 74 — and 76 once SMD-1480 and SMD-1259 took 74 and 75). The exact statement orders by distance *and id*: the
column is `vector(64)` and the cosine accumulates in float4, so distinct
rows can tie at rank K, and without the tie-break the id kept was whichever
worker's stream it landed in — an answer the marker keeps must not depend
on the plan that computed it. The map's key gains the server's side: a probe
of the distance kernel (the cosine between two fixed vectors, as text),
since the kernel's last bits differ between pgvector builds and CPUs, a
pinned image *tag* does not fix that and `extversion` does not show it; and
the planner settings leave the key — they decide the plan, which the plan
check holds, and a reordered `SET LOCAL` should not cost a recomputation.
An entry's whole-table answers must hold exactly K ids (a kept scale has
more than K rows; a trimmed list had passed and would have read as recall
lost). The suite: it had proved no marker existed when it started, so the
marker it finds at the end is its own and is dropped whether or not it
read run 1's line saying so (the line came after the commit; a Ctrl-C in
between would have left the marker); a signal is noted rather than acted
on, the run in flight finishes, the next run throws, and the drop happens
once in `finally` before the signal's exit — the handler had been dropping
the marker while the main flow, whose child had died of the same signal,
went on to spawn the next bench onto the dropped marker, which would have
rebuilt the corpus and written a new one. Two planted malformations join
the runs — a duplicated id in one whole-table answer, and a query digest
changed at index 1 — asserted to be computed for (`had none`) and to answer
for one query only (`1 of 3 reused`), so the guards and the prefix walk are
no longer mutant-blind; the remote-database flags pass through to the
spawned bench, which had refused a database the suite accepted; the marker
table's name is one exported constant the suite, the bench and `dropSchema`
share; and the suite reads section L's `oracle` cell rather than the run
line's prose. Declined: rewriting the statement as an `OFFSET 0` fence so
exactness holds by construction — the plan check already asserts it, and
the fence would trade a measured parallel top-N (Gather Merge over
per-worker sorts) for an unmeasured leader-side sort.

**Sixth pass — the stop signal.** Its top findings were the fifth's fixes:
the kernel probe keyed the cache on a float8's *text*, which the session's
`extra_float_digits` shortens (a role default set by some other tool would
have keyed a volume away from itself), so the probe renders under a pinned
setting; the tie-break had left the plan check's refusal blaming a database
setting its own `SET LOCAL` excludes, so the check judges by node kind (any
`Index Scan` over the one relation) and says what can still cause it; a
signal between runs still spawned the next bench, so the check comes before
the spawn too, and the header says what happens to a run in flight under a
group signal; a tier answer of any length up to K was trusted, so every key
is held to the exact answer's own size (K, or the rows that match); and a
malformed entry had read as `had none` again, so it counts what it held.
The guards themselves had been mutant-blind under two twenty-second
container runs — five of seven clauses could go and the suite would pass —
and the bench is a script that connects at import, so the pure part moved
to `db/bench-oracle.ts` and `test-schema.ts` [37] drives it in milliseconds
with the mechanism removed a clause at a time. Then: a run that exits other
than expected stops the suite with its output rather than cascading nulls
through the runs after it; the marker's DML reads the table's name from the
one constant; the remote-database flags are named once beside the guard
that honours them; and this section's lead names the kernel probe and not
the settings. Two passes had opened with the previous pass's fixes as the
top findings, which is where the loop stops.

**Seventh pass, at the user's call.** The key named the statement and the
kernel but not how `oracle()` turns the rows into what is stored (the
nearest row's `1 − d`, the ids in row order, `−1` for none), so a tree that
derived an answer differently would have read earlier entries as its own;
an ANSWER_FORM tag is one more element of the shape. The plan check's
`Index Scan` match also matched a `Bitmap Index Scan` line — the exact
bitmap over the GIN the comment beside it excludes — harmless on the
whole-table form it reads today and wrong the day the check reaches a
filtered form; a `Bitmap` prefix is excluded. The first query's digest joins
the key, so a tree whose query stream differs (an edit to the draws that
leaves the rows alone, which the regenerated rows do not catch) is another
entry beside the others rather than a write over them, and the write-back
that shortens an entry is left only for a stream that changed after its
first query. Then: the planted duplicate is the last id copied from the
first, the same length at any K, where `- 9` had spelled K = 10 and would
have let the length guard reject it before the distinctness guard was
reached; a run that exits other than expected is one tallied failure, not
two; the PGlite case is [37] (two blocks had carried [35]); the README's
expected outcome says the tally the suite prints; the lead counts eight
runs and names the two planted ones; the marker's binding comment names
`unsafe`'s parameter array, where the tagged template it described is gone;
`markerAnswers` is called as the total function [37] proves it to be, with
no ternary in front of it; and the 25-line JSDoc the extraction left behind
is the entry's, in its module.

**Boyscout, while the files were open** (what the passes cut for space, no
behaviour change): the marker-table probe is one `hasKeptCorpus` the bench,
the suite and `dropSchema` share, where three had spelled the `to_regclass`;
the digest uses `node:crypto`'s `createHash`, as `migrate.ts` and `auth.ts`
do, in place of Bun's hasher; the suite's two table readers share one cell
splitter and the section-L reader finds the data row from the separator
rather than by position; and the oracle entry is built where it is written
rather than on every path. A second look found the run line saying `done`
after a pass the marker had answered, and let it end as it stands. Left as
they were, being behaviour or outside the touched files: test-live's own
by-hand `OB1_*` strips, which
`shellWithoutOb1` could replace; a `--json` report the suite could compare
as data rather than scraped markdown; and prewarming the metadata GIN on
both paths so a reused row's first tier queries find it warm.

**Measured at ten million rows**, on the kept volume `hnsw10m`, with the
caveat that another session's ten-million-row store benchmark held two to
four of the VM's eight cores throughout, so no wall clock here is change
72's 7 min 24 s reuse's peer. The build took 56 min. A reuse that met the
marker as SMD-1493 wrote it — no answers — computed the exact pass and
extended the marker within about five minutes of connecting, then spent
52 minutes in sections A–E under that load (56 min 45 s in all). The reuse
after it took every answer from the marker (`exact oracle reused from the
marker (all 50 queries)`) and was into section A within three minutes of
connecting; its arms then took 78 minutes as the neighbour's load rose (81
min 1 s in all). Sections A, B, D and E of the two runs are identical cell
for cell, timings aside — the suite's comparison, run over the two reports.
The marker grew from 2,018 bytes to 208,858 with the one entry: ten keys ×
fifty queries × ten uuids. What the change removes is the exact pass, and
under the load it was worth about five minutes of a reuse here; alone, it
was most of change 72's seven.

Upstream status: **not applicable** — a fork-only bench harness. **Unfiled**
upstream. Reproduce: `./with-postgres.sh bun test-bench-reuse.ts`; or
`OB1_PG_KEEP=x OB1_BENCH_SCALES=150000 ./with-postgres.sh bun bench-hnsw.ts`
twice, the second run's section L reading `reused` under `source` and
`reused` under `oracle`.

### 77. The SQL shim reads the catalog — arrays bound by their column's type, `.not()`, one hop of resource embedding, an `Error` for an error, one pool per URL — and `test-tools.ts` drives all twenty-nine extension tools against Postgres (SMD-1588)

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

### 78. Every vendored MCP server is built for the request, or the session, it answers — the three per-scope singletons, one the ticket did not name and one it called correct no longer answer a request on another's transport (SMD-1497)

**The defect.** `integrations/delete-thought-mcp`, `integrations/update-thought-mcp`
and `recipes/work-operating-model-activation` built their `McpServer` once —
upstream at module scope, since change 67 once per key scope — and on every
request did `await server.connect(new StreamableHTTPTransport())` and handed
that transport the request. In `@modelcontextprotocol/sdk` 1.24.3
`Protocol.connect()` sets `this._transport = transport` before anything else,
and `_onrequest()` captures `this._transport` when the *message* arrives — and
`@hono/mcp` 0.1.1's `handleRequest()` awaits `ctx.req.json()` between the two.
So with requests A and B overlapping on one server: A connects transport TA,
B connects TB (overwriting), A's body finishes parsing, A's message is
dispatched to the server, and the server answers it on TB. TB has no stream
for A's request id, `send()` throws `No connection established for request
ID`, the SDK reports it to `onerror`, and A's client waits on a response that
will never come. Change 67's review pass found this and filed the ticket; its
second pass ran it — any two overlapping requests, not a burst. The fourth
server was `integrations/enhanced-mcp`, which the ticket did not name: it
keeps its own single-key compare and so was never in `extensions/test-auth.ts`'s
table, and the ticket was filed from a review of the files that were. It had
the same shape — `const server = new McpServer(…)` at module scope, thirteen
`server.registerTool(…)` calls beneath it, `server.connect(transport)` per
request — and the same hang, run. The fifth was the cost recipe's "after"
sample, `recipes/edge-function-cost-optimization/examples/after/`, which the
ticket held up as the correct shape for a singleton and this section's first
draft repeated: one `McpServer` per key scope, `connect()`ed once per
*session*. The grain is coarser and the defect the same — a server holds one
transport, so the second session minted for a scope took the server's
transport from the first, and every session but the last minted hung. The
review pass ran it on the pinned SDK: two sessions on one key, a POST through
the first's transport times out while the server logs `Failed to send
response: … No connection established for request ID: 1`, and a POST through
the second answers.
Two clients on one key, or one client whose session the isolate re-mints,
would have met it. (The SDK at 1.30.0 refuses a second `connect()` — `Already
connected to a transport. Call close() before connecting to a new transport` —
so a pin bump would have turned the silent hang into a loud 500; at 1.24.3
`connect()` has no guard.)

**The change.** The four servers build per request: `buildServer(principal)`
(or, for `enhanced-mcp`, `buildServer()`) is called where `serverFor(principal)`
or the module-level `server` was, connected to that request's transport and
dropped with it. The per-scope `Map` and `serverFor()` are gone from the three;
in `enhanced-mcp` the construction and the thirteen registrations are wrapped in
the function (a 1,517-line span re-indented — `git diff -w` shows the twenty
lines that changed, four of them the header comment). The re-indent is this
fork's largest whitespace-only divergence from the pin, by an order of
magnitude, in a vendored file: any upstream edit inside the span will
conflict on a plain rebase. The mitigation is one flag — `git rebase -X
ignore-space-change upstream/main` resolves whitespace-only hunks and takes
upstream's substantive edits at their old indentation, to re-indent by hand —
and the procedure under "Rebasing onto upstream" names it. The alternative,
a wrap with the body left at column 0, would have kept both diffs at twenty
lines at the cost of a 1,500-line function body no other server in the tree
formats that way; readability won. CI's deno-check job typechecks the
wrapped file from this change on (it never listed `enhanced-mcp`: change 67's
rationale for the job was the files that consume `../_shared/auth.ts`, and
this one keeps its own compare). This is the shape `kubernetes-deployment`, `ob-graph`, the
cost recipe's "before" sample and the seven extensions already had, and the one
the ticket called the cheap option. The "after" sample builds per *session*:
`server.ts` exports `buildServer(principal)` in place of the cached
`serverFor()`, `index.ts` builds the server beside the transport when it mints
a session and the session owns both, and the README's Step 2, Step 3 and file
tree say so — that shape needs a session store, a TTL and a client that sends
the id back, which the sample has and the four servers do not (they mint no
session id, so a client has nothing to send). Per request is not free, so it
was measured on the pinned SDK (Bun 1.4.0, 20,000 builds after 2,000 warm): a
one-tool server with `delete_thought`'s schema builds in 45 µs (31–45 across
the three reviewers' re-runs, most of it the SDK's Ajv instance, which
`tools/call` never uses — it validates with zod), the recipe's four-tool shape
in 70 µs, thirteen tools with five-field schemas in 474 µs. Those are Bun
numbers; the servers deploy on Deno, so the seventh review pass ran the same
build under Deno 2.9.6 with `enhanced-mcp`'s own deno.json (SDK 1.24.3, zod
4.1.13): one tool 92–97 µs against Bun's 37–39, thirteen five-field tools
776–839 µs against 216–221 — two and a half to four times slower, most of the
gap zod's schema construction — which puts `enhanced-mcp`'s real build at
roughly 1.2–1.8 ms on Deno. Cold start gets lighter, not heavier: the Ajv
instance moves from import time to request time, and the server is garbage
after the response instead of retained.
The cheapest thing any of these servers then does is a database round trip,
in milliseconds; the per-scope cache change 67 kept was buying tens of
microseconds and costing the hang. The cost recipe's README and its "before"
sample still call per-request construction the anti-pattern: their argument is
Supabase invocation counts and the handshake fan-out, which the server's
lifetime does not touch, and per session — once per handshake, not once per
call — is the grain their numbers assume.

**The harness.** `test-auth.ts` fires three `tools/list` at each MCP server
under one key, overlapping two ways, and asserts each answer carries its own
id and the full list — explicit statuses, since a `!== 200` would pass a
timeout (change 75). The first request starts alone with its body still
arriving for 20 ms, and without an Accept header, so the streaming body goes
through the servers' Accept patch as a Claude Desktop connector's would — which
found two servers with no such patch, `extensions/meal-planning/shared-server.ts`
and the cost recipe's "before" sample, answering 406 to any POST whose Accept
lacks `text/event-stream` where the other twelve patch it in (pre-existing;
SMD-1616; the probe kept the header for those two until change 84 moved the
transport to a version that wants no patch and removed all fifteen); the
other two requests start 5 ms later, complete. The stagger is load-bearing, and the
fourth review pass is why: three requests fired in one tick caught main's
shape (the `connect()` overwrite is independent of timing) but never open
the connect-to-body window itself — every handler in a burst reaches its
first await before any body is parsed. The regression that needs the window
is a "cleanup": build a server per request but `if (previous) await
previous.close()` first, the previous request's server kept in a module-level
`let`. In a burst the closed server is always an earlier, finished request's,
so all three answer (771/771 with the same-tick probe — the suite's count
then, before the fourth pass's last text rule); staggered, the second
request closes the first's server while its body is still arriving, `close()`
makes the SDK forget that server's transport, and the first request's answer
is sent to nothing — request 11 fails alone. (The fifth pass tried the other
reading — a server object kept and re-`connect()`ed after each `close()` —
and found a burst catches it too: it is main's shape again.) The margin is 15
ms: the first request reaches its body await within microseconds (measured:
connects at 3.6 ms, the other two at 9.2 and 9.5, its body read at 24.0),
and a stall longer than that degrades the probe to one request then a burst
of two — detection weakens, the fix cannot fail (forced with a 25 ms
stagger: the fix 772/772, the cleanup mutant still 1). Thirty-five runs,
ten of them under four CPU burners, all 772. One shape passes the probe
and is output-correct: a server per scope behind a serialising lock — the
lock covers the whole connect-to-dispatch window, so each answer reaches its
own transport. It is a worse design than a build per request, for reasons the
probe cannot see: every request under a scope waits for the previous one's
body to finish arriving, and the SDK's abort-controller map, keyed by JSON-RPC
id, is shared across unrelated clients. For `enhanced-mcp`, outside the
servers table, a section of its own imports it under the stand-in and runs
the same probe under the one key it reads. Two things the probe needed from
the harness: every in-process request now has a
two-second deadline and reports a hang as status 0 rather than waiting on it,
and the console silencer around a handler is a counter, not a save-and-restore
per call — two requests in flight each saved the other's no-op, and a hung
request never restored anything, so the first run of the probe printed `6
failed` with no failing line: the silencer had eaten them. A drift guard in
the file-text section refuses the spellings of a server that outlives the
request — a module-level declaration that names `McpServer` or
`StreamableHTTPTransport` (a shared transport routes by JSON-RPC id, which
distinct ids would pass), holds what `buildServer()` returns, or is a `Map`
— and the `enhanced-mcp` text is held to
`buildServer().connect(transport)`; it is a spelling check (an untyped `let
cached;` filled later passes it), and the probe is the proof. The "after"
sample, whose tool modules are not in the repository, is held by the
text-only rules to building its server beside its transport when a session is
minted, to no `serverFor`, and to no module-level declaration in `server.ts`
that names `McpServer` — a cache under any name.

**Verified.** `bun test-auth.ts` 772/772 (709 before: 3 overlapping × 13
servers + 14 guards + 5 for `enhanced-mcp` + 5 text-only rules for the "after"
sample). Drilled by putting `main`'s file back: `delete-thought-mcp` fails 3
of 772 — requests 11 and 12 `timed out after 2000 ms`, request 13 (the last
transport connected) answered, and the guard; `enhanced-mcp` the same three;
the "after" sample's `server.ts` fails its four text rules. The cleanup
mutant — a server per request, the previous request's closed first, held in
an untyped `let`, which the text guard passes — fails request 11 alone: the
staggered request, hung. The
fourth reviewer's other mutants: a server built before the 401 check for a
dummy principal fails the nine scope assertions; the probe with three equal
ids still fails main's shape (the deadline carries the detection, the ids
the attribution). `deno check` on `enhanced-mcp` passes (and CI's deno-check
job runs it for that file from this change on; its deno.json resolves
supabase-js).
`bun scripts/check-fork-consistency.mjs` PASS.

**Tidied while the files were open** (one commit after the seventh pass; no
behaviour changed, 772 before and after). The four servers' handler comments
repeated the mechanism their new header notes already state; each now says
what the line does and points at the note and this section. In
`test-auth.ts` the request deadline and the counted console silencer are
declared above the `request()` that uses them rather than below, and the
streaming-body test reads `body instanceof ReadableStream` rather than
`typeof body === "object"`.

**Not done here.** `enhanced-mcp` stays outside `test-auth.ts`'s table — its
own key compare (change 67's decision) and its integer-id read tools
(SMD-1525) are their own tickets. The "after" sample cannot be run here (its
tool modules are placeholders), so its fix is held by text and by the
mechanism the four runnable servers prove. The third review pass found, in
the per-session transport that sample keeps, a growth this change did not
introduce and does not fix: `@hono/mcp` 0.1.1 records every POST's `{ ctx,
stream }` in the transport's `#streamMapping` and deletes it only on abort or
`close()`, so a transport reused across a session holds one `Request` and one
Hono `Context` per tool call until the 30-minute prune drops the session
(measured: 200 completed POSTs on one transport, 0 of 200 `Request` objects
finalized after GC; with a transport per request, 200 of 200). The four
servers moved to a transport per request are clear of it; the sample's README
says the bound; SMD-1607 held the library fix, and change 83 moves the pin to
0.1.5, which releases each POST as it is answered. Nothing here changes a response, a
header or a tool surface; the answer a client receives is the same, now for
the request it sent.

Upstream status: at the pin, all five files carry the shared server —
`delete-thought-mcp`, `update-thought-mcp`, `enhanced-mcp` and
`work-operating-model-activation` at module scope, and the cost recipe's
"after" sample as an exported singleton connected once per session.
**Unfiled** by us.

### 79. The store measured against pgvector, and the second store not built — filtered recall is an in-engine question migration 014 already answers (SMD-1037)

The un-numbered section above, "A second vector store beside Postgres"
(SMD-1038), wrote down before any number existed the shape a second vector store
would take beside Postgres and the bar its numbers would have to clear: a recall
gap at a used filter tier, a latency gap at a reachable row count, or an index
build time that turns a re-embed into a maintenance window. SMD-1037 is that
measurement. It scores pgvector HNSW against pgvectorscale's DiskANN and
pgvector IVFFlat in the same Postgres, and against Qdrant in its own container,
on the fork's own corpus and on synthetic corpora to 10M rows — every store
against one exact-cosine ground truth over the same vectors, the comparators
wired into an eval (`evals/store-compare.ts`, `store-scale.ts`,
`store-backends.ts`) and never into the product. Like changes 31, 53, 55 and 59,
it ships no runtime change; the numbers are in evals/README.md, "Does the store
matter?".

**Unfiltered, the store does not matter.** On the real corpus pgvector HNSW
returns the exact top-10 for the unfiltered query — the case every vendor
benchmark reports — and so does every comparator. The pre-registered anti-bar
named an unfiltered-only win as no reason to move; there is not even a win to
argue.

**Filtered, a bare index loses recall — and that is the migration-014 question,
not a store question.** As the filter tightens, pgvector HNSW's default scan
returns a shrinking share of the exact top-10 (10% at a 3.5%-selective label),
because it picks its candidates before the filter and a rare label survives in
few of them — the SMD-968 hazard. Qdrant, filtering inside its graph, holds
100%; DiskANN, filtering its stream and rescoring, holds strongly and recovers
to near-exact. But the product does not run a bare index: `match_thoughts`
pushes the filter into the scan (migration 014), pgvector's own in-engine answer
to this exact loss, and DiskANN is a second in-engine rung. The recall dimension
of the bar is real and is met inside the engine; a second store matches the
in-engine rungs, it does not beat them.

**Latency and build cost at scale.** At a million synthetic rows (64-dim, where
random vectors defeat every index's recall, so these are build, size and latency
— not realistic recall): HNSW builds in 160s to a 570 MB index, IVFFlat in 12s,
and DiskANN — the best small-corpus filtered recall — in 8,165s, two hours and
sixteen minutes, with a filtered query latency of 520ms at a million rows.
Qdrant's read is its ANN search plus a Postgres resolve of the ids it returns:
9.3ms end-to-end at p95, larger than single-store pgvector HNSW's 4.1ms
unfiltered. At the product's real 1024 width the build costs are an order larger
— HNSW 35 minutes to an 8 GB index, and DiskANN's build exhausted the 14 GB test
machine outright. At ten million the pattern only sharpens: DiskANN did not
build inside a ten-minute bound (it needed 136 minutes at one million), HNSW's
own build took 139 minutes, and Qdrant's index no longer fit the test machine's
memory — in RAM it crashed search, on-disk it answered at seconds per query.

**Verdict.** None of the three triggers clears in favour of a second store
within reach. Filtered recall — the one real gap — is answered inside the engine
by migration 014 (and by DiskANN, at a build cost that rules DiskANN out at
scale); the external store matches that, it does not beat it. Latency does not
gap toward the external store — its id→row resolve makes the two-store read
slower than the single store, not faster. Build time is a real cost, but it
argues against DiskANN, not for Qdrant. The second store is not built. The
`thoughts.embedding` column stays the source of truth (SMD-1038's guardrail).
Two threads left open, each worth its own ticket if taken: a bounded evaluation
— not adoption — of DiskANN's SBQ compression, which gave the smallest index and
strong small-corpus filtered recall; and an upstream note that pgvectorscale's
parallel DiskANN build crashed the Postgres backend at a million rows (a serial
build completed).
### 80. The gate's sample is drawn by TID range — migration 038 reads its eight pages as eight TID Range Scans instead of a `TABLESAMPLE SYSTEM` over the whole heap, so the sample costs eight page reads at any size and counts the pages it drew (SMD-1526)

Change 70 ended on a term that grows with the table, and this removes it.
Migration 037 gates the routing count behind a sample of the heap: `FROM
thoughts t TABLESAMPLE SYSTEM (v_pct)` with the share sized to eight pages.
`SYSTEM` decides page by page over the *whole* heap — it hashes every block
number against its cutoff — so the statement carried about 2 ns per heap page
besides the eight pages' rows: a millisecond at ten million rows (526,000
pages) on every filtered call, whatever the buffer pool held. The empty-filter
shape one integration sends on every call went from 0.27 ms to 1.31 in change
70's bench, and by the slope a hundred million rows would pay some 10 ms.
Change 70's third finding measured the term, its header named this statement
as the fix, and SMD-1526 filed it with a second, smaller defect from the same
statement: `pages_seen` counted the distinct pages among the rows *returned*,
so a sampled page with no live row — a mass delete and a plain `VACUUM` leave
them — dropped out of the denominator and the scaled estimate was biased up.

**Migration 038.** The gate is 037's — the same floor, eight pages, three
conditions over three counts, the collection wrapped in the same `IF` — and
only the statement that produces the counts changes:

```sql
SELECT count(*) FILTER (WHERE p.hit), count(DISTINCT b.blk) FILTER (WHERE p.hit), count(DISTINCT b.blk)
  INTO v_hits, v_hit_pages, v_pages_seen
FROM (SELECT DISTINCT floor(random() * v_pages)::bigint AS blk FROM generate_series(1, 8)) b
LEFT JOIN LATERAL (
  SELECT (t.metadata @> filter AND t.embedding IS NOT NULL) AS hit
  FROM thoughts t
  WHERE t.ctid >= ('(' || b.blk || ',0)')::tid
    AND t.ctid <  ('(' || b.blk + 1 || ',0)')::tid
  LIMIT 291
) p ON true;
```

Eight block numbers are drawn from the heap's page count (`v_pages`, 037's
local, still computed at entry from `pg_relation_size`), made distinct, and
each is read as one TID range — every tuple of block *b* and nothing else, a
TID Range Scan (PostgreSQL 14 and later), one page read per block whatever the
heap holds. The rows on those pages are counted as 037 counted them, and the
third count is now the distinct blocks *drawn*: the `LEFT JOIN` keeps a block
that returned no row, which is the denominator the rule always meant. `v_pct`
goes; it was `TABLESAMPLE`'s argument. Everything else is carried token for
token — the rule, 014's collection ([20] compares it), 019's clauses, the
sentinel, the two template constants, and 020's `DROP` of the 4-argument form
with its ACL replay, since 038 is now the last definer that preflight's remedy
and the suites' `restoreShipped` apply alone (test-upgrade [16] holds it).

**Why this statement, and what the ticket's sketch got wrong — prototyped on
a real Postgres before the file was written.**

- *The probe needs a `LIMIT`, and it does two jobs.* The ticket's sketch was a
  `VALUES`/`generate_series` of the blocks joined `LATERAL` to the range probe.
  Written that way the planner pulls the `LATERAL` up into the join, the
  `ctid` bounds become *join* quals, and the TID Range path — which reads a
  relation's own restrictions only — is never built: the plan was a
  sequential scan of the whole heap under `Materialize`, cost 10,000,002,844
  under 019's `enable_seqscan = off`, 72 ms at 2,000 pages and 632 at
  200,000. A `LIMIT` on the probe keeps it a subquery (a subquery with a
  `LIMIT` is never pulled up), and 291 — `MaxHeapTuplesPerPage` on an 8 KB
  page — is a value no block can exceed, so it never cuts a page. It also
  caps the planner's estimate: the planner cannot see a bound that is an
  expression over another relation's column, prices the range at half a per
  cent of the heap, and uncapped that would put the eight probes at tens of
  thousands of cost units at ten million rows, within reach of
  `jit_above_cost` (100,000) on a larger heap — where JIT compiles the
  statement on every execution, the 50 ms a call change 70's third finding
  met. Capped, each probe is priced at 291 rows at most: the statement costs
  107 / 849 / 2,405 units at 2,000 / 20,000 / 200,000 pages and is flat
  from there. A build with 32 KB pages could hold more tuples on a dense page
  than the `LIMIT` admits; the count would then be short and the collection
  run — the safe side.
- *The draw is inside the statement, not in plpgsql.* The sketch drew the
  blocks in plpgsql. A `DISTINCT` subquery over `generate_series` costs no
  extra SPI round trip at entry (the unfiltered path still pays for `v_pages`
  alone, as under 037), keeps the estimate one statement over locals declared
  at entry — which is what `extractBody` and `routingAt` read for the bench,
  and what test-schema [8e] reads out of `pg_proc` to run against its own
  table — and is never pulled up either. `random()` in a target list
  is evaluated once per row of `generate_series` (the once-only trap is a
  scalar subquery, an InitPlan, which change 70 met loading its fixture);
  `DISTINCT` collapses a block drawn twice so no page is read or counted
  twice; the block is a `bigint`, since an `int` draw would overflow past 2³¹
  pages (a 16 TB heap — academic, and the wider cast is free).
- *Plan mode, which 037's statement lost on.* Both plan modes price the new
  statement alike — the bounds are column references under either — so
  plpgsql adopts the generic plan after the fifth call and never replans.
  Measured through a plpgsql wrapper on a 200,000-page heap: a few
  hundredths of a millisecond a call over the round trip in the default mode
  (0.01–0.09 across rounds, against a round trip of 0.2–0.3), 0.14–0.22
  under `force_custom_plan` (the replan), and 0.5–0.7 for 037's statement, which was priced 200× cheaper
  custom than generic and so replanned on every call. One plan, cached, eight
  page reads — while the paths the plan is built from are enabled. Turn one
  off at session, role or database level (`enable_tidscan`, `enable_nestloop`,
  or `enable_hashagg` and `enable_sort` together) and the planner still picks
  the same plan but adds `disable_cost`, 1e10, which carries the statement
  past every JIT threshold: the sample is compiled on every call, 41 ms
  against 0.46 on a 1,191-page heap, with the same plan node, the same eight
  buffers and nothing in preflight or the ledger to show it (review pass 3).
  The tidscan and nestloop sensitivities are new with 038 — 037's Sample Scan
  had neither a join nor a TID path — and the hashagg-and-sort one is 037's
  too (85 ms against 81). A function-level `SET jit = off` removes all three
  (measured) but also changes what the walk pays under a generic plan, which
  is SMD-1464's question; pinning the two `enable_*` GUCs on the function
  overrides an operator's setting for the walk as well. The decision is
  SMD-1624; the header states the premise. Row-level security on `thoughts`
  is a fourth trigger, and the one operators actually set: `jsonb_contains`
  is not leakproof, so under a policy `metadata @> filter` cannot be an index
  qual and 014's collection and the walk's direct CTE become sequential scans
  at `disable_cost`, JIT-compiled — 150 ms against 7 on 25,000 rows — since
  014/019 and unchanged by 038, whose TID bounds are leakproof (the probe
  keeps its plan; the policy undercounts its hits, the safe side). That is
  SMD-1625.
- *The bounds are text-built tids* (`'(b,0)'::tid` is at or below every
  tuple of block *b*, offsets starting at 1; `'(b+1,0)'` above them) because
  core Postgres has no constructor from a block number; the executor clamps
  a bound past the heap, so the last block's upper bound and a block the heap
  no longer has read nothing, cost nothing, and still count among the pages
  drawn — the safe side.
- *Not* `tsm_system_rows` (an extension the function would depend on — PGlite,
  where test-schema runs, does not ship it — with rows rather than pages as
  the unit and the `pages_seen` defect unchanged); *not* eight statements in
  a plpgsql loop (eight plans and eight SPI calls where one does; eight
  literal arms planned in 0.07–0.1 ms a call); *not* the planner's `@>`
  estimate, for change 70's reasons.

**The statement alone, one row a page, every page warm in the OS page cache**
(the 20,000- and 200,000-page heaps exceed the image's 128 MB `shared_buffers`)
(`EXPLAIN ANALYZE` execution time, median of 30, `enable_seqscan` off as the
function has it; change 70's first review pass measured 037's the same way):

| heap pages | 037's sample (`TABLESAMPLE SYSTEM`) | 038's (eight TID ranges) |
| ---: | ---: | ---: |
| 2,000 | 0.036 ms | 0.034 ms |
| 20,000 | 0.075 | 0.048 |
| 200,000 | 0.469 | 0.052 |

The fourth review pass re-ran both on a fresh container with its own code:
038 0.029 / 0.049 / 0.054, 037 0.027 / 0.071 / 0.433; the planner costs 107 /
849 / 2,405 and the absence of JIT reproduced exactly.

**The rule, re-measured for this draw** — 1,000 draws per filter on a
500,000-row corpus of the bench's shape (24,999 pages, twenty rows a page,
`v_exact` 1,000), 037's statement on the same corpus and the same draws'
worth in brackets:

| filter | matching rows | placement | skipped, 038 | skipped, 037 |
| --- | ---: | --- | ---: | ---: |
| 50% | 249,851 | uniform | 1,000 | 984 |
| 10% | 49,829 | uniform | 987 | 901 |
| 10,000 rows | 10,000 | one contiguous run | 0 | 1 |
| 1% | 4,915 | uniform | 1 | 1 |
| 2,000 rows | 1,882 | uniform | 0 | 0 |
| 1,000 rows | 1,000 | one contiguous run | 0 | 0 |
| 1,000 rows | 1,000 | four a page over 251 pages | 0 | 0 |
| 900 rows | 858 | uniform | 0 | 0 |
| 0.1% | 504 | uniform | 0 | 0 |
| 0.01% | 58 | uniform | 0 | 0 |
| nothing | 0 | — | 0 | 0 |

Every filter at or under the threshold ran the collection every time over
1,000 draws, on this corpus and on one just under the floor (163,840 rows,
8,191 pages: 50% skipped 1,000 and 10% 979 of 1,000 there in one run, 961 in
a re-run — a knife-edge tier, ten hits needed of a mean sixteen — against 993
and 905, 983 and 884 re-run; the contiguous 10,000 was skipped 10 times
against 037's statement's 13, not a wrong answer at ten times the threshold).
Every bracketed 037 figure is one run; a re-seeded re-run moved them by up to
two sigma (984 → 975 on the 50% filter, 337 → 296 on the bloated heap) with
every comparison keeping its direction.
The broad filters are skipped a little more often than under 037, because the
draw always reaches its pages: `SYSTEM` took a binomial number of pages with
mean eight and reached fewer than three about 1.4% of the time (e⁻⁸ × 41) —
the misses test-live [5d] widened its band for — where eight draws with the
duplicates collapsed reached eight distinct pages in all but a few of a
thousand at the floor (the fewest seen: 7 in 1,000 draws, 6 in 20,000). The
thin-spread layout, the one condition 3 is weakest against, was skipped 29
times in 20,000 draws at the floor — 1.45e-3, which is what change 70's
formula computes — C(8,3) × (251 / 8,191)³ = 1.6e-3 as a union bound, 1.44e-3
exact (a re-run: 34 in 20,000). 037's statement, re-run
on this heap, was skipped only 14 times in 20,000 — under the formula's 32 —
because `SYSTEM`'s variance made condition 1 fail whenever its draw reached
ten pages or more (twelve hits on nine pages still scale to 10.9× the
threshold here; on 037's 6,826-page heap the cut was nine pages, which is
where its header's 13 in 20,000 came from); that accident is gone, the bound
is the formula's and falls as the cube of the heap (7e-6 at a million rows,
7e-9 at ten million), and `hit_pages ≥ 4` remains the knob if the band
matters. At the ceiling count (`v_exact` 8,000) the picture is change 70's:
near the floor the 10% filter is never skipped (0 of 2,000; 037: 0) and the
50% filter about half the time (1,169 of 2,000; 037: 1,212), so the
collection runs as before 037 plus the sample. On a heap three quarters empty
— the 500,000-row corpus with its middle deleted and plain-`VACUUM`ed, 6,250
live pages of 24,999 — the broad filters get their collection back for want of
hits under both statements alike (50% skipped 332 of 1,000 against 337, 10%
126 against 132, the thin filters 0), and the denominator is now honest:
condition 1 failed in 105 of the 50% draws under 038 where under 037 it
failed in none, because 037's `pages_seen` had shrunk to the two pages that
answered and scaled twenty hits to the whole heap.

**Through the function, before and after, on the machine change 28 describes**
(`db/bench-hnsw.ts`, the before pass as `OB1_BENCH_UPTO=037` — the function
with 037's sample — and the after pass with 038, from one tree, on the same
day). The machine was busier than for change 70's tables: seven other
Postgres containers held the VM's memory throughout, and the before arm's
own figures sit above change 70's for the same 037 body at every tier (the
empty filter 1.05 ms at a million rows against 0.43 then), so read the
million-row columns as a pair and not against change 70's. At ten million
the two columns are two machines: the before pass ran under that load (its
50% tier 132 ms against change 70's 13 for the same 037 body — the walk
reading the index from disk), while the after pass — started three times
and stopped three times mid-build, twice by the VM's OOM killer with two
other sessions' benches resident, a kept ten-million corpus among them, once
when the server dropped the connection under the same pressure — ran on the
fourth attempt six hours later
on the idle VM change 70's own passes had, and its column sits within the
spread of change 70's 037 figures everywhere but the rows this change is
about (50% 13.2 then, 14.4 now; 900 rows 10.9 and 11.1). Section B, ten
asked, median over 50 random queries:

| rows | filter | matching rows | 037: in exact top-10 | median ms | 038: in exact top-10 | median ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1,000,000 | 50% | 499,443 | 3.0 | 20.16 | 3.0 | 14.87 |
| 1,000,000 | 10% | 99,748 | 5.5 | 63.47 | 5.4 | 53.62 |
| 1,000,000 | 1% | 9,951 | 8.9 | 426.32 | 8.8 | 328.66 |
| 1,000,000 | 5,000 rows | 4,916 | 10.0 | 31.93 | 8.6 | 399.43 |
| 1,000,000 | 2,000 rows | 1,963 | 10.0 | 16.98 | 8.5 | 559.51 |
| 1,000,000 | 0.1% | 1,034 | 10.0 | 11.73 | 10.0 | 9.33 |
| 1,000,000 | 900 rows | 934 | 10.0 | 10.26 | 10.0 | 7.81 |
| 1,000,000 | 0.01% | 99 | 10.0 | 2.38 | 10.0 | 1.39 |
| 1,000,000 | nothing | 0 | 0.0 | 1.05 | 0.0 | 0.34 |
| 10,000,000 | 50% | 4,998,406 | 0.9 | 132.40 | 0.7 | 14.42 |
| 10,000,000 | 10% | 999,827 | 2.1 | 387.55 | 1.9 | 49.88 |
| 10,000,000 | 1% | 99,633 | 5.5 | 2,608.58 | 5.3 | 425.48 |
| 10,000,000 | 0.1% | 10,231 | 10.0 | 115.04 | 4.2 | 914.71 |
| 10,000,000 | 5,000 rows | 5,088 | 10.0 | 63.11 | 10.0 | 55.80 |
| 10,000,000 | 2,000 rows | 1,978 | 10.0 | 36.98 | 10.0 | 33.14 |
| 10,000,000 | 900 rows | 886 | 10.0 | 13.91 | 10.0 | 11.09 |
| 10,000,000 | 0.01% | 959 | 10.0 | 15.51 | 10.0 | 12.13 |
| 10,000,000 | nothing | 0 | 0.0 | 1.67 | 0.0 | 0.36 |

Section C, the two statements themselves, extracted from the deployed body and
explained (execution time under a forced custom plan / a forced generic plan /
generic with JIT off; the 10,000-row rows are the sanity passes both arms ran
first, five queries):

| rows | statement | filter | matching rows | 037: ms | 038: ms |
| ---: | --- | --- | ---: | ---: | ---: |
| 10,000 | route | 50% | 5,041 | 0.60 / 0.54 / 0.65 | 0.68 / 0.63 / 0.72 |
| 10,000 | estimate | 50% | 5,041 | 0.10 / 0.10 / 0.08 | 0.12 / 0.08 / 0.09 |
| 10,000 | estimate | 0.01% | 1 | 0.11 / 0.14 / 0.10 | 0.14 / 0.10 / 0.08 |
| 10,000 | estimate | nothing | 0 | 0.12 / 0.08 / 0.04 | 0.08 / 0.07 / 0.12 |
| 1,000,000 | route | 50% | 499,443 | 35.09 / 33.41 / 33.67 | 28.13 / 29.54 / 27.70 |
| 1,000,000 | route | 0.01% | 99 | 0.65 / 1.07 / 0.73 | 0.65 / 0.68 / 0.71 |
| 1,000,000 | route | nothing | 0 | 0.05 / 0.04 / 0.07 | 0.03 / 0.04 / 0.03 |
| 1,000,000 | estimate | 50% | 499,443 | 0.25 / 0.31 / 0.30 | 0.12 / 0.10 / 0.11 |
| 1,000,000 | estimate | 0.01% | 99 | 0.30 / 0.22 / 0.25 | 0.09 / 0.08 / 0.09 |
| 1,000,000 | estimate | nothing | 0 | 0.32 / 0.36 / 0.27 | 0.10 / 0.10 / 0.10 |
| 10,000,000 | route | 50% | 4,998,406 | 297.21 / 316.29 / 283.95 | 278.63 / 317.77 / 284.75 |
| 10,000,000 | estimate | 50% | 4,998,406 | 1.17 / 1.14 / 1.15 | 0.12 / 0.10 / 0.10 |
| 10,000,000 | estimate | 900 rows | 886 | 1.10 / 1.13 / 1.20 | 0.11 / 0.12 / 0.10 |
| 10,000,000 | estimate | nothing | 0 | 1.20 / 1.12 / 1.14 | 0.10 / 0.09 / 0.09 |

Read down the tables and three things fall out.

- **The sample's cost is flat, and the empty filter has its cost back.** The
  `estimate` row reads 0.07–0.14 ms at 10,000 rows, 0.08–0.12 at a million
  and 0.09–0.12 at ten million under 038, the same three columns for the 50%
  filter, a thin one and the empty one — against 037's 0.04–0.14, 0.22–0.36
  and 1.10–1.20 (that last from the loaded before pass; 0.94–1.11 on the
  idle machine across change 70's two passes, so load barely moved that
  row): the 2 ns a page, gone. That is the ticket's first check (within a
  factor of two across the three scales; it is within 1.6 for any one filter
  and plan mode, 2.0 across the widest pair of cells, 0.07 and 0.14). Through
  the function the empty filter at ten million rows costs 0.36 ms — 0.27
  before 037 in change 70's pass, 1.31 under 037 there and 1.67 under 037
  today — which is the ticket's second check, within 0.1 ms of the pre-037
  figure; at a million rows 0.34 in this pair (1.05 under 037 today, 0.43 in
  change 70's pass, 0.21 before 037). The standalone table above says the
  same thing without a bench: 0.052 ms at 200,000 pages against 0.469.
- **The broad tiers lose the collection on every call now.** 50% at a
  million: 20.2 ms → 14.9, 10%: 63.5 → 53.6, with the recall columns
  unchanged (3.0 and 5.4–5.5, the index's own); the `route` rows are the same
  statement at the same cost (35 → 28 ms is the day's cache), so the
  difference is the calls that no longer run it — 037 skipped the 10% filter
  nine times in ten, 038 987 in a thousand. The thin tiers moved by the
  sample's saving and the spread (900 rows 10.3 → 7.8, 0.01% 2.4 → 1.4).
- **The planner's coin, on three more tiers.** At a million rows the 2,000-
  and 5,000-row tiers were served from GIN under the walk branch in the
  before pass (10.0 of 10 at 17 and 32 ms) and walked HNSW in the after pass
  (8.5 and 8.6 at 560 and 399 ms); at ten million the 0.1% tier did the same
  (10.0 at 115 ms, then 4.2 at 915), while the 1% tier walked HNSW in both
  passes at both scales. Every one of those tiers is above the threshold and
  routed to the walk by both arms — the gate cannot skip them (condition 2
  needs eight hits, and 160 sampled rows at 0.1–0.5% hold well under one)
  and cannot choose the walk's plan, which section E shows flipping under
  the seeded bounds on the same rows (17 ms and 10.0 against 577 ms and 8.5
  at a million; 851 ms and 4.2 against 206 ms and 10.0 with `ef_search`
  raised at ten million). Change 70 met the same flip on the 1% tier between
  its own passes under a fresh `ANALYZE`; it is SMD-1464's band, with three
  more rows for it.

**What it costs where it does nothing.** Under the floor — every real brain
today — nothing changes: the body computes `v_pages` at entry as under 037 and
runs no sample. Above it, every filtered call pays eight page reads: about
0.05 ms warm with one row a page, about 0.3 at the shipped width's 65–80
rows a page, eight random reads from disk on a heap larger than memory (on
the order of 0.1 ms each on NVMe, more on network storage), and nothing that
grows with the heap.

**Not done here.** Preflight still has no recogniser for the gate's body (a
037 or a 020 pasted over 038 passes the `filtered search` check; the
operator's path below), as change 70 said — a sentinel of the gate's own is
the line for the next preflight change. The threshold, the plan mode of the
*walk* statement (which flips onto a generic plan under a recency weight at
the ceiling and changes answers; change 70's "Not done here") and the seeded
bounds are SMD-1464; `ef_search` on real vectors SMD-1465. The `hit_pages ≥
4` knob is stated, not turned. The disabled-path JIT premise is SMD-1624; row-level security, which has cost `@>` its index since 014 and is a fourth trigger of the same JIT, is SMD-1625. A hundred million rows was not run, for the
reasons change 28 gives; what this change establishes is that the sample's
cost no longer depends on it. The bench's before arm (`OB1_BENCH_UPTO=037`)
does not combine with a kept corpus — change 72's rule: a corpus built under
a schema cut at a migration is measured and dropped, never kept — so a kept
ten-million corpus at 037 is not this change's before arm; the ten-million
passes here were built fresh, and the after pass's four attempts are the
tables' paragraph.

**Verified, on the merged tree:** `db/test-schema.ts` 901/901 under PGlite, [8e] rewritten (the
TID range probe, the three load-bearing tokens — `DISTINCT`, `LEFT`, `LIMIT
291` — no `TABLESAMPLE` in the body, the floor, exactness with the gate
reached; then the statement read out of the installed body, on a compacted
heap of some sixteen pages: five draws judged by the rule and each reaching
two to eight pages, its plan TID Range Scans with no sequential scan and no
Materialize, one block drawn eight times over reporting one page and its rows
counted once — the `DISTINCT` — and, an eight-block band emptied and vacuumed
with live rows beyond it, the probe pinned to that band reporting eight pages
drawn, no hit and eight buffers touched — the `LEFT` join and the `<` bound —
where an INNER join reports none and a `<=` bound reads sixteen) and [20]'s
definer pin moved to 038;
`db/test-live.ts` 500/500 on real Postgres, [5d] now exact (the broad filter
makes exactly one GIN scan fewer per call than under 020's body, twenty of
twenty, each call on its own connection — PR #69's first CI run failed this
section at 020 2.00 a call against 038 1.50 where the same tree read 2.75 and
1.75 locally and 2.00 and 1.00 on a freshly reset schema: on one connection
plpgsql plans the first five calls custom and may switch the walk to a
generic plan from the sixth, the two plans scan the GIN index a different
number of times through the chunk join, and the arms' trajectories need not
cancel; a first execution per call gives every call the same plan on both
arms, and the failure message now prints the per-call counts; 0.27–0.33 ms a
call for the sample on its
386-page heap at the shipped width, round trip included); `db/test-upgrade.ts`
189/189, [16] new (038 onto a populated 037: no column, signature, row or
privilege moves; 014 re-applied by hand, then 038 alone, leaves one form);
`server-portable` `tsc --noEmit` and `test-preflight.ts` (205/205) clean;
`bun scripts/check-fork-consistency.mjs` PASS; `bench-hnsw.ts` before and
after at a million rows and at 10,000 (both arms' estimate rows: 037's a
`Sample Scan`, 038's a `Tid Range Scan`) and at ten million rows (the after
pass on its fourth attempt, the VM idle), above.

**Review** — five passes, two reviewers each, triaged fix / ticket / no;
the stop signal (a pass's top findings in the previous pass's own additions)
came at pass 2 and again at 4, the later passes at the user's call. What
changed the change: test-schema [8e]'s behavioural checks had run a copy of
the statement kept in the test, so an INNER join, a missing `LIMIT` and a
constant block all passed them and were caught by regexes alone — [8e] now
runs the statement read out of `pg_proc`, on a fixture vacuumed before the
load (its "emptied middle half" had been pages earlier sections left empty),
pins the probe to eight emptied blocks (an INNER join reports none drawn),
draws one block eight times over (without `DISTINCT` the hits come back
eightfold), asserts the plan (without the `LIMIT`, `Materialize` over `Seq
Scan`) and the probe's eight buffers from the scan node's own line (a `<=`
bound reads sixteen); the mutants were run and each is killed by the
assertion that names it. test-live [5d] compares raw scan counts (IEEE gets
x/20 − y/20 wrong for 52 exact deltas). What changed the documents: the
"no JIT at any size" premise (a disabled planner path adds `disable_cost`
and JIT-compiles the sample on every call, 41 ms against 0.46 — SMD-1624, the
decision between `SET jit = off` and pinning the paths, since either touches
the walk); row-level security as a fourth trigger, pre-existing since 014
(`jsonb_contains` is not leakproof, 150 ms against 7 — SMD-1625); "every
page in `shared_buffers`" corrected to the OS page cache (the larger two
heaps never fit the image's 128 MB; change 70's sentence carried the same
error); the knife-edge 10% tier at the floor (979 one run, 961 the re-run);
a handful of figures quoted tighter than their spread, and the header's
first-screen block for a paged operator. What was verified without change:
the planner account re-derived from source; every header number reproduced
on a fresh container with fresh code (costs and the absence of JIT exactly,
the rates within binomial noise, the bloated heap to the digit); the
deployer's paths through `migrate.ts` including a non-superuser owner;
preflight with pasted-over bodies; the PostgREST contract byte-identical;
restricted and read-only callers; 14,000 calls under concurrent truncation
and growth; both temp-table shapes; the suites green on PostgreSQL 15, 16
and 17 with the probe planning as eight TID Range Scans on each; [8e]
flake-free over twenty runs and [5d]'s exact band over 180 isolated
iterations (3,600 calls), where 037's body missed in 6 of 30 iterations of
twenty calls — the ~1.4% per draw the header attributes to it. Filed and not fixed here: SMD-1624, SMD-1625,
SMD-1627 (`--reapply` rebuilds a missing HNSW index in dynamic shared memory
and fails under a 64 MB /dev/shm; a non-superuser cannot bootstrap where
pgvector is not trusted — both pre-existing). test-live [7] flaked six times
across the passes — four with another suite in the worktree, twice alone —
and passed on every re-run: SMD-1545's, with the concurrent-suite lead
weakened accordingly. Boyscout, after the passes: one exported `TID_PROBE`
(both bounds) where three files had their own, [8e]'s FROM clause read once
and a tautological bound dropped, two helper comments reworded for two
migrations, test-upgrade [14]'s title naming the schema it applies, the
header's cost table stated once — no behaviour change; and a second look
after CI: the body comment above the sample statement trimmed to the
mechanism, its measurements left to the header; and a third: one place in
`test-support` reads the sample statement out of a body (`SAMPLE_STATEMENT`,
`sampleStatementOf`) for [8e]'s draws and [5d]'s timing, so the last kept
copy of the statement is gone; `buffersOf` reads one node's Buffers line when
given the node; `extractBody` ignores comment lines before it looks for the
estimate.

**The operator's path, walked.** A brain at 037 with rows, upgraded by `bun
db/migrate.ts`: "038 applied, 1 applied, 37 skipped", one `match_thoughts`
carrying the TID range probe and no `TABLESAMPLE`, a filtered call answering
as before. The same brain with 037's file pasted over 038 by hand: the plain
run reports "applied 0, skipped 38" — the ledger records both and cannot see
the body — and what is lost is the per-page term coming back, a degradation
preflight's stated scope does not cover (change 70's paragraph); `migrate.ts
--reapply` re-runs every file in one transaction and the probe is back. The
PostgREST contract — six argument names, the `RETURNS TABLE` shape — is
byte-identical to 020's. The README's bench command with `OB1_BENCH_UPTO=037`
labels its arm `after (014–037)` and explains 037's estimate as a sample scan;
the default labels `after (014 on)` and explains 038's as a TID range scan.

**Upstream status:** not applicable — 014's routing statement and 037's gate
are this fork's.


### 81. Quantised vector indexes at the shipped width, measured on real vectors — halfvec adopted for `match_thoughts` (migration 039), binary declined (SMD-1501)

At the shipped width — 1,024 dimensions, `qwen3-embedding:4b` truncated — a
ten-million-row brain's two HNSW indexes were argued to be "roughly four
times" the 5.4 GB + 1.1 GB change 28 measured at 64 dimensions. pgvector 0.7+
indexes `halfvec` (half the bytes) and binary-quantised vectors (a
thirty-second), and the published results at equal recall are build times cut
by an order of magnitude and footprints by up to twelve times, with a rerank of
the candidates on the full vectors giving recall back. Nothing in the fork had
measured either, and change 28's random 64-dimensional bench cannot answer a
recall question. The ticket's shape was a measurement rather than a switch:
`match_thoughts` has two candidate CTEs merged by MAX per thought, a rerank
would have to sit between the CTEs and the merge on both sides, the exact
branch reads no index, and `evals/eval-filtered.ts`'s unfiltered control
exists to notice the default path's rows moving.

**The harness (`evals/eval-quant.ts`).** The real vectors this fork holds at
1,024 dimensions are the two LongMemEval corpora `eval-longmemeval.ts` loaded:
S under the shipped model (19,825 whole vectors and 56,267 windows — the two
tables `match_thoughts` scans, 76,092 vectors) and M under
`qwen3-embedding:0.6b` at the same width (51,660 and 145,705: 197,365). The
ticket asked for 100,000 rows and the largest the corpus allows; these bracket
it, and no third real corpus at this width exists on the machine (embedding
100,000 more sessions at 4b is days). The harness copies a corpus, rows only,
into a throwaway database under the tree's schema (kept under `OB1_PG_KEEP`,
re-migrated on reuse), embeds the 470 questions with the corpus's model, takes
an exact pass with no vector index in existence — exact in the function's own
shape, the true nearest `v_fetch` per side merged by MAX, which is what a
perfect index would return; not the ten highest MAX scores over every row,
which the two-CTE shape does not compute, and the report counts on how many
questions the two differ: on none of the 470, on either corpus — and then
builds each arm's two indexes alone — timed under one `maintenance_work_mem`
and worker count,
sized, dropped before the next — and runs the function's unfiltered statement
with only the candidate ORDER BY changed, under the function's own SET clauses,
at `hnsw.ef_search` 40 / 100 / 400. The arm the deployed function walks goes
last, under the shipped index names, and a CONTROL holds the function itself
to that arm's mirrored statement question for question (0 of 470 differed,
both corpora, both before and after 039). LongMemEval's own per-question
filter matches a few hundred thoughts and routes every question to the exact
branch, so the harness as run never touched the HNSW index; the measurement
is the unfiltered default path, `match_count` 10, where the index is used.

Three arms: `vector` (001/007's `hnsw (embedding vector_cosine_ops)`);
`halfvec` (`hnsw ((embedding::halfvec(1024)) halfvec_cosine_ops)`, the query
cast to match, the candidates' similarity recomputed on the full vector — the
heap row is read anyway); `binary` (`hnsw ((binary_quantize(embedding)::bit(1024))
bit_hamming_ops)`, each CTE taking `v_fetch × R` candidates by Hamming distance
and reranking them by full-vector cosine to `v_fetch`, R = 1, 2, 4, 10 — 400
candidates at the default count is the ticket's `v_fetch × k`). Scored:
recall@10 against the exact ten; how often one of the question's gold sessions
is among the ten with the whole corpus as haystack (the exact pass is the
ceiling: 46.2% on S, 34.5% on M — a session whose text twins another's shares
its row); whether the ten are the identical list the vector arm returns at the
same `ef_search`; the round trip's median and p95 after one untimed pass.
Each corpus was built and measured twice (`quant-*.log` in the session
scratchpad; the tables are the second pass, the first is quoted where it
differs).

**What the pages hold.** At 1,024 dimensions a float4 vector is 4,096 bytes
plus its neighbour lists, and pgvector packs an index page by whole elements:
two do not fit an 8 KB page, so every vector costs the index a page — 8.2 KB
per row on both tables, both corpora (155 MB for 19,825 thoughts; 404 MB for
51,660). Three halfvec elements fit a page (2.75 KB per row); a binary element
is 128 bytes and a page holds twenty (0.4 KB). So the shipped index at ten
million rows is near 80 GB before the chunks', not "four times 5.4 GB", and
halfvec is not half of it but a third.

**Results, `ef_search` 40 (the default, which the function leaves alone).**

| arm | candidates per CTE | S recall@10 | M recall@10 | S gold-hit | M gold-hit | same list as vector, S / M | S ms | M ms | index bytes | build s, S / M |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vector (001/007) | 40 | 0.984 | 0.971 | 46.2% | 33.8% | 100% / 100% | 4.13 | 4.22 | 577 MB / 1,482 MB | 13.9 / 28.7 |
| **halfvec (039)** | 40 | 0.974 | 0.970 | 45.5% | 33.6% | 93.4% / 95.3% | 3.12 | 4.08 | 193 MB / 494 MB (33%) | 7.9 / 18.5 |
| binary | 40 | 0.955 | 0.939 | 46.0% | 33.4% | 69.6% / 68.3% | 1.80 | 3.08 | 31 MB / 79 MB (5%) | 2.5 / 7.3 |
| binary | 80 → 40 | 0.980 | 0.973 | 46.2% | 34.3% | 83.0% / 79.1% | 3.07 | 4.09 | " | " |
| binary | 160 → 40 | 0.993 | 0.991 | 46.0% | 34.5% | 86.6% / 82.8% | 5.63 | 7.92 | " | " |
| binary | 400 → 40 | 0.998 | 0.997 | 46.2% | 34.5% | 88.9% / 83.6% | 13.25 | 17.44 | " | " |

The `ef_search` sweep for the two contenders (S / M):

| arm | ef_search 40 | 100 | 400 | ms at 40 / 100 / 400 |
| --- | --- | --- | --- | --- |
| vector | 0.984 / 0.971 | 0.996 / 0.989 | 0.999 / 0.998 | 4.1 / 6.4 / 18.1 — 4.2 / 6.5 / 17.4 |
| halfvec | 0.974 / 0.970 | 0.993 / 0.989 | 0.999 / 0.999 | 3.1 / 4.1 / 9.1 — 4.1 / 6.1 / 14.8 |

The first pass had put halfvec at 0.981 / 0.971 and vector at 0.983 / 0.973
(S / M): an HNSW graph built in parallel differs build to build, and a
hundredth of recall is that spread; latencies moved by about a quarter between
passes on a machine shared with other sessions' containers. A third pass
after 039 landed, with `match_thoughts` itself now the halfvec arm's control
(0 of 470 differ on either corpus): halfvec 0.980 / 0.971 against vector
0.984 / 0.973, the function's own median 3.1 / 3.8 ms. Every gold-hit
figure is within a point of the exact pass's ceiling under every arm — on a
haystack of the whole corpus the LongMemEval questions are not what
distinguishes these indexes; recall against the exact answer is.

**The decision.** The bar, set before the runs: an arm is worth a migration
only if, at the default `ef_search` on both corpora, its recall@10 is within
0.02 of the vector index's, its median latency no more than 1.2× the vector
index's, and its bytes at most 60% of the vector index's. **halfvec clears
it** on every axis: recall within the build-to-build spread at every
`ef_search`, faster or equal (the walk reads a third of the pages), a third
of the bytes, builds in 57–64% of the time. **Binary is declined, and not on
the numbers alone.** Without a rerank it loses three hundredths of recall
(0.939 against 0.971 on M — under the bar, and 68% identical lists). Reranked
at 80 → 40 it meets every number the bar asks: recall within four thousandths
on both corpora, latency at the vector index's, 5% of the bytes. Reranked
further (160 → 40) it passes the vector index's recall at 1.4–1.9× its
latency, because the rerank reads every candidate's full vector out of TOAST
and the two-CTE shape pays it twice, once a side. What decides against it is
what the ticket's own framing named: a rerank is a change to the function's
body — a subquery and a second candidate depth to size inside each of the
four walk CTEs, a second knob beside `ef_search` — and it returns the
identical ten rows on only 79–83% of questions, where halfvec clears the bar
with a cast and 93–95%. Binary at 80 → 40 is the arm for a brain whose
halfvec index no longer fits in memory, and a decision to make on that
brain's numbers with this harness; for the default path today halfvec
dominates vector.

**Migration 039.** Two things, in one file (its header has the rest). The
two HNSW indexes are rebuilt over `(embedding::halfvec(D))` with
`halfvec_cosine_ops` **under their names** — built under a staging name,
001/007's index dropped, the staging index renamed — so preflight,
`test-live.ts` [5]/[5c], `bench-hnsw.ts` and `bench-plan.ts`, which match
plans on `Index Scan using thoughts_embedding_idx`, read as they did. A
re-run finds the shipped name already over halfvec, of this shape and valid,
and does nothing (a valid index of another shape that names halfvec — an
IVFFlat over the cast — is refused by name, with the staging build as the
remedy, rather than taken for done); a staging index built beforehand by hand — `CREATE INDEX CONCURRENTLY
thoughts_embedding_halfvec_idx …`, the path for a brain where a plain CREATE
INDEX would hold writers too long (about 100 µs a row under
`maintenance_work_mem` 2GB with four workers, the graph in memory: a couple
of minutes at a million rows, some twenty at ten million) — is adopted when
valid and of this shape, refused by name when of another, and dropped first
when INVALID; an INVALID index under the shipped name is rebuilt rather than
kept. And `match_thoughts` is 038's body
with the two walk branches' four ORDER BYs cast on both sides,
`embedding::halfvec(D) <=> query_embedding::halfvec(D)`, the index's
expression token for token; the similarity stays `1 - (embedding <=>
query_embedding)` on the full vector, so the threshold, the merge and the
exact branch — which reads no index and casts nothing — are on one scale. The
stored vectors do not change: `reembed.ts`, the servers and every writer are
untouched, and the expression index keeps itself on every write.
`search_thoughts_hybrid` calls `match_thoughts` by name and inherits.

**Applying it.** 039 is the first bulk graph build most brains meet — 001 and
007 indexed an empty table that then grew row by row — and neither the file
nor `migrate.ts` sets `maintenance_work_mem`, so the compose stack's migrate
service and a `bun db/migrate.ts` from a shell build under the server's
64 MB and two workers: pgvector keeps the graph in memory while it fits
(some 25,000 vectors at this width, 2.5 KB each) and finishes the rest in its
on-disk phase, many times slower, with a NOTICE no driver here surfaces
(review pass 2). The rule, in the header, `db/README.md` and
`deploy/README.md`: 2.5 KB × the vectors across both tables — 250 MB per
100,000, 2.5 GB per million — set on the migrating role before the run,
`/dev/shm` to hold it under parallel workers; `migrate.ts` now prints the
vector count and the setting in force just before 039 runs. The file lifts
`statement_timeout` for its own transaction (a platform's per-role timeout
would cancel a build of minutes and roll the file back after the work), and
its DROP and RENAME take ACCESS EXCLUSIVE, so a held reader past the
migrator's `lock_timeout` aborts the file — the by-hand staging indexes
survive that rollback, the plain build does not. And preflight gains a check,
`walk index`, for the one failure state 039 creates and nothing else sees: a
body that orders by the cast over an index that is not over it, or the
reverse, or an INVALID index under the name — every walk a sequential scan
under `enable_seqscan = off`, exact at 019's cost, with `proconfig` intact and
the ledger recording 039. It reads the body's ORDER BY and each index's
definition and validity from the catalog and names the re-apply as the
remedy.

**What moved, and what it costs.** The default path's rows: at `ef_search`
40 the identical ten on 93% of S's questions and 95% of M's, recall within a
hundredth, gold sessions within a point. `evals/eval-filtered.ts`'s
unfiltered control, re-run on the 576-issue Linear corpus with 039 in the
after arm: 599 of 601 queries return the identical rows before and after, and
the mean overlap rounds to 100.0% — two lists differ by a row each, the
index's approximation and the intended change. The one thing that gets slower is a statement nobody
in the runtime sends: `ORDER BY embedding <=> q` on the raw column, from
psql or a recipe's own SQL, had the vector index and now has a sequential
scan — exact, 10–100 ms per hundred thousand rows at this width — because the
cast is the index's key (`test-live.ts` [5] holds both plans). An earlier
definer re-applied by hand (038, 020) puts a raw-column body over the halfvec
index and gets that scan on every walk; preflight's remedies now name 039 as
`match_thoughts`' last definer.

One thing did move, and the first draft of this section misread it.
`test-live.ts` [5b] calls the function under a 99% filter on 2,000 random
unit vectors at 1,024 dimensions, and its ten-query overlap with the exact
top-10 fell from at least 85 of 100 under the vector index to 79–83 under
halfvec, three runs running. Measured per query through the function over
100 queries on that fixture: under the vector index every call returned all
ten exact ids; under halfvec the first five calls of the session lost two to
six ids each and the ninety-five after them lost none, on every build. That
is not precision, it is plpgsql's plan cache: EXPLAIN of the function's own
walk statement shows the vector index priced out of the plan on this fixture
— both the custom and the generic plan read the GIN bitmap, which is exact —
while the halfvec index, a third of the pages, wins the custom plans the
first five calls get (an Index Scan, 2.6 ms, and the walk's recall on random
vectors, about 7 of 10 at `ef_search` 40 under either index) and loses to
the bitmap again once the generic plan is adopted (9.7 ms, exact). A cheaper
index moved a plan that sat on the edge; the walk itself is what it was.
[5b] now sums fifty queries against a 90% floor and says so; the 039 header
carries it as a failure mode; `bench-hnsw.ts`'s section A, which walks by
construction, is re-measured below.

**What the suites found on the way.** `test-schema.ts` [21] — 020's blend,
"identical at weight 0" — compared the shipped function with 019's installed
under another name, over a fixture of 200 rows each on its own axis: every
row nearly equidistant from every other, a graph the HNSW walk reached 34 of
200 rows of under *either* index. The section passed for a year because both
functions walked the same graph; under 039 the comparison function had no
index, scanned exactly, and the two disagreed. The fixture now spreads each
row's remainder over 32 shared axes (the walk reaches all 200, asserted), and
the comparison function takes 039's cast so the two walk the same index. New:
[38] holds the swap's every case (re-run, 001 re-applied, a hand rebuild, a
staging index adopted) and pairs the body's cast with the plan — an Index
Scan under the body's ORDER BY, none under the raw column's; [4] reads the
halfvec expression; [8e] and [20] pin 039 as the last definer, and [20]
compares the CTEs to 014's with the cast taken out. `test-upgrade.ts` [17]
applies 039 onto a populated 038: no row, signature or privilege moves, the
walk agrees with the exact answer before and after, a re-apply keeps the
index OIDs, and an INVALID staging index is rebuilt (made by flipping
`pg_index.indisvalid`, which PGlite refuses and a server allows).
`test-live.ts` [5d] applies the last definer before it drops the index — 039's
swap would otherwise build one over its 25,000 rows. And the first CI run of
this branch failed ten assertions of `test-schema.ts` [17b] — the hybrid
search's three-row fixture — with `match_thoughts` returning the near match
and the distant note but not the exact match at cosine 1.0, on a run that
passed locally every time. The likeliest cause: PGlite never vacuums, so by
[17b] the HNSW index holds the thousands of rows every earlier section
deleted, and whether a walk through those dead elements reaches every live
row turns on the level each insert drew at random — inferred from the
symptom rather than shown, since a local probe with 2,500 dead elements over
four seeds returned all three rows each time. The two three-row sections
([17b], [26]) now VACUUM after their DELETE, so the vector arm is measured
over the rows it is given whatever the cause was. Any HNSW index between
deletes and a vacuum has the same exposure, and had it before this change.
922 / 501 / 210 assertions.

**The bench.** `bench-hnsw.ts`'s after arm applies the whole tree, so from
this change its section A recall and every walk tier are the halfvec index's
at 64 dimensions. A corpus kept under an earlier tree (change 72) does NOT
take 039 on its next reuse: the marker's physical fingerprint covers the two
HNSW indexes by relfilenode, and 039's swap is a new relation under the old
name, which the fingerprint would read as `rewritten` — by design, since the
marker's section L sizes and build times would describe a graph that no
longer exists. The bench reads the migrator's dry run before the live run and
refuses a reuse on which 039 is pending there, before anything is built
(the alternative was the rebuild inside `migrate.ts` under the server's
default `maintenance_work_mem`, hours at ten million rows, and then the
refusal; `test-bench-reuse.ts` [7] holds it). Remove the kept volume and
build the corpus again under this tree (`db/README.md` names the command;
the ten-million-row volume `hnsw10m` on the development machine is such a
corpus). A fresh run at the two large scales then prints the halfvec
index's sizes and build times in section L where change 28's table holds the
vector index's. Run at the two published scales under 039, section A's
after arm reads 8.3 of 10 in the exact top-10 at `ef_search` 40 and 10.0 at
400 for 10,000 rows, 4.8 and 9.6 for 100,000 — change 28's table has
8.2 / 10.0 and 5.0 / 9.5 under
the vector index, the difference inside a pass's spread — at 1.31 and 1.91 ms
for the default path (1.82 and 3.25 there, on a different day's machine).
Change 28's tables stand; section L still records the before arm's vector
index sizes, and at 64 dimensions a float4 vector is 256 bytes, so the
page-packing gain above is smaller there and unmeasured.

**Follow-ups.** halfvec's HNSW ceiling is 4,000 dimensions where vector's is
2,000, and `qwen3-embedding:4b`'s native 2,560 would fit — but 001 still
builds the vector index first at the column's width, so `config.mjs`'s
ceiling stays 2,000; lifting it means 001's index becoming conditional, a
change of its own. SMD-1465 (size `ef_search` on real vectors) has its
unquantised baseline in the sweep table above.

**Review.** Three high-effort passes, each a fresh reviewer over the saved
diff with its own lens, each triaged and verified by the suites. Pass 1
(correctness and teeth) found the decision prose contradicting its own
table, the [5b] regression misread as fp16 when it was the plan cache, an
exact reference that was not exact by construction, the swap block trusting
names, the DROP's lock, and a harness that could be pointed at its own
source. Pass 2 (the operator and the upgrade path) found the kept bench
corpus's dead end, the build under the server's default memory, the failure
state preflight could not see, "exact" over-claimed, and the shipped-name
check weaker than the staging one. Pass 3 opened on pass 2's fixes — the
bench should refuse before the build rather than document it, the new
preflight scenarios left two branches undriven, the migrator's count came
from the wrong statistic, the shipped-name remedy dropped the live index,
the same-source guard compared hostnames literally — the stop signal, and
each was fixed. Declined: a `cteLimit` parameter on the harness's statement
builder in place of the string split that makes the true-MAX statement — the
pass itself said nothing breaks today, and the split is one line beside its
reason.

Upstream status: **not applicable** — upstream's `match_thoughts` is the
guide's single-table function over a Supabase index. **Unfiled.** Reproduce:
`cd evals && OB1_EVAL_QUANT_SOURCE=<a LongMemEval database> OB1_EVAL_LME=<its
file> OB1_EVAL_EMBED=<its model>@1024 OB1_PG_KEEP=quant OB1_PG_SHM_SIZE=3g
../db/with-postgres.sh bun eval-quant.ts --plans`; `bun db/test-schema.ts`
[38]; `./with-postgres.sh bun test-upgrade.ts` [16].

### 82. LanceDB, the embedded store, measured too — the one part of the two-store cost it removes is the network hop, and the hop was never the cost (SMD-1662)

Change 79 (SMD-1037) bracketed the second-store question with a separate server
(Qdrant) and an in-engine index (DiskANN), and left one shape untested that the
ticket itself named: an *embedded* store, run in-process against local files with
no second server and no network round trip — though still a second store to keep
consistent with Postgres. LanceDB is that store. It is wired as a fourth store
into the same harness (`evals/store-backends.ts`, a `LanceEngine` behind the same
`ExternalEngine` interface as Qdrant), scored against the same exact-cosine
oracle over the same points, so the measurement isolates which part of the
two-store cost is the network hop and which is architectural. Like changes 31,
53, 55, 59 and 79 it ships no runtime change; the numbers are in evals/README.md,
under "Does the store matter?".

**Filtered recall holds — because LanceDB prefilters, which is the migration-014
shape, not a store advantage.** LanceDB has no unquantized HNSW; its unquantized
index is IVF_FLAT (the fair recall row) and its graph is HNSW_SQ (scalar-
quantized). Both apply the filter *before* the vector search, so on the real
corpus they hold recall at the selective tiers where a *bare* pgvector HNSW
collapses (portal 3.5%: bare HNSW 10%, LanceDB IVF_FLAT in the high 80s at
default — build-variable, exact once probed — and HNSW_SQ 99–100%). That is
exactly what Qdrant did in change 79, and
exactly what `match_thoughts` already does in-engine via migration 014's in-scan
filter. LanceDB *matches* the in-engine ladder; it does not beat it.

**The network hop, isolated — and it is a fraction of a millisecond.** The clean
measure is the bare per-query vector round trip at default effort: Qdrant's whole
call — a round trip to its localhost server plus an HNSW search — ran at 0.77 ms
median, LanceDB's in-process IVF_FLAT call at 0.57 ms. The ~0.2 ms difference
(0.1–0.2 ms across runs) is an upper bound on the network hop: it also folds in
whatever separates an HNSW search from an IVF_FLAT one, so the loopback trip
itself is smaller. Either way it is sub-millisecond, growing only with real
network distance — the whole of what "embedded" buys. (The two-store hybrid arm runs its vector and
keyword legs in parallel, so its means measure the round-trip *shape* — two trips
versus one statement — not the hop, which is why the hop is read from the bare
search latency instead.) What "embedded" does **not** remove is the rest of the
two-store cost — every read is still an ANN search plus a Postgres resolve of the
ids it returns, and two stores must still be kept consistent (SMD-1038's
consistency section). Those are the costs change 79's verdict rested on, and they
are unchanged.

**At scale, the leanest external store is still a second store.** LanceDB is
embedded and on-disk (memory-mapped Lance files), so at a million 64-dim rows it
loaded in 5 s and built its index in 2 s to a 541 MB dataset, against Qdrant's
28 s load, 92 s index and 994 MB — the leanest, fastest-built external measured.
At ten million — where change 79 recorded Qdrant's *in-RAM* index OOM-crashing
the 14 GB VM — LanceDB built its IVF_FLAT in 28 s to a 5.6 GB dataset where
Qdrant's on-disk index needed 26 minutes and 7.4 GB; being on-disk from the
start, it never needed the on-disk workaround at all. But its end-to-end read
(~7.7 ms at 10M, within noise of Qdrant's on-disk 7.3 ms) still carries the
Postgres id→row resolve, so it does not gap toward a latency win over the single
store any more than Qdrant did; it removes the hop that was already cheap and
keeps the resolve that was the point.

**Verdict — change 79's holds, now for a reason it named.** The one part of the
two-store cost LanceDB removes is the network hop; the hop is a fraction of a
millisecond (~0.1–0.2 ms) on loopback, not the cost the verdict rested on. What remains is what it rested on:
a second store's id→row resolve and the consistency tax of two stores. LanceDB is
the best-behaved external store measured — prefilter recall, the leanest
footprint, no server — and a best-behaved second store is still a second store
that does not beat what migration 014 gives Postgres in-engine. Not built; the
`thoughts.embedding` column stays the source of truth. (LanceDB is Apache-2.0 and
the fork is FSL-1.1-MIT — SMD-1038's guardrail — so it is a dependency of an
eval, not the product.)

**What this does not answer.** This measured a second store as a *subordinate ANN
index* — Postgres the source of truth, every read resolving ids back to it — and
on *retrieval quality* it found parity, with filter strategy (in-engine via
migration 014) the only real variable. It did **not** measure the two shapes
where a second store would actually earn its place, and the resolve/consistency
costs the verdict leans on are partly artifacts of that chosen topology: a
**read-model** shape where the store holds the payload and serves the read with no
Postgres resolve at all (SMD-1696), and the **scale/operational failure envelope**
— the corpus size and width at which single-store pgvector stops fitting or
building, plus the re-embed maintenance window and read/write contention it
imposes (SMD-1697). The 10M arm above already hints at the latter: pgvector could
not build there while LanceDB built in 28 s. So "not built" is scoped to
retrieval quality on a corpus the single store handles; the read-model topology
and the scale case are open.

**Upstream status:** not applicable — the store comparison is this fork's eval.

### 83. The `@hono/mcp` pin moves from 0.1.1 to 0.1.5 — the transport lets go of each POST it has answered, so a transport kept for a session (the cost recipe's after sample) no longer holds one Request and one Context per tool call until the session is swept (SMD-1607)

**The defect.** Change 78's third review pass found it and its "Not done here"
records it: in `@hono/mcp` 0.1.1 `handlePostRequest` records each request's
`{ ctx, stream }` in the transport's private `#streamMapping`, and the only
per-request delete is inside `stream.onAbort`. When a response completes
normally `send()` closes the stream and deletes the two maps keyed by request
id, not this one; hono 4.9.2's `streamSSE` then calls `stream.close()`, and
`StreamingApi.close()` does not run abort subscribers — only `abort()` does.
So a transport that outlives the request keeps the `Request`, the Hono
`Context` and the closed stream of every POST it ever answered, until
`transport.close()` clears the map. The four servers change 78 moved to a
transport per request drop the transport with the request and are clear of
it. The cost recipe's after sample keeps one transport per session, on
purpose — that is the sample's point — and grew by one request per tool call
for up to the thirty minutes its sweep allows a session.

**The change.** The library fixed this a year ago: 0.1.2 (honojs/middleware
PR #1342, 2025-08-26, "SSE keepalive timers cleaned up on close") gives every
`#streamMapping` entry a `cleanup()` that deletes it, and both `send()` on the
last response and `close()` call `stream.abort()` where they called `close()`,
which runs the subscribers and so the cleanup; the SSE callback awaits that
abort and hono's `streamSSE` closes the body after it. 0.1.3 and 0.1.4 are
version chores (a jsr/npm mismatch); 0.1.5 (2025-10-30) `unref()`s the
keepalive interval of the standalone GET stream, which the fork's servers
have not opened since change 75. The peer range, `@modelcontextprotocol/sdk
^1.12.0` and `hono >=4.0.0`, admits the pin's 1.24.3 and 4.9.2. 0.2.0 and
later do not: 0.2.5 wants the SDK at ^1.25.1, 0.3.2 at ^1.29.0 and is built
against hono 4.11.5 — a move of the SDK pin with it, not this ticket's (0.3.0
also relaxes the Accept check to either token, SMD-1616's mechanism; change
84 made that move). So the pin moves to 0.1.5 at every site that names it —
`extensions/package.json`, `server/package.json`,
`server-portable/package.json`, the thirteen `deno.json` (the core server,
six extensions, four integrations, two recipes) and the template
`extensions/_template/AGENT_SPEC.md` hands a new extension — and the three
`bun.lock` files, in one commit, as `test-auth.ts`'s pin guard requires:
seventeen sites, three lockfiles. What 0.1.5 leaves as it was: the body is
still parsed after the server has been connected (change 78's window — its
staggered probe still means what it did), a POST is still 406 unless Accept
names both tokens (SMD-1616 stands), and a `tools/list` and a `tools/call`
answer are the same bytes at both versions — status, headers and body.
What it changes beside the map: an entry stores `{ header: ctx.header }`
rather than the Context, and would call that unbound in JSON-response mode
with a session id — neither of which any server here uses.

**The sample.** `pruneExpiredSessions()` closes the transport of each session
it drops: `close()` aborts whatever stream is still open, clears the maps and,
through `onclose`, tells the SDK the server has no transport — a dropped
session is ended rather than left to the collector; the call carries a
`.catch` so that a rejection — nothing in `close()` throws today — cannot
become an unhandled one, which under Deno ends the isolate. The README's
paragraph on the session-long transport says the release is 0.1.2's and what
0.1.1 did.

**The measurement.** A probe from `extensions/` — one `McpServer`, one
transport, 200 completed `tools/list` POSTs, a forced GC, then how many of the
200 `Request` objects are gone — read through `WeakRef`s. The ticket's
numbers were read through a `FinalizationRegistry`, and a rearranged probe
read 0 of 200 in every arrangement, including a transport per request, because
the registry's callbacks stopped arriving after the first run; `deref()` after
`Bun.gc(true)` is read on our schedule, not the runtime's. At 0.1.1: the
shared transport releases 0 of 200; `close()` then releases 199; a transport
per request releases 198–199. At 0.1.5: the shared transport releases
199–200 of 200 with no `close()`; three rounds of each at each version. 200
POSTs take 4–16 ms either way. One or two can linger, reachable from the
frames that answered them under a conservative stack scan — the review's
standalone copy of the same loop read 98 of 100 twice in thirty rounds where
the suite's read 100 in ninety — so the slack is a property of the frame
shape, not of the transport, and no assertion should rest on its exact size.

**The test.** `extensions/test-auth.ts` gains a section after the pin guard:
one server, one transport, 100 sequential `tools/list`, each asserted
answered with its own id, then a forced GC and the count of `Request` objects
collected, asserted at 90 or more of 100 — 0.1.1 releases none, and the
distance between none and most is the mechanism; the exact slack is not (the
review pass moved the bar from 99). It is a test of
the pinned library, which nothing runnable in the tree exercised across a
session; the after sample, which does, cannot be run here (change 78) and is
held by a text rule that its sweep closes what it drops. The docblock names
the claim.

**Verified.** `bun test-auth.ts` 775/775 (772 on main: two for the transport,
one text rule). `server/`: `test-stateless.mjs` 47/47, the two other suites
PASS. `server-portable/`: `test-server.ts` 151/151, `test-auth.ts` 67/67,
`tsc --noEmit` clean. `deno check` on `recipes/ob-graph` fetched 0.1.5 and
passed. `check-fork-consistency.mjs` PASS. Drills: 0.1.1 put back in
`extensions/package.json` fails 12 — the eleven `deno.json` the guard compares
and the transport's `0/100 Request objects collected`; the sample without its
`close()` fails its one rule.

**Review, first pass** (one cold reviewer beside the author's read; the pass
covered change 83 with this one, and its findings there are recorded there).
covered change 84 with this one, and its findings there are recorded there).
Two findings here, both fixed. The release assertion's bar of 99 rested on
the slack being exactly one; the reviewer's standalone copy of the loop read
98 twice, so the bar is 90 and the paragraphs above say why. The sample's
`close()` was `void`ed; it carries a `.catch` now. Checked and found right:
the stream lifecycle at 0.1.5 (`send()` → `abort()` → `reader.cancel()`,
the frame already pulled because the transform's readable has no buffer),
that per-request transports hold no timer on the POST path, and that
deleting from the sessions Map inside `for…of` is safe.

**Tidied while the files were open.** The release section's comment in
`test-auth.ts` points at this section instead of restating it, twelve lines
to six; the test paragraph above loses a parenthetical. No behaviour change.

**Not done here.** SMD-1616 (the Accept patches, and whether 0.3.x's
either-token check is worth the SDK and hono moves it needs — change 84
made the moves and removed the patches). The after
sample is still untested by anything that runs it. No upstream issue was
filed against `@hono/mcp`: the fix shipped before this fork found the defect.

Upstream status: at the pin, `server/deno.json` and the twelve vendored
`deno.json` pin 0.1.1 — and upstream's `server/package.json` ranges
`^0.1.5`, so upstream's own Node suites ran a transport its Edge Function did
not deploy (the drift the fork pinned that file down for, and the pin guard
holds). The fork's seventeen sites read 0.1.5. A rebase over an upstream bump
of the same lines conflicts on one line per file — take the higher.
**Unfiled** by us.

### 84. The MCP stack moves together — SDK 1.24.3 → 1.30.0, `@hono/mcp` 0.1.5 → 0.3.2, hono 4.9.2 → 4.13.8, zod 4.1.13 → 4.6.5: a second `connect()` on one server now throws, the transport takes whatever Accept a client sends and the fifteen Accept patches are gone, and every SDK import carries the `@ts-types` pragma Deno needs to type it (SMD-1643, SMD-1616)

**Why now.** Change 83 found that the defect it fixed had been fixed in the
library a year earlier and the fork's pins had not moved. A survey of every
pin against npm (2026-09-17) put the MCP stack eight to thirteen months
behind, and the four constrain each other — `@hono/mcp` 0.3.x wants the SDK at
^1.29, the SDK at 1.30 depends on hono ^4.11.4, both take zod ^3.25 or ^4 — so
they move as one. The SDK's v2 package family (2026-07-28, a new wire
revision) is not this: two months old, clients unsettled; the 1.x line it is.

**What the move buys.** Three things the fork had wanted. SDK **1.26.0**
(2026-02-04) addresses GHSA-345p-7cg4-v4c7, "sharing server/transport
instances can leak cross-client response data" — change 78's defect, with a
name: `Protocol.connect()` now throws `Already connected to a transport. Call
close() before connecting to a new transport, or use a separate Protocol
instance per connection.` where 1.24.3 overwrote the transport silently. The
shape change 78 removed by hand is refused at the runtime, on the first
overlap, loudly; `test-auth.ts` asserts the throw. `@hono/mcp` **0.3.0**
relaxes the POST Accept check: a missing header reads as `*/*`, and either
token — or `*/*` — is enough, where 0.1.x demanded both and answered 406 to
everything else (measured at 0.1.5: no Accept, `application/json` alone,
`text/event-stream` alone and `*/*` all 406; at 0.3.2 all 200). Every Accept
patch in the tree existed for that check — the re-wrap of the request into a
new `Request` with both tokens that upstream added for Claude Desktop
connectors (their #33), which the core server carried, the portable server
carried with change 75's either-missing predicate, twelve vendored servers
carried, and the cost recipe's after sample carried. **Fifteen files, all
removed**, twelve to twenty-one lines each. SMD-1616, the two servers that
never had one, closes with them: there is nothing left to be missing.
`test-auth.ts`'s overlapping probe now sends its first request with no Accept
header at all fourteen servers (the `acceptPatch` flag and its two rows are
gone), and asserts no server carries the patch; `test-server.ts` [7] sends
SSE-only, JSON-only and no Accept and gets 200 for each. SDK 1.30.0 also
fixed the SSE keep-alive timer lifecycle and widened `@hono/node-server` past
GHSA-frvp-7c67-39w9; 1.28.0 rejects a plain JSON Schema object passed as
`inputSchema` — nothing here passes one, or the suites would have said.

**The Deno trap.** With the pins moved, every suite passed under Bun and
`tsc --noEmit` passed under 5.9.3 and 6.0.3 — and CI's seven `deno check`
steps failed on the six files that build a server, every error the same:
`Binding element 'query' implicitly has an 'any' type` at each tool handler.
Bisected on a twenty-line probe with three tool shapes: SDK **1.28.0** types
clean under Deno 2.9.6, **1.29.0** does not, at either zod. 1.29.0's "Add
typings exports" (#1623) put `"types": "./dist/esm/*.d.ts"` in the `./*`
export. For `@modelcontextprotocol/sdk/server/mcp.js` that substitutes to
`dist/esm/server/mcp.js.d.ts`, a file that does not exist; TypeScript's
resolver then tries `.js` → `.d.ts` and finds `mcp.d.ts`, Deno's does not
and types the module as `any` — so every handler's arguments are `any`, and
`noImplicitAny` reports each. Tried and rejected: a `// @deno-types` pragma
at the `dist/esm/…d.ts` path (the exports map refuses `dist/` subpaths, in
`check` and `run` alike); an import-map entry aiming the `.js` specifier at
the dist file (refused the same way); `--node-modules-dir=auto` (same
resolver); the extensionless specifier `sdk/server/mcp` (types resolve — the
pattern gives `mcp.d.ts` — and **the runtime does not**: `Could not resolve
'npm:@modelcontextprotocol/sdk@1.30.0/server/mcp'`; the worst combination,
green check, dead deploy). What works: a **`// @ts-types="@modelcontextprotocol/sdk/server/mcp"`
pragma** on the line above the `.js` import — Deno reads the types through
the extensionless subpath, the runtime import is unchanged, and under Bun and
tsc the line is a comment. Twenty-two pragmas in twenty files: the seventeen
Deno-side files that import an SDK subpath (`server/mcp.js` everywhere,
`types.js` in the two single-tool integrations), the extension template
`AGENT_SPEC.md`, and the two READMEs that show the import line; the first in
each file carries a two-line note. `test-auth.ts` holds it: every SDK subpath
import in every MCP server it reads, enhanced-mcp, and the after sample's two
files is preceded by its pragma. Upstream, the SDK's pattern would want to be
`"types": "./dist/esm/*"`, which both resolvers handle; Deno could substitute
as tsc does. Neither filed.

**Beside the pins.** Two more things the release notes did not name, both
read out of 0.3.2's dist and neither present at 0.1.5. Every POST that is not
itself an initialize — whether or not the transport ever saw one; a stateless
transport skips the session check, not this one, so on the fourteen
per-request servers that is every tool call — is checked for the
`mcp-protocol-version` header: absent, it reads
as 2025-03-26 and passes; naming a version outside the SDK's list
(2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07 at 1.30.0) it is
refused with **404** and a "Bad Request: Unsupported protocol version" body.
A client sends the version it negotiated at initialize, which the server chose
from that list, so no known client meets it; `test-auth.ts` holds the rule
(200 at the newest listed, 404 at `1999-01-01`) so a bump that moves it is
seen here first. And a GET with *no* Accept header now reads as `*/*` and
opens the standalone SSE stream where 0.1.x answered 406: on the servers that
still route GET to the transport — upstream's `server/index.ts` and the
vendored `app.all("*")` servers, which change 75's method guard did not
reach — a keyed, Accept-less GET hangs where it used to fail fast. The SDK
client and mcp-remote send `Accept: text/event-stream` on GET and hung there
already (change 75, SMD-1259); a bare curl is what changes. What the notes
and the measurements agree did not change: a `tools/list` and a `tools/call`
answer are byte-identical
across the move — status, headers, body; `handlePostRequest` still awaits
`ctx.req.json()` after the server is connected, so change 78's staggered probe
still means what it did; a transport reused across 200 POSTs still lets go of
every Request (change 83's assertion holds at 200/200). The build cost on
change 78's harness moved the right way: one tool 39 → 36 µs, thirteen tools
218 → 129 µs (Bun 1.4.0, same machine, same session). Two packages enter
the lockfiles as `@hono/mcp`'s peers: `hono-rate-limiter` 0.5.4 and
`pkce-challenge`, for its auth middleware, which nothing here calls —
`pkce-challenge` does load with the module (a static import of the package's
`auth.mjs`, which its `index.mjs` imports), `hono-rate-limiter` only when the
rate-limit middleware runs. The
pin guard found two files the seventeen-site count missed — the two REST
integrations' `deno.json` pin hono and zod without `@hono/mcp` — so nineteen
sites.

**Verified.** `bun test-auth.ts` **809/809** (775 at change 83: thirteen
no-patch guards, thirteen pragma guards, the enhanced-mcp pair, the SDK's
throw, the protocol-version pair, the core server's pin mirror, three text
rules for the after sample).
`server/`: `test-stateless`
47/47 and the two other suites PASS. `server-portable/`: `test-server.ts`
153/153 (151: the Accept row became three), `test-auth.ts` 67/67,
`tsc --noEmit` clean, `wrangler deploy --dry-run` builds. `extensions/`:
`test-tools.ts` 122/122 and `test-writes.ts` 186/186 against Postgres. All
seven `deno check` steps pass with the pragmas — and the six files that build
a server fail without them (pragmas renamed, checks run, pragmas restored):
`server` 11, `family-calendar` 6, `job-hunt` 10, `ob-graph` 27,
`kubernetes-deployment` 11, `enhanced-mcp` 13 errors, every one an `any`
handler argument. `check-fork-consistency.mjs` PASS.

**Review, first pass** (one cold reviewer beside the author's read, over
changes 83 and 84 together; ten findings, two of them 83's and recorded
there). Fixed: `server/bun.lock` had kept a nested zod 4.5.4 for the SDK
beside the 4.6.5 the Edge Function deploys — `server/package.json` listed no
zod, so `bun install` had nothing to hold it to; zod is pinned there now and
the lock regenerated from nothing, one zod. The pragma guard counted only
the imports its one-line regex matched, so a multi-line or single-quoted SDK
import would have passed unguarded beside a guarded one; it now also counts
every SDK specifier in the file and wants the two counts equal. The no-patch
guard matched one exact spelling; it matches any `.set("Accept", …)`. Four
comments still described the patch as present (two in `test-auth.ts`, one in
the portable server, and `test-server.ts` [7] calling an SSE-only Accept the
SDK client's POST form — that is its GET form; its POSTs name both tokens).
"Which nothing here imports" of the two new lockfile entries: `pkce-challenge`
does load with the module, `hono-rate-limiter` does not; the paragraph above
says so. The protocol-version 404 and the Accept-less GET, which the author's
read had found and written up between the commit and the review, the reviewer
found independently and confirmed against the dist. Not reproduced: one run
in the reviewer's ninety, made beside its other probes, reported two failed
assertions its loop did not capture (it kept the summary line; the suite
prints every failing line); thirty runs alone here failed none, and CI runs
the suite alone. Declined: a GET method guard for `ob-graph` and upstream's
`server/index.ts` — SMD-1259's family, not this change's — and a CI retry for
a flake that does not reproduce alone. Checked and found right: the stream
lifecycle at 0.3.2 (no `finally { close() }` in its `streamSSE`; the body ends
through `abort()` → `reader.cancel()` with the frame already pulled), 202 for
a notification now a JSON `null` body, no tool name in the tree that
`validateAndWarnToolName` would warn about per request, `response.headers`
edits still landing on 0.3.2's fresh Response, and the counts here.

**Review, second pass** (a second cold reviewer, given the first pass's
additions to read first). Nothing above LOW, and every code finding sat in
the first pass's own additions — the stop signal. Taken anyway, each a line
or two: the protocol-version check runs on every POST that is not itself an
initialize, whether or not the transport ever saw one — the paragraph above
said "after initialize", and the test's own transport, which never saw one,
had shown otherwise; the test names `LATEST_PROTOCOL_VERSION` rather than
the list's first entry, so its label is true by construction; the no-patch
guard matches the patch's mechanism, `Object.defineProperty(c.req, "raw"`,
not the header it set, which an outgoing fetch may set too; the pragma
guard's message admits the other way it fails — an SDK import in a spelling
it does not read (single quotes, no semicolon, a line break), which it
refuses rather than passes. And one gap the first pass's fix had exposed:
`server/package.json` promises to mirror `server/deno.json` exactly and
nothing held it to that, which is how the nested zod arrived — the pin guard
now compares the two on every MCP-stack import (supabase-js excepted: the
Node suites never load it, no installed package peers it); drilled with
hono at 4.13.7 in the one file, one failure naming it. Its first spelling
named supabase-js as a quoted literal, which the shim codemod takes for a
migration target — CI's round-trip check rewrote the test file and failed
the PR's first run; the exception is a regex now. Merge 4b8e5ec's
hand-resolution checked against both parents: nothing duplicated, nothing
lost. Noted, not this change's: four servers' `Access-Control-Allow-Headers`
omit `mcp-protocol-version` (and `last-event-id`) where the core, the
portable server and `kubernetes-deployment` carry them — a browser client
sending the header the spec asks for is refused at preflight; pre-existing,
and only sharper now that the header is validated (SMD-1668). 809
assertions.

**Tidied while the files were open.** The comments the two passes grew in
`test-auth.ts` — the pragma guard's, the transport and SDK blocks', the
protocol-version pair's, the pin mirror's and the probe's Accept sentence —
cut to a pointer at this section each, forty-seven lines to twenty-eight; and
two references the renumber had missed, where the word `change` and its
number sat on different lines (the transport block, `test-server.ts` [7]),
read the right number. A second look after the PR opened: the pin mirror's
comment, six lines to four, keeping the codemod warning. No behaviour change.

**Not done here.** The live connector check (one Claude Desktop session, two
tool calls in flight, Accept as the client sends it) that SMD-1497, SMD-1259
and SMD-1246 also wait on; a client that sends *neither* token nor `*/*`
would now get 406 where the patch used to rescue it — no known client does,
and the check would show one. The supabase-js pin (SMD-1644) and the test
tooling pins (SMD-1645) are their own tickets. No upstream issue against the
SDK's `types` pattern or Deno's resolver.

Upstream status: at the pin, upstream deploys SDK 1.24.3, `@hono/mcp` 0.1.1,
hono 4.9.2 and zod 4.1.13 with the Accept patch in every server;
`server/package.json` ranges `^1.28.0` / `^0.1.5` / `^4.12.9`. The fork's
nineteen sites and fifteen handlers diverge accordingly; a rebase conflicts on
each pin line (take the higher) and on each removed patch block (take the
removal). **Unfiled** by us.

### 85. A live row an HNSW walk cannot reach is the geometry, not the vacuum — `db/hnsw-graph.ts` reads the disconnected graph the suite's tied vectors build, and [4]/[11]/[15] join [7] on `match_thoughts`' exact branch (SMD-1632)

**The finding.** SMD-1574 moved `test-live.ts` [7]'s found-by reads off the HNSW
walk after they flaked in CI, and filed this to explain the walk returning none
of three live rows — reading it, from an instrumented dump, as a vacuum leaving
the entry point on a deleted element. The dump was right that the entry point's
reachable component held one row while two live rows sat outside it; the cause
it inferred was not. Over the suite's vectors — orthogonal unit axes, every pair
at cosine distance 1.0 — pgvector's neighbour-selection heuristic (`SelectNeighbors`,
`CheckElementCloser` in `hnswutils.c`) keeps an edge only where a candidate is
strictly closer to the element than to any neighbour already chosen, so with
every distance equal it keeps few, and the graph is not connected. A search
walking from the entry point cannot reach a row in another component, and even a
reachable one is missed by the bounded `ef` beam. This reproduces with **no
vacuum, no deletes**: a single insert of one orthogonal unit vector per axis
leaves live rows unreachable outright. The autovacuum the ticket named is a
contributory trigger — it re-picks the tiny graph's entry point and repairs
neighbourhoods, shifting which rows fall outside the reachable component at the
moment [7] reads — not the root.

**What `db/hnsw-graph.ts` shows.** A reader that decodes the index pages
(pgvector 0.8.6's `HnswMetaPageData`, `HnswElementTupleData`, `HnswNeighborTupleData`
through `pageinspect`'s `get_raw_page`, the magic number and the meta page version
checked), walks the graph from the entry point following neighbour lists at every
level, and joins
to the table by ctid, so it reports the live rows the entry point cannot reach.
On a quiescent index it is a **sound** detector: every row it calls unreachable
is one an unbounded relaxed walk of that row's own vector does not return
(measured against the walk; the reverse does not hold — the bounded beam misses
reachable rows too, so the walk misses more than the decoder reports). It reads
the pages one at a time, not in one snapshot, so under a concurrent insert or
vacuum the picture is inconsistent — fine for the diagnostic it is, not a check
against a brain taking writes. The all-levels walk is the
correction that makes it sound: a search does not walk level 0 from the meta
entry point but descends the upper lists to a query-dependent level-0 start, so
a level-0-only reachability under-counts and would call a reachable row
unreachable — a synthetic-graph assertion in [17] holds the walk to every level
(a review pass found the database soundness sample let a level-0-only walk pass,
so that assertion carries the guarantee). Measured on pgvector 0.8.6-pg16, 1024-dim: 1,024 orthogonal unit
vectors leave 0 to ~860 rows unreachable build to build (one connected build in
twenty), and a search of a row's own axis misses well over 100 of 120 sampled
whatever the hole; a 2,000-row **random** corpus is fully reachable and every
row is found by its own vector. So the pathology needs a corpus **dominated** by
near-equidistant vectors — the suite's, quantised or binary vectors, not real
embeddings.

**The test reads that flaked, and the ones that could.** [7]'s reads took
`match_thoughts`' exact branch in SMD-1574 (a metadata key only that thought
carries → 014/037 score the matching thoughts and their chunks by id, no walk).
This adds the same key to [4], [11] and [15] — the sections whose reads still
walked the same shape of corpus — and filters their reads on it, so the vector
arm (`search_thoughts_hybrid` passes the filter to `match_thoughts` for [11] and
[15]) takes the exact branch too. The ticket doubted [11] could be filtered
without changing what it tests; it can — the keyword arm is filtered by the same
key, which every row carries, so the keyword-hit-outside-the-window and
window-of-one probe are unchanged — and the suite proves it. [5b] is left on the
walk on purpose: its 2,000 vectors are random, which the finding shows are
reachable, and it exists to hold the walk's recall. `test-live.ts` [17] is the
new coverage: the walk misses most axes of an orthogonal corpus and none of a
random one, the decoder is sound, and `REINDEX` does not lift the miss rate.

**The decision.** No production reachability check and no capture-path
verification: a real corpus is reachable, so either would never fire and both
would cost every capture a walk. `REINDEX` is **not** the remedy the ticket
assumed — a rebuild of an all-equidistant graph is no more connected (measured:
the miss rate does not move) — so it is not offered as one. The mitigation is
the diagnostic (`db/hnsw-graph.ts`, superuser-only, for a database you
administer) and the test hardening. Not filed upstream as a bug: HNSW over
near-equidistant data being poorly connected is a known property of the
algorithm, reproduced here with no vacuum in play, not a pgvector defect — the
`hnswvacuum.c` path the ticket read (`RepairGraphEntryPoint`, whose own comment
says the entry point "will be empty until an element is repaired") is real but
is not what the reproduction needs.

**Verified.** `bun test-live.ts` 508/508 against pgvector 0.8.6-pg16, [17]
included, stable across repeated local runs; `db/hnsw-graph.ts` reads both
shipped indexes and its CLI exits non-zero on a holed index. The decoder's
soundness and the random-corpus reachability are the two facts the section rests
on, both robust to the build's randomness; the hole's size is reported, not
gated on.

**Not done here.** No standalone script produces the three-row miss on demand —
the tiny-graph miss needs the suite's accumulated index history and an
autovacuum at the read, and 282 standalone iterations at SMD-1574 plus the
replays here never caught it; the deterministic reproduction is the many-vector
disconnected graph, which is the same mechanism at a scale where it is certain.
The quantised and binary indexes (SMD-1501) share the near-equidistant risk at
low bit depth and are not measured for it. And [17] guards the decoder's
reachability logic and its gross layout (magic and version), not the individual
page-field offsets — a byte-level decode fixture is SMD-1673.

### 86. The read model, measured — the store holds the payload and serves the read with zero Postgres calls, and removing the resolve does not change the latency verdict; it relocates the cost to write time and storage (SMD-1696)

Change 82 (SMD-1662) closed by naming what it had not measured: it, like change
79, benchmarked a second store as a *subordinate ANN index* — Postgres the source
of truth, every read resolving the store's ids back to Postgres rows — so the
id→row resolve the "not built" verdict leaned on was partly an artifact of that
chosen topology, not of a two-store design. The shape it defined away is the one
where a second store is actually compelling: a **read model** (CQRS), where the
store holds the vector *and the full payload* and serves the retrieval read
completely, Postgres kept only as the transactional write log — a read path that
makes **zero Postgres calls**. This measures that shape, on the same harness and
the same exact-cosine oracle. Like changes 31, 53, 55, 59, 79 and 82 it ships no
runtime change; the numbers are in evals/README.md, under "Does the store matter?".

A `LanceReadModel` is added beside `LanceEngine` in `evals/store-backends.ts`: the
same in-process ANN, but every row carries `content` and `metadata` alongside the
vector, so it exposes two reads over one index — `search` (ids only, feeding the
change-82 resolve) and `searchRows` (full rows, the read-model read). The driver
`evals/store-readmodel.ts` measures three read paths on identical vectors against
one oracle: **(1)** single-store Postgres — one statement, ANN over the points
joined to the payload, a `match_thoughts`-equivalent read; **(2)** the change-82
two-store resolve — LanceDB ids, then Postgres pulls the payload back; **(3)** the
read model — LanceDB returns the full rows, no Postgres. Paths 2 and 3 use the
same LanceDB index and differ only in where the payload comes from, so `(path2 −
path3)` is the net topology delta and `(path1 − path3)` is the read model against
the incumbent.

**The zero-Postgres read path is real, and demonstrated.** The read model holds no
Postgres handle, so its read path is zero-Postgres by construction; a query counter
on the shared handle reads **0** across the whole path-3 loop (a runtime regression
guard), and — the demonstration — Postgres is *stopped* mid-run and the read model
still answers, byte-identical rows, with the OLTP database down. Content
correctness is checked too: every returned row carries the exact payload, not just
a matching id.

**Removing the resolve does not change change 79's latency conclusion.** On the
real corpus (601 issues, 963 points, 1024-dim, 150 queries) all three paths land
within a few tenths of a millisecond of each other — no clear winner: the read
model *edged* single-store Postgres by 0.09 ms in one run (1.21 vs 1.30 ms p50) and
trailed it on a quieter run, and the read-model-vs-resolve delta was 0.0–0.5 ms.
The resolve is essentially free at this size, so removing it buys nothing. At **1M
rows (64-dim)** the tie breaks toward the single store: single-store pgvector's own
HNSW read (~2.5 ms) was the fastest of the three in every run, and the
read-model-vs-resolve delta sat within run-to-run noise of zero (−0.7 to +0.5 ms) —
fetching the payload from LanceDB costs about the same as a Postgres primary-key
resolve of ten ids. So from 1M up the read model does not overtake the single
store: pgvector serving the read in one statement is the floor, and the resolve was
never the deciding cost.

At **10M rows** the same holds and the write side sharpens. (pgvector HNSW did not
build in a practical window here — still constructing its graph after 40 minutes,
so it was abandoned; the single-store anchor uses IVFFlat, which built in 2.4 min,
as change 82's 10M table did.) Single-store pgvector IVFFlat was again the fastest
read at 5.9 ms p50, the read model 7.4 ms, and the resolve delta a negligible
0.18 ms — removing it still does not overtake the single store. What grows sharply
is the mutable-edit tax: propagating one content edit cost **84.8 ms at 10M**
(3.3 → 11.7 → 84.8 ms/ref from 601 rows to 1M to 10M) as each edit rewrites an
ever-larger Lance fragment, while batched appends stayed cheap (drain 103k
rows/s). The read model added 6.3 GB on top of Postgres's 8.9 GB (+71% system), and
filtered reads on it reached ~244 ms — LanceDB scanning an unindexed list-column
prefilter over 10M rows, a scale wart a scalar index would address but the
index-only shape carries too.

**The cost the read model removes from read time reappears at write time — and it
is dominated by mutable edits.** A *synchronous* dual-write (each durable Postgres
write plus a per-row LanceDB append) cost **~2.3–3.0 ms/write** on top of the
Postgres write, because LanceDB writes a data fragment per `add`. Batched
propagation is the cure: an outbox/CDC drain sustained **21,000–103,000 rows/s**
across the scales (~0.01–0.05 ms/row), a few milliseconds per batch of freshness
lag — a batched append is one Lance fragment write amortised over the batch, so it
is cheap and does not grow with corpus size. That is the pattern OB1 already runs —
embeddings are *already* eventually consistent with content, the re-embed worker
lagging writes — so a read model is that same consistency model relocated, not a
new one. The genuinely expensive part is payload *edits*: propagating one
`update_thought`-style content change (a LanceDB `update`, which rewrites the
fragment holding the ref) cost **3.3 ms/ref on the real corpus and 11.7 ms/ref at
1M** (84.8 ms/ref at 10M) — it grows with fragment size, unlike a batched append.
Vectors are append-mostly; the consistency tax is the mutable payload, and unlike
the vectors it does not stay cheap as the store grows.

**Storage: the payload is held twice.** The payload lives in both stores.
On the real corpus the read-model dataset was 9 MB against an index-only LanceDB's
5 MB (a 4 MB payload duplication on disk; 2 MB logical), lifting the whole-system
total from 15 MB single-store to 24 MB. At 1M the read model held 656 MB against
599 MB index-only, whole-system 1.95 GB vs 1.30 GB single-store — about +50% (+71%
at 10M). (On-disk duplication tracks compressibility: the synthetic filler
compresses hard — 57 MB on disk vs 268 MB logical at 1M — so there it understates
what real content would cost; real content does not compress and carries Lance's
per-fragment overhead, landing near or above the logical figure — 4 MB on disk vs
2 MB logical on the real corpus.)

**Verdict — change 79's holds, and now the resolve it leaned on is shown not to be
the bottleneck.** The read-model topology *works*: its read path is provably
zero-Postgres — it serves reads with Postgres stopped — and feeding it is cheap for
appends when batched, on the eventual-consistency model the fork already uses. But
removing the resolve buys no read-latency win: the resolve is a fraction of a
millisecond, the three paths are within noise on the real corpus, single-store
pgvector has the fastest *p50* from 1M up, and the read-model-vs-resolve difference
is within noise throughout. (One tail-latency caveat already points at the scale
case: at 10M the single store could only run IVFFlat — pg HNSW would not build —
whose p95, 17.8 ms, is worse than the external HNSW_SQ index's 8.5 ms; at scale the
off-DB store builds a better-tail index than pgvector can, which is SMD-1697's
territory.) Meanwhile the read model holds the payload a second time (+50–71%
whole-system) and adds a write-time propagation path whose mutable-edit cost *grows*
with scale. So the read model does not earn its place on *retrieval latency*; where
it plausibly would is
the scale/operational envelope — offloading the vector working set off the OLTP
database and being buildable where single-store pgvector is not (the 10M arm of
change 82 already showed pgvector failing to build where LanceDB built in 28 s).
That is SMD-1697, still open. **Not built**; `thoughts.embedding` stays the source
of truth, now because the resolve the second-store case turned on was measured and
found not to be the cost — not merely assumed. (LanceDB is Apache-2.0 and the fork
is FSL-1.1-MIT — SMD-1038's guardrail — a dependency of an eval, not the product.)

**What this still measures as a race, not a composition.** Change 79, change 82 and
this one all measured stores as *substitutes* — each doing the whole match and
returning the rows, the cross-store hop treated as cost to minimise (change 82) or
eliminate (this change). None measured stores as *complements*: a **composed** match
where a scalable ANN engine does cheap coarse recall and Postgres does the exact
rerank/fusion — metadata, recency, keyword, freshness — over the small candidate
set. In that shape the id→row hop is the *precision stage*, not a tax, and it is
also the scale answer (coarse recall shards; the rerank set stays small and fits
RAM). That is the axis on which a second store plausibly earns its place, and all
three evals defined it away by racing single stores at the whole job. Measured
in change 87 (SMD-1707).

**Upstream status:** not applicable — the store comparison is this fork's eval.



### 87. The composed match, measured — stores as complements, not substitutes: a scalable ANN does cheap deep coarse recall, Postgres does the exact rerank/fuse over the small candidate set, and that recovers recall a single ANN pass loses at scale while adding precision the ANN can't express (SMD-1707)

Change 86 (SMD-1696) closed by naming the axis it had not measured. Changes 79, 82
and 86 all raced stores as **substitutes** — each doing the whole match and returning
the rows, the id→row hop treated as cost to minimise (82) or eliminate (86). None
measured stores as **complements**: a **composed** match where a scalable ANN engine
does cheap coarse recall and Postgres does the exact rerank/fusion over the small
candidate set, the hop reframed as the *precision stage*. This measures that shape,
on the same harness and the same exact-cosine oracle. Like changes 31, 53, 55, 59,
79, 82 and 86 it ships no runtime change; the numbers are in evals/README.md, under
"Does the store matter?".

`evals/store-composed.ts` drives two stages against one oracle (K = 10): **stage 1**,
a coarse ANN over K′ ≫ k candidates from LanceDB (the change-82 store); **stage 2**,
an exact rerank/fuse in Postgres over just those K′ refs — exact cosine (MIN over a
ref's windows), an exact metadata filter, an optional recency blend (change-20's
`recency_score`, inlined) and an optional keyword arm fused with the vector *rank* by
symmetric RRF over `docs.tsv` (both terms on the RRF scale, as search_thoughts_hybrid
fuses them). The rerank has no `ORDER BY` over the vector index, so it is exact within the candidate set and its cost is bounded by
|cand| = K′, not by N. Comparators: the substitute (vector-only ANN@k at depth 50),
a single-store Postgres hybrid (vector ⋈ FTS RRF over the whole table), a
pg-HNSW-coarse control, and the exact oracle. K′ is swept.

**On a small corpus there is nothing to recover.** On the real corpus (601 issues,
963 points, 1024-dim, 150 queries) the ANN is already exact — the substitute gets
100% recall@10 unfiltered — so the composition matches it and the K′ sweep only
shows the mechanism warming up (K′=10 → 78%, K′=25 → 99%, K′=50 → 100%). The recall
win is a scale phenomenon.

**At 1M rows the composition's real shape appears — and it is deep coarse recall,
not the rerank alone, that recovers recall.** The single ANN pass loses recall at
scale (substitute 60% unfiltered, nDCG 0.72). At the headline K′=200 the composed
match *ties* it (60%) — the exact rerank only re-orders the candidate set, and the
true top-10 neighbours are simply absent from a 200-candidate ANN pool 40% of the
time. Recall moves only as K′ deepens: **83% at K′=500, 92% at K′=1000**, approaching
the oracle's 100% at 21.7 ms total versus the oracle's 30.1 ms full scan. So the
quality win is *deep coarse recall + exact ordering* — a quality/latency dial, not a
free lunch: the rerank makes a deep-but-approximate set precisely ordered, but the
set is made deep by paying stage-1 cost. This sharpens change 86's thesis: the
precision stage is where a second store earns its place, but it only pays once the
coarse stage recalls enough to rerank.

**The coarse store's filtering quality is load-bearing.** On selective filters the
pg-HNSW-coarse control collapses (real corpus: portal 32%, t07 14%; 1M: 41/32/17/2%
across the tiers) — pgvector's post-filter is the SMD-968 hazard, and stage 2's exact
filter cannot recover rows the coarse stage never surfaced. LanceDB coarse
prefilters and holds filtered recall on the *selective* tiers (t10/t1/t01 = 100% at
1M), at a latency cost (~40 ms p50); the non-selective t50 tier sits at the
substitute's 71% — a scale recall loss the prefilter does not fix, since half the
corpus passing the filter is the same coarse-recall problem as the unfiltered arm. A
composed match is only as good as what its recall tier surfaces.

**The composed total beats the ~O(N) full scan and its edge widens with N; the rerank
stage's wall-clock is cache-bound and run-to-run volatile — the scale claim, corrected
by re-running the committed code.** The a-priori guess was that the stage-2 rerank
would be N-independent. It is not: it reads a bounded K′ rows, but at 10M those K′
heap fetches hit a heap that exceeds RAM, so its wall-clock is dominated by cache/OS
load and *swings between runs*. Two runs of the committed code, at K′=1000: rerank
6.5 ms at 1M, then **36.5 ms and 108.5 ms** at 10M — a ~6×–17× jump for 10× the data,
not the clean sub-linear the first cut claimed. What is stable is the full scan
(≈30 ms → ≈370 ms, a clean ~O(N), ~12×) and the direction: the **composed total**
(coarse ANN + rerank) at K′=1000 was 21.7 ms at 1M (≈1.4× cheaper than the full scan)
and 72–155 ms at 10M (2.5–5.1× cheaper across the two runs) — the system's edge over
the full scan widens with N even though the rerank stage's own scaling is volatile.
The coarse ANN is the part that grows most with N and is the shardable half; sharding
it would improve the system edge further, but that is asserted, not measured here. So
coarse-recall → exact-rerank scales where the full scan does not — not because the
rerank is flat (it is neither flat nor reliably sub-linear), but because the
bounded-candidate total stays well under the ~O(N) scan. (At 10M the filtered read is
dominated by the coarse stage's prefilter, ~237–259 ms p50 substitute / ~267–298 ms composed
for Lance's filtered arms (the mean over all filtered arms — the per-tier split is
unavailable at 10M, where the oracle is skipped) — the recall tier's filter cost is the scale wart, as in
change 86's read-model filtered reads.)

**The rerank stage adds precision the ANN cannot express, quantified.** Judged
against the objective each serves (not the pure-cosine oracle): against an exact
recency-blended oracle (w=0.3, 90-day half-life), the ANN substitute and the
pure-cosine composition both scored 18%, while folding recency into the rerank
recovered **73%** at ~3.8 ms — the exact stage serves the recency objective the vector
store cannot. (It caps below 100% because the cosine coarse stage does not surface
every recency-optimal row — the same binding-constraint lesson; deeper K′ raises it.)
Folding the keyword signal into the rerank moved the composed top-k onto the
whole-table hybrid it reproduces (**80% → 94% top-10 overlap**) — the composed keyword
arm fuses the vector rank and keyword rank by symmetric RRF, the same fusion
search_thoughts_hybrid runs over the whole table, so the bounded-candidate rerank
reproduces the full-table hybrid's ranking.

**Verdict — the multi-store win is composition, and it is real but conditional.**
Where a single ANN pass loses recall at scale (1M+), deep coarse recall + exact
rerank recovers it toward exact quality (92% of the oracle at K′=1000, measured at
1M — where the composed total was ~1.4× cheaper than the full scan), and the rerank
adds precision the ANN cannot express, over a bounded K′-row candidate set whose
advantage over the full scan *grows* with N (composed-total edge ~1.4× at 1M → 2.5–5.1×
at 10M, where recall itself was skipped). This is the id→row hop reframed as the
precision stage, exactly as change 86 predicted — stores as
complements, a **recall tier** (the scalable ANN) plus a **precision tier**
(Postgres). The conditions are the finding as much as the win: it needs deep coarse
recall (K′ large → stage-1 cost grows and must shard), the coarse store's filtering
quality is load-bearing, and a small corpus has nothing to recover. **Not built** —
a composed retrieval path in the product is a separate scoped issue if a bar clears;
this closes the second of the two axes change 86 named (SMD-1697, where the single
store stops fitting, is the other, still open). Stage 3 (a cross-encoder / LLM
reranker over stage 2) was left out: the rerank spikes already measured it
flat-to-negative and it is a heavy out-of-process dependency. (LanceDB is Apache-2.0
and the fork is FSL-1.1-MIT — SMD-1038's guardrail — a dependency of an eval, not the
product.)

**Upstream status:** not applicable — the store comparison is this fork's eval.



### 88. The knowledge-update slice was already reported and is the best one — and the number cannot see the failure MERIT means: the shipped read puts the stale value first on half the questions, and the resolving read, fed perfect chains, fixes that by changing what counts as relevant (SMD-1720)

SMD-1720 read MERIT's hardest tier — a fact updated later, embedding retrieval
at 0.30–0.95 success, update-on-write stores at 0.70–1.00 — against the fork's
`supersedes` column (025), which labels a superseded hit and never follows the
chain, and asked first for LongMemEval's knowledge-update slice on its own,
which it took to be unreported. It was reported: change 48's tables carry it at
**97.2% (4b) / 98.6% (0.6b)** strict recall_all@5, the best slice on both models,
so by the ticket's own step one it closes with the number. This change is what
was measured on the way to closing it. Like changes 31, 53, 55, 59, 79, 82, 86
and 87 it ships **no runtime change**; the harness is a third arm set in
`evals/eval-longmemeval.ts` (`OB1_EVAL_LME_ARMS=current`) and the numbers are in
evals/README.md under "The knowledge-update slice".

**The number answers the benchmark's question, not the reader's.** Every one
of the 72 knowledge-update questions has exactly two gold sessions — one states
a value, a later one updates it, median 50 days apart — and strict recall_all
counts the question when *both* are in the top five. A reader handed the stale
value first scores the same as one handed the update. So the arm set keeps the
rank of each gold and scores both frames over the same calls: `both` (strict),
`current-in`, `current-first` (the update in the top k and above the stale
session, or the stale one absent), `current@1`, `stale-only`; a control refuses
a question without two golds dated apart; every arm is paired with the shipped
order per question with McNemar's exact test, as change 59 reported.

**The shipped read is a coin flip on which value comes first.** `match_thoughts`
puts the update above the stale session on **38 of 72** questions on the 4b
(52.8%) and **33 of 72** on the 0.6b (45.8%); in almost every miss the stale
row is the top hit and the update second. Both are retrieved on 97–99%, so the
strict number is high and the reader's number is MERIT's range, reproduced on a
public corpus through the fork's own write and read path. Nothing above this
section could have shown it.

**The date is not the lever, again.** 020's blend as a caller can send it
(`recency_weight` 0.3, the half-life fixed at 90 days) is a byte-identical
no-op on rows three years old: a 2023 session has a recency near 10⁻⁴ and so
does the one a week newer. A half-life of 3,650 days moves one question
(p=1.000). Age alone — under the history filter `match_thoughts` blends every
row of the history and cuts to k, so the arm is the five newest sessions in it —
puts newer, unrelated sessions ahead of both golds — current-first 29.2%, strict 2.8%, +10 / −27
against the shipped order (p=0.008). Change 53 found the same on the temporal
slice; the update is not the most recent session in a history, it is the most
recent *about this*, and only a signal that reads the texts can know it.

**The resolving read, priced as an oracle.** The corpus carries **0**
`supersedes` pointers — nothing populates them: the consolidation pass (change
54) has not run on these loads, and at one thought per session it would judge
whole conversations — so the ticket's read (walk each hit forward to the head
of its chain, return the head at the hit's rank, list a session once) cannot be
measured as an arm. It is measured as its upper bound instead: each question's
gold pair held in memory as that question's chain, as if a reviewer had accepted
exactly the right proposals (a store that carries pointers is walked as it is). Fed those, it puts the update first on **every** question (+34 / −0
on the 4b, +39 / −0 on the 0.6b, p<0.001), at rank one on 94–97% — and scores
**0% on strict recall**, because it hands back one session where the benchmark
wants two. With the forward walk removed (the mutant) the arm is the shipped
order on every question, +0 / −0: the walk is the whole effect.

**What that means.** The read is a change of relevance definition, not a
ranking improvement — the same split `eval-supersession.ts` found on the seeded
corpus (change 46: topical relevance +0.000, current-version relevance +0.333),
now on the public one. And the benchmark is right to want both sessions: 14 of
the 72 questions carry a cue like *previous*, *before*, *initially*, about ten
of them ask for the value the update replaced ("What was my previous frequent
flyer status", "Where did I initially keep my old sneakers" — asked beside
"Where do I currently keep"), and one asks for both. A read that resolves by
default answers those from a row it has hidden.

**Decision: not built.** The read is deterministic given chains — a hit in a
chain is replaced, one outside it is not — so building it would measure nothing
the oracle has not; what is missing is chains, and no measured corpus carries an
accepted one. When one does, the read belongs behind an opt-in flag on the
search functions (`p_resolve`, default off), with a `superseded_by_chain: n`
label on a replaced hit, and never as the default — the benchmark's own
previous-value questions are the case against a default, and 025's decision
(label, do not exclude) stands. The reader has the pieces today: the
`⚠ Superseded by a newer thought — ID …` label names the head one read away,
and `Captured:` dates every hit. What would move the reader's number without a
chain is a reranker that reads the two texts and picks the later state — the
one-pool rerank change 59 found to be the lever — on this slice with this arm
set. That is a follow-up, filed against SMD-1319's reranker.

Also in this change: whichever phase reads the session→thought map first
rebuilds a missing one from each row's `metadata.lme_sid` under the run's
model (the four fingerprint twins matched by fingerprint, their questions
re-merged) and says so — both S maps had gone with `/tmp`, and the alternative
was a 14-hour reload. And a loader defect the second review pass found by
reading: the envelope carried `lme_q` and `lme_sid` onto a twin's existing
row, where `upsert_thought`'s key-wise metadata merge replaced the first
session's questions before the loader's union could keep them. The ids are now
written after the upsert, the union always, the id and date only for a row the
session created. The audit trail (008) shows the four overwrites on each S
store, ten questions losing one distractor session each and none losing a gold
one, so change 48's tables stand; the rebuild's merge repaired the rows, and
re-loading a twin session through the fixed loader leaves the row's id,
questions and date as they were.

Tidied after the third pass, while the file was open, no behaviour change: the
isolation filter and the two k values live once at module scope, the control
that turns returned ids into this history's sessions is one function both
scorers call, and the resolve arm walks the shipped arm's ids for the same
question and k instead of fetching the same list again. Tables identical.

Two items the passes had declined were then applied on request. The rebuild
matches a twin's session by a fingerprint computed client-side, one query for
the store's fingerprints instead of one round trip per unmapped session — and
the first run of it showed why the rule is checked against the store before it
is used: JavaScript's `\s` and `toLowerCase` are not 003's rule. Postgres's
`\s` leaves U+00A0, U+202F and U+FEFF alone and its `lower` turns İ into a
plain i; the naive spelling disagreed on 47 of 19,825 rows and the run fell
back to the server lookup, tables unchanged. The class now mirrors Postgres's
and agrees on every row, and a disagreement on any future store still sends
the twins to the server. And the `current` set refuses a gold session whose
row also stands for a session dated differently, since the recency arms read
the row's one date — never true here (the date leads the text a twin shares),
now checked.

**Upstream status:** not applicable — the eval is this fork's.

## Detached from the fork network

This repository was forked from `NateBJones-Projects/OB1` and then detached, for
one concrete reason: on a fork, GitHub's "New pull request" targets the **parent**
by default, so a mis-click puts internal work into a public PR on someone else's
repository. Detaching removes that. It also stops `gh` resolving to the parent,
which hid a red CI for eight commits (see above).

**Nothing about the upstream relationship in git changed.** The `upstream` remote,
the pin at `9543c29`, and the rebase procedure below all work exactly as before —
detaching is GitHub metadata, not history. Provenance stays recorded here and in
`LICENSE.md` (FSL-1.1-MIT, which is unaffected: internal use is permitted, and the
Competing Use restriction is unchanged by where the repo sits).

One consequence to know about. Fork status had been suppressing the
`pull_request_target`, `issues` and `schedule` triggers, which is the only reason
upstream's eleven workflows were dormant. Detaching makes them live —
`ob1-gate-v2.yml` would fail every internal PR by enforcing contribution rules
this fork deliberately does not follow, and `update-readme-contributions.yml`
runs on a cron with `contents: write` and rewrites the README on `main`.

The plan was to disable them at the repo level, keeping the files byte-identical
to the pin so rebases stayed clean. **That is not possible.** GitHub creates a
workflow record on first run, so a workflow that has never run cannot be disabled:
the API returns 404 and `gh workflow list` does not see it. Waiting until after
the first run means accepting whatever that run does — for the scheduled one, an
unattended bot commit to the default branch.

So all eleven are deleted, from `main` and from the working branch. Only
`fork-checks.yml` remains. `.github/disable-upstream-workflows.sh` is kept for the
case a rebase reintroduces one **and** it has already run, which is the only
situation where disabling works.

Removing them from `main` is safe because nothing reads our `main`: the pin is held
by the annotated tag `upstream-pin-9543c29`, and the procedure below rebases onto
`upstream/main` from `siggymd/fork-baseline`.

## Rebasing onto upstream

Roughly quarterly, or when something lands that we want.

```bash
git fetch upstream
git log --oneline upstream-pin-9543c29..upstream/main -- server/ docs/01-getting-started.md

git checkout -b siggymd/rebase-$(date +%Y%m%d) siggymd/fork-baseline
git rebase -X ignore-space-change upstream/main   # change 78 re-indented 1,517 lines of
                                                  # integrations/enhanced-mcp/index.ts; the flag
                                                  # resolves whitespace-only hunks and takes an
                                                  # upstream edit inside the span at its old
                                                  # indentation, to re-indent by hand

cd server
bun install --frozen-lockfile
bun test-stateless.mjs && bun test-stats-pagination.mjs && bun test-capture-atomicity.mjs
deno check --node-modules-dir=none index.ts   # --node-modules-dir=none is required
                                              # once the line above has created
                                              # server/node_modules
cd ../server-portable
bun install --frozen-lockfile && bun test-server.ts && bunx tsc --noEmit
bun run test:sql && bun run test:e2e            # needs podman or docker
bunx wrangler deploy --dry-run --outdir=.cf-out   # Workers target still builds
cd ../db && bun install --frozen-lockfile && bun test-schema.ts
./with-postgres.sh bun test-live.ts               # needs podman or docker
cd .. && bun scripts/check-fork-consistency.mjs   # CI runs it under bun too (change 58); node runs it as well

git tag -a upstream-pin-$(git rev-parse --short upstream/main) \
  -m "Upstream main @ $(git rev-parse upstream/main)"
```

Then update the pin table at the top of this file.

### Vendored content: audit once, hold the delta

Everything under `recipes/`, `integrations/`, `extensions/`, `skills/`,
`schemas/`, `dashboards/` and `primitives/` is upstream's community tree,
vendored wholesale at the pin. That means we ship its worst advice with its
best, under this repository's name, in a repo whose stated differentiator is
that the core is tested and the auth path is hardened. The rule (SMD-1251,
change 51): **we audit the tree once and hold the delta**, and a standing check
carries the audit so a rebase cannot quietly undo it. Four rules are audited
today. Writes around the functions (SMD-1228, change 69; SMD-1524, change
71): check 10 fails the build on a PostgREST `.update(`/`.upsert(`/`.insert(`
on `thoughts` whose payload carries `content` or `embedding` — inline or
through an object the file fills — and on a SQL `UPDATE thoughts … SET` of
either column or `INSERT INTO thoughts (…)` naming one: the raw update nine
vendored files made around `update_thought` and the 3-argument
`upsert_thought`, leaving a stale fingerprint, a stale model label and the
previous vector's windows, and the raw insert eight more made around the
capture, leaving no fingerprint and no label at all; with counted per-file
exceptions for a file whose README says it bypasses the functions — seven,
each a database of its own, a function body shown, or the test's fixture.
Credentials (SMD-1252, change 64; SMD-1455, change 67): check 8 fails
the build on a value read from the environment under a credential's name
compared with an equality operator — the one shared plaintext key seven
extension servers, and then seventeen more vendored files, compared with `!==`
before they became consumers of `server-portable/auth.ts` — with counted
per-file exceptions, and the list has been empty since change 67. Core
ownership (SMD-1250, change 58): check 7 fails the build on any
vendored statement that redefines, drops or re-comments a function
`db/migrations/` owns, the owned set read from the migrations, with counted
exceptions for the files that create a brain rather than add to one. And
shell safety — `scripts/check-fork-consistency.mjs` check 6 fails the build on
Codex's sandbox-bypass flag or its aliases, Claude Code's skip-permissions flag
or mode, any allow rule that grants all of `Bash` or a prefix of a network
client or interpreter, or any spawn through a shell (the `shell:` option with a
non-false value, `exec`/`execSync`, `os.system`, an explicit `sh -c`/`cmd /c`
argv), in every non-binary, non-ignored file under those seven directories,
with a reviewed exception list — per file *and* per pattern, and *counted* —
for prose that names a flag in order to say it was removed, and probe lists the
check runs against its own patterns on every run, positive and negative. A
rebase that brings a new hit fails CI, and the choice is the same as it was at
the pin: fix the vendored file and record the delta here, or list the exception
with its reason. SMD-1250 landed in that shape as change 58, SMD-1252 as
change 64, SMD-1455 as change 67, SMD-1228 as change 69 and SMD-1524 — the
raw inserts change 69 left outside its rule — as change 71: the four rules
named when the standard was decided are all audited and held, the last on
both of its doors.

### Landing a rebase on `main`, which is protected

`main` is the working default and carries a ruleset: nine required status checks,
no deletion, **no force-push**, and no bypass actors — it applies to admins too.
That is deliberate, and it interacts with a rebase in one specific way.

A rebase produces `siggymd/rebase-YYYYMMDD` with **rewritten history**, so it
cannot fast-forward onto `main`. Two ways forward:

**Open a pull request (normal case).** Required status checks mean **no push
directly to `main` succeeds**, merge commit or not — a push carries commits CI has
never seen, so the rule cannot be satisfied:

```
remote: - 9 of 9 required status checks are expected.
```

That is not a quirk of the merge; it is what requiring checks means. Everything
reaching `main` goes through a PR, which is two commands:

```bash
gh pr create --fill --base main --head siggymd/rebase-$(date +%Y%m%d)
gh pr merge --merge --auto        # lands itself once the nine checks pass
```

History keeps both lines, which is what happened when the fork's work first landed
on `main`, and is the right default: the rebase is a reconciliation, not a
replacement.

**Reset `main` to the rebased line (rare).** Only if you want `main`'s history to
*be* the rebased history — cleaner, but it discards the record of how the fork
diverged. This is a force-push and the ruleset will refuse it:

```
remote: - Cannot force-push to this branch
```

To do it anyway — as with any push that must bypass the checks — set the ruleset
to `disabled`, push, and put it back:

```bash
gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 -f enforcement=disabled
git push --force-with-lease origin main
gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 -f enforcement=active
```

Prefer `--force-with-lease` over `--force` so a push that raced with someone else's
is refused rather than silently discarding it.

**Nothing forces the rewrite.** The pin is held by the annotated tag
`upstream-pin-<sha>`, not by any branch, so `main`'s history never has to be
rewritten to record where upstream was. Reach for the merge.

**Drop a patch rather than carry it** if upstream fixes the same defect. Check
issues #470 and #216 first — both are open with volunteers waiting, so fixes 3
and possibly the auth work may arrive upstream.

### Why we do not send these upstream

`CONTRIBUTING.md:268` lists modifying "the core MCP server" as an automatic
reject, and [PR #122](https://github.com/NateBJones-Projects/OB1/pull/122) was
closed on exactly that basis:

> The main change edits the core MCP server, which is explicitly out of scope for
> community contributions in this repo… If we want this behavior upstream, it
> needs to come through a focused maintainer-led path instead.

Fixes 1–5 all live in `server/index.ts`. Fixes 6 and 7 are contributable in
principle; note that [issue #482](https://github.com/NateBJones-Projects/OB1/issues/482)
reports the upstream PR gate currently fails on **every** fork-originated PR.

---

## Review passes: what caught a finding is written at the catch

Measured 2026-09-18 with `bun scripts/mechanism-yield.mjs` over the commit log
as of `main` at 28e20d7 — before any tagged pass existed, so a re-run at HEAD
adds this ticket's own passes to every figure: 221 review-pass commits across
61 tickets, 511 bulleted findings in the 31 tickets whose passes carry bullet
bodies. **None of the 511 says what found it.** Each says what was wrong and
what changed. A keyword search for phrases that name a catcher ("mutant", "the
reviewer", "found by driving it") turns up about twenty, and half of those are
mentions, not catches — so nothing is inferred, and "which review mechanisms
pay" cannot be answered from the record. A proposal to back-fill a corrections
table from it (SMD-1711's origin) was dropped for that reason.

What the record does say, by a keyword classifier whose samples were read
(approximate by design: a defect in a checker that parses comments reads as
record drift):

- About a third of findings are record drift — this file, comments, READMEs.
  A little under a third are code defects. A fifth are test teeth: a vacuous
  assertion, a wrong fixture, a gate with no margin. The rest are confirmations
  of no defect and tickets filed.
- **The defect share does not fall with the pass number**: 44 / 43 / 51 / 51 %
  at passes one to four, higher on the few tickets that went further. Fourteen
  of 31 tickets found their last code or test defect at pass three or later,
  and three of the four that ran five or more passes found one on their final
  pass. Passes stop because the operator stops them. The stop signal — a pass
  whose findings are the previous pass's own fixes — is a per-ticket judgement;
  a pass count is no proxy for it.

**The convention, from SMD-1711 on.** Every finding bullet in a review-pass
commit body ends with a tag the script reads:

```
- <finding>. (caught: <mechanism>)
- <finding>. (caught: <mechanism>; held: test-live [17])
```

`<mechanism>` is one of five: `cold-read` (a reviewer reading the diff or the
record), `run-it` (running the suite, bench or tool and reading what it did),
`mutant` (a deliberate break the suite should have failed on), `walkthrough`
(following the documented procedure as an operator or deployer), `automated` (a
gate fired on its own — CI, a check, preflight, typecheck; name it in `held`).
Confirmations of no defect and record fixes carry the tag too: the mix per
mechanism is the point. `held` is optional and names the test section, check
or migration that now enforces the finding. An untagged bullet is counted as
`implicit`, and the script says how many there were; a bullet that contains
"(caught" but does not end in a readable tag is warned on, not counted as
untagged. Bullets that only report a green run are not findings.

**Re-measure when ten tickets carry tags**: `bun scripts/mechanism-yield.mjs
--since <first tagged commit>` — that commit and everything committed at or
after it, so a branch begun earlier contributes only what it committed in the
tagged era. That run — not this note — decides SMD-1712,
the citations facet that would give `delete_thought` a `CITED` refusal; it is
gated on the number. The script is a maintainer report, not a CI gate; it
prints its rules and a sample per class so the tallies can be judged before
anything is built on them. `--self-check` runs the parser's fixtures.

**The window and the attribution, corrected (SMD-1728).** A review pass aimed
at PR #76 by mistake ran the script on the day it was merged and showed the
window was not what the header said. `--since YYYY-MM-DD` on the git path
handed the bare day to git, whose approxidate reads it as that day *at the
current time*: at 03:27, `--since 2026-09-18` counted 0 commits while the same
day's saved dump counted 9, so every pass committed earlier that day was
dropped silently. The two paths also cut on two clocks — the anchor and git's
`--since` on committer time, each row and the dump filter on author date — and
129 of the log's 1,351 commits carry different days on the two (every rebase
moves the committer date; four of them are review passes), so a dump and a
live run of one window tallied differently. Both are one rule now: every date
is the committer date (`%cd`), and a `--since` day is the whole calendar day
on both paths, filtered on the row's date rather than passed to git. Verified
on the live log: `--since` at 2026-09-18, -17 and -14 returns the same commit
set from the git path and from a dump, and the four passes authored the day
before they were committed are in or out of both together.

The attribution rule was the larger defect. `ticketOf` took the first
`SMD-nnnn` anywhere in subject and body, and a subject often names another
ticket before its own ("main took 79 for SMD-1037 while the branch sat
unpushed … (SMD-1607)"): 13 of the 221 review passes at the 28e20d7 baseline
were credited to the wrong ticket, and three "tickets" in the tally (SMD-1616,
SMD-1624, SMD-1625) existed only by that error. The rule is now the trailing
`(SMD-nnnn)` of the subject, then the first mention in the subject, then the
body. The baseline figures above are re-read under it from the same dump: 221
review passes across **61** tickets (was 64), 511 findings in **31** (was 34);
the per-pass defect shares (44 / 43 / 51 / 51 %), the fourteen tickets whose
last defect came at pass three or later and the three-of-four on their final
pass are unchanged. Also fixed, each with a fixture: the pass number is the
leftmost mention whichever spelling ("Review pass 4: the third pass's fix held"
read as pass 3; the five subjects in the log that name two passes survived
only by word order), a bullet carrying a `(caught` tag is a finding wherever
it sits (a "Verified:" line may introduce tagged findings, and a tagged bullet
may quote the count that proved it), a bullet too short to be a finding is
counted as skipped rather than nowhere, a defect found by a named or unnumbered
pass shows as "an unnumbered pass" in the per-ticket table instead of "none",
and a row whose tag does not parse is classified over the finding, not over
the tag's tail. A dump made before this change carries author dates and
windows on them; the whole-log baseline does not depend on the date column.

---

## Known issues we did NOT fix

Deliberate. Recorded so nobody assumes they were missed.

- **The access key still rides in the URL** — but it is now scoped, named and
  hashed (fix 14). `?key=` is kept because Claude Desktop connectors are URL-only,
  so a key in a URL still reaches access logs and browser history. What changed is
  what a leak is worth: a read-scoped key cannot write, and `capture_thought` is
  not even registered for it. Upstream
  [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216) and
  [PR #238](https://github.com/NateBJones-Projects/OB1/pull/238) (OAuth 2.1) remain
  the real fix. Change 42 is adjacent, not a substitute: it makes the claude.ai
  connector *reach* the key path at all (upstream
  [#340](https://github.com/NateBJones-Projects/OB1/issues/340)) by answering
  OAuth discovery with 404; it does not change what the key is. **Still treat a
  connection URL as a credential**, and give URL-embedded clients read scope.
- **The upstream PR gate can be bypassed with a title.** A PR titled `[docs] …`
  (or touching no contribution directory) exits before the credential scan runs.
  Only matters if we start accepting PRs into this fork.
- **`claude-issue-triage.yml`** feeds untrusted issue bodies to an agent holding
  `issues: write`; **`discord-announce.yml`** declares no `permissions:` block.
  Neither is reachable in a fork that has those workflows disabled.
- **Three overlapping dashboards** (`open-brain-dashboard`, `-next`, `-pro`) with
  different auth and env models. Nothing says which is canonical. Pick one before
  depending on any.
- **`sensitivity-tiers` does not exist.** Both Next dashboards, the
  `weekly-digest` recipe and its code reference it as a primitive.
  [PR #110](https://github.com/NateBJones-Projects/OB1/pull/110) was closed
  pending a consolidation that never landed. Any feature gated on it is inert.
- **`server-portable` has not served a live `workerd` request.** The Cloudflare
  target is verified with the real bundler (`server-portable/README.md` has the
  size) and CI rebuilds it on
  every push, but no request has gone through `workerd` end to end. Smoke-test a
  real deploy before relying on it.
- **Two suites still test mirrors.** `server/test-stats-pagination.mjs` and
  `server/test-capture-atomicity.mjs` need a stubbed Supabase client, which the
  lazy `db()` accessor makes easy to inject but which is not built. Until then they
  keep their drift guards.
- **The eval sample is small.** Twenty retrieval queries and eight extraction
  captures. Differences under ~0.05 MRR, or one point of a per-field score, are not
  meaningful; the clear separations (the long-document slice, the structural
  failures) are. The test sets also reflect one person's kind of notes.
- **The local path is verified against real Ollama** (0.33.2, `nomic-embed-text` +
  `llama3.2`): `preflight --deep` passes, including `llama3.2 honours JSON mode`,
  and real thoughts capture and retrieve with no external service. Two caveats
  remain: Ollama was installed **natively** (Homebrew), because a Linux container
  on Apple Silicon gets no Metal passthrough and runs inference on CPU — the
  compose `local-models` profile is for Linux hosts and CI. And a container
  reaching a host-native Ollama needs `OLLAMA_HOST=0.0.0.0` plus
  `OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1`, since Ollama binds
  loopback by default.
- **The 24 shim-migrated files are not individually tested.** Most need live
  credentials (Gmail, Slack, Readwise). The shim itself has 61 assertions against
  real Postgres, and CI checks every migrated file still parses and that the
  codemod round-trips byte-for-byte — but exercise the ones you actually run
  before trusting them.
- **Seven files still need a human.** Four use PostgREST resource embedding (a
  join), two use nested `.or()` grouping, and one is a type-only import. Run
  `node scripts/migrate-to-sql-shim.mjs` for the current list and the reason.
- **`CLAUDE.md` and `AGENTS.md` disagree** — a duplicated worktrees block, then
  divergent content, and `AGENTS.md` mandates updating a private tracker.
  [PR #274](https://github.com/NateBJones-Projects/OB1/pull/274) proposed the
  obvious fix, was endorsed in review, and was closed unmerged.
- **An HNSW walk can miss a live row over near-equidistant vectors**
  (pgvector 0.8.6). Investigated under SMD-1632 and now understood: over the
  test suite's orthogonal unit axes (every pair at cosine distance 1.0)
  pgvector's neighbour-selection heuristic keeps few edges and the graph is not
  connected, so a search walking from the entry point misses a live row its own
  vector matches — the flake behind `test-live.ts` [7], reproduced with no
  vacuum. `db/hnsw-graph.ts` reads it from the index and [17] drives it; [4],
  [7], [11] and [15]'s reads take `match_thoughts`' exact branch, which does not
  walk. A **random, production-shaped corpus is fully reachable**, so this is
  the test corpus's problem (and quantised or binary vectors', SMD-1501) rather
  than a live brain's; no production check or capture-path verification is built
  for it, and `REINDEX` is not a remedy (a rebuild of an equidistant graph is no
  more connected). See change 85 (SMD-1632) for the measurements and the
  decision.
---

## Before this touches anything sensitive

Two constraints that are not engineering problems.

**Data.** Open Brain's model is one static bearer key in a URL, one shared
`thoughts` table with no per-user isolation, and every captured thought sent to
OpenRouter for LLM metadata extraction. That is fine for personal notes. It is
not an architecture to put regulated or patient-adjacent data into, and no patch
in this series changes that.

**Licence.** FSL-1.1-MIT, © Nate B. Jones. "Your internal use and access" is an
explicitly Permitted Purpose, so a private fork for internal tooling is squarely
allowed. A **Competing Use** — making it available to others in a commercial
product with the same or substantially similar functionality — is not. Each
version converts to MIT two years after upstream publishes it. Fine as internal
tooling; get a legal read before any of it ships in a product.
