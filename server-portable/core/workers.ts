// The worker actions (SMD-2283 PR 3; SMD-2132, SMD-2272): the control plane
// over worker_status's pools, as functions of a principal and a typed input.
// retry_failed and release_stale_leases mutate thought_work_claims and log each
// thought they touch; run_worker is only its dry-run preview so far, which reads.
// None consumes anything on the model — the EXISTING claim machinery (migration
// 015), not a new worker or scheduler, and never the LLM drain (the server does
// not run the bulk passes; entities.ts). The MCP tools and the keyed REST POSTs
// both call these, each saying the outcome in its own words.

import type { DryRunClaimResult, ReleaseLeasesResult, RetryFailedResult } from "../store.ts";
import type { Principal } from "../auth.ts";
import type { Ctx } from "./context.ts";
import { ok, refuse, type Outcome } from "./refusal.ts";
import type { Input } from "./schemas.ts";

/** The codes each action refuses with — every one a caller words (render.ts, the REST routes). */
export type RetryFailedCode = "REFUSED_EMPTY_WORK_TYPE";
export type ReleaseLeasesCode = "REFUSED_EMPTY_WORK_TYPE" | "REFUSED_LIVE_LEASE_NEEDS_WORKER";
export type RunWorkerCode = "REFUSED_EMPTY_WORK_TYPE" | "RUN_WORKER_DRAIN_NOT_AVAILABLE";

/**
 * Requeue one pool's failed claim rows. A fresh attempt clears the recorded
 * error and the attempt count. Each requeued thought gets an action-log row,
 * actor = this key (SMD-2132).
 */
export async function retryFailed(ctx: Ctx, principal: Principal, { work_type }: Input<"retry_failed">): Promise<Outcome<RetryFailedResult, RetryFailedCode>> {
  if (work_type.trim() === "") return refuse({ code: "REFUSED_EMPTY_WORK_TYPE", retryable: false });
  const result = await (await ctx.store()).retryFailed(work_type);
  await ctx.logActions(principal, result.ids.map((id) => ({ tool: "retry_failed", targetId: id })));
  return ok(result);
}

/**
 * Return claimed rows whose lease has lapsed to the pool — the manual form of
 * the lazy reaper. A live lease is released only with include_live AND a named
 * holder, since releasing one risks the holder double-processing. A work_type
 * given but blank is refused rather than read as every pool.
 */
export async function releaseStaleLeases(ctx: Ctx, principal: Principal, { work_type, worker_id, include_live }: Input<"release_stale_leases">): Promise<Outcome<ReleaseLeasesResult, ReleaseLeasesCode>> {
  if (work_type !== undefined && work_type.trim() === "") return refuse({ code: "REFUSED_EMPTY_WORK_TYPE", retryable: false });
  if (include_live === true && (worker_id === undefined || worker_id.trim() === "")) return refuse({ code: "REFUSED_LIVE_LEASE_NEEDS_WORKER", retryable: false });
  const result = await (await ctx.store()).releaseStaleLeases({ workType: work_type, workerId: worker_id, includeLive: include_live === true });
  await ctx.logActions(principal, result.ids.map((id) => ({ tool: "release_stale_leases", targetId: id })));
  return ok(result);
}

/**
 * run_worker's dry_run half (SMD-2272): a pure-SQL preview of what a pass over
 * `work_type` would claim, claiming nothing. The EXECUTING drain is deferred —
 * the server deliberately never runs the bulk LLM passes, and it lands on a
 * callable worker core (SMD-2304) — so dry_run must be explicitly true, and
 * anything else is refused as a value, never mistaken for a silent no-op. A
 * dry run mutates nothing, so it writes no action-log row.
 */
export async function runWorker(ctx: Ctx, _principal: Principal, { work_type, dry_run, limit }: Input<"run_worker">): Promise<Outcome<DryRunClaimResult, RunWorkerCode>> {
  if (work_type.trim() === "") return refuse({ code: "REFUSED_EMPTY_WORK_TYPE", retryable: false });
  if (dry_run !== true) return refuse({ code: "RUN_WORKER_DRAIN_NOT_AVAILABLE", retryable: false });
  return ok(await (await ctx.store()).dryRunClaim(work_type, limit));
}
