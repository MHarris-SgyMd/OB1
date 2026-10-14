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
  caller's operations. The SDK holds its input and answer to the manifest's schemas,
  the call goes to its route through `rest-client`'s `callPath`, and its answer is
  said by `render.ts`'s `renderPlugin`: a value, the refusal the forwarder slot
  carries whole, or a fault. Give this server and the REST core the same
  `OB1_PLUGINS`: a plugin the REST core runs and this server was not given is no tool
  here, and a name that is no plugin stops the entry, exit 2.
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
  `/health` one deadline covers the key's standing and the record together. A job
  poll or stream whose read faults is a 500, and a stream the registry is busy on
  `ok`, as is a key the registry turns busy between its check and the call. A fault
  finding the caller (this server's forwarder refused, the REST core away) is shown
  `ok` there, a 500 at the endpoint, and said in the log at most once a minute. The
  registry busy on this server's own key is busy, `-32003` with `Retry-After`, not a
  misconfiguration.

**Known differences from `index.ts` (the parity runs below):**
- **Writes** record the REST core's door, `open-brain-api`, with this server named as
  `act` (the forwarder key's name), where server-portable records `open-brain`.
- **Not yet, SMD-2287 PR 4b and 4c:**
  - the MCP request line and its spans (`door: "mcp"`, SMD-1849): only the REST core's
    lines are written;
  - the stop's drain of an answer's stream past its handler: today the stop counts
    requests in flight, not tool calls (`0 tool calls running` for a call that is), and
    a call whose client has gone is cut at once — the REST core runs it to its end.

**The entry** serves with Bun's longest idle timeout, 255 s (`IDLE_TIMEOUT_S`): its job
polls and mirrors are GETs that wait on the REST core, and Bun's 10 s default cuts such
a GET (the REST core's own reason, `server-portable/api.ts`). With no store, its stop
says no pool was opened. A base it cannot serve exits 2 in words.

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
bun test-mcp.ts                                                  # 87 — the tool list from whoami; each reply what render.ts makes of the core's outcome (a success, a refusal carried whole, a fault, capture's STORE_UNAVAILABLE, the REST core away); a scan's links under the endpoint; the key refusals' envelopes and a notification's bare answer; /health; the mirrors and the job routes; a capture key's capture, a reply that cannot be said, the tools' order, /health's first key, the mirrors' deadline, a job poll's fault; /health's one deadline, a job stream's answers, a misconfigured forwarder said once; the forwarder's busy key, the registry busy mid-call, one line for a route's throw, the entry's idle timeout and its refusal of a base; a route's throw named with the REST core's address, a client gone unsaid, a base's credentials unprinted, the entry imported throwing; a plugin's operation a tool where whoami names it, its value, refusal and fault as renderPlugin says them, the entry's OB1_PLUGINS; the method guard
cd ../server-portable && OB1_MCP_UNDER_TEST=client bun test-auth.ts   # 191 — test-auth's assertions, held to this server with the REST core behind it
cd ../server-portable && OB1_MCP_UNDER_TEST=client ../db/with-postgres.sh bun test-e2e-sql.ts   # 571 — the whole server over MCP on real Postgres, held to this server the same way
cd ../server-portable && OB1_MCP_UNDER_TEST=client bun test-plugins.ts   # 260 — plugins in the contract, an enabled plugin's operation as this server's tool
cd ../server-portable && OB1_MCP_UNDER_TEST=client ../db/with-postgres.sh bun test-plugins-sql.ts   # 107 — the example's operations, pinned over REST and read back through this server
```

`OB1_MCP_UNDER_TEST=client` makes a server-portable suite drive this server through
`stack.ts` in place of `index.ts` (`server-portable/test-support.ts`'s `mcpUnderTest`); each
suite first asserts that the server it got is the one the variable names.
CI runs test-auth, test-e2e-sql, test-plugins and test-plugins-sql both ways. Where the two servers differ, test-e2e-sql
says which it expects: a write through this server records the REST core's door,
`open-brain-api`, with this server as its carrier (`act`); the request lines are the
REST core's, one per call it is sent, until this server writes its own (PR 4). [18]
runs server-portable's own entry either way: this server holds no job store.
