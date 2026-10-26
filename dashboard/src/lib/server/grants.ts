// The page of grants' calls to the authorization server (SMD-3307 PR 3): its
// admin listener on the mesh (deploy/auth/admin.ts), port 3001, which no proxy
// rule routes to, under the `gui` client's own credentials. It lists the live
// grants and revokes one whole. A revoked grant's refresh tokens are refused
// from then on; an access token already issued is a JWT the REST core checks
// on its own, so the client's next call is refused once it lapses, within the
// access-token lifetime (600 s; the maintainer's choice of 2026-10-26).
//
// The listener takes the GUI's credentials, not the visitor's, so the page's
// gate is the visitor's own session, checked at the REST core on every load
// and action (grantsGate): a session whose grant was revoked, or whose key was
// removed, is refused here as it is on every other page, not trusted for the
// rest of its day on a flag set at its sign-in (review pass 1).

import { configuredIn } from '../../../../server-portable/oauth-edge.ts';
import { oneLine } from '../format';
import { AUTH_TIMEOUT_MS, basic, CLIENT_ID, oauthSettings, type OAuthSettings } from './oauth';
import type { WhoAmI } from './signin';

/** The AS's admin listener on the mesh. */
export const ADMIN_MESH_URL = 'http://auth.ob1.internal.:3001';

/** A grant id as the AS makes one (admin.ts GRANT_ID): anything else is no grant to revoke. */
export const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A live grant as the AS lists it (deploy/auth/store.ts GrantRow); times in seconds since the epoch. */
export type Grant = { id: string; clientId: string; clientName: string | null; accountId: string; scope: string; resources: string[]; createdAt: number | null; renewedAt: number | null; expiresAt: number | null; refreshTokens: number };

/**
 * The listing, or why there is none: the AS refused the GUI's credentials (its status: 401, or 429 once it has
 * refused 20 from the GUI's address in 15 minutes and turns it away for the rest of that window), or did not answer.
 */
export type GrantsAnswer = { ok: true; grants: Grant[]; more: boolean } | { ok: false; refused: number } | { ok: false; unreachable: true };

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** One row of the AS's answer as a Grant, or null for one that is not: the page shows nothing it cannot read. */
function grantOf(v: unknown): Grant | null {
	const r = (v ?? {}) as Record<string, unknown>;
	const id = str(r.id);
	if (!id || !GRANT_ID.test(id)) return null;
	return {
		id,
		clientId: str(r.clientId) ?? '',
		clientName: str(r.clientName),
		accountId: str(r.accountId) ?? '',
		scope: str(r.scope) ?? '',
		resources: Array.isArray(r.resources) ? r.resources.filter((x): x is string => typeof x === 'string') : [],
		createdAt: num(r.createdAt),
		renewedAt: num(r.renewedAt),
		expiresAt: num(r.expiresAt),
		refreshTokens: num(r.refreshTokens) ?? 0,
	};
}

/** The live grants, newest first, as the AS lists them (at most 500, and whether there are more). */
export async function listGrants(s: OAuthSettings, fetchFn: typeof fetch = fetch): Promise<GrantsAnswer> {
	try {
		const r = await fetchFn(`${ADMIN_MESH_URL}/grants`, { headers: { authorization: basic(s), accept: 'application/json' }, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS), redirect: 'manual' });
		if (r.status >= 500) {
			void r.body?.cancel().catch(() => {});
			return { ok: false, unreachable: true };
		}
		if (r.status !== 200) {
			void r.body?.cancel().catch(() => {});
			return { ok: false, refused: r.status };
		}
		const body = (await r.json()) as { grants?: unknown; more?: unknown };
		const grants = Array.isArray(body.grants) ? body.grants.map(grantOf).filter((g): g is Grant => g !== null) : [];
		return { ok: true, grants, more: body.more === true };
	} catch {
		return { ok: false, unreachable: true };
	}
}

/** What one revocation came to: done, no live grant of that id (revoked already, or lapsed), refused, turned away for now (429), or no answer. */
export type GrantRevoked = 'revoked' | 'gone' | 'refused' | 'locked' | 'unreachable';

/** A grant revoked whole at the AS: its codes and tokens and the grant itself. */
export async function revokeGrant(s: OAuthSettings, id: string, fetchFn: typeof fetch = fetch): Promise<GrantRevoked> {
	if (!GRANT_ID.test(id)) return 'gone';
	try {
		const r = await fetchFn(`${ADMIN_MESH_URL}/grants/${id}/revoke`, { method: 'POST', headers: { authorization: basic(s) }, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS), redirect: 'manual' });
		void r.body?.cancel().catch(() => {});
		if (r.status === 204) return 'revoked';
		if (r.status === 404) return 'gone';
		if (r.status === 429) return 'locked';
		return r.status >= 500 ? 'unreachable' : 'refused';
	} catch {
		return 'unreachable';
	}
}

/**
 * Whether the nav names the page: on a stack configured with the AS (COMPOSE_PROFILES naming auth, as every other
 * sign-in rule reads it), to a session that signed in able to write. The page itself checks more (grantsGate).
 */
export const grantsOffered = (session: { canCapture: boolean } | null, env: Record<string, string | undefined>) => configuredIn(env.COMPOSE_PROFILES) && session?.canCapture === true;

/** The page's gate: the AS's settings, or the status and words of its refusal. */
export type GrantsGate = { ok: true; settings: OAuthSettings } | { ok: false; status: 403 | 404 | 503; message: string };

/**
 * The page's gate, for its load and its action alike, before anything the request says:
 * - a stack not configured with the AS (COMPOSE_PROFILES names no `auth`) has no page: 404;
 * - a session that did not sign in able to write is refused at once: 403;
 * - configured, but the GUI holding no `OB1_AUTH_SECRET_GUI` or no sound origin, it cannot call the listener: 503;
 * - then the session itself at the REST core (`whoami`, under its own key or token, which renews a token due and
 *   ends a session the AS or the core refuses, as every page's read does): one that can no longer write is 403.
 */
export async function grantsGate(env: Record<string, string | undefined>, session: { canCapture: boolean } | null, whoami: () => Promise<WhoAmI | null>): Promise<GrantsGate> {
	if (!configuredIn(env.COMPOSE_PROFILES)) return { ok: false, status: 404, message: 'No page of grants here: this stack is not configured with the authorization server.' };
	if (session?.canCapture !== true) return { ok: false, status: 403, message: 'The page of grants is a write session’s: sign in with the operator’s account, or a write key on the break-glass port.' };
	const settings = oauthSettings(env);
	if (!settings) return { ok: false, status: 503, message: 'The dashboard cannot reach the authorization server’s grants: it has no OB1_AUTH_SECRET_GUI or no sound OB1_PUBLIC_ORIGIN. Set both in deploy/.env and recreate app.' };
	const who = await whoami();
	if (!who?.operations.includes('capture_thought')) return { ok: false, status: 403, message: 'This session can no longer write, so it sees no grants and revokes none.' };
	return { ok: true, settings };
}

/** The bidirectional controls, which can turn the words around them back to front (review pass 1: `‮edoc edualC` read as `Claude code`). */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Who a grant is for, in the page's words: this dashboard's sign-ins (one with no refresh token alive is a sign-in
 * never finished, a consent abandoned or an answer the GUI refused, which holds no session); a client named by a
 * metadata document's URL, by its host, which the AS fetched it from; a registered one by its id and the name it gave
 * itself, its own word and said as such, without the controls that could reorder what is said around it.
 */
export function grantClient(g: Grant): { label: string; detail: string | null } {
	if (g.clientId === CLIENT_ID) return g.refreshTokens > 0 ? { label: 'This dashboard', detail: 'a sign-in to the operator GUI' } : { label: 'This dashboard, unfinished', detail: 'a sign-in never finished: it holds no session' };
	if (/^https:\/\//.test(g.clientId)) {
		let host = g.clientId;
		try {
			host = new URL(g.clientId).host;
		} catch {
			// shown as the AS listed it
		}
		return { label: oneLine(host.replace(BIDI, ''), 120), detail: `client metadata document ${oneLine(g.clientId.replace(BIDI, ''), 200)}` };
	}
	const name = g.clientName?.replace(BIDI, '');
	return { label: name?.trim() ? `“${oneLine(name, 80)}”, as it calls itself` : 'a registered client with no name', detail: `registered client ${oneLine(g.clientId.replace(BIDI, ''), 120)}` };
}
