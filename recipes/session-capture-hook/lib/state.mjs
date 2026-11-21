/**
 * lib/state.mjs — where the session hook keeps its files (SMD-4338): the
 * entry file a detached child re-runs (`SELF`), the config's path, and the
 * state root with its queue (pending/, inflight/, dead/), its per-session
 * chains, its claims on payloads and its log. The one owner of the state root:
 * `useStateRoot` is the only writer of `STATE_DIR`, which a module that reads
 * it reads as an import, so each read sees the root of the brain the run is on.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, rmdirSync, appendFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

/**
 * The entry file, which a detached child re-runs and the entry's own guard
 * compares with the command line: set by the entry at load (useSelf), from its
 * own `import.meta.url`, so a copy under another name names itself (SMD-4338
 * review pass 1: derived here as lib/'s parent's `session-capture.mjs`, such a
 * copy ran nothing and said nothing). One process, one entry: two entry files
 * loading this one module would share the last one's.
 */
let SELF = "";
function useSelf(path) { SELF = path; }
const HOME = homedir();
export const CONFIG_PATH = process.env.OB1_SESSION_CAPTURE_CONFIG
  || join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "open-brain", "session-capture.json");
export const STATE_BASE = process.env.OB1_SESSION_CAPTURE_STATE
  || join(process.env.XDG_STATE_HOME || join(HOME, ".local", "state"), "open-brain", "session-capture");
/**
 * The state root every queue, chain and log below is read from: STATE_BASE for
 * the first brain (where a one-brain config has always kept it), and
 * STATE_BASE/brains/<name> for each brain after it (SMD-3313), set by
 * useStateRoot before a brain's run — so each brain has its own pending,
 * inflight and dead queues, its own chain per session (the id an episode
 * supersedes is that brain's own) and its own log, and a brain away delays no
 * other.
 */
export let STATE_DIR = STATE_BASE;
export function useStateRoot(dir) { STATE_DIR = dir; }
const LOG_PATH = () => join(STATE_DIR, "log");
const PENDING_DIR = () => join(STATE_DIR, "pending");
const DEAD_DIR = () => join(STATE_DIR, "dead");
/** Payloads a running child has claimed, one directory per pid: a rename into it is the claim, and exactly one child's rename succeeds. */
const INFLIGHT_DIR = () => join(STATE_DIR, "inflight");

function ensureDirs() {
  for (const d of [STATE_DIR, PENDING_DIR(), DEAD_DIR(), INFLIGHT_DIR()]) mkdirSync(d, { recursive: true, mode: 0o700 });
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
/**
 * How long a claim may go without progress before it is judged abandoned:
 * longer than one payload takes — postCapture's six requests at most (one
 * and five refusal retries) at POST_TIMEOUT_MS, 540 s against these 900 — and
 * the claim directory's mtime
 * moves at every payload a run turns to, so a long run is judged by its last
 * step, not its first (second review pass: five payloads of six requests
 * each could outlast the age from the run's start, and a live run swept
 * mid-flight posts twice — the sibling posts the payload pointerless, the run
 * posts it again and its bookkeeping fails on the swept path).
 */
const CLAIM_MAX_AGE_MS = 15 * 60_000;
/**
 * Payloads claimed by a child that is gone (killed, crashed) go back to
 * pending/, so nothing is lost to an interrupted run. A claim older than any
 * run can last goes back too, whatever its pid says: after a reboot the number
 * belongs to some other process, and a claim judged by liveness alone would
 * stay stuck for as long as that process lives (fourth review pass).
 */
function sweepInflight() {
  for (const name of readdirSync(INFLIGHT_DIR())) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    const dir = join(INFLIGHT_DIR(), name);
    let age = Infinity;
    try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; }
    if (isAlive(pid) && age < CLAIM_MAX_AGE_MS) continue;
    release(dir, { keepTemps: isAlive(pid) }); // a live child stalled past the age is still writing: its temp is its own (ninth review pass)
  }
}
/**
 * Give a claim directory's contents back: every payload to pending/, anything
 * else — a temp file a child left mid-write — unlinked, since it is no
 * payload (sixth review pass: swept along, it lived under pending/ for ever);
 * then the directory goes. Spelled once for the sweep and a run's end
 * (SMD-2035's second boyscout).
 */
function release(dir, { keepTemps = false } = {}) {
  try { for (const f of readdirSync(dir)) { try { if (f.endsWith(".json")) renameSync(join(dir, f), join(PENDING_DIR(), f)); else if (!keepTemps) unlinkSync(join(dir, f)); } catch { /* a sibling swept it */ } } } catch { /* swept from under us: nothing left to return */ }
  try { rmdirSync(dir); } catch { /* not empty after all, or gone */ }
}
/**
 * Take a payload into this run's claim directory `mine`: a rename exactly one
 * of two children wins, then the file read; one that will not parse goes to
 * dead/. Null when a sibling has it, or it would not parse. Spelled once for
 * the run's head and its follow-up (SMD-2035's second boyscout).
 */
function claim(home, mine) {
  const here = join(mine, basename(home));
  try { renameSync(home, here); } catch { return null; } // a sibling has it
  try {
    const payload = JSON.parse(readFileSync(here, "utf8"));
    if (!payload || typeof payload !== "object") throw new Error("not an object"); // a literal `null` parses, and would have thrown at the first field, outside every guard (eleventh review pass)
    return { home, here, payload };
  } catch { moveTo(here, DEAD_DIR()); log(`dead ${basename(home)} — not a payload this run can read`); return null; }
}
const moveTo = (from, dir) => { try { renameSync(from, join(dir, basename(from))); return true; } catch { return false; } };
/** Dead letters are kept for an operator to read (the README's troubleshooting), not forever: after thirty days they are removed (eighth review pass — an endpoint down for an afternoon filled dead/ and nothing pruned it). */
const DEAD_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** How long a payload the server keeps failing to take waits under pending/ before it is given up: longer than any outage worth riding out. */
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
function pruneDead() {
  for (const f of readdirSync(DEAD_DIR())) {
    try { if (Date.now() - statSync(join(DEAD_DIR(), f)).mtimeMs > DEAD_MAX_AGE_MS) unlinkSync(join(DEAD_DIR(), f)); } catch { /* gone, or not ours to remove */ }
  }
  // A temp file a writer left under the state directory or pending/ — killed
  // between its write and its rename — is nobody's once older than any run
  // lasts; the sweep reaches only the claim directories (seventh review pass).
  for (const dir of [STATE_DIR, PENDING_DIR()]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; } // removed under the run: nothing to prune there
    for (const f of names) {
      if (!f.endsWith(".tmp")) continue;
      try { if (Date.now() - statSync(join(dir, f)).mtimeMs > CLAIM_MAX_AGE_MS) unlinkSync(join(dir, f)); } catch { /* gone */ }
    }
  }
}
/**
 * The session's payloads still pending or in flight: a name is
 * `<ms>-<seq>-<rand>-<session>.json`, so the session is everything after the
 * third hyphen, compared whole — a suffix match let session `abc` claim
 * `run-abc`'s payloads (eleventh review pass). `pid` is the child whose claim
 * holds it, null under pending/ (SMD-2035); a look that only asks what other
 * children hold leaves pending/ unread.
 */
function listPayloads({ pending = true } = {}) {
  const out = [];
  const dirs = pending ? [{ dir: PENDING_DIR(), pid: null }] : [];
  try { for (const pid of readdirSync(INFLIGHT_DIR())) dirs.push({ dir: join(INFLIGHT_DIR(), pid), pid: Number(pid) }); } catch { /* no inflight dir yet */ }
  for (const { dir, pid } of dirs) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      const parts = f.split("-");
      out.push({ path: join(dir, f), name: f, ms: Number(parts[0]), pid, tail: parts.slice(3).join("-") });
    }
  }
  return out;
}
/** A session's — a chain's — payloads out of a listing: those whose name ends in its sanitised key. `prepare` walks the queue once for every episode (SMD-2013's first review pass: once per episode). */
function sessionPayloads(sessionId, opts = {}, listing = listPayloads(opts)) {
  const tail = basename(statePath(sessionId));
  return listing.filter((p) => p.tail === tail);
}
/**
 * When the session's summary was last ATTEMPTED: the state's recorded time,
 * or a payload of the session still pending or in flight (its name begins with
 * the millisecond it was prepared). The Stop interval gates on this, not on the
 * last LANDED capture — with the endpoint away nothing lands, and a gate on
 * landings let every turn queue a payload and spawn a child (eighth review pass).
 */
function lastAttemptMs(sessionId, state, queued = sessionPayloads(sessionId)) {
  const times = [];
  const recorded = state?.summary_at ?? state?.captured_at;
  if (recorded) times.push(Date.parse(recorded));
  for (const p of queued) times.push(p.ms);
  const ms = times.filter((t) => Number.isFinite(t) && t <= Date.now());
  return ms.length ? { at: Math.max(...ms), pending: times.length > (recorded ? 1 : 0) && Math.max(...ms) !== Date.parse(recorded ?? "") } : null;
}
function log(line) {
  try { ensureDirs(); appendFileSync(LOG_PATH(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* a log failure never fails the hook */ }
}
function statePath(sessionId) {
  return join(STATE_DIR, `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}
export function readState(sessionId) {
  // The state file's name is `sessionId` sanitised, and `#` sanitises to `_`
  // (SMD-2013), so a chain `<sid>#e2` and a session id literally ending `_e2`
  // share one file. A state that records a DIFFERENT chain than the one asked
  // for is not this one's — as the follow-up asks a payload whose it is (third
  // review pass). A file from before episodes carries no `chain_id` and is its
  // session's.
  try { const j = JSON.parse(readFileSync(statePath(sessionId), "utf8")); return j && j.chain_id && j.chain_id !== sessionId ? null : j; } catch { return null; }
}
/**
 * Every file in the state directory: pretty JSON, a trailing newline,
 * owner-only. One home for the mode (seventh review pass: it was spelled four
 * times). Written beside and renamed into place: a sibling run reads a landed
 * payload's `captured_id` and the state (SMD-2035), and a truncating write
 * would show it an empty file for a moment (fifth review pass). The temp
 * name carries this process's pid: the state file is one path for every
 * child, and two finishing one session's bookkeeping at once shared a name,
 * so one's rename found nothing (sixth review pass). It ends in no `.json`,
 * so no reader of the directories takes it for a payload, and the sweep
 * unlinks one a child left behind.
 */
const writeJson = (p, obj) => {
  const tmp = `${p}.${process.pid}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, p); } catch (e) { try { unlinkSync(tmp); } catch { /* never made */ } throw e; } // a write or rename that fails leaves no temp behind (seventh and ninth review passes: one per run, for as long as the fault lasted)
};
function writeState(sessionId, state) {
  ensureDirs();
  writeJson(statePath(sessionId), state);
}

export { CLAIM_MAX_AGE_MS, DEAD_DIR, DEAD_MAX_AGE_MS, HOME, INFLIGHT_DIR, LOG_PATH, PENDING_DIR, PENDING_MAX_AGE_MS, SELF, claim, ensureDirs, isAlive, lastAttemptMs, listPayloads, log, moveTo, pruneDead, release, sessionPayloads, statePath, sweepInflight, useSelf, writeJson, writeState };
