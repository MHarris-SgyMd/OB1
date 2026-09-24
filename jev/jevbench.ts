#!/usr/bin/env bun
/**
 * jevbench.ts — which choice framing to serve, measured on JevBench's public
 * tasks (SMD-2050).
 *
 * The receipt run (conformance.ts) found the v1.4 engine's `It is {option}`
 * labels cost ~2 points on the author's in-domain banking set, while the
 * engine's README says the same framing lifts JevBench's open-domain accuracy
 * 2–7 points. JevBench ran the same weights through both engines as two rows —
 * "openJev Verdict" (engine 33950bf: bare labels, a 1,024-token budget, no
 * calibrator) and "openJev Verdict 1.4" (engine 00b5ee96, PR #3: `It is`
 * labels for choices, 512 tokens, the calibrator) — and publishes each row's
 * right/wrong on its 231 public tasks. So this does two things, on the
 * benchmark's own files fetched pinned (commit and sha256), with no model call
 * outside this runtime:
 *
 * 1. Reproduce both rows task by task — the conformance question again, on
 *    open-domain tasks and both engines. Right/wrong is the argmax over the
 *    task's own options (JevBench's adapter drops the abstention slot and
 *    renormalizes), which no positive temperature moves, so it reproduces
 *    whichever calibrator the run loaded.
 * 2. Compare the framing alone — bare against `It is`, both at the 512-token
 *    budget the tier serves — per tier, paired on the same tasks (McNemar's
 *    exact test on the tasks where the two disagree).
 *
 * The prompt rules are the adapter's (jevbench/adapters/verdict_local.py)
 * through the author's core/formatting.py at each commit: a choice is
 * Choice(question=instructions, options=criteria in its own order), a score is
 * levels `{text} (Value: {i}.0)`, a noul the proposition with its criteria
 * appended; a structured state is Python's json.dumps(…, ensure_ascii=False).
 * Only the choice labels differ between the engines; the token budget does too.
 *
 *   bun jevbench.ts <model dir>
 */

import { ensureModel, type ModelPins } from "./fetch-model.ts";
import { INSUFFICIENT_LABEL, LABEL_MARKER, loadVerdict, SEP_MARKER, truncate, type Encoder, type Runner } from "./verdict.ts";

const JEVBENCH = "fstandhartinger/jevbench";
const PATHS: Record<string, string> = {
  "easy.jsonl": "datasets/public/easy.jsonl",
  "original.jsonl": "datasets/public/original.jsonl",
  "hard.jsonl": "datasets/public/hard.jsonl",
  "openjev-verdict-per-task.json": "results/v1.2/additions/openjev-verdict-per-task.json",
  "openjev-verdict-1.4-per-task.json": "results/v1.2/additions/openjev-verdict-1.4-per-task.json",
};
export const JEVBENCH_PINS: ModelPins = {
  repo: JEVBENCH,
  revision: "2fa63fa3226cb369795525ed011800f57dcbd894",
  files: {
    "easy.jsonl": { bytes: 37_220, sha256: "231df3c2c8e88a1a8c137ebe85de96ba70fabd330849098ac7b3c52c70b7172b" },
    "original.jsonl": { bytes: 57_237, sha256: "5c2414edb3006b8bfcb70fda433f0f9ca015759433849f8d3104328a1f7c4180" },
    "hard.jsonl": { bytes: 651_848, sha256: "89e9e6becb33ed88c1de7d42dcc87531b2fb64cfaef4e1986faf7c37b3f80ebb" },
    "openjev-verdict-per-task.json": { bytes: 10_131, sha256: "d11092b5bd451ae11c3954b70dbbfa85609958435d30aa9e4c302b527cf092df" },
    "openjev-verdict-1.4-per-task.json": { bytes: 10_110, sha256: "ddf01d4a1f9962e971d1be1aa23cafd76779c772fd6abbb8d7b4ee99a4e49edb" },
  },
  url: (name) => `https://raw.githubusercontent.com/${JEVBENCH}/${JEVBENCH_PINS.revision}/${PATHS[name]}`,
};

/** The public tiers as the per-task files and the v1.4 README count them: the "original" set is the standard tier. */
export const TIERS = { "easy.jsonl": "easy", "original.jsonl": "standard", "hard.jsonl": "hard" } as const;
export type Tier = (typeof TIERS)[keyof typeof TIERS];

type Task = {
  id: string;
  tier: Tier;
  state: unknown;
  expected: string | number;
  question: { type: "choice" | "score" | "noul"; instructions: string; criteria?: Record<string, string> | string[] | null };
};

/**
 * Python's json.dumps(value, ensure_ascii=False) for what JevBench states hold:
 * ", " and ": " separators, strings escaped as JSON (Python and JSON agree on
 * the escapes ensure_ascii=False keeps), no floats (none in the public set —
 * checked; JavaScript cannot tell 1.0 from 1, so a float would be refused).
 */
export function pyDumps(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`pyDumps: a float (${v}) cannot be written as Python writes it from a parsed value`);
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyDumps).join(", ")}]`;
  if (typeof v === "object") return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyDumps(x)}`).join(", ")}}`;
  throw new Error(`pyDumps: ${typeof v}`);
}

export type Framing = "bare" | "it-is";
export const ABSTAIN = "__insufficient_evidence__";

/** The prompt the adapter's query becomes in the author's engine, and the option ids in slot order. */
export function jevbenchPrompt(t: Task, framing: Framing): { prompt: string; ids: string[] } {
  const state = typeof t.state === "string" ? t.state : pyDumps(t.state);
  const q = t.question;
  const withLabels = (labels: string[], text: string) => `${[...labels, INSUFFICIENT_LABEL].map((l) => `${LABEL_MARKER}${l}`).join("")}${SEP_MARKER}${text}`;
  const asked = `Question: ${q.instructions}\n\nContext:\n${state}`;
  if (q.type === "choice") {
    const opts = Object.entries(q.criteria as Record<string, string>).map(([k, v]) => ({ id: k, desc: v || k }));
    return { prompt: withLabels(opts.map((o) => (framing === "it-is" ? `It is ${o.desc}` : o.desc)), asked), ids: [...opts.map((o) => o.id), ABSTAIN] };
  }
  if (q.type === "score") {
    const levels = q.criteria as string[];
    // Level(value=float(i)) and f"{description} (Value: {value})": Python writes the float as 0.0.
    return { prompt: withLabels(levels.map((d, i) => `${String(d)} (Value: ${i}.0)`), asked), ids: [...levels.map((_, i) => String(i)), ABSTAIN] };
  }
  const c = (q.criteria ?? {}) as Record<string, string>;
  const prop = q.instructions + (c.true || c.false ? ` (true: ${c.true || "yes"}; false: ${c.false || "no"})` : "");
  return { prompt: withLabels([`true: ${prop}`, `false: not ${prop}`], `Context:\n${state}\n\nEvaluate proposition: ${prop}`), ids: ["true", "false", ABSTAIN] };
}

export type Arm = { framing: Framing; maxTokens: number };
export type TaskOutcome = { id: string; tier: Tier; correct: boolean; truncated: boolean };

/** Right or wrong per task: the argmax over the task's own options, the abstention slot dropped. */
export async function runArm(tasks: Task[], encoder: Encoder, run: Runner, arm: Arm): Promise<TaskOutcome[]> {
  const out: TaskOutcome[] = [];
  for (const t of tasks) {
    const { prompt, ids } = jevbenchPrompt(t, arm.framing);
    const cut = truncate(encoder.encode(prompt).ids, arm.maxTokens);
    const logits = await run(BigInt64Array.from(cut.ids, BigInt), new BigInt64Array(cut.ids.length).fill(1n));
    let top = -1;
    for (let i = 0; i < ids.length; i++) if (ids[i] !== ABSTAIN && (top < 0 || logits[i] > logits[top])) top = i;
    const want = t.question.type === "noul" ? (t.expected === "yes" ? "true" : "false") : String(t.expected);
    out.push({ id: t.id, tier: t.tier, correct: ids[top] === want, truncated: cut.truncated });
  }
  return out;
}

export type Published = Map<string, boolean>;

export async function loadJevbench(modelDir: string, opts: { log?: (l: string) => void } = {}) {
  const dir = `${modelDir}/jevbench`;
  await ensureModel(dir, { pins: JEVBENCH_PINS, log: opts.log });
  const tasks: Task[] = [];
  for (const [file, tier] of Object.entries(TIERS)) {
    for (const line of (await Bun.file(`${dir}/${file}`).text()).trim().split("\n")) tasks.push({ ...JSON.parse(line), tier });
  }
  const published = async (f: string): Promise<Published> =>
    new Map(Object.entries(((await Bun.file(`${dir}/${f}`).json()) as { public_tasks: Record<string, [string, number]> }).public_tasks).map(([id, [cw]]) => [id, cw === "c"]));
  const { encoder, run } = await loadVerdict(modelDir, { threads: 4 });
  return { tasks, encoder, run, earlier: await published("openjev-verdict-per-task.json"), v14: await published("openjev-verdict-1.4-per-task.json") };
}

/** How many tasks an arm scores as the published row does, and which do not. */
export function agreement(outcomes: TaskOutcome[], published: Published): { agree: number; differ: string[] } {
  const differ = outcomes.filter((o) => published.get(o.id) !== o.correct).map((o) => `${o.id} (ours ${o.correct ? "right" : "wrong"})`);
  return { agree: outcomes.length - differ.length, differ };
}

/** Accuracy per tier and overall. */
export function byTier(outcomes: TaskOutcome[]): Record<Tier | "all", { correct: number; n: number }> {
  const acc = { easy: { correct: 0, n: 0 }, standard: { correct: 0, n: 0 }, hard: { correct: 0, n: 0 }, all: { correct: 0, n: 0 } };
  for (const o of outcomes) for (const k of [o.tier, "all"] as const) { acc[k].n++; if (o.correct) acc[k].correct++; }
  return acc;
}

/** McNemar's exact two-sided test: b tasks only A gets right, c only B does. */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0, coef = 1; // C(n, 0)
  for (let i = 0; i <= Math.min(b, c); i++) {
    tail += coef;
    coef = (coef * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: bun jevbench.ts <model dir>");
    process.exit(2);
  }
  const j = await loadJevbench(dir, { log: (m) => console.log(`jevbench: ${m}`) });
  const arms: [string, Arm, Published | null][] = [
    ["earlier engine (bare, 1024)", { framing: "bare", maxTokens: 1024 }, j.earlier],
    ["v1.4 engine (It is, 512) — served", { framing: "it-is", maxTokens: 512 }, j.v14],
    ["bare, 512", { framing: "bare", maxTokens: 512 }, null],
  ];
  const results = new Map<string, TaskOutcome[]>();
  for (const [name, arm, pub] of arms) {
    const t0 = performance.now();
    const o = await runArm(j.tasks, j.encoder, j.run, arm);
    results.set(name, o);
    const tiers = byTier(o);
    const line = (Object.entries(tiers) as [string, { correct: number; n: number }][]).map(([k, v]) => `${k} ${v.correct}/${v.n} (${((100 * v.correct) / v.n).toFixed(1)}%)`).join("  ");
    console.log(`\n${name}: ${line}  [${((performance.now() - t0) / 1000).toFixed(1)} s, ${o.filter((x) => x.truncated).length} truncated]`);
    if (pub) {
      const a = agreement(o, pub);
      const pubTiers = byTier(o.map((x) => ({ ...x, correct: pub.get(x.id)! })));
      console.log(`  published row: ${(Object.entries(pubTiers) as [string, { correct: number; n: number }][]).map(([k, v]) => `${k} ${v.correct}/${v.n}`).join("  ")}`);
      console.log(`  task-by-task agreement with the published row: ${a.agree}/${o.length}${a.differ.length ? ` — ${a.differ.slice(0, 8).join(", ")}` : ""}`);
    }
  }
  const A = results.get("bare, 512")!, B = results.get("v1.4 engine (It is, 512) — served")!;
  console.log("\nframing alone, both at 512 tokens (bare vs It is), paired:");
  for (const tier of ["easy", "standard", "hard", "all"] as const) {
    const pairs = A.map((a, i) => [a, B[i]] as const).filter(([a]) => tier === "all" || a.tier === tier);
    const onlyBare = pairs.filter(([a, b]) => a.correct && !b.correct).length, onlyItIs = pairs.filter(([a, b]) => !a.correct && b.correct).length;
    const accA = pairs.filter(([a]) => a.correct).length, accB = pairs.filter(([, b]) => b.correct).length;
    console.log(`  ${tier.padEnd(8)} n=${String(pairs.length).padStart(3)}  bare ${((100 * accA) / pairs.length).toFixed(1)}%  It is ${((100 * accB) / pairs.length).toFixed(1)}%  Δ ${(((accB - accA) * 100) / pairs.length).toFixed(1)} pts  only-bare ${onlyBare}  only-It-is ${onlyItIs}  McNemar p ${mcnemar(onlyBare, onlyItIs).toFixed(3)}`);
  }
}
