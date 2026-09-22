# 83. The `@hono/mcp` pin moves from 0.1.1 to 0.1.5 — the transport lets go of each POST it has answered, so a transport kept for a session (the cost recipe's after sample) no longer holds one Request and one Context per tool call until the session is swept (SMD-1607)

**The defect.** Change 78's third review pass found it and its "Not done here"
records it: in `@hono/mcp` 0.1.1 `handlePostRequest` records each request's
`{ ctx, stream }` in the transport's private `#streamMapping`, and the only
per-request delete is inside `stream.onAbort`. When a response completes
normally `send()` closes the stream and deletes the two maps keyed by request
id, not this one; hono 4.9.2's `streamSSE` then calls `stream.close()`, and
`StreamingApi.close()` does not run abort subscribers — only `abort()` does.
So a transport that outlives the request keeps the `Request`, the Hono
`Context` and the closed stream of every POST it ever answered, until
`transport.close()` clears the map. The four servers change 78 moved to a
transport per request drop the transport with the request and are clear of
it. The cost recipe's after sample keeps one transport per session, on
purpose — that is the sample's point — and grew by one request per tool call
for up to the thirty minutes its sweep allows a session.

**The change.** The library fixed this a year ago: 0.1.2 (honojs/middleware
PR #1342, 2025-08-26, "SSE keepalive timers cleaned up on close") gives every
`#streamMapping` entry a `cleanup()` that deletes it, and both `send()` on the
last response and `close()` call `stream.abort()` where they called `close()`,
which runs the subscribers and so the cleanup; the SSE callback awaits that
abort and hono's `streamSSE` closes the body after it. 0.1.3 and 0.1.4 are
version chores (a jsr/npm mismatch); 0.1.5 (2025-10-30) `unref()`s the
keepalive interval of the standalone GET stream, which the fork's servers
have not opened since change 75. The peer range, `@modelcontextprotocol/sdk
^1.12.0` and `hono >=4.0.0`, admits the pin's 1.24.3 and 4.9.2. 0.2.0 and
later do not: 0.2.5 wants the SDK at ^1.25.1, 0.3.2 at ^1.29.0 and is built
against hono 4.11.5 — a move of the SDK pin with it, not this ticket's (0.3.0
also relaxes the Accept check to either token, SMD-1616's mechanism; change
84 made that move). So the pin moves to 0.1.5 at every site that names it —
`extensions/package.json`, `server/package.json`,
`server-portable/package.json`, the thirteen `deno.json` (the core server,
six extensions, four integrations, two recipes) and the template
`extensions/_template/AGENT_SPEC.md` hands a new extension — and the three
`bun.lock` files, in one commit, as `test-auth.ts`'s pin guard requires:
seventeen sites, three lockfiles. What 0.1.5 leaves as it was: the body is
still parsed after the server has been connected (change 78's window — its
staggered probe still means what it did), a POST is still 406 unless Accept
names both tokens (SMD-1616 stands), and a `tools/list` and a `tools/call`
answer are the same bytes at both versions — status, headers and body.
What it changes beside the map: an entry stores `{ header: ctx.header }`
rather than the Context, and would call that unbound in JSON-response mode
with a session id — neither of which any server here uses.

**The sample.** `pruneExpiredSessions()` closes the transport of each session
it drops: `close()` aborts whatever stream is still open, clears the maps and,
through `onclose`, tells the SDK the server has no transport — a dropped
session is ended rather than left to the collector; the call carries a
`.catch` so that a rejection — nothing in `close()` throws today — cannot
become an unhandled one, which under Deno ends the isolate. The README's
paragraph on the session-long transport says the release is 0.1.2's and what
0.1.1 did.

**The measurement.** A probe from `extensions/` — one `McpServer`, one
transport, 200 completed `tools/list` POSTs, a forced GC, then how many of the
200 `Request` objects are gone — read through `WeakRef`s. The ticket's
numbers were read through a `FinalizationRegistry`, and a rearranged probe
read 0 of 200 in every arrangement, including a transport per request, because
the registry's callbacks stopped arriving after the first run; `deref()` after
`Bun.gc(true)` is read on our schedule, not the runtime's. At 0.1.1: the
shared transport releases 0 of 200; `close()` then releases 199; a transport
per request releases 198–199. At 0.1.5: the shared transport releases
199–200 of 200 with no `close()`; three rounds of each at each version. 200
POSTs take 4–16 ms either way. One or two can linger, reachable from the
frames that answered them under a conservative stack scan — the review's
standalone copy of the same loop read 98 of 100 twice in thirty rounds where
the suite's read 100 in ninety — so the slack is a property of the frame
shape, not of the transport, and no assertion should rest on its exact size.

**The test.** `extensions/test-auth.ts` gains a section after the pin guard:
one server, one transport, 100 sequential `tools/list`, each asserted
answered with its own id, then a forced GC and the count of `Request` objects
collected, asserted at 90 or more of 100 — 0.1.1 releases none, and the
distance between none and most is the mechanism; the exact slack is not (the
review pass moved the bar from 99). It is a test of
the pinned library, which nothing runnable in the tree exercised across a
session; the after sample, which does, cannot be run here (change 78) and is
held by a text rule that its sweep closes what it drops. The docblock names
the claim.

**Verified.** `bun test-auth.ts` 775/775 (772 on main: two for the transport,
one text rule). `server/`: `test-stateless.mjs` 47/47, the two other suites
PASS. `server-portable/`: `test-server.ts` 151/151, `test-auth.ts` 67/67,
`tsc --noEmit` clean. `deno check` on `recipes/ob-graph` fetched 0.1.5 and
passed. `check-fork-consistency.mjs` PASS. Drills: 0.1.1 put back in
`extensions/package.json` fails 12 — the eleven `deno.json` the guard compares
and the transport's `0/100 Request objects collected`; the sample without its
`close()` fails its one rule.

**Review, first pass** (one cold reviewer beside the author's read; the pass
covered change 83 with this one, and its findings there are recorded there).
covered change 84 with this one, and its findings there are recorded there).
Two findings here, both fixed. The release assertion's bar of 99 rested on
the slack being exactly one; the reviewer's standalone copy of the loop read
98 twice, so the bar is 90 and the paragraphs above say why. The sample's
`close()` was `void`ed; it carries a `.catch` now. Checked and found right:
the stream lifecycle at 0.1.5 (`send()` → `abort()` → `reader.cancel()`,
the frame already pulled because the transform's readable has no buffer),
that per-request transports hold no timer on the POST path, and that
deleting from the sessions Map inside `for…of` is safe.

**Tidied while the files were open.** The release section's comment in
`test-auth.ts` points at this section instead of restating it, twelve lines
to six; the test paragraph above loses a parenthetical. No behaviour change.

**Not done here.** SMD-1616 (the Accept patches, and whether 0.3.x's
either-token check is worth the SDK and hono moves it needs — change 84
made the moves and removed the patches). The after
sample is still untested by anything that runs it. No upstream issue was
filed against `@hono/mcp`: the fix shipped before this fork found the defect.

Upstream status: at the pin, `server/deno.json` and the twelve vendored
`deno.json` pin 0.1.1 — and upstream's `server/package.json` ranges
`^0.1.5`, so upstream's own Node suites ran a transport its Edge Function did
not deploy (the drift the fork pinned that file down for, and the pin guard
holds). The fork's seventeen sites read 0.1.5. A rebase over an upstream bump
of the same lines conflicts on one line per file — take the higher.
**Unfiled** by us.
