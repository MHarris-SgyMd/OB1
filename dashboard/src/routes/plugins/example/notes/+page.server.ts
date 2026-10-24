import { fail, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { Actions, PageServerLoad } from './$types';
import { firstLine, oneLine } from '$lib/format';
import { pluginAccess } from '$lib/server/plugins';

// The example plugin's Notes page (SMD-2280 PR 3; plugins/example/): a
// thought's notes through example_list_notes, the newest thoughts to choose
// from through example_recent, and pinning one through example_add_note for a
// key that may. Every read and write is the plugin's own REST operation under
// the visitor's key, so the page reaches nothing that key cannot call, and a
// key the registry lists none of the plugin to (or the plugin disabled) finds
// no page here: pluginAccess's 404, before any call.

const PLUGIN = 'example';
const PAGE = '/notes';
const HERE = `${base}/plugins/${PLUGIN}${PAGE}`;
/** A thought id as the plugin's operations read it: zod's uuid, an RFC 9562 one (or the nil and max), so the core never refuses one the page took. */
const THOUGHT_ID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
/** add_note's bound on a note, after its trim. */
const NOTE_MAX = 2000;

type Note = { id: string; thought_id: string; note: string; written_by: string; created_at: string };
type Recent = { id: string; type: string | null; created_at: string | null };

export const load: PageServerLoad = async (event) => {
	const ex = await pluginAccess(event, PLUGIN, PAGE);
	const typed = event.url.searchParams.get('thought')?.trim() ?? '';
	const thought = THOUGHT_ID.test(typed) ? typed.toLowerCase() : null;
	const [notes, recent] = await Promise.all([
		thought && ex.may('list_notes') ? ex.read('list_notes', 'GET', '/notes', { thought_id: thought }) : null,
		ex.may('recent') ? ex.read('recent', 'GET', '/recent', { limit: 10 }) : null,
	]);
	return {
		plugin: { title: ex.plugin.title, description: ex.plugin.description },
		// Cut whole: never half an emoji (review pass 1).
		typed: thought ? '' : firstLine(typed, 80),
		thought,
		canList: ex.may('list_notes'),
		canPin: ex.may('add_note'),
		// Each note's text whole (2000 characters at most); who wrote it is a key's name, on one line.
		notes: (notes as { notes: Note[] } | null)?.notes.map((n) => ({ id: n.id, note: n.note, by: oneLine(n.written_by, 80), at: n.created_at })) ?? null,
		recent: (recent as { thoughts: Recent[] } | null)?.thoughts.map((t) => ({ id: t.id, type: t.type === null ? null : oneLine(t.type, 40), at: t.created_at })) ?? null,
	};
};

export const actions: Actions = {
	// A note pinned under the visitor's key, then the thought's notes again (a
	// redirect, so a reload sends nothing twice). A refusal is said beside the
	// form, the note as typed kept in it.
	pin: async (event) => {
		const form = await event.request.formData();
		const thought = String(form.get('thought_id') ?? '').trim();
		// A browser counts a textarea's line break as one character for its maxlength and sends it as two (CRLF): read
		// as one, a note the field took is not refused as too long, and a note is stored with the breaks it was typed with (review pass 1).
		const note = String(form.get('note') ?? '').replace(/\r\n?/g, '\n');
		const kept = { note };
		if (!THOUGHT_ID.test(thought)) return fail(400, { ...kept, error: 'That is not a thought id: 36 characters of hex and hyphens, as a thought’s page shows it.' });
		if (!note.trim()) return fail(400, { ...kept, error: 'Write the note first.' });
		// Grouped as English groups it, whatever the server's locale (review pass 2).
		if (note.trim().length > NOTE_MAX) return fail(400, { ...kept, error: `A note is at most ${NOTE_MAX.toLocaleString('en-US')} characters; this one is ${note.trim().length.toLocaleString('en-US')}.` });
		// No Postgres text holds a NUL: the core's 500 (SMD-2534). Refused here, not stripped, since the note is the visitor's words.
		if (note.includes('\0')) return fail(400, { ...kept, error: 'A note cannot hold a NUL character.' });
		// The gate first, as the load's: an action runs before any load, so a plugin turned off, or a key that may call
		// none of it, is the page's 404 here too, before any call. A core that does not answer is the error page: after a
		// refusal the page's loads run again to render it, and fail the same (review pass 3 took back a catch that kept
		// the note only in a race).
		const ex = await pluginAccess(event, PLUGIN, PAGE);
		const answer = await ex.call('add_note', 'POST', '/notes', { thought_id: thought, note });
		// Back at the form, the new note just above it, not at the top of a long list (review pass 2).
		if (answer.ok) throw redirect(303, `${HERE}?thought=${thought.toLowerCase()}#pin`);
		const { code } = answer;
		if (answer.status >= 500) console.error(`[dashboard] ${PLUGIN}_add_note: ${answer.status} ${code ?? ''}`.trimEnd());
		const error =
			answer.status === 403 ? 'This key cannot pin notes: pinning is a write key’s.'
			: code === 'NO_SUCH_THOUGHT' ? 'The brain holds no thought with that id that this key can read.'
			: answer.status >= 500 ? `The brain could not pin the note${code ? ` (${code})` : ''}.`
			: `The brain refused the note${code ? ` (${code})` : ''}.`;
		return fail(answer.status, { ...kept, error });
	},
};
