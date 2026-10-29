import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import { codeOf, may, read, write } from '$lib/server/rest';
import { EDIT_MAX_BYTES, notAnswered, notYours, postedBytes } from '$lib/server/writes';
import type { FetchedThought } from '$lib/types';

// A thought's text, edited (SMD-3322): update_thought under the visitor's
// credential, with the `updated_at` this page read as its
// `if_unchanged_since`, so an edit made since — by another tab, a connector or
// a worker — is refused as stale rather than overwritten. The core writes the
// audit row, keeping the text it replaced, and re-embeds the new text. A
// session whose whoami named no update_thought is offered no page here. The
// form posts as multipart, so its text is not percent-encoded, and a text past
// EDIT_MAX_BYTES is said to be one, not sent.

// Server-rendered alone, as the thought's own page: the text rides once, in the field.
export const csr = false;

const tooLarge = (n: number) =>
	`This text posts as ${n.toLocaleString('en-US')} bytes, past the ${EDIT_MAX_BYTES.toLocaleString('en-US')} this page saves. Edit it through update_thought over the MCP server or the REST core instead.`;
/** The time the core writes as updated_at, ISO 8601 or Postgres's text form: what an unaltered form posts back. */
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	if (!may(session, 'update_thought')) error(403, notYours('edit'));
	const thought = (await read(event, session, 'fetch', { id: event.params.id })) as FetchedThought;
	const updatedAt = thought.metadata.updated_at;
	const size = postedBytes(thought.text);
	// A text the page could not post back is not put in a field to be edited and lost: said, and left out.
	const editable = size <= EDIT_MAX_BYTES;
	return {
		thought: { id: thought.id, title: thought.title, text: editable ? thought.text : null, updatedAt: typeof updatedAt === 'string' ? updatedAt : null },
		tooLarge: editable ? null : tooLarge(size),
	};
};

export const actions: Actions = {
	save: async (event) => {
		const session = event.locals.session!;
		// Before anything the post says, as the page's load: a session that may not edit makes no call the core would only
		// refuse. What it sees is the load's 403, which runs after a refused action and answers the page whatever this said.
		if (!may(session, 'update_thought')) return fail(403, { content: '', since: '', error: notYours('edit') });
		const form = await event.request.formData();
		// A browser sends a textarea's line breaks as CRLF: saved as they were typed (the pin's rule, review pass 1 there).
		const content = String(form.get('content') ?? '').replace(/\r\n?/g, '\n');
		const since = String(form.get('if_unchanged_since') ?? '');
		// The time posted stays the form's: the load runs again after a refusal and reads the thought afresh, and its
		// newer time in the field would let a second Save overwrite the change a stale refusal just reported.
		const kept = { content, since };
		if (!content.trim()) return fail(400, { ...kept, error: 'A thought cannot be left empty. To remove it, delete it.' });
		// No Postgres text holds a NUL: the core's 500 (SMD-2534). Refused here, not stripped, since the text is the visitor's words.
		if (content.includes('\0')) return fail(400, { ...kept, error: 'A thought cannot hold a NUL character.' });
		if (postedBytes(content) > EDIT_MAX_BYTES) return fail(413, { ...kept, error: tooLarge(postedBytes(content)) });
		// The time the page read: without it the edit would overwrite whatever changed since, which this page exists not
		// to do. One that is no time at all is a form altered by hand, which the core would answer with a fault (review pass 1).
		if (!TIME.test(since) || !Number.isFinite(Date.parse(since))) return fail(400, { ...kept, error: 'This form has lost the time its thought was read. Open the thought again and edit from there.' });
		const id = event.params.id;
		const answer = await write(event, session, 'update_thought', { id, content, if_unchanged_since: since });
		if (answer.ok) redirect(303, `${base}/thoughts/${encodeURIComponent(id)}`);
		const code = codeOf(answer.body);
		if (answer.status >= 500) console.error(`[dashboard] update_thought: ${answer.status} ${code ?? ''}`.trimEnd());
		const said =
			notAnswered(code, 'edit') ??
			(answer.status === 403 ? notYours('edit')
			: code === 'REFUSED_STALE_READ' ? 'The thought changed after this page read it, so the edit was not saved. Open the thought again to see the change, then edit that.'
			: code === 'NOT_FOUND' ? 'The brain no longer holds this thought.'
			: code === 'REFUSED_DUPLICATE_CONTENT' ? 'Another thought already holds this text.'
			: answer.status >= 500 ? `The brain could not save the edit${code ? ` (${code})` : ''}.`
			: `The brain refused the edit${code ? ` (${code})` : ''}.`);
		return fail(answer.status, { ...kept, error: said });
	},
};
