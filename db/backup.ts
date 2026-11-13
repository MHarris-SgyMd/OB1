#!/usr/bin/env bun
/**
 * backup.ts — the brain's thoughts and its entity graph as JSON files, one per
 * table, read from one snapshot (SMD-3318).
 *
 *   bun db/backup.ts --url postgres://…                 # ./backup/<table>-YYYY-MM-DD.json
 *   bun db/backup.ts --url … --out /srv/brain-backups    # another directory
 *
 * This is the `db/` home for what `recipes/brain-backup/backup-brain.mjs` did
 * through compat/supabase-sql (SMD-2144), which retires (SMD-3216). The files
 * keep that recipe's shape — a JSON array of rows per table, named
 * `<table>-<UTC date>.json` — and its tables become the core's:
 *
 *   thoughts, ob1_entities, thought_entities, ob1_entity_edges
 *
 * (migrations 001 and 016, so every brain has them). The recipe read
 * `entities` and `edges`, which no Daemonic Brain has, and the retired
 * smart-ingest schema's two tables; it skipped a table that was not there.
 * Here a missing table is a brain not migrated, and the run refuses.
 *
 * ── What a run guarantees ───────────────────────────────────────────────────
 * One snapshot. Every table is read in one REPEATABLE READ, READ ONLY
 * transaction, so the four files agree with each other — a mention never
 * names a thought the thoughts file lacks — and a run never writes. A role
 * with SELECT on the four tables is enough.
 *
 * Postgres's own JSON. Each row is `to_jsonb(row)`, written as Postgres
 * renders it: timestamps keep their microseconds and offset, numerics their
 * digits, a vector its text form — what `jsonb_populate_record(NULL::<table>,
 * row)` reads back into the same values (db/test-live.ts [50] holds the round
 * trip). The recipe's rows went through JavaScript, which cut timestamps to
 * milliseconds.
 *
 * Every row once. Pages of 1,000 follow the table's primary key (keyset, not
 * OFFSET), and each table's rows written are compared with its count(*) in the
 * same snapshot; a difference fails the run.
 *
 * All or nothing. Each table is written to `<file>.tmp`; only when every table
 * is written and counted are the four renamed into place. A run that fails
 * leaves the directory as it found it — an earlier backup of the same date
 * included — and exits 1 with the database's reason.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 * Not the whole brain: thought_audit, the sources, facets, claims, relations,
 * the plugins' schemas and the rest are not here. `pg_dump` is the whole-brain
 * backup (recipes/brain-backup/README.md says how). Nor a restore: nothing
 * here reads the files back into a brain.
 *
 * statement_timeout is 60 s a statement for the run, as the recipe's per-page
 * bound was: a page past it fails the run, and the server cancels the query.
 */

import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SQL } from "bun";
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, openSql } from "./connect.ts";

/** A table the backup writes, and its primary key in order: the keyset's columns. */
export interface BackupTable {
  readonly name: string;
  readonly key: readonly string[];
}

/** The tables, in the order they are read and summarised. */
export const BACKUP_TABLES: readonly BackupTable[] = [
  { name: "thoughts", key: ["id"] },
  { name: "ob1_entities", key: ["id"] },
  { name: "thought_entities", key: ["thought_id", "entity_id"] },
  { name: "ob1_entity_edges", key: ["thought_id", "from_entity_id", "to_entity_id", "relation"] },
];

/** Rows per page. */
export const PAGE_SIZE = 1000;

/** The per-statement bound, for the run's connection. */
export const STATEMENT_TIMEOUT = "60s";

export interface BackupOptions {
  /** A client on the brain; one connection is enough, and the run holds it in one transaction. */
  sql: SQL;
  /** The directory the files go to; made if absent. */
  out: string;
  /** The UTC date in the file names; today's by default. */
  date?: string;
  /** Rows per page; PAGE_SIZE by default (the live suite pages small to cross a page). */
  pageSize?: number;
  writer?: Writer;
  /** Awaited after each table is written and counted, inside the snapshot: the live suite's door to write between tables ([50]). */
  afterTable?: (t: TableResult) => Promise<void>;
}

/** One table's outcome. */
export interface TableResult {
  table: string;
  rows: number;
  bytes: number;
  file: string;
}

/** `n` bytes for people. */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * The page query for `t`: the next `limit` rows after the key `$1…$n` (none on
 * the first page), each as Postgres's JSON text beside its key columns as text.
 * The names are this file's constants, never input.
 */
export function pageQuery(t: BackupTable, first: boolean): string {
  const cols = t.key.map((c) => `r.${c}`).join(", ");
  const keys = t.key.map((c, i) => `r.${c}::text AS k${i}`).join(", ");
  const after = first ? "" : ` WHERE (${cols}) > (${t.key.map((_, i) => `$${i + 1}`).join(", ")})`;
  const limit = `$${first ? 1 : t.key.length + 1}`;
  return `SELECT to_jsonb(r)::text AS j, ${keys} FROM ${t.name} r${after} ORDER BY ${cols} LIMIT ${limit}`;
}

/** Write a file's tmp sibling page by page; returns the rows written. Throws with the tmp file removed. */
async function writeTable(tx: SQL, t: BackupTable, tmp: string, pageSize: number): Promise<number> {
  const fd = openSync(tmp, "w", 0o600);
  let rows = 0;
  try {
    writeSync(fd, "[");
    let after: string[] | null = null;
    for (;;) {
      const page = (await tx.unsafe(pageQuery(t, after === null), after === null ? [pageSize] : [...after, pageSize])) as Record<string, string>[];
      for (const r of page) {
        writeSync(fd, `${rows === 0 ? "\n" : ",\n"}${r.j}`);
        rows++;
      }
      if (page.length < pageSize) break;
      const last = page[page.length - 1];
      after = t.key.map((_, i) => last[`k${i}`]);
    }
    writeSync(fd, rows === 0 ? "]\n" : "\n]\n");
  } catch (e) {
    try { closeSync(fd); } catch { /* the write's error is the one to report */ }
    try { unlinkSync(tmp); } catch { /* not there */ }
    throw e;
  }
  closeSync(fd);
  return rows;
}

/** The SQLSTATE and message of a database error, else the message. */
function reasonOf(e: unknown): string {
  const err = e as { errno?: unknown; code?: unknown; message?: unknown };
  const state = typeof err?.errno === "string" && /^[0-9A-Z]{5}$/.test(err.errno) ? `${err.errno} ` : "";
  return `${state}${String(err?.message ?? e).split("\n")[0]}`;
}

/**
 * The backup: every table of BACKUP_TABLES from one snapshot, written and
 * counted, then renamed into place. Returns the exit code: 0 written, 1 not
 * (nothing renamed, every tmp file removed).
 */
export async function run(opts: BackupOptions): Promise<number> {
  const w = opts.writer ?? consoleWriter;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const out = resolve(opts.out);
  try {
    if (!existsSync(out)) mkdirSync(out, { recursive: true, mode: 0o700 });
  } catch (e) {
    w.err(`backup: cannot make ${out}: ${reasonOf(e)}`);
    return 1;
  }
  w.out(`Brain backup — ${date}, to ${out}`);
  const results: TableResult[] = [];
  const tmps: string[] = [];
  try {
    await opts.sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (tx) => {
      for (const t of BACKUP_TABLES) {
        const file = join(out, `${t.name}-${date}.json`);
        const tmp = `${file}.tmp`;
        tmps.push(tmp);
        try {
          const rows = await writeTable(tx as unknown as SQL, t, tmp, pageSize);
          const [{ n }] = (await tx.unsafe(`SELECT count(*)::bigint::text AS n FROM ${t.name}`)) as { n: string }[];
          if (String(rows) !== n) throw new Error(`wrote ${rows} row(s) of ${n} — the pages missed or repeated rows`);
          const result = { table: t.name, rows, bytes: statSync(tmp).size, file };
          results.push(result);
          w.out(`  ${t.name}: ${rows} row(s)`);
          await opts.afterTable?.(result);
        } catch (e) {
          throw new Error(`${t.name}: ${reasonOf(e)}`);
        }
      }
    });
  } catch (e) {
    for (const tmp of tmps) {
      try { unlinkSync(tmp); } catch { /* written by no page, or removed by writeTable */ }
    }
    w.err(`backup FAILED — ${reasonOf(e)}. Nothing was written: ${out} is as it was.`);
    return 1;
  }
  for (const r of results) renameSync(`${r.file}.tmp`, r.file);
  const width = Math.max(...results.map((r) => r.table.length), 5) + 2;
  w.out("");
  w.out(`${"Table".padEnd(width)}${"Rows".padStart(10)}${"Size".padStart(11)}`);
  for (const r of results) w.out(`${r.table.padEnd(width)}${String(r.rows).padStart(10)}${humanSize(r.bytes).padStart(11)}`);
  w.out(`${"Total".padEnd(width)}${String(results.reduce((s, r) => s + r.rows, 0)).padStart(10)}${humanSize(results.reduce((s, r) => s + r.bytes, 0)).padStart(11)}`);
  w.out(`Done: ${results.length} table(s) from one snapshot, in ${out}.`);
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cli = commandLine(
    "backup.ts",
    { url: "one", out: "one" },
    { hints: { url: "<postgres://…>", out: "<directory> (./backup)" } },
  );
  const url = databaseUrl(cli.value("url"));
  const sql = openSql(url, { max: 1, session: { statement_timeout: STATEMENT_TIMEOUT } });
  const out = cli.value("out") ?? "backup";
  await closeThenExit(sql, async () => {
    return run({ sql, out });
  });
}
