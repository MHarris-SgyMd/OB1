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
 * shas and file names alone; a hit refuses with exit 1 and writes nothing; the
 * foreground half finishes inside the SessionEnd budget and the detached half
 * posts; a second ending supersedes the first; a provenance refusal is retried
 * without provenance; a dead endpoint keeps the payload for a later run; the
 * printed hook carries no key; --check tells a capture key from a wider one.
 */

import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync, unlinkSync, utimesSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  scanForSecrets, scanSummary, SECRET_PATTERNS, parseRpcBody, postCapture, prepare, postPending, hookJson, shellWord, readState, LIMITS, REFUSAL_RE, checkpointOf,
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
const READ = ["fetch", "list_supersession_proposals", "list_thoughts", "search", "search_thoughts", "search_thoughts_keyword", "thought_stats"];
const fake = Bun.serve({
  port: 0,
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
      received.push({ key, args });
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
      if (/\[\[slow\]\]/.test(content)) await sleep(2500);
      const id = uuid(1000 + received.length);
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
    user("This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.", { origin: { kind: "human" } }),
    assistant([toolUse("t1", "mcp__open-brain__search_thoughts", { query: "hook" }), toolUse("t2", "WebSearch", { query: "codex hooks" }), toolUse("t3", "mcp__other__web_search", { q: "x" })]),
    user([toolResult("t1", `1. [2026-09-01] (idea) a thought\n   ID: ${uuid(1)}\n2. [2026-09-02] (task) another\n   ID: ${uuid(2)}`), toolResult("t2", `a page mentioning ID: ${uuid(77)} which is not ours`), toolResult("t3", `ID: ${uuid(78)}`)]),
    assistant([toolUse("t4", "Edit", { file_path: "/repo/proj/src/a.ts", old_string: "x", new_string: "y" }), toolUse("t5", "Write", { file_path: "/repo/proj/README.md", content: "…" }), toolUse("t6", "Bash", { command: "cd /repo/proj && git commit -q -F msg.txt" }), toolUse("t9", "Write", { file_path: "/Users/someone/.claude/projects/-Users-someone-Proj/memory/note-1234.md", content: "…" })]),
    user([toolResult("t4", "ok"), toolResult("t5", "ok"), toolResult("t6", "[feat/x abc1234] done"), toolResult("t9", "ok")]),
    assistant([toolUse("t7", "mcp__open-brain__capture_thought", { content: "decision" })]),
    user([toolResult("t7", `Captured as idea — id ${uuid(3)} — hooks`)]),
    user("now push and open the PR", { origin: { kind: "human" } }),
    user("now push and open the PR", { origin: { kind: "human" } }), // a retried prompt collapses
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
  assert(provenanceOf(many).length === LIMITS.derived, `derived_from is capped at ${LIMITS.derived}`);
  const empty = renderSummary(summariseTranscript(join(TMP, "empty.jsonl"), (writeFileSync(join(TMP, "empty.jsonl"), "{}\n"), "claude-code")));
  assert(/Brain: no thoughts read or written this session\./.test(empty), "a session that never touched the brain says so");
}

// ── [4] Secret scan ──────────────────────────────────────────────────────────
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
  ];
  for (const c of clean) assert(scanForSecrets(`text ${c} text`).length === 0, `clean: ${c.slice(0, 50)}`);
  assert(scanForSecrets(renderSummary(summariseTranscript(CLAUDE_T))).length === 0, "the fixture's own summary is clean");
  const f = scanForSecrets("aaa sk-ant-api03-" + "Ab1".repeat(12));
  assert(f[0].at === 4 && !JSON.stringify(f).includes("Ab1Ab1"), "a finding carries the reason and the offset, never the match");
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
    writeFileSync(join(STATE, "pending", `${Date.now()}-0000-abcdef-s-other-dup.json`), JSON.stringify({ ...dup1.payload, session_id: "s-other-dup" }));
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
  assert(scanForSecrets(renderSummary(pc)).length === 0 && scanSummary(pc, renderSummary(pc)).some((f) => /in a prompt/.test(f.reason)),
    "the rendered text is clean (the clip cut the key) but the full prompt is not, and the finding says where");
  const twiceT = join(TMP, "twice.jsonl");
  writeFileSync(twiceT, [user("the key is sk-ant-api03-" + "Ab1".repeat(12), { origin: { kind: "human" } }), assistant([{ type: "text", text: "you pasted sk-ant-api03-" + "Ab1".repeat(12) }])].join("\n"));
  const tw = summariseTranscript(twiceT);
  const twf = scanSummary(tw, renderSummary(tw));
  assert(twf.filter((f) => /^anthropic key/.test(f.reason)).length === 1, `one secret in two places is one finding, not three (${twf.map((f) => f.reason).join("; ")})`);
  const pcr = prepare({ ...base, session_id: "s-past-clip", transcript_path: pastClipT });
  assert(pcr.code === 1 && /refused/.test(pcr.message) && /in a prompt/.test(pcr.message), `…so the capture is refused (${pcr.message.slice(0, 80)})`);
  // A secret in the summary refuses before any payload.
  const secretT = join(TMP, "secret.jsonl");
  writeFileSync(secretT, [user("use this key: sk-ant-api03-" + "Ab1".repeat(12), { origin: { kind: "human" } }), assistant([{ type: "text", text: "ok" }])].join("\n"));
  const before = readdirSync(join(STATE, "pending")).length;
  const r = prepare({ ...base, session_id: "s-secret", transcript_path: secretT });
  assert(r.code === 1 && /refused/.test(r.message) && /anthropic key at char \d+/.test(r.message), `a secret refuses with exit 1 and the reason (${r.message.slice(0, 90)})`);
  assert(!r.message.includes("Ab1Ab1"), "…never the secret");
  assert(readdirSync(join(STATE, "pending")).length === before && !existsSync(join(STATE, "s-secret.json")), "…and nothing is written");
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
  assert(chain.length === 2 && chain[0].obsolete === true && chain[0].file === chainA.payloadPath, "the earlier payload of the session is obsolete: the summary is cumulative");
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
  const s = await runHook({ session_id: "s-sec", transcript_path: secretT, hook_event_name: "SessionEnd" }, { OB1_SESSION_CAPTURE_SYNC: "1" });
  assert(s.code === 1 && /refused/.test(s.err) && /credential assignment/.test(s.err) && !/abcdefghijklmnop/.test(s.err), "a secret: exit 1, the reason named, the secret not echoed");
  assert(received.length === 1, "…and nothing was sent");
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
  assert((() => { try { hookJson("claude", {}); return false; } catch (e) { return /no default events for harness "claude"/.test(e.message); } })(), "a harness with no defaults is a named error from hookJson, not a TypeError off undefined (first review pass)");
  assert(!JSON.stringify([cc, cx, st]).includes("cap-key"), "no key in any of them");
  assert(shellWord("/Users/me/My Projects/OB1/x.mjs") === "'/Users/me/My Projects/OB1/x.mjs'" && shellWord(SCRIPT) === SCRIPT && shellWord("/a'b/c.mjs") === "'/a'\\''b/c.mjs'",
    "a path with a space or a quote is quoted for the shell the harness runs the command through; a plain one is not");
  const run = (args, key) => {
    if (key) writeFileSync(CONFIG, JSON.stringify({ url: URL_, key }), { mode: 0o600 });
    return spawnScript(args);
  };
  const ok = await run(["--check"], "cap-key");
  assert(ok.code === 0 && /capture_thought alone \(capture scope\)/.test(ok.out), `--check with a capture key: ok (${ok.out.trim().slice(0, 70)})`);
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
