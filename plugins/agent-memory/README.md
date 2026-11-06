# Agent Memory Plugin

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by the [@NateBJones](https://github.com/NateBJones) team** as the Agent Memory API integration and the Agent Memory schema, a server and tables of their own; a plugin of the brain's since SMD-2690.

## What it does

An agent runtime (OpenClaw, Hermes, Codex, Claude Code, an n8n flow) asks the brain what it knows before a task, and tells it what the task decided and learnt afterwards. The plugin keeps those memories governed: each one says where it came from, whether a person confirmed it, and whether it may be followed as an instruction or only used as evidence.

- **`agent_memory_writeback`** (capture) keeps what a task decided, produced, learnt, was constrained by, left open, means to do next, failed at and made. Each item is one memory:
  - Its text is captured as a thought through the core, with `source: agent-memory`, the trust the request gives (never above the key's) and six metadata keys naming the workspace, project, task, runtime, kind and provenance (`agent_memory_*`). Your key is named on the thought's audit row.
  - Its provenance, scope, review state and use policy, the models that made it and where it came from are kept in the plugin's own tables.
  - A memory is confirmed at once, usable as an instruction, only when the request says `user_confirmed` or `imported` and `requires_review: false`. Any other waits for review, usable as evidence only.
  - It is refused as a whole, with nothing written, when any memory looks like a private key, an API key, a credential, a large code block or a transcript (`UNSAFE_WRITEBACK`, which lists why).
  - Each memory has an idempotency key, so the same write-back sent again answers the memories it wrote and writes nothing.
- **`agent_memory_recall`** (read) searches the brain by meaning, keeps the hits that are this workspace's memories and in scope, and ranks them by similarity and by what their provenance, use policy, review and confidence add. Under a write key the recall is traced, and its `request_id` is the one to report usage against. Under a read key nothing is stored.
- **`agent_memory_record_usage`** (write) marks the memories a traced recall returned as used, or ignored with a reason.
- **`agent_memory_review_queue`**, **`agent_memory_list_memories`** and **`agent_memory_get_memory`** (read) list what waits for review, list a workspace's memories by status, runtime, kind or task, and show one memory with its sources, models and relations.
- **`agent_memory_review_memory`** (write) is a person's verdict on a memory: confirm, evidence only, restrict its scope, mark it stale, reject, dispute, edit, merge or supersede. Each review is kept with the memory before and after it, under the key's name.
- **`agent_memory_get_recall`** (read) shows a traced recall: what was asked, and each memory returned with its rank, similarity, score and whether it was used.

Each is an MCP tool on the brain's own connector, and a route under `/v1/plugins/agent-memory/` on the REST core (`/api/v1/…` through the proxy, with `compose.api-public.yaml`):

| Operation | Scope | Route |
| --- | --- | --- |
| `writeback` | capture | `POST /writeback` |
| `recall` | read | `POST /recall` |
| `record_usage` | write | `POST /recalls/{request_id}/usage` |
| `review_queue` | read | `GET /review-queue` |
| `list_memories` | read | `GET /memories` |
| `get_memory` | read | `GET /memories/{memory_id}` |
| `review_memory` | write | `PATCH /memories/{memory_id}/review` |
| `get_recall` | read | `GET /recalls/{request_id}` |

The request and answer bodies keep the old server's contract: the `openbrain.agent_memory.*.v1` versions and OpenClaw's `openbrain.openclaw.*.v1` aliases. The trust model is [Safe Agent Memory and Provenance](../../docs/safe-agent-memory-provenance.md).

**What changed from the standalone server:**
- **Routes.** `/recall/:request_id/usage` is `/recalls/{request_id}/usage`, `/recall-traces/:request_id` is `/recalls/{request_id}`, and `/memories/review` is `/review-queue`. There is no `/health`: the REST core's own `/health` is the one to probe.
- **Keys.** A capture-only key can write back (it could not reach the old server at all). It cannot recall, which reads. A write key is still the one whose recalls are traced, and the one that reports usage and reviews.
- **The embedding provider** is the brain's, through the core. While it does not answer, a recall is refused `PROVIDER_UNAVAILABLE` (503, retryable): send it again. A write-back keeps its memories all the same, and recall finds them once the brain's vector mender has filled their thoughts' vectors in. The old server failed either with a 500.
- **A recall that finds nothing** answers no memories. The old server answered the workspace's newest memories when the search found no thought at all.
- **An edit's text** is captured as a thought of its own, which the memory then names. The old server changed the memory row alone, so a recall kept finding it by its old text. The old thought stays: the core keeps one thought per text, so it may be another memory's too.
- **Answers.** Every memory carries its `memory_type`, `thought_id`, `review_status` and `lifecycle_status` beside the old fields, and `related_artifacts` lists its artifact. `get_memory` and `review_memory` answer that shape too, where the old server answered the raw row. A refusal is the plugin's code (`NO_SUCH_MEMORY`, `UNSAFE_WRITEBACK`, …), not an `error` string.
- **Artifacts.** An `artifact_reference` memory keeps its own artifact. The old server gave each one every artifact of its write-back.
- **The thought's metadata** is six flat `agent_memory_*` keys. The old server wrote `source_type`, `topics`, `people` and a nested `agent_memory` object, which a capture through the core does not take: the core's extractor gives the thought its topics and people.
- **Bounds.** Each memory is at most 16,384 characters (over 15,000 is refused as transcript-like, as before), a label or id 200, a uri 4,096, and each list 50 items.

## Prerequisites

- A working brain stack (`deploy/compose.yaml`), as [SETUP.md](../../SETUP.md) brings it up.
- A key for each runtime: `bun keygen.ts --name <runtime> --scope write` in `server-portable/` prints the key, and a line to add to `MCP_ACCESS_KEYS` in `deploy/.env`. Add it before step 2, which recreates the servers that read it. A capture key can write back alone; a read key can recall and list alone.

## Turn it on

1. **Turn the plugin on.** Add it to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all. Names in `OB1_PLUGINS` are comma-separated.

   ```
   OB1_PLUGINS=agent-memory
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   With a model provider that is not local, the egress policy decides whether a capture's or a search's text may leave for it, and the default (`deny`) lets nothing out that no term allows. Allow each runtime's key by its name, beside any terms already there: `OB1_EGRESS_ALLOW=actor:<key name>`. Without it a recall is refused (`422 CORE_REFUSED`, `refused: REFUSED_EGRESS`), and a write-back's memories are kept with no vector, which the vector mender fills in once the term is there ([deploy/.env.example](../../deploy/.env.example), "What may leave the box").
2. **Recreate the services so they read it.** From `deploy/`, run `docker compose up -d migrate api mcp`, then `docker compose up -d --force-recreate --no-deps app`, each with the stack's other `-f` files.
   - The migrator makes the plugin's role, its schema and its login role `ob1_plugins_agent_memory`, and applies `001_memories.sql`.
   - Recreating `app` signs everyone out of the GUI: its sessions live in its memory.
3. **Check it.**
   - The REST core's preflight, at the top of its log (`docker compose logs api`): its `plugin tables` row says the role, schema and migrations are in place.
   - Write a memory back, then recall it with `include_unconfirmed`:

     ```bash
     curl -sS -X POST "https://<host>/api/v1/plugins/agent-memory/writeback" -H "x-brain-key: $KEY" -H 'content-type: application/json' \
       -d '{"schema_version":"openbrain.agent_memory.writeback.v1","workspace_id":"demo","memory_payload":{"lessons":["Run the migrator before the REST core."]}}'
     curl -sS -X POST "https://<host>/api/v1/plugins/agent-memory/recall" -H "x-brain-key: $KEY" -H 'content-type: application/json' \
       -d '{"schema_version":"openbrain.agent_memory.recall.v1","workspace_id":"demo","query":"what runs first","scope":{"include_unconfirmed":true}}'
     ```

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. The plugin's tables and rows stay, and come back when it is turned on again; the memories' thoughts stay in the brain either way.

## Moving from the standalone server

The standalone server (`integrations/agent-memory-api`) kept its memories in eight public tables, `agent_memories` and seven `agent_memory_*` beside it (`schemas/agent-memory`). Their thoughts stay as they are, and recall finds them once the memories are copied across: the plugin starts with empty tables. Stop the old server first, and point each runtime at the plugin's routes.

The block below copies the old tables into the plugin's, column for column. Run it as the database owner in `psql`: on the compose stack, from `deploy/`, pipe it to `docker compose exec -T postgres psql -U postgres -d openbrain`. It is one transaction, so a refused row copies nothing and the block can be run again. A row already in the plugin's tables, by id or by idempotency key, is left as it is, and so is anything hanging off a memory that was left:

```sql
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO plugin_agent_memory.memories (id, thought_id, workspace_id, project_id, channel_kind, channel_id, channel_thread_id, visibility, memory_type, summary, content,
    lifecycle_status, provenance_status, confidence, created_by, runtime_name, runtime_version, provider, model, task_id, flow_id, can_use_as_instruction,
    can_use_as_evidence, requires_user_confirmation, review_status, last_confirmed_at, stale_after, idempotency_key, content_hash, metadata, created_at, updated_at)
  SELECT id, thought_id, workspace_id, project_id, channel_kind, channel_id, channel_thread_id, visibility, memory_type, summary, content,
    lifecycle_status, provenance_status, confidence, created_by, runtime_name, runtime_version, provider, model, task_id, flow_id, can_use_as_instruction,
    can_use_as_evidence, requires_user_confirmation, review_status, last_confirmed_at, stale_after, idempotency_key, content_hash, metadata, created_at, updated_at
    FROM public.agent_memories
ON CONFLICT DO NOTHING;
CREATE TEMP TABLE copied ON COMMIT DROP AS
  SELECT o.id FROM public.agent_memories o JOIN plugin_agent_memory.memories n USING (id) WHERE n.created_at = o.created_at;
INSERT INTO plugin_agent_memory.source_refs (id, memory_id, source_kind, uri, title, source_timestamp, metadata, created_at)
  SELECT id, memory_id, source_kind, uri, title, source_timestamp, metadata, created_at FROM public.agent_memory_source_refs WHERE memory_id IN (SELECT id FROM copied)
ON CONFLICT DO NOTHING;
INSERT INTO plugin_agent_memory.artifacts (id, memory_id, artifact_kind, uri, description, metadata, created_at)
  SELECT id, memory_id, artifact_kind, uri, description, metadata, created_at FROM public.agent_memory_artifacts WHERE memory_id IN (SELECT id FROM copied)
ON CONFLICT DO NOTHING;
INSERT INTO plugin_agent_memory.relations (id, from_memory_id, to_memory_id, relation, confidence, metadata, created_at)
  SELECT id, from_memory_id, to_memory_id, relation, confidence, metadata, created_at FROM public.agent_memory_relations
   WHERE from_memory_id IN (SELECT id FROM copied) AND to_memory_id IN (SELECT id FROM copied)
ON CONFLICT DO NOTHING;
INSERT INTO plugin_agent_memory.review_actions (id, memory_id, action, actor_id, actor_label, notes, before, after, created_at)
  SELECT id, memory_id, action, actor_id, actor_label, notes, before, after, created_at FROM public.agent_memory_review_actions WHERE memory_id IN (SELECT id FROM copied)
ON CONFLICT DO NOTHING;
INSERT INTO plugin_agent_memory.recall_traces (id, request_id, workspace_id, project_id, runtime_name, runtime_version, task_id, flow_id, channel_kind, channel_id,
    query, schema_version, request_payload, response_policy, created_at)
  SELECT id, request_id, workspace_id, project_id, runtime_name, runtime_version, task_id, flow_id, channel_kind, channel_id,
    query, schema_version, request_payload, response_policy, created_at FROM public.agent_memory_recall_traces
ON CONFLICT DO NOTHING;
INSERT INTO plugin_agent_memory.recall_items (id, trace_id, memory_id, rank, similarity, ranking_score, returned, used, ignored_reason, use_policy_snapshot, created_at)
  SELECT id, trace_id, memory_id, rank, similarity, ranking_score, returned, used, ignored_reason, use_policy_snapshot, created_at FROM public.agent_memory_recall_items
   WHERE memory_id IN (SELECT id FROM copied) AND trace_id IN (SELECT id FROM plugin_agent_memory.recall_traces)
ON CONFLICT DO NOTHING;
INSERT INTO plugin_agent_memory.audit_events (id, event_type, workspace_id, project_id, memory_id, trace_id, actor_kind, actor_label, runtime_name, task_id, payload, created_at)
  SELECT id, event_type, workspace_id, project_id,
         CASE WHEN memory_id IN (SELECT id FROM copied) THEN memory_id END,
         CASE WHEN trace_id IN (SELECT id FROM plugin_agent_memory.recall_traces) THEN trace_id END,
         actor_kind, actor_label, runtime_name, task_id, payload, created_at FROM public.agent_memory_audit_events
ON CONFLICT DO NOTHING;
COMMIT;
```

- **Which memories.** All of them. A memory whose thought was deleted (its `thought_id` null) is copied too, and listed, but never recalled: a recall finds memories through their thoughts.
- **Left as it is.** A memory the plugin already holds, by id or by idempotency key (a runtime that wrote the same memory back to the plugin first), is not copied, and nor are its sources, artifacts, relations, reviews or recall items. Its audit rows are copied without the memory's id.
- **The old tables** stay, and nothing reads them once the server is stopped. Drop them by hand once the copy is checked; `db/config.mjs` no longer grants them to a `--grant` role, and a grant made before stays until they are dropped.

## Troubleshooting

- **`400 NO_MEMORIES`.** `memory_payload` held no memory: every list was empty.
- **`400 REFUSED_INPUT`.** The body was not the contract's: `issues` names each field. The versions are the four `schema_version` strings above; a field past its bound is named too.
- **`403 FORBIDDEN`.** The key's scope does not reach the operation: recall and the lists read (a capture key cannot), and usage and review write (a read or capture key cannot).
- **`404 NO_SUCH_MEMORY` or `NO_SUCH_RECALL`.** No memory has that id, or no traced recall that `request_id`. A recall made under a read key is never traced, and its `request_id` is null.
- **`409 IDEMPOTENCY_KEY_REUSED`.** The write-back's `idempotency_key` already holds a memory with other text. Give each write-back its own key, or none (a key is then made from the workspace, runtime, task, step and the memory's text).
- **`422 UNSAFE_WRITEBACK`.** A memory looked like a private key, an API key, a credential, a large code block or a transcript; `unsafe` says which and why. Nothing was written. Write back a compact summary and artifact links instead.
- **`422 CORE_REFUSED`.** The core refused a capture or the search, and `refused` names its code: `REFUSED_EGRESS` is the egress policy keeping a recall's query in ("Turn it on", step 1). A refusal the core says is worth retrying is answered `503` instead. A write-back refused part way keeps the memories before the refused one, so the same write-back sent again once the cause is fixed finishes it.
- **`503 PROVIDER_UNAVAILABLE`** (retryable). The brain's embedding provider did not answer a recall's query (`reason` and `base` say why and where). Send the recall again.
- **A recall answers no memories.** The memories are still waiting for review (send `scope.include_unconfirmed: true`, or confirm them), are another project's (`scope.project_only: false`), are personal (`scope.visibility: "personal"`), or are stale, rejected, superseded or disputed (`scope.include_stale: true`).
