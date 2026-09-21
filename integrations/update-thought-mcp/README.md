# Update Thought MCP

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@txcfi-scott](https://github.com/txcfi-scott)**

> Standalone MCP Edge Function that adds an `update_thought` tool with optional `if_unchanged_since` optimistic concurrency for multi-writer setups.

## What It Does

The core Open Brain MCP server captures, searches, lists, and summarises thoughts but does not expose an update path. This integration adds a single new tool, `update_thought`, deployable as a separate Supabase Edge Function and registered as its own custom connector alongside your main Open Brain connector.

The tool supports three arguments:

- `content` — when provided, overwrites the thought's text and regenerates its embedding via OpenRouter.
- `metadata_patch` — shallow-merged into the existing `metadata` JSONB. Keys not present in the patch are left alone.
- `if_unchanged_since` — optional ISO 8601 timestamp. When supplied, the update is rejected with `STALE_READ` if the stored `updated_at` has advanced past that reference. Omit for last-write-wins behaviour (backward compatible).

On this fork the tool is one call to the database's `update_thought` (`db/migrations/033`), not a read followed by a raw update of the row. That is what keeps the thought whole: the content fingerprint follows the text (so the next capture of the same text is recognised as a duplicate, `db/migrations/003` and `018`), the model label follows the vector (`021`, what preflight and the re-embed read), the previous vector's chunk rows go (`022`), the patch is shallow-merged into `metadata` inside the function, and `if_unchanged_since` is decided under the row's lock rather than against a read a moment earlier. Two more answers come from the function: `DUPLICATE_CONTENT`, when the new text is already another thought's (edit that one instead), and a note when another row holds a stale fingerprint for the text. FORK.md change 69 (SMD-1228); `extensions/test-writes.ts` drives the tool against Postgres and compares the row with one `update_thought` edited directly. The vectors these writers make are `openai/text-embedding-3-small`'s, 1536 wide, so the brain must be built at that model and width (`OB1_EMBEDDING_MODEL=openai/text-embedding-3-small`, `OB1_EMBEDDING_DIM=1536` — upstream's Supabase brain is); on this fork's default, `qwen3-embedding:4b` at 1024, the function refuses the vector and the whole capture or edit fails — loudly, where the raw write failed the same way or had its error ignored. Since FORK.md change 103 (SMD-1541) the audit row the edit leaves (`thought_audit`, `db/migrations/008`; the trigger's body is `025`'s) names the key that made it — its `MCP_ACCESS_KEYS` name, or `MCP_ACCESS_KEY` under the older single key — where before it named nobody; since migration `045` (SMD-1730) the row also names this server as its `origin`.

Why it matters: once more than one agent writes to the same Open Brain (Claude Desktop, Codex, a background worker, etc.), last-write-wins silently drops concurrent edits. Optimistic concurrency is the cheapest fix — pass the `updated_at` you read, and the server rejects the write if something changed in between.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Supabase CLI installed (`npm i -g supabase` or your preferred method)
- [Deno](https://deno.land/) runtime available locally for type-checking (optional but recommended)
- OpenRouter API key (only required when your callers pass `content` — needed for re-embedding)

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

```text
UPDATE THOUGHT MCP -- CREDENTIAL TRACKER
--------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Project URL:              ____________
  Service role key:         ____________
  OpenRouter API key:       ____________
  MCP access key:           ____________

GENERATED DURING SETUP
  Update Thought URL:       https://<project>.supabase.co/functions/v1/update-thought-mcp
  Custom connector name:    Open Brain — Update

--------------------------------------
```

## Steps

> **Runs under Bun, not as an Edge Function.** This function imports the repository's SQL shim (`compat/supabase-sql`, which imports `bun`) and `compat/deno-on-bun.ts`, the two Deno globals it uses on Bun (FORK.md change 74), so `supabase functions deploy` cannot bundle it; from a checkout of this repository it serves on `PORT` (8000 unset — podman's `gvproxy` holds that port on macOS, so set one):
>
> ```bash
> PORT=8787 NODE_PATH=extensions/node_modules SUPABASE_URL='postgres://user:password@host:5432/openbrain' MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' OPENROUTER_API_KEY='…' bun integrations/update-thought-mcp/index.ts
> ```
>
> `SUPABASE_URL` carries the Postgres connection string (the shim's convention; `SUPABASE_SERVICE_ROLE_KEY` may be left unset), and the other variables are the secrets the steps below set, passed as environment — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts it this way in CI. The Supabase steps below apply to the file after `bun scripts/migrate-to-sql-shim.mjs --revert integrations/update-thought-mcp/index.ts`, which puts it back on supabase-js.

### 1. Create the Edge Function in your project

From the root of your local Open Brain repo (the one you set up during getting-started):

**1. Create the function folder:**

```bash
supabase functions new update-thought-mcp
```

**2. Copy the integration code:**

```bash
curl -o supabase/functions/update-thought-mcp/index.ts \
  https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/integrations/update-thought-mcp/index.ts
curl -o supabase/functions/update-thought-mcp/deno.json \
  https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/integrations/update-thought-mcp/deno.json
mkdir -p supabase/functions/_shared
curl -o supabase/functions/_shared/auth.ts \
  https://raw.githubusercontent.com/MHarris-SgyMd/OB1/main/integrations/_shared/auth.ts
```

The third file is the access-key module the function imports from `../_shared/auth.ts` — the core server's, copied so Supabase bundles it (`supabase/functions/_shared/` ships with every function; if you already have it from another server on this fork, it is the same file).

### 2. Set environment variables

Reuse the same secrets as the core Open Brain server:

```bash
supabase secrets set \
  OPENROUTER_API_KEY="your-openrouter-key" \
  MCP_ACCESS_KEYS="laptop:write:<sha256-of-your-key>"
```

`MCP_ACCESS_KEYS` holds one `name:scope:sha256` entry per client — the hash, never the key; mint one as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows. The older single `MCP_ACCESS_KEY` still works, compared by digest. The secret is project-wide — one `MCP_ACCESS_KEYS` for every function in the project — so set the whole list, your existing entries plus this one, comma-separated. Use a `write` key: `update_thought` is registered only for one, so a `read` key connects to a server with no tools at all.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by the platform.

### 3. Deploy

```bash
supabase functions deploy update-thought-mcp --no-verify-jwt
```

### 4. Register the connector in Claude Desktop

Open **Settings → Connectors → Add custom connector** and paste:

```
https://<project>.supabase.co/functions/v1/update-thought-mcp?key=<your-key>
```

Name it something distinct from your main Open Brain connector (e.g. `Open Brain — Update`) so the tool shows up clearly in your tool list.

### 5. Verify

Ask Claude: `Call the update_thought tool with id = "<uuid-from-your-db>" and metadata_patch = {"reviewed": true}.` You should see a success message and the thought's `updated_at` timestamp advance.

To verify optimistic concurrency:

1. Read a thought and note its `updated_at` (call it T0).
2. Call `update_thought` with `if_unchanged_since = T0` — it succeeds. `updated_at` is now T1.
3. Call `update_thought` again with `if_unchanged_since = T0` — it is rejected with `STALE_READ`.

## Expected Outcome

- A new Edge Function at `https://<project>.supabase.co/functions/v1/update-thought-mcp`.
- A custom connector registered in your AI client that exposes exactly one tool, `update_thought`.
- Updating an existing thought replaces its content, re-embeds it, or merges a metadata patch.
- When `if_unchanged_since` is passed, the server rejects writes that would overwrite a concurrent change with a `STALE_READ` error, giving the caller a clear signal to re-fetch and retry.

The [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) covers how to manage your tool surface area once you add this (and any other) custom connector.

## Troubleshooting

**Issue: Tool call returns `401 Invalid or missing access key`**
Solution: Make sure the `?key=` parameter in your connector URL is the **key** whose hash sits in the `MCP_ACCESS_KEYS` secret (the URL carries the key, the secret its hash). If you rotate the key, update the secret's entry and the connector URL. A `read`-scoped key authenticates but is given no tool — the connector shows nothing to call.

**Issue: `OPENROUTER_API_KEY is not set on this Edge Function; content updates cannot re-embed.`**
Solution: This appears only when a caller passes `content`. Set the secret (`supabase secrets set OPENROUTER_API_KEY=...`) and re-deploy. Updates that only pass `metadata_patch` work without an embedding provider.

**Issue: Updates always succeed even though I expected `STALE_READ`**
Solution: `if_unchanged_since` is optional. Confirm you are actually passing it, and that the timestamp you read was the thought's `updated_at` (not `created_at`). `update_thought` compares at millisecond precision, which is what a JavaScript `Date` carries, so passing back exactly what you read passes; `updated_at` moves on every write through the function.

**Issue: `DUPLICATE_CONTENT: another thought already holds this exact text`**
Solution: The new content normalises to text another thought already holds (`db/migrations/003`'s rule: whitespace collapsed, case folded). Edit that thought, or delete it first — two rows with one fingerprint is what the rule exists to prevent.

## Attribution

Adapted from a multi-participant capture design used across live Claude / ChatGPT / Codex sessions. Released here as a standalone integration so any Open Brain user can opt in without touching the core server.
