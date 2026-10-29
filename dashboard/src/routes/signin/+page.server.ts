import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { HOME } from '$lib/paths';
import type { Actions, PageServerLoad } from './$types';
import { codeOf, rest } from '$lib/server/rest';
import { closeSession, cookieOptions, openSession, SESSION_MAX_AGE } from '$lib/server/session';
import { FIRST_READ, keySignInOffered, REFUSED_WORDS, whoAmI } from '$lib/server/signin';
import { oauthSettings } from '$lib/server/oauth';
import { authReachability, configuredIn } from '../../../../server-portable/oauth-edge.ts';
import { breakGlassPort } from '$lib/server/listener';

/**
 * The page's state (ADR decision 16, SMD-2382): not configured, key sign-in;
 * configured and the authorization server answering, a sign-in through it;
 * configured and not answering, no sign-in here — knocking the AS over opens
 * no weaker door — pointing to break-glass; configured but the GUI given no
 * secret or no sound origin, said as the operator's to fix. On the break-glass
 * port (SMD-3307), configured, key sign-in whatever the AS's state.
 */
export const load: PageServerLoad = async ({ locals, request, url }) => {
	// Signed in, a visit goes home; a post's own answer stands, so a refused key
	// sent from a tab still signed in says why (review pass 2).
	if (locals.session && request.method === 'GET') throw redirect(303, HOME);
	// Its own words alone: `constructor` or `__proto__` in the address is no word of it (review pass 1: an inherited key was a 500).
	const word = url.searchParams.get('refused') ?? '';
	const refused = Object.hasOwn(REFUSED_WORDS, word) ? REFUSED_WORDS[word] : null;
	if (keySignInOffered(request)) return { mode: configuredIn(env.COMPOSE_PROFILES) && locals.breakglass ? ('breakglass' as const) : ('key' as const), refused };
	const breakglassPort = breakGlassPort(env.BREAKGLASS_PORT);
	if (!oauthSettings(env)) return { mode: 'misconfigured' as const, refused, breakglassPort };
	return { mode: (await authReachability().reachable()) ? ('oauth' as const) : ('unavailable' as const), refused, breakglassPort };
};

export const actions: Actions = {
	// The key is checked against the REST core before anything is held: whoami
	// under that key. A refusal is the core's (401 here); what the key may call
	// decides whether it may sign in at all and whether it may capture.
	default: async ({ request, cookies, url, locals }) => {
		if (!keySignInOffered(request)) return fail(403, { error: 'Key sign-in is off: this stack is configured with the authorization server. Sign in through it.' });
		const form = await request.formData();
		const key = String(form.get('key') ?? '').trim();
		if (!key) return fail(400, { error: 'Paste an access key.' });

		let answer;
		try {
			answer = await rest().call('whoami', {}, { key, signal: request.signal });
		} catch (err) {
			// This page answers strangers: why the core did not answer is the operator's, in the log.
			console.error(`[signin] whoami: the REST core did not answer: ${err instanceof Error ? err.message : String(err)}`);
			return fail(502, { error: 'Could not reach the brain. The dashboard log has the reason.' });
		}
		if (answer.status === 401) return fail(401, { error: 'The brain refused that access key.' });
		const who = answer.ok ? whoAmI(answer.body) : null;
		if (!who) {
			console.error(`[signin] whoami answered ${answer.status} ${codeOf(answer.body) ?? ''}`.trimEnd());
			return fail(502, { error: 'Sign-in failed. The dashboard log has the reason.' });
		}
		if (!who.operations.includes(FIRST_READ)) {
			return fail(403, { error: 'This key cannot read: the dashboard needs a read- or write-scoped key. A capture-only key may add thoughts and nothing else.' });
		}
		// A sign-in over a live session replaces it: the old id would otherwise hold its key until it expired, out of sign-out's reach. This listener's own (locals.session, under its own cookie name).
		closeSession(locals.session?.id);
		const id = openSession({ credential: { key }, name: who.name, scope: who.scope, canCapture: who.operations.includes('capture_thought'), operations: who.operations, breakglass: locals.breakglass });
		cookies.set(locals.sessionCookie, id, { ...cookieOptions(url, locals.breakglass), maxAge: SESSION_MAX_AGE });
		throw redirect(303, HOME);
	},
};
