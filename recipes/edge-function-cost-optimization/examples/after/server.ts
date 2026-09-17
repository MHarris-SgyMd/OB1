// ✅ One McpServer per SESSION — built by buildServer() when index.ts mints a
// session, connected to that session's transport, and dropped with it.
//
// Each tool module exports a `register(server, principal)` function; a tool
// that writes is registered only `if (canWrite(principal))`, so the server a
// read-scoped key is handed never had those tools (ob1-fork, SMD-1455). The
// principal is the one the session was minted under: use it for canWrite()
// and nothing else — never for attribution.
// Adding a new extension means: drop a new file in `tools/`, add one import,
// add one `register()` call.
//
// Not one server per key scope, connected once per session (this file's first
// shape): a McpServer holds ONE transport, and the SDK answers a request on
// whichever transport the server holds when the message arrives — so the
// second session minted for a scope took the server's transport from the
// first, and every session but the last minted hung (ob1-fork, SMD-1497,
// FORK.md change 78). A build is tens of microseconds, once per session.

// Deno reads the SDK's types through the extensionless subpath: its exports map
// names them `./dist/esm/*.d.ts`, unreachable from `.js` (FORK.md change 81).
// @ts-types="@modelcontextprotocol/sdk/server/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Principal } from "../_shared/auth.ts";
import { register as registerOpenBrain } from "./tools/open-brain.ts";
import { register as registerHousehold } from "./tools/household.ts";
import { register as registerMeal } from "./tools/meal.ts";
import { register as registerCrm } from "./tools/crm.ts";

/** The server for one session: every tool module registered for this principal's scope. */
export function buildServer(principal: Principal): McpServer {
  const server = new McpServer({
    name: "open-brain-unified",
    version: "2.0.0",
  });
  registerOpenBrain(server, principal);
  registerHousehold(server, principal);
  registerMeal(server, principal);
  registerCrm(server, principal);
  return server;
}
