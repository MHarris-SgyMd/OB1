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

Twenty-eight numbered changes on top of the pin. Seven fix defects found in an
audit of the pinned tree; the rest are migration work — a runtime-neutral build
(Phase 3), the core schema as applicable migrations (Phase 1), and a swappable
data layer (Phase 2).

The table below covers changes 1–17, which landed before this file grew prose
sections. Changes **18–28 are the numbered `###` sections** further down, which is
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
| 10,000 | 50% | 10.0 | 8.0 | 0/50 | 10.0 | 9.4 | 0/50 |
| 10,000 | 10% | 5.3 | 4.9 | 1/50 | 10.0 | 10.0 | 0/50 |
| 10,000 | 1% | 0.8 | 0.8 | 24/50 | 10.0 | 10.0 | 0/50 |
| 10,000 | 0.1% (9 rows) | 0.1 | 0.1 | 46/50 | 9.0 | 9.0 | 0/50 |
| 100,000 | 50% | 10.0 | 4.6 | 0/50 | 10.0 | 6.4 | 0/50 |
| 100,000 | 10% | 5.2 | 3.7 | 0/50 | 10.0 | 8.7 | 0/50 |
| 100,000 | 1% | 0.5 | 0.5 | 30/50 | 10.0 | 10.0 | 0/50 |
| 100,000 | 0.1% | 0.0 | 0.0 | 48/50 | 10.0 | 10.0 | 0/50 |
| 100,000 | 0.01% (6 rows) | 0.0 | 0.0 | 50/50 | 6.0 | 6.0 | 0/50 |

Two things in the after column are not the fix. The 6.4 and 8.7 at 100,000
rows for the broad filters are the HNSW approximation — random uniform vectors
are the index's hardest case, and 007 scored 4.6 and 3.7 on the same rows; the
iterative scan improves it because it keeps going, but `ef_search` is unchanged
and so is the index. And the two thinnest rows return fewer than ten because
fewer than ten exist; they are there to show the scan reaching past its
candidate budget for every matching row and finding them all.

**These tables were measured four times.** The first bench's random generator was an
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
replaced the body's OR with two branches (below); the recall columns did not
move and the latencies did, and the tables are from that run.

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
  only in the filtered branch; the unfiltered branch has no predicate and no
  join.
- **Two `RETURN QUERY` branches, one per path.** Drafts three through eight kept
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
- `match_count` is clamped to 1–100 inside the function, as 012 clamps its
  `p_limit`, and `search_thoughts` bounds `limit` to 1–100 in both servers, as
  the keyword tool already did. 007 capped each CTE near 40 candidates whatever
  was asked; this function honours `v_fetch`, so an unbounded count became
  unbounded scan work — `limit: 5000` would walk each CTE to 20,000 passing
  candidates — and the callers who send a filter are outside the servers' bound.
  What the clamp changes, named: 0 and negative counts return one row, NULL
  returns ten, and integrations that asked for 200–500 rows as headroom for a
  client-side post-filter now get 100 — more than 007 ever returned, less than
  they asked for. The fourth pass asked for the tool bound, the sixth for the
  clamp, the seventh for the edges to be stated and tested.
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
  never runs the DO block and a non-owner cannot. The seed guard in 014 asks
  the same question for the same reason: a database-level seed outranks server
  configuration, so seeding over an operator's `ALTER SYSTEM` would silently
  undo it (verified), and the eighth-pass version, which looked only for a
  database-level row, would have.
- The function-level SET is applied at CALL time too, so a non-superuser in
  a fresh session that has not yet loaded pgvector is refused on the first call
  as well as on the CREATE. First-party stores and PostgREST cast the query
  vector from text, which loads the library first; a direct SQL caller feeding
  an existing column value in uncast, on a cold pooled connection, does not.
  Documented in the header rather than engineered away: moving the settings
  into the body as `SET LOCAL` would reopen the transaction-scoped leak this
  design rejected, for a path only cold, uncast, non-superuser direct SQL
  reaches. Cast the argument or `SELECT '[1]'::vector` on connect.
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
- The plans, read from the deployed body (bench section C). Under the custom
  plan both sides come at the filter from the GIN index: a bitmap on `thoughts`
  and a sort for the direct side, a bitmap on the parent and primary-key lookups
  into `thought_chunks` for the chunk side. Under the generic plan, where the
  filter is a parameter, the direct side still uses the GIN index; the chunk
  side, whose filter lives on the parent row, walks its own HNSW index and looks
  each candidate's parent up. Both are exact for the filter, because the walk is
  iterative and bounded.

**The second defect the mechanism predicted.** `ORDER BY embedding <=> q LIMIT
200` returns 40 rows on a 10,000-row table, because the scan returns at most
`ef_search` and stops. So `v_fetch` above 40 was never honoured: with no chunk
rows `match_count = 50` returned 40, and with chunks the two CTEs together capped
near 80 — asked 100, got 68 to 79. 007's header calling the factor "a recall
budget, not a guess" was true only at `match_count <= 10`. The iterative scan
fixes this too: asked 100, got 100.

**Cost, and the plan it does not depend on.** The default path — unfiltered,
ten rows, what every first-party caller sends — costs what it did: median
0.62 → 0.68 ms at 10,000 rows, 1.32 → 1.40 ms at 100,000; its branch has no
predicate and no join. Filtered medians at 10,000 rows run 1.1–3.3 ms. At
100,000 rows they run 0.3–7.8 ms where the planner takes the GIN index — the
broad tiers cost the most, a bitmap over 10,000 or 50,000 matching rows has to
be sorted — and 44 and 190 ms on the 1% and 0.1% tiers in this run, where it
sent both sides down the HNSW walk instead; the previous run of the same bench
on the same seeded data took those two tiers to the GIN index at 2.2 and
0.7 ms. That choice is the planner's estimate on a statistics sample, it was
this way before the body had two branches (an earlier run recorded the 1% tier
at 41 ms one time and 2 ms the next), and the answer is complete either way.
The function declares no plan mode: plpgsql runs a statement's custom plan
five times and then its generic plan if that does not estimate costlier, and
section C explains both for a 1% filter — 0.65 ms custom against 3.87 generic
at 10,000 rows, where both plans reach the GIN index for `thoughts` and the
generic one walks the chunk index; 42.5 custom against 14.3 generic at 100,000,
where the custom plan walked both sides and the generic one still had the GIN
index for `thoughts`. Section D forces the generic plan for the whole session
at 100,000 rows: a 0.1% filter, a 0.01% one and one matching nothing took
62–64 ms each and returned every matching row, because both scan bounds are in
force (seeded at database level, the session reconnected to read them) and the
chunk side pays a primary-key lookup per candidate. The single-text body with
`plan_cache_mode = force_custom_plan` measured 211–294 ms on the same section.
Removing the OR turned the plan the function had to be kept off into one it
may run and still answer, which is what let the forced plan mode go; the
bounds are what make every plan here a latency and not a recall question.

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
1%. SMD-945 and SMD-958 both redefine `match_thoughts` and should build on this
body so they do not reintroduce the post-filter.

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
  the real fix. **Still treat a connection URL as a credential**, and give
  URL-embedded clients read scope.
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
  target is verified with the real bundler (252 KiB gzipped) and CI rebuilds it on
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
