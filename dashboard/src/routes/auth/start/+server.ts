import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { authorizeUrl, newSignIn, oauthSettings } from '$lib/server/oauth';
import { holdSignIn, SIGNIN_COOKIE, SIGNIN_MAX_AGE, signInCookieOptions } from '$lib/server/session';

// A sign-in through the authorization server starts here (SMD-3307): a state
// and a PKCE verifier held on this server, the state in a cookie on the GUI's
// auth paths alone, and the browser sent to the AS's authorization endpoint.
// POST, from the sign-in page's button: a link would be started by a hover's
// preload, and a page elsewhere could plant one.
export const POST: RequestHandler = async ({ cookies, url, locals }) => {
	const s = oauthSettings(env);
	if (!s || locals.session) throw redirect(303, `${base}/signin`);
	const { state, verifier, challenge } = newSignIn();
	holdSignIn(state, verifier);
	cookies.set(SIGNIN_COOKIE, state, { ...signInCookieOptions(url), maxAge: SIGNIN_MAX_AGE });
	throw redirect(303, authorizeUrl(s, state, challenge));
};
