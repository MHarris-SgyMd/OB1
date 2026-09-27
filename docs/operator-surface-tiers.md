# Three servers and an authorization server behind the proxy (SMD-2282)

An architecture decision record. **Decided 2026-09-27 by the maintainer.**

The brain's deployed surface becomes three servers and an authorization server, all behind one reverse proxy:

- **A REST core** owns Postgres, egress and the contract, and answers JSON.
- **An operator GUI** in SvelteKit is a client of the REST core.
- **An MCP server** on SDK v2 is a client of the REST core too.
- **An authorization server** is its own service. Identity crosses from the MCP server to the REST core by token exchange.

Internal names are subdomains; public routes are paths. The stack deploys by compose only.

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
| 7 | **Token exchange (RFC 8693)** carries identity across the MCP→REST hop. | a service credential plus an asserted user |
| 8 | **Compose-only deployment.** | keeping a single-process mode |

## The shape

```
                 ┌───────────── edge network ─────────────┐
 client ──https──▶  proxy                                  │
                 │   /mcp        → mcp.ob1.internal        │
                 │   /dashboard  → app.ob1.internal        │
                 │   /auth       → auth.ob1.internal       │
                 │   /grafana    → lgtm (SMD-1849 profile) │
                 │   /api        → api.ob1.internal  (opt-in, off by default)
                 └───────────────┬────────────────────────┘
                                 │  internal network (internal: true)
   mcp ──token exchange──▶ auth  │
   mcp ─────REST client──▶ api ◀──── REST client ── app
   n8n ─────REST──────────▶ api ──▶ postgres, egress (Ollama / Jev / OpenRouter)
   db/ workers (core codebase, separate processes) ──▶ postgres
```

- **Public routes:**

  | Path | Service |
  |---|---|
  | `/mcp` | MCP server (SMD-2287) |
  | `/dashboard` | operator GUI (SMD-2280) |
  | `/auth` | authorization server (SMD-2285) |
  | `/grafana` | SMD-1849 |
  | `/api` | REST core (SMD-2284), off by default |
  | `/canary/...` | the canary tier's equivalents |

- **Internal names** are network aliases on a compose network with `internal: true`: `api.ob1.internal`, `mcp.ob1.internal`, `app.ob1.internal`, `auth.ob1.internal`. Only the proxy also joins the edge network. Calls between services still authenticate; being on the network is not trust.
- **`/.well-known/` stays a 404 except two routed paths:**
  - `/.well-known/oauth-protected-resource/mcp` goes to the MCP server (RFC 9728).
  - `/.well-known/oauth-authorization-server/auth` goes to the authorization server (RFC 8414).
  Both use the path-inserted form those RFCs define for a resource or issuer that lives under a path.
- **Path-based public routes carry obligations:**
  - The GUI sets SvelteKit's `paths.base` and scopes its cookie to `Path=/dashboard`, so the cookie never reaches another route.
  - The authorization server must run with its issuer under `/auth`. That is a selection criterion in SMD-2285.

## Identity

- **The REST core is the only resource server that authorizes.**
  - Access keys keep their read / write / capture scopes (`server-portable/auth.ts`).
  - The authorization server's tokens map to the same three scopes: `brain:read`, `brain:write`, `brain:capture`.
  - The audit actor is the subject, plus `act` when a service delegated.
  - No privilege exists only in OAuth.
- **MCP server:**
  - It serves protected-resource metadata and answers 401 with `WWW-Authenticate`.
  - It exchanges each incoming token (audience = the public `/mcp` resource) for a REST-core token under its own client credentials.
  - The MCP authorization spec forbids passing the received token upstream; exchange is how the hop keeps both the subject and the delegating service.
- **GUI:** a confidential client using authorization code with PKCE, asking for the REST core as the resource (RFC 8707). Tokens live in the sealed server-side session and never reach the browser, the same pattern the SvelteKit dashboard uses for the key today.
- **Access-key clients** (n8n, the session hook, the CLI, `?key=` connectors) call the REST core directly on the internal network. Whether a key-authenticated MCP client exchanges its key at the authorization server, or has it forwarded, depends on whether the chosen server supports custom subject-token types (SMD-2285 criterion 8, SMD-2286 step 4).
- **Multi-user isolation stays deferred** (SMD-1716). The authorization server introduces identities, not tenants.

## Where everything else lives

- **Workers and `db/` scripts** stay in the core codebase as separate processes on Postgres (SMD-2134). They are controlled through the REST core's worker routes (SMD-2131/2132), not a container shell.
- **Egress** (Ollama, Jev, OpenRouter) and its gate belong to the REST core alone.
- **Destructive-verb guards** live in the REST core, so every client gets them. These are the bulk cap, re-verify before delete, and restricted state from the principal, which `-pro` put in its route handlers.
- **Prose, `structuredContent`, refusal envelopes, SSE keepalive, notification handling and the scope-filtered `tools/list`** belong to the MCP server alone.
- **Telemetry:** each server emits OTLP spans with the SMD-1849 allow-list. The MCP span is the parent of the REST span through `traceparent`. Grafana owns storage and presentation.
- **Brain tiers** (stable / canary / working): one REST core per tier, with the MCP server and the GUI per tier behind `/canary/...`. The exact split is settled with SMD-1846.

## Migration order

| Step | Ticket | Done when |
|---|---|---|
| 1 | SMD-2283: extract a transport-free core from `server-portable/index.ts` (`buildServer`, `:809`–`:2526`) | The suites pass unchanged; `index.ts` calls only the core |
| 2 | SMD-2284: the REST core server, over the core, JSON and OpenAPI from one zod source (SMD-1931) | A contract test agrees with MCP for every operation |
| 3 | SMD-1846 (revised): the proxy and internal network, alongside SMD-1849 | One published port; streaming passes through unbuffered |
| 4 | SMD-2280: the GUI's read views against the REST core | The smoke renders every read view with three key scopes |
| 5 | SMD-2287: the MCP server on v2 as a REST client; parity, then canary, then cutover | The suites pass against it; `index.ts` registers no tools |
| 6 | SMD-2285, then SMD-2286: authorization server and identity chain. Selection starts now, in parallel | A claude.ai connector signs in and its audit row names the subject and `act` |
| 7 | SMD-2288: compose-only; retire the Workers target; rewrite the guard rail and SETUP.md | No doc names a non-compose deployment |

SMD-2278 (server-portable to SDK v2) goes ahead as written, since the current server stays in service through step 5. SMD-2279 (vendored servers to v2) mostly becomes retirement under SMD-1931.

## Retirement conditions

| Surface | Retires when |
|---|---|
| `dashboards/open-brain-dashboard-next`, `-pro` | SMD-2280's harvest list is recorded. They are deployed nowhere. |
| `integrations/open-brain-rest`, `integrations/rest-api` | Every route has a disposition against the REST core (SMD-1931) |
| server-portable's MCP registration | The MCP server passes parity and the stable tier's `/mcp` routes to it (SMD-2287) |
| The Cloudflare Workers target and the PostgREST store it selects | After SMD-2287's cutover (SMD-2288) |
| `dashboards/open-brain-dashboard` (current SvelteKit) | The REST core and MCP server are stable (decision 2) |

## What this reverses or amends

- **Change 042 ("OAuth discovery is a 404", SMD-1246):** two `/.well-known/` paths are now routed. Everything else stays a 404.
- **SMD-1846's "OAuth not in scope":** OAuth is in scope. Auth stays in the services, not the proxy.
- **`docs/orchestration-tool.md`:** n8n "reaches the brain only through its MCP surface". Under decision 1 it reaches the REST core instead. The key discipline (a capture-scope key in a domain-pinned credential) carries over unchanged.
- **CLAUDE.md's MCP guard rail:** "one HTTP process reached by URL", never stdio, still holds for the MCP server. The reference deployment becomes the compose stack, not the Bun container (SMD-2288, maintainer review of the wording).
- **SMD-2133's "Target end-state":** REST is canonical, and the deployed surface is three servers, not two interfaces on one process.

## Not decided here

- **Which authorization server.** SMD-2285 selects it against eight criteria: token exchange, resource indicators, MCP client registration, PKCE, an issuer under a path, one compose service, licence, custom subject-token types.
- **Whether agent-memory-api, smart-ingest and the `/ext/<name>` extension servers** fold into the core or retire. SMD-1931 gives the dispositions, and the GUI's agent-memory and kanban views follow from them.
- **The importance scale, the restricted-content lock and kanban's status column.** Each is non-core schema today (`schemas/enhanced-thoughts`, `schemas/workflow-status`); adopting one is a migration decision of its own.
- **Supersession accept/reject, lineage and provenance reads, and an entity-graph read.** These are core tools that do not exist yet, needed by the GUI's later views. File them when the GUI reaches them.

## Related

- `docs/operator-gui-dashboards-analysis.md`: the three dashboards, the feature matrix and the operator gaps.
- `changes/152-the-dashboards-off-supabase.md`: the sealed-session sign-in the GUI starts from.
- SMD-2133 (epic), SMD-1931, SMD-1846, SMD-1849, SMD-2275/2278/2279, SMD-2131/2132, SMD-2134, SMD-1716, SMD-1246.
