/**
 * oauth-token.ts — the REST core's check of the authorization server's access
 * tokens (SMD-2286 step 1; docs/operator-surface-tiers.md, Identity).
 *
 * The REST core is the only resource server that authorizes. Beside the
 * access keys (auth.ts, untouched: its copies are byte-synced into the
 * vendored servers), it accepts a bearer JWT the authorization server signed
 * for it, and only on a configured stack (oauth-edge.ts edgeSettings:
 * COMPOSE_PROFILES names `auth` and OB1_PUBLIC_ORIGIN is sound). A token is
 * accepted when:
 * - its issuer is `<origin>/auth` and its audience exactly `<origin>/api`, so
 *   a token for `/mcp` is refused here: it reaches the REST core only by the
 *   exchange, which the MCP server makes (deploy/auth/server.ts);
 * - it is ES256 with `typ: at+jwt`, signed by a key of the authorization
 *   server's JWKS, read on the mesh and cached; it has not expired;
 * - its `brain:` scopes name one key scope's worth (keyScopeOf).
 *
 * What it becomes is a Principal like a key's, so every rule after the
 * authentication (scopes, the registry, egress, jobs, the audit row) is the
 * key's:
 * - `name` is `oauth:<sub>`. A key's name cannot hold `:` (auth.ts
 *   parseKeyRecords, keygen.ts), so no key reads as a signed-in identity;
 * - `keyHash` is a digest of the issuer and subject, fixed per subject: the
 *   agent registry's key for it (its CHECK wants 64 hex) and job ownership's;
 * - `act` is `oauth:<act.sub>` on an exchanged token: the MCP service that
 *   carried it.
 *
 * Configured, the issuer check never drops: with the authorization server down
 * a token is checked against the keys already read, and with none read a token
 * is answered unavailable (503), never let through and never refused as bad.
 * Keys are kept for the access tokens' lifetime (600 s), so a token issued
 * before an outage is served to its end.
 */

import { createHash } from "node:crypto";
import { createRemoteJWKSet, errors as jose, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Principal, Scope } from "./auth.ts";
import { edgeSettings, OAUTH_SCOPES } from "./oauth-edge.ts";

/** The authorization server's key set by its mesh name, rooted as AUTH_HEALTH_URL is (oauth-edge.ts): oidc-provider's `/jwks` under the issuer's `/auth`. */
export const AUTH_JWKS_URL = "http://auth.ob1.internal.:3000/auth/jwks";
/** How long a read key set is used before it is read again: the authorization server's access-token lifetime (deploy/auth/server.ts ACCESS_TTL). */
export const JWKS_CACHE_MAX_AGE_MS = 600_000;
/** The least time between two reads, so a token naming an unknown key costs one read in this long, not one each. */
export const JWKS_COOLDOWN_MS = 30_000;
export const JWKS_TIMEOUT_MS = 2_000;

/** What a token check answers: a principal, a token that is not one this server accepts, or no keys to check it with. */
export type TokenOutcome = { status: "ok"; principal: Principal } | { status: "invalid"; why: string } | { status: "unavailable" };
export type TokenCheck = (token: string) => Promise<TokenOutcome>;

/** Where tokens for this REST core come from and are for. */
export type TokenSettings = { issuer: string; audience: string };

/** The settings on a configured stack with a sound origin, else null: no token is accepted. */
export function tokenSettings(env: { COMPOSE_PROFILES?: string; OB1_PUBLIC_ORIGIN?: string }): TokenSettings | null {
  const { origin } = edgeSettings(env);
  return origin ? { issuer: `${origin}/auth`, audience: `${origin}/api` } : null;
}

/**
 * The key scope a token's scopes name, or null for none (SMD-2286 step 5: one
 * to one, no privilege only OAuth has). `brain:write` is a write key's —
 * which reads and captures as well — `brain:read` alone a read key's and
 * `brain:capture` alone a capture key's. `brain:read` with `brain:capture` and
 * no `brain:write` is no key's scope, and no brain scope at all grants
 * nothing; both are null. Other scopes (`openid`, `offline_access`) are not
 * the brain's and are ignored. The authorization server holds the same rule
 * (deploy/auth/layout.ts keyScopeOf), so it never issues what this refuses.
 */
export function keyScopeOf(scope: unknown): Exclude<Scope, "forward"> | null {
  const held = new Set(typeof scope === "string" ? scope.split(" ").filter((s) => (OAUTH_SCOPES as readonly string[]).includes(s)) : []);
  if (held.has("brain:write")) return "write";
  if (held.size !== 1) return null;
  return held.has("brain:read") ? "read" : "capture";
}

/** The subject's fixed digest: the registry's key for an OAuth identity, as a key's digest is a key's. */
export function subjectHash(issuer: string, sub: string): string {
  return createHash("sha256").update(`oauth\n${issuer}\n${sub}`).digest("hex");
}

/**
 * A subject or actor as the authorization server names one: its one account
 * (`operator`) or a client id (a service's, the MCP server's). Held to the
 * characters a log line, an egress term (`actor:oauth:<sub>`) and the audit
 * row can carry as they are.
 */
const SUBJECT = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * The failures of the key set itself, not of the token: anything but a token
 * naming no key it holds. Raised by checkerOver's key reader so the check can
 * tell "no keys to check with" (unavailable) from "not a token of this server"
 * (invalid).
 */
class KeysUnavailable extends Error {}

/** A key reader that says KeysUnavailable for every failure but a key the set does not hold (or holds twice). */
function guarded(keys: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await keys(header, token);
    } catch (e) {
      if (e instanceof jose.JWKSNoMatchingKey || e instanceof jose.JWKSMultipleMatchingKeys) throw e;
      throw new KeysUnavailable((e as Error)?.message ?? String(e));
    }
  };
}

/** The check of tokens for `settings` against `keys`: the remote key set in a deploy, a local one in a suite. */
export function checkerOver(settings: TokenSettings, keys: JWTVerifyGetKey): TokenCheck {
  const read = guarded(keys);
  return async (token) => {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, read, {
        issuer: settings.issuer,
        audience: settings.audience,
        algorithms: ["ES256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "exp"],
      }));
    } catch (e) {
      if (e instanceof KeysUnavailable) return { status: "unavailable" };
      const { code, claim } = e as { code?: string; claim?: string };
      return { status: "invalid", why: `${code ?? "ERR_JWT_INVALID"}${claim ? ` (${claim})` : ""}` };
    }
    const sub = payload.sub;
    if (typeof sub !== "string" || !SUBJECT.test(sub)) return { status: "invalid", why: "sub is not a subject this server names" };
    const scope = keyScopeOf(payload.scope);
    if (!scope) return { status: "invalid", why: "its scopes name no key scope" };
    const principal: Principal = { name: `oauth:${sub}`, scope, keyHash: subjectHash(settings.issuer, sub) };
    if (payload.act !== undefined) {
      const actor = (payload.act as { sub?: unknown } | null)?.sub;
      if (typeof actor !== "string" || !SUBJECT.test(actor)) return { status: "invalid", why: "act names no actor this server names" };
      principal.act = { name: `oauth:${actor}` };
    }
    return { status: "ok", principal };
  };
}

/** The check a deploy uses: the authorization server's key set on the mesh, cached (the header's rules). */
export function remoteChecker(settings: TokenSettings, url: string = AUTH_JWKS_URL): TokenCheck {
  return checkerOver(settings, createRemoteJWKSet(new URL(url), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: JWKS_TIMEOUT_MS,
  }));
}
