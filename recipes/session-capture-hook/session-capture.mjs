#!/usr/bin/env bun
/**
 * session-capture.mjs — a session hook for Claude Code and Codex that captures
 * ONE summary thought into Daemonic Brain at each of a session's checkpoints — a
 * compaction (Claude Code's PreCompact) and the session's end — with the
 * thoughts the session retrieved as its provenance (SMD-1298, SMD-2012) —
 * one thought per EPISODE of the session, not per session (SMD-2013): a
 * long session is several pieces of work, and each gets its own summary, its
 * own provenance and its own supersedes chain.
 *
 * What it sends: a summary this script derives from the transcript — what was
 * asked (the human prompts), what came out (the assistant's last message), what
 * changed (file paths, a commit count, PR links), and how many thoughts the
 * session read from or wrote to the brain. Those thoughts' ids go in
 * `derived_from`, so the trace_provenance SQL function (migration 025) walks
 * from the summary to them and find_derivatives from any of them to the
 * session; search results mark a superseded hit. The transcript itself is
 * never sent, and nothing is read from the brain — the hook holds a
 * capture-scoped key (`bun keygen.ts --scope capture`), which the server
 * registers `capture_thought` for, the priority writers on its own
 * thoughts (SMD-3664) and the open-item writers on its own items (SMD-3665),
 * and no read.
 *
 * Before anything leaves the machine the summary is scanned for secrets — the
 * common key prefixes, credential assignments, a URL carrying a password, and
 * high-entropy tokens. A secret on ONE line is REDACTED (SMD-2127): the span
 * becomes `[redacted:<reason>]` in the prompts, the outcome and the title
 * before the text is rendered, the text is scanned again, and only a text that
 * second scan finds clean is sent. A MULTI-LINE key blob — a pasted PEM or PGP
 * block, a wrapped base64 key — is REFUSED, not redacted: blanking a block
 * precisely proved leaky, and losing one summary beats sending a line of a key.
 * A refusal prints the reason (never the match), exits 1, and the session ends
 * as it would have. OB1_CAPTURE_ON_SECRET=refuse refuses on every hit, blob or
 * not. Exit 2 is the one code a Stop hook may block with; as a hook
 * this script never uses it (the by-hand forms — --print-hook, --dry-run — exit
 * 2 on misuse).
 *
 * Time budget: Claude Code gives SessionEnd hooks 1.5 s by default (raised to the
 * hook's `timeout`, at most 60), Codex 1 s (at most 3); PreCompact shares no
 * budget, but a compaction waits on it, so it is printed with the same 10 s. The hook does its local
 * work — read, summarise, scan — in the foreground, well inside a second, then
 * hands the network call to a detached child and exits 0. The child posts,
 * records the new thought's id in the state directory, and appends a line to the
 * log; a post that fails waits under pending/ for a later run, which claims what
 * it posts by a rename so two runs never share a file, drops an older
 * payload of a session that has since ended again as obsolete, and steps
 * aside for an earlier payload of its own session still in another child's
 * hands, so that it lands first and the later one supersedes it (SMD-2035).
 * A later run for
 * the same session (a compaction, a Stop hook with --min-interval, or a session
 * resumed under the same id — `claude --resume`, a Codex resume — ending again)
 * captures a fresh summary that SUPERSEDES the earlier one, so a session is one
 * current thought however many times it is captured; a summary of a session
 * still running says so in a Checkpoint line, which its end drops. A fork under
 * a new id is a new session with its own summary.
 *
 * Both harnesses hand a hook the same JSON on stdin — session_id,
 * transcript_path, cwd, hook_event_name — so one script serves both; the
 * transcript's first line says which wrote it.
 *
 *   bun session-capture.mjs --version                    # prints "session-capture <version>" (SMD-4378)
 *   bun session-capture.mjs --print-hook claude-code     # the settings.json to paste (SessionEnd + PreCompact); installs nothing
 *   bun session-capture.mjs --print-hook codex           # the hooks.json to paste (SessionEnd: Codex has no compaction hook)
 *   bun session-capture.mjs --print-hook claude-code --event Stop --min-interval 20   # the coarser checkpoint: a turn, at most every 20 min
 *   bun session-capture.mjs --check                      # config + endpoint (warned if on a pre-v2.0.0 stack's legacy root or tier route) + key scope; writes nothing
 *   bun session-capture.mjs --dry-run <transcript.jsonl> # print what WOULD be sent; sends nothing (--event PreCompact --trigger auto previews a checkpoint's)
 *   bun session-capture.mjs --print-hook claude-code --claims   # the claims hook: renews a worktree's work claims while a session works (SMD-3602)
 *   bun session-capture.mjs --renew-claims [--cwd <dir>] [--claim <id>]  # renew the claims this worktree keeps tokens for, now
 *   bun session-capture.mjs --copy-forget <id> --from <name> [--client-key <uuid>] [--brain <name>] [--yes]  # copy a forget the hook missed (SMD-4411); says what it would do until --yes
 *   bun session-capture.mjs                              # as the hook: hook JSON on stdin
 *
 * Bun or Node 18+, no dependencies. The hook is this file and the modules in
 * lib/ beside it (SMD-4338): a hook command names this file, a copy of the hook
 * copies lib/ with it, and every export is this file's. Config (0600, never in
 * a hook command line):
 *   ${XDG_CONFIG_HOME:-~/.config}/open-brain/session-capture.json
 *   { "url": "http://127.0.0.1:8010/mcp", "key": "<the raw capture key>" }
 * or several brains, each its own url and capture key (SMD-3313):
 *   { "brains": [{ "name": "stable", "url": "…/mcp", "key_file": "…" }, { "name": "canary", … }] }
 * A brain's `claim_key` (or `claim_key_file`) is the key agents claim work
 * with, which renews the claims whose tokens a worktree keeps in
 * `.work-claims/` (SMD-3602).
 * State and log: ${XDG_STATE_HOME:-~/.local/state}/open-brain/session-capture/
 * (the first brain's; each brain after it under brains/<name>/, its own queue,
 * chains and log: a brain away delays no other).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, openSync, closeSync, statSync, fstatSync, realpathSync, utimesSync, linkSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UUID, oneLine, shownUrl } from "./lib/util.mjs";
import { CLAIM_MAX_AGE_MS, CONFIG_PATH, DEAD_MAX_AGE_MS, LOG_PATH, PENDING_MAX_AGE_MS, SELF, STATE_BASE, STATE_DIR, ensureDirs, isAlive, log, readState, useSelf, useStateRoot } from "./lib/state.mjs";
import { SECRET_MODES, SECRET_PATTERNS, countRedactions, describeRedactions, redactSecrets, redactionMarker, scanForSecrets, secretMode } from "./lib/secrets.mjs";
import { CaptureError, REFUSAL_RE, SDK_ERROR_RE, parseRpcBody, resultText, rpc, textOfResult } from "./lib/rpc.mjs";
import { BRAIN_NAME_RE, CONNECTOR_RE, endpointOf, loadBrains, loadConfig, splitUserinfo } from "./lib/config.mjs";
import { CLAIMS_DIRNAME, UUID_ONLY_RE, checkClaims, claimFiles, noteAgentClaimCall, renewClaim, renewClaims, renewEveryMs, scrubTokens, worktreeRoot } from "./lib/claims.mjs";
import { DEFAULT_EVENTS, EVENTS, HARNESS, HARNESSES, HOOK_EVENTS, HOOK_VERSION, INTERVAL_EVENTS, TRIGGERS, TRIGGER_EVENTS, VERSION_RE, checkpointOf, eventSpec } from "./lib/hook.mjs";
import { LIMITS, NOT_TICKETS, anchorOf, assistantExcerpt, boundaryBegan, boundaryEnded, cleanEpisode, distinctPrompts, episodeChain, gateFindings, headerTickets, provenanceOf, redactEpisode, renderSummary, scanSummary, segment, stripInjected, ticketsIn, when } from "./lib/episode.mjs";
import { parseClaudeCode, parseCodex, sniffHarness, summariseTranscript } from "./lib/transcript.mjs";
import { egressRefusalForModel, modelStatusLine, modelSummary } from "./lib/model.mjs";
import { RUN_MAX, aheadOf, checkBrain, detachPost, landedAfter, landedBefore, newerInFlight, pointerFor, postCapture, postPending, prepare, providerMends, verdictOf } from "./lib/post.mjs";
// The exports that moved to lib/ (SMD-4338), re-exported so every name this file exported before is still its own: the suite,
// the agent runner, server-portable's suite and db/test-live.ts import from here.
export { CLAIMS_DIRNAME, CONFIG_PATH, CaptureError, DEFAULT_EVENTS, EVENTS, HARNESS, HARNESSES, HOOK_EVENTS, HOOK_VERSION, INTERVAL_EVENTS, LIMITS, NOT_TICKETS, REFUSAL_RE, RUN_MAX, SDK_ERROR_RE, SECRET_MODES, SECRET_PATTERNS, STATE_BASE, STATE_DIR, TRIGGERS, TRIGGER_EVENTS, VERSION_RE, aheadOf, assistantExcerpt, checkpointOf, claimFiles, cleanEpisode, describeRedactions, egressRefusalForModel, endpointOf, episodeChain, eventSpec, gateFindings, headerTickets, landedAfter, landedBefore, loadBrains, loadConfig, modelStatusLine, modelSummary, newerInFlight, parseClaudeCode, parseCodex, parseRpcBody, pointerFor, postCapture, postPending, prepare, provenanceOf, providerMends, readState, redactEpisode, redactSecrets, redactionMarker, renderSummary, renewClaim, renewClaims, renewEveryMs, resultText, rpc, scanForSecrets, scanSummary, secretMode, segment, shownUrl, sniffHarness, splitUserinfo, stripInjected, summariseTranscript, ticketsIn, useStateRoot, verdictOf, worktreeRoot };

// This file, by its own url: the path its detached children re-run and its guard compares (lib/state.mjs, SELF).
useSelf(fileURLToPath(import.meta.url));

// ── The write fan-out (SMD-3314) ─────────────────────────────────────────────
//
// A PostToolUse hook on the brain's write tools: each capture, edit, delete
// and forget that lands on the brain a connector names is repeated on every
// other brain with a write key, through that brain's own key and its own
// queue. A copied capture carries `client_key`: the id the first brain gave
// the thought, which the server keeps on the copy (migration 112), so an edit
// or a pointer that names the thought by that id finds the copy on every
// brain. The queue keeps the first brain's order, one write at a time: a
// capture lands before the edit, the delete or the forget of it, and a brain
// away holds its queue until it answers.

/** The write tools a fan-out repeats: forget_thought since 1.9.0 (SMD-1723 PR 3), a server from 144 on serving it. */
export const FANOUT_TOOLS = ["capture_thought", "update_thought", "delete_thought", "forget_thought"];
/** The fan-out's tools a brain's server may lack and still take the rest: a copy of one is held for it, not refused. */
const FANOUT_LATER = new Set(["forget_thought"]);
const WRITES_DIR = () => join(STATE_DIR, "writes");
const WRITES_PENDING = () => join(WRITES_DIR(), "pending");
const WRITES_DEAD = () => join(WRITES_DIR(), "dead");
const DRAIN_LOCK = () => join(WRITES_DIR(), "drain.lock");
/** A drain lock held this long by a live process is a stalled drain's, and is taken back. */
const DRAIN_LOCK_MAX_AGE_MS = 15 * 60_000;

/** Whether a result is the tool's error: its flag, where the shape carries one, else its words (a refusal, a fault, an unknown id). */
export function resultIsError(resp, text) {
  if (resp && typeof resp === "object" && !Array.isArray(resp) && (resp.isError === true || resp.result?.isError === true)) return true;
  return /^\s*(?:Refused\b|Error\b|No thought with id\b|MCP error\b)/.test(text);
}

/** A value's outline for the log — its types and keys, never its text. */
function shapeOf(v, depth = 0) {
  if (Array.isArray(v)) return depth > 1 ? "list" : `list[${v.length ? shapeOf(v[0], depth + 1) : ""}]`;
  if (v && typeof v === "object") return depth > 1 ? "object" : `{${Object.keys(v).slice(0, 8).map((k) => `${k}: ${shapeOf(v[k], depth + 1)}`).join(", ")}}`;
  return v === null ? "null" : typeof v;
}

/** The named keys of an object that it holds, as they are (a null too: update_thought's `supersedes: null` clears). */
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => Object.hasOwn(o, k)).map((k) => [k, o[k]]));

/**
 * What a PostToolUse hook copies, and where: `{ source, targets, op }`, or
 * `{ skip }` — a reason to log, or null for a tool that is not the fan-out's.
 * The source is the brain whose `connector` names the tool's server; a write
 * through any other server (the canary's own connector, its test traffic) is
 * that brain's alone. The targets are the other brains with a write key.
 */
export function fanOutPlan(hook, brains) {
  const m = /^mcp__(.+)__([a-z_]+)$/.exec(String(hook?.tool_name ?? ""));
  if (!m || !FANOUT_TOOLS.includes(m[2])) return { skip: null };
  const [, server, tool] = m;
  const source = brains.find((b) => b.cfg.connector === server);
  if (!source) return { skip: null };
  const targets = brains.filter((b) => b !== source && b.cfg.writeKey);
  // A forget goes on with none: its drop reaches every brain's queue, and a brain left without a key that has been copied to (its writes/ is there) is held it (queueForget, SMD-4411).
  if (!targets.length && tool !== "forget_thought") return { skip: `${tool} through ${server}: no other brain has a write_key, so nothing is copied` };
  const input = hook.tool_input && typeof hook.tool_input === "object" && !Array.isArray(hook.tool_input) ? hook.tool_input : {};
  const resp = hook.tool_response;
  const text = resultText(resp);
  const first = text.split("\n")[0];
  const sc = resp && typeof resp === "object" && !Array.isArray(resp) ? (resp.structuredContent ?? resp.result?.structuredContent) : undefined;
  const scId = typeof sc?.id === "string" && new RegExp(`^${UUID}$`, "i").test(sc.id) ? sc.id.toLowerCase() : undefined;
  // A write that failed reaches PostToolUseFailure, not this hook; a result
  // that reads as an error is never copied all the same — a refusal's or a
  // fault's code, or a reply that is not the tool's success: `Captured as`,
  // `Updated`, `Deleted`, `Forgot` (review pass 2: a fault's
  // `update_thought failed: …` read as a success).
  const success = { capture_thought: /^Captured as /, update_thought: /^Updated /, delete_thought: /^Deleted /, forget_thought: /^Forgot / }[tool];
  if (resultIsError(resp, text) || typeof sc?.code === "string" || !(success.test(first) || (scId && !/^Already captured\b/.test(first) && sc?.keyed !== "matched")))
    return { skip: /^Already captured\b/.test(first) || sc?.keyed === "matched"
      // The key named a thought already there: nothing was written on the first brain, so nothing is copied (review pass 2).
      ? `capture_thought matched a thought already on ${source.name} by its client_key and wrote nothing, so nothing is copied`
      : `${tool} did not land on ${source.name}, so it is not copied: ${oneLine(text).slice(0, 120) || `its shape: ${shapeOf(resp)}`}` };
  let args, alt;
  if (tool === "capture_thought") {
    // The id the first brain gave it: the result's structured id where the
    // shape carries one, else the reply's first line — `Captured as <type> —
    // id <uuid>`, the type the model's, up to 40 characters, so the id is the
    // one after it, never one a type spells (review pass 1).
    const id = scId
      ?? new RegExp(`^Captured as .*? — id (${UUID})\\b`, "i").exec(first)?.[1]
      ?? new RegExp(`^Captured as\\b.*\\bid (${UUID})\\b`, "i").exec(first)?.[1];
    if (!id) return { skip: `${source.name}'s reply to capture_thought named no id, so it is not copied (its shape: ${shapeOf(resp)})` };
    if (typeof input.content !== "string") return { skip: "capture_thought's input carried no content, so it is not copied" };
    args = { ...pick(input, ["content", "derived_from", "supersedes", "source", "trust", "metadata"]), client_key: id.toLowerCase() };
  } else {
    // The thought by the id the first brain answered: a name the caller gave
    // as a client_key resolved there to the thought's own id, which is the
    // copy's key (review pass 2); else the name as sent.
    const answered = scId ?? new RegExp(`^(?:Updated|Deleted|Forgot) (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
    args = tool === "update_thought"
      // `if_unchanged_since` is the first brain's clock: the copy is always newer, so it is not sent.
      ? pick(input, ["id", "content", "metadata_patch", "supersedes"])
      : pick(input, ["id", "detach_citations"]);
    if (answered) args.id = answered;
    if (typeof args.id !== "string") return { skip: `${tool}'s input carried no id, so it is not copied` };
    if (tool === "forget_thought") {
      // A forget's echo (SMD-1723 PR 3): the name the copy sends, which each brain resolves on its own — the first
      // brain's id, there the copy's client_key — so the echo is checked against what reaches that brain.
      args.confirm = args.id;
      // Its citations there go with it: the person chose to forget on the first brain, and a citation on another is a
      // copy of the text (the maintainer, review pass 1: a copy refused CITED was given up, the text left there).
      args.detach_citations = true;
      // The thought's own client_key, as the reply names it: where the receiving brain knows the thought by that key
      // alone — the thought began there, its id its own — the copy is sent again by it (review pass 1).
      const ownName = new RegExp(`\\bclient_key (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
      if (ownName && ownName !== args.id) alt = ownName;
    }
    if (tool === "update_thought" && Object.keys(args).length === 1) return { skip: `update_thought of ${args.id} changed nothing a copy carries, so it is not copied` };
  }
  return { source, targets, op: { tool, args, ...(alt ? { alt } : {}), from: source.name, session: typeof hook.session_id === "string" ? hook.session_id : null, at: new Date().toISOString() } };
}

/** Writes a copy into the current brain's queue: a name that sorts in the order the hooks ran, written whole before it is seen. */
export function enqueueWrite(op) {
  mkdirSync(WRITES_PENDING(), { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(15, "0")}-${String(process.hrtime.bigint() % 10n ** 15n).padStart(15, "0")}-${process.pid}.json`;
  const tmp = join(WRITES_PENDING(), `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(op), { mode: 0o600 });
  renameSync(tmp, join(WRITES_PENDING(), name));
  return name;
}

/**
 * Removes the current brain's queued and given-up copies that carry a thought by one of `names` — a capture keyed so,
 * an edit or a delete of it — and returns how many (SMD-1723 PR 3). A forget's own copies stay, and so does a queued
 * copy a send may have reached (`sent`), or one in flight or left so by a killed drain (`sending`): it may have landed,
 * or land late, and the forget behind it is what reaches it there — dropped, a capture committed after the forget's
 * NOT_FOUND kept its text for good (review passes 7 and 8). `dirs` narrows it to one of the two (SMD-4411).
 */
export function dropCopiesOf(names, dirs = [WRITES_PENDING(), WRITES_DEAD()]) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  let n = 0;
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")); } catch { continue; }
    for (const f of files) {
      let op;
      try { op = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      if (op?.tool === "forget_thought") continue;
      if ((op?.sent === true || op?.sending === true) && dir === WRITES_PENDING()) continue;
      if (namesOf(op).some((x) => want.has(x))) { try { unlinkSync(join(dir, f)); n++; } catch { /* gone: a drain took it */ } }
    }
  }
  return n;
}
/** The names a queued copy carries a thought by: a capture's client_key, an edit's or a delete's id. */
const namesOf = (op) => [op?.args?.client_key, op?.args?.id].filter((x) => typeof x === "string").map((x) => x.toLowerCase());
/** Whether the current brain's queue still holds a copy of a thought by one of `names` — after a drop, one kept for having maybe landed. */
function queueCarries(names) {
  const want = new Set(names.map((n) => String(n).toLowerCase()));
  return pendingWrites().some((f) => { try { const op = JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8")); return op?.tool !== "forget_thought" && namesOf(op).some((x) => want.has(x)); } catch { return false; } });
}

/**
 * A forget queued (SMD-1723 PR 3, SMD-4411). Each brain it covers — every configured brain with `all`, else the
 * `targets` — first loses its queued and given-up copies of the thought (dropCopiesOf). Then the forget goes into its
 * queue: queued where the brain has a write key, held where it has none but has been copied to (its writes/ is there),
 * to land behind whatever was sent before it once a key is set, as a brain away holds its queue. The brain the forget
 * was made on (`source`) has forgotten it already, but a copy its queue kept for having maybe landed (a two-way
 * fan-out queues copies to it too) would land again, as a new thought under its key: so it is queued the forget too
 * where it has a write key — whatever its queue shows, since a drain racing the drop can write such a copy back after
 * the drop read the queue — and held where it has none and its queue still carries one (review pass 1). By hand
 * (`sourceAlways` false: --copy-forget, which cannot tell a forgotten id from a wrong one) it is queued the forget only
 * where its queue carries a copy, so a wrong id never forgets the person's own thought there (review pass 2). With
 * `all`, a queue left on disk by a brain no longer in the config (renamed, removed) loses its copies too, said in the
 * first brain's log, with the command for one still carrying a copy that may have landed. Each brain is its own step:
 * one whose queue cannot be written is logged, in its own log and the first brain's, with the --copy-forget that
 * redoes it, and the others go on (review passes 2 and 3). Returns `{ queued, held, failed }`: `{ brain, name }` for
 * each queue the forget was queued or held in, and the brains that failed.
 */
export function queueForget(op, brains, { source = null, targets, all, sourceAlways = true }) {
  const names = [op.args.id, op.alt].filter(Boolean);
  const queued = [], held = [], failed = [];
  // Lines for the first brain's log too, the one an operator reads: a forget lost on a brain, a stray queue's copy (review pass 3).
  const notices = [];
  // The command that redoes a forget lost on one brain: --brain names it, save the brain the forget was made on, which --copy-forget sends one only where its queue carries a copy.
  const redo = (name) => `bun ${shellWord(SELF)} --copy-forget ${op.args.id}${op.alt ? ` --client-key ${op.alt}` : ""} --from ${source?.name ?? "<the brain you forgot it on>"}${source && name === source.name ? "" : ` --brain ${name}`} --yes`;
  for (const b of all ? brains : targets) {
    try {
      useStateRoot(b.root);
      const dropped = dropCopiesOf(names);
      if (dropped) log(`fan-out: dropped ${dropped} queued or given-up cop${dropped === 1 ? "y" : "ies"} of ${op.args.id}, which a forget follows`);
      const owed = b !== source || (b.cfg.writeKey && sourceAlways) || queueCarries(names);
      if (!owed) continue;
      if (b.cfg.writeKey) {
        queued.push({ brain: b, name: enqueueWrite(op) });
        log(`fan-out: queued ${opLabel(op)} from ${op.from}${b === source ? ", where it was made: a copy kept here for having maybe landed is sent again before it" : ""}`);
      } else if (existsSync(WRITES_DIR())) {
        held.push({ brain: b, name: enqueueWrite({ ...op, held: true }) });
        log(`fan-out: held ${opLabel(op)} from ${op.from}: this brain has no write_key now; once one is set, it lands, in order, at its next drain`);
      }
    } catch (e) {
      failed.push(b);
      const line = `fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)} — ${opLabel(op)} was not queued for ${b.name}; once that is mended, run: ${redo(b.name)}`;
      log(line);
      notices.push(line);
    }
  }
  if (all) {
    const configured = new Set(brains.map((b) => b.root));
    let stray = [];
    try { stray = readdirSync(join(STATE_BASE, "brains")).map((n) => join(STATE_BASE, "brains", n)).filter((r) => !configured.has(r) && existsSync(join(r, "writes"))); } catch { /* none */ }
    for (const root of stray) {
      // Its own log is no one's now, and log() would make a state there: what it lost and kept is said in the first brain's.
      try {
        useStateRoot(root);
        const dropped = dropCopiesOf(names);
        if (dropped) notices.push(`fan-out: dropped ${dropped} queued or given-up cop${dropped === 1 ? "y" : "ies"} of ${op.args.id} from ${root}, the queue of a brain no longer in the config`);
        // A copy kept for having maybe landed, on a brain no forget can be queued for: named, with what sends one.
        if (queueCarries(names)) notices.push(`fan-out: a copy of ${op.args.id} in ${root} was sent to the brain that queue was for and may have landed there, and no forget follows it: once that brain is back in the config, run: ${redo(basename(root))}`);
      } catch (e) { notices.push(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)} — reading ${root}`); }
    }
  }
  if (notices.length && brains.length) { useStateRoot(brains[0].root); for (const line of notices) if (!failed.includes(brains[0]) || !line.includes(`not queued for ${brains[0].name};`)) log(line); }
  return { queued, held, failed };
}

/**
 * For a PostToolUse run of a forget that landed, the words naming it and the --copy-forget that copies it — for a run
 * whose config did not load, which copies nothing (SMD-4411 review pass 1) — or null. Read from the reply, and the
 * --from brain's name from the config's JSON where it still reads: with no config loaded, which connector the fan-out
 * copies from is unknown, so the words say it applies to that one.
 */
export function lostForget(hook) {
  if (hook?.hook_event_name !== "PostToolUse" || !/^mcp__.+__forget_thought$/.test(String(hook?.tool_name ?? ""))) return null;
  const text = resultText(hook.tool_response);
  if (resultIsError(hook.tool_response, text)) return null;
  const first = text.split("\n")[0];
  const id = new RegExp(`^Forgot (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
  if (!id) return null;
  const ownName = new RegExp(`\\bclient_key (${UUID})\\b`, "i").exec(first)?.[1]?.toLowerCase();
  const server = /^mcp__(.+)__forget_thought$/.exec(String(hook.tool_name))[1];
  // The brain whose connector it is, where the config's JSON still reads (a key file failed, not the file): named (review pass 3).
  let from = `<the brain whose connector is ${server}>`;
  try { const named = JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")).brains?.find?.((b) => b?.connector === server)?.name; if (typeof named === "string" && BRAIN_NAME_RE.test(named)) from = named; } catch { /* unreadable: the placeholder */ }
  return `forget_thought of ${id} was not copied to the other brains, as the config did not load. If it went through the connector the fan-out copies from, run once the config loads: bun ${shellWord(SELF)} --copy-forget ${id}${ownName && ownName !== id ? ` --client-key ${ownName}` : ""} --from ${from}, then again with --yes`;
}

/** The current brain's queued copies, oldest first. */
export const pendingWrites = () => (existsSync(WRITES_PENDING()) ? readdirSync(WRITES_PENDING()).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort() : []);

/**
 * One drain per brain at a time: the lock, or false when a live drain holds
 * it. Its age is the time since its holder last began a copy (drainWrites
 * touches it before each), so a long drain is never mistaken for a stalled
 * one; a dead holder's, or one silent past DRAIN_LOCK_MAX_AGE_MS, is taken
 * back by renaming it aside — one process's rename wins, so two never both
 * take it and each make a lock of its own (review pass 1).
 */
function takeDrainLock() {
  mkdirSync(WRITES_DIR(), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    // Made whole: the pid written to a file of this process's own, then
    // linked into place — the link fails if a lock is there — so no drain
    // ever reads a lock still empty, judges it stale and takes it from the
    // drain making it (review pass 2: the two-drain case caught one doing
    // so, and both stopped).
    const mine = `${DRAIN_LOCK()}.new.${process.pid}`;
    try {
      writeFileSync(mine, String(process.pid), { mode: 0o600 });
      linkSync(mine, DRAIN_LOCK());
      unlinkSync(mine);
      return true;
    } catch (e) {
      try { unlinkSync(mine); } catch { /* not made */ }
      if (e?.code !== "EEXIST") throw e;
      let pid = NaN, age = 0;
      try { pid = Number(readFileSync(DRAIN_LOCK(), "utf8").trim()); age = Date.now() - statSync(DRAIN_LOCK()).mtimeMs; } catch { continue; } // gone between the two: try again
      if (liveLock(pid, age)) { log(`drain: the queue is left to the drain in pid ${pid}`); return false; }
      const aside = `${DRAIN_LOCK()}.${process.pid}`;
      try { renameSync(DRAIN_LOCK(), aside); } catch { continue; } // another took it back first: try for the new one
      // Taken back only if what was moved aside is still a lock to take: its
      // holder may have renewed it, or made a new one, in the gap — judged
      // again on its pid AND its age (review pass 2). One still live goes back
      // by a hard link, which fails rather than overwrite a lock made meanwhile.
      let nowPid = pid, nowAge = age;
      try { nowPid = Number(readFileSync(aside, "utf8").trim()); nowAge = Date.now() - statSync(aside).mtimeMs; } catch { /* unreadable: judged as read */ }
      if (liveLock(nowPid, nowAge)) { try { linkSync(aside, DRAIN_LOCK()); } catch { /* a newer one stands */ } try { unlinkSync(aside); } catch { /* gone */ } log(`drain: the queue is left to the drain in pid ${nowPid}`); return false; }
      try { unlinkSync(aside); } catch { /* gone */ }
      log(`drain: took back the lock of pid ${Number.isInteger(pid) ? pid : "?"}${Number.isInteger(pid) && isAlive(pid) ? `, silent for ${Math.round(age / 60_000)} min` : ", no longer running"}`);
    }
  }
  return false;
}
/** A lock to leave alone: another live process's, renewed within DRAIN_LOCK_MAX_AGE_MS. An unreadable one is not (review pass 2). */
const liveLock = (pid, age) => Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid) && age < DRAIN_LOCK_MAX_AGE_MS;
const releaseDrainLock = () => { try { if (Number(readFileSync(DRAIN_LOCK(), "utf8").trim()) === process.pid) unlinkSync(DRAIN_LOCK()); } catch { /* not ours, or gone */ } };
/** Whether this process still holds the lock, its age reset: false once another has taken it back — the drain stops, the copy left to it. */
const holdDrainLock = () => { try { if (Number(readFileSync(DRAIN_LOCK(), "utf8").trim()) !== process.pid) return false; const t = new Date(); utimesSync(DRAIN_LOCK(), t, t); return true; } catch { return false; } };

/**
 * Whether a queued file holds a copy as the hook writes one: an object whose `tool` is one the fan-out copies
 * (FANOUT_TOOLS: a mistyped one was held a week, the log saying to mint a write key that was fine — review pass 2), an
 * object `args`, an `at` that parses as a date, and the names the drain reads — `args.client_key`, `args.id`, `alt` — each a string or absent.
 * Anything else, a hand edit or a corrupt file, is given up as one that does not parse: it threw on every drain, ahead
 * of the week's give-up, or, with no date, was never given up once a fault kept it, and every copy behind it waited
 * for good (SMD-4412). A name that is no string (`{"toString":1}`) threw wherever a template or String() met it — the
 * log's label, a forget's note, its drop of dead/ copies — so it is refused here, before any of them (review passes 1, 2).
 */
const isCopy = (op) => FANOUT_TOOLS.includes(op?.tool) && op.args !== null && typeof op.args === "object" && !Array.isArray(op.args)
  && Number.isFinite(Date.parse(op.at)) && [op.args.client_key, op.args.id, op.alt].every((n) => n === undefined || typeof n === "string");

/** A copy as the log names it: the tool and the id or key it names, never its text. */
const opLabel = (op) => `${op.tool}${op.tool === "capture_thought" ? ` (client_key ${op.args.client_key})` : ` of ${op.args.id}`}`;

/**
 * One copy onto a brain, through its write key. `done` — landed, or skipped
 * for good: the thought it names was never copied there (NOT_FOUND, marked
 * `notFound`); `keep` — the brain did not answer, or answered a transient: the
 * queue stops here, in order, with `unknown` when the send may have reached the
 * brain (a transport failure past the connection, a fault, a store it could not
 * reach); `dead` — refused for good. A pointer the brain does not know (a
 * thought each brain's own writers made, a board-sync row) is dropped and the
 * write tried again, as the server's contract asks (SMD-3314 PR 1). A forget
 * answered NOT_FOUND or FORGOTTEN is sent again by the thought's own client_key
 * (`alt`) where it carries one (SMD-4411).
 */
export async function postWrite(cfg, op) {
  const wcfg = { ...cfg, key: cfg.writeKey };
  const args = structuredClone(op.args);
  const dropped = [];
  let forgottenBefore = false; // a forget whose id answered FORGOTTEN, sent again by the thought's own client_key
  let byKey = ""; // why a forget went again by the thought's own client_key, for its line
  for (let attempt = 0; attempt < 5; attempt++) {
    let result;
    try { result = await rpc(wcfg, "tools/call", { name: op.tool, arguments: args }); }
    catch (e) {
      const msg = oneLine(String(e?.message ?? e));
      // A real server answers a tool it lacks with a JSON-RPC error, which rpc throws (review pass 7: the lines below
      // never ran against one). A transport failure past the connection (a timeout, a 5xx from a front, a reset) may
      // have reached the brain: its answer is unknown. One refused at the connection, or a name resolving to nothing,
      // never did; nor did a JSON-RPC error, which the server answered.
      const missing = toolMissing(op, msg);
      const unknown = !missing && !/^JSON-RPC /.test(msg) && !NOT_REACHED.has(e?.code) && !NOT_REACHED.has(e?.cause?.code);
      return { keep: true, ...(unknown ? { unknown: true } : {}), line: missing ?? `kept: ${opLabel(op)} — ${msg.slice(0, 200)}` };
    }
    const text = textOfResult(result);
    const note = `${dropped.length ? ` (dropped: ${dropped.join(", ")})` : ""}${byKey ? ` (sent again by its client_key ${op.alt}, ${byKey})` : ""}`;
    // A forget that left some of the thought there (a replay, a fault, on a copy after the first): kept, to be sent
    // again, so its text does not stay there for a copy logged done (SMD-1723 PR 3, review pass 2).
    const missedThere = op.tool === "forget_thought" && !result.isError && Array.isArray(result.structuredContent?.notForgotten) ? result.structuredContent.notForgotten : [];
    if (missedThere.length) return { keep: true, line: `kept: ${opLabel(op)} — forgotten in part there, ${missedThere.length} cop${missedThere.length === 1 ? "y" : "ies"} of it not yet (${[...new Set(missedThere.map((m) => String(m?.code ?? "?")))].join(", ")}): sent again` };
    if (!result.isError) {
      const id = new RegExp(`\\b(${UUID})\\b`, "i").exec(text.split("\n")[0])?.[1];
      const keyed = typeof result.structuredContent?.keyed === "string" ? `, ${result.structuredContent.keyed}` : "";
      // Recorded on a thought this brain already held by the same text — its own, now named by the first brain's id
      // too, so the first brain's later edits and delete reach it (the server's rule: one text, one thought) (review pass 2).
      const onto = result.structuredContent?.keyed === "recorded" && result.structuredContent?.existed === true ? " onto a thought already there by the same text" : "";
      return { done: true, line: `copied ${opLabel(op)}${id ? ` → ${id.toLowerCase()}` : ""}${keyed}${onto}${note}${op.tool === "forget_thought" ? forgetReview(result.structuredContent) : ""}` };
    }
    const v = verdictOf(result, text);
    // Forgotten there already (its own forget, or a copy that landed before a lost answer): done (SMD-1723 PR 3) — once
    // the thought's own client_key is tried too. A copy queued there ahead of this forget, kept for having maybe landed,
    // was sent again and lands as a new thought under that key, which a forget by this name no longer reaches (SMD-4411
    // review pass 1: the first brain's own queue, and --copy-forget given the receiving brain's own id).
    if (op.tool === "forget_thought" && v.code === "FORGOTTEN") {
      if (op.alt && args.id !== op.alt) { args.id = op.alt; args.confirm = op.alt; forgottenBefore = true; byKey = "its id forgotten there already"; continue; }
      return { done: true, line: `copied ${opLabel(op)}: forgotten there already${note}` };
    }
    // A tool this brain cannot call (toolMissing says which): a server from before forget_thought (migration 144),
    // the copy waiting for it, in order, as a brain away does — given up only after the week — so the forget is not
    // lost (SMD-1723 PR 3); or a key that cannot call it (a capture key in write_key), the operator's to fix, which
    // every later copy would meet — kept, in order.
    const cannotCall = SDK_ERROR_RE.test(text) && toolMissing(op, text);
    if (cannotCall) return { keep: true, line: cannotCall };
    // A capture key in write_key, which cannot send a client_key: the operator's to fix, kept, as above.
    if (v.code === "REFUSED_CLIENT_KEY_SCOPE") return { keep: true, line: `kept: ${opLabel(op)} — the write key cannot send a client_key (a capture key); mint a write key on this brain (bun server-portable/keygen.ts --name claude-code --scope write) and set write_key — --check says` };
    // A forget the brain knows by the thought's own client_key alone (the thought began there): sent again by it.
    if (op.tool === "forget_thought" && v.code === "NOT_FOUND" && op.alt && args.id !== op.alt) {
      args.id = op.alt; args.confirm = op.alt;
      byKey = "its id not found there";
      continue;
    }
    // Its id forgotten there already, and nothing there under its client_key either: done.
    if (forgottenBefore && v.code === "NOT_FOUND") return { done: true, line: `copied ${opLabel(op)}: forgotten there already, and nothing there keeps its client_key ${op.alt}` };
    // A forget's NOT_FOUND may also be one forgotten there already, by a copy whose answer was lost — a forgotten copy
    // keeps no key to resolve (SMD-1723 PR 3). `notFound` lets --copy-forget say a name that found nothing (review pass 1).
    if (v.code === "NOT_FOUND") return { done: true, notFound: true, line: `skipped ${opLabel(op)}: no thought there has that id or keeps it as its client_key — never copied to this brain${op.tool === "forget_thought" ? ", or forgotten there already (also, its text kept: a copy deleted there before by its key, on a v2.1.0 server; a thought that began here, its forget from a v2.1.0 first brain, whose reply names no client_key — upgrade both and forget it here)" : ""}${note}` };
    // A fault (FAILED: the REST core away behind the MCP server, the store
    // restarting, a busy registry) carries no `retryable`, which verdictOf reads
    // as final: kept, so a brain mid-restart does not lose its edits (review pass 2).
    if (v.code === "FAILED") return { keep: true, unknown: true, line: `kept: ${opLabel(op)} — ${oneLine(text).slice(0, 200)}` };
    if (v.mend === "derived" && args.derived_from) {
      const at = v.positions.filter((i) => i < args.derived_from.length);
      dropped.push(at.length ? `derived_from[${at.join(", ")}]` : "derived_from");
      args.derived_from = at.length ? args.derived_from.filter((_, i) => !at.includes(i)) : [];
      if (!args.derived_from.length) delete args.derived_from;
      continue;
    }
    // Metadata the brain's server refuses (a key it reserves that the first
    // brain's did not): dropped and sent again, as the session hook drops a
    // summary's (review pass 2).
    if (v.mend === "metadata" && (args.metadata !== undefined || args.metadata_patch !== undefined)) {
      dropped.push(args.metadata !== undefined ? "metadata" : "metadata_patch");
      delete args.metadata; delete args.metadata_patch;
      if (op.tool === "update_thought" && Object.keys(args).length === 1) return { done: true, line: `skipped ${opLabel(op)}: its only change, metadata_patch, this brain refuses (${oneLine(text).slice(0, 120)})` };
      continue;
    }
    if ((v.mend === "supersedes" || v.code === "REFUSED_WOULD_CYCLE") && typeof args.supersedes === "string") {
      dropped.push("supersedes");
      delete args.supersedes;
      if (op.tool === "update_thought" && Object.keys(args).length === 1) return { done: true, line: `skipped ${opLabel(op)}: its only change, supersedes, names no thought there` };
      continue;
    }
    // The receiving brain's embedding provider refusing it (a key or a model its operator mends, SMD-2892): held as a
    // fault is, not given up — its edits and delete would otherwise meet NOT_FOUND there (review pass 1).
    // STORE_UNAVAILABLE is how a capture says the fault FAILED says for an edit: the REST core behind the MCP server
    // away or slow — which may have committed it all the same (review pass 9).
    if (v.retryable || providerMends(result)) return { keep: true, ...(v.code === "STORE_UNAVAILABLE" ? { unknown: true } : {}), line: `kept: ${opLabel(op)} — ${oneLine(text).slice(0, 200)}` };
    return { dead: true, line: `not copied (given up): ${opLabel(op)} — ${oneLine(text).slice(0, 200)}${note}${op.tool === "forget_thought" ? " — its text stays on this brain until forgotten there by hand" : ""}` };
  }
  return { dead: true, line: `not copied (given up): ${opLabel(op)} — still refused after dropping ${dropped.join(", ")}` };
}

/**
 * The current brain's queue, oldest first, one copy at a time, until it is
 * empty or a copy is kept — the rest wait behind it, in order. One drain per
 * brain: a drain that finds the lock held leaves the queue to its holder, and a
 * holder looks once more after it lets go, so a copy queued meanwhile is not
 * left behind. Returns each copy's outcome, with its file's `name` and a
 * forget's `forgetOf`; each is also a line in the log.
 */
export async function drainWrites(cfg) {
  const outcomes = [];
  pruneWrites();
  const seen = new Set(); // names this drain has dealt with: one that answers ENOENT every time (a dangling link) cannot spin it (review pass 2)
  for (;;) {
    if (!takeDrainLock()) return outcomes;
    let stopped = false;
    try {
      for (const name of pendingWrites()) {
        if (seen.has(name)) continue;
        seen.add(name);
        // Still this drain's, its age reset before each copy: a lock another
        // took back means the rest is theirs now (review pass 1). Only a holder
        // silent past DRAIN_LOCK_MAX_AGE_MS loses it — a copy's longest is five
        // attempts at POST_TIMEOUT_MS, well inside — so the one copy such a
        // holder had in flight is the only one two drains can both post, and
        // its key makes the second land as the same thought — unless its
        // forget lands between the two, a gap the lock check just before the
        // send narrows.
        if (!holdDrainLock()) { stopped = true; break; }
        const path = join(WRITES_PENDING(), name);
        let op;
        try { op = JSON.parse(readFileSync(path, "utf8")); } catch (e) {
          if (e?.code === "ENOENT") { try { unlinkSync(path); } catch { /* gone: the holder before finished it */ } continue; }
          moveWrite(path, WRITES_DEAD(), name);
          const o = { dead: true, name, line: `not copied (given up): ${name} does not parse` };
          log(o.line); outcomes.push(o); continue;
        }
        if (!isCopy(op)) {
          moveWrite(path, WRITES_DEAD(), name);
          const o = { dead: true, name, line: `not copied (given up): ${name} is not a copy${op?.tool === "forget_thought" ? " — a forget: its text stays on this brain until forgotten there by hand" : ""}` };
          log(o.line); outcomes.push(o); continue;
        }
        // A send may reach the brain whatever it answers: the copy says so in its own file before it goes (`sending`),
        // and a forget's drop leaves it — dropped, a capture committed after the forget's NOT_FOUND kept its text for
        // good (review pass 7). One a drain killed mid-send left `sending` is read as having been sent (review pass 8).
        // A forget held for a brain with no write key (queueForget): its week starts at its first send, now that the
        // brain has one, not when it was made — else a key set back after a week gave it up at its first fault, its text
        // left there (SMD-4411 review pass 1).
        if (op.held === true) { const { held: _h, ...rest } = op; op = { ...rest, at: new Date().toISOString() }; if (!rewriteWrite(name, op)) continue; }
        const reachedBefore = op.sent === true || op.sending === true;
        if (!reachedBefore && !rewriteWrite(name, { ...op, sending: true })) continue; // gone: a drop took it first
        // Still this drain's, just before the send: a holder whose lock was taken back while it was suspended does not
        // send a copy its successor may have sent, and a forget after (review pass 9). Narrowed, not closed: the gap is
        // the microseconds to the request.
        if (!holdDrainLock()) { stopped = true; break; }
        // A throw on one copy (an answer of a shape the hook cannot read: the url not the brain's /mcp, or a server and
        // hook out of step) keeps it, as a fault does, rather than ending the drain: its send may have reached the brain,
        // and after a week it is given up like any other (SMD-4412).
        let o;
        try { o = await postWrite(cfg, op); }
        catch (e) { o = { keep: true, unknown: true, line: `kept: ${opLabel(op)} — the brain's answer could not be read (${oneLine(String(e?.message ?? e)).slice(0, 160)}): check that the url is this brain's /mcp, and that its server and this hook are current` }; }
        // A lock taken back while this copy was in flight: the queue is its new holder's, and this drain touches no
        // file of it — not this copy's, which the holder may be sending again (review pass 8: a stale holder's
        // write-back put a copy back after the forget that followed it).
        if (!holdDrainLock()) { log(`drain: the lock was taken back while ${opLabel(op)} was in flight; the queue is its new holder's`); stopped = true; break; }
        // Kept for a week: given up, as the capture queue gives a payload up
        // (PENDING_MAX_AGE_MS) — what it named is skipped there afterwards.
        if (o.keep && Date.now() - Date.parse(op.at) > PENDING_MAX_AGE_MS) o = { dead: true, line: `not copied (given up after a week): ${o.line.replace(/^kept: /, "")}${op.tool === "forget_thought" ? " — its text stays on this brain until forgotten there by hand" : ""}` };
        // A forget of a name a forget landed for earlier in this drain finds nothing: said so, not as a copy never sent
        // with its text kept (review pass 3: alarming after a success).
        if (o.notFound && op.tool === "forget_thought" && outcomes.some((x) => x.done && !x.notFound && x.forgetOf === op.args.id)) o = { ...o, line: `skipped ${opLabel(op)}: forgotten by the forget of it above, in this drain` };
        log(o.line);
        outcomes.push({ ...o, name, ...(op.tool === "forget_thought" ? { forgetOf: op.args.id } : {}) });
        // A forget landed: a copy of its thought given up since the forget's drop (sent again ahead of it, then refused
        // for good) holds its text in dead/ — removed now (SMD-4411 review pass 1).
        if (o.done && op.tool === "forget_thought") {
          const gone = dropCopiesOf([op.args.id, op.alt].filter(Boolean), [WRITES_DEAD()]);
          if (gone) log(`fan-out: removed ${gone} given-up cop${gone === 1 ? "y" : "ies"} of ${op.args.id}, which its forget followed`);
        }
        if (o.keep) {
          // `sent` once a send may have reached the brain — a transport failure past the connection, a fault, a
          // store it could not reach (`unknown`) — and never cleared; any other answer the brain gave (a refusal, a
          // code to retry) wrote nothing.
          // Written back even if a forget's drop removed it during the send — the drop read it before it was marked
          // (review pass 9): its name keeps it ahead of that forget, which then reaches it. Only this drain, holding the
          // lock, and a drop remove a queued copy.
          const { sending: _s, sent: _t, ...rest } = op;
          const sent = reachedBefore || o.unknown === true;
          rewriteWrite(name, { ...rest, ...(sent ? { sent: true } : {}) }, { force: sent });
          stopped = true; markHeld(name); break;
        }
        if (o.dead) moveWrite(path, WRITES_DEAD(), name); else removeWrite(path); // already gone: the holder before finished it too
      }
    } finally { releaseDrainLock(); }
    if (!pendingWrites().length) clearHeld();
    if (stopped || !pendingWrites().some((n) => !seen.has(n))) return outcomes;
  }
}

/**
 * What a brain's forget left for a person to review there — the thoughts derived from it, the pages, the standing twins
 * that keep the text — as ids, so the log names them; the first brain's reply names only its own (review pass 7).
 */
function forgetReview(sc) {
  const ids = (k) => (Array.isArray(sc?.[k]) ? sc[k].filter((x) => typeof x === "string") : []);
  const parts = [["derived from it", ids("irreproducibleIds")], ["pages", ids("pageIds")], ["standing twins keeping its text", ids("twinIds")]]
    .filter(([, list]) => list.length).map(([what, list]) => `${what}: ${list.slice(0, 5).join(", ")}${list.length > 5 ? ` and ${list.length - 5} more` : ""}`);
  return parts.length ? ` — to review there: ${parts.join("; ")}` : "";
}

/** A connection refused, or a name that resolves to nothing: the copy never reached the brain. */
const NOT_REACHED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
/**
 * The line for a copy a brain cannot call its tool for — a server from before it (forget_thought, migration 144), held
 * for it; else a key that cannot call it — or null. Only "Tool … not found" (or disabled): the SDK answers an input it
 * cannot validate with the same -32602, and that copy is refused for good (review pass 1).
 */
function toolMissing(op, text) {
  if (!/\bTool \S+ (?:not found|disabled)\b/.test(text)) return null;
  if (FANOUT_LATER.has(op.tool)) return `kept: ${opLabel(op)} — this brain's server has no ${op.tool} (one before v2.1.0), or the write key is no write key: upgrade the server past v2.1.0, or mint a write key, and the copy lands in order`;
  return `kept: ${opLabel(op)} — the write key cannot call ${op.tool}; mint a write key on this brain (bun server-portable/keygen.ts --name claude-code --scope write) and set write_key — --check says`;
}

/**
 * A queued copy's file rewritten whole — a temporary file renamed over it, so a kill or a full disk never leaves half a
 * copy (review pass 8) — or false when it is gone (a forget's drop took it), unless `force` puts it back.
 */
function rewriteWrite(name, op, { force = false } = {}) {
  const path = join(WRITES_PENDING(), name);
  if (!force && !existsSync(path)) return false;
  const tmp = join(WRITES_PENDING(), `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(op), { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

/** A copy's file moved aside, or removed: false when it is already gone (another drain's). */
function moveWrite(path, dir, name) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); renameSync(path, join(dir, name)); return true; } catch (e) { if (e?.code === "ENOENT") return false; throw e; } }
function removeWrite(path) { try { unlinkSync(path); return true; } catch (e) { if (e?.code === "ENOENT") return false; throw e; } }

/** The queue held on a copy: stamped, so session events try it again at most every HELD_RETRY_MS rather than at every turn (review pass 1). */
const HELD_PATH = () => join(WRITES_DIR(), "held");
const HELD_RETRY_MS = 5 * 60_000;
function markHeld(name) { try { writeFileSync(HELD_PATH(), name, { mode: 0o600 }); } catch { /* a stamp failure only means an earlier retry */ } }
function clearHeld() { try { unlinkSync(HELD_PATH()); } catch { /* none */ } }
const heldRecently = () => { try { return Date.now() - statSync(HELD_PATH()).mtimeMs < HELD_RETRY_MS; } catch { return false; } };

/** writes/dead/ pruned at thirty days and a temp file a writer left under writes/pending/, as pruneDead prunes the capture queue's. */
function pruneWrites() {
  // …and a lock a drain moved aside and was killed before removing (drain.lock.<pid>).
  for (const [dir, maxAge, only] of [[WRITES_DEAD(), DEAD_MAX_AGE_MS, null], [WRITES_PENDING(), CLAIM_MAX_AGE_MS, /\.tmp$/], [WRITES_DIR(), CLAIM_MAX_AGE_MS, /^drain\.lock\.(?:new\.)?\d+$/]]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (only && !only.test(f)) continue;
      try { if (Date.now() - statSync(join(dir, f)).mtimeMs > maxAge) unlinkSync(join(dir, f)); } catch { /* gone */ }
    }
  }
}

/** Drains a brain's queue: in this process under OB1_SESSION_CAPTURE_SYNC=1 (its outcomes said on stderr), else in a detached child. */
async function startDrain(brain, tag) {
  useStateRoot(brain.root);
  if (process.env.OB1_SESSION_CAPTURE_SYNC === "1") {
    const outcomes = await drainWrites(brain.cfg);
    for (const o of outcomes) console.error(`session-capture: ${tag}${o.line}`);
    return outcomes.some((o) => !o.done) ? 1 : 0;
  }
  ensureDirs();
  const fd = openSync(LOG_PATH(), "a", 0o600);
  const child = spawn(process.execPath, [SELF, "--drain-writes", "--brain", brain.name], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env } });
  child.unref();
  closeSync(fd);
  return 0;
}

/**
 * The hook on PostToolUse: queue the copy on each target, then drain each.
 * Exits 0 — a copy's fate is the log's, never the session's — save under
 * OB1_SESSION_CAPTURE_SYNC=1, where a copy not landed is exit 1, as a capture
 * not landed is there. A queue or drain that throws is logged, not thrown.
 */
async function fanOutHook(hook, brains) {
  const sync = process.env.OB1_SESSION_CAPTURE_SYNC === "1";
  try {
    const plan = fanOutPlan(hook, brains);
    if (!plan.op) {
      if (plan.skip) { useStateRoot(brains[0].root); log(`fan-out: ${plan.skip}`); }
      return 0;
    }
    // A forget goes through queueForget (SMD-4411): the copies of its thought no send may have reached are dropped
    // from every brain's queue, the first brain's own among them, and the forget is queued behind those kept, or held
    // for a brain with no write key now. dropCopiesOf's and queueForget's docblocks say why.
    let drains = plan.targets, lost = 0;
    if (plan.op.tool === "forget_thought") {
      const { queued, held, failed } = queueForget(plan.op, brains, { source: plan.source, targets: plan.targets, all: true });
      drains = queued.map((q) => q.brain);
      lost = failed.length; // a brain whose queue could not be written: a copy not landed, exit 1 under sync (review pass 3)
      // Said only when no other brain was queued, held or failed: the first brain's own forget is no copy (review pass 2).
      if (![...queued, ...held].some((x) => x.brain !== plan.source) && !failed.length) { useStateRoot(plan.source.root); log(`fan-out: forget_thought through ${plan.source.cfg.connector}: no other brain has a write_key, so nothing is copied`); }
    } else {
      for (const t of plan.targets) {
        useStateRoot(t.root);
        enqueueWrite(plan.op);
        log(`fan-out: queued ${opLabel(plan.op)} from ${plan.op.from}`);
      }
    }
    let code = lost ? 1 : 0;
    for (const t of drains) code = Math.max(code, await startDrain(t, `[${t.name}] `));
    return sync ? code : 0;
  } catch (e) {
    log(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)}`);
    if (sync) console.error(`session-capture: fan-out: ${e?.message ?? e}`);
    return sync ? 1 : 0;
  }
}

/**
 * --check's lines for the fan-out, per brain: the connector whose writes are
 * copied from it and where to; for a brain with a write key, that the key can
 * edit, delete and forget (a server with no forget_thought is a warning), that
 * the brain keeps a client_key (a server from before migration 112 drops the
 * argument unread, and every later edit of the copy would find nothing), and
 * what its queue holds; for one without, a warning of the copies its queue
 * still holds (SMD-4411). Returns the exit code.
 */
async function checkWrites(brain, brains, tag) {
  const cfg = brain.cfg;
  // Said only where something is copied: a connector set for work claims alone is no fan-out (SMD-3602 review pass 4).
  if (cfg.connector && brains.some((b) => b.cfg.writeKey)) {
    const to = brains.filter((b) => b !== brain && b.cfg.writeKey).map((b) => b.name);
    console.log(`${tag}fan-out: writes through ${cfg.connector} ${to.length ? `are copied to ${to.join(", ")}` : "stay on this brain (no other brain has a write_key)"}`);
  }
  if (!cfg.writeKey) {
    // Copies queued while it had a key, and forgets held for it since (SMD-4411): nothing sends them until one is set.
    useStateRoot(brain.root);
    const held = pendingWrites();
    if (held.length) {
      let forgets = 0;
      for (const f of held) { try { if (JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8"))?.tool === "forget_thought") forgets++; } catch { /* unreadable: the drain says so */ } }
      // A copy of a thought forgotten before 1.10.0 while this brain had no key was neither dropped nor held a forget
      // (review pass 1): it would land with its text, so the warning says how to forget it first.
      console.error(`session-capture: ${tag}warning: ${held.length} cop${held.length === 1 ? "y" : "ies"} queued for this brain${forgets ? `, ${forgets === 1 ? "1 of them a forget" : `${forgets} of them forgets`},` : ""} wait for a write_key; once one is set (write_key or write_key_file), they land, in order, at its next drain. Before setting it, run bun session-capture.mjs --copy-forget <id> --from <the brain you forgot it on> --brain ${brain.name} --yes for each thought you forgot while it had none on a hook before 1.10.0, which held no forget for it`);
    }
    return 0;
  }
  let tools;
  try { tools = (await rpc({ ...cfg, key: cfg.writeKey }, "tools/list", {}, 15_000)).tools ?? []; } catch (e) { console.error(`session-capture: ${tag}the write key: ${shownUrl(cfg.url)} did not answer tools/list — ${e.message}`); return 1; }
  const names = tools.map((t) => t.name);
  const missing = FANOUT_TOOLS.filter((t) => !names.includes(t) && !FANOUT_LATER.has(t));
  if (missing.length) { console.error(`session-capture: ${tag}the write key cannot call ${missing.join(", ")} — mint a write key on this brain: bun server-portable/keygen.ts --name claude-code --scope write`); return 1; }
  const later = FANOUT_TOOLS.filter((t) => !names.includes(t) && FANOUT_LATER.has(t));
  if (later.length) console.error(`session-capture: ${tag}warning: this brain's server has no ${later.join(", ")} (one before v2.1.0): a forget through the connector is held for it, the copies behind it waiting, for up to a week — upgrade it past v2.1.0`);
  const capture = tools.find((t) => t.name === "capture_thought");
  if (!capture?.inputSchema?.properties?.client_key) { console.error(`session-capture: ${tag}this brain's capture_thought takes no client_key — its server is from before migration 112 (SMD-3314): upgrade it before copying writes to it`); return 1; }
  useStateRoot(brain.root);
  const queued = pendingWrites();
  const dead = existsSync(WRITES_DEAD()) ? readdirSync(WRITES_DEAD()).filter((f) => f.endsWith(".json")).length : 0;
  // The oldest copy's age: a queue held on it for long is the one thing an operator needs to see (review pass 1).
  let oldest = "";
  if (queued.length) { try { const at = Date.parse(JSON.parse(readFileSync(join(WRITES_PENDING(), queued[0]), "utf8")).at); if (Number.isFinite(at)) oldest = `, the oldest ${Math.max(0, Math.round((Date.now() - at) / 60_000))} min old`; } catch { /* unreadable: the drain says so */ } }
  console.log(`${tag}write key: ok — it can capture, edit${later.length ? " and delete" : ", delete and forget"}, and the brain keeps a client_key. Copies queued: ${queued.length}${oldest}${dead ? `; given up: ${dead} (in ${WRITES_DEAD()})` : ""}`);
  return 0;
}

/** Marks the current brain's queued forgets `held`: drainWrites re-dates one at its first send. */
function holdForgets() {
  for (const f of pendingWrites()) {
    let op;
    try { op = JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8")); } catch { continue; }
    if (op?.tool === "forget_thought" && op.held !== true) rewriteWrite(f, { ...op, held: true });
  }
}

/** Any other hook run: a brain whose queue holds copies a drain left (it was away) gets a drain, so they land without waiting for the next write. */
async function kickWriteDrains(brains, { atEnd = false } = {}) {
  for (const b of brains) {
    useStateRoot(b.root);
    if (!b.cfg.writeKey) {
      // A forget queued while this brain had a key, which it no longer has: held, so its week starts again at its first
      // send once a key is set, as a forget held for it does (SMD-4411 review pass 2: given up at its first fault).
      try { holdForgets(); } catch (e) { log(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)}`); }
      continue;
    }
    // A queue held on a copy tried within HELD_RETRY_MS waits for the next
    // write or the next window (review pass 1) — save at a session's end, its
    // last chance before the next session (review pass 2). Never the session's
    // exit: a failure here is the log's.
    try { if (pendingWrites().length && (atEnd || !heldRecently())) await startDrain(b, `[${b.name}] `); }
    catch (e) { log(`fan-out: error: ${oneLine(String(e?.message ?? e)).slice(0, 200)}`); }
  }
}

// ── Hook JSON to paste ───────────────────────────────────────────────────────

/** A path as a shell word: quoted when it carries anything the shell would split or expand. */
export function shellWord(p) {
  return /^[A-Za-z0-9_./+:@%,=-]+$/.test(p) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/** The settings JSON for a harness: its default events (EVENTS, DEFAULT_EVENTS) or the one named. */
export function hookJson(harness, { event, minInterval = 20, runtime } = {}) {
  // The runtime that printed the hook, by its absolute path: a harness launched
  // from a GUI may carry a PATH without ~/.bun/bin, and a bare `bun` would fail
  // with "command not found" at every session end (twelfth review pass).
  const bin = runtime || process.execPath;
  // main() checks both names first; a caller of the export hears why, not a
  // TypeError off undefined or a hook under an event that never fires (first
  // and second review passes).
  if (!HARNESSES.includes(harness)) throw new Error(`hookJson: no default events for harness "${harness}" — one of ${HARNESSES.join(", ")}`);
  if (event !== undefined && !eventSpec(event)) throw new Error(`hookJson: "${event}" is not an event this hook runs on — one of ${HOOK_EVENTS.join(", ")}`);
  // Which harness fires which event is the table's to say, not a special case
  // in main() — the export printed Codex a PreCompact hook (third review pass).
  if (event !== undefined && !EVENTS[event].harnesses.includes(harness)) throw new Error(`hookJson: ${harness} has no ${event} hook — it fires ${EVENTS[event].harnesses.join(", ")}'s`);
  const events = event ? [event] : DEFAULT_EVENTS[harness];
  const handlerFor = (ev) => {
    const spec = EVENTS[ev];
    // The harness runs the command through a shell: a checkout under a path with a
    // space would otherwise split (first review pass).
    const cmd = [shellWord(bin), shellWord(SELF), ...(spec.interval ? ["--min-interval", String(minInterval)] : [])].join(" ");
    // Claude Code raises SessionEnd's shared 1.5 s budget to a hook's own timeout (≤ 60);
    // Codex allows at most 3 s there. The foreground finishes in well under one second either way.
    // PreCompact shares no budget — a command hook's 600 s default stands — but a
    // compaction WAITS on it, so it is pinned to the same 10 s: a read that hangs
    // must not hold a compaction for ten minutes (SMD-2012).
    // A Stop hook keeps the harness's default, 600 s in both (third review pass:
    // a pinned 30 undercut the README's advice for an enormous transcript).
    return spec.timeout ? { type: "command", command: cmd, timeout: HARNESS[harness].timeoutSec } : { type: "command", command: cmd };
  };
  return { hooks: Object.fromEntries(events.map((ev) => [ev, [{ hooks: [handlerFor(ev)] }]])) };
}

/**
 * The fan-out's settings JSON (SMD-3314): a PostToolUse hook on the write
 * tools of one connector's server, anchored — `^mcp__open-brain__` would match
 * nothing else, but the harness reads a matcher with any other character as an
 * unanchored regex — and async, so a copy never holds the session.
 */
export function fanOutHookJson({ connector = "open-brain", runtime } = {}) {
  if (!CONNECTOR_RE.test(connector)) throw new Error(`fanOutHookJson: "${connector}" is no MCP server's name`);
  const cmd = [shellWord(runtime || process.execPath), shellWord(SELF)].join(" ");
  return { hooks: { PostToolUse: [{ matcher: `^mcp__${connector}__(${FANOUT_TOOLS.join("|")})$`, hooks: [{ type: "command", command: cmd, async: true }] }] } };
}

/**
 * The claims hook's settings JSON (SMD-3602): `--claims` on every tool's
 * PostToolUse and PostToolUseFailure and on each prompt, async, so a renewal
 * never holds the session. PostToolUseFailure is where Claude Code hands the
 * agent's own refused claim calls (SMD-3874). The flag keeps it apart from the
 * fan-out's PostToolUse, which would otherwise copy a write twice, and from
 * the capture.
 */
export function claimsHookJson({ runtime } = {}) {
  const hook = { type: "command", command: [shellWord(runtime || process.execPath), shellWord(SELF), "--claims"].join(" "), async: true };
  return { hooks: { PostToolUse: [{ matcher: "*", hooks: [hook] }], PostToolUseFailure: [{ matcher: "*", hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }] } };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * The value after a flag — `--name value` or `--name=value` — "" when the flag
 * is last or the next token is itself a flag (thirteenth review pass:
 * `--print-hook --event Stop` read `--event` as the harness), undefined when
 * absent. The `=` form was unseen and so silently ignored: `--trigger=auto`
 * previewed no trigger, `--min-interval=45` printed 20 (third review pass).
 */
function flag(args, name) {
  // The LAST mention wins, in either form (fourth review pass: `=` won over a
  // later space form, so a corrected flag appended to the line was ignored).
  return flagAll(args, name).at(-1);
}
/** Whether a flag is present in either form. */
const has = (args, name) => flag(args, name) !== undefined;
/** Every value a flag was given, in order, in either form — `--post a --post b`, one per episode of a run (SMD-2013); `flag` is its last. */
function flagAll(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) { const v = args[i + 1] ?? ""; out.push(v.startsWith("--") ? "" : v); }
    else if (args[i].startsWith(`${name}=`)) { const v = args[i].slice(name.length + 1); out.push(v.startsWith("--") ? "" : v); } // `--event=--min-interval` is a value forgotten too (fifth review pass)
  }
  return out;
}

/**
 * `--event` as the CLI reads it, for --print-hook and --dry-run alike (second
 * review pass: spelled twice, and the copies disagreed on the empty value and
 * the case hint). { event } — undefined when absent — or { error } to print
 * and exit 2 with. A misspelt event would install a hook that never fires;
 * an empty one (`--event --min-interval 20`, the Stop forgotten) would print
 * the default pair as silently (first review pass).
 */
function eventFlag(args) {
  const event = flag(args, "--event");
  if (event === undefined) return { event };
  if (event === "") return { error: `--event takes one of ${HOOK_EVENTS.join(", ")}; none was given` };
  if (!eventSpec(event)) return { error: `--event takes ${HOOK_EVENTS.join(", ")}, not "${event}"${HOOK_EVENTS.some((e) => e.toLowerCase() === event.toLowerCase()) ? " — the case matters" : ""}` };
  return { event };
}

/**
 * `--min-interval` as every path reads it (third review pass: four readers and
 * two rules). { minInterval } — undefined when absent — or { error }. A printed
 * Stop hook needs a floor above zero (at zero it would capture every turn); the
 * hook path takes zero as no floor.
 */
function intervalFlag(args, { aboveZero }) {
  const raw = flag(args, "--min-interval");
  if (raw === undefined) return { minInterval: undefined };
  const n = Number(raw);
  if (!(raw.trim() !== "" && Number.isFinite(n) && n >= 0 && (!aboveZero || n > 0))) return { error: `--min-interval takes a number of minutes${aboveZero ? " above zero" : ""}${raw.trim() ? `, not "${raw}"` : "; none was given"}`, raw };
  return { minInterval: n, raw };
}

/** `--trigger`, --dry-run's: with --event PreCompact, one of the two a harness sends — a typo would preview the wrong line in silence (second review pass). */
function triggerFlag(args, event) {
  const trigger = flag(args, "--trigger");
  if (trigger === undefined) return { trigger };
  if (!eventSpec(event)?.trigger) return { error: `--trigger goes with --event ${TRIGGER_EVENTS.join(" or ")}${event ? `, not ${event}` : ", which was not given"}` };
  if (!TRIGGERS.includes(trigger)) return { error: `--trigger takes ${TRIGGERS.join(" or ")}${trigger ? `, not "${trigger}"` : "; none was given"}` };
  return { trigger };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether stdin is a pipe or a socket, as a harness hands a hook its JSON: not a terminal, not /dev/null (SMD-4378 review pass 2). */
function stdinIsPiped() {
  try { const st = fstatSync(0); return st.isFIFO() || st.isSocket(); } catch { return false; }
}

export async function main(argv) {
  const args = argv.slice(2);
  // First, whatever else is given and whether or not stdin is piped: an
  // operator confirming an upgrade needs no config, no brain and no
  // transcript (SMD-4378). A piped stdin may be a hook command's, which then
  // does nothing at every run: the log says so, as it does for a flag no hook
  // takes (review pass 1: it was silent). On a terminal or /dev/null, as an
  // interactive shell or Claude Code's Bash tool runs it, nothing is logged
  // and no state dir is made (review pass 2).
  if (has(args, "--version")) {
    if (stdinIsPiped()) log(`--version: printed session-capture ${HOOK_VERSION}; stdin unread, nothing captured, renewed or copied (if this is a hook command, it stops every run: remove --version)`);
    console.log(`session-capture ${HOOK_VERSION}`);
    return 0;
  }
  const harness = flag(args, "--harness");
  // Exit 1, not 2: on a Stop hook 2 would block the assistant's turn over a typo in the command line (seventh review pass).
  if (harness !== undefined && !HARNESSES.includes(harness)) { console.error(`--harness takes ${HARNESSES.join(" or ")}, not "${harness}" (omit it: the transcript's first line says which)`); return 1; }
  const { mode: onSecret, error: modeError } = secretMode(); // judged where it is read: --check, --dry-run, the hook (SMD-2127)
  if (has(args, "--print-hook")) {
    if (modeError) { console.error(modeError); return 2; } // a by-hand form, exit 2 as on a bad flag (first review pass: the one path that let a typo by)
    const h = flag(args, "--print-hook") || "claude-code";
    if (!HARNESSES.includes(h)) { console.error(`--print-hook takes ${HARNESSES.join(" or ")}, not "${h}"`); return 2; }
    // The claims hook (SMD-3602): Claude Code's async PostToolUse,
    // PostToolUseFailure (SMD-3874) and UserPromptSubmit, renewing the claims a
    // session's worktree holds tokens for.
    if (has(args, "--claims")) {
      if (h !== "claude-code") { console.error(`--claims is Claude Code's: ${HARNESS[h].label} has no async hook. Its agent renews with renew_claim itself, and its session hook renews at each event it fires`); return 2; }
      for (const f of ["--event", "--min-interval", "--trigger", "--fan-out", "--connector"]) if (has(args, f)) { console.error(`${f} is not --claims's; --claims prints the claims hook alone`); return 2; }
      console.error(`# Paste into ${HARNESS[h].settings} — this prints the hook, it installs nothing. It renews the claims whose tokens a session's worktree keeps in ${CLAIMS_DIRNAME}/, through the config's claim_key. A claims hook pasted before 1.7.3 has no PostToolUseFailure entry, so it never saw the agent's own refused claim calls (SMD-3874): add that entry, or replace all three if the printed command differs from yours.`);
      console.log(JSON.stringify(claimsHookJson(), null, 2));
      return 0;
    }
    // The write fan-out's hook (SMD-3314): Claude Code's async PostToolUse, for
    // the connector the config names on a brain (or --connector, or open-brain).
    if (has(args, "--fan-out")) {
      if (h !== "claude-code") { console.error(`--fan-out is Claude Code's: ${HARNESS[h].label} has no async PostToolUse hook`); return 2; }
      for (const f of ["--event", "--min-interval", "--trigger"]) if (has(args, f)) { console.error(`${f} is the session hook's; --fan-out prints the write fan-out's PostToolUse hook alone`); return 2; }
      let connector = flag(args, "--connector");
      if (connector === "") { console.error("--connector <the MCP server's name>"); return 2; }
      if (connector === undefined) { try { connector = loadBrains().find((b) => b.cfg.connector)?.cfg.connector; } catch { /* no config: the default */ } }
      connector ??= "open-brain";
      if (!CONNECTOR_RE.test(connector)) { console.error(`--connector takes an MCP server's name — letters, digits, hyphens and underscores — not "${connector}"`); return 2; }
      console.error(`# Paste into ${HARNESS[h].settings} — this prints the hook, it installs nothing. Copies go to the brains the config gives a write_key.`);
      console.log(JSON.stringify(fanOutHookJson({ connector }), null, 2));
      return 0;
    }
    if (has(args, "--connector")) { console.error("--connector goes with --fan-out"); return 2; }
    const { event, error } = eventFlag(args); // absent: the harness's default events
    if (error) { console.error(error); return 2; }
    // A flag of the other by-hand form would validate nowhere and vanish (second review pass).
    if (has(args, "--trigger")) { console.error("--trigger is --dry-run's, to preview a checkpoint; a hook reads the trigger the harness sends"); return 2; }
    if (event !== undefined && !EVENTS[event].harnesses.includes(h)) {
      const who = HARNESS[h].label;
      console.error(`${who} has no ${event === "PreCompact" ? "compaction" : event} hook: --print-hook ${h} prints ${DEFAULT_EVENTS[h].join(" and ")}; for a checkpoint on ${who} print --event ${INTERVAL_EVENTS.join(" or ")} --min-interval <minutes>`);
      return 2;
    }
    // A Stop hook printed with `--min-interval 20m` would run with NaN and capture every turn (eighth review pass).
    const { minInterval: mi, error: intervalError } = intervalFlag(args, { aboveZero: true });
    if (intervalError) { console.error(intervalError); return 2; }
    // The interval rides on a Stop hook's command line and nowhere else: given with the default pair it would validate and vanish (first review pass).
    if (mi !== undefined && !eventSpec(event)?.interval) { console.error(`--min-interval applies to --event ${INTERVAL_EVENTS.join(" or ")} alone; the other events capture every time`); return 2; }
    const where = HARNESS[h].settings;
    console.error(`# Paste into ${where} — this prints the hook, it installs nothing. Off until you do.`);
    console.log(JSON.stringify(hookJson(h, { event, minInterval: mi ?? 20 }), null, 2));
    return 0;
  }
  if (has(args, "--check")) {
    console.log(`session-capture ${HOOK_VERSION}`); // the copy being checked, before the mode and config checks (SMD-4378); a bad --harness is refused before it
    if (modeError) { console.error(`session-capture: ${modeError}`); return 1; } // before the config: a missing config must not hide the typo (first review pass)
    let brains;
    try { brains = loadBrains(); } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    // Each brain checked, and named when there are several (SMD-3313); the
    // run's exit is the worst brain's.
    let code = 0;
    for (const b of brains) {
      useStateRoot(b.root);
      const tag = brains.length > 1 ? `[${b.name}] ` : "";
      const c = await checkBrain(b.cfg, tag, onSecret);
      code = Math.max(code, c, await checkWrites(b, brains, tag), await checkClaims(b, tag));
    }
    // OB1_CLAIM_KEY is the one-brain shape's; beside a brains list it is read by no brain (review pass 1).
    if (process.env.OB1_CLAIM_KEY && (brains.some((b) => b.listed) || process.env.OB1_BRAIN_URL)) console.error(`warning: OB1_CLAIM_KEY is set but no brain uses it — it is read for the one-brain config file alone${process.env.OB1_BRAIN_URL ? " (OB1_BRAIN_URL's brain renews no claims)" : "; with a brains list give the brain its own claim_key"}`);
    return code;
  }
  if (has(args, "--renew-claims")) {
    // The claims a worktree keeps tokens for, renewed now: by hand (the
    // current directory's worktree, or --cwd's), or as the hook's child, told
    // by id which claims it stamped (SMD-3602).
    const given = flagAll(args, "--claim");
    // An empty --claim (`--claim --cwd X`, `--claim=`) is refused, not read as "every claim" (review pass 5).
    if (given.some((v) => !v)) { console.error("session-capture: --claim takes a claim id (a uuid); none was given"); return 2; }
    const ids = given.map((s) => s.toLowerCase());
    // A --claim that is no claim id is refused unechoed: a token given there by mistake is not printed or logged (review pass 4).
    if (ids.some((id) => !UUID_ONLY_RE.test(id))) { console.error("session-capture: --claim takes a claim id (a uuid) — the value given is not one, and is not shown"); return 2; }
    let brains;
    try { brains = loadBrains(); } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    const cwd = flag(args, "--cwd") || process.cwd();
    const dir = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd);
    const outcomes = await renewClaims(dir, brains, { now: true, ...(ids.length ? { only: ids } : {}) });
    // The hook's child writes to the log already; a run by hand prints, terminal or not (review pass 4: an agent's shell is no terminal).
    if (!has(args, "--from-hook")) {
      if (!outcomes.length) console.log(`no claims to renew: ${worktreeRoot(dir) ? `no token files in ${join(worktreeRoot(dir), CLAIMS_DIRNAME)}/` : "not inside a git worktree"}`);
      for (const o of outcomes) console.log(o.line);
    }
    // A renewal that revived a lapsed claim others claimed meanwhile is renewed and blocked: 1, as a blocked one is (review pass 1).
    return outcomes.some((o) => (!o.ok || o.blocked) && !o.ended) ? 1 : 0;
  }
  if (has(args, "--copy-forget")) {
    // A forget copied again, by hand (SMD-4411): one the hook never queued — its config unreadable at that run, or the
    // hook not run — which the first brain now refuses as FORGOTTEN, so a repeat through the connector copies nothing.
    // Queued as the hook queues one: the drop on every brain's queue with it, queued for each brain with a write key,
    // held for one without that has been copied to — or all of that on the one brain --brain names — then drained here.
    // A forget is not undone, and nothing here can tell a forgotten id from a wrong one (a brain answers whether a name
    // is forgotten only by forgetting it): so --from, the brain it was forgotten on, is required and is sent nothing
    // unless its queue carries a copy, and without --yes the command only says what it would do (review pass 2: a wrong
    // id pasted forgot a kept thought on every brain, exit 0).
    const usage = "--copy-forget <the thought's id, as the brain you forgot it on answered it> --from <that brain> [--client-key <the thought's own client_key>] [--brain <name>] [--yes]";
    const id = flag(args, "--copy-forget").toLowerCase();
    if (!UUID_ONLY_RE.test(id)) { console.error(`session-capture: ${usage}${id ? " — the id given is not a uuid" : ""}`); return 2; }
    const altRaw = flag(args, "--client-key");
    const alt = altRaw?.toLowerCase();
    if (alt !== undefined && !UUID_ONLY_RE.test(alt)) { console.error(`session-capture: --client-key takes the thought's own client_key (a uuid), as the forget's reply named it${alt ? `, not "${altRaw}"` : "; none was given"}`); return 2; }
    const brainName = flag(args, "--brain");
    if (brainName === "") { console.error("session-capture: --brain <name> (a brain the config names)"); return 2; }
    const fromName = flag(args, "--from");
    if (!fromName) { console.error(`session-capture: --from <the brain you forgot it on> is required: that brain is sent no forget unless its queue still carries a copy of the thought — ${usage}`); return 2; }
    if (brainName !== undefined && brainName === fromName) { console.error(`session-capture: --brain names the brain the thought was forgotten on (--from); name the brain to copy the forget to`); return 2; }
    let brains, targets, source;
    // A brain the forget can reach: one with a write key, or one without that has been copied to, where it is held.
    const reachable = (b) => Boolean(b.cfg.writeKey) || existsSync(join(b.root, "writes"));
    try {
      brains = loadBrains();
      const named = (n) => { const b = brains.find((x) => x.name === n); if (!b) throw new Error(`no brain named "${n}" in ${CONFIG_PATH} (its brains: ${brains.map((x) => x.name).join(", ")})`); return b; };
      source = named(fromName);
      if (brainName !== undefined) {
        const b = named(brainName);
        if (!reachable(b)) throw new Error(`brain "${brainName}" has no write_key and has never been copied to, so nothing goes to it — forget the thought there through its own connector`);
        targets = [b];
      } else {
        targets = brains;
        if (!brains.some((b) => b !== source && reachable(b))) throw new Error(`no brain in ${CONFIG_PATH} other than ${fromName} (--from) has a write_key or has been copied to, so there is nowhere to copy the forget — is --from the brain you forgot it on? Else forget the thought on each brain through its own connector`);
      }
    } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    const op = { tool: "forget_thought", args: { id, confirm: id, detach_citations: true }, ...(alt && alt !== id ? { alt } : {}), from: "--copy-forget", session: null, at: new Date().toISOString() };
    // Without --yes: what it would do, and nothing done.
    if (!has(args, "--yes")) {
      console.log(`would forget, for good, the thought named ${id}${op.alt ? `, then by its client_key ${op.alt}` : ""}:`);
      // A forget of the name already in a brain's queue (the hook's, kept while the brain was away) (review pass 3).
      const queuedHere = (b) => { useStateRoot(b.root); return pendingWrites().some((f) => { try { const o = JSON.parse(readFileSync(join(WRITES_PENDING(), f), "utf8")); return o?.tool === "forget_thought" && o.args?.id === id; } catch { return false; } }); };
      const drop = "its queued copies of it dropped";
      for (const b of brainName === undefined ? brains : targets) {
        const already = queuedHere(b) ? "; a forget of it is already queued here, which lands at the next drain" : "";
        if (b === source) { console.log(`  [${b.name}] where it was forgotten: ${drop}; ${b.cfg.writeKey ? "sent the forget" : "held the forget (no write_key now)"} only if a copy that may have landed is still queued there${already}`); continue; }
        console.log(`  [${b.name}] ${b.cfg.writeKey ? `${drop}, then the forget sent` : reachable(b) ? `${drop}, then the forget held: this brain has no write_key now` : "nothing: it has no write_key and has never been copied to"}${already}`);
      }
      if (brainName === undefined) console.log("  and the queues of brains no longer in the config, on this machine: their queued copies of it dropped");
      // What this machine's logs record of the name: a forget the hook made or lost, or nothing — the one check there is
      // against a wrong id, since a brain answers whether a name is forgotten only by forgetting it (review pass 3).
      const seen = [];
      for (const root of new Set([STATE_BASE, ...brains.map((b) => b.root)])) {
        let text = "";
        try { text = readFileSync(join(root, "log"), "utf8"); } catch { continue; }
        const line = text.split("\n").filter((l) => l.includes(`forget_thought of ${id}`)).at(-1);
        if (line) seen.push(`  ${line.slice(0, 220)}`);
      }
      console.log(seen.length ? `This machine's logs record a forget of ${id}, the latest of each:\n${seen.join("\n")}` : `No line in this machine's logs records a forget of ${id}: the hook never saw one — check the id before you go on.`);
      console.log(`A forget is not undone. Check that ${id} is the id ${fromName} answered in its own reply ("Forgot ${id}…")${op.alt ? `, and ${op.alt} the client_key that reply named` : ""}, then run this again with --yes.`);
      return 0;
    }
    // --brain names one brain: no other loses its copies or is held the forget (review pass 1).
    const { queued, held, failed } = queueForget(op, brains, { source, targets, all: brainName === undefined, sourceAlways: false });
    let code = failed.length ? 1 : 0;
    for (const b of failed) console.log(`[${b.name}] ${opLabel(op)} was not queued there: its queue could not be written (the log at ${join(b.root, "log")} says why)`);
    for (const h of held) { console.log(`[${h.brain.name}] held ${opLabel(op)}: this brain has no write_key now; once one is set, it lands, in order, at its next drain`); code = 1; }
    if (!queued.length && !held.length && !failed.length) { console.log(`nothing was queued or held: ${fromName}'s queue carries no copy of the thought, and no other brain was reached`); return 1; }
    for (const q of queued) {
      useStateRoot(q.brain.root);
      const outcomes = await drainWrites(q.brain.cfg);
      for (const o of outcomes) console.log(`[${q.brain.name}] ${o.line}`);
      if (outcomes.some((o) => !o.done)) code = 1;
      const mine = outcomes.find((o) => o.name === q.name);
      // A name that found nothing there: a wrong id, a thought that brain knows by its own id alone, or one forgotten
      // there already, whose copy keeps no key (review pass 1: exit 0 read as success while the text stayed). Not said
      // when a forget of the same name landed in this drain, ahead of it — the hook's, held for the brain (review pass 2).
      const landedBefore = outcomes.some((o) => o !== mine && o.done && !o.notFound && o.forgetOf === id);
      if (mine?.notFound && !landedBefore) {
        // The step that leaves no text first; "forgotten already" last, where a reader stopping early does no harm (review pass 3).
        console.log(`[${q.brain.name}] nothing was forgotten on ${q.brain.name}: no thought there has ${op.alt ? `${id} or ${op.alt}` : id} as its id or client_key.${op.alt ? "" : ` If the forget's reply named a client_key ("its client_key <uuid>"), run this again with --client-key <that uuid>: a thought that began on ${q.brain.name} is known there by it alone.`} Or, by its own id there: --copy-forget <its id on ${q.brain.name}> --from ${fromName} --brain ${q.brain.name}. Check the id. Only if it was forgotten there already (a forgotten copy keeps no key, so a repeat finds nothing) is nothing left to do`);
        code = 1;
      }
      // Still queued: left to a drain already running, or kept, or behind a copy kept.
      if (pendingWrites().includes(q.name)) {
        console.log(outcomes.length
          ? `[${q.brain.name}] ${opLabel(op)} stays queued: it lands, in order, at this brain's next drain (--drain-writes --brain ${q.brain.name})`
          : `[${q.brain.name}] ${opLabel(op)} is queued behind a drain already running, which sends it in order: its outcome is in ${LOG_PATH()}`);
        code = 1;
      }
    }
    return code;
  }
  if (has(args, "--drain-writes")) {
    // A brain's queue of copied writes, by hand or as the hook's child (SMD-3314).
    const brainName = flag(args, "--brain");
    if (!brainName) { console.error("--drain-writes --brain <name> (a brain the config gives a write_key)"); return 2; }
    let b;
    try {
      const brains = loadBrains();
      b = brains.find((x) => x.name === brainName);
      if (!b) throw new Error(`no brain named "${brainName}" in ${CONFIG_PATH} (its brains: ${brains.map((x) => x.name).join(", ")})`);
      if (!b.cfg.writeKey) throw new Error(`brain "${brainName}" has no write_key, so nothing is copied to it`);
    } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    useStateRoot(b.root);
    const outcomes = await drainWrites(b.cfg);
    if (process.stdout.isTTY) for (const o of outcomes) console.log(o.line);
    return outcomes.some((o) => !o.done) ? 1 : 0;
  }
  if (has(args, "--dry-run")) {
    const path = flag(args, "--dry-run");
    if (!path) { console.error("--dry-run <transcript.jsonl>"); return 2; }
    // `--event PreCompact [--trigger auto|manual]` or `--event Stop` previews the
    // checkpoint line the hook would write for that event (first review pass:
    // --print-hook refused an unknown event while --dry-run took one in silence,
    // and nothing by hand could show the line). The flags are read BEFORE the
    // transcript: a transcript with no prompt returned 0 past every refusal
    // (third review pass).
    const { event: ev, error } = eventFlag(args);
    if (error) { console.error(error); return 2; }
    const { trigger, error: triggerError } = triggerFlag(args, ev);
    if (triggerError) { console.error(triggerError); return 2; }
    if (has(args, "--min-interval")) { console.error("--min-interval is --print-hook's, for a Stop hook; a dry run has no interval"); return 2; }
    if (modeError) { console.error(modeError); return 2; }
    console.log(`--- session-capture ${HOOK_VERSION}: what it would send; nothing is sent\n`); // which hook's rules the texts below follow (SMD-4378)
    // With the model summary on, say so and that a dry run does NOT call it: the
    // texts below are the DERIVED summaries — what the model is given, and what
    // is sent if the call is refused, slow or unconfigured (SMD-2014). Tolerant
    // of a missing brain config: a dry run is offline.
    try { const c = loadConfig(); if (c.summary === "model") console.log(`--- ${modelStatusLine(c)}; a dry run shows the DERIVED text below (the model is not called here)\n`); } catch { /* no config: nothing to say about the model */ }
    const s = summariseTranscript(path, harness);
    if (!s.episodes.length) {
      const sniffed = sniffHarness(readFileSync(path, "utf8").split("\n", 5));
      console.log(`--- would SKIP: no human prompt in ${path} (a compaction, or a transcript with only tool traffic${harness && harness !== sniffed ? `; note: --harness ${harness} was given but the first line says ${sniffed}` : ""})`);
      return 0;
    }
    const several = s.episodes.length > 1;
    if (ev) s.episodes[s.episodes.length - 1].checkpoint = checkpointOf({ hook_event_name: ev, trigger });
    // The segmentation first (SMD-2013): where the boundaries fell and why, one
    // line per episode, so an operator sees the pieces before the texts.
    if (several) {
      console.log(`--- ${s.episodes.length} episodes — one thought each, on its own supersedes chain:`);
      for (const ep of s.episodes) {
        const tickets = ep.named.size ? [...ep.named].join(", ") : anchorOf(ep.cwd, ep.branch)[0] ?? "no ticket";
        console.log(`    ${ep.n}. ${[tickets, ep.branch ? `(${ep.branch})` : "", `${distinctPrompts(ep.prompts).length} prompt(s)`, ep.first ? `${when(ep.first)} → ${when(ep.last)}` : "undated", ep.opened ? `begun ${boundaryBegan(ep.opened)}` : "from the start", ep.closed ? `ended ${boundaryEnded(ep.closed)}` : "still open"].filter(Boolean).join(" — ")}`);
      }
    }
    let code = 0;
    for (const ep of s.episodes) {
      const cleaned = cleanEpisode(ep, onSecret);
      const { text, redactions } = cleaned;
      const where = gateFindings(cleaned, text);
      const ids = provenanceOf(ep);
      if (several) console.log(`\n=== episode ${ep.n} ===`);
      console.log(text);
      const from = headerTickets(cleaned.ep).from;
      console.log(`\n--- would send${several ? ` (episode ${ep.n})` : ""}: source=${s.harness}, derived_from=${ids.length} id(s)${ids.length ? ` [${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}]` : ""}${from ? `, metadata.tickets_from=${from}` : ""}, metadata.hook_version=${HOOK_VERSION}`);
      if (where.length) { console.log(`--- would REFUSE${several ? ` episode ${ep.n}` : ""}: ${where.join(", ")}${redactions.length ? ` after ${countRedactions(redactions.length)}` : ""}`); code = 1; }
      else if (redactions.length) console.log(`--- secret scan: ${countRedactions(redactions.length)} — ${describeRedactions(redactions)}; the text above is what would be sent`);
      else console.log("--- secret scan: clean");
    }
    return code;
  }
  if (has(args, "--post")) {
    const files = flagAll(args, "--post").filter(Boolean); // none: drain pending/ alone
    // `--brain <name>`: the brain whose queue this drains, as the hook's child
    // is told (SMD-3313); none, the first.
    const brainName = flag(args, "--brain");
    if (brainName === "") { console.error("--brain <name> (a brain the config names)"); return 2; }
    let cfg;
    try {
      const brains = loadBrains();
      const b = brainName === undefined ? brains[0] : brains.find((x) => x.name === brainName);
      if (!b) throw new Error(`no brain named "${brainName}" in ${CONFIG_PATH} (its brains: ${brains.map((x) => x.name).join(", ")})`);
      useStateRoot(b.root);
      cfg = b.cfg;
    } catch (e) { log(`error: ${e.message}`); console.error(`session-capture: ${e.message}`); return 2; }
    const outcomes = await postPending(cfg, files.length ? files : undefined);
    // Each outcome is already a timestamped line in the log, where this
    // process's stdout also lands when the hook spawned it; say it again only
    // to a terminal (first review pass: every line twice in the log).
    if (process.stdout.isTTY) for (const o of outcomes) console.log(o.ok ? `captured ${o.id}${o.note ? ` (${o.note})` : ""}` : o.deferred ? o.error : `not captured: ${o.error}${o.dead ? " (given up)" : " (kept for retry)"}`);
    return outcomes.some((o) => !o.ok && !o.obsolete && !o.deferred) ? 1 : 0;
  }

  // The hook itself: JSON on stdin. A terminal is not a hook — say so instead
  // of waiting on it for ever (ninth review pass).
  if (process.stdin.isTTY) { console.error("session-capture: expected the hook's JSON on stdin (a harness pipes it). By hand: --version, --print-hook [claude-code|codex], --check, --dry-run <transcript>, --post <payload> [--post <payload>…], --copy-forget <id>."); return 2; }
  let hook;
  try { hook = JSON.parse(await readStdin()); } catch (e) { console.error(`session-capture: stdin is not the hook's JSON (${e.message})`); return 1; }
  // A hook takes two flags. Any other — `--event` or `--trigger`, which are
  // the by-hand forms' and whose values the harness sends on stdin, or a
  // misspelt `--min-intervall` that would capture every turn — would change
  // nothing and say nothing (fourth and fifth review passes). Exit 1, never 2:
  // a Stop hook's 2 blocks the turn.
  const HOOK_FLAGS = ["--harness", "--min-interval", "--claims"];
  for (const a of args) {
    if (!a.startsWith("--") || HOOK_FLAGS.includes(a.split("=")[0])) continue;
    const name = a.split("=")[0];
    log(`error: ${name} is not a hook flag`);
    console.error(`session-capture: ${name} is not a hook flag — a hook takes ${HOOK_FLAGS.join(" and ")}; the event and the trigger come from the harness on stdin — remove it from the command; nothing captured`);
    return 1;
  }
  const { minInterval: hookInterval, error: intervalError, raw: intervalRaw } = intervalFlag(args, { aboveZero: false });
  if (intervalError) { log(`error: --min-interval "${intervalRaw}" is not a number of minutes`); console.error(`session-capture: ${intervalError}; nothing captured`); return 1; }
  const event = String(hook.hook_event_name ?? "");
  // The claims hook renews and captures nothing, so the capture's secret mode
  // is not its to judge: a typo there must not stop renewals (review pass 2).
  const claimsOnly = has(args, "--claims") && !eventSpec(event);
  // Exit 1, as the flags above: a typo in the environment blocks nothing and captures nothing (SMD-2127).
  if (modeError && !claimsOnly) { log(`error: ${modeError}`); console.error(`session-capture: ${modeError}; nothing captured`); return 1; }
  const minIntervalMin = hookInterval ?? 0;
  // The config is checked FIRST, before a payload exists: a hook pasted before
  // the config is written would otherwise queue one payload per session end
  // for as long as the config is missing, and post them all, stale, when it
  // appears (fifth review pass).
  let brains;
  try { brains = loadBrains(); } catch (e) {
    log(`error: ${e.message}`); console.error(`session-capture: ${e.message}`);
    // A forget this run would have copied is lost with it: named, with the command that copies it once the config
    // loads (SMD-4411 review pass 1: the log said the errno alone).
    const lost = lostForget(hook);
    if (lost) { log(`fan-out: ${lost}`); console.error(`session-capture: ${lost}`); }
    return 1;
  }
  const sync = process.env.OB1_SESSION_CAPTURE_SYNC === "1";
  // The claims hook (SMD-3602): renew what is due, nothing captured or copied.
  // Exit 0 once the config loads: a renewal's fate is the log's. On an event
  // the hook captures on, a command given --claims by hand still captures, the
  // renewal after it (review pass 1: it silently captured nothing).
  if (claimsOnly) {
    try { noteAgentClaimCall(hook, brains); } catch (e) { useStateRoot(brains[0].root); log(`claims: error: ${scrubTokens(oneLine(String(e?.message ?? e))).slice(0, 200)}`); }
    try { await renewClaims(hook.cwd, brains, { detach: !sync }); } catch (e) { useStateRoot(brains[0].root); log(`claims: error: ${scrubTokens(oneLine(String(e?.message ?? e))).slice(0, 200)}`); }
    return 0;
  }
  // A write tool's result (SMD-3314): copied to the other brains, nothing captured.
  if (event === "PostToolUse") return fanOutHook(hook, brains);
  // Each brain prepares from its own state and posts in a child of its own
  // (SMD-3313): its chains supersede its own ids, its queue waits for it alone,
  // and one away delays no other. One brain says what it always said; several
  // name theirs on every line. The exit is the worst brain's.
  const several = brains.length > 1;
  let code = 0;
  for (const b of brains) {
    useStateRoot(b.root);
    code = Math.max(code, await hookForBrain(hook, b, several, { minIntervalMin, harness, onSecret }));
  }
  // Copies a drain left behind (their brain away) get another drain at every session event.
  await kickWriteDrains(brains, { atEnd: event === "SessionEnd" });
  // The session's claims (SMD-3602): renewed at a compaction and at its end —
  // never released there, as its PR may still be open — and, on a Stop hook's
  // turn, when due. Not on an event this hook does not capture on.
  if (!event || eventSpec(event)) {
    try { await renewClaims(hook.cwd, brains, { force: !eventSpec(event)?.interval, detach: !sync }); } catch (e) { useStateRoot(brains[0].root); log(`claims: error: ${scrubTokens(oneLine(String(e?.message ?? e))).slice(0, 200)}`); }
  }
  return code;
}

/** The hook's run for one brain, its state root set: prepare, then post in sync or in a detached child. Returns the exit code. */
async function hookForBrain(hook, brain, several, { minIntervalMin, harness, onSecret }) {
  const tag = several ? `[${brain.name}] ` : "";
  const cfg = brain.cfg;
  let prepared;
  try { prepared = prepare(hook, { minIntervalMin, harness, onSecret, summary: cfg.summary }); } catch (e) { log(`error: ${e.message}`); console.error(`session-capture: ${tag}${e.message}`); return 1; }
  // A refused episode exits 1 once the others are on their way (SMD-2013): the
  // secret's episode is not sent, the rest of the session still is.
  const paths = prepared.payloadPaths ?? [];
  if (!paths.length) { log(prepared.message); console.error(`session-capture: ${tag}${prepared.message}`); return prepared.code; }
  if (prepared.code) { log(prepared.message); console.error(`session-capture: ${tag}${prepared.message}`); } // the refusal first, then what posts
  if (process.env.OB1_SESSION_CAPTURE_SYNC === "1") {
    // The run's own outcomes, by file — oldest-first posting puts stranded
    // payloads before them (third review pass: `[o]` read the first outcome).
    const outcomes = await postPending(cfg, paths);
    const own = paths.map((p) => outcomes.find((x) => x.file === p));
    if (own.every((o) => !o)) { console.error(`session-capture: ${tag}another run took ${paths.length === 1 ? "this payload" : "these payloads"} (to post them, or as obsolete beside a newer one)`); return prepared.code; } // two runs at once (fourth review pass)
    for (const o of own) if (o) console.error(`session-capture: ${tag}${o.ok ? `captured ${o.id}` : o.obsolete ? `skip: ${o.error}` : o.deferred ? o.error : `not captured: ${o.error}`}`);
    return prepared.code || (own.every((o) => !o || o.ok || o.obsolete || o.deferred) ? 0 : 1);
  }
  const pid = detachPost(paths, several ? brain.name : undefined);
  log(`${prepared.code ? `posting the rest` : prepared.message} → posting in pid ${pid}`);
  return prepared.code;
}

// Run as the entry point — argv[1] resolved through any symlink (sixth review
// pass: a hook installed through ~/bin compared the link with the real path,
// never ran, and exited 0 saying nothing).
const invokedAs = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : ""; } catch { return process.argv[1] ?? ""; } })();
if ((invokedAs && SELF === invokedAs) || (typeof Bun !== "undefined" && Bun.main === SELF)) {
  main(process.argv).then((code) => process.exit(code), (e) => { console.error(`session-capture: ${e?.message ?? e}`); process.exit(1); });
}
