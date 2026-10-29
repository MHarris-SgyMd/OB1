import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import { oneLine } from '$lib/format';
import { codeOf, may, read, write } from '$lib/server/rest';
import { cookieOptions } from '$lib/server/session';
import { FLASH_MAX_AGE, notAnswered, notYours, workersCookie } from '$lib/server/writes';
import type { WorkerStatusResult } from '$lib/types';

// The worker queue (SMD-2280 PR 2b, SMD-2131): worker_status, one row per
// background-work pool (entity extraction, consolidation, re-embed) with its
// counts, its stale leases and whether it is the brain's active pool. Read
// whole: a pool is a handful of numbers. A session whose whoami named them may
// act on a pool (SMD-3322 PR 3): retry_failed requeues its failed rows, and
// release_stale_leases returns its stale leases — leases past their time, a
// stopped or stalled worker's — to the pool. A live lease is never released
// here (the CLI's include_live, which names its worker). Each logs an action
// row for each thought it touches, under the visitor's key. Then the page
// again, by a redirect, saying from a flash cookie what was done: a reload
// asks the page, not the action again, which would requeue rows that failed
// since and so run a row that always fails past its attempts (review pass 1).

/** What the flash cookie says (`<op>.<rows>.<pool, URI-encoded>`), read back into the page's words; null for anything else. */
function doneFrom(value: string): string | null {
	const [op, count, ...rest] = value.split('.');
	const n = Number(count);
	let pool: string;
	try {
		pool = oneLine(decodeURIComponent(rest.join('.')), 120);
	} catch {
		return null;
	}
	if (!Number.isInteger(n) || n < 0 || !pool) return null;
	const rows = (one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
	const them = n === 1 ? 'it' : 'them';
	if (op === 'retry') return n ? `Requeued ${rows('failed row', 'failed rows')} of ${pool}: the next worker pass takes ${them}.` : `${pool} held no failed row: nothing was requeued.`;
	if (op === 'release') return n ? `Returned ${rows('stale lease', 'stale leases')} of ${pool} to the pool: the next worker pass takes ${them}.` : `${pool} held no stale lease: nothing was released.`;
	return null;
}

export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	const flash = workersCookie(event.locals.sessionCookie);
	const said = event.cookies.get(flash);
	if (said !== undefined) event.cookies.delete(flash, cookieOptions(event.url, event.locals.breakglass));
	const v = (await read(event, session, 'worker_status', {})) as WorkerStatusResult;
	// A pool's name and a stale lease's worker are written by the workers: each on one line, cut.
	return {
		pools: v.pools.map((p) => ({ ...p, workType: oneLine(p.workType, 120), staleWorkerId: p.staleWorkerId === null ? null : oneLine(p.staleWorkerId, 80), key: p.workType })),
		canRetry: may(session, 'retry_failed'),
		canRelease: may(session, 'release_stale_leases'),
		done: said ? doneFrom(said) : null,
	};
};

/**
 * A pool's name as its form posts it back: the core's own, whole — not trimmed, since a worker may have written one
 * with spaces about it, and its pool is that name exactly (review pass 1). A name that is blank is no pool's.
 */
const workTypeOf = (form: FormData) => String(form.get('work_type') ?? '');

/** The page again, its flash cookie saying what the action did. */
function doneHere(event: RequestEvent, op: 'retry' | 'release', count: number, workType: string): never {
	event.cookies.set(workersCookie(event.locals.sessionCookie), `${op}.${count}.${encodeURIComponent(workType)}`, { ...cookieOptions(event.url, event.locals.breakglass), maxAge: FLASH_MAX_AGE });
	redirect(303, `${base}/workers`);
}

export const actions: Actions = {
	retry: async (event) => {
		const session = event.locals.session!;
		if (!may(session, 'retry_failed')) return fail(403, { error: notYours('retry') });
		const workType = workTypeOf(await event.request.formData());
		if (!workType.trim()) return fail(400, { error: 'Name the pool to retry: its form carries it.' });
		const answer = await write(event, session, 'retry_failed', { work_type: workType });
		if (answer.ok) doneHere(event, 'retry', (answer.body as { retried: number }).retried, workType);
		const code = codeOf(answer.body);
		if (answer.status >= 500) console.error(`[dashboard] retry_failed: ${answer.status} ${code ?? ''}`.trimEnd());
		return fail(answer.status, { error: notAnswered(code, 'retry') ?? (answer.status === 403 ? notYours('retry') : answer.status >= 500 ? `The brain could not retry the pool${code ? ` (${code})` : ''}.` : `The brain refused the retry${code ? ` (${code})` : ''}.`) });
	},
	release: async (event) => {
		const session = event.locals.session!;
		if (!may(session, 'release_stale_leases')) return fail(403, { error: notYours('release') });
		const workType = workTypeOf(await event.request.formData());
		if (!workType.trim()) return fail(400, { error: 'Name the pool whose stale leases to release: its form carries it.' });
		// Stale leases alone: no include_live, so a worker still running keeps what it holds.
		const answer = await write(event, session, 'release_stale_leases', { work_type: workType });
		if (answer.ok) doneHere(event, 'release', (answer.body as { released: number }).released, workType);
		const code = codeOf(answer.body);
		if (answer.status >= 500) console.error(`[dashboard] release_stale_leases: ${answer.status} ${code ?? ''}`.trimEnd());
		return fail(answer.status, { error: notAnswered(code, 'release') ?? (answer.status === 403 ? notYours('release') : answer.status >= 500 ? `The brain could not release the leases${code ? ` (${code})` : ''}.` : `The brain refused the release${code ? ` (${code})` : ''}.`) });
	},
};
