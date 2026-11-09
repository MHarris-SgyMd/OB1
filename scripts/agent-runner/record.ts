/**
 * record.ts — a run's record (SMD-4087 cut 2b; docs/agent-runner.md, "Secrets and records", "A run, step by step").
 * Each run has a directory under the runner's state (`runs/<run>/`) holding the run's facts as JSON (`record.json`),
 * the session artefacts (settings, guard logs, streams, written there by session.ts), the bundle and the diff. The
 * agent never writes the record: it sits outside the clone, and the record file is written owner-only, never through a
 * link. SMD-4091's report reads these records; cut 3's reconcile reads the outcome and the steps still owed.
 *
 * This module is the record's shape and its I/O. It starts no session and runs no git; cut 2b's run orchestration
 * (2b-2) and the gate (gate.ts) fill the fields.
 */

import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The steps a run passes through, in order. Cut 2b reaches `gate`; the claim, publish and end are cuts 2c and 3. */
export const STEPS = ["lock", "gates", "select", "claim", "prepare", "work", "review", "gate", "publish", "end"] as const;
export type Step = (typeof STEPS)[number];

/** How a run ended, or null while it runs. A work failure hands the ticket to a person; an environment failure keeps the label (docs, "On a failure"). */
export const OUTCOMES = ["published", "work-failure", "env-failure", "handed-over", "no-op"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** A step a run couldn't finish now (a release while stable is down, a `CLAIM_UNATTRIBUTED`): step 0 retries it each tick (cut 3). */
export type OwedStep = { kind: "release" | "comment" | "label" | "move" | "capture"; why: string; at: string };

/** The gate's verdict, as the record keeps it: whether it passed and which checks failed (gate.ts computes it). */
export type GateSummary = { pass: boolean; failed: string[]; ciCheckFiles: string[] };

/** A session's reported cost and turns, by role, as the run counts them (docs, "Limits"). */
export type SessionCost = { role: "worker" | "review"; turns: number | null; costUsd: number | null; ended: string };

/**
 * A run's facts, the whole of `record.json`. The runner writes it; the agent can't. Every field a later cut needs is
 * here from the start, so the shape doesn't change under a running record: unset fields are null or empty until their
 * step sets them.
 */
export type RunRecord = {
  /** The run's id, the directory name: an ISO time with ':' and '.' replaced, so it sorts and is a safe path. */
  run: string;
  /** The ticket worked, e.g. "SMD-1234". */
  ticket: string;
  /** The base commit the clone starts at (origin/main's head at the tick). */
  base: string;
  /** The branch the session commits on, `agent/smd-<n>-<slug>`. */
  branch: string;
  /** The claim the run works under, or null until cut 2c claims (cut 2b runs unclaimed, against the stand-in API). */
  claimId: string | null;
  /** The draft PR's number once published (cut 3), else null. */
  pr: number | null;
  /** The worker session's process group, for the signal handling and reconcile (step 0). */
  pgid: number | null;
  /** The step the run last reached. */
  step: Step;
  /** How it ended, or null while it runs. */
  outcome: Outcome | null;
  /** Steps still owed, retried by step 0 (cut 3). A record is finished only when this is empty and the outcome is set. */
  owed: OwedStep[];
  startedAt: string;
  endedAt: string | null;
  /** Each session's turns and cost. */
  sessions: SessionCost[];
  /** The gate's verdict, once it has run. */
  gate: GateSummary | null;
  /** A short free-text note per step, for the record's reader; never model text (that goes only to the PR body). */
  notes: string[];
};

/** Where the runner keeps its state by default; a test or probe passes another. */
export const DEFAULT_STATE = (home: string): string => join(home, ".local", "share", "open-brain", "agent-runner");
/** The runs live under `<state>/runs/`. */
export const runsDir = (state: string): string => join(state, "runs");
/** A run's own directory. */
export const runDir = (state: string, run: string): string => join(runsDir(state), run);

/** The paths inside a run's directory. The session's `record` directory is the run directory itself, so session.ts writes its settings, guard logs and streams here. */
export const recordFile = (dir: string): string => join(dir, "record.json");
export const clonePath = (dir: string): string => join(dir, "clone");
export const reviewCheckout = (dir: string): string => join(dir, "review");
export const bundleFile = (dir: string): string => join(dir, "branch.bundle");
export const diffFile = (dir: string): string => join(dir, "diff.txt");

/** A run id from a time: the ISO string with ':' and '.' made '-', so it is a safe, sortable directory name. */
export const runId = (at: Date = new Date()): string => at.toISOString().replace(/[:.]/g, "-");

/** A slug from a ticket's title: lower-case words joined by '-', cut to 40 chars, so `agent/smd-<n>-<slug>` is a plain branch name. */
export function slugOf(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return s || "work";
}

/** The branch for a ticket and title: `agent/smd-<n>-<slug>`, lower-case, from the ticket's number and a slug. */
export function branchFor(ticket: string, title: string): string {
  const n = /(\d+)\s*$/.exec(ticket)?.[1] ?? "0";
  return `agent/smd-${n}-${slugOf(title)}`;
}

/** Writes text to a file, owner-only, truncating, never following a link (so nothing redirects the record). */
export function writeNoFollow(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Reads a file whole, never following a link. */
export function readNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** A fresh record for a run, with only what the first steps know; the directory is made 0700. */
export function startRecord(state: string, fields: { run: string; ticket: string; base: string; branch: string }): RunRecord {
  const dir = runDir(state, fields.run);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const record: RunRecord = {
    run: fields.run,
    ticket: fields.ticket,
    base: fields.base,
    branch: fields.branch,
    claimId: null,
    pr: null,
    pgid: null,
    step: "prepare",
    outcome: null,
    owed: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    sessions: [],
    gate: null,
    notes: [],
  };
  writeRecord(dir, record);
  return record;
}

/** Writes a record to its directory's `record.json`, pretty and newline-terminated, owner-only and never through a link. */
export function writeRecord(dir: string, record: RunRecord): void {
  writeNoFollow(recordFile(dir), `${JSON.stringify(record, null, 2)}\n`);
}

/** Reads a run's record. Throws if it isn't there or isn't a record. */
export function readRecord(dir: string): RunRecord {
  const parsed: unknown = JSON.parse(readNoFollow(recordFile(dir)));
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as RunRecord).run !== "string") throw new Error(`not a run record: ${recordFile(dir)}`);
  return parsed as RunRecord;
}

/** Applies a change to a record and writes it back, returning the new record. The one way a record is updated, so every write is whole and atomic. */
export function updateRecord(dir: string, change: (r: RunRecord) => void): RunRecord {
  const record = readRecord(dir);
  change(record);
  writeRecord(dir, record);
  return record;
}

/** Every run directory under a state, newest first (the names sort by time). A record that won't parse is skipped, its name returned for the caller to note. */
export function listRuns(state: string): { runs: string[]; unreadable: string[] } {
  let names: string[];
  try {
    names = readdirSync(runsDir(state)).sort().reverse();
  } catch {
    return { runs: [], unreadable: [] };
  }
  const runs: string[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    try {
      readRecord(runDir(state, name));
      runs.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { runs, unreadable };
}

/** A record is finished when it ended (an outcome is set) and nothing is owed; step 0 reconciles the rest (cut 3). */
export const isFinished = (r: RunRecord): boolean => r.outcome !== null && r.owed.length === 0;
