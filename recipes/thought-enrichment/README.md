# Thought Enrichment Pipeline

> **On this fork (SMD-2139).** `enrich-thoughts.mjs`, `backfill-type.mjs` and `backfill-sensitivity.mjs` read and write the brain through `compat/supabase-sql` under `bun`: `SUPABASE_URL` is a `postgres://` connection string, `SUPABASE_SERVICE_ROLE_KEY` is accepted and ignored, and the scripts run from a checkout (their import is relative). Until SMD-2139 they reached the brain as PostgREST clients — `${SUPABASE_URL}/rest/v1/…` with a service-role key — over a gateway this fork's stack does not run (SETUP.md); the decision for the class is in `docs/vendored-disposition.md`. Their writes are `type`, `sensitivity_tier`, `importance`, `source_type`, `enriched` and `metadata`, never content or vector — the columns `update_thought` owns stay its. Three things changed with the transport: a refused read or write ends the run with the database's reason, one line and exit 1, where a failed write was counted and the scan went on (and an enrichment run that left rows failed exits 1); a flag no script knows is refused, and so is `--dry-run` beside `--apply`; and every numeric flag must be an integer. The port is a stopgap by design: SMD-1930 re-expresses these backfills as transforms over the worker-claim runner, and the client goes with it.

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

Retroactively classify and enrich your existing thoughts with structured metadata. The pipeline uses an LLM (via OpenRouter, the Anthropic API, or any OpenAI-compatible endpoint) to extract type, summary, topics, tags, people, action items, confidence, and importance for each thought. A separate regex-based scanner detects sensitive content (SSNs, credit cards, API keys, health data) and assigns sensitivity tiers.

## Prerequisites

- A brain built by `db/migrate.ts` (SETUP.md) and its `postgres://` connection string, for a role with the grants under Security notes — `SELECT, UPDATE` on `thoughts` for the two backfills; `enrich-thoughts.mjs` changes `metadata`, which the audit trigger records, so it needs `SELECT, INSERT` on `thought_audit` too
- The **enhanced thoughts schema** applied (`schemas/enhanced-thoughts/schema.sql`) — the scripts read and write the columns it adds to `thoughts`: `type`, `importance`, `source_type`, `enriched`, `sensitivity_tier` (and `metadata`, which is core). Without it a run stops at its first read with `42703 column "…" does not exist`, naming the first column the script reads (`type`, `sensitivity_tier`, `enriched` or `source_type`)
- [Bun 1.4+](https://bun.sh/) and a checkout of this repository — the scripts import `compat/supabase-sql` by relative path
- For `enrich-thoughts.mjs` alone: an [OpenRouter](https://openrouter.ai/) API key (the default provider), an [Anthropic](https://console.anthropic.com/) API key, or a local OpenAI-compatible endpoint (Setup, step 3). The two backfills call no model.

## Setup

1. From the recipe's directory, put the connection string in the environment or in `.env.local` beside the scripts (a variable in the environment wins):

   ```bash
   cd recipes/thought-enrichment
   cat > .env.local <<'ENV'
   SUPABASE_URL=postgres://brain_user:its-password@127.0.0.1:5432/openbrain
   OPENROUTER_API_KEY=sk-or-v1-...
   ENV
   ```

   `.env.local` is gitignored. A `SUPABASE_SERVICE_ROLE_KEY` line from an older setup may stay; it is read and ignored. The file takes `KEY=value` lines, a leading `export`, quotes around a value, and a `# comment` after an unquoted one.

2. If using Anthropic directly instead of OpenRouter, add `ANTHROPIC_API_KEY` and pass `--provider anthropic` when running.

3. To keep the thought text on your machine, point the OpenRouter provider at a local OpenAI-compatible server — Ollama's is `http://127.0.0.1:11434/v1` — and name the model:

   ```bash
   OPENROUTER_BASE_URL=http://127.0.0.1:11434/v1 OPENROUTER_API_KEY=local bun enrich-thoughts.mjs --dry-run --limit 5 --model qwen3:8b
   ```

   The key's value is not checked by a local server, but the script requires one to be set.

## Scripts

### enrich-thoughts.mjs -- LLM-based enrichment

Classifies each thought using an LLM and writes structured metadata back to the brain.

1. Preview what the enrichment will do (no writes):

   ```bash
   bun enrich-thoughts.mjs --dry-run --limit 10
   ```

2. Run enrichment for real:

   ```bash
   bun enrich-thoughts.mjs --apply --concurrency 5
   ```

3. Check progress at any time:

   ```bash
   bun enrich-thoughts.mjs --status
   ```

4. Retry any previously failed thoughts:

   ```bash
   bun enrich-thoughts.mjs --apply --retry-failed
   ```

**Flags:** `--provider` (openrouter or anthropic), `--concurrency`, `--limit`, `--skip`, `--model`, `--max-calls`, `--reset-state`.

The `--max-calls` flag is a hard ceiling on the number of LLM calls per run. The default is `10000`; pass `--max-calls 0` to disable the cap. When the limit is hit the script aborts cleanly, prints a summary, and leaves remaining rows with `enriched=false` so you can resume later. This protects against a shell typo (e.g. dropping `--limit`) burning unbounded spend against a large un-enriched table.

**Resume.** The script checkpoints `lastProcessedId` to `data/enrichment-state.json` beside the script — or under `ENRICH_STATE_DIR`, if set — after each concurrency chunk. On startup, if a checkpoint exists and neither `--skip` nor `--reset-state` was passed, the run resumes from `id > lastProcessedId` (ids are uuids on this fork, so the order is the uuid's, not the order of capture). The `enriched=false` filter is still applied as a second layer of defense. Pass `--reset-state` to ignore the checkpoint and start from scratch. A row whose `enriched` is `NULL` rather than `false` is neither counted by `--status` nor picked up — the schema's default is `false`, so only a raw writer leaves one; `UPDATE thoughts SET enriched = false WHERE enriched IS NULL` brings them in. A run that left rows failed exits 1 with its summary, so a scheduler can tell.

### backfill-type.mjs -- Type canonicalization

Fixes thoughts where the top-level `type` column is still `reference` but `metadata.type` contains a valid different type.

1. Preview:

   ```bash
   bun backfill-type.mjs --dry-run
   ```

2. Apply — to one row first, then to all:

   ```bash
   bun backfill-type.mjs --limit 1
   bun backfill-type.mjs
   ```

**Flags:** `--dry-run`, `--limit N` (stop after N rows written), `--batch-size N` (rows per page, default 500).

`schemas/enhanced-thoughts`' own `SELECT backfill_thought_types();` covers the *other* rows: those whose `type` is `NULL` — a table that got the column after its rows were captured (`ADD COLUMN` leaves every existing row `NULL`, so on a brain that applied the schema late this script sees no candidates and the function sees them all). This script reads the rows stamped `reference`, previews, stops at a limit, and reports what it changed per type and what it skipped.

### backfill-sensitivity.mjs -- Regex-based sensitivity detection

Scans thought content for patterns matching SSNs, credit cards, API keys, passwords, medications, health data, and financial details. Upgrades `sensitivity_tier` from `standard` (or empty) to `personal` or `restricted` as appropriate; a row already at `personal` or `restricted` is not scanned.

1. Preview:

   ```bash
   bun backfill-sensitivity.mjs --dry-run
   ```

2. Apply:

   ```bash
   bun backfill-sensitivity.mjs --apply
   ```

## Recommended execution order

1. Run `backfill-type.mjs` first to fix any type mismatches from prior imports.
2. Run `backfill-sensitivity.mjs` to tag sensitive content before enrichment.
3. Run `enrich-thoughts.mjs --dry-run --limit 20` to preview LLM classifications.
4. Run `enrich-thoughts.mjs --apply` to enrich all remaining thoughts.

## Security notes

- **Prompt injection:** thought content is wrapped in `<thought_content>` tags and the system prompt instructs the model to treat everything inside as untrusted data. Any literal tag occurrences in content are escaped. Output fields (`summary`, `topics`, `tags`, `people`, `action_items`) are length-capped and control-char-stripped before they are written to `metadata`. Even so, enriching hostile third-party imports (shared chat exports, scraped feeds) can still influence classification labels — review before trusting them as ground truth.
- **Thought text leaves the box.** `enrich-thoughts.mjs` sends each thought's first 4,000 characters to the provider you choose. The fork's own server keeps its model calls local by default (`OB1_LLM_BASE_URL`, SETUP.md) and gates what leaves through its egress policy; this script runs outside that gate, so choose the endpoint deliberately — `OPENROUTER_BASE_URL` at a local OpenAI-compatible server (Setup, step 3) keeps the text on the machine. A brain holding health or financial detail should not be enriched through a cloud provider without that decision. The two backfills send nothing anywhere.
- **The connection string is the credential.** It carries the role's password: keep it in the environment or the gitignored `.env.local`, never in a file you commit. A value that is not a `postgres://` string is refused by a line that names its scheme and never repeats the value. If the role is for these scripts alone, grant it exactly what they write — `GRANT USAGE ON SCHEMA public TO <role>; GRANT SELECT, UPDATE ON thoughts TO <role>;` for the two backfills, and for `enrich-thoughts.mjs` also `GRANT SELECT, INSERT ON thought_audit TO <role>;` (a metadata change is recorded by the audit trigger, which runs as the connecting role). The server's own role has these through `bun db/migrate.ts --grant` (`db/README.md`, "Grants for a capturing role").

## Troubleshooting

Every failure is one line on stderr, `ERROR: <what> → <code> <message>`, and exit 1 (`DEBUG=1` adds the stack).

- `ERROR: SUPABASE_URL must be set …` — the variable is neither in the environment nor in `.env.local` beside the scripts.
- `ERROR: SUPABASE_URL must be a postgres:// connection string; the value's scheme is "https:" …` — an older `.env.local` still names a Supabase project; the fork's value is the database's connection string. The value itself is never printed.
- `ERROR: unknown flag "--dryrun" (flags: --dry-run, --apply)` — a flag the script does not know is refused rather than ignored (the typo would otherwise have run the write). `--dry-run` beside `--apply` is refused the same way, and a numeric flag must be an integer (`--limit 1.5`, `--concurrency 0` and `--concurrency x` are refused by name).
- `… → ERR_POSTGRES_CONNECTION_REFUSED Failed to connect` — nothing listens at the host and port in the URL (a stopped container, or `5432` where the compose stack publishes another port).
- `… → 3D000 database "…" does not exist` — the URL's path names a database the server does not have.
- `… → 42703 column "type" does not exist` (or `sensitivity_tier`, `enriched`, `source_type` — the first column the script reads) — `schemas/enhanced-thoughts/schema.sql` has not been applied to this brain: `psql "$SUPABASE_URL" -f schemas/enhanced-thoughts/schema.sql` from the checkout's root.
- `… → 42501 permission denied for table thoughts` — the role in the URL may not read or write `thoughts`: `GRANT SELECT, UPDATE ON thoughts TO <role>`.
- `… → 42501 permission denied for table thought_audit` — `enrich-thoughts.mjs` changed a row's `metadata` and the audit trigger, running as your role, could not record it: `GRANT SELECT, INSERT ON thought_audit TO <role>`. The two backfills never meet this (a `type` or `sensitivity_tier` change records no event).
- `--dry-run` reads the brain, so it needs the URL too; only `--help` and `backfill-sensitivity.mjs` without a flag run without one.

## Repairing double-encoded metadata (versions before this fix)

Earlier versions of `enrich-thoughts.mjs` pre-stringified `metadata` before the request body was itself stringified, so the `metadata` jsonb column was stored as a JSON *string* instead of an object on every enriched row. Symptoms: `metadata->'topics'` returns NULL everywhere, `metadata @>` filters stop matching, and stats/dashboard topic lists go empty, while the raw value looks like `"{\"type\":...}"`. (On this fork the shim binds the object as jsonb, and migration 005 refuses a string payload on the functions' path.)

The inner string is the complete, valid metadata — nothing is lost. Repair in one transactional statement (`psql "$SUPABASE_URL"`):

```sql
UPDATE thoughts
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string';
```

If any row held a non-JSON string the statement aborts as a whole and changes nothing.

## Cost expectations

The default OpenRouter model is `openai/gpt-4o-mini` at roughly $0.001--0.002 per thought. For 1,000 thoughts, expect approximately $1--2; a local endpoint (Setup, step 3) costs nothing beyond the machine's time. The `backfill-type` and `backfill-sensitivity` scripts are free (no LLM calls -- they use local logic only).

## Expected outcome

After running the full pipeline:

- Every thought has a validated `type` (idea, task, decision, lesson, meeting, journal, person_note, or reference)
- `importance` is scored 1--5 with calibrated distribution (most at 3)
- `metadata` contains `summary`, `topics`, `tags`, `people`, `action_items`, `confidence`, `detected_source_type`, and enrichment provenance
- Thoughts containing sensitive patterns are flagged with `sensitivity_tier` = `personal` or `restricted`
- The `enriched` boolean is set to `true` for all processed thoughts

## File overview

| File | Purpose |
|------|---------|
| `enrich-thoughts.mjs` | Main LLM enrichment script |
| `backfill-type.mjs` | Type canonicalization from metadata |
| `backfill-sensitivity.mjs` | Regex-based sensitivity detection |
| `sensitivity-patterns.json` | Configurable regex patterns |
| `lib/sensitivity-patterns.mjs` | Compiles JSON patterns into RegExp |
| `lib/brain.mjs` | The brain's client: `compat/supabase-sql`, the env file, one-line failures |
| `lib/memory-core.mjs` | sha256Hex, canonicalizeText, the LLM fetch timeout |
