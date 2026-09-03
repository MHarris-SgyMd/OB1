#!/usr/bin/env bun
/**
 * eval-embed2.ts — a benchmark that actually discriminates.
 *
 * v1 was saturated: everything scored 85–95% and a 45 MB model tied a 669 MB one.
 * Short one-line thoughts with distinct topics are easy, so the test measured
 * nothing. Three additions, each targeting a real failure mode:
 *
 *   NEAR-DUPLICATES. Clusters of thoughts on the same subject where only one
 *   answers the query. This is what a growing brain looks like — the tenth note
 *   about certificates — and it needs discrimination, not topic matching.
 *
 *   LONG DOCUMENTS with the answer at the END. Context windows here span 512 to
 *   8192 tokens. A 512-token model silently truncates a long thought and the tail
 *   becomes unsearchable, with no error anywhere. Short test docs hide that
 *   completely.
 *
 *   TEMPORAL / NUMERIC specificity, where the distractor is lexically closer than
 *   the answer.
 *
 * Reported per-slice, because an average over easy and hard queries hides exactly
 * the thing worth knowing.
 */

/**
 * Any OpenAI-compatible endpoint. Ollama by default, but the point of the
 * indirection is that the *hosted* defaults this fork inherited can be measured
 * on the same corpus as the local ones — otherwise the comparison is a leaderboard
 * citation, not a measurement.
 *
 *   OB1_EVAL_BASE=https://openrouter.ai/api/v1 OB1_EVAL_KEY=sk-or-… bun eval-retrieval.ts \
 *     openai/text-embedding-3-small qwen/qwen3-embedding-8b
 */

import { DOCS, QUERIES, SLICES } from "./corpus.ts";
import { embed, cosine, EVAL_BASE } from "./lib.ts";



async function evaluate(model: string) {
  const t0 = Date.now();
  const vecs: Record<string, number[]> = {};
  for (const d of DOCS) vecs[d.id] = await embed(model, d.text);
  const dims = vecs[DOCS[0].id].length;

  const per: Record<string, { n: number; hit1: number; mrr: number }> = {};
  for (const s of SLICES) per[s] = { n: 0, hit1: 0, mrr: 0 };
  const misses: string[] = [];

  for (const { q, want, slice } of QUERIES) {
    const qv = await embed(model, q, true);
    const ranked = DOCS.map((d) => ({ id: d.id, s: cosine(qv, vecs[d.id]) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((r) => r.id === want) + 1;
    per[slice].n++;
    if (rank === 1) per[slice].hit1++;
    per[slice].mrr += 1 / rank;
    if (rank !== 1) misses.push(`${slice}: "${q.slice(0, 44)}" → wanted ${want} (rank ${rank}), got ${ranked[0].id}`);
  }

  const overall = SLICES.reduce((a, s) => a + per[s].mrr, 0) / QUERIES.length;
  return { model, dims, per, overall, misses, seconds: (Date.now() - t0) / 1000 };
}

const models = process.argv.slice(2);
const results = [];
for (const m of models) {
  process.stderr.write(`  … ${m}\n`);
  try { results.push(await evaluate(m)); }
  catch (e) { process.stderr.write(`  ✗ ${m}: ${(e as Error).message}\n`); }
}

console.log(`\n  ${DOCS.length} thoughts, ${QUERIES.length} queries — R@1 per slice, then overall MRR\n`);
console.log("  model                       dims  " + SLICES.map((s) => s.padStart(9)).join("") + "   MRR    sec");
console.log("  " + "─".repeat(88));
for (const r of results.sort((a, b) => b.overall - a.overall)) {
  const cells = SLICES.map((s) => {
    const p = r.per[s];
    return `${p.hit1}/${p.n}`.padStart(9);
  }).join("");
  console.log(`  ${r.model.padEnd(27)} ${String(r.dims).padStart(4)}  ${cells}   ${r.overall.toFixed(3)}  ${r.seconds.toFixed(1).padStart(5)}`);
}

for (const r of results) {
  if (!r.misses.length) continue;
  console.log(`\n  ${r.model} missed ${r.misses.length}:`);
  for (const m of r.misses) console.log(`    ${m}`);
}
