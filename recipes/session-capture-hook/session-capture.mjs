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
import { join, basename, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { UUID, clip, oneLine, sha256, shownUrl } from "./lib/util.mjs";
import { CLAIM_MAX_AGE_MS, CONFIG_PATH, DEAD_DIR, DEAD_MAX_AGE_MS, HOME, INFLIGHT_DIR, LOG_PATH, PENDING_DIR, PENDING_MAX_AGE_MS, SELF, STATE_BASE, STATE_DIR, claim, ensureDirs, isAlive, lastAttemptMs, listPayloads, log, moveTo, pruneDead, readState, release, sessionPayloads, statePath, sweepInflight, useSelf, useStateRoot, writeJson, writeState } from "./lib/state.mjs";
import { SECRET_MODES, SECRET_PATTERNS, countRedactions, describeRedactions, redactSecrets, redactionMarker, scanForSecrets, secretMode } from "./lib/secrets.mjs";
import { CaptureError, REFUSAL_RE, SDK_ERROR_RE, parseRpcBody, resultText, rpc, textOfResult } from "./lib/rpc.mjs";
import { BRAIN_NAME_RE, CONNECTOR_RE, endpointOf, loadBrains, loadConfig, splitUserinfo, urlSource } from "./lib/config.mjs";
import { CLAIMS_DIRNAME, UUID_ONLY_RE, checkClaims, claimFiles, noteAgentClaimCall, renewClaim, renewClaims, renewEveryMs, scrubTokens, worktreeRoot } from "./lib/claims.mjs";
// The exports that moved to lib/ (SMD-4338), re-exported so every name this file exported before is still its own: the suite,
// the agent runner, server-portable's suite and db/test-live.ts import from here.
export { CLAIMS_DIRNAME, CONFIG_PATH, CaptureError, REFUSAL_RE, SDK_ERROR_RE, SECRET_MODES, SECRET_PATTERNS, STATE_BASE, STATE_DIR, claimFiles, describeRedactions, endpointOf, loadBrains, loadConfig, parseRpcBody, readState, redactSecrets, redactionMarker, renewClaim, renewClaims, renewEveryMs, resultText, rpc, scanForSecrets, secretMode, shownUrl, splitUserinfo, useStateRoot, worktreeRoot };

// This file, by its own url: the path its detached children re-run and its guard compares (lib/state.mjs, SELF).
useSelf(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * The hook's version, the one source of it (SMD-4378). It is a constant, not a
 * read of `metadata.json`, because an installed hook may be a copy of this
 * file and its lib/, without the recipe's other files. The suite fails if it
 * differs from `metadata.json`'s. `--version`
 * prints it, `--check` and `--dry-run` name it first, and each summary carries
 * it as `metadata.hook_version`: the hook that prepared the payload, whose
 * rules wrote its derived text and header. A model's summary is written when
 * the payload is sent, which a later hook may do; its stamp names the hook
 * that prepared the model's input.
 */
export const HOOK_VERSION = "1.11.1";
/** A version's shape, three numbers: the only stamp `postCapture` sends. The suite holds HOOK_VERSION to it. */
export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** Caps on what the summary carries. The text is one thought; the server chunks long ones, but a summary is meant to be read whole. */
export const LIMITS = {
  prompts: 12,          // human prompts listed
  promptChars: 200,     // per prompt
  outcomeChars: 1500,   // the assistant's last message
  sessionIdChars: 120,  // the id in the closing line — a uuid is 36; bounded so the closing lines never outgrow the cap (fifth review pass)
  files: 20,            // file paths named
  textChars: 6000,      // the whole summary
  derived: 60,          // provenance ids sent (the server validates each; a long list is a long validation)
  modelMsgs: 30,        // assistant messages kept per episode for an opt-in model summary (SMD-2014): the most recent, decisions land late
  modelInputChars: 12000, // the assistant text handed to the model, tail-clipped
};

/** The tools a capture-scoped key is given (server-portable/tools.ts's capture group): --check's word for "a capture key". */
const CAPTURE_SURFACE = new Set(["capture_thought", "set_priority", "clear_priority", "open_item", "update_item", "set_item_status", "propose_item_close", "decide_item_close"]);
/**
 * The brain's tool names — only THEIR results are read for thought ids, so a uuid printed by some other tool is never claimed as provenance.
 * Not thought_stats: it prints no thought id, and each row of it starts with a type, topic or person, so a tag reading `ID: <uuid>` would read as one (SMD-2510, review pass 2).
 */
const BRAIN_TOOLS = ["search_thoughts", "search_thoughts_keyword", "list_thoughts", "list_supersession_proposals", "capture_thought", "update_thought"];
/** The two names every connector has (the MCP connector spec's pair): the brain's only under a server whose name says `brain` (eighth review pass — a Notion or Linear `search` prints uuid-shaped ids too). */
const GENERIC_TOOLS = ["search", "fetch"];
// The tool's own name after an MCP-style separator (`mcp__open-brain__search_thoughts`, `server/search`, `server.search`), or bare.
// `_` is NOT a separator on purpose: `web_search` must not read as the brain's `search`.
// `brain` as a word of the server's name (open-brain, my_brain, brain), not a
// substring: a `brainstorm` server's search is not the brain's (ninth review pass).
const BRAIN_TOOL_RE = new RegExp(`(?:(?:^|__|[/.:])(?:${BRAIN_TOOLS.join("|")})|^(?:[^]*[^a-z0-9])?brain(?:[^a-z0-9][^]*)?(?:__|[/.:])(?:${GENERIC_TOOLS.join("|")}))$`, "i");
// `ID: <uuid>` is how every read tool prints a thought's id (SMD-1248); a capture answers `Captured as … — id <uuid>`.
// Each at a line's start, as the server prints it: a thought's text is fenced (`│ ` before its every
// line, SMD-2483), so an id line its text quotes is not one, and is never claimed as provenance.
const RETRIEVED_ID_RE = new RegExp(`^[ \\t]*ID:\\s*(${UUID})\\b`, "gim");
const CAPTURED_ID_RE = new RegExp(`^Captured as [^\\n]*?\\bid (${UUID})\\b`, "gim");
/** Tool names whose input names a file the session changed (Claude Code). */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ── Small helpers ────────────────────────────────────────────────────────────

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

/** One of the brain's prose tools by name — not a generic `search`/`fetch`, whose JSON text is a thought's own, unfenced. */
const PROSE_TOOL_RE = new RegExp(`(?:^|__|[/.:])(?:${BRAIN_TOOLS.join("|")})$`, "i");

/**
 * A brain tool's reply as the harness recorded it: its text, or — where a
 * prose tool's record is the JSON of its result (structuredContent,
 * `{ …, text }`, or a content-block list, SMD-2283) — the text inside it, with
 * its real line breaks, which the line-anchored id patterns need (SMD-2483,
 * review pass 2). A generic `fetch`'s JSON is left as it was: its `text` is
 * the thought's own, which no fence guards.
 */
function replyText(text, name) {
  const t = text.trimStart();
  if ((t[0] !== "{" && t[0] !== "[") || !PROSE_TOOL_RE.test(name)) return text;
  try { return textOfBlocks(JSON.parse(t)) || text; } catch { return text; }
}

function textOfBlocks(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content) && typeof content.text === "string") return content.text; // one block, not a list
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b === "string" ? b : (b?.type === "text" || b?.type === "input_text" || b?.type === "output_text") ? String(b.text ?? "") : "")).filter(Boolean).join("\n");
}

/** An empty summary — the session's (n = 0) or one episode's (n ≥ 1) — filled by the segmenter from either parser's events. */
function emptySummary(n = 0) {
  // `cwd` and `branch` are where the session ENDED; `roots` every directory it
  // ran in (a session that moves between worktrees has several), so a file under
  // any of them is inside the project.
  // `checkpoint` is set by prepare() from the hook event (checkpointOf); a
  // transcript read for --dry-run or a test has none, and renders no such line.
  // `n` is the episode's ordinal (0: the whole session), `named` the tickets
  // its asks name in first-mention order, `about` the tickets it is the work
  // of (its opening ask's, its first ask's, its home's), `opened` and `closed`
  // the boundaries at its ends, and `episodes` — the session's alone — its
  // pieces (SMD-2013).
  // `assistant` holds the episode's assistant messages, the most recent kept
  // (LIMITS.modelMsgs), for the opt-in model summary alone (SMD-2014); it never
  // reaches a derived payload, so a session with the option off is byte-identical.
  return { harness: "", sessionId: "", title: "", cwd: "", branch: "", roots: new Set(), prompts: [], outcome: "", assistant: [], files: new Set(), commits: 0, prs: [], retrieved: new Set(), captured: new Set(), first: "", last: "", pushed: false, checkpoint: undefined, n, named: new Set(), about: new Set(), opened: undefined, closed: undefined, episodes: [] };
}

/**
 * User lines that are not a human ask: the summary Claude Code writes in the
 * human's voice when it compacts a long session — an episode boundary
 * (SMD-2013) — and a bare slash command.
 */
const COMPACTION_RE = /^This session is being continued from a previous conversation/i;
// A BARE slash command (`/compact`) is the harness's, not an ask; one with
// arguments (`/code-review high`, `/implement the hook`) is what the human asked
// (twelfth review pass: the rule matched the leading word and dropped the rest).
const NOT_ASKED_RE = /^\/[a-z][\w-]*\s*$/i;

/**
 * Claude Code's ~/.claude/projects/<slug>/<session>.jsonl — one JSON object per
 * line; the shape is internal and changes, so every read here is tolerant. Both
 * parsers emit EVENTS in transcript order — `{ t, … }`, one per fact the
 * summary needs — and `segment` folds them into the session and its episodes
 * (SMD-2013). A line's events come as time, directory, branch, then content:
 * the directory and branch a line records are where its content happened.
 */
export function parseClaudeCode(lines, s) {
  const toolNames = new Map(); // tool_use id → name
  const events = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    if (o.isSidechain === true) continue; // a subagent's turns are not this session's asks
    if (!s.sessionId && typeof o.sessionId === "string") s.sessionId = o.sessionId;
    if (o.type === "ai-title" && typeof o.aiTitle === "string") { events.push({ t: "title", text: o.aiTitle }); continue; }
    if (o.type === "pr-link" && typeof o.prUrl === "string") { events.push({ t: "pr", url: o.prUrl }); continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (typeof o.timestamp === "string") events.push({ t: "time", at: o.timestamp });
    if (typeof o.cwd === "string" && o.cwd) events.push({ t: "cwd", v: o.cwd });
    if (typeof o.gitBranch === "string" && o.gitBranch) events.push({ t: "branch", v: o.gitBranch });
    const content = o.message?.content;
    if (o.type === "assistant") {
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === "tool_use") {
          toolNames.set(b.id, String(b.name ?? ""));
          const input = b.input ?? {};
          if (EDIT_TOOLS.has(b.name) && typeof (input.file_path ?? input.notebook_path) === "string") events.push({ t: "file", path: input.file_path ?? input.notebook_path });
          if (b.name === "Bash" && typeof input.command === "string") {
            if (/\bgit\s+commit\b/.test(input.command)) events.push({ t: "commit" });
            if (/\bgit\s+push\b/.test(input.command)) events.push({ t: "push" });
          }
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          events.push({ t: "outcome", text: b.text }); // the last text block of the last assistant line wins
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
      events.push({ t: "ids", text: replyText(textOfBlocks(r.content), name) });
    }
    if (results.length) continue;
    // The compaction summary: the harness's own flag — read before the origin
    // gate, whoever the line is from — or the sentence it opens with, which a
    // transcript copied by a tool that dropped the flag still carries.
    if (o.isCompactSummary === true) { events.push({ t: "compaction" }); continue; }
    if (o.origin && o.origin.kind && o.origin.kind !== "human") continue;
    const text = stripInjected(textOfBlocks(content));
    if (COMPACTION_RE.test(text)) { events.push({ t: "compaction" }); continue; }
    if (text && !NOT_ASKED_RE.test(text)) events.push({ t: "prompt", text });
  }
  return segment(events, s);
}

/** Codex's ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — {timestamp, type, payload} per line; events as parseClaudeCode emits them. */
export function parseCodex(lines, s) {
  const calls = new Map(); // call_id → { name, input }
  const events = [];
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const p = o?.payload;
    if (!p || typeof p !== "object") continue;
    if (typeof o.timestamp === "string") events.push({ t: "time", at: o.timestamp });
    if (o.type === "session_meta") {
      s.sessionId ||= String(p.id ?? p.session_id ?? "");
      if (typeof p.cwd === "string" && p.cwd) events.push({ t: "cwd", v: p.cwd });
      continue;
    }
    if (o.type === "turn_context") { if (typeof p.cwd === "string" && p.cwd) events.push({ t: "cwd", v: p.cwd }); continue; }
    if (o.type === "event_msg") {
      // A turn's closing message is its outcome; an assistant message after it (a turn still running at the end) is the later word.
      if (p.type === "task_complete" && typeof p.last_agent_message === "string" && p.last_agent_message.trim()) events.push({ t: "outcome", text: p.last_agent_message });
      continue;
    }
    if (o.type !== "response_item") continue;
    if (p.type === "message") {
      const text = textOfBlocks(p.content);
      if (p.role === "user") { const t = stripInjected(text); if (COMPACTION_RE.test(t)) events.push({ t: "compaction" }); else if (t) events.push({ t: "prompt", text: t }); }
      else if (p.role === "assistant" && text.trim()) events.push({ t: "outcome", text });
      continue;
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = String(p.name ?? "");
      const raw = p.type === "function_call" ? p.arguments : p.input;
      calls.set(p.call_id, { name, raw });
      if (name === "apply_patch" || /apply_patch/.test(name)) {
        for (const m of String(raw ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) events.push({ t: "file", path: m[1].trim() });
      } else if (name === "shell" || name === "exec_command" || name === "container.exec") {
        let cmd = ""; try { const a = JSON.parse(String(raw)); cmd = Array.isArray(a.command) ? a.command.join(" ") : String(a.command ?? a.cmd ?? ""); } catch { cmd = String(raw ?? ""); }
        if (/\bgit\s+commit\b/.test(cmd)) events.push({ t: "commit" });
        if (/\bgit\s+push\b/.test(cmd)) events.push({ t: "push" });
      }
      continue;
    }
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const call = calls.get(p.call_id);
      if (!call || !BRAIN_TOOL_RE.test(call.name)) continue;
      events.push({ t: "ids", text: replyText(textOfBlocks(p.output) || String(p.output ?? ""), call.name) });
    }
  }
  return segment(events, s);
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

// ── Episodes ─────────────────────────────────────────────────────────────────

/**
 * A ticket key as a branch name or an ask spells it — `SMD-2013`, `smd-2013`:
 * two to five letters, a dash, two to six digits. Not the shapes that look
 * like one and are not (a digest's name, an encoding, a standard, a PR
 * number, a cipher). In an ASK, once the session's branches or directories
 * have named a team (`teams`), only that team's keys count, in any case —
 * `node-22`, `port-8010` and `AES-256` are spelled the same way, and split a
 * session on `main` (first and second review passes); before any team is
 * known, an upper-case key counts, since it is the only way a session with no
 * keyed branch names its work.
 */
const TICKET_RE = /\b([A-Za-z]{2,5})-(\d{2,6})\b/g;
// The brain's own denied prefixes (server-portable/subject.ts's NOT_TICKET_PREFIXES) are here too, those this shape can
// match: a branch's first word the brain denies would else be its ticket here and none there (SMD-4291's review pass 2:
// `es-2015-target-smd-610` named ES-2015, and the asked smd-610 lost its team).
export const NOT_TICKETS = new Set(["SHA", "UTF", "ISO", "RFC", "CVE", "IPV", "TLS", "SSL", "HTTP", "PR", "MD", "AES", "RSA", "GPT", "ED", "HTML",
  "IEEE", "CWE", "WCAG", "GPL", "LGPL", "AGPL", "FSL", "BSD", "MPL", "CC", "ES", "COVID", "FY"]);
/** The ticket keys a text names, upper-cased, in first-mention order; with `teams`, under the rule for an ask. */
export function ticketsIn(text, teams) {
  const out = [];
  for (const m of String(text ?? "").matchAll(TICKET_RE)) {
    const team = m[1].toUpperCase(), id = `${team}-${m[2]}`; // `team`, not `key`: Daemonic Brain's credential-compare check reads a `key` under an equality operator as a secret compared, comments included
    if (NOT_TICKETS.has(team) || out.includes(id)) continue;
    if (teams && (teams.size ? !teams.has(team) : m[1] !== team)) continue;
    out.push(id);
  }
  return out;
}
/**
 * The tickets an ask names, read with its secrets blanked (SMD-4292): a ticket-shaped value a secret holds
 * (`password=ABC-1234`) is no ticket. Read off the raw ask, it headed the summary while the ask that held it was
 * blanked, the brain keyed it as a subject, it began an episode ("begun with ABC-1234") and it decided where the
 * session split. Both readers of an ask's tickets, `named` and the segmenter's boundaries, go through here.
 * In both modes: under `refuse`, read raw, the secret split off an episode of its own, and the clean episode before it
 * was sent saying "ended when ABC-1234 was taken up" (review pass 1: limiting this rule to `redact` kept sending that
 * line). Read blanked, it splits nothing, and its episode is refused whole, as one holding `password=hunter2` always
 * was. A real ticket the scan takes for a secret (`Password: SMD-12 (reset flow)`) is dropped too: its ask is blanked
 * in the text as well.
 * The ask is blanked on one line, as `redactEpisode` blanks each prompt: blanked as written, a quoted secret whose
 * closing quote is on the next line (`password = "hunter22⏎QQZ-9876"`) was cut at its first space, and its
 * ticket-shaped part headed the summary while the prompt showed it blanked (review pass 1, secrets adversary).
 * Only tickets the raw ask names, read with the same teams, are kept: blanking can join a word to its marker into a
 * ticket shape (`XY-12` before a Slack webhook's URL; review pass 1, cold read), and a lower-case mention of that key
 * before any team is known is no ticket (review pass 3, mutant).
 * The cost: the scan runs once per ask, cached per event (the segmenter and the episode both read it), and only for an
 * ask whose raw text names a ticket: about 20 ms per MB of such asks, nothing for an ask naming none.
 */
const blankedAsks = new WeakMap();
const askTickets = (ev, teams) => {
  const raw = ticketsIn(ev.text, teams);
  if (!raw.length) return [];
  let text = blankedAsks.get(ev);
  if (text === undefined) { text = redactSecrets(oneLine(ev.text)).text; blankedAsks.set(ev, text); }
  return ticketsIn(text, teams).filter((id) => raw.includes(id));
};
/**
 * A place's own tickets (SMD-4291): the first ticket-shaped word of `text` is the place's ticket, and the other keys of
 * its team are tickets beside it (`smd-610-and-smd-611`); a word of another team is the place's description, no ticket
 * and no team (`node-22` of `smd-610-bump-node-22`). Before, every ticket-shaped word of a branch or a directory was a
 * ticket of the place and taught its team, so on `smd-610-bump-node-22` an ask's `node-22` headed the summary.
 */
const ownTickets = (text) => {
  const [first] = ticketsIn(text);
  return first ? ticketsIn(text, new Set([first.split("-")[0]])) : [];
};
/** A branch's own tickets: read whole, its first ticket-shaped word the place's (`feature/smd-55-x`). */
const branchTickets = (branch) => ownTickets(branch);
/**
 * A directory's own tickets: those of its deepest part that names one, a worktree's or a project's own name before a
 * parent's (`~/aoc-2024/smd-55-day1/src` is SMD-55's, not AOC-2024's; `~/aoc-2024/day1` is AOC-2024's). Split at either
 * slash, so a Windows path is read by its parts too (review pass 1, run-it: read whole, its parent's word won).
 */
const dirTickets = (cwd) => {
  const parts = String(cwd ?? "").split(/[\\/]/);
  for (let k = parts.length - 1; k >= 0; k--) { const own = ownTickets(parts[k]); if (own.length) return own; }
  return [];
};
/** The tickets of a place's change, a `cwd` or a `branch` event, as the event's kind reads them. */
const placeTickets = (t, v) => (t === "branch" ? branchTickets(v) : dirTickets(v));
/** The tickets a place — a branch and a directory — names: each one's own, the branch's first. */
const anchorOf = (cwd, branch) => [...new Set([...branchTickets(branch), ...dirTickets(cwd)])];
/** The tickets an episode is known by: those its asks named, and those its branch and its directory name. */
const knownTickets = (ep) => new Set([...ep.named, ...anchorOf(ep.cwd, ep.branch)]);
/** Anchored: the episode's branch or directory names a ticket — its work has a home, and a ticket an ask merely mentions does not end it. */
const anchored = (ep) => anchorOf(ep.cwd, ep.branch).length > 0;
/** Whether, before the next ask, the session moves to a branch or directory naming one of these tickets: then the ask that named them began that work, whatever branch it was typed on. */
const movesTo = (events, i, ids) => {
  for (let k = i + 1; k < events.length && events[k].t !== "prompt"; k++) {
    if ((events[k].t === "cwd" || events[k].t === "branch") && placeTickets(events[k].t, events[k].v).some((id) => ids.includes(id))) return true;
  }
  return false;
};

/** One parser event onto a summary — the session's, or an episode's. */
function apply(x, ev, teams) {
  switch (ev.t) {
    case "time": if (!x.first) x.first = ev.at; x.last = ev.at; break;
    case "cwd": x.cwd = ev.v; x.roots.add(ev.v); break;
    case "branch": x.branch = ev.v; break;
    case "prompt": x.prompts.push(ev.text); for (const id of askTickets(ev, teams)) x.named.add(id); break;
    case "outcome": x.outcome = ev.text; x.assistant.push(ev.text); if (x.assistant.length > LIMITS.modelMsgs) x.assistant.shift(); break; // `outcome` is the last, for the derived text; `assistant` keeps the recent window for the model (SMD-2014)
    case "file": x.files.add(ev.path); break;
    case "commit": x.commits++; break;
    case "push": x.pushed = true; break;
    case "pr": if (!x.prs.includes(ev.url)) x.prs.push(ev.url); break;
    case "ids": harvestIds(ev.text, x); break;
    case "title": x.title = ev.text; break;
    default: break; // a compaction is a boundary, nothing of the summary's
  }
}

/**
 * The segmenter (SMD-2013): the parser's events, in transcript order, folded
 * into the session's summary `s` and into `s.episodes`, one per piece of work.
 * The session's PLACE — its branch and directory, `loc` — is followed on every
 * line; an episode's place (`cwd`, `branch`, `roots`) is where it runs, and a
 * move away from it is applied to the episode the next ask opens, never to
 * the one it ends (first review pass: the ended episode was labelled — its
 * branch, its project, and when its asks named no ticket its TICKET — with
 * the place the session moved to). An episode ENDS, and the next begins at
 * the next ask:
 *   - at a compaction — the harness's summary line;
 *   - when the session is on another branch at that ask, or, with no branch to
 *     go by, in a directory inside none of the episode's roots — a cd within
 *     the checkout is no move, nor is one out of it with the branch unchanged
 *     (the harness records the shell's directory per command), nor a move the
 *     session came back from before the ask, nor a detached HEAD mid-rebase;
 *   - at an ask that names a ticket none of the episode's asks, its branch or
 *     its directory named — unless the episode's branch or directory names a
 *     ticket (the work has a home; a mention does not end it), in which case
 *     only if the session then moves to a branch or directory naming the new
 *     ticket before the next ask: the ask began that work.
 * A move to a place that names a ticket the episode is ABOUT — its opening
 * ask's, its first ask's, its home's — is the episode's own, since the branch
 * is made a few lines after the ask that names its ticket; and when the
 * episode is about nothing yet, such a move names the work instead of ending
 * it. A ticket an ask merely mentioned makes no later move its own (first
 * review pass: a plan mentioned the next ticket, and the move to its branch
 * never ended the episode). Work between a boundary and the next ask — the
 * assistant finishing after a compaction, or after the move — belongs to the
 * ask that caused it. A compaction and a move between two asks are both
 * recorded. So a boundary is fixed once written: appending to the transcript
 * never moves an earlier one, and an episode's ordinal, text and fingerprint
 * stand — an episode captured and unchanged is skipped, and only the one that
 * changed supersedes its own earlier summary. The one boundary decided by
 * what FOLLOWS is the ask that names a new ticket under an anchored episode:
 * until the move to that ticket's branch is written — or the next ask, which
 * settles it the other way — the ask is the earlier episode's, and a
 * checkpoint taken in that window is superseded by that episode's own next
 * summary, on its own chain. Episodes without an ask are not episodes.
 */
const STAMPED = new Set(["prompt", "outcome", "file", "commit", "push", "pr", "ids"]); // the events that carry a line's time onto an episode: its span is that of its content, so an episode closed at an ask does not reach to that ask's line
export function segment(events, s = emptySummary()) {
  // The team prefixes the session's branches and directories (not a folder
  // of a checkout: `placeOf`) have named SO FAR: what a lower-case key in
  // an ask may be a ticket of. Gathered as the
  // walk goes, never ahead of it — a branch made later would make an earlier
  // mention a key and move a boundary already captured (second review pass).
  const teams = new Set();
  const learnTeams = (t, v) => { for (const id of placeTickets(t, v)) teams.add(id.split("-")[0]); }; // the team of a branch's or a directory's own ticket, not of every word (SMD-4291)
  const episodes = [];
  let cur, lineAt = "", compacted = false; // the open episode; the current line's time; a compaction since the episode's last ask
  const loc = { cwd: "", branch: "" }; // where the session IS, against where the episode runs
  const branchMoved = () => Boolean(loc.branch && cur.branch && loc.branch !== cur.branch);
  const below = (dir, root) => dir === root || dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`); // either slash: a Windows path too (SMD-4291's review pass 2)
  const inside = () => !loc.cwd || !cur.cwd || [...cur.roots].some((r) => below(loc.cwd, r)); // at or under a root: an ancestor of the checkout — HOME, ~/Projects — is not inside it (second review pass: it became the episode's directory, and every checkout under it was then inside)
  /** Away: the session is not where the episode runs — another branch, or with no branch to go by, a directory inside none of its roots. */
  const away = () => branchMoved() || (!(loc.branch && cur.branch) && !inside());
  /** The episode's top root a directory lies below: a root no other root contains. */
  const topOf = (dir) => { const roots = [...cur.roots]; return roots.find((r) => dir !== r && below(dir, r) && !roots.some((o) => o !== r && below(r, o))) ?? ""; };
  /**
   * What a directory below the episode's roots is, read from its parts below the top root. A part begins a checkout of
   * its own when it sits directly in a worktrees folder (a name ending `worktree` or `worktrees`, or `wt`, `.wt`, in any
   * case: `.claude/worktrees/smd-…`, `.worktrees`, `repo-worktrees`, a worktree named for no ticket among them), or when
   * it names a ticket and that ticket is the one `branch` names (`~/Projects/smd-55-day1` on `smd-55-day1`), or it is
   * the first part naming a ticket below HOME with `branch` naming none, or directly in a top root naming none by its
   * directory or `branch` (`~/Projects/smd-55-day1`). Any other part naming a ticket is a ticket-shaped folder of the
   * checkout it is in (`packages/node-22-compat`, `docs/smd-500-notes`). `kind` is "checkout" when the directory's deepest
   * part naming a ticket begins one, "folder" when it is a folder, "" when no part below the top root names one (`api`)
   * or it is in no root; `home` is the deepest checkout of its own at or above it, "" for the top root's (read when asked,
   * as the roots change: `placeAt`). A cd within the roots into a folder teaches its home's team, not the folder's; an
   * episode opened in a folder runs in its home. The cost: a ticket-shaped folder directly in a checkout naming no ticket
   * (`app/node-22-compat` on `main`) reads as a checkout of its own (SMD-4291's review passes 3 to 5).
   */
  const placeOf = (dir, branch) => {
    const top = topOf(dir);
    if (!top) return { kind: "", home: "" };
    const rel = dir.slice(top.length + 1).split(/[\\/]/), named = rel.map((part) => ownTickets(part).length > 0);
    const bt = branchTickets(branch), first = named.indexOf(true), k = named.lastIndexOf(true);
    const begins = (j) => (j > 0 && /worktrees?$|^\.?wt$/i.test(rel[j - 1]))
      || (named[j] && (bt.includes(ownTickets(rel[j])[0]) || (j === first && ((top === HOME && !bt.length) || (j === 0 && !anchorOf(top, branch).length)))));
    let end = -1;
    for (let j = 0; j <= k; j++) if (begins(j)) end = j;
    return { kind: k < 0 ? "" : k === end ? "checkout" : "folder", home: end < 0 ? "" : dir.slice(0, top.length + 1 + rel.slice(0, end + 1).join("/").length) };
  };
  // A directory's place is decided when the session first enters it below the roots, with the branch it has then, and
  // both readers (the team a cd teaches, the place an episode opens in) read that one answer: read again at a branch
  // move, `node-22-compat` was a folder to the episode it closed and a checkout to the next line (review pass 4, run-it).
  // A folder of the top root's checkout takes the current episode's top root as its home, never the one it was entered
  // under: a compaction there ran in `~/Projects` after the session had moved its episodes to `ob1` (review pass 5).
  const places = new Map();
  const placeAt = (dir, branch) => {
    const place = places.get(dir) ?? placeOf(dir, branch);
    if (place.kind) places.set(dir, place);
    return place.kind && !place.home ? { ...place, home: topOf(dir) || dir } : place;
  };
  /** The episode runs where the session is: its first directory names the project, a subdirectory does not. */
  const settle = () => {
    if (loc.cwd) { cur.roots.add(loc.cwd); if (!cur.cwd || !below(loc.cwd, cur.cwd)) cur.cwd = loc.cwd; }
    if (loc.branch) cur.branch = loc.branch;
  };
  /**
    * Whether a move to a place naming these tickets is the episode's own —
    * about one of them (the keys it opened and was asked with), or heading to
    * where it already runs (its home). An episode about nothing and with no
    * home yet takes the move's keys as its own. Its home is read LIVE, never
    * kept in `about`: once the episode has moved on, a move BACK to the branch
    * it began on is a new piece of work, not its own (second review pass: an
    * ex-home key lingered in `about`, and a return to the old branch was
    * absorbed).
    */
  const own = (names) => {
    const home = anchorOf(cur.cwd, cur.branch);
    if (names.some((id) => cur.about.has(id) || home.includes(id))) return true;
    if (cur.about.size || home.length || !names.length) return false;
    for (const id of names) cur.about.add(id);
    return true;
  };
  const open = (boundary) => {
    const next = emptySummary(episodes.length + 1);
    if (cur) cur.closed = boundary;
    next.opened = boundary;
    // An episode opened with the shell in a ticket-shaped folder (`placeOf`) runs in the checkout the folder is in: a
    // compaction, a new ticket or a branch move in `packages/node-22-compat` named NODE-22 as the new episode's place
    // (SMD-4291's review passes 2 to 4, cold read). Any other takes where the shell is, as before: a
    // folder naming nothing (`api`), a checkout of its own (a nested worktree), a place out of the roots.
    const place = boundary && cur?.cwd && loc.cwd && inside() ? placeAt(loc.cwd, loc.branch) : undefined; // the parser writes no empty branch: loc.branch is set whenever cur.branch is
    next.cwd = place?.kind === "folder" ? place.home : loc.cwd; next.branch = loc.branch;
    if (next.cwd) next.roots.add(next.cwd);
    if (boundary?.ticket) next.about.add(boundary.ticket); // the key it BEGAN with; its home is read live in `own` (second review pass)
    if (lineAt) next.first = next.last = lineAt;
    episodes.push(next); cur = next; compacted = false;
  };
  open(undefined);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    apply(s, ev); // the session's rollup names every key it mentioned; the episodes' `named` is team-gated
    if (ev.t === "time") { lineAt = ev.at; continue; } // the session's span is every line's; an episode's, its content's (below)
    if (ev.t === "title") { episodes[0].title = ev.text; continue; } // the harness titles the session from its first asks: the first episode's, whenever the line falls
    if (ev.t === "compaction") { if (cur.prompts.length) compacted = true; else cur.opened = { kind: "compaction" }; continue; }
    if (ev.t === "cwd" || ev.t === "branch") {
      if (ev.t === "branch" && ev.v === "HEAD") continue; // detached mid-rebase: the session is where it was
      loc[ev.t] = ev.v;
      // A cd within the episode's roots into a ticket-shaped folder (`placeOf`) teaches its home's team: a folder's
      // name is its checkout's, not a ticket's (review pass 1, run-it: `packages/node-22-compat` taught NODE), but this
      // repo's worktrees sit under its checkout, the branch still `main`, and a projects folder holds checkouts (review
      // pass 2; pass 3 made it the rule an episode's opening reads too).
      // The branch the line moves to when it records both, cwd first: the place is read with it (review pass 4, cold
      // read), and the pair is one move (below).
      const pairBranch = ev.t === "cwd" && events[i + 1]?.t === "branch" && events[i + 1].v !== "HEAD" ? events[i + 1].v : "";
      // A folder teaches its home's team: a nested worktree's `packages/node-22-compat` is that worktree's (review pass 5).
      const entered = ev.t === "branch" || !cur.cwd || !inside() ? undefined : placeAt(loc.cwd, pairBranch || loc.branch);
      if (entered?.kind === "folder") learnTeams("cwd", entered.home); else learnTeams(ev.t, ev.v);
      // A line writes its cwd then its branch, so the two are one move: read
      // the branch before judging the cwd, else a cwd-first return to the repo
      // root — a parent of the worktree it was in — settles onto the episode it
      // ends before its branch arrives (second review pass).
      if (pairBranch) { const nb = events[++i]; apply(s, nb); learnTeams("branch", nb.v); loc.branch = nb.v; }
      if (!cur.prompts.length) { settle(); continue; } // before the first ask, the episode is wherever the session is
      if (!branchMoved()) {
        if (inside()) settle(); // a cd within the checkout
        else if (!cur.branch && own(dirTickets(loc.cwd))) settle(); // no branch to go by: a directory naming the episode's ticket is its own
        // else: the shell out of the checkout on the same branch — the session's place stands; or, with no branch, a move the next ask decides
        continue;
      }
      if (own([...branchTickets(loc.branch), ...(inside() ? [] : dirTickets(loc.cwd))])) settle(); // a move to the episode's own place — judged by what changed: the branch, and the directory once it too has left the roots, in whichever order the line records them; else pending, decided at the next ask
      continue;
    }
    if (ev.t === "prompt") {
      const named = askTickets(ev, teams);
      if (cur.prompts.length) {
        const known = knownTickets(cur), fresh = named.filter((id) => !known.has(id));
        const moved = away();
        const fresh_ = named.length > 0 && fresh.length === named.length;
        const turned = fresh_ && (!anchored(cur) || movesTo(events, i, named));
        if (compacted || moved || turned) {
          const move = moved ? (branchMoved() ? { kind: "branch", to: loc.branch } : { kind: "directory", to: basename(loc.cwd) }) : undefined;
          // The new episode is "with" the ask's key only on the key's own evidence: the
          // key alone ended an episode with a home, or the session then moved to its
          // branch. An ask that names a key beside a compaction or a move may only be
          // mentioning it (second review pass: a review on main was "with SMD-2000",
          // and about it, so the move to SMD-2000's branch never began an episode).
          const began = fresh_ && (anchored(cur) ? movesTo(events, i, named) : !(compacted || moved));
          const b = { kind: compacted ? "compaction" : move ? move.kind : "ticket", ticket: began ? fresh[0] : undefined };
          if (move) { b.to = move.to; if (compacted) b.moved = move; }
          open(b);
        }
      }
      if (!cur.prompts.length && cur.n === 1) for (const id of named) cur.about.add(id); // the session's first ask says what its first episode is about: its keys (its home is read live in `own`); a later episode's opening ask says so only through `began`
      compacted = false;
    }
    if (lineAt && STAMPED.has(ev.t)) { if (!cur.first) cur.first = lineAt; cur.last = lineAt; }
    apply(cur, ev, teams);
  }
  s.episodes = episodes.filter((ep) => ep.prompts.length); // the first, before any ask, is the only one that can be empty
  for (const ep of s.episodes) { ep.harness = s.harness; ep.sessionId = s.sessionId; }
  return s;
}

/** The key an episode's summaries chain under: the session's own id for the first episode — a session of one episode is captured as before — and `<session id>#e<n>` after it. The state file and the payload names carry it sanitised. */
export const episodeChain = (sessionId, n) => (n > 1 ? `${sessionId}#e${n}` : sessionId);
/** The chain a payload belongs to: its own, or — a payload from before episodes — its session's. */
const chainOf = (j) => j?.chain_id ?? j?.session_id;

/** A move as the episode line says it. */
const moveText = (m) => `${m.kind === "branch" ? "branch " : ""}${clip(m.to ?? "", 80)}`;
/** The move a boundary carries: itself, or the one recorded beside a compaction. */
const moveOf = (b) => (b.kind === "compaction" ? b.moved : b.kind === "ticket" ? undefined : b);
/** How an episode began, for its line in the summary. */
const boundaryBegan = (b) => {
  const parts = [];
  if (b.kind === "compaction") parts.push("after a compaction");
  if (moveOf(b)) parts.push(`on the move to ${moveText(moveOf(b))}`);
  const base = parts.join(" and ");
  return b.ticket ? `${base}${base ? " " : ""}with ${b.ticket}` : base;
};
/** …and how it ended. */
const boundaryEnded = (b) => {
  const parts = [];
  if (b.kind === "compaction") parts.push("at a compaction");
  if (moveOf(b)) parts.push(`when the session moved to ${moveText(moveOf(b))}`);
  if (b.kind === "ticket") parts.push(`when ${b.ticket} was taken up`);
  return parts.join(" and ");
};

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

/** How a redaction or a refusal names a prompt: its place in the distinct list the text shows, and a word when it lies past the listed ones (second review pass of SMD-2127). */
function promptLabel(i) {
  return `prompt ${i + 1}${i >= LIMITS.prompts ? ` (past the ${LIMITS.prompts} the text lists)` : ""}`;
}

/** An ISO timestamp as the summary shows it: the day and the minute. */
const when = (iso) => iso.slice(0, 16).replace("T", " ");

/**
 * The tickets a summary's header lists, at most three, and where they came from: `asks`, those the episode's asks
 * named; else `place`, those its branch or directory names; null for none (SMD-2013). The capture sends `from` as
 * `metadata.tickets_from` (SMD-3306 PR 7a-3b-2): the brain's subject rule keys a session by its header's tickets, and
 * the text alone cannot say which kind of list it holds — the summary lists only 12 asks, each cut at 200
 * characters, and an ask in lower case before a team is known counts for none.
 */
export function headerTickets(s) {
  const named = s.named ? [...s.named] : [];
  if (named.length) return { tickets: named.slice(0, 3), from: "asks" };
  const place = anchorOf(s.cwd, s.branch).slice(0, 3);
  return { tickets: place, from: place.length ? "place" : null };
}

/**
 * Render the summary — the session's, or one episode's — as one thought.
 * Deterministic: the same transcript renders the same text, which is what the
 * fingerprint and the state compare; and an episode's text depends on nothing
 * after it (not on how many episodes follow), so a closed one never changes.
 */
export function renderSummary(s) {
  const project = s.cwd && s.cwd !== HOME ? basename(s.cwd) : ""; // a session in $HOME names no project (and not the user)
  // A transcript with no timestamp is "undated", never today: the clock would
  // change the fingerprint at midnight and the same session would be captured twice (ninth review pass).
  const day = s.last || s.first ? (s.last || s.first).slice(0, 10) : "undated";
  const prompts = distinctPrompts(s.prompts);
  // The tickets first (SMD-2013): those the asks named, else the one the branch
  // or the directory names — a search for the ticket lands on this episode.
  const tickets = headerTickets(s).tickets.join(", ");
  const head = ["Session summary", tickets, s.harness, project, s.branch ? `(${s.branch})` : "", day].filter(Boolean).join(" — ").replace(" — (", " (");
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
  // Which piece of the session this is, and what bounded it (SMD-2013): only
  // when there is something to say — a session of one episode reads as before.
  if (s.n > 1 || s.closed) tail.push(`Episode ${s.n} of the session${s.opened ? `, begun ${boundaryBegan(s.opened)}` : ""}${s.closed ? `, ended ${boundaryEnded(s.closed)}` : ""}.`);
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
  // Each prompt on its own (SMD-2127's first review pass): the redaction blanks
  // one prompt at a time, so a hit that existed only across the join —
  // `--password` ending one prompt, its value opening the next — was a refusal
  // no redaction could clear, at an offset into a join nobody sees.
  const sources = [...distinctPrompts(s.prompts).map((p, i) => [promptLabel(i), p]), ["the outcome", s.outcome ?? ""], ["the title", s.title ?? ""]];
  for (const [where, full] of sources) {
    for (const f of scanForSecrets(full)) if (!found.some((g) => g.reason.replace(/ in (?:prompt \d+(?: \(past the \d+ the text lists\))?|the outcome|the title)$/, "") === f.reason)) found.push({ ...f, reason: `${f.reason} in ${where}` });
  }
  return found;
}

/** The ids sent as derived_from: what the session retrieved, then what it captured, capped. */
export function provenanceOf(s) {
  return [...s.retrieved, ...s.captured].slice(0, LIMITS.derived);
}

/**
 * The episode's assistant messages, oldest of the kept window first, joined and
 * tail-clipped — the model's input beside the derived summary (SMD-2014). Never
 * tool results, never a human prompt, never the raw transcript: only what the
 * assistant itself wrote. Empty when the episode has no assistant text.
 */
export function assistantExcerpt(ep) {
  const joined = (ep.assistant ?? []).map((t) => String(t).trim()).filter(Boolean).join("\n\n----\n\n");
  return joined.length > LIMITS.modelInputChars ? joined.slice(-LIMITS.modelInputChars) : joined;
}

/**
 * An episode with its secrets blanked and its summary rendered from the
 * blanked sources — the prompts one by one, the outcome and the title, the
 * sources scanSummary reads whole — so a key a clip would cut in half is
 * blanked before the clip; then the rendered text once more, for what reaches
 * it from elsewhere (a path, a link). The episode given is not changed.
 * `redactions` names each span taken — its reasons, its offset in the source
 * it sat in — for the payload, the message and the log.
 */
export function redactEpisode(ep) {
  const redactions = [];
  const blocks = [];
  // A pasted key blob is found on the RAW sources: the summary flattens a
  // prompt's newlines (oneLine), so a multi-line block must be seen before that
  // — a key-material span crossing a newline is a blob the caller refuses
  // (SMD-2127 scope call). The blanking below runs on the flattened summary.
  const addBlocks = (raw, place) => { if (typeof raw === "string" && raw) for (const b of redactSecrets(raw).blocks) blocks.push({ reason: b.reasons.join(", "), in: place }); };
  for (const p of ep.prompts) addBlocks(p, "a prompt");
  addBlocks(ep.outcome, "the outcome");
  addBlocks(ep.title, "the title");
  const take = (text, place) => {
    if (typeof text !== "string" || !text) return text;
    const r = redactSecrets(text);
    for (const sp of r.spans) redactions.push({ reason: sp.reasons.join(", "), at: sp.at, in: place });
    return r.text;
  };
  // The DISTINCT prompts, as the summary lists them: a retried prompt is one
  // line in the text and one redaction in the count.
  // The title as the summary shows it, on one line, as the prompts are (SMD-4292 review pass 2, secrets adversary: blanked
  // as written, a quoted value whose closing quote is on the next line was cut there, and the rest shown).
  const redacted = { ...ep, prompts: distinctPrompts(ep.prompts).map((p, i) => take(p, promptLabel(i))), outcome: take(ep.outcome, "the outcome"), title: take(typeof ep.title === "string" ? oneLine(ep.title) : ep.title, "the title") };
  const text = take(renderSummary(redacted), "the text");
  return { ep: redacted, text, redactions, blocks };
}
/** The episode's summary as it would be sent under a mode: blanked and re-rendered, or as rendered. */
export function cleanEpisode(ep, onSecret) {
  return onSecret === "redact" ? redactEpisode(ep) : { ep, text: renderSummary(ep), redactions: [], blocks: [] };
}
/**
 * The gate over a cleaned episode, whatever the mode: any MULTI-LINE key block
 * — a pasted key blob the scope call refuses rather than redacts (SMD-2127) —
 * and the single-line secrets the scan still sees in the blanked sources and
 * the text (the net under the redaction). Returns a phrase per finding for the
 * refusal message; empty means the summary may be sent.
 */
export function gateFindings(cleaned, text) {
  const where = (cleaned.blocks ?? []).map((b) => `a multi-line key block (${b.reason}) in ${b.in}`);
  for (const f of scanSummary(cleaned.ep, text)) where.push(`${f.reason} at char ${f.at}`);
  return where;
}

// ── Posting over MCP ─────────────────────────────────────────────────────────

/**
 * Whether a refusal is the brain's embedding provider refusing the call (SMD-2892): EMBEDDING_PROVIDER_ERROR, any
 * status. Its key, its model, its address, a gateway's answer, or a request it refuses — a 400 included, which a
 * hosted provider answers to every call for a setting it will not take (the maintainer's call, 2026-11-12: kept, as
 * before the code, rather than lose every summary to a misconfigured brain). Such a payload is kept, as a transient
 * is, until the mend lands it or the week is up.
 */
export function providerMends(result) {
  return result?.structuredContent?.code === "EMBEDDING_PROVIDER_ERROR";
}

/**
 * The server's machine-readable verdict on a result (SMD-1978), read from the
 * MCP result's `structuredContent` — `{ code, retryable, positions? }` — and,
 * for a server from before that field, derived from the prose rules unchanged.
 * `retryable` is the transient/final split (a kept payload vs a dead one);
 * `mend` names a pointer a retry should drop to mend the capture; `positions`
 * the derived_from indices to drop (absent for a key that may not know a source
 * exists — the existence-oracle rule); `on` marks a pointer the server could not
 * judge, which postPending counts. The hook keys on this, not on English.
 */
export function verdictOf(result, text) {
  const sc = result?.structuredContent;
  if (sc && typeof sc.code === "string") {
    // Valid indices only: a non-array, or a float, string or NEGATIVE element
    // from a non-conforming server, is dropped — a negative would otherwise pass
    // the retry loop's upper bound and drop nothing while burning a retry (review
    // pass 2). An empty result falls to the drop-all salvage, as a capture key's
    // position-less refusal does.
    const positions = Array.isArray(sc.positions) ? sc.positions.filter((n) => Number.isInteger(n) && n >= 0) : [];
    // The shape refusals took a code in SMD-2283 (before it they were prose the
    // rules below read): each mends the pointer its prose named, so the hook
    // drops and retries exactly what it did before.
    const mend = (sc.code === "DERIVED_FROM_MISSING" || sc.code === "REFUSED_DERIVED_FROM_SHAPE") ? "derived"
      : (sc.code === "REFUSED_SUPERSEDES_UNKNOWN" || sc.code === "REFUSED_SUPERSEDES_OWNERSHIP" || sc.code === "REFUSED_SUPERSEDES_SHAPE") ? "supersedes"
      : sc.code === "REFUSED_METADATA_SHAPE" ? "metadata"
        : (sc.retryable !== true && sc.code !== "EMBEDDING_PROVIDER_ERROR" && /metadata/.test(text)) ? "metadata" // a coded metadata REFUSAL a later server might send — mended by the prose beside the code; gated on non-retryable so a transient that merely mentions metadata is kept whole, as the prose path is (SMD-2168 review passes 1–2), and never on EMBEDDING_PROVIDER_ERROR, whose provider's words may say metadata (SMD-2892)
          : null;
    return { code: sc.code, retryable: sc.retryable === true, mend, positions, on: sc.code === "SUPERSEDES_UNJUDGED" ? "supersedes" : undefined };
  }
  // A server from before SMD-1978: the prose rules, unchanged. A "Refused:" is
  // final and may be mended by dropping the pointer it names; an "Error:" (the
  // store away, a pointer it could not judge) is a transient the payload keeps.
  const isRefused = REFUSAL_RE.test(text);
  const refused = isRefused || SDK_ERROR_RE.test(text);
  const mend = isRefused ? (/derived_from/.test(text) ? "derived" : /supersedes/.test(text) ? "supersedes" : /metadata/.test(text) ? "metadata" : null) : null;
  return {
    code: null, retryable: !refused, mend,
    positions: [...text.matchAll(/derived_from\[(\d+)\]/g)].map((m) => Number(m[1])),
    on: /this key's `supersedes` could not be (?:checked|attributed)/.test(text) ? "supersedes" : undefined,
  };
}

/**
 * capture_thought over MCP. Returns { id, note, sent } on success. A refusal of a
 * pointer — a derived_from id the server does not know (a thought since
 * deleted, a result this parser misread), or a supersedes the server refuses
 * (the earlier summary deleted; a key that may not replace it) — or of the
 * `metadata` (SMD-2168) drops what was refused and tries again, and the note
 * says so: a summary with no sources, a fresh one beside the old, or one
 * without its redaction count, beats no summary. (First review pass: only
 * derived_from was retried, and a dead supersedes refused every later ending of
 * the session forever, since the state kept naming it.)
 */
export async function postCapture(cfg, payload) {
  // SMD-1724: a session summary is an agent's output — derived from the
  // session, written by the hook or its model — declared so; the server clamps
  // it to the key's kind. A server from before the argument strips it unread.
  const args = { content: payload.text, source: payload.harness, trust: "agent" };
  if (payload.derived_from?.length) args.derived_from = payload.derived_from;
  if (payload.supersedes) args.supersedes = payload.supersedes;
  // What rides in metadata.* beside the row's own source (which stays the
  // harness, so a reader and a per-source weight — SMD-1297 — still tell a model
  // summary from a derived one, and a redacted one from a clean one): the model
  // that wrote the summary if one did (SMD-2014), and the COUNT of secrets
  // blanked from it (SMD-2168) — the count alone, never the reasons or offsets,
  // which the text's markers already name; and where its header's tickets came
  // from, the asks or the place (SMD-3306 PR 7a-3b-2), for the brain's subject
  // rule, which the text alone leaves to guess — not with a model's summary,
  // whose prose has no header for the word to describe (review pass 4: a model
  // echoing the header it was shown would have its tickets keyed); and the
  // version of the hook that prepared it (SMD-4378), so the brain can later
  // tell which rules wrote a header. A payload queued by a hook before 1.11.0 has
  // none, and is sent without it: no hook can say which wrote it. A hook
  // before 1.11.0 sending a payload a later one queued (a rollback) drops it.
  // A stamp not in a version's shape (a hand edit, a corrupt file) is not sent:
  // a long one the server refused cost the summary all its metadata, the
  // redaction count among it (review pass 2).
  const meta = {};
  if (payload.summary_model) meta.summary_model = payload.summary_model;
  if (payload.redactions?.length) meta.redactions = payload.redactions.length;
  if (payload.tickets_from && !payload.summary_model) meta.tickets_from = payload.tickets_from;
  if (typeof payload.hook_version === "string" && VERSION_RE.test(payload.hook_version)) meta.hook_version = payload.hook_version;
  if (Object.keys(meta).length) args.metadata = meta;
  const call = () => rpc(cfg, "tools/call", { name: "capture_thought", arguments: args });
  let result = await call();
  let text = textOfResult(result);
  const notes = [];
  // A mendable refusal (a droppable pointer, whatever its retryable flag) is
  // mended by dropping the pointer the verdict names and trying again; the
  // server's transients (the store away, a pointer it could not judge) name no
  // pointer to mend and fall through to the classification below.
  for (let retry = 0; retry < 5 && result.isError; retry++) {
    const v = verdictOf(result, text);
    if (v.mend === "derived" && args.derived_from) {
      // The POSITIONS the verdict names, dropped exactly (second review pass: a
      // first cut dropped all forty sources over one deleted thought); with
      // none named — a key not told which — the whole list goes.
      const at = v.positions.filter((i) => i < args.derived_from.length);
      if (at.length) {
        notes.push(`${at.length} source id(s) dropped: ${oneLine(text).slice(0, 120)}`);
        args.derived_from = args.derived_from.filter((_, i) => !at.includes(i));
        if (!args.derived_from.length) delete args.derived_from;
      } else { notes.push("provenance dropped: " + oneLine(text).slice(0, 160)); delete args.derived_from; }
    } else if (v.mend === "supersedes" && args.supersedes) { notes.push("supersedes dropped: " + oneLine(text).slice(0, 160)); delete args.supersedes; }
    // A server that refuses `metadata` — a reserved-key clash, or a brain from
    // before it took the argument (SMD-2014) — is met by dropping metadata and
    // posting the summary anyway (SMD-2168): the count is a nicety, the summary
    // is the point, as with a dropped pointer.
    else if (v.mend === "metadata" && args.metadata) { notes.push("metadata dropped: " + oneLine(text).slice(0, 160)); delete args.metadata; }
    else break;
    result = await call();
    text = textOfResult(result);
  }
  // An error saved nothing, whatever id its words name (SMD-3153: the one
  // that did, a save whose vector did not attach, left with its code).
  if (result.isError) {
    // Final vs kept is the verdict's `retryable` (SMD-1978): a refusal is dead,
    // a transient — the store not answering, a pointer it could not judge — is
    // worth keeping (first review pass: every isError was "refused", and a brain
    // whose database was down for a minute lost the session for good).
    const v = verdictOf(result, text);
    // Kept by its code too (SMD-2892): the brain's embedding provider refusing it — a key or a model an operator
    // mends — is final for the call and no fault of the summary's, so the payload waits for the mend as an outage's
    // does (up to PENDING_MAX_AGE_MS), not dead on the first refusal.
    const kept = v.retryable || providerMends(result);
    const err = new CaptureError(kept ? "failed" : "refused", `capture ${kept ? "failed" : "refused"}: ${oneLine(text).slice(0, 200)}`);
    // A pointer the server could not judge: a failure ON the pointer, counted by
    // postPending so the last attempt can drop it (eighth review pass).
    if (v.on === "supersedes") err.on = "supersedes";
    throw err;
  }
  const id = new RegExp(`\\bid (${UUID})`, "i").exec(text)?.[1];
  if (!id) throw new CaptureError("failed", `capture answered without an id: ${oneLine(text).slice(0, 200)}`);
  // `sent`: the pointer the post that landed named — none when a mend dropped
  // it, which is what the captured line reports (SMD-2473 PR 2 review pass 1).
  return { id: id.toLowerCase(), note: notes.join("; "), sent: args.supersedes };
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

/** How many payloads a run posts beside its own — the queue's five (SMD-1298); the run's own, one per episode, all post (SMD-2013's second review pass: the oldest of more than five waited for a run that might never come). */
export const RUN_MAX = 5;

/**
 * The foreground: read the transcript, decide, summarise, scan, hand off.
 * Returns { code, message, payloadPaths, payloadPath?, payload? } — the caller
 * prints the message and exits with the code; `payloadPaths` are the payloads
 * the run's child posts, one per episode written, `payloadPath` the newest. One payload per episode whose summary changed
 * (SMD-2013): an episode captured and unchanged is skipped by fingerprint, one
 * whose summary carries a secret has it blanked (`opts.onSecret` `redact`, the
 * default) or is refused alone (`refuse`) — the others still post (SMD-2127).
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
  for (const ep of s.episodes) ep.sessionId = sessionId; // the hook's id wins over the transcript's, which segment set
  const episodes = s.episodes;
  if (!episodes.length) return { code: 0, message: `skip: no human prompt in session ${sessionId}` };
  const last = episodes[episodes.length - 1]; // the open episode: where the session is now
  const chainFor = (ep) => episodeChain(sessionId, ep.n);
  const listing = listPayloads(); // the queue walked once for every episode (thirteenth review pass of SMD-1298; SMD-2013's first)
  const states = new Map(episodes.map((ep) => [chainFor(ep), readState(chainFor(ep)) ?? {}]));
  if (eventSpec(event)?.interval && opts.minIntervalMin > 0) {
    // The session's last attempt across its episodes' chains: a new episode
    // inside the interval is not a reason to capture (SMD-2013's first review
    // pass: the gate read the open chain alone, which a new episode has none of).
    const gates = episodes.map((ep) => lastAttemptMs(chainFor(ep), states.get(chainFor(ep)), sessionPayloads(chainFor(ep), {}, listing))).filter(Boolean);
    const gate = gates.length ? gates.reduce((a, b) => (b.at > a.at ? b : a)) : null;
    const ageMin = gate ? (Date.now() - gate.at) / 60_000 : Infinity;
    if (ageMin < opts.minIntervalMin) return { code: 0, message: `skip: last capture ${ageMin.toFixed(0)} min ago${gate.pending ? " (still pending)" : ""}, interval ${opts.minIntervalMin}` };
  }
  if (typeof hook.cwd === "string" && hook.cwd) { for (const x of [s, last]) { x.cwd = hook.cwd; x.roots.add(hook.cwd); } }
  last.checkpoint = checkpointOf(hook); // a checkpoint is the open episode's; a closed one is over
  const written = [], skipped = [], refused = [];
  const onSecret = opts.onSecret ?? "redact";
  for (const ep of episodes) {
    const chain = chainFor(ep);
    // Blanked BEFORE the fingerprint (SMD-2127): the fingerprint is of the text
    // sent, so the same transcript is the same summary, however it was cleaned.
    const cleaned = cleanEpisode(ep, onSecret);
    const { text, redactions } = cleaned;
    const fingerprint = sha256(text);
    const state = states.get(chain);
    if (state.fingerprint === fingerprint) { skipped.push({ ep, as: state.thought_id }); continue; }
    // …or already QUEUED: with the endpoint away, a session resumed and ended
    // again with no new turn would queue the same summary twice, and the run
    // that drains them would dead-letter the first as "obsolete" (eleventh review pass).
    if (sessionPayloads(chain, {}, listing).some((p) => payloadOf(p)?.fingerprint === fingerprint)) { skipped.push({ ep, queued: true }); continue; }
    // The gate, whatever the mode: a multi-line key block is refused, and under
    // `redact` the blanked sources and text are re-scanned — the net under the
    // redaction, so no single-line secret the scan can see is sent (SMD-2127).
    const where = gateFindings(cleaned, text);
    if (where.length) { refused.push({ ep, where: `${where.join(", ")}${redactions.length ? ` after ${countRedactions(redactions.length)}` : ""}` }); continue; }
    const ticketsFrom = headerTickets(cleaned.ep).from;
    const payload = {
      session_id: sessionId, chain_id: chain, episode: ep.n, harness: s.harness, event: ep === last ? event : "", trigger: ep === last ? last.checkpoint?.trigger : undefined, text, fingerprint, // a closed episode's summary is final whatever event the run is: it carries no event, so the log says none (second review pass)
      derived_from: provenanceOf(ep), supersedes: state.thought_id || undefined,
      prompts: distinctPrompts(cleaned.ep.prompts).length, prepared_at: new Date().toISOString(), attempts: 0, // as the text counts them: two asks that differed in a secret alone are one line once blanked (first review pass)
      ...(redactions.length ? { redactions } : {}), // what was blanked, where — the log's and the message's; absent when nothing was
      ...(ticketsFrom ? { tickets_from: ticketsFrom } : {}), // where the header's tickets came from (SMD-3306 PR 7a-3b-2)
      hook_version: HOOK_VERSION, // the hook that prepared the payload (its derived text, or the model's input), whichever later hook drains the queue (SMD-4378)
    };
    // The model's input rides the payload only when the option is on AND the
    // payload is a durable one the model will actually write — not a running
    // checkpoint, which keeps its derived text (the same event-table test
    // modelSummary applies): so a derived-mode payload carries nothing of the
    // model (SMD-2014), and a checkpoint payload never carries the assistant
    // excerpt at rest unread (review pass 2). The fingerprint stays the DERIVED
    // text's, so an episode is asked of the model once — a re-end with the same
    // derived summary is skipped, not re-modelled.
    if (opts.summary === "model" && !eventSpec(payload.event)?.checkpoint) payload.assistant = assistantExcerpt(ep);
    ensureDirs();
    // The name orders the queue: the millisecond, then a per-process sequence
    // (two payloads one process prepares in one millisecond sort as made — third
    // review pass: a random tail decided, and a test flaked), then a random tail
    // so two processes never collide; it ends in the chain's sanitised key.
    const payloadPath = join(PENDING_DIR(), `${Date.now()}-${String(payloadSeq++).padStart(4, "0")}-${randomBytes(3).toString("hex")}-${basename(statePath(chain), ".json")}.json`);
    writeJson(payloadPath, payload);
    written.push({ ep, payloadPath, payload });
  }
  const one = episodes.length === 1;
  const who = `session ${sessionId}${last.checkpoint ? ` (${event}${last.checkpoint.trigger ? ` ${last.checkpoint.trigger}` : ""})` : ""}`;
  const describe = (p) => `${p.prompts} prompt(s), ${p.derived_from.length} source id(s)${p.supersedes ? `, supersedes ${p.supersedes}` : ""}${p.redactions?.length ? `, redacted: ${describeRedactions(p.redactions)}` : ""}`;
  const sentences = [];
  if (refused.length) {
    const carrier = one ? `the summary for session ${sessionId}` : `${refused.length === 1 ? `episode ${refused[0].ep.n}` : `episodes ${refused.map((r) => r.ep.n).join(", ")}`} of session ${sessionId}`;
    const where = refused.map((r) => (one ? r.where : `episode ${r.ep.n}: ${r.where}`)).join("; ");
    sentences.push(`refused — ${carrier} carries what looks like a secret (${where}); ${written.length ? `${refused.length === 1 ? "that episode is" : "those episodes are"} not sent, the other ${written.length === 1 ? "episode posts" : `${written.length} episodes post`}` : "nothing sent"}. Remove it from the conversation before ending the session, or capture by hand.`);
  }
  if (written.length) {
    sentences.push(one ? `prepared: ${who}, ${describe(written[0].payload)}`
      : `prepared: ${who}, episode${written.length === 1 ? "" : "s"} ${written.map((w) => w.ep.n).join(", ")} of ${episodes.length}${skipped.length ? ` (${skipped.length} unchanged)` : ""} — ${written.map((w) => `${w.ep.n}: ${describe(w.payload)}`).join("; ")}`);
    const newest = written[written.length - 1];
    return { code: refused.length ? 1 : 0, message: sentences.join(" | "), payloadPaths: written.map((w) => w.payloadPath), payloadPath: newest.payloadPath, payload: newest.payload };
  }
  if (refused.length) return { code: 1, message: sentences[0], payloadPaths: [] };
  const queuedOnly = skipped.every((k) => k.queued);
  if (one) return { code: 0, message: queuedOnly ? `skip: session ${sessionId} already queued — a payload with this summary is pending` : `skip: session ${sessionId} already captured as ${skipped[0].as}`, payloadPaths: [] };
  const newest = skipped[skipped.length - 1];
  return { code: 0, message: `skip: session ${sessionId}'s ${episodes.length} episodes are already captured${skipped.some((k) => k.queued) ? " or queued" : ""} (the newest ${newest.queued ? "as a pending payload" : `as ${newest.as}`})`, payloadPaths: [] };
}

/**
 * A recorded time as milliseconds, or NaN when it is none or lies in the
 * FUTURE: a clock that was wrong decides nothing (fourth review pass of
 * SMD-1298) — else one skewed payload would make every honest later ending
 * obsolete until the wall clock caught up. The one spelling of that rule, for
 * `recordedAfter` and `momentOf` (SMD-2035's boyscout: it was written twice).
 */
const pastMs = (iso) => { const t = Date.parse(iso ?? ""); return t <= Date.now() ? t : NaN; };
/**
 * Whether the state records a summary NEWER than a payload prepared at
 * `preparedAt`. States from before summary_at carry the post time — close
 * enough. One rule, read before the post and again after it (ninth review
 * pass: it was spelled twice).
 */
function recordedAfter(state, preparedAt) {
  return Boolean(preparedAt && pastMs(state?.summary_at ?? state?.captured_at) > Date.parse(preparedAt));
}

/**
 * What a payload file says of itself, or `undefined` when it cannot be read
 * (mid-write, or gone) — then each reader takes the side that costs least if
 * wrong. A name is matched by a sanitised tail two ids can share ("a.b" and
 * "a_b"), so the file says whose it is (seventh review pass: the sixth had
 * fixed one reader of five); and it says whether it has landed.
 */
const payloadOf = (p) => { try { return JSON.parse(readFileSync(p.path, "utf8")) ?? undefined; } catch (e) { return e?.code === "ENOENT" ? null : undefined; } }; // null: gone between the listing and the read — a claim that has just cleared, nobody's (ninth review pass)
/**
 * The claims a payload steps aside for: payloads of its session that another
 * LIVE child holds under inflight/<pid>/ and that are OLDER than it — a name
 * leads with the millisecond it was prepared, so the names order them —
 * landed or not: one that carries its `captured_id` is over but for its
 * state write, and a sibling posting past it would write the state beside
 * that write, in no order (eighth review pass let it, the ninth undid it). A
 * compaction's child still posting when the session's end spawned its own
 * (`/compact` then `/exit`; an auto-compaction on the last turn) left the
 * end's payload pointing at nothing — the checkpoint had not landed — so the
 * end landed first and the checkpoint after it, a live thought saying
 * "continuing" of a session that had ended, beside the final summary
 * (SMD-2035; SMD-2012's second review pass, the gap SMD-1989 had recorded).
 * A child that is gone holds no one (the next run's sweep returns its claim);
 * only the NEWER of two steps aside, so two children never wait on each other.
 */
export const aheadOf = (sessionId, name) => sessionPayloads(sessionId, { pending: false }).filter((p) => {
  if (p.pid === process.pid || p.name.localeCompare(name) >= 0 || !isAlive(p.pid)) return false;
  const j = payloadOf(p);
  return j === undefined || (j !== null && chainOf(j) === sessionId); // unreadable: ahead, the safe side; gone: not
});
/**
 * Whether a NEWER payload of the session is in another live child's hands:
 * the older one is then obsolete — a summary is cumulative, the newer covers
 * it, and a payload posted beside it would stand as a live "continuing"
 * thought (fourth review pass: a sweep returned an older payload to pending/
 * after the newer's run had looked, a sibling claimed it, and both posted).
 */
export const newerInFlight = (sessionId, name) => sessionPayloads(sessionId, { pending: false }).some((p) => p.pid !== process.pid && p.name.localeCompare(name) > 0 && isAlive(p.pid) && chainOf(payloadOf(p)) === sessionId); // unreadable: not a reason to drop a payload

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
    const j = payloadOf(p);
    if (!j) continue;
    // The name's millisecond was written by the same clock as prepared_at: a
    // future one decides nothing either, and the payload ranks last — a clock
    // that ran ahead never puts it over the state (fifth review pass).
    if (j?.captured_id && chainOf(j) === sessionId) out.push({ name: p.name, id: j.captured_id, ms: payloadMoment(j.prepared_at, p.ms) });
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
/** A recorded moment for ranking: `pastMs`, else the fallback. */
const momentOf = (iso, fallbackMs) => { const t = pastMs(iso); return Number.isNaN(t) ? fallbackMs : t; };
/** A payload's moment: when it was prepared, else the millisecond in its name — written by the same clock, so a future one decides nothing either and the payload ranks last (fifth review pass; spelled once, eleventh). */
const payloadMoment = (preparedAt, nameMs) => momentOf(preparedAt, nameMs <= Date.now() ? nameMs : 0);
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
export function pointerFor(sessionId, name, state, landedHere) {
  // A state whose time is in the future or unreadable STANDS (its moment is now): it is the pointer's normal source, and a clock that was wrong is no reason to rank an owed payload — the exception — over it (fourth review pass).
  // What this run itself landed is the last resort: when the landed payload's own id write failed — the disk full, the temp path taken — the file went back to pending/ without it, the state was never written, and a follow-up of the session would post pointerless while the next run posted the landed payload again (eighth review pass; the first pass had dropped this map as redundant, and it is, but for that fault).
  const cands = [state?.thought_id && { id: state.thought_id, ms: momentOf(state.summary_at ?? state.captured_at, Date.now()) }, landedBefore(sessionId, name), landedHere].filter(Boolean);
  cands.sort((a, b) => b.ms - a.ms);
  return cands[0]?.id;
}

// ── The opt-in model summary (SMD-2014) ──────────────────────────────────────

/** One model call's ceiling. The detached child has no 1.5 s hook budget, but a summary is not worth a long wait; a slower model falls back to the derived one. */
const MODEL_TIMEOUT_MS = 30_000;

/** The model's brief: Daemonic Brain's plain register, what to write, the caps, and the guards. */
const MODEL_SYSTEM = [
  "You are writing a memory of one piece of a coding session's work, to be stored and retrieved later by any AI.",
  "From the derived summary and the assistant's own messages below, write plain, direct prose covering:",
  "- what was DECIDED, and why;",
  "- what was left OPEN;",
  "- what CHANGED.",
  "Rules: at most ~200 words; no preamble, no headings, no lists, no markdown; name no thought ids and no file paths you were not given; include no keys, tokens or secrets; if the messages do not say, do not invent — write only what they support. Write about this one piece of work alone.",
].join("\n");

/**
 * May the model endpoint be called under the hook's egress policy (SMD-2014,
 * mirroring the server's SMD-1903 gate)? "Local" is DECLARED (`model_local`),
 * never guessed from the address — a loopback URL behind a forwarding proxy is
 * not local, and a LAN model a box declares local is. Under deny (the default
 * and the fail-closed value) only a declared-local endpoint may be called;
 * allow and off permit any. Returns null when allowed, else the reason.
 */
export function egressRefusalForModel(cfg) {
  if (cfg.egress === "off" || cfg.egress === "allow") return null;
  if (cfg.modelLocal) return null;
  return `egress policy "${cfg.egress}" and the model endpoint is not declared local — set "model_local": true in the config for a model on this machine, or "egress" to "allow"`;
}

/** One line for --check and --dry-run: what the summary will be, and if a model is configured, whether egress would let it run — without calling it. */
export function modelStatusLine(cfg) {
  if (cfg.summary !== "model") return `summary: derived (the default; set "summary": "model" for a local model to write what was decided)`;
  if (!cfg.modelUrl || !cfg.model) return `summary: model — but no model_url/model is configured, so the derived summary is sent`;
  const refusal = egressRefusalForModel(cfg);
  if (refusal) return `summary: model at ${cfg.modelUrl} (${cfg.model}) — but egress would refuse it (${refusal}), so the derived summary is sent`;
  return `summary: model at ${cfg.modelUrl} (${cfg.model}); egress ${cfg.egress}${cfg.modelLocal ? ", endpoint declared local" : ""}`;
}

/**
 * The model summary of one episode, or null to keep the derived one already in
 * the payload (SMD-2014). Runs in the DETACHED child, never the foreground:
 * the hook's budget is 1.5 s, this is seconds. Every way it can go wrong — the
 * option off, no endpoint declared, egress refusing a non-local endpoint, a
 * slow or failed or empty call, or a secret in the model's OWN words — falls
 * back to the derived summary and logs why: a well-formed memory beats none.
 * The model is shown the derived summary and the assistant's messages only,
 * never tool results or the raw transcript, and it names no ids — `derived_from`
 * stays the derived summary's provenance whichever text is sent.
 */
export async function modelSummary(cfg, payload, fetchImpl = fetch) {
  if (cfg.summary !== "model" || typeof payload.assistant !== "string") return null; // derived: the option is off, or the payload was prepared before it was on
  const chain = chainOf(payload);
  // A running checkpoint keeps its DERIVED summary: its `Checkpoint: …
  // continuing` line is the signal a sibling session reads and search marks
  // superseded, and a free rewrite would drop it. The model writes the durable
  // summary at the episode's end (a compaction that CLOSES the episode, so its
  // payload carries no event, or the session's end), which supersedes the
  // checkpoint's derived text (SMD-2014). Read from the event table that
  // renderSummary's Checkpoint line derives from, not the rendered text (first
  // review pass: matching the rendered wording was fragile and untested).
  if (eventSpec(payload.event)?.checkpoint) return null;
  if (!cfg.modelUrl || !cfg.model) { log(`model summary skipped for ${chain}: summary=model but no model_url/model configured — derived summary sent`); return null; }
  // The assistant messages are scanned before they leave the box, as the
  // derived text was at prepare and the model's own output is below: a key in a
  // message that is not the last outcome is absent from the derived summary, so
  // prepare's scan never saw it, and this is the only gate before it would
  // reach the model — a remote one under egress allow/off (first review pass:
  // both reviewers found the excerpt left the box unscanned). A hit keeps the
  // derived summary; nothing is sent to the model.
  const leak = scanForSecrets(payload.assistant);
  if (leak.length) { log(`model summary refused for ${chain}: ${leak[0].reason} at char ${leak[0].at} in the assistant messages — nothing sent to the model, derived summary sent`); return null; }
  const refusal = egressRefusalForModel(cfg);
  if (refusal) { log(`model summary refused for ${chain}: ${refusal} — derived summary sent`); return null; }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.modelTimeout ?? MODEL_TIMEOUT_MS);
  try {
    const r = await fetchImpl(`${cfg.modelUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.modelKey ? { Authorization: `Bearer ${cfg.modelKey}` } : cfg.modelBasic ? { Authorization: `Basic ${cfg.modelBasic}` } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: MODEL_SYSTEM },
          { role: "user", content: `Derived summary:\n${payload.text}\n\nThe assistant's messages for this piece of work:\n${payload.assistant || "(none)"}` },
        ],
      }),
      redirect: "manual", // a redirect is a proxy or a login page, not the model
      signal: ac.signal,
    });
    if (!r.ok) { log(`model summary failed for ${chain}: HTTP ${r.status} from the model endpoint — derived summary sent`); return null; }
    let body; try { body = await r.json(); } catch { log(`model summary failed for ${chain}: the model endpoint did not answer JSON — derived summary sent`); return null; }
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) { log(`model summary empty for ${chain} — derived summary sent`); return null; }
    const out = text.trim().slice(0, LIMITS.textChars);
    // The scan runs on the model's OWN words too: it can quote a key the derived
    // summary would not have (SMD-2014). A hit keeps the derived text, which the
    // prepare-time scan already cleared, rather than refusing the episode.
    const findings = scanForSecrets(out);
    if (findings.length) { log(`model summary refused for ${chain}: ${findings[0].reason} at char ${findings[0].at} in the model's output — derived summary sent`); return null; }
    return { text: out, model: cfg.model };
  } catch (e) {
    log(`model summary failed for ${chain}: ${String(e?.message ?? e).slice(0, 120)} — derived summary sent`);
    return null;
  } finally {
    clearTimeout(timer);
  }
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
 * own payload is always among the five. After them the run follows up, round
 * after round while a round yields, with up to five payloads of the sessions
 * whose claims it cleared that waited under pending/ — an end deferred behind
 * the checkpoint it has just landed (SMD-2035) — never with one it has itself
 * just returned there.
 */
export async function postPending(cfg, own) {
  ensureDirs();
  sweepInflight();
  const mine = join(INFLIGHT_DIR(), String(process.pid));
  mkdirSync(mine, { recursive: true, mode: 0o700 });
  // The run's own: one payload, or one per episode the run prepared (SMD-2013) — all of them; the five bound what waited from before, taken longest-waiting first.
  const owns = [].concat(own ?? []).filter(Boolean);
  const pending = readdirSync(PENDING_DIR()).filter((f) => f.endsWith(".json")).sort().map((f) => join(PENDING_DIR(), f));
  const earlier = pending.filter((f) => !owns.includes(f)).slice(0, Math.max(0, RUN_MAX - owns.length));
  const wanted = [...earlier, ...owns.filter((f) => existsSync(f))].sort((a, b) => basename(a).localeCompare(basename(b))); // names lead with the millisecond they were made
  // Claim: the payload's home path stays its name in the outcomes and the state.
  // Every session-keyed structure and rule below keys on the CHAIN — the
  // session's id, or an episode's key under it (SMD-2013): each episode's
  // summaries order and supersede among themselves alone.
  const claimed = wanted.map((home) => claim(home, mine)).filter(Boolean);
  const newestOf = new Map(); // chain → the newest payload's home in this run
  for (const { home, payload } of claimed) newestOf.set(chainOf(payload), home);
  const outcomes = [];
  pruneDead();
  const clearedSessions = new Set();
  const landedHere = new Map(); // chain → what this run landed: the pointer's last resort
  const bounced = new Set(); // files the follow-up found to be another session's: read once
  // After the run: payloads left under pending/ of every session whose claim
  // this run cleared — landed, dropped as obsolete beside a newer one, or
  // failed on and returned — are claimed and posted now, with the pointer the
  // state carries, rather than by whichever hook run comes next: an end
  // deferred behind the checkpoint this run has just landed (second review
  // pass), behind an older payload it has just dropped for that end (fourth),
  // or behind one whose post failed (fifth). Round after round while a round
  // yields something — an end deferred behind a checkpoint the first round
  // was posting (fifth review pass) — up to five payloads in all.
  const FOLLOW_UP_MAX = 5;
  const followUps = (room) => {
    // Not what this run has itself returned to pending/ — a failed post, a
    // deferral — which would be retried at once and counted twice (third
    // review pass). Each cleared session's candidates NEWEST first, taken in
    // rounds across the sessions — every session's newest before any
    // session's second — so one session's obsolete older ends never spend
    // the room another's newest needs (fifth and sixth review passes); the
    // older ones left under pending/ are dropped by the next run.
    const done = new Set(outcomes.map((o) => o.file));
    const lists = [...clearedSessions].map((sid) => [sid, sessionPayloads(sid).filter((q) => q.pid === null && !done.has(q.path) && !bounced.has(`${sid}:${q.path}`)).sort((x, y) => y.name.localeCompare(x.name))]);
    const next = [];
    for (let k = 0; next.length < room && lists.some(([, l]) => l.length > k); k++) {
      for (const [sid, l] of lists) {
        const p = l[k];
        if (!p || next.length >= room) continue;
        const c = claim(p.path, mine);
        if (!c) continue;
        // A name is matched by its sanitised tail, which two ids can share
        // ("a.b" and "a_b"): a payload of another session is not this run's
        // to judge (sixth review pass — it was dropped as obsolete beside a
        // session it did not belong to).
        if (chainOf(c.payload) !== sid) { moveTo(c.here, PENDING_DIR()); bounced.add(`${sid}:${p.path}`); continue; } // by session: its own may still follow it up (tenth review pass)
        // The session's newest, across rounds: a later round must not name an older payload newest when the newest was taken before and failed (ninth review pass).
        if (!newestOf.has(sid) || basename(newestOf.get(sid)).localeCompare(p.name) < 0) newestOf.set(sid, p.path);
        next.push({ ...c, followUp: true });
      }
    }
    next.sort((a, b) => basename(a.home).localeCompare(basename(b.home))); // oldest first, as the run posts
    if (next.length) log(`following up: ${next.length} payload(s) of ${[...new Set(next.map((n) => chainOf(n.payload)))].join(", ")} waited under pending/ behind a claim this run cleared`);
    return next;
  };
  const queue = [...claimed];
  let followedUp = 0;
  try {
    for (;;) {
      if (!queue.length) {
        if (followedUp >= FOLLOW_UP_MAX) break;
        const more = followUps(FOLLOW_UP_MAX - followedUp);
        if (!more.length) break;
        queue.push(...more);
      }
      const { home, here, payload, retaken, followUp } = queue.shift();
      const file = home;
      const chain = chainOf(payload);
      const who = "session=" + payload.session_id + (payload.episode > 1 ? ` episode=${payload.episode}` : "");
      // The cap counts what the follow-up posts or defers, not what it drops:
      // five stale ends of one session, four of them obsolete, spent the room
      // another session's deferred end needed (eleventh review pass).
      if (followUp) followedUp++;
      try { const now = new Date(); utimesSync(mine, now, now); } catch { /* the claim is judged by its age; a touch that fails leaves it judged from the last one */ }
      // Whether a newer summary of the session exists anywhere — this run holds
      // a newer payload, the state records a later one, a newer payload has
      // landed owed its bookkeeping, or a newer one is in another live child's
      // hands about to post, cumulative over this one — is ONE question, asked
      // before stepping aside and again before posting (third and fourth review
      // passes: asked in parts, the parts disagreed).
      const newestHere = newestOf.get(chain) === home;
      const outdated = (state) => !newestHere || recordedAfter(state, payload.prepared_at) || landedAfter(chain, basename(here)) || newerInFlight(chain, basename(here));
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
      // A payload that has landed steps aside too: its state write must follow
      // an older sibling's, and two children finishing one session's owed
      // bookkeepings at once wrote the state in no order (tenth review pass;
      // the first pass had spared it the wait, which is gone).
      // A landed one consults them whatever its siblings: outdated or not, its
      // state write must follow an older sibling's (eleventh review pass: one
      // beside a newer payload in this run wrote at once, and raced).
      const ahead = !payload.captured_id && outdated(readState(chain)) ? [] : aheadOf(chain, basename(here));
      if (ahead.length) {
        const moved = moveTo(here, PENDING_DIR());
        // Between the look and that move the predecessor may have landed and
        // run its follow-up over a pending/ that did not yet hold this payload
        // (third review pass). One more look: if the claim has cleared, the
        // payload is taken back and posted now — once — unless the landing run
        // got to it first, in which case that run posts it and this one says so.
        let why = `the session's earlier post is in flight (pid ${ahead[0].pid}); ${moved ? "kept under pending/ for the run that lands it" : "pending/ refused the move, so it stays in this run's hands until the run ends"}`;
        if (moved && !retaken && !aheadOf(chain, basename(here)).length) {
          try { renameSync(home, here); queue.unshift({ home, here, payload, retaken: true }); continue; } catch { why = existsSync(mine) ? "the session's earlier post has cleared and its run has taken this payload up" : "this run's claim directory is gone, swept as stale, so the payload waits under pending/ for the next run"; }
        }
        log(`deferred ${who} — ${why}`);
        outcomes.push({ file, ok: false, deferred: true, error: `deferred: ${why}` });
        continue;
      }
      const state = readState(chain);
      const stateIsNewer = recordedAfter(state, payload.prepared_at);
      // A payload that already LANDED is never obsolete: its id must reach the
      // state, and the newer payload behind it must supersede it (sixth review
      // pass: judged obsolete beside a newer one, the id was lost and two
      // summaries stood). One whose session has a NEWER landed payload owed its
      // bookkeeping is obsolete though the state is silent (second review pass:
      // an old checkpoint posted as "continuing" after the end had landed).
      const obsolete = !payload.captured_id && outdated(state);
      if (obsolete) {
        if (followUp) followedUp--; // a drop is no work the cap bounds
        clearedSessions.add(chain);
        moveTo(here, DEAD_DIR());
        log(`obsolete ${who} — a later capture of the session has a summary; this one is not posted`);
        outcomes.push({ file, ok: false, obsolete: true, error: "obsolete: a later capture of the session has a summary" });
        continue;
      }
      // The pointer is decided when the payload POSTS, not when it was prepared:
      // the session's newest landed thought — what the state records NOW, or a
      // landed payload whose bookkeeping is owed — else what prepare saw. The state only moves forward, so a pointer from
      // prepare time is stale the moment the state names another id — a payload
      // prepared before its predecessor landed pointed past it, and two
      // summaries stood (seventh and eighth review passes).
      if (!payload.captured_id) payload.supersedes = pointerFor(chain, basename(here), state, landedHere.get(chain)) ?? payload.supersedes;
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
      const waited = Date.now() - (pastMs(payload.prepared_at) || Number(basename(here).split("-")[0]));
      let lastResort = "";
      if (!payload.captured_id && payload.supersedes && onPointer > 0 && (attemptsSoFar >= 4 || waited > PENDING_MAX_AGE_MS)) {
        lastResort = `supersedes dropped: ${onPointer} of ${attemptsSoFar} attempts failed on it${waited > PENDING_MAX_AGE_MS ? ", the payload a week old" : ""}: ${oneLine(payload.last_error ?? "").slice(0, 120)}`;
        delete payload.supersedes;
      }
      // The opt-in model summary (SMD-2014), done here in the detached child:
      // rewrite the derived text into what was decided, or keep the derived one.
      // Not for a payload that already landed, and not again once a model wrote
      // it (summary_model set and persisted by a failed post's writeJson below),
      // so a retry re-posts the model's text rather than re-calling the model.
      if (!payload.captured_id && payload.summary_model === undefined) {
        const m = await modelSummary(cfg, payload);
        if (m) { payload.text = m.text; payload.summary_model = m.model; }
      }
      let posted;
      try {
        // A payload that already landed (its bookkeeping failed last time) is not
        // posted again: the id is on the payload (second review pass — a local
        // fault after the capture counted as a failed attempt and re-posted).
        posted = payload.captured_id ? { id: payload.captured_id, note: payload.captured_note ?? "", sent: payload.captured_sent } : await postCapture(cfg, payload);
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
        clearedSessions.add(chain); // the claim clears: an end that stepped aside for this payload must not wait for an unrelated run (fifth review pass)
        moveTo(here, dead ? DEAD_DIR() : PENDING_DIR());
        log(`${dead ? "dead" : "pending"} ${who} attempt=${payload.attempts}${dead && waited > PENDING_MAX_AGE_MS ? ` waited=${Math.round(waited / 86_400_000)}d` : ""} error="${payload.last_error}"`);
        outcomes.push({ file, ok: false, error: payload.last_error, dead });
        continue;
      }
      const { id } = posted;
      clearedSessions.add(chain);
      landedHere.set(chain, { id, ms: payloadMoment(payload.prepared_at, Number(basename(here).split("-")[0])) });
      const note = [posted.note, lastResort].filter(Boolean).join("; ");
      // Bookkeeping, apart from the post: the id goes onto the payload first, so a
      // fault here leaves a file the next run finishes without posting twice. A
      // landed payload whose session already records a NEWER summary is finished
      // without moving the state back to it (third review pass). The ORDER is
      // load-bearing: the id goes onto the file, the state is read AGAIN, then
      // written, then the claim removed — a sibling's end steps aside until the
      // claim clears, so its state write follows this one; and a sibling that
      // landed a newer summary meanwhile must not be moved back to this one
      // (eighth review pass of SMD-1298). The state is read after the id write:
      // read before it, a stall between the two let a sibling's state, written
      // meanwhile, be overwritten by this older one (ninth review pass).
      try {
        if (!payload.captured_id) writeJson(here, { ...payload, captured_id: id, captured_note: note, ...(posted.sent ? { captured_sent: posted.sent } : {}) });
        const stateIsNewerNow = stateIsNewer || recordedAfter(readState(chain), payload.prepared_at);
        // summary_at never runs ahead of the clock that will read it back.
        const summaryAt = Number.isNaN(pastMs(payload.prepared_at)) ? new Date().toISOString() : payload.prepared_at;
        if (!stateIsNewerNow) writeState(chain, { chain_id: chain, thought_id: id, fingerprint: payload.fingerprint, captured_at: new Date().toISOString(), summary_at: summaryAt, harness: payload.harness, prompts: payload.prompts, sources: (payload.derived_from ?? []).length });
        unlinkSync(here);
        // `supersedes_sent`: postCapture's `sent`, what the post asked — a
        // capture-only key's server may drop it without a word (SMD-2473).
        log(`captured ${who} harness=${payload.harness}${payload.event && payload.event !== "SessionEnd" ? ` event=${payload.event}${payload.trigger ? ` trigger=${payload.trigger}` : ""}` : ""} id=${id} sources=${(payload.derived_from ?? []).length}${posted.sent ? ` supersedes_sent=${posted.sent}` : ""}${payload.redactions?.length ? ` redactions=${payload.redactions.length}` : ""}${note ? ` note="${note}"` : ""}`);
        outcomes.push({ file, ok: true, id, note });
      } catch (e) {
        moveTo(here, PENDING_DIR());
        log(`captured ${who} id=${id} but the bookkeeping failed: ${String(e.message ?? e).slice(0, 200)} — the payload keeps the id for the next run`);
        outcomes.push({ file, ok: true, id, note: [note, "bookkeeping deferred"].filter(Boolean).join("; ") });
      }
    }
  } finally {
    // Anything still claimed (an unexpected throw) goes back; then the claim directory goes.
    release(mine);
  }
  return outcomes;
}

/** Hand the network half to a child that outlives this process; stdout/stderr go to the log. */
function detachPost(payloadPaths, brain) {
  ensureDirs();
  const fd = openSync(LOG_PATH(), "a", 0o600);
  const child = spawn(process.execPath, [SELF, ...(brain ? ["--brain", brain] : []), ...payloadPaths.flatMap((p) => ["--post", p])], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env },
  });
  child.unref();
  closeSync(fd);
  return child.pid;
}

/** --check for one brain: its endpoint, its key's surface, the deprecated routes (SMD-2686, SMD-3057); `tag` prefixes each line ("[canary] "). Returns the exit code. */
async function checkBrain(cfg, tag, onSecret) {
  // An answer from the root through the proxy's legacy route worked until
  // v2.0.0 closed it (SMD-2532), so on an older stack it is a warning, not a failure.
  // A tier's route through stable's proxy closes then too (SMD-3057), and
  // its /mcp is stable's: the tier itself is the url to set. Each route's
  // Deprecation date is its own, stamped by a release and never moved
  // (RFC 9745: when the deprecation began), so it says which answered:
  // the tiers' @1792108800, the root's @1790899200. Another date falls
  // back to the Link's anchor, and with no deprecation Link to the url's
  // tier path, in case as the routers match it. Said on a refused answer
  // too: a tier route with no tier behind it is a 404, and its client is
  // the one to tell.
  const warnDeprecated = () => {
    if (!cfg.deprecation) return;
    const u = new URL(cfg.url); // endpointOf made it, so it parses
    const link = cfg.deprecationLink ?? "";
    const tierRoute = cfg.deprecation === "@1792108800" || (cfg.deprecation !== "@1790899200" && (/rel="deprecation"/.test(link) ? /#a-canary-beside-the-stack>/.test(link) : /^\/(canary|working)\/mcp(\/|$)/.test(u.pathname)));
    if (tierRoute) {
      console.error(`${tag}warning: ${shownUrl(cfg.url)} answered through the proxy's deprecated tier route (Deprecation: ${cfg.deprecation}), which stops answering at v2.0.0 — set the url in ${cfg.where ?? urlSource()} to the tier itself, a canary's own port (deploy/canary.sh), never stable's /mcp (deploy/README.md, "A canary beside the stack")`);
    } else {
      let to = "its /mcp";
      if (u.pathname === "/") to = shownUrl(`${u.origin}/mcp${u.search}`);
      console.error(`${tag}warning: ${shownUrl(cfg.url)} answered through the proxy's deprecated legacy route (Deprecation: ${cfg.deprecation}), which stops answering at v2.0.0 — set the url to ${to} in ${cfg.where ?? urlSource()} (deploy/README.md, "Moving a client to /mcp")`);
    }
  };
  let tools;
  try { tools = ((await rpc(cfg, "tools/list", {}, 15_000)).tools ?? []).map((t) => t.name).sort(); } catch (e) { console.error(`session-capture: ${tag}${shownUrl(cfg.url)} did not answer tools/list — ${e.message}`); warnDeprecated(); return 1; }
  // The summary mode, and whether a configured model would run — read from the
  // config, the model endpoint not called (SMD-2014).
  if (cfg.summary === "model") console.log(`${tag}${modelStatusLine(cfg)}`);
  warnDeprecated();
  // A capture key's surface: capture_thought, since SMD-3664 the priority writers (on a thought it captured alone) and
  // since SMD-3665 the open-item writers (on an item it opened alone) — no read. A server before SMD-3664 lists
  // capture_thought alone.
  if (tools.includes("capture_thought") && tools.every((t) => CAPTURE_SURFACE.has(t))) { console.log(`${tag}ok: ${shownUrl(cfg.url)} answers, and the key sees ${tools.join(", ")} alone (capture scope). On a secret: ${onSecret}. State: ${STATE_DIR}`); return 0; }
  if (!tools.includes("capture_thought")) { console.error(`session-capture: ${tag}the key cannot capture — its surface is [${tools.join(", ")}]. Mint one with: bun server-portable/keygen.ts --name session-hook --scope capture`); return 1; }
  console.error(`${tag}warning: the key can capture, and it can also ${tools.filter((t) => !CAPTURE_SURFACE.has(t)).join(", ")} — a leak of this file reads your brain. Prefer a capture-scoped key: bun server-portable/keygen.ts --name session-hook --scope capture`);
  return 0;
}

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
