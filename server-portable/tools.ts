// The canonical MCP tool surface — the single, typed source (SMD-1805). The
// names live here as `as const`, so `ToolName` is a real union TypeScript checks
// a tool name against; a JSON import would widen every name to `string`, which
// is why the source is TS and not tools.json. scripts/gen-tools.ts writes
// tools.json from this for deploy/smoke.sh (bash, no bun in the deploy job), and
// check-fork-consistency.ts round-trips the two so they cannot drift.

import type { Scope } from "./auth.ts";

/** A tool's scope is a key's scope: one literal union, so a fourth scope is added once (tenth review pass). */
export type ToolScope = Scope;

export interface ToolEntry {
  readonly name: string;
  /**
   * The gate index.ts registers the tool behind, named for the key scope that
   * unlocks it alone: `read` (canRead — a read or a write key), `capture`
   * (canCapture — a write key or the capture-only key, SMD-1298), `write`
   * (canWrite — a write key alone). A key's surface is the union of the groups
   * its scope unlocks, UNLOCKS below; visibleToolNames() derives it, so the
   * drift guards read the manifest rather than a fixed count, and a tool
   * gated with canCapture in index.ts but tagged `write` here fails them
   * (first review pass: a hand-written list beside the manifest would not). A
   * future flag-gated or optional tool adds its condition here and extends
   * that function.
   */
  readonly scope: ToolScope;
}

// `satisfies` checks each entry against ToolEntry (so a bad scope like "reed" is
// a compile error at the source) while `as const` keeps the literal names for
// the union below.
export const TOOLS = [
  { name: "search", scope: "read" },
  { name: "fetch", scope: "read" },
  { name: "search_thoughts", scope: "read" },
  { name: "search_thoughts_keyword", scope: "read" },
  { name: "list_thoughts", scope: "read" },
  { name: "list_supersession_proposals", scope: "read" },
  { name: "thought_stats", scope: "read" },
  { name: "thought_changes", scope: "read" },
  { name: "capture_thought", scope: "capture" },
  { name: "update_thought", scope: "write" },
  { name: "delete_thought", scope: "write" },
] as const satisfies readonly ToolEntry[];

/** Every tool name as a literal union — the type a tool name is checked against. */
export type ToolName = (typeof TOOLS)[number]["name"];

const namesIn = (groups: readonly ToolScope[]): ToolName[] => TOOLS.filter((t) => groups.includes(t.scope)).map((t) => t.name).sort();

/** The tool groups each key scope unlocks — the one statement of the scope hierarchy. */
export const UNLOCKS: Readonly<Record<Scope, readonly ToolScope[]>> = {
  read: ["read"],
  capture: ["capture"],
  write: ["read", "capture", "write"],
};

/** Every tool name a write-scoped key sees, sorted — derived from UNLOCKS, not restated (eleventh review pass: it was every manifest entry, a second statement of the hierarchy). */
export const TOOL_NAMES: ToolName[] = namesIn(UNLOCKS.write);
/** The read group, sorted — the surface a read-only key sees. */
export const READ_TOOL_NAMES: ToolName[] = namesIn(["read"]);
/** The write group, sorted — what a write key alone unlocks: update and delete. */
export const WRITE_TOOL_NAMES: ToolName[] = namesIn(["write"]);
/** The capture group, sorted — the surface a capture-only key sees (SMD-1298). */
export const CAPTURE_TOOL_NAMES: ToolName[] = namesIn(["capture"]);

/**
 * The tool names a caller sees, derived from the manifest for the caller's
 * scope — the one place "which tools are expected" is computed, so the drift
 * guards stay correct as tools gain conditions. Today the only condition is
 * the key's scope; a flag-gated tool would take its flag as another field here.
 */
export function visibleToolNames({ scope }: { scope: Scope }): ToolName[] {
  return namesIn(UNLOCKS[scope]);
}
