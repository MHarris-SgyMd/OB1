import type { PageServerLoad } from './$types';
import { base } from '$app/paths';
import { oneLine } from '$lib/format';
import { addressOf, textIn, wholeIn } from '$lib/params';
import { read } from '$lib/server/rest';
import type { ChangesResult } from '$lib/types';
import { SAID_BY } from '../../../../server-portable/core/filter.ts';

/** The kinds of change thought_changes takes. */
const ACTIONS = ['capture', 'update', 'delete'] as const;
type Action = (typeof ACTIONS)[number];
const DEFAULT_LIMIT = 50;
/** How many of one edit's metadata keys the page names: any write key writes metadata, and one edit can move thousands. */
const KEYS_SHOWN = 20;
/** A field the core records on a content edit that the tool never names: content's own hash. */
const UNNAMED = new Set(['content_fingerprint']);
/** A page cursor: the audit row a previous page ended with (the core's `since` takes one, parseSince). */
const CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The change feed (SMD-2280 PR 2b): thought_changes, every capture, edit and
// deletion oldest first, with who made it. With no start it is the most recent
// changes; from a time or a date it pages forward with no repeats. The address
// holds the filters, the start (`since`, a time the visitor typed) and the
// place (`after`, the cursor Next carries, kept out of the form so a new filter
// starts again: review pass 1). The fields are the core's own (AuditChange):
// the tool's words for an edit's kind (marked, re-captured, reset) are
// render.ts's, which the GUI does not import.
export const load: PageServerLoad = async (event) => {
	const params = event.url.searchParams;
	const after = params.get('after') ?? '';
	const q = {
		// A time with its zone or a date; the core refuses another (REFUSED_SINCE, rest.ts's words).
		since: textIn(params, 'since', 100),
		// The cursor of the page before, carried by Next alone; one of the wrong shape starts again.
		after: CURSOR.test(after) ? after.toLowerCase() : undefined,
		others_only: params.get('others_only') === '1',
		// A key's name: the core's actor bound.
		agent: textIn(params, 'agent', 200),
		actions: [...new Set(params.getAll('action'))].filter((a): a is Action => (ACTIONS as readonly string[]).includes(a)),
		limit: wholeIn(params, 'limit', 1, 200, DEFAULT_LIMIT),
	};
	const start = q.after ?? q.since;
	const v = (await read(event, event.locals.session!, 'thought_changes', {
		limit: q.limit,
		others_only: q.others_only,
		...(start ? { since: start } : {}),
		...(q.agent ? { agent: q.agent } : {}),
		...(q.actions.length ? { actions: q.actions } : {}),
	})) as ChangesResult;
	const path = `${base}/changes`;
	const kept = { others_only: q.others_only, agent: q.agent, action: q.actions, limit: q.limit };
	// Next keeps the typed start beside the cursor (the cursor wins, `start` above), so the form still shows it and a
	// new filter after Next starts from it, not from the newest (review pass 2).
	return {
		q,
		filtered: q.others_only || q.agent !== undefined || q.actions.length > 0,
		// Each change as the page shows it, and no more: the core's fields, its text one line.
		changes: v.changes.map((c) => {
			const keys = c.metadataKeys.map((k) => oneLine(k, 40));
			return {
				id: c.id,
				at: c.createdAt,
				action: c.action,
				// Name and door are untrusted text (render.ts's renderChange): a key by name and its kind's word; no key but
				// a door, by the door; neither, from outside the server.
				who:
					c.actorName !== null
						? `by ${oneLine(c.actorName, 80)}${c.actorKind && (SAID_BY as readonly string[]).includes(c.actorKind) ? ` (${c.actorKind})` : ''}`
						: c.origin !== null
							? `by ${oneLine(c.origin, 80)} (no key)`
							: 'from outside the server',
				thoughtId: c.thoughtId,
				present: c.present,
				// A capture row's text is the thought's current one; a delete's, what it held (render.ts's renderChange).
				text: c.head === null ? null : oneLine(c.head, 160),
				changed: c.changed.filter((f) => !UNNAMED.has(f)),
				metadataKeys: keys.slice(0, KEYS_SHOWN),
				metadataMore: Math.max(keys.length - KEYS_SHOWN, 0),
				supersedesBefore: c.supersedesBefore,
				supersedesAfter: c.supersedesAfter,
				derivation: c.derivation,
			};
		}),
		more: v.more,
		bounded: v.bounded,
		// Forward from the page's last change, with the same filters; the newest again, with none.
		next: v.more && v.bounded && v.cursor ? addressOf(path, { since: q.since, after: v.cursor, ...kept }, { limit: DEFAULT_LIMIT }) : null,
		newest: start ? addressOf(path, kept, { limit: DEFAULT_LIMIT }) : null,
	};
};
