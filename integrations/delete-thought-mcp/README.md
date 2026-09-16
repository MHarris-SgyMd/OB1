# Delete Thought MCP

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@txcfi-scott](https://github.com/txcfi-scott)**

> Standalone MCP Edge Function that adds a `delete_thought` tool — hard-deletes a thought by UUID with a pre-flight fetch and a clear confirmation response.

## What It Does

The core Open Brain MCP server exposes capture/search/list/stats tools but has no delete path. As a result, thoughts accumulate forever — there is no way for an AI client to remove a test entry, a duplicate, or something captured in error without dropping into the Supabase SQL editor.

This integration deploys a second Edge Function that exposes exactly one tool, `delete_thought(id)`. It is a hard delete (the row is removed), with a pre-flight existence check so the caller sees a distinct "not found" outcome rather than a silent success.

**Recovery:** this is a hard delete, not a soft delete. Recovery depends on your Supabase project's database backups (daily backups are available on paid tiers; Point-in-Time Recovery on higher tiers). If you need recoverable deletes, install the companion `schemas/thought-audit` schema and extend this function to write an audit row with the prior content before the delete — see the "Audit hook" section below.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Supabase CLI installed

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
DELETE THOUGHT MCP -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Project URL:              ____________
  Service role key:         ____________
  MCP access key:           ____________

GENERATED DURING SETUP
  Delete Thought URL:       https://<project>.supabase.co/functions/v1/delete-thought-mcp
  Custom connector name:    Open Brain — Delete

--------------------------------------
```

## Steps

> **Runs under Bun, not as an Edge Function.** This function imports the repository's SQL shim (`compat/supabase-sql`, which imports `bun`) and `compat/deno-on-bun.ts`, the two Deno globals it uses on Bun (FORK.md change 74), so `supabase functions deploy` cannot bundle it; from a checkout of this repository it serves on `PORT` (8000 unset — podman's `gvproxy` holds that port on macOS, so set one):
>
> ```bash
> NODE_PATH=extensions/node_modules SUPABASE_URL='postgres://user:password@host:5432/openbrain' MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' bun integrations/delete-thought-mcp/index.ts
> ```
>
> `SUPABASE_URL` carries the Postgres connection string (the shim's convention; `SUPABASE_SERVICE_ROLE_KEY` may be left unset), and the other variables are the secret Step 3 sets, passed as environment — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts it this way in CI. The Supabase steps below apply to the file after `bun scripts/migrate-to-sql-shim.mjs --revert integrations/delete-thought-mcp/index.ts`, which puts it back on supabase-js.

### 1. Create the Edge Function

From the root of your local Open Brain repo:

**1. Create the function folder:**

```bash
supabase functions new delete-thought-mcp
```

**2. Copy the integration code:**

```bash
curl -o supabase/functions/delete-thought-mcp/index.ts \
  https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/integrations/delete-thought-mcp/index.ts
curl -o supabase/functions/delete-thought-mcp/deno.json \
  https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/integrations/delete-thought-mcp/deno.json
mkdir -p supabase/functions/_shared
curl -o supabase/functions/_shared/auth.ts \
  https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/integrations/_shared/auth.ts
```

The third file is the access-key module the function imports from `../_shared/auth.ts` — the core server's, copied so Supabase bundles it (`supabase/functions/_shared/` ships with every function; if you already have it from another server on this fork, it is the same file).

### 2. Set environment variables

```bash
supabase secrets set MCP_ACCESS_KEYS="laptop:write:<sha256-of-your-key>"
```

`MCP_ACCESS_KEYS` holds one `name:scope:sha256` entry per client — the hash, never the key; mint one as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows. The older single `MCP_ACCESS_KEY` still works, compared by digest. The secret is project-wide — one `MCP_ACCESS_KEYS` for every function in the project — so set the whole list, your existing entries plus this one, comma-separated. Use a `write` key: `delete_thought` is registered only for one, so a `read` key connects to a server with no tools at all.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the Supabase platform.

### 3. Deploy

```bash
supabase functions deploy delete-thought-mcp --no-verify-jwt
```

### 4. Register the connector

In Claude Desktop: **Settings → Connectors → Add custom connector**, paste:

```
https://<project>.supabase.co/functions/v1/delete-thought-mcp?key=<your-key>
```

Use a distinct connector name (e.g. `Open Brain — Delete`) so the tool is easy to spot in your tool list.

### 5. Verify

Ask Claude: `Call the delete_thought tool with id = "<some-uuid>".`

Run through this short verification sequence:

1. Capture a throwaway thought and copy its id from the response.
2. Call `delete_thought` with that id — you should see `Deleted thought <id> (prior content length: N chars).`
3. Call `delete_thought` with the same id again — you should see `Thought not found: <id>` with `isError: true`.
4. Confirm in the Supabase Table Editor that the row is gone (reload the Table Editor if it still appears cached).

## Expected Outcome

- A new Edge Function at `https://<project>.supabase.co/functions/v1/delete-thought-mcp`.
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
