import type { PageServerLoad } from './$types';
import { firstLine } from '$lib/format';
import { read } from '$lib/server/rest';
import type { ListThoughtsResult, ThoughtStats } from '$lib/types';

/** The newest thoughts the overview lists; browsing them all is the browse view's. */
const RECENT = 10;

// The overview: the brain's counts and its newest thoughts, two reads at once.
export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	const [stats, recent] = await Promise.all([
		read(event, session, 'thought_stats', {}) as Promise<ThoughtStats>,
		read(event, session, 'list_thoughts', { limit: RECENT }) as Promise<ListThoughtsResult>,
	]);
	// What the page shows of each, and no more: the page's data rides in the page,
	// and ten thoughts of megabytes each made an 18.8 MB overview whose loads
	// stalled the server (review pass 4).
	return {
		stats,
		recent: recent.thoughts.map((t) => ({ id: t.id, line: firstLine(t.content), created_at: t.created_at, superseded: t.supersededBy !== null })),
	};
};
