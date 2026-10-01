/**
 * policy.ts — one layout for every piece of the authorization POC (SMD-2285).
 *
 * The stand-in MCP servers and REST cores, the proxy, the runner-up and the
 * verifier read their URLs, resources, scopes and clients from here, so a
 * candidate and its checks cannot disagree about what a name means. The layout
 * itself is the deploy's (deploy/auth/layout.ts), read with the settings in
 * POC_ENV. The winner, the deploy's own server, reads the same layout from its
 * environment: stack.ts sets POC_ENV's values in evals/auth/.env on every
 * `--up`, and the winner's overlay passes them on:
 * - two tiers, stable (no prefix) and canary;
 * - two service clients: `runner`, for the stable REST core, and
 *   `runner-tiers`, linked to both tiers' REST cores, as a deploy might link
 *   the runner: it must still get one audience per token (A4).
 *
 * Dependency-free, so both the container side and the verifier import it.
 */
import { layoutFromEnv } from "../../deploy/auth/layout.ts";

export { ACCESS_TOKEN_TYPE, originFromEnv, SCOPES, secretName, TOKEN_EXCHANGE, type ClientPolicy, type Layout } from "../../deploy/auth/layout.ts";

export const TIERS = ["", "/canary"] as const;
export type Tier = (typeof TIERS)[number];

/** The deploy's settings for the POC's layout. */
export const POC_ENV = {
  OB1_AUTH_TIERS: "stable,canary",
  OB1_AUTH_SERVICES: "runner=brain:capture@stable runner-tiers=brain:capture@stable,canary",
};

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

export function layout(origin: string) {
  return layoutFromEnv({ OB1_PUBLIC_ORIGIN: origin, ...POC_ENV });
}
