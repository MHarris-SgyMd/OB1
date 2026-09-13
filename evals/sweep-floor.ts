#!/usr/bin/env bun
/**
 * sweep-floor.ts — SMD-1300 characterisation: what the admission rule costs and
 * buys on the LongMemEval load, across absolute thresholds and a relative
 * (fraction-of-top) cutoff, by document-length bucket.
 *
 * The ticket asks to "decide the floor by measurement, not by lowering a
 * constant." eval-longmemeval.ts measured the two endpoints (0.5 → 45.3%, −1 →
 * 87.7%); this sweeps the middle and the relative alternative so the rule that
 * ships in migration 027 is the one the numbers pick.
 *
 * METHOD. For each question and each k, call the SHIPPED search_thoughts_hybrid
 * once at threshold −1, limit k — the shipped call's own candidate window is its
 * limit, so this is exactly the row set search_thoughts would fuse at that k,
 * with the floor removed. Each candidate carries its raw cosine `similarity` and
 * `matched_needles`. Every admission rule is then applied to that identical set
 * in TS (the floor only ever removes rows; it never reorders), so the arms
 * differ only in admission. Widening the candidate window is a separate lever
 * (SMD-1301) and is deliberately NOT swept here.
 *
 * A keyword hit (`matched_needles` non-empty) is exempt from every floor, as the
 * function has it. The relative rule keeps the top-ranked row unconditionally,
 * then every row whose similarity is within `f` of the top candidate's.
 *
 *   OB1_EVAL_LME=/path/longmemeval_s.json DATABASE_URL=postgres://... bun sweep-floor.ts
 *   OB1_EVAL_LME_MAP=/path/map.json          session→thought map from the load
 *   OB1_EVAL_EMBED=qwen3-embedding:0.6b@1024 embedding spec (must match the load)
 *   OB1_EVAL_MAX_QUESTIONS=20                score a prefix only (smoke test)
 */
import { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
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
const BATCH = Number(process.env.OB1_EVAL_BATCH ?? 32);
const MAXQ = Number(process.env.OB1_EVAL_MAX_QUESTIONS ?? 0);
const MAP_PATH = process.env.OB1_EVAL_LME_MAP ?? `/tmp/lme-map-${EMBED_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;

type Turn = { role: string; content: string };
type Question = {
  question_id: string;
  question_type: string;
  question: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
};
const questions = JSON.parse(readFileSync(DATA, "utf8")) as Question[];

// Session → token estimate, for the length buckets. The gold session's length is
// what the floor's document-length asymmetry turns on.
const sidTokens = new Map<string, number>();
for (const q of questions) {
  q.haystack_session_ids.forEach((sid, i) => {
    if (sidTokens.has(sid)) return;
    const body = q.haystack_sessions[i].map((t) => `${t.role}: ${t.content}`).join("\n\n");
    sidTokens.set(sid, Math.round((`Session date: ${q.haystack_dates[i]}\n\n${body}`).length / 4));
  });
}

type SidMap = Record<string, string>;
const map: SidMap = existsSync(MAP_PATH) ? (JSON.parse(readFileSync(MAP_PATH, "utf8")) as SidMap) : {};
if (!Object.keys(map).length) { console.error(`no map at ${MAP_PATH}; run the eval-longmemeval load first.`); process.exit(2); }
const idToSids = new Map<string, string[]>();
for (const [sid, id] of Object.entries(map)) idToSids.set(id, [...(idToSids.get(id) ?? []), sid]);

async function embedMany(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH).map((t) => applyPrompt(spec, t, true));
    const r = await fetch(`${EVAL_BASE}/embeddings`, {
      method: "POST", headers: EVAL_HEADERS,
      body: JSON.stringify({ model: spec.name, input: slice, ...(spec.dims ? { dimensions: spec.dims } : {}) }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = (await r.json()) as { data: { index: number; embedding: number[] }[] };
    const sorted = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    for (const v of sorted) if (v.length !== DIM) throw new Error(`provider returned ${v.length}-wide vectors for vector(${DIM})`);
    out.push(...sorted);
  }
  return out;
}
const toVector = (v: number[]) => `[${v.join(",")}]`;

const sql = new SQL({ url: URL_, max: 4 });

// The admission rules. Each returns the kept subset of the candidate list,
// order preserved (the SQL already returned fused order).
type Cand = { id: string; sim: number | null; matched: number };
type Rule = { key: string; keep: (rows: Cand[]) => Cand[] };
const kwExempt = (r: Cand) => r.matched > 0;
const absRule = (t: number): Rule => ({
  key: t < 0 ? "abs@-1" : `abs@${t}`,
  keep: (rows) => rows.filter((r) => kwExempt(r) || (r.sim != null && r.sim > t)),
});
const relRule = (f: number): Rule => ({
  key: `rel@${f}`,
  keep: (rows) => {
    const sims = rows.map((r) => r.sim).filter((s): s is number => s != null);
    const top = sims.length ? Math.max(...sims) : null;
    return rows.filter((r, i) => kwExempt(r) || i === 0 || (r.sim != null && top != null && r.sim >= f * top));
  },
});
const rules: Rule[] = [
  absRule(0.5), absRule(0.4), absRule(0.3), absRule(0.2), absRule(-1),
  relRule(0.5), relRule(0.6), relRule(0.7), relRule(0.8),
];

const KS = [5, 10];
const TYPES = ["single-session-user", "single-session-assistant", "single-session-preference", "multi-session", "temporal-reasoning", "knowledge-update", "ALL"];
const bucketOf = (tok: number) => (tok < 1000 ? "<1k" : tok <= 3000 ? "1k–3k" : ">3k");
const BUCKETS = ["<1k", "1k–3k", ">3k"];

type Cell = { strict: number; any: number; n: number; rows: number; short: number };
const cell = (): Cell => ({ strict: 0, any: 0, n: 0, rows: 0, short: 0 });
const table = new Map<string, Cell>();
const bump = (key: string, strict: boolean, any: boolean, rows: number, short: boolean) => {
  const c = table.get(key) ?? cell();
  c.n++; if (strict) c.strict++; if (any) c.any++; c.rows += rows; if (short) c.short++;
  table.set(key, c);
};

const scored = questions.filter((q) => !q.question_id.endsWith("_abs"));
const use = MAXQ ? scored.slice(0, MAXQ) : scored;
console.log(`▸ sweeping ${use.length} questions × ${rules.length} rules × ${KS.length} k — ${EMBED_MODEL}`);

const filterFor = (q: Question) => ({ lme_q: [q.question_id] });
const qvs = await embedMany(use.map((q) => q.question));
const t0 = Date.now();
let outside = 0;

for (let i = 0; i < use.length; i++) {
  const q = use[i];
  const qv = toVector(qvs[i]);
  const hay = new Set(q.haystack_session_ids);
  const gold = new Set(q.answer_session_ids);
  const goldTok = Math.max(0, ...[...gold].map((g) => sidTokens.get(g) ?? 0));
  const bucket = bucketOf(goldTok);
  for (const k of KS) {
    const raw = await sql`SELECT id, similarity, matched_needles
                          FROM search_thoughts_hybrid(${qv}::vector, ${q.question}, -1.0, ${k}, ${filterFor(q)}::jsonb)`;
    const cands: Cand[] = raw.map((r: { id: string; similarity: number | null; matched_needles: string[] | null }) => ({
      id: String(r.id),
      sim: r.similarity == null ? null : Number(r.similarity),
      matched: (r.matched_needles ?? []).length,
    }));
    for (const rule of rules) {
      const kept = rule.keep(cands);
      const sids: string[] = [];
      for (const c of kept) {
        const own = idToSids.get(c.id);
        if (!own) throw new Error(`CONTROL FAILED: ${c.id} not recorded by the loader`);
        const here = own.filter((sid) => hay.has(sid));
        if (!here.length) outside++;
        for (const sid of here) if (!sids.includes(sid)) sids.push(sid);
      }
      const top = new Set(sids.slice(0, k));
      const strict = [...gold].every((g) => top.has(g));
      const any = [...gold].some((g) => top.has(g));
      const short = kept.length < Math.min(k, hay.size);
      bump(`${rule.key}|${k}|${q.question_type}`, strict, any, kept.length, short);
      bump(`${rule.key}|${k}|ALL`, strict, any, kept.length, short);
      bump(`${rule.key}|${k}|B:${bucket}`, strict, any, kept.length, short);
    }
  }
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${use.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
if (outside) throw new Error(`CONTROL FAILED: ${outside} results outside the question's history`);

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");

for (const k of KS) {
  console.log(`\n## strict recall_all@${k} (any-hit@${k}), by question type\n`);
  console.log(`| rule | ${TYPES.map((t) => t.replace("single-session-", "ss-")).join(" | ")} | mean rows | short |`);
  console.log(`| --- | ${TYPES.map(() => "---").join(" | ")} | --- | --- |`);
  for (const rule of rules) {
    const cells = TYPES.map((t) => { const c = table.get(`${rule.key}|${k}|${t}`) ?? cell(); return `${pct(c.strict, c.n)} (${pct(c.any, c.n)})`; });
    const all = table.get(`${rule.key}|${k}|ALL`) ?? cell();
    console.log(`| ${rule.key} | ${cells.join(" | ")} | ${(all.rows / (all.n || 1)).toFixed(1)} | ${all.short} |`);
  }
  console.log(`\n### strict recall_all@${k} by gold-session length bucket\n`);
  console.log(`| rule | ${BUCKETS.join(" | ")} |`);
  console.log(`| --- | ${BUCKETS.map(() => "---").join(" | ")} |`);
  for (const rule of rules) {
    const cells = BUCKETS.map((b) => { const c = table.get(`${rule.key}|${k}|B:${b}`) ?? cell(); return `${pct(c.strict, c.n)} (n=${c.n})`; });
    console.log(`| ${rule.key} | ${cells.join(" | ")} |`);
  }
}
console.log(`\nrules: abs@t = admit sim > t (keyword hits exempt); rel@f = admit top row + rows with sim ≥ f × top_sim (keyword hits exempt). Candidate window = k (shipped); widening it is SMD-1301.`);

await sql.end();
