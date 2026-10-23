// How the pages write the REST core's values: shared by the server and the
// browser, so nothing here may read the session or the environment.

/**
 * An ISO instant as `2026-10-22 14:03 UTC`, or a dash for none. In UTC and
 * labelled, so the server's render and the browser's agree: a locale format
 * rendered in the container's zone and re-rendered in the visitor's showed
 * two times for one instant (review pass 1).
 */
export function when(iso: string | null | undefined): string {
	if (!iso) return '—';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const s = d.toISOString();
	// A year outside 0000–9999 is written `+010000-…`, which the cut below would garble: shown as given (review pass 2).
	return /^\d{4}-/.test(s) ? `${s.slice(0, 16).replace('T', ' ')} UTC` : iso;
}

/** A count map's largest entries, largest first, ties by name. */
export function top(counts: Record<string, number> | null | undefined, n = 8): [string, number][] {
	return Object.entries(counts ?? {})
		.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
		.slice(0, n);
}

/** A metadata word any write key writes (a type, a trust), as a list shows it: cut as a first line is, or null when not a string. */
export function shortWord(v: unknown): string | null {
	return typeof v === 'string' ? firstLine(v, 40) : null;
}

/** A thought's first line, cut at `max` characters, for a list. */
export function firstLine(text: string, max = 160): string {
	const line = text.trimStart().split('\n', 1)[0] ?? '';
	if (line.length <= max) return line;
	// Never between a surrogate pair: half an emoji is U+FFFD on the page (SMD-2280 PR 2a review pass 2).
	const end = /[\uD800-\uDBFF]/.test(line[max - 2] ?? '') ? max - 2 : max - 1;
	return `${line.slice(0, end)}…`;
}
