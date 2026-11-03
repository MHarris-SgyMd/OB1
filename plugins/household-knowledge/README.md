# Household Knowledge Plugin

Facts about the things in the home, and the vendors who work on it, kept in the brain itself (SMD-2311). An agent can answer "what colour is the living room?", "what model is the dishwasher?" or "who was our plumber?". It is the learning path's [Extension 1](../../extensions/household-knowledge/), which was a standalone MCP server with its own keys until it became this plugin.

## What it does

Two tables of its own, in the schema `plugin_household_knowledge`, made by `migrations/001_household_knowledge.sql`:

- `household_items`: a fact about something in the home. It has a name, a category, where it is, and its `details`: an object of whatever keys suit it, such as a brand, a model, a colour code or a serial number.
- `household_vendors`: the service providers. Each has what they do, how to reach them, a rating from 1 to 5, and the day they last worked on the house.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add a household item | `household_knowledge_add_household_item` | `POST /v1/plugins/household-knowledge/items` | `write` | `name`; `category`, `location`, `details` (an object), `notes` optional | `{ item }` |
| Search household items | `household_knowledge_search_household_items` | `GET /v1/plugins/household-knowledge/items` | `read` | `query`, `category`, `location` optional; `limit`, 1 to 200, default 50 | `{ items }` |
| A household item | `household_knowledge_get_item_details` | `GET /v1/plugins/household-knowledge/items/{item_id}` | `read` | `item_id` | `{ item }` |
| Add a vendor | `household_knowledge_add_vendor` | `POST /v1/plugins/household-knowledge/vendors` | `write` | `name`; `service_type`, `phone`, `email`, `website` (http or https), `notes`, `rating` (1 to 5), `last_used` optional | `{ vendor }` |
| The vendors | `household_knowledge_list_vendors` | `GET /v1/plugins/household-knowledge/vendors` | `read` | `service_type`, `query` optional; `limit`, 1 to 500, default 100 | `{ vendors }`, by name |

- **Formats.** Dates are `YYYY-MM-DD` from the year 0001, and timestamps are ISO text in UTC. Text is trimmed and holds no NUL.
- **`details`** is an object, at most 10,000 characters as JSON. The standalone server took it as a JSON string. A string, a list or a NUL anywhere in it is refused at 400.
- **Searching items.** `query` matches the name, category, location, notes and every value in `details`, in any case: "sea salt" finds the paint whose `details` say `"color": "Sea Salt"`. `category` and `location` match part of theirs, in any case. A `%`, `_` or backslash matches itself. Every filter given applies, and the newest item comes first.
- **Vendors** are listed by name. `service_type` matches part of the service type ("plumb" finds the plumbers), and `query` matches the name, service type or notes.
- **Refusals.**
  - An `item_id` that names no item: `404 NO_SUCH_ITEM`, saying where the ids are.
  - An email that is no address, a website that is not http or https, a rating outside 1 to 5, or any input out of its form or range: `400`, before anything is stored.
- **MCP hints.** Every tool is closed-world, a read is read-only, and an add is marked as destroying nothing.

It reaches nothing of the core's: no thought is read or written.

**`user_id`.** Each table keeps upstream's multi-user `user_id` column, nullable, and nothing writes or reads it. The fork is one operator's brain (SMD-1716), so every key that may read sees every row (decided 2026-11-02).

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to add items and vendors.

## Turn it on

1. Add the plugin to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all.

   ```
   OB1_PLUGINS=household-knowledge
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   Names are comma-separated: `OB1_PLUGINS=household-knowledge,home-maintenance` runs both.
2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate api mcp` from `deploy/`, then `docker compose up -d --force-recreate --no-deps app`, so the operator GUI reaches the recreated REST core at once. Name the stack's other `-f` files in both. Recreating `app` signs everyone out of the GUI. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_household_knowledge`, and applies `001_household_knowledge.sql`.
3. Check it:
   - preflight's `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists the three reads for a read key, and all five tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its tables and rows stay and come back when it is turned on again.

## Moving from the standalone server

The standalone server kept its rows in `public.household_items` and `public.household_vendors`. A plugin's migrations run as its own role in its own schema, and cannot adopt them. Neither dogfood brain held them. On a brain that does:

1. Turn the plugin on (above).
2. Copy the rows across as the database owner, in `psql`. It is one transaction, so a refused row copies nothing and the whole block can be run again:

   ```sql
   \set ON_ERROR_STOP on
   BEGIN;
   INSERT INTO plugin_household_knowledge.household_items (id, user_id, name, category, location, details, notes, created_at, updated_at)
     SELECT id, user_id, name, category, location,
            CASE WHEN details IS NULL THEN '{}'::jsonb WHEN jsonb_typeof(details) = 'object' THEN details ELSE jsonb_build_object('value', details) END,
            notes, created_at, updated_at FROM public.household_items;
   INSERT INTO plugin_household_knowledge.household_vendors (id, user_id, name, service_type, phone, email, website, notes, rating, last_used, created_at)
     SELECT id, user_id, name, service_type, phone, email, website, notes, rating, last_used, created_at FROM public.household_vendors;
   COMMIT;
   ```

   - **`user_id`.** Each row keeps its `user_id`, in the column the plugin keeps and ignores.
   - **`details` that is not an object.** The standalone server once stored `details` as an escaped JSON string. Any `details` that is not an object (a string, a list) is kept under a `value` key, so nothing is lost and search still finds it. A null becomes `{}`.
   - **A refused copy.** The plugin's tables check a name of 1 to 200 characters, as the old ones did not. If a row breaks it, the copy names the check and nothing is copied. Fix that row in `public` and run the block again.
   - **Leftover tables.** Once the plugin's answers look right, the old tables can be dropped by hand.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_household_knowledge".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add. Over MCP, a read key's tool list has no write tools at all.
- **`400` on `details`.** It is an object, `{"brand": "Bosch"}`, not a string holding JSON.
