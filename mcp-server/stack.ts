// The MCP server with the REST core behind it, in one process, for a suite
// (SMD-2287): server-portable's suites drive it in place of index.ts when
// OB1_MCP_UNDER_TEST=client (server-portable/test-support.ts mcpUnderTest),
// so the same assertions hold the MCP server as a REST client to what
// server-portable answers. Import it after the suite has set its
// environment: it adds a forwarder key of its own to MCP_ACCESS_KEYS — a
// forward-scope key, which grants nothing — before the REST core reads it.

import { randomBytes } from "node:crypto";
import { hashKey, routable } from "../server-portable/auth.ts";
import { createRestClient } from "../rest-client/index.ts";
import { outgoingTraceparent } from "../server-portable/telemetry.ts";
import { SUITE_CARRIER } from "../server-portable/test-support.ts";
import { createMcpApp, edgeFrom, REST_TIMEOUT_MS } from "./app.ts";
import { SSE_KEEPALIVE_MAX_MS, SSE_KEEPALIVE_MS } from "../server-portable/sse.ts";
import { plugins } from "../server-portable/root.ts";
import { createCallCount } from "../server-portable/shutdown.ts";

const forwarderKey = randomBytes(32).toString("hex");
process.env.MCP_ACCESS_KEYS = [process.env.MCP_ACCESS_KEYS, `${SUITE_CARRIER}:forward:${hashKey(forwarderKey)}`].filter(Boolean).join(",");

// The REST core in process, its request lines kept apart from the MCP server's — two processes' lines are — so a
// suite's request log holds the MCP server's alone, as server-portable's holds index.ts's (SMD-2287 PR 4b).
const restCore = (await import("../server-portable/api.ts")).restApp(() => {});
const rest = createRestClient({
  baseUrl: "http://api.ob1.internal",
  fetch: (req) => Promise.resolve(restCore.fetch(routable(req))),
  forwarderKey,
  timeoutMs: REST_TIMEOUT_MS,
  // The calling span's traceparent, as the entry sends it (PR 4c): the REST core continues it for its forwarder.
  headers: outgoingTraceparent,
});
// The plugins the REST core in process runs (root.ts's, read once), so this server's tools are its operations'.
// Its tool calls counted, as the entry counts them for its stop, and read by a suite as index.ts's are (toolCallsRunning).
const toolCalls = createCallCount();
// The keepalive's timing, read by each request: sse.ts's defaults, until a suite stalls a call in a fraction of a second (useKeepaliveTiming).
const keepalive = { intervalMs: SSE_KEEPALIVE_MS, maxMs: SSE_KEEPALIVE_MAX_MS };
const app = createMcpApp({ rest, plugins, toolCalls, keepalive, edge: () => edgeFrom({ COMPOSE_PROFILES: process.env.COMPOSE_PROFILES, OB1_PUBLIC_ORIGIN: process.env.OB1_PUBLIC_ORIGIN }) });

export default {
  // A request whose URL will not parse, rebuilt so it is routed and refused, not a 500 (SMD-2535).
  fetch: (req: Request) => app.fetch(routable(req)),
  /** The tool calls running, as index.ts's toolCallsRunning says its own. */
  toolCallsRunning: (): number => toolCalls.running,
  /** Sets the keepalive's timing for the calls that follow, returning the one it replaced, as index.ts's useKeepaliveTiming. */
  useKeepaliveTiming: (next: { intervalMs: number; maxMs: number }) => {
    const previous = { ...keepalive };
    Object.assign(keepalive, next);
    return previous;
  },
};
