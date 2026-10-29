import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { oneLine } from '$lib/format';
import { codeOf, may, read, write } from '$lib/server/rest';
import { notAnswered, notYours } from '$lib/server/writes';
import type { WorkerStatusResult } from '$lib/types';

// The worker queue (SMD-2280 PR 2b, SMD-2131): worker_status, one row per
// background-work pool (entity extraction, consolidation, re-embed) with its
// counts, its stale leases and whether it is the brain's active pool. Read
// whole: a pool is a handful of numbers. A session whose whoami named them may
// act on a pool (SMD-3322 PR 3): retry_failed requeues its failed rows, and
// release_stale_leases returns its stale leases — a stopped worker's — to the
// pool. A live lease is never released here (the CLI's include_live, which
// names its worker). Each logs an action row per thought it touches, under the
// visitor's key, and the page says what it did; both are idempotent, so a
// repeated post does nothing more.
export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	const v = (await read(event, session, 'worker_status', {})) as WorkerStatusResult;
	// A pool's name and a stale lease's worker are written by the workers: each on one line, cut.
	return {
		pools: v.pools.map((p) => ({ ...p, workType: oneLine(p.workType, 120), staleWorkerId: p.staleWorkerId === null ? null : oneLine(p.staleWorkerId, 80), key: p.workType })),
		canRetry: may(session, 'retry_failed'),
		canRelease: may(session, 'release_stale_leases'),
	};
};

/** A pool's name as a form posts it back: the core's own, which the page carries whole in a hidden field. */
const workTypeOf = (form: FormData) => String(form.get('work_type') ?? '').trim();
const rows = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export const actions: Actions = {
	retry: async (event) => {
		const session = event.locals.session!;
		if (!may(session, 'retry_failed')) return fail(403, { error: notYours('retry') });
		const workType = workTypeOf(await event.request.formData());
		if (!workType) return fail(400, { error: 'Name the pool to retry: its form carries it.' });
		const answer = await write(event, session, 'retry_failed', { work_type: workType });
		if (answer.ok) {
			const { retried } = answer.body as { retried: number };
			return { done: retried ? `Requeued ${rows(retried, 'failed row', 'failed rows')} of ${oneLine(workType, 120)}: the next worker pass takes ${retried === 1 ? 'it' : 'them'}.` : `${oneLine(workType, 120)} held no failed row: nothing was requeued.` };
		}
		const code = codeOf(answer.body);
		if (answer.status >= 500) console.error(`[dashboard] retry_failed: ${answer.status} ${code ?? ''}`.trimEnd());
		return fail(answer.status, { error: notAnswered(code, 'retry') ?? (answer.status === 403 ? notYours('retry') : answer.status >= 500 ? `The brain could not retry the pool${code ? ` (${code})` : ''}.` : `The brain refused the retry${code ? ` (${code})` : ''}.`) });
	},
	release: async (event) => {
		const session = event.locals.session!;
		if (!may(session, 'release_stale_leases')) return fail(403, { error: notYours('release') });
		const workType = workTypeOf(await event.request.formData());
		if (!workType) return fail(400, { error: 'Name the pool whose stale leases to release: its form carries it.' });
		// Stale leases alone: no include_live, so a worker still running keeps what it holds.
		const answer = await write(event, session, 'release_stale_leases', { work_type: workType });
		if (answer.ok) {
			const { released } = answer.body as { released: number };
			return { done: released ? `Returned ${rows(released, 'stale lease', 'stale leases')} of ${oneLine(workType, 120)} to the pool: the next worker pass takes ${released === 1 ? 'it' : 'them'}.` : `${oneLine(workType, 120)} held no stale lease: nothing was released.` };
		}
		const code = codeOf(answer.body);
		if (answer.status >= 500) console.error(`[dashboard] release_stale_leases: ${answer.status} ${code ?? ''}`.trimEnd());
		return fail(answer.status, { error: notAnswered(code, 'release') ?? (answer.status === 403 ? notYours('release') : answer.status >= 500 ? `The brain could not release the leases${code ? ` (${code})` : ''}.` : `The brain refused the release${code ? ` (${code})` : ''}.`) });
	},
};
