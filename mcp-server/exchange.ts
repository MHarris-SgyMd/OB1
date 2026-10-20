// The token exchange at the hop (SMD-2286 step 2; docs/operator-surface-tiers.md,
// Identity, decision 7): the MCP authorization spec forbids passing the token
// a client sent for /mcp on to the REST core, so this server trades it
// (RFC 8693) at the authorization server's token endpoint, as its `mcp`
// client, for a token whose audience is the REST core (`<origin>/api`). The
// result keeps the subject, carries `act: {sub: "mcp"}`, never a wider scope,
// never a later expiry (deploy/auth/server.ts's grant). The REST core then
// checks that token as its own (server-portable/oauth-token.ts).
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
//   in time, answered a 200 with no token in it, or limited us: retry).
//   Anything that says this server is misconfigured (its client refused, a
//   target or request the server will not take) throws ExchangeMisconfigured,
//   which the route answers as a fault.
// - A trade is the authorization server's word on the grant when it is made:
//   a grant revoked there afterwards is seen at the next trade, when the
//   entry lapses (at most the exchanged token's lifetime, 600 s; the access
//   token the client holds lives no longer). A key revoked in the registry is
//   seen at once, as the REST core checks every call.

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
export type Exchanged = { status: "ok"; token: string } | { status: "invalid" } | { status: "scope" } | { status: "unavailable" };
export type Exchanger = { exchange(token: string): Promise<Exchanged>; size(): number };

/** This server's own settings refused by the authorization server: a fault for the log, never a client's refusal. */
export class ExchangeMisconfigured extends Error {
  readonly hint = "set OB1_AUTH_SECRET_MCP to the `mcp` client's secret in deploy/.env (deploy/auth/provision.ts --init writes it), and run the authorization server from this release's deploy/auth, whose `mcp` client may trade for the REST core";
}

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
    } catch {
      return { status: "unavailable" };
    }
    const body = (await r.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
    if (r.status === 200 && typeof body?.access_token === "string") {
      keep(digest, body.access_token, typeof body.expires_in === "number" ? body.expires_in : 0);
      return { status: "ok", token: body.access_token };
    }
    // A 200 whose body stalled past the timeout or came cut short says nothing of this server's settings (review pass 1).
    if (r.status === 200) return { status: "unavailable" };
    if (r.status === 429 || r.status >= 500) return { status: "unavailable" };
    const error = typeof body?.error === "string" ? body.error : "";
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
