# One brain per stack: federation and tier validation through an edge proxy (SMD-2872)

An architecture decision record. **The direction was decided 2026-10-09 by the maintainer**: each Open Brain runs behind its own proxy, on a port the operator sets, with its networks entirely its own, so several run on one machine. Brains mesh together only behind a separate edge proxy. Brains working together and validating a build between the tiers (stable, canary, working) are two different needs.

The decision table marks which rows are that direction, which follow from it, and which are proposals a child ticket settles. SMD-2873 to SMD-2875 carry the direction out. The open questions are worked in SMD-2876 to SMD-2878 and recorded here as each is answered. An answer that amends a row (listed under the table) goes back to the maintainer.

Each Open Brain is a self-contained stack:
- with default profiles, a forwarder (SMD-2583) holds the stack's one published port, in front of the stack's own proxy. The `orchestration` profile adds n8n's port, and the host-ports overlay adds more, all bound to loopback by default;
- its networks, Postgres and volumes are its own, and so (row 10, proposed) are its access keys. Its networks include its `mesh`, the internal network on which its proxy reaches its servers;
- no Docker network is shared with any other brain.

"The edge proxy" is a separate stack in front of several brains. It is not each brain's own `edge` network, the outward network its forwarder publishes the port on.

Two needs used to be met by joining brains' networks. Here neither is:
- **Brains that work together** (import, export, exchanging ideas) do it over HTTP, through the edge proxy, which reaches each brain through its published port (row 6, proposed; open question 1).
- **Validating a build against stable** (refresh, replay, diff, promote) treats the canary as one more instance, and the tier tools as clients of two instances. A working tier is an instance too.

## Why

The canary was coupled to stable at runtime for one convenience, a URL on stable's origin (`/canary/mcp`):

- **Shared network.** `deploy/compose.canary.yaml` joins the canary's MCP server and REST core to stable's mesh network (SMD-2294 PR 2, #316).
- **Name collision.** From the canary's containers, `mcp.ob1.internal`, `api.ob1.internal` and `auth.ob1.internal` resolve to stable's containers as well as the canary's own. `compose.canary.yaml` records this, measured on podman.
- **Shared keys.** The canary accepts stable's access keys (`deploy/canary.sh`). Clients therefore hand an unreleased build raw keys that stable accepts, on a network where stable's REST core answers.
  - Two conventions keep it from calling there. `compose.canary.yaml`'s rule says anything a canary dials is a rooted `*.canary.ob1.internal` name. And the canary runs with no compose profiles, so its server's one probe by a stable name (OAuth) never runs.
  - Neither is a boundary.
- **Stable carries the canary's routes.** Stable's route table in `compose.yaml` has the routers `canary`, `working` and `tier-off`, the middleware `tier-absent`, and the services `canary` and `working` (SMD-2294 PR 1, #314). Every stable release ships routes for brains it doesn't run.
- **The canary depends on stable.** Its URL needs stable's proxy, stable's mesh and a stable release that carries the route. It is also exposed wherever stable is: the LAN under stable's `SERVER_BIND`, or a tunnel.
- **The tier tool joins both brains.**
  - `deploy/tier.sh` runs `db/tier.ts` in one container, connected to each network it is given. `canary.sh`'s refresh gives it both brains' data networks. tier.sh's documented `--diff` adds stable's egress.
  - It builds each database URL with the superuser, so that one container holds both brains' passwords.
- **Guarding it costs.** Check 28 holds `compose.canary.yaml`'s networks and names exactly, with eight probes of its own. SMD-2685 added holds against a second key into stable's mesh. CI renders the overlay in two steps and stands it up through `canary.sh` in two more, and `canary.sh` checks stable's proxy and mesh before it joins.
- **`deploy/compose.tiers.yaml` goes furthest** (SMD-2294 PR 3, #320): three brains in one project, with one proxy, one Ollama, shared networks and one `down`. Check 27 generates the stack it should be from `compose.yaml` (`tierStack()`) and holds the file to it, value for value.

Validation needs a second brain to compare against. Federation needs brains that can reach each other. Neither needs a network shared between brains.

## The decision

| # | Decided | Status | Chosen over |
|---|---|---|---|
| 1 | **One brain is one compose project.** Its published ports are its only way in, and no network of it is joined from another project. | the maintainer's direction | tiers as paths on one proxy, with the canary joined to stable's mesh (SMD-2294 PRs 1–2) |
| 2 | **The operator sets each brain's port**, so several brains run on one machine. | the maintainer's direction | one fixed port per stack |
| 3 | **Brains mesh together behind a separate edge proxy**, its own project. | the maintainer's direction | a network shared by brains; brain-to-brain database links |
| 4 | **Each brain has its own authorization server** (when its `auth` profile is on). | follows from 1 under today's wiring: the authorization server is reached as `auth.ob1.internal` on the brain's own mesh | one authorization server for every tier (SMD-2282 decision 14) |
| 5 | **Each brain's database is reached only through its own project.** | follows from 1 | one container on both brains' data networks |
| 6 | **The edge reaches each brain through the brain's published port.** | proposed; SMD-2876 settles it (open question 1) | the edge joining the brains' networks |
| 7 | **The edge holds no key and injects no credential or identity.** A client's own key passes through, unchanged, to the brain the client names. | proposed; SMD-2876 | the edge as an authenticating gateway for several brains |
| 8 | **An instance is its env file**: `COMPOSE_PROJECT_NAME`, `SERVER_PORT`/`SERVER_BIND` and the profile ports, all in the one file. `compose.yaml` stays one file for every instance. | proposed; SMD-2873 (measured to work today) | a compose file per instance; `name:` edited per copy |
| 9 | **Tier tools reach each brain through its own project.** Refresh by a dump streamed from stable's project into the canary's; replay, diff and promote by the means SMD-2875 settles. | proposed; SMD-2875 | the joined container |
| 10 | **Each brain has its own access keys.** A brain calling another is an HTTP client with a key the other issued, and a canary is an instance with its own port and keys. | proposed here; SMD-2874 for the canary. It doesn't follow from row 1: the canary takes stable's keys because `canary.sh` copies them into its env file, which needs no shared network. | the canary accepting stable's keys |

Some answers to the open questions would amend a row:
- question 1's shared network for the forwarders and the edge amends rows 1 and 6;
- either option in question 2 that has the edge assert a client's address amends row 7;
- question 3's shared authorization server amends row 4, and if the edge hosts it, it is row 7's rejected alternative.

Any of these needs the maintainer, not SMD-2876 alone.

## Measured (2026-10-09)

### Two instances of today's `compose.yaml`

Each render was `docker compose --env-file <file> -f deploy/compose.yaml config --format json`, on main after SMD-2583 PR 2 (#365), and again, with the same results, on main 31318101 (after #366–#368):
- once with no project name;
- once with `COMPOSE_PROJECT_NAME=inst2` in the shell, with `SERVER_PORT=8020`;
- once with `-p inst3`;
- once with an env file holding `COMPOSE_PROJECT_NAME=inst4` and `SERVER_PORT=8040`;
- twice more with every profile and `compose.host-ports.yaml`.

The results:
- **The project name.** `COMPOSE_PROJECT_NAME`, from the shell or **from the env file**, and `-p` each win over the file's `name: open-brain`. The inst4 env file renders project `inst4`, the forwarder at `127.0.0.1:8040`, the image `inst4-server`, and networks `inst4_data`, `_edge`, `_egress`, `_front` and `_mesh`.
- **No shared names.** The two instances share no network, no volume, no built image tag and no container name, and nothing is external. That holds with every profile too: the profiles' networks, such as `auth-egress` and the overlay's `postgres-port`, are prefixed with the project as well.
- **What they do share:** pulled images (Traefik, pgvector, Bun, and per profile Ollama and n8n), and read-only bind mounts of the checkout for the profiles that take them (`db/`, `server-portable/`, the orchestration runner's imports and `pipelines.json`).
- **The only collisions are host ports.** With default profiles, it's the forwarder's 127.0.0.1:8000 alone. With every profile and the host-ports overlay, both instances publish:
  - 127.0.0.1:8000 (the forwarder);
  - 5432 (Postgres);
  - 5678 (n8n);
  - 11434 (Ollama);
  - 8020 (jev, not the `SERVER_PORT=8020` of the second render).

  A second instance must set each of them.

### Reaching a brain's published port from outside its project

Each test target was a minimal HTTP server, published on 127.0.0.1, on all interfaces, or on the bridge gateway, in a network of its own. A client on a different network asked for it by the host aliases.
- **Controls:** every target answered from the host. Under podman, the first run also had each target answer from inside its own network.
- **Clean-up:** every container was named `smd2800-*`, removed by exact name, and none was left behind.

| Brain's port bound to | From the host | Container elsewhere, podman | Container elsewhere, Docker | Mac LAN address |
|---|---|---|---|---|
| `127.0.0.1` | reached | **reached** | **not reached** | not reached |
| all interfaces | reached | reached | reached | **reached: exposed** |
| the bridge gateway (`172.17.0.1`) | at that address only | (not applicable) | reached | (not measured) |

What each column was:
- **Podman:** podman machine on macOS, rootful, 6.0.2. The client asked by `host.containers.internal` and `host.docker.internal`, both 192.168.127.254, the machine's host address.
- **Docker:** Docker Engine 29.9.0 on Linux, run in a throwaway privileged `docker:dind` container in the podman machine, which played the Linux host. The client asked by `host-gateway`, 172.17.0.1.
- **Mac LAN address:** the Mac requesting its own LAN address under podman, not a request from another machine. The LAN was not tested on Linux. The bridge gateway is an address internal to the host.

What else the runs showed:
- **Isolation:** on both runtimes, a container on another network can't resolve a brain's containers by name. The only way in is the published port.
- **A false failure:** one podman client network that was created fresh got 10.89.10.0/24 and failed everything, including reaching the host. That is a known fault of this machine's podman with some fresh networks, not part of the result. The same client on 10.89.77.0/24 behaves as in the table.
- **Not measured:** rootless Docker, rootless podman, rootful podman on native Linux, Docker Desktop, and host-network mode.

So no loopback-only binding works for an edge in a container on both runtimes. Binding all interfaces works on both, but exposes the brain on the LAN. That is the edge's first decision (open question 1).

## What changes

**Instances (SMD-2873):**
- `compose.yaml`'s `name: open-brain` stays as the fallback, since the env file wins over it (measured). `tier.sh` (`NETWORK=open-brain_data,…`), `canary.sh` (`STABLE=open-brain`, `CANARY=open-brain-canary`) and the README's names read the instance's `COMPOSE_PROJECT_NAME` instead.
- Default host ports collide between instances, and the second `up` fails to bind without naming the setting. Each instance sets its own ports, and a new check before `up` names the port and its setting.
- Each instance on `local-models` runs its own Ollama and volume, so models are pulled, and held in memory, once per instance. A host Ollama shared by all instances (`deploy/.env.example`'s Option B) is the alternative. A brain reaches it from its container under podman machine; on Docker on Linux it meets the same reachability as open question 1. SMD-2873 documents both.

**The canary (SMD-2874):**
- `canary.sh`'s env file is written from stable's, so it carries stable's settings. It carries the canary's own `COMPOSE_PROJECT_NAME`, port and keys instead.
- **`compose.canary.yaml` and path mode are retired.** Path mode is canary.sh's default today: the canary at `/canary/mcp` on stable's origin, its servers on stable's mesh. canary.sh's existing `--port` mode, which runs the canary behind its own proxy, becomes the only mode. (It too takes stable's keys today, which the last bullet changes.) Retired with them:
  - check 28's entries for the overlay (`FILE_NETWORKS`, `SERVICE_NETWORKS`, `OVERLAYS`) and its eight probes of it;
  - the path-mode `up`s inside CI's "A canary stands beside the stack from deploy/canary.sh", and the path-mode refusals in "The canary's refusals…";
  - its renders in CI's "Every published port binds loopback" and "The proxy loads only the held route tables".
- **Stable's tier routes are removed:** the routers `canary` and `working`, their services, and the middleware `tier-absent`. Tier routes, where wanted, are the edge's.
  - In the checker, the shared `ROUTE_TIER_PATHS` (defined beside check 27) builds the `canary`, `working` and `tier-off` routers.
  - Check 28's `PROXY_ROUTE_TABLE` stops using it and keeps a `tier-off` router of its own.
  - Check 27's `TIER_ROUTE_TABLE` keeps it while `compose.tiers.yaml` lives.
- **Stable's `tier-off` stays until SMD-2532 removes the legacy route (v2.0.0).**
  - The legacy route is the proxy's catch-all that still hands root-path requests, such as `POST /?key=`, to the MCP server.
  - `tier-off` is a bare 404 for any path starting with `/canary` or `/working`, in any case. It keeps a changed tier URL from reaching stable through the legacy route and writing with the same key. A connector left at `…/canary/mcp` must not write into stable.
  - In CI's "The tier routes reach a tier on the mesh…", the tier-off probes stay; its tier-absent and tier stand-up probes go.
- **The canary's keys are its own.** The dogfood connector `open-brain-canary` gets the new port and a new key.

**The tier tools (SMD-2875):** today one container joins both data networks and holds both superuser passwords. Under this decision each brain is reached through its own project:
- **Refresh:** a dump streamed from stable's project into the canary's. Its re-migrate and refresh mark run in the canary's own project.
- **Replay and diff** run today over Postgres, with a hybrid arm keyed on `OB1_EVAL_EMBED`. SMD-2875 settles whether they move onto HTTP (`db/brain-compare.ts`) or keep Postgres through each brain's own project. Moving them changes what is measured.
- **Promote** reads the canary's `schema_version` and writes stable's `tier`, `promoted_schema_version` and `promoted_at`. The read runs through the canary's project, the write through stable's.

**New:**
- the edge proxy: `deploy/edge/`, its own project and port (SMD-2876);
- the federation contract: brain-to-brain operations through the edge, where there are none today beyond compare and refresh (SMD-2877).

**Retired, or replaced:** `compose.tiers.yaml` and check 27, retired or replaced by a launcher of instances and the edge (SMD-2878).

**Unchanged:** the release overlay (`compose.release.yaml`, rendered at release by `scripts/release-artifacts.ts`, not in the repo) pins images only and applies to each instance alike.

## What this reverses or amends

- **SMD-2282** (`docs/operator-surface-tiers.md`):
  - decision 4, one reverse proxy in front of a brain's own servers, is **kept**;
  - decision 14 ("One authorization server for every tier … under one public origin") is **amended** by row 4: each brain runs its own authorization server. Whether brains behind the edge share one is open question 3;
  - its passages built on tiers as paths are superseded:
    - the "Brain tiers" bullet (tiers "behind `/canary/...`") and its "As built (SMD-2294)" paragraph;
    - the `/canary/...` row of its route list;
    - the reason it gives for a separate `data` network, that the mesh is not per project because a canary joins stable's;
    - the migration-order and "What else this touches" rows that put the tiers on proxy paths;
    - the MCP clients row, which names `/canary/mcp` as the canary's URL;
    - the note that the bare `/.well-known/oauth-authorization-server` route "conflicts with nothing" with one authorization server. With one per brain behind one edge origin, it does (open question 3).
- **SMD-2294:**
  - PR 1's tier routes (#314), except `tier-off` until SMD-2532;
  - PR 2's mesh join (#316);
  - PR 3's `compose.tiers.yaml` with check 27 (#320).
- **SMD-2661:** the dogfood canary's move to `/canary/mcp`.
- **SMD-2286** (the identity chain): `compose.yaml`'s route-table comment names it as where OAuth for each tier is settled. The ticket itself speaks of one public `/mcp` resource and no tiers, so under this decision it applies to each brain's own `/mcp`.
- **`deploy/README.md`:** "A canary beside the stack" and "Refreshing a tier" describe path mode and the joined tier container.
- **`db/brain-compare.ts`:** its header says each tier is "a path on one origin since SMD-2294" and that "two tiers share an origin".

## Open questions

1. **How the edge and brains reach each other on each runtime** (SMD-2876). Measured above:
   - an edge on the host reaches loopback-bound brains on both runtimes;
   - an edge in a container reaches them under podman machine, but not under Docker on Linux. There, a brain bound to the bridge gateway or to all interfaces is reachable, and all interfaces exposes it on the LAN;
   - a brain calling a peer has the same problem in the other direction: a loopback-bound edge is unreachable from a brain's container on Docker on Linux.

   A network joined only by the brains' forwarders and the edge would work on both runtimes, but it brings back the alias rules check 28 holds for the mesh today (and amends rows; see the list under the table).
2. **The client's address through the edge** (SMD-2876). A brain's forwarder sends the PROXY protocol's first line to its proxy. With `OB1_AUTH_TRUSTED_PROXY` set, the authorization server's per-address limits (`deploy/auth/limits.ts`) then see each client's address. They are off without it, and `/mcp` has no rate limits by design (SMD-2309). Through an edge, every request would carry the edge's address. The options:
   - the forwarder accepts a PROXY line from an edge it trusts;
   - the edge writes the client into `X-Forwarded-For`. The brain's proxy trusts that header, which compose's doesn't today, and the authorization server reads the second hop (`OB1_AUTH_FORWARDED_HOPS=2`). This is the shape `deploy/.env.example` describes for a host tunnel;
   - the limits treat the edge as one client.

   The first two amend a row (see the list under the table).
3. **Routing and identity at the edge** (SMD-2876, SMD-2286):
   - **Path or host routing.** A brain's OAuth challenge fires only at its origin's `Host` and exactly the path `/mcp`, since RFC 9728 wants the protected-resource document's `resource` identical to the URL the client used (SMD-2382, as built). Path routing at the edge (`/<brain>/mcp`) therefore breaks a brain's OAuth unless the brain learns its path. Host routing (`<brain>.<domain>`) keeps it.
   - **The authorization server.** Brains behind one edge either share one or each keeps its own. Under one origin, the bare `/.well-known/oauth-authorization-server` route that Claude Code fetches can name only one.
4. **The federation contract** (SMD-2877):
   - which operations a peer may call (export, import, search, capture), with which key scope;
   - what an imported thought records (source brain, source id, source trust per SMD-1724);
   - how an idea passed A→B→A is kept from returning as a new thought;
   - per-thought export controls, since a brain holds personal data;
   - what governs the thought text a peer call sends off the box. The egress gate (SMD-1903, `server-portable/egress.ts`) covers model calls (embedding and chat). Since SMD-2681 (#368) it also gates a call that isn't a model's: `db/board-findings.ts` puts each comment it posts to Linear through `mayLeaveBox`, against an endpoint declared not local, with subject units of its own (type `board-finding`). The gate's terms name the text (actor, source, type, topic, marker), never where it goes; of the destination it reads only whether the endpoint is declared local. A peer call could be gated the same way, with units of its own, or by a new rule that names destinations.
5. **`compose.tiers.yaml`** (SMD-2878): retire it with check 27, or replace it with a launcher of N instances and the edge.

## Order

1. SMD-2873, instance identity: everything else names instances.
2. SMD-2874, the canary as an instance, and SMD-2875, tier tools through each brain's project. Either order. SMD-2874 keeps stable's `tier-off` until SMD-2532 lands.
3. SMD-2876, the edge.
4. SMD-2877, the federation contract, and SMD-2878, `compose.tiers.yaml`.

SMD-2874 reverses a mode the dogfood canary runs today. Its last step moves that canary to its own port, and its connector to that port with a key of the canary's own.

## Not decided here

- The federation contract's formats and the first-cut operations, beyond the questions open question 4 lists (SMD-2877).
- Whether the GUI (SMD-2280) serves one brain or switches between brains behind the edge.
- Whether a published edge needs rate limits that a single brain's `/mcp` doesn't have (SMD-2309's reasoning was per brain).

## Related

- `docs/operator-surface-tiers.md`: SMD-2282, three servers and an authorization server behind each brain's proxy.
- SMD-2583: the network move. `data`, `front`, `mesh` and the forwarder are what make a brain self-contained.
- SMD-1806: three brains as a promotion pipeline, which this keeps as separate instances.
- SMD-2109: `db/brain-compare.ts`, the HTTP-only compare.
