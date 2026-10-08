# Vendored-content disposition table (SMD-1924)

The fork vendors ~33k lines of upstream community code across `integrations/`,
`recipes/`, `schemas/` and a few `docs/drafts/` SQL sketches. The standing posture is
**"audit once, hold the delta"** (SMD-1228 / SMD-1250 / SMD-1256): the tree is *kept* —
these are the repo's "open for contributions" categories — held to the core's standard
where it matters, with `scripts/check-fork-consistency.ts` as the standing guard.

This document runs that standard to completion: **one inventory, one disposition per
artifact.** For an arbitrary vendored file you can now say whether it is live,
superseded, hazardous, or dead.

## The three dispositions

- **keep + audited** — a legitimate standalone community artifact, held to the delta.
  This is the majority. "keep" is the verdict for anything that is a real community
  example *and* is not superseded-or-hazard-or-dead — **not** "integrated into core."
- **rebuild-ticket** — an un-absorbed capability worth having in core; the ticket that
  tracks the rebuild is linked. An artifact can be *both* keep+audited (the folder
  stays, held to the delta) and carry linked rebuild-tickets for its un-absorbed parts.
- **remove** — superseded by a fork rebuild, or a hazard, **with nothing depending on
  it**. A removal only lands as a PR that can state *"verified no references."*

Every external-touching artifact here — the SMD-1867 fold-in rows below, and the
sinks (the digests and briefings), which the sweep finds by their `metadata.json`
services and tags rather than by this table — is classified by the five-facet
connector taxonomy in [`docs/connector-taxonomy.md`](connector-taxonomy.md)
(SMD-1933); `check-fork-consistency` check 19 reads the fold-in rows from this
table as one of its coverage triggers.

Some capture-source integrations are additionally **folded into SMD-1867** (the
ingestion-adapter contract): they are kept, but re-scoped as adapters rather than
ad-hoc integrations.

## Project posture (2026-09-21): no upstream parity

**The fork does not maintain parity or API compatibility with upstream Open Brain.**
Breaking backwards compatibility is an accepted cost at this stage. Consequence for
this triage: *"preserves the upstream-faithful origin"* is **not** a keep reason. A
loose artifact whose capability is fully in a `db/` migration and whose only remaining
value is an upstream reference is **remove**, even if the guard tolerates it. A *live
in-tree* reference — a kept community integration/recipe that installs it, CI, the
fork's ROLE_GRANTS, a cross-schema dependency — is still a keep reason (those are fork
features, not upstream parity).

## Summary rollup

**87 artifacts** (17 integrations + 51 recipes + 16 schemas + 3 docs/drafts), each with
exactly one disposition.

- **keep + audited: 71** (78 until `brain-smoke-test` retired, SMD-2103; 77 until SMD-1931 retired `open-brain-rest` and `rest-api`, 75 until it retired `enhanced-mcp`, `delete-thought-mcp`, `update-thought-mcp` and `discord-capture`). Two of them — `edge-function-cost-optimization` and
  `local-brain-no-mcp` — are struck through as retired by SMD-1800 and stay in this count as
  they did before SMD-2126. The vendored tree is overwhelmingly legitimate community
  content with live in-tree references (CI parity tests, recipes, the fork's ROLE_GRANTS,
  cross-schema deps). The seed "remove" list did not survive the gate — every seed-remove
  integration/schema is load-bearing today (the SMD-1228/1524/1544/1798 audit wired them
  into CI + the shim after the seed was written).
- **remove: 16.**
  - `schemas/text-search-trgm` — index verbatim in migration 011; no fork-side dep.
  - `schemas/recency-boosted-match-thoughts` — `match_thoughts_recency` has zero callers; 020 folded recency into core `match_thoughts`.
  - `schemas/thought-work-claims` — comment-only stub; 015 owns the table.
  - `docs/drafts/agent-memory-branding-dna.md` — upstream personal-brand playbook.
  - `docs/drafts/agent-memory-staging-deploy-notes.md` — upstream staging notes (nuggets captured elsewhere).
  - `docs/drafts/discord-chunking-discussion.md` — resolved (proposals landed in 003/007/011).
  - `recipes/obsidian-vault-import` — `db/ingest-markdown.ts` is the fork's Obsidian import (SMD-2126 → SMD-2137).
  - `recipes/local-ollama-embeddings` — the fork embeds locally by default; `db/reembed.ts` for existing rows (SMD-2126 → SMD-2138).
  - `recipes/brain-smoke-test` — `deploy/smoke.sh` absorbed what applies to the fork; the rest needed PostgREST or a retiring gateway (SMD-2126 → SMD-2103).
  - `schemas/wiki-pages` — the page store is core, migration 064 (SMD-949 → SMD-1812).
  - `integrations/open-brain-rest` — the REST core serves what a client needs of it; each route's fate is in "The brain's outward surface" (SMD-1931).
  - `integrations/rest-api` — likewise (SMD-1931).
  - `integrations/enhanced-mcp` — its tools are core tools, or the entity-graph read the GUI files (SMD-2280), or smart-ingest's plugin (SMD-2690) (SMD-1931).
  - `integrations/delete-thought-mcp` — the core's `delete_thought` (SMD-1931).
  - `integrations/update-thought-mcp` — the core's `update_thought` (SMD-1931).
  - `integrations/discord-capture` — a README with no code (SMD-1931).
- **sub-file removal: 2.** `recipes/email-history-import/rollback-chunking-columns.sql`
  — undoes abandoned upstream PR #27 column-chunking; no-op on the fork; and
  `recipes/fingerprint-dedup-backfill/backfill-fingerprints.mjs` — migration 023 backfills the
  fingerprint server-side (SMD-2126 → SMD-2145).
- **PostgREST-speaking scripts (SMD-2126, decided 2026-09-24): 30 files in 21 recipes at the
  decision (28 in 19 after SMD-2137 and SMD-2138; 26 in 17 with SMD-2144's two on the shim; 23 in 16 with SMD-2139's three; 22 in 15 with SMD-2239's retirement; 21 in 14 with SMD-2103's)**, one fate each — an import onto the ingestion contract, a
  maintenance script onto the shim, the two smoke harnesses to their own tickets (`brain-smoke-test`
  retired into `deploy/smoke.sh`, SMD-2103), the three above
  retire (`obsidian-vault-import` and `local-ollama-embeddings` done, SMD-2137 and SMD-2138) — in
  the section below;
  check 24 holds the class.
- **fold-in SMD-1867 (capture-source adapters): 4 integrations** — `chrome-capture-extension`,
  `slack-capture`, `telegram-capture`, `readwise-capture` (`discord-capture` retired, SMD-1931). Plus **~11
  import recipes** flagged as candidate adapters (`chatgpt` / `email-history` / `gmail-smart-pull`
  / `google-activity` / `grok` / `instagram` / `journals-blogger` / ~~`obsidian`~~ (retired — SMD-2126 → SMD-2137) / `perplexity`
  / `readwise` / `x-twitter`).
- **rebuild-tickets linked (kept + tracked):** ~~`enhanced-mcp` → SMD-1525 + SMD-1798~~ (retired, SMD-1931);
  `schemas/typed-reasoning-edges` → SMD-1253; ~~`schemas/wiki-pages` → SMD-949~~ (rebuilt in core as migration 064 and retired, SMD-1812);
  `schemas/smart-ingest` → SMD-1253.
- **SMD-1798 portability (runtime supabase-js), kept:** `agent-memory-api`, ~~`enhanced-mcp`~~,
  ~~`open-brain-rest`~~, ~~`rest-api`~~ (the three retired, SMD-1931), `ob-graph`, `repo-learning-coach`, `schema-aware-routing`,
  `work-operating-model-activation`, `x-twitter-import` (`local-brain-no-mcp`, also listed
  here, was retired by SMD-1800 instead).
- **adjacent follow-up filed:** SMD-1929 (purge inherited NBJ brand/funnel assets under
  `dashboards/` + `docs/`, outside this triage's four directories).

**Guard follow-ups (SMD-1924 verify item — "a newly vendored file redefining a core object
fails CI"):**
1. `scripts/check-fork-consistency.ts` check 7 already covers **function** redefinitions
   (`upsert_thought` / `match_thoughts` / `update_updated_at`) since SMD-1250 — confirmed.
2. **Done** — check 5 now also fails a vendored `.sql` that does `DROP COLUMN` / `ALTER COLUMN`
   on core `thoughts` (rule `thoughts-column-mutation`, scoped to `schemas`/`recipes`/`integrations`
   `.sql`; a core migration may own the schema and a README example is prose, so both are out
   of scope). This is the class `email-history-import`'s rollback SQL slipped past. Mutant-tested.
3. **Done** — `recency-boosted-match-thoughts`'s now-dead `match_thoughts_recency` allowlist
   entry was removed with the folder in the removals PR.

**Consistency fixes surfaced by the audit (behaviour-neutral):**
1. **`schemas/smart-ingest` folder-name drift** — several refs say `schemas/smart-ingest-tables`
   (`integrations/smart-ingest`, `integrations/rest-api`, `recipes/brain-smoke-test`); the
   folder is `schemas/smart-ingest`. **Resolved** — the two integrations no longer carry it,
   and `brain-smoke-test`, where it was tangled with a stale "not yet on main" assertion,
   retired (SMD-2103); `git grep smart-ingest-tables` finds only this note and `changes/`.
2. **`recipes/content-fingerprint-dedup` stale paths** — `recipes/email-history-import`'s
   `pull-gmail.ts` pointed at `primitives/content-fingerprint-dedup`; **fixed** to `recipes/…`
   here. The `dashboards/ob1-canonical-landing` upstream GitHub URL is an SMD-1929 item
   (upstream branding/links), left for it.
3. **`schemas/workflow-status`** — **no fix needed.** `migration.sql` already uses
   `ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS …` on both columns (idempotent, re-runnable);
   the earlier "bare `ADD COLUMN` collision" note was a misread of the README example. The
   `workflow-status` row below is corrected.

## PostgREST-speaking scripts (decided 2026-09-24, SMD-2126)

Thirty scripts in twenty-one recipes reached the brain as PostgREST clients at the decision
(twenty-one in fourteen remain — `obsidian-vault-import`'s and `local-ollama-embeddings`'
retired, SMD-2137 and SMD-2138, `brain-backup`'s and `lint-sweep`'s on the shim, SMD-2144,
`thought-enrichment`'s three, SMD-2139, `weekly-digest`'s retired, SMD-2239, and
`brain-smoke-test`'s, SMD-2103, their rows kept as the record) —
`${SUPABASE_URL}/rest/v1/<table>` or `/rest/v1/rpc/<fn>` with a service-role `apikey`
from a `.mjs` / `.js` / `.ts` `fetch`, or supabase-py's `create_client` from a `.py` — and
none imports `compat/supabase-sql`. The fork's stack (SETUP.md) runs no PostgREST, so on
this fork not one of their live modes reaches a brain — and an import's `--dry-run` runs
because it never reaches the URL (readwise's excepted: it asks `thoughts` which highlights it
holds before its guard), where a maintenance script's reads the brain first and fails the same
way. SMD-1802 left their READMEs' data-path prose alone for one decision for the class
rather than twenty-one rewrites. This is that decision; the count is the survey of
`main` at f7693c4c, re-measured on d8e3de60 (`grep -rlE "rest/v1|from supabase import|create_client\(|SUPABASE_SERVICE_ROLE_KEY" recipes --include=*.mjs --include=*.js --include=*.py --include=*.ts`,
the ten files already on the shim set aside).

**Weighed.** (1) *Upstream-only* — mark the twenty-one and stop: cheapest, and the fork
loses every import recipe, the root README's "start importing your data" table. (2) *A
PostgREST profile* — `postgrest/postgrest` in `deploy/compose.yaml` behind a JWT secret so
the scripts run unchanged: one service and zero porting, but it brings back the surface
SMD-1795 retired (its title: "no Supabase account, PostgREST or Deno anywhere in the tree"), and every raw insert
SMD-1524 closed for the servers stays open for these scripts — five of them embed the text
themselves and POST content and vector as a row — no model label, no audit actor, three with
no fingerprint and two with one computed client-side, a copy of 003's rule that drifts with it
— and five more call `upsert_thought` over `/rest/v1/rpc/`, the right function over the wrong
transport. (SMD-1524's rule is for vendored code; the fork's own writers in `db/` — the
ingester below among them — insert rows themselves by design, with the same fingerprint
function and the audit actor set.) Declined. (3) *Port by kind* — taken, with (1)'s verdict for the three whose
capability the fork's core already owns.

**The kinds.** An **import** (a capture from an export) becomes an adapter of the ingestion
contract (`db/ingest-contract.ts`, SMD-1867): its parser emits `Ingested` items and
`bun db/ingest-records.ts --source items --items` (SMD-2136, the one new mechanism) writes them through the
pipeline — its own insert, not `upsert_thought`: 003's `content_fingerprint_of`, the
`ob1.actor` envelope for the audit, a deterministic id per item, `thought_sources`, 053's
links, the watermark, `reembed.ts` for the vector — so a Python parser stays Python and needs
no database client.
Not the REST gateway the ticket named as the `.py` target: `integrations/open-brain-rest`'s
`POST /capture` embeds at `openai/text-embedding-3-small` (1536), which the fork's default
brain (`qwen3-embedding:4b`, 1024) refuses, and a request per row is the wrong shape for a
ten-thousand-row import.

**Maintenance scripts.** A **maintenance script** (reads `thoughts`, writes metadata or a
sidecar table) moves onto `compat/supabase-sql` under `bun`, its brain URL variable a
`postgres://` string — `SUPABASE_URL` for most; `OPEN_BRAIN_URL` for entity-wiki,
typed-edge-classifier and wiki-synthesis; lint-sweep, weekly-digest and provenance-chains
read either — the shape SMD-1798 gave the servers; the REST idioms map one to one
(`Prefer: count=exact` → `{ count: "exact" }`, with `head: true` only where the request was
HEAD or `Range: 0-0` — a counted PATCH is the update's `.select()` and `data.length`;
`resolution=ignore-duplicates` → `upsert(…, { ignoreDuplicates })`; `/rpc/f` → `.rpc("f")`),
and a thought a script deletes goes through `.rpc("delete_thought", { p_id, p_actor })` — the
actor a JSON object naming the script; a `CITED` answer arrives as `data.ok === false`, not in
`error`, and each ticket says whether a cited row stays or `p_detach` goes. The key variable
(`SUPABASE_SERVICE_ROLE_KEY`, `OPEN_BRAIN_SERVICE_KEY`) is read and ignored by the shim, so a
script may stop requiring it. The first two ports landed with SMD-2144 — `brain-backup` and
`lint-sweep`, both read-only, driven in `db/test-live.ts` [26] against a real Postgres; the first
writers with SMD-2139 — `thought-enrichment`'s three backfills, `type`, `sensitivity_tier` and
metadata through `.update().eq()`, never content or vector, driven in [29]; `weekly-digest`,
the third read-only script at the decision, left the class: a sink posting thought text to Telegram,
it is now the `db/` verb `db/weekly-digest.ts` behind the egress gate — both the synthesis and the
Telegram send pass the gate — rather than a shim port (SMD-2239; the orchestration ADR's decision 9,
written for templates, read to cover a `bun` sink too).

**The entity tables.** Four scripts — atomizer's, authorship-edges', entity-wiki's,
typed-edge-classifier's — assume upstream's `schemas/entity-extraction` tables; on a fork
brain `thought_entities` is migration 016's (a uuid `entity_id` to `ob1_entities`, no
`mention_role`), so the schema's `CREATE TABLE IF NOT EXISTS` is a no-op there and a write of
`mention_role` fails with 42703 whatever the transport (change 093 recorded the shared name
for grants; the third review pass measured the write). Each port reads 016's shape and writes
mentions through the fork's `record_thought_entities`, or its ticket says why not;
`thought_edges` (`schemas/typed-reasoning-edges`) is its own name and applies.

**Smoke harnesses and retirements.** A **smoke harness** has its own ticket: `brain-smoke-test`
retired once `deploy/smoke.sh` took the one check of its that applied and that smoke.sh lacked
(SMD-2103); `ob-graph`'s is SMD-2146. A script whose
capability is **in core** retires: `obsidian-vault-import` (the Markdown adapter,
`ingest-records.ts --source markdown --markdown`, is the import; the recipe's heading split with LLM
distillation of long sections, its `--min-words` / `--skip-folders` / `--after` filters, its
secret scan, sync log and source label have no counterpart there and were dropped with it,
each named in SMD-2137, which removed the directory), `local-ollama-embeddings` (the server embeds locally through
`OB1_LLM_BASE_URL`; `reembed.ts`; removed in SMD-2138; two of its three models are rows of `SETUP.md`'s table, with the fork's numbers), `fingerprint-dedup-backfill/backfill-fingerprints.mjs`
(migration 023).

**Held by check 24** of `scripts/check-fork-consistency.ts`: in every code file under the
seven category directories and docs/, a `rest/v1` path in a string, a supabase-py import or
`create_client(`, or a `@supabase/postgrest-js` specifier is a hit, comments blanked; the
files below are counted per file in `POSTGREST_EXCEPTIONS` with the ticket that ports or
retires each, so a new call fails, a landed port fails until its entry goes, and the class
cannot grow back. `POSTGREST_EXCEPTIONS`'s size, plus the two scripts that reach the gateway
through a lib, is the class's remaining size; a retired row below stays as the record and counts
nothing.

| Recipe | Scripts (lines that speak PostgREST) | Touches | Fate | Ticket |
|---|---|---|---|---|
| `atomizer` | `audit-gmail-pipeline.mjs` (2), `lib/entity-resolver.mjs` (2), `re-atomize-gmail-thought.mjs` (2); `backfill-gmail-correspondents.mjs` through the lib | `thoughts`, `entities`, `thought_entities` (016's on a fork brain — above), `thought_edges` | port onto the shim; thought writes through `upsert_thought` / `delete_thought` | SMD-2140 |
| `authorship-edges` | `lib/author-edges.mjs` (2); `backfill-authorship.mjs` through the lib | `thoughts`, `entities`, `thought_entities` (016's on a fork brain — above) | port onto the shim | SMD-2141 |
| `brain-backup` | `backup-brain.mjs` (0; was 1) | `thoughts` and five optional companion tables (read) | on the shim since SMD-2144; read-only — `SUPABASE_URL` a `postgres://` string, the key ignored, a missing table 42P01; `pg_dump` named as the whole-brain backup | SMD-2144 |
| `brain-smoke-test` | `smoke-all.js` (gone) | `thoughts`, `graph_*`, `ingestion_jobs`, four RPCs | **retired**: `deploy/smoke.sh` absorbed what applied (check 1 refuses a wrong key in-protocol); the directory and its check 24 entry are gone | SMD-2103 ✅ |
| `chatgpt-conversation-import` | `import-chatgpt.py` (3) | `thoughts` (raw POST with a vector), `match_thoughts`, `chatgpt_conversations` | port onto the ingestion contract; SMD-2147 decides its `match_thoughts` dedup and `chatgpt_conversations` sidecar | SMD-2147 |
| `email-history-import` | `pull-gmail.ts` (2) | `thoughts` (raw POST with a vector) | port onto the ingestion contract | SMD-2021 |
| `entity-wiki` | `generate-wiki.mjs` (1) | `thoughts`, `entities`, `thought_entities` (016's on a fork brain — above), `edges`; `match_thoughts`, `upsert_thought` (reads `OPEN_BRAIN_URL`) | port onto the shim | SMD-2143 |
| `fingerprint-dedup-backfill` | `delete-duplicates.mjs` (1), `backfill-fingerprints.mjs` (1) | `thoughts` (PATCH, DELETE) | `delete-duplicates.mjs` onto the shim, its deletes through `delete_thought`; `backfill-fingerprints.mjs` removed (migration 023) | SMD-2145 |
| `google-activity-import` | `import-google-activity.mjs` (1) | `thoughts` (raw POST with a vector) | port onto the ingestion contract | SMD-2150 |
| `lint-sweep` | `lint-sweep.js` (0; was 1) | `thoughts`, `entities`, `edges`, `thought_entities` (read; either URL name; the seven `lint_*` views are psql's, the script reads none) | on the shim since SMD-2144; read-only — recency by `created_at` (uuid ids), `edges` by entity-extraction's columns | SMD-2144 |
| `local-ollama-embeddings` | `embed-local.py` (2) | `upsert_thought` over `/rest/v1/rpc/` | retired: the server embeds locally (`OB1_LLM_BASE_URL`), `db/reembed.ts` for existing rows; the directory, its two test-writes guards and its check 24 entry are gone | SMD-2138 |
| `ob-graph` | `smoke-graph-rpcs.mjs` (1); `index.ts` is on the shim since SMD-1798 | `graph_nodes`, `graph_edges`; `traverse_graph`, `find_shortest_path` | the smoke onto the shim or into `extensions/test-tools.ts` | SMD-2146 |
| `obsidian-vault-import` | `import-obsidian.py` (3) | `thoughts` (raw POST with a vector) | retired: `db/ingest-markdown.ts` is the fork's Obsidian import (`ingest-records.ts --source markdown --markdown`); the directory, its registry rows and its check 24 entry are gone | SMD-2137 |
| `perplexity-conversation-import` | `import-perplexity.py` (1) | `thoughts` (raw POST with a vector) | port onto the ingestion contract | SMD-2148 |
| `provenance-chains` | `backfill.mjs` (1), `eval.mjs` (1); `mcp-tools.ts` takes an injected client and test-writes drives it on the shim (SMD-1524) | `thoughts` (PATCH); `merge_thought_provenance_metadata` and `merge_thought_eval_metadata` (`schemas/provenance-chains`' functions) over `/rpc/`; `eval.mjs` writes metadata (reads either URL name) | port onto the shim | SMD-2142 |
| `readwise-import` | `import-readwise.py` (2, supabase-py) | `upsert_thought`, `readwise_books`, `thoughts` (UPDATE of two columns) | port onto the ingestion contract | SMD-2149 |
| `source-filtering` | `backfill-metadata.ts` (2) | `thoughts` (PATCH of metadata) | port onto the shim | SMD-2021 |
| `thought-enrichment` | `enrich-thoughts.mjs` (0; was 4), `backfill-type.mjs` (0; was 1), `backfill-sensitivity.mjs` (0; was 1) | `thoughts` (an update of metadata, `type`, `sensitivity_tier`) | on the shim since SMD-2139; the first writers — `SUPABASE_URL` a `postgres://` string, the key ignored, a refused write ends the run; a stopgap until SMD-1930's runner | SMD-2139 |
| `typed-edge-classifier` | `classify-edges.mjs` (1) | `thoughts`, `thought_entities` (016's on a fork brain — above), `thought_edges`; `thought_edges_upsert` (reads `OPEN_BRAIN_URL`) | port onto the shim | SMD-2141 |
| `weekly-digest` | `weekly-digest.mjs` (gone) | `thoughts` (read) → Telegram | **retired**: a sink, rebuilt as the `db/` verb `db/weekly-digest.ts` behind the egress gate (both the synthesis and the Telegram send pass it) — the `.mjs` is gone, the README is a pointer | SMD-2239 ✅ |
| `wiki-synthesis` | `scripts/synthesize-wiki.mjs` (1), `scripts/backfill-gmail-wikis.mjs` (1) | `synthesize-wiki.mjs` reads `thoughts` and writes files; `backfill-gmail-wikis.mjs` reads `thoughts` and `thought_edges`, captures through `upsert_thought` — a raw `POST /thoughts` when the function is absent — and DELETEs pages (both read `OPEN_BRAIN_URL`) | port onto the shim; page deletes through `delete_thought` | SMD-2143 |

## The brain's outward surface (decided 2026-10-08, SMD-1931)

Under [`docs/operator-surface-tiers.md`](operator-surface-tiers.md) the REST core is the
contract, and a contributed server either becomes a REST-core plugin (decision 9,
SMD-2308; the mechanism is SMD-2310) or retires. "A thin adapter" or "a client of the
REST core as its own server" is not an option. This section gives each surface-bearing
integration its disposition, and each route of the two REST gateways its fate against
the REST core's operations (`server-portable/rest/routes.ts`; the OpenAPI document at
`GET /openapi.json`). Neither gateway ran in any `deploy/` compose file; CI ran them
only inside the suites (`extensions/test-auth.ts` imported both and started each as
`bun <file>` on a free port, `extensions/test-writes.ts` imported both). Both are
retired: their directories and their rows in those suites went with SMD-1931's PR 3.

### Servers

| Integration | Disposition | Why |
|---|---|---|
| `open-brain-rest` | **retired** (SMD-1931) | Every route has a fate below. |
| `rest-api` | **retired** (SMD-1931) | Every route has a fate below. |
| `enhanced-mcp` | **retired** (SMD-1931) | Its search (semantic and text), list, get, update, capture and stats tools are core tools. `count_thoughts` is a count filtered on sidecar columns and dates, moved to SMD-2280 with `rest-api`'s `/count`; `ops_capture_status` reads `smart-ingest`'s jobs and goes with that plugin (SMD-2690); `ops_source_monitor` reads three `ops_source_*` views that no `.sql` in the tree defines (`recipes/brain-health-monitoring` has other `ops_*` views), so it is dropped; `graph_search`, `entity_detail` and `related_thoughts` are the entity-graph read the GUI files (SMD-2280). |
| `delete-thought-mcp` | **retired** (SMD-1931) | The core's `delete_thought` tool and `DELETE /v1/thoughts/{id}` call the `delete_thought` RPC (009, as 036, 042 and 060 replaced it), which answers a cited source with `REFUSED_CITED` and a detach option and records the key as the audit actor. This server's raw delete meets the same citation trigger as a plain error message, with no structured refusal and no detach, and audits with no actor. |
| `update-thought-mcp` | **retired** (SMD-1931) | The core's `update_thought` tool and `PATCH /v1/thoughts/{id}`. |
| `discord-capture` | **retired** (SMD-1931) | A README with no code. |
| `kubernetes-deployment` | **retire** (SMD-1931; removal SMD-2288) | No deployment target under compose-only (the ADR, "What this reverses or amends"). |
| `agent-memory-api` | **plugin** (SMD-2310, port SMD-2690) | Its own tables (`schemas/agent-memory`) and live clients (`hermes-agent-memory`, `openclaw-agent-memory`). |
| `smart-ingest` | **plugin** (SMD-2310, port SMD-2690) | Its own tables (`schemas/smart-ingest`); document atomization the core does not do. |
| `readwise-capture` | **plugin at `/hooks/readwise`** (SMD-2310, port SMD-2690) | An inbound webhook with its own cache (`schemas/readwise-books`). |
| `slack-capture`, `telegram-capture` | **plugin at `/hooks/<name>`** (SMD-2101) | Inbound webhooks; SMD-2101 already carries them. |
| `chrome-capture-extension` | **client of `/api`** (SMD-1931, done in its PR 3) | A browser client, not a server: `POST /v1/thoughts` with a capture key, `GET /v1/whoami` as its key check. |

`entity-extraction-worker` and `consolidation-workers` are workers, not surface; they
keep their rows below.

### `open-brain-rest` routes

| Route | Fate |
|---|---|
| `OPTIONS *` | **dropped** — the REST core sets no CORS. A browser page reaches it same-origin or through a server of its own; an extension's service worker needs only its host permission. |
| `GET /health` | **served** — `GET /health` (liveness, no key); `GET /v1/whoami` for a key check. |
| `GET /stats` | **served** — `GET /v1/stats`. `days` and `exclude_restricted` have no core field (`thought_stats` takes none). |
| `GET /thoughts` | **served** in part — `GET /v1/thoughts`. Offset paging and sort have no core field, and the `importance` / `quality_score` / `status` / `source_type` filters read sidecar columns: **moved to SMD-2280**, which decides what the GUI needs. |
| `GET /thought/:id` | **served** — `GET /v1/thoughts/{id}`. |
| `PUT /thought/:id` | **served** — `PATCH /v1/thoughts/{id}` (content, `metadata_patch`). The type / importance / quality / tier / status columns are sidecar: **moved to SMD-2280** with the list's filters. |
| `DELETE /thought/:id` | **served** — `DELETE /v1/thoughts/{id}`, now with the `REFUSED_CITED` answer, `detach_citations` and an audit actor. |
| `POST /capture` | **served** — `POST /v1/thoughts`; a capture key is now enough. Its sidecar fields (`type`, `source_type`, `importance`, `quality_score`, `sensitivity_tier`, `status`) are **moved to SMD-2280**. |
| `POST /search` | **served** — `POST /v1/search` (semantic) and `POST /v1/search/keyword` (text). |
| `GET /duplicates` | **dropped** — token-Jaccard over the newest 250 rows. The core has no near-duplicate detector: an exact re-capture merges at capture by fingerprint, `GET /v1/proposals` lists conflicting pairs only, and a duplicate is retired by hand with `PATCH /v1/thoughts/{id}` `supersedes`. |
| `GET /thought/:id/connections` | **moved to SMD-2280** — the entity-graph read (`get_thought_connections` is an `enhanced-thoughts` sidecar function). |
| `GET`, `POST /thought/:id/reflection` | **dropped** — no `reflections` table exists anywhere. |
| `GET /ingestion-jobs`, `GET /ingestion-jobs/:id`, `POST /ingestion-jobs/:id/execute` | **dropped** — stubs that answer nothing. |
| `POST /ingest` | **served** — one capture: `POST /v1/thoughts`. |

### `rest-api` routes

| Route | Fate |
|---|---|
| `OPTIONS *` | **dropped** — as `open-brain-rest`'s. |
| `/health`, `/healthz`, `/` | **served** — `GET /health`, `GET /v1/whoami`. |
| `POST /search` | **served** — `POST /v1/search`, `POST /v1/search/keyword`; `min_similarity` is the core's `threshold`. Its date bounds, `page` and `exclude_restricted` have no core field: **moved to SMD-2280**. |
| `POST /capture` | **served** — `POST /v1/thoughts`; the egress gate stands where its restricted-content refusal stood. The `type` and `topics` it put in metadata are keys the core reserves for its own extraction, and its `tags` array is not a scalar the core's metadata takes: **dropped**; `importance` / `quality_score` are sidecar: **moved to SMD-2280**. |
| `GET /recent` | **served** in part — `GET /v1/thoughts`. Its offset paging and `source` / `exclude_restricted` filters: **moved to SMD-2280**. |
| `GET /thoughts` | **served** in part — as `open-brain-rest`'s `GET /thoughts`. |
| `GET /count` | **served** for the total — `GET /v1/stats`; a filtered count is **moved to SMD-2280**. |
| `/stats` | **served** — `GET /v1/stats`; `days` and `exclude_restricted` have no core field (as `open-brain-rest`'s). |
| `GET`, `PUT`, `DELETE /thought/:id` | **served** — fetch, update and delete as above. Its tier escalation on update is sidecar: **moved to SMD-2280**. |
| `GET /thought/:id/connections` | **moved to SMD-2280** — the entity-graph read. |
| `PATCH /thought/:id/enrich` | **dropped** — a per-thought re-embed, re-classify and tier escalation. The nearest core operations work on pools: `POST /v1/workers/retry` requeues failed rows, and `POST /v1/workers/run` only previews (`dry_run`). |
| `POST /ingest`, `GET /ingestion-jobs`, `GET /ingestion-jobs/:id`, `POST /ingestion-jobs/:id/execute` | **moved to SMD-2690** — the `smart-ingest` plugin. |
| `GET /duplicates` | **dropped** — it calls `find_near_duplicates`, which no `.sql` in the tree defines. |
| `POST /duplicates/resolve` | **dropped** — a raw merge and delete. A duplicate is retired by hand with `PATCH /v1/thoughts/{id}` `supersedes`, then `DELETE /v1/thoughts/{id}` if it should go. |
| `GET /entities`, `GET /entities/:id` | **moved to SMD-2280** — the entity-graph read. They read the sidecar `entities` / `edges`, not migration 016's `ob1_entities`, and their integer ids never match a UUID. |

## How the "verified no references" gate is applied

An artifact is *referenced* — and therefore not removable — when something outside its
own folder depends on it: a code import, a CI parity test (`extensions/test-auth.ts`,
`extensions/test-writes.ts`), the fork guard (`scripts/check-fork-consistency.ts`),
`.github/workflows/fork-checks.yml`, `extensions/package.json` scripts, the SQL-shim
codemod (`scripts/migrate-to-sql-shim.ts`), a `README.md` capability index row, a docs
setup step, or another artifact wiring to it. Mentions in `FORK.md` / `CHANGELOG.md`
are the *audit record*, not a live dependency, and do not block a removal.

> **Finding — several ticket-seed "remove" verdicts are revised to keep + audited.**
> The seed list in SMD-1924 predates the SMD-1228 / SMD-1524 / SMD-1544 / SMD-1798
> audit that wired the vendored Edge-Function workers into the CI parity harness and
> the SQL shim. `entity-extraction-worker`, `consolidation-workers`, and
> `delete-thought-mcp` were all load-bearing then (CI drove them; recipes and a skill
> wired to them), so they failed the "verified no references" gate. (`delete-thought-mcp`
> retired with SMD-1931, its skill repointed at the core's `delete_thought`.) The fork's *own-runtime*
> rebuilds (`db/` migrations 009 / 016 / 029) run **beside** the vendored community
> Edge Functions; they do not make them dead. Details in each row below.

## Inventory

Scope: every artifact under `integrations/`, `recipes/`, `schemas/`, `docs/drafts/`,
excluding `_shared/` / `_template/` scaffolding and `README.md` indexes. 87 artifacts
(17 + 51 + 16 + 3).

### `integrations/` (17)

| Artifact | Disposition | Justification |
|---|---|---|
| `agent-memory-api` | keep + audited | Live runtime API: README index, `schemas/agent-memory` deploys from it, CI drives it (`test-auth.ts:189` rest, `test-writes.ts:384`); on the SQL-shim KEEP list. Portability follow-up SMD-1798. **SMD-1931 (2026-10-08): a REST-core plugin, port SMD-2690.** |
| `chrome-capture-extension` | keep + audited → fold-in **SMD-1867** | Client-side capture source (Claude / ChatGPT / Gemini → the REST core's `POST /v1/thoughts` at `/api`). A capture adapter under the SMD-1867 contract, not an ad-hoc integration. **SMD-1931 (2026-10-08): a client of `/api` — `POST /v1/thoughts` with a capture key.** |
| `consolidation-workers` | keep + audited *(revises seed "remove")* | Does bio-synthesis + metadata-normalization (LLM enrichment) — migration 029 / SMD-1294 is *supersession proposals*, a different capability, and does not supersede this. Load-bearing: CI `test-auth.ts:200-201` + `test-writes.ts` bio (SMD-1544), `test-auth.ts` imports and starts `metadata-norm` (the deno-check job went with SMD-1800), `package.json` `sync-auth`, on the shim. Fails "verified no references." |
| `delete-thought-mcp` | ~~keep + audited *(revises seed "remove")*~~ → **retired (SMD-1931)** | Was a standalone single-tool server around a raw delete. The core's `delete_thought` (MCP tool and `DELETE /v1/thoughts/{id}`) records the key as the audit actor and answers a cited source with `REFUSED_CITED` and a detach option. `skills/deleting-thoughts` now names the core connector, and its `extensions/test-auth.ts` row went with it. |
| `discord-capture` | ~~keep + audited~~ → **retired (SMD-1931)** | Was a capture-source README with no code. A Discord source, if one is built, is a REST-core plugin at `/hooks/discord` (SMD-2310). |
| `enhanced-mcp` | ~~keep + audited + rebuild-tickets~~ → **retired (SMD-1931)** | Was a thirteen-tool MCP server on its own single key. Its search, list, get, update, capture and stats tools are core tools; its graph tools are the entity-graph read the GUI files (SMD-2280); `ops_capture_status` goes with smart-ingest's plugin (SMD-2690); `count_thoughts` and `ops_source_monitor` are dropped ("The brain's outward surface" above). Its `extensions/test-auth.ts` and `extensions/test-writes.ts` rows went with it. |
| `entity-extraction-worker` | keep + audited *(revises seed "remove")* | `db/extract-entities.ts` (migration 016 / SMD-947) is the fork's *own-runtime* rebuild; the vendored Edge Function is the community queue-processor still wired to `smart-ingest` (triggers it by URL), `schemas/entity-extraction`, recipes `entity-wiki` / `wiki-compiler` / `brain-health-monitoring` / `typed-edge-classifier`, and CI `test-auth.ts:199`. Fails "verified no references." |
| `hermes-agent-memory` | keep + audited | Standalone Python `MemoryProvider` plugin depending on the kept `agent-memory-api`. Not superseded / hazard / dead. |
| `kubernetes-deployment` | keep + audited | Self-hosted K8s + own Postgres deployment path. Raw INSERTs audited under SMD-1524; guard owns `k8s/init.sql` / `openbrain.yml` / `index.ts` (OWN_DATABASE); CI `test-auth.ts:188` + the deploy-stack job's image build (on Bun since SMD-1800; the deno-check job went with it). **SMD-1931 (2026-10-08): retire; removal SMD-2288.** |
| `open-brain-rest` | ~~keep + audited~~ → **retired (SMD-1931)** | Was the REST gateway for the Next dashboards' surfaces, which `chrome-capture-extension` POSTed to. Every route's fate is in "The brain's outward surface" above; the extension now calls the REST core. Its `extensions/test-auth.ts` and `extensions/test-writes.ts` rows went with it. |
| `openclaw-agent-memory` | keep + audited | OpenClaw plugin/publishing package depending on the kept `agent-memory-api` + `schemas/agent-memory`. Live: README index, docs, `.gitignore` (`dist/`), CLAW_HUB publishing. Distinct from the `recipes/openclaw-agent-memory` setup recipe. |
| `readwise-capture` | keep + audited → fold-in **SMD-1867** | Readwise-highlight webhook capture source. `schemas/readwise-books` is its companion cache; CI `test-auth.ts:205` (webhook) + `test-writes.ts:512` (SMD-1524). Capture adapter under SMD-1867. **SMD-1931 (2026-10-08): a REST-core plugin at `/hooks/readwise`, port SMD-2690.** |
| `rest-api` | ~~keep + audited~~ → **retired (SMD-1931)** | Was the general REST gateway (CORS, CRUD, an `/ingest` proxy to `smart-ingest`, entity endpoints). Every route's fate is in "The brain's outward surface" above. Its `extensions/test-auth.ts` and `extensions/test-writes.ts` rows went with it. |
| `slack-capture` | keep + audited → fold-in **SMD-1867** | Slack quick-capture source. Live: README index, `docs/01-getting-started` step, CI. Capture adapter under SMD-1867. **SMD-1931 (2026-10-08): a REST-core plugin at `/hooks/slack` (SMD-2101).** |
| `smart-ingest` | keep + audited | LLM document-extraction/atomization pipeline; companion worker to `schemas/smart-ingest`. Live: CI `test-auth.ts:622` (`rest-api`'s `/ingest` proxy to it retired with SMD-1931), `entity-extraction-worker` helper routes oversized content to it. (Schema's rebuild is tracked under SMD-1253.) **SMD-1931 (2026-10-08): a REST-core plugin, port SMD-2690.** |
| `telegram-capture` | keep + audited → fold-in **SMD-1867** | Telegram quick-capture source; its README is a CI-driven write sample (`extensions/test-writes.ts`, its telegram-capture spellings) and a guard fixture (one of check 10's `THOUGHT_WRITE_PROBES` in `scripts/check-fork-consistency.ts`). Capture adapter under SMD-1867. **SMD-1931 (2026-10-08): a REST-core plugin at `/hooks/telegram` (SMD-2101).** |
| `update-thought-mcp` | ~~keep + audited *(revises seed "remove")*~~ → **retired (SMD-1931)** | Was a standalone single-tool server. The core's `update_thought` (MCP tool and `PATCH /v1/thoughts/{id}`) does what it did. `skills/updating-thoughts` now names the core connector, and its `extensions/test-auth.ts` and `extensions/test-writes.ts` rows went with it. |

### `schemas/` (16)

| Artifact | Disposition | Justification |
|---|---|---|
| `agent-memory` | keep + audited | Governed-memory **sidecar** tables (memory records, provenance, use-policy, review, recall traces, audit) — all in their own names, core `thoughts` untouched (not a hazard); no `db/` migration replicates them (not superseded). Depended on by `agent-memory-api` / `hermes-agent-memory` / `openclaw-agent-memory` and CI `test-writes.ts` SIDECARS. |
| `brain-stats-daily` | keep + audited | Dashboard daily-bucket heatmap RPCs (`brain_stats_daily*`), own functions only, core untouched. Distinct from migration 024 (`thought_stats_summary`, a single summary) — not superseded. Standalone dashboard schema; unreferenced ≠ dead (dashboards are an open category). |
| `crm-person-tiers` | keep + audited | Own `crm_persons` / `crm_person_mentions` tables + tiers RPC, core untouched (not a hazard). Wired into the fork's own `db/config.mjs` ROLE_GRANTS and `db/README` grants; optional companion to the `gmail-smart-pull` recipe. |
| `enhanced-thoughts` | keep + audited *(revises seed "remove/fence hazard")* | The SMD-1250 `upsert_thought` clobber is **gone from the current file** (only additive `ALTER … ADD COLUMN` + non-core functions `search_thoughts_text` / `brain_stats_aggregate` / `get_thought_connections`), and check 7 of the guard now blocks its return. Load-bearing: CI `test-writes.ts` SIDECARS applies it, and `entity-extraction-worker` / `consolidation-workers` reference its columns (`enhanced-mcp` and `rest-api` did until SMD-1931). Residual is a documented *deployment* grant caveat (anon + SECURITY DEFINER), not a file hazard. |
| `entity-extraction` | keep + audited *(revises seed "remove")* | Community `public.entities` / `edges` / `thought_entities` / queue (distinct from the fork's `ob1_*` in migration 016 — they coexist). Required by `schemas/typed-reasoning-edges` (errors without it), used by the vendored worker, `recipes/brain-health-monitoring` ops-views, and CI `test-writes.ts` (reads `consolidation_log`). Fails "verified no references." |
| `per-agent-identity` | keep + audited *(revises seed "remove")* | Community `openbrain_agents` / `agent_memory_keys` + `lookup_agent_memory_key` — granted by the fork's own `db/config.mjs` ROLE_GRANTS (SMD-1226). Migration 010 is "Ported from schemas/per-agent-identity" with departures (ob1_* names); the community file is the upstream-faithful origin, held to the delta. |
| `provenance-chains` | keep + audited *(revises seed "remove")* | Additive derivation columns + own merge functions (granted by `db/config.mjs`); `recipes/provenance-chains` + `typed-edge-classifier` read it. Guard check 7 (line 554) already fences its function set. Distinct from core's 025/026/032 provenance. |
| `readwise-books` | keep + audited | Own `readwise_books` cache + RPCs; granted by `db/config.mjs`; companion to `integrations/readwise-capture` + `recipes/readwise-import`; CI `test-writes.ts` SIDECARS. Not superseded, not a hazard. |
| `recency-boosted-match-thoughts` | **remove** *(no-parity posture)* | Standalone `match_thoughts_recency` with **zero callers** in the fork; migration 020 folded recency into core `match_thoughts` + `recency_score()` instead (`db/README`: "upstream … for the formula"). Guard-allowlisted (not a clobber) but valueless to the fork. Removal PR: delete the folder **and** the now-dead allowlist entry `scripts/check-fork-consistency.ts` once carried for it. |
| `smart-ingest` | keep + audited | Own `ingestion_jobs` / `ingestion_items` + `append_thought_evidence` (granted by `db/config.mjs`); companion to `integrations/smart-ingest`; `brain-health-monitoring` references it (`enhanced-mcp` and `rest-api` did until SMD-1931). *(The `schemas/smart-ingest-tables` folder-name drift is resolved; see "Consistency fixes" above.)* Rebuild tracked under SMD-1253. |
| `text-search-trgm` | **remove** *(no-parity posture)* | Pure `idx_thoughts_content_trgm` GIN index promoted **verbatim** into core by migration 011 (SMD-925; on by default — `test-schema.ts:250`). Its purpose (accelerate `enhanced-thoughts`' `search_thoughts_text` ILIKE fallback) targets a function the fork replaced with `search_thoughts_keyword` (012). Only ref is an `enhanced-thoughts` doc comment. No fork-side value. Removal PR: delete the folder (no guard allowlist entry to clean). |
| `thought-audit` | keep + audited *(revises seed "remove")* | Own `thought_audit` table (granted by `db/config.mjs`, with the `thought_provenance` view); was referenced by `delete-thought-mcp` / `update-thought-mcp` until SMD-1931 retired them. Migration 008 is "Ported from schemas/thought-audit" with departures; community origin held to the delta. |
| `thought-work-claims` | **remove** *(no-parity posture)* | Already a **comment-only stub** — all upstream DDL was stripped under SMD-1250 (it would have clobbered 015's `release_thought` / `release_claims_for_worker`). Migration 015 owns the real `thought_work_claims` (evals + `db/config.mjs` grants use it). The stub's only content is upstream documentation. Removal PR: delete the folder; guard check 7 still fences the function names regardless. |
| `typed-reasoning-edges` | keep + audited + rebuild-ticket **SMD-1253** | Own `thought_edges` table + upsert RPC (granted by `db/config.mjs`); required by `recipes/typed-edge-classifier` (matches its CHECK constraint). Requires `entity-extraction`. Not rebuilt in core; rebuild tracked under SMD-1253. |
| `wiki-pages` | ~~keep + audited + rebuild-ticket SMD-949~~ → **retired (SMD-1812)** *(no-parity posture; rebuilt in core)* | Was upstream's `wiki_pages` / `wiki_sections` / `wiki_section_revisions` + three RPCs. Migration 064 is the fork's page store — `pages` (a page is a thought: its id, its render as the content), `page_sections`, `page_section_revisions`, `write_page_section`'s regen guard, lineage rows for generated sections — under names of its own, so a brain that applied the file by hand keeps its tables untouched. Directory removed, README index row → core, community grant rows out (`pages` group instead). The wiki recipes' pages belong there (SMD-2143). |
| `workflow-status` | keep + audited | Minimal "add `status` / `status_updated_at` + `idx_thoughts_status`" migration; `migration.sql` uses `ADD COLUMN IF NOT EXISTS` on both columns (idempotent, re-runnable — no install-order collision with `enhanced-thoughts`). Live consumers: `dashboards/open-brain-dashboard-next` (Workflow board requires the columns) and `open-brain-rest`. Distinct from the heavier `enhanced-thoughts`. |

### `docs/drafts/` (3)

The ticket's flagged `docs/drafts/*upsert*.sql` **hazard does not exist** in the current
tree (`find docs -iname '*upsert*.sql'` → nothing) — already remediated. The three
remaining drafts are unreferenced markdown working-notes.

| Artifact | Disposition | Justification |
|---|---|---|
| `agent-memory-branding-dna.md` | **remove** | Upstream (NBJ) product-identity guidance for "NBJ OB1 Agent Memory." Zero references; no fork value under the fork's own-identity / no-parity posture. The sibling brand *assets* it prescribes (`docs/assets/agent-memory/brand/`, `dashboards/.../public/brand/`) are covered by follow-up **SMD-1929**. |
| `agent-memory-staging-deploy-notes.md` | **remove** | Upstream launch/staging notes (references `NAT-833`, "Jonathan's personal OB1 database"); explicitly transitional ("use it to update the public guides"). Zero references. *Before deleting: confirm the operational nuggets (Hono `/agent-memory-api/*` path normalization) are captured in `integrations/agent-memory-api/README`; fold if not.* |
| `discord-chunking-discussion.md` | **remove** | Resolved design discussion — all three proposals landed in core (chunking → 007, fingerprint → 003, full-text → 011). Historical; zero references. |

### `recipes/` (51)

| Artifact | Disposition | Justification |
|---|---|---|
| `adaptive-capture-classification` | keep + audited | Standalone capture confidence-gating + learning-loop recipe (own learning tables); not superseded, not a hazard. |
| `atomizer` | keep + audited → **SMD-2126**: port onto the shim (SMD-2140) | Standalone LLM compound→atomic splitter + Gmail re-atomization tooling; writes through the core capture path. |
| `authorship-edges` | keep + audited → **SMD-2126**: port onto the shim (SMD-2141) | Standalone speaker-attribution recipe writing `thought_entities` author edges (no LLM, no hardcoded ids); consumes existing entity tables. |
| `auto-capture` | keep + audited | Workflow-guidance recipe paired with the reusable auto-capture skill. |
| `brain-backup` | keep + audited → **on the shim (SMD-2144)** | Standalone export-to-JSON backup utility (`backup-brain.mjs`), read-only; its README names `pg_dump` as the whole-brain backup. |
| `brain-health-monitoring` | keep + audited | Ops SQL views + runbook (`ops-views.sql`, no core clobber); optionally reads the kept `entity-extraction` / `smart-ingest` tables. |
| `brain-smoke-test` | ~~keep + audited → **SMD-2126**: SMD-2103~~ → **retired (SMD-2103)** *(no-parity posture; SMD-2126 → SMD-2103)* | Was the fresh-install smoke harness (`smoke-all.js`), seven categories against a Supabase project. Three needed what the fork lacks: PostgREST and a service-role key for DB Schema and Access Key Enforcement, an anon key for Row-Level Security. REST API pointed at `open-brain-rest`, since retired (SMD-1931). The rest was covered already: `deploy/smoke.sh` checks 5–6 for MCP Server; the server's start gate, `server-portable/preflight.ts`, for the schema; the suites for capture, since smoke.sh is read-only; `server-portable/test-auth.ts` for `?key=`. The one Auth check it lacked, a wrong key refused in-protocol, is now smoke.sh's check 1, which also reads the body for -32001 instead of trusting the 200. |
| `bring-your-own-context` | keep + audited | Portable context workflow (extraction prompts + Work Operating Model flow + remote MCP deploy). |
| `chatgpt-conversation-import` | keep + audited → SMD-1867 candidate → **SMD-2126**: port onto the ingestion contract (SMD-2147, after SMD-2136) | ChatGPT-export import recipe (`chatgpt_parser.py` + `schema.sql`, no core clobber); an ingestion source — candidate SMD-1867 adapter alongside the capture integrations. |
| `claudeception` | keep + audited | Skills-that-create-skills continuous-learning recipe; searches/captures via the core MCP path. |
| `content-fingerprint-dedup` | keep + audited | The `upsert_thought` redefinition is a **README code example**, annotated "do not paste — migration 003/005 own it (SMD-1250)"; guard check 7 allowlists it (lines 646/1406). It is the fork's canonical dedup-convention doc, cited by `email-history-import` / `edge-function-cost-optimization` / `gmail-smart-pull` / `lint-sweep`. *(Minor: some cross-refs point at `primitives/content-fingerprint-dedup` / an upstream GitHub URL — stale paths to fix; overlaps SMD-1929.)* |
| `daily-digest` | keep + audited | Gmail-draft daily summary via Claude Code scheduled tasks + core MCP; zero infra. |
| `edge-function-cost-optimization` | ~~keep + audited~~ → **retired (SMD-1800)** | Was an MCP-consolidation/caching recipe about Edge Function invocation billing on Supabase; its measurements were that meter's, which this fork's containers have no analogue of, and its per-session sample's shape (changes 78, 83) lives in those changes' records. Its `examples/_shared/auth.ts` left the `sync-auth` list. |
| `editorial-policy` | keep + audited | 40-rule synthesis constitution + weekly drift auditor; `auditor/index.ts` is CI-driven (`test-writes.ts` DRIVEN_1524, SMD-1524). No core clobber. |
| `email-history-import` | keep + audited *(drop one sub-file)* → SMD-1867 candidate → **SMD-2126**: port onto the ingestion contract (SMD-2021, after SMD-2136) | Gmail-history import (an SMD-1867 candidate). **Sub-file removal:** `rollback-chunking-columns.sql` undoes the abandoned upstream PR #27 column-chunking (`parent_id`/`chunk_index`/`full_text` + `insert_thought` RPC) the fork never adopted (it uses `thought_chunks` / migration 007) — a no-op on the fork, dead upstream cruft. It is also an **unguarded `DROP COLUMN` on core `thoughts`** (guard check 5 only guards `ADD COLUMN`) → also a guard-rule candidate for the SMD-1924 verify step. |
| `entity-wiki` | keep + audited → **SMD-2126**: port onto the shim (SMD-2143) | Per-entity markdown wiki generator; reads the kept `entity-extraction` tables + worker. |
| `fingerprint-dedup-backfill` | keep + audited → **SMD-2126**: `delete-duplicates.mjs` onto the shim, `backfill-fingerprints.mjs` removed (SMD-2145) | Client-side fingerprint backfill **+ duplicate cleanup**. Migration 023 backfills server-side, but the recipe's `delete-duplicates.mjs` removes pre-existing dupes (a migration doesn't), and it's cited as the cleanup step by `lint-sweep` / `edge-function-cost-optimization` / `content-fingerprint-dedup`. Complements core, not superseded. **SMD-2126:** migration 023 backfills the fingerprint server-side, so `backfill-fingerprints.mjs` has no work left here and goes (SMD-2145); the duplicate cleanup stays and moves onto the shim, its deletes through `delete_thought`. |
| `gmail-smart-pull` | keep + audited → SMD-1867 candidate | Gmail → ingest-pack with sensitivity routing + atomization + contact tiers; own SQL (`merge_thought_metadata`, `entities_canonical_email`, no core clobber). SMD-1867 candidate. |
| `google-activity-import` | keep + audited → SMD-1867 candidate → **SMD-2126**: port onto the ingestion contract (SMD-2150, after SMD-2136) | Google Takeout (Search/Gmail/Maps/YouTube/Chrome/Gemini) import. SMD-1867 candidate. |
| `grok-export-import` | keep + audited → SMD-1867 candidate | xAI Grok conversation-export import. SMD-1867 candidate. |
| `infographic-generator` | keep + audited | Output generator (thoughts/research → infographic images via Gemini); not an import. |
| `instagram-import` | keep + audited → SMD-1867 candidate | Instagram export (DMs/comments/captions) import. SMD-1867 candidate. |
| `journals-blogger-import` | keep + audited → SMD-1867 candidate | Blogger Atom-XML import. SMD-1867 candidate. |
| `life-engine` | keep + audited | Background `/loop` personal-assistant recipe; own `schema.sql` (no core clobber). |
| `life-engine-video` | keep + audited | Remotion + ElevenLabs video-briefing add-on for `life-engine`. |
| `lint-sweep` | keep + audited → **on the shim (SMD-2144)** | Read-only three-tier quality audit (`views.sql` + `lint-sweep.js`); never mutates thoughts. Tier 1 needs `schemas/enhanced-thoughts`' columns. |
| `live-retrieval` | keep + audited | Read-side "flywheel" workflow that surfaces thoughts on topic shifts. |
| `local-brain-no-mcp` | ~~keep + audited *(own-database)*~~ → **retired (SMD-1800)** | Was a self-hosted LAN Supabase stack with three Edge Functions for curl-only capture/search/list where MCP is blocked. The fork's stack (`SETUP.md`) already runs without a cloud, and `integrations/open-brain-rest` is the HTTP surface without MCP; the companion `skills/ob1-local-http` now calls it. Its check 7/10/11/22 exceptions went with it. |
| `local-ollama-embeddings` | ~~keep + audited~~ → **retired (SMD-2138)** *(no-parity posture; SMD-2126 → SMD-2138)* | Was the capture-without-a-cloud-key recipe. The `ALTER COLUMN embedding TYPE` was a README example explicitly annotated "not altered by hand on this fork — build at `db/config.mjs`'s width; `upsert_thought` refuses another width."; the example was CI-held (`test-writes.ts`, SMD-1524; its two guards went with it). **SMD-2126:** the fork embeds locally by default (`OB1_LLM_BASE_URL`, `deploy/compose.yaml --profile local-models`) and `db/reembed.ts` re-embeds existing rows, so the recipe's capability is core and its only transport is one the stack lacks; it retired in SMD-2138 (test-writes' two text assertions on it went with it; the two models it named that `SETUP.md`'s table lacked are rows there — mxbai with the fork's own 0.882 MRR, gte-qwen2 unmeasured here). |
| `ob-graph` | keep + audited + SMD-1798 → **SMD-2126**: `smoke-graph-rpcs.mjs` onto the shim or into test-tools (SMD-2146) | Knowledge-graph layer (own nodes/edges tables + recursive-CTE traversal + MCP server); no core clobber. `index.ts` uses supabase-js at runtime → SMD-1798 portability. |
| `obsidian-vault-import` | ~~keep + audited, an SMD-1867 candidate~~ → **retired (SMD-2137)** *(no-parity posture; SMD-2126 → SMD-2137)* | Was the Obsidian-vault import, an SMD-1867 candidate. **SMD-2126:** the Markdown adapter of the ingestion contract (`db/ingest-markdown.ts`, SMD-1867 — frontmatter, `[[wikilinks]]` and tags as facets and edges, the file kept byte for byte) is the fork's Obsidian import, so the recipe retired in SMD-2137 (the directory is gone); its heading split with LLM distillation, `--min-words` / `--skip-folders` / `--after` filters, secret scan, sync log and source label have no counterpart in the adapter and were dropped with it, each named there — the filters, the label, an mtime date and a pre-allowlist vault scan noted on SMD-1814 as the connector's; the root README row points at the adapter and the registry rows went (the `obsidian` vendor returns with SMD-1814's capability). |
| `openclaw-agent-memory` | keep + audited | Canonical OpenClaw × OB1 Agent Memory workflow recipe (depends on the kept `agent-memory-api`). Distinct from the `integrations/openclaw-agent-memory` plugin. |
| `openclaw-code-review-memory` | keep + audited | OpenClaw code-review-agent memory workflow over Agent Memory. |
| `openclaw-taskflow-work-log` | keep + audited | OpenClaw TaskFlow handoff-log workflow over Agent Memory. |
| `panning-for-gold` | keep + audited | Flagship three-phase brain-dump mining workflow (paired with the skill pack). |
| `perplexity-conversation-import` | keep + audited → SMD-1867 candidate → **SMD-2126**: port onto the ingestion contract (SMD-2148, after SMD-2136) | Perplexity `.xlsx` export import. SMD-1867 candidate. |
| `provenance-chains` | keep + audited → **SMD-2126**: port onto the shim (SMD-2142) | Backfill + nightly evaluator + MCP tool handlers over the kept `schemas/provenance-chains`; answers "why do I believe X / what uses this." SMD-1253 lineage. |
| `readwise-import` | keep + audited → SMD-1867 candidate → **SMD-2126**: port onto the ingestion contract (SMD-2149, after SMD-2136) | One-shot Readwise history backfill; pairs with `integrations/readwise-capture`. SMD-1867 candidate. |
| `repo-learning-coach` | keep + audited + SMD-1798 | Local learning app with its own Supabase tables (`schema.sql`) + durable captures; `server/supabase.ts` uses supabase-js → SMD-1798; `server/brain.ts` is CI-driven. |
| `research-to-decision-workflow` | keep + audited | Workflow composing canonical OB1 skills into decision pipelines. |
| `schema-aware-routing` | keep + audited *(own-project)* + SMD-1798 | Metadata-routing pattern that creates **its own five tables in its own project** (README-annotated; guard check 10 counted exception; CI BYPASS_1524, SMD-1524). Its `alter column embedding` / raw inserts target its own `thoughts`, not core. README uses supabase-js → SMD-1798. |
| `source-filtering` | keep + audited → **SMD-2126**: port onto the shim (SMD-2021) | Source-tag filtering + metadata backfill for early imports. |
| `thought-enrichment` | keep + audited → **on the shim (SMD-2139)** | Retroactive LLM classification + sensitivity backfills; `type`, `sensitivity_tier` and metadata through the shim, never content or vector; SMD-1930 re-expresses them as transforms. |
| `typed-edge-classifier` | keep + audited → **SMD-2126**: port onto the shim (SMD-2141) | Opus/Haiku classifier populating the kept `thought_edges` (`typed-reasoning-edges`); SMD-1253 lineage. |
| `vercel-neon-telegram` | keep + audited *(own-database)* | Alternative Vercel + Neon + Telegram stack building **its own Neon brain** (guard OWN_DATABASE line 1409; `sql/001`/`002` owned as NEON). Its `match_thoughts` is its own install, not a clobber. Uses the Vercel AI SDK (no supabase-js). |
| `weekly-digest` | keep (pointer) → **SMD-2126 → SMD-2239 done**: retired for the `db/` verb | Scheduled importance-ranked digest to Telegram — a sink, so brain content leaves only through the egress gate. Rebuilt as `db/weekly-digest.ts` (the synthesis and the Telegram send are each gated); the `weekly-digest.mjs` script is gone and the recipe README points at the verb. |
| `wiki-compiler` | keep + audited | Orchestrates graph extraction + typed edges + entity/topic synthesis into scheduled wiki refreshes; wires the kept entity worker + edge tables. |
| `wiki-synthesis` | keep + audited → **SMD-2126**: port onto the shim (SMD-2143) | Topic/email-thread wiki synthesis from atomic thoughts via any OpenAI-compatible LLM. |
| `work-operating-model-activation` | keep + audited + SMD-1798 | Operating-model elicitation workflow; own `schema.sql`; `index.ts` uses supabase-js → SMD-1798. |
| `world-model-diagnostic-activation` | keep + audited | World-Model Readiness Diagnostic activation; own tables (`world_model_assessments` / `world_model_boundary_flows`), no core clobber. |
| `x-twitter-import` | keep + audited → SMD-1867 candidate | X/Twitter export (tweets/DMs/Grok) import. SMD-1867 candidate; `import-x-twitter.mjs` uses supabase-js → SMD-1798. |
