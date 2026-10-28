# mcp-server — the brain's MCP server as a client of its REST core

SMD-2282's decision 3 (`docs/operator-surface-tiers.md`) makes the REST core the
brain's contract (`server-portable/api.ts`, SMD-2284). MCP calls go through a server of
their own, which calls the REST core like any other client. This directory is that
server (SMD-2287): MCP over streamable HTTP on SDK v2. Every tool is a call to the REST
core through [`../rest-client`](../rest-client/README.md), carrying the caller's key
beside this server's forward-scope key. It holds no store, no key list and no model.

It is built to answer as `server-portable/index.ts` did, from the same pieces; server-portable's suites, which drive this server (below), hold it to that. That file, the MCP server this one replaced, retired in SMD-2287 PR 6b; a comparison below with `index.ts` means it, and this server's own entry is `index.ts` in the table:
- **The endpoint's HTTP edge**, `server-portable/mcp-edge.ts`:
  - the methods served and the CORS headers;
  - the JSON-RPC refusal envelopes, and a refused notification's bare 202 or 503;
  - the public origin's challenge;
  - the bounded read of a refused body;
  - the worker mirrors' words.
- **The words**, `server-portable/render.ts`. A refusal arrives whole through the
  forwarder slot, so it is said as the in-process core's would be.
- **The tool schemas**, `server-portable/core/schemas.ts`, which the SDK validates input
  against.
- **The SSE keepalive**, `server-portable/sse.ts`.

| File | What it is |
|---|---|
| `app.ts` | `createMcpApp`: the MCP endpoint, `/health`, the keyed worker mirrors, the job routes, the method guard and discovery |
| `index.ts` | The entry, `bun index.ts`: OB1_REST_URL, OB1_FORWARDER_KEY, OB1_PLUGINS, PORT, OB1_LISTEN_HOST (one IP address to listen on, as the REST core's: unset, every address; never forwarded by compose; a value that is no IP address, a link-local IPv6 one, or one this host does not have, exits 2), OB1_STOP_GRACE, and for OAuth COMPOSE_PROFILES (naming `auth`), OB1_PUBLIC_ORIGIN and OB1_AUTH_SECRET_MCP |
| `exchange.ts` | The token exchange at the hop (SMD-2286): an OAuth token traded for the REST core's, cached by its digest |
| `stack.ts` | This server with the REST core behind it in one process, for server-portable's suites |
| `test-mcp.ts` | The suite |

## How a request is answered

- **The caller.** Each key the request presents (`x-brain-key`, `x-access-key`,
  `?key=`, `Bearer`, in that order) is asked of the REST core's `GET /v1/whoami`. The
  first it knows decides:
  - known, it gives its name and the operations it may call;
  - revoked, the revocation's envelope;
  - the registry busy, `-32003` with `Retry-After`;
  - no key the core knows, `-32001`, or at the public origin of a stack with the
    `auth` profile, the OAuth challenge.

  A refused notification gets a bare 202, or 503 when busy, as server-portable answers
  (SMD-2106). If the REST core refuses this server's own forwarder key, the server is
  misconfigured: the request is a 500, never the caller's refusal.
- **An OAuth client** (SMD-2286): a bearer of a JWT's shape is never sent to the REST
  core as a key, a key form beside it or not (a dotted value in a key form stays a
  key, since a raw `MCP_ACCESS_KEY` may have dots; on a stack with no public origin
  any bearer is a key; on one with an origin, send a dotted key in a key form). With
  no key beside it, at the public
  resource of a stack with the
  `auth` profile, it is traded (RFC 8693) at the authorization server's token endpoint
  on the mesh, as the `mcp` client (`OB1_AUTH_SECRET_MCP`), for a token whose audience
  is the REST core; that token rides `Authorization: Bearer` on every call, and the
  REST core records the subject (`oauth:operator`) with this server as `act`
  (`oauth:mcp`). The keyed routes at the origin's `Host` (a scan's job links, the
  worker mirrors) trade it too; `/health`'s record stays a key's.
  - The claims are read first, only to refuse: another issuer, any audience but
    exactly `<origin>/mcp`, or an expired or exp-less token is refused with no trade.
  - A trade is cached by the incoming token's digest, never by its subject, until 5 s
    before the exchanged token expires: one operator's read and write connectors each
    keep their own scope. The authorization server's exchange checks the token, not
    its grant: a grant revoked there is refused once the client's access token
    expires (at most 600 s); a subject revoked in the registry, at the next call.
  - Refused (`invalid_grant`, or the claims), at `/mcp` and the keyed routes alike:
    401 `invalid_token`, so the client refreshes, or 503 while the authorization
    server is away, so a refresh that cannot finish does not become a sign-in. A
    token not checked within a keyed route's 2.5 s deadline: 503. Scopes with no key's meaning: 403 `insufficient_scope`,
    `scope="brain:read"`. The authorization server away, limiting, stalling or cut
    short: 503, `Retry-After: 30`. A subject revoked in the registry: the revoked
    key's refusal, not a sign-in loop. This server's own client refused, or the REST
    core refusing a token traded for it a moment ago (it checks none, or another
    origin's): a 500 and one line in the log, with its fix. A trade the authorization
    server did not answer is said in the log too, at most once a minute.
  - The token endpoint is the mesh name over plain HTTP (`exchange.ts`
    `AUTH_TOKEN_URL`): this server trades inside the stack's network only.
  - On a stack with an origin, anywhere else (another `Host`, no secret), a token is
    no caller and gets the edge's answer as before; the start warns when a configured
    stack has no secret, and when the secret is set but the stack is not configured
    or its origin is unsound. On a stack with no origin there is no OAuth, and a
    bearer of any shape is sent on as a key, as on main.
- **The tools** are the caller's operations, each validated by the SDK against its
  schema. A call goes to the REST core with the caller's key, and its answer is
  rendered by `render.ts`:
  - a success's value;
  - a refusal from the `refusal` the forwarder slot carries;
  - a fault (`FAILED`, or capture's `STORE_UNAVAILABLE`) in the tool's fault words.

  A forwarded capture is answered the whole value, whatever the key's scope, so a
  capture-only key's capture is said as `index.ts` said it. A reply `render.ts` cannot
  say is the tool's fault, coded, never the SDK's uncoded error. tools/list keeps
  `index.ts`'s order.

  The REST core away mid-call is the tool's fault: for capture that is
  `STORE_UNAVAILABLE`, which the session hook keeps and retries. A re-capture of the
  same text upserts the row (migration 073), so a capture that landed before the
  connection dropped is not duplicated. A scan's job links are put under the endpoint
  the call came to, as `atEndpoint` puts server-portable's.
- **Plugin tools** (SMD-2310). The entry reads `OB1_PLUGINS` as the REST core does, for
  each enabled plugin's operations: their names, schemas and routes. An operation is
  a tool, `<plugin>_<operation>`, after the core's, where whoami names it among the
  caller's operations. The SDK holds its input and answer to the manifest's schemas;
  the arguments its client sent go to its route through `rest-client`'s `callPath`, for
  the REST core to parse once as `index.ts`'s SDK did (none is `{}`; two calls of a
  batch under one id are refused, their arguments no one's to pick), and its answer is
  said by `render.ts`'s `renderPlugin`: a value, the refusal the forwarder slot
  carries whole, or a fault. Give this server and the REST core the same
  `OB1_PLUGINS` and the same build of each plugin: a plugin the REST core runs and
  this server was not given is no tool here (said once in the log, by operation, as is
  a core tool of a newer REST core), and
  one whose route or schema differs between the two builds answers a fault. A name
  that is no plugin stops the entry, exit 2 in words, as it stops the REST core.
- **`/health`** is plain `ok` without a key. With a key, the first key the REST core
  knows decides, as `index.ts` authenticated the first, and the route shows the REST
  core's keyed `/health`: the brain's record on the health surface, for a key that may
  read it and that the registry clears within the deadline, with this server's view of
  the public origin beside it as `oauth`. Any other key gets `ok`.
- **The keyed mirrors.** `/worker-status`, `/worker-retry-failed`,
  `/worker-release-leases`, `/worker-run`, `/jobs/<id>` and `/jobs/<id>/stream` are the
  REST core's operations, with the same gates, inputs and words as server-portable's
  (`mcp-edge.ts`'s `MIRROR_INPUT` and `MIRROR_WORDS`). Their key check, like
  `/health`'s, is held to `HEALTH_DEADLINE_MS` (`server-portable/deadlines.ts`): a
  registry that does not answer by then is shown `ok`, the lookup aborted. On
  `/health` one deadline covers the key's standing and the record, asked together, as
  `index.ts` started both — for the first key presented, and the next once one is found
  unknown, so no key that could not decide is read. A job poll or stream whose read
  faults is a 500; a key the registry turns busy or revoked between its check and the
  call is `ok`, its line `refused` BUSY or REVOKED. A fault finding the caller or the
  record (this server's forwarder refused or revoked, the REST core away, a registry
  that throws, a record that is no object) is shown `ok` there, its line `error`
  FAILED, a 500 `error` at the endpoint, and said in the log at most once a minute;
  this server's forwarder refused during a call is the same misconfiguration, said in
  the same words — a mirror's `error` FAILED, a job poll's or stream's 500. A
  keyed HEAD at `/health` and the mirrors is `ok` at once, asking the REST core
  nothing. The
  registry busy on this server's own key is busy, `-32003` with `Retry-After`, not a
  misconfiguration.
- **CORS.** `/mcp` answers every origin, `Access-Control-Allow-Origin: *`
  (`mcp-edge.ts`'s `corsHeaders`), and reads no allowlist, on purpose (SMD-2113). A
  browser-hosted client, claude.ai or the Claude Desktop connector, calls from an origin
  that is its own, not the operator's, so an allowlist could only refuse clients. CORS is
  not what guards the brain: every MCP call still needs a key or a token, as from any
  other client, and this server reads no cookie, so a page has no ambient credential to
  borrow. The REST core sets no CORS at all (`docs/vendored-disposition.md`,
  `OPTIONS *`): a page reaches it same-origin or through a server of its own, as the
  operator GUI does. `server-portable/test-server.ts`'s `corsOk` and `test-mcp.ts`'s
  preflight case hold the answer, so changing it is a decision, not a drift.

**Known differences from `index.ts` (found by the parity runs SMD-2287 PR 6a retired):**
- **Writes** record the REST core's door, `open-brain-api`, with this server named as
  `act` (the forwarder key's name), where server-portable records `open-brain`.
- **The key on a line.** `index.ts` matched a key's hash before it asked the registry;
  this server knows a key only by the REST core's whoami. So these lines name no key: a
  registry that throws (at a keyed route `error` FAILED, shown `ok`; at the endpoint a
  500 `error` with no JSON-RPC method or tool read yet), one silent past
  `HEALTH_DEADLINE_MS` or a REST core that hangs (`refused`), and a keyed HEAD (`ok`,
  any key, a wrong one included, where `index.ts`'s read `refused`). A revoked or busy
  key is named, the REST core naming it to its forwarder — before its scope is weighed,
  where `index.ts` showed a key out of scope nothing first (a capture key presented first
  at `/health` or a mirror is resolved, so registered and stamped, and waits on a busy
  registry, where `index.ts` answered it at once); one the
  registry turns revoked or busy between whoami and `/health`'s record is `refused`
  with no code, the REST core's keyed `/health` answering liveness. With this
  server's forwarder misconfigured, an unknown key reads `refused`, the REST core
  refusing it before the forwarder.
- **The REST core's lines** for a keyed `GET /health` are two for the key that decides
  (its whoami and its `/health`, asked together), and two for each unknown key before
  it, `refused`.
- **A key turned during a tool call** (revoked or busy after this server's whoami) is
  the tool's fault, FAILED, where `index.ts` refused a key turned before the call.
- **The stop** counts this server's tool calls; a scan's job body runs in the REST core,
  whose own stop marks it lost, where `index.ts` counted it among its tool calls.
- **A throw's kind on a span.** What the REST core throws (its registry, its store) is
  on the REST core's span, under this server's; this server's own span has the kind of
  what it met, a 500, since an answer carries no exception.
- **A keyed HEAD's telemetry.** Knowing no key, it sends no span or log record — its
  line and its point on the request-duration histogram kept, where the keyless probe
  has no record at all — so a monitor's probes spend none of the budget for requests
  no key was accepted for (`telemetry.ts`), where `index.ts` named the key and sent
  both. A wrong key's HEAD sends its point alone, its line `ok`, where `index.ts`'s was
  `refused`, its span and record within the budget. A HEAD at `/mcp` itself is a 405, held to the
  budget as `index.ts`'s was: point a monitor at `/health`.

**Every request's line** is this server's own, `door: "mcp"`, as `index.ts` wrote it
(SMD-1849): the route as a template, the JSON-RPC method and tool, the key's name once
known, how it ended — a batch its worst call, a call that never ran `unrun`, a client
gone `abandoned`, a stall `stalled` — and the bytes a stream wrote. The REST core's
lines are its own process's.

**Spans, metrics and log records** (SMD-1849) go where `OTEL_EXPORTER_OTLP_ENDPOINT`
says, as `index.ts`'s did, under the service name `open-brain-mcp` (`OTEL_SERVICE_NAME`
says otherwise): each request a span, each tool call an `execute_tool` span beneath it.
Every call on the REST core carries the current span's `traceparent`, which the REST
core continues for a request its forwarder carried — a forward-scope key in
`x-brain-forwarder` — so a tool call and the operation it ran are one trace. Any other
caller's `traceparent` it links, as before. The REST core's sampling follows this
server's sampled flag for such a request (`parentbased_` samplers), and a span this
server held to its budget leaves the REST core's under it without its parent. There is
no CLIENT span between the two, so Tempo's service graph draws no edge from this server
to the REST core (SMD-3031). With no collector set, a trusted incoming `traceparent` names this
server's line but is not sent on, so the REST core's line names a trace of its own. The
stop sends what is batched.

**The entry** serves with Bun's longest idle timeout, 255 s (`IDLE_TIMEOUT_S`): its job
polls and mirrors are GETs that wait on the REST core, and Bun's 10 s default cuts such
a GET (the REST core's own reason, `server-portable/api.ts`). Its stop (SIGTERM) waits
for Bun's requests in flight and for the tool calls running past their client, within
OB1_STOP_GRACE, then cuts what is left, each line `cut`; with no store, it says no pool
was opened. A base it cannot serve exits 2 in words.

## Run

Compose runs it as the `mcp` service on the server's image, behind the proxy's `/mcp`
(`SETUP.md`); the brain has no other deployment (SMD-2288). By hand, as its tests run it:

```bash
(cd server-portable && bun install) && (cd rest-client && bun install)   # it imports both (SMD-2978)
cd mcp-server && bun install
OB1_REST_URL=http://api.ob1.internal.:8000 OB1_FORWARDER_KEY=<a forward-scope key> OB1_PLUGINS=<the REST core's> bun index.ts
```

The forwarder key is minted with `cd server-portable && bun keygen.ts --name <name> --scope
forward`, and its hash goes in the REST core's `MCP_ACCESS_KEYS`. With no
`OB1_FORWARDER_KEY` the entry exits 2. To trade OAuth tokens it reads what the REST
core reads, `COMPOSE_PROFILES` naming `auth` and a sound `OB1_PUBLIC_ORIGIN`, the
same values, and also needs `OB1_AUTH_SECRET_MCP`, the authorization server's `mcp` client secret from
`deploy/.env`.

The server image (`server-portable/Dockerfile`) carries this directory and
`rest-client/`, each with its own lockfile's packages (PR 5a). There `bun` is the
entrypoint and `../mcp-server/index.ts` the file, without the image's preflight, which
needs a database this server never opens. CI's step "The server image runs the MCP server as a REST client"
starts it from the image alone to hold that; the brain runs it only as compose's service.

`deploy/canary.sh` mints a canary's own forwarder key. On the compose stack it is the
`mcp` service (PR 5b): the proxy routes `/mcp`, `/health` and the protected-resource
document to it as `mcp.ob1.internal`, and compose hands it `OB1_FORWARDER_KEY`
(required: compose refuses the stack without it), `OB1_AUTH_SECRET_MCP`, the origin and
profiles and `OB1_PLUGINS` from `deploy/.env`, on the mesh alone, with
`bun --no-install` as its entrypoint.

## Test

The suites import `../server-portable/` and `../rest-client/`, so they need `bun install`
in both of those as well as here. Auto-install is off in each (their `bunfig.toml`), so
a missing install fails the import, naming the package (SMD-2978).

```bash
bun test-mcp.ts                                                  # 193 — the tool list from whoami; each reply what render.ts makes of the core's outcome (a success, a refusal carried whole, a fault, capture's STORE_UNAVAILABLE, the REST core away); a scan's links under the endpoint; the key refusals' envelopes and a notification's bare answer; /health; the mirrors and the job routes; a capture key's capture, a reply that cannot be said, the tools' order, /health's first key, the mirrors' deadline, a job poll's fault; /health's one deadline, a job stream's answers, a misconfigured forwarder said once; the forwarder's busy key, the registry busy mid-call, one line for a route's throw, the entry's idle timeout and its refusal of a base; a route's throw named with the REST core's address, a client gone unsaid, a base's credentials unprinted, the entry imported throwing; a plugin's operation a tool where whoami names it, its value, refusal and fault as renderPlugin says them, the entry's OB1_PLUGINS, an input's steps run once, a call with no arguments, a batch's shared id refused, a body behind byte-order marks; the entry's stop, a tool call waited on and cut; a fault's line `error` FAILED, the keyed HEADs at once, `/health`'s record beside the key's check, a key turned mid-call; the entry's spans sent at its stop as open-brain-mcp, the REST core's span the child of its tool call's across two processes, a plugin tool named on its line; the method guard; the token exchange: a token traded once and cached by its digest, the REST core sent the exchanged token alone, a read and a write connector of one subject each their own scope, one trade at a time, the cache's margin and bound, refusals on the claims, the authorization server's answers (invalid_grant, invalid_scope, away, busy, 429, a cut-short 200, its client refused) and the REST core's (403, keyless), a revoked subject, job links and mirrors by token, refused ones answered (503 with the authorization server away), /health not, a token beside a key form never sent as one, a dotted raw key in each form and as a bearer with no OAuth, a REST core that checks no token or another origin's, a trade past a job link's deadline, unavailable trades said in the log, a stalled refusal, echoing error codes (a bare 64-hex value too) and a hex key as a bearer, another Host and no secret, a key client with the authorization server away, a token too brief to keep
cd ../server-portable && bun test-auth.ts   # 191 — test-auth's assertions, held to this server with the REST core behind it
cd ../server-portable && ../db/with-postgres.sh bun test-e2e-sql.ts   # 673 — the whole server over MCP on real Postgres, held to this server the same way
cd ../server-portable && bun test-server.ts   # 1223 — the real server's suite whole: its request lines, its spans, one trace per tool call, the entry's telemetry, a keyed HEAD outside the budget, and its stop, a tool call past its client waited on
cd ../server-portable && bun test-plugins.ts   # 282 — plugins in the contract, an enabled plugin's operation as this server's tool
cd ../server-portable && ../db/with-postgres.sh bun test-plugins-sql.ts   # 107 — the example's operations, pinned over REST and read back through this server
```

Every server-portable suite that drives an MCP server drives this one, through `stack.ts`
(`server-portable/test-support.ts`'s `mcpUnderTest`), and first asserts that it got it
(SMD-2287 PR 6a: until then five of them also ran against `index.ts`). A write through
this server records the REST core's door, `open-brain-api`, with this server as its
carrier (`act`). test-e2e-sql's [18] runs server-portable's own entry: this server holds
no job store.
