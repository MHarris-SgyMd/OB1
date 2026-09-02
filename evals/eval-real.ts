#!/usr/bin/env bun
/**
 * eval-real.ts — run the retrieval comparison against a real corpus.
 *
 * Every number in eval-retrieval.ts comes from twenty thoughts I wrote to be
 * adversarial. That is enough to rank models but not enough to trust a tuned
 * threshold: the cascade's 0.08 escalation gate was fitted to exactly one failing
 * query, which is overfitting by any standard. This runs the same comparison over
 * a real issue tracker — 97 closed Linear issues — to find out which conclusions
 * survive contact with data I did not write.
 *
 * The task: the issue BODY is the document, the issue TITLE is the query. Nobody
 * had to label anything, and it is the retrieval question a tracker actually
 * poses — "which issue was the one about X". Real trackers are dense with
 * near-duplicates, which is the case synthetic corpora flatter.
 *
 * Everything runs against local Ollama. The corpus is internal engineering data
 * from a healthcare company, so it does not go to a hosted embedding provider —
 * which is the whole argument for the local path being a supported option.
 *
 *   bun eval-real.ts embeddinggemma bge-m3 nomic-embed-text
 */

const BASE = process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";
const KEY = process.env.OB1_EVAL_KEY ?? "";
const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
};
const CORPUS = process.env.OB1_EVAL_CORPUS ?? "/tmp/linear-corpus.json";

type Item = { id: string; title: string; text: string; labels: string[] };
const ITEMS: Item[] = JSON.parse(await Bun.file(CORPUS).text());

async function embed(model: string, input: string, isQuery = false): Promise<number[]> {
  const [spec, dims] = model.split("@");
  const instruct = spec.endsWith("!instruct");
  const name = spec.replace(/!instruct$/, "");
  if (instruct && isQuery) input = `Instruct: Given a search query, retrieve the issue that matches it\nQuery: ${input}`;
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({ model: name, input, ...(dims ? { dimensions: Number(dims) } : {}) }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 90)}`);
  return ((await r.json()) as { data: [{ embedding: number[] }] }).data[0].embedding;
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

type Res = {
  model: string; dims: number; r1: number; r5: number; mrr: number; seconds: number;
  margins: { id: string; margin: number; wrong: boolean }[];
  misses: { id: string; title: string; rank: number; got: string }[];
};

async function evaluate(model: string): Promise<Res> {
  const t0 = Date.now();
  const vecs: Record<string, number[]> = {};
  for (const it of ITEMS) vecs[it.id] = await embed(model, it.text);
  const dims = vecs[ITEMS[0].id].length;

  let hit1 = 0, hit5 = 0, mrr = 0;
  const margins: Res["margins"] = [];
  const misses: Res["misses"] = [];

  for (const it of ITEMS) {
    const qv = await embed(model, it.title, true);
    const ranked = ITEMS.map((d) => ({ id: d.id, s: cosine(qv, vecs[d.id]) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((r) => r.id === it.id) + 1;
    if (rank === 1) hit1++;
    if (rank <= 5) hit5++;
    mrr += 1 / rank;
    margins.push({ id: it.id, margin: ranked[0].s - ranked[1].s, wrong: rank !== 1 });
    if (rank !== 1) misses.push({ id: it.id, title: it.title, rank, got: ranked[0].id });
  }

  const n = ITEMS.length;
  return { model, dims, r1: hit1 / n, r5: hit5 / n, mrr: mrr / n,
           seconds: (Date.now() - t0) / 1000, margins, misses };
}

/**
 * Optional second tier, same design as eval-cascade.ts: escalate to an LLM rerank
 * of the top-K only when tier 1's cosine margin says it is unsure. The synthetic
 * corpus put that gate at 0.08 off a single failing query. With ~14 misses here
 * there is enough signal to say whether the threshold transfers.
 */
const RERANK = process.env.OB1_EVAL_RERANK ?? "";
const MARGIN = Number(process.env.OB1_EVAL_MARGIN ?? 0);
const TOPK = Number(process.env.OB1_EVAL_TOPK ?? 5);

async function rerank(query: string, cands: { id: string; text: string }[]): Promise<string[]> {
  const numbered = cands.map((c, i) => `[${i + 1}] ${c.text.slice(0, 700)}`).join("\n\n");
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST", headers: HEADERS,
    body: JSON.stringify({
      model: RERANK, temperature: 0, reasoning_effort: "none",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content:
          `Rank the numbered issue descriptions by how well each matches the given issue ` +
          `title. Pay attention to which component and which specific behaviour each one ` +
          `concerns. Return JSON {"order": [numbers, best first]} with every number once.` },
        { role: "user", content: `Title: ${query}\n\nIssues:\n${numbered}` },
      ],
    }),
  });
  if (!r.ok) return cands.map((c) => c.id);
  try {
    const order = JSON.parse(String((await r.json())?.choices?.[0]?.message?.content))?.order;
    if (!Array.isArray(order)) return cands.map((c) => c.id);
    const seen = new Set<string>(); const out: string[] = [];
    for (const n of order) { const c = cands[Number(n) - 1]; if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c.id); } }
    for (const c of cands) if (!seen.has(c.id)) out.push(c.id);
    return out;
  } catch { return cands.map((c) => c.id); }
}

async function cascade(model: string): Promise<void> {
  const vecs: Record<string, number[]> = {};
  for (const it of ITEMS) vecs[it.id] = await embed(model, it.text);
  let h1t1 = 0, h1t2 = 0, mrr1 = 0, mrr2 = 0, esc = 0, ms = 0;
  const fixed: string[] = [], broke: string[] = [];
  for (const it of ITEMS) {
    const qv = await embed(model, it.title, true);
    const ranked = ITEMS.map((d) => ({ id: d.id, s: cosine(qv, vecs[d.id]) })).sort((a, b) => b.s - a.s);
    const r1 = ranked.findIndex((r) => r.id === it.id) + 1;
    if (r1 === 1) h1t1++; mrr1 += 1 / r1;

    const go = MARGIN <= 0 || (ranked[0].s - ranked[1].s) < MARGIN;
    let r2 = r1;
    if (go) {
      esc++;
      const cands = ranked.slice(0, TOPK).map((r) => ({ id: r.id, text: ITEMS.find((d) => d.id === r.id)!.text }));
      const a = Date.now();
      const order = await rerank(it.title, cands);
      ms += Date.now() - a;
      const k = order.indexOf(it.id) + 1;
      r2 = k > 0 ? k : r1;
    }
    if (r2 === 1) h1t2++; mrr2 += 1 / r2;
    if (r1 !== 1 && r2 === 1) fixed.push(it.id);
    if (r1 === 1 && r2 !== 1) broke.push(`${it.id}→${r2}`);
  }
  const n = ITEMS.length;
  console.log(`\n  cascade on ${n} real issues — embed=${model} rerank=${RERANK} K=${TOPK} gate=${MARGIN || "always"}`);
  console.log(`    tier 1        R@1 ${((h1t1 / n) * 100).toFixed(0)}%  MRR ${(mrr1 / n).toFixed(3)}`);
  console.log(`    tier 1+2      R@1 ${((h1t2 / n) * 100).toFixed(0)}%  MRR ${(mrr2 / n).toFixed(3)}   escalated ${esc}/${n}, +${(ms / n).toFixed(0)}ms/query avg`);
  console.log(`    fixed ${fixed.length} (${fixed.slice(0, 8).join(" ")})`);
  console.log(`    broke ${broke.length} (${broke.slice(0, 8).join(" ")})`);
}

if (RERANK) { await cascade(process.argv[2] ?? "embeddinggemma"); process.exit(0); }

const results: Res[] = [];
for (const m of process.argv.slice(2)) {
  process.stderr.write(`  … ${m}\n`);
  try { results.push(await evaluate(m)); }
  catch (e) { process.stderr.write(`  ✗ ${m}: ${(e as Error).message}\n`); }
}

console.log(`\n  ${ITEMS.length} real issues — body is the document, title is the query\n`);
console.log("  model                             dims    R@1    R@5    MRR     sec");
console.log("  " + "─".repeat(70));
for (const r of results.sort((a, b) => b.mrr - a.mrr)) {
  console.log(
    `  ${r.model.padEnd(33)} ${String(r.dims).padStart(4)}  ${(r.r1 * 100).toFixed(0).padStart(4)}%  ` +
    `${(r.r5 * 100).toFixed(0).padStart(4)}%  ${r.mrr.toFixed(3)}  ${r.seconds.toFixed(1).padStart(6)}`
  );
}

/**
 * Does the cosine margin separate right from wrong? On the synthetic corpus it
 * looked usable off a single failure. With ~97 queries there are enough misses to
 * say whether that was real.
 */
for (const r of results) {
  const wrong = r.margins.filter((m) => m.wrong).map((m) => m.margin);
  const right = r.margins.filter((m) => !m.wrong).map((m) => m.margin);
  if (!wrong.length) { console.log(`\n  ${r.model}: no misses`); continue; }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  // At a gate tuned to catch 80% of misses, how many correct queries pay the toll?
  const cut = [...wrong].sort((a, b) => a - b)[Math.floor(wrong.length * 0.8)] ?? Math.max(...wrong);
  const falsePos = right.filter((m) => m < cut).length;
  console.log(
    `\n  ${r.model}: ${wrong.length} misses. margin median — wrong ${med(wrong).toFixed(3)} vs right ${med(right).toFixed(3)}`
  );
  console.log(
    `    gate < ${cut.toFixed(3)} catches ${wrong.filter((m) => m < cut).length}/${wrong.length} misses ` +
    `and escalates ${falsePos}/${right.length} correct queries ` +
    `(${(((falsePos + wrong.filter((m) => m < cut).length) / r.margins.length) * 100).toFixed(0)}% of all traffic)`
  );
}

const best = results[0];
if (best?.misses.length) {
  console.log(`\n  ${best.model} — first 6 misses:`);
  for (const m of best.misses.slice(0, 6)) {
    console.log(`    ${m.id} (rank ${m.rank}) "${m.title.slice(0, 58)}"`);
    console.log(`       beaten by ${m.got}`);
  }
}
