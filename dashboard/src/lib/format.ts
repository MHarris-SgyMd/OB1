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

/** A thought's first line, cut at `max` characters, for a list. */
export function firstLine(text: string, max = 160): string {
	const line = text.trimStart().split('\n', 1)[0] ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
