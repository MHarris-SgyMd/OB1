import { env } from '$env/dynamic/private';
import type { Handle } from '@sveltejs/kit';
import { cookieOptions, SESSION_COOKIE, sessionSecret, unseal } from '$lib/server/session';

// Every request: the session cookie, if any, becomes locals.session. A cookie
// that does not unseal (tampered, expired, or SESSION_SECRET rotated) is
// dropped, so the visitor lands on /signin rather than on an error.
export const handle: Handle = async ({ event, resolve }) => {
	const secret = sessionSecret(env);
	const token = event.cookies.get(SESSION_COOKIE);
	event.locals.session = await unseal(token, secret);
	if (token && !event.locals.session) event.cookies.delete(SESSION_COOKIE, cookieOptions(event.url));
	return resolve(event);
};
