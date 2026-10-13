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
import { createMcpApp, edgeFrom, REST_TIMEOUT_MS } from "./app.ts";

const forwarderKey = randomBytes(32).toString("hex");
process.env.MCP_ACCESS_KEYS = [process.env.MCP_ACCESS_KEYS, `mcp-server-suite:forward:${hashKey(forwarderKey)}`].filter(Boolean).join(",");

const api = (await import("../server-portable/api.ts")).default;
const rest = createRestClient({
  baseUrl: "http://api.ob1.internal",
  fetch: (req) => Promise.resolve(api.fetch(req)),
  forwarderKey,
  timeoutMs: REST_TIMEOUT_MS,
});
const app = createMcpApp({ rest, edge: () => edgeFrom({ COMPOSE_PROFILES: process.env.COMPOSE_PROFILES, OB1_PUBLIC_ORIGIN: process.env.OB1_PUBLIC_ORIGIN }) });

export default {
  // A request whose URL will not parse, rebuilt so it is routed and refused, not a 500 (SMD-2535).
  fetch: (req: Request) => app.fetch(routable(req)),
};
