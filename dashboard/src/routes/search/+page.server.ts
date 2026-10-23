import type { PageServerLoad } from './$types';
import { base } from '$app/paths';
import { firstLine } from '$lib/format';
import { OFFSET_MAX, readSearch, searchAddress, type ListedHit } from '$lib/search';
import { read } from '$lib/server/rest';
import type { KeywordResult, SearchThoughtsResult } from '$lib/types';
import { movedWords, typesOf } from '../../../../server-portable/stated-status.ts';

/** A word any write key writes, as the list shows it: cut as a first line is. */
const word = (v: unknown) => (typeof v === 'string' ? firstLine(v, 40) : null);

// Search (SMD-2280 PR 2a): by meaning through search_thoughts — a fixed top N,
// identifier-shaped words and quoted spans matched exactly among them — or by
// exact text through search_thoughts_keyword, a page at a time. The query and
// mode are the address; both reads are POSTs, so the query reaches the core in
// a body. With no query nothing is read: a search is a logged act (query_log,
// when the operator has it on), the visitor's own.
export const load: PageServerLoad = async (event) => {
	const s = readSearch(event.url.searchParams);
	const form = { query: s.query, mode: s.mode, limit: s.limit };
	if (s.query === '') return { form, hits: null, vectorless: null, total: null, offset: 0, links: null };

	const session = event.locals.session!;
	if (s.mode === 'meaning') {
		const r = (await read(event, session, 'search_thoughts', { query: s.query, limit: s.limit })) as SearchThoughtsResult;
		const hits: ListedHit[] = r.hits.map((h) => ({
			id: h.id,
			line: firstLine(h.content),
			created_at: h.created_at,
			superseded: h.supersededBy !== null,
			trust: word(h.metadata.trust),
			// Null for a hit found by an exact identifier or quoted span, or without a vector at all (SMD-2891): the page says exact match.
			score: h.matchedNeedles.length > 0 || h.similarity === null ? null : Math.round(h.similarity * 100) / 100,
			moved: h.moved && h.moved.length ? movedWords(typesOf(h.moved), h.movedNotRead) : null,
			occurrences: null,
		}));
		// The provider did not answer: the hits are the query's exact matches alone, which the page says (SMD-2891).
		return { form, hits, vectorless: r.vectorFailed?.matched ?? null, total: null, offset: 0, links: null };
	}
	const r = (await read(event, session, 'search_thoughts_keyword', { query: s.query, limit: s.limit, offset: s.offset })) as KeywordResult;
	const hits: ListedHit[] = r.hits.map((h) => ({
		id: h.id,
		line: firstLine(h.content),
		created_at: h.created_at,
		superseded: null,
		trust: word(h.metadata.trust),
		score: null,
		moved: null,
		occurrences: h.occurrences,
	}));
	// `total` is the whole match set; null past its end (an offset beyond it), where a full page is the only sign of more.
	const more = r.total !== null ? s.offset + hits.length < r.total : hits.length === s.limit;
	const path = `${base}/search`;
	return {
		form,
		hits,
		vectorless: null,
		total: r.total,
		offset: s.offset,
		links: {
			previous: s.offset > 0 ? searchAddress(path, s, Math.max(s.offset - s.limit, 0)) : null,
			next: more && s.offset + s.limit <= OFFSET_MAX ? searchAddress(path, s, s.offset + s.limit) : null,
		},
	};
};
