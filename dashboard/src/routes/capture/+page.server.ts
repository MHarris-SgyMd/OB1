import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import { codeOf, may, write } from '$lib/server/rest';
import { cookieOptions } from '$lib/server/session';
import { CAPTURE_SOURCE, capturedCookie, EDIT_MAX_BYTES, FLASH_MAX_AGE, notAnswered, notYours, postedBytes, THOUGHT_ID } from '$lib/server/writes';

// A thought captured from the GUI (SMD-3322): capture_thought under the
// visitor's credential, naming the GUI's own source, `dashboard`, so its
// captures are not labelled `mcp`, the conversational label egress `source:`
// terms key on (SMD-3208). The core embeds the text, extracts its metadata and
// writes the audit row. Then the thought's page, which says what the capture
// did from a flash cookie: a new thought, or the one that already held this
// text — into which the core merges this capture, its source now `dashboard`
// and the metadata extracted merged in (review pass 1) — and whether this
// capture wrote no embedding.
// The form posts as multipart, held to EDIT_MAX_BYTES as the edit page is. A
// session whose whoami named no capture_thought is offered no page here.

export const csr = false;

const tooLarge = (n: number) =>
	`This text posts as ${n.toLocaleString('en-US')} bytes, past the ${EDIT_MAX_BYTES.toLocaleString('en-US')} this page saves. Capture it through capture_thought over the MCP server or the REST core instead.`;

export const load: PageServerLoad = async (event) => {
	if (!may(event.locals.session, 'capture_thought')) error(403, notYours('capture'));
	return {};
};

export const actions: Actions = {
	capture: async (event) => {
		const session = event.locals.session!;
		// Before anything the post says, as the load: no call the core would only refuse (the load's 403 answers the page).
		if (!may(session, 'capture_thought')) return fail(403, { content: '', error: notYours('capture') });
		const form = await event.request.formData();
		// A browser sends a textarea's line breaks as CRLF: saved as they were typed, as the edit page saves them.
		const content = String(form.get('content') ?? '').replace(/\r\n?/g, '\n');
		const kept = { content };
		if (!content.trim()) return fail(400, { ...kept, error: 'Write the thought first.' });
		// No Postgres text holds a NUL: the core's 500 (SMD-2534). Refused here, not stripped, since the text is the visitor's words.
		if (content.includes('\0')) return fail(400, { ...kept, error: 'A thought cannot hold a NUL character.' });
		if (postedBytes(content) > EDIT_MAX_BYTES) return fail(413, { ...kept, error: tooLarge(postedBytes(content)) });
		const answer = await write(event, session, 'capture_thought', { content, source: CAPTURE_SOURCE });
		const body = answer.body as { id?: unknown; existed?: unknown; embeddingAttached?: unknown } | null;
		if (answer.ok && typeof body?.id === 'string' && THOUGHT_ID.test(body.id)) {
			const said = `${body.id}.${body.existed === true ? 'existed' : 'new'}${body.embeddingAttached === false ? '.novector' : ''}`;
			event.cookies.set(capturedCookie(event.locals.sessionCookie), said, { ...cookieOptions(event.url, event.locals.breakglass), maxAge: FLASH_MAX_AGE });
			redirect(303, `${base}/thoughts/${body.id}`);
		}
		const code = codeOf(answer.body);
		if (answer.ok || answer.status >= 500) console.error(`[dashboard] capture_thought: ${answer.status} ${code ?? (answer.ok ? 'no thought id in the answer' : '')}`.trimEnd());
		const said =
			notAnswered(code, 'capture') ??
			(answer.status === 403 ? notYours('capture')
			: answer.ok ? 'The brain saved the thought but did not say its id. Find it under Browse.'
			: answer.status >= 500 ? `The brain could not capture the thought${code ? ` (${code})` : ''}.`
			: `The brain refused the thought${code ? ` (${code})` : ''}.`);
		return fail(answer.ok ? 502 : answer.status, { ...kept, error: said });
	},
};
