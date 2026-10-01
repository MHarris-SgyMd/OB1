/**
 * policy.ts — one layout for every piece of the authorization POC (SMD-2285).
 *
 * The authorization server, the stand-in MCP servers and REST cores, the proxy
 * and the verifier all read their URLs, resources, scopes and clients from here,
 * so a candidate and its checks cannot disagree about what a name means. It
 * follows the ADR (docs/operator-surface-tiers.md):
 * - public routes are paths on one origin (decision 5), the issuer is
 *   `<origin>/auth`, and internal names are `*.ob1.internal`;
 * - one authorization server serves every tier, and each tier's MCP server and
 *   REST core is an audience of its own (decision 14). Two tiers here, stable
 *   (no prefix) and canary;
 * - an OAuth token for `/mcp` reaches the REST core only by token exchange,
 *   which keeps the subject and names the MCP service as `act` (decision 7).
 *
 * Only statically configured clients have a policy entry. A client registered
 * dynamically (DCR) or named by a metadata document (CIMD) is third-party: it
 * may ask for an MCP resource and nothing else, so it can never hold a token
 * the REST core accepts, and the server lets it register for authorization
 * code (and refresh) only, so every token it holds was approved by a user who
 * signed in. Its id is assigned by the server or is an https URL, so it cannot
 * collide with a name below.
 *
 * Dependency-free, so both the container side and the verifier import it.
 */
export const SCOPES = ["brain:read", "brain:write", "brain:capture"] as const;
export const TIERS = ["", "/canary"] as const;
export type Tier = (typeof TIERS)[number];

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** Where each piece listens inside the mesh. The proxy is the only published port. */
export const INTERNAL = {
  auth: "http://auth.ob1.internal:3000",
  mcpPort: { "": 8100, "/canary": 8101 } as Record<Tier, number>,
  apiPort: { "": 8200, "/canary": 8201 } as Record<Tier, number>,
  api: (tier: Tier) => `http://api.ob1.internal:${INTERNAL.apiPort[tier]}`,
  mcp: (tier: Tier) => `http://mcp.ob1.internal:${INTERNAL.mcpPort[tier]}`,
};

/** The redirect URI every public test client registers: never listened on, the verifier reads the redirect instead. */
export const NATIVE_REDIRECT = "http://localhost:9876/callback";

export type ClientPolicy =
  | { kind: "gui"; resources: string[]; redirect: string }
  | { kind: "service"; resources: string[]; scope: string }
  | { kind: "exchange"; from: string; to: string };

export function layout(origin: string) {
  const issuer = `${origin}/auth`;
  const mcp = (tier: Tier) => `${origin}${tier}/mcp`;
  const api = (tier: Tier) => `${origin}${tier}/api`;
  const clients: Record<string, ClientPolicy> = {
    gui: { kind: "gui", resources: [api("")], redirect: `${origin}/dashboard/auth/callback` },
    runner: { kind: "service", resources: [api("")], scope: "brain:capture" },
    // A service linked to both tiers' REST cores, as a deploy might link the runner: it must still get one audience per token (A4).
    "runner-tiers": { kind: "service", resources: [api(""), api("/canary")], scope: "brain:capture" },
    mcp: { kind: "exchange", from: mcp(""), to: api("") },
    "mcp-canary": { kind: "exchange", from: mcp("/canary"), to: api("/canary") },
  };
  const mcpResources = TIERS.map(mcp);
  return {
    origin,
    issuer,
    mcp,
    api,
    /** RFC 9728: the protected-resource metadata URL for a tier's MCP server. */
    prm: (tier: Tier) => `${origin}/.well-known/oauth-protected-resource${tier}/mcp`,
    /** Every resource the server issues tokens for. */
    resources: [...mcpResources, ...TIERS.map(api)],
    clients,
    /** The resources a client may ask for: its policy's, or the MCP servers' for a third-party client. */
    allowedResources(clientId: string): string[] {
      if (!Object.hasOwn(clients, clientId)) return mcpResources;
      const p = clients[clientId];
      return p.kind === "exchange" ? [] : p.resources;
    },
    /** The four discovery paths the proxy routes to the server: RFC 8414 and OIDC under the issuer's path, and Claude Code's bare one. */
    discovery: [
      `${origin}/.well-known/oauth-authorization-server/auth`,
      `${origin}/.well-known/openid-configuration/auth`,
      `${issuer}/.well-known/openid-configuration`,
      `${origin}/.well-known/oauth-authorization-server`,
    ],
  };
}
export type Layout = ReturnType<typeof layout>;

/** Read the environment every container shares. */
export function originFromEnv(env: Record<string, string | undefined> = process.env): string {
  const origin = env.OB1_PUBLIC_ORIGIN;
  if (!origin) throw new Error("OB1_PUBLIC_ORIGIN is not set");
  return origin.replace(/\/$/, "");
}
