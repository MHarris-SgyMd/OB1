/**
 * query-log.ts — the helpers every reader of the opt-in query log
 * (migration 034) needs, in one place so export-queries.ts and
 * eval-utilization.ts cannot drift apart on them.
 */

import type { SQL } from "bun";

/**
 * Refuse, in the reader's own words, a brain the log table is not on. Without
 * this the first query dies in the driver — `relation "query_log" does not
 * exist`, a stack trace — where preflight's "query log" check says plainly
 * "not present — migration 034 is not applied". Same verdict here, exit 2 like
 * the readers' other refusals (no DATABASE_URL, a bad argument).
 */
export async function requireQueryLog(sql: SQL, reader: string): Promise<void> {
  const [{ present }] = await sql<{ present: boolean }[]>`SELECT to_regclass('public.query_log') IS NOT NULL AS present`;
  if (present) return;
  await sql.close();
  process.stderr.write(`${reader}: query_log is not present — the opt-in query log (migration 034) is not applied on this brain. Apply it (cd db && bun migrate.ts --url $DATABASE_URL) and set OB1_QUERY_LOG=on, then use the brain before reading the log.\n`);
  process.exit(2);
}

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
