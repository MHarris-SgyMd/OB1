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
- **Webhooks** (optional), `hooks: { <name>: { description, handler } }`: a capture source's inbound endpoints. See "A plugin's webhooks" below.
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

## A plugin's webhooks

A capture source (Slack, Telegram, Readwise) needs an endpoint its service can POST to, and that service holds no brain key. A plugin declares each such endpoint as a hook:

- **Where.** The REST core serves it at `/hooks/<plugin>/<name>`, but only for a plugin the operator names in `OB1_HOOKS` (also enabled in `OB1_PLUGINS`). The proxy reaches it only with `deploy/compose.hooks-public.yaml`, so a webhook is off unless the operator turns on both.
- **The handler** is given the request's headers, query, its body as the bytes sent (at most 1 MiB, counted as they arrive; POST alone) and as UTF-8 text, the secret `OB1_HOOK_SECRETS` gives its plugin, and `captureSeconds`, the longest one capture's model calls may run under the brain's settings. It verifies the delivery itself, over the bytes, and refuses replays (below). With no secret set for the plugin, the REST core answers 503 and never calls the handler.
- **Replays.** A signature over the body alone verifies forever. A delivery anyone recorded (a proxy log, a leaked request) could be resent at will, and each resend runs capture's model calls again: no data is changed, but the spend is a stranger's to trigger. So a webhook refuses replays (SMD-2755):
  - **It signs the time.** `verifyTimestamped(request, ctx.secret, scheme)` from the SDK checks the HMAC of `<prefix><timestamp><separator><body>` against a header, in constant time. It refuses a timestamp (Unix seconds) more than `toleranceSeconds` from the server's clock, 300 by default, either way. A verdict that is not `ok` carries `NO_TIMESTAMP`, `BAD_SIGNATURE` or `STALE_DELIVERY`, the handler's 401. The signature is checked first, so only a delivery the secret's holder signed is told it is stale. The scheme is a small options object. Slack's is `{ signatureHeader: "x-slack-signature", signaturePrefix: "v0=", timestampHeader: "x-slack-request-timestamp", prefix: "v0:", separator: ":" }`; the example's is the plain `<timestamp>.<body>`. `hmacSha256Hex` and `safeEqual` remain for a scheme it does not fit.
  - **It remembers ids.** A sender that names each delivery (Slack's `event_id`, Telegram's `update_id`) lets a handler run one once inside the tolerance. The id is read from what the signature covers, never from a header it does not: a replayer would send the same signed bytes under a new id each time. The SDK's `onceById(ctx, id, run, { keepSeconds })` does it (SMD-2768), over a `deliveries` table the plugin's migration makes as the example's `migrations/002_deliveries.sql` does; `isDeliveryId(id, scope?)` says whether it takes an id (a string of 1 to 200 characters from `!` to `~`, less a scope and its space), so a handler answers a bad one first, asking with the scope it passes `onceById`: 400 to a sender that reads it, a 2xx to one that retries anything else (below). A numeric id (Telegram's `update_id`) is passed as `String(id)`. It claims the id before `run` captures, and answers a resend with what the first captured (`{ duplicate }`), or one whose first is still running with `{ inFlight }`, the example's retryable `409`. A `run` that throws, or hands back no thought, gives the claim back, so the sender's retry runs. A claim left unfinished (a server that stopped mid-capture) is taken by a retry past a lease: by default one capture's model calls under the brain's own settings (`OB1_LLM_TIMEOUT`, twice over with `OB1_CHUNK_CONTEXT` on, or the genre tier's 31 s if longer, which `ctx.captureSeconds` reads for the plugin) and a minute, so 180 s as shipped. A lease that outlasts the sender's last retry loses a delivery whose server died mid-capture, every retry answered 409; a plugin whose sender gives up sooner passes a shorter `leaseSeconds`, at the cost of a slow capture run twice. It prunes ids older than `keepSeconds` (an unfinished claim once its lease is out too): twice the tolerance and a minute's margin, the example's eleven minutes, and no shorter than the sender goes on retrying (Slack retries an event nearly at once, after a minute and after five). That bounds a replay of the same bytes, which is stale by then; a retry the sender signs afresh with the same id is told apart only inside the window. The ids are in a table rather than the process's memory, which a restart empties and each replica keeps apart. One table per plugin: a plugin with two hooks that remember ids gives each its own `scope` (its name, say), which onceById keeps the ids under and prunes by, so each hook has its own window and the same id from two senders is two deliveries. The scope is part of the key, so it is chosen before the hook first runs: adding one later forgets the ids kept without it. A plugin with a scope kept for good beside one that prunes adds the index the prune reads (`onceById`'s doc comment has it), or each claim scans every kept row. `002_deliveries.sql`'s columns, check and index are the shape to copy; its comments describe the example's own, unscoped use. The thought a `run` hands back is the core's thought id: anything else is thrown, the claim kept to lapse, since its record would fail unseen. The claim is a transaction of its own, never held across the capture's model calls, which would hold one of the plugin's two connections for as long.
  - **A sender that wants an answer within seconds** (Slack's Events API: three) counts a capture slower than that as a failed attempt, and its retry finds the first still running: `409 IN_FLIGHT`, another failure, and a later retry is answered with the first's thought. That is the answer to keep: a 2xx to an in-flight retry loses the delivery if the first then fails, where a 409 lets a retry past the lease capture it. Slack's slash commands carry no `event_id`, and Slack does not document retrying one: a command's id is its plugin's to choose from the signed body, and a command slower than Slack waits for still captures, but its user is shown a timeout. A hook answers when its handler returns, and the contract has no way to leave work running after it: a promise left behind is not waited for when the server stops, and its rejection stops the REST core (SMD-2767).
  - **A sender that retries any answer but a 2xx** (Slack, Telegram) is answered 2xx for a delivery its plugin will never capture: a check such as Slack's `url_verification`, a bot's message or an edit, a refusal of the core's that is not retryable. The example's 4xx answers are for a sender that reads them; such a sender would resend each one.
  - **A sender that signs no time** has its ids alone: Telegram's secret-token header, and Readwise, which signs nothing and sends its secret in the body. A pruned id is open to replay, so its plugin keeps ids as long as the sender retries (Telegram keeps an update it could not deliver for 24 hours), or as long as they can be resent (a Readwise highlight's, for good: `keepSeconds: Infinity` prunes nothing). A high-water mark where ids only rise (Telegram's `update_id`) holds only while deliveries come one at a time: Telegram keeps up to `max_connections` (40 by default) deliveries open at once, so they can arrive out of order. Such a secret is a bearer secret: whoever saw one delivery can forge others. Its plugin's README should say so.
- **What it may do.** It runs as `hook:<plugin>`, a caller of capture scope alone. Through `ctx.call` it can add a thought, written as the hook on its audit row, but nothing a sender posts can read, change or delete one. It reaches its plugin's own tables through `ctx.db` as an operation does.
- **Its answer** is a status a sender reads (200, 202, 204, 400, 401, 403, 404, 409, 413, 422 or 503) and an optional JSON object body. A handler that throws is answered `FAILED` with nothing of why — the sender is anonymous — and the message goes to the REST core's log.

The example's `capture` hook is the template ([example/README.md](example/README.md)).

## The rules a plugin is held to

Checked when the server starts, so a malformed manifest stops it:

- No two operations share a tool name, and none takes a core tool's name.
- A hook's name is one path segment of lower-case words and hyphens, with a description and a handler.
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
