# Plugins

A plugin adds operations to the brain itself (SMD-2310). It runs inside the brain's own servers (the REST core and the MCP server), and its operations join the brain's one contract. The REST core serves them under `/v1/plugins/<name>/`, the MCP server lists them as tools named `<name>_<operation>`, and the OpenAPI document describes them. Each one sits behind the same scope gate as a core operation. A plugin has no server or keys of its own, and no database connection but the pool the brain gives it, logged in as a role that holds nothing on the core.

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
  - **GUI pages** (optional), `gui: { pages: [{ path, label }] }`: each a path under the plugin's and the label its nav entry shows. The REST core lists an enabled plugin's pages at `GET /v1/plugins`, the registry the operator GUI's nav reads (SMD-2280 renders the pages).
- `migrations/` (optional): the plugin's tables, as `NNN_name.sql` files. See below.
- `README.md` and `metadata.json` (`"category": "plugins"`), as every contribution has.
- An entry in [registry.ts](registry.ts). The server runs only plugins built into its image; nothing is loaded by a name the environment gives.

## A plugin's tables

A plugin's tables live in a Postgres schema of its own, `plugin_<name>`, owned by a role of its own, `ob1_plugin_<name>` (hyphens read as `_`). Every plugin's SQL runs on a connection logged in as `ob1_plugins`: a login role that is NOINHERIT and no superuser, holding `SET` on each plugin's role and nothing on the core. The operator sets its password, `OB1_PLUGIN_DB_PASSWORD`, in `deploy/.env`.

- **Migrating.** The migrator applies an enabled plugin's `migrations/` after the core's. Each file runs on that login connection, as the plugin's role with its schema first on the path. It records them in their own ledger, `plugin_migrations` ([db/README.md](../db/README.md), "Plugin migrations"). Run it with the same `OB1_PLUGINS` and `OB1_PLUGIN_DB_PASSWORD`; the compose migrator reads both from `deploy/.env`.
- **At runtime.** A handler reaches them through `ctx.db.tx(async (sql) => …)`: one transaction on a pool of the plugin's own, logged in the same way. Tables are named bare, and each `${value}` is a bound parameter. A plugin with no `migrations/` has no role or schema, so its `ctx.db` refuses, naming them.
- **The boundary is Postgres's.** Neither role holds anything on the core's tables, so Postgres refuses a migration or a handler that reaches for one. SQL that undoes the plugin's role (`RESET ROLE`, `END;`) lands on `ob1_plugins`, which is refused the core's tables the same — though from there it could `SET ROLE` to any plugin's role and reach that plugin's tables, which is one more reason check 31 refuses the undoing and review reads every plugin. The brain's thoughts are reached through `ctx.call` alone. What the two roles do hold is PUBLIC's defaults: `USAGE` on the `public` schema (its types and functions; every core function runs as its caller), and `TEMP` on the database, which the plugin's own pool keeps away from every other connection. Advisory locks are not a role's to refuse: a plugin's transaction-level lock (`pg_advisory_xact_lock`) on a key the core uses would hold a core write up for that transaction, so a plugin keeps to keys of its own.
- **No foreign keys into the core.** A row that names a thought holds its id, and the operation checks the thought through the core, as the example's `add_note` does.
- **Turning a plugin off** removes its operations and runs none of its migrations. Its schema, tables and rows are left as they are.

## The rules a plugin is held to

Checked when the server starts, so a malformed manifest stops it:

- No two operations share a tool name, and none takes a core tool's name.
- No two operations of a plugin have routes that one request could match (`/items/{id}` beside `/items/latest`).
- A path field is a string field.
- An output schema does not transform: MCP holds the answer to it a second time.
- A refusal is 400, 403, 404, 409 or 422 with an `UPPER_CASE` code, and is never retryable.

Held by check 31 of `scripts/check-fork-consistency.ts`, on every push. It is an accident guard in front of the database's boundary, not a sandbox: a plugin's TypeScript runs in the server's own process, where it could reach anything the server can, so what holds hostile code is curation. The check makes code that would read like an attempt to leave the boundary fail a push, so review sees it.

- **Its directory** holds TypeScript, `migrations/*.sql`, a `README.md` and a `metadata.json`, nothing else.
- **Imports.** A plugin imports `server-portable/plugin-sdk.ts` and its own directory's `.ts` files (static, re-exported or bare), nothing else; zod comes from the SDK. Code that runs in the server imports no test file.
- **Globals.** It names none that reach past `ctx`, aliased or not: `fetch`, `eval`, `Function`, `Reflect`, `globalThis`, `self`, `Bun`, `process`, `Deno`, `require`, `Worker`, `WebSocket`, `XMLHttpRequest`, `EventSource`, or `import()`. A local of one of those names is renamed.
- **Its SQL** is a migration file or a tagged template literal (`` sql`…` ``); an untagged template is text, not SQL.
  - It names no core table anywhere, and no schema but its own (`public.`, another plugin's, `pg_temp`). This holds even for a plugin's own table: one may not be called `jobs` or `pages`.
  - It spells nothing with `U&` escapes.
  - It sets or resets no role, `session_authorization` or `search_path` (quoted or not), runs no `RESET ALL`, `set_config` or `SET SESSION`, and makes no temp object.
  - It takes no session advisory lock, holds no cursor `WITH HOLD`, and runs no `LISTEN` or `DISCARD`.
  - Outside a plpgsql body, it runs no `BEGIN`, `END`, `ABORT`, `COMMIT`, `ROLLBACK` (`ROLLBACK TO` aside), `START TRANSACTION`, `PREPARE` or `EXECUTE` as a statement. Inside one, it runs no `EXECUTE` (dynamic SQL this check cannot read), `COMMIT` or `ROLLBACK`.
- **The registry and the directories agree.** `plugins/registry.ts` imports and lists exactly the plugin directories, and a manifest's name is its directory's.

Held by the maintainer's review:

- **The brain's thoughts are reached through `ctx.call(name, input)` alone.** That is a core operation called as the caller, behind the caller's own scope: a read operation called with a read key cannot capture or update. A write through it names the caller on its audit row.
- **An output says only what the caller may see.** `ctx.call` hands back the core operation's whole value: for `capture_thought`, more than the REST core tells a key that cannot read (`rest/app.ts`'s `capturedFor`). What reaches the caller is what the output schema declares, so it should not declare more.

Plugins are **curated**: they run in the brain's process with its privileges, so a new one needs maintainer review. That review is the control; the roles and check 31 catch what review misses by accident.
