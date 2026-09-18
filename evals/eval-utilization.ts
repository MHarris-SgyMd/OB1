#!/usr/bin/env bun
/**
 * eval-utilization.ts — did the caller use what the search returned? (SMD-1719)
 *
 * Reads the opt-in query log (migration 034) from DATABASE_URL and prints, per
 * arm and overall: ids returned, ids used (cited by a later capture's
 * derived_from/supersedes, or opened by fetch/update/delete), utilization,
 * use rate, the cited/opened split, and approximate tokens returned per id used.
 * The numbers and their caveats are defined in evals/utilization.ts (pure) and
 * evals/README.md ("Utilization").
 *
 *   DATABASE_URL=postgres://… bun evals/eval-utilization.ts [--gold fixture.json]
 *   OB1_EXPORT_WINDOW_MIN=30   # how long after a search a touch still counts (export-queries.ts's window)
 *
 * --gold takes a fixture in export-queries.ts's shape ({ queries: [{ query,
 * relevant }] }) and adds the ignore rate: searches whose results held a
 * relevant id the caller never used. A fixture exported from THIS log's own
 * touches is circular (its `relevant` IS the touches); the honest gold is a
 * hand-labelled set in the same shape.
 *
 * Tokens: the log does not record what a search returned beyond the ids, so
 * the estimate joins the ids to `thoughts` as they are stored NOW (chars / 4);
 * a since-deleted or since-edited row shifts it. Stated in the report.
 */

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { parsePgUuidArray, posInt } from "./query-log.ts";
import { renderReport, summarise, type ActionRow, type SearchRow } from "./utilization.ts";

loadEnv();

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  process.stderr.write("DATABASE_URL is not set — the report reads query_log from the live brain.\n");
  process.exit(2);
}

const WINDOW_MIN = posInt(process.env.OB1_EXPORT_WINDOW_MIN, 30);

const args = process.argv.slice(2);
const goldIdx = args.indexOf("--gold");
const goldPath = goldIdx >= 0 ? args[goldIdx + 1] : undefined;
if (goldIdx >= 0 && (!goldPath || goldPath.startsWith("--"))) {
  process.stderr.write("--gold needs a fixture path\n");
  process.exit(2);
}
// Anything that is not `--gold <path>` is refused — a fixture path given
// without the flag must not run the report silently without its gold columns.
const stray = args.filter((a, i) => !(a === "--gold" || (i > 0 && args[i - 1] === "--gold")));
if (stray.length) {
  process.stderr.write(`unexpected argument ${stray[0]}; usage: bun evals/eval-utilization.ts [--gold <fixture.json>]\n`);
  process.exit(2);
}

let gold: Map<string, Set<string>> | undefined;
if (goldPath) {
  const fx = JSON.parse(readFileSync(goldPath, "utf8")) as { queries?: { query: string; relevant: unknown }[] };
  gold = new Map();
  // `relevant` is an array in a fresh export and may be a `{a,b}` literal in a
  // re-serialised one (eval-replay.ts guards the same); coerce, never char-scan.
  for (const q of fx.queries ?? []) gold.set(q.query, new Set(parsePgUuidArray(q.relevant)));
}

const sql = new SQL({ url: URL_, max: 2 });

const searchRows = await sql<{
  id: string; agent_id: string | null; logged_at: Date; tool: string; query: string | null;
  match_count: number | null; threshold: number | null; recency_weight: number | null;
  result_ids: unknown; chars: number | null; surviving: number; returned_n: number;
}[]>`
  SELECT s.id, s.agent_id, s.logged_at, s.tool, s.query, s.match_count, s.threshold, s.recency_weight, s.result_ids,
         (SELECT sum(length(t.content))::bigint FROM thoughts t WHERE t.id = ANY(s.result_ids)) AS chars,
         (SELECT count(*)::int FROM thoughts t WHERE t.id = ANY(s.result_ids)) AS surviving,
         coalesce(cardinality(s.result_ids), 0) AS returned_n
    FROM query_log s
   WHERE s.kind = 'search'`;
const actionRows = await sql<{ agent_id: string | null; logged_at: Date; tool: string; target_id: string }[]>`
  SELECT agent_id, logged_at, tool, target_id FROM query_log WHERE kind = 'action'`;
await sql.close();

const searches: SearchRow[] = searchRows.map((r) => ({
  id: r.id,
  agentId: r.agent_id,
  loggedAt: r.logged_at,
  tool: r.tool,
  query: r.query,
  matchCount: r.match_count,
  threshold: r.threshold,
  recencyWeight: r.recency_weight,
  resultIds: parsePgUuidArray(r.result_ids),
  // The estimate is whole or absent: a search whose returned ids are all still
  // stored gets chars/4 over all of them; one where any id has since been
  // deleted gets none, rather than a partial sum that reads as a cheaper
  // search than it was (second review pass). Edits still shift it — said in
  // the report's caveat.
  resultTokens: r.chars !== null && Number(r.surviving) === Number(r.returned_n) && Number(r.returned_n) > 0 ? Math.round(Number(r.chars) / 4) : null,
}));
const actions: ActionRow[] = actionRows.map((r) => ({ agentId: r.agent_id, loggedAt: r.logged_at, tool: r.tool, targetId: r.target_id }));

const summary = summarise(searches, actions, WINDOW_MIN, gold);
console.log(renderReport(summary));
