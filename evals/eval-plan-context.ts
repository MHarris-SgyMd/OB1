#!/usr/bin/env bun
/**
 * eval-plan-context.ts — does one plan_context call help an agent plan? (SMD-2684 PR 2)
 *
 * The ticket's Verify asks: on a fixed set of requests, does a plan written after one `plan_context` call cite more of
 * the brain's relevant rows than a plan written after free searching? This runs that comparison. The maintainer chose
 * its shape on 2026-11-10:
 *   - the planner is headless Claude Code (`claude -p`, MODEL), one run per request and arm;
 *   - relevance is labelled by two blind raters, and their agreement (Cohen's κ) is reported before the verdict;
 *   - the requests are 20 tickets drawn by a fixed rule (draw), not picked by hand.
 *
 * The arms differ only in the brain tools the planner may see and call:
 *   A  plan_context, called once;
 *   B  the read tools a session searches with (search, search_thoughts, search_thoughts_keyword, fetch, agenda,
 *      relations, thread), at most B_CALLS calls.
 * Every other brain tool is hidden from the model (--disallowedTools), no built-in tool is given (--tools ""), no
 * setting or CLAUDE.md loads, and a run whose session listed any other brain tool, or ran another model, is invalid.
 *
 * What is counted: a plan cites a thought by its full id. A cite counts only if a tool showed that id in the same run
 * (seen); a cite of an id never shown is reported, not credited. The rows to label are, per request, every thought
 * either arm's plan cited, and UNCITED_SAMPLE thoughts that either arm saw and neither cited, mixed so a rater can't
 * tell which were cited, by which arm, or why a row is there. A row is relevant (gold) when both raters say so.
 *
 * The verdict, fixed before any run (posted on SMD-2684 with this file's PREREGISTRATION hash):
 *   - per request, d = relevant rows A's plan cited − relevant rows B's plan cited;
 *   - κ below KAPPA_BAR: no verdict, the labels don't hold;
 *   - helps: more requests with d > 0 than d < 0, a two-sided exact sign test p ≤ P_BAR over the untied, and mean d > 0;
 *   - hurts: the mirror image; otherwise not shown.
 * Reported beside it, never deciding it: SMD-1719's utilization rate per arm (utilization.ts's summarise, the cites as
 * cite rows), the share of each plan's cites that are relevant, the relevant share of the uncited sample, cost, calls,
 * and every run that broke a rule.
 *
 *   bun eval-plan-context.ts --draw <linear-page.json>… --held <keys.txt> --out <requests.json>
 *   bun eval-plan-context.ts --run --requests <requests.json> --mcp-config <file> --out <dir> [--only KEY] [--arm A|B] [--again]
 *   bun eval-plan-context.ts --status --requests … --out <dir>
 *   bun eval-plan-context.ts --ids --requests … --out <dir>                 # the thought ids every run saw, one per line
 *   bun eval-plan-context.ts --sheets --requests … --out <dir> --rows <rows.json>
 *   bun eval-plan-context.ts --score --requests … --out <dir> --rows <rows.json> --labels <r1.json> --labels <r2.json> [--json <file>]
 *   bun eval-plan-context.ts --self-check                                    # the rules, on hand-known answers; no brain, no model
 *
 * --draw reads Linear issue listings ({ issues: [{ id, title, createdAt, project }] }, the Backlog state's) and a file
 * of the ticket keys the brain holds. Its output holds the tickets' titles, the board's text, so it stays out of the
 * repo (check-consistency refuses it under evals/fixtures, SMD-1295): the rule and the listings rebuild it exactly, and
 * the drawn keys are on SMD-2684. --run spawns `claude` per request and arm, in an order set by the request's
 * hash, and skips a run whose stream already ended; --again moves an ended run aside (`.try1`) and runs it again.
 * --mcp-config is a Claude Code MCP config naming the brain `brain`: it holds a key, so keep it 0600 and out of the repo.
 * --rows is the text of the thoughts --ids lists ([{ id, created_at, type, content }]), read from the brain by its
 * operator. The runs, the rows, the sheets and the labels hold the brain's text: keep them out of the repo. --json
 * writes the result as keys, counts and hashes only.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarise, type ActionRow, type SearchRow } from "./utilization.ts";

// ── What was fixed before the run ─────────────────────────────────────────────

export const SEED = "SMD-2684 PR 2";
export const MODEL = "claude-sonnet-5-5";
export const N_REQUESTS = 20;
/** The board's own projects are named with this prefix (data: Linear's project names, which board-sync matches). */
export const PROJECT_PREFIX = "Open Brain";
/** Tickets filed in this window, in a project whose name starts PROJECT_PREFIX: the brain's own work. */
export const WINDOW = { from: "2026-09-01T00:00:00.000Z", to: "2026-11-10T00:00:00.000Z" } as const;
export const B_CALLS = 10;
export const UNCITED_SAMPLE = 8;
export const ROW_CHARS = 2000;
export const KAPPA_BAR = 0.6;
export const P_BAR = 0.1;
export const RUN_TIMEOUT_MS = 15 * 60_000;

/** Every brain tool the canary served on 2026-11-10 (the session's init list): all but the arm's are hidden. */
export const BRAIN_TOOLS = [
  "agenda", "brain_info", "capture_thought", "claim_work", "clear_priority", "decide_item_close", "delete_thought", "fetch",
  "item_history", "job_status", "list_claims", "list_items", "list_logged_searches", "list_supersession_proposals",
  "list_thought_ids", "list_thoughts", "open_item", "plan_context", "priority_history", "propose_item_close", "relations",
  "release_claim", "release_stale_leases", "renew_claim", "reset_capture_stamp", "retry_failed",
  "review_supersession_proposal", "run_worker", "scan_thoughts", "search", "search_thoughts", "search_thoughts_keyword",
  "set_item_status", "set_priority", "task_status", "thought_changes", "thought_stats", "thread", "update_item",
  "update_thought", "worker_status",
] as const;

export type Arm = "A" | "B";
export const ARM_NAMES: readonly Arm[] = ["A", "B"];
export const ARMS: Record<Arm, { label: string; tools: readonly string[]; maxTurns: number; budgetUsd: number; instruction: string }> = {
  A: {
    label: "one plan_context call",
    tools: ["plan_context"],
    maxTurns: 4,
    budgetUsd: 1.5,
    instruction: "First call plan_context once, with the request. Make no other tool call.",
  },
  B: {
    label: "free searching",
    tools: ["search", "search_thoughts", "search_thoughts_keyword", "fetch", "agenda", "relations", "thread"],
    maxTurns: 14,
    budgetUsd: 3,
    instruction: `First use the brain's tools as you see fit, at most ${B_CALLS} tool calls in all.`,
  },
};

export const SYSTEM_PROMPT =
  "You plan software work for the maintainer of Daemonic Brain, a persistent AI memory system (Postgres and pgvector " +
  "behind an MCP server). You cannot read the code, the repository or the ticket tracker. Your only source is the " +
  "maintainer's brain, which you reach through the tools you have: it holds the maintainer's notes, decisions, session " +
  "records and a copy of the ticket board. Learn what the brain knows that bears on the request, then write the plan. " +
  "Do not change anything in the brain.";

export function userPrompt(req: Request, arm: Arm): string {
  return [
    `Request: ${req.text}`,
    "",
    ARMS[arm].instruction,
    "",
    "Then write the plan in markdown, under these headings:",
    "## Can it be done now",
    "## What the brain already knows",
    "## Steps",
    "## Open questions",
    "",
    "Cite each brain thought you rely on by its full ID in square brackets, right where you use it, for example " +
      "[01234567-89ab-cdef-0123-456789abcdef]. Cite only thoughts a tool showed you. End with one line: `Cited: ` and " +
      "every thought ID you cited, separated by commas, or `Cited: none`.",
  ].join("\n");
}

/** The raters' rules, written before the first label (memory: a bar must fix its edge cases, not only its definitions). */
export const RATER_RULES = `# Rating rules (SMD-2684 PR 2)

Each sheet is one request: a ticket someone was asked to go ahead with. Under it are rows from the maintainer's brain.
Label every row 1 (relevant) or 0 (not relevant) to planning that request. Judge each row alone, from its text.

## 1, relevant: the row tells a person planning this request something they would need, or should check, before or while doing it
- the ticket's own record: its plan, decisions, constraints, status or blockers;
- work it depends on, or that depends on it, when the row says how they connect or what state that work is in;
- a past change, measurement, decision or failure in the same feature or code the work touches;
- a rule or convention the work's steps must follow, when the row states it for this kind of work (a migration rule
  for a ticket that adds a migration).

## 0, not relevant
- the row only shares words, an area or a theme with the request;
- the row names the ticket, or a related one, only in a list of keys, statuses or ranks, saying nothing else about it;
- a general process note (how to push, claim, review or release) unless the request is about that process;
- the row is about another ticket and says nothing that bears on this one.

## Edge cases
- The row's date, its age, whether it was later superseded, and who wrote it do not count: judge what the text says.
- A row that is relevant in part is relevant.
- Two rows with the same text are each judged alone.
- When unsure, 0.

## Answer
One JSON file: { "<ticket key>": { "R01": 1, "R02": 0, … }, … }, every row of every sheet labelled 0 or 1.
`;

export const PREREGISTRATION = createHash("sha256")
  .update(JSON.stringify({ SEED, MODEL, N_REQUESTS, WINDOW, B_CALLS, UNCITED_SAMPLE, ROW_CHARS, KAPPA_BAR, P_BAR, ARMS, SYSTEM_PROMPT, RATER_RULES, prompt: userPrompt({ n: 0, key: "SMD-0", title: "T", text: "Go ahead with SMD-0: T" }, "A") }))
  .digest("hex");

// ── Small pure helpers ────────────────────────────────────────────────────────

export const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Every full uuid in a text, lower-cased, first appearance first. */
export function idsIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(UUID_RE)) {
    const id = m[0].toLowerCase();
    if (!seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// ── The draw ──────────────────────────────────────────────────────────────────

export type Ticket = { id: string; title: string; createdAt: string; project?: string | null };
export type Request = { n: number; key: string; title: string; text: string };

export function eligible(t: Ticket): boolean {
  return (t.project ?? "").startsWith(PROJECT_PREFIX) && t.createdAt >= WINDOW.from && t.createdAt < WINDOW.to
    && !/^\s*tracking\s*:/i.test(t.title) && !/plan_context/i.test(t.title);
}

/** The eligible tickets ordered by sha256(SEED|key); the first N the brain holds, the ones it doesn't passed over and named. */
export function draw(tickets: Ticket[], held: Set<string>, n = N_REQUESTS): { requests: Request[]; notHeld: string[]; eligible: number } {
  const byKey = new Map<string, Ticket>();
  for (const t of tickets) if (eligible(t)) byKey.set(t.id, t);
  const ordered = [...byKey.values()].sort((a, b) => (sha(`${SEED}|${a.id}`) < sha(`${SEED}|${b.id}`) ? -1 : 1));
  const requests: Request[] = [];
  const notHeld: string[] = [];
  for (const t of ordered) {
    if (requests.length >= n) break;
    if (!held.has(t.id)) { notHeld.push(t.id); continue; }
    requests.push({ n: requests.length + 1, key: t.id, title: t.title, text: `Go ahead with ${t.id}: ${t.title}` });
  }
  return { requests, notHeld, eligible: byKey.size };
}

// ── A run's stream ────────────────────────────────────────────────────────────

export type Call = { tool: string; input: unknown; ids: string[]; chars: number; isError: boolean };
export type RunRecord = {
  ended: boolean;
  model: string | null;
  /** The brain tools the session listed, without the mcp__brain__ prefix; `other` holds any tool that isn't a brain tool. */
  tools: string[];
  other: string[];
  /** The brain calls the run made (its tool_use named mcp__brain__…), in order. */
  calls: Call[];
  /** Calls to a name the session doesn't have (a bare `search`): refused by Claude Code before the brain, so not calls. */
  misnamed: string[];
  plan: string;
  cited: string[];
  seen: string[];
  costUsd: number | null;
  turns: number | null;
  durationMs: number | null;
  resultSubtype: string | null;
};

const contentText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : "")).join("\n") : "";

/** One `claude -p --output-format stream-json --verbose` stream → what the run did. Unparseable lines are skipped. */
export function parseRun(lines: string[]): RunRecord {
  const rec: RunRecord = { ended: false, model: null, tools: [], other: [], calls: [], misnamed: [], plan: "", cited: [], seen: [], costUsd: null, turns: null, durationMs: null, resultSubtype: null };
  const pending = new Map<string, { tool: string; input: unknown; brain: boolean }>();
  let lastText = "";
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "system" && ev.subtype === "init") {
      rec.model = typeof ev.model === "string" ? ev.model : null;
      for (const t of Array.isArray(ev.tools) ? ev.tools : []) {
        if (typeof t !== "string") continue;
        if (t.startsWith("mcp__brain__")) rec.tools.push(t.slice("mcp__brain__".length)); else rec.other.push(t);
      }
    } else if (ev.type === "assistant" || ev.type === "user") {
      const content = (ev.message as { content?: unknown } | undefined)?.content;
      for (const part of Array.isArray(content) ? content : []) {
        if (!part || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "tool_use" && typeof p.id === "string" && typeof p.name === "string") {
          pending.set(p.id, { tool: p.name.replace(/^mcp__brain__/, ""), input: p.input, brain: p.name.startsWith("mcp__brain__") });
        } else if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
          const call = pending.get(p.tool_use_id);
          const text = contentText(p.content);
          pending.delete(p.tool_use_id);
          if (call && !call.brain) { rec.misnamed.push(call.tool); continue; }
          rec.calls.push({ tool: call?.tool ?? "?", input: call?.input, ids: idsIn(text), chars: text.length, isError: p.is_error === true });
        } else if (p.type === "text" && typeof p.text === "string" && ev.type === "assistant") {
          lastText = p.text;
        }
      }
    } else if (ev.type === "result") {
      rec.ended = true;
      rec.resultSubtype = typeof ev.subtype === "string" ? ev.subtype : null;
      rec.plan = typeof ev.result === "string" ? ev.result : lastText;
      rec.costUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null;
      rec.turns = typeof ev.num_turns === "number" ? ev.num_turns : null;
      rec.durationMs = typeof ev.duration_ms === "number" ? ev.duration_ms : null;
    }
  }
  // A call whose result never came is still a call the run made.
  for (const c of pending.values()) if (c.brain) rec.calls.push({ tool: c.tool, input: c.input, ids: [], chars: 0, isError: true });
  if (!rec.plan) rec.plan = lastText;
  rec.seen = idsIn(rec.calls.map((c) => c.ids.join(" ")).join(" "));
  rec.cited = idsIn(rec.plan);
  return rec;
}

/**
 * Problems with a run, in two kinds: `invalid` means the run is not the experiment (another model, another tool set, no
 * end) and is run again; `deviations` are the planner's own departures from its instructions, scored as they are and
 * reported.
 */
export function judgeRun(rec: RunRecord, arm: Arm): { invalid: string[]; deviations: string[] } {
  const invalid: string[] = [];
  const deviations: string[] = [];
  if (!rec.ended) invalid.push("the stream has no result event");
  if (rec.model !== MODEL) invalid.push(`model ${rec.model ?? "unknown"}, not ${MODEL}`);
  const want = [...ARMS[arm].tools].sort().join(",");
  const got = [...rec.tools].sort().join(",");
  if (got !== want) invalid.push(`brain tools [${got}], not [${want}]`);
  if (rec.other.length) invalid.push(`other tools listed: ${rec.other.join(", ")}`);
  if (rec.ended && rec.resultSubtype !== "success") deviations.push(`ended ${rec.resultSubtype ?? "without a subtype"}`);
  if (arm === "A" && rec.calls.length !== 1) deviations.push(`${rec.calls.length} calls, not one`);
  if (arm === "B" && rec.calls.length > B_CALLS) deviations.push(`${rec.calls.length} calls, over ${B_CALLS}`);
  if (rec.misnamed.length) deviations.push(`${rec.misnamed.length} call(s) to a tool it doesn't have (${rec.misnamed.join(", ")}), not counted as calls`);
  if (rec.calls.some((c) => c.isError)) deviations.push(`${rec.calls.filter((c) => c.isError).length} call(s) errored`);
  if (!/^##\s+Steps/m.test(rec.plan)) deviations.push("no Steps heading: no plan");
  return { invalid, deviations };
}

// ── The rating set ────────────────────────────────────────────────────────────

export type Row = { id: string; created_at?: string | null; type?: string | null; content: string };

/** Per request: every thought either plan cited and saw, and UNCITED_SAMPLE seen-but-uncited thoughts, in a hashed order. */
export function rateSet(key: string, recs: Partial<Record<Arm, RunRecord>>, isThought: (id: string) => boolean): string[] {
  const cited = new Set<string>();
  const seen = new Set<string>();
  for (const arm of ARM_NAMES) {
    const r = recs[arm];
    if (!r) continue;
    const s = new Set(r.seen);
    for (const id of r.cited) if (s.has(id) && isThought(id)) cited.add(id);
    for (const id of r.seen) if (isThought(id)) seen.add(id);
  }
  const uncited = [...seen].filter((id) => !cited.has(id)).sort((a, b) => (sha(`${SEED}|uncited|${key}|${a}`) < sha(`${SEED}|uncited|${key}|${b}`) ? -1 : 1)).slice(0, UNCITED_SAMPLE);
  return [...cited, ...uncited].sort((a, b) => (sha(`${SEED}|sheet|${key}|${a}`) < sha(`${SEED}|sheet|${key}|${b}`) ? -1 : 1));
}

export const rLabel = (i: number): string => `R${String(i + 1).padStart(2, "0")}`;

/** One request's sheet: the request and its rows, nothing about which arm saw or cited what. */
export function sheetText(req: Request, ids: string[], rows: Map<string, Row>): string {
  const out = [`# ${req.key}`, "", `Request: ${req.text}`, "", `Rows: ${ids.length}. Label each one 1 or 0 under RULES.md.`, ""];
  ids.forEach((id, i) => {
    const r = rows.get(id);
    const content = r?.content ?? "";
    const cut = [...content].length > ROW_CHARS ? `${[...content].slice(0, ROW_CHARS).join("")}\n[… ${[...content].length - ROW_CHARS} more characters]` : content;
    out.push(`## ${rLabel(i)}`, `Written ${r?.created_at ? String(r.created_at).slice(0, 10) : "?"}${r?.type ? ` · type ${r.type}` : ""}`, "", "~~~~text", cut.replaceAll("~~~~", "~ ~ ~ ~"), "~~~~", "");
  });
  return out.join("\n");
}

// ── The statistics ────────────────────────────────────────────────────────────

/** Cohen's κ for two raters' 0/1 labels on the same items; NaN with no items, 1 when both are constant and equal. */
export function kappa(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0 || n !== b.length) return NaN;
  let agree = 0, a1 = 0, b1 = 0;
  for (let i = 0; i < n; i++) { if (a[i] === b[i]) agree++; if (a[i] === 1) a1++; if (b[i] === 1) b1++; }
  const po = agree / n;
  const pe = (a1 / n) * (b1 / n) + (1 - a1 / n) * (1 - b1 / n);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

/** Two-sided exact sign test over the untied pairs: P(a split at least this uneven | p = ½); 1 with none. */
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) { tail += c; c = (c * (n - i)) / (i + 1); }
  return Math.min(1, (2 * tail) / 2 ** n);
}

export type Verdict = "helps" | "hurts" | "not shown" | "no verdict";
export function verdictOf(v: { kappa: number; wins: number; losses: number; meanDiff: number; invalidRuns: number }): { verdict: Verdict; why: string } {
  if (v.invalidRuns > 0) return { verdict: "no verdict", why: `${v.invalidRuns} run(s) are not the experiment; run them again` };
  if (!(v.kappa >= KAPPA_BAR)) return { verdict: "no verdict", why: `κ ${Number.isNaN(v.kappa) ? "undefined" : v.kappa.toFixed(3)} is below ${KAPPA_BAR}: the labels don't hold` };
  const p = signTestP(v.wins, v.losses);
  const tail = `${v.wins} requests better, ${v.losses} worse, sign test p ${p.toFixed(4)}, mean difference ${v.meanDiff.toFixed(2)}`;
  if (v.wins > v.losses && p <= P_BAR && v.meanDiff > 0) return { verdict: "helps", why: tail };
  if (v.losses > v.wins && p <= P_BAR && v.meanDiff < 0) return { verdict: "hurts", why: tail };
  return { verdict: "not shown", why: tail };
}

// ── The score ─────────────────────────────────────────────────────────────────

export type Labels = Record<string, Record<string, number>>;
export type ArmScore = { cited: number; relevant: number; unseenCites: number; seen: number; calls: number; costUsd: number };
export type RequestScore = { key: string; rated: number; A: ArmScore; B: ArmScore; d: number };
export type Score = {
  preregistration: string;
  requests: RequestScore[];
  kappa: number;
  items: number;
  agreeRelevant: number;
  disagree: number;
  wins: number;
  losses: number;
  ties: number;
  meanDiff: number;
  p: number;
  verdict: Verdict;
  why: string;
  either: { wins: number; losses: number; meanDiff: number; p: number };
  utilization: Record<Arm, { returned: number; used: number; utilization: number | null }>;
  citedRelevantShare: Record<Arm, number | null>;
  uncitedRelevant: { rated: number; relevant: number };
  runs: { key: string; arm: Arm; invalid: string[]; deviations: string[] }[];
};

export function score(
  requests: Request[],
  recs: Map<string, Partial<Record<Arm, RunRecord>>>,
  isThought: (id: string) => boolean,
  keyMap: Record<string, Record<string, string>>,
  r1: Labels,
  r2: Labels,
): Score {
  const a: number[] = [];
  const b: number[] = [];
  const gold = new Map<string, Set<string>>();
  const either = new Map<string, Set<string>>();
  let agreeRelevant = 0;
  const missing: string[] = [];
  for (const req of requests) {
    const g = new Set<string>();
    const e = new Set<string>();
    for (const [label, id] of Object.entries(keyMap[req.key] ?? {})) {
      const x = r1[req.key]?.[label];
      const y = r2[req.key]?.[label];
      if ((x !== 0 && x !== 1) || (y !== 0 && y !== 1)) { missing.push(`${req.key} ${label}`); continue; }
      a.push(x); b.push(y);
      if (x === 1 && y === 1) { g.add(id); agreeRelevant++; }
      if (x === 1 || y === 1) e.add(id);
    }
    gold.set(req.key, g);
    either.set(req.key, e);
  }
  if (missing.length) throw new Error(`labels missing or not 0/1 for ${missing.length} row(s), first ${missing.slice(0, 5).join(", ")}`);
  const runs: Score["runs"] = [];
  const armScore = (rec: RunRecord | undefined, rel: Set<string>): ArmScore => {
    if (!rec) return { cited: 0, relevant: 0, unseenCites: 0, seen: 0, calls: 0, costUsd: 0 };
    const seen = new Set(rec.seen);
    const credited = rec.cited.filter((id) => seen.has(id) && isThought(id));
    return {
      cited: credited.length,
      relevant: credited.filter((id) => rel.has(id)).length,
      unseenCites: rec.cited.filter((id) => !seen.has(id)).length,
      seen: rec.seen.filter(isThought).length,
      calls: rec.calls.length,
      costUsd: rec.costUsd ?? 0,
    };
  };
  const rows: RequestScore[] = [];
  const eitherDiffs: number[] = [];
  for (const req of requests) {
    const rr = recs.get(req.key) ?? {};
    for (const arm of ARM_NAMES) {
      const rec = rr[arm];
      const j = rec ? judgeRun(rec, arm) : { invalid: ["no run"], deviations: [] };
      if (j.invalid.length || j.deviations.length) runs.push({ key: req.key, arm, ...j });
    }
    const A = armScore(rr.A, gold.get(req.key)!);
    const B = armScore(rr.B, gold.get(req.key)!);
    rows.push({ key: req.key, rated: Object.keys(keyMap[req.key] ?? {}).length, A, B, d: A.relevant - B.relevant });
    eitherDiffs.push(armScore(rr.A, either.get(req.key)!).relevant - armScore(rr.B, either.get(req.key)!).relevant);
  }
  const wins = rows.filter((r) => r.d > 0).length;
  const losses = rows.filter((r) => r.d < 0).length;
  const meanDiff = rows.length ? rows.reduce((s, r) => s + r.d, 0) / rows.length : 0;
  const k = kappa(a, b);
  const invalidRuns = runs.filter((r) => r.invalid.length).length;
  const { verdict, why } = verdictOf({ kappa: k, wins, losses, meanDiff, invalidRuns });
  const eWins = eitherDiffs.filter((d) => d > 0).length;
  const eLosses = eitherDiffs.filter((d) => d < 0).length;

  // SMD-1719's rate, by its own code: each call a search row returning the thoughts it showed, each credited cite a
  // cite row (the `<writer>/<pointer>` shape), one agent per request so a cite attributes only to its own run.
  const utilization = {} as Score["utilization"];
  for (const arm of ARM_NAMES) {
    const searches: SearchRow[] = [];
    const actions: ActionRow[] = [];
    for (const req of requests) {
      const rec = recs.get(req.key)?.[arm];
      if (!rec) continue;
      rec.calls.forEach((c, i) => searches.push({
        id: `${req.key}.${arm}.${i}`, agentId: req.key, loggedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), tool: c.tool, query: req.key,
        matchCount: null, threshold: null, recencyWeight: null, resultIds: c.ids.filter(isThought), resultTokens: null,
      }));
      const seen = new Set(rec.seen);
      for (const id of rec.cited) if (seen.has(id) && isThought(id)) actions.push({ agentId: req.key, loggedAt: new Date(Date.UTC(2026, 0, 1, 0, 5, 0)), tool: "plan/derived_from", targetId: id });
    }
    const o = summarise(searches, actions, 30).overall;
    utilization[arm] = { returned: o.returned, used: o.used, utilization: o.utilization };
  }
  const share = (arm: Arm): number | null => {
    const c = rows.reduce((s, r) => s + r[arm].cited, 0);
    return c ? rows.reduce((s, r) => s + r[arm].relevant, 0) / c : null;
  };
  // The uncited sample: rated rows neither plan cited.
  let uRated = 0, uRel = 0;
  for (const req of requests) {
    const rr = recs.get(req.key) ?? {};
    const citedAny = new Set([...(rr.A?.cited ?? []), ...(rr.B?.cited ?? [])]);
    for (const id of Object.values(keyMap[req.key] ?? {})) if (!citedAny.has(id)) { uRated++; if (gold.get(req.key)!.has(id)) uRel++; }
  }
  return {
    preregistration: PREREGISTRATION, requests: rows, kappa: k, items: a.length, agreeRelevant, disagree: a.filter((x, i) => x !== b[i]).length,
    wins, losses, ties: rows.length - wins - losses, meanDiff, p: signTestP(wins, losses), verdict, why,
    either: { wins: eWins, losses: eLosses, meanDiff: eitherDiffs.length ? eitherDiffs.reduce((s, d) => s + d, 0) / eitherDiffs.length : 0, p: signTestP(eWins, eLosses) },
    utilization, citedRelevantShare: { A: share("A"), B: share("B") }, uncitedRelevant: { rated: uRated, relevant: uRel }, runs,
  };
}

export function renderScore(s: Score): string {
  const pct = (x: number | null): string => (x === null ? "n/a" : `${(100 * x).toFixed(1)}%`);
  const sum = (arm: Arm, f: (x: ArmScore) => number): number => s.requests.reduce((t, r) => t + f(r[arm]), 0);
  const out = [
    `plan_context vs free searching (SMD-2684 PR 2), preregistration ${s.preregistration.slice(0, 12)}`,
    "",
    "request     rated   A cited/relevant   B cited/relevant    d",
    ...s.requests.map((r) => `${r.key.padEnd(10)} ${String(r.rated).padStart(6)}   ${`${r.A.cited}/${r.A.relevant}`.padStart(16)}   ${`${r.B.cited}/${r.B.relevant}`.padStart(16)}   ${String(r.d).padStart(3)}`),
    "",
    `labels: ${s.items} rows, κ ${s.kappa.toFixed(3)}, ${s.agreeRelevant} relevant by both, ${s.disagree} split`,
    `relevant rows cited: A ${sum("A", (x) => x.relevant)}, B ${sum("B", (x) => x.relevant)}; A better on ${s.wins}, worse on ${s.losses}, tied on ${s.ties}`,
    `VERDICT: ${s.verdict} (${s.why})`,
    `  with either rater's relevant: ${s.either.wins} better, ${s.either.losses} worse, p ${s.either.p.toFixed(4)}, mean ${s.either.meanDiff.toFixed(2)}`,
    "",
    "beside it (not deciding it):",
    ...ARM_NAMES.map((arm) => `  ${arm} ${ARMS[arm].label}: utilization ${pct(s.utilization[arm].utilization)} (${s.utilization[arm].used} of ${s.utilization[arm].returned} thoughts shown were cited), ` +
      `relevant share of cites ${pct(s.citedRelevantShare[arm])}, unseen cites ${sum(arm, (x) => x.unseenCites)}, calls ${sum(arm, (x) => x.calls)}, cost $${sum(arm, (x) => x.costUsd).toFixed(2)}`),
    `  uncited sample: ${s.uncitedRelevant.relevant} of ${s.uncitedRelevant.rated} rows neither plan cited are relevant by both raters`,
    ...(s.runs.length ? ["", "runs that broke a rule:", ...s.runs.map((r) => `  ${r.key} ${r.arm}: ${[...r.invalid.map((x) => `INVALID ${x}`), ...r.deviations].join("; ")}`)] : []),
  ];
  return out.join("\n");
}

// ── I/O ───────────────────────────────────────────────────────────────────────

const runPath = (dir: string, key: string, arm: Arm): string => join(dir, "runs", `${key}.${arm}.jsonl`);
function readRun(dir: string, key: string, arm: Arm): RunRecord | undefined {
  const p = runPath(dir, key, arm);
  return existsSync(p) ? parseRun(readFileSync(p, "utf8").split("\n")) : undefined;
}
function readRuns(dir: string, requests: Request[]): Map<string, Partial<Record<Arm, RunRecord>>> {
  const m = new Map<string, Partial<Record<Arm, RunRecord>>>();
  for (const r of requests) m.set(r.key, { A: readRun(dir, r.key, "A"), B: readRun(dir, r.key, "B") });
  return m;
}
const readRows = (p: string): Map<string, Row> => new Map((JSON.parse(readFileSync(p, "utf8")) as Row[]).map((r) => [r.id.toLowerCase(), r]));

export function claudeArgs(req: Request, arm: Arm, mcpConfig: string): string[] {
  const hidden = BRAIN_TOOLS.filter((t) => !ARMS[arm].tools.includes(t)).map((t) => `mcp__brain__${t}`);
  return [
    "claude", "-p", userPrompt(req, arm),
    "--model", MODEL,
    "--system-prompt", SYSTEM_PROMPT,
    "--output-format", "stream-json", "--verbose",
    "--strict-mcp-config", "--mcp-config", mcpConfig,
    "--tools", "",
    "--allowedTools", ARMS[arm].tools.map((t) => `mcp__brain__${t}`).join(","),
    "--disallowedTools", hidden.join(","),
    "--permission-mode", "dontAsk",
    "--setting-sources", "",
    "--no-session-persistence",
    "--max-turns", String(ARMS[arm].maxTurns),
    "--max-budget-usd", String(ARMS[arm].budgetUsd),
  ];
}

async function runOne(dir: string, req: Request, arm: Arm, mcpConfig: string): Promise<void> {
  const cwd = join(dir, "cwd");
  mkdirSync(cwd, { recursive: true });
  if (readdirSync(cwd).length) throw new Error(`${cwd} must stay empty: the planner runs there`);
  const out = runPath(dir, req.key, arm);
  const started = Date.now();
  const proc = Bun.spawn(claudeArgs(req, arm, mcpConfig), { cwd, stdout: Bun.file(out), stderr: Bun.file(`${out}.err`), stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
  const code = await proc.exited;
  clearTimeout(timer);
  const rec = readRun(dir, req.key, arm)!;
  const j = judgeRun(rec, arm);
  console.log(`${req.key} ${arm}: exit ${code}, ${((Date.now() - started) / 1000).toFixed(0)} s, ${rec.calls.length} calls, ${rec.seen.length} ids seen, ${rec.cited.length} cited, $${(rec.costUsd ?? 0).toFixed(3)}` +
    `${j.invalid.length ? `; INVALID: ${j.invalid.join("; ")}` : ""}${j.deviations.length ? `; ${j.deviations.join("; ")}` : ""}`);
}

// ── Self-check ────────────────────────────────────────────────────────────────

export function selfCheck(): number {
  let fails = 0;
  const ok = (cond: boolean, what: string): void => { if (!cond) { fails++; console.log(`FAIL ${what}`); } else console.log(`ok   ${what}`); };
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-9;

  // The draw.
  const t = (id: string, over: Partial<Ticket> = {}): Ticket => ({ id, title: `title ${id}`, createdAt: "2026-10-01T00:00:00.000Z", project: `${PROJECT_PREFIX} — X`, ...over });
  ok(eligible(t("SMD-1")), "a brain ticket in the window is eligible");
  ok(!eligible(t("SMD-1", { project: "Accessibility & Compliance" })), "another project's ticket is not");
  ok(!eligible(t("SMD-1", { project: null })), "a ticket with no project is not");
  ok(!eligible(t("SMD-1", { createdAt: "2026-08-31T23:59:59.999Z" })) && eligible(t("SMD-1", { createdAt: WINDOW.from })), "the window's start is inclusive");
  ok(!eligible(t("SMD-1", { createdAt: WINDOW.to })), "the window's end is exclusive");
  ok(!eligible(t("SMD-1", { title: "Tracking: the brain helps" })) && !eligible(t("SMD-1", { title: "plan_context's reply" })), "trackers and plan_context's own tickets are left out");
  const pool = Array.from({ length: 60 }, (_, i) => t(`SMD-${100 + i}`));
  const held = new Set(pool.map((x) => x.id).filter((k) => k !== "SMD-105"));
  const d1 = draw([...pool, ...pool], held);
  const d2 = draw([...pool].reverse(), held);
  ok(d1.requests.length === N_REQUESTS && d1.eligible === 60, "the draw takes N from the eligible, a ticket listed twice counted once");
  ok(JSON.stringify(d1.requests) === JSON.stringify(d2.requests), "the draw doesn't depend on the listing's order");
  ok(d1.requests.every((r, i) => r.n === i + 1 && r.text === `Go ahead with ${r.key}: ${r.title}`), "requests are numbered and worded by the template");
  const order = [...pool].sort((x, y) => (sha(`${SEED}|${x.id}`) < sha(`${SEED}|${y.id}`) ? -1 : 1)).map((x) => x.id);
  const firstN = order.filter((k) => held.has(k)).slice(0, N_REQUESTS);
  ok(JSON.stringify(d1.requests.map((r) => r.key)) === JSON.stringify(firstN), "the draw is the hash order, the unheld passed over");
  ok(order.indexOf("SMD-105") < N_REQUESTS ? d1.notHeld.includes("SMD-105") : !d1.notHeld.includes("SMD-105"), "an unheld ticket reached by the draw is named");

  // A run's stream.
  const U1 = "11111111-1111-4111-8111-111111111111", U2 = "22222222-2222-4222-8222-222222222222", U3 = "33333333-3333-4333-8333-333333333333";
  const stream = (arm: Arm, over: { model?: string; tools?: string[]; plan?: string; calls?: [string, string][]; noEnd?: boolean } = {}): string[] => {
    const tools = (over.tools ?? [...ARMS[arm].tools]).map((x) => `mcp__brain__${x}`);
    const lines: unknown[] = [{ type: "system", subtype: "init", model: over.model ?? MODEL, tools }];
    (over.calls ?? [["plan_context", `{"knowledge":{"hits":[{"id":"${U1.toUpperCase()}"},{"id":"${U2}"}]}}`]]).forEach(([tool, result], i) => {
      lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name: `mcp__brain__${tool}`, input: { request: "r" } }] } });
      lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: result }] } });
    });
    const plan = over.plan ?? `## Can it be done now\nyes [${U1}]\n## Steps\n1. do it [${U3}]\nCited: ${U1}, ${U3}`;
    lines.push({ type: "assistant", message: { content: [{ type: "text", text: plan }] } });
    if (!over.noEnd) lines.push({ type: "result", subtype: "success", result: plan, total_cost_usd: 0.25, num_turns: 2, duration_ms: 9000 });
    return [...lines.map((l) => JSON.stringify(l)), "not json", ""];
  };
  const rA = parseRun(stream("A"));
  ok(rA.ended && rA.model === MODEL && rA.calls.length === 1 && rA.calls[0].tool === "plan_context", "a stream's init, call and end are read");
  ok(JSON.stringify(rA.seen) === JSON.stringify([U1, U2]), "ids seen are lower-cased and kept once");
  ok(JSON.stringify(rA.cited) === JSON.stringify([U1, U3]), "a plan's cites are its full ids, inline and on the Cited line, once each");
  ok(judgeRun(rA, "A").invalid.length === 0 && judgeRun(rA, "A").deviations.length === 0, "a clean arm-A run breaks no rule");
  ok(judgeRun(parseRun(stream("A", { model: "claude-opus-5-5" })), "A").invalid.length === 1, "another model makes the run invalid");
  ok(judgeRun(parseRun(stream("A", { tools: ["plan_context", "search"] })), "A").invalid.length === 1, "a run that listed another brain tool is invalid");
  ok(judgeRun(parseRun(stream("A", { tools: [] })), "A").invalid.length === 1, "a run with the arm's tool missing is invalid");
  ok(judgeRun(rA, "B").invalid.length === 1, "an arm-A stream judged as arm B is invalid");
  ok(judgeRun(parseRun(stream("A", { noEnd: true })), "A").invalid.some((x) => x.includes("no result")), "a stream with no end is invalid");
  ok(parseRun(stream("A", { noEnd: true })).plan.includes("## Steps"), "a stream with no end keeps its last text as the plan");
  const twoCalls = parseRun(stream("A", { calls: [["plan_context", U1], ["plan_context", U2]] }));
  ok(judgeRun(twoCalls, "A").deviations.some((x) => x.includes("2 calls")), "arm A calling twice is a deviation, scored as it is");
  const many = parseRun(stream("B", { calls: Array.from({ length: B_CALLS + 1 }, () => ["search", U2] as [string, string]) }));
  ok(judgeRun(many, "B").deviations.some((x) => x.includes("over")) && judgeRun(many, "B").invalid.length === 0, "arm B past its cap is a deviation");
  ok(judgeRun(parseRun(stream("A", { plan: "no plan here" })), "A").deviations.some((x) => x.includes("no plan")), "a reply without a Steps heading is no plan");
  ok(parseRun(stream("A", { plan: "## Steps\nCited: none" })).cited.length === 0, "Cited: none cites nothing");
  const bare = [
    JSON.stringify({ type: "system", subtype: "init", model: MODEL, tools: ["mcp__brain__search"] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "search", input: {} }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", is_error: true, content: `No such tool available: search ${U1}` }] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "## Steps" }),
  ];
  const bareRec = parseRun(bare);
  ok(bareRec.calls.length === 0 && bareRec.misnamed.join() === "search" && bareRec.seen.length === 0, "a call to a bare name never reached the brain: no call, nothing seen");
  ok(judgeRun(bareRec, "B").deviations.some((x) => x.includes("doesn't have")), "it is reported as a deviation");

  // The rating set and its sheet.
  const isT = (_id: string): boolean => true;
  const recB = parseRun(stream("B", { calls: [["search", `${U2} ${U3}`]], plan: `## Steps\n[${U2}]` }));
  const set = rateSet("SMD-1", { A: rA, B: recB }, isT);
  ok(set.length === 3 && new Set(set).size === 3 && set.includes(U1) && set.includes(U2) && set.includes(U3), "the rating set is the credited cites and the uncited seen, once each");
  ok(!rateSet("SMD-1", { A: rA }, (id) => id !== U2).includes(U2), "a seen id that is no thought is not rated");
  const unseenOnly = parseRun(stream("A", { calls: [["plan_context", U2]], plan: `## Steps\n[${U1}]` }));
  ok(JSON.stringify(rateSet("SMD-1", { A: unseenOnly }, isT)) === JSON.stringify([U2]), "a cite never seen is not rated as cited");
  const bigSeen = Array.from({ length: 30 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`);
  const big = parseRun(stream("B", { calls: [["search", bigSeen.join(" ")]], plan: `## Steps\n[${bigSeen[0]}]` }));
  ok(rateSet("SMD-1", { B: big }, isT).length === 1 + UNCITED_SAMPLE, "the uncited are sampled to UNCITED_SAMPLE");
  const rowsM = new Map<string, Row>([[U1, { id: U1, created_at: "2026-10-02T03:04:05Z", type: "observation", content: "x".repeat(ROW_CHARS + 5) }], [U2, { id: U2, content: "~~~~text\nforged" }]]);
  const sh = sheetText({ n: 1, key: "SMD-1", title: "T", text: "Go ahead with SMD-1: T" }, [U1, U2], rowsM);
  ok(sh.includes("## R01") && sh.includes("## R02") && sh.includes("[… 5 more characters]") && sh.includes("Written 2026-10-02 · type observation"), "a sheet labels its rows and cuts long text");
  ok(!sh.includes(U1) && !/\barm\b|plan_context|cited/i.test(sh), "a sheet names no id, no arm and no cite");
  ok((sh.match(/^~~~~/gm) ?? []).length === 4, "a row's text can't close its own fence");

  // The statistics, on hand-known answers.
  ok(near(kappa([1, 1, 0, 0], [1, 1, 0, 0]), 1) && near(kappa([1, 0, 1, 0], [0, 1, 0, 1]), -1), "κ is 1 for agreement and −1 for opposition");
  ok(near(kappa([1, 1, 1, 0, 0, 0, 1, 0, 1, 0], [1, 1, 0, 0, 0, 0, 1, 1, 1, 0]), 0.6), "κ is 0.6 on a hand-worked 10-item table (po .8, pe .5)");
  ok(near(kappa([1, 1], [1, 1]), 1) && near(kappa([1, 1], [0, 0]), 0) && Number.isNaN(kappa([], [])), "κ's degenerate cases");
  ok(near(signTestP(9, 1), 22 / 1024) && near(signTestP(7, 3), 352 / 1024) && near(signTestP(5, 5), 1) && signTestP(0, 0) === 1, "the sign test's exact tails");
  ok(near(signTestP(1, 9), signTestP(9, 1)), "the sign test is two-sided");
  const base = { kappa: 0.8, wins: 9, losses: 1, meanDiff: 1.2, invalidRuns: 0 };
  ok(verdictOf(base).verdict === "helps", "9 better, 1 worse, a positive mean: helps");
  ok(verdictOf({ ...base, wins: 1, losses: 9, meanDiff: -1.2 }).verdict === "hurts", "the mirror image: hurts");
  ok(verdictOf({ ...base, wins: 7, losses: 3 }).verdict === "not shown", "7 against 3 (p .34) is not shown");
  ok(verdictOf({ ...base, meanDiff: -0.1 }).verdict === "not shown", "more wins with a negative mean is not shown");
  ok(verdictOf({ ...base, kappa: KAPPA_BAR }).verdict === "helps" && verdictOf({ ...base, kappa: KAPPA_BAR - 1e-9 }).verdict === "no verdict", "κ at the bar holds, below it doesn't");
  ok(verdictOf({ ...base, kappa: NaN }).verdict === "no verdict", "an undefined κ gives no verdict");
  ok(verdictOf({ ...base, invalidRuns: 1 }).verdict === "no verdict", "an invalid run gives no verdict");
  // P_BAR's edge: 8 against 1 is p 20/512 ≈ .039 (helps); 6 against 1 is p 16/128 = .125 (not shown).
  ok(verdictOf({ ...base, wins: 8, losses: 1 }).verdict === "helps" && verdictOf({ ...base, wins: 6, losses: 1 }).verdict === "not shown", "the p bar decides at its edge");

  // The score, end to end on two requests.
  const reqs: Request[] = [{ n: 1, key: "SMD-1", title: "T", text: "Go ahead with SMD-1: T" }, { n: 2, key: "SMD-2", title: "U", text: "Go ahead with SMD-2: U" }];
  const recs = new Map<string, Partial<Record<Arm, RunRecord>>>([["SMD-1", { A: rA, B: recB }], ["SMD-2", { A: rA, B: recB }]]);
  const keyMap = { "SMD-1": { R01: U1, R02: U2, R03: U3 }, "SMD-2": { R01: U1, R02: U2, R03: U3 } };
  const lab: Labels = { "SMD-1": { R01: 1, R02: 1, R03: 0 }, "SMD-2": { R01: 0, R02: 1, R03: 0 } };
  const sc = score(reqs, recs, isT, keyMap, lab, lab);
  // A cites U1 (seen) and U3 (unseen); B cites U2 (seen). SMD-1: gold {U1, U2} → A 1, B 1, d 0. SMD-2: gold {U2} → A 0, B 1, d −1.
  ok(sc.requests[0].A.cited === 1 && sc.requests[0].A.unseenCites === 1 && sc.requests[0].A.relevant === 1 && sc.requests[0].B.relevant === 1 && sc.requests[0].d === 0, "a request's cites are credited only when seen, and scored on the gold");
  ok(sc.requests[1].d === -1 && sc.wins === 0 && sc.losses === 1 && sc.ties === 1 && near(sc.meanDiff, -0.5), "the paired differences and their counts");
  ok(near(sc.kappa, 1) && sc.items === 6 && sc.agreeRelevant === 3, "κ over every rated row");
  ok(sc.utilization.A.returned === 4 && sc.utilization.A.used === 2 && near(sc.utilization.A.utilization ?? -1, 0.5), "utilization by SMD-1719's code: per request A saw 2 thoughts and its credited cite used 1 (4 and 2 over both)");
  ok(sc.utilization.B.returned === 4 && sc.utilization.B.used === 2, "B's utilization the same way");
  const split = score(reqs, recs, isT, keyMap, lab, { "SMD-1": { R01: 0, R02: 1, R03: 0 }, "SMD-2": { R01: 0, R02: 1, R03: 1 } });
  ok(split.agreeRelevant === 2 && split.disagree === 2 && split.requests[0].A.relevant === 0, "gold is relevant by both; a split row is not gold");
  ok(split.either.losses === 1 && split.either.wins === 0, "the either-rater reading counts a split row as relevant");
  let threw = false;
  try { score(reqs, recs, isT, keyMap, lab, { "SMD-1": { R01: 1 } }); } catch { threw = true; }
  ok(threw, "a row a rater left unlabelled stops the score");
  const noRun = score(reqs, new Map([["SMD-1", { A: rA }]]), isT, keyMap, lab, lab);
  ok(noRun.verdict === "no verdict" && noRun.runs.some((r) => r.invalid.includes("no run")), "a missing run gives no verdict");
  // The drop-the-mechanism mutant: credit unseen cites and the score must move.
  ok(sc.requests[0].A.cited !== rA.cited.length, "crediting a cite never seen would change the count (the seen rule has teeth)");

  // The command line the planner runs under.
  const args = claudeArgs(reqs[0], "B", "/x/mcp.json");
  const after = (flag: string): string => args[args.indexOf(flag) + 1];
  ok(after("--model") === MODEL && after("--tools") === "" && after("--permission-mode") === "dontAsk" && after("--setting-sources") === "" && args.includes("--strict-mcp-config"), "the planner runs on MODEL with no built-in tool, no prompt and no settings");
  ok(after("--allowedTools").split(",").length === ARMS.B.tools.length && !after("--disallowedTools").includes("mcp__brain__search,") && after("--disallowedTools").includes("mcp__brain__plan_context"), "arm B allows its read tools and hides plan_context");
  ok(after("--disallowedTools").split(",").length + ARMS.B.tools.length === BRAIN_TOOLS.length, "every brain tool is either allowed or hidden");
  ok(claudeArgs(reqs[0], "A", "/x").join(" ").includes("--allowedTools mcp__brain__plan_context --disallowedTools"), "arm A allows plan_context alone");
  ok(!/capture_thought|update_thought|delete_thought/.test(after("--allowedTools")), "no write tool is allowed");
  ok(/^[0-9a-f]{64}$/.test(PREREGISTRATION), "the preregistration hash is taken");

  console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
  return fails;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function argList(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === flag && args[i + 1] && !args[i + 1].startsWith("--")) out.push(args[i + 1]); });
  return out;
}
const arg = (args: string[], flag: string): string | undefined => argList(args, flag)[0];
function need(v: string | undefined, what: string): string {
  if (!v) { process.stderr.write(`${what} is required\n`); process.exit(2); }
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) process.exit(selfCheck() ? 1 : 0);

  if (args.includes("--draw")) {
    const pages = argList(args, "--draw");
    const held = new Set(readFileSync(need(arg(args, "--held"), "--held"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean));
    const tickets = pages.flatMap((p) => (JSON.parse(readFileSync(p, "utf8")) as { issues: Ticket[] }).issues);
    const d = draw(tickets, held);
    const out = need(arg(args, "--out"), "--out");
    writeFileSync(out, `${JSON.stringify({ seed: SEED, window: WINDOW, preregistration: PREREGISTRATION, listed: tickets.length, eligible: d.eligible, notHeld: d.notHeld, requests: d.requests }, null, 2)}\n`);
    console.log(`${tickets.length} listed, ${d.eligible} eligible, ${d.requests.length} drawn${d.notHeld.length ? `, passed over (not in the brain): ${d.notHeld.join(", ")}` : ""} → ${out}`);
    return;
  }

  const requests = (JSON.parse(readFileSync(need(arg(args, "--requests"), "--requests"), "utf8")) as { requests: Request[] }).requests;
  const dir = need(arg(args, "--out"), "--out");
  mkdirSync(join(dir, "runs"), { recursive: true });

  if (args.includes("--run")) {
    const mcp = need(arg(args, "--mcp-config"), "--mcp-config");
    if (!existsSync(mcp)) { process.stderr.write(`no MCP config at ${mcp}\n`); process.exit(2); }
    const only = arg(args, "--only");
    const armOnly = arg(args, "--arm") as Arm | undefined;
    if (armOnly && !ARM_NAMES.includes(armOnly)) { process.stderr.write("--arm is A or B\n"); process.exit(2); }
    const todo = requests.filter((r) => !only || r.key === only);
    if (only && !todo.length) { process.stderr.write(`${only} is not among the requests\n`); process.exit(2); }
    for (const req of todo) {
      // Which arm goes first is set by the request's hash, so neither arm always runs on a warmer brain.
      const order: Arm[] = parseInt(sha(`${SEED}|order|${req.key}`).slice(0, 2), 16) % 2 ? ["A", "B"] : ["B", "A"];
      for (const arm of order) {
        if (armOnly && arm !== armOnly) continue;
        const prior = readRun(dir, req.key, arm);
        if (prior?.ended && !args.includes("--again")) { console.log(`${req.key} ${arm}: done already`); continue; }
        if (prior && args.includes("--again")) renameSync(runPath(dir, req.key, arm), `${runPath(dir, req.key, arm)}.try${Date.now()}`);
        await runOne(dir, req, arm, mcp);
      }
    }
    return;
  }

  const recs = readRuns(dir, requests);
  if (args.includes("--status")) {
    for (const req of requests) for (const arm of ARM_NAMES) {
      const rec = recs.get(req.key)?.[arm];
      if (!rec) { console.log(`${req.key} ${arm}: not run`); continue; }
      const j = judgeRun(rec, arm);
      console.log(`${req.key} ${arm}: ${rec.calls.length} calls, ${rec.seen.length} seen, ${rec.cited.length} cited, $${(rec.costUsd ?? 0).toFixed(3)}${j.invalid.length ? `; INVALID: ${j.invalid.join("; ")}` : ""}${j.deviations.length ? `; ${j.deviations.join("; ")}` : ""}`);
    }
    return;
  }
  if (args.includes("--ids")) {
    const ids = new Set<string>();
    for (const r of recs.values()) for (const rec of Object.values(r)) for (const id of [...(rec?.seen ?? []), ...(rec?.cited ?? [])]) ids.add(id);
    console.log([...ids].join("\n"));
    return;
  }

  const rows = readRows(need(arg(args, "--rows"), "--rows"));
  const isThought = (id: string): boolean => rows.has(id);
  const keyMap: Record<string, Record<string, string>> = {};
  for (const req of requests) {
    const set = rateSet(req.key, recs.get(req.key) ?? {}, isThought);
    keyMap[req.key] = Object.fromEntries(set.map((id, i) => [rLabel(i), id]));
  }
  if (args.includes("--sheets")) {
    mkdirSync(join(dir, "sheets"), { recursive: true });
    writeFileSync(join(dir, "sheets", "RULES.md"), RATER_RULES);
    for (const req of requests) writeFileSync(join(dir, "sheets", `${String(req.n).padStart(2, "0")}-${req.key}.md`), sheetText(req, Object.values(keyMap[req.key]), rows));
    writeFileSync(join(dir, "key.json"), `${JSON.stringify(keyMap, null, 2)}\n`);
    const n = Object.values(keyMap).reduce((s, m) => s + Object.keys(m).length, 0);
    console.log(`${requests.length} sheets, ${n} rows, in ${join(dir, "sheets")}; the key (which row is which id) in ${join(dir, "key.json")}, kept from the raters`);
    return;
  }
  if (args.includes("--score")) {
    const labels = argList(args, "--labels");
    if (labels.length !== 2) { process.stderr.write("--score takes --labels twice, one per rater\n"); process.exit(2); }
    const stored = JSON.parse(readFileSync(join(dir, "key.json"), "utf8"));
    if (JSON.stringify(stored) !== JSON.stringify(keyMap)) { process.stderr.write("key.json no longer matches the runs and rows: the sheets were made from other data\n"); process.exit(2); }
    const s = score(requests, recs, isThought, keyMap, JSON.parse(readFileSync(labels[0], "utf8")), JSON.parse(readFileSync(labels[1], "utf8")));
    console.log(renderScore(s));
    const json = arg(args, "--json");
    if (json) writeFileSync(json, `${JSON.stringify(s, null, 2)}\n`);
    return;
  }
  process.stderr.write("usage: see the header of eval-plan-context.ts\n");
  process.exit(2);
}

if (import.meta.main) await main();
