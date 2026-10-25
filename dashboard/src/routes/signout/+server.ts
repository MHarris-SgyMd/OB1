import { error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { revocations } from '$lib/server/rest';
import { authReachability } from '../../../../server-portable/oauth-edge.ts';
import { closeSession, cookieOptions, SESSION_COOKIE } from '$lib/server/session';

// POST, from the header's form: a GET that signs out is a link any page could
// plant; and from this origin, which SvelteKit checks of a form's post but not
// of one with no body (review pass 3). The session ends here on the server, not
// only in the browser; a sign-in through the authorization server also has its
// refresh token revoked there (SMD-3307, session.ts onTokensEnded), ending the
// grant's chain — waited on while the AS answers, so the next sign-in finds it
// gone, and not while its probe finds it down (review pass 1: 10 s on every
// sign-out), when the revoker tries again until it answers (review pass 3).
export const POST: RequestHandler = async ({ cookies, request, url }) => {
	if (request.headers.get('origin') !== url.origin) throw error(403, 'Sign-out is posted from the dashboard itself.');
	const held = closeSession(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, cookieOptions(url));
	if (held && 'tokens' in held && (await authReachability().reachable())) await revocations.flush();
	throw redirect(303, `${base}/signin`);
};
