#!/usr/bin/env bun
/**
 * test-session-capture.mjs — the hook against synthetic transcripts and a fake
 * MCP endpoint (SMD-1298). No brain, no model, no network beyond localhost.
 *
 * Run: bun recipes/session-capture-hook/test-session-capture.mjs
 *
 * What it holds: both parsers read only what the summary needs and only from
 * the brain's own tool results; the summary is deterministic and capped; the
 * secret scan catches each shape it names and leaves the summary's own ids,
 * shas and file names alone; a hit is blanked to `[redacted:<reason>]` and the
 * rest sent, one the blanking leaves is refused, and under
 * OB1_CAPTURE_ON_SECRET=refuse every hit refuses with exit 1 and writes nothing (SMD-2127); the
 * foreground half finishes inside the SessionEnd budget and the detached half
 * posts; a second ending supersedes the first, and one prepared while the
 * checkpoint before it is still posting steps aside for it (SMD-2035); a provenance refusal is retried
 * without provenance; a dead endpoint keeps the payload for a later run; the
 * printed hook carries no key; --check tells a capture key from a wider one.
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, unlinkSync, utimesSync, renameSync, symlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "session-capture.mjs");
const TMP = mkdtempSync(join(tmpdir(), "ob1-session-capture-"));
const STATE = join(TMP, "state");
const CONFIG = join(TMP, "session-capture.json");
process.env.OB1_SESSION_CAPTURE_STATE = STATE;
process.env.OB1_SESSION_CAPTURE_CONFIG = CONFIG;
delete process.env.OB1_BRAIN_URL;
delete process.env.OB1_CAPTURE_KEY;

const {
  stripInjected, sniffHarness, parseClaudeCode, parseCodex, summariseTranscript, renderSummary, provenanceOf,
  scanForSecrets, scanSummary, SECRET_PATTERNS, redactSecrets, redactEpisode, cleanEpisode, secretMode, SECRET_MODES, redactionMarker, describeRedactions, parseRpcBody, postCapture, prepare, postPending, hookJson, shellWord, readState, LIMITS, REFUSAL_RE, checkpointOf, EVENTS, HOOK_EVENTS, DEFAULT_EVENTS, eventSpec, HARNESS, HARNESSES, TRIGGER_EVENTS, INTERVAL_EVENTS, aheadOf, newerInFlight, landedBefore, landedAfter, pointerFor, segment, ticketsIn, episodeChain, RUN_MAX,
} = await import(SCRIPT);

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓  ${label}`); } else { failed++; console.error(`  ✗  ${label}`); }
}
const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** The script as a child: `stdin` when the hook path is meant (the hook's JSON, or raw bytes), none for a flag. */
function spawnScript(args, { stdin, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const t = Date.now();
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t }));
    if (stdin !== undefined) child.stdin.end(stdin);
  });
}
const runHook = (input, env = {}, args = [], raw = false) => spawnScript(args, { env, stdin: raw ? String(input) : JSON.stringify(input) });

// ── A fake MCP endpoint ──────────────────────────────────────────────────────
// Keys: "cap-key" sees capture_thought alone; "write-key" everything; "read-key"
// the reads; anything else is -32001 inside a 200, as the server answers.
// tools/call answers as an SSE frame, tools/list as raw JSON, so both shapes
// the client must parse are exercised. Behaviour markers in the content:
//   [[refuse-derived]]   the first attempt with derived_from is refused as the server refuses an unknown id
//   [[embedding-failed]] saved, but isError with the "embedding failed to attach" text and the id
//   [[store-down]]       the server answered, its store did not: isError "Error: Failed to connect" — not a refusal
//   [[fn-missing]]       a store error phrased with "not found" — still not a refusal
//   [[refuse-hard]]      a refusal the hook cannot mend: isError "Refused: …" naming no pointer → dead
//   [[grant-missing]]    the server could not CHECK the supersedes (its role lacks SELECT on thought_audit): kept, the pointer not dropped
//   [[refuse-derived-at:N]]  the first attempt is refused naming position N of derived_from, as the server does
//   [[slow]]             the answer takes 2.5 s — a synchronous post would bust the SessionEnd budget
const received = [];
let refusedOnce = new Set();
const READ = ["fetch", "list_supersession_proposals", "list_thoughts", "search", "search_thoughts", "search_thoughts_keyword", "thought_changes", "thought_stats"]; // main's read surface as of SMD-1296; the capture rule does not depend on its length
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1", // the address the suite posts to: an ephemeral port chosen on localhost's other address could be one another app holds on this one (eleventh review pass: Notion answered 401 to a run)
  async fetch(req) {
    const key = req.headers.get("x-brain-key");
    if (new URL(req.url).pathname === "/not-the-endpoint") return new Response("Method Not Allowed", { status: 405 });
    if (new URL(req.url).pathname === "/unwell") return new Response("Bad Gateway", { status: 502 });
    if (new URL(req.url).pathname === "/busy") return new Response("Too Many Requests", { status: 429 });
    if (new URL(req.url).pathname === "/login") return new Response("<html><body>Sign in</body></html>", { status: 200, headers: { "Content-Type": "text/html" } });
    if (new URL(req.url).pathname === "/moved") return new Response("", { status: 301, headers: { Location: `${new URL(req.url).origin}/login` } });
    if (new URL(req.url).pathname === "/front-401") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Unauthorized: missing or invalid authentication." } }), { status: 401, headers: { "Content-Type": "application/json" } });
    const body = await req.json();
    const envelope = (payload) => ({ jsonrpc: "2.0", id: body.id, ...payload });
    const sse = (payload) => new Response(`event: message\ndata: ${JSON.stringify(envelope(payload))}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    const json = (payload) => Response.json(envelope(payload));
    const scope = key === "cap-key" ? "capture" : key === "write-key" ? "write" : key === "read-key" ? "read" : null;
    if (!scope) return json({ error: { code: -32001, message: "Unauthorized: missing or invalid authentication." } });
    const surface = scope === "capture" ? ["capture_thought"] : scope === "write" ? [...READ, "capture_thought", "update_thought", "delete_thought"] : READ;
    if (body.method === "tools/list") return json({ result: { tools: surface.map((name) => ({ name })) } });
    if (body.method === "tools/call") {
      const { name, arguments: args } = body.params;
      // The pinned SDK answers an unknown tool as a RESULT with isError, not a JSON-RPC error (thirteenth review pass: the fake modelled the wrong shape).
      if (!surface.includes(name)) return sse({ result: { isError: true, content: [{ type: "text", text: `MCP error -32602: Tool ${name} not found` }] } });
      const n = received.push({ key, args }); // the id is the post's ordinal at the moment it ARRIVES, so two posts in flight at once never share one (SMD-2035's suite)
      const content = String(args.content);
      if (/\[\[refuse-derived\]\]/.test(content) && args.derived_from && !refusedOnce.has(content)) {
        refusedOnce.add(content);
        return sse({ result: { isError: true, content: [{ type: "text", text: `Refused: derived_from[0] names no thought. Each entry must be an existing thought id (the ID: line of a search result).` }] } });
      }
      if (/\[\[refuse-derived-old\]\]/.test(content) && args.derived_from && !refusedOnce.has(content)) {
        refusedOnce.add(content); // a server from before this pass names the whole list
        return sse({ result: { isError: true, content: [{ type: "text", text: "Refused: a `derived_from` id names no thought — (in [\"…\"]). Each must be an existing thought id (the ID: line of a search result)." }] } });
      }
      if (/\[\[refuse-supersedes\]\]/.test(content) && args.supersedes) {
        return sse({ result: { isError: true, content: [{ type: "text", text: "Refused: no thought with the id given as supersedes. Pass the id of an existing thought — the ID: line of a search result." }] } });
      }
      if (/\[\[store-down\]\]/.test(content)) return sse({ result: { isError: true, content: [{ type: "text", text: "Error: Failed to connect" }] } });
      if (/\[\[store-401\]\]/.test(content)) return sse({ result: { isError: true, content: [{ type: "text", text: "Error: PostgREST answered 401 Unauthorized: JWT expired" }] } });
      if (/\[\[state-moves\]\]/.test(content)) writeFileSync(join(STATE, "s-raced.json"), JSON.stringify({ thought_id: uuid(82), fingerprint: "sib", captured_at: new Date().toISOString(), summary_at: new Date().toISOString() }));
      if (/\[\[grant-missing\]\]/.test(content) && args.supersedes) return sse({ result: { isError: true, content: [{ type: "text", text: "Error: this key's `supersedes` could not be checked against the target's capture record (permission denied for table thought_audit) — the server role needs SELECT on thought_audit: cd db && bun migrate.ts --grant <role> --url $DATABASE_URL." }] } });
      if (/\[\[registry-away\]\]/.test(content) && args.supersedes) return sse({ result: { isError: true, content: [{ type: "text", text: "Error: this key's `supersedes` could not be attributed while the agent registry is unavailable — retry when resolve_agent answers." }] } });
      if (/\[\[refuse-hard\]\]/.test(content)) return sse({ result: { isError: true, content: [{ type: "text", text: "Refused: the content is not a thought this brain will hold." }] } });
      if (/\[\[fn-missing\]\]/.test(content)) return sse({ result: { isError: true, content: [{ type: "text", text: "Error: function upsert_thought(text, jsonb, vector) not found; a function must be defined before it is called" }] } });
      const at = /\[\[refuse-derived-at:(\d+)\]\]/.exec(content);
      if (at && args.derived_from && !refusedOnce.has(content)) {
        refusedOnce.add(content);
        return sse({ result: { isError: true, content: [{ type: "text", text: `Refused: derived_from[${at[1]}] names no thought. Each entry must be an existing thought id (the ID: line of a search result).` }] } });
      }
      if (/\[\[slow-down\]\]/.test(content)) { await sleep(2500); return sse({ result: { isError: true, content: [{ type: "text", text: "Error: Failed to connect" }] } }); }
      if (/\[\[slow\]\]/.test(content)) await sleep(2500);
      const id = uuid(1000 + n);
      if (/\[\[embedding-failed\]\]/.test(content)) return sse({ result: { isError: true, content: [{ type: "text", text: `Thought saved (id ${id}) but its embedding failed to attach: stub. It will NOT appear in semantic search until re-captured.` }] } });
      return sse({ result: { content: [{ type: "text", text: `Captured as observation — id ${id} — topics` }] } });
    }
    return json({ error: { code: -32601, message: "Method not found" } });
  },
});
const URL_ = `http://127.0.0.1:${fake.port}/`;
writeFileSync(CONFIG, JSON.stringify({ url: URL_, key: "cap-key" }), { mode: 0o600 });

// ── Fixtures ────────────────────────────────────────────────────────────────

const SID = "11111111-2222-4333-8444-555555555555";
const T0 = "2026-09-22T13:00:00.000Z";
const line = (o) => JSON.stringify(o);
const user = (content, extra = {}) => line({ type: "user", sessionId: SID, timestamp: T0, cwd: "/repo/proj", gitBranch: "feat/x", message: { role: "user", content }, ...extra });
const assistant = (content) => line({ type: "assistant", sessionId: SID, timestamp: "2026-09-22T13:20:00.000Z", cwd: "/repo/proj", gitBranch: "feat/x", message: { role: "assistant", content } });
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const toolResult = (id, text) => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] });

/** A Claude Code session: two searches (one from the brain, one from the web), an edit, a commit, a PR, a capture, noise. */
function claudeTranscript() {
  return [
    line({ type: "permission-mode", sessionId: SID, permissionMode: "auto" }),
    user("plan and implement the hook <system-reminder>\nThe repo says X.\n</system-reminder>", { origin: { kind: "human" } }),
    user("<system-reminder>only a reminder</system-reminder>", { origin: { kind: "human" } }), // strips to nothing: not asked
    user("<command-name>/compact</command-name><command-message>compact</command-message>", { origin: { kind: "human" } }),
    user("an injected line", { isMeta: true }),
    user("a subagent's prompt", { isSidechain: true, origin: { kind: "human" } }),
    user("/compact", { origin: { kind: "human" } }),
    user("/code-review high", { origin: { kind: "human" } }), // a slash command WITH arguments is an ask (twelfth review pass)
    assistant([toolUse("t1", "mcp__open-brain__search_thoughts", { query: "hook" }), toolUse("t2", "WebSearch", { query: "codex hooks" }), toolUse("t3", "mcp__other__web_search", { q: "x" })]),
    user([toolResult("t1", `1. [2026-09-01] (idea) a thought\n   ID: ${uuid(1)}\n2. [2026-09-02] (task) another\n   ID: ${uuid(2)}`), toolResult("t2", `a page mentioning ID: ${uuid(77)} which is not ours`), toolResult("t3", `ID: ${uuid(78)}`)]),
    assistant([toolUse("t4", "Edit", { file_path: "/repo/proj/src/a.ts", old_string: "x", new_string: "y" }), toolUse("t5", "Write", { file_path: "/repo/proj/README.md", content: "…" }), toolUse("t6", "Bash", { command: "cd /repo/proj && git commit -q -F msg.txt" }), toolUse("t9", "Write", { file_path: "/Users/someone/.claude/projects/-Users-someone-Proj/memory/note-1234.md", content: "…" })]),
    user([toolResult("t4", "ok"), toolResult("t5", "ok"), toolResult("t6", "[feat/x abc1234] done"), toolResult("t9", "ok")]),
    assistant([toolUse("t7", "mcp__open-brain__capture_thought", { content: "decision" })]),
    user([toolResult("t7", `Captured as idea — id ${uuid(3)} — hooks`)]),
    user("now push and open the PR", { origin: { kind: "human" } }),
    user("now push and open the PR", { origin: { kind: "human" } }), // a retried prompt collapses
    user("This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.", { origin: { kind: "human" } }), // a compaction after the last ask: a boundary armed, never opened (SMD-2013) — the work after it is the last ask's
    assistant([toolUse("t8", "Bash", { command: "git push -u origin feat/x && gh pr create" })]),
    user([toolResult("t8", "https://github.com/o/r/pull/7")]),
    line({ type: "pr-link", sessionId: SID, prNumber: 7, prUrl: "https://github.com/o/r/pull/7", prRepository: "o/r", timestamp: "2026-09-22T13:30:00.000Z" }),
    line({ type: "ai-title", sessionId: SID, aiTitle: "Session-end capture hook" }),
    line({ type: "assistant", sessionId: SID, timestamp: "2026-09-22T13:20:00.000Z", cwd: "/repo/proj-wt", gitBranch: "feat/y", message: { role: "assistant", content: [toolUse("t10", "Edit", { file_path: "/repo/proj-wt/src/b.ts", old_string: "x", new_string: "y" })] } }),
    user([toolResult("t10", "ok")], { cwd: "/repo/proj-wt", gitBranch: "feat/y" }),
    line({ type: "assistant", sessionId: SID, timestamp: "2026-09-22T13:20:00.000Z", cwd: "/repo/proj-wt", gitBranch: "feat/y", message: { role: "assistant", content: [{ type: "text", text: "Done: the hook is in, PR #7 is open. <system-reminder>noise</system-reminder>" }] } }),
    "not json at all",
    "",
  ].join("\n");
}

/** A Codex rollout: a brain search through an MCP tool, an apply_patch, a shell commit, a task_complete. */
function codexTranscript() {
  const ev = (type, payload) => line({ timestamp: "2026-09-22T14:00:00.000Z", type, payload });
  return [
    ev("session_meta", { id: "c0dec0de-1111-4222-8333-444444444444", cwd: "/repo/other", cli_version: "0.151.0", originator: "codex-tui", timestamp: "2026-09-22T14:00:00.000Z" }),
    ev("turn_context", { cwd: "/repo/other", turn_id: "t1" }),
    ev("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "developer instructions" }] }),
    ev("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/repo/other</cwd>\n</environment_context>" }] }),
    ev("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "find what we decided about egress" }] }),
    ev("response_item", { type: "function_call", name: "mcp__open-brain__search_thoughts", call_id: "c1", arguments: JSON.stringify({ query: "egress" }) }),
    ev("response_item", { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: `1. [2026-09-22] (idea) deny by default\n   ID: ${uuid(5)}` }] }),
    ev("response_item", { type: "function_call", name: "open-brain.search_thoughts", call_id: "c4", arguments: JSON.stringify({ query: "egress again" }) }),
    ev("response_item", { type: "function_call_output", call_id: "c4", output: { type: "output_text", text: `1. [2026-09-22] (idea) the same, spelled another way\n   ID: ${uuid(6)}` } }),
    ev("response_item", { type: "function_call", name: "shell", call_id: "c2", arguments: JSON.stringify({ command: ["bash", "-lc", "git commit -am wip"] }) }),
    ev("response_item", { type: "function_call_output", call_id: "c2", output: "[main 1234567] wip" }),
    ev("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "c3", input: "*** Begin Patch\n*** Update File: src/egress.ts\n@@\n-a\n+b\n*** Add File: docs/note.md\n+hello\n*** End Patch" }),
    ev("response_item", { type: "custom_tool_call_output", call_id: "c3", output: "Success" }),
    ev("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "We deny by default; noted in docs/note.md." }] }),
    ev("event_msg", { type: "task_complete", turn_id: "t1", last_agent_message: "We deny by default; noted in docs/note.md." }),
    ev("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "thanks, commit it" }] }),
    ev("event_msg", { type: "task_complete", turn_id: "t2", last_agent_message: "Committed as wip." }),
  ].join("\n");
}

const CLAUDE_T = join(TMP, "claude.jsonl");
const CODEX_T = join(TMP, "codex.jsonl");
writeFileSync(CLAUDE_T, claudeTranscript());
writeFileSync(CODEX_T, codexTranscript());

// ── [1] Claude Code parser ───────────────────────────────────────────────────
console.log("[1] The Claude Code parser reads what the summary needs, and only from the brain's tool results");
{
  const s = summariseTranscript(CLAUDE_T);
  assert(s.harness === "claude-code", `the harness is sniffed from the transcript (${s.harness})`);
  assert(s.sessionId === SID && s.cwd === "/repo/proj-wt" && s.branch === "feat/y", `session id, and the cwd and branch where the session ENDED (${s.cwd}, ${s.branch})`);
  assert([...s.roots].join() === "/repo/proj,/repo/proj-wt", "every directory the session ran in is a project root");
  assert(s.prompts.length === 4 && s.prompts[0] === "plan and implement the hook" && s.prompts.includes("/code-review high"), `four human prompts, the reminder stripped from the first, a slash command with arguments kept (${JSON.stringify(s.prompts)})`);
  assert(!s.prompts.some((p) => /reminder|compact|injected|subagent|continued from/.test(p)), "a reminder-only turn, a slash command, a meta line, a subagent line, a typed slash command and a compaction summary are not asked");
  assert(s.title === "Session-end capture hook", "the title comes from the ai-title line");
  assert([...s.retrieved].sort().join() === [uuid(1), uuid(2)].join(), `retrieved ids come from the brain's search result only (${[...s.retrieved].join(", ")})`);
  assert(!s.retrieved.has(uuid(77)) && !s.retrieved.has(uuid(78)), "a uuid printed by WebSearch or by a foreign web_search tool is not claimed as provenance");
  assert([...s.captured].join() === uuid(3), "the id the session captured is read from capture_thought's answer");
  assert([...s.files].sort().join() === "/Users/someone/.claude/projects/-Users-someone-Proj/memory/note-1234.md,/repo/proj-wt/src/b.ts,/repo/proj/README.md,/repo/proj/src/a.ts", "edited and written files are collected, wherever they are");
  assert(s.commits === 1 && s.pushed === true, "one commit counted, the push seen");
  assert(s.prs.join() === "https://github.com/o/r/pull/7", "the PR link is read from the pr-link line");
  assert(/PR #7 is open/.test(s.outcome), "the outcome is the assistant's last text");
  assert(s.first === T0 && s.last === "2026-09-22T13:20:00.000Z", `the time span is read (${s.first} → ${s.last})`);
}

// ── [2] Codex parser ─────────────────────────────────────────────────────────
console.log("\n[2] The Codex parser reads a rollout the same way");
{
  const s = summariseTranscript(CODEX_T);
  assert(s.harness === "codex", `the harness is sniffed from session_meta (${s.harness})`);
  assert(s.sessionId === "c0dec0de-1111-4222-8333-444444444444" && s.cwd === "/repo/other", "session id and cwd from session_meta");
  assert(s.prompts.join("|") === "find what we decided about egress|thanks, commit it", `user prompts, the environment_context frame and the developer message excluded (${JSON.stringify(s.prompts)})`);
  assert([...s.retrieved].sort().join() === [uuid(5), uuid(6)].join(), `the brain's MCP results yield the retrieved ids — under either tool spelling, and from a lone output block (${[...s.retrieved].join(", ")})`);
  assert([...s.files].sort().join() === "docs/note.md,src/egress.ts", `apply_patch's Update and Add File lines name the files (${[...s.files].join(", ")})`);
  assert(s.commits === 1, "a git commit inside the shell tool's argv is counted");
  assert(s.outcome === "Committed as wip.", "the outcome is the last task_complete's message");
  assert(sniffHarness(["{\"type\":\"user\",\"sessionId\":\"x\"}"]) === "claude-code" && sniffHarness(["garbage"]) === "claude-code", "an unrecognised first line falls back to claude-code");
  assert(stripInjected("a <AGENTS.md path=\"x\">rules</AGENTS.md> b <permissions instructions>p</permissions> c").replace(/\s+/g, " ") === "a b c", "Codex's instruction frames strip too");
}

// ── [3] The rendered summary ─────────────────────────────────────────────────
console.log("\n[3] The summary is deterministic, capped, and says what it carries");
{
  const s = summariseTranscript(CLAUDE_T);
  const text = renderSummary(s);
  assert(text === renderSummary(summariseTranscript(CLAUDE_T)), "the same transcript renders the same text");
  assert(/^Session summary — claude-code — proj-wt \(feat\/y\) — 2026-09-22\n/.test(text), `the head names harness, the project and branch where the session ended, and the day (${text.split("\n")[0]})`);
  assert(/Title: Session-end capture hook/.test(text), "the title line");
  assert(/Asked \(3 prompts\):\n- plan and implement the hook\n- \/code-review high\n- now push and open the PR\n/.test(text), "asked: distinct prompts, a retried one collapsed");
  assert(/Outcome \(the assistant's last message\):\nDone: the hook is in, PR #7 is open\.\n/.test(text) && !/noise/.test(text), "the outcome, its reminder stripped");
  assert(/Changed: 3 files — src\/a\.ts, README\.md, src\/b\.ts; 1 file outside the project; 1 commit, pushed; PR https:\/\/github\.com\/o\/r\/pull\/7\./.test(text), `changed: files relative to whichever root holds them, one outside counted not named, the commit, the push, the PR (${/Changed:.*$/m.exec(text)?.[0]})`);
  assert(!text.includes("/Users/someone"), "…a path outside the project is not in the text");
  assert(/Brain: retrieved 2 thoughts, captured 1 \(recorded as this summary's provenance\)\./.test(text), "the brain line counts, it does not list ids");
  assert(!text.includes(uuid(1)), "…no thought id is in the text: provenance is the derived_from field, not prose");
  assert(new RegExp(`Session ${SID}, 2026-09-22 13:00 → 2026-09-22 13:20\\.$`).test(text), "the session line closes it with the span");
  assert(provenanceOf(s).join() === [uuid(1), uuid(2), uuid(3)].join(), "derived_from is the retrieved ids then the captured one");
  // A checkpoint (SMD-2012): a compaction or a turn names the moment — the transcript's last timestamp, not the clock — and the trigger, before the closing line; an end names nothing.
  const cp = renderSummary({ ...s, checkpoint: { kind: "compacted", trigger: "auto" } });
  assert(/\n\nCheckpoint: compacted at 2026-09-22 13:20 \(auto\), continuing — the session's next checkpoint or its end supersedes this summary\.\n\nSession /.test(cp) && !/Checkpoint/.test(text) && cp === renderSummary({ ...s, checkpoint: { kind: "compacted", trigger: "auto" } }),
    `a compaction checkpoint names the moment and the trigger before the session line, deterministically; a session end names no checkpoint (${/Checkpoint:.*$/m.exec(cp)?.[0]})`);
  assert(/\n\nCheckpoint: turn ended at 2026-09-22 13:20, continuing/.test(renderSummary({ ...s, checkpoint: { kind: "running" } })) && /\n\nCheckpoint: compacted, continuing/.test(renderSummary({ ...s, first: "", last: "", checkpoint: { kind: "compacted" } })),
    "a turn's checkpoint says the turn ended; an undated one, or one whose trigger is neither manual nor auto, names no time and no trigger");

  const many = { ...s, prompts: Array.from({ length: 40 }, (_, i) => `prompt number ${i} ${"x".repeat(400)}`), retrieved: new Set(Array.from({ length: 100 }, (_, i) => uuid(200 + i))) };
  const big = renderSummary(many);
  assert(big.length <= LIMITS.textChars, `the whole text is capped at ${LIMITS.textChars} (${big.length})`);
  assert((big.match(/^- /gm) ?? []).length === LIMITS.prompts + 1 && /- … and 28 more/.test(big), `at most ${LIMITS.prompts} prompts are listed, the rest counted`);
  // The cap falls on the body, never on the closing lines (first review pass: clip() cut from the tail, and a long checkpoint summary lost the line saying the session still ran).
  // Twelve prompts at 200, the outcome at 1,500 and twenty long in-project paths are past the cap (the run-it reviewer's shape).
  const heavy = { ...many, outcome: "y".repeat(3000), files: new Set(Array.from({ length: 20 }, (_, i) => `/repo/proj/src/${"deeply/nested/".repeat(3)}component-number-${i}-and-more-words-in-its-name.ts`)) };
  const bigCp = renderSummary({ ...heavy, checkpoint: { kind: "compacted", trigger: "auto" } }), bigEnd = renderSummary(heavy);
  assert(bigCp.length === LIMITS.textChars && /…\n\nCheckpoint: compacted at 2026-09-22 13:20 \(auto\), continuing — the session's next checkpoint or its end supersedes this summary\.\n\nSession 11111111-2222-4333-8444-555555555555, 2026-09-22 13:00 → 2026-09-22 13:20\.$/.test(bigCp),
    `a summary over the cap keeps its Checkpoint and Session lines whole and ends on the Session line, the body clipped instead (${bigCp.length} chars, tail: ${JSON.stringify(bigCp.slice(-60))})`);
  assert(bigEnd.length === LIMITS.textChars && new RegExp(`…\\n\\nSession ${SID}, 2026-09-22 13:00 → 2026-09-22 13:20\\.$`).test(bigEnd), `…and so does one with no checkpoint (${bigEnd.length} chars, tail: ${JSON.stringify(bigEnd.slice(-40))})`);
  assert(bigCp !== bigEnd, "…so a checkpoint's summary and the end's differ even at the cap, and the end supersedes the checkpoint (first review pass: both clipped to the same 6000 bytes, and the end was 'already captured')");
  // The heavy body: with a short one the negative bound sliced it to nothing too, and the mutant hid (pass 2's own run-it).
  const absurd = renderSummary({ ...heavy, sessionId: "x".repeat(7000), checkpoint: { kind: "compacted", trigger: "auto" } });
  assert(absurd.length === LIMITS.textChars && /\n\nCheckpoint: compacted at /.test(absurd) && new RegExp(`\\n\\nSession x{${LIMITS.sessionIdChars - 1}}…, 2026-09-22`).test(absurd),
    `an absurd session id is clipped in the closing line, so the whole stays within the cap with the Checkpoint whole (fifth review pass: the closing was unbounded and the cap's sentence false; ${absurd.length} chars)`);
  assert(provenanceOf(many).length === LIMITS.derived, `derived_from is capped at ${LIMITS.derived}`);
  const empty = renderSummary(summariseTranscript(join(TMP, "empty.jsonl"), (writeFileSync(join(TMP, "empty.jsonl"), "{}\n"), "claude-code")));
  assert(/Brain: no thoughts read or written this session\./.test(empty), "a session that never touched the brain says so");
}

// ── [3b] Episodes ────────────────────────────────────────────────────────────
console.log("\n[3b] A long session is several episodes, one summary each, on its own chain (SMD-2013)");
const E_SID = "s-ep";
const EPISODES_T = join(TMP, "episodes.jsonl");
let episodesLines;
{
  // The rules alone, on events.
  const P = (text) => ({ t: "prompt", text }), CWD = (v) => ({ t: "cwd", v }), BR = (v) => ({ t: "branch", v }), CP = { t: "compaction" };
  const asks = (...ev) => segment(ev).episodes.map((e) => e.prompts.join("+")).join("|");
  assert(ticketsIn("implement smd-2013 and SMD-2013; sha-256, utf-8, RFC-2119, CVE-2024-1234, PR-154, ubuntu-2604, x-1, ID: 8de5e1e1-c72c-4b7f").join() === "SMD-2013" && ticketsIn("michaelharris/smd-1917-fork-md-token-sink").join() === "SMD-1917" && ticketsIn("").length === 0 && ticketsIn(undefined).length === 0,
    "a ticket key is two to five letters, a dash and two to six digits, upper-cased and said once; a digest's name, an encoding, an RFC, a CVE, a PR number, a uuid are not");
  assert(asks(CWD("/a"), P("one"), CWD("/a/sub"), P("two"), CWD("/a"), P("three"), CWD("/a/sub/deeper"), P("four")) === "one+two+three+four", "a cd into a subdirectory of the checkout and back is no move: the harness records the shell's directory per command");
  const dir = segment([CWD("/a"), P("one"), CWD("/b"), P("two")]).episodes;
  assert(dir.map((e) => e.prompts.join()).join("|") === "one|two" && dir[1].opened.kind === "directory" && dir[1].opened.to === "b" && dir[0].closed === dir[1].opened && dir[1].cwd === "/b" && [...dir[1].roots].join() === "/b",
    "a move to another directory ends the episode at the next ask; the next says where it went and runs there");
  assert(asks(BR("main"), P("fix the cors thing"), BR("me/smd-2079-cors"), P("review")) === "fix the cors thing+review", "a branch that names a ticket, made under an episode that names none, gives the work its name — no boundary");
  assert(asks(BR("me/smd-1844-a"), P("do smd-1844"), BR("me/smd-1843-b"), P("review")) === "do smd-1844|review" && asks(BR("me/smd-1844-a"), P("do it"), BR("main"), P("review")) === "do it|review", "…while a move to a branch naming another ticket, or none, ends it");
  assert(asks(BR("main"), P("help with x"), P("now implement SMD-2013")) === "help with x|now implement SMD-2013" && asks(BR("me/smd-2035-x"), P("do smd-2035"), P("also see smd-1297, and file smd-2050")) === "do smd-2035+also see smd-1297, and file smd-2050",
    "an ask naming a new ticket ends an episode with no home; on a branch that names the episode's ticket, a mention does not");
  assert(asks(BR("main"), P("tidy the readme"), P("bump to node-22 and smd-2013")) === "tidy the readme+bump to node-22 and smd-2013" && asks(BR("me/smd-1000-a"), P("tidy"), P("bump to node-22")) === "tidy+bump to node-22" && asks(BR("main"), P("tidy the readme"), P("bump to NODE-22")) === "tidy the readme|bump to NODE-22",
    "a lower-case key in an ask counts only for a team the session's branches name — node-22 on main is no ticket, smd-2013 under an smd- branch is — while before any team is known an upper-case key counts (first review pass)");
  assert(asks(BR("main"), P("tidy the readme"), P("switch the hash to AES-256, RSA-2048")) === "tidy the readme+switch the hash to AES-256, RSA-2048" && asks(BR("me/smd-1000-a"), P("tidy"), P("see XYZ-2013"), P("more")) === "tidy+see XYZ-2013+more" && asks(BR("main"), P("tidy"), P("see XYZ-2013")) === "tidy|see XYZ-2013",
    "a cipher's name is no key, and once a team is known another team's upper-case key is not one either (second review pass)");
  const stamped = segment([BR("me/smd-1000-a"), P("do smd-1000"), BR("main"), P("also SMD-1000 and SMD-2000 review")]).episodes;
  assert(stamped.length === 2 && stamped[1].opened.kind === "branch" && stamped[1].opened.ticket === undefined && !stamped[1].about.has("SMD-2000") && /begun on the move to branch main\.\n/.test(renderSummary(stamped[1])) && segment([BR("me/smd-2035-x"), P("do smd-2035"), { t: "compaction" }, P("create a branch for smd-2013"), BR("me/smd-2013-y"), P("review")]).episodes[1].opened.ticket === "SMD-2013",
    "an episode opened by a move is not 'with' a key its first ask merely names, nor about it; one opened at a compaction whose ask names the key the session then moves to is (second review pass)");
  assert(ticketsIn("smd-2013 and NODE-22 and pg-16", new Set(["SMD"])).join() === "SMD-2013" && ticketsIn("smd-2013 and pg-16", new Set()).length === 0 && ticketsIn("smd-2013 and pg-16").join() === "SMD-2013,PG-16", "…ticketsIn with a non-empty team set keeps only those teams' keys, in any case; an empty set keeps upper-case keys alone; no set — a branch name — every key (second review pass)");
  // The teams are those named SO FAR: a keyed branch made later must not make an earlier mention a key and move a boundary already captured (second review pass — the set was built from the whole transcript up front, and a prefix segmented otherwise than the whole).
  const early = [CWD("/repo"), BR("main"), P("help with x"), P("now smd-2013 please"), P("more")];
  assert(asks(...early) === "help with x+now smd-2013 please+more" && asks(...early, BR("me/smd-2099-later"), P("review")) === "help with x+now smd-2013 please+more+review" && asks(...early, BR("me/smd-2099-later"), P("now smd-2013 for real"), BR("me/smd-2013-z"), P("go")) === "help with x+now smd-2013 please+more|now smd-2013 for real+go",
    "a lower-case key counts from the first keyed branch on, not before it: the earlier episode stands as it was captured, and the branch made under it names its work");
  // The place an episode runs is its own: a move applies to the episode the next ask opens, never to the one it ends (first review pass).
  const moved = segment([CWD("/wt/smd-1844"), BR("me/smd-1844-a"), P("start work"), BR("me/smd-1843-b"), CWD("/wt/smd-1843"), P("review")]).episodes;
  assert(moved.length === 2 && moved[0].branch === "me/smd-1844-a" && moved[0].cwd === "/wt/smd-1844" && [...moved[0].roots].join() === "/wt/smd-1844" && /^Session summary — SMD-1844 — [^\n]*\(me\/smd-1844-a\)/.test(renderSummary(moved[0])) && moved[0].closed.kind === "branch" && moved[0].closed.to === "me/smd-1843-b" && moved[1].branch === "me/smd-1843-b" && moved[1].cwd === "/wt/smd-1843" && /^Session summary — SMD-1843 — /.test(renderSummary(moved[1])),
    `an ended episode keeps its branch, directory and ticket; the move is the next episode's (${renderSummary(moved[0]).split("\n")[0]})`);
  assert(asks(CWD("/repo"), P("one"), CWD("/repo/db"), CWD("/repo/scripts"), P("two"), CWD("/repo"), P("three")) === "one+two+three" && segment([CWD("/repo"), P("one"), CWD("/repo/db"), P("two")]).episodes[0].cwd === "/repo" && asks(CWD("/repo/db"), BR("main"), P("one"), CWD("/repo"), P("two")) === "one+two" && segment([CWD("/repo/db"), BR("main"), P("one"), CWD("/repo"), P("two")]).episodes[0].cwd === "/repo/db",
    "a cd between two subdirectories of one checkout is no move, and the episode's first directory names the project (first review pass: db/ to scripts/ split)");
  // An ancestor of the checkout is not inside it (second review pass): with no branch to go by a move up and over is a move; on a branch, the shell's.
  const up = segment([CWD("/Users/me/Projects/OB1"), P("one"), CWD("/Users/me"), CWD("/Users/me/Projects/other"), P("two")]).episodes;
  assert(up.map((e) => e.prompts.join()).join("|") === "one|two" && up[0].cwd === "/Users/me/Projects/OB1" && !up[0].roots.has("/Users/me") && up[1].cwd === "/Users/me/Projects/other" && segment([CWD("/Users/me/Projects/OB1"), BR("main"), P("one"), CWD("/Users/me"), P("two")]).episodes.length === 1,
    "a cd to HOME and on to another checkout is a move, and HOME never becomes the episode's directory or a root");
  // A line writes cwd then branch, so the two are one move: a cwd-first return
  // from a nested worktree to the repo root must not settle onto the episode it
  // ends before its branch arrives (second review pass — the closed episode's
  // text changed as the transcript grew).
  const wt = [CWD("/r"), BR("me/smd-10-a"), P("start"), CWD("/r/.claude/worktrees/smd-20"), BR("me/smd-20-b"), P("next"), { t: "file", path: "/r/.claude/worktrees/smd-20/x.ts" }];
  const wtEp2 = segment(wt).episodes[1], wtEp2Whole = segment([...wt, CWD("/r"), BR("main")]).episodes[1];
  assert(wtEp2.cwd === "/r/.claude/worktrees/smd-20" && [...wtEp2.roots].join() === "/r/.claude/worktrees/smd-20" && [...segment(wt).episodes[0].roots].join() === "/r" && /^Session summary — SMD-20 — smd-20 \(me\/smd-20-b\)/.test(renderSummary(wtEp2)) && renderSummary(wtEp2) === renderSummary(wtEp2Whole),
    `a return to the repo root from a worktree, cwd before branch, is the next episode's; the worktree episode keeps its place and its text stands as the transcript grows (${renderSummary(wtEp2).split("\n")[0]})`);
  // An episode's home is read live: once it has moved on, a move back to the
  // branch it began on is a new piece of work, not its own (second review pass).
  const backEp = segment([BR("me/smd-50-a"), CP, P("now smd-90"), BR("me/smd-90-b"), P("x"), BR("me/smd-50-a"), P("y"), BR("me/smd-70-c"), P("z")]).episodes;
  assert(backEp.map((e) => e.prompts.join("+")).join("|") === "now smd-90+x|y|z" && backEp.map((e) => e.branch).join("|") === "me/smd-90-b|me/smd-50-a|me/smd-70-c" && /^Session summary — SMD-90 \(me\/smd-90-b\)/.test(renderSummary(backEp[0])) && /^Session summary — SMD-50 \(me\/smd-50-a\)/.test(renderSummary(backEp[1])),
    `after an own move to smd-90 the episode's home is smd-90; a return to smd-50 opens a new episode, each head its own branch (${backEp.map((e) => e.prompts.length).join(",")})`);
  // The pairing's HEAD guard on a REAL detached-HEAD line: a rebase writes cwd
  // then gitBranch "HEAD" adjacent, the shape the pairing pairs, and it must
  // not become a move (third review pass — the guard was untested on a paired line).
  assert(segment([CWD("/r/.claude/worktrees/smd-50"), BR("me/smd-50-a"), P("a"), CWD("/r"), BR("HEAD"), P("b")]).episodes.length === 1 && segment([CWD("/r/.claude/worktrees/smd-50"), BR("me/smd-50-a"), P("a"), CWD("/r"), BR("HEAD"), P("b")]).episodes[0].branch === "me/smd-50-a",
    "a cwd then HEAD, adjacent as a rebase writes them, is no move: the pairing skips HEAD and the episode keeps its branch");
  // The unanchored branch of `began`: an episode on `main` (no home) split by a
  // compaction, its ask naming a team-recognised key, is not "with" that key —
  // the compaction ended it, not the key (third review pass — only the anchored
  // branch of `began` was pinned).
  const beganU = segment([BR("me/smd-11-a"), P("do smd-11"), BR("main"), P("refactor"), CP, P("now smd-500")]).episodes;
  assert(beganU.map((e) => e.prompts.join("+")).join("|") === "do smd-11|refactor|now smd-500" && beganU[2].opened.kind === "compaction" && beganU[2].opened.ticket === undefined && beganU[2].about.size === 0 && !/with SMD-500/.test(renderSummary(beganU[2])) && /Episode 3 of the session, begun after a compaction\./.test(renderSummary(beganU[2])),
    "an unanchored episode split by a compaction is not 'with' the key its ask names — the compaction ended it, and the key is unproven until a branch");
  assert(asks(CWD("/a"), P("one"), CWD("/b"), CWD("/a"), P("two")) === "one+two" && asks(BR("A"), P("one"), BR("B"), BR("A"), P("two")) === "one+two" && asks(BR("me/smd-1100-x"), P("do it"), BR("HEAD"), BR("me/smd-1100-x"), P("more")) === "do it+more" && asks(BR("me/smd-1100-x"), P("do it"), BR("HEAD"), P("more")) === "do it+more",
    "a move the session came back from before the next ask is no move, and a detached HEAD mid-rebase is no branch (first review pass)");
  assert(asks(CWD("/repo"), BR("main"), P("one"), CWD("/tmp"), P("two"), CWD("/repo"), P("three")) === "one+two+three" && segment([CWD("/repo"), BR("main"), P("one"), CWD("/tmp"), P("two")]).episodes[0].cwd === "/repo" && !segment([CWD("/repo"), BR("main"), P("one"), CWD("/tmp"), P("two")]).episodes[0].roots.has("/tmp"),
    "a cd out of the checkout with the branch unchanged is the shell's, not the session's: no move, and the episode's place stands");
  const both = segment([BR("main"), P("one"), CP, BR("feat/x"), P("two")]).episodes;
  assert(both.length === 2 && both[1].opened.kind === "compaction" && both[1].opened.moved?.kind === "branch" && both[1].opened.to === "feat/x" && /Episode 2 of the session, begun after a compaction and on the move to branch feat\/x\./.test(renderSummary(both[1])) && /Episode 1 of the session, ended at a compaction and when the session moved to branch feat\/x\./.test(renderSummary(both[0])) && segment([BR("main"), P("one"), BR("feat/x"), CP, P("two")]).episodes[1].opened.moved?.kind === "branch",
    "a compaction and a move between two asks are both recorded, in either order (first review pass: the later overwrote the earlier)");
  assert(asks(BR("me/smd-2035-x"), P("do smd-2035"), P("now plan smd-2013"), P("looks good, implement it"), BR("me/smd-2013-y"), P("review"), P("ship it")) === "do smd-2035+now plan smd-2013+looks good, implement it|review+ship it",
    "a ticket an ask merely mentioned makes no later move its own: the move to its branch ends the anchored episode at the next ask (first review pass: plan, approve, implement made one episode)");
  assert(asks(BR("me/smd-1100-x"), P("do smd-1100"), P("look at smd-2200"), P("more"), BR("me/smd-2200-y"), P("review")) === "do smd-1100+look at smd-2200+more|review", "…and the look-ahead for the move stops at the next ask");
  assert(asks(CWD("/wt/smd-1843-x"), BR("me/smd-1000-z"), P("do it"), BR("me/smd-1843-y"), P("next")) === "do it+next" && asks(CWD("/wt/smd-1843-x"), BR("main"), P("do it"), P("also smd-2050"), P("more")) === "do it+also smd-2050+more",
    "the directory's ticket counts as the episode's home too: a move to its branch is its own, and a mention under it does not split");
  assert(asks(BR("main"), P("do SMD-1001"), P("SMD-1001 and SMD-1002"), P("more")) === "do SMD-1001+SMD-1001 and SMD-1002+more" && asks(CWD("/a"), CWD("/b"), P("one"), P("two")) === "one+two", "an ask naming a known ticket beside a new one is no turn; moves before the first ask begin nothing");
  const titled = segment([P("one"), CP, P("two"), { t: "title", text: "the session's title" }]).episodes;
  assert(titled[0].title === "the session's title" && titled[1].title === "", "the harness's title is the first episode's, whenever the line falls");
  assert(asks(BR("me/smd-2035-x"), P("do smd-2035"), P("now smd-2013"), BR("me/smd-2013-y"), P("review")) === "do smd-2035|now smd-2013+review" && segment([BR("me/smd-2035-x"), P("do smd-2035"), P("now smd-2013"), BR("me/smd-2013-y"), P("review")]).episodes[1].opened.kind === "ticket",
    "…unless the session then moves to the new ticket's branch before the next ask: the ask began that work, and the move is its own");
  assert(asks(P("one"), CP, CP, P("two"), CP) === "one|two" && segment([CP, P("one")]).episodes[0].opened.kind === "compaction" && segment([P("one"), CP]).episodes.length === 1 && !segment([P("one"), CP]).episodes[0].closed,
    "two compactions in a row open one episode; one before the first ask begins the first; one after the last ask ends nothing yet");
  assert(segment([]).episodes.length === 0 && segment([CWD("/a"), BR("main"), CP]).episodes.length === 0 && segment([P("one")]).episodes[0].n === 1 && segment([P("one")]).n === 0, "no ask, no episode; the first is 1, the session itself 0");
  assert(episodeChain("sid", 1) === "sid" && episodeChain("sid", 2) === "sid#e2", "the first episode chains under the session's own id — a session of one is captured as before — later ones under it");

  // The ticket's fixture: two compactions, a branch change, three ticket ids.
  const ln = (type, content, { cwd = "/repo/main-wt", branch = "main", ts = "2026-09-24T09:00:00.000Z", ...extra } = {}) => line({ type, sessionId: E_SID, timestamp: ts, cwd, gitBranch: branch, message: { role: type, content }, ...extra });
  const ask = (text, o) => ln("user", text, { origin: { kind: "human" }, ...o });
  const say = (text, o) => ln("assistant", [{ type: "text", text }], o);
  const search = (ids, tid, o) => [ln("assistant", [toolUse(tid, "mcp__open-brain__search_thoughts", { query: "q" })], o), ln("user", [toolResult(tid, ids.map((id, i) => `${i + 1}. [2026-09-01] (idea) x\n   ID: ${uuid(id)}`).join("\n"))], o)];
  const tool = (tid, name, input, out, o) => [ln("assistant", [toolUse(tid, name, input)], o), ln("user", [toolResult(tid, out)], o)];
  const A = { cwd: "/repo/main-wt", branch: "michaelharris/smd-1844-loopback" };
  const B = { cwd: "/repo/wt/smd-1843-env", branch: "michaelharris/smd-1843-env" };
  const C = { cwd: "/repo/wt/smd-1917-fork-md", branch: "michaelharris/smd-1917-fork-md" };
  const t = (h, m) => `2026-09-24T${h}:${m}:00.000Z`;
  const compaction = (o) => ask("This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.", { ...o, isCompactSummary: true });
  episodesLines = [
    ask("create a new branch to plan and implement smd-1844", { ts: t("09", "00") }),
    ...search([11], "e1", { ts: t("09", "05") }),
    ...tool("e2", "Edit", { file_path: "/repo/main-wt/deploy/compose.yaml", old_string: "a", new_string: "b" }, "ok", { ...A, ts: t("09", "10") }), // the branch changes to one naming the ticket: no boundary
    ...tool("e3", "Bash", { command: "git commit -q -F msg" }, "[x 123] done", { ...A, cwd: "/repo/main-wt/deploy", ts: t("09", "12") }), // a cd into a subdirectory: no boundary
    ask("review for issues", { ...A, ts: t("09", "20") }),
    say("Pass one: two findings fixed.", { ...A, ts: t("09", "30") }),
    compaction({ ...A, ts: t("09", "35") }),
    say("Merged as abc.", { ...A, ts: t("09", "40") }), // after the compaction, before any ask: the first episode's outcome
    ask("create a new branch to plan and implement smd-1843", { ...A, ts: t("10", "00") }), // opens episode 2 after the compaction, typed on the OLD branch
    ...search([12, 13], "e4", { ...B, ts: t("10", "05") }), // the move to the new worktree and branch, both naming the ticket: no boundary
    ...tool("e5", "Edit", { file_path: "/repo/wt/smd-1843-env/deploy/compose.yaml", old_string: "a", new_string: "b" }, "ok", { ...B, ts: t("10", "08") }),
    ...tool("e6", "mcp__open-brain__capture_thought", { content: "d" }, `Captured as idea — id ${uuid(14)} — x`, { ...B, ts: t("10", "09") }),
    ask("also note SMD-1844's compose fix is merged already", { ...B, ts: t("10", "20") }), // a mention while anchored: no boundary
    say("Noted; the forwards are in.", { ...B, ts: t("10", "30") }),
    ask("now smd-1917: split FORK.md into one file per change", { ...B, ts: t("10", "40") }), // a new ticket, and the session then moves to its branch: episode 3 opens HERE
    ...tool("e7", "Edit", { file_path: "/repo/wt/smd-1917-fork-md/scripts/fork-index.ts", old_string: "a", new_string: "b" }, "ok", { ...C, ts: t("10", "50") }),
    say("Split done.", { ...C, ts: t("11", "00") }),
    compaction({ ...C, ts: t("11", "05") }),
    say("Pushed.", { ...C, ts: t("11", "06") }),
    ask("review for issues", { ...C, ts: t("11", "10") }), // episode 4: after a compaction, no ticket in the ask — the branch names it
    ...search([15], "e8", { ...C, ts: t("11", "15") }),
    say("Clean.", { ...C, ts: t("11", "20") }),
  ];
  writeFileSync(EPISODES_T, episodesLines.join("\n"));
  // The harness's flag is a boundary on its own: a compaction summary worded another way still ends the episode (a mutant that read the sentence alone survived).
  writeFileSync(join(TMP, "flag.jsonl"), [ask("one", { ts: t("09", "00") }), ask("Earlier in this conversation, before compaction, we did X.", { ts: t("09", "10"), isCompactSummary: true }), ask("two", { ts: t("09", "20") })].join("\n"));
  assert(summariseTranscript(join(TMP, "flag.jsonl")).episodes.map((e) => e.prompts.join()).join("|") === "one|two" && summariseTranscript(join(TMP, "flag.jsonl")).prompts.join() === "one,two", "a line the harness flags as its compaction summary is a boundary and not an ask, whatever its first sentence");
  writeFileSync(join(TMP, "flag-origin.jsonl"), [ask("one", { ts: t("09", "00") }), ln("user", "Earlier in this conversation we did X.", { ts: t("09", "10"), isCompactSummary: true, origin: { kind: "system" } }), ask("two", { ts: t("09", "20") })].join("\n"));
  assert(summariseTranscript(join(TMP, "flag-origin.jsonl")).episodes.map((e) => e.prompts.join()).join("|") === "one|two", "…whoever the harness says the line is from: the flag is read before the origin gate (first review pass)");
  const s = summariseTranscript(EPISODES_T);
  const eps = s.episodes;
  assert(eps.length === 4 && eps.map((e) => e.n).join() === "1,2,3,4" && s.prompts.length === 6 && s.n === 0 && s.retrieved.size === 4, `four episodes; the session's own summary still holds everything (${eps.length}: ${eps.map((e) => e.prompts[0].slice(0, 30)).join(" | ")})`);
  const [e1, e2, e3, e4] = eps;
  assert(e1.prompts.join("|") === "create a new branch to plan and implement smd-1844|review for issues" && e1.outcome === "Merged as abc." && [...e1.retrieved].join() === uuid(11) && e1.commits === 1 && [...e1.files].join() === "/repo/main-wt/deploy/compose.yaml" && e1.branch === "michaelharris/smd-1844-loopback" && e1.closed?.kind === "compaction" && e1.opened === undefined && e1.first === t("09", "00") && e1.last === t("09", "40"),
    "episode 1: its two asks, the outcome the assistant gave after the compaction and before the next ask, its own search, commit and file; the branch made after its first ask is its own; it ended at the compaction");
  assert(e2.prompts.length === 2 && /smd-1843/.test(e2.prompts[0]) && /SMD-1844's/.test(e2.prompts[1]) && e2.opened.kind === "compaction" && e2.opened.ticket === "SMD-1843" && [...e2.retrieved].join() === [uuid(12), uuid(13)].join() && [...e2.captured].join() === uuid(14) && e2.cwd === "/repo/wt/smd-1843-env" && [...e2.roots].join() === "/repo/main-wt,/repo/wt/smd-1843-env" && e2.closed.kind === "ticket" && e2.closed.ticket === "SMD-1917" && e2.first === t("10", "00") && e2.last === t("10", "30"),
    "episode 2: begun after the compaction with SMD-1843, the move to its worktree and branch its own; a mention of the earlier ticket while on its branch does not end it; ended when SMD-1917 was taken up, its span its content's");
  assert(e3.prompts.length === 1 && /^now smd-1917/.test(e3.prompts[0]) && e3.opened.kind === "ticket" && e3.opened.ticket === "SMD-1917" && e3.branch === "michaelharris/smd-1917-fork-md" && e3.outcome === "Pushed." && [...e3.files].join() === "/repo/wt/smd-1917-fork-md/scripts/fork-index.ts" && e3.retrieved.size === 0 && e3.closed.kind === "compaction" && e3.last === t("11", "06"),
    "episode 3: opened AT the ask naming the new ticket — typed on the old branch, the session moved to the ticket's branch before the next ask — with the file and the outcome that followed; ended at the second compaction");
  assert(e4.prompts.join() === "review for issues" && e4.opened.kind === "compaction" && e4.opened.ticket === undefined && [...e4.retrieved].join() === uuid(15) && !e4.closed && e4.first === t("11", "10") && e4.last === t("11", "20") && e4.sessionId === E_SID && e4.harness === "claude-code",
    "episode 4: begun after the second compaction, asked without a ticket, still open");
  assert(eps.map((e) => provenanceOf(e).join()).join("|") === [uuid(11), [uuid(12), uuid(13), uuid(14)].join(), "", uuid(15)].join("|"), "derived_from is split per episode: the ids retrieved and captured inside it, not the session's union");
  const [x1, x2, x3, x4] = eps.map(renderSummary);
  assert(/^Session summary — SMD-1844 — claude-code — main-wt \(michaelharris\/smd-1844-loopback\) — 2026-09-24\n/.test(x1) && /\n\nChanged: 1 file — deploy\/compose\.yaml; 1 commit\.\n\nBrain: retrieved 1 thought \(recorded as this summary's provenance\)\.\n\nEpisode 1 of the session, ended at a compaction\.\n\nSession s-ep, 2026-09-24 09:00 → 2026-09-24 09:40\.$/.test(x1),
    `episode 1's text: the ticket first, its own files and brain line, its episode line before its span (${x1.split("\n").slice(-3).join(" | ")})`);
  assert(/^Session summary — SMD-1843, SMD-1844 — claude-code — smd-1843-env \(michaelharris\/smd-1843-env\) — 2026-09-24\n\nTitle: create a new branch to plan and implement smd-1843\n/.test(x2) && /\n\nBrain: retrieved 2 thoughts, captured 1 \(recorded/.test(x2) && /\n\nEpisode 2 of the session, begun after a compaction with SMD-1843, ended when SMD-1917 was taken up\.\n\nSession s-ep, 2026-09-24 10:00 → 2026-09-24 10:30\.$/.test(x2),
    "episode 2's text names the tickets its asks named, the first first, is titled by its first ask, and says how it began and ended");
  assert(/^Session summary — SMD-1917 — claude-code — smd-1917-fork-md \(michaelharris\/smd-1917-fork-md\)/.test(x3) && /\n\nEpisode 3 of the session, begun with SMD-1917, ended at a compaction\./.test(x3) && /^Session summary — SMD-1917 — claude-code — smd-1917-fork-md/.test(x4) && /\n\nEpisode 4 of the session, begun after a compaction\.\n\nSession s-ep, 2026-09-24 11:10 → 2026-09-24 11:20\.$/.test(x4),
    "episode 3 begun with its ticket; episode 4, asked without one, is named by its branch's, and open — no ended clause");
  assert(!/Episode/.test(renderSummary(s)) && /^Session summary — SMD-1844, SMD-1843, SMD-1917 — claude-code — smd-1917-fork-md/.test(renderSummary(s)) && !/Episode/.test(renderSummary(summariseTranscript(CLAUDE_T))) && !/Episode/.test(renderSummary(summariseTranscript(CLAUDE_T).episodes[0])),
    "the session's own summary and a session of one episode carry no episode line: a session of one episode reads as before");
  // Stability under append: every prefix of the transcript segments into a prefix of the whole's episodes, its closed ones word for word.
  {
    let stable = true;
    for (let k = 1; k <= episodesLines.length; k++) {
      writeFileSync(join(TMP, "prefix.jsonl"), episodesLines.slice(0, k).join("\n"));
      for (const ep of summariseTranscript(join(TMP, "prefix.jsonl")).episodes) {
        const whole = eps[ep.n - 1];
        // An open episode's LAST ask may be one the whole gives to the next episode: an ask naming a new ticket, its move not yet written (the one boundary decided by what follows).
        const settled = ep.closed ? ep.prompts : ep.prompts.slice(0, -1);
        if (!whole || (ep.opened?.kind ?? "-") !== (whole.opened?.kind ?? "-") || settled.some((p, i) => whole.prompts[i] !== p) || (ep.closed && renderSummary(ep) !== renderSummary(whole))) stable = false;
      }
    }
    assert(stable, "appending to the transcript never moves an earlier boundary: every prefix's closed episodes render word for word as the whole's, and its open one is a prefix of its counterpart but for an ask whose move is not yet written");
    writeFileSync(join(TMP, "prefix.jsonl"), episodesLines.slice(0, episodesLines.indexOf(episodesLines.find((l) => /now smd-1917/.test(l))) + 1).join("\n"));
    const undecided = summariseTranscript(join(TMP, "prefix.jsonl")).episodes;
    assert(undecided.length === 2 && undecided[1].prompts.length === 3 && /^now smd-1917/.test(undecided[1].prompts[2]), "…that ask, with nothing yet after it, is the earlier episode's: the boundary is decided by the move that follows");
  }

  // prepare(): one payload per episode, on its own chain.
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const cfg = { url: URL_, key: "cap-key" };
  const pe = prepare({ session_id: E_SID, transcript_path: EPISODES_T, cwd: "/repo/wt/smd-1917-fork-md", hook_event_name: "SessionEnd" });
  assert(pe.code === 0 && pe.payloadPaths.length === 4 && pe.payloadPath === pe.payloadPaths[3] && pe.payload.episode === 4 && /^prepared: session s-ep, episodes 1, 2, 3, 4 of 4 — 1: 2 prompt\(s\), 1 source id\(s\); 2: 2 prompt\(s\), 3 source id\(s\); 3: 1 prompt\(s\), 0 source id\(s\); 4: 1 prompt\(s\), 1 source id\(s\)$/.test(pe.message),
    `one payload per episode, the newest the run's own, the message naming each (${pe.message})`);
  const bodies = pe.payloadPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  assert(bodies.map((b) => b.chain_id).join() === "s-ep,s-ep#e2,s-ep#e3,s-ep#e4" && bodies.every((b) => b.session_id === E_SID) && bodies.map((b) => b.episode).join() === "1,2,3,4" && pe.payloadPaths.map((p) => basename(p).split("-").slice(3).join("-")).join() === "s-ep.json,s-ep_e2.json,s-ep_e3.json,s-ep_e4.json",
    "each payload carries its session and its chain — the first the session's own id, the rest keyed under it — and is named for its chain");
  assert(bodies.every((b) => b.supersedes === undefined) && bodies[0].derived_from.join() === uuid(11) && bodies[1].derived_from.join() === [uuid(12), uuid(13), uuid(14)].join() && bodies[2].text === x3, "no episode has a predecessor yet; each carries its own provenance and text");
  assert(/^Session summary — SMD-1844 — claude-code — main-wt \(/.test(bodies[0].text) && /^Session summary — SMD-1917 — claude-code — smd-1917-fork-md \(/.test(bodies[3].text), "the hook's cwd is the open episode's place, not a closed one's");
  const twin = prepare({ session_id: E_SID, transcript_path: EPISODES_T, cwd: "/repo/wt/smd-1917-fork-md", hook_event_name: "SessionEnd" });
  assert(twin.payloadPaths.length === 0 && /^skip: session s-ep's 4 episodes are already captured or queued \(the newest as a pending payload\)$/.test(twin.message) && readdirSync(join(STATE, "pending")).length === 4,
    `the same ending again before anything posts writes no twin: every episode is deduped against its own queue (${twin.message})`);
  const outs = await postPending(cfg, pe.payloadPaths);
  assert(outs.length === 4 && outs.every((o) => o.ok) && received.length === 4 && received.map((r) => r.args.derived_from?.length ?? 0).join() === "1,3,0,1" && ["s-ep", "s-ep_e2", "s-ep_e3", "s-ep_e4"].every((f) => existsSync(join(STATE, `${f}.json`))) && readdirSync(join(STATE, "pending")).length === 0,
    `the run posts every episode, oldest first, each with its own provenance, and records four states (${received.map((r) => r.args.content.split("\n")[0].slice(18, 40)).join(" | ")})`);
  const ids = ["s-ep", "s-ep#e2", "s-ep#e3", "s-ep#e4"].map((c) => readState(c).thought_id);
  // A re-ending with one more ask: only the last episode changes, and supersedes its own.
  episodesLines.push(ask("one more look", { ...C, ts: t("11", "30") }), say("Still clean.", { ...C, ts: t("11", "31") }));
  writeFileSync(EPISODES_T, episodesLines.join("\n"));
  const again = prepare({ session_id: E_SID, transcript_path: EPISODES_T, hook_event_name: "SessionEnd" });
  assert(again.payloadPaths.length === 1 && again.payload.episode === 4 && again.payload.supersedes === ids[3] && /^prepared: session s-ep, episode 4 of 4 \(3 unchanged\) — 4: 2 prompt\(s\), 1 source id\(s\), supersedes 00001004-/.test(again.message),
    `after one more ask only the last episode is prepared, superseding its own earlier summary (${again.message})`);
  await postPending(cfg, again.payloadPaths);
  assert(received.length === 5 && received[4].args.supersedes === ids[3] && ["s-ep", "s-ep#e2", "s-ep#e3"].every((c, i) => readState(c).thought_id === ids[i]) && readState("s-ep#e4").thought_id === uuid(1005),
    "…and posts it alone: the earlier episodes' thoughts and states are untouched");
  assert(/^skip: session s-ep's 4 episodes are already captured \(the newest as 00001005-/.test(prepare({ session_id: E_SID, transcript_path: EPISODES_T, hook_event_name: "SessionEnd" }).message), "the same transcript again: every episode is a skip, said once");
  // A new episode inside the Stop interval is not a reason to capture: the gate reads the session's last attempt across its chains (first review pass).
  const D = { cwd: "/repo/wt/smd-2014-model", branch: "michaelharris/smd-2014-model" };
  writeFileSync(join(TMP, "episodes-five.jsonl"), [...episodesLines, ask("now smd-2014: the opt-in model summary", { ...C, ts: t("12", "00") }), say("Planned.", { ...D, ts: t("12", "05") })].join("\n"));
  const gated = prepare({ session_id: E_SID, transcript_path: join(TMP, "episodes-five.jsonl"), hook_event_name: "Stop" }, { minIntervalMin: 20 });
  const ungated = prepare({ session_id: E_SID, transcript_path: join(TMP, "episodes-five.jsonl"), hook_event_name: "Stop" });
  assert(/^skip: last capture 0 min ago, interval 20$/.test(gated.message) && ungated.payloadPaths.length === 2 && ungated.payload.episode === 5 && /Episode 4 of the session, begun after a compaction, ended when SMD-2014 was taken up\./.test(JSON.parse(readFileSync(ungated.payloadPaths[0], "utf8")).text),
    `a Stop inside the interval skips though a fifth episode has opened; without the interval it prepares the closed fourth and the new fifth (${gated.message} | ${ungated.message.slice(0, 60)})`);
  for (const p of ungated.payloadPaths) unlinkSync(p);
  // A checkpoint is the open episode's alone.
  const cpE = prepare({ session_id: "s-ep-cp", transcript_path: EPISODES_T, hook_event_name: "PreCompact", trigger: "auto" });
  const cpBodies = cpE.payloadPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  assert(cpBodies.length === 4 && cpBodies.slice(0, 3).every((b) => !/Checkpoint:/.test(b.text) && b.event === "" && b.trigger === undefined) && /\n\nEpisode 4 of the session, begun after a compaction\.\n\nCheckpoint: compacted at 2026-09-24 11:31 \(auto\), continuing/.test(cpBodies[3].text) && cpBodies[3].event === "PreCompact" && cpBodies[3].trigger === "auto" && /^prepared: session s-ep-cp \(PreCompact auto\), episodes 1, 2, 3, 4 of 4/.test(cpE.message),
    "at a compaction, the closed episodes' summaries name no checkpoint — they are over, and their payloads carry no event — and the open one's does, after its episode line");
  // A secret in one episode refuses that episode alone.
  writeFileSync(join(TMP, "episodes-secret.jsonl"), episodesLines.map((l) => l.replace("also note SMD-1844's compose fix is merged already", "also note SMD-1844's fix is merged; MCP_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz012345 was the key")).join("\n"));
  const sec = prepare({ session_id: "s-ep-sec", transcript_path: join(TMP, "episodes-secret.jsonl"), hook_event_name: "SessionEnd" }, { onSecret: "refuse" });
  assert(sec.code === 1 && sec.payloadPaths.length === 3 && /^refused — episode 2 of session s-ep-sec carries what looks like a secret \(episode 2: credential assignment[^)]*\); that episode is not sent, the other 3 episodes post\. Remove it from the conversation before ending the session, or capture by hand\. \| prepared: session s-ep-sec, episodes 1, 3, 4 of 4 — 1: /.test(sec.message) && !/abcdefghijklmnop/.test(sec.message) && sec.payloadPaths.every((p) => !/_e2\.json$/.test(p)),
    `a secret in one episode refuses that episode alone, exit 1, the others prepared (${sec.message.slice(0, 140)})`);
  writeFileSync(join(TMP, "one-secret.jsonl"), [ask("MCP_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz012345 please"), say("no")].join("\n"));
  assert(/^refused — the summary for session s-one-sec carries what looks like a secret \(credential assignment[^)]*\); nothing sent\./.test(prepare({ session_id: "s-one-sec", transcript_path: join(TMP, "one-secret.jsonl"), hook_event_name: "SessionEnd" }, { onSecret: "refuse" }).message), "…while a session of one episode is refused in the words it always was");
  // Under redact (the default, SMD-2127): the episode's secret is blanked and all four are prepared; the episode's payload alone records a redaction.
  const secRed = prepare({ session_id: "s-ep-sec-red", transcript_path: join(TMP, "episodes-secret.jsonl"), hook_event_name: "SessionEnd" });
  assert(secRed.code === 0 && secRed.payloadPaths.length === 4 && /^prepared: session s-ep-sec-red, episodes 1, 2, 3, 4 of 4 — 1: 2 prompt\(s\), 1 source id\(s\); 2: 2 prompt\(s\), 3 source id\(s\), redacted: credential assignment, high-entropy token at char \d+ in prompt 2; 3: /.test(secRed.message) && !/abcdefghijklmnop/.test(secRed.message),
    `under redact the episode's secret is blanked and all four prepared, the message saying which episode, what and where (${secRed.message.slice(0, 200)})`);
  const secBodies = secRed.payloadPaths.map((p) => JSON.parse(readFileSync(p, "utf8")));
  assert(/MCP_ACCESS_KEY=\[redacted:credential assignment, high-entropy token\] was the key/.test(secBodies[1]?.text ?? "") && secBodies[1]?.redactions?.length === 1 && [0, 2, 3].every((i) => !("redactions" in secBodies[i])) && !JSON.stringify(secBodies).includes("abcdefghijklmnop"),
    "…episode 2's payload carries the marker where the key was and one redaction; the other three carry no redactions field");
  for (const p of secRed.payloadPaths) unlinkSync(p);
  // The cap: the run's child takes the newest five; older episodes wait for a later run.
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const many = [];
  for (let i = 1; i <= 7; i++) { const o = { cwd: `/repo/wt/smd-${3000 + i}`, branch: `me/smd-${3000 + i}-x`, ts: t("12", String(i).padStart(2, "0")) }; many.push(ask(`work on smd-${3000 + i}`, o), say(`done ${i}`, o)); }
  writeFileSync(join(TMP, "seven.jsonl"), many.join("\n"));
  const seven = prepare({ session_id: "s-seven", transcript_path: join(TMP, "seven.jsonl"), hook_event_name: "SessionEnd" });
  assert(seven.payloadPaths.length === 7 && readdirSync(join(STATE, "pending")).length === 7 && /^prepared: session s-seven, episodes 1, 2, 3, 4, 5, 6, 7 of 7 — /.test(seven.message), `seven episodes: seven payloads written, every one handed to the run's child — the five per run bound what waited from before, not the run's own (${seven.message.slice(0, 60)})`);
  prepare({ session_id: "s-stranded-seven", transcript_path: CODEX_T, hook_event_name: "SessionEnd" }); // one from before, waiting
  const sevenRun = await postPending(cfg, seven.payloadPaths);
  assert(sevenRun.length === 7 && sevenRun.every((o) => o.ok) && readdirSync(join(STATE, "pending")).length === 1 && received.length === 7 && RUN_MAX === 5, "the child posts its seven and nothing else: with more own than the five, no room is left for what waited (second review pass: the run's own two oldest waited for a run that might never come)");
  assert((await postPending(cfg)).length === 1 && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(STATE).filter((f) => /^s-seven.*\.json$/.test(f)).length === 7, "…and the next run takes the one that waited");
  // As a hook, synchronous and detached.
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const he = await runHook({ session_id: "s-ep-hook", transcript_path: EPISODES_T, cwd: "/repo/wt/smd-1917-fork-md", hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(he.code === 0 && (he.err.match(/session-capture: captured 0000/g) ?? []).length === 4 && received.length === 4, `as a hook, synchronous: four captures, four lines on stderr (exit ${he.code}: ${he.err.trim().split("\n").length} line(s))`);
  const epLog = readFileSync(join(STATE, "log"), "utf8");
  assert(/captured session=s-ep-hook harness=claude-code id=/.test(epLog) && /captured session=s-ep-hook episode=2 harness=claude-code id=/.test(epLog) && /captured session=s-ep-hook episode=4 harness=claude-code id=/.test(epLog), "the log names the episode after the first");
  const hs = await runHook({ session_id: "s-ep-hook-sec", transcript_path: join(TMP, "episodes-secret.jsonl"), cwd: "/repo/wt/smd-1917-fork-md", hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1", OB1_CAPTURE_ON_SECRET: "refuse" });
  assert(hs.code === 1 && /refused — episode 2 of session s-ep-hook-sec/.test(hs.err) && (hs.err.match(/session-capture: captured 0000/g) ?? []).length === 3 && received.length === 7 && !readState("s-ep-hook-sec#e2") && readState("s-ep-hook-sec#e3")?.thought_id,
    `a secret in one episode under refuse: exit 1 naming it, the other three captured (${hs.err.trim().split("\n").length} line(s))`);
  const hr = await runHook({ session_id: "s-ep-hook-red", transcript_path: join(TMP, "episodes-secret.jsonl"), cwd: "/repo/wt/smd-1917-fork-md", hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(hr.code === 0 && (hr.err.match(/session-capture: captured 0000/g) ?? []).length === 4 && received.length === 11 && readState("s-ep-hook-red#e2")?.thought_id && received.slice(7).filter((r) => /MCP_ACCESS_KEY=\[redacted:credential assignment, high-entropy token\] was the key/.test(r.args.content)).length === 1 && !received.slice(7).some((r) => /abcdefghijklmnop/.test(r.args.content)),
    `…and under redact (the default) all four capture, exit 0, the marker in what reached the endpoint and the key nowhere (${hr.err.trim().split("\n").length} line(s))`);
  assert(/captured session=s-ep-hook-red episode=2 harness=claude-code id=\S+ sources=3 redactions=1\n/.test(readFileSync(join(STATE, "log"), "utf8")) && !/session=s-ep-hook-red harness=claude-code id=\S+ sources=1 redactions/.test(readFileSync(join(STATE, "log"), "utf8")), "…the log line counts the redactions on that episode's capture and no other");
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const hd = await runHook({ session_id: "s-ep-detached", transcript_path: EPISODES_T, cwd: "/repo/wt/smd-1917-fork-md", hook_event_name: "SessionEnd" });
  assert(hd.code === 0 && hd.ms < 1500, `detached: the foreground exits 0 in ${hd.ms} ms with four payloads to post`);
  const t0 = Date.now();
  while ((received.length < 4 || !readState("s-ep-detached#e4")) && Date.now() - t0 < 10_000) await sleep(50);
  assert(received.length === 4 && ["s-ep-detached", "s-ep-detached#e2", "s-ep-detached#e3", "s-ep-detached#e4"].every((c) => readState(c)?.thought_id) && /posting in pid \d+/.test(readFileSync(join(STATE, "log"), "utf8")) && readdirSync(join(STATE, "pending")).length === 0,
    `…and one child posted all four and recorded four states (${received.length} after ${Date.now() - t0} ms)`);
}

{
  // A state file names its chain, so a session id that sanitises to another
  // chain's file does not cross-read it (third review pass): `x#e2` and a
  // session literally `x_e2` both name x_e2.json.
  console.log("\n[3c] A chain's state file names its chain, so a colliding session id does not cross-read it (SMD-2013)");
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const collideCfg = { url: URL_, key: "cap-key" };
  const cl = (role, text, branch, ts) => line({ type: role, sessionId: "x", timestamp: ts, cwd: "/r", gitBranch: branch, message: { role, content: role === "user" ? text : [{ type: "text", text }] }, origin: { kind: "human" } });
  writeFileSync(join(TMP, "two-ep.jsonl"), [cl("user", "do smd-1000", "me/smd-1000-a", "2026-09-24T09:00:00.000Z"), cl("assistant", "one", "me/smd-1000-a", "2026-09-24T09:05:00.000Z"), cl("user", "now smd-2000", "me/smd-2000-b", "2026-09-24T09:10:00.000Z"), cl("assistant", "two", "me/smd-2000-b", "2026-09-24T09:15:00.000Z")].join("\n"));
  const two = prepare({ session_id: "x", transcript_path: join(TMP, "two-ep.jsonl"), hook_event_name: "SessionEnd" });
  await postPending(collideCfg, two.payloadPaths);
  assert(existsSync(join(STATE, "x.json")) && existsSync(join(STATE, "x_e2.json")) && JSON.parse(readFileSync(join(STATE, "x_e2.json"), "utf8")).chain_id === "x#e2", "session x's episode 2 records its chain in x_e2.json");
  const collide = prepare({ session_id: "x_e2", transcript_path: join(TMP, "two-ep.jsonl"), hook_event_name: "SessionEnd" });
  assert(collide.payloadPaths.length === 2 && /^prepared: session x_e2, episodes 1, 2 of 2 —/.test(collide.message) && !/already captured/.test(collide.message) && JSON.parse(readFileSync(collide.payloadPaths[0], "utf8")).supersedes === undefined,
    `a session literally named x_e2 does not read x's episode-2 state as its own: it prepares fresh, superseding nothing, not "already captured" (${collide.message.slice(0, 70)})`);
  for (const p of collide.payloadPaths) unlinkSync(p);
}

// ── [4] Secret scan ──────────────────────────────────────────────────────────
// Two 64-character base64 lines of a key block: one has a run of thirty-two and is a hit on its own, the other has none (its slashes split it) and is not (third review pass).
const SEEDED = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB";
const SEEDLESS = "ZVEiR2BwpZOOkE/Z0/BVnhZYL71oZV34bKfWjQIt6V/isSMahdsAASACp4ZTGtwi";
console.log("\n[4] The secret scan catches every shape it names and leaves the summary's own tokens alone");
{
  const probes = [
    ["anthropic key", "sk-ant-api03-" + "Ab1".repeat(12)],
    ["openai key", "sk-proj-" + "Zq9".repeat(14)],
    ["aws access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["github token", "ghp_" + "a1B2c3D4".repeat(5)],
    ["github token", "github_pat_11ABCDEFG0123456789_" + "x".repeat(20)],
    ["slack token", "xoxb-1234567890-abcdefghij"],
    ["google api key", "AIza" + "Sy" + "B".repeat(33)],
    ["stripe key", "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"],
    ["sendgrid key", "SG." + "aBcDeFgHiJkLmNoPqRsTuV" + "." + "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-aBcDe"],
    ["linear key", "lin_api_" + "a1b2c3d4e5f6g7h8i9j0k1l2"],
    ["hugging face token", "hf_" + "AbCdEfGhIjKlMnOpQrStUvWxYz012345"],
    ["npm token", "npm_" + "a".repeat(36)],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"],
    ["private key block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["url with a password", "postgres://postgres:s3cretpassw0rd@postgres:5432/openbrain"],
    ["credential assignment", "x-brain-key: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
    ["credential assignment", "MCP_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz012345"],
    ["password assignment", 'password: "correct-horse-battery-staple"'],
    ["credential assignment", "OB1_WORKER_KEY=" + "f0".repeat(32)],
    ["credential assignment", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["credential assignment", "MY_API_KEY=abc/def/ghijklmnopqrstuvwxyz0123456789"],
    ["credential assignment", "SECRET_KEY_BASE=abcdefghijklmnop12"],
    ["credential assignment", "export SLACK_TOKEN=abcdefghijklmnopqrstuvwxyz01"],
    ["credential flag", "tool --api-key abcdefghijklmnopqrstuv7 --quiet"],
    ["credential flag", "tool --secret-key Hb7xQ9mZpL2vR4tW8yKcN3dF"],
    ["credential flag", "tool --token=ghq_1234567890abcdefghij"],
    ["credential flag", "tool --client-secret Ab3dE5fG7hI9jK1lM3nO5p"],
    ["password flag", "psql --password hunter2 -h db"],
    ["bearer token", "Authorization: Bearer " + "Ab9".repeat(12)],
    ["password assignment", "POSTGRES_PASSWORD=hunter2"],
    ["64-hex token (a raw key, or a digest out of its context)", "use this key for the hook: " + "3f9a" .repeat(16)],
    ["64-hex token (a raw key, or a digest out of its context)", "0123456789abcdef".repeat(4)],
    ["64-hex token (a raw key, or a digest out of its context)", "0x" + "0123456789abcdef".repeat(4)],
    ["64-hex token (a raw key, or a digest out of its context)", "run sha256sum first, then paste the hook key " + "3f9a".repeat(16) + " into the config"],
    ["64-hex token (a raw key, or a digest out of its context)", "the key is " + "3f9a".repeat(16) + "  and then we moved on"],
    ["password assignment", "the password: Tr0ub4dor&3 was in the compose file"],
    ["url with a password", "postgres://user:p@ss@host:5432/db"],
    ["slack webhook url", "https://hooks.slack.com/services/" + "T0123456789/B0123456789/" + "abcdefghijklmnopqrstuvwx"], // split so GitHub's push protection does not read the probe as a live webhook
    ["access key in a URL", "see http://127.0.0.1:8010/?key=" + "3f9a".repeat(16)],
    ["access key in a URL", "https://brain.example.com/mcp?x=1&access_token=" + "Ab9".repeat(12)],
    ["access key in a URL", "http://h/?key=" + "k".repeat(20)],
    ["access key in a URL", "https://acct.blob.core.windows.net/c/f.txt?sv=2022&sig=" + "Ab9%2F".repeat(8)],
  ];
  for (const [name, probe] of probes) {
    const f = scanForSecrets(`the summary says ${probe} and goes on`);
    assert(f.some((x) => x.reason === name), `caught: ${name}`);
  }
  assert(SECRET_PATTERNS.every(([name]) => probes.some((p) => p[0] === name)), "every named pattern has a probe above");
  const highEntropy = "kQ7vX2pL9mN4rT8wZ1yB6cF3hJ5gD0sA";
  assert(scanForSecrets(`token ${highEntropy} here`).some((x) => x.reason === "high-entropy token"), "a 32-character mixed-case token with digits and high entropy is caught by shape");
  assert(scanForSecrets(`see https://example.com/?t=${highEntropy}`).length === 0 && scanForSecrets(`img data:image/png;base64,${highEntropy}${highEntropy}`).length === 0,
    "…but not inside a URL or a base64 data URI");
  assert(scanForSecrets("key " + "Zq9Xw2Vb7Nm4Kp1Lt8Rs5Yh3Gf6Dj0Ca" + "Qe4Wr7Ty2Ui9Op5As" ).some((x) => x.reason === "high-entropy token"), "a 49-character key-shaped token is caught at the lower bar");
  // Each threshold pinned alone (second review pass: the three covered for each other).
  assert(scanForSecrets("t ahObiPcj1dK2eL3fM4gNahObiPcj1dK2eL3fM4gN t").length === 0, "a 40-character token at 4.32 bits is clean — the bar under 48 is 4.5");
  assert(scanForSecrets("t adgjM14cfiMP3beiLO2aehKN1adgjM14cfiMP3beiLO2aehKN1ad t").some((x) => x.reason === "high-entropy token"), "a 52-character token at 4.23 bits is caught — the bar from 48 is 4.2");
  assert(scanForSecrets("t fetchUserAccountBalanceByIdV3LegacyQuickJumpsOverWXZ2026 t").length === 0, "a 56-character identifier at 4.9 bits is clean — word-shaped");
  const clean = [
    uuid(1), "8541cec9f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6", "session-hook:capture:" + "0123456789abcdef".repeat(4), "laptop:write:" + "ab12".repeat(16) + ",chatgpt:read:" + "cd34".repeat(16),
    "sha256:" + "0123456789abcdef".repeat(4), "docker.io/oven/bun@sha256:" + "0123456789abcdef".repeat(4),
    "https://github.com/o/r/commit/" + "0123456789abcdef".repeat(4), "https://bucket.s3.amazonaws.com/blobs/" + "0123456789abcdef".repeat(4) + "?x=1",
    "recipes/session-capture-hook/session-capture.mjs", "ob1-fork-md-front-door-1917.md", "michaelharris/smd-1298-session-end-capture",
    "https://github.com/MHarris-SgyMd/OB1/pull/101", "Session summary — claude-code — OB1 (main) — 2026-09-22", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "the password is stored in a file", "a token of appreciation", "Bearer authentication is used by the connector", "the API key is set in the env", "api_keys: 3 (rotated)", "KEYS_WITH_CAPTURE = the fixture's list",
    // References, not values (twelfth review pass): compose's own line, an env accessor, a dotted identifier, a placeholder, a flag handed a variable.
    "- OB1_LLM_API_KEY=${OB1_LLM_API_KEY:-}", "OB1_CAPTURE_KEY: ${OB1_CAPTURE_KEY}", "apiKey: process.env.OPENAI_API_KEY", "export OPENAI_API_KEY=$OPENAI_API_KEY_PROD",
    "accessToken: session.accessToken,", "client_secret: process.env.GOOGLE_CLIENT_SECRET,", "OPENAI_API_KEY: ${{secrets.OPENAI_API_KEY}}", "OB1_LLM_API_KEY=<your-openai-key-here>",
    "tool --api-key \"$OPENAI_API_KEY\"", "theBearer: 'abcdefghijklmnopqrstu'", "userSecret: process.env.USER_SECRET_VALUE",
    "OPENAI_API_KEY=%OPENAI_API_KEY%", "OPENAI_API_KEY=$env:OPENAI_API_KEY", "api_key: os.getenv(\"OPENAI_API_KEY\")", "tool --token=%TOKEN%",
    // Placeholders, names and calls carry no digit (thirteenth review pass): each refused a session.
    "SECRET_KEY = get_random_secret_key()", "api_key: keyring.get_password('openai', 'default')", "api_key: your-api-key-goes-here", "api_key = REPLACE_WITH_YOUR_KEY",
    "api_key: ********************", "API_KEY=changeme-change-me-before-deploy", "apiKey: {{.Values.openai.apiKey}}", "set OPENAI_API_KEY=%OPENAI_API_KEY_SOURCE%",
    "docker build --secret id=npmrc,src=$HOME/.npmrc .", "--secret id=github_token,env=GITHUB_TOKEN", "--secret /run/secrets/openai_api_key", "--token ~/.config/gh/tokenfile.txt",
    // …with a digit, so the path and reference exclusions are held on their own (the digit rule excused the lines above):
    "--secret id=npmrc2,src=$HOME/.npmrc", "--secret /run/secrets/openai_api_key_2026", "--token ~/.config/gh/token1.txt", "OPENAI_API_KEY=%OPENAI_API_KEY_2%", "apiKey: {{.Values.openai.apiKey2}}",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "getUserAccountBalanceById2026Version3", "fetchUserAccountBalanceByIdV3Legacy2026 and renderSessionSummaryForHarness2026Codex",
    "https://docs.google.com/document/d/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2wX3yZ4a/edit", "https://www.notion.so/team/Design-Review-1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1u",
    "DATABASE_URL=postgres://ob1@127.0.0.1:5432/openbrain", "MCP_ACCESS_KEYS=laptop:write:" + "ab12".repeat(16) + ",session-hook:capture:" + "cd34".repeat(16),
    "ACTIONLINT_SHA256=" + "9f86".repeat(16), "--sha256 " + "9f86".repeat(16), "\n" + "9f86".repeat(16) + "  actionlint_1.7.7_linux_amd64.tar.gz", "\n" + "9f86".repeat(16) + "  a.tgz: OK\n" + "8e75".repeat(16) + "  b.tgz: OK", "sha256: " + "9f86".repeat(16), "SHA-256 = " + "9f86".repeat(16), "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>",
    "/Users/mharris/.claude/projects/-Users-mharris-Projects-OB1/memory/ob1-compose-loopback-1844.md",
    "/private/tmp/claude-501/-Users-mharris-Projects-OB1/8de5e1e1-c72c-4b7f-aa81-ccbce6558ef6/scratchpad/smd1298/patch1-server.py",
    // A bracketed value is a placeholder — this script's own marker first of all: the second scan must not read it as a value (SMD-2127).
    "password: [redacted:password assignment]", "psql --password [redacted:password flag] -h db", "tool --token [redacted:credential flag]", "MCP_ACCESS_KEY=[redacted:credential assignment, high-entropy token]",
    "postgres://u:[redacted:url with a password]@h/db", "Authorization: Bearer [redacted:bearer token]", "http://127.0.0.1:8010/?key=[redacted:access key in a URL]", "api_key = [YOUR_API_KEY_1]", "POSTGRES_PASSWORD=[set in the vault, rotated 2026]",
  ];
  for (const c of clean) assert(scanForSecrets(`text ${c} text`).length === 0, `clean: ${c.slice(0, 50)}`);
  assert(scanForSecrets(renderSummary(summariseTranscript(CLAUDE_T))).length === 0, "the fixture's own summary is clean");
  const f = scanForSecrets("aaa sk-ant-api03-" + "Ab1".repeat(12));
  assert(f[0].at === 4 && !JSON.stringify(f).includes("Ab1Ab1"), "a finding carries the reason and the offset, never the match");
  assert(f.length === 1 && f[0].end === 53, `…and the span's end; an anthropic key is one finding — the openai rule steps off sk-ant- (SMD-2127; ${JSON.stringify(f)})`);
  // Redaction (SMD-2127): the span is the VALUE where a rule names one, so the marker keeps the name; every match, not the first; overlapping spans are one marker; offsets stay true right to left.
  const live = "set LINEAR_API_KEY=lin_api_" + "a1b2c3d4e5f6g7h8i9j0k1l2" + " now";
  const v = scanForSecrets(live);
  assert(v.length === 3 && v.every((x) => x.at === 19 && x.end === 51) && v.map((x) => x.reason).join() === "linear key,credential assignment,high-entropy token",
    `the live shape — a linear key assigned — is three rules on ONE span, the value's, named rules first (${JSON.stringify(v.map((x) => [x.reason, x.at, x.end]))})`);
  const lr = redactSecrets(live);
  assert(lr.text === "set LINEAR_API_KEY=[redacted:linear key, credential assignment, high-entropy token] now" && lr.spans.length === 1 && lr.spans[0].at === 19 && lr.spans[0].end === 19 + "[redacted:linear key, credential assignment, high-entropy token]".length,
    `…and one redaction, the name kept, the marker naming the three (${lr.text})`);
  assert(redactionMarker(["a", "b"]) === "[redacted:a, b]", "the marker's shape");
  const two = redactSecrets("first sk-ant-api03-" + "Ab1".repeat(12) + " then POSTGRES_PASSWORD=hunter2 end");
  assert(two.text === "first [redacted:anthropic key] then POSTGRES_PASSWORD=[redacted:password assignment] end" && two.spans.map((s) => `${s.at}-${s.end}`).join() === "6-30,54-84" && two.spans.every((s) => /^\[redacted:[^\]]+\]$/.test(two.text.slice(s.at, s.end))),
    `two secrets of different lengths: each its own marker, the second's offsets true after the first's marker changed the length — replaced right to left; the spans returned are the markers' places in the blanked text (${two.text})`);
  const twice = redactSecrets("the key is sk-ant-api03-" + "Ab1".repeat(12) + " and again sk-ant-api03-" + "Ab1".repeat(12));
  assert(twice.spans.length === 2 && !/Ab1Ab1/.test(twice.text) && scanForSecrets(twice.text).length === 0, "the same key twice is blanked twice: every match of a pattern, where the report reads the first");
  assert(scanForSecrets("a sk-ant-api03-" + "Ab1".repeat(12) + " b sk-ant-api03-" + "Ab1".repeat(12)).length === 1 && scanForSecrets("a sk-ant-api03-" + "Ab1".repeat(12) + " b sk-ant-api03-" + "Ab1".repeat(12), { every: true }).length === 2, "…the report's scan stays one finding per pattern; `every` is the redaction's");
  const block = redactSecrets("key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\nabc\n-----END RSA PRIVATE KEY-----\nthen");
  assert(block.text === "key:\n[redacted:private key block]\nthen", `a private key block is blanked header to footer, its body with it (${JSON.stringify(block.text)})`);
  assert(redactSecrets("-----BEGIN OPENSSH PRIVATE KEY----- and nothing else").text === "[redacted:private key block] and nothing else", "…the header alone when there is no footer");
  const pw = redactSecrets("postgres://postgres:s3cretpassw0rd@postgres:5432/openbrain and Bearer " + "Ab9".repeat(12) + " and http://h/?key=" + "3f9a".repeat(16));
  assert(pw.text === "postgres://[redacted:url with a password]@postgres:5432/openbrain and Bearer [redacted:bearer token] and http://h/?key=[redacted:access key in a URL]".replace("postgres://[", "postgres://postgres:[") && scanForSecrets(pw.text).length === 0,
    `a URL keeps its user and host, a bearer its word, a query its key name — the value alone is blanked (${pw.text})`);
  // The fixpoint: every shape the scan names is blanked to a text the scan finds clean — the marker is a hit on no rule, and no rule outruns its span.
  for (const [name, probe] of probes) {
    const t = `the summary says ${probe} and goes on`;
    const r = redactSecrets(t);
    assert(r.spans.length >= 1 && r.text !== t && scanForSecrets(r.text).length === 0, `blanked, then clean: ${name} (${r.text.slice(0, 70)})`);
  }
  assert(redactSecrets("nothing here but prose and a uuid " + uuid(4)).text === "nothing here but prose and a uuid " + uuid(4), "a clean text is returned as it was");
  // First review pass: the token's span is the WHOLE bare secret — base64 carries `/`, which the class leaves out for paths; a body's own `=` is no name — and a value's trailing punctuation is the sentence's.
  const b64 = "L4HmvD0hgfx/z2Ov9zukFDtJufEIt41DZORiSBylHXw=";
  assert(redactSecrets(`the value ${b64} for the run`).text === "the value [redacted:high-entropy token] for the run" && scanForSecrets(`the value ${b64} for the run`)[0]?.at === 10, `a base64 token with a slash is blanked whole, not from the slash on (${redactSecrets(`the value ${b64} for the run`).text})`);
  assert(redactSecrets("x dGVzdGtleQ==bm90aGVyc2VjcmV0MTIzNDU2Nzg5MA== y").text === "x [redacted:high-entropy token] y" && redactSecrets("x QUJDREVGR0hJSktMTU5PUFFSU1Q1=MTIzNDU2Nzg5MEFCQ0RFRjEyMw== y").text === "x [redacted:high-entropy token] y",
    "a token whose own body carries `=` keeps no head: only a snake-case NAME= — an underscore in it — is a name");
  assert(redactSecrets(`FOO_BAR=${highEntropy}`).text === "FOO_BAR=[redacted:high-entropy token]" && redactSecrets(`see Projects/x/${highEntropy}/y.txt now`).text === "see Projects/x/[redacted:high-entropy token]/y.txt now" && redactSecrets(`see /Users/me/Projects/${highEntropy} now`).text === "see /Users/me/Projects/[redacted:high-entropy token] now",
    "…a snake-case name stays before the marker, and a path's word-shaped segments beside a token stay");
  assert(redactSecrets("(POSTGRES_PASSWORD=hunter2) and then POSTGRES_PASSWORD=hunter2. Also --api-key abcdefghijklmnopqrstuv7).").text === "(POSTGRES_PASSWORD=[redacted:password assignment]) and then POSTGRES_PASSWORD=[redacted:password assignment]. Also --api-key [redacted:credential flag]).",
    `a closing bracket or a full stop after a value stays in the text (${redactSecrets("(POSTGRES_PASSWORD=hunter2) x").text})`);
  // Second review pass: a quoted value runs to its closing quote — the class stopped at the first space and the tail of a multi-word password was sent; an unquoted value keeps its stop; the trim is two characters at most and knows the backtick.
  const quoted = redactSecrets('password: "correct horse battery" and PGPASSWORD=\'letmein please now\' and MY_API_KEY = "abcdef1234567890 and the rest" and --api-key "abcdef1234567890 more here" then x-brain-key: "abcdef1234567890 tail words" end');
  assert(quoted.text === 'password: "[redacted:password assignment]" and PGPASSWORD=\'[redacted:password assignment]\' and MY_API_KEY = "[redacted:credential assignment]" and --api-key "[redacted:credential flag]" then x-brain-key: "[redacted:credential assignment]" end' && scanForSecrets(quoted.text).length === 0,
    `a quoted value is blanked to its closing quote, spaces and all, under every value rule (${quoted.text.slice(0, 80)})`);
  assert(redactSecrets('password: "correct horse\nbattery"').text === 'password: "[redacted:password assignment] horse\nbattery"' && redactSecrets("psql --password hunter2 then more").text === "psql --password [redacted:password flag] then more",
    "…a quote not closed on its line, or no quote, keeps the class's stop at the first space");
  assert(redactSecrets("run `MY_API_KEY=abcdef1234567890ABCDEF` please").text === "run `MY_API_KEY=[redacted:credential assignment, high-entropy token]` please" && redactSecrets("--password hunter2)). x").text === "--password [redacted:password flag]). x" && redactSecrets("PASSWORD=;;;;;;").text === "PASSWORD=[redacted:password assignment];;",
    "a closing backtick stays; the trim takes two characters at most — a longer run of punctuation is the value's own");
  // …and the token's widening reaches across a base64 body's own short run to the run beyond, while a hyphenated id or a word in capitals beside a token stays.
  assert(redactSecrets("the value 2a5e5/wha/KOs5531C25uckbnMrqZfeys5t1Q9bMYOg= for the run").text === "the value [redacted:high-entropy token] for the run", "a base64 body's short lowercase run between two longer ones joins the span");
  assert(redactSecrets(`SMD-2127/${highEntropy} and ${highEntropy}/README.md and ${highEntropy}/HEAD here`).text === "SMD-2127/[redacted:high-entropy token] and [redacted:high-entropy token]/README.md and [redacted:high-entropy token]/HEAD here",
    "a ticket id, a file name in capitals and HEAD beside a token stay — the summaries are searched by ticket");
  const tk = redactSecrets("a sk-ant-api03-" + "Ab1".repeat(12) + " b sk-ant-api03-" + "Ab1".repeat(12));
  assert(tk.spans.length === 2 && tk.spans.every((s) => tk.text.slice(s.at, s.end) === "[redacted:anthropic key]"), "the spans returned sit where the markers sit in the blanked text, the second moved by the first");
  // A BLOCK of key material spanning MULTIPLE LINES is a pasted key blob: the scope call REFUSES it, not redacts it (SMD-2127), since a precise blanking of a block leaked over four review passes. redactSecrets reports such a span in `blocks`; a secret confined to ONE line is blanked and sent.
  const A33 = "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56X"; // 34 chars, one 32-run
  const WORDISH = "vExVngytkbgo5TegmX+J7ulqDCkyimrbudns6yghqtY="; // a key line that READS word-shaped (share 0.659) and is no token hit on its own
  assert(SEEDED.length === 64 && SEEDLESS.length === 64 && scanForSecrets(SEEDED).length === 1 && scanForSecrets(SEEDLESS).length === 0, "the fixture: one line is a hit on its own, the other is not");
  assert((WORDISH.match(/[a-z]{3,}/g) ?? []).join("").length / WORDISH.length >= 0.6 && scanForSecrets(WORDISH).length === 0, "the word-shaped fixture is no token hit on its own");
  const pgp = redactSecrets(`key:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${SEEDED}\n${SEEDLESS}\n${SEEDED}\nAb3d==\n-----END PGP PRIVATE KEY BLOCK-----\nthen`);
  assert(pgp.blocks.length === 1 && /private key block/.test(pgp.blocks[0].reasons.join()), `PGP armor — a multi-line key block — is reported for refusal, not redacted (${pgp.blocks.length})`);
  assert(redactSecrets(`-----BEGIN PRIVATE KEY-----\n${SEEDLESS}\n${SEEDED}\n${SEEDLESS} and prose`).blocks.length === 1, "a footer-less PEM body across lines is a block");
  assert(redactSecrets(`paste:\n${SEEDED}\n${SEEDLESS}\n${SEEDED}\nAb3d==\nthen more`).blocks.length === 1, "a newline-wrapped blob is a block");
  assert(redactSecrets(`${A33}/xy\n${SEEDLESS}\nmore prose`).blocks.length === 1 && redactSecrets(`-----BEGIN PRIVATE KEY-----\n${SEEDED}\n${SEEDLESS}\nZWJoiPk/XvENLy5RUEiF8qxm`).blocks.length === 1,
    "a block whose interior or trailing line has no run of thirty-two is still ONE multi-line block — refused, never partially blanked (passes 3–4's leaks cannot recur)");
  assert(redactSecrets(`${SEEDED}\n${WORDISH}\nmore`).blocks.length === 1, "a word-shaped key line contiguous to a block line makes the block multi-line — refused whatever its shape (pass 5's escape closed by refusing the blob)");
  // A SINGLE-LINE secret is redacted and SENT (blocks empty).
  const inlineKey = redactSecrets("LINEAR_API_KEY=lin_api_a1b2c3d4e5f6g7h8i9j0k1l2 please");
  assert(inlineKey.blocks.length === 0 && inlineKey.text === "LINEAR_API_KEY=[redacted:linear key, credential assignment, high-entropy token] please", "an inline single-line key is redacted and sent, not refused — the live incident's shape");
  const oneLineBlob = redactSecrets(`paste: ${SEEDED} ${SEEDLESS} ${SEEDED} Ab3d== then`);
  assert(oneLineBlob.blocks.length === 0 && oneLineBlob.text === "paste: [redacted:high-entropy token] then", "a blob on ONE line is redacted whole and sent — the span covers it, no newline crossed");
  assert(redactSecrets(`the value L4HmvD0hgfx/z2Ov9zukFDtJufEIt41DZORiSBylHXw= for the run`).text === "the value [redacted:high-entropy token] for the run" && redactSecrets(`the value L4HmvD0hgfx/z2Ov9zukFDtJufEIt41DZORiSBylHXw= for the run`).blocks.length === 0,
    "a single-line base64 token with a slash is blanked whole and sent");
  assert(redactSecrets(`${SEEDED} Pneumonoultramicroscopicsilicovolcanoconiosis and fetchUserAccountBalanceByIdV3Legacy2026 and ${highEntropy}/README.md`).text === `[redacted:high-entropy token] Pneumonoultramicroscopicsilicovolcanoconiosis and fetchUserAccountBalanceByIdV3Legacy2026 and [redacted:high-entropy token]/README.md`,
    "a long word, an identifier or a file name beside a token is not a line of the block");
  assert(redactSecrets('password: “correct horse battery” and password: `correct horse battery` and password: «correct horse battery» end').text === 'password: “[redacted:password assignment]” and password: `[redacted:password assignment]` and password: «[redacted:password assignment]» end',
    "typographic quotes, guillemets and a backtick close a quoted value — the opening one is no value character");
  assert(redactSecrets("t eyJhbGciOiJSU0EtT0FFUCJ9.abcdefghij1234.abcdefghij5678.abcdefghij9012.FuKgOY7Ph6CX1oIDbrkvrA t").text === "t [redacted:jwt] t", "a five-segment JWE is blanked whole");
  assert(redactSecrets(`see /Users/me/Projects/${highEntropy}/notes.md now`).text === `see /Users/me/Projects/[redacted:high-entropy token]/notes.md now` && redactSecrets(`${highEntropy}/HEAD here`).text === "[redacted:high-entropy token]/HEAD here" && redactSecrets(`see /Users/me/Projects/${highEntropy}/notes.md now`).blocks.length === 0,
    "a token on a line WITH other words keeps its tight span and is sent — the path and HEAD around it are not a block");
  assert(redactSecrets(`note ${A33} Ab3d1x done`).text === "note [redacted:high-entropy token] Ab3d1x done" && redactSecrets(`note ${A33} Ab3d1x done`).blocks.length === 0,
    "a short base64-ish word beside an inline token, not in a block, is not eaten")
  assert(redactSecrets("t eyJhbGciOiJSU0EtT0FFUCJ9.abcdefghij1234.abcdefghij5678.abcdefghij9012.FuKgOY7Ph6CX1oIDbrkvrA t").text === "t [redacted:jwt] t", "a five-segment JWE is blanked whole, not to its third segment");
  const many = describeRedactions([...Array.from({ length: 30 }, () => ({ reason: "password assignment", at: 26, in: "prompt 1" })), { reason: "anthropic key", at: 4, in: "the outcome" }]);
  assert(many === "password assignment at chars 26, 26, 26 and 27 more in prompt 1; anthropic key at char 4 in the outcome", `the message groups a reason and source, listing three offsets and counting the rest (${many})`);
  assert(/; and 2 more$/.test(describeRedactions(Array.from({ length: 10 }, (_, i) => ({ reason: `r${i}`, at: i, in: "prompt 1" })))) && describeRedactions([{ reason: "access key in a URL", at: 3, in: "prompt 2" }]) === "access key in a URL at char 3 in prompt 2", "…eight entries then a count; a reason with ` in ` in it survives the grouping");
  // The mode: the environment's word, or an error naming what it takes — never a mode a typo picked.
  assert(secretMode({}).mode === "redact" && secretMode({ OB1_CAPTURE_ON_SECRET: "" }).mode === "redact" && secretMode({ OB1_CAPTURE_ON_SECRET: "refuse" }).mode === "refuse" && secretMode({ OB1_CAPTURE_ON_SECRET: "redact" }).mode === "redact" && SECRET_MODES.join() === "redact,refuse",
    "OB1_CAPTURE_ON_SECRET: absent or empty is redact, the two words are themselves");
  const typo = secretMode({ OB1_CAPTURE_ON_SECRET: "Redact" });
  assert(typo.mode === undefined && typo.error === 'OB1_CAPTURE_ON_SECRET takes redact or refuse, not "Redact"', `…and anything else is an error naming the words, the case included (${typo.error})`);
}

// ── [5] prepare(): decisions before any network ─────────────────────────────
console.log("\n[5] The foreground half decides, writes a payload, and never a key");
{
  rmSync(STATE, { recursive: true, force: true });
  const base = { session_id: SID, transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd", reason: "other" };
  writeFileSync(join(TMP, "two.jsonl"), [user("a second, different prompt", { origin: { kind: "human" } }), assistant([{ type: "text", text: "done" }])].join("\n"));
  writeFileSync(join(TMP, "raced.jsonl"), [user("[[state-moves]] a prompt whose post a sibling overtakes", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  // Only the brain's tool results yield provenance: another connector's `search` prints uuid-shaped ids too (eighth review pass).
  writeFileSync(join(TMP, "notion.jsonl"), [
    user("find the page", { origin: { kind: "human" } }),
    assistant([toolUse("n1", "mcp__claude_ai_Notion__search", { query: "hook" }), toolUse("n2", "mcp__open-brain__search", { query: "hook" }), toolUse("n3", "mcp__my_brain__fetch", { id: "x" }), toolUse("n4", "mcp__brainstorm-notes__fetch", { id: "y" })]),
    user([toolResult("n1", `ID: ${uuid(500)}\nID: ${uuid(501)}`), toolResult("n2", `ID: ${uuid(502)}`), toolResult("n3", `ID: ${uuid(503)}`), toolResult("n4", `ID: ${uuid(504)}`)]),
    assistant([{ type: "text", text: "found" }]),
  ].join("\n"));
  const notion = prepare({ ...base, session_id: "s-notion", transcript_path: join(TMP, "notion.jsonl") });
  assert(notion.payload && notion.payload.derived_from.join() === [uuid(502), uuid(503)].join(), `a connector's generic search yields no provenance; the brain's does, under any server named for it as a word — not a brainstorm's (${notion.payload?.derived_from.length})`);
  // The event decides the checkpoint (SMD-2012): PreCompact with its trigger, Stop a turn, SessionEnd none — and an event the hook does not know is an end, not a guess.
  assert(checkpointOf({ hook_event_name: "PreCompact", trigger: "manual" }).kind === "compacted" && checkpointOf({ hook_event_name: "PreCompact", trigger: "manual" }).trigger === "manual" && checkpointOf({ hook_event_name: "PreCompact", trigger: 7 }).trigger === undefined
    && checkpointOf({ hook_event_name: "Stop" }).kind === "running" && checkpointOf({ hook_event_name: "SessionEnd", trigger: "auto" }) === undefined && checkpointOf({}) === undefined && checkpointOf({ hook_event_name: "SubagentStop" }) === undefined,
    "checkpointOf reads the event, and a trigger only when it is manual or auto");
  assert(HOOK_EVENTS.join() === "SessionEnd,PreCompact,Stop" && Object.values(EVENTS).every((e) => "checkpoint" in e && typeof e.timeout === "boolean" && typeof e.interval === "boolean") && EVENTS.Stop.interval && !EVENTS.Stop.timeout && EVENTS.PreCompact.checkpoint === "compacted",
    "the three events are one table — what a summary there says, whether the printed hook pins a timeout, whether the command carries the interval (second review pass: four structures)");
  assert(TRIGGER_EVENTS.join() === "PreCompact" && INTERVAL_EVENTS.join() === "Stop", "…which event carries a trigger and which the interval, derived once (fourth review pass: both were still spelled as names outside it)");
  assert(HARNESSES.join() === "claude-code,codex" && HARNESS["claude-code"].timeoutSec === 10 && HARNESS.codex.timeoutSec === 3 && HARNESS.codex.label === "Codex" && /hooks\.json$/.test(HARNESS.codex.settings) && HARNESS.constructor === undefined,
    "the harnesses are one table too — label, settings path, the pinned timeout — with no inherited names (fifth review pass)");
  assert(EVENTS.PreCompact.harnesses.join() === "claude-code" && DEFAULT_EVENTS["claude-code"].join() === "SessionEnd,PreCompact" && DEFAULT_EVENTS.codex.join() === "SessionEnd" && Object.keys(DEFAULT_EVENTS).join() === "claude-code,codex",
    "…and which harness fires which, the defaults derived from it (third review pass: a second table beside the first)");
  // Object's own names are not events (third review pass: `EVENTS["constructor"]` was a function, and "toString" passed every check).
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    assert(eventSpec(name) === undefined && !HOOK_EVENTS.includes(name) && checkpointOf({ hook_event_name: name }) === undefined && /is not an event this hook captures on/.test(prepare({ ...base, session_id: `s-proto-${name.replace(/_/g, "")}`, hook_event_name: name }).message),
      `"${name}" is no event: not a checkpoint, and a hook under it is a skip`);
  }
  assert(eventSpec(7) === undefined && eventSpec(["PreCompact"]) === undefined && eventSpec("PreCompact") === EVENTS.PreCompact, "eventSpec reads a string by own property, nothing else");
  const foreign = prepare({ ...base, session_id: "s-foreign", hook_event_name: "SubagentStop" });
  assert(foreign.code === 0 && !foreign.payloadPath && /^skip: SubagentStop is not an event this hook captures on \(SessionEnd, PreCompact, Stop\)/.test(foreign.message),
    `a command pasted under an event the hook is not for is a skip, exit 0 — it fires mid-session and would post a final-looking summary over the checkpoint (second review pass; ${foreign.message})`);
  assert(prepare({ session_id: "s-no-event", transcript_path: CLAUDE_T, cwd: "/repo/proj" }).payloadPath !== undefined && !/Checkpoint:/.test(prepare({ session_id: "s-no-event-2", transcript_path: CLAUDE_T, cwd: "/repo/proj" }).payload.text),
    "…while no event at all — a run by hand — is an end, as before");
  const compact = prepare({ ...base, session_id: "s-compact", hook_event_name: "PreCompact", trigger: "auto" }, { minIntervalMin: 20 });
  assert(compact.payloadPath && compact.payload.event === "PreCompact" && compact.payload.trigger === "auto" && /\n\nCheckpoint: compacted at 2026-09-22 13:20 \(auto\), continuing/.test(compact.payload.text) && /^prepared: session s-compact \(PreCompact auto\), 3 prompt/.test(compact.message),
    `a PreCompact hook prepares a payload naming the compaction, ungated by the Stop interval (${compact.message})`);
  assert(prepare({ ...base, session_id: "s-compact", transcript_path: join(TMP, "two.jsonl"), hook_event_name: "PreCompact", trigger: "manual" }, { minIntervalMin: 20 }).payloadPath !== undefined, "…and a second compaction a moment later, the transcript grown, prepares too — the interval is Stop's alone");
  const oddTrigger = prepare({ ...base, session_id: "s-compact-odd", hook_event_name: "PreCompact", trigger: "AUTO" });
  assert(oddTrigger.payloadPath && !("trigger" in JSON.parse(readFileSync(oddTrigger.payloadPath, "utf8"))) && /\n\nCheckpoint: compacted at 2026-09-22 13:20, continuing/.test(oddTrigger.payload.text) && /\(PreCompact\), 3 prompt/.test(oddTrigger.message),
    "a trigger that is neither manual nor auto is recorded nowhere — not the payload, not the line, not the message (first review pass: the mutant recording any value survived)");
  // No timestamp anywhere: the summary is "undated", so two renders agree whatever the clock says (ninth review pass).
  writeFileSync(join(TMP, "undated.jsonl"), [line({ type: "user", sessionId: SID, message: { role: "user", content: "a prompt with no time" } }), line({ type: "assistant", sessionId: SID, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })].join("\n"));
  const undated1 = renderSummary(summariseTranscript(join(TMP, "undated.jsonl"))), undated2 = renderSummary(summariseTranscript(join(TMP, "undated.jsonl")));
  assert(undated1 === undated2 && /— undated\n/.test(undated1) && !undated1.includes(new Date().toISOString().slice(0, 10)), "a transcript with no timestamps renders 'undated', never today");
  assert(prepare({ ...base, transcript_path: join(TMP, "missing.jsonl") }).code === 0, "no transcript: skip, exit 0");
  writeFileSync(join(TMP, "quiet.jsonl"), user([toolResult("x", "ok")]) + "\n" + assistant([{ type: "text", text: "hi" }]) + "\n");
  assert(/no human prompt/.test(prepare({ ...base, transcript_path: join(TMP, "quiet.jsonl") }).message), "a session with no human prompt: skip");
  const p = prepare(base);
  assert(p.code === 0 && p.payloadPath && existsSync(p.payloadPath), `a payload is written (${p.message})`);
  const payload = JSON.parse(readFileSync(p.payloadPath, "utf8"));
  assert(payload.harness === "claude-code" && payload.session_id === SID && payload.derived_from.length === 3 && payload.supersedes === undefined,
    "…carrying harness, session, provenance, and no supersedes on a first capture");
  assert(!JSON.stringify(payload).includes("cap-key"), "…and no key: the child reads the config itself");
  assert(scanForSecrets(payload.text).length === 0 && payload.text.startsWith("Session summary"), "…and the summary text");
  // A state from an earlier capture: the same text is a no-op; a different text supersedes.
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, `${SID}.json`), JSON.stringify({ thought_id: uuid(9), fingerprint: payload.fingerprint, captured_at: new Date().toISOString() }));
  assert(/already captured as/.test(prepare(base).message), "the same summary again is a skip — idempotent per session");
  writeFileSync(join(STATE, `${SID}.json`), JSON.stringify({ thought_id: uuid(9), fingerprint: "stale", captured_at: new Date(Date.now() - 5 * 60_000).toISOString() }));
  // A different transcript, since the first payload of this summary is still pending and the same one again is a skip (eleventh review pass).
  const again = prepare({ ...base, transcript_path: join(TMP, "two.jsonl") });
  assert(again.payloadPath && JSON.parse(readFileSync(again.payloadPath, "utf8")).supersedes === uuid(9), `a changed summary supersedes the earlier thought (${again.message})`);
  assert(/already queued/.test(prepare(base).message), "…while the summary already pending is a skip, not a twin");
  // A session whose id is a hyphen-suffix of another's does not see the other's payloads (eleventh review pass: `endsWith` did).
  {
    const runAbc = prepare({ ...base, session_id: "run-abc", hook_event_name: "Stop" }, { minIntervalMin: 20 });
    assert(runAbc.payloadPath, "run-abc's Stop prepares");
    const abc = prepare({ ...base, session_id: "abc", transcript_path: join(TMP, "two.jsonl"), hook_event_name: "Stop" }, { minIntervalMin: 20 });
    assert(abc.payloadPath !== undefined, `abc's Stop is not gated by run-abc's pending payload (${abc.message})`);
    unlinkSync(runAbc.payloadPath); if (abc.payloadPath) unlinkSync(abc.payloadPath);
  }
  // The same summary queued twice with the endpoint away is one payload: the second ending is "already queued" (eleventh review pass).
  {
    const dup1 = prepare({ ...base, session_id: "s-dup" });
    const dup2 = prepare({ ...base, session_id: "s-dup" });
    assert(dup1.payloadPath && /already queued/.test(dup2.message) && dup2.payloadPath === undefined, `a pending payload with this fingerprint makes the next ending a skip (${dup2.message})`);
    // Another session's pending payload with this fingerprint is not this session's (the session is in the name, compared whole).
    writeFileSync(join(STATE, "pending", `${Date.now()}-0000-abcdef-s-other-dup.json`), JSON.stringify({ ...dup1.payload, session_id: "s-other-dup", chain_id: "s-other-dup" }));
    unlinkSync(dup1.payloadPath);
    const dup3 = prepare({ ...base, session_id: "s-dup" });
    assert(dup3.payloadPath !== undefined, `another session's payload with the same fingerprint does not make this one "already queued" (${dup3.message})`);
    unlinkSync(dup3.payloadPath); for (const f of readdirSync(join(STATE, "pending"))) if (f.endsWith("-s-other-dup.json")) unlinkSync(join(STATE, "pending", f));
  }
  // A hook that sends no session_id: the transcript's own id keys the state AND the payload, so the second ending sees the first (tenth review pass).
  {
    const codexId = summariseTranscript(CODEX_T).sessionId;
    assert(codexId, "the Codex transcript carries its own id");
    try { unlinkSync(join(STATE, `${codexId}.json`)); } catch { /* none yet */ }
    const noId = prepare({ transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
    assert(noId.payload?.session_id === codexId && existsSync(join(STATE, "pending", basename(noId.payloadPath))), `with no session_id the payload is keyed by the transcript's id (${noId.payload?.session_id})`);
    writeFileSync(join(STATE, `${codexId}.json`), JSON.stringify({ thought_id: uuid(77), fingerprint: noId.payload.fingerprint, captured_at: new Date().toISOString() }));
    assert(/already captured as/.test(prepare({ transcript_path: CODEX_T, hook_event_name: "SessionEnd" }).message), "…and the state under that id is the one the next ending reads");
    unlinkSync(noId.payloadPath); unlinkSync(join(STATE, `${codexId}.json`));
  }
  // Two payloads of this session are pending from the prepares above: the last ATTEMPT gates, not the last landing (eighth review pass).
  assert(/skip: last capture 0 min ago \(still pending\), interval 20/.test(prepare({ ...base, hook_event_name: "Stop" }, { minIntervalMin: 20 }).message), "a Stop while a payload of the session is still pending is a skip, whatever the state says");
  const parked = [p.payloadPath, again.payloadPath].map((f) => { const to = join(TMP, basename(f)); renameSync(f, to); return [to, f]; });
  assert(/skip: last capture 5 min ago, interval 20/.test(prepare({ ...base, hook_event_name: "Stop" }, { minIntervalMin: 20 }).message), "a Stop inside the interval is a skip");
  assert(prepare({ ...base, hook_event_name: "Stop" }, { minIntervalMin: 1 }).payloadPath !== undefined, "…and outside it captures");
  for (const [to, f] of parked) renameSync(to, f);
  // The interval gates on the last ATTEMPT: a payload of the session still pending counts, so an endpoint away does not turn a Stop hook into a payload per turn (eighth review pass).
  {
    const pendingOne = prepare({ ...base, session_id: "s-pending-gate", hook_event_name: "Stop" }, { minIntervalMin: 20 });
    assert(pendingOne.payloadPath && existsSync(pendingOne.payloadPath), "a first Stop with nothing recorded prepares");
    const gated = prepare({ ...base, session_id: "s-pending-gate", transcript_path: join(TMP, "two.jsonl"), hook_event_name: "Stop" }, { minIntervalMin: 20 });
    assert(/skip: last capture 0 min ago \(still pending\), interval 20/.test(gated.message), `…and the next Stop inside the interval is a skip while it is pending, with no state at all (${gated.message})`);
    if (pendingOne.payloadPath) unlinkSync(pendingOne.payloadPath); // a failed assertion above must not become a crash below
  }
  // A secret PAST the prompt clip is still seen — the scan reads the unclipped sources (third review pass).
  const pastClipT = join(TMP, "past-clip.jsonl");
  writeFileSync(pastClipT, [user("please rotate the hook's key " + "word ".repeat(45) + "MCP_ACCESS_KEY=" + "3f9a".repeat(16), { origin: { kind: "human" } }), assistant([{ type: "text", text: "rotated" }])].join("\n"));
  const pc = summariseTranscript(pastClipT);
  assert(scanForSecrets(renderSummary(pc)).length === 0 && scanSummary(pc, renderSummary(pc)).some((f) => /in prompt 1$/.test(f.reason)),
    "the rendered text is clean (the clip cut the key) but the full prompt is not, and the finding says where");
  const twiceT = join(TMP, "twice.jsonl");
  writeFileSync(twiceT, [user("the key is sk-ant-api03-" + "Ab1".repeat(12), { origin: { kind: "human" } }), assistant([{ type: "text", text: "you pasted sk-ant-api03-" + "Ab1".repeat(12) }])].join("\n"));
  const tw = summariseTranscript(twiceT);
  const twf = scanSummary(tw, renderSummary(tw));
  assert(twf.filter((f) => /^anthropic key/.test(f.reason)).length === 1, `one secret in two places is one finding, not three (${twf.map((f) => f.reason).join("; ")})`);
  const pcr = prepare({ ...base, session_id: "s-past-clip", transcript_path: pastClipT }, { onSecret: "refuse" });
  assert(pcr.code === 1 && /refused/.test(pcr.message) && /in prompt 1 at char/.test(pcr.message), `…so the capture is refused under refuse, the prompt numbered (${pcr.message.slice(0, 80)})`);
  // Under redact (the default), the prompt is blanked BEFORE the clip: the key past it is gone from the source, the text carries no marker (the clip took it), and the count says one (SMD-2127).
  const pcRed = prepare({ ...base, session_id: "s-past-clip-red", transcript_path: pastClipT });
  assert(pcRed.code === 0 && pcRed.payload?.redactions?.length === 1 && pcRed.payload.redactions[0]?.in === "prompt 1" && /^credential assignment, 64-hex token/.test(pcRed.payload.redactions[0]?.reason ?? "") && !/3f9a3f9a/.test(pcRed.payload.text) && !/\[redacted/.test(pcRed.payload.text) && scanSummary(cleanEpisode(summariseTranscript(pastClipT).episodes[0], "redact").ep, pcRed.payload.text).length === 0,
    `under redact the key past the clip is blanked in the source, counted once, and the sent text is clean (${pcRed.message.slice(0, 120)})`);
  if (pcRed.payloadPath) unlinkSync(pcRed.payloadPath);
  // A secret in the summary refuses before any payload.
  const secretT = join(TMP, "secret.jsonl");
  writeFileSync(secretT, [user("use this key: sk-ant-api03-" + "Ab1".repeat(12), { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const before = readdirSync(join(STATE, "pending")).length;
  const r = prepare({ ...base, session_id: "s-secret", transcript_path: secretT }, { onSecret: "refuse" });
  assert(r.code === 1 && /refused/.test(r.message) && /anthropic key at char \d+/.test(r.message), `under refuse a secret refuses with exit 1 and the reason (${r.message.slice(0, 90)})`);
  assert(!r.message.includes("Ab1Ab1"), "…never the secret");
  assert(readdirSync(join(STATE, "pending")).length === before && !existsSync(join(STATE, "s-secret.json")), "…and nothing is written");
  // Under redact (the default, SMD-2127): the span is blanked in the prompt, the summary rendered from the blanked prompt, the payload written, the message saying what and where — never the match.
  const red = prepare({ ...base, session_id: "s-secret-red", transcript_path: secretT });
  assert(red.code === 0 && red.payloadPath && red.message === "prepared: session s-secret-red, 1 prompt(s), 0 source id(s), redacted: anthropic key at char 14 in prompt 1", `under redact the secret is blanked and the capture prepared, the message naming the shape, the offset and the source (${red.message})`);
  const redPayload = red.payloadPath ? JSON.parse(readFileSync(red.payloadPath, "utf8")) : {}; // a refusal under a mutant fails the arms below, it does not crash the suite
  assert(/\nTitle: use this key: \[redacted:anthropic key\]\n/.test(redPayload.text) && /\n- use this key: \[redacted:anthropic key\]\n/.test(redPayload.text) && !redPayload.text.includes("Ab1Ab1") && scanForSecrets(redPayload.text).length === 0 && !JSON.stringify(redPayload).includes("Ab1Ab1"),
    "…the text carries the marker where the key was, in the title and the ask, and nothing of the key anywhere in the payload");
  assert(redPayload.redactions?.length === 1 && redPayload.redactions[0]?.reason === "anthropic key" && redPayload.redactions[0]?.in === "prompt 1" && redPayload.redactions[0]?.at === 14, `…and records the redaction (${JSON.stringify(redPayload.redactions)})`);
  writeFileSync(join(STATE, "s-secret-red.json"), JSON.stringify({ thought_id: uuid(9), fingerprint: redPayload.fingerprint, captured_at: new Date().toISOString() }));
  assert(/^skip: session s-secret-red already captured as/.test(prepare({ ...base, session_id: "s-secret-red", transcript_path: secretT }).message), "…the same transcript again is a skip");
  assert(redPayload.fingerprint === createHash("sha256").update(redPayload.text ?? "").digest("hex"), "…and the fingerprint is the blanked text's — the text sent — not the raw render's (the mutant fingerprinting the raw text skipped the same transcript too)");
  if (red.payloadPath) unlinkSync(red.payloadPath);
  unlinkSync(join(STATE, "s-secret-red.json"));
  // Provenance is untouched by the blanking: the fixture with a key in a retried prompt keeps its three sources, and the retried prompt is one line and one redaction.
  const provT = join(TMP, "secret-prov.jsonl");
  writeFileSync(provT, claudeTranscript().replaceAll("now push and open the PR", "now push and open the PR with the key sk-ant-api03-" + "Ab1".repeat(12)));
  const prov = prepare({ ...base, session_id: "s-secret-prov", transcript_path: provT });
  assert(prov.code === 0 && prov.payload?.derived_from.length === 3 && prov.payload.redactions?.length === 1 && prov.payload.prompts === 3 && /\n- now push and open the PR with the key \[redacted:anthropic key\]\n/.test(prov.payload.text) && !prov.payload.text.includes("Ab1Ab1"),
    `derived_from keeps its three ids beside one redaction; the retried prompt is one line and counted once (${prov.message.slice(0, 120)})`);
  if (prov.payloadPath) unlinkSync(prov.payloadPath);
  // First review pass: the gate reads each prompt on its own, as the redaction blanks them — a flag ending one prompt and a word opening the next was a refusal under either mode that no redaction could clear.
  writeFileSync(join(TMP, "join.jsonl"), [user("run psql --password", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }]), user("hunter2 then check the row count", { origin: { kind: "human" } }), assistant([{ type: "text", text: "done" }])].join("\n"));
  const jn = prepare({ ...base, session_id: "s-join", transcript_path: join(TMP, "join.jsonl") });
  const jnR = prepare({ ...base, session_id: "s-join-refuse", transcript_path: join(TMP, "join.jsonl") }, { onSecret: "refuse" });
  assert(jn.code === 0 && jn.payloadPath && !("redactions" in jn.payload) && jnR.code === 0 && jnR.payloadPath && scanSummary(summariseTranscript(join(TMP, "join.jsonl")).episodes[0], "x").length === 0,
    `two prompts that read as a secret only joined are no secret in either mode (${jn.message.slice(0, 60)} | ${jnR.message.slice(0, 60)})`);
  for (const x of [jn, jnR]) if (x.payloadPath) unlinkSync(x.payloadPath);
  // …and two asks that differ in their secret alone are one line once blanked: the payload counts them as the text does (first review pass).
  writeFileSync(join(TMP, "same-ask.jsonl"), [user("use sk-ant-api03-" + "Ab1".repeat(12), { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }]), user("use sk-ant-api03-" + "Cd2".repeat(12), { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const same = prepare({ ...base, session_id: "s-same-ask", transcript_path: join(TMP, "same-ask.jsonl") });
  assert(same.code === 0 && same.payload.prompts === 1 && /\nAsked \(1 prompt\):\n- use \[redacted:anthropic key\]\n/.test(same.payload.text) && same.payload.redactions.length === 2 && /redacted: anthropic key at char 4 in prompt 1; anthropic key at char 4 in prompt 2$/.test(same.message),
    `the count is the blanked text's (${same.message.slice(0, 120)})`);
  if (same.payloadPath) unlinkSync(same.payloadPath);
  // …a secret in the thirteenth of thirteen asks is named as past the twelve the text lists (second review pass).
  writeFileSync(join(TMP, "thirteen.jsonl"), [...Array.from({ length: 12 }, (_, i) => [user(`ask number ${i + 1}`, { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])]).flat(), user("and last: sk-ant-api03-" + "Ab1".repeat(12), { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const thirteen = prepare({ ...base, session_id: "s-thirteen", transcript_path: join(TMP, "thirteen.jsonl") });
  assert(thirteen.code === 0 && thirteen.payload.redactions?.[0]?.in === "prompt 13 (past the 12 the text lists)" && /- … and 1 more\n/.test(thirteen.payload.text) && !/Ab1Ab1/.test(JSON.stringify(thirteen.payload)),
    `a redaction in an ask the text does not list says so (${thirteen.payload?.redactions?.[0]?.in})`);
  if (thirteen.payloadPath) unlinkSync(thirteen.payloadPath);
  // …and a pasted PGP armor, or a footer-less PEM body — a MULTI-LINE key blob — is REFUSED, not redacted (SMD-2127 scope call).
  writeFileSync(join(TMP, "armor.jsonl"), [user(`export:\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${SEEDED}\n${SEEDLESS}\n${SEEDED}\nAb3d==\n-----END PGP PRIVATE KEY BLOCK-----\ndone`, { origin: { kind: "human" } }), assistant([{ type: "text", text: `saved -----BEGIN PRIVATE KEY-----\n${SEEDLESS}\n${SEEDED}\n${SEEDLESS}` }])].join("\n"));
  const armor = prepare({ ...base, session_id: "s-armor", transcript_path: join(TMP, "armor.jsonl") });
  assert(armor.code === 1 && /a multi-line key block \(private key block/.test(armor.message) && armor.payloadPaths.length === 0 && !existsSync(join(STATE, "s-armor.json")) && !/ZVEiR2Bwp|MIIEvQ/.test(armor.message),
    `a multi-line key blob is refused, naming the block, nothing of its lines, nothing sent (${armor.message.slice(0, 120)})`);
  if (armor.payloadPath) unlinkSync(armor.payloadPath);
  // …and a block a name splits is still a MULTI-LINE key block (the header's span grows across a line) → refused.
  writeFileSync(join(TMP, "split.jsonl"), [user(`stored:\n-----BEGIN PRIVATE KEY-----\n${SEEDLESS}\napi_key=abcdef1234567890abcdefghij\n${SEEDLESS}\ndone`, { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const splitR = prepare({ ...base, session_id: "s-split", transcript_path: join(TMP, "split.jsonl") });
  assert(splitR.code === 1 && /a multi-line key block/.test(splitR.message) && splitR.payloadPaths.length === 0 && !existsSync(join(STATE, "s-split.json")) && !/ZVEiR2Bwp/.test(splitR.message),
    `a name-split key block is refused as a multi-line block, nothing sent (${splitR.message.slice(0, 120)})`);
  // …while a clean summary with an ordinary redacted inline key is NOT refused by the backstop.
  writeFileSync(join(TMP, "inline-ok.jsonl"), [user("rotate MCP_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz012345 today", { origin: { kind: "human" } }), assistant([{ type: "text", text: "the commit is 8541cec9f2a1b3c4d5e6f7a8b9c0d1e2f3a4b5c6" }])].join("\n"));
  const inlineOk = prepare({ ...base, session_id: "s-inline-ok", transcript_path: join(TMP, "inline-ok.jsonl") });
  assert(inlineOk.code === 0 && inlineOk.payloadPath && /MCP_ACCESS_KEY=\[redacted:credential assignment, high-entropy token\]/.test(inlineOk.payload.text) && !/abcdefghijklmnop/.test(inlineOk.payload.text),
    `an inline key beside a git sha is redacted and sent — the backstop does not refuse it (${inlineOk.message.slice(0, 80)})`);
  if (inlineOk.payloadPath) unlinkSync(inlineOk.payloadPath);
  // The backstop: a blanking the scan still finds something after is refused as every hit was — the net under the redaction. A URL's password blanked, the URL no longer reads as one, and the digest in its path reads as a bare key.
  writeFileSync(join(TMP, "backstop.jsonl"), [user("pull https://u:p4ssw0rd@h/blobs/" + "3f9a".repeat(16) + " now", { origin: { kind: "human" } }), assistant([{ type: "text", text: "pulled" }])].join("\n"));
  const bs = prepare({ ...base, session_id: "s-backstop", transcript_path: join(TMP, "backstop.jsonl") });
  assert(bs.code === 1 && /^refused — the summary for session s-backstop carries what looks like a secret \(64-hex token \(a raw key, or a digest out of its context\) in prompt 1 at char \d+ after 3 redactions\); nothing sent\. Remove it from the conversation before ending the session, or capture by hand\.$/.test(bs.message) && !/3f9a3f9a|p4ssw0rd/.test(bs.message) && bs.payloadPaths.length === 0 && !existsSync(join(STATE, "s-backstop.json")),
    `a summary the blanking leaves a hit in is refused as every hit was, the message naming the hit, its source and the redactions tried, nothing written (${bs.message.slice(0, 160)})`);
  const bsDry = cleanEpisode(summariseTranscript(join(TMP, "backstop.jsonl")).episodes[0], "redact");
  const bsAgain = scanSummary(bsDry.ep, bsDry.text);
  assert(bsDry.redactions.map((r) => r.in).join() === "prompt 1,the text,the text" && /https:\/\/u:\[redacted:url with a password\]@h\/blobs\/\[redacted:64-hex token/.test(bsDry.text) && !/3f9a3f9a/.test(bsDry.text) && bsAgain.length === 1 && /^64-hex token .* in prompt 1$/.test(bsAgain[0].reason),
    `…the source round took the password, the text round the digest the un-URL'd path then showed (title and ask); the prompt, read whole and unclipped, still carries it, and that is the hit (${bsDry.redactions.map((r) => r.in).join()})`);
}

// ── [6] Posting ──────────────────────────────────────────────────────────────
console.log("\n[6] The background half posts over MCP, records the id, retries a provenance refusal without it, and keeps a failed payload");
{
  rmSync(STATE, { recursive: true, force: true });
  const cfg = { url: URL_, key: "cap-key" };
  assert(parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{}}').result !== undefined && parseRpcBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n').result.a === 1, "both answer shapes parse");
  assert(parseRpcBody('data: {"jsonrpc":"2.0",\ndata:  "id":1,"result":{"a":2}}\n\n').result.a === 2, "an event's data split over several data: lines is one message");
  assert(parseRpcBody('event: message\r\ndata:{"jsonrpc":"2.0","id":1,"result":{"a":3}}\r\n\r\n').result.a === 3, "data: without the space, CRLF line ends");
  assert(parseRpcBody(': keep-alive\n\ndata: {"a":1}\n\nid: 7\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":4}}\n\n').result.a === 4, "the LAST event is the answer; a comment-only event is skipped");
  assert(parseRpcBody('data: {"jsonrpc":"2.0","id":3,"result":{"a":5}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n', 3).result.a === 5, "a trailing notification is not the answer: the reply carrying the request's id is");
  assert(parseRpcBody('data: {"jsonrpc":"2.0","id":9,"result":{"a":6}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/ping"}\n\n').result.a === 6, "…and without an id to match, the last message that is a reply at all");
  assert(parseRpcBody('data: {"jsonrpc":"2.0","id":3,"result":{"a":7}}\n\ndata: {"jsonrpc":"2.0","id":4,"result":{"a":8}}\n\n', 3).result.a === 7, "the request's id wins over a later reply to another request");
  let htmlErr = ""; try { parseRpcBody("<!DOCTYPE html><html>a proxy page</html>"); } catch (e) { htmlErr = e.message; }
  assert(/not a JSON-RPC answer: <!DOCTYPE/.test(htmlErr), "an HTML page (a proxy) is a readable error, not a parse crash");
  received.length = 0;
  const p = prepare({ session_id: SID, transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const [o] = await postPending(cfg, p.payloadPath);
  assert(o.ok && o.id === uuid(1001), `posted and the id read from the answer (${o.id})`);
  assert(received[0].args.source === "claude-code" && received[0].args.derived_from.length === 3 && received[0].args.content === JSON.parse(JSON.stringify(p.payload)).text, "the call carries source, derived_from and the summary");
  assert(received[0].key === "cap-key", "…under the configured key");
  const st = readState(SID);
  assert(st.thought_id === uuid(1001) && st.fingerprint === p.payload.fingerprint && st.sources === 3, "the state records the thought id and the fingerprint");
  assert(!existsSync(p.payloadPath), "the payload is removed");
  assert(/captured session=.* id=00001001-/.test(readFileSync(join(STATE, "log"), "utf8")), "the log has the line");
  // A second ending of the same session supersedes.
  writeFileSync(join(STATE, `${SID}.json`), JSON.stringify({ ...st, fingerprint: "older" }));
  const p2 = prepare({ session_id: SID, transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  await postPending(cfg, p2.payloadPath);
  assert(received[1].args.supersedes === uuid(1001), "the second capture supersedes the first");
  // A provenance refusal: once without derived_from, noted.
  const r1 = await postCapture(cfg, { text: "[[refuse-derived]] summary", harness: "codex", derived_from: [uuid(50)] });
  assert(r1.id && /1 source id\(s\) dropped/.test(r1.note), `an unknown source id, named by position, is dropped and the capture retried (${r1.note.slice(0, 60)})`);
  assert(received.at(-1).args.derived_from === undefined && received.at(-2).args.derived_from?.length === 1, "…two calls, the second bare — the one source was the one refused");
  const r1old = await postCapture(cfg, { text: "[[refuse-derived-old]] summary", harness: "codex", derived_from: [uuid(51), uuid(52)] });
  assert(r1old.id && /provenance dropped/.test(r1old.note) && received.at(-1).args.derived_from === undefined, "a server that names no position (before this pass) gets the whole list dropped");
  const r2 = await postCapture(cfg, { text: "[[embedding-failed]] summary", harness: "codex", derived_from: [] });
  assert(r2.id === uuid(1000 + received.length) && /embedding failed/.test(r2.note), "a saved-but-vectorless answer is a capture with a note");
  // Unauthorized is dead at once; a closed port is kept for a later run and then delivered.
  const bad = prepare({ session_id: "s-bad", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [b] = await postPending({ url: URL_, key: "wrong" }, bad.payloadPath);
  assert(!b.ok && b.dead && /Unauthorized/.test(b.error) && existsSync(join(STATE, "dead", bad.payloadPath.split("/").pop())), "a refused key gives up: the payload goes to dead/");
  // A key whose scope no longer unlocks capture_thought: the SDK answers an isError RESULT saying "MCP error -32602: Tool … not found" — final, not a week of retries (thirteenth review pass).
  const narrowed = prepare({ session_id: "s-narrowed", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const no = (await postPending({ url: URL_, key: "read-key" }, narrowed.payloadPath)).find((o) => basename(o.file) === basename(narrowed.payloadPath));
  assert(!no.ok && no.dead && /capture refused: MCP error -32602: Tool capture_thought not found/.test(no.error) && existsSync(join(STATE, "dead", basename(narrowed.payloadPath))),
    `a key that cannot see the tool is given up on at once (${(no.error ?? "").slice(0, 70)})`);
  // The server answered, its database did not: not a refusal, so the payload
  // is kept and lands when the store is back (first review pass: it went dead).
  const outageT = join(TMP, "outage.jsonl");
  writeFileSync(outageT, [user("[[store-down]] a prompt during an outage", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const outage = prepare({ session_id: "s-outage", transcript_path: outageT, hook_event_name: "SessionEnd" });
  const og = (await postPending(cfg, outage.payloadPath)).find((o) => basename(o.file) === basename(outage.payloadPath)); // oldest first: own is not always first
  assert(!og.ok && !og.dead && /capture failed: Error: Failed to connect/.test(og.error) && existsSync(outage.payloadPath), `a store outage keeps the payload (${og.error})`);
  unlinkSync(outage.payloadPath);
  const hardT = join(TMP, "hard.jsonl");
  writeFileSync(hardT, [user("[[refuse-hard]] a prompt the server will not hold", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const hard = prepare({ session_id: "s-hard", transcript_path: hardT, hook_event_name: "SessionEnd" });
  const [ho] = await postPending(cfg, hard.payloadPath);
  assert(!ho.ok && ho.dead && /capture refused: Refused:/.test(ho.error) && !existsSync(hard.payloadPath), `a "Refused:" the hook cannot mend is dead at once (${ho.error.slice(0, 50)})`);
  const grantT = join(TMP, "grant.jsonl");
  writeFileSync(grantT, [user("[[grant-missing]] a prompt on a brain whose role lacks a grant", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  writeFileSync(join(STATE, "s-grant.json"), JSON.stringify({ thought_id: uuid(95), fingerprint: "older", captured_at: new Date(Date.now() - 60_000).toISOString(), summary_at: new Date(Date.now() - 60_000).toISOString() }));
  const grant = prepare({ session_id: "s-grant", transcript_path: grantT, hook_event_name: "SessionEnd" });
  const beforeGrant = received.length;
  const [go] = await postPending(cfg, grant.payloadPath);
  assert(!go.ok && !go.dead && /could not be checked/.test(go.error ?? "") && received.length === beforeGrant + 1 && received.at(-1).args.supersedes === uuid(95),
    `a supersedes the server could not check is kept for retry with the pointer intact — one call, not a fresh un-superseded summary (${go.error?.slice(0, 50) ?? `ok ${go.id}`})`);
  assert(JSON.parse(readFileSync(join(STATE, "pending", basename(go.file)), "utf8")).supersedes_failures === 1, "…and the payload counts one failure on the pointer, the count the last attempt reads (eighth review pass)");
  if (existsSync(grant.payloadPath)) unlinkSync(grant.payloadPath);
  // …and the same for the registry being away: an "Error:" of the server's, whatever its sentence, is kept whole.
  const awayT = join(TMP, "away.jsonl");
  writeFileSync(awayT, [user("[[registry-away]] a prompt while the registry is down", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  writeFileSync(join(STATE, "s-away.json"), JSON.stringify({ thought_id: uuid(96), fingerprint: "older", captured_at: new Date(Date.now() - 60_000).toISOString(), summary_at: new Date(Date.now() - 60_000).toISOString() }));
  const away = prepare({ session_id: "s-away", transcript_path: awayT, hook_event_name: "SessionEnd" });
  const beforeAway = received.length;
  const [ao] = await postPending(cfg, away.payloadPath);
  assert(!ao.ok && !ao.dead && /could not be attributed/.test(ao.error ?? "") && received.length === beforeAway + 1 && received.at(-1).args.supersedes === uuid(96),
    `a server error of any wording keeps the payload and the pointer — the hook tells an error from a refusal by the prefix, not the sentence (${ao.error?.slice(0, 40) ?? `ok ${ao.id}`})`);
  if (existsSync(away.payloadPath)) unlinkSync(away.payloadPath);
  const fnT = join(TMP, "fn.jsonl");
  writeFileSync(fnT, [user("[[fn-missing]] a prompt mid-migration", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const fn = prepare({ session_id: "s-fn", transcript_path: fnT, hook_event_name: "SessionEnd" });
  const [fo] = await postPending(cfg, fn.payloadPath);
  assert(!fo.ok && !fo.dead && /capture failed/.test(fo.error), `a store error phrased with "not found" and "must be" is a failure, kept (${fo.error.slice(0, 60)})`);
  unlinkSync(fn.payloadPath);
  // The server names the position that names no thought: that one goes, the rest stay.
  const r5 = await postCapture(cfg, { text: "[[refuse-derived-at:1]] summary with three sources", harness: "codex", derived_from: [uuid(70), uuid(71), uuid(72)] });
  assert(r5.id && /1 source id\(s\) dropped/.test(r5.note) && received.at(-1).args.derived_from.join() === [uuid(70), uuid(72)].join(),
    `a positional refusal drops that position alone and keeps the other sources (${received.at(-1).args.derived_from?.length} kept)`);
  // A wrong url — a proxy, a page, not the endpoint — answers 4xx: dead at once and said with the url; a 5xx is kept (fifth review pass).
  const wrong = prepare({ session_id: "s-wrong-url", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [wo] = await postPending({ url: `${URL_}not-the-endpoint`, key: "cap-key" }, wrong.payloadPath);
  assert(!wo.ok && wo.dead && /HTTP 405 from .*not-the-endpoint/.test(wo.error) && /check the url/.test(wo.error), `a 4xx is a wrong endpoint: dead, the url named (${wo.error.slice(0, 60)})`);
  const unwell = prepare({ session_id: "s-unwell", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [uo] = await postPending({ url: `${URL_}unwell`, key: "cap-key" }, unwell.payloadPath);
  assert(!uo.ok && !uo.dead && /HTTP 502/.test(uo.error) && existsSync(unwell.payloadPath), "a 5xx is the server unwell: kept");
  unlinkSync(unwell.payloadPath);
  const busy = prepare({ session_id: "s-busy", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [bo] = await postPending({ url: `${URL_}busy`, key: "cap-key" }, busy.payloadPath);
  assert(!bo.ok && !bo.dead && /HTTP 429/.test(bo.error) && existsSync(busy.payloadPath), "a 429 is the endpoint asking for patience: kept, not a wrong url (sixth review pass)");
  unlinkSync(busy.payloadPath);
  const moved = prepare({ session_id: "s-moved", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [mo] = await postPending({ url: `${URL_}moved`, key: "cap-key" }, moved.payloadPath);
  assert(!mo.ok && mo.dead && /HTTP 301 redirect to .*\/login/.test(mo.error) && /check the url/.test(mo.error), `a redirect is a wrong url: dead, the target named (${mo.error.slice(0, 60)})`);
  const page = prepare({ session_id: "s-page", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [po] = await postPending({ url: `${URL_}login`, key: "cap-key" }, page.payloadPath);
  assert(!po.ok && po.dead && /an HTML page from/.test(po.error), `an HTML page at 200 is a wrong url, not five silent retries (${po.error.slice(0, 50)})`);
  const front = prepare({ session_id: "s-front", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [fo2] = await postPending({ url: `${URL_}front-401`, key: "cap-key" }, front.payloadPath);
  assert(!fo2.ok && fo2.dead && /JSON-RPC -32001/.test(fo2.error) && !/check the url/.test(fo2.error), `a 4xx carrying a JSON-RPC envelope is judged by the envelope: a bad key, not a bad url (${fo2.error.slice(0, 50)})`);
  // A position the server names past the list (a server and a client disagreeing) falls to the whole-list drop in one retry, not five identical calls.
  const beforePast = received.length;
  const r6 = await postCapture(cfg, { text: "[[refuse-derived-at:5]] summary with two sources", harness: "codex", derived_from: [uuid(73), uuid(74)] });
  assert(r6.id && /provenance dropped/.test(r6.note) && received.length === beforePast + 2, `a position past the list drops the list in one retry (${received.length - beforePast} calls)`);
  // A payload whose capture landed but whose bookkeeping did not is finished without a second post.
  const landedT = prepare({ session_id: "s-landed", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(landedT.payloadPath, JSON.stringify({ ...landedT.payload, captured_id: uuid(90), captured_note: "" }));
  const beforeLanded = received.length;
  const [lo] = await postPending(cfg, landedT.payloadPath);
  assert(lo.ok && lo.id === uuid(90) && received.length === beforeLanded && !existsSync(landedT.payloadPath) && readState("s-landed")?.thought_id === uuid(90),
    "a payload carrying its captured id is not posted again; its state is written and it is removed");
  // A landed payload beside a NEWER payload of its session in one run: never
  // obsolete — it finishes, and the newer one supersedes the id it landed
  // (sixth review pass: judged obsolete, the id was lost and two summaries stood).
  const landedFirst = prepare({ session_id: "s-landed-chain", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(landedFirst.payloadPath, JSON.stringify({ ...landedFirst.payload, captured_id: uuid(97), captured_note: "" }));
  await sleep(2);
  const newerAfter = prepare({ session_id: "s-landed-chain", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const beforeChain = received.length;
  const chained = await postPending(cfg, newerAfter.payloadPath);
  assert(chained.length === 2 && chained[0].ok && chained[0].id === uuid(97) && !chained[0].obsolete, "the landed payload finishes rather than going obsolete");
  assert(chained[1].ok && received.length === beforeChain + 1 && received.at(-1).args.supersedes === uuid(97), "…and the newer payload supersedes the id it landed");
  assert(readState("s-landed-chain").thought_id === chained[1].id, "…the state ends at the newest");
  // A pointer from prepare time gives way to the state's when the state has moved on (eighth review pass: `!payload.supersedes` kept the stale one).
  writeFileSync(join(STATE, "s-state-moved.json"), JSON.stringify({ thought_id: uuid(80), fingerprint: "m0", captured_at: new Date(Date.now() - 120_000).toISOString(), summary_at: new Date(Date.now() - 120_000).toISOString() }));
  const stateMoved = prepare({ session_id: "s-state-moved", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  assert(stateMoved.payload.supersedes === uuid(80), "prepared pointing at the state's id");
  writeFileSync(join(STATE, "s-state-moved.json"), JSON.stringify({ thought_id: uuid(81), fingerprint: "m1", captured_at: new Date(Date.now() - 1000).toISOString(), summary_at: new Date(Date.now() - 90_000).toISOString() }));
  const [smo] = await postPending(cfg, stateMoved.payloadPath);
  assert(smo.ok && received.at(-1).args.supersedes === uuid(81), `…and posts superseding the id the state names NOW, not the one prepare saw (${received.at(-1).args.supersedes === uuid(81) ? "state's" : "prepare's"})`);
  // The state is re-read after the post: a sibling that landed a newer summary during the request is not overwritten (eighth review pass).
  const raced = prepare({ session_id: "s-raced", transcript_path: join(TMP, "raced.jsonl"), hook_event_name: "SessionEnd" });
  await new Promise((r) => setTimeout(r, 5)); // the sibling's summary_at must be a later millisecond than prepared_at
  const [ro] = await postPending(cfg, raced.payloadPath);
  assert(ro.ok && readState("s-raced").thought_id === uuid(82) && readState("s-raced").thought_id !== ro.id, "a summary a sibling landed during the post keeps the state; the older one landed does not move it back");
  // A payload prepared BEFORE its predecessor landed (two endings seconds apart, each in its own run) takes its pointer from the state at post time (seventh review pass).
  const early = prepare({ session_id: "s-early", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  assert(early.payload.supersedes === undefined, "prepared with no state: no pointer yet");
  writeFileSync(join(STATE, "s-early.json"), JSON.stringify({ thought_id: uuid(98), fingerprint: "p1", captured_at: new Date(Date.now() - 1000).toISOString(), summary_at: new Date(Date.now() - 5000).toISOString() }));
  const [eo] = await postPending(cfg, early.payloadPath);
  assert(eo.ok && received.at(-1).args.supersedes === uuid(98), "…and posts superseding what the state recorded meanwhile");
  // A pointer the server keeps failing on does not take the summary with it: the last attempt drops it.
  writeFileSync(join(STATE, "s-stuck-ptr.json"), JSON.stringify({ thought_id: uuid(99), fingerprint: "older", captured_at: new Date(Date.now() - 60_000).toISOString(), summary_at: new Date(Date.now() - 60_000).toISOString() }));
  const stuckT = join(TMP, "stuck.jsonl");
  writeFileSync(stuckT, [user("[[registry-away]] a prompt while the registry never came back", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const stuck = prepare({ session_id: "s-stuck-ptr", transcript_path: stuckT, hook_event_name: "SessionEnd" });
  // Three of four attempts failed on the pointer, the fourth on an outage: the pointer is still what to drop (eighth review pass: the last error's wording decided, and this payload died).
  writeFileSync(stuck.payloadPath, JSON.stringify({ ...stuck.payload, attempts: 4, supersedes_failures: 3, last_error: "capture failed: Error: Failed to connect" }));
  const beforeStuck = received.length;
  const [so2] = await postPending(cfg, stuck.payloadPath);
  assert(so2.ok && /supersedes dropped: 3 of 4 attempts failed on it/.test(so2.note) && received.length === beforeStuck + 1 && received.at(-1).args.supersedes === undefined,
    `on the fifth attempt the pointer is dropped and the summary lands (${(so2.note ?? so2.error ?? "").slice(0, 60)})`);
  // A store's own "401 Unauthorized" quoted in an Error: is an outage, not the key refused: kept (twelfth review pass — the bare word dead-lettered it).
  {
    writeFileSync(join(TMP, "store401.jsonl"), [user("[[store-401]] a prompt while the store's key was rotating", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
    const s401 = prepare({ session_id: "s-store-401", transcript_path: join(TMP, "store401.jsonl"), hook_event_name: "SessionEnd" });
    const o401 = (await postPending(cfg, s401.payloadPath)).find((o) => basename(o.file) === basename(s401.payloadPath));
    assert(!o401.ok && !o401.dead && /401 Unauthorized/.test(o401.error) && existsSync(join(STATE, "pending", basename(s401.payloadPath))), "a store-side 401 inside the server's Error: keeps the payload");
    unlinkSync(join(STATE, "pending", basename(s401.payloadPath)));
  }
  // A transient failure never dead-letters, however many times: nine store outages keep the payload; a payload a week old is given up (eleventh review pass — five tries across one outage lost sessions).
  {
    writeFileSync(join(TMP, "nine.jsonl"), [user("[[store-down]] a prompt during a long outage", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
    const nine = prepare({ session_id: "s-nine", transcript_path: join(TMP, "nine.jsonl"), hook_event_name: "SessionEnd" });
    writeFileSync(nine.payloadPath, JSON.stringify({ ...nine.payload, attempts: 9, last_error: "capture failed: Error: Failed to connect" }));
    const no = (await postPending(cfg, nine.payloadPath)).find((o) => basename(o.file) === basename(nine.payloadPath)); // oldest first: own is not always first
    assert(!no.ok && !no.dead && existsSync(join(STATE, "pending", basename(nine.payloadPath))), "a tenth store outage keeps the payload pending — attempts alone never give up");
    const old = prepare({ session_id: "s-week", transcript_path: join(TMP, "nine.jsonl"), hook_event_name: "SessionEnd" });
    writeFileSync(old.payloadPath, JSON.stringify({ ...old.payload, prepared_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }));
    const wk = (await postPending(cfg, old.payloadPath)).find((o) => basename(o.file) === basename(old.payloadPath));
    assert(!wk.ok && wk.dead && existsSync(join(STATE, "dead", basename(old.payloadPath))), "…while one that has waited eight days is given up");
    unlinkSync(join(STATE, "pending", basename(nine.payloadPath)));
  }
  // A pointer failing once a day: the last chance before the payload dies of age is taken WITHOUT the pointer (twelfth review pass — it died at attempt three, never tried bare).
  {
    writeFileSync(join(STATE, "s-aged-ptr.json"), JSON.stringify({ thought_id: uuid(94), fingerprint: "older", captured_at: new Date(Date.now() - 9 * 86_400_000).toISOString(), summary_at: new Date(Date.now() - 9 * 86_400_000).toISOString() }));
    writeFileSync(join(TMP, "agedptr.jsonl"), [user("[[grant-missing]] a prompt whose pointer the server could never check", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
    const aged = prepare({ session_id: "s-aged-ptr", transcript_path: join(TMP, "agedptr.jsonl"), hook_event_name: "SessionEnd" });
    writeFileSync(aged.payloadPath, JSON.stringify({ ...aged.payload, attempts: 2, supersedes_failures: 2, prepared_at: new Date(Date.now() - 8 * 86_400_000).toISOString(), last_error: "capture failed: Error: this key's `supersedes` could not be checked" }));
    const ao2 = (await postPending(cfg, aged.payloadPath)).find((o) => basename(o.file) === basename(aged.payloadPath));
    assert(ao2.ok && /supersedes dropped: 2 of 2 attempts failed on it, the payload a week old/.test(ao2.note) && received.at(-1).args.supersedes === undefined, `an eight-day-old payload failing on the pointer lands without it (${(ao2.note ?? ao2.error ?? "").slice(0, 70)})`);
  }
  // Four failures that only MENTION supersedes (a store error quoting the function's signature) drop nothing: the pointer rides on the fifth attempt.
  writeFileSync(join(STATE, "s-word-only.json"), JSON.stringify({ thought_id: uuid(99), fingerprint: "older", captured_at: new Date(Date.now() - 60_000).toISOString(), summary_at: new Date(Date.now() - 60_000).toISOString() }));
  const wordT = join(TMP, "word.jsonl");
  writeFileSync(wordT, [user("a prompt whose store quoted p_supersedes", { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const word = prepare({ session_id: "s-word-only", transcript_path: wordT, hook_event_name: "SessionEnd" });
  writeFileSync(word.payloadPath, JSON.stringify({ ...word.payload, attempts: 4, last_error: "capture failed: Error: function upsert_thought(text, jsonb, uuid p_supersedes) does not exist" }));
  const [wdo] = await postPending(cfg, word.payloadPath);
  assert(wdo.ok && !/supersedes dropped/.test(wdo.note ?? "") && received.at(-1).args.supersedes === uuid(99), "…while a last error that merely contains the word keeps the pointer");
  const landedOld = prepare({ session_id: "s-landed-old", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(landedOld.payloadPath, JSON.stringify({ ...landedOld.payload, captured_id: uuid(91), prepared_at: new Date(Date.now() - 60_000).toISOString() }));
  writeFileSync(join(STATE, "s-landed-old.json"), JSON.stringify({ thought_id: uuid(92), fingerprint: "newer", summary_at: new Date(Date.now() - 1_000).toISOString(), captured_at: new Date(Date.now() - 500).toISOString() }));
  const [lo2] = await postPending(cfg, landedOld.payloadPath);
  assert(lo2.ok && !existsSync(landedOld.payloadPath) && readState("s-landed-old").thought_id === uuid(92),
    "a landed payload older than the session's recorded capture is finished without moving the state back to it");
  await sleep(2);
  const down = prepare({ session_id: "s-down", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const [d] = await postPending({ url: "http://127.0.0.1:9/", key: "cap-key" }, down.payloadPath);
  assert(!d.ok && !d.dead && existsSync(down.payloadPath) && JSON.parse(readFileSync(down.payloadPath, "utf8")).attempts === 1, "a dead endpoint keeps the payload with its attempt count");
  // A later run for ANOTHER session, through the path a hook takes (its own
  // payload named first): the stranded payload goes with it. A first cut's
  // retry ran only from a bare postPending(), which no hook path called.
  const other = prepare({ session_id: "s-other", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  assert(basename(down.payloadPath) < basename(other.payloadPath), "two payloads made in the same millisecond still sort as made — the name carries a sequence (third review pass: a random tail flaked the suite)");
  const later = await postPending(cfg, other.payloadPath);
  assert(later.at(-1)?.file === other.payloadPath && later.at(-1)?.ok, "the run's own payload posts last — it is the newest");
  assert(later.some((x) => x.ok && x.file === down.payloadPath) && !existsSync(down.payloadPath), "…and the stranded payload from the dead-endpoint run goes with it, first");
  assert(readdirSync(join(STATE, "pending")).length === 0, "…leaving pending/ empty");
  // Two payloads of ONE session pending (it ended twice while the server was
  // down): they land in the order they were made, the later superseding the
  // id the earlier just received, and the state ends at the newest (second
  // review pass: newest-first left the state naming the stale summary).
  const chainA = prepare({ session_id: "s-chain", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  await sleep(5);
  // Dead letters older than thirty days are pruned by the next run; younger ones stay (eighth review pass).
  const deadOld = join(STATE, "dead", "1000-0000-aaaaaa-s-old.json"), deadNew = join(STATE, "dead", "2000-0000-bbbbbb-s-new.json");
  writeFileSync(deadOld, "{}"); writeFileSync(deadNew, "{}");
  const ancient = new Date(Date.now() - 31 * 24 * 60 * 60_000);
  utimesSync(deadOld, ancient, ancient);
  const chainB = prepare({ session_id: "s-chain", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const before = received.length;
  const chain = await postPending(cfg, chainB.payloadPath);
  assert(chain.length === 2 && chain[0].obsolete === true && chain[0].file === chainA.payloadPath && /a later capture of the session/.test(chain[0].error), "the earlier payload of the session is obsolete: the summary is cumulative — and the reason says capture, since the later one may be a checkpoint (second review pass: the wording was held by nothing)");
  assert(received.length === before + 1 && chain[1].ok && chain[1].file === chainB.payloadPath, "…one post, the newest");
  assert(readState("s-chain").thought_id === chain[1].id && existsSync(join(STATE, "dead", basename(chainA.payloadPath))), "…the state names it, and the obsolete payload sits in dead/");
  assert(!existsSync(join(STATE, "dead", "1000-0000-aaaaaa-s-old.json")) && existsSync(join(STATE, "dead", "2000-0000-bbbbbb-s-new.json")), "a dead letter past thirty days is pruned by a run; a younger one stays");
  // …and a stranded payload older than a capture the session's state already records is obsolete too.
  const stale = prepare({ session_id: "s-stale", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  // The payload is dated a minute back and the state's summary a second back: newer, and not in the future (a future time decides nothing — below).
  writeFileSync(stale.payloadPath, JSON.stringify({ ...JSON.parse(readFileSync(stale.payloadPath, "utf8")), prepared_at: new Date(Date.now() - 60_000).toISOString() }));
  writeFileSync(join(STATE, "s-stale.json"), JSON.stringify({ thought_id: uuid(80), fingerprint: "newer", summary_at: new Date(Date.now() - 1_000).toISOString(), captured_at: new Date(Date.now() - 500).toISOString() }));
  const [so] = await postPending(cfg, stale.payloadPath);
  assert(so.obsolete === true && readState("s-stale").thought_id === uuid(80), "a payload older than the session's recorded capture is not posted and the state stands");
  // It is the SUMMARY's time that decides, not the post's (fourth review pass: the fallback alone satisfied the test above).
  const byPost = prepare({ session_id: "s-by-post", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(join(STATE, "s-by-post.json"), JSON.stringify({ thought_id: uuid(81), fingerprint: "x", summary_at: new Date(Date.now() - 60_000).toISOString(), captured_at: new Date(Date.now() + 60_000).toISOString() }));
  const [bp] = await postPending(cfg, byPost.payloadPath);
  assert(bp.ok && readState("s-by-post").thought_id === bp.id, "a state whose summary is older but whose post is newer does not make the payload obsolete — summary_at decides");
  const bySummary = prepare({ session_id: "s-by-summary", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(join(STATE, "s-by-summary.json"), JSON.stringify({ thought_id: uuid(82), fingerprint: "x", summary_at: new Date(Date.now() + 5_000).toISOString(), captured_at: new Date(Date.now() - 60_000).toISOString() }));
  const [bs] = await postPending(cfg, bySummary.payloadPath);
  assert(bs.ok && readState("s-by-summary").thought_id === bs.id, "…and a summary time in the FUTURE decides nothing: the payload posts and the state follows it (a clock that was wrong does not poison the session)");
  assert(Date.parse(readState("s-by-summary").summary_at) <= Date.now(), "…the state never records a summary time ahead of the clock");
  const skewed = prepare({ session_id: "s-skewed", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(skewed.payloadPath, JSON.stringify({ ...skewed.payload, prepared_at: new Date(Date.now() + 3_600_000).toISOString() }));
  const [sk] = await postPending(cfg, skewed.payloadPath);
  assert(sk.ok && Date.parse(readState("s-skewed").summary_at) <= Date.now(), "a PAYLOAD dated an hour ahead posts and the state clamps its summary time to now (fifth review pass: the min had no pin)");
  // Twenty payloads in a tight loop: the names order as made even inside one millisecond (fourth review pass: the two-payload check had a network call between them).
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push(basename(prepare({ session_id: `s-burst-${i}`, transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }).payloadPath));
  assert(burst.every((n, i) => i === 0 || burst[i - 1] < n), "twenty payloads prepared in a tight loop sort as made");
  for (const f of readdirSync(join(STATE, "pending"))) if (/-s-burst-/.test(f)) unlinkSync(join(STATE, "pending", f));
  // Six sessions stranded and one ending now: four of the six go, and the run's own always does.
  for (let i = 0; i < 6; i++) { prepare({ session_id: `s-many-${i}`, transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2); }
  const mine = prepare({ session_id: "s-mine", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const many = await postPending(cfg, mine.payloadPath);
  assert(many.length === 5 && many.at(-1).file === mine.payloadPath && many.every((o) => o.ok), `five per run, the run's own among them (${many.length})`);
  assert(readdirSync(join(STATE, "pending")).length === 2, "…two stranded ones wait for the next run");
  for (const f of readdirSync(join(STATE, "pending"))) unlinkSync(join(STATE, "pending", f));
  // A supersedes the server refuses (the earlier summary deleted, or not this
  // key's): dropped and retried, the session not dead forever.
  const r3 = await postCapture(cfg, { text: "[[refuse-supersedes]] summary", harness: "codex", derived_from: [], supersedes: uuid(60) });
  assert(r3.id && /supersedes dropped/.test(r3.note) && received.at(-1).args.supersedes === undefined && received.at(-2).args.supersedes === uuid(60),
    `a refused supersedes is dropped and the capture retried (${r3.note.slice(0, 60)})`);
  const r4 = await postCapture(cfg, { text: "[[refuse-derived]][[refuse-supersedes]] both", harness: "codex", derived_from: [uuid(61)], supersedes: uuid(62) });
  assert(r4.id && /source id\(s\) dropped/.test(r4.note) && /supersedes dropped/.test(r4.note) && received.at(-1).args.derived_from === undefined && received.at(-1).args.supersedes === undefined,
    "both pointers refused: both dropped, three calls, one capture");
}

// ── [6b] Two children on one queue ───────────────────────────────────────────
console.log("\n[6b] Two children draining one queue post each payload once; a dead child's claims come back");
{
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  for (let i = 0; i < 3; i++) { prepare({ session_id: `s-race-${i}`, transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2); }
  const child = () => spawnScript(["--post"]);
  const [a, b] = await Promise.all([child(), child()]);
  assert(a.code === 0 && b.code === 0 && !/ENOENT/.test(a.err + b.err), `both children exit 0 with no ENOENT (${(a.err + b.err).trim().slice(0, 80)})`);
  assert(received.length === 3, `three payloads, three posts — none twice, none lost (${received.length})`);
  assert(readdirSync(join(STATE, "pending")).length === 0 && readdirSync(join(STATE, "inflight")).length === 0, "pending/ and inflight/ are empty afterwards");
  assert([0, 1, 2].every((i) => readState(`s-race-${i}`)?.thought_id), "every session's state names its thought");
  // A claim left by a child that died: swept back and posted by the next run.
  mkdirSync(join(STATE, "inflight", "999999"), { recursive: true });
  const orphan = prepare({ session_id: "s-orphan", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(join(STATE, "inflight", "999999", basename(orphan.payloadPath)), readFileSync(orphan.payloadPath));
  unlinkSync(orphan.payloadPath);
  const swept = await postPending({ url: URL_, key: "cap-key" });
  assert(swept.some((o) => o.ok && basename(o.file) === basename(orphan.payloadPath)) && !existsSync(join(STATE, "inflight", "999999")), "a dead child's claim is swept back to pending/ and posted; its directory goes");
  // A claim under a pid that is ALIVE but not a hook (the number reused after a
  // reboot) is swept once it is older than any run can last (fourth review pass).
  const reused = join(STATE, "inflight", String(process.ppid));
  mkdirSync(reused, { recursive: true });
  const stuck = prepare({ session_id: "s-stuck", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(join(reused, basename(stuck.payloadPath)), readFileSync(stuck.payloadPath));
  unlinkSync(stuck.payloadPath);
  const fresh = await postPending({ url: URL_, key: "cap-key" });
  assert(!fresh.some((o) => basename(o.file) === basename(stuck.payloadPath)) && existsSync(reused), "a fresh claim under a live pid is left alone");
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(reused, old, old);
  const aged = await postPending({ url: URL_, key: "cap-key" });
  assert(aged.some((o) => o.ok && basename(o.file) === basename(stuck.payloadPath)) && !existsSync(reused), "…and swept back and posted once it is older than any run can last");
}

// ── [6c] Two children of ONE session ─────────────────────────────────────────
console.log("\n[6c] A checkpoint's child still posting when the session's end posts: the end steps aside and supersedes it (SMD-2035)");
{
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const cfg = { url: URL_, key: "cap-key" };
  const claimOf = (p) => { try { return readdirSync(join(STATE, "inflight")).some((pid) => existsSync(join(STATE, "inflight", pid, basename(p)))); } catch { return false; } };
  const logText = () => { try { return readFileSync(join(STATE, "log"), "utf8"); } catch { return ""; } }; // empty before the first line is written
  const postOf = (sid, kind) => received.find((r) => new RegExp(`Session ${sid}[,.]`).test(r.args.content) && /Checkpoint:/.test(r.args.content) === (kind === "checkpoint"));
  const iso = (ms) => new Date(ms).toISOString();
  const named = (ms, sid) => `${ms}-0-aaaa-${sid}.json`;
  const claimJson = (sid) => JSON.stringify({ session_id: sid }); // a planted claim says whose it is, as every real payload does (seventh review pass: the readers ask the file)
  const holder = join(STATE, "inflight", String(process.ppid)); // a claim under a pid that is alive and never clears: the suite's own parent
  const gone0 = await new Promise((res) => { const c = spawn(process.execPath, ["-e", "0"]); c.on("close", () => res(c.pid)); }); // a pid proven dead
  const DEFERRED = /^deferred: the session's earlier post is in flight \(pid \d+\); kept under pending\/ for the run that lands it$/;
  // The compaction's payload answers slowly (2.5 s); the end's, prepared while
  // that child is in flight, would otherwise land first with no pointer, and
  // the checkpoint after it as a second current thought saying "continuing".
  const slowT = join(TMP, "slow-chain.jsonl");
  writeFileSync(slowT, [user("[[slow]] keep going", { origin: { kind: "human" } }), assistant([{ type: "text", text: "on it" }])].join("\n"));
  const cp = prepare({ session_id: "s-chain", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" });
  assert(cp.payloadPath && cp.payload.supersedes === undefined, "a compaction's payload, nothing to supersede yet");
  await sleep(2);
  const beside = prepare({ session_id: "s-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "manual" });
  const childA = spawnScript(["--post", cp.payloadPath]);
  const t0 = Date.now();
  while (!(claimOf(cp.payloadPath) && claimOf(beside.payloadPath)) && Date.now() - t0 < 5000) await sleep(20);
  assert(claimOf(cp.payloadPath) && claimOf(beside.payloadPath) && readdirSync(join(STATE, "inflight")).length === 1, "the checkpoints' child holds its claims while the endpoint is slow");
  const end = prepare({ session_id: "s-chain", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd", reason: "exit" });
  await sleep(2);
  const besideEnd = prepare({ session_id: "s-beside", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd", reason: "exit" });
  assert(end.payloadPath && end.payload.supersedes === undefined && besideEnd.payloadPath, "both ends' payloads, prepared before their checkpoints have landed, name no pointer");
  // The ends' run: each is behind a checkpoint another live child holds, so
  // each steps aside AT ONCE — back under pending/, no wait — for the child
  // that lands its checkpoint to follow up with (fourth review pass: the first
  // cut waited on a budget, and every pass found its defects there).
  const t1 = Date.now();
  const outs = await postPending(cfg, end.payloadPath);
  const endMs = Date.now() - t1;
  const o = outs.find((x) => x.file === end.payloadPath), ob = outs.find((x) => x.file === besideEnd.payloadPath);
  assert(o?.deferred && ob?.deferred && endMs < 1000 && existsSync(end.payloadPath) && existsSync(besideEnd.payloadPath) && claimOf(cp.payloadPath) && received.length === 1,
    `both ends step aside at once (${endMs} ms) while their checkpoints' claims stand, and wait under pending/ (${o?.error})`);
  assert(DEFERRED.test(o?.error ?? "") && /deferred session=s-chain — the session's earlier post is in flight \(pid \d+\); kept under pending\/ for the run that lands it/.test(logText()), "…the outcome and the log name the pid holding the claim");
  // Three later ends of s-beside reach pending/ too (a resume ending again),
  // under fixed names a hash-ordered directory reads out of name order — 1,
  // 3, 2 on APFS — so without the sort the wrong one would post.
  for (const [i, tag] of [["1", "aaaa"], ["2", "bbbb"], ["3", "cccc"]]) writeFileSync(join(STATE, "pending", `999999999999${i}-${i}-${tag}-s-beside.json`), JSON.stringify({ ...besideEnd.payload, fingerprint: `later-${i}`, text: besideEnd.payload.text.replace(/\n\nSession s-beside/, `\n\nLater ${i}.\n\nSession s-beside`) }));
  const a = await childA;
  assert(a.code === 0 && received.length === 4 && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(join(STATE, "inflight")).length === 0 && readdirSync(join(STATE, "dead")).length === 3 && readdirSync(join(STATE, "dead")).includes(basename(besideEnd.payloadPath)),
    `the child lands its two, then follows up with the five ends behind them: the newest of each session posted, the three older obsolete (${received.length} posts; exit ${a.code}; dead: ${readdirSync(join(STATE, "dead")).length})`);
  const endPost = postOf("s-chain", "end"), besideEndPost = postOf("s-beside", "end");
  assert(endPost?.args.supersedes === uuid(1001) && readState("s-chain")?.thought_id === uuid(1003) && readState("s-chain")?.summary_at === end.payload.prepared_at, `the end supersedes the id the checkpoint landed (${endPost?.args.supersedes}) and the state names the end's: one current thought`);
  assert(besideEndPost?.args.supersedes === uuid(1002) && /\n\nLater 3\./.test(besideEndPost?.args.content ?? "") && readState("s-beside")?.thought_id === uuid(1004) && /following up: 5 payload\(s\) of s-chain, s-beside waited under pending\/ behind a claim this run cleared/.test(logText()),
    `the latest end of the other session supersedes its checkpoint (${besideEndPost?.args.supersedes}); the log has the follow-up`);
  // The predecessor lands but its bookkeeping fails (the state path a directory):
  // its payload goes back to pending/ carrying captured_id and the state names
  // nothing — the follow-up's pointer is read from the payload (first review pass).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  mkdirSync(join(STATE, "s-unbooked.json"), { recursive: true });
  const cp2 = prepare({ session_id: "s-unbooked", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "manual" });
  const childA2 = spawnScript(["--post", cp2.payloadPath]);
  const t3 = Date.now();
  while (!claimOf(cp2.payloadPath) && Date.now() - t3 < 5000) await sleep(20);
  const end2 = prepare({ session_id: "s-unbooked", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const outs2 = await postPending(cfg, end2.payloadPath);
  const a2 = await childA2;
  assert(outs2.filter((x) => x.file === end2.payloadPath).length === 1 && outs2[0]?.deferred && a2.code === 0 && received.length === 2 && received[1].args.supersedes === uuid(1001) && (logText().match(/bookkeeping failed/g) ?? []).length === 2 && readState("s-unbooked") === null,
    `the end steps aside, the checkpoint's child follows up with it and it supersedes the checkpoint the state never named — read from the landed payload under pending/ (${received[1]?.args.supersedes})`);
  rmSync(join(STATE, "s-unbooked.json"), { recursive: true, force: true });
  const settled = await postPending(cfg);
  assert(settled.length === 2 && settled.every((x) => x.ok) && received.length === 2 && readState("s-unbooked")?.thought_id === uuid(1002) && readdirSync(join(STATE, "pending")).length === 0, "the next run finishes both bookkeepings without posting again; the state names the end");
  assert(readdirSync(STATE).filter((f) => f.endsWith(".tmp")).length === 0, "the state writes that failed on the directory left no temp file behind (seventh review pass: one per run)");
  // A temp file a writer left under the state directory or pending/ is pruned once older than any run lasts; a fresh one may still be mid-write.
  const staleTmp = join(STATE, "s-old.json.4242.tmp"), freshTmp = join(STATE, "pending", `${Date.now()}-0-aaaa-s-fresh.json.4243.tmp`);
  writeFileSync(staleTmp, "{"); writeFileSync(freshTmp, "{");
  const aged = new Date(Date.now() - 20 * 60_000); utimesSync(staleTmp, aged, aged);
  await postPending(cfg);
  assert(!existsSync(staleTmp) && existsSync(freshTmp), "a stale temp file under the state directory is pruned; a fresh one under pending/ is left to its writer");
  unlinkSync(freshTmp);
  // A run whose own landing's bookkeeping fails does not follow up with the
  // payload it has itself just returned (fourth review pass: one outcome).
  mkdirSync(join(STATE, "s-ok.json"), { recursive: true });
  const okP = prepare({ session_id: "s-ok", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  const okRun = await postPending(cfg, okP.payloadPath);
  assert(okRun.length === 1 && okRun[0].ok && /bookkeeping deferred/.test(okRun[0].note) && !/following up/.test(logText().split("bookkeeping failed").at(-1)) && existsSync(okP.payloadPath), "a landing owed its bookkeeping is one outcome; the run does not follow up with its own return");
  rmSync(join(STATE, "s-ok.json"), { recursive: true, force: true });
  // The pointer by the rule alone — pointerFor over the state and the owed
  // payloads under pending/ and other claims: the NEWEST by prepared time.
  rmSync(STATE, { recursive: true, force: true });
  const S = "s-point", now = Date.now(), older = iso(now - 600_000), newer = iso(now - 300_000);
  const lair = join(STATE, "inflight", "424242");
  mkdirSync(join(STATE, "pending"), { recursive: true }); mkdirSync(lair, { recursive: true });
  writeFileSync(join(STATE, "pending", named(now - 3000, S)), JSON.stringify({ session_id: S, captured_id: uuid(77), prepared_at: newer }));
  writeFileSync(join(lair, named(now - 4000, S)), JSON.stringify({ session_id: S, captured_id: uuid(76), prepared_at: older }));
  writeFileSync(join(STATE, "pending", named(now - 2000, S)), JSON.stringify({ session_id: S, prepared_at: newer, text: "never posted" }));
  const me = named(now - 1000, S);
  assert(landedBefore(S, me)?.id === uuid(77) && landedBefore(S, named(now - 3500, S))?.id === uuid(76) && landedBefore(S, named(now - 5000, S)) === undefined,
    "landedBefore: the newest LANDED payload older than the name, wherever it lies and whatever order the directories are read in — not one still owed its post, none when nothing older has landed");
  assert(landedAfter(S, named(now - 3500, S)) === true && landedAfter(S, me) === false && landedAfter("s-none", me) === false, "landedAfter: whether a landed payload NEWER than the name exists — the never-posted one does not count");
  assert(pointerFor(S, me, { thought_id: uuid(78), summary_at: iso(now - 100_000) }) === uuid(78) && pointerFor(S, me, { thought_id: uuid(78), summary_at: older }) === uuid(77), "pointerFor: the newest by time — the state's thought when it is the later, the owed payload's when it is");
  assert(pointerFor(S, me, { thought_id: uuid(78), summary_at: older, captured_at: iso(now) }) === uuid(77) && pointerFor(S, me, { thought_id: uuid(78), captured_at: iso(now - 100_000) }) === uuid(78), "…the state by summary_at, its prepare time, not captured_at, its post time — which serves only a state from before summary_at");
  assert(pointerFor(S, me, { thought_id: uuid(78), summary_at: iso(now + 600_000) }) === uuid(78) && pointerFor(S, me, { thought_id: uuid(78), summary_at: "garbage" }) === uuid(78), "…a state time in the future, or none, leaves the state standing: the normal source is not outranked on a clock that was wrong (fourth review pass)");
  assert(pointerFor(S, me, null) === uuid(77) && pointerFor("s-none", me, null) === undefined && pointerFor("s-none", me, { thought_id: uuid(78), summary_at: older }) === uuid(78), "…no state: the owed payload; nothing landed: the state alone, or no pointer");
  writeFileSync(join(STATE, "pending", named(now - 1500, S)), JSON.stringify({ session_id: S, captured_id: uuid(79) }));
  assert(pointerFor(S, me, { thought_id: uuid(78), summary_at: iso(now - 100_000) }) === uuid(79), "…a landed payload with no prepared_at ranks by the millisecond in its name");
  assert(pointerFor(S, me, { thought_id: uuid(78), summary_at: iso(now - 100_000) }, { id: uuid(70), ms: now - 200_000 }) === uuid(79) && pointerFor(S, me, { thought_id: uuid(78), summary_at: iso(now - 100_000) }, { id: uuid(70), ms: now - 1000 }) === uuid(70) && pointerFor("s-none", me, null, { id: uuid(70), ms: now - 1000 }) === uuid(70),
    "…what the run itself landed ranks by its time like the rest — the last resort when nothing else knows, not a trump (eighth review pass)");
  writeFileSync(join(STATE, "pending", named(now + 3_600_000, S)), JSON.stringify({ session_id: S, captured_id: uuid(80), prepared_at: iso(now + 3_600_000) }));
  assert(pointerFor(S, named(now + 3_700_000, S), { thought_id: uuid(78), summary_at: iso(now - 100_000) }) === uuid(78), "…a payload written by a clock an hour ahead — prepared_at and name alike — ranks last and does not outrank the state (fifth review pass)");
  // An older checkpoint of a session whose END has landed in another child's
  // hands, its bookkeeping owed — or whose end is in another live child's
  // hands, not yet posted — is obsolete: posting it would stand a fresh
  // "continuing" thought after the end (second and fourth review passes).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const oldCp = prepare({ session_id: "s-late", transcript_path: CODEX_T, hook_event_name: "PreCompact", trigger: "auto" });
  await sleep(2);
  const lateEnd = prepare({ session_id: "s-late", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  mkdirSync(holder, { recursive: true });
  writeFileSync(join(holder, basename(lateEnd.payloadPath)), JSON.stringify({ ...lateEnd.payload, captured_id: uuid(88) }));
  unlinkSync(lateEnd.payloadPath);
  const lo = (await postPending(cfg, oldCp.payloadPath)).find((x) => x.file === oldCp.payloadPath);
  assert(lo?.obsolete && received.length === 0 && readdirSync(join(STATE, "dead")).length === 1, `an older checkpoint whose session's end has landed elsewhere, owed its bookkeeping, is obsolete and not posted (${lo?.error})`);
  const oldCp2 = prepare({ session_id: "s-swept", transcript_path: CODEX_T, hook_event_name: "PreCompact", trigger: "auto" });
  await sleep(2);
  const sweptEnd = prepare({ session_id: "s-swept", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  renameSync(sweptEnd.payloadPath, join(holder, basename(sweptEnd.payloadPath)));
  assert(newerInFlight("s-swept", basename(oldCp2.payloadPath)) === true && newerInFlight("s-swept", basename(sweptEnd.payloadPath)) === false && aheadOf("s-swept", basename(sweptEnd.payloadPath)).length === 0, "newerInFlight: a newer payload of the session in another live child's hands; not itself, and nothing is ahead of the newest");
  const so = (await postPending(cfg, oldCp2.payloadPath)).find((x) => x.file === oldCp2.payloadPath);
  assert(so?.obsolete && received.length === 0 && /following up/.test(logText()) === false && readdirSync(join(STATE, "dead")).length === 2, `…and an older checkpoint whose end is in another live child's hands, not yet posted, is obsolete too — the end covers it (${so?.error})`);
  rmSync(holder, { recursive: true, force: true });
  // The follow-up leaves alone what this run has itself just returned to
  // pending/: a session cleared through an owed bookkeeping whose newest
  // payload then fails to post, or steps aside, would otherwise be taken up
  // at once — attempts counted twice, two outcomes for one file (third and
  // fourth review passes).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const downT = join(TMP, "down-own.jsonl");
  writeFileSync(downT, [user("[[store-down]] wrap up", { origin: { kind: "human" } }), assistant([{ type: "text", text: "done" }])].join("\n"));
  const owed = prepare({ session_id: "s-own", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(owed.payloadPath, JSON.stringify({ ...owed.payload, captured_id: uuid(70) }));
  await sleep(2);
  const failing = prepare({ session_id: "s-own", transcript_path: downT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  mkdirSync(holder, { recursive: true });
  writeFileSync(join(holder, named(Date.now() - 5000, "s-own2")), claimJson("s-own2"));
  const owed2 = prepare({ session_id: "s-own2", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(owed2.payloadPath, JSON.stringify({ ...owed2.payload, captured_id: uuid(71) }));
  await sleep(2);
  const stepping = prepare({ session_id: "s-own2", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const ownRun = await postPending(cfg);
  assert(ownRun.length === 4 && ownRun.filter((x) => x.file === failing.payloadPath).length === 1 && !ownRun.find((x) => x.file === failing.payloadPath).ok && received.length === 1 && JSON.parse(readFileSync(failing.payloadPath, "utf8")).attempts === 1,
    `a payload the run itself returned to pending/ after a failed post is not followed up: one outcome, one post, one attempt (${ownRun.length} outcomes, ${received.length} post(s))`);
  assert(ownRun.filter((x) => x.file === stepping.payloadPath).length === 1 && ownRun.find((x) => x.file === stepping.payloadPath).deferred && ownRun.find((x) => x.file === owed2.payloadPath).deferred && (logText().match(/deferred session=s-own2/g) ?? []).length === 2 && !/following up/.test(logText()),
    "…nor one that stepped aside: one deferred outcome each, one deferred line each, no follow-up while the claim stands — the owed one beside a newer sibling steps aside for the older claim too, its state write after that one's (eleventh review pass)");
  rmSync(holder, { recursive: true, force: true });
  // The follow-up runs for a session whose claim this run cleared by DROPPING
  // a payload, not only by landing one: the child holding the newer payload
  // may have stepped aside for the older one this run has just dropped, and
  // its payload then waits under pending/ for whoever clears the way (fourth
  // review pass). Staged: the newer payload's claim clears mid-run, and the
  // stepped-aside payload appears under pending/ before the follow-up.
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  mkdirSync(holder, { recursive: true });
  const dropped = prepare({ session_id: "s-drop", transcript_path: CODEX_T, hook_event_name: "PreCompact", trigger: "auto" }); await sleep(2);
  const heldNewer = join(holder, named(Date.now(), "s-drop")); writeFileSync(heldNewer, claimJson("s-drop")); await sleep(2);
  const slowOther = prepare({ session_id: "s-drop-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const stepped = prepare({ session_id: "s-drop", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const steppedHome = stepped.payloadPath, steppedAside = join(TMP, basename(stepped.payloadPath));
  renameSync(steppedHome, steppedAside); // not yet under pending/: it is still in the other child's hands
  const dropRun = postPending(cfg);
  await sleep(600); // the older one is dropped at once; the slow payload of the other session is posting
  unlinkSync(heldNewer); renameSync(steppedAside, steppedHome); // the other child steps aside: its claim clears, its payload reaches pending/
  const dropped_ = await dropRun;
  assert(dropped_.find((x) => x.file === dropped.payloadPath)?.obsolete && dropped_.find((x) => x.file === slowOther.payloadPath)?.ok && dropped_.find((x) => x.file === steppedHome)?.ok && received.length === 2 && /following up: 1 payload\(s\) of s-drop waited under pending\/ behind a claim this run cleared/.test(logText()) && readdirSync(join(STATE, "pending")).length === 0,
    `a run that dropped a session's older payload for a newer one in another child's hands follows up with that session's payload once it waits under pending/ (${dropped_.map((x) => x.ok ? "ok" : x.obsolete ? "obsolete" : x.error).join(", ")})`);
  rmSync(holder, { recursive: true, force: true });
  // A failed post clears a claim too: an end that stepped aside for a
  // checkpoint whose post then fails must not wait for an unrelated run — the
  // run that failed follows up with it (fifth review pass). Staged: the
  // checkpoint fails at once, the run goes on with another session's slow
  // payload, and the end reaches pending/ meanwhile.
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const downCp = prepare({ session_id: "s-fail", transcript_path: downT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }); await sleep(2);
  const slowBeside = prepare({ session_id: "s-fail-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2);
  const failEnd = prepare({ session_id: "s-fail", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const failEndAside = join(TMP, basename(failEnd.payloadPath));
  renameSync(failEnd.payloadPath, failEndAside);
  const failRun = postPending(cfg);
  await sleep(600);
  renameSync(failEndAside, failEnd.payloadPath);
  const failed_ = await failRun;
  assert(!failed_.find((x) => x.file === downCp.payloadPath)?.ok && failed_.find((x) => x.file === slowBeside.payloadPath)?.ok && failed_.find((x) => x.file === failEnd.payloadPath)?.ok && received.filter((r) => /Session s-fail[,.]/.test(r.args.content)).length === 2 && /following up: 1 payload\(s\) of s-fail waited/.test(logText()) && existsSync(downCp.payloadPath),
    `a run whose checkpoint post failed follows up with the end that stepped aside for it (${failed_.map((x) => x.ok ? "ok" : x.obsolete ? "obsolete" : x.error.slice(0, 40)).join(" | ")})`);
  // A chained compaction: the end steps aside behind a checkpoint the child
  // is itself FOLLOWING UP with, so the follow-up goes round again (fifth
  // review pass: one round left the end under pending/ for an unrelated run).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const cpA = prepare({ session_id: "s-link", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" });
  const childLinkA = spawnScript(["--post", cpA.payloadPath]);
  const tL = Date.now();
  while (!claimOf(cpA.payloadPath) && Date.now() - tL < 5000) await sleep(20);
  const slow2T = join(TMP, "slow-link.jsonl");
  writeFileSync(slow2T, [user("[[slow]] keep going", { origin: { kind: "human" } }), user("and more", { origin: { kind: "human" } }), assistant([{ type: "text", text: "on it" }])].join("\n"));
  const cpB = prepare({ session_id: "s-link", transcript_path: slow2T, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "manual" }); // after the first child's claim: a second compaction while the first is still posting
  const childLinkB = await spawnScript(["--post", cpB.payloadPath]);
  assert(childLinkB.code === 0 && existsSync(cpB.payloadPath) && claimOf(cpA.payloadPath), "the second compaction's child steps aside behind the first's and exits 0");
  const tL2 = Date.now();
  while (!claimOf(cpB.payloadPath) && Date.now() - tL2 < 10_000) await sleep(20); // the first child lands its checkpoint and follows up with the second
  const linkEnd = prepare({ session_id: "s-link", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const linkOut = (await postPending(cfg, linkEnd.payloadPath)).find((x) => x.file === linkEnd.payloadPath);
  const linkA = await childLinkA;
  // Two interleavings are right (eleventh review pass): the child judges the
  // second checkpoint before the end looks — it posts it, and its second round
  // posts the end superseding it; or the end's claim is in the child's sight
  // when it judges the second checkpoint, which is then obsolete beside it,
  // and the end's second look finds the claim cleared and takes itself back.
  const rounds = (logText().match(/following up/g) ?? []).length;
  const chained = rounds === 2 && linkOut?.deferred && received.length === 3 && received[2].args.supersedes === uuid(1002) && !/Checkpoint:/.test(received[2].args.content) && readState("s-link")?.thought_id === uuid(1003);
  const retook = rounds === 1 && linkOut?.ok && received.length === 2 && received[1].args.supersedes === uuid(1001) && !/Checkpoint:/.test(received[1].args.content) && readdirSync(join(STATE, "dead")).includes(basename(cpB.payloadPath)) && readState("s-link")?.thought_id === uuid(1002);
  assert(linkA.code === 0 && (chained || retook) && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(join(STATE, "inflight")).length === 0,
    `the end steps aside behind the checkpoint being followed up and the child's second round posts it, or the checkpoint is obsolete beside the end and the end takes itself back — one current thought either way (${received.length} posts; rounds: ${rounds}; ${chained ? "chained" : retook ? "retook" : linkOut?.error ?? "?"})`);
  // Under the cap the follow-up takes a session's NEWEST payloads: six ends of
  // one session behind a cleared claim, five taken, the newest posted, the
  // oldest left under pending/ for the next run to drop (fifth review pass: the
  // oldest five were taken and a stale one posted).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const capOwed = prepare({ session_id: "s-cap", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(capOwed.payloadPath, JSON.stringify({ ...capOwed.payload, captured_id: uuid(60) })); await sleep(2);
  const capSlow = prepare({ session_id: "s-cap-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const capEnd = prepare({ session_id: "s-cap", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const capBody = JSON.parse(readFileSync(capEnd.payloadPath, "utf8")); unlinkSync(capEnd.payloadPath);
  // A second cleared session with two ends: the room is shared in rounds —
  // every session's newest before any session's second (sixth review pass:
  // the first session's obsolete older ends took the room the second's
  // newest needed).
  const capOwed2 = prepare({ session_id: "s-cap2", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(capOwed2.payloadPath, JSON.stringify({ ...capOwed2.payload, captured_id: uuid(61) }));
  const capRunning = postPending(cfg);
  await sleep(600); // the owed bookkeepings are done, the other session's slow payload is posting: the ends reach pending/ now, for the follow-up alone
  for (let i = 1; i <= 6; i++) writeFileSync(join(STATE, "pending", `99999999999${i}-${i}-cap${i}-s-cap.json`), JSON.stringify({ ...capBody, fingerprint: `cap-${i}`, prepared_at: iso(Date.parse(capBody.prepared_at) + i), text: capBody.text.replace(/\n\nSession s-cap/, `\n\nLater ${i}.\n\nSession s-cap`) }));
  for (let i = 1; i <= 2; i++) writeFileSync(join(STATE, "pending", `99999999999${i}-${i}-cap${i}-s-cap2.json`), JSON.stringify({ ...capBody, session_id: "s-cap2", chain_id: "s-cap2", fingerprint: `cap2-${i}`, prepared_at: iso(Date.parse(capBody.prepared_at) + i), text: capBody.text.replace(/\n\nSession s-cap/, `\n\nSecond ${i}.\n\nSession s-cap2`) }));
  const capRun = await capRunning;
  const posted = received.slice(1).map((r) => (/\n\n(Later \d|Second \d)\./.exec(r.args.content) ?? [])[1]).sort().join(",");
  assert(capRun.length === 11 && posted === "Later 6,Second 2" && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(join(STATE, "dead")).length === 6 && /following up: 5 payload\(s\) of (?:s-cap, s-cap2|s-cap2, s-cap) waited/.test(logText()) && (logText().match(/following up/g) ?? []).length === 2,
    `the follow-up shares its room in rounds across the two sessions: each session's newest posts, the six older ones are obsolete — the drops spend no room, so a second round finishes them (posted: ${posted}; dead: ${readdirSync(join(STATE, "dead")).length}; rounds: ${(logText().match(/following up/g) ?? []).length})`);
  assert((await postPending(cfg)).length === 0, "…and the next run has nothing of them left to drop");
  void capSlow;
  // Three cleared sessions of three ends each under the cap of five: the
  // first round takes every session's newest, the second round two more and
  // stops mid-round (seventh review pass: the inner room check had no tooth).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const threeOwed = ["s-t1", "s-t2", "s-t3"].map((sid) => { const o = prepare({ session_id: sid, transcript_path: CODEX_T, hook_event_name: "SessionEnd" }); writeFileSync(o.payloadPath, JSON.stringify({ ...o.payload, captured_id: uuid(66) })); return o; });
  const threeSlow = prepare({ session_id: "s-t-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const threeRunning = postPending(cfg);
  await sleep(600);
  for (const sid of ["s-t1", "s-t2", "s-t3"]) for (let i = 1; i <= 3; i++) writeFileSync(join(STATE, "pending", `99999999999${i}-${i}-t${i}-${sid}.json`), JSON.stringify({ ...capBody, session_id: sid, chain_id: sid, fingerprint: `${sid}-${i}`, prepared_at: iso(Date.now() + i), text: capBody.text.replace(/\n\nSession s-cap/, `\n\nThird ${i}.\n\nSession ${sid}`) }));
  const threeRun = await threeRunning;
  assert(threeRun.length === 13 && received.length === 4 && ["s-t1", "s-t2", "s-t3"].every((sid) => /\n\nThird 3\./.test(received.find((r) => new RegExp(`Session ${sid}[,.]`).test(r.args.content))?.args.content ?? "")) && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(join(STATE, "dead")).length === 6 && /following up: 5 payload\(s\)/.test(logText()),
    `three sessions of three: the first round takes every session's newest and two more, later rounds the rest — three posted, six obsolete, none left (${received.length} posts; pending: ${readdirSync(join(STATE, "pending")).length}; rounds: ${(logText().match(/following up/g) ?? []).length})`);
  void threeOwed; void threeSlow;
  // The cap counts what the follow-up posts or defers, not what it drops: five
  // stale ends of one cleared session, four obsolete beside the newest, must
  // not spend the room a second session's end, deferred meanwhile, needs
  // (eleventh review pass: the round's five claims were the five).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const owedT = prepare({ session_id: "s-capT", transcript_path: CODEX_T, hook_event_name: "SessionEnd" }); writeFileSync(owedT.payloadPath, JSON.stringify({ ...owedT.payload, captured_id: uuid(58) })); await sleep(2);
  const owedS = prepare({ session_id: "s-capS", transcript_path: CODEX_T, hook_event_name: "SessionEnd" }); writeFileSync(owedS.payloadPath, JSON.stringify({ ...owedS.payload, captured_id: uuid(59) })); await sleep(2);
  const capX = prepare({ session_id: "s-capX", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const capT = postPending(cfg);
  await sleep(600); // the owed bookkeepings are done; the slow payload posts: T's five ends arrive, the newest slow too
  for (let i = 1; i <= 5; i++) writeFileSync(join(STATE, "pending", `99999999999${i}-${i}-t${i}-s-capT.json`), JSON.stringify({ ...capBody, session_id: "s-capT", chain_id: "s-capT", fingerprint: `T-${i}`, prepared_at: iso(Date.now() + i), text: capBody.text.replace(/\n\nSession s-cap/, `\n\n${i === 5 ? "[[slow]] " : ""}Tail ${i}.\n\nSession s-capT`) }));
  await sleep(3000); // round 1 posts T's newest, slowly: S's end steps in meanwhile
  writeFileSync(join(STATE, "pending", `999999999996-6-s1-s-capS.json`), JSON.stringify({ ...capBody, session_id: "s-capS", chain_id: "s-capS", fingerprint: "S-1", prepared_at: iso(Date.now()), text: capBody.text.replace(/\n\nSession s-cap/, "\n\nEnd of S.\n\nSession s-capS") }));
  const capTRun = await capT;
  assert(capTRun.length === 9 && received.length === 3 && /Tail 5\./.test(received[1].args.content) && /End of S\./.test(received[2].args.content) && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(join(STATE, "dead")).length === 4 && (logText().match(/following up/g) ?? []).length === 2,
    `the follow-up's five drops of T's stale ends do not spend the room: S's end, deferred meanwhile, is followed up in the second round (${received.length} posts; rounds: ${(logText().match(/following up/g) ?? []).length}; outcomes: ${capTRun.length})`);
  // A pending file that parses to no object — a literal null — is a dead letter, not a crash that leaves every claim in the run's hands.
  writeFileSync(join(STATE, "pending", `${Date.now()}-0-aaaa-s-null.json`), "null");
  const nullRun = await postPending(cfg);
  assert(nullRun.length === 0 && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(join(STATE, "dead")).some((f) => f.endsWith("-s-null.json")) && readdirSync(join(STATE, "inflight")).length === 0, "a payload that is JSON but no object is a dead letter; the run goes on");
  // A payload of another session whose id sanitises to the same file tail
  // ("s.dot" and "s_dot" both name s_dot.json) is not this run's to follow
  // up: it goes back where it was, not to dead/ as obsolete (sixth review pass).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const dotOwed = prepare({ session_id: "s.dot", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  writeFileSync(dotOwed.payloadPath, JSON.stringify({ ...dotOwed.payload, captured_id: uuid(62) })); await sleep(2);
  const dotSlow = prepare({ session_id: "s-dot-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const underscore = prepare({ session_id: "s_dot", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const underscoreAside = join(TMP, basename(underscore.payloadPath));
  renameSync(underscore.payloadPath, underscoreAside);
  const dotRunning = postPending(cfg);
  await sleep(600);
  renameSync(underscoreAside, underscore.payloadPath);
  const dotRun = await dotRunning;
  assert(dotRun.length === 2 && dotRun.find((x) => x.file === dotSlow.payloadPath)?.ok && existsSync(underscore.payloadPath) && readdirSync(join(STATE, "dead")).length === 0 && !/following up/.test(logText()),
    `the other session's payload under the shared tail is left under pending/, unjudged (${dotRun.length} outcomes; dead: ${readdirSync(join(STATE, "dead")).length})`);
  // …and every other reader says whose a file is by reading it (seventh review pass: one of five had): the stranger's landed payload is no pointer and no reason to drop; in a live child's hands it is neither ahead nor newer in flight.
  writeFileSync(underscore.payloadPath, JSON.stringify({ ...underscore.payload, captured_id: uuid(65) }));
  const dotMine = `${Date.now() - 1000}-0-aaaa-s_dot.json`;
  assert(landedBefore("s.dot", `${Date.now() + 1000}-0-aaaa-s_dot.json`) === undefined && landedAfter("s.dot", dotMine) === false && landedBefore("s_dot", `${Date.now() + 1000}-0-aaaa-s_dot.json`)?.id === uuid(65), "a landed payload under the shared tail counts for its own session alone");
  mkdirSync(holder, { recursive: true });
  renameSync(underscore.payloadPath, join(holder, basename(underscore.payloadPath)));
  writeFileSync(join(holder, `${Date.now() - 6000}-0-aaaa-s_dot.json`), "{"); // unreadable, older
  writeFileSync(join(holder, `${Date.now() - 5000}-0-aaaa-s_dot.json`), JSON.stringify({ session_id: "s_dot" })); // the stranger's, older
  writeFileSync(join(holder, `${Date.now() + 5000}-0-aaaa-s_dot.json`), JSON.stringify({ session_id: "s_dot" })); // the stranger's, newer
  writeFileSync(join(holder, `${Date.now() + 6000}-0-aaaa-s_dot.json`), "{"); // unreadable, newer
  symlinkSync(join(holder, "nowhere"), join(holder, `${Date.now() - 7000}-0-aaaa-s_dot.json`)); // listed, gone on the read: a claim that has just cleared (ninth review pass)
  assert(aheadOf("s.dot", dotMine).length === 1 && aheadOf("s_dot", dotMine).length === 3 && landedBefore("s_dot", dotMine)?.id === uuid(65) && newerInFlight("s.dot", dotMine) === false && newerInFlight("s_dot", dotMine) === true,
    "in a live child's hands the stranger's older payloads are not ahead of this session — the unreadable one is, the safe side; one gone on the read is not — and its newer one is not newer in flight, nor is the unreadable one, the safe side; for their own session the older ones are ahead, landed or not (a landed one is still writing its state, and a post past it would race that write), all but the unreadable count as newer");
  rmSync(holder, { recursive: true, force: true });
  // Two children finishing one session's owed bookkeepings at once write the
  // state together: each writes beside under its own pid and renames, so
  // neither's rename finds the other's file gone (sixth review pass: one
  // shared temp name, and one child's bookkeeping "failed" every time).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const raceA = prepare({ session_id: "s-race", transcript_path: CODEX_T, hook_event_name: "SessionEnd" }); await sleep(2);
  const raceB = prepare({ session_id: "s-race", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  writeFileSync(raceA.payloadPath, JSON.stringify({ ...raceA.payload, captured_id: uuid(63) }));
  writeFileSync(raceB.payloadPath, JSON.stringify({ ...raceB.payload, captured_id: uuid(64) }));
  mkdirSync(join(STATE, "s-race.json.tmp"), { recursive: true }); // a stranger's temp name standing in the way: a write under one shared name would fail on it, a write under this process's own never meets it
  const [ra, rb] = await Promise.all([spawnScript(["--post", raceA.payloadPath]), spawnScript(["--post", raceB.payloadPath])]);
  assert(ra.code === 0 && rb.code === 0 && !/bookkeeping failed/.test(logText()) && readState("s-race")?.thought_id === uuid(64) && readdirSync(join(STATE, "pending")).length === 0 && readdirSync(STATE).filter((f) => f.endsWith(".tmp") && f !== "s-race.json.tmp").length === 0,
    `two children finish one session's owed bookkeepings together without a failed rename, each under its own temp name; the state names the newer (${(logText().match(/bookkeeping failed/g) ?? []).length} failure(s))`);
  rmSync(join(STATE, "s-race.json.tmp"), { recursive: true, force: true });
  // The landed payload's own id write fails — the temp path taken, as a full
  // disk would fail it — so it goes back under pending/ without its id and
  // the state is never written: the end that stepped aside for it, followed
  // up in the same run, still supersedes what the run landed, and the next
  // run drops the id-less payload as obsolete instead of posting it again
  // (eighth review pass; the seventh had declined this as unreachable).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const idO = prepare({ session_id: "s-idless", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }); await sleep(2);
  const idSlow = prepare({ session_id: "s-idless-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2);
  const idEnd = prepare({ session_id: "s-idless", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const idEndAside = join(TMP, basename(idEnd.payloadPath));
  renameSync(idEnd.payloadPath, idEndAside);
  mkdirSync(join(STATE, "inflight", String(process.pid), `${basename(idO.payloadPath)}.${process.pid}.tmp`), { recursive: true }); // the temp path, taken
  writeFileSync(join(STATE, "s-idless.json"), JSON.stringify({ thought_id: uuid(50), fingerprint: "old", captured_at: iso(Date.now() - 3_600_000), summary_at: iso(Date.now() - 3_600_000) })); // an end an hour ago: the run's landing is the newer, by its time (ninth review pass: the moment had no tooth)
  writeFileSync(idO.payloadPath, JSON.stringify({ ...idO.payload, prepared_at: "garbage" })); // …and by its NAME when its prepare time is unusable, as a file's is (tenth review pass)
  const idRunning = postPending(cfg);
  await sleep(600);
  renameSync(idEndAside, idEnd.payloadPath); // the end reaches pending/ while the run posts the slow one
  const idRun = await idRunning;
  const idO_ = idRun.find((x) => x.file === idO.payloadPath), idEnd_ = idRun.find((x) => x.file === idEnd.payloadPath);
  assert(idO_?.ok && /bookkeeping deferred/.test(idO_.note) && JSON.parse(readFileSync(idO.payloadPath, "utf8")).captured_id === undefined && idEnd_?.ok && received.length === 3 && received[2].args.supersedes === uuid(1001) && readState("s-idless")?.thought_id === uuid(1003),
    `the end followed up supersedes what the run landed though the landed payload carries no id (${received[2]?.args.supersedes}; ${idO_?.note})`);
  rmSync(join(STATE, "inflight", String(process.pid)), { recursive: true, force: true });
  writeFileSync(idO.payloadPath, JSON.stringify({ ...JSON.parse(readFileSync(idO.payloadPath, "utf8")), prepared_at: idO.payload.prepared_at })); // the hand-made unusable time restored: the next run judges obsolescence by it, and an unusable one decides nothing
  const idNext = await postPending(cfg);
  assert(idNext.find((x) => x.file === idO.payloadPath)?.obsolete && received.length === 3 && readdirSync(join(STATE, "pending")).length === 0, "…and the next run drops the id-less payload as obsolete beside the state, not posting it again");
  void idSlow;
  // …and it is a last resort, not a trump: a sibling landing a newer summary
  // of the session meanwhile writes the state, and the state's thought — later
  // than what this run landed, earlier than the end — is the pointer.
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const id2O = prepare({ session_id: "s-idless2", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }); await sleep(3);
  const id2Slow = prepare({ session_id: "s-idless2-beside", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(3);
  const id2End = prepare({ session_id: "s-idless2", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const id2EndAside = join(TMP, basename(id2End.payloadPath));
  renameSync(id2End.payloadPath, id2EndAside);
  mkdirSync(join(STATE, "inflight", String(process.pid), `${basename(id2O.payloadPath)}.${process.pid}.tmp`), { recursive: true });
  const id2Running = postPending(cfg);
  await sleep(600);
  writeFileSync(join(STATE, "s-idless2.json"), JSON.stringify({ thought_id: uuid(88), fingerprint: "sib", captured_at: iso(Date.now()), summary_at: iso(Date.parse(id2O.payload.prepared_at) + 1) }));
  renameSync(id2EndAside, id2End.payloadPath);
  const id2Run = await id2Running;
  assert(id2Run.find((x) => x.file === id2End.payloadPath)?.ok && received.length === 3 && received[2].args.supersedes === uuid(88),
    `a sibling's newer state outranks what the run landed: the end supersedes the state's thought (${received[2]?.args.supersedes})`);
  rmSync(join(STATE, "inflight", String(process.pid)), { recursive: true, force: true });
  void id2Slow;
  // A temp file a child left mid-write in its claim directory is no payload:
  // the sweep unlinks it rather than moving it under pending/ for ever.
  const deadDir = join(STATE, "inflight", String(gone0));
  mkdirSync(deadDir, { recursive: true });
  writeFileSync(join(deadDir, `${Date.now()}-0-aaaa-s-tmp.json.${gone0}.tmp`), "{");
  const junk = join(STATE, "pending", `${Date.now()}-0-aaaa-s-junk.json`);
  writeFileSync(junk, "{"); // a payload that will not parse
  await postPending(cfg);
  assert(!existsSync(deadDir) && readdirSync(join(STATE, "pending")).length === 0, "a dead child's half-written temp file is unlinked by the sweep, not swept into pending/");
  assert(!existsSync(junk) && readdirSync(join(STATE, "dead")).includes(basename(junk)) && /dead \S+-s-junk\.json — not a payload this run can read/.test(logText()), "a payload that will not parse is a dead letter, and the log says why (tenth review pass: it had no tooth and no line)");
  // The follow-up's "newest" of a session never regresses across rounds: the
  // newest, taken in the main claim, posts slowly and fails; an older payload
  // reaching pending/ meanwhile is followed up — and is obsolete beside it,
  // not the session's newest (ninth review pass: a fresh set per round named
  // it newest and it posted).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const slowDownT = join(TMP, "slow-down.jsonl");
  writeFileSync(slowDownT, [user("[[slow-down]] wrap up", { origin: { kind: "human" } }), assistant([{ type: "text", text: "done" }])].join("\n"));
  const rgC = prepare({ session_id: "s-regress", transcript_path: downT, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }); await sleep(3);
  const rgM = prepare({ session_id: "s-regress", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "manual" }); await sleep(3);
  const rgE = prepare({ session_id: "s-regress", transcript_path: slowDownT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const rgMAside = join(TMP, basename(rgM.payloadPath));
  renameSync(rgM.payloadPath, rgMAside);
  const rgRunning = postPending(cfg);
  await sleep(600); // the checkpoint is obsolete beside the end; the end is posting, slowly, and will fail
  renameSync(rgMAside, rgM.payloadPath);
  const rgRun = await rgRunning;
  assert(rgRun.find((x) => x.file === rgC.payloadPath)?.obsolete && !rgRun.find((x) => x.file === rgE.payloadPath)?.ok && rgRun.find((x) => x.file === rgM.payloadPath)?.obsolete && received.length === 1 && existsSync(rgE.payloadPath) && !existsSync(rgM.payloadPath),
    `the middle payload followed up is obsolete beside the failed newest, not posted as the newest (${rgRun.map((x) => x.ok ? "ok" : x.obsolete ? "obsolete" : "failed").join(", ")}; ${received.length} post(s))`);
  // A payload that steps aside goes back under pending/ AT ONCE, not at the
  // run's end: while this run goes on posting another session's slow payload,
  // the landing child's follow-up must be able to see it, and a newer payload
  // of its session in a third child must not step aside for it (third review pass).
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  mkdirSync(holder, { recursive: true });
  writeFileSync(join(holder, named(Date.now() - 5000, "s-d1")), claimJson("s-d1"));
  const d1 = prepare({ session_id: "s-d1", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2);
  const d2 = prepare({ session_id: "s-d2", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  const running = postPending(cfg);
  await sleep(700);
  const midway = { d1Pending: existsSync(d1.payloadPath), d2Held: claimOf(d2.payloadPath) };
  const ran = await running;
  assert(midway.d1Pending && midway.d2Held && ran.find((x) => x.file === d1.payloadPath)?.deferred && ran.find((x) => x.file === d2.payloadPath)?.ok, `the payload that stepped aside is under pending/ while the run still posts the slow one it holds (${JSON.stringify(midway)})`);
  // A checkpoint between an older one still posting and the session's END that
  // has landed owed its bookkeeping — both in another child's hands — is
  // obsolete, and steps aside for nothing: the question asked before stepping
  // aside is the one asked before posting (third review pass).
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(holder, { recursive: true });
  const c0 = prepare({ session_id: "s-mid", transcript_path: CODEX_T, hook_event_name: "PreCompact", trigger: "auto" }); await sleep(2);
  const c1 = prepare({ session_id: "s-mid", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }); await sleep(2);
  const midEnd = prepare({ session_id: "s-mid", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  renameSync(c0.payloadPath, join(holder, basename(c0.payloadPath)));
  writeFileSync(join(holder, basename(midEnd.payloadPath)), JSON.stringify({ ...midEnd.payload, captured_id: uuid(66) })); unlinkSync(midEnd.payloadPath);
  const mid = (await postPending(cfg, c1.payloadPath)).find((x) => x.file === c1.payloadPath);
  assert(mid?.obsolete && !/deferred session=/.test(logText()), `a checkpoint the session's landed end outdates is obsolete, not deferred behind the older one (${mid?.error})`);
  // …and the same with the end UNPOSTED in that child's hands: the newer-in-flight rule at the step-aside gate, alone (fifth review pass: it had a tooth only at the posting gate).
  const c0b = prepare({ session_id: "s-mid2", transcript_path: CODEX_T, hook_event_name: "PreCompact", trigger: "auto" }); await sleep(2);
  const c1b = prepare({ session_id: "s-mid2", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }); await sleep(2);
  const midEnd2 = prepare({ session_id: "s-mid2", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  renameSync(c0b.payloadPath, join(holder, basename(c0b.payloadPath))); renameSync(midEnd2.payloadPath, join(holder, basename(midEnd2.payloadPath)));
  const mid2 = (await postPending(cfg, c1b.payloadPath)).find((x) => x.file === c1b.payloadPath);
  assert(mid2?.obsolete && !/deferred session=/.test(logText()), `a checkpoint whose session's end is in another child's hands, unposted, is obsolete before it would step aside for the older one (${mid2?.error})`);
  rmSync(holder, { recursive: true, force: true });
  // One run over five payloads against claims that never clear: the older
  // sibling and the one the state outdates obsolete, the landed one finished,
  // the two behind a claim stepping aside — at once, both back under pending/.
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  mkdirSync(holder, { recursive: true });
  for (const sid of ["s-b1", "s-b2", "s-b3", "s-b4"]) writeFileSync(join(holder, named(Date.now() - 5000, sid)), claimJson(sid));
  const b1old = prepare({ session_id: "s-b1", transcript_path: CODEX_T, hook_event_name: "SessionEnd" }); await sleep(2);
  const b1 = prepare({ session_id: "s-b1", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2);
  const b2 = prepare({ session_id: "s-b2", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2);
  const b3 = prepare({ session_id: "s-b3", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }); await sleep(2);
  writeFileSync(b3.payloadPath, JSON.stringify({ ...b3.payload, captured_id: uuid(90) }));
  const b4 = prepare({ session_id: "s-b4", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" });
  await sleep(2); // the state must be LATER than the payload, not in its millisecond
  writeFileSync(join(STATE, "s-b4.json"), JSON.stringify({ thought_id: uuid(91), fingerprint: "y", captured_at: iso(Date.now()), summary_at: iso(Date.now()) }));
  const t4 = Date.now();
  const five = await postPending(cfg);
  const by = (p) => five.find((x) => x.file === p.payloadPath);
  assert(Date.now() - t4 < 1000 && five.length === 5 && by(b1old)?.obsolete && by(b3)?.deferred && by(b4)?.obsolete && by(b1)?.deferred && by(b2)?.deferred && DEFERRED.test(by(b1).error),
    `one run, five payloads, at once (${Date.now() - t4} ms): the older sibling and the outdated one obsolete, the three behind a claim deferred — the landed one too, whose state write must follow the older's (tenth review pass)`);
  assert(readdirSync(join(STATE, "pending")).sort().join() === [basename(b1.payloadPath), basename(b2.payloadPath), basename(b3.payloadPath)].sort().join() && received.length === 0 && (logText().match(/deferred session=/g) ?? []).length === 3,
    "the three deferred payloads are back under pending/, nothing posted, one deferred line each");
  rmSync(holder, { recursive: true, force: true });
  // The rule alone: only an OLDER payload of the SAME session under a LIVE
  // other pid is ahead.
  const gone = await new Promise((res) => { const c = spawn(process.execPath, ["-e", "0"]); c.on("close", () => res(c.pid)); }); // a pid proven dead, not a number assumed so (first review pass)
  const mine = named(Date.now(), "s-chain");
  const live = join(STATE, "inflight", String(process.ppid)), dead = join(STATE, "inflight", String(gone));
  mkdirSync(live, { recursive: true }); mkdirSync(dead, { recursive: true });
  writeFileSync(join(live, named(Date.now() + 1000, "s-chain")), claimJson("s-chain"));
  writeFileSync(join(live, named(Date.now() - 1000, "s-chained")), claimJson("s-chained"));
  writeFileSync(join(dead, named(Date.now() - 1000, "s-chain")), claimJson("s-chain"));
  const unheld = join(STATE, "pending", named(Date.now() - 1000, "s-chain")), own = join(STATE, "inflight", String(process.pid));
  writeFileSync(unheld, claimJson("s-chain"));
  mkdirSync(own, { recursive: true }); writeFileSync(join(own, named(Date.now() - 1000, "s-chain")), claimJson("s-chain"));
  assert(aheadOf("s-chain", mine).length === 0, "a NEWER payload of the session in a live child's hands is not ahead (only the newer of two steps aside, so two children never wait on each other); nor an older one of another session, nor one under a pid that is gone, nor one under pending/ that no child holds, nor one in this run's own hands");
  writeFileSync(join(dead, named(Date.now() + 3000, "s-chain")), claimJson("s-chain")); writeFileSync(join(own, named(Date.now() + 3000, "s-chain")), claimJson("s-chain"));
  assert(newerInFlight("s-chain", mine) === true && newerInFlight("s-chain", named(Date.now() + 2000, "s-chain")) === false && newerInFlight("s-chained", named(Date.now() - 2000, "s-chained")) === true && newerInFlight("s-chain", named(Date.now() + 1500, "s-chain")) === false,
    "…while that newer one in a live child's hands outdates this one — by session, by name, by liveness: a newer one under a pid that is gone, or in this run's own hands, outdates nothing");
  unlinkSync(unheld); rmSync(own, { recursive: true, force: true });
  writeFileSync(join(live, named(Date.now() - 1000, "s-chain")), claimJson("s-chain"));
  assert(aheadOf("s-chain", mine).length === 1 && aheadOf("s-chain", mine)[0].pid === process.ppid, "an older one under a live pid is ahead, named by its pid");
  rmSync(live, { recursive: true, force: true }); rmSync(dead, { recursive: true, force: true });
}

// ── [7] The hook end to end, synchronous ─────────────────────────────────────
console.log("\n[7] As a hook: JSON on stdin, exit codes, and what reaches the endpoint");
{
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  const r = await runHook({ session_id: "s-e2e", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd", reason: "prompt_input_exit" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(r.code === 0 && /captured 0000/.test(r.err), `exit 0 and the id on stderr (${r.err.trim().slice(0, 80)})`);
  assert(received.length === 1 && received[0].args.source === "claude-code", "one capture reached the endpoint, from claude-code");
  const secretT = join(TMP, "secret2.jsonl");
  writeFileSync(secretT, [user("MCP_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz012345 please", { origin: { kind: "human" } }), assistant([{ type: "text", text: "no" }])].join("\n"));
  const s = await runHook({ session_id: "s-sec", transcript_path: secretT, hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1", OB1_CAPTURE_ON_SECRET: "refuse" });
  assert(s.code === 1 && /refused/.test(s.err) && /credential assignment/.test(s.err) && !/abcdefghijklmnop/.test(s.err), "a secret under refuse: exit 1, the reason named, the secret not echoed");
  assert(received.length === 1, "…and nothing was sent");
  const typoMode = await runHook({ session_id: "s-sec-typo", transcript_path: secretT, hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1", OB1_CAPTURE_ON_SECRET: "redcat" });
  assert(typoMode.code === 1 && /session-capture: OB1_CAPTURE_ON_SECRET takes redact or refuse, not "redcat"; nothing captured/.test(typoMode.err) && received.length === 1 && !readdirSync(join(STATE, "pending")).some((f) => /-s-sec-typo\.json$/.test(f)),
    `a mode the environment misspells is refused with exit 1 and nothing captured — neither mode taken for it (${typoMode.err.trim().slice(0, 90)})`);
  const sr = await runHook({ session_id: "s-sec-red", transcript_path: secretT, hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(sr.code === 0 && /session-capture: captured 0000/.test(sr.err) && received.length === 2 && /MCP_ACCESS_KEY=\[redacted:credential assignment, high-entropy token\] please/.test(received[1].args.content) && !/abcdefghijklmnop/.test(received[1].args.content) && received[1].args.source === "claude-code",
    `the same secret under redact (the default): exit 0, captured, the marker in the content that reached the endpoint and the key not (${sr.err.trim().slice(0, 60)})`);
  const g = await runHook({ session_id: "s-garbage", transcript_path: CLAUDE_T, hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1", OB1_SESSION_CAPTURE_CONFIG: join(TMP, "nope.json") });
  assert(g.code === 1 && /no endpoint or key/.test(g.err) && /keygen\.ts --name session-hook --scope capture/.test(g.err), "no config: exit 1, saying how to mint the key");
  assert(!readdirSync(join(STATE, "pending")).some((f) => /-s-garbage\.json$/.test(f)), "…and nothing queued: a hook pasted before its config does not pile up payloads (fifth review pass)");
  const n = await runHook("not json {", {}, [], true);
  assert(n.code === 1 && /not the hook's JSON/.test(n.err), "malformed stdin: exit 1");
  const hb = await runHook({ session_id: "s-h", transcript_path: CLAUDE_T, hook_event_name: "SessionEnd" }, {}, ["--harness", "Codex"]);
  assert(hb.code === 1 && /--harness takes claude-code or codex/.test(hb.err), "a --harness that is neither is refused with usage and exit 1 — never 2, which would block a Stop (seventh review pass)");
  // The fake server's sentences are the real server's: the hook tells a refusal from an error and a position from a list by the server's PROSE, so the shapes it reads must be the ones index.ts writes (tenth review pass: nothing linked the two).
  {
    const serverSrc = readFileSync(join(HERE, "..", "..", "server-portable", "index.ts"), "utf8").replace(/\\`/g, "`"); // the sentences sit in template literals, their backticks escaped
    for (const sentence of [
      "Refused: a capture-scoped key may name as `supersedes` only a thought it captured itself",
      "Refused: no thought with the id given as supersedes",
      "this key's `supersedes` could not be checked against the target's capture record",
      "this key's `supersedes` could not be attributed while the agent registry is unavailable",
      "derived_from[${i}] (${sent[i]})",
      " no thought. Each entry must be an existing thought id (the ID: line of a search result).", // the verb is built, the rest is literal
    ]) assert(serverSrc.includes(sentence), `index.ts still says: ${sentence.slice(0, 60)}`);
    assert(REFUSAL_RE.test("Refused: a capture-scoped key may name as `supersedes` only a thought it captured itself") && !REFUSAL_RE.test("Error: this key's `supersedes` could not be checked against the target's capture record (x)"),
      "…and the hook's refusal rule reads the server's Refused: and not its Error:");
  }
  const evOnHook = await runHook({ session_id: "s-ev-flag", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1" }, ["--event", "PreCompact"]);
  const trOnHook = await runHook({ session_id: "s-tr-flag", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }, { OB1_SESSION_CAPTURE_SYNC: "1" }, ["--trigger=manual"]);
  assert(evOnHook.code === 1 && /--event is not a hook flag — a hook takes --harness and --min-interval/.test(evOnHook.err) && trOnHook.code === 1 && /--trigger is not a hook flag/.test(trOnHook.err) && !readState("s-ev-flag") && !readState("s-tr-flag"),
    `as a hook, --event or --trigger on the command line is refused with exit 1 and nothing captured — the harness sends both on stdin (fourth review pass: they ran, ignored, in silence; exits ${evOnHook.code}/${trOnHook.code})`);
  const typoOnHook = await runHook({ session_id: "s-typo-flag", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "Stop" }, { OB1_SESSION_CAPTURE_SYNC: "1" }, ["--min-intervall", "20"]);
  assert(typoOnHook.code === 1 && /--min-intervall is not a hook flag/.test(typoOnHook.err) && !readState("s-typo-flag"), "…and so is any other flag: a misspelt --min-interval would have captured every turn in silence (fifth review pass)");
  assert((await runHook({ session_id: "s-two-flags", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "Stop" }, { OB1_SESSION_CAPTURE_SYNC: "1" }, ["--harness=claude-code", "--min-interval=20"])).code === 0 && readState("s-two-flags")?.thought_id, "…while the hook's two flags, in either form, run");
  const mib = await runHook({ session_id: "s-mi", transcript_path: CLAUDE_T, hook_event_name: "Stop" }, {}, ["--min-interval", "20m"]);
  assert(mib.code === 1 && /--min-interval takes a number of minutes/.test(mib.err), `"--min-interval 20m" is refused (exit ${mib.code}), not run as NaN and a capture every turn (eighth review pass)`);
  // The synchronous path reports the RUN'S OWN outcome even when an older
  // stranded payload posts before it (third review pass).
  prepare({ session_id: "s-stranded-before", transcript_path: CODEX_T, hook_event_name: "SessionEnd" });
  await sleep(5);
  const own = await runHook({ session_id: "s-own-after", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(own.code === 0 && /captured 0000/.test(own.err) && readState("s-own-after")?.thought_id !== undefined && readState("s-stranded-before")?.thought_id !== undefined,
    `both post, and the exit and the message are the run's own (${own.err.trim().slice(0, 60)})`);
  received.length = 1;
  const skip = await runHook({ session_id: "s-e2e", transcript_path: CLAUDE_T, hook_event_name: "Stop" }, { OB1_SESSION_CAPTURE_SYNC: "1" }, ["--min-interval", "20"]);
  assert(skip.code === 0 && /skip: last capture/.test(skip.err) && received.length === 1, "a Stop inside the interval sends nothing and exits 0");
  // A compaction, then the session's end, the transcript unchanged (SMD-2012):
  // the checkpoint's summary names the compaction; the end's supersedes it and
  // names nothing — a reader tells a summary of a running session from a final one.
  const before = received.length;
  const cpt = await runHook({ session_id: "s-compact-chain", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "PreCompact", trigger: "auto" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(cpt.code === 0 && received.length === before + 1 && /\n\nCheckpoint: compacted at 2026-09-22 13:20 \(auto\), continuing/.test(received.at(-1).args.content) && received.at(-1).args.supersedes === undefined,
    `a PreCompact hook captures a summary naming the compaction (exit ${cpt.code}: ${cpt.err.trim().slice(0, 60)})`);
  const cptId = readState("s-compact-chain")?.thought_id;
  const end = await runHook({ session_id: "s-compact-chain", transcript_path: CLAUDE_T, cwd: "/repo/proj", hook_event_name: "SessionEnd", reason: "other" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(end.code === 0 && received.length === before + 2 && cptId && received.at(-1).args.supersedes === cptId && !/Checkpoint:/.test(received.at(-1).args.content),
    `…and the session's end, the transcript unchanged, supersedes it with a summary naming no checkpoint (${end.err.trim().slice(0, 60)})`);
  assert(/captured session=s-compact-chain harness=claude-code event=PreCompact trigger=auto id=/.test(readFileSync(join(STATE, "log"), "utf8")), "the log names the event and its trigger when it is not the session's end");
  const foreignRun = await runHook({ session_id: "s-compact-chain", transcript_path: join(TMP, "two.jsonl"), cwd: "/repo/proj", hook_event_name: "UserPromptSubmit" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(foreignRun.code === 0 && received.length === before + 2 && /skip: UserPromptSubmit is not an event this hook captures on/.test(foreignRun.err), `as a hook under an event it is not for: exit 0, nothing sent, the skip named (${foreignRun.err.trim().slice(0, 70)})`);
  const protoRun = await runHook({ session_id: "s-compact-chain", transcript_path: join(TMP, "two.jsonl"), cwd: "/repo/proj", hook_event_name: "toString" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(protoRun.code === 0 && received.length === before + 2 && /skip: toString is not an event this hook captures on/.test(protoRun.err), "…and under one of Object's own names — which passed as an event and captured an end over the checkpoint (third review pass)");
}

// ── [8] Detached ─────────────────────────────────────────────────────────────
console.log("\n[8] Detached: the hook returns inside the SessionEnd budget and the capture still lands");
{
  rmSync(STATE, { recursive: true, force: true });
  received.length = 0;
  // The endpoint takes 2.5 s to answer this one: a post made in the foreground
  // would bust the budget, so the timing below is a test of the hand-off, not
  // of localhost being fast (first review pass: two detach mutants passed).
  const slowT = join(TMP, "slow.jsonl");
  writeFileSync(slowT, [user("[[slow]] wrap up the session", { origin: { kind: "human" } }), assistant([{ type: "text", text: "done" }])].join("\n"));
  const r = await runHook({ session_id: "s-detached", transcript_path: slowT, cwd: "/repo/proj", hook_event_name: "SessionEnd", reason: "other" });
  assert(r.code === 0 && r.ms < 1500, `the foreground exits 0 in ${r.ms} ms (budget 1500) while the endpoint takes 2500`);
  const t0 = Date.now();
  while (received.length === 0 && Date.now() - t0 < 10_000) await sleep(50);
  assert(received.length === 1 && received[0].args.source === "claude-code", `the detached child posted (${received.length} capture(s), after ${Date.now() - t0} ms)`);
  while (!readState("s-detached") && Date.now() - t0 < 10_000) await sleep(50);
  assert(readState("s-detached")?.thought_id !== undefined, "…and recorded the id");
  const log = readFileSync(join(STATE, "log"), "utf8");
  assert(/posting in pid \d+/.test(log) && /captured session=s-detached harness=claude-code/.test(log), "the log has the hand-off and the capture, under the hook's session id");
  assert((log.match(/^\S+ captured session=s-detached/gm) ?? []).length === 1 && !/^captured 0000/m.test(log), "…once: the child's stdout is not echoed into the log");
}

// ── [9] The printed hook and --check ────────────────────────────────────────
console.log("\n[9] The printed hook carries no secret; --check tells a capture key from a wider one");
{
  const noHarness = await runHook({}, {}, ["--print-hook", "--event", "Stop", "--min-interval", "20"]);
  assert(noHarness.code === 0 && /"Stop"/.test(noHarness.out) && /--min-interval 20/.test(noHarness.out), `--print-hook with no harness named and flags after it prints the Claude Code hook (exit ${noHarness.code}: ${(noHarness.err || "").slice(0, 60)})`);
  const own = hookJson("claude-code", {});
  assert(own.hooks.SessionEnd[0].hooks[0].command.startsWith(shellWord(process.execPath) + " "), `with no runtime named the hook runs the absolute path of the runtime that printed it, not a bare word (${own.hooks.SessionEnd[0].hooks[0].command.split(" ")[0]})`);
  const cc = hookJson("claude-code", { runtime: "bun" });
  assert(cc.hooks.SessionEnd[0].hooks[0].command === `bun ${SCRIPT}` && cc.hooks.SessionEnd[0].hooks[0].timeout === 10, "Claude Code: SessionEnd, the script's absolute path, timeout 10");
  const cx = hookJson("codex", { runtime: "bun" });
  assert(cx.hooks.SessionEnd[0].hooks[0].timeout === 3, "Codex: timeout 3, its maximum for SessionEnd");
  const st = hookJson("claude-code", { event: "Stop", minInterval: 30, runtime: "node" });
  assert(st.hooks.Stop[0].hooks[0].command === `node ${SCRIPT} --min-interval 30` && st.hooks.Stop[0].hooks[0].timeout === undefined, "Stop: the interval rides on the command line, and no timeout — the harness's 600 s default stands");
  assert(Object.keys(own.hooks).join() === "SessionEnd,PreCompact" && own.hooks.PreCompact[0].hooks[0].command === own.hooks.SessionEnd[0].hooks[0].command && own.hooks.PreCompact[0].hooks[0].timeout === 10,
    `Claude Code with no event named prints the pair — SessionEnd and PreCompact, one command, PreCompact pinned to 10 s too: it shares no budget, but a compaction waits on it (${Object.keys(own.hooks).join()}) (SMD-2012)`);
  assert(Object.keys(cx.hooks).join() === "SessionEnd" && Object.keys(st.hooks).join() === "Stop" && Object.keys(hookJson("claude-code", { event: "PreCompact", runtime: "bun" }).hooks).join() === "PreCompact",
    "Codex's default is SessionEnd alone — it has no compaction hook; an event named prints that event alone");
  const thrown = (fn) => { try { fn(); return ""; } catch (e) { return e.message; } };
  assert(/no default events for harness "claude"/.test(thrown(() => hookJson("claude", {}))), "a harness with no defaults is a named error from hookJson, not a TypeError off undefined (first review pass)");
  assert(/"precompact" is not an event this hook runs on/.test(thrown(() => hookJson("claude-code", { event: "precompact" }))), "…and so is an event outside the table: the export refuses what the CLI refuses (second review pass: it printed a hook under any name)");
  assert(/"constructor" is not an event/.test(thrown(() => hookJson("claude-code", { event: "constructor" }))) && /"__proto__" is not an event/.test(thrown(() => hookJson("claude-code", { event: "__proto__" }))) && /no default events for harness "constructor"/.test(thrown(() => hookJson("constructor", {}))),
    "Object's own names are refused by name as events and as a harness — not printed, not a TypeError (third review pass)");
  assert(/codex has no PreCompact hook/.test(thrown(() => hookJson("codex", { event: "PreCompact" }))) && Object.keys(hookJson("codex", { event: "Stop", runtime: "bun" }).hooks).join() === "Stop",
    "which harness fires which event is the table's rule: the export refuses Codex a PreCompact hook as the CLI does, and prints it a Stop (third review pass)");
  assert(!JSON.stringify([cc, cx, st]).includes("cap-key"), "no key in any of them");
  assert(shellWord("/Users/me/My Projects/OB1/x.mjs") === "'/Users/me/My Projects/OB1/x.mjs'" && shellWord(SCRIPT) === SCRIPT && shellWord("/a'b/c.mjs") === "'/a'\\''b/c.mjs'",
    "a path with a space or a quote is quoted for the shell the harness runs the command through; a plain one is not");
  const run = (args, key) => {
    if (key) writeFileSync(CONFIG, JSON.stringify({ url: URL_, key }), { mode: 0o600 });
    return spawnScript(args);
  };
  const ok = await run(["--check"], "cap-key");
  assert(ok.code === 0 && /capture_thought alone \(capture scope\)\. On a secret: redact\. State: /.test(ok.out), `--check with a capture key: ok, naming the mode (${ok.out.trim().slice(0, 100)})`);
  const okRefuse = await spawnScript(["--check"], { env: { OB1_CAPTURE_ON_SECRET: "refuse" } });
  const okTypo = await spawnScript(["--check"], { env: { OB1_CAPTURE_ON_SECRET: "REFUSE" } });
  assert(okRefuse.code === 0 && /On a secret: refuse\./.test(okRefuse.out) && okTypo.code === 1 && /OB1_CAPTURE_ON_SECRET takes redact or refuse, not "REFUSE"/.test(okTypo.err) && !okTypo.out.trim(), "…the environment's mode is the one named; a misspelt one is exit 1 and named (SMD-2127)");
  const noCfgTypo = await spawnScript(["--check"], { env: { OB1_CAPTURE_ON_SECRET: "x", OB1_SESSION_CAPTURE_CONFIG: join(TMP, "nope.json") } });
  const printTypo = await spawnScript(["--print-hook", "claude-code"], { env: { OB1_CAPTURE_ON_SECRET: "x" } });
  assert(noCfgTypo.code === 1 && /not "x"/.test(noCfgTypo.err) && !/no endpoint or key/.test(noCfgTypo.err) && printTypo.code === 2 && /not "x"/.test(printTypo.err) && !printTypo.out.trim(),
    `a misspelt mode is named before a missing config, and --print-hook refuses it too, exit 2, printing no hook (first review pass: the one path that let it by; exits ${noCfgTypo.code}/${printTypo.code})`);
  const wide = await run(["--check"], "write-key");
  assert(wide.code === 0 && /warning: the key can capture, and it can also/.test(wide.err) && /--scope capture/.test(wide.err), "--check with a write key: a warning naming the fix");
  const ro = await run(["--check"], "read-key");
  assert(ro.code === 1 && /cannot capture/.test(ro.err), "--check with a read key: exit 1");
  writeFileSync(CONFIG, JSON.stringify({ url: URL_, key: "cap-key" }), { mode: 0o600 });
  const dry = await run(["--dry-run", CLAUDE_T]);
  assert(dry.code === 0 && /^Session summary — claude-code/.test(dry.out) && /would send: source=claude-code, derived_from=3 id/.test(dry.out) && /secret scan: clean/.test(dry.out), "--dry-run prints the summary and what it would send");
  assert(!/Checkpoint:/.test(dry.out), "…with no checkpoint line: a dry run has no event");
  const dryCp = await run(["--dry-run", CLAUDE_T, "--event", "PreCompact", "--trigger", "auto"]);
  assert(dryCp.code === 0 && /\n\nCheckpoint: compacted at 2026-09-22 13:20 \(auto\), continuing/.test(dryCp.out) && /\n\nCheckpoint: turn ended at /.test((await run(["--dry-run", CLAUDE_T, "--event", "Stop"])).out),
    "--dry-run --event previews the checkpoint line the hook would write for that event (first review pass)");
  assert((await run(["--dry-run", CLAUDE_T, "--event", "bogus"])).code === 2, "…and refuses an event it does not know, as --print-hook does");
  // One reader for --event on both paths (second review pass: two copies, disagreeing on the empty value and the case hint).
  const dryEmpty = await run(["--dry-run", CLAUDE_T, "--event"]), dryCase = await run(["--dry-run", CLAUDE_T, "--event", "precompact"]);
  assert(dryEmpty.code === 2 && /none was given/.test(dryEmpty.err) && dryCase.code === 2 && /the case matters/.test(dryCase.err), "--dry-run refuses an empty --event and names a case slip in the same words as --print-hook");
  const trigTypo = await run(["--dry-run", CLAUDE_T, "--event", "PreCompact", "--trigger", "Auto"]);
  assert(trigTypo.code === 2 && /--trigger takes auto or manual, not "Auto"/.test(trigTypo.err) && !trigTypo.out.trim(), "a --trigger that is neither is refused, not previewed without one (second review pass)");
  const trigAlone = await run(["--dry-run", CLAUDE_T, "--trigger", "auto"]);
  assert(trigAlone.code === 2 && /--trigger goes with --event PreCompact, which was not given/.test(trigAlone.err), "…as is --trigger with no event");
  assert((await run(["--dry-run", CLAUDE_T, "--event", "Stop", "--trigger", "auto"])).code === 2 && (await run(["--dry-run", CLAUDE_T, "--event", "PreCompact", "--trigger"])).code === 2, "…or under Stop, or dangling");
  assert((await run(["--dry-run", CLAUDE_T, "--event", "PreCompact", "--min-interval", "20"])).code === 2 && (await run(["--print-hook", "claude-code", "--event", "PreCompact", "--trigger", "auto"])).code === 2, "a flag of the other by-hand form is refused on either, not validated nowhere and dropped");
  // The flags are read before the transcript (third review pass: a transcript with no prompt returned 0 past every refusal).
  const quietBogus = await run(["--dry-run", join(TMP, "quiet.jsonl"), "--event", "bogus", "--trigger", "Whatever", "--min-interval", "5"]);
  assert(quietBogus.code === 2 && /--event takes/.test(quietBogus.err) && !quietBogus.out.trim() && /would SKIP/.test((await run(["--dry-run", join(TMP, "quiet.jsonl"), "--event", "PreCompact", "--trigger", "auto"])).out),
    "--dry-run on a transcript with no prompt still refuses a bad flag, and with good ones says it would skip");
  // The `=` form (third review pass: unseen, so `--trigger=auto` previewed no trigger and `--min-interval=45` printed 20).
  const eqForm = await run(["--dry-run", CLAUDE_T, "--event=PreCompact", "--trigger=auto"]);
  assert(eqForm.code === 0 && /Checkpoint: compacted at 2026-09-22 13:20 \(auto\), continuing/.test(eqForm.out), `--event=PreCompact --trigger=auto reads as the space form does (${eqForm.err.trim().slice(0, 60)})`);
  // The segmentation, for an operator (SMD-2013): one line per episode, then each text.
  const dryEp = await run(["--dry-run", EPISODES_T]);
  assert(dryEp.code === 0 && /^--- 4 episodes — one thought each, on its own supersedes chain:\n    1\. SMD-1844 — \(michaelharris\/smd-1844-loopback\) — 2 prompt\(s\) — 2026-09-24 09:00 → 2026-09-24 09:40 — from the start — ended at a compaction\n    2\. SMD-1843, SMD-1844 — \(michaelharris\/smd-1843-env\) — 2 prompt\(s\) — 2026-09-24 10:00 → 2026-09-24 10:30 — begun after a compaction with SMD-1843 — ended when SMD-1917 was taken up\n    3\. SMD-1917 — [^\n]*— begun with SMD-1917 — ended at a compaction\n    4\. SMD-1917 — \(michaelharris\/smd-1917-fork-md\) — 2 prompt\(s\) — 2026-09-24 11:10 → 2026-09-24 11:31 — begun after a compaction — still open\n\n=== episode 1 ===\nSession summary — SMD-1844/.test(dryEp.out) && (dryEp.out.match(/^=== episode \d ===$/gm) ?? []).length === 4 && (dryEp.out.match(/^--- would send \(episode \d\): source=claude-code, derived_from=/gm) ?? []).length === 4 && (dryEp.out.match(/secret scan: clean/g) ?? []).length === 4,
    `--dry-run prints the segmentation — one line per episode with its tickets, branch, asks, span and bounds — then each episode's text and what it would send (${dryEp.out.split("\n")[1]})`);
  const dryEpCp = await run(["--dry-run", EPISODES_T, "--event", "PreCompact", "--trigger", "manual"]);
  assert((dryEpCp.out.match(/Checkpoint: compacted/g) ?? []).length === 1 && /=== episode 4 ===[^]*Checkpoint: compacted at 2026-09-24 11:31 \(manual\)/.test(dryEpCp.out), "…with --event, the checkpoint line previews on the open episode alone");
  const dryEpSec = await spawnScript(["--dry-run", join(TMP, "episodes-secret.jsonl")], { env: { OB1_CAPTURE_ON_SECRET: "refuse" } });
  assert(dryEpSec.code === 1 && /^--- would REFUSE episode 2: credential assignment/m.test(dryEpSec.out) && (dryEpSec.out.match(/secret scan: clean/g) ?? []).length === 3 && /abcdefghijklmnop/.test(dryEpSec.out), `…and under refuse a secret in one episode is refused by episode, the others clean — the dry run shows the text, as it does for one episode, so an operator sees the offset (exit ${dryEpSec.code}: ${dryEpSec.out.split("\n").filter((l) => /^--- (?:would REFUSE|secret)/.test(l)).join(" | ").slice(0, 300)})`);
  // Under redact (the default, SMD-2127) the dry run shows the text as it would be SENT — the marker in it, the key not — and says what was blanked and where.
  const dryEpRed = await run(["--dry-run", join(TMP, "episodes-secret.jsonl")]);
  assert(dryEpRed.code === 0 && /^--- secret scan: 1 redaction — credential assignment, high-entropy token at char \d+ in prompt 2; the text above is what would be sent$/m.test(dryEpRed.out) && (dryEpRed.out.match(/secret scan: clean/g) ?? []).length === 3 && /MCP_ACCESS_KEY=\[redacted:credential assignment, high-entropy token\] was the key/.test(dryEpRed.out) && !/abcdefghijklmnop/.test(dryEpRed.out) && !/would REFUSE/.test(dryEpRed.out),
    `under redact the dry run exits 0, prints the blanked text and names the redaction (${dryEpRed.out.split("\n").filter((l) => /^--- secret/.test(l)).join(" | ").slice(0, 200)})`);
  const dryBackstop = await run(["--dry-run", join(TMP, "backstop.jsonl")]);
  assert(dryBackstop.code === 1 && /^--- would REFUSE: 64-hex token \(a raw key, or a digest out of its context\) in prompt 1 at char \d+ after 3 redactions$/m.test(dryBackstop.out) && /\[redacted:url with a password\]@h\/blobs\/\[redacted:64-hex token/.test(dryBackstop.out) && !/3f9a3f9a|p4ssw0rd/.test(dryBackstop.out), `…and a summary the blanking leaves a hit in is shown blanked and refused, the redactions tried named (${dryBackstop.out.split("\n").filter((l) => /^--- would/.test(l)).join(" | ").slice(0, 200)})`);
  const dryTypo = await spawnScript(["--dry-run", join(TMP, "episodes-secret.jsonl")], { env: { OB1_CAPTURE_ON_SECRET: "redcat" } });
  assert(dryTypo.code === 2 && /OB1_CAPTURE_ON_SECRET takes redact or refuse, not "redcat"/.test(dryTypo.err) && !dryTypo.out.trim(), "a misspelt mode is refused before the transcript is read, exit 2 as the by-hand forms do, nothing printed");
  const lastWins = await run(["--dry-run", CLAUDE_T, "--event=PreCompact", "--event", "Stop"]);
  assert(lastWins.code === 0 && /Checkpoint: turn ended at /.test(lastWins.out) && Object.keys(JSON.parse((await run(["--print-hook=codex", "--print-hook", "claude-code"])).out).hooks).join() === "SessionEnd,PreCompact",
    "a repeated flag: the last mention wins in either form (fourth review pass: the = form won over a later correction)");
  const prefixed = await run(["--print-hook", "claude-code", "--eventual=Stop", "--eventual", "PreCompact"]);
  assert(prefixed.code === 0 && Object.keys(JSON.parse(prefixed.out).hooks).join() === "SessionEnd,PreCompact", "a flag whose name merely begins with another's is not that flag, in either form (fifth review pass: the = form's match was unpinned)");
  const eqDangling = await run(["--print-hook", "claude-code", "--event=--min-interval", "20"]);
  assert(eqDangling.code === 2 && /none was given/.test(eqDangling.err), "`--event=--min-interval` is an event forgotten, as `--event --min-interval` is (fifth review pass: the = form returned the flag as the value)");
  const eqStop = await run(["--print-hook=claude-code", "--event=Stop", "--min-interval=45"]);
  assert(eqStop.code === 0 && /--min-interval 45/.test(eqStop.out) && Object.keys(JSON.parse(eqStop.out).hooks).join() === "Stop", `…and --print-hook=claude-code --event=Stop --min-interval=45 prints a Stop hook at 45 (exit ${eqStop.code})`);
  assert(/--min-interval takes a number of minutes above zero; none was given/.test((await run(["--print-hook", "claude-code", "--event", "Stop", "--min-interval"])).err), "a dangling --min-interval says none was given, in its siblings' words");
  const zero = await run(["--print-hook", "claude-code", "--event", "Stop", "--min-interval", "0"]);
  assert(zero.code === 2 && /above zero/.test(zero.err), "a printed Stop hook needs a floor above zero — at zero it would capture every turn");
  assert(received.length === 1, "…and sends nothing");
  const ph = await run(["--print-hook", "codex"]);
  assert(ph.code === 0 && JSON.parse(ph.out).hooks.SessionEnd && /installs nothing/.test(ph.err), "--print-hook prints JSON on stdout and the where-to-paste on stderr");
  const pair = await run(["--print-hook", "claude-code"]);
  assert(pair.code === 0 && Object.keys(JSON.parse(pair.out).hooks).join() === "SessionEnd,PreCompact" && Object.keys(JSON.parse(ph.out).hooks).join() === "SessionEnd", "…the CLI's default for Claude Code is the pair, for Codex SessionEnd alone");
  const cxpc = await run(["--print-hook", "codex", "--event", "PreCompact"]);
  assert(cxpc.code === 2 && /Codex has no compaction hook/.test(cxpc.err) && /--event Stop --min-interval/.test(cxpc.err) && !cxpc.out.trim(), `--print-hook codex --event PreCompact is refused, naming the Stop alternative, and prints nothing (exit ${cxpc.code})`);
  const miss = await run(["--print-hook", "claude-code", "--event", "precompact"]);
  assert(miss.code === 2 && /--event takes SessionEnd, PreCompact, Stop, not "precompact" — the case matters/.test(miss.err) && !miss.out.trim(), "an event the hook does not know is refused — a misspelt one would install a hook that never fires — and a case slip is named");
  assert((await run(["--print-hook", "claude-code", "--event", "SubagentStop"])).code === 2, "…as is an event the harness has and this hook has no use for");
  const ctor = await run(["--print-hook", "claude-code", "--event", "constructor"]);
  assert(ctor.code === 2 && /not "constructor"/.test(ctor.err) && !ctor.out.trim() && (await run(["--print-hook", "claude-code", "--event", "__proto__"])).code === 2, "…and one of Object's own names, which printed a hook under `constructor` (third review pass)");
  const noEv = await run(["--print-hook", "claude-code", "--event", "--min-interval", "20"]);
  assert(noEv.code === 2 && /--event takes one of SessionEnd, PreCompact, Stop; none was given/.test(noEv.err) && !noEv.out.trim(), `--event with no value — the Stop forgotten — is refused, not the default pair with the interval dropped (exit ${noEv.code}; first review pass)`);
  const miNoStop = await run(["--print-hook", "claude-code", "--min-interval", "30"]);
  assert(miNoStop.code === 2 && /--min-interval applies to --event Stop alone/.test(miNoStop.err) && !miNoStop.out.trim(), "--min-interval with no Stop event is refused, not validated and dropped");
  assert((await run(["--print-hook", "claude-code", "--event", "PreCompact", "--min-interval", "30"])).code === 2, "…under PreCompact too");
}

fake.stop(true);
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${"─".repeat(52)}\n${passed + failed} assertions: ${passed} passed, ${failed} failed\n${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
