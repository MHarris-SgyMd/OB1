import { fail, redirect } from '@sveltejs/kit';
import { HOME } from '$lib/paths';
import type { Actions, PageServerLoad } from './$types';
import { codeOf, rest } from '$lib/server/rest';
import { closeSession, cookieOptions, openSession, SESSION_COOKIE, SESSION_MAX_AGE } from '$lib/server/session';
import { FIRST_READ, keySignInOffered, whoAmI } from '$lib/server/signin';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.session) throw redirect(303, HOME);
	return { offered: keySignInOffered() };
};

export const actions: Actions = {
	// The key is checked against the REST core before anything is held: whoami
	// under that key. A refusal is the core's (401 here); what the key may call
	// decides whether it may sign in at all and whether it may capture.
	default: async ({ request, cookies, url }) => {
		if (!keySignInOffered()) return fail(403, { error: 'Key sign-in is off: this stack is configured with the authorization server.' });
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
		// A sign-in over a live session replaces it: the old id would otherwise hold its key until it expired, out of sign-out's reach.
		closeSession(cookies.get(SESSION_COOKIE));
		const id = openSession({ key, name: who.name, scope: who.scope, canCapture: who.operations.includes('capture_thought') });
		cookies.set(SESSION_COOKIE, id, { ...cookieOptions(url), maxAge: SESSION_MAX_AGE });
		throw redirect(303, HOME);
	},
};
