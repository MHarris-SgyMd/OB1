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
- A model provider: the stack's own Ollama (`--profile local-models`, nothing to
  set), an Ollama on the host, or an OpenRouter key — the shipped defaults are
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

Three services, in order (five with the profile):

| Service | Replaces |
| --- | --- |
| `postgres` | The Supabase-hosted database (`pgvector/pgvector:0.8.6-pg16`) |
| `migrate` | Pasting SQL into the Supabase dashboard — the `ob1-migrate` image (`db/Dockerfile`) runs `db/migrate.ts`, then exits |
| `server` | Upstream's Edge Function and its deploy command |
| `ollama` (profile) | OpenRouter — the model endpoint the server defaults to |
| `ollama-pull` (profile) | Pulling both models by hand; runs once, then exits |

### 3. Verify

```bash
OB1_SMOKE_KEY=<your-raw-key> ./deploy/smoke.sh
```

### 4. Connect a client

```
http://127.0.0.1:8000/?key=<MCP_ACCESS_KEY>
```

8000 is `SERVER_PORT`, set in `deploy/.env` when something on the host already
publishes it (a devcontainer publishing 8000 on the podman VM was the case met);
the URL, `smoke.sh` and the `lsof` line below follow it.

That URL works from this machine and nowhere else, by default — a client on
this machine, such as Claude Code at user scope
(`claude mcp add --transport http --scope user open-brain http://127.0.0.1:8000/
--header "x-brain-key: <key>"`). A claude.ai or Claude Desktop custom connector
connects from Anthropic's side, not from your machine, so it needs a TLS proxy
or a tunnel in front; one on this host (caddy, cloudflared, `tailscale funnel`)
dials `127.0.0.1:8000` itself and the loopback default serves it — `SERVER_BIND`
changes only when the proxy is on another machine, as the next section says.
`127.0.0.1`, not `localhost`: the mapping binds the IPv4 loopback only, and a
client that resolves `localhost` to `::1` first without falling back is refused
(`smoke.sh` dials `127.0.0.1` for the same reason).

## Pinning a release

The stack above builds `server` and `migrate` from the checkout, and pins
`postgres` and `ollama` by tag (`ollama`'s is the one `x-ollama-image` anchor in
`compose.yaml`, shared by `ollama-pull`). A release pins everything: the job
`.github/workflows/release.yml` (SMD-1860) runs on the tag a cut is named by —
`v<X.Y.Z>`; [`FORK.md`](../FORK.md) "Versioning" has the scheme and the cut —
publishes the two images to GHCR, `ghcr.io/mharris-sgymd/ob1-server:<X.Y.Z>` and
`ghcr.io/mharris-sgymd/ob1-migrate:<X.Y.Z>` for linux/amd64 and linux/arm64, and
creates the GitHub release with a compose overlay that names the two by tag and
digest and `ollama` by the digest its tag resolved to when the job ran, beside
`compose.yaml` and `.env.example` from the same tag, the change files the release
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
the repo root, with whatever `-f` files the stack was started with:

| Service | On the compose network | On the host | From another machine |
| --- | --- | --- | --- |
| `server` | `server:8000` | `127.0.0.1:${SERVER_PORT:-8000}` — the stack's only published port | Through a TLS proxy or tunnel. One on this host dials `127.0.0.1` and needs no knob; only a proxy on another machine needs `SERVER_BIND=0.0.0.0` in `deploy/.env`, and then the key rides every request in clear until the proxy |
| `postgres` | `postgres:5432` — the server and the migrator | Nothing. `compose exec postgres psql -U postgres openbrain` for psql, `compose exec -T postgres pg_dump -U postgres openbrain > dump.sql` for a backup. A tool run from a checkout (`db/reembed.ts`, `db/extract-entities.ts`, `db/consolidate.ts`, the evals) adds `-f deploy/compose.host-ports.yaml`, which publishes it on `127.0.0.1:${POSTGRES_PORT:-5432}` — choose that when the stack comes up: adding or dropping the file later recreates `postgres` and, through `depends_on`, `server` | Never. `POSTGRES_BIND` exists for a firewalled host you have looked at; it is the superuser on the whole brain |
| `ollama` (`--profile local-models`) | `ollama:11434` — the server and `ollama-pull` | Nothing. `compose exec ollama ollama pull <model>`; the host-ports file publishes it on `127.0.0.1:${OLLAMA_PORT:-11434}` for an eval run from a checkout | Not intended; an unauthenticated model API |
| `jev` (`--profile jev`) | `jev:8020` — the server's preflight, and a spike run in a container | Nothing. The host-ports file publishes it on `127.0.0.1:${JEV_PORT:-8020}` for a spike run from a checkout (`OB1_JEV_BASE_URL=http://127.0.0.1:8020`) | Not intended; an unauthenticated model API, as Ollama's is |
| `board-sync` (`--profile board-sync`) | Listens on nothing; dials `postgres:5432` and the model provider, and Linear's API outward | Nothing | Nothing |

The three-brain pipeline (`-f deploy/compose.tiers.yaml`, SMD-1806) publishes one
server per tier, each on loopback by default; its three Postgres services and
shared Ollama publish nothing, exactly as above.

| Service | On the compose network | On the host | From another machine |
| --- | --- | --- | --- |
| `stable-server` | `stable-server:8000` | `127.0.0.1:${STABLE_SERVER_PORT:-8010}` | Through a proxy; `STABLE_SERVER_BIND=0.0.0.0` only for a proxy elsewhere |
| `canary-server` | `canary-server:8000` | `127.0.0.1:${CANARY_SERVER_PORT:-8011}` | Through a proxy; `CANARY_SERVER_BIND=0.0.0.0` only for a proxy elsewhere |
| `working-server` | `working-server:8000` | `127.0.0.1:${WORKING_SERVER_PORT:-8012}` | Through a proxy; `WORKING_SERVER_BIND=0.0.0.0` only for a proxy elsewhere |

`docker compose -f deploy/compose.yaml config` renders each mapping with
`host_ip: 127.0.0.1`, and `scripts/check-fork-consistency.ts` check 13 parses
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

`migrate` exits 0 having applied every migration under `db/migrations/` (its image,
`db/Dockerfile`, carries the runner and the migrations and installs nothing —
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

With a read or write key, the same `GET <base>/health` answers what the brain is,
as JSON — version, commit, store, tier, the Postgres and pgvector versions, the
ledger's highest migration against the server's own, counts, size and HNSW
parameters (the `brain_info` tool's record; `server-portable/README.md` has the
fields). A probe with no key still gets `ok`. `smoke.sh` prints the version, the
commit and the highest migration from it, and asserts the version is the
checkout's:

```bash
curl -s -H "x-brain-key: $KEY" http://127.0.0.1:8010/health | jq '{version, commit, ledgerStatus, highest: .database.highestMigration}'
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
OB1_GIT_SHA=$(git describe --always --dirty --abbrev=8) docker compose up -d --build server
```

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
but needs an inbound URL the stack has no origin for until SMD-1846, and the
handler's shape (signature, replay window, loop guard) is SMD-1862's.

## Refreshing a tier

`db/tier.ts` builds the canary and working tiers from stable (`db/README.md`,
"The canary and working tiers"). Its `--refresh` runs under Bun and shells to
`pg_dump` / `pg_restore` at the source server's major, and no image here
carries both. `tier.sh` is the runnable form. It builds `db/tier.Dockerfile`
(`oven/bun:1.4.0-alpine` plus `postgresql16-client`, the major of the postgres
service) as `open-brain-tier:latest`, and runs this checkout's `tier.ts`
in it, mounted read-only, on the stack's network:

```bash
# stable (this stack's postgres) into a canary on its own server beside it; from
# a branch worktree, name the running stack's env file (deploy/.env is gitignored)
deploy/tier.sh --env-file ~/OB1/deploy/.env --refresh --from postgres --to open-brain-canary-postgres --tier canary
deploy/tier.sh --env-file ~/OB1/deploy/.env --diff    --from postgres --to open-brain-canary-postgres
# the three-tier stack's own network and services
deploy/tier.sh --refresh --from stable-postgres --to canary-postgres --network open-brain-tiers_default
```

`--from` and `--to` name a database on the network as `HOST[:PORT][/DB]`
(port 5432 and database `openbrain` by default). The wrapper builds the URL as
the services here do, with `POSTGRES_PASSWORD`. A full `postgres://` URL is used
as given. `--network` defaults to `open-brain_default`, and `--runtime` is
`docker` or `podman` (docker when it is on the PATH). Anything else goes to
`tier.ts` as given, and a wrapper flag given twice is refused.

The env file (`--env-file`, default `deploy/.env`) is read by compose itself,
through `compose config --environment`. So a quoted value, an inline comment,
an `export` line, CRLF line endings or a byte-order mark read here as they do
for the stack. A variable set in the shell wins over the file, as it does
there. Only what `tier.ts` and `migrate.ts` read is handed to the container:
- the `OB1_*` knobs (`migrate.ts` reads `OB1_EMBEDDING_*` on a refresh);
- `POSTGRES_PASSWORD`;
- the provider settings the replay's embed reads (`OPENROUTER_API_KEY`,
  `OLLAMA_BASE`).

Access keys and `LINEAR_API_KEY` stay behind. The values travel in a temporary
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

The container runs with `--init`, so Ctrl-C stops a refresh, and it publishes
nothing. The client's major has to be at least the source server's, and
`refreshToolsReady` refuses the refresh otherwise, so a Postgres bump in the
compose files means bumping the package in `db/tier.Dockerfile` with it. On
every PR, the deploy-stack CI job seeds one thought and one logged search, then
runs through this script: a refresh, a `--replay`, a `--diff`, a retry over a
copy left stamped `stable` (as a refresh that died after its restore leaves
it), and both refusals. On a host with SELinux enforcing (Fedora and RHEL,
where podman labels by default), the container can read the mounted checkout
only once it is relabelled: `chcon -Rt container_file_t <checkout>`. The
script does not relabel it for you.

A refresh does not carry the per-database HNSW settings over (SMD-2037), and a
server already running on the refreshed database keeps its old pool until it
is recreated. The canary-beside-the-dogfood standup is SMD-2038.

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
