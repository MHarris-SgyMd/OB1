/**
 * query-decompose.ts — the one lever the SMD-1301/1302/1304 nulls point to,
 * measured (Linear SMD-1318). After SMD-1300 removed the floor, the weakest
 * LongMemEval-S strict recall_all@5 slices are multi-session (79.3%) and
 * temporal (79.5%), and their golds sit at ranks 6–20 of the candidate pool
 * (single-vector oracle @30 is 99.2% / 95.3%). Three levers that reorder that ONE
 * pool all failed — the candidate window (1301, no-op), an event-date blend
 * (1302, noise-to-harm), and rerankers over the pool (1304, flat-to-negative,
 * and MemReranker-4B's lift did not reproduce held-out).
 *
 * The shared cause: a multi-hop counting/comparison question ("how many days
 * between X and Y", "which happened first, X or Y", "how many projects have I
 * led") needs 2–3 distinct gold sessions in the top five (mean 2.2 temporal, 2.6
 * multi-session), but ONE blended query vector is the average of several events,
 * so each event's session lands mid-pool and no reorder of that one pool recovers
 * the set. Every prior lever operated on one vector's ranking of one pool.
 *
 * The answer this harness records: decomposition is declined, and it corrects the
 * ticket's premise. Best strict recall_all@5 is +1.7 (multi-session) and flat
 * temporal; RRF fusion regresses temporal. The premise was that one blended vector
 * ranks each event mid-pool — but the single blended pool ALREADY covers the whole
 * set (that IS the oracle, 99.2% / 95.3%), and ~85% of golds already sit at rank
 * <=2 individually. On the fired questions, decomposition's union covers the SAME
 * golds as the blended pool (a crude heuristic split even LOSES temporal coverage),
 * so decomposition adds no coverage; an LLM split cleanly lifts each event's gold
 * up its OWN sub-pool (rank-0 share 39%->61%), but that does not move strict either.
 * The miss is SET ASSEMBLY: fitting 2-3 mutually-competing golds plus their
 * distractors into five slots. Decomposition removes gold-vs-gold competition (each
 * gold in its own pool) but the merge re-introduces gold-vs-distractor competition
 * that no dumb fusion (RRF / round-robin / max-sim) can adjudicate. That last-mile
 * discrimination is a reranker's single-hop strength (any-hit ~99%) — which is why
 * a reranker DESTROYS pre-decomposition sets (SMD-1304) yet belongs AFTER
 * decomposition. Decomposition alone is declined for the default path;
 * decompose-then-rerank is the gated follow-up this measures the headroom for.
 *
 * The mechanism, and what this harness measures: retrieve with SEVERAL
 * vectors. Decompose the question into independent single-fact sub-questions,
 * retrieve top-k per sub-question, union, and fuse — so each event gets its own
 * vector ranking its own session near the top. This is the standard 2025–26
 * multi-hop RAG pipeline (decompose → retrieve per hop → union → fuse; ACL 2025
 * SRW, arXiv:2606.08577). A reranker, if it earns its place, belongs AFTER this
 * step (on single-hop sub-pools where its any-hit strength applies) — gated on
 * this pass showing lift, per SMD-1318.
 *
 * Every arm runs the identical pipeline (decompose → per-sub-query top-SUBK →
 * fuse → take 5 distinct sessions); the baseline's decomposer just returns the
 * question unchanged. So a question the decomposer leaves atomic goes through the
 * exact same path as baseline — the "single-topic behaves as today" invariant is
 * true by construction, and the harness checks it.
 *
 * Reuses a persisted eval-longmemeval load (its DB + session→thought map); it
 * neither loads nor re-embeds the corpus. Run its load phase first.
 *
 *   OB1_EVAL_LME=/path/longmemeval_s.json DATABASE_URL=postgres://... \
 *   OB1_EVAL_LME_MAP=/path/map.json OB1_EVAL_EMBED=qwen3-embedding:0.6b@1024 \
 *   OB1_DECOMP_ARMS=baseline,oracle,decomp-heur,decomp-llm bun evals/query-decompose.ts
 *
 *   OB1_DECOMP_POOL=30      pool depth for the baseline/oracle anchor
 *   OB1_DECOMP_SUBK=20      top-k retrieved PER sub-question (sweep 10/20/30)
 *   OB1_DECOMP_FUSE=rrf     union fusion: rrf | roundrobin | maxsim
 *   OB1_DECOMP_LLM=qwen2.5:7b   chat model for the decomp-llm split
 *   OB1_DECOMP_MAXQ=0       cap questions per slice (a smoke run; 0 = all)
 *   OB1_DECOMP_DUMP=/path   optional: dump each question's sub-questions for review
 *   OB1_DECOMP_CACHE=/path  optional: cache the LLM split by (model, question) so a
 *                           SUBK/fuse sweep re-uses one decomposition pass, not N
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
const MAP_PATH = process.env.OB1_EVAL_LME_MAP ?? `/tmp/lme-map-${EMBED_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;
if (!existsSync(MAP_PATH)) { console.error(`no map at ${MAP_PATH}; run eval-longmemeval.ts load first.`); process.exit(2); }
const POOL = Number(process.env.OB1_DECOMP_POOL ?? 30);
const SUBK = Number(process.env.OB1_DECOMP_SUBK ?? 20);
const FUSE = (process.env.OB1_DECOMP_FUSE ?? "rrf") as "rrf" | "roundrobin" | "maxsim";
const LLM = process.env.OB1_DECOMP_LLM ?? "qwen2.5:7b";
const ARMS = (process.env.OB1_DECOMP_ARMS ?? "baseline,oracle,decomp-heur,decomp-llm").split(",").map((s) => s.trim());
const MAXQ = Number(process.env.OB1_DECOMP_MAXQ ?? 0);
// The two slices that carry the post-floor misses; the short single-session
// slices are already saturated, so multi-vector retrieval cannot move them.
const SLICES = ["multi-session", "temporal-reasoning"];
const MAX_SUBQ = 6; // bound cost: no question needs more than a handful of hops

type Turn = { role: string; content: string };
type Question = { question_id: string; question_type: string; question: string; question_date: string;
  haystack_dates: string[]; haystack_session_ids: string[]; haystack_sessions: Turn[][]; answer_session_ids: string[] };
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
const sql = new SQL({ url: URL_, max: 4 });

async function embedMany(texts: string[], isQuery: boolean): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const slice = texts.slice(i, i + 32).map((t) => applyPrompt(spec, t, isQuery));
    const r = await fetch(`${EVAL_BASE}/embeddings`, { method: "POST", headers: EVAL_HEADERS,
      body: JSON.stringify({ model: spec.name, input: slice, ...(spec.dims ? { dimensions: spec.dims } : {}) }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    out.push(...[...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

/** strict recall_all@k over the distinct sessions a ranked id list resolves to. */
function strictAt(ids: string[], q: Question, k: number): boolean {
  const hay = new Set(q.haystack_session_ids); const gold = new Set(q.answer_session_ids);
  const sids: string[] = [];
  for (const id of ids) { const own = idToSids.get(id); if (!own) continue;
    for (const sid of own.filter((s) => hay.has(s))) if (!sids.includes(sid)) sids.push(sid); }
  const top = new Set(sids.slice(0, k));
  return [...gold].every((g) => top.has(g));
}
/** the distinct sessions a ranked id list resolves to (for the invariant check). */
function sessionsOf(ids: string[], q: Question, k: number): string[] {
  const hay = new Set(q.haystack_session_ids); const sids: string[] = [];
  for (const id of ids) { const own = idToSids.get(id); if (!own) continue;
    for (const sid of own.filter((s) => hay.has(s))) if (!sids.includes(sid)) sids.push(sid); }
  return sids.slice(0, k);
}

type Agg = Record<string, [number, number]>; // type -> [hit, n]
const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : "—");
function report(label: string, a: Agg) {
  console.log(`  ${label.padEnd(40)} ${SLICES.map((t) => `${t.split("-")[0]} ${pct(a[t]?.[0] ?? 0, a[t]?.[1] ?? 0)}`).join("   ")}`);
}

// ── Decomposers ──────────────────────────────────────────────────────────────
// Each returns the sub-questions for a query; a one-element result means "atomic"
// and drives the identical single-vector path as baseline.

function heuristicSplit(question: string): string[] {
  // Only fire on the multi-hop shapes the slices are made of; otherwise atomic.
  const q = question.trim();
  const low = q.toLowerCase();
  const multiHop = /\bhow many\b|\bwhich (?:one )?(?:came|happened|was) (?:first|earliest|latest|last)\b|\bbetween\b|\bcompared? to\b|\bversus\b|\bvs\.?\b|\bmore than\b|\bfewer than\b|\bearlier\b|\blater\b|\ball (?:of )?(?:my|the)\b/.test(low);
  if (!multiHop) return [q];
  // Split on coordinating conjunctions / commas / "vs"; keep fragments that
  // carry a noun phrase (>= 2 words). Fragments inherit no stem, so the first
  // keeps the question stem and the rest become bare entity phrases — a weak but
  // honest heuristic baseline for the LLM split to beat.
  const parts = q.split(/\s*(?:,|;|\band\b|\bor\b|\bvs\.?\b|\bversus\b)\s*/i)
    .map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 2);
  const uniq = [...new Set(parts)];
  return uniq.length >= 2 ? uniq.slice(0, MAX_SUBQ) : [q];
}

const DECOMP_SYS =
  "You break a user's question into the minimal set of independent, single-fact sub-questions needed to answer it, for a memory search over past sessions. Rules: " +
  "(1) A question about ONE fact or event returns a one-element JSON array containing the original question unchanged. " +
  "(2) A counting, comparison, ordering, or multi-event question (\"how many X\", \"which happened first, A or B\", \"how many days between A and B\", \"list all my …\") returns one self-contained sub-question per distinct event or entity it refers to. " +
  "(3) Each sub-question must stand alone: resolve pronouns and keep enough context to retrieve the right memory on its own. " +
  "(4) Return ONLY a JSON array of strings and nothing else.";

// LLM split cache: (model+prompt → question → sub-questions), persisted so a
// SUBK/fuse sweep pays the LLM cost once. Keyed by model AND a fingerprint of the
// system prompt + temperature, so neither a model swap nor a prompt edit reads a
// stale split. Only genuine splits are cached: a fetch/parse failure falls back to
// [question] WITHOUT caching, so one flaky call cannot permanently poison the file.
const djb2 = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i); return (h >>> 0).toString(36); };
const CACHE_KEY = `${LLM}@t0#${djb2(DECOMP_SYS)}`;
const CACHE_PATH = process.env.OB1_DECOMP_CACHE;
const llmCache: Record<string, Record<string, string[]>> =
  CACHE_PATH && existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : {};
let cacheDirty = false;

async function llmSplit(question: string): Promise<string[]> {
  const bucket = (llmCache[CACHE_KEY] ??= {});
  if (bucket[question]) return bucket[question];
  const subs = await llmSplitUncached(question);
  if (subs) { bucket[question] = subs; cacheDirty = true; return subs; }
  return [question]; // failure: fall back, but do not cache the fallback
}

/** Returns the parsed sub-questions, or null on a fetch/parse failure (uncached). */
async function llmSplitUncached(question: string): Promise<string[] | null> {
  let r: Response;
  try {
    r = await fetch(`${EVAL_BASE}/chat/completions`, { method: "POST", headers: EVAL_HEADERS,
      body: JSON.stringify({ model: LLM, temperature: 0, messages: [
        { role: "system", content: DECOMP_SYS },
        { role: "user", content: question }] }) });
  } catch { return null; }
  if (!r.ok) return null;
  const txt = ((await r.json()) as any).choices?.[0]?.message?.content ?? "";
  // Prefer an array that starts with a quoted string, so a stray bracket in prose
  // ("Here [are] the items: [\"a\",\"b\"]") does not get greedily swallowed into an
  // unparseable span; fall back to the loose match for other well-formed shapes.
  const m = txt.match(/\[\s*"[\s\S]*"\s*\]/) ?? txt.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]) as unknown[];
    const subs = [...new Set(arr.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))];
    return subs.length ? subs.slice(0, MAX_SUBQ) : [question]; // a valid empty parse = atomic
  } catch { return null; }
}

// ── Retrieval + fusion ───────────────────────────────────────────────────────
type Ranked = { id: string; sim: number }[]; // one sub-query's pool, sim desc

async function poolFor(vec: number[], qid: string, k: number): Promise<Ranked> {
  const rows = await sql`SELECT id, similarity FROM match_thoughts(${toVector(vec)}::vector, -1.0, ${k}, ${{ lme_q: [qid] }}::jsonb)` as any[];
  return rows.map((r) => ({ id: r.id, sim: r.similarity }));
}

/** Fuse several sub-query rankings into one id list. */
function fuse(pools: Ranked[], mode: typeof FUSE): string[] {
  if (pools.length === 1) return pools[0].map((c) => c.id);
  if (mode === "roundrobin") {
    const out: string[] = []; const seen = new Set<string>();
    const depth = Math.max(...pools.map((p) => p.length));
    for (let r = 0; r < depth; r++) for (const p of pools) {
      const id = p[r]?.id; if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
  }
  if (mode === "maxsim") {
    const best = new Map<string, number>();
    for (const p of pools) for (const c of p) best.set(c.id, Math.max(best.get(c.id) ?? -Infinity, c.sim));
    return [...best.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  // rrf (default): reciprocal-rank fusion, k0 = 60 (standard).
  const K0 = 60; const score = new Map<string, number>();
  for (const p of pools) p.forEach((c, r) => score.set(c.id, (score.get(c.id) ?? 0) + 1 / (K0 + r + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.log(`▸ ${questions.length} questions (${SLICES.join(" + ")}); pool=${POOL} subk=${SUBK} fuse=${FUSE}; embed=${EMBED_MODEL}`);

// One vector per question, embedded once; the baseline/oracle anchor + the
// atomic path share it.
const qvs = await embedMany(questions.map((q) => q.question), true);
const basePools: Ranked[] = [];
for (let i = 0; i < questions.length; i++) basePools.push(await poolFor(qvs[i], questions[i].question_id, POOL));

if (ARMS.includes("baseline")) {
  const a: Agg = {};
  questions.forEach((q, i) => { a[q.question_type] ??= [0, 0]; a[q.question_type][1]++;
    if (strictAt(basePools[i].map((c) => c.id), q, 5)) a[q.question_type][0]++; });
  report("baseline (one vector, take 5)", a);
}
if (ARMS.includes("oracle")) {
  const a: Agg = {};
  questions.forEach((q, i) => {
    a[q.question_type] ??= [0, 0]; a[q.question_type][1]++;
    const gold = new Set(q.answer_session_ids); if (gold.size > 5) return;
    const hay = new Set(q.haystack_session_ids); const present = new Set<string>();
    for (const c of basePools[i]) for (const sid of (idToSids.get(c.id) ?? []).filter((s) => hay.has(s))) present.add(sid);
    if ([...gold].every((g) => present.has(g))) a[q.question_type][0]++;
  });
  report(`oracle (perfect reorder of top-${POOL})`, a);
}

// Shared runner for the two decomposition arms.
async function runDecomp(name: string, decompose: (q: string) => Promise<string[]> | string[]) {
  console.log(`\n  --- ${name} (subk=${SUBK}, fuse=${FUSE}, llm=${name.includes("llm") ? LLM : "—"}) ---`);
  const strict: Agg = {}; const cover: Agg = {}; // cover = union coverage ceiling (all questions)
  // Coverage restricted to FIRED questions, where decomposition actually does
  // something: union vs the one blended pool over the SAME question set. On atomic
  // questions the union IS the blended pool (basePools), so overall coverage is
  // definitionally ~oracle; this pair is the non-definitional comparison.
  const coverFiredU: Agg = {}; const coverFiredB: Agg = {};
  const probe: Record<string, Record<string, number>> = {}; // slice -> best sub-pool gold-rank histogram
  const probeBlend: Record<string, Record<string, number>> = {}; // slice -> blended-pool gold-rank histogram
  const dump: any[] = [];
  let fired = 0, subqFiredTotal = 0, dbCalls = 0, embedCalls = 0, invariantOk = 0, invariantN = 0;
  const t0 = Date.now();
  const subsByQ: string[][] = [];
  for (const q of questions) subsByQ.push([...await decompose(q.question)]);
  const decompMs = Date.now() - t0;
  if (CACHE_PATH && cacheDirty) { writeFileSync(CACHE_PATH, JSON.stringify(llmCache)); cacheDirty = false; }
  // Embed each distinct sub-query once. Atomic questions reuse the baseline pool
  // (their one sub-query IS the already-embedded question), so only fired
  // questions' sub-queries are embedded — which is also the true added cost.
  const distinct = [...new Set(subsByQ.filter((s) => s.length > 1).flat())];
  const emb = new Map<string, number[]>();
  const embs = await embedMany(distinct, true); embedCalls += distinct.length;
  distinct.forEach((s, j) => emb.set(s, embs[j]));

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]; const subs = subsByQ[i];
    strict[q.question_type] ??= [0, 0]; cover[q.question_type] ??= [0, 0];
    if (subs.length > 1) { fired++; subqFiredTotal += subs.length; }
    // Retrieve per sub-query. A one-sub-question result is treated as atomic and
    // routed through the baseline pool (basePools[i], the ORIGINAL question's
    // vector) — deliberately, even when the model reworded that one question:
    // this isolates the effect of DECOMPOSITION (several vectors) from single-query
    // rewriting, which is a separate lever, not this ticket. So a lone reword is
    // not embedded, and the arm's only difference from baseline is the >1-hop split.
    let pools: Ranked[];
    if (subs.length === 1) { pools = [basePools[i]]; }
    else { pools = []; for (const s of subs) { pools.push(await poolFor(emb.get(s)!, q.question_id, SUBK)); dbCalls++; } }
    const ids = fuse(pools, FUSE);
    // strict@5
    strict[q.question_type][1]++; if (strictAt(ids, q, 5)) strict[q.question_type][0]++;
    // union-coverage ceiling: are all golds present anywhere in the union?
    cover[q.question_type][1]++;
    const gold = new Set(q.answer_session_ids); const hay = new Set(q.haystack_session_ids); const present = new Set<string>();
    for (const p of pools) for (const c of p) for (const sid of (idToSids.get(c.id) ?? []).filter((s) => hay.has(s))) present.add(sid);
    const covered = (set: Set<string>) => gold.size <= 5 && [...gold].every((g) => set.has(g));
    if (covered(present)) cover[q.question_type][0]++;
    if (subs.length > 1) { // fired-only: union vs blended over the same questions.
      // Same-depth control: the blended pool is truncated to SUBK, the depth each
      // sub-pool is retrieved at, so the comparison is not confounded by the
      // baseline pool's greater POOL (30) depth.
      const blend = new Set<string>();
      for (const c of basePools[i].slice(0, SUBK)) for (const sid of (idToSids.get(c.id) ?? []).filter((s) => hay.has(s))) blend.add(sid);
      coverFiredU[q.question_type] ??= [0, 0]; coverFiredB[q.question_type] ??= [0, 0];
      coverFiredU[q.question_type][1]++; coverFiredB[q.question_type][1]++;
      if (covered(present)) coverFiredU[q.question_type][0]++;
      if (covered(blend)) coverFiredB[q.question_type][0]++;
    }
    // guard: an atomic question takes the baseline path — it reuses basePools[i]
    // (the same pool the baseline arm scores) and fuse() returns a single pool
    // unchanged, so its top-5 equals baseline. This confirms the code routes an
    // atomic decomposition through that path; it is true by construction, not an
    // independent replication of production retrieval.
    if (subs.length === 1) { invariantN++;
      const a = sessionsOf(ids, q, 5).join(","); const b = sessionsOf(basePools[i].map((c) => c.id), q, 5).join(",");
      if (a === b) invariantOk++;
    }
    // last-mile probe: for each gold, its BEST rank within any single sub-pool.
    // Coverage says the gold is in the union; this says how far a per-sub-pool
    // reranker would have to lift it. Only meaningful when the query fired.
    if (process.env.OB1_DECOMP_PROBE && subs.length > 1) {
      const rankIn = (pool: Ranked, g: string): number => { // rank of session g in one pool, or Infinity
        const seen: string[] = [];
        for (const c of pool) for (const sid of (idToSids.get(c.id) ?? []).filter((s) => hay.has(s))) if (!seen.includes(sid)) seen.push(sid);
        return seen.indexOf(g);
      };
      const bucket = (r: number) => r < 0 ? "absent" : r === 0 ? "0" : r <= 2 ? "1-2" : r <= 4 ? "3-4" : r <= 9 ? "5-9" : "10+";
      const blank = () => ({ "0": 0, "1-2": 0, "3-4": 0, "5-9": 0, "10+": 0, absent: 0 });
      for (const g of gold) {
        if (!hay.has(g)) continue;
        // decomposition: the gold's BEST rank across its sub-pools.
        let best = Infinity;
        for (const p of pools) { const r = rankIn(p, g); if (r >= 0) best = Math.min(best, r); }
        (probe[q.question_type] ??= blank())[bucket(best === Infinity ? -1 : best)]++;
        // blended baseline (same question): the gold's rank in the ONE blended pool,
        // truncated to SUBK so the two rows are compared at the same pool depth.
        (probeBlend[q.question_type] ??= blank())[bucket(rankIn(basePools[i].slice(0, SUBK), g))]++;
      }
    }
    if (process.env.OB1_DECOMP_DUMP) dump.push({ qid: q.question_id, type: q.question_type, question: q.question, subs });
  }
  report(`${name} strict@5`, strict);
  report(`${name} union-coverage (all q)`, cover);
  report(`${name} coverage, fired q: union`, coverFiredU);
  report(`${name} coverage, fired q: blended`, coverFiredB);
  const firePct = pct(fired, questions.length);
  console.log(`  fire ${firePct} (${fired}/${questions.length} decomposed >1); mean sub-qs when fired ${(subqFiredTotal / (fired || 1)).toFixed(2)}; ` +
    `atomic path reuses baseline pool ${invariantOk}/${invariantN}`);
  console.log(`  cost: decompose ${(decompMs / 1000).toFixed(1)}s total, +${embedCalls} sub-query embeddings (batched 32/request), +${dbCalls} extra match_thoughts calls`);
  if (process.env.OB1_DECOMP_PROBE) for (const t of SLICES) if (probe[t]) {
    const line = (b: Record<string, number>) => `rank0 ${b["0"]} | 1-2 ${b["1-2"]} | 3-4 ${b["3-4"]} | 5-9 ${b["5-9"]} | 10+ ${b["10+"]} | absent ${b.absent}`;
    const n = Object.values(probe[t]).reduce((x, y) => x + y, 0);
    console.log(`  gold rank, blended pool  [${t.split("-")[0]}, n=${n}]: ${line(probeBlend[t])}`);
    console.log(`  gold rank, best sub-pool [${t.split("-")[0]}, n=${n}]: ${line(probe[t])}`);
  }
  if (process.env.OB1_DECOMP_DUMP) { writeFileSync(process.env.OB1_DECOMP_DUMP, JSON.stringify(dump, null, 2)); console.log(`  wrote sub-questions -> ${process.env.OB1_DECOMP_DUMP}`); }
}

if (ARMS.includes("decomp-heur")) await runDecomp("decomp-heur", heuristicSplit);
if (ARMS.includes("decomp-llm")) await runDecomp("decomp-llm", llmSplit);

console.log(`\nAn atomic question reuses the baseline pool by construction (guard above). The`);
console.log(`blended pool already covers the set (the oracle), and on fired questions the`);
console.log(`decomposed union covers no more; an LLM split only lifts each event's gold up its`);
console.log(`OWN sub-pool (rank-0 share ~39%->61%). Strict@5 still barely moves, because the`);
console.log(`multi-hop miss is set ASSEMBLY, not coverage or per-event rank: fusion cannot tell`);
console.log(`each sub-pool's one gold from its topical distractors. That discrimination is a`);
console.log(`reranker's single-hop job (any-hit ~99%) — the gated next step.`);
await sql.end();
