# Run a Vendored Server

A guide to running a vendored recipe or integration server: one process under [Bun](https://bun.sh) against your brain's Postgres, beside the brain, on its own port and with its own access keys. These are the workers under `recipes/` and `integrations/` that a recipe or integration README tells you to run (the last HTTP APIs and webhook receivers became plugins with SMD-2690). The brain itself is the compose stack in [`SETUP.md`](../../SETUP.md), its one deployment (SMD-2288); this guide does not run it, and new operations on the brain are a plugin ([`plugins/README.md`](../../plugins/README.md)), not a server here.

Each server is one HTTP process reached by URL: never a stdio process a client spawns, and never a `claude_desktop_config.json` entry. None of them speaks MCP. An agent reaches the brain through the brain's own connector ([Remote MCP Connection](../remote-mcp/)); these servers are called by a schedule, by a service's webhook or by another server.

## Prerequisites

- A running Daemonic Brain: the compose stack in [`SETUP.md`](../../SETUP.md), with its database published to this host (Step 1)
- [Bun](https://bun.sh) 1.4+ on the machine that will run the server
- A checkout of this repository: the servers import the SQL shim and the access-key module by relative path, so they run from the tree, not from a copied file
- The server's README, which names its tables, its environment and what calls it

## What You Need From the Server's README

Every vendored server's README names the file to run and the environment it reads. The table below is the shape; the values are the server's:

| Setting | Value |
|---------|-------|
| Server file | `integrations/<name>/index.ts` or `recipes/<name>/<file>.ts` |
| Port | `8787` (any free port; `PORT` unset means 8000, the stack's published port, which podman's `gvproxy` may hold too) |
| Listen address | every address, unset; `OB1_LISTEN_HOST` names one IP address instead (`127.0.0.1` keeps the server to this machine). A value that is not one, or a link-local one, stops the server at start, in words; one this host does not have stops it with Bun's own error, `Is port N in use?` on macOS, EADDRNOTAVAIL on Linux (SMD-3323) |
| Environment | `SUPABASE_URL` (the Postgres connection string: the shim keeps the variable's name), `MCP_ACCESS_KEYS` (the editorial-policy auditor reads `AUDITOR_ACCESS_KEYS`), and whatever else the README lists (`OPENROUTER_API_KEY`, …) |

These servers run this way, and `integrations/test-auth.ts` starts each one so in CI:

| Server | Kind | Called by |
|--------|------|-----------|
| [`integrations/entity-extraction-worker`](../../integrations/entity-extraction-worker/) | worker | a schedule |
| [`integrations/consolidation-workers`](../../integrations/consolidation-workers/) (`bio`, `metadata-norm`) | workers | a schedule |
| [`recipes/editorial-policy`](../../recipes/editorial-policy/) (`auditor/index.ts`) | worker | a weekly schedule |

---

## Step 1: Apply the Server's Tables

Each server's README names the schemas it needs, under its prerequisites or in its first step: `schemas/knowledge-graph` for the extraction and consolidation workers, `schemas/enhanced-thoughts` for most of them, and the auditor its recipe's own `recipes/editorial-policy/schema.sql`. Run each against your brain's database, as the README says: `psql "$DATABASE_URL" -f schemas/<name>/schema.sql`, nothing first (no `auth.*` stub, no Supabase role: SMD-1810). With the compose stack, run it inside the database's container, `podman compose -f deploy/compose.yaml exec -T postgres psql -U postgres openbrain < schemas/<name>/schema.sql`, which needs neither a published port nor psql on the host.

The server in Step 4 does need to reach the database from the host, so the stack must have come up with `-f deploy/compose.host-ports.yaml` (`deploy/README.md`, "What is reachable from where"); `SUPABASE_URL` is then `postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/openbrain`.

## Step 2: Install the Pinned Packages

Once per checkout:

```bash
(cd integrations && bun install)
```

`integrations/package.json` pins `hono` and `zod`, the packages the vendored servers share (SMD-3747). An integration resolves the install from under it, and a recipe through `recipes/node_modules`, a committed link to `../integrations/node_modules`, so its command needs no `NODE_PATH` (SMD-1991). A server that needs another package has a `package.json` of its own, and its README says to install there too. A README's run line that passes `--no-install` makes a skipped install fail the start instead of Bun downloading unpinned packages.

## Step 3: Mint an Access Key

The vendored servers authenticate the way the brain does: a key is **named**, has a **scope** (`read` or `write`; a `capture` or `forward` key is the brain's alone and is not admitted here), and only its **SHA-256 hash** is stored. The server never holds the key itself, and a key is revoked on its own by removing its line and restarting. A read-scoped key is refused, with a 403, by a route that writes, and may only dry-run a worker; that is the key to give anything that only reads.

> **Already have keys from the brain?** A vendored server reads its own `MCP_ACCESS_KEYS` from its own environment, so reuse a line or mint a new one per server: your choice. Nothing is shared unless you pass the same value.

Mint one from the checkout with Bun (it prints the key once, and the line to store):

```bash
bun server-portable/keygen.ts --name cron --scope write
```

Or by hand: generate a key, then hash it.

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

Save the **key** somewhere safe: it goes with each request, and is not recoverable from the hash. The **hash** goes in the server's environment as `name:scope:hash`; several keys are separated by commas:

```bash
MCP_ACCESS_KEYS=cron:write:paste-the-hash-here,dashboard:read:paste-another-hash-here
```

A request carries the key in an `x-brain-key` or `x-access-key` header, as `Authorization: Bearer <key>`, or as `?key=` on the URL. A wrong key in any of them is refused with a 401.

> The older single raw key still works (`MCP_ACCESS_KEY`, the auditor's `AUDITOR_ACCESS_KEY`): one key for every caller, with write scope, compared by digest. Move to `MCP_ACCESS_KEYS` when you next touch the environment; both may be set at once.

## Step 4: Run the Server

From the checkout, with the environment on the command (or in a file your process manager reads):

```bash
SUPABASE_URL='postgres://user:password@host:5432/openbrain' \
MCP_ACCESS_KEYS='cron:write:paste-the-hash-here' \
PORT=8787 bun --no-install integrations/<name>/index.ts
```

`SUPABASE_URL` carries the Postgres connection string (the SQL shim, `compat/supabase-sql`, keeps supabase-js's variable names so the vendored code does not change), and `SUPABASE_SERVICE_ROLE_KEY` may be left unset. Bun prints its start line, `Started development server: http://localhost:8787` (`Started server:` under `NODE_ENV=production`). The server's README names its routes under that root, and what its callers send.

Each server holds one pool of `OB1_PG_POOL` connections (ten unless set) for its life, shared by every request; five such servers beside the brain are sixty of Postgres's default hundred before any load, so set it lower where several share one database.

## Step 5: Put It Behind HTTPS

A caller on this machine, outside a container (a cron job), is done: give it the `http://127.0.0.1:8787` URL. A scheduled workflow in the stack's `orchestration` profile runs in a container, where `127.0.0.1` is the container itself: it reaches a server on the host as `http://host.containers.internal:8787` under podman, or `host.docker.internal` under Docker Desktop, both of which reach the host's loopback (measured on podman 5; on Linux Docker a container reaches the host by its bridge address, so there the server listens on that address, not `127.0.0.1` alone). A caller on another machine, and a service that calls from its own side (Readwise's webhook, a hosted runtime), needs an HTTPS URL that reaches your port. The same answers serve the stack ([`SETUP.md`](../../SETUP.md), "Connect a client"):

- **A TLS proxy or tunnel on this host** (caddy, cloudflared, `tailscale funnel`) dials `127.0.0.1:8787` itself, so start the server with `OB1_LISTEN_HOST=127.0.0.1` and it listens on the loopback alone. One proxy fronts every port you run: the stack's on 8000, each server on its own.
- **Any host that runs Bun and reaches the brain's Postgres** (a VPS, a container built from a Bun image with this checkout in it) runs the same command; put its TLS terminator in front. `server-portable/Dockerfile`, the brain's server image, is the shape to copy.

Keep the process up the way you keep any service up: a systemd unit, a compose service, a process manager. `bun` restarts in a second, and the URL and key stay.

---

## Updating a Running Server

Pull the checkout, install again in case the pins moved, and restart the process:

```bash
git pull
(cd integrations && bun install)
PORT=8787 … bun --no-install integrations/<name>/index.ts
```

The URL and access key stay the same, so its callers need no change. If the server's tables changed, its README says what to re-run.

---

## Troubleshooting

**`EADDRINUSE` on start**
- Something holds the port. `PORT` unset is 8000, the stack's; on macOS podman's `gvproxy` holds 8000 too. Pick another port and give the callers the new URL.

**`Cannot find package 'hono'` (or `zod`)**
- Step 2 was skipped: `(cd integrations && bun install)`. A recipe server needs the same install; it finds it through the `node_modules` link in `recipes/`.

**401 on every request**
- The request must carry the **key**, the environment its **hash**. An entry that is not `name:read|write|capture|forward:<64 hex characters>` is ignored, and the vendored servers do not log it (a `capture` or `forward` key, well formed, is no key to them either: they admit read and write). Check each entry is three fields, the scope lower-case, the digest 64 hex characters. `bun preflight.ts` in `server-portable/` with the same `MCP_ACCESS_KEYS` in its environment prints the parse problem.

**403 on a write, or a worker's real run**
- The key is read-scoped. A read key may call the routes that read and dry-run a worker; give a caller that writes a `write` key.

**`relation "…" does not exist`**
- Step 1 was skipped, or ran against another database than `SUPABASE_URL` names. Re-run the server's schema against that database.

**`permission denied for table …`**
- The server's role is not the tables' owner and was not granted them. Apply the schema as the role the server connects with, or grant that role with `bun db/migrate.ts --grant <role>`: the **community** group for the tables under `schemas/`, the **recipes** group for a recipe's own SQL (`db/README.md`, "Grants for a capturing role").

**A caller on another machine cannot reach the server**
- It needs the HTTPS URL (Step 5). A `127.0.0.1` or LAN address works only from this machine or network.
- Read the server's terminal: a refused request logs its cause there.

## Expected Outcome

One `bun` process per server, each answering on its own port: every route for a write key, the reading routes and a worker's dry run for a read key, a 401 for anything else. Behind a TLS proxy, an HTTPS URL its callers reach. Stopping the process stops the server; restarting it with the same environment brings it back at the same URL.

## Extensions That Use This

None: the six extensions are plugins since SMD-2311, served by the brain itself with no server of their own. The vendored recipe and integration servers in the table above run this way.
