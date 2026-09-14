/**
 * rerank-heldout.ts — the held-out generalisation test for the SMD-1304 reranker
 * re-look. The LongMemEval reranker numbers (rerank-spike.ts + rerank-llm-
 * reranker.py) risk benchmark familiarity: MemReranker used LongMemEval as one of
 * its evaluation benchmarks. This builds a pool over a corpus it never saw — the
 * real Linear tracker (team SMD, completed issues; build-linear-corpus.ts) scored
 * on graphrag-questions.json, the hand-labelled multi-hop / aggregation set — so a
 * reranker's gain can be checked off-distribution.
 *
 * The verdict it produced (strict recall_all@5): the LongMemEval MemReranker gain
 * does NOT reproduce here — baseline multi-hop is already 100% (these questions are
 * easy, golds robustly top-ranked), so there is no marginal second gold to drop;
 * the generic Qwen3-Reranker is perfectly neutral (not harmful) and MemReranker is
 * about neutral (+1 aggregation, −1 multi-hop). So the LongMemEval reranker effects
 * are a difficulty phenomenon, and MemReranker's +10 is largely benchmark-specific.
 * A *hard* held-out multi-hop corpus would be needed to confirm it. See FORK.md.
 *
 * Everything is in memory (601 docs, 27 questions). Build the corpus first:
 *   LINEAR_API_KEY=… OB1_CORPUS_OUT=/tmp/linear-corpus-full.json bun evals/build-linear-corpus.ts
 * then:
 *   OB1_CORPUS=/tmp/linear-corpus-full.json OB1_RERANK_HELDOUT_OUT=/tmp/heldout-pool.json \
 *     OB1_EVAL_EMBED=qwen3-embedding:0.6b@1024 bun evals/rerank-heldout.ts
 * then rerank the dump with rerank-llm-reranker.py (RR_POOL_FILE=/tmp/heldout-pool.json).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { EVAL_BASE, EVAL_HEADERS, applyPrompt, parseSpec } from "./lib.ts";

loadEnv();
const CORPUS = process.env.OB1_CORPUS ?? "/tmp/linear-corpus-full.json";
if (!existsSync(CORPUS)) { console.error(`no corpus at ${CORPUS}; run build-linear-corpus.ts first.`); process.exit(2); }
const QF = new URL("./graphrag-questions.json", import.meta.url).pathname;
const OUT = process.env.OB1_RERANK_HELDOUT_OUT ?? "/tmp/heldout-pool.json";
const SPEC = parseSpec(process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:0.6b@1024");
const DIM = SPEC.dims ?? 1024;
const POOL = Number(process.env.OB1_RERANK_POOL ?? 30);

const docs = JSON.parse(readFileSync(CORPUS, "utf8")) as { id: string; title: string; text: string }[];
const docText = new Map(docs.map((d) => [d.id, `${d.title}\n\n${d.text}`]));
const corpusIds = new Set(docs.map((d) => d.id));
const raw = JSON.parse(readFileSync(QF, "utf8"));
const qs = (raw.questions ?? raw) as { id?: string; type: string; question: string; expected: string[] }[];
// Keep questions whose full expected set survived corpus drift.
const usable = qs.filter((q) => q.expected.every((e) => corpusIds.has(e)));
console.log(`corpus ${docs.length} docs; questions ${qs.length}, usable ${usable.length} (dropped ${qs.length - usable.length})`);

async function embedMany(texts: string[], isQuery: boolean): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const slice = texts.slice(i, i + 32).map((t) => applyPrompt(SPEC, t.slice(0, 8000), isQuery));
    const r = await fetch(`${EVAL_BASE}/embeddings`, { method: "POST", headers: EVAL_HEADERS,
      body: JSON.stringify({ model: SPEC.name, input: slice, ...(SPEC.dims ? { dimensions: SPEC.dims } : {}) }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    for (const d of data.data) if (d.embedding.length !== DIM) throw new Error(`provider returned ${d.embedding.length}-wide vectors`);
    out.push(...[...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const cos = (a: number[], b: number[]) => dot(a, b) / (Math.sqrt(dot(a, a) * dot(b, b)) || 1);
const strictAt = (r: string[], g: string[], k: number) => g.every((x) => r.slice(0, k).includes(x));

console.log("embedding docs + questions...");
const docIds = docs.map((d) => d.id);
const docEmb = await embedMany(docIds.map((id) => docText.get(id)!), false);
const qEmb = await embedMany(usable.map((q) => q.question), true);

const dump: any[] = [];
const agg: Record<string, { s5: number; s10: number; oracle: number; n: number }> = {};
for (let i = 0; i < usable.length; i++) {
  const q = usable[i];
  const ranked = docIds.map((id, j) => ({ id, s: cos(qEmb[i], docEmb[j]) })).sort((a, b) => b.s - a.s).map((x) => x.id);
  const cands = ranked.slice(0, POOL);
  const a = agg[q.type] ??= { s5: 0, s10: 0, oracle: 0, n: 0 }; a.n++;
  if (strictAt(ranked, q.expected, 5)) a.s5++;
  if (strictAt(ranked, q.expected, 10)) a.s10++;
  if (q.expected.every((g) => cands.includes(g))) a.oracle++;
  dump.push({ qid: q.id ?? `q${i}`, type: q.type, question: q.question, gold: q.expected, hay: cands, cands,
    contents: Object.fromEntries(cands.map((id) => [id, docText.get(id)!])) });
}
writeFileSync(OUT, JSON.stringify(dump));
writeFileSync(OUT + ".map", JSON.stringify(Object.fromEntries([...corpusIds].map((id) => [id, [id]]))));
const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(0)}%` : "—");
console.log(`\nvector BASELINE (pool=${POOL}), strict recall_all:`);
for (const t of Object.keys(agg)) { const a = agg[t];
  console.log(`  ${t.padEnd(12)} n=${a.n}  @5 ${pct(a.s5, a.n)}  @10 ${pct(a.s10, a.n)}  oracle(all-in-top${POOL}) ${pct(a.oracle, a.n)}`); }
console.log(`\nwrote pool -> ${OUT}  (rerank with rerank-llm-reranker.py, RR_POOL_FILE=${OUT})`);
