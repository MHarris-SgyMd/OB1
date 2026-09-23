# Shared MCP Server

A guide to building scoped MCP servers that give other people limited access to specific parts of your Open Brain.

## When You Need This

You've built your Open Brain—a personal knowledge system with thoughts, contacts, goals, and work data. But now you want to share *part* of it with someone else:

- Your spouse needs access to meal plans and shopping lists
- A collaborator needs to see project tasks but not your personal notes
- A family member needs to update shared calendars without seeing your work
- A team member needs read-only access to specific documentation

You don't want to give them your entire MCP server with full database access. You need a **shared MCP server**—a separate server with scoped credentials, limited table access, and controlled permissions.

## The Security Model

A shared MCP server provides isolation through three layers:

### 1. Scoped Credentials

Create a separate database user/role with limited permissions:
- Different API key or database password
- Can only access specific tables
- Can be revoked without affecting your main server

### 2. Limited Table Access

Explicitly define which tables are available:
- Use Row-Level Security (RLS) policies
- Grant table-level permissions to the scoped role
- Hide sensitive tables entirely from the shared role

### 3. Read-Only vs Read-Write

Control operations per table:
- Some tables are read-only (view recipes, view meal plans)
- Some tables allow updates (shopping list items)
- Some tables allow inserts (adding new items)
- Sensitive operations (delete) can be blocked entirely

## Prerequisites

Before building a shared MCP server:

- Working Open Brain installation with your primary MCP server
- Supabase project (or PostgreSQL database with RLS support)
- Node.js 18+ installed
- Understanding of database roles and permissions
- The other person's Claude Desktop config access (or ability to share config)

## Build Guide

### Step 1: Decide What to Share

Create a mapping of tables and operations:

```
Table: meal_plans
  - Operations: SELECT
  - Why: Spouse can view planned meals

Table: recipes
  - Operations: SELECT
  - Why: Spouse can view recipe details

Table: shopping_list_items
  - Operations: SELECT, INSERT, UPDATE
  - Why: Spouse can view items and, with a write-scoped key, add and check them off

Table: thoughts (NOT SHARED)
Table: contacts (NOT SHARED)
Table: work_projects (NOT SHARED)
```

Be explicit. Default to not sharing unless there's a clear reason.

### Step 2: Create a Scoped Database Role

In Supabase SQL Editor (or via psql):

```sql
-- Create a new database role for shared access
CREATE ROLE household_member LOGIN PASSWORD 'secure_password_here';

-- Grant connection to the database
GRANT CONNECT ON DATABASE postgres TO household_member;

-- Grant usage on the schema
GRANT USAGE ON SCHEMA public TO household_member;

-- Grant specific table permissions
GRANT SELECT ON public.meal_plans TO household_member;
GRANT SELECT ON public.recipes TO household_member;
GRANT SELECT, INSERT, UPDATE ON public.shopping_list_items TO household_member;

-- Set up Row-Level Security (optional, for finer control)
ALTER TABLE shopping_list_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Household members see shared lists"
  ON shopping_list_items
  FOR SELECT
  TO household_member
  USING (household_id = current_setting('app.current_household')::uuid);

CREATE POLICY "Household members update shared lists"
  ON shopping_list_items
  FOR UPDATE
  TO household_member
  USING (household_id = current_setting('app.current_household')::uuid);
```

**For Supabase specifically**: Create a service role key with restricted permissions through the Supabase dashboard, or use connection pooling with different credentials.

### Step 3: Build a Separate MCP Server

Create a second server file beside the extension's — `extensions/<name>/shared-server.ts`, where the relative imports below resolve; the real one is `extensions/meal-planning/shared-server.ts`. It is a Bun-native Hono + MCP SDK server (SMD-1799) — the same pattern as the core Open Brain and all extensions.

```typescript
// extensions/<name>/shared-server.ts — a second, Bun-native server beside the extension's index.ts
import { Hono } from "hono";
// Deno reads the SDK's types through the extensionless subpath: its exports map
// names them `./dist/esm/*.d.ts`, unreachable from `.js` (FORK.md change 84).
// @ts-types="@modelcontextprotocol/sdk/server/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "../../compat/supabase-sql/index.ts"; // Bun's Postgres client in supabase-js's shape
import { authenticateRequest, canWrite } from "../_shared/auth.ts";

const app = new Hono();

app.post("/mcp", async (c) => {
  // Authenticate with SEPARATE access keys for the shared server — named,
  // scoped, hashed entries (see the core server's auth.ts); give a household
  // member a read-scoped key unless they should mark items purchased.
  const principal = authenticateRequest(c.req.raw, {
    MCP_ACCESS_KEYS: process.env.MCP_HOUSEHOLD_ACCESS_KEYS,
    MCP_ACCESS_KEY: process.env.MCP_HOUSEHOLD_ACCESS_KEY,
  });
  if (!principal) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Use SCOPED credentials — not the service role key
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_HOUSEHOLD_KEY!, // Limited key
  );

  const server = new McpServer(
    { name: "household-shared-server", version: "1.0.0" },
  );

  // Only expose tools for shared tables
  server.tool(
    "view_meal_plans",
    "View upcoming meal plans",
    { days: z.number().optional().describe("Number of days to view") },
    async ({ days }) => {
      const { data, error } = await supabase
        .from("meal_plans")
        .select("*")
        .gte("date", new Date().toISOString().split("T")[0])
        .order("date", { ascending: true })
        .limit(days || 7);

      if (error) throw error;
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "view_shopping_list",
    "View current shopping list",
    {},
    async () => {
      const { data, error } = await supabase
        .from("shopping_list_items")
        .select("*")
        .eq("purchased", false)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // Tools that write are registered only for a write-scoped key; a read-scoped
  // household member sees the view tools alone.
  if (canWrite(principal)) server.tool(
    "add_shopping_item",
    "Add item to shopping list",
    {
      item: z.string().describe("Item name"),
      quantity: z.string().optional().describe("Quantity"),
    },
    async ({ item, quantity }) => {
      const { data, error } = await supabase
        .from("shopping_list_items")
        .insert({ item, quantity: quantity || "1", purchased: false })
        .select();

      if (error) throw error;
      return { content: [{ type: "text", text: `Added: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  if (canWrite(principal)) server.tool(
    "update_shopping_item",
    "Mark shopping item as purchased",
    {
      id: z.string().describe("Item ID"),
      purchased: z.boolean().describe("Purchased status"),
    },
    async ({ id, purchased }) => {
      const { data, error } = await supabase
        .from("shopping_list_items")
        .update({ purchased })
        .eq("id", id)
        .select();

      if (error) throw error;
      return { content: [{ type: "text", text: `Updated: ${JSON.stringify(data, null, 2)}` }] };
    }
  );

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.get("/", (c) => c.json({ status: "ok", service: "Household Shared", version: "1.0.0" }));

// Bun serves the entry module's default export on PORT (8000 unset); the suites import `fetch`.
export default {
  port: Number(process.env.PORT || 8000),
  fetch: app.fetch,
};
```

### Step 4: Mint Separate Keys

The shared server's keys are its own environment, separate from the extension server's — there is no Supabase project holding secrets; the variables go on the `bun` command in Step 5:

```bash
# Mint a separate, named key for the shared server — read-scoped unless this
# member should add or check off items (Step 3 of the Deploy an Edge Function
# primitive shows the by-hand form). The HASH goes in MCP_HOUSEHOLD_ACCESS_KEYS;
# the key goes in the other person's connector URL. From a checkout, in a
# subshell so the cwd stays here:
(cd /path/to/your/OB1/checkout/server-portable && bun keygen.ts --name spouse --scope read)
```

The shared server reads `MCP_HOUSEHOLD_ACCESS_KEYS` (the older single `MCP_HOUSEHOLD_ACCESS_KEY` still works, compared by digest) and `SUPABASE_HOUSEHOLD_KEY`, which the SQL shim accepts and ignores — the credentials are in `SUPABASE_URL`, so the household's scope is the key's `read`/`write`, not a second database credential. No `package.json` of its own: `extensions/package.json` and the extension's `deno.json` pin the packages the file imports.

### Step 5: Run It as a Separate Server

The shared server is its own process on its own port, with its own keys — the extension's server never sees them:

```bash
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
SUPABASE_HOUSEHOLD_KEY='unused-by-the-shim' \
MCP_HOUSEHOLD_ACCESS_KEYS='partner:read:<sha256-of-the-shared-key>' \
PORT=8788 bun extensions/<name>/shared-server.ts
```

`bun extensions/meal-planning/shared-server.ts` is the real one (`extensions/test-auth.ts` starts it under `bun` in CI). The other person connects via Claude Desktop:

1. Open Claude Desktop → **Settings** → **Connectors**
2. Click **Add custom connector**
3. Name: `Household Shared`
4. Remote MCP server URL: `https://your-host/mcp?key=shared-access-key` — the shared server's port behind TLS, never the extension's
5. Click **Add**

**Key points:**
- They connect via URL — no Node.js, no config files, no terminal needed on their end
- They do NOT need access to your main MCP server or credentials
- You can revoke access by removing their line from `MCP_HOUSEHOLD_ACCESS_KEYS` in the shared server's environment and restarting it

### Step 6: Test the Access Boundaries

Verify the security model works:

```typescript
// Test script: test-boundaries.ts
import { createClient } from "@supabase/supabase-js";

const sharedClient = createClient(
  process.env.SHARED_SUPABASE_URL!,
  process.env.SHARED_SUPABASE_KEY!
);

async function testBoundaries() {
  console.log("Testing allowed access...");

  // Should succeed: reading meal plans
  const { data: meals, error: mealsError } = await sharedClient
    .from("meal_plans")
    .select("*");
  console.log("meal_plans:", mealsError ? "BLOCKED" : "ALLOWED");

  // Should succeed: reading shopping list
  const { data: shopping, error: shoppingError } = await sharedClient
    .from("shopping_list_items")
    .select("*");
  console.log("shopping_list_items (SELECT):", shoppingError ? "BLOCKED" : "ALLOWED");

  // Should fail: reading thoughts
  const { data: thoughts, error: thoughtsError } = await sharedClient
    .from("thoughts")
    .select("*");
  console.log("thoughts:", thoughtsError ? "BLOCKED ✓" : "ALLOWED (BAD)");

  // Should fail: deleting from shopping list
  const { error: deleteError } = await sharedClient
    .from("shopping_list_items")
    .delete()
    .eq("id", "test-id");
  console.log("shopping_list_items (DELETE):", deleteError ? "BLOCKED ✓" : "ALLOWED (BAD)");
}

testBoundaries();
```

Expected output:

```
meal_plans: ALLOWED
shopping_list_items (SELECT): ALLOWED
thoughts: BLOCKED ✓
shopping_list_items (DELETE): BLOCKED ✓
```

## Concrete Example: Spouse Access to Meal Planning

**Scenario**: You and your spouse share meal planning and grocery shopping. Your spouse wants to:
- See what's planned for dinner this week
- Add items to the shopping list
- Check off items when shopping
- View recipes for planned meals

But should NOT be able to:
- Read your personal thoughts or journal entries
- Access your work projects
- See your personal contacts
- Modify anything outside meal planning

**Implementation**:

1. **Tables shared**: `meal_plans`, `recipes`, `shopping_list_items`
2. **Operations**:
   - `meal_plans`: SELECT only
   - `recipes`: SELECT only
   - `shopping_list_items`: SELECT, INSERT, UPDATE (no DELETE)
3. **Credentials**: Separate Supabase service role key with table-level grants
4. **Deployment**: Compiled MCP server on spouse's laptop, configured in their Claude Desktop

**User experience for your spouse**:

```
Spouse: "What's for dinner this week?"
Claude: [calls view_meal_plans tool] "Here's the meal plan:
- Monday: Chicken tacos
- Tuesday: Pasta primavera
- Wednesday: Leftover night
..."

Spouse: "Add milk and eggs to the shopping list"          (a write-scoped key; with the read-scoped one minted above, add_shopping_item is not offered)
Claude: [calls add_shopping_item twice] "Added milk and eggs to the list."

Spouse: "Show me the recipe for chicken tacos"
Claude: [calls view_recipe tool] "Here's the recipe: ..."
```

Behind the scenes, Claude uses the shared MCP server—never touching your personal data.

## Expected Outcome

After following this guide, you will have:

1. A scoped database role with limited table access
2. A separate MCP server implementation with restricted tools
3. Independent deployment on another person's machine
4. Verified security boundaries preventing unauthorized access
5. A working shared-access pattern you can replicate for other use cases

The other person can now use Claude to interact with shared data, while your personal Open Brain remains completely private.

## Troubleshooting

### Issue 1: "Permission denied for table X"

**Symptom**: The shared server throws permission errors when trying to access a table.

**Cause**: The scoped database role doesn't have the necessary grants.

**Solution**:

```sql
-- Check current permissions
SELECT grantee, privilege_type, table_name
FROM information_schema.role_table_grants
WHERE grantee = 'household_member';

-- Grant missing permissions
GRANT SELECT ON public.meal_plans TO household_member;
GRANT SELECT, INSERT, UPDATE ON public.shopping_list_items TO household_member;
```

### Issue 2: Shared server can access tables it shouldn't

**Symptom**: The scoped role can read tables that should be private (e.g., `thoughts`, `contacts`).

**Cause**: The Supabase service role key has admin privileges, or the database role has excessive grants.

**Solution**:

```sql
-- Revoke all permissions first
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM household_member;

-- Grant only what's needed
GRANT SELECT ON public.meal_plans TO household_member;
GRANT SELECT ON public.recipes TO household_member;
GRANT SELECT, INSERT, UPDATE ON public.shopping_list_items TO household_member;

-- Verify no extra grants exist
SELECT grantee, privilege_type, table_name
FROM information_schema.role_table_grants
WHERE grantee = 'household_member';
```

For Supabase: Create a custom JWT with limited claims, or use connection pooling with role-based credentials.

### Issue 3: Changes not syncing between users

**Symptom**: You add a meal plan, but your spouse doesn't see it when they query.

**Cause**: Different database connections, caching, or RLS policies blocking visibility.

**Solution**:
1. Check both users are connecting to the same database:

   ```bash
   # Your .env
   echo $SUPABASE_URL

   # Their .env.shared
   echo $SHARED_SUPABASE_URL
   ```

2. Verify RLS policies allow visibility:

   ```sql
   -- Check RLS is enabled
   SELECT tablename, rowsecurity
   FROM pg_tables
   WHERE schemaname = 'public';

   -- If RLS is enabled, check policies
   SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
   FROM pg_policies
   WHERE tablename = 'meal_plans';
   ```

3. Disable RLS if not needed:

   ```sql
   ALTER TABLE meal_plans DISABLE ROW LEVEL SECURITY;
   ```

### Issue 4: MCP server won't start on spouse's machine

**Symptom**: Claude Desktop shows "MCP server failed to start" or tools don't appear.

**Cause**: Missing Node.js, incorrect paths, or environment variable issues.

**Solution**:
1. Verify Node.js version:

   ```bash
   node --version  # Should be 18+
   ```

2. Test the server manually:

   ```bash
   node --env-file=/path/to/.env.shared /path/to/dist/shared-server.js
   ```

3. Check Claude Desktop logs:

   ```bash
   # macOS
   tail -f ~/Library/Logs/Claude/mcp*.log
   ```

4. Verify the connector URL is correct:

   - Check that the `?key=` value is the **key** whose hash sits in the `MCP_HOUSEHOLD_ACCESS_KEYS` secret (the URL carries the key, the secret its hash), and that the line's scope is what you expect
   - Try removing and re-adding the connector in Settings → Connectors
   - Verify the shared server is running: its terminal shows Bun's start line, and `curl http://your-host:8788/mcp` without a key answers 401

## Extensions That Use This

- [Meal Planning](../../extensions/meal-planning/) — Includes a dedicated shared-server.ts for household grocery list and meal plan access

## Next Steps

- **Audit regularly**: Review what's shared and revoke access when no longer needed
- **Monitor usage**: Set up logging to see what queries the shared server receives
- **Iterate on permissions**: Start with read-only, add write permissions as trust builds
- **Document for users**: Create a simple guide for the other person explaining what they can ask Claude to do
- **Consider other use cases**: Team collaboration, family calendars, shared project tracking

You now have a reusable pattern for sharing parts of your Open Brain without compromising privacy.
