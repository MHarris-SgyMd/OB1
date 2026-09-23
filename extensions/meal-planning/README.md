# Extension 4: Meal Planning

## Why This Matters

Your agent can reason across five datasets — what you've cooked before, what's in the pantry, who's home this week (from your family calendar), what people actually liked, and what you need to buy. That's meal planning that actually works. And your spouse needs access too — not to your whole brain, just to the meal plan and the shopping list. This is where you learn to share specific parts of your system with someone else.

## Learning Path: Extension 4 of 6

| Extension | Name | Status |
|-----------|------|--------|
| 1 | Household Knowledge Base | Complete |
| 2 | Home Maintenance Tracker | Complete |
| 3 | Family Calendar | Complete |
| **4** | **Meal Planning** | **<-- You are here** |
| 5 | Professional CRM | Not started |
| 6 | Job Hunt Pipeline | Not started |

## What You'll Learn

- Row Level Security (first introduction to multi-user access)
- Shared MCP server (separate server with limited, scoped access)
- JSONB for complex data (ingredients, instructions)
- Auto-generating derivative data (shopping lists from meal plans)
- Cross-extension queries (checking who's home this week from the family calendar)

## What It Does

A complete meal planning system with recipes, weekly meal plans, and auto-generated shopping lists. Includes a separate shared MCP server so your partner can view plans — and, with a write-scoped key, check off grocery items — without accessing your full Open Brain.

**Tables:**
- `recipes` — Your recipe collection with JSONB ingredients and instructions
- `meal_plans` — Weekly meal planning linked to recipes
- `shopping_lists` — Auto-generated grocery lists from meal plans

**Primary MCP Tools (full access):**
- `add_recipe` — Add a recipe with ingredients and instructions
- `search_recipes` — Search by name, cuisine, tags, or ingredient
- `update_recipe` — Update an existing recipe
- `create_meal_plan` — Plan meals for a week
- `get_meal_plan` — View the meal plan for a given week
- `generate_shopping_list` — Auto-generate shopping list from meal plan

**Shared MCP Tools (household access):**
- `view_meal_plan` — View meal plans (read-only)
- `view_recipes` — Browse recipes (read-only)
- `view_shopping_list` — View shopping list
- `mark_item_purchased` — Toggle item purchased status

## Prerequisites

- Working Open Brain setup
- Extensions 1-3 recommended (Extension 3's family_members table is referenced for cross-extension integration)
- [Bun](https://bun.sh) 1.4+ and a Postgres carrying the Open Brain schema ([`SETUP.md`](../../SETUP.md)) — this server runs under Bun, not as a Supabase Edge Function (FORK.md change 74)
- **Required reading:** [Row Level Security](../../primitives/rls/) primitive
- **Required reading:** [Shared MCP Server](../../primitives/shared-mcp/) primitive

## Credential Tracker

You'll reference these values during setup. Copy this block into a text editor and fill it in as you go.

> **Already have your Supabase credentials from the [Setup Guide](../../docs/01-getting-started.md)?** You just need the same Project URL and Secret key.

```text
MEAL PLANNING -- CREDENTIAL TRACKER
--------------------------------------

SUPABASE (from your Open Brain setup)
  Postgres URL:          ____________  (SUPABASE_URL — the shim's name for it)
  Secret key:            ____________
  Project ref:           ____________

GENERATED DURING SETUP
  Default User ID:             ____________
  MCP Access Key:              ____________  (same key for all extensions)
  MCP Server URL:              ____________
  MCP Connection URL:          ____________

FOR SHARED SERVER
  Household Access Key:        ____________
  Household Key (Supabase):    ____________
  Shared Server URL:           ____________
  Shared Connection URL:       ____________

NOTE: This extension uses TWO Edge Functions:
  1. Primary (meal-planning-mcp) — your full access
  2. Shared (meal-planning-shared-mcp) — household read + shopping list

--------------------------------------
```

## Steps

> **No JSON config files. No local Node.js server. Same pattern as your core Open Brain setup.**

### 1. Create the Database Schema

Run the SQL in `schema.sql` against your Open Brain database, as the role the servers will connect with. Its row-level-security policies call Supabase's `auth.uid()` and `auth.jwt()`, which a plain Postgres does not have, so give it both first (the servers connect as one role and scope rows by `DEFAULT_USER_ID` themselves; the table owner is not subject to the policies) — **on a Supabase database skip this first command**, which has both and whose row-level security would break if they were replaced (the plain `CREATE` refuses with "already exists"): `psql "$DATABASE_URL" -c "CREATE SCHEMA IF NOT EXISTS auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid'; CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT ''{}''::jsonb';"` and then `psql "$DATABASE_URL" -f extensions/meal-planning/schema.sql` — or paste `schema.sql` alone into the Supabase SQL Editor, if that is where it lives. This creates three RLS-enabled tables:

```bash
# Using Supabase SQL Editor (recommended)
# 1. Open https://supabase.com/dashboard/project/YOUR_PROJECT_ID/sql/new
# 2. Paste the contents of schema.sql
# 3. Click "Run"
```

**Important:** The schema includes Row Level Security policies. Make sure you understand what RLS does before proceeding (see the [RLS primitive](../../primitives/rls/)).

### 2. Generate Your User ID

The extension needs a user ID to scope your data. Generate a UUID and save it in your credential tracker:

```bash
# macOS / Linux
uuidgen | tr '[:upper:]' '[:lower:]'

# Or use any UUID generator — the value just needs to be unique to you
```

Pass it to the server as `DEFAULT_USER_ID` when you start it in Step 3.

> If you already set `DEFAULT_USER_ID` for a previous extension, you can skip this step — all extensions share the same user ID.

### 3. Run the Primary MCP Server

This server runs under [Bun](https://bun.sh) against your Postgres: it imports the repository's SQL shim (`compat/supabase-sql`, Bun's Postgres client in supabase-js's shape) and is Bun-native — `process.env` for its environment, a default-exported `{ port, fetch }` that `bun` serves (SMD-1799) — so it is not a Supabase Edge Function and `supabase functions deploy` does not apply (FORK.md change 74). From a checkout of this repository:

```bash
(cd extensions && bun install)   # once: the pinned hono, zod and MCP SDK the server imports
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:paste-the-hash-here' \
DEFAULT_USER_ID='your-generated-uuid-here' \
PORT=8787 bun extensions/meal-planning/index.ts
```

`SUPABASE_URL` carries the Postgres connection string — the shim keeps the variable names, so the code does not change — and `SUPABASE_SERVICE_ROLE_KEY` may be left unset. Mint the access key as [Deploy an Edge Function, Step 3](../../primitives/deploy-edge-function/README.md#step-3-mint-an-access-key) shows and set its `name:scope:hash` line in `MCP_ACCESS_KEYS` (the older single `MCP_ACCESS_KEY` still works, with write scope). Bun prints its start line, `Started development server: http://localhost:8787` (`Started server:` under `NODE_ENV=production`; `PORT` unset, it listens on 8000 — which podman's `gvproxy` also holds on macOS, hence 8787 here); your **MCP Server URL** is `http://your-host:8787/mcp`, and your **MCP Connection URL** adds the key: `http://your-host:8787/mcp?key=your-access-key` — a read-scoped key is the one to put in a connector URL. To reach it from a hosted client, put it behind the same TLS proxy as the core server ([`SETUP.md`](../../SETUP.md)). `extensions/test-auth.ts` starts the server this way in CI. Each server holds one pool of `OB1_PG_POOL` connections (ten unless set) for its life, shared by every request; five extension servers beside the core server are sixty of Postgres's default hundred before any load, so set it lower where several share one database.

> **Every tool of this server runs on the fork.** `extensions/test-tools.ts` drives all six against a real Postgres carrying this `schema.sql` in CI — `tags` into `TEXT[]` beside `ingredients` into `JSONB` in one insert, the tag and ingredient filters, the recipe embedded on each meal (`recipes:recipe_id (…)`), the shopping list aggregated from it, and `update_recipe`'s error path carrying the database's message (FORK.md change 77, SMD-1588; change 74's review had found two of the six failing on the shim).

### 4. Connect to Your AI

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide to connect this extension to Claude Desktop, ChatGPT, Claude Code, or any other MCP client.

| Setting | Value |
|---------|-------|
| Connector name | `Meal Planning` |
| URL | Your **MCP Connection URL** from the credential tracker |

### 5. Test the Primary Server

Try these prompts in Claude Desktop:

```
Add a recipe: Chicken Stir-Fry. Ingredients: 1 lb chicken breast, 2 cups broccoli, 1 cup bell peppers, 3 tbsp soy sauce, 2 tbsp oil. Instructions: 1) Cut chicken into cubes. 2) Heat oil in wok. 3) Cook chicken 5 min. 4) Add vegetables, cook 3 min. 5) Add soy sauce, toss well. Tags: quick, healthy, asian. Prep 10 min, cook 15 min, serves 4.

Plan meals for the week of March 17: Monday dinner is the chicken stir-fry, Tuesday dinner is pasta night (custom meal, no recipe), Wednesday dinner is tacos.

Generate a shopping list for the week of March 17.
```

## Setting Up the Shared Server

The shared server gives household members limited access — they can view meal plans, browse recipes, and manage the shopping list without accessing your full Open Brain.

### 1. Create a Household Member Role in Supabase

The RLS policies check for `auth.jwt() ->> 'role' = 'household_member'`. You need to create a JWT with this claim:

**Option A: Create a separate Supabase user for your spouse**
1. Go to Supabase Dashboard → Authentication → Users
2. Create a new user with your spouse's email
3. In the SQL Editor, grant the household_member role:

```sql
-- Create a custom claim for this user
UPDATE auth.users
SET raw_app_meta_data = jsonb_set(
  COALESCE(raw_app_meta_data, '{}'),
  '{role}',
  '"household_member"'
)
WHERE email = 'spouse@example.com';
```

**Option B: Use a shared service account**
1. Create a new Supabase API key in Settings → API with limited permissions
2. This is simpler but less granular than per-user authentication

For this guide, we'll use Option B (shared service account).

### 2. Run the Shared Server

The shared server runs under Bun exactly as the primary one does (Step 3 above), from `shared-server.ts` instead of `index.ts`, with its own keys — `MCP_HOUSEHOLD_ACCESS_KEYS` (the older single `MCP_HOUSEHOLD_ACCESS_KEY` still works) rather than `MCP_ACCESS_KEYS`, so a household member's key never opens the primary server — and on a port of its own:

```bash
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_HOUSEHOLD_ACCESS_KEYS='spouse:write:paste-the-hash-here' \
PORT=8788 bun extensions/meal-planning/shared-server.ts
```

`SUPABASE_HOUSEHOLD_KEY`, the restricted Supabase key the Edge Function version read, may be left unset: with the shim the credentials live in the connection string, so give this server a `SUPABASE_URL` whose Postgres role has only the household member's privileges if you want the database to hold that line too. Its **MCP Connection URL** is `http://your-host:8788/mcp?key=the-household-key`.

> **Every tool of the shared server runs on the fork.** `extensions/test-tools.ts` drives all four in CI on the rows the primary server's tools planted — the embedded recipe on `view_meal_plan`, the tag filter on `view_recipes`, `view_shopping_list`'s error path carrying the database's message (FORK.md change 77, SMD-1588).

Mint the household member's key with scope `read` unless they should check items off the shopping list — `mark_item_purchased` is the shared server's one tool that writes, and a read-scoped key is not given it.

You'll also need to set the household Supabase key:

```bash
supabase secrets set SUPABASE_HOUSEHOLD_KEY=household-scoped-api-key
```

### 3. Connect Your Household Member

Your spouse/partner follows the [Remote MCP Connection](../../primitives/remote-mcp/) guide on their device:

| Setting | Value |
|---------|-------|
| Connector name | `Meal Planning (Shared)` |
| URL | The shared server's MCP Connection URL |

They can view meal plans and recipes; with a write-scoped key they can also check off grocery items. They cannot create recipes, modify meal plans, or access other parts of your Open Brain.

### 4. Test the Shared Server

Your spouse can now use prompts like:

```
What's for dinner this week?
Show me the shopping list for this week.
Mark "chicken breast" as purchased.        (needs a write-scoped key — mark_item_purchased is the one tool that writes)
Search recipes tagged "quick".
```

## Cross-Extension Integration

**With Family Calendar (Extension 3):**
Your agent can check who's home this week via the `family_members` and `activities` tables to adjust serving sizes. Example prompt:

```
Who's home for dinner this week? Adjust the meal plan servings accordingly.
```

**With Household Knowledge Base (Extension 1):**
Cross-reference pantry inventory: "Do we have the ingredients for chicken stir-fry?" queries both the recipe's ingredients and your knowledge base entries about pantry stock.

**Pattern reuse:**
The RLS patterns you learn here apply directly to Extensions 5 (Professional CRM) and 6 (Job Hunt Pipeline). The shared MCP server pattern is reusable for any future extension where you want to give someone else partial access.

## Expected Outcome

Your agent can now:

- Store and search your recipe collection
- Plan weekly meals with a mix of recipes and custom entries
- Auto-generate shopping lists by aggregating recipe ingredients
- Let your spouse view plans (and, with a write-scoped key, check off grocery items) without full system access

The shared server demonstrates a key Open Brain principle: your data, your rules. You control exactly what someone else can see and do.

## Troubleshooting

For common issues (connection errors, 401s, deployment problems), see [Common Troubleshooting](../../primitives/troubleshooting/).

**Extension-specific issues:**

**RLS policies blocking queries on the shared server**
- Verify your user has the `household_member` role set in `raw_app_meta_data`
- Check the RLS policies match the schema.sql
- Test with service role key first to confirm it's not an RLS issue

**JSONB ingredient search not working**
- The `search_recipes` tool uses `.cs.` (contains) operator for JSONB — ingredient names must match exactly (case-insensitive)
- For more flexible search, consider adding a GIN index on the ingredients JSONB column

**Shopping list aggregation is wrong**
- The current implementation does simple string concatenation for quantities (e.g., "1 cup + 2 cups")
- For production use, you'd want smarter quantity aggregation

**Shared server can see all data**
- Double-check that RLS policies are enabled (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`)
- Verify the `household_member` role is set correctly in the JWT claims
- Test by trying to insert/delete from the shared server (should fail)

## Next Steps

**Extension 5: Professional CRM** — You'll apply the RLS skills you just learned to protect professional contact data. The shared server pattern isn't needed here (your work contacts are private), but the multi-entity relationship (contacts → interactions) is the same pattern you used in Extension 3 (family members → activities).

**Key concepts in Extension 5:**
- Contact management with interaction history
- Relationship tracking and follow-up reminders
- RLS for sensitive professional data
- Integration with calendar (Extension 3) for scheduling follow-ups

Continue to [Extension 5: Professional CRM](../professional-crm/)

> **Tool surface area:** This extension introduced the concept of scoped servers — a primary server with full access and a shared server with limited tools. That same principle applies to how you organize all your MCP tools. With ~25 tools across 4 extensions now, consider running the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) to identify which servers to connect per workflow and whether any tools can be consolidated.
