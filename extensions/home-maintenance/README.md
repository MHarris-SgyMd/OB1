# Extension 2: Home Maintenance Tracker

## Why This Matters

The HVAC tech mentioned the pump was showing wear 18 months ago. The warranty on the water heater expires next month. The gutters haven't been cleaned since... when exactly? Without a system, these connections never get made — you just get expensive surprises. Your agent can track every maintenance task, remind you what's coming due, and keep a complete history so nothing slips through.

## Learning Path: Extension 2 of 6

| Extension | Name | Status |
|-----------|------|--------|
| 1 | Household Knowledge Base | Complete |
| **2** | **Home Maintenance Tracker** | **<-- You are here** |
| 3 | Family Calendar | Not started |
| 4 | Meal Planning & Recipes | Not started |
| 5 | Professional CRM | Not started |
| 6 | Job Hunt Pipeline | Not started |

## What It Does

A maintenance scheduling and history system. Track recurring tasks, log completed work, and let your agent surface what needs attention before it becomes an emergency.

In Daemonic Brain the tracker is a **plugin**: [`plugins/home-maintenance`](../../plugins/home-maintenance/) (SMD-2311). It runs inside the brain's own servers, behind the brain's own keys, and its tools appear on the MCP connector you already have. There is no separate server, key list or connector to set up. Its tables live in a schema of its own, `plugin_home_maintenance`, which the brain's migrator makes when you turn the plugin on.

**Tables:**
- `maintenance_tasks` — One-time or recurring tasks, each with its next due date and priority
- `maintenance_logs` — The work done: when, by whom, what it cost, what they recommended

**Tools** (each also a REST route under `/v1/plugins/home-maintenance/`):
- `home_maintenance_add_maintenance_task` — Add a one-time or recurring task
- `home_maintenance_list_maintenance_tasks` — List every task, with its id
- `home_maintenance_log_maintenance` — Log work done; the task's next due date moves on
- `home_maintenance_get_upcoming_maintenance` — What is due soon, and what is overdue
- `home_maintenance_search_maintenance_history` — Search the work done by task, category or dates

The plugin's [README](../../plugins/home-maintenance/README.md) gives each one's input, output and refusals.

## What You'll Learn

- Date handling and scheduling logic in PostgreSQL
- One-to-many relationships (task → multiple log entries)
- Time-based queries (upcoming and overdue tasks, date ranges)
- Computed fields (calculating next_due based on frequency, in the same transaction as the log)
- Historical logging patterns

## Prerequisites

- Working Open Brain setup: the compose stack ([`SETUP.md`](../../SETUP.md)) and an MCP client connected to it ([Getting Started](../../docs/01-getting-started.md), Steps 6 and 7)
- Extension 1 recommended but not required

## Steps

### 1. Turn on the Plugin

Add the plugin to `deploy/.env`, with the secret the plugins' database logins are derived from (skip the second line if another plugin already set it):

```
OB1_PLUGINS=home-maintenance
OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
```

Then recreate the migrator and the servers from `deploy/`, naming the stack's other `-f` files as you brought it up:

```bash
docker compose up -d migrate api mcp
docker compose up -d --force-recreate --no-deps app   # the operator GUI, so it reaches the recreated REST core; it signs everyone out
```

The migrator makes the plugin's tables, and the servers start with its five tools.

### 2. Check Your AI Sees It

Your MCP client lists the `home_maintenance_*` tools on the brain's own connector, once it refreshes its tool list. A read key sees the three that read. A write key sees all five.

### 3. Test It

Try these prompts:

```
Add a maintenance task: HVAC filter replacement, every 90 days, next due in three weeks
```

```
Log maintenance: I just changed the HVAC filter, cost $45, did it myself
```

```
What maintenance is coming up in the next 30 days, and is anything overdue?
```

```
Show me the history for HVAC maintenance
```

## Cross-Extension Integration

The maintenance tracker introduces patterns you'll see throughout the remaining extensions:

- **Task → Log entries pattern**: A parent record (maintenance_task) with multiple child records (maintenance_logs). This same one-to-many pattern appears in:
  - Extension 5 (Professional CRM): contact → interaction logs
  - Extension 6 (Job Hunt Pipeline): application → interview logs

- **Auto-calculated dates**: Logging work updates the task's `last_completed` and calculates `next_due` from `frequency_days`, in the same transaction, so the task and its history never disagree.

- **Time-based queries**: Upcoming maintenance shows how to query for records in a date range, and what is overdue — essential for calendar systems (Extension 3) and deadline tracking (Extension 6).

- **Historical search**: Searching the history crosses both tables with date filtering.

### Connection to Extension 1

If you built Extension 1 (Household Knowledge Base), you can name your vendors when logging maintenance. The `performed_by` field holds the vendor's name, an informal link between the two.

## Expected Outcome

After completing this extension, you should be able to:

1. Create recurring and one-time maintenance tasks
2. Log completed maintenance with cost and notes
3. Have next due dates calculated from each task's frequency
4. See upcoming and overdue maintenance
5. Search maintenance history by task, category, or date range

Your agent will be able to answer questions like:
- "What maintenance is due this month?"
- "When did we last service the HVAC?"
- "How much have we spent on plumbing maintenance this year?"
- "What did the electrician recommend last time?"

## Troubleshooting

For common issues (connection errors, 401s), see [Common Troubleshooting](../../primitives/troubleshooting/). The plugin's own troubleshooting is in [its README](../../plugins/home-maintenance/README.md#troubleshooting).

**Extension-specific issues:**

**No `home_maintenance_*` tools**
- Check that `OB1_PLUGINS` in `deploy/.env` names `home-maintenance`, and that the migrator and servers were recreated after it was set
- Refresh your client's tool list

**"next_due not updating after logging maintenance"**
- A one-time task (no `frequency_days`) is done once logged, with no next due date
- A log of work older than the task's last completion keeps the task where it was

**"Date errors"**
- Dates are `YYYY-MM-DD`

## Next Steps

**Extension 3: Family Calendar** — Build on your date-handling skills to create a shared calendar of the household's activities and the dates to remember. The calendar extends the time-based query patterns you learned here and introduces weekly activities and yearly dates.

[Continue to Extension 3 →](../family-calendar/README.md)

> **Tip:** As you turn on more plugins, your AI sees more tools. The [MCP Tool Audit & Optimization Guide](../../docs/05-tool-audit.md) covers strategies for managing your tool surface area.
