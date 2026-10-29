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
		pools: v.pools.map((p) => ({ ...p, workType: oneLine(p.workType, 120), staleWorkerId: p.staleWorkerId === null ? null : oneLine(p.staleWorkerId, 80), name: p.workType })),
		canRetry: may(session, 'retry_failed'),
		canRelease: may(session, 'release_stale_leases'),
		done: said ? doneFrom(said) : null,
	};
};

/**
 * Each action's operation, the answer field that counts what it moved, and its words: the two act alike, and differ in
 * these alone. Release sends no include_live, so a worker still running keeps what it holds.
 */
const ACTS = {
	retry: { tool: 'retry_failed', moved: 'retried', unnamed: 'Name the pool to retry: its form carries it.', fault: 'retry the pool', refused: 'retry' },
	release: { tool: 'release_stale_leases', moved: 'released', unnamed: 'Name the pool whose stale leases to release: its form carries it.', fault: 'release the leases', refused: 'release' },
} as const;

/**
 * One action on the pool its form names: the pool's name as the form posts it back, the core's own, whole — not
 * trimmed, since a worker may have written one with spaces about it, and its pool is that name exactly (review pass
 * 1); a blank one is no pool's. Done, the page again, its flash cookie saying what moved.
 */
async function act(event: RequestEvent, op: keyof typeof ACTS) {
	const { tool, moved, unnamed, fault, refused } = ACTS[op];
	const session = event.locals.session!;
	if (!may(session, tool)) return fail(403, { error: notYours(op) });
	const workType = String((await event.request.formData()).get('work_type') ?? '');
	if (!workType.trim()) return fail(400, { error: unnamed });
	const answer = await write(event, session, tool, { work_type: workType });
	if (answer.ok) {
		const count = (answer.body as Record<string, number>)[moved];
		event.cookies.set(workersCookie(event.locals.sessionCookie), `${op}.${count}.${encodeURIComponent(workType)}`, { ...cookieOptions(event.url, event.locals.breakglass), maxAge: FLASH_MAX_AGE });
		redirect(303, `${base}/workers`);
	}
	const code = codeOf(answer.body);
	if (answer.status >= 500) console.error(`[dashboard] ${tool}: ${answer.status} ${code ?? ''}`.trimEnd());
	return fail(answer.status, {
		error: notAnswered(code, op) ?? (answer.status === 403 ? notYours(op) : answer.status >= 500 ? `The brain could not ${fault}${code ? ` (${code})` : ''}.` : `The brain refused the ${refused}${code ? ` (${code})` : ''}.`),
	});
}

export const actions: Actions = {
	retry: (event) => act(event, 'retry'),
	release: (event) => act(event, 'release'),
};
