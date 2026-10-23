import type { PageServerLoad } from './$types';
import { base } from '$app/paths';
import { oneLine } from '$lib/format';
import { addressOf, textIn, wholeIn } from '$lib/params';
import { read } from '$lib/server/rest';
import type { ChangesResult } from '$lib/types';

/** The kinds of change thought_changes takes. */
const ACTIONS = ['capture', 'update', 'delete'] as const;
type Action = (typeof ACTIONS)[number];
const DEFAULT_LIMIT = 50;

// The change feed (SMD-2280 PR 2b): thought_changes, every capture, edit and
// deletion oldest first, with who made it. With no `since` it is the most
// recent changes; from a time, a date or the cursor a page ended with, it
// pages forward with no repeats. The address holds the filters and the start,
// so Next is a link. The fields are the core's own (AuditChange): the tool's
// words for an edit's kind (marked, re-captured, reset) are render.ts's, which
// the GUI does not import.
export const load: PageServerLoad = async (event) => {
	const params = event.url.searchParams;
	const q = {
		// A time with its zone, a date, or a page's cursor; the core refuses another (REFUSED_SINCE, rest.ts's words).
		since: textIn(params, 'since', 100),
		others_only: params.get('others_only') === '1',
		// A key's name: the core's actor bound.
		agent: textIn(params, 'agent', 200),
		actions: [...new Set(params.getAll('action'))].filter((a): a is Action => (ACTIONS as readonly string[]).includes(a)),
		limit: wholeIn(params, 'limit', 1, 200, DEFAULT_LIMIT),
	};
	const v = (await read(event, event.locals.session!, 'thought_changes', {
		limit: q.limit,
		others_only: q.others_only,
		...(q.since ? { since: q.since } : {}),
		...(q.agent ? { agent: q.agent } : {}),
		...(q.actions.length ? { actions: q.actions } : {}),
	})) as ChangesResult;
	const path = `${base}/changes`;
	const kept = { others_only: q.others_only, agent: q.agent, action: q.actions, limit: q.limit };
	return {
		q,
		// Each change as the page shows it, and no more: the core's fields, its text one line.
		changes: v.changes.map((c) => ({
			id: c.id,
			at: c.createdAt,
			action: c.action,
			who: c.actorName,
			kind: c.actorKind,
			thoughtId: c.thoughtId,
			present: c.present,
			// A capture row's text is the thought's current one; a delete's, what it held (render.ts's renderChange).
			text: c.head === null ? null : oneLine(c.head, 160),
			changed: c.changed,
			metadataKeys: c.metadataKeys.map((k) => oneLine(k, 40)),
			supersedesBefore: c.supersedesBefore,
			supersedesAfter: c.supersedesAfter,
			derivation: c.derivation,
		})),
		more: v.more,
		bounded: v.bounded,
		// Forward from the page's last change, with the same filters; the newest again, with none.
		next: v.more && v.bounded && v.cursor ? addressOf(path, { since: v.cursor, ...kept }, { limit: DEFAULT_LIMIT }) : null,
		newest: q.since ? addressOf(path, kept, { limit: DEFAULT_LIMIT }) : null,
	};
};
