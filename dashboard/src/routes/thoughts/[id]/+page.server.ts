import type { PageServerLoad } from './$types';
import { read } from '$lib/server/rest';
import type { FetchedThought } from '$lib/types';

// One thought, by its id, through the core's `fetch`: its text and every
// metadata field. An id the brain does not hold is the core's 404. Opening it
// counts as `fetch` always has — a click-through the core logs against the
// visitor's key (migration 034).
export const load: PageServerLoad = async (event) => {
	const thought = (await read(event, event.locals.session!, 'fetch', { id: event.params.id })) as FetchedThought;
	return { thought };
};
