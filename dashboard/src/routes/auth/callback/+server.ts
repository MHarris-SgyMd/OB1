import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { HOME } from '$lib/paths';
import { exchangeCode, oauthSettings, revokeEnded, signInFrom } from '$lib/server/oauth';
import { rest } from '$lib/server/rest';
import { closeSession, cookieOptions, openSession, SESSION_COOKIE, SESSION_MAX_AGE, SIGNIN_COOKIE, signInCookieOptions, spendSignIn } from '$lib/server/session';
import { FIRST_READ, whoAmI } from '$lib/server/signin';

// The authorization server's answer (SMD-3307): the redirect URI the AS
// registers for the `gui` client. The answer is taken only from the browser
// that started it — the state derived from the binding in its cookie, which no
// URL carries — and once; the verifier is derived from the same binding
// (oauth.ts signInFrom), so a code and state seen elsewhere complete nothing
// (review pass 2); the code is traded for tokens
// on the mesh with the client's secret, and the REST core's whoami, under the
// new access token, says whose they are and what they may call — as a key's
// sign-in does. Every way it can fail goes back to /signin with a word for
// why, never the AS's own text.
const back = (why: string): never => {
	throw redirect(303, `${base}/signin?refused=${why}`);
};

export const GET: RequestHandler = async ({ cookies, url, request }) => {
	const s = oauthSettings(env);
	if (!s) back('not_configured');
	const state = url.searchParams.get('state');
	const held = signInFrom(cookies.get(SIGNIN_COOKIE));
	// The cookie goes only with its own answer: a stray or stale callback leaves a sign-in in flight alone (review pass 1).
	if (!state || !held || state !== held.state) back('stale');
	cookies.delete(SIGNIN_COOKIE, signInCookieOptions(url));
	if (!spendSignIn(state!)) back('stale');
	const verifier = held!.verifier;
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
	// From here a failure leaves tokens no session will hold: revoked, not left live (review pass 1).
	if (!whoAnswer) {
		void revokeEnded(s, [tokens]);
		back('unreachable');
	}
	if (!whoAnswer!.ok) console.error(`[dashboard] whoami refused a new sign-in's token: ${whoAnswer!.status}`);
	const who = whoAnswer!.ok ? whoAmI(whoAnswer!.body) : null;
	if (!who || !who.operations.includes(FIRST_READ)) {
		void revokeEnded(s, [tokens]);
		back(who ? 'cannot_read' : 'token');
	}
	// A sign-in over a live session replaces it, as a key's does; what it, or room for this one, ended is revoked.
	const replaced = closeSession(cookies.get(SESSION_COOKIE));
	const opened = openSession({ credential: { tokens }, name: who!.name, scope: who!.scope, canCapture: who!.operations.includes('capture_thought') });
	void revokeEnded(s, [replaced && 'tokens' in replaced ? replaced.tokens : null, ...opened.ended]);
	cookies.set(SESSION_COOKIE, opened.id, { ...cookieOptions(url), maxAge: SESSION_MAX_AGE });
	throw redirect(303, HOME);
};
