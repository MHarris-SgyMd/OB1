# Smart Ingest Plugin

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)** as the Smart Ingest integration, a server of its own with its own schema; a plugin of the brain's since SMD-2690.

## What it does

You send it a document: meeting notes, a journal entry, an article, an email thread. The brain's model extracts the durable thoughts in it, each one atomic and standing on its own, and the plugin decides what to do with each, against the thoughts the brain already holds:

- **skip** it: too short (under 30 characters) or rated below 3 of 5, said twice in the same document, or a duplicate of a thought the brain holds (a cosine similarity above 0.92);
- **add** it: nothing the brain holds is as close as 0.85;
- **append evidence**: a thought between 0.85 and 0.92 that is at least as long; the passage the new one came from is added to that thought's `metadata.evidence` (`append_thought_evidence`);
- **create a revision**: a thought between 0.85 and 0.92 that is shorter; the new one is captured as superseding it.

A **dry run** stores the decisions and writes nothing to the brain; `get_job` shows each one and `execute_job` carries them out. Without a dry run they are carried out at once.

Four operations, each an MCP tool on the brain's own connector and a route on the REST core (`/api/v1/…` through the proxy, with `compose.api-public.yaml`):

| Tool | Route | Scope | What it does |
| --- | --- | --- | --- |
| `smart_ingest_ingest` | `POST /v1/plugins/smart-ingest/jobs` | write | Extract, decide, and (without `dry_run`) carry out |
| `smart_ingest_execute_job` | `POST /v1/plugins/smart-ingest/jobs/{job_id}/execute` | write | Carry out a dry run's decisions |
| `smart_ingest_list_jobs` | `GET /v1/plugins/smart-ingest/jobs` | read | The jobs, newest first, each with its status and counts; `status` narrows to one |
| `smart_ingest_get_job` | `GET /v1/plugins/smart-ingest/jobs/{job_id}` | read | A job and its items: each decision, why, and what its execute did |

**Each job counts what was done** (SMD-2154): `added_count`, `skipped_count`, `appended_count`, `revised_count`, `existed_count` and `failed_count` sum to `extracted_count`. `existed_count` is an add whose text was already a thought by the time it ran (a capture since the dry run, or another job's), or evidence the thought already held: nothing was written for it. A dry run's counts are what it decided.

**The same text** is one job: sending it again answers that job (`existing: true`), and so does a `source_metadata.import_key` already ingested. `reprocess: true` extracts it again as a new job, paying for the model calls again.

**Who wrote it.** Each thought is captured through the core as the key that called, with `source: smart-ingest` and five metadata keys: `smart_ingest_job`, `smart_ingest_item`, `extraction_type`, and the job's `source_label` and `source_type` when given. The core embeds it and extracts its own metadata (its `type`, `topics`, `people`) as it does any capture. What the extraction said beside the text (its type, importance, tags and the passage it came from) is the item's, in the plugin's table. `trust` is passed to each capture: `ingested` for outside text.

### Deduplication

The two cut-offs are on `search_thoughts`' cosine similarity between the new thought and the brain's closest. They were tuned upstream for OpenAI's `text-embedding-3-small`; the brain's default model is `qwen3-embedding:4b`, whose similarities run otherwise, so **they are uncalibrated here**; measuring them is SMD-4216. Until then, read a dry run's decisions (`get_job` shows each item's `similarity_score`) before executing a large document.

A keyword-only hit has no similarity and is never a match. The search is the brain's: a thought the caller's key cannot read is not among its hits.

### How long a call takes

One call does all of its work before it answers. Extraction is one model call per chunk of at most 5,000 words, within a budget of 140 s; then each extracted thought is searched for, and (without `dry_run`) captured, each capture with the core's own metadata call. A long document can take minutes, longer than many MCP clients wait. Send a large one as a dry run, then `execute_job`, or split it. Whether a call whose client stopped waiting runs on to the end is not measured (SMD-4159); `get_job` shows what it did. Running extraction as a task of its own, so the call answers at once, is SMD-4217, on the coordinator's runs (SMD-3477).

### What the standalone server did that the plugin does not

- **No model or provider of its own.** The model is the brain's classifier (`OB1_METADATA_MODEL`) on its chat endpoint, through `ctx.model.chat`: the egress gate judges each call, and `OB1_LLM_TIMEOUT` bounds it. The old server's OpenRouter, OpenAI and Anthropic keys and their fallback order are gone.
- **No vector of its own.** The old server embedded each thought with `text-embedding-3-small` at 1536 and matched it with `match_thoughts`; the plugin searches with the brain's own embedding (`search_thoughts`).
- **No enhanced columns.** It set the enhanced-thoughts schema's `type`, `importance`, `quality_score`, `source_type` and `sensitivity_tier` columns on each thought it wrote. A plugin reaches the brain's thoughts only through core operations, and `capture_thought` takes none of them; the core's extractor gives the thought its type.
- **No `skip_classification`.** Every capture runs the core's metadata call.
- **No entity-worker trigger.** The old server POSTed to `ENTITY_EXTRACTION_WORKER_URL` after a write. The brain's own passes extract entities from new thoughts.
- **No `SMART_INGEST_*` variables.** A plugin reads no environment: the bounds are the old defaults, fixed (100,000 characters of text, 140 s of extraction). The old call cap (10,000) and chunk cap (10) are gone: the text's bound keeps an extraction to about a dozen chunks.
- **`source_metadata` stays on the job.** The old server spread it over each thought's metadata; `capture_thought` takes at most eight flat keys, so it is the job's alone.
- **No fingerprint lookup.** The old server read `thoughts.content_fingerprint` to skip an exact duplicate at the dry run. The search finds one by meaning (its similarity is about 1), and an add whose text is already a thought is `existed` at the execute.

## Prerequisites

- A working brain stack (`deploy/compose.yaml`), its chat endpoint answering (`OB1_LLM_BASE_URL`, `OB1_METADATA_MODEL`).
- A key with write scope: `bun keygen.ts --name me --scope write` in `server-portable/` prints the key, and a line to add to `MCP_ACCESS_KEYS` in `deploy/.env` ([SETUP.md](../../SETUP.md) has the rest). A read key reads the jobs (`list_jobs`, `get_job`) and nothing more.

## Turn it on

1. **Turn the plugin on.** Add it to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all. Names in `OB1_PLUGINS` are comma-separated.

   ```
   OB1_PLUGINS=smart-ingest
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   With a chat endpoint that is not local, the egress policy decides whether the document may leave for it. Under the default (`deny`), only `OB1_EGRESS_ALLOW=plugin:smart-ingest` lets the plugin's calls out: the caller's `actor:` term does not. Add it beside any terms already there. Each capture's text is judged as any capture's is, by the caller's key ([deploy/.env.example](../../deploy/.env.example), "What may leave the box").
2. **Recreate the services so they read it.** From `deploy/`, run `docker compose up -d migrate api mcp`, then `docker compose up -d --force-recreate --no-deps app`, each with the stack's other `-f` files. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_smart_ingest`, and applies `001_ingestion.sql`. Recreating `app` signs everyone out of the GUI: its sessions live in its memory.
3. **Check it.** The REST core's preflight, at the top of its log (`docker compose logs api`): its `plugin tables` row says the role, schema and migration are in place. Then a dry run:

   ```bash
   curl -X POST "https://<your brain's host>/api/v1/plugins/smart-ingest/jobs" \
     -H "Content-Type: application/json" -H "x-brain-key: <your write key>" \
     -d '{"text": "Met with Sarah about the API redesign. She wants GraphQL instead of REST. We agreed to prototype both by Friday.", "source_label": "test-meeting", "dry_run": true}'
   ```

   The answer names the job (`job.job_id`) and what it would do. `get_job` with that id lists each item; `execute_job` carries them out.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tables and rows stay, and come back when it is turned on again.

## Moving from the standalone server

The standalone server (`integrations/smart-ingest`) kept its jobs in `public.ingestion_jobs` and `public.ingestion_items`, made by `schemas/smart-ingest`. The thoughts it wrote stay as they are. The plugin starts with empty tables of its own, so `get_job` finds only its own jobs, and an old job's text sent again is a new job. Don't run the old server beside the plugin.

To keep the old jobs, copy them across. The block below copies every job and item, keeping their ids, so an old dry run's job can be executed by the plugin. Run it as the database owner in `psql`: on the compose stack, from `deploy/`, pipe it to `docker compose exec -T postgres psql -U postgres -d openbrain`. It is one transaction, so a refused row copies nothing, and it can be run again: a job already in the plugin's table is left as it is, with its items. Run it before the plugin's first ingest: a job the plugin made holds an id, or a text, an old job may have, and that old job is then not copied.

```sql
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO plugin_smart_ingest.ingestion_jobs (id, input_hash, import_key, source_label, source_type, input_length, status, dry_run, trust, created_by,
                                                source_metadata, error_message, created_at, completed_at)
  SELECT j.id, j.input_hash, nullif(j.metadata->>'import_key', ''), j.source_label, nullif(j.metadata->>'source_type', ''), coalesce(j.input_length, 0),
         CASE WHEN j.status IN ('extracting', 'dry_run_complete', 'executing', 'complete', 'failed') THEN j.status ELSE 'failed' END,
         coalesce(j.metadata->>'dry_run', 'false') = 'true',
         CASE WHEN j.metadata->>'trust' IN ('operator', 'agent', 'ingested') THEN j.metadata->>'trust' END,
         'MCP_ACCESS_KEY', coalesce(j.metadata, '{}'::jsonb) - 'source_type' - 'dry_run' - 'skip_classification' - 'trust',
         j.error_message, coalesce(j.created_at, now()), j.completed_at
    FROM public.ingestion_jobs j
ON CONFLICT DO NOTHING;
INSERT INTO plugin_smart_ingest.ingestion_items (id, job_id, position, content, type, importance, tags, source_snippet, action, reason, status,
                                                 matched_thought_id, similarity_score, result_thought_id, error_message)
  SELECT i.id, i.job_id, (row_number() OVER (PARTITION BY i.job_id ORDER BY i.id) - 1)::int, i.extracted_content,
         CASE WHEN i.metadata->>'type' IN ('idea', 'task', 'person_note', 'reference', 'decision', 'lesson', 'meeting', 'journal') THEN i.metadata->>'type' ELSE 'idea' END,
         CASE WHEN i.metadata->>'importance' ~ '^[1-5]$' THEN (i.metadata->>'importance')::smallint ELSE 3 END,
         (SELECT coalesce(array_agg(x ORDER BY n), '{}') FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(i.metadata->'tags') = 'array' THEN i.metadata->'tags' ELSE '[]'::jsonb END) WITH ORDINALITY AS a(x, n)),
         coalesce(i.metadata->>'source_snippet', ''),
         CASE WHEN i.action IN ('add', 'skip', 'append_evidence', 'create_revision') THEN i.action ELSE 'skip' END, coalesce(i.reason, ''),
         CASE WHEN i.status IN ('pending', 'ready') THEN 'ready' WHEN i.status = 'executed' THEN 'executed' ELSE 'failed' END,
         i.matched_thought_id, i.similarity_score, i.result_thought_id, i.error_message
    FROM public.ingestion_items i
   WHERE EXISTS (SELECT 1 FROM plugin_smart_ingest.ingestion_jobs p JOIN public.ingestion_jobs o ON o.id = p.id
                  WHERE p.id = i.job_id AND p.input_hash = o.input_hash AND p.created_by = 'MCP_ACCESS_KEY')
     AND NOT EXISTS (SELECT 1 FROM plugin_smart_ingest.ingestion_items p WHERE p.job_id = i.job_id)
ON CONFLICT DO NOTHING;
UPDATE plugin_smart_ingest.ingestion_jobs j
   SET extracted_count = c.n, added_count = c.added, skipped_count = c.skipped, appended_count = c.appended, revised_count = c.revised, failed_count = c.failed
  FROM (SELECT job_id, count(*)::int AS n,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'add')::int AS added,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'skip')::int AS skipped,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'append_evidence')::int AS appended,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'create_revision')::int AS revised,
               count(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM plugin_smart_ingest.ingestion_items GROUP BY job_id) c
 WHERE j.id = c.job_id AND j.created_by = 'MCP_ACCESS_KEY'
   AND EXISTS (SELECT 1 FROM public.ingestion_jobs o WHERE o.id = j.id AND o.input_hash = j.input_hash);
SELECT setval('plugin_smart_ingest.ingestion_jobs_id_seq', greatest((SELECT max(id) FROM plugin_smart_ingest.ingestion_jobs), 1));
SELECT setval('plugin_smart_ingest.ingestion_items_id_seq', greatest((SELECT max(id) FROM plugin_smart_ingest.ingestion_items), 1));
COMMIT;
```

- **The counts** are recounted from the copied items, as the plugin counts them, so they sum to `extracted_count`. The old server counted an execute by what its dry run decided, so an old job's `existed_count` is 0 whatever happened (SMD-2154).
- **The key** that made an old job is recorded as `MCP_ACCESS_KEY`, the one key the old server held.
- **What the old server spread** over each item's metadata beyond its type, importance, tags and passage stays in `public.ingestion_items`, and the job's `source_metadata` is its metadata less the four keys the plugin keeps in columns.
- **Afterwards**, `public.ingestion_jobs`, `public.ingestion_items` and the function `public.append_thought_evidence(uuid, jsonb)` are no longer used: the core's `append_thought_evidence` operation writes evidence through the event log. Drop them when you no longer want the old rows; `bun migrate.ts --grant <role>` no longer grants them.

## Troubleshooting

- **`403 FORBIDDEN`.** The key cannot write: `ingest` and `execute_job` take a write key.
- **`404 NO_SUCH_JOB`.** No job has that id on this brain.
- **`409 JOB_NOT_READY`.** `execute_job` carries out a dry run's job alone (`dry_run_complete`): this one is still extracting, failed, or being executed by another call. A job already complete is answered as it stands (`already: true`).
- **`422 RESTRICTED_CONTENT`.** The text holds what looks like a national id, a passport, card or account number, a key or a password (`pattern` names which). Nothing was sent to a model. Remove it and send the text again.
- **`422 EXTRACTION_REFUSED`.** The egress gate kept the text in (`reason` names the rule): under `deny`, add `plugin:smart-ingest` to `OB1_EGRESS_ALLOW` ("Turn it on", step 1). The job is marked failed; send the text again with `reprocess: true`.
- **`422 EXTRACTION_FAILED`.** The model answered something that is not the thoughts list (`refused` and `detail` say what), or the provider refused the call (the REST core's log has its words). The job is marked failed.
- **`422 BUDGET_REACHED`.** Extraction ran past 140 s. Split the document.
- **`503 PROVIDER_UNAVAILABLE`** (retryable, with `Retry-After`). The chat endpoint, or the embedding provider the search needs, did not answer. The job is marked failed; send it again with `reprocess: true` once the provider answers.
- **An item `failed`.** Its `error_message` names the core's refusal: a thought deleted since the dry run (`NOT_FOUND` for evidence, `REFUSED_SUPERSEDES_UNKNOWN` for a revision), a thought whose evidence list is full (`REFUSED_THOUGHT_EVIDENCE`), or a revision whose text was already a thought, which keeps its own provenance.
