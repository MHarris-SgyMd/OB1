# Extension 3: Family Calendar

## Why This Matters

Two kids, two parents, overlapping schedules. Soccer practice conflicts with the dentist appointment. Nobody bought the birthday present. The haircut hasn't been scheduled in months. The chaos isn't from lack of caring — it's from lack of a system that can reason across everyone's schedule at once. Your agent can cross-reference both parents' schedules against all kids' events and surface what's falling through the cracks.

## Learning Path: Extension 3 of 6

| Extension | Name | Status |
|-----------|------|--------|
| 1 | Household Knowledge Base | Complete |
| 2 | Home Maintenance Tracker | Complete |
| **3** | **Family Calendar** | **<-- You are here** |
| 4 | Meal Planning | Not started |
| 5 | Professional CRM | Not started |
| 6 | Job Hunt Pipeline | Not started |

## What You'll Learn

- Multi-entity data models (family members → activities relationship)
- Time-based queries and date handling
- Recurring events (weekly activities with day_of_week, and yearly dates on their next anniversary)
- Nullable foreign keys (activities can belong to one person or the whole family)
- Querying across date ranges

## What It Does

A multi-person family scheduling system. Track activities, important dates, and family members so your agent can spot conflicts, surface upcoming events, and make sure nothing gets forgotten.

In Daemonic Brain the family calendar is a **plugin**: [`plugins/family-calendar`](../../plugins/family-calendar/) (SMD-2311). It runs inside the brain's own servers, behind the brain's own keys, and its tools appear on the MCP connector you already have. There is no separate server, key list or connector to set up. Its tables live in a schema of its own, `plugin_family_calendar`, which the brain's migrator makes when you turn the plugin on.

**Tables:**
- `family_members` — People in your household
- `activities` — Scheduled events and recurring activities (soccer every Tuesday, one-time dentist appointment)
- `important_dates` — Birthdays, anniversaries, deadlines with optional yearly recurrence

**Tools** (each also a REST route under `/v1/plugins/family-calendar/`):
- `family_calendar_add_family_member` — Add a person to your household roster
- `family_calendar_list_family_members` — List the household, with each member's id
- `family_calendar_add_activity` — Schedule a one-time appointment, a span of days, or a weekly activity
- `family_calendar_get_week_schedule` — See everyone's schedule for a given week, day by day
- `family_calendar_search_activities` — Find activities by title, member's name, location, notes, type or member
- `family_calendar_add_important_date` — Track birthdays, anniversaries, deadlines
- `family_calendar_get_upcoming_dates` — Surface dates in the next N days, yearly ones on their next anniversary, and any whose reminder has begun

The plugin's [README](../../plugins/family-calendar/README.md) gives each one's input, output and refusals.

## Prerequisites

- Working Open Brain setup: the compose stack ([`SETUP.md`](../../SETUP.md)) and an MCP client connected to it ([Getting Started](../../docs/01-getting-started.md), Steps 6 and 7)
- Extensions 1-2 recommended but not required

## Steps

### 1. Turn on the Plugin

Add the plugin to `deploy/.env`, with the secret the plugins' database logins are derived from (skip the second line if another plugin already set it):

```
OB1_PLUGINS=family-calendar
OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
```

Then recreate the migrator and the servers from `deploy/`, naming the stack's other `-f` files as you brought it up:

```bash
docker compose up -d migrate api mcp
docker compose up -d --force-recreate --no-deps app   # the operator GUI, so it reaches the recreated REST core; it signs everyone out
```

The migrator makes the plugin's tables, and the servers start with its seven tools.

### 2. Check Your AI Sees It

Your MCP client lists the `family_calendar_*` tools on the brain's own connector, once it refreshes its tool list. A read key sees the four that read. A write key sees all seven.

### 3. Test It

Try these prompts:

```
Add my family members: me (Jonathan), spouse (Sarah), and two kids (Emma age 8, Noah age 5).

Add a recurring activity: Emma has soccer practice every Tuesday from 5-6pm at Lincoln Park, starting this week.

Show me our schedule for next week.

Add an important date: Emma's birthday is May 15, remind me 7 days before.

What important dates are coming up in the next 30 days?
```

## Cross-Extension Integration

The family calendar sets up the `family_members` table that Meal Planning (Extension 4) depends on — knowing who's home this week determines how many meals to plan. The calendar's tables are the plugin's own, so your agent connects the two: it reads the week through the calendar's tools, then plans meals with Extension 4's.

The multi-entity pattern (family_member → activities) is the same pattern you'll use for contacts → interactions in the Professional CRM (Extension 5).

When you build the Household Knowledge Base (Extension 1), you can cross-reference it here: "Who was Emma's pediatrician again?" can query Extension 1's knowledge base, then "Schedule Emma's checkup" uses this calendar.

## Expected Outcome

Your agent can now:

1. Track everyone's schedule in one place
2. Surface upcoming events and important dates
3. Spot scheduling conflicts (if two activities overlap)
4. Answer questions like "What does Emma have this week?" or "When is Noah's birthday?"
5. Remind you about important dates before they arrive

## Troubleshooting

For common issues (connection errors, 401s), see [Common Troubleshooting](../../primitives/troubleshooting/). The plugin's own troubleshooting is in [its README](../../plugins/family-calendar/README.md#troubleshooting).

**Extension-specific issues:**

**No `family_calendar_*` tools**
- Check that `OB1_PLUGINS` in `deploy/.env` names `family-calendar`, and that the migrator and servers were recreated after it was set
- Refresh your client's tool list

**Activities not showing up in get_week_schedule**
- Check that `start_date` and `end_date` are set correctly: a one-off (a start date alone) is in the week of its day only, and a weekly activity is listed only where its day in that week falls within its dates
- `day_of_week` is a lower-case day name ('monday', not 'Monday'); a capitalised one is refused when the activity is added
- The week runs seven days from `week_start`, in YYYY-MM-DD format

## Next Steps

**Extension 4: Meal Planning** — Combine what you've learned about scheduling with recipes, a week's meals and the shopping list made from them, ticked off as things are bought.

**Key concepts in Extension 4:**
- JSONB for complex data (ingredients, instructions)
- Auto-generating derivative data (shopping lists from meal plans)
- Cross-extension queries (checking who's home this week from the family calendar)

Continue to [Extension 4: Meal Planning](../meal-planning/)

> **Context check:** With 3 extensions turned on, you're now exposing ~15 more tools to your AI. This is still manageable, but Extension 4 adds 10 more. Now is a good time to read the [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) — it covers how to audit your tool surface, and patterns for keeping your AI sharp as you add complexity.
