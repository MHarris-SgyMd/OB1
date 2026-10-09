# Three servers and an authorization server behind the proxy (SMD-2282)

An architecture decision record. **Decided 2026-09-27 by the maintainer.** Amended 2026-09-29 with the authorization server's selection and identity rules (SMD-2285, decisions 13–16). Amended 2026-10-01: the authorization server keeps its state in SQLite in its own volume, not in a database on the brain's Postgres (SMD-2285, "What else this touches").

The brain's deployed surface becomes three servers and an authorization server, all behind one reverse proxy:

- **A REST core** owns Postgres, egress and the contract, and answers JSON.
- **An operator GUI** in SvelteKit is a client of the REST core.
- **An MCP server** on SDK v2 is a client of the REST core too.
- **An authorization server** is its own service, off unless the operator turns it on. An OAuth token crosses from the MCP server to the REST core by token exchange. An access key is forwarded to the REST core, which checks it.

Internal names are subdomains; public routes are paths. The stack deploys by compose only.

Contributions (decided 2026-09-27, SMD-2308) are curated **plugins inside the REST core**, not servers of their own. A plugin's operations join the shared contract, its tables join a plugin ledger, and its UI is pages in the canonical GUI.

This revises SMD-2133's target of "two interfaces over one contract". That target made MCP canonical, with REST derived from it. Here **REST is the contract, and MCP is one of its clients.**

The input was the three-dashboard analysis (`docs/operator-gui-dashboards-analysis.md`, SMD-2280). It found that a GUI over today's MCP server has to scrape prose. None of the three dashboards shows the operator's own tools (13 of the 17 core tools are unused). And the two Next dashboards sit on a REST gateway that is not deployed and cannot run on the default brain.

## The decision

| # | Decided | Chosen over |
|---|---|---|
| 1 | **REST core.** One server owns Postgres, the egress gate and the contract. Every non-MCP caller uses it: the GUI, the self-hosted orchestrator (n8n) and outside callers. **Internal by default; a public route only by opt-in.** | public by default |
| 2 | **Operator GUI.** A SvelteKit server, a client of the REST core. Read views first; the other CRUD verbs follow. It **links to** the telemetry dashboards (SMD-1849) and owns no telemetry data or presentation. It harvests `-next`/`-pro`'s non-overlapping features before they retire. The current SvelteKit dashboard retires once the REST core and the MCP server are stable. | growing a Next dashboard; a GUI over MCP |
| 3 | **MCP server.** SDK v2 (SMD-2275), a client of the REST core, so behaviour that is purely MCP is isolated there. Instrumented. MCP gets its own authentication. | MCP as the core (today) |
| 4 | **One reverse proxy** in front of all three (SMD-1846). Each has its own public endpoint through it, and they talk to each other over an internal-only network. | one host port per service |
| 5 | **Subdomains for internal names, paths for public routes.** | subdomains everywhere; paths everywhere |
| 6 | **An authorization server now, as its own service.** | inside the GUI server; OAuth later |
| 7 | **Token exchange (RFC 8693)** carries an OAuth token's identity across the MCP→REST hop. **An access key is forwarded** with the MCP server's own service key, and the REST core checks it (amended 2026-09-29, SMD-2285). | a service credential plus an asserted user; exchanging keys too |
| 8 | **Compose-only deployment.** | keeping a single-process mode |
| 9 | **A contributed server (an extension or an integration) folds into the REST core as a plugin** (SMD-2308, 2026-09-27). Its operations join the shared contract, and REST and MCP expose them from one process. | a REST-core client of its own at `/ext/<name>`; unchanged standalone servers |
| 10 | **The six curated `extensions/` port to plugins** (SMD-2311). | keeping them as an undeployed learning path; retiring them |
| 11 | **`dashboards/` becomes extension pages in the canonical GUI**, registered through its nav registry. There are no standalone dashboard apps. | an open category of REST-client apps behind `/api` |
| 12 | **Extensions use the brain's identity**: keys or authorization-server tokens, checked by the REST core. There is no key list per extension. | a key list per extension |
| 13 | **The authorization server is `oidc-provider`** (panva, MIT, OpenID Certified), in a small service of our own on Bun through `node:http`, pinned to an exact version (SMD-2285, 2026-09-28). It was the only candidate to pass all eight criteria. Better Auth is the runner-up in the proof of concept. | Keycloak, Authentik, Logto, Better Auth; Zitadel, Ory Hydra and Authelia were ruled out |
| 14 | **One authorization server for every tier.** `/mcp`, `/canary/mcp`, `/working/mcp` and each tier's REST core are distinct resources (RFC 8707 audiences) under one public origin. | one per tier |
| 15 | **Operator sign-in is a passkey, with a password fallback**, both at the authorization server. **Break-glass:** key sign-in to the GUI on a loopback-only listener that no tunnel points at. | password and TOTP; an upstream provider; no break-glass; key sign-in everywhere |
| 16 | **The `auth` compose profile is the switch** (SMD-2382, 2026-09-29). Setting the public origin without it means keys only. | the origin being the switch |

## The shape

```
                 ┌───────────── edge network ─────────────┐
 client ──https──▶  proxy                                  │
                 │   /mcp        → mcp.ob1.internal        │
                 │   /dashboard  → app.ob1.internal        │
                 │   /auth       → auth.ob1.internal       │
                 │   /grafana    → lgtm (SMD-1849 profile) │
                 │   /api        → api.ob1.internal  (opt-in, off by default)
                 │   /health     → mcp.ob1.internal  (keyed; plain "ok" without a key)
                 │   /hooks/<name> → api.ob1.internal (a plugin's webhook; off by default, per plugin)
                 └───────────────┬────────────────────────┘
                                 │  mesh network (internal: true, no outbound route)
   mcp ──token exchange──▶ auth  │  (OAuth tokens only; keys are forwarded to api)
   mcp ─────REST client──▶ api ◀──── REST client ── app
   n8n ─────REST──────────▶ api ──▶ postgres
   n8n ──runner key──▶ orchestration-runner ──▶ postgres
   db/ workers, board-sync (core codebase, separate processes) ──▶ postgres

   egress network (outbound allowed): api, db/ workers, board-sync, orchestration-runner
                                        → Ollama / Jev / OpenRouter (board-sync also → Linear);
                                      n8n → Linear, Gmail; auth → client metadata fetches
```

- **Public routes:**

  | Path | Service |
  |---|---|
  | `/mcp` | MCP server (SMD-2287) |
  | `/dashboard` | operator GUI (SMD-2280) |
  | `/auth` | authorization server (SMD-2285) |
  | `/grafana` | SMD-1849 |
  | `/api` | REST core (SMD-2284), off by default |
  | `/health` | MCP server: keyed BrainInfo JSON read from the REST core, plain `ok` without a key (today's contract) |
  | `/hooks/<name>` | a plugin's inbound webhook, served by the REST core. Off by default and turned on per plugin, like `/api` (decision 9). There is no `/ext/<name>`: extensions are plugins, not servers |
  | `/canary/...` | the canary tier's equivalents (SMD-2294). As built: `/canary/mcp` and `/working/mcp` reach that tier's MCP server as `mcp.canary.ob1.internal` or `mcp.working.ob1.internal` on the mesh, a 404 while it is absent; the rest under either prefix, in any letter case, is a 404 |

- **Two networks.**
  - **Mesh network.** Internal names are network aliases on a compose network with `internal: true`: `api.ob1.internal`, `mcp.ob1.internal`, `app.ob1.internal`, `auth.ob1.internal`. Postgres and every service join it. Calls between services still authenticate; being on the network is not trust.
  - **Egress network.** An `internal: true` network has no outbound route, to the internet or to the host. So the services that must reach out also join an ordinary network:
    - the REST core, for Ollama (host Ollama on the dogfood stack), Jev and OpenRouter;
    - every worker-class process that calls a provider: the `db/` workers (extract, consolidate, reembed, rebuild's pools), board-sync (also Linear), and the `orchestration-runner`;
    - n8n, for Linear and Gmail;
    - the authorization server, which fetches client ID metadata documents. Each fetch goes through a guard that refuses private, loopback, link-local, CGNAT and `*.ob1.internal` targets, because the server also sits on the mesh (SMD-2285).

    The MCP server and the GUI stay mesh-only. The proxy joins the edge network and the mesh.
  - **As built (SMD-2583, the network move):** `deploy/compose.yaml` puts no service on compose's default network, and check 28 holds each service's networks exactly. It departs from the above in four places:
    - **Postgres is on a third internal network, `data`, not the mesh.** `data` holds Postgres and only what connects to it: the migrator, the MCP server, the REST core, board-sync, the workers, the import runner and its role's one-shot. The mesh is not per project, because a canary of another project joins stable's (SMD-2294), and compose names every container by its service name on each network it joins. Stable's Postgres on the mesh would then answer the canary's `postgres:5432`. The canary also has a database password of its own, and its env file holds no credential to stable's database (stable's password, of 12 characters or more, is in none of its values, which every `up` checks): `deploy/canary.sh` writes `.env.canary.local` from stable's env file at its first `up`, as compose reads it, with a fresh password and without the other profiles' secrets, and sets the canary database's password to it at every `up`.
    - **The MCP server is on `data` and `egress` too.** It still embeds and writes for itself; it can be mesh-only once it calls the REST core (SMD-2287).
    - **The authorization server's way out is a network of its own, `auth-egress`.** On the shared `egress` it would reach Ollama, Jev, n8n and the runner, and its fetch guard would be all that stood between them and an outsider's URL.
    - **n8n is on `egress` alone, not the mesh.** It reaches `server:8000` and `orchestration-runner:8090` there. `egress` is per project, so no tier's `server` answers it there, which the mesh cannot promise.

    The proxy's outward network is `edge`, which nothing else joins. A container on internal networks alone publishes no port, and its DNS forwards no name it does not hold (both measured on podman 6). So until the proxy sits on internal networks behind a forwarder, a name the proxy dials that nothing holds still reaches the host's resolvers through `edge` (SMD-2583's second part). `compose.host-ports.yaml` gives Postgres a lone outward network, `postgres-port`, for its loopback port. CI's "Postgres answers on the data network alone" shows that a container on `egress` cannot open a connection to Postgres, by name or by address.
- **Postgres from the host** stays an operator opt-in: `deploy/compose.host-ports.yaml` publishes it on loopback (SMD-1844). A host-run `db/` script or recipe uses that overlay, or runs in a tools container on the mesh (SMD-1869).
- **The REST core's own `/health` is internal only.** Brain identity and ledger freshness reach the public side through the MCP server's `/health`, the one probe URL for `smoke.sh`, the image healthcheck and `db/brain-compare.ts`.
- **`/.well-known/` stays a 404 except three routed paths, and those only while the `auth` profile is configured:**
  - `/.well-known/oauth-protected-resource/mcp` goes to the MCP server (RFC 9728).
  - `/.well-known/oauth-authorization-server/auth` goes to the authorization server (RFC 8414).
  - The bare `/.well-known/oauth-authorization-server` goes to the authorization server too. Claude Code 2.1.275 fetches only that URL and ignores the issuer's path (anthropics/claude-code#95270). With one authorization server (decision 14) the route conflicts with nothing. Its document names the issuer `…/auth`, not the bare origin, so whether Claude Code accepts it is a proof-of-concept check.
  The first two use the path-inserted form those RFCs define for a resource or issuer that lives under a path.
  - **As built (SMD-1846 PR 2, 2026-10-02):**
    - The proxy routes the authorization server's paths while it *answers*. Otherwise Traefik's 502 is rewritten to a 404, so an origin without it reads as "no OAuth here".
    - The server's start is where *configured* is enforced: it exits 2 unless deploy/.env's `COMPOSE_PROFILES` names `auth` (`deploy/auth/config.ts`). So a server started with `--profile auth` on the command line alone never answers, and answering means configured and reachable.
    - Its session cookie is `Path=/auth`, so on the shared origin it rides no other route.
    - OIDC's `/.well-known/openid-configuration/auth` is routed beside the two above; the server serves it.
    - The protected-resource path is routed to the MCP server (SMD-2382), which serves the document only while it advertises OAuth, and answers 404 otherwise; a server that is down is the proxy's 404 too, never a 502. The proxy also answers `/register`, `/authorize` and `/token` at the root with a 404: an MCP client that finds the document and no authorization-server metadata signs in at the issuer's root, and the legacy route would hand that to the MCP server.
- **Path-based public routes carry obligations:**
  - The GUI sets SvelteKit's `paths.base` and scopes its cookie to `Path=/dashboard`, so the cookie never reaches another route.
  - The authorization server's issuer is `${OB1_PUBLIC_ORIGIN}/auth`, set from configuration and never derived from request headers (SMD-2382).

## Identity

- **The switch and its two states** (decision 16, SMD-2382). One setting, `OB1_PUBLIC_ORIGIN`, fixes the issuer, the protected-resource URL, the passkey relying-party ID and every redirect URI. OAuth exists only when the `auth` compose profile is enabled, and the profile refuses to start without the origin. Two states are kept apart:
  - **Configured** is static: `COMPOSE_PROFILES=auth` in `deploy/.env`, interpolated into each service that acts on it (as built: the authorization server and the MCP server's environment). **Security rules key on it.** While configured, the GUI's public port never offers key sign-in and the REST core never drops its issuer check, even with the authorization server down.
  - **Reachable** is dynamic: `auth.ob1.internal` answers its health check. **Only what is advertised or offered keys on it**: the protected-resource metadata, the 401 challenge and passkey sign-in. Knocking the authorization server over closes those; it never opens a weaker door.
  - Not configured, with or without an origin, is today's posture: keys only. That covers loopback-only stacks, the quick tunnel (whose name changes every start) and a named tunnel whose operator wants no OAuth.
- **The REST core is the only resource server that authorizes.**
  - Access keys keep their read / write / capture scopes (`server-portable/auth.ts`).
  - The authorization server's tokens map to the same three scopes: `brain:read`, `brain:write`, `brain:capture`.
  - The audit actor is the subject, plus `act` when a service delegated. A key's subject is its bare name, and an OAuth subject is `oauth:<sub>`. So a key can never read as a signed-in identity, because `keygen.ts` allows no `:` in a key name. Existing rows, `actor:` egress terms and the search tools' `actor` filter keep matching, since each already reads a key's bare name.
  - No privilege exists only in OAuth.
- **MCP server:**
  - While the authorization server is reachable, it serves protected-resource metadata and answers 401 with `WWW-Authenticate`. The challenge goes only on requests whose `Host` is the public origin, so a keyless loopback client gets today's refusal (HTTP 200 carrying JSON-RPC -32001, or a bodyless 202 for a notification) rather than an OAuth flow it can never finish. Keying this on `Host` fails safe; no security rule keys on `Host`.
  - While configured but unreachable, OAuth clients get a 503, not a 401 that would restart their sign-in.
  - **As built (SMD-2382, `server-portable/oauth-edge.ts`):**
    - The challenge goes only on a request for the resource itself: the origin's `Host` (a port the scheme implies counts as none) and exactly the path `/mcp`, any query, since RFC 9728 wants the document's `resource` identical to the URL the client used. `/mcp/`, the root URL kept for SMD-2306's window, and any `Host` but the origin's (loopback, a LAN address, another name) keep today's refusal.
    - A key in any form, wrong, empty or malformed (`Authorization: Bearer ` with nothing after it), is a key client's: it gets today's refusal in every state, so this server's 401 never sends a key client to sign in. Only a request with no key form (another scheme, such as `Basic`, is none), or with a bearer of a JWT's shape and no key beside it, is answered for OAuth. (claude.ai fetches the document by itself, without its key, so a `?key=` connector at `/mcp` of a configured stack is asked to sign in; once through, its key authenticates before the token and it is served. A connector with no key loops until SMD-2286 accepts the token: the `auth` profile is a preview until then.)
    - Reachable is a GET of `auth.ob1.internal`'s `/healthz`, a 200 within 2 s, its answer kept 30 s, and only for a request the answer turns on. The MCP server is on the mesh for it, as `mcp.ob1.internal`.
    - Its keyed `/health` carries its own view beside the brain's record: configured, the origin, advertised now. `smoke.sh` compares that view with what reaches the server through the URL it was given, which is how a tunnel that does not keep the origin's `Host` is found.
    - Configured with an unsound origin, there is no resource to recognise: every request is answered as on a stack that is not configured, a token's included (today's refusal, not the 503). The authorization server refuses to start on the same origin, and preflight warns.
    - At any `Host` but the origin's a bearer token is refused as today: hosts reach the brain with keys. (An origin that is itself loopback, `http://localhost:8000`, is the public resource at that exact host and port.)
    - Until the identity chain (SMD-2286) checks tokens, a token is refused `invalid_token`.
  - It exchanges each incoming OAuth token (audience = the public `/mcp` resource) for a REST-core token under its own client credentials. It caches the result by the incoming token, never by subject alone. One operator can hold a read-scope connector and a write-scope connector.
  - The MCP authorization spec forbids passing the received token upstream; exchange is how the hop keeps both the subject and the delegating service.
- **Access-key MCP clients** (the hook, `?key=` connectors) are **forwarded** (decision 7, SMD-2286 step 4). The MCP server passes the key to the REST core with its own forwarder key. The REST core checks both, and records the key's name as the subject and the MCP service as the actor.
  - The forwarder is a key with a `forward` scope that grants nothing by itself. The REST core refuses any other key in the forwarder's place, so a client holding two keys cannot stamp one as the other's actor (SMD-2284).
  - **As built (SMD-2284):** the slot is the `x-brain-forwarder` header, read only inside the stack — the mesh, and `data` and `egress`, where the REST core also listens since the network move (SMD-2583) — since the public `/api` route deletes it; inside, what guards it is the forwarder key, which nothing sends until SMD-2286's step 4. The audit row records the subject as ever (`actor_name`, `canonical_agent_id`) and the carrier in `thought_audit.actor_context.act` as `{name, agent_id}`. `act.name` follows `actor_name`'s convention above: a key's bare name, and for a token-exchanged request (SMD-2286) `oauth:<client_id>` from the exchanged token's `act.sub` — one shape on the audit row, which is append-only, whichever way the request was carried.
  - This is not the token passthrough the spec forbids. That rule covers OAuth tokens issued for the MCP server, and a brain key is the REST core's own credential, checked there.
  - Forwarding works in every state and needs no authorization server. Keys therefore survive its outage, the capture hook included.
- **GUI:**
  - A confidential client using authorization code with PKCE, asking for the REST core as the resource (RFC 8707).
  - Tokens live in the sealed server-side session and never reach the browser, the same pattern the SvelteKit dashboard uses for the key today.
  - Sign-in is a passkey with a password fallback while configured (decision 15), and a key when not.
  - Break-glass key sign-in stays available on a separate port published only on `127.0.0.1`. Neither the source IP nor `Host` can tell local from public, because every documented tunnel dials `127.0.0.1`.
- **Clients inside compose** (n8n, the `db/` worker containers) call the REST core directly on the mesh with an access key.
- **Clients on the host** cannot reach the mesh: the session-capture hook (`OB1_BRAIN_URL`), `db/brain-compare.ts`, Claude Code's MCP entries and `db/` scripts run from the host.
  - They keep keys and may use the loopback URL. OAuth needs the public origin, which is a different resource from `http://127.0.0.1…/mcp` (SMD-2382).
  - `/api` is available where the operator has turned it on.
  - The hook stays an MCP client. It reads the SMD-1978 refusal codes from `structuredContent`, which SMD-2287 must carry over exactly.
- **Multi-user isolation stays deferred** (SMD-1716). The authorization server introduces identities, not tenants.

## Where everything else lives

- **Workers and `db/` scripts** stay in the core codebase as separate processes on Postgres (SMD-2134). They sit on the mesh and the egress network (as built, `data` and `egress`: none answers on the mesh, and `data` is where Postgres is; SMD-2583). They are controlled through the REST core's worker routes (SMD-2131/2132), not a container shell.
- **The `orchestration-runner`** (SMD-2212, on main since #222) is a worker-class process of the same kind. n8n asks it over HTTP, with `OB1_RUNNER_KEY`, to run one allowlisted pipeline (`db/ingest-records.ts`, then `db/reembed.ts`) straight against Postgres. It stays that way: an import is a batch write, like board-sync's, not a REST call per item. Its HTTP endpoint is mesh-only and answers n8n alone. (As built, SMD-2583: on `egress`, where n8n is, so every container there reaches its port; `OB1_RUNNER_KEY` is what answers n8n alone.)
- **Egress.** Every process that calls a provider joins the egress network. The gate is the shared `server-portable/egress.ts`, which each process enforces for itself; the REST core is the only egress point for requests that arrive over HTTP.
- **Destructive-verb guards** live in the REST core, so every client gets them. These are the bulk cap, re-verify before delete, and restricted state from the principal, which `-pro` put in its route handlers.
- **Prose, `structuredContent`, refusal envelopes, SSE keepalive, notification handling and the scope-filtered `tools/list`** belong to the MCP server alone.
- **Telemetry:** each server emits OTLP spans with the SMD-1849 allow-list. The MCP span is the parent of the REST span through `traceparent`. Grafana owns storage and presentation.
- **Brain tiers** (stable / canary / working): one REST core per tier, with the MCP server and the GUI per tier behind `/canary/...`. The exact split is settled in SMD-2294.
  - **As built (SMD-2294):** the canary stays a compose project of its own (`deploy/canary.sh`), with its own Postgres. `deploy/compose.canary.yaml` puts its MCP server and REST core on stable's mesh as `mcp.canary.ob1.internal` and `api.canary.ob1.internal`, under those names alone, and stable's proxy routes `/canary/mcp` to the first. On stable's mesh it would also resolve stable's `auth.ob1.internal`, which settles how a tier reaches the one authorization server across projects; until a tier has OAuth of its own (SMD-2286) the canary runs with no compose profiles, advertises none and dials no `*.ob1.internal` name of stable's. `deploy/compose.tiers.yaml`, the three tiers as one stack, gives each tier its MCP server and REST core and puts one proxy in front, with `/mcp`, `/canary/mcp`, `/working/mcp` and stable's `/health` the only public paths; no tier publishes a port of its own. The GUI per tier waits on SMD-2280.

## Contributions and plugins

Decided 2026-09-27 (SMD-2308, decisions 9–12).

- **A plugin is a directory with a manifest** (SMD-2310) that declares:
  - its operations (zod in and out, a handler given the principal and the core services);
  - its tables, as migrations in a plugin-scoped ledger that `db/migrate.ts` applies and reports;
  - its grants;
  - its optional GUI pages, with a nav entry for the GUI's registry;
  - the scope each operation needs.
- **Plugins are enabled per deployment by config.** A disabled plugin registers nothing, and its tables are left alone, never dropped.
- **Enabled plugins join the shared contract.** REST routes are namespaced, MCP tools prefixed, and OpenAPI lists them. `whoami` scope checks apply as for core operations.
- **Boundaries inside the process:**
  - a plugin reaches core data only through core operations and services, never raw SQL on `thoughts` or other core tables (the checker holds this);
  - its own tables come through a plugin-scoped handle;
  - egress goes through the shared gate.
- **A plugin that needs an inbound webhook** (a capture source) is exposed at `/hooks/<name>`, off by default and turned on per plugin.
- **Plugins are curated.** They run in the REST core's process with the brain's privileges, so every plugin is maintainer-reviewed. `integrations/` stops being an open category for anything that touches the brain. Contributions that never touch the brain are out of this repo's surface.
- **The six curated extensions port to plugins** (SMD-2311). Each tool becomes an operation. Each `schema.sql` becomes plugin migrations that adopt existing tables. professional-crm's direct `thoughts` read (`extensions/professional-crm/index.ts:480-485`) becomes a core-operation call. Upstream's multi-user `user_id` columns get a decision for each plugin (SMD-1716 stays deferred).
- **Community UI** is a plugin's GUI pages in the canonical GUI (decision 11). The Next dashboards' snippets (`schemas/*/dashboard-snippets`, `recipes/wiki-synthesis/dashboard-snippets`) are ported that way or retired (SMD-2280).
- **Identity** is the REST core's (decision 12). No plugin mints or checks its own keys.

## Migration order

| Step | Ticket | Done when |
|---|---|---|
| 1 | SMD-2283: extract a transport-free core from `server-portable/index.ts` (`buildServer`, `:809`–`:2526`) | The suites pass unchanged; `index.ts` calls only the core |
| 2 | SMD-2284: the REST core server, over the core, JSON and OpenAPI from one zod source (SMD-1931) | A contract test agrees with MCP for every operation |
| 3 | SMD-1846 (revised): the proxy and internal network, alongside SMD-1849 | One published port; streaming passes through unbuffered |
| 4 | SMD-2280: the GUI's read views against the REST core | The smoke renders every read view with three key scopes |
| 5 | SMD-2287: the MCP server on v2 as a REST client; parity, then canary, then cutover | The suites pass against it; `index.ts` registers no tools |
| with 3 | SMD-2382: the public origin and the `auth` profile switch | Each of the four states (no origin; an origin without the profile; configured and reachable; configured and unreachable) behaves as the Identity section says |
| 6 | SMD-2285, then SMD-2286: authorization server and identity chain. The pick is made (decision 13); the proof of concept runs next, in parallel | A claude.ai connector signs in and its audit row names the subject and `act` |
| 7 | SMD-2288: compose-only; retire the Workers target; rewrite the guard rail and SETUP.md | No doc names a non-compose deployment |
| with 2, 5 | SMD-2296: release images per server, the CI full-stack job through the proxy, the landing check and counted surfaces | A release rehearsal smokes every pulled image |
| after 5 | SMD-2294: the tier stack (`compose.tiers.yaml`, `canary.sh`, `tier.sh`, `--compare`) on proxy paths | No `:8010`–`:8012` left in `deploy/` or `db/` |
| after 2 | SMD-2295: n8n reaches the brain through the REST core; the orchestration ADR's boundary amended | A template's brain call audits as n8n's key |
| after 2 | SMD-2310: the plugin mechanism; CONTRIBUTING, the PR template and CLAUDE.md's repo-structure lines describe it | A sample plugin appears in OpenAPI, `tools/list` and the GUI nav only when enabled |
| after SMD-2310 | SMD-2311: the six curated extensions become plugins; their standalone servers retire | No `extensions/*/index.ts` server remains |

SMD-2278 (server-portable to SDK v2) has landed (#226), so the current server is on v2 through the transition. SMD-2279 (vendored servers to v2) mostly becomes retirement under SMD-1931.

**Rule for new work while the migration runs:** a new brain operation (SMD-1715's deliverables, SMD-1723's forget, SMD-2272's drain, SMD-2273's jobs, SMD-2261's watermark, SMD-1812's page store, and any contributed capability as a plugin, SMD-2310) is written as a core operation in the shared zod contract (SMD-2283 / SMD-1931), exposed by the REST core and projected to MCP. It is never an MCP-only tool. Until SMD-2283 lands, it may still land in `index.ts`, but its logic goes in a module the core can import.

## What else this touches

Read against the tree on 2026-09-27.

| System | Change | Ticket |
|---|---|---|
| Tier stack (stable / canary / working on 8010–8012) | Each tier is a REST core plus an MCP server on proxy paths | SMD-2294 |
| MCP clients (Claude Code entries, claude.ai / Desktop connectors) | URLs become `https://<host>/mcp` and `/canary/mcp`; keys keep working; OAuth becomes available | SMD-2294, SMD-2286 |
| Session-capture hook | New URL; stays an MCP client; refusal codes carried over exactly | SMD-2287 |
| board-sync and the `db/` scripts | 35 files import `server-portable` modules (`entities`, `embed`, `chunk`, `egress`, `store`, …) and none import `index.ts`. SMD-2283 keeps those paths. The worker containers join the mesh and the egress network (they call providers); as built, `data` and `egress` (SMD-2583) | SMD-2283, SMD-2134, SMD-1869 |
| n8n | Brain calls move from MCP to the REST core. SMD-2212 (merged, #222) needs no re-aim for its import: n8n calls the `orchestration-runner`, not the brain. Its act tool is n8n's own endpoint | SMD-2295 |
| `orchestration-runner` (#222) | A worker-class DB writer on the mesh and the egress network (as built, `data` and `egress`, where n8n reaches it; SMD-2583). Its per-uid egress rules (SMD-2289) are the container's own network namespace's, so they hold whichever networks it joins | SMD-2289 |
| `integrations/kubernetes-deployment` | Retires under compose-only | SMD-1931, SMD-2288 |
| Jev, the LLM env forwarding, the preflight entrypoint | Move from the `server` service to the REST core | SMD-2284 |
| Release images and CI | `ob1-server` becomes one image per server; the full-stack job goes through the proxy; the Workers build retires | SMD-2296, SMD-2288 |
| Docs and skills with the one-process `?key=` URL shape | One bring-up path and the new URLs | SMD-2288 |
| `chrome-capture-extension`, `recipes/*` MCP callers, agent-memory plugins | New URLs; the extension is a client of `/api` (`POST /v1/thoughts`) since `open-brain-rest` retired | SMD-1931 |
| Secrets in `deploy/.env` | The authorization server's signing key, its cookie keys, each static client's secret, and the operator's password (which the operator may remove once hashed) and its argon2id hash, written by `deploy/auth/provision.ts --init`, with the backup note (`deploy/README.md`, "Authorization server"). The container is given the hash, never the password | SMD-2285 |
| The authorization server's store, backup and restore | One SQLite file in the `auth` service's own volume, through an oidc-provider adapter of ours (`deploy/auth/store.ts`), backed up with `VACUUM INTO` beside the running server. Decided 2026-10-01 in place of an `ob1_auth` role and database on the brain's Postgres: the internet-facing server then holds no Postgres credential (as built, Postgres is on `data`, which the authorization server never joins, so the two share no network either; SMD-2583), and `pg_dump openbrain` and `db/tier.ts --refresh` are unchanged | SMD-2285 |
| `docs/01-getting-started.md` (quick tunnel first) | OAuth and passkeys need a stable origin: a named tunnel, Tailscale Funnel or your own domain. The quick tunnel stays key-only | SMD-2382 |

## Retirement conditions

Which vendored integrations become plugins and which retire was decided on 2026-10-08 (SMD-1931), with each REST gateway route's fate: [`docs/vendored-disposition.md`](vendored-disposition.md), "The brain's outward surface". Plugins: agent-memory-api, smart-ingest and readwise-capture (SMD-2690), slack- and telegram-capture (SMD-2101). Retired: the two REST gateways, enhanced-mcp, the delete- and update-thought servers and discord-capture, all gone from the tree with SMD-1931; and kubernetes-deployment, whose removal is SMD-2288. The Chrome capture extension becomes a client of `/api`.

| Surface | Retires when |
|---|---|
| `dashboards/open-brain-dashboard-next`, `-pro` | SMD-2280's harvest list is recorded. They are deployed nowhere. |
| `integrations/open-brain-rest`, `integrations/rest-api` | Every route has a disposition against the REST core (SMD-1931). **Met and retired** (SMD-1931 PR 3). |
| server-portable's MCP registration | The MCP server passes parity and the stable tier's `/mcp` routes to it (SMD-2287) |
| The Cloudflare Workers target and the PostgREST store it selects | After SMD-2287's cutover (SMD-2288) |
| `dashboards/open-brain-dashboard` (current SvelteKit) | The REST core and MCP server are stable (decision 2) |

## What this reverses or amends

- **Change 042 ("OAuth discovery is a 404", SMD-1246):** three `/.well-known/` paths are now routed, and only while the `auth` profile is configured. Everything else stays a 404.
- **SMD-1846's "OAuth not in scope":** OAuth is in scope. Auth stays in the services, not the proxy.
- **`docs/orchestration-tool.md`:** n8n "reaches the brain only through its MCP surface". Under decision 1 it reaches the REST core instead. The key discipline (a capture-scope key in a domain-pinned credential) carries over unchanged.
- **CLAUDE.md's MCP guard rail:** "one HTTP process reached by URL", never stdio, still holds for the MCP server. The reference deployment becomes the compose stack, not the Bun container (SMD-2288, maintainer review of the wording).
- **SMD-2133's "Target end-state":** REST is canonical, and the deployed surface is three servers, not two interfaces on one process.
- **`docs/mcp-sdk-v2-migration.md` (SMD-2275):** it calls server-portable "the canonical one-HTTP-process server". Its staging still holds, but the long-term MCP surface is SMD-2287's server, a client of the REST core.
- **`integrations/kubernetes-deployment`:** under compose-only it has no deployment target. It retires, with SMD-1931 recording the disposition and SMD-2288 the removal. SMD-2259, the Kubernetes step of SMD-2080 and the Kubernetes outlier in SMD-2281 are held for that.

- **CONTRIBUTING.md's "Remote MCP pattern" (`:132`, `:382`), the PR template's server checkbox and the `dashboards/` and `integrations/` category rows** (CLAUDE.md, CONTRIBUTING.md) describe standalone `bun <file>` servers with their own keys. Decisions 9–12 replace them with the curated plugin pattern (SMD-2310 rewrites them). SMD-1846's `/ext/<name>` row becomes `/hooks/<name>`.

## Not decided here

- **The authorization server's remaining details**, each in its own ticket:
  - token lifetimes and refresh-token rotation (SMD-2286);
  - the client-metadata fetch policy (resolve-and-refuse, or an allowlist) (SMD-2285). Whether `openbrain` revokes PUBLIC's CONNECT went with the `ob1_auth` role: the authorization server reaches no database (2026-10-01).

  The survey behind decision 13 (eight candidates at the versions checked on 2026-09-28) is on SMD-2285.
- **The importance scale, the restricted-content lock and kanban's status column.** Each is non-core schema today (`schemas/enhanced-thoughts`, `schemas/workflow-status`); adopting one is a migration decision of its own.
- **Operations that exist only on the command line or not at all**, needed by the GUI's later views, filed when the GUI reaches them:
  - supersession accept/reject (`db/consolidate.ts --accept/--reject`), where the list tool now also has a `stale` status (migration 063) and a `lineage` selector (070);
  - `rebuild_derived`, its orphan sweep and its census (migration 063, `db/rebuild.ts`);
  - lineage and provenance reads;
  - an entity-graph read.

## Related

- `docs/operator-gui-dashboards-analysis.md`: the three dashboards, the feature matrix and the operator gaps.
- `changes/152-the-dashboards-off-supabase.md`: the sealed-session sign-in the GUI starts from.
- SMD-2133 (epic), SMD-1931, SMD-1846, SMD-1849, SMD-2275/2278/2279, SMD-2131/2132, SMD-2134, SMD-1716, SMD-1246, SMD-2285/2286, SMD-2382.
