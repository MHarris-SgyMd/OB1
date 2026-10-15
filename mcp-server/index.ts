// The MCP server's entry (SMD-2287): `bun index.ts` serves app.ts on PORT —
// as mcp.ob1.internal on the stack's mesh and at /mcp through the proxy once
// SMD-2287 PR 5 gives it a compose service (server-portable's is there now).
// It calls the REST core at OB1_REST_URL with OB1_FORWARDER_KEY — a
// forward-scope key MCP_ACCESS_KEYS holds (`bun keygen.ts --scope forward`) —
// beside each caller's key, and reads OB1_PLUGINS as the REST core does, for
// the enabled plugins' tools. It reads no store and holds no key list: what a
// key may do is the REST core's to say.

import { createRestClient } from "../rest-client/index.ts";
import { loadPlugins, type LoadedPlugin } from "../server-portable/core/plugins.ts";
import { routable } from "../server-portable/auth.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "../server-portable/shutdown.ts";
import { cutOpenRequests } from "../server-portable/telemetry.ts";
import { createMcpApp, edgeFrom, REST_TIMEOUT_MS } from "./app.ts";

/** Where the REST core answers on the mesh unless OB1_REST_URL says otherwise. */
export const DEFAULT_REST_URL = "http://api.ob1.internal.:8000";

const env = process.env;
const forwarderKey = env.OB1_FORWARDER_KEY?.trim();
if (import.meta.main && !forwarderKey) {
  console.error("OB1_FORWARDER_KEY is not set: the MCP server forwards each caller's key to the REST core beside a forward-scope key of its own (`cd server-portable && bun keygen.ts <name> --scope forward`, its hash in MCP_ACCESS_KEYS).");
  process.exit(2);
}

const baseUrl = env.OB1_REST_URL?.trim() || DEFAULT_REST_URL;
function restClient() {
  try {
    return createRestClient({ baseUrl, forwarderKey: forwarderKey || undefined, timeoutMs: REST_TIMEOUT_MS });
  } catch (err) {
    if (!import.meta.main) throw err;
    console.error(`OB1_REST_URL or OB1_FORWARDER_KEY will not serve: ${(err as Error).message}`);
    process.exit(2);
  }
}
const rest = restClient();

// The enabled plugins (SMD-2310), as the REST core reads OB1_PLUGINS: their operations' schemas and routes, read at
// the start so a name that is no plugin stops the server there — exit 2 in words, where the REST core stops on its throw.
function enabledPlugins(): LoadedPlugin[] {
  try {
    return loadPlugins(env.OB1_PLUGINS);
  } catch (err) {
    if (!import.meta.main) throw err;
    console.error(`OB1_PLUGINS will not serve: ${(err as Error).message}`);
    process.exit(2);
  }
}
const plugins = enabledPlugins();
/** The tool calls running, counted for the stop (SMD-2250), as index.ts counts its own: a call whose client left still runs to its end. */
const toolCalls = createCallCount();
/** The stop's word: set when it cuts what is still in flight, so a request it ends then is `cut`, not `abandoned`. */
const stop = { cut: false };
const app = createMcpApp({ rest, plugins: () => plugins, toolCalls, stop, restUrl: baseUrl.replace(/\/\/[^/@]*@/, "//…@"), edge: () => edgeFrom({ COMPOSE_PROFILES: env.COMPOSE_PROFILES, OB1_PUBLIC_ORIGIN: env.OB1_PUBLIC_ORIGIN }) });

let bunServer: Stoppable | undefined;
if (import.meta.main) {
  const grace = drainBoundFrom(env.OB1_STOP_GRACE);
  if (grace.problem) console.warn(grace.problem);
  // As index.ts stops (SMD-2250): the server's own requests in flight, and the tool calls a request no longer counts
  // (a client gone mid-call). No store to close here — the REST core holds it — so the stop says no pool was opened.
  drainOnSignal({
    drainBoundMs: grace.drainBoundMs,
    server: () => bunServer,
    calls: toolCalls,
    close: async () => false,
    // A record still open — a mirror whose client left while it waits — ends before the exit, on every path (index.ts's).
    endOpen: cutOpenRequests,
    onCut: () => {
      // Every request still in flight gets its line, `cut`, before the process exits (SMD-1849).
      stop.cut = true;
      cutOpenRequests();
    },
  });
}

/** The server's idle timeout, in seconds: Bun's ceiling, as the REST core's (server-portable/api.ts says why). */
export const IDLE_TIMEOUT_S = 255;

export default {
  // An empty PORT is unset, not port 0 (SMD-1799).
  port: Number(env.PORT || 8000),
  // Its job polls and mirrors are GETs that wait on the REST core: Bun's 10 s default cuts such a GET (review pass 3).
  idleTimeout: IDLE_TIMEOUT_S,
  fetch: (req: Request, server?: unknown) => {
    if (import.meta.main && !bunServer && isStoppable(server)) bunServer = server;
    // A request whose URL will not parse, rebuilt so it is routed and refused, not a 500 (SMD-2535).
    return app.fetch(routable(req));
  },
};
