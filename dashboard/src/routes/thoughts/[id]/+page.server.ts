import type { PageServerLoad } from './$types';
import { read } from '$lib/server/rest';
import type { FetchedThought } from '$lib/types';

// Rendered on the server alone: with the client's script, the text rode in the
// page twice — its markup and the data that hydrates it — 24 MB for a 12 MB
// thought (review pass 4). Nothing on it needs a script.
export const csr = false;

// One thought, by its id, through the core's `fetch`: its text and every
// metadata field. An id the brain does not hold is the core's 404. Opening it
// counts as `fetch` always has — a click-through the core logs against the
// visitor's key (migration 034).
export const load: PageServerLoad = async (event) => {
	const thought = (await read(event, event.locals.session!, 'fetch', { id: event.params.id })) as FetchedThought;
	return { thought };
};
