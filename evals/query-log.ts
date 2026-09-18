/**
 * query-log.ts — the two helpers every reader of the opt-in query log
 * (migration 034) needs, in one place so export-queries.ts and
 * eval-utilization.ts cannot drift apart on them.
 */

/**
 * A positive integer or the default — a stray "abc"/"" must not become NaN in a
 * make_interval() bind (a cryptic mid-query error) or a zero-width window.
 */
export const posInt = (raw: string | undefined, def: number): number => {
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/**
 * Bun.sql returns a uuid[] column as the raw Postgres literal `{a,b}`, not a JS
 * array (the same asymmetry store-sql.ts builds the literal by hand for). Parse
 * it back so an id list is an array of ids, never a string an indexOf would then
 * char-scan.
 */
export function parsePgUuidArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v !== "string") return [];
  const inner = v.replace(/^\{|\}$/g, "").trim();
  return inner ? inner.split(",").map((s) => s.replace(/^"|"$/g, "")).filter(Boolean) : [];
}
