// The operator GUI's entry (SMD-2280): `bun serve.ts` starts the SvelteKit
// server `bun run build` wrote to build/ (adapter-node), on PORT (8000 unless
// set). Compose's `app` service runs it in the server image as
// `bun ../dashboard/serve.ts`; the proxy routes /dashboard to it as
// app.ob1.internal on the mesh, the path kept.
//
// What it sets before the server loads is the origin SvelteKit judges a form's
// post by and the session cookie's Secure by:
//   - OB1_PUBLIC_ORIGIN, when it is a sound public origin (SMD-2382's rules,
//     server-portable/oauth-edge.ts): the https origin a TLS proxy or tunnel
//     serves, never derived from a request. An unsound one is warned of and
//     passed over.
//   - Otherwise the request's Host with the scheme the proxy saw, from its
//     X-Forwarded-Proto — `http`, since the stack's proxy terminates no TLS,
//     and Traefik replaces any X-Forwarded-Proto a client sends. So a stack
//     reached over plain HTTP on the loopback or a LAN address signs in as it
//     is reached, and one behind TLS needs OB1_PUBLIC_ORIGIN, or a form's post
//     is refused, its origin not the one the GUI reads.
// It also sets adapter-node's drain and body limit (below), and reads
// OB1_REST_URL (the REST core, api.ob1.internal on the mesh unless set),
// OB1_STOP_GRACE (the stop's grace, as the servers read it), COMPOSE_PROFILES
// (key sign-in is off while it names auth, but on the break-glass port, whose
// own origin BREAKGLASS_PORT names) and GRAFANA_LINK or GRAFANA_ROUTE
// (the Grafana link, set by the overlays that reach Grafana).
// It holds no brain key of its own: each visitor's key or token is the call's. Its one
// secret is OB1_AUTH_SECRET_GUI, its credential as the authorization server's `gui`
// client, which signs the operator in through it while the stack is configured (SMD-3307).

import { createRestClient, DEFAULT_REST_URL } from "../rest-client/index.ts";
import { configuredIn, originProblem } from "../server-portable/oauth-edge.ts";
import { drainBoundFrom } from "../server-portable/shutdown.ts";

const env = process.env;

/** Exit 2 with the reason, before the server listens: a setting it cannot serve with. */
function refuse(why: string): never {
  console.error(`dashboard: ${why}`);
  process.exit(2);
}

// The REST core's address, held here so a bad one stops the start rather than every page.
try {
  createRestClient({ baseUrl: env.OB1_REST_URL?.trim() || DEFAULT_REST_URL });
} catch (err) {
  refuse(`OB1_REST_URL will not serve: ${(err as Error).message}`);
}

// adapter-node's own settings, from this file alone: a stray one in the environment would steer the origin.
for (const name of ["ORIGIN", "PROTOCOL_HEADER", "HOST_HEADER", "PORT_HEADER", "ADDRESS_HEADER", "XFF_DEPTH", "SOCKET_PATH", "SHUTDOWN_TIMEOUT", "BODY_SIZE_LIMIT"]) delete env[name];
// A stop drains within the platform's grace (OB1_STOP_GRACE, as the servers
// read it, less 2 s): adapter-node waits 30 s by default, past compose's 10 s,
// so a stop with a request stuck on the REST core ended in the kill with every
// open request cut off unanswered (review pass 4). Its drain in whole seconds,
// rounded down so it ends inside the bound, a second at least.
const drain = drainBoundFrom(env.OB1_STOP_GRACE);
if (drain.problem) console.warn(`dashboard: ${drain.problem}`);
env.SHUTDOWN_TIMEOUT = String(Math.max(1, Math.floor(drain.drainBoundMs / 1000)));
// …and a deadline of the stop's own, as the servers' drainOnSignal has: a
// request whose REST call never answers outlives adapter-node's drain when
// SvelteKit has no signal to abort it with — a sign-in's POST, whose signal it
// never aborts once the body is read — and the process waited for the kill
// (review pass 5: 10.15 s, exit 137). At the bound plus a second, inside the
// grace, it exits, saying so.
const deadlineMs = Math.min(drain.drainBoundMs + 1000, drain.graceS * 1000 - 250);
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    // A second signal ends the wait, as the servers' drainOnSignal does (review pass 6).
    if (stopping) {
      console.error(`dashboard: a second ${signal} during the stop; exit`);
      process.exit(1);
    }
    stopping = true;
    setTimeout(() => {
      console.error(`dashboard: a request still open ${deadlineMs} ms into the stop, past the drain; exit`);
      process.exit(1);
    }, deadlineMs).unref();
  });
}
// The largest body the GUI takes is a thought's text, edited or captured (SMD-3322), posted as multipart so its text is not
// percent-encoded (three bytes a byte for anything not ASCII): 1 MB, which the edit page holds a thought's text under
// as a browser posts it (TEXT_MAX_BYTES, postedBytes), saying so of a thought past it rather than letting its Save
// fail. Every other request — the sign-in form's key, signed out, among them — is held to 64 kB by its declared
// length in hooks.server.ts, as all were before.
env.BODY_SIZE_LIMIT = "1M";
const publicOrigin = env.OB1_PUBLIC_ORIGIN?.trim();
const problem = publicOrigin ? originProblem(publicOrigin) : null;
if (publicOrigin && !problem) {
  env.ORIGIN = new URL(publicOrigin).origin;
} else {
  // Not refused: the authorization server and the MCP server say so too, and
  // the dashboard still serves the address it is reached by.
  if (problem) console.warn(`dashboard: ${problem}; signing in at the address each request names instead.`);
  env.PROTOCOL_HEADER = "x-forwarded-proto";
}
// Configured for the authorization server, the GUI signs in only through it (SMD-3307), as its `gui` client:
// without the client's secret, or a sound origin to redirect through, it offers none on the origin (the
// break-glass port takes an access key whatever its settings). Said at the start, as the MCP server says its
// own (the sign-in page says it too).
if (configuredIn(env.COMPOSE_PROFILES)) {
  if (!env.OB1_AUTH_SECRET_GUI?.trim()) console.warn("dashboard: COMPOSE_PROFILES names auth but OB1_AUTH_SECRET_GUI is not set, so no sign-in is offered but an access key on the break-glass port: set it in deploy/.env (provision.ts --init writes it) and recreate app.");
  else if (!publicOrigin || problem) console.warn("dashboard: COMPOSE_PROFILES names auth but OB1_PUBLIC_ORIGIN is not a sound origin, so no sign-in through the authorization server is offered.");
}
env.PORT ||= "8000";
env.HOST ||= "0.0.0.0";

await import("./build/index.js");
