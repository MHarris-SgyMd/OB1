#!/usr/bin/env bun
/**
 * export-queries.ts — turn the opt-in query log (migration 034, SMD-1295) into a
 * replayable fixture of the searches a brain was actually asked.
 *
 * Every retrieval number the fork ships is measured on one corpus the baseline
 * already saturates (evals/eval-real.ts, recall@10 0.98), so the reranker,
 * hybrid fusion and GraphRAG all came out neutral there (SMD-1039). This reads
 * the other ground truth — the queries people and agents sent to search, and
 * which returned thought they went on to open — and writes it as a fixture that
 * eval-replay.ts scores a code change against.
 *
 * The link between a search and the fetch/edit/delete that followed is NOT in
 * the log (there is no request token in the handlers). It is recovered here by
 * the only keys both rows share: the acting agent and the returned id, within a
 * window. An action is attributed to the MOST RECENT prior search by the same
 * agent whose result set contained the id — a NULL agent is its own bucket.
 *
 * The fixture is query text and ids — the query, the ids the caller touched as
 * `relevant`, the shipped ranking as `baseline`. No *thought content* leaves the
 * brain, so it can be committed without the corpus (checked by
 * scripts/check-fork-consistency.mjs check 9). But the query strings are the
 * searcher's own words — personal data — so committing an export fixture from a
 * real brain commits real queries; that is a maintainer's call, not something
 * the redaction guards. The `relevant` label is click-through relevance — a
 * proxy, not a judgement (a fetch can be a wrong guess) — and it is coarse: it
 * buckets by query TEXT, so distinct callers (or searches with different
 * arguments) that typed the same words are merged, and every anonymous caller (a
 * NULL agent, e.g. while the registry is unreachable) is one bucket, so a touch
 * could be paired with another anonymous caller's search that returned the same
 * id. Keep the hand-labelled sets (eval-real.ts) as the second opinion.
 *
 *   DATABASE_URL=postgres://… bun evals/export-queries.ts [out.json]
 *   OB1_EXPORT_WINDOW_MIN=30   # how long after a search a touch still counts
 */

import { SQL } from "bun";
import { loadEnv } from "./env.ts";

loadEnv();

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  process.stderr.write("DATABASE_URL is not set — export reads query_log from the live brain.\n");
  process.exit(2);
}

const WINDOW_MIN = Number(process.env.OB1_EXPORT_WINDOW_MIN ?? 30);
const OUT = process.argv[2] ?? process.env.OB1_EXPORT_OUT ?? "/tmp/ob1-query-fixture.json";

const sql = new SQL({ url: URL_, max: 2 });

/**
 * Bun.sql returns a uuid[] column as the raw Postgres literal `{a,b}`, not a JS
 * array (the same asymmetry store-sql.ts builds the literal by hand for). Parse
 * it back so `baseline` is committed as an array of ids, never a string an
 * indexOf would then char-scan.
 */
function parsePgUuidArray(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v !== "string") return [];
  const inner = v.replace(/^\{|\}$/g, "").trim();
  return inner ? inner.split(",").map((s) => s.replace(/^"|"$/g, "")).filter(Boolean) : [];
}

// Each action → the most recent prior search (same agent, within the window)
// that returned its id. LATERAL so the "most recent" is decided per action.
const links = await sql<{ query: string; target_id: string }[]>`
  SELECT s.query, act.target_id
    FROM query_log act
    JOIN LATERAL (
      SELECT s.query, s.logged_at
        FROM query_log s
       WHERE s.kind = 'search'
         AND s.query IS NOT NULL
         AND s.agent_id IS NOT DISTINCT FROM act.agent_id
         AND s.logged_at <= act.logged_at
         AND s.logged_at >= act.logged_at - make_interval(mins => ${WINDOW_MIN})
         AND s.result_ids @> ARRAY[act.target_id]
       ORDER BY s.logged_at DESC
       LIMIT 1
    ) s ON true
   WHERE act.kind = 'action'`;

// The baseline ranking per query: the ids the MOST RECENT search of that text
// returned, in rank order. Distinct on the query keeps one baseline per query.
const baselines = await sql<{ query: string; result_ids: unknown }[]>`
  SELECT DISTINCT ON (query) query, result_ids
    FROM query_log
   WHERE kind = 'search' AND query IS NOT NULL
   ORDER BY query, logged_at DESC`;
const baselineOf = new Map(baselines.map((b) => [b.query, parsePgUuidArray(b.result_ids)]));

// One fixture entry per query that produced at least one click-through label.
const relevant = new Map<string, Set<string>>();
for (const { query, target_id } of links) {
  if (!relevant.has(query)) relevant.set(query, new Set());
  relevant.get(query)!.add(target_id);
}

const queries = [...relevant.entries()]
  .map(([query, ids]) => ({
    query,
    relevant: [...ids],
    baseline: baselineOf.get(query) ?? [],
  }))
  .sort((a, b) => a.query.localeCompare(b.query));

const fixture = {
  generated: new Date().toISOString(),
  source: "query_log",
  windowMinutes: WINDOW_MIN,
  note: "Click-through relevance from OB1_QUERY_LOG (SMD-1295). Query text and ids — no thought content, but the query strings are the searcher's own (personal data). `relevant` is a proxy (a fetch can be a wrong guess), bucketed by query text; `baseline` is the ranking the log recorded at export time.",
  queries,
};

await Bun.write(OUT, JSON.stringify(fixture, null, 2) + "\n");
await sql.close();

const labelled = queries.reduce((n, q) => n + q.relevant.length, 0);
process.stderr.write(
  `  exported ${queries.length} queries (${labelled} click-through labels, window ${WINDOW_MIN} min) → ${OUT}\n` +
  (queries.length === 0 ? "  (no query had a follow-up touch — is OB1_QUERY_LOG on, and has anyone searched then fetched?)\n" : ""),
);
