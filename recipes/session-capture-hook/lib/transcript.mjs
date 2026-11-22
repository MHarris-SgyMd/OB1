/**
 * lib/transcript.mjs — a transcript read (SMD-4338): which harness wrote it,
 * Claude Code's and Codex's lines read into events (an ask, an outcome, a
 * file, a commit, a move, the ids a brain tool returned), and the events
 * handed to the segmenter (lib/episode.mjs).
 */

import { readFileSync } from "node:fs";
import { emptySummary, segment, stripInjected } from "./episode.mjs";

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

/** Tool names whose input names a file the session changed (Claude Code). */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

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


/** Read a transcript and return the summary structure. */
export function summariseTranscript(path, harness) {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const s = emptySummary();
  s.harness = harness || sniffHarness(lines.slice(0, 5));
  return s.harness === "codex" ? parseCodex(lines, s) : parseClaudeCode(lines, s);
}
