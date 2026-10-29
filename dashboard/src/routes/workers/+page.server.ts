import type { PageServerLoad } from './$types';
import { oneLine } from '$lib/format';
import { read } from '$lib/server/rest';
import type { WorkerStatusResult } from '$lib/types';

// The worker queue (SMD-2280 PR 2b, SMD-2131): worker_status, one row per
// background-work pool (entity extraction, consolidation, re-embed) with its
// counts, its stale leases and whether it is the brain's active pool. Read
// whole: a pool is a handful of numbers. Retrying a pool's failures is a write,
// the CLI's today; SMD-3322 brings it here.
export const load: PageServerLoad = async (event) => {
	const v = (await read(event, event.locals.session!, 'worker_status', {})) as WorkerStatusResult;
	// A pool's name and a stale lease's worker are written by the workers: each on one line, cut.
	return { pools: v.pools.map((p) => ({ ...p, workType: oneLine(p.workType, 120), staleWorkerId: p.staleWorkerId === null ? null : oneLine(p.staleWorkerId, 80) })) };
};
