# deploy — running Open Brain without Supabase

Phase 4 of the migration: the operational glue. Supabase supplied a database, a
place to run the function, a secret store and a deploy command. Off Supabase each
is an ordinary piece of infrastructure, and this directory is the smallest working
arrangement of them.

`compose.yaml` is the migration plan's Phase 4 exit test made literal — a change
reaches a running system with **no Supabase CLI installed and no supabase.com
account involved**. It is a reference, not a production topology: no TLS, no
backups, no resource limits.

## Prerequisites

- podman or docker, with compose
- An OpenRouter API key

## Steps

### 1. Configure

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → MCP_ACCESS_KEY
```

`deploy/.env` is gitignored. This replaces `supabase secrets set`: the same values,
now ordinary environment variables your platform's secret store supplies.

### 2. Bring it up

```bash
podman compose -f deploy/compose.yaml up --build
```

Three services, in order:

| Service | Replaces |
| --- | --- |
| `postgres` | The Supabase-hosted database (`pgvector/pgvector:0.8.6-pg16`) |
| `migrate` | Pasting SQL into the Supabase dashboard — runs `db/migrate.ts`, then exits |
| `server` | The Edge Function and `supabase functions deploy` |

### 3. Verify

```bash
./deploy/smoke.sh
```

### 4. Connect a client

```
http://127.0.0.1:8000/?key=<MCP_ACCESS_KEY>
```

That URL works from this machine and nowhere else, by default — a client on
this machine, such as Claude Code at user scope
(`claude mcp add --transport http --scope user open-brain http://127.0.0.1:8000/
--header "x-brain-key: <key>"`). A claude.ai or Claude Desktop custom connector
connects from Anthropic's side, not from your machine, so it needs a TLS proxy
or a tunnel in front; one on this host (caddy, cloudflared, `tailscale serve`)
dials `127.0.0.1:8000` itself and the loopback default serves it — `SERVER_BIND`
changes only when the proxy is on another machine, as the next section says.
`127.0.0.1`, not `localhost`: the mapping binds the IPv4 loopback only, and a
client that resolves `localhost` to `::1` first without falling back is refused
(`smoke.sh` dials `127.0.0.1` for the same reason).

## Pinning a release

The stack builds `server` from the checkout and pins `postgres` and `migrate` by
tag; `ollama` still floats on `:latest`. Once the fork cuts releases (SMD-1804 —
`MAJOR.MINOR.PATCH+upstream.<sha>`, see [`FORK.md`](../FORK.md) "Versioning"), a
production deployment pins to one so the server, the migrations and the models it
was verified against move together:

```yaml
# deploy/compose.yaml, per release
services:
  server:
    image: ghcr.io/mharris-sgymd/ob1-server:<tag>   # instead of `build:`
  migrate:
    image: ghcr.io/mharris-sgymd/ob1-migrate:<tag>
  ollama:
    image: ollama/ollama@sha256:<digest>            # a digest, not :latest
```

The published `ob1-server`/`ob1-migrate` images and the per-release ollama digest
are produced by the release job (SMD-1805) and are not built yet; until then the
checkout build is the supported path. `releases.json` at the repo root records
which migration range, server commit and upstream pin each `<tag>` closed, and
`preflight` prints the running brain's `schema_version` so a mismatch between a
pinned server and the brain it opens is caught before traffic.

## What is reachable from where

Compose binds an address-less `"8000:8000"` to `0.0.0.0`, every interface, so the
first stack this fork ran on (podman on macOS) offered the database superuser and
the MCP server to the whole LAN on a password and a key over plain HTTP. Since
SMD-1844 every published port names its address, the default is loopback, and
the database and Ollama are not published at all. `compose …` in this section
stands for `podman compose -f deploy/compose.yaml …` (or `docker compose`) from
the repo root, with whatever `-f` files the stack was started with:

| Service | On the compose network | On the host | From another machine |
| --- | --- | --- | --- |
| `server` | `server:8000` | `127.0.0.1:${SERVER_PORT:-8000}` — the stack's only published port | Through a TLS proxy or tunnel. One on this host dials `127.0.0.1` and needs no knob; only a proxy on another machine needs `SERVER_BIND=0.0.0.0` in `deploy/.env`, and then the key rides every request in clear until the proxy |
| `postgres` | `postgres:5432` — the server and the migrator | Nothing. `compose exec postgres psql -U postgres openbrain` for psql, `compose exec -T postgres pg_dump -U postgres openbrain > dump.sql` for a backup. A tool run from a checkout (`db/reembed.ts`, `db/extract-entities.ts`, `db/consolidate.ts`, the evals) adds `-f deploy/compose.host-ports.yaml`, which publishes it on `127.0.0.1:${POSTGRES_PORT:-5432}` — choose that when the stack comes up: adding or dropping the file later recreates `postgres` and, through `depends_on`, `server` | Never. `POSTGRES_BIND` exists for a firewalled host you have looked at; it is the superuser on the whole brain |
| `ollama` (`--profile local-models`) | `ollama:11434` — the server and `ollama-pull` | Nothing. `compose exec ollama ollama pull <model>`; the host-ports file publishes it on `127.0.0.1:${OLLAMA_PORT:-11434}` for an eval run from a checkout | Not intended; an unauthenticated model API |

`docker compose -f deploy/compose.yaml config` renders each mapping with
`host_ip: 127.0.0.1`, and `scripts/check-fork-consistency.mjs` check 13 parses
every `compose*.yaml` under `deploy/` and refuses a mapping that drops the
address, a service that reaches outside the file (`extends`, `include`) or onto
the host without a port (`network_mode`), and holds an inventory of which
service publishes from which file — the server from `compose.yaml`, the
database and Ollama from the host-ports file — so a new published port is
named there deliberately, with its row in the table above; the "Full stack, no
Supabase" CI job reads the rendered config the same way.

On podman machine and Docker Desktop the listener you can see is the VM's
proxy (`gvproxy`, `vpnkit`), not the container, so the check is on the Mac:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ":(5432|8000|11434) "
```

(with your `SERVER_PORT` from `deploy/.env` in place of 8000 if you set one —
the shell does not read that file; and the trailing space anchors the port,
since without it a Supabase CLI stack on 54321 and 54322 matches `5432` and
reads as the database leaking)

shows `127.0.0.1:<port>` for the server, and for 5432 nothing without the
host-ports file and `127.0.0.1:5432` with it; a line on 11434 is a
host-installed Ollama (SETUP.md's macOS path), not the stack's — `127.0.0.1` is
its own default and enough, since `host.containers.internal` reaches the host's
loopback from the VM (measured); `*:11434` there means someone set
`OLLAMA_HOST=0.0.0.0` and an unauthenticated model API is on the LAN. `ss`
inside the VM does not answer the
question. Measured on podman 5 (libkrun machine, macOS): gvproxy
honours the address — with `SERVER_BIND=0.0.0.0` it listens on `*:8000` and a
connection to the Mac's LAN address succeeds; with the default it listens on
`127.0.0.1:8000` and the same connection gets nothing. "Nothing" is a timeout,
not a refusal, when the macOS application firewall's stealth mode is on (it
drops a probe of a closed port), so read `lsof`, not the error's wording.

## Expected outcome

`migrate` exits 0 having applied every migration under `db/migrations/` (it needs no `bun install` —
`migrate.ts` imports only Bun and `node:` built-ins). `server` logs `preflight OK`
followed by `Started server`. `smoke.sh` ends with `0 failed` and exits 0 (its
checks are the numbered comments in the script; the summary line counts them).

Point an HTTP liveness probe at **`GET <base>/health`** (200, no key) — the URL
you configure outside the proxy is the one to use; the exact match rule is the
`HEALTH_PATH` comment in `server-portable/index.ts` (FORK.md change 75). The MCP
endpoint serves POST only: `GET /` and `HEAD /` answer 405, so a platform-default
probe aimed at `/` marks a healthy server down. The image's own `HEALTHCHECK`
POSTs to the endpoint instead, which also proves the MCP path serves; either is
fine. Opening the connector URL in a browser shows `Method Not Allowed`, which is
expected.

## Why the server runs preflight before serving

The data layer is built lazily on first use. Without a gate, a server with a wrong
`DATABASE_URL` starts cleanly, answers `initialize`, returns every tool from
`tools/list`, and passes any HTTP liveness probe — then fails when a user captures
their first thought, with the real error buried inside a tool response.

On Supabase this mattered less: the platform injected the database credentials, so
they could not be wrong. Off Supabase every one is hand-written.

So the container's entrypoint is `bun preflight.ts && exec bun index.ts`. A
misconfigured deployment crashloops, which is visible, instead of looking healthy,
which is not. `preflight.ts --json` suits a pipeline gate; `--deep` also calls
OpenRouter and checks the embedding width still matches the schema.

One check that matters most on a managed database: `vector extension`. If the
provider installed pgvector into a schema off the connection's `search_path`
(Supabase uses `extensions`), the bare `vector` type does not resolve and every
capture and search would fail with `type "vector" does not exist` on a database
that has pgvector. Preflight fails with the schema it found and the exact
`ALTER ROLE … SET search_path` (or `ALTER DATABASE`) to run — see `FORK.md`
change 43.

## Using smoke.sh against a real deployment

It only needs a URL and a key, so the same check covers every target:

```bash
./deploy/smoke.sh https://ob1.internal.example.com "$MCP_ACCESS_KEY"
```

Read-only — it never captures a thought, so it is safe against production. Exit 0
if the deployment serves correctly, 1 otherwise.

Give it the URL a connector would be given, without its `?key=` — the key is the
second argument, and a query string is refused. Check 2 probes the **origin root**,
which is where claude.ai looks for OAuth discovery before it will open a custom
connector (with the server's path as a suffix, when the URL carries one). A server
behind a path prefix needs its proxy to route `/.well-known/` to it, or to 404 it
there, for that check to pass.

## What this does not cover

- **TLS, backups, resource limits, log shipping.** Reference topology only. One
  limit is set because the stack met it: the postgres service's `shm_size`
  (`POSTGRES_SHM_SIZE`, 1 GB), since a parallel HNSW index build keeps its whole
  graph in `/dev/shm` and a container's default 64 MB fails the rebuild after a
  bulk load of a few hundred thousand rows. Raise it with `maintenance_work_mem`
  before rebuilding a large index, or build with
  `max_parallel_maintenance_workers = 0` (`db/README.md`, "Caveats"). Migration
  039 is such a rebuild on every brain it reaches — both HNSW indexes over
  `embedding::halfvec`, in the migrate service's session, which has the server's
  64 MB unless the role was given more: set `maintenance_work_mem` on the
  migrating role to about 2.5 KB per vector across `thoughts` and
  `thought_chunks` (250 MB per 100,000, 2.5 GB per million) and
  `POSTGRES_SHM_SIZE` at least that, before the stack runs it; the migrator
  prints the vector count and the setting in force just before 039. On a brain
  past a million rows build the two staging indexes `CONCURRENTLY` first, as
  the migration's header says, and let it adopt them.
- **A Supabase Edge Function passing checks 2, 3 and 4.** On Supabase the API gateway
  answers the OAuth discovery path with 401 before the function sees it, so check
  2 fails there — and the failure is real: the claude.ai connector will not open
  against that deployment either (upstream
  [#340](https://github.com/NateBJones-Projects/OB1/issues/340); FORK.md change 42).
  Checks 3 and 4 fail too: upstream's `server/index.ts` has no method guard, so
  a GET answers 200 instead of 405 — with a key it hangs (upstream
  [#424](https://github.com/NateBJones-Projects/OB1/issues/424)) — and it has no
  `/health` route, so that GET gets the same 200 JSON-RPC refusal instead of
  `ok` (FORK.md change 75).
- **Scheduled jobs.** One recipe (`recipes/editorial-policy`) uses `pg_cron` and
  `pg_net` to call an endpoint on a schedule. Off Supabase that becomes an ordinary
  cron job, a Kubernetes CronJob, or a scheduled workflow. Not ported here.
- **Data migration.** `pg_dump --data-only` from the old database, plus a full
  re-embed if the embedding model family changes — `db/reembed.ts`, run from a
  checkout with the provider reachable, not from this stack. A checkout reaches
  this stack's database only with `-f deploy/compose.host-ports.yaml` ("What is
  reachable from where", above); the same goes for the two workers below.
- **Entity extraction.** `db/extract-entities.ts --follow` is a long-running
  worker with a per-thought model cost; it is not a service here. Run it from a
  checkout, with `OB1_WORKER_KEY` set to a key whose hash is in
  `MCP_ACCESS_KEYS`, when you have decided to pay that cost. The same goes for
  `db/consolidate.ts`, the pass that proposes supersessions from the entities
  that worker extracts (a per-pair cost; `db/README.md`), and for reviewing
  what it proposes.
- **Auth.** Still a single shared key, in a header or `?key=`. Moving off Supabase
  does not improve that; see [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).

## Related

- `../db/` — the schema and its migration runner
- `../server-portable/` — the server, and `preflight.ts`
- `../FORK.md` — what this fork changes and why
