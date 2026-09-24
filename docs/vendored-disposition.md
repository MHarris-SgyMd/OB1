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

- **keep + audited: 81.** The vendored tree is overwhelmingly legitimate community
  content with live in-tree references (CI parity tests, recipes, the fork's ROLE_GRANTS,
  cross-schema deps). The seed "remove" list did not survive the gate — every seed-remove
  integration/schema is load-bearing today (the SMD-1228/1524/1544/1798 audit wired them
  into CI + the shim after the seed was written).
- **remove: 6.**
  - `schemas/text-search-trgm` — index verbatim in migration 011; no fork-side dep.
  - `schemas/recency-boosted-match-thoughts` — `match_thoughts_recency` has zero callers; 020 folded recency into core `match_thoughts`.
  - `schemas/thought-work-claims` — comment-only stub; 015 owns the table.
  - `docs/drafts/agent-memory-branding-dna.md` — upstream personal-brand playbook.
  - `docs/drafts/agent-memory-staging-deploy-notes.md` — upstream staging notes (nuggets captured elsewhere).
  - `docs/drafts/discord-chunking-discussion.md` — resolved (proposals landed in 003/007/011).
- **sub-file removal: 1.** `recipes/email-history-import/rollback-chunking-columns.sql`
  — undoes abandoned upstream PR #27 column-chunking; no-op on the fork.
- **fold-in SMD-1867 (capture-source adapters): 5 integrations** — `chrome-capture-extension`,
  `discord-capture`, `slack-capture`, `telegram-capture`, `readwise-capture`. Plus **~11
  import recipes** flagged as candidate adapters (`chatgpt` / `email-history` / `gmail-smart-pull`
  / `google-activity` / `grok` / `instagram` / `journals-blogger` / `obsidian` / `perplexity`
  / `readwise` / `x-twitter`).
- **rebuild-tickets linked (kept + tracked):** `enhanced-mcp` → SMD-1525 + SMD-1798;
  `schemas/typed-reasoning-edges` → SMD-1253; `schemas/wiki-pages` → SMD-949;
  `schemas/smart-ingest` → SMD-1253.
- **SMD-1798 portability (runtime supabase-js), kept:** `agent-memory-api`, `enhanced-mcp`,
  `open-brain-rest`, `rest-api`, `ob-graph`, `repo-learning-coach`, `schema-aware-routing`,
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
   folder is `schemas/smart-ingest`. **Deferred** — in `brain-smoke-test` the drift is tangled
   with a stale "not yet on main" assertion (the schema *is* on main), so a correct fix is a
   smoke-test-logic change, not a rename; left for its own pass.
2. **`recipes/content-fingerprint-dedup` stale paths** — `recipes/email-history-import`'s
   `pull-gmail.ts` pointed at `primitives/content-fingerprint-dedup`; **fixed** to `recipes/…`
   here. The `dashboards/ob1-canonical-landing` upstream GitHub URL is an SMD-1929 item
   (upstream branding/links), left for it.
3. **`schemas/workflow-status`** — **no fix needed.** `migration.sql` already uses
   `ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS …` on both columns (idempotent, re-runnable);
   the earlier "bare `ADD COLUMN` collision" note was a misread of the README example. The
   `workflow-status` row below is corrected.

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
> `delete-thought-mcp` are all load-bearing today (CI drives them; recipes and a skill
> wire to them), so they fail the "verified no references" gate. The fork's *own-runtime*
> rebuilds (`db/` migrations 009 / 016 / 029) run **beside** the vendored community
> Edge Functions; they do not make them dead. Details in each row below.

## Inventory

Scope: every artifact under `integrations/`, `recipes/`, `schemas/`, `docs/drafts/`,
excluding `_shared/` / `_template/` scaffolding and `README.md` indexes. 87 artifacts
(17 + 51 + 16 + 3).

### `integrations/` (17)

| Artifact | Disposition | Justification |
|---|---|---|
| `agent-memory-api` | keep + audited | Live runtime API: README index, `schemas/agent-memory` deploys from it, CI drives it (`test-auth.ts:189` rest, `test-writes.ts:384`); on the SQL-shim KEEP list. Portability follow-up SMD-1798. |
| `chrome-capture-extension` | keep + audited → fold-in **SMD-1867** | Client-side capture source (Claude / ChatGPT / Gemini → `open-brain-rest`). A capture adapter under the SMD-1867 contract, not an ad-hoc integration. |
| `consolidation-workers` | keep + audited *(revises seed "remove")* | Does bio-synthesis + metadata-normalization (LLM enrichment) — migration 029 / SMD-1294 is *supersession proposals*, a different capability, and does not supersede this. Load-bearing: CI `test-auth.ts:200-201` + `test-writes.ts` bio (SMD-1544), `test-auth.ts` imports and starts `metadata-norm` (the deno-check job went with SMD-1800), `package.json` `sync-auth`, on the shim. Fails "verified no references." |
| `delete-thought-mcp` | keep + audited *(revises seed "remove")* | Migration 009 ported the *RPC* from it into core, but the standalone MCP server stays a live community "add just this one tool" example: CI `test-auth.ts:186`, the whole `skills/deleting-thoughts` pack, `schemas/thought-audit` README. Fails "verified no references." |
| `discord-capture` | keep + audited → fold-in **SMD-1867** | Capture source (Discord bot); sibling to slack/telegram capture. SMD-1867 adapter. |
| `enhanced-mcp` | keep + audited + rebuild-tickets | Load-bearing (CI `test-auth.ts`/`test-writes.ts`, `evals/eval-filtered`, `rest-api` shares its `_shared`). Un-absorbed capabilities ticketed: integer-id read tools broken on the UUID fork → **SMD-1525**; portability → **SMD-1798**. |
| `entity-extraction-worker` | keep + audited *(revises seed "remove")* | `db/extract-entities.ts` (migration 016 / SMD-947) is the fork's *own-runtime* rebuild; the vendored Edge Function is the community queue-processor still wired to `smart-ingest` (triggers it by URL), `schemas/entity-extraction`, recipes `entity-wiki` / `wiki-compiler` / `brain-health-monitoring` / `typed-edge-classifier`, and CI `test-auth.ts:199`. Fails "verified no references." |
| `hermes-agent-memory` | keep + audited | Standalone Python `MemoryProvider` plugin depending on the kept `agent-memory-api`. Not superseded / hazard / dead. |
| `kubernetes-deployment` | keep + audited | Self-hosted K8s + own Postgres deployment path. Raw INSERTs audited under SMD-1524; guard owns `k8s/init.sql` / `openbrain.yml` / `index.ts` (OWN_DATABASE); CI `test-auth.ts:188` + the deploy-stack job's image build (on Bun since SMD-1800; the deno-check job went with it). |
| `open-brain-rest` | keep + audited | REST gateway for the dashboard surfaces; `chrome-capture-extension` POSTs to it. CI `test-auth.ts:192` rest + `test-writes.ts:405`; on the shim; portability SMD-1798. |
| `openclaw-agent-memory` | keep + audited | OpenClaw plugin/publishing package depending on the kept `agent-memory-api` + `schemas/agent-memory`. Live: README index, docs, `.gitignore` (`dist/`), CLAW_HUB publishing. Distinct from the `recipes/openclaw-agent-memory` setup recipe. |
| `readwise-capture` | keep + audited → fold-in **SMD-1867** | Readwise-highlight webhook capture source. `schemas/readwise-books` is its companion cache; CI `test-auth.ts:205` (webhook) + `test-writes.ts:512` (SMD-1524). Capture adapter under SMD-1867. |
| `rest-api` | keep + audited | Documented general REST gateway (CORS, full CRUD, ingest, entity endpoints); `/ingest` proxies to `smart-ingest`. CI `test-auth.ts:622` + `test-writes.ts:443`, `brain-smoke-test` probes it; on the shim. (Coexists with `open-brain-rest`, the dashboard-specific gateway — a possible future consolidation, not a removal; both referenced.) |
| `slack-capture` | keep + audited → fold-in **SMD-1867** | Slack quick-capture source. Live: README index, `docs/01-getting-started` step, CI. Capture adapter under SMD-1867. |
| `smart-ingest` | keep + audited | LLM document-extraction/atomization pipeline; companion worker to `schemas/smart-ingest`. Live: CI `test-auth.ts:622`, `rest-api` `/ingest` proxies to it, `entity-extraction-worker` helper routes oversized content to it. (Schema's rebuild is tracked under SMD-1253.) |
| `telegram-capture` | keep + audited → fold-in **SMD-1867** | Telegram quick-capture source; its README is a CI-driven write sample (`extensions/test-writes.ts`, its telegram-capture spellings) and a guard fixture (one of check 10's `THOUGHT_WRITE_PROBES` in `scripts/check-fork-consistency.ts`). Capture adapter under SMD-1867. |
| `update-thought-mcp` | keep + audited *(revises seed "remove")* | Twin of `delete-thought-mcp`: migration 009 ported the *RPC* from it into core, but the standalone MCP server stays a live community example — CI `test-auth.ts:187` + `test-writes.ts:315`, `schemas/thought-audit` README. Fails "verified no references." |

### `schemas/` (16)

| Artifact | Disposition | Justification |
|---|---|---|
| `agent-memory` | keep + audited | Governed-memory **sidecar** tables (memory records, provenance, use-policy, review, recall traces, audit) — all in their own names, core `thoughts` untouched (not a hazard); no `db/` migration replicates them (not superseded). Depended on by `agent-memory-api` / `hermes-agent-memory` / `openclaw-agent-memory` and CI `test-writes.ts` SIDECARS. |
| `brain-stats-daily` | keep + audited | Dashboard daily-bucket heatmap RPCs (`brain_stats_daily*`), own functions only, core untouched. Distinct from migration 024 (`thought_stats_summary`, a single summary) — not superseded. Standalone dashboard schema; unreferenced ≠ dead (dashboards are an open category). |
| `crm-person-tiers` | keep + audited | Own `crm_persons` / `crm_person_mentions` tables + tiers RPC, core untouched (not a hazard). Wired into the fork's own `db/config.mjs` ROLE_GRANTS and `db/README` grants; optional companion to the `gmail-smart-pull` recipe. |
| `enhanced-thoughts` | keep + audited *(revises seed "remove/fence hazard")* | The SMD-1250 `upsert_thought` clobber is **gone from the current file** (only additive `ALTER … ADD COLUMN` + non-core functions `search_thoughts_text` / `brain_stats_aggregate` / `get_thought_connections`), and check 7 of the guard now blocks its return. Load-bearing: `enhanced-mcp` depends on it, CI `test-writes.ts` SIDECARS applies it, `rest-api` / `entity-extraction-worker` / `consolidation-workers` reference its columns. Residual is a documented *deployment* grant caveat (anon + SECURITY DEFINER), not a file hazard. |
| `entity-extraction` | keep + audited *(revises seed "remove")* | Community `public.entities` / `edges` / `thought_entities` / queue (distinct from the fork's `ob1_*` in migration 016 — they coexist). Required by `schemas/typed-reasoning-edges` (errors without it), used by the vendored worker, `recipes/brain-health-monitoring` ops-views, and CI `test-writes.ts` (reads `consolidation_log`). Fails "verified no references." |
| `per-agent-identity` | keep + audited *(revises seed "remove")* | Community `openbrain_agents` / `agent_memory_keys` + `lookup_agent_memory_key` — granted by the fork's own `db/config.mjs` ROLE_GRANTS (SMD-1226). Migration 010 is "Ported from schemas/per-agent-identity" with departures (ob1_* names); the community file is the upstream-faithful origin, held to the delta. |
| `provenance-chains` | keep + audited *(revises seed "remove")* | Additive derivation columns + own merge functions (granted by `db/config.mjs`); `recipes/provenance-chains` + `typed-edge-classifier` read it. Guard check 7 (line 554) already fences its function set. Distinct from core's 025/026/032 provenance. |
| `readwise-books` | keep + audited | Own `readwise_books` cache + RPCs; granted by `db/config.mjs`; companion to `integrations/readwise-capture` + `recipes/readwise-import`; CI `test-writes.ts` SIDECARS. Not superseded, not a hazard. |
| `recency-boosted-match-thoughts` | **remove** *(no-parity posture)* | Standalone `match_thoughts_recency` with **zero callers** in the fork; migration 020 folded recency into core `match_thoughts` + `recency_score()` instead (`db/README`: "upstream … for the formula"). Guard-allowlisted (not a clobber) but valueless to the fork. Removal PR: delete the folder **and** the now-dead allowlist entry `scripts/check-fork-consistency.ts` once carried for it. |
| `smart-ingest` | keep + audited | Own `ingestion_jobs` / `ingestion_items` + `append_thought_evidence` (granted by `db/config.mjs`); companion to `integrations/smart-ingest`; `enhanced-mcp` / `rest-api` / `brain-health-monitoring` reference it. *(Minor: some refs say `schemas/smart-ingest-tables` — a stale folder-name drift to fix, not a disposition issue.)* Rebuild tracked under SMD-1253. |
| `text-search-trgm` | **remove** *(no-parity posture)* | Pure `idx_thoughts_content_trgm` GIN index promoted **verbatim** into core by migration 011 (SMD-925; on by default — `test-schema.ts:250`). Its purpose (accelerate `enhanced-thoughts`' `search_thoughts_text` ILIKE fallback) targets a function the fork replaced with `search_thoughts_keyword` (012). Only ref is an `enhanced-thoughts` doc comment. No fork-side value. Removal PR: delete the folder (no guard allowlist entry to clean). |
| `thought-audit` | keep + audited *(revises seed "remove")* | Own `thought_audit` table (granted by `db/config.mjs`, with the `thought_provenance` view); referenced by `delete-thought-mcp` / `update-thought-mcp`. Migration 008 is "Ported from schemas/thought-audit" with departures; community origin held to the delta. |
| `thought-work-claims` | **remove** *(no-parity posture)* | Already a **comment-only stub** — all upstream DDL was stripped under SMD-1250 (it would have clobbered 015's `release_thought` / `release_claims_for_worker`). Migration 015 owns the real `thought_work_claims` (evals + `db/config.mjs` grants use it). The stub's only content is upstream documentation. Removal PR: delete the folder; guard check 7 still fences the function names regardless. |
| `typed-reasoning-edges` | keep + audited + rebuild-ticket **SMD-1253** | Own `thought_edges` table + upsert RPC (granted by `db/config.mjs`); required by `recipes/typed-edge-classifier` (matches its CHECK constraint). Requires `entity-extraction`. Not rebuilt in core; rebuild tracked under SMD-1253. |
| `wiki-pages` | keep + audited + rebuild-ticket **SMD-949** | Own `wiki_pages` / `wiki_sections` / `wiki_section_revisions` + RPCs (granted by `db/config.mjs`); README index row; feeds the wiki recipes. Not rebuilt in core; rebuild tracked under SMD-949. |
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
| `atomizer` | keep + audited | Standalone LLM compound→atomic splitter + Gmail re-atomization tooling; writes through the core capture path. |
| `authorship-edges` | keep + audited | Standalone speaker-attribution recipe writing `thought_entities` author edges (no LLM, no hardcoded ids); consumes existing entity tables. |
| `auto-capture` | keep + audited | Workflow-guidance recipe paired with the reusable auto-capture skill. |
| `brain-backup` | keep + audited | Standalone export-to-JSON backup utility (`backup-brain.mjs`). |
| `brain-health-monitoring` | keep + audited | Ops SQL views + runbook (`ops-views.sql`, no core clobber); optionally reads the kept `entity-extraction` / `smart-ingest` tables. |
| `brain-smoke-test` | keep + audited | Fresh-install smoke harness (`smoke-all.js`); exercises REST/MCP/DB/auth across kept artifacts. |
| `bring-your-own-context` | keep + audited | Portable context workflow (extraction prompts + Work Operating Model flow + remote MCP deploy). |
| `chatgpt-conversation-import` | keep + audited → SMD-1867 candidate | ChatGPT-export import recipe (`chatgpt_parser.py` + `schema.sql`, no core clobber); an ingestion source — candidate SMD-1867 adapter alongside the capture integrations. |
| `claudeception` | keep + audited | Skills-that-create-skills continuous-learning recipe; searches/captures via the core MCP path. |
| `content-fingerprint-dedup` | keep + audited | The `upsert_thought` redefinition is a **README code example**, annotated "do not paste — migration 003/005 own it (SMD-1250)"; guard check 7 allowlists it (lines 646/1406). It is the fork's canonical dedup-convention doc, cited by `email-history-import` / `edge-function-cost-optimization` / `gmail-smart-pull` / `lint-sweep`. *(Minor: some cross-refs point at `primitives/content-fingerprint-dedup` / an upstream GitHub URL — stale paths to fix; overlaps SMD-1929.)* |
| `daily-digest` | keep + audited | Gmail-draft daily summary via Claude Code scheduled tasks + core MCP; zero infra. |
| `edge-function-cost-optimization` | ~~keep + audited~~ → **retired (SMD-1800)** | Was an MCP-consolidation/caching recipe about Edge Function invocation billing on Supabase; its measurements were that meter's, which this fork's containers have no analogue of, and its per-session sample's shape (changes 78, 83) lives in those changes' records. Its `examples/_shared/auth.ts` left the `sync-auth` list. |
| `editorial-policy` | keep + audited | 40-rule synthesis constitution + weekly drift auditor; `auditor/index.ts` is CI-driven (`test-writes.ts` DRIVEN_1524, SMD-1524). No core clobber. |
| `email-history-import` | keep + audited *(drop one sub-file)* → SMD-1867 candidate | Gmail-history import (an SMD-1867 candidate). **Sub-file removal:** `rollback-chunking-columns.sql` undoes the abandoned upstream PR #27 column-chunking (`parent_id`/`chunk_index`/`full_text` + `insert_thought` RPC) the fork never adopted (it uses `thought_chunks` / migration 007) — a no-op on the fork, dead upstream cruft. It is also an **unguarded `DROP COLUMN` on core `thoughts`** (guard check 5 only guards `ADD COLUMN`) → also a guard-rule candidate for the SMD-1924 verify step. |
| `entity-wiki` | keep + audited | Per-entity markdown wiki generator; reads the kept `entity-extraction` tables + worker. |
| `fingerprint-dedup-backfill` | keep + audited | Client-side fingerprint backfill **+ duplicate cleanup**. Migration 023 backfills server-side, but the recipe's `delete-duplicates.mjs` removes pre-existing dupes (a migration doesn't), and it's cited as the cleanup step by `lint-sweep` / `edge-function-cost-optimization` / `content-fingerprint-dedup`. Complements core, not superseded. |
| `gmail-smart-pull` | keep + audited → SMD-1867 candidate | Gmail → ingest-pack with sensitivity routing + atomization + contact tiers; own SQL (`merge_thought_metadata`, `entities_canonical_email`, no core clobber). SMD-1867 candidate. |
| `google-activity-import` | keep + audited → SMD-1867 candidate | Google Takeout (Search/Gmail/Maps/YouTube/Chrome/Gemini) import. SMD-1867 candidate. |
| `grok-export-import` | keep + audited → SMD-1867 candidate | xAI Grok conversation-export import. SMD-1867 candidate. |
| `infographic-generator` | keep + audited | Output generator (thoughts/research → infographic images via Gemini); not an import. |
| `instagram-import` | keep + audited → SMD-1867 candidate | Instagram export (DMs/comments/captions) import. SMD-1867 candidate. |
| `journals-blogger-import` | keep + audited → SMD-1867 candidate | Blogger Atom-XML import. SMD-1867 candidate. |
| `life-engine` | keep + audited | Background `/loop` personal-assistant recipe; own `schema.sql` (no core clobber). |
| `life-engine-video` | keep + audited | Remotion + ElevenLabs video-briefing add-on for `life-engine`. |
| `lint-sweep` | keep + audited | Read-only three-tier quality audit (`views.sql` + `lint-sweep.js`); never mutates thoughts. |
| `live-retrieval` | keep + audited | Read-side "flywheel" workflow that surfaces thoughts on topic shifts. |
| `local-brain-no-mcp` | ~~keep + audited *(own-database)*~~ → **retired (SMD-1800)** | Was a self-hosted LAN Supabase stack with three Edge Functions for curl-only capture/search/list where MCP is blocked. The fork's stack (`SETUP.md`) already runs without a cloud, and `integrations/open-brain-rest` is the HTTP surface without MCP; the companion `skills/ob1-local-http` now calls it. Its check 7/10/11/22 exceptions went with it. |
| `local-ollama-embeddings` | keep + audited | The `ALTER COLUMN embedding TYPE` is a README example explicitly annotated "not altered by hand on this fork — build at `db/config.mjs`'s width; `upsert_thought` refuses another width." CI-driven (`test-writes.ts:707`, SMD-1524). |
| `ob-graph` | keep + audited + SMD-1798 | Knowledge-graph layer (own nodes/edges tables + recursive-CTE traversal + MCP server); no core clobber. `index.ts` uses supabase-js at runtime → SMD-1798 portability. |
| `obsidian-vault-import` | keep + audited → SMD-1867 candidate | Obsidian-vault import. SMD-1867 candidate. |
| `openclaw-agent-memory` | keep + audited | Canonical OpenClaw × OB1 Agent Memory workflow recipe (depends on the kept `agent-memory-api`). Distinct from the `integrations/openclaw-agent-memory` plugin. |
| `openclaw-code-review-memory` | keep + audited | OpenClaw code-review-agent memory workflow over Agent Memory. |
| `openclaw-taskflow-work-log` | keep + audited | OpenClaw TaskFlow handoff-log workflow over Agent Memory. |
| `panning-for-gold` | keep + audited | Flagship three-phase brain-dump mining workflow (paired with the skill pack). |
| `perplexity-conversation-import` | keep + audited → SMD-1867 candidate | Perplexity `.xlsx` export import. SMD-1867 candidate. |
| `provenance-chains` | keep + audited | Backfill + nightly evaluator + MCP tool handlers over the kept `schemas/provenance-chains`; answers "why do I believe X / what uses this." SMD-1253 lineage. |
| `readwise-import` | keep + audited → SMD-1867 candidate | One-shot Readwise history backfill; pairs with `integrations/readwise-capture`. SMD-1867 candidate. |
| `repo-learning-coach` | keep + audited + SMD-1798 | Local learning app with its own Supabase tables (`schema.sql`) + durable captures; `server/supabase.ts` uses supabase-js → SMD-1798; `server/brain.ts` is CI-driven. |
| `research-to-decision-workflow` | keep + audited | Workflow composing canonical OB1 skills into decision pipelines. |
| `schema-aware-routing` | keep + audited *(own-project)* + SMD-1798 | Metadata-routing pattern that creates **its own five tables in its own project** (README-annotated; guard check 10 counted exception; CI BYPASS_1524, SMD-1524). Its `alter column embedding` / raw inserts target its own `thoughts`, not core. README uses supabase-js → SMD-1798. |
| `source-filtering` | keep + audited | Source-tag filtering + metadata backfill for early imports. |
| `thought-enrichment` | keep + audited | Retroactive LLM classification + sensitivity backfills; writes through the core path. |
| `typed-edge-classifier` | keep + audited | Opus/Haiku classifier populating the kept `thought_edges` (`typed-reasoning-edges`); SMD-1253 lineage. |
| `vercel-neon-telegram` | keep + audited *(own-database)* | Alternative Vercel + Neon + Telegram stack building **its own Neon brain** (guard OWN_DATABASE line 1409; `sql/001`/`002` owned as NEON). Its `match_thoughts` is its own install, not a clobber. Uses the Vercel AI SDK (no supabase-js). |
| `weekly-digest` | keep + audited | Scheduled importance-ranked digest to Telegram. |
| `wiki-compiler` | keep + audited | Orchestrates graph extraction + typed edges + entity/topic synthesis into scheduled wiki refreshes; wires the kept entity worker + edge tables. |
| `wiki-synthesis` | keep + audited | Topic/email-thread wiki synthesis from atomic thoughts via any OpenAI-compatible LLM. |
| `work-operating-model-activation` | keep + audited + SMD-1798 | Operating-model elicitation workflow; own `schema.sql`; `index.ts` uses supabase-js → SMD-1798. |
| `world-model-diagnostic-activation` | keep + audited | World-Model Readiness Diagnostic activation; own tables (`world_model_assessments` / `world_model_boundary_flows`), no core clobber. |
| `x-twitter-import` | keep + audited → SMD-1867 candidate | X/Twitter export (tweets/DMs/Grok) import. SMD-1867 candidate; `import-x-twitter.mjs` uses supabase-js → SMD-1798. |
