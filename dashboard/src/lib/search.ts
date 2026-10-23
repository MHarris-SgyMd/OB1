// The search view's address (SMD-2280 PR 2a), shared by its load and its page:
// nothing here reads the session or the environment.

/** By meaning (search_thoughts) or by exact text (search_thoughts_keyword). */
export type SearchMode = 'meaning' | 'text';

/** The result counts the menu offers; the address takes any whole number from 1 to 100, what both reads take. */
export const SEARCH_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_SEARCH_SIZE = 25;
/** The longest query sent: a search box's, well past any question; the address carries it. */
export const QUERY_MAX = 1000;
/** How deep the exact-text pages go by offset. */
export const OFFSET_MAX = 100_000;

/** A hit as either mode lists it: the fields one mode lacks are null. */
export type ListedHit = {
	id: string;
	line: string;
	created_at: string | null;
	/** True when a newer thought supersedes it; null where the read does not say (the exact-text search). */
	superseded: boolean | null;
	trust: string | null;
	/** By meaning: similarity to the query, 0–1, or null for a hit found by an exact identifier or quoted span. */
	score: number | null;
	/** By meaning: the tickets it names that moved since it was written, in the tool's words. */
	moved: string | null;
	/** By exact text: how often the text holds the query. */
	occurrences: number | null;
};

/** The view's state from the address: a query, a mode, a count and (by exact text) where the page starts. */
export function readSearch(params: URLSearchParams) {
	const query = (params.get('q') ?? '').trim().slice(0, QUERY_MAX);
	const mode: SearchMode = params.get('mode') === 'text' ? 'text' : 'meaning';
	const size = Number(params.get('limit'));
	const offset = Number(params.get('offset'));
	return {
		query,
		mode,
		limit: Number.isInteger(size) && size >= 1 && size <= 100 ? size : DEFAULT_SEARCH_SIZE,
		offset: mode === 'text' && Number.isInteger(offset) && offset > 0 && offset <= OFFSET_MAX ? offset : 0,
	};
}

/** The address of an exact-text page of this search. */
export function searchAddress(path: string, s: { query: string; mode: SearchMode; limit: number }, offset: number): string {
	const p = new URLSearchParams({ q: s.query, mode: s.mode });
	if (s.limit !== DEFAULT_SEARCH_SIZE) p.set('limit', String(s.limit));
	if (offset > 0) p.set('offset', String(offset));
	return `${path}?${p}`;
}
