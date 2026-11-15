# What makes an MCP client fetch the tool list again

Measured 2026-11-14 (the logs' times are UTC, 2026-11-15) for SMD-4344. A record of what was measured on that date: a client's later release may behave differently.

## The question

A key's tool list changes without the client's doing: a plugin is enabled, a key's scope changes, a release adds a tool. A connected client keeps the list it fetched at connect, and the user reconnects by hand.

The MCP revisions offer several ways for a server to prompt a new `tools/list`. Which one works depends on the client. This page records, for each client measured, which revision it offers and which mechanism makes it list again.

## Result

One client is measured so far: Claude Code 2.1.325, headless (`claude -p`), on macOS.

| Server it meets | Revision used | A tool is added while it is connected | Lists again? |
| --- | --- | --- | --- |
| 2025-era, no session, POST only (the probe's copy of how the brain wires `/mcp` today) | 2025-11-25 | nothing can be sent | No. The new tool never appears, in the same turn or in a new one. |
| 2025-era, with a session and a GET stream | 2025-11-25 | `notifications/tools/list_changed` on the GET stream | Yes, 4 ms after the notification. |
| 2025-era, with a session | 2025-11-25 | the session is forgotten: 404 to its session id | Yes, at its next tool call: it initializes again, repeats the call, then lists. |
| 2026-07-28 | 2026-07-28 | `notifications/tools/list_changed` on its `subscriptions/listen` stream | Yes, 4 ms after the notification. |
| 2026-07-28 | 2026-07-28 | nothing sent; `tools/list` answered `ttlMs` 3000, then 2000 | No. No second `tools/list` in 13 s, nor in 51 s, each with a tool call after the wait; nor at the start of a new turn 10 s after the change. |
| 2026-07-28 | 2026-07-28 | every listen stream cut, nothing sent | Yes. It opens `subscriptions/listen` again 6 s after the cut and lists at once. |

What Claude Code 2.1.325 does at connect:

- It sends `server/discover` first, with the 2026-07-28 envelope. A server that answers it gets 2026-07-28 from then on.
- A 2025-era server answers that probe with an error (400 from the SDK's 2025-era transport). Claude Code then sends `initialize` offering 2025-11-25, and tries a GET for a stream.
- On 2026-07-28 it opens `subscriptions/listen` with `toolsListChanged: true` before its first `tools/list`, without being asked.
- A tool that appears after a re-list is usable in the same session: the model called it in the same turn.

## What this means for the brain

- **Today's `/mcp` is the one arrangement that leaves Claude Code stale.** It is 2025-era, has no session and offers no stream, so there is no channel and nothing to expire. This is read from the probe's copy of that wiring on SDK 2.4.0, not from the brain's own server, which is on 2.1.0.
- **`subscriptions/listen` is what works for Claude Code.** It refreshes at once on a notification, and it heals after a restart: the dropped stream is opened again and the list fetched again.
- **`ttlMs` alone does nothing for Claude Code 2.1.325.** It was the cheaper design, since it needs no open connection, but this client did not act on it in either run.
- **A 404 to a session id works on the 2025-era wire, at a cost.** The brain would have to issue session ids, the refresh waits for the client's next call, and the client initializes more than once on the way.

So for Claude Code the order is: serve 2026-07-28 (SMD-4345), then `subscriptions/listen` (SMD-4347). A `ttlMs` (SMD-4346) is still required by the revision, but it is not what refreshes this client.

## Not measured

| Client | Why not | What it needs |
| --- | --- | --- |
| Claude Desktop | A custom connector is added by URL and, as far as is known, reached from the vendor's servers, not from this machine. Not confirmed here. | The probe at a public HTTPS URL. |
| claude.ai custom connector | The same. | The same. |
| ChatGPT connector | The same. | The same. |
| Claude Code, interactive | Only headless runs were made, of one turn and of two. | A hand-driven session against the probe. |

The maintainer decided on 2026-11-14 not to put the probe at a public URL, so the three hosted clients stay unmeasured. The order above rests on Claude Code alone.

Also not measured: a `ttlMs` longer than 3 s or a wait longer than 51 s; whether Claude Code lists again on a timer when idle for minutes; the SDK's `listMaxPages` and paged lists.

The brain's request log cannot answer the first question for any client: it records neither the protocol version a request names nor the client's name. The probe's log did.

## How it was measured

A scratch MCP server on `@modelcontextprotocol/server` 2.4.0, bound to loopback, not the brain's: `evals/mcp-clients/probe.ts`. It served three paths:

- 2026-07-28 and stateless 2025-era traffic, through the SDK's `createMcpHandler`;
- 2025-era only, built per request with no session and POST only, as `mcp-server/app.ts` wires it;
- 2025-era only, with sessions and a GET stream.

It logged every request's HTTP method, MCP headers, JSON-RPC method, the revision named and the client's stated name and capabilities. A control route added or removed one tool, with or without telling anyone, forgot the sessions, or cut the listen streams.

Each run (`evals/mcp-clients/run-claude-code.sh`) was one headless Claude Code session that called a tool, called the control route itself, waited, then said whether the new tool was available and called it. The result in the table is read from the server's log, not from the model's report.

Before any run, the SDK's own client (2.4.0) proved each path (`evals/mcp-clients/selfcheck.ts`): in its default mode it negotiated 2025-11-25, and with `versionNegotiation: { mode: "auto" }` it negotiated 2026-07-28, kept a list inside its `ttlMs` without a request, and listed again on a notification.

A second script (`evals/mcp-clients/run-claude-code-turns.sh`) keeps one session open for two user turns and makes the change from outside between them, to see whether a new turn alone makes the client list again. It did not, on the 2026-07-28 path under a `ttlMs` of 3000 or on the stateless 2025-era path.

Each one-turn case was run once, except the `ttlMs` case, run twice. Each two-turn case was run once.
