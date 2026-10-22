// How the pages write the REST core's values: shared by the server and the
// browser, so nothing here may read the session or the environment.

/** An ISO instant as the visitor's locale writes a date and time, or a dash for none. */
export function when(iso: string | null | undefined): string {
	if (!iso) return '—';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** A count map's largest entries, largest first, ties by name. */
export function top(counts: Record<string, number> | null | undefined, n = 8): [string, number][] {
	return Object.entries(counts ?? {})
		.sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
		.slice(0, n);
}

/** Bytes as KB, MB or GB, one decimal. */
export function bytes(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return i === 0 ? `${v} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** A thought's first line, cut at `max` characters, for a list. */
export function firstLine(text: string, max = 160): string {
	const line = text.trimStart().split('\n', 1)[0] ?? '';
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
