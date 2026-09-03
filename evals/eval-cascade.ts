#!/usr/bin/env bun
/**
 * eval-cascade.ts — is a second retrieval tier worth its latency?
 *
 * eval-retrieval.ts shows the three best embedding models plateau at 0.975 MRR
 * and fail the SAME query:
 *
 *   "which certificate do I have to renew by hand?"
 *     wanted  cert-staging  "Renew the SSL certificate for the staging cluster…"
 *     got     cert-prod     "…auto-renews through cert-manager, so it needs no
 *                            manual action."
 *
 * The distractor is lexically closer — it contains "manual" — but states the
 * negation of what was asked. A bi-encoder embeds query and document separately
 * and never gets to compare them, so polarity is exactly what it cannot see.
 * Scaling the encoder does not help: qwen3-embedding:4b scores five points higher
 * on MTEB and misses the identical query.
 *
 * A cross-encoder tier sees both texts at once. This measures whether that pays,
 * against the only thing that matters for an interactive tool: what it costs in
 * wall-clock time.
 *
 *   TIER 1  embed the query, HNSW top-K            (the current behaviour)
 *   TIER 2  a local LLM reorders those K candidates
 *
 * Reports MRR and R@1 for tier 1 alone and the cascade, plus the per-query
 * latency of each stage, because a second tier that triples search latency to fix
 * one query in twenty is not obviously a good trade.
 */


const EMBED = process.env.OB1_EVAL_EMBED ?? "embeddinggemma";
const RERANK = process.env.OB1_EVAL_RERANK ?? "qwen2.5:7b";
const TOPK = Number(process.env.OB1_EVAL_TOPK ?? 5);
/**
 * Escalate to tier 2 only when tier 1 looks unsure — i.e. when the gap between the
 * best and second-best cosine is below this. A confident top hit does not need a
 * second opinion, and paying 3s for one is the difference between a tool that
 * feels instant and one that does not.
 */
const MARGIN = Number(process.env.OB1_EVAL_MARGIN ?? 0);

/** Same corpus as eval-retrieval.ts, imported rather than duplicated. */
import { DOCS, QUERIES, SLICES } from "./corpus.ts";
import { embed, cosine, EVAL_BASE, EVAL_HEADERS } from "./lib.ts";



/**
 * Listwise rerank. The candidates are numbered and the model returns an ordering,
 * which is one call for the whole list rather than one per candidate — the
 * difference between ~1s and ~5s of added latency at K=5.
 */
async function rerank(query: string, cands: { id: string; text: string }[]): Promise<string[]> {
  const numbered = cands.map((c, i) => `[${i + 1}] ${c.text}`).join("\n");
  const r = await fetch(`${EVAL_BASE}/chat/completions`, {
    method: "POST", headers: EVAL_HEADERS,
    body: JSON.stringify({
      model: RERANK,
      temperature: 0,
      reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          `Rank the numbered notes by how well each ANSWERS the question. Pay close ` +
          `attention to negation and polarity: a note saying something needs no action ` +
          `does not answer a question asking what needs action. Return JSON ` +
          `{"order": [numbers, best first]} containing every number exactly once.` },
        { role: "user", content: `Question: ${query}\n\nNotes:\n${numbered}` },
      ],
    }),
  });
  if (!r.ok) return cands.map((c) => c.id);
  const raw = (await r.json())?.choices?.[0]?.message?.content;
  try {
    const order = JSON.parse(String(raw))?.order;
    if (!Array.isArray(order)) return cands.map((c) => c.id);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of order) {
      const c = cands[Number(n) - 1];
      if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c.id); }
    }
    for (const c of cands) if (!seen.has(c.id)) out.push(c.id);  // never drop a candidate
    return out;
  } catch { return cands.map((c) => c.id); }
}

/**
 * TIER 0 — lexical BM25, in-process, no model call at all.
 *
 * Worth testing before an expensive reranker because it is effectively free, and
 * because bi-encoders are known to miss exact tokens: names, error codes, IDs. If
 * a ~0ms tier recovers what a 1.2s tier recovers, the expensive one is not needed.
 * Fused with the vector ranking by Reciprocal Rank Fusion, which needs no score
 * calibration between the two — the usual reason naive hybrid scoring fails.
 */
const tok = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const DF: Record<string, number> = {};
const TF: Record<string, Record<string, number>> = {};
let avgdl = 0;
for (const d of DOCS) {
  const ts = tok(d.text);
  avgdl += ts.length;
  TF[d.id] = {};
  for (const t of ts) TF[d.id][t] = (TF[d.id][t] ?? 0) + 1;
  for (const t of new Set(ts)) DF[t] = (DF[t] ?? 0) + 1;
}
avgdl /= DOCS.length;
function bm25(q: string): { id: string; s: number }[] {
  const k1 = 1.5, b = 0.75;
  return DOCS.map((d) => {
    const dl = Object.values(TF[d.id]).reduce((a, c) => a + c, 0);
    let s = 0;
    for (const t of tok(q)) {
      const f = TF[d.id][t] ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (DOCS.length - (DF[t] ?? 0) + 0.5) / ((DF[t] ?? 0) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
    }
    return { id: d.id, s };
  }).sort((x, y) => y.s - x.s);
}
/** RRF: rank-based, so the two scales never have to be reconciled. */
function rrf(...lists: { id: string }[][]): string[] {
  const score: Record<string, number> = {};
  for (const l of lists) l.forEach((r, i) => { score[r.id] = (score[r.id] ?? 0) + 1 / (60 + i + 1); });
  return Object.keys(score).sort((a, b) => score[b] - score[a]);
}

const vecs: Record<string, number[]> = {};
for (const d of DOCS) vecs[d.id] = await embed(EMBED, d.text);

type Acc = { n: number; hit1: number; mrr: number };
const mk = (): Record<string, Acc> =>
  Object.fromEntries(SLICES.map((s) => [s, { n: 0, hit1: 0, mrr: 0 }]));
const t1 = mk(), t2 = mk(), t0 = mk(), th = mk(), tg = mk();
let msEmbed = 0, msRerank = 0;
const fixed: string[] = [], broke: string[] = [];
let escalated = 0;
const margins: { q: string; margin: number; wasWrong: boolean }[] = [];

for (const { q, want, slice } of QUERIES) {
  const a = Date.now();
  const qv = await embed(EMBED, q, true);
  const ranked = DOCS.map((d) => ({ id: d.id, s: cosine(qv, vecs[d.id]) })).sort((x, y) => y.s - x.s);
  msEmbed += Date.now() - a;

  const r1 = ranked.findIndex((r) => r.id === want) + 1;
  t1[slice].n++; t1[slice].mrr += 1 / r1; if (r1 === 1) t1[slice].hit1++;

  const lex = bm25(q);
  const r0 = lex.findIndex((r) => r.id === want) + 1;
  t0[slice].n++; t0[slice].mrr += 1 / r0; if (r0 === 1) t0[slice].hit1++;

  const hyb = rrf(ranked, lex);
  const rh = hyb.indexOf(want) + 1;
  th[slice].n++; th[slice].mrr += 1 / rh; if (rh === 1) th[slice].hit1++;

  /**
   * Gated hybrid: trust the vector ranking when it is confident, and only fuse in
   * BM25 when it is not. Ungated fusion is a net loss on this corpus — lexical
   * overlap drags down paraphrased queries the vector search already had right —
   * but the near-dup slice shows BM25 knows something the encoder does not. Gating
   * keeps that without paying for it elsewhere, and unlike the LLM tier it is free.
   */
  const marginPre = ranked[0].s - ranked[1].s;
  const gated = marginPre < MARGIN ? hyb : ranked.map((r) => r.id);
  const rg = gated.indexOf(want) + 1;
  tg[slice].n++; tg[slice].mrr += 1 / rg; if (rg === 1) tg[slice].hit1++;

  const margin = ranked[0].s - ranked[1].s;
  const escalate = MARGIN <= 0 || margin < MARGIN;
  if (escalate) escalated++;
  margins.push({ q, margin, wasWrong: r1 !== 1 });

  const cands = ranked.slice(0, TOPK).map((r) => ({ id: r.id, text: DOCS.find((d) => d.id === r.id)!.text }));
  const b = Date.now();
  const order = escalate ? await rerank(q, cands) : cands.map((c) => c.id);
  msRerank += Date.now() - b;

  // A candidate outside the top-K keeps its tier-1 rank; the cascade can only
  // reorder what tier 1 surfaced, which is the whole point of the recall budget.
  const inK = order.indexOf(want) + 1;
  const r2 = inK > 0 ? inK : r1;
  t2[slice].n++; t2[slice].mrr += 1 / r2; if (r2 === 1) t2[slice].hit1++;

  if (r1 !== 1 && r2 === 1) fixed.push(`${slice}: "${q.slice(0, 52)}"`);
  if (r1 === 1 && r2 !== 1) broke.push(`${slice}: "${q.slice(0, 52)}" → fell to rank ${r2}`);
}

const N = QUERIES.length;
const mrr = (t: Record<string, Acc>) => SLICES.reduce((a, s) => a + t[s].mrr, 0) / N;
const r1s = (t: Record<string, Acc>) => SLICES.reduce((a, s) => a + t[s].hit1, 0);

console.log(`\n  ${DOCS.length} thoughts, ${N} queries — embed=${EMBED} rerank=${RERANK} K=${TOPK}\n`);
console.log("  tier                          " + SLICES.map((s) => s.padStart(9)).join("") + "     R@1    MRR   ms/query");
console.log("  " + "─".repeat(92));
for (const [label, t, ms] of [
  ["0  BM25 lexical only", t0, 0],
  ["1  embedding only", t1, msEmbed / N],
  ["0+1 hybrid (RRF, always)", th, msEmbed / N],
  [`0+1 hybrid (gated <${MARGIN})`, tg, msEmbed / N],
  [`1+2 cascade (top-${TOPK})`, t2, (msEmbed + msRerank) / N],
] as const) {
  const cells = SLICES.map((s) => `${t[s].hit1}/${t[s].n}`.padStart(9)).join("");
  console.log(`  ${label.padEnd(28)}${cells}   ${String(r1s(t)).padStart(2)}/${N}  ${mrr(t).toFixed(3)}   ${ms.toFixed(0).padStart(6)}`);
}
console.log(`\n  tier 1 ${(msEmbed / N).toFixed(0)}ms/query, tier 2 adds ${(msRerank / N).toFixed(0)}ms` +
            (MARGIN > 0 ? `  (escalated ${escalated}/${N} at margin < ${MARGIN})` : ""));

// Is the cosine margin actually a usable confidence signal, or noise? If the
// queries tier 1 gets wrong do not sit at the bottom of the margin distribution,
// gating on it cannot work and the tier has to run on every query.
const sorted = [...margins].sort((a, b) => a.margin - b.margin);
console.log("\n  cosine margin (top1 − top2), smallest first — ✗ marks a tier-1 miss");
for (const m of sorted.slice(0, 6)) {
  console.log(`    ${m.margin.toFixed(4)}  ${m.wasWrong ? "✗" : " "}  "${m.q.slice(0, 54)}"`);
}
console.log(`    …  widest is ${sorted[sorted.length - 1].margin.toFixed(4)}`);
if (fixed.length) { console.log(`\n  the rerank FIXED ${fixed.length}:`); for (const f of fixed) console.log(`    ${f}`); }
if (broke.length) { console.log(`\n  the rerank BROKE ${broke.length}:`); for (const b of broke) console.log(`    ${b}`); }
if (!fixed.length && !broke.length) console.log("\n  the rerank changed nothing");
