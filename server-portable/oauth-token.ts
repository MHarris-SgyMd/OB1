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
 * Configured, the issuer check never drops (cachedKeys has the rules): the
 * keys are read on the mesh, kept 600 s, and read again after that or for a
 * key they lack. When a read fails, the keys read last go on serving for 600 s
 * from that first failure, which is every token issued before the outage to
 * its end, since none lives longer; and no read is tried again for 30 s. With
 * no keys to check a token against, it is answered unavailable (503), never
 * let through and never refused as bad.
 *
 * A token whose scopes name no key scope is a valid token without the scope
 * any operation needs: answered `scope` (403 `insufficient_scope`, RFC 6750
 * §3.1), as the proof of concept's resource servers answer it.
 */

import { createHash } from "node:crypto";
import { createLocalJWKSet, errors as jose, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import type { Principal, Scope } from "./auth.ts";
import { edgeSettings, OAUTH_SCOPES } from "./oauth-edge.ts";

/** The authorization server's key set by its mesh name, rooted as AUTH_HEALTH_URL is (oauth-edge.ts): oidc-provider's `/jwks` under the issuer's `/auth`. */
export const AUTH_JWKS_URL = "http://auth.ob1.internal.:3000/auth/jwks";
/**
 * How long a read key set is used before it is read again, and how long the
 * keys read last go on serving once a read fails: the authorization server's
 * access-token lifetime (deploy/auth/server.ts ACCESS_TTL), so a token issued
 * before an outage is served to its end.
 */
export const JWKS_CACHE_MAX_AGE_MS = 600_000;
/** The least time between two reads: after a read, a token naming a key the set lacks waits this long for the next; after a failed one, every token does. */
export const JWKS_COOLDOWN_MS = 30_000;
export const JWKS_TIMEOUT_MS = 2_000;

/**
 * What a token check answers: a principal; a token that is not one this
 * server accepts; a valid one whose scopes name no key scope; or no keys to
 * check it with.
 */
export type TokenOutcome = { status: "ok"; principal: Principal } | { status: "invalid"; why: string } | { status: "scope" } | { status: "unavailable" };
export type TokenCheck = (token: string) => Promise<TokenOutcome>;

/** Where tokens for this REST core come from and are for. */
export type TokenSettings = { issuer: string; audience: string };

/**
 * The settings on a configured stack with a sound origin, else null: no token
 * is accepted. The audience is the stable tier's `<origin>/api`: a brain is
 * its own stack with its own authorization server (docs/one-brain-per-stack.md),
 * and the tiers stack passes no origin (deploy/compose.tiers.yaml), so no REST
 * core of another tier is configured to read it.
 */
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
 * (deploy/auth/layout.ts keyScopeOf) where a request names scopes afresh; a
 * token it narrowed to such a set still arrives here, and is refused.
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
 * No keys to check a token with: the key set could not be read and none read
 * before still serves, or the token names a key the set lacks and the set
 * cannot be read again yet. A key reader throws it so the check answers
 * unavailable (503), not invalid; any other failure of a reader is the same.
 */
export class KeysUnavailable extends Error {}

/** A key reader that says KeysUnavailable for every failure but a key the set does not hold (or holds twice). */
function guarded(keys: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (header, token) => {
    try {
      return await keys(header, token);
    } catch (e) {
      if (e instanceof jose.JWKSNoMatchingKey || e instanceof jose.JWKSMultipleMatchingKeys || e instanceof KeysUnavailable) throw e;
      throw new KeysUnavailable((e as Error)?.message ?? String(e));
    }
  };
}

/**
 * The authorization server's key set, kept (the header's rules). `read`
 * fetches it; `now` is the clock, in ms. Each token's key is looked up as:
 * - a set read within JWKS_CACHE_MAX_AGE_MS that holds the token's `kid`: used;
 * - no set, a set that old, or one lacking the `kid`: read again, unless a read
 *   was tried within JWKS_COOLDOWN_MS (after a successful read, only a missing
 *   `kid` waits; after a failed one, everything does). One read at a time;
 * - the read failed or was not tried: the set read last serves until
 *   JWKS_CACHE_MAX_AGE_MS past the first failure since the last success;
 * - a `kid` the set lacks right after a successful read: the token's fault
 *   (invalid); one it lacks with no read possible: unavailable, since the
 *   authorization server may have a new key this set has not seen.
 */
export function cachedKeys(read: () => Promise<JSONWebKeySet>, now: () => number = Date.now): JWTVerifyGetKey {
  let local: JWTVerifyGetKey | null = null;
  let readAt = 0;
  let triedAt = -Infinity;
  let failingSince: number | null = null;
  let inflight: Promise<boolean> | null = null;
  const tryRead = () =>
    (inflight ??= (async () => {
      triedAt = now();
      try {
        const set = await read();
        local = createLocalJWKSet(set);
        readAt = now();
        failingSince = null;
        return true;
      } catch {
        failingSince ??= now();
        return false;
      } finally {
        inflight = null;
      }
    })());
  const holds = async (header: Parameters<JWTVerifyGetKey>[0], token: Parameters<JWTVerifyGetKey>[1]) => {
    if (!local) return false;
    try {
      await local(header, token);
      return true;
    } catch (e) {
      if (e instanceof jose.JWKSNoMatchingKey) return false;
      throw e;
    }
  };
  return async (header, token) => {
    const fresh = local !== null && now() - readAt < JWKS_CACHE_MAX_AGE_MS;
    const has = await holds(header, token);
    let readNow = false;
    if (!fresh || !has) {
      // A missing kid on a fresh set waits out the cooldown since the last read; anything after a failure waits since the try.
      const since = fresh && failingSince === null ? readAt : triedAt;
      if (now() - since >= JWKS_COOLDOWN_MS || local === null && failingSince === null) readNow = await tryRead();
    }
    const serving = local !== null && (readNow || now() - readAt < JWKS_CACHE_MAX_AGE_MS || (failingSince !== null && now() - failingSince < JWKS_CACHE_MAX_AGE_MS));
    if (!serving) throw new KeysUnavailable("no key set to check the token against");
    if (!(await holds(header, token))) {
      if (readNow) throw new jose.JWKSNoMatchingKey();
      throw new KeysUnavailable("the token names a key the set lacks, and the set cannot be read again yet");
    }
    return local!(header, token);
  };
}

/** The key set read over HTTP: a 200 with a JSON `keys` array within JWKS_TIMEOUT_MS, no redirect followed. */
export function jwksOver(url: string): () => Promise<JSONWebKeySet> {
  return async () => {
    const r = await fetch(url, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (r.status !== 200) throw new Error(`the key set answered ${r.status}`);
    const set = (await r.json()) as JSONWebKeySet;
    if (!Array.isArray(set?.keys)) throw new Error("the key set holds no keys array");
    return set;
  };
}

/** The check of tokens for `settings` against `keys`: the authorization server's kept set in a deploy, a local one in a suite. */
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
    // Exactly this audience: jose accepts an `aud` list that holds it among others, and the authorization server issues one audience a token.
    const aud = payload.aud;
    if (!(aud === settings.audience || (Array.isArray(aud) && aud.length === 1 && aud[0] === settings.audience))) return { status: "invalid", why: "aud names more than this REST core" };
    const sub = payload.sub;
    if (typeof sub !== "string" || !SUBJECT.test(sub)) return { status: "invalid", why: "sub is not a subject this server names" };
    const scope = keyScopeOf(payload.scope);
    if (!scope) return { status: "scope" };
    const principal: Principal = { name: `oauth:${sub}`, scope, keyHash: subjectHash(settings.issuer, sub) };
    if (payload.act !== undefined) {
      const actor = (payload.act as { sub?: unknown } | null)?.sub;
      if (typeof actor !== "string" || !SUBJECT.test(actor)) return { status: "invalid", why: "act names no actor this server names" };
      principal.act = { name: `oauth:${actor}` };
    }
    return { status: "ok", principal };
  };
}

/** The check a deploy uses: the authorization server's key set on the mesh, kept (cachedKeys). `now` is for a suite. */
export function remoteChecker(settings: TokenSettings, url: string = AUTH_JWKS_URL, now: () => number = Date.now): TokenCheck {
  return checkerOver(settings, cachedKeys(jwksOver(url), now));
}
