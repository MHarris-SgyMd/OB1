/**
 * better-auth.ts — the runner-up (SMD-2285 decision 1): Better Auth 1.7.6 with
 * `@better-auth/oauth-provider` and `@better-auth/cimd`, as its own small Bun
 * service with its issuer at `<origin>/auth`, run through the same verifier as
 * the winner.
 *
 * Better Auth is a whole account system, not only an authorization server. Its
 * handler also answers sign-up, profile, session and client-management
 * routes, so this service is an ALLOWLIST: the proxy's traffic reaches only
 * the protocol routes below and the shared sign-in and consent pages
 * (pages.ts). Anything else is a 404, and POST on the authorization route is a
 * 405 (the library reads a POST's body, which the hook below does not). Sign-up
 * is off; the one account is the operator, whose password is checked against
 * the same argon2id hash the winner reads.
 *
 * Sign-in and consent are called inside the process, with the brain's origin
 * as their Origin, so the library's own CSRF check sees ours, not the
 * browser's. And the library's signed interaction query is not bound to the
 * browser that started the flow (oidc-provider's is, by cookie). So every
 * interaction POST must carry the brain's origin as its Origin, or it is a 403
 * (any method but GET and POST is a 405): without that, a same-site page could
 * post a consent with the operator's cookie and a query it fetched itself. And
 * no page may be framed (pages.ts), or one disguised click on a framed consent
 * page would post from the brain's own origin.
 *
 * What is ours, beside the library's configuration:
 * - the token-exchange grant, through `extendOAuthProvider` (Better Auth has
 *   none built in). The rules are the winner's: only an `exchange` client from
 *   policy.ts, a subject token this server signed for that client's MCP
 *   resource, the same subject, no wider scope, `act: { sub: <client> }`. The
 *   library strips `exp` from contributed claims, so an exchanged token cannot
 *   be cut to its subject's expiry per issuance. Instead the REST cores'
 *   tokens live EXCHANGED_TTL seconds, and a subject token with less time left
 *   than that is refused: an exchanged token never outlives its subject;
 * - resource rules in a before-hook. Better Auth lets a token carry several
 *   audiences (several `resource` values, or `openid`, which adds its userinfo
 *   endpoint), and issues an opaque token for a request naming none. At the
 *   authorization endpoint, before any page, the hook refuses a request naming
 *   no resource, more than one, no scope (the library would fill in the
 *   client's registered ones, openid among them for some, and for a
 *   metadata-document client it learns those only after the hook has run), or
 *   `openid`. It redirects the refusal to the client when the redirect URI is
 *   exactly one the client registered (stricter than the library, which lets a
 *   loopback port vary), and answers it as JSON otherwise. At the token
 *   endpoint it counts `resource` in the raw form (the parsed body keeps only
 *   the last of a repeated field, and the library grants a client credentials
 *   token every resource the client is linked to) and refuses more than one,
 *   or none for client credentials;
 * - the third-party rule: a dynamically registered client may use
 *   authorization code and refresh only (the same hook), and so may a client
 *   named by a metadata document. The CIMD plugin's `onClientCreated` only
 *   notifies (it logs what the hook throws), so the rule runs where the
 *   document is read: the fetch wrapper refuses a document asking for more,
 *   and logs why;
 * - DPoP stripped: the library offers it to every client with no switch, and
 *   nothing in the stack checks a proof, so the `DPoP` header never reaches it
 *   and the metadata does not advertise it. Nor does it advertise anything else
 *   the allowlist blocks (userinfo, logout, introspection, back-channel logout,
 *   the claims parameter, sign-up's `prompt=create`), and a client may not
 *   register a `backchannel_logout_uri`, which the library would fetch;
 * - the fetch guard for metadata documents, the same as the winner's, though
 *   `@better-auth/cimd/node` ships an SSRF-safe fetch of its own;
 * - POC ONLY, behind OB1_AUTH_POC_ERROR_DETAIL=1: our refusals carry an
 *   `error_detail`, as the winner's do.
 *
 * State is bun:sqlite in memory, migrated at start; static clients are rows
 * (Better Auth has no clients in configuration).
 */
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { jwt } from "better-auth/plugins";
import { oauthProvider, extendOAuthProvider, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { guardedFetch } from "./fetch-guard.ts";
import { consentPage, loginPage, PAGE_HEADERS, pageHtml, type Asking } from "./pages.ts";
import { ACCESS_TOKEN_TYPE, layout, originFromEnv, SCOPES, TOKEN_EXCHANGE } from "./policy.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const L = layout(originFromEnv());
const ORIGIN = new URL(L.origin);
const OPERATOR = "operator";
const OPERATOR_EMAIL = "operator@ob1.internal";
const ACCESS_TTL = 600;
/** The REST cores' token lifetime, and the least time a subject token must have left to be exchanged. */
const EXCHANGED_TTL = 60;
const PASSWORD_HASH = need("OB1_AUTH_OPERATOR_PASSWORD_HASH");
const POC_ERROR_DETAIL = process.env.OB1_AUTH_POC_ERROR_DETAIL === "1";
const THIRD_PARTY_GRANTS = new Set(["authorization_code", "refresh_token"]);
/** Why a third-party client's metadata is refused (DCR body or metadata document), or null. */
function thirdPartyRefusal(meta: Record<string, unknown>): string | null {
  const declared = meta.grant_types;
  if (declared !== undefined && (!Array.isArray(declared) || declared.some((g) => typeof g !== "string"))) return "grant_types must be an array of strings";
  const refused = ((declared as string[] | undefined) ?? ["authorization_code"]).filter((g) => !THIRD_PARTY_GRANTS.has(g));
  if (refused.length) return `a third-party client may use authorization_code and refresh_token only, not ${refused.join(", ")}`;
  if (meta.backchannel_logout_uri !== undefined) return "backchannel_logout_uri is not accepted: the server would fetch it";
  return null;
}
const secretOf = (id: string) => need(`OB1_AUTH_SECRET_${id.toUpperCase().replace(/-/g, "_")}`);

/** A refusal, with the POC's detail when the switch is on. */
function refuse(error: string, description: string, detail?: string): never {
  throw new APIError("BAD_REQUEST", { error, error_description: description, ...(POC_ERROR_DETAIL && detail ? { error_detail: detail } : {}) });
}

const mcpResources = L.resources.filter((r) => r.endsWith("/mcp"));
const ownKeys = createRemoteJWKSet(new URL("http://127.0.0.1:3000/auth/jwks"));

const tokenExchange = () => ({
  id: "ob1-token-exchange",
  init(ctx: unknown) {
    extendOAuthProvider(ctx as never, {
      grants: {
        [TOKEN_EXCHANGE]: async ({ ctx, provider }: { ctx: { body: Record<string, string | undefined>; context: { internalAdapter: { findUserById(id: string): Promise<unknown> } } }; provider: { authenticateClient(o: { requireCredentials: boolean }): Promise<{ client: { clientId: string } }>; issueTokens(p: unknown): Promise<unknown> } }) => {
          const b = ctx.body;
          const { client } = await provider.authenticateClient({ requireCredentials: true });
          const policy = Object.hasOwn(L.clients, client.clientId) ? L.clients[client.clientId] : undefined;
          if (policy?.kind !== "exchange") refuse("unauthorized_client", "this client may not exchange tokens");
          if (!b.subject_token) refuse("invalid_request", "subject_token is required");
          if (b.subject_token_type !== ACCESS_TOKEN_TYPE) refuse("invalid_request", `subject_token_type must be ${ACCESS_TOKEN_TYPE}`);
          if (b.actor_token || b.actor_token_type) refuse("invalid_request", "the actor is the authenticated client; actor_token is not accepted");
          if (b.requested_token_type && b.requested_token_type !== ACCESS_TOKEN_TYPE) refuse("invalid_request", `requested_token_type must be ${ACCESS_TOKEN_TYPE}`);
          if (b.audience) refuse("invalid_request", "name the target with resource, not audience");
          if (b.resource !== policy.to) refuse("invalid_target", `this client exchanges for ${policy.to} only`);

          let claims: { sub?: string; scope?: string; exp?: number };
          try {
            ({ payload: claims } = await jwtVerify(b.subject_token!, ownKeys, { issuer: L.issuer, audience: policy.from, algorithms: ["ES256"], typ: "at+jwt" }));
          } catch (cause) {
            const { code, claim } = cause as { code?: string; claim?: string };
            refuse("invalid_grant", "grant request is invalid", `subject_token is not a valid access token for this client's resource (${code ?? "invalid"}${claim ? ` ${claim}` : ""})`);
          }
          if (claims.sub !== OPERATOR) refuse("invalid_grant", "grant request is invalid", "subject_token names no known account");
          const held = new Set((claims.scope ?? "").split(" ").filter(Boolean));
          const asked = b.scope ? b.scope.split(" ").filter(Boolean) : [...held];
          const wider = asked.filter((s) => !held.has(s));
          if (wider.length) refuse("invalid_scope", `scope wider than the subject token's: ${wider.join(" ")}`);
          // The library strips a contributed `exp`: bound the exchanged token by its resource's TTL instead.
          if ((claims.exp ?? 0) - Math.floor(Date.now() / 1000) < EXCHANGED_TTL) refuse("invalid_grant", "grant request is invalid", `subject_token has less than ${EXCHANGED_TTL} s left`);
          const user = await ctx.context.internalAdapter.findUserById(claims.sub);
          return provider.issueTokens({
            client,
            user,
            scopes: asked,
            resources: [policy.to],
            accessTokenClaims: { act: { sub: client.clientId } },
            tokenResponse: { issued_token_type: ACCESS_TOKEN_TYPE },
          });
        },
      },
    });
  },
});

/**
 * The fetch for metadata documents: the guard, then the third-party rule on
 * what the document asks for. The plugin reports any refusal as "Failed to
 * fetch metadata document", so the cause is logged, as the guard logs its own.
 */
const guarded = guardedFetch();
async function cimdFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const res = await guarded(input, init);
  if (res.status !== 200) return res;
  const text = await res.text();
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(text, { status: res.status, headers: res.headers });
  }
  const why = doc && typeof doc === "object" ? thirdPartyRefusal(doc) : null;
  if (why) {
    console.log(`cimd-rule: refused ${String(input instanceof Request ? input.url : input)} — ${why}`);
    throw new Error(`metadata document refused: ${why}`);
  }
  return new Response(text, { status: res.status, headers: res.headers });
}

/** Where an authorization request that breaks a resource rule is sent back: its registered redirect, or nowhere. */
async function refuseAuthorization(ctx: { query?: Record<string, unknown>; redirect(url: string): unknown }, error: string, description: string): Promise<never> {
  const q = (ctx.query ?? {}) as Record<string, string | string[] | undefined>;
  const clientId = String(q.client_id ?? "");
  const redirectUri = String([q.redirect_uri ?? ""].flat()[0]);
  const row = (await context().adapter.findOne({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] })) as { redirectUris?: string[] } | null;
  if (!row?.redirectUris?.includes(redirectUri)) refuse(error, description);
  const back = new URL(redirectUri);
  back.searchParams.set("error", error);
  back.searchParams.set("error_description", description);
  if (q.state) back.searchParams.set("state", String(q.state));
  back.searchParams.set("iss", L.issuer);
  throw ctx.redirect(back.href);
}

const resourcesOf = (v: unknown) => [v ?? []].flat().map(String).filter(Boolean);
type Adapter = { adapter: { create(a: unknown): Promise<unknown>; findOne(a: unknown): Promise<unknown> } };
let adapterContext: Adapter | undefined;
const context = () => {
  if (!adapterContext) throw new Error("the adapter is not ready");
  return adapterContext;
};

const options = {
  appName: "Open Brain",
  baseURL: L.origin,
  basePath: "/auth",
  secret: need("OB1_AUTH_COOKIE_KEYS").split(",")[0],
  trustedOrigins: [L.origin],
  // Better Auth limits request rates itself (the winner has no limiter: SMD-2309's). The verifier
  // registers dozens of clients a run, so the POC turns it off for parity; the deploy would keep one.
  rateLimit: { enabled: false },
  database: new Database(":memory:"),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    // The operator's password is the winner's: an argon2id hash from the environment.
    password: {
      hash: (password: string) => Bun.password.hash(password, { algorithm: "argon2id" }),
      verify: ({ hash, password }: { hash: string; password: string }) => Bun.password.verify(password, hash).catch(() => false),
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const c = ctx as unknown as { path: string; body?: Record<string, unknown>; query?: Record<string, unknown>; redirect(url: string): unknown };
      if (c.path === "/oauth2/register") {
        const why = thirdPartyRefusal(c.body ?? {});
        if (why) refuse("invalid_client_metadata", why);
      }
      if (c.path === "/oauth2/authorize") {
        const q = c.query ?? {};
        const resources = resourcesOf(q.resource);
        // A request naming no scope gets the client's registered ones from the library, openid among them for
        // some, and for a metadata-document client the library learns those only after this hook has run. So
        // a request must name its scopes; the openid rule then reads exactly what it names.
        if (!String(q.scope ?? "").trim()) await refuseAuthorization(c, "invalid_scope", "name the scopes this request asks for");
        const scopes = String(q.scope).split(" ");
        if (resources.length === 0) await refuseAuthorization(c, "invalid_target", "name the resource this token is for");
        if (resources.length > 1) await refuseAuthorization(c, "invalid_target", "only a single resource indicator value must be requested");
        if (scopes.includes("openid")) await refuseAuthorization(c, "invalid_scope", "openid cannot be asked beside a resource here: it adds the userinfo audience");
      }
      if (c.path === "/oauth2/token") {
        const b = c.body ?? {};
        // The parsed body keeps only the last of a repeated field, but the library re-reads the raw form and
        // grants every `resource` a client is linked to (client credentials put them all in `aud`). So count them there.
        const request = (ctx as unknown as { request?: Request }).request;
        const named = request ? new URLSearchParams(await request.clone().text()).getAll("resource").length : resourcesOf(b.resource).length;
        if (named > 1) refuse("invalid_target", "only a single resource indicator value must be requested");
        if (b.grant_type === "client_credentials" && named === 0) refuse("invalid_target", "name the resource this token is for");
      }
    }),
  },
  plugins: [
    jwt({ jwks: { keyPairConfig: { alg: "ES256" } }, jwt: { issuer: L.issuer } }),
    oauthProvider({
      loginPage: "/auth/interaction/login",
      consentPage: "/auth/interaction/consent",
      scopes: ["openid", "offline_access", ...SCOPES],
      resources: [...mcpResources.map((identifier) => ({ identifier, accessTokenTtl: ACCESS_TTL })), ...L.resources.filter((r) => r.endsWith("/api")).map((identifier) => ({ identifier, accessTokenTtl: EXCHANGED_TTL }))],
      accessTokenExpiresIn: ACCESS_TTL,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultResources: mcpResources,
      clientRegistrationAllowedResources: mcpResources,
      grantTypes: ["authorization_code", "client_credentials", "refresh_token"],
      silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
    } as never),
    cimd({ fetchClientMetadataResource: cimdFetch } as never),
    tokenExchange(),
  ],
};

const auth = betterAuth(options as never);
const { runMigrations } = await getMigrations(options as never);
await runMigrations();

// --- seeding: the operator and the static clients ---------------------------

adapterContext = (await auth.$context) as unknown as Adapter;
const now = () => new Date();
await context().adapter.create({ model: "user", data: { id: OPERATOR, email: OPERATOR_EMAIL, name: "Operator", emailVerified: true, createdAt: now(), updatedAt: now() }, forceAllowId: true });
await context().adapter.create({ model: "account", data: { accountId: OPERATOR, providerId: "credential", userId: OPERATOR, password: PASSWORD_HASH, createdAt: now(), updatedAt: now() } });
const sha = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64url");
for (const [clientId, p] of Object.entries(L.clients)) {
  const base = { clientId, clientSecret: await sha(secretOf(clientId)), tokenEndpointAuthMethod: "client_secret_basic", createdAt: now(), updatedAt: now() };
  if (p.kind === "gui") await context().adapter.create({ model: "oauthClient", data: { ...base, name: "Open Brain GUI", redirectUris: [p.redirect], grantTypes: ["authorization_code"], responseTypes: ["code"], scopes: [...SCOPES], requirePKCE: true } });
  if (p.kind === "service") await context().adapter.create({ model: "oauthClient", data: { ...base, name: clientId, redirectUris: [], grantTypes: ["client_credentials"], responseTypes: [], scopes: [p.scope], clientCredentialsScopes: [p.scope] } });
  if (p.kind === "exchange") await context().adapter.create({ model: "oauthClient", data: { ...base, name: clientId, redirectUris: [], grantTypes: [TOKEN_EXCHANGE], responseTypes: [], scopes: [...SCOPES] } });
  const linked = p.kind === "exchange" ? [p.to] : p.resources;
  for (const resourceId of linked) await context().adapter.create({ model: "oauthClientResource", data: { clientId, resourceId, createdAt: now() } });
}

// --- the pages ---------------------------------------------------------------

async function askingFrom(query: URLSearchParams): Promise<Asking> {
  const clientId = query.get("client_id") ?? "";
  const row = (await context().adapter.findOne({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] })) as { name?: string } | null;
  return { clientId, clientName: row?.name, redirectUri: query.get("redirect_uri") ?? "", scope: query.get("scope") ?? "", resources: query.getAll("resource") };
}

const html = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers: { ...PAGE_HEADERS, ...headers } });
const inner = (path: string, init: RequestInit = {}) => auth.handler(new Request(`${L.origin}/auth${path}`, { ...init, headers: { "content-type": "application/json", origin: L.origin, ...(init.headers as Record<string, string>) } }));

/** Follow the library's `{ redirect, url }` answer as a browser redirect, carrying its cookies. */
async function relay(r: Response): Promise<Response> {
  // A refusal the hook makes on the library's internal re-run is a redirect to the client: pass it on.
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
    const headers = new Headers({ location: r.headers.get("location")!, "cache-control": "no-store" });
    for (const c of r.headers.getSetCookie()) headers.append("set-cookie", c);
    return new Response(null, { status: 303, headers });
  }
  const body = (await r.json().catch(() => ({}))) as { url?: string; error?: string; error_description?: string };
  if (!r.ok || !body.url) return html(400, pageHtml("none", `the library refused: ${body.error ?? r.status} ${body.error_description ?? ""}`));
  const headers = new Headers({ location: body.url, "cache-control": "no-store" });
  for (const c of r.headers.getSetCookie()) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

async function interaction(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return html(405, pageHtml("none", "method not allowed"), { allow: "GET, POST" });
  if (req.method === "POST" && req.headers.get("origin") !== L.origin) return html(403, pageHtml("none", "this form must be posted from the brain's own origin"));
  const q = url.searchParams;
  const signed = url.search.slice(1);
  const asking = await askingFrom(q);
  if (url.pathname === "/auth/interaction/login") {
    if (req.method === "GET") return html(200, loginPage(asking, `/auth/interaction/login?${signed}`));
    const form = new URLSearchParams(await req.text());
    const r = await inner("/sign-in/email", { method: "POST", body: JSON.stringify({ email: OPERATOR_EMAIL, password: form.get("password") ?? "", oauth_query: signed }) });
    if (r.status === 401 || r.status === 403) return html(401, loginPage(asking, `/auth/interaction/login?${signed}`, true));
    return relay(r);
  }
  if (url.pathname === "/auth/interaction/consent") return html(200, consentPage(asking, `/auth/interaction/consent/confirm?${signed}`, `/auth/interaction/consent/abort?${signed}`));
  const accept = url.pathname === "/auth/interaction/consent/confirm";
  if (req.method !== "POST" || !(accept || url.pathname === "/auth/interaction/consent/abort")) return html(404, pageHtml("none", "not found"));
  return relay(await inner("/oauth2/consent", { method: "POST", headers: { cookie: req.headers.get("cookie") ?? "" }, body: JSON.stringify({ accept, oauth_query: signed }) }));
}

// --- routing -----------------------------------------------------------------

const DISCOVERY = new Set(["/.well-known/oauth-authorization-server/auth", "/.well-known/openid-configuration/auth", "/auth/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]);
/** What the proxy's traffic may reach in the library. */
const PROTOCOL = new Set(["/auth/oauth2/authorize", "/auth/oauth2/token", "/auth/oauth2/register", "/auth/oauth2/revoke", "/auth/jwks"]);
const metadata = oauthProviderOpenIdConfigMetadata(auth as never) as (req: Request) => Promise<Response>;
const UNADVERTISED = [
  "dpop_signing_alg_values_supported", "userinfo_endpoint", "end_session_endpoint", "pushed_authorization_request_endpoint", "require_pushed_authorization_requests",
  "introspection_endpoint", "introspection_endpoint_auth_methods_supported", "introspection_endpoint_auth_signing_alg_values_supported",
  "backchannel_logout_supported", "backchannel_logout_session_supported", "claims_parameter_supported",
];

Bun.serve({
  hostname: "0.0.0.0",
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    // URLs come from the configured origin, never the request's Host.
    const pinned = new URL(`${url.pathname}${url.search}`, L.origin);
    if (DISCOVERY.has(url.pathname)) {
      const doc = (await (await metadata(new Request(`${L.origin}/auth/.well-known/openid-configuration`))).json()) as Record<string, unknown>;
      for (const k of UNADVERTISED) delete doc[k];
      if (Array.isArray(doc.prompt_values_supported)) doc.prompt_values_supported = doc.prompt_values_supported.filter((p) => p !== "create" && p !== "select_account");
      return Response.json(doc, { headers: { "cache-control": "no-store" } });
    }
    // The library sends an error it cannot return to a client (no valid client or redirect) to its own page.
    if (url.pathname === "/auth/error") {
      return html(400, pageHtml("none", `The request was refused: ${String(url.searchParams.get("error") ?? "").replace(/[<>&]/g, "")} ${String(url.searchParams.get("error_description") ?? "").replace(/[<>&]/g, "")}`));
    }
    if (url.pathname.startsWith("/auth/interaction/")) {
      return interaction(req, url).catch((e: Error) => html(400, pageHtml("none", String(e.message).replace(/[<>&]/g, ""))));
    }
    if (!PROTOCOL.has(url.pathname)) return new Response("not found", { status: 404 });
    if (url.pathname === "/auth/oauth2/authorize" && req.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
    const headers = new Headers(req.headers);
    headers.delete("dpop");
    headers.set("host", ORIGIN.host);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    return auth.handler(new Request(pinned, { method: req.method, headers, body, redirect: "manual" }));
  },
});
console.log(`better-auth on Bun ${Bun.version}: issuer ${L.issuer}`);
