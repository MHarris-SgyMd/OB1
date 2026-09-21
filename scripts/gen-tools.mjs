#!/usr/bin/env bun
/**
 * gen-tools.mjs — writes server-portable/tools.json from the typed source
 * server-portable/tools.ts (SMD-1805).
 *
 * tools.ts is the single source of the MCP tool surface: the names live there as
 * `as const` so TypeScript can check a name against a `ToolName` union, which a
 * JSON file cannot carry. deploy/smoke.sh is bash (and the deploy CI job has no
 * bun), so it reads a JSON file, not the TS — this generates that file, and
 * check-fork-consistency.mjs round-trips it (regenerate in memory, compare to
 * the committed copy) so the two never drift.
 *
 *   bun scripts/gen-tools.mjs        # rewrite server-portable/tools.json
 *
 * Runs under bun (it imports the TS source). `renderToolsJson` is exported so
 * the consistency check compares without writing.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TOOLS } from "../server-portable/tools.ts";

const NOTE =
  "Generated from server-portable/tools.ts by scripts/gen-tools.mjs — do not edit by hand. " +
  "tools.ts is the typed source of the MCP tool surface (SMD-1805); deploy/smoke.sh reads this JSON " +
  "and check-fork-consistency.mjs round-trips it against the source.";

/** The exact contents tools.json must have, given the source — one definition
 *  for the writer here and the round-trip check. Two-space indent, trailing
 *  newline, every field the source carries (so a future `gate` flows through). */
export function renderToolsJson() {
  return JSON.stringify({ note: NOTE, tools: TOOLS.map((t) => ({ ...t })) }, null, 2) + "\n";
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "server-portable", "tools.json");

if (import.meta.main) {
  writeFileSync(OUT, renderToolsJson());
  console.log(`wrote ${OUT} (${TOOLS.length} tools)`);
}
