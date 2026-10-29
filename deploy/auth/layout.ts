/**
 * layout.ts — the authorization server's resources, scopes and clients
 * (SMD-2285), from the public origin and two settings.
 *
 * It follows the ADR (docs/operator-surface-tiers.md):
 * - public routes are paths on one origin, and the issuer is `<origin>/auth`;
 * - one authorization server serves every tier, and each tier's MCP server and
 *   REST core is an audience of its own (decision 14): `<origin><tier>/mcp`
 *   and `<origin><tier>/api`, with the stable tier at no prefix;
 * - an OAuth token for `/mcp` reaches the REST core only by token exchange,
 *   which keeps the subject and names the MCP service as `act` (decision 7).
 *
 * The static clients:
 * - `gui`, the operator GUI: a confidential client using authorization code
 *   with PKCE, for the stable tier's REST core;
 * - `mcp` (stable) and `mcp-<tier>`, each tier's MCP server: token exchange
 *   only, from its own tier's `/mcp` to its own tier's REST core;
 * - one service client per entry in OB1_AUTH_SERVICES: client credentials,
 *   for the named tiers' REST cores, with the named scopes.
 * Each one's secret is OB1_AUTH_SECRET_<ID> (secretName).
 *
 * Only a static client has a policy entry. A client registered dynamically
 * (DCR) or named by a metadata document (CIMD) is third-party: it may ask for
 * an MCP resource and nothing else, so it can never hold a token the REST core
 * accepts, and the server lets it register for authorization code (and
 * refresh) only, so every token it holds was approved by a user who signed in.
 * Its id is assigned by the server or is an https URL, so it cannot collide
 * with a static one.
 *
 * Dependency-free, so the proof of concept's verifier (evals/eval-auth.ts)
 * reads the same layout the server does.
 */
export const SCOPES = ["brain:read", "brain:write", "brain:capture"] as const;

/**
 * The access-key scope a set of scopes names, or null for none (SMD-2286 step
 * 5: the brain's scopes are its key scopes, one to one, and no privilege
 * exists only in OAuth). `brain:write` is a write key's, which reads and
 * captures too; `brain:read` alone a read key's; `brain:capture` alone a
 * capture key's. `brain:read` with `brain:capture` and no `brain:write` is no
 * key's, and none of the three is none. Scopes that are not the brain's
 * (`openid`, `offline_access`) are ignored. The REST core reads a token by the
 * same rule (server-portable/oauth-token.ts keyScopeOf) and refuses a token it
 * gives null for (403 insufficient_scope); server-portable/test-rest.ts holds
 * the two rules together. The server refuses such a set where a request names
 * it afresh: at the authorization request's interaction, at the exchange and
 * in OB1_AUTH_SERVICES. The library can still issue one by narrowing what a
 * client already holds (a refresh, client credentials within a service's
 * scopes, or a grant built up over two consents), and the REST core refuses
 * that token: no privilege comes of it.
 */
export function keyScopeOf(scopes: readonly string[]): "write" | "read" | "capture" | null {
  const held = new Set(scopes.filter((s) => (SCOPES as readonly string[]).includes(s)));
  if (held.has("brain:write")) return "write";
  if (held.size !== 1) return null;
  return held.has("brain:read") ? "read" : "capture";
}

/** Whether a set of scopes names brain scopes that no access key holds together: brain:read with brain:capture, without brain:write. */
export const noKeysScope = (scopes: readonly string[]) => keyScopeOf(scopes) === null && scopes.some((s) => (SCOPES as readonly string[]).includes(s));

/** The one account, whose `sub` every signed-in token carries; a service's tokens carry its client id, so no service may be named this. */
export const OPERATOR = "operator";

/**
 * Whether the REST core can name a client the operator signs in through
 * (SMD-3064). It names the caller `oauth:operator+<client>` and refuses a
 * token whose client it cannot carry on a log line, in an egress term or in
 * the search tools' 200-character `actor` filter: an id of a subject's
 * characters, or a metadata document's https URL of a host, an optional port
 * and a path alone, at most 180 characters. server-portable/oauth-token.ts
 * holds the same rule (`clientNameable`), and the REST suite holds the two
 * equal. This server's client metadata validator refuses such a client
 * wherever the library loads it, and the exchange refuses a token issued to
 * one before that, so it issues no token the REST core would refuse.
 */
export function clientNameable(id: string): boolean {
  return id.length <= 180 && /^(?:[A-Za-z0-9._~-]{1,128}|https:\/\/[A-Za-z0-9.-]{1,100}(?::[0-9]{1,5})?\/[A-Za-z0-9._~\/%-]{0,170})$/.test(id);
}

/** A grant's whole life, which no refresh token outlives: 30 days from the consent. */
export const GRANT_TTL_S = 30 * 86_400;
/** How long a refresh token lasts unused: each refresh rotates it, and the new one has this long again, within the grant's life. */
export const REFRESH_IDLE_S = 14 * 86_400;

/**
 * How long a spent refresh token is still honoured (SMD-2286, the maintainer's
 * choice): the MCP SDK refreshes without a lock, so calls meeting an expired
 * access token together all refresh with the same token, and a replay read
 * strictly revokes the grant, signing the user out (measured, 10 of 10 runs).
 * Within 10 s of its first spend, each presentation rotates it again
 * (store.ts find); after that, a replay revokes the grant. The cost, stated:
 * a token presented again inside the window, a thief's included, forks the
 * chain undetected, the fork living as any chain does. 10 s, not more,
 * because the SDK's race takes milliseconds (10 bursts of 10 parallel
 * refreshes took 0.42 s, measured) and the window is the theft's.
 */
export const REFRESH_REUSE_GRACE_S = 10;

/**
 * Whether a refresh chain begun at `iiat` may still rotate: under GRANT_TTL_S
 * old. Past it a refresh issues no new refresh token, so no chain outlives the
 * 30 days refreshTtl gives it, even when its grant is saved again later.
 */
export const chainRotates = (iiat: number | undefined, now: number) => iiat === undefined || now - iiat < GRANT_TTL_S;

/**
 * A refresh token's lifetime (SMD-2286, the maintainer's choice: rotate, 14
 * days idle): REFRESH_IDLE_S, cut to what is left of GRANT_TTL_S since the
 * first refresh token of the chain was issued (`iiat`, which oidc-provider
 * carries across every rotation), and never less than a second: a chain that
 * old has no grant left to refresh in any case.
 */
export function refreshTtl(iiat: number | undefined, now: number): number {
  const spent = iiat === undefined ? 0 : Math.max(0, now - iiat);
  return Math.max(1, Math.min(REFRESH_IDLE_S, GRANT_TTL_S - spent));
}

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** The tiers a deploy may name, and each one's path prefix on the origin. */
export const TIER_PREFIX = { stable: "", canary: "/canary", working: "/working" } as const;
export type TierName = keyof typeof TIER_PREFIX;
export type TierPrefix = (typeof TIER_PREFIX)[TierName];

export type ClientPolicy =
  | { kind: "gui"; resources: string[]; redirect: string }
  | { kind: "service"; resources: string[]; scope: string }
  | { kind: "exchange"; from: string; to: string };

/** A service identity: its scopes, and the tiers whose REST cores it may ask for. */
export type Service = { scope: string; tiers: TierName[] };

/** The environment variable holding a static client's secret. */
export const secretName = (clientId: string) => `OB1_AUTH_SECRET_${clientId.toUpperCase().replace(/-/g, "_")}`;

/** A tier's MCP server's exchange client: `mcp` for stable, `mcp-<tier>` for the others. */
export const mcpClientId = (tier: TierName) => (tier === "stable" ? "mcp" : `mcp-${tier}`);

/** Every static client's id, in the layout's order: what --init writes a secret for and the server refuses to start without. */
export const clientIds = (tiers: TierName[], services: Record<string, Service>) => ["gui", ...tiers.map(mcpClientId), ...Object.keys(services)];

export function layout(origin: string, tiers: TierName[], services: Record<string, Service>) {
  const issuer = `${origin}/auth`;
  const prefixes = tiers.map((t) => TIER_PREFIX[t]);
  const mcp = (prefix: TierPrefix) => `${origin}${prefix}/mcp`;
  const api = (prefix: TierPrefix) => `${origin}${prefix}/api`;
  const clients: Record<string, ClientPolicy> = {
    gui: { kind: "gui", resources: [api("")], redirect: `${origin}/dashboard/auth/callback` },
  };
  for (const t of tiers) clients[mcpClientId(t)] = { kind: "exchange", from: mcp(TIER_PREFIX[t]), to: api(TIER_PREFIX[t]) };
  for (const [id, s] of Object.entries(services)) clients[id] = { kind: "service", resources: s.tiers.map((t) => api(TIER_PREFIX[t])), scope: s.scope };
  const mcpResources = prefixes.map(mcp);
  return {
    origin,
    issuer,
    mcp,
    api,
    /** RFC 9728: the protected-resource metadata URL for a tier's MCP server. */
    prm: (prefix: TierPrefix) => `${origin}/.well-known/oauth-protected-resource${prefix}/mcp`,
    /** Every resource the server issues tokens for. */
    resources: [...mcpResources, ...prefixes.map(api)],
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

/** The hosts an `http:` origin may name: OAuth 2.1 allows plain HTTP for loopback alone. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The value as an error may quote it: up to its first `?` or `#`. A pasted
 * connector URL carries the access key as `?key=` (SMD-2382 review pass 3),
 * so a query or fragment is never echoed, as an `@` is not. The MCP server's
 * copy is server-portable/oauth-edge.ts.
 */
function shown(given: string): string {
  const cut = given.search(/[?#]/);
  return cut < 0 ? `"${given}"` : `"${given.slice(0, cut)}", the rest not shown`;
}

/**
 * OB1_PUBLIC_ORIGIN, without a trailing slash: a scheme, a host and an
 * optional port, nothing else. Every URL the server names starts with it, so
 * a path, a query, a fragment or credentials would leak into the issuer and
 * every endpoint. `https:`, or `http:` on a loopback host.
 */
export function originFromEnv(env: Record<string, string | undefined> = process.env): string {
  const given = env.OB1_PUBLIC_ORIGIN?.trim();
  if (!given) throw new Error("OB1_PUBLIC_ORIGIN is not set");
  // An `@` is never echoed, whether it parses or not (`user:pw@host` with no
  // scheme reads as the scheme `user:`): the value would carry a password
  // into the log. No origin holds one.
  if (given.includes("@")) throw new Error("OB1_PUBLIC_ORIGIN holds an @, so it may hold credentials (not shown): give the origin alone, e.g. https://brain.example.com");
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`OB1_PUBLIC_ORIGIN is not a URL (${shown(given)}): give the origin, e.g. https://brain.example.com`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`OB1_PUBLIC_ORIGIN must be https:// (${shown(given)})`);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) throw new Error(`OB1_PUBLIC_ORIGIN must be https:// unless its host is loopback (${shown(given)})`);
  if (given.replace(/\/$/, "") !== url.origin) throw new Error(`OB1_PUBLIC_ORIGIN must be an origin alone, with no path, query, fragment or credentials (${shown(given)} — the origin is ${url.origin})`);
  return url.origin;
}

/** A list's parts, refusing an empty one or a repeat in words: `what` names the list in the message. */
function parts(list: string, sep: string, what: string): string[] {
  const out = list.split(sep).map((s) => s.trim());
  if (out.some((s) => !s)) throw new Error(`${what} has an empty entry ("${list}")`);
  const twice = out.filter((s, i) => out.indexOf(s) !== i);
  if (twice.length) throw new Error(`${what} lists ${[...new Set(twice)].join(", ")} twice`);
  return out;
}

/**
 * OB1_AUTH_TIERS: a comma-separated list of tier names, `stable` when unset or
 * blank (compose passes an unset `${OB1_AUTH_TIERS:-}` as the empty string).
 */
export function tiersFromEnv(env: Record<string, string | undefined> = process.env): TierName[] {
  const names = parts(env.OB1_AUTH_TIERS?.trim() || "stable", ",", "OB1_AUTH_TIERS");
  const unknown = names.filter((n) => !Object.hasOwn(TIER_PREFIX, n));
  if (unknown.length) throw new Error(`OB1_AUTH_TIERS names no such tier: ${unknown.join(", ")} (known: ${Object.keys(TIER_PREFIX).join(", ")})`);
  if (!names.includes("stable")) throw new Error("OB1_AUTH_TIERS must include stable: the GUI's client is for its REST core");
  return names as TierName[];
}

/** A service id: lowercase letters, digits and inner hyphens, at most 64 characters, so its secret's name is a plain variable name. */
const SERVICE_ID = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * OB1_AUTH_SERVICES: service identities, separated by any whitespace, each
 * `<id>=<scope>[+<scope>…]@<tier>[,<tier>…]`, e.g.
 * `runner=brain:capture@stable`. Empty when unset or blank. `gui`, `mcp` and
 * `mcp-*` are the server's own clients and cannot be named here.
 */
export function servicesFromEnv(tiers: TierName[], env: Record<string, string | undefined> = process.env): Record<string, Service> {
  const out: Record<string, Service> = {};
  for (const entry of (env.OB1_AUTH_SERVICES ?? "").split(/\s+/).filter(Boolean)) {
    const m = /^([^=@]*)=([^=@]*)@([^=@]*)$/.exec(entry);
    if (!m) throw new Error(`OB1_AUTH_SERVICES: "${entry}" is not <id>=<scope>[+<scope>]@<tier>[,<tier>]`);
    const [, id, scopes, tierList] = m;
    if (!SERVICE_ID.test(id)) throw new Error(`OB1_AUTH_SERVICES: "${id}" is not a service id (lowercase letters, digits and inner hyphens, at most 64)`);
    if (id === "gui" || id === "mcp" || id.startsWith("mcp-")) throw new Error(`OB1_AUTH_SERVICES: "${id}" is a reserved client id`);
    // A service's token's subject is its id (the REST core's caller `oauth:<id>`), so it may not be the operator's.
    if (id === OPERATOR) throw new Error(`OB1_AUTH_SERVICES: "${id}" is the operator's subject; a service named so would act as the operator`);
    if (Object.hasOwn(out, id)) throw new Error(`OB1_AUTH_SERVICES: "${id}" is listed twice`);
    const scope = parts(scopes, "+", `OB1_AUTH_SERVICES: "${id}"'s scopes`);
    const badScope = scope.filter((s) => !(SCOPES as readonly string[]).includes(s));
    if (badScope.length) throw new Error(`OB1_AUTH_SERVICES: "${id}" asks for unknown scope ${badScope.join(", ")}`);
    if (noKeysScope(scope)) throw new Error(`OB1_AUTH_SERVICES: "${id}" asks for ${scope.join("+")}, which no access key holds together; brain:write reads and captures, or name one of them`);
    const named = parts(tierList, ",", `OB1_AUTH_SERVICES: "${id}"'s tiers`);
    const badTier = named.filter((t) => !(tiers as string[]).includes(t));
    if (badTier.length) throw new Error(`OB1_AUTH_SERVICES: "${id}" names a tier OB1_AUTH_TIERS does not: ${badTier.join(", ")}`);
    out[id] = { scope: scope.join(" "), tiers: named as TierName[] };
  }
  return out;
}

/** The whole layout from the environment: the origin, the tiers and the services. */
export function layoutFromEnv(env: Record<string, string | undefined> = process.env): Layout {
  const tiers = tiersFromEnv(env);
  return layout(originFromEnv(env), tiers, servicesFromEnv(tiers, env));
}
