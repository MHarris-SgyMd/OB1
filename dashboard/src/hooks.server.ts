import { redirect, type Handle } from '@sveltejs/kit';
import { base } from '$app/paths';
import { revocations } from '$lib/server/rest';
import { closeSession, cookieOptions, onTokensEnded, readSession, SESSION_COOKIE } from '$lib/server/session';

// Tokens no session holds any more, however it ended, are revoked at the AS (SMD-3307; review pass 3).
onTokensEnded((t) => void revocations.add(t));

/** The paths a visitor reaches signed out: the sign-in page, a sign-in through the authorization server (its start and its answer, SMD-3307), and the liveness probe. */
const OPEN = new Set([`${base}/signin`, `${base}/auth/start`, `${base}/auth/callback`, `${base}/health`]);

// Every request: the session the cookie names, if any, becomes locals.session.
// A cookie that names none (ended, expired, or from before a restart) is
// dropped, and an expired session's tokens revoked at the AS (SMD-3307). Signed out, every path but OPEN redirects to /signin — here, not in
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
	// No page's URL leaves the origin. Not `no-referrer`: under it a browser
	// sends `Origin: null` with a plain form POST, which SvelteKit refuses as
	// cross-site, so sign-out (a form with no script) failed in every browser
	// (review pass 1, Chromium, Firefox and WebKit).
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('x-frame-options', 'DENY');
	return response;
};
