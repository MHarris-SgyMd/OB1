![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

# REST API Gateway

> Documented REST gateway for non-MCP clients, dashboards, webhooks, and custom integrations with CORS support and full CRUD plus search, ingest, and entity endpoints.

## What It Does

Provides a standard REST API alongside the MCP server for clients that cannot use the Model Context Protocol. This includes browser-based dashboards, ChatGPT Actions, Gemini extensions, webhook receivers, and any HTTP client.

All endpoints share the same authentication, sensitivity filtering, and enrichment pipeline as the MCP server. CORS is enabled for browser and Electron clients.

**Available endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/search` | Semantic or full-text search |
| POST | `/capture` | Create a new thought |
| GET | `/recent` | Recent thoughts (paginated) |
| GET | `/thoughts` | Browse with filters and pagination |
| GET | `/thought/:id` | Get a single thought |
| PUT | `/thought/:id` | Update thought content, through the database's `update_thought` |
| PATCH | `/thought/:id/enrich` | Re-enrich a thought (a new vector goes through `update_thought`) |
| DELETE | `/thought/:id` | Delete a thought |
| GET | `/thought/:id/connections` | Related thoughts |
| GET | `/count` | Count thoughts with filters |
| GET | `/stats` | Brain stats summary |
| POST | `/ingest` | Proxy to smart-ingest — not available on this fork (SMD-2114) |
| GET | `/ingestion-jobs` | List ingestion jobs |
| GET | `/ingestion-jobs/:id` | Get job detail with items |
| POST | `/ingestion-jobs/:id/execute` | Execute a dry-run job |
| GET | `/duplicates` | Find near-duplicate pairs |
| POST | `/duplicates/resolve` | Merge and resolve a duplicate pair |
| GET | `/entities` | Browse/search entities |
| GET | `/entities/:id` | Entity detail with thoughts and edges |
| GET | `/health` | Health check |

**Parameters of the two routes this fork changed (SMD-2054; the note under "How It Connects" says why):**

- `POST /search` — JSON body: `query` (two characters or more), `mode` (`semantic`, the default, or `text`), `limit` (1–100, default 25), `page` (default 1; text mode's — semantic mode answers one page of `limit` rows and reports `page: 1`), `min_similarity` (0–1, default 0.3; semantic mode), `exclude_restricted` (default `true`: thoughts whose `sensitivity_tier` is `restricted` are dropped), `start_date` / `end_date` (an ISO 8601 date or date-time, read as UTC unless it carries an offset; a bound off that shape, a day the calendar lacks, or a window closed before it opens is a `400` naming the field).
- `GET /recent` — query string: `limit` (1–100, default 20), `offset`, `source`, `type`, `topic`, `exclude_restricted` (default `true`, as above; `false` shows every tier).

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- **Enhanced thoughts schema** applied — install `schemas/enhanced-thoughts` (required for all endpoints)
- At least one LLM API key: OpenRouter (recommended), OpenAI, or Anthropic (for search embeddings and capture classification)
- [Bun](https://bun.sh) 1.4+ and a checkout of this repository — the server runs under Bun ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/))
- Optional: `schemas/smart-ingest-tables` (for `/ingest` and `/ingestion-jobs` endpoints)
- Optional: `schemas/knowledge-graph` (for `/entities` endpoints and `/duplicates/resolve` entity reattachment)

## Steps

### 1. Run the gateway

This gateway runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and its own `_shared/` helpers, and is Bun-native — `process.env` for its environment, a default-exported `{ port, fetch }` that `bun` serves (FORK.md change 74; SMD-1799) — one HTTP process, as every server here is. From a checkout of this repository ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) walks the same steps):

```bash
PORT=8787 \
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEY='your-access-key' \
OPENROUTER_API_KEY='your-openrouter-key' \
bun integrations/rest-api/index.ts
```

`SUPABASE_URL` carries the Postgres connection string (the shim's convention; `SUPABASE_SERVICE_ROLE_KEY` may be left unset); `PORT` unset is 8000, which the core server holds — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts it this way in CI, and `extensions/test-writes.ts` drives its capture and edit against Postgres. A client on another machine — a hosted dashboard, the Chrome extension on another device — reaches it through the same TLS proxy as the core server ([Run a Remote MCP Server, Step 5](../../primitives/deploy-remote-mcp/README.md#step-5-put-it-behind-https)).

### 2. Set the environment

`MCP_ACCESS_KEY` is the one key this gateway holds — the raw key, compared constant-time (this server predates the hashed `MCP_ACCESS_KEYS` list, change 67) — sent by clients as `x-brain-key`; `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`) embeds searches and classifies captures. The optional knobs below — CORS, the rate limit — go in the same environment.

### 3. Test the Health Endpoint

```bash
curl "http://127.0.0.1:8787/health" \
  -H "x-brain-key: your-access-key"
```

Expected response:

```json
{ "ok": true, "service": "open-brain-rest", "timestamp": "2026-04-06T..." }
```

### 4. Test Search

```bash
curl -X POST "http://127.0.0.1:8787/search" \
  -H "Content-Type: application/json" \
  -H "x-brain-key: your-access-key" \
  -d '{ "query": "project decisions", "mode": "semantic", "limit": 5 }'
```

### 5. Test Capture

```bash
curl -X POST "http://127.0.0.1:8787/capture" \
  -H "Content-Type: application/json" \
  -H "x-brain-key: your-access-key" \
  -d '{ "content": "Decided to use PostgreSQL for the new project because of pgvector support.", "source": "rest_test" }'
```

## Authentication

All requests require authentication via one of:
- Header: `x-brain-key: your-access-key`
- Header: `Authorization: Bearer your-access-key`

The key is accepted **only** via headers, never as a `?key=` query parameter —
URL query strings leak into CDN/proxy/server access logs, which would expose
the credential in places that aren't rotated with the secret.

Key comparison uses constant-time byte-wise equality to prevent
timing-based key discovery.

## Security

`MCP_ACCESS_KEY` is the only authentication layer — the process answers
anyone who reaches its port. Additional hardening
is controlled by two env vars:

### Trust model

`MCP_ACCESS_KEY` is a single shared secret, and the gateway connects as
whatever role `SUPABASE_URL` names — the table owner, in the reference stack,
which no policy binds. Anyone
holding the key has full read/write access to the entire brain — this is a
**single-tenant, self-hosted** design, not a multi-user gateway. Use a
high-entropy key (≥32 random bytes); because rate limiting is best-effort
(see below), key strength is the primary defense against brute force. Rotate
by restarting the gateway with a new `MCP_ACCESS_KEY`.

### CORS

| Env var | Default | Notes |
|---------|---------|-------|
| `CORS_ALLOWED_ORIGINS` | unset (`*`) | Comma-separated origin allowlist. When unset the gateway responds with `Access-Control-Allow-Origin: *` for backward compatibility. |

**Warning:** `*` combined with write methods (`POST`, `PUT`, `PATCH`,
`DELETE`) is unsafe for production. Any webpage a victim visits can
attempt a cross-origin write if it can obtain the key from another
channel. Set `CORS_ALLOWED_ORIGINS` to your dashboard origin(s):

```bash
CORS_ALLOWED_ORIGINS="https://brain.example.com,https://dashboard.example.com"
```

### Rate Limiting

| Env var | Default | Notes |
|---------|---------|-------|
| `RATE_LIMIT_PER_MIN` | `100` | Per-key request cap per rolling 60-second window. Returns `429` with `Retry-After` when exceeded. |

State is kept in-memory per process, so the limit resets on restart. This is sufficient to block naive burn attacks against a
leaked key; it is not a replacement for a durable token-bucket. If you
expect high volume or need durability across cold starts, swap the
in-memory Map in `index.ts` for a Postgres-backed bucket.

Keys are SHA-256-hashed before being used as bucket identifiers so raw
keys never touch log output.

## How It Connects to Other Components

The REST API uses the same `_shared/` helpers as the Enhanced MCP Server (`integrations/enhanced-mcp`), ensuring consistent behavior for search, capture, and enrichment. The `/ingest` endpoints are written to proxy to Smart Ingest at `${SUPABASE_URL}/functions/v1/smart-ingest`, upstream's path on a project URL — with the shim's `postgres://` connection string that target is nonsense, so on this fork they fail until SMD-2114 gives the gateway a `SMART_INGEST_URL`.

> **On this fork (FORK.md change 69, SMD-1228).** `:id` is the thought's UUID (`thoughts.id` here; an integer on upstream's enhanced schema — both are accepted). `POST /capture`, `PUT /thought/:id` and `PATCH /thought/:id/enrich` write a thought's content and vector through the database's own functions — the 3-argument `upsert_thought` (`db/migrations/035`) and `update_thought` (`033`) — rather than with a raw update of the row, so the content fingerprint follows the text, the model label follows the vector and the previous vector's chunk rows go; the enhanced-thoughts columns (`type`, `sensitivity_tier`, `importance`, `quality_score`, `source_type`) are written beside them by an update that carries neither. Two consequences: `/capture` reads the fork's return (`id`, `fingerprint`, `existed`) and no longer throws after the write, and a `PUT` whose embedding call failed leaves the row without a vector — not with the old vector under the new text — answers `embedding_updated: false` with a message saying so, and `PATCH /thought/:id/enrich?fill=embedding` refills it. The enhanced-thoughts columns are set for a fresh row; a re-capture of text already stored leaves them (the tier rule is escalation-only, and `PUT` is the way to change them). `extensions/test-writes.ts` drives the three routes against Postgres. The vectors these writers make are `openai/text-embedding-3-small`'s, 1536 wide, so the brain must be built at that model and width (`OB1_EMBEDDING_MODEL=openai/text-embedding-3-small`, `OB1_EMBEDDING_DIM=1536` — upstream's Supabase brain is); on this fork's default, `qwen3-embedding:4b` at 1024, the function refuses the vector and the whole capture or edit fails — loudly, where the raw write failed the same way or had its error ignored. Since FORK.md change 103 (SMD-1541) the audit row a capture, edit or enrich leaves (`thought_audit`, `db/migrations/008`; the trigger's body is `025`'s) names `MCP_ACCESS_KEY` — the one key this server holds — as the actor, with this server named as the row's `origin` (since migration `046`, SMD-1730; as `via` in the row's `actor_context` before it); before it named nobody. `DELETE /thought/:id` and the duplicate-resolve merge still delete raw, and the merge writes the survivor's `metadata` raw, so those audit rows name nobody (SMD-1793).

> **On this fork (SMD-2054).** `POST /search` applies `exclude_restricted` (default `true`) and `start_date` / `end_date` to the rows itself, by the `sensitivity_tier` column and as instants, in both modes. Before: semantic mode returned restricted thoughts' full content — its filter compared a `sensitivity_tier` this fork's `match_thoughts` (`db/migrations/014`, `041`'s body) never returns, so nothing was ever dropped — and text mode sent `exclude_restricted: true` as a key of `p_filter`, which the enhanced-thoughts sidecar's `search_thoughts_text` reads as a metadata containment (`metadata @> p_filter`) no thought satisfies, so every text-mode search answered an empty page with `total: 0`; text mode read no date bound at all. Now semantic mode looks the tier up by id after the match (one query, which also supplies the `source_type` the semantic results carry, and the `type` where the row's metadata carries none — `match_thoughts` returns neither, so `source_type` was missing from every semantic result before; an id the lookup does not return is treated as restricted) and text mode reads the column the function returns. A bound is an ISO 8601 date or date-time, read as UTC unless it carries an offset — a date-only value is that day's midnight UTC — and a bound off that shape, a day the calendar lacks, or a window closed before it opens is a `400` naming the field. (`GET /thoughts` and `GET /count` hand the same string to Postgres, which reads a bare date in the session's time zone and takes shapes `/search` refuses, such as `yesterday`; for a bound both accept, they agree on the instant on a database running in UTC, the container images' default.)
>
> Two consequences. In **semantic mode** `match_thoughts` returns the top-N by similarity and the route over-fetches — `limit + 20`, or `limit + 50` under a date bound, at most 200 — then filters, so a brain with more than twenty restricted rows ranked above the cut can answer fewer than `limit` rows with matches left below the over-fetch; `total` there is the rows returned, as before. In **text mode** the function ranks and pages before the filters apply: `total` and `total_pages` count the rows the filters hide, `count` is the rows on the page after them, and a page the filters emptied is `count: 0` with `total_pages` still saying how many pages the function has; a page past the last hit answers `total: 0`, since the count rides on the rows. No route gives the exact count of a search's matches after the filters (`GET /count` counts by type, source and window, not by query); SMD-2055 gives `search_thoughts_text` tier and date arguments of its own, which makes text mode's page and total exact.
>
> `GET /recent` was the one route reading `thoughts` directly with no tier predicate — it answered every restricted thought's full content, newest first (`GET /duplicates` calls `find_near_duplicates`, which is defined nowhere on this fork, so it fails rather than answers) — and takes `exclude_restricted` (default `true`) as its siblings do; like theirs, its predicate is `<>` on the column, which also hides a row whose tier is NULL (an explicit write; the column defaults to `standard`), where the sidecar's functions use `IS DISTINCT FROM` — and where `/search` shows such a row, as enhanced-mcp's tools do; the two routes differ there. Every answer of `POST /search` — a page or a refused bound — carries the request's CORS headers; the file's other routes answer `Access-Control-Allow-Origin: null` under an allowlist (SMD-2079). `extensions/test-writes.ts` drives both modes against a restricted twin planted at a captured thought's vector.

For guidance on managing tool count and token overhead when running multiple integrations, see the [tool audit guide](../../docs/05-tool-audit.md).

## Expected Outcome

After completing setup, you should be able to:

1. Query the `/health` endpoint and receive a success response
2. Search thoughts via `/search` (both semantic and text modes)
3. Capture new thoughts via `/capture` with automatic enrichment
4. Browse and filter thoughts via `/thoughts` with pagination
5. Get, update, and delete individual thoughts
6. View brain statistics via `/stats`

## Troubleshooting

**"Service misconfigured: auth key not set"**
`MCP_ACCESS_KEY` is not set in the gateway's environment. Set it on the `bun` command and restart.

**"search failed" on semantic search**
No embedding API key configured. The search endpoint needs `OPENROUTER_API_KEY` or `OPENAI_API_KEY` to generate query embeddings.

**"/ingest" returns connection errors**
Expected on this fork: the proxy target is built from `SUPABASE_URL`, which is a Postgres connection string here (SMD-2114). Call the smart-ingest server (`integrations/smart-ingest`) directly.

**"/entities" returns empty or errors**
The knowledge graph schema (`schemas/knowledge-graph`) must be applied first. Without it, entity endpoints will fail with table-not-found errors.

**CORS errors from browser**
If `CORS_ALLOWED_ORIGINS` is unset, the gateway responds with `*` for backward
compatibility. If it is set, confirm your browser's `Origin` header matches
one of the allowlisted origins exactly (scheme + host + port).

**429 rate_limited**
Requests from a single key exceeded `RATE_LIMIT_PER_MIN` (default 100) in a
rolling 60-second window. Honor the `Retry-After` response header or raise
the limit with `RATE_LIMIT_PER_MIN=300` in the gateway's environment.
