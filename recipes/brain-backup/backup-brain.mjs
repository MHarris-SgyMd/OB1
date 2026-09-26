#!/usr/bin/env bun
// ob1-fork (SMD-2144): this script paged PostgREST's `/<table>` route with a
// service-role key, and this fork's stack runs no PostgREST. It reads the same
// pages through compat/supabase-sql now — SUPABASE_URL is a postgres:// connection
// string, SUPABASE_SERVICE_ROLE_KEY is accepted and ignored (the credentials live
// in the URL), and a table that is not there is Postgres's 42P01 where PostgREST
// answered PGRST205. The files it writes are the same. Run it from a checkout:
// the import below is relative to this file.
/**
 * backup-brain.mjs -- Export the Open Brain tables to local JSON files.
 *
 * Paginates through the brain's Postgres (1000 rows per query) and writes each
 * table to backup/<table>-YYYY-MM-DD.json. Shows progress and prints a summary.
 *
 * Usage:
 *   bun backup-brain.mjs
 *
 * The script reads SUPABASE_URL (a postgres:// connection string) from the
 * environment or from a .env.local file in the current directory.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "../../compat/supabase-sql/index.ts";

const SCRIPT_DIR = process.cwd();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

// Stock Open Brain only has `thoughts`. The other tables are from optional
// companion contributions (entity extraction, smart ingest). Missing tables
// are skipped at runtime so this recipe works against any Open Brain install.
// On this fork the companions are `schemas/entity-extraction` (entities, edges;
// thought_entities is migration 016's on a fork brain) and `schemas/smart-ingest`
// (ingestion_jobs, ingestion_items); the fork's own tables — thought_audit,
// thought_sources, thought_facets, ob1_entities and the rest — are not in this
// list, and `pg_dump` is the whole-brain backup (README).
const TABLES = [
  { name: "thoughts",         orderBy: "id", required: true  },
  { name: "entities",         orderBy: "id", required: false },
  { name: "edges",            orderBy: "id", required: false },
  { name: "thought_entities", orderBy: "thought_id,entity_id", required: false },
  { name: "ingestion_jobs",   orderBy: "id", required: false },
  { name: "ingestion_items",  orderBy: "id", required: false },
];

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

function loadEnvFile() {
  const envPath = path.join(SCRIPT_DIR, ".env.local");
  const vars = {};
  if (fs.existsSync(envPath)) {
    let isFirstLine = true;
    for (let line of fs.readFileSync(envPath, "utf8").split("\n")) {
      // Strip UTF-8 BOM from the first line -- Notepad and some VS Code
      // configurations on Windows write it, which would otherwise poison
      // the first key name (e.g. "\uFEFFSUPABASE_URL") and cause a
      // confusing "SUPABASE_URL not found" even though it's right there.
      if (isFirstLine && line.charCodeAt(0) === 0xFEFF) line = line.slice(1);
      isFirstLine = false;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1).replace(/^['"]|['"]$/g, "");
      }
    }
  }
  return vars;
}

const envVars = loadEnvFile();

const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  envVars.SUPABASE_URL ||
  "";

// Read for the callers that still set it; the shim ignores it (SMD-2144).
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  envVars.SUPABASE_SERVICE_ROLE_KEY ||
  "";

// A https://….supabase.co URL is refused before any query, with the shim's own
// explanation. No process.exit() anywhere in this file: the exit code is set
// and the process ends on its own once the pool is closed (SMD-2144).
let client = null;
if (!SUPABASE_URL) {
  console.error(
    "ERROR: SUPABASE_URL not found.\n" +
    "Either export it or add it to .env.local in the current directory " +
    "(a postgres:// connection string on this fork)."
  );
} else {
  try {
    client = createClient(SUPABASE_URL, SERVICE_KEY || undefined);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
  }
}

// Bounded per-query timeout. Unattended backup jobs must either finish or
// fail within a predictable window -- a hung connection should not keep a
// cron job alive forever. 60s is generous for a 1000-row page; override with
// FETCH_TIMEOUT_MS for slow tiers or very large tables. A page that times out
// is abandoned, not cancelled: the query stays in flight on its connection, so
// the run ends the process itself at the end rather than waiting on the pool
// (review pass 1, cold read).
let timedOut = false;
const FETCH_TIMEOUT_MS = (() => {
  const raw =
    process.env.FETCH_TIMEOUT_MS ||
    envVars.FETCH_TIMEOUT_MS ||
    "";
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Fetch a single page of rows from a table. */
async function fetchPage(table, orderBy, offset, limit) {
  // One query per page: the rows ordered by the table's key, the window
  // `range` cuts (inclusive on both ends, as PostgREST's Range was), and the
  // table's exact count beside them.
  let query = client.from(table).select("*", { count: "exact" });
  for (const col of orderBy.split(",")) query = query.order(col.trim());
  query = query.range(offset, offset + limit - 1);

  // The driver has no per-query timeout. The race below gives up on the page
  // after FETCH_TIMEOUT_MS; the connection is closed with the pool at exit.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `Query for ${table} timed out after ${FETCH_TIMEOUT_MS} ms ` +
      `(raise FETCH_TIMEOUT_MS if this table is legitimately slow)`
    )), FETCH_TIMEOUT_MS);
  });
  let result;
  try {
    result = await Promise.race([query, timeout]);
  } catch (err) {
    timedOut = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (result.error) {
    // 42P01, "relation does not exist", is the one condition that means "table
    // not present" — an optional companion table this brain never applied. Any
    // other error (a role without SELECT on the table, a bad column name, a
    // dropped connection) should surface loudly, not be silently treated as
    // "table missing" -- that's how backup tools lose data without anyone
    // noticing.
    if (result.error.code === "42P01") {
      return { rows: [], total: null, missing: true };
    }
    throw new Error(`Postgres error ${result.error.code ?? ""} on ${table}: ${result.error.message}`.replace("  ", " "));
  }

  return { rows: result.data ?? [], total: result.count };
}

/** Export one table, streaming rows to disk. */
async function exportTable(tableName, orderBy, backupDir, dateStr, required) {
  const filePath = path.join(backupDir, `${tableName}-${dateStr}.json`);
  // Write to a sibling .tmp file and atomically rename on success. Any crash
  // (network error, process kill) leaves only the .tmp behind, so yesterday's
  // valid backup is never overwritten by today's partial one.
  const tmpPath = `${filePath}.tmp`;
  let offset = 0;
  let total = null;
  let rowCount = 0;

  const first = await fetchPage(tableName, orderBy, 0, PAGE_SIZE);

  const label = `  ${tableName}`;
  if (first.missing) {
    if (required) {
      throw new Error(`Required table "${tableName}" not found in the database`);
    }
    process.stdout.write(`${label}: skipped (table not present)\n`);
    return { rowCount: 0, filePath: null, fileSize: 0, skipped: true };
  }

  total = first.total;

  if (first.rows.length === 0) {
    process.stdout.write(`${label}: 0 rows (empty table)\n`);
    // Even the two-byte "[]" path writes via tmp+rename so we never leave a
    // half-written file in the final location.
    try {
      fs.writeFileSync(tmpPath, "[]");
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
    return { rowCount: 0, filePath, fileSize: 2 };
  }

  const fd = fs.openSync(tmpPath, "w");
  let closed = false;
  try {
    fs.writeSync(fd, "[\n");
    let firstRow = true;

    function writeRows(rows) {
      for (const row of rows) {
        if (!firstRow) fs.writeSync(fd, ",\n");
        fs.writeSync(fd, JSON.stringify(row));
        firstRow = false;
        rowCount++;
      }
    }

    writeRows(first.rows);
    process.stdout.write(
      `${label}: ${rowCount}${total != null ? "/" + total : ""} rows\r`
    );

    let lastPageSize = first.rows.length;
    offset = PAGE_SIZE;
    while (lastPageSize === PAGE_SIZE && (total == null || offset < total)) {
      const page = await fetchPage(tableName, orderBy, offset, PAGE_SIZE);
      lastPageSize = page.rows.length;
      if (lastPageSize === 0) break;
      writeRows(page.rows);
      offset += lastPageSize;

      process.stdout.write(
        `${label}: ${rowCount}${total != null ? "/" + total : ""} rows\r`
      );
    }

    fs.writeSync(fd, "\n]");
    fs.closeSync(fd);
    closed = true;

    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (!closed) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }

  const fileSize = fs.statSync(filePath).size;

  process.stdout.write(
    `${label}: ${rowCount} rows (${humanSize(fileSize)})               \n`
  );

  return { rowCount, filePath, fileSize };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dateStr = today();
  const backupDir = path.join(SCRIPT_DIR, "backup");

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`Created ${backupDir}`);
  }

  console.log(`\nOpen Brain Backup -- ${dateStr}`);
  console.log(`Target: ${backupDir}\n`);

  const results = [];
  for (const table of TABLES) {
    try {
      const result = await exportTable(table.name, table.orderBy, backupDir, dateStr, table.required);
      results.push({ table: table.name, ...result });
    } catch (err) {
      console.error(`\n  ERROR exporting ${table.name}: ${err.message}`);
      results.push({ table: table.name, rowCount: 0, filePath: null, fileSize: 0, error: err.message });
    }
  }

  const totalRows = results.reduce((s, r) => s + r.rowCount, 0);
  const totalSize = results.reduce((s, r) => s + r.fileSize, 0);

  console.log("\n--- Backup Summary ---");
  console.log(`Date:  ${dateStr}`);
  console.log(`Dir:   ${backupDir}\n`);

  const colTable = "Table".padEnd(20);
  const colRows  = "Rows".padStart(8);
  const colSize  = "Size".padStart(10);
  console.log(`${colTable}${colRows}${colSize}`);
  console.log("-".repeat(38));

  for (const r of results) {
    const name = r.table.padEnd(20);
    const rows = String(r.rowCount).padStart(8);
    const size = (r.error ? "ERROR" : humanSize(r.fileSize)).padStart(10);
    console.log(`${name}${rows}${size}`);
  }

  console.log("-".repeat(38));
  console.log(`${"TOTAL".padEnd(20)}${String(totalRows).padStart(8)}${humanSize(totalSize).padStart(10)}`);
  console.log(`\nDone. ${results.filter(r => !r.error).length}/${results.length} tables exported successfully.`);
  // A table that failed is in the summary as ERROR; the run says so in its exit code too.
  return results.some((r) => r.error) ? 1 : 0;
}

if (!client) {
  process.exitCode = 1;
} else {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error("Fatal error:", err);
    process.exitCode = 1;
  } finally {
    // The pool's connections would keep the process alive; closed, it ends
    // with the code above once every write has drained. After a timed-out page
    // close() would wait on the abandoned query, so that run gives the pool a
    // few seconds and then ends the process with the code already set.
    if (timedOut) {
      await Promise.race([client.close(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      process.exit(process.exitCode ?? 1);
    }
    await client.close();
  }
}
