import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { onBreakGlass } from '$lib/server/listener';
import { closeSession, cookieOptions, SESSION_COOKIE } from '$lib/server/session';

// POST, from the header's form: a GET that signs out is a link any page could
// plant; and from this origin, which hooks.server.ts checks of every unsafe
// request, one with no body too (review pass 3). The session ends here on the
// server, not only in the browser — this listener's own (locals.session), so a
// sign-out on the break-glass port ends no session of the origin's where the
// two share a host (SMD-3307); a sign-in through the authorization server also
// has its refresh token revoked there (session.ts onTokensEnded), ending the
// grant's chain — by the revoker, not waited on: an AS that hangs, or a queue
// left by an outage, would otherwise hold the sign-out (review pass 4).
export const POST: RequestHandler = async ({ cookies, request, url, locals }) => {
	closeSession(locals.session?.id);
	cookies.delete(SESSION_COOKIE, cookieOptions(url, onBreakGlass(request)));
	throw redirect(303, `${base}/signin`);
};
