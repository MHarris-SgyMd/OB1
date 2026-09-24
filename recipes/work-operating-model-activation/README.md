# Work Operating Model Activation

> A conversation-first workflow that interviews you about how your work actually runs, stores the answers as structured Open Brain data, and generates agent-ready operating files.
> [!NOTE]
> If you are coming from the Bring Your Own Context post or want the article-friendly entrypoint, start with [Bring Your Own Context](../bring-your-own-context/). This recipe is the structured profiling engine that BYOC uses under the hood.

## What It Does

This recipe adds a dedicated MCP server plus schema for a 45-minute elicitation workflow. The interview runs in five fixed layers:

1. operating rhythms
2. recurring decisions
3. dependencies
4. institutional knowledge
5. friction

Each approved layer is saved into structured tables, summarized into one durable Open Brain thought through your existing core connector, and made available for later querying and export generation.

This recipe depends on the canonical [Work Operating Model skill](../../skills/work-operating-model/), which owns the interview behavior. The recipe owns the data model, remote MCP server, and export snapshots. The higher-level [Bring Your Own Context](../bring-your-own-context/) recipe packages this workflow together with context extraction prompts and the portable bundle contract.

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- Existing core Open Brain connector with `search_thoughts` and `capture_thought`
- AI client that supports reusable skills or prompt packs
- [Bun](https://bun.sh) 1.4+ and a checkout of this repository — the server runs under Bun ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/))
- Canonical [Work Operating Model skill](../../skills/work-operating-model/)

## Credential Tracker

```text
WORK OPERATING MODEL ACTIVATION -- CREDENTIAL TRACKER
----------------------------------------------------

FROM YOUR OPEN BRAIN SETUP
  Postgres URL:          ____________  (SUPABASE_URL — the shim's name for it)
  MCP Access Key:        ____________
  Core Open Brain tools available:  yes / no

GENERATED DURING SETUP
  Default User ID:       ____________
  MCP Server URL:        ____________
  MCP Connection URL:    ____________
  Current profile version: ____________

----------------------------------------------------
```

## Steps

### 1. Install the skill dependency

Follow the installation steps in the [Work Operating Model skill](../../skills/work-operating-model/). The skill handles the interview, confirmation gates, contradiction pass, and summary-thought capture.

### 2. Run the schema

Run [`schema.sql`](./schema.sql) against your brain's database — `psql "$DATABASE_URL" -f recipes/work-operating-model-activation/schema.sql` (or paste it into Supabase's SQL Editor, if that is where your Postgres lives).

This creates:

- `operating_model_profiles`
- `operating_model_sessions`
- `operating_model_layer_checkpoints`
- `operating_model_entries`
- `operating_model_exports`

It also adds the helper RPC functions `operating_model_start_session()` and `operating_model_save_layer()` for atomic session and layer persistence.

### 3. Generate your default user ID

This recipe is single-user on purpose. Generate one UUID and reuse it for future sessions:

```bash
uuidgen | tr '[:upper:]' '[:lower:]'
```

Save it to your credential tracker; it goes on the run command in Step 4 as `DEFAULT_USER_ID`.

### 4. Run the MCP server

This server runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and the access-key module from `../_shared/auth.ts` (the copy in `recipes/_shared/`, the core server's), and is Bun-native — `process.env` for its environment, a default-exported `{ port, fetch }` that `bun` serves (FORK.md change 74; SMD-1799) — one HTTP process, as every server here is. From a checkout of this repository ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) walks every step):

```bash
(cd extensions && bun install)   # once: the pinned hono, zod and MCP SDK
PORT=8787 NODE_PATH=extensions/node_modules \
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
SUPABASE_SERVICE_ROLE_KEY=unused \
MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' \
DEFAULT_USER_ID='your-generated-uuid' \
bun recipes/work-operating-model-activation/index.ts
```

`SUPABASE_URL` carries the Postgres connection string (the shim's convention); this server refuses to start without `SUPABASE_SERVICE_ROLE_KEY`, so set it to any value — the shim ignores it. `PORT` unset is 8000, which the core server holds — see [Run a migrated server under Bun](../../compat/supabase-sql/README.md#3-run-a-migrated-server-under-bun). `extensions/test-auth.ts` starts it this way in CI. Your **MCP Server URL** is `http://your-host:8787/mcp`; a hosted connector needs the HTTPS form ([Run a Remote MCP Server, Step 5](../../primitives/deploy-remote-mcp/README.md#step-5-put-it-behind-https)).

- `MCP_ACCESS_KEYS` — `name:scope:sha256` entries, minted as [Run a Remote MCP Server, Step 3](../../primitives/deploy-remote-mcp/README.md#step-3-mint-an-access-key) shows (the older single `MCP_ACCESS_KEY` still works). Give the session a `write` key: `start_operating_model_session`, `save_operating_model_layer` and `generate_operating_model_exports` are registered only for one; a `read` key gets `query_operating_model` alone.
- `generate_operating_model_exports` returns all five artifact blobs even if no local files are written

## Troubleshooting

**Issue: `start_operating_model_session` says no environment variable is configured**
Solution: Verify `DEFAULT_USER_ID` is in the server's environment (the `bun` command in Step 4) and restart it.

**Issue: The skill can see the recipe connector but not `search_thoughts` or `capture_thought`**
Solution: This recipe does not replace the core Open Brain server. Re-enable your base connector alongside this one.

**Issue: Export generation fails with missing layers**
Solution: At least one approved checkpoint must exist for each of the five layers. Resume the session and finish the missing layer summaries before exporting.

**Issue: Querying by friction priority returns nothing**
Solution: `friction_priority` reads from `details.priority`, so the saved friction entries need `low`, `medium`, or `high` in that field.

## Next Steps

- Feed `USER.md`, `SOUL.md`, and `HEARTBEAT.md` into any agent platform that uses operating files.
- Re-run the workflow quarterly or after a major role change to create a new version.
- Use the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) once you add this server so your capture/query/admin tool surface stays manageable.
