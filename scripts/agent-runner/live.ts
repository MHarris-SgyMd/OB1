/**
 * live.ts — the live run (SMD-4087 cut 2c-3; docs/agent-runner.md, "A run, step by step" steps 3-4 and the hand-back,
 * decision 12). It wraps cut 2b's local run (run.ts) with the outward steps the earlier cuts built but did not yet call:
 * the real claim (claims.ts) before the run, the ticket's move to In Progress at the claim and back to Backlog on the
 * hand-back (board.ts), the hand-back's Linear comment, and the claim's release.
 *
 * Cut 2c-3 does not push or open a PR (cut 3). So every run — a pass included, since there is nothing to publish yet —
 * ends with the branch in the runner's bare repository, the claim released and the ticket back in Backlog, so nothing is
 * left held. A pass or a work failure relabels the ticket for a person (so it is not taken again before cut 3 can
 * publish); only an environment failure keeps the `agent-ready` label, so a later tick can retry.
 *
 * It takes the claim client, the Linear client and run() through injected deps, as run.ts takes its sessions, so the
 * self-check (live-check.ts) drives the whole wiring offline: a stubbed fetch for claims.ts, a stubbed GraphQL client
 * for board.ts, and a stub run() that returns each outcome. The run with the real keys and a model needs stable's
 * `/api` route; SMD-4089 provisioned the keys.
 */

import { brainReady, claimsDir, claimWork, deleteToken, releaseClaim, writeToken, type ClaimReply } from "./claims.ts";
import { comment, handBack, moveToInProgress } from "./board.ts";
import type { Config, Fetch } from "./facts.ts";
import type { Gql } from "../../db/linear-api.ts";
import type { Outcome } from "./record.ts";
import type { RunInput, RunResult } from "./run.ts";

/** What the live run takes from its environment, so the self-check can stand in for all of it. */
export type LiveDeps = {
  /** The hermetic fetch claims.ts uses (SAFE_REQUEST): the brain check, the claim and the release. */
  fetch: Fetch;
  /** The Linear client board.ts uses: the In Progress / Backlog moves and the hand-back comment. */
  gql: Gql;
  /** The runner's agent-kind brain key. */
  brainKey: string;
  /** The runner's own directory; the claim's token is kept under `<runnerDir>/claims/` (claims.ts). */
  runnerDir: string;
  /** The `agent-ready` and `agent-handed-back` label ids, resolved by the caller from `readBoard` (facts.ts). */
  readyLabelId: string;
  handedBackLabelId: string;
  /** cut 2b's whole local run (run.ts `run`), injected so the self-check stubs it; the wiring around it is this cut. */
  run: (input: RunInput) => Promise<RunResult>;
};

/** The live run's input: the claim's facts, and everything run() needs but the claim id (filled once the claim is made). */
export type LiveInput = {
  piece?: string;
  leaseSeconds: number;
  claimLabel: string;
  runInput: Omit<RunInput, "claimId">;
  cfg: Config;
  deps: LiveDeps;
};

/** How far the live run got, and what it left owed for step 0 to retry (docs, "A step that can't be done now"). */
export type LiveResult = {
  /** `brain`: stable wasn't ready, no claim made. `claim`: not claimed (held or refused), nothing moved. `closed`: the ticket was closed, claimed then released without running. `ran`: run() ran and the ticket was handed back. */
  stage: "brain" | "claim" | "closed" | "ran";
  claimId: string | null;
  outcome: Outcome | null;
  ran: boolean;
  handedBack: boolean;
  commented: boolean;
  released: "released" | "owed" | "n/a";
  /** Steps that couldn't be done now (the hand-back move, the comment, the release): step 0 retries each; a release left owed keeps its token. */
  owed: string[];
  /** People-facing notes that are NOT retried — a failed move to In Progress, which the hand-back to Backlog supersedes. */
  notes: string[];
  detail: string;
};

/** A short word for a claim reply the live run couldn't claim through, never a token. */
function claimWhy(reply: ClaimReply): string {
  if (reply.kind === "work-claimed") return `held by ${reply.heldBy.map((h) => `${h.holder}${h.ownKey ? " (your own key)" : ""}`).join(", ") || "another claim"}`;
  if (reply.kind === "ended") return `the claim has ended${reply.ticketClosed ? " (the ticket closed)" : ""}`;
  if (reply.kind === "unattributed") return reply.retryable ? "the registry can't attribute the key yet (retry)" : "the registry can't attribute the key (an operator must act)";
  if (reply.kind === "refused") return `${reply.code}: ${reply.detail}`;
  if (reply.kind === "error") return reply.detail;
  return reply.kind;
}

/** A clean, value-safe hand-back comment from the run's own computed fields — never the sessions' model text (docs, "What the runner publishes"). */
export function handbackComment(result: RunResult): string {
  const r = result.record;
  const head = result.outcome === null ? "passed the gate" : result.outcome === "env-failure" ? "an environment failure" : "a work failure";
  const lines = [`**Agent runner — ${head}.**`, "", `Run \`${r.run}\`, ended at step \`${r.step}\`.`];
  if (r.gate) lines.push(r.gate.pass ? "Gate: passed, no check failed." : `Gate: failed — ${r.gate.failed.join(", ") || "see the record"}.`);
  const sessions = r.sessions
    .map((s) => `${s.role} ${s.turns ?? "?"} turns${s.costUsd !== null ? ` $${s.costUsd.toFixed(2)}` : ""}${s.ended !== "result" ? ` (ended ${s.ended})` : ""}`)
    .join("; ");
  if (sessions) lines.push(`Sessions: ${sessions}.`);
  lines.push(`Branch \`${r.branch}\` is in the runner's bare repository; it was not pushed (publishing is cut 3). The bundle and diff are kept with the run's record.`);
  lines.push(
    result.outcome === null
      ? "The run passed the gate — handed over for you to publish from the bundle."
      : result.outcome === "env-failure"
        ? "An environment step did not answer before the work started; the label is kept so a later run can take it."
        : "The work could not be completed; the ticket is labelled for a person.",
  );
  return lines.join("\n").replace(/wc_[0-9a-f]{6,}/gi, "wc_…");
}

/** Settle the release: a released claim's token is deleted; anything else keeps the token and is recorded owed for step 0. */
function settleRelease(reply: ClaimReply, runnerDir: string, claimId: string, owed: string[]): "released" | "owed" {
  if (reply.kind === "released") {
    deleteToken(claimsDir(runnerDir), claimId);
    return "released";
  }
  owed.push(`release claim ${claimId}: ${claimWhy(reply)}`);
  return "owed";
}

/**
 * One live run: the brain check, the claim, the move to In Progress, the local run, then the hand-back — the ticket to
 * Backlog (relabelled for a person unless the environment failed), the comment, and the release. A Linear move that
 * fails is recorded owed, not fatal; a release that can't land keeps the token for step 0. Never throws.
 */
export async function liveRun(input: LiveInput): Promise<LiveResult> {
  const d = input.deps;
  const ident = input.runInput.ticket.identifier;
  const owed: string[] = [];
  const notes: string[] = [];

  // Step 3 — stable must answer and be stable before a claim (claims.ts). Brain down: no claim, no move; a later tick retries (the label is untouched).
  const ready = await brainReady(d.fetch, input.cfg, d.brainKey);
  if (!ready.ok) {
    return { stage: "brain", claimId: null, outcome: "env-failure", ran: false, handedBack: false, commented: false, released: "n/a", owed, notes, detail: `stable not ready: ${ready.detail}` };
  }

  // Step 3 — claim before the branch. Not claimed (held, refused, error): stop, having moved nothing.
  const claim = await claimWork(d.fetch, ready.base, d.brainKey, { ticket: ident, ...(input.piece === undefined ? {} : { piece: input.piece }), lease_seconds: input.leaseSeconds, label: input.claimLabel });
  if (claim.kind !== "claimed") {
    return { stage: "claim", claimId: null, outcome: null, ran: false, handedBack: false, commented: false, released: "n/a", owed, notes, detail: `not claimed: ${claimWhy(claim)}` };
  }
  const claimId = claim.claim.id;
  const token = claim.token;
  writeToken(claimsDir(d.runnerDir), { id: claimId, token, ticket: ident, piece: input.piece ?? null, lease_seconds: input.leaseSeconds });

  // A ticket the brain already records closed still minted a token (claims.ts): release it at once, never run (docs step 3).
  if (claim.ticketClosed) {
    const rel = await releaseClaim(d.fetch, ready.base, d.brainKey, { id: claimId, token, reason: `${ident} is ${claim.ticketClosed.statusType}; claimed and released without running` });
    const released = settleRelease(rel, d.runnerDir, claimId, owed);
    return { stage: "closed", claimId, outcome: null, ran: false, handedBack: false, commented: false, released, owed, notes, detail: `ticket closed (${claim.ticketClosed.statusType})` };
  }

  // Step 4 — move to In Progress. Best-effort and people-facing: the claim, not the state, holds the work, and the run
  // ends by moving the ticket to Backlog anyway — so a failure here is noted, never owed (step 0 must not re-move a
  // handed-back ticket to In Progress).
  const toProgress = await moveToInProgress(d.gql, input.cfg, ident);
  if (!toProgress.ok) notes.push(`couldn't move ${ident} to In Progress (people-facing only): ${toProgress.detail}`);

  // Steps 4-10 — the whole local run on the real claim. run() records failures as outcomes and doesn't throw but for a
  // catastrophic I/O error (its record unwritable); catch that too, so the claim is never left orphaned (SMD-4087's
  // Verify) before cut 3's reconcile exists — hand back as a work failure and release.
  let result: RunResult;
  try {
    result = await d.run({ ...input.runInput, claimId });
  } catch (e) {
    const why = String((e as Error)?.message ?? e).replace(/wc_[0-9a-f]{6,}/gi, "wc_…").slice(0, 200);
    const rel = await releaseClaim(d.fetch, ready.base, d.brainKey, { id: claimId, token, reason: `agent-runner errored before finishing: ${why}` });
    const released = settleRelease(rel, d.runnerDir, claimId, owed);
    const back = await handBack(d.gql, input.cfg, { identifier: ident, kind: "work", readyLabelId: d.readyLabelId, handedBackLabelId: d.handedBackLabelId });
    if (!back.ok) owed.push(`hand ${ident} back (work): ${back.detail}`);
    const cm = await comment(d.gql, ident, `**Agent runner — the run errored before it finished.** ${why}. The ticket is labelled for a person; no branch was published.`);
    if (!cm.ok) owed.push(`comment on ${ident}: ${cm.detail}`);
    return { stage: "ran", claimId, outcome: "work-failure", ran: true, handedBack: back.ok, commented: cm.ok, released, owed, notes, detail: `run errored: ${why}` };
  }

  // The hand-back (docs, "On a failure"): release the claim first, so it is never held longer than it must be
  // (SMD-4087's "never an orphaned claim"), then move the ticket to Backlog and comment. Env failure keeps the label; a
  // pass or a work failure relabels for a person. No re-select race: the ticket stays In Progress until the atomic
  // Backlog+relabel move, and runs are serial (decision 7).
  const reason = `agent-runner ${result.outcome ?? "passed the gate"} — run ${result.record.run}, branch ${result.record.branch} in the bare repository, not pushed (publishing is cut 3)`;
  const rel = await releaseClaim(d.fetch, ready.base, d.brainKey, { id: claimId, token, reason });
  const released = settleRelease(rel, d.runnerDir, claimId, owed);

  const kind: "work" | "env" = result.outcome === "env-failure" ? "env" : "work";
  const back = await handBack(d.gql, input.cfg, { identifier: ident, kind, readyLabelId: d.readyLabelId, handedBackLabelId: d.handedBackLabelId });
  if (!back.ok) owed.push(`hand ${ident} back (${kind}): ${back.detail}`);
  const commented = await comment(d.gql, ident, handbackComment(result));
  if (!commented.ok) owed.push(`comment on ${ident}: ${commented.detail}`);

  return { stage: "ran", claimId, outcome: result.outcome, ran: true, handedBack: back.ok, commented: commented.ok, released, owed, notes, detail: `ran: ${result.outcome ?? "gate passed"}` };
}
