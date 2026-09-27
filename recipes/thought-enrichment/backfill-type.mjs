#!/usr/bin/env bun
// ob1-fork (SMD-2139): this script paged PostgREST's `/thoughts` route and wrote
// each row's `type` back through it with a service-role key, and this fork's
// stack runs no PostgREST. It reads and writes through compat/supabase-sql now —
// SUPABASE_URL is a postgres:// connection string, SUPABASE_SERVICE_ROLE_KEY is
// accepted and ignored (the credentials live in the URL). Run it from a
// checkout: the import is relative. One read changed with the transport: a
// page selects `metadata` whole and reads its `type` key here, since the shim
// takes no JSON path in a select list. `--limit N` caps the rows written. A
// flag the script does not know is refused, not ignored.
/**
 * backfill-type.mjs
 *
 * Backfills the `type` column in the `thoughts` table from metadata.type,
 * for rows where type = 'reference' but metadata contains a valid different type.
 * (`schemas/enhanced-thoughts`' backfill_thought_types() covers the OTHER
 * rows — those whose `type` is NULL, a table that got the column after its
 * rows; this script reads the rows stamped 'reference'.)
 *
 * Usage: bun backfill-type.mjs [--dry-run] [--batch-size N] [--limit N]
 */

import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { connect, endWith, failure, intFlag, isTransientDbError, readEnv, refuseUnknownFlags } from "./lib/brain.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const VALID_TYPES = new Set(["idea", "task", "person_note", "reference", "decision", "lesson", "meeting", "journal"]);

/** A positive integer flag, or the default when the flag is absent; anything else is refused by name. */
function positiveInt(args, flag, fallback) {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : intFlag(args[at + 1], flag, 1);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

// The client main() opens, closed at the bottom on both paths (lib/brain.mjs).
let client = null;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cursor-based pagination on id. Offset pagination is unsafe here: every
// successful update removes a row from the `type = 'reference'` filter, so
// `offset += rows.length` would skip unprocessed rows. The cursor pattern is
// id > afterId ORDER BY id ASC. `includeCount` is used once on the first call
// to populate the total for the progress bar — every later call omits the
// count so Postgres does not COUNT(*) the filtered set per page (LOW-7).
async function fetchBatch(afterId, batchSize, { includeCount = false } = {}, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    const { data, error, count } = await client
      .from("thoughts")
      .select("id,metadata", includeCount ? { count: "exact" } : undefined)
      .eq("type", "reference")
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(batchSize);
    if (!error) return { rows: data ?? [], total: includeCount && typeof count === "number" ? count : null };
    if (!isTransientDbError(error) || attempt >= retries) throw failure(`read thoughts after id ${afterId}`, error);
    const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
    process.stderr.write(`\n[retry] read after id ${afterId} ${error.code}, waiting ${delay}ms\n`);
    await sleep(delay);
  }
}

// One row's `type`. The `.select("id")` narrows what the write returns to the
// id — without it the shim returns the whole row, its vector included, on
// every update (PostgREST's `Prefer: return=minimal` had the same purpose).
async function updateRow(id, newType, retries = 6) {
  for (let attempt = 0; ; attempt++) {
    const { error } = await client.from("thoughts").update({ type: newType }).eq("id", id).select("id");
    if (!error) return;
    if (!isTransientDbError(error) || attempt >= retries) throw failure(`update thought ${id}`, error);
    const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
    process.stderr.write(`\n[retry] id ${id} ${error.code}, waiting ${delay}ms (attempt ${attempt + 1}/${retries})\n`);
    await sleep(delay);
  }
}

async function updateBatch(updates) {
  const CONCURRENCY = 5;
  for (let i = 0; i < updates.length; i += CONCURRENCY) {
    const chunk = updates.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(({ id, type }) => updateRow(id, type)));
    if (i + CONCURRENCY < updates.length) await sleep(200);
  }
}

async function main() {
  refuseUnknownFlags(args, ["--dry-run", "--batch-size", "--limit"], ["--batch-size", "--limit"]);
  const BATCH_SIZE = positiveInt(args, "--batch-size", 500);
  const LIMIT = positiveInt(args, "--limit", 0);
  client = connect(readEnv(__dirname));

  console.log(`Starting type backfill${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
  console.log(`Batch size: ${BATCH_SIZE}${LIMIT ? `, limit: ${LIMIT}` : ""}`);
  console.log("");

  // Cursor replaces offset. afterId starts at the zero UUID (thoughts.id is
  // a UUID) and advances to the last id seen in each page, so an update that
  // removes rows from the `type = 'reference'` filter cannot cause the cursor
  // to skip un-processed rows.
  let afterId = "00000000-0000-0000-0000-000000000000";
  let processedRows = 0;
  let total = null;
  let firstCountDone = false;
  let totalUpdated = 0;
  let totalSkippedInvalidType = 0;
  let totalSkippedAlreadyCorrect = 0;
  let totalSkippedNullType = 0;
  let limitReached = false;

  const invalidTypeLog = {};
  const typeDistribution = {};

  while (true) {
    // The limit met, no page is read: the scan had gone on to the next row it
    // would have written, every page between read for nothing (`--limit 1` on
    // a smoke test scanned the whole set).
    if (LIMIT && totalUpdated >= LIMIT) {
      limitReached = true;
      break;
    }
    const { rows, total: fetchedTotal } = await fetchBatch(afterId, BATCH_SIZE, {
      includeCount: !firstCountDone,
    });
    firstCountDone = true;

    if (total === null && fetchedTotal !== null) {
      total = fetchedTotal;
      console.log(`Total rows with type='reference': ${total}`);
      console.log("");
    }

    if (!rows || rows.length === 0) break;

    const updates = [];
    let examined = 0;

    for (const row of rows) {
      // The row's metadata, read whole; a non-string type is its JSON text, as
      // PostgREST's `->>` gave it.
      const rawType = row.metadata?.type;
      const metaType = typeof rawType === "string" ? rawType : rawType == null ? "" : JSON.stringify(rawType);
      examined++;

      if (!metaType || metaType === "" || metaType === "null") {
        totalSkippedNullType++;
        continue;
      }

      if (!VALID_TYPES.has(metaType)) {
        invalidTypeLog[metaType] = (invalidTypeLog[metaType] || 0) + 1;
        totalSkippedInvalidType++;
        continue;
      }

      if (metaType === "reference") {
        totalSkippedAlreadyCorrect++;
        continue;
      }

      if (LIMIT && totalUpdated + updates.length >= LIMIT) {
        limitReached = true;
        examined--; // not classified: the limit stopped the scan at this row
        break;
      }
      updates.push({ id: row.id, type: metaType });
      typeDistribution[metaType] = (typeDistribution[metaType] || 0) + 1;
    }

    if (updates.length > 0) {
      if (!DRY_RUN) {
        await updateBatch(updates);
      }
      totalUpdated += updates.length;
    }

    // The rows examined — every row of the page, unless the limit stopped the
    // scan inside it (the rest of the page was counted as processed and
    // classified nowhere).
    processedRows += examined;
    // Advance cursor past the highest id seen (rows are ordered by id ASC).
    afterId = rows[rows.length - 1].id;

    const pct = total ? ((processedRows / total) * 100).toFixed(1) : "?";
    process.stdout.write(`\rProgress: ${processedRows}/${total ?? "?"} (${pct}%) — updated so far: ${totalUpdated}`);

    if (limitReached || rows.length < BATCH_SIZE) break;
  }

  console.log("\n");
  console.log(limitReached ? `=== BACKFILL STOPPED AT --limit ${LIMIT} ===` : "=== BACKFILL COMPLETE ===");
  console.log("");
  console.log(`Rows processed:              ${processedRows}`);
  console.log(`Rows updated:                ${totalUpdated}${DRY_RUN ? " (dry run, not written)" : ""}`);
  console.log(`Skipped (already reference): ${totalSkippedAlreadyCorrect}`);
  console.log(`Skipped (null/empty type):   ${totalSkippedNullType}`);
  console.log(`Skipped (invalid type):      ${totalSkippedInvalidType}`);

  if (Object.keys(invalidTypeLog).length > 0) {
    console.log("");
    console.log("Invalid (non-canonical) type values found in metadata (skipped):");
    for (const [t, c] of Object.entries(invalidTypeLog)) {
      console.log(`  ${t}: ${c}`);
    }
  }

  if (Object.keys(typeDistribution).length > 0) {
    console.log("");
    console.log("Type distribution of updated rows:");
    const sorted = Object.entries(typeDistribution).sort((a, b) => b[1] - a[1]);
    for (const [t, c] of sorted) {
      console.log(`  ${t}: ${c}`);
    }
  }

  console.log("");
  console.log("Done.");
}

endWith(main(), () => client);
