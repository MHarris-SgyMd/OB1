/**
 * oauth-edge.ts — what the MCP server says about OAuth at the public origin
 * (SMD-2382, ADR decision 16 in docs/operator-surface-tiers.md).
 *
 * Two states, never confused:
 * - **Configured** is static: COMPOSE_PROFILES names `auth`, as the
 *   authorization server requires of its own copy (deploy/auth/config.ts).
 *   With it comes OB1_PUBLIC_ORIGIN, the one origin the issuer, the
 *   protected-resource URL and every redirect URI start with.
 * - **Reachable** is dynamic: the authorization server answers its health
 *   check on the mesh (`AuthReachability`, cached for `REACHABILITY_TTL_MS`).
 *
 * Only what is advertised keys on reachable: the protected-resource document
 * (RFC 9728) and the 401 challenge that names it. So knocking the
 * authorization server over closes those and opens nothing; an OAuth token
 * then gets a 503, not a 401 that would restart its client's sign-in.
 *
 * Only a request for the public resource is answered this way: its `Host` is
 * the origin's, and its path is exactly `/mcp`, the `resource` the document
 * names (RFC 9728 §3.3 wants them identical), with any query. A client at
 * any `Host` but the origin's (loopback, a LAN address, another name), on
 * `/mcp/`, or on the root URL kept for SMD-2306's window dialled a URL that
 * is not that resource, so an OAuth flow could never finish for it; it gets
 * today's answers in every state. So does every request on a stack whose
 * origin is unsound: there is no resource to recognise. Keying on
 * `Host` fails safe — a tunnel that rewrites it only suppresses the
 * challenge — and no rule that admits anyone keys on it. A key presented in
 * any form, even empty, is a key client's, and a wrong one is refused as
 * today, so this server's 401 never sends a key client to sign in. (A
 * claude.ai connector finds the document by itself, without its key, once
 * the proxy routes it: SMD-2382's next cut, and SMD-2286's.)
 *
 * The MCP server accepts no OAuth token yet: SMD-2286 checks them and
 * exchanges each at the hop. Until then a token is answered 401
 * `invalid_token`.
 */

/** The hosts an `http:` origin may name: OAuth 2.1 allows plain HTTP for loopback alone. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The scopes the authorization server issues (deploy/auth/layout.ts SCOPES), one per key scope. */
export const OAUTH_SCOPES = ["brain:read", "brain:write", "brain:capture"] as const;

/** The public resource's path, and where its protected-resource document lives (RFC 9728 §3.1, path-inserted). */
export const RESOURCE_PATH = "/mcp";
export const PRM_PATH = `/.well-known/oauth-protected-resource${RESOURCE_PATH}`;

/**
 * The authorization server's health check, by its mesh name. Written rooted,
 * as the proxy's route is (deploy/compose.yaml), so a host's DNS search domain
 * is never tried for it. Bun's fetch honours HTTP_PROXY, so a server given one
 * needs NO_PROXY to name this host; compose passes the server neither.
 */
export const AUTH_HEALTH_URL = "http://auth.ob1.internal.:3000/healthz";
export const REACHABILITY_TTL_MS = 30_000;
export const REACHABILITY_TIMEOUT_MS = 2_000;

/** How long an OAuth client is asked to wait while the authorization server is not answering. */
export const UNREACHABLE_RETRY_AFTER_SECONDS = 30;

/** Whether COMPOSE_PROFILES names `auth`: the rule deploy/auth/config.ts's configuredIn applies. */
export function configuredIn(profiles: string | undefined): boolean {
  return (profiles ?? "").split(",").some((p) => p.trim() === "auth");
}

/**
 * The value as an error may quote it: up to its first `?` or `#`. A pasted
 * connector URL carries the access key as `?key=` (SMD-2382 review pass 3),
 * so a query or fragment is never echoed, as an `@` is not.
 */
function shown(given: string): string {
  const cut = given.search(/[?#]/);
  return cut < 0 ? `"${given}"` : `"${given.slice(0, cut)}", the rest not shown`;
}

/**
 * Why OB1_PUBLIC_ORIGIN cannot be the public origin, or null when it can. The
 * rules are deploy/auth/layout.ts's originFromEnv, which refuses to start the
 * authorization server on any of them (test-server.ts [11a] holds the two
 * together): `https:`, or `http:` on a loopback host, and an origin alone. A
 * value holding an `@` is never echoed, since it may hold credentials, and
 * nothing from a `?` or `#` on is (shown).
 */
export function originProblem(value: string | undefined): string | null {
  const given = value?.trim();
  if (!given) return "OB1_PUBLIC_ORIGIN is not set";
  if (given.includes("@")) return "OB1_PUBLIC_ORIGIN holds an @, so it may hold credentials (not shown)";
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    return `OB1_PUBLIC_ORIGIN is not a URL (${shown(given)})`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return `OB1_PUBLIC_ORIGIN must be https:// (${shown(given)})`;
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return `OB1_PUBLIC_ORIGIN must be https:// unless its host is loopback (${shown(given)})`;
  if (given.replace(/\/$/, "") !== url.origin) return `OB1_PUBLIC_ORIGIN must be an origin alone, with no path, query, fragment or credentials (${shown(given)} — the origin is ${url.origin})`;
  return null;
}

/** The edge's static settings: the origin when the stack is configured and the origin is sound, else null. */
export type EdgeSettings = { configured: boolean; origin: string | null };

export function edgeSettings(env: { COMPOSE_PROFILES?: string; OB1_PUBLIC_ORIGIN?: string }): EdgeSettings {
  const configured = configuredIn(env.COMPOSE_PROFILES);
  const origin = configured && originProblem(env.OB1_PUBLIC_ORIGIN) === null ? new URL(env.OB1_PUBLIC_ORIGIN!.trim()).origin : null;
  return { configured, origin };
}

/** The protected-resource document for the public `/mcp` (RFC 9728 §2). */
export function protectedResourceDocument(origin: string) {
  return {
    resource: `${origin}${RESOURCE_PATH}`,
    authorization_servers: [`${origin}/auth`],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The challenge (RFC 6750 §3, RFC 9728 §5.1). A request that presented no
 * key form and no token gets no error code; one whose token was refused gets
 * `invalid_token`, saying why.
 */
export function challengeHeader(origin: string, refusedToken: boolean): string {
  const metadata = `resource_metadata="${origin}${PRM_PATH}"`;
  return refusedToken
    ? `Bearer ${metadata}, error="invalid_token", error_description="this server accepts no OAuth token yet; use an access key"`
    : `Bearer ${metadata}`;
}

/**
 * The shape of a JWT: three base64url segments. Every access token the
 * authorization server issues is one (deploy/auth/server.ts:
 * `accessTokenFormat: "jwt"`, and a request naming no resource is refused),
 * while a key keygen.ts mints is hex and has no dots, so a bearer value of
 * this shape is an OAuth client's token, not a key sent as
 * `Authorization: Bearer`. A legacy raw MCP_ACCESS_KEY written with two dots
 * would read as a token too; keygen.ts never mints one.
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * What a refused request presented: no key form, a key (in any of auth.ts's
 * forms, empty or malformed included), or only a bearer token of a JWT's
 * shape. Any key form beside a token makes it a key client, as a gateway's
 * own token beside `?key=` is (auth.ts presentedKeys). Another scheme
 * (`Basic`) is no key form: auth.ts reads none from it.
 */
export type Presented = "none" | "key" | "token";

export function presentedKind(req: Request): Presented {
  // Present, not truthy: a connector pasted with an empty key is still a key client.
  if (req.headers.has("x-brain-key") || req.headers.has("x-access-key") || new URL(req.url).searchParams.has("key")) return "key";
  // The Bearer scheme with anything after it, or nothing: a client whose key
  // variable is unset sends `Bearer ` (which arrives as `Bearer`), and is a
  // key client all the same (review pass 3).
  const scheme = req.headers.get("authorization")?.trim().match(/^Bearer(?:\s+(.*))?$/i);
  if (!scheme) return "none";
  return JWT_SHAPE.test(scheme[1]?.trim() ?? "") ? "token" : "key";
}

/**
 * The request's URL when its `Host` is the origin's, else null. The server is
 * reached over plain HTTP behind the proxy, so the runtime's URL says
 * `http://<Host>` whatever the client dialled; the `Host` is read again under
 * the origin's own scheme, so the host name is compared as the URL normalises
 * it and only that scheme's default port (`:443` from a TLS front, for an
 * `https:` origin) counts as none. A `Host` that is not a bare host and port
 * (`x:99999`, `user@host`, `host/x`) is not the origin's. A request built
 * with no `Host` (a suite's) is read by its URL's.
 */
function atOrigin(req: Request, origin: string): URL | null {
  const o = new URL(origin);
  let url: URL, host: URL;
  try {
    url = new URL(req.url);
    host = new URL(`${o.protocol}//${req.headers.get("host") ?? url.host}`);
  } catch {
    return null;
  }
  if (host.username || host.password || host.pathname !== "/" || host.search || host.hash) return null;
  return host.host === o.host ? url : null;
}

/** Whether a request is for the public resource: the origin's host, and exactly the resource's path. */
export function forPublicResource(req: Request, origin: string): boolean {
  return atOrigin(req, origin)?.pathname === RESOURCE_PATH;
}

/** Whether a request is for the public resource's protected-resource document. */
export function forPublicDocument(req: Request, origin: string): boolean {
  return atOrigin(req, origin)?.pathname === PRM_PATH;
}

/**
 * How a refused request is answered at the edge: `today` (the JSON-RPC
 * refusal every client has had), a 401 `challenge` (`refusedToken` when it
 * held a token), or `unavailable` (503) for a token while the authorization
 * server is not answering. `reachable` is asked only when the answer turns on
 * it, so a request off the public resource never waits on the probe.
 */
export type EdgeAnswer = { kind: "today" } | { kind: "challenge"; origin: string; refusedToken: boolean } | { kind: "unavailable" };

export async function refusalAt(
  settings: EdgeSettings,
  req: Request,
  reachable: () => Promise<boolean>,
): Promise<EdgeAnswer> {
  if (!settings.origin || !forPublicResource(req, settings.origin)) return { kind: "today" };
  const presented = presentedKind(req);
  if (presented === "key") return { kind: "today" };
  if (await reachable()) return { kind: "challenge", origin: settings.origin, refusedToken: presented === "token" };
  return presented === "token" ? { kind: "unavailable" } : { kind: "today" };
}

/**
 * Whether the authorization server answers its health check: a 200 within
 * `timeoutMs`. The answer, either way, is kept for `ttlMs`, and one check is
 * in flight at a time, so a burst of keyless requests costs one probe.
 */
export class AuthReachability {
  private value: boolean | null = null;
  private expires = 0;
  private inflight: Promise<boolean> | null = null;

  constructor(
    private readonly url: string = AUTH_HEALTH_URL,
    private readonly ttlMs: number = REACHABILITY_TTL_MS,
    private readonly timeoutMs: number = REACHABILITY_TIMEOUT_MS,
    // Called as a plain function: a method call on the global fetch is an
    // "Illegal invocation" on Workers.
    private readonly fetchFn: typeof fetch = ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i)) as typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  reachable(): Promise<boolean> {
    if (this.value !== null && this.now() < this.expires) return Promise.resolve(this.value);
    if (!this.inflight) {
      // Started inside the chain, so a fetch that throws at once is down, not a rejection.
      this.inflight = Promise.resolve()
        .then(() => this.fetchFn(this.url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "manual" }))
        .then((r) => {
          void r.body?.cancel().catch(() => {});
          return r.status === 200;
        }, () => false)
        .then((up) => {
          this.value = up;
          this.expires = this.now() + this.ttlMs;
          this.inflight = null;
          return up;
        });
    }
    return this.inflight;
  }
}

// The process's probe, built on first use. A suite swaps in its own (useAuthReachability).
let probe: AuthReachability | null = null;
export function authReachability(): AuthReachability {
  if (!probe) probe = new AuthReachability();
  return probe;
}
export function useAuthReachability(p: AuthReachability | null): void {
  probe = p;
}
