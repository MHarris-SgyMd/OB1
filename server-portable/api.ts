// The REST core (SMD-2284): one internal HTTP process that answers JSON for
// every operation the MCP tools expose, over the same core and the same
// process root as the MCP server (root.ts). Its routes, its authorization and
// its OpenAPI document are rest/'s; this file builds the core under its own
// door and serves it. Run as `bun api.ts` — the stack's `api` service,
// reached as api.ob1.internal on the mesh, and at /api only where the operator
// names deploy/compose.api-public.yaml.

import { agents, closeStore, db, env, initEnv, serveHere } from "./root.ts";
import { routable } from "./auth.ts";
import { createCore } from "./core/index.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "./shutdown.ts";
import { markRunningLost } from "./jobs.ts";
import { createRestApp } from "./rest/app.ts";

/**
 * The door a write through this server names in its actor (`via`), which
 * migration 046 stamps as thought_audit.origin (SMD-1730): a write made here
 * reads as the REST core's, beside the MCP server's `open-brain`.
 */
export const API_DOOR = "open-brain-api";

const core = createCore({ env, store: db, door: API_DOOR });

/** The calls running — each request and each detached job run — counted for the stop (SMD-2250). */
const calls = createCallCount();

export const app = createRestApp({
  core,
  init: () => initEnv(),
  keys: () => ({ MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS, MCP_ACCESS_KEY: env().MCP_ACCESS_KEY }),
  resolve: (principal) => agents().resolve(db(), principal),
  track: calls.track,
});

// Stopping on SIGTERM, what is in flight finished (SMD-2250), as the MCP
// server stops: only when this module is Bun's entry, never in a suite that
// imports it.
const SERVES_ON_BUN = typeof Bun !== "undefined" && import.meta.main === true;
let bunServer: Stoppable | undefined;
if (SERVES_ON_BUN) {
  // The store's first build wires the durable job store for this server: its
  // jobs carry its door and its start-up reconcile touches only those, so the
  // MCP server's live jobs on the same database are left alone (migration 078).
  serveHere(API_DOOR);
  const grace = drainBoundFrom(process.env.OB1_STOP_GRACE);
  if (grace.problem) console.warn(grace.problem);
  drainOnSignal({
    drainBoundMs: grace.drainBoundMs,
    server: () => bunServer,
    calls,
    close: closeStore,
    onCut: () => {
      const lost = markRunningLost();
      if (lost > 0) console.warn(`stop cut ${lost} running job${lost === 1 ? "" : "s"}: marked lost (SMD-2273)`);
    },
  });
}

export default {
  // An empty PORT is unset, not port 0 (SMD-1799).
  port: Number(process.env.PORT || 8000),
  fetch: (req: Request, server?: unknown) => {
    if (SERVES_ON_BUN && !bunServer && isStoppable(server)) bunServer = server;
    // A request whose URL will not parse, rebuilt so it is routed and refused, not a 500 (SMD-2535).
    return calls.track(() => app.fetch(routable(req)));
  },
};
