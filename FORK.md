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

Twenty-four numbered changes on top of the pin, across 71 `[fork]` commits. Seven
fix defects found in an audit of the pinned tree; the rest are migration work — a
runtime-neutral build (Phase 3), the core schema as applicable migrations
(Phase 1), and a swappable data layer (Phase 2).

The table below covers changes 1–17, which landed before this file grew prose
sections. Changes **18–24 are the numbered `###` sections** further down, which is
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
server-portable/test-update-delete.ts # fix 22 (new file)
server-portable/test-audit.ts    # fix 21  (new file)
db/test-support.ts               # fix 20  (new file — schema lifecycle, assert)
db/ci-parity.sh                  # fix 20  (new file — CI's order, one shared Postgres)
server-portable/chunk.ts         # fix 18  (new file)
server-portable/thoughts.ts      # fix 20  (new file — pure rules, lifted for testing)
server-portable/test-support.ts  # fix 20  (new file — the MCP client)
server-portable/test-thoughts.ts # fix 20  (new file)
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
- For chunked content `thoughts.embedding` becomes the *first chunk's* vector, not
  the whole content's. Embedding the whole thing would be an over-batch request,
  which Ollama answers by silently truncating — reintroducing the bug in the one
  column pre-existing rows and the PostgREST path still depend on.
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

Measured best on a real corpus: 0.933 MRR against `embeddinggemma`'s 0.914 over 97
real issues, and the only local model that embeds a long capture whole. Costs ~3x
the embedding latency and 2.5 GB.

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

### 24. An opt-in trigram index on `thoughts.content` — and what it is worth

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

**So the index is opt-in, and off by default.** `OB1_TRGM_INDEX=on` builds it;
unset leaves the extension in place and the index out. That resolves the tension
directly rather than arguing around it: a stock deployment pays nothing for a
capability it cannot reach, and a deployment that has installed
`schemas/enhanced-thoughts`, or queries the table with `ILIKE` itself, gets the
index by setting one variable.

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

**Measuring it was harder than building it.** The migration is 39 lines. The
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
cd .. && node scripts/check-fork-consistency.mjs

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
