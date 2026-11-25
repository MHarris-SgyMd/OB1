# What makes an MCP client fetch the tool list again

Measured 2026-11-14 (the logs' times are UTC, 2026-11-15) for SMD-4344. A record of what was measured on that date: a client's later release may behave differently.

## The question

A key's tool list changes without the client's doing: a plugin is enabled, a key's scope changes, a release adds a tool. A connected client keeps the list it fetched at connect, and the user reconnects by hand.

The MCP revisions offer several ways for a server to prompt a new `tools/list`. Which one works depends on the client. This page records, for each client measured, which revision it offers and which mechanism makes it list again.

## Result

One client is measured so far: Claude Code 2.1.325, headless (`claude -p`), on macOS.

| Server it meets | Revision used | What happens while it is connected | Lists again? |
| --- | --- | --- | --- |
| 2025-era, no session, POST only (the probe's copy of how the brain wires `/mcp` today) | 2025-11-25 | a tool is added; nothing can be sent | No. The new tool never appears, in the same turn or in a new one. |
| 2025-era, with a session and a GET stream | 2025-11-25 | a tool is added; `notifications/tools/list_changed` on the GET stream | Yes, 4 ms after the notification. |
| 2025-era, with a session | 2025-11-25 | the session is forgotten: 404 to its session id (no tool added) | Yes, at its next tool call: it initializes again, repeats the call, then lists. |
| 2026-07-28 | 2026-07-28 | a tool is added; `notifications/tools/list_changed` on its `subscriptions/listen` stream | Yes, 4 ms after the notification. |
| 2026-07-28 | 2026-07-28 | a tool is added; nothing sent; `tools/list` answered `ttlMs` 3000, then 2000 | No. No second `tools/list` in 13 s, nor in 51 s, each with a tool call after the wait; nor at the start of a new turn 10 s after the change. |
| 2026-07-28 | 2026-07-28 | a tool is added; every listen stream cut, nothing sent | Yes. It opens `subscriptions/listen` again 6 s after the cut and lists at once. |

What Claude Code 2.1.325 does at connect:

- It sends `server/discover` first, with the 2026-07-28 envelope. A server that answers it gets 2026-07-28 from then on.
- A 2025-era server answers that probe with an error (400 from the SDK's 2025-era transport). Claude Code then sends `initialize` offering 2025-11-25, and tries a GET for a stream.
- On 2026-07-28 it opens `subscriptions/listen` with `toolsListChanged: true` before its first `tools/list`, without being asked.
- A tool that appears after a re-list is usable in the same session: the model called it in the same turn.

## What this means for the brain

- **Today's `/mcp` leaves Claude Code stale.** It is 2025-era, has no session and offers no stream, so there is no channel and nothing to expire. This is read from the probe's copy of that wiring, on SDK 2.4.0 and again on 2.1.0, the brain's pin, with the same result. The brain's own server was not run.
- **Serving 2026-07-28 does not fix that by itself.** A 2026-07-28 server that sends no notification leaves Claude Code as stale as today's, whatever `ttlMs` it answers, until a listen stream happens to drop.
- **`subscriptions/listen` is what works for Claude Code.** It refreshes at once on a notification, and it heals after a restart: the dropped stream is opened again and the list fetched again. (A restart that leaves nothing serving was measured on 2026-11-18, below: behind a proxy it heals only if the server is back within 12 seconds of its stream's closing frame, or 7 of a stream that was dropped.)
- **`ttlMs` alone does nothing for Claude Code 2.1.325.** It was the cheaper design, since it needs no open connection, but this client did not act on it in any of three runs.
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

The brain's request log cannot answer the first question for any client: it records neither the protocol version a request names nor the client's name. The probe's log did. (Since SMD-4363 the line's `rev` records the revision a request names; the client's name is still not recorded.)

## How it was measured

A scratch MCP server on `@modelcontextprotocol/server` 2.4.0, bound to loopback, not the brain's: `evals/mcp-clients/probe.ts`. It served three paths:

- 2026-07-28 and stateless 2025-era traffic, through the SDK's `createMcpHandler`;
- 2025-era only, built per request with no session and POST only, as `mcp-server/app.ts` wires it;
- 2025-era only, with sessions and a GET stream.

It logged every request's HTTP method, MCP headers, JSON-RPC method, the revision named and the client's stated name and capabilities. A control route added or removed one tool, with or without telling anyone, forgot the sessions, or cut the listen streams.

Each run (`evals/mcp-clients/run-claude-code.sh`) was one headless Claude Code session that called a tool, called the control route itself, waited, then said whether the new tool was available and called it. The result in the table is read from the server's log, not from the model's report.

The SDK's own client (2.4.0) proves each path (`evals/mcp-clients/selfcheck.ts`; the first two paths before any Claude Code run, the stateless 2025-era path after its runs): in its default mode it negotiated 2025-11-25, and with `versionNegotiation: { mode: "auto" }` it negotiated 2026-07-28, kept a list inside its `ttlMs` without a request, and listed again on a notification.

A second script (`evals/mcp-clients/run-claude-code-turns.sh`) keeps one session open for two user turns and makes the change from outside between them, to see whether a new turn alone makes the client list again. It did not, on the 2026-07-28 path under a `ttlMs` of 3000 or on the stateless 2025-era path.

Each one-turn case was run once, except the `ttlMs` case, run twice. Each two-turn case was run once.

## A restart, measured 2026-11-18 (SMD-4347)

A dated addition. The table above is as it was written on 2026-11-14.

Its last row cut the listen streams with the server still serving. A restart is harder on a client: for some seconds nothing serves. This section records what Claude Code 2.1.327 on macOS does then, headless but where a row says interactive, and how long the brain's own stack is away when it restarts. The date is UTC: the first nine runs and the first three stack timings were made on the evening of 2026-11-17, local time.

### What the client does

The probe ended every listen stream, changed its tool set without saying so, and then for a number of seconds answered every MCP request as something that is not serving:

- **502**, as the stack's proxy answers while the server behind it is away;
- **busy**, as the brain's edge answers when the registry cannot be asked: HTTP 200, JSON-RPC -32003, `Retry-After: 2`;
- **500**, in plain text, as the brain's route answers when its key check throws;
- **the port closed**, as when the whole stack is down.

It ended each stream as the SDK's handler ends one at `close()`, with its closing frame, but in the row marked "dropped", where every connection was dropped where it stood, as by a server that dies.

Times are seconds from the end of the stream.

| Away for | Answered meanwhile | `subscriptions/listen` after its stream ended | Lists again? |
| --- | --- | --- | --- |
| 3 s | 502 | 6.0: opened | Yes, 3 ms later. |
| 7 s | 502 | 6.0: 502. 8.0: opened | Yes. |
| 11 s | 502 | 6.0, 8.0: 502. 12.0: opened | Yes. |
| 20 s, twice | 502 | 6.0, 8.0, 12.0: 502. None after | No. Its last request in the one run was 34 s after the server returned; in the other it was watched for 160 s, a new turn 130 s in. |
| 7 s, the stream dropped | 502 | 1.0, 3.0: 502. 7.0: opened | Yes. |
| 7 s | busy | 6.0: busy. 8.0: opened | Yes. |
| 20 s | busy | 6.0, 8.0, 12.0: busy. None after | No, in the 70 s after the server returned, a new turn among them. |
| 7 s | 500 | 6.0: 500. 8.0: opened | Yes. Run twice: once with this body, once with a JSON-RPC one. |
| 7 s | the port closed | 8.0: opened | Yes. |
| 20 s | the port closed | 25.8: `server/discover` again, then opened | Yes. |
| 60 s | the port closed | 64.4: `server/discover` again, then opened | Yes. |
| 180 s | the port closed | None in the 35 s after the port opened. At its next tool call, 217 s: `server/discover` again, then opened | Yes, at that call. |
| 60 s, an interactive session | the port closed | None while it sat idle, 52 s after the port opened. At its next tool call, 112 s: `server/discover` again, then opened | Yes, at that call. The turn began with the model saying that the harness reported the server as failed to connect (ECONNREFUSED); the `/mcp` panel after the turn showed the server with both tools. |

And with no stream held, the probe started `LISTEN=off` so that it declares `tools.listChanged: false` as the brain's server does today:

| Away for | Answered meanwhile | What the client sent | Lists again? |
| --- | --- | --- | --- |
| 20 s | 502 | Nothing, through the outage and the 40 s after it. At connect it had sent `server/discover` and `tools/list`, and no listen | No. Its next tool call was served, and no `tools/list` was sent. |
| 60 s | the port closed | Nothing, through the outage and the 40 s after it | No. The same. |
| 60 s, an interactive session | the port closed | Nothing, through the outage and the 50 s after it, until its next tool call | No. Its `/mcp` panel, opened 40 s after the port reopened and again after the turn, showed the server with one tool; the tool call was served, and no `tools/list` was sent. |

What that shows:

- **Three attempts, counted from the end of its stream, not from the server's return.** At 6, 8 and 12 seconds after a stream ended with its closing frame; at about 1, 3 and 7 after one that was dropped.
- **A 502, a busy answer and a 500 each use an attempt up.** Three 502s end it, and so do three busy answers.
- **One success is enough.** It lists at once, and the new tool is usable in the same session.
- **After three refusals it stops.** The server's return, time, its own tool calls and a new turn did not start it again while it was watched. Its tool calls are served, so the session looks healthy and holds an old list. A tool call answered 502 after it had stopped was not seen.
- **A closed port is treated differently.** It connects again from `server/discover`: by itself after 20 and after 60 seconds, headless, and at its next tool call after 180. The interactive session, after 60, did not while idle; its next turn began with the model saying the server had failed to connect, and its tool call reconnected and was served, with nothing done by hand. The harness's own message to the model is in neither log: this is the model's account of it. An attempt that met the closed port leaves nothing in the probe's log.
- **With no stream it notices nothing.** It sends no request through an outage of either kind, and keeps its list. In the interactive run its `/mcp` panel, first opened 40 seconds after the port was back, showed the server as it had been.

Its documentation (`https://code.claude.com/docs/en/mcp`, read 2026-11-18) names limits these runs could not reach: a reopened stream that closes again within 10 seconds is reopened "up to three times"; after "five reopens in an hour" it "waits about six hours"; a remote server that drops is reconnected "up to five times", after which an interactive session marks it failed and a `claude -p` run goes on without its tools, retrying for about half an hour. Every run here had one outage, and all but two were headless.

Two things were seen once and by accident, in runs that were spoiled and are not in the tables:

- **A session started while the server answered 502** sent `server/discover` and then `initialize` four times in 6 seconds, and did not try again in the 24 seconds left of the run.
- **A tool call made while the server was away** failed with the proxy's words ("Bad Gateway"), and was not sent again in the 3 seconds left of that run.

### The stack's own restart

How long is the brain away when its servers are replaced? On a scratch stack built from main 6aad356b (podman, macOS), two requests were sent through the stack's proxy every 100 ms: a keyless `tools/list`, which the MCP server answers by itself, and a keyed one, which needs the REST core's `whoami` as a re-listen does.

| Procedure | The MCP server away until a keyed request was served | Meanwhile |
| --- | --- | --- |
| `up -d --force-recreate --no-deps mcp`, three times (keyless requests only) | 6.62, 5.58, 5.90 s | 502 |
| `deploy/canary.sh`'s order: `api` recreated, then `mcp` at once, twice | 5.55, 5.84 s | 502 |
| A plugin enabled as `plugins/example/README.md` says: `up -d migrate api mcp` | 6.93 s | 502, then 500 for the last 0.3 s. 49 tools before, 52 after |
| An upgrade's shape: `up -d --force-recreate migrate api mcp app coordinator` | 6.60 s | 502, then 500 for the last 0.3 s |
| The same, the migrator made to take 15 s | 25.80 s | 502, then 500 for the last 0.5 s. The migrator ran while the MCP server was away |
| The 15-second migrator run by itself first, then the same `up` | 7.30 s | The servers served through the migrator's run. Then 502, and 500 for the last 0.5 s |
| A key's scope edited in the env file, write to read: `up -d` | Never away: the `mcp` container was not replaced | A keyed request was answered 500 for 7.7 s while the REST core was replaced. 49 tools before, 24 after |
| The same edit with `restart: true` on `mcp`'s `depends_on`, twice | 11.5, 11.3 s | 502, then 500 for the last 0.1 s. Compose stopped `mcp` before it replaced the REST core, so a keyed request failed for the same 11.5 and 11.3 s. 24 tools and 49 by turns |
| The same edit with a label on `mcp` that carries the key list, three times | 6.3, 6.1, 6.1 s | 502, then 500 for the last 0.2 s. The REST core was stopped first, a keyed request refused 500 for the 5 s before: 11.5, 11.3 and 11.5 s in all, where the edit costs 7.7 s as the stack stands. 49 tools and 24 by turns |

So in every procedure that replaces the MCP server but two, an attempt at 6 seconds may still be refused and those at 8 and 12 are served. With `restart: true` only the attempt at 12 would be, by half a second. With a migration that takes time, applied by the same `up`, none is: in one `up` compose stopped the REST core, then the MCP server, and started both at the end, the migrator's run between. And a key's scope, edited as the stack stands, changes a tool list without replacing the MCP server at all; with the label it replaces both.

A keyed request failed for longer than the MCP server was away, the REST core being replaced first: 12.6 and 12.3 seconds in the two canary-order runs (one request in the second was served between the two replacements), 14.0 with the plugin, 11.8 in the upgrade's shape. In the plugin's and the upgrade's runs the MCP server went on answering for 7 and 5 seconds after the REST core had stopped, and a keyed request was still refused for 0.3 seconds after its return.

`deploy/canary.sh` itself was not run: its two commands were, on a running stack. No run had a migration of the core's to apply; the plugin run applied the example plugin's own, if its README is right, and the 15-second migrator is the stack's own behind a wait. The slow migrator and the two rows after the scope edit were made with compose override files kept outside the tree: none of the three settings is in `deploy/compose.yaml`. The order compose replaces services in is what was seen on Compose 5.8; its documentation promises the replacing, not the order. Adding the label replaced `mcp` once, 6.1 s.

This is one machine and an idle stack, with no collector running.

### How, and what is thin

- The probe's controls `down/N`, `busy/N`, `fault/N`, `refuse/N` and `cut/N` and its `LISTEN=off` mode (`evals/mcp-clients/probe.ts`). `selfcheck.ts` holds, in each mode: what each of the five answers while it is away (the status or the closed port, and for `down`, `busy` and `fault` whether the body is plain text or a JSON-RPC error); that `down`, `busy` and `fault` last about what they were asked to, checked 1.5 s into two seconds and 0.3 s after; and that each changes the tool set. With a stream it also holds that each of the five ends a held stream as it should. It does not hold that the 2025-era sessions are forgotten. The 3-second run and one of the 20-second 502 runs were one-turn runs (`run-claude-code.sh`); the rest were two-turn runs (`run-claude-code-turns.sh`), the outage begun 30 s into the first turn's idle time and the second turn sent after it. The two interactive runs were driven through a terminal by an `expect` script, which also opened the `/mcp` panel before and after the second turn. In the run with a stream the first panel was not seen: the client had raised a dialog of its own, which took the keys, and one of them confirmed it. That script is not in the tree. Run against a stand-in client, it could still be made to press Enter on a dialog it had not read, and typing into a person's real session is not worth that: an interactive run is three things typed by hand, which the probe's header gives. Two further runs made while it was being mended, an interactive session whose stream was ended with the server still up, each asked again at 6.0 s and listed at once, as a headless one does.
- The probe was extended three times during the day. The 502 runs of 3, 7, 11 and 20 seconds and the closed-port runs of 7 and 20 were made before `busy`, `fault`, `cut` and `LISTEN=off` existed; what `down` and `refuse` do to a client did not change, though the 502's content type and the log's fields did.
- `cut/N` drops a stream with no closing frame. The 2026-11-14 table's row "every listen stream cut" used `drop`, which ends each with its frame: its 6 seconds is the first row's here. As it drops its connections `cut` closes its port and opens it again at once, and a connection made between the two is refused, where a proxy in front of a server that died would answer 502. A test client that connected the moment its stream dropped met that in 5 of 680 tries in one review's runs, and in 21 and 23 of 300 in another's (SMD-4493). The run in the row marked "dropped" has its first attempt 1.0 s after the drop, answered 502, which is when this client first asks after a reset with the port never closed (the last section): nothing suggests that it met the closed port, though an attempt the port refused would have left no line in the log.
- A one-turn run cannot wait long: the headless session refuses a long sleep in the foreground. `sleep 110` was not run at all; `sleep 50` the model ran in the background, and waited. A two-turn run waits outside the session.
- Twenty-two sessions in all: the eighteen in the tables, two of them interactive, each case once but the 20-second 502 and the 500; two spoiled; and the two made while the interactive script was being mended. Sixteen timed restarts of the stack. The 7-second busy run's script was edited while it ran and ended with a shell error after its second turn; the probe's log of the run is whole.
- Not measured: an outage between 12 and 20 seconds behind a 502; a closed port for longer than 60 seconds interactive, or 180 headless; what the `/mcp` panel shows while a server is held as failed; a client whose own path to the server drops; more than one outage in a session, and so the five reopens an hour (more than one end in a session was run since, and the five met: the last section); a stream held through the stack's forwarder and proxy, or one a proxy drops; the edge's 503 for a token while the authorization server is away; any other client; the brain's own server, which holds no stream yet. `docs/mcp-listen-streams.md` is the decision this was measured for.

## The server ending one stream and serving on, measured 2026-11-24 (SMD-4493)

A dated addition, for the gate of SMD-4493's second PR (`docs/mcp-listen-streams.md`, "A stream whose client or key is gone"). Every stream above was ended by the SDK's handler, which ends them all at once, or by a server that then was away. The brain is to end one caller's streams and go on serving, and may then refuse that caller. This records what Claude Code 2.1.331 on macOS does then: headless, each session a new process on the model `haiku`, two turns, on loopback to the probe, which has no keys and no tokens.

The probe holds each listen stream by what can end it alone, and ends it one of three ways, changing its tool set without saying so and going on serving:

- **clean:** the stream's request aborted on the server's side, so the body ends whole with no closing frame;
- **reset:** the stream's body errored, so the connection is reset;
- **frame:** a closing frame written by hand, the same bytes as the SDK's own, and then the body's end.

In each session of the two tables one stream was ended, once, 29 to 30 seconds after it opened, the session idle between its turns. Times are seconds from the probe's log line for the step, which it writes as the streams are ended.

| The stream was ended | Runs | `subscriptions/listen` after | Lists again? |
| --- | --- | --- | --- |
| by the SDK's own close, with its frame (the control) | 4 | 6.0: opened | Yes, in each. |
| clean | 3 | 1.0: opened | Yes, in each. |
| reset | 3 | 1.0: opened | Yes, in each. |
| frame | 3 | 6.0, 6.0 and 6.2: opened | Yes, in each. |

"Lists again" is a `tools/list` sent within 30 ms of the reopening and answered; and the second turn called the tool that only the new list has.

And with a refusal for the 40 seconds after the end, the probe serving again from then, the second turn 20 seconds later, and the session watched 50 seconds after the probe served again. In those 40 seconds the client sent its listens and nothing else, so what was refused, in every row, was a listen:

| The stream was ended | A listen was answered | Runs | `subscriptions/listen` after | Lists again? |
| --- | --- | --- | --- | --- |
| clean | as a revoked caller is: HTTP 200, JSON-RPC -32001 | 3 | 1.0, 3.0, 7.0: refused. None after | No. |
| frame | the same | 3 | 6.0, 8.0, 12.0: refused. None after | No. |
| clean | in the words for a key not known: the same shape | 3 | 1.0, 3.0, 7.0: refused. None after | No. |
| clean | as at a bound: HTTP 200, JSON-RPC -32603 | 3 | 1.0, 3.0, 7.0: refused. None after | No. |
| frame | the same | 3 | 6.0, 8.0, 12.0: refused. None after | No. |

"No" is no `tools/list` after the step. The probe then had a second tool, and the second turn called the first alone; in 15 of the 16 sessions whose listens were refused for 20 or 40 seconds, the model said the second was not available to it, and in the other that it had not checked.

Five further sessions, each once:

- **Five minutes after a refusal.** A listen refused as at a bound for 20 seconds after a clean end, then 280 seconds of serving, then a second turn. After its three refused attempts the client asked for no stream and no list in those 280 seconds or in that turn, whose tool call was served.
- **A call that meets the refusal.** Every request refused as a revoked caller's for 90 seconds after a clean end, the second turn 20 seconds in. Its three listens were refused, and then its tool call, 21.9 seconds in. It sent nothing more in the 28 seconds watched, the refusal still on. The model was given the refusal's words, and quoted them: the key has been revoked, request a new one.
- **Seven clean ends in one session, 15 seconds apart.** The first five were each opened again 1.0 second on, and listed; each of those streams was open 14 seconds. After the sixth end the client made no attempt in the 75 seconds watched, a second turn among them. The seventh end found no stream.
- **Seven ends by a frame written by hand, 20 seconds apart.** The first five were each opened again 6.0 seconds on, and listed; each was open 14 seconds. After the sixth end the client made no attempt in the 90 seconds watched, a second turn among them. The seventh found no stream.
- **Seven times, 15 seconds apart, a clean end with a listen refused for 2 seconds after it.** Each of the first five times the attempt 1.0 to 1.2 seconds on was refused and the one 3.0 to 3.3 seconds on was opened, and listed; each of those streams was open 12 seconds. The sixth time the client made no attempt at all, in the 85 seconds watched. So it stopped after its fifth reopening, ten attempts in: the five refused among them did not bring the stop sooner.

What that shows, of this client in these runs:

- **None of the three ways stranded it.** It opened its stream again after each, and listed. Without a closing frame it did so as after a drop, a second on; with one, six seconds on, whether the SDK wrote the frame or the server did by hand.
- **A refused listen is an attempt used up.** A listen answered HTTP 200 with a JSON-RPC error, -32001 in either wording or -32603, ended it after three: the same three attempts a 502 and a busy answer use up, above. That is of these answers: a closed port is treated otherwise, above, and a 401 was not run.
- **Once stopped it stayed stopped,** for the 310 seconds the probe served in the one session watched that long, a new turn among them, and for the 50 seconds of each of the fifteen others. Its calls were served and its list was the old one.
- **A refused call goes to the model, and nothing follows it.** Once, and watched 28 seconds with the refusal still on: no call again, no listen, no list. Whether its calls go on once the refusal ends was not seen.
- **Five reopenings in a session, and no sixth,** three times: by clean ends 15 seconds apart and by frames 20 seconds apart, each stream open 14 seconds, and in the last session, each open 12. After the sixth end it made no attempt. Its documentation, as its page read on 2026-11-24, gives five reopens in an hour for a stream that stays open longer than 10 seconds, and three for one that closes again within 10, which no stream here did. The six ends that met a stream fell within 75 to 100 seconds, so "in an hour" is the documentation's, and the six hours it is said to wait were not watched.
- **A refused attempt did not count toward the five.** Once: the five refused among the ten did not bring the stop sooner. What the client counts, reopenings or ends, these runs do not tell apart.

How, and what is thin:

- The probe's controls `end/WAY`, `revoked/WAY/N`, `unknown/WAY/N` and `nolisten/WAY/N` (`evals/mcp-clients/probe.ts`). `selfcheck.ts` holds: that each way ends two held streams, and one alone, as it says, with nothing announced on the stream it ends, and that the probe then serves on with a request's result, holds none, and holds a listen made after; that the frame written by hand is the SDK's own, byte for byte, once and last, for a number's id and for the two strings this client sends a listen with; what a `server/discover`, a `tools/list`, a `tools/call` and a listen in this client's shape, a bare `tools/list` and a notification, each at three paths, and a bare `tools/call` at the two older ones, are each answered under the two refusals of a caller, each refusal whole and with no `Retry-After`, in the words the probe copies from the brain's; that under the third every other request is answered as with no refusal and a listen refused; that each refusal lasts about what it was asked to, to within some 0.4 of a second, for one second and for two; that one caller's refusal begun while the other's runs replaces it, its time with it, in either order; that a refusal asked for less than 1 second or more than 600 is not begun; that the tool set changes, in what the probe lists and not in its own word alone; each of these after each of the three ways, the five pairs the runs here used among the nine; with no stream held, each refusal once more, after one way each; and that the probe's log, which is the record of these runs, marks as many answers with each refusal as the check met, each with the refusal of the control then running, has a line for each request, and has a `serving-again` within about half a second of each control's end. It does not hold two controls at once, but that one case, nor which answer each mark is on. This client's shape is its user-agent and protocol headers, a number for the id of a `tools/list` and a `tools/call`, and a string for a listen's and a `server/discover`'s. The self-check's header names what it leaves unheld. `reset` is held as an error at the reader, which a body cut short gives too: that it is a reset at TCP was seen by hand, with Bun 1.4.3 on macOS.
- What the probe's refusals copy of the brain is the status and the body of a single request, a listen and a notification, for a caller that presents a key. Nothing holds the copies to the brain's code. Its headers are not copied, nor what it answers a batch or a GET, which this client did not send. A caller with a token whose subject the registry has revoked is answered as a revoked key is, which is the shape run here. What the probe cannot stand in for is a 401 with a challenge, which the brain gives at its public origin to a caller with nothing, and to one whose token it refuses, a lapsed token among them: no session here held a credential, so none could be refused that way.
- Thirty-three sessions: thirteen in the first table, of which three controls and the nine ends were one batch and the first control was run alone before it; fifteen in the second; the five after. All headless, all on 2.1.331, one after another, the last three on a probe started afresh two hours after the rest, on loopback with no proxy between: whether a reset at the MCP server reaches a client through the stack's proxy as a reset was not run.
- One control session's first turn failed before its tool call, the headless client answering "Credit balance is too low". Its stream had opened; the end, the reopening 6.0 seconds on, the list and the second turn were as in the other three.
- Each refusal in the second table lasted 40 seconds, longer than the client's three attempts. The last of the five sessions has one shorter than them: an attempt that is refused, and a later one that opens.
- Not measured: an interactive session; what the `/mcp` panel shows of a server whose stream the client has stopped asking for; what starts a stopped client again short of a new session; a stream ended in the middle of a turn, or within 10 seconds of its opening; a refusal that never ends, beyond the 50 seconds one session was watched under a refusal of 90; a new session whose first listen is refused; a 401, which a caller meets when its token is refused, and a sign-in again after a grant is revoked, which need the authorization server; and any other client.
