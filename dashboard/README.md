# dashboard — the operator GUI, a client of the REST core

SMD-2282's decision 2 (`docs/operator-surface-tiers.md`) gives the brain one operator
GUI: a SvelteKit server of its own that reads and writes the brain only through the
REST core (`server-portable/api.ts`), the brain's contract. This directory is that GUI
(SMD-2280). Every page is a call on the REST core through
[`../rest-client`](../rest-client/README.md), the client the MCP server uses, under the
signed-in visitor's own key. It holds no store, no key list and no key of its own.

It replaces the three dashboards under `dashboards/`, which retire as this one takes
over what each did (SMD-2280's plan: read views first, then plugin pages, then
sign-in through the authorization server, then the old dashboards' retirement).

| File | What it is |
|---|---|
| `serve.ts` | The entry, `bun serve.ts`: the SvelteKit server `bun run build` writes to `build/`, on PORT (8000), with the origin set (below) |
| `src/hooks.server.ts` | Every request: the session, the sign-in wall, and the headers that keep a page out of caches and frames |
| `src/lib/server/session.ts` | The sessions, held in the server's memory |
| `src/lib/server/rest.ts` | The REST core's client, and a read under the visitor's key |
| `src/lib/server/signin.ts` | Whether key sign-in is offered, and whoami's answer |
| `src/routes/` | The pages: the overview, the status, a thought, sign-in and sign-out, `/health` |
| `smoke.ts` | The smoke: drives the GUI as a browser would, through the stack's proxy |

## In the stack

Compose's `app` service runs it in the server image, `bun ../dashboard/serve.ts`, on
the mesh as `app.ob1.internal`. The proxy routes `/dashboard` and everything under it
there with the path kept, so the GUI serves under that base (`paths.base`), and its
cookie is scoped to it. The image builds it (`server-portable/Dockerfile`'s
`dashboard-build` stage); the build bundles every package, so the image installs
nothing for it. A release's compose overlay runs the release's server image here too.

Open `http://127.0.0.1:8000/dashboard` (the stack's published port), or
`https://<host>/dashboard` through the TLS proxy or tunnel in front of it, and sign in
with an access key.

## Signing in

- **A key.** The visitor pastes an access key. The REST core's `GET /v1/whoami` says
  whose it is and which operations it may call. A read or write key opens a session.
  A capture-only key is refused (403): it may add a thought and read nothing, so no
  page could load. A key the core refuses is refused (401), with nothing held.
- **The session is the server's.** The cookie (`ob1_dashboard_session`, `Path=/dashboard`,
  httpOnly, SameSite=Lax, a day, Secure on https) carries a random id and nothing
  else. The key and its scope stay in the server's memory, so neither the key nor
  anything sealed from it reaches the browser, and sign-out ends the session on the
  server. A restart signs everyone out.
- **A revoked key** ends its sessions at their next page: the REST core answers 401,
  and the GUI drops the session and sends the visitor to sign in.
- **While the stack is configured with the authorization server** (`COMPOSE_PROFILES`
  names `auth`, ADR decision 16), key sign-in is off on the public origin, whether or
  not the authorization server answers: knocking it over must not open a weaker door.
  Sign-in by code and PKCE, and break-glass key sign-in on a loopback-only port, are
  SMD-2280's fourth PR; until then a configured stack's GUI signs no one in.

## The origin

SvelteKit refuses a form posted from another origin, and the cookie is Secure only on
https. So the server must know the origin a browser sees:

- **`OB1_PUBLIC_ORIGIN`**, when it is a sound public origin (the authorization
  server's rules: https, or http on a loopback host, and an origin alone). Set it when
  a TLS proxy or tunnel serves the stack: the stack's own proxy sees plain HTTP. An
  unsound one is warned of and passed over.
- Otherwise each request's `Host`, with the scheme the stack's proxy saw (its
  `X-Forwarded-Proto`, which Traefik sets itself): plain HTTP on the loopback or a
  LAN address signs in as it is reached.

## Settings

| Variable | What it does |
|---|---|
| `OB1_REST_URL` | The REST core; `http://api.ob1.internal.:8000` on the mesh unless set |
| `OB1_PUBLIC_ORIGIN` | The origin behind TLS (above) |
| `COMPOSE_PROFILES` | Key sign-in is off while it names `auth` |
| `GRAFANA_LINK` | The nav's link to Grafana, set by `deploy/compose.grafana-public.yaml` (`/grafana/`) or `deploy/compose.grafana-port.yaml` (`/grafana/` on its loopback origin); none without either |
| `PORT` | 8000 unless set |

## The pages

| Path | What it reads |
|---|---|
| `/dashboard` | `thought_stats` (the counts, the date range, the largest types, topics and people) and `list_thoughts` (the ten newest) |
| `/dashboard/status` | `brain_info`: the server's version, commit and migrations, and the database's ledger, sizes, counts, workers' heartbeats and proposal queue |
| `/dashboard/thoughts/<id>` | `fetch`: a thought's text and metadata (the core logs the open as a click-through, as it does any `fetch`) |
| `/dashboard/signin`, `/dashboard/signout` | Sign-in and sign-out |
| `/dashboard/health` | Liveness: `ok`, asking the REST core nothing |

Browse, search, the change feed, the worker queue, the proposals and the query log are
SMD-2280's second PR; plugin pages its third.

Every page is rendered on the server: the browser calls no API, so there is no proxy
in the GUI to the REST core, and a page reads only the operations its own load names.
Pages are `no-store`, refuse framing, and carry a Content-Security-Policy that admits
no script but SvelteKit's own.

## Develop

```bash
cd dashboard && bun install
bun run check                        # svelte-check
bun run build && OB1_REST_URL=http://127.0.0.1:<port> OB1_PUBLIC_ORIGIN=http://127.0.0.1:8000 bun serve.ts
```

`OB1_REST_URL` there is a REST core you can reach: the stack's `/api` with
`deploy/compose.api-public.yaml` (`http://127.0.0.1:8000/api`), or one run from a
checkout.

## Smoke

```bash
bun smoke.ts --url http://127.0.0.1:8000/dashboard --key <write> --read-key <read> --capture-key <capture>
```

It drives the GUI through the stack's proxy as a browser would: the sign-in wall, a
wrong and a capture-only key refused, a cookie the server never issued refused, a
sign-in posted from another origin refused, the cookie's attributes, each page
rendered from the REST core, no page, header, script or cookie holding the key, and
sign-out ending the session on the server. CI runs it in the full-stack job.
