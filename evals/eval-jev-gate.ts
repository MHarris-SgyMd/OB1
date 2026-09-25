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
 * and the cost at real volume. This harness measures those; the control is
 * `gate()`'s identity when off, which the self-check holds. It builds nothing
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
 *   rubric v2  NOT pre-registered: after the first result, on the maintainer's
 *              call, the grades were redone (entity-gate-grades-v2.json) at
 *              the entity level (up to three of its mentions, not the first
 *              alone), with a role that points at one person counted as that
 *              person, and each mention given a category — a code artifact
 *              counts as a tool, or as junk with --strict-code. The verdict
 *              above stays on rubric v1; v2 is reported beside it.
 *   margin     on test, the chosen arm's balanced accuracy at rejecting an
 *              invalid mention must beat B1's by 10 points, with the paired
 *              bootstrap's 95% interval of the difference above 0. For typing,
 *              the per-type gates must beat the extractor's own type by 10
 *              points on the valid mentions (the report also prints the
 *              interval, which the typing margin does not require).
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
 *   bun eval-jev-gate.ts --url postgres://…/openbrain [--cache <file>] [--numeric 60] [--cost-thoughts 40, 0 to skip]
 *                        [--grades fixtures/entity-gate-grades-v2.json [--strict-code]]
 *   bun eval-jev-gate.ts --url … --diagnose [--cache <file>]   why the tier fails: the name read or not, the length, the labels, the graph
 *                                                   the report (or DATABASE_URL for --url)
 *   bun eval-jev-gate.ts --url … --dump-sample <file>       the grading sample as JSONL
 *   bun eval-jev-gate.ts --self-check                       the rules and the arithmetic; no tier, no database
 *
 * The report needs OB1_JEV_BASE_URL (and OB1_JEV_LOCAL=1 for a tier on this
 * box); the dump needs only the database. The dump holds the brain's own text.
 * Write it outside the tree: a committed fixture holds ids and numbers only
 * (check 9). `--cache` keeps the tier's answers (probabilities and logits, no
 * text) keyed by the model's provenance and what was asked, so a re-analysis
 * asks the tier again only for /info and the timed thoughts, and another model
 * is asked afresh. `--numeric` sizes the B0 cohort, `--cost-thoughts` the
 * thoughts timed whole (0 skips the timing). The report prints the brain's
 * vocabulary to stdout and nothing to the tree.
 */

import { SQL } from "bun";
import { loadEnv } from "./env.ts";
import { binOf, brier, ece, readGrades, reliability, skill, type Scored } from "./eval-calibration.ts";
import { ENTITY_TYPES, NUMERIC_NAME_RE, type EntityType } from "../server-portable/entities.ts";
import { ProviderError } from "../server-portable/embed.ts";
import { INSUFFICIENT_EVIDENCE, jevDecideMany, jevInfo, resolveJevConfig, type JevConfig, type JevDecision, type JevEnv, type JevModelInfo, type JevOption, type JevResult } from "../server-portable/jev.ts";
import { JEV_MAX_BATCH } from "../server-portable/jev-contract.ts";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── The deterministic baselines (pre-registered) ─────────────────────────────

/**
 * How B0 reads a name: NFKC, lower case, trimmed. Migration 016's
 * normalize_entity_name also folds `-_/\#` to spaces and strips outer
 * punctuation; for NUMERIC_NAME_RE a match here implies a match there, and the
 * vocabulary and shapes read the name as the extractor wrote it.
 */
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

/**
 * NOT pre-registered: B1's identifier shapes read for every type, not only
 * person and place. Added after the first run showed the invalid mentions B1
 * keeps are mostly code identifiers typed tool, topic or project. Reported as
 * post hoc, for SMD-1935 to weigh; the verdict does not read it.
 */
export function anyTypeShapeRejects(name: string, type: string): string | null {
  return b1Rejects(name, type) ?? IDENTIFIER_SHAPES.find(([, re]) => re.test(name.trim()))?.[0] ?? null;
}

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
export type GradedMention = { thought: string; entity: string } & Grade & { grader_a: [0 | 1, number]; grader_b: [0 | 1, number] } & Partial<Categorised>;
/**
 * Rubric v2's categories (entity-gate-grades-v2.json), by index: what a
 * mention is, beside whether it counts. 0 named, 1 a role pointing at one
 * person, 2 a code artifact (file, table, function, variable, branch, CI job),
 * 3 only inside URLs or paths, 4 a number, hash or address, 5 generic, 6 not
 * held. Valid is 0–2, or 0–1 when code artifacts are read as junk (--strict-code).
 */
export const CATEGORIES = ["named", "role → person", "code artifact", "URL or path only", "number, hash or address", "generic", "not held"] as const;
export const CODE_ARTIFACT = 2;
type Categorised = { category: number; category_a: number; category_b: number };
export type GateGrades = { generated: string; origin: string; note: string; mentions: GradedMention[] };

export const GATE_GRADES_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "entity-gate-grades.json");
export const GATE_GRADES_V2_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "entity-gate-grades-v2.json");
const isCategory = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) < CATEGORIES.length;
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
    if (!isBit(m.valid)) out.push(`mentions[${i}]: valid ${JSON.stringify(m.valid)} is not 0 or 1`);
    if (!isType(m.type)) out.push(`mentions[${i}]: type ${JSON.stringify(m.type)} is not an index`);
    else if ((m.valid === 1) !== (m.type >= 0)) out.push(`mentions[${i}]: valid ${m.valid} with type ${m.type}`);
    for (const k of ["grader_a", "grader_b"] as const) {
      const r = m[k];
      if (!Array.isArray(r) || r.length !== 2 || !isBit(r[0]) || !isType(r[1])) out.push(`mentions[${i}]: ${k} is not [valid, type]`);
      else if ((r[0] === 1) !== (r[1] >= 0)) out.push(`mentions[${i}]: ${k} is valid ${r[0]} with type ${r[1]}`);
    }
    // Rubric v2: all three categories or none, each an index, each agreeing with its validity (0–2 valid).
    const cats = [["category", "valid"], ["category_a", "grader_a"], ["category_b", "grader_b"]] as const;
    if (cats.some(([k]) => k in m)) for (const [k, v] of cats) {
      const c = (m as Partial<Categorised>)[k], valid = v === "valid" ? m.valid : (m[v] as unknown[] | undefined)?.[0];
      if (!isCategory(c)) out.push(`mentions[${i}]: ${k} ${JSON.stringify(c)} is not a category`);
      else if ((c <= CODE_ARTIFACT ? 1 : 0) !== valid) out.push(`mentions[${i}]: ${k} ${c} with ${v} ${JSON.stringify(valid)}`);
    }
    const key = `${m.thought}:${m.entity}`;
    if (seen.has(key)) out.push(`mentions[${i}]: ${key} is graded twice`);
    seen.add(key);
  });
  return out;
}

export function readGateGrades(path = GATE_GRADES_PATH, opts: { strictCode?: boolean } = {}): GateGrades {
  const g = JSON.parse(readFileSync(path, "utf8"));
  const problems = validateGateGrades(g);
  if (problems.length) throw new Error(`${path}: ${problems.join("; ")}`);
  if (!opts.strictCode) return g;
  if (!g.mentions.every((m: GradedMention) => m.category !== undefined)) throw new Error(`${path}: --strict-code needs rubric v2's categories`);
  return { ...g, mentions: g.mentions.map((m: GradedMention) => strictCode(m)) };
}

/** Rubric v2 with code artifacts read as junk: a category-2 label, the adjudicated one or a grader's, becomes invalid with no type. */
export function strictCode(m: GradedMention): GradedMention {
  const junk = (c: number | undefined, label: [0 | 1, number]): [0 | 1, number] => (c === CODE_ARTIFACT ? [0, -1] : label);
  const [valid, type] = junk(m.category, [m.valid, m.type]);
  return { ...m, valid, type, grader_a: junk(m.category_a, m.grader_a), grader_b: junk(m.category_b, m.grader_b) };
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

/**
 * Mean log loss of p = sigmoid(a·s + b) against the labels, exact at any
 * score: softplus(z) − y·z. A clamped p made every confident row cost the same
 * past |z| ≈ 21, so the loss went flat and the search walked to its bound on a
 * score of logit(1.00) (measured on the extractor's column).
 */
function logLoss(rows: { s: number; y: 0 | 1 }[], a: number, b: number): number {
  const softplus = (z: number) => Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z)));
  return rows.reduce((t, r) => { const z = a * r.s + b; return t + softplus(z) - r.y * z; }, 0) / rows.length;
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
  // Scores that do not vary carry no order to fit: the base rate, not a slope
  // of arbitrary sign that would reverse the test order (run-it pass 1).
  if (!slopeOnly && rows.every((r) => r.s === rows[0].s)) return { a: 0, b: logit(rows.reduce((t, r) => t + r.y, 0) / rows.length) };
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

/**
 * The paired bootstrap of stat(A) − stat(B) over the same rows: the point
 * difference, the 2.5/97.5 percentiles, and how many resamples had both
 * classes (a one-class resample has no balanced accuracy and is dropped). The
 * rows must come in a fixed order: the seed picks indices, so another order is
 * another interval (the report reads the graded set in fixture order).
 */
export function pairedBootstrap<R>(rows: R[], stat: (rs: R[]) => [number, number], n = 10_000, seed = 1937): { diff: number; lo: number; hi: number; kept: number } {
  const [a, b] = stat(rows);
  const next = rng(seed), diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample = rows.map(() => rows[Math.floor(next() * rows.length)]);
    const [x, y] = stat(sample);
    if (Number.isFinite(x - y)) diffs.push(x - y);
  }
  diffs.sort((p, q) => p - q);
  return { diff: a - b, lo: diffs[Math.floor(0.025 * diffs.length)] ?? NaN, hi: diffs[Math.min(diffs.length - 1, Math.floor(0.975 * diffs.length))] ?? NaN, kept: diffs.length };
}

/** A seeded shuffle, for the permuted-score mutant. */
export function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs], next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/**
 * The permuted-score mutant as a test: the scores shuffled across the labels
 * `n` times. The mean says where chance sits for this many rows; p is the share
 * of shuffles (the observed order counted as one) whose AUROC reaches the
 * observed, so one lucky shuffle cannot pass for a signal or hide one.
 */
export function permutationTest(scores: number[], labels: (0 | 1)[], n = 1000, seed = 7): { observed: number; mean: number; p: number; n: number; reach: number } {
  const of = (ss: number[]) => auroc(ss.filter((_, i) => labels[i] === 1), ss.filter((_, i) => labels[i] === 0));
  const observed = of(scores);
  let sum = 0, reach = 0;
  for (let i = 0; i < n; i++) { const a = of(shuffled(scores, seed + i)); sum += a; if (a >= observed) reach++; }
  return { observed, mean: sum / n, p: (reach + 1) / (n + 1), n, reach };
}

/**
 * The gate as a deployment would run it: keep a candidate when its score
 * clears the threshold, with the extractor's type unless the arm names
 * another. Off (threshold -Infinity) it is the identity — today's graph — which
 * the self-check holds; a post-filter has no other path to the graph.
 */
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
  const at = ENTITY_TYPES.indexOf(extractorType as EntityType);
  return {
    v1: { s: binaryScore(results[0]), type: null },
    v2: { s: binaryScore(results[1]), type: null },
    claim: { s: at >= 0 ? per[at] : -Infinity, type: null },
    pertype: { s: per[top], type: top },
    // The choice types a mention only when it picked a type: an abstention, a
    // number or a generic word is no type (-1), one rule for all three.
    choice: { s: logit(pValid), type: ENTITY_TYPES.indexOf(choice.selected as EntityType) },
    extractor: { s: logit(stored), type: null },
  };
}

// ── The brain ────────────────────────────────────────────────────────────────

/** `inWindow`: the window holds the name. The extractor sometimes names what the text does not spell ("OpenBrain"), and the window is then the thought's head. */
export type Candidate = { thought: string; entity: string; name: string; type: string; context: string; inWindow: boolean; metadata: Record<string, unknown>; stored: number };

/** The first place a text names `name`, without case, the name's regex characters literal. */
const findName = (text: string, name: string) => new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(text);

/**
 * One window of the thought around the first place it names the entity, found
 * without case on the text itself (lower-casing first can change a string's
 * length, "İ", and misplace the window), else its head; and whether the window
 * holds the name.
 */
export function windowAround(text: string, name: string, span = 400): { context: string; inWindow: boolean } {
  const m = findName(text, name);
  if (!m) return { context: text.slice(0, 2 * span), inWindow: false };
  return { context: text.slice(Math.max(0, m.index - span), m.index + m[0].length + span), inWindow: true };
}

type Row = { thought: string; entity: string; name: string; entity_type: string; content: string; metadata: Record<string, unknown> | null; confidence: string | number };
const toCandidate = (r: Row): Candidate => {
  const { context, inWindow } = windowAround(r.content, r.name);
  return { thought: r.thought, entity: r.entity, name: r.name, type: r.entity_type, context, inWindow, metadata: r.metadata ?? {}, stored: Number(r.confidence) };
};

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
    // Bun binds a JS array as a comma-joined string, not an array (SMD-1803's
    // trap), so each list goes as a Postgres array literal; the ids are uuids.
    const literal = (ids: string[]) => `{${ids.join(",")}}`;
    const thoughts = literal(keys.map((k) => k.thought)), entities = literal(keys.map((k) => k.entity));
    // In the fixture's order: the bootstrap and the permutation test pick rows
    // by index from a seed, so the order Postgres happened to return would move
    // the interval (run-it pass 1: -1.8 to -0.0 over 200 orders).
    const rows = (await tx`
      SELECT t.id::text AS thought, e.id::text AS entity, e.name, e.entity_type, t.content, t.metadata, te.confidence
      FROM unnest(${thoughts}::uuid[], ${entities}::uuid[]) WITH ORDINALITY AS k(thought_id, entity_id, ord)
      JOIN thought_entities te ON te.thought_id = k.thought_id AND te.entity_id = k.entity_id
      JOIN thoughts t ON t.id = te.thought_id
      JOIN ob1_entities e ON e.id = te.entity_id
      ORDER BY k.ord
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

export type ScoredRow = { c: Candidate; g: GradedMention; split: "dev" | "test"; arms: Record<ArmName, Reading>; b1: string | null };
export type Label = (r: ScoredRow) => 0 | 1;
type Fitted = { temp: { a: number; b: number }; pOf: (s: number) => number; threshold: number };

/** The cache's key: the model's provenance and what was asked. Another model, another framing or another window is another key. */
export function cacheKey(model: { name: string; revision: string; weights_sha256: string; calibrator_sha256: string; rules: string }, ds: JevDecision[]): string {
  return new Bun.CryptoHasher("md5").update([model.name, model.revision, model.weights_sha256, model.calibrator_sha256, model.rules].join("|")).update(JSON.stringify(ds)).digest("hex");
}

/** A cache file read and checked: an object of answer lists, or a refusal that names the file. */
export function readCache(path: string | undefined): Record<string, JevResult[]> {
  if (!path || !existsSync(path)) return {};
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`--cache ${path} is not JSON (${(e as Error).message}); move it aside to start afresh`); }
  if (!data || typeof data !== "object" || Array.isArray(data) || !Object.values(data).every(Array.isArray)) throw new Error(`--cache ${path} is not an object of answer lists; move it aside to start afresh`);
  return data as Record<string, JevResult[]>;
}

/** Write the cache whole or not at all: a temporary file renamed over it, so a kill mid-write leaves the last good file. */
function writeCache(path: string, cached: Record<string, JevResult[]>) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cached));
  renameSync(tmp, path);
}

type Ask = (c: Candidate, ds: JevDecision[]) => Promise<JevResult[]>;

/**
 * The tier's answers through the cache, for the report and the diagnosis: a
 * question this model was already asked is answered from `cached`, any other
 * is asked (under the candidate's own thought's metadata, so an egress term
 * applies row by row) and kept. A refusal is the caller's: the report counts
 * it and goes on, and the diagnosis stops on it (the cache is still written). The cache key names the model and what was
 * asked, the window included, so another model or window is asked afresh.
 * `run` goes between a SIGINT/SIGTERM handler and a `finally`, both of which
 * write the cache: a signal does not run `finally`, and an interrupted
 * ten-minute run keeps what it asked.
 */
async function withCache<T>(cfg: JevConfig, model: JevModelInfo, cachePath: string | undefined, cached: Record<string, JevResult[]>, run: (ask: Ask, counts: { asked: number; hits: number }) => Promise<T>): Promise<T> {
  const counts = { asked: 0, hits: 0 };
  const ask: Ask = async (c, ds) => {
    const key = cacheKey(model, ds);
    if (cached[key]) { counts.hits++; return cached[key]; }
    cached[key] = (await jevDecideMany(cfg, ds, { kind: "decision", actor: "eval-jev-gate", metadata: c.metadata })).results;
    counts.asked++;
    return cached[key];
  };
  const onSignal = (code: number) => () => { if (cachePath) writeCache(cachePath, cached); process.exit(code); };
  const onInt = onSignal(130), onTerm = onSignal(143);
  process.once("SIGINT", onInt).once("SIGTERM", onTerm);
  try {
    return await run(ask, counts);
  } finally {
    process.off("SIGINT", onInt).off("SIGTERM", onTerm);
    if (cachePath) writeCache(cachePath, cached);
  }
}

/** ECE over the deciles, the calibration harness's bins. */
const eceOf = (rows: Scored[]) => ece(reliability(rows, binOf(Infinity)));
const TIER_ARMS = ARMS.filter((x) => x !== "extractor");

/**
 * Everything taken from dev under one set of labels: per arm the temperature,
 * the Platt refit and the threshold, and the tier arm with the best dev
 * balanced accuracy (the first on a tie, in ARMS' order). The per-grader
 * sensitivity calls it again with that grader's labels, so a grader's margin
 * is the whole procedure under their labels, not the adjudicated arm rescored.
 */
export function fitOnDev(dev: ScoredRow[], y: Label): { fitted: Record<ArmName, Fitted>; keep: (arm: ArmName) => (r: ScoredRow) => boolean; devBa: Record<ArmName, number>; chosen: ArmName } {
  const fitted = Object.fromEntries(ARMS.map((arm) => {
    const d = dev.map((r) => ({ s: r.arms[arm].s, y: y(r) })).filter((r) => Number.isFinite(r.s));
    const platt = fitPlatt(d);
    // A slope of 0 (a constant dev score) is the base rate for every row, a -Infinity claim included (0 · -Infinity is NaN).
    const pOf = (s: number) => clampP(sigmoid(platt.a === 0 ? platt.b : platt.a * s + platt.b));
    return [arm, { temp: fitPlatt(d, true), pOf, threshold: bestThreshold(dev.map((r) => ({ p: pOf(r.arms[arm].s), y: y(r) }))) }];
  })) as Record<ArmName, Fitted>;
  const keep = (arm: ArmName) => (r: ScoredRow) => fitted[arm].pOf(r.arms[arm].s) >= fitted[arm].threshold;
  const devBa = Object.fromEntries(ARMS.map((arm) => [arm, balancedAccuracy(dev.map((r) => ({ keep: keep(arm)(r), y: y(r) })))])) as Record<ArmName, number>;
  const chosen = TIER_ARMS.reduce((best, arm) => (devBa[arm] > devBa[best] ? arm : best));
  return { fitted, keep, devBa, chosen };
}

async function report(url: string, numericN: number, costThoughts: number, cachePath: string | undefined, gradesPath: string, strict: boolean) {
  const cfg = resolveJevConfig(process.env as JevEnv);
  if (!cfg) { console.error("the report needs OB1_JEV_BASE_URL (and OB1_JEV_LOCAL=1 for a tier on this box)"); process.exit(2); }
  const grades = readGateGrades(gradesPath, { strictCode: strict });
  const second = readGrades().mentions;
  const cached = readCache(cachePath);
  const info = await jevInfo(cfg);
  const sql = new SQL(url);
  let found: Candidate[], missing: number, numeric: Candidate[], secondFound: Candidate[], lists: Candidate[][], perThought: number[];
  try {
    ({ found, missing } = await graded(sql, grades.mentions));
    const order = new Map(grades.mentions.map((g, i) => [`${g.thought}:${g.entity}`, i]));
    if (found.some((c, i) => i > 0 && order.get(`${c.thought}:${c.entity}`)! < order.get(`${found[i - 1].thought}:${found[i - 1].entity}`)!)) throw new Error("the graded rows did not come back in fixture order; the bootstrap reads rows by index");
    ({ found: secondFound } = await graded(sql, second));
    numeric = await numericCohort(sql, numericN);
    ({ lists, perThought } = costThoughts ? await thoughtLists(sql, costThoughts) : { lists: [], perThought: [] });
  } finally {
    await sql.close();
  }
  const gradeOf = new Map(grades.mentions.map((m) => [`${m.thought}:${m.entity}`, m]));
  const secondOf = new Map(second.map((m) => [`${m.thought}:${m.entity}`, m.outcome]));

  // A row the egress policy refuses is counted, by cohort, and left out. A
  // cached answer sent nothing, so the gate is not asked.
  const subject = (c: Candidate) => ({ kind: "decision" as const, actor: "eval-jev-gate", metadata: c.metadata });
  const refused = { graded: 0, second: 0, numeric: 0, cost: 0 };
  const m = info.model;
  const t0 = performance.now();
  const rows: ScoredRow[] = [];
  const secondRows: { key: string; y: 0 | 1; arms: Record<ArmName, Reading>; b1: string | null }[] = [];
  const numericRows: Record<ArmName, Reading>[] = [];
  const { asked, hits } = await withCache(cfg, m, cachePath, cached, async (ask, counts) => {
    const decide = async (c: Candidate, cohort: keyof typeof refused) => {
      try {
        return await ask(c, decisionsFor(c));
      } catch (e) {
        if (!(e instanceof ProviderError && e.kind === "egress")) throw e;
        refused[cohort]++;
        return null;
      }
    };
    for (const c of found) {
      const results = await decide(c, "graded");
      if (results) rows.push({ c, g: gradeOf.get(`${c.thought}:${c.entity}`)!, split: splitOf(c.thought), arms: readArms(results, c.type, c.stored), b1: b1Rejects(c.name, c.type) });
    }
    for (const c of secondFound) {
      const key = `${c.thought}:${c.entity}`;
      const results = await decide(c, "second");
      if (results) secondRows.push({ key, y: secondOf.get(key)!, arms: readArms(results, c.type, c.stored), b1: b1Rejects(c.name, c.type) });
    }
    for (const c of numeric) { const r = await decide(c, "numeric"); if (r) numericRows.push(readArms(r, c.type, c.stored)); }
    return counts;
  });
  const wall = performance.now() - t0;

  const dev = rows.filter((r) => r.split === "dev"), test = rows.filter((r) => r.split === "test");
  const y: Label = (r) => r.g.valid;
  const refusedLine = Object.entries(refused).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ");
  console.log(`\nModel ${m.name}@${m.revision.slice(0, 8)} at ${cfg.endpoint.base}. ${grades.mentions.length} graded mentions, ${found.length} still in the brain${missing ? ` (${missing} gone)` : ""}${refusedLine ? `; refused by the egress policy: ${refusedLine}` : ""}: ${dev.length} dev, ${test.length} test; ${test.filter((r) => r.g.valid === 0).length} of the test mentions invalid. ${asked} candidates asked, ${hits} from the cache, ${(wall / 1000).toFixed(1)} s.`);
  const a = grades.mentions.map((g) => g.grader_a), b = grades.mentions.map((g) => g.grader_b);
  const bothValid = a.map((x, i) => [x[1], b[i][1], x[0] === 1 && b[i][0] === 1] as const).filter((x) => x[2]);
  console.log(`graders: agree on validity ${pct(a.filter((x, i) => x[0] === b[i][0]).length, a.length)} (kappa ${fixed(kappa(a.map((x) => x[0]), b.map((x) => x[0])), 2)}); on the type where both call it valid ${bothValid.filter((x) => x[0] === x[1]).length} of ${bothValid.length} (kappa ${fixed(kappa(bothValid.map((x) => x[0]), bothValid.map((x) => x[1])), 2)})`);
  const outside = rows.filter((r) => !r.c.inWindow);
  console.log(`${outside.length} of the ${rows.length} windows do not hold the name (the extractor named what the text does not spell, so the window is the thought's head): ${outside.filter((r) => r.split === "test").length} in test, ${outside.filter((r) => r.g.valid === 0).length} graded invalid`);

  const { fitted, keep: armKeep, devBa, chosen } = fitOnDev(dev, y);
  const keepB1 = (r: { b1: string | null }) => r.b1 === null;
  const baTest = (keep: (r: ScoredRow) => boolean, rs = test) => balancedAccuracy(rs.map((r) => ({ keep: keep(r), y: y(r) })));
  const testRate = test.filter((r) => y(r)).length / test.length;

  console.log("\nValidity on the test split (threshold, temperature and Platt fitted on dev; AUROC is the order alone; skill is against a constant at test's base rate, scored on the same rows):\n");
  // The served probability: the tier's p_true (or the choice's total) at its own temperature; for the extractor, its stored column.
  const served = (s: number) => clampP(sigmoid(s));
  const rates = (keep: (r: ScoredRow) => boolean) => [fixed(baTest(keep), 3), pct(test.filter((r) => !y(r) && !keep(r)).length, test.filter((r) => !y(r)).length), pct(test.filter((r) => y(r) && keep(r)).length, test.filter((r) => y(r)).length)];
  const dash = (n: number) => Array(n).fill("—");
  console.log(table(
    ["arm", "AUROC", "served p: mean (range)", "Brier served", "ECE served", "Brier T", "Brier Platt", "skill Platt", "ECE Platt", "threshold (dev)", "balanced accuracy", "rejects invalid", "keeps valid"],
    [
      ["B0 numeric", ...dash(9), ...rates((r) => !b0Rejects(r.c.name))],
      ["B1 shape", ...dash(9), ...rates(keepB1)],
      ["B1 shapes, any type (post hoc)", ...dash(9), ...rates((r) => !anyTypeShapeRejects(r.c.name, r.c.type))],
      ...ARMS.map((arm) => {
        const f = fitted[arm];
        const pos = test.filter((r) => y(r)).map((r) => r.arms[arm].s), neg = test.filter((r) => !y(r)).map((r) => r.arms[arm].s);
        const sv = test.map((r) => ({ stated: served(r.arms[arm].s), outcome: y(r) }));
        const tp = test.map((r) => ({ stated: clampP(sigmoid(f.temp.a * r.arms[arm].s)), outcome: y(r) }));
        const pl = test.map((r) => ({ stated: f.pOf(r.arms[arm].s), outcome: y(r) }));
        const ps = sv.map((x) => x.stated);
        const sk = skill(brier(pl), testRate);
        return [arm, fixed(auroc(pos, neg), 3), `${fixed(ps.reduce((t, p) => t + p, 0) / ps.length, 2)} (${fixed(Math.min(...ps), 2)}–${fixed(Math.max(...ps), 2)})`, fixed(brier(sv), 3), fixed(eceOf(sv), 3), fixed(brier(tp), 3), fixed(brier(pl), 3),
          sk === null ? "—" : `${(100 * sk).toFixed(1)}%`, fixed(eceOf(pl), 3), fixed(f.threshold, 2), ...rates(armKeep(arm))];
      }),
    ],
  ));
  const floored = TIER_ARMS.filter((arm) => fitted[arm].temp.a < 0.002);
  console.log(`\n(temperature alone, b = 0, lands at 1/T ${TIER_ARMS.map((arm) => `${arm} ${fitted[arm].temp.a.toFixed(3)}`).join(", ")}${floored.length ? `; ${floored.join(", ")} at the search's floor of 0.001, flattened to a coin` : ""}.)`);

  const ranked = [...TIER_ARMS].sort((p, q) => devBa[q] - devBa[p]);
  const marginOf = (keep: (r: ScoredRow) => boolean, label: Label, rs = test) =>
    pairedBootstrap(rs, (xs) => [balancedAccuracy(xs.map((r) => ({ keep: keep(r), y: label(r) }))), balancedAccuracy(xs.map((r) => ({ keep: keepB1(r), y: label(r) })))]);
  const interval = (x: { diff: number; lo: number; hi: number; kept: number }) => `${fixed(100 * x.diff, 1)} points, 95% interval ${fixed(100 * x.lo, 1)} to ${fixed(100 * x.hi, 1)} (${x.kept} resamples)`;
  const margin = marginOf(armKeep(chosen), y);
  const passes = margin.diff >= 0.1 && margin.lo > 0;
  console.log(`\nchosen on dev: ${chosen} (dev balanced accuracy ${ranked.map((arm) => `${arm} ${fixed(devBa[arm], 3)}`).join(", ")}). On test, ${chosen} − B1 = ${interval(margin)}: the pre-registered margin (≥ 10 points, interval above 0) is ${passes ? "MET" : "NOT met"}.`);
  console.log(`B1 then ${chosen} (the deployable order) − B1 alone: ${interval(marginOf((r) => keepB1(r) && armKeep(chosen)(r), y))}.`);
  console.log(`without the ${outside.filter((r) => r.split === "test").length} test windows that do not hold the name: ${chosen} − B1 = ${interval(marginOf(armKeep(chosen), y, test.filter((r) => r.c.inWindow)))}.`);
  // The labels' own uncertainty: the whole procedure — refit, threshold and arm chosen on dev — under each grader's labels alone.
  for (const who of ["grader_a", "grader_b"] as const) {
    const label: Label = (r) => r.g[who][0];
    const f = fitOnDev(dev, label);
    console.log(`  under ${who}'s labels alone (${test.filter((r) => label(r) === 0).length} test invalid), refit on dev: chosen ${f.chosen} (dev ${[...TIER_ARMS].sort((p, q) => f.devBa[q] - f.devBa[p]).map((arm) => `${arm} ${fixed(f.devBa[arm], 3)}`).join(", ")}); ${f.chosen} − B1 = ${interval(marginOf(f.keep(f.chosen), label))}`);
  }

  // Typing, on the valid mentions the graders typed.
  const typedRows = test.filter((r) => r.g.valid === 1);
  const typeAcc = (typeOf: (r: ScoredRow) => number) => typedRows.filter((r) => typeOf(r) === r.g.type).length;
  const extractorType = (r: ScoredRow) => ENTITY_TYPES.indexOf(r.c.type as EntityType);
  const typing = pairedBootstrap(typedRows, (rs) => [rs.filter((r) => r.arms.pertype.type === r.g.type).length / rs.length, rs.filter((r) => extractorType(r) === r.g.type).length / rs.length]);
  const most = ENTITY_TYPES.map((_, i) => typedRows.filter((r) => r.g.type === i).length);
  console.log(`\nTyping on the ${typedRows.length} valid test mentions: the extractor ${pct(typeAcc(extractorType), typedRows.length)}, pertype ${pct(typeAcc((r) => r.arms.pertype.type!), typedRows.length)}, choice ${pct(typeAcc((r) => r.arms.choice.type!), typedRows.length)} (no type when it abstains or picks number or generic), always "${ENTITY_TYPES[most.indexOf(Math.max(...most))]}" (the commonest graded type on these rows) ${pct(Math.max(...most), typedRows.length)}. pertype − extractor = ${fixed(100 * typing.diff, 1)} points, 95% interval ${fixed(100 * typing.lo, 1)} to ${fixed(100 * typing.hi, 1)}: the pre-registered margin (≥ 10 points) is ${typing.diff >= 0.1 ? "MET" : "NOT met"}. pertype says ${ENTITY_TYPES[3]} for ${typedRows.filter((r) => r.arms.pertype.type === 3).length} of them.`);
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
  console.log(table(["threshold", `${chosen}: kept`, "precision", "recall", "extractor: kept", "precision", "recall"], [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => [t.toFixed(1), ...at(chosen, t), ...at("extractor", t)])));
  const stored = [...new Set(test.map((r) => r.c.stored))].sort();
  console.log(`the extractor's column takes ${stored.length} distinct value${stored.length === 1 ? "" : "s"} on the test split: ${stored.map((v) => { const k = test.filter((r) => r.c.stored === v); return `${v} on ${k.length} (${pct(k.filter((r) => y(r)).length, k.length)} valid)`; }).join(", ")}`);

  // The mutant: does the chosen arm's order beat shuffles of itself?
  const perm = permutationTest(test.map((r) => r.arms[chosen].s), test.map(y));
  console.log(`\nmutant: ${chosen}'s scores permuted across the test mentions, ${perm.n} times: mean AUROC ${fixed(perm.mean, 3)}; ${perm.reach} of ${perm.n} reach the unpermuted ${fixed(perm.observed, 3)} (p = ${fixed(perm.p, 3)}, the observed order counted as one).`);

  // The second grader's set: SMD-1982's hand grades, the same definition, another grader.
  if (secondRows.length) {
    const sp = secondRows.filter((r) => r.y === 1), sn = secondRows.filter((r) => r.y === 0);
    const shared = secondRows.filter((r) => gradeOf.has(r.key)).length;
    console.log(`\nSMD-1982's hand-graded mentions (${secondRows.length}, ${sn.length} invalid, ${shared} of them also in the graded set; another grader, the same definition): AUROC ${TIER_ARMS.map((arm) => `${arm} ${fixed(auroc(sp.map((r) => r.arms[arm].s), sn.map((r) => r.arms[arm].s)), 3)}`).join(", ")}; B1 balanced accuracy ${fixed(balancedAccuracy(secondRows.map((r) => ({ keep: keepB1(r), y: r.y }))), 3)}, ${chosen} at its dev threshold ${fixed(balancedAccuracy(secondRows.map((r) => ({ keep: fitted[chosen].pOf(r.arms[chosen].s) >= fitted[chosen].threshold, y: r.y }))), 3)}.`);
  }
  // The B0 names: could an arm replace B0?
  if (numericRows.length) console.log(`\nthe ${numericRows.length} most-mentioned B0 names (all invalid): each arm at its dev threshold rejects ${TIER_ARMS.map((arm) => `${arm} ${pct(numericRows.filter((r) => fitted[arm].pOf(r[arm].s) < fitted[arm].threshold).length, numericRows.length)}`).join(", ")}; B0 100%.`);

  // Cost at real volume: a thought's whole candidate list in one call, which
  // the client packs into requests of at most JEV_MAX_BATCH decisions, sent in turn.
  const shapes = { binary: { from: 1, to: 2 }, pertype: { from: 2, to: 8 } } as const;
  const cost: Record<keyof typeof shapes, { ms: number; requests: number }[]> = { binary: [], pertype: [] };
  for (const list of lists) {
    for (const shape of ["binary", "pertype"] as const) {
      const ds = list.flatMap((c) => decisionsFor(c).slice(shapes[shape].from, shapes[shape].to));
      try {
        const t = performance.now();
        await jevDecideMany(cfg, ds, subject(list[0]));
        cost[shape].push({ ms: performance.now() - t, requests: Math.ceil(ds.length / JEV_MAX_BATCH) });
      } catch (e) {
        if (!(e instanceof ProviderError && e.kind === "egress")) throw e;
        refused.cost++;
      }
    }
  }
  const sizes = lists.map((l) => l.length);
  const line = (xs: { ms: number; requests: number }[]) => `p50 ${fixed(quantile(xs.map((x) => x.ms), 0.5), 0)} ms, p90 ${fixed(quantile(xs.map((x) => x.ms), 0.9), 0)} ms, max ${fixed(quantile(xs.map((x) => x.ms), 1), 0)} ms, requests a call ${quantile(xs.map((x) => x.requests), 0)} to ${quantile(xs.map((x) => x.requests), 1)} (p50 ${quantile(xs.map((x) => x.requests), 0.5)})`;
  if (cost.binary.length) console.log(`\nCost at real volume: mentions per thought in the brain p50 ${quantile(perThought, 0.5)}, p95 ${quantile(perThought, 0.95)}, max ${quantile(perThought, 1)}. Timed: ${cost.binary.length} whole thoughts by md5 (candidates p50 ${quantile(sizes, 0.5)}, p90 ${quantile(sizes, 0.9)}, max ${quantile(sizes, 1)}${refused.cost ? `; ${refused.cost} calls refused` : ""}), each list in one call. One binary a candidate (v2's shape): ${line(cost.binary)}. The six per-type binaries: ${line(cost.pertype)}.`);

  // For a human: the test mentions the chosen arm and B1 disagree on, with the grade.
  console.log(`\ntest mentions where ${chosen} and B1 disagree — the extractor's type, the name, the grade, ${chosen}'s P, pertype's type, * when the window lacks the name:`);
  for (const r of test.filter((r) => armKeep(chosen)(r) !== keepB1(r))) {
    console.log(`  ${r.c.type.padEnd(12)} ${r.c.name.slice(0, 32).padEnd(32)} ${r.g.valid ? `valid ${ENTITY_TYPES[r.g.type]}`.padEnd(20) : "invalid".padEnd(20)} ${fixed(fitted[chosen].pOf(r.arms[chosen].s), 2)}  ${ENTITY_TYPES[r.arms.pertype.type!]}${r.b1 ? `  (B1: ${r.b1})` : ""}${r.c.inWindow ? "" : " *"}`);
  }
}

// ── The diagnosis: why the tier fails here ───────────────────────────────────

/**
 * NOT pre-registered: probes added after the verdict, asking why Verdict fails
 * a task its benchmark scores (JevBench easy 88%, standard 69%). JevBench
 * decides about a short text whose answer the text states; this gate asks what
 * a name inside a long note is. The probes separate the causes: does the model
 * read the name at all (D1), is it the note's length (D2), is it the label
 * wording (D3), and what it says across the whole graph (D4).
 */
export const JUNK = "junk";
const sevenWay = (descriptions: Record<EntityType, string>, junk: string) => [...ENTITY_TYPES.map((t) => ({ id: t, description: descriptions[t] })), { id: JUNK, description: junk }];
/** The type definitions the arms use, and junk in the same register. */
export const ABSTRACT_OPTIONS = sevenWay(DEFINITION, "not a specific named entity: a number, version, port or address; or a generic word or role");
/** Concrete labels, each with examples from OUTSIDE the brain. A probe outside the harness whose examples included 11 graded names scored 48%, against 33% with these; its wording differed too, so not all of that gap is string matching. */
export const CONCRETE_OPTIONS = sevenWay({
  person: "a person's name, like Ada Lovelace or Grace Hopper",
  organization: "a company or organization, like Mozilla or the Red Cross",
  project: "a named project, repository, product or ticket, like Firefox, Apollo 11 or JIRA-4521",
  tool: "a piece of software, library, service, command or file, like Kubernetes, numpy, curl or setup.py",
  topic: "a named subject or method, like quantum computing or gradient descent",
  place: "a geographic place, like London or California",
}, "not a name at all: a number, version, port or hash, or an ordinary word or role like manager, user or settings");

/** The name in a note (the question names it) or the name as the text itself (the question does not). */
export function sevenWayAbout(name: string, context: string, options: JevOption[]): JevDecision {
  return { kind: "choice", question: `What is "${name}" in this note: one of these kinds of named entity, or junk?`, options, context };
}
export function sevenWayOf(text: string, options: JevOption[]): JevDecision {
  return { kind: "choice", question: "What kind of thing is this name?", options, context: text };
}
/** A choice's answer as a label: an abstention is junk (no type it will stand behind). */
export const sevenWayLabel = (r: JevResult) => (r.selected === INSUFFICIENT_EVIDENCE ? JUNK : r.selected);

/** The sentence or line holding the name, at most 120 characters either side of it; null when the text lacks it. */
export function sentenceAround(text: string, name: string): string | null {
  const m = findName(text, name);
  if (!m) return null;
  const breaks = [...text.slice(0, m.index).matchAll(/[.!?]\s|\n/g)].map((x) => x.index! + x[0].length);
  const start = Math.max(breaks.at(-1) ?? 0, m.index - 120);
  const after = text.slice(m.index + m[0].length).search(/[.!?]\s|\n/);
  const end = Math.min(after < 0 ? text.length : m.index + m[0].length + after + 1, m.index + m[0].length + 120);
  return text.slice(start, end).trim();
}

async function diagnose(url: string, cachePath: string | undefined) {
  const cfg = resolveJevConfig(process.env as JevEnv);
  if (!cfg) { console.error("the diagnosis needs OB1_JEV_BASE_URL (and OB1_JEV_LOCAL=1 for a tier on this box)"); process.exit(2); }
  const cached = readCache(cachePath);
  const info = await jevInfo(cfg);
  const v2 = readGateGrades(GATE_GRADES_V2_PATH);
  const sql = new SQL(url);
  let found: Candidate[], everyone: Candidate[];
  try {
    ({ found } = await graded(sql, v2.mentions));
    everyone = await sql.begin("read only", async (tx) => ((await tx`
      SELECT DISTINCT ON (e.id) t.id::text AS thought, e.id::text AS entity, e.name, e.entity_type, t.content, t.metadata, te.confidence
      FROM ob1_entities e JOIN thought_entities te ON te.entity_id = e.id JOIN thoughts t ON t.id = te.thought_id
      ORDER BY e.id, t.created_at, t.id
    `) as Row[]).map(toCandidate));
  } finally {
    await sql.close();
  }
  const truthOf = new Map(v2.mentions.map((m) => [`${m.thought}:${m.entity}`, m]));
  const truth = (c: Candidate) => { const m = truthOf.get(`${c.thought}:${c.entity}`)!; return m.valid ? ENTITY_TYPES[m.type] : JUNK; };
  const LABELS = [...ENTITY_TYPES, JUNK];
  const spread = (xs: string[]) => LABELS.map((l) => `${l} ${xs.filter((x) => x === l).length}`).join(", ");
  const held = found.filter((c) => c.inWindow);
  await withCache(cfg, info.model, cachePath, cached, async (ask, counts) => {
    console.log(`\nDiagnosis (not pre-registered), ${info.model.name}; truth is rubric v2 with code artifacts counted, on the ${held.length} graded mentions whose window holds the name.\n`);
    // D1: the same window asked about the entity, a number and an unrelated word.
    const d1 = held.slice(0, 60);
    let same = 0;
    const moves: number[] = [];
    for (const c of d1) {
      const [a, b, z] = await ask(c, [sevenWayAbout(c.name, c.context, ABSTRACT_OPTIONS), sevenWayAbout("021", c.context, ABSTRACT_OPTIONS), sevenWayAbout("banana", c.context, ABSTRACT_OPTIONS)]);
      if (sevenWayLabel(a) === sevenWayLabel(b) && sevenWayLabel(a) === sevenWayLabel(z)) same++;
      moves.push(Math.max(...Object.keys(a.probabilities).map((k) => Math.abs(a.probabilities[k] - z.probabilities[k]))));
    }
    console.log(`D1, does it read the name? The same window asked about the entity, "021" and "banana": one answer for all three on ${same} of ${d1.length}; the largest move in any option's probability, entity to banana, p50 ${quantile(moves, 0.5).toFixed(3)}, p90 ${quantile(moves, 0.9).toFixed(3)}.`);
    // D2 and D3: the context's length, and the labels' wording.
    const arms: { name: string; ds: (c: Candidate) => JevDecision }[] = [
      { name: "abstract labels, the name in the question, the ~800-character window", ds: (c) => sevenWayAbout(c.name, c.context, ABSTRACT_OPTIONS) },
      { name: "abstract labels, the name in the question, its sentence alone", ds: (c) => sevenWayAbout(c.name, sentenceAround(c.context, c.name)!, ABSTRACT_OPTIONS) },
      { name: "abstract labels, the name alone as the text", ds: (c) => sevenWayOf(c.name, ABSTRACT_OPTIONS) },
      { name: "concrete labels (examples from outside the brain), the name alone", ds: (c) => sevenWayOf(c.name, CONCRETE_OPTIONS) },
      { name: "concrete labels, the name then its sentence", ds: (c) => sevenWayOf(`${c.name}\n\n(from: ${sentenceAround(c.context, c.name)})`, CONCRETE_OPTIONS) },
    ];
    const rows: string[][] = [];
    for (const arm of arms) {
      const said: string[] = [];
      for (const c of held) said.push(sevenWayLabel((await ask(c, [arm.ds(c)]))[0]));
      const t = held.map(truth), junkSaid = said.filter((x) => x === JUNK).length;
      rows.push([arm.name, pct(said.filter((x, i) => x === t[i]).length, held.length), pct(said.filter((x, i) => x === JUNK && t[i] === JUNK).length, junkSaid), pct(said.filter((x, i) => x !== JUNK && t[i] !== JUNK).length, t.filter((x) => x !== JUNK).length), spread(said)]);
    }
    rows.push(["the extractor's own type (never junk)", pct(held.filter((c) => c.type === truth(c)).length, held.length), "—", "100.0%", spread(held.map((c) => c.type))]);
    console.log(`\nD2 and D3, the context's length and the labels' wording, against rubric v2 (${held.filter((c) => truth(c) === JUNK).length} of ${held.length} junk):\n`);
    console.log(table(["framing", "label right (7-way)", "junk precision", "keeps valid", "what it answers"], rows));
    // D4: the whole graph, the first framing.
    const said: { c: Candidate; label: string }[] = [];
    for (const c of everyone) said.push({ c, label: sevenWayLabel((await ask(c, [sevenWayAbout(c.name, c.context, ABSTRACT_OPTIONS)]))[0]) });
    console.log(`\nD4, the whole graph (${everyone.length} entities, the first framing): it answers ${spread(said.map((x) => x.label))}; it keeps the extractor's type on ${pct(said.filter((x) => x.label === x.c.type).length, said.length)} and calls ${pct(said.filter((x) => x.label === JUNK).length, said.length)} junk, ${pct(said.filter((x) => x.label === JUNK && b0Rejects(x.c.name)).length, said.filter((x) => b0Rejects(x.c.name)).length)} of the numeric names among them.`);
    // D5: under each rubric, the graph's junk weighted by type from the graded strata, and the 7-way labels on all 201.
    const byEntity = new Map(said.map((x) => [x.c.entity, x.label]));
    const rubrics: [string, GradedMention[]][] = [["v1 (the verdict's)", readGateGrades().mentions], ["v2, code artifacts junk", readGateGrades(GATE_GRADES_V2_PATH, { strictCode: true }).mentions], ["v2, code artifacts count", v2.mentions]];
    const typeOf = new Map(found.map((c) => [c.entity, c]));
    const numeric = everyone.filter((c) => b0Rejects(c.name)).length;
    const d5 = rubrics.map(([name, ms]) => {
      const lab = (m: GradedMention) => (m.valid ? ENTITY_TYPES[m.type] : JUNK);
      const junk = ENTITY_TYPES.reduce((sum, t) => {
        const pop = everyone.filter((c) => c.type === t && !b0Rejects(c.name)).length, gs = ms.filter((m) => typeOf.get(m.entity)?.type === t);
        return sum + (gs.length ? (pop * gs.filter((m) => !m.valid).length) / gs.length : 0);
      }, numeric);
      const scored = ms.filter((m) => typeOf.has(m.entity) && byEntity.has(m.entity));
      const right = (f: (m: GradedMention) => string) => pct(scored.filter((m) => f(m) === lab(m)).length, scored.length);
      const c = (m: GradedMention) => typeOf.get(m.entity)!;
      return [name, String(ms.filter((m) => m.valid).length), `~${Math.round(junk)} (${pct(junk, everyone.length)})`, right((m) => byEntity.get(m.entity)!), right((m) => (b1Rejects(c(m).name, c(m).type) ? JUNK : c(m).type))];
    });
    console.log(`\nD5, under each rubric: the graph's junk, weighted by type from the graded strata plus the ${numeric} numeric names; and the 7-way label (the first framing) on the graded mentions, against B1 then the extractor's type:\n`);
    console.log(table(["rubric", "valid of 201", "junk in the graph", "tier's 7-way right", "B1 then the extractor's type"], d5));
    console.log(`\n${counts.asked} asked, ${counts.hits} from the cache.`);
  });
}

// ── The self-check ───────────────────────────────────────────────────────────

function selfCheck() {
  let failed = 0;
  const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
  const refuses = (f: () => unknown) => { try { f(); return ""; } catch (e) { return (e as Error).message; } };

  // B0 and B1, on the shapes SMD-1935 names and the ones it must keep.
  ok(["021", "11434", "127.0.0.1", "10 000"].every(b0Rejects) && !["pg16", "smd 1938", "Edge0"].some(b0Rejects), "B0 rejects a migration number, a port, an address and a spaced number, and keeps a name with a letter");
  ok(b0Rejects("０２１") && b0Rejects("  021  "), "B0 reads the name normalised: full-width digits and outer spaces are still a number");
  const b1 = (n: string, t: string) => b1Rejects(n, t);
  ok(b1("021", "person") === "a number" && b1("Person", "topic") === "a type-vocabulary word" && b1("places", "place") === "a type-vocabulary word", "B1 rejects a number and the type vocabulary, whatever the type");
  ok(["@hono/mcp", "hono/mcp", "michaelharris/**", "SMD-1497", "host.containers.internal", "openrouter.ai", "open-brain_default", "localhost:11434"].every((n) => b1(n, "person") !== null && b1(n, "place") !== null), "B1 rejects an identifier's shape typed person or place: a package, a path, a glob, a ticket id, a host, a domain, snake_case, a host:port");
  ok(["@hono/mcp", "SMD-1497", "openrouter.ai", "db/migrate.ts"].every((n) => b1(n, "tool") === null && b1(n, "project") === null), "B1 keeps the same shapes typed tool or project: it bars only person and place (SMD-1935)");
  ok(anyTypeShapeRejects("ob1_entity_edges", "project") !== null && anyTypeShapeRejects("db/README.md", "topic") !== null && anyTypeShapeRejects("Bun", "tool") === null && anyTypeShapeRejects("021", "tool") === "a number" && anyTypeShapeRejects("SMD-1497", "person") === "a person with a ticket id's shape", "the post-hoc rule reads B1's shapes for every type, and keeps B1's own reasons first");
  ok(["Nate B. Jones", "anita", "Michael Harris", "Mac mini M4 Pro", "main", "operator"].every((n) => b1(n, "person") === null && b1(n, "place") === null), "B1 keeps a name with spaces, a lower-case name and a generic word: the ambiguous cases are the gate's, not the regex's");

  // The arithmetic.
  ok(auroc([2, 3], [0, 1]) === 1 && auroc([0, 1], [2, 3]) === 0 && auroc([1], [1]) === 0.5 && Number.isNaN(auroc([], [1])), "AUROC: separated 1, reversed 0, a tie 0.5, an empty side NaN");
  ok(balancedAccuracy([{ keep: false, y: 0 }, { keep: true, y: 1 }]) === 1 && balancedAccuracy([{ keep: true, y: 0 }, { keep: true, y: 1 }, { keep: true, y: 1 }]) === 0.5 && Number.isNaN(balancedAccuracy([{ keep: true, y: 1 }])), "balanced accuracy: perfect 1, keep-everything 0.5 whatever the base rate, one class NaN");
  ok(bestThreshold([{ p: 0.2, y: 0 }, { p: 0.4, y: 0 }, { p: 0.6, y: 1 }, { p: 0.9, y: 1 }]) === 0.6, "the dev threshold is the lowest that separates");
  ok(bestThreshold([{ p: 0.8, y: 1 }, { p: 0.2, y: 0 }, { p: 0.6, y: 0 }, { p: 0.4, y: 1 }]) === 0.4, "two thresholds tie (0.4 and 0.8, balanced accuracy 0.75 each): the lowest wins, whatever the rows' order");
  // A known temperature and a known Platt offset are recovered from labels drawn at them.
  const draw = rng(42);
  const synth = (a: number, b: number) => Array.from({ length: 4000 }, () => { const s = (draw() - 0.5) * 12; return { s, y: (draw() < sigmoid(a * s + b) ? 1 : 0) as 0 | 1 }; });
  const t = fitPlatt(synth(0.4, 0), true), p = fitPlatt(synth(0.4, -1));
  ok(Math.abs(t.a - 0.4) < 0.05 && t.b === 0, `a temperature is recovered (1/T = ${t.a.toFixed(3)}, drawn at 0.4)`);
  ok(Math.abs(p.a - 0.4) < 0.05 && Math.abs(p.b + 1) < 0.15, `Platt's slope and offset are recovered (${p.a.toFixed(3)}, ${p.b.toFixed(3)}; drawn at 0.4, -1)`);
  // The extractor's column: two stated values, 1.00 and 0.90 (logit ≈ 20.7 and 2.2), neither of which the label follows.
  // The best temperature flattens it toward the base rate; a clamped loss is flat past |z| ≈ 21 and the fit walks the other way.
  const column = Array.from({ length: 400 }, (_, i) => ({ s: logit(i % 10 ? 1 : 0.9), y: (draw() < 0.42 ? 1 : 0) as 0 | 1 }));
  const w = fitPlatt(column, true);
  ok(w.a < 0.1, `a temperature on a confident column the labels do not follow flattens it (1/T = ${w.a.toFixed(3)}), not sharpens it`);
  const flat = fitPlatt([0, 1, 1, 0, 1].map((y) => ({ s: 0.3, y: y as 0 | 1 })));
  ok(flat.a === 0 && Math.abs(flat.b - logit(0.6)) < 1e-12, "Platt on scores that do not vary returns the base rate, not a slope of arbitrary sign");
  const tied = fitPlatt([{ s: 1, y: 1 }, { s: 1, y: 0 }, { s: 2, y: 1 }, { s: 0, y: 0 }]);
  ok(tied.a > 0, "scores that vary but repeat their first value are fitted, not taken for constant");
  const tflat = fitPlatt([0, 1, 1].map((y) => ({ s: 0.3, y: y as 0 | 1 })), true);
  ok(tflat.b === 0, "a temperature has no offset, constant scores or not");
  ok(kappa([1, 1, 0, 0], [1, 1, 0, 0]) === 1 && Math.abs(kappa([1, 0, 1, 0], [1, 1, 0, 0])) < 1e-12, "kappa: agreement 1, agreement at chance 0");
  ok(Math.abs(kappa([1, 1, 1, 0], [1, 1, 0, 0]) - 0.5) < 1e-12 && kappa([1, 1], [1, 1]) === 1, "kappa with unequal marginals (0.75 agreement, 0.5 by chance: 0.5), and one label throughout is agreement");
  const rows = Array.from({ length: 200 }, (_, i) => ({ a: i % 2 === 0, b: i % 4 === 0, y: (i % 2 === 0 ? 1 : 0) as 0 | 1 }));
  const bs = pairedBootstrap(rows, (rs) => [balancedAccuracy(rs.map((r) => ({ keep: r.a, y: r.y }))), balancedAccuracy(rs.map((r) => ({ keep: r.b, y: r.y })))]);
  const oneClassy = Array.from({ length: 10 }, (_, i) => ({ keep: i === 0, y: (i === 0 ? 1 : 0) as 0 | 1 }));
  const thin = pairedBootstrap(oneClassy, (rs) => [balancedAccuracy(rs), 0.5], 2000);
  ok(thin.kept < 2000 && thin.kept > 0 && Number.isFinite(thin.lo) && Number.isFinite(thin.hi), `a resample with one class has no balanced accuracy and is dropped, and counted (${thin.kept} of 2000 kept)`);
  ok(Math.abs(bs.diff - 0.25) < 1e-12 && bs.lo > 0 && bs.hi <= 0.5 && bs.kept === 10_000 && JSON.stringify(bs) === JSON.stringify(pairedBootstrap(rows, (rs) => [balancedAccuracy(rs.map((r) => ({ keep: r.a, y: r.y }))), balancedAccuracy(rs.map((r) => ({ keep: r.b, y: r.y })))])), `the paired bootstrap: the point difference exact, the interval around it, every resample kept, the same seed the same interval (${bs.lo.toFixed(3)}–${bs.hi.toFixed(3)})`);
  // Pairing: B errs everywhere A errs and on four rows more, so on ANY resample of
  // the same rows A − B >= 0. Resampled apart, the two statistics cross zero.
  // A errs on 20 rows, B on those and 4 more: the difference (0.02) is small beside either statistic's own spread.
  const nested = Array.from({ length: 200 }, (_, i) => ({ y: (i % 2) as 0 | 1, a: i < 20 ? i % 2 === 0 : i % 2 === 1, b: i < 24 ? i % 2 === 0 : i % 2 === 1 }));
  const pairedNested = pairedBootstrap(nested, (rs) => [balancedAccuracy(rs.map((r) => ({ keep: r.a, y: r.y }))), balancedAccuracy(rs.map((r) => ({ keep: r.b, y: r.y })))], 2000);
  ok(pairedNested.lo >= 0 && pairedNested.diff > 0, `the bootstrap is paired: B's errors contain A's, so no resample of the same rows puts A below B (lower bound ${pairedNested.lo.toFixed(3)})`);
  // The percentiles: the mean of 0..99 resampled has sd ≈ 2.9, so its 95% interval is about 43.8 to 55.2.
  const means = pairedBootstrap(Array.from({ length: 100 }, (_, i) => i), (rs) => [rs.reduce((t, x) => t + x, 0) / rs.length, 0], 4000);
  ok(Math.abs(means.lo - 43.84) < 0.5 && Math.abs(means.hi - 55.16) < 0.5, `the interval is the 2.5th and 97.5th percentiles (${means.lo.toFixed(2)} to ${means.hi.toFixed(2)} for a mean of 0..99; the normal approximation says 43.84 to 55.16, the 5th/95th would be 44.75 to 54.25)`);

  // The controls: the gate off is the identity; a permuted score loses its order.
  const cands = [{ type: "person", n: 1 }, { type: "tool", n: 2 }];
  const offRun = gate(cands, () => -1e9, -Infinity);
  ok(offRun.length === 2 && offRun.every((k, i) => k.cand === cands[i] && k.type === cands[i].type), "the gate off keeps every candidate with the extractor's type: today's graph exactly");
  ok(gate(cands, (c) => c.n, 2, () => "topic").length === 1 && gate(cands, (c) => c.n, 2, () => "topic")[0].type === "topic", "the gate on keeps what clears the threshold, typed as the arm says");
  const sep = Array.from({ length: 100 }, (_, i) => i), lab = sep.map((i) => i >= 50);
  const permuted = shuffled(sep, 7);
  const permAuroc = auroc(permuted.filter((_, i) => lab[i]), permuted.filter((_, i) => !lab[i]));
  ok(auroc(sep.filter((_, i) => lab[i]), sep.filter((_, i) => !lab[i])) === 1 && permAuroc > 0.3 && permAuroc < 0.7, `the mutant: a perfect score permuted falls to chance (${permAuroc.toFixed(3)})`);
  const strong = permutationTest(sep, lab.map((l) => (l ? 1 : 0)), 200), none = permutationTest(sep.map((i) => i % 7), lab.map((l) => (l ? 1 : 0)), 200);
  ok(strong.observed === 1 && strong.p === 1 / 201 && strong.reach === 0 && Math.abs(strong.mean - 0.5) < 0.05 && none.p > 0.05 && none.reach > 0 && none.reach < 200, `the permutation test: a perfect score is past every shuffle (p = 1/201, the observed order counted as one; chance ${strong.mean.toFixed(3)}), a score unrelated to the label is not, and each shuffle is its own (p ${none.p.toFixed(3)}, ${none.reach} of 200 reach it)`);
  ok(permutationTest(sep.map(() => 1), lab.map((l) => (l ? 1 : 0)), 50).p === 1, "a shuffle that ties the observed reaches it: a constant score has p = 1");

  // The framings and the readings.
  const ds = decisionsFor({ name: "Bun", context: "ctx" });
  const prop = (i: number) => (ds[i] as { proposition: string }).proposition;
  ok(ds.length === 9 && ds.slice(0, 8).every((d) => d.kind === "binary") && ds[8].kind === "choice" && prop(0).includes("is the name of a specific") && prop(1).includes("clearly identifiable") && ENTITY_TYPES.every((t, i) => prop(2 + i).endsWith(DEFINITION[t])) && ds.every((d) => d.context === "ctx"), "a candidate costs nine decisions, each with its window: v1, v2, one binary per type in ENTITY_TYPES' order, the choice");
  const bin = (lt: number, lf: number, temperature = 1): JevResult => ({ kind: "binary", probabilities: { true: 0.5, false: 0.3, [INSUFFICIENT_EVIDENCE]: 0.2 }, selected: "true", abstained: false, p_insufficient: 0.2, p_true: 0.6, logits: [lt, lf, -9], temperature, tokens: 1, truncated: false });
  const reordered: JevResult = { ...bin(0, 0), probabilities: { false: 0.3, true: 0.5, [INSUFFICIENT_EVIDENCE]: 0.2 }, logits: [1, 3, -9], temperature: 2 };
  ok(Math.abs(binaryScore(bin(3, 1, 2)) - 1) < 1e-12 && Math.abs(binaryScore(reordered) - 1) < 1e-12, "a binary score is (true − false) / the tier's temperature, read by key whatever the keys' order");
  const choice: JevResult = { kind: "choice", probabilities: { person: 0.05, organization: 0.05, project: 0.1, tool: 0.4, topic: 0.1, place: 0, number: 0.2, generic: 0.05, [INSUFFICIENT_EVIDENCE]: 0.05 }, selected: "tool", abstained: false, p_insufficient: 0.05, logits: [], temperature: 1, tokens: 1, truncated: false };
  const per = [0, 0, 0, 5, 1, 0];
  const read = readArms([bin(7, 0), bin(2, 0), ...per.map((s) => bin(s, 0)), choice], "topic", 0.9);
  ok(read.v1.s === 7 && read.v2.s === 2 && read.pertype.type === ENTITY_TYPES.indexOf("tool") && read.pertype.s === 5 && read.claim.s === 1 && Math.abs(read.choice.s - logit(0.7)) < 1e-9 && read.choice.type === ENTITY_TYPES.indexOf("tool") && Math.abs(read.extractor.s - logit(0.9)) < 1e-12, "the readings: v1 and v2 from their own results, pertype's argmax and max, claim at the extractor's type, choice's keep score as the six types' total, the extractor's column on the logit scale");
  const noType = (selected: string) => readArms([bin(0, 0), bin(0, 0), ...per.map((s) => bin(s, 0)), { ...choice, selected, abstained: selected === INSUFFICIENT_EVIDENCE }], "topic", 1).choice.type;
  ok(noType(INSUFFICIENT_EVIDENCE) === -1 && noType("number") === -1 && noType("generic") === -1, "the choice names no type when it abstains or picks number or generic: one rule for all three");
  ok(readArms([bin(0, 0), bin(0, 0), ...per.map((s) => bin(s, 0)), choice], "not-a-type", 1).claim.s === -Infinity, "a claim for a type off the vocabulary scores as a reject");

  const A = "10000000-0000-4000-8000-000000000001", B = "10000000-0000-4000-8000-000000000002";
  // The diagnosis's framings.
  ok(sentenceAround("First one. Then Bun ran here. After.", "bun") === "Then Bun ran here." && sentenceAround(`${"x".repeat(300)} Bun ${"y".repeat(300)}`, "bun") === `${"x".repeat(119)} Bun ${"y".repeat(119)}` && sentenceAround("line one\nuses Bun\nline three", "bun") === "uses Bun" && sentenceAround("One. Two. Then Bun ran.", "bun") === "Then Bun ran." && sentenceAround("no name", "bun") === null, "the sentence around a name: bounded by a full stop or a line break, at most 120 characters either side, null when the text lacks it");
  const about = sevenWayAbout("Bun", "ctx", ABSTRACT_OPTIONS), of = sevenWayOf("Bun", CONCRETE_OPTIONS);
  ok(about.kind === "choice" && about.question.includes('"Bun"') && about.context === "ctx" && of.kind === "choice" && !of.question.includes("Bun") && of.context === "Bun" && [ABSTRACT_OPTIONS, CONCRETE_OPTIONS].every((o) => o.length === 7 && o[6].id === JUNK && ENTITY_TYPES.every((t, i) => o[i].id === t)), "the name goes in the question (about a note) or is the text itself (of a name); both option sets are the six types then junk");
  ok([ABSTRACT_OPTIONS, CONCRETE_OPTIONS].every((o) => new Set(o.map((x) => x.description)).size === 7 && o.every((x) => x.description.length > 10)) && ABSTRACT_OPTIONS[6].description !== CONCRETE_OPTIONS[6].description, "each option set's seven descriptions are distinct and written out, and the two junk descriptions differ");
  ok(sevenWayLabel({ ...choice, selected: INSUFFICIENT_EVIDENCE }) === JUNK && sevenWayLabel(choice) === "tool", "a seven-way abstention reads as junk");

  // The dev procedure: the refit, the threshold and the arm, under the labels given.
  const mk = (i: number, scores: Partial<Record<ArmName, number>>, valid: 0 | 1, alt: 0 | 1): ScoredRow => ({
    c: { thought: A, entity: A, name: `n${i}`, type: "tool", context: "c", inWindow: true, metadata: {}, stored: 1 },
    g: { thought: A, entity: A, valid, type: valid ? 3 : -1, grader_a: [valid, valid ? 3 : -1], grader_b: [alt, alt ? 3 : -1] },
    split: "dev", b1: null,
    arms: Object.fromEntries(ARMS.map((arm) => [arm, { s: scores[arm] ?? 0, type: null }])) as Record<ArmName, Reading>,
  });
  // v2 follows the adjudicated label, choice follows grader B's, and v1 ties v2 exactly.
  const devRows = Array.from({ length: 40 }, (_, i) => { const y = (i % 2) as 0 | 1, alt = (i % 4 < 2 ? 1 : 0) as 0 | 1; return mk(i, { v1: y ? 2 : -2, v2: y ? 2 : -2, choice: alt ? 2 : -2, claim: i % 5 ? 0.5 : -Infinity }, y, alt); });
  const byValid = fitOnDev(devRows, (r) => r.g.valid), byB = fitOnDev(devRows, (r) => r.g.grader_b[0]);
  ok(byValid.chosen === "v1" && byValid.devBa.v1 === 1 && byValid.devBa.v2 === 1 && byB.chosen === "choice" && byB.devBa.choice === 1, `the arm is chosen on dev under the labels given, the first in ARMS' order on a tie (${byValid.chosen}; under grader B's labels ${byB.chosen})`);
  ok(Number.isFinite(byValid.fitted.claim.threshold) && Number.isFinite(byValid.fitted.claim.pOf(-Infinity)) && byValid.fitted.claim.pOf(-Infinity) === byValid.fitted.claim.pOf(0.5), "an arm constant on its finite dev rows fits the base rate for every row, a -Infinity claim included (0 · -Infinity would be NaN), and keeps a finite threshold");
  const onlyExtractor = fitOnDev(Array.from({ length: 20 }, (_, i) => mk(i, { extractor: i % 2 ? 5 : -5 }, (i % 2) as 0 | 1, 0)), (r) => r.g.valid);
  ok(onlyExtractor.devBa.extractor === 1 && onlyExtractor.chosen !== "extractor", "the extractor's column is scored but never chosen: the verdict is about the tier's arms");
  ok(byB.fitted.v2.threshold !== byValid.fitted.v2.threshold || byB.devBa.v2 !== byValid.devBa.v2, "the threshold and the dev score are refit under another grader's labels, not carried over");
  // The cache: the key names the model and what was asked; a bad file is refused by name.
  const model = { name: "m", revision: "r", weights_sha256: "w", calibrator_sha256: "c", rules: "u" };
  const k0 = cacheKey(model, ds);
  ok(k0 !== cacheKey({ ...model, revision: "r2" }, ds) && k0 !== cacheKey({ ...model, weights_sha256: "w2" }, ds) && k0 !== cacheKey(model, decisionsFor({ name: "Bun", context: "ctx2" })) && k0 === cacheKey({ ...model }, decisionsFor({ name: "Bun", context: "ctx" })), "the cache key changes with the model's revision or weights and with the window, and only with them");
  const tmpDir = tmpdir(), bad1 = join(tmpDir, `gate-cache-${process.pid}-1.json`), bad2 = join(tmpDir, `gate-cache-${process.pid}-2.json`);
  writeFileSync(bad1, "{\"a\": [1]"); writeFileSync(bad2, "{\"a\": 1}");
  const refusal = (path: string) => { try { readCache(path); return ""; } catch (e) { return (e as Error).message; } };
  ok(refusal(bad1).includes(bad1) && refusal(bad1).includes("not JSON") && refusal(bad2).includes("not an object of answer lists") && Object.keys(readCache(join(tmpDir, "absent-gate-cache.json"))).length === 0, "a cache that is not JSON, or not an object of answer lists, is refused by name; an absent one is empty");
  const badGrades = join(tmpDir, `gate-grades-${process.pid}.json`);
  writeFileSync(badGrades, JSON.stringify({ generated: "g", origin: "o", note: "n", mentions: [{ thought: "x" }] }));
  ok(refuses(() => readGateGrades(badGrades)).startsWith(badGrades), "a grades file that fails validation is refused naming its path");
  rmSync(bad1); rmSync(bad2); rmSync(badGrades);

  // The grades: the shape, and the committed file when it is there.
  const good = { generated: "g", origin: "o", note: "n", mentions: [{ thought: A, entity: B, valid: 1, type: 3, grader_a: [1, 3], grader_b: [1, 2] }] };
  ok(validateGateGrades(good).length === 0, "a sound grades file validates");
  const row = good.mentions[0], C = "10000000-0000-4000-8000-00000000000c";
  const bad = validateGateGrades({ generated: "", note: "", mentions: [
    { ...row, valid: 0 }, { ...row, entity: C, type: 6 }, { ...row, entity: "x" }, { ...row, entity: C, thought: `x${A}` }, { ...row, entity: C, thought: A.toUpperCase().replace("10000000", "1000000A") },
    { ...row, entity: C, valid: 1, type: -1 }, { ...row, entity: C, valid: 2 }, { ...row, entity: C, type: 1.5 },
    { ...row, entity: C, grader_a: [1] }, { ...row, entity: C, grader_b: [2, 1] }, { ...row, entity: C, grader_b: [1, 1.5] }, null, { ...row }, "a row", { ...row, entity: C, grader_a: [1, 3, 3] }, { ...row, entity: C, grader_a: [1, -1] },
  ] });
  const expect = ["generated is missing", "origin is missing", "note is missing", "mentions[0]: valid 0 with type 3", "mentions[1]: type 6 is not an index", `mentions[2]: "x" is not a lower-case id`, `mentions[3]: "x${A}" is not a lower-case id`, "mentions[4]: ", "mentions[5]: valid 1 with type -1", "mentions[6]: valid 2 is not 0 or 1", "mentions[7]: type 1.5 is not an index", "mentions[8]: grader_a is not [valid, type]", "mentions[9]: grader_b is not [valid, type]", "mentions[10]: grader_b is not [valid, type]", "mentions[11] is not an object", "mentions[12]: ", "is graded twice", "mentions[13] is not an object", "mentions[14]: grader_a is not [valid, type]", "mentions[15]: grader_a is valid 1 with type -1"];
  const unmet = expect.filter((e) => !bad.some((p) => p.includes(e)));
  ok(unmet.length === 0, `each rule refuses by name: a missing label, an invalid row with a type and a valid one without, a type off the vocabulary or not an integer, a validity not 0/1, a bad id in either column (unanchored, upper case), each grader's label of the wrong shape or values, a row that is not an object, a duplicate (unmet: ${unmet.join("; ") || "none"})`);
  ok(validateGateGrades(null)[0] === "the fixture is not an object" && validateGateGrades([])[0] === "the fixture is not an object" && validateGateGrades({ generated: "g", origin: "o", note: "n" }).includes("mentions is not an array"), "a fixture that is not an object, or has no mentions array, is a problem and not a throw");
  // Rubric v2: the categories agree with validity, all three or none; --strict-code turns a code artifact into junk.
  const v2row = { ...row, category: 2, category_a: 2, category_b: 5, grader_b: [0, -1] };
  ok(validateGateGrades({ ...good, mentions: [v2row] }).length === 0, "a rubric-v2 row, a code artifact one grader called generic, validates");
  const v2bad = validateGateGrades({ ...good, mentions: [{ ...v2row, category: 4 }, { ...v2row, entity: C, category_b: 2 }, { ...v2row, entity: A, category: 7 }, (({ category_a, ...r }) => ({ ...r, thought: C }))(v2row), { ...v2row, thought: C, entity: C, category: 1.5 }] });
  const v2expect = ["mentions[0]: category 4 with valid 1", "mentions[1]: category_b 2 with grader_b 0", "mentions[2]: category 7 is not a category", "mentions[3]: category_a undefined is not a category", "mentions[4]: category 1.5 is not a category"];
  const v2unmet = v2expect.filter((e) => !v2bad.some((p) => p.includes(e)));
  ok(v2unmet.length === 0, `a category that disagrees with its validity, one off the list, or one missing beside the others is refused by name (unmet: ${v2unmet.join("; ") || "none"})`);
  const strict = strictCode({ ...v2row, valid: 1, type: 3, grader_a: [1, 3], grader_b: [0, -1] } as GradedMention);
  ok(strict.valid === 0 && strict.type === -1 && strict.grader_a[0] === 0 && strict.grader_b[0] === 0 && strictCode({ ...v2row, category: 0, category_a: 0 } as GradedMention).valid === 1, "--strict-code reads a code artifact as junk, for the adjudication and each grader, and leaves a named entity valid");
  const split = strictCode({ ...v2row, category: 2, category_a: 0, category_b: 2, grader_a: [1, 3], grader_b: [1, 3] } as GradedMention);
  const splitB = strictCode({ ...v2row, category: 0, category_a: 0, category_b: 2, grader_a: [1, 3], grader_b: [1, 3] } as GradedMention);
  ok(split.valid === 0 && split.grader_a[0] === 1 && split.grader_b[0] === 0 && splitB.valid === 1 && splitB.grader_a[0] === 1 && splitB.grader_b[0] === 0, "--strict-code reads each grader by that grader's own category, not the adjudication's");
  ok(refuses(() => readGateGrades(GATE_GRADES_PATH, { strictCode: true })).includes("needs rubric v2's categories"), "--strict-code on grades without categories is refused, not read as all-named");
  ok(splitOf(A) === "test" && splitOf("10000000-0000-4000-8000-000000000003") === "dev", "the split is pinned: md5's first hex digit below 8 is dev");
  const wtext = `${"x".repeat(500)}The Name${"y".repeat(500)}`;
  const win = (t: string, n: string) => windowAround(t, n);
  ok(win(wtext, "the name").context === `${"x".repeat(400)}The Name${"y".repeat(400)}` && win(wtext, "the name").inWindow && win("short The Name text", "the name").context === "short The Name text" && win(wtext, "absent").context === wtext.slice(0, 800) && !win(wtext, "absent").inWindow, "the window: 400 characters either side of the first place the name appears, found without case, clipped at the ends; the head, and not in the window, when the text lacks the name");
  const dotted = `${"İ".repeat(500)} see Bun here`;
  ok(win(dotted, "bun").inWindow && win(dotted, "bun").context.includes("Bun") && win("a+b (c) and more", "(c)").inWindow && win("a+b (c) and more", "a+b").inWindow && win("x [y z", "[y").inWindow && win(`Bun first${"-".repeat(900)}bun again`, "BUN").context.startsWith("Bun first"), "the name is found on the text itself: a character whose lower case is longer (İ) does not misplace the window, and a name's regex characters are literal");
  if (existsSync(GATE_GRADES_PATH)) {
    const g = readGateGrades();
    const n = g.mentions.length, dev = g.mentions.filter((m) => splitOf(m.thought) === "dev").length;
    ok(n === 201 && dev === 111, `the committed grades validate: the pre-registered 201 mentions, 111 of them dev (${dev} dev of ${n})`);
    ok(g.mentions.every((m) => m.valid === m.grader_a[0] || m.valid === m.grader_b[0]), "every adjudicated validity is one grader's: adjudication picks, it does not invent");
  }
  if (existsSync(GATE_GRADES_V2_PATH)) {
    const v1 = readGateGrades(), v2 = readGateGrades(GATE_GRADES_V2_PATH);
    ok(v2.mentions.length === v1.mentions.length && v2.mentions.every((m, i) => m.thought === v1.mentions[i].thought && m.entity === v1.mentions[i].entity && m.category !== undefined), "rubric v2 grades the same 201 mentions in the same order, each with a category");
    ok(v2.mentions.every((m) => m.category === m.category_a || m.category === m.category_b), "every adjudicated v2 category is one grader's");
    ok(readGateGrades(GATE_GRADES_V2_PATH, { strictCode: true }).mentions.filter((m) => m.valid).length === v2.mentions.filter((m) => m.valid && m.category !== CODE_ARTIFACT).length, "--strict-code on the committed v2 grades drops exactly the code artifacts");
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
    const numericN = Number(arg("--numeric") ?? 60), costThoughts = Number(arg("--cost-thoughts") ?? 40);
    if (!url || !Number.isInteger(numericN) || numericN < 1 || !Number.isInteger(costThoughts) || costThoughts < 0) {
      console.error("usage: bun eval-jev-gate.ts --url postgres://… [--numeric 60] [--cost-thoughts 40] [--cache <file>] [--grades <file> [--strict-code]] | --diagnose [--cache <file>] | --dump-sample <file> | --self-check");
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
    } else if (process.argv.includes("--diagnose")) await diagnose(url, arg("--cache"));
    else await report(url, numericN, costThoughts, arg("--cache"), arg("--grades") ?? GATE_GRADES_PATH, process.argv.includes("--strict-code"));
  }
}
