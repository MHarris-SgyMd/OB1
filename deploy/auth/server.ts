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
 * Each is matched on the request target's path as the library reads it, never
 * decoded or resolved. A target that is not a path (absolute-form, which only
 * a caller on the mesh can send: the proxy rewrites it), or that holds a
 * character the library would read another way (`#`, whitespace), is 400, and a throw in
 * the listener, or a rejection of the promise it returns, is that request's
 * 500, not the process's end; the handlers and timeouts it hands on run
 * outside that guard (target.ts, SMD-2615).
 *
 * State is one SQLite file (store.ts) in the `auth` service's own volume, so a
 * restart keeps every session, grant, refresh token and registered client.
 * It holds no Postgres credential and reaches no database.
 *
 * Registration is open, as MCP clients expect (they register before anyone
 * signs in), and bounded two ways. The store holds at most
 * OB1_AUTH_MAX_CLIENTS registered clients (200), counting the registrations
 * under way, and every spelling the library routes to registration is held to
 * it (registration.ts): past that, a registration is answered 503
 * `temporarily_unavailable` until room frees. A registration whose body
 * stalls is closed after 30 s, freeing its place. The store refuses a payload
 * SQLite cannot read, so no registration can stop the purge. And the store's purge runs once
 * listening and hourly: it deletes rows expired a day ago, and every
 * registered client more than a day old that nothing alive in the last day
 * names (an abandoned sign-in's, or one registered for the sake of it).
 *
 * The abuse limits are limits.ts's: password checks across every client and
 * tries per sign-in always, and with a trusted proxy, per address, a sign-in
 * backoff, failed client authentications (per client too) and registrations
 * an hour.
 */
// Types alone: the server is made by target.ts's serve, guarded.
import type http from "node:http";
import Provider, { errors, type ClientMetadata, type KoaContextWithOIDC, type ResourceServer } from "oidc-provider";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { guardedFetch } from "./fetch-guard.ts";
import { consentPage, esc, loginPage, PAGE_HEADERS, pageHtml, type Asking } from "./pages.ts";
import { configFromEnv, type Config } from "./config.ts";
import { ACCESS_TOKEN_TYPE, SCOPES, TOKEN_EXCHANGE } from "./layout.ts";
import { Bucket, clientAddress, clientIdOf, clientKey, countsAgainstClient, retryAfter, SIGN_IN_RATE, SignInBackoff, TOKEN_FAILURES, TOKEN_PATH, Tries, TRIES_PER_SIGN_IN, trustedProxy, WindowLimit } from "./limits.ts";
import { REGISTRATION_PATH, REGISTRATION_TIMEOUT_MS, RegistrationGate } from "./registration.ts";
import { CLOCK_TOLERANCE, sqliteAdapter } from "./store.ts";
import { serve, targetOf } from "./target.ts";

/**
 * A start that is refused: said, and after 30 s exit 2, which the restart
 * policy retries with the reason in the log each time (the n8n pattern in
 * deploy/compose.yaml) and without a hot loop. Exiting at once restarted it
 * about three times a second for as long as nobody stopped it (SMD-1846 PR
 * 2's review, measured on podman), the import runner's 229 restarts in 30 s
 * again (deploy/orchestration/runner.ts, refuseStart). A stop in the 30 s ends
 * it at once.
 */
async function refuseStart(why: string): Promise<never> {
  console.error(`${why}\n(exiting in 30 s; the restart policy retries)`);
  await Bun.sleep(30_000);
  process.exit(2);
}

// Definitely assigned: a refused start never returns.
let C!: Config;
try {
  C = configFromEnv();
} catch (e) {
  await refuseStart((e as Error).message);
}
const L = C.layout;
let store!: ReturnType<typeof sqliteAdapter>;
try {
  store = sqliteAdapter(C.dbPath);
} catch (e) {
  await refuseStart((e as Error).message);
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
  // The session cookie on the issuer's path. The library sets the short-lived
  // interaction cookies on their own paths, but the session on `/` by
  // default, and behind the proxy `/` is the whole origin: an operator signed
  // in here would send it with every `/mcp`, root and later `/dashboard` and
  // `/api` request, and it alone completes a grant (SMD-1846 PR 2's review).
  // Every endpoint that reads it is under `/auth`; the discovery paths
  // outside it read none. The library's defaults beside the path, named.
  cookies: { keys: C.cookieKeys, long: { httpOnly: true, sameSite: "lax", path: "/auth" } },
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

// The abuse limits (limits.ts). Per address only with a trusted proxy in
// front: behind a tunnel every client is one address, and a per-address
// lockout there would be everyone's. addressOf returns undefined, and the
// per-address limits are off, while the proxy's name does not resolve.
const { set: trusted } = trustedProxy(C.trustedProxy);
const addressOf = (req: http.IncomingMessage) => (trusted.size ? clientAddress(req, trusted, C.forwardedHops) : undefined);

// Failed client authentications, per address and client: the token and
// revocation endpoints refuse that client from that address past them. Only
// a client the library found, and one with a secret to guess, counts: a
// made-up id, a public client or one named by a metadata document URL (which
// the library fetches for any https id) has none, and counting them would let
// an address push its own entry out of the map with ids enough (MAX_ENTRIES).
// The keys one address can make are then the clients holding a secret: the
// fixed ones and at most OB1_AUTH_MAX_CLIENTS registered.
const tokenFailures = new WindowLimit(TOKEN_FAILURES.limit, TOKEN_FAILURES.windowMs);
const countFailedClient = (ctx: KoaContextWithOIDC, error: Error) => {
  const oidc = ctx.oidc as unknown as { client?: { clientSecret?: unknown }; params?: { client_id?: unknown; client_secret?: unknown; client_assertion?: unknown } } | undefined;
  const params = oidc?.params ?? {};
  const address = addressOf(ctx.req);
  if (address !== undefined && typeof oidc?.client?.clientSecret === "string" && countsAgainstClient(error as { error?: string }, { authorization: ctx.headers.authorization, ...params })) tokenFailures.record(clientKey(address, clientIdOf(ctx.headers.authorization, params.client_id, params.client_assertion)));
};

provider.on("grant.error", countFailedClient);
provider.on("revocation.error", countFailedClient);

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

/** Password checks across every address, wrong passwords per sign-in flow, and (with a trusted proxy) per address. */
const verifies = new Bucket(SIGN_IN_RATE.capacity, SIGN_IN_RATE.everyMs);
const flowTries = new Tries(TRIES_PER_SIGN_IN, 600_000);
const signIns = new SignInBackoff();

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
    // Every limit is checked, then every one reserved, before the first await,
    // so a burst of concurrent sign-ins is held as the same sign-ins one at a
    // time would be (limits.ts).
    const tooManyPage = (waitMs: number, note: string) => {
      res.setHeader("retry-after", retryAfter(waitMs));
      return send(res, 429, loginPage(asking, `${base}/login`, { note }));
    };
    // A spent sign-in is not waited out but started again: no Retry-After, and no form to post into it.
    if (!flowTries.has(uid)) return send(res, 429, loginPage(asking, `${base}/login`, { note: "Too many wrong passwords for this sign-in: start again from the app.", form: false }));
    const address = addressOf(req);
    const locked = address === undefined ? 0 : signIns.wait(address);
    if (locked) return tooManyPage(locked, `Too many wrong passwords from your address: try again in ${Math.ceil(locked / 60_000)} minute(s); a sign-in left open longer than ten minutes must start again from the app.`);
    const busy = verifies.take();
    if (busy) return tooManyPage(busy, "Too many sign-ins right now: try again in a moment.");
    flowTries.take(uid);
    if (address !== undefined) signIns.attempt(address);
    const form = await readForm(req);
    if (!(await Bun.password.verify(form.get("password") ?? "", C.passwordHash).catch(() => false))) {
      return send(res, 401, loginPage(asking, `${base}/login`, { wrong: true }));
    }
    verifies.giveBack();
    flowTries.clear(uid);
    if (address !== undefined) signIns.succeeded(address);
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
const registrations = new RegistrationGate(C.maxClients, () => store.countClients());
/** Registrations per address in an hour, with a trusted proxy (limits.ts): reserved at admission, given back on an answer other than 201 or a body stalled past the timeout. */
const registrationsByAddress = new WindowLimit(C.registrationsPerHour, 3_600_000);

/** A 429 in OAuth's JSON shape, with Retry-After. */
function tooMany(res: http.ServerResponse, waitMs: number, why: string) {
  res.writeHead(429, { "content-type": "application/json", "retry-after": retryAfter(waitMs), "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "temporarily_unavailable", error_description: `${why}; try again in ${retryAfter(waitMs)} s` }));
}

/** The library's own bound on a request body (selective_body.js). */
const TOKEN_BODY_LIMIT = 56 * 1024;
/**
 * A token or revocation request's body, read here so the client it names is
 * known before the library checks its secret. The library takes a body read
 * upstream from `req.body` (it logs once that it did). It is read as UTF-8,
 * whatever charset the request names, and the library parses the same
 * string, so the two cannot disagree on the client. Undefined when it is not
 * a form, which the library then answers as it would have; null when it is
 * larger than the library allows.
 */
async function readTokenBody(req: http.IncomingMessage): Promise<string | null | undefined> {
  if (!/^application\/x-www-form-urlencoded\b/i.test(req.headers["content-type"] ?? "")) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > TOKEN_BODY_LIMIT) return null;
    chunks.push(c as Buffer);
  }
  const body = Buffer.concat(chunks).toString();
  (req as http.IncomingMessage & { body?: string }).body = body;
  return body;
}

/** Whether a token or revocation request may reach the library: refused while its client, from its address, is past its failures. */
async function tokenGate(req: http.IncomingMessage, res: http.ServerResponse, address: string): Promise<boolean> {
  const body = await readTokenBody(req);
  if (body === null) {
    res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "invalid_request", error_description: "failed to parse the request body" }));
    return false;
  }
  const form = new URLSearchParams(body ?? "");
  const clientId = clientIdOf(req.headers.authorization, form.get("client_id") ?? undefined, form.get("client_assertion") ?? undefined);
  const wait = tokenFailures.wait(clientKey(address, clientId));
  if (wait) tooMany(res, wait, "too many failed authentications for this client from this address");
  return !wait;
}

// Made by serve, which guards it: a throw or a rejection in a request is that
// request's 500, never the process's end (target.ts). node:http is imported
// for its types alone, so an `http.createServer` here fails the typecheck.
const server = serve((req, res) => {
  // The provider builds every URL from the request's host and protocol (it
  // trusts X-Forwarded-* with proxy = true). Pin both to the configured origin.
  req.headers.host = ORIGIN.host;
  req.headers["x-forwarded-host"] = ORIGIN.host;
  req.headers["x-forwarded-proto"] = ORIGIN.protocol.slice(0, -1);
  // The path as the library will route it, so every gate below sees the path
  // the library does; an absolute-form target, or one the library would read
  // another way, is refused (target.ts).
  const target = targetOf(req.url);
  if (!target) {
    res.writeHead(400, { "content-type": "text/plain" });
    return res.end("bad request target: send the path alone");
  }
  const { path, search } = target;
  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (DISCOVERY.has(path)) {
    mount(req, `/.well-known/openid-configuration${search}`);
    return callback(req, res);
  }
  if (path.startsWith("/auth/interaction/")) {
    return interaction(req, res, path).catch((e: Error) => {
      console.error(`interaction failed: ${e instanceof errors.OIDCProviderError ? (e.error_description ?? e.message) : (e.stack ?? e.message)}`);
      if (res.headersSent) return;
      // The library's own refusals (an expired or unknown interaction) say what
      // went wrong; anything else is the server's fault and says nothing of it.
      if (e instanceof errors.OIDCProviderError) return page(res, e.status, "none", esc(e.error_description ?? e.message));
      page(res, 500, "none", "something went wrong on the server; try again, and see its log");
    });
  }
  const address = addressOf(req);
  if (address !== undefined && req.method === "POST" && TOKEN_PATH.test(path)) {
    return tokenGate(req, res, address).then(
      (pass) => {
        if (!pass) return;
        mount(req, `${path.slice("/auth".length) || "/"}${search}`);
        return callback(req, res);
      },
      () => res.destroy(),
    );
  }
  // Every spelling the library routes to registration (registration.ts), with
  // the ones under way counted: the client is saved only after its body is read.
  if (req.method === "POST" && REGISTRATION_PATH.test(path)) {
    let giveBackSlot = () => {};
    if (address !== undefined) {
      const wait = registrationsByAddress.take(address);
      if (wait) return tooMany(res, wait, `this address has registered ${C.registrationsPerHour} clients in the last hour`);
      // Given back once the answer is sent and is not a new client, or when
      // the body stalls past the timeout below (no client can exist); a
      // request dropped otherwise keeps its place, since the client may exist.
      let settled = false;
      giveBackSlot = () => {
        if (!settled) registrationsByAddress.giveBack(address);
        settled = true;
      };
      res.on("finish", () => {
        if (res.statusCode !== 201) giveBackSlot();
        settled = true;
      });
    }
    if (!registrations.admit()) {
      // RFC 7591 names no error for a full server; this is OAuth's own for "not now".
      res.writeHead(503, { "content-type": "application/json", "retry-after": "3600", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "temporarily_unavailable", error_description: `the authorization server holds as many registered clients as it allows (${C.maxClients}); registered clients that go unused are removed after a day` }));
    }
    res.on("close", () => registrations.release());
    // A registration that stalls holds its place only this long (registration.ts).
    req.setTimeout(REGISTRATION_TIMEOUT_MS, () => {
      giveBackSlot();
      req.destroy();
    });
  }
  if (path === "/auth" || path.startsWith("/auth/")) {
    mount(req, `${path.slice("/auth".length) || "/"}${search}`);
    return callback(req, res);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(3000, "0.0.0.0", () => {
  console.log(`oidc-provider on Bun ${Bun.version}: issuer ${L.issuer}`);
  // The first purge once the listener is up, so a large store never holds up the start.
  purge();
});

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

/** The store's purge (store.ts): once listening, then hourly. It logs only when it removed something, and a failure is logged and retried next hour. */
function purge() {
  try {
    const { clients, expired } = store.purge();
    if (clients || expired) console.log(`purged ${clients} idle registered client(s) and ${expired} row(s) expired over a day ago`);
  } catch (e) {
    console.error(`purge failed: ${(e as Error).stack ?? (e as Error).message}`);
  }
}
setInterval(purge, 3_600_000).unref();
