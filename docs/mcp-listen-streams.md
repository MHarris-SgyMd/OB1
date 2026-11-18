# Listen streams on `/mcp`: the decision

SMD-4347. Proposed 2026-11-18 in the ticket's first PR; merging this page is the decision. Nothing here is built yet.

## The question

A client keeps the tool list it fetched when it connected. When the list changes, the user reconnects by hand. The 2026-07-28 MCP revision has a push for this: the client opens `subscriptions/listen`, a POST whose answer is a stream that stays open, and the server sends `notifications/tools/list_changed` on it.

The brain's MCP server has never held a connection open. Should it hold these, and what must it then get right?

## Decision

**Go: hold the streams, and send no notification on them.**

- The MCP server declares `tools.listChanged: true` on 2026-07-28 and keeps each `subscriptions/listen` stream open.
- **A restart of the MCP server ends every stream**, its stop with the stream's closing frame. A connected Claude Code asks for its stream again, and lists again when it gets one.
- **That is the whole mechanism.** It works for a change that replaces the MCP server and has it back in time: a plugin being enabled, and an upgrade whose migrator is run before the servers are replaced. For a key's scope, which replaces the REST core and leaves the MCP server running, the operator recreates `mcp` after it, with one more command, or the client is reconnected by hand as now.

Not built: a notification, and anything that makes a scope edit restart the MCP server by itself. Both were tried on paper or on a stack, and each cost more than the edit is worth; "Considered and not taken" has them.

The alternative is to change nothing: a session reconnects by hand, as now.

## What it buys

A connected Claude Code session lists again with no reconnect, if the MCP server is back within 12 seconds of its stream's end:

| The change | The MCP server away | Fits? |
| --- | --- | --- |
| A plugin enabled, as its README says | 6.9 s | Yes |
| An upgrade, the migrator run first, as `deploy/canary.sh` runs it | 7.3 s | Yes |
| An upgrade in one `up -d`, with a migration that takes 15 s | 25.8 s | No: the migrator runs while the MCP server is away. With nothing to migrate, 6.6 s |
| A key's scope edited, `up -d` | Not away at all | No: nothing ends the streams |
| The same, and `mcp` recreated after it | 5.6 to 6.6 s | Yes |

One machine, an idle stack. The attempt that lands is the client's second, at 8 seconds, with a second or less to spare.

## What it does not fix

- **An outage longer than 12 seconds behind the proxy.** The client stops asking and stays as stale as it is today. That includes an upgrade in one `up -d` whose migration takes more than a few seconds.
- **A key's scope edit, unless the operator recreates `mcp`.**
- **A server that dies.** The client's window is then 7 seconds. No death was timed; the stack's orderly restarts took nearly that.
- **A tool call made during a restart.** It fails as it does today, for about twice as long as the MCP server is away, the REST core being replaced first.
- **2025-era clients,** which have no stream on a server that keeps no sessions.
- **Clients not measured:** Claude Desktop, the claude.ai connector, the ChatGPT connector (SMD-4376). Where one of those speaks 2026-07-28, declaring `true` changes what it is told, with no run of any.
- **A client behind the quick tunnel `docs/01-getting-started.md` recommends.** Its vendor's page says: "Quick Tunnels do not support Server-Sent Events (SSE)." What a client does with a listen that is never answered through one was not run.

`ttlMs` (SMD-4346) stays its own ticket. Claude Code ignored it in three runs.

## What it costs, against today

- **A session that cannot reach the server finds out.** Today it does not: an idle session through a closed port sends nothing, and its tools are served when the path is back. With a stream held, the client sees the stream go and tries to reconnect. In the one interactive run, of a port closed for 60 seconds, the next turn began with the model saying the server had failed to connect; its tool call then reconnected and was served, with a fresh list and nothing done by hand. A model that believes the brain is away may not try the call. A stack reached on its own machine closes its port whenever it is taken down. A laptop waking or a tunnel dropping may be the same from the client's side; neither was run.
- **Past what was watched.** The client's documentation gives a dropped server five reconnects, a second apart and doubling, after which an interactive session marks it failed and it can be reconnected from `/mcp`. The 60-second run was past that, and recovered at its next call. It also says a `claude -p` run stops retrying after about half an hour. The longest closure run was 180 seconds.
- **Several restarts in an hour.** The documentation says that after five reopens in an hour the client waits about six hours. Not measured. Work on a plugin against a scratch stack will meet it, and so will a tunnel that cuts streams.
- **The proxy's own stop.** Its documented grace for requests in flight is 10 seconds. A stream never ends, so replacing the proxy by itself would wait that out and then drop the streams with no closing frame. Not run.
- **The vendor's switch.** The documentation says a flag the client fetches can keep a server off the stream, and that the stream exists only on the client's newer runtime.
- **The build.** The capability is one word. The rest is the stop, the stream's record and the caps: `mcp-server/app.ts`; `mcp-server/index.ts` and `server-portable/shutdown.ts`, or a wrapper beside it; `server-portable/telemetry.ts`; the two suites; and the documents. Reverting the capability is one word; the rest stays.

## What the answer rests on

`docs/mcp-client-refresh.md`, "A restart, measured 2026-11-18 (SMD-4347)", has the runs: 18 of Claude Code 2.1.327, two of them interactive, and 16 timed restarts of a scratch stack. Each case ran once, but a few.

**1. What changes a tool list, and what each change replaces.**

| What changes the list | Where it is read | What is replaced | Measured |
| --- | --- | --- | --- |
| The tools the release has | The image | Both servers | |
| The enabled plugins | `OB1_PLUGINS`, in both servers' environments, loaded once | Both servers | 49 tools, then 52 |
| A key's scope | `MCP_ACCESS_KEYS`, which the MCP server does not carry (`deploy/compose.yaml`) | The REST core. **Not the MCP server** | 49 tools, then 24; the `mcp` container the same one |

A key revoked in the registry is refused everything while the servers run, which is no change of list. A token traded at the authorization server carries its own scope. Nothing else was found.

**2. What Claude Code does when its stream ends.**

- Ended with the SDK's closing frame: it asks again 6, 8 and 12 seconds later. Dropped with none: at about 1, 3 and 7.
- A stream opened: it lists at once.
- Three refusals, 502s or the edge's busy answer: it stops, and did not ask again while watched (160 and 70 seconds, a new turn in each). Its tool calls are served, on the old list.
- The port closed: it connects again from the start, by itself after 20 and 60 seconds, at its next tool call after 180.
- No stream held, as today: it sends nothing through an outage of either kind.

**3. How long the stack is away,** from the MCP server's going away to a keyed request being served: the table under "What it buys", and 5.6 and 5.8 seconds through `deploy/canary.sh`'s two commands with nothing to migrate. In one `up -d`, compose stops the REST core, then the MCP server, and starts both at the end, the migrator's run between: that order is what was seen on Compose 5.8, not what its documentation promises. No stack had a collector, whose flush at the stop comes before the streams are closed and so adds nothing to the client's wait, if the build closes them last.

## What the build must make true

This is what must hold, not how to wire it. Three reviews each found a draft's wiring of the stop wrong in a new way, by building it; the wiring is the build's to settle, against a real process. What they found is given with each rule, as what the build already knows will bite.

**The capability.** The 2026-07-28 server declares `tools.listChanged: true`. The 2025-era server is unchanged.

**The stop.**

- A stop with nothing in flight but listen streams ends inside its bound and exits 0. Today one open stream holds the stop to its bound, 8 seconds, and ends it as a cut with exit 1: Bun's `stop()` waits for every response body.
- Every open stream is sent its closing frame before the process exits, also when a call is cut at the bound. There the frames go out in the stop's last second.
- The streams are closed as late as the stop can close them: after the other requests have drained and after the telemetry flush. The client's 12 seconds start when its stream ends, and whatever the stop does after that is spent from them.
- No connection is accepted after the signal, and no request is answered by a handler already closed.

Known to bite: the SDK handler's `close()` ends the streams with their frames, and also closes every 2026-07-28 call in flight and the handler itself. `pendingRequests` counts a held stream, and nothing says when only streams are left. `drainOnSignal` as it stands ends every open record before its flush (`endOpen`), drops every connection at the bound before the flush (`stop(true)`), and reaches its exit before a frame written at the bound is sent: the last stream closed lost its frame every time, until the process waited a turn of the event loop before closing connections and before exiting, and the drain awaited that. Today's cut marks a listen stream `cut` with the calls.

**The record of a stream.**

- One line: `rpc` `subscriptions/listen`, `ok` when its client closed it or the stop took it to close. A stream the stop closes has its record ended with the stop's other records, before the flush, or its line and span are never sent; so its `ms` runs to that moment, not to the frame.
- It is no failure. Today the route would end a held stream's record as `stalled` after 10 minutes, with a warning to look at the database; a client closing its stream is `abandoned`, with a warning that a capture may have landed; and the stop's is `cut`. `stalled` and `cut` are among the outcomes the `ob1-server-failures` alert counts: three sessions listening again after one restart would put three failures on a quiet brain ten minutes later.
- It is not a sample in `http.server.request.duration`, which the dashboard's p50 and p99 panels read.
- An open stream shows somewhere. With one line at its end and no sample, it would show nowhere; and its span, begun at arrival, would be exported hours later. The build says where a stream shows and what its span is.

**The caps.**

- The server's cap is set where the handler is built, not left to the SDK's 1,024: 256.
- A cap for each caller's name, counted by the route, since the SDK's is the whole server's and one key filled it in a fraction of a second, in a reviewer's test: 32. One name is every session of one key, so the number is sessions, not clients.
- A stream refused at either cap is `refused` on its line, with a code. Today the SDK's refusal is a 200 whose line reads `ok`.

Both numbers are a first guess, to be set against the sessions a key really holds.

**The documents.**

- Upgrading: the migrator first, then the servers, where the steps now say one `up -d`.
- Editing keys: what a scope edit needs for connected clients to see it. Four places give a command that replaces the REST core alone (`deploy/README.md`, `deploy/.env.example`, `deploy/orchestration/provision.ts`'s own words, `scripts/agent-runner/README.md`), and two say `up -d` recreates both servers, which it does not (`docs/01-getting-started.md`, `primitives/remote-mcp/README.md`).
- A tunnel or TLS proxy in front (`SETUP.md`, `docs/01-getting-started.md`): it must carry an event stream without buffering or cutting it, and the quick tunnel does not.
- The statements that no stream is held: the comment above `buildServer`, `docs/mcp-sdk-v2-migration.md`, `mcp-server/README.md`, the rows in `test-mcp.ts` [9b].

**The path.** A held stream is never idle on the wire: the SDK writes a comment on it every 15 seconds, under the proxy's idle limit of 180. No stream has been held through the stack's own forwarder and proxy: every one measured ran from the client to the probe on loopback, for about a minute at most.

**A stream that outlives its credential.** A key can be revoked, and a token can expire, while a stream opened under it stays open until the next restart. Nothing but keepalives is ever sent on it. This is accepted.

## The cuts

1. **PR 1, this one.** The measurements, the probe's modes, this page. Nothing served changes.
2. **PR 2a: the server can hold a stream, and does not yet.** The stop, the record, the caps, with the capability still `false`. Its tests need a held stream, so the suite turns the capability on for itself; how, without shipping a switch an operator could set, is 2a's first decision. It is not inert: the stop's new steps run on every stop.
3. **PR 2b: it holds them.** The capability, the documents, and the real client against a scratch stack through each row of the table under "What it buys".

## Considered and not taken

- **A notification for the scope edit,** published when the route sees a caller's tools differ from what it last saw. It needs a memory for each credential, bounded, and it loops when the memory is kept by name: two callers of one name and different scopes each look like a change to the other, and every listening client lists again, without end (prototyped).
- **A label on `mcp` that carries the key list,** as the proxy's `ob1.proxy-routes` label carries its routes, so that a key's edit replaces both servers in one `up -d`. Run, three times: the MCP server away 6.1 to 6.3 seconds, so it works. Not taken, for what it costs. A keyed request then fails for 11.5 seconds at a key edit, where it fails for 7.7 today. Every edit of the list, a key minted or a line reordered, ends every client's stream. The key list (names, scopes and digests, never a key) goes onto the `mcp` service, where `ps` and `events` show it, and the project holds that service to "no key list" by a consistency check and a CI rule. And it does nothing for the four documented commands that replace the REST core alone.
- **Restarting `mcp` whenever `api` is recreated** (`depends_on` with `restart: true`). Run, twice: compose stopped `mcp` first, then replaced `api`, then started `mcp`. The MCP server was away 11.3 and 11.5 seconds, nearly the client's whole window.
- **The proxy holding a request while the server restarts** (Traefik's `retry`). Not evaluated. As documented it does not retry a POST unless told to, and the MCP endpoint takes POST alone. It would help what this does not, a tool call during a restart, so it is worth its own look.
- **Ending each stream after a set time.** The client's five reopens an hour forbid anything short, and every planned end is another chance to lose the client.
- **A `tools/list_changed` when a stream is opened.** The client lists at every opening already.
- **Answering something other than 502 during a restart.** A closed port buys a longer retry, and the cost named above.

## To measure in the build

- An upgrade with a real migration, done the way the documents will say, and a stack with a collector, through the real client.
- A stream held for an hour through the forwarder, the proxy and a tunnel; and the proxy's own stop with one open.
- An interactive session through a closure longer than 60 seconds, with what its `/mcp` panel shows meanwhile; and a client whose own path drops.
- What Claude Code does with a refusal at a cap, and whether a refused attempt counts toward five reopens an hour.

## Verify, for the build

In 2a, with the suite's own switch:

- A stop with a listen stream open and nothing else exits 0 inside its bound; the stream's client reads its closing frame; the log has one line for it, `ok`.
- A stop with a stream open and a call in flight waits for the call, which is answered in full, then closes the stream.
- A stop with a stream open and a call cut at the bound: the call's line is `cut`, the stream's `ok`, its closing frame read, exit 1.
- The same three with a collector: the stream's line and span are exported, and its frame is read.
- A connection attempted after the signal is refused, not served and not answered 500.
- A stream held past the stall bound, shortened for the test, is not `stalled`; one its client closed is not `abandoned`; neither is a sample in the duration histogram.
- The stream past each cap is refused, and its line says so.

In 2b, a Claude Code session connected to a scratch stack, with no reconnect in any:

- It lists again, and can call the new tool, after `OB1_PLUGINS` gains a plugin and the servers are brought up as `plugins/example/README.md` says. The ticket's Verify says "a plugin enabled on a running stack"; a plugin is enabled by a restart, and this is met by the restart.
- It lists again after an upgrade done as the documents then say, with a migration that takes longer than the client's window.
- It lists again after its key's scope is edited and `mcp` recreated as the documents then say.
- With the capability set back to `false`, each of the three fails.
