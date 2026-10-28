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
 *   await run({ url, orphans: true, dryRun: true })   # in-process: import { run } from "./rebuild.ts" (SMD-2304's engine shape, SMD-2679)
 *   await sweepOrphans(sql, { limit, writer })        # the sweep alone on the caller's client: the sleep scheduler's re-derive pass (SMD-2679)
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
 * the same thought keeps its own reason for its own rebuild. It and --status
 * read the first 10,001 lineage rows by id; the sleep scheduler's sweep walks
 * the windows past them (db/sleep.ts).
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

import type { SQL } from "bun";
import { blankProblem, commandLine, consoleWriter, flagList, numberProblem, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, databaseUrlProblem, NO_DATABASE_URL, openSql } from "./connect.ts";
import { staleStandings, staleStandingsText, STALE_STANDING_ROWS_SQL, type StaleStandingRow } from "../server-portable/consolidate.ts";

// Every argument accounted for (db/cli.ts, SMD-2134): a flag this door does not
// have is refused rather than ignored, and a blank --reason is refused as every
// flag's blank value is (it is recorded on every row marked).
const FLAGS = {
  url: "one", input: "one", reason: "one", fingerprints: "one", limit: "one",
  gone: "none", force: "none", orphans: "none", status: "none", "dry-run": "none",
} as const;
const HINTS = { url: "<postgres://…>", input: "<thought id>", reason: "<text> (with --input)", fingerprints: "<fp1,fp2> (with --gone)", limit: "<N> (with --orphans)", gone: "(with --input)", force: "(with --input)" };

/** --orphans' bound when none is given, and the most it takes. */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10000;

/**
 * One rebuild.ts run — the CLI's flags, typed (SMD-2304's engine shape,
 * SMD-2679): exactly one of `input`, `orphans` and `status`, as the CLI asks.
 * `fingerprints` is the list the CLI splits out of its comma-separated value.
 * `sql`, when given, is the caller's client, never closed here; otherwise one
 * connection is opened from `url`.
 */
export interface RebuildOptions {
  url?: string;
  sql?: SQL;
  input?: string;
  reason?: string;
  /** Passed as given — the CLI's trim and its dropping of empty items are the CLI's — but a blank item is refused, as the scanner refuses a blank value. */
  fingerprints?: readonly string[] | null;
  limit?: number;
  gone?: boolean;
  force?: boolean;
  orphans?: boolean;
  status?: boolean;
  dryRun?: boolean;
  writer?: Writer;
}

type Report = {
  ok: boolean; error?: string; id?: string;
  input: string; reason: string; input_gone: boolean; force: boolean;
  walked: number; depth: number; at_cap: boolean;
  rebuilt: number; enqueued: number; deleted: number; marked: number; unqueued: number; stale_proposals: number; kept: number; current: number; legacy: number;
  irreproducible: string[]; cascading: { proposals: number; lineage_rows: number }; pools: string[];
};

/** The worker that drains a pool, by the key's prefix (db/config.mjs's three key shapes, and subject.ts's subjectPoolKey). */
function drainer(pool: string): string {
  if (pool.startsWith("reembed:")) return "bun db/reembed.ts --url <url>";
  // The subject pool (113, SMD-3306): the rules' pool has no question in its key.
  if (pool.startsWith("subjects:")) return `bun db/extract-entities.ts --url <url> --subjects${pool.includes(":p") ? "" : " rules"}`;
  if (pool.startsWith("extract:")) return "bun db/extract-entities.ts --url <url>";
  if (pool.startsWith("consolidate:")) return "bun db/consolidate.ts --url <url>";
  return "(no worker in this tree drains this key)";
}

function printReport(r: Report, out: Writer["out"]): void {
  out(`  input:       ${r.input}${r.input_gone ? " (leaving — the row still stands; the caller deletes it)" : ""}`);
  out(`  reason:      ${r.reason}${r.force ? " (--force: every row treated as stale)" : ""}`);
  out(`  walked:      ${r.walked} lineage row(s) to depth ${r.depth}${r.at_cap ? " — the walk's cap; whatever stood beyond it is the next call's" : ""}`);
  out(`  rebuilt:     ${r.rebuilt} (a vector restored from the snapshot at the model — the one re-derivation the database owns${r.force ? "; or, under --force, a vector at the configured model whose text did not move, its record renewed" : ""})`);
  out(`  enqueued:    ${r.enqueued} (thought, pool) claim(s) for the workers`);
  out(`  deleted:     ${r.deleted} (lineage rows whose artifact is gone${r.input_gone ? "; the windows, the graph and the snapshot rows the input keyed" : ""})`);
  out(`  marked:      ${r.marked} lineage row(s) carry the reason until their producer writes again${r.unqueued ? `; ${r.unqueued} of them wait for no pool (the tags, a generated page section, or no configured model)` : ""}${r.stale_proposals ? `; ${r.stale_proposals} proposal(s) set stale — pending ones, and ones the consolidate pass itself had settled (067) — their status the mark; the next pass replaces one it finds in conflict again and settles one it does not` : ""}`);
  out(`  kept:        ${r.kept} (a structured pass reads its source, not the text; a person's decision on a proposal stands)`);
  out(`  current:     ${r.current} (nothing moved)${r.legacy ? `; ${r.legacy} legacy row(s) read current by construction — --force re-runs them` : ""}`);
  if (r.input_gone) out(`  cascade:     ${r.cascading.proposals} proposal(s) and ${r.cascading.lineage_rows} lineage row(s) go with the row delete (029's and 061's triggers)`);
  if (r.irreproducible.length) {
    out(`  irreproducible: ${r.irreproducible.length} derived_from child(ren) — prose no recipe re-runs; a human reviews them:`);
    for (const id of r.irreproducible) out(`    ${id}`);
  }
  if (r.pools.length) {
    out(`  pools:       ${r.pools.join(", ")}`);
    for (const p of r.pools) out(`    ${p}  →  ${drainer(p)}`);
  }
}

/** Whether rebuild_derived (migration 063) is on this brain. */
export async function hasRebuild(sql: SQL): Promise<boolean> {
  const [row] = (await sql`SELECT to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NOT NULL AS ok`) as { ok: boolean }[];
  return row.ok;
}

/**
 * Bun 1.4 binds a JS string[] to a text[] parameter as the bare text `a,b`
 * (run-it, first review pass: "malformed array literal"), so the Postgres
 * array literal is built here — each element quoted, quotes and backslashes
 * escaped — and bound as text.
 */
function fingerprintsLiteral(fps: readonly string[] | null): string | null {
  return fps ? "{" + fps.map((s) => `"${s.replace(/(["\\])/g, "\\$1")}"`).join(",") + "}" : null;
}

/** Thrown out of a dry run's transaction with its report, so the transaction rolls back. */
class DryRunReport {
  constructor(readonly report: Report) {}
}

/**
 * One call of rebuild_derived. A dry run makes it inside a transaction of its
 * own that is rolled back: one connection whatever the caller's client is,
 * where a bare BEGIN through a pool may land on one connection and the call
 * on another.
 */
async function callRebuild(sql: SQL, dry: boolean, id: string, reason: string, gone: boolean, fps: string | null, force: boolean, orphansOnly = false): Promise<Report> {
  const call = async (q: SQL): Promise<Report> => {
    const [row] = (await q`SELECT rebuild_derived(${id}::uuid, ${reason}::text, ${gone}::boolean, ${fps}::text::text[], ${force}::boolean, ${orphansOnly}::boolean) AS r`) as { r: Report }[];
    return row.r;
  };
  if (!dry) return call(sql);
  try {
    await sql.begin(async (tx) => {
      throw new DryRunReport(await call(tx as unknown as SQL));
    });
  } catch (e) {
    if (e instanceof DryRunReport) return e.report;
    throw e;
  }
  throw new Error("a dry run's transaction committed");
}

/**
 * What a sweep did: the thoughts read with an orphaned lineage row, those the
 * calls touched, the rows deleted over them, and the calls refused as a value;
 * `windowed` when the lineage table holds more rows than the read window
 * (LINEAGE_WINDOW), so orphans past it went unread — none found is then not
 * a clean table; `stopped` when the caller's signal ended it before every
 * thought read was called — a call it cut, rolled back, counted in none of
 * the others — or a replay's refusal did (stopOnReplay); `last`,
 * the window's last lineage row by id, where a next sweep's `after` picks up;
 * `failed`, the calls skipFailure passed over; `whole`, when every orphan the
 * window holds was called — nothing stopped it, and the limit did not cut it
 * — or every call made failed, so reading the window again would meet the
 * same thoughts and none past them (review pass 3).
 */
export type SweepResult = { thoughts: number; touched: number; deleted: number; refused: number; failed: number; windowed: boolean; stopped: boolean; whole: boolean; last: string | null };

/** The lineage rows a sweep or the census reads, in id order: the first LINEAGE_WINDOW. */
const LINEAGE_WINDOW = 10001;

/**
 * A lineage row `d` whose artifact is gone: no windows, no mentions or edges
 * under its key, no vector, no tags. One predicate for the census's count and
 * the sweep's read, so the two never disagree on what an orphan is.
 */
const orphaned = (sql: SQL) => sql`(
       (d.artifact_kind = 'chunks'   AND NOT EXISTS (SELECT 1 FROM thought_chunks c WHERE c.thought_id = d.artifact_id))
    OR (d.artifact_kind = 'entities' AND NOT EXISTS (SELECT 1 FROM thought_entities m WHERE m.thought_id = d.artifact_id AND m.extraction_key = d.produced_by)
                                     AND NOT EXISTS (SELECT 1 FROM ob1_entity_edges g WHERE g.thought_id = d.artifact_id AND g.extraction_key = d.produced_by))
    OR (d.artifact_kind = 'vector'   AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id AND t.embedding IS NOT NULL))
    OR (d.artifact_kind = 'metadata' AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id AND (t.metadata ? 'type' OR t.metadata ? 'topics'))))`;

/**
 * Whether `sql` is a transaction's handle (or a savepoint's, the same object):
 * a dry run is a transaction of its own, which Bun does not open inside one. A
 * transaction a caller opened with a raw BEGIN on a reserved connection is not
 * seen: the dry run's rollback would end it too, so pass none open.
 */
const inTransaction = (sql: SQL): boolean => typeof (sql as { savepoint?: unknown }).savepoint === "function";
const IN_TRANSACTION = "rebuild.ts's dry run is a transaction of its own, rolled back: pass the client itself or a reserved connection, not a transaction's handle";

/**
 * The orphan census alone: the thoughts, by id, holding a lineage row whose
 * artifact is gone, read from the window of LINEAGE_WINDOW lineage rows in id
 * order after `after` (the start when absent) — at most `limit` — with
 * `windowed` when rows lie past the window and `last`, its last row's id.
 * One statement, one snapshot: the window's count and its orphans read apart
 * could disagree, rows committed between them cutting a window the count said
 * was whole (review pass 2 of PR 1). One row past the window is read to tell
 * a table of exactly LINEAGE_WINDOW rows, read whole, from a larger one. In id
 * order, so successive windows walk the table: read in no order, every sleep
 * read the same first rows and an orphan past them was never found (SMD-2679
 * PR 3, review pass 1).
 */
export async function orphanCensus(sql: SQL, opts: { limit?: number; after?: string | null } = {}): Promise<{ ids: string[]; windowed: boolean; last: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const after = opts.after ? sql`WHERE id > ${opts.after}::uuid` : sql``;
  const [found] = (await sql`
    WITH w AS MATERIALIZED (SELECT id, artifact_kind, artifact_id, produced_by FROM derivations ${after} ORDER BY id LIMIT ${LINEAGE_WINDOW + 1}),
         al AS (SELECT * FROM w ORDER BY id LIMIT ${LINEAGE_WINDOW})
    SELECT (SELECT count(*)::int FROM w) AS n, (SELECT id::text FROM al ORDER BY id DESC LIMIT 1) AS last, ARRAY(
      SELECT DISTINCT d.artifact_id::text FROM al d
       WHERE EXISTS (SELECT 1 FROM thoughts t WHERE t.id = d.artifact_id) AND ${orphaned(sql)}
       ORDER BY 1 LIMIT ${limit}) AS ids`) as { n: number; last: string | null; ids: string[] }[];
  return { ids: found.ids, windowed: Number(found.n) > LINEAGE_WINDOW, last: found.last };
}

/**
 * The orphan sweep: the lineage rows whose artifact is gone while the thought
 * stands, grouped by the thought that keys them, then rebuild_derived once
 * per thought in its orphans-only mode, which deletes each such row and
 * touches no row whose artifact stands. It reads orphanCensus's window —
 * the first LINEAGE_WINDOW lineage rows after `after`, in id order
 * (`windowed` says when there were more) — and acts on at most `limit`
 * thoughts — an integer, held to 1..10,000. `onFound` is told how many were
 * read, before the first call. A refusal as a value (REPLAYING, NOT_FOUND) is
 * said through the writer and counted; a database error rejects, the calls
 * made before it kept. `signal` stops it between calls — the call in hand
 * finishes — and, aborted already, before its read (the sleep scheduler's
 * wake, SMD-2679). `stopOnReplay` stops it at the first REPLAYING refusal: a
 * session's state, which every call after would meet too. `skipFailure` is
 * asked of a call that throws, with its thought's id: true counts it
 * `failed` and goes on to the next thought, so one whose call always fails
 * does not end every sweep at it; false (and absent) rejects, the error
 * carrying the thought's id as `thought`. Needs 063 (hasRebuild).
 */
export async function sweepOrphans(sql: SQL, opts: { limit?: number; dryRun?: boolean; writer?: Writer; onFound?: (thoughts: number) => void; signal?: AbortSignal; after?: string | null; stopOnReplay?: boolean; skipFailure?: (e: unknown, thought: string) => boolean } = {}): Promise<SweepResult> {
  const { err } = opts.writer ?? consoleWriter;
  if (opts.limit != null && !Number.isInteger(opts.limit)) throw new RangeError(`sweepOrphans: limit must be an integer (${opts.limit})`);
  if (opts.dryRun === true && inTransaction(sql)) throw new Error(IN_TRANSACTION);
  if (opts.signal?.aborted) return { thoughts: 0, touched: 0, deleted: 0, refused: 0, failed: 0, windowed: false, stopped: true, whole: false, last: null };
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const census = await orphanCensus(sql, { limit: opts.limit, after: opts.after });
  const orphans = census.ids.map((id) => ({ id }));
  opts.onFound?.(orphans.length);
  let deleted = 0, touched = 0, refused = 0, failed = 0;
  let stopped = false;
  for (const o of orphans) {
    if (opts.signal?.aborted) {
      stopped = true;
      break;
    }
    // Orphans only: a stale row on the same thought keeps its own reason
    // for its own rebuild (cold read, first review pass). The sweep marks no
    // row, so its reason is the report's label only.
    let r: Report;
    try {
      r = await callRebuild(sql, opts.dryRun === true, o.id, "operator: orphan sweep", false, null, false, true);
    } catch (e) {
      // Cut by the caller's stop — the call cancelled under it — the sweep
      // keeps what it did, as a stop between calls does (review pass 3).
      if (opts.signal?.aborted) {
        stopped = true;
        break;
      }
      if (!opts.skipFailure?.(e, o.id)) {
        // Named, so the operator can find the thought (review pass 4 of PR 3).
        if (e !== null && typeof e === "object") (e as { thought?: string }).thought = o.id;
        throw e;
      }
      failed += 1;
      continue;
    }
    if (!r.ok) {
      err(`  ${o.id}: refused ${r.error}${r.error === "REPLAYING" ? " — this session is a replay (ob1.projecting_replay, a database- or role-level default); a rebuild is a live operation" : r.error === "NOT_FOUND" ? " — the thought went between the census and the call" : ""}`);
      refused += 1;
      if (opts.stopOnReplay && r.error === "REPLAYING") {
        stopped = true;
        break;
      }
      continue;
    }
    touched += 1;
    deleted += r.deleted;
  }
  return { thoughts: orphans.length, touched, deleted, refused, failed, windowed: census.windowed, stopped, whole: !stopped && (orphans.length < limit || failed === orphans.length), last: census.last };
}

/**
 * The door's run, callable: the CLI's, returning the code the CLI exits with
 * (the header's list). Its usage refusals come first, in the CLI's words and
 * order, before any connection is opened. Nothing happens at import.
 */
export async function run(opts: RebuildOptions): Promise<number> {
  const { out, err } = opts.writer ?? consoleWriter;
  // A blank value the CLI's scanner refuses, first, in its words and with its flag list.
  const blank = blankProblem(FLAGS, { input: opts.input, reason: opts.reason, fingerprints: opts.fingerprints });
  if (blank !== null) {
    err(`${blank}\n${flagList(FLAGS, HINTS)}`);
    return 2;
  }
  // databaseUrl's two refusals without its exit; a URL beside a caller's client is held to the rule too.
  const noUrl = opts.url == null || opts.url.trim() === "";
  const urlProblem = noUrl ? (opts.sql == null ? NO_DATABASE_URL : null) : databaseUrlProblem(opts.url as string);
  if (urlProblem !== null) {
    err(urlProblem);
    return 2;
  }
  // The scanner's digits rule, as the CLI reads --limit before the modes.
  const limitProblem = opts.limit == null ? null : numberProblem("--limit", opts.limit, { min: 0 });
  if (limitProblem !== null) {
    err(`${limitProblem}\n${flagList(FLAGS, HINTS)}`);
    return 2;
  }
  const INPUT = opts.input ?? undefined;
  const ORPHANS = opts.orphans === true;
  const STATUS = opts.status === true;
  const GONE = opts.gone === true;
  const FORCE = opts.force === true;
  const DRY = opts.dryRun === true;
  // Held to 1..10,000 as before: 0 reads as 1.
  const LIMIT = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const FINGERPRINTS = opts.fingerprints ?? null;
  const modes = [INPUT !== undefined, ORPHANS, STATUS].filter(Boolean).length;
  if (modes !== 1) {
    err("Say one thing: --input <id> [--reason …] [--gone [--fingerprints …]] [--force] [--dry-run] | --orphans [--limit N] [--dry-run] | --status");
    return 2;
  }
  // What is allowed, not what was given (cli.ts's rule): the value may be a URL given without --url.
  if (INPUT !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(INPUT)) {
    err("--input takes a thought id (a UUID)");
    return 2;
  }
  if ((GONE || FORCE || FINGERPRINTS) && INPUT === undefined) {
    err("--gone, --force and --fingerprints go with --input");
    return 2;
  }
  if (FINGERPRINTS && !GONE) {
    err("--fingerprints goes with --gone: the earlier texts' fingerprints are what a leaving thought's snapshot rows are found by");
    return 2;
  }
  const reasonRaw = opts.reason ?? undefined;
  // A flag outside its mode is a usage error, not a silent no-op (second
  // review pass: --reason on the sweep landed nowhere — the sweep marks no row).
  if (reasonRaw !== undefined && INPUT === undefined) {
    err("--reason goes with --input: the sweep marks no row and --status writes nothing, so there is nothing to record it on");
    return 2;
  }
  if (opts.limit != null && !ORPHANS) {
    err("--limit goes with --orphans");
    return 2;
  }
  if (DRY && STATUS) {
    err("--dry-run goes with --input or --orphans: --status writes nothing");
    return 2;
  }
  const REASON = reasonRaw ?? (GONE ? "operator: forget" : FORCE ? "operator: force" : "operator: edit");
  // A caller's transaction cannot hold the dry run's own (Bun refuses a begin
  // inside one), and failing at the first call said the dry run's line first.
  if (DRY && opts.sql != null && inTransaction(opts.sql)) {
    err(IN_TRANSACTION);
    return 2;
  }
  const sql = opts.sql ?? openSql(opts.url as string);
  try {
    return await rebuildWith(sql, { INPUT, STATUS, GONE, FORCE, DRY, LIMIT, REASON, FPS_LITERAL: fingerprintsLiteral(FINGERPRINTS) }, out, err);
  } finally {
    // A failing close must not mask the run's own code.
    if (opts.sql == null) await sql.close().catch(() => {});
  }
}

/** The run once its options are settled: the script's body as it was, printing through the Writer and returning where it exited. */
async function rebuildWith(sql: SQL, o: { INPUT: string | undefined; STATUS: boolean; GONE: boolean; FORCE: boolean; DRY: boolean; LIMIT: number; REASON: string; FPS_LITERAL: string | null }, out: Writer["out"], err: Writer["err"]): Promise<number> {
  const { INPUT, STATUS, GONE, FORCE, DRY, LIMIT, REASON, FPS_LITERAL } = o;
  try {
    if (!(await hasRebuild(sql))) {
      err("  rebuild_derived is not on this brain: migration 063 (SMD-1732) is missing. Apply it — cd db && bun migrate.ts --url <url> — and run again.");
      return 2;
    }
    if (STATUS) {
      const [c] = (await sql`
        WITH al AS (SELECT id, artifact_kind, artifact_id, produced_by, input_ids, input_fingerprints, recipe, stale_since FROM derivations ORDER BY id LIMIT ${LINEAGE_WINDOW}),
             st AS (SELECT d.id FROM al d JOIN thoughts t ON t.id = d.input_ids[1]
                     WHERE d.artifact_kind <> 'proposal' AND d.input_fingerprints[1] IS DISTINCT FROM COALESCE(t.content_fingerprint, content_fingerprint_of(t.content))),
             orph AS (SELECT d.id FROM al d WHERE ${orphaned(sql)})
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
      const bound = Number(c.rows) >= LINEAGE_WINDOW ? " (the first 10,001 lineage rows by id read; the rest not)" : "";
      out(`  lineage:     ${c.rows} row(s)${bound}: ${Object.entries(c.by_kind ?? {}).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
      out(`  stale:       ${c.stale} row(s) whose input's text moved since (the census's read) — bun db/rebuild.ts --input <id> acts on a thought's`);
      out(`  marked:      ${c.marked} row(s) await a re-run rebuild_derived asked for`);
      out(`  orphans:     ${c.orphans} row(s) whose artifact is gone${Number(c.orphans) ? " — bun db/rebuild.ts --orphans deletes them" : ""}`);
      out(`  legacy:      ${c.legacy} row(s) backfilled by 061 at the thought's current text (read as current; --force re-records a vector and re-runs the rest)`);
      out(`  proposals:   ${c.stale_proposals} stale (a text moved under the verdict${standings.total ? `: ${staleStandingsText(standings, null, "bun db/consolidate.ts --retry-failed")}` : ""}; the pass replaces one it finds in conflict again and settles one it does not — a reviewer may decide one sooner: bun db/consolidate.ts --list stale)`);
      const pools = (await sql`SELECT work_type AS w, count(*)::int AS n FROM thought_work_claims WHERE status = 'pending' GROUP BY 1 ORDER BY 1`) as { w: string; n: number }[];
      out(`  pools:       ${pools.length ? pools.map((p) => `${p.w} (${p.n} pending)`).join(", ") : "nothing pending"}`);
      for (const p of pools) out(`    ${p.w}  →  ${drainer(p.w)}`);
      return 0;
    }
    if (INPUT !== undefined) {
      if (DRY) out("  dry run: the call runs and rolls back — the report is what it would do");
      const r = await callRebuild(sql, DRY, INPUT, REASON, GONE, FPS_LITERAL, FORCE);
      if (!r.ok) {
        err(`  refused: ${r.error}${r.error === "NOT_FOUND" ? " — no thought has this id" : r.error === "REPLAYING" ? " — this session is a replay (ob1.projecting_replay); a rebuild is a live operation" : ""}`);
        return 1;
      }
      printReport(r, out);
      return 0;
    }
    // --orphans: the rows whose artifact is gone, grouped by the thought that
    // keys them; one call per thought.
    const s = await sweepOrphans(sql, { limit: LIMIT, dryRun: DRY, writer: { out, err }, onFound: (n) => { if (n && DRY) out("  dry run: each call runs and rolls back"); } });
    if (s.thoughts === 0) {
      // A table larger than the window read is no clean one (review pass 2 of PR 3).
      out(`  orphans: none — every lineage row read names an artifact that stands${s.windowed ? "; the read took the first 10,001 by id, the table holds more, and a running sleep scheduler walks the rest" : ""}`);
      return 0;
    }
    out(`  orphans:     ${s.thoughts} thought(s) carried a lineage row whose artifact is gone${s.thoughts >= LIMIT ? ` (the first ${LIMIT}; run again for the rest)` : ""}${s.windowed ? " — in the first 10,001 lineage rows by id; the table holds more, and a running sleep scheduler walks the rest" : ""}`);
    out(`  deleted:     ${s.deleted} lineage row(s) over ${s.touched} thought(s)${DRY ? " (rolled back)" : ""} — nothing else on those thoughts was touched${s.refused ? `; ${s.refused} call(s) refused (above)` : ""}`);
    // A refusal as a value is exit 1 here as under --input (fourth review pass).
    return s.refused ? 1 : 0;
  } catch (e) {
    const on = (e as { thought?: string }).thought;
    err(`  failed${on ? ` on thought ${on}` : ""}: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  const cli = commandLine("rebuild.ts", FLAGS, { hints: HINTS });
  const url = databaseUrl(cli.value("url"));
  // The scanner's digits rule, before the modes, as the script read it.
  const limit = cli.has("limit") ? cli.int("limit", { absent: DEFAULT_LIMIT, min: 0 }) : undefined;
  // One connection, opened lazily: a refusal before the first query opens none.
  const sql = openSql(url);
  await closeThenExit(sql, async () => {
    return run({
      sql, url, limit,
      input: cli.value("input"),
      reason: cli.value("reason"),
      fingerprints: cli.value("fingerprints")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
      gone: cli.has("gone"), force: cli.has("force"), orphans: cli.has("orphans"), status: cli.has("status"), dryRun: cli.has("dry-run"),
    });
  });
}
