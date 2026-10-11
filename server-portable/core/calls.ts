// Which operation each tool name runs (SMD-2310): the one table from a name in
// the manifest to the core's function for it. The REST core's routes call
// through it (rest/routes.ts), and so does a plugin's ctx.call (plugins.ts) —
// one mapping, so a plugin calling `fetch` runs what GET /v1/thoughts/{id}
// runs.

import type { Principal } from "../auth.ts";
import type { ToolName } from "../tools.ts";
import { ok, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";
import type { createCore } from "./index.ts";

type Core = ReturnType<typeof createCore>;

/** What a call needs beyond the principal and the input: the stop's tracker, for an operation that starts detached work. */
export type CallOptions = { track?: <T>(run: () => Promise<T>) => Promise<T> };

/** A tool's call: the core, the caller, the tool's parsed input. */
export type Call<K extends ToolName> = (core: Core, principal: Principal, input: Input<K>, opts: CallOptions) => Promise<Outcome<object>>;

// `satisfies`, not an annotation, so each row keeps its operation's own answer
// type for CoreAnswer below.
export const CALLS = {
  search: (c, p, i) => c.search(p, i),
  fetch: (c, p, i) => c.fetch(p, i),
  search_thoughts: (c, p, i) => c.searchThoughts(p, i),
  search_thoughts_keyword: (c, p, i) => c.searchThoughtsKeyword(p, i),
  list_thoughts: (c, p, i) => c.listThoughts(p, i),
  list_thought_ids: (c, p, i) => c.listThoughtIds(p, i),
  list_logged_searches: (c, p, i) => c.listLoggedSearches(p, i),
  list_supersession_proposals: (c, p, i) => c.listSupersessionProposals(p, i),
  thought_stats: (c, p, i) => c.thoughtStats(p, i),
  thought_changes: (c, p, i) => c.thoughtChanges(p, i),
  worker_status: (c, p, i) => c.workerStatus(p, i),
  brain_info: async (c) => ok(await c.brainInfo("tool")),
  job_status: (c, p, i) => c.jobStatus(p, i),
  scan_thoughts: (c, p, i, o) => c.scanThoughts(p, i, { track: o.track }),
  capture_thought: (c, p, i) => c.capture(p, i),
  update_thought: (c, p, i) => c.updateThought(p, i),
  delete_thought: (c, p, i) => c.deleteThought(p, i),
  reset_capture_stamp: (c, p, i) => c.resetCaptureStamp(p, i),
  retry_failed: (c, p, i) => c.retryFailed(p, i),
  release_stale_leases: (c, p, i) => c.releaseStaleLeases(p, i),
  run_worker: (c, p, i) => c.runWorker(p, i),
} satisfies { [K in ToolName]: Call<K> };

/** The `{field}` names a route's path fills, in order: a core route's (rest/routes.ts) or a plugin operation's. */
export const pathFields = (path: string): string[] => [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);

/** What a core operation answers, by its tool name: its typed value or its refusal — what a plugin's `ctx.call` hands back. */
export type CoreAnswer<K extends ToolName> = Awaited<ReturnType<(typeof CALLS)[K]>>;
