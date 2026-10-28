import type { PageServerLoad } from './$types';
import { base } from '$app/paths';
import { listInput, pageLinks, readBrowse } from '$lib/browse';
import { firstLine, shortWord } from '$lib/format';
import { read } from '$lib/server/rest';
import type { ListThoughtsResult } from '$lib/types';

// Browse (SMD-2280 PR 2a): every thought a page at a time, through the core's
// list_thoughts keyset (SMD-2995) — newest or oldest first, by its filters —
// the address holding the page's place, so Next, Previous and the browser's
// Back are links. One read a page; a cursor the core refuses is its 400, in
// words (rest.ts).
/** A thought id's shape, for the `deleted` the delete page sends here (SMD-3322): anything else is not said back. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const load: PageServerLoad = async (event) => {
	const q = readBrowse(event.url.searchParams);
	const deleted = event.url.searchParams.get('deleted') ?? '';
	const page = (await read(event, event.locals.session!, 'list_thoughts', listInput(q))) as ListThoughtsResult;
	return {
		q,
		// Each thought as the list shows it, and no more: its text rides in the page (the overview's lesson, review pass 4).
		thoughts: page.thoughts.map((t) => ({
			id: t.id,
			line: firstLine(t.content),
			created_at: t.created_at,
			superseded: t.supersededBy !== null,
			type: shortWord(t.metadata.type),
			trust: shortWord(t.metadata.trust),
		})),
		links: pageLinks(`${base}/thoughts`, q, page.cursor),
		deleted: ID.test(deleted) ? deleted.toLowerCase() : null,
	};
};
