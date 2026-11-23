# Listen streams on `/mcp`: the decision

SMD-4347. Proposed 2026-11-18 in the ticket's first PR; merging this page was the decision. Its second PR, 2a, built what a held stream needs with the capability still off: "As built in PR 2a" says what, and nothing is held yet.

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
- **The build.** The capability is one word. The rest is the stop, the stream's record and the caps: `mcp-server/app.ts` and `mcp-server/listen-streams.ts`; `mcp-server/index.ts`, `server-portable/shutdown.ts` and `server-portable/sse.ts`; the two suites; and the documents. `server-portable/telemetry.ts` is as it was ("As built", below). Reverting the capability is one word; the rest stays.

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

**3. How long the stack is away,** from the MCP server's going away to a keyed request being served: the table under "What it buys", and 5.6 and 5.8 seconds through `deploy/canary.sh`'s two commands with nothing to migrate. In one `up -d`, compose stops the REST core, then the MCP server, and starts both at the end, the migrator's run between: that order is what was seen on Compose 5.8, not what its documentation promises. No stack had a collector, whose flush at the stop comes before the streams are closed and so adds nothing to the client's wait, if the build closes them last. (As built, that is so of a stop whose drain finishes. One that cuts closes the streams before its flush, which then takes a second at most of the client's wait.)

## What the build must make true

This is what must hold, not how to wire it. Three reviews each found a draft's wiring of the stop wrong in a new way, by building it; the wiring is the build's to settle, against a real process. What they found is given with each rule, as what the build already knows will bite.

**The capability.** The 2026-07-28 server declares `tools.listChanged: true`. The 2025-era server is unchanged.

**The stop.**

- A stop with nothing in flight but listen streams ends inside its bound and exits 0. Before the build, one open stream held the stop to its bound, 8 seconds, and ended it as a cut with exit 1: Bun's `stop()` waits for every response body.
- Every open stream is sent its closing frame before the process exits, also when a call is cut at the bound: there the frames go out at the bound. The stop gives the close 100 ms, and past it the streams still open are dropped, which its last line says. It gives the frames 100 ms more to leave before it closes the connections; where they were not seen to leave by then, its last line says that. **Amended in the build:** as merged the rule had no bound, and said the frames go out in the stop's last second. The frame is best effort inside those 200 ms; a stream dropped with none leaves its client the 7 seconds of a server that dies.
- The streams are closed as late as the stop can close them where its drain finished: after the other requests have drained and after the telemetry flush. The client's 12 seconds start when its stream ends, and whatever the stop does after that is spent from them. **Amended 2026-11-19, in the build's fourth review:** where the stop cuts, the streams are closed at the bound, before the flush. This rule first held there too, and it meant leaving every connection open through the flush for the app to cut by going silent; each of three reviews found another answer still leaving, and the fourth found the design. The flush after a cut is a second at most, which is what the client's window gives up, on a stop that has already cut a request.
- No connection is accepted after the signal, and no request is answered by a handler already closed. (Added in the build: an entry signalled before its first request has yet to learn its server, and its listener stays open, as it always has. What it is sent then is not served.)

Known to bite: the SDK handler's `close()` ends the streams with their frames, and also closes every 2026-07-28 call in flight and the handler itself. `pendingRequests` counts a held stream, and nothing says when only streams are left. `drainOnSignal` as it stood before the build ended every open record before its flush (`endOpen`), dropped every connection at the bound before the flush (`stop(true)`), and reached its exit before a frame written at the bound was sent: the last stream closed lost its frame every time, until the process waited a turn of the event loop before closing connections and before exiting, and the drain awaited that. That stop's cut marked a listen stream `cut` with the calls.

Found in the build, by its first run against a real process: closing the handler ends each 2026-07-28 call in flight as a 200 whose stream is empty and ends as a whole answer would, where the stop used to drop its connection, and with no warning for it.

**The record of a stream.**

- One line: `rpc` `subscriptions/listen`, `ok`, written when the stream opens, its `ms` the time to open it. The request is answered once its stream is open, and its record ends there. Its end writes nothing. (**Amended by SMD-4459:** its end writes a record of its own, which is no request's: "The end of a stream", below.)
- It is no failure. Before the build the route would have ended a held stream's record as `stalled` after 10 minutes, with a warning to look at the database; a client closing its stream was `abandoned`, with a warning that a capture may have landed; and the stop's was `cut`. `stalled` and `cut` are among the outcomes the `ob1-server-failures` alert counts: three sessions listening again after one restart would put three failures on a quiet brain ten minutes later.
- Its sample in `http.server.request.duration`, which the dashboard's p50 and p99 panels read, is the time to open it: a request's, not a stream's hours.
- An open stream shows somewhere: its line and its span as it opens, sent with the next batch, and the stop's two lines, which count the streams it found open and say whether they were closed. (Added by SMD-4458: and while it is open it is counted, on keyed `/health` and in a metric of the total.)

This rule was first written as one line at the stream's end, its `ms` its lifetime, and no sample. "As built" says why the build wrote the line at the open.

**The caps.**

- The server's cap is 256, not the SDK's 1,024.
- A cap for each caller's name, since the SDK's is the whole server's and one key filled it in a fraction of a second, in a reviewer's test: 32. One name is every session of one key, so the number is sessions, not clients.
- A stream refused at either cap is `refused` on its line, with a code that says which: `LISTEN_SERVER_FULL` or `LISTEN_CALLER_FULL`. The two are mended differently. The SDK's own refusal is a 200 whose line reads `ok`.
- Both are counted by the route, which knows a listen by its `Mcp-Method` header: the handler serves none that header does not name. The SDK's own bound, 1,024 as it comes, is set to the server's too.
- A caller's name is its key's name; for a token it is its subject and its client together, so one person signed in through eight clients has eight names, and could fill the server's 256.

Both numbers are a first guess, to be set against the sessions a key really holds.

Amended in the build: as merged the rule set the server's cap where the handler is built, and named one code. The last two bullets and the second code are the build's.

**The documents.**

- Upgrading: the migrator first, then the servers, where the steps now say one `up -d`.
- Editing keys: what a scope edit needs for connected clients to see it. Four places give a command that replaces the REST core alone (`deploy/README.md`, `deploy/.env.example`, `deploy/orchestration/provision.ts`'s own words, `scripts/agent-runner/README.md`), and two say `up -d` recreates both servers, which it does not (`docs/01-getting-started.md`, `primitives/remote-mcp/README.md`).
- A tunnel or TLS proxy in front (`SETUP.md`, `docs/01-getting-started.md`): it must carry an event stream without buffering or cutting it, and the quick tunnel does not.
- The statements that no stream is held: the comment above `buildServer`, `docs/mcp-sdk-v2-migration.md`, `mcp-server/README.md`, the rows in `test-mcp.ts` [9b].
- What the operator is told of a line, which is true today and false of a held stream (found by a reader on the operator's side, in the build's third review):
  - `deploy/README.md`, "What the servers log": a stream's line "at the stream's end"; `ms` "to its end"; what `stalled`, `abandoned` and `cut` mean; where a `code` comes from (the two new ones are named there since SMD-4458).
  - The p50 panel's description in `deploy/observability/dashboard.json` and its copy in `deploy/compose.yaml`; the histogram's own description and the `ms` field's in `server-portable/telemetry.ts`.
  - `mcp-server/README.md` on the stop ("waits for Bun's requests in flight … then cuts what is left"), and `deploy/README.md` on the flush's bound, which after a drain that finished is 0.2 s shorter on a server that holds streams.
- `server-portable/telemetry.ts`'s own account of `cut` ("the server's stop closed it while its client was still there"): on a server that holds streams it is also a request that arrived after the drain had ended and was never served.
- The suite's preload, `mcp-server/test-listen-on.ts`, which turns on a line that will then say `true`, and the rows that hold "today's entry" to holding none: each needs its reverse, or goes. Among them since SMD-4459: [8h]'s "of a listen it answers and ends at once it says no end".
- That a restart of `mcp` is seen by every connected session, and that five in an hour may park a client for hours: `deploy/README.md` says both since SMD-4458, in its paragraphs on the count of open streams, and nowhere beside a command that restarts it. Those commands are in `plugins/example/README.md` and `deploy/README.md`. The four paragraphs were written with no stream held by a real client: read them again against one.
- What SMD-4458 wrote of the count while no server held a stream: "none yet" and "none does yet" in `deploy/README.md` (a line's `code`, and the paragraph on the count), "none does until" in `mcp-server/README.md`; its rows for today's entry, which fail by themselves the day it holds streams (`test-mcp.ts` [8h]'s "no count of listen streams" and [9c]'s "as the entry is today"), with the README's line for them; the dashboard panel's own description ("as none does yet", and what its 0 and its no data mean, in `deploy/observability/dashboard.json` and its copy in `deploy/compose.yaml`), `deploy/README.md`'s two accounts of that panel and its series ("none does until", "none does yet", and the same reading of 0 and no data) and the workflow's comment on the panel; and `db/brain-compare.ts`'s comment on what keyed `/health` carries beside the record, which then holds `listen` too.
- The dashboard step in `.github/workflows/brain-checks.yml` ("The observability profile's dashboard reads every series it names") passes the listen streams' panel on the 0 its own query makes, since no server there sends the series. Open a listen in that step's traffic: until then no running stack on CI holds the count's name, which check 37 holds from the code, and nothing holds its sum, or more of a matcher's value than that a variable in it is one the dashboard has. A holding server then always sends the series, so take the panel's `or vector(0)` out, and the witness with it, which then does nothing: the step then asks the panel for a number above 0, as it asks every query with no 0 of its own (were the 0 kept, the panel's row would have to be made required, as the store's refusals are); 0 is then a server's own word; and a count that stops arriving shows as no data where today, under All, it reads the same 0 as none open. And measure an upgrade that changes the dashboard, with the profile on: its one `up -d` recreates `lgtm` and `mcp` with nothing ordering them, so the old server's last export may meet no collector and its count stand for five minutes beside the new one's.
- The workflow's own reading of the MCP server's stop: `.github/workflows/brain-checks.yml` matches its last line whole, and a stream open at that stop adds to it.

**The path.** A held stream is never idle on the wire: the SDK writes a comment on it every 15 seconds, under the proxy's idle limit of 180. No stream has been held through the stack's own forwarder and proxy: every one measured ran from the client to the probe on loopback, for about a minute at most.

**A stream that outlives its credential.** A key can be revoked, and a token can expire, while a stream opened under it stays open until the next restart. Nothing but keepalives is ever sent on it. This is accepted.

## The cuts

1. **PR 1.** The measurements, the probe's modes, this page. Nothing served changes.
2. **PR 2a: the server can hold a stream, and does not yet.** The stop, the record, the caps, with the capability still `false`. Its tests need a held stream, so the suite turns the capability on for itself, with no switch an operator could set. "As built" says how, and that where the capability is off the stop is as it was.
3. **PR 2b: it holds them.** The capability, the documents, and the real client against a scratch stack through each row of the table under "What it buys". Decided 2026-11-19, after 2a's reviews: not before a running server can say how many streams it holds (SMD-4458) and a stream's end is recorded (SMD-4459). Both are built. Decided 2026-11-21: nor before SMD-4493, a stream nobody reads keeping its place.

## As built in PR 2a

What the build settled, against a real process, and where it left the rules above. Six reviews changed several of these, the fourth of them the stop's design; they are given as they now are, and the ticket's record says what each review found.

- **The switch.** One constant, `HOLD_LISTEN_STREAMS = false`, in `mcp-server/listen-streams.ts`, read by the entry alone. No setting turns it on. The suite's own apps are given their streams; its spawned entry is started with a preload, `mcp-server/test-listen-on.ts`, that loads that one module with the one word changed, and fails to start if the line is not there to change. PR 2b changes the word.
- **Inert where it is off.** The stop is given its new steps only by a server that holds streams, and an app that holds none has neither of the two gates below. With the capability `false` the entry stops as it did. Rows hold it where the two differ: today's entry waits on a request whose headers were half sent at its signal, and serves it. The page first said 2a would not be inert.
- **The line at the open.** A stream's record ends when its stream opens: `ok`, its `ms` the time to open it. The rule as first written, one line at the end with the stream's lifetime, set the stop against itself: a record still open at the stop must be ended before the flush or it is never sent, and the stream, where the drain finishes, must be closed after the flush. Ended at the open, the record is sent with the next batch like any request's, the stop has nothing of the stream to end or to cut, and `server-portable/telemetry.ts` needs no change. The cost: nothing records when a stream ended or how long it was held. A client that asks again writes a new line.
- **The stop,** for a server that holds streams (`server-portable/shutdown.ts` has it in its own words):
  1. It stops accepting, and waits for the requests and the tool calls, looked at together. The streams are not counted. Neither is a connection with no whole request on it yet, which Bun's own end would wait on to the bound: one whose headers were half sent at the signal, and on macOS one opened and never used (Linux closes that one at the signal; both measured).
  2. The drain's end, finished or cut, is told to the app in the turn that decides it, whether or not the entry had a server yet. What arrives after it is not served and not answered: its line is `cut`, and its connection goes with the process.
  3. Where the drain finished: the open records are ended, the telemetry flushed and the pool closed, as ever; then the streams are closed through the handler, their answers waited on to have ended, and every connection closed.
  4. Where it was cut: the streams are closed at the bound, the same way, and then every connection, as a server that holds none closes its own there; then the flush and the pool.
  5. Closing the streams takes a few milliseconds. Its two waits are bounded at 100 ms each. After a finished drain they are kept back from what the grace period leaves the flush, so the latest the stop can end is as it was at a grace of 2 s or more; a stop whose flush ends early, or runs out its own budget of 5 s, or is cut short by a second signal, can end up to 0.2 s later than it would have. At a grace of 1 s the latest is 0.95 s where it was 0.75. The last line says what became of the streams: closed; closed, but not seen to leave in time; or how many were not closed, why, and that they were dropped with their connections. It says nothing of streams where none is left by then, their clients gone. A server that could hold streams and holds none as its drain ends closes nothing, keeps nothing back from its flush, and at a cut closes its connections in the bound's own turn. Steps 1 and 2 are still its own: its drain is the one that looks, so a connection with no whole request on it does not hold it to its bound, and nothing that arrives after its drain is served.
- **The moment between the handler's close and the connections'.** The SDK gives one way to end the streams with their frames, its handler's `close()`, and that ends every 2026-07-28 call in flight too, as an answer of nothing that ends whole. So from the cut a tool call's answer goes no further and does not end, and no request at `/mcp` is begun: its connection's close, milliseconds on, is its end, as a cut call's always was. That is all the app does at a cut.
- **What that changes for other requests, against a server that holds none.** A connection with no whole request on it no longer holds the stop to its bound. A request made whole on such a connection after the drain has ended is dropped, where a server that holds none would still be waiting on that connection and would serve it. And at a cut the connections are closed a few milliseconds after the bound (200 ms at the most), not in the same turn. Measured, 2 to 3 ms with up to 24 streams (a millisecond or so where a 2026-07-28 call is cut beside them) and 6 to 16 ms with 256. An answer other than a tool call's that is ready in them still leaves, under a line that says `cut` with a status of 0: a job poll's, or the 500 of a request under which the REST core went away in that same moment, as at a whole stack's stop, with its line on stderr. And where a collector does not answer, the flush takes its second after the streams have closed: the client's attempt at 8 seconds can then miss, and the one at 12 is its last.
- **What the stop waits on after closing the streams.** Measured on the entry. With the exit straight after the close, a stream's closing frame was lost. With every connection closed straight after it, the frame was lost again where the drain had finished, a reset in its place. Waiting for the streams' answers to have ended, which the runtime's count of requests says, lost none, with one stream and with 24, on macOS, in a Linux container (`oven/bun:1.4.3`) and on CI's own runner; and with 256 beside 256 other requests ending around the bound, on macOS and in the Linux container (21 runs there: job polls answered, clients leaving, the REST core gone, calls cut). That count is of every request, and moves for others in the wait. It falls for a cut request that ends then, so the wait also holds while the app still counts a stream. It rises for a request made whole then on a connection the runtime kept, which is never answered: the wait runs out its 100 ms and the last line says the frames were not seen to leave, though each was read (found by the sixth review, after a finished drain, with one such request made whole in the 2 ms that wait takes). What the wait costs, measured on macOS: after a finished drain the count has not fallen when the stop first looks and has when it looks again, 2 ms on; with a 2026-07-28 call cut beside the streams it has fallen by the first look.
- **The caps** are the route's count, by caller name and for the server, of the requests whose header names the method. The handler's own `maxSubscriptions` is set to the server's bound as well. It was taken out once, since no row could tell the two apart, and put back after the reviews: a listen the route's count missed (its body behind two byte-order marks) and a stream a throw left in the handler each ran into nothing before the handler's 1,024. Both were mended at their cause. The second bound is what such a stream would run into now. No row reaches it while the route's count is right; the row for a stream left by a throw sees that stream only through it.
- **A held stream keeps nothing of its request.** The route's own listener on the request is taken off once the stream is held. Left on, each stream kept its request's body: 30 streams opened with 3 MiB bodies kept 90 MiB.
- **Not built in 2a:** the capability, the documents, and anything from "To measure in the build". And two things an operator will want once streams are held, each its own change, and each to land before PR 2b:
  - A count of open streams on a running server, in all and by caller's name (SMD-4458). In 2a only the stop's lines counted them, and a refusal at a bound had nothing to be read against. Built since, in that ticket's first PR: keyed `/health` has `listen` (how many are open, the two bounds, each caller's count), shown to whoever may read the record, and the server sends the total as a metric, `ob1.mcp.listen_streams`, which reads 0 at a stop's flush. Its second PR put that total on the observability profile's dashboard, as "Listen streams open" in the Requests row.
  - The end of a stream (SMD-4459). Nothing recorded it, so a stream that kept dropping read as healthy traffic: each reopening an `ok` line of a millisecond or two under its key's name. Built since: "The end of a stream", below.
- **Left as it is:**
  - A request whose header names the method, from a caller at its bound, is refused at the bound whatever else is wrong with it, where the handler would answer 400, 413 or 415; and a notification the route cannot read is answered there as a request.
  - A request dropped after the drain's end is written `cut` with no caller's name: its key was never checked. That line is on stdout alone: its record is made after the drain's end, which can be during the flush or after it, so its span and metric may never be sent, and the stop's own lines say nothing of it. `cut` so means two things: closed at the bound, and never served after the drain.
  - A path that holds an encoded line break, carriage return or line separator never reaches the app's first middleware, and is still answered its 405 after the drain's end. So is what the runtime answers by itself: `100 Continue`, and a 400 for a header it cannot read.
  - A listen whose client goes before its stream opens is written `abandoned`, with the warning any abandoned request gets, that a capture may have landed.
  - The stop's last line says the streams were closed when the app's count of them has reached zero and the runtime's has fallen by as many. The runtime's count is of every request: it can fall for another's end, and rise for a request that arrives in the wait, which makes the line say "not seen to leave" of frames that left (SMD-4462).
  - A stop that drops streams without their frames exits 0, as one whose pool did not close in time does: the exit code says whether a request was cut.
- **The first design, and why it went.** Until the fourth review the stop closed the streams after the flush on a cut too. No connection was closed at the bound, and the app cut in the stop's place: a gate in its first middleware, another in the function that says a fault, a rule for a stream opening at the cut, the same option on the job stream. Each review found an answer that still got out, or a line that said what had not happened. Closing the connections is what a cut is; with that back, those are gone.

## The end of a stream

SMD-4459, decided by the maintainer on 2026-11-21 and built in one PR, with the capability still off.

- **What records it.** A line of its own where the request lines go, `{"door":"mcp","event":"listen_end","agent":…,"end":…,"held_ms":…,"trace":…}`; where telemetry is sent, a log record named `ob1.listen_end` with the same fields, and one point on `ob1.mcp.listen_stream.duration`, a histogram of the seconds held, labelled by how the stream ended. `deploy/README.md` has the operator's account.
- **It is no request's.** The line has no `outcome`, `method` or `status`. No point goes on `http.server.request.duration`, and nothing the `ob1-server-failures` alert counts. The stream's request keeps its one line and its one span, ended as the stream opened.
- **Nothing is held open for it.** The record is written whole at the end, and there is none between the opening's and the end's, so no record of a stream is open for the stop to end or to cut.
- **Three kinds of end.** `client`: the client's side went. `stop`: the server's stop closed it. `server`: the server ended it itself, as it does a listen that asks for nothing this server sends.
- **A dropped connection and a client's close are one kind.** The ticket asked that they be told apart. They cannot be at this server: a request aborted, its reader's cancel, the client's exit, its kill, and a socket half-closed, destroyed or reset each reach the request as "The connection was closed", and only the server's own close differs (measured on Bun 1.4.3, on macOS and in a Linux container, on loopback, each once; a client frozen for 2 s was seen only when it was killed). Whether the proxy's access log tells the two apart was not measured.
- **The stop.** As its drain ends, finished or cut, each stream still open is recorded as the stop's: before the flush, so the record is sent. Where the drain finished, the stream is closed after that flush, and its time held, which is to the drain's end, is short of the real close by the flush; at a cut the stream is closed at the bound, before the flush. The close then records nothing more, and neither does a client that leaves in between: its stream's end is the stop's already. A stream keeps its place until it is closed, since the stop counts the streams by their places.
- **Where it is made.** `server-portable/telemetry.ts`, which PR 2a left unchanged, has the record (`endListenStream`). The route makes each stream's end outside the request's scope, so a held stream still keeps nothing of its request. A stream is in a set until its end is said, which is what says each end once; the app says that set's size (`listen.unsaid`), and rows hold it to the streams open after each kind of end, so that one whose end was said is not kept.
- **Not built.** A panel of ends on the dashboard, which waits for real streams. One that groups or matches on `ob1_end` needs the label added to check 37's table (`DASHBOARD_INSTRUMENT_LABELS`), which refuses it until then; and the histogram's name on the profile's image is to be measured with it, with whether a rate reads anything of a `stop` series, whose only export is its process's last. And nothing for a server that is killed, which records no end.

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
- A stream's end through the stack's proxy, with the real client (SMD-4459): that its client's leaving reaches the server at all, and how soon, which is what an end's `held_ms` means there. Every end measured so far was direct to the server on loopback. Where a leaving does not reach the server and the client asks again, a caller climbs to its bound with no end written (seen with a relay, in SMD-4459's third review): `deploy/README.md` gives both pictures, and this measurement says which is the stack's.
- What Claude Code does with a refusal at a cap, and whether a refused attempt counts toward five reopens an hour.

## Verify, for the build

In 2a (this list rewritten in the build, to the rules as amended above), with the suite's own switch, each held by a row of `mcp-server/test-mcp.ts` ([8h] against the entry in a process of its own, [9c] in process) or of `server-portable/test-server.ts` ([13d] on a stand-in server, [17] for the stream wrapper), on macOS, in a Linux container and on CI's runner:

- A stop with a listen stream open and nothing else exits 0 inside its bound; the stream's client reads its closing frame; the log has one line for it, `ok`. No collector.
- A stop with a stream open and a call in flight waits for the call, which is answered in full, then closes the stream. With a collector: the stream's span is sent by the stop's end.
- A stop with 24 streams open and a call of each revision cut at the bound: each call's line is `cut` and its client gets nothing, each stream's line is `ok` and its closing frame read, exit 1. With a collector.
- A stop whose collector never answers. Where the drain finished, the streams are closed after the flush has run out its bound of 1.8 s, not before. Where it was cut, they are closed at the bound, before the flush, and a call and a job poll whose work ends 300 ms on are not answered.
- A connection attempted after the signal is refused. A request whose headers were half sent at the signal, made whole after the drain has ended, is not served, and not answered 500 by a handler already closed. An entry signalled before its first request serves nothing sent it after.
- A stream held past the stall bound, shortened for the test, is not `stalled`; one its client closed is not `abandoned`; its line is written as it opens, its `ms` the time to open it.
- A tool call cut by the stop: nothing more of its answer goes out, and it does not end; a request not yet at its transport is not begun.
- The stream past each cap is refused, and its line says which; a listen the route cannot read and the handler can is counted like any other.
- A listen made whole during the drain of an entry that held none at its signal is held, and closed with its frame once the drain ends, which it does with the call it waited on.
- Today's entry, which holds none, cuts as it did and waits on a half-sent request as it did; and an app that holds none has neither of the stop's gates.

In 2b, a Claude Code session connected to a scratch stack, with no reconnect in any:

- It lists again, and can call the new tool, after `OB1_PLUGINS` gains a plugin and the servers are brought up as `plugins/example/README.md` says. The ticket's Verify says "a plugin enabled on a running stack"; a plugin is enabled by a restart, and this is met by the restart.
- It lists again after an upgrade done as the documents then say, with a migration that takes longer than the client's window.
- It lists again after its key's scope is edited and `mcp` recreated as the documents then say.
- With the capability set back to `false`, each of the three fails.
