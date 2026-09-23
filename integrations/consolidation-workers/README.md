# Consolidation Workers

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

> Bio synthesis and metadata normalization workers for post-import thought quality improvement via LLM reclassification.

## What It Does

This integration provides two workers, run under Bun against your Postgres, that improve thought quality after initial import:

**Bio Worker** (`bio/index.ts`): Synthesizes a canonical biographical profile from person_note, decision, and journal thoughts. The profile is stored as a thought with `metadata.generated_by = "consolidation-bio"` and is rewritten through the database's `update_thought` on subsequent runs — embedded by the worker, so the row carries a vector and its model label and the content fingerprint follows the text; a re-embed pass's vector is replaced, not blanked (FORK.md change 69). The first run stores the profile through the 3-argument `upsert_thought`, embedded, with the enhanced columns following on the fresh row, and both paths name the key as 008's audit actor (FORK.md change 71, SMD-1524) — the raw insert it replaced computed its own fingerprint and stored no vector. On this fork the worker's source and profile queries — filters on `metadata->>generated_by`, `->>artifact_type` and `->>subject` — run through the SQL shim's JSON-path columns (FORK.md change 73, SMD-1544); before that change the shim refused the column and the worker answered 500 at its first query, so nothing above had run. `extensions/test-writes.ts` drives both write paths against Postgres. Useful for generating "Who is X" summaries from scattered notes.

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
- [Bun](https://bun.sh) installed, and a checkout of this repository (the workers run from it)

## Steps

1. Check out this repository — the workers run from it, under Bun.
2. Start `bio/index.ts` and `metadata-norm/index.ts` with the environment below.
3. Set the required environment variables and API keys.
4. Run each worker in dry-run mode first, then apply changes.
5. Verify the resulting rows in `consolidation_log` and `thoughts`.

### 1. Check Out the Integration

The workers run from a checkout of this repository: each imports the repository's SQL shim by relative path, and the access-key module from `../_shared/auth.ts` beside it (the core server's, held byte-identical by `extensions/test-auth.ts`). Nothing is copied anywhere; there is no Supabase Edge Function to deploy, and the directory's `deno.json` pins nothing any more.

### 2. Run the Workers

> **Runs under Bun, not as an Edge Function.** Both workers import the repository's SQL shim (`compat/supabase-sql`, which imports `bun`) and are Bun-native — `process.env` for their environment, a default-exported `{ port, fetch }` that `bun` serves (FORK.md change 74 moved `consolidation-bio`; SMD-1798 moved `consolidation-metadata`, whose two-group `.or()` over the candidates the shim did not read until then; SMD-1799 the shape), so `supabase functions deploy` cannot bundle them; from a checkout of this repository each serves on `PORT` (8000 unset — podman's `gvproxy` holds that port on macOS, so set one):
>
> ```bash
> PORT=8787 SUPABASE_URL='postgres://user:password@host:5432/openbrain' MCP_ACCESS_KEYS='cron:write:<sha256-of-your-key>' OPENROUTER_API_KEY='…' bun integrations/consolidation-workers/bio/index.ts
> PORT=8788 SUPABASE_URL='postgres://user:password@host:5432/openbrain' MCP_ACCESS_KEYS='cron:write:<sha256-of-your-key>' OPENROUTER_API_KEY='…' bun integrations/consolidation-workers/metadata-norm/index.ts
> ```
>
> `SUPABASE_URL` carries the Postgres connection string (the shim's convention; `SUPABASE_SERVICE_ROLE_KEY` may be left unset), and the other variables are the secrets the steps below set, passed as environment — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts both this way in CI, and `extensions/test-writes.ts` drives the bio worker's two write paths and the metadata worker's review against Postgres.

### 3. Set Environment Variables

```bash
export \
  MCP_ACCESS_KEYS="cron:write:<sha256-of-your-key>" \
  OPENROUTER_API_KEY="your-openrouter-key"
```

`MCP_ACCESS_KEYS` holds one `name:scope:sha256` entry per caller — the hash, never the key; mint one as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows. The older single `MCP_ACCESS_KEY` still works, compared by digest. One `MCP_ACCESS_KEYS` list serves every server you run — set the whole list, comma-separated, in each worker's environment. Both workers write, so a real run needs a `write` key; a `read` key may only `dry_run=true`.

Optional multi-provider fallback:

```bash
export \
  OPENAI_API_KEY="your-openai-key" \
  ANTHROPIC_API_KEY="your-anthropic-key"
```

`consolidation-bio` embeds the profile it writes, and embeddings come from OpenRouter or OpenAI only — with `ANTHROPIC_API_KEY` alone the worker answers 503 before it spends an LLM call. The vectors these writers make are `openai/text-embedding-3-small`'s, 1536 wide, so the brain must be built at that model and width (`OB1_EMBEDDING_MODEL=openai/text-embedding-3-small`, `OB1_EMBEDDING_DIM=1536` — upstream's Supabase brain is); on this fork's default, `qwen3-embedding:4b` at 1024, the function refuses the vector and the whole capture or edit fails — loudly, where the raw write failed the same way or had its error ignored.

Optional tuning:

```bash
export \
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
curl -X POST "http://localhost:8787/?dry_run=true" \
  -H "x-brain-key: your-access-key"
```

Apply the profile:

```bash
curl -X POST "http://localhost:8787" \
  -H "x-brain-key: your-access-key"
```

Optionally target a specific person:

```bash
curl -X POST "http://localhost:8787/?name=Sarah" \
  -H "x-brain-key: your-access-key"
```

### 5. Run the Metadata Normalization Worker

Preview what would change (dry run):

```bash
curl -X POST "http://localhost:8788/?dry_run=true&limit=20" \
  -H "x-brain-key: your-access-key"
```

Apply changes:

```bash
curl -X POST "http://localhost:8788/?limit=20" \
  -H "x-brain-key: your-access-key"
```

Increase batch size (max 100):

```bash
curl -X POST "http://localhost:8788/?limit=100" \
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
Solution: Verify your API keys are set correctly. Check the worker's stderr for the specific error. The worker tries OpenRouter first, then OpenAI, then Anthropic.

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
