# Plugins

A plugin adds operations to the brain itself (SMD-2310). It runs inside the brain's own servers (the REST core and the MCP server), and its operations join the brain's one contract. The REST core serves them under `/v1/plugins/<name>/`, the MCP server lists them as tools named `<name>_<operation>`, and the OpenAPI document describes them. Each one sits behind the same scope gate as a core operation. A plugin has no server, keys or database connection of its own.

| Plugin | What it does |
| --- | --- |
| [example](example/) | The template: a read operation over the core, and notes pinned to thoughts in a table of its own |

## Turning plugins on

The operator names the plugins a brain runs in `OB1_PLUGINS` in `deploy/.env`, comma-separated. A plugin that is not named registers nothing. A name that is no plugin stops the server, and preflight says so first. The three-tier stack runs none.

## What a plugin is

A directory, `plugins/<name>/`, with:

- `index.ts`: the manifest, `export default definePlugin({...})` from `server-portable/plugin-sdk.ts`.
  - **The name** is the directory's: lower-case words joined by hyphens.
  - **Each operation** declares a title, a description and the scope a key needs (`read`, `capture` or `write`). It also declares its REST method and path under the plugin's, an input and an output as zod shapes, and a handler.
  - **The handler** returns `ok(value)` or `refuse(status, CODE, facts)`. A value is held to the output schema; one that does not fit is the plugin's fault, answered as `FAILED`.
- `migrations/` (optional): the plugin's tables, as `NNN_name.sql` files. See below.
- `README.md` and `metadata.json` (`"category": "plugins"`), as every contribution has.
- An entry in [registry.ts](registry.ts). The server runs only plugins built into its image; nothing is loaded by a name the environment gives.

## A plugin's tables

A plugin's tables live in a Postgres schema of its own, `plugin_<name>`, owned by a role of its own, `ob1_plugin_<name>` (hyphens read as `_`).

- **Migrating.** The migrator applies an enabled plugin's `migrations/` after the core's, each file run as that role with its schema first on the path. It records them in their own ledger, `plugin_migrations` ([db/README.md](../db/README.md), "Plugin migrations"). Run it with the same `OB1_PLUGINS`; the compose migrator reads it from `deploy/.env`.
- **At runtime.** A handler reaches them through `ctx.db.tx(async (sql) => …)`: one transaction as the same role, in the same schema. Tables are named bare, and each `${value}` is a bound parameter. A plugin with no `migrations/` has no role or schema, so its `ctx.db` refuses, naming them.
- **The boundary.** The role holds nothing on the core's tables, so Postgres refuses a migration or a handler that reaches for one. The brain's thoughts are reached through `ctx.call` alone.
- **No foreign keys into the core.** A row that names a thought holds its id, and the operation checks the thought through the core, as the example's `add_note` does.
- **Turning a plugin off** removes its operations and runs none of its migrations. Its schema, tables and rows are left as they are.

## The rules a plugin is held to

Checked when the server starts, so a malformed manifest stops it:

- No two operations share a tool name, and none takes a core tool's name.
- No two operations of a plugin have routes that one request could match (`/items/{id}` beside `/items/latest`).
- A path field is a string field.
- An output schema does not transform: MCP holds the answer to it a second time.
- A refusal is 400, 403, 404, 409 or 422 with an `UPPER_CASE` code, and is never retryable.

Held by the maintainer's review:

- **Imports.** A plugin imports `server-portable/plugin-sdk.ts` and its own files, nothing else; zod comes from the SDK.
- **No role, session or transaction change in its SQL.** `SET ROLE` holds a plugin's SQL to its own tables only while that SQL does not undo it. These are refused in review: `RESET ROLE`, `SET ROLE` or `SET SESSION AUTHORIZATION`; a `search_path` change or `set_config`; `COMMIT`, `ROLLBACK` or `BEGIN` (a migration file that commits leaves the rest running as the migrator); and temp objects, session advisory locks or held cursors.
- **The brain's thoughts are reached through `ctx.call(name, input)` alone.** That is a core operation called as the caller, behind the caller's own scope: a read operation called with a read key cannot capture or update. A write through it names the caller on its audit row.
- **An output says only what the caller may see.** `ctx.call` hands back the core operation's whole value: for `capture_thought`, more than the REST core tells a key that cannot read (`rest/app.ts`'s `capturedFor`). What reaches the caller is what the output schema declares, so it should not declare more.

Plugins are **curated**: they run in the brain's process with its privileges, so a new one needs maintainer review.
