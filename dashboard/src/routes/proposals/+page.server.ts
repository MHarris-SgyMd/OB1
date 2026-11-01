import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { base } from '$app/paths';
import { firstLine, oneLine } from '$lib/format';
import { addressOf, wholeIn, wordIn, wordOf } from '$lib/params';
import { codeOf, may, read, write } from '$lib/server/rest';
import { cookieOptions } from '$lib/server/session';
import { FLASH_MAX_AGE, notAnswered, notYours, proposalsCookie, THOUGHT_ID } from '$lib/server/writes';
import type { ProposalsResult } from '$lib/types';
import { SAID_BY, TRUST } from '../../../../server-portable/core/filter.ts';

const STATUSES = ['pending', 'accepted', 'rejected', 'stale', 'all'] as const;
/** Lineage, as the core's three-way `lineage`: every pair, only lineage pairs, or none of them. */
const LINEAGE = ['any', 'only', 'none'] as const;
/** The page's filters' defaults, which its address leaves out. */
const DEFAULTS = { status: 'pending', lineage: 'any', limit: 25 } as const;

/** The verdict in the tool's words (render.ts's renderSupersessionProposals). */
const VERDICT = {
	newer_supersedes_older: 'the newer thought supersedes the older',
	older_supersedes_newer: 'the older thought supersedes the newer',
	conflict_undirected: 'one is out of date, which not stated',
} as const;

/**
 * The page's filters, read from its address — a decision's too: its form posts to `?/<action>&<filters>`, so the load
 * that runs after a refused decision lists the rows the visitor was deciding among, the refused one with its words
 * beside it (a form posting to `?/<action>` alone came back to the pending list, without the row), and the redirect
 * after a decision lands on them.
 */
const filtersOf = (params: URLSearchParams) => ({
	status: wordIn(params, 'status', STATUSES, DEFAULTS.status),
	lineage: wordIn(params, 'lineage', LINEAGE, DEFAULTS.lineage),
	limit: wholeIn(params, 'limit', 1, 200, DEFAULTS.limit),
});

// Supersession proposals (SMD-2280 PR 2b): the pairs the consolidation pass
// judged one to outdate or duplicate the other, most confident first, with its
// verdict, its reason and both thoughts as they are now. A session whose
// whoami names review_supersession_proposal (SMD-3338) decides one here
// (SMD-3322 PR 4): accept, or reject — the core's one decision, with the CLI's
// writer and lineage guards, under the visitor's credential. Then the page
// again, by a redirect, saying from a flash cookie what the decision did, as
// the workers page does: a reload asks the page, not the decision again. The
// page reads the most confident `limit`; the core's cursor (`after`, SMD-3249)
// is not followed here yet.

/**
 * What the flash cookie says, read back into the page's words; null for anything else.
 * `accept.<id>.<written 1|0>.<lapsed>` or `reject.<id>.<plain|cleared|held|moved|again>`.
 */
function doneFrom(value: string): string | null {
	const [op, id, a, b] = value.split('.');
	if (!THOUGHT_ID.test(id ?? '')) return null;
	if (op === 'accept') {
		const lapsed = Number(b);
		if ((a !== '1' && a !== '0') || !Number.isInteger(lapsed) || lapsed < 0) return null;
		const them = lapsed === 1 ? 'a capture-only pointer' : `${lapsed.toLocaleString('en-US')} capture-only pointers`;
		return `Accepted proposal ${id}: the side it names now supersedes the other${a === '1' ? '' : ' (the pointer was already there, and a reject will leave it)'}.` +
			(lapsed ? ` It also cleared ${them} onto the side that stands, which a reject does not restore.` : '');
	}
	if (op === 'reject') {
		const said: Record<string, string> = {
			plain: `Rejected proposal ${id}.`,
			cleared: `Rejected proposal ${id}, which was accepted: the pointer its accept wrote is cleared. A capture-only pointer that accept cleared stays cleared.`,
			held: `Rejected proposal ${id}, which was accepted: its pointer was there before the accept, so it stays.`,
			moved: `Rejected proposal ${id}, which was accepted: its pointer was changed since, so there was nothing of the accept’s to clear.`,
			again: `Rejected proposal ${id} again: this decision, its note and its reviewer replace the earlier reject’s.`,
		};
		return said[a ?? ''] ?? null;
	}
	return null;
}

export const load: PageServerLoad = async (event) => {
	const session = event.locals.session!;
	const flash = proposalsCookie(event.locals.sessionCookie);
	const said = event.cookies.get(flash);
	if (said !== undefined) event.cookies.delete(flash, cookieOptions(event.url, event.locals.breakglass));
	const q = filtersOf(event.url.searchParams);
	const v = (await read(event, session, 'list_supersession_proposals', {
		status: q.status,
		limit: q.limit,
		...(q.lineage === 'any' ? {} : { lineage: q.lineage === 'only' }),
	})) as ProposalsResult;
	// Each side as the page shows it: its first line, its writer's marks (any write key writes them), what supersedes it.
	const side = (s: ProposalsResult['proposals'][number]['newer']) => ({
		id: s.id,
		line: firstLine(s.content),
		created_at: s.created_at,
		edited: s.edited,
		writer: s.writer && { name: s.writer.name === null ? null : oneLine(s.writer.name, 80), kind: wordOf(SAID_BY, s.writer.kind), trust: wordOf(TRUST, s.writer.trust), captureOnly: s.writer.captureOnly },
		supersededBy: s.supersededBy,
	});
	return {
		q,
		canReview: may(session, 'review_supersession_proposal'),
		done: said ? doneFrom(said) : null,
		// SMD-3338: false when a decided row was listed on a brain short of 114, which records no reviewer; absent from a core before it.
		reviewersRead: v.reviewersRead !== false,
		proposals: v.proposals.map((p) => ({
			id: p.id,
			status: p.status,
			verdict: VERDICT[p.verdict] ?? p.verdict,
			// An accept of an undirected verdict names the side that stands: a button for each.
			undirected: p.verdict === 'conflict_undirected',
			confidence: p.confidence,
			// The judge reads both thoughts' text, which can steer it: its reason and the review note are one line each.
			reason: p.reason === null ? null : oneLine(p.reason, 300),
			judgeKey: oneLine(p.judgeKey, 120),
			judgedAt: p.judgedAt,
			reviewedAt: p.reviewedAt,
			reviewNote: p.reviewNote === null ? null : oneLine(p.reviewNote, 300),
			// SMD-3338: who decided an accepted or rejected row — a key's name on one line, its kinds held to the words.
			reviewer: p.reviewer ? { name: p.reviewer.name ? oneLine(p.reviewer.name, 80) : null, agentRecorded: p.reviewer.agentRecorded, kind: wordOf(SAID_BY, p.reviewer.kind), kindNow: wordOf(SAID_BY, p.reviewer.kindNow) } : null,
			// While accepted: the side whose supersedes column the acceptance wrote.
			stands: p.status === 'accepted' && p.supersedingId ? (p.supersedingId === p.newer.id ? 'newer' : p.supersedingId === p.older.id ? 'older' : null) : null,
			lineage: p.lineage,
			newer: side(p.newer),
			older: side(p.older),
		})),
	};
};

/** The refusals `force` waives on an accept (SMD-3338): the page offers "Accept anyway" after one. */
const FORCEABLE = new Set(['REFUSED_EDITED_SINCE', 'REFUSED_LINEAGE_PAIR', 'REFUSED_WRITER']);

/** A refusal of the core's in the page's words, by its code and the facts beside it (the tool's, in render.ts, said for a page). */
function refusedWords(code: string | undefined, facts: Record<string, unknown>, decision: 'accept' | 'reject'): string | undefined {
	const stays = facts.status === 'rejected' ? 'Left as it is, it stays rejected, the expected decision' : 'Rejecting it is the expected decision';
	switch (code) {
		case 'NOT_FOUND': return 'No such proposal: it may have gone with one of its thoughts. The list below is current.';
		case 'REFUSED_EDITED_SINCE': return 'A thought was edited since this pair was judged (a stale proposal’s was), so the verdict is about a text that is gone. Read both; accept anyway if it still holds, or reject it.';
		case 'REFUSED_LINEAGE_PAIR': return `One side derives from the other (a lineage pair): accepting writes the pointer while the derivation still names its input, which search then treats as superseded. ${stays}; accept anyway only if that is what you mean.`;
		case 'REFUSED_WRITER': return `The side that would stand is a capture-only key’s text, or of a lower trust than the other (the WRITER flag). Read both writers; accept anyway if it should stand${facts.status === 'rejected' ? '; left as it is, it stays rejected' : ', or reject it'}.`;
		case 'REFUSED_DIRECTION_REQUIRED': return 'The judge did not say which thought is current: accept with the side that stands.';
		case 'REFUSED_ALREADY_ACCEPTED': return 'This proposal is already accepted. A reject first clears its pointer if it still holds this proposal’s value; then it can be accepted again.';
		case 'REFUSED_ALREADY_SUPERSEDES': return 'The side that would stand already supersedes a third thought, and a thought holds one predecessor: edit that thought’s pointer, or reject this proposal.';
		case 'REFUSED_PROPOSAL_WOULD_CYCLE': return facts.chainTooLong === true
			? 'The chain of supersedes pointers here is longer than the brain walks, so whether this pointer would close a loop cannot be told. Reject this proposal, or shorten the chain first.'
			: 'Writing this pointer would close a loop of supersedes pointers. Reject this proposal, or clear the other pointer first.';
		case 'REFUSED_SUPERSEDED_GONE': return 'The thought to be superseded no longer exists: reject this proposal.';
		case 'REFUSED_REVIEW_ARGUMENT': return facts.problem === 'note_marker'
			? 'A note may not begin with “settled by the pass:” — that marker is the consolidation pass’s own.'
			: `The brain refused the ${decision}’s arguments (${String(facts.problem ?? code)}).`;
		default: return undefined;
	}
}

/**
 * One decision on the proposal its form names, under the visitor's credential: an accept with the side that stands
 * (an undirected verdict's button names it) and force where the page offered "Accept anyway", or a reject; a note with
 * either. Done, the page again under the filters the form carried, its flash cookie saying what the decision did.
 */
/** What a decision that did not land hands the page: the proposal it named (null for none), what it posted, whether force would waive it, and its words — one shape, so the page reads each. */
type Refused = { id: string | null; direction: 'newer' | 'older' | null; note: string; forceable: boolean; error: string };
const refused = (status: number, r: Partial<Refused> & { error: string }) => fail(status, { id: null, direction: null, note: '', forceable: false, ...r } satisfies Refused);

async function decide(event: RequestEvent, decision: 'accept' | 'reject') {
	const session = event.locals.session!;
	if (!may(session, 'review_supersession_proposal')) return refused(403, { error: notYours(decision) });
	const form = await event.request.formData();
	const field = (name: string) => String(form.get(name) ?? '');
	const back = filtersOf(event.url.searchParams);
	const id = field('id');
	if (!THOUGHT_ID.test(id)) return refused(400, { error: 'Name the proposal to decide: its form carries it.' });
	const direction = decision === 'accept' ? (wordOf(['newer', 'older'], field('direction')) as 'newer' | 'older' | null) : null;
	// As typed, NUL out (no Postgres text holds one); the core trims it and holds it to 2,000 characters.
	const note = field('note').replaceAll('\0', '').trim();
	if (note.length > 2000) return refused(400, { id, direction, note, error: `A note is at most 2,000 characters; this one is ${note.length.toLocaleString('en-US')}.` });
	const force = decision === 'accept' && field('force') === '1';
	const answer = await write(event, session, 'review_supersession_proposal', {
		id,
		decision,
		...(direction ? { direction } : {}),
		...(note ? { note } : {}),
		...(force ? { force: true } : {}),
	});
	if (answer.ok) {
		const v = answer.body as { written?: boolean | null; lapsed?: unknown[]; cleared?: boolean | null; previousStatus?: string; previousPointerWritten?: boolean | null };
		const facts = decision === 'accept'
			? `${v.written === false ? 0 : 1}.${Array.isArray(v.lapsed) ? v.lapsed.length : 0}`
			: v.previousStatus === 'accepted' ? (v.cleared ? 'cleared' : v.previousPointerWritten === false ? 'held' : 'moved') : v.previousStatus === 'rejected' ? 'again' : 'plain';
		event.cookies.set(proposalsCookie(event.locals.sessionCookie), `${decision}.${id}.${facts}`, { ...cookieOptions(event.url, event.locals.breakglass), maxAge: FLASH_MAX_AGE });
		redirect(303, addressOf(`${base}/proposals`, back, DEFAULTS));
	}
	const code = codeOf(answer.body);
	const facts = (answer.body ?? {}) as Record<string, unknown>;
	if (answer.status >= 500) console.error(`[dashboard] review_supersession_proposal: ${answer.status} ${code ?? ''}`.trimEnd());
	return refused(answer.status, {
		id,
		direction,
		note,
		// The page offers "Accept anyway" after a refusal force waives, on an accept not already forced.
		forceable: decision === 'accept' && !force && FORCEABLE.has(code ?? ''),
		error: notAnswered(code, decision) ?? refusedWords(code, facts, decision) ?? (answer.status === 403 ? notYours(decision) : answer.status >= 500 ? `The brain could not ${decision} the proposal${code ? ` (${code})` : ''}.` : `The brain refused the ${decision}${code ? ` (${code})` : ''}.`),
	});
}

export const actions: Actions = {
	accept: (event) => decide(event, 'accept'),
	reject: (event) => decide(event, 'reject'),
};
