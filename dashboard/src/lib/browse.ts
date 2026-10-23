// The browse view's address (SMD-2280 PR 2a): its filters, sort, page size and
// place are the URL's query, so a page is a link — shared, reloaded, or gone back
// to with the browser's Back. Pure and shared by the server's load and the page:
// nothing here reads the session or the environment.

/** The trust words, highest first: what `said_by` and `min_trust` take (server-portable/core/filter.ts SAID_BY, TRUST). */
export const TRUST_WORDS = ['operator', 'agent', 'ingested'] as const;
export type TrustWord = (typeof TRUST_WORDS)[number];

/** The page sizes the menu offers; the address takes any whole number to PAGE_MAX (a link, or the smoke's page of one). */
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** The largest page: the core takes 1–1000, and a page is read whole into the browser. */
export const PAGE_MAX = 100;

/**
 * How many cursors back the address keeps: each is at most 512 characters
 * (the core's bound, SMD-2995) and about 100 in practice, so twenty stay well
 * inside a request line. Past them, Previous still works to the twentieth
 * page back, and First page always does.
 */
export const TRAIL_MAX = 20;

/** The longest free-text filter kept from the address: the core's `actor` bound, and ample for a type, topic or person. */
const TEXT_MAX = 200;

/** The view's state, read from the address: every filter as the core takes it, absent when unset or unreadable. */
export type BrowseQuery = {
	type?: string;
	topic?: string;
	person?: string;
	actor?: string;
	said_by?: TrustWord;
	min_trust?: TrustWord;
	days?: number;
	sort: 'newest' | 'oldest';
	limit: number;
	/** The cursor this page starts after, as the previous page gave it; absent on the first page. */
	after?: string;
	/** The cursors of the pages before this one, oldest first: Previous is the last of them, or the first page. */
	trail: string[];
};

/** The filters alone, for the form and for the links that keep them. */
export const FILTER_KEYS = ['type', 'topic', 'person', 'actor', 'said_by', 'min_trust', 'days'] as const;

const text = (v: string | null) => {
	const t = v?.trim();
	return t ? t.slice(0, TEXT_MAX) : undefined;
};
const trust = (v: string | null): TrustWord | undefined => (TRUST_WORDS as readonly string[]).includes(v ?? '') ? (v as TrustWord) : undefined;
/** A cursor's characters (base64url), at most the core's 512: anything else is no cursor, left for the first page rather than sent. */
const cursor = (v: string) => /^[A-Za-z0-9_-]{1,512}$/.test(v);

/**
 * The view's state from the address. Nothing unreadable reaches the core: a
 * filter it cannot hold is dropped, a page size past 1–PAGE_MAX is the default,
 * and a cursor of the wrong characters starts the list again. A cursor of the
 * right characters the core does not read (made under the other sort, or
 * altered) is the core's to refuse, which the page says in words.
 */
export function readBrowse(params: URLSearchParams): BrowseQuery {
	const days = Number(params.get('days'));
	const limit = Number(params.get('limit'));
	const after = params.get('after') ?? '';
	const trail = (params.get('back') ?? '').split('.').filter(cursor).slice(-TRAIL_MAX);
	return {
		type: text(params.get('type')),
		topic: text(params.get('topic')),
		person: text(params.get('person')),
		actor: text(params.get('actor')),
		said_by: trust(params.get('said_by')),
		min_trust: trust(params.get('min_trust')),
		// The core takes up to 365,000 days; a whole number of them here.
		days: Number.isInteger(days) && days >= 1 && days <= 365_000 ? days : undefined,
		sort: params.get('sort') === 'oldest' ? 'oldest' : 'newest',
		limit: Number.isInteger(limit) && limit >= 1 && limit <= PAGE_MAX ? limit : DEFAULT_PAGE_SIZE,
		after: cursor(after) ? after : undefined,
		// A trail with no page after it is no trail: the first page has nothing before it.
		trail: cursor(after) ? trail : [],
	};
}

/** The list_thoughts input for this page: the filters, sort, size and cursor, nothing else. */
export function listInput(q: BrowseQuery) {
	return {
		limit: q.limit,
		sort: q.sort,
		...(q.after ? { after: q.after } : {}),
		...Object.fromEntries(FILTER_KEYS.filter((k) => q[k] !== undefined).map((k) => [k, q[k]])),
	};
}

/** The address of a page of this view: these filters, sort and size, from `after` with `trail` behind it. */
function address(path: string, q: BrowseQuery, after: string | undefined, trail: string[]): string {
	const p = new URLSearchParams();
	for (const k of FILTER_KEYS) if (q[k] !== undefined) p.set(k, String(q[k]));
	if (q.sort !== 'newest') p.set('sort', q.sort);
	if (q.limit !== DEFAULT_PAGE_SIZE) p.set('limit', String(q.limit));
	if (after) {
		p.set('after', after);
		if (trail.length) p.set('back', trail.slice(-TRAIL_MAX).join('.'));
	}
	const s = p.toString();
	return s ? `${path}?${s}` : path;
}

/**
 * The links around a page: the next (from the core's cursor, with this page's
 * own cursor pushed onto the trail), the previous (the trail's last, or the
 * first page), and the first page — each keeping the filters. Null where there
 * is none: no next at the end, no previous or first on the first page.
 */
export function pageLinks(path: string, q: BrowseQuery, next: string | null) {
	const onFirst = q.after === undefined;
	const behind = q.trail.length ? q.trail[q.trail.length - 1] : undefined;
	return {
		next: next ? address(path, q, next, onFirst ? [] : [...q.trail, q.after!]) : null,
		// A trail cut at TRAIL_MAX has lost the pages before it: from its oldest page, Previous is the first page.
		previous: onFirst ? null : address(path, q, behind, q.trail.slice(0, -1)),
		first: onFirst ? null : address(path, q, undefined, []),
	};
}
