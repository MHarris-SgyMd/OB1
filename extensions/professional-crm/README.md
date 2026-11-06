# Extension 5: Professional CRM

## Why This Matters

You ran into someone at a conference six months ago. They mentioned they were looking for exactly what you do. You said you'd follow up. You didn't. That connection is gone — not because you're bad at networking, but because no human can track hundreds of professional relationships in their head. Your agent could have surfaced that contact three days after the conversation and reminded you to follow up. It could tell you, before your next meeting with someone, every interaction you've had and every note you've captured about them.

## Learning Path: Extension 5 of 6

| Extension | Name | Status |
|-----------|------|--------|
| 1 | Household Knowledge Base | Completed |
| 2 | Home Maintenance Tracker | Completed |
| 3 | Family Calendar | Completed |
| 4 | Meal Planning & Recipes | Completed |
| **5** | **Professional CRM** | **<-- You are here** |
| 6 | Job Hunt Pipeline | Not started |

## What You'll Learn

- Multi-level relationships across tables (contacts → interactions → opportunities)
- Pipeline tracking with stage management
- A value that only moves forward (`last_contacted` follows the latest interaction, never an older one logged late)
- Reading the brain's own thoughts through its core, as the caller, from a plugin that holds nothing of the core's
- Bridge tools that connect different data domains

## What It Does

A professional contact management system with interaction logging, opportunity tracking, follow-up reminders, meeting prep and stale-contact detection.

In Daemonic Brain the CRM is a **plugin**: [`plugins/professional-crm`](../../plugins/professional-crm/) (SMD-2311). It runs inside the brain's own servers, behind the brain's own keys, and its tools appear on the MCP connector you already have. There is no separate server, key list, connector or `DEFAULT_USER_ID` to set up. Its tables live in a schema of its own, `plugin_professional_crm`, which the brain's migrator makes when you turn the plugin on.

**Tables:**
- `professional_contacts` — The people in your network
- `contact_interactions` — Each touchpoint with them
- `opportunities` — Deals, projects and collaborations, each at a stage
- `contact_thoughts` — The brain's thoughts linked to a contact

**Tools** (each also a REST route under `/v1/plugins/professional-crm/`):
- `professional_crm_add_contact` — Add a contact
- `professional_crm_search_contacts` — Find contacts by words or a tag
- `professional_crm_update_contact` — Change a contact's fields, including the follow-up date
- `professional_crm_log_interaction` — Log a meeting, email, call, coffee or other touchpoint
- `professional_crm_get_contact_history` — A contact's profile, interactions, opportunities and linked thoughts
- `professional_crm_create_opportunity` — Add an opportunity, with a contact or none
- `professional_crm_list_opportunities` — Find opportunities by stage, open or closed, or contact
- `professional_crm_update_opportunity` — Move an opportunity on, through to won or lost
- `professional_crm_get_follow_ups` — Who is overdue or due for a follow-up
- `professional_crm_link_thought` — **The bridge:** link a thought from your brain to a contact
- `professional_crm_prep_context` — **Meeting prep:** everything about a contact in one briefing
- `professional_crm_stale_contacts` — Relationships going cold

The old server's tools carried a `crm_` prefix of their own; the plugin's name prefixes them now. The plugin's [README](../../plugins/professional-crm/README.md) gives each one's input, output and refusals.

The old server's tables were in `public`, made by a `schema.sql` here that is gone. The plugin's README has the copy for a brain that held them.

## Prerequisites

- Working Daemonic Brain setup: the compose stack ([`SETUP.md`](../../SETUP.md)) and an MCP client connected to it ([Getting Started](../../docs/01-getting-started.md), Steps 6 and 7)
- Extensions 1-4 recommended

## Steps

### 1. Turn on the Plugin

Add the plugin to `deploy/.env`, with the secret the plugins' database logins are derived from (skip the second line if another plugin already set it):

```
OB1_PLUGINS=professional-crm
OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
```

Then recreate the migrator and the servers from `deploy/`, naming the stack's other `-f` files as you brought it up:

```bash
docker compose up -d migrate api mcp
docker compose up -d --force-recreate --no-deps app   # the operator GUI, so it reaches the recreated REST core; it signs everyone out
```

The migrator makes the plugin's tables, and the servers start with its twelve tools.

### 2. Check Your AI Sees It

Your MCP client lists the `professional_crm_*` tools on the brain's own connector, once it refreshes its tool list. A read key sees the six that read. A write key sees all twelve.

### 3. Test It

Try these prompts:

```
Add a professional contact: Sarah Chen, works at DataCorp as VP of Engineering, met at AI Summit 2026
```

```
Log an interaction: had coffee with Sarah Chen yesterday, discussed their RAG pipeline needs, follow up needed. Remind me to follow up next Tuesday.
```

```
Show me everyone I need to follow up with this week
```

```
Create an opportunity: DataCorp consulting project, linked to Sarah Chen, in conversation stage, estimated $50k
```

```
Prep me for my meeting with Sarah
```

## Cross-Extension Integration

**This is where extensions start to compound in power.**

### `professional_crm_link_thought` — The Bridge Tool

Your brain captures thoughts all day long. Some of those thoughts mention people. This tool bridges the gap — your agent sees a thought about someone and can surface it before your next meeting with them.

**Example workflow:**

1. You capture a thought: "Ran into Sarah Chen at the AI meetup — she's looking for someone to help with their RAG pipeline."
2. Your agent finds it with `search_thoughts` and uses `professional_crm_link_thought` to add it to Sarah's contact record
3. Next time you look up Sarah or prep for a meeting, that thought appears in context
4. Before your next meeting with Sarah, your agent surfaces: "Last interaction: coffee 2 weeks ago. Note from recent thought: looking for RAG pipeline help."

**How it works technically:**

The tool takes a `thought_id` (from `search_thoughts`) and a `contact_id` (from `professional_crm_search_contacts`). It reads the thought through the brain's own `fetch`, as the key that called it, so a key that may not read thoughts cannot link one. It appends the thought's text to the contact's notes on a dated line, and records the link, so linking the same thought again adds nothing.

### Integration with Extension 6 (Job Hunt Pipeline)

If you build Extension 6, its link works in reverse — recruiters and hiring managers from your job search become professional contacts: your agent adds them here with `professional_crm_add_contact`, then records the contact on the job-hunt side. Your networking doesn't stop when the job search ends.

## Expected Outcome

Your agent will be able to answer questions like:
- "Who do I need to follow up with this week?"
- "Show me my full history with Sarah Chen"
- "What opportunities are in the proposal stage?" — and "Mark the DataCorp project won."
- "Find contacts I met at conferences who work in AI"
- "Prep me for my meeting with Sarah" (aggregated briefing)
- "Which relationships are going cold?" (stale contact detection)

## Troubleshooting

For common issues (connection errors, 401s), see [Common Troubleshooting](../../primitives/troubleshooting/). The plugin's own troubleshooting is in [its README](../../plugins/professional-crm/README.md#troubleshooting).

**Extension-specific issues:**

**No `professional_crm_*` tools**
- Check that `OB1_PLUGINS` in `deploy/.env` names `professional-crm`, and that the migrator and servers were recreated after it was set
- Refresh your client's tool list

**`NO_SUCH_THOUGHT` when linking**
- The thought is read as the key that called the tool: check the id with `search_thoughts`, using the same key

## Next Steps

**Extension 6: Job Hunt Pipeline** — The most complex build in the learning path. You'll create a complete job search management system with 5 tables (companies, postings, applications, interviews, contacts) and bridge it back to this CRM. You'll learn advanced pipeline tracking, conversion rate analysis, and cross-extension integration at scale.

[Continue to Extension 6 →](../job-hunt/README.md)

> **37 tools and counting.** With 5 plugins on, your AI is holding ~37 tool definitions from them in context. If you're noticing the AI picking the wrong tool or ignoring some entirely, the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) has prompt kits that audit your tools, suggest merges, and help you turn on only the plugins a workflow needs.
