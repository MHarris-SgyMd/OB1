# Common Troubleshooting

Solutions for issues that come up across any Open Brain extension. If your problem is specific to one extension (e.g., a particular table or tool), check that extension's README instead. Every server here — the core server in its container, each extension server under `bun` — logs the cause of a refused request to its own output, so the first move is almost always to read it: `podman compose -f deploy/compose.yaml logs server` for the core server, the terminal the `bun` command runs in for an extension.

## Connection Issues

**"Cannot connect to the database" / `ECONNREFUSED` on start**
- `SUPABASE_URL` is the Postgres connection string (`postgres://user:password@host:5432/openbrain`) — the SQL shim keeps supabase-js's variable name, but the value is a database URL, not a `https://…supabase.co` project URL
- From a shell on the host, the compose stack's database is not published (`deploy/README.md`, "What is reachable from where"); an extension server on the host reaches it only when the stack came up with `-f deploy/compose.host-ports.yaml`, or through its own connection string
- The extension's tables are the connecting role's own when that role applied the schema; otherwise grant them with `bun db/migrate.ts --grant <role>`. No `auth.uid()` stub is needed (SMD-1810)

**"Getting 401 Unauthorized"**
- The URL or header must carry the **key**; the server's `MCP_ACCESS_KEYS` holds its **hash** — check that the two are that way round
- Double-check that the `?key=` value in your Connection URL matches your MCP Access Key exactly
- If using header-based auth (Claude Code): the extension servers and the core server (`server-portable/`) accept `x-brain-key`, `x-access-key` or `Authorization: Bearer <key>`, and try every form you send
- Do not use `mcp-remote` with `--header` for Cursor — use Cursor's native `url` field instead (see [Remote MCP Connection](../remote-mcp/))
- An entry in `MCP_ACCESS_KEYS` that is not `name:read|write|capture:<64 hex characters>` is ignored silently — `bun preflight.ts` in `server-portable/` with the same value in its environment prints the parse problem
- A key's scope is what you expect: a read-scoped key does not see the tools that write, and a server whose only tools write shows it nothing
- Try minting a new key: Step 3 of [Run a Remote MCP Server](../deploy-remote-mcp/), then restart the server with the new line and update your Connection URL

**"Tools don't appear in Claude Desktop"**
- The connector dials from Anthropic's side: the URL must be HTTPS and reachable from the internet (Step 5 of [Run a Remote MCP Server](../deploy-remote-mcp/)); `http://127.0.0.1:…` works only for a client on this machine
- Verify the connector is enabled for your conversation — click the "+" button at the bottom of the chat → Connectors → check the toggle
- Check that the MCP Connection URL is correct and includes `?key=your-access-key`
- Try removing and re-adding the connector in Settings → Connectors
- Start a new conversation after adding the connector
- Restart Claude Desktop after making changes

**"ChatGPT doesn't use the tools"**
- Confirm Developer Mode is enabled (Settings → Apps & Connectors → Advanced settings)
- Check that the connector is active for your current conversation in the tools/apps panel
- Be explicit: "Use the [tool_name] tool to [do thing]." ChatGPT often needs direct tool references the first few times before it picks up the habit.

## Server Issues

**The server won't start**
- `EADDRINUSE`: the port is taken. `PORT` unset is 8000 — the core server's, and on macOS podman's `gvproxy` holds it too. Pick another port.
- `Cannot find package 'hono'`: run `(cd extensions && bun install)` once; an integration or recipe server also needs `NODE_PATH=extensions/node_modules` on its command
- A missing environment variable: the server names it and exits. The extension's README lists what it reads.
- The core server exits with `preflight FAILED`: read the failing row — it names the setting and the fix (`deploy/README.md`, "Why the server runs preflight before serving")

**The server starts but tool calls error**
- Read the server's output: a failed tool call logs its cause there
- `relation "…" does not exist`: the extension's `schema.sql` did not run against the database `SUPABASE_URL` names
- `function auth.uid() does not exist`: a `schema.sql` from before SMD-1810, or one of your own with Supabase's policies — the files in this tree call no `auth.*` function; take the current file
- Vector width: a server that embeds through OpenRouter at 1536 dimensions refuses on a brain built at this fork's local default (1024); the README says which width it needs

## Database Issues

**"relation 'table_name' does not exist"**
- The extension's `schema.sql` wasn't run successfully
- Re-run it with `psql "$DATABASE_URL" -f extensions/<name>/schema.sql` (or paste it into whatever SQL client you use)
- Check for errors in the SQL output — common issues include missing the pgvector extension or running statements out of order

**"permission denied"**
- The role in `SUPABASE_URL` needs grants on the extension's tables; `bun db/migrate.ts --grant <role>` grants the core tables and, since SMD-1810, the extension and recipe tables too — the **extensions** and **recipes** groups (`db/README.md`, "Grants for a capturing role"). The schemas grant nothing themselves; a role that owns the tables needs nothing
- Check that `user_id` values are valid UUIDs

**"Foreign key violation" errors**
- Parent records must exist before creating child records (e.g., create a company before adding a job posting)
- Verify the referenced ID exists and belongs to the same `user_id`
- Check that you're using the correct UUID — copy-paste rather than typing
- Ensure foreign key constraints are not blocking inserts

## Performance Issues

**Tools work but responses are slow**
- The first capture or search after the stack starts loads the local models into memory (`qwen3-embedding:4b`, `qwen2.5:7b`) — seconds once, then fast
- A hosted provider (OpenRouter) adds a network round trip per embedding; a local Ollama on a machine without a GPU embeds slowly under load
- Check the server's output for a query that is slow on its own; `deploy/README.md` names the indexes the migrations build

**Search returns no results**
- Make sure you've added data first (the extension starts empty)
- Try broader search terms — most search tools use ILIKE which requires partial matches
- Check date ranges and filters — a common issue is filtering by a date range that doesn't include your data
- For semantic search, try asking the AI to "search with threshold 0.3" for a wider net

## Data Issues

**"Date parsing errors"**
- Ensure dates are in ISO 8601 format: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`
- The MCP server expects date strings, which PostgreSQL will parse
- For "N days from now" calculations, let the tool compute the date

**"Auto-calculated fields not updating"**
- Verify that the database trigger exists (check the schema.sql was run completely)
- Check that the tool completed successfully (look at the server's output)
- For date calculations, ensure the frequency/interval field has a value set
- For one-time tasks (null frequency), auto-calculated fields may remain null by design

## Getting More Help

- **The FAQ**: [`docs/03-faq.md`](../../docs/03-faq.md) covers the questions that come up most, ChatGPT's connector behaviour first among them.
- **OB1 Discord**: Join the [Open Brain Discord](https://discord.gg/Cgh9WJEkeG) — there's a `#help` channel for troubleshooting.

## Extensions That Use This

All extensions reference this guide for common issues:

- [Household Knowledge Base](../../extensions/household-knowledge/) (Extension 1)
- [Home Maintenance Tracker](../../extensions/home-maintenance/) (Extension 2)
- [Family Calendar](../../extensions/family-calendar/) (Extension 3)
- [Meal Planning](../../extensions/meal-planning/) (Extension 4)
- [Professional CRM](../../extensions/professional-crm/) (Extension 5)
- [Job Hunt Pipeline](../../extensions/job-hunt/) (Extension 6)
