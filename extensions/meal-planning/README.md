# Extension 4: Meal Planning

## Why This Matters

Your agent can reason across five datasets — what you've cooked before, what's in the pantry, who's home this week (from your family calendar), what people actually liked, and what you need to buy. That's meal planning that actually works.

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

- JSONB for complex data (ingredients, instructions)
- Auto-generating derivative data (shopping lists from meal plans), and keeping what a person changed (a bought item) when it is made again
- Idempotent planning: a slot set, not appended to
- Cross-extension queries (checking who's home this week from the family calendar)

## What It Does

A meal planning system with recipes, weekly meal plans, and shopping lists made from them.

In Daemonic Brain the meal planner is a **plugin**: [`plugins/meal-planning`](../../plugins/meal-planning/) (SMD-2311). It runs inside the brain's own servers, behind the brain's own keys, and its tools appear on the MCP connector you already have. There is no separate server, key list or connector to set up. Its tables live in a schema of its own, `plugin_meal_planning`, which the brain's migrator makes when you turn the plugin on.

Upstream's extension also had a second, "shared" server, so a household member could view the plan and tick off the list on a key of their own. A plugin's operations take the brain's own scopes, which cannot express "read, and mark bought", so that server is retired (SMD-2920). The plugin's own `get_shopping_list` and `mark_item_purchased` do the reading and ticking, behind the brain's read and write keys.

**Tables:**
- `recipes` — Your recipe collection with ingredients, instructions and tags
- `meal_plans` — The week's meals: a recipe or a custom meal, by day and meal
- `shopping_lists`, `shopping_list_items` — One list a week, made from the planned recipes, each item with whether it is bought

**Tools** (each also a REST route under `/v1/plugins/meal-planning/`):
- `meal_planning_add_recipe` — Add a recipe with ingredients and instructions
- `meal_planning_search_recipes` — Find recipes by words, cuisine, tag or ingredient
- `meal_planning_update_recipe` — Change a recipe's fields
- `meal_planning_create_meal_plan` — Plan meals for days and meal types of a week
- `meal_planning_get_meal_plan` — See the week's meals, day by day
- `meal_planning_generate_shopping_list` — Make the week's shopping list from its recipes
- `meal_planning_get_shopping_list` — See the week's list
- `meal_planning_mark_item_purchased` — Tick an item off

The plugin's [README](../../plugins/meal-planning/README.md) gives each one's input, output and refusals.

## Prerequisites

- Working Open Brain setup: the compose stack ([`SETUP.md`](../../SETUP.md)) and an MCP client connected to it ([Getting Started](../../docs/01-getting-started.md), Steps 6 and 7)
- Extensions 1-3 recommended (Extension 3's family calendar, a plugin, is read for cross-extension integration)

## Steps

### 1. Turn on the Plugin

Add the plugin to `deploy/.env`, with the secret the plugins' database logins are derived from (skip the second line if another plugin already set it):

```
OB1_PLUGINS=meal-planning
OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
```

Then recreate the migrator and the servers from `deploy/`, naming the stack's other `-f` files as you brought it up:

```bash
docker compose up -d migrate api mcp
docker compose up -d --force-recreate --no-deps app   # the operator GUI, so it reaches the recreated REST core; it signs everyone out
```

The migrator makes the plugin's tables, and the servers start with its eight tools.

### 2. Check Your AI Sees It

Your MCP client lists the `meal_planning_*` tools on the brain's own connector, once it refreshes its tool list. A read key sees the three that read. A write key sees all eight.

### 3. Test It

Try these prompts:

```
Add a recipe: pasta al limone, Italian, serves 4 — 400 g spaghetti, 2 tbsp olive oil, 1 lemon; boil the pasta, toss with oil and lemon.
```

```
Plan dinners for next week: pasta on Monday and Wednesday, salad on Tuesday, leftovers on Thursday.
```

```
What's for dinner on Wednesday?
```

```
Make the shopping list for next week. I already have the olive oil — tick it off.
```

## Cross-Extension Integration

**With Family Calendar (Extension 3):**
Your agent can check who's home this week through the family calendar plugin's `family_calendar_get_week_schedule` to adjust serving sizes. Example prompt:

```
Who's home for dinner this week? Adjust the meal plan servings accordingly.
```

**With Household Knowledge Base (Extension 1):**
Cross-reference pantry inventory: "Do we have the ingredients for chicken stir-fry?" reads both the recipe's ingredients and your knowledge base entries about pantry stock.

## Expected Outcome

Your agent can now:

- Store and search your recipe collection
- Plan weekly meals with a mix of recipes and custom entries
- Make shopping lists by adding up recipe ingredients
- Tick off what's bought, and keep those ticks when the list is made again

## Troubleshooting

For common issues (connection errors, 401s), see [Common Troubleshooting](../../primitives/troubleshooting/). The plugin's own troubleshooting is in [its README](../../plugins/meal-planning/README.md#troubleshooting).

**Extension-specific issues:**

**No `meal_planning_*` tools**
- Check that `OB1_PLUGINS` in `deploy/.env` names `meal-planning`, and that the migrator and servers were recreated after it was set
- Refresh your client's tool list

**Shopping list quantities don't add up**
- Only quantities written as numbers ("2", "1/2", "1 1/2") are summed; others ("a pinch") are listed after the sum

## Next Steps

**Extension 5: Professional CRM** — Contact management with interaction history: the multi-entity relationship (contacts → interactions) is the same pattern you used in Extension 3 (family members → activities).

**Key concepts in Extension 5:**
- Contact management with interaction history
- Relationship tracking and follow-up reminders
- Integration with calendar (Extension 3) for scheduling follow-ups

Continue to [Extension 5: Professional CRM](../professional-crm/)

> **Tool surface area:** With ~25 tools across 4 plugins now, consider running the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) to identify which plugins to turn on per workflow and whether any tools can be consolidated.
