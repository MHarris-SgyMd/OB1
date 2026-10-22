import type { PageServerLoad } from './$types';
import { read } from '$lib/server/rest';
import type { BrainInfo } from '$lib/types';
import { brainInfoRows } from '../../../../server-portable/brain-info.ts';

// What this brain is (SMD-2041): the server's version, commit and migrations
// beside the database's facts — the ledger, the sizes, the workers'
// heartbeats, the proposal queue — one read, the core's brain_info, which the
// keyed /health body carries too. Laid out as the core's own rows, so each
// judgement (the ledger current or behind, a worker waiting for the provider,
// what is pending and what is stale, a size) is worded once, as the brain_info
// tool words it: the page's own wording drifted from it on six facts (review
// pass 4).
export const load: PageServerLoad = async (event) => {
	const info = (await read(event, event.locals.session!, 'brain_info', {})) as BrainInfo;
	return { rows: brainInfoRows(info) };
};
