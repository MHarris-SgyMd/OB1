# Extension Name Plugin

<!--
TEMPLATE: the plugin's own README, plugins/<name>/README.md (SMD-3747). It is
the reference for the plugin's operations: the extension's guide,
extensions/<name>/README.md, walks a person through turning it on and links
here for the detail. Replace "Extension Name", "extension-name" and
"extension_name" (the tool prefix: the name with hyphens as underscores), and
describe your own tables and operations. Delete this comment.
-->

What the plugin keeps, kept in the brain itself, and what an agent can answer with it: "what did I note about …?", "find the entry for …". It is the learning path's [Extension N](../../extensions/extension-name/).

## What it does

One table of its own, in the schema `plugin_extension_name`, made by `migrations/001_entries.sql`:

- `entries`: what the extension keeps. Each has a name and notes.

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Add an entry | `extension_name_add_entry` | `POST /v1/plugins/extension-name/entries` | `write` | `name`; `notes` optional | `{ entry }` |
| Search entries | `extension_name_search_entries` | `GET /v1/plugins/extension-name/entries` | `read` | `query` optional; `limit`, 1 to 200, default 50 | `{ entries, truncated }`, newest first |
| An entry | `extension_name_get_entry` | `GET /v1/plugins/extension-name/entries/{entry_id}` | `read` | `entry_id` | `{ entry }` |

- **Formats.** Timestamps are ISO text in UTC. Text is trimmed and holds no NUL.
- **Searching.** `query` matches part of the name or the notes, in any case; `%` and `_` match themselves.
- **Truncated.** A search says whether more matched than its `limit`.
- **Refusals.** An `entry_id` that names no entry: `404 NO_SUCH_ENTRY`. Any input out of its form or range: `400`, before anything is stored.
- **MCP hints.** Every tool is closed-world, a read is read-only, and an add is marked as destroying nothing.

It reaches nothing of the core's: no thought is read or written.

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to add entries.

## Turn it on

1. Add the plugin to `deploy/.env`, with the secret each plugin's login role's password is derived from. If `OB1_PLUGIN_DB_PASSWORD` is already set for another plugin, keep it: one secret serves them all.

   ```
   OB1_PLUGINS=extension-name
   OB1_PLUGIN_DB_PASSWORD=<openssl rand -hex 32>
   ```

   Names are comma-separated: `OB1_PLUGINS=extension-name,household-knowledge` runs both.
2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate api mcp` from `deploy/`, then `docker compose up -d --force-recreate --no-deps app`, so the operator GUI reaches the recreated REST core at once. Name the stack's other `-f` files in both. Recreating `app` signs everyone out of the GUI. The migrator makes the plugin's role, its schema and its login role `ob1_plugins_extension_name` (the first time), and applies `001_entries.sql`.
3. Check it:
   - preflight's `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists the two reads for a read key, and all three tools for a write key;
   - your MCP client sees the same tools on the brain's own connector, with no new connector or key.

Remove the name from `OB1_PLUGINS` and recreate the same services to turn it off. Its tools and routes go, while its table and rows stay and come back when it is turned on again.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The running image predates the plugin. Pull or rebuild it.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins_extension_name".** `OB1_PLUGIN_DB_PASSWORD` is not the secret the role was made with. [The example plugin's troubleshooting](../example/README.md#troubleshooting) says how to set it back or change both.
- **`403 FORBIDDEN` with `needs: "write"`.** A read key cannot add. Over MCP, a read key's tool list has no write tools at all.
- **`404 NO_SUCH_ENTRY`.** The id names no entry: `search_entries` lists them.
