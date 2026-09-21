# 42. OAuth discovery is a 404 — `/.well-known/*` is answered before the auth catch-all, so the claude.ai connector proceeds on the key (SMD-1246)

Before it opens a custom connector, claude.ai fetches
`/.well-known/oauth-protected-resource` (RFC 9728). A **404** there means "no
OAuth here, treat the resource as public", and the connector proceeds on the key
it was given. A **401** means "protected", and the client falls back to OAuth 2.1
Dynamic Client Registration (RFC 7591) — which, against a server with no OAuth,
fails with *"Couldn't register with Open Brain's sign-in service."* Upstream
[#340](https://github.com/NateBJones-Projects/OB1/issues/340) (2026-09-05)
diagnosed this on the Supabase path: the API gateway special-cases that one path
and answers 401 before the Edge Function sees the request, so nothing inside
`open-brain-mcp` can fix it, and the reporter's verified workaround is a
Cloudflare Worker in front that returns 404 for the prefix.

`server-portable` had the same defect by a different door. `app.all("*")` caught
every path, so the discovery GET went through `authenticate()`. With no key it
got HTTP 200 and a JSON-RPC `-32001` envelope — fix 1's answer, right for an MCP
request and wrong for this one. With a key — which IS the URL-only connector's
shape: the SDK copies the connector URL's query onto its path-aware discovery
GET (`client/auth.js`, `url.search = issuer.search`), a fact this paragraph got
wrong until change 75's review — it
authenticated, cost an agent-registry resolve, and was handed to
`StreamableHTTPTransport`, which opened an SSE stream nothing wrote to or
closed: the response never completed (SMD-1259, found by this change's review
pass; closed by change 75). Neither is 404. Nothing exercised the path: no test
named `.well-known`, and `deploy/smoke.sh` only ever POSTed to the endpoint.
Local Claude Code over `x-brain-key` never asks, which is why it stayed
invisible in development.

**The change is one route.** `app.all("/.well-known/*", …)` returns `Not Found`
404 with the CORS headers, placed between the `OPTIONS` preflight handler and the
catch-all so it runs before `authenticate()` and the agent resolve — the answer is
a fact about the server, not the caller. The route's comment carries the two
ordering rules (why it sits where it does, and that a later `/.well-known/` route
must sit above it); they are not repeated here.

**Verified.** `test-server.ts` [11], twenty-seven assertions against the real
server: nine rows — four discovery paths including the exact one upstream saw
Supabase answer, then the bare document under a wrong key, the right key in the
header and the right key in `?key=`, then POST and the OPTIONS preflight —
each asserted for status, CORS and a body that is not a JSON-RPC envelope, by the
same rule [4]–[10] use. Every probe carries one 2-second abort that covers the
body read, and a transport error is reported by its own name, so a regression
fails its assertions with a stable count instead of hanging on the catch-all's
stream or crashing the suite; drilled by deleting the route. `deploy/smoke.sh`
check 2 probes the **origin root** — where RFC 9728 puts the document and where
claude.ai looks, with the server's path as a suffix when the URL carries one —
with no key and following redirects, as the SDK client does, and naming the URL
and code that missed; the base URL must carry a scheme and no query string, or
the script refuses it rather than derive the wrong origin. It was the
one check a Supabase deployment cannot pass, and that failure is real; change
75's checks 3 and 4 are the others.
`tsc --noEmit` is clean and the Workers bundle still builds
(`wrangler deploy --dry-run`, 272 KiB gzipped).

**Not verified: a live connector.** The only check that closes the ticket is a
real claude.ai custom connector completing the handshake against a deployed fork
server. That has not been run. It is also the first live exercise the Workers
target would get; the known-issues entry below still stands.

**Not done here.** Serving real RFC 9728 protected-resource metadata, or OAuth
itself — #216 and PR #238 remain the real fix for the key riding in the URL; this
change says only "there is no OAuth here", which is what the client needs to hear
to proceed on a key. Refusing other non-MCP paths: `server-portable` mounts the
transport at every path, and both shipped targets (compose, Workers) serve at
`/`, so a mount point plus Hono's `notFound` is available and would make this
route one case of a general rule rather than an exception above a catch-all.
That is a design decision, and it sits with the **method** axis the review passes
found — an authenticated GET anywhere costs an agent-registry resolve and then
hangs on an SSE stream the per-request transport never closes, because the
Accept patch stamps `text/event-stream` on every method (upstream #424; their PR
#425 answers GET with 405). Both are SMD-1259, a second mechanism, not this one;
the method axis is closed by change 75, which answers GET with 405 before
`authenticate()`. The path axis (a mount point) stays open there too.
The concrete reason the path axis waits: a mount at `/` makes the connector URL
the mount point, and a proxy that forwards under an unstripped prefix — the shape
`deploy/README.md` already anticipates — would then 404 the MCP endpoint itself.
That is a deployment-contract change, not a route. A
server mounted under a path prefix needs its proxy to route `/.well-known/` to it
or 404 it there: discovery lives at the origin root, so this route can only answer
what reaches it. `SETUP.md` gains no per-client connection notes yet; the ticket
names them as a follow-on once a connector has been seen to work.

Upstream status: #340 open; the fix cannot land in their server. **Unfiled.**
