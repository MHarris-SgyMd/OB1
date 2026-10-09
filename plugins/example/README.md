# Example Plugin

The template a plugin starts from (SMD-2310). It shows both halves of a plugin:

- **The core, as the caller.** `recent` lists the newest thoughts through the core's `list_thoughts`. `ctx.call` is the only way a plugin reaches the brain's thoughts.
- **A table of its own.** `add_note` and `list_notes` keep notes pinned to thoughts in `plugin_example.notes`, made by `migrations/001_notes.sql`.
- **A webhook.** `capture` takes a signed POST and captures its text as a thought, as a Slack or Telegram plugin's would. It refuses a delivery signed more than five minutes ago, and runs a delivery it has seen once (`plugin_example.deliveries`, made by `migrations/002_deliveries.sql`).

## What it does

| Operation | MCP tool | REST route | Scope | Input | Output |
|---|---|---|---|---|---|
| Recent thought ids | `example_recent` | `GET /v1/plugins/example/recent` | `read` | `limit`, 1 to 20, default 5 | `{ thoughts: [{ id, type, created_at }] }` |
| Pin a note to a thought | `example_add_note` | `POST /v1/plugins/example/notes` | `write` | `thought_id`, `note` (1 to 2000 characters) | `{ note: { id, thought_id, note, written_by, created_at } }` |
| A thought's notes | `example_list_notes` | `GET /v1/plugins/example/notes` | `read` | `thought_id` | `{ notes: [...] }`, oldest first |

**The webhook**, `POST /hooks/example/capture`, takes `{"text": "…"}`, and an `"id"` (1 to 200 characters) if the sender names its deliveries. It is signed over the time and the body. `x-example-timestamp` is the Unix time in seconds, and `x-example-signature` is the hex HMAC-SHA256 of `<timestamp>.<body>` (the raw body) under the secret `OB1_HOOK_SECRETS` gives the example.

- **Signed within five minutes** of the server's clock, it captures the text through the core as `hook:example` (trust `ingested`, source `example-hook`) and answers 202 with the thought's id.
- **Unsigned, mis-signed or with no timestamp**, it answers 401 (`BAD_SIGNATURE`, `NO_TIMESTAMP`). Signed but more than five minutes off, it answers 401 `STALE_DELIVERY`, so a recorded delivery cannot be resent later (SMD-2755).
- **An id it has captured** is answered 200 with that thought's id and `"duplicate": true`, and runs nothing. One whose first delivery is still being captured is answered 409 `IN_FLIGHT`. A capture that fails gives the id back, so the sender's retry runs, and the claim of one that never finished (the server stopped mid-capture) lapses after three minutes for the same reason. Ids are kept eleven minutes, twice the tolerance and a minute. By then a resend of the same bytes is stale, but a retry the sender signs afresh with the same id is captured again.
- **A capture the core refuses** is answered 422 `CORE_REFUSED`, with the core's code as `refused`. It is 503 when the core says the refusal is worth retrying (`retryable: true`), and the id is given back either way.
- **With no secret configured**, it answers 503 `HOOK_NOT_CONFIGURED`.

It is served only while `OB1_HOOKS` names the example, and reachable from outside only with `deploy/compose.hooks-public.yaml`:

```bash
SECRET=<the example's secret in OB1_HOOK_SECRETS>
BODY='{"id":"delivery-1","text":"from a webhook"}'
TS=$(date +%s)
SIG=$(printf %s "$TS.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST -H 'content-type: application/json' -H "x-example-timestamp: $TS" -H "x-example-signature: $SIG" -d "$BODY" http://127.0.0.1:8000/hooks/example/capture
```

It declares one GUI page, **Notes** at `/notes`, which `GET /v1/plugins` lists for the operator GUI's nav while the plugin is on. Through the proxy, where `/api` is on, the routes are under `/api` (`/api/v1/plugins/example/…`). `add_note` looks the thought up through the core as the caller before it writes. A thought the caller cannot read, or one that is not there, is refused with `404 NO_SUCH_THOUGHT`. `written_by` is the name of the key that pinned the note.

## Prerequisites

- A working Open Brain stack (`deploy/compose.yaml`).
- A key with read scope (`bun keygen.ts --name me --scope read` in `server-portable/`), and one with write scope (`--scope write`) to pin notes.

## Turn it on

1. Add the plugin to `deploy/.env`, with a password for `ob1_plugins`, the login role every plugin's SQL runs on (generate one with `openssl rand -hex 32`, and back it up with `POSTGRES_PASSWORD`):

   ```
   OB1_PLUGINS=example
   OB1_PLUGIN_DB_PASSWORD=<the generated password>
   ```

2. Recreate the migrator and the servers so they read it: `docker compose up -d migrate server api` from `deploy/`. The migrator makes `ob1_plugins` (the first time), the plugin's role and schema, and applies `001_notes.sql` and `002_deliveries.sql`. The servers wait for it.
3. Check it:
   - preflight's `plugins` row says `example — enabled`, and its `plugin tables` row says the role, schema and migrations are in place;
   - `GET /v1/whoami` lists `example_recent` and `example_list_notes` for a read key, and `example_add_note` too for a write key;
   - `GET /v1/plugins` lists the plugin and its Notes page;
   - an MCP client sees the same tools.
4. For the webhook, add `OB1_HOOKS=example` and `OB1_HOOK_SECRETS=example=<openssl rand -hex 32>` to `deploy/.env`, recreate the REST core (`docker compose up -d api`), and name the overlay with the stack's other `-f` files: `docker compose -f compose.yaml -f compose.hooks-public.yaml up -d proxy`. The REST core's preflight `plugin webhooks` row then says `example` is served (the MCP server serves no webhook, and is not given the knobs).

Remove the name from `OB1_PLUGINS` and recreate the servers to turn it off. Its tools, routes and OpenAPI entries are gone. Its table and notes stay, and come back when it is turned on again.

## Start your own plugin

Copy this directory to `plugins/<name>/` and set `name` in `index.ts` to the directory's name. Then import it in `plugins/registry.ts` and add it to `PLUGINS`. See [plugins/README.md](../README.md) for the rules a plugin is held to.

## Troubleshooting

- **The server refuses to start: "OB1_PLUGINS names … which is no plugin in this build".** The name is not in `plugins/registry.ts` in the image that is running. Check the spelling, or rebuild the image after adding a plugin.
- **Preflight's `plugin tables` row says the server "cannot log in as ob1_plugins".** `OB1_PLUGIN_DB_PASSWORD` is not the password the role was made with: the migrator never changes an existing role's password. Set the variable back, or change both together (`ALTER ROLE ob1_plugins PASSWORD '…'` as the database owner).
- **Preflight's `plugin tables` row fails with "migration(s) not applied".** The migrator has not run with `OB1_PLUGINS` set. Recreate it as in step 2, or run `OB1_PLUGINS=example OB1_PLUGIN_DB_PASSWORD=… bun migrate.ts --url "$DATABASE_URL"` in `db/`.
- **`403 FORBIDDEN` with `needs: "write"` or `"read"`.** The key's scope does not reach the operation: a read key cannot pin a note, and a capture-only key cannot read.
- **`404 NO_SUCH_THOUGHT`.** The thought is not there, or the key cannot read it.
- **`422 CORE_REFUSED`.** The core refused the `list_thoughts` call `recent` made; the message names the core's code.
- **The webhook answers `401 STALE_DELIVERY`.** The delivery was signed more than five minutes from the server's clock: a resend of an old delivery, or a clock that is off on the sender or the server. A curl run of the recipe above signs the time it runs.
