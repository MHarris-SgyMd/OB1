# Plugins

A plugin adds operations to the brain itself (SMD-2310). It runs inside the REST core's process, and its operations join the brain's one contract. The REST core serves them under `/v1/plugins/<name>/`, the MCP server lists them as tools named `<name>_<operation>`, and the OpenAPI document describes them. Each one sits behind the same scope gate as a core operation. A plugin has no server, keys or database connection of its own.

| Plugin | What it does |
| --- | --- |
| [example](example/) | The template: one read operation over the core |

## Turning plugins on

The operator names the plugins a brain runs in `OB1_PLUGINS` in `deploy/.env`, comma-separated. A plugin that is not named registers nothing. A name that is no plugin stops the server, and preflight says so first. The three-tier stack runs none.

## What a plugin is

A directory, `plugins/<name>/`, with:

- `index.ts`: the manifest, `export default definePlugin({...})` from `server-portable/plugin-sdk.ts`.
  - **The name** is the directory's: lower-case words joined by hyphens.
  - **Each operation** declares a title, a description and the scope a key needs (`read`, `capture` or `write`). It also declares its REST method and path under the plugin's, an input and an output as zod shapes, and a handler.
  - **The handler** returns `ok(value)` or `refuse(status, CODE, facts)`. A value is held to the output schema; one that does not fit is the plugin's fault, answered as `FAILED`.
- `README.md` and `metadata.json` (`"category": "plugins"`), as every contribution has.
- An entry in [registry.ts](registry.ts). The server runs only plugins built into its image; nothing is loaded by a name the environment gives.

## The rules a plugin is held to

- **Imports.** A plugin imports `server-portable/plugin-sdk.ts` and its own files, nothing else. zod comes from the SDK.
- **The brain's thoughts are reached through `ctx.call(name, input)` alone.** That is a core operation called as the caller, behind the caller's own scope: a read operation called with a read key cannot capture or update. The audit row names the caller.
- **Names are checked when the server starts.** No two operations share a tool name, and none takes a core tool's name. A malformed manifest stops the server.

Plugins are **curated**: they run in the brain's process with its privileges, so a new one needs maintainer review.
