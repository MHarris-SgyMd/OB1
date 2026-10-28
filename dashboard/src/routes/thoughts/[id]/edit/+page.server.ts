import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import { codeOf, may, read, write } from '$lib/server/rest';
import type { FetchedThought } from '$lib/types';

// A thought's text, edited (SMD-3322): update_thought under the visitor's
// credential, with the `updated_at` this page read as its
// `if_unchanged_since`, so an edit made since — by another tab, a connector or
// a worker — is refused as stale rather than overwritten. The core writes the
// audit row, keeping the text it replaced, and re-embeds the new text. A
// session whose whoami named no update_thought is offered no page here.

// Server-rendered alone, as the thought's own page: the text rides once, in the field.
export const csr = false;

const NOT_YOURS = 'This key cannot edit thoughts: editing is a write key’s.';

export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	if (!may(session, 'update_thought')) error(403, NOT_YOURS);
	const thought = (await read(event, session, 'fetch', { id: event.params.id })) as FetchedThought;
	const updatedAt = thought.metadata.updated_at;
	return { thought: { id: thought.id, title: thought.title, text: thought.text, updatedAt: typeof updatedAt === 'string' ? updatedAt : null } };
};

export const actions: Actions = {
	save: async (event) => {
		const session = event.locals.session!;
		const form = await event.request.formData();
		// A browser sends a textarea's line breaks as CRLF: saved as they were typed (the pin's rule, review pass 1 there).
		const content = String(form.get('content') ?? '').replace(/\r\n?/g, '\n');
		const since = String(form.get('if_unchanged_since') ?? '');
		// The time posted stays the form's: the load runs again after a refusal and reads the thought afresh, and its
		// newer time in the field would let a second Save overwrite the change a stale refusal just reported.
		const kept = { content, since };
		// Before anything the post says, as the page's load: a session that may not edit is told so without a call the core would only refuse.
		if (!may(session, 'update_thought')) return fail(403, { ...kept, error: NOT_YOURS });
		if (!content.trim()) return fail(400, { ...kept, error: 'A thought cannot be left empty. To remove it, delete it.' });
		// No Postgres text holds a NUL: the core's 500 (SMD-2534). Refused here, not stripped, since the text is the visitor's words.
		if (content.includes('\0')) return fail(400, { ...kept, error: 'A thought cannot hold a NUL character.' });
		// The time the page read: without it the edit would overwrite whatever changed since, which this page exists not to do.
		if (!since) return fail(400, { ...kept, error: 'This form has lost the time its thought was read. Open the thought again and edit from there.' });
		const id = event.params.id;
		const answer = await write(event, session, 'update_thought', { id, content, if_unchanged_since: since });
		if (answer.ok) redirect(303, `${base}/thoughts/${encodeURIComponent(id)}`);
		const code = codeOf(answer.body);
		if (answer.status >= 500) console.error(`[dashboard] update_thought: ${answer.status} ${code ?? ''}`.trimEnd());
		const said =
			answer.status === 403 ? NOT_YOURS
			: code === 'REFUSED_STALE_READ' ? 'The thought changed after this page read it, so the edit was not saved. Open the thought again to see the change, then edit that.'
			: code === 'NOT_FOUND' ? 'The brain no longer holds this thought.'
			: code === 'REFUSED_DUPLICATE_CONTENT' ? 'Another thought already holds this text.'
			: answer.status >= 500 ? `The brain could not save the edit${code ? ` (${code})` : ''}.`
			: `The brain refused the edit${code ? ` (${code})` : ''}.`;
		return fail(answer.status, { ...kept, error: said });
	},
};
