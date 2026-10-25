// Sign-in through the stack's authorization server (SMD-3307, ADR decision 15
// and the GUI section of docs/operator-surface-tiers.md): the GUI is the AS's
// confidential `gui` client (deploy/auth/layout.ts), signing the operator in by
// authorization code with PKCE (S256) for the REST core's resource,
// `<origin>/api`. Its tokens — an access token of 600 s and a refresh token
// that rotates on every use (SMD-2286's policy) — live in the server-side
// session and never reach the browser.
//
// The browser is sent to the public `<origin>/auth/authorize`; every call this
// server makes itself (the code's exchange, a refresh, a revocation) goes to
// the AS on the mesh, as the REST core reads its keys there. Pure but for the
// fetch, which a suite hands in (test-oauth.ts).

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { edgeSettings } from '../../../../server-portable/oauth-edge.ts';

/** The AS on the mesh, under its issuer's path (`/auth`): the REST core reads its keys from the same host (oauth-token.ts). */
export const AUTH_MESH_URL = 'http://auth.ob1.internal.:3000/auth';
/** The client the AS registers for the GUI (deploy/auth/layout.ts's `gui`). */
export const CLIENT_ID = 'gui';
/** What the GUI asks for: a token that reads and writes (as a write key does), renewed by a refresh token (`offline_access`). */
export const SCOPE = 'openid offline_access brain:write';
/** How long one call to the AS may take: a page waits on it. */
export const AUTH_TIMEOUT_MS = 10_000;

/** What the GUI needs to sign in through the AS, or null on a stack that is not configured for it, has no sound origin, or gave the GUI no secret. */
export type OAuthSettings = { origin: string; secret: string; authorize: string; redirect: string; resource: string; token: string; revocation: string };

export function oauthSettings(env: Record<string, string | undefined>): OAuthSettings | null {
	const { origin } = edgeSettings(env);
	const secret = env.OB1_AUTH_SECRET_GUI?.trim();
	if (!origin || !secret) return null;
	return {
		origin,
		secret,
		authorize: `${origin}/auth/authorize`,
		redirect: `${origin}/dashboard/auth/callback`,
		resource: `${origin}/api`,
		token: `${AUTH_MESH_URL}/token`,
		revocation: `${AUTH_MESH_URL}/token/revocation`,
	};
}

/** The tokens one sign-in holds: the access token, when it stops being good (ms since the epoch), and the refresh token. */
export type Tokens = { access: string; expiresAt: number; refresh: string };

/** How long a sign-in may take from its start to its answer: as long as the AS keeps one open (deploy/auth/server.ts, ttl.Interaction). */
export const SIGNIN_MS = 600_000;
/**
 * The key a sign-in's PKCE verifier is derived from, this process's own: a
 * sign-in in flight holds nothing on the server, so a flood of starts — open
 * to anyone, the only way in on a configured stack — evicts no operator's
 * (review pass 1). A restart forgets it, and a sign-in begun before one starts
 * again.
 */
const SIGNIN_KEY = randomBytes(32);

/** A sign-in's verifier, from its state (which carries when it began): null once it is older than SIGNIN_MS, or not one this process began. */
export function verifierFor(state: string, now: number = Date.now()): string | null {
	const m = /^([0-9a-z]{1,12})\.[A-Za-z0-9_-]{32}$/.exec(state);
	if (!m) return null;
	const age = now - parseInt(m[1], 36);
	if (!(age >= 0 && age <= SIGNIN_MS)) return null;
	return createHmac('sha256', SIGNIN_KEY).update(state).digest('base64url');
}

/** A fresh sign-in: its state (when it began, and 24 random bytes), the PKCE verifier derived from it, and the verifier's S256 challenge. */
export function newSignIn(now: number = Date.now()): { state: string; verifier: string; challenge: string } {
	const state = `${now.toString(36)}.${randomBytes(24).toString('base64url')}`;
	const verifier = verifierFor(state, now)!;
	return { state, verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/**
 * The authorization request the browser is sent to. `prompt=login consent`:
 * the password every time, so a sign-out of the GUI is one — the AS's own
 * session (a day) would otherwise sign the next visitor of that browser in with
 * a click (review pass 1) — and the consent, without which the AS grants no
 * `offline_access`, and so no refresh token (oidc-provider, as OpenID Connect
 * Core §11 has it).
 */
export function authorizeUrl(s: OAuthSettings, state: string, challenge: string): string {
	const q = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: 'code',
		redirect_uri: s.redirect,
		scope: SCOPE,
		state,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		resource: s.resource,
		prompt: 'login consent',
	});
	return `${s.authorize}?${q}`;
}

/** What a call to the AS's token endpoint came to: the tokens, the AS's refusal (its OAuth error), or no answer. */
export type TokenAnswer = { ok: true; tokens: Tokens } | { ok: false; refused: string } | { ok: false; unreachable: true };

/** One POST to the token endpoint as the `gui` client (client_secret_basic), read into tokens. */
async function tokenCall(s: OAuthSettings, form: Record<string, string>, fetchFn: typeof fetch, now: () => number): Promise<TokenAnswer> {
	let r: Response;
	try {
		r = await fetchFn(s.token, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: basic(s) },
			body: new URLSearchParams(form).toString(),
			signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
			redirect: 'manual',
		});
	} catch {
		return { ok: false, unreachable: true };
	}
	const body = (await r.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown } | null;
	// A fault, a body that is no answer, or the AS's own "too many, later" (429): no answer, to try again — not a refusal that ends a session (review pass 1).
	if (r.status >= 500 || r.status === 429 || body === null || body.error === 'temporarily_unavailable') return { ok: false, unreachable: true };
	if (!r.ok) return { ok: false, refused: typeof body.error === 'string' ? body.error : `HTTP ${r.status}` };
	const { access_token, refresh_token, expires_in } = body;
	// A token set this client cannot keep — no refresh token, no lifetime — is the AS misconfigured, said as a refusal.
	if (typeof access_token !== 'string' || typeof refresh_token !== 'string' || typeof expires_in !== 'number' || !(expires_in > 0)) return { ok: false, refused: 'incomplete_token_answer' };
	return { ok: true, tokens: { access: access_token, refresh: refresh_token, expiresAt: now() + expires_in * 1000 } };
}

/** The `gui` client's credentials, RFC 6749 §2.3.1: each half form-encoded, then base64. */
function basic(s: OAuthSettings): string {
	const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, '+');
	return `Basic ${Buffer.from(`${enc(CLIENT_ID)}:${enc(s.secret)}`).toString('base64')}`;
}

/** The code the AS sent back, traded for tokens with the verifier that made its challenge. */
export function exchangeCode(s: OAuthSettings, code: string, verifier: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<TokenAnswer> {
	return tokenCall(s, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: s.redirect, resource: s.resource }, fetchFn, now);
}

/** A new token pair for a refresh token; the AS spends the old one (it rotates on every use). */
export function refreshTokens(s: OAuthSettings, refresh: string, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<TokenAnswer> {
	return tokenCall(s, { grant_type: 'refresh_token', refresh_token: refresh, resource: s.resource }, fetchFn, now);
}

/** Sign-out's revocation of the refresh token (RFC 7009), which ends its grant's chain: best-effort, the session ends either way. */
export async function revokeRefresh(s: OAuthSettings, refresh: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
	try {
		const r = await fetchFn(s.revocation, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(s) },
			body: new URLSearchParams({ token: refresh, token_type_hint: 'refresh_token' }).toString(),
			signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
			redirect: 'manual',
		});
		void r.body?.cancel().catch(() => {});
		return r.ok;
	} catch {
		return false;
	}
}

/** How long before its expiry an access token is renewed: a page's calls then never carry one that lapses mid-flight. */
export const RENEW_BEFORE_MS = 60_000;

/** Whether tokens need renewing before the next call. */
export const needsRenewal = (t: Tokens, now: number = Date.now()) => t.expiresAt - RENEW_BEFORE_MS <= now;

/** Why a renewal gave no token: the AS refused it (the session is over) or did not answer (try again). */
export class RenewalFailed extends Error {
	constructor(readonly refused: boolean, detail: string) {
		super(detail);
	}
}

/**
 * The access token to send for a session, renewed first when it is within
 * RENEW_BEFORE_MS of expiry. It reads the session's tokens as they are now
 * (`current`), never a copy taken when the request began: a second call in
 * the same request, after the first renewed, would otherwise renew again with
 * the spent refresh token, forking the chain within the AS's 10 s grace and
 * revoking the grant past it (review pass 1). One renewal per session at a
 * time: two calls at once wait on one. The new pair is written back through
 * `store`. A renewal the AS refuses ends the session through `close` and
 * throws RenewalFailed(true); one it does not answer throws
 * RenewalFailed(false) and leaves the session — though if the AS spent the
 * refresh token and its answer was lost, the next try is a reuse it refuses,
 * which ends the session then (rotation's price).
 */
export function createRenewer(deps: {
	refresh: (refreshToken: string) => Promise<TokenAnswer>;
	current: (id: string) => Tokens | null;
	store: (id: string, t: Tokens) => void;
	close: (id: string) => void;
	now?: () => number;
}) {
	const inFlight = new Map<string, Promise<Tokens>>();
	const now = deps.now ?? Date.now;
	return async function accessFor(id: string): Promise<string> {
		const pending = inFlight.get(id);
		if (pending) return (await pending).access;
		const held = deps.current(id);
		if (!held) throw new RenewalFailed(true, 'ended');
		if (!needsRenewal(held, now())) return held.access;
		const renewal = (async () => {
			const answer = await deps.refresh(held.refresh);
			if (answer.ok) {
				deps.store(id, answer.tokens);
				return answer.tokens;
			}
			if ('refused' in answer) {
				deps.close(id);
				throw new RenewalFailed(true, answer.refused);
			}
			throw new RenewalFailed(false, 'unreachable');
		})().finally(() => inFlight.delete(id));
		inFlight.set(id, renewal);
		return (await renewal).access;
	};
}

/** The refresh tokens of sessions that ended without a sign-out (evicted, replaced, a sign-in that failed after its exchange), revoked in the background: a grant no one holds is closed, not left live for its 14 days (review pass 1). */
export function revokeEnded(s: OAuthSettings | null, ended: (Tokens | null | undefined)[], fetchFn: typeof fetch = fetch): void {
	if (!s) return;
	for (const t of ended) if (t) void revokeRefresh(s, t.refresh, fetchFn);
}
