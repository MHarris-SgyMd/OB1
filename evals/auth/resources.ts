/**
 * resources.ts — stand-ins for each tier's MCP server and REST core (SMD-2285).
 *
 * Neither server exists yet in the shape the ADR gives them (SMD-2287,
 * SMD-2284), so the POC runs the smallest version of the two hops the
 * authorization server must serve:
 *
 * - **MCP server** (stable :8100, canary :8101). A real SDK v2 MCP server, so the
 *   verifier's SDK v2 client runs its own discovery and authorization against
 *   it. It publishes RFC 9728 metadata and answers a request without a valid
 *   token for ITS resource with 401 and `WWW-Authenticate: Bearer
 *   resource_metadata=…`. Its one tool, `whoami`, exchanges the caller's token
 *   for one for the same tier's REST core (it never passes the caller's token
 *   on), calls the REST core with it, and returns what the REST core saw.
 * - **REST core** (stable :8200, canary :8201). It accepts only a JWT this
 *   issuer signed for ITS resource, and reports the subject as `oauth:<sub>`
 *   and the actor from `act`, as SMD-2286 records them.
 *
 * Both verify tokens against the server's JWKS, fetched across the mesh, and
 * answer a valid token that carries none of the brain's scopes with 403
 * `insufficient_scope` (RFC 6750): a request for `openid` alone can still get
 * a token for a resource, with an empty scope.
 */
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ACCESS_TOKEN_TYPE, INTERNAL, layout, originFromEnv, SCOPES, TIERS, TOKEN_EXCHANGE, type Tier } from "./policy.ts";

const L = layout(originFromEnv());
const keys = createRemoteJWKSet(new URL(`${INTERNAL.auth}/auth/jwks`));

type Verdict = { ok: true; claims: JWTPayload & { act?: { sub?: string }; scope?: string; client_id?: string } } | { ok: false; reason: string; presented: boolean };

/** Does a token carry any of the brain's scopes? */
const brainScoped = (scope: unknown) => String(scope ?? "").split(" ").some((s) => (SCOPES as readonly string[]).includes(s));
const noScope = () => json(403, { error: "insufficient_scope" }, { "www-authenticate": `Bearer error="insufficient_scope", scope="${SCOPES.join(" ")}"` });

async function check(req: Request, audience: string): Promise<Verdict> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer (\S+)$/i.exec(header);
  if (!m) return { ok: false, reason: "no bearer token", presented: false };
  try {
    const { payload } = await jwtVerify(m[1], keys, { issuer: L.issuer, audience, algorithms: ["ES256"], typ: "at+jwt" });
    return { ok: true, claims: payload };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, presented: true };
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

function restCore(tier: Tier) {
  const audience = L.api(tier);
  Bun.serve({
    hostname: "0.0.0.0",
    port: INTERNAL.apiPort[tier],
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/whoami")) return json(404, { error: "not_found" });
      const v = await check(req, audience);
      if (!v.ok) return json(401, { error: "invalid_token", reason: v.reason }, { "www-authenticate": `Bearer error="invalid_token"` });
      if (!brainScoped(v.claims.scope)) return noScope();
      const c = v.claims;
      return json(200, { subject: `oauth:${c.sub}`, actor: c.act?.sub ?? null, client_id: c.client_id, scope: c.scope, aud: c.aud, exp: c.exp });
    },
  });
}

/**
 * The token endpoint's path, read once from the server's own metadata across
 * the mesh: each candidate puts it somewhere else (/auth/token, /auth/oauth2/token).
 * The metadata's URLs name the public origin, which the mesh cannot reach, so
 * only the path is kept.
 */
let tokenPath: Promise<string> | undefined;
function tokenEndpoint(): Promise<string> {
  tokenPath ??= fetch(`${INTERNAL.auth}/auth/.well-known/openid-configuration`)
    .then((r) => r.json() as Promise<{ token_endpoint: string }>)
    .then((m) => new URL(m.token_endpoint).pathname)
    .catch((e) => {
      tokenPath = undefined;
      throw e;
    });
  return tokenPath.then((path) => `${INTERNAL.auth}${path}`);
}

async function exchange(tier: Tier, subjectToken: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const id = tier === "" ? "mcp" : "mcp-canary";
  const secret = process.env[`OB1_AUTH_SECRET_${id.toUpperCase().replace(/-/g, "_")}`] ?? "";
  const r = await fetch(await tokenEndpoint(), {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token: subjectToken, subject_token_type: ACCESS_TOKEN_TYPE, resource: L.api(tier) }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

function mcpServer(tier: Tier) {
  const resource = L.mcp(tier);
  const prmPath = new URL(L.prm(tier)).pathname;
  const mcpPath = new URL(resource).pathname;
  const challenge = (presented: boolean) => `Bearer resource_metadata="${L.prm(tier)}"${presented ? `, error="invalid_token"` : ""}`;
  Bun.serve({
    hostname: "0.0.0.0",
    port: INTERNAL.mcpPort[tier],
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === prmPath) {
        return json(200, { resource, authorization_servers: [L.issuer], scopes_supported: SCOPES, bearer_methods_supported: ["header"] });
      }
      if (path !== mcpPath) return json(404, { error: "not_found" });
      const v = await check(req, resource);
      if (!v.ok) return json(401, { error: "invalid_token", reason: v.reason }, { "www-authenticate": challenge(v.presented) });
      if (!brainScoped(v.claims.scope)) return noScope();
      const incoming = (req.headers.get("authorization") ?? "").slice("Bearer ".length);

      const server = new McpServer({ name: `ob1-auth-poc-mcp${tier}`, version: "0.0.0" });
      server.registerTool("whoami", { description: "What the REST core sees for this caller, reached by token exchange.", inputSchema: {} }, async () => {
        const ex = await exchange(tier, incoming);
        if (ex.status !== 200) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ exchange: ex }) }] };
        const r = await fetch(`${INTERNAL.api(tier)}${new URL(L.api(tier)).pathname}/whoami`, { headers: { authorization: `Bearer ${ex.body.access_token}` } });
        const seen = await r.json().catch(() => ({}));
        return { isError: r.status !== 200, content: [{ type: "text" as const, text: JSON.stringify({ status: r.status, seen }) }] };
      });
      const transport = new WebStandardStreamableHTTPServerTransport();
      await server.connect(transport);
      const body = req.method === "POST" ? await req.text() : undefined;
      const response = await transport.handleRequest(new Request(req.url, { method: req.method, headers: req.headers, body }));
      return response ?? json(500, { error: "no response from the MCP transport" });
    },
  });
}

for (const tier of TIERS) {
  restCore(tier);
  mcpServer(tier);
}
console.log(`stand-ins up: MCP ${TIERS.map((t) => INTERNAL.mcpPort[t]).join(",")}, REST ${TIERS.map((t) => INTERNAL.apiPort[t]).join(",")}`);
