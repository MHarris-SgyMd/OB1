// Reading the operator views' addresses (SMD-2280 PR 2b): each value as the
// core takes it, or absent, so nothing unreadable reaches the core — the same
// rules browse.ts holds for its own. Pure and shared by the loads and the
// pages: nothing here reads the session or the environment.

/** A whole number from `min` to `max`, or `fallback` when the address holds none or another. */
export function wholeIn(params: URLSearchParams, name: string, min: number, max: number, fallback: number): number {
	const n = Number(params.get(name));
	return params.has(name) && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Free text: trimmed, cut at `max`, and without NUL, which no Postgres text holds (the core's 500, SMD-2534); empty is unset. */
export function textIn(params: URLSearchParams, name: string, max: number): string | undefined {
	const t = params.get(name)?.replaceAll('\0', '').trim();
	return t ? t.slice(0, max) : undefined;
}

/** One of `words`, or `fallback`. */
export function wordIn<const W extends readonly string[]>(params: URLSearchParams, name: string, words: W, fallback: W[number]): W[number] {
	const v = params.get(name);
	return v !== null && (words as readonly string[]).includes(v) ? (v as W[number]) : fallback;
}

/** The address of `path` with `values` set, leaving out each one unset or equal to its default in `defaults`. */
export function addressOf(path: string, values: Record<string, string | number | boolean | string[] | undefined>, defaults: Record<string, string | number | boolean> = {}): string {
	const p = new URLSearchParams();
	for (const [k, v] of Object.entries(values)) {
		if (v === undefined || v === false || v === defaults[k]) continue;
		if (Array.isArray(v)) for (const each of v) p.append(k, each);
		else p.set(k, v === true ? '1' : String(v));
	}
	const s = p.toString();
	return s ? `${path}?${s}` : path;
}
