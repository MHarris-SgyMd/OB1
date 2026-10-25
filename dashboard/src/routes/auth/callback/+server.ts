import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { HOME } from '$lib/paths';
import { exchangeCode, oauthSettings } from '$lib/server/oauth';
import { rest } from '$lib/server/rest';
import { closeSession, cookieOptions, openSession, SESSION_COOKIE, SESSION_MAX_AGE, SIGNIN_COOKIE, signInCookieOptions, takeSignIn } from '$lib/server/session';
import { FIRST_READ, whoAmI } from '$lib/server/signin';

// The authorization server's answer (SMD-3307): the redirect URI the AS
// registers for the `gui` client. The answer is taken only with the state
// this browser was given at the start (its cookie) and the verifier held for
// it, once; the code is traded for tokens on the mesh with the client's
// secret, and the REST core's whoami, under the new access token, says whose
// they are and what they may call — as a key's sign-in does. Every way it can
// fail goes back to /signin with a word for why, never the AS's own text.
const back = (why: string): never => {
	throw redirect(303, `${base}/signin?refused=${why}`);
};

export const GET: RequestHandler = async ({ cookies, url, request }) => {
	const s = oauthSettings(env);
	if (!s) back('not_configured');
	const state = url.searchParams.get('state');
	const bound = cookies.get(SIGNIN_COOKIE);
	cookies.delete(SIGNIN_COOKIE, signInCookieOptions(url));
	// The verifier is spent whatever happens next: an answer is taken once.
	const verifier = takeSignIn(state);
	if (!state || state !== bound || !verifier) back('stale');
	const error = url.searchParams.get('error');
	if (error) back(error === 'access_denied' ? 'denied' : 'refused');
	const code = url.searchParams.get('code');
	if (!code) back('refused');

	const answer = await exchangeCode(s!, code!, verifier!);
	if (!answer.ok) {
		if ('unreachable' in answer) back('unreachable');
		else {
			console.error(`[dashboard] the authorization server refused a sign-in's code (${answer.refused})`);
			back('refused');
		}
	}
	const { tokens } = answer as Extract<typeof answer, { ok: true }>;
	let whoAnswer;
	try {
		whoAnswer = await rest().call('whoami', {}, { token: tokens.access, signal: request.signal });
	} catch (err) {
		console.error(`[dashboard] whoami: the REST core did not answer: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!whoAnswer) back('unreachable');
	if (!whoAnswer!.ok) console.error(`[dashboard] whoami refused a new sign-in's token: ${whoAnswer!.status}`);
	const who = whoAnswer!.ok ? whoAmI(whoAnswer!.body) : null;
	if (!who) back('token');
	if (!who!.operations.includes(FIRST_READ)) back('cannot_read');
	// A sign-in over a live session replaces it, as a key's does.
	closeSession(cookies.get(SESSION_COOKIE));
	const id = openSession({ credential: { tokens }, name: who!.name, scope: who!.scope, canCapture: who!.operations.includes('capture_thought') });
	cookies.set(SESSION_COOKIE, id, { ...cookieOptions(url), maxAge: SESSION_MAX_AGE });
	throw redirect(303, HOME);
};
