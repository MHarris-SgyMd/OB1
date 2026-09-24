# Extension Name

<!--
=============================================================================
TEMPLATE INSTRUCTIONS (for contributors and AI assistants)
=============================================================================

This template defines the required structure, visual patterns, and formatting
for all Open Brain extension guides. Follow it exactly.

VISUAL PATTERNS USED IN THIS TEMPLATE:
  1. shields.io BADGES for every step and sub-step
  2. Collapsible <details> blocks for SQL and long code
  3. GitHub alert callouts: [!CAUTION], [!WARNING], [!TIP], [!IMPORTANT], [!NOTE]
  4. "Done when" verification checkpoints after every step
  5. Numbered commands within steps when there are 2+ commands in sequence

BADGE FORMAT:
  Main steps use:
    ![Step N](https://img.shields.io/badge/Step_N-TITLE_HERE-HEX_COLOR?style=for-the-badge)
  Sub-steps use INVERTED colors (color on left, grey on right):
    ![N.X](https://img.shields.io/badge/N.X-TITLE_HERE-555?style=for-the-badge&labelColor=HEX_COLOR)

  Replace HEX_COLOR with one consistent color for the whole extension.
  Use underscores for spaces in badge titles: "Create_Tables" not "Create Tables"

COLOR REFERENCE (pick one per extension, or reuse from this list):
  E53935 (red)  |  F4511E (orange-red)  |  FB8C00 (orange)
  43A047 (green)  |  00897B (teal)  |  1E88E5 (blue)
  5C6BC0 (indigo)  |  8E24AA (purple)  |  D81B60 (pink)

REPLACE all instances of:
  - "Extension Name" with your extension's name
  - "extension-name" with your extension's slug (lowercase, hyphenated)
  - "HEX_COLOR" with your chosen badge color
  - "YOUR_PROJECT_ID" with the placeholder for the user's project ref
  - "table_name" / "table_name_2" with your actual table names

DELETE this comment block before submitting your PR.
=============================================================================
-->

## Why This Matters

Lead with the human pain point. What real-life scenario makes this extension worth building? Use specific, relatable examples — not tech specs.

## What It Does

1-2 sentences on the practical capability this adds to your Open Brain.

## Learning Path: Extension X of 6

| Extension | What You Build | Status |
| --------- | -------------- | ------ |
| 1. [Household Knowledge Base](../household-knowledge/) | Home facts your agent can recall | |
| 2. [Home Maintenance Tracker](../home-maintenance/) | Scheduling and history for home upkeep | |
| 3. [Family Calendar](../family-calendar/) | Multi-person schedule coordination | |
| 4. [Meal Planning](../meal-planning/) | Recipes, meal plans, shared grocery lists | |
| 5. [Professional CRM](../professional-crm/) | Contact tracking with interaction history | |
| 6. [Job Hunt Pipeline](../job-hunt/) | Application tracking and interview pipeline | |

> Mark your current extension with **<-- You are here**

## What You'll Learn

- Concept or technique 1
- Concept or technique 2
- Concept or technique 3

## Prerequisites

- Working Open Brain setup ([guide](../../docs/01-getting-started.md))
- [Bun](https://bun.sh) 1.4+ and a checkout of this repository — the server runs under Bun ([Run a Remote MCP Server](../../primitives/deploy-remote-mcp/))
- List any earlier extensions that must be completed first
- List any required primitives with links

## Credential Tracker

Copy this block into a text editor and fill it in as you go.

> **Already have your brain's connection string from the [Setup Guide](../../docs/01-getting-started.md)?** That is the one value this server needs from it.

```text
EXTENSION NAME -- CREDENTIAL TRACKER
--------------------------------------

DATABASE (from your Open Brain setup)
  Postgres URL:          ____________  (SUPABASE_URL — the shim's name for it)

GENERATED DURING SETUP
  MCP Access Key:        ____________  (same key for all extensions)
  MCP Server URL:        ____________
  MCP Connection URL:    ____________

--------------------------------------
```

---

![Step 1](https://img.shields.io/badge/Step_1-Create_the_Database_Tables-HEX_COLOR?style=for-the-badge)

<!-- If this step has multiple parts (e.g., create tables, then create functions,
     then set permissions), break them into sub-steps with inverted badges. -->

![1.1](https://img.shields.io/badge/1.1-Create_the_Tables-555?style=for-the-badge&labelColor=HEX_COLOR)

Run `schema.sql` against your Open Brain database — `psql "$DATABASE_URL" -f extensions/extension-name/schema.sql`, or paste it into the SQL client you use. If its policies call `auth.uid()`, create the two stub functions first, as [Household Knowledge](../household-knowledge/README.md) Step 1 shows:

<details>
<summary>📋 <strong>SQL: Extension tables</strong> (click to expand)</summary>

```sql
-- Paste your schema.sql content here
-- Keep each logical group (tables, functions, policies) in its own sub-step
```

</details>

![1.2](https://img.shields.io/badge/1.2-Grant_Table_Permissions-555?style=for-the-badge&labelColor=HEX_COLOR)

New query → paste and Run:

<!--
IMPORTANT: Every extension MUST include this GRANT step.
Replace table_name and table_name_2 with your actual table names.
Add one line per table your extension creates.
-->

<details>
<summary>📋 <strong>SQL: Grant the server's role access</strong> (click to expand)</summary>

```sql
grant select, insert, update, delete on table public.table_name to your_role;
grant select, insert, update, delete on table public.table_name_2 to your_role;
```

</details>

> [!IMPORTANT]
> This step is required unless the server connects as the table owner. Nothing grants the connecting role anything by default (`db/README.md`, "Grants for a capturing role"). Without this, your MCP server will return "permission denied" errors.

![1.3](https://img.shields.io/badge/1.3-Verify-555?style=for-the-badge&labelColor=HEX_COLOR)

✅ **Done when:** `\d table_name` in psql shows your new tables with the expected columns.

---

![Step 2](https://img.shields.io/badge/Step_2-Run_the_MCP_Server-HEX_COLOR?style=for-the-badge)

Run the server under [Bun](https://bun.sh) from a checkout of this repository — one HTTP process, as every server here is (SMD-1799; [Run a Remote MCP Server](../../primitives/deploy-remote-mcp/) walks it, `compat/supabase-sql/README.md` §3 has the shim):

```bash
(cd extensions && bun install)   # once: the pinned hono, zod and MCP SDK
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:<sha256-of-your-key>' \
PORT=8787 bun extensions/extension-name/index.ts
```

`SUPABASE_URL` is a `postgres://` connection string (the SQL shim keeps the variable names; `SUPABASE_SERVICE_ROLE_KEY` may be left unset). Mint the access key as [Run a Remote MCP Server, Step 3](../../primitives/deploy-remote-mcp/README.md#step-3-mint-an-access-key) shows and set its `name:scope:hash` line in `MCP_ACCESS_KEYS`. Your **MCP Server URL** is `http://your-host:8787/mcp`, and your **MCP Connection URL** adds the key: `http://your-host:8787/mcp?key=<your-key>` (behind TLS on any host that is not your own).

✅ **Done when:** Bun prints its start line (`Started development server: http://localhost:8787`, or `Started server:` under `NODE_ENV=production`) and the process stays up.

---

![Step 3](https://img.shields.io/badge/Step_3-Connect_to_Your_AI-HEX_COLOR?style=for-the-badge)

Follow the [Remote MCP Connection](../../primitives/remote-mcp/) guide to connect this extension to Claude Desktop, ChatGPT, Claude Code, or any other MCP client.

| Setting | Value |
|---------|-------|
| Connector name | `Extension Name` |
| URL | Your **MCP Connection URL** from the credential tracker |

✅ **Done when:** Your AI client shows the extension's tools in its available tools list.

---

![Step 4](https://img.shields.io/badge/Step_4-Test_It-HEX_COLOR?style=for-the-badge)

<!-- Provide 2-3 specific prompts the user can paste into their AI to verify
     each tool works. Use a numbered list so they test in order. -->

Try these prompts in your AI client:

1. **Test prompt 1** — describe what this tests and what the user should see
2. **Test prompt 2** — describe what this tests and what the user should see
3. **Test prompt 3** — describe what this tests and what the user should see

> [!CAUTION]
> If any prompt returns an error, read the server's terminal output (a failed tool call logs its cause there) before troubleshooting further.

✅ **Done when:** All test prompts return expected results and `select * from table_name` shows the rows.

---

## Cross-Extension Integration

<!-- Describe how this extension connects to others. What tools bridge between
     this extension and the rest of the Open Brain ecosystem? Be specific about
     which tools call which, and give example prompts that trigger cross-extension
     behavior. This is the proof that extensions compound. -->

Describe how this extension connects to others. What tools bridge between this extension and the rest of the Open Brain ecosystem? This is the proof that extensions compound.

## Expected Outcome

<!-- Be specific. What tables exist? What tools are available? What can the user
     ask their AI to do that they couldn't before? -->

What should be working when you're done? Be specific.

## Troubleshooting

For common issues (connection errors, 401s, deployment problems), see [Common Troubleshooting](../../primitives/troubleshooting/).

**Extension-specific issues:**

<!-- Include at least 2-3 issues specific to this extension. Format each as a
     bold error message followed by a bullet-point fix. -->

**"permission denied for table table_name"**
- You skipped Step 1.2. Go back and run the `GRANT` SQL.

**"relation 'table_name' does not exist"**
- The schema SQL wasn't run successfully — re-run it against the database `SUPABASE_URL` names.

## Next Steps

Link to the next extension in the learning path and briefly describe what it adds.

> **Tool hygiene:** This extension adds MCP tools to your AI's context window. As you build more extensions, the total tool count grows — and with it, the context cost and risk of your AI picking the wrong tool. See the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) for strategies on auditing, merging, and scoping your tools.

<!--
REQUIRED: Every extension that exposes MCP tools must include a link to
docs/05-tool-audit.md somewhere in its README. The automated review checks
for this. The blockquote above is the recommended format — adjust the wording
to fit your extension's context, but keep the link.
-->
