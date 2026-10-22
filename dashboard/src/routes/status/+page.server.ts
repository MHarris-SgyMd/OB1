import type { PageServerLoad } from './$types';
import { read } from '$lib/server/rest';
import type { BrainInfo } from '$lib/types';

// What this brain is (SMD-2041): the server's version, commit and migrations
// beside the database's facts — the ledger, the sizes, the workers'
// heartbeats, the proposal queue — one read, the core's brain_info, which the
// keyed /health body carries too.
export const load: PageServerLoad = async (event) => {
	const info = (await read(event, event.locals.session!, 'brain_info', {})) as BrainInfo;
	return { info };
};
