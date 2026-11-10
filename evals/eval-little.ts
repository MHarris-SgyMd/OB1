#!/usr/bin/env bun
/**
 * eval-little.ts — where does "the brain has little on this" begin? (SMD-4212 PR 1)
 *
 * plan_context's knowledge section is a search of the request, and a search always keeps its nearest matches: a
 * request the brain knows nothing about still gets its eight hits and no gap. SMD-4212 asks for a `little` gap, never
 * a verdict, at a bar measured on labelled requests. This measures the bar. The maintainer chose its shape on
 * 2026-11-10:
 *   - the truth is per hit: two blind raters label each of a request's hits relevant or not, under SMD-2684 PR 2's
 *     rules, with κ; a request has little when at most LITTLE_MAX of its hits are relevant by both;
 *   - the requests are N_BRAIN tickets of the brain's own projects and N_OTHER of SMD's other projects (which this
 *     brain holds nothing on), drawn by a seeded rule, plus N_PARA of them rewritten without their key by a paraphraser
 *     who sees only the titles;
 *   - a few candidate signals and thresholds are fixed in advance; half the requests (dev) choose one, and the other
 *     half (test) confirm it against the bar, also fixed in advance.
 *
 * The candidates, each read from the knowledge hits plan_context returned (limit LIMIT):
 *   top(t)    little when the best hit's similarity is below t (a hit with no similarity, a literal-only match, reads 0);
 *   count(f)  little when at most LITTLE_MAX hits have a similarity of f or more;
 *   literal   little when no hit matched an exact literal of the request (an identifier or a quoted span).
 * t and f run over THRESHOLDS. On dev, the rule with the highest balanced accuracy wins; ties go to the higher
 * precision of `little`, then literal, top, count in that order, then the lower threshold.
 * The bar, on test: balanced accuracy ≥ BAR_BALANCED, precision of `little` ≥ BAR_PRECISION (a false `little` tells
 * an agent the brain lacks what it holds), and κ ≥ KAPPA_BAR over all rated hits. Similarity is the embedding's, so the
 * bar holds for the model it was measured on (EMBEDDING, read from the brain at run time) and no other.
 *
 *   bun eval-little.ts --draw <linear-page.json>… --held <keys.txt> --out <requests.json>
 *   bun eval-little.ts --paraphrase-sheet --requests <requests.json>                      # the titles for the paraphraser
 *   bun eval-little.ts --paraphrases <answers.json> --requests <requests.json>            # merge them in, checked
 *   bun eval-little.ts --run --requests … --mcp-config <file> --out <dir>                 # plan_context's search, once each
 *   bun eval-little.ts --ids --requests … --out <dir>                                     # every hit id, one per line
 *   bun eval-little.ts --sheets --requests … --out <dir> --rows <rows.json>
 *   bun eval-little.ts --score --requests … --out <dir> --labels <r1.json> --labels <r2.json> [--json <file>]
 *   bun eval-little.ts --self-check
 *
 * The requests file holds board titles, and the runs, rows, sheets and labels the brain's text: all stay out of the
 * repo. --mcp-config is a Claude Code MCP config naming the brain `brain` (its key in an x-brain-key header): keep it
 * 0600. --json writes keys, counts and thresholds only.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unwrapRpc, type BrainEndpoint } from "../db/brain-compare.ts";
import { eligible, kappa, PROJECT_PREFIX, rLabel, sha, WINDOW, type Row, type Ticket } from "./eval-plan-context.ts";

// ── What was fixed before the run ─────────────────────────────────────────────

export const SEED = "SMD-4212 PR 1";
export const N_BRAIN = 30;
export const N_OTHER = 30;
/** Paraphrases: this many of each class, drawn by hash from the drawn tickets. */
export const N_PARA_EACH = 10;
export const LIMIT = 8;
/**
 * The search the hits come from: plan_context's own knowledge search (core/plan.ts: runSearch, hybrid, threshold 0,
 * recency 0, no filter, prefer_current on, limit 8), asked through search_thoughts with the same arguments, which runs
 * the same runSearch with no deadline. plan_context stops the embedding at 8 s, and on 2026-11-10 the canary's sleep
 * held its model server past that on every call, so plan_context answered with exact matches alone.
 */
export const SEARCH_TOOL = "search_thoughts";
export const SEARCH_ARGS = (query: string) => ({ query, limit: LIMIT, prefer_current: true });
export const LITTLE_MAX = 1;
export const THRESHOLDS: readonly number[] = Array.from({ length: 26 }, (_, i) => Number((0.3 + 0.02 * i).toFixed(2)));
export const BAR_BALANCED = 0.75;
export const BAR_PRECISION = 0.75;
export const KAPPA_BAR = 0.6;
export const ROW_CHARS = 1500;
export const CANDIDATE_ORDER = ["literal", "top", "count"] as const;
export type Candidate = (typeof CANDIDATE_ORDER)[number];

export const PARAPHRASE_RULES = `# Paraphrasing rules (SMD-4212 PR 1)

Each line below is the title of a work ticket. Rewrite each as the short request an operator would type to an AI agent
to get that work done, in plain words.

- Keep what the work is about; leave out the ticket's key and any other ticket key.
- Do not copy more than five words in a row from the title.
- At most 25 words. One sentence or two.
- No quotation marks around a phrase from the title.

Answer with one JSON object: { "<line id>": "<request>", … }, one entry per line.
`;

export const RATER_RULES = `# Rating rules (SMD-4212 PR 1)

Each sheet is one request someone made of an AI agent working on a software project. Under it are rows from the
maintainer's memory system: what a search of the request brought back. Label every row 1 (relevant) or 0 (not relevant)
to doing that request. Judge each row alone, from its text.

## 1, relevant: the row tells a person doing this request something they would need, or should check, before or while doing it
- the work's own record: its plan, decisions, constraints, status or blockers;
- work it depends on, or that depends on it, when the row says how they connect or what state that work is in;
- a past change, measurement, decision or failure in the same feature or code the work touches;
- a rule or convention the work's steps must follow, when the row states it for this kind of work.

## 0, not relevant
- the row only shares words, an area or a theme with the request;
- the row names the work, or a related one, only in a list of keys, statuses or ranks, saying nothing else about it;
- a general process note (how to push, claim, review or release) unless the request is about that process;
- the row is about other work and says nothing that bears on this request.

## Edge cases
- The row's date, its age, whether it was later superseded, and who wrote it do not count: judge what the text says.
- A row that is relevant in part is relevant.
- Two rows with the same text are each judged alone.
- A request about a product or codebase the rows never mention gets 0 on every row; that is a valid answer.
- When unsure, 0.

## Answer
One JSON file: { "<request id>": { "R01": 1, "R02": 0, … }, … }, every row of every sheet labelled 0 or 1.
`;

export const PREREGISTRATION = createHash("sha256")
  .update(JSON.stringify({ SEED, N_BRAIN, N_OTHER, N_PARA_EACH, LIMIT, SEARCH_TOOL, searchArgs: SEARCH_ARGS("q"), LITTLE_MAX, THRESHOLDS, BAR_BALANCED, BAR_PRECISION, KAPPA_BAR, ROW_CHARS, CANDIDATE_ORDER, PARAPHRASE_RULES, RATER_RULES, WINDOW, PROJECT_PREFIX }))
  .digest("hex");

// ── The draw ──────────────────────────────────────────────────────────────────

export type Klass = "brain" | "other" | "para";
export type Request = { id: string; key: string; klass: Klass; title: string; text: string | null };

const isTracker = (t: Ticket) => /^\s*tracking\s*:/i.test(t.title);
export const otherEligible = (t: Ticket): boolean =>
  typeof t.project === "string" && t.project !== "" && !t.project.startsWith(PROJECT_PREFIX) && t.createdAt >= WINDOW.from && t.createdAt < WINDOW.to && !isTracker(t);

const byHash = (salt: string) => (a: string, b: string) => (sha(`${SEED}|${salt}|${a}`) < sha(`${SEED}|${salt}|${b}`) ? -1 : 1);

/** N_BRAIN held brain tickets and N_OTHER unheld other-project tickets, each in hash order; N_PARA_EACH of each class marked for a paraphrase. */
export function drawLittle(tickets: Ticket[], held: Set<string>): { requests: Request[]; brainEligible: number; otherEligible: number; notHeld: string[]; otherHeld: string[] } {
  const uniq = new Map<string, Ticket>();
  for (const t of tickets) uniq.set(t.id, t);
  const all = [...uniq.values()];
  const brainPool = all.filter(eligible).map((t) => t.id).sort(byHash("brain"));
  const otherPool = all.filter(otherEligible).map((t) => t.id).sort(byHash("other"));
  const notHeld: string[] = [];
  const otherHeld: string[] = [];
  const brain: string[] = [];
  for (const k of brainPool) { if (brain.length >= N_BRAIN) break; if (held.has(k)) brain.push(k); else notHeld.push(k); }
  const other: string[] = [];
  for (const k of otherPool) { if (other.length >= N_OTHER) break; if (!held.has(k)) other.push(k); else otherHeld.push(k); }
  const title = (k: string) => uniq.get(k)!.title;
  const requests: Request[] = [
    ...brain.map((k) => ({ id: k, key: k, klass: "brain" as const, title: title(k), text: `Go ahead with ${k}: ${title(k)}` })),
    ...other.map((k) => ({ id: k, key: k, klass: "other" as const, title: title(k), text: `Go ahead with ${k}: ${title(k)}` })),
  ];
  for (const pool of [brain, other]) {
    for (const k of [...pool].sort(byHash("para")).slice(0, N_PARA_EACH)) requests.push({ id: `P-${k}`, key: k, klass: "para", title: title(k), text: null });
  }
  return { requests, brainEligible: brainPool.length, otherEligible: otherPool.length, notHeld, otherHeld };
}

/** The paraphraser's lines: an opaque id (never the key) and the title with any ticket key taken out. */
export function paraphraseLines(requests: Request[]): { line: string; id: string; title: string }[] {
  return requests.filter((r) => r.klass === "para").map((r, i) => ({ line: `L${String(i + 1).padStart(2, "0")}`, id: r.id, title: r.title.replace(/\b[A-Z][A-Z0-9]+-\d+\b/g, "the ticket") }));
}

/** A paraphrase's problems, empty when it keeps the rules a program can check. */
export function paraphraseProblems(text: unknown, title: string): string[] {
  if (typeof text !== "string" || !text.trim()) return ["empty"];
  const p: string[] = [];
  if (/\b[A-Z][A-Z0-9]+-\d+\b/.test(text)) p.push("names a ticket key");
  if (text.trim().split(/\s+/).length > 25) p.push("over 25 words");
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  const tw = words(title);
  const pw = words(text);
  for (let i = 0; i + 6 <= pw.length; i++) {
    const six = pw.slice(i, i + 6).join(" ");
    for (let j = 0; j + 6 <= tw.length; j++) if (tw.slice(j, j + 6).join(" ") === six) { p.push("copies six words in a row from the title"); i = pw.length; break; }
  }
  return p;
}

// ── A run ─────────────────────────────────────────────────────────────────────

/**
 * One keyed tools/call, as db/brain-compare.ts's callToolReply makes it, but with CALL_TIMEOUT_MS: on a brain whose
 * sleep shares the model server, the search's embedding waits behind a background call that can run past a minute,
 * longer than that client's fixed 20 s. Returns the structured value; throws the tool's error.
 */
export const CALL_TIMEOUT_MS = 300_000;
export async function callTool(ep: BrainEndpoint, name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${ep.base}/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-brain-key": ep.key },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    redirect: "error",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${name} → HTTP ${r.status}`);
  const msg = unwrapRpc(await r.text());
  if (!msg) throw new Error(`${name} returned no JSON-RPC reply`);
  if (msg.error) throw new Error(`${name} refused — ${msg.error.message ?? JSON.stringify(msg.error)}`);
  if (msg.result?.isError) throw new Error(`${name} answered an error`);
  return msg.result?.structuredContent;
}

export type Hit = { id: string; similarity: number | null; literal: boolean };
export type Reply = { hits: Hit[]; vectorFailed: string | null; embedding: string | null };

/**
 * The hits whose block in plan_context's rendered text says `Contains…`: an exact literal of the request matched it,
 * shown or past the cut. The lean MCP value (SMD-4191) carries no needles, so the text is the record: blocks start
 * "--- Result N (…) ---" and name their thought on an "ID: <uuid>" line.
 */
export function literalIdsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const block of text.split(/^(?:--- )?Result \d+ /m).slice(1)) {
    const id = block.match(/^ID: ([0-9a-f-]{36})$/im)?.[1];
    if (id && /^Contains(?: \([^)]*\))?: /m.test(block)) out.add(id.toLowerCase());
  }
  return out;
}

/** A search's structured value (search_thoughts', or plan_context's under `knowledge`) → its hits (id, similarity, whether a literal matched) and a missed embedding. */
export function readReply(v: unknown): Reply {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const k = (o.knowledge && typeof o.knowledge === "object" ? o.knowledge : o) as Record<string, unknown>;
  const hits = Array.isArray(k.hits) ? k.hits : [];
  const literal = literalIdsOf(typeof o.text === "string" ? o.text : "");
  return {
    hits: hits.flatMap((h) => {
      const x = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
      if (typeof x.id !== "string") return [];
      const id = x.id.toLowerCase();
      return [{ id, similarity: typeof x.similarity === "number" ? x.similarity : null, literal: literal.has(id) }];
    }),
    vectorFailed: typeof k.vectorFailed === "string" ? k.vectorFailed : null,
    embedding: null,
  };
}

// ── The signals and the score ─────────────────────────────────────────────────

export type Rule = { candidate: Candidate; threshold: number | null };
export const ruleName = (r: Rule): string => (r.candidate === "literal" ? "literal" : `${r.candidate}(${r.threshold!.toFixed(2)})`);

export function littleBy(rule: Rule, hits: readonly Hit[]): boolean {
  if (rule.candidate === "literal") return !hits.some((h) => h.literal);
  const sims = hits.map((h) => h.similarity ?? 0);
  if (rule.candidate === "top") return (sims.length ? Math.max(...sims) : 0) < rule.threshold!;
  return sims.filter((s) => s >= rule.threshold!).length <= LITTLE_MAX;
}

export const allRules = (): Rule[] => [{ candidate: "literal", threshold: null }, ...THRESHOLDS.map((t) => ({ candidate: "top" as const, threshold: t })), ...THRESHOLDS.map((t) => ({ candidate: "count" as const, threshold: t }))];

export type Confusion = { tp: number; fp: number; tn: number; fn: number };
export function confusion(pred: boolean[], gold: boolean[]): Confusion {
  const c = { tp: 0, fp: 0, tn: 0, fn: 0 };
  pred.forEach((p, i) => { if (p && gold[i]) c.tp++; else if (p) c.fp++; else if (gold[i]) c.fn++; else c.tn++; });
  return c;
}
/** Mean of the recall on each class; a class with no members is left out of the mean (NaN when both are empty). */
export function balanced(c: Confusion): number {
  const r: number[] = [];
  if (c.tp + c.fn) r.push(c.tp / (c.tp + c.fn));
  if (c.tn + c.fp) r.push(c.tn / (c.tn + c.fp));
  return r.length ? r.reduce((s, x) => s + x, 0) / r.length : NaN;
}
/** Precision of `little`; NaN when the rule says little for none. */
export const precision = (c: Confusion): number => (c.tp + c.fp ? c.tp / (c.tp + c.fp) : NaN);

/** dev or test, by hash, half of each class in each (an odd class gives dev the extra one). */
export function splitOf(requests: readonly Request[]): Map<string, "dev" | "test"> {
  const m = new Map<string, "dev" | "test">();
  for (const k of ["brain", "other", "para"] as const) {
    const ids = requests.filter((r) => r.klass === k).map((r) => r.id).sort(byHash("split"));
    ids.forEach((id, i) => m.set(id, i < Math.ceil(ids.length / 2) ? "dev" : "test"));
  }
  return m;
}

/** The dev choice: the highest balanced accuracy; then the higher precision (NaN lowest); then CANDIDATE_ORDER; then the lower threshold. */
export function choose(rules: readonly Rule[], hits: Hit[][], gold: boolean[]): { rule: Rule; balanced: number; precision: number } {
  const scored = rules.map((rule) => { const c = confusion(hits.map((h) => littleBy(rule, h)), gold); return { rule, balanced: balanced(c), precision: precision(c) }; });
  const n = (x: number) => (Number.isNaN(x) ? -1 : x);
  scored.sort((a, b) => n(b.balanced) - n(a.balanced) || n(b.precision) - n(a.precision)
    || CANDIDATE_ORDER.indexOf(a.rule.candidate) - CANDIDATE_ORDER.indexOf(b.rule.candidate) || (a.rule.threshold ?? 0) - (b.rule.threshold ?? 0));
  return scored[0];
}

export type Labels = Record<string, Record<string, number>>;
export type Score = {
  preregistration: string;
  embedding: string | null;
  kappa: number;
  items: number;
  requests: { id: string; klass: Klass; split: "dev" | "test"; relevant: number; little: boolean; topSimilarity: number | null; literal: boolean }[];
  littleByClass: Record<Klass, { little: number; of: number }>;
  chosen: { rule: string; dev: { balanced: number; precision: number }; test: { balanced: number; precision: number; confusion: Confusion } };
  everyRuleOnTest: { rule: string; balanced: number; precision: number }[];
  verdict: "bar met" | "bar not met" | "no verdict";
  why: string;
};

export function score(requests: Request[], replies: Map<string, Reply>, keyMap: Record<string, Record<string, string>>, r1: Labels, r2: Labels, embedding: string | null): Score {
  const a: number[] = [];
  const b: number[] = [];
  const missing: string[] = [];
  const relevantOf = new Map<string, number>();
  for (const req of requests) {
    let rel = 0;
    for (const [label] of Object.entries(keyMap[req.id] ?? {})) {
      const x = r1[req.id]?.[label];
      const y = r2[req.id]?.[label];
      if ((x !== 0 && x !== 1) || (y !== 0 && y !== 1)) { missing.push(`${req.id} ${label}`); continue; }
      a.push(x); b.push(y);
      if (x === 1 && y === 1) rel++;
    }
    relevantOf.set(req.id, rel);
  }
  if (missing.length) throw new Error(`labels missing or not 0/1 for ${missing.length} row(s), first ${missing.slice(0, 5).join(", ")}`);
  const absent = requests.filter((r) => !replies.has(r.id)).map((r) => r.id);
  const failed = requests.filter((r) => replies.get(r.id)?.vectorFailed).map((r) => r.id);
  const split = splitOf(requests);
  const rows = requests.map((r) => {
    const hits = replies.get(r.id)?.hits ?? [];
    const sims = hits.map((h) => h.similarity).filter((s): s is number => s !== null);
    return { id: r.id, klass: r.klass, split: split.get(r.id)!, relevant: relevantOf.get(r.id) ?? 0, little: (relevantOf.get(r.id) ?? 0) <= LITTLE_MAX, topSimilarity: sims.length ? Math.max(...sims) : null, literal: hits.some((h) => h.literal) };
  });
  const littleByClass = { brain: { little: 0, of: 0 }, other: { little: 0, of: 0 }, para: { little: 0, of: 0 } };
  for (const r of rows) { littleByClass[r.klass].of++; if (r.little) littleByClass[r.klass].little++; }
  const pick = (s: "dev" | "test") => rows.filter((r) => r.split === s);
  const hitsOf = (rs: typeof rows) => rs.map((r) => replies.get(r.id)?.hits ?? []);
  const dev = pick("dev");
  const test = pick("test");
  const chosen = choose(allRules(), hitsOf(dev), dev.map((r) => r.little));
  const tc = confusion(hitsOf(test).map((h) => littleBy(chosen.rule, h)), test.map((r) => r.little));
  const k = kappa(a, b);
  const everyRuleOnTest = allRules().map((rule) => { const c = confusion(hitsOf(test).map((h) => littleBy(rule, h)), test.map((r) => r.little)); return { rule: ruleName(rule), balanced: balanced(c), precision: precision(c) }; });
  const tb = balanced(tc);
  const tp = precision(tc);
  let verdict: Score["verdict"];
  let why: string;
  if (absent.length || failed.length) { verdict = "no verdict"; why = `${absent.length} request(s) not run, ${failed.length} whose embedding missed the deadline: run them again`; }
  else if (!(k >= KAPPA_BAR)) { verdict = "no verdict"; why = `κ ${Number.isNaN(k) ? "undefined" : k.toFixed(3)} is below ${KAPPA_BAR}: the labels don't hold`; }
  else if (tb >= BAR_BALANCED && tp >= BAR_PRECISION) { verdict = "bar met"; why = `${ruleName(chosen.rule)}: test balanced accuracy ${tb.toFixed(3)}, precision of little ${tp.toFixed(3)}`; }
  else { verdict = "bar not met"; why = `${ruleName(chosen.rule)}: test balanced accuracy ${Number.isNaN(tb) ? "undefined" : tb.toFixed(3)} (bar ${BAR_BALANCED}), precision of little ${Number.isNaN(tp) ? "undefined" : tp.toFixed(3)} (bar ${BAR_PRECISION})`; }
  return {
    preregistration: PREREGISTRATION, embedding, kappa: k, items: a.length, requests: rows, littleByClass,
    chosen: { rule: ruleName(chosen.rule), dev: { balanced: chosen.balanced, precision: chosen.precision }, test: { balanced: tb, precision: tp, confusion: tc } },
    everyRuleOnTest, verdict, why,
  };
}

export function renderScore(s: Score): string {
  const f = (x: number | null) => (x === null || Number.isNaN(x) ? "n/a" : x.toFixed(3));
  return [
    `where "little on this" begins (SMD-4212 PR 1), preregistration ${s.preregistration.slice(0, 12)}, embedding ${s.embedding ?? "unknown"}`,
    "",
    "request              class  split  relevant  little  top-sim  literal",
    ...s.requests.map((r) => `${r.id.padEnd(20)} ${r.klass.padEnd(6)} ${r.split.padEnd(6)} ${String(r.relevant).padStart(8)}  ${String(r.little).padEnd(6)}  ${f(r.topSimilarity).padStart(7)}  ${r.literal}`),
    "",
    `labels: ${s.items} hits rated, κ ${f(s.kappa)}`,
    `little by class: brain ${s.littleByClass.brain.little}/${s.littleByClass.brain.of}, other ${s.littleByClass.other.little}/${s.littleByClass.other.of}, paraphrase ${s.littleByClass.para.little}/${s.littleByClass.para.of}`,
    `chosen on dev: ${s.chosen.rule} (balanced ${f(s.chosen.dev.balanced)}, precision ${f(s.chosen.dev.precision)})`,
    `on test: balanced ${f(s.chosen.test.balanced)}, precision ${f(s.chosen.test.precision)} (tp ${s.chosen.test.confusion.tp}, fp ${s.chosen.test.confusion.fp}, tn ${s.chosen.test.confusion.tn}, fn ${s.chosen.test.confusion.fn})`,
    `VERDICT: ${s.verdict} (${s.why})`,
  ].join("\n");
}

// ── Sheets ────────────────────────────────────────────────────────────────────

/** One request's sheet: the request and its hits in a hashed order, no similarity, rank or id. */
export function sheetFor(req: Request, ids: string[], rows: Map<string, Row>): string {
  const out = [`# ${req.id.startsWith("P-") ? `request ${sha(`${SEED}|sheet-id|${req.id}`).slice(0, 8)}` : req.id}`, "", `Request: ${req.text}`, "", `Rows: ${ids.length}. Label each one 1 or 0 under RULES.md.`, ""];
  ids.forEach((id, i) => {
    const r = rows.get(id);
    const content = r?.content ?? "";
    const chars = [...content];
    const cut = chars.length > ROW_CHARS ? `${chars.slice(0, ROW_CHARS).join("")}\n[… ${chars.length - ROW_CHARS} more characters]` : content;
    out.push(`## ${rLabel(i)}`, `Written ${r?.created_at ? String(r.created_at).slice(0, 10) : "?"}${r?.type ? ` · type ${r.type}` : ""}`, "", "~~~~text", cut.replaceAll("~~~~", "~ ~ ~ ~"), "~~~~", "");
  });
  return out.join("\n");
}
/** The sheet's heading id: a paraphrase gets an opaque one, so its key isn't shown beside a request written without it. */
export const sheetId = (req: Request): string => (req.id.startsWith("P-") ? `request ${sha(`${SEED}|sheet-id|${req.id}`).slice(0, 8)}` : req.id);

// ── Self-check ────────────────────────────────────────────────────────────────

export function selfCheck(): number {
  let fails = 0;
  const ok = (c: boolean, what: string) => { if (!c) { fails++; console.log(`FAIL ${what}`); } else console.log(`ok   ${what}`); };
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-9;

  // The draw.
  const t = (id: string, project: string | null, over: Partial<Ticket> = {}): Ticket => ({ id, title: `title ${id} about SMD-9 work`, createdAt: "2026-10-01T00:00:00.000Z", project, ...over });
  const brainT = Array.from({ length: 45 }, (_, i) => t(`SMD-${100 + i}`, `${PROJECT_PREFIX} — X`));
  const otherT = Array.from({ length: 45 }, (_, i) => t(`SMD-${300 + i}`, "Client Codebase Health"));
  const brainOrder = brainT.map((x) => x.id).sort(byHash("brain"));
  const otherOrder = otherT.map((x) => x.id).sort(byHash("other"));
  const held = new Set([...brainT.map((x) => x.id).filter((k) => k !== brainOrder[0]), otherOrder[2]]);
  const d = drawLittle([...brainT, ...otherT, t("SMD-999", null), t("SMD-998", "Client", { title: "Tracking: x" })], held);
  const brain = d.requests.filter((r) => r.klass === "brain");
  const other = d.requests.filter((r) => r.klass === "other");
  const para = d.requests.filter((r) => r.klass === "para");
  ok(brain.length === N_BRAIN && other.length === N_OTHER && para.length === 2 * N_PARA_EACH, "the draw takes N_BRAIN, N_OTHER and two N_PARA_EACH");
  ok(d.notHeld[0] === brainOrder[0] && brain[0].key === brainOrder[1], "a brain ticket the brain doesn't hold is passed over and named");
  ok(d.otherHeld[0] === otherOrder[2] && !other.some((r) => r.key === otherOrder[2]), "an other-project ticket the brain holds is passed over and named");
  ok(d.otherEligible === 45 && !d.requests.some((r) => r.key === "SMD-999" || r.key === "SMD-998"), "no project, or a tracker, is not eligible");
  ok(para.filter((r) => brain.some((b) => b.key === r.key)).length === N_PARA_EACH && para.every((r) => r.text === null && r.id === `P-${r.key}`), "half the paraphrases are brain tickets', each waiting for its text");
  ok(JSON.stringify(drawLittle([...otherT, ...brainT].reverse(), held).requests) === JSON.stringify(d.requests), "the draw doesn't depend on the listing's order");
  const lines = paraphraseLines(d.requests);
  ok(lines.length === 2 * N_PARA_EACH && lines.every((l) => !/SMD-\d/.test(l.title) && /^L\d\d$/.test(l.line)) && lines.every((l) => !l.line.includes("SMD")), "the paraphraser sees opaque line ids and titles with their keys taken out");
  ok(paraphraseProblems("Fix the export so it keeps every row", "The export drops rows past the first page").length === 0, "a clean paraphrase passes");
  ok(paraphraseProblems("Fix SMD-12 now", "x").includes("names a ticket key") && paraphraseProblems("", "x").includes("empty"), "a key or an empty answer is refused");
  ok(paraphraseProblems("we need the export drops rows past the first page fixed", "The export drops rows past the first page").some((p) => p.startsWith("copies")), "six words in a row from the title are refused");
  ok(paraphraseProblems(Array.from({ length: 26 }, () => "w").join(" "), "x").includes("over 25 words"), "more than 25 words is refused");

  // A reply.
  const U = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;
  const text = `Plan context for "x".\n\n--- Result 1 (90.6% match) ---\nID: ${U(1)}\nBy: a\nContains: SMD-1\nTopics: t\n\n--- Result 2 (40% match) ---\nID: ${U(2)}\nTopics: Contains: nothing\n\n--- Result 3 (30% match) ---\nID: ${U(3)}\nContains (in the whole text, past what is shown): SMD-1\n`;
  const rep = readReply({ knowledge: { hits: [{ id: U(1).toUpperCase(), similarity: 0.71 }, { id: U(2), similarity: null }, { id: U(3), similarity: 0.3 }, { nope: 1 }], vectorFailed: "deadline" }, text });
  ok(rep.hits.length === 3 && rep.hits[0].id === U(1) && rep.hits[1].similarity === null && rep.vectorFailed === "deadline", "a reply's hits, similarity and missed embedding are read");
  ok(rep.hits[0].literal && !rep.hits[1].literal && rep.hits[2].literal, "a literal match is read from its block's Contains line, shown or past the cut, and not from a Contains inside another line");
  const flat = readReply({ hits: [{ id: U(1), similarity: 0.5 }], vectorFailed: "provider_down", text });
  ok(flat.hits.length === 1 && flat.hits[0].literal && flat.vectorFailed === "provider_down", "search_thoughts' flat value reads the same way");
  ok(JSON.stringify(SEARCH_ARGS("q")) === JSON.stringify({ query: "q", limit: 8, prefer_current: true }) && SEARCH_TOOL === "search_thoughts", "the search is plan_context's: limit 8, prefer_current on, no threshold, recency or filter");

  // The signals.
  const H = (sims: (number | null)[], lit = false): Hit[] => sims.map((s, i) => ({ id: U(i), similarity: s, literal: lit && i === 0 }));
  ok(littleBy({ candidate: "top", threshold: 0.5 }, H([0.49, 0.2])) && !littleBy({ candidate: "top", threshold: 0.5 }, H([0.5])), "top(t): little below t, not at it");
  ok(littleBy({ candidate: "top", threshold: 0.3 }, H([null])) && littleBy({ candidate: "top", threshold: 0.3 }, []), "a literal-only hit reads 0, and no hit is little");
  ok(littleBy({ candidate: "count", threshold: 0.5 }, H([0.6, 0.4, 0.4])) && !littleBy({ candidate: "count", threshold: 0.5 }, H([0.6, 0.5, 0.1])), "count(f): little with at most LITTLE_MAX hits at f or more");
  ok(littleBy({ candidate: "literal", threshold: null }, H([0.9])) && !littleBy({ candidate: "literal", threshold: null }, H([0.1], true)), "literal: little when no hit matched a literal");
  ok(THRESHOLDS[0] === 0.3 && THRESHOLDS.at(-1) === 0.8 && THRESHOLDS.length === 26 && allRules().length === 53, "the threshold grid runs 0.30 to 0.80 by 0.02, 53 rules");

  // The statistics.
  const c = confusion([true, true, false, false, true], [true, false, false, true, true]);
  ok(c.tp === 2 && c.fp === 1 && c.tn === 1 && c.fn === 1, "the confusion counts");
  ok(near(balanced(c), (2 / 3 + 1 / 2) / 2) && near(precision(c), 2 / 3), "balanced accuracy and precision on a hand-worked table");
  ok(Number.isNaN(precision(confusion([false], [true]))) && near(balanced(confusion([false], [false])), 1), "precision undefined with no little said; a one-class set is its one recall");
  const ch = choose([{ candidate: "top", threshold: 0.5 }, { candidate: "literal", threshold: null }, { candidate: "top", threshold: 0.4 }], [H([0.3]), H([0.6], true)], [true, false]);
  ok(ch.rule.candidate === "literal", "a tie on balanced accuracy and precision goes to literal first");
  const ch2 = choose([{ candidate: "top", threshold: 0.5 }, { candidate: "top", threshold: 0.4 }], [H([0.3]), H([0.6])], [true, false]);
  ok(ch2.rule.threshold === 0.4, "then to the lower threshold");
  const ch3 = choose([{ candidate: "literal", threshold: null }, { candidate: "top", threshold: 0.5 }], [H([0.3]), H([0.6], true), H([0.7])], [true, false, false]);
  ok(ch3.rule.candidate === "top", "a higher balanced accuracy beats the candidate order");

  // The split.
  const reqs: Request[] = [...Array.from({ length: 5 }, (_, i) => ({ id: `SMD-${i}`, key: `SMD-${i}`, klass: "brain" as const, title: "t", text: "x" })), ...Array.from({ length: 4 }, (_, i) => ({ id: `SMD-${50 + i}`, key: `SMD-${50 + i}`, klass: "other" as const, title: "t", text: "x" }))];
  const sp = splitOf(reqs);
  ok([...sp.values()].filter((v) => v === "dev").length === 5 && reqs.filter((r) => r.klass === "brain" && sp.get(r.id) === "dev").length === 3, "the split halves each class, an odd one giving dev the extra");

  // The score, end to end.
  const two: Request[] = [
    { id: "SMD-1", key: "SMD-1", klass: "brain", title: "t", text: "x" }, { id: "SMD-2", key: "SMD-2", klass: "brain", title: "t", text: "x" },
    { id: "SMD-3", key: "SMD-3", klass: "other", title: "t", text: "x" }, { id: "SMD-4", key: "SMD-4", klass: "other", title: "t", text: "x" },
  ];
  const replies = new Map<string, Reply>([["SMD-1", { hits: H([0.8, 0.7]), vectorFailed: null, embedding: null }], ["SMD-2", { hits: H([0.75, 0.6]), vectorFailed: null, embedding: null }], ["SMD-3", { hits: H([0.4, 0.3]), vectorFailed: null, embedding: null }], ["SMD-4", { hits: H([0.35, 0.2]), vectorFailed: null, embedding: null }]]);
  const km = Object.fromEntries(two.map((r) => [r.id, { R01: U(0), R02: U(1) }]));
  const lab: Labels = { "SMD-1": { R01: 1, R02: 1 }, "SMD-2": { R01: 1, R02: 1 }, "SMD-3": { R01: 0, R02: 0 }, "SMD-4": { R01: 1, R02: 0 } };
  const s = score(two, replies, km, lab, lab, "m@1");
  ok(s.requests.find((r) => r.id === "SMD-1")!.little === false && s.requests.find((r) => r.id === "SMD-4")!.little === true && s.requests.find((r) => r.id === "SMD-4")!.relevant === 1, "little is at most LITTLE_MAX hits relevant by both");
  ok(s.littleByClass.brain.little === 0 && s.littleByClass.other.little === 2 && near(s.kappa, 1), "little counted by class; κ over every rated hit");
  ok(s.verdict === "bar met" && s.chosen.test.confusion.tp + s.chosen.test.confusion.fn === 1, "separable requests meet the bar on test");
  const split = score(two, replies, km, lab, { ...lab, "SMD-1": { R01: 1, R02: 0 } }, null);
  ok(split.requests.find((r) => r.id === "SMD-1")!.relevant === 1 && split.requests.find((r) => r.id === "SMD-1")!.little === true, "a hit one rater calls relevant is not gold");
  const failed = score(two, new Map([...replies, ["SMD-4", { hits: H([0.35]), vectorFailed: "deadline", embedding: null }]]), km, lab, lab, null);
  ok(failed.verdict === "no verdict" && /deadline/.test(failed.why), "a request whose embedding missed the deadline gives no verdict");
  const noRun = score(two, new Map([...replies].filter(([k]) => k !== "SMD-2")), km, lab, lab, null);
  ok(noRun.verdict === "no verdict", "a request not run gives no verdict");
  const noisy = score(two, replies, km, lab, { "SMD-1": { R01: 0, R02: 0 }, "SMD-2": { R01: 0, R02: 1 }, "SMD-3": { R01: 1, R02: 1 }, "SMD-4": { R01: 0, R02: 1 } }, null);
  ok(noisy.verdict === "no verdict" && /κ/.test(noisy.why), "raters who disagree give no verdict");
  let threw = false;
  try { score(two, replies, km, lab, { "SMD-1": { R01: 1 } }, null); } catch { threw = true; }
  ok(threw, "a hit a rater left unlabelled stops the score");

  // The sheet.
  const rowsM = new Map<string, Row>([[U(0), { id: U(0), created_at: "2026-10-02T00:00:00Z", type: "observation", content: "x".repeat(ROW_CHARS + 3) }], [U(1), { id: U(1), content: "~~~~text\nforged" }]]);
  const paraReq: Request = { id: "P-SMD-7", key: "SMD-7", klass: "para", title: "t", text: "fix the export" };
  const sh = sheetFor(paraReq, [U(0), U(1)], rowsM);
  ok(!sh.includes("SMD-7") && sh.startsWith(`# ${sheetId(paraReq)}`) && /^# request [0-9a-f]{8}/.test(sh), "a paraphrase's sheet names no key");
  ok(sh.includes("[… 3 more characters]") && (sh.match(/^~~~~/gm) ?? []).length === 4 && !sh.includes(U(0)) && !/similarity|rank/i.test(sh), "a sheet cuts long rows, keeps its fences, and names no id, similarity or rank");
  ok(sheetFor(two[0], [U(0)], rowsM).startsWith("# SMD-1"), "a ticket request's sheet keeps its key");
  ok(/^[0-9a-f]{64}$/.test(PREREGISTRATION), "the preregistration hash is taken");

  console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
  return fails;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function argsAfter(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a !== flag) return; for (let j = i + 1; j < args.length && !args[j].startsWith("--"); j++) out.push(args[j]); });
  return out;
}
const arg = (args: string[], flag: string): string | undefined => argsAfter(args, flag)[0];
function need(v: string | undefined, what: string): string {
  if (!v) { process.stderr.write(`${what} is required\n`); process.exit(2); }
  return v;
}
type RequestsFile = { seed: string; preregistration: string; requests: Request[] } & Record<string, unknown>;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--self-check")) process.exit(selfCheck() ? 1 : 0);

  if (args.includes("--draw")) {
    const tickets = argsAfter(args, "--draw").flatMap((p) => (JSON.parse(readFileSync(p, "utf8")) as { issues: Ticket[] }).issues);
    const held = new Set(readFileSync(need(arg(args, "--held"), "--held"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean));
    const d = drawLittle(tickets, held);
    const out = need(arg(args, "--out"), "--out");
    writeFileSync(out, `${JSON.stringify({ seed: SEED, preregistration: PREREGISTRATION, listed: tickets.length, brainEligible: d.brainEligible, otherEligible: d.otherEligible, notHeld: d.notHeld, otherHeld: d.otherHeld, requests: d.requests }, null, 2)}\n`);
    console.log(`${tickets.length} listed; ${d.brainEligible} brain and ${d.otherEligible} other eligible; ${d.requests.length} requests → ${out}`);
    return;
  }

  const reqPath = need(arg(args, "--requests"), "--requests");
  const file = JSON.parse(readFileSync(reqPath, "utf8")) as RequestsFile;
  const requests = file.requests;

  if (args.includes("--paraphrase-sheet")) {
    console.log(PARAPHRASE_RULES);
    for (const l of paraphraseLines(requests)) console.log(`${l.line}: ${l.title}`);
    return;
  }
  if (args.includes("--paraphrases")) {
    const answers = JSON.parse(readFileSync(need(arg(args, "--paraphrases"), "--paraphrases"), "utf8")) as Record<string, string>;
    const lines = paraphraseLines(requests);
    const bad: string[] = [];
    for (const l of lines) {
      const r = requests.find((x) => x.id === l.id)!;
      const p = paraphraseProblems(answers[l.line], r.title);
      if (p.length) bad.push(`${l.line}: ${p.join(", ")}`); else r.text = answers[l.line].trim();
    }
    if (bad.length) { process.stderr.write(`paraphrases refused:\n  ${bad.join("\n  ")}\n`); process.exit(1); }
    writeFileSync(reqPath, `${JSON.stringify({ ...file, requests }, null, 2)}\n`);
    console.log(`${lines.length} paraphrases merged into ${reqPath}`);
    return;
  }

  const dir = need(arg(args, "--out"), "--out");
  mkdirSync(join(dir, "runs"), { recursive: true });
  const runPath = (id: string) => join(dir, "runs", `${id}.json`);

  if (args.includes("--run")) {
    if (requests.some((r) => !r.text)) { process.stderr.write("a paraphrase has no text yet: merge --paraphrases first\n"); process.exit(2); }
    const cfg = JSON.parse(readFileSync(need(arg(args, "--mcp-config"), "--mcp-config"), "utf8")) as { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> };
    const b = cfg.mcpServers.brain;
    if (!b?.url || !b.headers?.["x-brain-key"]) { process.stderr.write("the MCP config names no `brain` with an x-brain-key header\n"); process.exit(2); }
    const ep: BrainEndpoint = { label: "brain", base: b.url.replace(/\/$/, ""), key: b.headers["x-brain-key"] };
    const info = await callTool(ep, "brain_info", {});
    const emb = (info as { embedding?: { model?: string; dim?: number } } | undefined)?.embedding;
    const embedding = emb?.model ? `${emb.model}@${emb.dim}` : null;
    writeFileSync(join(dir, "embedding.txt"), `${embedding ?? "unknown"}\n`);
    // One warm-up call, so the model is loaded before the first measured search.
    await callTool(ep, SEARCH_TOOL, SEARCH_ARGS("warm-up"));
    for (const r of requests) {
      if (existsSync(runPath(r.id)) && !args.includes("--again") && !readReply(JSON.parse(readFileSync(runPath(r.id), "utf8"))).vectorFailed) { console.log(`${r.id}: done already`); continue; }
      const started = Date.now();
      let reply = await callTool(ep, SEARCH_TOOL, SEARCH_ARGS(r.text!));
      for (let i = 0; i < 2 && readReply(reply).vectorFailed; i++) reply = await callTool(ep, SEARCH_TOOL, SEARCH_ARGS(r.text!));
      writeFileSync(runPath(r.id), `${JSON.stringify(reply ?? null)}\n`);
      const rp = readReply(reply);
      console.log(`${r.id} (${r.klass}): ${rp.hits.length} hits, top similarity ${Math.max(0, ...rp.hits.map((h) => h.similarity ?? 0)).toFixed(3)}${rp.hits.some((h) => h.literal) ? ", a literal matched" : ""}${rp.vectorFailed ? `, EMBEDDING MISSED (${rp.vectorFailed})` : ""}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    return;
  }

  const replies = new Map<string, Reply>();
  for (const r of requests) if (existsSync(runPath(r.id))) replies.set(r.id, readReply(JSON.parse(readFileSync(runPath(r.id), "utf8"))));
  if (args.includes("--ids")) {
    console.log([...new Set([...replies.values()].flatMap((r) => r.hits.map((h) => h.id)))].join("\n"));
    return;
  }
  const keyMap: Record<string, Record<string, string>> = {};
  for (const r of requests) {
    const ids = [...new Set((replies.get(r.id)?.hits ?? []).map((h) => h.id))].sort(byHash(`sheet|${r.id}`));
    keyMap[r.id] = Object.fromEntries(ids.map((id, i) => [rLabel(i), id]));
  }
  if (args.includes("--sheets")) {
    const rows = new Map((JSON.parse(readFileSync(need(arg(args, "--rows"), "--rows"), "utf8")) as Row[]).map((r) => [r.id.toLowerCase(), r]));
    mkdirSync(join(dir, "sheets"), { recursive: true });
    writeFileSync(join(dir, "sheets", "RULES.md"), RATER_RULES);
    // A paraphrase's sheet is named by its opaque id, so a rater can't pair it with its ticket by file name.
    const sheetIds: Record<string, string> = {};
    requests.forEach((r, i) => {
      const name = `${String(i + 1).padStart(2, "0")}-${sheetId(r).replace(/\s+/g, "-")}.md`;
      sheetIds[sheetId(r)] = r.id;
      writeFileSync(join(dir, "sheets", name), sheetFor(r, Object.values(keyMap[r.id]), rows));
    });
    writeFileSync(join(dir, "key.json"), `${JSON.stringify({ keyMap, sheetIds }, null, 2)}\n`);
    console.log(`${requests.length} sheets, ${Object.values(keyMap).reduce((s, m) => s + Object.keys(m).length, 0)} rows → ${join(dir, "sheets")}; the key in ${join(dir, "key.json")}, kept from the raters`);
    return;
  }
  if (args.includes("--score")) {
    const labels = argsAfter(args, "--labels");
    if (labels.length !== 2) { process.stderr.write("--score takes --labels twice, one per rater\n"); process.exit(2); }
    const stored = JSON.parse(readFileSync(join(dir, "key.json"), "utf8")) as { keyMap: Record<string, Record<string, string>>; sheetIds: Record<string, string> };
    if (JSON.stringify(stored.keyMap) !== JSON.stringify(keyMap)) { process.stderr.write("key.json no longer matches the runs: the sheets were made from other data\n"); process.exit(2); }
    // Raters answer by the sheet's heading id; map a paraphrase's opaque id back to its request.
    const back = (l: Labels): Labels => Object.fromEntries(Object.entries(l).map(([k, v]) => [stored.sheetIds[k] ?? k, v]));
    const embedding = existsSync(join(dir, "embedding.txt")) ? readFileSync(join(dir, "embedding.txt"), "utf8").trim() : null;
    const s = score(requests, replies, keyMap, back(JSON.parse(readFileSync(labels[0], "utf8"))), back(JSON.parse(readFileSync(labels[1], "utf8"))), embedding);
    console.log(renderScore(s));
    const json = arg(args, "--json");
    if (json) writeFileSync(json, `${JSON.stringify(s, null, 2)}\n`);
    return;
  }
  process.stderr.write("usage: see the header of eval-little.ts\n");
  process.exit(2);
}

if (import.meta.main) await main();
