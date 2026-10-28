import type { PageServerLoad } from './$types';
import { may, read } from '$lib/server/rest';
import { cookieOptions } from '$lib/server/session';
import { capturedCookie } from '$lib/server/writes';
import type { FetchedThought } from '$lib/types';

// Rendered on the server alone: with the client's script, the text rode in the
// page twice — its markup and the data that hydrates it — 24 MB for a 12 MB
// thought (review pass 4). Nothing on it needs a script.
export const csr = false;

// One thought, by its id, through the core's `fetch`: its text and every
// metadata field. An id the brain does not hold is the core's 404. Opening it
// counts as `fetch` always has — a click-through the core logs against the
// visitor's key (migration 034). Its edit and delete pages are offered where
// the session's whoami named their operations, and a capture the capture page
// just made is said from its flash cookie, once (SMD-3322).
export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	const thought = (await read(event, session, 'fetch', { id: event.params.id })) as FetchedThought;
	const flash = capturedCookie(event.locals.sessionCookie);
	const [capturedId, kind, vector] = (event.cookies.get(flash) ?? '').split('.');
	if (capturedId) event.cookies.delete(flash, cookieOptions(event.url, event.locals.breakglass));
	const captured = capturedId === thought.id && (kind === 'new' || kind === 'existed') ? { existed: kind === 'existed', noVector: vector === 'novector' } : null;
	return { thought, canEdit: may(session, 'update_thought'), canDelete: may(session, 'delete_thought'), captured };
};
