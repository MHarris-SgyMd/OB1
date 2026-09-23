# Agent Memory API

> Runtime-neutral recall, write-back, review, inspection, and trace API for OB1 Agent Memory.

```mermaid
sequenceDiagram
  participant Runtime as Agent runtime
  participant API as Agent Memory API
  participant OB1 as OB1 database
  participant Human as Human reviewer
  Runtime->>API: POST /recall
  API->>OB1: semantic search + policy ranking
  API-->>Runtime: scoped memories + use policy
  Runtime->>API: POST /writeback
  API->>API: block secrets/transcripts/reasoning dumps
  API->>OB1: store evidence-only memory
  Human->>API: PATCH /memories/:id/review
  API->>OB1: confirm/evidence-only/reject/scope
```

## What It Does

This API exposes the v1 OB1 Agent Memory contract. OpenClaw is the first launch runtime, but these endpoints are runtime-neutral and can be used by Codex, Claude Code, local agents, n8n, or future SQLite adapters.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- [`schemas/agent-memory`](../../schemas/agent-memory/) applied
- [Bun](https://bun.sh) installed, and a checkout of this repository (the API runs under Bun, Step 2)
- `OPENROUTER_API_KEY` and `MCP_ACCESS_KEYS` in the server's environment — `name:scope:sha256` entries, minted as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows (the older single `MCP_ACCESS_KEY` still works). The routes that write — `POST /writeback`, `POST /recall/:request_id/usage`, `PATCH /memories/:id/review` — answer 403 to a `read` key; recall and the listings serve either scope, but a recall under a `read` key stores no trace and returns `request_id: null`, so usage reporting needs a `write` key end to end.

## Credential Tracker

```text
AGENT MEMORY API -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Postgres URL (SUPABASE_URL): ____________
  MCP Access Key:             ____________
  OpenRouter API Key:         ____________

GENERATED DURING SETUP
  Agent Memory API URL:       ____________
  Agent Memory API URL + key: ____________

--------------------------------------
```

## Steps

![Step 1](https://img.shields.io/badge/Step_1-Install_the_Schema-1E88E5?style=for-the-badge)

Apply [`schemas/agent-memory/schema.sql`](../../schemas/agent-memory/schema.sql).

**Done when:** the `agent_memories` and `agent_memory_recall_traces` tables exist.

![Step 2](https://img.shields.io/badge/Step_2-Run_the_API-1E88E5?style=for-the-badge)

This API runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and is Bun-native — `process.env` for its environment, a default-exported `{ port, fetch }` that `bun` serves (SMD-1799) — so it is not a Supabase Edge Function and `supabase functions deploy` does not apply (FORK.md change 74; SMD-1798 moved this server — its two embeds were servable since change 77, and it waited on the deploy story). It imports the access-key module from `../_shared/auth.ts` (the copy in `integrations/_shared/`, the core server's). From a checkout of this repository:

```bash
(cd extensions && bun install)   # once: the pinned hono and zod the server imports
NODE_PATH=extensions/node_modules \
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='agent:write:<sha256-of-your-key>' \
OPENROUTER_API_KEY='…' \
PORT=8787 bun integrations/agent-memory-api/index.ts
```

`SUPABASE_URL` carries the Postgres connection string — the shim keeps the variable names, so the code does not change — and `SUPABASE_SERVICE_ROLE_KEY` may be left unset; `NODE_PATH` resolves `hono` and `zod` — all this API imports — from the pinned install, since an integration has no `node_modules` of its own ([Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun)). `OPENROUTER_API_KEY` embeds a recall's query and a write-back's memories. The server prints `Listening on http://localhost:8787/` (`PORT` unset, it listens on 8000, Deno's default — which podman's `gvproxy` also holds on macOS, hence 8787 here); the routes below are served at that root, and at `/agent-memory-api/…` too, the prefix Supabase gave them. To reach it from a hosted runtime, put it behind the same TLS proxy as the core server ([`SETUP.md`](../../SETUP.md)). `extensions/test-auth.ts` starts the server this way in CI, and `extensions/test-writes.ts` drives its routes against a real Postgres carrying `schemas/agent-memory` (SMD-1798).

**Done when:** the server prints its `Listening on` line.

![Step 3](https://img.shields.io/badge/Step_3-Test_Health-1E88E5?style=for-the-badge)

```bash
curl "http://localhost:8787/health?key=YOUR_MCP_ACCESS_KEY"
```

**Done when:** the response includes `"ok": true`.

## API Surface

The API accepts the runtime-neutral core schema versions and the OpenClaw launch aliases:

| Contract | Runtime-Neutral | OpenClaw Alias |
| -------- | --------------- | -------------- |
| Recall request | `openbrain.agent_memory.recall.v1` | `openbrain.openclaw.recall.v1` |
| Recall response | `openbrain.agent_memory.recall_response.v1` | `openbrain.openclaw.recall_response.v1` |
| Write-back request | `openbrain.agent_memory.writeback.v1` | `openbrain.openclaw.writeback.v1` |
| Write-back response | `openbrain.agent_memory.writeback_response.v1` | `openbrain.openclaw.writeback_response.v1` |

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Verify deployment |
| `/recall` | POST | Retrieve scoped memories before work starts (under a `read` key no trace is stored and `request_id` is `null`) |
| `/writeback` | POST | Save compact operational memory after work finishes — each memory's thought through the 3-argument `upsert_thought`, its vector and model label in the same call (FORK.md change 69; the vector is `openai/text-embedding-3-small`'s, so the brain must be at that model and width — 1536, not the fork's 1024 default — or every write-back fails whole); since change 103 (SMD-1541) the thought's audit row names the key that wrote back, with this server as the row's `origin` (since migration `046`, SMD-1730; `via` in its `actor_context` before it) and `runtime` (the runtime's name) in its `actor_context` |
| `/recall/:request_id/usage` | POST | Report which recalled memories were used or ignored |
| `/memories` | GET | List memories by workspace, project, status, runtime, type, or task prefix |
| `/memories/review` | GET | List pending agent-written memories |
| `/memories/:id` | GET | Inspect one memory with source/artifact details |
| `/memories/:id/review` | PATCH | Confirm, edit, reject, restrict, stale, dispute, or supersede |
| `/recall-traces/:request_id` | GET | Debug what was recalled and how it was used |

## Expected Outcome

An agent runtime can recall relevant context, write back compact memories, and leave a trace that explains what happened. Unsafe write-backs are blocked before durable storage.

The trust model is documented in [Safe Agent Memory and Provenance](../../docs/safe-agent-memory-provenance.md).

## Smoke Harness

Use the live smoke harness after starting the server or rotating a key, with a `write`-scoped key — the harness writes back first, then reports usage against the recall's `request_id`:

```bash
OB1_AGENT_MEMORY_ENDPOINT="http://localhost:8787" \
OB1_AGENT_MEMORY_KEY="YOUR_MCP_ACCESS_KEY" \
OB1_AGENT_MEMORY_WORKSPACE_ID="ob1-staging" \
OB1_AGENT_MEMORY_PROJECT_ID="agent-memory-api-smoke" \
node integrations/agent-memory-api/smoke/live-smoke.mjs
```

The harness checks health, write-back policy defaults, conservative recall gating, include-unconfirmed recall, usage reporting, review action, memory inspection, recall trace, and unsafe write-back blocking. It prints a JSON summary and never prints the access key.

For personal databases, use the cleanup harness to find or reject smoke/test memories without deleting rows:

```bash
OB1_AGENT_MEMORY_ENDPOINT="http://localhost:8787" \
OB1_AGENT_MEMORY_KEY="YOUR_MCP_ACCESS_KEY" \
OB1_AGENT_MEMORY_WORKSPACE_ID="ob1-staging" \
OB1_AGENT_MEMORY_TEST_PROJECT_IDS="agent-memory-api-smoke,agent-memory-openclaw-smoke" \
node integrations/agent-memory-api/smoke/cleanup-test-memory.mjs
```

The default mode is dry-run. Add `--apply` to mark matching active test memories as `rejected`. The harness refuses project IDs that do not look like smoke/test/sandbox scopes.

## Troubleshooting

**Issue: `Invalid or missing access key`**
Solution: Confirm the request includes the key — `?key=...`, `x-brain-key`, `x-access-key` or a bearer token — and that its SHA-256 hash is an entry in `MCP_ACCESS_KEYS` (the request carries the key, the secret its hash).

**Issue: `Forbidden: this key is read-scoped and this route writes`**
Solution: The key's entry in `MCP_ACCESS_KEYS` has scope `read`. Write-back, usage reporting and review need a `write` key.

**Issue: recall returns no memories**
Solution: Confirm write-back has created `agent_memories`, and that those memories are confirmed or `include_unconfirmed` is true.

**Issue: write-back blocked as unsafe**
Solution: Store a compact summary and artifact links. Do not submit raw transcripts, reasoning traces, secrets, or large code blocks.

## Tool Surface Area

This integration exposes an API that plugins can wrap as tools. See the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) before adding additional runtime-specific tool surfaces.
