/**
 * eval-auth.ts — SMD-2285 Work step 2: the authorization server's
 * proof-of-concept overlay, the evals/orchestration pattern.
 *
 *   bun eval-auth.ts --up <candidate>       # the stack, built from this checkout
 *   bun eval-auth.ts --verify <candidate> [--json]
 *   bun eval-auth.ts --down <candidate>     # removes the project's containers, networks and image
 *   bun eval-auth.ts --self-check           # the fetch guard, route table and policy; no stack (CI)
 *
 * <candidate> is `oidc-provider` (the winner). The stack is evals/auth/:
 * compose.yaml (proxy, stand-in MCP servers and REST cores for two tiers, a
 * metadata-document host and a bait) plus compose.<candidate>.yaml (the
 * authorization server). Only the proxy publishes a port, 127.0.0.1:8020, and
 * the origin is http://localhost:8020 with the issuer at /auth.
 *
 * What --verify checks, by the ticket's criteria (a check is a PASS or a
 * FAIL; the two MANUAL rows need a public origin and are never counted). A
 * refusal is matched by its error code, and by its reason or its cause (the
 * POC server's `error_detail`) wherever the check names one:
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
 *     internal mesh with none.
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
 *     scheme, not the host its URI names, and names the resource of a request
 *     for `openid` alone.
 *   A (2, resource indicators): every token checked has exactly one audience.
 *     A /mcp token is refused by the REST core and by the other tier, and a
 *     REST token by /mcp. An unknown resource is refused, and so are two
 *     resources at once from a client allowed both. A third-party client can
 *     neither get a REST-core token nor register for client credentials (by
 *     DCR or by metadata document) or the implicit grant (by DCR). A request
 *     that names no resource is refused before any page is shown. A token for
 *     a resource that carries no brain scope (a request for `openid` alone) is
 *     refused by the MCP server and the REST core with `insufficient_scope`.
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
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/client";
import { parseEnv } from "../db/env.ts";
import { guardedLookup, refusedName, refusedUrl, specialUse } from "./auth/fetch-guard.ts";
import { Browser, claimsOf, pkce, tampered, tokenRequest, type Claims, type TokenReply } from "./auth/flows.ts";
import { ACCESS_TOKEN_TYPE, INTERNAL, layout, NATIVE_REDIRECT, TOKEN_EXCHANGE, type Layout } from "./auth/policy.ts";
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

function down(candidate: Candidate) {
  // `--rmi all`: the image carries a custom tag, which `--rmi local` leaves behind.
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

async function bearer(url: string, token: string, method = "GET"): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" } };
  if (method === "POST") init.body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const r = await fetch(url, init);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** A GET whose Host header is the caller's choice (fetch may not send one it did not derive). */
function getWithHost(url: string, host: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const req = httpRequest({ hostname: u.hostname === "localhost" ? "127.0.0.1" : u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: { host, "x-forwarded-host": host } }, (res) => {
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

function authorizeUrl(meta: Meta, p: Record<string, string | string[] | undefined>): URL {
  const u = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries(p)) for (const one of v === undefined ? [] : [v].flat()) u.searchParams.append(k, one);
  return u;
}

async function registerRaw(meta: Meta, body: Record<string, unknown>): Promise<TokenReply> {
  const r = await fetch(meta.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

/** A public client registered through DCR, as a connector without CIMD does. */
async function register(meta: Meta, grantTypes = ["authorization_code"]): Promise<string> {
  const r = await registerRaw(meta, { client_name: "POC direct client", redirect_uris: [NATIVE_REDIRECT], grant_types: grantTypes, response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" });
  if (r.status !== 201 || !r.body.client_id) throw new Error(`registration failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return String(r.body.client_id);
}

/**
 * Authorization code + PKCE for a public client; returns the token reply, or
 * the redirect's error. `resource` goes on both requests as given (none, one
 * or several).
 */
async function publicCode(c: Ctx, clientId: string, resource: string | string[] | undefined, scope: string): Promise<TokenReply> {
  const pk = pkce();
  const back = await new Browser(c.env.OB1_AUTH_OPERATOR_PASSWORD).authorize(authorizeUrl(c.meta, { client_id: clientId, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope, resource, code_challenge: pk.challenge, code_challenge_method: "S256", state: "s" }), NATIVE_REDIRECT);
  if (!back.get("code")) return { status: 400, body: { error: back.get("error"), error_description: back.get("error_description") } };
  const params: Record<string, string | string[]> = { grant_type: "authorization_code", code: back.get("code")!, redirect_uri: NATIVE_REDIRECT, code_verifier: pk.verifier };
  if (resource !== undefined) params.resource = resource;
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

async function discovery(L: Layout, candidate: Candidate): Promise<Meta> {
  const docs = await Promise.all(L.discovery.map(async (u) => {
    const r = await fetch(u);
    return { u, status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
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
  for (const off of ["userinfo_endpoint", "end_session_endpoint", "pushed_authorization_request_endpoint"]) if (meta[off] !== undefined) wrong.push(`${off} advertised`);
  if (meta.client_id_metadata_document_supported !== true) wrong.push("CIMD not advertised");
  if (!list("token_endpoint_auth_methods_supported").includes("none")) wrong.push(`auth methods ${list("token_endpoint_auth_methods_supported")}`);
  if (meta.authorization_response_iss_parameter_supported !== true) wrong.push("no iss in authorization responses");
  for (const g of ["authorization_code", "client_credentials", TOKEN_EXCHANGE]) if (!list("grant_types_supported").includes(g)) wrong.push(`grant ${g} missing`);
  row("D1 metadata at /.well-known/oauth-authorization-server/auth", wrong.length === 0, wrong.length ? wrong.join("; ") : `issuer ${meta.issuer}, ${endpoints.length} endpoints under it, S256 only, code only, no implicit, DPoP, userinfo, logout or PAR, CIMD + "none", iss, 3 grants`);

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

  // The fetch guard: each client_id refused for its own cause, in the POC
  // server's error_detail. The mesh and localhost go by the name rule, so a
  // lookup refusing them later for their address would not pass.
  const r = c.run;
  const guarded: [string, RegExp][] = [
    [`https://bait.ob1.internal/${r}.json`, /^fetch refused: bait\.ob1\.internal names the mesh$/],
    [`https://private-host.test/${r}.json`, /^fetch refused: \S+ is private \(RFC 1918\)$/],
    [`https://127.0.0.1/${r}.json`, /^fetch refused: 127\.0\.0\.1 is loopback$/],
    [`https://[::1]/${r}.json`, /^fetch refused: ::1 is loopback$/],
    [`https://10.0.0.1/${r}.json`, /^fetch refused: 10\.0\.0\.1 is private \(RFC 1918\)$/],
    [`https://100.64.0.1/${r}.json`, /^fetch refused: 100\.64\.0\.1 is shared address space/],
    [`https://169.254.169.254/${r}`, /^fetch refused: 169\.254\.169\.254 is link-local/],
    [`https://[::ffff:127.0.0.1]/${r}.json`, /^fetch refused: \S+ maps 127\.0\.0\.1 is loopback$/],
    [`https://localhost/${r}.json`, /^fetch refused: localhost names this machine$/],
    [`https://postgres/${r}.json`, /^fetch refused: postgres is a single-label name/],
  ];
  // The library's own rules: a non-200 and its 5 KiB limit. (The guard never follows a redirect either: node:https does not.)
  const library: [string, RegExp][] = [
    [`https://cimd.test/redirect/${r}.json`, /unexpected response status 302/],
    [`https://cimd.test/big/${r}.json`, /response too large/],
  ];
  const pk = pkce();
  const probe = async (id: string): Promise<TokenReply> => {
    const res = await fetch(authorizeUrl(meta, { client_id: id, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pk.challenge, code_challenge_method: "S256" }), { redirect: "manual" });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const problems: string[] = [];
  for (const [id, cause] of [...guarded, ...library]) {
    const reply = await probe(id);
    if (!refused(reply, "invalid_client", undefined, cause)) problems.push(`${id} → ${errOf(reply)} (want ${cause})`);
  }
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
  row("R3 the fetch guard refuses internal client_ids before connecting", problems.length === 0, problems.length ? problems.join("; ") : `${guarded.length} refused by the guard, each for its own cause, the redirect and the 6 KiB document refused by the library for theirs, the bait logged the control connection and nothing else`);
  return out;
}

async function grants(c: Ctx): Promise<{ gui?: string }> {
  const { L, meta, env } = c;
  const gui = L.clients.gui;
  if (gui.kind !== "gui") throw new Error("policy: gui is not a gui client");
  const guiClient = { id: "gui", secret: env.OB1_AUTH_SECRET_GUI };
  const password = env.OB1_AUTH_OPERATOR_PASSWORD;
  const out: { gui?: string } = {};
  const start = (extra: Record<string, string>) => authorizeUrl(meta, { client_id: "gui", response_type: "code", redirect_uri: gui.redirect, scope: "brain:read brain:write", resource: L.api(""), state: "st-1", ...extra });
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
  row("G2 PKCE is required, and plain is refused", refused(asReply(noPkce), "invalid_request", /PKCE/) && refused(asReply(plain), "invalid_request", /code_challenge_method/), `no challenge → ${err(asReply(noPkce))}; plain → ${err(asReply(plain))}`);

  const pk2 = pkce();
  const back2 = await new Browser(password).authorize(start({ code_challenge: pk2.challenge, code_challenge_method: "S256" }), gui.redirect).catch(() => new URLSearchParams());
  const wrongVerifier = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: back2.get("code") ?? "", redirect_uri: gui.redirect, code_verifier: pkce().verifier }, guiClient);
  row("G3 a wrong code_verifier and a replayed code are refused", Boolean(back2.get("code")) && refused(wrongVerifier, "invalid_grant", undefined, /code_verifier does not match code_challenge/) && refused(replay, "invalid_grant", undefined, /already consumed/), `wrong verifier → ${errOf(wrongVerifier)}; replay → ${errOf(replay)}`);

  const runner = { id: "runner", secret: env.OB1_AUTH_SECRET_RUNNER };
  const cc = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: L.api(""), scope: "brain:capture" }, runner);
  const cr = claimsOf(cc.body.access_token);
  const wider = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: L.api(""), scope: "brain:write" }, runner);
  const toMcp = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", resource: L.mcp(""), scope: "brain:capture" }, runner);
  const ccOk = cc.status === 200 && oneAud(cr, L.api("")) && cr.sub === "runner" && cr.act === undefined && cr.scope === "brain:capture" && refused(wider, "invalid_scope", /requested scope is not allowed/) && refused(toMcp, "invalid_target", /may not ask/);
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
    const ok5 = shown && first.status === 200 && Boolean(first.body.refresh_token) && refreshed.status === 200 && oneAud(rc, L.mcp("")) && rc.sub === "operator" && rc.scope === "brain:read";
    row("G5 a third-party client refreshes for its granted resource, and consent said so", ok5, `consent page names the client id and http://localhost:9876, lists offline_access and explains it: ${shown}; first ${first.status} refresh_token ${first.body.refresh_token ? "issued" : "none"}; refreshed ${errOf(refreshed)} aud ${audOf(rc)} scope ${rc.scope}`);
  } catch (e) {
    row("G5 a third-party client refreshes for its granted resource, and consent said so", false, (e as Error).message);
  }
  // What the consent page says. A native client with a custom scheme returns
  // to an app, whatever host the URI names; a request for openid alone still
  // names its resource. Both are denied here: nothing is issued.
  try {
    const custom = "evilapp://localhost:8020/mcp";
    const reg6 = await registerRaw(meta, { client_name: "Open Brain dashboard", redirect_uris: [custom], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" });
    const id6 = String(reg6.body.client_id ?? "");
    const pk6 = pkce();
    const b6 = new Browser(password);
    const denied = await b6.authorize(authorizeUrl(meta, { client_id: id6, response_type: "code", redirect_uri: custom, scope: "brain:read", resource: L.mcp(""), code_challenge: pk6.challenge, code_challenge_method: "S256" }), "evilapp://", false);
    const page6 = b6.pages[b6.prompts.indexOf("consent")] ?? "";
    const appShown = page6.includes("returning to the app registered for evilapp:") && !page6.includes("returning to localhost") && page6.includes(`client ${id6} (it calls itself "Open Brain dashboard")`);
    const idO = await register(meta);
    const pkO = pkce();
    const bO = new Browser(password);
    const deniedO = await bO.authorize(authorizeUrl(meta, { client_id: idO, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "openid", resource: L.mcp(""), code_challenge: pkO.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT, false);
    const pageO = bO.pages[bO.prompts.indexOf("consent")] ?? "";
    const resourceShown = pageO.includes(`asks for openid on ${L.mcp("")}`);
    const ok6 = appShown && resourceShown && denied.get("error") === "access_denied" && deniedO.get("error") === "access_denied";
    row("G6 the consent page names where the code goes and the resource asked for", ok6, `custom scheme → "${page6.slice(0, 160)}…" (${appShown}); openid alone → "${pageO.slice(0, 160)}…" (${resourceShown}); Deny → ${denied.get("error")}, ${deniedO.get("error")}`);
  } catch (e) {
    row("G6 the consent page names where the code goes and the resource asked for", false, (e as Error).message);
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
  row("A4 an unknown resource, and two at once from a client allowed both, are refused", refused(unknown, "invalid_target", /not a resource/) && refused(two, "invalid_target", /only a single resource indicator value/), `unknown → ${err(unknown)}; both /mcp at once → ${err(two)}`);

  const asked = await register(meta).then((id) => publicCode(c, id, L.api(""), "brain:read")).catch(failed);
  row("A5 a third-party client cannot get a REST-core token", refused(asked, "invalid_target", /may not ask/), `DCR client asking for ${L.api("")} → ${err(asked)}`);

  // The third-party rule, on both registration paths.
  const ccReg = await registerRaw(meta, { grant_types: ["client_credentials"], response_types: [], redirect_uris: [], token_endpoint_auth_method: "client_secret_basic" });
  const implicitReg = await registerRaw(meta, { grant_types: ["implicit"], response_types: ["id_token"], redirect_uris: [NATIVE_REDIRECT], token_endpoint_auth_method: "none", application_type: "native" });
  const stringReg = await registerRaw(meta, { grant_types: "client_credentials", redirect_uris: [NATIVE_REDIRECT] });
  const pk = pkce();
  // Refused by the rule, which runs on the fetched document: the refusal itself shows the document was fetched and read.
  const cimdCc = await fetch(authorizeUrl(meta, { client_id: `https://cimd.test/cc/${c.run}.json`, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", resource: L.mcp(""), code_challenge: pk.challenge, code_challenge_method: "S256" }), { redirect: "manual" });
  const cimdCcBody: TokenReply = { status: cimdCc.status, body: (await cimdCc.json().catch(() => ({}))) as Record<string, unknown> };
  const a6 = refused(ccReg, "invalid_client_metadata", /third-party/) && refused(implicitReg, "invalid_client_metadata", /third-party/) && refused(stringReg, "invalid_client_metadata", /array of strings/) && refused(cimdCcBody, "invalid_client_metadata", /third-party/);
  row("A6 a third-party client cannot register for client credentials or implicit", a6, `DCR client_credentials → ${err(ccReg)}; DCR implicit → ${err(implicitReg)}; DCR grant_types as a string → ${err(stringReg)}; CIMD document with client_credentials → ${err(cimdCcBody)}`);

  const noResourceCc = await tokenRequest(meta.token_endpoint, { grant_type: "client_credentials", scope: "brain:capture" }, runner);
  // At authorization it is refused before any page: no sign-in, no consent, no code.
  const noResourceBrowser = new Browser(env.OB1_AUTH_OPERATOR_PASSWORD);
  const pk7 = pkce();
  const noResourceBack = await register(meta)
    .then((id) => noResourceBrowser.authorize(authorizeUrl(meta, { client_id: id, response_type: "code", redirect_uri: NATIVE_REDIRECT, scope: "brain:read", code_challenge: pk7.challenge, code_challenge_method: "S256" }), NATIVE_REDIRECT))
    .catch((e: Error) => new URLSearchParams({ error: e.message }));
  const noResourceCode: TokenReply = { status: 400, body: { error: noResourceBack.get("error"), error_description: noResourceBack.get("error_description") } };
  const a7 = refused(noResourceCc, "invalid_target", /name the resource/) && refused(noResourceCode, "invalid_target", /name the resource/) && noResourceBrowser.prompts.length === 0 && !noResourceBack.get("code");
  row("A7 a request that names no resource gets no token", a7, `client credentials → ${err(noResourceCc)}; authorization → ${err(noResourceCode)} after ${noResourceBrowser.prompts.length} pages`);

  // A token for a resource can carry no brain scope (a request for openid
  // alone), and each resource must refuse it for that.
  const bareMcp = await register(meta).then((id) => publicCode(c, id, L.mcp(""), "openid")).catch(failed);
  const bareMcpClaims = claimsOf(bareMcp.body.access_token);
  const atMcp = bareMcp.status === 200 ? await bearer(L.mcp(""), String(bareMcp.body.access_token), "POST") : { status: 0, body: {} };
  const guiPk = pkce();
  const gui = L.clients.gui;
  const guiRedirect = gui.kind === "gui" ? gui.redirect : "";
  const guiBack = await new Browser(env.OB1_AUTH_OPERATOR_PASSWORD).authorize(authorizeUrl(meta, { client_id: "gui", response_type: "code", redirect_uri: guiRedirect, scope: "openid", resource: L.api(""), code_challenge: guiPk.challenge, code_challenge_method: "S256" }), guiRedirect).catch(() => new URLSearchParams());
  const bareRest = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: guiBack.get("code") ?? "", redirect_uri: guiRedirect, code_verifier: guiPk.verifier }, { id: "gui", secret: env.OB1_AUTH_SECRET_GUI });
  const atRest = bareRest.status === 200 ? await bearer(`${L.api("")}/whoami`, String(bareRest.body.access_token)) : { status: 0, body: {} };
  const a8 = bareMcp.status === 200 && oneAud(bareMcpClaims, L.mcp("")) && !bareMcpClaims.scope && atMcp.status === 403 && atMcp.body.error === "insufficient_scope" && bareRest.status === 200 && atRest.status === 403 && atRest.body.error === "insufficient_scope";
  row("A8 a token with no brain scope is refused by the MCP server and the REST core", a8, `/mcp token for openid alone: ${bareMcp.status}, aud ${audOf(bareMcpClaims)}, scope "${bareMcpClaims.scope ?? ""}" → /mcp ${atMcp.status} ${atMcp.body.error ?? ""}; REST token likewise: ${bareRest.status} → REST ${atRest.status} ${atRest.body.error ?? ""}`);
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
    // RFC 6749 names unauthorized_client; oidc-provider 9.12.2 answers invalid_request ("requested grant type is not allowed for this client").
    ["the GUI client, which has no exchange grant", te(subject, {}, { id: "gui", secret: env.OB1_AUTH_SECRET_GUI }), ["unauthorized_client", "invalid_request"], /not allowed/],
    ["a wrong MCP client secret", te(subject, {}, { id: "mcp", secret: "not-the-secret" }), "invalid_client", undefined, /invalid secret/],
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
  const env = parseEnv(readFileSync(ENV_FILE, "utf8"));
  const L = layout(env.OB1_PUBLIC_ORIGIN);
  const t0 = Date.now();
  const runLog = logsFromNow(candidate, ["cimd", "bait"]);
  const run = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const meta = await discovery(L, candidate);
  const c: Ctx = { L, meta, env, candidate, runLog, run };
  const { cimd } = await registration(c);
  const { gui } = await grants(c);
  await audiences(c, cimd?.accessToken, gui);
  await exchange(c, cimd, gui);
  row("M1 claude.ai connector", "manual", `needs a public origin (claude.ai refuses private and CGNAT hosts): add ${L.mcp("")} as a custom connector and sign in`);
  row("M2 Claude Code 2.1.275 on the bare metadata path", "manual", `claude mcp add --transport http poc ${L.mcp("")}, then /mcp: it reads ${L.discovery[3]}, whose issuer is ${L.issuer}`);

  const counted = rows.filter((r) => r.pass !== "manual");
  const failing = counted.filter((r) => !r.pass);
  if (json) console.log(JSON.stringify({ candidate, run, seconds: (Date.now() - t0) / 1000, rows }, null, 2));
  else {
    for (const r of rows) console.log(`${r.pass === "manual" ? "MANUAL" : r.pass ? "PASS  " : "FAIL  "} ${r.id}\n         ${r.detail}`);
    console.log(`\n${candidate}: ${counted.length - failing.length}/${counted.length} checks pass in ${((Date.now() - t0) / 1000).toFixed(1)} s${failing.length ? ` — FAILED: ${failing.map((r) => r.id.split(" ")[0]).join(", ")}` : ""}`);
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
  const special = ["0.1.2.3", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2001::1", "2002:a00:1::", "fc00::1", "fd12:3456::1", "fe80::1", "fec0::1", "ff02::1", "fe80::1%eth0"];
  const routable = ["1.1.1.1", "8.8.8.8", "11.0.0.10", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450::1", "::ffff:8.8.8.8"];
  for (const a of special) expect(`${a} is special-use`, /^\S+ (is|maps) /.test(specialUse(a) ?? "") && !/not an IP address/.test(specialUse(a) ?? ""));
  for (const a of routable) expect(`${a} is routable`, specialUse(a) === null);
  expect("a name is not an address", specialUse("example.com") !== null);

  for (const h of ["localhost", "LOCALHOST", "a.localhost", "ob1.internal", "api.ob1.internal", "api.ob1.internal.", "postgres"]) expect(`${h} is refused by name`, refusedName(h) !== null);
  for (const h of ["cimd.test", "claude.ai", "example.com", "ob1.internal.example.com"]) expect(`${h} passes the name rule`, refusedName(h) === null);
  expect("http: is refused", refusedUrl(new URL("http://claude.ai/x")) !== null);
  expect("POST is refused", refusedUrl(new URL("https://claude.ai/x"), "POST") !== null);
  expect("an IPv6 loopback literal is refused", refusedUrl(new URL("https://[::1]/x")) !== null);
  expect("a mapped IPv4 loopback literal is refused", refusedUrl(new URL("https://[::ffff:127.0.0.1]/x")) !== null);
  expect("a routable literal passes", refusedUrl(new URL("https://1.1.1.1/x")) === null);
  expect("a public name passes to the lookup", refusedUrl(new URL("https://claude.ai/oauth/client.json")) === null);

  // The lookup: every answer is checked, one special-use answer refuses the name.
  const answer = (addrs: string[]) => ((_h: string, _o: unknown, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => cb(null, addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 })))) as never;
  const lookedUp = (addrs: string[], all: boolean) => {
    const logs: string[] = [];
    let result: { err: Error | null; value: unknown } = { err: null, value: undefined };
    guardedLookup((l) => logs.push(l), "https://x.test/", answer(addrs))("x.test", { all }, (e, v) => {
      result = { err: e, value: v };
    });
    return { ...result, logs };
  };
  expect("a public answer passes", lookedUp(["1.1.1.1"], false).value === "1.1.1.1");
  expect("all public answers pass as a list", Array.isArray(lookedUp(["1.1.1.1", "2606:4700::1"], true).value));
  const mixed = lookedUp(["1.1.1.1", "10.0.0.5"], true);
  expect("one private answer among public ones refuses the name, and logs it", mixed.err !== null && mixed.logs.some((l) => l.includes("10.0.0.5")));
  expect("a loopback answer is refused", lookedUp(["127.0.0.1"], false).err !== null);
  expect("no answer is refused", lookedUp([], true).err !== null);

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
else if (verb === "--down") down(candidate);
else process.exit(await verify(candidate, args.includes("--json")));
