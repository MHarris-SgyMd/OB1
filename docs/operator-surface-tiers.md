# Three servers and an authorization server behind the proxy (SMD-2282)

An architecture decision record. **Decided 2026-09-27 by the maintainer.** Amended 2026-09-29 with the authorization server's selection and identity rules (SMD-2285, decisions 13–16). Amended 2026-10-01: the authorization server keeps its state in SQLite in its own volume, not in a database on the brain's Postgres (SMD-2285, "What else this touches"). Amended 2026-10-10 by SMD-2872 (`docs/one-brain-per-stack.md`): each brain is its own stack, so decision 14 becomes one authorization server per brain, and the passages here that put the tiers on paths of one origin (`/canary/...`) are superseded; that ADR lists them. Amended 2026-10-13 (SMD-2928): the two passages that route n8n, the `db/` worker containers and a tools container over the mesh say which networks each is on as built (SMD-2583). Amended 2026-10-16 (SMD-2876): the bare discovery route's note says what it names behind the edge proxy, where sign-in waits for TLS (SMD-3053). Amended 2026-10-16 (SMD-2286): Identity says how the REST core accepts the authorization server's tokens as built, the token lifetimes are decided (Not decided here), and the GUI's sign-in and the revocation page are SMD-2280's. Amended 2026-10-20 (SMD-2286 PR 2): Identity says how the MCP server trades a client's token at the hop as built. Amended 2026-10-28 by SMD-3215 (`docs/brain-coordinator.md`, not yet built): a per-brain coordinator runs every task, and a plugin operation's implementation may be an n8n workflow it runs. Such a call reaches the REST core as a run, a fourth way beside a key, a forwarded key and an exchanged token, bounded by its caller's scope and the operation's. "A plugin is given no outbound call" stays true of plugin code; outbound calls are n8n's, through credentials pinned to their hosts.

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
                 │   /grafana    → lgtm.ob1.internal (opt-in, off by default)
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
  | `/grafana` | Grafana (SMD-1849), off by default |
  | `/api` | REST core (SMD-2284), off by default |
  | `/health` | MCP server: keyed BrainInfo JSON read from the REST core, plain `ok` without a key (today's contract) |
  | `/hooks/<name>` | a plugin's inbound webhook, served by the REST core. Off by default and turned on per plugin, like `/api` (decision 9). There is no `/ext/<name>`: extensions are plugins, not servers |
  | `/canary/...` | the canary tier's equivalents (SMD-2294). As built: from SMD-2294, `/canary/mcp` and `/working/mcp` reached that tier's MCP server as `mcp.canary.ob1.internal` or `mcp.working.ob1.internal` on the mesh. Since SMD-2874 a canary is a brain on its own port; SMD-3057 deprecated the two routes for a release, and SMD-2874 PR 3 removed them from `compose.yaml`'s proxy at v2.0.0, where every path under either prefix, in any letter case, is the proxy's own 404, `tier-off` going with the legacy route in the same release (SMD-2532). `compose.tiers.yaml`'s went with that file (SMD-2878) |

- **Two networks.**
  - **Mesh network.** Internal names are network aliases on a compose network with `internal: true`: `api.ob1.internal`, `mcp.ob1.internal`, `app.ob1.internal`, `auth.ob1.internal`. Postgres and every service join it. Calls between services still authenticate; being on the network is not trust.
  - **Egress network.** An `internal: true` network has no outbound route, to the internet or to the host. So the services that must reach out also join an ordinary network:
    - the REST core, for Ollama (host Ollama on the dogfood stack), Jev and OpenRouter;
    - every worker-class process that calls a provider: the `db/` workers (extract, consolidate, reembed, rebuild's pools), board-sync (also Linear), and the `orchestration-runner`;
    - n8n, for Linear and Gmail;
    - the authorization server, which fetches client ID metadata documents. Each fetch goes through a guard that refuses private, loopback, link-local, CGNAT and `*.ob1.internal` targets, because the server also sits on the mesh (SMD-2285).

    The MCP server and the GUI stay mesh-only. The proxy joins the edge network and the mesh (as built, `front` and the mesh, internal both, behind a forwarder on `edge`; SMD-2583).
  - **As built (SMD-2583, the network move):** `deploy/compose.yaml` puts no service on compose's default network, and check 28 holds each service's networks exactly. It departs from the above in five places:
    - **Postgres is on a third internal network, `data`, not the mesh.** `data` holds Postgres and only what connects to it: the migrator, `server` (server-portable's MCP server, called by nothing in the stack since SMD-2295, retired in SMD-2287 PR 6b; the `mcp` service at /mcp is on the mesh alone), the REST core, board-sync, the workers, the sleep scheduler, the import runner and its role's one-shot, and the observability profile's Postgres exporter and its role's one-shot (SMD-1849). The mesh is not per project, because a canary of another project joins stable's (SMD-2294; no longer since SMD-2874, `docs/one-brain-per-stack.md`), and compose names every container by its service name on each network it joins. Stable's Postgres on the mesh would then answer the canary's `postgres:5432`. The canary also has a database password of its own, and its env file holds no credential to stable's database (stable's password, of 12 characters or more, is in none of its values, which every `up` checks): `deploy/canary.sh` writes `.env.canary.local` from stable's env file at its first `up`, as compose reads it, with a fresh password and without the other profiles' secrets, and sets the canary database's password to it at every `up`.
    - **The MCP server is on `data` and `egress` too.** It still embeds and writes for itself; it can be mesh-only once it calls the REST core (SMD-2287). **As built (SMD-2287 PR 5b):** `/mcp` is the `mcp` service's, on the mesh alone, every tool a call on the REST core; `server`, on `data` and `egress` alone, nothing of the proxy's routing to it since SMD-2532 closed the root, is called by nothing in the stack: n8n's brain calls and the orchestration eval's go to the REST core (SMD-2295). It retires in SMD-2287 PR 6.
    - **The authorization server's way out is a network of its own, `auth-egress`.** On the shared `egress` it would reach Ollama, Jev, n8n and the runner, and its fetch guard would be all that stood between them and an outsider's URL.
    - **The observability profile's exporter is scraped on a network of its own, `telemetry`** (SMD-1849), internal, holding `lgtm` and the exporter alone: the exporter is on `data` to read Postgres, and on the mesh it would answer every service there.
    - **n8n is on `egress` alone, not the mesh.** It reaches `orchestration-runner:8090` there, and its brain calls go to the REST core there as `api:8000` (SMD-2295). `egress` is per project, so no tier's `api` answers it there, which the mesh cannot promise.

    A container on internal networks alone publishes no port, and its DNS forwards no name it does not hold (both measured on podman 6). So the proxy is on internal networks alone, `front` and `mesh`, and a name it dials that nothing holds never reaches the host's resolvers. The published port is a forwarder's, on `edge` (outward, nothing else on it) and `front`: a TCP forwarder of ours, inline in compose.yaml, that dials the proxy only at an address on `front` (its own lookup reaches the host's resolvers while the proxy is down) and opens each connection with the PROXY protocol's line naming the client, which the proxy trusts from the private ranges, so the authorization server's per-address limits still see each client (SMD-2583's second part). `compose.host-ports.yaml` gives Postgres a lone outward network, `postgres-port`, for its loopback port. CI's "Postgres answers on the data network alone" shows that a container on `egress` cannot open a connection to Postgres, by name or by address.
- **Postgres from the host** stays an operator opt-in: `deploy/compose.host-ports.yaml` publishes it on loopback (SMD-1844). A host-run `db/` script or recipe uses that overlay, or runs in a tools container on the mesh (SMD-1869); as built, on `data`, where Postgres is, and on `egress` too when it calls a provider (SMD-2583). `deploy/tier.sh` runs each half of a refresh or promote in a container on one brain's `data` network alone (SMD-2875 PR 2), with no `egress`, since its replay moved onto HTTP (PR 1).
- **The REST core's own `/health` is internal only.** Brain identity and ledger freshness reach the public side through the MCP server's `/health`, the one probe URL for `smoke.sh`, the image healthcheck and `db/brain-compare.ts`.
- **`/.well-known/` stays a 404 except three routed paths, and those only while the `auth` profile is configured:**
  - `/.well-known/oauth-protected-resource/mcp` goes to the MCP server (RFC 9728).
  - `/.well-known/oauth-authorization-server/auth` goes to the authorization server (RFC 8414).
  - The bare `/.well-known/oauth-authorization-server` goes to the authorization server too. Claude Code 2.1.275 fetches only that URL and ignores the issuer's path (anthropics/claude-code#95270). With one authorization server (decision 14) the route conflicts with nothing. With one per brain (SMD-2872), behind the edge proxy each brain is at a host of its own, so the bare route there would name that brain's server alone (SMD-2876; sign-in through the edge waits for TLS there, SMD-3053). Its document names the issuer `…/auth`, not the bare origin, so whether Claude Code accepts it is a proof-of-concept check.
  The first two use the path-inserted form those RFCs define for a resource or issuer that lives under a path.
  - **As built (SMD-1846 PR 2, 2026-10-02):**
    - The proxy routes the authorization server's paths while it *answers*. Otherwise Traefik's 502 is rewritten to a 404, so an origin without it reads as "no OAuth here".
    - The server's start is where *configured* is enforced: it exits 2 unless deploy/.env's `COMPOSE_PROFILES` names `auth` (`deploy/auth/config.ts`). So a server started with `--profile auth` on the command line alone never answers, and answering means configured and reachable.
    - Its session cookie is `Path=/auth`, so on the shared origin it rides no other route.
    - OIDC's `/.well-known/openid-configuration/auth` is routed beside the two above; the server serves it.
    - The protected-resource path is routed to the MCP server (SMD-2382), which serves the document only while it advertises OAuth, and answers 404 otherwise; a server that is down is the proxy's 404 too, never a 502. The proxy also answers `/register`, `/authorize` and `/token` at the root with a 404: an MCP client that finds the document and no authorization-server metadata signs in at the issuer's root, and until v2.0.0 the legacy route would have handed that to the MCP server.
- **Path-based public routes carry obligations:**
  - The GUI sets SvelteKit's `paths.base` and scopes its cookie to `Path=/dashboard`, so the cookie never reaches another route.
  - The authorization server's issuer is `${OB1_PUBLIC_ORIGIN}/auth`, set from configuration and never derived from request headers (SMD-2382).
  - Grafana serves from `/grafana` with `${OB1_PUBLIC_ORIGIN}/grafana/` as its root URL, its Content-Security-Policy on and its cookie `Secure` under https. A page of its that ran a script would run as the origin `/auth` signs in on, so its route is opt-in (`deploy/compose.grafana-public.yaml`, SMD-1849 PR 3a). By default Grafana is reached nowhere; a loopback port of its own, a separate origin, is the other way (`deploy/compose.grafana-port.yaml`, a release asset).

## Identity

- **The switch and its two states** (decision 16, SMD-2382). One setting, `OB1_PUBLIC_ORIGIN`, fixes the issuer, the protected-resource URL, the passkey relying-party ID and every redirect URI. OAuth exists only when the `auth` compose profile is enabled, and the profile refuses to start without the origin. Two states are kept apart:
  - **Configured** is static: `COMPOSE_PROFILES=auth` in `deploy/.env`, interpolated into each service that acts on it (as built: the authorization server's environment, and the `server-env` block the MCP server and the REST core share). **Security rules key on it.** While configured, the GUI's public port never offers key sign-in and the REST core never drops its issuer check, even with the authorization server down.
  - **Reachable** is dynamic: `auth.ob1.internal` answers its health check. **Only what is advertised or offered keys on it**: the protected-resource metadata, the 401 challenge and passkey sign-in. Knocking the authorization server over closes those; it never opens a weaker door.
  - Not configured, with or without an origin, is today's posture: keys only. That covers loopback-only stacks, the quick tunnel (whose name changes every start) and a named tunnel whose operator wants no OAuth.
- **The REST core is the only resource server that authorizes.**
  - Access keys keep their read / write / capture scopes (`server-portable/auth.ts`).
  - The authorization server's tokens map to the same three scopes: `brain:read`, `brain:write`, `brain:capture`.
  - The audit actor is the subject, plus `act` when a service delegated. A key's subject is its bare name, and an OAuth subject is `oauth:<sub>+<client>`, the account and the client it signed in through, or `oauth:<sub>` alone for a service whose subject is its own client (amended 2026-10-28, SMD-3064: below). So a key can never read as a signed-in identity, because `keygen.ts` allows no `:` in a key name. For keys, existing rows, `actor:` egress terms and the search tools' `actor` filter keep matching, since each already reads a key's bare name. An OAuth name from before the amendment (`oauth:operator`) matches nothing new.
  - No privilege exists only in OAuth.
  - **As built (SMD-2286 PR 1, `server-portable/oauth-token.ts`):**
    - The REST core accepts a token only on a configured stack with a sound origin; elsewhere a token is an unknown key, as before. It checks the issuer `<origin>/auth`, the audience exactly `<origin>/api` (so an `/mcp` token is refused: it arrives only by the exchange), ES256 with `typ: at+jwt`, and expiry.
    - The signing keys come from the authorization server's JWKS on the mesh (`auth.ob1.internal`'s `/auth/jwks`) and are kept 600 s, the access tokens' lifetime (`cachedKeys`). Reads are tried at most once in 30 s, and a request that needs one joins any in flight. Once the set is stale and reads fail, the keys read last serve 600 s from then, so a token issued before an outage is served to its end. A token whose key the set lacks, with no read possible yet, is a 503, so a new signing key never sends a client to sign in. With no keys at all, a token is answered 503 with `Retry-After: 30`: the issuer check never drops, and the token is not refused as bad.
    - `brain:write` is a write key's scope, which reads and captures too; `brain:read` alone is a read key's, and `brain:capture` alone a capture key's. `brain:read` with `brain:capture` and no `brain:write` is no key's scope, and a token with it, or with no brain scope, is answered 403 `insufficient_scope`. The authorization server refuses such a set where a request names it afresh (the authorization request's interaction, the exchange, `OB1_AUTH_SERVICES`); one the library narrows from what a client holds (a refresh, client credentials, a grant built over two consents) reaches the REST core and is refused there. Its consent page words each scope as the key that holds it.
    - **A principal per client (decided 2026-10-28, SMD-3064).**
      - The caller is `oauth:<sub>+<client>`: the one account `operator` and the client it signed in through. That client is the token's own `client_id` (`gui`, the operator GUI's), or on an exchanged token the connector the authorization server nests in its `act`: `act: {sub: "mcp", act: {sub: <the subject token's client>}}` (RFC 8693 §4.1). A connector is a registered client's id or a metadata document's https URL. A service's token, whose subject is its own client id (which may not be `operator`), is `oauth:<sub>` alone.
      - No subject holds `+`, so no subject reads as another's client. A client is an id of a subject's characters, or an https URL of a host, an optional port and a path alone, at most 180 characters (`clientNameable`): a URL with a comma would split an egress term list, one with a `+` would read as a second client, and the CIMD draft says a client id should not hold a query. The authorization server holds the same rule: its client metadata validator refuses such a client wherever the library loads it, so it gets no authorization or refresh, and the exchange refuses a token issued to one before the rule; the REST core refuses a token naming one as invalid, and a caller name over 200 characters, the `actor` filter's limit.
      - Each principal's registry digest is fixed per issuer, subject and client, so the agent registry and job ownership treat it as they treat a key: each connector and the GUI has its own kind and trust ceiling (`set_agent_kind('oauth:operator+gui', 'operator')`), its own jobs and its own revocation. Its registry row records no scope (its tokens hold several). Revoking it there bans that client for good, since no sign-in changes the digest; a leaked token is answered at the authorization server, whose page of grants revokes one client's grant (SMD-3307).
      - Declined: one principal, with a kind and revocation per nested actor kept beside the registry. It would have built a second registry for what the first already does.
      - An exchanged token's outer `act.sub` is recorded as `act` (`oauth:mcp`); beside the forwarder slot, the token's own `act` stands. A refusal says `credential: "token"`, with `WWW-Authenticate: Bearer error="invalid_token"` (or `insufficient_scope`).
- **MCP server:**
  - While the authorization server is reachable, it serves protected-resource metadata and answers 401 with `WWW-Authenticate`. The challenge goes only on requests whose `Host` is the public origin, so a keyless loopback client gets today's refusal (HTTP 200 carrying JSON-RPC -32001, or a bodyless 202 for a notification) rather than an OAuth flow it can never finish. Keying this on `Host` fails safe; no security rule keys on `Host`.
  - While configured but unreachable, OAuth clients get a 503, not a 401 that would restart their sign-in.
  - **As built (SMD-2382, `server-portable/oauth-edge.ts`):**
    - The challenge goes only on a request for the resource itself: the origin's `Host` (a port the scheme implies counts as none) and exactly the path `/mcp`, any query, since RFC 9728 wants the document's `resource` identical to the URL the client used. `/mcp/`, the root URL kept for SMD-2306's window, and any `Host` but the origin's (loopback, a LAN address, another name) keep today's refusal.
    - A key in any form, wrong, empty or malformed (`Authorization: Bearer ` with nothing after it), is a key client's: it gets today's refusal in every state, so this server's 401 never sends a key client to sign in. Only a request with no key form (another scheme, such as `Basic`, is none), or with a bearer of a JWT's shape and no key beside it, is answered for OAuth. (claude.ai fetches the document by itself, without its key, so a `?key=` connector at `/mcp` of a configured stack is asked to sign in; once through, its key authenticates before the token and it is served. A connector with no key is served on its token: `/mcp` is `mcp-server/`'s since SMD-2287 PR 5b, which trades it (SMD-2286).)
    - Reachable is a GET of `auth.ob1.internal`'s `/healthz`, a 200 within 2 s, its answer kept 30 s, and only for a request the answer turns on. The MCP server is on the mesh for it, as `mcp.ob1.internal`.
    - Its keyed `/health` carries its own view beside the brain's record: configured, the origin, advertised now. `smoke.sh` compares that view with what reaches the server through the URL it was given, which is how a tunnel that does not keep the origin's `Host` is found.
    - Configured with an unsound origin, there is no resource to recognise: every request is answered as on a stack that is not configured, a token's included (today's refusal, not the 503). The authorization server refuses to start on the same origin, and preflight warns.
    - At any `Host` but the origin's a bearer token is refused as today: hosts reach the brain with keys. (An origin that is itself loopback, `http://localhost:8000`, is the public resource at that exact host and port.)
    - `/mcp` is `mcp-server/`'s since SMD-2287 PR 5b, which trades each token (below); server-portable's, which the proxy no longer routes to (SMD-2532), accepts none. The REST core accepts its own tokens since SMD-2286 PR 1.
  - It exchanges each incoming OAuth token (audience = the public `/mcp` resource) for a REST-core token under its own client credentials. It caches the result by the incoming token, never by subject alone. One operator can hold a read-scope connector and a write-scope connector.
  - **As built (SMD-2286 PR 2, `mcp-server/exchange.ts`):**
    - On a stack with a public origin, a bearer of a JWT's shape is never sent to the REST core as a key, whether or not a key form sits beside it; a dotted value in `x-brain-key`, `x-access-key` or `?key=` stays a key, since an operator's raw `MCP_ACCESS_KEY` may have dots, and on a stack with no public origin (no OAuth) a bearer of any shape is a key, as server-portable reads it. Such a key sent as a bearer on a stack with an origin reads as a token: send it in a key form. At the public resource of a configured stack, with the `mcp` client's secret (`OB1_AUTH_SECRET_MCP`), one with no key beside it is traded at the authorization server's token endpoint on the mesh, RFC 8693, for `<origin>/api`. So it is at the keyed routes the proxy hands this server at the origin's `Host` (a scan's job links, the worker mirrors), where a token refused is answered as at `/mcp`, never shown `ok`, which a poller would read for ever; a token not checked within those routes' 2.5 s deadline is 503, and the next request is answered from the trade once it is kept. `/health`'s record stays a key's, since the REST core's is. Anywhere else on such a stack it is no caller and gets the edge's answer as before (before this PR it was also sent to the REST core as a key).
    - The claims are read first, unverified and only to refuse: another issuer, any audience but exactly `<origin>/mcp`, or an expired or exp-less token is refused with no trade. The authorization server verifies the rest.
    - A trade is cached by the incoming token's sha256 until 5 s before the exchanged token expires, one trade at a time per token, at most 1,024 entries. The exchanged token rides `Authorization: Bearer` to the REST core (rest-client's `token`), beside the forwarder slot. The authorization server's exchange checks the subject token, not its grant, so a grant revoked there is refused once the client's access token expires (at most 600 s), when its refresh fails and it signs in again; a subject revoked in the registry is refused at the next call.
    - Answers at `/mcp` and the keyed routes: the trade refused (`invalid_grant`) or the claims refusing the token is 401 `invalid_token` naming the protected-resource document, so the client refreshes — 503 instead while the authorization server does not answer its health check, since that refresh cannot finish and the client would fall back to an interactive sign-in; scopes that name no key scope are 403 `insufficient_scope` naming `scope="brain:read"`, so an MCP client holding no brain scope steps up rather than refreshing into the same 403 (read with capture gains nothing from it, and is mended only if a refresh widens it to its grant); the authorization server away, limiting this server (429), stalling, or answering a 200 with no token, or the REST core without keys, is 503 with `Retry-After: 30`; a REST core refusing a token it was traded for a moment ago (it checks none, or another origin's, or cannot match the server's keys) is this stack's misconfiguration, a fault in the log with its fix, as is a trade the authorization server does not answer, said at most once a minute; the health probe behind the 503 is cached 30 s, and a check it has to make can run past a keyed route's deadline once in that time; a subject revoked in the registry gets a revoked key's refusal, not a 401 that would send its client round a sign-in it cannot escape; this server's own client refused is a fault in the log, with its fix.
  - The MCP authorization spec forbids passing the received token upstream; exchange is how the hop keeps both the subject and the delegating service.
- **Access-key MCP clients** (the hook, `?key=` connectors) are **forwarded** (decision 7; SMD-2286's step 4, built by SMD-2284 and SMD-2287). The MCP server passes the key to the REST core with its own forwarder key. The REST core checks both, and records the key's name as the subject and the MCP service as the actor.
  - The forwarder is a key with a `forward` scope that grants nothing by itself. The REST core refuses any other key in the forwarder's place, so a client holding two keys cannot stamp one as the other's actor (SMD-2284).
  - **As built (SMD-2284):** the slot is the `x-brain-forwarder` header, read only inside the stack — the mesh, and `data` and `egress`, where the REST core also listens since the network move (SMD-2583) — since the public `/api` route deletes it; inside, what guards it is the forwarder key, which SMD-2287's `mcp-server/` sends. The audit row records the subject as ever (`actor_name`, `canonical_agent_id`) and the carrier in `thought_audit.actor_context.act` as `{name, agent_id}`. `act.name` follows `actor_name`'s convention above: a key's bare name, and for a token-exchanged request (SMD-2286) `oauth:<client_id>` from the exchanged token's `act.sub` — one shape on the audit row, which is append-only, whichever way the request was carried. A token's `act` carries the name alone, with no `agent_id`: the MCP service it names is a client of the authorization server, not a key the registry holds (SMD-2286 PR 1).
  - This is not the token passthrough the spec forbids. That rule covers OAuth tokens issued for the MCP server, and a brain key is the REST core's own credential, checked there.
  - Forwarding works in every state and needs no authorization server. Keys therefore survive its outage, the capture hook included.
- **GUI** (built with the GUI itself, SMD-2280; moved there from SMD-2286 on 2026-10-16, together with the revocation page):
  - A confidential client using authorization code with PKCE, asking for the REST core as the resource (RFC 8707).
  - Tokens live in the sealed server-side session and never reach the browser, the same pattern the SvelteKit dashboard used for the key (retired, SMD-3310).
  - Sign-in is a passkey with a password fallback while configured (decision 15), and a key when not.
  - Break-glass key sign-in stays available on a separate port published only on `127.0.0.1`. Neither the source IP nor `Host` can tell local from public, because every documented tunnel dials `127.0.0.1`.
  - **As built (SMD-2280 PR 1, `dashboard/`):** key sign-in alone, checked by the REST core's `GET /v1/whoami`, and off while configured. The session is server-side: the cookie holds a random id, and the key stays in the GUI's memory, so no key or anything sealed from it reaches the browser (the SvelteKit dashboard sealed the key into its cookie). Code and PKCE, break-glass and the revocation page moved to SMD-3307; its PR 1 signs in by code and PKCE as the confidential `gui` client, the access and refresh tokens held in that same server-side session. Its PR 2 is break-glass: the `breakglass` service, under the auth profile, publishes `127.0.0.1:${BREAKGLASS_PORT:-8001}` (a literal loopback, no `_BIND` knob) to the proxy's `breakglass` entrypoint, whose one router takes `/dashboard` to the GUI with `X-OB1-Listener: breakglass` set, and the `web` entrypoint deletes that header from every request; the GUI offers key sign-in there alone while configured, whatever the authorization server's state, its session bound to that listener and its form taken from that port's own loopback origin. Its PR 3 is the page of grants (`/dashboard/grants`): the authorization server serves an admin listener on port 3001 on the mesh, which no proxy rule routes to, taking the `gui` client's credentials alone; the page lists the live grants and revokes one whole, its refresh tokens refused at once and its access token lapsing within the 600 s lifetime (the maintainer's choice of 2026-10-26: no revocation list, no shorter tokens).
- **Clients inside compose** (n8n, the `db/` worker containers) call the REST core directly on the mesh with an access key; as built, neither joins the mesh, so n8n reaches it as `api:8000` on `egress` and a worker container as `api:8000` on `data` or `egress` (SMD-2583).
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
  - **As built (SMD-2294):** the canary stays a compose project of its own (`deploy/canary.sh`), with its own Postgres. `deploy/compose.canary.yaml` puts its MCP server and REST core on stable's mesh as `mcp.canary.ob1.internal` and `api.canary.ob1.internal`, under those names alone, and stable's proxy routes `/canary/mcp` to the first. On stable's mesh it would also resolve stable's `auth.ob1.internal`, which settles how a tier reaches the one authorization server across projects; until a tier has OAuth of its own (SMD-2286) the canary runs with no compose profiles, advertises none and dials no `*.ob1.internal` name of stable's but one: with `OTEL_EXPORTER_OTLP_ENDPOINT` in its env file it sends its telemetry to stable's collector, `lgtm.ob1.internal` (SMD-1849 PR 3a), which carries no key and no text and names the canary by its tier. `deploy/compose.tiers.yaml`, the three tiers as one stack, gives each tier its MCP server and REST core and puts one proxy in front, with `/mcp`, `/canary/mcp`, `/working/mcp` and stable's `/health` the only public paths; no tier publishes a port of its own. The GUI per tier waits on SMD-2280.
  - **Superseded (SMD-2874, under `docs/one-brain-per-stack.md`):** `compose.canary.yaml` is gone, and the canary no longer joins stable's mesh. It answers at `/mcp` behind its own proxy, on its own loopback port. Stable's route table no longer routes `/canary/mcp` or `/working/mcp` either (SMD-2874 PR 3): every path under either prefix is its own 404 since SMD-2532 removed `tier-off` with the legacy route. `compose.tiers.yaml`, the three tiers as one stack, is retired too (SMD-2878).

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
- **Plugins are curated.** They run in the brain's own processes (the REST core's and the MCP server's) with the brain's privileges, so every plugin is maintainer-reviewed. `integrations/` stops being an open category for anything that touches the brain. Contributions that never touch the brain are out of this repo's surface.
- **The six curated extensions port to plugins** (SMD-2311). Each tool becomes an operation. Each `schema.sql` becomes plugin migrations that adopt existing tables. professional-crm's direct `thoughts` read (`extensions/professional-crm/index.ts:480-485`) becomes a core-operation call. Upstream's multi-user `user_id` columns get a decision for each plugin (SMD-1716 stays deferred).
- **Community UI** is a plugin's GUI pages in the canonical GUI (decision 11). The Next dashboards' snippets (`schemas/*/dashboard-snippets`, `recipes/wiki-synthesis/dashboard-snippets`) are ported that way or retired (SMD-2280). All three were retired with the Next dashboard (SMD-3309).
- **Identity** is the REST core's (decision 12). No plugin mints or checks its own keys.

**As built (SMD-2310, 2026-10-08).** The mechanism settles what the decisions left open:

- **Where.** A plugin is `plugins/<name>/`, a curated category. `plugins/registry.ts` imports each one by name, so the set a server can run is fixed when its image is built, and `OB1_PLUGINS` picks from it. The manifest is built with `server-portable/plugin-sdk.ts`.
- **Projection.** An operation is a REST route `/v1/plugins/<name>/<path>` and an MCP tool `<name>_<operation>`. Both servers serve it, the MCP server in-process as it does the core's operations. It sits behind the gate a core operation of its scope sits behind (`tools.ts`'s `unlocks`).
- **Tables.** Each plugin has a schema, `plugin_<name>`, owned by a NOLOGIN role, `ob1_plugin_<name>`. Every plugin's SQL runs on a connection logged in as `ob1_plugins` (LOGIN, NOINHERIT, no superuser, its password `OB1_PLUGIN_DB_PASSWORD`), which holds `SET` on each plugin's role and nothing on the core.
  - **Migrations** run on that connection as the plugin's role in its schema, recorded in `plugin_migrations` beside `schema_migrations`.
  - **At runtime** the handle `ctx.db` runs the same way, on a connection pool of the plugin's own.
  - **Grants** are the role's ownership of its schema; the planned list of grants per plugin is not needed. Beyond it, both roles hold only PUBLIC's defaults: `USAGE` on `public` (every core function runs as its caller) and `TEMP`, which the plugin's own pool keeps from every other connection.
  - **The boundary is Postgres's.** Neither role reaches a core table, so SQL that undoes the plugin's role still cannot — though it could reach another plugin's tables, since `ob1_plugins` may `SET ROLE` to every plugin's role. The plugin's TypeScript runs in the server's process and could reach anything the server can, so curation is what holds hostile code. Check 31 of the consistency checker is the accident guard in front of both: a role, session or transaction change, a core table or another schema named, an import past the SDK, or a global past `ctx` fails a push so that review sees it.
- **GUI pages.** The manifest declares each page (a path and a label), and the REST core lists the enabled plugins and their pages at `GET /v1/plugins`. That is the registry the GUI's nav reads; the pages themselves are SMD-2280's to render.
- **Webhooks.** A manifest declares `hooks`. The REST core serves each at `/hooks/<plugin>/<name>`, but only for a plugin `OB1_HOOKS` names, and the proxy reaches them only with `deploy/compose.hooks-public.yaml`: off by default, on per plugin, like `/api`. A hook takes no key; it verifies its sender against the secret `OB1_HOOK_SECRETS` gives its plugin, and runs as `hook:<plugin>`, of capture scope alone.
- **Egress.** A plugin is given no outbound call (check 31 refuses `fetch` and its kin). A model call through the shared gate, offered as a core service, comes with the first plugin that needs one: smart-ingest's port, SMD-2690.

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
| n8n | Brain calls move from MCP to the REST core. SMD-2212 (merged, #222) needs no re-aim for its import: n8n calls the `orchestration-runner`, not the brain. Its act tool is n8n's own endpoint. **As built (SMD-2295):** no shipped template calls the brain; the brain credential is pinned to `api`, the REST core's name on `egress`, and provisioning refuses one pinned elsewhere; the orchestration eval's workflows call the REST core | SMD-2295 |
| `orchestration-runner` (#222) | A worker-class DB writer on the mesh and the egress network (as built, `data` and `egress`, where n8n reaches it; SMD-2583). Its per-uid egress rules (SMD-2289) are the container's own network namespace's, so they hold whichever networks it joins | SMD-2289 |
| `integrations/kubernetes-deployment` | **Retired** under compose-only (SMD-2288 PR 1) | SMD-1931, SMD-2288 |
| Jev, the LLM env forwarding, the preflight entrypoint | Move from the `server` service to the REST core | SMD-2284 |
| Release images and CI | `ob1-server` stays one image for the three servers: it carries the MCP server built on the REST core since SMD-2287 PR 5a, by the maintainer's choice (2026-10-20) over an image per server; the full-stack job goes through the proxy; the Workers build retires | SMD-2296, SMD-2287, SMD-2288 |
| Docs and skills with the one-process `?key=` URL shape | One bring-up path and the new URLs: **met** (SMD-2532 closed the root URL; SMD-2288 PR 2 the bring-up docs) | SMD-2288 |
| `chrome-capture-extension`, `recipes/*` MCP callers, agent-memory plugins | New URLs; the extension is a client of `/api` (`POST /v1/thoughts`) since `open-brain-rest` retired | SMD-1931 |
| Secrets in `deploy/.env` | The authorization server's signing key, its cookie keys, each static client's secret, and the operator's password (which the operator may remove once hashed) and its argon2id hash, written by `deploy/auth/provision.ts --init`, with the backup note (`deploy/README.md`, "Authorization server"). The container is given the hash, never the password | SMD-2285 |
| The authorization server's store, backup and restore | One SQLite file in the `auth` service's own volume, through an oidc-provider adapter of ours (`deploy/auth/store.ts`), backed up with `VACUUM INTO` beside the running server. Decided 2026-10-01 in place of an `ob1_auth` role and database on the brain's Postgres: the internet-facing server then holds no Postgres credential (as built, Postgres is on `data`, which the authorization server never joins, so the two share no network either; SMD-2583), and `pg_dump openbrain` and `db/tier.ts --refresh` are unchanged | SMD-2285 |
| `docs/01-getting-started.md` (quick tunnel first) | OAuth and passkeys need a stable origin: a named tunnel, Tailscale Funnel or your own domain. The quick tunnel stays key-only | SMD-2382 |

## Retirement conditions

Which vendored integrations become plugins and which retire was decided on 2026-10-08 (SMD-1931), with each REST gateway route's fate: [`docs/vendored-disposition.md`](vendored-disposition.md), "The brain's outward surface". Plugins: agent-memory-api, smart-ingest and readwise-capture (SMD-2690), slack- and telegram-capture (SMD-2101). Retired: the two REST gateways, enhanced-mcp, the delete- and update-thought servers and discord-capture, all gone from the tree with SMD-1931; and kubernetes-deployment, whose removal is SMD-2288. The Chrome capture extension becomes a client of `/api`.

| Surface | Retires when |
|---|---|
| `dashboards/open-brain-dashboard-next`, `-pro` | SMD-2280's harvest list is recorded. They are deployed nowhere. **Met and retired** (SMD-3309). |
| `integrations/open-brain-rest`, `integrations/rest-api` | Every route has a disposition against the REST core (SMD-1931). **Met and retired** (SMD-1931 PR 3). |
| server-portable's MCP registration | The MCP server passes parity and the stable tier's `/mcp` routes to it (SMD-2287) |
| The Cloudflare Workers target and the PostgREST store it selects | **Retired** ahead of SMD-2287's cutover, since no brain ran them (SMD-3152, SMD-2288's step 1) |
| `dashboards/open-brain-dashboard` (the old SvelteKit one) | The REST core and MCP server are stable (decision 2). **Retired** with the `dashboards/` category (SMD-3310); the clause was dropped 2026-10-27, since no compose service ever ran it. |

## What this reverses or amends

- **Change 042 ("OAuth discovery is a 404", SMD-1246):** three `/.well-known/` paths are now routed, and only while the `auth` profile is configured. Everything else stays a 404.
- **SMD-1846's "OAuth not in scope":** OAuth is in scope. Auth stays in the services, not the proxy.
- **`docs/orchestration-tool.md`:** n8n "reaches the brain only through its MCP surface". Under decision 1 it reaches the REST core instead. The key discipline (a capture-scope key in a domain-pinned credential) carries over unchanged. **As built (SMD-2295):** the ADR is amended, the brain credential is pinned to `api`, and provisioning refuses one pinned elsewhere.
- **CLAUDE.md's MCP guard rail:** one HTTP server reached by URL, never stdio, still holds for the MCP server. The reference deployment becomes the compose stack, not the Bun container: rewritten by SMD-2288 PR 2, with check 22c holding it.
- **SMD-2133's "Target end-state":** REST is canonical, and the deployed surface is three servers, not two interfaces on one process.
- **`docs/mcp-sdk-v2-migration.md` (SMD-2275):** it calls server-portable "the canonical one-HTTP-process server". Its staging still holds, but the long-term MCP surface is SMD-2287's server, a client of the REST core.
- **`integrations/kubernetes-deployment`:** under compose-only it has no deployment target. It retired, with SMD-1931 recording the disposition and SMD-2288 the removal (PR 1). SMD-2259, the Kubernetes step of SMD-2080 and the Kubernetes outlier in SMD-2281, held for that, fall away with it.

- **CONTRIBUTING.md's "Remote MCP pattern" (`:132`, `:382`), the PR template's server checkbox and the `dashboards/` and `integrations/` category rows** (CLAUDE.md, CONTRIBUTING.md) describe standalone `bun <file>` servers with their own keys. Decisions 9–12 replace them with the curated plugin pattern (SMD-2310 rewrites them; the `dashboards/` rows went with that category, SMD-3310). SMD-1846's `/ext/<name>` row becomes `/hooks/<name>`.

## Not decided here

- **The authorization server's remaining details**, each in its own ticket:
  - token lifetimes and refresh-token rotation: **decided** (SMD-2286, maintainer, 2026-10-16). Access tokens last 600 s. A refresh token rotates on every use and lasts 14 days unused, within its grant's 30 (`deploy/auth/layout.ts` `refreshTtl`). A spent one presented again within 10 s rotates again, each time, since the MCP SDK refreshes without a lock and a strict replay rule signed users out; inside that window a replay forks the chain undetected, the price of the grace. Later, it revokes the grant (`REFRESH_REUSE_GRACE_S`, `deploy/auth/store.ts`). A chain 30 days old rotates no more (`chainRotates`);
  - the client-metadata fetch policy (resolve-and-refuse, or an allowlist) (SMD-2285). Whether `openbrain` revokes PUBLIC's CONNECT went with the `ob1_auth` role: the authorization server reaches no database (2026-10-01).

  The survey behind decision 13 (eight candidates at the versions checked on 2026-09-28) is on SMD-2285.
- **The importance scale, the restricted-content lock and kanban's status column.** Each is non-core schema today (`schemas/enhanced-thoughts`, `schemas/workflow-status`); adopting one is a migration decision of its own.
- **Operations that exist only on the command line or not at all**, needed by the GUI's later views, filed when the GUI reaches them:
  - supersession accept/reject (`db/consolidate.ts --accept/--reject`), where the list tool now also has a `stale` status (migration 063) and a `lineage` selector (070) — on the core since SMD-3338 as `review_supersession_proposal`, the GUI's verb SMD-3322's;
  - `rebuild_derived`, its orphan sweep and its census (migration 063, `db/rebuild.ts`);
  - lineage and provenance reads;
  - an entity-graph read.

## Related

- `docs/operator-gui-dashboards-analysis.md`: the three dashboards, the feature matrix and the operator gaps.
- `changes/152-the-dashboards-off-supabase.md`: the sealed-session sign-in the GUI starts from.
- SMD-2133 (epic), SMD-1931, SMD-1846, SMD-1849, SMD-2275/2278/2279, SMD-2131/2132, SMD-2134, SMD-1716, SMD-1246, SMD-2285/2286, SMD-2382.
