import { redirect, type Handle } from '@sveltejs/kit';
import { base } from '$app/paths';
import { closeSession, cookieOptions, readSession, SESSION_COOKIE } from '$lib/server/session';

/** The paths a visitor reaches signed out: the sign-in page and the liveness probe. */
const OPEN = new Set([`${base}/signin`, `${base}/health`]);

// Every request: the session the cookie names, if any, becomes locals.session.
// A cookie that names none (ended, expired, or from before a restart) is
// dropped. Signed out, every path but OPEN redirects to /signin — here, not in
// a layout's load, so a form action or an endpoint is behind it too.
export const handle: Handle = async ({ event, resolve }) => {
	const id = event.cookies.get(SESSION_COOKIE);
	const session = readSession(id);
	event.locals.session = session;
	if (id && !session) {
		closeSession(id);
		event.cookies.delete(SESSION_COOKIE, cookieOptions(event.url));
	}
	if (!session && !OPEN.has(event.url.pathname)) throw redirect(303, `${base}/signin`);
	const response = await resolve(event);
	// Nothing a page shows is the browser's to keep: a thought, the brain's facts.
	response.headers.set('cache-control', 'no-store');
	response.headers.set('referrer-policy', 'no-referrer');
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('x-frame-options', 'DENY');
	return response;
};
