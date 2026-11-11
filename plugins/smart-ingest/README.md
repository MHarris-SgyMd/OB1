# Smart Ingest Plugin

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)** as the Smart Ingest integration, a server of its own with its own schema; a plugin of the brain's since SMD-2690.

## What it does

You send it a document: meeting notes, a journal entry, an article, an email thread. The brain's model extracts the durable thoughts in it, each one atomic and standing on its own, and the plugin decides what to do with each, against the thoughts the brain already holds:

- **skip** it: too short (under 30 characters) or rated below 3 of 5, said twice in the same document, a thought the brain holds word for word (up to case and spacing), or a duplicate of one by meaning (a cosine similarity above 0.92);
- **add** it: nothing the brain holds is as close as 0.85;
- **append evidence**: a thought between 0.85 and 0.92 that is at least as long; the passage the new one came from, as the model quoted it (its own text when the model gave none, or quoted words the document does not hold) is added to that thought's `metadata.evidence` (`append_thought_evidence`), labelled with the job's `source_label` (`smart_ingest` without one);
- **create a revision**: a thought between 0.85 and 0.92 that is shorter; the new one is captured as superseding it. A job whose captures' trust is below that thought's never supersedes it: the passage is appended as evidence instead (`lower_trust_than_match`), its entry's `source` saying it came from below the thought's trust. The trust weighed is the one the captures are stamped with, the declared `trust` capped at the key's kind (`ctx.caller.trust`), so declaring none, or more than the key holds, does not get past it; an unclassified key's is below any. So an `ingested` email, or an agent's document, never demotes an operator's note.

A **dry run** stores the decisions and writes nothing to the brain; `get_job` shows each one and `execute_job` carries them out. Without a dry run they are carried out at once.

Four operations, each an MCP tool on the brain's own connector and a route on the REST core (`/api/v1/…` through the proxy, with `compose.api-public.yaml`):

| Tool | Route | Scope | What it does |
| --- | --- | --- | --- |
| `smart_ingest_extract` | `POST /v1/plugins/smart-ingest/jobs` | write | Extract, decide, and (without `dry_run`) carry out |
| `smart_ingest_execute_job` | `POST /v1/plugins/smart-ingest/jobs/{job_id}/execute` | write | Carry out a dry run's decisions |
| `smart_ingest_list_jobs` | `GET /v1/plugins/smart-ingest/jobs` | read | The jobs, newest first, each with its status and counts; `status` narrows to one |
| `smart_ingest_get_job` | `GET /v1/plugins/smart-ingest/jobs/{job_id}` | read | A job and its items: each decision, why, and what its execute did |

**Each job counts what was done** (SMD-2154): `added_count`, `skipped_count`, `appended_count`, `revised_count`, `existed_count` and `failed_count` sum to `extracted_count`. `existed_count` is an add whose text the brain held by the time it ran (a capture since the dry run, or another job's), or evidence the thought already held: nothing was added for it. Before each add and revision the plugin looks for its text word for word among the search's first 20 hits, and writes nothing if the brain holds it; with the search unable to answer (the embedding provider down) the job pauses instead (below). A held text the look does not find (captured in the moment between the look and the capture, ranked past those 20, or in a thought the caller's key cannot read) is a re-capture, which merges this capture's metadata into that thought (its `source` among them), as any capture of known text does. A dry run's counts are what it decided.

**The same text** is one job: sending it again answers that job (`existing: true`), and so does a `source_metadata.import_key` already ingested, even two sent at once. The answer's `message` says what to do with that job: `execute_job` for a dry run's. A job paused while carrying out an extract that was no dry run (a `503`, below) is carried out by the same call again. A failed job answers no one: the same call after a refusal while extracting or deciding runs again, as a new job. A job a server left extracting or executing when it stopped answers its text for good: send it with `reprocess: true`, which extracts a text again as a new job, paying for the model calls again.

**A job is its creator's** (the maintainer's call, 2026-11-11), as the core's own `job_status` is, the creator told by the key's name (a key re-minted under the same name keeps its jobs): `list_jobs`, `get_job` and `execute_job` answer only the key that made the job, and another is told there is none (`NO_SUCH_JOB`). The same text from another key is that key's own job. So every capture of a job is written as the key that sent the document, under its trust.

**Who wrote it.** Each thought is captured through the core as the key that called, with `source: smart-ingest` (the old server wrote `smart_ingest`, which the core's source labels do not take: a filter on the old label finds the old thoughts alone; evidence entries keep `source: smart_ingest`) and five metadata keys: `smart_ingest_job`, `smart_ingest_item`, `extraction_type`, and the job's `source_label` and `source_type` when given. The core embeds it and extracts its own metadata (its `type`, `topics`, `people`) as it does any capture. What the extraction said beside the text (its type, importance, tags and the passage it came from) is the item's, in the plugin's table. `trust` is passed to each capture: `ingested` for outside text. Each capture carries a `client_key` made from the job's random seed and the item's id, so a job resumed after a fault is answered its own earlier capture, nothing written twice.

### Deduplication

The two cut-offs are on `search_thoughts`' cosine similarity between the new thought and the closest of the search's first 20 hits (superseded thoughts among them: the search ranks them by meaning alone). They were tuned upstream for OpenAI's `text-embedding-3-small`; the brain's default model is `qwen3-embedding:4b`, whose similarities run otherwise, so **they are uncalibrated here**; measuring them is SMD-4216. Until then, read a dry run's decisions (`get_job` shows each item's `similarity_score`) before executing a large document.

A hit whose text is the new thought's, word for word, is a duplicate (`exact_duplicate`) whatever its similarity: on `qwen3-embedding` a search is embedded under an instruction a stored thought is not, so the same text need not score near 1. A keyword-only hit has no similarity and is never a match by meaning. The search is the brain's: a thought the caller's key cannot read is not among its hits. Each extracted thought the dry run decides on is one `search_thoughts` call, and each add or revision one more at its execute (its text looked for again), each logged with `OB1_QUERY_LOG` on; one skipped as too weak or said twice is none.

### How long a call takes

One call does all of its work before it answers. Extraction is one model call per chunk of at most 5,000 words and 50,000 characters, its answer at most 4,096 tokens (twenty long thoughts come near it, and an answer cut off there fails the job), and no chunk is begun once 140 s of extraction have passed (a text within both bounds is sent as it is, one chunk; a longer one's chunks are its words joined by single spaces, as the old server's were); then each extracted thought is searched for, and (without `dry_run`) captured, each capture with the core's own metadata call. A long document can take minutes, longer than many MCP clients wait. Send a large one as a dry run, then `execute_job`, or split it. A call whose client stopped waiting ran on to the end in a reviewer's probe (in process, no proxy in front; SMD-4159 measures it); `get_job` shows what it did. Running extraction as a task of its own, so the call answers at once, is SMD-4217, on the coordinator's runs (SMD-3477).

### What the standalone server did that the plugin does not

- **No model or provider of its own.** The model is the brain's classifier (`OB1_METADATA_MODEL`) on its chat endpoint, through `ctx.model.chat`: the egress gate judges each call, and `OB1_LLM_TIMEOUT` bounds it. The old server's OpenRouter, OpenAI and Anthropic keys and their fallback order are gone.
- **No vector of its own.** The old server embedded each thought with `text-embedding-3-small` at 1536 and matched it with `match_thoughts`; the plugin searches with the brain's own embedding (`search_thoughts`).
- **No enhanced columns.** It set the enhanced-thoughts schema's `type`, `importance`, `quality_score`, `source_type` and `sensitivity_tier` columns on each thought it wrote. A plugin reaches the brain's thoughts only through core operations, and `capture_thought` takes none of them; the core's extractor gives the thought its type.
- **No `skip_classification`.** Every capture runs the core's metadata call.
- **No entity-worker trigger.** The old server POSTed to `ENTITY_EXTRACTION_WORKER_URL` after a write. The brain's own passes extract entities from new thoughts.
- **No `SMART_INGEST_*` variables.** A plugin reads no environment: the bounds are the old defaults, fixed (100,000 characters of text, 140 s of extraction). The old call cap (10,000) and chunk cap (10) are gone: the text's bound keeps an extraction to about a dozen chunks.
- **`source_metadata` stays on the job.** The old server spread it over each thought's metadata; `capture_thought` takes at most eight flat keys, so it is the job's alone.
- **No fingerprint lookup.** The old server read `thoughts.content_fingerprint` to skip an exact duplicate. The plugin compares the search's hits' text with the thought's, at the dry run and again before each capture.
- **No bare list from the model.** The old server asked for the array wrapped in an object and took a bare array too; the plugin asks for the object (`{"thoughts": [...]}`), which `ctx.model`'s JSON mode parses, and an answer that is none, a bare array among them, fails the job.
- **A narrower bank-account pattern.** The restricted check reads an account number and its word within 200 characters of each other; the old server read the whole line, which on a long one held the REST core for most of a second.

## Prerequisites

- A working brain stack (`deploy/compose.yaml`), its chat endpoint answering (`OB1_LLM_BASE_URL`, `OB1_METADATA_MODEL`).
- A key with write scope: `bun keygen.ts --name me --scope write` in `server-portable/` prints the key, and a line to add to `MCP_ACCESS_KEYS` in `deploy/.env` ([SETUP.md](../../SETUP.md) has the rest). A read key makes no jobs, so it reads none: a job is its creator's.

## Turn it on

1. **Turn the plugin on.** Add it to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all. Names in `OB1_PLUGINS` are comma-separated.

   ```
   OB1_PLUGINS=smart-ingest
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   With a chat endpoint that is not local, the egress policy decides whether the document may leave for it. Under the default (`deny`), only `OB1_EGRESS_ALLOW=plugin:smart-ingest` lets the plugin's calls out: the caller's `actor:` term does not. Add it beside any terms already there. Each capture's text is judged as any capture's is, by the caller's key ([deploy/.env.example](../../deploy/.env.example), "What may leave the box").
2. **Recreate the services so they read it.** From `deploy/`, run `docker compose up -d migrate api mcp`, then `docker compose up -d --force-recreate --no-deps app`, each with the stack's other `-f` files. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_smart_ingest`, and applies `001_ingestion.sql`. Recreating `app` signs everyone out of the GUI: its sessions live in its memory.
3. **Check it.** The REST core's preflight, at the top of its log (`docker compose logs api`): its `plugin tables` row says the role, schema and migration are in place. Moving from the standalone server? Copy its jobs first ("Moving from the standalone server", below): a job made before the copy can stop it. Then a dry run:

   ```bash
   curl -X POST "https://<your brain's host>/api/v1/plugins/smart-ingest/jobs" \
     -H "Content-Type: application/json" -H "x-brain-key: <your write key>" \
     -d '{"text": "Met with Sarah about the API redesign. She wants GraphQL instead of REST. We agreed to prototype both by Friday.", "source_label": "test-meeting", "dry_run": true}'
   ```

   The REST routes need `/api` published: name `compose.api-public.yaml` too and bring the proxy up with it (`docker compose -f compose.yaml -f compose.api-public.yaml up -d proxy`, with the stack's other `-f` files). The MCP tools need no overlay. The answer names the job (`job.job_id`) and what it would do. `get_job` with that id lists each item; `execute_job` carries them out.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tables and rows stay, and come back when it is turned on again.

## Moving from the standalone server

The standalone server (`integrations/smart-ingest`) kept its jobs in `public.ingestion_jobs` and `public.ingestion_items`, made by `schemas/smart-ingest`. The thoughts it wrote stay as they are. The plugin starts with empty tables of its own, so `get_job` finds only its own jobs, and until the copy below, and its hand-over to a key, an old job's text sent again is a new job; after them, the copied job answers that key. Stop the old server (`bun integrations/smart-ingest/index.ts`) before turning the plugin on, and point its callers at the plugin:

| | The old server | The plugin |
| --- | --- | --- |
| Ingest | `POST /` (or `/smart-ingest`) | `POST /api/v1/plugins/smart-ingest/jobs`, or the `smart_ingest_extract` tool |
| Execute a dry run | `POST /execute` with `{"job_id": n}` | `POST /api/v1/plugins/smart-ingest/jobs/{job_id}/execute` |
| The key | its one `MCP_ACCESS_KEY`, in `x-brain-key` or as a bearer | a brain key of write scope, in `x-brain-key`, `x-access-key` or as a bearer (`Authorization: Bearer`), never on the URL |
| The answer | the job's fields at the top level, `status: "existing"` for a text already ingested | ingest: `{existing, job: {job_id, status, …counts}, message}`; execute: `{already, job}`; a refusal is `{code, …}` at its status (a job not ready is `409`, the old `400`) |
| `skip_classification` | taken | refused (the input is strict): every capture runs the core's metadata call |
| A restricted value, a text too long | `403`, `413` | `422 RESTRICTED_CONTENT`; `400 REFUSED_INPUT` |

To keep the old jobs, copy them across. The block below copies every job and item, keeping their ids, so an old dry run's job can be executed by the plugin. Run it as the database owner in `psql`: on the compose stack, from `deploy/`, pipe it to `docker compose exec -T postgres psql -U postgres -d openbrain`. It is one transaction, so a refused row copies nothing, and it can be run again: a job already in the plugin's table is left as it is, with its items and counts. Run it before the plugin's first extract: a job the plugin made holds an id an old job may have, and that old job is then not copied; an item the plugin made holding an old item's id stops the copy, which then copies nothing. To copy after all, delete the plugin's own jobs first, as the database owner (`DELETE FROM plugin_smart_ingest.ingestion_jobs;`, their items with them: the copy has copied nothing yet), and run the block again.

```sql
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO plugin_smart_ingest.ingestion_jobs (id, input_hash, import_key, source_label, source_type, input_length, status, dry_run, trust, created_by,
                                                source_metadata, error_message, created_at, completed_at)
  SELECT j.id, j.input_hash, nullif(j.metadata->>'import_key', ''), j.source_label, nullif(j.metadata->>'source_type', ''), coalesce(j.input_length, 0),
         CASE WHEN j.status = 'executing' THEN 'dry_run_complete' WHEN j.status IN ('dry_run_complete', 'complete', 'failed') THEN j.status ELSE 'failed' END,
         coalesce(j.metadata->>'dry_run', 'false') = 'true',
         CASE WHEN j.metadata->>'trust' IN ('operator', 'agent', 'ingested') THEN j.metadata->>'trust' END,
         'MCP_ACCESS_KEY', coalesce(j.metadata, '{}'::jsonb) - 'source_type' - 'dry_run' - 'skip_classification' - 'trust',
         coalesce(j.error_message, CASE j.status WHEN 'executing' THEN 'copied while executing: execute_job carries out the items still ready'
                                                 WHEN 'extracting' THEN 'copied while extracting: the old server stopped before it was done' END),
         coalesce(j.created_at, now()), j.completed_at
    FROM public.ingestion_jobs j
ON CONFLICT DO NOTHING;
WITH copied AS (
  INSERT INTO plugin_smart_ingest.ingestion_items (id, job_id, position, content, type, importance, tags, source_snippet, action, reason, status,
                                                   matched_thought_id, similarity_score, result_thought_id, error_message)
    SELECT i.id, i.job_id, (row_number() OVER (PARTITION BY i.job_id ORDER BY i.id) - 1)::int, i.extracted_content,
           CASE WHEN i.metadata->>'type' IN ('idea', 'task', 'person_note', 'reference', 'decision', 'lesson', 'meeting', 'journal') THEN i.metadata->>'type' ELSE 'idea' END,
           CASE WHEN i.metadata->>'importance' ~ '^[1-5]$' THEN (i.metadata->>'importance')::smallint ELSE 3 END,
           (SELECT coalesce(array_agg(x #>> '{}' ORDER BY n), '{}') FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(i.metadata->'tags') = 'array' THEN i.metadata->'tags' ELSE '[]'::jsonb END) WITH ORDINALITY AS a(x, n)
             WHERE jsonb_typeof(x) = 'string'),
           coalesce(i.metadata->>'source_snippet', ''),
           CASE WHEN i.action IN ('add', 'skip', 'append_evidence', 'create_revision') THEN i.action ELSE 'skip' END, coalesce(i.reason, ''),
           CASE WHEN i.status IN ('pending', 'ready') THEN 'ready' WHEN i.status = 'executed' THEN 'executed' ELSE 'failed' END,
           i.matched_thought_id, CASE WHEN i.similarity_score = 'NaN' THEN NULL ELSE i.similarity_score END, i.result_thought_id, i.error_message
      FROM public.ingestion_items i
     WHERE EXISTS (SELECT 1 FROM plugin_smart_ingest.ingestion_jobs p JOIN public.ingestion_jobs o ON o.id = p.id
                    WHERE p.id = i.job_id AND p.input_hash = o.input_hash AND p.created_by = 'MCP_ACCESS_KEY')
       AND NOT EXISTS (SELECT 1 FROM plugin_smart_ingest.ingestion_items p WHERE p.job_id = i.job_id)
  RETURNING job_id, action, status)
UPDATE plugin_smart_ingest.ingestion_jobs j
   SET extracted_count = c.n, added_count = c.added, skipped_count = c.skipped, appended_count = c.appended, revised_count = c.revised, failed_count = c.failed
  FROM (SELECT job_id, count(*)::int AS n,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'add')::int AS added,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'skip')::int AS skipped,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'append_evidence')::int AS appended,
               count(*) FILTER (WHERE status <> 'failed' AND action = 'create_revision')::int AS revised,
               count(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM copied GROUP BY job_id) c
 WHERE j.id = c.job_id;
SELECT setval('plugin_smart_ingest.ingestion_jobs_id_seq', greatest((SELECT max(id) FROM plugin_smart_ingest.ingestion_jobs), 1));
SELECT setval('plugin_smart_ingest.ingestion_items_id_seq', greatest((SELECT max(id) FROM plugin_smart_ingest.ingestion_items), 1));
COMMIT;
```

- **The counts** are counted from the items this run copies, as the plugin counts them, so they sum to `extracted_count`; a job copied before, executed by the plugin since, keeps the counts its execute gave. The old server counted an execute by what its dry run decided, so an old job's `existed_count` is 0 whatever happened (SMD-2154).
- **A job the old server left unfinished** (it stopped mid-way): one still executing is copied as a dry run's, so `execute_job` carries out its items still ready; one still extracting is copied as failed, and its text sent again is a new job. `error_message` says which.
- **The key** that made an old job is recorded as `MCP_ACCESS_KEY`, the one key the old server held, and a job is its creator's: hand the copied jobs to the key that will read and execute them, as the database owner:

  ```sql
  UPDATE plugin_smart_ingest.ingestion_jobs j SET created_by = '<your key's name>' WHERE j.created_by = 'MCP_ACCESS_KEY'
     AND NOT EXISTS (SELECT 1 FROM plugin_smart_ingest.ingestion_jobs k WHERE k.created_by = '<your key's name>' AND k.input_hash = j.input_hash);
  ```
- **What the old server spread** over each item's metadata beyond its type, importance, tags (those that are text) and passage stays in `public.ingestion_items`. The job's `source_metadata` is its metadata less `source_type`, `dry_run`, `skip_classification` and `trust`, which the plugin keeps in columns or drops.
- **Afterwards**, the old tables and the function `public.append_thought_evidence(uuid, jsonb)` are no longer used: the core's `append_thought_evidence` operation writes evidence through the event log. `--grant` no longer grants them, but a grant made before stays until they are dropped; that function is `SECURITY DEFINER` and writes `thoughts.metadata` past the event log, so a role granted it keeps that until then (`bun migrate.ts --grant <role> --exact`, from `db/`, revokes what a role holds beyond its groups). When you no longer want the old rows, drop them as the database owner, the brain-health-monitoring view over them first:

  ```sql
  DROP VIEW IF EXISTS public.ops_ingestion_summary;
  DROP TABLE IF EXISTS public.ingestion_items, public.ingestion_jobs;
  DROP FUNCTION IF EXISTS public.append_thought_evidence(uuid, jsonb);
  ```

## Troubleshooting

- **`403 FORBIDDEN`.** The key cannot write: `extract` and `execute_job` take a write key.
- **`404 NO_SUCH_JOB`.** No job of this key's has that id: a job is its creator's.
- **`409 JOB_NOT_READY`.** `execute_job` carries out a dry run's job alone (`dry_run_complete`): `job_status` and `message` say which this is. Still extracting; failed (send the text again: a failed job's text is a new job); or executing, by another call, or left so by a server that stopped while it ran, which stays so (send the text again with `reprocess: true`; SMD-4217 makes a job resumable). A fault while executing leaves the job a dry run's again, so `execute_job` carries out the items still ready. A job already complete is answered as it stands (`already: true`).
- **`422 RESTRICTED_CONTENT`.** The text holds what looks like a national id, a passport, card or account number, a key or a password (`pattern` names which). Nothing was sent to a model. Remove it and send the text again. The patterns are the old server's, and read loosely: a UUID whose first groups are all digits reads as a card number.
- **`422 EXTRACTION_REFUSED`.** The egress gate kept the text in (`reason` names the rule): under `deny`, add `plugin:smart-ingest` to `OB1_EGRESS_ALLOW` ("Turn it on", step 1). The job is marked failed; send the text again once the term is there.
- **`422 EXTRACTION_FAILED`.** The model answered something that is not the thoughts list (`refused` and `detail` say what), or the provider refused the call (the REST core's log has its words). The job is marked failed.
- **`422 BUDGET_REACHED`.** A chunk was due to begin after 140 s of extraction. Split the document.
- **`503 PROVIDER_UNAVAILABLE`** (retryable, with `Retry-After`). The chat endpoint, or the embedding provider the search needs, did not answer, or the core said a write may land a moment later (a thought kept busy). While extracting or deciding, the job is marked failed, and the same call again, once the provider answers, runs as a new job. While executing (an inline ingest's, or `execute_job`), the job is paused, a dry run's again with its items still ready: `execute_job` carries them out once the provider answers.
- **`500 FAILED`.** A fault of the core's or the store's; the REST core's log has it. The job is marked failed (or, while executing, a dry run's again), its `error_message` saying so without the store's words.
- **An item `failed`.** Its `error_message` names the core's refusal: a thought deleted since the dry run (`NOT_FOUND` for evidence, `REFUSED_SUPERSEDES_UNKNOWN` for a revision), a thought whose evidence list is full (`REFUSED_THOUGHT_EVIDENCE`), or a revision whose text was already a thought, which keeps its own provenance; or a fault, logged. A failed item is not tried again: the job is complete, and the text sent again with `reprocess: true` is extracted afresh.
