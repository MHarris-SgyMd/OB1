import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { authorizeUrl, newSignIn, oauthSettings } from '$lib/server/oauth';
import { SIGNIN_COOKIE, SIGNIN_MAX_AGE, signInCookieOptions } from '$lib/server/session';
import { authReachability } from '../../../../../server-portable/oauth-edge.ts';

// A sign-in through the authorization server starts here (SMD-3307): a binding
// (when it began, and random bytes) in a cookie on the GUI's auth paths alone,
// the state and the PKCE verifier derived from it (oauth.ts signInFrom, so a
// start holds nothing here, and a callback URL alone completes no sign-in this
// browser started), and the browser sent to the AS's authorization endpoint —
// or, the AS down, back to the sign-in page, which says so (review pass 1).
// POST, from the sign-in page's button: a link would be started by a hover's
// preload, and a page elsewhere could plant one; and from this origin, which
// hooks.server.ts checks of every unsafe request, one with no body too (review
// pass 3). Never on the break-glass port, whose key sign-in is the way in
// there: the AS answers at the origin alone (SMD-3307).
export const POST: RequestHandler = async ({ cookies, url, locals }) => {
	const s = oauthSettings(env);
	if (!s || locals.session || locals.breakglass || !(await authReachability().reachable())) throw redirect(303, `${base}/signin`);
	const { binding, state, challenge } = newSignIn();
	cookies.set(SIGNIN_COOKIE, binding, { ...signInCookieOptions(url), maxAge: SIGNIN_MAX_AGE });
	throw redirect(303, authorizeUrl(s, state, challenge));
};
