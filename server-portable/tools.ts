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
   * The tool's group, named for the key scope that unlocks it alone: `read`
   * (a read or a write key), `capture` (a write key or the capture-only key,
   * SMD-1298), `write` (a write key alone). A key's surface is the union of
   * the groups its scope unlocks, UNLOCKS below. This is the only statement
   * of a tool's gate: index.ts registers an MCP tool and the REST core admits
   * a route through mayCall (SMD-1931), and visibleToolNames() derives what
   * the drift guards expect, so they read the manifest rather than a fixed
   * count. A future flag-gated or optional tool adds its condition here and
   * extends those functions.
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
  { name: "list_thought_ids", scope: "read" },
  { name: "list_logged_searches", scope: "read" },
  { name: "worker_status", scope: "read" },
  { name: "job_status", scope: "read" },
  { name: "scan_thoughts", scope: "read" },
  { name: "list_supersession_proposals", scope: "read" },
  { name: "thought_stats", scope: "read" },
  { name: "thought_changes", scope: "read" },
  { name: "brain_info", scope: "read" },
  { name: "capture_thought", scope: "capture" },
  { name: "update_thought", scope: "write" },
  { name: "delete_thought", scope: "write" },
  { name: "retry_failed", scope: "write" },
  { name: "release_stale_leases", scope: "write" },
  { name: "run_worker", scope: "write" },
] as const satisfies readonly ToolEntry[];

/** Every tool name as a literal union — the type a tool name is checked against. */
export type ToolName = (typeof TOOLS)[number]["name"];

const namesIn = (groups: readonly ToolScope[]): ToolName[] => TOOLS.filter((t) => groups.includes(t.scope)).map((t) => t.name).sort();

/** The tool groups each key scope unlocks — the one statement of the scope hierarchy. */
export const UNLOCKS: Readonly<Record<Scope, readonly ToolScope[]>> = {
  read: ["read"],
  capture: ["capture"],
  write: ["read", "capture", "write"],
  // A forwarder's key grants nothing (SMD-2284); no server admits it as a caller.
  forward: [],
};

/** A tool's group, from its manifest entry. */
export const scopeOf = (name: ToolName): ToolScope => TOOLS.find((t) => t.name === name)!.scope;

/**
 * Whether a key's scope unlocks a tool — the one gate both surfaces ask
 * (SMD-1931): index.ts registers an MCP tool only where it holds, and the REST
 * core refuses a route with FORBIDDEN where it does not, so a tool's scope is
 * stated once, here, and not again beside either registration.
 */
export const mayCall = ({ scope }: { scope: Scope }, name: ToolName): boolean => UNLOCKS[scope].includes(scopeOf(name));

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
