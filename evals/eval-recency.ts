#!/usr/bin/env bun
/**
 * eval-recency.ts — does blending age into match_thoughts help or hurt, on the
 * corpus this fork measures everything against?
 *
 * SMD-945 (migration 020) lets a caller weight cosine similarity against
 * exp(-age_days / half_life_days). The default weight is 0 and the ticket says
 * what to do if a weight hurts here: say so and keep it at 0. This harness is
 * that measurement, plus the two things the migration's header claims and
 * cannot prove on its own:
 *
 *   * the CONTROL — at weight 0 the function returns the same rows in the same
 *     order as 019's function (installed from its own file under another name
 *     on the same load, so it uses the same index and any HNSW recall noise is
 *     shared). No table is printed if any query disagrees.
 *   * the WINDOW — the blend can only reorder the candidates the scan produced,
 *     16 * N of them under a weight (4 * N without one). For every query and
 *     weight the function's top N is compared with an exact blended ranking of
 *     the whole table (a sequential scan, the oracle), and so is the top N a
 *     4 * N window would have given — the un-widened alternative, computed in
 *     TypeScript from the nearest 4 * N — so the factor is priced by what it
 *     recovers, not assumed.
 *
 * The task is eval-real's: each issue's TITLE is the query, its body the
 * document, so no one labelled anything. Every thought's created_at is the
 * issue's own creation date (the corpus builder records it since 2026-09-08),
 * so "age" here means what it means in the tracker. Note what that measures:
 * the right answer for a title is the issue itself, whatever its age, so this
 * corpus cannot show recency HELPING — an active brain's "what was I doing
 * about X" has no ground truth here. It shows what a weight COSTS on a
 * relevance task, which is the number the default should be set by.
 *
 * Arms: the grid of weights and half-lives below at two settings — as the
 * tools call it (10 results, threshold 0.5) and unbounded (100, −1). Per cell:
 * R@1, R@5, MRR, how many top-1s changed against weight 0, and the two window
 * overlaps against the oracle.
 *
 * The corpus is internal engineering data: read from /tmp, loaded into a
 * throwaway loopback Postgres, embedded by a local model, with document and
 * title vectors cached in /tmp by text hash.
 *
 *   OB1_EVAL_CORPUS=/tmp/linear-corpus-full.json ../db/with-postgres.sh bun eval-recency.ts
 *   OB1_EVAL_EMBED=qwen3-embedding:4b@1024   the embedding spec, as the other harnesses take it
 *   OB1_EVAL_MAX_QUERIES=50                  cap the query set (0 = all)
 */

import { SQL } from "bun";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";
import { embed, parseSpec } from "./lib.ts";
import { loadLinearCorpus, insertLinearThought, linearThoughtId, linearVectorCachePath, cachedDocumentVectors, type LinearDoc } from "./linear-corpus.ts";
import { strideSample } from "./identifiers.ts";
import { requireDatabaseUrl, resetSchema } from "../db/test-support.ts";
import { migrationValues, substituteMigration } from "../db/config.mjs";

loadEnv();
const URL_ = requireDatabaseUrl("eval-recency.ts");
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? Number(process.env.OB1_EMBEDDING_DIM || 1024);
const MAX = Number(process.env.OB1_EVAL_MAX_QUERIES ?? 0);
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

const WEIGHTS = [0, 0.1, 0.2, 0.3, 0.5, 1.0];
const HALF_LIVES = [30, 90, 365];
type Setting = { name: string; n: number; threshold: number };
const SETTINGS: Setting[] = [
  { name: "as shipped — 10 results, threshold 0.5, what search and search_thoughts send", n: 10, threshold: 0.5 },
  { name: "unbounded — 100 results, threshold −1, comparable to eval-real", n: 100, threshold: -1 },
];

const lit = (v: number[]) => `[${v.join(",")}]`;

// ── Load: bodies as thoughts, with real vectors and real dates ───────────────

const { path: corpusPath, docs } = loadLinearCorpus();
const dated = docs.filter((d) => d.createdAt);
if (dated.length !== docs.length) {
  console.error(`  ${docs.length - dated.length} of ${docs.length} documents carry no createdAt; rebuild the corpus with evals/build-linear-corpus.ts (it records the date since 2026-09-08).`);
  process.exit(2);
}
const body = (d: LinearDoc) => d.text;
console.log(`  corpus: ${docs.length} documents from ${corpusPath}; embed ${EMBED_MODEL} @ ${DIM}`);

const t0 = Date.now();
const { vectors, embedded } = await cachedDocumentVectors(docs, {
  path: linearVectorCachePath(EMBED_MODEL, "body"), dim: DIM, text: body, embed: (t) => embed(EMBED_MODEL, t),
});
const titled = docs.filter((d) => d.title.trim());
const { vectors: titleVectors, embedded: titlesEmbedded } = await cachedDocumentVectors(titled, {
  path: linearVectorCachePath(EMBED_MODEL, "title"), dim: DIM, text: (d) => d.title, embed: (t) => embed(EMBED_MODEL, t, true),
});
await resetSchema(URL_, { dim: DIM, model: spec.name });
const sql = new SQL({ url: URL_, max: 4 });
for (const d of docs) await insertLinearThought(sql, d, lit(vectors[d.id]), body(d), d.createdAt);
await sql.unsafe("VACUUM ANALYZE thoughts");
const loaded = new Set<string>((await sql`SELECT metadata->>'issue' AS issue FROM thoughts`).map((r: { issue: string }) => r.issue));
console.log(`  loaded ${loaded.size} thoughts (${embedded} bodies and ${titlesEmbedded} titles embedded now, the rest from cache) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const collapsed = docs.filter((d) => !loaded.has(d.id)).map((d) => d.id);
if (collapsed.length) console.log(`  ! ${collapsed.length} documents collapsed onto an earlier one by content fingerprint and are unreachable: ${collapsed.join(", ")}`);
const idOf = new Map<string, string>(); // thought uuid → issue id
for (const d of docs) idOf.set(linearThoughtId(d.id), d.id);

// The corpus's ages, so the half-lives below read against something.
const ages = (await sql`SELECT metadata->>'issue' AS issue, extract(epoch FROM (now() - created_at)) / 86400.0 AS days FROM thoughts ORDER BY days`)
  .map((r: { issue: string; days: number }) => ({ issue: r.issue, days: Number(r.days) }));
const pct = (p: number) => ages[Math.min(ages.length - 1, Math.floor(ages.length * p))].days;
console.log(`  ages:   ${pct(0).toFixed(0)}–${pct(0.999).toFixed(0)} days (median ${pct(0.5).toFixed(0)}); ${ages.filter((a) => a.days <= 30).length} under 30 days, ${ages.filter((a) => a.days <= 90).length} under 90, ${ages.filter((a) => a.days <= 365).length} under 365`);

// 019's function, under another name, for the control. Same file, same
// substitutions, so the only difference from the shipped one is 020's edit.
const m019 = readdirSync(MIGRATIONS).filter((f) => f.startsWith("019") && f.endsWith(".sql")).sort()[0];
const text019 = substituteMigration(readFileSync(join(MIGRATIONS, m019), "utf8"), migrationValues({ dim: DIM, model: spec.name }));
if (text019.split("FUNCTION match_thoughts(").length !== 2) throw new Error(`${m019} does not define match_thoughts exactly once`);
await sql.unsafe(text019.replace("FUNCTION match_thoughts(", "FUNCTION match_thoughts_019("));

// ── Per query: the function at every cell, 019's function, the oracles ──────

type Query = { q: string; want: string };
const queries: Query[] = strideSample(titled.filter((d) => loaded.has(d.id)).map((d) => ({ q: d.title, want: d.id })), MAX);
console.log(`  queries: ${queries.length} titles → bodies${MAX ? ` (capped at ${MAX})` : ""}`);

type Ranked = { id: string; sim: number; score: number }[];
type Cell = { w: number; h: number };
const cells: Cell[] = [{ w: 0, h: 90 }, ...WEIGHTS.filter((w) => w > 0).flatMap((w) => HALF_LIVES.map((h) => ({ w, h })))];
const key = (c: Cell) => `${c.w}/${c.h}`;
type Raw = {
  fn: Record<string, Record<string, Ranked>>;       // setting name → cell key → the function's rows
  was: Record<string, string[]>;                    // setting name → 019's rows (control)
  oracle: Record<string, Record<string, string[]>>; // setting name → cell key → exact blended top-N over the whole table
  narrow: Record<string, Record<string, string[]>>; // setting name → cell key → top-N a 4N window would give
  age: Map<string, number>;                         // issue id → age in days, for the narrow window
};

const blendExpr = (w: number, h: number) =>
  `(1 - (embedding <=> $1::vector)) * (1 - ${w}) + CASE WHEN created_at IS NULL THEN 0 ELSE exp(-GREATEST(extract(epoch FROM (now() - created_at)), 0) / 86400.0 / ${h}) END * ${w}`;

async function raw(q: Query): Promise<Raw> {
  const qv = lit(titleVectors[q.want]);
  const out: Raw = { fn: {}, was: {}, oracle: {}, narrow: {}, age: new Map() };
  for (const s of SETTINGS) {
    out.fn[s.name] = {};
    out.oracle[s.name] = {};
    out.narrow[s.name] = {};
    for (const c of cells) {
      const rows = await sql.unsafe(`SELECT id, similarity, score FROM match_thoughts($1::vector, $2::float, $3::int, '{}'::jsonb, $4::float, $5::float)`, [qv, s.threshold, s.n, c.w, c.h]);
      out.fn[s.name][key(c)] = rows.map((r: { id: string; similarity: number; score: number }) => ({ id: idOf.get(r.id)!, sim: Number(r.similarity), score: Number(r.score) }));
      // The oracle: the same blend over EVERY row, exactly — no index can serve
      // this ORDER BY, so the planner scans; the threshold gates raw similarity
      // as the function's does.
      const exact = await sql.unsafe(
        `SELECT id FROM thoughts WHERE embedding IS NOT NULL AND 1 - (embedding <=> $1::vector) > $2::float ORDER BY ${blendExpr(c.w, c.h)} DESC, id LIMIT $3::int`,
        [qv, s.threshold, s.n]);
      out.oracle[s.name][key(c)] = exact.map((r: { id: string }) => idOf.get(r.id)!);
    }
    const was = await sql.unsafe(`SELECT id FROM match_thoughts_019($1::vector, $2::float, $3::int, '{}'::jsonb)`, [qv, s.threshold, s.n]);
    out.was[s.name] = was.map((r: { id: string }) => idOf.get(r.id)!);
    // The narrow window: the nearest 4N by similarity (019's window), blended
    // in TypeScript with the same formula and cut to N. What the function
    // would have returned had 020 not widened the window.
    const near = await sql.unsafe(
      `SELECT id, 1 - (embedding <=> $1::vector) AS sim, extract(epoch FROM (now() - created_at)) / 86400.0 AS days
       FROM thoughts WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector LIMIT $2::int`, [qv, Math.max(s.n * 4, 20)]);
    for (const r of near as { id: string; days: number }[]) out.age.set(idOf.get(r.id)!, Number(r.days));
    for (const c of cells) {
      const ranked = (near as { id: string; sim: number; days: number }[])
        .map((r) => ({ id: idOf.get(r.id)!, sim: Number(r.sim), score: Number(r.sim) * (1 - c.w) + Math.exp(-Math.max(Number(r.days), 0) / c.h) * c.w }))
        .filter((r) => r.sim > s.threshold)
        .sort((a, b) => b.score - a.score || (linearThoughtId(a.id) < linearThoughtId(b.id) ? -1 : 1));
      out.narrow[s.name][key(c)] = ranked.slice(0, s.n).map((r) => r.id);
    }
  }
  return out;
}

process.stdout.write("  … the arms");
const results = new Map<Query, Raw>();
let done = 0;
for (const q of queries) {
  results.set(q, await raw(q));
  if (++done % 50 === 0) process.stdout.write(".");
}
process.stdout.write("\n");
await sql.unsafe(`DROP FUNCTION match_thoughts_019(vector, float, int, jsonb)`);

// ── Control ─────────────────────────────────────────────────────────────────

const disagreements: string[] = [];
for (const [q, r] of results) {
  for (const s of SETTINGS) {
    const now = r.fn[s.name][key(cells[0])];
    const was = r.was[s.name];
    if (now.length !== was.length || now.some((x, i) => x.id !== was[i])) disagreements.push(`"${q.q.slice(0, 50)}" [${s.n}/${s.threshold}]: 020 ${now.slice(0, 5).map((x) => x.id).join(",")}… 019 ${was.slice(0, 5).join(",")}…`);
    if (now.some((x) => x.score !== x.sim)) disagreements.push(`"${q.q.slice(0, 50)}" [${s.n}/${s.threshold}]: score ≠ similarity at weight 0`);
  }
}
if (disagreements.length) {
  console.error(`\n  ${disagreements.length} of ${results.size * SETTINGS.length} calls: at weight 0 the shipped function and 019's disagree — no table is printed until they say the same thing:\n    ${disagreements.slice(0, 6).join("\n    ")}`);
  await sql.close();
  process.exit(1);
}

// ── Report ──────────────────────────────────────────────────────────────────

const rankOf = (list: string[], want: string) => { const i = list.indexOf(want); return i < 0 ? Infinity : i + 1; };
const overlap = (a: string[], b: string[]) => { const B = new Set(b); return a.length ? a.filter((x) => B.has(x)).length / Math.max(a.length, b.length) : 1; };
console.log(`\n  ${results.size} queries; the control passed on every one (at weight 0 the shipped function returns 019's rows in 019's order, and score equals similarity, at both settings).`);
console.log(`  "window" is the share of the exact blended top-N the function's top-N contains (16N candidates under a weight); "4N" the same for the window 019 had, blended in TypeScript.`);

for (const s of SETTINGS) {
  console.log(`\n  ${s.name}\n`);
  console.log("  weight  half-life    R@1     R@5   not in top-N   MRR    top-1 changed   window    4N");
  console.log("  ──────  ─────────  ─────  ─────  ────────────  ─────  ─────────────  ──────  ──────");
  const base = new Map<Query, string>();
  for (const [q, r] of results) base.set(q, r.fn[s.name][key(cells[0])][0]?.id ?? "");
  for (const c of cells) {
    const ranks = queries.map((q) => rankOf(results.get(q)!.fn[s.name][key(c)].map((x) => x.id), q.want));
    const n = ranks.length || 1;
    const r1 = ranks.filter((r) => r === 1).length / n;
    const r5 = ranks.filter((r) => r <= 5).length / n;
    const miss = ranks.filter((r) => r > s.n).length;
    const mrr = ranks.reduce((a, r) => a + (r === Infinity ? 0 : 1 / r), 0) / n;
    const changed = queries.filter((q) => (results.get(q)!.fn[s.name][key(c)][0]?.id ?? "") !== base.get(q)).length;
    const win = queries.reduce((a, q) => a + overlap(results.get(q)!.fn[s.name][key(c)].map((x) => x.id), results.get(q)!.oracle[s.name][key(c)]), 0) / n;
    const nar = queries.reduce((a, q) => a + overlap(results.get(q)!.narrow[s.name][key(c)], results.get(q)!.oracle[s.name][key(c)]), 0) / n;
    console.log(
      `  ${String(c.w).padStart(6)}  ${(c.w === 0 ? "—" : `${c.h} d`).padStart(9)}  ${(r1 * 100).toFixed(0).padStart(4)}%  ${(r5 * 100).toFixed(0).padStart(4)}%  ${`${miss}/${queries.length}`.padStart(12)}  ${mrr.toFixed(3)}  ${String(changed).padStart(13)}  ${(win * 100).toFixed(1).padStart(5)}%  ${(nar * 100).toFixed(1).padStart(5)}%`);
  }
}

// Which queries a gentle weight moves, and which way, at the shipped setting.
const s0 = SETTINGS[0];
const gentle = { w: 0.2, h: 90 };
console.log(`\n  At weight ${gentle.w}, half-life ${gentle.h} days, ${s0.n} results: where the answer's rank moved against weight 0\n`);
let better = 0, worse = 0;
const moved: string[] = [];
for (const q of queries) {
  const r = results.get(q)!;
  const before = rankOf(r.fn[s0.name][key(cells[0])].map((x) => x.id), q.want);
  const after = rankOf(r.fn[s0.name][key(gentle)].map((x) => x.id), q.want);
  if (after < before) better++;
  if (after > before) worse++;
  if (after !== before && moved.length < 20) {
    const age = ages.find((a) => a.issue === q.want)?.days ?? NaN;
    moved.push(`    "${q.q.slice(0, 60)}" → ${q.want} (${age.toFixed(0)} days old): ${before === Infinity ? "—" : before} → ${after === Infinity ? "—" : after}`);
  }
}
console.log(moved.join("\n") || "    none.");
console.log(`\n  ${better} better, ${worse} worse, ${queries.length - better - worse} unchanged.`);

await sql.close();
