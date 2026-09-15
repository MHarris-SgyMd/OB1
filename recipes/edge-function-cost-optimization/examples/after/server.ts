// ✅ Module-scope McpServer singletons — one per key scope, each constructed
// exactly ONCE per cold-start, on the first request that needs it.
//
// Each tool module exports a `register(server, principal)` function; a tool
// that writes is registered only `if (canWrite(principal))`, so the server a
// read-scoped key is handed never had those tools (ob1-fork, SMD-1455).
// Adding a new extension means: drop a new file in `tools/`, add one import,
// add one `register()` call. No per-request reconstruction — two servers at
// most, not one per request.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite, type Principal } from "../../../_shared/auth.ts";
import { register as registerOpenBrain } from "./tools/open-brain.ts";
import { register as registerHousehold } from "./tools/household.ts";
import { register as registerMeal } from "./tools/meal.ts";
import { register as registerCrm } from "./tools/crm.ts";

const servers = new Map<boolean, McpServer>();

/** The server for this principal's scope, built on first use. */
export function serverFor(principal: Principal): McpServer {
  const write = canWrite(principal);
  let server = servers.get(write);
  if (!server) {
    server = new McpServer({
      name: "open-brain-unified",
      version: "2.0.0",
    });
    registerOpenBrain(server, principal);
    registerHousehold(server, principal);
    registerMeal(server, principal);
    registerCrm(server, principal);
    servers.set(write, server);
  }
  return server;
}
