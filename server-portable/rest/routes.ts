// Where each operation lives on the REST core (SMD-2284): its method, its path
// and the status a success answers — one row per tool in the manifest
// (tools.ts), keyed by its name, so a tool added there without a route here,
// or a route for a tool the manifest lacks, is a compile error. The input is
// the tool's own zod schema (core/schemas.ts): a path's `{name}` fills the
// field of that name, a GET or DELETE reads the rest from the query string, a
// POST or PATCH from the JSON body. Free text a search runs on travels in a
// body, so it never sits in a URL a log or a proxy may keep.

import type { ToolName } from "../tools.ts";
import type { Principal } from "../auth.ts";
import type { Core, Input, Outcome } from "../core/index.ts";
import { ok, type RefusalCode } from "../core/refusal.ts";

/**
 * The HTTP status each refusal answers with — one per code, so a new refusal
 * does not compile until it has one. 400 a shape the caller can fix, 403 a
 * rule the caller may not pass, 404 nothing there, 409 the state changed or
 * conflicts, 422 a reference to nothing or a refusal the store named that
 * this server does not know (REFUSED), 501 a mode not built, 503 retry.
 */
export const REFUSAL_STATUS: Record<RefusalCode, 400 | 403 | 404 | 409 | 422 | 501 | 503> = {
  NOT_FOUND: 404,
  REFUSED_FILTER: 400,
  REFUSED_EGRESS: 403,
  REFUSED_SINCE: 400,
  REFUSED_CURSOR: 400,
  REFUSED_SUPERSEDES_SHAPE: 400,
  REFUSED_DERIVED_FROM_SHAPE: 400,
  REFUSED_METADATA_SHAPE: 400,
  SUPERSEDES_UNJUDGED: 503,
  REFUSED_SUPERSEDES_OWNERSHIP: 403,
  REFUSED_SUPERSEDES_UNKNOWN: 422,
  DERIVED_FROM_MISSING: 422,
  // Never answered as a refusal: the row is saved, so it is a creation (below).
  EMBEDDING_NOT_ATTACHED: 503,
  REFUSED_NOTHING_TO_UPDATE: 400,
  REFUSED_STALE_READ: 409,
  REFUSED_DUPLICATE_CONTENT: 409,
  REFUSED_WOULD_CYCLE: 409,
  REFUSED_CITED: 409,
  REFUSED: 422,
  REFUSED_EMPTY_WORK_TYPE: 400,
  REFUSED_LIVE_LEASE_NEEDS_WORKER: 400,
  RUN_WORKER_DRAIN_NOT_AVAILABLE: 501,
};

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** What a call needs beyond the principal and the input: the stop's tracker, for an operation that starts detached work. */
export type CallOptions = { track?: <T>(run: () => Promise<T>) => Promise<T> };

export type Route<K extends ToolName> = {
  method: Method;
  /** OpenAPI's path form: `{field}` names an input field filled from the path. */
  path: string;
  /** The status a success answers: 200, a creation 201, a job accepted 202. */
  ok: 200 | 201 | 202;
  /**
   * What a fault the operation throws answers as, when it is not FAILED:
   * capture's is the transient the session hook keeps and retries
   * (SMD-1978), as the MCP tool says it.
   */
  fault?: "STORE_UNAVAILABLE";
  /** The operation the route calls — the MCP tool's own, from createCore. */
  call: (core: Core, principal: Principal, input: Input<K>, opts: CallOptions) => Promise<Outcome<object>>;
};

export const ROUTES: { [K in ToolName]: Route<K> } = {
  // ChatGPT's compatibility shapes, beside the brain's own search and fetch.
  search: { method: "POST", path: "/v1/search/compat", ok: 200, call: (c, p, i) => c.search(p, i) },
  fetch: { method: "GET", path: "/v1/thoughts/{id}", ok: 200, call: (c, p, i) => c.fetch(p, i) },
  search_thoughts: { method: "POST", path: "/v1/search", ok: 200, call: (c, p, i) => c.searchThoughts(p, i) },
  search_thoughts_keyword: { method: "POST", path: "/v1/search/keyword", ok: 200, call: (c, p, i) => c.searchThoughtsKeyword(p, i) },
  list_thoughts: { method: "GET", path: "/v1/thoughts", ok: 200, call: (c, p, i) => c.listThoughts(p, i) },
  list_thought_ids: { method: "GET", path: "/v1/thought-ids", ok: 200, call: (c, p, i) => c.listThoughtIds(p, i) },
  list_logged_searches: { method: "GET", path: "/v1/logged-searches", ok: 200, call: (c, p, i) => c.listLoggedSearches(p, i) },
  list_supersession_proposals: { method: "GET", path: "/v1/proposals", ok: 200, call: (c, p, i) => c.listSupersessionProposals(p, i) },
  thought_stats: { method: "GET", path: "/v1/stats", ok: 200, call: (c, p, i) => c.thoughtStats(p, i) },
  thought_changes: { method: "GET", path: "/v1/changes", ok: 200, call: (c, p, i) => c.thoughtChanges(p, i) },
  worker_status: { method: "GET", path: "/v1/workers", ok: 200, call: (c, p, i) => c.workerStatus(p, i) },
  brain_info: { method: "GET", path: "/v1/brain", ok: 200, call: async (c) => ok(await c.brainInfo("tool")) },
  job_status: { method: "GET", path: "/v1/jobs/{job_id}", ok: 200, call: (c, p, i) => c.jobStatus(p, i) },
  scan_thoughts: { method: "POST", path: "/v1/scans", ok: 202, call: (c, p, i, o) => c.scanThoughts(p, i, { track: o.track }) },
  capture_thought: { method: "POST", path: "/v1/thoughts", ok: 201, fault: "STORE_UNAVAILABLE", call: (c, p, i) => c.capture(p, i) },
  update_thought: { method: "PATCH", path: "/v1/thoughts/{id}", ok: 200, call: (c, p, i) => c.updateThought(p, i) },
  delete_thought: { method: "DELETE", path: "/v1/thoughts/{id}", ok: 200, call: (c, p, i) => c.deleteThought(p, i) },
  retry_failed: { method: "POST", path: "/v1/workers/retry", ok: 200, call: (c, p, i) => c.retryFailed(p, i) },
  release_stale_leases: { method: "POST", path: "/v1/workers/release-leases", ok: 200, call: (c, p, i) => c.releaseStaleLeases(p, i) },
  run_worker: { method: "POST", path: "/v1/workers/run", ok: 200, call: (c, p, i) => c.runWorker(p, i) },
};

/** The `{field}` names a route's path fills, in order. */
export const pathFields = (path: string): string[] => [...path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);

/** The path in Hono's form, `:field` for `{field}`. */
export const honoPath = (path: string): string => path.replace(/\{([a-z_]+)\}/g, ":$1");

/** Whether a route's input rides the query string (GET, DELETE) or a JSON body (POST, PATCH). */
export const readsQuery = (method: Method): boolean => method === "GET" || method === "DELETE";
