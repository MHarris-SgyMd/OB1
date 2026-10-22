import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { closeSession, cookieOptions, SESSION_COOKIE } from '$lib/server/session';

// POST, from the header's form: a GET that signs out is a link any page could
// plant. The session ends here on the server, not only in the browser.
export const POST: RequestHandler = async ({ cookies, url }) => {
	closeSession(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, cookieOptions(url));
	throw redirect(303, `${base}/signin`);
};
