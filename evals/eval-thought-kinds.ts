#!/usr/bin/env bun
/**
 * eval-thought-kinds.ts — what kinds of statement does the brain actually hold,
 * and can the metadata model tell them apart? (Linear SMD-1951; the measurement
 * SMD-1949's `type` enum is decided from.)
 *
 * `thought_stats` on the dogfood brain, 2026-09-22: 308 thoughts, 259 of them
 * `task`. The five upstream types carry almost no information, and widening the
 * enum by intuition would repeat the mistake — a type nobody consumes is a label
 * nobody reads, and one the extractor cannot assign reliably is a filter that
 * will be trusted and wrong. So the whole brain was labelled by hand against a
 * candidate axis first, and this harness holds that labelled set: the fixture
 * (`fixtures/thought-kinds.json`) is ids and labels ONLY — every value is a
 * thought id or a closed-vocabulary key, so check-fork-consistency 9 accepts it
 * and the content stays where it is; the eval pulls the text live.
 *
 * The axis. `kind` is the EPISTEMIC kind — what kind of statement the thought
 * is — and nothing else. `person_note` is a referent (entity edges, SMD-947 /
 * SMD-1935) and `task` a workflow state; neither is a kind here. `plan` was
 * added during labelling: the ticket's candidates had no honest slot for a
 * piece of assigned work with its problem and its acceptance test, which is
 * what a Linear import IS, and `procedure` (how to do a repeatable thing) is
 * not that. A thought that is genuinely two kinds with neither dominant is
 * `compound`, with the kinds it contains recorded under `parts` — the fork's
 * answer to a compound is to atomize it (SMD-1930), not to give it two types.
 *
 * Four modes, one shape:
 *
 *   bun eval-thought-kinds.ts --self-check                       # the fixture's shape rules, probed; no database, no model
 *   DATABASE_URL=… bun eval-thought-kinds.ts --label out.jsonl   # the model's first pass over every thought, one line per id, resumable
 *   bun eval-thought-kinds.ts --freeze labels.jsonl out.jsonl    # hand labels + first pass → the fixture
 *   DATABASE_URL=… bun eval-thought-kinds.ts [--frozen]          # score: distribution, the legacy confusion table, first-pass agreement
 *
 * Scoring reads the fixture, pulls `metadata.type` and the text for its ids
 * from the LIVE brain, and prints (1) the distribution per kind × source, with
 * the status axis where a kind carries one; (2) the confusion of the shipped
 * `type` against the kind, and how much of the brain has NO slot in the five;
 * (3) the frozen first pass's agreement with the hand label, per kind and per
 * confidence band, and where it named a kind that carries a status, whether it
 * read the status too; (4) unless `--frozen`, the same model run again now, so the
 * agreement number is reproduced against the live brain rather than read from
 * the file. The model is the metadata model (OB1_METADATA_MODEL) through the
 * server's own resolver and egress gate, at the metadata temperature (0 by
 * default, so the first pass is reproducible). The text sent is capped at
 * CLASSIFY_CHARS — the kind is decided in the head, and the longest imports
 * are past the 7B's comfortable window (SMD-1879).
 *
 * The confidence band the first pass returns is recorded, not used: SMD-1949
 * proposes a `type_confidence` band to feed a review queue, and this fixture is
 * the test of whether the band means anything before it ships.
 */

import { SQL } from "bun";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";
import { ProviderError, providerCall, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";

/** The candidate axis. Closed for this measurement; SMD-1949 decides which earn a slot. */
export const KINDS = [
  "observation", "fact", "idea", "hypothesis", "question", "decision", "lesson",
  "procedure", "rule", "event", "plan", "reference", "compound",
] as const;
export type Kind = (typeof KINDS)[number];

/** The kinds that carry a workflow/resolution status, and the values each takes. */
export const STATUS_OF: Partial<Record<Kind, readonly string[]>> = {
  plan: ["open", "done", "canceled"],
  question: ["open", "resolved"],
  hypothesis: ["open", "confirmed", "refuted"],
  decision: ["standing", "superseded"],
};

/** Where a row came from, read from the text's shape — the dogfood brain's every row says `source: mcp`, because the board was loaded through capture_thought (SMD-1806's ingester labels its own rows and was not what filled this brain). */
export const SOURCE_KINDS = ["linear_issue", "linear_project", "agent_capture"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CONFIDENCE = ["high", "medium", "low"] as const;

/** The shipped five (server-portable/thoughts.ts THOUGHT_TYPES). */
export const LEGACY_TYPES = ["observation", "task", "idea", "reference", "person_note"] as const;

/**
 * Which shipped type a kind would land on if the extractor were right — the
 * expectation column of the confusion table. A kind with no entry has NO slot
 * in the five: whatever the extractor says about it is wrong by construction,
 * and that share of the brain is the measurement SMD-1949 wants. A hypothesis
 * is not an `idea` (a possibility floated) — it is a prediction with a
 * resolvable outcome, and the five cannot say that — so it has no slot.
 */
export const LEGACY_OF: Partial<Record<Kind, (typeof LEGACY_TYPES)[number]>> = {
  observation: "observation", fact: "observation", event: "observation",
  idea: "idea",
  plan: "task",
  reference: "reference",
};

/** Characters of a thought the classifier sees. */
export const CLASSIFY_CHARS = 12_000;

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(HERE, "fixtures", "thought-kinds.json");

// ── The text's shape ─────────────────────────────────────────────────────────

const ISSUE_HEAD = /^SMD-\d+ — [^\n]*\nProject: [^\n]*· Status: [^\n]*\n/;
// Anchored on the head, not on any line: a head whose own status line lacks the
// parenthetical must not take one from a ticket quoted further down (review pass 5).
const ISSUE_STATUS = /^SMD-\d+ — [^\n]*\nProject: [^\n]*· Status: [^·\n]+? \((\w+)\)/;

/** A Linear issue as the board loader wrote it, a project record, or anything else — an agent's or a person's capture. */
export function sourceKindOf(content: string): SourceKind {
  if (ISSUE_HEAD.test(content)) return "linear_issue";
  if (content.startsWith("Project: ")) return "linear_project";
  return "agent_capture";
}

/** A `plan` status from an imported issue's own state type; undefined when the text is not an import — a status line quoted inside a capture is not the capture's status (review pass 4 moved the gate here from label()). */
export function ticketStatusOf(content: string): "open" | "done" | "canceled" | undefined {
  if (!ISSUE_HEAD.test(content)) return undefined;
  const m = ISSUE_STATUS.exec(content);
  if (!m) return undefined;
  const t = m[1];
  if (t === "completed") return "done";
  if (t === "canceled") return "canceled";
  return "open";
}

// ── The model's first pass ───────────────────────────────────────────────────

export const SYSTEM = `Classify the user's captured thought by its epistemic kind — what kind of statement it is. Return JSON with:
- "kind": exactly one of
  "observation" (something noticed or measured at a time — a report of what was),
  "fact" (a standing truth about the system or the world, not tied to when it was noticed),
  "idea" (a possibility floated, not committed to),
  "hypothesis" (a prediction whose outcome can be checked later),
  "question" (an open unknown, asked),
  "decision" (a choice made among alternatives, with what was rejected),
  "lesson" (a rule drawn from an outcome that claims to transfer to the next case),
  "procedure" (how to do something here, step by step, and what bites),
  "rule" (a standing constraint or policy to follow),
  "event" (a dated thing that happened),
  "plan" (a piece of proposed or assigned work: a problem and what will be done about it, done or not),
  "reference" (a pointer to something elsewhere, kept for lookup),
  "compound" (genuinely two or more of the above with none dominant)
- "status": for a plan "open"|"done"|"canceled"; a question "open"|"resolved"; a hypothesis "open"|"confirmed"|"refuted"; a decision "standing"|"superseded"; otherwise null
- "confidence": "high"|"medium"|"low" — how sure you are of the kind
Judge by what the text mainly asserts, not by its length or its topic.`;

export type Verdict = { kind: Kind; status: string | null; confidence: (typeof CONFIDENCE)[number] | null };

/** The model's JSON, held to the vocabulary; a kind off the list is a parse failure, not a coercion — the point is to measure the model, not to help it. */
export function parseVerdict(raw: unknown): Verdict | { error: string } {
  if (typeof raw !== "string") return { error: "no message content" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { error: "not JSON" }; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "not an object" };
  const o = parsed as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind.trim().toLowerCase() : "";
  if (!(KINDS as readonly string[]).includes(kind)) return { error: `kind "${String(o.kind)}" off the list` };
  const k = kind as Kind;
  // The status is secondary: a value off the kind's list (the model answering
  // "backlog" for a plan, say) is recorded as no status, and the kind stands —
  // the kind is what is scored, and a status miss must not read as "unanswered".
  const allowed = STATUS_OF[k];
  const s = typeof o.status === "string" ? o.status.trim().toLowerCase() : "";
  const status = allowed && allowed.includes(s) ? s : null;
  // A band off the list, or none, is recorded as none — not as "low", which
  // would make the band table conflate "the model said low" with "the model
  // said nothing usable" (review pass 3).
  const c = typeof o.confidence === "string" ? o.confidence.trim().toLowerCase() : "";
  const confidence = (CONFIDENCE as readonly string[]).includes(c) ? (c as (typeof CONFIDENCE)[number]) : null;
  return { kind: k, status, confidence };
}

type Chat = { choices?: [{ message?: { content?: string } }] };

async function classify(content: string, metadata: Record<string, unknown>): Promise<Verdict | { error: string }> {
  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  try {
    const d = await providerCall<Chat>(cfg, "/chat/completions", {
      model: cfg.metadataModel,
      response_format: { type: "json_object" },
      temperature: cfg.metadataTemperature,
      ...cfg.metadataReasoning,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: content.slice(0, CLASSIFY_CHARS) }],
    }, { kind: "extraction", metadata, content });
    return parseVerdict(d?.choices?.[0]?.message?.content);
  } catch (e) {
    if (e instanceof ProviderError) return { error: `${e.kind}: ${e.message}` };
    throw e;
  }
}

// ── The fixture ──────────────────────────────────────────────────────────────

/**
 * Ids and labels only, every label a KEY of a closed vocabulary and every
 * value an id — the one shape check 9 admits without an allowlist entry, and
 * the compact one: a kind is the list of thoughts that are it.
 */
export type Fixture = {
  generated: string;
  origin: string;
  note: string;
  /** kind → ids; a partition of the labelled set. */
  kinds: Record<string, string[]>;
  /** For compounds only: the kinds they contain → ids. */
  parts: Record<string, string[]>;
  /** status value → ids; only for ids whose kind carries that status. */
  status: Record<string, string[]>;
  /** source kind → ids; a partition of the labelled set. */
  source_kind: Record<string, string[]>;
  /** The model's first-pass kind → ids (a partition of the ids it answered for). */
  first_pass: Record<string, string[]>;
  /** The model's first-pass confidence band → ids; an id whose answer carried no usable band is absent. */
  first_pass_confidence: Record<string, string[]>;
  /** The model's first-pass status → ids, for the ids whose first-pass kind carries one and whose answer gave one. */
  first_pass_status: Record<string, string[]>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id → key for one map, checking that no id sits under two keys. */
function invert(map: Record<string, string[]>, what: string, problems: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, ids] of Object.entries(map)) {
    if (!Array.isArray(ids)) { problems.push(`${what}.${key} is not an array`); continue; }
    if (ids.length === 0) { problems.push(`${what}.${key} is empty — a key with no ids says nothing; drop it`); continue; }
    for (const id of ids) {
      if (typeof id !== "string" || !UUID.test(id)) { problems.push(`${what}.${key} carries a non-id ${JSON.stringify(id).slice(0, 40)}`); continue; }
      // The database emits lowercase; an upper-cased id would validate and then
      // miss its live row in the score's IN list (review pass 4).
      if (id !== id.toLowerCase()) { problems.push(`${what}.${key} carries an upper-cased id ${id}`); continue; }
      if (out.get(id) === key) problems.push(`${what}.${key} lists ${id} twice`);
      else if (out.has(id)) problems.push(`${what}: ${id} is under both ${out.get(id)} and ${key}`);
      out.set(id, key);
    }
  }
  return out;
}

/**
 * The shape rules, as a list of what is wrong (empty = sound). Pure, so
 * --self-check can probe it with mutants; the freeze refuses to write a fixture
 * that fails it and the score refuses to read one.
 */
export function validateFixture(f: Fixture): string[] {
  const problems: string[] = [];
  for (const k of ["generated", "origin", "note"] as const) if (typeof f[k] !== "string" || f[k].trim() === "") problems.push(`${k} is missing`);
  for (const k of ["kinds", "parts", "status", "source_kind", "first_pass", "first_pass_confidence", "first_pass_status"] as const) {
    if (!f[k] || typeof f[k] !== "object" || Array.isArray(f[k])) { problems.push(`${k} is not an object`); return problems; }
  }
  for (const k of Object.keys(f.kinds)) if (!(KINDS as readonly string[]).includes(k)) problems.push(`kinds.${k} is not a candidate kind`);
  for (const k of Object.keys(f.first_pass)) if (!(KINDS as readonly string[]).includes(k)) problems.push(`first_pass.${k} is not a candidate kind`);
  for (const k of Object.keys(f.parts)) if (!(KINDS as readonly string[]).includes(k) || k === "compound") problems.push(`parts.${k} is not a kind a compound can contain`);
  for (const k of Object.keys(f.source_kind)) if (!(SOURCE_KINDS as readonly string[]).includes(k)) problems.push(`source_kind.${k} is not a source kind`);
  for (const k of Object.keys(f.first_pass_confidence)) if (!(CONFIDENCE as readonly string[]).includes(k)) problems.push(`first_pass_confidence.${k} is not a band`);
  const allStatus = new Set(Object.values(STATUS_OF).flat());
  for (const k of Object.keys(f.status)) if (!allStatus.has(k)) problems.push(`status.${k} is not a status any kind carries`);
  for (const k of Object.keys(f.first_pass_status)) if (!allStatus.has(k)) problems.push(`first_pass_status.${k} is not a status any kind carries`);

  const kindOf = invert(f.kinds, "kinds", problems);
  if (kindOf.size === 0) problems.push("kinds is empty");
  const sourceOf = invert(f.source_kind, "source_kind", problems);
  const statusOf = invert(f.status, "status", problems);
  const firstOf = invert(f.first_pass, "first_pass", problems);
  const bandOf = invert(f.first_pass_confidence, "first_pass_confidence", problems);
  const fpStatusOf = invert(f.first_pass_status, "first_pass_status", problems);
  for (const id of kindOf.keys()) if (!sourceOf.has(id)) problems.push(`${id} has a kind and no source_kind`);
  for (const id of sourceOf.keys()) if (!kindOf.has(id)) problems.push(`${id} has a source_kind and no kind`);
  for (const [id, s] of statusOf) {
    const k = kindOf.get(id);
    if (!k) { problems.push(`${id} has a status and no kind`); continue; }
    const allowed = STATUS_OF[k as Kind];
    if (!allowed) problems.push(`${id} is a ${k}, which carries no status, but has status ${s}`);
    else if (!allowed.includes(s)) problems.push(`${id} is a ${k} with status ${s}, not one of ${allowed.join("|")}`);
  }
  for (const [id, k] of kindOf) if (STATUS_OF[k as Kind] && !statusOf.has(id)) problems.push(`${id} is a ${k} and needs a status`);
  // Parts: every compound names at least two DISTINCT parts, nothing else
  // names any, and a part is not named twice for one id (review pass 3: the
  // other maps get that through invert; this one is many-to-many).
  const partsOf = new Map<string, string[]>();
  for (const [part, ids] of Object.entries(f.parts)) {
    if (!Array.isArray(ids)) { problems.push(`parts.${part} is not an array`); continue; }
    if (ids.length === 0) { problems.push(`parts.${part} is empty — a key with no ids says nothing; drop it`); continue; }
    for (const id of ids) {
      if (typeof id !== "string" || !UUID.test(id)) { problems.push(`parts.${part} carries a non-id ${JSON.stringify(id).slice(0, 40)}`); continue; }
      if (id !== id.toLowerCase()) { problems.push(`parts.${part} carries an upper-cased id ${id}`); continue; }
      const had = partsOf.get(id) ?? [];
      if (had.includes(part)) problems.push(`${id} names the part ${part} twice`);
      partsOf.set(id, [...had, part]);
    }
  }
  for (const [id, k] of kindOf) {
    const parts = partsOf.get(id) ?? [];
    if (k === "compound" && parts.length < 2) problems.push(`${id} is a compound with ${parts.length} part(s); a compound names at least two`);
    if (k !== "compound" && parts.length > 0) problems.push(`${id} is a ${k} and has parts (${parts.join(", ")}); only a compound has parts`);
  }
  for (const id of partsOf.keys()) if (!kindOf.has(id)) problems.push(`${id} has parts and no kind`);
  for (const id of firstOf.keys()) if (!kindOf.has(id)) problems.push(`${id} has a first-pass kind and no hand label`);
  for (const id of bandOf.keys()) if (!firstOf.has(id)) problems.push(`${id} has a first-pass band and no first-pass kind`);
  for (const [id, st] of fpStatusOf) {
    const k = firstOf.get(id);
    if (!k) { problems.push(`${id} has a first-pass status and no first-pass kind`); continue; }
    const allowed = STATUS_OF[k as Kind];
    if (!allowed) problems.push(`${id}'s first pass is a ${k}, which carries no status, but has first-pass status ${st}`);
    else if (!allowed.includes(st)) problems.push(`${id}'s first pass is a ${k} with status ${st}, not one of ${allowed.join("|")}`);
  }
  return problems;
}

export function readFixture(path = FIXTURE_PATH): Fixture {
  const f = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  const problems = validateFixture(f);
  if (problems.length) {
    console.error(`${path} is not a sound fixture:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  … ${problems.length - 20} more` : ""}`);
    process.exit(2);
  }
  return f;
}

/** A review-file line: what --label writes per thought. Content never. */
type ReviewLine = {
  id: string;
  legacy_type: string | null;
  source_kind: SourceKind;
  ticket_status: "open" | "done" | "canceled" | null;
  first_pass: Verdict | null;
  error: string | null;
};

/** A hand label: the reader's kind, and the parts / status where the kind takes them. */
type HandLabel = { id: string; kind: Kind; parts?: Kind[]; status?: string };

/**
 * A run killed mid-append leaves a torn, unterminated last line. readJsonl skips
 * it on read, but the next append would glue a whole line onto it, and one
 * resume later that glued line is the torn tail — the fresh answer lost — and
 * two resumes later a torn line sits mid-file and every read throws (review
 * pass 5 reproduced this against pass 4's read-side fix). So the resume trims
 * the torn bytes off the end first: a truncate to the last newline, never a
 * rewrite of the answered lines. Returns whether anything was trimmed.
 */
export function trimTornTail(path: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  if (text === "" || text.endsWith("\n")) return false;
  const keep = text.slice(0, text.lastIndexOf("\n") + 1);
  truncateSync(path, Buffer.byteLength(keep, "utf8"));
  console.error(`${path}: trimmed a torn last line (a run killed mid-write?) before appending`);
  return true;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const out: T[] = [];
  lines.forEach((l, i) => {
    try { out.push(JSON.parse(l) as T); }
    catch {
      // A run killed mid-append leaves a partial last line; that one is dropped
      // with a word, so the resume can go on. Anything earlier is a real defect.
      if (i === lines.length - 1) console.error(`${path}: the last line is not JSON (a run killed mid-write?); dropped`);
      else throw new Error(`${path}: line ${i + 1} is not JSON`);
    }
  });
  return out;
}

function push(map: Record<string, string[]>, key: string, id: string) { (map[key] ??= []).push(id); }

/**
 * Hand labels + the first pass → the fixture. The source kind and, for a plan
 * with no hand status, the ticket's own status come from the review file (the
 * text's shape, read once at --label time); the hand label wins where both
 * speak. Every id in the labels file must have a review line, so nothing is
 * frozen that was not read from the brain.
 */
export function buildFixture(labels: HandLabel[], review: ReviewLine[], note: string, generated = new Date().toISOString()): Fixture {
  const byId = new Map(review.map((r) => [r.id, r])); // the last line per id wins: a redone error follows its error line
  const f: Fixture = {
    generated,
    origin: "the dogfood brain on the maintainer's machine, every thought it held, labelled whole (SMD-1951)",
    note,
    kinds: {}, parts: {}, status: {}, source_kind: {}, first_pass: {}, first_pass_confidence: {}, first_pass_status: {},
  };
  const seen = new Set<string>();
  for (const l of labels) {
    if (seen.has(l.id)) throw new Error(`${l.id} is labelled twice`);
    seen.add(l.id);
    const r = byId.get(l.id);
    if (!r) throw new Error(`${l.id} has a hand label and no review line — label from the brain, not from memory`);
    if (!(KINDS as readonly string[]).includes(l.kind)) throw new Error(`${l.id}: kind ${l.kind} is not a candidate`);
    push(f.kinds, l.kind, l.id);
    push(f.source_kind, r.source_kind, l.id);
    for (const p of l.parts ?? []) push(f.parts, p, l.id);
    const status = l.status ?? (l.kind === "plan" ? r.ticket_status ?? undefined : undefined);
    if (status) push(f.status, status, l.id);
    if (r.first_pass) {
      push(f.first_pass, r.first_pass.kind, l.id);
      if (r.first_pass.confidence) push(f.first_pass_confidence, r.first_pass.confidence, l.id);
      if (r.first_pass.status) push(f.first_pass_status, r.first_pass.status, l.id);
    }
  }
  for (const m of [f.kinds, f.parts, f.status, f.source_kind, f.first_pass, f.first_pass_confidence, f.first_pass_status]) for (const ids of Object.values(m)) ids.sort();
  return f;
}

// ── Reporting ────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string { return d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`; }

function table(header: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

/** Agreement of a guess map with the hand kinds: overall, and per hand kind (recall) / per guessed kind (precision). */
function agreement(kindOf: Map<string, string>, guessOf: Map<string, string>): { n: number; agree: number; perKind: Map<string, { n: number; agree: number; guessed: number; right: number }> } {
  const perKind = new Map<string, { n: number; agree: number; guessed: number; right: number }>();
  const at = (k: string) => { let e = perKind.get(k); if (!e) { e = { n: 0, agree: 0, guessed: 0, right: 0 }; perKind.set(k, e); } return e; };
  let n = 0, agree = 0;
  for (const [id, g] of guessOf) {
    const k = kindOf.get(id);
    if (!k) continue;
    n++;
    at(k).n++;
    at(g).guessed++;
    if (g === k) { agree++; at(k).agree++; at(k).right++; }
  }
  return { n, agree, perKind };
}

// ── Modes ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && !args[i + 1]?.startsWith("--") ? args[i + 1] : undefined; };
const flag2 = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && !args[i + 2]?.startsWith("--") ? args[i + 2] : undefined; };

function selfCheck(): void {
  let failed = 0;
  const ok = (cond: boolean, what: string) => { if (!cond) { failed++; console.error(`  FAIL ${what}`); } };
  const A = "10000000-0000-4000-8000-000000000001", B = "10000000-0000-4000-8000-000000000002", C = "10000000-0000-4000-8000-000000000003";
  const sound: Fixture = {
    generated: "2026-09-22T00:00:00Z", origin: "probe", note: "probe",
    kinds: { plan: [A], lesson: [B], compound: [C] },
    parts: { observation: [C], decision: [C] },
    status: { done: [A] },
    source_kind: { linear_issue: [A], agent_capture: [B, C] },
    first_pass: { plan: [A, B], lesson: [C] },
    first_pass_confidence: { high: [A], low: [B] },
    first_pass_status: { done: [A], open: [B] },
  };
  ok(validateFixture(sound).length === 0, `a sound fixture validates: ${validateFixture(sound).join("; ")}`);
  // Each mutant names the problem text the rule it targets emits, on an id no
  // neighbouring rule would also catch — review pass 3 found three probes whose
  // rule could be deleted with the check still green, because another rule
  // fired on the same id (a plan's status, a source with no kind).
  const mutants: [string, (f: Fixture) => void, string][] = [
    ["an id under two kinds", (f) => { f.kinds.observation = [B]; }, "is under both"],
    ["a kind off the list", (f) => { f.kinds.task = [B]; f.kinds.lesson = []; }, "not a candidate kind"],
    ["a plan with no status", (f) => { f.status = {}; }, "needs a status"],
    ["a status on a kind that carries none", (f) => { f.status.open = [B]; }, "carries no status"],
    ["a status a kind does not take", (f) => { f.status = { resolved: [A] }; }, "not one of"],
    ["a compound with one part", (f) => { f.parts = { observation: [C] }; }, "at least two"],
    ["a part named twice", (f) => { f.parts = { observation: [C, C] }; }, "twice"],
    ["parts that are not an array", (f) => { (f.parts as Record<string, unknown>).observation = 1; }, "not an array"],
    ["parts on a non-compound", (f) => { f.parts.observation.push(B); }, "only a compound has parts"],
    ["a kind with no source", (f) => { f.source_kind = { linear_issue: [A], agent_capture: [B] }; }, "no source_kind"],
    ["a source with no kind", (f) => { f.source_kind.agent_capture.push("10000000-0000-4000-8000-000000000009"); }, "source_kind and no kind"],
    ["a first pass for an unlabelled id", (f) => { f.first_pass.plan.push("10000000-0000-4000-8000-000000000009"); }, "no hand label"],
    ["a band with no first pass", (f) => { f.first_pass_confidence.low.push("10000000-0000-4000-8000-000000000004"); }, "band and no first-pass kind"],
    ["a first-pass status a kind does not take", (f) => { f.first_pass_status = { done: [A], resolved: [B] }; }, "not one of"],
    ["a first-pass status on a kind that carries none", (f) => { f.first_pass_status.open.push(C); }, "carries no status"],
    ["a non-id value", (f) => { f.first_pass_confidence.high.push("a leaked thought body"); }, "non-id"],
    ["an empty kind", (f) => { f.kinds.observation = []; }, "is empty"],
    ["an upper-cased id", (f) => { f.status.done = ["1000000A-0000-4000-8000-00000000000A"]; }, "upper-cased"],
    ["an id listed twice under one key", (f) => { f.first_pass.plan.push(A); }, "twice"],
    ["a non-id part", (f) => { f.parts.observation.push("a leaked thought body"); }, "non-id"],
    ["an empty part list", (f) => { f.parts.decision = []; }, "parts.decision is empty"],
    ["an upper-cased part id", (f) => { f.parts.observation.push("1000000A-0000-4000-8000-00000000000A"); }, "parts.observation carries an upper-cased id"],
    ["a bare note", (f) => { f.note = " "; }, "note is missing"],
  ];
  for (const [why, mutate, expect] of mutants) {
    const f = JSON.parse(JSON.stringify(sound)) as Fixture;
    mutate(f);
    const problems = validateFixture(f);
    ok(problems.some((p) => p.includes(expect)), `the shape rules catch ${why} with "${expect}" (got: ${problems.join("; ") || "nothing"})`);
  }
  ok(sourceKindOf("SMD-1494 — bench-hnsw.ts: size the workers\nProject: Open Brain — Benchmarking & Scale · Status: Backlog (backlog) · Priority: Low\nhttps://…\n\n## Problem\n") === "linear_issue", "an imported issue is recognised by its two-line head");
  ok(sourceKindOf("Project: Open Brain — Wiki Pages & External Sync\nInitiative: …") === "linear_project", "a project record is recognised");
  ok(sourceKindOf("SMD-1806 slice 1 (the stable tier) is DONE — PR #103") === "agent_capture", "a capture that starts with a ticket id is not an import");
  ok(ticketStatusOf("SMD-1 — t\nProject: P · Status: Done (completed) · Priority: Low\n") === "done", "completed → done");
  ok(ticketStatusOf("SMD-1 — t\nProject: P · Status: In Review (started) · Priority: Low\n") === "open", "started → open");
  ok(ticketStatusOf("SMD-1 — t\nProject: P · Status: Canceled (canceled) · Priority: Low\n") === "canceled", "canceled → canceled");
  ok(ticketStatusOf("Lesson from a review") === undefined, "no status line → undefined");
  ok(ticketStatusOf("Lesson from a review that quotes a ticket head:\nProject: P · Status: Done (completed) · Priority: Low\n") === undefined, "a status line quoted inside a capture is not the capture's status");
  ok(ticketStatusOf("SMD-1 — t\nProject: P · Status: Done · Priority: Low\n\nSupersedes:\nProject: Q · Status: Done (completed) · Priority: Low\n") === undefined, "a head without the state type does not take one from a ticket quoted below it");
  const v = parseVerdict(JSON.stringify({ kind: "Plan", status: "Done", confidence: "high" }));
  ok("kind" in v && v.kind === "plan" && v.status === "done" && v.confidence === "high", "a verdict parses, case-folded");
  ok("error" in parseVerdict(JSON.stringify({ kind: "task", confidence: "high" })), "a kind off the list is an error, not a coercion");
  const off = parseVerdict(JSON.stringify({ kind: "plan", status: "backlog", confidence: "high" }));
  ok("kind" in off && off.kind === "plan" && off.status === null, "a status the kind does not take is dropped and the kind stands");
  const l = parseVerdict(JSON.stringify({ kind: "lesson", status: "done", confidence: "high" }));
  ok("kind" in l && l.status === null, "a status on a kind that carries none is dropped");
  ok("kind" in parseVerdict(JSON.stringify({ kind: "lesson" })) && (parseVerdict(JSON.stringify({ kind: "lesson" })) as Verdict).confidence === null, "a missing band is none, not low");
  ok((parseVerdict(JSON.stringify({ kind: "lesson", confidence: "very" })) as Verdict).confidence === null, "a band off the list is none");
  const built = buildFixture(
    [{ id: A, kind: "plan" }, { id: B, kind: "lesson" }, { id: C, kind: "compound", parts: ["observation", "decision"] }],
    [
      { id: A, legacy_type: "task", source_kind: "linear_issue", ticket_status: "done", first_pass: { kind: "plan", status: "done", confidence: "high" }, error: null },
      { id: B, legacy_type: "observation", source_kind: "agent_capture", ticket_status: null, first_pass: { kind: "plan", status: "open", confidence: null }, error: null },
      { id: C, legacy_type: "task", source_kind: "agent_capture", ticket_status: null, first_pass: null, error: "timeout" },
    ], "probe", "2026-09-22T00:00:00Z");
  const flat = (m: Record<string, string[]>) => Object.values(m).flat();
  ok(validateFixture(built).length === 0, `buildFixture builds a sound fixture: ${validateFixture(built).join("; ")}`);
  ok(built.status.done?.[0] === A, "buildFixture: the ticket's own status fills a plan with no hand status");
  ok(!flat(built.first_pass).includes(C), "buildFixture: an unanswered id has no first pass");
  ok(built.first_pass_status.done?.[0] === A && built.first_pass_status.open?.[0] === B, "buildFixture: the first pass's status is kept");
  ok(!flat(built.first_pass_confidence).includes(B), "buildFixture: an absent band is not invented");
  ok(built.source_kind.linear_issue?.[0] === A && built.source_kind.agent_capture?.includes(B), "buildFixture: the source kind comes from the review line");
  {
    // The resume after a run killed mid-append: the torn tail is trimmed, the
    // next line lands whole, and the file reads clean from then on.
    const dir = mkdtempSync(join(tmpdir(), "thought-kinds-"));
    const p = join(dir, "review.jsonl");
    writeFileSync(p, JSON.stringify({ id: A }) + "\n" + '{"id":"' + B + '","legacy_ty');
    ok(trimTornTail(p) === true, "a torn last line is trimmed before the resume appends");
    appendFileSync(p, JSON.stringify({ id: B }) + "\n");
    ok(readJsonl<{ id: string }>(p).map((l) => l.id).join(",") === `${A},${B}`, "the line appended after a torn tail reads back whole, on its own line");
    ok(trimTornTail(p) === false, "a terminated file is left alone");
    ok(!existsSync(join(dir, "none.jsonl")) && trimTornTail(join(dir, "none.jsonl")) === false, "no file, nothing to trim");
    rmSync(dir, { recursive: true, force: true });
  }
  let threw = false;
  try { buildFixture([{ id: A, kind: "plan" }], [], "probe"); } catch { threw = true; }
  ok(threw, "buildFixture refuses a label with no review line");
  if (existsSync(FIXTURE_PATH)) {
    const problems = validateFixture(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture);
    ok(problems.length === 0, `the committed fixture is sound: ${problems.slice(0, 5).join("; ")}`);
  }
  console.log(failed ? `self-check: ${failed} FAILED` : "self-check: OK");
  process.exit(failed ? 1 : 0);
}

function requireUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set — this eval reads the LIVE brain, not a throwaway; point it at the dogfood database."); process.exit(2); }
  return url;
}

type Row = { id: string; content: string; metadata: Record<string, unknown> };

async function label(out: string): Promise<void> {
  const sql = new SQL({ url: requireUrl(), max: 1 });
  // Resume: an id with an answered line is done; an id whose only lines
  // recorded an error is redone and its new line appended (review pass 3 —
  // before this every existing line counted, errors included; pass 4 dropped
  // the rewrite of the file that did the dropping, a truncate-and-write of
  // hours of model time). The freeze reads the LAST line per id.
  trimTornTail(out);
  const done = new Set(readJsonl<ReviewLine>(out).filter((l) => l.first_pass !== null).map((l) => l.id));
  const limit = Number(flag("limit") ?? 0);
  const rows = await sql`SELECT id::text, content, metadata FROM thoughts ORDER BY created_at, id` as Row[];
  const todo = rows.filter((r) => !done.has(r.id)).slice(0, limit || undefined);
  console.error(`${rows.length} thoughts, ${done.size} already in ${out}, ${todo.length} to label`);
  let i = 0, errors = 0;
  const t0 = Date.now();
  for (const r of todo) {
    const v = await classify(r.content, r.metadata);
    const source_kind = sourceKindOf(r.content);
    const line: ReviewLine = {
      id: r.id,
      legacy_type: typeof r.metadata.type === "string" ? r.metadata.type : null,
      source_kind,
      ticket_status: ticketStatusOf(r.content) ?? null,
      first_pass: "kind" in v ? v : null,
      error: "error" in v ? v.error : null,
    };
    if (line.error) errors++;
    appendFileSync(out, JSON.stringify(line) + "\n");
    i++;
    if (i % 10 === 0 || i === todo.length) console.error(`  ${i}/${todo.length} (${errors} errors, ${((Date.now() - t0) / 1000 / i).toFixed(1)} s each)`);
  }
  await sql.end();
}

function freeze(labelsPath: string, reviewPath: string): void {
  const labels = readJsonl<HandLabel>(labelsPath);
  const review = readJsonl<ReviewLine>(reviewPath);
  const note = flag("note");
  if (!note) { console.error("--freeze needs --note \"who labelled, when, and how\" — the fixture says so in its own words."); process.exit(2); }
  const f = buildFixture(labels, review, note);
  const problems = validateFixture(f);
  if (problems.length) { console.error(`refusing to write an unsound fixture:\n  ${problems.join("\n  ")}`); process.exit(1); }
  const out = flag("out") ?? FIXTURE_PATH;
  writeFileSync(out, JSON.stringify(f, null, 2) + "\n");
  const unread = new Set(review.filter((r) => !labels.some((l) => l.id === r.id)).map((r) => r.id)).size;
  console.log(`wrote ${out}: ${labels.length} labelled ids, ${Object.keys(f.kinds).length} kinds${unread ? `; ${unread} review lines have NO hand label and were left out` : ""}`);
}

async function score(): Promise<void> {
  const f = readFixture(flag("fixture"));
  const problems: string[] = [];
  const kindOf = invert(f.kinds, "kinds", problems);
  const sourceOf = invert(f.source_kind, "source_kind", problems);
  const statusOf = invert(f.status, "status", problems);
  const firstOf = invert(f.first_pass, "first_pass", problems);
  const bandOf = invert(f.first_pass_confidence, "first_pass_confidence", problems);
  const fpStatusOf = invert(f.first_pass_status, "first_pass_status", problems);
  const ids = [...kindOf.keys()];

  const sql = new SQL({ url: requireUrl(), max: 1 });
  // Bun binds a JS array as an IN list, not as a Postgres array literal, so
  // `= ANY($1::uuid[])` is a malformed-array error; `IN ${sql(ids)}` is the form.
  const rows = await sql`SELECT id::text, content, metadata FROM thoughts WHERE id::text IN ${sql(ids)}` as Row[];
  const live = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !live.has(id));
  // Every section scores the rows still in the brain (review pass 5: only the
  // shipped-type table filtered on `live`; the distribution, the first pass and
  // the status table counted deleted rows, and "unanswered" could go negative).
  const here = (list: string[]) => list.filter((id) => live.has(id));
  const liveKindOf = new Map([...kindOf].filter(([id]) => live.has(id)));
  const out: string[] = [];
  out.push(`# thought kinds — ${f.origin}`, "", `Fixture generated ${f.generated}. ${f.note}`, "");
  out.push(`${ids.length} labelled thoughts; ${live.size} still in the brain${missing.length ? `, **${missing.length} gone since** (deleted or re-captured; scored on the ${live.size})` : ""}.`, "");

  // 1. Distribution: kind × source, and the status axis.
  const kinds = [...KINDS].filter((k) => f.kinds[k]?.length);
  const sources = [...SOURCE_KINDS].filter((s) => f.source_kind[s]?.length);
  out.push("## Distribution", "", table(
    ["kind", ...sources, "total", "share", "status"],
    kinds.map((k) => {
      const mine = here(f.kinds[k]);
      const bySource = sources.map((s) => mine.filter((id) => sourceOf.get(id) === s).length);
      const st = STATUS_OF[k];
      const statusCells = st ? st.map((s) => `${s} ${mine.filter((id) => statusOf.get(id) === s).length}`).join(", ") : "—";
      return [k, ...bySource, mine.length, pct(mine.length, live.size), statusCells];
    }),
  ), "");
  const compounds = here(f.kinds.compound ?? []);
  if (compounds.length) {
    const partCounts = Object.entries(f.parts).map(([p, pid]) => `${p} ${here(pid).length}`).join(", ");
    out.push(`${compounds.length} compound(s) contain: ${partCounts}.`, "");
  }

  // 2. The shipped five against the kind.
  const legacyOf = new Map<string, string>();
  for (const [id, r] of live) legacyOf.set(id, typeof r.metadata.type === "string" ? r.metadata.type : "(none)");
  const legacyCols = [...LEGACY_TYPES, "(none)"].filter((t) => [...legacyOf.values()].includes(t));
  let slotted = 0, slotRight = 0, noSlot = 0;
  out.push("## The shipped `type` against the kind", "", table(
    ["kind", ...legacyCols, "expected", "right"],
    kinds.map((k) => {
      const mine = here(f.kinds[k]);
      const counts = legacyCols.map((t) => mine.filter((id) => legacyOf.get(id) === t).length);
      const exp = LEGACY_OF[k];
      if (!exp) { noSlot += mine.length; return [k, ...counts, "*no slot*", "—"]; }
      const right = mine.filter((id) => legacyOf.get(id) === exp).length;
      slotted += mine.length; slotRight += right;
      return [k, ...counts, exp, `${right}/${mine.length}`];
    }),
  ), "");
  out.push(`Where a kind has a slot in the five, the shipped type is right for **${slotRight}/${slotted}** (${pct(slotRight, slotted)}). **${noSlot}/${live.size}** (${pct(noSlot, live.size)}) of the brain is a kind the five have no slot for, so its type is wrong whatever it says.`, "");

  // 3. The frozen first pass.
  const reportPass = (title: string, guessOf: Map<string, string>, bands?: Map<string, string>) => {
    const a = agreement(liveKindOf, guessOf);
    out.push(`## ${title}`, "", `Agrees with the hand label on **${a.agree}/${a.n}** (${pct(a.agree, a.n)}); ${live.size - a.n} unanswered.`, "");
    out.push(table(
      ["kind", "hand", "model agreed (recall)", "model said", "of which right (precision)"],
      [...KINDS].filter((k) => a.perKind.get(k)).map((k) => { const e = a.perKind.get(k)!; return [k, e.n, `${e.agree} (${pct(e.agree, e.n)})`, e.guessed, `${e.right} (${pct(e.right, e.guessed)})`]; }),
    ), "");
    if (bands) {
      const answered = [...guessOf.keys()].filter((id) => liveKindOf.has(id));
      const unbanded = answered.filter((id) => !bands.has(id)).length;
      out.push(table(["band", "n", "agreed"], CONFIDENCE.map((b) => {
        const inBand = answered.filter((id) => bands.get(id) === b);
        const right = inBand.filter((id) => guessOf.get(id) === kindOf.get(id)).length;
        return [b, inBand.length, `${right} (${pct(right, inBand.length)})`];
      })), unbanded ? `${unbanded} answer(s) gave no usable band.` : "", "");
    }
  };
  reportPass("First pass, frozen in the fixture", firstOf, bandOf);
  // Where the model named the kind and that kind carries a status, did it read
  // the status too? Per kind, from the frozen first_pass_status map.
  {
    const rows: (string | number)[][] = [];
    for (const k of Object.keys(STATUS_OF) as Kind[]) {
      const both = here(ids).filter((id) => kindOf.get(id) === k && firstOf.get(id) === k);
      if (!both.length) continue;
      const right = both.filter((id) => statusOf.get(id) !== undefined && fpStatusOf.get(id) === statusOf.get(id)).length;
      const none = both.filter((id) => !fpStatusOf.has(id)).length;
      rows.push([k, both.length, `${right} (${pct(right, both.length)})`, none]);
    }
    if (rows.length) out.push("Where the model named the kind and the kind carries a status:", "", table(["kind", "both said", "status agreed", "model gave none"], rows), "");
  }

  // 4. The same model, now.
  if (!has("frozen")) {
    const cfg = resolveEmbedConfig(process.env as EmbedEnv);
    const guessOf = new Map<string, string>(); const bands = new Map<string, string>();
    let i = 0, errors = 0;
    const t0 = Date.now();
    for (const [id, r] of live) {
      const v = await classify(r.content, r.metadata);
      if ("kind" in v) { guessOf.set(id, v.kind); if (v.confidence) bands.set(id, v.confidence); } else errors++;
      if (++i % 25 === 0) console.error(`  ${i}/${live.size} (${errors} errors, ${((Date.now() - t0) / 1000 / i).toFixed(1)} s each)`);
    }
    reportPass(`Re-run now: ${cfg.metadataModel} at temperature ${cfg.metadataTemperature}`, guessOf, bands);
    const drift = [...guessOf].filter(([id, g]) => firstOf.has(id) && firstOf.get(id) !== g).length;
    out.push(`${drift} answer(s) differ from the frozen first pass; ${errors} call(s) failed.`, "");
  }
  await sql.end();
  console.log(out.join("\n"));
}

if (import.meta.main) {
  loadEnv();
  if (has("self-check")) selfCheck();
  else if (has("label")) await label(flag("label") ?? "/tmp/thought-kinds-review.jsonl");
  else if (has("freeze")) freeze(flag("freeze") ?? "", flag2("freeze") ?? "");
  else await score();
}
