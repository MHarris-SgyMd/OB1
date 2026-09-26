#!/usr/bin/env bun
// ob1-fork (SMD-2139): this script paged PostgREST's `/thoughts` route and wrote
// each row's `sensitivity_tier` back through it with a service-role key, and
// this fork's stack runs no PostgREST. It reads and writes through
// compat/supabase-sql now — SUPABASE_URL is a postgres:// connection string,
// SUPABASE_SERVICE_ROLE_KEY is accepted and ignored (the credentials live in the
// URL). Run it from a checkout: the import is relative. A refused read or write
// ends the run with the database's reason, where a failed write was counted and
// the scan went on.
/**
 * Backfill sensitivity_tier for existing thoughts.
 * Scans thoughts with sensitivity_tier = 'standard' (or null/empty),
 * runs regex-based sensitivity detection on their content, and updates
 * any that should be 'personal' or 'restricted'.
 *
 * Usage:
 *   bun backfill-sensitivity.mjs --dry-run    # scan only
 *   bun backfill-sensitivity.mjs --apply      # update the brain
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, endWith, failure, readEnv } from "./lib/brain.mjs";

// --- Sensitivity detection (shared patterns from sensitivity-patterns.json) ---

import { RESTRICTED_PATTERNS, PERSONAL_PATTERNS } from "./lib/sensitivity-patterns.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function detectSensitivity(text) {
  const reasons = [];

  for (const [pattern, reason] of RESTRICTED_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(reason);
      return { tier: "restricted", reasons };
    }
  }

  for (const [pattern, reason] of PERSONAL_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(reason);
    }
  }

  if (reasons.length > 0) {
    return { tier: "personal", reasons };
  }

  return { tier: "standard", reasons: [] };
}

// --- Main ---

const dryRun = process.argv.includes("--dry-run");
const apply = process.argv.includes("--apply");

const BATCH_SIZE = 500;
const PROGRESS_EVERY = 5000;

// The client main() opens, closed at the bottom on both paths (lib/brain.mjs).
let client = null;

async function main() {
  if (!dryRun && !apply) {
    console.log("Usage:");
    console.log("  bun backfill-sensitivity.mjs --dry-run    # scan only");
    console.log("  bun backfill-sensitivity.mjs --apply      # update the brain");
    return;
  }

  client = connect(readEnv(__dirname));

  console.log(`Mode: ${dryRun ? "DRY RUN (no changes)" : "APPLY (will update the brain)"}`);
  console.log();

  let afterId = "00000000-0000-0000-0000-000000000000";
  let scanned = 0;
  let scannedAtLastProgress = 0;
  let upgradedPersonal = 0;
  let upgradedRestricted = 0;

  // Cursor-based pagination on id. Offset-pagination is unsafe here:
  // successful updates shift the "where sensitivity_tier in (null, standard,
  // '')" result set, so `offset += BATCH_SIZE` would skip un-processed rows.
  // Cursor on id ASC is stable under mutation. The filter is PostgREST's own
  // `or=(…)` expression; the shim reads its empty `eq.` term as the gateway did.
  while (true) {
    const { data, error } = await client
      .from("thoughts")
      .select("id,content,sensitivity_tier")
      .or("sensitivity_tier.is.null,sensitivity_tier.eq.standard,sensitivity_tier.eq.")
      .gt("id", afterId)
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);
    if (error) throw failure(`read thoughts after id ${afterId}`, error);
    if (!data || data.length === 0) break;

    for (const row of data) {
      scanned++;
      const result = detectSensitivity(row.content || "");

      if (result.tier !== "standard") {
        if (result.tier === "personal") upgradedPersonal++;
        if (result.tier === "restricted") upgradedRestricted++;

        if (apply) {
          // `.select("id")` narrows what the write returns to the id — without
          // it the shim returns the whole row, its vector included.
          const { error: updateError } = await client
            .from("thoughts")
            .update({ sensitivity_tier: result.tier })
            .eq("id", row.id)
            .select("id");
          if (updateError) throw failure(`update thought ${row.id}`, updateError);
        }

        if (scanned <= 30 || result.tier === "restricted") {
          console.log(
            `  ${result.tier.toUpperCase()} #${row.id}: ${result.reasons.join(", ")} — "${(row.content || "").slice(0, 80)}..."`
          );
        }
      }
    }

    // Advance the cursor past the last id seen, regardless of whether
    // any rows in this page were upgraded.
    afterId = data[data.length - 1].id;
    if (data.length < BATCH_SIZE) break;

    // Progress reporter independent of a multiple-of-offset check, so
    // partial batches do not silently stop emitting progress.
    if (Math.floor(scanned / PROGRESS_EVERY) > Math.floor(scannedAtLastProgress / PROGRESS_EVERY)) {
      console.log(`  ... scanned ${scanned} thoughts so far (${upgradedPersonal} personal, ${upgradedRestricted} restricted)`);
      scannedAtLastProgress = scanned;
    }
  }

  console.log();
  console.log("=== Results ===");
  console.log(`  Scanned:              ${scanned}`);
  console.log(`  Upgraded to personal: ${upgradedPersonal}`);
  console.log(`  Upgraded to restricted: ${upgradedRestricted}`);
  console.log(`  Unchanged:            ${scanned - upgradedPersonal - upgradedRestricted}`);
  console.log(`  Mode:                 ${dryRun ? "DRY RUN (no changes made)" : "APPLIED"}`);
}

endWith(main(), () => client);
