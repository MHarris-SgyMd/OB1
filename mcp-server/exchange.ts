// The token exchange at the hop (SMD-2286 step 2; docs/operator-surface-tiers.md,
// Identity, decision 7): the MCP authorization spec forbids passing the token
// a client sent for /mcp on to the REST core, so this server trades it
// (RFC 8693) at the authorization server's token endpoint, as its `mcp`
// client, for a token whose audience is the REST core (`<origin>/api`). The
// result keeps the subject, carries `act: {sub: "mcp", act: {sub: <the
// connector>}}`, never a wider scope, never a later expiry
// (deploy/auth/server.ts's grant). The REST core then checks that token as
// its own (server-portable/oauth-token.ts), and names its caller by the
// connector, `oauth:operator+<client>` (SMD-3064).
//
// - Before the trade, the token's claims are read unverified and only to
//   refuse: another issuer, any audience but exactly `<origin>/mcp`, or an
//   expired or exp-less token is invalid without a call. The authorization
//   server verifies the signature, the audience and the subject itself.
// - Each trade is cached by a digest of the incoming token — never by its
//   subject: one operator can hold a read connector and a write connector,
//   and a cache by subject would hand the read one the write token (the
//   ticket's Verify). An entry lives until 5 s before the exchanged token's
//   expiry, one trade at a time per token, at most MAX_ENTRIES of them.
// - Answers: the exchanged token; `invalid` (the client should refresh or
//   sign in: invalid_grant); `scope` (the token's scopes name no key scope:
//   invalid_scope); `unavailable` (the authorization server did not answer
//   in time, its answer stalled, it answered a 200 with no token in it, or
//   limited us: retry).
//   Anything that says this server is misconfigured (its client refused, a
//   target or request the server will not take) throws ExchangeMisconfigured,
//   which the route answers as a fault.
// - The authorization server's exchange checks the subject token, not its
//   grant: a grant revoked there is refused once the client's access token
//   expires (at most 600 s), when its refresh fails and it signs in again;
//   a trade kept here lives no longer than that token (review pass 2,
//   measured against deploy/auth). A subject revoked in the registry is
//   refused at the next call, as the REST core checks every one.
// - The endpoint is plain HTTP by its mesh name: inside the stack's network,
//   as the authorization server's health probe is, and nowhere else.

import { createHash } from "node:crypto";

/** The authorization server's token endpoint by its mesh name, rooted as oauth-edge.ts's AUTH_HEALTH_URL is. */
export const AUTH_TOKEN_URL = "http://auth.ob1.internal.:3000/auth/token";
/** The stable tier's exchange client (deploy/auth/layout.ts mcpClientId): its secret is OB1_AUTH_SECRET_MCP. */
export const EXCHANGE_CLIENT_ID = "mcp";
export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/** How long a trade may take before the authorization server counts as away. */
export const EXCHANGE_TIMEOUT_MS = 5_000;
/** An entry is dropped this long before its exchanged token expires, so a call never carries one that lapses on the way. */
export const EXPIRY_MARGIN_S = 5;
/** The most trades kept: the subjects are the authorization server's, but each connector's token is its own entry. */
export const MAX_ENTRIES = 1_024;

export type ExchangeSettings = { tokenUrl: string; clientId: string; secret: string; issuer: string; mcpAudience: string; apiResource: string };
/** `why` is for the log alone, built from this server's own words and a status, never the answer's text. */
export type Exchanged = { status: "ok"; token: string } | { status: "invalid" } | { status: "scope" } | { status: "unavailable"; why: string };
export type Exchanger = { exchange(token: string): Promise<Exchanged>; size(): number };

const EXCHANGE_HINT = "set OB1_AUTH_SECRET_MCP to the `mcp` client's secret in deploy/.env (deploy/auth/provision.ts --init writes it), and run the authorization server from this release's deploy/auth, whose `mcp` client may trade for the REST core";

/** This stack's settings refusing the exchange — the authorization server's or the REST core's: a fault for the log with its fix, never a client's refusal. */
export class ExchangeMisconfigured extends Error {
  constructor(message: string, readonly hint: string = EXCHANGE_HINT) {
    super(message);
  }
}

/**
 * An upstream's error code for a log line: letters and underscores, as every
 * code the authorization server and the REST core send is, else nothing.
 * No digit, so no hex secret or key passes whole (review passes 2 and 3: a
 * body that echoed a token printed it; a bare 64-hex secret still passed).
 */
export const codeWord = (code: unknown): string => (typeof code === "string" && /^[A-Za-z_]{1,64}$/.test(code) ? code : "");

/** The settings on a configured stack with a sound origin and the `mcp` client's secret, else null: no token is traded. */
export function exchangeSettings(origin: string | null, secret: string | undefined, tokenUrl: string = AUTH_TOKEN_URL): ExchangeSettings | null {
  const s = secret?.trim();
  if (!origin || !s) return null;
  return { tokenUrl, clientId: EXCHANGE_CLIENT_ID, secret: s, issuer: `${origin}/auth`, mcpAudience: `${origin}/mcp`, apiResource: `${origin}/api` };
}

/** A token's claims, read without verifying it, or null when it is no JWT's shape: to refuse with, never to accept. */
function claimsOf(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Whether the claims could be a token for this server's /mcp at all: its issuer, exactly its audience, unexpired. */
function couldBeOurs(claims: Record<string, unknown> | null, s: ExchangeSettings, nowS: number): boolean {
  if (!claims || claims.iss !== s.issuer) return false;
  const aud = claims.aud;
  if (!(aud === s.mcpAudience || (Array.isArray(aud) && aud.length === 1 && aud[0] === s.mcpAudience))) return false;
  return typeof claims.exp === "number" && claims.exp > nowS;
}

/** The trader over `settings`: `fetch` and `now` (ms) are for a suite. */
export function createExchanger(s: ExchangeSettings, opts: { fetch?: (req: Request) => Promise<Response>; now?: () => number } = {}): Exchanger {
  const send = opts.fetch ?? ((req: Request) => globalThis.fetch(req));
  const now = opts.now ?? Date.now;
  const kept = new Map<string, { token: string; until: number }>();
  const inflight = new Map<string, Promise<Exchanged>>();
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.secret)}`).toString("base64")}`;

  const keep = (digest: string, token: string, expiresInS: number) => {
    const until = now() + (expiresInS - EXPIRY_MARGIN_S) * 1000;
    if (until <= now()) return;
    if (kept.size >= MAX_ENTRIES) {
      for (const [k, v] of kept) if (v.until <= now()) kept.delete(k);
      // Still full: the oldest goes (a Map keeps insertion order).
      if (kept.size >= MAX_ENTRIES) kept.delete(kept.keys().next().value!);
    }
    kept.set(digest, { token, until });
  };

  const trade = async (digest: string, subject: string): Promise<Exchanged> => {
    let r: Response;
    try {
      r = await send(new Request(s.tokenUrl, {
        method: "POST",
        headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token: subject, subject_token_type: ACCESS_TOKEN_TYPE, resource: s.apiResource }),
        redirect: "manual",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      }));
    } catch (e) {
      return { status: "unavailable", why: (e as Error)?.name === "TimeoutError" ? `no answer within ${EXCHANGE_TIMEOUT_MS} ms` : "it could not be reached" };
    }
    // A body that stalls past the timeout, at any status, is the authorization server not answering, never this server's
    // settings (review passes 1 and 2); one that cannot be read as JSON is read as no answer of its.
    let stalled = false;
    const body = (await r.json().catch((e: unknown) => {
      // The trade's own timeout ends a stalled body as a TimeoutError; nothing else aborts it.
      stalled = (e as Error)?.name === "TimeoutError";
      return null;
    })) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (stalled) return { status: "unavailable", why: `its ${r.status} answer stalled past ${EXCHANGE_TIMEOUT_MS} ms` };
    if (r.status === 200 && typeof body?.access_token === "string") {
      keep(digest, body.access_token, typeof body.expires_in === "number" ? body.expires_in : 0);
      return { status: "ok", token: body.access_token };
    }
    // A 200 cut short or with no token says nothing of this server's settings (review pass 1).
    if (r.status === 200) return { status: "unavailable", why: "it answered 200 with no token" };
    if (r.status === 429 || r.status >= 500) return { status: "unavailable", why: `it answered ${r.status}${r.status === 429 ? " (rate-limited: after repeated invalid_client refusals, as a wrong OB1_AUTH_SECRET_MCP draws, the `mcp` client is locked out for a while)" : ""}` };
    const error = codeWord(body?.error);
    if (error === "invalid_grant") return { status: "invalid" };
    if (error === "invalid_scope") return { status: "scope" };
    throw new ExchangeMisconfigured(`the authorization server refused this server's token exchange (${r.status} ${error || "no error code"})`);
  };

  return {
    async exchange(token) {
      if (!couldBeOurs(claimsOf(token), s, Math.floor(now() / 1000))) return { status: "invalid" };
      const digest = createHash("sha256").update(token).digest("hex");
      const hit = kept.get(digest);
      if (hit && hit.until > now()) return { status: "ok", token: hit.token };
      if (hit) kept.delete(digest);
      const running = inflight.get(digest);
      if (running) return running;
      const p = trade(digest, token).finally(() => inflight.delete(digest));
      inflight.set(digest, p);
      return p;
    },
    size: () => kept.size,
  };
}
