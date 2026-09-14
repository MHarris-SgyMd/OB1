/**
 * rerank-spike.ts — the post-floor LongMemEval recall levers, measured
 * (Linear SMD-1301 candidate window, SMD-1302 event-date signal, SMD-1304
 * reranker re-look). One question drives all three: with SMD-1300's floor gone,
 * multi-session (79.3%) and temporal (79.5%) are the weakest strict recall_all@5
 * slices, and their golds sit at ranks 6–20 in the candidate pool (oracle @30 is
 * 99.2% / 95.3%). What, if anything, reorders the close-behind gold into the
 * top five?
 *
 * The answer this harness records: nothing available in the fork's local stack.
 *   - fan-in width (1301): a wider vector scan does NOT change the returned five.
 *     Calling the shipped hybrid at match_count = 5..100 and taking the first 5
 *     is invariant with N — at recency_weight 0 the vector arm is ranked by
 *     similarity, and admitting more rows below the five never reorders the five.
 *     (The keyword arm fires on 12/248 questions and perturbs at most ~1 of them,
 *     so the hybrid arm sits ~1 question below the pure-vector `baseline` — but
 *     that gap does not move with N, which is the no-op.)
 *   - event-date proximity (1302): the gold's date has no relation to
 *     question_date that distinguishes it from a distractor (a blend over the 248
 *     multi-session + temporal questions gains at most +2 of them at one weight,
 *     and hurts at any real weight) — see the header of this file's `dateblend`
 *     arm.
 *   - reranking (1304): a bi-encoder swap (bge-m3), a general-LLM listwise
 *     rerank (qwen2.5:7b), and a purpose-built cross-encoder (bge-reranker-v2-m3,
 *     run separately by rerank-crossencoder.py) are all flat-to-negative. The
 *     misses are multi-hop counting/comparison questions ("how many projects
 *     have I led", "how many days between X and Y"); per-document relevance
 *     reranking cannot separate the gold instances from equally-topical rows.
 *
 * The reranker re-decline (superseding the informal GBrain-notes decline, which
 * was measured only on the saturated tracker corpus) is thus grounded on the
 * corpus that HAS headroom. See evals/README.md and FORK.md.
 *
 * Reuses a persisted eval-longmemeval load (its DB + session→thought map); it
 * neither loads nor re-embeds the corpus. Run its load phase first.
 *
 *   OB1_EVAL_LME=/path/longmemeval_s.json DATABASE_URL=postgres://... \
 *   OB1_EVAL_LME_MAP=/path/map.json OB1_EVAL_EMBED=qwen3-embedding:0.6b@1024 \
 *   OB1_RERANK_ARMS=baseline,fanin,dateblend,bge,llm,oracle bun evals/rerank-spike.ts
 *
 *   OB1_RERANK_POOL=30        candidate pool depth to rerank / oracle over
 *   OB1_RERANK_MAXQ=10        cap questions per slice (a smoke run; 0 = all)
 *   OB1_RERANK_BGE=bge-m3:latest        bi-encoder for the `bge` arm
 *   OB1_RERANK_LLM=qwen2.5:7b           chat model for the `llm` listwise arm
 */
import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { EVAL_BASE, EVAL_HEADERS, applyPrompt, parseSpec } from "./lib.ts";

loadEnv();
const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL is required."); process.exit(2); }
const DATA = process.env.OB1_EVAL_LME;
if (!DATA || !existsSync(DATA)) { console.error("OB1_EVAL_LME must name longmemeval_s.json."); process.exit(2); }
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:0.6b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? 1024;
const MAP_PATH = process.env.OB1_EVAL_LME_MAP ?? `/tmp/lme-map-${EMBED_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;
if (!existsSync(MAP_PATH)) { console.error(`no map at ${MAP_PATH}; run eval-longmemeval.ts load first.`); process.exit(2); }
const POOL = Number(process.env.OB1_RERANK_POOL ?? 30);
const BGE = process.env.OB1_RERANK_BGE ?? "bge-m3:latest";
const LLM = process.env.OB1_RERANK_LLM ?? "qwen2.5:7b";
const ARMS = (process.env.OB1_RERANK_ARMS ?? "baseline,fanin,dateblend,bge,llm,oracle").split(",").map((s) => s.trim());
// The two slices that carry the post-floor misses; the short single-session
// slices are already saturated, so reranking cannot move them.
const SLICES = ["multi-session", "temporal-reasoning"];

type Turn = { role: string; content: string };
type Question = { question_id: string; question_type: string; question: string; question_date: string;
  haystack_dates: string[]; haystack_session_ids: string[]; haystack_sessions: Turn[][]; answer_session_ids: string[] };
const MAXQ = Number(process.env.OB1_RERANK_MAXQ ?? 0); // cap questions per slice for a smoke run
const questions = (() => {
  const all = (JSON.parse(readFileSync(DATA, "utf8")) as Question[])
    .filter((q) => SLICES.includes(q.question_type) && !q.question_id.endsWith("_abs"));
  if (!MAXQ) return all;
  const seen: Record<string, number> = {};
  return all.filter((q) => (seen[q.question_type] = (seen[q.question_type] ?? 0) + 1) <= MAXQ);
})();
const map = JSON.parse(readFileSync(MAP_PATH, "utf8")) as Record<string, string>;
const idToSids = new Map<string, string[]>();
for (const [sid, id] of Object.entries(map)) idToSids.set(id, [...(idToSids.get(id) ?? []), sid]);

const toVector = (v: number[]) => `[${v.join(",")}]`;
const DAY = 86400000;
function toMs(d: string): number | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w{3}\) (\d{2}):(\d{2})$/.exec(d);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

async function embedMany(texts: string[], model: string, isQuery: boolean, dims?: number): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const raw = texts.slice(i, i + 32);
    const slice = model === spec.name ? raw.map((t) => applyPrompt(spec, t, isQuery)) : raw.map((t) => t.slice(0, 6000));
    const r = await fetch(`${EVAL_BASE}/embeddings`, { method: "POST", headers: EVAL_HEADERS,
      body: JSON.stringify({ model, input: slice, ...(dims ? { dimensions: dims } : {}) }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    out.push(...[...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const cos = (a: number[], b: number[]) => dot(a, b) / (Math.sqrt(dot(a, a) * dot(b, b)) || 1);

const sql = new SQL({ url: URL_, max: 4 });

/** strict recall_all@k over the distinct sessions a ranked id list resolves to. */
function strictAt(ids: string[], q: Question, k: number): boolean {
  const hay = new Set(q.haystack_session_ids); const gold = new Set(q.answer_session_ids);
  const sids: string[] = [];
  for (const id of ids) { const own = idToSids.get(id); if (!own) continue;
    for (const sid of own.filter((s) => hay.has(s))) if (!sids.includes(sid)) sids.push(sid); }
  const top = new Set(sids.slice(0, k));
  return [...gold].every((g) => top.has(g));
}
type Agg = Record<string, [number, number]>; // type -> [hit, n]
function tally(pred: (q: Question, i: number) => boolean): Agg {
  const a: Agg = {};
  questions.forEach((q, i) => { a[q.question_type] ??= [0, 0]; a[q.question_type][1]++; if (pred(q, i)) a[q.question_type][0]++; });
  return a;
}
const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : "—");
function report(label: string, a: Agg) {
  console.log(`  ${label.padEnd(42)} ${SLICES.map((t) => `${t.split("-")[0]} ${pct(a[t]?.[0] ?? 0, a[t]?.[1] ?? 0)}`).join("   ")}`);
}

// Candidate pool: top-POOL by vector similarity, with content + event date.
type Cand = { id: string; sim: number; ms: number | null; content: string };
console.log(`▸ ${questions.length} questions (${SLICES.join(" + ")}); pool=${POOL}; embed=${EMBED_MODEL}`);
const qvs = await embedMany(questions.map((q) => q.question), spec.name, true, spec.dims);
const pools: Cand[][] = [];
for (let i = 0; i < questions.length; i++) {
  const rows = await sql`SELECT id, content, similarity, created_at FROM match_thoughts(${toVector(qvs[i])}::vector, -1.0, ${POOL}, ${{ lme_q: [questions[i].question_id] }}::jsonb)` as any[];
  pools.push(rows.map((r) => ({ id: r.id, sim: r.similarity, ms: r.created_at ? new Date(r.created_at).getTime() : null, content: r.content })));
}
// Optional dump for the out-of-stack cross-encoder probe (rerank-crossencoder.py):
// everything it needs to rerank and score, so it touches neither the DB nor a
// second embedding pass.
if (process.env.OB1_RERANK_POOL_OUT) {
  const dump = questions.map((q, i) => ({
    qid: q.question_id, type: q.question_type, question: q.question, gold: q.answer_session_ids, hay: q.haystack_session_ids,
    cands: pools[i].map((c) => c.id), contents: Object.fromEntries(pools[i].map((c) => [c.id, c.content])),
  }));
  writeFileSync(process.env.OB1_RERANK_POOL_OUT, JSON.stringify(dump));
  // The id→sessions map the scorer needs, alongside the pool.
  writeFileSync(`${process.env.OB1_RERANK_POOL_OUT}.map`, JSON.stringify(Object.fromEntries(idToSids)));
  console.log(`  wrote pool + map for rerank-crossencoder.py -> ${process.env.OB1_RERANK_POOL_OUT}`);
}
console.log("");

if (ARMS.includes("baseline"))
  report("baseline (vector similarity, take 5)", tally((q, i) => strictAt(pools[i].map((c) => c.id), q, 5)));

if (ARMS.includes("oracle")) {
  // A perfect reorder of the pool: strict@5 is reachable iff #golds ≤ 5 and every
  // gold session is present among the pool's distinct sessions.
  report(`oracle (perfect rerank of top-${POOL})`, tally((q, i) => {
    const gold = new Set(q.answer_session_ids); if (gold.size > 5) return false;
    const hay = new Set(q.haystack_session_ids); const present = new Set<string>();
    for (const c of pools[i]) for (const sid of (idToSids.get(c.id) ?? []).filter((s) => hay.has(s))) present.add(sid);
    return [...gold].every((g) => present.has(g));
  }));
}

if (ARMS.includes("fanin")) {
  // SMD-1301: call the SHIPPED hybrid (threshold 0, the post-1300 tool value) at
  // match_count = N (fan-in N, fused over N) and take the first 5 returned. If the
  // five don't move with N, a wider window cannot help. This is the real shipped
  // path — it differs from the pure-vector `baseline` arm (match_thoughts at -1)
  // by the keyword arm and the 0-vs-(-1) admission, ~1 question here; that gap is
  // constant, and the point is that it does not move with N.
  console.log(`\n  --- SMD-1301 candidate-window (fan-in N, return 5; shipped hybrid @ threshold 0) ---`);
  for (const N of [5, 10, 20, 50, 100]) {
    const a = await (async () => {
      const acc: Agg = {};
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const rows = await sql`SELECT id FROM search_thoughts_hybrid(${toVector(qvs[i])}::vector, ${q.question}, 0.0, ${N}, ${{ lme_q: [q.question_id] }}::jsonb)` as any[];
        acc[q.question_type] ??= [0, 0]; acc[q.question_type][1]++;
        if (strictAt(rows.map((r) => r.id), q, 5)) acc[q.question_type][0]++;
      }
      return acc;
    })();
    report(`fan-in ${String(N).padStart(3)}`, a);
  }
}

if (ARMS.includes("dateblend")) {
  // SMD-1302: rerank the pool by sim*(1-w) + proximity(event_date, question_date)*w.
  // Every row in an eval-longmemeval load carries created_at set to its session
  // date (the benchmark format toMs parses), so `c.ms` is never null here; a null
  // question_date makes prox 0 for the whole pool (the blend degenerates to sim,
  // no reordering) rather than demoting anything. So this arm's result is the date
  // signal, not a null-handling artifact.
  console.log(`\n  --- SMD-1302 event-date proximity blend (rerank pool, take 5) ---`);
  for (const H of [7, 30, 90]) for (const w of [0.1, 0.2, 0.3]) {
    const a = tally((q, i) => {
      const qms = toMs(q.question_date);
      const scored = pools[i].map((c) => {
        const prox = (qms != null && c.ms != null) ? Math.pow(0.5, Math.abs(qms - c.ms) / DAY / H) : 0;
        return { id: c.id, s: c.sim * (1 - w) + prox * w };
      }).sort((x, y) => y.s - x.s);
      return strictAt(scored.map((c) => c.id), q, 5);
    });
    report(`w=${w} half-life=${H}d`, a);
  }
}

if (ARMS.includes("bge")) {
  // SMD-1304 local bi-encoder: re-embed query + candidate content with bge-m3,
  // reorder by bge cosine.
  console.log(`\n  --- SMD-1304 bi-encoder rerank (${BGE}) ---`);
  const contentById = new Map<string, string>();
  for (const p of pools) for (const c of p) contentById.set(c.id, c.content);
  const ids = [...contentById.keys()];
  const embs = await embedMany(ids.map((id) => contentById.get(id)!), BGE, false);
  const cand = new Map<string, number[]>(); ids.forEach((id, j) => cand.set(id, embs[j]));
  const qe = await embedMany(questions.map((q) => q.question), BGE, true);
  report(`${BGE} rerank`, tally((q, i) => {
    const scored = pools[i].map((c) => ({ id: c.id, s: cos(qe[i], cand.get(c.id)!) })).sort((x, y) => y.s - x.s);
    return strictAt(scored.map((c) => c.id), q, 5);
  }));
}

if (ARMS.includes("llm")) {
  // SMD-1304 general-LLM listwise: present top-min(POOL,20) snippets, ask for the
  // 5 most relevant. A general chat model is a poor reranker; recorded to show it.
  console.log(`\n  --- SMD-1304 LLM listwise rerank (${LLM}) ---`);
  const N = Math.min(POOL, 20);
  const a: Agg = Object.fromEntries(SLICES.map((t) => [t, [0, 0] as [number, number]]));
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const cands = pools[i].slice(0, N).map((c, idx) => ({ n: idx + 1, id: c.id, snip: c.content.slice(0, 700).replace(/\s+/g, " ") }));
    const list = cands.map((c) => `[${c.n}] ${c.snip}`).join("\n\n");
    const r = await fetch(`${EVAL_BASE}/chat/completions`, { method: "POST", headers: EVAL_HEADERS,
      body: JSON.stringify({ model: LLM, temperature: 0, messages: [
        { role: "system", content: "You rank memory sessions by how well each helps answer the question. Some questions need MULTIPLE sessions. Return ONLY a JSON array of the 5 most relevant session numbers, most relevant first." },
        { role: "user", content: `Question: ${q.question}\n\nSessions:\n${list}\n\nReturn the 5 most relevant session numbers as a JSON array.` }] }) });
    const txt = r.ok ? ((await r.json()) as any).choices?.[0]?.message?.content ?? "" : "";
    const m = txt.match(/\[[\d,\s]+\]/);
    let picks: number[] = [];
    if (m) { try { picks = (JSON.parse(m[0]) as number[]).filter((x) => Number.isInteger(x)); } catch { /* keep vector order */ } }
    const byN = new Map(cands.map((c) => [c.n, c.id]));
    const ordered = [...picks.map((n) => byN.get(n)).filter(Boolean) as string[], ...cands.map((c) => c.id)];
    a[q.question_type][1]++; if (strictAt(ordered, q, 5)) a[q.question_type][0]++;
  }
  report(`${LLM} listwise`, a);
}

console.log(`\nbaseline is the pure-vector arm (match_thoughts at -1); the shipped hybrid`);
console.log(`(fan-in arm, threshold 0) sits within ~1 question of it here. The purpose-built`);
console.log(`cross-encoder arm (bge-reranker-v2-m3) is rerank-crossencoder.py — it needs a`);
console.log(`torch env outside the local Ollama stack, which is itself part of the finding.`);
await sql.end();
