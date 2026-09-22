# 78. Every vendored MCP server is built for the request, or the session, it answers — the three per-scope singletons, one the ticket did not name and one it called correct no longer answer a request on another's transport (SMD-1497)

**The defect.** `integrations/delete-thought-mcp`, `integrations/update-thought-mcp`
and `recipes/work-operating-model-activation` built their `McpServer` once —
upstream at module scope, since change 67 once per key scope — and on every
request did `await server.connect(new StreamableHTTPTransport())` and handed
that transport the request. In `@modelcontextprotocol/sdk` 1.24.3
`Protocol.connect()` sets `this._transport = transport` before anything else,
and `_onrequest()` captures `this._transport` when the *message* arrives — and
`@hono/mcp` 0.1.1's `handleRequest()` awaits `ctx.req.json()` between the two.
So with requests A and B overlapping on one server: A connects transport TA,
B connects TB (overwriting), A's body finishes parsing, A's message is
dispatched to the server, and the server answers it on TB. TB has no stream
for A's request id, `send()` throws `No connection established for request
ID`, the SDK reports it to `onerror`, and A's client waits on a response that
will never come. Change 67's review pass found this and filed the ticket; its
second pass ran it — any two overlapping requests, not a burst. The fourth
server was `integrations/enhanced-mcp`, which the ticket did not name: it
keeps its own single-key compare and so was never in `extensions/test-auth.ts`'s
table, and the ticket was filed from a review of the files that were. It had
the same shape — `const server = new McpServer(…)` at module scope, thirteen
`server.registerTool(…)` calls beneath it, `server.connect(transport)` per
request — and the same hang, run. The fifth was the cost recipe's "after"
sample, `recipes/edge-function-cost-optimization/examples/after/`, which the
ticket held up as the correct shape for a singleton and this section's first
draft repeated: one `McpServer` per key scope, `connect()`ed once per
*session*. The grain is coarser and the defect the same — a server holds one
transport, so the second session minted for a scope took the server's
transport from the first, and every session but the last minted hung. The
review pass ran it on the pinned SDK: two sessions on one key, a POST through
the first's transport times out while the server logs `Failed to send
response: … No connection established for request ID: 1`, and a POST through
the second answers.
Two clients on one key, or one client whose session the isolate re-mints,
would have met it. (The SDK at 1.30.0 refuses a second `connect()` — `Already
connected to a transport. Call close() before connecting to a new transport` —
so a pin bump would have turned the silent hang into a loud 500; at 1.24.3
`connect()` has no guard.)

**The change.** The four servers build per request: `buildServer(principal)`
(or, for `enhanced-mcp`, `buildServer()`) is called where `serverFor(principal)`
or the module-level `server` was, connected to that request's transport and
dropped with it. The per-scope `Map` and `serverFor()` are gone from the three;
in `enhanced-mcp` the construction and the thirteen registrations are wrapped in
the function (a 1,517-line span re-indented — `git diff -w` shows the twenty
lines that changed, four of them the header comment). The re-indent is this
fork's largest whitespace-only divergence from the pin, by an order of
magnitude, in a vendored file: any upstream edit inside the span will
conflict on a plain rebase. The mitigation is one flag — `git rebase -X
ignore-space-change upstream/main` resolves whitespace-only hunks and takes
upstream's substantive edits at their old indentation, to re-indent by hand —
and the procedure under "Rebasing onto upstream" names it. The alternative,
a wrap with the body left at column 0, would have kept both diffs at twenty
lines at the cost of a 1,500-line function body no other server in the tree
formats that way; readability won. CI's deno-check job typechecks the
wrapped file from this change on (it never listed `enhanced-mcp`: change 67's
rationale for the job was the files that consume `../_shared/auth.ts`, and
this one keeps its own compare). This is the shape `kubernetes-deployment`, `ob-graph`, the
cost recipe's "before" sample and the seven extensions already had, and the one
the ticket called the cheap option. The "after" sample builds per *session*:
`server.ts` exports `buildServer(principal)` in place of the cached
`serverFor()`, `index.ts` builds the server beside the transport when it mints
a session and the session owns both, and the README's Step 2, Step 3 and file
tree say so — that shape needs a session store, a TTL and a client that sends
the id back, which the sample has and the four servers do not (they mint no
session id, so a client has nothing to send). Per request is not free, so it
was measured on the pinned SDK (Bun 1.4.0, 20,000 builds after 2,000 warm): a
one-tool server with `delete_thought`'s schema builds in 45 µs (31–45 across
the three reviewers' re-runs, most of it the SDK's Ajv instance, which
`tools/call` never uses — it validates with zod), the recipe's four-tool shape
in 70 µs, thirteen tools with five-field schemas in 474 µs. Those are Bun
numbers; the servers deploy on Deno, so the seventh review pass ran the same
build under Deno 2.9.6 with `enhanced-mcp`'s own deno.json (SDK 1.24.3, zod
4.1.13): one tool 92–97 µs against Bun's 37–39, thirteen five-field tools
776–839 µs against 216–221 — two and a half to four times slower, most of the
gap zod's schema construction — which puts `enhanced-mcp`'s real build at
roughly 1.2–1.8 ms on Deno. Cold start gets lighter, not heavier: the Ajv
instance moves from import time to request time, and the server is garbage
after the response instead of retained.
The cheapest thing any of these servers then does is a database round trip,
in milliseconds; the per-scope cache change 67 kept was buying tens of
microseconds and costing the hang. The cost recipe's README and its "before"
sample still call per-request construction the anti-pattern: their argument is
Supabase invocation counts and the handshake fan-out, which the server's
lifetime does not touch, and per session — once per handshake, not once per
call — is the grain their numbers assume.

**The harness.** `test-auth.ts` fires three `tools/list` at each MCP server
under one key, overlapping two ways, and asserts each answer carries its own
id and the full list — explicit statuses, since a `!== 200` would pass a
timeout (change 75). The first request starts alone with its body still
arriving for 20 ms, and without an Accept header, so the streaming body goes
through the servers' Accept patch as a Claude Desktop connector's would — which
found two servers with no such patch, `extensions/meal-planning/shared-server.ts`
and the cost recipe's "before" sample, answering 406 to any POST whose Accept
lacks `text/event-stream` where the other twelve patch it in (pre-existing;
SMD-1616; the probe kept the header for those two until change 84 moved the
transport to a version that wants no patch and removed all fifteen); the
other two requests start 5 ms later, complete. The stagger is load-bearing, and the
fourth review pass is why: three requests fired in one tick caught main's
shape (the `connect()` overwrite is independent of timing) but never open
the connect-to-body window itself — every handler in a burst reaches its
first await before any body is parsed. The regression that needs the window
is a "cleanup": build a server per request but `if (previous) await
previous.close()` first, the previous request's server kept in a module-level
`let`. In a burst the closed server is always an earlier, finished request's,
so all three answer (771/771 with the same-tick probe — the suite's count
then, before the fourth pass's last text rule); staggered, the second
request closes the first's server while its body is still arriving, `close()`
makes the SDK forget that server's transport, and the first request's answer
is sent to nothing — request 11 fails alone. (The fifth pass tried the other
reading — a server object kept and re-`connect()`ed after each `close()` —
and found a burst catches it too: it is main's shape again.) The margin is 15
ms: the first request reaches its body await within microseconds (measured:
connects at 3.6 ms, the other two at 9.2 and 9.5, its body read at 24.0),
and a stall longer than that degrades the probe to one request then a burst
of two — detection weakens, the fix cannot fail (forced with a 25 ms
stagger: the fix 772/772, the cleanup mutant still 1). Thirty-five runs,
ten of them under four CPU burners, all 772. One shape passes the probe
and is output-correct: a server per scope behind a serialising lock — the
lock covers the whole connect-to-dispatch window, so each answer reaches its
own transport. It is a worse design than a build per request, for reasons the
probe cannot see: every request under a scope waits for the previous one's
body to finish arriving, and the SDK's abort-controller map, keyed by JSON-RPC
id, is shared across unrelated clients. For `enhanced-mcp`, outside the
servers table, a section of its own imports it under the stand-in and runs
the same probe under the one key it reads. Two things the probe needed from
the harness: every in-process request now has a
two-second deadline and reports a hang as status 0 rather than waiting on it,
and the console silencer around a handler is a counter, not a save-and-restore
per call — two requests in flight each saved the other's no-op, and a hung
request never restored anything, so the first run of the probe printed `6
failed` with no failing line: the silencer had eaten them. A drift guard in
the file-text section refuses the spellings of a server that outlives the
request — a module-level declaration that names `McpServer` or
`StreamableHTTPTransport` (a shared transport routes by JSON-RPC id, which
distinct ids would pass), holds what `buildServer()` returns, or is a `Map`
— and the `enhanced-mcp` text is held to
`buildServer().connect(transport)`; it is a spelling check (an untyped `let
cached;` filled later passes it), and the probe is the proof. The "after"
sample, whose tool modules are not in the repository, is held by the
text-only rules to building its server beside its transport when a session is
minted, to no `serverFor`, and to no module-level declaration in `server.ts`
that names `McpServer` — a cache under any name.

**Verified.** `bun test-auth.ts` 772/772 (709 before: 3 overlapping × 13
servers + 14 guards + 5 for `enhanced-mcp` + 5 text-only rules for the "after"
sample). Drilled by putting `main`'s file back: `delete-thought-mcp` fails 3
of 772 — requests 11 and 12 `timed out after 2000 ms`, request 13 (the last
transport connected) answered, and the guard; `enhanced-mcp` the same three;
the "after" sample's `server.ts` fails its four text rules. The cleanup
mutant — a server per request, the previous request's closed first, held in
an untyped `let`, which the text guard passes — fails request 11 alone: the
staggered request, hung. The
fourth reviewer's other mutants: a server built before the 401 check for a
dummy principal fails the nine scope assertions; the probe with three equal
ids still fails main's shape (the deadline carries the detection, the ids
the attribution). `deno check` on `enhanced-mcp` passes (and CI's deno-check
job runs it for that file from this change on; its deno.json resolves
supabase-js).
`bun scripts/check-fork-consistency.mjs` PASS.

**Tidied while the files were open** (one commit after the seventh pass; no
behaviour changed, 772 before and after). The four servers' handler comments
repeated the mechanism their new header notes already state; each now says
what the line does and points at the note and this section. In
`test-auth.ts` the request deadline and the counted console silencer are
declared above the `request()` that uses them rather than below, and the
streaming-body test reads `body instanceof ReadableStream` rather than
`typeof body === "object"`.

**Not done here.** `enhanced-mcp` stays outside `test-auth.ts`'s table — its
own key compare (change 67's decision) and its integer-id read tools
(SMD-1525) are their own tickets. The "after" sample cannot be run here (its
tool modules are placeholders), so its fix is held by text and by the
mechanism the four runnable servers prove. The third review pass found, in
the per-session transport that sample keeps, a growth this change did not
introduce and does not fix: `@hono/mcp` 0.1.1 records every POST's `{ ctx,
stream }` in the transport's `#streamMapping` and deletes it only on abort or
`close()`, so a transport reused across a session holds one `Request` and one
Hono `Context` per tool call until the 30-minute prune drops the session
(measured: 200 completed POSTs on one transport, 0 of 200 `Request` objects
finalized after GC; with a transport per request, 200 of 200). The four
servers moved to a transport per request are clear of it; the sample's README
says the bound; SMD-1607 held the library fix, and change 83 moves the pin to
0.1.5, which releases each POST as it is answered. Nothing here changes a response, a
header or a tool surface; the answer a client receives is the same, now for
the request it sent.

Upstream status: at the pin, all five files carry the shared server —
`delete-thought-mcp`, `update-thought-mcp`, `enhanced-mcp` and
`work-operating-model-activation` at module scope, and the cost recipe's
"after" sample as an exported singleton connected once per session.
**Unfiled** by us.
