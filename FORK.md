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

Fifty-six numbered changes on top of the pin. Seven fix defects found in an
audit of the pinned tree; the rest are migration work — a runtime-neutral build
(Phase 3), the core schema as applicable migrations (Phase 1), and a swappable
data layer (Phase 2). Three (changes 31, 53, and 55) ship no runtime change at
all: each is a measurement that decided against building something.

The table below covers changes 1–17, which landed before this file grew prose
sections. Changes **18–56 are the numbered `###` sections** further down, which is
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
scripts/migrate-to-sql-shim.mjs  # fix 13  (new file — the codemod)
<24 recipe/integration files>    # fix 13  (one import line each; revert with the codemod)
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
  thin filters to show the bounds working when it is reached.
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
  covers 25. They are seeded ONCE at **database** level by a DO block in the
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
million rows at the default count, ~400,000 at the ceiling of 500.

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

**Not done here.** SMD-969 asks whether the *unfiltered* candidate scan reaches
the HNSW index at scale; this bench explains only the filtered case, and only at
1% — measured in change 36, at the shipped width, where the answer was no.
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
covers edits only: `upsert_thought` writes fingerprints without it, so a
capture of text X committing while an edit to X is in flight still ends in the
edit raising the unique violation, exactly as before this change. One lock per
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
stale label as they leave a stale fingerprint. A label for the rows no finished pass
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
`reembed.ts`'s header. The extraction worker has no acknowledgement path of its
own — its failed rows are 016's, and preflight does not read them.

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
takes, makes the read find the row and closes both. The label vouches exactly
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
and does from here — a check of its own, `chunk delete privilege`, reads
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
closes them; the read itself runs only when a vector arrives. The remedy for a
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
redefines this body next and carries the locked read with its `FOUND`, the
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
Over PostgREST a skip, beside `atomic capture` and `chunk delete privilege`;
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
check and `chunk delete privilege` — both say so now. To a ticket: a census of
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
`upsert_thought` overloads — 023 redefines no function, and a capture racing an edit outside the
backfill's transaction still ends as 018's header says. Deleting the extra twin
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
request and wrong for this one. With a key — not the connector's shape, its
discovery GET carries none, but any client that echoes the URL's `?key=` — it
authenticated, cost an agent-registry resolve, and was handed to
`StreamableHTTPTransport`, which opened an SSE stream nothing writes to or
closes: the response never completes (SMD-1259, found by this change's review
pass). Neither is 404. Nothing exercised the path: no test
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
the script refuses it rather than derive the wrong origin. It is the
one check a Supabase deployment cannot pass, and that failure is real.
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
#425 answers GET with 405). Both are SMD-1259, a second mechanism, not this one.
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
follow-up). Capture is the only write path this change gives provenance —
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
it lands the accept path should call it.

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
not only LongMemEval.

Upstream status: **not applicable** — a fork-internal measurement of the fork's
own retrieval. **Unfiled** upstream. Reproduce: a persisted `eval-longmemeval.ts`
load, then `bun evals/query-decompose.ts` (see `evals/README.md`).
### 56. A lease outlasts a missed heartbeat, not a batch — `renew_claims`, and the one rule the three workers share (SMD-1023)

Change 29's `claim_thoughts` stamped one `ttl_expires_at` per call, for every
row in the batch, and nothing could move it. So a lease had to outlast the
whole batch: the eighth row of a batch of eight is not started until the seven
before it finish, and its clock has run since the claim. 015's header said so,
and every consumer carried the coupling as arithmetic of its own —
`reembed.ts` grew its default lease to `--batch` × `OB1_LLM_TIMEOUT` and
refused a shorter one (change 34), `extract-entities.ts` and `consolidate.ts`
refused a batch × timeout above the lease and defaulted to one thought per
claim so the product stayed small (changes 30 and 54). When a batch overran
anyway, the next claim by any worker returned its unfinished rows to the pool,
a second worker took and repeated them, the first's `release_thought` returned
false, and after three expiries the reaper marked the row failed — a cap
written for a thought that kills every worker that touches it, applied to a
healthy row that was slow. `reembed.ts`'s header called its arithmetic "a
stand-in for per-row lease renewal (SMD-1023)". This is the renewal.

**Migration 030: `renew_claims(work_type, worker_id, ttl_seconds)`.** Every
row the worker holds under the key — status `claimed`, `worker_id` its own —
has its deadline moved to `now() + ttl`, never backward (`GREATEST` with the
current one), and the ids renewed are returned. Nothing else changes:
`claim_thoughts`, `release_thought` and `release_claims_for_worker` are as 015
wrote them, `test-schema` [29] asserts 015 is still the last file to define the
first two, and the claim stays the single locking pass upstream kept it as when
it left renewal out. A pending row, a terminal row and another worker's row are
not the caller's to renew and are not returned. A lease past its deadline that
no claim has yet reaped is still the holder's — the reaper runs at the start of
`claim_thoughts` and nowhere else — and is renewed; a renewal and a reaper
reaching the row together contend on its lock, and the loser re-evaluates its
predicate on the winner's version under READ COMMITTED, so the row ends
renewed-and-held or pending-and-unrenewed, never both. The ids returned are the
rows still held: one of the batch not among them was reaped and is another
worker's now. One column comment beside it, on `ttl_expires_at`, says what the
lease means since 030; neither literal spells a flag with its dashes, which
`test-schema` [10] requires and [29] asserts of the live text.

**The heartbeat, once.** `db/lease.ts` is the implementation the three workers
share, as `consolidation_pool()` was change 54's one pool rule: a timer per
worker that calls `renew_claims` every `--heartbeat` seconds while the worker
holds rows and sends nothing while it holds none; a `held` set the loop adds a
batch to after the claim and removes each row from BEFORE its release goes out,
so a beat in flight across a release does not read the released row as lost;
a `lost` set for the ids a beat found no longer the worker's, which the loop
skips rather than repeating the provider's work and the summary counts. Beats
never overlap — a tick that finds one in flight is skipped — and the timer is
unref'd, so it holds no process open. The three workers wire it identically:
started beside the worker id, the batch added after the claim, each row removed
before its release, stopped in the `finally` that returns the leases. A beat
that fails is reported once per run of failures and the leases hold from the
last one that answered; a process that cannot reach the database cannot beat,
and its rows return to the pool as a dead worker's would, which is the right
reading of it.

**The rule that replaces "the TTL must cover the batch".** `--ttl` ≥ 2 ×
`--heartbeat`, so one delayed beat cannot lapse a lease. A pair under it is
refused before anything is claimed — exit 2, the arithmetic shown;
`reembed.ts --status` answers regardless, as before — and a lease given without
a heartbeat derives one of a third of itself, at most 60 s, so any lease of
three seconds or more fits. `--ttl` now means one thing: how long a dead
worker's rows stay out of the pool. Nothing about the batch, the timeout or the
calls a thought costs sizes it, and the three refusals that did —
`reembed.ts`'s derived floor with its long-lease warning,
`extract-entities.ts`'s `--batch × --timeout`, `consolidate.ts`'s `--batch ×
--k × --timeout` — are gone. The reaper's cap keeps the meaning 015 gave it:
under a heartbeating worker a lease lapses only when the beats stop reaching
the database for a whole lease, so a row expired three times is one whose
worker died three times on it, not one that was slow.

**Proof.** `test-live` [8e]: a worker on a 5 s lease beats at 2.5 s; a claim
at 5.5 s — past the original deadline — gets only the unclaimed rows and the
worker's release succeeds; it beats once more and stops; a claim before the
renewed deadline gets nothing and one after it receives its three rows on their
second attempt, every row ending succeeded and none failed. [8a] and [8b] hold
as they were: the claim is untouched. [9] runs `reembed.ts` end to end with
every embedding taking 600 ms, eight per claim, a 3 s lease and the 1 s
heartbeat it derives: two workers re-embed all forty-two thoughts in batches
near five seconds long, no row reaches a second worker, no release finds its
lease gone, none is lost, every claim row succeeded on its first attempt — the
ticket's first Verify bullet, which no arithmetic could pass. [10] and [16] run
their first pass under a 6 s lease so the beats fire in the other two workers,
and assert the old refusals are gone (a batch of four at a 300 s timeout is a
`--dry-run` that exits 0) and the new one holds. `test-schema` [29] owns the
state machine on one connection: the holder's rows and no others, never
backward, expired-not-reaped is still held, reaped is not, 015's CHECK still in
force under the new writer, both comments' text. A beat is one `UPDATE`
through 015's partial worker index; [8e] prints its round trip beside the
claim's — a few milliseconds on the function's first call, the plan included,
and under a millisecond after.

**What did not change, and why.** The default lease stays 900 s: shorter is
now safe — a dead worker's rows return in `--ttl`, not `--ttl` plus the batch
— but the default is the operator's to lower and the ticket did not ask.
`extract-entities.ts` and `consolidate.ts` keep one thought per claim for the
reason that survives: a claim costs half a millisecond against a model call of
seconds, so a bigger batch buys nothing and a dead worker holds fewer rows.
The read-only modes never beat, since they never claim. 028's comments on
`last_error` and `release_thought` stand as applied — nothing here redefines
either function, which is the case 028's header said a successor must mind.

Upstream status: **not applicable** — upstream's `schemas/thought-work-claims`
left mid-batch renewal out deliberately, to keep the claim one atomic
statement, and its table is not this one (change 29's four departures). A
separate renewal function keeps the property upstream wanted and could be
offered against its schema; **unfiled** upstream.

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
git rebase upstream/main

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
cd .. && bun scripts/check-fork-consistency.mjs   # CI runs it under node; bun runs it too

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
carries the audit so a rebase cannot quietly undo it. Today the audited rule is
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
with its reason. Three sibling tickets hold the rest of the standard —
SMD-1250 (vendored SQL that redefines core functions), SMD-1252 (vendored
extensions authenticating with a plaintext key compare) and SMD-1228
(integrations writing around `update_thought`) — and each should land as a
fix plus a check, in the same shape.

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
  target is verified with the real bundler (272 KiB gzipped) and CI rebuilds it on
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
