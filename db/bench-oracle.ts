/**
 * bench-oracle.ts — the pure part of bench-hnsw.ts's oracle cache (SMD-1562):
 * what an entry in the kept corpus's marker holds, and what of it a run may
 * trust. Lifted out of the bench so the guards are a function test-schema.ts
 * drives in milliseconds — the bench is a top-level script that connects at
 * import, and two twenty-second container runs had left five of the seven
 * guards mutant-blind (review pass). The bench keeps what needs a server:
 * the statement, the shape's key, the plan check, the reads and writes.
 */
import { createHash } from "node:crypto";

/** One query's exact answer: the top-K ids in distance order, and the nearest row's cosine (−1 where nothing matched). */
export type OracleAnswer = { ids: string[]; top: number };
/**
 * One entry of the marker's oracle map: for each tier key and for the whole
 * table, one answer per query — the exact top-K ids in distance order and
 * the nearest row's cosine (the whole table's is the confound). At ten
 * million rows the exact pass is most of a reuse's minutes — some 450 full
 * scans — and its answers are a pure function of the rows, the queries, K
 * and the oracle's statement, the same on every reuse. What they are a
 * function of is named by value. The map's key (`oracleShapeOn` in the
 * bench) is a digest of the oracle's statement (K inside it), the filter's
 * form, how a vector is rendered, how an answer is derived from the rows,
 * the server's distance kernel, and the first query's digest — so a tree,
 * a server or a stream that differs in any of them writes an entry of its
 * own beside this one rather than over it (a kept volume outlives branches;
 * review passes). The entry carries `queries`, a digest of each query's
 * literal as the server parsed it, in order: the stream's first queries are
 * a prefix of any longer run's, so a run asking fewer takes the answers
 * whose digests match its own — the leading ones, all of them where the
 * stream is unchanged — and a run asking more computes the rest and extends
 * its entry. Valid exactly while the rows are: the cache rides inside the
 * marker whose physical fingerprint a reuse judges first, and a corpus that
 * changed is refused before this is read. A marker without an entry for
 * this key, or whose digests stop matching, is computed for and extended,
 * not refused — the answers are derivable, the build is not.
 */
export type OracleCache = { queries: string[]; answers: Record<string, OracleAnswer[]> };

/** A short digest for the cache — of a query's literal, of the statement's forms, of the server's kernel probe. */
export const digestOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/**
 * The answers an entry gives this run: for each of THESE keys, the leading
 * answers whose queries are this run's (`taken`, `have` of them), and how
 * many the entry holds (`had`). The entry must be whole — one well-formed
 * answer per query for every key: distinct string ids, exactly as many as an
 * exact answer for the key holds (`expected(key)`: K, or fewer where fewer
 * rows match — a trimmed list would read as recall lost), and a finite
 * cosine — and its digests are matched against this run's queries from the
 * front, so a changed stream answers for nothing past the change. Nothing
 * where the entry is absent or malformed — computed for, never refused (the
 * answers are a function of rows the caller has vouched for; a malformed
 * field would otherwise be a TypeError after the checks were paid, or a
 * silently skewed recall); `had` still counts what a malformed entry held,
 * so the caller can say it found one and discarded it. Built here, where the
 * shape was proven, so the caller asserts nothing (review passes).
 */
export function markerAnswers(entry: unknown, keys: string[], digests: string[], expected: (key: string) => number): { have: number; had: number; taken: Record<string, OracleAnswer[]> } {
  const c = entry as OracleCache | null | undefined;
  const none = (had: number) => ({ have: 0, had, taken: Object.fromEntries(keys.map((key) => [key, [] as OracleAnswer[]])) });
  if (!c || typeof c !== "object" || !Array.isArray(c.queries) || c.queries.length < 1) return none(0);
  const n = c.queries.length;
  const answer = (key: string) => (a: unknown): a is OracleAnswer => {
    const { ids, top } = (a ?? {}) as OracleAnswer;
    return Array.isArray(ids) && ids.length === expected(key) && new Set(ids).size === ids.length && ids.every((id) => typeof id === "string") && Number.isFinite(top);
  };
  const whole = c.queries.every((d) => typeof d === "string") && keys.every((key) => Array.isArray(c.answers?.[key]) && c.answers[key].length === n && c.answers[key].every(answer(key)));
  if (!whole) return none(n);
  let have = 0;
  while (have < Math.min(n, digests.length) && c.queries[have] === digests[have]) have++;
  return { have, had: n, taken: Object.fromEntries(keys.map((key) => [key, c.answers[key].slice(0, have)])) };
}
