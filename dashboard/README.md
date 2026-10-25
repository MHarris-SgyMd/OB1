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
| `src/lib/server/session.ts` | The sessions, held in the server's memory (a key or the authorization server's tokens), and sign-ins through the AS in flight |
| `src/lib/server/oauth.ts` | Sign-in through the authorization server as its `gui` client: the authorization request, the code's exchange, a refresh, a revocation, a session's renewal |
| `src/lib/server/rest.ts` | The REST core's client, and a read under the visitor's key (a core operation's or a plugin's) |
| `src/lib/server/plugins.ts` | The plugin registry (`GET /v1/plugins`), read once a request: the nav's plugin pages, and a plugin page's 404 |
| `src/lib/server/signin.ts` | Whether key sign-in is offered, whoami's answer, and a refused sign-in's words |
| `src/routes/` | The pages: the overview, browse, search, the change feed, the proposals, the workers, the query log, the status, a thought, sign-in and sign-out, `/health`, and the plugins' pages under `plugins/` |
| `src/lib/browse.ts`, `src/lib/search.ts`, `src/lib/params.ts` | The views' addresses: what a page's query means, as the core takes it, and the links between pages |
| `src/lib/tidy.ts` | A GET form's address holding what is set alone |
| `smoke.ts` | The smoke: drives the GUI as a browser would, through the stack's proxy |
| `smoke-oauth.ts` | The sign-in through the authorization server, driven the same way on a configured stack |
| `test-oauth.ts` | `oauth.ts` offline, against a fake token endpoint |

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
  The GUI signs the operator in through it instead (SMD-3307), as its confidential
  `gui` client, with `OB1_AUTH_SECRET_GUI` from `deploy/.env`: the sign-in page's
  button starts a code-and-PKCE request for the REST core (`resource=<origin>/api`,
  `offline_access` with `prompt=consent`); the AS asks for the password and the
  consent and sends the browser back to `/dashboard/auth/callback`, where the code is
  traded on the mesh for an access token (600 s) and a refresh token, held in the
  session like a key and never sent to the browser. Every page calls the REST core with
  the access token, renewed with the refresh token a minute before it lapses (one
  renewal per session at a time); a renewal the AS refuses ends the session, and one it
  does not answer is the page's 503. Sign-out revokes the refresh token at the AS. With
  the AS not answering, the page says sign-in is unavailable; break-glass key sign-in
  on a loopback-only port is SMD-3307's second PR. With no secret or no sound origin,
  it says so, and signs no one in.
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
  beside a public origin is SMD-3307's break-glass listener.) An
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
| `/dashboard/thoughts` | `list_thoughts` a page at a time (SMD-2995's keyset): newest or oldest first, 1–100 a page (the menu offers 10, 25, 50 and 100), filtered by type, topic, person, the writing key's name or kind, a trust floor and the last N days. A typed filter applies on Enter or Apply, a menu's choice when it is made; focus stays where it was, and (with script on) the address holds what is set alone. The address holds the page's place: Next carries the core's cursor; Previous and First page go back by the cursors of the pages before (the last 20 kept in the address; past them Previous gives way to First page); the browser's Back works too. Clear filters keeps the order and size. A cursor the core refuses is a 400 saying so, with the first page offered |
| `/dashboard/search` | By meaning (`search_thoughts`, a fixed top 1–100, identifiers and quoted spans matched exactly; each hit's similarity and, beside it, "exact match" where it holds one, and the tickets it names that moved since it was written, in the tool's words) or by exact text (`search_thoughts_keyword`, the query sent as typed, spaces kept, a page at a time by offset, with how many thoughts hold it). With the embedding provider refusing, a search by meaning says its hits are exact matches alone (or that nothing held the query exactly); with it silent, the core waits out its own 120 s, so the page answers 504 at its 30 s, naming the provider, with the same query by exact text a link away (the core's short-circuit is SMD-3205). With no query it reads nothing; a search, as through any client, is the visitor's own, logged where `OB1_QUERY_LOG` is on, its query sent in a POST body |
| `/dashboard/changes` | `thought_changes`: every capture, edit and deletion with who made it, the most recent by default, or forward from a time or a date, Next carrying the page's cursor as `after` (so a new filter starts again), each change once; by the writing key, by kind, leaving out this key's own. The core's fields as they are (an edit's fields moved, its supersession, its sources); the tool's words for an edit's kind (marked, re-captured, reset) are render.ts's. A start the core cannot read is a 400 in words |
| `/dashboard/proposals` | `list_supersession_proposals`: the pairs the consolidation pass judged, most confident first, by status and lineage — the verdict, confidence and reason (one line), each side's first line, writer (with the ingested notice before an ingested side's text) and what supersedes it, and the review. Read only: accept and reject are `db/consolidate.ts`'s, whose `--list` (and the tool) name the writer flags and the pointers an accept would clear, which this page does not |
| `/dashboard/workers` | `worker_status` (a pool appears once anything is queued for it): each background-work pool's counts — not queued, waiting, in flight, stale, done, failed — whether it is the active pool, and its oldest stale lease |
| `/dashboard/query-log` | `list_logged_searches`: the logged searches, most recent first, from a time — each query (one line), its arm, tier, the count it asked for (034's `match_count`, not how many it found) and arguments. Every key's searches, as the tool shows them to any key that can read; empty where `OB1_QUERY_LOG` is off |
| `/dashboard/status` | `brain_info`, laid out as the core's own rows (`brainInfoRows` in `server-portable/brain-info.ts`, the brain_info tool's words): the server's version, commit and migrations, and the database's ledger, sizes, counts, vectors, proposals, findings and workers' heartbeats |
| `/dashboard/thoughts/<id>` | `fetch`: a thought's text and metadata, with the ingested notice before an ingested thought's text, rendered on the server with no script (the core logs the open as a click-through, as it does any `fetch`: SMD-3212) |
| `/dashboard/signin`, `/dashboard/signout` | Sign-in and sign-out |
| `/dashboard/health` | Liveness: `ok`, asking the REST core nothing |
| `/dashboard/plugins/example/notes` | The example plugin's Notes page, while `OB1_PLUGINS` names it: the newest thoughts (`example_recent`), a thought's notes (`example_list_notes`, each with the key that pinned it), and for a key that may, a form pinning one (`example_add_note`; a refusal said beside the form, the note kept) |

No list's links are preloaded on hover: a thought's page is a logged `fetch`, and a search page a logged search.

**Plugin pages** (SMD-2310's GUI half). A plugin's directory holds no Svelte (check 31), so
its pages are routes here, `src/routes/plugins/<name><path>/`: a `+page.svelte` and a
`+page.server.ts`. The nav names a page where `GET /v1/plugins` lists it to that key — an
enabled plugin of which the key may call an operation, so never to a capture-only key — and
this build has its route. The load and any action start with `pluginAccess` (in
`src/lib/server/plugins.ts`): the page's 404 unless the registry lists it to the key, a
disabled plugin's included, and then the plugin's own operations under the visitor's key,
which is the only way the page reaches them. Check 31 holds the routes here to the
manifests and to that rule ([plugins/README.md](../plugins/README.md), "The rules a plugin is
held to"). The nav reads the registry again at every
navigation — one read a page, waiting 2 s at most before it renders without the plugins'
pages — so a plugin turned on or off with the GUI left running shows at the next page;
recreating `app`, as the example's README does, signs everyone out instead.

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
reaching the stack. A plugin page reads the registry of the REST core it is pointed at, so a
page new in the checkout needs a REST core built from the same tree, with `OB1_PLUGINS`
naming its plugin: the stack's lists only its own build's pages, and the new one is a 404.

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
the change feed walked a change at a time from a start and a bad start refused in words,
the proposals and workers rendering, the query log holding the smoke's own search,
each list's data holding only the fields it shows, no page, header, script or cookie
holding the key, sign-out and a
second sign-in each ending a session on the server, and one key's 21st sign-in ending
its own oldest session. `--require-thought` fails rather than skips the thought page
when the overview lists none, and `--require-ingested` unless the overview's newest
thought — the one it drives — is an ingested one, so its notice is driven, and
`--require-pages` unless the brain holds three thoughts, so browse walks three pages and
search pages, and the trust filter leaves the untrusted ones out; `--require-rows` unless
the proposals and workers pages render rows. `--notes on` drives the example plugin's Notes page
(in the write and read keys' navs, a note pinned by the write key and refused to the read
key): it writes one 2,000-character note a run, which the plugin has no operation to delete,
so point it at a scratch brain. `--notes off` holds the page absent and its route the GUI's
404 (pinning to a held thought, which the gate refuses); unset, a Notes page the nav names
is read and never written to. `--notes-only` runs that arm alone. CI captures three just before the smoke (two
with no trust, then an ingested one), records a proposal and queues a pool through their
producers, and runs it in the full-stack job,
before that job configures the authorization server, with `--notes off`; the next step turns
the example plugin on and runs `--notes on --notes-only`, then turns it off. After them,
the job holds key sign-in off.
