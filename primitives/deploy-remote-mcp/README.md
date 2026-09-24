# Run a Remote MCP Server

A guide to running any Open Brain extension server — and the recipe and integration servers that share its shape — as a remote MCP server: one process under [Bun](https://bun.sh) against your Postgres, reachable over HTTPS by any AI client. This is the same pattern the core Open Brain server uses ([`SETUP.md`](../../SETUP.md)): the extension servers run beside it, each on its own port, each with its own access keys.

"Remote" is about the client, not the machine. A connector in Claude Desktop, claude.ai or ChatGPT dials your server from the vendor's side, so it needs an HTTPS URL it can reach; a client on the same machine (Claude Code, Cursor) reaches `http://127.0.0.1:<port>` directly. Either way the server is one HTTP process — never a stdio process a client spawns, and never a `claude_desktop_config.json` entry.

## Prerequisites

- A running Open Brain: the compose stack in [`SETUP.md`](../../SETUP.md), or any Postgres with pgvector carrying the schema `db/migrations/` applies
- [Bun](https://bun.sh) 1.4+ on the machine that will run the server
- A checkout of this repository — the servers import the SQL shim and the access-key module by relative path, so they run from the tree, not from a copied file
- The extension's README: its Step 1 applies the extension's own tables

## What You Need From the Extension

Every extension README names the file to run and the environment it reads. The table below is the shape; the values are the extension's:

| Setting | Value |
|---------|-------|
| Server file | `extensions/extension-name/index.ts` |
| Port | `8787` (any free port; `PORT` unset means 8000, which the core server or podman's `gvproxy` may hold) |
| Environment | `SUPABASE_URL` (the Postgres connection string — the shim keeps the variable's name), `MCP_ACCESS_KEYS`, and whatever else the README lists (`DEFAULT_USER_ID`, `OPENROUTER_API_KEY`, …) |

Replace `extension-name` below with the extension's directory name.

---

## Step 1: Apply the Extension's Schema

Run the extension's `schema.sql` against your Open Brain database, as the extension's README Step 1 says — `psql "$DATABASE_URL" -f extensions/extension-name/schema.sql`, with the two `auth.*` stub functions first when the schema's policies call `auth.uid()` (the README says when). The core server's tables are already there from the migrations; this adds the extension's. With the compose stack, run it inside the database's container — `podman compose -f deploy/compose.yaml exec -T postgres psql -U postgres openbrain < extensions/extension-name/schema.sql` — which needs neither a published port nor psql on the host (the `auth.*` stub line a README gives runs the same way, its `CREATE …` after `psql -U postgres openbrain -c` in place of the redirect). The server in Step 4 does need to reach the database from the host, so the stack must have come up with `-f deploy/compose.host-ports.yaml` (`deploy/README.md`, "What is reachable from where"); `SUPABASE_URL` is then `postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/openbrain`.

## Step 2: Install the Pinned Packages

Once per checkout:

```bash
(cd extensions && bun install)
```

`extensions/package.json` pins `hono`, `zod`, `@hono/mcp` and the MCP SDK for every extension server. An integration or recipe server has no `node_modules` of its own and resolves the same install through `NODE_PATH=extensions/node_modules`, as its README's run line shows.

## Step 3: Mint an Access Key

The extensions authenticate the way the core Open Brain server does: a key is **named**, has a **scope** (`read` or `write`; a `capture` key exists for the core server's session hook and is not admitted here), and only its **SHA-256 hash** is stored — the server never holds the key itself, and a key is revoked on its own by removing its line and restarting. A read-scoped key is never given the tools that write, so it does not even see them; that is the key to put in a connector URL.

> **Already have keys from the core server?** An extension server reads its own `MCP_ACCESS_KEYS` from its own environment, so reuse a line or mint a new one per extension — your choice. Nothing is shared unless you pass the same value.

Mint one from the checkout with Bun (it prints the key once, and the line to store):

```bash
bun server-portable/keygen.ts --name laptop --scope write
```

Or by hand — generate a key, then hash it:

🟩 **Mac/Linux:**

```bash
KEY=$(openssl rand -hex 32)
echo "key:  $KEY"
echo "hash: $(printf %s "$KEY" | shasum -a 256 | cut -d' ' -f1)"   # sha256sum on a Linux box without shasum
```

🟦 **Windows (PowerShell):**

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
$hash = ([System.Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') }) -join ''
"key:  $key"; "hash: $hash"
```

Save the **key** somewhere safe — it goes in your Connection URL and is not recoverable from the hash. The **hash** goes in the server's environment as `name:scope:hash`; several keys are separated by commas:

```bash
MCP_ACCESS_KEYS=laptop:write:paste-the-hash-here,phone:read:paste-another-hash-here
```

> The older `MCP_ACCESS_KEY=<raw key>` variable still works — one key for every client, with write scope, compared by digest now. Move to `MCP_ACCESS_KEYS` when you next touch the environment; both may be set at once.

## Step 4: Run the Server

From the checkout, with the environment on the command (or in a file your process manager reads):

```bash
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='laptop:write:paste-the-hash-here' \
PORT=8787 bun extensions/extension-name/index.ts
```

`SUPABASE_URL` carries the Postgres connection string — the SQL shim (`compat/supabase-sql`) keeps supabase-js's variable names so the vendored code does not change — and `SUPABASE_SERVICE_ROLE_KEY` may be left unset. Bun prints its start line, `Started development server: http://localhost:8787` (`Started server:` under `NODE_ENV=production`). Your **MCP Server URL** is `http://your-host:8787/mcp`, and your **MCP Connection URL** adds the key:

```text
http://your-host:8787/mcp?key=your-access-key
```

Each server holds one pool of `OB1_PG_POOL` connections (ten unless set) for its life, shared by every request; five extension servers beside the core server are sixty of Postgres's default hundred before any load, so set it lower where several share one database. `extensions/test-auth.ts` starts every extension server this way in CI, and `extensions/test-tools.ts` drives their tools against a real Postgres there.

## Step 5: Put It Behind HTTPS

A client on this machine is done: give it the `http://127.0.0.1:8787/mcp` URL. A hosted connector — Claude Desktop's custom connector, claude.ai, ChatGPT — connects from the vendor's side and needs an HTTPS URL that reaches your port. The same answers serve the core server ([`SETUP.md`](../../SETUP.md), "Connect a client"):

- **A TLS proxy or tunnel on this host** — caddy, cloudflared, `tailscale funnel` — dials `127.0.0.1:8787` itself; the server keeps listening on the loopback. One proxy fronts every port you run: the core server on 8000, each extension on its own.
- **Any host that runs Bun and reaches Postgres** — a VPS, a container built from a Bun image with this checkout in it — runs the same command; put its TLS terminator in front. `server-portable/Dockerfile` is the core server's image and the shape to copy.

Save the HTTPS form of the Connection URL, then follow the [Remote MCP Connection](../remote-mcp/) guide to connect it to your AI client. Keep the process up the way you keep any service up — a systemd unit, a compose service, a process manager; `bun` restarts in a second and the URL and key stay.

---

## Updating a Running Server

Pull the checkout and restart the process:

```bash
git pull
PORT=8787 … bun extensions/extension-name/index.ts
```

The URL and access key stay the same — no need to reconfigure your AI clients. If the extension's `schema.sql` changed, the README's Step 1 says what to re-run. Most schemas use `IF NOT EXISTS` and re-run cleanly; family-calendar's and meal-planning's do not, and every `CREATE POLICY` refuses a second run — apply the changed statements by hand there.

---

## Troubleshooting

**`EADDRINUSE` on start**
- Something holds the port. `PORT` unset is 8000, the core server's; on macOS podman's `gvproxy` holds 8000 too. Pick another port and give the clients the new URL.

**`Cannot find package 'hono'` (or `zod`, `@hono/mcp`)**
- Step 2 was skipped: `(cd extensions && bun install)`. For an integration or recipe server, add `NODE_PATH=extensions/node_modules` to the command, as its README shows.

**401 on every request**
- The URL or header must carry the **key**, the environment its **hash**. An entry that is not `name:read|write|capture:<64 hex characters>` is ignored, and the vendored servers do not log it: check each entry is three fields, the scope lower-case, the digest 64 hex characters. `bun preflight.ts` in `server-portable/` with the same `MCP_ACCESS_KEYS` in its environment prints the parse problem.
- A `read`-scoped key authenticates but is given no writing tool; a server whose only tools write (`delete-thought-mcp`, `update-thought-mcp`) shows a read key nothing to call.

**`relation "…" does not exist`**
- Step 1 was skipped, or ran against another database than `SUPABASE_URL` names. Re-run the extension's `schema.sql` against that database.

**`function auth.uid() does not exist`**
- The extension's policies call Supabase's `auth.uid()`, which a plain Postgres lacks. The extension's README Step 1 gives the two stub functions to create first.

**The connector in Claude Desktop or ChatGPT cannot reach the server**
- It dials from the vendor's side: the URL must be HTTPS and reachable from the internet (Step 5). A `127.0.0.1` or LAN address works only for a client on this machine or network.
- Read the server's terminal: a refused request logs its cause there.

## Expected Outcome

One `bun` process per extension, each answering on its own port with the extension's tools — the full set for a write key, the reading tools alone for a read key — and, behind a TLS proxy, an HTTPS Connection URL that any MCP client accepts. Stopping the process stops the server; restarting it with the same environment brings it back at the same URL.

## Extensions That Use This

- [Household Knowledge Base](../../extensions/household-knowledge/) (Extension 1)
- [Home Maintenance Tracker](../../extensions/home-maintenance/) (Extension 2)
- [Family Calendar](../../extensions/family-calendar/) (Extension 3)
- [Meal Planning](../../extensions/meal-planning/) (Extension 4) — two servers, the shared one on its own port and keys ([Shared MCP Server](../shared-mcp/))
- [Professional CRM](../../extensions/professional-crm/) (Extension 5)
- [Job Hunt Pipeline](../../extensions/job-hunt/) (Extension 6)

The recipe and integration servers under `recipes/` and `integrations/` run the same way; each README's run line names its file, port and environment.
