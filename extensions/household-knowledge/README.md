# Extension 1: Household Knowledge Base

## Why This Matters

You're at the paint store and can't remember what shade of blue is in the living room. Your kid's shoe size changed and you're ordering online from memory. The plumber who fixed the leak last year — what was their number? Every household accumulates hundreds of small facts that matter at exactly the wrong moment. Your Daemonic Brain agent can hold all of them and surface them when you need them.

## Learning Path: Extension 1 of 6

| Extension | Name | Status |
|-----------|------|--------|
| **1** | **Household Knowledge Base** | **<-- You are here** |
| 2 | Home Maintenance Tracker | Not started |
| 3 | Family Calendar | Not started |
| 4 | Meal Planning & Recipes | Not started |
| 5 | Professional CRM | Not started |
| 6 | Job Hunt Pipeline | Not started |

## What It Does

A store of household facts — paint colors, appliance details, vendor contacts, measurements, warranty info, and anything else about your home and family that you'd otherwise forget.

In Daemonic Brain the knowledge base is a **plugin**: [`plugins/household-knowledge`](../../plugins/household-knowledge/) (SMD-2311). It runs inside the brain's own servers, behind the brain's own keys, and its tools appear on the MCP connector you already have. There is no separate server, key list or connector to set up. Its tables live in a schema of its own, `plugin_household_knowledge`, which the brain's migrator makes when you turn the plugin on.

**Tables:**
- `household_items` — Facts about things in your home, with their particulars (brand, model, colour code) as a flexible JSON object
- `household_vendors` — Service providers: plumbers, electricians, landscapers

**Tools** (each also a REST route under `/v1/plugins/household-knowledge/`):
- `household_knowledge_add_household_item` — Store a fact about something in your home
- `household_knowledge_search_household_items` — Find items by name, category, location, notes or any detail
- `household_knowledge_get_item_details` — One item in full
- `household_knowledge_add_vendor` — Track a service provider
- `household_knowledge_list_vendors` — List providers, by service type or a search

The plugin's [README](../../plugins/household-knowledge/README.md) gives each one's input, output and refusals.

## What You'll Learn

- Basic table design with PostgreSQL
- JSONB patterns for flexible metadata storage
- Text search with ILIKE patterns, across columns and inside JSON
- How a brain's plugin serves tools behind the brain's own keys

## Prerequisites

- Working Daemonic Brain setup: the compose stack ([`SETUP.md`](../../SETUP.md)) and an MCP client connected to it ([Getting Started](../../docs/01-getting-started.md), Steps 6 and 7)

## Steps

### 1. Turn on the Plugin

Add the plugin to `deploy/.env`, with the secret the plugins' database logins are derived from (skip the second line if another plugin already set it):

```
OB1_PLUGINS=household-knowledge
OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
```

Then recreate the migrator and the servers from `deploy/`, naming the stack's other `-f` files as you brought it up:

```bash
docker compose up -d migrate api mcp
docker compose up -d --force-recreate --no-deps app   # the operator GUI, so it reaches the recreated REST core; it signs everyone out
```

The migrator makes the plugin's tables, and the servers start with its five tools.

### 2. Check Your AI Sees It

Your MCP client lists the `household_knowledge_*` tools on the brain's own connector, once it refreshes its tool list. A read key sees the three that read. A write key sees all five.

### 3. Test It

Try these prompts:

```
Add a household item: living room paint is Sherwin Williams Sea Salt SW 6204
```

```
What colour is the living room?
```

```
Add a vendor: Mike's Plumbing, phone 555-1234, last used them in December 2025
```

```
List all my plumbers
```

## Cross-Extension Integration

This is the foundation. Future extensions build on the pattern you learn here:

- **JSONB flexibility pattern**: The `details` field in `household_items` holds arbitrary key-value pairs. You'll see this same pattern in Extension 4 (Meal Planning) for recipe ingredients and in Extension 5 (Professional CRM) for contact metadata.

- **Vendor tracking pattern**: The `household_vendors` table introduces a contact management pattern that evolves into full contact tracking in Extension 5 (Professional CRM).

## Expected Outcome

After completing this extension, you should be able to:

1. Store household facts with flexible metadata
2. Search items by name, category, location, or any detail
3. Track service providers with contact information
4. Retrieve specific item details on demand

Your agent will be able to answer questions like:
- "What's the model number of my dishwasher?"
- "When did we last use the electrician?"
- "What paint color is in the bedroom?"
- "Who's a good plumber we've used before?"

## Troubleshooting

For common issues (connection errors, 401s), see [Common Troubleshooting](../../primitives/troubleshooting/). The plugin's own troubleshooting is in [its README](../../plugins/household-knowledge/README.md#troubleshooting).

**Extension-specific issues:**

**No `household_knowledge_*` tools**
- Check that `OB1_PLUGINS` in `deploy/.env` names `household-knowledge`, and that the migrator and servers were recreated after it was set
- Refresh your client's tool list

**An item's details are refused**
- `details` is a JSON object (`{"brand": "Bosch"}`), not a string holding JSON

## Next Steps

**Extension 2: Home Maintenance Tracker** — Learn how to handle recurring tasks, date-based scheduling, and historical logging. The maintenance tracker introduces one-to-many relationships (task → multiple log entries) and time-based queries that surface upcoming work.

[Continue to Extension 2 →](../home-maintenance/README.md)

> **As you add extensions**, each one adds tool definitions to your AI's context window. By Extension 3–4, it's worth thinking about which plugins you keep turned on. See the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) for strategies.
