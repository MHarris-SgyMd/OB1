// Generated from server-portable/rest/openapi.ts by rest-client/generate.ts — do not edit by hand (SMD-2287).

/** Each REST operation's method and path, by its operationId — the MCP tool's name for a core operation. */
export const OPERATIONS = {
  brain_info: { method: "GET", path: "/v1/brain" },
  capture_thought: { method: "POST", path: "/v1/thoughts" },
  delete_thought: { method: "DELETE", path: "/v1/thoughts/{id}" },
  fetch: { method: "GET", path: "/v1/thoughts/{id}" },
  health: { method: "GET", path: "/health" },
  job_status: { method: "GET", path: "/v1/jobs/{job_id}" },
  job_stream: { method: "GET", path: "/v1/jobs/{job_id}/stream" },
  list_logged_searches: { method: "GET", path: "/v1/logged-searches" },
  list_supersession_proposals: { method: "GET", path: "/v1/proposals" },
  list_thought_ids: { method: "GET", path: "/v1/thought-ids" },
  list_thoughts: { method: "GET", path: "/v1/thoughts" },
  plugins: { method: "GET", path: "/v1/plugins" },
  release_stale_leases: { method: "POST", path: "/v1/workers/release-leases" },
  reset_capture_stamp: { method: "POST", path: "/v1/thoughts/{id}/reset-capture-stamp" },
  retry_failed: { method: "POST", path: "/v1/workers/retry" },
  review_supersession_proposal: { method: "POST", path: "/v1/proposals/{id}/review" },
  run_worker: { method: "POST", path: "/v1/workers/run" },
  scan_thoughts: { method: "POST", path: "/v1/scans" },
  search: { method: "POST", path: "/v1/search/compat" },
  search_thoughts: { method: "POST", path: "/v1/search" },
  search_thoughts_keyword: { method: "POST", path: "/v1/search/keyword" },
  thought_changes: { method: "GET", path: "/v1/changes" },
  thought_stats: { method: "GET", path: "/v1/stats" },
  update_thought: { method: "PATCH", path: "/v1/thoughts/{id}" },
  whoami: { method: "GET", path: "/v1/whoami" },
  worker_status: { method: "GET", path: "/v1/workers" },
} as const;

export type OperationId = keyof typeof OPERATIONS;
