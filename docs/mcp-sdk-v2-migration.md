# Migrate to the MCP TypeScript SDK v2 (SMD-2275)

> **Amended 2026-09-27 by `docs/operator-surface-tiers.md` (SMD-2282).** The staging below still holds, and stage 1 (SMD-2278) has landed. But server-portable is no longer the long-term canonical surface. The REST core (SMD-2284) is the contract, and the MCP surface becomes a new SDK-v2 server that is a client of it (SMD-2287). Where this record calls server-portable "the canonical one-HTTP-process server" or "the canonical surface", read it as true until SMD-2287's cutover. Stage 2 (SMD-2279) is mostly retirement under SMD-1931.

An architecture decision record. **Decided 2026-09-27: GO — migrate the fork
onto the MCP TypeScript SDK v2 scoped packages (`@modelcontextprotocol/core` +
`@modelcontextprotocol/server`), retiring the v1 single package
`@modelcontextprotocol/sdk` and the third-party `@hono/mcp`. Staged,
server-portable first. The spike proves the transport swap is small — three
localized changes in `server-portable/index.ts` carry it, and every
server-portable suite is green but three understood assertions.** The evidence
is a throwaway spike on branch `michaelharris/smd-2275-sdk-v2-spike` (commit
`def84115`), measured against this tree. This page is the pick, what the spike
measured, the staged order, the swap map, and what it declines and leaves open.
The verified package facts are the memory note `mcp-typescript-sdk-v2-repackaging`.

## The decision

1. **Go, not defer.** There is no forcing function today — v1 keeps ~6 months of
   fixes — but the swap is small (below), the official `@modelcontextprotocol/hono`
   retires a third-party dependency (`@hono/mcp`, v1-only, superseded), and v2's
   transport is spec-strict where the fork's v1 stack had drifted lenient. We
   migrate proactively while it is cheap rather than under a client requirement
   or a Tasks build later.
2. **The v2 packages, over staying on v1.** `@modelcontextprotocol/sdk` (1.30.0)
   → `@modelcontextprotocol/core` (2.1.0) + `@modelcontextprotocol/server` (2.1.0);
   `@hono/mcp` (0.3.2) → **dropped**. Server-portable uses
   `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`
   (a Web-standard `Request → Response` transport), so it needs no framework
   middleware package at all — `@modelcontextprotocol/hono` is available but the
   fork does not need it, because it owns its own Hono app and only wants a
   transport.
3. **Staged, server-portable first.** The canonical one-HTTP-process server
   (`server-portable/`) migrates first as its own PR; the vendored servers and the
   SDK client follow, or the vendored servers retire per SMD-1931. The stages are
   below.

## What the spike measured

The spike swapped `server-portable/` onto v2 and ran the suites against this
tree. It is not for merge — it is the sizing behind this ADR.

**The transport swap is three localized changes in `index.ts`:**
- The two imports collapse to one:
  `import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";`
  (was `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` +
  `StreamableHTTPTransport` from `@hono/mcp`).
- The per-request wiring passes a Web `Request`, not the Hono `Context`:
  `new WebStandardStreamableHTTPServerTransport()` → `server.connect(transport)` →
  `transport.handleRequest(mcpRequest)`.
- The request body, already drained once by `requestLabel(await c.req.text())`,
  is **reconstructed into a fresh `Request`** for the transport. This was the
  single biggest source of breakage and is the one real gotcha: v2's transport
  reads the **raw request body stream**, where `@hono/mcp` read Hono's *cached*
  body, so the fork's read-the-body-for-the-label-first step (SMD-1864's request
  labelling) left the v2 transport with an empty stream and every call returned
  `-32700 Parse error: Invalid JSON` until the body was handed over reconstructed.

**`McpServer`, `registerTool`, `connect` are v2-compatible.** `McpServer`'s
constructor (`{ name, version }`), `registerTool(name, config, cb)` (still
three-arg, handler last), and `connect(transport)` are unchanged, so
`buildServer`'s `registerTool` monkey-patch (`index.ts:809-822`) survives
untouched. **No tool code changed.** The tool `inputSchema` stays a zod object.

**Suites, on the swapped tree:**
- `bun run typecheck` — clean.
- `test-server.ts` — **342/344**. The two failures are the change-84 assertions
  that a single `Accept` token reaches the transport "unpatched → 200": v2 is
  spec-strict and answers `406 Not Acceptable: Client must accept both
  application/json and text/event-stream` unless the client sends **both** tokens.
  This is a behaviour improvement (spec compliance), so those two tests get
  rewritten to assert the 406, not patched around.
- `test-e2e-sql.ts` — **264/265** (throwaway Postgres). The one failure: an
  unregistered-tool call (e.g. a capture key calling `search_thoughts`) now
  surfaces as a **JSON-RPC error** (`-32602`), where v1's `McpServer` wrapped
  "tool not found" as an `isError` tool *result*. A test/handling reconciliation,
  not a regression (the fork's own refusals-as-values path, SMD-1978, is
  unaffected — this is the SDK's built-in not-found).
- `test-auth.ts` — **120/120**.
- Workers (`wrangler deploy --dry-run`) — **builds and serves** (1767 KiB /
  336 KiB gzip), `nodejs_compat` only.

**The revision matches the fork's posture.** v2 negotiated `protocolVersion`
down to the client's requested `2024-11-05` and returned a well-formed
`initialize` result, so existing clients that send both `Accept` tokens keep
working. v2 answers a normal request/response as an SSE stream
(`content-type: text/event-stream`) when the client accepts it, so the SMD-1864
`withSseKeepalive` wrapper still applies unchanged — the `[17]` keepalive suite
is green.

## The staged plan

1. **server-portable → v2** (the real migration PR; unblocks the SMD-2273
   path-A prerequisite). The three `index.ts` changes above; drop `@hono/mcp` +
   `@modelcontextprotocol/sdk`, add `@modelcontextprotocol/core` +
   `/server`; rewrite the two `test-server` Accept assertions and the one
   `test-e2e-sql` error-shape assertion; keep `extensions/package.json` in lockstep
   (the two pin sets must stay identical — `extensions/test-auth.ts` fails if they
   drift; FORK.md change 84). A `changes/smd-NNNN.md` fragment is required (it
   touches `server-portable/`).
2. **The shared-install vendored servers → v2, or retire per SMD-1931.**
   `enhanced-mcp`, `delete-thought-mcp`, `update-thought-mcp`, `ob-graph`,
   `work-operating-model-activation` resolve the SDK from one
   `extensions/node_modules` install, so it is one swap plus each server's own
   `StreamableHTTPTransport` → `WebStandardStreamableHTTPServerTransport` line.
   `delete-thought-mcp` / `update-thought-mcp` also import `ListToolsRequestSchema`
   from the SDK — re-point to v2's type exports. This stage is a candidate to
   fold into SMD-1931's consolidation (retire rather than migrate).
3. **The self-pinned outliers.** `integrations/kubernetes-deployment` vendors its
   own pinned SDK + `@hono/mcp` (its own `package.json`/`bun.lock`) — a self-
   contained swap. `recipes/vercel-neon-telegram` is already on the v1
   `WebStandardStreamableHTTPServerTransport` (from
   `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, `^1.12.1`), so
   it moves by re-pointing the import to `@modelcontextprotocol/server` — the
   smallest change of all.
4. **The SDK client + e2e fixtures.** `evals/orchestration/mcp-client.ts` (and the
   two Windmill scripts) use the SDK **client** (`Client` +
   `StreamableHTTPClientTransport`) — swap to `@modelcontextprotocol/client`. The
   hand-rolled JSON-RPC in `test-server.ts` / `test-e2e-sql.ts` already sends both
   `Accept` tokens on its main path; only the deliberate single-token probes change.

## Package swap map

FORK.md change 84 counts the coupled stack: 19 pin sites, 3 lockfiles, 15
servers, 20 SDK importers. The swap per site:

| v1 | v2 |
| --- | --- |
| `@modelcontextprotocol/sdk` `1.30.0` | `@modelcontextprotocol/core` `2.1.0` + `@modelcontextprotocol/server` `2.1.0` |
| `@hono/mcp` `0.3.2` (third-party) | dropped (server-portable needs no middleware pkg; `@modelcontextprotocol/hono` `2.0.1` is the option if a server wants the framework app) |
| `McpServer` from `.../sdk/server/mcp.js` | `McpServer` from `@modelcontextprotocol/server` |
| `StreamableHTTPTransport` from `@hono/mcp`, `handleRequest(c)` | `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server`, `handleRequest(request)` |
| `ListToolsRequestSchema` from `.../sdk/.../types.js` | the same name is exported from `@modelcontextprotocol/server` |
| client `Client` + `StreamableHTTPClientTransport` from `.../sdk/client/*` | `@modelcontextprotocol/client` |

Pin sites to touch: `server-portable/package.json`, `extensions/package.json`
(lockstep), `integrations/kubernetes-deployment/package.json`, `evals/package.json`
(client only), `recipes/vercel-neon-telegram/package.json`, and the three
`bun.lock` files. The transitive tree shrinks: v1 pulled `express`, `raw-body`,
`cors`, `@hono/node-server`, `ajv`, `@cfworker/json-schema` (unused on the
Workers path); v2 `@modelcontextprotocol/server` depends only on `zod` +
`@modelcontextprotocol/core`, and `@modelcontextprotocol/hono` has zero runtime
dependencies.

## Transport & keepalive

The rewrite is confined to `index.ts:809-822` (unchanged — the monkey-patch
holds) and the per-request handler at `index.ts:~3096`. The one substantive
edit beyond the import and the transport class is the **body reconstruction**:
read the text once, use it for both `requestLabel` and a rebuilt `Request` for
`transport.handleRequest`. `response.headers.delete("mcp-session-id")` and the
CORS header copy stay; `withSseKeepalive` (SMD-1864) stays and still fires,
because v2 answers with `text/event-stream`. `MCP_METHODS = ["POST"]` and the
`GET → 405` guard (SMD-1259) are unaffected — the `[13]` GET suite is green.

## Client impact & the compat window

- v2 **negotiates the protocol version down** to what the client requests
  (measured: a `2024-11-05` client got a `2024-11-05` result), so Claude
  Desktop / claude.ai connectors and the ChatGPT `search`/`fetch` shim keep
  connecting, provided they send **both** `Accept` tokens (browsers and the
  official clients do; a bespoke client that sends one now gets a clear 406).
- The `?key=` / `x-brain-key` auth rides **on top** of the transport, unchanged —
  the auth gate runs before `handleRequest` and is untouched by the swap (v2's
  own `requireBearerAuth`/OAuth helpers are not used; the fork keeps its key auth).
- v2 ships built-in legacy handling (`legacyStatelessFallback`,
  `classifyInboundRequest`, `isLegacyRequest`) — a backstop for older-protocol
  clients that the stage-1 PR should exercise against a real connector before it
  merges.

## Not decided here (Tasks)

v2 does **not** ship Tasks as a turnkey helper — there is no
`@modelcontextprotocol/tasks` package and no high-level `tasks/*` server API.
The **protocol types do exist** in `@modelcontextprotocol/server`
(`GetTaskRequest`/`GetTaskResult`, `CreateTaskResult`, `TaskStatus`,
`isTaskAugmentedRequestParams`, `RELATED_TASK_META_KEY`, …), so SMD-2273 path A
on v2 means **wiring the task lifecycle over those types**, not hand-rolling the
whole extension from scratch — but it is still real work, not a free win from
migrating. Migrating to v2 does not, by itself, unlock async. This refines the
earlier "Tasks not shipped as SDK helpers" note: the wire types are present, the
orchestration is not. SMD-2275 blocks SMD-2273; the task lifecycle is that
ticket's, not this one's.

## Declined

- **Defer entirely.** Rejected: the swap is small and measured, and it retires a
  third-party dependency now rather than under a deadline. The ~6-month v1 window
  is a reason to move calmly, not a reason to wait.
- **Big-bang all 15 servers in one PR.** Rejected: server-portable is the
  canonical surface and the only one on the dogfood path; the vendored servers
  share one install (one later swap) and several are retirement candidates
  (SMD-1931). Stage it.
- **Adopt `@modelcontextprotocol/hono`.** Not needed for server-portable, which
  owns its Hono app and only wants a transport; `WebStandardStreamableHTTPServerTransport`
  is the smaller surface and is already the shape `vercel-neon-telegram` uses.

## Follow-ups

- **SMD-2278 — server-portable → v2** (stage 1; the real migration PR; blocks
  SMD-2273's path-A prerequisite).
- **SMD-2279 — vendored servers → v2 or retire** (stage 2; tied to SMD-1931).
- **SMD-2281 — self-pinned outliers + the SDK client → v2** (stage 3; completes
  the v1 retirement).

## Related

- SMD-2273 — async response pattern; path A (native Tasks) sits behind this
  migration. Blocked by SMD-2275.
- SMD-2272 — `run_worker` drain; another long-running call that would ride the
  same async pattern.
- SMD-2131 / SMD-2132 — the `/worker-status` read + `POST /worker-*` action
  routes that coexist with the MCP endpoint; the swap keeps them (e2e green).
- SMD-1931 — consolidate the outward surface; stage 2's retire-or-migrate call.
- SMD-1864 — the SSE keepalive the swap preserves.
- SMD-1259 — the GET → 405 posture the swap preserves.
- SMD-2001 / SMD-1616 — the vendored servers' transport quirks stage 2 inherits.
