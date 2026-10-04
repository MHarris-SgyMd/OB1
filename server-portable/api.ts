// The REST core (SMD-2284): one internal HTTP process that answers JSON for
// every operation the MCP tools expose, over the same core and the same
// process root as the MCP server (root.ts). Its routes, its authorization and
// its OpenAPI document are rest/'s; this file builds the core under its own
// door and serves it. Run as `bun api.ts`; reached as api.ob1.internal on the
// stack's mesh once SMD-2284's PR 3 adds the service, public only where the
// operator turns /api on.

import { agents, closeStore, db, env, initEnv } from "./root.ts";
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
// Not serveHere() yet: the store's first build would wire the durable job
// store and reconcile every live job in it to lost — the MCP server's too,
// on the same database (store-sql.ts's reconcileRunningLost). Until SMD-2284's
// PR 3 scopes that reconcile to the server that started a job, this server's
// jobs live in its memory alone (jobs.ts, as on Workers).
if (SERVES_ON_BUN) {
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
    return calls.track(() => app.fetch(req));
  },
};
