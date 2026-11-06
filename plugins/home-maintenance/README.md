# Home Maintenance Plugin

The house's maintenance tasks and the log of work done on them, kept in the brain itself (SMD-2311). An agent can say what is due or overdue, log work as it is done, and answer "when did we last service the HVAC?". It is the learning path's [Extension 2](../../extensions/home-maintenance/), which was a standalone MCP server with its own keys until it became this plugin.

## What it does

Two tables of its own, in the schema `plugin_home_maintenance`, made by `migrations/001_home_maintenance.sql`:

- `maintenance_tasks`: each task is one-time (clean the gutters) or recurring every `frequency_days` (change the HVAC filter every 90). It has a `priority` (low, medium, high or urgent), the day it is `next_due`, and the latest day work on it was logged (`last_completed`).
- `maintenance_logs`: the work done. Each entry has the task, the day, who did it, what it cost, and what they recommended next.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add a maintenance task | `home_maintenance_add_maintenance_task` | `POST /v1/plugins/home-maintenance/tasks` | `write` | `name`; `category`, `frequency_days` (1 to 3650), `next_due`, `priority` (medium unless given; one not given reads as unknown in the brain), `notes`, `today` optional | `{ task, item }` |
| The maintenance tasks | `home_maintenance_list_maintenance_tasks` | `GET /v1/plugins/home-maintenance/tasks` | `read` | `query`, `category`, `today` optional; `include_done` (default false); `limit`, 1 to 500, default 100 | `{ tasks, truncated }` |
| Log maintenance done | `home_maintenance_log_maintenance` | `POST /v1/plugins/home-maintenance/logs` | `write` | `task_id`, `completed_on`; `performed_by`, `cost`, `notes`, `next_action`, `today` optional | `{ log, task, item }` |
| Upcoming maintenance | `home_maintenance_get_upcoming_maintenance` | `GET /v1/plugins/home-maintenance/upcoming` | `read` | `days_ahead`, 0 to 366, default 30; `today` optional | `{ today, tasks }` |
| Search maintenance history | `home_maintenance_search_maintenance_history` | `GET /v1/plugins/home-maintenance/history` | `read` | `task_id`, `task_name`, `category`, `date_from`, `date_to` optional; `limit`, 1 to 200, default 50 | `{ logs, count, total_cost, truncated }` |
| Keep the tasks' open items | `home_maintenance_sync_open_items` | `POST /v1/plugins/home-maintenance/items/sync` | `write` | none | `{ opened, updated, settled, reopened, unchanged, priorities_stated, failed, items_truncated }` |

- **Formats.** Dates are `YYYY-MM-DD` from the year 0001, and timestamps are ISO text in UTC. A cost is a number, kept to two decimal places. Text is trimmed and holds no NUL.
- **Today.** The date in UTC is a day off from the user's for part of each day in most time zones. So:
  - a log's `completed_on` is required: the day the work was done, in the user's own calendar;
  - each operation that counts `days_until` (the task a log answers among them) takes an optional `today`, the user's date, and counts from the date in UTC without it. A `today` more than a day from the date in UTC is no time zone's, and is refused at 400.
- **A task** answers with:
  - its id;
  - `next_due` and `last_completed`;
  - `days_until` its due date: negative when it is overdue, null with no date;
  - `done`: a one-time task whose work has been logged.

  A recurring task added without `next_due` falls due `frequency_days` from today. One last done on a known day is added, then logged on that day.
- **Logging work** moves the task on, in the same transaction:
  - `last_completed` becomes the latest day logged;
  - a recurring task falls due `frequency_days` after that day;
  - a one-time task is done, with no due date.

  A log of older work is kept without moving the task back. A `completed_on` more than a day past today in UTC is refused, since no later log could bring the task's dates back. The answer is the log and the task as it now is.
- **Upcoming** lists the tasks due within `days_ahead` and every overdue one. They come soonest first, and urgent before high before medium before low within a day. A one-time task with no date, or one done, is not listed.
- **Every task** is in `list_maintenance_tasks`, which gives the ids `log_maintenance` takes. A done task is listed only with `include_done`, after the rest. Its `query` matches word by word: every word must be in the name, category or notes, in any order. `truncated` says whether more matched than `limit`.
- **History** lists the work logged, latest first, each entry with its task `{ id, name, category }`. `task_name` matches word by word, as a query does. The filters all apply together, and both edge days are included. `count` and `total_cost` are over every log that matched, not just the page, so "what did we spend this year?" needs one call. `truncated` says whether more matched than were listed.
- **Refusals.**
  - A `task_id` that names no task: `404 NO_SUCH_TASK`, saying where the ids are.
  - A `date_to` before `date_from`: `422 BAD_DATES`.
  - A `completed_on` more than a day past today in UTC: `422 FUTURE_DATE`.
  - Input out of its form or range: `400`, before anything is stored.
- **Open items** (SMD-3665 PR 3b). Each task is an open item in the brain, standing for the task's row, so a brain's reads (`list_items`, overdue among them) see it beside every other to-do:
  - `add_maintenance_task` opens it `proposed`, due at the task's `next_due` (the start of that day in UTC), by the calling key; a write key confirms it (`set_item_status`, open) or dismisses it (dropped);
  - `log_maintenance` moves a recurring task's item to its new `next_due`, and settles a one-time task's done, keeping the day it was due;
  - a recurring task comes round again, so its item, settled done by a key, is reopened at its next due day, by the next log or `sync_open_items`; an item a key dropped is left as it is.

  `item` in the answer is `{ id, status }`, or `null` when the brain did not keep it: the task is stored all the same, its item kept after the plugin's own transaction commits. `sync_open_items` keeps every task's at once, the same way: it opens a missing one (a task added before items, or one whose item came back `null`), moves a renamed task's text or a moved due day onto its item, settles a done one-time task's item still live, and reopens a recurring task's item settled done. A done task with no item gets none. Two logs of one task at once may leave its item's due day a log behind, since each keeps the item after its own transaction; the next log or sync puts it right. `items_truncated` says the brain held more than 1000 of the plugin's live items, so a done one-time task's item past them may be left live. Run it once after turning items on; it is safe to run again.
- **Priorities** (SMD-3666 PR 3). A task's own `priority` is stated on its open item through `set_priority`, at the calling key's tier, mapped by `docs/priority.md`'s table: low 1, medium 2, high 3, urgent 4, the task's word the reason. The column's default, medium, is no statement: a task added without a `priority` stays medium here and reads as unknown in the brain (`priority_chosen`, migration `002_priority_chosen.sql`, records whether it was given; a task from before it reads as not given). `add_maintenance_task` states it as the item opens; `sync_open_items` states every live item's again, the same again writing nothing (`priorities_stated` counts what it wrote or cleared), and clears one whose task went back to the unchosen default. A settled item's priority is left. The due day is the item's own, so none is stated beside the level. Each statement is the calling key's, and a key clears only its own: a task added under one key and changed in the table, then synced under another, keeps the first key's statement beside the second's, and the higher tier wins until the first key syncs again (the plugin has no operation that changes a priority).
- **MCP hints.** Every tool is closed-world, a read is read-only, and a write is marked as destroying nothing; `sync_open_items` is idempotent too.

It reads and writes no thought. It reaches the core through `ctx.call` for its tasks' open items alone. The old schema's two triggers, `updated_at` and a task's dates moved on when work is logged, are `log_maintenance`'s own statements now, so no function lives in the plugin's schema.

**`user_id`.** Each table keeps upstream's multi-user `user_id` column, nullable, and nothing writes or reads it. Daemonic Brain is one operator's brain (SMD-1716), so every key that may read sees every row (decided 2026-11-02).

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to add tasks and log work.

## Turn it on

1. Add the plugin to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all.

   ```
   OB1_PLUGINS=home-maintenance
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   Names are comma-separated: `OB1_PLUGINS=family-calendar,home-maintenance` runs both.
2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate api mcp` from `deploy/`, then `docker compose up -d --force-recreate --no-deps app`, so the operator GUI reaches the recreated REST core at once. Name the stack's other `-f` files in both. Recreating `app` signs everyone out of the GUI. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_home_maintenance`, and applies `001_home_maintenance.sql`.
3. Check it:
   - preflight's `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists the three reads for a read key, and all five tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its tables and rows stay and come back when it is turned on again.

## Moving from the standalone server

The standalone server kept its rows in `public.maintenance_tasks` and `public.maintenance_logs`. A plugin's migrations run as its own role in its own schema, and cannot adopt them. Neither dogfood brain held them. On a brain that does:

1. Turn the plugin on (above).
2. Copy the rows across as the database owner, in `psql`. It is one transaction, so a refused row copies nothing and the whole block can be run again:

   ```sql
   \set ON_ERROR_STOP on
   BEGIN;
   INSERT INTO plugin_home_maintenance.maintenance_tasks (id, user_id, name, category, frequency_days, last_completed, next_due, priority, notes, created_at, updated_at)
     SELECT id, user_id, name, category, frequency_days, (last_completed AT TIME ZONE 'UTC')::date, (next_due AT TIME ZONE 'UTC')::date,
            coalesce(priority, 'medium'), notes, created_at, updated_at FROM public.maintenance_tasks;
   INSERT INTO plugin_home_maintenance.maintenance_logs (id, task_id, user_id, completed_on, performed_by, cost, notes, next_action)
     SELECT id, task_id, user_id, (completed_at AT TIME ZONE 'UTC')::date, performed_by, cost, notes, next_action FROM public.maintenance_logs;
   UPDATE plugin_home_maintenance.maintenance_tasks t
      SET last_completed = m.last, next_due = CASE WHEN t.frequency_days IS NULL THEN NULL ELSE m.last + t.frequency_days END
     FROM (SELECT task_id, max(completed_on) AS last FROM plugin_home_maintenance.maintenance_logs GROUP BY task_id) m
    WHERE t.id = m.task_id;
   COMMIT;
   ```

   - **`user_id`.** Each row keeps its `user_id`, in the column the plugin keeps and ignores.
   - **Dates.** The old tables held timestamps. Each becomes its date in UTC. A log's `created_at` is the time of the copy.
   - **Each task's dates, recomputed.** The old trigger took `last_completed` from whichever log was written last, so a log of older work written later moved a task back. The `UPDATE` sets each logged task's `last_completed` to its latest log's day and its `next_due` from that, as `log_maintenance` does: a recurring task `frequency_days` on, a one-time task done.
   - **A refused copy.** The plugin's tables check what the old ones did not:
     - a name of 1 to 200 characters;
     - a frequency of 1 to 3650 days;
     - a cost of 0 or more.

     If a row breaks one of these, the copy names the check and nothing is copied. Fix that row in `public` and run the block again.
   - **Leftover tables.** Once the plugin's answers look right, the old tables can be dropped by hand.
3. Give the copied tasks their open items and priorities (SMD-3665, SMD-3666): call `sync_open_items` once with a write key (`POST /v1/plugins/home-maintenance/items/sync`). A copy writes the tables alone, so until then no copied task is in the brain's reads. A copied task reads as its priority not chosen (`priority_chosen` false): its medium is unknown in the brain, and its low, high or urgent is stated.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_home_maintenance".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add or log. Over MCP, a read key's tool list has no write tools at all.
- **A task is missing from upcoming.** A one-time task with no `next_due`, or one done, is never upcoming. `list_maintenance_tasks` lists every task, and with `include_done` the done ones too.
- **`next_due` did not move after logging.** The log was of older work than the task's `last_completed`, which keeps the task where it was, or the task is one-time and now done.
