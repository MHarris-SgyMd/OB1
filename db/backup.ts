#!/usr/bin/env bun
/**
 * backup.ts — the brain's thoughts and its entity graph as JSON files, one per
 * table, read from one snapshot (SMD-3318).
 *
 *   bun db/backup.ts --url postgres://… --out /srv/brain-backups   # <out>/<table>-YYYY-MM-DD.json
 *   bun db/backup.ts --url …                                       # ./backup, under the working directory
 *   bun db/backup.ts --url … --out … --statement-timeout 600       # a longer per-statement bound; 0 for none
 *
 * This is the `db/` home for what `recipes/brain-backup/backup-brain.mjs` did
 * through compat/supabase-sql (SMD-2144), which retires (SMD-3216). The files
 * keep that recipe's shape — a JSON array of rows per table, named
 * `<table>-<UTC date>.json` — and its tables:
 *
 *   thoughts, ob1_entities, thought_entities, ob1_entity_edges   always (migrations 001 and 016)
 *   entities, edges                                               when present (schemas/entity-extraction)
 *   ingestion_jobs, ingestion_items                               when present (the retired smart-ingest schema)
 *
 * A core table missing is a brain not migrated, and the run refuses. The
 * recipe read `entities` and `edges` in place of 016's tables, which it did
 * not know; it skipped any table that was not there.
 *
 * ── What a run guarantees ───────────────────────────────────────────────────
 * The database the URL names. The run refuses (exit 2) when the connection
 * reached another — PGDATABASE beats the URL's database in Bun's client — and
 * its first line names the database it reads.
 *
 * One snapshot. Every table is read in one REPEATABLE READ, READ ONLY
 * transaction, so the files agree with each other — a mention never names a
 * thought the thoughts file lacks — and a run never writes. A role with SELECT
 * on the tables is enough. The snapshot holds back vacuum's horizon for the
 * run's length, as pg_dump's does.
 *
 * Postgres's own JSON. Each row is `to_jsonb(row)`, written as Postgres
 * renders it: timestamps keep their microseconds and offset, numerics are JSON
 * numbers with their digits, a vector is its text form — what
 * `jsonb_populate_record(NULL::<table>, row)` reads back into the same values
 * (db/test-live.ts [50] holds the round trip). The recipe's rows went through
 * JavaScript, which cut timestamps to milliseconds and wrote numerics as
 * strings.
 *
 * Every row once. Pages of 1,000 follow the table's primary key (keyset, not
 * OFFSET), and each table's rows written are compared with its count(*) in the
 * same snapshot; a difference fails the run.
 *
 * Nothing in place until the reads are done. Each table is written to a file
 * of this run's own (`<file>.<pid>.tmp`, created new: an existing path there,
 * a symlink included, fails the run rather than being written through), and
 * renamed into place only once every table is written and counted. A run that
 * fails before that point leaves the directory as it found it — an earlier
 * backup of the same date included, and the directory itself removed if the
 * run made it — and exits 1 naming the table and the database's reason. A
 * rename that fails after it is said, naming the files already replaced; the
 * rest of the run's files are removed. SIGINT and SIGTERM remove them too.
 *
 * ── What it is not ──────────────────────────────────────────────────────────
 * Not the whole brain: thought_audit, the sources, facets, claims, relations,
 * the plugins' schemas and the rest are not here. `pg_dump` is the whole-brain
 * backup (recipes/brain-backup/README.md says how). Nor a restore: nothing
 * here reads the files back into a brain.
 *
 * statement_timeout is 60 s a statement by default (--statement-timeout; the
 * recipe's FETCH_TIMEOUT_MS was its per-page bound): a page past it fails the
 * run, and the server cancels the query. The count(*)s run unbounded — on a
 * large brain a count is longer than a page. A page is held in memory whole:
 * 1,000 rows, so about a gigabyte for 1 MB thoughts.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SQL } from "bun";
import { commandLine, consoleWriter, type Writer } from "./cli.ts";
import { closeThenExit, databaseUrl, openSql, reachedDatabaseRefusal } from "./connect.ts";

/** A table the backup writes, its primary key in order (the keyset's columns), and whether a brain may lack it. */
export interface BackupTable {
  readonly name: string;
  readonly key: readonly string[];
  readonly optional?: true;
}

/** The tables, in the order they are read and summarised. */
export const BACKUP_TABLES: readonly BackupTable[] = [
  { name: "thoughts", key: ["id"] },
  { name: "ob1_entities", key: ["id"] },
  { name: "thought_entities", key: ["thought_id", "entity_id"] },
  { name: "ob1_entity_edges", key: ["thought_id", "from_entity_id", "to_entity_id", "relation"] },
  { name: "entities", key: ["id"], optional: true },
  { name: "edges", key: ["id"], optional: true },
  { name: "ingestion_jobs", key: ["id"], optional: true },
  { name: "ingestion_items", key: ["id"], optional: true },
];

/** Rows per page. */
export const PAGE_SIZE = 1000;

/** The per-statement bound by default, in seconds. */
export const STATEMENT_TIMEOUT_S = 60;

export interface BackupOptions {
  /** A client on the brain; one connection is enough, and the run holds it in one transaction. */
  sql: SQL;
  /** The directory the files go to; made if absent. */
  out: string;
  /** The URL the client was opened on: the run refuses when the connection reached another database. */
  url?: string;
  /** The UTC date in the file names; today's by default. */
  date?: string;
  /** Rows per page; PAGE_SIZE by default (the live suite pages small to cross a page). */
  pageSize?: number;
  /** The per-statement bound the client's session carries, in seconds (0: none); the counts lift it and put it back. */
  statementTimeoutS?: number;
  writer?: Writer;
  /** Awaited after each table is written and counted, inside the snapshot: the live suite's door to write between tables ([50]). */
  afterTable?: (t: TableResult) => Promise<void>;
}

/** One table's outcome: written (rows, bytes, the page queries it took), or not on this brain. */
export interface TableResult {
  table: string;
  rows: number;
  bytes: number;
  pages: number;
  file: string;
  absent?: true;
}

/** This process's files not yet renamed into place: removed on a failed run and on SIGINT/SIGTERM. */
export const pendingFiles = new Set<string>();

/** Remove every pending file; what cannot be removed is left. */
export function removePending(): void {
  for (const f of pendingFiles) {
    try { unlinkSync(f); } catch { /* gone already */ }
    pendingFiles.delete(f);
  }
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

/** Write table `t` to `path`, created new, page by page; returns the rows and the page queries. Throws with the file left to the caller. */
async function writeTable(tx: SQL, t: BackupTable, path: string, pageSize: number): Promise<{ rows: number; pages: number }> {
  // "wx": O_CREAT|O_EXCL — never an existing file's mode, never through a symlink.
  const fd = openSync(path, "wx", 0o600);
  pendingFiles.add(path);
  let rows = 0, pages = 0;
  try {
    writeSync(fd, "[");
    let after: string[] | null = null;
    for (;;) {
      const page = (await tx.unsafe(pageQuery(t, after === null), after === null ? [pageSize] : [...after, pageSize])) as Record<string, string>[];
      pages++;
      for (const r of page) {
        writeSync(fd, `${rows === 0 ? "\n" : ",\n"}${r.j}`);
        rows++;
      }
      if (page.length < pageSize) break;
      const last = page[page.length - 1];
      after = t.key.map((_, i) => last[`k${i}`]);
    }
    writeSync(fd, rows === 0 ? "]\n" : "\n]\n");
  } finally {
    closeSync(fd);
  }
  return { rows, pages };
}

/** The SQLSTATE and message of a database error, else the message. */
function reasonOf(e: unknown): string {
  const err = e as { errno?: unknown; code?: unknown; message?: unknown };
  const state = typeof err?.errno === "string" && /^[0-9A-Z]{5}$/.test(err.errno) ? `${err.errno} ` : "";
  return `${state}${String(err?.message ?? e).split("\n")[0]}`;
}

/**
 * The backup: every table of BACKUP_TABLES the brain has, from one snapshot,
 * written and counted, then renamed into place. Returns the exit code: 0
 * written, 1 not (or not all renamed: said), 2 the connection reached another
 * database than `url` names.
 */
export async function run(opts: BackupOptions): Promise<number> {
  const w = opts.writer ?? consoleWriter;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const timeout = opts.statementTimeoutS ?? STATEMENT_TIMEOUT_S;
  const out = resolve(opts.out);
  const results: TableResult[] = [];
  let made = false;
  try {
    await opts.sql.begin("ISOLATION LEVEL REPEATABLE READ READ ONLY", async (txn) => {
      const tx = txn as unknown as SQL;
      const [{ db }] = (await tx.unsafe("SELECT pg_catalog.current_database() AS db")) as { db: string }[];
      if (opts.url !== undefined) {
        const refusal = await reachedDatabaseRefusal(tx, opts.url);
        if (refusal !== null) throw Object.assign(new Error(refusal), { refused: true });
      }
      if (!existsSync(out)) {
        mkdirSync(out, { recursive: true, mode: 0o700 });
        made = true;
      }
      w.out(`Brain backup — ${date}, database ${db}, to ${out}`);
      for (const t of BACKUP_TABLES) {
        const file = join(out, `${t.name}-${date}.json`);
        try {
          if (t.optional) {
            const [{ here }] = (await tx.unsafe("SELECT to_regclass($1) IS NOT NULL AS here", [t.name])) as { here: boolean }[];
            if (!here) {
              results.push({ table: t.name, rows: 0, bytes: 0, pages: 0, file, absent: true });
              w.out(`  ${t.name}: not on this brain`);
              continue;
            }
          }
          const tmp = `${file}.${process.pid}.tmp`;
          const { rows, pages } = await writeTable(tx, t, tmp, pageSize);
          // The count reads the whole table: unbounded, then the page bound back.
          await tx.unsafe("SET LOCAL statement_timeout = 0");
          const [{ n }] = (await tx.unsafe(`SELECT count(*)::bigint::text AS n FROM ${t.name}`)) as { n: string }[];
          await tx.unsafe(`SET LOCAL statement_timeout = '${timeout}s'`);
          if (String(rows) !== n) throw new Error(`wrote ${rows} row(s) of ${n} — the pages missed or repeated rows`);
          const result = { table: t.name, rows, bytes: statSync(tmp).size, pages, file };
          results.push(result);
          w.out(`  ${t.name}: ${rows} row(s)`);
          await opts.afterTable?.(result);
        } catch (e) {
          throw new Error(`${t.name}: ${reasonOf(e)}`);
        }
      }
    });
  } catch (e) {
    removePending();
    if (made && readdirSync(out).length === 0) rmdirSync(out);
    if ((e as { refused?: boolean }).refused) {
      w.err(`backup refused — ${(e as Error).message}.`);
      return 2;
    }
    w.err(`backup FAILED — ${reasonOf(e)}. Nothing was written: ${made ? `${out}, which this run made, is removed` : `${out} is as it was`}.`);
    return 1;
  }
  const written = results.filter((r) => !r.absent);
  const replaced: string[] = [];
  for (const r of written) {
    const tmp = `${r.file}.${process.pid}.tmp`;
    try {
      renameSync(tmp, r.file);
      pendingFiles.delete(tmp);
      replaced.push(r.file);
    } catch (e) {
      removePending();
      w.err(`backup FAILED renaming ${r.file} into place: ${reasonOf(e)}. ${replaced.length === 0 ? "No file was replaced" : `Already replaced: ${replaced.join(", ")}`}; this run's other files are removed.`);
      return 1;
    }
  }
  const width = Math.max(...results.map((r) => r.table.length), 5) + 2;
  w.out("");
  w.out(`${"Table".padEnd(width)}${"Rows".padStart(10)}${"Size".padStart(11)}`);
  for (const r of written) w.out(`${r.table.padEnd(width)}${String(r.rows).padStart(10)}${humanSize(r.bytes).padStart(11)}`);
  w.out(`${"Total".padEnd(width)}${String(written.reduce((s, r) => s + r.rows, 0)).padStart(10)}${humanSize(written.reduce((s, r) => s + r.bytes, 0)).padStart(11)}`);
  const absent = results.filter((r) => r.absent).map((r) => r.table);
  w.out(`Done: ${written.length} table(s) from one snapshot, in ${out}.${absent.length ? ` Not on this brain: ${absent.join(", ")}.` : ""}`);
  return 0;
}

// ── CLI ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const cli = commandLine(
    "backup.ts",
    { url: "one", out: "one", "statement-timeout": "one" },
    { hints: { url: "<postgres://…>", out: "<directory> (./backup, under the working directory)", "statement-timeout": `<seconds> (${STATEMENT_TIMEOUT_S}; 0: none)` } },
  );
  const url = databaseUrl(cli.value("url"));
  const timeout = cli.int("statement-timeout", { absent: STATEMENT_TIMEOUT_S, min: 0, max: 2147483 });
  const out = cli.value("out") ?? "backup";
  // A stop mid-run takes this run's unfinished files with it.
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.on(sig, () => {
      removePending();
      process.exit(code);
    });
  }
  const sql = openSql(url, { max: 1, session: { statement_timeout: `${timeout}s` } });
  await closeThenExit(sql, async () => {
    return run({ sql, out, url, statementTimeoutS: timeout });
  });
}
