# Entity Extraction Worker

> Async worker that drains the entity extraction queue, extracting people, projects, topics, tools, organizations, and places from thoughts via LLM and building a knowledge graph.

## What It Does

Processes the `entity_extraction_queue` table in batches. For each queued thought, the worker calls an LLM to extract named entities and their relationships, then upserts them into the `entities`, `edges`, and `thought_entities` tables.

The knowledge graph enables queries like "what projects does Sarah work on?" or "which tools are related to this topic?" — turning unstructured thoughts into a navigable graph of people, projects, and concepts.

**Entity types:** person, project, topic, tool, organization, place

**Relationship types:** works_on, uses, related_to, member_of, located_in, co_occurs_with

**Worker behavior:**
- Claims pending queue items atomically (prevents duplicate processing)
- Retries failed items up to 5 times before marking as permanently failed
- Skips system-generated thoughts (those with `metadata.generated_by`)
- Supports dry-run mode for previewing extractions without writing
- Enforces canonical ordering for symmetric relations to avoid duplicate edges

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- **Enhanced thoughts schema** applied — install `schemas/enhanced-thoughts`
- **Knowledge graph schema** applied — install `schemas/knowledge-graph` to create the `entities`, `edges`, `thought_entities`, and `entity_extraction_queue` tables
- At least one LLM API key: OpenRouter (recommended), OpenAI, or Anthropic
- Supabase CLI installed for deployment

## Steps

> **Runs under Bun, not as an Edge Function.** This worker imports the repository's SQL shim (`compat/supabase-sql`, which imports `bun`) and `compat/deno-on-bun.ts`, the two Deno globals it uses on Bun (FORK.md change 74), so `supabase functions deploy` cannot bundle it; from a checkout of this repository it serves on `PORT` (8000 unset — podman's `gvproxy` holds that port on macOS, so set one):
>
> ```bash
> PORT=8787 SUPABASE_URL='postgres://user:password@host:5432/openbrain' MCP_ACCESS_KEYS='cron:write:<sha256-of-your-key>' OPENROUTER_API_KEY='…' bun integrations/entity-extraction-worker/index.ts
> ```
>
> `SUPABASE_URL` carries the Postgres connection string (the shim's convention; `SUPABASE_SERVICE_ROLE_KEY` may be left unset), and the other variables are the secrets the steps below set, passed as environment — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts it this way in CI. The Supabase steps below apply to the file after `bun scripts/migrate-to-sql-shim.mjs --revert integrations/entity-extraction-worker/index.ts`, which puts it back on supabase-js.

### 1. Deploy the Edge Function

Copy the `integrations/entity-extraction-worker/` folder into your Supabase project's `supabase/functions/` directory, and `integrations/_shared/auth.ts` to `supabase/functions/_shared/auth.ts` — the worker imports the access-key module from `../_shared/auth.ts` (if you already have it from another server on this fork, it is the same file). Then deploy:

```bash
supabase functions deploy entity-extraction-worker --no-verify-jwt
```

### 2. Set Environment Variables

```bash
supabase secrets set \
  MCP_ACCESS_KEYS="cron:write:<sha256-of-your-key>" \
  OPENROUTER_API_KEY="your-openrouter-key"
```

`MCP_ACCESS_KEYS` holds one `name:scope:sha256` entry per caller — the hash, never the key; mint one as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows. The older single `MCP_ACCESS_KEY` still works, compared by digest. The secret is project-wide — one `MCP_ACCESS_KEYS` for every function in the project — so set the whole list, your existing entries plus this one, comma-separated. The worker writes, so a real run needs a `write` key; a `read` key may only `dry_run=true`.

Optional multi-provider fallback:

```bash
supabase secrets set \
  OPENAI_API_KEY="your-openai-key" \
  ANTHROPIC_API_KEY="your-anthropic-key"
```

Optional safety knobs:

```bash
supabase secrets set \
  ENTITY_EXTRACTION_MAX_CALLS="10000" \
  FETCH_TIMEOUT_MS="60000"
```

- `ENTITY_EXTRACTION_MAX_CALLS` — cap on LLM extraction calls per container
  lifetime (default `10000`; set to `0` to disable). When the cap trips,
  the worker releases remaining claimed rows back to `pending` and returns
  `{ truncated: true, truncated_reason: "call_cap_reached", ... }` so the
  next invocation resumes cleanly.
- `FETCH_TIMEOUT_MS` — hard timeout on every LLM fetch (default `60000`).
  Protects against stalled upstreams consuming the 150s Edge Function
  wall-clock.

### 3. Backfill the Extraction Queue

If you have existing thoughts that need entity extraction, enqueue them:

```sql
INSERT INTO entity_extraction_queue (thought_id, status)
SELECT id, 'pending'
FROM thoughts
WHERE id NOT IN (SELECT thought_id FROM entity_extraction_queue)
ORDER BY created_at DESC
LIMIT 100;
```

New thoughts are automatically enqueued by the `queue_entity_extraction` trigger from the knowledge graph schema.

### 4. Run the Worker

Trigger the worker to process the queue:

```bash
curl -X POST "https://<your-project-ref>.supabase.co/functions/v1/entity-extraction-worker?limit=10" \
  -H "x-brain-key: your-access-key"
```

For a dry run (preview without writing — the one thing a `read`-scoped key may do):

```bash
curl -X POST "https://<your-project-ref>.supabase.co/functions/v1/entity-extraction-worker?limit=5&dry_run=true" \
  -H "x-brain-key: your-access-key"
```

### 5. Verify Results

Check that entities and edges were created:

```sql
SELECT entity_type, canonical_name, last_seen_at
FROM entities
ORDER BY last_seen_at DESC
LIMIT 20;

SELECT e1.canonical_name AS from_entity, e2.canonical_name AS to_entity, ed.relation, ed.support_count
FROM edges ed
JOIN entities e1 ON ed.from_entity_id = e1.id
JOIN entities e2 ON ed.to_entity_id = e2.id
ORDER BY ed.updated_at DESC
LIMIT 20;
```

## API Reference

### `POST /entity-extraction-worker`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | query param | 10 | Number of queue items to process (max 50) |
| `dry_run` | query param | false | Preview extractions without writing to DB |

**Response:**

```json
{
  "processed": 10,
  "succeeded": 8,
  "failed": 2,
  "entities_created": 15,
  "edges_created": 7,
  "dry_run": false,
  "truncated": false,
  "truncated_reason": null,
  "llm_calls": 10,
  "elapsed_ms": 8421
}
```

- `truncated` — `true` when the worker aborted early because a safety cap
  was hit. Remaining claimed rows are returned to `pending`.
- `truncated_reason` — `"call_cap_reached"` (ENTITY_EXTRACTION_MAX_CALLS)
  or `"wall_clock_budget"` (approaching the 150s platform timeout).
- `llm_calls` — cumulative LLM calls across this container's lifetime.
- `elapsed_ms` — wall-clock duration of this invocation.

**Queue statuses:**

- `pending` — awaiting extraction
- `processing` — currently being worked on
- `complete` — entities extracted and written
- `skipped` — intentionally not extracted (e.g. `metadata.generated_by`
  is set, indicating a system-synthesized artifact)
- `failed` — exceeded `MAX_ATTEMPTS` (5) retries; check `last_error`

Dry-run preview leaves the queue untouched — rows stay in `pending` until
the worker runs without `dry_run=true`.

## How It Connects to Other Components

The Smart Ingest Edge Function (`integrations/smart-ingest`) automatically triggers this worker after writing new thoughts. The Enhanced MCP Server (`integrations/enhanced-mcp`) exposes `graph_search` and `entity_detail` tools that query the graph this worker builds.

For guidance on managing tool count and token overhead as you add more integrations, see the [tool audit guide](../../docs/05-tool-audit.md).

## Expected Outcome

After completing setup and running the worker, you should be able to:

1. See entities extracted from your thoughts in the `entities` table
2. See relationships between entities in the `edges` table
3. Query `thought_entities` to find which thoughts mention which entities
4. Use the `graph_search` and `entity_detail` MCP tools (if the enhanced MCP server is deployed)
5. Observe the queue draining — items move from `pending` → `processing` → `complete`

## Troubleshooting

**"No LLM API key configured"**
Set at least one of `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY` as a Supabase secret.

**Queue items stuck in "processing"**
If the worker crashes mid-batch, items remain in "processing" status. Reset them:

```sql
UPDATE entity_extraction_queue
SET status = 'pending', started_at = NULL
WHERE status = 'processing'
  AND started_at < now() - interval '10 minutes';
```

**Items repeatedly failing**
Check the `last_error` column in `entity_extraction_queue`. After 5 failed attempts, items are marked as permanently `failed`. Common causes: LLM rate limiting, empty thought content, malformed responses.

**No entities extracted from a thought**
The LLM only extracts entities with confidence >= 0.5. Vague or very short thoughts may not yield any entities. This is expected behavior — check `dry_run` output to see what the LLM returns.
