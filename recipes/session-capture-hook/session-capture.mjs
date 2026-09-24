#!/usr/bin/env bun
/**
 * session-capture.mjs — a session hook for Claude Code and Codex that captures
 * ONE summary thought into Open Brain at each of a session's checkpoints — a
 * compaction (Claude Code's PreCompact) and the session's end — with the
 * thoughts the session retrieved as its provenance (SMD-1298, SMD-2012).
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
 * registers `capture_thought` for and nothing else.
 *
 * Before anything leaves the machine the summary is scanned for secrets — the
 * common key prefixes, credential assignments, a URL carrying a password, and
 * high-entropy tokens. A hit refuses the whole capture: the reason is printed
 * (never the match), the exit code is 1, and the session ends as it would have.
 * Exit 2 is the one code a Stop hook may block with; as a hook this script
 * never uses it (the by-hand forms — --print-hook, --dry-run — exit 2 on misuse).
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
 *   bun session-capture.mjs --print-hook claude-code     # the settings.json to paste (SessionEnd + PreCompact); installs nothing
 *   bun session-capture.mjs --print-hook codex           # the hooks.json to paste (SessionEnd: Codex has no compaction hook)
 *   bun session-capture.mjs --print-hook claude-code --event Stop --min-interval 20   # the coarser checkpoint: a turn, at most every 20 min
 *   bun session-capture.mjs --check                      # config + endpoint + key scope; writes nothing
 *   bun session-capture.mjs --dry-run <transcript.jsonl> # print what WOULD be sent; sends nothing (--event PreCompact --trigger auto previews a checkpoint's)
 *   bun session-capture.mjs                              # as the hook: hook JSON on stdin
 *
 * Bun or Node 18+, no dependencies. Config (0600, never in a hook command line):
 *   ${XDG_CONFIG_HOME:-~/.config}/open-brain/session-capture.json
 *   { "url": "http://127.0.0.1:8010/", "key": "<the raw capture key>" }
 * State and log: ${XDG_STATE_HOME:-~/.local/state}/open-brain/session-capture/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, rmdirSync, openSync, closeSync, appendFileSync, statSync, realpathSync, utimesSync } from "node:fs";
import { join, basename, relative, isAbsolute, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Configuration ────────────────────────────────────────────────────────────

const SELF = fileURLToPath(import.meta.url);
const HOME = homedir();
export const CONFIG_PATH = process.env.OB1_SESSION_CAPTURE_CONFIG
  || join(process.env.XDG_CONFIG_HOME || join(HOME, ".config"), "open-brain", "session-capture.json");
export const STATE_DIR = process.env.OB1_SESSION_CAPTURE_STATE
  || join(process.env.XDG_STATE_HOME || join(HOME, ".local", "state"), "open-brain", "session-capture");
const LOG_PATH = () => join(STATE_DIR, "log");
const PENDING_DIR = () => join(STATE_DIR, "pending");
const DEAD_DIR = () => join(STATE_DIR, "dead");
/** Payloads a running child has claimed, one directory per pid: a rename into it is the claim, and exactly one child's rename succeeds. */
const INFLIGHT_DIR = () => join(STATE_DIR, "inflight");

/** Caps on what the summary carries. The text is one thought; the server chunks long ones, but a summary is meant to be read whole. */
export const LIMITS = {
  prompts: 12,          // human prompts listed
  promptChars: 200,     // per prompt
  outcomeChars: 1500,   // the assistant's last message
  sessionIdChars: 120,  // the id in the closing line — a uuid is 36; bounded so the closing lines never outgrow the cap (fifth review pass)
  files: 20,            // file paths named
  textChars: 6000,      // the whole summary
  derived: 60,          // provenance ids sent (the server validates each; a long list is a long validation)
};

/** The brain's tool names — only THEIR results are read for thought ids, so a uuid printed by some other tool is never claimed as provenance. */
const BRAIN_TOOLS = ["search_thoughts", "search_thoughts_keyword", "list_thoughts", "list_supersession_proposals", "thought_stats", "capture_thought", "update_thought"];
/** The two names every connector has (the MCP connector spec's pair): the brain's only under a server whose name says `brain` (eighth review pass — a Notion or Linear `search` prints uuid-shaped ids too). */
const GENERIC_TOOLS = ["search", "fetch"];
// The tool's own name after an MCP-style separator (`mcp__open-brain__search_thoughts`, `server/search`, `server.search`), or bare.
// `_` is NOT a separator on purpose: `web_search` must not read as the brain's `search`.
// `brain` as a word of the server's name (open-brain, my_brain, brain), not a
// substring: a `brainstorm` server's search is not the brain's (ninth review pass).
const BRAIN_TOOL_RE = new RegExp(`(?:(?:^|__|[/.:])(?:${BRAIN_TOOLS.join("|")})|^(?:[^]*[^a-z0-9])?brain(?:[^a-z0-9][^]*)?(?:__|[/.:])(?:${GENERIC_TOOLS.join("|")}))$`, "i");
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// `ID: <uuid>` is how every read tool prints a thought's id (SMD-1248); a capture answers `Captured as … — id <uuid>` or `Thought saved (id <uuid>)`.
const RETRIEVED_ID_RE = new RegExp(`\\bID:\\s*(${UUID})\\b`, "gi");
const CAPTURED_ID_RE = new RegExp(`(?:Captured as [^\\n]*?\\bid |Thought saved \\(id )(${UUID})\\b`, "gi");
/** Tool names whose input names a file the session changed (Claude Code). */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ── Small helpers ────────────────────────────────────────────────────────────

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

/**
 * Harness-injected blocks a prompt may carry that are not what the human typed:
 * Claude Code's system reminders, slash-command wrappers and pasted-content
 * frames; Codex's environment context and instruction frames. Removed before a
 * prompt is judged non-empty, so a turn that was only a reminder is not "asked".
 */
const INJECTED_TAGS = ["system-reminder", "system_reminder", "command-name", "command-message", "command-args", "local-command-stdout", "local-command-caveat",
  "pasted_content", "environment_context", "user_instructions", "permissions", "turn_aborted", "ide_selection", "task-notification", "agent-message", "AGENTS\\.md"];
const INJECTED_RE = new RegExp(`<(${INJECTED_TAGS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>|<(${INJECTED_TAGS.join("|")})(?:\\s[^>]*)?\\/?>`, "gi");
export function stripInjected(text) {
  return String(text ?? "").replace(INJECTED_RE, " ").replace(/[ \t]+\n/g, "\n").trim();
}

function ensureDirs() {
  for (const d of [STATE_DIR, PENDING_DIR(), DEAD_DIR(), INFLIGHT_DIR()]) mkdirSync(d, { recursive: true, mode: 0o700 });
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
/**
 * How long a claim may go without progress before it is judged abandoned:
 * longer than one payload takes — postCapture's six requests at most (one
 * and five refusal retries) at POST_TIMEOUT_MS, 540 s, and a wait as long
 * again (SMD-2035), 630 s against these 900 — and the claim directory's mtime
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
    for (const f of readdirSync(dir)) { try { renameSync(join(dir, f), join(PENDING_DIR(), f)); } catch { /* a sibling swept it */ } }
    try { rmdirSync(dir); } catch { /* not empty after all, or gone */ }
  }
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
}
/**
 * When the session's summary was last ATTEMPTED: the state's recorded time,
 * or a payload of the session still pending or in flight (its name begins with
 * the millisecond it was prepared). The Stop interval gates on this, not on the
 * last LANDED capture — with the endpoint away nothing lands, and a gate on
 * landings let every turn queue a payload and spawn a child (eighth review pass).
 */
/**
 * The session's payloads still pending or in flight: a name is
 * `<ms>-<seq>-<rand>-<session>.json`, so the session is everything after the
 * third hyphen, compared whole — a suffix match let session `abc` claim
 * `run-abc`'s payloads (eleventh review pass). `pid` is the child whose claim
 * holds it, null under pending/ (SMD-2035); a poll that only asks what other
 * children hold leaves pending/ unread.
 */
function sessionPayloads(sessionId, { pending = true } = {}) {
  const tail = basename(statePath(sessionId));
  const out = [];
  const dirs = pending ? [{ dir: PENDING_DIR(), pid: null }] : [];
  try { for (const pid of readdirSync(INFLIGHT_DIR())) dirs.push({ dir: join(INFLIGHT_DIR(), pid), pid: Number(pid) }); } catch { /* no inflight dir yet */ }
  for (const { dir, pid } of dirs) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      const parts = f.split("-");
      if (parts.slice(3).join("-") === tail) out.push({ path: join(dir, f), name: f, ms: Number(parts[0]), pid });
    }
  }
  return out;
}
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
  try { return JSON.parse(readFileSync(statePath(sessionId), "utf8")); } catch { return null; }
}
/** Every file in the state directory: pretty JSON, a trailing newline, owner-only. One home for the mode (seventh review pass: it was spelled four times). */
const writeJson = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
function writeState(sessionId, state) {
  ensureDirs();
  writeJson(statePath(sessionId), state);
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * The endpoint and the key. From the config file (the shipped shape), or from
 * OB1_BRAIN_URL / OB1_CAPTURE_KEY in the environment (a test, a container). The
 * key never appears in a hook's command line, where it would sit in a settings
 * file every tool on the machine can read.
 */
export function loadConfig() {
  let cfg = {};
  if (existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch (e) { throw new Error(`${CONFIG_PATH} is not JSON: ${e.message}`); }
    try {
      const mode = statSync(CONFIG_PATH).mode & 0o077;
      if (mode !== 0 && process.platform !== "win32") console.error(`session-capture: ${CONFIG_PATH} is readable by others — chmod 600 it`);
    } catch { /* unreadable stat: the read above already succeeded */ }
  }
  const url = process.env.OB1_BRAIN_URL || cfg.url;
  let key = process.env.OB1_CAPTURE_KEY || cfg.key;
  if (!key && cfg.key_file) key = readFileSync(cfg.key_file, "utf8").trim();
  if (!url || !key) {
    throw new Error(`no endpoint or key — write ${CONFIG_PATH} as {"url": "http://127.0.0.1:8010/", "key": "<capture key>"} (mint the key with: bun server-portable/keygen.ts --name session-hook --scope capture)`);
  }
  return { url: String(url).replace(/\/*$/, "/"), key: String(key) };
}

// ── Transcript parsing ───────────────────────────────────────────────────────

/** Which harness wrote a transcript: Codex rollouts open with a session_meta line; Claude Code's lines carry sessionId. */
export function sniffHarness(firstLines) {
  for (const l of firstLines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o?.type === "session_meta" && o.payload) return "codex";
    if (typeof o?.sessionId === "string" || o?.type === "user" || o?.type === "assistant") return "claude-code";
  }
  return "claude-code";
}

function textOfBlocks(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content) && typeof content.text === "string") return content.text; // one block, not a list
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : (b?.type === "text" || b?.type === "input_text" || b?.type === "output_text") ? String(b.text ?? "") : "")).filter(Boolean).join("\n");
}

/** An empty summary, filled by either parser. */
function emptySummary() {
  // `cwd` and `branch` are where the session ENDED; `roots` every directory it
  // ran in (a session that moves between worktrees has several), so a file under
  // any of them is inside the project.
  // `checkpoint` is set by prepare() from the hook event (checkpointOf); a
  // transcript read for --dry-run or a test has none, and renders no such line.
  return { harness: "", sessionId: "", title: "", cwd: "", branch: "", roots: new Set(), prompts: [], outcome: "", files: new Set(), commits: 0, prs: [], retrieved: new Set(), captured: new Set(), first: "", last: "", pushed: false, checkpoint: undefined };
}

/**
 * A user line that is not a human ask: the summary Claude Code writes in the
 * human's voice when it compacts a long session, and a bare slash command.
 */
// A BARE slash command (`/compact`) is the harness's, not an ask; one with
// arguments (`/code-review high`, `/implement the hook`) is what the human asked
// (twelfth review pass: the rule matched the leading word and dropped the rest).
const NOT_ASKED_RE = /^This session is being continued from a previous conversation|^\/[a-z][\w-]*\s*$/i;

/** Claude Code's ~/.claude/projects/<slug>/<session>.jsonl — one JSON object per line; the shape is internal and changes, so every read here is tolerant. */
export function parseClaudeCode(lines, s) {
  const toolNames = new Map(); // tool_use id → name
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    if (o.isSidechain === true) continue; // a subagent's turns are not this session's asks
    if (!s.sessionId && typeof o.sessionId === "string") s.sessionId = o.sessionId;
    if (o.type === "ai-title" && typeof o.aiTitle === "string") { s.title = o.aiTitle; continue; }
    if (o.type === "pr-link" && typeof o.prUrl === "string") { if (!s.prs.includes(o.prUrl)) s.prs.push(o.prUrl); continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (typeof o.timestamp === "string") { if (!s.first) s.first = o.timestamp; s.last = o.timestamp; }
    if (typeof o.cwd === "string" && o.cwd) { s.cwd = o.cwd; s.roots.add(o.cwd); }
    if (typeof o.gitBranch === "string" && o.gitBranch) s.branch = o.gitBranch;
    const content = o.message?.content;
    if (o.type === "assistant") {
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use") {
          toolNames.set(b.id, String(b.name ?? ""));
          const input = b.input ?? {};
          if (EDIT_TOOLS.has(b.name) && typeof (input.file_path ?? input.notebook_path) === "string") s.files.add(input.file_path ?? input.notebook_path);
          if (b.name === "Bash" && typeof input.command === "string") {
            if (/\bgit\s+commit\b/.test(input.command)) s.commits++;
            if (/\bgit\s+push\b/.test(input.command)) s.pushed = true;
          }
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          s.outcome = b.text; // the last text block of the last assistant line wins
        }
      }
      continue;
    }
    // A user line: a human prompt, or the tool results the harness feeds back.
    if (o.isMeta === true) continue;
    const blocks = Array.isArray(content) ? content : [];
    const results = blocks.filter((b) => b?.type === "tool_result");
    for (const r of results) {
      const name = toolNames.get(r.tool_use_id) ?? "";
      if (!BRAIN_TOOL_RE.test(name)) continue;
      harvestIds(textOfBlocks(r.content), s);
    }
    if (results.length) continue;
    if (o.origin && o.origin.kind && o.origin.kind !== "human") continue;
    const text = stripInjected(textOfBlocks(content));
    if (text && !NOT_ASKED_RE.test(text)) s.prompts.push(text);
  }
  return s;
}

/** Codex's ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — {timestamp, type, payload} per line. */
export function parseCodex(lines, s) {
  const calls = new Map(); // call_id → { name, input }
  let lastAgentMessage = "";
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const p = o?.payload;
    if (!p || typeof p !== "object") continue;
    if (typeof o.timestamp === "string") { if (!s.first) s.first = o.timestamp; s.last = o.timestamp; }
    if (o.type === "session_meta") {
      s.sessionId ||= String(p.id ?? p.session_id ?? "");
      if (typeof p.cwd === "string" && p.cwd) { s.cwd = p.cwd; s.roots.add(p.cwd); }
      continue;
    }
    if (o.type === "turn_context") { if (typeof p.cwd === "string" && p.cwd) { s.cwd = p.cwd; s.roots.add(p.cwd); } continue; }
    if (o.type === "event_msg") {
      if (p.type === "task_complete" && typeof p.last_agent_message === "string" && p.last_agent_message.trim()) lastAgentMessage = p.last_agent_message;
      continue;
    }
    if (o.type !== "response_item") continue;
    if (p.type === "message") {
      const text = textOfBlocks(p.content);
      if (p.role === "user") { const t = stripInjected(text); if (t) s.prompts.push(t); }
      else if (p.role === "assistant" && text.trim()) s.outcome = text;
      continue;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = String(p.name ?? "");
      const raw = p.type === "function_call" ? p.arguments : p.input;
      calls.set(p.call_id, { name, raw });
      if (name === "apply_patch" || /apply_patch/.test(name)) {
        for (const m of String(raw ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) s.files.add(m[1].trim());
      } else if (name === "shell" || name === "exec_command" || name === "container.exec") {
        let cmd = ""; try { const a = JSON.parse(String(raw)); cmd = Array.isArray(a.command) ? a.command.join(" ") : String(a.command ?? a.cmd ?? ""); } catch { cmd = String(raw ?? ""); }
        if (/\bgit\s+commit\b/.test(cmd)) s.commits++;
        if (/\bgit\s+push\b/.test(cmd)) s.pushed = true;
      }
      continue;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const call = calls.get(p.call_id);
      if (!call || !BRAIN_TOOL_RE.test(call.name)) continue;
      harvestIds(textOfBlocks(p.output) || String(p.output ?? ""), s);
    }
  }
  if (lastAgentMessage) s.outcome = lastAgentMessage;
  return s;
}

function harvestIds(text, s) {
  for (const m of text.matchAll(CAPTURED_ID_RE)) s.captured.add(m[1].toLowerCase());
  for (const m of text.matchAll(RETRIEVED_ID_RE)) { const id = m[1].toLowerCase(); if (!s.captured.has(id)) s.retrieved.add(id); }
}

/** Read a transcript and return the summary structure. */
export function summariseTranscript(path, harness) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const s = emptySummary();
  s.harness = harness || sniffHarness(lines.slice(0, 5));
  return s.harness === "codex" ? parseCodex(lines, s) : parseClaudeCode(lines, s);
}

// ── The summary text ─────────────────────────────────────────────────────────

/** A path relative to the first project root that contains it; unchanged (absolute) when none does. */
function relPath(p, roots) {
  if (!isAbsolute(p)) return p;
  for (const root of roots) {
    const r = relative(root, p);
    if (r && !r.startsWith("..") && !isAbsolute(r)) return r;
  }
  return p;
}

/** Dedupe consecutive repeats of one prompt (a retried command), keep order. */
function distinctPrompts(prompts) {
  const out = [];
  for (const p of prompts) { const line = oneLine(p); if (line && out[out.length - 1] !== line) out.push(line); }
  return out;
}

/** An ISO timestamp as the summary shows it: the day and the minute. */
const when = (iso) => iso.slice(0, 16).replace("T", " ");

/** Render the summary as one thought. Deterministic: the same transcript renders the same text, which is what the fingerprint and the state compare. */
export function renderSummary(s) {
  const project = s.cwd && s.cwd !== HOME ? basename(s.cwd) : ""; // a session in $HOME names no project (and not the user)
  // A transcript with no timestamp is "undated", never today: the clock would
  // change the fingerprint at midnight and the same session would be captured twice (ninth review pass).
  const day = s.last || s.first ? (s.last || s.first).slice(0, 10) : "undated";
  const prompts = distinctPrompts(s.prompts);
  const head = [`Session summary — ${s.harness}`, project, s.branch ? `(${s.branch})` : "", day].filter(Boolean).join(" — ").replace(" — (", " (");
  const parts = [head];
  const title = oneLine(s.title || prompts[0] || "");
  if (title) parts.push(`Title: ${clip(title, 120)}`);

  if (prompts.length) {
    const shown = prompts.slice(0, LIMITS.prompts).map((p) => `- ${clip(p, LIMITS.promptChars)}`);
    if (prompts.length > LIMITS.prompts) shown.push(`- … and ${prompts.length - LIMITS.prompts} more`);
    parts.push(`Asked (${prompts.length} prompt${prompts.length === 1 ? "" : "s"}):\n${shown.join("\n")}`);
  }
  const outcome = stripInjected(s.outcome).trim();
  if (outcome) parts.push(`Outcome (the assistant's last message):\n${clip(outcome, LIMITS.outcomeChars)}`);

  const changed = [];
  if (s.files.size) {
    // Inside the project, by relative path; outside it (a memory note, a scratch
    // file, another checkout) counted only — not the session's work, and the
    // path says where things live on this machine.
    const inside = [], outside = [];
    const roots = s.roots.size ? s.roots : new Set(s.cwd ? [s.cwd] : []);
    for (const f of s.files) { const r = relPath(f, roots); (isAbsolute(r) ? outside : inside).push(r); }
    if (inside.length) {
      const shown = inside.slice(0, LIMITS.files).join(", ") + (inside.length > LIMITS.files ? `, … ${inside.length - LIMITS.files} more` : "");
      changed.push(`${inside.length} file${inside.length === 1 ? "" : "s"} — ${shown}`);
    }
    if (outside.length) changed.push(`${outside.length} file${outside.length === 1 ? "" : "s"} outside the project`);
  }
  if (s.commits) changed.push(`${s.commits} commit${s.commits === 1 ? "" : "s"}${s.pushed ? ", pushed" : ""}`);
  if (s.prs.length) changed.push(`PR ${s.prs.join(", ")}`);
  if (changed.length) parts.push(`Changed: ${changed.join("; ")}.`);

  const brain = [];
  if (s.retrieved.size) brain.push(`retrieved ${s.retrieved.size} thought${s.retrieved.size === 1 ? "" : "s"}`);
  if (s.captured.size) brain.push(`captured ${s.captured.size}`);
  parts.push(brain.length ? `Brain: ${brain.join(", ")} (recorded as this summary's provenance).` : "Brain: no thoughts read or written this session.");
  // A summary of a session still running says so, and how it got here — a
  // compaction (PreCompact, manual or auto) or a turn (Stop) — so a reader
  // tells a checkpoint from an end; the end's summary carries no such line and
  // supersedes it (SMD-2012). The moment is the transcript's last timestamp,
  // never the clock: the fingerprint must not move with time.
  const tail = [];
  if (s.checkpoint) {
    const at = s.last ? ` at ${when(s.last)}` : "";
    const how = s.checkpoint.kind === "compacted" ? `compacted${at}${s.checkpoint.trigger ? ` (${s.checkpoint.trigger})` : ""}` : `turn ended${at}`;
    tail.push(`Checkpoint: ${how}, continuing — the session's next checkpoint or its end supersedes this summary.`);
  }
  tail.push(`Session ${clip(s.sessionId || "unknown", LIMITS.sessionIdChars)}${s.first ? `, ${when(s.first)}` : ""}${s.last && s.last !== s.first ? ` → ${when(s.last)}` : ""}.`);
  // The cap falls on the body — prompts, outcome, files — never on the closing
  // lines: clip() cuts from the tail, and a long checkpoint summary that lost
  // the line saying the session still runs would read as final (first review
  // pass). The closing is bounded (the id clipped, the rest fixed), so the
  // whole stays within LIMITS.textChars (fifth review pass: an unbounded id
  // made that sentence false).
  // The body's room is never below one: clip() with a negative bound slices
  // from the end (second review pass; a session id longer than the cap is
  // unreachable through the hook — its payload name would fail — but the
  // arithmetic is honest, and the closing is then the whole).
  const closing = tail.join("\n\n");
  return `${clip(parts.join("\n\n"), Math.max(1, LIMITS.textChars - closing.length - 2))}\n\n${closing}`;
}

/**
 * The scan over everything the summary was built from — the rendered text and
 * the full prompts, outcome and title BEFORE their clips — so a credential a
 * clip would cut in half is still seen whole (third review pass: the scan ran
 * on the rendered text alone, and a key straddling a 200-character clip left as
 * a fragment no pattern matched). Findings from a source name where they sit.
 */
export function scanSummary(s, text) {
  const found = scanForSecrets(text);
  const sources = [["a prompt", s.prompts.join("\n")], ["the outcome", s.outcome ?? ""], ["the title", s.title ?? ""]];
  for (const [where, full] of sources) {
    for (const f of scanForSecrets(full)) if (!found.some((g) => g.reason.replace(/ in (?:a prompt|the outcome|the title)$/, "") === f.reason)) found.push({ reason: `${f.reason} in ${where}`, at: f.at });
  }
  return found;
}

/** The ids sent as derived_from: what the session retrieved, then what it captured, capped. */
export function provenanceOf(s) {
  return [...s.retrieved, ...s.captured].slice(0, LIMITS.derived);
}

// ── Secret scan ──────────────────────────────────────────────────────────────

function entropyBits(token) {
  const counts = new Map();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / token.length; h -= p * Math.log2(p); }
  return h;
}

/** The patterns, named so a refusal can say WHAT kind of thing it saw without showing it. */
export const SECRET_PATTERNS = [
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/],
  ["aws access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ["slack token", /\bxox[aboprs]-[A-Za-z0-9-]{10,}/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/],
  ["sendgrid key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/],
  ["linear key", /\blin_api_[A-Za-z0-9]{20,}/],
  ["hugging face token", /\bhf_[A-Za-z0-9]{30,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["url with a password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/]{4,}@/i],
  ["slack webhook url", /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{16,}/],
  // The connector form SETUP.md documents, `…/?key=<raw key>`: URLs are blanked
  // before the hex rule runs, so this one reads the full text (fourth review pass).
  ["access key in a URL", /[?&](?:key|api[_-]?key|access[_-]?token|token|secret|sig|signature|x-amz-signature)=[A-Za-z0-9._~%+/=-]{16,}/i],
  ["bearer token", /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/],
  // A credential ASSIGNED: `x-brain-key: <hex>`, `MCP_ACCESS_KEY=…`, `api_key = "…"`. Not DATABASE_URL:
  // a URL without a password is an address, and one with is caught above.
  // Not MCP_ACCESS_KEYS (plural): that value holds name:scope:DIGEST records by construction (keygen.ts), and a session quoting deploy/.env's line is not leaking a key (third review pass).
  // The name may carry an env-var prefix (`AWS_SECRET_ACCESS_KEY=`, `MY_API_KEY=`,
  // `SECRET_KEY_BASE=`, `GITHUB_TOKEN=`): `\b` never sits between `_` and a
  // letter, so a rule that began at the word let every prefixed spelling by
  // (eleventh review pass). Bare `token` needs a prefix — "a token of appreciation".
  // The VALUE must be a value: `${VAR}`, `$VAR`, `<placeholder>`, `process.env.X`,
  // `os.environ[...]`, `session.accessToken,` are references, and a session that
  // quoted compose.yaml's own `OB1_LLM_API_KEY=${OB1_LLM_API_KEY:-}` refused
  // itself (twelfth review pass). A value with no digit is a placeholder or a
  // name — `your-api-key-goes-here`, `REPLACE_WITH_YOUR_KEY`, `********`,
  // `get_random_secret_key()` — each refused a whole session (thirteenth); a
  // real key without a digit is rare, and the entropy rule reads one of 32+.
  ["credential assignment", /(?<![A-Za-z0-9])(?:x-brain-key|MCP_ACCESS_KEY|OB1_[A-Z_]*KEY|OB1_SMOKE_KEY|(?:[A-Z0-9]+_)*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret(?:[_-]?(?:access[_-]?)?key)?(?:[_-]?base)?)|(?:[A-Z0-9]+_)+token|bearer)\b["']?\s*[:=]\s*["']?(?!\$|<|%|\{|process\.env\b|os\.environ\b|Deno\.env\b|import\.meta\.env\b|[A-Za-z_]\w*(?:\.\w+)+[,;)]?(?:\s|$))(?=[^\s"']*\d)[^\s"']{16,}/i],
  // A credential handed to a command by flag: `--api-key <value>` has no `=`
  // (twelfth review pass). Hyphenated compounds (`--client-secret`,
  // `--refresh-token`), `=` as well as a space; not a path, a `%VAR%`, or
  // docker's `--secret id=…,src=…` spec, and the value carries a digit
  // (thirteenth). A password's floor is six, as in the assignment rule.
  ["credential flag", /(?<![\w-])--(?:[a-z]+-)*(?:api-?key|access-?token|auth-?token|client-?secret|refresh-?token|token|secret(?:-?key)?)(?:\s+|=)["']?(?!\$|<|%|[\/~.]|\w+=)(?=[^\s"']*\d)[^\s"']{16,}/i],
  ["password flag", /(?<![\w-])--(?:[a-z]+-)*password(?:\s+|=)["']?(?!\$|<|%|[\/~.]|\w+=)[^\s"']{6,}/i],
  // A password can be short — `POSTGRES_PASSWORD=hunter2` reached the brain under the 16-character floor (first review pass).
  ["password assignment", /\b(?:passw(?:or)?d|[A-Z_]*PASSWORD|PGPASSWORD)\b["']?\s*[:=]\s*["']?[^\s"']{6,}/i],
  // This fork's own access keys are 64 hex characters (keygen.ts), as are their
  // digests — told apart only by where they sit: a digest follows `name:scope:`
  // in MCP_ACCESS_KEYS or `sha256:`; a bare 64-hex run is a key until proven
  // otherwise (second review pass: the mixed-case rule let every hex string by).
  // …and not the everyday spellings of a digest: `SHA256=<hex>`, `--sha256 <hex>`, `sha256: <hex>`,
  // and `sha256sum`'s own output shape, `<hex>  file` — two spaces then the name (fifth review pass:
  // an actionlint pin line refused a session; sixth: a lookbehind on the WORD sha256sum excused any
  // hex later on that line, a key included).
  ["64-hex token (a raw key, or a digest out of its context)", /(?<![0-9a-f])(?<!:(?:read|write|capture):)(?<!sha-?256\s*[:=]\s*)(?<!--sha-?256\s+)(?<![A-Za-z0-9_-])(?:0x)?[0-9a-f]{64}(?![0-9a-f])(?!(?<=(?:^|\n)[ \t]*(?:0x)?[0-9a-f]{64})\s{2}\S)/i],
];

/**
 * Scan a text. Returns [] when clean, else one entry per finding: the pattern's
 * name and where (a 0-based character offset), never the matched text. Besides
 * the patterns: a 32+ character token of mixed case and digits with high
 * entropy — a key or token by shape. What is NOT a token: hex (a sha, a digest, a uuid —
 * no mixed case), a path (split at its slashes), a URL's path or query (a
 * document id), a base64 data URI, a file name, and a word-shaped identifier
 * (`getUserAccountBalanceById2026Version3`: mostly lowercase runs). The bar is
 * 4.5 bits per character under 48 characters and 4.2 from there — a real key
 * measures 5 and up; an identifier 4.4 (first review pass: six realistic
 * false positives, each of which would have refused a whole session).
 */
/** The patterns that read the URL-blanked text: shapes, not prefixes. */
const URL_BLIND = new Set(["64-hex token (a raw key, or a digest out of its context)"]);

export function scanForSecrets(text) {
  const findings = [];
  // URLs and base64 payloads blanked in place (offsets kept) for the shape
  // rules — the 64-hex rule and the token scan: a hex id in a URL's path (a
  // sha256 repository's commit, a blob) is an address, not a pasted key (third
  // review pass). The named patterns run over the full text — a key inside a
  // URL's query is caught by its prefix or by the `?key=` rule above.
  const blanked = text
    .replace(/\bhttps?:\/\/[^\s)>\]"']+/gi, (u) => " ".repeat(u.length))
    .replace(/\bbase64,[A-Za-z0-9+/=]+/g, (b) => " ".repeat(b.length));
  for (const [name, re] of SECRET_PATTERNS) {
    const m = re.exec(URL_BLIND.has(name) ? blanked : text);
    if (m) findings.push({ reason: name, at: m.index });
  }
  for (const m of blanked.matchAll(/[A-Za-z0-9+_=-]{32,}/g)) {
    const t = m[0];
    if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/[0-9]/.test(t)) continue;
    if (/^[\w.-]+\.(?:md|ts|mjs|js|json|sql|yml|yaml|txt|sh)$/.test(t)) continue; // a file name
    const wordish = (t.match(/[a-z]{3,}/g) ?? []).join("").length / t.length;
    if (wordish >= 0.6) continue; // an identifier, not a key
    if (entropyBits(t) >= (t.length >= 48 ? 4.2 : 4.5)) findings.push({ reason: "high-entropy token", at: m.index });
  }
  return findings.sort((a, b) => a.at - b.at);
}

// ── Posting over MCP ─────────────────────────────────────────────────────────

/**
 * Parse a Streamable-HTTP answer: raw JSON, or an SSE stream whose LAST event
 * is the JSON-RPC message. An event's data is every `data:` line joined with
 * newlines, the optional space after the colon dropped — the spec's shape, not
 * only the one-line form the server sends today (first review pass).
 */
export function parseRpcBody(text, wantId) {
  const t = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const messages = t.split(/\n\n+/)
    .map((ev) => ev.split("\n").filter((l) => /^data:/.test(l)).map((l) => l.replace(/^data:\s?/, "")).join("\n"))
    .filter((d) => d.length > 0)
    .map((d) => { try { return JSON.parse(d); } catch { return null; } })
    .filter((m) => m && typeof m === "object");
  if (!messages.length) throw new Error(`not a JSON-RPC answer: ${t.slice(0, 80)}`);
  // The reply to THIS request by id; else the last message that is a reply at
  // all — a trailing notification (a ping) is not the answer (second review pass).
  return messages.find((m) => wantId !== undefined && m.id === wantId)
    ?? [...messages].reverse().find((m) => m.result !== undefined || m.error !== undefined)
    ?? messages[messages.length - 1];
}

/** Why a capture did not land: `refused` — the server said no to the request as shaped (nothing will change on a retry); `failed` — the server, the store or the network did not answer (a retry may). */
export class CaptureError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
// The server's own refusals open with "Refused:" — that alone; a store error
// phrased with "not found" or "must be" is a failure to keep (second review
// pass). The SDK's unknown-tool and invalid-params errors are RESULTS with
// isError set, whose text opens "MCP error -32602" — not JSON-RPC errors
// (thirteenth review pass: a key whose scope had been narrowed retried its
// unknown tool for a week). Both are final.
export const REFUSAL_RE = /^\s*Refused\b/;
export const SDK_ERROR_RE = /^\s*MCP error -3260[12]\b/;

/** One request's ceiling — and how long a run waits, in all, for an earlier payload of a session that another child is posting (SMD-2035). */
export const POST_TIMEOUT_MS = 90_000;

let rpcId = 1;
export async function rpc(cfg, method, params, timeoutMs = POST_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const id = rpcId++;
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": cfg.key },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "manual", // a redirect is a page or a front, not the endpoint (sixth review pass: a 301 to a login page was five silent retries)
      signal: ac.signal,
    });
    const text = await r.text();
    const wrongUrl = (what) => new CaptureError("refused", `${what} from ${cfg.url} — not the MCP endpoint, or a proxy in front of it; check the url in ${CONFIG_PATH}`);
    // The server answers inside a 200 — a 4xx is a proxy, a login page, or a
    // URL that is not the endpoint: said once and given up, not retried five
    // times as a transient (fifth review pass). A 5xx is the server or its
    // front unwell, and kept; so are 408 and 429, the endpoint asking for
    // patience. A 4xx that carries a JSON-RPC envelope is judged by the
    // envelope — a front mirroring -32001 onto HTTP 401 is a bad KEY, not a
    // bad url (sixth review pass).
    if (r.status >= 300 && r.status < 400) throw wrongUrl(`HTTP ${r.status} redirect to ${r.headers.get("location") ?? "?"}`);
    if (r.status === 408 || r.status === 429) throw new CaptureError("failed", `HTTP ${r.status} from ${cfg.url} — the endpoint asks for patience`);
    if (r.status >= 400 && r.status < 500) {
      let inner = null;
      try { inner = parseRpcBody(text, id); } catch { /* no envelope: a page */ }
      if (inner?.error) throw new Error(`JSON-RPC ${inner.error.code ?? ""}: ${inner.error.message ?? "error"}`.trim());
      throw wrongUrl(`HTTP ${r.status}`);
    }
    if (r.status >= 500) throw new CaptureError("failed", `HTTP ${r.status} from ${cfg.url}`);
    if (/text\/html/i.test(r.headers.get("content-type") ?? "") && !text.trimStart().startsWith("{")) throw wrongUrl("an HTML page");
    const body = parseRpcBody(text, id);
    if (body.error) throw new Error(`JSON-RPC ${body.error.code ?? ""}: ${body.error.message ?? "error"}`.trim());
    return body.result ?? {};
  } finally {
    clearTimeout(timer);
  }
}

const textOfResult = (result) => (result?.content ?? []).map((c) => c?.text ?? "").join("\n");

/**
 * capture_thought over MCP. Returns { id, note } on success. A refusal of a
 * pointer — a derived_from id the server does not know (a thought since
 * deleted, a result this parser misread), or a supersedes the server refuses
 * (the earlier summary deleted; a key that may not replace it) — drops that
 * pointer and tries again, and the note says so: a summary with no sources, or
 * a fresh one beside the old, beats no summary. (First review pass: only
 * derived_from was retried, and a dead supersedes refused every later ending of
 * the session forever, since the state kept naming it.)
 */
export async function postCapture(cfg, payload) {
  const args = { content: payload.text, source: payload.harness };
  if (payload.derived_from?.length) args.derived_from = payload.derived_from;
  if (payload.supersedes) args.supersedes = payload.supersedes;
  const call = () => rpc(cfg, "tools/call", { name: "capture_thought", arguments: args });
  let result = await call();
  let text = textOfResult(result);
  const notes = [];
  // Only a "Refused:" is mended by dropping a pointer; the server's own errors
  // ("Error: … could not be checked", the registry away) are kept whole for a
  // later run (fifth review pass: the hook told the two apart by wording).
  for (let retry = 0; retry < 5 && result.isError && REFUSAL_RE.test(text); retry++) {
    // The server names the POSITIONS that name no thought (second review
    // pass: a first cut dropped all forty sources over one deleted thought).
    const at = [...text.matchAll(/derived_from\[(\d+)\]/g)].map((m) => Number(m[1])).filter((i) => args.derived_from && i < args.derived_from.length);
    if (args.derived_from && at.length) {
      notes.push(`${at.length} source id(s) dropped: ${oneLine(text).slice(0, 120)}`);
      args.derived_from = args.derived_from.filter((_, i) => !at.includes(i));
      if (!args.derived_from.length) delete args.derived_from;
    } else if (args.derived_from && /derived_from/.test(text)) { notes.push("provenance dropped: " + oneLine(text).slice(0, 160)); delete args.derived_from; }
    else if (args.supersedes && /supersedes/.test(text)) { notes.push("supersedes dropped: " + oneLine(text).slice(0, 160)); delete args.supersedes; }
    else break;
    result = await call();
    text = textOfResult(result);
  }
  const id = new RegExp(`(?:\\bid |\\(id )(${UUID})`, "i").exec(text)?.[1];
  if (result.isError && !id) {
    // A refusal is final; anything else — "Error: Failed to connect", a store
    // timeout — is the server not answering, and the payload is worth keeping
    // (first review pass: every isError was "refused", and a brain whose
    // database was down for a minute lost the session for good).
    const refused = REFUSAL_RE.test(text) || SDK_ERROR_RE.test(text);
    const err = new CaptureError(refused ? "refused" : "failed", `capture ${refused ? "refused" : "failed"}: ${oneLine(text).slice(0, 200)}`);
    // The server's two sentences for a pointer it could not judge (index.ts):
    // a failure ON the pointer, counted by postPending so the last attempt can
    // drop it — the word alone in some other error is not one (eighth review pass).
    if (/this key's `supersedes` could not be (?:checked|attributed)/.test(text)) err.on = "supersedes";
    throw err;
  }
  if (result.isError) notes.push(oneLine(text).slice(0, 160));
  if (!id) throw new CaptureError("failed", `capture answered without an id: ${oneLine(text).slice(0, 200)}`);
  return { id: id.toLowerCase(), note: notes.join("; ") };
}

// ── The two halves of a hook run ─────────────────────────────────────────────

/**
 * The events this hook runs on, in one table (SMD-2012; second review pass:
 * the same three names were spelled in four structures that had to agree).
 * `checkpoint` is what a summary captured at the event says of the session —
 * `compacted` before a compaction, `running` at a turn's end, nothing at an
 * end; `timeout` whether the printed hook pins 10 s (3 on Codex): SessionEnd's
 * budget is shared, and a compaction waits on PreCompact; `interval` whether
 * the printed command carries --min-interval, Stop's floor — and prepare()
 * gates on it; `trigger` whether the harness sends one with it; `harnesses`
 * which harness fires it, `byDefault` whether --print-hook prints it unasked.
 * The table is the one reader of these facts (fourth review pass: the gate,
 * the interval's event and the trigger's were still spelled as names). Claude
 * Code's PreCompact fires before a compaction, manual or automatic — the
 * checkpoint a long session already has; Codex has no compaction hook, so its
 * default is SessionEnd alone. An event outside the table is
 * not the hook's: prepare() skips it, since SubagentStop or UserPromptSubmit
 * would post a final-looking summary of a session still running.
 */
/**
 * The harnesses, and what differs between them: the label a message uses,
 * where the printed hook is pasted, and the timeout a pinned hook carries —
 * Claude Code raises SessionEnd's shared 1.5 s budget to a hook's own (≤ 60),
 * Codex allows at most 3 s (fifth review pass: the 3-or-10, the labels and the
 * paths were ternaries beside the events' table).
 */
export const HARNESS = Object.assign(Object.create(null), {
  "claude-code": { label: "Claude Code", settings: "~/.claude/settings.json (or .claude/settings.json in a project)", timeoutSec: 10 },
  codex: { label: "Codex", settings: "~/.codex/hooks.json", timeoutSec: 3 },
});
export const HARNESSES = Object.keys(HARNESS);
// A null prototype, and eventSpec() by own property: on a plain object
// `EVENTS["constructor"]` is Object's, and "toString" passed every check as an
// event — printed as a hook that never fires, captured as an end (third review pass).
export const EVENTS = Object.assign(Object.create(null), {
  SessionEnd: { checkpoint: undefined, timeout: true, interval: false, trigger: false, harnesses: HARNESSES, byDefault: true },
  PreCompact: { checkpoint: "compacted", timeout: true, interval: false, trigger: true, harnesses: ["claude-code"], byDefault: true },
  Stop: { checkpoint: "running", timeout: false, interval: true, trigger: false, harnesses: HARNESSES, byDefault: false },
});
export const HOOK_EVENTS = Object.keys(EVENTS);
/** The table's row for a name, or undefined — the one way the table is read. */
export const eventSpec = (name) => (typeof name === "string" && Object.hasOwn(EVENTS, name) ? EVENTS[name] : undefined);
/** What --print-hook prints with no --event: the table's default events the harness fires (second review pass: a second table beside the first). */
export const DEFAULT_EVENTS = Object.fromEntries(HARNESSES.map((h) => [h, HOOK_EVENTS.filter((e) => EVENTS[e].byDefault && EVENTS[e].harnesses.includes(h))]));
/** The events that carry a trigger, and those the interval gates — derived once, so a message cannot drift from the table (fifth review pass). */
export const TRIGGER_EVENTS = HOOK_EVENTS.filter((e) => EVENTS[e].trigger);
export const INTERVAL_EVENTS = HOOK_EVENTS.filter((e) => EVENTS[e].interval);
/** The two triggers Claude Code sends with PreCompact; anything else is recorded nowhere. */
export const TRIGGERS = ["auto", "manual"];

/** What the event says about the session, for renderSummary's Checkpoint line: `compacted` with its trigger, `running`, or nothing for an end. */
export function checkpointOf(hook) {
  const spec = eventSpec(String(hook.hook_event_name ?? ""));
  if (!spec?.checkpoint) return undefined;
  return spec.trigger ? { kind: spec.checkpoint, trigger: TRIGGERS.includes(hook.trigger) ? hook.trigger : undefined } : { kind: spec.checkpoint };
}

/**
 * The foreground: read the transcript, decide, summarise, scan, hand off.
 * Returns { code, message, payloadPath? } — the caller prints the message and exits with the code.
 */
let payloadSeq = 0;
export function prepare(hook, opts = {}) {
  const event = String(hook.hook_event_name ?? "");
  // An event this hook is not for — a command pasted under SubagentStop or
  // UserPromptSubmit fires mid-session and would post a final-looking summary
  // that supersedes the checkpoint (second review pass). No event at all is a
  // run by hand, an end.
  if (event && !eventSpec(event)) return { code: 0, message: `skip: ${event} is not an event this hook captures on (${HOOK_EVENTS.join(", ")}); nothing captured` };
  if (!hook.transcript_path || !existsSync(hook.transcript_path)) return { code: 0, message: `skip: no transcript for session ${hook.session_id || "?"}` };
  const s = summariseTranscript(hook.transcript_path, opts.harness);
  // ONE id for both halves: the hook's session_id (what a later run of the same
  // session presents again), else the transcript's own — the state, the
  // interval and the payload all key on it (tenth review pass: a hook that sent
  // no session_id read its state under "" and its payload under the
  // transcript's id, and never saw its own capture). Resolved after the
  // transcript is read, since the fallback comes from it; the read costs ~50 ms.
  if (typeof hook.session_id === "string" ? hook.session_id : typeof hook.session_id === "number") s.sessionId = String(hook.session_id); // an object is not an id
  const sessionId = s.sessionId;
  const state = readState(sessionId) ?? {};
  const queued = sessionPayloads(sessionId); // walked once: the interval and the dedupe below both read it (thirteenth review pass)
  if (eventSpec(event)?.interval && opts.minIntervalMin > 0) {
    const last = lastAttemptMs(sessionId, state, queued);
    const ageMin = last ? (Date.now() - last.at) / 60_000 : Infinity;
    if (ageMin < opts.minIntervalMin) return { code: 0, message: `skip: last capture ${ageMin.toFixed(0)} min ago${last.pending ? " (still pending)" : ""}, interval ${opts.minIntervalMin}` };
  }
  if (typeof hook.cwd === "string" && hook.cwd) { s.cwd = hook.cwd; s.roots.add(hook.cwd); }
  if (!s.prompts.length) return { code: 0, message: `skip: no human prompt in session ${s.sessionId}` };
  s.checkpoint = checkpointOf(hook);
  const text = renderSummary(s);
  const fingerprint = sha256(text);
  if (state.fingerprint === fingerprint) return { code: 0, message: `skip: session ${s.sessionId} already captured as ${state.thought_id}` };
  // …or already QUEUED: with the endpoint away, a session resumed and ended
  // again with no new turn would queue the same summary twice, and the run
  // that drains them would dead-letter the first as "obsolete" (eleventh review pass).
  for (const p of queued) {
    try { if (JSON.parse(readFileSync(p.path, "utf8")).fingerprint === fingerprint) return { code: 0, message: `skip: session ${s.sessionId} already queued — a payload with this summary is pending` }; } catch { /* a sibling took or removed it */ }
  }
  const findings = scanSummary(s, text);
  if (findings.length) {
    const where = findings.map((f) => `${f.reason} at char ${f.at}`).join(", ");
    return { code: 1, message: `refused — the summary for session ${s.sessionId} carries what looks like a secret (${where}); nothing sent. Remove it from the conversation before ending the session, or capture by hand.` };
  }
  const payload = {
    session_id: s.sessionId, harness: s.harness, event, trigger: s.checkpoint?.trigger, text, fingerprint,
    derived_from: provenanceOf(s), supersedes: state.thought_id || undefined,
    prompts: distinctPrompts(s.prompts).length, prepared_at: new Date().toISOString(), attempts: 0,
  };
  ensureDirs();
  // The name orders the queue: the millisecond, then a per-process sequence
  // (two payloads one process prepares in one millisecond sort as made — third
  // review pass: a random tail decided, and a test flaked), then a random tail
  // so two processes never collide.
  const payloadPath = join(PENDING_DIR(), `${Date.now()}-${String(payloadSeq++).padStart(4, "0")}-${randomBytes(3).toString("hex")}-${basename(statePath(s.sessionId), ".json")}.json`);
  writeJson(payloadPath, payload);
  return { code: 0, message: `prepared: session ${s.sessionId}${s.checkpoint ? ` (${event}${s.checkpoint.trigger ? ` ${s.checkpoint.trigger}` : ""})` : ""}, ${payload.prompts} prompt(s), ${payload.derived_from.length} source id(s)${payload.supersedes ? `, supersedes ${payload.supersedes}` : ""}`, payloadPath, payload };
}

/**
 * Whether the state records a summary NEWER than a payload prepared at
 * `preparedAt`. States from before summary_at carry the post time — close
 * enough. A recorded time in the FUTURE (a clock that was wrong) decides
 * nothing — else one skewed payload would make every honest later ending
 * obsolete until the wall clock caught up (fourth review pass). One rule,
 * read before the post and again after it (ninth review pass: it was spelled twice).
 */
function recordedAfter(state, preparedAt) {
  const recordedMs = Date.parse(state?.summary_at ?? state?.captured_at ?? "");
  return Boolean(preparedAt && recordedMs <= Date.now() && recordedMs > Date.parse(preparedAt));
}

/**
 * The claims a payload steps aside for: payloads of its session that another
 * LIVE child holds under inflight/<pid>/ and that are OLDER than it — a name
 * leads with the millisecond it was prepared, so the names order them. A
 * compaction's child still posting when the session's end spawned its own
 * (`/compact` then `/exit`; an auto-compaction on the last turn) left the
 * end's payload pointing at nothing — the checkpoint had not landed — so the
 * end landed first and the checkpoint after it, a live thought saying
 * "continuing" of a session that had ended, beside the final summary
 * (SMD-2035; SMD-2012's second review pass, the gap SMD-1989 had recorded).
 * A child that is gone holds no one (the next run's sweep returns its claim);
 * only the NEWER of two steps aside, so two children never wait on each other.
 */
export const aheadOf = (sessionId, name) => sessionPayloads(sessionId, { pending: false }).filter((p) => p.pid !== process.pid && p.name.localeCompare(name) < 0 && isAlive(p.pid));
/**
 * Whether a NEWER payload of the session is in another live child's hands:
 * the older one is then obsolete — a summary is cumulative, the newer covers
 * it, and a payload posted beside it would stand as a live "continuing"
 * thought (fourth review pass: a sweep returned an older payload to pending/
 * after the newer's run had looked, a sibling claimed it, and both posted).
 */
export const newerInFlight = (sessionId, name) => sessionPayloads(sessionId, { pending: false }).some((p) => p.pid !== process.pid && p.name.localeCompare(name) > 0 && isAlive(p.pid));

/**
 * The session's landed payloads whose bookkeeping is still owed — the post
 * answered, `captured_id` written, the state write failed, the file back under
 * pending/ or still in its child's hands — are thoughts the state does not
 * name (first review pass). Each with its moment: the time it was prepared,
 * or the millisecond in its name when a hand-made file has none.
 */
function landedPayloads(sessionId) {
  const out = [];
  for (const p of sessionPayloads(sessionId)) {
    let j;
    try { j = JSON.parse(readFileSync(p.path, "utf8")); } catch { continue; }
    if (j?.captured_id) out.push({ name: p.name, id: j.captured_id, ms: momentOf(j.prepared_at, p.ms) });
  }
  return out;
}
/** The newest of them older than `name`, by name — whatever order the directories were read in. */
export function landedBefore(sessionId, name) {
  return landedPayloads(sessionId).filter((p) => p.name.localeCompare(name) < 0).sort((a, b) => b.name.localeCompare(a.name))[0];
}
/** Whether one newer than `name` has landed: a payload older than it is then obsolete whatever the state says (second review pass). */
export function landedAfter(sessionId, name) {
  return landedPayloads(sessionId).some((p) => p.name.localeCompare(name) > 0);
}
/** A recorded moment for ranking: the time when it is one and not in the future — a clock that was wrong decides nothing, recordedAfter's rule — else the fallback. */
const momentOf = (iso, fallbackMs) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) && t <= Date.now() ? t : fallbackMs; };
/**
 * The thought a payload supersedes: the session's newest landed one by the
 * time its payload was prepared — what the state records (`summary_at`, the
 * prepare time; `captured_at`, the post time, only for a state from before
 * it), or a landed payload whose bookkeeping is owed. Newest by time, not by
 * source: a run that finished an older payload's bookkeeping named it over
 * the state's newer thought, and two summaries stood (first review pass).
 * What this run itself landed is one or the other: its state write moved the
 * state, or failed and left the payload owed under pending/ — the per-run map
 * SMD-1298's sixth pass added for it was the third spelling of the same fact.
 */
export function pointerFor(sessionId, name, state) {
  // A state whose time is in the future or unreadable STANDS (its moment is now): it is the pointer's normal source, and a clock that was wrong is no reason to rank an owed payload — the exception — over it (fourth review pass).
  const cands = [state?.thought_id && { id: state.thought_id, ms: momentOf(state.summary_at ?? state.captured_at, Date.now()) }, landedBefore(sessionId, name)].filter(Boolean);
  cands.sort((a, b) => b.ms - a.ms);
  return cands[0]?.id;
}

/**
 * The background half: post what is pending, OLDEST FIRST — up to four earlier
 * payloads from runs whose post failed, then the one this run prepared — so a
 * session that ended while the server was down lands on the next session's
 * ending, whichever session that is. A summary is cumulative over the
 * transcript, so of two payloads of ONE session only the newest is worth
 * posting: an older one — older than another in this run, or than the summary
 * the session's state already records (`summary_at`, the payload's own
 * prepared_at, not the time it was posted) — is obsolete and goes to dead/
 * unposted (second review pass). Every file this run touches it first CLAIMS
 * by renaming it into inflight/<pid>/, an atomic move exactly one of two
 * children wins, so two sessions ending together never post each other's
 * payload or trip over a file the other moved; a child that dies mid-flight
 * leaves its claims for the next run's sweep (third review pass). The run's
 * own payload is always among the five. After its landings the run follows
 * up once with up to five payloads of those sessions that waited under
 * pending/ — an end deferred behind the checkpoint it has just landed
 * (SMD-2035) — never with one it has itself just returned there.
 */
export async function postPending(cfg, own) {
  ensureDirs();
  sweepInflight();
  const mine = join(INFLIGHT_DIR(), String(process.pid));
  mkdirSync(mine, { recursive: true, mode: 0o700 });
  const pending = readdirSync(PENDING_DIR()).filter((f) => f.endsWith(".json")).sort().map((f) => join(PENDING_DIR(), f));
  const earlier = pending.filter((f) => f !== own).slice(0, own ? 4 : 5);
  const wanted = [...earlier, ...(own && existsSync(own) ? [own] : [])].sort((a, b) => basename(a).localeCompare(basename(b))); // names lead with the millisecond they were made
  // Claim: the payload's home path stays its name in the outcomes and the state.
  const claimed = [];
  for (const home of wanted) {
    const here = join(mine, basename(home));
    try { renameSync(home, here); } catch { continue; } // a sibling has it
    let payload;
    try { payload = JSON.parse(readFileSync(here, "utf8")); } catch { moveTo(here, DEAD_DIR()); continue; }
    claimed.push({ home, here, payload });
  }
  const newestOf = new Map(); // session → the newest payload's home in this run
  for (const { home, payload } of claimed) newestOf.set(payload.session_id, home);
  const outcomes = [];
  pruneDead();
  const clearedSessions = new Set();
  // After the run, once: payloads left under pending/ of every session whose
  // claim this run cleared — landed, or dropped as obsolete beside a newer one
  // — are claimed and posted now, with the pointer the state carries, rather
  // than by whichever hook run comes next: an end deferred behind the
  // checkpoint this run has just landed (second review pass), or behind an
  // older payload it has just dropped for that end (fourth review pass).
  const followUps = () => {
    // Not what this run has itself returned to pending/ — a failed post, a
    // deferral — which would be retried at once and counted twice (third
    // review pass); at most five, the run's own bound.
    const done = new Set(outcomes.map((o) => o.file));
    const next = [];
    for (const sid of clearedSessions) {
      for (const p of sessionPayloads(sid).filter((q) => q.pid === null && !done.has(q.path)).sort((x, y) => x.name.localeCompare(y.name))) {
        if (next.length >= 5) break;
        const here = join(mine, p.name);
        try { renameSync(p.path, here); } catch { continue; }
        let payload;
        try { payload = JSON.parse(readFileSync(here, "utf8")); } catch { moveTo(here, DEAD_DIR()); continue; }
        next.push({ home: p.path, here, payload });
        newestOf.set(sid, p.path);
      }
    }
    if (next.length) log(`following up: ${next.length} payload(s) of ${[...new Set(next.map((n) => n.payload.session_id))].join(", ")} waited under pending/ behind a claim this run cleared`);
    return next;
  };
  const queue = [...claimed];
  let followed = false;
  try {
    for (;;) {
      if (!queue.length) {
        if (followed) break;
        followed = true;
        queue.push(...followUps());
        if (!queue.length) break;
      }
      const { home, here, payload, retaken } = queue.shift();
      const file = home;
      try { const now = new Date(); utimesSync(mine, now, now); } catch { /* the claim is judged by its age; a touch that fails leaves it judged from the last one */ }
      // Whether a newer summary of the session exists anywhere — this run holds
      // a newer payload, the state records a later one, a newer payload has
      // landed owed its bookkeeping, or a newer one is in another live child's
      // hands about to post, cumulative over this one — is ONE question, asked
      // before stepping aside and again before posting (third and fourth review
      // passes: asked in parts, the parts disagreed).
      const newestHere = newestOf.get(payload.session_id) === home;
      const outdated = (state) => !newestHere || recordedAfter(state, payload.prepared_at) || landedAfter(payload.session_id, basename(here)) || newerInFlight(payload.session_id, basename(here));
      // An earlier payload of the session that another child is still posting
      // lands first (SMD-2035): this one steps aside at once — back under
      // pending/, where the run that lands the predecessor follows up with it,
      // and the next hook run failing that — and the pointer it will carry
      // comes from the state that landing writes. It does not wait: the first
      // cut polled for up to a request's timeout under a budget the run shared,
      // and four review passes found their defects in that budget, while the
      // follow-up posts the payload as soon as the wait would have (fourth
      // review pass). A payload that has landed, or that is outdated, steps
      // aside for no one.
      const ahead = payload.captured_id || outdated(readState(payload.session_id)) ? [] : aheadOf(payload.session_id, basename(here));
      if (ahead.length) {
        moveTo(here, PENDING_DIR());
        // Between the look and that move the predecessor may have landed and
        // run its follow-up over a pending/ that did not yet hold this payload
        // (third review pass). One more look: if the claim has cleared, the
        // payload is taken back and posted now — once — unless the landing run
        // got to it first, in which case that run posts it.
        if (!retaken && !aheadOf(payload.session_id, basename(here)).length) {
          try { renameSync(home, here); queue.unshift({ home, here, payload, retaken: true }); continue; } catch { /* the landing run has it */ }
        }
        const why = `the session's earlier post is in flight (pid ${ahead[0].pid}); kept under pending/ for the run that lands it`;
        log(`deferred session=${payload.session_id} — ${why}`);
        outcomes.push({ file, ok: false, deferred: true, error: `deferred: ${why}` });
        continue;
      }
      const state = readState(payload.session_id);
      const stateIsNewer = recordedAfter(state, payload.prepared_at);
      // A payload that already LANDED is never obsolete: its id must reach the
      // state, and the newer payload behind it must supersede it (sixth review
      // pass: judged obsolete beside a newer one, the id was lost and two
      // summaries stood). One whose session has a NEWER landed payload owed its
      // bookkeeping is obsolete though the state is silent (second review pass:
      // an old checkpoint posted as "continuing" after the end had landed).
      const obsolete = !payload.captured_id && outdated(state);
      if (obsolete) {
        clearedSessions.add(payload.session_id);
        moveTo(here, DEAD_DIR());
        log(`obsolete session=${payload.session_id} — a later capture of the session has a summary; this one is not posted`);
        outcomes.push({ file, ok: false, obsolete: true, error: "obsolete: a later capture of the session has a summary" });
        continue;
      }
      // The pointer is decided when the payload POSTS, not when it was prepared:
      // the session's newest landed thought — what the state records NOW, or a
      // landed payload whose bookkeeping is owed — else what prepare saw. The state only moves forward, so a pointer from
      // prepare time is stale the moment the state names another id — a payload
      // prepared before its predecessor landed pointed past it, and two
      // summaries stood (seventh and eighth review passes).
      if (!payload.captured_id) payload.supersedes = pointerFor(payload.session_id, basename(here), state) ?? payload.supersedes;
      // A pointer the server has kept failing on — its registry away for good,
      // its audit table unreadable — must not take the summary down with it:
      // on the last attempt it is dropped and the summary lands (seventh review
      // pass). Judged by the failures counted ON the pointer, not by the word
      // in the last error: a store error quoting `p_supersedes` dropped it with
      // a note that lied, and a run of pointer failures ending in one outage
      // still died (eighth review pass).
      const attemptsSoFar = payload.attempts ?? 0;
      const onPointer = payload.supersedes_failures ?? 0;
      // How long the payload has waited: prepared_at, else the millisecond in
      // its own name (written by this machine's clock). Read before the post,
      // so the last resort is taken on the payload's LAST chance — a pointer
      // failing once a day died of age at attempt three, never tried without
      // the pointer (twelfth review pass).
      const waited = Date.now() - (Date.parse(payload.prepared_at ?? "") || Number(basename(here).split("-")[0]));
      let lastResort = "";
      if (!payload.captured_id && payload.supersedes && onPointer > 0 && (attemptsSoFar >= 4 || waited > PENDING_MAX_AGE_MS)) {
        lastResort = `supersedes dropped: ${onPointer} of ${attemptsSoFar} attempts failed on it${waited > PENDING_MAX_AGE_MS ? ", the payload a week old" : ""}: ${oneLine(payload.last_error ?? "").slice(0, 120)}`;
        delete payload.supersedes;
      }
      let posted;
      try {
        // A payload that already landed (its bookkeeping failed last time) is not
        // posted again: the id is on the payload (second review pass — a local
        // fault after the capture counted as a failed attempt and re-posted).
        posted = payload.captured_id ? { id: payload.captured_id, note: payload.captured_note ?? "" } : await postCapture(cfg, payload);
      } catch (e) {
        payload.attempts = (payload.attempts ?? 0) + 1;
        payload.last_error = String(e.message ?? e).slice(0, 300);
        if (e.on === "supersedes") payload.supersedes_failures = (payload.supersedes_failures ?? 0) + 1;
        // Dead: the server refused the request as shaped, the key is unknown to
        // it, or the payload has waited a week. A connection or store failure is
        // kept however many times it has failed — a cap of five tries, spent one
        // per session end across one outage, lost the earliest sessions for good
        // while the header promised they would wait (eleventh review pass).
        // The key unknown to the server is the JSON-RPC code rpc() names, not the
        // word — a store's own "401 Unauthorized" quoted inside an `Error:` is an
        // outage to wait out (twelfth review pass).
        const dead = e.kind === "refused" || /JSON-RPC -32(?:001|60[12])\b/.test(payload.last_error) || (Number.isFinite(waited) && waited > PENDING_MAX_AGE_MS);
        try { writeJson(here, payload); } catch { /* the claim is gone from under us; nothing to update */ }
        moveTo(here, dead ? DEAD_DIR() : PENDING_DIR());
        log(`${dead ? "dead" : "pending"} session=${payload.session_id} attempt=${payload.attempts}${dead && waited > PENDING_MAX_AGE_MS ? ` waited=${Math.round(waited / 86_400_000)}d` : ""} error="${payload.last_error}"`);
        outcomes.push({ file, ok: false, error: payload.last_error, dead });
        continue;
      }
      const { id } = posted;
      clearedSessions.add(payload.session_id);
      const note = [posted.note, lastResort].filter(Boolean).join("; ");
      // The state is read AGAIN after the post: a sibling run may have landed a
      // newer summary of the session meanwhile, and a judgement made before the
      // post would move the state back to this older one (eighth review pass).
      const stateIsNewerNow = stateIsNewer || recordedAfter(readState(payload.session_id), payload.prepared_at);
      // Bookkeeping, apart from the post: the id goes onto the payload first, so a
      // fault here leaves a file the next run finishes without posting twice. A
      // landed payload whose session already records a NEWER summary is finished
      // without moving the state back to it (third review pass). The ORDER is
      // load-bearing: the state is written, then the claim is removed — a run
      // that stepped aside for this claim (aheadOf) reads the state the moment
      // the claim clears, and a claim cleared before the state was written
      // would leave it pointerless (SMD-2035, second review pass).
      try {
        if (!payload.captured_id) writeJson(here, { ...payload, captured_id: id, captured_note: note });
        // summary_at never runs ahead of the clock that will read it back.
        const summaryAt = payload.prepared_at && Date.parse(payload.prepared_at) <= Date.now() ? payload.prepared_at : new Date().toISOString();
        if (!stateIsNewerNow) writeState(payload.session_id, { thought_id: id, fingerprint: payload.fingerprint, captured_at: new Date().toISOString(), summary_at: summaryAt, harness: payload.harness, prompts: payload.prompts, sources: (payload.derived_from ?? []).length });
        unlinkSync(here);
        log(`captured session=${payload.session_id} harness=${payload.harness}${payload.event && payload.event !== "SessionEnd" ? ` event=${payload.event}${payload.trigger ? ` trigger=${payload.trigger}` : ""}` : ""} id=${id} sources=${(payload.derived_from ?? []).length}${payload.supersedes ? ` supersedes=${payload.supersedes}` : ""}${note ? ` note="${note}"` : ""}`);
        outcomes.push({ file, ok: true, id, note });
      } catch (e) {
        moveTo(here, PENDING_DIR());
        log(`captured session=${payload.session_id} id=${id} but the bookkeeping failed: ${String(e.message ?? e).slice(0, 200)} — the payload keeps the id for the next run`);
        outcomes.push({ file, ok: true, id, note: [note, "bookkeeping deferred"].filter(Boolean).join("; ") });
      }
    }
  } finally {
    // Anything still claimed (an unexpected throw) goes back; then the claim directory goes.
    try { for (const f of readdirSync(mine)) moveTo(join(mine, f), PENDING_DIR()); } catch { /* swept from under us: nothing left to return */ }
    try { rmdirSync(mine); } catch { /* gone */ }
  }
  return outcomes;
}

/** Hand the network half to a child that outlives this process; stdout/stderr go to the log. */
function detachPost(payloadPath) {
  ensureDirs();
  const fd = openSync(LOG_PATH(), "a", 0o600);
  const child = spawn(process.execPath, [SELF, "--post", payloadPath], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env },
  });
  child.unref();
  closeSync(fd);
  return child.pid;
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
  let value;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) { const v = args[i + 1] ?? ""; value = v.startsWith("--") ? "" : v; }
    else if (args[i].startsWith(`${name}=`)) { const v = args[i].slice(name.length + 1); value = v.startsWith("--") ? "" : v; } // `--event=--min-interval` is a value forgotten too (fifth review pass)
  }
  return value;
}
/** Whether a flag is present in either form. */
const has = (args, name) => flag(args, name) !== undefined;

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

export async function main(argv) {
  const args = argv.slice(2);
  const harness = flag(args, "--harness");
  // Exit 1, not 2: on a Stop hook 2 would block the assistant's turn over a typo in the command line (seventh review pass).
  if (harness !== undefined && !HARNESSES.includes(harness)) { console.error(`--harness takes ${HARNESSES.join(" or ")}, not "${harness}" (omit it: the transcript's first line says which)`); return 1; }
  if (has(args, "--print-hook")) {
    const h = flag(args, "--print-hook") || "claude-code";
    if (!HARNESSES.includes(h)) { console.error(`--print-hook takes ${HARNESSES.join(" or ")}, not "${h}"`); return 2; }
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
    let cfg;
    try { cfg = loadConfig(); } catch (e) { console.error(`session-capture: ${e.message}`); return 2; }
    let tools;
    try { tools = ((await rpc(cfg, "tools/list", {}, 15_000)).tools ?? []).map((t) => t.name).sort(); } catch (e) { console.error(`session-capture: ${cfg.url} did not answer tools/list — ${e.message}`); return 1; }
    if (tools.join() === "capture_thought") { console.log(`ok: ${cfg.url} answers, and the key sees capture_thought alone (capture scope). State: ${STATE_DIR}`); return 0; }
    if (!tools.includes("capture_thought")) { console.error(`session-capture: the key cannot capture — its surface is [${tools.join(", ")}]. Mint one with: bun server-portable/keygen.ts --name session-hook --scope capture`); return 1; }
    console.error(`warning: the key can capture, and it can also ${tools.filter((t) => t !== "capture_thought").join(", ")} — a leak of this file reads your brain. Prefer a capture-scoped key: bun server-portable/keygen.ts --name session-hook --scope capture`);
    return 0;
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
    const s = summariseTranscript(path, harness);
    if (!s.prompts.length) {
      const sniffed = sniffHarness(readFileSync(path, "utf8").split("\n", 5));
      console.log(`--- would SKIP: no human prompt in ${path} (a compaction, or a transcript with only tool traffic${harness && harness !== sniffed ? `; note: --harness ${harness} was given but the first line says ${sniffed}` : ""})`);
      return 0;
    }
    if (ev) s.checkpoint = checkpointOf({ hook_event_name: ev, trigger });
    const text = renderSummary(s);
    const findings = scanSummary(s, text);
    const ids = provenanceOf(s);
    console.log(text);
    console.log(`\n--- would send: source=${s.harness}, derived_from=${ids.length} id(s)${ids.length ? ` [${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", …" : ""}]` : ""}`);
    if (findings.length) { console.log(`--- would REFUSE: ${findings.map((f) => `${f.reason} at char ${f.at}`).join(", ")}`); return 1; }
    console.log("--- secret scan: clean");
    return 0;
  }
  if (has(args, "--post")) {
    const file = flag(args, "--post");
    let cfg;
    try { cfg = loadConfig(); } catch (e) { log(`error: ${e.message}`); console.error(`session-capture: ${e.message}`); return 2; }
    const outcomes = await postPending(cfg, file || undefined);
    // Each outcome is already a timestamped line in the log, where this
    // process's stdout also lands when the hook spawned it; say it again only
    // to a terminal (first review pass: every line twice in the log).
    if (process.stdout.isTTY) for (const o of outcomes) console.log(o.ok ? `captured ${o.id}${o.note ? ` (${o.note})` : ""}` : o.deferred ? o.error : `not captured: ${o.error}${o.dead ? " (given up)" : " (kept for retry)"}`);
    return outcomes.some((o) => !o.ok && !o.obsolete && !o.deferred) ? 1 : 0;
  }

  // The hook itself: JSON on stdin. A terminal is not a hook — say so instead
  // of waiting on it for ever (ninth review pass).
  if (process.stdin.isTTY) { console.error("session-capture: expected the hook's JSON on stdin (a harness pipes it). By hand: --print-hook [claude-code|codex], --check, --dry-run <transcript>, --post <payload>."); return 2; }
  let hook;
  try { hook = JSON.parse(await readStdin()); } catch (e) { console.error(`session-capture: stdin is not the hook's JSON (${e.message})`); return 1; }
  // A hook takes two flags. Any other — `--event` or `--trigger`, which are
  // the by-hand forms' and whose values the harness sends on stdin, or a
  // misspelt `--min-intervall` that would capture every turn — would change
  // nothing and say nothing (fourth and fifth review passes). Exit 1, never 2:
  // a Stop hook's 2 blocks the turn.
  const HOOK_FLAGS = ["--harness", "--min-interval"];
  for (const a of args) {
    if (!a.startsWith("--") || HOOK_FLAGS.includes(a.split("=")[0])) continue;
    const name = a.split("=")[0];
    log(`error: ${name} is not a hook flag`);
    console.error(`session-capture: ${name} is not a hook flag — a hook takes ${HOOK_FLAGS.join(" and ")}; the event and the trigger come from the harness on stdin — remove it from the command; nothing captured`);
    return 1;
  }
  const { minInterval: hookInterval, error: intervalError, raw: intervalRaw } = intervalFlag(args, { aboveZero: false });
  if (intervalError) { log(`error: --min-interval "${intervalRaw}" is not a number of minutes`); console.error(`session-capture: ${intervalError}; nothing captured`); return 1; }
  const minIntervalMin = hookInterval ?? 0;
  // The config is checked FIRST, before a payload exists: a hook pasted before
  // the config is written would otherwise queue one payload per session end
  // for as long as the config is missing, and post them all, stale, when it
  // appears (fifth review pass).
  let cfg;
  try { cfg = loadConfig(); } catch (e) { log(`error: ${e.message}`); console.error(`session-capture: ${e.message}`); return 1; }
  let prepared;
  try { prepared = prepare(hook, { minIntervalMin, harness }); } catch (e) { log(`error: ${e.message}`); console.error(`session-capture: ${e.message}`); return 1; }
  if (prepared.code !== 0) { log(prepared.message); console.error(`session-capture: ${prepared.message}`); return prepared.code; }
  if (!prepared.payloadPath) { log(prepared.message); console.error(`session-capture: ${prepared.message}`); return 0; }
  if (process.env.OB1_SESSION_CAPTURE_SYNC === "1") {
    // The run's own outcome, by file — oldest-first posting puts stranded
    // payloads before it (third review pass: `[o]` read the first outcome).
    const o = (await postPending(cfg, prepared.payloadPath)).find((x) => x.file === prepared.payloadPath);
    if (!o) { console.error("session-capture: another run took this payload (to post it, or as obsolete beside a newer one)"); return 0; } // two runs at once (fourth review pass)
    console.error(`session-capture: ${o.ok ? `captured ${o.id}` : o.obsolete ? `skip: ${o.error}` : o.deferred ? o.error : `not captured: ${o.error}`}`);
    return o.ok || o.obsolete || o.deferred ? 0 : 1;
  }
  const pid = detachPost(prepared.payloadPath);
  log(`${prepared.message} → posting in pid ${pid}`);
  return 0;
}

// Run as the entry point — argv[1] resolved through any symlink (sixth review
// pass: a hook installed through ~/bin compared the link with the real path,
// never ran, and exited 0 saying nothing).
const invokedAs = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : ""; } catch { return process.argv[1] ?? ""; } })();
if ((invokedAs && SELF === invokedAs) || (typeof Bun !== "undefined" && Bun.main === SELF)) {
  main(process.argv).then((code) => process.exit(code), (e) => { console.error(`session-capture: ${e?.message ?? e}`); process.exit(1); });
}
