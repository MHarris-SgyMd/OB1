# Example Plugin

The template a plugin starts from (SMD-2310). It has one read operation, `recent`, which lists the newest thoughts' ids, types and capture times. It reads them through the core's `list_thoughts`, as the caller, which is the only way a plugin reaches the brain's thoughts.

## What it does

| | |
|---|---|
| MCP tool | `example_recent` |
| REST route | `GET /v1/plugins/example/recent?limit=5` (`/api/v1/plugins/example/recent` through the proxy, where `/api` is on) |
| Scope | `read`: a read or a write key |
| Input | `limit`, 1 to 20, default 5 |
| Output | `{ thoughts: [{ id, type, created_at }] }` |

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope: `bun keygen.ts --name me --scope read` in `server-portable/`.

## Turn it on

1. Add the plugin to `deploy/.env`:

   ```
   OB1_PLUGINS=example
   ```

2. Recreate the servers so they read it: `docker compose up -d server api` from `deploy/`.
3. Check it:
   - preflight's `plugins` row says `example — enabled`;
   - `GET /v1/whoami` lists `example_recent` for a read key;
   - an MCP client sees the `example_recent` tool.

Remove the name from `OB1_PLUGINS` and recreate the servers to turn it off. The tool, the route and its OpenAPI entry are gone.

## Start your own plugin

Copy this directory to `plugins/<name>/` and set `name` in `index.ts` to the directory's name. Then import it in `plugins/registry.ts` and add it to `PLUGINS`. See [plugins/README.md](../README.md) for the rules a plugin is held to.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The name is not in `plugins/registry.ts` in the image that is running. Check the spelling, or rebuild the image after adding a plugin.
- **`403 FORBIDDEN` with `needs: "read"`.** The key's scope does not reach the operation: a capture-only key cannot read.
- **`422 CORE_REFUSED`.** The core refused the `list_thoughts` call the operation made; the message names the core's code.
