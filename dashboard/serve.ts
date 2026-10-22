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
//     is refused as cross-site.
// It reads OB1_REST_URL (the REST core, api.ob1.internal on the mesh unless
// set), COMPOSE_PROFILES (key sign-in is off while it names auth) and
// GRAFANA_LINK (the Grafana link, set by the overlays that reach Grafana).
// It holds no key and no secret of its own: each visitor's key is the call's.

import { createRestClient, DEFAULT_REST_URL } from "../rest-client/index.ts";
import { originProblem } from "../server-portable/oauth-edge.ts";

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
for (const name of ["ORIGIN", "PROTOCOL_HEADER", "HOST_HEADER", "PORT_HEADER", "ADDRESS_HEADER", "XFF_DEPTH", "SOCKET_PATH"]) delete env[name];
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
env.PORT ||= "8000";
env.HOST ||= "0.0.0.0";

await import("./build/index.js");
