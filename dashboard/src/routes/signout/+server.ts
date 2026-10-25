import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { oauthSettings, revokeRefresh } from '$lib/server/oauth';
import { closeSession, cookieOptions, SESSION_COOKIE } from '$lib/server/session';

// POST, from the header's form: a GET that signs out is a link any page could
// plant. The session ends here on the server, not only in the browser; a
// sign-in through the authorization server also has its refresh token revoked
// there (SMD-3307), ending the grant's chain, best-effort — the session ends
// whether or not the AS answers.
export const POST: RequestHandler = async ({ cookies, url }) => {
	const held = closeSession(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, cookieOptions(url));
	const s = oauthSettings(env);
	if (held && 'tokens' in held && s && !(await revokeRefresh(s, held.tokens.refresh))) console.error('[dashboard] sign-out: the authorization server did not revoke the refresh token');
	throw redirect(303, `${base}/signin`);
};
