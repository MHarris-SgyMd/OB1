/**
 * decompose-rerank.ts — the follow-up query-decompose.ts (SMD-1318) pointed to,
 * measured (Linear SMD-1420). SMD-1318 found decomposition necessary but not
 * sufficient: it lifts each event's gold up its OWN sub-pool (best-across-sub-pools
 * rank-0 share 39%->61%) and its union covers the whole set (100% / 96.2% on fired
 * questions), yet decomp-only strict recall_all@5 barely moves (round-robin 80.2% /
 * 78.7% full slice, vs baseline 79.3% / 79.5%). SMD-1318 blamed SET ASSEMBLY —
 * merging 2–3 sub-pools into five slots — and predicted a per-hop reranker (a
 * cross-encoder's single-hop strength) would finish the job, since a reranker over
 * ONE blended multi-hop pool had collapsed (generic Qwen3-Reranker-4B, strict 66.1%
 * / 70.1%, SMD-1304). This harness measures that pipeline:
 *   decompose (SMD-1318) -> retrieve per sub-question -> RERANK each sub-pool ->
 *   interleave the reranked sub-pools -> take 5 distinct sessions.
 *
 * The answer this harness records, measured on TWO corpora and significance-tested:
 * decompose-then-rerank is DECLINED. Decomposition adds nothing over reranking one
 * blended pool; the reranker is the lever, and HOW you combine the sub-pools (rerank
 * each and interleave, merge them into one pool and rerank once, or just rerank the
 * one blended pool) does not matter. Fired-only strict recall_all@5 (round-robin),
 * MemReranker-4B, on LongMemEval-S (saturated) and LongMemEval-M-cleaned (~10x
 * haystacks, real headroom):
 *                                      S (multi/temporal)   M (multi/temporal)
 *   baseline                           80.0% / 82.7%        52.0% / 59.6%
 *   decomp-only round-robin            82.0% / 80.8%        62.0% / 57.7%
 *   one blended pool -> rerank         96.0% / 78.8%        78.0% / 78.8%
 *   decompose -> interleave rerank     94.0% / 78.8%        78.0% / 75.0%
 *   decompose -> merge -> rerank once  98.0% / 78.8%        78.0% / 78.8%
 *   oracle                             100.0% / 96.2%       86.0% / 86.5%
 *
 * McNemar exact (paired), fired questions, both corpora:
 *  - RERANKING vs baseline is a large, SIGNIFICANT lift on multi for every pool
 *    method (S p~0.02, M p=0.002-0.004) and on M temporal for the one-pool and merge
 *    arms (p=0.021; the interleave arm's smaller M-temporal lift, 75.0%, is p=0.06,
 *    not significant). Biggest on the harder M (multi +26). This is the SMD-1304
 *    reranker, and it earns its place.
 *  - The POOL-COMBINATION technique — interleave vs merge vs one blended pool — is
 *    NOT significant anywhere: either corpus, either slice, either reranker (every
 *    pairwise p >= 0.375, net win/loss of 0-4 questions; merge == one-pool EXACTLY
 *    on M). The S 94/96/98 spread was sampling noise, and M — with far more room
 *    (multi baseline miss-rate 20% on S -> 48% on M), the fair test — confirms it.
 *    Decomposition does not separate from reranking one pool even where there was
 *    every opportunity for a difference to appear.
 * Decomposition-as-RETRIEVAL does help on M (+10 multi, 52->62: several vectors
 * cover more of a huge haystack than one), but reranking one pool subsumes it
 * (78 >= 62). And on M even the GENERIC (non-benchmark) reranker lifts multi
 * significantly (52->72, p=0.021), so the multi benefit is not purely MemReranker's
 * benchmark-fit in the hard regime (SMD-1304's held-out caveat still applies to the
 * magnitude, and to temporal). Net: reranking one pool is the lever (SMD-1304/1319),
 * not decomposition; the motivated next step is a non-benchmark reranker (hosted
 * Voyage rerank-2.5, SMD-1319) over ONE pool, and SMD-1039's premise — a harder
 * corpus reveals what a saturated one hides — is validated here (M separates
 * rerank-vs-baseline cleanly where S could not).
 *
 * Two harness phases around the reranker, which is an out-of-stack torch process
 * (rerank-llm-reranker.py, CE_MODEL-swappable — MemReranker-4B is local,
 * Apache-2.0), so the reranker code is reused UNCHANGED. The reranker's query is
 * the SUB-question and its pool is that sub-question's rows, so it runs on the
 * single-hop shape where its strength applies, never the blended multi-hop pool.
 *
 *  1. dump  — reads the sub-questions query-decompose.ts writes (OB1_DECOMP_DUMP;
 *     query-decompose stays the decomposition authority, not re-implemented here),
 *     retrieves top-SUBK per sub-question, and writes THREE reranker pool files so
 *     every pool-combination strategy is comparable on one dump: the per-sub-pool
 *     pool (POOL_OUT, for the INTERLEAVE arm), the round-robin UNION of the sub-pools
 *     as one pool (POOL_OUT.merged, for the MERGE arm), and the single blended
 *     top-POOL pool (POOL_OUT.blended, the SMD-1304 ONE-POOL arm) — each with a
 *     `.map` beside it (rerank-llm-reranker.py reads POOLF+".map"). Also writes a
 *     DB-free meta sidecar (per question: gold, hay, sub-pool ids, baseline top-5,
 *     decomposition-only round-robin) and prints the SMD-1318 anchors.
 *  2. score — reads the reranker's ranks back and scores strict recall_all@5 on the
 *     fired set AND the full slice: the INTERLEAVE arm from OB1_DR_RANKS (per-sub-pool
 *     ranks, interleaved round-robin), and — when given — the MERGE arm from
 *     OB1_DR_MERGED_RANKS and the ONE-POOL arm from OB1_DR_BLENDED_RANKS (both keyed
 *     by parent qid, taken straight). Unfired questions fall through to the baseline
 *     pool for every arm (the single-topic invariant). No DB: a pure function of the
 *     meta sidecar + the reranker's ranks.
 *
 * Reuses a persisted eval-longmemeval load (its DB + session→thought map); it
 * neither loads nor re-embeds the corpus. Run query-decompose.ts's dump first, then:
 *
 *   # phase 1 — build the three reranker pools + meta sidecar
 *   OB1_EVAL_LME=/path/longmemeval_s.json DATABASE_URL=postgres://... \
 *   OB1_EVAL_LME_MAP=/path/lme-map-0.6b.json OB1_EVAL_EMBED=qwen3-embedding:0.6b@1024 \
 *   OB1_DR_SUBS=/path/decomp-llm-full.json OB1_DR_POOL_OUT=/tmp/dr-pool.json \
 *     bun evals/decompose-rerank.ts
 *   # phase 2 — rerank all three pools. CE_POOL must be >= the largest merged union
 *   # (a round-robin union of up to MAX_SUBQ x SUBK sub-pool ids; it maxed at 44
 *   # here, so 60 sufficed) so no candidate is truncated before reranking.
 *   for P in "" .merged .blended; do RR_POOL_FILE=/tmp/dr-pool.json$P \
 *     CE_MODEL=IAAR-Shanghai/MemReranker-4B RANKS_OUT=dr-ranks$P.json CE_POOL=60 \
 *     uv run --no-project --python 3.12 --with transformers --with torch --with accelerate \
 *     python evals/rerank-llm-reranker.py; done
 *   # phase 3 — score all three arms
 *   OB1_DR_META=/tmp/dr-pool.json.meta OB1_DR_RANKS=<dir>/dr-ranks.json \
 *     OB1_DR_MERGED_RANKS=<dir>/dr-ranks.merged.json OB1_DR_BLENDED_RANKS=<dir>/dr-ranks.blended.json \
 *     bun evals/decompose-rerank.ts --score
 *
 * LongMemEval-M: same 500 questions, ~10x haystacks. eval-longmemeval.ts's loader
 * readFileSync's the whole corpus, and bun (JavaScriptCore) cannot allocate a 2.5 GB
 * string, so the M corpus is loaded in question shards into its own DB and this
 * harness is pointed at a SLIM M file (haystack_sessions dropped — already in the
 * DB; only the light fields are read here) with the SAME decomp dump (M's questions
 * are S's, so the split is identical). See evals/README.md for the recipe.
 *
 *   OB1_DR_SUBK=20         top-k retrieved PER sub-question (match query-decompose's SUBK)
 *   OB1_DR_POOL=30         blended-pool depth for the baseline/oracle anchor + one-pool arm
 *   OB1_DR_FUSE=roundrobin interleave the reranked sub-pools: roundrobin | rrf
 *   OB1_DR_MERGED_RANKS    reranker ranks over POOL_OUT.merged  (adds the MERGE arm)
 *   OB1_DR_BLENDED_RANKS   reranker ranks over POOL_OUT.blended (adds the ONE-POOL arm)
 */
import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { EVAL_BASE, EVAL_HEADERS, applyPrompt, parseSpec } from "./lib.ts";

loadEnv();
const SCORE = process.argv.includes("--score");
const SUBK = Number(process.env.OB1_DR_SUBK ?? 20);
const POOL = Number(process.env.OB1_DR_POOL ?? 30);
const FUSE = (process.env.OB1_DR_FUSE ?? "roundrobin") as "roundrobin" | "rrf";
// The two slices that carry the post-floor misses (as in query-decompose.ts).
const SLICES = ["multi-session", "temporal-reasoning"];
const MAX_SUBQ = 6;

type Turn = { role: string; content: string };
type Question = { question_id: string; question_type: string; question: string; question_date: string;
  haystack_dates: string[]; haystack_session_ids: string[]; haystack_sessions: Turn[][]; answer_session_ids: string[] };
// Per-question meta the score phase needs, with no DB: enough to reassemble the
// interleave and to score it against baseline / decomp-only / oracle.
type Meta = {
  qid: string; type: string; gold: string[]; hay: string[];
  fired: boolean; subQids: string[];      // one per sub-pool, in interleave order
  baseTop5: string[];                     // baseline blended pool -> distinct sessions, take 5
  decompRR: string[];                     // decomposition-only round-robin -> take 5 (the SMD-1318 anchor)
  oracleHit: boolean;                     // all golds present in the blended POOL pool
};
// The merged arm keys its reranker ranks by the PARENT qid (one merged pool per
// question), so a plain string is enough to look them up.

const pct = (a: number, b: number) => (b ? `${(100 * a / b).toFixed(1)}%` : "—");
type Agg = Record<string, [number, number]>; // type -> [hit, n]
function report(label: string, a: Agg) {
  console.log(`  ${label.padEnd(40)} ${SLICES.map((t) => `${t.split("-")[0]} ${pct(a[t]?.[0] ?? 0, a[t]?.[1] ?? 0)}`).join("   ")}`);
}

// Round-robin interleave of several ranked id lists (each list's rank-0 first,
// then every rank-1, …); or reciprocal-rank fusion across them. Distinct ids in
// first-seen order — the caller resolves ids to distinct sessions afterwards.
function interleave(lists: string[][], mode: typeof FUSE): string[] {
  if (lists.length === 1) return lists[0];
  if (mode === "rrf") {
    const K0 = 60; const score = new Map<string, number>();
    for (const l of lists) l.forEach((id, r) => score.set(id, (score.get(id) ?? 0) + 1 / (K0 + r + 1)));
    return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  const out: string[] = []; const seen = new Set<string>();
  const depth = Math.max(0, ...lists.map((l) => l.length));
  for (let r = 0; r < depth; r++) for (const l of lists) {
    const id = l[r]; if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// Resolve a ranked id list to distinct in-haystack sessions, first-seen order.
function sessionsOf(ids: string[], idToSids: Map<string, string[]>, hay: Set<string>, k: number): string[] {
  const sids: string[] = [];
  for (const id of ids) { const own = idToSids.get(id); if (!own) continue;
    for (const sid of own.filter((s) => hay.has(s))) if (!sids.includes(sid)) sids.push(sid); }
  return sids.slice(0, k);
}
const strictHit = (sessions: string[], gold: string[]) => { const top = new Set(sessions); return gold.every((g) => top.has(g)); };

// ══════════════════════════════════════════════════════════════════════════════
// SCORE PHASE — pure function of the meta sidecar + the reranker's ranks.
// ══════════════════════════════════════════════════════════════════════════════
if (SCORE) {
  const METAF = process.env.OB1_DR_META;
  const RANKSF = process.env.OB1_DR_RANKS;
  if (!METAF || !existsSync(METAF)) { console.error("OB1_DR_META must name the meta sidecar from the dump phase."); process.exit(2); }
  if (!RANKSF || !existsSync(RANKSF)) { console.error("OB1_DR_RANKS must name the reranker's ranks output."); process.exit(2); }
  const bundle = JSON.parse(readFileSync(METAF, "utf8")) as { subk: number; pool: number; idToSids: Record<string, string[]>; metas: Meta[] };
  const idToSids = new Map<string, string[]>(Object.entries(bundle.idToSids));
  const ranks = JSON.parse(readFileSync(RANKSF, "utf8")) as Record<string, string[]>;
  const metas = bundle.metas;
  // Optional MERGE arm: reranker ranks over the merged union pool, keyed by PARENT
  // qid (from OB1_DR_POOL_OUT.merged reranked in one pass with the original question).
  const MERGEDF = process.env.OB1_DR_MERGED_RANKS;
  const mergedRanks: Record<string, string[]> | null =
    MERGEDF && existsSync(MERGEDF) ? JSON.parse(readFileSync(MERGEDF, "utf8")) : null;
  // Optional ONE-POOL arm: reranker ranks over the single blended pool, keyed by
  // PARENT qid (from OB1_DR_POOL_OUT.blended) — the SMD-1304 shape, reproduced here.
  const BLENDEDF = process.env.OB1_DR_BLENDED_RANKS;
  const blendedRanks: Record<string, string[]> | null =
    BLENDEDF && existsSync(BLENDEDF) ? JSON.parse(readFileSync(BLENDEDF, "utf8")) : null;

  console.log(`▸ score: ${metas.length} questions; subk=${bundle.subk} pool=${bundle.pool}; interleave=${FUSE}; ranks=${Object.keys(ranks).length} sub-pools${mergedRanks ? `; +merge (${Object.keys(mergedRanks).length})` : ""}${blendedRanks ? `; +one-pool (${Object.keys(blendedRanks).length})` : ""}`);

  // Coverage guard: a reranker run that crashed or was interrupted leaves ranks
  // for only the sub-pools it reached, and a missing sub-pool drops a whole hop
  // from the interleave — which reads as a spurious negative, not an error. Refuse
  // to present the rerank arm as trustworthy unless every fired sub-pool is covered.
  const firedN = metas.filter((m) => m.fired).length;
  const banner = (what: string, have: number, need: number) => {
    console.log(`\n  ####################################################################`);
    console.log(`  # INCOMPLETE RERANKER RUN: ${have}/${need} fired ${what} have ranks.`);
    console.log(`  # The affected rerank column below drops the missing entries and`);
    console.log(`  # UNDER-REPORTS strict@5 — do NOT read it as a real result. Re-run the`);
    console.log(`  # reranker to completion (RANKS_OUT), then score again.`);
    console.log(`  ####################################################################`);
  };
  const expectedSubPools = metas.reduce((n, m) => n + m.subQids.length, 0);
  const coveredSubPools = metas.reduce((n, m) => n + m.subQids.filter((sq) => ranks[sq]).length, 0);
  if (coveredSubPools < expectedSubPools) banner("interleave sub-pools", coveredSubPools, expectedSubPools);
  // The MERGE and ONE-POOL arms carry the headline numbers, so guard them just as
  // loudly: each is one reranked pool per fired question, keyed by parent qid.
  if (mergedRanks) { const c = metas.filter((m) => m.fired && mergedRanks[m.qid]).length; if (c < firedN) banner("merge pools", c, firedN); }
  if (blendedRanks) { const c = metas.filter((m) => m.fired && blendedRanks[m.qid]).length; if (c < firedN) banner("one-pool (blended) pools", c, firedN); }

  // Full-slice strict@5 for each arm: unfired questions fall through to the
  // baseline blended top-5 for every arm (the single-topic invariant), so the
  // arms differ only on the fired questions.
  const base: Agg = {}, decomp: Agg = {}, rerank: Agg = {}, merged: Agg = {}, onepool: Agg = {}, oracle: Agg = {};
  // Fired-only strict@5: the set where decomposition + rerank actually act.
  const baseF: Agg = {}, decompF: Agg = {}, rerankF: Agg = {}, mergedF: Agg = {}, onepoolF: Agg = {}, oracleF: Agg = {};
  let missingMerged = 0, missingBlended = 0;
  // Gold rank after the per-hop rerank: best rank of each fired gold across its
  // reranked sub-pools — the headroom (39% not at rank 0) this step aims to close.
  const blank = () => ({ "0": 0, "1-2": 0, "3-4": 0, "5-9": 0, "10+": 0, absent: 0 });
  const bucket = (r: number) => r < 0 ? "absent" : r === 0 ? "0" : r <= 2 ? "1-2" : r <= 4 ? "3-4" : r <= 9 ? "5-9" : "10+";
  const rankHist: Record<string, Record<string, number>> = {};
  let missingRanks = 0;

  for (const m of metas) {
    const hay = new Set(m.hay);
    const bump = (a: Agg, hit: boolean) => { a[m.type] ??= [0, 0]; a[m.type][1]++; if (hit) a[m.type][0]++; };
    const baseHit = strictHit(m.baseTop5, m.gold);
    const decompHit = strictHit(m.fired ? m.decompRR : m.baseTop5, m.gold);
    // rerank arm: interleave the reranked sub-pools; unfired falls through to base.
    let rerankSessions = m.baseTop5;
    if (m.fired) {
      const lists = m.subQids.map((sq) => { const r = ranks[sq]; if (!r) missingRanks++; return r ?? []; });
      rerankSessions = sessionsOf(interleave(lists, FUSE), idToSids, hay, 5);
    }
    const rerankHit = strictHit(rerankSessions, m.gold);
    // merge arm: one reranked pass over the merged union pool (keyed by parent qid);
    // unfired falls through to base. Scored only when merged ranks are provided.
    let mergedHit = baseHit;
    if (mergedRanks && m.fired) {
      const r = mergedRanks[m.qid]; if (!r) missingMerged++;
      mergedHit = strictHit(sessionsOf(r ?? [], idToSids, hay, 5), m.gold);
    }
    // one-pool arm: single reranked pass over the blended pool; unfired -> base.
    let onepoolHit = baseHit;
    if (blendedRanks && m.fired) {
      const r = blendedRanks[m.qid]; if (!r) missingBlended++;
      onepoolHit = strictHit(sessionsOf(r ?? [], idToSids, hay, 5), m.gold);
    }

    bump(base, baseHit); bump(decomp, decompHit); bump(rerank, rerankHit); bump(oracle, m.oracleHit);
    if (mergedRanks) bump(merged, mergedHit);
    if (blendedRanks) bump(onepool, onepoolHit);
    if (m.fired) {
      bump(baseF, baseHit); bump(decompF, decompHit); bump(rerankF, rerankHit); bump(oracleF, m.oracleHit);
      if (mergedRanks) bump(mergedF, mergedHit);
      if (blendedRanks) bump(onepoolF, onepoolHit);
      // per-gold best rank across reranked sub-pools
      for (const g of m.gold) {
        if (!hay.has(g)) continue;
        let best = Infinity;
        for (const sq of m.subQids) {
          const r = ranks[sq]; if (!r) continue;
          const rank = sessionsOf(r, idToSids, hay, r.length).indexOf(g);
          if (rank >= 0) best = Math.min(best, rank);
        }
        (rankHist[m.type] ??= blank())[bucket(best === Infinity ? -1 : best)]++;
      }
    }
  }

  console.log(`\n  --- full slice (unfired questions = baseline pool, unchanged) ---`);
  report("baseline (one vector, take 5)", base);
  report("decomp-only round-robin", decomp);
  if (blendedRanks) report("one blended pool -> rerank", onepool);
  report(`decompose -> interleave rerank (${FUSE})`, rerank);
  if (mergedRanks) report("decompose -> merge -> rerank once", merged);
  report(`oracle (perfect reorder of top-${bundle.pool})`, oracle);
  console.log(`\n  --- fired questions only (where decomposition + rerank act) ---`);
  report("baseline (blended, take 5)", baseF);
  report("decomp-only round-robin", decompF);
  if (blendedRanks) report("one blended pool -> rerank", onepoolF);
  report(`decompose -> interleave rerank (${FUSE})`, rerankF);
  if (mergedRanks) report("decompose -> merge -> rerank once", mergedF);
  report("oracle", oracleF);
  const line = (b: Record<string, number>) => `rank0 ${b["0"]} | 1-2 ${b["1-2"]} | 3-4 ${b["3-4"]} | 5-9 ${b["5-9"]} | 10+ ${b["10+"]} | absent ${b.absent}`;
  console.log(`\n  gold rank after per-hop rerank (best across a gold's reranked sub-pools; fired questions):`);
  for (const t of SLICES) if (rankHist[t]) {
    const n = Object.values(rankHist[t]).reduce((x, y) => x + y, 0);
    console.log(`  [${t.split("-")[0]}, n=${n}]: ${line(rankHist[t])}`);
  }
  if (missingRanks) console.log(`\n  ! ${missingRanks} sub-pool(s) had no ranks entry — an incomplete interleave reranker run; treated as empty.`);
  if (mergedRanks && missingMerged) console.log(`  ! ${missingMerged} merged pool(s) had no ranks entry — an incomplete merge reranker run; treated as empty.`);
  if (blendedRanks && missingBlended) console.log(`  ! ${missingBlended} blended pool(s) had no ranks entry — an incomplete one-pool reranker run; treated as empty.`);
  console.log(`\nCompare the three rerank rows (one-pool / interleave / merge) to each other and`);
  console.log(`to baseline — with a PAIRED test (McNemar exact on the per-question hits), not by`);
  console.log(`eye: on ~100 fired questions a 1-2 question gap is noise. What SMD-1420 found across`);
  console.log(`LongMemEval-S (saturated) and -M (headroom): reranking (any pool method) is a large,`);
  console.log(`SIGNIFICANT lift on multi (and on M temporal); the pool-combination technique is NOT`);
  console.log(`significant anywhere. Reranking one pool is the lever, not decomposition. Declined;`);
  console.log(`see FORK / README for the significance tables and the two-corpus verdict.`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// DUMP PHASE — retrieve per sub-question, write the per-sub-pool reranker pool.
// ══════════════════════════════════════════════════════════════════════════════
const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error("DATABASE_URL is required."); process.exit(2); }
const DATA = process.env.OB1_EVAL_LME;
if (!DATA || !existsSync(DATA)) { console.error("OB1_EVAL_LME must name longmemeval_s.json."); process.exit(2); }
const SUBS_PATH = process.env.OB1_DR_SUBS;
if (!SUBS_PATH || !existsSync(SUBS_PATH)) { console.error("OB1_DR_SUBS must name query-decompose.ts's sub-question dump (OB1_DECOMP_DUMP output)."); process.exit(2); }
const POOL_OUT = process.env.OB1_DR_POOL_OUT;
if (!POOL_OUT) { console.error("OB1_DR_POOL_OUT is required (the reranker pool file to write)."); process.exit(2); }
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:0.6b@1024";
const spec = parseSpec(EMBED_MODEL);
const MAP_PATH = process.env.OB1_EVAL_LME_MAP ?? `/tmp/lme-map-${EMBED_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;
if (!existsSync(MAP_PATH)) { console.error(`no map at ${MAP_PATH}; run eval-longmemeval.ts load first.`); process.exit(2); }

const questionsAll = (JSON.parse(readFileSync(DATA, "utf8")) as Question[])
  .filter((q) => SLICES.includes(q.question_type) && !q.question_id.endsWith("_abs"));
const byId = new Map(questionsAll.map((q) => [q.question_id, q]));
// The decomposition authority: query-decompose.ts's dump of sub-questions per
// question. We consume it rather than re-implement the (fragile) LLM split.
const subsDump = JSON.parse(readFileSync(SUBS_PATH, "utf8")) as { qid: string; type: string; question: string; subs: string[] }[];
const subsByQid = new Map(subsDump.map((d) => [d.qid, d.subs.slice(0, MAX_SUBQ)]));
// Score exactly the questions the dump covers (and that survive the slice filter).
const questions = subsDump.map((d) => byId.get(d.qid)).filter((q): q is Question => !!q);
if (questions.length !== subsDump.length) console.error(`! ${subsDump.length - questions.length} dumped question(s) not found in the slice — check OB1_DR_SUBS matches the embed/slices.`);

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
type Ranked = { id: string; sim: number; content: string }[];
async function poolFor(vec: number[], qid: string, k: number): Promise<Ranked> {
  const rows = await sql`SELECT id, content, similarity FROM match_thoughts(${toVector(vec)}::vector, -1.0, ${k}, ${{ lme_q: [qid] }}::jsonb)` as any[];
  return rows.map((r) => ({ id: r.id, sim: r.similarity, content: r.content }));
}

console.log(`▸ dump: ${questions.length} questions (${SLICES.join(" + ")}); subk=${SUBK} pool=${POOL}; embed=${EMBED_MODEL}`);

// One blended vector per question -> the baseline/oracle anchor + the unfired
// fall-through.
const qvs = await embedMany(questions.map((q) => q.question), true);
const basePools: Ranked[] = [];
for (let i = 0; i < questions.length; i++) basePools.push(await poolFor(qvs[i], questions[i].question_id, POOL));

// Fired questions: embed each distinct sub-question once, retrieve top-SUBK per.
const distinctSubs = [...new Set(
  questions.flatMap((q) => { const s = subsByQid.get(q.question_id) ?? []; return s.length > 1 ? s : []; }))];
const subEmb = new Map<string, number[]>();
const subVecs = await embedMany(distinctSubs, true);
distinctSubs.forEach((s, j) => subEmb.set(s, subVecs[j]));
const embedCount = distinctSubs.length; // sub-questions are embedded deduped, so this is < the sub-pool count

const poolEntries: any[] = [];   // one per sub-pool, for the INTERLEAVE arm's reranker
const mergedEntries: any[] = []; // one MERGED union pool per fired question, for the MERGE arm's reranker
const blendedEntries: any[] = [];// one BLENDED top-POOL pool per fired question, for the ONE-POOL arm (SMD-1304 shape, reproducible here)
const metas: Meta[] = [];
let subPools = 0;
const t0 = Date.now();
for (let i = 0; i < questions.length; i++) {
  const q = questions[i];
  const subs = subsByQid.get(q.question_id) ?? [q.question];
  const fired = subs.length > 1;
  const hay = new Set(q.haystack_session_ids);
  const gold = q.answer_session_ids;
  const baseTop5 = sessionsOf(basePools[i].map((c) => c.id), idToSids, hay, 5);
  // oracle: all golds present among the blended POOL pool's distinct sessions.
  const present = new Set<string>();
  for (const c of basePools[i]) for (const sid of (idToSids.get(c.id) ?? []).filter((s) => hay.has(s))) present.add(sid);
  const oracleHit = gold.length <= 5 && gold.every((g) => present.has(g));

  const subQids: string[] = [];
  let decompRR = baseTop5;
  if (fired) {
    const rawPools: string[][] = [];
    const unionContent = new Map<string, string>();
    for (let j = 0; j < subs.length; j++) {
      const s = subs[j];
      const sqid = `${q.question_id}#${j}`;
      const pool = await poolFor(subEmb.get(s)!, q.question_id, SUBK); subPools++;
      subQids.push(sqid);
      rawPools.push(pool.map((c) => c.id));
      for (const c of pool) unionContent.set(c.id, c.content);
      poolEntries.push({ qid: sqid, parent: q.question_id, type: q.question_type,
        question: s, gold, hay: q.haystack_session_ids,
        cands: pool.map((c) => c.id), contents: Object.fromEntries(pool.map((c) => [c.id, c.content])) });
    }
    // decomposition-only round-robin over the RAW (retrieval-order) sub-pools —
    // the SMD-1318 anchor the rerank arm must beat.
    decompRR = sessionsOf(interleave(rawPools, "roundrobin"), idToSids, hay, 5);
    // MERGE arm: the round-robin UNION of the sub-pools as ONE candidate set, to be
    // reranked in a single pass with the ORIGINAL question — decomposition used for
    // recall, then one reranker pass with cross-candidate context (vs the INTERLEAVE
    // arm, which reranks each sub-pool separately). Keyed by the parent qid.
    const unionCands = interleave(rawPools, "roundrobin");
    mergedEntries.push({ qid: q.question_id, parent: q.question_id, type: q.question_type,
      question: q.question, gold, hay: q.haystack_session_ids,
      cands: unionCands, contents: Object.fromEntries(unionCands.map((id) => [id, unionContent.get(id)!])) });
    // ONE-POOL arm: the single blended top-POOL pool reranked with the original
    // question (the SMD-1304 shape) — emitted here for the SAME fired questions so
    // all pool-combination strategies are comparable on one dump.
    blendedEntries.push({ qid: q.question_id, parent: q.question_id, type: q.question_type,
      question: q.question, gold, hay: q.haystack_session_ids,
      cands: basePools[i].map((c) => c.id), contents: Object.fromEntries(basePools[i].map((c) => [c.id, c.content])) });
  }
  metas.push({ qid: q.question_id, type: q.question_type, gold, hay: q.haystack_session_ids, fired, subQids, baseTop5, decompRR, oracleHit });
}
await sql.end();

writeFileSync(POOL_OUT, JSON.stringify(poolEntries));
writeFileSync(`${POOL_OUT}.merged`, JSON.stringify(mergedEntries));
writeFileSync(`${POOL_OUT}.blended`, JSON.stringify(blendedEntries));
// rerank-llm-reranker.py reads the id→sessions map as `<pool file>.map`, so write
// one beside EVERY pool file it may be pointed at, not only the interleave pool.
const mapJson = JSON.stringify(Object.fromEntries(idToSids));
for (const p of ["", ".merged", ".blended"]) writeFileSync(`${POOL_OUT}${p}.map`, mapJson);
writeFileSync(`${POOL_OUT}.meta`, JSON.stringify({ subk: SUBK, pool: POOL, idToSids: Object.fromEntries(idToSids), metas }));

// Anchors on the fired set (so the reranked strict is read against them; these
// reproduce the SMD-1318 fired numbers from the retrieval-only pipeline).
const fired = metas.filter((m) => m.fired);
const anchor = (pick: (m: Meta) => string[]) => { const a: Agg = {};
  for (const m of fired) { a[m.type] ??= [0, 0]; a[m.type][1]++; if (strictHit(pick(m), m.gold)) a[m.type][0]++; } return a; };
console.log(`\n  fired ${fired.length}/${questions.length} (${pct(fired.length, questions.length)}); mean sub-qs ${(subPools / (fired.length || 1)).toFixed(2)}`);
console.log(`  --- anchors on the fired set (retrieval-only; no rerank yet) ---`);
report("baseline (blended, take 5)", anchor((m) => m.baseTop5));
report("decomp-only round-robin", anchor((m) => m.decompRR));
report("oracle", (() => { const a: Agg = {}; for (const m of fired) { a[m.type] ??= [0, 0]; a[m.type][1]++; if (m.oracleHit) a[m.type][0]++; } return a; })());
console.log(`  cost: +${embedCount} sub-query embeddings (deduped) and +${subPools} extra match_thoughts (one per sub-pool), ${((Date.now() - t0) / 1000).toFixed(1)}s retrieval`);
console.log(`\n  wrote INTERLEAVE reranker pool -> ${POOL_OUT}  (${poolEntries.length} sub-pools)`);
console.log(`  wrote MERGE reranker pool     -> ${POOL_OUT}.merged  (${mergedEntries.length} merged union pools)`);
console.log(`  wrote ONE-POOL reranker pool  -> ${POOL_OUT}.blended  (${blendedEntries.length} blended pools, the SMD-1304 shape)`);
console.log(`  wrote id→sessions map         -> ${POOL_OUT}.map`);
console.log(`  wrote score-phase meta        -> ${POOL_OUT}.meta`);
const maxUnion = Math.max(0, ...mergedEntries.map((e: any) => e.cands.length));
console.log(`\n  next: rerank the three pools (set CE_POOL >= ${maxUnion}, the largest merged union here), then score:`);
console.log(`    for P in "" .merged .blended; do RR_POOL_FILE=${POOL_OUT}$P CE_MODEL=IAAR-Shanghai/MemReranker-4B \\`);
console.log(`      RANKS_OUT=dr-ranks$P.json CE_POOL=60 uv run --no-project --python 3.12 \\`);
console.log(`      --with transformers --with torch --with accelerate python evals/rerank-llm-reranker.py; done`);
console.log(`    OB1_DR_META=${POOL_OUT}.meta OB1_DR_RANKS=<dir>/dr-ranks.json \\`);
console.log(`      OB1_DR_MERGED_RANKS=<dir>/dr-ranks.merged.json OB1_DR_BLENDED_RANKS=<dir>/dr-ranks.blended.json \\`);
console.log(`      bun evals/decompose-rerank.ts --score`);
