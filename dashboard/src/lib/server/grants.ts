// The page of grants' calls to the authorization server (SMD-3307 PR 3): its
// admin listener on the mesh (deploy/auth/admin.ts), port 3001, which no proxy
// rule routes to, under the `gui` client's own credentials. It lists the live
// grants and revokes one whole. A revoked grant's refresh tokens are refused
// from then on; an access token already issued is a JWT the REST core checks
// on its own, so the client's next call is refused once it lapses, within the
// access-token lifetime (600 s; the maintainer's choice of 2026-10-26).

import { AUTH_TIMEOUT_MS, basic, type OAuthSettings } from './oauth';

/** The AS's admin listener on the mesh. */
export const ADMIN_MESH_URL = 'http://auth.ob1.internal.:3001';

/** A grant id as the AS makes one (admin.ts GRANT_ID): anything else is no grant to revoke. */
export const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A live grant as the AS lists it (deploy/auth/store.ts GrantRow); times in seconds since the epoch. */
export type Grant = { id: string; clientId: string; clientName: string | null; accountId: string; scope: string; resources: string[]; createdAt: number | null; renewedAt: number | null; expiresAt: number | null };

/** The listing, or why there is none: the AS refused the GUI's credentials (its status), or did not answer. */
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
	};
}

/** The live grants, newest first, as the AS lists them (at most 500, and whether there are more). */
export async function listGrants(s: OAuthSettings, fetchFn: typeof fetch = fetch): Promise<GrantsAnswer> {
	try {
		const r = await fetchFn(`${ADMIN_MESH_URL}/grants`, { headers: { authorization: basic(s), accept: 'application/json' }, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS), redirect: 'manual' });
		if (r.status >= 500 || r.status === 429) {
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

/** What one revocation came to: done, no live grant of that id (revoked already, or lapsed), refused, or no answer. */
export type GrantRevoked = 'revoked' | 'gone' | 'refused' | 'unreachable';

/** A grant revoked whole at the AS: its codes and tokens and the grant itself. */
export async function revokeGrant(s: OAuthSettings, id: string, fetchFn: typeof fetch = fetch): Promise<GrantRevoked> {
	if (!GRANT_ID.test(id)) return 'gone';
	try {
		const r = await fetchFn(`${ADMIN_MESH_URL}/grants/${id}/revoke`, { method: 'POST', headers: { authorization: basic(s) }, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS), redirect: 'manual' });
		void r.body?.cancel().catch(() => {});
		if (r.status === 204) return 'revoked';
		if (r.status === 404) return 'gone';
		return r.status >= 500 || r.status === 429 ? 'unreachable' : 'refused';
	} catch {
		return 'unreachable';
	}
}

/**
 * Whether a session is offered the page: on a stack configured for the AS (the GUI's settings for it sound, so it
 * holds the credentials the listener takes), to a session that may write — the operator's token, or a write key on
 * the break-glass port. A read key sees no grants and revokes none.
 */
export const grantsOffered = (session: { canCapture: boolean } | null, s: OAuthSettings | null): s is OAuthSettings => s !== null && session?.canCapture === true;
