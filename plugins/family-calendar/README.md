# Family Calendar Plugin

The household's members, their activities and the dates to remember, kept in the brain itself (SMD-2311). An agent can read the week's schedule, find an activity, and see which birthdays and deadlines are coming up. It is the learning path's [Extension 3](../../extensions/family-calendar/), which was a standalone MCP server with its own keys until it became this plugin.

## What it does

Three tables of its own, in the schema `plugin_family_calendar`, made by `migrations/001_family_calendar.sql`:

- `family_members`: the people in the household.
- `activities`: each one is either weekly on a day (swimming every Monday) or dated alone (a camp from one day to another). It belongs to one member, or with none to the whole family.
- `important_dates`: birthdays, anniversaries and deadlines. A yearly one comes round on the same day each year.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add a family member | `family_calendar_add_family_member` | `POST /v1/plugins/family-calendar/members` | `write` | `name`; `relationship`, `birth_date`, `notes` optional | `{ member }` |
| Schedule an activity | `family_calendar_add_activity` | `POST /v1/plugins/family-calendar/activities` | `write` | `title`; `family_member_id`, `activity_type`, `day_of_week`, `start_time`, `end_time`, `start_date`, `end_date`, `location`, `notes` optional | `{ activity }` |
| The week's schedule | `family_calendar_get_week_schedule` | `GET /v1/plugins/family-calendar/week` | `read` | `week_start`; `family_member_id` optional | `{ week_start, week_end, activities }` |
| Search activities | `family_calendar_search_activities` | `GET /v1/plugins/family-calendar/activities` | `read` | `query`, `activity_type`, `family_member_id` optional; `limit`, 1 to 200, default 50 | `{ activities }` |
| Add a date to remember | `family_calendar_add_important_date` | `POST /v1/plugins/family-calendar/dates` | `write` | `title`, `date_value`; `family_member_id`, `recurring_yearly` (default false), `reminder_days_before` (0 to 365, default 7), `notes` optional | `{ important_date }` |
| Upcoming dates | `family_calendar_get_upcoming_dates` | `GET /v1/plugins/family-calendar/dates` | `read` | `days_ahead`, 0 to 366, default 30 | `{ today, dates }` |

- **Formats.** Dates are `YYYY-MM-DD` from the year 0001, and times `HH:MM` on the 24-hour clock, both in and out. `day_of_week` is a lower-case day name (`monday`). An activity is weekly (a `day_of_week`) or dated (a `start_date`), or both: a weekly one whose dates bound it.
- **Members on answers.** Every activity and date answers `family_member` as `{ id, name, relationship }`, or `null` for the whole family's.
- **The week.** `get_week_schedule` covers the seven days from `week_start`. It returns:
  - each weekly activity whose day in that week falls within its own dates, where it has them (a Monday class starting on a Wednesday first appears the week after);
  - each dated activity whose `start_date` to `end_date` overlaps the week (no `end_date` means it runs on).

  They are ordered by start time.
- **Searching.** `search_activities` matches `query` against the title or the member's name, in any case. A `%` or `_` in it matches itself. The latest start date comes first, then the activities with none.
- **Upcoming dates.** `get_upcoming_dates` lists dates from today to `days_ahead` days on, soonest first.
  - A yearly date counts on its next anniversary, so a birthday stored with its birth year is listed in the right week. A 29 February falls on the 28th in other years.
  - Each date carries `next_date`, `days_until`, and `remind`: whether it is within its `reminder_days_before`.
  - "Today" is the database's date.
- **Refusals.**
  - An activity with neither a `day_of_week` nor a `start_date`, which no week would list: `422 NO_WHEN`.
  - A `family_member_id` that names no member: `404 NO_SUCH_MEMBER`.
  - An `end_date` before the `start_date`: `422 BAD_DATES`.
  - A date, time or day that is malformed: `400`, before anything is stored.

It reaches nothing of the core's: no thought is read or written.

**`user_id`.** Each table keeps upstream's multi-user `user_id` column, nullable, and nothing writes or reads it. The fork is one operator's brain (SMD-1716), so every key that may read sees every row. The column waits for a multi-user change that may never come (decided 2026-11-02).

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to add members, activities and dates.

## Turn it on

1. Add the plugin to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all.

   ```
   OB1_PLUGINS=family-calendar
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   Names are comma-separated: `OB1_PLUGINS=example,family-calendar` runs both.
2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate api mcp` from `deploy/`, then `docker compose up -d --force-recreate --no-deps app`, so the operator GUI reaches the recreated REST core at once. Name the stack's other `-f` files in both. Recreating `app` signs everyone out of the GUI. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_family_calendar`, and applies `001_family_calendar.sql`.
3. Check it:
   - preflight's `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists the three reads for a read key, and all six tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its tables and rows stay and come back when it is turned on again.

## Moving from the standalone server

The standalone server kept its rows in `public.family_members`, `public.activities` and `public.important_dates`. A plugin's migrations run as its own role in its own schema, and cannot adopt them. Neither dogfood brain held them. On a brain that does:

1. Turn the plugin on (above).
2. Copy the rows across as the database owner, in `psql`:

   ```sql
   INSERT INTO plugin_family_calendar.family_members (id, name, relationship, birth_date, notes, created_at)
     SELECT id, name, relationship, birth_date, notes, coalesce(created_at, now()) FROM public.family_members;
   INSERT INTO plugin_family_calendar.activities (id, family_member_id, title, activity_type, day_of_week, start_time, end_time, start_date, end_date, location, notes, created_at)
     SELECT id, family_member_id, title, activity_type, lower(day_of_week), start_time, end_time, start_date, end_date, location, notes, coalesce(created_at, now()) FROM public.activities;
   INSERT INTO plugin_family_calendar.important_dates (id, family_member_id, title, date_value, recurring_yearly, reminder_days_before, notes, created_at)
     SELECT id, family_member_id, title, date_value, coalesce(recurring_yearly, false), coalesce(reminder_days_before, 7), notes, coalesce(created_at, now()) FROM public.important_dates;
   ```

   - **A refused copy.** The plugin's tables check what the old ones did not: a lower-case day name, an end date on or after the start, a name and title of 1 to 200 characters, and a reminder of 0 to 365 days. If a row breaks one of these, the copy is refused and names the check. Fix that row in `public` and run the copy again.
   - **Leftover tables.** Once the plugin's answers look right, the old tables can be dropped by hand.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_family_calendar".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add. Over MCP, a read key's tool list has no write tools at all.
- **An activity is missing from the week.** Check its `start_date` and `end_date`. A weekly activity is listed only where its day in that week falls within them: one starting midweek after its day first appears the week after.
