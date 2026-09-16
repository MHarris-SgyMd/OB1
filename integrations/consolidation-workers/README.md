# Consolidation Workers

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

> Bio synthesis and metadata normalization workers for post-import thought quality improvement via LLM reclassification.

## What It Does

This integration provides two Supabase Edge Function workers that improve thought quality after initial import:

**Bio Worker** (`bio/index.ts`): Synthesizes a canonical biographical profile from person_note, decision, and journal thoughts. The profile is stored as a thought with `metadata.generated_by = "consolidation-bio"` and is updated in place on subsequent runs. Useful for generating "Who is X" summaries from scattered notes.

**Metadata Normalization Worker** (`metadata-norm/index.ts`): Finds thoughts with weak metadata (catch-all type="reference", default importance=3, low-confidence topics) and re-evaluates them via LLM. Only applies changes when the reclassification confidence exceeds 0.8 and the change is material (different type, importance shift >= 2, or new topics where none existed). Marks reviewed thoughts to prevent re-processing.

Both workers:
- Use three-tier LLM fallback: OpenRouter (primary) > OpenAI > Anthropic
- Support dry-run mode for previewing changes without writing
- Log all operations to the `consolidation_log` table for auditability
- Authenticate through `_shared/auth.ts` (the core server's module): named, scoped, SHA-256-hashed keys in `MCP_ACCESS_KEYS`, fail-closed when none is configured; a `read` key may only dry-run
- Use wildcard CORS for flexible deployment

For the full tool and worker inventory, see `docs/05-tool-audit.md` in the repository root.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- **Enhanced thoughts schema** applied — install `schemas/enhanced-thoughts` for the `type`, `importance`, `sensitivity_tier`, and `source_type` columns
- **Knowledge graph schema** applied — install `schemas/knowledge-graph` for the `consolidation_log` table
- At least one LLM API key: OpenRouter (recommended), OpenAI, or Anthropic
- Supabase CLI installed for deployment

## Steps

1. Copy the worker folders into your Supabase functions directory.
2. Deploy the `consolidation-bio` and `consolidation-metadata` edge functions.
3. Set the required environment variables and API keys.
4. Run each worker in dry-run mode first, then apply changes.
5. Verify the resulting rows in `consolidation_log` and `thoughts`.

### 1. Copy the Integration

Copy the `integrations/consolidation-workers/` folder into your Supabase project's `supabase/functions/` directory. Each subfolder becomes its own edge function:

```bash
mkdir -p supabase/functions/consolidation-bio supabase/functions/consolidation-metadata supabase/functions/_shared
cp integrations/consolidation-workers/bio/index.ts supabase/functions/consolidation-bio/index.ts
cp integrations/consolidation-workers/metadata-norm/index.ts supabase/functions/consolidation-metadata/index.ts
cp integrations/consolidation-workers/deno.json supabase/functions/consolidation-bio/deno.json
cp integrations/consolidation-workers/deno.json supabase/functions/consolidation-metadata/deno.json
cp integrations/consolidation-workers/_shared/*.ts supabase/functions/_shared/
```

Files are copied one by one, not folders, so running the block again — or into a `_shared/` folder you already have from the enhanced MCP server or any other server on this fork — replaces files rather than nesting a copy. The `deno.json` pins `@supabase/supabase-js`, which `consolidation-metadata` imports by its bare name (Supabase reads one per function directory); `consolidation-bio` imports the SQL shim instead and needs it only once SMD-1480 lands. Both workers import the access-key module from `../_shared/auth.ts`.

### 2. Deploy the Edge Functions

> **`consolidation-bio` is not deployable as it stands.** It imports the repository's SQL shim (`compat/supabase-sql`, which imports `bun`) while still reading `Deno.env`, so `supabase functions deploy` cannot bundle it and Bun cannot run it — SMD-1480 holds the fix; its access-key behaviour is exercised by `extensions/test-auth.ts`. `consolidation-metadata` deploys.

```bash
supabase functions deploy consolidation-bio --no-verify-jwt
supabase functions deploy consolidation-metadata --no-verify-jwt
```

### 3. Set Environment Variables

```bash
supabase secrets set \
  MCP_ACCESS_KEYS="cron:write:<sha256-of-your-key>" \
  OPENROUTER_API_KEY="your-openrouter-key"
```

`MCP_ACCESS_KEYS` holds one `name:scope:sha256` entry per caller — the hash, never the key; mint one as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows. The older single `MCP_ACCESS_KEY` still works, compared by digest. The secret is project-wide — one `MCP_ACCESS_KEYS` for every function in the project — so set the whole list, your existing entries plus this one, comma-separated. Both workers write, so a real run needs a `write` key; a `read` key may only `dry_run=true`.

Optional multi-provider fallback:

```bash
supabase secrets set \
  OPENAI_API_KEY="your-openai-key" \
  ANTHROPIC_API_KEY="your-anthropic-key"
```

Optional tuning:

```bash
supabase secrets set \
  CONSOLIDATION_MAX_CALLS="100" \
  FETCH_TIMEOUT_MS="60000"
```

- `CONSOLIDATION_MAX_CALLS` — cap on LLM completions per metadata-norm
  invocation. Defaults to 100; set to `0` to disable the cap. When the
  cap trips, the response includes `truncated: { reason, cap }` and
  already-written `consolidation_reviewed` markers are preserved.
- `FETCH_TIMEOUT_MS` — per-provider LLM fetch timeout in milliseconds.
  Defaults to 60000. On timeout the fallback chain advances to the
  next configured provider.

### 4. Run the Bio Worker

Generate a biographical profile (dry run first — the one thing a `read`-scoped key may do):

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/consolidation-bio?dry_run=true" \
  -H "x-brain-key: your-access-key"
```

Apply the profile:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/consolidation-bio" \
  -H "x-brain-key: your-access-key"
```

Optionally target a specific person:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/consolidation-bio?name=Sarah" \
  -H "x-brain-key: your-access-key"
```

### 5. Run the Metadata Normalization Worker

Preview what would change (dry run):

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/consolidation-metadata?dry_run=true&limit=20" \
  -H "x-brain-key: your-access-key"
```

Apply changes:

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/consolidation-metadata?limit=20" \
  -H "x-brain-key: your-access-key"
```

Increase batch size (max 100):

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/consolidation-metadata?limit=100" \
  -H "x-brain-key: your-access-key"
```

### 6. Verify the Results

Check the consolidation log for operations:

```sql
SELECT operation, survivor_id, details, created_at
FROM consolidation_log
ORDER BY created_at DESC
LIMIT 10;
```

Verify the bio profile was created. Profiles are scoped by subject — `self` when no `?name=` is supplied, otherwise the name verbatim:

```sql
SELECT id, content, metadata->>'subject' AS subject, metadata
FROM thoughts
WHERE metadata->>'generated_by' = 'consolidation-bio'
ORDER BY created_at DESC;
```

To look up one subject:

```sql
SELECT id, content
FROM thoughts
WHERE metadata->>'generated_by' = 'consolidation-bio'
  AND metadata->>'subject' = 'self'
ORDER BY created_at DESC
LIMIT 1;
```

Check metadata normalization results:

```sql
SELECT id, type, importance, metadata->>'consolidation_reason' AS reason
FROM thoughts
WHERE metadata->>'consolidation_reviewed' = 'true'
ORDER BY updated_at DESC
LIMIT 10;
```

## Expected Outcome

After running the workers:

- **Bio worker**: One canonical biographical profile per subject exists (`self` when no `?name=` was supplied, otherwise the name verbatim). Running again with the same subject updates that profile in place. Running with a different `?name=` creates a new profile for that subject without touching the existing ones.
- **Metadata normalization**: Thoughts previously stuck with generic type="reference" or default importance=3 are reclassified with higher confidence. Each change is logged with the reason and model used. Thoughts that were reviewed but not changed are marked `consolidation_reviewed: true` to avoid re-processing.

## Troubleshooting

**Issue: Bio worker returns "No source thoughts found"**
Solution: The worker needs at least one person_note, high-importance decision (>= 4), or recent journal entry. Check that your thoughts have the correct `type` column set. Run the enrichment recipe first if thoughts lack type metadata.

**Issue: Metadata worker finds 0 candidates**
Solution: Candidates must have `type = 'reference'` with confidence < 0.7, or `importance = 3` with confidence < 0.7, and must not already be marked `consolidation_reviewed`. Check your thoughts meet these criteria.

**Issue: All LLM providers fail**
Solution: Verify your API keys are set correctly. Check the Supabase function logs for specific error messages. The worker tries OpenRouter first, then OpenAI, then Anthropic.

**Issue: consolidation_log insert fails**
Solution: Ensure the knowledge graph schema is applied. The `consolidation_log` table is created by `schemas/knowledge-graph`. This is a non-fatal error — the thought updates still succeed.

## Architecture

```
consolidation-workers/
  _shared/           # Shared config and helpers (config and helpers as in enhanced-mcp)
    auth.ts          # Access keys — a copy of server-portable/auth.ts (this fork)
    config.ts        # Constants, models, prompt, patterns
    helpers.ts       # Type coercion, embedding, metadata extraction
  bio/
    index.ts         # Biographical profile synthesis worker
  metadata-norm/
    index.ts         # Metadata quality improvement worker
  deno.json          # Deno configuration
  metadata.json      # OB1 contribution metadata
  README.md          # This file
```

This is an optional enhancement — it is not required for the core Open Brain alpha path. Install it after the enhanced thoughts and knowledge graph schemas if you want automated thought quality improvement.
