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

- podman or docker, with Docker Compose v2.23.1 or later (`docker compose`, or
  what `podman compose` runs when it is installed): the proxy's route table is
  an inline `configs:` entry, which older compose does not read, and the Python
  podman-compose refuses the file (1.6.0: `missing networks: default`)
- A model provider: the stack's own Ollama (`--profile local-models`, one line to
  set: `OB1_LLM_LOCAL=1`), an Ollama on the host, or an OpenRouter key — the shipped defaults are
  local; `deploy/.env.example`, "Model provider", is the one line to choose

## Steps

### 1. Configure

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24                                    # → POSTGRES_PASSWORD
bun server-portable/keygen.ts --name laptop --scope write   # → a line for MCP_ACCESS_KEYS; keep the key
```

`deploy/.env` is gitignored. This replaces `supabase secrets set`: the same values,
now ordinary environment variables your platform's secret store supplies.

### 2. Bring it up

```bash
podman compose -f deploy/compose.yaml --profile local-models up --build
```

The profile is the stack's own Ollama, where the server's model endpoint
defaults; drop it when `deploy/.env` names another provider (an Ollama on the
host, OpenRouter — `.env.example`, "Model provider"). Without either, the server
container refuses to start: preflight dials an endpoint whose name is local once
(`GET /models`, 2.5 s) and its `provider endpoint` row fails on the `ollama` name with nothing
behind it, naming the profile, the two host aliases and a hosted provider as the
ways out (SMD-1875). Before that row the name counted as local and was not
dialled, so the stack came up `preflight OK` and the first capture failed on it
(`getaddrinfo ENOTFOUND ollama`) with the server log ending at `Started server`.

The services, in order, the last two with the profile:

| Service | Replaces |
| --- | --- |
| `postgres` | The Supabase-hosted database (`pgvector/pgvector:0.8.6-pg16`) |
| `migrate` | Pasting SQL into the Supabase dashboard — the `ob1-migrate` image (`db/Dockerfile`) runs `db/migrate.ts`, then exits |
| `server` | Upstream's Edge Function and its deploy command |
| `proxy` | Supabase's gateway in front of the function — the stack's one origin, with the server at `/mcp` on it ("One origin" below) |
| `forwarder` | — the stack's one published port, in front of the proxy, which is on internal networks alone (SMD-2583) |
| `ollama` (profile) | OpenRouter — the model endpoint the server defaults to |
| `ollama-pull` (profile) | Pulling both models by hand; runs once, then exits |

### 3. Verify

```bash
OB1_SMOKE_KEY=<your key> ./deploy/smoke.sh
```

### 4. Connect a client

```
http://127.0.0.1:8000/mcp?key=<your key>
```

8000 is `SERVER_PORT`, set in `deploy/.env` when something on the host already
publishes it (a devcontainer publishing 8000 on the podman VM was the case met);
the URL, `smoke.sh` and the `lsof` line below follow it. It is the port in front
of the proxy (the forwarder's, SMD-2583), and `/mcp` the server's path on it. A client configured before SMD-1846 at the
root (`http://127.0.0.1:8000/?key=…`) still works, through the proxy's legacy
route ("One origin" below), until v2.0.0; give new clients `/mcp`, and move
the old ones ("Moving a client to /mcp").

That URL works from this machine and nowhere else, by default — a client on
this machine, such as Claude Code at user scope
(`claude mcp add --transport http --scope user open-brain http://127.0.0.1:8000/mcp
--header "x-brain-key: <key>"`). A claude.ai or Claude Desktop custom connector
connects from Anthropic's side, not from your machine, so it needs a TLS proxy
or a tunnel in front; one on this host (caddy, cloudflared, `tailscale funnel`)
dials `127.0.0.1:8000` itself and the loopback default serves it — `SERVER_BIND`
changes only when the proxy is on another machine, as the next section says.
`127.0.0.1`, not `localhost`: the mapping binds the IPv4 loopback only, and a
client that resolves `localhost` to `::1` first without falling back is refused
(`smoke.sh` dials `127.0.0.1` for the same reason).

## Pinning a release

The stack above builds `server` and `migrate` from the checkout, pins
`postgres` and `ollama` by tag (`ollama`'s is the one `x-ollama-image` anchor in
`compose.yaml`, shared by `ollama-pull`), and `proxy`, `forwarder` and `n8n` by digest in
`compose.yaml` itself, which the overlay leaves as they are. A release pins everything: the job
`.github/workflows/release.yml` (SMD-1860) runs on the tag a cut is named by —
`v<X.Y.Z>`; [`FORK.md`](../FORK.md) "Versioning" has the scheme and the cut —
publishes the two images to GHCR, `ghcr.io/mharris-sgymd/ob1-server:<X.Y.Z>` and
`ghcr.io/mharris-sgymd/ob1-migrate:<X.Y.Z>` for linux/amd64 and linux/arm64, and
creates the GitHub release with a compose overlay that names the two by tag and
digest and `ollama` by the digest its tag resolved to when the job ran, beside
`compose.yaml`, `.env.example`, `compose.api-public.yaml` and `compose.hooks-public.yaml` from the same tag, the change files the release
numbered and `scripts/mechanism-yield.ts`'s table. Before the release existed, the
job brought a stack up from the *pulled* images and held it to this file's checks
(the `Full stack, no Supabase` lines, `smoke.sh`, no Supabase binary) and to
preflight's schema-version row for the version the release's migrator wrote.

On a machine with Docker (or Podman) and no checkout:

```bash
mkdir ob1 && cd ob1
curl -fsSLO https://github.com/MHarris-SgyMd/OB1/releases/download/v<X.Y.Z>/compose.yaml
curl -fsSLO https://github.com/MHarris-SgyMd/OB1/releases/download/v<X.Y.Z>/compose.release.yaml
curl -fsSL -o .env https://github.com/MHarris-SgyMd/OB1/releases/download/v<X.Y.Z>/env.example
curl -fsSLO https://github.com/MHarris-SgyMd/OB1/releases/download/v<X.Y.Z>/compose.api-public.yaml   # optional: /api on the proxy, a third -f ("The REST core" below)
curl -fsSLO https://github.com/MHarris-SgyMd/OB1/releases/download/v<X.Y.Z>/compose.hooks-public.yaml   # optional: plugins' webhooks at /hooks, another -f ("Plugins' webhooks" below)
# fill in .env as step 1 says, then:
docker compose -f compose.yaml -f compose.release.yaml pull
docker compose -f compose.yaml -f compose.release.yaml up -d --wait   # --profile local-models on both for the stack's own Ollama
```

`up` without `--build`: `compose.yaml`'s `build:` stays under the overlay and is
used only when asked, so a pinned stack never rebuilds behind the overlay's back.
The server's log carries preflight's row for the brain the release's migrator
wrote — `schema version   <X.Y.Z>+upstream.<sha> · highest migration NNN` — and
warns, by name, when a brain is at another release than its server: a server
older than its brain, or a brain migrated past the range its version names (both
images carry `releases.json` as of the tag, so the second reads the release's
range). `releases.json` at the repo root records which migration range, server
commit, upstream pin and change files each tag closed. `smoke.sh` against a pinned
stack takes the URL and the key as arguments ("Using smoke.sh against a real
deployment" below).

One thing to check after the first tag: the two GHCR packages' visibility. A
package a workflow first publishes may be created **private** whatever the
repository's visibility is, and `pull` on a clean machine then wants a login —
make `ob1-server` and `ob1-migrate` public in the package settings if they are
not.

## What is reachable from where

Compose binds an address-less `"8000:8000"` to `0.0.0.0`, every interface, so the
first stack this fork ran on (podman on macOS) offered the database superuser and
the MCP server to the whole LAN on a password and a key over plain HTTP. Since
SMD-1844 every published port names its address, the default is loopback, and
the database and Ollama are not published at all. `compose …` in this section
stands for `podman compose -f deploy/compose.yaml …` (or `docker compose`) from
the repo root, with whatever `-f` files the stack was started with.

Inside the stack, each service is on the networks it needs and no other
(SMD-2583; the ADR's "Two networks", `docs/operator-surface-tiers.md`), and
nothing is on compose's default network:
- `mesh`, internal: the proxy, the MCP server, the REST core and the
  authorization server, each called by its `*.ob1.internal` name; a tier of
  another project joins it under its own (`compose.canary.yaml`).
- `data`, internal: Postgres, and only what connects to it — the migrator,
  the two servers, board-sync, the workers, the import runner and its role's
  one-shot. No other project joins it.
- `egress`, outward: whatever calls a model provider or a vendor (the two
  servers, board-sync, the workers, the import runner, n8n), and the stack's
  own Ollama and Jev, which fetch their weights there and are called there by
  name.
- `auth-egress`, outward: the authorization server's alone.
- `front`, internal: the forwarder and the proxy alone, where the forwarder
  reaches the proxy as `proxy.ob1.internal`.
- `edge`, outward: the forwarder's alone, where the stack's port is
  published. The proxy is on internal networks alone (`front` and `mesh`),
  so a name it looks up that nothing holds is never asked of the host's
  resolvers.

An internal network has no route out, and a container on internal networks
alone publishes no port, so `compose.host-ports.yaml` gives Postgres one more
network of its own, `postgres-port`, for its loopback port.

| Service | On the stack's networks | On the host | From another machine |
| --- | --- | --- | --- |
| `forwarder` | Listens on 8000, on `edge`, and dials the proxy alone, as `proxy.ob1.internal` on `front`, at an address on `front` and no other; it opens each connection with the PROXY protocol's line naming the client (SMD-2583) | `127.0.0.1:${SERVER_PORT:-8000}` — the stack's only published port without `--profile orchestration`; the server is `/mcp` on it ("One origin" below) | Through a TLS proxy or tunnel. One on this host dials `127.0.0.1` and needs no knob; only a proxy on another machine needs `SERVER_BIND=0.0.0.0` in `deploy/.env`, and then the key rides every request in clear until the proxy |
| `proxy` | `proxy.ob1.internal:8000` on `front`, which the forwarder dials, and `proxy:8000` on `mesh`; it dials every backend on the `mesh` network, by a name resolved with no search domains: the server as `mcp.ob1.internal:8000`, `auth.ob1.internal:3000`, a canary or working tier's server as `mcp.canary.ob1.internal:8000` or `mcp.working.ob1.internal:8000` while one has joined the mesh (SMD-2294), and — with `compose.api-public.yaml` named — `api.ob1.internal:8000` | Nothing of its own: the forwarder's port | Through the forwarder |
| `server` | `server:8000` on `egress` — n8n; `mcp.ob1.internal` on `mesh` — the proxy, and from where it probes the authorization server's `/healthz` (SMD-2382). It dials `postgres:5432` on `data` and the model provider on `egress`: the ADR has it on the mesh alone, which waits on its calls going through the REST core (SMD-2287) | Nothing of its own: the proxy's port, at `/mcp` (SMD-1846) | Through the proxy |
| `api` | `api.ob1.internal:8000` on the `mesh` network, and `api:8000` on `data` and `egress`, which every container there can reach — a key is still required for anything but `/health` and `/openapi.json`. It dials `postgres:5432` and the model provider as the server does | Nothing of its own: `/api` on the proxy's port, only with `compose.api-public.yaml` named ("The REST core" below) | Through the proxy, as the server, when `/api` is on |
| `postgres` | `postgres:5432` on `data` alone — the migrator, the two servers, board-sync, the workers and the import runner; from `egress` the name does not resolve and its address does not answer (CI's "Postgres answers on the data network alone") | Nothing. `compose exec postgres psql -U postgres openbrain` for psql, `compose exec -T postgres pg_dump -U postgres openbrain > dump.sql` for a backup. A tool run from a checkout (`db/reembed.ts`, `db/extract-entities.ts`, `db/consolidate.ts`, the evals) adds `-f deploy/compose.host-ports.yaml`, which publishes it on `127.0.0.1:${POSTGRES_PORT:-5432}` — choose that when the stack comes up: adding or dropping the file later recreates `postgres` and, through `depends_on`, `server` and `api` | Never. `POSTGRES_BIND` exists for a firewalled host you have looked at; it is the superuser on the whole brain |
| `ollama` (`--profile local-models`) | `ollama:11434` on `egress` — the server and `ollama-pull` | Nothing. `compose exec ollama ollama pull <model>`; the host-ports file publishes it on `127.0.0.1:${OLLAMA_PORT:-11434}` for an eval run from a checkout | Not intended; an unauthenticated model API |
| `jev` (`--profile jev`) | `jev:8020` on `egress` — the server's preflight, and a spike run in a container | Nothing. The host-ports file publishes it on `127.0.0.1:${JEV_PORT:-8020}` for a spike run from a checkout (`OB1_JEV_BASE_URL=http://127.0.0.1:8020`) | Not intended; an unauthenticated model API, as Ollama's is |
| `board-sync` (`--profile board-sync`) | Listens on nothing; dials `postgres:5432` on `data`, and the model provider and Linear's API on `egress` | Nothing | Nothing |
| `extract`, `consolidate` (`--profile workers`) | Listen on nothing; dial `postgres:5432` on `data` and the model provider on `egress` | Nothing | Nothing |
| `n8n` (`--profile orchestration`) | `n8n:5678` on `egress`, which nothing in the stack dials; n8n dials `server:8000`, `orchestration-runner:8090` and the vendors its workflows name, all on `egress`. Not the mesh, where a tier of another project's server is `server` too | `127.0.0.1:${N8N_PORT:-5678}`: the editor, the public API (`/api/v1`), webhooks (`/webhook/…`) and MCP endpoints (`/mcp/…`), behind the owner's password and the keys provisioning stores | Through a TLS proxy, as the server. `N8N_BIND=0.0.0.0` only for a proxy on another machine, and then its keys ride every request in clear until the proxy |
| `orchestration-runner` (`--profile orchestration`) | `orchestration-runner:8090` on `egress`, which n8n's import templates dial with `OB1_RUNNER_KEY`; it dials `postgres:5432` on `data` as its own role, `ob1_orchestration_runner`, and the model provider, and for a live-API emitter the hosts its pipeline names. Its emitters dial nothing (SMD-2289) | Nothing | Nothing |
| `auth` (`--profile auth`) | `auth.ob1.internal:3000` on the `mesh` network, which the proxy dials for `/auth` and the discovery paths ("One origin" below), and the MCP server for its `/healthz` probe (SMD-2382); it dials client metadata documents outward on `auth-egress`, its own, through its fetch guard. It shares no network with Postgres, Ollama, Jev, n8n or the workers, and holds no Postgres credential | Nothing of its own: `/auth` and the discovery paths on the proxy's port. `compose exec auth …` for the backup below | Through the proxy, as the server |

The three-brain pipeline (`-f deploy/compose.tiers.yaml`, SMD-1806) publishes its
forwarder alone, in front of its proxy (SMD-2583), on this file's `SERVER_BIND` and `SERVER_PORT`, with each tier a path
on it (SMD-2294): `/mcp` the stable tier's server, `/canary/mcp` and
`/working/mcp` the others' (a bodiless 404 while that tier is stopped; stable's
`/mcp` answers 502 then, as compose.yaml's does). Its
servers, REST cores, three Postgres services and shared Ollama publish nothing,
and it has compose.yaml's networks, less the authorization server's.
Nothing public routes to a REST core, and the root, `/.well-known` and `/api`
are the proxy's 404: that stack has no legacy window, no authorization server
and no `/api`. It reads `SERVER_PORT` as this file does, so to run the two side
by side set `SERVER_PORT` in the shell for one of them, which wins over
`deploy/.env`. Its proxy waits on no tier and starts in compose's first wave,
so a canary or working tier whose migration fails is a 404 at its path while
stable and the origin serve; `up` still exits 1 and names the failed migrator.
`up proxy` alone therefore brings no tier: name the services, or none.
Its project is `open-brain-tiers`, the file's `name:`. Leave `COMPOSE_PROJECT_NAME`
and `-p` alone for it: either one overrides that name, and as `open-brain` the tiers
would join this stack's project, its `proxy` and its `mesh`, where two servers
answer as `mcp.ob1.internal`.
A canary stood beside this
stack (`deploy/canary.sh`, "A canary beside the stack" below) is this file
again under the project `open-brain-canary`: the same rows on its own networks,
less the proxy, its server and REST core also on this stack's `mesh` as
`mcp.canary.ob1.internal` and `api.canary.ob1.internal`, and reached at
`/canary/mcp` on this stack's port (SMD-2294). Beside a stable from before
that, `--port` gives it its own proxy on loopback, as before.

| Service | On the stack's networks | On the host | From another machine |
| --- | --- | --- | --- |
| `proxy` | dials each tier's server on `mesh`: `mcp.ob1.internal:8000` (stable), `mcp.canary.ob1.internal:8000`, `mcp.working.ob1.internal:8000`; `proxy.ob1.internal` on `front` | Nothing of its own: `/mcp`, `/canary/mcp`, `/working/mcp` on the forwarder's port | Through the forwarder |
| `forwarder` | on `edge`, and dials the proxy alone on `front`, as compose.yaml's (SMD-2583) | `127.0.0.1:${SERVER_PORT:-8000}` | Through a TLS proxy or tunnel, as compose.yaml's; `SERVER_BIND=0.0.0.0` only for a proxy on another machine |
| `<tier>-server` | `<tier>-server:8000` on `data` and `egress`; `mcp.<tier>.ob1.internal` (stable: `mcp.ob1.internal`) on `mesh` | Nothing of its own: its path on the proxy's port | Through the proxy |
| `<tier>-api` | `api.<tier>.ob1.internal:8000` (stable: `api.ob1.internal`) on `mesh`, and `<tier>-api:8000` on `data` and `egress` — a key is still required for anything but `/health` and `/openapi.json` | Nothing | Nothing |

`docker compose -f deploy/compose.yaml config` renders each mapping with
`host_ip: 127.0.0.1`, and `scripts/check-fork-consistency.ts` check 13 parses
every `compose*.yaml` under `deploy/` and refuses a mapping that drops the
address, a service that reaches outside the file (`extends`, `include`) or onto
the host without a port (`network_mode`), and holds an inventory of which
service publishes from which file — the forwarder and the profile's n8n from
`compose.yaml`, the database and Ollama from the host-ports file — so a new published port is
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

shows `127.0.0.1:<port>` for the forwarder, and for 5432 nothing without the
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

## One origin: the proxy and its paths

The stack's one origin is the `proxy` service (Traefik, pinned by digest), behind
the one port the stack publishes (the forwarder's, below), and each service is a
path on it rather than a port of its own (SMD-1846). The
paths today:

| Path | Answered by |
| --- | --- |
| `/auth` and everything under it, `/.well-known/oauth-authorization-server/auth`, `/.well-known/openid-configuration/auth`, the bare `/.well-known/oauth-authorization-server` | `auth` (`--profile auth`), as `auth.ob1.internal` on the `mesh` network — the issuer, sign-in, registration and the three discovery documents outside the issuer's path (the bare one is the only one Claude Code reads). Only while it answers: with the profile off, the server stopped or still starting, the proxy's own bodiless 404, so an origin without it says "no OAuth here" as before. Its own answers pass through untouched, the registration cap's 503 and `Retry-After` included |
| `/api` and everything under it | the proxy's bodiless 404 by default. With `compose.api-public.yaml` named (below), `api` — the REST core, as `api.ob1.internal` on the `mesh` network — with `/api` stripped: `/api/v1/stats` reaches it as `/v1/stats`, and the links it answers carry `/api` back |
| `/hooks` and everything under it | the proxy's bodiless 404 by default. With `compose.hooks-public.yaml` named ("Plugins' webhooks" below), `api` — the REST core — path kept: `/hooks/<plugin>/<name>` is a plugin's inbound webhook, served only for a plugin `OB1_HOOKS` names (SMD-2310) |
| `/mcp` and everything under it | `server` — the MCP endpoint (POST), `GET /mcp/health`, `/mcp/worker-status`, `/mcp/jobs/<id>`; `GET /mcp` is the server's 405 |
| `/canary/mcp`, `/working/mcp` and everything under each | that tier's MCP server, as `mcp.canary.ob1.internal` or `mcp.working.ob1.internal` on the `mesh` network: a tier run as a compose project of its own joins this stack's mesh under that name and none of this stack's (`deploy/canary.sh` does, SMD-2294). One that brought this stack's own names along (`mcp.ob1.internal`, `api.ob1.internal` and, with `--profile auth`, `auth.ob1.internal`, which `compose.yaml` gives its services on the `mesh` key) would share this stack's traffic with it, sign-ins included. `GET /canary/mcp/health` is its liveness and, with a read key, its record. With no such tier, or one stopped or still starting, the proxy's bodiless 404. A tier's protected-resource path is not routed, so a tier is reached with keys |
| any other path starting with `/canary` or `/working`, in any letter case | the proxy's bodiless 404, so a client given a tier's URL with anything changed after the prefix (`/canary`, `/CANARY/mcp`, `/canary%2Fmcp`, an invisible space pasted after `canary`) never reaches this stack's server by the legacy route, where the same key would write to this brain. A typo of the prefix itself (`/canry/mcp`) still does, until SMD-2532 closes the legacy route |
| `GET`/`HEAD`/`OPTIONS /health` | `server` — liveness for a GET-only probe at the origin root: `ok`, or the brain's record with a read key; OPTIONS for a browser's CORS preflight |
| `/.well-known/oauth-protected-resource/mcp` | `server` — the MCP server's protected-resource document while it advertises OAuth: the `auth` profile on, the request at the origin's `Host`, and the authorization server answering the server's probe on the mesh. Otherwise the server's 404, and a server that is down is the proxy's 404, never a 502 (SMD-2382). A claude.ai connector at `https://host/mcp` asks this at the origin root before it uses its key, and proceeds on the key only on a 404 (SMD-1246) |
| `/register`, `/authorize`, `/token` | the proxy's bodiless 404: where an MCP client that found the document but no authorization-server metadata would register and sign in, at the issuer's root. Kept off the legacy route, which would hand the POST to the MCP server (SMD-2382). The authorization server's own are under `/auth` |
| `/.well-known` and everything else under it | the proxy: a 404. It carries none of the server's CORS headers; the MCP SDK's discovery reads a CORS failure as a 404 and goes on |
| anything else | `server`, through the **legacy** route: what clients reach at the root today — `POST /?key=…`, `GET /` (the server's 405, which an MCP SDK client takes as "no stream here"; a 404 there made v1 and v2 clients report an error on every connect, measured), `/worker-status`, `/jobs/<id>`. It keeps every client configured before SMD-1846 working until v2.0.0, and every answer says so: a `Deprecation` header and a `Link` to "Moving a client to /mcp" below, where the server's line naming each key still on it is too (SMD-2306). SMD-2532 removes it, and `/` becomes the proxy's 404 |

Every backend is dialled by its name on the `mesh` network — the server as
`mcp.ob1.internal`, never `server`, because compose gives every container its
service name on each network it joins, and a tier's container on this mesh is
a `server` too (SMD-2294). A name nothing on the networks holds — a tier that
is not up, the authorization server with its profile off, this stack's own
server while it is stopped or recreated — stays in the stack: the proxy is
on internal networks alone, `front` and `mesh`, and an internal network
forwards no name it does not hold to the host's resolvers (measured on podman
6; CI's "The proxy asks nothing outside the stack…" holds it on Docker). So a
resolver that answers `*.ob1.internal` itself (a split-horizon DNS serving
`.internal`, a hostile network's) is never asked (SMD-2583).

A container on internal networks alone publishes no port, so the port is the
**forwarder**'s: a small TCP forwarder on `edge` and `front`, its script
inline in `compose.yaml` (`x-forwarder`, which `deploy/forwarder.ts` holds and
check 28 holds the two equal). It terminates nothing and reads nothing:
per connection it looks the proxy up as `proxy.ob1.internal.` and dials it
only at an address on `front` — the interface no default route leaves by —
since its own lookup reaches the host's resolvers while the proxy is down: a
resolver answering that name gets nothing, and the forwarder logs that it
refused. It opens each connection with the PROXY protocol's line naming the
client, which the proxy trusts from the private ranges, so the access log and
`X-Forwarded-For` name each client rather than the forwarder (and what may write
that line other than the forwarder is under "Abuse limits" below).

The path reaches the server as it came, prefix and all: the server answers POST
at every path and `/health` under any prefix, so `/mcp` needs no setting there.
The routes are `x-proxy-routes` at the top of `compose.yaml`, which compose
hands the proxy as an inline config (`routes.yaml` in the directory Traefik's
file provider reads), so a release's `compose.yaml` carries them and there is no
second file to fetch; an overlay may add a file beside it, as
`compose.api-public.yaml` does. Such a file is a `ROUTE_FILES` entry with its
table built in `scripts/check-fork-consistency.ts` (check 28); no compose
file defines a config that is not a route table (SMD-2658). Every overlay is
an `OVERLAYS` entry there, naming the keys it sets on each service, and a
combination in CI's "The proxy loads only the held route tables", whose
`declared()` names the paths it may change in a render: that step holds each
combination equal to `compose.yaml` alone but for those paths, the proxy and
the configs, so an overlay cannot add an alias, a service or a namespace beside
what it says it does (SMD-2685). The same text is a label on the proxy, so
an `up` after a route changed recreates it: compose does not recreate a
container for a changed inline config alone (docker/compose#11900, measured on
5.5).

**Upgrading a stack from before SMD-2583's forwarder** is one plain `compose
up -d` (with its `-f` files and profiles): compose recreates the proxy without
its port, then creates the forwarder, which waits for it, on the port. On
that first `up`, name the forwarder wherever you name the proxy (`up -d
--build server proxy forwarder`): `up proxy` alone frees the port and never
creates the forwarder. **Rolling back** to a `compose.yaml` from before it
needs `up -d --remove-orphans`, or the forwarder, an orphan, keeps the port.

**Upgrading a stack from before SMD-1846** is one plain `compose up -d --build`
(with the `-f` files and profiles it runs with): compose recreates the server
without its port, then starts the proxy on it — about 1.5 s with no answer on
the port, measured on podman — and every client URL keeps working. The last
30–100 ms of it is the proxy's own 404, between its start and its routes
loading; an SDK client connected across it saw one 404 and went on (measured).
On that first `up` name the proxy and the forwarder wherever you name the server
(`up -d --build server proxy forwarder`): `up server` alone recreates the server
without its port and never creates either. Once they run, recreating the server
alone is fine — the forwarder keeps the port and the proxy finds the new
container by name —
but a rebuild names the REST core too, or the proxy, which depends on it ("The
REST core", below): `api` runs the server's image, and a container keeps the
image it started on. **Rolling back** to
a `compose.yaml` from before it needs `up -d --remove-orphans`: without it the
proxy, now an orphan, keeps the port and the old server cannot bind it
(measured: "address already in use", the stack down).

**Adding a service** is two edits in `compose.yaml`: the service, with no
`ports:`, and a router for its path in `x-proxy-routes`, at a priority above
`legacy` (1). The same router, and its backend under `services:`, go in
`PROXY_ROUTE_TABLE` in `scripts/check-fork-consistency.ts`, whose check 28
holds the table byte for byte. A note on a route goes in the YAML comments
above the block, never in it: Traefik renders a route file as a Go template
before it reads the YAML, so a comment line in the table is not inert
(SMD-2658). The service's networks — the mesh, and the one name it answers to
there; `data` only if it connects to Postgres; `egress` if it calls out — go
in its `networks:` and in the same check's `SERVICE_NETWORKS`, since a service
that names none lands on compose's default network, which nothing else joins
(SMD-2583): only a backend answers to its
own mesh name, since two containers under one alias leave the proxy sending
every request to whichever registered first (SMD-2685, measured). Its keys are
`SERVICE_KEYS`, which act inside its own container; a capability is a
`CONFINEMENT` entry, its mounts and build are `SERVICE_MOUNTS` and
`SERVICE_BUILDS` entries, a named volume it adds is in `COMPOSE_VOLUMES`, and
nothing joins another service's namespaces. Not container labels: Traefik's
label-driven registry reads them
through the container engine's socket, which is root on the host, and the
proxy is the one process a client on the network reaches —
`docs/orchestration-tool.md` declined the same socket for n8n. The
authorization server came this way (the `auth` router) and the REST core's
`api-off`; the dashboard arrives the same way with its own ticket
(`docs/operator-surface-tiers.md`). A service under a profile gets the `auth`
router's shape: an `errors` middleware that turns Traefik's 502 for a name
that does not resolve into a 404, so its paths answer only while it runs, and
the service's own 5xx pass through. The service also joins a network the
proxy is on (`mesh`, for the authorization server).

**What the proxy does not do.** No authentication: the key travels to the
server untouched, as `x-brain-key` or `?key=`, and the server checks it. No TLS:
a remote client still comes through a tunnel or a TLS proxy on the host, which
dials `127.0.0.1:${SERVER_PORT}` (step 4); TLS at this proxy, once the stack has
a public origin, is SMD-2382's. It keeps `Host` as the client sent it — the one `Host` the MCP server advertises OAuth at is the public origin's (SMD-2382) — deletes a
header spelled with `_` or `.` that aliases another (`X_Brain_Key`), and passes
an SSE stream through as it is written — the server's keepalive frame (every
5 s on a long tool call, SMD-1864) reaches the client when it is sent.

**No rate limits on `/mcp`, by design (SMD-2309).** A wrong key costs the
server a SHA-256 or two per key form presented, no query, and a read of at
most 64 KiB of the body for the refusal's JSON-RPC id. What a limit could
hold off is guessing, and a key `keygen.ts` mints is 32 random bytes: out of
reach at any rate. A limit cannot slow guessing without refusing before the key is
checked, which refuses the right key from the same place too; delaying only
wrong answers does not help, since a guesser opens connections in parallel.
Per address that is a lockout anyone can set off from a platform's shared
egress (a claude.ai or ChatGPT connector reaches `/mcp` from the platform's
addresses, every user's alike); across addresses, from anywhere. So the key
is the defence: mint it with `keygen.ts`, and never hash a chosen word into
`MCP_ACCESS_KEYS`, since the server holds only the digest and cannot tell how
strong the key was. A raw `MCP_ACCESS_KEY`, the one key it sees in plain, is
refused under 32 characters by preflight, the image's entrypoint. Compose
passes the server no raw key, so this is for the image run on its own
(`docker run`, Kubernetes); a Workers deployment and the vendored servers run
no preflight, so give them a 32-byte key yourself. The REST core
(`server-portable/rest/`, SMD-2284) checks the same keys, from headers alone,
and refuses a wrong one before reading the body; it takes the same position,
and the proxy does not route `/api` yet. The proxy
sets none either: an MCP client keeps its connection through a JSON-RPC
refusal, and Traefik's limit answers a plain-text 429 instead; by default it
also keys every client behind a tunnel to one address. The authorization
server's sign-in is a password, not a key, and limits itself ("Authorization
server", "Abuse limits").

**Its access log never holds a query string.** A connector carries its key in
`?key=`, and an OAuth redirect will carry its code and state there; a log line
with the query would put on disk the key `keygen.ts` shows once. Traefik logs
one JSON line per request with the query parameters, every header and the
userinfo of an absolute-form target (`ClientUsername`) dropped: `compose logs
proxy` shows the method, the path, the status and the timings. CI's "Full
stack, no Supabase" job greps that log for the smoke key after calls carrying
it in a query string and as userinfo. The log is bounded as every service's
is ("What the servers log", below).

**Podman.** Nothing here needs the engine's socket, so there is no socket path
to find and no SELinux label to relax. On podman machine (macOS), while
SMD-1846 was built, the stack's published port was met unforwarded on the Mac
while the proxy answered inside the VM (`podman machine ssh -- curl
http://127.0.0.1:<port>/health` answered, the Mac's `curl` got nothing), and so
was any container's port on that compose network; recreating the network
(`compose down` then `up`) restored it where restarting or recreating the proxy
did not. The eval kit's auth stack meets a similar race (`evals/eval-auth.ts`).

## The REST core and its opt-in `/api`

The `api` service is the REST core (SMD-2284): every operation the MCP tools
expose, as JSON, over the same core — the server's image run as `bun api.ts`,
with the server's environment and its preflight
(`server-portable/README.md`, "The REST core"). It publishes no port. On the
`mesh` network it is `api.ob1.internal:8000`, for a client on the mesh (the
operator GUI, when it comes; nothing dials it there today); it is on `data`
and `egress` too, where Postgres and
the model providers are (SMD-2583), and every container on those reaches it
as `api:8000`, with a key.
It has no build of its own: an `up` that names it without `server` on a stack
that never built the server's image stops at "no such image" — name `server`
too, or build it first.

```bash
# from a container on the mesh — the proxy is one:
docker compose -f compose.yaml exec proxy wget -qO- --header "x-brain-key: $KEY" http://api.ob1.internal.:8000/v1/whoami
```

**Public only where you turn it on.** Without the overlay the proxy answers
`/api` with its bodiless 404. Naming it routes `/api` to the REST core:

```bash
docker compose -f compose.yaml -f compose.api-public.yaml up -d
curl -H "x-brain-key: $KEY" http://127.0.0.1:${SERVER_PORT:-8000}/api/v1/whoami
curl http://127.0.0.1:${SERVER_PORT:-8000}/api/openapi.json        # the contract, no key
```

Keep naming the file on every later `up` that names the proxy, or names no
service (with the other `-f` files and profiles), the rebuild below included:
such an `up` without it recreates the proxy without the route, and `/api` is the
404 again — which is also how to turn it off; an `up` of other services alone
leaves the proxy, and `/api`, as they were. With the file named and the REST
core down or starting, `/api` answers the proxy's 502. The REST core takes its key
from a header (`x-brain-key`, `x-access-key` or `Authorization: Bearer`), never
from `?key=`, so a client of `/api` needs a header; a URL-only connector stays
on `/mcp`. The proxy deletes `x-brain-forwarder` on the way in: a request's
carrier (SMD-2284) is named only from inside the stack, where the MCP server
will name itself once it forwards (SMD-2286). Its writes record their door as
`open-brain-api`
(`thought_audit.origin`) beside the MCP server's `open-brain`, and the jobs it
starts are its own (migration 078): either server's start marks only its own
unfinished jobs lost. A job is read by the key that started it through either
server; its stream, from the server that did not run it, is the job's state
as recorded, then ends.

Measured on this stack (CI's "Full stack, no Supabase" job holds each): off,
`/api` is a 404 and a POST there never reaches the MCP server; on the mesh
`api.ob1.internal` answers; on, `/api/v1/whoami` answers, a key in `?key=` alone
is a 401, a scan's poll link reads `/api/v1/jobs/…`; dropped again, a 404. The
REST core's log is one JSON line per request — method, route template, operation,
key name, status, an error's code, time ("What the servers log", below) — and
neither its log nor the proxy's holds a key.

## Plugins' webhooks at `/hooks`

A plugin can declare inbound webhooks: a capture source's endpoint, which a
service such as Slack, Telegram or Readwise POSTs to (SMD-2310,
`plugins/README.md`). The REST core serves one at `/hooks/<plugin>/<name>` only
for a plugin named in `OB1_HOOKS`, which must also be enabled in
`OB1_PLUGINS`; any other path under `/hooks` is its 404. The proxy answers
`/hooks` with its bodiless 404 until you name the overlay:

```bash
# deploy/.env: OB1_PLUGINS=example, OB1_PLUGIN_DB_PASSWORD=…, OB1_HOOKS=example,
#              OB1_HOOK_SECRETS=example=<openssl rand -hex 32>
docker compose -f compose.yaml -f compose.hooks-public.yaml up -d
```

Keep every other `-f` the stack already runs with on the same command —
`compose.release.yaml`, `compose.api-public.yaml` — or the proxy is recreated
without them, and `/api` turns off. `/api` does not open `/hooks`: a delivery
sent to `/api/hooks/…` is the REST core's 404.

- **Keys and secrets.** A webhook takes no brain key, because its sender holds
  none. Each handler verifies a delivery against the secret `OB1_HOOK_SECRETS`
  gives its plugin, and refuses one it cannot verify, or one signed more than
  its tolerance ago (five minutes by default), so a recorded delivery cannot
  be resent later (`plugins/README.md`, "Replays", SMD-2755). Preflight's
  `plugin webhooks` row says which plugins are served and warns of one with no
  secret.
- **What a hook may do.** It runs as `hook:<plugin>`, a caller of capture
  scope alone: it may add a thought, and the audit row names it as the writer,
  but nothing it is sent can read, change or delete one.
- **The request.** Its body is counted as it arrives and cut at 1 MiB (413),
  chunked or not, and handed to the handler as the bytes sent, since a
  signature is over the bytes. It takes POST alone. A plugin with no secret
  set is answered 503 before its handler runs, and a handler's fault is
  `FAILED` to the sender, its message in the REST core's log alone.
- **The proxy.** It deletes `x-brain-forwarder` on the way in, as `/api`'s
  route does.
- **No rate limit.** Nothing limits the rate of deliveries: a sender that
  floods a webhook is the plugin's to refuse.
- **Turning it off.** Keep naming the file on every `up` that names the proxy,
  as with `/api`; dropping it recreates the proxy without the route.

Measured on this stack (CI's "Full stack, no Supabase" job holds each, with the
example plugin turned on for the step alone):
- off, `/hooks` is a 404;
- on, a delivery signed with another secret is the plugin's 401, and a signed
  one captures a thought the REST core reads back on the mesh;
- a plugin it does not serve is a 404, and a GET is a 405;
- dropped again, a 404.

## Moving a client to /mcp

Before SMD-1846 the server answered at the origin root, so every client was
given the root: `http://127.0.0.1:8000/?key=…`, or `https://host/?key=…`
through a tunnel. The proxy's legacy route still answers there, for a window
that closes with **v2.0.0**, and no sooner than two weeks after the first
release carrying this section (SMD-2306). After the window the root is the
proxy's 404, and a client still on it stops working (SMD-2532). The port does
not change: the forwarder publishes the same `SERVER_PORT` the proxy did. Only the path
changes: add `/mcp`.

**During the window.** Every answer through the legacy route carries two
headers:

```
Deprecation: @1790899200
Link: <https://github.com/MHarris-SgyMd/OB1/blob/main/deploy/README.md#moving-a-client-to-mcp>; rel="deprecation"; type="text/html"
```

The server also logs a line the first time each key name reaches it there,
from an MCP client or a keyed REST call (`/worker-status`, the worker actions,
`/jobs/<id>`) alike:

```
key "session-hook" reached the brain at the old root URL (POST "/") through the proxy's legacy route — move its client to /mcp; …
```

**Finding the clients still on the root.** Run
`compose logs -t server | grep 'old root URL'` (with the `-f` files the stack
runs with). Each line names a key from `MCP_ACCESS_KEYS`, which is where a key
per client pays off: the single-key form, `MCP_ACCESS_KEY`, is named
`MCP_ACCESS_KEY` for every client, so its line says only that some client is
on the root. A name is logged the first time it is seen in a server
process, so a line says the client was on the root at that time, not that it
still is. Restart the server after moving clients, and a name that comes back
is still on the root. The proxy's access log has a line for every such
request, with `"RouterName":"legacy@file"`, the path, and the client's address
but no key; a keyless request is only there. On podman for macOS that address
is the VM's gateway, not the client. `smoke.sh` run with no URL probes the root
without a key, so it adds no name, and expects both headers (check 11).

| Client | Before | After |
| --- | --- | --- |
| Claude Code (`claude mcp add`) | `http://127.0.0.1:<SERVER_PORT>/` | `claude mcp get open-brain` names the scope (and prints the key); then `claude mcp remove open-brain -s <scope>` and `claude mcp add --transport http --scope <scope> open-brain http://127.0.0.1:<SERVER_PORT>/mcp --header "x-brain-key: <key>"`. Without `--transport http` the add makes a stdio entry. A project-scope entry is the `url` in `.mcp.json`: edit it there |
| Claude Desktop or claude.ai custom connector | `https://host/?key=…` | `https://host/mcp?key=…`: remove the connector and add it with the new URL |
| The session-capture hook | `"url": "http://127.0.0.1:<port>/"` in `~/.config/open-brain/session-capture.json` (or the file `OB1_SESSION_CAPTURE_CONFIG` names) | `"url": "http://127.0.0.1:<port>/mcp"`, then `bun recipes/session-capture-hook/session-capture.mjs --check`, which warns while the url still answers through the legacy route. `OB1_BRAIN_URL` in the hook's environment overrides the file: move it too |
| `db/tier.ts --compare` (`db/brain-compare.ts`) | `http://127.0.0.1:<port>/`, or a connector name it reads with `claude mcp get` | `http://127.0.0.1:<port>/mcp`; a connector name follows the Claude Code row |
| curl, a script, a monitor | `/worker-status`, `/jobs/<id>`, `POST /worker-retry-failed`, `/worker-release-leases`, `/worker-run`, `/health` at the root | the same under `/mcp` (`/mcp/worker-status`, …). `GET /health` at the root stays: it is the health route, not the legacy one. A `scan_thoughts` handle's links are now under the endpoint the call came to |
| n8n | `http://server:8000/` in a workflow node you built | no change needed: n8n reaches the server on the `egress` network, not through the proxy |
| any other client: Codex or Cursor, an `mcp-remote` or `supergateway` bridge, a dashboard's `MCP_URL` | the root, with or without `?key=` | put `/mcp` before `?key=` (`https://host/mcp?key=…`), or at the end of a URL without one |

A stack run with `compose.tiers.yaml` has no legacy window: since SMD-2294 its
proxy answers the root with a 404, and each tier is `/mcp`, `/canary/mcp` or
`/working/mcp` on the proxy's port. A client of that stack moves from the
tier's old host port to its path.

Two more things belong here, though neither applies until the stack has a
public origin and the `auth` profile on (SMD-2382):

- **A configured stack asks a claude.ai connector to sign in, key or no
  key.** claude.ai asks for the protected-resource document before it uses a
  connector's key, and the MCP server serves it at the public origin while
  the authorization server answers. So a `?key=` connector at `/mcp` opens an
  OAuth sign-in first — the operator's, at `/auth`. Once through, its key
  still rides the URL and authenticates before the token, so it is served as
  before. A connector with no key cannot get past the sign-in until SMD-2286
  accepts the token. The server itself never sends a key client to sign in: a
  bad key, in any form, still gets the 200 carrying a JSON-RPC refusal.
- **Changing the public origin later costs a re-enrolment.** Every passkey has
  to be enrolled again and every connector registered again.

The compose side of the upgrade is in "Upgrading a stack from before
SMD-1846" above: name `proxy` beside `server` on the first `up`, and roll back
with `--remove-orphans`.

## Expected outcome

`migrate` exits 0 having applied every migration under `db/migrations/` (its image,
`db/Dockerfile`, carries the runner and the migrations and installs nothing —
`migrate.ts` imports only Bun and `node:` built-ins). `server` logs `preflight OK`
followed by `Started server`, and `proxy` turns healthy. `smoke.sh` ends with
`0 failed` and exits 0 (its checks are the numbered comments in the script; the
summary line counts them).

Point an HTTP liveness probe at **`GET <base>/health`** (200, no key) —
`http://127.0.0.1:8000/health` at the origin root or `…/mcp/health` under the
endpoint, or whatever URL you configure outside the proxy; the exact match rule
is the `HEALTH_PATH` comment in `server-portable/index.ts` (FORK.md change 75).
The MCP endpoint serves POST only: `GET /mcp` answers 405 (and `GET /` too,
through the legacy route; the proxy's 404 once SMD-2532 removes it), so a
platform-default probe aimed at `/` marks a healthy server down. The image's own `HEALTHCHECK` is that keyless `GET /health` too —
not a POST to the endpoint, which the request log would write as a refusal every
30 s (SMD-1849). Opening the connector URL in a browser shows `Method Not Allowed`,
which is expected.

With a read or write key, the same `GET <base>/health` answers what the brain is,
as JSON — version, commit, store, tier, the Postgres and pgvector versions, the
ledger's highest migration against the server's own, counts, size and HNSW
parameters (the `brain_info` tool's record; `server-portable/README.md` has the
fields). A probe with no key still gets `ok`. `smoke.sh` prints the version, the
commit and the highest migration from it, and asserts the version is the
checkout's:

```bash
curl -s -H "x-brain-key: $KEY" "http://127.0.0.1:${SERVER_PORT:-8000}/health" | jq '{version, commit, ledgerStatus, highest: .database.highestMigration}'
```

**The commit is a build argument.** `server-portable/Dockerfile` bakes
`OB1_GIT_SHA` into the image, and compose passes the variable of the same name to
every server build (the three tier servers too). Set it from the shell, on the
command that builds — not in `deploy/.env`, where a value written once is baked
into every later build — with `--dirty`, so an image built from uncommitted
changes says so. Compose never forwards it at runtime; a runtime variable of that
name set some other way (`docker run -e`, a Kubernetes `env:` entry) overrides the
baked one, so set none. Unset at build, the image reports `unknown`; a Worker
always does (wrangler has no build arg). Rebuild with it:

```bash
OB1_GIT_SHA=$(git describe --always --dirty --abbrev=8) docker compose up -d --build server proxy forwarder
```

The REST core runs the server's image by name, and the proxy depends on it,
so this rebuilds and recreates it too; add `-f compose.api-public.yaml` where
`/api` is on.

`proxy` and `forwarder` named beside `server`: the proxy waits on the server
and the forwarder on the proxy, nothing waits on the forwarder, so `up server`
alone on a stack from before SMD-1846 recreates the server without its port and
never creates the forwarder that takes it over (SMD-2583).

The release images carry the tagged commit — the cut's merge commit, in full
(`.github/workflows/release.yml`) — which is not `releases.json`'s `server` field
(the cut's first commit; the server tree is the same).

## Why the server runs preflight before serving

The data layer is built lazily on first use. Without a gate, a server with a wrong
`DATABASE_URL` starts cleanly, answers `initialize`, returns every tool from
`tools/list`, and passes any HTTP liveness probe — then fails when a user captures
their first thought, with the real error buried inside a tool response.

On Supabase this mattered less: the platform injected the database credentials, so
they could not be wrong. Off Supabase every one is hand-written.

So the container's entrypoint runs `bun preflight.ts` and, only if it passes, `exec bun index.ts` (the REST core's service runs `api.ts` instead). A
misconfigured deployment crashloops, which is visible, instead of looking healthy,
which is not. `preflight.ts --json` suits a pipeline gate; `--deep` also calls
OpenRouter and checks the embedding width still matches the schema.

One check that matters most on a managed database: `vector extension`. If the
provider installed pgvector into a schema off the connection's `search_path`
(Supabase uses `extensions`), the bare `vector` type does not resolve and every
capture and search would fail with `type "vector" does not exist` on a database
that has pgvector. Preflight fails with the schema it found and the exact
statement to run: the login role's `ALTER ROLE … IN DATABASE … SET search_path`,
its own path kept and the schema added — or, where the connection string sets
the path, the `options=` value to put there instead — see `FORK.md` change 43
and SMD-2238.

## Using smoke.sh against a real deployment

It only needs a URL and a key, so the same check covers every target:

```bash
./deploy/smoke.sh https://ob1.internal.example.com/mcp "$MCP_ACCESS_KEY"
```

Read-only — it never captures a thought, so it is safe against production. Exit 0
if the deployment serves correctly, 1 otherwise.

Give it the URL a connector would be given, without its `?key=` — the key is the
second argument, and a query string is refused. Check 2 probes the **origin root**,
which is where claude.ai looks for OAuth discovery before it will open a custom
connector (with the server's path as a suffix, when the URL carries one). A server
behind a path prefix needs its proxy to route `/.well-known/` to it, or to 404 it
there, for that check to pass — this stack's proxy routes the authorization
server's three discovery documents to it and the protected-resource document to
the server, whose 404 it is unless OAuth is advertised, and 404s the rest of
`/.well-known/` ("One origin" above).
Where OAuth is advertised at the URL's origin, the document decides (SMD-2382):
for a URL at `<origin>/mcp` or the origin root, a document naming exactly
`<origin>/mcp` must come with the challenge on a keyless request there, a 404
at the root form, and the authorization server's metadata at
`<origin>/.well-known/oauth-authorization-server/auth` naming the issuer
`<origin>/auth` — a front that routes `/mcp` but not `/auth` fails here. The
server's keyed `/health` is read for one verdict: when it says it advertises at
exactly this origin and the document reached smoke as a 404, the tunnel or proxy
in front does not keep the origin's `Host`, or does not route the document;
with a key it does not show that record to, the pass line says this could not
be judged. A URL spelled otherwise than the server's origin (`:443`, upper
case), or a document naming another origin (`http` in front of an `https`
tunnel), fails with the URL to use instead. A URL under another
path (a tier at `/canary/mcp`, reached with keys until SMD-2286 gives tiers
OAuth) is asked at its own path form and
the root form only. A server whose authorization server flips between up and
down inside one run (its probe's 30 s) can fail it once; run it again.

## What the servers log

Two servers write one JSON line to stdout per request (SMD-1849,
`server-portable/telemetry.ts`): the MCP server for each request to its MCP
endpoint, when the request ends, and the REST core for every request it
answers. The MCP server's other routes — its keyed `/health`, the worker
mirrors, `/jobs/`, its 405s, CORS preflights and `/.well-known/` — write none
yet, and a REST request the stop cuts off writes none (the process exits
before its answer); SMD-1849's second PR gives every route of both servers a
line from one per-request record.

```
{"ts":"2026-10-08T16:36:17.603Z","door":"mcp","method":"POST","rpc":"tools/call","tool":"capture_thought","agent":"laptop","status":200,"outcome":"ok","ms":7480,"bytes":612}
```

These keys, and no other, each held to its rule as the line is written — a
value that fails its rule is `?`, and a key with nothing to say is left out:

| Key | What it holds |
| -- | -- |
| `ts` | when the line was written, UTC |
| `door` | `mcp` (the MCP server) or `api` (the REST core) |
| `method` | the HTTP method |
| `route` | the REST core's route template (`/v1/thoughts/:id`), never the path it was given |
| `rpc` | the MCP JSON-RPC method (`tools/call`), or `batch` for a body of several messages; one outside the 2025-06-18 schema's client methods is `other` — so a newer client's (2025-11-25's `tasks/*`) is too |
| `tool` | the tool an MCP tool call names or a REST route runs, from the manifest (`tools.ts`); a batch names none |
| `agent` | the configured name of the key that authenticated — never the key; the single legacy `MCP_ACCESS_KEY` is named `MCP_ACCESS_KEY` |
| `status` | the HTTP status (an MCP tool call is a 200 whatever the tool said; 0 when the client left before there was an answer — during the key check, the registry's answer, the body read or the transport's parse — 408 when it was gone before the route ran) |
| `outcome` | on every line. A request the MCP server refuses at its key is `refused`, whatever its method and status. An MCP tool call says the tool's: `ok`; `refused` (a refusal as a value); `error` (the tool threw, or the route did — a 500); `unrun` (a call that never ran to an end — the transport refused the request, the SDK its input, the key's scope does not hold the tool, or it was sent as a notification, with no `id`); a batch its worst call's (error, refused, unrun, ok). Any other request, and every REST request, says its answer's: `error` for a fault (a 5xx `FAILED` or `STORE_UNAVAILABLE`, or one with no code), `refused` for any other 4xx or 5xx (a 503 `BUSY` is a refusal for now, on both doors), else `ok` — so a JSON-RPC error inside a 200, an unknown method, is `ok`, and a capture saved without its vector is `refused` with `EMBEDDING_NOT_ATTACHED` on the MCP server and `ok` (a 201 whose body says so, which the line does not) on the REST core. A key whose scope lacks the tool, or an input the schema refuses, is `unrun` with no code on the MCP server, where the tool is not registered or the SDK refuses it, and `refused` with `FORBIDDEN` or `REFUSED_INPUT` on the REST core. `abandoned` is a client gone before the MCP server's answer was complete, or before the REST core handed its answer over (one that leaves after keeps that answer's outcome); the MCP server adds `cut` (the stop) and `stalled` (still running at the keepalive's ten minutes — written then, and the call's own end writes no second line). An abandoned or stalled call runs on to its end; whether a capture landed is `thought_audit`'s to say |
| `code` | a refusal's or a fault's code (`NOT_FOUND`, `FAILED`) — the MCP server's from the tool's reply or, at the key, `UNAUTHORIZED`, `REVOKED`, `BUSY` or `AUTH_UNREACHABLE`; the REST core's from its 4xx or 5xx answer |
| `ms` | milliseconds from arrival to the line: an MCP answer's stream to its end, including the time a slow reader takes to drain it; a REST answer to its handing over, before its body is sent, so a job stream (`/v1/jobs/:job_id/stream`) is timed to its opening |
| `bytes` | the bytes of an MCP answer's stream, the server's own keepalive frames apart (the SDK transport's, every 15 s of a long call, are in the stream it writes, and counted) |

A line never holds the URL, its query string, a header, a key, a body, a
tool's arguments or a thought's or a search's text. Search text has its own
home, the query log (migration 034), behind its own switch and retention; this
is not a second copy. `test-server.ts` [21] sends a key in `?key=`, planted
search text and a tool name carrying a line break and planted text through the
server and looks for each, and holds a key's name with a line break and JSON in
it to printable ASCII in a unit check (`JSON.stringify` escapes a line break
anyway, so no line is forged either way); `test-rest.ts` [8] does the same with
a key, an id and query text. The liveness checks are not logged: the image's `HEALTHCHECK` is a
keyless `GET /health`, which the MCP server writes no line for and the REST
core only when it is not a 200. The lines in words beside them — a client that
left, a stop that cut a call, a stalled stream, a key on the old root URL — go
to stderr, as before; their method and tool are the caller's strings, cut to
64 printable characters. Stdout carries lines that are not JSON as well —
preflight's report at every start (each check, then `preflight OK`), Bun's
`Started server: …`, and a stop's two or three `SIGTERM: …` lines — so select
the JSON lines before handing them to `jq`.

The `agent` is a key's name as the operator wrote it in `MCP_ACCESS_KEYS`: name
keys after the client or device they are for (`laptop`, `claude-desktop`), not
after a person, so the log stays free of names and addresses.

```bash
# every request that did not end `ok`, on either server
docker logs open-brain-server-1 2>/dev/null | grep '^{"ts"' | jq -c 'select(.outcome != "ok")'
docker logs open-brain-api-1 2>/dev/null | grep '^{"ts"' | jq -c 'select(.outcome != "ok")'
```

**Every service in `deploy/`'s stacks has a bounded log**: the json-file driver,
rotated at 10 MB with three files kept (`x-logging` in `compose.yaml`; check 29
of `scripts/check-fork-consistency.ts` refuses a service there without it, and
check 27 holds `compose.tiers.yaml` to the same). Podman takes the same keys
and keeps one file, truncated at the bound rather than rotated: every line
goes at once, so it holds anywhere from nothing to 10 MB (measured on podman
6.0.2). The driver is named per service, so it
replaces an engine-wide default an operator has set (journald, a log shipper's
driver); to keep one, set each service's `logging:` in a second `-f` file
(an anchor is read within its own file, so an `x-logging` there changes
nothing here).

## Keeping the board in the brain

The fork's own brain holds its Linear board — every issue in the Open Brain
initiative's projects as one thought, in the shape the hand captures used. Until
SMD-1954 that was a paste per ticket, and a ticket that moved to Done kept
reading Backlog until someone pasted it again, which made a second row. The
`board-sync` profile is that sweep as a service:

```bash
# deploy/.env: LINEAR_API_KEY=lin_api_…  (and OB1_LINEAR_INITIATIVE when the
# initiative is not "Open Brain")
podman compose -f deploy/compose.yaml --profile board-sync up -d
podman compose -f deploy/compose.yaml --profile board-sync logs -f board-sync
```

Each pass stamps a heartbeat, `heartbeat:board-sync` in `ob1_config`
(SMD-2261). Preflight's `workers` row, the keyed `/health` body and `brain_info`
read it. The row warns at once when the loop says it stopped (`compose stop`),
and once the heartbeat is older than three intervals — its restarts used up,
or its container removed. It names `up -d --no-deps board-sync`, with the
`-f` files and `-p` the stack was started with. Just after `up`, the server's
preflight can read the row a `down` left before board-sync's first pass stamps
it; such a warning in the start-up log clears on the next `bun preflight.ts`.
`db/README.md`, "Long-running workers report their liveness", has the row's
shape.

Every `OB1_BOARD_SYNC_INTERVAL` seconds (300) it runs `bun db/sync-linear.ts`
once: a few requests list every issue's identifier, last-updated time and names
(a hundred a page), one query reads the brain's ticket rows, and the difference
is the work — a new
issue is captured (vector, tags, and the facets Linear knows: project, status,
priority, labels, parent), a moved or edited one is updated in place with a
fresh vector, an unchanged one costs nothing. There is no state file: the brain
is the state, so a pass that dies is finished by the next one. The same command
runs from a checkout against any brain (`bun db/sync-linear.ts --url … --audit`
is the lockstep census alone; `db/README.md`, "The board in the brain"). The
scheduled form is the one built here; a Linear webhook is exact and immediate
but needs an inbound route — a router on the proxy (SMD-1846) and a public
origin a vendor can reach (SMD-2382) — and the handler's shape (signature, replay window, loop guard) is SMD-1862's.

## Extraction and consolidation as services

Once extraction has run on a brain, each capture is queued for it as it
lands, and an extracted thought joins consolidation's pool, but nothing does
the work until a worker runs. The `workers` profile runs both workers as
services: `db/extract-entities.ts --follow` as `extract` and
`db/consolidate.ts --follow` as `consolidate`. Each drains its pool, then
polls for new work.

**The cost comes first.** Extraction makes a model call per thought (per
window of a long one), and consolidation up to three, one per judged pair. On
a local model that is GPU time: the dogfood brain takes 50 to 90 thoughts a
day, and on `qwen2.5:7b` a thought's extraction took 37 s at the median (two
workers), so a follower is idle most of the day. On a hosted provider it is
money per call, and each thought's text goes to the provider under the egress
policy. Decide before you enable it.

The first start drains a backlog — every thought already in the brain — so
it runs `extract` alone, and adds `consolidate` once the backlog is done
("Start `extract` alone on a backlog", below). Mint the worker key, append
the line keygen prints to `MCP_ACCESS_KEYS` (comma-separated), set the raw key
as `OB1_WORKER_KEY` in `deploy/.env`, and start extraction:

```bash
(cd server-portable && bun keygen.ts --name workers --scope capture)
podman compose -f deploy/compose.yaml --profile workers up -d extract
```

Then read where it stands, as often as you like:

```bash
podman compose -f deploy/compose.yaml --profile workers run --rm --no-deps extract bun db/extract-entities.ts --status
```

Its `status:` line counts the pool. The backlog is done when it reads `0 in
flight, 0 pending, 0 not yet in the pool`. "0 pending" alone is not enough:
the last thought may still be in flight, and until the follower's first pass
the backlog is "not yet in the pool". If it also reads `N failed`, retry
those now, while no newer thought has been judged without them, and wait for
the line again:

```bash
podman compose -f deploy/compose.yaml --profile workers run --rm --no-deps extract bun db/extract-entities.ts --retry-failed --workers 1
```

Then add consolidation:

```bash
podman compose -f deploy/compose.yaml --profile workers up -d consolidate
podman compose -f deploy/compose.yaml --profile workers logs -f extract consolidate
```

From then on `--profile workers up -d` brings both back with the stack (or
`COMPOSE_PROFILES=workers` in `deploy/.env`). Name the profile on `down`
too: a plain `down` leaves the two followers running against a database it
has removed.

**What each one is:**
- **Identity.** Both need a worker key, and refuse to start without one (exit
  2), so what they write carries its agent id. A key the database cannot
  resolve at start is a warning, as for a run from a checkout.
- **Settings.** `OB1_EXTRACT_FOLLOW` and `OB1_CONSOLIDATE_FOLLOW` set the poll
  interval in seconds (unset, 15). `OB1_EXTRACT_WORKERS` and
  `OB1_CONSOLIDATE_WORKERS` set the worker count (unset, 1, not the CLI's 2).
  A worker holds one model call at a time, so the two counts, with
  `board-sync`'s calls and the captures', share the provider's parallel slots
  (`OLLAMA_NUM_PARALLEL`): one each leaves a slot free for captures on a
  provider with three while `board-sync` is idle. Digits only: anything else
  is refused naming the variable, and a number the CLI then refuses (`0`,
  more digits than it reads exactly) is refused naming its flag, `--follow`
  or `--workers`. Everything else is the server's environment: the model, the
  endpoints, the egress policy, the extraction window and the escalation
  model.
- **Code.** The services run this checkout's `db/` and `server-portable/`,
  mounted read-only as for `board-sync`; neither release image carries the
  workers (SMD-2601). So the profile needs a checkout, and the checkout should
  be at the release the stack runs: a newer one runs newer worker code
  against an older schema, and the workers do not check the schema's version.
  The mount is the checkout compose was run from, so run it from one that
  stays (not a worktree you will remove). A changed checkout reaches a
  follower when it is restarted — any restart, on-failure included.
- **Stopping.** `stop` lets each worker finish the thought it holds. The grace
  period is 120 s for `extract` (a thought's extraction took 121 s at p90 on
  the stable brain) and 60 s for `consolidate`. Inside it the follower exits
  0; past it the container is killed (137). Either way it stays stopped, and
  a thought still held is not lost: its lease lapses after 900 s and the next
  run takes it (a thought whose lease lapses three times is recorded failed).
- **Refusals.** A configuration refusal exits 2: no key, a key
  `MCP_ACCESS_KEYS` does not hold, a revoked key or one whose scope grants
  nothing (`forward`), a setting that is not a number the CLI takes, an egress
  policy that would refuse every call (`OB1_LLM_LOCAL` unset against a host
  Ollama), or (`extract`) a model or prompt version other than the one the
  brain's extraction key records. So does a provider that refuses the
  follower's first call at start — a model it does not serve, a refused key,
  a wrong base URL (SMD-2599). The service is restarted three times — four
  runs — then stops, and `ps` shows it exited, as `board-sync` does.
- **Outages.** A follower waits out the database going away (it checks
  again after 5 s, doubling to 5 min) and a provider outage — a transient
  error past its pauses, a 404 naming the model while Ollama pulls it, a
  timeout its probe cannot get past — and says so in its log. The thought in
  hand goes back to the pool unrecorded, and the follower probes with a
  one-token call until the provider answers; a thought that fails again
  within 15 minutes of that is recorded failed, as its own fault (SMD-2599).
  An unreachable provider at start is waited for too. None of these exits,
  so none spends a restart.

**Changing the model.** A new `OB1_METADATA_MODEL`, or a checkout whose
extraction prompt version moved (after a pull), is a new extraction key, and
`extract` refuses it until told. Stop both followers BEFORE the change
reaches them:
- a running `extract` keeps extracting under the old key, over what the
  switch writes;
- a `consolidate` recreated under the new key judges every thought against
  the old model's entities, and never judges the new ones.

With `COMPOSE_PROFILES=workers`, a plain `up -d` after the change starts both,
so stop them before you pull or edit. Then run the switch once — a backlog,
so it ends as the first start does:

```bash
podman compose -f deploy/compose.yaml --profile workers stop extract consolidate
# now edit deploy/.env, or move the checkout
podman compose -f deploy/compose.yaml --profile workers run --rm --no-deps extract bun db/extract-entities.ts --switch-key --workers 1
```

Check that it exited 0, read `--status` until the done line, and retry any
`N failed` (the first start's two commands, above) before consolidation
comes back. Then bring the followers back with the two servers, whose
capture-time tagging reads the same `OB1_METADATA_MODEL` (`server` for MCP,
`api` for REST):

```bash
podman compose -f deploy/compose.yaml --profile workers up -d server api extract consolidate
```

The switch re-extracts every thought that has no row under the new key — all
of them, for a key the brain has never used. **Going back to a model or
prompt version used before re-extracts nothing**: every thought still has
its finished row under that key, so the graph stays the other model's while
`--status` reads done (SMD-2607 fixes this). Until then, judge a new model on
a working copy (`db/tier.ts`) rather than switching the brain to it and back.

Consolidation's key follows its judge model (`OB1_JUDGE_MODEL`, else the
metadata model) and prompt version, with no switch to refuse: a new one is a
new pool. The follower takes every thought with entities again and judges
each pair not already proposed — up to three calls a thought, unattended.
With `OB1_JUDGE_MODEL` set, a new metadata model leaves consolidation's key
as it was, so thoughts already judged are not judged again against the new
entities.

**Start `extract` alone on a backlog.** A pair is judged once, from its newer
side, against older thoughts that share an entity, have a vector and were
captured on an earlier UTC date. If the older one had no entities or no
vector yet, the pair is never judged. For captures beside a running `extract`
that almost never happens: their neighbours were extracted long before. The
exception is two captures either side of 00:00 UTC with the earlier still
being extracted. One extract worker finishes it first, since it claims in
queue order; with `OB1_EXTRACT_WORKERS` above 1 it can still be held. A
backlog is different: a first run or a `--switch-key` queues every thought at
one instant, and they are taken in no order, so a thought can be judged
before an older neighbour is extracted. Hence the first-start order above.
Once newer thoughts have been judged, three cases miss their pairs however
the passes are run (`db/README.md`, "Consolidation: proposing which thoughts
supersede which"):
- an older thought whose extraction failed (`--retry-failed` extracts it);
- an older thought whose embedding failed (`db/reembed.ts` embeds it; no
  service runs it);
- an import dated older than thoughts already judged.

**Consolidation applies no proposal.** Each proposal waits for a person. One whose text moved under it (a stale row) is judged
again by the next pass, which settles it unless the conflict still stands,
when it waits for a person again (067). `--list` shows the queue.
`--accept <id>` or `--reject <id>` decides one, with `--note` giving your
reason. When the listing says the judge did not state which thought is
current, an accept needs `--direction newer` or `--direction older`.

Since migration 084 the pass also stores its related, evolves and duplicate
verdicts as `relation` facets on the newer thought — edges, not proposals,
nothing to review (`--list relations` lists them). The service connects as the
superuser, so it stores them. A brain that ran the pass before 084 has none for
the thoughts judged then: `--status` counts them and prints the `DELETE FROM
thought_work_claims …` that has the next pass judge exactly those again (their
model calls again), run with `podman compose -f deploy/compose.yaml exec
postgres psql -U postgres openbrain -c "…"` (`db/README.md`, "Consolidation:
proposing which thoughts supersede which").

```bash
podman compose -f deploy/compose.yaml --profile workers run --rm --no-deps consolidate bun db/consolidate.ts --list
```

An accept is audited under the agent of the key in `OB1_WORKER_KEY`, which in
this container is the workers' key. To have it recorded as yours, give your
own key, one `MCP_ACCESS_KEYS` holds, to that one command: set before it on
the same line, it reaches neither your shell nor the next command, and the
bare `-e` passes it into the container without putting it on the command
line:

```bash
OB1_WORKER_KEY="$(cat ~/.config/ob1/my-key)" podman compose -f deploy/compose.yaml --profile workers run --rm --no-deps -e OB1_WORKER_KEY consolidate bun db/consolidate.ts --accept <id> --note "…"
```

The run prints `agent: <name>` first; check it names your key. Do not
`export OB1_WORKER_KEY`: compose reads the shell before `deploy/.env`, so
every later compose command in that shell — an `up -d` included — would
start the followers under your key. Without the prefix, the decision is the
workers' key's.

A reject records no reviewer whichever key runs it (SMD-2608). Accepting
unattended waits on a judge that can tell conflicts apart (SMD-1873).

This is the baseline for the sleep scheduler (SMD-1794): always on, at low
concurrency. `db/sleep.ts` runs these passes only while the logs are quiet
and stops them on a live call; until its compose service (SMD-2678) it runs
in a one-off container of this profile's `extract` service, with the
profile's own followers stopped — `db/README.md`, "Sleep", gives the command
and how to move off this profile, whose followers do not yield. It has no
budget yet (SMD-2679).

## Refreshing a tier

`db/tier.ts` builds the canary and working tiers from stable (`db/README.md`,
"The canary and working tiers"). Its `--refresh` runs under Bun and shells to
`pg_dump` / `pg_restore`, `pg_dump` at least both servers' major (it reads
`--to` too, to show it reaches it before the reset), and no image here
carries both. `tier.sh` is the runnable form. It builds `db/tier.Dockerfile`
(`oven/bun:1.4.0-alpine` plus `postgresql16-client`, the major of the postgres
service) as `open-brain-tier:latest`, and runs this checkout's `tier.ts`
in it, mounted read-only, on the stack's networks — `data`, where Postgres
is, and `egress`, where a replay's embedding model is:

```bash
# stable (this stack's postgres) into a working copy, a scratch database on the
# same server, created first; from a branch worktree, name the running stack's
# env file (deploy/.env is gitignored)
docker compose --env-file ~/OB1/deploy/.env -f deploy/compose.yaml exec postgres createdb -U postgres openbrain_working
deploy/tier.sh --env-file ~/OB1/deploy/.env --refresh --from postgres --to postgres/openbrain_working --tier working
# replay stable's logged searches on the canary deploy/canary.sh stood up — on
# both projects' database networks, so by container name (each has a
# `postgres`), and stable's egress for the model the replay embeds with. The
# canary's database takes its own password (SMD-2583): --env-file is the
# canary's file, which builds --to's URL and hands on the replay's settings,
# and --from-env-file is stable's, for --from's password alone
OB1_EVAL_EMBED=qwen3-embedding:4b@1024 deploy/tier.sh --env-file ~/OB1/deploy/.env.canary.local \
  --from-env-file ~/OB1/deploy/.env \
  --network open-brain_data,open-brain-canary_data,open-brain_egress \
  --diff --since 2026-01-01 --from open-brain-postgres-1 --to open-brain-canary-postgres-1
# the three-tier stack's own database network and services
deploy/tier.sh --refresh --from stable-postgres --to canary-postgres --network open-brain-tiers_data
```

A working copy on stable's server is a scratch database for a branch's
migration, reset at will. It shares stable's memory and WAL as a canary must
not, since the canary is the tier that takes the risky rebuilds ("A canary
beside the stack", below).

A `--diff` or `--replay` replays what stable logged, so:
- stable must run with `OB1_QUERY_LOG=on`, which is off by default;
- the window starts at the canary's last refresh unless `--since` says
  otherwise, and a refresh is what `canary.sh up` just did;
- hybrid-arm rows (`search_thoughts`) are replayed only with `OB1_EVAL_EMBED`
  set to the brain's model, as in the example, and otherwise skipped.

Both print the window and how many searches were replayed and skipped. A
`--diff` that replayed none says `nothing to compare` and exits 3, where a
pass is 0, a moved ranking or a failed step 1, and a usage error or refusal
2 (SMD-2182).

### Compare two live brains

`--diff`/`--replay` is the merge-time replay over Postgres. To ask instead "are
these two running brains telling me the same thing, and if not why?" in one step,
point them at each other over HTTP (SMD-2109):

```bash
# each brain is a connector name (claude mcp get resolves the URL + key) or an
# http(s):// URL with its key in --a-key/--b-key, OB1_COMPARE_KEY, or ?key=
bun db/tier.ts --compare open-brain open-brain-canary
# replay a supplied query set…
bun db/tier.ts --compare open-brain open-brain-canary --replay --hybrid \
  --query "highest value open ticket" --queries-file deploy/compare-queries.txt --json
# …or replay what a brain actually searched, from its own query_log
bun db/tier.ts --compare open-brain open-brain-canary --replay \
  --from-log open-brain --since 2026-09-24T00:00:00Z
```

It reads each brain as a client — the keyed `GET /health` record (version,
commit, tier, the tree's latest migration against the ledger's highest, schema
version, embedding, counts, and the **board-sync watermark**: the newest Linear
`updatedAt` any thought reflects, SMD-2261); the **exact id-set difference** (which thoughts one
brain holds and the other does not, via `list_thought_ids`, SMD-2244); and, with
`--replay`, the two search tools over a query set that is either supplied
(`--query`/`--queries-file`) or drawn from a brain's own `query_log`
(`--from-log`, SMD-2245 — each logged search replayed on the arm that ran it).
The vector arm needs no local model — each brain embeds its own query. It never
prints a key and prints a one-line verdict ("current with each other" / "canary
is 1 migration behind; 407 vs 597 thoughts"), and exits non-zero when anything
differs. The default compare writes nothing; `--replay` issues real searches,
which a brain running `OB1_QUERY_LOG=on` records in `query_log` (telemetry,
migration 034, never the thoughts corpus), as any client search does. Until
SMD-2037 lands, a refreshed brain runs at pgvector's default HNSW settings, so a
hybrid-arm difference can be GUC-induced — the retrieval section says so.

The board-sync watermark is the one freshness signal a missed day of board moves
changes: a status move rewrites a ticket's thought, so the count, the newest
capture and the ledger all stay the same. The Freshness section prints
`board sync: a=…  b=…`, and watermarks half a day or more apart, or one brain
holding no usable one, are a delta the verdict names ("open-brain-canary's
board-sync watermark is 1 day older") and the exit code counts. A brain older
than SMD-2261 reads `unread` there and is not called older. A brain that has the
field but did not read it (a read that timed out or failed — it is the last the
keyed `/health` deadline reaches), or sent a malformed value, makes a verdict with no other delta "not
certain" rather than "current", exit 0 as for any unread axis, and the line says
why. A value more than an hour past the brain's database clock is passed over:
if that clock runs more than an hour slow, a fresh board move is passed over and
the watermark lags until the clock catches up. The gap is between the newest board
move each brain reflects, not how long one has been stale: a canary refreshed
after a quiet week reads a week older the hour the board next moves, and a pass
that synced one stale ticket of fifty moves the watermark as far as all fifty
would. It moves when the board does, so it says nothing of whether a sync is
alive.

`--from` and `--to` name a database on the network as `HOST[:PORT][/DB]`
(port 5432 and database `openbrain` by default). The wrapper builds the URL as
the services here do, with `POSTGRES_PASSWORD`. A full `postgres://` URL is used
as given. `--network` defaults to `open-brain_data,open-brain_egress` (a
stack from before SMD-2583 has one, `open-brain_default`), and `--runtime` is
`docker` or `podman` (docker when it is on the PATH). `--from-env-file PATH`
takes a short-form `--from`'s password from another env file, when `--from`
is another stack's with a password of its own (the canary's refresh names
stable's; SMD-2583); nothing else is read from it. Anything else goes to
`tier.ts` as given, and a wrapper flag given twice is refused.

The env file (`--env-file`, default `deploy/.env`) is read by compose itself,
through `compose config --environment`. So a quoted value, an inline comment,
an `export` line, CRLF line endings or a byte-order mark read here as they do
for the stack. A variable set in the shell wins over the file, as it does
there. Only what `tier.ts` and `migrate.ts` read is handed to the container:
- the `OB1_*` knobs (`migrate.ts` reads `OB1_EMBEDDING_*` on a refresh);
- `POSTGRES_PASSWORD`;
- the key the replay's embed falls back to when `OB1_LLM_API_KEY` is unset
  (`OPENROUTER_API_KEY`).

Access keys, `LINEAR_API_KEY`, `OLLAMA_BASE` and the authorization server's
`OB1_AUTH_*` settings stay behind. The values travel in a temporary
env file (mode 600, removed on exit), so they are not on the wrapper's command
line or the runtime's. They are in the container's environment, which
`inspect` shows while it runs, and the URLs are on the argument lists of bun,
`pg_dump`, `pg_restore` and `migrate.ts` inside it, which a Linux host's `ps`
shows (SMD-2119). The checkout's own `.env` files are mounted with the code and
switched off: `OB1_ENV_FILES=off` stops `db/env.ts` reading them, and
`bun --no-env-file`, run from a working directory outside the checkout, stops
Bun's auto-load. So only the stack's environment reaches `tier.ts`.

From a container every database is remote, so a short-form `--to` gets
`OB1_ALLOW_REMOTE_DB=1`. A `--to` given as a URL does not, so export
`OB1_ALLOW_REMOTE_DB=1` to reset one, as with `tier.ts` itself. In place of the
loopback check, `tier.ts` guards `--to` two ways:

- **It is not the `--from` database.** The source connection's own session is
  looked up in the target's `pg_stat_activity`. Only the same cluster lists it,
  and then the database names decide. So `postgres` and `open-brain-postgres-1`
  are one database, and a canary copied from stable's volume, which shares its
  `system_identifier`, is still another.
- **It is a tier a refresh can own.** That means one of:
  - a database an earlier refresh marked. Before resetting, each refresh sets
    `ob1.refresh_target` on the database, where the reset and the restore
    cannot reach it, so a refresh that failed partway can simply be re-run;
  - one stamped `canary` or `working`;
  - one whose public schema holds nothing but what extensions own;
  - an Open Brain schema (`schema_migrations`, `ob1_config` and `thoughts`)
    holding no thoughts. `schema_migrations` alone is not enough, since Rails,
    Ecto, golang-migrate and dbmate use that name too.

  A `--to` stamped `stable`, a brain holding thoughts under no tier stamp,
  and another application's database are refused. The first two are most
  often `--from` and `--to` the wrong way round, and the third a name one off.
  The refusal names no override, because marking such a target by hand
  disarms the guard for it for good.

**The mark.** The mark is only ever read from the database's own setting (in
`pg_db_role_setting`), and only `canary` or `working` counts. A value set for
a role, for the server or on a connection does not count, and neither does a
`stable` or `off` set there by hand. Setting it needs a superuser, or
`GRANT SET ON PARAMETER ob1.refresh_target` (PG15+). Restoring pgvector needs
a superuser in the default install anyway, and a refresh that cannot set the
mark stops before touching anything. The mark lasts until it is cleared, and a
database restored from a canary's dump with `--create` brings it along:

```sql
-- make a database a refresh target on purpose (a new tier's database, say)
ALTER DATABASE openbrain SET ob1.refresh_target = 'canary';
-- clear it before a database that was a tier becomes the record
ALTER DATABASE openbrain RESET ob1.refresh_target;
```

`--promote` refuses a marked `--to` and prints the `RESET` for it.

The container runs with `--init`, so Ctrl-C stops a refresh, and `tier.sh`
then exits with the container's status (130), so a script calling it stops
too. It publishes nothing. The client's major has to be at least the source
server's, and `refreshToolsReady` refuses the refresh otherwise, so a
Postgres bump in the compose files means bumping the package in
`db/tier.Dockerfile` with it. On
every PR, the deploy-stack CI job seeds one thought and one logged search, then
runs through this script: a refresh, a `--replay`, a `--diff`, a `--diff` over
the empty window after the refresh (exit 3), a retry over a copy left
stamped `stable` (as a refresh that died after its restore leaves it), and
both refusals. On a host with SELinux enforcing (Fedora and RHEL,
where podman labels by default), the container can read the mounted checkout
only once it is relabelled: `chcon -Rt container_file_t <checkout>`. The
script does not relabel it for you.

The dump carries no database-level settings (`ALTER DATABASE … SET`), so the
refresh copies `--from`'s onto `--to` itself before migrating it, and resets
any `--to` has that `--from` lacks, the refresh mark aside (SMD-2037). That is
how migration 014's HNSW bounds reach the copy: without them a broad filtered
search on it walks at pgvector's defaults and returns short. Only the
database's own settings travel. Where stable's bounds come from the server's
configuration instead (`postgresql.conf`, `ALTER SYSTEM`, and 014 then seeds
none), a copy on another server has whatever that server says. A server already
running on the refreshed database keeps its old pool until it is recreated.
Grants are not carried either (the restore runs with `--no-privileges`), so a
server that connects to the copy as a role other than `postgres` needs
`bun db/migrate.ts --url <copy> --grant <role>` first. Since migration 054 a
key used recently on stable is not written on its next lookup, so a missing
grant can surface minutes after a start that looked healthy.

## A canary beside the stack

`compose.tiers.yaml` stands three new brains up from nothing. A stack that is
already running holds a brain of its own, and SMD-1806 makes it stable, the
record. `canary.sh` stands the canary beside it, and takes it down again
(SMD-2038):

```bash
# from a branch worktree, name the running stack's env file (deploy/.env is gitignored)
export OB1_SMOKE_KEY=…   # a raw write key whose hash is in MCP_ACCESS_KEYS; the canary takes stable's keys
deploy/canary.sh --env-file ~/OB1/deploy/.env up --connect
deploy/canary.sh --env-file ~/OB1/deploy/.env down --volumes
```

The canary is `compose.yaml` again under the project `open-brain-canary`, with
its own Postgres, volume, networks and images, `OB1_TIER=canary`, and two
servers: the MCP server and the REST core. It needs Docker Compose v2
(`config --format json`, `up --wait`), which is what `docker compose` is and
what `podman compose` runs when it is installed; the Python podman-compose is
not enough.

It runs on an env file of its own (SMD-2583): `.env.canary.local` beside
stable's (`--canary-env-file` names another, never stable's own file). The
root `.gitignore` has ignored `.env.*.local` since before this, so stable's
checkout ignores it whatever its age, and the temporary file it is written
in, `.env.canary-<pid>-<n>.local`, which is removed however `up` ends. The
first `up` writes it from stable's file as compose reads it, mode 600: every
setting, each with the value compose read, quoted afresh, but for three kinds:
- **the database password**, which is a fresh one of the canary's;
- **the secrets of the profiles the canary never runs**: the authorization
  server's `OB1_AUTH_*`, n8n's `N8N_*`, the import runner's `OB1_RUNNER_*`,
  the workers' `OB1_WORKER_KEY` and `LINEAR_API_KEY`;
- **nothing else**: the file is kept only if compose reads every value in it
  as stable's file reads it, less those, and no value carries stable's
  database password (a `DATABASE_URL` holding it, say, is refused, naming the
  setting; a password under 12 characters is not looked for, as it would
  match ordinary text). Stable's comments are not carried.

A value stable's file builds from a shell variable (`X=${SOMETHING}`) is
refused, naming it, rather than written as it read at that moment: write the
canary's file yourself then. The container runtime's own variables (`HOME`,
`PATH`, `USER`, `TMPDIR`, `XDG_*`, `DOCKER_*`, `PODMAN_*`, `CONTAINER(S)_*`)
are read as they are when `up` runs, and written as values. A file that is
not UTF-8 is refused too. Each of these refusals comes before stable is
stamped or anything else changes. And every `up` that finds the file checks
it first, before anything else, as an edit can undo it: a password of its
own (not built from the shell, on one line) and nothing of stable's.

**One way.** Once a canary.sh with this file has run, the canary's database
takes the canary's password, and a canary.sh from before SMD-2583 (an older
release's checkout, a branch not yet merged with it) builds the canary's URL
from stable's: its `up` stops the canary's servers, then fails the refresh
(at the canary's login, or sooner, at a stable network that no longer
exists), and `/canary/mcp` stays down until this script's `up` runs again, or
`down --volumes` starts the canary afresh.

From then on the file is the canary's own:
- **The password.** Every `up` sets the canary database's password to the
  file's, so a canary stood up before SMD-2583, whose database was made on
  stable's password, takes its own at its next `up`. Neither password opens
  the other stack's database, and the canary's servers hold no database
  credential of stable's. They do hold stable's other settings, its provider
  keys and access-key hashes among them, as the canary always has.
- **Stable's changes.** A setting stable gains or changes later does not reach
  the canary, and `up` names each one that differs (the name, never the
  value; the port, address, tier and profiles canary.sh sets are not named).
  Edit `.env.canary.local` to carry one across, or delete it and the next
  `up` makes it again. `down --volumes` leaves it, and a canary stood up again
  makes its database on it.

It takes stable's access keys with the rest, so a client reaches it with
stable's keys. The tier and the compose profiles (none) are the canary's own. Each tier has its own Postgres server, never a second
database on stable's: a canary exists to absorb the risky migration, reembed
or index rebuild, and a shared server would share its memory, its WAL and its
crashes with the record.

It answers at `/canary/mcp` on stable's own origin (SMD-2294): the URL is
stable's with `/canary` in front of `/mcp`, on stable's `SERVER_PORT`.
`deploy/compose.canary.yaml` puts its two servers on
stable's `mesh` network as `mcp.canary.ob1.internal` and
`api.canary.ob1.internal` (only those: the canary's own `mesh` names would
share stable's `/mcp`, `/api` and `/auth`), and stable's proxy routes
`/canary/mcp` to the first ("One origin", above). They stay off stable's
`data` and `egress`, so they cannot reach stable's database, or a service a
compose profile runs there; stable's Postgres is on stable's `data` alone, so
the canary's `postgres` is its own (SMD-2583). The refresh joins each
project's database network, read off its Postgres container: `data`, or
`default` for a stable from before SMD-2583. It reads stable's password from
stable's env file and the canary's from the canary's (`tier.sh
--from-env-file`). With no profiles the canary advertises no OAuth;
on stable's mesh it could otherwise find stable's authorization server.
On stable's origin the canary is reached wherever stable is, with stable's
keys: on the LAN when stable's `SERVER_BIND` opens it, and through any tunnel
or TLS proxy in front of stable's port. It runs whatever the checkout that
stood it up holds, so `up` says so when stable is bound past loopback or has
a public origin; pass `--port N` for a canary on this host's loopback alone.
While a canary is attached, stable's `compose down` leaves stable's mesh in
place (it is in use), so take the canary down first; if stable's mesh is
made again, re-run `up`.

A stable from before SMD-2294 has no `/canary` route, and `up` refuses there
unless `--port N` names a loopback port for the canary's own proxy, the way
every canary was stood up before (on its old fixed default port, which
`--port` now names): its server at
`/mcp` on `127.0.0.1:N`, whatever `SERVER_BIND` says for stable, and its
servers off stable's mesh. Re-run `up` without `--port` once stable is
upgraded, and the canary's proxy is removed.

`up` can be re-run, and re-running it is how the canary catches up after
stable is redeployed:

1. It refuses, with exit 2 and nothing changed, when:
   - the canary's server would dial a bare hostname for a model endpoint
     (`OB1_LLM_BASE_URL`, `OB1_CHAT_BASE_URL`, `OB1_JEV_BASE_URL`). Stable's
     compose services are on stable's `egress` network, which the canary
     never joins: `OB1_LLM_BASE_URL` unset falls
     back to the `local-models` profile's `ollama`, and the jev profile's
     setup is `http://jev:8020`. Name an endpoint the canary can reach for
     the canary alone, in the shell, which wins over the env file for the
     canary and leaves stable as it is (or in `.env.canary.local`, once `up` has
     made it):
     `OB1_LLM_BASE_URL=http://host.docker.internal:11434/v1 deploy/canary.sh
     … up` for an Ollama on the host, or a host's full name for one on the
     LAN. It must serve the brain's embedding model. A remote provider also
     needs `OB1_LLM_LOCAL=` cleared there, or the egress gate takes it for
     local. A stack whose only model server is the `local-models` profile
     needs an Ollama on the host for its canary;
   - stable's running proxy routes no `/canary/mcp`, or stable has no `mesh`
     network, and no `--port` was given;
   - with `--port`, its port is taken. For another container's, pass another
     `--port`; if that container is a canary stood up by hand, remove it
     instead, since the new canary is refreshed from stable and nothing is
     lost that stable does not hold. A process on the host listening there is
     refused too;
   - `--connect` finds another connector under the name (below);
   - stable's Postgres, found by its compose labels (`--stable-project`,
     default `open-brain`), is stamped `canary` or `working`, or carries a
     refresh's mark (`canary`, `working`): that is a copy, not the record.
     A mark of `stable` or `off`, an operator's protection, is not one;
   - stable's Postgres is on neither `<stable>_data` nor `<stable>_default`,
     where the refresh would reach it (SMD-2583);
   - the canary's env file, when it has one, holds no `POSTGRES_PASSWORD` of
     its own, or one built from the shell or spanning lines, or holds
     stable's database password anywhere (above).

   Stable with no tier stamp is stamped `tier=stable`. When stable's server
   runs without `OB1_TIER=stable` it says so; set that in the env file and
   recreate the servers (`up -d server api`).
2. It writes the canary's env file if there is none (above), and starts the
   canary's Postgres. Once standing servers are stopped (3), it sets the
   canary database's password to that file's, then refreshes it from stable
   through `tier.sh` on each project's database network: the dump, the
   settings, a migration with this checkout, the stamp and the mark
   ("Refreshing a tier", above). Stable's password comes from stable's env
   file alone and the canary's from its own: a password set only in the
   shell is not used, since canary.sh unsets it (compose would let it win
   over the canary's file) and tier.sh refuses one beside
   `--from-env-file`.
3. It builds the server from this checkout and recreates it and the REST
   core, which runs the server's image, so their pools open on the refreshed
   database. Standing servers are stopped before the refresh, so nothing
   serves the copy mid-restore through the connector, or writes rows the
   restore then collides with. `OB1_GIT_SHA` is the checkout's
   `git describe`, unless the shell sets it.
4. It smoke-tests the canary with `OB1_SMOKE_KEY`. The keyed `/health` must
   say `tier` `canary`, and `smoke.sh` must pass. Then the vector arm, which
   `smoke.sh` leaves out and a `--diff` replays only with a provider
   configured. A candidate thought is searched for by its own text, with
   every literal that search matches exactly taken out: SMD keys, dates,
   paths and identifiers, as `extract_search_needles` finds them. It must
   come back as Result 1, at 50% or more. Up to five candidates are tried,
   and the first that passes decides.
   - Taking the literals out matters. `search_thoughts` is hybrid, and it
     scores a keyword hit by cosine too, so a probe holding an identifier was
     found by the keyword arm at 0.2% under a provider answering random
     vectors.
   - The floor is what a thought scores against its own text. On the
     dogfood's brain that was 78–94%, and about 0 under the random provider
     or another model.
   - Five candidates, because with the literals out two session summaries of
     one template are nearly one text, and the vector arm rightly ranks a
     sibling first. On the dogfood's brain that happened to 10 of the 30 newest
     candidates, with at most two misses in a row. From any of the 26
     starting points the first five held a pass, and a broken provider or
     index fails all five.
   - Candidates are the newest thoughts embedded with the brain's model
     whose opening, digits aside, no other thought shares.
   - A canary with no such thought is not checked, and says so, unless stable
     had one before the refresh: then a migration emptied the vectors, or the
     model changed without a reembed, and the smoke fails.

   `--no-smoke` skips the smoke and needs no key.
5. With `--connect` it registers the Claude Code connector
   `open-brain-canary` (`--name`) at user scope, under the same key; a new
   session sees its tools. The URL is the canary's: `/canary/mcp` on
   stable's origin, or `/mcp` on `--port`.

`down` removes the canary's containers and its own networks; stable's mesh
stays. It deregisters the connector only when `claude` has it at user scope
and at a URL of the canary's: `/canary/mcp`, which no other service answers,
on loopback (`127.0.0.1`, `localhost`, `[::1]`) or on the address stable's
origin is bound to (its forwarder's, or its proxy's before SMD-2583), or a
canary proxy's port with any path (and either with
any `?key=`). A connector at stable's own `/mcp` is never the canary's. An
`up` that moves the canary between stable's origin and `--port` without
`--connect` leaves the connector where it was, and says how to move it.
One at the root of `--port`'s port, the URL from before `/mcp`, still
answers through the deprecated root until v2.0.0 (SMD-2532), and `up` says
so; `--port N --connect` moves it to `/mcp`. Moving off `--port`, pass `--connect` in that same `up`, which moves the
connector before the canary's proxy goes; afterwards its old port is no
longer the canary's, and the connector must be removed by hand first
(`claude mcp remove --scope user open-brain-canary`). The proxy goes last,
once the canary answers on stable's origin: an `up` that fails keeps it, so
a connector at its port stays the canary's and a re-run with `--connect`
moves it. Only a failure after the health wait (at the smoke, or the
connector) leaves it answering meanwhile; a
failed refresh or health wait stops the canary's servers.
A canary proxy's port is read from its container — its forwarder's, which
publishes it since SMD-2583, or its proxy's before that — running or stopped (after
a reboot podman leaves it stopped, and Docker restarts it but not its
Postgres); once that is gone, pass the `--port` it was stood up with.
`claude mcp get` shows the
entry that wins for the current directory, so a local entry by the name
hides a user one behind it. One by that name anywhere else, or in local or
project scope, is left alone with a line saying so, and `up --connect`
refuses to replace it. `--volumes` also deletes the canary's database, and
only once it says it is a canary: stamped `canary`, marked by a refresh, or
holding nothing, which is what a first refresh that died before its mark
leaves. A refusal puts the canary's Postgres back as it found it. The volume
is looked for by name (`open-brain-canary_pgdata`), which is how `compose
down --volumes` removes it. With none there is nothing to delete, and nothing
is started to find out. Neither touches stable: `down` acts on the project
`open-brain-canary` alone.

On every PR, the deploy-stack CI job runs `canary.sh` beside its stack, in
two steps. The first is every refusal above, each with exit 2 and nothing
started, stamped or registered: an old stable by its proxy's route label, a
stable proxy off its mesh, an empty `--port` and a `--stable-project` no
project could be named among them. The second is the canary's life, in four
`up`s:
- `up --connect` over a stable carrying the protective mark `stable`. The
  canary must answer at `/canary/mcp` with tier `canary` and OAuth not
  configured, run no proxy, hold only its tier's names on stable's mesh, and
  say that stable's public origin reaches it; its probe must pass on a
  thought whose text holds literals, searched for without them;
- a second `up`, with `--port` under `SERVER_BIND=0.0.0.0`, against a
  provider stub serving another model. The canary's proxy must be on
  loopback, its servers off stable's mesh, `/canary/mcp` the proxy's 404
  again; the thought put on stable just before it must reach the canary, and
  the smoke must fail on the floor;
- a third `up` on the same port, with a connector at its root: named as on
  the deprecated root, not as one the canary no longer answers, and the root
  answering 200 with a `Deprecation` header;
- a fourth `up`, back on stable's origin: the canary's proxy removed, its port
  free, and a connector left at that port named;
- `down --volumes` refused on a canary stamped `working`, an empty canary
  deleted, and nothing to delete once the volume is gone (a local-scope
  connector left alone);
- a volume by the canary's name that compose did not make, holding a table,
  refused with nothing left running;
- a connector at stable's own `/mcp` left alone, and a last `down` that
  removes the canary's.

Afterwards the stack's Postgres container, its thoughts and its server are
checked unchanged. A stand-in `claude` on PATH answers `mcp get` there. The
provider stub embeds by bag of words, and the probe thoughts are seeded with
its vectors, so a thought is near its own text and far from the others. Its
wrong-model mode scores a thought's own text at about 30%.

## The typed-decision tier

The Jev spikes — a reranker, a question router, extraction gates — each need a
model that answers a bounded question ("is this true of this text?", "which of
these options?") with a calibrated probability in one forward pass. Ollama
cannot serve one (its API exposes no option logits), so the `jev` profile runs
[`jev/serve.ts`](../jev/README.md) — Verdict v1.4 on onnxruntime's CPU
provider — beside the stack (SMD-2050):

```bash
# deploy/.env: OB1_JEV_BASE_URL=http://jev:8020 and OB1_JEV_LOCAL=1
podman compose -f deploy/compose.yaml --profile jev up -d
podman compose -f deploy/compose.yaml --profile jev logs -f jev
```

The first start fetches the pinned weights (606 MB, about 20 s here) into the
`jev-models` volume — on a link slower than ~1 MB/s that outlasts the
healthcheck's ten-minute start period and the server, which waits for a
healthy `jev`, does not start: pre-pull with
`podman compose -f deploy/compose.yaml --profile jev run --rm jev --fetch-only`; every start verifies each file's sha256 and replaces one
that does not match (a verify-only restart serves in about a second). About
1 GB resident, outside Ollama's scheduler. With `OB1_JEV_BASE_URL` set the
server's preflight dials the tier and fails the start when it does not answer,
so set the knob with the profile, not before it; with the profile the server
waits for `jev` to be healthy (`depends_on … required: false`), so the first
start's fetch does not crashloop it. `compose restart server` does not start
what the server depends on: with `jev` stopped the server's preflight fails
and restarts it until `compose --profile jev up -d` brings the tier back
(preflight's remedy says so). A full batch of 64 decisions is ~25 s in the
container; `JEV_THREADS` (and `JEV_HUB`, a mirror for the weights) in
`deploy/.env` reach the service. A spike run from a checkout
adds `-f deploy/compose.host-ports.yaml` and reaches it at
`http://127.0.0.1:8020`; without compose, `bun jev/serve.ts` on the host serves
the same contract on the same port.

## Orchestration

The fork's orchestration tool is n8n (`../docs/orchestration-tool.md`,
SMD-1863). It runs workflows that need state — a schedule, a trigger, a retry,
a cursor. The `orchestration` profile runs it beside the stack (SMD-2210).
The image is n8n's, pinned by digest and never vendored.

n8n itself reaches the brain only through its MCP endpoint, with a
capture-scope key, and holds no write key. The one exception is the profile's
import runner (SMD-2212, below). It writes brain tables directly, the way the
pipeline does from a checkout, and a workflow holding its key can cause those
writes. That is the ADR's decision 4, amended, and the runner's key is
bounded by its allowlist. OB1's part is the provisioning step in
`orchestration/`, the templates it loads from `orchestration/templates/`, and
the runner.

Below, `compose` stands for `podman compose -f deploy/compose.yaml --profile
orchestration`, or docker compose.

```bash
bun deploy/orchestration/provision.ts --init   # once: the profile's secrets into deploy/.env (it never replaces one)
podman compose -f deploy/compose.yaml --profile orchestration up -d
bun deploy/orchestration/provision.ts        # --env-file for another file; --rotate for a new API key
# Optional, for a template that captures into the brain (none ships yet): a CAPTURE key
cd server-portable && bun keygen.ts --name n8n --scope capture && cd ..
#   the key into deploy/.env as N8N_BRAIN_CAPTURE_KEY, the line it prints into MCP_ACCESS_KEYS,
#   then recreate the servers (compose up -d server api; a restart keeps the old keys) and provision again
```

`--init` writes `N8N_ENCRYPTION_KEY`, `N8N_OWNER_PASSWORD` and its bcrypt
hash `N8N_OWNER_PASSWORD_HASH` (single-quoted, since compose would read its
`$`s as variables), `N8N_MCP_KEY`, `N8N_WEBHOOK_KEY`, the import runner's
`OB1_RUNNER_KEY`, and `OB1_RUNNER_DB_PASSWORD`, its database role's (SMD-2289),
where the file has none. A stack provisioned before SMD-2289 runs `--init`
once more to gain the password, then `compose --profile orchestration up -d
--build`, so the migrator's image carries `login-role.ts`. Without the
password, `compose --profile orchestration up -d` fails naming `orchestration-runner-role`, whose log (`compose logs
orchestration-runner-role`) says to run `--init`, and the runner is not
started, the one already running included. n8n sets its owner from the email and the hash at every start
(`N8N_INSTANCE_OWNER_MANAGED_BY_ENV`). So the owner exists from the first
boot, and nobody who reaches the port before provisioning can claim the
instance. To change the password, edit it, run `--init` again, and recreate
n8n: `compose up -d n8n`. A `compose restart` keeps the environment the
container was created with, and so the old hash. `--init` re-derives a hash that no longer matches, and rewrites one
whose line is not single-quoted. Keep the password within 72 bytes: bcrypt
reads no further, and `--init` refuses a longer one. Without the key or the
hash, the container exits at once with the reason in its log, and `ps` shows
it restarting. The step reads `deploy/.env` alone. A shell variable of the
same name overrides the file for compose, so an exported `N8N_OWNER_EMAIL`
or `N8N_PORT` would split the two.

The provisioning step runs from a checkout against the loopback port. It
signs in as the owner and keeps n8n's API key in `deploy/.env` with its id,
its scopes and the file's tag (`N8N_API_KEY`, `_ID`, `_SCOPES`, `_TAG`), all
written at once. The key carries ten of n8n's 106 scopes, the credential
and workflow calls the step makes, and it expires after `N8N_API_KEY_DAYS`
(90). A run mints a new key when that one has less than a week left, or on
`--rotate`. Every run deletes every other key this env file minted, and
n8n answers a deleted key with 401. A key an interrupted run left behind
goes on the next run. A second env file provisioning the same n8n keeps its
own key: each file tags its keys, and a tag counts only beside a fingerprint
of the machine (its stable id, not its network hostname) and the file's
real path (`N8N_API_KEY_TAG_OF`). That holds for another machine's checkout
provisioning this n8n, and for a copy of `deploy/.env`, which mints under a
tag of its own on its first run and revokes nothing. A moved file does the
same. The step names the tag it left, with its live keys, and `--adopt`
revokes them. A symlinked `deploy/.env` is written through, and stays a
link. Then the step creates or patches each
credential from `orchestration/credentials.template.json` with values from
the env file, and creates or replaces each template. A replaced workflow
loses edits made in the editor: the template is the source. Run it again
after changing a key in `deploy/.env` or a template. Before it writes
anything, it refuses:
- a brain key at write scope, or one `MCP_ACCESS_KEYS` does not list,
  wherever in a credential it sits: a header, `Bearer <key>`, a URL's `?key=`;
- a key whose scope is not the one its credential declares (`brainScope`);
- one of OB1's own keys (the inbound keys, the runner's) in any other
  credential, a vendor's included, or inside a longer value: each does one
  job;
- a template naming a credential no template declares, or a workflow
  (`ob1wf:<template>`) no template is.

A credential marked `optional` whose value is unset is skipped, and so is
every workflow that needs it. Without `N8N_LINEAR_API_KEY` the act tool is
not loaded, and the run says so. A run also unloads what it no longer
produces:
- a workflow skipped that way, and an import instance whose pipeline left
  `pipelines.json`, are unpublished (their endpoint, webhook and schedule
  stop; the workflow stays, with its history);
- a skipped optional credential is deleted, with the key it held.

A workflow counts as a template's when its name fits the template's and it
carries one of the template's node ids. So a workflow of your own is never
touched, but a copy of an OB1 workflow renamed to an instance's name counts
as that instance.

No secret sits in n8n's environment but the encryption key and the owner's
hash, and no workflow can read one from there
(`N8N_BLOCK_ENV_ACCESS_IN_NODE`). n8n rate-limits sign-in to five a minute,
so several runs in a row can meet a 429. The step says so.

**An AI client** connects to an MCP endpoint a template publishes, at
`http://127.0.0.1:5678/mcp/<path>` (the port is `N8N_PORT`) with the header `x-n8n-key: $N8N_MCP_KEY`
(Claude Code: `claude mcp add --transport http n8n <url> --header
"x-n8n-key: …"`). What that endpoint exposes is workflow-shaped: an act tool
that is a multi-step flow, or a trigger an agent may pull. The brain's own
tools stay on the brain's endpoint, under the client's own key (decision 7).
**An on-demand run** is a POST to `/webhook/<path>` with the header
`x-n8n-run-key: $N8N_WEBHOOK_KEY`. The two keys are separate: the MCP key
starts no run, and the run key opens no MCP endpoint (both measured).

**The act tool** (`templates/act-mcp.json`). `/mcp/ob1-act` lists one tool,
`linear_file_issue`. It is a multi-step flow in its own workflow
(`templates/act-linear-file-issue.json`):
1. find the team by its key, and the label by its name;
2. create the label if the team lacks it;
3. create the issue, and answer its identifier and URL.

It holds a Linear key of its own, `N8N_LINEAR_API_KEY`, which needs write
access and is pinned to `api.linear.app`. Everything the AI client passes is
sent to Linear, and n8n keeps a copy in its run history for the window
below. Leave the key unset and the endpoint is not loaded, or is unloaded on
the next run if it was.

**Imports** (`templates/import.per-pipeline.json` and
`import-on-demand.per-pipeline.json`, the runner `orchestration/runner.ts`).
An import recipe converted to an emitter of ingestion-contract items
(SMD-2147–2150, SMD-2021) runs as one instance of the import template, one
per line of `orchestration/pipelines.json`. That file is empty until the
first recipe is converted. Each pipeline owns one source (its `system`): two
lines naming the same one are refused.
- **The schedule.** Each instance runs on a schedule of the pipeline's own,
  `everyHours`: 1 to 23 hours, or whole days (24, 48, … 168), since n8n
  counts an hourly schedule within one day. An hourly 24 ran once and never
  again (measured in n8n 2.40.6's own code). n8n counts days of the year, so
  a weekly run can come a day late at the end of a leap year.
- **On demand**, an instance runs through a POST to
  `/webhook/ob1-import-<pipeline>` with the run key. The door is a workflow
  of its own that saves no runs. It drops the request, headers and all, and
  calls the import, so the run key never lands in n8n's saved runs. It answers
  the report with 200, or the runner's reason with the runner's status (409
  when a run of that pipeline is already going, 422 refused, 500 failed).
  It answers 502 when the runner did not answer, or refused the door itself:
  a runner key out of step with n8n's copy, or a pipeline the runner lacks.
- **The runner.** n8n's image has neither Bun nor python3, so the import asks
  the runner, `orchestration-runner`, over the `egress` network, with
  `OB1_RUNNER_KEY`. The runner publishes no port, and it:
  1. runs the pipeline's emitter over `deploy/imports/<pipeline>/`, mounted
     read-only (`IMPORTS_DIR` moves it). Each pipeline's emitter runs as a
     uid of its own, derived from the pipeline's name (so a renamed pipeline
     has a new one), with no database URL or key in its environment. Its
     HOME is `/`, which it cannot write, and Python's user site is off.
     - It cannot read the runner's, the ingester's or another emitter's
       environment, or reach another emitter's process.
     - Whatever it leaves running is killed when it finishes.
     - A parser an export exploits holds no secret, and cannot plant code
       for, or lines into, another pipeline's emitter.
     - The export must be readable by the pipeline's uid. A directory it
       cannot read is refused as that (422, naming the uid and the path),
       not taken for an empty export.
     - It has no network (SMD-2289), unless its pipeline names hosts:
       - Nothing is reachable: no DNS, not the host's Ollama, not Postgres,
         n8n or the brain, not the internet or a cloud metadata endpoint,
         not the runner's own port. The runner's command sets these rules
         as the container starts, keyed on the emitter uids (nft), and then
         drops the capability to change them. The runner refuses to start
         if an emitter uid can reach a port of its on loopback (asked before
         it listens), or if it still holds that capability. A connect
         fails at once; a name lookup waits out the resolver's timeout
         (about 5 s) before it fails. The engine's kernel needs nf_tables
         (measured on podman, and in CI on Docker); without it the runner
         refuses to start, and says why, every 30 s. So does an engine whose
         user namespace does not map uids 20000–59999.
       - Never run the runner on the host's network (`--network host`, or a
         pod sharing the host's): its rules would go into the host's own
         ruleset and outlive the container, and its port and proxies would
         be open to every process on the host. compose.yaml never does.
       - A live-API emitter's pipeline names the hosts it needs:
         `"network": ["api.readwise.io"]` (port 443), or `"host:port"`.
         How the vendor's credential reaches the emitter is not decided
         yet (it is, with the first live-API recipe converted: SMD-2149,
         SMD-2021): the emitter's environment holds none. Do not put one in
         the emitter's argv (every uid in the container can read another's
         command line) or in a file under the imports directory (every
         emitter can read a world-readable one).
         The emitter reaches them only through a proxy the runner keeps
         for that pipeline, at `HTTPS_PROXY` in its environment, which
         Python's urllib and requests and Bun's fetch read. The proxy
         tunnels TLS (CONNECT) to a named host on its named port, and the
         tunnel's first bytes must be a ClientHello whose server name is
         that host, with no encrypted inner hello (ECH). A CDN that routes
         by server name then takes the tunnel to that vendor alone. What
         travels inside TLS is not read: a CDN that honours an HTTP Host
         unlike the server name (domain fronting, which the large CDNs
         refuse) could still carry it to another of its sites. Anything
         else is refused, and the run's report lists what was under
         `egress`, with the connections closed for 30 s of quiet before
         their tunnel opened and those past the proxy's 64 at once. An open
         tunnel lasts while both sides are open, and 30 s of quiet after
         either ends. `true` is refused: a pipeline cannot ask for the whole
         network. So is a host that names or resolves to a loopback,
         link-local or cloud metadata address (every address it resolves
         to is read); a private address is not refused, since a compose
         service has one. A named host must speak TLS: a plain-HTTP one
         (the host's Ollama, say) is cut off at its first bytes. The hosts
         are the operator's to choose; nothing reviews them yet (SMD-2211's
         checkpoint covers n8n's credentials, not these).
       - The ingester and reembed run as `bun` and keep the runner's
         network: Postgres and the model provider.
       - The container's init process keeps the two capabilities, which
         no emitter can reach. A `compose exec` as root gets the
         container's configured set, the two included, so an operator
         there can change the rules; the rules are set afresh each time
         the container starts.
     - A limit: every emitter can read every pipeline's exports that are
       world-readable. `deploy/imports/README.md` has how to keep one
       pipeline's to its own uid, on a host that enforces file modes.
       Docker Desktop and podman-machine do not. The runner is bounded to
       512 processes and 2 GB;
  2. refuses the whole batch if any line is not the pipeline's one source
     and scope;
  3. runs `db/ingest-records.ts --source items --items -` under the actor
     `orchestration-runner`, then `db/reembed.ts`, both as `bun`, without
     the runner's key.
     - reembed embeds every row the brain holds without a vector at its
       model, oldest first, not only this run's. That is normally just this
       run's. After a model switch it is the whole brain, and imports then
       run to their deadline for as long as that takes.
- **Success** means every row of the pipeline's source has a vector.
  reembed's own exit code (1 for any failed row in its job, or another
  pass's leases) does not decide it.
  - A row still pending is embedded by the next run.
  - A row the provider refused waits for a retry, run in the runner:
    `compose exec orchestration-runner su-exec bun bun db/reembed.ts
    --retry-failed`.
  - A row it refuses every time is an item to fix or remove in the export,
    and then its thought to delete.
  - When reembed refuses to run at all, the report quotes reembed's reason,
    and says which kind of refusal it is:
    - a model switch it was not told of, a width that does not match, or
      an egress policy refusing everything: no run embeds anything until
      that is fixed;
    - a provider that did not answer, or a start that met another claimer:
      the next run tries again.
  - The runner takes the server's model and egress settings when it is
    created. After changing them, recreate it with the servers: `compose up
    -d --force-recreate server api orchestration-runner`.
- **The deadline.** One run, emitter to reembed, is bounded by
  `OB1_RUNNER_TIMEOUT_S` (3600), the wait for another pipeline's reembed
  included. n8n waits that long and a minute more. The runner reads the
  knob at start, and provisioning reads it from `deploy/.env`. After
  changing it, recreate the runner (`compose up -d orchestration-runner`),
  then provision. A step past the deadline, or running when the runner is
  stopped or recreated, gets two SIGTERMs and then SIGKILL, so reembed hands
  back the rows it was holding.

The run's answer is the ingester's count line and the items it named
(skipped, stale, held). A URL's password in anything a step printed is
masked. Drop an export into the pipeline's directory and the next run
ingests it, and a rerun writes nothing. The export never passes through
n8n. The request names the pipeline and nothing else, so n8n's run history
holds the report, not the export. The report does name items by identity,
and a refusal can quote the value it refused.

The runner's key is a write capability bounded by the allowlist (the ADR's
decision 4, amended), and not a brain key. To change it, edit
`OB1_RUNNER_KEY`, recreate the runner (`compose up -d orchestration-runner`),
and provision, which patches n8n's copy.

**The runner's database role** (SMD-2289). The runner reaches Postgres as
`ob1_orchestration_runner`, not the superuser. It is a LOGIN role that is not
a superuser and owns nothing. It holds the grant groups its ingester and
reembed run, and no more: capture, worker, structure and extraction
(db/README.md, "Grants for a capturing role"). Not the server group, whose
writes to `ob1_agent_keys` could clear a key's revocation. It is a member of
no other role.
- The `orchestration-runner-role` step makes it, on the migrator's image and
  as the migrator connects, before the runner starts, on every `up`:
  `db/login-role.ts` creates the role or resets its password to
  `OB1_RUNNER_DB_PASSWORD` and clears an existing one's settings in every
  database, then `migrate.ts --grant --groups … --exact` replaces what its
  grants hold here with the groups' privileges (schema USAGE, CONNECT and
  TEMP stay) in one transaction, so a runner already running never meets a
  moment without them. A role neither will take is refused by name: a
  superuser, a member of another role, an owner, one with a schema of its
  name, or one holding a privilege a revoke there does not reach (a default
  privilege naming it, a grant in another database). `login-role.ts` commits
  first, so when `--exact` refuses, the new password is already set and the
  runner, if its config changed, is left created and not started.
- The step runs `migrate`'s image, by the name `migrate` gives it
  (`<project>-migrate`, never pulled), and never pulls or builds its own, so the build that brings a new migration (`up
  --build server` included) brings its grants to the step's next run; a
  release overlay pins it to the release's migrator. To rotate the password,
  edit `OB1_RUNNER_DB_PASSWORD` and start the profile again
  (`compose --profile orchestration up -d`).
- The runner's environment holds what its ingester and reembed read: the
  tier, the embedding, chunk and chat-blurb knobs, the provider's endpoints
  and credentials, the timeout and the egress gate. It does not hold the
  server's key material or its other knobs.

**Adding a pipeline.** A pipeline is a line in `pipelines.json` plus its
emitter, and the emitter has to be in the runner's image. For a converted
recipe, its conversion ships the pieces (SMD-2147–2150, SMD-2021):
1. the emitter under `recipes/<recipe>/`;
2. a `COPY` of it in `orchestration/runner.Dockerfile`, beside its pinned
   packages (the file shows the lines);
3. a `!recipes/<recipe>/<emitter>` line in the repo root's `.dockerignore`,
   which otherwise keeps `recipes/` out of every image;
4. its line in `pipelines.json`.

Then rebuild the runner (`compose up -d --build orchestration-runner`), put
the export in `imports/<pipeline>/`, and provision. A line whose emitter the
image lacks fails that build, naming the two files. An image started with
such a line refuses to start, which stops every pipeline, not just that
one: every door answers 502 until it is fixed.

**Removing a pipeline.** Take its line out, recreate the runner (`compose up
-d --force-recreate orchestration-runner`; a plain `up -d` sees no change
in a mounted file), and provision, which unpublishes its instance.

**Custody and backups.**
- **The owner password** is the profile's standing secret, stronger than the
  API key, since every mint signs in with it.
- **`N8N_ENCRYPTION_KEY`** encrypts every stored credential: lose it and they
  are unreadable. n8n also writes it into its volume
  (`/home/node/.n8n/config`), so a copy of the whole volume carries the key
  beside the credentials it protects. The copy below is the database alone.
  Keep the password, the key and the hash with `deploy/.env`.
- **n8n's store** needs keeping as well. The workflows are the templates, and
  an API-key credential comes back from `deploy/.env`. But an OAuth
  credential's refresh token (Gmail's) and each polling workflow's cursor
  live only in n8n's store.

The store is one SQLite file, and it can be copied while n8n runs. Here
`compose` stands for `podman compose -f deploy/compose.yaml --profile
orchestration`, or docker compose:

```bash
umask 077   # the copy holds run history (a capture's text) in the clear
compose exec -T n8n sh -c "rm -f /home/node/.n8n/backup.sqlite && node -e \"new (require('node:sqlite').DatabaseSync)('/home/node/.n8n/database.sqlite').exec(\\\"VACUUM INTO '/home/node/.n8n/backup.sqlite'\\\")\""
compose exec -T n8n sh -c 'cat /home/node/.n8n/backup.sqlite && rm /home/node/.n8n/backup.sqlite' > n8n-backup.sqlite
# restore: stop n8n first (compose stop n8n), then write the file as the image's
# own user, removing the old WAL, which SQLite would otherwise replay onto the copy
compose run --rm --no-deps -T --entrypoint sh n8n -c 'rm -f /home/node/.n8n/database.sqlite-wal /home/node/.n8n/database.sqlite-shm && cat > /home/node/.n8n/database.sqlite' < n8n-backup.sqlite
compose up -d --no-deps n8n
bun deploy/orchestration/provision.ts --rotate   # the copy brings back keys and credentials as they were then
```

Both shapes were measured, with the same `N8N_ENCRYPTION_KEY`: a restore
into a fresh volume, and one over a stopped n8n. The workflows and
credentials come back. So does every API key n8n held when the copy was
taken, including one revoked since, and every credential as it was then.
That is why the restore ends with a `--rotate` provisioning run: it revokes
the file's old keys and patches the credentials to the env file's current
keys. Two ways to lose the store: `compose cp` writes the file root-owned,
and n8n then opens it read-only; and a restore that leaves the old WAL in
place came back as "database disk image is malformed" (measured).

**After a compromise** (a leaked owner password or API key), a password
change revokes nothing by itself. Delete every key in n8n's Settings → n8n
API, change the password, run `--init`, recreate n8n (`compose up -d n8n`),
and provision with `--rotate`.

**Run history.** Each run's data is a copy of what the run carried: a
capture's text, an act tool's arguments. It sits outside `delete_thought`
and the brain's retention. The profile keeps it 24 hours or 1,000 runs
(`N8N_EXECUTIONS_MAX_AGE`, `N8N_EXECUTIONS_MAX_COUNT`); n8n's defaults are 14
days and 10,000. n8n marks runs past the window hourly, and deletes a marked
run's rows at its first 15-minute sweep an hour after that. So a run's rows
can outlive the window by up to about two and a quarter hours. Rows, not
bytes: SQLite may keep a deleted row's text in the file's free pages until
they are reused or the file is vacuumed, and a backup keeps whatever it
copied. The eval kit's P check proves the rows gone.

**Upgrades.** Take a backup (above) first: n8n migrates its store on the new
image, and nothing reverses that. Bump the digest deliberately, and re-run
the eval kit against the new image in two cycles. First
`bun evals/eval-orchestration.ts --up n8n`, then `--verify n8n
--wait-schedule`, then `--down n8n`. Then `--up n8n --with sealed`, then
`--verify n8n`, then `--down n8n`. The second is the egress probe, and the
one that catches a new image calling out. The endpoints that mint the key
and the run data the kit counts are not n8n's published contract. The kit
runs this profile as it ships (`../evals/README.md`, "The orchestration
profile (SMD-2210)").

**Licences** (the fork's reading, not legal advice; the ADR's Gate 1). n8n is
under its Sustainable Use License, OB1 under FSL-1.1-MIT, and an operator
running the profile is running two non-OSI licences side by side.
Installing an OB1 brain with the profile on a client's own infrastructure is
inside both: n8n's FAQ permits consulting and installing on a client's
server. Hosting the profile for others is outside n8n's licence. A
commercial product built on OB1 that competes with it is outside OB1's.

## Authorization server

OAuth for the brain (SMD-2285; `../docs/operator-surface-tiers.md`, decisions
13–16): oidc-provider 9.12.2 in a small Bun service of the fork's own
(`auth/server.ts`), which won the proof of concept (`../evals/README.md`). The
`auth` profile runs it. It publishes no port: the proxy routes `/auth` and
the three discovery paths outside it to it while it answers, and answers them
404 itself while it does not ("One origin", above). No service is its client
yet: the MCP server and the GUI become its clients with SMD-2286/2287. The
MCP server already sends clients to it (SMD-2382), a preview: at the public origin, while
this server answers its probe on the mesh, it serves the protected-resource
document and answers a keyless `/mcp` with the 401 challenge naming it.

Below, `compose` stands for `podman compose -f deploy/compose.yaml --profile
auth`, or docker compose, with whatever other `-f` files the stack was
started with. It assumes the stack of step 1: compose reads the whole of
`deploy/.env` for every service, so `POSTGRES_PASSWORD` and `MCP_ACCESS_KEYS`
must be set even to start this one.

```bash
# deploy/.env: OB1_PUBLIC_ORIGIN=https://brain.example.com (yours; --init does not write it)
#              COMPOSE_PROFILES=auth   (with any other profiles, comma-separated)
bun deploy/auth/provision.ts --init   # once: the profile's secrets into deploy/.env (it keeps every value it finds)
bun deploy/auth/provision.ts          # what the server would refuse, read from deploy/.env
compose up -d --wait --wait-timeout 60 auth server proxy   # builds and starts it, recreates the server on the new .env (it advertises OAuth only when configured), and waits
```

`COMPOSE_PROFILES=auth` in `deploy/.env` is the switch (ADR decision 16): the
server refuses to start without it, exit 2 naming it, so `--profile auth` on
the command line alone never puts it on the public origin. With it, every
`up` of the stack starts it. Two compose rules bear on that:
- a `COMPOSE_PROFILES` set in the shell beats the file's, both ways (the
  server reads what compose interpolated);
- a `--profile` on the command line replaces `COMPOSE_PROFILES` for that
  command, so `--profile local-models up` alone does not start this server.
  List every profile there instead (`--profile local-models --profile auth`).

`proxy` is named because a proxy from before SMD-1846's PR 2 has no `/auth`
route and is not on the mesh, and `up auth` alone would leave it so, with
`/auth` still answered by the MCP server; on a current stack it is a no-op.

`--wait` matters: a server that refuses its settings says why, exits 2 after
30 s and is restarted (the import runner's pattern: one restart each 30 s, not
a hot loop), and `up` without it returns 0 all the same. With it, `up` fails
at its `--wait-timeout` (measured: `application not healthy after 1m0s`, one
restart in that minute); the log names the setting. Stop the refusing one
with `compose stop auth` until it is fixed. It needs Docker Compose v2 or `podman
compose` backed by it, as the canary's section says; the Python
podman-compose has no `--wait`.

`--init` writes the signing key `OB1_AUTH_JWKS` (one P-256 key), two cookie
keys `OB1_AUTH_COOKIE_KEYS`, the operator's password
`OB1_AUTH_OPERATOR_PASSWORD` and its argon2id hash
`OB1_AUTH_OPERATOR_PASSWORD_HASH` (single-quoted, since compose would read
its `$`s as variables), and a secret `OB1_AUTH_SECRET_<ID>` for each static
client: the GUI's, each tier's MCP server's and each service's. It writes
only what the file lacks, so run it again after adding a tier to
`OB1_AUTH_TIERS` or a service to `OB1_AUTH_SERVICES`. Once the hash is
written you may keep the password elsewhere and remove its line: `--init`
then keeps the hash. It warns when anyone but you may read or write
`deploy/.env` (`chmod 600` it). A password holding `#` or `$` goes on a single-quoted
line (`OB1_AUTH_OPERATOR_PASSWORD='…'`), and no password may hold a `'`, which
compose cannot read inside single quotes (and then reads none of the file).
Unquoted, the script that hashes it
keeps a ` # note` as part of the password, and compose reads every `$` in
the file as a variable, so `--init` and the check refuse such a line. The container is given
the hash, never the password, and none of the rest of `deploy/.env`. To
change the password, edit it, run `--init` (which re-derives a hash that no
longer matches), and recreate the service with `compose up -d --wait auth`; a
`compose restart` keeps the old hash.

The server checks every setting at start and, if any is missing or
malformed, exits 2 naming them all; the restart policy brings it back and
its log (`compose logs auth`) says why each time. `OB1_PUBLIC_ORIGIN` must be
an origin alone, `https://`, or `http://` on a loopback host. A service
client named in `OB1_AUTH_SERVICES` needs its secret's line added to the
`auth` service's environment in `deploy/compose.yaml`, since compose cannot
pass a variable it does not name: `provision.ts` says which line.

**Its state** — sessions, grants, refresh tokens and dynamically registered
clients — is one SQLite file in the `auth-data` volume, so a restart keeps
it, and so does an upgrade, which rebuilds and recreates the container. The server holds
no Postgres credential and shares no network with Postgres (SMD-2583). On a stop it finishes
what is in flight, closes the store and exits. The library's in-memory store,
which the proof of concept first ran on, forgot all of it at every restart.

**Registration** is open, as MCP clients expect: claude.ai and Claude Code
register themselves before anyone signs in. It is bounded two ways:
- **A cap.** The store holds at most `OB1_AUTH_MAX_CLIENTS` registered clients
  (200 unless set), counting registrations still under way. Past it, a
  registration is answered 503 `temporarily_unavailable` until room frees,
  however its path is spelled (the library takes any case and a trailing
  slash). The static clients (the GUI,
  the MCP servers, the services) are configuration, not rows, and a client
  named by a metadata document is never stored, so neither counts.
- **A purge**, once the server is listening and then hourly. A registered
  client goes once it is a day old and nothing of its own (a grant, a code, a
  refresh token, a sign-in under way) has been alive for a day: an abandoned
  sign-in's, or one registered for the sake of it. Rows that expired go a
  day after. The log says what each pass removed. A pass over 100,000
  clients and 300,000 grants took under half a second on an Apple M5 Pro,
  with the server answering nothing meanwhile (`bun:sqlite` is synchronous);
  a slower host or larger rows take longer.

A sign-in's grant lasts 30 days from consent, used or not, and a refresh
token at most 14; the registration stays while any grant or refresh token of
the client is alive, and a day after. A client then finds its `client_id`
unknown, and what it does next is the client's. The MCP TypeScript SDK
registers again when a refresh is answered `invalid_client` and the app
around it supports forgetting its client; a client with no refresh token
meets an unknown-client page at sign-in, and its app must forget the client
to register afresh.

**Abuse limits** (SMD-2309), kept in memory (a restart forgets them), in
two layers. Each refusal is a 429 (the cap above keeps its 503), with
`Retry-After` where waiting helps (a spent sign-in starts again instead).

Always on, and safe when every client looks like one address, as behind a
host tunnel:
- **Password checks** across every client: ten at once, then one a second.
  A right password gives its check back, so only wrong ones spend it. Past
  it the sign-in page asks for a moment. A guesser gets about 3,600 tries an
  hour, but a flood of them holds the right password off too while it lasts:
  nothing outlasts the flood, and the loopback sign-in that answers one is
  SMD-2286's.
- **Each sign-in** takes five wrong passwords, then must start again from the
  app.
- **Registration** has the cap and the idle purge above.

Per address, only with `OB1_AUTH_TRUSTED_PROXY` set to the proxy in front (a
host name or address). A request from that proxy is the client whose
`X-Forwarded-For` entry sits `OB1_AUTH_FORWARDED_HOPS` from the right (1
unless set); a request from anyone else is its own connection's address, so
no header can pick one. A request with no such entry gets only the limits
above, and an IPv6 address counts by its /64. An address that wins password
checks in a flood is locked out after six, so one address cannot hold them.
- **Sign-in:** five wrong passwords are free; each one after locks the address
  out for a minute, doubling, at most fifteen. The right password clears it.
- **The token and revocation endpoints:** twenty failed authentications of
  one client from one address in fifteen minutes refuse that client from
  there until the oldest falls out; another client from the same address is
  untouched, so one connector failing behind a platform's shared egress
  refuses no other. Only a request that presented a secret or an assertion,
  for a client that exists and holds a secret, counts.
- **Registration:** `OB1_AUTH_REGISTRATIONS_PER_HOUR` clients an hour (30
  unless set), so no one address fills the cap. A platform that registers
  from a shared egress shares its hour too: thirty registrations there stop
  your next connect through it until the oldest is an hour old.

While the name does not resolve, the per-address limits are off and the log
says so every five minutes. Compose's `proxy` shares `mesh` with `auth`, so
`OB1_AUTH_TRUSTED_PROXY=proxy` resolves.

Leave `OB1_AUTH_TRUSTED_PROXY` unset unless the proxy's entry is each
client's own. Compose's proxy trusts no forwarded header; it takes the
client's address from the forwarder's PROXY protocol line (SMD-2583), so with
one hop the entry is the address the forwarder's port saw: each client's
when the published port faces clients directly (a Linux host's port
forwarding keeps the source), but one address for everyone behind a host
tunnel (cloudflared, `tailscale funnel`, caddy) or a port forwarder that
rewrites the source (rootless podman on macOS showed every client as its
gateway, measured). A lockout there is everyone's. The proxy trusts that line
from the private ranges, so anything inside the stack that reaches its port —
the mesh's servers and the authorization server — could name another
address, and so could a process on a Linux host itself: an internal network's
gateway is a bridge address on the host, inside the private ranges, and the host
dials a container on one from it though no port is published (rootful podman,
measured). Only these per-address limits read it. Two hops need the tunnel to write its client into
`X-Forwarded-For` and the proxy to trust that header (Traefik's
`forwardedHeaders.trustedIPs`, which compose does not set); a tunnel that
passes the header through unwritten lets the client name entry 2. A password from `--init`, or one of 12 characters
or more, is what holds against many addresses guessing; the loopback
break-glass sign-in is SMD-2286's. The proxy in front sets no rate limit of
its own, by design ("No rate limits on `/mcp`, by design" above).

**Custody and backups.**
- **The signing key** signs every token the server issues: a new key
  invalidates them all, and a lost one cannot be recovered.
- **The client secrets** are shared with each client; a new one locks out
  every client holding the old one.
- **The password** is the operator's sign-in on the public origin.

Keep all of them with `POSTGRES_PASSWORD` in `deploy/.env`'s backup. The
store is worth keeping too, but losing it costs a sign-in, not data: every
client registers and asks for consent again, and nothing in the brain
changes. It can be copied while the server runs:

```bash
umask 077   # the copy holds refresh tokens and sessions
compose exec -T auth bun -e "const { Database } = require('bun:sqlite'); require('node:fs').rmSync('/data/backup.sqlite', { force: true }); new Database('/data/auth.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\")"
compose exec -T auth sh -c 'cat /data/backup.sqlite && rm /data/backup.sqlite' > auth-backup.sqlite
# restore: stop the server first (compose stop auth), then write the file as the
# image's own user, removing the old WAL, which SQLite would otherwise replay onto the copy
compose run --rm --no-deps -T --entrypoint sh auth -c 'rm -f /data/auth.sqlite-wal /data/auth.sqlite-shm && cat > /data/auth.sqlite' < auth-backup.sqlite
compose up -d --wait --no-deps auth
```

A restored store brings back every grant and refresh token as it was when
the copy was taken, including any revoked since. After a compromise, remove
every `OB1_AUTH_*` line from `deploy/.env` but `OB1_AUTH_TIERS` and
`OB1_AUTH_SERVICES` (the signing key, the cookie keys, the password, its hash
and the client secrets; a kept password would be hashed again as it was),
run `--init` for new ones, hand each client its new secret, and drop the store
(`compose rm -sf auth`, then `podman volume rm <project>_auth-data`, or
`docker volume rm`; `open-brain_auth-data` for the stack of step 1) before
`compose up -d --wait auth`: every client signs in again. Both shapes were measured:
the backup above restored into a fresh volume brings a registered client back
with its registration token, and the fresh volume alone does not.

**Upgrades.** The service is built from the checkout, so after pulling a new
one rebuild it: `compose up -d --build --wait auth`. A plain `up` keeps the
old image. oidc-provider is pinned exactly (`auth/package.json`). A bump
re-runs the proof of concept against the new image
(`bun evals/eval-auth.ts --up oidc-provider`, then `--verify`); CI's auth-poc
job does the same.

**A preview until SMD-2286.** With the profile on, the MCP server
advertises OAuth at the public origin, and a claude.ai connector at `/mcp`
is asked to sign in here, `?key=` ones included. A `?key=` connector is
served once through, since its key authenticates before the token; one with
no key is not, since the MCP server accepts no token yet: it answers
`invalid_token`, and the client signs in again. Only the operator can sign
in today, so leave the profile off where others' claude.ai connectors must
keep working; turning it off again makes the document a 404, and they
proceed on the key.
Not yet: passkey sign-in, which needs the public origin (SMD-2382,
SMD-2286), and the MCP server and the GUI as this server's clients
(SMD-2286, SMD-2287). The release overlay does not pin an image for it yet,
so the profile builds from a checkout.

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
- **Upstream's Edge Function on Supabase passing checks 2, 3 and 4.** There the API gateway
  answers the OAuth discovery path with 401 before the function sees it, so check
  2 fails there — and the failure is real: the claude.ai connector will not open
  against that deployment either (upstream
  [#340](https://github.com/NateBJones-Projects/OB1/issues/340); FORK.md change 42).
  Checks 3 and 4 fail too: upstream's Edge Function build has no method guard, so
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
  worker with a per-thought model cost, so it runs as a service only when asked:
  the `workers` profile runs it and `db/consolidate.ts --follow`, the pass that
  proposes supersessions from the entities it extracts ("Extraction and
  consolidation as services", above). Decide on the cost before you ask for it.
  A follower exits 0 when stopped, so watch its log: it says there when the
  model looks at fault, after each pass drains the pool. A follower started on
  a backlog says nothing until the backlog is done, so try a new model on a
  working copy with `--limit 48` first (SMD-2266, `db/README.md`; on the brain
  itself a new model is a new key, "Changing the model" above). It waits out
  a database restart, a provider outage or a model being pulled, and says so
  in its log, rather than exiting or failing the thoughts it holds
  (SMD-2599); a model the provider does not serve at start is refused with
  exit 2. Reviewing what consolidation proposes stays a person's job.
- **Auth.** Still a single shared key, in a header or `?key=`. Moving off Supabase
  does not improve that; see [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).
  The `auth` profile's authorization server runs behind the proxy's `/auth`,
  but no service is its client yet, and a claude.ai connector's sign-in there
  is a preview ("Authorization server", above).

## Related

- `../db/` — the schema and its migration runner
- `../server-portable/` — the server, and `preflight.ts`
- `../FORK.md` — what this fork changes and why
