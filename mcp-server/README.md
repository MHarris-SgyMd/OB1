# mcp-server — the brain's MCP server as a client of its REST core

SMD-2282's decision 3 (`docs/operator-surface-tiers.md`) makes the REST core the
brain's contract (`server-portable/api.ts`, SMD-2284). MCP calls go through a server of
their own, which calls the REST core like any other client. This directory is that
server (SMD-2287): MCP over streamable HTTP on SDK v2. Every tool is a call to the REST
core through [`../rest-client`](../rest-client/README.md), carrying the caller's key
beside this server's forward-scope key. It holds no store, no key list and no model.

It is built to answer as `server-portable/index.ts` does, from the same pieces. How far that holds is what its suites measure (below):
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
| `index.ts` | The entry, `bun index.ts`: OB1_REST_URL, OB1_FORWARDER_KEY, OB1_PLUGINS, PORT, OB1_STOP_GRACE |
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
- **The tools** are the caller's operations, each validated by the SDK against its
  schema. A call goes to the REST core with the caller's key, and its answer is
  rendered by `render.ts`:
  - a success's value;
  - a refusal from the `refusal` the forwarder slot carries;
  - a fault (`FAILED`, or capture's `STORE_UNAVAILABLE`) in the tool's fault words.

  A forwarded capture is answered the whole value, whatever the key's scope, so a
  capture-only key's capture is said as `index.ts` says it. A reply `render.ts` cannot
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
  the REST core to parse once as `index.ts`'s SDK does (none is `{}`; two calls of a
  batch under one id are refused, their arguments no one's to pick), and its answer is
  said by `render.ts`'s `renderPlugin`: a value, the refusal the forwarder slot
  carries whole, or a fault. Give this server and the REST core the same
  `OB1_PLUGINS` and the same build of each plugin: a plugin the REST core runs and
  this server was not given is no tool here (said once in the log, by operation, as is
  a core tool of a newer REST core), and
  one whose route or schema differs between the two builds answers a fault. A name
  that is no plugin stops the entry, exit 2 in words, as it stops the REST core.
- **`/health`** is plain `ok` without a key. With a key, the first key the REST core
  knows decides, as `index.ts` authenticates the first, and the route shows the REST
  core's keyed `/health`: the brain's record on the health surface, for a key that may read it and
  that the registry clears within the deadline, with this server's view of the public
  origin beside it as `oauth`. Any other key gets `ok`.
- **The keyed mirrors.** `/worker-status`, `/worker-retry-failed`,
  `/worker-release-leases`, `/worker-run`, `/jobs/<id>` and `/jobs/<id>/stream` are the
  REST core's operations, with the same gates, inputs and words as server-portable's
  (`mcp-edge.ts`'s `MIRROR_INPUT` and `MIRROR_WORDS`). Their key check, like
  `/health`'s, is held to `HEALTH_DEADLINE_MS` (`server-portable/deadlines.ts`): a
  registry that does not answer by then is shown `ok`, the lookup aborted. On
  `/health` one deadline covers the key's standing and the record, asked together for
  each key presented, as `index.ts` starts both. A job poll or stream whose read
  faults is a 500; a key the registry turns busy or revoked between its check and the
  call is `ok`, its line `refused` BUSY or REVOKED. A fault finding the caller or the
  record (this server's forwarder refused or revoked, the REST core away, a registry
  that throws, a record that is no object) is shown `ok` there, its line `error`
  FAILED, a 500 `error` at the endpoint, and said in the log at most once a minute. A
  keyed HEAD at `/health` and the mirrors is `ok` at once, asking the REST core
  nothing. The
  registry busy on this server's own key is busy, `-32003` with `Retry-After`, not a
  misconfiguration.

**Known differences from `index.ts` (the parity runs below):**
- **Writes** record the REST core's door, `open-brain-api`, with this server named as
  `act` (the forwarder key's name), where server-portable records `open-brain`.
- **The key on a line.** `index.ts` matches a key's hash before it asks the registry;
  this server knows a key only by the REST core's whoami. So these lines name no key: a
  registry that throws (at a keyed route `error` FAILED, shown `ok`; at the endpoint a
  500 `error` with no JSON-RPC method or tool read yet), one silent past
  `HEALTH_DEADLINE_MS` or a REST core that hangs (`refused`), and a keyed HEAD (`ok`,
  any key, a wrong one included, where `index.ts`'s reads `refused`). A revoked or busy
  key is named, the REST core naming it to its forwarder — before its scope is weighed,
  where `index.ts` shows a key out of scope nothing first; one the
  registry turns revoked or busy between whoami and `/health`'s record is `refused`
  with no code, the REST core's keyed `/health` answering liveness. With this
  server's forwarder misconfigured, an unknown key reads `refused`, the REST core
  refusing it before the forwarder.
- **The REST core's lines** for a keyed `GET /health` are two a key presented (its
  whoami and its `/health`, asked together): a key it does not know reads `refused` on
  both.
- **A key turned during a tool call** (revoked or busy after this server's whoami) is
  the tool's fault, FAILED, where `index.ts` refuses a key turned before the call.
- **The stop** counts this server's tool calls; a scan's job body runs in the REST core,
  whose own stop marks it lost, where `index.ts` counts it among its tool calls.
- **Not yet, SMD-2287 PR 4c:** the spans (SMD-1849) and the `traceparent` this server
  sends the REST core; test-server's [22] is skipped through this server till then.

**Every request's line** is this server's own, `door: "mcp"`, as `index.ts` writes it
(SMD-1849): the route as a template, the JSON-RPC method and tool, the key's name once
known, how it ended — a batch its worst call, a call that never ran `unrun`, a client
gone `abandoned`, a stall `stalled` — and the bytes a stream wrote. The REST core's
lines are its own process's.

**The entry** serves with Bun's longest idle timeout, 255 s (`IDLE_TIMEOUT_S`): its job
polls and mirrors are GETs that wait on the REST core, and Bun's 10 s default cuts such
a GET (the REST core's own reason, `server-portable/api.ts`). Its stop (SIGTERM) waits
for Bun's requests in flight and for the tool calls running past their client, within
OB1_STOP_GRACE, then cuts what is left, each line `cut`; with no store, it says no pool
was opened. A base it cannot serve exits 2 in words.

## Run

```bash
cd mcp-server && bun install
OB1_REST_URL=http://api.ob1.internal.:8000 OB1_FORWARDER_KEY=<a forward-scope key> OB1_PLUGINS=<the REST core's> bun index.ts
```

The forwarder key is minted with `cd server-portable && bun keygen.ts <name> --scope
forward`, and its hash goes in the REST core's `MCP_ACCESS_KEYS`. With no
`OB1_FORWARDER_KEY` the entry exits 2. The compose service, its forwarder key from
`deploy/.env` and the canary tier's route are SMD-2287 PR 5.

## Test

```bash
bun test-mcp.ts                                                  # 115 — the tool list from whoami; each reply what render.ts makes of the core's outcome (a success, a refusal carried whole, a fault, capture's STORE_UNAVAILABLE, the REST core away); a scan's links under the endpoint; the key refusals' envelopes and a notification's bare answer; /health; the mirrors and the job routes; a capture key's capture, a reply that cannot be said, the tools' order, /health's first key, the mirrors' deadline, a job poll's fault; /health's one deadline, a job stream's answers, a misconfigured forwarder said once; the forwarder's busy key, the registry busy mid-call, one line for a route's throw, the entry's idle timeout and its refusal of a base; a route's throw named with the REST core's address, a client gone unsaid, a base's credentials unprinted, the entry imported throwing; a plugin's operation a tool where whoami names it, its value, refusal and fault as renderPlugin says them, the entry's OB1_PLUGINS, an input's steps run once, a call with no arguments, a batch's shared id refused, a body behind byte-order marks; the entry's stop, a tool call waited on and cut; a fault's line `error` FAILED, the keyed HEADs at once, `/health`'s record beside the key's check, a key turned mid-call; the method guard
cd ../server-portable && OB1_MCP_UNDER_TEST=client bun test-auth.ts   # 191 — test-auth's assertions, held to this server with the REST core behind it
cd ../server-portable && OB1_MCP_UNDER_TEST=client ../db/with-postgres.sh bun test-e2e-sql.ts   # 571 — the whole server over MCP on real Postgres, held to this server the same way
cd ../server-portable && OB1_MCP_UNDER_TEST=client bun test-server.ts   # 1008 — the real server's suite, its request lines and stop; [22]'s 54 span assertions are PR 4c's
cd ../server-portable && OB1_MCP_UNDER_TEST=client bun test-plugins.ts   # 282 — plugins in the contract, an enabled plugin's operation as this server's tool
cd ../server-portable && OB1_MCP_UNDER_TEST=client ../db/with-postgres.sh bun test-plugins-sql.ts   # 107 — the example's operations, pinned over REST and read back through this server
```

`OB1_MCP_UNDER_TEST=client` makes a server-portable suite drive this server through
`stack.ts` in place of `index.ts` (`server-portable/test-support.ts`'s `mcpUnderTest`); each
suite first asserts that the server it got is the one the variable names.
CI runs test-server, test-auth, test-e2e-sql, test-plugins and test-plugins-sql both ways. Where the two servers differ, test-e2e-sql
says which it expects: a write through this server records the REST core's door,
`open-brain-api`, with this server as its carrier (`act`). [18] runs server-portable's
own entry either way: this server holds no job store.
