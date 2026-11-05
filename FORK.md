# FORK.md — the fork era: where Daemonic Brain came from

Daemonic Brain began as a fork of
[NateBJones-Projects/OB1](https://github.com/NateBJones-Projects/OB1) (Open
Brain), whose guide builds the brain on supabase.com. The fork was for running it
without Supabase, on infrastructure you control. It is a project in its own right
(decided 2026-11-04, SMD-3765): the pin was frozen on 2026-10-25 (SMD-1256),
nothing further is taken from upstream, and no parity is kept.

This file is the record of that era — the pin, changes 1–17, the files the fork
owned, the detach, and how rebases ran — in the voice it was written in: "this
fork", "we" and "upstream" are that voice. How the project is versioned,
released, deployed and checked now is [`MAINTAINING.md`](MAINTAINING.md). Every
change from 18 on is one file under [`changes/`](changes/README.md), indexed
there. A section that moved keeps its heading here with a pointer, so a citation
of it still lands. **Start at [`SETUP.md`](SETUP.md).**

---

## The pin

| | |
| --- | --- |
| Upstream baseline | `9543c29a3e44a210ce278392b9fac11248997461` |
| Upstream date | 2026-08-30 |
| Git tag | `upstream-pin-9543c29` |
| Patch branch | `siggymd/fork-baseline`, until the fork shipped from `main` |

Upstream publishes **no releases and no tags** — there is no stable version to
track, and the setup guide has users `curl` `main` straight into production. The
tag above is our substitute for a release: it is the exact upstream tree our
patches apply to.

The fork deployed from that branch, never from upstream `main`. Daemonic Brain
deploys as the compose stack: [`MAINTAINING.md`, "Deploying"](MAINTAINING.md#deploying).

### Versioning

Moved to [`MAINTAINING.md`, "Versioning"](MAINTAINING.md#versioning) (SMD-3765), with "What the version contract covers".

### Cutting a release

Moved to [`MAINTAINING.md`, "Cutting a release"](MAINTAINING.md#cutting-a-release) (SMD-3765).

### Deploying

Moved to [`MAINTAINING.md`, "Deploying"](MAINTAINING.md#deploying) (SMD-3765).

---

## What we changed

Numbered changes on top of the pin. Seven fix defects found in an audit of the
pinned tree; the rest are migration work — a runtime-neutral build (Phase 3), the
core schema as applicable migrations (Phase 1), and a swappable data layer
(Phase 2). Ten (changes 31, 53, 55, 59, 79, 82, 86, 87, 88, and 89) ship no
runtime change at all: each is a measurement that decided against building
something.

The table below covers changes 1–17, which landed before this file grew prose
sections. Every change from 18 on is **one file under
[`changes/`](changes/README.md)** — `NNN-<slug>.md`, a fixed shape, a 150-line
cap — and their index is generated into [`changes/README.md`](changes/README.md)
by `scripts/fork-index.ts` (into this file, until SMD-3765); check 15 holds the
sizes, the numbering and the index, and fails a "FORK.md change N" citation
with no file behind it (SMD-1917).

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
server/index.ts                  # fixes 3, 4, 5; deleted by SMD-1800 (the Edge Function build; server-portable is the server)
server/package.json              # fix 2; deleted by SMD-1800
server/bun.lock                  # fix 2; deleted by SMD-1800
server/test-stateless.mjs        # fix 1; deleted by SMD-1800 (test-server [4]–[5] hold the envelope)
server/test-stats-pagination.mjs # fix 3   (new file); deleted by SMD-1800 (thought_stats aggregates in SQL, migration 024)
server/test-capture-atomicity.mjs# fix 5   (new file); deleted by SMD-1800 (test-store-sql [2], test-e2e-sql hold the one write)
db/migrations/                   # fix 9   (moved here from server/ in fix 9)
.github/metadata.schema.json     # fix 7   (3 additive optional fields); SMD-1933 adds `connectors`
.github/workflows/fork-checks.yml# fix 7   (new file)
.github/workflows/ci-shift.yml   # SMD-3467 (new file — warns of a job or step on main that got slower)
.github/dependabot.yml           # SMD-2093 (new file — moves the workflows' SHA-pinned actions)
scripts/check-fork-consistency.ts # fix 7 (new file)
scripts/mechanism-yield.ts       # SMD-1711 (new file — review-pass yield report, not a gate); window and attribution fixed SMD-1728
scripts/ci-step-times.ts         # SMD-3305 (new file — a CI job's and its steps' times over a window of runs, with medians; not a gate); SMD-3467 adds --shift
scripts/suite-sections.ts        # SMD-3305 (new file — a suite's bracketed sections by wall time; not a gate)
scripts/connector-registry.ts    # SMD-1933 (new file — the connector registry's rules and the spec's table renderer)
scripts/contributions.ts         # SMD-1933 (new file — the one walk of the contribution directories)
docs/connector-registry.json     # SMD-1933 (new file — the connector taxonomy's one source)
docs/connector-taxonomy.md       # SMD-1933 (new file — the spec; its tables are rendered from the JSON)
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
scripts/migrate-to-sql-shim.ts   # fix 13  (new file — the codemod); change 74 (the runtime line, the KEEP list); change 77 (the embed blockers are the shim's refusals; agent-memory-api kept)
<23 recipe/integration files>    # fix 13  (one import line each; revert with the codemod; 24 until change 74 put the local-brain client back)
<7 extension servers>            # change 64 (keys through extensions/_shared/auth.ts; the tools that write gated); deleted by SMD-2311
extensions/_shared/auth.ts       # change 64 (new file — server-portable/auth.ts byte for byte; the test holds them equal); deleted by SMD-3747
extensions/test-auth.ts          # change 64 (new file — the seven servers under scoped keys); change 67 widened it to every vendored server; change 74 starts every server on the shim under bun; SMD-1800 holds the tree's three package.json to one MCP stack
extensions/package.json          # change 64 (new file — test deps pinned to the extensions' deno.json; since SMD-1800 the pin the other two installs are held to)
extensions/bun.lock              # change 64 (new file)
<17 vendored files>              # change 67 (thirteen servers and samples onto scoped keys through _shared/auth.ts; four onto a timing-safe compare, one through the same module)
recipes/_shared/auth.ts          # change 67 (new file — server-portable/auth.ts byte for byte); deleted with ob-graph and work-operating-model-activation by SMD-2920
recipes/editorial-policy/_shared/auth.ts            # change 67 (new file — the same)
recipes/edge-function-cost-optimization/examples/_shared/auth.ts  # change 67 (new file — the same); deleted with the recipe by SMD-1800
integrations/_shared/auth.ts     # change 67 (new file — the same)
integrations/consolidation-workers/_shared/auth.ts  # change 67 (new file — the same, beside the workers' existing _shared/)
<9 vendored files>               # change 69 (a thought's content and vector through update_thought / the 3-argument upsert_thought; the enhanced columns beside them)
extensions/test-writes.ts        # change 69 (new file — every vendored writer driven against Postgres, its row against update_thought's)
<8 vendored files>               # change 71 (a captured thought through the 3-argument upsert_thought instead of a raw INSERT; three more say they bypass it)
compat/supabase-sql/index.ts     # change 73 (PostgREST's JSON-path column in filters and order; a timestamp back as a string — the bio worker runs on the fork); change 77 (the catalog: arrays by declared type, .not(), one-hop embedding, PostgrestError, one pool per URL)
compat/deno-on-bun.ts            # change 74 (new file — Deno's two globals on Bun, for the servers on the shim); deleted by SMD-1799 (the servers are Bun-native)
<16 vendored files>              # change 74 (one import line each — compat/deno-on-bun.ts first; four swap Supabase's jsr: types import for it); the line went with SMD-1799
extensions/test-tools.ts         # change 77 (new file — every extension tool on the shim, against Postgres); deleted by SMD-2311
db/test-bench-reuse.ts           # change 76 (new file — the kept bench corpus's oracle cache held to the computation, on one index)
db/bench-oracle.ts               # change 76 (new file — the cache's pure part: what of a marker's entry a run may trust; test-schema [37])
db/migrations/039_*.sql          # change 81 (new file — the two HNSW indexes over embedding::halfvec under their names; match_thoughts' walk branches order by the cast)
db/migrations/040_*.sql          # change 91 (new file — 039's match_thoughts with `SET jit = off`; a disabled planner path no longer JIT-compiles the gate's sample)
db/migrations/041_*.sql          # change 94 (new file — 040's match_thoughts with `enable_nestloop = on` and `enable_tidscan = on` pinned; an operator's setting no longer reaches the call's joins or the gate's probe)
db/migrations/042_*.sql          # change 95 (new file — thought_facets, the citation guard on thoughts, delete_thought(uuid, jsonb, boolean), record_citation)
db/migrations/043_*.sql          # change 98 (new file — query_log.tool's two shapes and the table's cite clause as COMMENTs, behind 031's guard; test-schema [42], test-upgrade [20]; [21] keeps test-support's reset lists honest)
evals/eval-quant.ts              # change 81 (new file — vector, halfvec and binary-with-rerank measured on real vectors at the shipped width; test-schema [38], test-upgrade [16])
<4 vendored MCP servers, 1 sample> # change 78 (a McpServer built per request — per session in the cost recipe's after sample — in place of one shared and connect()ed to a fresh transport each time)
<17 pin sites, 3 lockfiles>      # change 83 (@hono/mcp 0.1.1 → 0.1.5: the transport lets go of each POST it has answered; the after sample's sweep closes the transports it drops)
<19 pin sites, 3 lockfiles, 15 servers, 20 SDK importers> # change 84 (SDK 1.30.0, @hono/mcp 0.3.2, hono 4.13.8, zod 4.6.5 together; the Accept patches removed; an @ts-types pragma on every SDK import so Deno types it; the pragmas and the deno.json pins went with SMD-1800)
server-portable/tools.ts         # change 100 (new file — the typed source of the MCP tool surface: TOOLS as const, ToolName, visibleToolNames())
server-portable/tools.json       # change 100 (new file — GENERATED from tools.ts by scripts/gen-tools.ts; deploy/smoke.sh reads it)
scripts/gen-tools.ts             # change 100 (new file — writes tools.json from tools.ts; renderToolsJson() shared with the round-trip check)
<4 suites + deploy/smoke.sh>     # change 100 (test-server/-auth/-e2e-sql/-agents and smoke.sh read the manifest; test-server's tools/list is the live drift guard; test-auth's mutating list is typed ToolName[])
db/test-support.ts               # change 100 (createAssert gains total()/skipped()/docCheck — a doc check counted apart from the total it verifies)
db/test-schema.ts, db/test-live.ts # change 100 (each holds db/README.md's quoted assertion total to the run's own; test-live only on a full run)
scripts/check-fork-consistency.ts # change 100 (grant privileges per group [SMD-1471]; every migration documented once and the count checked; tools.json round-tripped against tools.ts [SMD-1805])
changes/                         # SMD-1917 (new dir — one file per change from 18 on: NNN-<slug>.md once numbered, smd-NNNN.md until the release step numbers it; a fixed shape and a 150-line cap)
scripts/fork-index.ts            # SMD-1917 (new file — renders FORK.md's index from changes/; check 15 round-trips it; the release step calls it); SMD-2084 (the numbered files alone — a fragment moves nothing in FORK.md)
db/config.mjs                    # change 100 (grantRows() — every ROLE_GRANTS row undeduped, for the per-group privilege check)
db/README.md                     # change 100 (the applied-migration count stated as a digit so the check can read it)
docs/01-getting-started.md       # fix 6
recipes/content-fingerprint-dedup/README.md  # fix 6
recipes/email-history-import/README.md       # fix 6
recipes/gmail-smart-pull/README.md           # fix 6
dashboards/open-brain-dashboard-next/README.md # fix 6
integrations/open-brain-rest/metadata.json   # fix 7
recipes/world-model-diagnostic-activation/metadata.json # fix 7
skills/world-model-diagnostic/metadata.json  # fix 7
```

`recipes/weekly-digest` and `extensions/professional-crm` are deliberately
**unmodified** — their violations were resolved by widening
`.github/metadata.schema.json` instead, so the contributor credit and env-var
manifests they carry survive a rebase untouched. `recipes/lint-sweep` was the
third until SMD-2144 moved its script onto the shim and its manifest to the
object form the schema had been widened for (`env` grouped, `tools` Bun).

Until SMD-1800 the one file where a conflict was likely to need thought was
`server/index.ts`, upstream's Edge Function (changed 9 times in upstream's
history, not since June 2026); it is gone, and what remains of upstream's tree
here is the vendored content, where every server's head (`process.env`, the SQL
shim import) and tail (`export default { port, fetch }`) is the fork's. Measured
on the day `server/` left: `git merge-tree --write-tree upstream/main HEAD`
against upstream's three commits since the pin conflicts on **three files, all
workflows this fork deleted** (`.github/workflows/{markdown-lint,ob1-gate-v2,
ob1-pr-followups}.yml`, SMD-1256's decision) and on **no vendored file**;
`CONTRIBUTING.md`, `docs/01-getting-started.md` and `recipes/README.md`
auto-merge. The same before the deletion: upstream never touched `server/`
after the pin. Re-run it before a rebase; the number is the cost.

### Drift guards

The three suites that once mirrored `server/index.ts` inline behind guards that
read it as text (a silent mirror is how fix 1's bug happened) left with the file
(SMD-1800). `server-portable/` never needed them: its env is read lazily, so
`test-server.ts` imports the server and asserts against the running handler,
and the vendored servers are imported and started the same way by
`integrations/test-auth.ts` — there is nothing to drift from.

---

## Checking CI on this fork

Moved to [`MAINTAINING.md`, "Checking CI"](MAINTAINING.md#checking-ci) (SMD-3765).
One trap of the fork era stays here, as it was written:

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

No rebase runs now: the pin was frozen on 2026-10-25 (SMD-1256). This is how
one ran, roughly quarterly, or when something landed that we wanted.

```bash
git fetch upstream
git log --oneline upstream-pin-9543c29..upstream/main -- server/ docs/01-getting-started.md
git merge-tree --write-tree --name-only upstream/main HEAD   # the dry run: which files conflict,
                                                             # before anything moves (the count
                                                             # under "Files we own" is this)

git checkout -b siggymd/rebase-$(date +%Y%m%d) siggymd/fork-baseline
git rebase -X ignore-space-change upstream/main   # every vendored server's head and tail is the
                                                  # fork's (the shim import, process.env, the Bun
                                                  # export — changes 74, 133, SMD-1799), and change
                                                  # 78 re-indented 1,517 lines of enhanced-mcp; the
                                                  # flag resolves whitespace-only hunks and takes an
                                                  # upstream edit inside a span at its old
                                                  # indentation, to re-indent by hand. An upstream
                                                  # edit to a server's Deno head or tail is a
                                                  # conflict to resolve as the fork's shape.

for d in rest-client mcp-server server-portable db; do (cd $d && bun install --frozen-lockfile); done
cd server-portable && bun test-server.ts && bunx tsc --noEmit
bun run test:sql && bun run test:e2e   # needs podman or docker
cd ../db && bun test-schema.ts
./with-postgres.sh bun test-live.ts    # needs podman or docker
cd .. && bun scripts/check-fork-consistency.ts   # CI runs it too (change 58)

git tag -a upstream-pin-$(git rev-parse --short upstream/main) \
  -m "Upstream main @ $(git rev-parse upstream/main)"
```

Then update the pin table at the top of this file.

### Vendored content: audit once, hold the delta

Moved to [`MAINTAINING.md`, "Vendored content: audit once, hold the delta"](MAINTAINING.md#vendored-content-audit-once-hold-the-delta) (SMD-3765).

### Landing a rebase on `main`, which is protected

`main` carries a ruleset — one required check, "Fork Checks passed", changes only
through a pull request, no force-push and no bypass actor — described in
[`MAINTAINING.md`, "Checking CI"](MAINTAINING.md#checking-ci). That is
deliberate, and it interacts with a rebase in one specific way.

A rebase produces `siggymd/rebase-YYYYMMDD` with **rewritten history**, so it
cannot fast-forward onto `main`. Two ways forward:

**Open a pull request (normal case).** The pull-request rule means **no push
directly to `main` succeeds**, green checks or not, and the required checks refuse
it a second way — a push carries commits CI has never seen. GitHub answers with
the rules it applied, one `remote: -` line each: that changes must be made through
a pull request, and that the required status checks are expected. That is not a
quirk of the merge; it is what the ruleset means. Everything
reaching `main` goes through a PR, which is two commands:

```bash
gh pr create --fill --base main --head siggymd/rebase-$(date +%Y%m%d)
gh pr merge --merge --auto        # lands itself once "Fork Checks passed" passes
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
to `disabled`, push, and put it back from the record, so the live copy converges
on the file — every field the file names — at every use:

```bash
gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 -f enforcement=disabled
git push --force-with-lease origin main
gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input .github/rulesets/main.json
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

Fixes 1–5 all lived in `server/index.ts` (deleted by SMD-1800). Fixes 6 and 7 are contributable in
principle; note that [issue #482](https://github.com/NateBJones-Projects/OB1/issues/482)
reports the upstream PR gate currently fails on **every** fork-originated PR.

---

## Review passes: what caught a finding is written at the catch

Moved to [`MAINTAINING.md`, "Review passes: what caught a finding is written at the catch"](MAINTAINING.md#review-passes-what-caught-a-finding-is-written-at-the-catch) (SMD-3765).

## The recurring defect in this fork: a value defined twice

Moved to [`MAINTAINING.md`, "The recurring defect: a value defined twice"](MAINTAINING.md#the-recurring-defect-a-value-defined-twice) (SMD-3765).

## Known issues we did NOT fix

Moved to [`MAINTAINING.md`, "Known issues we did NOT fix"](MAINTAINING.md#known-issues-we-did-not-fix)
(SMD-3765). Three items stayed here, as they were written: two concern
upstream's workflows, which the fork deleted, and one the Workers target, which
SMD-3152 retired.

- **The upstream PR gate can be bypassed with a title.** A PR titled `[docs] …`
  (or touching no contribution directory) exits before the credential scan runs.
  Only matters if we start accepting PRs into this fork.
- **`claude-issue-triage.yml`** feeds untrusted issue bodies to an agent holding
  `issues: write`; **`discord-announce.yml`** declares no `permissions:` block.
  Neither is reachable in a fork that has those workflows disabled.
- **`server-portable` has not served a live `workerd` request.** The Cloudflare
  target is verified with the real bundler (`server-portable/README.md` has the
  size) and CI rebuilds it on
  every push, but no request has gone through `workerd` end to end. Smoke-test a
  real deploy before relying on it.

## Before this touches anything sensitive

Moved to [`MAINTAINING.md`, "Before this touches anything sensitive"](MAINTAINING.md#before-this-touches-anything-sensitive) (SMD-3765).
