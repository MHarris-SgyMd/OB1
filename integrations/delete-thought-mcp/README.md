# Delete Thought MCP

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@txcfi-scott](https://github.com/txcfi-scott)**

> Standalone MCP server that adds a `delete_thought` tool — hard-deletes a thought by UUID with a pre-flight fetch and a clear confirmation response.

## What It Does

The core Open Brain MCP server exposes capture/search/list/stats tools but has no delete path. As a result, thoughts accumulate forever — there is no way for an AI client to remove a test entry, a duplicate, or something captured in error without dropping into psql.

This integration runs a second MCP server that exposes exactly one tool, `delete_thought(id)`. It is a hard delete (the row is removed), with a pre-flight existence check so the caller sees a distinct "not found" outcome rather than a silent success.

**Recovery:** this is a hard delete, not a soft delete. Recovery depends on your database's backups (`pg_dump` from the reference stack: `deploy/README.md`, "What is reachable from where"). If you need recoverable deletes, install the companion `schemas/thought-audit` schema and extend this function to write an audit row with the prior content before the delete — see the "Audit hook" section below.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- [Bun](https://bun.sh) 1.4+ and a checkout of this repository ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/))

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
DELETE THOUGHT MCP -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Postgres URL:             ____________  (SUPABASE_URL — the shim's name for it)
  MCP access key:           ____________

GENERATED DURING SETUP
  Delete Thought URL:       http://your-host:8787/mcp  (behind HTTPS for a hosted client)
  Custom connector name:    Open Brain — Delete

--------------------------------------
```

## Steps

### 1. Run the server

This server runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and the access-key module from `../_shared/auth.ts` beside it (the core server's — the same file every server on this fork shares), and is Bun-native — `process.env` for its environment, a default-exported `{ port, fetch }` that `bun` serves (FORK.md change 74; SMD-1799) — one HTTP process, as every server here is. From a checkout of this repository ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) walks every step):

```bash
(cd extensions && bun install)   # once: the pinned hono, zod and MCP SDK
PORT=8787 NODE_PATH=extensions/node_modules \
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' \
bun integrations/delete-thought-mcp/index.ts
```

`SUPABASE_URL` carries the Postgres connection string (the shim's convention; `SUPABASE_SERVICE_ROLE_KEY` may be left unset); `PORT` unset is 8000, which the core server holds — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts it this way in CI.

### 2. Set the access key

`MCP_ACCESS_KEYS` holds one `name:scope:sha256` entry per client — the hash, never the key; mint one as [Run a Remote MCP Server, Step 3](../../primitives/deploy-remote-mcp/README.md#step-3-mint-an-access-key) shows. The older single `MCP_ACCESS_KEY` still works, compared by digest. The list is this server's own environment: reuse the core server's lines or give this server its own. Use a `write` key: `delete_thought` is registered only for one, so a `read` key connects to a server with no tools at all.

### 3. Put it behind HTTPS

Your **MCP Server URL** is `http://your-host:8787/mcp`. A client on this machine (Claude Code) takes it as is; a hosted connector (Claude Desktop, ChatGPT) dials from the vendor's side and needs the HTTPS form — the same TLS proxy or tunnel that fronts the core server ([Run a Remote MCP Server, Step 5](../../primitives/deploy-remote-mcp/README.md#step-5-put-it-behind-https)).

### 4. Register the connector

In Claude Desktop: **Settings → Connectors → Add custom connector**, paste:

```
https://your-host/mcp?key=<your-key>
```

(For Claude Code on this machine: `claude mcp add --transport http open-brain-delete http://127.0.0.1:8787/mcp --header "x-brain-key: <your-key>"`.)

Use a distinct connector name (e.g. `Open Brain — Delete`) so the tool is easy to spot in your tool list.

### 5. Verify

Ask Claude: `Call the delete_thought tool with id = "<some-uuid>".`

Run through this short verification sequence:

1. Capture a throwaway thought and copy its id from the response.
2. Call `delete_thought` with that id — you should see `Deleted thought <id> (prior content length: N chars).`
3. Call `delete_thought` with the same id again — you should see `Thought not found: <id>` with `isError: true`.
4. Confirm the row is gone: `select count(*) from thoughts where id = '<id>';` answers 0.

## Expected Outcome

- A second MCP server at `http://your-host:8787/mcp` — behind HTTPS for a hosted client.
- A custom connector in your AI client that exposes exactly one tool, `delete_thought`.
- Invoking the tool with a valid UUID removes that row from the `thoughts` table and returns a confirmation.
- Invoking with a non-existent UUID returns a clear `Thought not found: <id>` error.

The [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) explains how to manage your tool surface area as you add this and other custom connectors.

## Audit Hook (optional)

If you also install `schemas/thought-audit`, extend this function to write an audit row before the delete so the prior `content`, `metadata`, and `created_at` are preserved in `thought_audit` for recovery or historical audit queries. A minimal sketch:

```ts
// Before the delete call:
await supabase.from("thought_audit").insert({
  thought_id: id,
  action: "delete",
  diff: {
    previous_content: existing.content,
    previous_metadata: existing.metadata ?? null,
  },
  actor_context: { origin: "mcp:delete_thought" },
});
```

Left out of the base integration to keep its dependencies to a single table.

## Troubleshooting

**Issue: Tool call returns `401 Invalid or missing access key`**
Solution: Confirm the `?key=` in your custom connector URL is the **key** whose hash sits in the `MCP_ACCESS_KEYS` secret (the URL carries the key, the secret its hash). If you rotate the key, update the secret's entry and the connector URL. A `read`-scoped key authenticates but is given no tool — the connector shows nothing to call.

**Issue: `delete_thought error: permission denied for table thoughts`**
Solution: Ensure your service role has DELETE permission on `public.thoughts`. The getting-started guide grants this in Step 2.5 — re-run `grant select, insert, update, delete on table public.thoughts to service_role;` in the SQL editor if it was missed.

**Issue: Tool succeeds but the row is still visible in the Table Editor**
Solution: The Table Editor caches results. Reload the page, or run `select id from thoughts where id = '<uuid>'` directly in the SQL Editor to confirm the row is gone.

## Attribution

Adapted from a multi-participant capture design used across live Claude / ChatGPT / Codex sessions. Released as a standalone integration so any Open Brain user can opt in without modifying the core server.
