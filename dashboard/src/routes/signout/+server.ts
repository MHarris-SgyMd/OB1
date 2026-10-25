import { error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { closeSession, cookieOptions, SESSION_COOKIE } from '$lib/server/session';

// POST, from the header's form: a GET that signs out is a link any page could
// plant; and from this origin, which SvelteKit checks of a form's post but not
// of one with no body (review pass 3). The session ends here on the server, not
// only in the browser; a sign-in through the authorization server also has its
// refresh token revoked there (SMD-3307, session.ts onTokensEnded), ending the
// grant's chain — by the revoker, not waited on: an AS that hangs, or a queue
// left by an outage, would otherwise hold the sign-out (review pass 4).
export const POST: RequestHandler = async ({ cookies, request, url }) => {
	if (request.headers.get('origin') !== url.origin) throw error(403, 'Sign-out is posted from the dashboard itself.');
	closeSession(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, cookieOptions(url));
	throw redirect(303, `${base}/signin`);
};
