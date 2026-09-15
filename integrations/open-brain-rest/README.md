# Open Brain REST Gateway

`open-brain-rest` is the Supabase Edge Function used by the Next.js dashboard for the non-Agent-Memory OB1 surfaces:

- Dashboard stats and recent thoughts
- Thoughts browse/detail/edit/delete
- Search
- Workflow kanban updates
- Duplicate review
- Audit review
- Add to Brain

Agent Memory stays in `integrations/agent-memory-api`. This gateway only handles the base `thoughts` operational surface.

## Required Secrets

Set these as Supabase function secrets:

| Secret | Use |
| --- | --- |
| `MCP_ACCESS_KEYS` | Dashboard/API access keys as `name:scope:sha256` entries — the hash, never the key; mint one as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows. Sent as `x-brain-key`, `x-access-key`, `?key=` or a bearer token. The routes that write (`PUT`/`DELETE /thought/:id`, `POST /capture`, `POST /thought/:id/reflection`, `POST /ingest`) answer 403 to a `read` key. The older single `MCP_ACCESS_KEY` still works, compared by digest. |
| `OPENROUTER_API_KEY` | Embeddings and metadata extraction |
| `SUPABASE_URL` | Provided automatically by Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Provided automatically by Supabase |

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

## Deploy

> **Not deployable as it stands.** This function imports the repository's SQL shim (`compat/supabase-sql`, which imports `bun`) while still reading `Deno.env`, so `supabase functions deploy` cannot bundle it and Bun cannot run it — SMD-1480 holds the fix. Its access-key behaviour is exercised by `extensions/test-auth.ts`. The steps below are the deploy it will have.

From a Supabase workdir, copy or symlink this folder to `supabase/functions/open-brain-rest` and `integrations/_shared/auth.ts` to `supabase/functions/_shared/auth.ts` — the function imports the access-key module from `../_shared/auth.ts` (the same file every server on this fork shares). Then deploy:

```bash
supabase functions deploy open-brain-rest --no-verify-jwt --use-api --project-ref YOUR_PROJECT_REF
```

The dashboard should point `NEXT_PUBLIC_API_URL` at:

```text
https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-rest
```

## Smoke Test

Run the live smoke harness against a deployed function:

```bash
OB1_REST_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-rest" \
OB1_REST_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/open-brain-rest/smoke/live-smoke.mjs
```

The smoke creates three temporary rows, verifies health, capture, browse, stats, text search, workflow update, duplicate scan, and audit filtering, then deletes the rows. Pass `--keep` only when you intentionally want to inspect the created rows.

## Dashboard Demo Seed

To seed the same data story used by the screenshot/PDF/video walkthrough:

```bash
OB1_REST_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-rest" \
OB1_REST_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/open-brain-rest/smoke/seed-dashboard-demo.mjs --apply
```

Run without `--apply` first for a dry run. The seed writes through `/capture`, so it exercises the real dashboard gateway and embedding path.

## Notes

- Duplicate review uses a local token-similarity scan in v1. It is intentionally simple and cheap for solo/small-team OB1 deployments.
- Semantic search and capture require `OPENROUTER_API_KEY`.
- Reflection and smart-ingest routes are compatibility surfaces. If the optional tables/workers are missing, the dashboard still works for the core thoughts/workflow/search/audit surfaces.
