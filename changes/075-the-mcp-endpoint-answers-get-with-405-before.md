# 75. The MCP endpoint answers GET with 405 before `authenticate()` — an authenticated GET no longer opens an SSE stream nothing writes to or closes (SMD-1259)

`server-portable/index.ts`, `server-portable/test-server.ts` ([13]),
`deploy/smoke.sh` (check 3), `deploy/README.md`, `SETUP.md` (Linear SMD-1259,
filed from change 42's first review pass; upstream
[#424](https://github.com/NateBJones-Projects/OB1/issues/424)).

**The defect.** `app.all("*")` handled every method. Beneath it the Accept patch
— upstream's #33 fix, written for POSTs from Claude Desktop connectors that omit
the header — set `Accept: application/json, text/event-stream` on GETs too, and
`StreamableHTTPTransport.handleRequest` then took an authenticated GET as a
request to open the standalone SSE stream. The transport here is built per
request and is sessionless: nothing ever wrote a message to that stream or
closed it. The response was `200 text/event-stream`, its headers flushed at
once, its body a `ping` event every 30 s from the transport's keep-alive and
nothing else, until the client hung up — or, on Bun alone, until its 10 s
per-connection idle reset beat the ping (SMD-1259 measured 10–12 s there). On
Node and Workers nothing on the server side ended it: an uptime checker
configured with the key parked one connection per probe, indefinitely. Each
such GET first cost an agent-registry resolve and a server build. Change 42's review reproduced it three ways:
`GET /?key=…`; `GET //.well-known/…?key=…` (a trailing slash on the base URL
doubles the slash, which Hono does not match to `/.well-known/*`); and
`GET /.Well-Known/…` (Hono matches case-sensitively). Upstream #424 reports the
same hang from mcp-remote, whose handshake GET waited 60 s for it. Any holder of
a key — a browser opening the connector URL the docs hand out, an uptime checker
configured with the key, a client echoing `?key=` on GET — could park
connections at will, and nothing rate-limited it.

**The change.** The route table now says what the endpoint serves. The MCP
handler is registered with `app.on(MCP_METHODS, "*", …)` for `["POST"]` alone,
and Hono's `notFound` answers whatever no route matched with
`405 Method Not Allowed`, `Allow: POST, OPTIONS` and the CORS headers —
before `authenticate()`, so no key shape reaches the agent registry or builds a
server, and the answer is the same for no key, a wrong key and a revoked one; it
is about the method, not the caller. 405 and not 404 because the handler serves
POST at every path: an unmatched request is always a method the endpoint does
not serve, never an unknown path. `notFound` rather than a trailing
`app.all("*")` (the second pass's shape) so that a route registered later is not
silently shadowed by dispatch order — the third review pass verified the two
byte-identical across every method and both odd paths. That 405 is the
Streamable HTTP transport's documented answer from a server that offers no
server-initiated stream. HEAD,
PUT and PATCH land there (the transport's own 405 for PUT and PATCH came after
auth and named `GET` in its `Allow`), and so does DELETE. The first draft kept
DELETE on the premise that the SDK client sends it from `terminateSession()` and
accepts 200 or 405; the first review pass read the client and found the premise
true and irrelevant: `terminateSession()` returns before sending anything when
it holds no session id, the id comes from an `mcp-session-id` response header —
which this server strips from every response — or from a `sessionId` the
application passes to the transport's constructor, so the only DELETE that can
arrive is from a client an application seeded by hand, and it accepts the 405 by
spec. A keyed DELETE bought a resolve and a server build for a transport with
nothing to close. One list — `MCP_METHODS` — registers the handler and names the
405's `Allow`, so the two cannot drift; the first draft had a string beside a
hand-written boolean, which the review named as a value defined twice. The CORS
`Access-Control-Allow-Methods` is left as it was on main, `GET, POST, OPTIONS,
DELETE`, on purpose: it answers a different question — what a browser may send
so that it can hear our answer — and the first review pass's version, which
derived it from the served list, would have turned a browser-hosted client's
DELETE (or a preflighted GET carrying `mcp-protocol-version`; GET itself is
CORS-safelisted, but a preflight still happens for the header) into a network
error where the server would have said 405. The second pass caught that.

**A contract change for health checks, and its remedy.** A keyless `GET /` or
`HEAD /` used to get the 200 JSON-RPC refusal; it now gets 405. A
platform-default HTTP probe — Kubernetes `httpGet`, a load balancer's target
check, an uptime monitor — can only GET and expects 2xx, so aimed at `/` it
would mark a healthy server down. So `GET /health` is a route of its own,
registered between `/.well-known/*` and the MCP handler, before
`authenticate()`: `ok`, 200, no key needed, a key ignored; Hono routes HEAD to
it as GET, so a HEAD probe gets a bodiless 200. It says the process is serving
and nothing else — readiness (is the database reachable) stays preflight's job
at the entrypoint, as the Dockerfile comment records. The third review pass
found the second pass's route an exact root match: behind the unstripped proxy
prefix `deploy/README.md` and change 42 already anticipate, `GET /mcp/health`
got the 405 — the very outcome the route was added to prevent — and so did
`/health/`. The route is now a GET handler on `*` that tests the path for
`health` as its last segment, optional trailing slash, and calls `next()`
otherwise (which lands on the 405). A route pattern was tried first —
`/:prefix{.+}/health` — and in `test-server.ts` matched `/mcp/health` and
`/a/b/health` but not `/functions/v1/open-brain-mcp/health`. Three passes
stated three mechanisms for that, and the fifth is the one driven directly
against the project's Hono 4.9.2 with each router named: the RegExpRouter
accepts `/:prefix{.+}/health` on its own and matches four segments; what makes
it throw `UnsupportedPathError` at registration is a `:param` route sharing the
root node with a static route — `/.well-known/*` here, or a plain `/health` —
regex or no regex; SmartRouter then falls back to the TrieRouter, and the
TrieRouter miscounts a `{.+}` prefix of three or more segments (its segment
counter matches one slash where it should match all). The scratch apps that
"matched every depth" in passes 3 and 4 were loading Hono 4.13.8 from Bun's
global cache, not the project's 4.9.2 — a scratch file outside the package
resolves `hono` elsewhere. The lesson holds either way: the pattern's reach
depends on router internals and on which Hono answers, and testing the path
depends on neither. The name is exact after Hono's decodeURI: `/healthz`,
`/Health` and `/health/x` are not it; `/he%61lth` is; an encoded slash `%2F`
stays encoded and is not a slash, so `/health%2F` and `/health//` are refused
while `/health/` and `//health` pass — one trailing slash, and an empty segment
is tolerated. The breadth — `health` under any prefix — stands in for a
base-path setting the server does not have; the mount change 42 defers would
match `${base}/health` exactly and should narrow it. `POST /health` is the MCP
endpoint, as POST at every path is, and a PUT or DELETE at a health path gets
its 405 with `Allow: GET, HEAD, POST, OPTIONS` — the health resource's methods,
which include the endpoint's, derived from the same list (the fourth pass wrote
`GET, HEAD, OPTIONS` and contradicted its own sentence about POST). The
image's `HEALTHCHECK` keeps POSTing to the endpoint, which also proves the MCP
path serves; `deploy/README.md` points platform probes at `<base>/health` and
says a browser opening the connector URL sees `Method Not Allowed`, which is
expected. Nothing in the tree GETs the endpoint for liveness (checked: the
Dockerfile, `compose.yaml`, `smoke.sh`, the workflows; the Kubernetes
integration uses a `tcpSocket` probe).

**What the ticket's smallest fix would have missed.** SMD-1259's second review
pass offered a method condition on the Accept patch as the minimal fix. Read
against the SDK client (`@modelcontextprotocol/sdk` 1.24.3,
`_startOrAuthSse`): the client sets `Accept: text/event-stream` on its own GET,
so the transport would have opened the stream for it whether or not the patch
ran. The patch is left as it was, with a comment saying only POST now reaches
it. The guard is the fix; gating the patch as well would have been a second
mechanism with no observable behaviour left to test.

**What the client does with a 405.** Read in the SDK source, not asserted:
`_startOrAuthSse` cancels the body and returns on 405 — the comment there reads
"indicates that the server does not offer an SSE stream at GET endpoint … an
expected case that should not trigger an error" — and any other non-2xx is a
`StreamableHTTPError` it reports through `onerror`. mcp-remote wraps this
client. A live connector has not been seen to do it; see below.

**Verified.** `test-server.ts` [13], 64 assertions against the real
server: eleven fetch rows — GET under no key, a wrong key, the right key in the
header and in `?key=`, GET carrying the SDK client's own headers, HEAD, PUT,
PATCH, DELETE with and without a key, and the case-variant discovery path — each
asserted for 405, an `Allow` naming the served methods, CORS, and a body that
is not a JSON-RPC envelope; the doubled-slash path handed to `worker.fetch` as
a `Request` object, because Bun's `fetch()` collapses `//` to `/` on the wire
and a fetch row probed the 404 route instead (found when that row failed) — an
earlier draft wrote the request line over a raw socket to prove Bun.serve's
parser passes `//` through, which the sixth pass called a harness property and
not a repo contract, production being Deno and Workers; `/health` → 200 with
CORS bare, with a key, as HEAD, with a trailing slash, under a one-segment and
under the Supabase-shaped three-segment prefix; `/healthz`, `/Health`,
`/health/x`, `/a/healthz` → 405 or 404 — route exactness, not a status
contract, since what a stray GET gets is the deferred path-axis decision, but
one of the two refusals and nothing else, because the third pass's `!== 200`
would have passed the abort marker, which is a hang, the one outcome the block
exists to refuse (the fourth pass reproduced it with a wrapped `fetch`);
`PUT /health` → 405 with `Allow: GET, HEAD, POST, OPTIONS`, and `POST /health`
with the key → the transport's `initialize` result (a keyless row would have
been satisfied by the JSON-RPC refusal, which the sixth pass caught). The sixth
pass also asked whether that health-path `Allow` — a second evaluation of
`HEALTH_PATH`, for a request nothing sends — is worth its seam; it is kept,
because an `Allow` that omits GET at a path that serves GET is a false
statement, and the cost is one regex test on a refusal path. A base-path
setting would make both the route and this branch exact; that is the mount
change 42 defers. The exact CORS method list lives in [3], where the preflight is
now probed through the same abortable helper, whose body parse sits outside the
transport try so a non-JSON body reports the status the server sent rather than
`SyntaxError`; POST reaching the transport is [7], which also sends
`Accept: text/event-stream` alone and gets 200 — the Accept patch now supplies
whichever of the two tokens the transport requires is missing, where it used to
test only the SSE token and let that POST through to a 406 after paying the
resolve and the build (change 84 removed the patch: at `@hono/mcp` 0.3.x the
transport takes either token, or none, and [7] sends all three forms
unpatched). Drilled by restoring the pre-change shape — the handler on
`app.all` and the `notFound` removed — 34 of 151 assertions fail: the
fetch rows holding a valid GET fail as `TimeoutError`; the doubled-slash row as
a 200 (the stream's headers flush at once; it is the body that never ends, and
that row reads only the status); the rows without a key as 200 with an envelope; HEAD, PUT and PATCH
by an `Allow` that names GET, from the transport's own 405 after auth; the keyed
DELETE by the transport's 200; the four near-miss paths and `PUT /health` by
the 200 refusal; `/health` keeps passing, being its own route. The
suite's 2 s abort on every routing probe stays: it is what turns the failure
mode this change closes into a red assertion instead of a stuck CI job, so it is
the test's teeth, not scaffolding to retire. `deploy/smoke.sh` check 3 GETs the
endpoint and expects 405; check 4 GETs `<base>/health` and expects the body
`ok` — right whether or not the proxy strips its prefix, by the path test
above. The body and not the status, because a 200 there proves nothing: a
server with no health route (upstream's, say) answers a keyless GET with a 200
JSON-RPC refusal, and a proxy that redirects unknown paths to a landing page
answers 200 too — the fifth pass's status-only check passed on both, while
three documents claimed a Supabase deployment fails it. Two checks, because
they are two contracts with two remedies (the fourth pass bundled them into one
tally to keep the count at eight, a constraint it had itself dissolved by moving
the count literal into one file). Both **with no key**. No key, because both answers come before `authenticate()` so a key proves
nothing, and because the script's status helper follows redirects with `-L`, on
which curl forwards a custom header to whatever host comes next — the first
draft sent the key, and behind a redirecting front proxy it would have landed in
a third party's access log. A 200 from the endpoint is the guard missing or a
front proxy answering `GET /` itself, and the message says both; a hang would
also read as 200 under `--max-time`, since the stream's headers flush before the
body stalls (the first draft said `000`, which curl prints only when no status
line arrives at all). Check 2's comment now says why a keyless discovery probe
suffices — the route answers before auth whether or not the key rides along —
rather than the false claim that the connector sends none. The former checks
3–7 are now 5–9. No document carries the count any more: `deploy/README.md`
says the summary ends with `0 failed` and exits 0, and `SETUP.md` points there.
This change bumped seven to eight by hand in two files before the fourth pass
noticed, then eight to nine in one, before the sixth pass asked why a number
the script computes is copied anywhere. `SETUP.md`'s tool counts (ten for a
write key, seven for a read key; three tools gated, not two) are corrected
where they contradicted each other eight lines apart, and
`server-portable/README.md`'s suite count and bundle size, stale since [11]
landed, now match the run, and are the only current copies of either number
(the dated run records in changes 42 and 43 keep theirs) — `SETUP.md` and the
known-issues entry below point there.
`tsc --noEmit` clean; the Workers bundle builds (`wrangler deploy --dry-run`,
281 KiB gzipped). The compose stack's smoke run is CI's `deploy-stack` job.

**Tidied while the files were open** (boyscout, after the sixth pass; no
behaviour change, the suite count unchanged): the two 405 header sets are built
once instead of spread per refusal; the test's probe deadline is one constant
where it was the literal `2000` twice; and the per-row refusal triple that [11]
and [13] each spelled out is one `expectRefusal()` helper beside `probe()`. Two
cut-for-space items were left alone because they change behaviour: an `Allow`
on the OPTIONS answer, and Hono's `cors()` middleware in place of the
hand-spread header (its preflight answers 204 where [3] asserts 200) — the
latter is a ticket if anyone wants it.

**Not verified: a live connector.** The same standing as change 42: a real
Claude Desktop connector, a claude.ai connector and mcp-remote against a deployed
build of this `main`, each completing `initialize` and listing tools. The SDK
reading above says they will. It is not the same as seeing it.

**Not done here.** The path axis — mounting the transport at a path and letting
Hono's `notFound` answer `/favicon.ico` and `/robots.txt` — remains the
deployment-contract decision change 42 describes; `/health` no longer waits on
it. Today those stray paths get the 405 like any other GET, which is a complete
answer if not the most descriptive one.
`server/index.ts`, the Deno Edge Function upstream deploys, carries the same
Accept patch and no method guard; it is upstream's file, and #424's PR #425 is
their fix for it. A Supabase deployment therefore fails smoke checks 3 and 4 as
it fails check 2, and for as real a reason: with a key, its GET hangs, and it
has no `/health` — its keyless GET there gets the 200 JSON-RPC refusal, which
is why check 4 reads the body.

Upstream status: #424 open, PR #425 open. **Unfiled** by us.
