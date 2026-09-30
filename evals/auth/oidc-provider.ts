/**
 * oidc-provider.ts — the winning candidate (SMD-2285 decision 1), as its own
 * small Bun service: oidc-provider 9.12.2 served through node:http, with its
 * issuer at `<origin>/auth` (criterion 5).
 *
 * What is ours, beside the library's configuration:
 * - the token-exchange grant (RFC 8693, criterion 1). Only an `exchange` client
 *   from policy.ts may use it. The subject token must be an access token this
 *   server signed for that client's MCP resource (so never an exchanged one,
 *   whose audience is a REST core); the result is a token for the same tier's
 *   REST core with the same subject,
 *   no wider scope, no later expiry, and `act: { sub: <the MCP client> }`;
 * - `getResourceServerInfo`, which the library says MUST be replaced (criterion
 *   2): a resource outside the layout, or outside the client's allowance, is
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
 * - sign-in and consent pages. The POC signs the operator in by password,
 *   checked against an argon2id hash from the environment (decision 15's
 *   fallback). Passkeys and the loopback break-glass belong to the deploy.
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
 *   exists. Off unless that variable is set; the deploy never sets it.
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
 * State is the library's in-memory adapter: the POC proves the protocol, and
 * storage in its own `ob1_auth` database is the deploy's (Work step 3).
 */
import http from "node:http";
import Provider, { errors, type KoaContextWithOIDC } from "oidc-provider";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { guardedFetch } from "./fetch-guard.ts";
import { ACCESS_TOKEN_TYPE, layout, originFromEnv, SCOPES, TOKEN_EXCHANGE } from "./policy.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const L = layout(originFromEnv());
const OPERATOR = "operator";
const ACCESS_TTL = 600;
const PASSWORD_HASH = need("OB1_AUTH_OPERATOR_PASSWORD_HASH");
const jwks = JSON.parse(need("OB1_AUTH_JWKS")) as { keys: JWK[] };
/** The public half of the signing keys, to verify a subject token without a network hop. */
const ownKeys = createLocalJWKSet({ keys: jwks.keys.map(({ d, p, q, dp, dq, qi, ...pub }) => pub) });

const secretOf = (id: string) => need(`OB1_AUTH_SECRET_${id.toUpperCase().replace(/-/g, "_")}`);

/** The only grant types a client without a policy entry (DCR, CIMD) may register. */
const THIRD_PARTY_GRANTS = new Set(["authorization_code", "refresh_token"]);

const clients = Object.entries(L.clients).map(([client_id, p]) => {
  const base = { client_id, client_secret: secretOf(client_id), token_endpoint_auth_method: "client_secret_basic" };
  if (p.kind === "gui") return { ...base, grant_types: ["authorization_code"], response_types: ["code"], redirect_uris: [p.redirect] };
  if (p.kind === "service") return { ...base, grant_types: ["client_credentials"], response_types: [], redirect_uris: [], scope: p.scope };
  return { ...base, grant_types: [TOKEN_EXCHANGE], response_types: [], redirect_uris: [] };
});

/** POC ONLY (see the header): the library's internal reason for a refusal, which it never sends itself. */
const POC_ERROR_DETAIL = process.env.OB1_AUTH_POC_ERROR_DETAIL === "1";
function detailOf(error: unknown): { error_detail?: string } {
  if (!POC_ERROR_DETAIL) return {};
  const detail = (error as { error_detail?: unknown } | undefined)?.error_detail;
  const cause = (error as { cause?: { message?: string } } | undefined)?.cause?.message;
  const text = typeof detail === "string" ? detail : cause;
  return text ? { error_detail: text } : {};
}

function resourceInfo(resource: string) {
  return { scope: SCOPES.join(" "), audience: resource, accessTokenTTL: ACCESS_TTL, accessTokenFormat: "jwt" as const, jwt: { sign: { alg: "ES256" } } };
}

const provider = new Provider(L.issuer, {
  clients,
  jwks: jwks as never,
  cookies: { keys: need("OB1_AUTH_COOKIE_KEYS").split(",") },
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
      if (L.clients[String(metadata.client_id)]) return;
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
provider.on("grant.error", (ctx, error) => {
  if (ctx.body && typeof ctx.body === "object") Object.assign(ctx.body, detailOf(error));
});

const EXCHANGE_PARAMS = ["subject_token", "subject_token_type", "actor_token", "actor_token_type", "requested_token_type", "resource", "audience", "scope"];

provider.registerGrantType(TOKEN_EXCHANGE, async (ctx: KoaContextWithOIDC) => {
  const { params, client } = ctx.oidc as unknown as { params: Record<string, string | undefined>; client: { clientId: string } };
  const policy = L.clients[client.clientId];
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
  const token = new provider.AccessToken({ accountId: claims.sub, client: ctx.oidc.client, scope: asked.join(" "), gty: "token_exchange", expiresIn: exp - now });
  token.resourceServer = new provider.ResourceServer(policy.to, resourceInfo(policy.to));
  token.exp = exp;
  ctx.oidc.entity("AccessToken", token);
  const value = await token.save();
  ctx.body = { access_token: value, issued_token_type: ACCESS_TOKEN_TYPE, token_type: "Bearer", expires_in: exp - now, scope: token.scope };
}, EXCHANGE_PARAMS);

// --- sign-in and consent --------------------------------------------------

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: http.ServerResponse, status: number, prompt: string, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><title>Open Brain sign-in</title><main data-prompt="${esc(prompt)}">${body}</main>`);
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16 * 1024) throw new Error("form too large");
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

  if (req.method === "GET" && !action) {
    // Name the client by what the server checked. Its client_name is its own
    // claim, so it is shown only as that.
    const clientId = String(params.client_id);
    const checked = /^https:\/\//i.test(clientId) ? `the client published at ${new URL(clientId).host}` : `client ${clientId}`;
    // Where the code goes: an http(s) redirect's origin; any other scheme is an
    // app on the device, whichever owns that scheme, so its host means nothing.
    const destination = (() => {
      try {
        const u = new URL(String(params.redirect_uri));
        return u.protocol === "http:" || u.protocol === "https:" ? `returning to ${u.origin}` : `returning to the app registered for ${u.protocol} (${u.href})`;
      } catch {
        return `returning to ${String(params.redirect_uri)}`;
      }
    })();
    const said = client?.clientName ? ` (it calls itself &ldquo;${esc(client.clientName)}&rdquo;)` : "";
    const who = `<strong>${esc(checked)}</strong>${said}, <strong>${esc(destination)}</strong>`;
    if (prompt.name === "login") {
      return page(res, 200, "login", `<p>Sign in to let ${who} reach your brain.</p><form method="post" action="/auth/interaction/${esc(uid)}/login"><input type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>`);
    }
    // What the request names, validated by the library before this page: the
    // token can carry no scope or resource beyond these. (prompt.details lists
    // only what the grant still lacks, which is empty on a repeat consent.)
    const asked = String(params.scope ?? "").split(" ").filter(Boolean);
    const resources = [String(params.resource ?? "")].flat().filter(Boolean);
    const offline = asked.includes("offline_access") ? " It may keep access after you close it (<code>offline_access</code>)." : "";
    return page(res, 200, "consent", `<p>${who}, asks for <code>${esc(asked.join(" "))}</code> on <code>${esc(resources.join(" "))}</code>.${offline}</p><form method="post" action="/auth/interaction/${esc(uid)}/confirm"><button>Allow</button></form><form method="post" action="/auth/interaction/${esc(uid)}/abort"><button>Deny</button></form>`);
  }
  if (req.method !== "POST") return page(res, 405, "none", "method not allowed");

  if (action === "abort") return provider.interactionFinished(req, res, { error: "access_denied", error_description: "the operator denied the request" }, { mergeWithLastSubmission: false });
  if (action === "login") {
    if (prompt.name !== "login") return page(res, 400, "none", "not a sign-in step");
    const form = await readForm(req);
    if (!(await Bun.password.verify(form.get("password") ?? "", PASSWORD_HASH).catch(() => false))) {
      return page(res, 401, "login", `<p>Wrong password.</p><form method="post" action="/auth/interaction/${esc(uid)}/login"><input type="password" name="password"><button>Sign in</button></form>`);
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

http.createServer((req, res) => {
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
      console.error(`interaction failed: ${e.message}`);
      if (!res.headersSent) page(res, 400, "none", esc(e.message));
    });
  }
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
    mount(req, (req.url ?? "").slice("/auth".length) || "/");
    return callback(req, res);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
}).listen(3000, "0.0.0.0", () => console.log(`oidc-provider on Bun ${Bun.version}: issuer ${L.issuer}`));
