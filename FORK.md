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

### Versioning

The fork ships continuously from `main`, so for a long time nothing named what
shipped: one tag (the pin above), no releases, and a brain identified only by the
highest migration its ledger recorded. The version scheme (SMD-1804) gives it a
name:

```
MAJOR.MINOR.PATCH+upstream.<sha>
```

The build metadata carries the upstream pin, so a version says both what the fork
is and what it sits on (`1.0.0+upstream.9543c29`). The bump is chosen by the
contracts the fork already enforces — the rules are here, and checked, not
remembered:

- **MAJOR** — a migration changes a shipped function's signature or return shape
  (020's `match_thoughts`, 014's sentinel), drops or renames a shipped
  table/column/index a client can see, or changes the MCP tool surface
  incompatibly (a tool removed, an argument's meaning changed). A client written
  against `N.x` keeps working on `N.y`.
- **MINOR** — an additive migration (a new function; a new column with
  `IF NOT EXISTS`; an index swapped under the same names), a new tool, a new
  worker, a new preflight check.
- **PATCH** — no schema change: server, docs, evals, tests, or a migration that
  only re-comments (028, 043).

**The brain reports its version.** Migration 044 writes `schema_version` into
`ob1_config`; `preflight` prints it beside the ledger's highest migration and
warns, by name, when a brain is past its version's range or a server is older than
the brain it serves. `db/version.mjs` is the one definition of the current version
(`FORK_VERSION`), and `migrate.ts --dry-run` names the release each pending
migration belongs to. 044 wrote `0.0.0+upstream.9543c29`, the pre-first-release
baseline; each cut appends the migration that writes its version as the last file
of the range it freezes — 048 writes `1.0.0+upstream.9543c29`, the first release.

**A release is a tag naming three things**: the migration range it closes
(the first cut, `001..048`), the server commit, and the upstream pin. The committed
`releases.json` is the machine-readable mirror CI reads with no network. Migrations
inside a released range are **frozen** — the ledger's sha check already refuses
drift at apply time; `check-fork-consistency` adds the rule that a renumber or
edit of a released migration fails at review time (a released migration is
append-only; add a new file).

**The change counter is retired.** Numbered `### N.` sections were assigned by
hand at PR time, so every merge of `main` while a PR was in review renumbered a
section and its cross-references. A PR ships a fragment, `changes/smd-NNNN.md`
(front matter — `type`, `bump`, `tickets`, `migrations` — and a `## Changelog`
and a `## FORK` body), with no change number; the release step assigns the
numbers once, at assembly, writing each fragment as the next
`changes/NNN-<slug>.md` in merge order and regenerating the index below
(SMD-1804, SMD-1917). Changes 1–103 keep their numbers — the code comments cite
them — as the table and the files they are.

`CHANGELOG.md` (root, **Keep a Changelog 1.1.0**) is the short page beside this
design record: `## [Unreleased]` first, one dated section per release with entries
under the six headings, each entry ending in its ticket and migration numbers. The
release step writes it and the change files from the same fragments in one commit,
and `check-fork-consistency` pairs the two both ways. Conventional Commits is **not**
adopted — the fragment's fields give tooling what it needs, and the `[fork]` prefix
and `(caught: …)` tags stay. (The orphaned `.github/release-drafter.yml`, an
upstream leftover no workflow ran, is removed so there is one release mechanism.)

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

Numbered changes on top of the pin. Seven fix defects found in an audit of the
pinned tree; the rest are migration work — a runtime-neutral build (Phase 3), the
core schema as applicable migrations (Phase 1), and a swappable data layer
(Phase 2). Ten (changes 31, 53, 55, 59, 79, 82, 86, 87, 88, and 89) ship no
runtime change at all: each is a measurement that decided against building
something.

The table below covers changes 1–17, which landed before this file grew prose
sections. Every change from 18 on is **one file under
[`changes/`](changes/README.md)** — `NNN-<slug>.md`, a fixed shape, a 150-line
cap — and the index after the table is generated from that directory by
`scripts/fork-index.ts`; check 15 holds the sizes, the numbering and the index,
and fails a "FORK.md change N" citation with no file behind it (SMD-1917).

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

<!-- changes-index:start — generated from changes/ by scripts/fork-index.ts; do not edit by hand -->
**123 numbered changes** on top of the pin: 1–17 are the table above; 18–123 are one file each under [`changes/`](changes/README.md), newest last. A change's record is its file; the review-pass prose behind it is in the commits (`(caught: …)` tags, read by `scripts/mechanism-yield.ts`).

| # | Change | Ticket |
| --- | --- | --- |
| 18 | [Long captures stay searchable](changes/018-long-captures-stay-searchable.md) | — |
| 19 | [Default embedding model → `qwen3-embedding:4b` at 1024 dimensions](changes/019-default-embedding-model-to-qwen3-embedding-4b.md) | — |
| 20 | [Shared scaffolding, and pure logic lifted out of `index.ts`](changes/020-shared-scaffolding-and-pure-logic-lifted-out.md) | — |
| 21 | [Every mutation is recorded](changes/021-every-mutation-is-recorded.md) | — |
| 22 | [`update_thought` and `delete_thought`](changes/022-update-thought-and-delete-thought.md) | — |
| 23 | [A stable agent identity](changes/023-a-stable-agent-identity.md) | — |
| 24 | [A trigram index on `thoughts.content`](changes/024-a-trigram-index-on-thoughts-content.md) | — |
| 25 | [The benchmark corpus was truncated, and nobody knew](changes/025-the-benchmark-corpus-was-truncated-and-nobody.md) | — |
| 26 | [Keyword search](changes/026-keyword-search.md) | — |
| 27 | [Contextual retrieval, measured](changes/027-contextual-retrieval-measured.md) | — |
| 28 | [A filtered search reaches the index](changes/028-a-filtered-search-reaches-the-index.md) | — |
| 29 | [A lease per thought, and the re-embed that proves it](changes/029-a-lease-per-thought-and-the-re-embed.md) | — |
| 30 | [Entities and relationships](changes/030-entities-and-relationships.md) | — |
| 31 | [GraphRAG, measured](changes/031-graphrag-measured.md) | — |
| 32 | [Hybrid ranking](changes/032-hybrid-ranking.md) | — |
| 33 | [An unchanged edit is never a duplicate](changes/033-an-unchanged-edit-is-never-a-duplicate.md) | — |
| 34 | [The head window is recorded on the row](changes/034-the-head-window-is-recorded-on-the-row.md) | — |
| 35 | [Preflight sees an unfinished re-embed](changes/035-preflight-sees-an-unfinished-re-embed.md) | — |
| 36 | [`match_thoughts` reaches the index at the shipped width](changes/036-match-thoughts-reaches-the-index-at-the-shipped.md) | — |
| 37 | [`match_thoughts` blends recency into its ranking](changes/037-match-thoughts-blends-recency-into-its-ranking.md) | — |
| 38 | [A vector carries its model](changes/038-a-vector-carries-its-model.md) | — |
| 39 | [The operator's way to say "I know"](changes/039-the-operator-s-way-to-say-i-know.md) | — |
| 40 | [A re-capture's windows stay while the label vouches for them](changes/040-a-re-capture-s-windows-stay-while-the-label.md) | — |
| 41 | [003's missing half](changes/041-003-s-missing-half.md) | — |
| 42 | [OAuth discovery is a 404](changes/042-oauth-discovery-is-a-404.md) | SMD-1246 |
| 43 | [pgvector off the search path](changes/043-pgvector-off-the-search-path.md) | SMD-1247 |
| 44 | [The read tools print the thought id, so `update_thought` and `delete_thought` can reach what a search found](changes/044-the-read-tools-print-the-thought-id-so-update.md) | SMD-1248 |
| 45 | [`thought_stats` aggregates in SQL](changes/045-thought-stats-aggregates-in-sql.md) | SMD-1249 |
| 46 | [Derivation and supersession: what a thought was built from, and which it replaces](changes/046-derivation-and-supersession-what-a-thought.md) | SMD-1253 |
| 47 | [`trace_provenance` bounds its work, not only its output](changes/047-trace-provenance-bounds-its-work.md) | SMD-1288 |
| 48 | [`search_thoughts` no longer floors long captures out of the results](changes/048-search-thoughts-no-longer-floors-long-captures.md) | SMD-1300 |
| 49 | [The caveat rule is stated at the table](changes/049-the-caveat-rule-is-stated-at-the-table.md) | SMD-1052 |
| 50 | [The chunk limit follows the model's window, not a constant](changes/050-the-chunk-limit-follows-the-model-s-window.md) | SMD-1305 |
| 51 | [Two vendored recipes stop handing untrusted content a shell](changes/051-two-vendored-recipes-stop-handing-untrusted.md) | SMD-1251 |
| 52 | [The PostgREST store maps every row it returns](changes/052-the-postgrest-store-maps-every-row-it-returns.md) | SMD-1040 |
| 53 | [The post-floor recall levers, measured](changes/053-the-post-floor-recall-levers-measured.md) | SMD-1301, SMD-1302, SMD-1304 |
| 54 | [A pass that proposes which thoughts supersede which](changes/054-a-pass-that-proposes-which-thoughts-supersede.md) | SMD-1294 |
| 55 | [Query decomposition, measured](changes/055-query-decomposition-measured.md) | SMD-1318 |
| 56 | [The migrator owns the re-run](changes/056-the-migrator-owns-the-re-run.md) | SMD-1193 |
| 57 | [A lease outlasts a missed heartbeat, not a batch](changes/057-a-lease-outlasts-a-missed-heartbeat-not-a-batch.md) | SMD-1023 |
| 58 | [Vendored SQL stops replacing what the migrations own](changes/058-vendored-sql-stops-replacing-what.md) | SMD-1250 |
| 59 | [Decompose-then-rerank, measured on two corpora](changes/059-decompose-then-rerank-measured-on-two-corpora.md) | SMD-1420 |
| 60 | [`update_thought` takes provenance](changes/060-update-thought-takes-provenance.md) | SMD-1323 |
| 61 | [021's evidence backfill runs with the operator's acceptances out of its sight](changes/061-021-s-evidence-backfill-runs-with-the-operator.md) | SMD-1421 |
| 62 | [A capturing role's grants are documented and checked for the whole capture path, not `thoughts` alone](changes/062-a-capturing-role-s-grants-are-documented.md) | SMD-1226 |
| 63 | [A capture takes the fingerprint lock too](changes/063-a-capture-takes-the-fingerprint-lock-too.md) | SMD-1043 |
| 64 | [The vendored extensions authenticate the way the core server does](changes/064-the-vendored-extensions-authenticate-the-way.md) | SMD-1252 |
| 65 | [An opt-in query log turns real use into a replayable eval, and a CI gate holds a recall floor against the searches people actually ran](changes/065-an-opt-in-query-log-turns-real-use.md) | SMD-1295 |
| 66 | [A re-capture writes no provenance](changes/066-a-re-capture-writes-no-provenance.md) | SMD-1453 |
| 67 | [The vendored recipes and integrations authenticate the way the extensions do](changes/067-the-vendored-recipes-and-integrations.md) | SMD-1455 |
| 68 | [delete_thought joins the writers' lock order, closing a deadlock between an accept and a delete of the superseded thought](changes/068-delete-thought-joins-the-writers-lock-order.md) | SMD-1462 |
| 69 | [The vendored writers of a thought's content and vector go through the functions that own them](changes/069-the-vendored-writers-of-a-thought-s-content.md) | SMD-1228 |
| 70 | [The routing count is gated by a sample of the heap](changes/070-the-routing-count-is-gated-by-a-sample.md) | SMD-1463 |
| 71 | [The vendored captures that inserted a thought go through the 3-argument `upsert_thought`](changes/071-the-vendored-captures-that-inserted-a-thought.md) | SMD-1524 |
| 72 | [A loaded bench corpus outlives the run](changes/072-a-loaded-bench-corpus-outlives-the-run.md) | SMD-1493 |
| 73 | [The SQL shim takes PostgREST's JSON-path column and hands a timestamp back as a string](changes/073-the-sql-shim-takes-postgrest-s-json-path-column.md) | SMD-1544 |
| 74 | [The servers on the SQL shim run under Bun](changes/074-the-servers-on-the-sql-shim-run-under-bun.md) | SMD-1480 |
| 75 | [The MCP endpoint answers GET with 405 before `authenticate()`](changes/075-the-mcp-endpoint-answers-get-with-405-before.md) | SMD-1259 |
| 76 | [The kept bench corpus answers the exact oracle from its marker](changes/076-the-kept-bench-corpus-answers-the-exact-oracle.md) | SMD-1562 |
| 77 | [The SQL shim reads the catalog](changes/077-the-sql-shim-reads-the-catalog.md) | SMD-1588 |
| 78 | [Every vendored MCP server is built for the request, or the session, it answers](changes/078-every-vendored-mcp-server-is-built.md) | SMD-1497 |
| 79 | [The store measured against pgvector, and the second store not built](changes/079-the-store-measured-against-pgvector.md) | SMD-1037 |
| 80 | [The gate's sample is drawn by TID range](changes/080-the-gate-s-sample-is-drawn-by-tid-range.md) | SMD-1526 |
| 81 | [Quantised vector indexes at the shipped width, measured on real vectors](changes/081-quantised-vector-indexes-at-the-shipped-width.md) | SMD-1501 |
| 82 | [LanceDB, the embedded store, measured too](changes/082-lancedb-the-embedded-store-measured-too.md) | SMD-1662 |
| 83 | [The `@hono/mcp` pin moves from 0.1.1 to 0.1.5](changes/083-the-hono-mcp-pin-moves-from-0-1-1-to-0-1-5.md) | SMD-1607 |
| 84 | [The MCP stack moves together](changes/084-the-mcp-stack-moves-together.md) | SMD-1643, SMD-1616 |
| 85 | [A live row an HNSW walk cannot reach is the geometry, not the vacuum](changes/085-a-live-row-an-hnsw-walk-cannot-reach.md) | SMD-1632 |
| 86 | [The read model, measured](changes/086-the-read-model-measured.md) | SMD-1696 |
| 87 | [The composed match, measured](changes/087-the-composed-match-measured.md) | SMD-1707 |
| 88 | [The knowledge-update slice was already reported and is the best one](changes/088-the-knowledge-update-slice-was-already-reported.md) | SMD-1720 |
| 89 | [GraphRAG as an expansion/rerank stage, measured on the *typed* graph and beyond recall](changes/089-graphrag-as-an-expansion-rerank-stage-measured.md) | SMD-1738 |
| 90 | [A capture that cites a returned id is logged as a use of it, and `eval-utilization.ts` reads the query log for the layer every other number here skips](changes/090-a-capture-that-cites-a-returned-id-is-logged.md) | SMD-1719 |
| 91 | [`match_thoughts` runs with `jit = off`](changes/091-match-thoughts-runs-with-jit-off.md) | SMD-1624 |
| 92 | [A NULL `created_at` is `null`, not the fabricated epoch, and a timestamp with no ISO form renders as its own text](changes/092-a-null-created-at-is-null-not-the-fabricated.md) | SMD-1328 |
| 93 | [The community schemas apply on plain Postgres](changes/093-the-community-schemas-apply-on-plain-postgres.md) | SMD-1796 |
| 94 | [`match_thoughts` pins the two planner paths its statements are built around](changes/094-match-thoughts-pins-the-two-planner-paths.md) | SMD-1677, SMD-1703 |
| 95 | [A thought cited as a source cannot be deleted from under the citation](changes/095-a-thought-cited-as-a-source-cannot-be-deleted.md) | SMD-1712 |
| 96 | [The two `created_at` mappers change 92 scoped out take the same rule](changes/096-the-two-created-at-mappers-change-92-scoped-out.md) | SMD-1803 |
| 97 | [The SQL store is the default](changes/097-the-sql-store-is-the-default.md) | SMD-1797 |
| 98 | [The cite shape is stated at the table](changes/098-the-cite-shape-is-stated-at-the-table.md) | SMD-1749 |
| 99 | [The stack publishes one port, on loopback](changes/099-the-stack-publishes-one-port-on-loopback.md) | SMD-1844 |
| 100 | [Two counted surfaces read one typed source instead of drifting by hand](changes/100-two-counted-surfaces-read-one-typed-source.md) | SMD-1805, SMD-1471 |
| 101 | [The chat calls can have an endpoint of their own](changes/101-the-chat-calls-can-have-an-endpoint-of-their.md) | SMD-1902 |
| 102 | [Every knob the server reads reaches the container](changes/102-every-knob-the-server-reads-reaches.md) | SMD-1843 |
| 103 | [Change 69's five servers name the key on 008's audit row](changes/103-change-69-s-five-servers-name-the-key-on-008.md) | SMD-1541 |
| 104 | [A version for the fork, reported by the brain, with a changelog beside the design record](changes/104-a-version-for-the-fork-reported-by-the-brain.md) | SMD-1804 |
| 105 | [The supersession judge has a model of its own](changes/105-the-supersession-judge-has-a-model-of-its-own.md) | SMD-1901 |
| 106 | [Two fork conventions become checks](changes/106-two-fork-conventions-become-checks.md) | SMD-1808 |
| 107 | [Nothing decided which content may leave the box for a model call](changes/107-nothing-decided-which-content-may-leave-the-box.md) | SMD-1903 |
| 108 | [FORK.md is the front door, and every change is one file](changes/108-fork-md-is-the-front-door-and-every-change.md) | SMD-1917 |
| 109 | [The stable brain is a derived view over the records, rebuilt by one tool](changes/109-the-stable-brain-is-a-derived-view-over.md) | SMD-1806 |
| 110 | [The workers, benches, suites and evals are type-checked](changes/110-the-workers-benches-suites-and-evals-are-type.md) | SMD-1932 |
| 111 | [The query log's column set: a filter that is finally written, the arm that served a query, and the tier that wrote it](changes/111-the-query-log-s-column-set-a-filter.md) | SMD-1490 |
| 112 | [The connector taxonomy](changes/112-the-connector-taxonomy.md) | SMD-1933 |
| 113 | [`thought_audit` becomes the log of record](changes/113-thought-audit-becomes-the-log-of-record.md) | SMD-1730 |
| 114 | [The scripts are TypeScript, type-checked where they run](changes/114-the-scripts-are-typescript-type-checked-where.md) | SMD-1870 |
| 115 | [The entity graph answers "what is central about X" from one command](changes/115-the-entity-graph-answers-what-is-central-about-x.md) | SMD-1938 |
| 116 | [A seekable prune index on the query log, and the awaited write measured and kept](changes/116-a-seekable-prune-index-on-the-query-log.md) | SMD-1492 |
| 117 | [Every thought in the dogfood brain labelled by kind](changes/117-every-thought-in-the-dogfood-brain-labelled.md) | SMD-1951 |
| 118 | [`main`'s ruleset becomes a file the tree holds to the workflow](changes/118-main-s-ruleset-becomes-a-file-the-tree-holds.md) | SMD-1856 |
| 119 | [The SQL-safety guard rail is a check](changes/119-the-sql-safety-guard-rail-is-a-check.md) | SMD-1936 |
| 120 | [A landing that changes the fork records itself, and the merge queue is built but refused](changes/120-a-landing-that-changes-the-fork-records-itself.md) | SMD-1857 |
| 121 | [Three shared modules for the tools beside the server](changes/121-three-shared-modules-for-the-tools-beside.md) | SMD-1985 |
| 122 | [The board reaches the brain by a sweep that runs itself](changes/122-the-board-reaches-the-brain-by-a-sweep-that-runs.md) | SMD-1954 |
| 123 | [A release publishes what it names](changes/123-a-release-publishes-what-it-names.md) | SMD-1860 |

Landed since the last release and numbered at the next one (SMD-1804): [SMD-1298](changes/smd-1298.md), [SMD-1809](changes/smd-1809.md), [SMD-1864](changes/smd-1864.md), [SMD-1989](changes/smd-1989.md).
<!-- changes-index:end -->

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
.github/metadata.schema.json     # fix 7   (3 additive optional fields); SMD-1933 adds `connectors`
.github/workflows/fork-checks.yml# fix 7   (new file)
scripts/check-fork-consistency.ts # fix 7 (new file)
scripts/mechanism-yield.ts       # SMD-1711 (new file — review-pass yield report, not a gate); window and attribution fixed SMD-1728
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
db/migrations/040_*.sql          # change 91 (new file — 039's match_thoughts with `SET jit = off`; a disabled planner path no longer JIT-compiles the gate's sample)
db/migrations/041_*.sql          # change 94 (new file — 040's match_thoughts with `enable_nestloop = on` and `enable_tidscan = on` pinned; an operator's setting no longer reaches the call's joins or the gate's probe)
db/migrations/042_*.sql          # change 95 (new file — thought_facets, the citation guard on thoughts, delete_thought(uuid, jsonb, boolean), record_citation)
db/migrations/043_*.sql          # change 98 (new file — query_log.tool's two shapes and the table's cite clause as COMMENTs, behind 031's guard; test-schema [42], test-upgrade [20]; [21] keeps test-support's reset lists honest)
evals/eval-quant.ts              # change 81 (new file — vector, halfvec and binary-with-rerank measured on real vectors at the shipped width; test-schema [38], test-upgrade [16])
<4 vendored MCP servers, 1 sample> # change 78 (a McpServer built per request — per session in the cost recipe's after sample — in place of one shared and connect()ed to a fresh transport each time)
<17 pin sites, 3 lockfiles>      # change 83 (@hono/mcp 0.1.1 → 0.1.5: the transport lets go of each POST it has answered; the after sample's sweep closes the transports it drops)
<19 pin sites, 3 lockfiles, 15 servers, 20 SDK importers> # change 84 (SDK 1.30.0, @hono/mcp 0.3.2, hono 4.13.8, zod 4.6.5 together; the Accept patches removed; an @ts-types pragma on every SDK import so Deno types it)
server-portable/tools.ts         # change 100 (new file — the typed source of the MCP tool surface: TOOLS as const, ToolName, visibleToolNames())
server-portable/tools.json       # change 100 (new file — GENERATED from tools.ts by scripts/gen-tools.ts; deploy/smoke.sh reads it)
scripts/gen-tools.ts             # change 100 (new file — writes tools.json from tools.ts; renderToolsJson() shared with the round-trip check)
<4 suites + deploy/smoke.sh>     # change 100 (test-server/-auth/-e2e-sql/-agents and smoke.sh read the manifest; test-server's tools/list is the live drift guard; test-auth's mutating list is typed ToolName[])
db/test-support.ts               # change 100 (createAssert gains total()/skipped()/docCheck — a doc check counted apart from the total it verifies)
db/test-schema.ts, db/test-live.ts # change 100 (each holds db/README.md's quoted assertion total to the run's own; test-live only on a full run)
scripts/check-fork-consistency.ts # change 100 (grant privileges per group [SMD-1471]; every migration documented once and the count checked; tools.json round-tripped against tools.ts [SMD-1805])
changes/                         # SMD-1917 (new dir — one file per change from 18 on: NNN-<slug>.md once numbered, smd-NNNN.md until the release step numbers it; a fixed shape and a 150-line cap)
scripts/fork-index.ts            # SMD-1917 (new file — renders FORK.md's index from changes/; check 15 round-trips it; the release step calls it)
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

**Two linters run on every PR (SMD-1808).** `commit-lint` holds each commit to the
house grammar (`[fork] … (SMD-NNNN)`, and `(caught: …)` on a review pass's finding
bullets) — `scripts/commitlint.config.ts`, which shares its tag parser with
`scripts/mechanism-yield.ts` through `scripts/commit-grammar.ts`, so the check
and the yield count cannot disagree. `workflow-lint` runs `actionlint` (pinned by
checksum) with `shellcheck` over this workflow's `run:` steps; the workflow now
sets `defaults.run.shell: bash`, so every step runs under `-eo pipefail` and a
masked `cmd | grep` failure is surfaced rather than swallowed. Both are opt-in
locally (`bun scripts/install-hooks.ts` for the commit hook), and both are
*required* on `main` with the other ten jobs since SMD-1856.

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
cd .. && bun scripts/check-fork-consistency.ts   # CI runs it too (change 58)

git tag -a upstream-pin-$(git rev-parse --short upstream/main) \
  -m "Upstream main @ $(git rev-parse upstream/main)"
```

Then update the pin table at the top of this file.

### Vendored content: audit once, hold the delta

Everything under `recipes/`, `integrations/`, `extensions/`, `skills/`,
`schemas/`, `dashboards/` and `primitives/` is upstream's community tree,
vendored wholesale at the pin, so we ship its worst advice with its best under
this repository's name. The rule (SMD-1251, change 51): **audit the tree once
and hold the delta** — a standing check carries each audit so a rebase cannot
quietly undo it. Four rules are held today, each in
`scripts/check-fork-consistency.ts` with counted, reasoned exceptions: shell
safety (check 6, change 51), core ownership (check 7, change 58), credential
compares (check 8, changes 64 and 67 — the exception list has been empty since
67) and writes around the functions that own a thought's content and vector
(check 10, changes 69 and 71). A rebase that brings a new hit fails CI, and the
choice is the one made at the pin: fix the vendored file and record the delta in
that change's file, or list the exception with its reason. Each rule's text and
its measurements are in the change file named.

### Landing a rebase on `main`, which is protected

`main` is the working default and carries a ruleset: every one of
`fork-checks.yml`'s twelve jobs required, on a head up to date with `main` and
satisfied only by a run of the Actions app; changes only through a pull request;
no deletion, **no force-push**, and no bypass actors — it applies to admins too.
The ruleset is a file, `.github/rulesets/main.json`, applied with
`gh api -X PUT repos/MHarris-SgyMd/OB1/rulesets/22189960 --input .github/rulesets/main.json`,
and `check-fork-consistency` check 20 holds the file to the workflow's job list,
so a job added without being required fails CI by name (SMD-1856). That is
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
gh pr merge --merge --auto        # lands itself once the twelve checks pass
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

Fixes 1–5 all live in `server/index.ts`. Fixes 6 and 7 are contributable in
principle; note that [issue #482](https://github.com/NateBJones-Projects/OB1/issues/482)
reports the upstream PR gate currently fails on **every** fork-originated PR.

---

## Review passes: what caught a finding is written at the catch

Measured 2026-09-18 with `bun scripts/mechanism-yield.ts` over the commit log
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

**Re-measure when ten tickets carry tags**: `bun scripts/mechanism-yield.ts
--since <first tagged commit>` — that commit and everything committed at or
after it, so a branch begun earlier contributes only what it committed in the
tagged era. That run was to decide SMD-1712, the citations facet that gives
`delete_thought` its `CITED` refusal; the gate was re-decided at three tagged
tickets under the epic's schedule caveat, the numbers are in change 95, and
the ten-ticket run now judges the epic's Phase 3 instead. The script is a
maintainer report, not a CI gate; it
prints its rules and a sample per class so the tallies can be judged before
anything is built on them. `--self-check` runs the parser's fixtures.

**The window and the attribution, corrected (SMD-1728, PR #80).** A
`--since YYYY-MM-DD` handed to the log was read as that day *at the current
time*, and the two paths cut on two clocks — committer time and author date,
which differ on 129 of the log's 1,351 commits — so a dump and a live run of one
window tallied differently. Both are one rule now: every row carries the
committer instant, and a `--since` day is resolved once to the instant it begins
in `--zone` (a Region/City name, default `America/Chicago`) and cut by instant
exactly as a `<sha>` anchor is. `ticketOf` took the first `SMD-nnnn` anywhere in
a subject and credited 13 of the 221 baseline passes to a ticket the subject
only mentioned; it reads the parenthetical the subject ends with first. The
baseline figures above are re-read under both rules from the same dump — 221
passes across **61** tickets, 511 findings in **31** — and the per-pass defect
shares are unchanged. The fixtures, the pass-number reading and the
dropped-bullet report are in that ticket's pass commits.

---

## The recurring defect in this fork: a value defined twice

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
`scripts/check-fork-consistency.ts` rather than by intent.

The pattern is consistent enough to be a rule: **a default that appears in two
files will be wrong in one of them, and the copy that goes stale is the one nobody
runs directly.** Everything provider-facing now resolves through `db/config.mjs`,
and `scripts/check-fork-consistency.ts` fails the build when compose, the
embedding model, the metadata model and the base URL stop agreeing.

The same rule applies to the suites. Three of them read a shipped default instead
of pinning their own, so changing the default broke tests that were testing
something else entirely — `test-e2e-sql` matched a provider by the literal string
`openrouter.ai`, `test-preflight` hardcoded `1536`, `test-embedding-dimensions`
keyed a stub off exact input text. A suite should pin what it does not test.

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
  reaching a host-native Ollama needs
  `OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1` — and nothing
  more: Ollama's loopback default is reachable through that name on podman
  machine (measured in change 99's fourth review pass; `OLLAMA_HOST=0.0.0.0`,
  which this bullet used to prescribe, put an unauthenticated model API on the
  LAN for nothing).
- **The 24 shim-migrated files are not individually tested.** Most need live
  credentials (Gmail, Slack, Readwise). The shim itself has 61 assertions against
  real Postgres, and CI checks every migrated file still parses and that the
  codemod round-trips byte-for-byte — but exercise the ones you actually run
  before trusting them.
- **Seven files still need a human.** Four use PostgREST resource embedding (a
  join), two use nested `.or()` grouping, and one is a type-only import. Run
  `bun scripts/migrate-to-sql-shim.ts` for the current list and the reason.
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
