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
 * - `name` is `oauth:<sub>+<client>`: the subject, and the client it signed
 *   in through (SMD-3064) — the token's own `client_id` (the GUI's `gui`), or
 *   on an exchanged token the connector the authorization server nests in its
 *   `act`. So each client is a principal of its own: its own registry row,
 *   kind and trust, revocation and job ownership. A service's token, whose
 *   subject is its own client id, is `oauth:<sub>` alone. A key's name cannot
 *   hold `:` (auth.ts parseKeyRecords, keygen.ts), so no key reads as a
 *   signed-in identity, and no subject holds `+`, so no subject reads as
 *   another's client;
 * - `keyHash` is a digest of the issuer, subject and client, fixed per
 *   principal: the agent registry's key for it (its CHECK wants 64 hex) and
 *   job ownership's;
 * - `act` is `oauth:<act.sub>` on an exchanged token: the MCP service that
 *   carried it.
 *
 * Configured, the issuer check never drops (cachedKeys has the rules): the
 * keys are read on the mesh, kept 600 s, and read again after that or for a
 * key they lack, at most once in 30 s. Once the set is stale and reads fail,
 * the keys read last go on serving for 600 s from then, which is every token
 * issued before the outage to its end, since none lives longer. With no keys
 * to check a token against, it is answered unavailable (503), never let
 * through and never refused as bad.
 *
 * A token whose scopes name no key scope is a valid token without the scope
 * any operation needs: answered `scope` (403 `insufficient_scope`, RFC 6750
 * §3.1), as the proof of concept's resource servers answer it.
 */

import { createHash } from "node:crypto";
import { createLocalJWKSet, decodeJwt, errors as jose, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
import type { Principal, Scope } from "./auth.ts";
import { edgeSettings, OAUTH_SCOPES } from "./oauth-edge.ts";

/** The authorization server's key set by its mesh name, rooted as AUTH_HEALTH_URL is (oauth-edge.ts): oidc-provider's `/jwks` under the issuer's `/auth`. */
export const AUTH_JWKS_URL = "http://auth.ob1.internal.:3000/auth/jwks";
/**
 * How long a read key set is used before it is read again, and how long the
 * keys read last go on serving once it is stale and reads fail: the authorization server's
 * access-token lifetime (deploy/auth/server.ts ACCESS_TTL), so a token issued
 * before an outage is served to its end.
 */
export const JWKS_CACHE_MAX_AGE_MS = 600_000;
/** The least time between two reads tried, whatever asked for them: a token naming a key the set lacks, a stale set, a failing server. */
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
 * and deploy/canary.sh runs a canary with no origin, so no REST core of another
 * tier is configured to read it.
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

/**
 * A principal's fixed digest: the registry's key for an OAuth identity, as a
 * key's digest is a key's. Of the subject alone for a service's token, of the
 * subject and the client it signed in through otherwise (SMD-3064). Neither
 * part holds a newline, so no two principals share a digest.
 */
export function subjectHash(issuer: string, sub: string, client?: string): string {
  return createHash("sha256").update(`oauth\n${issuer}\n${sub}${client === undefined ? "" : `\n${client}`}`).digest("hex");
}

/**
 * A subject or actor as the authorization server names one: its one account
 * (`operator`) or a client id (a service's, the MCP server's). Held to the
 * characters a log line, an egress term (`actor:oauth:<sub>`) and the audit
 * row can carry as they are.
 */
const SUBJECT = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * Whether a client a subject signs in through can be named (SMD-3064): an id
 * the authorization server gave (a static client's, a registered one's), held
 * as a subject is, or a client metadata document's https URL (CIMD) of a
 * host, an optional port and a path alone. A URL is held to those: no comma
 * (an egress term list splits on commas), no `+` (the name's separator), no
 * credentials, and no query or fragment, which the CIMD draft says a client id
 * should not hold.
 * At most 180 characters, so `oauth:operator+<client>` fits the search tools'
 * 200-character `actor` filter. deploy/auth/layout.ts holds the same rule, so
 * the authorization server issues no token for a client this one refuses; the
 * REST suite holds the two equal.
 */
export function clientNameable(id: string): boolean {
  return id.length <= 180 && /^(?:[A-Za-z0-9._~-]{1,128}|https:\/\/[A-Za-z0-9.-]{1,100}(?::[0-9]{1,5})?\/[A-Za-z0-9._~\/%-]{0,170})$/.test(id);
}

/** The longest caller name: the search tools' `actor` filter takes at most this many characters (core/schemas.ts). */
const NAME_MAX = 200;

/**
 * No keys to check a token with: the key set could not be read and none read
 * before still serves, or the token names a key the set lacks and the set
 * cannot be read again yet. A key reader throws it so the check answers
 * unavailable (503), not invalid; any other failure of a reader is the same.
 */
class KeysUnavailable extends Error {}

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
 * fetches it; `now` is the clock, in ms (monotonic by default, so a wall-clock
 * step cannot freeze or stretch it). For each token:
 * - **Needs a read** when there is no set, the set is JWKS_CACHE_MAX_AGE_MS
 *   old (stale), or it lacks the token's `kid`. A read already in flight is
 *   joined; otherwise one is made unless one was tried within
 *   JWKS_COOLDOWN_MS. That one gate holds a missing-`kid` flood and a failing
 *   server alike to a read in 30 s.
 * - **Serves** while the set is fresh. Once it is stale with reads failing,
 *   the outage is counted from the first moment both were true, and the set
 *   serves JWKS_CACHE_MAX_AGE_MS from then: every token issued before the
 *   outage, to its end, however long the set sat idle or whatever failed
 *   while it was fresh. A success ends the outage.
 * - **A `kid` the set lacks** after a successful read (this request's or one
 *   it joined) is the token's fault (invalid); one it lacks with no read made
 *   is unavailable, since the authorization server may have a new key.
 */
export function cachedKeys(read: () => Promise<JSONWebKeySet>, now: () => number = () => performance.now()): JWTVerifyGetKey {
  let local: JWTVerifyGetKey | null = null;
  let readAt = -Infinity;
  let triedAt = -Infinity;
  let lastFailed = false;
  let outageSince: number | null = null;
  let inflight: Promise<boolean> | null = null;
  const tryRead = () =>
    (inflight ??= (async () => {
      triedAt = now();
      try {
        // Through a resolved promise, so a reader that throws at once still settles after `inflight` is set.
        const set = await Promise.resolve().then(read);
        local = createLocalJWKSet(set);
        readAt = now();
        lastFailed = false;
        outageSince = null;
        return true;
      } catch {
        lastFailed = true;
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
      // A doubled kid (JWKSMultipleMatchingKeys) is refused here, before the serving gate: jose has no retry over two
      // keys of one kid, so that token is invalid whatever the set's age, and the authorization server always sets a kid.
      throw e;
    }
  };
  const stale = () => now() - readAt >= JWKS_CACHE_MAX_AGE_MS;
  return async (header, token) => {
    let readOk = false;
    if (local === null || stale() || !(await holds(header, token))) {
      if (inflight) readOk = await inflight;
      else if (now() - triedAt >= JWKS_COOLDOWN_MS) readOk = await tryRead();
    }
    if (local !== null && stale() && lastFailed) outageSince ??= now();
    const serving = local !== null && (!stale() || (outageSince !== null && now() - outageSince < JWKS_CACHE_MAX_AGE_MS));
    if (!serving) throw new KeysUnavailable("no key set to check the token against");
    if (!(await holds(header, token))) {
      if (readOk) throw new jose.JWKSNoMatchingKey();
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
    // No keys is no answer: it would replace a good set and refuse every token 401, sending its client to sign in.
    if (!Array.isArray(set?.keys) || set.keys.length === 0) throw new Error("the key set holds no keys");
    return set;
  };
}

/** The check of tokens for `settings` against `keys`: the authorization server's kept set in a deploy, a local one in a suite. */
export function checkerOver(settings: TokenSettings, keys: JWTVerifyGetKey): TokenCheck {
  const read = guarded(keys);
  return async (token) => {
    // Another issuer's or audience's token is refused on its claims before any key is looked up, so it is told 401,
    // never "retry" (a 503) while the keys cannot be read. Read unverified, this only ever refuses: acceptance is
    // jwtVerify's, below, whose signature binds these same claims. The audience is exactly this REST core's: jose
    // alone accepts an `aud` list that holds it among others, and the authorization server issues one a token.
    let claimed: Record<string, unknown>;
    try {
      claimed = decodeJwt(token);
    } catch {
      return { status: "invalid", why: "not a JWT" };
    }
    const claimedAud = claimed.aud;
    if (claimed.iss !== settings.issuer) return { status: "invalid", why: "iss is not this REST core's issuer" };
    // An expired token, or one with no expiry, is refused here too, so a forged one naming a key the set lacks is told
    // 503 at most for the rest of its claimed life, and an old token after a key change is sent to sign in, not to retry.
    if (typeof claimed.exp !== "number" || claimed.exp <= Math.floor(Date.now() / 1000)) return { status: "invalid", why: "expired, or no exp" };
    if (!(claimedAud === settings.audience || (Array.isArray(claimedAud) && claimedAud.length === 1 && claimedAud[0] === settings.audience))) return { status: "invalid", why: "aud names more than this REST core" };
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
    if (!scope) return { status: "scope" };
    // The client the subject signed in through: on an exchanged token, the
    // connector nested in its `act` (the exchanging MCP service is the outer
    // actor, recorded as `act`); otherwise the token's own client_id.
    let client: unknown = payload.client_id;
    let carrier: string | undefined;
    if (payload.act !== undefined) {
      const act = payload.act as { sub?: unknown; act?: { sub?: unknown; act?: unknown } | null } | null;
      if (typeof act?.sub !== "string" || !SUBJECT.test(act.sub)) return { status: "invalid", why: "act names no actor this server names" };
      if (typeof act.act?.sub !== "string" || act.act.act !== undefined) return { status: "invalid", why: "act names no one client the subject signed in through" };
      carrier = act.sub;
      client = act.act.sub;
    }
    if (typeof client !== "string" || !clientNameable(client)) return { status: "invalid", why: "names no client this server names" };
    // A service's own token: the subject is the client, one name.
    const own = client === sub && carrier === undefined;
    const principal: Principal = own
      ? { name: `oauth:${sub}`, scope, keyHash: subjectHash(settings.issuer, sub) }
      : { name: `oauth:${sub}+${client}`, scope, keyHash: subjectHash(settings.issuer, sub, client) };
    if (principal.name.length > NAME_MAX) return { status: "invalid", why: `names a caller longer than ${NAME_MAX} characters` };
    if (carrier !== undefined) principal.act = { name: `oauth:${carrier}` };
    return { status: "ok", principal };
  };
}

/** The check a deploy uses: the authorization server's key set on the mesh, kept (cachedKeys). `now` is for a suite. */
export function remoteChecker(settings: TokenSettings, url: string = AUTH_JWKS_URL, now?: () => number): TokenCheck {
  // No clock given (a deploy): cachedKeys's own, monotonic.
  return checkerOver(settings, cachedKeys(jwksOver(url), now));
}
