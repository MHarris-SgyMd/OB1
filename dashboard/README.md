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
| `src/routes/` | The pages: the overview, browse, search, the status, a thought, sign-in and sign-out, `/health` |
| `src/lib/browse.ts`, `src/lib/search.ts` | Browse's and search's addresses: what a page's query means, and the links between pages |
| `smoke.ts` | The smoke: drives the GUI as a browser would, through the stack's proxy |

## In the stack

Compose's `app` service runs it in the server image, `bun ../dashboard/serve.ts`, on
the mesh as `app.ob1.internal`. The proxy routes `/dashboard` and everything under it
there with the path kept, so the GUI serves under that base (`paths.base`), and its
cookie is scoped to it. The image builds it (`server-portable/Dockerfile`'s
`dashboard-build` stage); the build bundles every package, so the image installs
nothing for it. A release's compose overlay runs the release's server image here too.

Open `http://127.0.0.1:8000/dashboard` (the stack's published port), or
`https://<host>/dashboard` through the TLS proxy or tunnel in front of it once
`OB1_PUBLIC_ORIGIN` names that origin, and sign in with an access key. One or the
other: with `OB1_PUBLIC_ORIGIN` set, a sign-in at the loopback address is refused as
cross-site ("The origin", below).

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
- **One key holds at most 20 sessions**, and a sign-in past that ends that key's oldest;
  the server holds 1,000 in all. A sign-in over a live session ends the old one.
- **The origin is shared.** The cookie rides `/dashboard` alone, but any page served
  elsewhere on the same origin (Grafana at `/grafana/` with
  `compose.grafana-public.yaml`, say) can send requests to `/dashboard` that carry it,
  and SvelteKit's origin check passes them. A script running in such a page reaches
  what the signed-in visitor's key reaches (ADR, "Path-based public routes carry
  obligations").

## The origin

SvelteKit refuses a form posted from another origin, and the cookie is Secure only on
https. So the server must know the origin a browser sees:

- **`OB1_PUBLIC_ORIGIN`**, when it is a sound public origin (the authorization
  server's rules: https, or http on a loopback host, and an origin alone). Set it when
  a TLS proxy or tunnel serves the stack: the stack's own proxy sees plain HTTP. It is
  then the only origin the GUI takes a form from, as it is the one the authorization
  server and every redirect name: sign in there, not at `127.0.0.1`. (A loopback sign-in
  beside a public origin is the break-glass listener of SMD-2280's fourth PR.) An
  unsound one is warned of and passed over.
- Otherwise each request's `Host`, with the scheme the stack's proxy saw (its
  `X-Forwarded-Proto`, which Traefik sets itself): plain HTTP on the loopback or a
  LAN address signs in as it is reached through the stack's port. Reached without
  the proxy (a `bun serve.ts` of your own), no such header arrives and the scheme
  is taken as https, so set `OB1_PUBLIC_ORIGIN` there (Develop, below).

## Settings

| Variable | What it does |
|---|---|
| `OB1_REST_URL` | The REST core; `http://api.ob1.internal.:8000` on the mesh unless set |
| `OB1_PUBLIC_ORIGIN` | The origin behind TLS (above) |
| `COMPOSE_PROFILES` | Key sign-in is off while it names `auth` |
| `GRAFANA_LINK` | The nav's link to Grafana: `deploy/compose.grafana-port.yaml` sets it to `/grafana/` on its loopback origin, Grafana's root URL whenever that file is named |
| `GRAFANA_ROUTE` | The link when `GRAFANA_LINK` is unset: `deploy/compose.grafana-public.yaml` sets it to `/grafana/` on this origin. With neither, no link |
| `PORT` | 8000 unless set |
| `OB1_STOP_GRACE` | The stop's grace, as the servers read it: the GUI drains within it, less 2 s |

## The pages

| Path | What it reads |
|---|---|
| `/dashboard/` | `thought_stats` (the counts, the date range, the largest types, topics and people) and `list_thoughts` (the ten newest; their links are not preloaded on hover, since each open is a click-through) |
| `/dashboard/thoughts` | `list_thoughts` a page at a time (SMD-2995's keyset): newest or oldest first, 1–100 a page (the menu offers 10, 25, 50 and 100), filtered by type, topic, person, the writing key's name or kind, a trust floor and the last N days. A filter applies when its field is left or Enter is pressed. The address holds the page's place: Next carries the core's cursor; Previous and First page go back by the cursors of the pages before (the last 20 kept in the address); the browser's Back works too. A cursor the core refuses is a 400 saying so, with the first page offered |
| `/dashboard/search` | By meaning (`search_thoughts`, a fixed top 1–100, identifiers and quoted spans matched exactly; each hit's similarity, or "exact match", and the tickets it names that moved since it was written, in the tool's words) or by exact text (`search_thoughts_keyword`, a page at a time by offset, with how many thoughts hold it). With the embedding provider down, a search by meaning says its hits are exact matches alone. With no query it reads nothing; a search, as through any client, is the visitor's own, logged where `OB1_QUERY_LOG` is on, its query sent in a POST body |
| `/dashboard/status` | `brain_info`, laid out as the core's own rows (`brainInfoRows` in `server-portable/brain-info.ts`, the brain_info tool's words): the server's version, commit and migrations, and the database's ledger, sizes, counts, vectors, proposals, findings and workers' heartbeats |
| `/dashboard/thoughts/<id>` | `fetch`: a thought's text and metadata, with the ingested notice before an ingested thought's text, rendered on the server with no script (the core logs the open as a click-through, as it does any `fetch`: SMD-3212) |
| `/dashboard/signin`, `/dashboard/signout` | Sign-in and sign-out |
| `/dashboard/health` | Liveness: `ok`, asking the REST core nothing |

The change feed, the worker queue, the proposals and the query log are SMD-2280's PR 2b;
plugin pages its third. No list's links are preloaded on hover: a thought's page is a
logged `fetch`, and a search page a logged search.

Every page is rendered on the server: the browser calls no API, so there is no proxy
in the GUI to the REST core, and a page reads only the operations its own load names.
Pages are `no-store`, refuse framing, send `Referrer-Policy: same-origin` (not
`no-referrer`, under which a browser posts a form with `Origin: null` and SvelteKit
refuses it), and carry a Content-Security-Policy that admits no script but
SvelteKit's own, by a nonce per response. Times are written in UTC.

## Develop

```bash
(cd rest-client && bun install) && (cd server-portable && bun install)   # what the GUI imports and its types read
cd dashboard && bun install
bun run check                        # svelte-check
bun run build && PORT=5174 OB1_REST_URL=http://127.0.0.1:8000/api OB1_PUBLIC_ORIGIN=http://127.0.0.1:5174 bun serve.ts
```

Then open `http://127.0.0.1:5174/dashboard`. `OB1_REST_URL` there is a REST core you
can reach: the stack's `/api` with `deploy/compose.api-public.yaml`, as above, or one
run from a checkout. Not port 8000, the stack's own: on macOS a listener on every
address beside the stack's loopback one starts without an error, and the browser keeps
reaching the stack.

## Smoke

```bash
bun smoke.ts --url http://127.0.0.1:8000/dashboard --key <write> --read-key <read> --capture-key <capture>
```

It drives the GUI through the stack's proxy as a browser would: the sign-in wall, a
wrong and a capture-only key refused, a cookie the server never issued refused, a
sign-in posted from another origin or with `Origin: null` refused, a wrong key from a
signed-in tab refused in words, the cookie's and the pages' headers, each page rendered
from the REST core, browse walked a page of one at a time in each order (each thought
once, Previous and First page going back, a trust filter, a refused cursor in words),
search finding the driven thought by meaning and by exact text and paging the latter,
each list's data holding only the fields it shows, no page, header, script or cookie
holding the key, sign-out and a
second sign-in each ending a session on the server, and one key's 21st sign-in ending
its own oldest session. `--require-thought` fails rather than skips the thought page
when the overview lists none, and `--require-ingested` unless the overview's newest
thought — the one it drives — is an ingested one, so its notice is driven, and
`--require-pages` unless the brain holds two thoughts, so browse and search page and the
trust filter leaves one out. CI captures two just before the smoke (one with no trust,
then an ingested one) and runs it in the full-stack job,
before that job configures the authorization server; after it, the job holds key
sign-in off.
