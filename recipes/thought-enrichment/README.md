# Thought Enrichment Pipeline

> **In Daemonic Brain (SMD-3318) — the two backfills moved to `db/`.** `backfill-type.mjs` and `backfill-sensitivity.mjs` are [`db/backfill-metadata.ts`](../../db/backfill-metadata.ts) now, writing `metadata.type` and `metadata.sensitivity_tier` through `update_thought`, and the `type` and `sensitivity_tier` columns too where `schemas/enhanced-thoughts` added them (below, "The two backfills"). `enrich-thoughts.mjs` follows as SMD-2298's re-tag worker (SMD-3318 PR 3b); until then it is as below.
>
> **In Daemonic Brain (SMD-2139).** `enrich-thoughts.mjs` reads and writes the brain through `compat/supabase-sql` under `bun`: `SUPABASE_URL` is a `postgres://` connection string, `SUPABASE_SERVICE_ROLE_KEY` is accepted and ignored, and the script runs from a checkout (its import is relative). Until SMD-2139 it reached the brain as a PostgREST client — `${SUPABASE_URL}/rest/v1/…` with a service-role key — over a gateway Daemonic Brain's stack does not run (SETUP.md); the decision for the class is in `docs/vendored-disposition.md`. Its writes are `type`, `importance`, `source_type`, `enriched` and `metadata`, never content or vector — the columns `update_thought` owns stay its. Every row written has its `updated_at` moved by the core trigger, and in Daemonic Brain that column is evidence: the accepted-vector caveat and the label-from-claims rule compare it with a re-embed pass's claim times, so run it between re-embed passes, not during one — as `schemas/enhanced-thoughts/schema.sql` says of its own backfill. Three things changed with the transport: a refused read or write ends the run with the database's reason, one line and exit 1, where a failed write was counted and the scan went on (and a run that left rows failed exits 1); a flag the script does not know is refused, and so is `--dry-run` beside `--apply`; and every numeric flag must be an integer. The port is a stopgap: SMD-3318 PR 3b replaces it with SMD-2298's re-tag worker (SMD-1930's runner was canceled).

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

Retroactively classify and enrich your existing thoughts with structured metadata. The pipeline uses an LLM (via OpenRouter, the Anthropic API, or any OpenAI-compatible endpoint) to extract type, summary, topics, tags, people, action items, confidence, and importance for each thought. A separate regex-based scanner detects sensitive content (SSNs, credit cards, API keys, health data) and assigns sensitivity tiers.

## Prerequisites

- A brain built by `db/migrate.ts` (SETUP.md) and its `postgres://` connection string, for a role with the grants under Security notes — `enrich-thoughts.mjs` changes `metadata`, which the audit trigger records, so it needs `SELECT, UPDATE` on `thoughts` and `SELECT, INSERT` on `thought_audit`
- The **enhanced thoughts schema** applied (`schemas/enhanced-thoughts/schema.sql`) — the script reads and writes the columns it adds to `thoughts`: `type`, `importance`, `source_type` and `enriched` (and `metadata`, which is core). Without it a run stops at its first read with `42703 column "…" does not exist`, naming the first column the script reads (`enriched` or `source_type`)
- [Bun 1.4+](https://bun.sh/) and a checkout of this repository — the script imports `compat/supabase-sql` by relative path
- An [OpenRouter](https://openrouter.ai/) API key (the default provider), an [Anthropic](https://console.anthropic.com/) API key, or a local OpenAI-compatible endpoint (Setup, step 3).

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

**Flags:** `--apply`, `--dry-run`, `--status`, `--retry-failed`, `--provider` (openrouter or anthropic), `--concurrency`, `--limit`, `--skip`, `--model`, `--max-calls`, `--reset-state`, `--help`. A value follows its flag as the next argument (`--limit 10`, never `--limit=10`); a flag without its value, or one the script does not know, is refused. The preview prints a `[DRY]` line with the classification and then the same `OK #id -> type` line the live run prints; nothing is written.

The `--max-calls` flag is a hard ceiling on the number of LLM calls per run. The default is `10000`; pass `--max-calls 0` to disable the cap. When the limit is hit the script aborts cleanly, prints a summary, and leaves remaining rows with `enriched=false` so you can resume later. This protects against a shell typo (e.g. dropping `--limit`) burning unbounded spend against a large un-enriched table.

**Resume.** The script checkpoints `lastProcessedId` to `data/enrichment-state.json` beside the script — or under `ENRICH_STATE_DIR`, if set (a relative path resolves against the directory you run from — keep it under the recipe's `data/`, the one place `.gitignore` covers; `--apply` makes the directory and proves it writable before any row is written) — after each concurrency chunk. On startup, if a checkpoint exists and neither `--skip` nor `--reset-state` was passed, the run resumes from `id > lastProcessedId` (ids are uuids in Daemonic Brain, so the order is the uuid's, not the order of capture). The `enriched=false` filter is still applied as a second layer of defense. Pass `--reset-state` to ignore the checkpoint and start from scratch. A row whose `enriched` is `NULL` rather than `false` is neither counted by `--status` nor picked up — the schema's default is `false`, so only a raw writer leaves one; `UPDATE thoughts SET enriched = false WHERE enriched IS NULL` brings them in. A run that left rows failed exits 1 with its summary, so a scheduler can tell. A model that cannot be reached — a closed port, an unknown host, a 5xx after its retries — is such a failure: one `FAIL #id: …` line per row, the id kept for `--retry-failed`; only a write the *database* refuses ends the run, after the checkpoint for the rows already handled is written (Troubleshooting).

### The two backfills: `db/backfill-metadata.ts`

`backfill-type.mjs` and `backfill-sensitivity.mjs` are one `db/` script now (SMD-3318). It reads `DATABASE_URL`, not `SUPABASE_URL`, from the environment or from a `.env` / `.env.local` in the directory you run it from (Bun reads those; the old scripts read `.env.local` beside themselves). Keep the URL there rather than on the command line, where `ps` shows its password to every user. From this directory, with `DATABASE_URL=postgres://…` in its `.env.local`:

```bash
bun ../../db/backfill-metadata.ts                         # both passes, a dry run: what would be written
bun ../../db/backfill-metadata.ts --apply                 # write
bun ../../db/backfill-metadata.ts --pass sensitivity --apply
```

A cron line `cd`s here first (cron starts in `$HOME`, where no `.env` names the brain) and adds `--apply`: with no flag the script is a dry run that writes nothing, where `bun backfill-type.mjs` wrote. A role of its own needs what `bun db/migrate.ts --grant <role>` gives (run from the checkout's root): the write goes through `update_thought`, which reads `ob1_agents` and `ob1_config` as well as `thoughts` and `thought_audit`.

Both passes write the metadata key through `update_thought` (one audit event a row, `actor_name` `backfill-metadata`), and the column too where `schemas/enhanced-thoughts` added it, for that schema's readers (a column's write alone records no audit event, as the old scripts' did not):

- **type** writes a `metadata.type` the capture would have written otherwise (another case, or an alias such as `todo` or `fact`) as the capture's own type, an alias's words kept in `type_raw`. A type naming none of the capture's (`decision`, `lesson`) is left in the key, and so is a row an importer owns. The `type` column takes the old script's rule on the type as the capture names it: a row stamped `reference` takes it when it is one of the old eight (so `Task` and `todo` now set it, where the old script skipped them), an importer's row included.
- **sensitivity** reads `db/sensitivity.ts`'s patterns (the ones this recipe shipped, reworked, and the session-capture hook's secret table), and each place — the key, and the column where it exists — takes the highest of their tier and the other place's when that is higher than what it says, in any case. A tier is never lowered, and a thought's text is never printed (the old script printed the first 80 characters of every restricted thought, and of the first 30 it scanned). `db/weekly-digest.ts` leaves a row out of its model calls by the key, the column, or the same patterns over its text, so a thought captured since the backfill last ran is held back too.

Without `--apply` nothing is written. `--dry-run` is refused (a run without `--apply` is one), and `--batch-size` is `--batch`. A row whose metadata is not a JSON object (SQL NULL, or a double-encoded string, below) has its keys counted, not written; repair it and run again. The audit trail names each key written: `SELECT thought_id, diff FROM thought_audit WHERE actor_name = 'backfill-metadata'` (a column's write alone is not in it). A page holds its rows' whole text: on a brain of long documents pass a smaller `--batch`. Its failures print `backfill-metadata FAILED — <code> <message>` and exit 1 (2 for a refusal), not the `ERROR:` lines under Troubleshooting, which are `enrich-thoughts.mjs`'s. `db/README.md` has the rest.

## Recommended execution order

1. Run `bun ../../db/backfill-metadata.ts --apply` first, to settle types and tag sensitive content before enrichment.
2. Run `enrich-thoughts.mjs --dry-run --limit 20` to preview LLM classifications.
3. Run `enrich-thoughts.mjs --apply` to enrich all remaining thoughts.
4. Run `bun ../../db/backfill-metadata.ts --apply` again: the enrichment writes its own `metadata.type` (and gives metadata to rows that had none), which the type pass settles and the sensitivity pass then reads.

## Security notes

- **Prompt injection:** thought content is wrapped in `<thought_content>` tags and the system prompt instructs the model to treat everything inside as untrusted data. Any literal tag occurrences in content are escaped. Output fields (`summary`, `topics`, `tags`, `people`, `action_items`) are length-capped and control-char-stripped before they are written to `metadata`. Even so, enriching hostile third-party imports (shared chat exports, scraped feeds) can still influence classification labels — review before trusting them as ground truth.
- **Thought text leaves the box.** `enrich-thoughts.mjs` sends each thought's first 4,000 characters to the provider you choose. Daemonic Brain's own server keeps its model calls local by default (`OB1_LLM_BASE_URL`, SETUP.md) and gates what leaves through its egress policy; this script runs outside that gate, so choose the endpoint deliberately — `OPENROUTER_BASE_URL` at a local OpenAI-compatible server (Setup, step 3) keeps the text on the machine. A brain holding health or financial detail should not be enriched through a cloud provider without that decision. `db/backfill-metadata.ts` sends nothing anywhere.
- **The connection string is the credential.** It carries the role's password: keep it in the environment or the gitignored `.env.local`, never in a file you commit. A value that is not a `postgres://` string is refused by a line that names its scheme and never repeats the value. If the role is for this script alone, grant it exactly what it writes — `GRANT USAGE ON SCHEMA public TO <role>; GRANT SELECT, UPDATE ON thoughts TO <role>; GRANT SELECT, INSERT ON thought_audit TO <role>;` (a metadata change is recorded by the audit trigger, which runs as the connecting role). The server's own role has these through `bun db/migrate.ts --grant` (`db/README.md`, "Grants for a capturing role").

## Troubleshooting

Every failure is one line on stderr, `ERROR: <what> → <code> <message>`, and exit 1 (`DEBUG=1` adds the stack).

- `ERROR: SUPABASE_URL must be set …` — the variable is neither in the environment nor in `.env.local` beside the scripts.
- `ERROR: SUPABASE_URL must be a postgres:// connection string; the value's scheme is "https:" …` — an older `.env.local` still names a Supabase project; Daemonic Brain's value is the database's connection string. The value itself is never printed.
- `ERROR: unknown flag "--dryrun" (flags: …)` — a flag the script does not know is refused rather than ignored (the typo would otherwise have run the write). `--dry-run` beside `--apply` is refused the same way, and a numeric flag must be an integer (`--limit 1.5`, `--concurrency 0` and `--concurrency x` are refused by name).
- `… → ERR_POSTGRES_CONNECTION_REFUSED Failed to connect` — nothing listens at the host and port in the URL (a stopped container, or `5432` where the compose stack publishes another port).
- `… → 3D000 database "…" does not exist` — the URL's path names a database the server does not have.
- `… → 28P01 password authentication failed for user "…"` — the URL's password is not the role's.
- `… → 42703 column "enriched" does not exist` (or `source_type`, the first column the script reads) — `schemas/enhanced-thoughts/schema.sql` has not been applied to this brain: `psql "$SUPABASE_URL" -f schemas/enhanced-thoughts/schema.sql` from the checkout's root, or paste the file into any SQL client connected to the brain.
- `… → 42501 permission denied for table thoughts` — the role in the URL may not read or write `thoughts`: `GRANT SELECT, UPDATE ON thoughts TO <role>`.
- `… → 42501 permission denied for table thought_audit` — `enrich-thoughts.mjs` changed a row's `metadata` and the audit trigger, running as your role, could not record it: `GRANT SELECT, INSERT ON thought_audit TO <role>`.
- `FAIL #…: Unable to connect. Is the computer able to access the url?` (or `getaddrinfo ENOTFOUND …`) — `enrich-thoughts.mjs` could not reach the model at `OPENROUTER_BASE_URL` (or the Anthropic API); each row fails, the run exits 1, and `--retry-failed` picks them up once the endpoint answers. A 5xx or a 429 is retried a few times first.
- `--dry-run` reads the brain, so it needs the URL too; only `--help` runs without one.

## Repairing double-encoded metadata (versions before this fix)

Earlier versions of `enrich-thoughts.mjs` pre-stringified `metadata` before the request body was itself stringified, so the `metadata` jsonb column was stored as a JSON *string* instead of an object on every enriched row. Symptoms: `metadata->'topics'` returns NULL everywhere, `metadata @>` filters stop matching, and stats/dashboard topic lists go empty, while the raw value looks like `"{\"type\":...}"`. (In Daemonic Brain the shim binds the object as jsonb, and migration 005 refuses a string payload on the functions' path.)

The inner string is the complete, valid metadata — nothing is lost. Repair in one transactional statement (`psql "$SUPABASE_URL"`, or any SQL client):

```sql
UPDATE thoughts
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string';
```

If any row held a non-JSON string the statement aborts as a whole and changes nothing.

## Cost expectations

The default OpenRouter model is `openai/gpt-4o-mini` at roughly $0.001--0.002 per thought. For 1,000 thoughts, expect approximately $1--2; a local endpoint (Setup, step 3) costs nothing beyond the machine's time. `db/backfill-metadata.ts` is free (no model calls: local logic only).

## Expected outcome

After running the full pipeline:

- Every thought has a validated `type` (idea, task, decision, lesson, meeting, journal, person_note, or reference)
- `importance` is scored 1--5 with calibrated distribution (most at 3)
- `metadata` contains `summary`, `topics`, `tags`, `people`, `action_items`, `confidence`, `detected_source_type`, and enrichment provenance
- Thoughts containing sensitive patterns carry `metadata.sensitivity_tier` = `personal` or `restricted` (`db/backfill-metadata.ts`)
- The `enriched` boolean is set to `true` for all processed thoughts

## File overview

| File | Purpose |
|------|---------|
| `enrich-thoughts.mjs` | Main LLM enrichment script |
| `lib/brain.mjs` | The brain's client: `compat/supabase-sql`, the env file, one-line failures |
| `lib/memory-core.mjs` | sha256Hex, canonicalizeText, the LLM fetch timeout |
