import { error, redirect, type Handle } from '@sveltejs/kit';
import { base } from '$app/paths';
import { env } from '$env/dynamic/private';
import { breakGlassPort, onBreakGlass, originAllowed, originRefusal, sessionCookieName } from '$lib/server/listener';
import { revocations } from '$lib/server/rest';
import { closeSession, cookieOptions, onTokensEnded, readSession } from '$lib/server/session';
import { EDIT_PATH, SMALL_BODY_BYTES } from '$lib/server/writes';

// Tokens no session holds any more, however it ended, are revoked at the AS (SMD-3307; review pass 3).
onTokensEnded((t) => void revocations.add(t));

/** The paths a visitor reaches signed out: the sign-in page, a sign-in through the authorization server (its start and its answer, SMD-3307), and the liveness probe. */
const OPEN = new Set([`${base}/signin`, `${base}/auth/start`, `${base}/auth/callback`, `${base}/health`]);

// Every request: first its origin, if it changes anything — SvelteKit's own
// check is off for the break-glass port's sake (svelte.config.js), so this one
// takes the origin and, on the break-glass listener alone, that port's loopback
// origin (listener.ts originAllowed). Then the session the cookie names, if
// any, becomes locals.session — only on the listener it was signed in on, so a
// break-glass session, a key's while the stack is configured, opens nothing on
// the origin, and an origin's nothing on the break-glass port. Each listener's
// cookie has a name of its own (listener.ts sessionCookieName), so where the
// two share a host (an origin of http://127.0.0.1:…) neither overwrites the
// other's (review pass 1), and the origin's carries its port, so neither do two
// brains' on one machine (SMD-3352). A cookie that names none (ended, expired, or from
// before a restart) is dropped, and an expired session's tokens revoked at the
// AS (SMD-3307). Signed out, every path but OPEN redirects to /signin — here,
// not in a layout's load, so a form action or an endpoint is behind it too.
export const handle: Handle = async ({ event, resolve }) => {
	const port = breakGlassPort(env.BREAKGLASS_PORT);
	if (!originAllowed(event.request, event.url, port)) return guarded(originRefusal(event.request, event.url, port));
	const breakglass = onBreakGlass(event.request);
	event.locals.breakglass = breakglass;
	event.locals.sessionCookie = sessionCookieName(breakglass, port, event.url);
	const id = event.cookies.get(event.locals.sessionCookie);
	const held = readSession(id);
	const session = held && held.breakglass === breakglass ? held : null;
	event.locals.session = session;
	if (id && !held) {
		closeSession(id);
		event.cookies.delete(event.locals.sessionCookie, cookieOptions(event.url, breakglass));
	}
	if (!session && !OPEN.has(event.url.pathname)) throw redirect(303, `${base}/signin`);
	// The body limit is an edit's 1 MB (serve.ts); every other request — a sign-in, signed out, among them — is held to
	// 64 kB, as the GUI held them all before (SMD-3322 review pass 2). By its declared length: one sent without a length
	// is still cut at serve.ts's limit.
	const length = Number(event.request.headers.get('content-length') ?? 0);
	if (length > SMALL_BODY_BYTES && !(session && EDIT_PATH.test(event.url.pathname))) error(413, 'That is more than this page takes.');
	return guarded(await resolve(event));
};

/** Every answer's headers, the origin check's refusal's too (review pass 2). */
function guarded(response: Response): Response {
	// Nothing a page shows is the browser's to keep: a thought, the brain's facts.
	response.headers.set('cache-control', 'no-store');
	// No page's URL leaves the origin. Not `no-referrer`: under it a browser
	// sends `Origin: null` with a plain form POST, which the origin check
	// refuses, so sign-out (a form with no script) failed in every browser
	// (review pass 1, Chromium, Firefox and WebKit).
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('x-frame-options', 'DENY');
	return response;
}
