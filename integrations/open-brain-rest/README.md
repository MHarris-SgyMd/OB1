# Open Brain REST Gateway

`open-brain-rest` is the REST gateway the Next.js dashboard uses for the non-Agent-Memory OB1 surfaces — one HTTP process under Bun:

- Dashboard stats and recent thoughts
- Thoughts browse/detail/edit/delete
- Search
- Workflow kanban updates
- Duplicate review
- Audit review
- Add to Brain

Agent Memory stays in `integrations/agent-memory-api`. This gateway only handles the base `thoughts` operational surface.

## Required Environment

Set these in the server's environment (the `bun` command under "Deploy"):

| Secret | Use |
| --- | --- |
| `MCP_ACCESS_KEYS` | Dashboard/API access keys as `name:scope:sha256` entries — the hash, never the key; mint one as [Run a Remote MCP Server, Step 3](../../primitives/deploy-remote-mcp/README.md#step-3-mint-an-access-key) shows. Sent as `x-brain-key`, `x-access-key`, `?key=` or a bearer token. The routes that write (`PUT`/`DELETE /thought/:id`, `POST /capture`, `POST /thought/:id/reflection`, `POST /ingest`) answer 403 to a `read` key. The older single `MCP_ACCESS_KEY` still works, compared by digest. |
| `OPENROUTER_API_KEY` | Embeddings and metadata extraction |
| `SUPABASE_URL` | The Postgres connection string — the SQL shim keeps supabase-js's variable name |
| `SUPABASE_SERVICE_ROLE_KEY` | May be left unset; the shim ignores it |

## Required Database Shape

Apply the base OB1 schema plus:

- `schemas/enhanced-thoughts/schema.sql`
- `schemas/workflow-status/migration.sql`

The function expects `thoughts.id` to be a UUID. The dashboard now treats thought IDs as strings end to end.

## Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Auth/API health check |
| `/stats` | GET | Aggregate count, type, and topic stats |
| `/thoughts` | GET | Paginated thought browse with filters |
| `/thought/:id` | GET/PUT/DELETE | Detail, edit, delete |
| `/capture` | POST | Save one thought |
| `/search` | POST | Semantic or text search |
| `/duplicates` | GET | Near-duplicate scan |
| `/thought/:id/connections` | GET | Metadata-overlap connections |
| `/thought/:id/reflection` | GET/POST | Reflection reads/writes when the optional table exists |
| `/ingestion-jobs` | GET | Smart-ingest placeholder for dashboard compatibility |
| `/ingest` | POST | Current v1 fallback captures input as one thought |

> **On this fork (FORK.md change 69, SMD-1228).** `POST /capture` and `PUT /thought/:id` write a thought's content and vector through the database's own functions — the 3-argument `upsert_thought` (`db/migrations/035`) and `update_thought` (`033`) — rather than with a raw update of the row, so the content fingerprint follows the text, the model label follows the vector and the previous vector's chunk rows go; a `PUT`'s `metadata` is shallow-merged inside the function, and the enhanced-thoughts columns (`type`, `importance`, `quality_score`, `sensitivity_tier`, `status`) are written beside it by an update that carries neither content nor vector — on a fresh row; a `POST /capture` of text already stored answers `action: "updated"` with the same id, refreshes the vector and merges the metadata, and leaves those columns to `PUT`. A `PUT` of text another thought already holds answers 409 with the function's `DUPLICATE_CONTENT`. `extensions/test-writes.ts` drives both routes against Postgres. The vectors these writers make are `openai/text-embedding-3-small`'s, 1536 wide, so the brain must be built at that model and width (`OB1_EMBEDDING_MODEL=openai/text-embedding-3-small`, `OB1_EMBEDDING_DIM=1536` — upstream's Supabase brain is); on this fork's default, `qwen3-embedding:4b` at 1024, the function refuses the vector and the whole capture or edit fails — loudly, where the raw write failed the same way or had its error ignored. Since FORK.md change 103 (SMD-1541) the audit row a capture (`POST /capture`, and `POST /ingest`, which captures the same way) or edit leaves (`thought_audit`, `db/migrations/008`; the trigger's body is `025`'s) names the key that made it — its `MCP_ACCESS_KEYS` name, or `MCP_ACCESS_KEY` under the older single key — with this server named as the row's `origin` (since migration `046`, SMD-1730; as `via` in the row's `actor_context` before it); before it named nobody. A `DELETE` still deletes the row raw, and its audit row names nobody (SMD-1793).

## Deploy

This gateway runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and the access-key module from `../_shared/auth.ts` beside it (the same file every server on this fork shares), and is Bun-native — `process.env` for its environment, a default-exported `{ port, fetch }` that `bun` serves (FORK.md change 74; SMD-1799) — one HTTP process, as every server here is. From a checkout of this repository ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) walks the same steps for an MCP server):

```bash
(cd extensions && bun install)   # once: the pinned hono and zod
PORT=8787 NODE_PATH=extensions/node_modules \
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' \
OPENROUTER_API_KEY='…' \
bun --no-install integrations/open-brain-rest/index.ts
```

`SUPABASE_URL` carries the Postgres connection string (the shim's convention; `SUPABASE_SERVICE_ROLE_KEY` may be left unset); `PORT` unset is 8000, which the core server holds — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts it under the same environment in CI (without `--no-install`: that suite also starts servers that import the MCP SDK, whose subpaths Bun resolves by fetching on first start — SMD-1991), and `extensions/test-writes.ts` drives its writes against Postgres.

The dashboard points `NEXT_PUBLIC_API_URL` at the gateway's root — `http://127.0.0.1:8787` on this machine (its `.env.example` says so), or the HTTPS URL of the proxy in front of it when the dashboard is hosted ([Run a Remote MCP Server, Step 5](../../primitives/deploy-remote-mcp/README.md#step-5-put-it-behind-https)). The routes are served at that root, and at `/open-brain-rest/…` too, the prefix upstream's deploy gave them.

## Smoke Test

Run the live smoke harness against a running gateway:

```bash
OB1_REST_URL="http://127.0.0.1:8787" \
OB1_REST_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/open-brain-rest/smoke/live-smoke.mjs
```

The smoke creates three temporary rows, verifies health, capture, browse, stats, text search, workflow update, duplicate scan, and audit filtering, then deletes the rows. Pass `--keep` only when you intentionally want to inspect the created rows.

## Dashboard Demo Seed

To seed the same data story used by the screenshot/PDF/video walkthrough:

```bash
OB1_REST_URL="http://127.0.0.1:8787" \
OB1_REST_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/open-brain-rest/smoke/seed-dashboard-demo.mjs --apply
```

Run without `--apply` first for a dry run. The seed writes through `/capture`, so it exercises the real dashboard gateway and embedding path.

## Notes

- Duplicate review uses a local token-similarity scan in v1. It is intentionally simple and cheap for solo/small-team OB1 deployments.
- Semantic search and capture require `OPENROUTER_API_KEY`.
- Reflection and smart-ingest routes are compatibility surfaces. If the optional tables/workers are missing, the dashboard still works for the core thoughts/workflow/search/audit surfaces.
