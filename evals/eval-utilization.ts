#!/usr/bin/env bun
/**
 * eval-utilization.ts — did the caller use what the search returned? (SMD-1719)
 *
 * Reads the opt-in query log (migration 034) from DATABASE_URL and prints, per
 * arm, per agent when the log holds more than one (named from ob1_agents when
 * migration 010 is present), and overall: distinct ids returned, ids used
 * (cited by a later capture's or edit's derived_from/supersedes, or opened by
 * fetch/update/delete), utilization, use rate, the cited/opened partition, and
 * approximate tokens returned per id used.
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
import { posInt, requireQueryLog } from "./query-log.ts";
import { goldFromFixture, renderReport, summarise, toActionRow, toSearchRow, type ActionDbRow, type SearchDbRow } from "./utilization.ts";

loadEnv();

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  process.stderr.write("DATABASE_URL is not set — the report reads query_log from the live brain.\n");
  process.exit(2);
}

const WINDOW_MIN = posInt(process.env.OB1_EXPORT_WINDOW_MIN, 30);

const args = process.argv.slice(2);
if (args.filter((a) => a === "--gold").length > 1) {
  process.stderr.write("--gold given more than once; one gold fixture per run\n");
  process.exit(2);
}
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

// The coercions live in utilization.ts (toSearchRow, toActionRow,
// goldFromFixture) so db/test-schema.ts [39] can drive them over database-shaped
// rows without a database; this file is the SQL and the printing.
let gold: ReturnType<typeof goldFromFixture> | undefined;
if (goldPath) {
  try {
    gold = goldFromFixture(JSON.parse(readFileSync(goldPath, "utf8")));
  } catch (e) {
    // The likeliest operator mistake — a mistyped path, a file that is not
    // JSON — is refused in a sentence like the script's other refusals,
    // before the database is touched.
    process.stderr.write(`--gold ${goldPath}: not a readable JSON fixture (${(e as Error).message})\n`);
    process.exit(2);
  }
}

const sql = new SQL({ url: URL_, max: 2 });
await requireQueryLog(sql, "eval-utilization");

// at_us: logged_at at the log's own microsecond grain (`::numeric`, so the
// arithmetic is exact on every server — extract() returns numeric from PG 14,
// double before, where the last digit could go); a Date alone is milliseconds.
// One lateral pass over the returned ids per search row gives both aggregates;
// the distinct count of returned ids is the reader's (toSearchRow), so a
// duplicate in a logged result set neither strips the estimate nor caps
// utilization below one, and the count has one definition.
const searchRows = await sql<SearchDbRow[]>`
  SELECT s.id, s.agent_id, s.logged_at,
         (extract(epoch FROM s.logged_at)::numeric * 1000000)::bigint AS at_us,
         s.tool, s.query, s.match_count, s.threshold, s.recency_weight, s.result_ids,
         c.chars, c.surviving
    FROM query_log s
    CROSS JOIN LATERAL (
      SELECT sum(length(t.content))::bigint AS chars, count(*)::int AS surviving
        FROM thoughts t WHERE t.id = ANY(s.result_ids)
    ) c
   WHERE s.kind = 'search'`;
const actionRows = await sql<ActionDbRow[]>`
  SELECT agent_id, logged_at, (extract(epoch FROM logged_at)::numeric * 1000000)::bigint AS at_us, tool, target_id
    FROM query_log WHERE kind = 'action'`;
// The by-agent table names its rows from the registry beside the log
// (ob1_agents, migration 010; the label mirrors the key name) — an eighth
// review pass's two-agent walk read a table of bare uuids. A brain without 010
// has no registry and the rows keep their ids.
const agentNames = new Map<string, string>();
try {
  if ((await sql<{ present: boolean }[]>`SELECT to_regclass('public.ob1_agents') IS NOT NULL AS present`)[0].present) {
    for (const r of await sql<{ id: string; label: string }[]>`SELECT canonical_agent_id AS id, label FROM ob1_agents`) agentNames.set(r.id, r.label);
  }
} catch (e) {
  // The label is cosmetic: a role that can read the log but not the registry
  // gets the report with bare ids and one line saying why, not a stack trace
  // after the log was already read (ninth review pass).
  process.stderr.write(`  (agent names not read — ${(e as Error).message.split("\n")[0]}; the by-agent table shows ids)\n`);
}
await sql.close();

const summary = summarise(searchRows.map(toSearchRow), actionRows.map(toActionRow), WINDOW_MIN, gold);
console.log(renderReport(summary, agentNames));
