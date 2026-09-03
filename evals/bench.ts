#!/usr/bin/env bun
/**
 * bench.ts — one command to judge a new model against what is already recorded.
 *
 * The individual harnesses measure; this decides. Before it existed, evaluating a
 * candidate meant knowing which of six scripts applied, remembering the right
 * suffix flags, and diffing the output against a table in a markdown file by eye.
 * Every model comparison in evals/README.md was done that way, and the ordering
 * changed often enough that doing it by hand was the wrong shape.
 *
 *   bun bench.ts qwen3-embedding:4b@1024      # embedding candidate
 *   bun bench.ts qwen2.5:7b                   # extraction candidate
 *   bun bench.ts some-new-model               # kind is detected, not declared
 *   bun bench.ts --list                       # what is already recorded
 *   bun bench.ts <model> --rebaseline         # write the result into baselines.json
 *
 * It answers three questions in order: does it beat the current default, where
 * does it land in the recorded field, and is the difference big enough to mean
 * anything. The third matters most — a corpus of this size cannot resolve small
 * gaps, so the verdict says so rather than reporting four decimal places and
 * letting them look like precision.
 */

import { join, dirname } from "node:path";
import { parseSpec } from "./lib.ts";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";
const BASELINES = join(HERE, "baselines.json");

type EmbedResult = { mrr: number; r1: number; sec: number; gb?: number };
type ExtractResult = { total: number; perCapture: number; gb?: number; failures: number };
type Baselines = {
  defaults: { embedding: string; embeddingDim: number; metadata: string };
  embedding: { results: Record<string, EmbedResult> };
  extraction: { max: number; results: Record<string, ExtractResult> };
};

const baselines: Baselines = await Bun.file(BASELINES).json();
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const model = args.find((a) => !a.startsWith("--"));

if (flags.has("--list") || !model) {
  // Sort by SCORE, then format. Sorting the formatted strings orders them by
  // model name, which looks like a ranking and is not one.
  const table = <T extends { gb?: number }>(
    o: Record<string, T>,
    rank: (v: T) => number,
    show: (v: T) => string,
    dflt: string
  ) =>
    Object.entries(o)
      .sort((a, b) => rank(b[1]) - rank(a[1]))
      .map(([k, v]) => `    ${(k.startsWith(dflt) ? `${k} *` : k).padEnd(34)} ${show(v)}  ${v.gb ?? "?"} GB`)
      .join("\n");

  console.log("\n  Embedding — MRR on the retrieval corpus\n");
  console.log(table(baselines.embedding.results, (v) => v.mrr, (v) => v.mrr.toFixed(3), baselines.defaults.embedding));
  console.log("\n  Extraction — score out of 84\n");
  console.log(table(baselines.extraction.results, (v) => v.total, (v) => `${v.total}/84`, baselines.defaults.metadata));
  console.log("\n  * = current default");
  console.log(`\n  defaults: ${baselines.defaults.embedding} @ ${baselines.defaults.embeddingDim} + ${baselines.defaults.metadata}\n`);
  process.exit(0);
}

/**
 * Detect rather than declare. An embedding model answers /embeddings and refuses
 * /chat/completions; a chat model does the reverse. Asking the provider is more
 * reliable than a naming convention — `qwen3-embedding:4b` and `embeddinggemma`
 * share no pattern, and a new family will share neither.
 */
const bare = parseSpec(model).name;
async function detectKind(): Promise<"embedding" | "extraction"> {
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: bare, input: "probe" }),
  });
  if (r.ok) return "embedding";
  const body = await r.text();
  if (/not found|no such model|pull the model/i.test(body)) {
    console.error(`\n  ${bare} is not available at ${BASE}.\n  Try: ollama pull ${bare}\n`);
    process.exit(2);
  }
  return "extraction";
}

function run(script: string, argv: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(["bun", join(HERE, script), ...argv], {
    env: { ...process.env, OB1_EVAL_TEMP: "0", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const out = p.stdout.toString();
  if (!out.trim()) { console.error(p.stderr.toString().slice(-800)); process.exit(1); }
  return out;
}

/**
 * How much difference is real. The retrieval corpus is 97 queries, so one query
 * changing hands moves MRR by roughly 0.01; the extraction set is 84 points, where
 * a point is one field on one capture. Anything inside that is noise dressed as a
 * result, and this file says so rather than ranking on it.
 */
const EMBED_NOISE = 0.01;
const EXTRACT_NOISE = 2;

const kind = await detectKind();
console.log(`\n  ${model} — detected as ${kind}, measuring against ${BASE}\n`);

if (kind === "embedding") {
  const out = run("eval-real.ts", [model]);
  const line = out.split("\n").find((l) => l.includes(bare) && /0\.\d{3}/.test(l));
  if (!line) { console.error(out); process.exit(1); }
  const nums = line.match(/(\d+)%\s+(\d+)%\s+(0\.\d+)\s+([\d.]+)/);
  if (!nums) { console.error(out); process.exit(1); }
  const got: EmbedResult = { r1: Number(nums[1]) / 100, mrr: Number(nums[3]), sec: Number(nums[4]) };

  const dflt = baselines.defaults.embedding;
  const dkey = Object.keys(baselines.embedding.results).find((k) => k.startsWith(dflt));
  const dv = dkey ? baselines.embedding.results[dkey] : undefined;
  const field = Object.entries(baselines.embedding.results).sort((a, b) => b[1].mrr - a[1].mrr);
  const rank = field.filter(([, v]) => v.mrr > got.mrr).length + 1;

  console.log(`  MRR ${got.mrr.toFixed(3)}   R@1 ${(got.r1 * 100).toFixed(0)}%   ${got.sec.toFixed(1)}s`);
  console.log(`  rank ${rank} of ${field.length + 1} recorded\n`);
  if (dv) {
    const d = got.mrr - dv.mrr;
    const verdict = Math.abs(d) < EMBED_NOISE
      ? `indistinguishable from the default (${d >= 0 ? "+" : ""}${d.toFixed(3)}, under the ${EMBED_NOISE} noise floor)`
      : d > 0
        ? `BEATS the default by ${d.toFixed(3)} MRR`
        : `loses to the default by ${(-d).toFixed(3)} MRR`;
    console.log(`  vs ${dkey} (default, ${dv.mrr.toFixed(3)}): ${verdict}`);
    if (d > EMBED_NOISE) {
      const r = got.sec / dv.sec;
      console.log(r < 1
        ? `  and ${(1 / r).toFixed(1)}x FASTER — worth switching.`
        : `  ${r.toFixed(1)}x the embedding time.`);
      console.log(`  Switching costs a schema migration plus re-embedding every existing row.`);
    }
  }
} else {
  const out = run("eval-extraction.ts", [model]);
  const line = out.split("\n").find((l) => l.includes(bare) && /\d+\/84/.test(l));
  if (!line) { console.error(out); process.exit(1); }
  const m = line.match(/(\d+)\/84\s+([\d.]+)/);
  if (!m) { console.error(out); process.exit(1); }
  const failLine = out.split("\n").find((l) => l.trim().startsWith(bare) && !/\d+\/84/.test(l)) ?? "";
  const clean = /none/.test(failLine);
  const got: ExtractResult = { total: Number(m[1]), perCapture: Number(m[2]) / 14, failures: clean ? 0 : 1 };

  const dflt = baselines.defaults.metadata;
  const dv = baselines.extraction.results[dflt];
  const field = Object.entries(baselines.extraction.results).sort((a, b) => b[1].total - a[1].total);
  const rank = field.filter(([, v]) => v.total > got.total).length + 1;

  console.log(`  ${got.total}/84   ${got.perCapture.toFixed(2)}s per capture   structural failures: ${clean ? "none" : "SOME"}`);
  console.log(`  rank ${rank} of ${field.length + 1} recorded\n`);
  if (dv) {
    const d = got.total - dv.total;
    const verdict = Math.abs(d) < EXTRACT_NOISE
      ? `indistinguishable from the default (${d >= 0 ? "+" : ""}${d}, under the ${EXTRACT_NOISE}-point noise floor)`
      : d > 0 ? `BEATS the default by ${d} points` : `loses to the default by ${-d} points`;
    console.log(`  vs ${dflt} (default, ${dv.total}/84): ${verdict}`);
    const ratio = got.perCapture / dv.perCapture;
    console.log(ratio < 1
      ? `  ${(1 / ratio).toFixed(1)}x FASTER per capture`
      : `  ${ratio.toFixed(1)}x the capture latency`);
    if (!clean) {
      console.log(`\n  Structural failures disqualify regardless of score: an invented person or a`);
      console.log(`  capture with no topics corrupts thought_stats and list_thoughts filters.`);
    }
  }
  console.log(`\n  The metadata model has no schema dependency — changing it costs nothing.`);
}

if (flags.has("--rebaseline")) {
  console.log(`\n  --rebaseline: edit ${BASELINES} by hand.`);
  console.log(`  Deliberately not automatic: a baseline written from a single run on a corpus`);
  console.log(`  nobody reviewed is how a benchmark quietly starts measuring the wrong thing.`);
}
console.log("");
