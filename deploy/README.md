# deploy — the compose stack

The brain is `compose.yaml`: the forwarder and proxy in front, the REST core,
the MCP server at `/mcp`, the operator GUI, Postgres and the migrator, and the
profiles beside them, each an ordinary piece of infrastructure
you run, with its settings in an env file. This directory is the smallest
working arrangement of them. It is a reference, not a production topology: no
TLS, no backups, no resource limits.

## Prerequisites

- podman or docker, with Docker Compose v2.23.1 or later (`docker compose`, or
  what `podman compose` runs when it is installed): the proxy's route table is
  an inline `configs:` entry, which older compose does not read, and the Python
  podman-compose refuses the file (1.6.0: `missing networks: default`)
- To build the images from a checkout (`up --build`): Docker Engine 25 or later,
  or podman 5.1 or later — the server's Dockerfile sets its healthcheck's
  `--start-interval`, which older builders refuse (SMD-3194). A release install
  pulls the images and needs neither
- A model provider: the stack's own Ollama (`--profile local-models`, one line to
  set: `OB1_LLM_LOCAL=1`), an Ollama on the host, or an OpenRouter key — the shipped defaults are
  local; `deploy/.env.example`, "Model provider", is the one line to choose

## Steps

### 1. Configure

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24                                    # → POSTGRES_PASSWORD
bun server-portable/keygen.ts --name laptop --scope write   # → a line for MCP_ACCESS_KEYS; keep the key
bun server-portable/keygen.ts --name mcp-forwarder --scope forward   # → a line for MCP_ACCESS_KEYS too, its key OB1_FORWARDER_KEY
```

`MCP_ACCESS_KEYS` takes both lines, comma-separated. The second is the MCP
server's own forward key (SMD-2287), required: compose refuses the stack
without `OB1_FORWARDER_KEY`.

`deploy/.env` is gitignored. Its values are ordinary environment variables,
which a platform's secret store can supply instead.

### 2. Bring it up

```bash
# the check first: up runs only when it passes
bun --no-env-file deploy/instance.ts check -f deploy/compose.yaml --profile local-models &&
  podman compose -f deploy/compose.yaml --profile local-models up --build
```

`instance.ts check` renders the stack as compose will: the same env files, `-f`
files, profiles and project name (`--env-file`, `-f`, `--profile` and `-p` as
for compose). With no `--env-file`, it reads `COMPOSE_ENV_FILES`, else the
`.env` beside the first compose file, as compose does; a `COMPOSE_FILE` in the
env file or the shell needs the same files given with `-f`. It runs only under
`bun --no-env-file`, and never beside a Bun `--env-file`, since Bun would load a
`.env` in the working directory into the check, where compose reads it as the
shell's; otherwise it refuses, naming the command.

It refuses an env file whose project was made from other env files (the ones
compose records for `--env-file` or `COMPOSE_ENV_FILES`, or the project
directory's `.env` where none was given), since that `up` would recreate the
other brain's containers with this file's settings; an env file that only moved
is recreated from with `up -d --force-recreate`. Then, for each host port the
brain would publish, it says whether the port is free, already the same
service's own, or held: by another brain's container (a stopped one included,
which takes its port back when it starts; Docker's read from its port bindings),
by another of this brain's services, by a second mapping of this brain's, or by
a process on the host. A port this brain's service holds now is its own (a
stopped container that also asks for it is named); a port its stopped service
will take back is tried first, in case a process took it meanwhile. A refusal
names the setting to change (`SERVER_PORT`, and the others "One env file is one
brain" lists).

It only reads, so it is safe beside a running brain: run it before every `up`.
Each line is `✓` (free, or this brain's own), `✗` (a refusal, naming what to
change), `?` (unknown: a stopped container's ports could not be read) or `·` (a
note). Any exit but 0 means do not `up`: 2 is a refusal, a usage error or
compose's own. It never prints compose's words, which can quote an env file's
values: it says what failed from a line number, a setting's name and its own
reading of the files (a quote left open, a port that is none), and names the
`compose … config --quiet` command that prints them.

It reads every container runtime on the PATH, docker and podman both
(`--runtime` names one). Where compose's own bind failure, at the end of an
`up`, names no setting, its refusal names the one to change (SMD-2873).

The profile is the stack's own Ollama, where the server's model endpoint
defaults; drop it when `deploy/.env` names another provider (an Ollama on the
host, OpenRouter — `.env.example`, "Model provider"). Without either, the server
container refuses to start: preflight dials an endpoint whose name is local once
(`GET /models`, 2.5 s) and its `provider endpoint` row fails on the `ollama` name with nothing
behind it, naming the profile, the two host aliases and a hosted provider as the
ways out (SMD-1875). Before that row the name counted as local and was not
dialled, so the stack came up `preflight OK` and the first capture failed on it
(`getaddrinfo ENOTFOUND ollama`) with the server log ending at `Started server`.
A name that resolves with nothing answering yet is the other case: an Ollama
on the host not started yet, or the profile's `ollama` container started and
not yet listening (one not started at all is a name that does not resolve,
and still fails). The row warns, and
the server starts degraded: captures land without their vectors, searches
answer by exact matches, and keyed `/health` (`provider.status`, `since`) and
`brain_info` (its `Provider` row, `unreachable since …`) say so. It
re-probes every `OB1_PROVIDER_REPROBE_INTERVAL` seconds (15) and leaves
degraded when the provider answers, with no restart (SMD-2890).

The services, in order, the last two with the profile:

| Service | What it is |
| --- | --- |
| `postgres` | The brain's database, Postgres with pgvector (`pgvector/pgvector:0.8.6-pg16`) |
| `migrate` | The `ob1-migrate` image (`db/Dockerfile`): runs `db/migrate.ts`, then exits |
| `api` | The REST core: every operation, as JSON, over Postgres and the model provider; internal unless opted in (SMD-2284). It builds the server image, which `mcp` and `app` run; `server`, the MCP server `server-portable/index.ts` was, built it until SMD-2287 PR 6b retired both |
| `mcp` | The MCP server at `/mcp`, a client of the REST core, on the mesh alone (SMD-2287) |
| `app` | The operator GUI at `/dashboard`, a client of the REST core, on the mesh alone (SMD-2280; `dashboard/README.md`) |
| `proxy` | The stack's one origin, with the MCP server at `/mcp` on it ("One origin" below) |
| `forwarder` | The stack's one published port, in front of the proxy, which is on internal networks alone (SMD-2583) |
| `ollama` (profile) | The stack's own model endpoint: `OB1_LLM_BASE_URL` defaults to `http://ollama:11434/v1`, unless the env file names another provider |
| `ollama-pull` (profile) | Pulls both models; runs once, then exits |

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
of the proxy (the forwarder's, SMD-2583), and `/mcp` the MCP server's path on it. A client configured before SMD-1846 at the
root (`http://127.0.0.1:8000/?key=…`) stopped working at v2.0.0, when the
proxy's legacy route went (SMD-2532): give clients `/mcp` ("Moving a client to
/mcp").

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

The stack above builds the server image (as `api`) and `migrate` from the checkout, pins
`postgres` and `ollama` by tag (`ollama`'s is the one `x-ollama-image` anchor in
`compose.yaml`, shared by `ollama-pull`), and `proxy`, `forwarder`, `n8n`, `lgtm` and `pg-exporter` by digest in
`compose.yaml` itself, which the overlay leaves as they are. A release pins everything: the job
`.github/workflows/release.yml` (SMD-1860) runs on the tag a cut is named by —
`v<X.Y.Z>`; [`FORK.md`](../FORK.md) "Versioning" has the scheme and the cut —
publishes the two images to GHCR, `ghcr.io/mharris-sgymd/ob1-server:<X.Y.Z>` and
`ghcr.io/mharris-sgymd/ob1-migrate:<X.Y.Z>` for linux/amd64 and linux/arm64, and
creates the GitHub release with a compose overlay that names the two by tag and
digest and `ollama` by the digest its tag resolved to when the job ran, beside
`compose.yaml`, `.env.example`, `compose.api-public.yaml`, `compose.hooks-public.yaml`, `compose.grafana-public.yaml` and `compose.grafana-port.yaml` from the same tag, the change files the release
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
curl -fsSLO https://github.com/MHarris-SgyMd/OB1/releases/download/v<X.Y.Z>/compose.grafana-port.yaml   # optional: Grafana on 127.0.0.1:3000, another -f ("The observability profile" below)
curl -fsSLO https://github.com/MHarris-SgyMd/OB1/releases/download/v<X.Y.Z>/compose.grafana-public.yaml   # optional: Grafana at /grafana on the stack's origin, another -f (the same)
# fill in .env as step 1 says, minting its keys with the release's own image (no checkout needed):
docker run --rm --entrypoint bun ghcr.io/mharris-sgymd/ob1-server:<X.Y.Z> keygen.ts --name laptop --scope write          # its line in MCP_ACCESS_KEYS; keep the key
docker run --rm --entrypoint bun ghcr.io/mharris-sgymd/ob1-server:<X.Y.Z> keygen.ts --name mcp-forwarder --scope forward   # its line in MCP_ACCESS_KEYS too, the key OB1_FORWARDER_KEY
# then:
docker compose -f compose.yaml -f compose.release.yaml pull
docker compose -f compose.yaml -f compose.release.yaml up -d --wait   # --profile local-models on both for the stack's own Ollama
```

`up` without `--build`: `compose.yaml`'s `build:` stays under the overlay and is
used only when asked, so a pinned stack never rebuilds behind the overlay's back.
The server's log carries preflight's row for the brain the release's migrator
wrote — `schema version   <X.Y.Z> · highest migration NNN` (a release before 2.0.0
prints `<X.Y.Z>+upstream.<sha>`) — and
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

## One env file is one brain

A brain is its env file (SMD-2873, under the one-brain-per-stack decision,
[`docs/one-brain-per-stack.md`](../docs/one-brain-per-stack.md)). Any number run
on one machine, each from its own file, all from the one `compose.yaml`:

- **`COMPOSE_PROJECT_NAME`** names it. Unset, the project is `compose.yaml`'s
  `name:`, `open-brain`. The value in the env file wins over that, as the shell's
  and `-p` do. Everything the project makes carries its name: containers are
  `<project>-<service>-1`, networks `<project>_data`, `<project>_egress` and
  the rest, the database volume `<project>_pgdata`, and the server image
  `<project>-server`. Two instances share no network, volume, image tag or
  container name (measured, the decision's "Measured").
- **Its own secrets**: a `POSTGRES_PASSWORD` and `MCP_ACCESS_KEYS` of its own
  (step 1). A key opens only the brains whose `MCP_ACCESS_KEYS` lists its hash.
- **Its host ports.** These are the only thing two instances collide on. With no
  profile that is the forwarder's, `SERVER_PORT` (8000; `SERVER_BIND`
  127.0.0.1). Each profile or overlay an instance runs adds its own:
  - `N8N_PORT` for `--profile orchestration`;
  - `POSTGRES_PORT`, `OLLAMA_PORT` and `JEV_PORT` for `compose.host-ports.yaml`,
    each with its `_BIND`.

  Set each one in the second instance's file. `bun --no-env-file
  deploy/instance.ts check --env-file deploy/.env.<name>.local -f
  deploy/compose.yaml`, with the same `-f` files and `--profile`s as its `up`,
  says before that `up` which one is still taken, and by what; compose's own
  bind failure names no setting.

A second brain beside the first:

```bash
cp deploy/.env.example deploy/.env.ob1b.local   # .env.*.local: the root .gitignore ignores it
# deploy/.env.ob1b.local: its own POSTGRES_PASSWORD and MCP_ACCESS_KEYS, as in step 1, and
#   COMPOSE_PROJECT_NAME=ob1b
#   SERVER_PORT=8040
bun --no-env-file deploy/instance.ts check --env-file deploy/.env.ob1b.local -f deploy/compose.yaml &&
  docker compose --env-file deploy/.env.ob1b.local -f deploy/compose.yaml up -d --build
OB1_SMOKE_KEY=<ob1b's key> ./deploy/smoke.sh http://127.0.0.1:8040/mcp
```

Name an instance's file `.env.<name>.local`, the form the root `.gitignore`
ignores (it does not ignore `.env.<name>`); the fork's checks refuse a tracked
env file.
`--env-file` replaces `deploy/.env` for that command, so give it on every
compose command for that brain: `ps`, `logs`, `down` and the rest. A canary's
env file names the canary's project, port, address, tier and profiles
(SMD-2874), but the refresh and its checks are `canary.sh`'s: stand it up and
take it down with `canary.sh`, and give compose its file only to look (`ps`,
`logs`). The scripts
take the brain the same way:
- `deploy/canary.sh --env-file deploy/.env.ob1b.local --port 8021 up` stands `ob1b`'s canary. Its
  project is `ob1b-canary`, its connector `ob1b-canary`, and its env file
  `.env.ob1b-canary.local`. `--stable-project` overrides the project the env
  file names.
- `deploy/tier.sh --env-file deploy/.env.ob1b.local` joins `ob1b_data` and
  builds its image as `ob1b-tier`. `--project` overrides the project, and
  `--network` names the network outright.

**Local models.** An instance on `--profile local-models` runs its own Ollama
and `ollama` volume, so both models are pulled, and held in memory, once per
instance. The alternative is one Ollama on the host that every instance names
(`deploy/.env.example`, Option B):
- Under podman machine, a container reaches the host's loopback, so `ollama
  serve` on its 127.0.0.1 default serves every instance (measured).
- On Docker on Linux, a container does not reach a port the host binds to
  loopback, so that Ollama must listen on the bridge address (SETUP.md) or on
  every interface. The second exposes it on the LAN.

## Several brains behind one edge

The edge proxy (SMD-2876) puts several brains behind one port, each at a host
of its own: `http://<name>.localhost:8090/mcp`, or `<name>.<domain>` with the
registry's `edge.domain`, a name under `localhost`. curl and browsers resolve
`*.localhost` to loopback themselves. Bun and most other programs ask the
system's resolver, which answers it on macOS and under systemd-resolved. On
another Linux resolver, give each name a hosts line (`127.0.0.1
stable.localhost`), or the name goes to upstream DNS. The edge is a compose
project of its own, `ob1-edge` (`deploy/edge/`). It reaches each brain
through the brain's published port, as any client on the host does, and
joins no brain's network. Each brain is served at the root of a host of its
own. Access keys pass through; sign-in waits for TLS at the edge (below).

```bash
cp deploy/edge/brains.example.yaml deploy/edge/brains.local.yaml   # ignored by git
# deploy/edge/brains.local.yaml: each brain by name, with the port it is published on
bun --no-env-file deploy/edge/edge.ts check  # the shape, what publishes each brain's port, the URLs; starts nothing
bun --no-env-file deploy/edge/edge.ts up     # renders the table, picks the shape, starts the edge
bun --no-env-file deploy/edge/edge.ts down
# a client of one brain through the edge, with that brain's own key:
claude mcp add --transport http stable http://stable.localhost:8090/mcp --header "x-brain-key: <stable's key>"
```

A brain's port is its env file's `SERVER_PORT`: 8000 unless set, or 8010
for the dogfood stack. A canary's is the `--port` that `deploy/canary.sh`
was first given, which it keeps in the canary's env file.
`check` names the container that publishes each port, so a registry that
swaps two ports, which would send one brain's key to the other, shows up
there.

- **Each brain still answers on its own port**, and keeps its own keys. The
  edge holds no key. A client's `?key=` or `x-brain-key` header passes
  through unchanged to the brain the host names.
- **Any 502 becomes a bare 404 on that brain's host alone.** That covers a
  brain that is down, and also a running brain whose own proxy answers 502,
  such as while its server restarts. An unknown host gets the edge's 404.
- **The edge deletes `X-Brain-Forwarder` and `X-OB1-Legacy-Route`** from each
  request. A brain's proxy treats the first as its own, and a v1.x brain's
  server read the second as its legacy route's (a v2.0.0 brain ignores it);
  the edge deletes it for the older brains it can front.
- **Sign-in (OAuth) is not served through the edge yet. Keys are.** Each
  brain's host on the edge would be its origin, with its challenge, its
  discovery documents and its authorization server its own. But MCP SDK v2
  and Claude Code send a token request over plain HTTP only to exactly
  `localhost`, `127.0.0.1` or `::1`, never to a name under `localhost`. This
  was measured on MCP SDK v2, and the same rule is read in Claude Code
  2.1.301's bundle. Sign-in at `<name>.localhost` therefore needs
  TLS at the edge (SMD-3053). A token is accepted at `/mcp`, which
  `mcp-server/` serves since SMD-2287 PR 5b, trading it at the hop
  (SMD-2286); the brain's origin will then be its host on the edge.

  Until then, a brain running the `auth` profile keeps its
  `OB1_PUBLIC_ORIGIN`. Since the edge's host is not its origin's, through the
  edge its `/mcp` answers keys alone: a call with no key gets the server's
  refusal (JSON-RPC -32001), not a sign-in. Its `/auth` paths still answer
  through the edge, by path, naming its own origin.
- **The authorization server's per-address limits see the edge's address**
  for every client that comes through the edge. One client's failed
  authentications at a brain's `/auth` through the edge therefore lock out
  every client behind the edge for the lockout's length.
- **The domain is `localhost` or a name under it.** The edge listens on
  loopback alone. Under that domain, the resolvers that follow RFC 6761 answer
  loopback themselves, where a public name would send a client's key off the
  machine over plain HTTP. A Linux resolver that doesn't follow it needs the
  hosts lines above.
- **Two shapes**, because no one binding reaches a brain's loopback port from
  a container on both runtimes (measured;
  [`docs/one-brain-per-stack.md`](../docs/one-brain-per-stack.md)):
  - **Under a rootful podman machine** (`podman machine inspect --format
    '{{.Rootful}}'`), the edge is a container that publishes
    `127.0.0.1:<port>` and dials each brain at `host.containers.internal`.
    podman publishes a port on one loopback only, so `[::1]:<port>` is left
    to anything else. A client asking for `<name>.localhost` tries `::1`
    first, so `check` and `up` refuse while something answers there.
  - **On Docker Engine on Linux**, it runs on the host's network, listens on
    both 127.0.0.1 and `[::1]`, and dials each brain at 127.0.0.1. Its
    healthcheck's ping is on `edge.ping_port`. A host with IPv6 turned off
    has no `[::1]`, so `check` and `up` refuse there, saying so.

  `edge.ts` picks the shape from the runtime. Every other runtime is refused
  until `--shape bridge` or `--shape host` names one: a rootless podman
  machine, a rootless engine, podman on Linux, and Docker Desktop.
  `--shape host` under podman machine is refused outright, since it was
  measured unreachable from the Mac. Docker Desktop has no known working
  shape. Its containers name the host `host.docker.internal`, not the bridge
  shape's name, and a host-network container there listens inside its VM,
  out of the Mac's reach.
- **`up` checks that the table is served.** The table has a probe route of
  its own, `_edge.<domain>`, which no brain's name can take and which
  answers 418. Until that route answers, `up` treats the table as not
  loaded. In that case it recreates the edge once, and then fails, naming
  the log. It never asks a brain, so a brain that is down doesn't fail `up`.
- **Changing the registry:** `up` again. The table's digest is a label on
  the edge's container, so a changed table recreates it.

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
- `mesh`, internal: the proxy, the MCP server, the REST core, the
  authorization server and the observability profile's collector, each called
  by its `*.ob1.internal` name. No other project joins it: a canary runs on
  networks of its own (SMD-2874).
- `data`, internal: Postgres, and only what connects to it — the migrator,
  the two servers, board-sync, the workers, the sleep scheduler, the import
  runner and its role's one-shot, and the observability profile's exporter
  and its role's one-shot. No other project joins it.
- `egress`, outward: whatever calls a model provider or a vendor (the two
  servers, board-sync, the workers, the sleep scheduler, the import runner,
  n8n), and the stack's
  own Ollama and Jev, which fetch their weights there and are called there by
  name.
- `auth-egress`, outward: the authorization server's alone.
- `front`, internal: the forwarder, the break-glass listener and the proxy
  alone, where each reaches the proxy as `proxy.ob1.internal`.
- `telemetry`, internal: the observability profile's collector and its
  Postgres exporter alone, where the collector scrapes it as
  `pg-exporter.ob1.internal` (SMD-1849 PR 3b).
- `edge`, outward: the forwarder's and the break-glass listener's alone,
  where their ports are published. The proxy is on internal networks alone (`front` and `mesh`),
  so a name it looks up that nothing holds is never asked of the host's
  resolvers.

An internal network has no route out, and a container on internal networks
alone publishes no port, so `compose.host-ports.yaml` gives Postgres one more
network of its own, `postgres-port`, for its loopback port, and
`compose.grafana-port.yaml` the observability profile's Grafana one,
`grafana-port`; each reaches out.

| Service | On the stack's networks | On the host | From another machine |
| --- | --- | --- | --- |
| `forwarder` | Listens on 8000, on `edge`, and dials the proxy alone, as `proxy.ob1.internal` on `front`, at an address on `front` and no other; it opens each connection with the PROXY protocol's line naming the client (SMD-2583) | `127.0.0.1:${SERVER_PORT:-8000}` — the stack's only published port but the break-glass port under the `auth` profile and n8n's under `--profile orchestration`; the MCP server is `/mcp` on it ("One origin" below) | Through a TLS proxy or tunnel. One on this host dials `127.0.0.1` and needs no knob; only a proxy on another machine needs `SERVER_BIND=0.0.0.0` in `deploy/.env`, and then the key rides every request in clear until the proxy |
| `breakglass` (`--profile auth`) | Listens on 8001, on `edge`, and dials the proxy's `breakglass` entrypoint alone, `proxy.ob1.internal:8001` on `front`, as the forwarder dials `web` — the forwarder's script, `--port 8001`. That entrypoint routes `/dashboard` alone, marked `X-OB1-Listener: breakglass`, which the `web` entrypoint deletes from every request on the origin (SMD-3307) | `127.0.0.1:${BREAKGLASS_PORT:-8001}`, a literal loopback with no `_BIND` knob: the operator GUI's key sign-in while the stack is configured, the authorization server up or down (`dashboard/README.md`, "Signing in") | Never: no tunnel or proxy points at it, and the operator signs in on the brain's machine |
| `proxy` | `proxy.ob1.internal:8000` on `front`, which the forwarder dials, and `proxy:8000` on `mesh`; its break-glass entrypoint listens on 8001 on both, which the break-glass listener dials on `front` (the mesh's servers reach it too, as they reach the GUI itself); it dials every backend on the `mesh` network, by a name resolved with no search domains: the MCP server (`mcp`) as `mcp.ob1.internal:8000`, the operator GUI (`app`) as `app.ob1.internal:8000`, `auth.ob1.internal:3000`, and — with `compose.api-public.yaml` named — `api.ob1.internal:8000`, and with `compose.grafana-public.yaml` `lgtm.ob1.internal:3000` | Nothing of its own: the forwarder's port, and under the `auth` profile the break-glass port | Through the forwarder, or on this machine the break-glass listener |
| `mcp` | `mcp.ob1.internal:8000` on the `mesh` network alone — the proxy. It dials the REST core as `api.ob1.internal:8000` and, on a stack configured with the authorization server, `auth.ob1.internal:3000` to trade a token, both on the mesh: no Postgres, no model provider, nothing outward (SMD-2287) | Nothing of its own: `/mcp`, `/health` and the protected-resource document on the proxy's port | Through the proxy |
| `app` | `app.ob1.internal:8000` on the `mesh` network alone — the proxy. It dials the REST core as `api.ob1.internal:8000` with each visitor's own key: no Postgres, no model provider, nothing outward (SMD-2280) | Nothing of its own: `/dashboard` on the proxy's port, and under the `auth` profile on the break-glass port. With `OB1_PUBLIC_ORIGIN` set, sign-in through the proxy works at that origin only, not here, nor through the edge proxy's host for the brain | Through the proxy; behind TLS, set `OB1_PUBLIC_ORIGIN`, or its sign-in form is refused, its origin not the one the GUI reads (`dashboard/README.md`, "The origin") |
| `api` | `api.ob1.internal:8000` on the `mesh` network, and `api:8000` on `data` and `egress`, which every container there can reach — a key is still required for anything but `/health` and `/openapi.json`. It dials `postgres:5432` and the model provider as the server does | Nothing of its own: `/api` on the proxy's port, only with `compose.api-public.yaml` named ("The REST core" below) | Through the proxy, as the server, when `/api` is on |
| `postgres` | `postgres:5432` on `data` alone — the migrator, the REST core, the coordinator's passes and the import runner; from `egress` the name does not resolve and its address does not answer (CI's "Postgres answers on the data network alone") | Nothing. `compose exec postgres psql -U postgres openbrain` for psql, `compose exec -T postgres pg_dump -U postgres openbrain > dump.sql` for a backup. A tool run from a checkout (`db/reembed.ts`, `db/extract-entities.ts`, `db/consolidate.ts`, the evals) adds `-f deploy/compose.host-ports.yaml`, which publishes it on `127.0.0.1:${POSTGRES_PORT:-5432}` — choose that when the stack comes up: adding or dropping the file later recreates `postgres` and, through `depends_on`, `api` | Never. `POSTGRES_BIND` exists for a firewalled host you have looked at; it is the superuser on the whole brain |
| `ollama` (`--profile local-models`) | `ollama:11434` on `egress` — the server and `ollama-pull` | Nothing. `compose exec ollama ollama pull <model>`; the host-ports file publishes it on `127.0.0.1:${OLLAMA_PORT:-11434}` for an eval run from a checkout | Not intended; an unauthenticated model API |
| `jev` (`--profile jev`) | `jev:8020` on `egress` — the server's preflight, and a spike run in a container | Nothing. The host-ports file publishes it on `127.0.0.1:${JEV_PORT:-8020}` for a spike run from a checkout (`OB1_JEV_BASE_URL=http://127.0.0.1:8020`) | Not intended; an unauthenticated model API, as Ollama's is |
| `coordinator` | Listens on nothing; its passes (`OB1_PASSES`: board-sync, the workers, the sleep scheduler) dial `postgres:5432` on `data`, and the model provider and Linear's API on `egress` | Nothing | Nothing |
| `n8n` (`--profile orchestration`) | `n8n:5678` on `egress`, which nothing in the stack dials; n8n dials `orchestration-runner:8090` and the vendors its workflows name, and its brain calls go to the REST core as `api:8000` (SMD-2295), all on `egress`. Not the mesh, where every backend the proxy reaches is (a tier of another project joined it, its server `server` too, from SMD-2294 to SMD-2874) | `127.0.0.1:${N8N_PORT:-5678}`: the editor, the public API (`/api/v1`), webhooks (`/webhook/…`) and MCP endpoints (`/mcp/…`), behind the owner's password and the keys provisioning stores | Through a TLS proxy, as the server. `N8N_BIND=0.0.0.0` only for a proxy on another machine, and then its keys ride every request in clear until the proxy |
| `orchestration-runner` (`--profile orchestration`) | `orchestration-runner:8090` on `egress`, which n8n's import templates dial with `OB1_RUNNER_KEY`; it dials `postgres:5432` on `data` as its own role, `ob1_orchestration_runner`, and the model provider, and for a live-API emitter the hosts its pipeline names. Its emitters dial nothing (SMD-2289) | Nothing | Nothing |
| `lgtm` (`--profile observability`) | `lgtm.ob1.internal` on the `mesh` network: the MCP server and the REST core send their OTLP to `:4318` there, and with `compose.grafana-public.yaml` the proxy dials its Grafana at `:3000` for `/grafana`. On the internal `telemetry` network its collector scrapes `pg-exporter` every 30 s. Its Prometheus, Tempo, Loki and Pyroscope listen on its own loopback. It dials nothing else by itself — a data source its admin adds reaches any name on `mesh` or `telemetry` ("The observability profile" below) — and shares no network with Postgres or the model providers | Nothing by default. `compose.grafana-port.yaml` publishes its Grafana on `${GRAFANA_BIND:-127.0.0.1}:${GRAFANA_PORT:-3000}`, an origin of its own; `compose.grafana-public.yaml` routes `/grafana` on the proxy's port | Grafana's own sign-in, anonymous access off: through a TLS proxy to the loopback port (`GRAFANA_ORIGIN` its https origin), or at `/grafana` with `compose.grafana-public.yaml`, which shares the stack's origin ("The observability profile" below) |
| `pg-exporter` (`--profile observability`) | `pg-exporter.ob1.internal:9187` on the internal `telemetry` network, where lgtm's collector scrapes it at `/cgi-bin/metrics`, the one path that answers; nothing on `data` reaches that port, and the exporter itself listens on the container's loopback (SMD-3023). It dials `postgres:5432` on `data` as `ob1_monitor` (a member of `pg_monitor` alone). It shares no network with the model providers or the mesh | Nothing | Nothing |
| `auth` (`--profile auth`) | `auth.ob1.internal:3000` on the `mesh` network, which the proxy dials for `/auth` and the discovery paths ("One origin" below), and the MCP server for its `/healthz` probe (SMD-2382); its admin listener, `auth.ob1.internal:3001`, which the operator GUI's page of grants dials and no proxy rule routes to (SMD-3307 PR 3); it dials client metadata documents outward on `auth-egress`, its own, through its fetch guard. It shares no network with Postgres, Ollama, Jev, n8n or the workers, and holds no Postgres credential | Nothing of its own: `/auth` and the discovery paths on the proxy's port. `compose exec auth …` for the backup below | Through the proxy, as the server |

A canary stood beside this
stack (`deploy/canary.sh`, "A canary beside the stack" below) is this file
again under the project `open-brain-canary`: the same rows on its own networks,
its forwarder on a loopback port of its own (SMD-2874). It joins none of this
stack's networks.

`docker compose -f deploy/compose.yaml config` renders each mapping with
`host_ip: 127.0.0.1`, and `scripts/check-fork-consistency.ts` check 13 parses
every `compose*.yaml` under `deploy/` and refuses a mapping that drops the
address, a service that reaches outside the file (`extends`, `include`) or onto
the host without a port (`network_mode`), and holds an inventory of which
service publishes from which file — the forwarder and the profile's n8n from
`compose.yaml`, the database, Ollama and Jev from the host-ports file and Grafana from `compose.grafana-port.yaml` — so a new published port is
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
the one port the stack publishes for its clients (the forwarder's, below), and each service is a
path on it rather than a port of its own (SMD-1846). The
paths today:

| Path | Answered by |
| --- | --- |
| `/auth` and everything under it, `/.well-known/oauth-authorization-server/auth`, `/.well-known/openid-configuration/auth`, the bare `/.well-known/oauth-authorization-server` | `auth` (`--profile auth`), as `auth.ob1.internal` on the `mesh` network — the issuer, sign-in, registration and the three discovery documents outside the issuer's path (the bare one is the only one Claude Code reads). Only while it answers: with the profile off, the server stopped or still starting, the proxy's own bodiless 404, so an origin without it says "no OAuth here" as before. Its own answers pass through untouched, the registration cap's 503 and `Retry-After` included |
| `/api` and everything under it | the proxy's bodiless 404 by default. With `compose.api-public.yaml` named (below), `api` — the REST core, as `api.ob1.internal` on the `mesh` network — with `/api` stripped: `/api/v1/stats` reaches it as `/v1/stats`, and the links it answers carry `/api` back |
| `/hooks` and everything under it | the proxy's bodiless 404 by default. With `compose.hooks-public.yaml` named ("Plugins' webhooks" below), `api` — the REST core — path kept: `/hooks/<plugin>/<name>` is a plugin's inbound webhook, served only for a plugin `OB1_HOOKS` names (SMD-2310) |
| `/mcp` and everything under it | `mcp` — the MCP server built on the REST core (SMD-2287), as `mcp.ob1.internal` on the `mesh` network: the MCP endpoint (POST), `GET /mcp/health`, `/mcp/worker-status`, `/mcp/jobs/<id>`; `GET /mcp` is its 405. Every tool is a call on the REST core, the caller's key beside this server's own forward key |
| `/dashboard` and everything under it | `app` — the operator GUI (SMD-2280), as `app.ob1.internal` on the `mesh` network, path kept: sign in with a read or write access key, then the brain's counts and newest thoughts, every thought a page at a time by its filters, search by meaning or by exact text, what changed, supersession proposals, the worker queue and the query log, its status (`brain_info`), any thought and an enabled plugin's pages, each read from the REST core under that key. Key sign-in is off here while `COMPOSE_PROFILES` names `auth`, and on only at the break-glass port (`dashboard/README.md`). While `app` is stopped or starting, the proxy's own 502 |
| `/grafana` and everything under it | the proxy's bodiless 404 by default. With `compose.grafana-public.yaml` named ("The observability profile" below), `lgtm` (`--profile observability`), as `lgtm.ob1.internal` on the `mesh` network — its Grafana, serving from `/grafana`, path kept, behind its own sign-in. With the profile off, or the container stopped or still starting, the proxy's bodiless 404 too, and so is a 502 of Grafana's own (a data source it cannot reach) |
| every path starting with `/canary` or `/working`, in any letter case | the proxy's own 404 (SMD-2874: a canary or a working tier is a brain of its own on its own port, and this stack routes none; from SMD-2294 to v2.0.0 a tier answered at `/canary/mcp` here, deprecated by SMD-3057 for a release before it went). No router matches them, so a client still given a tier's URL here reaches nothing; until v2.0.0 `tier-off` kept them off the legacy route, and went with it (SMD-2532) |
| `GET`/`HEAD`/`OPTIONS /health` | `mcp` — liveness for a GET-only probe at the origin root: `ok`, or the brain's record with a read key; OPTIONS for a browser's CORS preflight |
| `/.well-known/oauth-protected-resource/mcp` | `mcp` — the MCP server's protected-resource document while it advertises OAuth: the `auth` profile on, the request at the origin's `Host`, and the authorization server answering the server's probe on the mesh. Otherwise the server's 404, and a server that is down is the proxy's 404, never a 502 (SMD-2382). A claude.ai connector at `https://host/mcp` asks this at the origin root before it uses its key, and proceeds on the key only on a 404 (SMD-1246) |
| `/register`, `/authorize`, `/token` | the proxy's bodiless 404: where an MCP client that found the document but no authorization-server metadata would register and sign in, at the issuer's root. A router of its own since SMD-2382, when the legacy route would have handed the POST to the MCP server. The authorization server's own are under `/auth` |
| `/.well-known` and everything else under it | the proxy: a 404. It carries none of the server's CORS headers; the MCP SDK's discovery reads a CORS failure as a 404 and goes on |
| anything else | the proxy's own 404 (body `404 page not found`), the origin root included: `POST /?key=…`, `GET /`, `/worker-status`, `/jobs/<id>`. Until v2.0.0 the **legacy** route sent these to `server`, which nothing here routes to now, so every client configured before SMD-1846 kept working, each answer deprecated (SMD-2306); SMD-2532 removed it. A client given the root moves to `/mcp` ("Moving a client to /mcp" below) |

Every backend is dialled by its name on the `mesh` network — the MCP server as
`mcp.ob1.internal`, never `mcp`, because compose gives every container its service
name on each network it joins, and a tier's container on this mesh was a
`server` too (SMD-2294). A name nothing on the networks holds — a tier that
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
file defines a config that is not a route table (SMD-2658) but compose.yaml's
forwarder script and the observability profile's dashboard and its provider
(check 28's `BASE_CONFIGS`, check 37). Every overlay is
an `OVERLAYS` entry there, naming the keys it sets on each service, and a
combination in CI's "The proxy loads only the held route tables", whose
`declared()` names the paths it may change in a render: that step holds each
combination equal to `compose.yaml` alone but for those paths, the proxy and
the configs, so an overlay cannot add an alias, a service or a namespace beside
what it says it does (SMD-2685). The same text is a label on the proxy, so
an `up` after a route changed recreates it: compose does not recreate a
container for a changed inline config alone (docker/compose#11900, measured on
5.5).

**Upgrading a stack from before SMD-2287 PR 5b**, where `/mcp` moves to the
`mcp` service: first mint the MCP server's forward key and give it to the
stack's env file — its hash line added to `MCP_ACCESS_KEYS` and the raw key as
`OB1_FORWARDER_KEY=`. From a checkout, `bun server-portable/keygen.ts --name
mcp-forwarder --scope forward`; on a release install, which has no checkout,
the release's image mints it: `docker run --rm --entrypoint bun
ghcr.io/mharris-sgymd/ob1-server:<X.Y.Z> keygen.ts --name mcp-forwarder
--scope forward`. Then the stack's own `up`: `compose up -d --build` from a
checkout, or, on a release install, the new tag's `compose.yaml` and
`compose.release.yaml` downloaded over the old ones and its `pull` and
`up -d --wait` ("Pinning a release"), with its `-f` files and profiles. Without the key compose refuses every command on the
stack, `ps`, `logs` and `down` among them, naming it, before anything changes:
inspect or stop the old stack with the old `compose.yaml`, or hand one command
`OB1_FORWARDER_KEY=x` in the shell. The `up` creates `mcp` and recreates
the proxy, which waits on the MCP server and the REST core; from a checkout or
a release since SMD-2287 PR 6b, take its upgrade below with it, `--remove-orphans`
included. On a stack running the observability profile, the `ob1-server-silent`
alert fires for up to a day after it: `server` stops sending its series as it
goes, which the alert reads as a server gone quiet. Then
check the key took: `curl -s -H "x-brain-key: <a read or write
key>" <origin>/mcp/health` answers the brain's JSON record. A bare `ok` there
is a key the brain did not take: yours (unknown, revoked, out of scope) or,
when `compose logs mcp` says this server is misconfigured, its own forward key
— a hash line missing or mistyped, which leaves `mcp` healthy and every tool
call a 500, and which that line names (`deploy/smoke.sh <origin>/mcp <key>` from a checkout
checks the same and more). A canary gets its own key from `canary.sh up`. **Rolling back** to a `compose.yaml` from before
it needs `up -d --remove-orphans`, or `mcp`, an orphan, keeps the
`mcp.ob1.internal` alias and answers part of `/mcp` beside the old server; a
canary rolled back with an older `canary.sh` needs `docker rm -f
<canary>-mcp-1` for the same reason.

**Upgrading a stack from before SMD-2287 PR 6b**, where `server` retires:
`server-portable/index.ts`, the MCP server it ran, is gone, and the REST core
builds the server image. Run the stack's own `up` with `--remove-orphans`
(`compose up -d --build --remove-orphans` from a checkout; on a release
install its `pull`, then `up -d --wait --remove-orphans`), with its `-f`
files and profiles: without it the old `server` container keeps running beside
the stack, an orphan holding connections to its database. The REST core's
first start marks lost any job the old server left running (door
`open-brain`). A raw key holding a character past U+00FF, which `?key=`
carried to `index.ts`, reaches no server now: no header carries it to the REST
core (`rest-client/README.md`), and `/mcp` has refused it since PR 5b. Mint
its client a new key (`keygen.ts`) and drop the old one from
`MCP_ACCESS_KEYS`. `canary.sh up` removes a canary's old `server` container
itself. **Rolling back** to a release from before it is the old
`compose.yaml`, which builds and runs `server` again.

**Upgrading a stack from before SMD-2583's forwarder** is one plain `compose
up -d` (with its `-f` files and profiles): compose recreates the proxy without
its port, then creates the forwarder, which waits for it, on the port. On
that first `up`, name the forwarder wherever you name the proxy (`up -d
--build api proxy forwarder`): `up proxy` alone frees the port and never
creates the forwarder. **Rolling back** to a `compose.yaml` from before it
needs `up -d --remove-orphans`, or the forwarder, an orphan, keeps the port.

**Upgrading a stack from before SMD-1846** is one plain `compose up -d --build`
(with the `-f` files and profiles it runs with): compose recreates the server
without its port, then starts the proxy on it — about 1.5 s with no answer on
the port, measured on podman. The last
30–100 ms of it is the proxy's own 404, between its start and its routes
loading; an SDK client connected across it saw one 404 and went on (measured).
A client still configured at the root stops working there from v2.0.0: move it
to `/mcp` first ("Moving a client to /mcp").
On that first `up` name the proxy and the forwarder wherever you name the REST
core (`up -d --build api proxy forwarder`): `up api` alone never creates either.
Once they run, recreating the REST core alone is fine — the forwarder keeps the
port and the proxy finds the new container by name — but a rebuild names the
proxy too, which depends on the MCP server and the operator GUI as well ("The
REST core", below): they run the image `api` builds, and a container keeps the
image it started on. (Until SMD-2287 PR 6b the server image's builder was
`server`, the MCP server `server-portable/index.ts` was.) **Rolling back** to
a `compose.yaml` from before it needs `up -d --remove-orphans`: without it the
proxy, now an orphan, keeps the port and the old server cannot bind it
(measured: "address already in use", the stack down).

**Adding a service** is two edits in `compose.yaml`: the service, with no
`ports:`, and a router for its path in `x-proxy-routes`, at a priority that
orders it among the others. The same router, and its backend under `services:`, go in
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
`api-off`, and the operator GUI's `dashboard` (SMD-2280). A service under a profile gets the `auth`
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
passes the server no raw key, so this holds only for a compose file edited to
pass one; the vendored servers run no preflight, so give them a 32-byte key
yourself. The REST core
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
It builds the server image, which the MCP server and the operator GUI run by
name (`server` built it until SMD-2287 PR 6b), so name it with `--build` to
rebuild all three.

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
from a header (`x-brain-key`, `x-access-key` or `Authorization: Bearer`, which on
a stack with the `auth` profile also carries the authorization server's tokens:
"Tokens at the REST core", SMD-2286), never from `?key=`, so a client of `/api` needs a header; a URL-only connector stays
on `/mcp`. The proxy deletes `x-brain-forwarder` on the way in: a request's
carrier (SMD-2284) is named only from inside the stack, where the MCP server
names itself when it forwards a key (SMD-2287's `mcp-server/`). Its writes record their door as
`open-brain-api`
(`thought_audit.origin`), the MCP server's at `/mcp` among them, carried by it,
and the jobs it
starts are its own (migration 078): its start marks its own unfinished jobs
lost, and those of `open-brain`, the MCP server `index.ts` was until SMD-2287
PR 6b retired it. A job is read by the key that started it through either
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
docker compose -f compose.yaml -f compose.hooks-public.yaml up -d --force-recreate --no-deps app
```

The second line gives the GUI the recreated REST core's address at once
(signing everyone out of it: its sessions live in its memory).

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
through a tunnel. From SMD-1846 to v2.0.0 the proxy's legacy route kept the
root answering, for a window (SMD-2306). **From v2.0.0 the window is closed**:
the root is the proxy's own 404 (body `404 page not found`), and a client still
on it stops working (SMD-2532). The port does
not change: the forwarder publishes the same `SERVER_PORT` the proxy did. Only the path
changes: add `/mcp`.

**On a stack from v1.6.0 to v1.9.0,** still in the window, every answer
through the legacy route carries two headers:

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

**Finding the clients still on the root.** On such a stack, run
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
without a key, so it adds no name: run that stack's own `smoke.sh`, from a
v1.x checkout. A v2.0.0 checkout's check 11 expects the proxy's own 404 there
and fails on an older stack's deprecated 200. On v2.0.0 neither log has a
line for them, no legacy router and no server line: a client still on the
root reports that 404 itself.

| Client | Before | After |
| --- | --- | --- |
| Claude Code (`claude mcp add`) | `http://127.0.0.1:<SERVER_PORT>/` | `claude mcp get open-brain` names the scope (and prints the key); then `claude mcp remove open-brain -s <scope>` and `claude mcp add --transport http --scope <scope> open-brain http://127.0.0.1:<SERVER_PORT>/mcp --header "x-brain-key: <key>"`. Without `--transport http` the add makes a stdio entry. A project-scope entry is the `url` in `.mcp.json`: edit it there |
| Claude Desktop or claude.ai custom connector | `https://host/?key=…` | `https://host/mcp?key=…`: remove the connector and add it with the new URL |
| The session-capture hook | `"url": "http://127.0.0.1:<port>/"` in `~/.config/open-brain/session-capture.json` (or the file `OB1_SESSION_CAPTURE_CONFIG` names) | `"url": "http://127.0.0.1:<port>/mcp"`, then `bun recipes/session-capture-hook/session-capture.mjs --check`, which warns while the url answers through a pre-v2.0.0 stack's legacy route, and from v2.0.0 names the root as not the endpoint. `OB1_BRAIN_URL` in the hook's environment overrides the file: move it too |
| `db/tier.ts --compare` (`db/brain-compare.ts`) | `http://127.0.0.1:<port>/`, or a connector name it reads with `claude mcp get` | `http://127.0.0.1:<port>/mcp`; a connector name follows the Claude Code row |
| curl, a script, a monitor | `/worker-status`, `/jobs/<id>`, `POST /worker-retry-failed`, `/worker-release-leases`, `/worker-run`, `/health` at the root | the same under `/mcp` (`/mcp/worker-status`, …). `GET /health` at the root stays: it has a route of its own. A `scan_thoughts` handle's links are now under the endpoint the call came to |
| n8n | `http://server:8000/` in an MCP Client node you built | an HTTP Request node against the REST core, `http://api:8000/v1/…` with the key in `x-brain-key`, on the `egress` network and not through the proxy (SMD-2295). Nothing answers at `server` since SMD-2287 PR 6b retired it, and the profile's brain credential is pinned to `api` since SMD-2295 |
| any other client: Codex or Cursor, an `mcp-remote` or `supergateway` bridge | the root, with or without `?key=` | put `/mcp` before `?key=` (`https://host/mcp?key=…`), or at the end of a URL without one |

Two more things belong here, though neither applies until the stack has a
public origin and the `auth` profile on (SMD-2382):

- **A configured stack asks a claude.ai connector to sign in, key or no
  key.** claude.ai asks for the protected-resource document before it uses a
  connector's key, and the MCP server serves it at the public origin while
  the authorization server answers. So a `?key=` connector at `/mcp` opens an
  OAuth sign-in first — the operator's, at `/auth`. Once through, its key
  still rides the URL and authenticates before the token, so it is served as
  before. A connector with no key is served once signed in: `/mcp` is
  `mcp-server/`'s since SMD-2287 PR 5b, which trades its token at the hop
  (SMD-2286). The server itself never sends a key client to sign in: a
  bad key, in any form, still gets the 200 carrying a JSON-RPC refusal.
- **Changing the public origin later costs a re-enrolment.** Every passkey has
  to be enrolled again and every connector registered again.

The compose side of the upgrade is in "Upgrading a stack from before
SMD-1846" above: name `proxy` beside `api` on the first `up`, and roll back
with `--remove-orphans`.

## Expected outcome

`migrate` exits 0 having applied every migration under `db/migrations/` (its image,
`db/Dockerfile`, carries the runner and the migrations and installs nothing —
`migrate.ts` imports only Bun and `node:` built-ins). `api` logs `preflight OK`
followed by `Started server`, and `proxy` turns healthy. `smoke.sh` ends with
`0 failed` and exits 0 (its checks are the numbered comments in the script; the
summary line counts them).

Point an HTTP liveness probe at **`GET <base>/health`** (200, no key) —
`http://127.0.0.1:8000/health` at the origin root or `…/mcp/health` under the
endpoint, or whatever URL you configure outside the proxy; the exact match rule
is `server-portable/mcp-edge.ts`'s `HEALTH_PATH` and the comment above it
(FORK.md change 75).
The MCP endpoint serves POST only: `GET /mcp` answers 405 (and `GET /` is the
proxy's own 404 since v2.0.0, SMD-2532), so a platform-default probe aimed at
`/` marks a healthy server down. The image's own `HEALTHCHECK` is that keyless `GET /health` too —
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
the server image's build, `api`'s. Set it from the shell, on the
command that builds — not in `deploy/.env`, where a value written once is baked
into every later build — with `--dirty`, so an image built from uncommitted
changes says so. Compose never forwards it at runtime; a runtime variable of that
name added to a service's `environment:` overrides the baked one, so add none.
Unset at build, the image reports `unknown`. Rebuild with it:

```bash
OB1_GIT_SHA=$(git describe --always --dirty --abbrev=8) docker compose up -d --build api proxy forwarder
```

The REST core builds the server image, the MCP server at `/mcp` and the
operator GUI at `/dashboard` run it by name, and the proxy depends on all
three, so this rebuilds and recreates them too. The first such `up` after the GUI arrived
(SMD-2280) also creates `app` and recreates the proxy, its route table having
changed, so the whole origin answers nothing until the servers are back; later
upgrades leave the proxy running. Add
`-f compose.api-public.yaml` where `/api` is on.

`proxy` and `forwarder` named beside `api`: the proxy waits on the servers and
the forwarder on the proxy, and nothing waits on the forwarder, so `up api`
alone on a stack from before SMD-1846 never creates the forwarder that takes
the published port over (SMD-2583).

The release images carry the tagged commit — the cut's merge commit, in full
(`.github/workflows/release.yml`) — which is not `releases.json`'s `server` field
(the cut's first commit; the server tree is the same).

## Why the server runs preflight before serving

The data layer is built lazily on first use. Without a gate, a server with a wrong
`DATABASE_URL` starts cleanly and passes any HTTP liveness probe — then fails when a user captures
their first thought, with the real error buried inside a tool response.

The settings the server needs come from the env file by hand (the database
password from which compose builds `DATABASE_URL`, the access keys, the model
provider's endpoint and key), so any of them can be wrong.

So the container's entrypoint runs `bun preflight.ts` and, only if it passes, `exec bun api.ts`, the image's default command (`index.ts` until SMD-2287 PR 6b); the MCP server and the operator GUI run their own entries from the image without it, as they read no store. A
misconfigured deployment crashloops, which is visible, instead of looking healthy,
which is not. `preflight.ts --json` suits a pipeline gate; `--deep` also calls
the configured model providers and checks the embedding width still matches the schema.

One check that matters most on a database brought from a managed provider (a
restored dump, say): `vector extension`. If pgvector sits in a schema off the
connection's `search_path` (some providers install it in `extensions`), the bare `vector` type does not resolve and every
capture and search would fail with `type "vector" does not exist` on a database
that has pgvector. Preflight fails with the schema it found and the exact
statement to run: the login role's `ALTER ROLE … IN DATABASE … SET search_path`,
its own path kept and the schema added — or, where the connection string sets
the path, the `options=` value to put there instead — see `FORK.md` change 43
and SMD-2238.

## After a reboot

What comes back after the host, the Docker daemon or a podman machine
restarts is each container's restart policy; compose is not involved. In
`compose.yaml` what serves is `unless-stopped`: Postgres, the three servers and the operator GUI,
the proxy, the forwarder that publishes its port, Ollama, n8n, the
orchestration runner, the authorization server and the observability
profile's `lgtm` and `pg-exporter` — and, since SMD-3214, the core passes
and `jev`; since SMD-3476 the passes are one service, the coordinator. What
runs once is `"no"`: the migrator,
`ollama-pull`, the runner's role job and the exporter's.

The four followers and `jev` were `on-failure:3`, so that a configuration a restart does
not fix stopped them rather than looped; but neither runtime starts that
policy at boot, so every reboot left a brain serving and not sleeping (on
2026-10-22 both dogfood brains' `sleep` and stable's `board-sync` stayed down
until started by hand). Each is now a child of the coordinator
(`db/coordinator.ts`), which runs the passes `OB1_PASSES` names, each through
`db/supervise.ts`, and, when one ends on its own — a refusal (exit 2), a crash — runs it
again after 1, 2, 4, 8, then every 15 minutes, its heartbeat ended with when.
The container never exits, so the runtime has nothing to restart in a loop. A
fix outside `deploy/.env` (a model pulled, the migrations applied) is met at
the next try; one in `deploy/.env` needs the coordinator recreated, which
`up -d` does when its environment changes. No `OB1_WORKER_KEY`, or a setting
that is not digits, holds that pass until that recreate, the follower never
started. Preflight's `workers` and `sleep` rows say a held pass is held, its
cause and its next try, rather than "start it again".

`jev` is `unless-stopped` as well, and needs no supervisor: serving, it
never exits on its own. A fetch that fails or hashes wrong, an engine that does
not load and a port taken are tried again on the same clock, the service
unhealthy meanwhile; a bad `JEV_THREADS` holds it until a recreate. The servers
can need it — with `OB1_JEV_BASE_URL` naming the `jev` service, their preflight
fails ("The jev service is not running") until it serves — and after a reboot
it now comes back without a hand start (SMD-2834). Check 32
of `scripts/check-fork-consistency.ts` holds every service's policy, and that
each follower runs through the supervisor. Postgres
had none until SMD-2760, so on Docker a reboot would bring the servers back
without their database. A canary (`canary.sh`) takes the same policies.

- **Docker** starts its `unless-stopped` containers when the daemon starts,
  except one stopped by hand. That needs the daemon itself to start at boot:
  Docker's packages enable it on Debian and Ubuntu, and elsewhere it is
  `sudo systemctl enable docker.service containerd.service`. Rootless Docker
  needs `systemctl --user enable docker` plus linger, and Docker Desktop
  needs its start-at-sign-in setting.
- **Podman** has no daemon. At boot only `podman-restart.service` applies
  the policies, and only once it is enabled. It starts the containers that
  `podman ps -a --filter should-start-on-boot=true` lists: those on `always`
  or `unless-stopped`, less any stopped by hand (measured for
  `unless-stopped`). On a podman machine on macOS (podman 6.0.2) it was
  disabled at both scopes, and the stack stayed down after the machine
  restarted until it was started by hand 47 minutes later (SMD-2760). Enable
  it in the scope the containers run in:

  ```bash
  podman machine inspect --format '{{.Rootful}}'     # true: the containers are root's
  podman machine ssh -- sudo systemctl enable podman-restart.service
  # false: the machine user's unit, inside the machine (not measured here)
  podman machine ssh -- systemctl --user enable podman-restart.service
  ```

  On a Linux host where podman runs as root, it is
  `sudo systemctl enable podman-restart.service`. For rootless podman (not
  measured here), run `systemctl --user enable podman-restart.service` and
  `sudo loginctl enable-linger "$USER"`, so that the user's units start
  without a login session.

  Before enabling it, list what it will start: every such container, not
  this stack's alone. On the Mac above that included a days-old scratch
  stack's server and proxy. Remove what should stay down, or stop it, which
  takes it off the list:

  ```bash
  podman ps -a --filter should-start-on-boot=true --format '{{.Names}} {{.Status}}'
  ```

**Order is not kept.** Compose is not running at boot, so nothing waits on
`depends_on`'s conditions (Postgres healthy, the migrator done), and a server
can start before Postgres answers. Its preflight then fails and the
container exits (preflight does not wait), and `unless-stopped` starts it
again until Postgres answers, which takes seconds. Under podman that loop
has no backoff (SMD-2043). A model provider that is not up yet does not
restart it: an Ollama on the host that starts after the stack is a preflight warning,
and the server serves degraded until it answers (SMD-2890). A database the server cannot use keeps it
restarting; for example, after a lost volume Postgres comes back empty, and
the migrator does not run at boot. `compose logs api` says why. With the
schema in place the migrator is not needed at boot; the `up` after an
upgrade runs it.

**A stack from before SMD-2760**, a canary's included, keeps its Postgres
(and its Ollama, where the profile is on) at `no` until each is recreated
from this `compose.yaml`. Its servers are already `unless-stopped`, so an
enabled unit would bring them back without their database. An `up -d`
recreates them, with a short outage. Or set the policy on each running
container in place: under podman that kept the same container running, and
it joined the boot list at once (measured). `podman update` takes one
container at a time; `docker update --restart unless-stopped` takes several.

```bash
# the default project's names; another brain's are <project>-… ("One env file is one brain")
podman update --restart unless-stopped open-brain-postgres-1
podman update --restart unless-stopped open-brain-canary-postgres-1   # a canary's (deploy/canary.sh)
podman update --restart unless-stopped open-brain-ollama-1            # with --profile local-models
```

**To check after a reboot**, list the stack with the `-f` files and profiles
it was brought up with: `postgres`, `api`, `mcp`, `app`, `proxy` and
`forwarder` should be `Up`, and `/health` should answer 200. Whatever is still down, the same
`up -d` the stack was brought up with starts in order.

```bash
podman compose -f deploy/compose.yaml ps -a
curl -fsS "http://127.0.0.1:${SERVER_PORT:-8000}/health"
```

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
path is asked at its own path form and the root form only. A server whose authorization server flips between up and
down inside one run (its probe's 30 s) can fail it once; run it again.

## What the servers log

Each server writes one JSON line to stdout per request — the MCP server at `/mcp` and the REST core — every route of each
(SMD-1849, `server-portable/telemetry.ts`) — the MCP endpoint, the MCP
server's keyed `/health`, worker mirrors and `/jobs/`, its 405s, CORS
preflights and `/.well-known/` answers, and every REST route — when the
request ends: as its answer goes, or for a stream (an MCP answer, a job
stream) at the stream's end. A request in flight when the stop cuts it is
written then, as `cut` (or `abandoned`, its client already gone), before the
process exits. A request Bun's own HTTP parser refuses — a path past its
limit (431), `OPTIONS *`, a method it does not know — never reaches a route
and has no line; the proxy's access log has it. The one request not
written is the liveness probe's (below): on the MCP server a GET or HEAD at a
health path that presents no key, on the REST core a GET or HEAD of `/health`
— known as it arrives, and not written whatever it answers.

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
| `route` | the route as a template, never the path it was given: the REST core's (`/v1/thoughts/:id`), or an MCP server mirror's (`/health`, `/worker-status`, `/worker-run`, `/jobs/:id/stream` — under whatever prefix it came); the MCP endpoint, the MCP server's preflights, `/.well-known/` answers and 405s, the REST core's 404s and 405s, and an unmatched path have none |
| `rpc` | the MCP JSON-RPC method (`tools/call`), or `batch` for a body of several messages; one outside the 2025-06-18 schema's client methods is `other` — so a newer client's (2025-11-25's `tasks/*`) is too |
| `tool` | the tool an MCP tool call names, a REST route runs or a mirror mirrors (the job routes' is `job_status`), from the manifest (`tools.ts`); a batch names none |
| `agent` | the configured name of the key that authenticated — never the key; the single legacy `MCP_ACCESS_KEY` is named `MCP_ACCESS_KEY` |
| `status` | the HTTP status (an MCP tool call is a 200 whatever the tool said). At the MCP endpoint, 0 when the client left before there was an answer — during the key check, the registry's answer, the body read or the transport's parse — and 408 when it was gone before the route ran; on an `abandoned` line from anywhere else, the status of the answer no one received (a REST body read the client cut off is the 500 it became), or 0 when the stop came before any answer |
| `outcome` | on every line. A request the MCP server refuses at its key is `refused`, whatever its method and status — at its MCP endpoint with the refusal's code, at a keyed mirror (a 200 that shows the caller nothing — the keyless probe at `/health` aside, which is not logged) with `REVOKED` or `BUSY` where the registry said which, and none for a key missing, wrong or out of scope. An MCP tool call says the tool's: `ok`; `refused` (a refusal as a value); `error` (the tool threw, or the route did — a 500); `unrun` (a call that never ran to an end — the transport refused the request, the SDK its input, the key's scope does not hold the tool, or it was sent as a notification, with no `id`); a batch its worst call's (error, refused, unrun, ok). Any other request, and every REST request, says its answer's: `error` for a fault (a 5xx `FAILED` or `STORE_UNAVAILABLE`, or one with no code), `refused` for any other 4xx or 5xx (a 503 `BUSY` is a refusal for now, on both doors), else `ok` — so a JSON-RPC error inside a 200, an unknown method, is `ok`. A key whose scope lacks the tool, or an input the schema refuses, is `unrun` with no code on the MCP server, where the tool is not registered or the SDK refuses it, and `refused` with `FORBIDDEN` or `REFUSED_INPUT` on the REST core. `abandoned` is a client gone before a stream ended (an MCP answer, either job stream) — by its abort, or by letting go of the body — or before any other answer was handed over (one that leaves after keeps that answer's outcome); `cut` is a request the stop closed while its client was still there, on either server (status 0 where no answer had begun, 200 for a stream the server had begun — Bun sends its status line with the stream's first bytes, so a client cut before them received nothing), and one whose client had already left is `abandoned`; `stalled` a stream still running at the keepalive's ten minutes — written then, and its own end writes no second line. An abandoned or stalled call runs on to its end; whether a capture landed is `thought_audit`'s to say |
| `code` | a refusal's or a fault's code (`NOT_FOUND`, `FAILED`) — the MCP server's from the tool's reply, from a worker action's refusal (`RUN_WORKER_DRAIN_NOT_AVAILABLE`, `REFUSED_EMPTY_WORK_TYPE`), from a mirror's store fault (`FAILED`), or at the key, `UNAUTHORIZED`, `REVOKED`, `BUSY` or `AUTH_UNREACHABLE` (at a keyed mirror, `REVOKED` or `BUSY` where the registry said which); the REST core's from its 4xx or 5xx answer |
| `ms` | milliseconds from arrival to the line: a stream (an MCP answer, either server's job stream) to its end, including the time a slow reader takes to drain it; any other answer to its handing over, before its body is sent |
| `bytes` | the bytes of a stream that ran to its end — an MCP answer's, either server's job stream's — the server's own keepalive frames apart (the MCP SDK transport's, every 15 s of a long call, are in the stream it writes, and counted) |
| `trace` | the W3C trace id of the request's span (below): its own, or with `OB1_OTEL_TRUST_TRACEPARENT=1` — or at the REST core, for a request its forwarder carried — an incoming `traceparent`'s, continued — and with no collector set, a trusted incoming `traceparent`'s alone, so a line can still be found beside a trusted proxy's; absent otherwise. 32 hex digits, checked like any value |

A line never holds the URL, its query string, a header (but an incoming
`traceparent`'s trace id, the `trace` key), a key, a body, a tool's arguments
or a thought's or a search's text. Search text has its own
home, the query log (migration 034), behind its own switch and retention; this
is not a second copy. `test-server.ts` [21] sends a key in `?key=`, planted
search text and a tool name carrying a line break and planted text through the
server and looks for each, and holds a key's name with a line break and JSON in
it to printable ASCII in a unit check (`JSON.stringify` escapes a line break
anyway, so no line is forged either way); `test-rest.ts` [8] does the same with
a key, an id and query text. The liveness checks are not logged: the image's `HEALTHCHECK` is a
keyless `GET /health`, which no server writes a line for — its 200, or the
500 of an environment that will not seed, is the healthcheck's to read. On the MCP server a keyed `/health` (smoke.sh's, an operator's curl) is
logged with its key's name when the key reaches `brain_info`; a wrong key or
one out of scope is shown `ok` as the probe is, but logged, `refused` — a key
that does not answer is a guess worth seeing — so only a request that
presented no key goes unlogged. The REST core writes no line for a GET or
HEAD of `/health` at all, keyed or not: its answer never reads a key. A keyed
HEAD at an MCP mirror is `ok` by the key's name, revoked or not: it answers
liveness before the registry is asked, and shows the caller nothing.
Every keyed mirror alike, a HEAD whose key authenticates aside: one that shows a caller nothing answers `ok`, a 200,
and its line is `refused`: with no key named when the key is missing (at a
mirror other than `/health`), wrong or out of scope, and by the key's name,
when the registry has not cleared it, with `REVOKED` or `BUSY` where it said
which (none when it did not answer in time). The lines in words beside them —
the MCP server's (a client that left, a stop that cut a call, a stalled
stream) and the REST core's job stream at its ceiling — go
to stderr, as before; their method and tool are the caller's strings, cut to
64 printable characters. Stdout carries lines that are not JSON as well —
preflight's report at every start (each check, then `preflight OK`), Bun's
`Started server: …`, and a stop's `SIGTERM: …` or `SIGINT: …` lines (two, and one more for each further signal) — so select
the JSON lines before handing them to `jq`.

The `agent` is a key's name as the operator wrote it in `MCP_ACCESS_KEYS`: name
keys after the client or device they are for (`laptop`, `claude-desktop`), not
after a person, so the log stays free of names and addresses.

```bash
# every request that did not end `ok`, on each server (the default project's
# containers; another brain's are <project>-mcp-1 and -api-1): /mcp's in the
# MCP server's; the REST core's own, n8n's among them, in the REST core's
docker logs open-brain-mcp-1 2>/dev/null | grep '^{"ts"' | jq -c 'select(.outcome != "ok")'
docker logs open-brain-api-1 2>/dev/null | grep '^{"ts"' | jq -c 'select(.outcome != "ok")'
```

**Every service in `deploy/`'s stacks has a bounded log**: the json-file driver,
rotated at 10 MB with three files kept (`x-logging` in `compose.yaml`; check 29
of `scripts/check-fork-consistency.ts` refuses a service there without it). Podman takes the same keys
and keeps one file, truncated at the bound rather than rotated: every line
goes at once, so it holds anywhere from nothing to 10 MB (measured on podman
6.0.2). The driver is named per service, so it
replaces an engine-wide default an operator has set (journald, a log shipper's
driver); to keep one, set each service's `logging:` in a second `-f` file
(an anchor is read within its own file, so an `x-logging` there changes
nothing here).

### Traces, metrics and log records

Each request is also an OpenTelemetry span, and each tool call (an MCP
`tools/call`, a REST operation, a plugin's) a span under it (SMD-1849 PR 2b);
each request is also a point on the request-duration histogram and a log
record (PR 2c); each provider call and store operation a span under the work
that made it and a point of its own, and a job's body and a webhook's deferred
work a trace of their own (PR 2d). All three signals are recorded and sent
only when the server's environment names a collector. `OTEL_EXPORTER_OTLP_ENDPOINT` sends all three,
the key's name among a log record's fields; `OTEL_METRICS_EXPORTER=none` and
`OTEL_LOGS_EXPORTER=none` keep it to traces — for a collector that takes only
traces, which would refuse the rest and have their losses said every minute.

| Variable | What it does |
| -- | -- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the collector's OTLP/HTTP base URL (`http://lgtm.ob1.internal.:4318`, the observability profile's): spans go to `<it>/v1/traces`, metrics to `<it>/v1/metrics` and log records to `<it>/v1/logs`, as JSON. With none of these endpoint variables set — the default — nothing is recorded or sent, and a request's span and point cost the server well under a microsecond. Each endpoint is read trimmed. One that is no http(s) URL, holds whitespace, or has a query string or a fragment (which `/v1/…` would follow), sends nothing, and the server says so at start |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `…_METRICS_ENDPOINT`, `…_LOGS_ENDPOINT` | one signal's URL itself, used as given (a query string kept), over the base: set alone, only that signal is sent |
| `OTEL_TRACES_EXPORTER=none`, `OTEL_METRICS_EXPORTER=none`, `OTEL_LOGS_EXPORTER=none` | that signal off, the others still sent; said at start. Only `otlp` and `none` are read, and a list that names `none` is off: another value (`console`, `prometheus`) is said at start, and the signal goes over OTLP all the same |
| `OTEL_EXPORTER_OTLP_PROTOCOL` (or a signal's own) | not read: every signal goes as OTLP/HTTP JSON, which a collector's port 4318 takes; a value other than `http/json` is said at start |
| `OTEL_SDK_DISABLED=true` | all of them off, with an endpoint set; said at start |
| `OTEL_EXPORTER_OTLP_HEADERS` | headers for the collector (`authorization=Bearer …`) |
| `OTEL_EXPORTER_OTLP_CERTIFICATE` | the path to a PEM CA certificate, for an https collector with its own; never `NODE_TLS_REJECT_UNAUTHORIZED=0`, which turns off every certificate check the server makes |
| `OB1_OTEL_TRUST_TRACEPARENT=1` | continue a caller's `traceparent`, for a deployment whose proxy sets it. Unset — the default — a request starts its own trace and links the caller's: a caller chooses its `traceparent`, and continued it would choose the request's trace (joining any trace it knows, colliding with another request's line) and, under a ratio, its sampling. The REST core continues one its forwarder carried whatever this says — a forward-scope key in `x-brain-forwarder`, the MCP server's tool call (SMD-2287) |
| `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BLRP_MAX_QUEUE_SIZE` | the span batch's queue and the log batch's, 2,048 by default and 65,536 at most (said at start when held): each item waiting holds memory (a span 1–2 KB measured) |
| `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`, `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE` | the items in one export, 512 by default and the queue at most; a value that is no whole number of at least 1 is ignored, and either is said at start |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BLRP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BLRP_EXPORT_TIMEOUT` | each batch's delay (5 s for spans, 1 s for log records; 0 sends each as it comes) and export timeout (30 s), each held to 2,147,483,647 ms, past which a timer fires at once |
| `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_METRIC_EXPORT_TIMEOUT` | how often the metrics are sent (60 s; a value under 1 s is ignored for the 60 s, one past 2,147,483,647 ms held there) and each export's timeout (30 s, at most the interval) |
| `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` | cumulative by default; `delta` for a backend that wants it |
| `OTEL_SERVICE_NAME` | the service's name; by default `open-brain-mcp` (the MCP server at `/mcp`, `mcp-server/`, SMD-2287) or `open-brain-api` (the REST core) |
| `OTEL_RESOURCE_ATTRIBUTES` | more of the resource (`deployment.environment.name=home` on a plain brain; a `service.namespace` would make Prometheus's `job` `<namespace>/<name>`); a key it names wins, `service.version` included — but not over a pipeline tier's `deployment.environment.name`, which a canary's env file would otherwise take from stable's |
| `OTEL_TRACES_SAMPLER` | the SDK's sampler; by default `parentbased_always_on`. A request's own trace is a root, so a caller decides nothing — unless its `traceparent` is trusted, when the `parentbased_` samplers follow its sampled flag and `traceidratio` reads its trace id; the REST core trusts its forwarder's, so it samples the MCP server's tool calls as the MCP server does. Under `always_off` a line names a trace no span was exported for |

A batch or metric setting above that is ignored or held is said at start,
and in `preflight --deep`'s telemetry row, by its name and the value used,
never the value set: it may be a secret pasted into the wrong variable, even
one of digits alone, which parses as a number. Where the value used is a
queue or interval the operator set, that variable is named instead (SMD-3235).

In `deploy/`'s compose stacks the MCP server at `/mcp` and the REST core take
`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
`OTEL_RESOURCE_ATTRIBUTES`, the three `OTEL_*_EXPORTER` switches,
`OTEL_SDK_DISABLED`, `OTEL_TRACES_SAMPLER` and its `_ARG`, and
`OTEL_METRIC_EXPORT_INTERVAL` from `deploy/.env` (`x-otel-env`), each empty
— read as unset — where the file names none; the workers take none. Not
`OTEL_SERVICE_NAME`, which would give both one name, nor the per-signal
endpoints, the batch and protocol settings or `OB1_OTEL_TRUST_TRACEPARENT`
(no proxy in the stack sets a `traceparent`): name those in a second `-f` file.
The `observability` profile below is a collector for them on the stack's own
machine. A pipeline tier's brain (`OB1_TIER`, SMD-1806) adds
`deployment.environment.name` with its tier to its resource, so a canary that
sends to stable's collector is told apart by name.

At start the server says where each signal goes — the variable, the
endpoint's origin and the service's name (held to printable ASCII), so a
credential in the URL stays out of the log — and why any goes nowhere. What is
not sent — an export that failed, one its collector never finished answering,
what a partial success rejected, or what a batch's full queue dropped — is
said on stderr at most once a minute for each signal: how many (`spans`,
`log records`, or `metric exports` — under cumulative temporality, the default,
the next export carries what a failed one held), the origin and the kind (`HTTP 400`,
`ECONNREFUSED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `timed out`,
`retryable status, retries spent`, `too many exports at once`, `queue full`,
`no answer in time`, `rejected by the collector`, `partly rejected by the collector`) — each kind with its count when a
minute held more than one, five at most and the rest as `others` — never the
error's message or a header. A count held inside a minute is said when the
minute ends; at the stop, what is still unsaid is said, the stop's own
flush's failures included when the flush ends inside its bound, and the full
queues' drops counted exactly. A flush cut at its bound says, by signal, how
many spans, log records and metric exports were on their way or still
batched (`telemetry: 12 spans not sent to http://… (on its way or batched
when the flush's 5000 ms ran out) (SMD-1849)`): a collector that is down is
retried until then, and one that hangs waited on, so that is all that is
known. Metrics count by export: a reading waiting behind an export on its
way at the stop is not counted. An export still unanswered at twice the
exporter's own timeout (`OTEL_EXPORTER_OTLP_TIMEOUT`, 10 s, or the signal's
own) plus 2 s is `no answer in time`, and no longer waited on: its batch moves
on and a flush leaves it. That timeout is an idle one, which a collector
trickling its answer more often than it never lets fire; an export the SDK
retries, after a backoff or a `Retry-After`, ends inside twice it (SMD-2902
PR 2). The SDK still holds such an export's request, in one of the 30 its
exporter allows each signal at once, so under a trickle that never ends every
export after 30 of them is `too many exports at once` until they end. What a
collector answers 200 but rejects (an OTLP partial success) is `rejected by
the collector`, by the count it gives — a metric export partly rejected as
one, `partly rejected by the collector` — and counts that export as failed, so
a stop that meets one since its signal says `not all sent`; the collector's
own message is never said. A throw while the SDK loads leaves the server
serving, said by the error's name alone. The stop sends what is still batched
and the metrics' last reading, and waits for what is on its way, beside
closing its pool, and says which on its own: `; telemetry sent`,
`; telemetry not all sent` (an export of some signal failed since the signal),
`; no telemetry left to send` (nothing exported, or on its way, since the
signal), or `; telemetry not all sent within N ms` (or `: a second signal`) —
never as the pool's. The word is the stop's own, counted from its signal: an
export lost while the stop drains its requests, or in its flush, makes it
`not all sent`; one lost before the signal, such as `no answer in time`, is
said on its own line — at once, when its minute ends, or at the stop with what
is still unsaid — and never in the word, so a stop after one can still say
`sent` (SMD-3297). A span or log record a full queue drops is said as
`queue full`, never in the word, and a stop while the SDK is still loading
counts from its flush. With a metrics endpoint a stop is never
`no telemetry left to send`: the uptime gauge (SMD-3050) is read at every
flush, under either temporality.
The flush has a bound of its own (SMD-2902): 5 s at most, inside what
`OB1_STOP_GRACE` leaves less a second before the kill, and never less than the
pool's (a second, a quarter of one after a cut); a second signal during the
drain gives it the pool's alone, and one after the drain ends it. A collector
that answers in a second or two gets the stop's telemetry when the drain has
left the time (a drain cut at its bound leaves about a second; an export
already on its way can need its answer time twice: the log batch and the
metric reader wait for it first); one that is down adds at most 5 s to the
stop, which then says what it did not send. Nothing orders
the observability profile's collector after the servers, so a `compose down`
or an upgrade can stop it first.

A span holds the line's values and nothing else: its name (`tools/call
capture_thought`, `GET /v1/thoughts/:id`), `http.request.method` (`_OTHER` for
a method outside the known set), `http.route`, `http.response.status_code`
(only for an answer the client was handed — none for an `abandoned` or a `cut`
request), `http.response.body.size`, `mcp.method.name` (with
`gen_ai.operation.name` and `gen_ai.tool.name` for a `tools/call` of a known
tool that ran — not one refused at its key, nor one that never ran), and
`ob1.door`, `ob1.tool`, `ob1.agent`, `ob1.outcome` and `ob1.code` as the line
has them, `ob1.rpc` only for what `mcp.method.name` cannot say (`batch`, or a
method outside the schema's). No `url.*`: the path is a key's or an id's, and
behind the proxy the scheme is not the server's to know. A tool call's span is
`execute_tool <tool>` with `gen_ai.tool.name`, its outcome and its code — the
operation's name is its request's alone, so a backend counts a single MCP call once (a REST operation's and a batch's calls carry none). A
request's span is an ERROR for a 5xx it answered (a 503 `BUSY` refusal
included, as the HTTP conventions have it) or an `error`, `stalled` or `cut`
request, a tool call's for an `error` or a `cut`; `error.type` is its code, else
its outcome. A refusal answered below 500 — a 4xx, or a refusal as a value
inside an MCP 200 — is not an ERROR: the request was served, and `ob1.outcome`
and `ob1.code` say it was refused. A fault — what a tool call throws, on its
span; a webhook's or a worker mirror's, on its request's, which has no tool
span — is an `exception` event with `exception.type` (the error's `name`,
`TypeError`, `PostgresError`) and `ob1.fault.code` where it carries a code
spelled as one (a Postgres error's SQLSTATE, which Bun's SQL keeps in `errno`;
else its `code`, `ECONNREFUSED`): never `exception.message` or a
stack, which can hold a URL, a key or a thought's text. A webhook's message
still goes to the REST core's stderr as its `api hook … fault:` line. Of a
caller's W3C headers only `traceparent` is read — a `tracestate`, its text, is
left behind — and it is a link on the request's span (its trace and span ids,
as the caller sent them), not its parent, unless trusted.

The request-duration histogram is `http.server.request.duration`, in seconds
— to the answer, or to a stream's end — on the HTTP conventions' bounds and on
past ten seconds (30, 60, 300, 600), since a capture through a local model
takes several and a stream can take minutes, to the keepalive's 600 s ceiling. Its labels are the span's
`http.request.method`, `http.route`, `http.response.status_code`,
`error.type`, `mcp.method.name`, `ob1.door`, `ob1.rpc`, `ob1.tool` and
`ob1.outcome`, each from a set the server's own words bound: never
`ob1.agent` or `ob1.code`, an `error.type` that is a fault's code (`FAILED`,
`STORE_UNAVAILABLE`) or else the outcome, and no `ob1.tool` for a request
refused at its key on either door — that refusal is the key's, not the
tool's — so a backend holds a series per route, tool and outcome, not per
key, and a keyless caller cannot raise a tool's refusal rate. A request's
log record is the line's fields as its body — the same fields stdout's line
has, its `ts` the record's own time — named `ob1.request`, at `INFO` for an
`ok` request, `WARN` for another that is no ERROR, `ERROR` where its span is
one, and carrying its span's trace and span ids, so a collector has the line
without reading a container's log. stdout's line is written all the same.

Inside a tool call, each call to the embedding or chat provider is a client
span under the GenAI conventions' names — `embeddings <model>` or
`chat <model>`, with `gen_ai.operation.name`, `gen_ai.request.model`, the
endpoint's `server.address` and `server.port` (never its userinfo or path),
and `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` where the
answer says them; no `gen_ai.provider.name`, since an OpenAI-compatible
endpoint does not say whose it is — and a point on
`gen_ai.client.operation.duration`, in seconds on the conventions' bounds and
on to 327.68 s, labelled with the operation, the model, the host and port and,
for a call that failed, its `error.type`: the provider's status (`503`;
`_OTHER` outside 300–599, so a provider cannot mint a series per status),
`timeout`, `invalid_body` (a 2xx that is no JSON), or the runtime's code
(`ECONNREFUSED`). A call the egress gate refuses is never made, and has none.

Each operation the core calls on the store is a client span named for the
operation (`matchThoughts`, `captureThought`) — one span per operation, not
per query: no query's text is read, so a span cannot name its SQL, and
`pg_stat_statements` times each SQL statement (the observability profile's
exporter, below) — with `db.system.name`
(`postgresql`), `db.operation.name` and `ob1.store` (`sql` or `postgrest`),
and a point on `db.client.operation.duration` labelled with the same, on
bounds finer than the conventions advise and on to 60 s. On the SQL store a
fault's SQLSTATE is its `error.type` and `db.response.status_code`
(any other fault's code or kind its `error.type`), and its time includes the
pool's wait. No query or parameter is on it. A plugin's transaction is an
internal span, `pluginTx`, with `ob1.plugin`, and no point: its time is the
plugin's own code and SQL, and the operations it calls are spans and points
of their own. The key's registry lookup (`resolveAgent`) runs before
any tool call, so its span is under the request's.

A job's body (`scan_thoughts`) starts a trace of its own, `job <kind>`, linked
to the tool call that started it rather than under it, since it runs on for
minutes after that call has answered; its provider calls and store operations
are its children. A job its timer fails ends its span then, an error with the
job's code (`JOB_TIMEOUT`). Each job is one point on `ob1.job.duration`, in
seconds to an hour, by `ob1.job.kind` and how it failed. A webhook's deferred
work, which runs after its answer, is a trace of its own the same way:
`defer <plugin>`, linked to its delivery's request, with `ob1.defer` (`work`);
a failed delivery's undoing of it (`discard`) runs before its 500, so it is
that request's child. The stop ends whatever of these is still open as `cut`,
with its request — after a drain that finished too, for work the drain does
not count (a store call outside any request). The pool's connections in use
are not counted here: Bun's client does not say them, and the observability
profile's Postgres exporter reads them from the database
(`pg_stat_activity_count` by state). Nor is the workers' traffic: `db/`'s
passes (entity extraction, the consolidation judge, the re-embeds) make the
heaviest provider and database calls, and install no OpenTelemetry, so a
provider-latency panel shows the servers' calls alone (SMD-2910).

`bun preflight.ts --deep` makes each provider probe a span and a point under
the same names, marked `ob1.probe` (`preflight`) so a backend tells them from
the server's calls — a probe's time is to the answer's headers, its error the
status or, where no answer came, the runtime's code, and it carries no token
counts — and sends them before it reports, as `open-brain-preflight` unless
`OTEL_SERVICE_NAME` (or a `service.name` in `OTEL_RESOURCE_ATTRIBUTES`) names
it. Its `telemetry` row says, within 5 s, whether they went: `ok` with where,
naming spans, points or both by what is sent; a warning for an export not
sent, an endpoint that is no URL or has a query string, an SDK that would not
start, or a setting held to its bound or not read and its default used (the
server would share each); a skip when no collector is named, when spans and
points are both turned off or the SDK is disabled, or when no probe ran —
run it in `api`, which holds the OTEL settings. A plain preflight, the one each container start runs, starts no telemetry, so a
stack no one has used yet has a first point only from `--deep`.

Never the URL, a query string, another header, a key, a body, an argument or
any text — `test-server.ts` [22] sends each and looks for it in every span's
name, attributes, events, status, trace state and resource, and a real
`bun index.ts` looks for the key, the query string and the text in all it
exports; [25] looks for a planted query string in every point's labels and
log record, and for a key's name on any point; [26] sends planted text to a
provider and a store and a base's userinfo, and looks in every span and point;
`test-plugins.ts` [16] looks for a deferred fault's message;
`test-preflight.ts` [11] looks in what `--deep` sends; `test-rest.ts` [12]
sends a key, query strings (one a `query=` at `/v1/search`) and a fault's
message and looks in each span's name, attributes, events and status, and in
what a real `bun api.ts` exports.

Where the signals go is the operator's decision: the brain is personal data,
and a collector off this machine is a place it then goes; the `observability`
profile below keeps them on it. What leaves is usage metadata:
per request `http.request.method`, `http.route`, `http.response.status_code`,
`http.response.body.size`, `mcp.method.name`, `gen_ai.operation.name`,
`gen_ai.tool.name`, `ob1.door`, `ob1.rpc`, `ob1.tool`, `ob1.agent`,
`ob1.outcome`, `ob1.code` and `error.type`, a fault's `exception.type` and
`ob1.fault.code`, and the line's fields again in its log record; per tool call
`gen_ai.tool.name`, `ob1.outcome`, `ob1.code` and `error.type`; per provider
call the model, the provider's host and port, its token counts and how it
failed; per store operation its name, the store's kind and a SQLSTATE; per
plugin transaction and deferred work its plugin's name (and `ob1.defer`); per
job its kind; on each of these `db.system.name` where it is the store's, its
`ob1.outcome` and `error.type`, and a fault's `exception.type` and
`ob1.fault.code`; the histograms' points by the labels above; the trace, span
and linked ids, each span's name, kind and status, its parent's id and a
link's flags, timestamps to the nanosecond, and a resource of `service.name`,
`service.version`, `service.instance.id` (a UUID fresh at each start, so the
MCP server and the REST core under one name, or two tiers, are two series;
each start so begins new series, and `OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<name>`
pins one), a pipeline tier's `deployment.environment.name` (`OB1_TIER`)
and `telemetry.sdk.*` (no host, no process) with whatever
`OTEL_RESOURCE_ATTRIBUTES` adds. Together they are a timeline of which client
called which tool, when, and how much came back — so name keys after clients,
not people (`ob1.agent`), before pointing at a collector elsewhere.

A request the server did not accept — no key, one it refused (revoked, busy,
outside the door's scopes), a webhook delivery its plugin refused — sends its
span and log record within 60 a minute per server; past that, its point on
`http.server.request.duration` and its line still count it, the line naming a
trace that was not sent, and one line says how many sent neither: at the
minute's end, by the next minute's first, or at the stop — whether its span
was sampled or not; one begun before the SDK loaded sends neither. Only the
request's own span is held: work it ran under it (a refused key's registry
lookup, a capture a plugin refused after) still sends its spans, without their
parent. A keyless flood otherwise put about 1 KB a request on a collector's
disk (measured on the profile below before the budget: 5,000 in under a
second, about 5 MB; with it, Loki took 28 KB for the same 5,000 and Tempo held
60 of their traces), and its Loki and Tempo expire by age alone. A key
accepted, or a delivery its plugin accepted, is never held to it. A keyed
client can still fill a batch's queue (a 100-call batch, 101 spans), and while
the collector lags what is past it is dropped — said as `queue full` — though
every line is still written.

### The observability profile

The `observability` profile (SMD-1849 PR 3a) runs two more containers and a
one-shot: `lgtm`, Grafana's otel-lgtm image, pinned by digest — an
OpenTelemetry collector taking OTLP on 4318, and Prometheus, Tempo, Loki,
Pyroscope and Grafana behind it — on the stack's machine, on the internal
`mesh` network and the internal `telemetry` one; `pg-exporter`, which reads
Postgres's own numbers into it; and `pg-monitor-role`, the one-shot that sets
its role (PR 3b). Four lines in `deploy/.env` turn it on:

```
COMPOSE_PROFILES=observability      # beside any already there on this one line (auth,observability): a second line replaces the first
GRAFANA_ADMIN_PASSWORD=<openssl rand -hex 24>
OB1_MONITOR_DB_PASSWORD=<openssl rand -hex 32>
OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm.ob1.internal.:4318
```

and one more `-f` file, on every command, is where Grafana is reached
(below) — from a release, beside `compose.release.yaml`:

```bash
docker compose -f compose.yaml -f compose.grafana-port.yaml up -d      # Grafana on http://127.0.0.1:3000/grafana/
```

`COMPOSE_PROFILES` counts only when no `--profile` is on the command line
(measured: with `--profile local-models` there, `lgtm` is not run), so name
every profile in that one line. A hex password needs no quoting; one with a
`$` goes in single quotes, which docker compose otherwise reads as a variable
and cuts short. Spans reach Tempo within seconds of a request, metrics within
a minute (`OTEL_METRIC_EXPORT_INTERVAL`). The profile alone runs a collector
nothing sends to; the endpoint alone sends to a name nothing holds, which each
server says on stderr, a line a minute per signal (`ENOTFOUND`, measured) —
and asks the host's resolvers for it, since the servers are on `egress`. An
`OTEL_*` variable set in the shell compose runs from wins over
`deploy/.env`'s, as every variable does.

Grafana signs in `admin` with `GRAFANA_ADMIN_PASSWORD`. Anonymous access is
off — the image's own default would sign anyone in as Admin — and the
container refuses to start, at every start, with that password under 12
characters (spaces aside) or `admin` (in any case), saying why in its log and
exiting 30 s later, so its restart policy retries at that pace. Grafana keeps
the password it first started with in its database, on the volume: changing
the variable later changes nothing until the operator changes it in Grafana —
its profile page, or from a file holding the new one, kept off the command
line, and deleted after: `compose exec -T -e GF_PATHS_DATA=/data/grafana/data
lgtm /otel-lgtm/grafana/bin/grafana cli --homepath /otel-lgtm/grafana admin
reset-admin-password --password-from-stdin < new-password` (measured). Keep no
credential in a Grafana data source: Grafana encrypts one under its default
key, on the volume.

Where Grafana is reached is the operator's choice, and by default it is
nowhere:
- **On loopback, an origin of its own** — `-f compose.grafana-port.yaml`, a
  release asset: `http://127.0.0.1:3000/grafana/` (`GRAFANA_BIND`,
  `GRAFANA_PORT`), on a network of its own beside `mesh`, which reaches out
  (below). Grafana's root URL is that port, so its links name it and its
  cookie is not `Secure` over the plain http; behind a TLS proxy or tunnel to
  the port, `GRAFANA_ORIGIN` names its https origin instead. Browse to the
  address the root URL names: Grafana Live (Explore's live tail, dashboards'
  live updates) refuses a page from any other (measured: `localhost:3000`
  refused, `127.0.0.1:3000` open). Its own origin keeps Grafana's scripts
  from the stack's pages, not from its cookies: a browser sends a cookie of
  `127.0.0.1`'s to every port there, so with `/auth` used on the stack's
  loopback origin a script in a Grafana page could still send requests that
  carry `/auth`'s session (it could not read their answers). Naming it
  recreates `lgtm` alone.
- **At `/grafana` on the stack's origin** — `-f compose.grafana-public.yaml`,
  reached wherever the stack is: the LAN under `SERVER_BIND`, a tunnel to
  `OB1_PUBLIC_ORIGIN`. Grafana's root URL is then `OB1_PUBLIC_ORIGIN` (unset,
  the stack's loopback origin, so a link Grafana writes to itself names
  127.0.0.1, and Grafana Live refuses a page from any other address; its
  redirects are paths, measured) at `/grafana/`, its cookie `Secure` where
  that is https: over a tunnel, set it to the tunnel's https origin (an http
  one must be loopback, as the authorization server holds it), and name this
  file without the loopback one, whose origin wins when both are named.
  Grafana then shares the origin with `/auth`, the authorization server's
  sign-in and consent, and with `/mcp`: a script that ran in one of Grafana's
  pages would run as the origin, and while the operator's `/auth` session
  lasted it could consent a client of its own, which would then read and write
  the brain. So it is not the default. Without the file `/grafana` is the
  proxy's 404.

Either way Grafana's cookie is `Path=/grafana` (measured), and it sends its
Content-Security-Policy, which narrows which scripts a page runs, not what one
that runs can do.

What it holds, from the servers (the workers send nothing, SMD-2910):
- **Traces** in Tempo: one per request, `tools/call capture_thought` and the
  like, under `service.name` `open-brain-mcp` (the MCP server at `/mcp`, its
  tool call the parent of the REST core's operation, one trace) or
  `open-brain-api` (the REST core), with each tool
  call, provider call and store operation beneath it, and each job's body a
  trace of its own.
- **Metrics** in Prometheus, under this pin's OTLP names, underscored with
  their unit: `http_server_request_duration_seconds`,
  `gen_ai_client_operation_duration_seconds`,
  `db_client_operation_duration_seconds` and `ob1_job_duration_seconds`, each
  a classic histogram (`_bucket`, `_count`, `_sum`), each label the attribute
  underscored (`ob1_tool`, `gen_ai_request_model`, `error_type`); `job` is the
  service's name, `instance` its `service.instance.id`, new at each start, and
  a pipeline tier's `deployment_environment_name` its tier.
- **Log records** in Loki: each request's, its body the line's fields, under
  `service_name`.
- **The database's own numbers** in Prometheus under `job` `postgres`, from
  `pg-exporter` (postgres_exporter, pinned by digest) every 30 s:
  `pg_stat_statements_calls_total`, `_seconds_total`, `_rows_total` and the
  block read and write seconds for the 100 statements that took the most time
  (of those above the tenth percentile of total time: the exporter's own query
  leaves out the rest), each by `queryid`, `user` and `datname`, with
  `pg_stat_statements_query_id_total` naming each `queryid`'s normalized text
  cut to 120 characters (constants are `$1`, `$2`; `SELECT count(*)::int AS c
  FROM match_thoughts($1 ::vector, …)`, measured); connections by state,
  `pg_stat_activity_count` by database and state — the servers' pool among
  them, which their client cannot count — and the exporter's default
  collectors (`pg_up`, locks, database sizes, the WAL). The statements are the
  server's, the workers' and the migrator's alike; the exporter's own are left
  out. Postgres starts with `pg_stat_statements` preloaded on every stack and
  tier, with utility statements untracked, so an `ALTER ROLE … PASSWORD` is
  never recorded with its text, and with `track_io_timing` on, which the block
  times need (CI's "Postgres counts the brain's statements" holds all three).
  Those are `-c` flags on Postgres's command, which outrank `postgresql.conf`
  and `ALTER SYSTEM`: a library of your own to preload goes in
  `POSTGRES_PRELOAD_LIBRARIES` in `deploy/.env`, beside `pg_stat_statements`,
  which the list must keep
  (`POSTGRES_PRELOAD_LIBRARIES=pg_stat_statements,auto_explain`). The image
  ships Postgres's contrib modules (`auto_explain` among them) and pgvector,
  not `pg_cron` or another extension: a library it does not have stops
  Postgres at its start, on every tier that copies the setting. Migration 096
  creates the extension only as a superuser may: a migrator that is not one
  leaves it out and says so. Its views are `pg_monitor`'s alone, and each
  plain migrate run takes back a grant to `PUBLIC` that a restore without
  privileges gives back (a tier refresh's). `pg-exporter` reads as
  `ob1_monitor`, a member of Postgres's read-only `pg_monitor` alone, which
  `pg-monitor-role` sets from `OB1_MONITOR_DB_PASSWORD` (24 or more of A–Z a–z
  0–9 _ -) at each `up`: unset or short, `up -d` fails naming
  `pg-monitor-role`, whose log (`compose logs pg-monitor-role`) says what to
  set, and `pg-exporter` is created but never started; the rest of the stack
  comes up (measured). It is on `data`, where Postgres is, and on the internal
  `telemetry`, where the collector scrapes it; it publishes nothing, is
  read-only, holds no capability. The exporter listens on the container's
  loopback alone (SMD-3023): its `/probe`, which postgres_exporter cannot turn
  off, dials whatever Postgres target and credentials its caller names, so a
  caller that reached it could try passwords against Postgres. On port 9187
  the image's busybox `httpd` answers instead, on the container's `telemetry`
  address alone, so no container on `data` reaches it, and with one path,
  `/cgi-bin/metrics`: a script that makes its own request to the exporter's
  `/metrics`; every other path, `/probe` among them, is a 404. If the
  exporter or `httpd` stops, the container exits within 35 s and restarts
  (measured on podman: 37 s from `httpd`'s kill to the new start, 35 s from
  the exporter's; while the exporter is down a scrape is a 502).

Grafana opens on the stack's own dashboard, **Open Brain**, provisioned at
each start as `/grafana/d/ob1` in a folder of that name (its home page is the
same file, at `/grafana/d/default-home-dashboard/open-brain`; the image's own
dashboards are under Dashboards) from `deploy/observability/dashboard.json`,
which compose.yaml carries inline as the `grafana-dashboard` config (check 37
holds the copy to the file, and every Prometheus name and label its queries
read to one the stack writes; CI's "The observability profile's dashboard
reads every series it names" runs each query on the pinned images). `lgtm`
carries the file's sha256 as a label, so an `up -d` after the dashboard
changed recreates it: compose recreates a container for a changed label, not
for a changed inline config alone, and recreating it restarts Prometheus, Loki
and Tempo, which replay their write-ahead logs while the servers' sends fail
for those seconds. Grafana's home is the dashboard only where no user or
organisation has picked a home of its own. Prometheus ingests a zero at the
start of each of the servers' series (`created-timestamp-zero-ingestion`):
their counters are born at their first count, which a rate otherwise never
counts, so one failure would read 0 (measured); series already stored are as
they were. The series the collector scrapes — pg-exporter's and its own — get
no such zero, so its losses have totals beside their rate. Its rows, each
panel saying what it counts:
- **Requests**, every server: per second by door and the tool each ran (an
  MCP tool call's, a REST route's operation, a mirror's; a keyed `/health` is
  `brain_info`'s), latency p50 and p99 by tool, by outcome, the share the
  server failed (`error`, `stalled`, `cut`; a refusal is the caller's), and
  those failures by fault code or outcome.
- **Model provider**: calls per second by model, latency p50 and p99 by
  operation, and failures by status or kind.
- **Store**: operations per second and p99 by the store's method, and its
  errors split into refusals (SQLSTATE classes 22, 23, P0 and the brain's own
  OB), faults (every other code: the database's, and the driver's or the
  network's where the store cannot reach it) and operations a stop cut. A
  method (`matchThoughts`) is not a statement, so this row and Postgres's are
  read side by side, not joined.
- **Jobs**: by kind, with their error type and p99.
- **Postgres**, this stack's own whatever the tier: the statements that took
  the most time over the range, with their text, calls and mean — among the
  100 the exporter reads, those with the most time since Postgres's statistics
  were reset, so one that grew costly lately but is not among them is missing;
  the brain's own SQL functions' mean time per call (`match_thoughts` beside
  the bench numbers); connections by role and state, the servers' pools among
  them; the buffer cache's hit ratio, the databases' sizes, and whether the
  collector reaches pg-exporter and it Postgres.
- **Requests not ok, and the telemetry itself**: the request records whose
  outcome was not ok and the traces that ended in error, by server alone (a
  path-mode canary's are among them whatever the tier), and the spans, points
  and records the collector refused or could not store, per second and in
  total since `lgtm` started.

Its variables pick the server (`open-brain-mcp`, `open-brain-api`, each server's
own `service.name`), a pipeline tier (for the request, provider, store and job
rows; a stack that is no tier sends none, so All takes a path-mode canary's
beside stable's and stable alone cannot be picked) and the database (All takes
every one but Postgres's templates, the brain's being `openbrain`). Grafana
will not save a change made to it — it is provisioned (measured) — so save a
copy, in a folder of your own, to keep one (the removal under "Alerts" deletes
the Open Brain folder's contents); to change the stack's own, export the copy's JSON (not "for
sharing externally", which writes `${DS_…}` placeholders) over
`deploy/observability/dashboard.json`, put back its uid `ob1`, its title `Open
Brain` and `"editable": false` (a saved copy has its own of each; check 37
says so), and run `bun scripts/inline-grafana.ts`, which writes
compose.yaml's inline copy and `lgtm`'s labels. Loki refused every record with
the disk under `lgtm-data` 92% full (measured on a podman machine; its
write-ahead log's threshold is 90%), answering the collector "Ingester is
shutting down": only `lgtm`'s own log and the dashboard's last two panels say
so. The records sent meanwhile are lost; free room (`compose exec lgtm sh -c
'du -sh /data/*'` says what each backend holds), then `compose restart lgtm`
(whether Loki takes records again by itself once under 90% is unmeasured).
Nothing on the dashboard shows the disk itself.

**Alerts** (SMD-3050): Grafana also loads five alert rules from
`deploy/observability/alert-rules.yaml` at each start, into the Open Brain
folder, each evaluated every 30 s:
- **A server stopped sending metrics**: a server that sent `process.uptime`
  in the last day and nothing in the last 10 minutes, for 2 more minutes (a
  host waking from sleep catches up inside them): stopped, or not reaching the
  collector. The servers, and `mcp-server/` where it runs, send that gauge at
  every metric export from their start, called or not; `preflight.ts --deep`
  sends none. It reads a 10-minute window, so it needs
  `OTEL_METRIC_EXPORT_INTERVAL` well under 10 minutes (the default is 60 s).
  Until a day has passed it also fires for a server stopped on purpose (a
  path-mode canary sending here, taken down, among them) and, under the old
  name, for one whose `OTEL_SERVICE_NAME` or `deployment.environment.name` (in
  `OTEL_RESOURCE_ATTRIBUTES`) changes. Measured: the REST core stopped, pending
  10.5 minutes on and firing at 12.5; normal 30 s after it started again.
- **The server failed requests**: over 5% of a server's requests over 10
  minutes `error`, `stalled` or `cut`, about three or more of them, for 5
  minutes. "About": Prometheus estimates a count over a window from its
  samples, so this rule's and the next one's threshold, 2.5, is not an exact
  line between two and three.
- **The model provider failed calls**: about three or more of a server's
  failed provider calls of one operation and error type over 10 minutes, for 5
  minutes; `preflight.ts --deep`'s probes are not counted (it says how they
  went itself).
- **The exporter does not reach Postgres**: the collector reads pg-exporter
  `up` 0, or pg-exporter reads Postgres `pg_up` 0, or either series is gone,
  for a minute (measured: pg-exporter stopped, pending in 26 s and firing in
  89 s; normal 27 s after it started again).
- **The collector is losing telemetry**: spans, points or records refused,
  dropped from a full queue or not stored (Loki refusing records past 90% full
  among them), for 10 minutes. The collector retries an export for some
  minutes before it counts it as failed, so this is pending about 7 minutes
  after the loss begins and firing 10 after that (measured: Loki stopped, the
  first failure counted 4.6 minutes on, the rule pending 2.7 minutes after
  that).

No contact point ships, so nothing leaves the machine: Grafana 13's default
notification policy sends to `empty`, which has none, and a rule that fires
shows only in Grafana's own lists (Alerting → Alert rules, and Alert groups).
To be told, add one: Alerting → Notification configuration → Contact points →
New contact point (a webhook, Slack or another chat needs only its own
settings; email needs Grafana's SMTP settings, which this stack does not set),
then the Notification policies tab → Default policy → ⋯ → Edit → Default
contact point. Grafana keeps both in its database on `lgtm-data`, so they
outlast an upgrade, and a secret the contact point holds — a webhook URL with
its token — is in that volume. Each notification carries the following, and
no key or thought's text (measured on a webhook's delivery):
- the rule's title (as `alertname`), its uid, the folder (`grafana_folder`)
  and Grafana's version;
- the labels its result keeps — `service_name`, `deployment_environment_name`,
  `gen_ai_operation_name`, `error_type` at most (check 38 holds each rule to
  these) — or, where a rule has no data to read (the Postgres rule with no
  `up` series), `datasource_uid` and `ref_id`. An `error_type` is an HTTP
  status, a kind (`timeout`), or an error's code or name, never its message;
  `service_name` and the tier are the servers' own names unless
  `OTEL_SERVICE_NAME` or `OTEL_RESOURCE_ATTRIBUTES` sets them, and then carry
  what you wrote there;
- its annotations, the query's value, and links back to Grafana at its root
  URL — `/grafana/` on `LGTM_ORIGIN`, which is the stack's own origin unless
  `compose.grafana-port.yaml` gives Grafana its own.

Where a rule's query fails (Prometheus down), Grafana sends a
`DatasourceError` alert instead, naming the rule (`rulename`, with
`datasource_uid` and `ref_id`) and carrying Grafana's error text, which names
Prometheus's address inside `lgtm` (`127.0.0.1:9090`); its summary reads
`[no value]` where it names a label (measured).

The rules are provisioned: Grafana shows them so and will not save a change to
one (measured). To change one, edit the file, run `bun scripts/inline-grafana.ts`
(it writes compose.yaml's `grafana-alert-rules` copy and `lgtm`'s sha256
label, as for the dashboard; check 38 holds the copy, and each query's names
and labels as check 37 holds a panel's) and `compose up -d`, which recreates
`lgtm`. A file Grafana cannot load stops `lgtm` at its start (measured: an
interval of 15 s, a 41-character uid), so `compose ps lgtm` says whether it
came up. A rule taken out of the file stays in Grafana, still evaluating and
notifying, until the file names it under a top-level `deleteRules:`
(`- orgId: 1` with `uid: <its uid>`); Grafana's rule API refuses to delete it
(measured). Take the entry out once `up -d` has removed the rule: while it
stands, a rule of that uid in the file loads nothing, without a word
(measured; check 38 refuses both in one file).

To remove every rule at once (rolling back, say), delete the dashboard's
folder with its rules forced. That also deletes anything else saved in that
folder, a copy of the dashboard among them, so move those out first. From
`deploy/`, with the `-f` files the stack was started with, `podman compose`
the same:

```bash
docker compose -f compose.yaml exec lgtm bash -c 'a="admin:$GF_SECURITY_ADMIN_PASSWORD"; g=http://127.0.0.1:3000/grafana; u=$(curl -fsS -u "$a" "$g/api/dashboards/uid/ob1" | grep -o "\"folderUid\":\"[^\"]*\"" | head -1 | cut -d\" -f4); test -n "$u" || { echo "no Open Brain dashboard, so no folder to delete" >&2; exit 1; }; curl -fsS -u "$a" -X DELETE "$g/api/folders/$u?forceDeleteRules=true"'
```

The dashboard is back within seconds, its provider reading the file again,
and the rules still in the file come back at `lgtm`'s next start (measured).

The servers send Pyroscope no profiles; it keeps about 70 MB of its own state.
All of it is in one volume, `lgtm-data`: Prometheus keeps 15 days, Tempo 14
and Loki 14 (its retention switched on: the image's default keeps every record
for ever), each read back from the running backend. A keyless request is
about 1 KB there, and a request the server did not accept is held to 60 a
minute per server ("Traces, metrics and log records" above): at most about
1.2 GB per server over the 14 days. `compose exec lgtm sh -c 'du -sh /data/*'`
says what each backend holds. Its health is each backend's own ready URL:
one that dies leaves `lgtm` unhealthy in `compose ps` (measured: Loki killed,
unhealthy within a minute), not restarted, since neither Docker nor Podman
restarts an unhealthy container by default — `compose restart lgtm` brings it
back. Idle, the container held 463 MiB of memory and
was ready 4 s after it started (measured on podman 6, macOS); its image is
2.6 GB on disk.

It calls out to nothing by itself: what it would call is off — Grafana's
plugin fetches, signing keys and preinstalled apps (so no Drilldown apps),
usage reports, update checks, news feed, gravatars, cloud migration and
external snapshots, and the backends' usage reports. On `mesh` and
`telemetry`, both internal, it has no outward network; with
`compose.grafana-port.yaml` its port's network reaches out, as Postgres's does in `compose.host-ports.yaml` (measured), and the
switches are what keep it quiet. Snapshots, public dashboards and Grafana's
own `/metrics` are off: each would show data without a sign-in. On `mesh` only
Grafana (3000), the collector's OTLP (4317, 4318) and its health check (13133,
which says only that it is up) answer: Prometheus, Tempo, Loki and Pyroscope
listen on the container's own loopback, server, gRPC and gossip ports alike
(each port probed from the mesh). Grafana's data-source proxy is held to those
four, but a data source's own queries are not: Grafana's admin reaches every
name on `mesh` — the MCP server, the REST core, the authorization server, a joined tier
(measured: a data source at the REST core) — where the servers ask for a key
and the authorization server for the operator's password, its discovery and
registration aside — and on `telemetry`, `pg-exporter`'s `/cgi-bin/metrics`
alone (SMD-3023); with `compose.grafana-port.yaml`, the LAN and the host
too, through the port's network — on Docker Desktop and a podman machine by
`host.docker.internal`, its loopback ports included (a host Ollama, Postgres's
port with the host-ports file); on Linux the host's other listeners, by the
network's gateway. The image's own sample dashboards (RED metrics, JVM) read
other names; this stack's is Open Brain, above.

A canary (`deploy/canary.sh`) is not on stable's `mesh` (SMD-2874), and its
env file is made from stable's at its first `up`: with the endpoint in
stable's by then, its servers say `ENOTFOUND` for `lgtm.ob1.internal` until
the endpoint is out of its file (`OTEL_EXPORTER_OTLP_ENDPOINT=
deploy/canary.sh up`, an empty one in the shell, keeps it out of the canary's
servers without an edit); `up` says so. `GRAFANA_*` and `OB1_MONITOR_*` are never carried.

**Turning it off**: take `observability` and the endpoint out of
`deploy/.env` and `compose up -d` without the Grafana `-f` files, then
`compose rm -sf lgtm pg-exporter pg-monitor-role` (measured: it takes `lgtm`
with the profile no longer named, and the role step's exited container;
`ob1_monitor` stays, a login with no grant but `pg_monitor`,
`DROP ROLE ob1_monitor` to remove it) — `up` leaves a service of a profile no longer named running, as it
does the workers' — and `docker network rm
<project>_grafana-port <project>_telemetry`, which outlive the file and the
services (measured); remove its volume
by its exact name
when its data should go too, `docker volume rm <project>_lgtm-data` (never a
prune), which takes Grafana's password with it: the next start reads
`GRAFANA_ADMIN_PASSWORD` afresh, the way to start over from a forgotten one.
Kept, the volume keeps any contact point too, so notifications resume at the
profile's next start.
**Rolling back** to a release from before it needs `up -d --remove-orphans`,
or `lgtm` and `pg-exporter` run on as orphans, `lgtm` on `mesh` and its port,
`pg-exporter` on `data` signed in to Postgres; `ob1_monitor` stays either way
(`DROP ROLE ob1_monitor`, as above). Rolling back to a release with the profile
but before its alert rules (SMD-3050) leaves the five rules in `lgtm-data`,
still evaluating and sending to any contact point, with no file to delete them
from (measured): remove them first, or after, with the folder command under
"Alerts" above.

## Keeping the board in the brain

The fork's own brain holds its Linear board — every issue in the Open Brain
initiative's projects as one thought, in the shape the hand captures used. Until
SMD-1954 that was a paste per ticket, and a ticket that moved to Done kept
reading Backlog until someone pasted it again, which made a second row. The
coordinator's `board-sync` pass is that sweep, unattended:

```bash
# deploy/.env: LINEAR_API_KEY=lin_api_…  (and OB1_LINEAR_INITIATIVE when the
# initiative is not "Open Brain"), and board-sync in OB1_PASSES
podman compose -f deploy/compose.yaml up -d coordinator
podman compose -f deploy/compose.yaml logs -f coordinator
```

Each pass stamps a heartbeat, `heartbeat:board-sync` in `ob1_config`
(SMD-2261). Preflight's `workers` row, the keyed `/health` body and `brain_info`
read it. The row warns at once when it says it stopped (`compose stop coordinator`)
or its supervisor holds it — a refusal, which it tries again on its own, the
row saying when and which: no `LINEAR_API_KEY`, an initiative that is not one
board, an interval or findings cap it does not take, an endpoint the egress
policy refuses wholesale, each with its remedy (SMD-3214) — and once the
heartbeat is older than three intervals: the coordinator stopped or removed. It names `up -d --no-deps
--force-recreate coordinator`, with the `-f` files and `-p` the stack was started with. Just after `up`, the server's
preflight can read the row a `down` left before board-sync's first pass stamps
it; such a warning in the start-up log clears on the next `bun preflight.ts`.
`db/README.md`, "Long-running workers report their liveness", has the row's
shape.

Every `OB1_BOARD_SYNC_INTERVAL` seconds (300), on the coordinator's clock
(SMD-3476; the tool's own `--loop` is retired), `bun db/sync-linear.ts
--trigger`, which the coordinator starts and signals, runs a pass: a few
requests list every issue's identifier, last-updated time and names (a hundred
a page), one query reads the brain's ticket rows, and the difference is the
work — a new issue is captured (vector, tags, and the facets Linear knows:
project, status, priority, labels, parent), a moved or edited one is updated in
place with a fresh vector, an unchanged one costs nothing. There is no state file: the brain
is the state, so a pass that dies is finished by the next one. The same command
runs from a checkout against any brain (`bun db/sync-linear.ts --url … --audit`
is the lockstep census alone; `db/README.md`, "The board in the brain"). The
scheduled form is the one built here; a Linear webhook is exact and immediate
but needs an inbound route — a router on the proxy (SMD-1846) and a public
origin a vendor can reach (SMD-2382) — and the handler's shape (signature, replay window, loop guard) is SMD-1862's.

**Telling the board what consolidation found** (SMD-2681). Set
`LINEAR_COMMENT_API_KEY` in `deploy/.env` — a Linear key of its own that can
comment, not `LINEAR_API_KEY` — and, under the default egress policy, add
`type:board-finding` to `OB1_EGRESS_ALLOW`.
Each pass then ends by posting a consolidation finding between two tickets the
board does not link (a pending `outdates` proposal, or a standing `related`,
`evolves` or `duplicate` relation) as one comment on the newer ticket: what the
judge found and how to act on it. It proposes only, never adding a link or
moving a status. At most `OB1_FINDINGS_POST_CAP` (5) comments go out in any 24
hours, and a ticket pair is told once per finding word. Without the term the
start-up log says the step is off; `bun db/board-findings.ts --url … --dry-run`
prints what it would post. `db/README.md`, "What it tells the board", has the
rules.

## Extraction and consolidation as passes

Once extraction has run on a brain, each capture is queued for it as it
lands, and an extracted thought joins consolidation's pool, but nothing does
the work until a worker runs. The coordinator's `workers` pass runs both,
each a child of its own: `db/extract-entities.ts --follow` as `extract` and
`db/consolidate.ts --follow` as `consolidate`. Each drains its pool, then
polls for new work.

**Two passes, pick one.** `workers` runs both followers always, at low
concurrency, beside live traffic. `sleep` runs the same two
passes, and re-embed when the brain has vectors to re-embed, only while the brain is quiet, at most an hour a sleep by default, and
stops them within seconds of the next live call ("The `sleep` pass
instead", below) — so a backlog, and a sync write's capture made after a
sleep's clock, waits for the next live call and the quiet. They are alternatives,
not companions: `OB1_PASSES` naming both runs `sleep` alone, and the log says
so (SMD-3476). The scheduler itself will not run beside a follower run outside
it — by hand, or an old stack's container — it refuses at its start, and when
one starts later it ends (exit 2) before its next sleep begins, or within a
poll if asleep; its supervisor then tries it again every few minutes, so it
starts on its own once the followers stop. The rest of this section is the
`workers` pass.

**The cost comes first.** Extraction makes a model call per thought (per
window of a long one), and consolidation up to three, one per judged pair. On
a local model that is GPU time: the dogfood brain takes 50 to 90 thoughts a
day, and on `qwen2.5:7b` a thought's extraction took 37 s at the median (two
workers), so a follower is idle most of the day. On a hosted provider it is
money per call, and each thought's text goes to the provider under the egress
policy. Decide before you enable it.

The first start drains a backlog — every thought already in the brain — so
extraction runs alone first, a one-off that does the backlog and exits, and
`workers` is named once the backlog is done ("Extraction alone on a
backlog", below). Mint the worker key, append the line keygen prints to
`MCP_ACCESS_KEYS` (comma-separated), set the raw key as `OB1_WORKER_KEY` in
`deploy/.env`, and run extraction, detached, as a one-off of the
coordinator's — the extract pass's script, as its user with its settings
(`db/coordinator.ts run <pass> [args…]`):

```bash
(cd server-portable && bun keygen.ts --name workers --scope capture)
podman compose -f deploy/compose.yaml run -d --rm --no-deps coordinator db/coordinator.ts run extract --workers 1
```

Then read where it stands, as often as you like:

```bash
podman compose -f deploy/compose.yaml run --rm --no-deps coordinator db/coordinator.ts run extract --status
```

Its `status:` line counts the pool. The backlog is done when it reads `0 in
flight, 0 pending, 0 not yet in the pool`. "0 pending" alone is not enough:
the last thought may still be in flight, and until the follower's first pass
the backlog is "not yet in the pool". If it also reads `N failed`, retry
those now, while no newer thought has been judged without them, and wait for
the line again:

```bash
podman compose -f deploy/compose.yaml run --rm --no-deps coordinator db/coordinator.ts run extract --retry-failed --workers 1
```

Then name `workers` in `OB1_PASSES` in `deploy/.env` and recreate the
coordinator, which starts both followers:

```bash
podman compose -f deploy/compose.yaml up -d coordinator
podman compose -f deploy/compose.yaml logs -f coordinator
```

From then on the stack's `up -d` brings both back, and a plain `down` stops
them with the rest: the coordinator is one of the stack's default services.

**What each one is:**
- **Identity.** Both need a worker key, and are held, never started, without
  one, so what they write carries its agent id. A key the database cannot
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
- **Code.** The coordinator runs the server image, which carries `db/`'s
  passes since SMD-3476, so they are the release's own and a stack with no
  checkout runs them too. A changed `db/` reaches them when the image is
  rebuilt and the coordinator recreated (`up -d --build`), as the servers'
  code does.
- **Stopping.** `stop coordinator` lets each worker finish the thought it
  holds: the coordinator passes the signal on to every pass. Its grace period
  is 120 s (a thought's extraction took 121 s at p90 on the stable brain).
  Inside it the coordinator exits 0; past it the container is killed (137). Either way it stays stopped, and
  a thought still held is not lost: its lease lapses after 900 s and the next
  run takes it (a thought whose lease lapses three times is recorded failed).
- **Refusals.** A configuration refusal exits 2: no key, a key
  `MCP_ACCESS_KEYS` does not hold, a revoked key or one whose scope grants
  nothing (`forward`), a setting that is not a number the CLI takes, an egress
  policy that would refuse every call (`OB1_LLM_LOCAL` unset against a host
  Ollama), or (`extract`) a model or prompt version other than the one the
  brain's extraction key records. So does a provider that refuses the
  follower's first call at start — a model it does not serve, a refused key,
  a wrong base URL (SMD-2599). The coordinator does not exit: its supervisor runs
  the follower again after 1, 2, 4, 8, then every 15 minutes, and preflight's
  `workers` row says it is held, the refusal by its kind with the kind's
  remedy, and the next try (SMD-3214).
  No key, or a setting that is not digits, the supervisor refuses itself,
  before the follower starts, and holds until the coordinator is recreated.
- **Outages.** A follower waits out the database going away (it checks
  again after 5 s, doubling to 5 min) and a provider outage — a transient
  error past its pauses, a 404 naming the model while Ollama pulls it, a
  timeout its probe cannot get past — and says so in its log. The thought in
  hand goes back to the pool unrecorded, and the follower probes with a
  one-token call until the provider answers; a thought that fails again
  within 15 minutes of that is recorded failed, as its own fault (SMD-2599).
  An unreachable provider at start is waited for too. None of these exits,
  so none waits on the supervisor's clock.

**Changing the model.** A new `OB1_METADATA_MODEL`, or a checkout whose
extraction prompt version moved (after a pull), is a new extraction key, and
`extract` refuses it until told. Stop both followers BEFORE the change
reaches them:
- a running `extract` keeps extracting under the old key, over what the
  switch writes;
- a `consolidate` recreated under the new key judges every thought against
  the old model's entities, and never judges the new ones.

A plain `up -d` after the change recreates the coordinator, which starts
both, so stop them before you pull or edit — stopping the coordinator, which
stops its other passes too. Then run the switch once — a backlog, so it ends
as the first start does:

```bash
podman compose -f deploy/compose.yaml stop coordinator
# now edit deploy/.env, or move the checkout
podman compose -f deploy/compose.yaml run --rm --no-deps coordinator db/coordinator.ts run extract --switch-key --workers 1
```

Check that it exited 0, read `--status` until the done line, and retry any
`N failed` (the first start's two commands, above) before consolidation
comes back. Then bring the followers back with the REST core, whose
capture-time tagging reads the same `OB1_METADATA_MODEL`:

```bash
podman compose -f deploy/compose.yaml up -d api coordinator
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

**Extraction alone on a backlog.** A pair is judged once, from its newer
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
- an older thought whose embedding failed (the servers' vector mender embeds
  it once the provider answers and the gate allows, SMD-2889; `db/reembed.ts`
  does a whole brain);
- an import dated older than thoughts already judged.

**Consolidation applies no proposal.** Each proposal waits for a person. One whose text moved under it (a stale row) is judged
again by the next pass, which settles it unless the conflict still stands,
when it waits for a person again (067). `--list` shows the queue.
`--accept <id>` or `--reject <id>` decides one, with `--note` giving your
reason. When the listing says the judge did not state which thought is
current, an accept needs `--direction newer` or `--direction older`.

Since migration 084 the pass also stores its related, evolves and duplicate
verdicts as `relation` facets on the newer thought — edges, not proposals,
nothing to review (`--list relations` lists them) — and since 102 a pair it
calls unrelated as a `distinct` one, two near neighbours kept apart (`--status`
counts them; SMD-3117). The pass connects as the
superuser, so it stores them. A brain that ran the pass before 084 has none for
the thoughts judged then: `--status` counts them and prints the `DELETE FROM
thought_work_claims …` that has the next pass judge exactly those again (their
model calls again), run with `podman compose -f deploy/compose.yaml exec
postgres psql -U postgres openbrain -c "…"` (`db/README.md`, "Consolidation:
proposing which thoughts supersede which").

```bash
podman compose -f deploy/compose.yaml run --rm --no-deps coordinator db/coordinator.ts run consolidate --list
```

A decision, accept or reject, is recorded under the agent of the key in
`OB1_WORKER_KEY` — on the proposal's row since migration 114, and in
`thought_audit` too when it writes or clears a pointer — which in this
container is the workers' key. To have it recorded as yours, give your
own key, one `MCP_ACCESS_KEYS` holds, to that one command: set before it on
the same line, it reaches neither your shell nor the next command, and the
bare `-e` passes it into the container without putting it on the command
line:

```bash
OB1_WORKER_KEY="$(cat ~/.config/ob1/my-key)" podman compose -f deploy/compose.yaml run --rm --no-deps -e OB1_WORKER_KEY coordinator db/coordinator.ts run consolidate --accept <id> --note "…"
```

The run prints `agent: <name>` first; check it names your key. Do not
`export OB1_WORKER_KEY`: compose reads the shell before `deploy/.env`, so
every later compose command in that shell — an `up -d` included — would
start the followers under your key. Without the prefix, the decision is the
workers' key's.

The decision then prints `decided by: <your key's name> (<its kind>)`, and
`--list accepted` or `--list rejected` shows the same line on each row
(SMD-2608); `--list` is the only place that shows it for now — the
`list_supersession_proposals` tool, `GET /v1/proposals` and the GUI's
`/dashboard/proposals` do not yet (SMD-3338). The kind is the one the registry
held for the key when it decided: classify your key and the workers' key first
(`SELECT set_agent_kind('<key name>', 'operator')`, as `SETUP.md` says, and
`'agent'` for the workers' key), or the line reads "a key the
registry has not classified", and a kind given later reads "classified after it
decided". A decision under the workers' key — yours without the prefix, or the
pass settling a stale row it no longer finds in conflict (067) — reads
`decided by: <the workers' key's name> (…)` either way; the pass's settle carries a note beginning
`settled by the pass:`. A row decided before migration 114 reads "not
recorded" unless its decision wrote or cleared a pointer, whose audit row names
the key. Accepting unattended waits on a judge that can tell conflicts apart
(SMD-1873).

### The `sleep` pass instead

`sleep` in `OB1_PASSES` runs `db/sleep.ts --follow`, the sleep scheduler
(SMD-1794, SMD-2678), as the coordinator's child. It runs the `workers`
pass's two followers' work, and re-embed, only while the brain is quiet — `OB1_SLEEP_QUIET` seconds (unset, 300)
with no live call — the re-derive sweep, then re-embed when the brain has
vectors not at `OB1_EMBEDDING_MODEL`, or thoughts with none (SMD-2679; none
on a brain the server embeds at its own model, so no embedding call), then
extraction, and
consolidation beside it once extraction's pool is drained, so the backlog
order above is built in. Anything that refuses re-embed — the embedding
key, credit, the model not served — or its endpoint down sets it down for
that sleep, said in its log and on `heartbeat:sleep`, and extraction and
consolidation run on; the next sleep with work tries again. **Upgrading a
brain from before migration 021:** its unlabelled vectors are re-embedded and
labelled by the first sleeps, one embedding call a row, before extraction;
`bun db/reembed.ts --dry-run` says how many first. A brain recording another
embedding model than the stack's sets re-embed aside, said in its log and on
`heartbeat:sleep` (preflight's `sleep` row says it, with both ways out where
it can print the model names), and the others run on: run `bun db/reembed.ts --switch-model` (db/README.md's
re-embed section), or put `OB1_EMBEDDING_MODEL` (and `OB1_EMBEDDING_DIM`)
back and recreate `api` and the coordinator, which read them once. On the next live call it stops them within `OB1_SLEEP_POLL` seconds
(unset, 5; the sweep's call in hand gets 2 s more, then is cancelled): the
model call in hand is aborted and every lease returned, and the brain is
quiet again `OB1_SLEEP_QUIET` seconds after the last one. A sleep runs at most
`OB1_SLEEP_BUDGET` minutes (unset, 60), and the next begins after a live call
(**Settings**, below). Each pass's cost is the same as under `workers`, spent
only while nobody is using the brain.
`db/README.md`, "Sleep", has the full rules.

**What wakes it.** A live write: one through a key that is not classified
`ingested` (board-sync's sync writes are; the servers' vector mender's are
marked background and do not wake it either). That is the "live call" these
sections name. A search does not wake it, whatever `OB1_QUERY_LOG` says: a
running pass costs a search 24–33 ms, so its passes go on through a session of
searches (SMD-3315). Preflight's `sleep` row says whether it is asleep, with
its last sleep.

**First start.** The same worker key as the `workers` pass (`OB1_WORKER_KEY`,
its line in `MCP_ACCESS_KEYS`), and `sleep` in `OB1_PASSES`, then:

```bash
podman compose -f deploy/compose.yaml up -d coordinator
podman compose -f deploy/compose.yaml logs -f coordinator
```

The log says `asleep:` when a sleep begins, `extraction drained — consolidating
beside it`, and `awake:` with the live call that woke it; `budget:` at its start
names the budget in force, and a sleep it stops says why — `the sleep's budget
is spent (60 min)`, `… still in hand 300 s past the budget — stopped now`, or
`<pass>: a statement passed the pass's statement_timeout (300 s)` with `the
sleep stops on its budget` — and a quiet night's clock with nothing left to do
says `the sleep's clock is spent (60 min) with nothing left to do — it ends`.
Each sleep begins with the re-derive sweep, which says `re-derive: N orphaned
lineage row(s) swept` when it deletes any.
The settings go out as startup parameters, which a transaction pooler
(PgBouncer, a managed host's pooled endpoint) refuses: the scheduler connects to
Postgres directly, as the stack's own does. `extract-entities.ts
--status` (the command above) reads its progress, and a status read is not a
live call. The coordinator is a default service and `unless-stopped`, so the
stack's `up -d` and a reboot bring it back ("After a reboot", above), and a
plain `down` stops it with the rest.

**From the `workers` pass.** Name `sleep` in `OB1_PASSES` in place of
`workers` and recreate the coordinator: it stops the followers and starts the
scheduler, never both at once. Then delete the followers' rows, or
preflight's `workers` row asks for them back. A follower run outside the
coordinator — by hand, or an old stack's `extract` and `consolidate`
containers, which `up -d --remove-orphans` removes — still keeps the
scheduler down: it refuses to run (exit 2, its log naming them) while a
follower's heartbeat is fresh, at its start or when an awake or asleep poll
finds one, since a follower does not yield to a live call. A follower stopped
cleanly marks its row ended, so the refusal lifts at once; one killed past
its grace leaves its row fresh for up to three of its intervals (3 min). The
coordinator does not exit on the refusal: its supervisor tries again after 1,
2, 4, 8, then every 15 minutes (SMD-3214), and preflight's `sleep` row says it
is held and names the followers keeping it down.

```bash
# deploy/.env: OB1_PASSES=sleep (in place of workers)
podman compose -f deploy/compose.yaml up -d coordinator
# delete the followers' rows the log or preflight names, e.g.
podman compose -f deploy/compose.yaml exec postgres psql -U postgres openbrain -c "DELETE FROM ob1_config WHERE key LIKE 'heartbeat:extract:%' OR key LIKE 'heartbeat:consolidate:%'"
```

**Settings.** `OB1_SLEEP_QUIET` (1–86400), `OB1_SLEEP_POLL` (1–60, the most a
pass runs beside a live call) and `OB1_SLEEP_WORKERS` (each pass's workers,
unset 1), digits only (`deploy/.env.example`). The budget (SMD-2679):
`OB1_SLEEP_BUDGET`, the longest a sleep runs in minutes (0–10080, unset 60; 0
for no clock) — at it the passes stop after the thought in hand and the next
sleep waits for a live call — and each pass's session settings:
`OB1_SLEEP_STATEMENT_TIMEOUT` in seconds (0–86400, unset 300; 0 leaves the
role's or the database's own: a statement past it stops the sleep, not the
scheduler), `OB1_SLEEP_WORK_MEM` and `OB1_SLEEP_MAINTENANCE_WORK_MEM` in MB
(1–2097151, unset 4 and 64). Preflight's `sleep` row says the budget, why the
last sleep stopped, and how many sleeps stopped on it. **The clock is on by
default:** upgraded, a quiet night holds the model for an hour, and the rest
of a backlog waits for the next live call — `OB1_SLEEP_BUDGET=0` and a
recreate restore the old behaviour, a larger value drains a backlog sooner. The scheduler reads its
environment once, so recreate the coordinator after changing any of them, the
key or the model: `podman compose -f deploy/compose.yaml up -d coordinator`.
A `restart` keeps the values it was created with.

**Reading a pass pair by pair** (SMD-3203). With
`OB1_SLEEP_DUMP_DIR=/var/lib/ob1/sleep-dumps`, where the coordinator mounts its
`sleep-dumps` volume, each consolidation pass appends every verdict to one
JSONL file per pass key there, as `db/consolidate.ts --dump` writes them. That
includes decide mode's link step, when it was asked and whether it capped the
pair, which a capped pair that stores no relation leaves nowhere else. Copy
them out while the coordinator runs, to a directory outside any checkout:
`podman compose -f deploy/compose.yaml cp coordinator:/var/lib/ob1/sleep-dumps <dir>`.
From a stopped container podman's copy says it copied and puts the files
elsewhere or nowhere. They hold the brain's text, each file created 0600, and
a copy keeps that mode; unset, nothing is written and the volume stays empty.

**Changing the model** is the `workers` pass's procedure above: stop the
coordinator before the change reaches it, run the switch, then bring back
`api coordinator`. The switch extracts the backlog
itself, in the foreground and beside any live traffic, as it does under
`workers`; only consolidation's new pool — the thoughts re-pooled under the
new key — waits for the brain to go quiet. An embedding model change
(`OB1_EMBEDDING_MODEL`) is `reembed.ts --switch-model`'s, run the same way:
until it records the new model, `sleep` sets its re-embed pass aside and says
so, and once it has, a sleep re-embeds whatever the switch left unfinished
(SMD-2679) — unless the new name is one its heartbeat row cannot carry (ASCII
letters, digits and `. _ : @ / + -`, `<name>@<width>` at most 120 characters),
which keeps re-embed out of sleep: then `reembed.ts` run by hand finishes it
(SMD-3486).

Since SMD-2752 it checks each claim pass's start
once, before its first quiet — not re-embed's, which each sleep with work
starts and whatever refuses it sets down for that sleep (SMD-2679): a bad
`OB1_WORKER_KEY`, a model not served (the judge's too) or an extraction key
recorded under another model ends each
start at once (exit 2, `heartbeat:sleep` ended failed), and its supervisor
tries again after 1, 2, 4, 8, then every 15 minutes, each try refused the same
way until the cause is mended (SMD-3214), so the coordinator's log names
the cause within seconds of the first start, not at the first quiet, and
preflight's `sleep` row gives it and the next try. As with the `workers`
pass, a model `ollama-pull` is still pulling at a first boot is refused the
same way, and met at a later try once the pull is done. A worker key revoked
later, or the key moved by a `--switch-key` run elsewhere, ends it at the next
sleep, held the same way. Each pass's banner is said once there, not at every sleep;
progress lines (`pool:`, `before:`) still come with each sleep's work.

## Refreshing a tier

`db/tier.ts` builds the canary and working tiers from stable (`db/README.md`,
"The canary and working tiers"). Its `--refresh` runs under Bun and shells to
`pg_dump` / `pg_restore`, `pg_dump` at least both servers' major (it reads
`--to` too, to show it reaches it before the reset), and no image here
carries both. `tier.sh` is the runnable form. It builds `db/tier.Dockerfile`
(`oven/bun:1.4.3-alpine` plus `postgresql16-client`, the major of the postgres
service) as `<project>-tier:latest`, the `--to` side's project, and runs this
checkout's `tier.ts` in it as two halves, each in a container of its own
(SMD-2875). Neither mounts the checkout: each is handed, by `cp`, every file git
tracks under `db`, `evals`, `scripts`, `server-portable` and `plugins`, and an
untracked one there only when it is code (`.ts`, `.mjs`, `.sql`: a migration not
yet added), never a name an env file has nor a directory whole. So no env file
is in either container, and `tier.sh` runs from a git checkout.
- **the source half**, on the `--from` side's `data` network alone, with
  `--from`'s password alone: a refresh's facts and its dump, or a promote's
  read of the canary;
- **the target half**, on the `--to` side's `data` network alone, with `--to`'s
  password and the settings `migrate.ts` reads: the guards, the restore, the
  settings, the migration and the stamps, or a promote's stamp on stable.

The source half's hand-off (the facts and the dump) passes to the target's
container through the runtime's CLI, `cp` piped to `cp`, and is never a file
on the host. No container joins both brains' networks or holds both their
passwords. Each half is still the superuser of its own brain, inside its own
project. The dump runs as `pg_read_all_data` when the login may take that role,
so it reads every table and sequence and can write nothing. `--replay` and
`--diff` need no container: they reach each brain over HTTP.

```bash
# stable (this stack's postgres) into a working copy, a scratch database on the
# same server, created first; from a branch worktree, name the running stack's
# env file (deploy/.env is gitignored)
docker compose --env-file ~/OB1/deploy/.env -f deploy/compose.yaml exec postgres createdb -U postgres openbrain_working
deploy/tier.sh --env-file ~/OB1/deploy/.env --refresh --from postgres --to postgres/openbrain_working --tier working
# replay stable's logged searches on stable and on the canary deploy/canary.sh
# stood up, each over HTTP with a read key, and diff the ids. Each brain is a
# connector name (its key is the connector's x-brain-key; canary.sh up --connect
# registers the canary's) or an http(s):// URL; a URL's key is --from-key /
# --to-key, else its ?key=, else OB1_COMPARE_KEY, which then goes to both
# brains. The variable or the connector keeps a key off the command line.
bun --no-env-file db/tier.ts --diff --from open-brain --to open-brain-canary --since 2026-01-01
bun --no-env-file db/tier.ts --diff \
  --from http://127.0.0.1:8000/mcp --to http://127.0.0.1:8011/mcp   # a key for each: no key opens both (SMD-2874)
# stable into the canary deploy/canary.sh stood up (canary.sh runs this itself):
# each side a `postgres` on its own network, --env-file the canary's file and
# --from-env-file stable's; --project names the canary's project, which a
# canary file from before SMD-2873 does not (tier.sh refuses both sides on one
# network)
deploy/tier.sh --env-file ~/OB1/deploy/.env.canary.local --from-env-file ~/OB1/deploy/.env \
  --project open-brain-canary --refresh --from postgres --to postgres --tier canary
# after a soak, the canary's version onto stable: the sides swap, so --env-file
# is stable's and --from-env-file the canary's
deploy/tier.sh --env-file ~/OB1/deploy/.env --from-env-file ~/OB1/deploy/.env.canary.local \
  --from-project open-brain-canary --promote --from postgres --to postgres
```

A working copy on stable's server is a scratch database for a branch's
migration, reset at will. It shares stable's memory and WAL as a canary must
not, since the canary is the tier that takes the risky rebuilds ("A canary
beside the stack", below).

A `--diff` or `--replay` replays what stable logged on both brains, so:
- stable must run with `OB1_QUERY_LOG=on`, which is off by default;
- the window is the most recent searches stable logged after `--since` (or at
  all), at most a page of them (`list_logged_searches`, 200);
- each brain embeds its own query, so every arm replays with no model here.
  A search both brains refuse is skipped; one that only one brain fails, the
  other answering, fails the run (exit 1 on both verbs), naming that brain;
- the canary is diffed against stable as it answers now, so a thought stable
  gained since the refresh can read as a move (the report's id-set line counts
  them). Until SMD-2875 the diff read both databases from one container on
  both brains' networks, against the ids stable had logged;
- the replays are real searches, which a brain running with
  `OB1_QUERY_LOG=on` logs.

Both print the window and how many searches were replayed and skipped. A
`--diff` that replayed none says `nothing to compare` and exits 3, where a
pass is 0, a moved ranking or a failed step 1 (a refusal such as a missing
key included), and a malformed command line 2, a `postgres://` side included
(SMD-2182).

### Compare two live brains

`--diff`/`--replay` is the merge-time gate over the searches stable logged, and
prints this report above its verdict. To ask instead "are these two running
brains telling me the same thing, and if not why?" in one step, point them at
each other with `--compare` (SMD-2109):

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
differs, a search one brain fails and the other answers included (an id-set
read that failed is not counted). The default compare writes nothing; `--replay` issues real searches,
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

`--from` and `--to` name a database on its side's network as `HOST[:PORT][/DB]`
(port 5432 and database `openbrain` by default). The wrapper builds the URL as
the services here do, with that side's `POSTGRES_PASSWORD`. A full
`postgres://` URL is used as given. Each side is a project:
- **`--to`'s** is the one `--env-file` names, `COMPOSE_PROJECT_NAME` as compose
  reads it, else `open-brain`, or `--project NAME` (SMD-2873). It names the
  image, `<project>-tier`, so a second brain's or a scratch run never re-tags
  the image another brain's runs use, and the network, `<project>_data`,
  unless `--network NAME` names it (a stack from before SMD-2583 has one
  network, `<project>_default`).
- **`--from`'s** is `--from-env-file`'s, when `--from` is another stack's with a
  password of its own (the canary's refresh names stable's; SMD-2583), or
  `--from-project NAME`, and `--from-network NAME` names its network. With none
  of these, `--from` is on the `--to` side's network. Only the password and
  the project are read from `--from-env-file`. A short-form `--from` on
  another network with no `--from-env-file` is refused, since the only
  password to build its URL from would be `--to`'s. So is a
  `COMPOSE_PROJECT_NAME` in the shell beside `--from-env-file`, where it would
  name one project for both sides, unless `--project` and `--from-project`
  (or the networks) name them.

Each of `--network` and `--from-network` is one network: a list is refused,
since a container on two would reach both brains. `--promote`'s `--from` is the
canary and its `--to` stable, so there `--env-file` is stable's. `--runtime` is
`docker` or `podman` (docker when it is on the PATH). Anything else goes to
both halves' `tier.ts` as given, so a flag it refuses is refused before
anything is dumped; `--handoff` is the wrapper's own. A wrapper flag given
twice is refused.

The env file (`--env-file`, default `deploy/.env`) is read by compose itself,
through `compose config --environment`. So a quoted value, an inline comment,
an `export` line, CRLF line endings or a byte-order mark read here as they do
for the stack. A variable set in the shell wins over the file, as it does
there. Only what `tier.ts` and `migrate.ts` read is handed to the target half,
by name, and the source half gets its URL alone:
- the knobs `migrate.ts` and `db/config.mjs` read on a refresh:
  `OB1_EMBEDDING_MODEL`, `OB1_EMBEDDING_DIM`, `OB1_EMBEDDING_DIMENSIONS`,
  `OB1_TRGM_INDEX`, `OB1_BACKFILL_LIMIT`, `OB1_CHUNK_CONTEXT`, `OB1_PLUGINS`
  and the plugin role's `OB1_PLUGIN_DB_PASSWORD`, and `OB1_TIER`;
- `POSTGRES_PASSWORD`.

Every other `OB1_*` setting stays behind: the provider and worker keys,
`OB1_COMPARE_KEY` (which `tier.ts --diff` reads from the shell, and compose's
reading would carry) and the authorization server's `OB1_AUTH_*` settings. So
do access keys, `OPENROUTER_API_KEY` (a replay's embed fell back to it until
the replay moved onto HTTP, SMD-2875), `LINEAR_API_KEY` and `OLLAMA_BASE`. The values travel in a temporary
env file per half (mode 600, removed as soon as that half's container is
made), so they are not on the
wrapper's command line or the runtime's. They are in each half's container
environment, which `inspect` shows while it runs, and its URL is on the
argument lists of bun and `migrate.ts` inside it, which a Linux host's `ps`
shows (SMD-2119). The hand-off holds the source's whole dump: it is in the
source half's container until the hand-off is passed (that container is
removed then), on the CLI's pipe, and in the target's container until the
wrapper removes it. A `--handoff` given to `tier.ts` itself must not exist yet:
it is made mode 700. No `.env` file reaches a half: each is handed the code
(above), not the checkout (until review pass 4 the checkout was mounted
read-only, and both brains' env files with it). `OB1_ENV_FILES=off` and
`bun --no-env-file`, run from a working directory outside the code, stay, so
nothing would load one anyway. So only the half's own environment reaches
`tier.ts`. A failure of compose's to read an env file is named with the
command that shows compose's own words, which can quote a value of the file.

From a container every database is remote, so a short-form `--to` gets
`OB1_ALLOW_REMOTE_DB=1`. A `--to` given as a URL does not, so export
`OB1_ALLOW_REMOTE_DB=1` to reset one, as with `tier.ts` itself. In place of the
loopback check, `tier.ts` guards `--to` two ways:

- **It is not the `--from` database.** Each half reads where its database is,
  as the server says: the cluster's `system_identifier`, when that cluster's
  postmaster started, and the database's name. The source half hands its
  reading over, and the target half compares it with its own, since neither
  reaches the other's database. So `postgres` and `open-brain-postgres-1` are
  one database, and a canary copied from stable's volume, which shares its
  `system_identifier` but started at another time, is still another.
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

Each half's container runs with `--init`, so Ctrl-C stops a refresh, and
`tier.sh` then exits with that container's status (130), so a script calling
it stops too. A half that fails ends the run there: the target half never
starts after a failed source half. Neither publishes anything. The client's major has to be at least the source
server's, and `refreshToolsReady` refuses the refresh otherwise, so a
Postgres bump in the compose files means bumping the package in
`db/tier.Dockerfile` with it. On
every PR, the deploy-stack-brains CI job seeds one thought and one logged search, then
runs through this script: a refresh, its refusal of a `--diff`, a retry over a
copy left stamped `stable` (as a refresh that died after its restore leaves
it), both refusals, a run for another project that builds that project's image
and leaves `open-brain-tier:latest` where it was, and the refusal of a list of
networks. Through the canary's first refresh, the canary step samples the
tier halves' containers: none is on both brains' data networks, and neither
holds the other side's password. The canary step then diffs the canary against stable
over HTTP (`tier.ts --diff`, exit 0), and over a window after every search
(exit 3).

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

A stack that is already running holds a brain of its own, and SMD-1806 makes
it stable, the record. `canary.sh` stands the canary beside it, and takes it down again
(SMD-2038):

```bash
# from a branch worktree, name the running stack's env file (deploy/.env is gitignored)
# the canary mints its own key: no key of stable's is needed, or opens it
deploy/canary.sh --env-file ~/OB1/deploy/.env --port 8011 up --connect   # the first up names its port, and stands it up from stable
deploy/canary.sh --env-file ~/OB1/deploy/.env up                         # later ones bring it level in place, keeping its own rows
deploy/canary.sh --env-file ~/OB1/deploy/.env up --refresh               # replace its database with stable's: its own rows go
deploy/canary.sh --env-file ~/OB1/deploy/.env down --volumes
```

A plain `up` keeps the canary's database and brings it level in place
(SMD-3155; SMD-3154 made the path, then behind `--no-refresh`). Since
SMD-3314 a canary holds rows no other brain has: its own captures, edits and
keys, its own ingests and its passes' proposals. `up` mends its env file and
keys, runs this checkout's `migrate` on the canary's own database, and
recreates the servers, its proxy and forwarder on its own networks. Only
`up --refresh` replaces that database with stable's, and its own rows with
it. A canary with no database to keep (no volume, or a running one holding
no relations) is stood up from stable by a plain `up` or `--refresh`, said. A database stamped
other than `canary` in `ob1_config` is refused, naming `--refresh`: a
refresh that died before its last step leaves stable's copy, which an
in-place migration would keep as the canary's. `--no-refresh` is still
accepted: it keeps, as a plain `up` does, and is refused on a canary with no
database to keep (no volume, changing nothing; or one whose database holds
no relations), where a plain `up` would stand one up. Either form
builds its images while the canary serves, then stops its writers before its
Postgres is touched, its servers and its coordinator, and removes any
container of the services the coordinator replaced (SMD-3476). Once the smoke
has passed it recreates the coordinator on the new build, running the passes
its env file's `OB1_PASSES` names (the canary's own, never stable's), board-sync
as step 5 below says; a `sleep` or `workers` pass with no `OB1_WORKER_KEY` in
the file is held, and `up` says so and exits 1. The first `up` after the
coordinator came writes into the file the passes its old running containers
ran, where it names none. A run that fails after the stop says what it left
stopped and how to go on. A running writer of another profile (the import
runner, the database monitor) is refused before anything changes: stop it
first.

The canary is `compose.yaml` again under the project `<stable>-canary` (SMD-2873):
`open-brain-canary` beside the default stable, `ob1b-canary` beside a brain whose
env file names `COMPOSE_PROJECT_NAME=ob1b`. Stable's project is the one its env
file names, as compose reads it, unless `--stable-project` names another.
`canary.sh names` prints stable's project, the canary's, the connector and the
canary's env file, and changes nothing. The read sees `COMPOSE_PROJECT_NAME`
(the env file's, or the shell's, which wins); a stable brought up with `-p`, or
with a `COMPOSE_FILE` overlay carrying a `name:` of its own, needs
`--stable-project`. A canary stood beside such a stable before SMD-2873 is
`open-brain-canary`, whatever `--stable-project` said: take it down first with
`--stable-project open-brain down`, since the next `up` stands `<stable>-canary`
beside it; the old canary's
`.env.canary.local` is then no canary's, and can be deleted. The
canary has its own Postgres, volume, networks and images, `OB1_TIER=canary`, and two
servers: the MCP server and the REST core. It needs Docker Compose v2
(`config --format json`, `up --wait`), which is what `docker compose` is and
what `podman compose` runs when it is installed; the Python podman-compose is
not enough.

It runs on an env file of its own (SMD-2583): `.env.<canary>.local` beside
stable's, named for the canary's project so two brains' canaries in one
directory stay apart (SMD-2873), and `.env.canary.local` for
`open-brain-canary`, the name it had before (`--canary-env-file` names
another, never stable's own file). The
root `.gitignore` has ignored `.env.*.local` since before this, so stable's
checkout ignores it whatever its age, and the temporary file it is written
in, `.env.canary-<pid>-<n>.local`, which is removed however `up` ends. The
first `up` writes it from stable's file as compose reads it, mode 600: every
setting, each with the value compose read, quoted afresh, but for these:
- **the database password**, which is a fresh one of the canary's;
- **the secrets of the profiles the canary never runs**: the authorization
  server's `OB1_AUTH_*`, n8n's `N8N_*`, the import runner's `OB1_RUNNER_*`,
  the workers' `OB1_WORKER_KEY`, and every Linear key, `LINEAR_*` in any
  letter case (`LINEAR_COMMENT_API_KEY` can comment; SMD-2882). The canary's
  own board-sync reads with a `LINEAR_API_KEY` of its own, never stable's
  (step 5, SMD-3312);
- **stable's keys and the secrets that go with them** (SMD-2874, SMD-3032):
  its `MCP_ACCESS_KEYS` (and the legacy `MCP_ACCESS_KEY`), the forwarder's
  `OB1_FORWARDER_KEY`, the plugins' webhook secrets `OB1_HOOK_SECRETS`, and
  their role's database password `OB1_PLUGIN_DB_PASSWORD`. In their place the
  canary gets keys of its own (below) and, where stable sets one, a plugin
  role password of its own, which every `up` sets the plugins' login role
  to, where the canary's Postgres has one (migrate.ts makes that role once
  and never changes its password);
- **stable's `COMPOSE_PROJECT_NAME`**: the file names the canary's own
  project instead, `COMPOSE_PROJECT_NAME="<canary>"`, so compose given that file
  alone acts on the canary, never on stable (SMD-2873);
- **stable's port, address, tier and profiles**: the file holds the canary's
  own, `SERVER_PORT` its `--port`, `SERVER_BIND="127.0.0.1"`,
  `OB1_TIER="canary"` and `COMPOSE_PROFILES=""` (SMD-2874), which canary.sh
  also hands compose in the shell on every call, with an empty
  `OB1_PUBLIC_ORIGIN`: the canary is loopback alone, and stable's origin would
  have its operator GUI refuse sign-in, its origin not the canary's (SMD-2280). A file written
  since carries none; one written before may hold stable's, which canary.sh's own
  calls override, but compose run by hand with that file does not: delete the
  line;
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
exists), and the canary stays down until this script's `up` runs again, or
`down --volumes` starts the canary afresh.

From then on the file is the canary's own:
- **The password.** Every `up` sets the canary database's password to the
  file's, so a canary stood up before SMD-2583, whose database was made on
  stable's password, takes its own at its next `up`. Neither password opens
  the other stack's database, and the canary's servers hold no database
  credential of stable's. They do hold stable's other settings, its provider
  keys among them, as the canary always has.
- **The keys.** See "Its own keys", below. A file made before SMD-2874 holds
  stable's access keys, and one made before SMD-3032 stable's plugin role
  password: the next `up` takes stable's keys out (by count), mints the
  canary's, clears any raw key or webhook secret of stable's, gives the
  plugin role a password of its own, and says each by name.
- **Stable's changes.** A setting stable gains or changes later does not reach
  the canary, and `up` names each one that differs (the name, never the
  value; the port, address, tier, profiles and public origin canary.sh sets are not named).
  Edit `.env.canary.local` to carry one across, or delete it and the next
  `up` makes it again. `down --volumes` leaves it, and a canary stood up again
  makes its database on it.

**Its own keys** (SMD-2874). No key of stable's opens the canary, and no key
of the canary's opens stable. Its `MCP_ACCESS_KEYS` holds a write key `up`
mints, named for the canary's project (`open-brain-canary:write:<sha256>`,
or `open-brain-canary-2` and on when an entry of the canary's holds that name),
and the raw key is the file's `OB1_CANARY_KEY`, which `up` smokes and
registers the connector with and which no container is handed. Beside it
`up` mints a forward key, `open-brain-canary-mcp-forwarder:forward:<sha256>`, the
raw key in the file's `OB1_FORWARDER_KEY`: the MCP server's own for its calls
on the canary's REST core (SMD-2287), never stable's, and refused as a caller
like any forward key. A canary made before it gets one at its next `up`, which
rewrites `MCP_ACCESS_KEYS` for it once: its other entries kept, comments in it
dropped, and one written across lines refused until it is on one line. Any
entry of stable's forward key goes with stable's keys, listed in stable's
`MCP_ACCESS_KEYS` or not, and a re-mint takes out the forward entries an
earlier one made (`open-brain-canary-mcp-forwarder`, `-2` and on), whose raw
key is gone. For another
client, mint a key with `bun server-portable/keygen.ts --name <client>
--scope read|write` and add the line it prints to the canary's
`MCP_ACCESS_KEYS`; `up` keeps any entry that is not stable's. A refresh copies
stable's `ob1_agents` and `ob1_agent_keys` rows into the canary, but those
grant nothing: a key is accepted by `MCP_ACCESS_KEYS` alone, and those rows
can only refuse one (`revoke_agent_key`). The canary's key registers its own
agent at its first request. `up` writes these settings with
`deploy/env-file.ts` (one line a setting, through a symlink), so it needs
`bun` on PATH; a setting it must rewrite that spans lines is refused (write it on one
line, entries separated by commas), and comments inside `MCP_ACCESS_KEYS` are
not kept when `up` rewrites it. Of `OB1_HOOK_SECRETS`, stable's pairs are
taken out and the canary's own kept. Stable's keys are those its env file holds now: a key stable rotated out
before this canary's file was mended reads as the canary's own, so take it
out of the file by hand. Stable's keys set in the shell are unset
for the run, as its database password is, so they never reach the canary.

The tier and the compose profiles (none) are the canary's own. Each tier has its own Postgres server, never a second
database on stable's: a canary exists to absorb the risky migration, reembed
or index rebuild, and a shared server would share its memory, its WAL and its
crashes with the record.

It answers at `/mcp` on a port of its own, behind its own proxy and
forwarder: `http://127.0.0.1:N/mcp`, on loopback whatever `SERVER_BIND` says
for stable (SMD-2874; docs/one-brain-per-stack.md). The first `up` needs
`--port N`, which it writes to the canary's env file as `SERVER_PORT`; later
ones read it there. A `--port` that differs is the canary's port from then
on: `up` writes it to the file, one line a setting, its old line removed and
the new one at the file's end
(`deploy/env-file.ts`), reads it back through compose, and says so. It does the same for the address, tier and
profiles when the file holds others than the canary's own, as one made
before SMD-2874 does (stable's). Stable's port (its env file's
`SERVER_PORT`, else 8000, or the port its forwarder publishes) is refused.
The file's port is read only from a file holding the canary's own tier
(`OB1_TIER="canary"`, which `up` writes with the port): one made before
SMD-2874 holds stable's tier and the port stable had then, so the first `up`
on it needs `--port`.

Its networks are its own project's: it joins none of stable's, so it cannot
reach stable's database, stable's servers, or a service a compose profile
runs there, and no name inside it resolves to stable. The refresh runs one
half on each project's database network (SMD-2875), stable's read off its
Postgres container: `data`, or `default` for a stable from before SMD-2583.
Stable's half takes stable's password from stable's env file, and the
canary's half the canary's from the canary's (`tier.sh --from-env-file`);
neither holds the other's. With no profiles the canary advertises no OAuth.

From SMD-2294 to SMD-2874 a canary could answer at `/canary/mcp` on stable's
own origin instead, its two servers on stable's `mesh` network
(`compose.canary.yaml`, now gone). Such a canary moves at its next
`up --port N`: its servers are recreated on its own networks alone, on the
same volume, behind its own proxy on `N`, and its env file, whose
`SERVER_PORT` was stable's, takes `N` and the canary's own address, tier and
profiles (their old lines removed and the new ones at the file's end, the
rest of the file as it was). A connector left at `/canary/mcp`
is stable's URL, not the canary's: `up` names it, `up --connect` refuses to
replace it until it is removed (`claude mcp remove --scope user
open-brain-canary`), and `down` leaves it alone. That same `up` takes
stable's keys out of the file and mints the canary's own (SMD-2874 PR 2): a
key of the canary's own in `MCP_ACCESS_KEYS` is kept, as is an
`OB1_WORKER_KEY` whose hash is the canary's (one of stable's is cleared), so a
canary's sleep pass keeps its key; `--connect` registers the connector with
the new key, and an `up` without it says the connector holds one the canary
no longer takes. `COMPOSE_PROFILES` becomes `""`: a profile's service the
canary runs is started by naming the profile on the command line, as it
always was beside canary.sh's empty one; its passes are its `OB1_PASSES`.

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
     canary and leaves stable as it is (or in the canary's env file, once `up`
     has made it):
     `OB1_LLM_BASE_URL=http://host.docker.internal:11434/v1 deploy/canary.sh
     … up` for an Ollama on the host, or a host's full name for one on the
     LAN. It must serve the brain's embedding model. A remote provider also
     needs `OB1_LLM_LOCAL=` cleared there, or the egress gate takes it for
     local. A stack whose only model server is the `local-models` profile
     needs an Ollama on the host for its canary;
   - it has no port: no `--port`, and no env file of its own, or one made
     before SMD-2874 (stable's tier), or one naming stable's port; or the
     port is stable's;
   - its port is taken. For another container's, pass another
     `--port`; if that container is a canary stood up by hand, remove it
     instead: a canary with no database of this project's is stood up from
     stable, and nothing is lost that stable does not hold. A process on the host listening there is
     refused too;
   - `--connect` finds another connector under the name (below);
   - stable's project cannot be read from its env file, or is not a compose
     project name, or ends in `-canary`: that is a canary's own project, so a
     brain named so has no canary of its own (SMD-2873);
   - stable's Postgres, found by its compose labels (stable's project), is
     stamped `canary` or `working`, or carries a
     refresh's mark (`canary`, `working`): that is a copy, not the record.
     A mark of `stable` or `off`, an operator's protection, is not one;
   - stable's Postgres is on neither `<stable>_data` nor `<stable>_default`,
     where the refresh would reach it (SMD-2583);
   - the canary's env file, when it has one, holds no `POSTGRES_PASSWORD` of
     its own, or one built from the shell or spanning lines, or holds
     stable's database password anywhere (above), or names a project other
     than the canary's (SMD-2873). One that names none, made before SMD-2873,
     is let through with a note to add `COMPOSE_PROJECT_NAME=<canary>`.

   Stable with no tier stamp is stamped `tier=stable`. When stable's server
   runs without `OB1_TIER=stable` it says so; set that in the env file and
   recreate the REST core (`up -d api`).
2. It writes the canary's env file if there is none (above), or writes to it
   the canary's own port, address, tier and profiles where it holds others (a
   `--port` that differs, a file from before SMD-2874), and starts the canary's
   Postgres. Once standing servers are stopped (3), it sets the
   canary database's password to that file's. Then, on a canary with a
   database, it runs this checkout's `migrate` on it in place (SMD-3155).
   With `--refresh`, or on a canary with no database to keep, it refreshes it
   from stable through `tier.sh` instead, one half on each project's database
   network: the dump, the settings, a migration with this checkout, the stamp
   and the mark ("Refreshing a tier", above). Stable's password comes from stable's env
   file alone and the canary's from its own: a password set only in the
   shell is not used, since canary.sh unsets it (compose would let it win
   over the canary's file) and tier.sh refuses one beside
   `--from-env-file`.
3. It builds the server image from this checkout (as `api`) and recreates the
   REST core, so its pool opens on the migrated or refreshed database, then the MCP server at `/mcp` (SMD-2287), on the same image and
   the file's own forward key, and starts its own proxy and forwarder,
   recreated only when their port changed. It waits for the keyed `/health` to
   be the REST core's record, which the MCP server answers only once the REST
   core behind it does. Standing servers are stopped before the refresh, so
   nothing serves the copy mid-restore through the connector, or writes rows
   the restore then collides with. `OB1_GIT_SHA` is the checkout's
   `git describe`, unless the shell sets it.
4. It smoke-tests the canary with its own key, `OB1_CANARY_KEY`. The keyed `/health` must
   say `tier` `canary`, and `smoke.sh` must pass. Then the vector arm, which
   `smoke.sh` leaves out. A candidate thought is searched for by its own text, with
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

   `--no-smoke` skips the smoke.
5. Its coordinator runs board-sync on the new build when the canary's env
   file's `OB1_PASSES` names it and the file holds a `LINEAR_API_KEY` of its
   own (SMD-3312, SMD-3476). A canary
   upgraded in place (a plain `up`) is never refreshed, and a refresh was
   what brought it stable's ticket rows, so without its own board-sync its
   copy of the board stays as it was at its last refresh. The coordinator
   stops with the other writers before the canary's Postgres is touched (3).
   - **The key is the canary's alone:** a Linear personal API key made for it
     with Read access alone, one line in its env file (`.env.canary.local`
     beside stable's for open-brain-canary):

     ```bash
     LINEAR_API_KEY=lin_api_…   # the canary's own, Read access alone
     ```

     Never stable's: a personal key can write unless it was made read-only,
     and board-sync runs an unreleased build's `db/` on the canary (the
     canary's server image, built from the tree `up` ran from). **Making the key read-only is what keeps the canary off
     the board's writes**; canary.sh cannot tell a key's access, and what it
     checks guards against accidents, not against a write key it has never
     seen:
     - the file never gets stable's;
     - every `up` clears from it a `LINEAR_API_KEY` that is one of stable's
       Linear keys (its comment key included, stable's file read with and
       without the shell's variables, and any exported in canary.sh's own
       shell), said;
     - it refuses a key set on two lines with a value each (compose reads only
       the last), and one that reads otherwise with the shell's variables
       (`${X:-…}`);
     - canary.sh unsets every Linear key from its own shell, so a shell
       exporting stable's does not reach the canary.
   - **It never posts a finding to the board.** Every `up` clears any other
     Linear key from the file (`LINEAR_COMMENT_API_KEY` pasted in, say), and
     canary.sh holds `LINEAR_COMMENT_API_KEY` empty for every compose call it
     makes besides.
   - **Turning it on** in a canary that holds rows of its own: set the file's
     `LINEAR_API_KEY` line (one line; a clearing leaves it as
     `LINEAR_API_KEY=`, to fill in) and name `board-sync` in its
     `OB1_PASSES`, then `up` (`up --refresh` would replace
     those rows with stable's). **Checking it syncs:** the
     canary's `brain_info` shows a `heartbeat:board-sync` alive and a
     board-sync watermark that keeps up with stable's.
   - **Turning it off:** take `board-sync` out of `OB1_PASSES`, or empty
     the key's line, and re-run `up`: the coordinator comes back without it,
     said, and the run says the canary runs no board-sync.
6. With `--connect` it registers the Claude Code connector named for the
   canary's project, `open-brain-canary` beside the default stable (`--name`
   names another), at user scope, under the canary's own key; a new
   session sees its tools. The URL is the canary's: `/mcp` on its port.

`down` removes the canary's containers, its coordinator among them, and its
own networks. It
deregisters the connector only when `claude` has it at user scope and at a
URL of the canary's: one of its ports on loopback (`127.0.0.1`,
`localhost`), with any path and any `?key=`. A connector at stable's own
`/mcp`, or at `/canary/mcp` on stable's origin, is never the canary's. An
`up` that moves the canary to another port without `--connect` leaves the
connector where it was, and says how to move it: that old port is no longer
the canary's from the next run, so remove the connector first, then
`up --connect`.
One at the root of the canary's port, the URL from before `/mcp`, is one
the canary no longer answers since v2.0.0, when the root became the proxy's
404 (SMD-2532); `up` says so, and `--connect` moves it to `/mcp`.
The canary's ports are `--port`, its env file's `SERVER_PORT`, and the one
its forwarder publishes (its proxy's before SMD-2583), read from the
container running or stopped (a reboot can leave it stopped: "After a
reboot" above).
`claude mcp get` shows the
entry that wins for the current directory, so a local entry by the name
hides a user one behind it. One by that name anywhere else, or in local or
project scope, is left alone with a line saying so, and `up --connect`
refuses to replace it. `--volumes` also deletes the canary's database, and
only once it says it is a canary: stamped `canary`, marked by a refresh, or
holding nothing, which is what a first refresh that died before its mark
leaves. A refusal puts the canary's Postgres back as it found it. The volume
is looked for by name (`<stable>-canary_pgdata`, `open-brain-canary_pgdata`
beside the default stable), which is how `compose down --volumes` removes it.
With none there is nothing to delete, and nothing is started to find out.
The canary's sleep dumps (its `sleep-dumps` volume, SMD-3203) go with the
database: the coordinator that mounts it is a default service, so compose
counts the volume.
Neither touches stable: `down` acts on the canary's project alone.

On every PR, the deploy-stack-brains CI job runs `canary.sh` beside its stack, in
two steps. The first is every refusal above, each with exit 2 and nothing
started, stamped or registered: no port, a canary file naming stable's port,
stable's port given, an empty `--port`, a `--stable-project` no project
could be named, and a connector left at `/canary/mcp` among them. The second
is the canary's life, in four `up`s:
- `up --port 8011 --connect` over a stable carrying the protective mark
  `stable`. The canary must answer at `127.0.0.1:8011/mcp` with tier
  `canary` and OAuth not configured, its env file must hold its own port,
  address, tier and profiles, and its own minted key alone in
  `MCP_ACCESS_KEYS` (no key hash of stable's, a plugin role password of its
  own, no webhook secret of stable's), every canary container must be on the
  canary's own networks alone, and stable's mesh must hold none. Stable's
  smoke key must list nothing at the canary and the canary's nothing at
  stable, each listing at its own; its probe must pass on a thought whose text
  holds literals, searched for without them;
- a second `up`, `--refresh` (a plain `up` keeps since SMD-3155), with no `--port` (its env file's) under
  `SERVER_BIND=0.0.0.0`, against a provider stub serving another model. The
  canary's forwarder must stay on loopback and stable's `/canary/mcp` be the
  proxy's 404; the thought put on stable just before it must reach the
  canary, and the smoke must fail on the floor;
- a third `up`, with a connector at the port's root: named as one the
  canary no longer answers, and the root the proxy's own 404 with no
  `Deprecation` header (SMD-2532);
- a fourth `up`, a plain one on `--port 8012`, which keeps the canary's
  database (a canary-only row survives, no tier half runs); then a database
  stamped `stable` refused, running and stopped; the port written to the canary's env file (written
  mode 600, compose reading 8012), its forwarder moved, 8011 free, and a
  connector left at 8011 named, one `SERVER_PORT` line left; then 8013
  edited into the file by hand with stable's keys added back to
  `MCP_ACCESS_KEYS`, and an `up` with no `--port` moves there, names the
  connector left at 8012, and takes stable's keys out by count, keeping the
  canary's own key and one `MCP_ACCESS_KEYS` line;
- `down --volumes` refused on a canary stamped `working`, an empty canary
  deleted, and nothing to delete once the volume is gone (a local-scope
  connector left alone);
- a volume by the canary's name that compose did not make, holding a table,
  refused with nothing left running;
- connectors at stable's own `/mcp` and at `/canary/mcp` left alone, and a
  last `down` that removes the canary's, by its env file's port.

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
that does not match (a verify-only restart serves in about a second). A
fetch that fails — no network yet after a reboot, the hub down, a file that
hashes wrong — does not end the service: it is tried again after 1, 2, 4, 8,
then every 15 minutes, `jev` unhealthy meanwhile, and a bad `JEV_THREADS`
holds it until a recreate (SMD-3214); `--fetch-only` still exits on either. About
1 GB resident, outside Ollama's scheduler. With `OB1_JEV_BASE_URL` set the
server's preflight dials the tier and fails the start when it does not answer,
so set the knob with the profile, not before it; with the profile the server
waits for `jev` to be healthy (`depends_on … required: false`), so the first
start's fetch does not crashloop it. `compose restart api` does not start
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

n8n itself reaches the brain only through the REST core, `http://api:8000`
on `egress` with the key in `x-brain-key` (SMD-2295, under SMD-2282's
decision 1), with a capture-scope key, and holds no write key. A capture
is `POST http://api:8000/v1/thoughts`; the REST core's contract is
`GET http://api:8000/openapi.json`, which needs no key. The one exception is
the profile's import runner (SMD-2212, below). It writes brain tables
directly, the way the pipeline does from a checkout, and a workflow holding
its key can cause those writes. That is the ADR's decision 4, amended, and
the runner's key is bounded by its allowlist. OB1's part is the provisioning
step in `orchestration/`, the templates it loads from
`orchestration/templates/`, and the runner.

Below, `compose` stands for `podman compose -f deploy/compose.yaml --profile
orchestration`, or docker compose.

```bash
bun deploy/orchestration/provision.ts --init   # once: the profile's secrets into deploy/.env (it never replaces one)
podman compose -f deploy/compose.yaml --profile orchestration up -d
bun deploy/orchestration/provision.ts        # --env-file for another file; --rotate for a new API key
# Optional, for a template that captures into the brain (none ships yet): a CAPTURE key
cd server-portable && bun keygen.ts --name n8n --scope capture && cd ..
#   the key into deploy/.env as N8N_BRAIN_CAPTURE_KEY, the line it prints into MCP_ACCESS_KEYS,
#   then recreate the REST core, which reads the list, and provision again (compose up -d api;
#   a restart keeps the old keys)
```

`--url` names n8n's origin where it is not `http://127.0.0.1:$N8N_PORT`. A
user and password in it (`http://user:pass@host`, for a front before n8n)
are sent as Basic on every request, beside n8n's own key or session, on any
Bun, and printed as `***@` (SMD-2894).

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
per line of `orchestration/pipelines.json`. That file holds the four export
importers (SMD-2493): `grok`, `instagram`, `blogger` and `x-twitter`, each
reading `imports/<name>/` weekly. Until an export is put in its folder, a run
writes nothing and succeeds: an absent folder through the emitter's
`--if-present`, an empty one by having nothing to read. What goes in each
folder, and what fails a run, is in `deploy/imports/README.md`. An emitter
killed by something other than the runner (exit 137: the container's
`mem_limit`, 2 GB, run out) fails the run saying so; an export that large is
imported from a checkout.
Each pipeline owns one source (its `system`): two lines naming the same one
are refused. Rows the runner writes carry its own name,
`orchestration-runner`. Classify it once, as `postgres`, before the first
export goes in (`SELECT set_agent_kind('orchestration-runner', 'ingested');`),
so they read `trust: ingested`. Rows written before that keep no trust until
`SELECT backfill_thought_actors();` restamps them.
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
     - The servers' vector mender (SMD-2889) embeds the same rows too, 8 a
       tick per server, within a sweep of their landing. Neither writes over the other's
       newer text — each write carries the stamp it read — but a row both
       reach may be embedded and written twice; `OB1_VECTOR_MEND_INTERVAL=off`
       leaves imports to the runner alone.
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
    created. After changing them, recreate it with the REST core: `compose up
    -d --force-recreate api orchestration-runner`.
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
masked. With the runner classified (above), drop an export into the
pipeline's directory and the next run ingests it, and a rerun writes
nothing. The export never passes through
n8n. The request names the pipeline and nothing else, so n8n's run history
holds the report, not the export. The report does name items by identity,
and a refusal can quote the value it refused. A failed run's notes are the
end of the emitter's stderr, which names the export's files and folders (an
Instagram thread's folder is named after the other person); the four
importers never quote a record's text there.

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
  --build api` included) brings its grants to the step's next run; a
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

Then rebuild the runner (`compose up -d --build orchestration-runner`),
classify the runner if it is not yet (above), provision, and put the
export in `imports/<pipeline>/`. A line whose emitter the
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
404 itself while it does not ("One origin", above). The REST core accepts
its tokens (SMD-2286, "Tokens at the REST core" below). `mcp-server/` is
its client: it trades each OAuth token sent to `/mcp` for the REST core's,
as the `mcp` client (SMD-2286), and serves `/mcp` as the `mcp` service
since SMD-2287 PR 5b; the operator GUI signs the operator in through it as
the confidential `gui` client, code and PKCE with a refresh token, with
`OB1_AUTH_SECRET_GUI` (SMD-3307, `dashboard/README.md`), and lists and
revokes grants on its page of grants through the server's admin listener:
port 3001 on the mesh, which no proxy rule routes to, taking the `gui`
client's credentials alone (`auth/admin.ts`). The
MCP server sends clients to it (SMD-2382): at the public origin, while
this server answers its probe on the mesh, it serves the protected-resource
document and answers a keyless `/mcp` with the 401 challenge naming it.

Below, `compose` stands for `podman compose -f deploy/compose.yaml --profile
auth`, or docker compose, with whatever other `-f` files the stack was
started with. It assumes the stack of step 1: compose reads the whole of
`deploy/.env` for every service, so `POSTGRES_PASSWORD`, `MCP_ACCESS_KEYS` and
`OB1_FORWARDER_KEY` must be set even to start this one.

```bash
# deploy/.env: OB1_PUBLIC_ORIGIN=https://brain.example.com (yours; --init does not write it)
#              COMPOSE_PROFILES=auth   (with any other profiles, comma-separated)
bun deploy/auth/provision.ts --init   # once: the profile's secrets into deploy/.env (it keeps every value it finds)
bun deploy/auth/provision.ts          # what the server would refuse, read from deploy/.env
compose up -d --wait --wait-timeout 60 auth api mcp app proxy breakglass   # builds and starts it, recreates the REST core, the MCP server and the GUI on the new .env (each reads the switch; the GUI signs in through it, and its sessions start again), starts the GUI's break-glass port on 127.0.0.1:${BREAKGLASS_PORT:-8001}, and waits
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
pass a variable it does not name: `provision.ts` says which line. A service's
id may not be `operator`, the account every sign-in's token names, and its
scopes must be one access key's: `brain:read+brain:capture` without
`brain:write` is refused, as `brain:write` already reads and captures. Either
stops the server starting, so change such a service before upgrading: split a
read+capture one into two services, one scope each (like for like:
`brain:write` would also let it change and delete), and give a renamed one
its new secret (`--init` writes it) and its line in `deploy/compose.yaml`.

A service gets its token from `<origin>/auth/token` by client credentials,
with its secret (`OB1_AUTH_SECRET_<ID>` in `deploy/.env`), naming the REST
core and its scope, and sends it as `Authorization: Bearer` to `/api`:

```bash
curl -s -u "runner:$OB1_AUTH_SECRET_RUNNER" -d grant_type=client_credentials \
  -d resource=https://brain.example.com/api -d scope=brain:capture \
  https://brain.example.com/auth/token
```

A request without a scope gets a token with none, which the REST core refuses.

**Tokens at the REST core** (SMD-2286). On a configured stack the REST core
accepts a bearer token this server issued for it: issuer `<origin>/auth`,
audience exactly `<origin>/api`, ES256, unexpired. A token for `/mcp` is
refused there; it reaches the REST core only exchanged by the MCP server.
- **Scopes:** `brain:write` acts as a write key, `brain:read` as a read
  key, `brain:capture` as a capture key; the consent page words them so. A
  token holding none of them, or `brain:read` with `brain:capture` and no
  `brain:write`, is answered 403 `insufficient_scope`.
- **The caller** is the operator and the client it signed in through,
  one name per client (SMD-3064): `oauth:operator+gui` for the operator
  GUI, `oauth:operator+<client>` for a connector reached through `/mcp`
  (a registered client's id, or a metadata document's URL, such as
  `oauth:operator+https://claude.ai/oauth/claude-code-client-metadata`),
  and `oauth:<id>` alone for a service. That name is what egress terms
  (`actor:oauth:operator+gui` in `OB1_EGRESS_ALLOW` or `OB1_EGRESS_DENY`),
  the search tools' actor filter and the audit row see; an exchanged
  token's audit row names the MCP service as `act`. The registry lists the
  names it has seen: `SELECT label, kind FROM ob1_agents WHERE label LIKE
  'oauth:%'`.
- **Classify each** as you would a key, or its writes carry no kind and a
  `said_by` filter misses them. The GUI is you; a connector is usually an
  agent:
  `compose exec -T postgres psql -U postgres -d openbrain -c "SELECT set_agent_kind('oauth:operator+gui', 'operator'), set_agent_kind('oauth:operator+<client>', 'agent')"`,
  then `SELECT backfill_thought_actors()` so the thoughts it wrote before
  carry the kind `said_by` reads (and `SELECT backfill_thought_audit_events()`
  for their audit rows). A name can be classified before its first sign-in.
  A client registered afresh is a new name, unclassified until you classify
  it.
- **Revoking one in the registry bans that client for good.** Its digest
  is fixed, so no new sign-in through that client escapes it: every token
  of it is refused 401 `REVOKED` (`credential: "token"`), and there is no
  function to undo it. The GUI and the other clients go on. (The digest is
  of the issuer too, so changing `OB1_PUBLIC_ORIGIN` gives each name a new
  one, and lifts the ban with it.) To ban one on purpose, by its label:
  `SELECT revoke_agent_key(k.key_hash, 'why') FROM ob1_agent_keys k JOIN
  ob1_agents a USING (canonical_agent_id) WHERE a.label =
  'oauth:operator+<client>'`.
  For a leaked token, act at this server instead. An access token dies
  within ten minutes on its own. A client can revoke its own refresh token
  (RFC 7009, `<origin>/auth/token/revocation`), which revokes its grant, as
  the GUI's sign-out does its own. The operator revokes any client's on the
  GUI's page of grants (`/dashboard/grants`, SMD-3307 PR 3): its refresh
  tokens are refused at once, and the access token it holds lapses within
  ten minutes (the maintainer's choice of 2026-10-26: no revocation list).
  The compromise steps under "Custody and backups" below end every grant.
- **Upgrading past SMD-3064:** the one name `oauth:operator` is gone, and
  nothing that named it binds a client now. A ban on it in the registry no
  longer refuses anyone: ban each client by its own name. An egress term
  naming it no longer matches, so name each client in its place: an
  `OB1_EGRESS_DENY` term `actor:oauth:operator` stops refusing, and an
  `OB1_EGRESS_ALLOW` term stops admitting, so text the GUI and connectors
  send no longer leaves for a provider that the allow list gated.
  A classification of it, and a search's `actor` filter, match only the
  rows written before. A connector named by a metadata document URL the
  brain cannot name (a query, `HTTPS://`, `+` or `:` in its path, no path,
  over 180 characters) is refused from now on, at its sign-in and its
  refresh.
- **The keys:** it reads this server's signing keys on the mesh and keeps
  them ten minutes, the tokens' lifetime, reading again after that or for a
  key it lacks, at most once in 30 s. Once the keys are stale and reads fail,
  the keys it read last go on serving for ten minutes from then, so a token
  issued before an outage works to its end. With no keys at all, a token gets
  503 with `Retry-After: 30`. Not configured, a token is an unknown key.
- **Lifetimes:** an access token lasts 600 s. A client that asked for
  `offline_access` gets a refresh token that lasts 14 days unused. Each use
  replaces it with a new one, and no chain outlives the 30-day grant behind
  it, so a connector signs in again at least monthly. A replaced token used
  again within 10 s is honoured, as often as it comes, since MCP clients
  refresh several times at once; each use gets a new token. Used again
  later, it is taken as stolen: the grant is revoked, and the client signs in
  again. The price of the 10 s: a stolen token replayed inside them forks the
  chain undetected.

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
  SMD-2280's.
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
or more, is what holds against many addresses guessing; a lockout's way in is the
GUI's loopback break-glass port (`breakglass`, `127.0.0.1:${BREAKGLASS_PORT:-8001}`),
which takes an access key whatever the server's state (SMD-3307). The proxy in front sets no rate limit of
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
`compose up -d --wait auth api mcp app`, which hands the MCP server and the
GUI their new secrets (without them every GUI sign-in is refused, the GUI's
log saying `invalid_client`) and has the REST core drop the old signing key at
once (it keeps a key set ten minutes, and ten more while the AS is away):
every client signs in again. Both shapes were measured:
the backup above restored into a fresh volume brings a registered client back
with its registration token, and the fresh volume alone does not.

**Upgrades.** The service is built from the checkout, so after pulling a new
one rebuild it: `compose up -d --build --wait auth`. A plain `up` keeps the
old image. oidc-provider is pinned exactly (`auth/package.json`). A bump
re-runs the proof of concept against the new image
(`bun evals/eval-auth.ts --up oidc-provider`, then `--verify`); CI's auth-poc
job does the same.

**Who can sign in.** With the profile on, the MCP server advertises OAuth
at the public origin, and a claude.ai connector at `/mcp` is asked to sign
in here, `?key=` ones included. A `?key=` connector is served once through,
since its key authenticates before the token; one with no key is served on
its token, which `mcp-server/`, serving `/mcp` since SMD-2287 PR 5b, trades
at the hop for the REST core's (SMD-2286) with `OB1_AUTH_SECRET_MCP`, which
`provision.ts --init` writes into `deploy/.env`. Only the operator can sign
in today, so leave the profile off where others' claude.ai connectors must
keep working; turning it off again makes the document a 404, and they
proceed on the key.
Not yet: passkey sign-in, which needs the public origin (SMD-2382,
SMD-2286). The release overlay does not pin an image for it yet,
so the profile builds from a checkout.

## What this does not cover

- **TLS, backups, resource limits, log shipping.** Reference topology only.
  Postgres's command sets three things on every stack and tier:
  `pg_stat_statements` preloaded (`POSTGRES_PRELOAD_LIBRARIES`), utility
  statements untracked, I/O timed ("The observability profile"). One
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
- **Memory for the brain's size** (SMD-1499). The postgres service runs on the
  image's `shared_buffers` (128MB) and `work_mem` (4MB). Preflight's `vector
  index memory` row warns when the HNSW indexes outgrow `shared_buffers` — at
  ten million rows, sizing it to the indexes gave about three times the
  throughput at ten connections — and prints the size to set: `ALTER SYSTEM
  SET shared_buffers` and a restart of postgres, where the host has the memory
  (`deploy/.env.example` has the commands, and the way back if postgres then
  will not start). Preflight's `filter bitmap memory` row is information only: what a
  filter's bitmap needs against `work_mem`, with no recommendation until
  SMD-1464 settles `match_thoughts`' plan mode.
- **Scheduled jobs.** One recipe (`recipes/editorial-policy`) uses `pg_cron` and
  `pg_net` to call an endpoint on a schedule, which the stack's Postgres does not
  ship. Here that becomes an ordinary cron job or a scheduled workflow (the `orchestration` profile's n8n). Not ported here.
- **Data migration.** `pg_dump --data-only` from a brain you are moving onto the stack, plus a full
  re-embed if the embedding model family changes — `db/reembed.ts`, run from a
  checkout with the provider reachable, not from this stack. A checkout reaches
  this stack's database only with `-f deploy/compose.host-ports.yaml` ("What is
  reachable from where", above); the same goes for the two workers below.
- **Entity extraction.** `db/extract-entities.ts --follow` is a long-running
  worker with a per-thought model cost, so the coordinator runs it only when
  `OB1_PASSES` asks: the `workers` pass runs it and `db/consolidate.ts
  --follow`, the pass that proposes supersessions from the entities it
  extracts, or the `sleep` pass runs both only while the brain is quiet
  ("Extraction and consolidation as passes", above). Decide on the cost
  before you ask for either.
  A follower exits 0 when stopped, so watch its log: it says there when the
  model looks at fault, after each pass drains the pool. A follower started on
  a backlog says nothing until the backlog is done, so try a new model on a
  working copy with `--limit 48` first (SMD-2266, `db/README.md`; on the brain
  itself a new model is a new key, "Changing the model" above). It waits out
  a database restart, a provider outage or a model being pulled, and says so
  in its log, rather than exiting or failing the thoughts it holds
  (SMD-2599); a model the provider does not serve at start is refused with
  exit 2. Reviewing what consolidation proposes stays a person's job.
- **Auth.** Without the `auth` profile, each client holds a static key of its
  own, named and scoped in `MCP_ACCESS_KEYS` and sent in a header or `?key=`.
  A key that leaks works until it is revoked: `revoke_agent_key` takes effect
  within a minute, with no restart (`SETUP.md`), or it can be taken out of the
  list. With the profile, MCP clients sign in through the authorization server
  and hold tokens that last 600 s, and a client's grant is revoked on the
  operator GUI's page of grants. (Upstream's one shared key,
  [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216), is what
  the named keys replaced.)
  The `auth` profile's authorization server runs behind the proxy's `/auth`;
  the MCP server at `/mcp` is its client (SMD-2287), and only the operator
  signs in there, with no passkey yet ("Authorization server", above).

## Related

- `../db/` — the schema and its migration runner
- `../server-portable/` — the server, and `preflight.ts`
- `../FORK.md` — what this fork changes and why
