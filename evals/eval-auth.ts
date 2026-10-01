/**
 * eval-auth.ts — SMD-2285 Work step 2: the authorization server's
 * proof-of-concept overlay, the evals/orchestration pattern.
 *
 *   bun eval-auth.ts --up <candidate>       # the stack, built from this checkout
 *   bun eval-auth.ts --verify <candidate> [--json]
 *   bun eval-auth.ts --down <candidate>     # removes the project's containers, networks and images
 *   bun eval-auth.ts --self-check           # the fetch guard, route table, policy and the deploy's settings; no stack (CI)
 *
 * <candidate> is `oidc-provider` (the winner) or `better-auth` (the runner-up),
 * one at a time: both publish the same port. The stack is evals/auth/:
 * compose.yaml (proxy, stand-in MCP servers and REST cores for two tiers, a
 * metadata-document host and a bait) plus compose.<candidate>.yaml (the
 * authorization server). Only the proxy publishes a port, 127.0.0.1:8020, and
 * the origin is http://localhost:8020 with the issuer at /auth.
 *
 * What --verify checks, by the ticket's criteria (a check is a PASS or a
 * FAIL; the two MANUAL rows need a public origin and are never counted). A
 * refusal is matched by its error code, and by its reason or its cause (the
 * POC server's `error_detail`, or the guard's log line) wherever the check
 * names one. EXPECT below holds each candidate to what it actually answers
 * (its wording, and which scope-less tokens and consent pages it produces), so
 * every row is counted for both; KNOWN notes, beside its row, where an answer
 * departs from a standard. A note never excuses: the row must still pass.
 *   D (5, issuer under a path): the three routed discovery paths and the
 *     issuer's own serve one document, with `issuer` exactly `<origin>/auth`,
 *     every endpoint under it, S256 and no `plain`, code as the only response
 *     type, no DPoP, userinfo, logout or PAR, CIMD advertised with "none"
 *     among the auth methods (claude.ai's two conditions), `iss` in the
 *     authorization response, and the exchange grant. A request with a spoofed
 *     `Host` gets the same document. The SDK v2 client's own discovery parses
 *     it along both of its paths, the OIDC one strictly (typescript-sdk#2733).
 *     Each tier's MCP server answers a tokenless call with 401 naming its RFC
 *     9728 metadata, which names this issuer. Of the running containers, only
 *     the proxy publishes a port, on loopback, and the server sits on the
 *     internal mesh with none. A sample of the routes either library carries beside the protocol
 *     (sign-up, sessions, account, consent and client management, userinfo,
 *     logout, introspection) answers 404, and a DPoP proof at the token
 *     endpoint binds nothing.
 *   R (3, client registration): the SDK v2 client connects to stable /mcp by
 *     CIMD (its client_id is a document URL new to this run, fetched in this
 *     run, and nothing is registered), and to canary /mcp by DCR, each through
 *     a sign-in and a consent page; the consent page names the client by what
 *     the server checked (the document's host) and the redirect's origin. The
 *     fetch guard refuses a `client_id` naming the mesh, a private name,
 *     loopback, RFC 1918, CGNAT, link-local metadata, an IPv4-mapped loopback,
 *     `localhost` and a compose service name, each for its own cause (the name
 *     rule for the mesh, `localhost` and the service name; the address rule
 *     for the rest); after the probes the bait logs the one control connection
 *     the verifier makes, and nothing else. A document behind a redirect and one
 *     over the library's 5 KiB limit are refused for those causes (the
 *     library's rules). Every probed URL carries the run's name.
 *   G (4, grants): the GUI's confidential client runs authorization code with
 *     PKCE for the REST core through sign-in and consent, and the response
 *     carries `iss`. PKCE is required and `plain` refused, each for that
 *     reason. A wrong verifier and a replayed code are refused. The runner's
 *     client-credentials token names the runner, within its scope. A
 *     third-party client refreshes for its granted resource, one audience,
 *     after a consent page that listed and explained `offline_access`. The
 *     consent page shows a custom-scheme redirect as the app that owns the
 *     scheme, not the host its URI names (or the candidate refuses the URI at
 *     registration), and names the resource of a request whose scopes are none
 *     of the resource's. A consent posted from another origin issues nothing.
 *   A (2, resource indicators): every token checked has exactly one audience.
 *     A /mcp token is refused by the REST core and by the other tier, and a
 *     REST token by /mcp. An unknown resource is refused, and so are two
 *     resources at once from a client allowed both. A third-party client can
 *     neither get a REST-core token nor register for client credentials (by
 *     DCR or by metadata document) or the implicit grant (by DCR), nor keep a
 *     back-channel logout URI. A request naming no scope, from a signed-in
 *     operator, twice, yields no second audience. A request that names no
 *     resource is refused before any page, and by POST from a signed-in,
 *     consented browser gets no code. Every token issued for a resource with
 *     no brain scope is refused where presented, with `insufficient_scope`.
 *   X (1, token exchange): through /mcp, the REST core sees `oauth:operator`
 *     with the MCP service as actor. Done directly, the exchange keeps the
 *     subject, adds `act`, narrows but never widens scope, and never outlives
 *     the subject token. It is refused across tiers, for a foreign target, to
 *     a client without the grant, with a wrong secret, for a wider scope, and
 *     for a tampered, already-exchanged or REST-core subject token, each for
 *     its own cause. The exchanged token works only at its own REST core.
 * Run it twice on one stack: the second run registers new clients, presents
 * metadata documents the server has not cached, signs in again, and reads
 * only the log lines written since it started. Run one verify at a time: two
 * at once would count each other's bait connections.
 * Needs docker (or podman) compose and openssl.
 */
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { layoutFromEnv } from "../deploy/auth/layout.ts";
import { guardProbes } from "./auth/fetch-guard-probes.ts";
import { Browser, claimsOf, pkce, tampered, tokenRequest, type Claims, type TokenReply } from "./auth/flows.ts";
import { ACCESS_TOKEN_TYPE, INTERNAL, layout, NATIVE_REDIRECT, TIERS, TOKEN_EXCHANGE, type Layout } from "./auth/policy.ts";
import { route } from "./auth/proxy.ts";
import { sdkFlow, type SdkRun } from "./auth/sdk-client.ts";
import { CANDIDATES, compose, docker, ENV_FILE, ensureCert, ensureEnv, logsFromNow, type Candidate } from "./auth/stack.ts";
import { waitFor } from "./orchestration/stack.ts";

type Row = { id: string; pass: boolean | "manual"; detail: string };
const rows: Row[] = [];
function row(id: string, pass: boolean | "manual", detail: string) {
  rows.push({ id, pass, detail });
}

function usage(msg: string): never {
  console.error(`${msg}\nusage: bun eval-auth.ts --up|--verify|--down <${CANDIDATES.join("|")}> [--json] | --self-check`);
  process.exit(2);
}

// --- the stack ------------------------------------------------------------

async function up(candidate: Candidate) {
  const env = await ensureEnv();
  const steps = [`env: ${ENV_FILE}`, ...ensureCert()];
  const r = compose(candidate, ["up", "-d", "--build", "--remove-orphans"]);
  if (r.code !== 0) throw new Error(`compose up failed:\n${r.err.trim()}`);
  steps.push(`compose project ob1-auth-${candidate} up`);
  const L = layout(env.OB1_PUBLIC_ORIGIN);
  const reaches = (url: string) => async () => (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  try {
    await waitFor("the issuer's metadata through the proxy", reaches(L.discovery[0]), 20_000, 1_000);
  } catch {
    // Podman on macOS: after a fresh up, gvproxy sometimes leaves the host
    // port unforwarded while the proxy answers inside its container (measured:
    // 1 to 3 of 6 down-then-up cycles, internal network or not). Restarting the
    // proxy re-establishes the forward.
    compose(candidate, ["restart", "proxy"]);
    steps.push("the host port did not forward within 20 s; restarted the proxy (a podman machine port-forward race)");
    await waitFor("the issuer's metadata through the proxy", reaches(L.discovery[0]), 100_000, 1_000);
  }
  await waitFor("the stand-in MCP server through the proxy", reaches(L.prm("")), 60_000, 1_000);
  steps.push(`issuer ${L.issuer} answering`);
  for (const s of steps) console.log(`  ${s}`);
}

/**
 * The env file, brought up to date before a verb that reads it through compose:
 * an evals/auth/.env written before the layout settings existed fails the
 * winner's overlay (`${OB1_AUTH_TIERS:?}`), so `--down` and `--verify` would
 * fail until an `--up`. Without a file there is no stack: say so, rather than
 * write fresh secrets nothing runs with.
 */
async function currentEnv(): Promise<Record<string, string>> {
  if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} does not exist: run --up first`);
  return ensureEnv();
}

async function down(candidate: Candidate) {
  await currentEnv();
  // `--rmi all`: the images carry custom tags, which `--rmi local` leaves behind.
  const r = compose(candidate, ["down", "-v", "--rmi", "all", "--remove-orphans"]);
  if (r.code !== 0) throw new Error(`compose down failed:\n${r.err.trim()}`);
  console.log(`  removed ob1-auth-${candidate} (evals/auth/.env and .poc/ kept; delete them for new secrets)`);
}

// --- helpers --------------------------------------------------------------

type Meta = Record<string, unknown> & { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };

/** What every check reads: the layout, the metadata, the secrets, and this run's own log lines. */
type Ctx = { L: Layout; meta: Meta; env: Record<string, string>; candidate: Candidate; runLog: (service: string) => string; run: string };

const audOf = (c: Claims) => [c.aud ?? []].flat();
const oneAud = (c: Claims, want: string) => audOf(c).length === 1 && audOf(c)[0] === want;
const err = (r: TokenReply) => `${r.status} ${String(r.body.error ?? "")}${r.body.error_description ? ` (${r.body.error_description})` : ""}`;
/**
 * Refused with one of the codes; when a reason is given, with that reason in
 * the description; when a detail is given, with that cause in the POC server's
 * `error_detail` (the library's own reason, which it never sends itself).
 */
const refused = (r: TokenReply, code: string | string[], reason?: RegExp, detail?: RegExp) =>
  r.status >= 400 &&
  [code].flat().includes(String(r.body.error)) &&
  (!reason || reason.test(String(r.body.error_description ?? ""))) &&
  (!detail || detail.test(String(r.body.error_detail ?? "")));
const errOf = (r: TokenReply) => `${err(r)}${r.body.error_detail ? ` [${r.body.error_detail}]` : ""}`;
const signedIn = (b: Browser) => b.prompts.includes("login") && b.prompts.includes("consent");

/**
 * What each candidate actually answers where the checks look: the code and
 * wording of its refusals, and which requests it refuses outright where the
 * other lets them through to a later rule (scope-less tokens, consent pages, a
 * custom-scheme URI). Each value is what was measured; a change in the library
 * fails the row, and where an answer departs from a standard KNOWN notes it.
 */
type Refusal = { code: string | string[]; reason?: RegExp; detail?: RegExp };
type Expect = {
  pkceMissing: Refusal;
  pkcePlain: Refusal;
  wrongVerifier: Refusal;
  codeReplay: Refusal;
  scopeNotAllowed: Refusal;
  notLinked: Refusal;
  unknownResource: Refusal;
  grantNotAllowed: Refusal;
  wrongSecret: Refusal;
  /** The library's own refusals of a metadata document behind a redirect, and over its size limit. */
  cimdRedirect: RegExp;
  cimdTooLarge: RegExp;
  /** A library that refuses a private client_id itself, before any fetch, says so this way. */
  prefetch?: RegExp;
  /** The scope-less tokens (A8) the candidate issues: each must then be refused where presented. The rest it refuses to issue. */
  scopelessIssued: string[];
  /** The non-resource scopes (G6) whose requests reach a consent page; the rest are refused before any page. */
  consentScopes: string[];
  /** A candidate that refuses `com.evilapp://localhost:8020/mcp` at registration (RFC 8252 §7.1: no naming authority) says so this way; one that accepts it must name the app on its consent page. */
  customSchemeRefusal?: RegExp;
  /** How it refuses a request naming no scope (A4), as the redirect's error. */
  noScope: Refusal;
  /** What a POST to the authorization endpoint gets (A7): POST is off on both. */
  postAuthorizeStatus: number;
};
const EXPECT: Record<Candidate, Expect> = {
  "oidc-provider": {
    pkceMissing: { code: "invalid_request", reason: /PKCE/ },
    pkcePlain: { code: "invalid_request", reason: /code_challenge_method/ },
    wrongVerifier: { code: "invalid_grant", detail: /code_verifier does not match code_challenge/ },
    codeReplay: { code: "invalid_grant", detail: /already consumed/ },
    scopeNotAllowed: { code: "invalid_scope", reason: /requested scope is not allowed/ },
    notLinked: { code: "invalid_target", reason: /may not ask/ },
    unknownResource: { code: "invalid_target", reason: /not a resource/ },
    // What it answers; RFC 6749 names unauthorized_client (the KNOWN note on X3).
    grantNotAllowed: { code: "invalid_request", reason: /not allowed/ },
    wrongSecret: { code: "invalid_client", detail: /invalid secret/ },
    cimdRedirect: /unexpected response status 302/,
    cimdTooLarge: /response too large/,
    // offline_access alone grants no resource scope, so oidc-provider refuses it (access_denied).
    scopelessIssued: ["mcp:openid", "rest:openid"],
    consentScopes: ["openid", "offline_access"],
    // No scope grants nothing, so the consent ends in access_denied.
    noScope: { code: "access_denied" },
    // enableHttpPostMethods is off by default: no POST route for authorization.
    postAuthorizeStatus: 404,
  },
  "better-auth": {
    pkceMissing: { code: "invalid_request", reason: /pkce is required/ },
    pkcePlain: { code: "invalid_request", reason: /code_challenge_method must be one of: S256/ },
    // What it answers; RFC 7636 §4.6 names invalid_grant (the KNOWN note on G3).
    wrongVerifier: { code: "invalid_request", reason: /code verification failed/ },
    codeReplay: { code: "invalid_grant", reason: /invalid code/ },
    scopeNotAllowed: { code: "invalid_scope", reason: /scopes are invalid/ },
    notLinked: { code: "invalid_target", reason: /is not linked to resource/ },
    unknownResource: { code: "invalid_target", reason: /is not configured/ },
    grantNotAllowed: { code: "unauthorized_client", reason: /not authorized to use grant type/ },
    wrongSecret: { code: "invalid_client", reason: /invalid client_secret/ },
    cimdRedirect: /returned HTTP 302/,
    cimdTooLarge: /exceeds 5KB size limit/,
    prefetch: /must not target a private or reserved address/,
    // openid is refused beside a resource (it adds the userinfo audience), so only offline_access yields a scope-less token, and only for /mcp.
    scopelessIssued: ["mcp:offline_access"],
    consentScopes: ["offline_access"],
    customSchemeRefusal: /omit the naming authority.*com\.evilapp:\/\/localhost:8020\/mcp/,
    noScope: { code: "invalid_scope", reason: /name the scopes/ },
    postAuthorizeStatus: 405,
  },
};

/**
 * Where a candidate departs from a standard, row by row. A note, not an
 * exclusion: the row is counted, EXPECT holds the candidate to what it
 * actually answers, and the note is printed beside it. If the library changes,
 * the row fails and both are revisited.
 */
const KNOWN: Record<Candidate, Record<string, string>> = {
  "oidc-provider": {
    X3: "a client without the exchange grant gets invalid_request, where RFC 6749 names unauthorized_client",
  },
  "better-auth": {
    G3: "a wrong code_verifier gets invalid_request (HTTP 401), where RFC 7636 §4.6 names invalid_grant",
  },
};

const refusedAs = (r: TokenReply, e: Refusal) => refused(r, e.code, e.reason, e.detail);
/** A token's brain scopes, in order: what a resource reads (a library may also list offline_access). */
const brainScopes = (scope: unknown) => String(scope ?? "").split(" ").filter((s) => s.startsWith("brain:")).join(" ");

/** Everything a reply and the run's server log say about one refusal: its description, the POC's detail, and log lines naming the URL. */
function causeOf(c: Ctx, r: TokenReply, url?: string): string {
  const lines = url ? c.runLog("auth").split("\n").filter((l) => l.includes(url)) : [];
  return [r.body.error_description, r.body.error_detail, ...lines].filter(Boolean).join(" | ");
}

async function bearer(url: string, token: string, method = "GET"): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" } };
  if (method === "POST") init.body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const r = await fetch(url, init);
  return { status: r.status, body: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

/** A GET whose Host header is the caller's choice (fetch may not send one it did not derive). */
function getWithHost(url: string, host: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const u = new URL(url);
  return new Promise((resolve) => {
    // IPv4 only: the proxy publishes on 127.0.0.1, and the origin's name may resolve to IPv6 loopback first.
    const req = httpRequest({ hostname: u.hostname, family: 4, port: u.port, path: `${u.pathname}${u.search}`, headers: { host, "x-forwarded-host": host } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
    req.end();
  });
}

/** An RFC 9449 DPoP proof for one request, signed with a fresh P-256 key. */
function dpopProof(htm: string, htu: string): string {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const input = `${part({ typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } })}.${part({ htm, htu, jti: randomUUID(), iat: Math.floor(Date.now() / 1000) })}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

function authorizeUrl(meta: Meta, p: Record<string, string | string[] | undefined>): URL {
  const u = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries(p)) for (const one of v === undefined ? [] : [v].flat()) u.searchParams.append(k, one);
  return u;
}

async function registerRaw(meta: Meta, body: Record<string, unknown>): Promise<TokenReply> {
  const r = await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

/** A public client registered through DCR, as a connector without CIMD does. */
async function register(meta: Meta, grantTypes = ["authorization_code"]): Promise<string> {
  const r = await registerRaw(meta, { client_name: "POC direct client", redirect_uris: [NATIVE_REDIRECT], grant_types: grantTypes, response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" });
  if (r.status !== 201 || !r.body.client_id) throw new Error(`registration failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return String(r.body.client_id);
}

/**
 * Authorization code + PKCE for a public client; returns the token reply, or
 * the redirect's error. `resource` goes on both requests as given (one or
 * several), and at the token endpoint `tokenResource` (the same by default; null
 * names none, so a code granted for several must pick); an undefined `scope` is
 * left out of the request.
 */
async function publicCode(c: Ctx, clientId: string, resource: string | string[], scope: string | undefined, tokenResource: string | string[] | null = resource): Promise<TokenReply> {
  const pk = pkce();
  const back = await new Browser(c.env.OB1_AUTH_OPERATOR_PASSWORD).authorize(authorizeUrl(c.meta, { client_id: clientId, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope, resource, code_challenge: pk.challenge, code_challenge_method: "S256", state: "s" }), NATIVE_REDIRECT);
  if (!back.get("code")) return { status: 400, body: { error: back.get("error"), error_description: back.get("error_description") } };
  const params: Record<string, string | string[]> = { grant_type: "authorization_code", code: back.get("code")!, redirect_uri: NATIVE_REDIRECT, code_verifier: pk.verifier };
  if (tokenResource !== null) params.resource = tokenResource;
  return tokenRequest(c.meta.token_endpoint, params, { id: clientId });
}

const failed = (e: Error): TokenReply => ({ status: 0, body: { error: e.message } });

function toolSeen(run: SdkRun): Record<string, unknown> {
  try {
    return ((JSON.parse(run.tool.text) as { seen?: Record<string, unknown> }).seen ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// --- the checks -----------------------------------------------------------

function endpointsOutside(L: Layout, doc: Record<string, unknown>): string[] {
  return Object.entries(doc)
    .filter(([k, v]) => (k.endsWith("_endpoint") || k === "jwks_uri") && typeof v === "string" && !v.startsWith(`${L.issuer}/`))
    .map(([k, v]) => `${k}=${v}`);
}

async function discovery(L: Layout, env: Record<string, string>, candidate: Candidate): Promise<Meta> {
  const docs = await Promise.all(L.discovery.map(async (u) => {
    const r = await fetch(u);
    return { u, status: r.status, body: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> };
  }));
  const meta = docs[0].body as Meta;
  const endpoints = Object.keys(meta).filter((k) => k.endsWith("_endpoint") || k === "jwks_uri");
  const outside = endpointsOutside(L, meta);
  const list = (k: string) => (meta[k] as string[] | undefined) ?? [];
  const wrong: string[] = [];
  if (docs[0].status !== 200) wrong.push(`HTTP ${docs[0].status}`);
  if (meta.issuer !== L.issuer) wrong.push(`issuer ${meta.issuer}`);
  if (outside.length) wrong.push(`outside the issuer: ${outside.join(", ")}`);
  if (!list("code_challenge_methods_supported").includes("S256") || list("code_challenge_methods_supported").includes("plain")) wrong.push(`code_challenge_methods ${list("code_challenge_methods_supported")}`);
  if (JSON.stringify(list("response_types_supported")) !== JSON.stringify(["code"])) wrong.push(`response types ${list("response_types_supported")}`);
  if (list("grant_types_supported").includes("implicit")) wrong.push("implicit advertised");
  if (meta.dpop_signing_alg_values_supported !== undefined) wrong.push("DPoP advertised");
  for (const off of ["userinfo_endpoint", "end_session_endpoint", "pushed_authorization_request_endpoint", "introspection_endpoint"]) if (meta[off] !== undefined) wrong.push(`${off} advertised`);
  for (const flag of ["backchannel_logout_supported", "claims_parameter_supported"]) if (meta[flag] === true) wrong.push(`${flag} advertised`);
  if (list("prompt_values_supported").includes("create")) wrong.push("prompt=create (sign-up) advertised");
  if (meta.client_id_metadata_document_supported !== true) wrong.push("CIMD not advertised");
  if (!list("token_endpoint_auth_methods_supported").includes("none")) wrong.push(`auth methods ${list("token_endpoint_auth_methods_supported")}`);
  if (meta.authorization_response_iss_parameter_supported !== true) wrong.push("no iss in authorization responses");
  for (const g of ["authorization_code", "client_credentials", TOKEN_EXCHANGE]) if (!list("grant_types_supported").includes(g)) wrong.push(`grant ${g} missing`);
  row("D1 metadata at /.well-known/oauth-authorization-server/auth", wrong.length === 0, wrong.length ? wrong.join("; ") : `issuer ${meta.issuer}, ${endpoints.length} endpoints under it, S256 only, code only, no implicit, DPoP, userinfo, logout, introspection, back-channel logout, claims parameter, sign-up or PAR, CIMD + "none", iss, 3 grants`);

  const same = docs.map((d) => `${new URL(d.u).pathname} ${d.status}${d.status === 200 && JSON.stringify(d.body) === JSON.stringify(meta) ? "" : " DIFFERS"}`);
  row("D2 the same document on all four paths (bare = Claude Code's)", same.every((s) => s.endsWith(" 200")), same.join(", "));

  // The SDK's own discovery: RFC 8414 first, then (the first URL hidden) its strict OIDC parse.
  const viaOauth = await discoverAuthorizationServerMetadata(L.issuer).catch((e: Error) => e);
  const hideOauth = (async (input: string | URL, init?: RequestInit) => (String(input).includes("oauth-authorization-server") ? new Response("", { status: 404 }) : fetch(input, init))) as typeof fetch;
  const viaOidc = await discoverAuthorizationServerMetadata(L.issuer, { fetchFn: hideOauth }).catch((e: Error) => e);
  const sdkOk = (m: unknown) => !(m instanceof Error) && (m as { issuer?: string } | undefined)?.issuer === L.issuer;
  row("D3 the SDK v2 client parses it by RFC 8414 and by strict OIDC", sdkOk(viaOauth) && sdkOk(viaOidc), `RFC 8414: ${sdkOk(viaOauth) ? "ok" : String(viaOauth)}; OIDC: ${sdkOk(viaOidc) ? "ok" : String(viaOidc)}`);

  for (const tier of ["", "/canary"] as const) {
    const prm = await discoverOAuthProtectedResourceMetadata(L.mcp(tier)).catch((e: Error) => e);
    const r = await fetch(L.mcp(tier), { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    const challenge = r.headers.get("www-authenticate") ?? "";
    const ok = !(prm instanceof Error) && prm.resource === L.mcp(tier) && JSON.stringify(prm.authorization_servers) === JSON.stringify([L.issuer]) && r.status === 401 && challenge.includes(`resource_metadata="${L.prm(tier)}"`);
    row(`D4 ${tier || "stable"} /mcp: 401 names its RFC 9728 metadata, which names this issuer`, ok, `HTTP ${r.status}, challenge ${challenge || "(none)"}; metadata ${prm instanceof Error ? prm.message : `${prm.resource} → ${prm.authorization_servers}`}`);
  }

  // What is running, not what the compose files would create.
  type Inspected = { Config: { Labels: Record<string, string> }; NetworkSettings: { Ports?: Record<string, { HostIp: string }[] | null>; Networks?: Record<string, unknown> } };
  const project = `ob1-auth-${candidate}`;
  const ids = compose(candidate, ["ps", "-q"]).out.trim().split("\n").filter(Boolean);
  const running = ids.length ? (JSON.parse(docker(["inspect", ...ids]).out || "[]") as Inspected[]) : [];
  const service = (c: Inspected) => c.Config.Labels["com.docker.compose.service"];
  const published = running.flatMap((c) => Object.values(c.NetworkSettings.Ports ?? {}).flatMap((b) => (b ?? []).map((x) => `${service(c)}@${x.HostIp}`)));
  const auth = running.find((c) => service(c) === "auth");
  const authNets = Object.keys(auth?.NetworkSettings.Networks ?? {}).map((n) => n.replace(`${project}_`, ""));
  const meshInternal = (JSON.parse(docker(["network", "inspect", `${project}_mesh`]).out || "[]") as { Internal?: boolean }[])[0]?.Internal === true;
  row("D5 only the proxy publishes a port; the server is on the internal mesh with none", running.length >= 5 && published.length === 1 && published[0] === "proxy@127.0.0.1" && authNets.includes("mesh") && meshInternal, `${running.length} containers running; published: ${published.join(", ") || "(nothing)"}; auth on ${authNets.join(", ") || "(not running)"}; mesh internal ${meshInternal}`);

  const spoofed = await getWithHost(L.discovery[0], "evil.example");
  const moved = endpointsOutside(L, spoofed.body);
  const unchanged = JSON.stringify(spoofed.body) === JSON.stringify(meta);
  // Routes a library may carry beside the protocol (sign-up, sessions, client
  // management, userinfo, logout) must not answer through the proxy.
  // Both libraries' routes beside the protocol (each 404s the other's anyway).
  const offProtocol: [string, string][] = [
    ["POST", "/auth/sign-up/email"], ["POST", "/auth/sign-in/email"], ["POST", "/auth/sign-out"], ["GET", "/auth/get-session"], ["GET", "/auth/list-sessions"], ["POST", "/auth/update-user"],
    ["GET", "/auth/oauth2/userinfo"], ["GET", "/auth/oauth2/end-session"], ["POST", "/auth/oauth2/consent"], ["POST", "/auth/oauth2/continue"], ["POST", "/auth/oauth2/introspect"],
    ["GET", "/auth/oauth2/get-consents"], ["GET", "/auth/oauth2/get-clients"], ["POST", "/auth/oauth2/create-client"], ["POST", "/auth/oauth2/client/rotate-secret"], ["POST", "/auth/admin/oauth2/create-client"],
    ["GET", "/auth/me"], ["GET", "/auth/session/end"], ["POST", "/auth/token/introspection"],
  ];
  const answered: string[] = [];
  for (const [method, path] of offProtocol) {
    const res = await fetch(`${L.origin}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined, redirect: "manual" });
    if (res.status !== 404) answered.push(`${method} ${path} → ${res.status}`);
  }
  row("D7 routes outside the protocol answer 404", answered.length === 0, answered.length ? answered.join("; ") : `${offProtocol.length} routes (sign-up, sign-in, sessions, account, consent, client management, userinfo, logout, introspection) all 404`);

  // A DPoP proof at the token endpoint must bind nothing: nothing in the stack checks one.
  const runnerSecret = env.OB1_AUTH_SECRET_RUNNER;
  const dpop = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`runner:${runnerSecret}`)}`, dpop: dpopProof("POST", meta.token_endpoint) },
    body: new URLSearchParams({ grant_type: "client_credentials", resource: L.api(""), scope: "brain:capture" }),
  });
  const dpopBody = ((await dpop.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const bound = claimsOf(dpopBody.access_token) as { cnf?: unknown };
  row("D8 a DPoP proof binds nothing: the token stays Bearer", dpop.status === 200 && String(dpopBody.token_type).toLowerCase() === "bearer" && bound.cnf === undefined, `HTTP ${dpop.status}, token_type ${dpopBody.token_type ?? "none"}, cnf ${JSON.stringify(bound.cnf ?? null)}`);

  row("D6 a spoofed Host does not move the endpoints", spoofed.status === 200 && unchanged, unchanged ? `HTTP ${spoofed.status}, the same document, every endpoint under the issuer` : `HTTP ${spoofed.status}, the document differs${moved.length ? `: moved ${moved.join(", ")}` : ""}`);
  return meta;
}

async function registration(c: Ctx): Promise<{ cimd?: SdkRun }> {
  const { L, meta, env, candidate } = c;
  const out: { cimd?: SdkRun } = {};
  const registeredIn = (run: SdkRun) => run.requests.some((r) => r === `POST ${meta.registration_endpoint}`);
  const documentPath = `/client/${c.run}.json`;
  const documentUrl = `https://cimd.test${documentPath}`;
  try {
    const browser = new Browser(env.OB1_AUTH_OPERATOR_PASSWORD);
    const run = await sdkFlow(L.mcp(""), browser, documentUrl);
    const q = run.authUrl.searchParams;
    const fetched = c.runLog("cimd").includes(`cimd: GET ${documentPath}`);
    const seen = toolSeen(run);
    const registered = registeredIn(run);
    const consentPage = browser.pages[browser.prompts.indexOf("consent")] ?? "";
    const named = consentPage.includes("the client published at cimd.test") && consentPage.includes("returning to http://localhost:9876");
    const ok = q.get("client_id") === documentUrl && !registered && fetched && signedIn(browser) && named && q.get("code_challenge_method") === "S256" && q.get("resource") === L.mcp("") && !run.tool.isError && seen.subject === "oauth:operator";
    row("R1 SDK v2 client by CIMD → stable /mcp → whoami", ok, `client_id ${q.get("client_id")}, registered ${registered}, fetched this run ${fetched}, pages ${browser.prompts.join("→")}, consent naming cimd.test and http://localhost:9876 ${named}, PKCE ${q.get("code_challenge_method")}, resource ${q.get("resource")}; tool ${run.tool.text}`);
    out.cimd = run;
  } catch (e) {
    row("R1 SDK v2 client by CIMD → stable /mcp → whoami", false, (e as Error).message);
  }
  try {
    const browser = new Browser(env.OB1_AUTH_OPERATOR_PASSWORD);
    const run = await sdkFlow(L.mcp("/canary"), browser);
    const q = run.authUrl.searchParams;
    const seen = toolSeen(run);
    const registered = registeredIn(run);
    const tc = claimsOf(run.accessToken);
    const ok = registered && !String(q.get("client_id")).startsWith("https://") && signedIn(browser) && q.get("resource") === L.mcp("/canary") && oneAud(tc, L.mcp("/canary")) && !run.tool.isError && seen.subject === "oauth:operator" && seen.actor === "mcp-canary";
    row("R2 SDK v2 client by DCR → canary /mcp → whoami", ok, `registered ${registered} as ${q.get("client_id")}, pages ${browser.prompts.join("→")}, resource ${q.get("resource")}, aud ${audOf(tc)}; tool ${run.tool.text}`);
  } catch (e) {
    row("R2 SDK v2 client by DCR → canary /mcp → whoami", false, (e as Error).message);
  }

  // The fetch guard: each client_id refused for its own cause, which the
  // guard both returns (the winner's error_detail) and logs (read from this
  // run's lines: the runner-up's library words every fetch failure alike).
  // The mesh and localhost go by the name rule, so a lookup refusing them
  // later for their address would not pass. A library that refuses a private
  // client_id itself, before any fetch, passes on its own words.
  const r = c.run;
  const E = EXPECT[candidate];
  const guarded: [string, RegExp][] = [
    [`https://bait.ob1.internal/${r}.json`, /bait\.ob1\.internal names the mesh$/m],
    [`https://private-host.test/${r}.json`, /\S+ is private \(RFC 1918\)$/m],
    [`https://127.0.0.1/${r}.json`, /127\.0\.0\.1 is loopback$/m],
    [`https://[::1]/${r}.json`, /::1 is loopback$/m],
    [`https://10.0.0.1/${r}.json`, /10\.0\.0\.1 is private \(RFC 1918\)$/m],
    [`https://100.64.0.1/${r}.json`, /100\.64\.0\.1 is shared address space/],
    [`https://169.254.169.254/${r}`, /169\.254\.169\.254 is link-local/],
    [`https://[::ffff:127.0.0.1]/${r}.json`, /\S+ maps 127\.0\.0\.1 is loopback$/m],
    [`https://localhost/${r}.json`, /localhost names this machine$/m],
    [`https://postgres/${r}.json`, /postgres is a single-label name/],
  ];
  // The library's own rules: a non-200 and its 5 KiB limit. (The guard never follows a redirect either: node:https does not.)
  const library: [string, RegExp][] = [
    [`https://cimd.test/redirect/${r}.json`, E.cimdRedirect],
    [`https://cimd.test/big/${r}.json`, E.cimdTooLarge],
  ];
  const pk = pkce();
  const probe = async (id: string): Promise<TokenReply> => {
    const res = await fetch(authorizeUrl(meta, { client_id: id, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pk.challenge, code_challenge_method: "S256" }), { redirect: "manual" });
    return { status: res.status, body: ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown> };
  };
  const problems: string[] = [];
  const replies = new Map<string, TokenReply>();
  for (const [id] of [...guarded, ...library]) replies.set(id, await probe(id));
  // The bait: a control connection AFTER the probes, from the server's own
  // container, then wait for its line. The log is ordered, so once the
  // control's line is in, any connection a probe caused is in too: the control
  // must be the only one.
  const control = compose(candidate, ["exec", "-T", "auth", "bun", "-e", `setTimeout(() => process.exit(2), 3000); await Bun.connect({ hostname: "bait.ob1.internal", port: 443, socket: { data() {}, open(s) { s.end(); } } }); await Bun.sleep(100); process.exit(0);`]);
  let connections: string[] = [];
  for (let i = 0; i < 30; i++) {
    connections = c.runLog("bait").split("\n").filter((l) => l.startsWith("bait: connection"));
    if (connections.length || control.code !== 0) break;
    await Bun.sleep(100);
  }
  if (control.code !== 0) problems.push(`the control connection failed: ${control.err.trim().slice(0, 200)}`);
  if (connections.length !== 1) problems.push(`the bait logged ${connections.length} connections; want exactly the control's: ${connections.join("; ")}`);
  // The causes, read after the bait's wait so the guard's log lines are in.
  const guardLine = (id: string) => causeOf(c, replies.get(id)!, new URL(id).href).split(" | ").map((t) => t.replace(/^.* — /, "").replace(/^fetch refused: /, "")).join("\n");
  for (const [id, cause] of guarded) {
    const reply = replies.get(id)!;
    const byLibrary = E.prefetch?.test(String(reply.body.error_description ?? "")) ?? false;
    if (!refused(reply, "invalid_client") || !(cause.test(guardLine(id)) || byLibrary)) problems.push(`${id} → ${errOf(reply)} (want ${cause}${E.prefetch ? ` or ${E.prefetch}` : ""}; the cause read: ${guardLine(id).replace(/\n/g, " / ") || "none"})`);
  }
  for (const [id, cause] of library) {
    const reply = replies.get(id)!;
    if (!refused(reply, "invalid_client") || !cause.test(causeOf(c, reply))) problems.push(`${id} → ${errOf(reply)} (want ${cause})`);
  }
  row("R3 the fetch guard refuses internal client_ids before connecting", problems.length === 0, problems.length ? problems.join("; ") : `${guarded.length} refused before connecting, each for its own cause (${guarded.filter(([id]) => E.prefetch?.test(String(replies.get(id)!.body.error_description ?? ""))).length} by the library before any fetch, the rest by the guard), the redirect and the 6 KiB document refused by the library for theirs, the bait logged the control connection and nothing else`);
  return out;
}

async function grants(c: Ctx): Promise<{ gui?: string }> {
  const { L, meta, env } = c;
  const gui = L.clients.gui;
  if (gui.kind !== "gui") throw new Error("policy: gui is not a gui client");
  const guiClient = { id: "gui", secret: env.OB1_AUTH_SECRET_GUI };
  const password = env.OB1_AUTH_OPERATOR_PASSWORD;
  const out: { gui?: string } = {};
  // prompt=consent: a library that remembers consent (Better Auth, per user and client) shows the page every run too.
  const start = (extra: Record<string, string>) => authorizeUrl(meta, { client_id: "gui", response_type: "code", redirect_uri: gui.redirect, scope: "brain:read brain:write", resource: L.api(""), state: "st-1", prompt: "consent", ...extra });
  const E = EXPECT[c.candidate];
  const asParams = (e: Error) => new URLSearchParams({ error: e.message });

  const pk = pkce();
  const browser = new Browser(password);
  const back = await browser.authorize(start({ code_challenge: pk.challenge, code_challenge_method: "S256" }), gui.redirect).catch(asParams);
  const code = back.get("code") ?? "";
  const tok = code ? await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: gui.redirect, code_verifier: pk.verifier }, guiClient) : { status: 0, body: {} };
  const tc = claimsOf(tok.body.access_token);
  const rest = tok.status === 200 ? await bearer(`${L.api("")}/whoami`, String(tok.body.access_token)) : { status: 0, body: {} };
  const ok = signedIn(browser) && back.get("iss") === L.issuer && back.get("state") === "st-1" && tok.status === 200 && oneAud(tc, L.api("")) && tc.sub === "operator" && tc.client_id === "gui" && tc.scope === "brain:read brain:write" && rest.status === 200 && rest.body.subject === "oauth:operator" && rest.body.actor === null;
  row("G1 GUI: confidential client, code + PKCE → REST core", ok, `pages ${browser.prompts.join("→")}, iss ${back.get("iss")}, state ${back.get("state")}${back.get("error") ? `, error ${back.get("error")}` : ""}; token ${tok.status} aud ${audOf(tc)} sub ${tc.sub} scope ${tc.scope}; REST ${rest.status} ${JSON.stringify(rest.body)}`);
  if (tok.status === 200) out.gui = String(tok.body.access_token);

  const replay = code ? await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: gui.redirect, code_verifier: pk.verifier }, guiClient) : { status: 0, body: {} };
  const noPkce = await new Browser(password).authorize(start({}), gui.redirect).catch(asParams);
  const plain = await new Browser(password).authorize(start({ code_challenge: pk.verifier, code_challenge_method: "plain" }), gui.redirect).catch(asParams);
  const asReply = (p: URLSearchParams): TokenReply => ({ status: 400, body: { error: p.get("error"), error_description: p.get("error_description") } });
  row("G2 PKCE is required, and plain is refused", refusedAs(asReply(noPkce), E.pkceMissing) && refusedAs(asReply(plain), E.pkcePlain), `no challenge → ${err(asReply(noPkce))}; plain → ${err(asReply(plain))}`);

  const pk2 = pkce();
  const back2 = await new Browser(password).authorize(start({ code_challenge: pk2.challenge, code_challenge_method: "S256" }), gui.redirect).catch(() => new URLSearchParams());
  const wrongVerifier = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: back2.get("code") ?? "", redirect_uri: gui.redirect, code_verifier: pkce().verifier }, guiClient);
  row("G3 a wrong code_verifier and a replayed code are refused", Boolean(back2.get("code")) && refusedAs(wrongVerifier, E.wrongVerifier) && refusedAs(replay, E.codeReplay), `wrong verifier → ${errOf(wrongVerifier)}; replay → ${errOf(replay)}`);

  const runner = { id: "runner", secret: env.OB1_AUTH_SECRET_RUNNER };
  const cc = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: L.api(""), scope: "brain:capture" }, runner);
  const cr = claimsOf(cc.body.access_token);
  const wider = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: L.api(""), scope: "brain:write" }, runner);
  const toMcp = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: L.mcp(""), scope: "brain:capture" }, runner);
  const ccOk = cc.status === 200 && oneAud(cr, L.api("")) && cr.sub === "runner" && cr.act === undefined && cr.scope === "brain:capture" && refusedAs(wider, E.scopeNotAllowed) && refusedAs(toMcp, E.notLinked);
  row("G4 client credentials: a service identity, within its scope and resource", ccOk, `token ${cc.status} aud ${audOf(cr)} sub ${cr.sub} scope ${cr.scope}; brain:write → ${err(wider)}; /mcp → ${err(toMcp)}`);

  // Refresh, which a third-party client may use: the consent page must say so, and the refreshed token keeps its one audience.
  try {
    const id = await register(meta, ["authorization_code", "refresh_token"]);
    const pk3 = pkce();
    const b = new Browser(password);
    const back3 = await b.authorize(authorizeUrl(meta, { client_id: id, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read offline_access", resource: L.mcp(""), prompt: "consent", code_challenge: pk3.challenge, code_challenge_method: "S256", state: "st-5" }), NATIVE_REDIRECT);
    const first = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: back3.get("code") ?? "", redirect_uri: NATIVE_REDIRECT, code_verifier: pk3.verifier, resource: L.mcp("") }, { id });
    const refreshed = await tokenRequest(meta.token_endpoint, { grant_type: "refresh_token", refresh_token: String(first.body.refresh_token ?? "") }, { id });
    const rc = claimsOf(refreshed.body.access_token);
    const consentPage = b.pages[b.prompts.lastIndexOf("consent")] ?? "";
    const shown = consentPage.includes(`client ${id}`) && consentPage.includes("returning to http://localhost:9876") && /asks for brain:read offline_access on /.test(consentPage) && /keep access after you close it \( offline_access \)/.test(consentPage);
    const ok5 = shown && first.status === 200 && Boolean(first.body.refresh_token) && refreshed.status === 200 && oneAud(rc, L.mcp("")) && rc.sub === "operator" && brainScopes(rc.scope) === "brain:read";
    row("G5 a third-party client refreshes for its granted resource, and consent said so", ok5, `consent page names the client id and http://localhost:9876, lists offline_access and explains it: ${shown}; first ${first.status} refresh_token ${first.body.refresh_token ? "issued" : "none"}; refreshed ${errOf(refreshed)} aud ${audOf(rc)} scope ${rc.scope}`);
  } catch (e) {
    row("G5 a third-party client refreshes for its granted resource, and consent said so", false, (e as Error).message);
  }
  // What the consent page says. A native client with a custom scheme returns
  // to an app, whatever host the URI names; a request for openid alone still
  // names its resource. Both are denied here: nothing is issued.
  try {
    // A reverse-domain scheme with a naming authority: the authority is the one thing RFC 8252 §7.1 forbids here.
    const custom = "com.evilapp://localhost:8020/mcp";
    const reg6 = await registerRaw(meta, { client_name: "Open Brain dashboard", redirect_uris: [custom], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" });
    // A library may refuse the URI at registration (RFC 8252 §7.1: a private-use scheme is a reverse-domain name with no authority); that closes the same hole. EXPECT says which does which.
    const E6 = EXPECT[c.candidate];
    const refusedAtRegistration = refused(reg6, "invalid_redirect_uri", E6.customSchemeRefusal);
    const id6 = String(reg6.body.client_id ?? "");
    const pk6 = pkce();
    const b6 = new Browser(password);
    const denied = refusedAtRegistration ? new URLSearchParams({ error: "access_denied" }) : await b6.authorize(authorizeUrl(meta, { client_id: id6, response_type: "code", redirect_uri: custom, scope: "brain:read", resource: L.mcp(""), code_challenge: pk6.challenge, code_challenge_method: "S256" }), "com.evilapp://", false);
    const page6 = refusedAtRegistration ? `refused at registration: ${reg6.body.error_description}` : b6.pages[b6.prompts.indexOf("consent")] ?? "";
    const appShown = E6.customSchemeRefusal ? refusedAtRegistration : (page6.includes("returning to the app registered for com.evilapp:") && !page6.includes("returning to localhost") && page6.includes(`client ${id6} (it calls itself "Open Brain dashboard")`));
    // A request whose scopes are none of the resource's (openid, offline_access) must still show its
    // resource. A library may refuse such a request before any page; EXPECT names which reach one.
    const shownFor: string[] = [];
    const reached: string[] = [];
    let pages = 0;
    let resourceShown = true;
    let deniedO = "access_denied";
    for (const scope of ["openid", "offline_access"]) {
      const idO = await register(meta, ["authorization_code", "refresh_token"]);
      const pkO = pkce();
      const bO = new Browser(password);
      const back = await bO.authorize(authorizeUrl(meta, { client_id: idO, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope, resource: L.mcp(""), prompt: "consent", code_challenge: pkO.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT, false);
      const pageO = bO.pages[bO.prompts.indexOf("consent")];
      if (pageO === undefined) {
        shownFor.push(`${scope}: refused before any page (${back.get("error")})`);
        continue;
      }
      pages++;
      reached.push(scope);
      const named = pageO.includes(`asks for ${scope} on ${L.mcp("")}`);
      resourceShown &&= named;
      if (back.get("error") !== "access_denied") deniedO = String(back.get("error"));
      shownFor.push(`${scope}: "${pageO.slice(0, 140)}…" (${named})`);
    }
    resourceShown &&= pages > 0 && JSON.stringify(reached) === JSON.stringify(E6.consentScopes);
    const ok6 = appShown && resourceShown && denied.get("error") === "access_denied" && deniedO === "access_denied";
    row("G6 the consent page names where the code goes and the resource asked for", ok6, `custom scheme → "${page6.slice(0, 160)}…" (${appShown}); ${shownFor.join("; ")}; Deny → ${denied.get("error")}, ${deniedO}`);
  } catch (e) {
    row("G6 the consent page names where the code goes and the resource asked for", false, (e as Error).message);
  }

  // A consent posted by a page of another origin (a CSRF) must issue nothing,
  // even with the operator signed in: the form carries the right interaction,
  // only its Origin is foreign.
  try {
    const idC = await register(meta);
    const pkC = pkce();
    const bC = new Browser(password);
    bC.consentOrigin = "http://evil.localhost:9999";
    const back = await bC.authorize(authorizeUrl(meta, { client_id: idC, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), prompt: "consent", code_challenge: pkC.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT).catch((e: Error) => new URLSearchParams({ error: e.message }));
    const ok7 = bC.prompts.includes("login") && bC.prompts.includes("consent") && !back.get("code") && /\/confirm.*HTTP 403.*must be posted from the brain's own origin/.test(back.get("error") ?? "");
    row("G7 a consent posted from another origin is refused", ok7, `pages ${bC.prompts.join("→")}; ${back.get("code") ? "a code was issued" : `no code: ${String(back.get("error") ?? "").replace(/<[^>]+>/g, " ").slice(0, 200)}`}`);
  } catch (e) {
    row("G7 a consent posted from another origin is refused", false, (e as Error).message);
  }

  // No interaction page may be framed: one disguised click on a framed consent page would post from the brain's own origin.
  try {
    const idF = await register(meta);
    const pkF = pkce();
    const bF = new Browser(password);
    // Through sign-in to consent, then Deny: both pages are read, nothing is issued.
    await bF.authorize(authorizeUrl(meta, { client_id: idF, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pkF.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT, false).catch(() => new URLSearchParams());
    const framed = (h: Headers) => /^deny$/i.test(h.get("x-frame-options") ?? "") && /frame-ancestors 'none'/.test(h.get("content-security-policy") ?? "");
    const seen = bF.prompts.map((p, i) => `${p} ${framed(bF.pageHeaders[i]) ? "forbids framing" : `X-Frame-Options ${bF.pageHeaders[i].get("x-frame-options") ?? "(none)"}, CSP ${bF.pageHeaders[i].get("content-security-policy") ?? "(none)"}`}`);
    // And a live sign-in page takes only GET and POST.
    const pB = new Browser(password);
    const pkP2 = pkce();
    const startP = authorizeUrl(meta, { client_id: idF, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pkP2.challenge, code_challenge_method: "S256" });
    const toLogin = await pB.request(startP);
    const loginUrl = new URL(toLogin.headers.get("location") ?? "", startP);
    await pB.request(loginUrl);
    const put = await pB.request(loginUrl, { method: "PUT" });
    const ok8 = bF.prompts.includes("login") && bF.prompts.includes("consent") && bF.pageHeaders.every(framed) && put.status === 405;
    row("G8 the sign-in and consent pages cannot be framed, and take only GET and POST", ok8, `${seen.join("; ")}; PUT to a live sign-in page → ${put.status}`);
  } catch (e) {
    row("G8 the sign-in and consent pages cannot be framed", false, (e as Error).message);
  }
  return out;
}

async function audiences(c: Ctx, mcpToken: string | undefined, guiToken: string | undefined) {
  const { L, meta, env } = c;
  if (mcpToken) {
    const tc = claimsOf(mcpToken);
    const atRest = await bearer(`${L.api("")}/whoami`, mcpToken);
    const atCanaryMcp = await bearer(L.mcp("/canary"), mcpToken, "POST");
    const atCanaryRest = await bearer(`${L.api("/canary")}/whoami`, mcpToken);
    row("A1 a /mcp token has one audience, its own", oneAud(tc, L.mcp("")) && tc.iss === L.issuer, `aud ${JSON.stringify(tc.aud)}, iss ${tc.iss}`);
    row("A2 a /mcp token is refused by the REST core and by the other tier", atRest.status === 401 && atCanaryMcp.status === 401 && atCanaryRest.status === 401, `REST ${atRest.status}, canary /mcp ${atCanaryMcp.status}, canary REST ${atCanaryRest.status}`);
  } else {
    row("A1 a /mcp token has one audience, its own", false, "no /mcp token: R1 failed");
    row("A2 a /mcp token is refused by the REST core and by the other tier", false, "no /mcp token: R1 failed");
  }
  if (guiToken) {
    const atMcp = await bearer(L.mcp(""), guiToken, "POST");
    row("A3 a REST-core token is refused by /mcp", atMcp.status === 401, `stable /mcp ${atMcp.status}`);
  } else row("A3 a REST-core token is refused by /mcp", false, "no REST token: G1 failed");

  // Two resources from a client allowed both: a third-party client may have either tier's /mcp.
  const runner = { id: "runner", secret: env.OB1_AUTH_SECRET_RUNNER };
  const unknown = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: "https://evil.example/api", scope: "brain:capture" }, runner);
  const both = [L.mcp(""), L.mcp("/canary")];
  const two = await register(meta).then((id) => publicCode(c, id, both, "brain:read")).catch(failed);
  // The same, redeemed naming no resource: a code granted for both must not become a token for both.
  const twoUnnamed = await register(meta).then((id) => publicCode(c, id, both, "brain:read", null)).catch(failed);
  const twoUnnamedClaims = claimsOf(twoUnnamed.body.access_token);
  const E = EXPECT[c.candidate];
  // A request naming no scope: the library fills in the client's registered
  // scopes (openid among them, for some). From an operator already signed in,
  // twice: a library that saves a consent before a rule refuses the flow would
  // hand the second request a code with no page. Any code issued is redeemed,
  // and its token must have one audience.
  const nsId = await register(meta, ["authorization_code", "refresh_token"]);
  const nsBrowser = new Browser(env.OB1_AUTH_OPERATOR_PASSWORD);
  const pkA = pkce();
  const nsFirst = await nsBrowser.authorize(authorizeUrl(meta, { client_id: nsId, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pkA.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT).catch(() => new URLSearchParams());
  const noScope: string[] = [];
  // The attack's precondition: signed in, and consented for this client.
  let noScopeOk = signedIn(nsBrowser) && Boolean(nsFirst.get("code"));
  if (!noScopeOk) noScope.push("the first, consented flow did not complete, so the case was not reached");
  // No scope twice (the second would find a consent the first saved), then a present but empty scope: none may yield a code.
  for (const [i, scope] of [[1, undefined], [2, undefined], [3, ""]] as const) {
    const pkN = pkce();
    const back = await nsBrowser.authorize(authorizeUrl(meta, { client_id: nsId, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope, resource: L.mcp(""), code_challenge: pkN.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT).catch((e: Error) => new URLSearchParams({ error: e.message.slice(0, 80) }));
    if (!back.get("code")) {
      const asReply: TokenReply = { status: 400, body: { error: back.get("error"), error_description: back.get("error_description") } };
      noScopeOk &&= refusedAs(asReply, E.noScope);
      noScope.push(`try ${i}${scope === "" ? " (scope empty)" : ""}: no code (${err(asReply)})`);
      continue;
    }
    // A code for a request naming no scope is a failure whatever it redeems to: the operator consented to nothing named.
    const t = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: back.get("code")!, redirect_uri: NATIVE_REDIRECT, code_verifier: pkN.verifier, resource: L.mcp("") }, { id: nsId });
    const tc = claimsOf(t.body.access_token);
    noScopeOk = false;
    noScope.push(`try ${i}${scope === "" ? " (scope empty)" : ""}: A CODE, token ${t.status} aud ${JSON.stringify(tc.aud)}`);
  }
  // Two resources at once from a service linked to both: client credentials must still give one audience.
  const tiers = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: [L.api(""), L.api("/canary")], scope: "brain:capture" }, { id: "runner-tiers", secret: env.OB1_AUTH_SECRET_RUNNER_TIERS });
  const tiersClaims = claimsOf(tiers.body.access_token);
  const tiersOk = refused(tiers, "invalid_target", /only a single resource indicator value/);
  row("A4 an unknown resource, two at once, or scopes a request never named add no second audience", refusedAs(unknown, E.unknownResource) && refused(two, "invalid_target", /only a single resource indicator value/) && twoUnnamed.status !== 200 && tiersOk && noScopeOk, `unknown → ${err(unknown)}; both /mcp at once → ${err(two)}; both granted, redeemed naming none → ${twoUnnamed.status === 200 ? `ISSUED, aud ${JSON.stringify(twoUnnamedClaims.aud)}` : err(twoUnnamed)}; a service linked to both REST cores asking for both → ${tiers.status === 200 ? `ISSUED, aud ${JSON.stringify(tiersClaims.aud)}` : err(tiers)}; no scope named, signed in → ${noScope.join("; ")}`);

  const asked = await register(meta).then((id) => publicCode(c, id, L.api(""), "brain:read")).catch(failed);
  row("A5 a third-party client cannot get a REST-core token", refusedAs(asked, E.notLinked), `DCR client asking for ${L.api("")} → ${err(asked)}`);

  // The third-party rule, on both registration paths.
  const ccReg = await registerRaw(meta, { grant_types: ["client_credentials"], response_types: [], redirect_uris: [], token_endpoint_auth_method: "client_secret_basic" });
  const implicitReg = await registerRaw(meta, { grant_types: ["implicit"], response_types: ["id_token"], redirect_uris: [NATIVE_REDIRECT], token_endpoint_auth_method: "none", application_type: "native" });
  const stringReg = await registerRaw(meta, { grant_types: "client_credentials", redirect_uris: [NATIVE_REDIRECT] });
  // A back-channel logout URI is one more URL the server would fetch on a client's say-so: refused, or dropped where the feature is off.
  const bclReg = await registerRaw(meta, { redirect_uris: [NATIVE_REDIRECT], grant_types: ["authorization_code"], token_endpoint_auth_method: "none", application_type: "native", backchannel_logout_uri: "https://bait.ob1.internal/logout" });
  const bclOk = refused(bclReg, "invalid_client_metadata", /backchannel_logout_uri/) || (bclReg.status === 201 && bclReg.body.backchannel_logout_uri === undefined);
  const pk = pkce();
  // Refused by the rule, which runs on the fetched document: the refusal itself shows the document was fetched and read.
  const ccDoc = `https://cimd.test/cc/${c.run}.json`;
  const cimdCc = await fetch(authorizeUrl(meta, { client_id: ccDoc, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pk.challenge, code_challenge_method: "S256" }), { redirect: "manual" });
  const cimdCcBody: TokenReply = { status: cimdCc.status, body: ((await cimdCc.json().catch(() => null)) ?? {}) as Record<string, unknown> };
  for (let i = 0; i < 20 && !/third-party/.test(causeOf(c, cimdCcBody, ccDoc)); i++) await Bun.sleep(100);
  const a6 = bclOk && refused(ccReg, "invalid_client_metadata", /third-party/) && refused(implicitReg, "invalid_client_metadata", /third-party/) && refused(stringReg, "invalid_client_metadata", /array of strings/) && refused(cimdCcBody, ["invalid_client_metadata", "invalid_client"]) && /third-party/.test(causeOf(c, cimdCcBody, ccDoc));
  row("A6 a third-party client cannot register for client credentials or implicit", a6, `DCR client_credentials → ${err(ccReg)}; DCR implicit → ${err(implicitReg)}; DCR grant_types as a string → ${err(stringReg)}; DCR backchannel_logout_uri → ${bclReg.status === 201 ? `registered, the URI ${bclReg.body.backchannel_logout_uri === undefined ? "dropped" : "KEPT"}` : err(bclReg)}; CIMD document with client_credentials → ${err(cimdCcBody)} [${causeOf(c, cimdCcBody, ccDoc)}]`);

  const noResourceCc = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", scope: "brain:capture" }, runner);
  // At authorization it is refused before any page: no sign-in, no consent, no code.
  const noResourceBrowser = new Browser(env.OB1_AUTH_OPERATOR_PASSWORD);
  const pk7 = pkce();
  const noResourceBack = await register(meta)
    .then((id) => noResourceBrowser.authorize(authorizeUrl(meta, { client_id: id, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", code_challenge: pk7.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT))
    .catch((e: Error) => new URLSearchParams({ error: e.message }));
  const noResourceCode: TokenReply = { status: 400, body: { error: noResourceBack.get("error"), error_description: noResourceBack.get("error_description") } };
  // And by POST, from a browser already signed in and consented for that client: a library that reads a POST's body could slip past a rule on the query.
  const signedInBrowser = new Browser(env.OB1_AUTH_OPERATOR_PASSWORD);
  const postId = await register(meta);
  const pkP = pkce();
  const first = await signedInBrowser.authorize(authorizeUrl(meta, { client_id: postId, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pkP.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT).catch(() => new URLSearchParams());
  // A harmless query naming the resource, and a body without one: the query is what a rule on the query reads.
  const postUrl = new URL(meta.authorization_endpoint);
  postUrl.searchParams.set("resource", L.mcp(""));
  postUrl.searchParams.set("scope", "brain:read");
  const posted = await signedInBrowser.request(postUrl, { method: "POST", body: new URLSearchParams({ client_id: postId, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", code_challenge: pkP.challenge, code_challenge_method: "S256" }) });
  const postedTo = posted.headers.get("location") ?? "";
  const postedCode = /[?&]code=/.test(postedTo);
  const a7 = refused(noResourceCc, "invalid_target", /name the resource/) && refused(noResourceCode, "invalid_target", /name the resource/) && noResourceBrowser.prompts.length === 0 && !noResourceBack.get("code") && Boolean(first.get("code")) && !postedCode && posted.status === E.postAuthorizeStatus;
  row("A7 a request that names no resource gets no token", a7, `client credentials → ${err(noResourceCc)}; authorization → ${err(noResourceCode)} after ${noResourceBrowser.prompts.length} pages; by POST from a signed-in, consented browser → HTTP ${posted.status} (this candidate: ${E.postAuthorizeStatus})${postedTo ? ` to ${postedTo.slice(0, 120)}` : ""}${first.get("code") ? "" : " (the first, consented flow got no code)"}`);

  // A token for a resource can carry no brain scope (a request for openid or
  // offline_access alone), and each resource must refuse it for that. A
  // library may refuse to issue one at all; every one issued must be refused
  // where it is presented, and at least one must be issued to test that.
  const tries: { key: string; what: string; reply: TokenReply; at: string; resource: string }[] = [];
  for (const scope of ["openid", "offline_access"]) {
    tries.push({ key: `mcp:${scope}`, what: `/mcp for ${scope} alone`, reply: await register(meta, ["authorization_code", "refresh_token"]).then((id) => publicCode(c, id, L.mcp(""), scope)).catch(failed), at: L.mcp(""), resource: L.mcp("") });
  }
  const guiPk = pkce();
  const gui = L.clients.gui;
  const guiRedirect = gui.kind === "gui" ? gui.redirect : "";
  const guiBack = await new Browser(env.OB1_AUTH_OPERATOR_PASSWORD).authorize(authorizeUrl(meta, { client_id: "gui", response_type: "code", redirect_uri: guiRedirect, scope: "openid", resource: L.api(""), code_challenge: guiPk.challenge, code_challenge_method: "S256" }), guiRedirect).catch(() => new URLSearchParams());
  tries.push({ key: "rest:openid", what: "the REST core for openid alone", reply: guiBack.get("code") ? await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: guiBack.get("code")!, redirect_uri: guiRedirect, code_verifier: guiPk.verifier }, { id: "gui", secret: env.OB1_AUTH_SECRET_GUI }) : { status: 400, body: { error: guiBack.get("error") ?? "refused" } }, at: `${L.api("")}/whoami`, resource: L.api("") });
  const results: string[] = [];
  const issuedKeys: string[] = [];
  let a8 = true;
  for (const t of tries) {
    if (t.reply.status !== 200) {
      results.push(`${t.what}: not issued (${err(t.reply)})`);
      continue;
    }
    issuedKeys.push(t.key);
    const tc = claimsOf(t.reply.body.access_token);
    const seen = await bearer(t.at, String(t.reply.body.access_token), t.at.endsWith("/mcp") ? "POST" : "GET");
    const ok = oneAud(tc, t.resource) && brainScopes(tc.scope) === "" && seen.status === 403 && seen.body.error === "insufficient_scope";
    a8 &&= ok;
    results.push(`${t.what}: issued, aud ${audOf(tc)}, scope "${tc.scope ?? ""}" → ${seen.status} ${seen.body.error ?? ""}`);
  }
  const wantIssued = EXPECT[c.candidate].scopelessIssued;
  a8 &&= JSON.stringify(issuedKeys) === JSON.stringify(wantIssued);
  row("A8 every token issued with no brain scope is refused where it is presented", a8, `${results.join("; ")}; issued ${issuedKeys.join(", ") || "none"} (this candidate: ${wantIssued.join(", ")})`);
}

async function exchange(c: Ctx, cimd: SdkRun | undefined, guiToken: string | undefined) {
  const { L, meta, env } = c;
  const seen = cimd ? toolSeen(cimd) : {};
  row("X1 through /mcp the REST core sees the subject, with the MCP service as actor", seen.subject === "oauth:operator" && seen.actor === "mcp" && seen.client_id === "mcp" && seen.aud === L.api(""), cimd ? cimd.tool.text : "no run: R1 failed");

  const subject = cimd?.accessToken;
  if (!subject) {
    row("X2 the exchange keeps the subject, adds act, never widens or outlives", false, "no /mcp token: R1 failed");
    row("X3 the exchange is refused wherever it should be", false, "no /mcp token: R1 failed");
    row("X4 an exchanged token works only at its own REST core", false, "no /mcp token: R1 failed");
    return;
  }
  const mcp = { id: "mcp", secret: env.OB1_AUTH_SECRET_MCP };
  const te = (s: string, extra: Record<string, string> = {}, client: { id: string; secret?: string } = mcp) =>
    tokenRequest(meta.token_endpoint, { grant_type: TOKEN_EXCHANGE, subject_token: s, subject_token_type: ACCESS_TOKEN_TYPE, resource: L.api(""), ...extra }, client);

  const sc = claimsOf(subject);
  // Exchange at least one whole second after the subject was issued, so an
  // exchange that ignored the subject's expiry would end after it.
  while (Date.now() / 1000 < (sc.iat ?? 0) + 1.2) await Bun.sleep(100);
  const x = await te(subject);
  const xc = claimsOf(x.body.access_token);
  const narrow = await te(subject, { scope: "brain:read" });
  const nc = claimsOf(narrow.body.access_token);
  const x2 = x.status === 200 && x.body.issued_token_type === ACCESS_TOKEN_TYPE && xc.sub === sc.sub && xc.act?.sub === "mcp" && oneAud(xc, L.api("")) && xc.scope === sc.scope && (xc.exp ?? Infinity) <= (sc.exp ?? 0) && narrow.status === 200 && nc.scope === "brain:read" && oneAud(nc, L.api(""));
  row("X2 the exchange keeps the subject, adds act, never widens or outlives", x2, `${x.status} sub ${xc.sub} act ${JSON.stringify(xc.act)} aud ${audOf(xc)} scope "${xc.scope}" (subject "${sc.scope}") exp ${xc.exp} ≤ ${sc.exp}; narrowed to "${nc.scope}" for ${audOf(nc)}`);

  // A /mcp token with brain:read alone, to ask for more than it holds.
  const readOnly = await register(meta).then((id) => publicCode(c, id, L.mcp(""), "brain:read")).catch(failed);
  const bad: string[] = [];
  if (readOnly.status !== 200 || !oneAud(claimsOf(readOnly.body.access_token), L.mcp(""))) bad.push(`no brain:read-only /mcp token to widen: ${err(readOnly)}`);
  if (x.status !== 200) bad.push("no exchanged token to re-exchange: X2's exchange failed");
  if (!guiToken) bad.push("no REST-core token to present: G1 failed");
  // invalid_grant carries one fixed description ("grant request is invalid"); the POC server's error_detail names the cause.
  const aud = /\(ERR_JWT_CLAIM_VALIDATION_FAILED aud\)/;
  const cases: [string, Promise<TokenReply>, string | string[], RegExp?, RegExp?][] = [
    ["the canary MCP service with a stable token", te(subject, { resource: L.api("/canary") }, { id: "mcp-canary", secret: env.OB1_AUTH_SECRET_MCP_CANARY }), "invalid_grant", undefined, aud],
    ["the stable MCP service for the canary REST core", te(subject, { resource: L.api("/canary") }), "invalid_target", /exchanges for/],
    // Each library answers in its own words (EXPECT); oidc-provider departs from RFC 6749 here (the KNOWN note on X3).
    ["the GUI client, which has no exchange grant", te(subject, {}, { id: "gui", secret: env.OB1_AUTH_SECRET_GUI }), EXPECT[c.candidate].grantNotAllowed.code, EXPECT[c.candidate].grantNotAllowed.reason, EXPECT[c.candidate].grantNotAllowed.detail],
    ["a wrong MCP client secret", te(subject, {}, { id: "mcp", secret: "not-the-secret" }), EXPECT[c.candidate].wrongSecret.code, EXPECT[c.candidate].wrongSecret.reason, EXPECT[c.candidate].wrongSecret.detail],
    ["a scope wider than the subject's", te(String(readOnly.body.access_token), { scope: "brain:read brain:write" }), "invalid_scope", /wider/],
    ["a tampered subject token", te(tampered(subject)), "invalid_grant", undefined, /ERR_JWS_SIGNATURE_VERIFICATION_FAILED/],
    ["an already-exchanged subject token (its audience is a REST core)", te(String(x.body.access_token)), "invalid_grant", undefined, aud],
    ["a REST-core token as the subject", te(String(guiToken)), "invalid_grant", undefined, aud],
    ["an actor_token", te(subject, { actor_token: subject, actor_token_type: ACCESS_TOKEN_TYPE }), "invalid_request", /actor_token/],
    ["no subject_token_type", tokenRequest(meta.token_endpoint, { grant_type: TOKEN_EXCHANGE, subject_token: subject, resource: L.api("") }, mcp), "invalid_request", /subject_token_type/],
  ];
  for (const [what, p, code, reason, detail] of cases) {
    const r = await p;
    if (!refused(r, code, reason, detail)) bad.push(`${what} → ${errOf(r)} (want ${[code].flat().join("|")}${reason ? ` matching ${reason}` : ""}${detail ? ` for ${detail}` : ""})`);
  }
  row("X3 the exchange is refused wherever it should be", bad.length === 0, bad.length ? bad.join("; ") : `${cases.length} refusals, each with its expected error and its own cause`);

  const exchanged = String(x.body.access_token ?? "");
  const own = await bearer(`${L.api("")}/whoami`, exchanged);
  const other = await bearer(`${L.api("/canary")}/whoami`, exchanged);
  const back = await bearer(L.mcp(""), exchanged, "POST");
  row("X4 an exchanged token works only at its own REST core", own.status === 200 && own.body.actor === "mcp" && other.status === 401 && back.status === 401, `own REST ${own.status} actor ${own.body.actor}; canary REST ${other.status}; /mcp ${back.status}`);
}

async function verify(candidate: Candidate, json: boolean): Promise<number> {
  const env = await currentEnv();
  const L = layout(env.OB1_PUBLIC_ORIGIN);
  const t0 = Date.now();
  const runLog = logsFromNow(candidate, ["auth", "cimd", "bait"]);
  const run = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const meta = await discovery(L, env, candidate);
  const c: Ctx = { L, meta, env, candidate, runLog, run };
  const { cimd } = await registration(c);
  const { gui } = await grants(c);
  await audiences(c, cimd?.accessToken, gui);
  await exchange(c, cimd, gui);
  row("M1 claude.ai connector", "manual", `needs a public origin (claude.ai refuses private and CGNAT hosts): add ${L.mcp("")} as a custom connector and sign in`);
  row("M2 Claude Code 2.1.275 on the bare metadata path", "manual", `claude mcp add --transport http poc ${L.mcp("")}, then /mcp: it reads ${L.discovery[3]}, whose issuer is ${L.issuer}`);

  const known = KNOWN[candidate];
  const idOf = (r: Row) => r.id.split(" ")[0];
  const counted = rows.filter((r) => r.pass !== "manual");
  const failing = counted.filter((r) => !r.pass);
  const label = (r: Row) => (r.pass === "manual" ? "MANUAL" : r.pass ? "PASS  " : "FAIL  ");
  if (json) console.log(JSON.stringify({ candidate, run, seconds: (Date.now() - t0) / 1000, rows, known }, null, 2));
  else {
    for (const r of rows) console.log(`${label(r)} ${r.id}\n         ${r.detail}${known[idOf(r)] ? `\n         departs from the standard: ${known[idOf(r)]}` : ""}`);
    const notes = Object.keys(known).length;
    console.log(`\n${candidate}: ${counted.length - failing.length}/${counted.length} checks pass${notes ? `, ${notes} departure${notes > 1 ? "s" : ""} from a standard noted` : ""} in ${((Date.now() - t0) / 1000).toFixed(1)} s${failing.length ? ` — FAILED: ${failing.map(idOf).join(", ")}` : ""}`);
  }
  return failing.length ? 1 : 0;
}

// --- self-check -----------------------------------------------------------

function selfCheck(): number {
  const failures: string[] = [];
  let probes = 0;
  const expect = (what: string, ok: boolean) => {
    probes++;
    if (!ok) failures.push(what);
  };
  // The fetch guard's rules, by its own probes (evals/auth/fetch-guard-probes.ts).
  guardProbes(expect);

  // The proxy's table.
  const routes: [string, string | null][] = [
    ["/auth", INTERNAL.auth], ["/auth/token", INTERNAL.auth], ["/.well-known/oauth-authorization-server/auth", INTERNAL.auth],
    ["/.well-known/openid-configuration/auth", INTERNAL.auth], ["/.well-known/oauth-authorization-server", INTERNAL.auth],
    ["/mcp", INTERNAL.mcp("")], ["/canary/mcp", INTERNAL.mcp("/canary")], ["/.well-known/oauth-protected-resource/mcp", INTERNAL.mcp("")],
    ["/.well-known/oauth-protected-resource/canary/mcp", INTERNAL.mcp("/canary")], ["/api/whoami", INTERNAL.api("")], ["/canary/api/whoami", INTERNAL.api("/canary")],
    ["/", null], ["/authx", null], ["/.well-known/openid-configuration", null], ["/mcp/extra", null], ["/apix", null], ["/canary/auth", null],
  ];
  for (const [path, want] of routes) expect(`route ${path} → ${want}`, route(path) === want);

  // The policy: a third-party client reaches the MCP servers only; an exchange client asks for nothing directly.
  const L = layout("http://localhost:8020");
  expect("a third-party client may ask for each /mcp and no REST core", JSON.stringify(L.allowedResources("https://cimd.test/client.json")) === JSON.stringify([L.mcp(""), L.mcp("/canary")]));
  expect("the MCP service asks for nothing directly", L.allowedResources("mcp").length === 0);
  expect("the GUI asks for the stable REST core only", JSON.stringify(L.allowedResources("gui")) === JSON.stringify([L.api("")]));
  expect("every resource is distinct", new Set(L.resources).size === L.resources.length && L.resources.length === 4);
  // TIERS (the stand-ins' and the proxy's list) and POC_ENV (the server's) name the same tiers.
  expect("the POC's tier list is the layout's", JSON.stringify(L.resources) === JSON.stringify([...TIERS.map(L.mcp), ...TIERS.map(L.api)]));

  // The deploy's two settings (deploy/auth/layout.ts): unset or blank is the
  // stable tier alone, any whitespace separates, and each bad entry stops the
  // server with its own reason (matched, so another check's throw is no pass).
  const O = "https://brain.example";
  const keys = (l: Layout | undefined) => JSON.stringify(Object.keys(l?.clients ?? {}));
  // A layout the settings should give; a refusal is a named failure, not a crash.
  const accepted = (what: string, env: Record<string, string>): Layout | undefined => {
    try {
      return layoutFromEnv({ OB1_PUBLIC_ORIGIN: O, ...env });
    } catch (e) {
      expect(`the deploy's settings accept ${what} (refused: ${(e as Error).message})`, false);
      return undefined;
    }
  };
  const D = accepted("no settings", {});
  expect("unset settings: the stable tier's two resources, the GUI and one exchange client", JSON.stringify(D?.resources) === JSON.stringify([`${O}/mcp`, `${O}/api`]) && keys(D) === JSON.stringify(["gui", "mcp"]));
  const B = accepted("blank settings", { OB1_AUTH_TIERS: " ", OB1_AUTH_SERVICES: "" });
  expect("blank settings (compose's unset ${X:-}) are the unset ones", !!B && JSON.stringify(B.resources) === JSON.stringify(D?.resources) && keys(B) === keys(D));
  const W = accepted("spaced tiers and whitespace-separated services", { OB1_AUTH_TIERS: " stable , working ", OB1_AUTH_SERVICES: "\n digest=brain:read+brain:capture@stable,working\trunner=brain:capture@stable\n" });
  expect("tier names are trimmed, and services split on any whitespace", keys(W) === JSON.stringify(["gui", "mcp", "mcp-working", "digest", "runner"]));
  const ex = W?.clients["mcp-working"];
  expect("a tier's exchange client trades its own /mcp for its own REST core", ex?.kind === "exchange" && ex.from === `${O}/working/mcp` && ex.to === `${O}/working/api`);
  const svc = W?.clients.digest;
  expect("a service gets its scopes and its tiers' REST cores", svc?.kind === "service" && svc.scope === "brain:read brain:capture" && JSON.stringify(svc.resources) === JSON.stringify([`${O}/api`, `${O}/working/api`]));
  expect("the GUI stays the GUI beside services", W?.clients.gui?.kind === "gui");
  const id64 = `r${"0-9".repeat(20)}abz`;
  const E = accepted("the id rule's edges", { OB1_AUTH_SERVICES: `${id64}=brain:read@stable a1=brain:read@stable q=brain:read@stable` });
  expect("a 64-character id, an id ending in a digit and a one-letter id are accepted", id64.length === 64 && !!E && Object.hasOwn(E.clients, id64) && Object.hasOwn(E.clients, "a1") && Object.hasOwn(E.clients, "q"));
  const refused: [string, Record<string, string>, RegExp][] = [
    ["an unknown tier", { OB1_AUTH_TIERS: "stable,staging" }, /names no such tier: staging/],
    ["tiers without stable", { OB1_AUTH_TIERS: "canary" }, /must include stable/],
    ["an empty tier", { OB1_AUTH_TIERS: "stable," }, /OB1_AUTH_TIERS has an empty entry/],
    ["a repeated tier", { OB1_AUTH_TIERS: "stable,canary,canary" }, /OB1_AUTH_TIERS lists canary twice/],
    ["a malformed service", { OB1_AUTH_SERVICES: "runner:brain:capture" }, /is not <id>=<scope>/],
    ["a malformed id", { OB1_AUTH_SERVICES: "Runner_1=brain:read@stable" }, /"Runner_1" is not a service id/],
    ["an id ending in a hyphen", { OB1_AUTH_SERVICES: "runner-=brain:read@stable" }, /"runner-" is not a service id/],
    ["an id over 64 characters", { OB1_AUTH_SERVICES: `${"r".repeat(65)}=brain:read@stable` }, /is not a service id/],
    ["the GUI's id", { OB1_AUTH_SERVICES: "gui=brain:write@stable" }, /"gui" is a reserved client id/],
    ["the stable MCP server's id", { OB1_AUTH_SERVICES: "mcp=brain:write@stable" }, /"mcp" is a reserved client id/],
    ["a tier MCP server's id", { OB1_AUTH_SERVICES: "mcp-x=brain:read@stable" }, /"mcp-x" is a reserved client id/],
    ["a repeated id", { OB1_AUTH_SERVICES: "runner=brain:read@stable runner=brain:capture@stable" }, /"runner" is listed twice/],
    ["an unknown scope", { OB1_AUTH_SERVICES: "runner=brain:admin@stable" }, /asks for unknown scope brain:admin/],
    ["an empty scope", { OB1_AUTH_SERVICES: "runner=brain:read+@stable" }, /"runner"'s scopes has an empty entry/],
    ["a repeated scope", { OB1_AUTH_SERVICES: "runner=brain:read+brain:read@stable" }, /"runner"'s scopes lists brain:read twice/],
    ["a tier the tiers do not list", { OB1_AUTH_SERVICES: "runner=brain:capture@canary" }, /names a tier OB1_AUTH_TIERS does not: canary/],
    ["an empty service tier", { OB1_AUTH_SERVICES: "runner=brain:capture@stable," }, /"runner"'s tiers has an empty entry/],
    ["a repeated service tier", { OB1_AUTH_SERVICES: "runner=brain:capture@stable,stable" }, /"runner"'s tiers lists stable twice/],
    ["a missing origin", { OB1_PUBLIC_ORIGIN: "" }, /OB1_PUBLIC_ORIGIN is not set/],
  ];
  for (const [what, env, why] of refused) {
    let said = "(accepted)";
    try {
      layoutFromEnv({ OB1_PUBLIC_ORIGIN: O, ...env });
    } catch (e) {
      said = (e as Error).message;
    }
    expect(`the deploy's settings refuse ${what} (${said})`, why.test(said));
  }

  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    return 1;
  }
  console.log(`eval-auth self-check: ${probes} probes pass`);
  return 0;
}

// --- main -----------------------------------------------------------------

const args = process.argv.slice(2);
if (args[0] === "--self-check") process.exit(selfCheck());
const verb = args[0];
const candidate = args[1] as Candidate;
if (!["--up", "--verify", "--down"].includes(verb)) usage("unknown verb");
if (!CANDIDATES.includes(candidate)) usage(`unknown candidate ${candidate ?? "(none)"}`);
if (verb === "--up") await up(candidate);
else if (verb === "--down") await down(candidate);
else process.exit(await verify(candidate, args.includes("--json")));
