#!/usr/bin/env bun
/**
 * eval-jev-gate.ts — SMD-1937: does a typed-decision gate after the entity
 * extractor beat the deterministic one on the cases a regex cannot judge?
 *
 * SMD-2050's slice ran one framing against the tier and got a negative first
 * number (AUROC 0.509 between migration numbers and frequent tools). That set
 * held the obvious cases, which SMD-1935's regex already gets right, and a weak
 * positive label. SMD-1937's Verify asks something else: a margin over the
 * deterministic gate on the AMBIGUOUS cases, Brier/ECE for the calibrated arms,
 * a threshold on the stored confidence (SMD-1925), a drop-the-mechanism control
 * and the cost at real volume. This harness measures those. It builds nothing
 * into the extraction path, and it writes nothing to the brain (each read is one
 * READ ONLY transaction). It calls the tier through server-portable/jev.ts and
 * holds no serving code of its own.
 *
 * Pre-registered before the grade and before any tier call on the graded set
 * (the commit that adds this docblock comes before the one that adds the grades):
 *
 *   baselines  B0 = NUMERIC_NAME_RE (entities.ts), SMD-1935's rule. B1 = B0,
 *              plus a type-vocabulary word minted as an entity (SMD-1982's
 *              grading found them), plus a `person` or `place` whose name has
 *              an identifier's shape: a package or path, a ticket id, a host,
 *              domain or file, snake_case or a glob, a host:port. B1 is the whole
 *              deterministic gate as SMD-1935 words it. It is fixed here and not
 *              tuned on the grades.
 *   set        the dogfood mentions whose name passes B0: every `person`,
 *              `place` and `organization` entity, plus 50 each of `tool`,
 *              `topic` and `project` by md5 of the entity id. One mention each,
 *              the entity's first thought, and a window of it around the name.
 *              Two Claude graders label each mention blind (no tier output, no
 *              baseline verdict), against the extraction prompt's own rules:
 *              valid (a specific named thing of a defensible type) and the
 *              defensible type, or none. A disagreement is adjudicated. Both raw
 *              grades are kept in the fixture, so kappa can be recomputed.
 *   split      dev or test by md5 of the thought id. Threshold, temperature and
 *              arm are chosen on dev and reported on test.
 *   margin     on test, the chosen arm's balanced accuracy at rejecting an
 *              invalid mention must beat B1's by 10 points, with the paired
 *              bootstrap's 95% interval of the difference above 0. For typing,
 *              the per-type gates must beat the extractor's own type by 10
 *              points on the valid mentions.
 *
 * The arms, on whatever serves ob1-jev/1 (Verdict v1.4 today; SemIf is SMD-2052):
 *
 *   v1        SMD-2050's framing: "X" is the name of a specific tool, project,
 *             person, organization or place.
 *   v2        validity in the extraction prompt's own words: specific, named,
 *             not a generic word, a role or a number.
 *   claim     the extractor's own claim as one binary: in this note, "X" is
 *             <the definition of the type it chose>.
 *   pertype   SMD-1937's form 2, six binaries "X" is <definition of T>. The
 *             keep score is the highest, the type is its argmax. `claim` is the
 *             one of the six at the extractor's type, so it costs nothing extra.
 *   choice    SMD-2050's choice over the six types plus "a number, version,
 *             port or address" and "a generic word or role". The keep score is
 *             the six types' total.
 *   extractor the confidence the extractor stored (SMD-1925's column), for the
 *             threshold table: is it a signal at all?
 *
 * Every arm gives a score on the logit scale and the probability the tier
 * served. A calibration refit (temperature alone, and Platt) is fitted on dev
 * and applied to test.
 *
 *   bun eval-jev-gate.ts --url postgres://…/openbrain       (or DATABASE_URL)   the report
 *   bun eval-jev-gate.ts --url … --dump-sample <file>       the grading sample as JSONL
 *   bun eval-jev-gate.ts --self-check                       the rules and the arithmetic; no tier, no database
 *
 * The report and the dump need OB1_JEV_BASE_URL (and OB1_JEV_LOCAL=1 for a
 * tier on this box); the dump needs only the database. The dump holds the
 * brain's own text. Write it outside the tree: a committed fixture holds ids
 * and numbers only (check 9). The report prints the brain's vocabulary to
 * stdout and nothing to the tree.
 */

import { SQL } from "bun";
import { loadEnv } from "./env.ts";
import { binOf, brier, ece, readGrades, reliability, type Scored } from "./eval-calibration.ts";
import { ENTITY_TYPES, NUMERIC_NAME_RE, type EntityType } from "../server-portable/entities.ts";
import { ProviderError } from "../server-portable/embed.ts";
import { INSUFFICIENT_EVIDENCE, jevDecideMany, resolveJevConfig, type JevDecision, type JevEnv, type JevResult } from "../server-portable/jev.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── The deterministic baselines (pre-registered) ─────────────────────────────

/** How entities.ts's rule reads a name: as migration 016 normalises it, NFKC and lower case. */
const normalised = (name: string) => name.normalize("NFKC").toLowerCase().trim();
const NUMERIC = new RegExp(NUMERIC_NAME_RE);

/** B0: SMD-1935's rule. A migration number, a port, an address. */
export const b0Rejects = (name: string) => NUMERIC.test(normalised(name));

/** The type vocabulary itself, minted as an entity ("person", "place"): SMD-1982's grades found them. */
export const VOCABULARY = new Set<string>([...ENTITY_TYPES, ...ENTITY_TYPES.map((t) => `${t}s`), "organisation", "organisations", "entity", "entities"]);

/**
 * An identifier's shape. SMD-1935 says a token that is an identifier
 * (`@scope/name`, `SMD-\d+`, a number, an IP or port) is never a person, and an
 * address is never a place. The paths, hosts and globs are the same rule read
 * one step wider. The step is fixed here, before the grade.
 */
export const IDENTIFIER_SHAPES: readonly [string, RegExp][] = [
  ["a package or a path", /^@?[\w.-]+\/[\w.*/-]*$/],
  ["a ticket id", /^[a-z]+-\d+$/i],
  ["a host, a domain or a file", /^[\w-]+(\.[\w-]+)+$/],
  ["snake_case or a glob", /^\S*[_*]\S*$/],
  ["a host:port", /^\S+:\d+$/],
];

/** B1: why the whole deterministic gate rejects a mention, or null to keep it with the extractor's type. */
export function b1Rejects(name: string, type: string): string | null {
  if (b0Rejects(name)) return "a number";
  if (VOCABULARY.has(normalised(name))) return "a type-vocabulary word";
  if (type === "person" || type === "place") for (const [why, re] of IDENTIFIER_SHAPES) if (re.test(name.trim())) return `a ${type} with ${why}'s shape`;
  return null;
}

// ── The grades ───────────────────────────────────────────────────────────────

/** A type as its index in ENTITY_TYPES, -1 for none: a committed fixture holds ids and numbers only (check 9). */
export type Grade = { valid: 0 | 1; type: number };
export type GradedMention = { thought: string; entity: string } & Grade & { grader_a: [0 | 1, number]; grader_b: [0 | 1, number] };
export type GateGrades = { generated: string; origin: string; note: string; mentions: GradedMention[] };

export const GATE_GRADES_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "entity-gate-grades.json");
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isType = (t: unknown) => Number.isInteger(t) && (t as number) >= -1 && (t as number) < ENTITY_TYPES.length;
const isBit = (v: unknown) => v === 0 || v === 1;

/** Every problem with a grades file, by row; empty when it is sound. A valid mention has a type; an invalid one has none. */
export function validateGateGrades(g: unknown): string[] {
  if (!g || typeof g !== "object" || Array.isArray(g)) return ["the fixture is not an object"];
  const f = g as Partial<GateGrades>;
  const out: string[] = [];
  for (const k of ["generated", "origin", "note"] as const) if (typeof f[k] !== "string" || !f[k]) out.push(`${k} is missing`);
  if (!Array.isArray(f.mentions)) return [...out, "mentions is not an array"];
  const seen = new Set<string>();
  f.mentions.forEach((m, i) => {
    if (!m || typeof m !== "object") return void out.push(`mentions[${i}] is not an object`);
    for (const k of ["thought", "entity"] as const) if (typeof m[k] !== "string" || !ID.test(m[k])) out.push(`mentions[${i}]: ${JSON.stringify(m[k])} is not a lower-case id`);
    if (!isBit(m.valid)) out.push(`mentions[${i}]: valid ${JSON.stringify(m.valid)}`);
    if (!isType(m.type)) out.push(`mentions[${i}]: type ${JSON.stringify(m.type)} is not an index`);
    else if ((m.valid === 1) !== (m.type >= 0)) out.push(`mentions[${i}]: valid ${m.valid} with type ${m.type}`);
    for (const k of ["grader_a", "grader_b"] as const) {
      const r = m[k];
      if (!Array.isArray(r) || r.length !== 2 || !isBit(r[0]) || !isType(r[1])) out.push(`mentions[${i}]: ${k} is not [valid, type]`);
    }
    const key = `${m.thought}:${m.entity}`;
    if (seen.has(key)) out.push(`mentions[${i}]: ${key} is graded twice`);
    seen.add(key);
  });
  return out;
}

export function readGateGrades(path = GATE_GRADES_PATH): GateGrades {
  const g = JSON.parse(readFileSync(path, "utf8"));
  const problems = validateGateGrades(g);
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  return g;
}

/** Cohen's kappa of two graders' labels over the same rows. */
export function kappa<T>(a: T[], b: T[]): number {
  const n = a.length;
  if (!n || n !== b.length) return NaN;
  const agree = a.filter((x, i) => x === b[i]).length / n;
  const labels = [...new Set([...a, ...b])];
  const chance = labels.reduce((s, l) => s + (a.filter((x) => x === l).length / n) * (b.filter((x) => x === l).length / n), 0);
  return chance === 1 ? 1 : (agree - chance) / (1 - chance);
}

/** dev or test, by the first hex digit of md5(thought id): half and half, fixed, and every mention of a thought on one side. */
export const splitOf = (thought: string): "dev" | "test" => (parseInt(new Bun.CryptoHasher("md5").update(thought).digest("hex")[0], 16) < 8 ? "dev" : "test");

// ── The arithmetic ───────────────────────────────────────────────────────────

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clampP = (p: number) => Math.min(1 - 1e-9, Math.max(1e-9, p));
export const logit = (p: number) => Math.log(clampP(p) / (1 - clampP(p)));

/** Mann–Whitney AUROC of scores for positives above negatives (ties count half). */
export function auroc(pos: number[], neg: number[]): number {
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return pos.length && neg.length ? wins / (pos.length * neg.length) : NaN;
}

/** Mean log loss of p = sigmoid(a·s + b) against the labels. */
function logLoss(rows: { s: number; y: 0 | 1 }[], a: number, b: number): number {
  return rows.reduce((t, r) => { const p = clampP(sigmoid(a * r.s + b)); return t - (r.y ? Math.log(p) : Math.log(1 - p)); }, 0) / rows.length;
}

/**
 * The refit, on the logit-scale score: Platt's (a, b) by Newton's method, or
 * with `slopeOnly` a temperature (b = 0, a = 1/T) by a golden-section search.
 * Both minimise log loss over the rows given (dev). Temperature keeps the order
 * of the scores and moves only how sure they sound; Platt can also shift the
 * midpoint.
 */
export function fitPlatt(rows: { s: number; y: 0 | 1 }[], slopeOnly = false): { a: number; b: number } {
  if (!rows.length) return { a: 1, b: 0 };
  if (slopeOnly) {
    let lo = 1e-3, hi = 50;
    const g = (Math.sqrt(5) - 1) / 2;
    for (let i = 0; i < 200; i++) {
      const m1 = hi - g * (hi - lo), m2 = lo + g * (hi - lo);
      if (logLoss(rows, m1, 0) < logLoss(rows, m2, 0)) hi = m2; else lo = m1;
    }
    return { a: (lo + hi) / 2, b: 0 };
  }
  // From (0, 0), where every p is 1/2 and the Hessian is well conditioned, and
  // each step halved until the loss falls: an undamped step from a confident
  // start meets saturated rows with no curvature and overshoots (measured).
  let a = 0, b = 0, loss = logLoss(rows, a, b);
  for (let i = 0; i < 100; i++) {
    let ga = 0, gb = 0, haa = 1e-9, hab = 0, hbb = 1e-9;
    for (const r of rows) {
      const p = sigmoid(a * r.s + b), w = p * (1 - p);
      ga += (p - r.y) * r.s; gb += p - r.y;
      haa += w * r.s * r.s; hab += w * r.s; hbb += w;
    }
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det, db = (haa * gb - hab * ga) / det;
    let step = 1;
    while (step > 1e-6 && !(logLoss(rows, a - step * da, b - step * db) <= loss)) step /= 2;
    if (step <= 1e-6) break;
    a -= step * da; b -= step * db;
    const next = logLoss(rows, a, b);
    if (loss - next < 1e-12) break;
    loss = next;
  }
  return { a, b };
}

/** Balanced accuracy of a keep/reject decision against validity: the mean of reject-rate on invalid and keep-rate on valid. */
export function balancedAccuracy(rows: { keep: boolean; y: 0 | 1 }[]): number {
  const inv = rows.filter((r) => r.y === 0), val = rows.filter((r) => r.y === 1);
  if (!inv.length || !val.length) return NaN;
  return (inv.filter((r) => !r.keep).length / inv.length + val.filter((r) => r.keep).length / val.length) / 2;
}

/** The threshold on p that maximises balanced accuracy over the rows (dev), the lowest on a tie. */
export function bestThreshold(rows: { p: number; y: 0 | 1 }[]): number {
  let best = 0.5, top = -1;
  for (const t of [...new Set(rows.map((r) => r.p))].sort((a, b) => a - b)) {
    const ba = balancedAccuracy(rows.map((r) => ({ keep: r.p >= t, y: r.y })));
    if (ba > top + 1e-12) { top = ba; best = t; }
  }
  return best;
}

/** A small seeded PRNG (mulberry32), so a bootstrap or a permutation reproduces. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The paired bootstrap of stat(A) − stat(B) over the same rows: the point difference and the 2.5/97.5 percentiles. */
export function pairedBootstrap<R>(rows: R[], stat: (rs: R[]) => [number, number], n = 2000, seed = 1937): { diff: number; lo: number; hi: number } {
  const [a, b] = stat(rows);
  const next = rng(seed), diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample = rows.map(() => rows[Math.floor(next() * rows.length)]);
    const [x, y] = stat(sample);
    if (Number.isFinite(x - y)) diffs.push(x - y);
  }
  diffs.sort((p, q) => p - q);
  return { diff: a - b, lo: diffs[Math.floor(0.025 * diffs.length)] ?? NaN, hi: diffs[Math.min(diffs.length - 1, Math.floor(0.975 * diffs.length))] ?? NaN };
}

/** A seeded shuffle, for the permuted-score mutant. */
export function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs], next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** The gate: keep a candidate when its score clears the threshold, with the extractor's type unless the arm names another. Off (threshold -Infinity) it is the identity. */
export function gate<C extends { type: string }>(cands: C[], scoreOf: (c: C) => number, threshold: number, typeOf: (c: C) => string = (c) => c.type): { cand: C; type: string }[] {
  return cands.filter((c) => scoreOf(c) >= threshold).map((c) => ({ cand: c, type: typeOf(c) }));
}

// ── The framings ─────────────────────────────────────────────────────────────

/** Each type as the extraction prompt defines it (entities.ts); organization and place, which it does not define, in the same words. */
export const DEFINITION: Record<EntityType, string> = {
  person: "a named human",
  organization: "a named company, team or organization",
  project: "a named piece of work",
  tool: "a named piece of software, a service, a library or a device",
  topic: "a named subject the text is about",
  place: "a named geographic place or location",
};

const CHOICE_OPTIONS = [
  ...ENTITY_TYPES.map((t) => ({ id: t, description: DEFINITION[t] })),
  { id: "number", description: "a number, version, port or network address" },
  { id: "generic", description: "a generic word or role, not a specific name" },
];

/** The decisions one candidate costs: v1, v2, the six per-type binaries (claim among them), the choice. In this order. */
export function decisionsFor(c: { name: string; context: string }): JevDecision[] {
  return [
    { kind: "binary", proposition: `"${c.name}" is the name of a specific tool, project, person, organization or place`, context: c.context },
    { kind: "binary", proposition: `"${c.name}" is a clearly identifiable, specific named entity in this note, not a generic word, a role or a number`, context: c.context },
    ...ENTITY_TYPES.map((t): JevDecision => ({ kind: "binary", proposition: `In this note, "${c.name}" is ${DEFINITION[t]}`, context: c.context })),
    { kind: "choice", question: `What is "${c.name}" in this note?`, options: CHOICE_OPTIONS, context: c.context },
  ];
}

/** A binary result's score on the logit scale at the tier's own temperature: ln P(true)/P(false). */
export function binaryScore(r: JevResult): number {
  const keys = Object.keys(r.probabilities);
  const t = keys.indexOf("true"), f = keys.indexOf("false");
  return (r.logits[t] - r.logits[f]) / r.temperature;
}

export type ArmName = "v1" | "v2" | "claim" | "pertype" | "choice" | "extractor";
export const ARMS: ArmName[] = ["v1", "v2", "claim", "pertype", "choice", "extractor"];
/** One arm's reading of one candidate: a logit-scale score, and the type it names (-1 none) when it types. */
export type Reading = { s: number; type: number | null };

/** What each arm reads from a candidate's results (in decisionsFor's order) and the extractor's stored confidence. */
export function readArms(results: JevResult[], extractorType: string, stored: number): Record<ArmName, Reading> {
  const per = ENTITY_TYPES.map((_, i) => binaryScore(results[2 + i]));
  const top = per.indexOf(Math.max(...per));
  const choice = results[8];
  const pValid = ENTITY_TYPES.reduce((s, t) => s + (choice.probabilities[t] ?? 0), 0);
  const typed = ENTITY_TYPES.map((t) => choice.probabilities[t] ?? 0);
  const at = ENTITY_TYPES.indexOf(extractorType as EntityType);
  return {
    v1: { s: binaryScore(results[0]), type: null },
    v2: { s: binaryScore(results[1]), type: null },
    claim: { s: at >= 0 ? per[at] : -Infinity, type: null },
    pertype: { s: per[top], type: top },
    choice: { s: logit(pValid), type: choice.selected === INSUFFICIENT_EVIDENCE ? -1 : typed.indexOf(Math.max(...typed)) },
    extractor: { s: logit(stored), type: null },
  };
}

// ── The brain ────────────────────────────────────────────────────────────────

export type Candidate = { thought: string; entity: string; name: string; type: string; context: string; metadata: Record<string, unknown>; stored: number };

/** One window of the thought around the first place it names the entity, else its head. */
export function windowAround(text: string, name: string, span = 400): string {
  const at = text.toLowerCase().indexOf(name.toLowerCase());
  if (at < 0) return text.slice(0, 2 * span);
  return text.slice(Math.max(0, at - span), at + name.length + span);
}

type Row = { thought: string; entity: string; name: string; entity_type: string; content: string; metadata: Record<string, unknown> | null; confidence: string | number };
const toCandidate = (r: Row): Candidate => ({ thought: r.thought, entity: r.entity, name: r.name, type: r.entity_type, context: windowAround(r.content, r.name), metadata: r.metadata ?? {}, stored: Number(r.confidence) });

/** The pre-registered sample: every person/place/organization past B0, and 50 each of the rest by md5(entity id); each entity's first mention. */
async function sample(sql: SQL): Promise<Candidate[]> {
  return sql.begin("read only", async (tx) => {
    const rows = (await tx`
      WITH firsts AS (
        SELECT DISTINCT ON (e.id) t.id::text AS thought, e.id::text AS entity, e.name, e.entity_type, t.content, t.metadata, te.confidence
        FROM ob1_entities e
        JOIN thought_entities te ON te.entity_id = e.id
        JOIN thoughts t ON t.id = te.thought_id
        WHERE e.normalized_name !~ ${NUMERIC_NAME_RE}
        ORDER BY e.id, t.created_at, t.id
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY entity_type ORDER BY md5(entity)) AS k FROM firsts
      )
      SELECT thought, entity, name, entity_type, content, metadata, confidence FROM ranked
      WHERE entity_type IN ('person', 'place', 'organization') OR k <= 50
      ORDER BY entity_type, md5(entity)
    `) as Row[];
    return rows.map(toCandidate);
  });
}

/** The graded mentions as the brain holds them now, and the ones it no longer does. */
async function graded(sql: SQL, keys: { thought: string; entity: string }[]): Promise<{ found: Candidate[]; missing: number }> {
  return sql.begin("read only", async (tx) => {
    const thoughts = keys.map((k) => k.thought), entities = keys.map((k) => k.entity);
    const rows = (await tx`
      SELECT t.id::text AS thought, e.id::text AS entity, e.name, e.entity_type, t.content, t.metadata, te.confidence
      FROM unnest(${thoughts}::uuid[], ${entities}::uuid[]) AS k(thought_id, entity_id)
      JOIN thought_entities te ON te.thought_id = k.thought_id AND te.entity_id = k.entity_id
      JOIN thoughts t ON t.id = te.thought_id
      JOIN ob1_entities e ON e.id = te.entity_id
    `) as Row[];
    return { found: rows.map(toCandidate), missing: keys.length - rows.length };
  });
}

/** SMD-1935's strong negatives, the B0 names, the most mentioned first: can an arm replace B0, or only follow it? */
async function numericCohort(sql: SQL, n: number): Promise<Candidate[]> {
  return sql.begin("read only", async (tx) => {
    const rows = (await tx`
      SELECT DISTINCT ON (e.id) t.id::text AS thought, e.id::text AS entity, e.name, e.entity_type, t.content, t.metadata, te.confidence,
             count(*) OVER (PARTITION BY e.id) AS mentions
      FROM ob1_entities e
      JOIN thought_entities te ON te.entity_id = e.id
      JOIN thoughts t ON t.id = te.thought_id
      WHERE e.normalized_name ~ ${NUMERIC_NAME_RE}
      ORDER BY e.id, t.created_at, t.id
    `) as (Row & { mentions: string })[];
    return rows.sort((a, b) => Number(b.mentions) - Number(a.mentions) || a.name.localeCompare(b.name)).slice(0, n).map(toCandidate);
  });
}

/** Whole thoughts' candidate lists, for the cost at real volume: every mention of `n` thoughts by md5, and the mentions-per-thought distribution. */
async function thoughtLists(sql: SQL, n: number): Promise<{ lists: Candidate[][]; perThought: number[] }> {
  return sql.begin("read only", async (tx) => {
    const per = (await tx`SELECT count(*) AS n FROM thought_entities GROUP BY thought_id`) as { n: string }[];
    const rows = (await tx`
      SELECT t.id::text AS thought, e.id::text AS entity, e.name, e.entity_type, t.content, t.metadata, te.confidence
      FROM thought_entities te
      JOIN thoughts t ON t.id = te.thought_id
      JOIN ob1_entities e ON e.id = te.entity_id
      WHERE te.thought_id IN (SELECT thought_id FROM (SELECT DISTINCT thought_id FROM thought_entities) d ORDER BY md5(thought_id::text) LIMIT ${n})
    `) as Row[];
    const by = new Map<string, Candidate[]>();
    for (const r of rows) (by.get(r.thought) ?? by.set(r.thought, []).get(r.thought)!).push(toCandidate(r));
    return { lists: [...by.values()], perThought: per.map((p) => Number(p.n)) };
  });
}

// ── The report ───────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const fixed = (x: number | undefined, digits: number) => (x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(digits));
const quantile = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : NaN);
const table = (header: string[], rows: (string | number)[][]) =>
  [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

type Scoredrow = { c: Candidate; g: Grade; split: "dev" | "test"; arms: Record<ArmName, Reading>; b1: string | null };

/** ECE over the deciles, the calibration harness's bins. */
const eceOf = (rows: Scored[]) => ece(reliability(rows, binOf(Infinity)));

async function report(url: string, perCohort: number, costThoughts: number) {
  const cfg = resolveJevConfig(process.env as JevEnv);
  if (!cfg) { console.error("the report needs OB1_JEV_BASE_URL (and OB1_JEV_LOCAL=1 for a tier on this box)"); process.exit(2); }
  const grades = readGateGrades();
  const second = readGrades().mentions;
  const sql = new SQL(url);
  let found: Candidate[], missing: number, numeric: Candidate[], secondFound: Candidate[], lists: Candidate[][], perThought: number[];
  try {
    ({ found, missing } = await graded(sql, grades.mentions));
    ({ found: secondFound } = await graded(sql, second));
    numeric = await numericCohort(sql, perCohort);
    ({ lists, perThought } = await thoughtLists(sql, costThoughts));
  } finally {
    await sql.close();
  }
  const gradeOf = new Map(grades.mentions.map((m) => [`${m.thought}:${m.entity}`, m]));
  const secondOf = new Map(second.map((m) => [`${m.thought}:${m.entity}`, m.outcome]));

  // Each window leaves under its own thought's metadata, so a source/type/topic
  // term the egress policy names applies to it; a refused row is counted and left out.
  const subject = (c: Candidate) => ({ kind: "decision" as const, actor: "eval-jev-gate", metadata: c.metadata });
  let refused = 0;
  const decide = async (c: Candidate) => {
    try {
      return (await jevDecideMany(cfg, decisionsFor(c), subject(c))).results;
    } catch (e) {
      if (!(e instanceof ProviderError && e.kind === "egress")) throw e;
      refused++;
      return null;
    }
  };
  const t0 = performance.now();
  const rows: Scoredrow[] = [];
  for (const c of found) {
    const results = await decide(c);
    if (!results) continue;
    const g = gradeOf.get(`${c.thought}:${c.entity}`)!;
    rows.push({ c, g, split: splitOf(c.thought), arms: readArms(results, c.type, c.stored), b1: b1Rejects(c.name, c.type) });
  }
  const secondRows: { y: 0 | 1; arms: Record<ArmName, Reading>; b1: string | null }[] = [];
  for (const c of secondFound) {
    const results = await decide(c);
    if (results) secondRows.push({ y: secondOf.get(`${c.thought}:${c.entity}`)!, arms: readArms(results, c.type, c.stored), b1: b1Rejects(c.name, c.type) });
  }
  const numericRows: Record<ArmName, Reading>[] = [];
  for (const c of numeric) { const r = await decide(c); if (r) numericRows.push(readArms(r, c.type, c.stored)); }
  const wall = performance.now() - t0;

  const dev = rows.filter((r) => r.split === "dev"), test = rows.filter((r) => r.split === "test");
  const y = (r: Scoredrow) => r.g.valid;
  console.log(`\n${grades.mentions.length} graded mentions, ${found.length} still in the brain${missing ? ` (${missing} gone)` : ""}${refused ? `, ${refused} refused by the egress policy` : ""}: ${dev.length} dev, ${test.length} test; ${test.filter((r) => r.g.valid === 0).length} of the test mentions invalid. Tier ${cfg.endpoint.base}; ${(wall / 1000).toFixed(1)} s.`);
  const a = grades.mentions.map((m) => m.grader_a), b = grades.mentions.map((m) => m.grader_b);
  console.log(`graders: agree on validity ${pct(a.filter((x, i) => x[0] === b[i][0]).length, a.length)} (kappa ${fixed(kappa(a.map((x) => x[0]), b.map((x) => x[0])), 2)}), on the type ${pct(a.filter((x, i) => x[1] === b[i][1]).length, a.length)} (kappa ${fixed(kappa(a.map((x) => x[1]), b.map((x) => x[1])), 2)})`);

  // Per arm: the refit and the threshold on dev, everything reported on test.
  const fitted = Object.fromEntries(ARMS.map((arm) => {
    const d = dev.map((r) => ({ s: r.arms[arm].s, y: y(r) })).filter((r) => Number.isFinite(r.s));
    const temp = fitPlatt(d, true), platt = fitPlatt(d);
    const pOf = (s: number) => clampP(sigmoid(platt.a * s + platt.b));
    const threshold = bestThreshold(dev.map((r) => ({ p: pOf(r.arms[arm].s), y: y(r) })));
    return [arm, { temp, platt, pOf, threshold }];
  })) as Record<ArmName, { temp: { a: number; b: number }; platt: { a: number; b: number }; pOf: (s: number) => number; threshold: number }>;

  const keepB1 = (r: { b1: string | null }) => r.b1 === null;
  const baTest = (keep: (r: Scoredrow) => boolean, rs = test) => balancedAccuracy(rs.map((r) => ({ keep: keep(r), y: y(r) })));
  const armKeep = (arm: ArmName) => (r: Scoredrow) => fitted[arm].pOf(r.arms[arm].s) >= fitted[arm].threshold;

  console.log("\nValidity on the test split (threshold, temperature and Platt fitted on dev; AUROC is the order alone):\n");
  // The served probability: the tier's p_true (or the choice's total) at its own temperature; for the extractor, its stored column.
  const served = (s: number) => clampP(sigmoid(s));
  console.log(table(
    ["arm", "AUROC", "Brier served", "ECE served", "Brier T", "Brier Platt", "ECE Platt", "threshold (dev)", "balanced accuracy", "rejects invalid", "keeps valid"],
    [
      ["B0 numeric", "—", "—", "—", "—", "—", "—", "—", fixed(baTest((r) => !b0Rejects(r.c.name)), 3), pct(test.filter((r) => !y(r) && b0Rejects(r.c.name)).length, test.filter((r) => !y(r)).length), pct(test.filter((r) => y(r) && !b0Rejects(r.c.name)).length, test.filter((r) => y(r)).length)],
      ["B1 shape", "—", "—", "—", "—", "—", "—", "—", fixed(baTest(keepB1), 3), pct(test.filter((r) => !y(r) && !keepB1(r)).length, test.filter((r) => !y(r)).length), pct(test.filter((r) => y(r) && keepB1(r)).length, test.filter((r) => y(r)).length)],
      ...ARMS.map((arm) => {
        const f = fitted[arm];
        const pos = test.filter((r) => y(r)).map((r) => r.arms[arm].s), neg = test.filter((r) => !y(r)).map((r) => r.arms[arm].s);
        const sv = test.map((r) => ({ stated: served(r.arms[arm].s), outcome: y(r) }));
        const tp = test.map((r) => ({ stated: clampP(sigmoid(f.temp.a * r.arms[arm].s)), outcome: y(r) }));
        const pl = test.map((r) => ({ stated: f.pOf(r.arms[arm].s), outcome: y(r) }));
        const keep = armKeep(arm);
        return [arm, fixed(auroc(pos, neg), 3), fixed(brier(sv), 3), fixed(eceOf(sv), 3), fixed(brier(tp), 3), fixed(brier(pl), 3), fixed(eceOf(pl), 3), fixed(f.threshold, 2), fixed(baTest(keep), 3),
          pct(test.filter((r) => !y(r) && !keep(r)).length, test.filter((r) => !y(r)).length), pct(test.filter((r) => y(r) && keep(r)).length, test.filter((r) => y(r)).length)];
      }),
    ],
  ));

  // The chosen arm: the tier arm with the best balanced accuracy on DEV.
  const tierArms = ARMS.filter((x) => x !== "extractor");
  const devBa = (arm: ArmName) => balancedAccuracy(dev.map((r) => ({ keep: armKeep(arm)(r), y: y(r) })));
  const chosen = tierArms.reduce((best, arm) => (devBa(arm) > devBa(best) ? arm : best));
  const margin = pairedBootstrap(test, (rs) => [balancedAccuracy(rs.map((r) => ({ keep: armKeep(chosen)(r), y: y(r) }))), balancedAccuracy(rs.map((r) => ({ keep: keepB1(r), y: y(r) })))]);
  const passes = margin.diff >= 0.1 && margin.lo > 0;
  console.log(`\nchosen on dev: ${chosen} (dev balanced accuracy ${fixed(devBa(chosen), 3)}). On test, ${chosen} − B1 = ${fixed(100 * margin.diff, 1)} points, 95% interval ${fixed(100 * margin.lo, 1)} to ${fixed(100 * margin.hi, 1)}: the pre-registered margin (≥ 10 points, interval above 0) is ${passes ? "MET" : "NOT met"}.`);
  const combined = pairedBootstrap(test, (rs) => [balancedAccuracy(rs.map((r) => ({ keep: keepB1(r) && armKeep(chosen)(r), y: y(r) }))), balancedAccuracy(rs.map((r) => ({ keep: keepB1(r), y: y(r) })))]);
  console.log(`B1 then ${chosen} (the deployable order) − B1 alone: ${fixed(100 * combined.diff, 1)} points, 95% interval ${fixed(100 * combined.lo, 1)} to ${fixed(100 * combined.hi, 1)}.`);

  // Typing, on the valid mentions the graders typed.
  const typedRows = test.filter((r) => r.g.valid === 1);
  const typeAcc = (typeOf: (r: Scoredrow) => number) => typedRows.filter((r) => typeOf(r) === r.g.type).length;
  const extractorType = (r: Scoredrow) => ENTITY_TYPES.indexOf(r.c.type as EntityType);
  const typing = pairedBootstrap(typedRows, (rs) => [rs.filter((r) => r.arms.pertype.type === r.g.type).length / rs.length, rs.filter((r) => extractorType(r) === r.g.type).length / rs.length]);
  console.log(`\nTyping on the ${typedRows.length} valid test mentions: the extractor ${pct(typeAcc(extractorType), typedRows.length)}, pertype ${pct(typeAcc((r) => r.arms.pertype.type!), typedRows.length)}, choice ${pct(typeAcc((r) => r.arms.choice.type!), typedRows.length)}. pertype − extractor = ${fixed(100 * typing.diff, 1)} points, 95% interval ${fixed(100 * typing.lo, 1)} to ${fixed(100 * typing.hi, 1)}: the margin (≥ 10 points, interval above 0) is ${typing.diff >= 0.1 && typing.lo > 0 ? "MET" : "NOT met"}.`);
  const confusion = ENTITY_TYPES.map((t, i) => [t, ...ENTITY_TYPES.map((_, j) => typedRows.filter((r) => r.g.type === i && extractorType(r) === j).length)]);
  console.log("\nthe graders' type (rows) against the extractor's (columns), valid test mentions:\n");
  console.log(table(["graded \\ extractor", ...ENTITY_TYPES], confusion));

  // SMD-1925: the chosen arm's calibrated P as the stored confidence — does a threshold trade precision for recall?
  console.log(`\nA stored confidence (SMD-1925): keep-at-threshold on test, ${chosen}'s P after the Platt refit, against the extractor's own column:\n`);
  const valid = test.filter((r) => y(r)).length;
  const at = (arm: ArmName, t: number) => {
    const kept = test.filter((r) => (arm === "extractor" ? r.c.stored : fitted[arm].pOf(r.arms[arm].s)) >= t);
    return [kept.length, pct(kept.filter((r) => y(r)).length, kept.length), pct(kept.filter((r) => y(r)).length, valid)];
  };
  console.log(table(["threshold", `${chosen}: kept`, "precision", "recall", "extractor: kept", "precision", "recall"], [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => [t.toFixed(1), ...at(chosen, t), ...at("extractor", t)])));
  const stored = [...new Set(test.map((r) => r.c.stored))];
  console.log(`the extractor's column takes ${stored.length} distinct value${stored.length === 1 ? "" : "s"} on the test split (${stored.sort().join(", ")})`);

  // Controls.
  const off = gate(test.map((r) => r.c), () => 0, -Infinity);
  const identity = off.length === test.length && off.every((k, i) => k.cand === test[i].c && k.type === test[i].c.type);
  console.log(`\ndrop-the-mechanism: with the gate off, ${off.length} of ${test.length} test candidates kept, every type the extractor's — ${identity ? "today's graph exactly" : "NOT the identity"}.`);
  const perm = shuffled(test.map((r) => r.arms[chosen].s), 7);
  console.log(`mutant: ${chosen}'s scores permuted across the test mentions give AUROC ${fixed(auroc(perm.filter((_, i) => y(test[i])), perm.filter((_, i) => !y(test[i]))), 3)} (unpermuted ${fixed(auroc(test.filter((r) => y(r)).map((r) => r.arms[chosen].s), test.filter((r) => !y(r)).map((r) => r.arms[chosen].s)), 3)}).`);

  // The second grader's set: SMD-1982's hand grades, the same definition, another grader.
  if (secondRows.length) {
    const sp = secondRows.filter((r) => r.y === 1), sn = secondRows.filter((r) => r.y === 0);
    console.log(`\nSMD-1982's hand-graded mentions (${secondRows.length}, ${sn.length} invalid; another grader, the same definition): AUROC ${tierArms.map((arm) => `${arm} ${fixed(auroc(sp.map((r) => r.arms[arm].s), sn.map((r) => r.arms[arm].s)), 3)}`).join(", ")}; B1 balanced accuracy ${fixed(balancedAccuracy(secondRows.map((r) => ({ keep: keepB1(r), y: r.y }))), 3)}, ${chosen} at its dev threshold ${fixed(balancedAccuracy(secondRows.map((r) => ({ keep: fitted[chosen].pOf(r.arms[chosen].s) >= fitted[chosen].threshold, y: r.y }))), 3)}.`);
  }
  // The B0 names: could an arm replace B0?
  if (numericRows.length) console.log(`\nthe ${numericRows.length} most-mentioned B0 names (all invalid): each arm at its dev threshold rejects ${tierArms.map((arm) => `${arm} ${pct(numericRows.filter((r) => fitted[arm].pOf(r[arm].s) < fitted[arm].threshold).length, numericRows.length)}`).join(", ")}; B0 100%.`);

  // Cost at real volume: a thought's whole candidate list, one request per arm shape.
  const perCand = { binary: 1, pertype: ENTITY_TYPES.length };
  const cost: Record<keyof typeof perCand, number[]> = { binary: [], pertype: [] };
  for (const list of lists) {
    for (const shape of ["binary", "pertype"] as const) {
      const ds = list.flatMap((c) => decisionsFor(c).slice(shape === "binary" ? 1 : 2, shape === "binary" ? 2 : 8));
      try {
        const t = performance.now();
        await jevDecideMany(cfg, ds, subject(list[0]));
        cost[shape].push(performance.now() - t);
      } catch (e) {
        if (!(e instanceof ProviderError && e.kind === "egress")) throw e;
      }
    }
  }
  const sizes = lists.map((l) => l.length);
  console.log(`\nCost at real volume: mentions per thought in the brain p50 ${quantile(perThought, 0.5)}, p95 ${quantile(perThought, 0.95)}, max ${Math.max(...perThought)}. Over ${lists.length} whole thoughts (${quantile(sizes, 0.5)} candidates p50), one request a thought: one binary a candidate (v2 or claim) p50 ${fixed(quantile(cost.binary, 0.5), 0)} ms, p95 ${fixed(quantile(cost.binary, 0.95), 0)} ms; the six per-type binaries p50 ${fixed(quantile(cost.pertype, 0.5), 0)} ms, p95 ${fixed(quantile(cost.pertype, 0.95), 0)} ms (per candidate ${perCand.binary} and ${perCand.pertype} decisions).`);

  // For a human: the test mentions the chosen arm and B1 disagree on, with the grade.
  console.log(`\ntest mentions where ${chosen} and B1 disagree — the extractor's type, the name, the grade, ${chosen}'s P, pertype's type:`);
  for (const r of test.filter((r) => armKeep(chosen)(r) !== keepB1(r))) {
    console.log(`  ${r.c.type.padEnd(12)} ${r.c.name.slice(0, 32).padEnd(32)} ${r.g.valid ? `valid ${ENTITY_TYPES[r.g.type]}`.padEnd(20) : "invalid".padEnd(20)} ${fixed(fitted[chosen].pOf(r.arms[chosen].s), 2)}  ${ENTITY_TYPES[r.arms.pertype.type!]}${r.b1 ? `  (B1: ${r.b1})` : ""}`);
  }
}

// ── The self-check ───────────────────────────────────────────────────────────

function selfCheck() {
  let failed = 0;
  const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };

  // B0 and B1, on the shapes SMD-1935 names and the ones it must keep.
  ok(["021", "11434", "127.0.0.1", "10 000"].every(b0Rejects) && !["pg16", "smd 1938", "Edge0"].some(b0Rejects), "B0 rejects a migration number, a port, an address and a spaced number, and keeps a name with a letter");
  const b1 = (n: string, t: string) => b1Rejects(n, t);
  ok(b1("021", "person") === "a number" && b1("Person", "topic") === "a type-vocabulary word" && b1("places", "place") === "a type-vocabulary word", "B1 rejects a number and the type vocabulary, whatever the type");
  ok(["@hono/mcp", "hono/mcp", "michaelharris/**", "SMD-1497", "host.containers.internal", "openrouter.ai", "open-brain_default", "localhost:11434"].every((n) => b1(n, "person") !== null && b1(n, "place") !== null), "B1 rejects an identifier's shape typed person or place: a package, a path, a glob, a ticket id, a host, a domain, snake_case, a host:port");
  ok(["@hono/mcp", "SMD-1497", "openrouter.ai", "db/migrate.ts"].every((n) => b1(n, "tool") === null && b1(n, "project") === null), "B1 keeps the same shapes typed tool or project: it bars only person and place (SMD-1935)");
  ok(["Nate B. Jones", "anita", "Michael Harris", "Mac mini M4 Pro", "main", "operator"].every((n) => b1(n, "person") === null && b1(n, "place") === null), "B1 keeps a name with spaces, a lower-case name and a generic word: the ambiguous cases are the gate's, not the regex's");

  // The arithmetic.
  ok(auroc([2, 3], [0, 1]) === 1 && auroc([0, 1], [2, 3]) === 0 && auroc([1], [1]) === 0.5 && Number.isNaN(auroc([], [1])), "AUROC: separated 1, reversed 0, a tie 0.5, an empty side NaN");
  ok(balancedAccuracy([{ keep: false, y: 0 }, { keep: true, y: 1 }]) === 1 && balancedAccuracy([{ keep: true, y: 0 }, { keep: true, y: 1 }, { keep: true, y: 1 }]) === 0.5 && Number.isNaN(balancedAccuracy([{ keep: true, y: 1 }])), "balanced accuracy: perfect 1, keep-everything 0.5 whatever the base rate, one class NaN");
  ok(bestThreshold([{ p: 0.2, y: 0 }, { p: 0.4, y: 0 }, { p: 0.6, y: 1 }, { p: 0.9, y: 1 }]) === 0.6, "the dev threshold is the lowest that separates");
  // A known temperature and a known Platt offset are recovered from labels drawn at them.
  const draw = rng(42);
  const synth = (a: number, b: number) => Array.from({ length: 4000 }, () => { const s = (draw() - 0.5) * 12; return { s, y: (draw() < sigmoid(a * s + b) ? 1 : 0) as 0 | 1 }; });
  const t = fitPlatt(synth(0.4, 0), true), p = fitPlatt(synth(0.4, -1));
  ok(Math.abs(t.a - 0.4) < 0.05 && t.b === 0, `a temperature is recovered (1/T = ${t.a.toFixed(3)}, drawn at 0.4)`);
  ok(Math.abs(p.a - 0.4) < 0.05 && Math.abs(p.b + 1) < 0.15, `Platt's slope and offset are recovered (${p.a.toFixed(3)}, ${p.b.toFixed(3)}; drawn at 0.4, -1)`);
  ok(kappa([1, 1, 0, 0], [1, 1, 0, 0]) === 1 && Math.abs(kappa([1, 0, 1, 0], [1, 1, 0, 0])) < 1e-12, "kappa: agreement 1, agreement at chance 0");
  const rows = Array.from({ length: 200 }, (_, i) => ({ a: i % 2 === 0, b: i % 4 === 0, y: (i % 2 === 0 ? 1 : 0) as 0 | 1 }));
  const bs = pairedBootstrap(rows, (rs) => [balancedAccuracy(rs.map((r) => ({ keep: r.a, y: r.y }))), balancedAccuracy(rs.map((r) => ({ keep: r.b, y: r.y })))]);
  ok(Math.abs(bs.diff - 0.25) < 1e-12 && bs.lo > 0 && bs.hi <= 0.5 && JSON.stringify(bs) === JSON.stringify(pairedBootstrap(rows, (rs) => [balancedAccuracy(rs.map((r) => ({ keep: r.a, y: r.y }))), balancedAccuracy(rs.map((r) => ({ keep: r.b, y: r.y })))])), `the paired bootstrap: the point difference exact, the interval around it, the same seed the same interval (${bs.lo.toFixed(3)}–${bs.hi.toFixed(3)})`);

  // The controls: the gate off is the identity; a permuted score loses its order.
  const cands = [{ type: "person", n: 1 }, { type: "tool", n: 2 }];
  const offRun = gate(cands, () => -1e9, -Infinity);
  ok(offRun.length === 2 && offRun.every((k, i) => k.cand === cands[i] && k.type === cands[i].type), "the gate off keeps every candidate with the extractor's type: today's graph exactly");
  ok(gate(cands, (c) => c.n, 2, () => "topic").length === 1 && gate(cands, (c) => c.n, 2, () => "topic")[0].type === "topic", "the gate on keeps what clears the threshold, typed as the arm says");
  const sep = Array.from({ length: 100 }, (_, i) => i), lab = sep.map((i) => i >= 50);
  const permuted = shuffled(sep, 7);
  const permAuroc = auroc(permuted.filter((_, i) => lab[i]), permuted.filter((_, i) => !lab[i]));
  ok(auroc(sep.filter((_, i) => lab[i]), sep.filter((_, i) => !lab[i])) === 1 && permAuroc > 0.3 && permAuroc < 0.7, `the mutant: a perfect score permuted falls to chance (${permAuroc.toFixed(3)})`);

  // The framings and the readings.
  const ds = decisionsFor({ name: "Bun", context: "ctx" });
  ok(ds.length === 9 && ds.slice(0, 8).every((d) => d.kind === "binary") && ds[8].kind === "choice" && ENTITY_TYPES.every((t, i) => (ds[2 + i] as { proposition: string }).proposition.endsWith(DEFINITION[t])), "a candidate costs nine decisions: v1, v2, one binary per type in ENTITY_TYPES' order, the choice");
  const bin = (lt: number, lf: number, temperature = 1): JevResult => ({ kind: "binary", probabilities: { true: 0.5, false: 0.3, [INSUFFICIENT_EVIDENCE]: 0.2 }, selected: "true", abstained: false, p_insufficient: 0.2, p_true: 0.6, logits: [lt, lf, -9], temperature, tokens: 1, truncated: false });
  ok(Math.abs(binaryScore(bin(3, 1, 2)) - 1) < 1e-12, "a binary score is (true − false) / the tier's temperature, read by key");
  const choice: JevResult = { kind: "choice", probabilities: { person: 0.05, organization: 0.05, project: 0.1, tool: 0.4, topic: 0.1, place: 0, number: 0.2, generic: 0.05, [INSUFFICIENT_EVIDENCE]: 0.05 }, selected: "tool", abstained: false, p_insufficient: 0.05, logits: [], temperature: 1, tokens: 1, truncated: false };
  const per = [0, 0, 0, 5, 1, 0];
  const read = readArms([bin(0, 0), bin(2, 0), ...per.map((s) => bin(s, 0)), choice], "topic", 1);
  ok(read.pertype.type === ENTITY_TYPES.indexOf("tool") && read.pertype.s === 5 && read.claim.s === 1 && Math.abs(read.choice.s - logit(0.7)) < 1e-9 && read.choice.type === ENTITY_TYPES.indexOf("tool") && read.v2.s === 2, "the readings: pertype's argmax and max, claim at the extractor's type, choice's keep score as the six types' total");
  ok(readArms([bin(0, 0), bin(0, 0), ...per.map((s) => bin(s, 0)), choice], "not-a-type", 1).claim.s === -Infinity, "a claim for a type off the vocabulary scores as a reject");

  // The grades: the shape, and the committed file when it is there.
  const A = "10000000-0000-4000-8000-000000000001", B = "10000000-0000-4000-8000-000000000002";
  const good = { generated: "g", origin: "o", note: "n", mentions: [{ thought: A, entity: B, valid: 1, type: 3, grader_a: [1, 3], grader_b: [1, 2] }] };
  ok(validateGateGrades(good).length === 0, "a sound grades file validates");
  const bad = validateGateGrades({ ...good, note: "", mentions: [{ ...good.mentions[0], valid: 0 }, { ...good.mentions[0], type: 6 }, { ...good.mentions[0], entity: "x" }, { ...good.mentions[0], grader_a: [1] }, null] });
  const expect = ["note is missing", "mentions[0]: valid 0 with type 3", "mentions[1]: type 6 is not an index", "mentions[1]: ", "is graded twice", `mentions[2]: "x" is not a lower-case id`, "mentions[3]: grader_a is not [valid, type]", "mentions[4] is not an object"];
  ok(expect.every((e) => bad.some((p) => p.includes(e))), `a missing label, an invalid row with a type, a type off the vocabulary, a duplicate, a bad id, a grader's label of the wrong shape and a row that is not an object are refused by name (${bad.length})`);
  ok(splitOf(A) === splitOf(A) && ["dev", "test"].includes(splitOf(B)), "the split is a function of the thought id");
  if (existsSync(GATE_GRADES_PATH)) {
    const g = readGateGrades();
    const n = g.mentions.length, dev = g.mentions.filter((m) => splitOf(m.thought) === "dev").length;
    ok(n > 0 && dev > 0 && dev < n, `the committed grades validate and fall on both sides of the split (${dev} dev of ${n})`);
    ok(g.mentions.every((m) => m.valid === m.grader_a[0] || m.valid === m.grader_b[0]), "every adjudicated validity is one grader's: adjudication picks, it does not invent");
  }

  if (failed) { console.error(`self-check: ${failed} FAILED`); process.exit(1); }
  console.log("self-check: OK");
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  loadEnv();
  const arg = (flag: string) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
  if (process.argv.includes("--self-check")) selfCheck();
  else {
    const url = arg("--url") ?? process.env.DATABASE_URL;
    const perCohort = Number(arg("--per-cohort") ?? 60), costThoughts = Number(arg("--cost-thoughts") ?? 20);
    if (!url || !Number.isInteger(perCohort) || perCohort < 1 || !Number.isInteger(costThoughts) || costThoughts < 1) {
      console.error("usage: bun eval-jev-gate.ts --url postgres://… [--per-cohort 60] [--cost-thoughts 20] | --dump-sample <file> | --self-check");
      process.exit(2);
    }
    const dump = arg("--dump-sample");
    if (dump) {
      const sql = new SQL(url);
      try {
        const cands = await sample(sql);
        await Bun.write(dump, cands.map((c) => JSON.stringify({ thought: c.thought, entity: c.entity, name: c.name, type: c.type, context: c.context })).join("\n") + "\n");
        console.log(`${cands.length} mentions to ${dump}: ${ENTITY_TYPES.map((t) => `${cands.filter((c) => c.type === t).length} ${t}`).join(", ")}`);
      } finally {
        await sql.close();
      }
    } else await report(url, perCohort, costThoughts);
  }
}
