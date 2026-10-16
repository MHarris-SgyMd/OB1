// The REST core (SMD-2284): one internal HTTP process that answers JSON for
// every operation the MCP tools expose, over the same core and the same
// process root as the MCP server (root.ts). Its routes, its authorization and
// its OpenAPI document are rest/'s; this file builds the core under its own
// door and serves it. Run as `bun api.ts` — the stack's `api` service,
// reached as api.ob1.internal on the mesh, and at /api only where the operator
// names deploy/compose.api-public.yaml.

import { agents, closeStore, db, env, hooks, initEnv, plugins, serveHere } from "./root.ts";
import { routable } from "./auth.ts";
import { createCore, mendIntervalFrom } from "./core/index.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "./shutdown.ts";
import { markRunningLost } from "./jobs.ts";
import { createRestApp } from "./rest/app.ts";
import { remoteChecker, tokenSettings, type TokenCheck } from "./oauth-token.ts";
import { cutOpenRequests, flushTelemetry, startTelemetry } from "./telemetry.ts";

/**
 * The door a write through this server names in its actor (`via`), which
 * migration 046 stamps as thought_audit.origin (SMD-1730): a write made here
 * reads as the REST core's, beside the MCP server's `open-brain`.
 */
export const API_DOOR = "open-brain-api";

const core = createCore({ env, store: db, door: API_DOOR });

/**
 * The token check for the stack's settings (oauth-token.ts, SMD-2286): null
 * unless configured, and one check — one cached key set — per issuer and
 * audience, so a request costs a read of the key set only when its cache says.
 */
let tokenCheck: { at: string; check: TokenCheck } | null = null;
function tokens(): TokenCheck | null {
  const settings = tokenSettings(env());
  if (!settings) return null;
  const at = `${settings.issuer} ${settings.audience}`;
  if (tokenCheck?.at !== at) tokenCheck = { at, check: remoteChecker(settings) };
  return tokenCheck.check;
}

/** The calls running — each request and each detached job run — counted for the stop (SMD-2250). */
const calls = createCallCount();

/**
 * The REST app over this core: its request lines to `log` where given, else
 * the request log (telemetry.ts). mcp-server/stack.ts gives one, so in a
 * suite the REST core's lines are apart from the MCP server's in front of it,
 * as two processes' are (SMD-2287 PR 4b). `tokenCheck` stands in for the
 * authorization server's key set on the mesh, for a suite that signs its own
 * tokens (test-rest-sql.ts, SMD-2286); a deploy gives none.
 */
export function restApp(log?: (line: string) => void, tokenCheck?: () => TokenCheck | null) {
  return createRestApp({
    core,
    init: () => initEnv(),
    keys: () => ({ MCP_ACCESS_KEYS: env().MCP_ACCESS_KEYS, MCP_ACCESS_KEY: env().MCP_ACCESS_KEY }),
    tokens: tokenCheck ?? tokens,
    resolve: (principal) => agents().resolve(db(), principal),
    track: calls.track,
    plugins,
    hooks,
    ...(log ? { log } : {}),
  });
}
export const app = restApp();

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
  // Spans to a collector, where one is named (OTEL_EXPORTER_OTLP_ENDPOINT, SMD-1849 PR 2b).
  void startTelemetry(API_DOOR);
  const grace = drainBoundFrom(process.env.OB1_STOP_GRACE);
  if (grace.problem) console.warn(grace.problem);
  // The vector mender (SMD-2889), as the MCP server starts one: a tick acts
  // only under the store's leader lock, so the two servers' menders take
  // turns, and this one goes on mending once the MCP endpoint is
  // mcp-server/'s, which holds no store (SMD-2287).
  const mend = mendIntervalFrom(process.env.OB1_VECTOR_MEND_INTERVAL);
  if (mend.problem) console.warn(mend.problem);
  const mender = mend.intervalS > 0 ? core.startVectorMender({ intervalS: mend.intervalS }) : undefined;
  drainOnSignal({
    drainBoundMs: grace.drainBoundMs,
    server: () => bunServer,
    calls,
    close: closeStore,
    // The telemetry still batched goes beside the pool's close, under its bound, said on its own.
    flush: flushTelemetry,
    // A record the runtime no longer counts but that is still open ends before that flush, on every path (PR 2c review pass 3).
    // The mender stops beside it, before the pool closes: no further row starts.
    endOpen: () => {
      mender?.stop();
      cutOpenRequests();
    },
    onCut: () => {
      // Every request still in flight gets its line — `cut`, or `abandoned`
      // for a client already gone — before the process exits — the middleware would write it after the handler, and
      // the exit comes first (SMD-1849).
      cutOpenRequests();
      const lost = markRunningLost();
      if (lost > 0) console.warn(`stop cut ${lost} running job${lost === 1 ? "" : "s"}: marked lost (SMD-2273)`);
    },
  });
}

/** The server's idle timeout, in seconds: Bun's ceiling. */
export const IDLE_TIMEOUT_S = 255;

export default {
  // An empty PORT is unset, not port 0 (SMD-1799).
  port: Number(process.env.PORT || 8000),
  // Bun's longest idle timeout, 255 s, not its 10 s default: on Bun 1.4.3 the
  // default cuts a GET whose handler has not answered yet — measured, a
  // 14-second GET reset at 12 s while a POST ran to its end — and the MCP
  // server's whoami, fetch, stats and job polls are GETs that a locked
  // table holds longer (SMD-2287 PR 3a review pass 3). A dead keep-alive
  // socket on the stack's internal network is held up to that long.
  idleTimeout: IDLE_TIMEOUT_S,

  fetch: (req: Request, server?: unknown) => {
    if (SERVES_ON_BUN && !bunServer && isStoppable(server)) bunServer = server;
    // A request whose URL will not parse, rebuilt so it is routed and refused, not a 500 (SMD-2535).
    return calls.track(() => app.fetch(routable(req)));
  },
};
