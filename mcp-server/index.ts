// The MCP server's entry (SMD-2287): `bun index.ts` serves app.ts on PORT —
// as mcp.ob1.internal on the stack's mesh and at /mcp through the proxy once
// SMD-2287 PR 5 gives it a compose service (server-portable's is there now).
// It calls the REST core at OB1_REST_URL with OB1_FORWARDER_KEY — a
// forward-scope key MCP_ACCESS_KEYS holds (`bun keygen.ts --scope forward`) —
// beside each caller's key, and reads OB1_PLUGINS as the REST core does, for
// the enabled plugins' tools. It reads no store and holds no key list: what a
// key may do is the REST core's to say. Its spans, metrics and log records go
// where OTEL_EXPORTER_OTLP_ENDPOINT says, as `open-brain-mcp` (SMD-1849, PR 4c),
// and each call on the REST core carries its span's traceparent. On a stack
// configured with the authorization server (COMPOSE_PROFILES names auth, with
// a sound OB1_PUBLIC_ORIGIN) it trades each OAuth token at the hop as the
// `mcp` client, its secret OB1_AUTH_SECRET_MCP (exchange.ts, SMD-2286).

import { createRestClient } from "../rest-client/index.ts";
import { loadPlugins, type LoadedPlugin } from "../server-portable/core/plugins.ts";
import { routable } from "../server-portable/auth.ts";
import { createCallCount, drainBoundFrom, drainOnSignal, isStoppable, type Stoppable } from "../server-portable/shutdown.ts";
import { cutOpenRequests, flushTelemetry, knowTools, outgoingTraceparent, startTelemetry } from "../server-portable/telemetry.ts";
import { createMcpApp, edgeFrom, REST_TIMEOUT_MS } from "./app.ts";
import { createExchanger, exchangeSettings } from "./exchange.ts";
import { originProblem } from "../server-portable/oauth-edge.ts";

/** Where the REST core answers on the mesh unless OB1_REST_URL says otherwise. */
export const DEFAULT_REST_URL = "http://api.ob1.internal.:8000";

/**
 * The service its signals are named for, unless OTEL_SERVICE_NAME says: apart
 * from `index.ts`'s `open-brain` while both serve (PR 5's compose service runs
 * beside it), and from the REST core's `open-brain-api`.
 */
export const SERVICE_NAME = "open-brain-mcp";

const env = process.env;
const forwarderKey = env.OB1_FORWARDER_KEY?.trim();
if (import.meta.main && !forwarderKey) {
  console.error("OB1_FORWARDER_KEY is not set: the MCP server forwards each caller's key to the REST core beside a forward-scope key of its own (`cd server-portable && bun keygen.ts --name <name> --scope forward`, its hash in MCP_ACCESS_KEYS).");
  process.exit(2);
}

const baseUrl = env.OB1_REST_URL?.trim() || DEFAULT_REST_URL;
function restClient() {
  try {
    return createRestClient({ baseUrl, forwarderKey: forwarderKey || undefined, timeoutMs: REST_TIMEOUT_MS, headers: outgoingTraceparent });
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
// Their tools named on a line and a span here, as root.ts names them for index.ts and the REST core (PR 4c: in a
// process of its own a plugin tool's line read `?`, the suites' REST core in process having named it for this one).
knowTools(plugins.flatMap((p) => p.operations.map((op) => op.tool)));
/** The tool calls running, counted for the stop (SMD-2250), as index.ts counts its own: a call whose client left still runs to its end. */
const toolCalls = createCallCount();
/** The stop's word: set when it cuts what is still in flight, so a request it ends then is `cut`, not `abandoned`. */
const stop = { cut: false };
const edge = edgeFrom({ COMPOSE_PROFILES: env.COMPOSE_PROFILES, OB1_PUBLIC_ORIGIN: env.OB1_PUBLIC_ORIGIN });
// The token exchange (SMD-2286): on a configured stack with the `mcp` client's secret; without the secret a token is
// no caller (refused as before), said once at the start rather than on every OAuth client's request.
const exchange = exchangeSettings(edge.origin, env.OB1_AUTH_SECRET_MCP);
if (import.meta.main && edge.origin && !exchange) console.warn("OB1_AUTH_SECRET_MCP is not set: this configured stack's OAuth tokens are refused here (the `mcp` client's secret, from deploy/.env, which deploy/auth/provision.ts --init writes).");
// The secret given where nothing trades: the stack is not configured or its origin unsound, said once, since tokens
// are then no caller and the start was otherwise silent (review pass 3: an operator setting only the secret saw nothing).
if (import.meta.main && !edge.origin && env.OB1_AUTH_SECRET_MCP?.trim()) {
  console.warn(`OB1_AUTH_SECRET_MCP is set, but no OAuth token is traded: ${edge.configured ? originProblem(env.OB1_PUBLIC_ORIGIN) : "COMPOSE_PROFILES does not name auth"} (set COMPOSE_PROFILES and OB1_PUBLIC_ORIGIN as the REST core has them).`);
}
const exchanger = exchange ? createExchanger(exchange) : null;
const app = createMcpApp({ rest, plugins: () => plugins, toolCalls, stop, restUrl: baseUrl.replace(/\/\/[^/@]*@/, "//…@"), edge: () => edge, exchanger: () => exchanger });

let bunServer: Stoppable | undefined;
if (import.meta.main) {
  // Spans to a collector, where one is named (OTEL_EXPORTER_OTLP_ENDPOINT), as index.ts's (PR 4c).
  void startTelemetry(SERVICE_NAME);
  const grace = drainBoundFrom(env.OB1_STOP_GRACE);
  if (grace.problem) console.warn(grace.problem);
  // As index.ts stops (SMD-2250): the server's own requests in flight, and the tool calls a request no longer counts
  // (a client gone mid-call). No store to close here — the REST core holds it — so the stop says no pool was opened.
  drainOnSignal({
    drainBoundMs: grace.drainBoundMs,
    server: () => bunServer,
    calls: toolCalls,
    close: async () => false,
    // The telemetry still batched goes under the stop's bound, said on its own (index.ts's).
    flush: flushTelemetry,
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
