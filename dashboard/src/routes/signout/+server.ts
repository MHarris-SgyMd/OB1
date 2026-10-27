import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { closeSession, cookieOptions } from '$lib/server/session';

// POST, from the header's form: a GET that signs out is a link any page could
// plant; and from this origin, which hooks.server.ts checks of every unsafe
// request, one with no body too (review pass 3). The session ends here on the
// server, not only in the browser — this listener's own (locals.session, under
// its own cookie name, SMD-3307); a sign-in through the authorization server also
// has its refresh token revoked there (session.ts onTokensEnded), ending the
// grant's chain — by the revoker, not waited on: an AS that hangs, or a queue
// left by an outage, would otherwise hold the sign-out (review pass 4).
export const POST: RequestHandler = async ({ cookies, url, locals }) => {
	closeSession(locals.session?.id);
	cookies.delete(locals.sessionCookie, cookieOptions(url, locals.breakglass));
	throw redirect(303, `${base}/signin`);
};
