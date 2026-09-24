# Extension Generator Spec

This document is a machine-readable specification for generating new Open Brain extensions. An AI agent given this spec and a description of the desired extension should be able to produce all required files in a single pass.

## Required Output Files

Every extension produces exactly four files in `extensions/{extension-slug}/`:

| File | Purpose |
|------|---------|
| `README.md` | Human-readable setup guide (follows template below) |
| `metadata.json` | Machine-readable metadata (follows schema below) |
| `schema.sql` | PostgreSQL tables, indexes, RLS policies |
| `index.ts` | The MCP server — Bun-native, `bun index.ts` serves it (SMD-1799) |

---

## File 1: the packages (no file of its own)

An extension ships no import map or package.json: `bun extensions/<slug>/index.ts` resolves `hono`, `zod`, `@hono/mcp` and `@modelcontextprotocol/sdk` from `extensions/node_modules`, which `extensions/package.json` pins — one MCP stack across the tree, held by `extensions/test-auth.ts` (until SMD-1800 each extension carried a `deno.json` mirroring those pins for `deno check`). Import exactly those four by bare name; if the extension needs another package, add it to `extensions/package.json` (and to test-auth's `PACKAGES`) rather than beside the extension. No `@supabase/supabase-js`: the server imports the repository's SQL shim by relative path (File 4).

---

## File 2: metadata.json

Must validate against `/.github/metadata.schema.json`. Required fields:

```json
{
  "name": "Human-Readable Extension Name",
  "description": "One sentence. What capability does this add?",
  "category": "extensions",
  "author": {
    "name": "Author Name",
    "github": "github-username"
  },
  "version": "1.0.0",
  "requires": {
    "open_brain": true,
    "services": [],
    "tools": ["Bun 1.4+"]
  },
  "requires_primitives": ["deploy-remote-mcp", "remote-mcp"],
  "learning_order": null,
  "tags": ["at-least-one-tag"],
  "difficulty": "beginner | intermediate | advanced",
  "estimated_time": "30 minutes"
}
```

Rules:
- `requires_primitives` always includes `deploy-remote-mcp` (the run line, and its Step 3 mints the access key) and `remote-mcp`. Add others (e.g., `rls`, `shared-mcp`) only if the extension teaches those concepts.
- `learning_order` is only set for curated learning path extensions (1-6). Community extensions omit it.
- `services` lists external APIs beyond the brain's own Postgres and model provider (e.g., `["Gmail API"]`); `tools` names the runtime, `Bun 1.4+`.
- `tags` should include the extension's domain and difficulty-related terms.

---

## File 3: schema.sql

PostgreSQL DDL that runs against the brain's database with `psql -f`. Must follow these rules:

1. **Every table must have:**
   - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
   - `user_id UUID NOT NULL` — a plain column the server fills from `DEFAULT_USER_ID`; no `REFERENCES auth.users` (Supabase's table, absent here — SMD-1810)
   - `created_at TIMESTAMPTZ DEFAULT now() NOT NULL`

2. **Use `CREATE TABLE IF NOT EXISTS`** — safe to re-run.

3. **Include indexes** for columns that will be queried frequently (user_id + any filter columns).

4. **No row-level security, no `GRANT`, nothing from Supabase's `auth` schema.** Upstream's template enabled RLS with a policy on `auth.uid()`; this fork runs one operator's brain on plain Postgres (SMD-1716), the server scopes rows by `DEFAULT_USER_ID`, and `scripts/check-fork-consistency.ts` check 12 refuses `auth.*`, `service_role`, `authenticated`, `anon`, `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` in any `.sql` under the category directories (SMD-1810). A role other than the tables' owner is granted by `bun db/migrate.ts --grant`: add one row per table to `ROLE_GRANTS.extensions` in `db/config.mjs`, the matching rows to `db/README.md`'s grants table (the checker holds the two equal), and the file to `CONTRIB_SCHEMA_FILES` in `db/test-support.ts` so test-schema [49] applies it.

5. **Never modify the core `thoughts` table.** Adding new tables is fine. Referencing `thoughts` via foreign key is fine. Altering or dropping `thoughts` columns is not.

6. **No `DROP TABLE`, `TRUNCATE`, or unqualified `DELETE FROM`.**

7. **Use JSONB for flexible metadata fields** where the structure might vary (e.g., `details JSONB DEFAULT '{}'`).

8. **Add update triggers** if the table has `updated_at`:

   ```sql
   CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN
       NEW.updated_at = now();
       RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;
   ```

---

## File 4: index.ts

The MCP server, in this fork's Bun-native shape (SMD-1799; the Edge Function shape it replaced is FORK.md's history). Must follow this exact structure:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "../../compat/supabase-sql/index.ts"; // Bun's Postgres client in supabase-js's shape
// The core server's access keys: named, scoped, SHA-256-hashed entries in
// MCP_ACCESS_KEYS, compared timing-safe, each revocable on its own. _shared/
// auth.ts is server-portable/auth.ts, copied beside the extensions and held
// identical by extensions/test-auth.ts. Never
// compare a key with `!==` yourself (the fork's consistency check refuses it).
import { authenticateRequest, canWrite, type Principal } from "../_shared/auth.ts";

// --- Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL!; // a postgres:// connection string
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; // ignored by the shim; the credentials are in the URL

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// --- MCP Server ---
// Built per request, for the principal that authenticated: a tool that writes
// is registered only for a write-scoped key, so a read-scoped key (the one to
// put in a URL) does not see it in tools/list at all.
function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "extension-slug",
    version: "1.0.0",
  });

  // --- Tools ---
  // Register read tools with server.registerTool(); wrap each tool that
  // inserts, updates or deletes in `if (canWrite(principal)) server.registerTool(...)`.

  return server;
}

// --- Hono App with Auth ---
const app = new Hono();

app.all("*", async (c) => {
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: process.env.MCP_ACCESS_KEYS,
    MCP_ACCESS_KEY: process.env.MCP_ACCESS_KEY,
  });
  if (!principal) {
    return c.json({ error: "Invalid or missing access key" }, 401);
  }

  const transport = new StreamableHTTPTransport();
  await buildServer(principal).connect(transport);
  return transport.handleRequest(c);
});

// Bun serves the entry module's default export on PORT (8000 unset); the suites import `fetch`.
export default {
  port: Number(process.env.PORT || 8000),
  fetch: app.fetch,
};
```

### Tool Registration Pattern

Every tool follows this pattern:

```typescript
server.registerTool(
  "tool_name",
  {
    title: "Human-Readable Tool Name",
    description: "When should the AI use this tool? Be specific about triggers.",
    annotations: {
      readOnlyHint: true, // Set false for tools that create, update, or delete data.
      // For write tools, also include openWorldHint and destructiveHint.
    },
    inputSchema: {
      param_name: z.string().describe("What this parameter is for"),
      optional_param: z.number().optional().default(10),
    },
  },
  async ({ param_name, optional_param }) => {
    try {
      // Supabase query here
      const { data, error } = await supabase
        .from("table_name")
        .select("*")
        .eq("user_id", "USER_ID"); // See note below about user_id

      if (error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${error.message}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `Result: ${JSON.stringify(data)}` }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  }
);
```

### Tool Design Rules

1. **Every tool must return `{ content: [{ type: "text" as const, text: string }] }`**. Never return raw strings.
2. **Every tool must have a try/catch** that returns `isError: true` on failure.
3. **Tool descriptions should describe WHEN to use the tool**, not what it does technically. The AI reads these to decide which tool to call.
4. **Use Zod for input validation.** Every parameter needs `.describe()` for the AI to understand it.
5. **Every tool must include MCP annotations.** Use `readOnlyHint: true` for retrieval/search/reporting tools. For write tools, use `readOnlyHint: false`, `openWorldHint: false` when the write is scoped to your own tables, and `destructiveHint: false` unless the tool deletes, overwrites, or performs irreversible actions. ChatGPT uses this metadata to distinguish read tools from write actions.
6. **Minimum tools per extension:** one for adding data, one for retrieving/searching data.
7. **The service role key bypasses RLS.** If the extension uses RLS and needs user-scoped queries, the tool must accept a `user_id` parameter or derive it from context.

### Extensions That Need OpenRouter

If the extension uses embeddings or LLM extraction (like the core brain), add:

```typescript
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
```

And include the embedding/extraction helper functions from `server-portable/index.ts`.

---

## File 5: README.md

Must follow the template at `extensions/_template/README.md`. Key sections:

### The Bun Run (CRITICAL)

The README's "Run the MCP Server" step is the run every extension README has (`extensions/household-knowledge/README.md` is the model): `PORT=8787 bun extensions/{extension-slug}/index.ts` with `SUPABASE_URL` (a `postgres://` connection string) and `MCP_ACCESS_KEYS` set, the key minted as the [Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) primitive's Step 3 shows, and behind HTTPS for a hosted client as its Step 5 shows. There is nothing else to deploy: the fork's servers are Bun-native (SMD-1799), and `extensions/test-auth.ts` starts every one under `bun` in CI. The path in the command must match the extension's actual directory name.

### SQL Setup

Point users at their database, with the connection string the server will use:

```markdown
Run `schema.sql` against your Open Brain database:
`psql "$DATABASE_URL" -f extensions/{extension-slug}/schema.sql`.
```

### Test Prompts

Include 3-5 example prompts a user can try immediately after setup. These should demonstrate the core tools and produce visible results.

---

## Naming Conventions

| Thing | Pattern | Example |
|-------|---------|---------|
| Directory | `extensions/{kebab-case-name}/` | `extensions/household-knowledge/` |
| MCP server name | `{kebab-case-name}` | `household-knowledge` |
| Table names | `{snake_case}` | `household_items`, `household_vendors` |
| Tool names | `{snake_case}` | `add_household_item`, `search_items` |
| Connector name | Title Case | `Household Knowledge` |

---

## Validation Checklist

Before submitting, verify:

- [ ] `index.ts` imports only `hono`, `zod`, `@hono/mcp`, `@modelcontextprotocol/sdk` (from `extensions/package.json`), the SQL shim and `../_shared/auth.ts` — no supabase-js, no `deno.json`
- [ ] `metadata.json` validates against `/.github/metadata.schema.json`
- [ ] `schema.sql` uses `IF NOT EXISTS`, includes indexes, carries no RLS, no `auth.*` call and no `GRANT` to a Supabase role (check 12), and its tables are in `ROLE_GRANTS.extensions` and `CONTRIB_SCHEMA_FILES`
- [ ] `schema.sql` does NOT modify the `thoughts` table
- [ ] `index.ts` follows the exact server structure (imports, auth, Hono app)
- [ ] `index.ts` tools return `{ content: [{ type: "text" as const, text }] }` format
- [ ] `index.ts` tools have try/catch with `isError: true` error handling
- [ ] `README.md` includes the Bun run (`PORT=8787 bun extensions/{extension-slug}/index.ts`) with `SUPABASE_URL` and `MCP_ACCESS_KEYS`
- [ ] `README.md` includes test prompts
- [ ] No credentials, API keys, or secrets in any file
- [ ] No binary files over 1MB
- [ ] Directory name matches the path in the README's `bun` command

---

## Example Prompt for AI Agent

> Create a new Open Brain extension called "Reading List" that tracks books, articles, and papers. Users should be able to add items with title, author, URL, status (to-read, reading, finished), notes, and a rating. Include tools for adding items, searching by title/author/status, and getting stats on reading habits. Follow the AGENT_SPEC.md in extensions/_template/.

This prompt, combined with this spec, should produce all 5 files correctly formatted and ready for a PR.
