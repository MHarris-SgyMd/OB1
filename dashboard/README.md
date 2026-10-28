# dashboard — the operator GUI, a client of the REST core

SMD-2282's decision 2 (`docs/operator-surface-tiers.md`) gives the brain one operator
GUI: a SvelteKit server of its own that reads and writes the brain only through the
REST core (`server-portable/api.ts`), the brain's contract. This directory is that GUI
(SMD-2280). Every page is a call on the REST core through
[`../rest-client`](../rest-client/README.md), the client the MCP server uses, under the
signed-in visitor's own key, or the authorization server's token for them (SMD-3307). It
holds no store, no key list and no brain key of its own; its one secret is the AS's `gui`
client's.

It is the brain's one dashboard. It replaced the three under the retired
`dashboards/` category (SMD-2280's plan: read views first, then plugin pages,
then sign-in through the authorization server, then the old dashboards'
retirement). The two Next.js ones retired with SMD-3309, whose record says what
this GUI took from them and what it dropped; the SvelteKit one and the category
retired with SMD-3310.

| File | What it is |
|---|---|
| `serve.ts` | The entry, `bun serve.ts`: the SvelteKit server `bun run build` writes to `build/`, on PORT (8000), with the origin set (below) |
| `src/hooks.server.ts` | Every request: its origin, the session, the sign-in wall, and the headers that keep a page out of caches and frames |
| `src/lib/server/session.ts` | The sessions, held in the server's memory (a key or the authorization server's tokens), and the sign-in answers already taken |
| `src/lib/server/oauth.ts` | Sign-in through the authorization server as its `gui` client: the authorization request, the code's exchange, a refresh, a revocation, a session's renewal |
| `src/lib/server/rest.ts` | The REST core's client: a read or a write under the visitor's credential (a core operation's or a plugin's), and `may`, whether the session's whoami named an operation |
| `src/lib/server/writes.ts` | What the write pages share (SMD-3322): the edit page's size limit, the delete's flash cookie, a refused session's words |
| `src/lib/server/plugins.ts` | The plugin registry (`GET /v1/plugins`), read once a request: the nav's plugin pages, and a plugin page's 404 |
| `src/lib/server/signin.ts` | Whether key sign-in is offered, whoami's answer, and a refused sign-in's words |
| `src/lib/server/listener.ts` | Which listener a request came in by (the origin, or the break-glass port), and the origin an unsafe request may come from |
| `src/lib/server/grants.ts` | The page of grants' calls to the authorization server's admin listener: the live grants, and a revoke |
| `src/routes/` | The pages: the overview, browse, search, the change feed, the proposals, the workers, the query log, the status, a thought and its edit and delete pages, the grants, sign-in and sign-out, `/health`, and the plugins' pages under `plugins/` |
| `src/lib/browse.ts`, `src/lib/search.ts`, `src/lib/params.ts` | The views' addresses: what a page's query means, as the core takes it, and the links between pages |
| `src/lib/tidy.ts` | A GET form's address holding what is set alone |
| `smoke.ts` | The smoke: drives the GUI as a browser would, through the stack's proxy |
| `smoke-oauth.ts` | The sign-in through the authorization server, driven the same way on a configured stack, and the page of grants |
| `smoke-breakglass.ts` | The break-glass key sign-in on a configured stack with the authorization server down, and the origin refusing it |
| `test-oauth.ts` | `oauth.ts`, the revoker, the session store's revocations, the break-glass listener's rules and the page of grants' calls offline |

## In the stack

Compose's `app` service runs it in the server image, `bun ../dashboard/serve.ts`, on
the mesh as `app.ob1.internal`. The proxy routes `/dashboard` and everything under it
there with the path kept, so the GUI serves under that base (`paths.base`), and its
cookie is scoped to it. The image builds it (`server-portable/Dockerfile`'s
`dashboard-build` stage); the build bundles every package, so the image installs
nothing for it. A release's compose overlay runs the release's server image here too.

Open `http://127.0.0.1:8000/dashboard` (the stack's published port), or
`https://<host>/dashboard` through the TLS proxy or tunnel in front of it once
`OB1_PUBLIC_ORIGIN` names that origin, and sign in with an access key — or, on a stack
configured with the authorization server, through it ("Signing in", below). One or the
other: with `OB1_PUBLIC_ORIGIN` set, a sign-in at the loopback address is refused, the
page naming the address that takes it ("The origin", below).

## Signing in

- **A key.** The visitor pastes an access key. The REST core's `GET /v1/whoami` says
  whose it is and which operations it may call. A read or write key opens a session.
  A capture-only key is refused (403): it may add a thought and read nothing, so no
  page could load. A key the core refuses is refused (401), with nothing held.
- **The session is the server's.** The cookie (`ob1_dashboard_session`, `Path=/dashboard`,
  httpOnly, SameSite=Lax, a day, Secure on https) carries a random id and nothing
  else. Where the origin names a port its name carries it (`ob1_dashboard_session_8010`
  at `http://127.0.0.1:8010`): a browser keeps one cookie per host and name whatever
  the port, so two brains reached on one machine would otherwise share it, and signing
  in to one would sign the browser out of the other (SMD-3352). The key and its scope stay in the server's memory, so neither the key nor
  anything sealed from it reaches the browser, and sign-out ends the session on the
  server. A restart signs everyone out.
- **A revoked key** ends its sessions at their next page: the REST core answers 401,
  and the GUI drops the session and sends the visitor to sign in.
- **While the stack is configured with the authorization server** (`COMPOSE_PROFILES`
  names `auth`, ADR decision 16), key sign-in is off on the public origin, whether or
  not the authorization server answers: knocking it over must not open a weaker door.
  The GUI signs the operator in through it instead (SMD-3307), as its confidential
  `gui` client, with `OB1_AUTH_SECRET_GUI` from `deploy/.env` (recreate `app` after
  turning the profile on, as `deploy/README.md`'s "Authorization server" does): the
  sign-in page's button starts a code-and-PKCE request for the REST core
  (`resource=<origin>/api`, `offline_access` with `prompt=login consent`, so the AS
  asks for the password every time and a sign-out of the GUI is one); the AS sends the
  browser back to `/dashboard/auth/callback`, where the code is traded on the mesh for
  an access token (600 s) and a refresh token, held in the session like a key and never
  sent to the browser. A URL can drop `prompt=login`, and the AS's own session (a day,
  which the GUI's sign-out leaves) would then skip the password, so the AS asks the
  `gui` client the password on every authorization whatever its request says, and the
  callback takes the tokens only if the ID token's `auth_time` is no earlier than the
  sign-in's start. Each sign-in is a grant of its own at the AS, so revoking one
  session's refresh token, which ends its grant, ends no other. A
  sign-in in flight holds nothing on the server: its state and PKCE verifier are
  derived from a binding in its cookie that no URL carries, so a callback URL seen
  elsewhere completes no sign-in this browser started (one the operator completed for
  a sign-in someone else started is that person's, OAuth's own residual). Start and
  sign-out refuse a post from another origin. Every page calls the REST core with the access
  token, renewed with the refresh token a minute before it lapses, from the session as
  it is now (one renewal per session at a time); a renewal the AS refuses ends the
  session, and one it does not answer, or an AS its probe finds down, is the page's 503
  — for up to 30 s after the AS is back, while the probe's answer is kept — (should the
  AS have spent the token before its answer was lost, the next try is a reuse it
  refuses, which ends the session). Sign-out revokes the refresh token at the AS, and a
  session that ends any other way while the GUI runs — evicted, replaced, found
  expired, refused by the REST core, a sign-in that failed after its exchange, a
  renewal that landed after its session ended — has its revoked too; one the AS does
  not answer is tried again every 30 s until it does (for the token's 14 days, a
  thousand at most). A restart forgets its sessions, and what is still due, before it
  could. The access token itself stays good at the REST core until it lapses (600 s at
  most), as the core checks it without asking the AS; it never left the GUI. With the
  AS not answering, the page says sign-in is unavailable and names the break-glass
  port; with no secret or no sound origin, it says so too. Either way it signs no one
  in on the origin.
- **Break-glass** (SMD-3307; ADR decision 15). While the stack is configured, the
  `breakglass` service publishes a second port on `127.0.0.1` alone
  (`BREAKGLASS_PORT`, 8001 unless set; no `_BIND` knob, and no tunnel points at it):
  the forwarder's script on the proxy's `breakglass` entrypoint, which routes
  `/dashboard` alone and marks each request `X-OB1-Listener: breakglass`. The `web`
  entrypoint deletes that header from every request on the origin, so only the proxy
  sets it. On that port the page offers key sign-in whatever the AS's state — the
  operator's way in on the brain's machine when the AS is down, misconfigured or
  locked out — and starts no sign-in through the AS. A session made there opens pages
  there alone, and one made on the origin opens none there; each rides a cookie of its
  own name (`ob1_dashboard_breakglass_<port>` there), so where the two share a host
  (an origin of `http://127.0.0.1:…`), or two brains' break-glass ports share
  127.0.0.1, neither overwrites the other; it is never Secure, the port being plain
  HTTP. What reaches the port is this machine: its browsers, and its containers too,
  through the engine's name for the host (`host.docker.internal`,
  `host.containers.internal`), as they reach any loopback port; the stack's own
  servers reach the GUI on the mesh besides.
- **One key holds at most 20 sessions**, and a sign-in past that ends that key's oldest;
  the server holds 1,000 in all. A sign-in over a live session ends the old one.
- **The origin is shared.** The cookie rides `/dashboard` alone, but any page served
  elsewhere on the same origin (Grafana at `/grafana/` with
  `compose.grafana-public.yaml`, say) can send requests to `/dashboard` that carry it,
  and the GUI's origin check passes them. A script running in such a page reaches
  what the signed-in visitor's key reaches (ADR, "Path-based public routes carry
  obligations").

## The origin

The GUI refuses any request that changes something (POST, PUT, PATCH, DELETE, with a
body or without) posted from another origin — its own check, `hooks.server.ts`, in
place of SvelteKit's, which would refuse the break-glass port's forms — and the cookie
is Secure only on https. So the server must know the origin a browser sees:

- **`OB1_PUBLIC_ORIGIN`**, when it is a sound public origin (the authorization
  server's rules: https, or http on a loopback host, and an origin alone). Set it when
  a TLS proxy or tunnel serves the stack: the stack's own proxy sees plain HTTP. It is
  then the only origin the GUI takes a form from, as it is the one the authorization
  server and every redirect name: sign in there, not at `127.0.0.1`. The break-glass
  port takes its own origin alone, `http://127.0.0.1:${BREAKGLASS_PORT}` — not
  `localhost`, which another process may answer on `::1` (the port is published on
  127.0.0.1 alone), nor the configured origin, from whose pages a key could otherwise
  be posted there. An unsound one is warned of and passed over.
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
| `COMPOSE_PROFILES` | Key sign-in is off on the origin while it names `auth` |
| `BREAKGLASS_PORT` | The break-glass port on the host, 8001 unless set: `http://127.0.0.1:<it>` is the one origin the GUI takes a form from on that listener, and its session cookie's name carries it. Changed, it needs `app` recreated as well as `breakglass` (a plain `compose up -d` does both) |
| `GRAFANA_LINK` | The nav's link to Grafana: `deploy/compose.grafana-port.yaml` sets it to `/grafana/` on its loopback origin, Grafana's root URL whenever that file is named |
| `GRAFANA_ROUTE` | The link when `GRAFANA_LINK` is unset: `deploy/compose.grafana-public.yaml` sets it to `/grafana/` on this origin, so not on the break-glass port, which routes the GUI alone. With neither, no link |
| `PORT` | 8000 unless set |
| `OB1_STOP_GRACE` | The stop's grace, as the servers read it: the GUI drains within it, less 2 s |

## The pages

| Path | What it reads and writes |
|---|---|
| `/dashboard/` | `thought_stats` (the counts, the date range, the largest types, topics and people) and `list_thoughts` (the ten newest; their links are not preloaded on hover, since each open is a click-through) |
| `/dashboard/thoughts` | `list_thoughts` a page at a time (SMD-2995's keyset): newest or oldest first, 1–100 a page (the menu offers 10, 25, 50 and 100), filtered by type, topic, person, the writing key's name or kind, a trust floor and the last N days. A typed filter applies on Enter or Apply, a menu's choice when it is made; focus stays where it was, and (with script on) the address holds what is set alone. The address holds the page's place: Next carries the core's cursor; Previous and First page go back by the cursors of the pages before (the last 20 kept in the address; past them Previous gives way to First page); the browser's Back works too. Clear filters keeps the order and size. A cursor the core refuses is a 400 saying so, with the first page offered |
| `/dashboard/search` | By meaning (`search_thoughts`, a fixed top 1–100, identifiers and quoted spans matched exactly; each hit's similarity and, beside it, "exact match" where it holds one, and the tickets it names that moved since it was written, in the tool's words) or by exact text (`search_thoughts_keyword`, the query sent as typed, spaces kept, a page at a time by offset, with how many thoughts hold it). With the embedding provider refusing, a search by meaning says its hits are exact matches alone (or that nothing held the query exactly); with it silent, the core waits out its own 120 s, so the page answers 504 at its 30 s, naming the provider, with the same query by exact text a link away (the core's short-circuit is SMD-3205). With no query it reads nothing; a search, as through any client, is the visitor's own, logged where `OB1_QUERY_LOG` is on, its query sent in a POST body |
| `/dashboard/changes` | `thought_changes`: every capture, edit and deletion with who made it, the most recent by default, or forward from a time or a date, Next carrying the page's cursor as `after` (so a new filter starts again), each change once; by the writing key, by kind, leaving out this key's own. The core's fields as they are (an edit's fields moved, its supersession, its sources); the tool's words for an edit's kind (marked, re-captured, reset) are render.ts's. A start the core cannot read is a 400 in words |
| `/dashboard/proposals` | `list_supersession_proposals`: the pairs the consolidation pass judged, most confident first, by status and lineage — the verdict, confidence and reason (one line), each side's first line, writer (with the ingested notice before an ingested side's text) and what supersedes it, and the review. Read only: accept and reject are `db/consolidate.ts`'s, whose `--list` (and the tool) name the writer flags and the pointers an accept would clear, which this page does not |
| `/dashboard/workers` | `worker_status` (a pool appears once anything is queued for it): each background-work pool's counts — not queued, waiting, in flight, stale, done, failed — whether it is the active pool, and its oldest stale lease |
| `/dashboard/query-log` | `list_logged_searches`: the logged searches, most recent first, from a time — each query (one line), its arm, tier, the count it asked for (034's `match_count`, not how many it found) and arguments. Every key's searches, as the tool shows them to any key that can read; empty where `OB1_QUERY_LOG` is off |
| `/dashboard/status` | `brain_info`, laid out as the core's own rows (`brainInfoRows` in `server-portable/brain-info.ts`, the brain_info tool's words): the server's version, commit and migrations, and the database's ledger, sizes, counts, vectors, proposals, findings and workers' heartbeats |
| `/dashboard/thoughts/<id>` | `fetch`: a thought's text and metadata, with the ingested notice before an ingested thought's text, rendered on the server with no script (the core logs the open as a click-through, as it does any `fetch`: SMD-3212). Links to its edit and delete pages where the session's whoami named `update_thought` and `delete_thought` at sign-in (SMD-3322) |
| `/dashboard/thoughts/<id>/edit` | `update_thought` (SMD-3322): the thought's text in a field, saved under the visitor's credential with the `updated_at` the page read as `if_unchanged_since`, so a change made since — another tab, a connector, a worker — is refused as stale, in words, and never overwritten; the form keeps the stale time, so saving again is refused again until the thought is opened afresh. The form posts as multipart, so its text goes as it is, not percent-encoded; a text that would post past 1,000,000 bytes (its UTF-8, each line break sent as CRLF) is not offered for editing, the page saying so (the GUI takes 1 MB for an edit's post, 64 kB for any other). An edit typed past 1 MB meets the server's bare 413. An empty text, a NUL and an altered time are refused before any call. Line breaks are saved as typed (a browser's CRLF as one break), a text's leading break included. The core writes the audit row, which keeps the text replaced, and re-embeds the new text. A 403 for a session whose whoami named no `update_thought`. Opening it is a `fetch`, logged as a click-through like the thought's own page (SMD-3212) |
| `/dashboard/thoughts/<id>/delete` | `delete_thought` (SMD-3322): the thought's title and first line, and a Delete to confirm; then the list, which says what was deleted, once, from a flash cookie the delete sets (never from its address, which anyone can link to). A thought that statements in other thoughts cite is refused, the page saying how many, with a second confirm to delete it anyway (`detach_citations`: each statement keeps its text and stance and records the thought as its deleted source). The core writes the audit row, which keeps the thought's text. A 403 for a session whose whoami named no `delete_thought` |
| `/dashboard/grants` | On a stack configured with the authorization server (`COMPOSE_PROFILES` naming `auth`), for a session that may write (the operator's, or a write key's on the break-glass port), and named in the nav for it alone (SMD-3307 PR 3): the clients signed in as the operator, each a grant at the AS — the MCP clients connected, and each sign-in to this GUI (one holding no live refresh token marked so: never finished, or idle past the refresh token's 14 days; recreating `app` forgets its sessions, whose grants stay listed until revoked here or lapsed) — newest first, 500 at most, each with its client (a registered one by its id and the name it gave itself, the characters that hide or reorder text taken out, though a look-alike name still looks alike; a metadata-document one by its host), its scopes and resources, when it was signed in, last renewed (its newest refresh token, when later than the sign-in's own) and lapses; and a revoke for each. Read and written through the AS's admin listener on the mesh (`auth.ob1.internal:3001`, no proxy route to it) under the GUI's own `gui` credentials, never the visitor's; so the visitor's own session is checked at the REST core on every load and revoke (`whoami`, which renews a token due and ends a refused one), and a session whose grant was revoked, or whose key was removed, loses the page with it. A revoke refuses the grant's refresh tokens at once; the access token the client holds is refused by the REST core once it lapses, within ten minutes (the maintainer's choice of 2026-10-26), and revoking one of this GUI's own grants ends that session at its next renewal. The AS down is said from the sign-in page's probe of `/healthz`, whose answer is kept 30 s either way: while it says down, without calling the listener (an AS just started again shows within 30 s); while it says up, the listener is called, and one that hangs costs a call's 10 s; its refusing the GUI's credentials is said too, and so is its turning the GUI's address away after 20 refusals in 15 minutes. Each revoke is logged: the AS's log names the grant and its client, the GUI's the session that revoked it. Without the auth profile the page is a 404; configured but without `OB1_AUTH_SECRET_GUI` or a sound origin, a 503 naming them; for a read session a 403 |
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
`no-referrer`, under which a browser posts a form with `Origin: null` and the GUI's
origin check refuses it), and carry a Content-Security-Policy that admits no script but
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
is read and never written to. `--notes-only` runs that arm alone. `--writes` (SMD-3322)
captures a thought of its own over the proxy's `/mcp` with the write key, edits it as the
page's multipart form posts (a 160 kB text saved; an empty text, an altered time and a stale
read refused in words, the stale time kept in the form) and deletes it on its pages, the list
saying so once and never for a link. It checks that a read key sees no links, gets 403 from
both pages and has its posts refused, and it prints the thought's
id. Leave it off against a brain you would not write to. Each key may come
from the environment instead of its flag (`OB1_SMOKE_KEY`, `OB1_SMOKE_READ_KEY`,
`OB1_SMOKE_CAPTURE_KEY`), off the process list. CI captures three just before the smoke (two
with no trust, then an ingested one), records a proposal and queues a pool through their
producers, and runs it in the full-stack job,
before that job configures the authorization server, with `--notes off --writes`, then reads
the write arm's thought's audit rows: its capture, then one edit and one delete through the
REST core under the smoke key's name. The next step turns
the example plugin on and runs `--notes on --notes-only`, then turns it off. After them,
the job holds key sign-in off.
