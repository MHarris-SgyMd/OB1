import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { base } from '$app/paths';
import type { RequestHandler } from './$types';
import { HOME } from '$lib/paths';
import { exchangeCode, oauthSettings, signedInSince, signInFrom } from '$lib/server/oauth';
import { revocations, rest } from '$lib/server/rest';
import { closeSession, cookieOptions, openSession, SESSION_MAX_AGE, signInCookieName, signInCookieOptions, spendSignIn } from '$lib/server/session';
import { FIRST_READ, whoAmI } from '$lib/server/signin';

// The authorization server's answer (SMD-3307): the redirect URI the AS
// registers for the `gui` client. The answer is taken only from the browser
// that started it — the state derived from the binding in its cookie, which no
// URL carries — and once; the verifier is derived from the same binding
// (oauth.ts signInFrom), so a code and state seen elsewhere complete no
// sign-in this browser started (review pass 2); the code is traded for tokens
// on the mesh with the client's secret, and taken only if the password was
// typed for this sign-in (review pass 3); the REST core's whoami, under the
// new access token, says whose they are and what they may call — as a key's
// sign-in does. Every way it can fail goes back to /signin with a word for
// why, never the AS's own text.
const back = (why: string): never => {
	throw redirect(303, `${base}/signin?refused=${why}`);
};

export const GET: RequestHandler = async ({ cookies, url, request, locals }) => {
	const s = oauthSettings(env);
	if (!s) back('not_configured');
	// Never on the break-glass port, as the start never is: the AS answers at the origin alone, and a session opened here would be the origin's under the port's cookie (review pass 2).
	if (locals.breakglass) back('stale');
	const state = url.searchParams.get('state');
	const held = signInFrom(cookies.get(signInCookieName(url)));
	// The cookie goes only with its own answer: a stray or stale callback leaves a sign-in in flight alone (review pass 1).
	if (!state || !held || state !== held.state) back('stale');
	cookies.delete(signInCookieName(url), signInCookieOptions(url));
	if (!spendSignIn(state!)) back('stale');
	const error = url.searchParams.get('error');
	if (error) back(error === 'access_denied' ? 'denied' : 'refused');
	const code = url.searchParams.get('code');
	if (!code) back('refused');

	const answer = await exchangeCode(s!, code!, held!.verifier);
	if (!answer.ok) {
		if ('unreachable' in answer) back('unreachable');
		else {
			console.error(`[dashboard] the authorization server refused a sign-in's code (${answer.refused})`);
			back('refused');
		}
	}
	const { tokens, signedInAt } = answer as Extract<typeof answer, { ok: true }>;
	// From here a failure leaves tokens no session will hold: revoked, not left live (review pass 1).
	// The password typed for this sign-in, not before it: `prompt=login` rides a URL the browser can change, and
	// the AS's own session — a day, which the GUI's sign-out leaves — would then sign the next visitor of that
	// browser in with a click (review pass 3). The ID token's auth_time says when the AS last asked.
	if (!signedInSince(signedInAt, held!.began)) {
		void revocations.add(tokens);
		back('login');
	}
	let whoAnswer;
	try {
		whoAnswer = await rest().call('whoami', {}, { token: tokens.access, signal: request.signal });
	} catch (err) {
		console.error(`[dashboard] whoami: the REST core did not answer: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!whoAnswer) {
		void revocations.add(tokens);
		back('unreachable');
	}
	if (!whoAnswer!.ok) console.error(`[dashboard] whoami refused a new sign-in's token: ${whoAnswer!.status}`);
	const who = whoAnswer!.ok ? whoAmI(whoAnswer!.body) : null;
	if (!who || !who.operations.includes(FIRST_READ)) {
		void revocations.add(tokens);
		back(who ? 'cannot_read' : 'token');
	}
	// A sign-in over a live session replaces it, as a key's does; it, and any the store ends for room, have their tokens revoked (session.ts onTokensEnded).
	closeSession(locals.session?.id);
	const id = openSession({ credential: { tokens }, name: who!.name, scope: who!.scope, canCapture: who!.operations.includes('capture_thought'), operations: who!.operations, breakglass: false });
	cookies.set(locals.sessionCookie, id, { ...cookieOptions(url), maxAge: SESSION_MAX_AGE });
	throw redirect(303, HOME);
};
