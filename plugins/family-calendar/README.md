# Family Calendar Plugin

The household's members, their activities and the dates to remember, kept in the brain itself (SMD-2311). An agent can read the week's schedule, find an activity, and see which birthdays and deadlines are coming up. It is the learning path's [Extension 3](../../extensions/family-calendar/), which was a standalone MCP server with its own keys until it became this plugin.

## What it does

Three tables of its own, in the schema `plugin_family_calendar`, made by `migrations/001_family_calendar.sql`:

- `family_members`: the people in the household.
- `activities`: each is a one-off (a dentist appointment), a span of days (a camp), or weekly on a day (swimming every Monday), bounded by dates if it has them. It belongs to one member, or with none to the whole family.
- `important_dates`: birthdays, anniversaries and deadlines. A yearly one comes round on the same day each year.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add a family member | `family_calendar_add_family_member` | `POST /v1/plugins/family-calendar/members` | `write` | `name`; `relationship`, `birth_date`, `notes` optional | `{ member }` |
| The family members | `family_calendar_list_family_members` | `GET /v1/plugins/family-calendar/members` | `read` | none | `{ members }`, by name |
| Schedule an activity | `family_calendar_add_activity` | `POST /v1/plugins/family-calendar/activities` | `write` | `title`; `family_member_id`, `activity_type`, `day_of_week`, `start_time`, `end_time`, `start_date`, `end_date`, `location`, `notes` optional | `{ activity }` |
| The week's schedule | `family_calendar_get_week_schedule` | `GET /v1/plugins/family-calendar/week` | `read` | `week_start`; `family_member_id` optional | `{ week_start, week_end, activities }`, each with `on_date` |
| Search activities | `family_calendar_search_activities` | `GET /v1/plugins/family-calendar/activities` | `read` | `query`, `activity_type`, `family_member_id` optional; `limit`, 1 to 200, default 50 | `{ activities, truncated }` |
| Add a date to remember | `family_calendar_add_important_date` | `POST /v1/plugins/family-calendar/dates` | `write` | `title`, `date_value`; `family_member_id`, `recurring_yearly` (default false), `reminder_days_before` (0 to 365, default 7), `notes`, `today` optional | `{ important_date, item }`, with `next_date` |
| Upcoming dates | `family_calendar_get_upcoming_dates` | `GET /v1/plugins/family-calendar/dates` | `read` | `days_ahead`, 0 to 366, default 30; `today` optional | `{ today, dates }` |
| Keep the dates' open items | `family_calendar_sync_open_items` | `POST /v1/plugins/family-calendar/items/sync` | `write` | `today` optional | `{ opened, updated, unchanged, failed }` |

- **Formats.** Dates are `YYYY-MM-DD` from the year 0001, and times `HH:MM` on the 24-hour clock, both in and out. `day_of_week` is a lower-case day name (`monday`). Text is trimmed and holds no NUL.
- **Activities.**
  - A one-off gives `start_date` alone: with no `end_date` it is that one day.
  - A span gives `start_date` and `end_date`; one day is a span whose end is its start.
  - A weekly one gives `day_of_week`, and dates to bound it if it has them. With no `end_date` it runs on.
  - An activity with neither a day nor a start date is refused.
- **Members.** Every activity and date answers `family_member` as `{ id, name, relationship }`, or `null` for the whole family's. `list_family_members` gives every member's id. A member filter or a `family_member_id` that names no one is refused rather than answered empty.
- **The week.** `get_week_schedule` covers the seven days from `week_start`, in date order and by start time within a day (an activity with no time last). Each activity carries `on_date`, the date it falls on that week. It returns:
  - each weekly activity whose day in that week falls within its own dates, where it has them (a Monday class starting on a Wednesday first appears the week after);
  - each one-off in the week of its day;
  - each span in every week it overlaps, once, on its first day in the week.
- **Searching.** `search_activities` matches `query` word by word: every word must be in the title, the member's name, the location or the notes, in any case and any order. `truncated` says whether more matched than `limit`. A `%`, `_` or backslash in it matches itself. `activity_type` matches in any case. The latest start date comes first, then the activities with none, newest first.
- **Upcoming dates.** `get_upcoming_dates` lists dates from today to `days_ahead` days on, soonest first. It also lists any date further off whose `reminder_days_before` has already begun.
  - A yearly date counts on its next anniversary, reckoned from its month and day whatever year it was stored under: a birth year, or next year's. A 29 February falls on the 28th in other years.
  - A one-time date before today is never listed. `add_important_date` answers its `next_date` as `null`, so an agent can say so.
  - Each listed date carries `next_date`, `days_until`, and `remind`: whether it is within its `reminder_days_before`.
  - "Today" is the user's date when the agent gives it as `today`, on the read or on the add's `next_date`, else the date in UTC. The read's answer says which day it counted from. A `today` more than a day from the date in UTC is refused at 400.
- **Refusals.**
  - An activity with neither a `day_of_week` nor a `start_date`: `422 NO_WHEN`.
  - A `family_member_id` that names no member, on an add or a filter: `404 NO_SUCH_MEMBER`, saying where the ids are.
  - An `end_date` before the `start_date`: `422 BAD_DATES`.
  - A date, time, day, id or number out of its form or range: `400`, before anything is stored.
- **Open items** (SMD-3665 PR 3b). A one-time date still to come, a deadline, is an open item in the brain, standing for the date's row, so a brain's reads (`list_items`, overdue among them) see it beside every other to-do. Birthdays, anniversaries and activities have none (the maintainer, 2026-11-04).
  - `add_important_date` opens it `proposed`, due that day (the start of it in UTC), its member's name its `owner` (a whole family's names none, so one a key gives its item is kept), by the calling key; a write key confirms it (`set_item_status`, open) or dismisses it (dropped). `item` in the answer is `{ id, status }`, or `null` for a yearly date, a one-time date already past, or when the brain did not keep it: the date is stored all the same.
  - `sync_open_items` keeps the item of every one-time date from today on (the user's, given as `today`): it opens a missing one (a date added before items, or one whose item came back `null`) and moves a changed title, day or member onto its item. A date already past is left as it is, its item, if any, kept for a key to settle. An item a key settled or dropped is left as it is. Run it once after turning items on; it is safe to run again.
- **MCP hints.** Every tool is closed-world, a read is read-only, and an add is marked as destroying nothing; `sync_open_items` is idempotent too.

It reads and writes no thought. It reaches the core through `ctx.call` for its deadlines' open items alone.

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
   - `GET /v1/whoami` lists the four reads for a read key, and all seven tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its tables and rows stay and come back when it is turned on again.

## Moving from the standalone server

The standalone server kept its rows in `public.family_members`, `public.activities` and `public.important_dates`. A plugin's migrations run as its own role in its own schema, and cannot adopt them. Neither dogfood brain held them. On a brain that does:

1. Turn the plugin on (above).
2. Copy the rows across as the database owner, in `psql`. It is one transaction, so a refused row copies nothing and the whole block can be run again:

   ```sql
   \set ON_ERROR_STOP on
   BEGIN;
   INSERT INTO plugin_family_calendar.family_members (id, user_id, name, relationship, birth_date, notes, created_at)
     SELECT id, user_id, name, relationship, birth_date, notes, coalesce(created_at, now()) FROM public.family_members;
   INSERT INTO plugin_family_calendar.activities (id, user_id, family_member_id, title, activity_type, day_of_week, start_time, end_time, start_date, end_date, location, notes, created_at)
     SELECT id, user_id, family_member_id, title, activity_type, lower(day_of_week), start_time, end_time, start_date, end_date, location, notes, coalesce(created_at, now()) FROM public.activities;
   INSERT INTO plugin_family_calendar.important_dates (id, user_id, family_member_id, title, date_value, recurring_yearly, reminder_days_before, notes, created_at)
     SELECT id, user_id, family_member_id, title, date_value, coalesce(recurring_yearly, false), coalesce(reminder_days_before, 7), notes, coalesce(created_at, now()) FROM public.important_dates;
   COMMIT;
   ```

   - **`user_id`.** Each row keeps its `user_id`, in the column the plugin keeps and ignores. Rows from two users land in one household, and the column still says whose each was.
   - **A refused copy.** The plugin's tables check what the old ones did not:
     - a lower-case day name;
     - an activity with a day or a start date;
     - an end date on or after the start;
     - a name and title of 1 to 200 characters;
     - a reminder of 0 to 365 days.

     If a row breaks one of these, the copy names the check and nothing is copied. Fix that row in `public` and run the block again.
   - **Times.** A time stored with seconds (`16:00:30`) is answered to the minute (`16:00`).
   - **Leftover tables.** Once the plugin's answers look right, the old tables can be dropped by hand.
3. Give the copied one-time dates still to come their open items (SMD-3665): call `sync_open_items` once with a write key (`POST /v1/plugins/family-calendar/items/sync`, `today` the user's date). A copy writes the tables alone, so until then no copied deadline is in the brain's reads.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_family_calendar".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add. Over MCP, a read key's tool list has no write tools at all.
- **An activity is missing from the week.** Check its `start_date` and `end_date`. A one-off is in the week of its day alone. A weekly activity is listed only where its day in that week falls within its dates: one starting midweek after its day first appears the week after.
