#!/usr/bin/env bun
/**
 * rebuild.ts — the operator's door to rebuild_derived (migration 063,
 * SMD-1732): walk the lineage table forward from a thought and act on every
 * descendant, sweep the lineage rows whose artifact is gone, or read the
 * census.
 *
 *   bun db/rebuild.ts --url … --input <id> [--reason <text>] [--force] [--dry-run]
 *   bun db/rebuild.ts --url … --input <id> --gone [--fingerprints fp1,fp2] [--dry-run]
 *   bun db/rebuild.ts --url … --orphans [--limit N] [--dry-run]
 *   bun db/rebuild.ts --url … --status
 *
 * ── What a run does ─────────────────────────────────────────────────────────
 * --input calls rebuild_derived(id, reason, gone, fingerprints, force,
 * orphans_only => false) once and
 * prints its report: what was rebuilt (a vector restored from 060's snapshot —
 * the one re-derivation the database owns), enqueued (handed to the workers'
 * pools under their CURRENT keys, the reason marked on each lineage row),
 * deleted (a row whose artifact is gone; under --gone the windows, the graph
 * and the snapshot rows too), marked with no pool (the tags), kept (a
 * structured pass, a decided proposal), current (nothing moved), and the
 * derived_from children it cannot reproduce. The reason defaults to the flag
 * that asked ('operator: edit', 'operator: force', 'operator: forget'); say
 * a better one. The sweep marks no row, so it takes no --reason (its call
 * carries 'operator: orphan sweep' as the report's label only).
 *
 * --gone is SMD-1723's shape — the input is leaving. The row must STILL STAND
 * when this runs (061's drop trigger leaves nothing to walk after a delete);
 * the tool does not delete the row, and says so. --fingerprints hands in the
 * earlier texts' fingerprints the log holds (a forget reads them before it
 * redacts); this tool passes what it is given.
 *
 * --orphans reads the lineage rows whose artifact is gone while the thought
 * stands (preflight's `lineage` WARN names this flag) and calls
 * rebuild_derived once per thought in its orphans-only mode, which deletes
 * each such row and touches no row whose artifact stands — a stale row on
 * the same thought keeps its own reason for its own rebuild.
 *
 * --dry-run runs the call inside a transaction and rolls it back: the report
 * is the function's own, and nothing is kept — the honest preview, since the
 * function is the only thing that knows what it would do.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 * It calls no model. The pools it fills are drained by the workers that own
 * the recipes — db/reembed.ts, db/extract-entities.ts, db/consolidate.ts —
 * and the end of a run names each pool that gained rows with the command that
 * drains it. The tags have no pool: a stale tags row is marked and reported,
 * and waits for a re-capture or an edit with the extractor's recipe.
 *
 * ── Exit codes ──────────────────────────────────────────────────────────────
 * 0 the call ran (or --status printed); 1 the function answered a refusal as a
 * value (NOT_FOUND, REPLAYING) or a run failed; 2 usage, no database URL, or a
 * brain without 063 (named, with the migrate command).
 */

import { commandLine } from "./cli.ts";
import { databaseUrl, openSql } from "./connect.ts";
import { staleStandings, staleStandingsText, STALE_STANDING_ROWS_SQL, type StaleStandingRow } from "../server-portable/consolidate.ts";

// Every argument accounted for (db/cli.ts, SMD-2134): a flag this door does not
// have is refused rather than ignored, and a blank --reason is refused as every
// flag's blank value is (it is recorded on every row marked).
const cli = commandLine("rebuild.ts", {
  url: "one", input: "one", reason: "one", fingerprints: "one", limit: "one",
  gone: "none", force: "none", orphans: "none", status: "none", "dry-run": "none",
}, { hints: { url: "<postgres://…>", input: "<thought id>", reason: "<text> (with --input)", fingerprints: "<fp1,fp2> (with --gone)", limit: "<N> (with --orphans)", gone: "(with --input)", force: "(with --input)" } });

const url = databaseUrl(cli.value("url"));
const INPUT = cli.value("input");
const ORPHANS = cli.has("orphans");
const STATUS = cli.has("status");
const GONE = cli.has("gone");
const FORCE = cli.has("force");
const DRY = cli.has("dry-run");
// Decimal digits (cli.ts's rule), then held to 1..10,000 as before: 0 reads as 1.
const LIMIT = Math.max(1, Math.min(cli.int("limit", { absent: 500, min: 0 }), 10000));
const FINGERPRINTS = cli.value("fingerprints")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const modes = [INPUT !== undefined, ORPHANS, STATUS].filter(Boolean).length;
if (modes !== 1) {
  console.error("Say one thing: --input <id> [--reason …] [--gone [--fingerprints …]] [--force] [--dry-run] | --orphans [--limit N] [--dry-run] | --status");
  process.exit(2);
}
// What is allowed, not what was given (cli.ts's rule): the value may be a URL given without --url.
if (INPUT !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(INPUT)) {
  console.error("--input takes a thought id (a UUID)");
  process.exit(2);
}
if ((GONE || FORCE || FINGERPRINTS) && INPUT === undefined) {
  console.error("--gone, --force and --fingerprints go with --input");
  process.exit(2);
}
if (FINGERPRINTS && !GONE) {
  console.error("--fingerprints goes with --gone: the earlier texts' fingerprints are what a leaving thought's snapshot rows are found by");
  process.exit(2);
}
const reasonRaw = cli.value("reason");
// A flag outside its mode is a usage error, not a silent no-op (second
// review pass: --reason on the sweep landed nowhere — the sweep marks no row).
if (reasonRaw !== undefined && INPUT === undefined) {
  console.error("--reason goes with --input: the sweep marks no row and --status writes nothing, so there is nothing to record it on");
  process.exit(2);
}
if (cli.has("limit") && !ORPHANS) {
  console.error("--limit goes with --orphans");
  process.exit(2);
}
if (DRY && STATUS) {
  console.error("--dry-run goes with --input or --orphans: --status writes nothing");
  process.exit(2);
}
const REASON = reasonRaw ?? (GONE ? "operator: forget" : FORCE ? "operator: force" : ORPHANS ? "operator: orphan sweep" : "operator: edit");
/**
 * Bun 1.4 binds a JS string[] to a text[] parameter as the bare text `a,b`
 * (run-it, first review pass: "malformed array literal"), so the Postgres
 * array literal is built here — each element quoted, quotes and backslashes
 * escaped — and bound as text.
 */
const FPS_LITERAL = FINGERPRINTS ? "{" + FINGERPRINTS.map((s) => `"${s.replace(/(["\\])/g, "\\$1")}"`).join(",") + "}" : null;

const sql = openSql(url);

type Report = {
  ok: boolean; error?: string; id?: string;
  input: string; reason: string; input_gone: boolean; force: boolean;
  walked: number; depth: number; at_cap: boolean;
  rebuilt: number; enqueued: number; deleted: number; marked: number; unqueued: number; stale_proposals: number; kept: number; current: number; legacy: number;
  irreproducible: string[]; cascading: { proposals: number; lineage_rows: number }; pools: string[];
};

/** The worker that drains a pool, by the key's prefix (db/config.mjs's three key shapes). */
function drainer(pool: string): string {
  if (pool.startsWith("reembed:")) return "bun db/reembed.ts --url <url>";
  if (pool.startsWith("extract:")) return "bun db/extract-entities.ts --url <url>";
  if (pool.startsWith("consolidate:")) return "bun db/consolidate.ts --url <url>";
  return "(no worker in this tree drains this key)";
}

function printReport(r: Report): void {
  console.log(`  input:       ${r.input}${r.input_gone ? " (leaving — the row still stands; the caller deletes it)" : ""}`);
  console.log(`  reason:      ${r.reason}${r.force ? " (--force: every row treated as stale)" : ""}`);
  console.log(`  walked:      ${r.walked} lineage row(s) to depth ${r.depth}${r.at_cap ? " — the walk's cap; whatever stood beyond it is the next call's" : ""}`);
  console.log(`  rebuilt:     ${r.rebuilt} (a vector restored from the snapshot at the model — the one re-derivation the database owns${r.force ? "; or, under --force, a vector at the configured model whose text did not move, its record renewed" : ""})`);
  console.log(`  enqueued:    ${r.enqueued} (thought, pool) claim(s) for the workers`);
  console.log(`  deleted:     ${r.deleted} (lineage rows whose artifact is gone${r.input_gone ? "; the windows, the graph and the snapshot rows the input keyed" : ""})`);
  console.log(`  marked:      ${r.marked} lineage row(s) carry the reason until their producer writes again${r.unqueued ? `; ${r.unqueued} of them wait for no pool (the tags, a generated page section, or no configured model)` : ""}${r.stale_proposals ? `; ${r.stale_proposals} proposal(s) set stale — pending ones, and ones the consolidate pass itself had settled (067) — their status the mark; the next pass replaces one it finds in conflict again and settles one it does not` : ""}`);
  console.log(`  kept:        ${r.kept} (a structured pass reads its source, not the text; a person's decision on a proposal stands)`);
  console.log(`  current:     ${r.current} (nothing moved)${r.legacy ? `; ${r.legacy} legacy row(s) read current by construction — --force re-runs them` : ""}`);
  if (r.input_gone) console.log(`  cascade:     ${r.cascading.proposals} proposal(s) and ${r.cascading.lineage_rows} lineage row(s) go with the row delete (029's and 061's triggers)`);
  if (r.irreproducible.length) {
    console.log(`  irreproducible: ${r.irreproducible.length} derived_from child(ren) — prose no recipe re-runs; a human reviews them:`);
    for (const id of r.irreproducible) console.log(`    ${id}`);
  }
  if (r.pools.length) {
    console.log(`  pools:       ${r.pools.join(", ")}`);
    for (const p of r.pools) console.log(`    ${p}  →  ${drainer(p)}`);
  }
}

async function needs063(): Promise<void> {
  const [row] = (await sql`SELECT to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NOT NULL AS ok`) as { ok: boolean }[];
  if (!row.ok) {
    console.error("  rebuild_derived is not on this brain: migration 063 (SMD-1732) is missing. Apply it — cd db && bun migrate.ts --url <url> — and run again.");
    await sql.close();
    process.exit(2);
  }
}

async function callRebuild(id: string, reason: string, gone: boolean, fps: string | null, force: boolean, orphansOnly = false): Promise<Report> {
  if (DRY) await sql.unsafe("BEGIN");
  try {
    const [row] = (await sql`SELECT rebuild_derived(${id}::uuid, ${reason}::text, ${gone}::boolean, ${fps}::text::text[], ${force}::boolean, ${orphansOnly}::boolean) AS r`) as { r: Report }[];
    return row.r;
  } finally {
    if (DRY) await sql.unsafe("ROLLBACK");
  }
}

try {
  await needs063();
  if (STATUS) {
    const [c] = (await sql`
      WITH al AS (SELECT id, artifact_kind, artifact_id, produced_by, input_ids, input_fingerprints, recipe, stale_since FROM derivations LIMIT 10001),
           st AS (SELECT d.id FROM al d JOIN thoughts t ON t.id = d.input_ids[1]
                   WHERE d.artifact_kind <> 'proposal' AND d.input_fingerprints[1] IS DISTINCT FROM COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))),
           orph AS (SELECT d.id FROM al d
                     WHERE (d.artifact_kind = 'chunks'   AND NOT EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = d.artifact_id))
                        OR (d.artifact_kind = 'entities' AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = d.artifact_id AND m.extraction_key = d.produced_by)
                                                         AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = d.artifact_id AND g.extraction_key = d.produced_by))
                        OR (d.artifact_kind = 'vector'   AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id AND t.embedding IS NOT NULL))
                        OR (d.artifact_kind = 'metadata' AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id AND (t.metadata ? 'type' OR t.metadata ? 'topics'))))
      SELECT (SELECT count(*)::int FROM al) AS rows,
             (SELECT jsonb_object_agg(k, n) FROM (SELECT artifact_kind AS k, count(*)::int AS n FROM al GROUP BY 1) s) AS by_kind,
             (SELECT count(*)::int FROM al WHERE stale_since IS NOT NULL) AS marked,
             (SELECT count(*)::int FROM st) AS stale,
             (SELECT count(*)::int FROM orph) AS orphans,
             (SELECT count(*)::int FROM al WHERE recipe->>'legacy' = 'true') AS legacy,
             (SELECT count(*)::int FROM supersession_proposals WHERE status = 'stale') AS stale_proposals`) as { rows: number; by_kind: Record<string, number> | null; marked: number; stale: number; orphans: number; legacy: number; stale_proposals: number }[];
    // 067: where each stale row stands against the judge pools — the one read
    // and rank db/consolidate.ts's --status uses (server-portable/consolidate.ts),
    // so the two doors never disagree (first review pass, mutant: a copy here
    // read one way while the worker's read another); keyless here, so a
    // failed or live claim is named with its judge key.
    const standings = staleStandings((await sql.unsafe(STALE_STANDING_ROWS_SQL)) as StaleStandingRow[], null);
    const bound = Number(c.rows) >= 10001 ? " (the first 10,001 lineage rows read; the rest not)" : "";
    console.log(`  lineage:     ${c.rows} row(s)${bound}: ${Object.entries(c.by_kind ?? {}).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
    console.log(`  stale:       ${c.stale} row(s) whose input's text moved since (the census's read) — bun db/rebuild.ts --input <id> acts on a thought's`);
    console.log(`  marked:      ${c.marked} row(s) await a re-run rebuild_derived asked for`);
    console.log(`  orphans:     ${c.orphans} row(s) whose artifact is gone${Number(c.orphans) ? " — bun db/rebuild.ts --orphans deletes them" : ""}`);
    console.log(`  legacy:      ${c.legacy} row(s) backfilled by 061 at the thought's current text (read as current; --force re-records a vector and re-runs the rest)`);
    console.log(`  proposals:   ${c.stale_proposals} stale (a text moved under the verdict${standings.total ? `: ${staleStandingsText(standings, null, "bun db/consolidate.ts --retry-failed")}` : ""}; the pass replaces one it finds in conflict again and settles one it does not — a reviewer may decide one sooner: bun db/consolidate.ts --list stale)`);
    const pools = (await sql`SELECT work_type AS w, count(*)::int AS n FROM thought_work_claims WHERE status = 'pending' GROUP BY 1 ORDER BY 1`) as { w: string; n: number }[];
    console.log(`  pools:       ${pools.length ? pools.map((p) => `${p.w} (${p.n} pending)`).join(", ") : "nothing pending"}`);
    for (const p of pools) console.log(`    ${p.w}  →  ${drainer(p.w)}`);
    await sql.close();
    process.exit(0);
  }
  if (INPUT !== undefined) {
    if (DRY) console.log("  dry run: the call runs and rolls back — the report is what it would do");
    const r = await callRebuild(INPUT, REASON, GONE, FPS_LITERAL, FORCE);
    if (!r.ok) {
      console.error(`  refused: ${r.error}${r.error === "NOT_FOUND" ? " — no thought has this id" : r.error === "REPLAYING" ? " — this session is a replay (ob1.projecting_replay); a rebuild is a live operation" : ""}`);
      await sql.close();
      process.exit(1);
    }
    printReport(r);
    await sql.close();
    process.exit(0);
  }
  // --orphans: the rows whose artifact is gone, grouped by the thought that
  // keys them; one call per thought.
  const orphans = (await sql`
    WITH al AS (SELECT id, artifact_kind, artifact_id, produced_by FROM derivations LIMIT 10001)
    SELECT DISTINCT d.artifact_id::text AS id FROM al d
     WHERE EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id)
       AND ((d.artifact_kind = 'chunks'   AND NOT EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = d.artifact_id))
         OR (d.artifact_kind = 'entities' AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = d.artifact_id AND m.extraction_key = d.produced_by)
                                          AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = d.artifact_id AND g.extraction_key = d.produced_by))
         OR (d.artifact_kind = 'vector'   AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id AND t.embedding IS NOT NULL))
         OR (d.artifact_kind = 'metadata' AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id AND (t.metadata ? 'type' OR t.metadata ? 'topics'))))
     ORDER BY 1 LIMIT ${LIMIT}`) as { id: string }[];
  if (orphans.length === 0) {
    console.log("  orphans: none — every lineage row read names an artifact that stands");
    await sql.close();
    process.exit(0);
  }
  if (DRY) console.log("  dry run: each call runs and rolls back");
  let deleted = 0, touched = 0, refused = 0;
  for (const o of orphans) {
    // Orphans only: a stale row on the same thought keeps its own reason
    // for its own rebuild (cold read, first review pass).
    const r = await callRebuild(o.id, REASON, false, null, false, true);
    if (!r.ok) {
      console.error(`  ${o.id}: refused ${r.error}${r.error === "REPLAYING" ? " — this session is a replay (ob1.projecting_replay, a database- or role-level default); a rebuild is a live operation" : r.error === "NOT_FOUND" ? " — the thought went between the census and the call" : ""}`);
      refused += 1;
      continue;
    }
    touched += 1;
    deleted += r.deleted;
  }
  console.log(`  orphans:     ${orphans.length} thought(s) carried a lineage row whose artifact is gone${orphans.length >= LIMIT ? ` (the first ${LIMIT}; run again for the rest)` : ""}`);
  console.log(`  deleted:     ${deleted} lineage row(s) over ${touched} thought(s)${DRY ? " (rolled back)" : ""} — nothing else on those thoughts was touched${refused ? `; ${refused} call(s) refused (above)` : ""}`);
  await sql.close();
  // A refusal as a value is exit 1 here as under --input (fourth review pass).
  process.exit(refused ? 1 : 0);
} catch (e) {
  console.error(`  failed: ${(e as Error).message}`);
  await sql.close();
  process.exit(1);
}
