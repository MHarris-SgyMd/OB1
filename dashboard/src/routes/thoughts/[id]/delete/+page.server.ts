import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import { firstLine } from '$lib/format';
import { codeOf, may, read, write } from '$lib/server/rest';
import { cookieOptions } from '$lib/server/session';
import { deletedCookie, FLASH_MAX_AGE, notYours } from '$lib/server/writes';
import type { FetchedThought } from '$lib/types';

// A thought deleted (SMD-3322): delete_thought under the visitor's credential,
// one thought, after this page asks. The core writes the audit row, which keeps
// the thought's text. A thought that statements in other thoughts cite is
// refused, and the page says how many; deleting it anyway is its own second
// confirm, `detach_citations`: each statement keeps its text and stance and
// records this thought as its deleted source (migration 042). A session whose
// whoami named no delete_thought is offered no page here.

export const csr = false;

export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	if (!may(session, 'delete_thought')) error(403, notYours('delete'));
	const thought = (await read(event, session, 'fetch', { id: event.params.id })) as FetchedThought;
	// The page asks about the thought by its title and first line alone: its whole text is a click away.
	return { thought: { id: thought.id, title: thought.title, line: firstLine(thought.text, 300) } };
};

export const actions: Actions = {
	delete: async (event) => {
		const session = event.locals.session!;
		if (!may(session, 'delete_thought')) return fail(403, { error: notYours('delete') });
		const form = await event.request.formData();
		const detach = form.get('detach_citations') === 'true';
		const id = event.params.id;
		const answer = await write(event, session, 'delete_thought', { id, ...(detach ? { detach_citations: true } : {}) });
		// To the list, which says what was deleted, from a flash cookie it reads once (review pass 1: from the address, a
		// link could make it say so of a thought that stands). Not back here: this page's load would find no thought.
		if (answer.ok) {
			event.cookies.set(deletedCookie(event.locals.sessionCookie), id, { ...cookieOptions(event.url, event.locals.breakglass), maxAge: FLASH_MAX_AGE });
			redirect(303, `${base}/thoughts`);
		}
		const code = codeOf(answer.body);
		if (answer.status >= 500) console.error(`[dashboard] delete_thought: ${answer.status} ${code ?? ''}`.trimEnd());
		if (code === 'REFUSED_CITED') {
			const n = (answer.body as { citedBy?: unknown }).citedBy;
			return fail(409, { cited: typeof n === 'number' ? n : null });
		}
		const said =
			answer.status === 403 ? notYours('delete')
			: code === 'NOT_FOUND' ? 'The brain no longer holds this thought.'
			: answer.status >= 500 ? `The brain could not delete the thought${code ? ` (${code})` : ''}.`
			: `The brain refused the delete${code ? ` (${code})` : ''}.`;
		return fail(answer.status, { error: said });
	},
};
