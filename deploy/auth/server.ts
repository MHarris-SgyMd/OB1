/**
 * server.ts — the brain's authorization server (SMD-2285, ADR decision 13): a
 * small Bun service of our own around oidc-provider 9.12.2, served through
 * node:http, with its issuer at `<origin>/auth`. It runs as deploy/compose.yaml's
 * `auth` profile. Its resources and clients come from layout.ts, read from the
 * environment (OB1_PUBLIC_ORIGIN, OB1_AUTH_TIERS, OB1_AUTH_SERVICES), and
 * every setting it reads is checked at start by config.ts, which names every
 * problem at once and stops it starting. It won the proof of concept, which
 * runs this file's image: `bun evals/eval-auth.ts --verify oidc-provider`.
 *
 * What is ours, beside the library's configuration:
 * - the token-exchange grant (RFC 8693). Only an `exchange` client from
 *   layout.ts may use it. The subject token must be an access token this
 *   server signed for that client's MCP resource (so never an exchanged one,
 *   whose audience is a REST core); the result is a token for the same tier's
 *   REST core with the same subject,
 *   no wider scope, no later expiry, and `act: { sub: <the MCP client> }`;
 * - `getResourceServerInfo`, which the library says MUST be replaced: a
 *   resource outside the layout, or outside the client's allowance, is
 *   `invalid_target`. A request that names no resource is refused before
 *   anything is issued (`defaultResource`), so every access token the server
 *   hands out is a JWT for exactly one audience;
 * - a third-party client (DCR or CIMD) may register for authorization code
 *   and refresh only. Without that rule, anyone could self-register for
 *   client credentials and hold an /mcp token no user ever approved;
 * - URLs built from the configured origin, never the request's `Host`, so a
 *   spoofed `Host` cannot move the endpoints the metadata names;
 * - the `fetch` option (fetch-guard.ts): the library's own SSRF protection
 *   does not load under Bun;
 * - sign-in and consent pages. The operator signs in by password, checked
 *   against an argon2id hash from the environment (decision 15's fallback);
 *   passkeys wait for the public origin (SMD-2382), and the loopback
 *   break-glass is the GUI's (SMD-2286).
 *   Consent is asked of every client, first-party ones included, and names
 *   what the server has checked, not what the client calls itself: the
 *   `client_id` (for a metadata document, its host); where the code goes (an
 *   http(s) redirect's origin, or for any other scheme the app that owns it);
 *   and the scopes and resources the request names, which the library has
 *   validated by then and which bound what the token can carry;
 * - the library's features the brain does not use are off: userinfo (every
 *   access token is bound to a resource, so it could never answer), RP-initiated
 *   logout, pushed authorization requests and DPoP;
 * - POC ONLY, behind OB1_AUTH_POC_ERROR_DETAIL=1 (set by the POC's compose
 *   file alone): error replies carry the library's `error_detail`, so the
 *   verifier can tell one refusal's cause from another's. The library withholds
 *   it on purpose: it says what a name resolves to and whether a client id
 *   exists. Off unless that variable is set, and the start logs a warning when
 *   it is. deploy/compose.yaml does not pass it, so deploy/.env cannot turn it
 *   on, and CI holds the rendered service to that.
 *
 * The routes it answers, all through the proxy:
 * - `/auth/*`, the provider itself, mounted under the issuer's path;
 * - `/.well-known/oauth-authorization-server/auth`,
 *   `/.well-known/openid-configuration/auth` and the bare
 *   `/.well-known/oauth-authorization-server` (Claude Code 2.1.275 reads only
 *   that one: anthropics/claude-code#95270). All three serve the provider's
 *   OpenID document, whose `issuer` is `<origin>/auth`;
 * - `/healthz`, for compose.
 *
 * State is one SQLite file (store.ts) in the `auth` service's own volume, so a
 * restart keeps every session, grant, refresh token and registered client.
 * It holds no Postgres credential and reaches no database.
 */
import http from "node:http";
import Provider, { errors, type ClientMetadata, type KoaContextWithOIDC, type ResourceServer } from "oidc-provider";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { guardedFetch } from "./fetch-guard.ts";
import { consentPage, esc, loginPage, PAGE_HEADERS, pageHtml, type Asking } from "./pages.ts";
import { configFromEnv, type Config } from "./config.ts";
import { ACCESS_TOKEN_TYPE, SCOPES, TOKEN_EXCHANGE } from "./layout.ts";
import { CLOCK_TOLERANCE, sqliteAdapter } from "./store.ts";

let C: Config;
try {
  C = configFromEnv();
} catch (e) {
  // Exit 2, the restart policy brings it back, and its log says why each time (the n8n pattern in deploy/compose.yaml).
  console.error((e as Error).message);
  process.exit(2);
}
const L = C.layout;
let store: ReturnType<typeof sqliteAdapter>;
try {
  store = sqliteAdapter(C.dbPath);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const OPERATOR = "operator";
const ACCESS_TTL = 600;
/** The public half of the signing keys, to verify a subject token without a network hop. */
const ownKeys = createLocalJWKSet({ keys: C.jwks.keys.map(({ d, ...pub }) => pub as JWK) });

/** The only grant types a client without a policy entry (DCR, CIMD) may register. */
const THIRD_PARTY_GRANTS = new Set(["authorization_code", "refresh_token"]);

const clients = Object.entries(L.clients).map(([client_id, p]): ClientMetadata => {
  const base = { client_id, client_secret: C.secrets[client_id], token_endpoint_auth_method: "client_secret_basic" as const };
  if (p.kind === "gui") return { ...base, grant_types: ["authorization_code"], response_types: ["code"], redirect_uris: [p.redirect] };
  if (p.kind === "service") return { ...base, grant_types: ["client_credentials"], response_types: [], redirect_uris: [], scope: p.scope };
  return { ...base, grant_types: [TOKEN_EXCHANGE], response_types: [], redirect_uris: [] };
});

/** POC ONLY (see the header): the library's internal reason for a refusal, which it never sends itself. */
const POC_ERROR_DETAIL = C.pocErrorDetail;
if (POC_ERROR_DETAIL) console.warn("WARNING: OB1_AUTH_POC_ERROR_DETAIL is on — error replies name their cause (whether a client id exists, what a name resolves to). The proof of concept's switch; never a deploy's.");
function detailOf(error: unknown): { error_detail?: string } {
  if (!POC_ERROR_DETAIL) return {};
  const detail = (error as { error_detail?: unknown } | undefined)?.error_detail;
  const cause = (error as { cause?: { message?: string } } | undefined)?.cause?.message;
  const text = typeof detail === "string" ? detail : cause;
  return text ? { error_detail: text } : {};
}

function resourceInfo(resource: string): ResourceServer {
  return { scope: SCOPES.join(" "), audience: resource, accessTokenTTL: ACCESS_TTL, accessTokenFormat: "jwt", jwt: { sign: { alg: "ES256" } } };
}

const provider = new Provider(L.issuer, {
  adapter: store,
  // The library's default, named: the store keeps each row this long past its expiry, as the memory adapter did.
  clockTolerance: CLOCK_TOLERANCE,
  clients,
  jwks: C.jwks,
  cookies: { keys: C.cookieKeys },
  async findAccount(_ctx, id) {
    return id === OPERATOR ? { accountId: id, claims: async () => ({ sub: id }) } : undefined;
  },
  // The brain's scopes are resource scopes, but a client's registered `scope` is checked against this list too.
  scopes: ["openid", "offline_access", ...SCOPES],
  // Access tokens take their resource's accessTokenTTL, which the library's default ttl functions read; a number here would override it.
  ttl: { Interaction: 600, Session: 86_400, Grant: 30 * 86_400, AuthorizationCode: 60 },
  // The one signing key is P-256, so a registered client's ID token defaults to ES256 (the library's default is RS256).
  clientDefaults: { id_token_signed_response_alg: "ES256" },
  enabledJWA: { idTokenSigningAlgValues: ["ES256"] },
  pkce: { required: () => true },
  // Code only: no implicit or hybrid flow (OAuth 2.1, the MCP authorization spec).
  responseTypes: ["code"],
  extraClientMetadata: {
    // A marker property, so the validator runs on every client: static, DCR and CIMD alike.
    properties: ["ob1_third_party_rule"],
    validator(_ctx, key, _value, metadata) {
      if (key !== "ob1_third_party_rule") return;
      delete (metadata as Record<string, unknown>)[key];
      if (Object.hasOwn(L.clients, String(metadata.client_id))) return;
      const declared = metadata.grant_types as unknown;
      if (declared !== undefined && (!Array.isArray(declared) || declared.some((g) => typeof g !== "string"))) {
        throw new errors.InvalidClientMetadata("grant_types must be an array of strings");
      }
      const grants = (declared as string[] | undefined) ?? ["authorization_code"];
      const refused = grants.filter((g) => !THIRD_PARTY_GRANTS.has(g));
      if (refused.length) throw new errors.InvalidClientMetadata(`a third-party client may use authorization_code and refresh_token only, not ${refused.join(", ")}`);
    },
  },
  routes: { authorization: "/authorize" },
  interactions: { url: (_ctx, interaction) => `/auth/interaction/${interaction.uid}` },
  features: {
    devInteractions: { enabled: false },
    clientCredentials: { enabled: true },
    registration: { enabled: true },
    revocation: { enabled: true },
    // Nothing in the stack checks a DPoP proof, and the exchange would turn a
    // bound /mcp token into a bearer REST-core one: off until both do.
    dPoP: { enabled: false },
    userinfo: { enabled: false },
    rpInitiatedLogout: { enabled: false },
    pushedAuthorizationRequests: { enabled: false },
    resourceIndicators: {
      enabled: true,
      // Called when a request names no resource: refuse it there, before a
      // sign-in, a consent or a spent code. `oneOf` is the granted list at the
      // token endpoint, where the client must still pick one if it has several.
      defaultResource: async (_ctx, _client, oneOf) => {
        if (oneOf) return oneOf;
        throw new errors.InvalidTarget("name the resource this token is for");
      },
      useGrantedResource: async () => true,
      async getResourceServerInfo(_ctx, resource, client) {
        if (!L.resources.includes(resource)) throw new errors.InvalidTarget(`${resource} is not a resource of this server`);
        if (!L.allowedResources(client.clientId).includes(resource)) throw new errors.InvalidTarget(`this client may not ask for ${resource}`);
        return resourceInfo(resource);
      },
    },
    clientIdMetadataDocument: { enabled: true, ack: "draft-02" },
  },
  fetch: guardedFetch(),
  // The actor of an exchange is the client that authenticated to make it.
  async extraTokenClaims(ctx, token) {
    if ((token as { gty?: string }).gty !== "token_exchange" || ctx?.oidc.params?.grant_type !== TOKEN_EXCHANGE) return undefined;
    return { act: { sub: ctx.oidc.client!.clientId } };
  },
  async renderError(ctx, out, error) {
    ctx.type = "json";
    ctx.body = { error: out.error, error_description: out.error_description, ...detailOf(error) };
  },
});
provider.proxy = true;

// POC ONLY (see the header): token-endpoint refusals carry their detail too.
// A fault of the server's own (the store full or locked, a bug) answers
// `server_error` with nothing internal in the body, and the library reports it
// only on this event: logged here, or `compose logs` would show nothing.
provider.on("server_error", (_ctx, error) => console.error(`server error: ${(error as Error).stack ?? (error as Error).message}`));

provider.on("grant.error", (ctx, error) => {
  if (ctx.body && typeof ctx.body === "object") Object.assign(ctx.body, detailOf(error));
});

const EXCHANGE_PARAMS = ["subject_token", "subject_token_type", "actor_token", "actor_token_type", "requested_token_type", "resource", "audience", "scope"];

provider.registerGrantType(TOKEN_EXCHANGE, async (ctx: KoaContextWithOIDC) => {
  const { params, client } = ctx.oidc as unknown as { params: Record<string, string | undefined>; client: { clientId: string } };
  // The library refuses a client without this grant before the handler runs;
  // this line narrows the policy's type, and holds if the two ever drift.
  const policy = Object.hasOwn(L.clients, client.clientId) ? L.clients[client.clientId] : undefined;
  if (policy?.kind !== "exchange") throw new errors.UnauthorizedClient("this client may not exchange tokens");
  if (!params.subject_token) throw new errors.InvalidRequest("subject_token is required");
  if (params.subject_token_type !== ACCESS_TOKEN_TYPE) throw new errors.InvalidRequest(`subject_token_type must be ${ACCESS_TOKEN_TYPE}`);
  if (params.actor_token || params.actor_token_type) throw new errors.InvalidRequest("the actor is the authenticated client; actor_token is not accepted");
  if (params.requested_token_type && params.requested_token_type !== ACCESS_TOKEN_TYPE) throw new errors.InvalidRequest(`requested_token_type must be ${ACCESS_TOKEN_TYPE}`);
  if (params.audience) throw new errors.InvalidRequest("name the target with resource, not audience");
  if (params.resource !== policy.to) throw new errors.InvalidTarget(`this client exchanges for ${policy.to} only`);

  let claims: { sub?: string; scope?: string; exp?: number; act?: unknown };
  try {
    ({ payload: claims } = await jwtVerify(params.subject_token, ownKeys, { issuer: L.issuer, audience: policy.from, algorithms: ["ES256"], typ: "at+jwt" }));
  } catch (cause) {
    // jose's code, and the claim for a claim failure (`aud`), name the cause in the POC's error_detail.
    const { code, claim } = cause as { code?: string; claim?: string };
    throw new errors.InvalidGrant(`subject_token is not a valid access token for this client's resource (${code ?? "invalid"}${claim ? ` ${claim}` : ""})`);
  }
  // No `act` check: an exchanged token's audience is a REST core, which the audience rule above already refuses.
  if (claims.sub !== OPERATOR) throw new errors.InvalidGrant("subject_token names no known account");

  const held = new Set((claims.scope ?? "").split(" ").filter(Boolean));
  const asked = params.scope ? params.scope.split(" ").filter(Boolean) : [...held];
  const wider = asked.filter((s) => !held.has(s));
  if (wider.length) throw new errors.InvalidScope(`scope wider than the subject token's: ${wider.join(" ")}`, wider.join(" "));

  // Never outlive the token it was exchanged from. `exp` is set outright: the
  // library stamps `token.exp || now + expiration`, and a TTL alone lands a
  // second late when the save crosses a second boundary.
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + ACCESS_TTL, claims.exp ?? 0);
  if (exp - now < 1) throw new errors.InvalidGrant("subject_token has expired");
  // No grantId: the token stands on its subject token, not on a grant of its
  // own. The library takes none here; its published types insist on one.
  const fields = { accountId: claims.sub, client: ctx.oidc.client!, scope: asked.join(" "), gty: "token_exchange", expiresIn: exp - now };
  const token = new provider.AccessToken(fields as typeof fields & { grantId: string });
  token.resourceServer = new provider.ResourceServer(policy.to, resourceInfo(policy.to));
  token.exp = exp;
  ctx.oidc.entity("AccessToken", token);
  const value = await token.save();
  ctx.body = { access_token: value, issued_token_type: ACCESS_TOKEN_TYPE, token_type: "Bearer", expires_in: exp - now, scope: token.scope };
}, EXCHANGE_PARAMS);

// --- sign-in and consent --------------------------------------------------

function send(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, PAGE_HEADERS);
  res.end(html);
}
const page = (res: http.ServerResponse, status: number, prompt: string, body: string) => send(res, status, pageHtml(prompt, body));

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new errors.InvalidRequest("form too large");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString());
}

async function interaction(req: http.IncomingMessage, res: http.ServerResponse, path: string) {
  const [, uid, action] = /^\/auth\/interaction\/([^/]+)(?:\/(login|confirm|abort))?$/.exec(path) ?? [];
  if (!uid) return page(res, 404, "none", "not found");
  const details = await provider.interactionDetails(req, res);
  if (details.uid !== uid) return page(res, 400, "none", "interaction mismatch");
  const { prompt, params, session } = details;
  const client = await provider.Client.find(String(params.client_id));

  const asking: Asking = {
    clientId: String(params.client_id),
    clientName: client?.clientName as string | undefined,
    redirectUri: String(params.redirect_uri),
    // What the request names, validated by the library before this page: the
    // token can carry no scope or resource beyond these. (prompt.details lists
    // only what the grant still lacks, which is empty on a repeat consent.)
    scope: String(params.scope ?? ""),
    resources: [params.resource ?? []].flat().map(String).filter(Boolean),
  };
  const base = `/auth/interaction/${encodeURIComponent(uid)}`;
  if (req.method === "GET" && !action) {
    if (prompt.name === "login") return send(res, 200, loginPage(asking, `${base}/login`));
    return send(res, 200, consentPage(asking, `${base}/confirm`, `${base}/abort`));
  }
  if (req.method !== "POST") return page(res, 405, "none", "method not allowed");
  // The interaction is bound to this browser's cookie already; a POST from another origin is refused as well (both candidates do).
  if (req.headers.origin !== L.origin) return page(res, 403, "none", "this form must be posted from the brain's own origin");

  if (action === "abort") return provider.interactionFinished(req, res, { error: "access_denied", error_description: "the operator denied the request" }, { mergeWithLastSubmission: false });
  if (action === "login") {
    if (prompt.name !== "login") return page(res, 400, "none", "not a sign-in step");
    const form = await readForm(req);
    if (!(await Bun.password.verify(form.get("password") ?? "", C.passwordHash).catch(() => false))) {
      return send(res, 401, loginPage(asking, `${base}/login`, true));
    }
    return provider.interactionFinished(req, res, { login: { accountId: OPERATOR, amr: ["pwd"] } }, { mergeWithLastSubmission: false });
  }
  if (action === "confirm") {
    if (prompt.name !== "consent") return page(res, 400, "none", "not a consent step");
    const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: session!.accountId, clientId: String(params.client_id) });
    if (!grant) return page(res, 400, "none", "grant not found");
    const d = prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[]; missingResourceScopes?: Record<string, string[]> };
    if (d.missingOIDCScope) grant.addOIDCScope(d.missingOIDCScope.join(" "));
    if (d.missingOIDCClaims) grant.addOIDCClaims(d.missingOIDCClaims);
    for (const [indicator, scopes] of Object.entries(d.missingResourceScopes ?? {})) grant.addResourceScope(indicator, scopes.join(" "));
    const grantId = await grant.save();
    return provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
  }
  return page(res, 404, "none", "not found");
}

// --- routing ---------------------------------------------------------------

/** The discovery paths outside the issuer's own, each answered with the provider's OpenID document. */
const DISCOVERY = new Set(["/.well-known/oauth-authorization-server/auth", "/.well-known/openid-configuration/auth", "/.well-known/oauth-authorization-server"]);
const callback = provider.callback();

/** Hand a request to the provider as if it were mounted at /auth (the way express's router sets these). */
function mount(req: http.IncomingMessage, inner: string) {
  const r = req as http.IncomingMessage & { originalUrl?: string; baseUrl?: string };
  r.originalUrl = req.url;
  r.baseUrl = "/auth";
  req.url = inner;
}

const ORIGIN = new URL(L.origin);

const server = http.createServer((req, res) => {
  // The provider builds every URL from the request's host and protocol (it
  // trusts X-Forwarded-* with proxy = true). Pin both to the configured origin.
  req.headers.host = ORIGIN.host;
  req.headers["x-forwarded-host"] = ORIGIN.host;
  req.headers["x-forwarded-proto"] = ORIGIN.protocol.slice(0, -1);
  const url = new URL(req.url ?? "/", "http://auth");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (DISCOVERY.has(url.pathname)) {
    mount(req, `/.well-known/openid-configuration${url.search}`);
    return callback(req, res);
  }
  if (url.pathname.startsWith("/auth/interaction/")) {
    return interaction(req, res, url.pathname).catch((e: Error) => {
      console.error(`interaction failed: ${e instanceof errors.OIDCProviderError ? (e.error_description ?? e.message) : (e.stack ?? e.message)}`);
      if (res.headersSent) return;
      // The library's own refusals (an expired or unknown interaction) say what
      // went wrong; anything else is the server's fault and says nothing of it.
      if (e instanceof errors.OIDCProviderError) return page(res, e.status, "none", esc(e.error_description ?? e.message));
      page(res, 500, "none", "something went wrong on the server; try again, and see its log");
    });
  }
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
    mount(req, (req.url ?? "").slice("/auth".length) || "/");
    return callback(req, res);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(3000, "0.0.0.0", () => console.log(`oidc-provider on Bun ${Bun.version}: issuer ${L.issuer}`));

// A stop (compose's SIGTERM) closes the listener, lets the requests in flight
// finish for up to 5 s, closes the store and exits; without a handler Bun
// ignored the signal and every stop waited out the grace period for SIGKILL
// (server-portable/shutdown.ts measured the same). A second signal, or the
// bound, cuts the wait short with exit 1.
let stopping = false;
function stop(signal: string) {
  const done = (code: number) => {
    store.close();
    console.log(`stopped on ${signal}${code ? ", requests still in flight cut off" : ""}`);
    process.exit(code);
  };
  if (stopping) return done(1);
  stopping = true;
  server.close(() => done(0));
  server.closeIdleConnections();
  setTimeout(() => done(1), 5000).unref();
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
