// The canonical MCP tool surface — the single, typed source (SMD-1805). The
// names live here as `as const`, so `ToolName` is a real union TypeScript checks
// a tool name against; a JSON import would widen every name to `string`, which
// is why the source is TS and not tools.json. scripts/gen-tools.ts writes
// tools.json from this for deploy/smoke.sh (bash, no bun in the deploy job), and
// check-fork-consistency.ts round-trips the two so they cannot drift.

export type ToolScope = "read" | "write";

export interface ToolEntry {
  readonly name: string;
  /**
   * When the tool is on the surface. `read` — always. `write` — only for a
   * write-scoped key, registered behind canWrite() in index.ts and absent for a
   * read key. This is the only "condition" today; a future flag-gated or
   * optional tool adds its condition here and extends visibleToolNames() below,
   * and the drift guards read that rather than a fixed count — so the surface
   * can grow conditions without a test hard-coding the answer.
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
  { name: "capture_thought", scope: "write" },
  { name: "update_thought", scope: "write" },
  { name: "delete_thought", scope: "write" },
] as const satisfies readonly ToolEntry[];

/** Every tool name as a literal union — the type a tool name is checked against. */
export type ToolName = (typeof TOOLS)[number]["name"];

/** Every tool name, sorted — the surface a write-scoped key sees. */
export const TOOL_NAMES: ToolName[] = TOOLS.map((t) => t.name).sort();
/** The read-scoped subset, sorted — the surface a read-only key sees. */
export const READ_TOOL_NAMES: ToolName[] = TOOLS.filter((t) => t.scope === "read").map((t) => t.name).sort();
/** The write-gated tools, sorted — absent from a read key's surface. */
export const WRITE_TOOL_NAMES: ToolName[] = TOOLS.filter((t) => t.scope === "write").map((t) => t.name).sort();

/**
 * The tool names a caller sees, derived from the manifest for the caller's
 * condition — the one place "which tools are expected" is computed, so the drift
 * guards stay correct as tools gain conditions. Today the only condition is
 * write scope; a flag-gated tool would take its flag as another field here.
 */
export function visibleToolNames({ write }: { write: boolean }): ToolName[] {
  return write ? TOOL_NAMES : READ_TOOL_NAMES;
}
