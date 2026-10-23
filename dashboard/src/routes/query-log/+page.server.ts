import type { PageServerLoad } from './$types';
import { oneLine } from '$lib/format';
import { textIn, wholeIn } from '$lib/params';
import { read } from '$lib/server/rest';
import type { LoggedSearchPage } from '$lib/types';

// The query log (SMD-2280 PR 2b): list_logged_searches, the brain's logged
// searches from query_log — each query, the arm that ran it and its arguments,
// most recent first, from `since`. query_log is opt-in (OB1_QUERY_LOG): empty
// where it was never on. No thought content: the queries are what the keys
// searched, every key's, as the tool shows them to any key that can read.
export const load: PageServerLoad = async (event) => {
	const params = event.url.searchParams;
	// An ISO-8601 time; the core refuses another (REFUSED_SINCE, rest.ts's words).
	const q = { since: textIn(params, 'since', 100), limit: wholeIn(params, 'limit', 1, 1000, 50) };
	const v = (await read(event, event.locals.session!, 'list_logged_searches', { limit: q.limit, ...(q.since ? { since: q.since } : {}) })) as LoggedSearchPage;
	return {
		q,
		// Each search on one line: a query, a tier and a filter are what a key sent.
		searches: v.searches.map((s) => ({
			at: s.loggedAt,
			arm: s.arm,
			tier: s.tier === null ? null : oneLine(s.tier, 40),
			query: oneLine(s.query, 200),
			matches: s.matchCount,
			threshold: s.threshold,
			recencyWeight: s.recencyWeight,
			filter: Object.keys(s.filter ?? {}).length ? oneLine(JSON.stringify(s.filter), 120) : null,
		})),
		truncated: v.truncated,
	};
};
