#!/usr/bin/env bun
/**
 * decoy-admission.ts — SMD-1300's short-corpus check: does the relative cutoff
 * (migration 027, what the tools send at threshold 0) admit more irrelevant rows
 * on SHORT thoughts than the old absolute 0.5 floor did?
 *
 * eval-longmemeval showed the floor's damage on LONG captures (recall). This is
 * the other half the ticket asks for: the PRECISION cost on the short tracker
 * corpus, reported before (threshold 0.5 — which migration 027 reproduces
 * exactly, since sim>0.5 implies sim>=0.5*top) and after (threshold 0, relative).
 *
 * Semantic queries: each issue's title, wanting its own body. For each, the
 * shipped function is called at 0.5 and at 0; we measure, per query, whether the
 * wanted doc is rank 1 (the floor must not reorder), how many rows come back, and
 * how many of them are NOT the wanted doc — the admission of everything else,
 * which on this corpus of distinct issues is the decoy/precision signal. Bucketed
 * by whether the query has a dominant top match (>=0.5, the short-thought case a
 * relative cutoff loosens most) or a weak one.
 *
 *   OB1_EVAL_CORPUS=/tmp/linear-corpus-full.json ../db/with-postgres.sh bun decoy-admission.ts
 *   OB1_EVAL_EMBED=qwen3-embedding:4b@1024   embedding spec (default: the fork default)
 */
import { SQL } from "bun";
import { loadEnv } from "./env.ts";
import { embed, parseSpec } from "./lib.ts";
import { loadLinearCorpus, insertLinearThought, linearThoughtId, linearVectorCachePath, cachedDocumentVectors, type LinearDoc } from "./linear-corpus.ts";
import { requireDatabaseUrl, resetSchema } from "../db/test-support.ts";

loadEnv();
const URL_ = requireDatabaseUrl("decoy-admission.ts");
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? 1024;
const lit = (v: number[]) => `[${v.join(",")}]`;

const { path: corpusPath, docs } = loadLinearCorpus();
const body = (d: LinearDoc) => d.text;
console.log(`  corpus: ${docs.length} documents from ${corpusPath}; embed ${EMBED_MODEL} @ ${DIM}`);

const { vectors, embedded } = await cachedDocumentVectors(docs, {
  path: linearVectorCachePath(EMBED_MODEL, "body"), dim: DIM, text: body, embed: (t) => embed(EMBED_MODEL, t),
});
await resetSchema(URL_, { dim: DIM, model: spec.name });
const sql = new SQL({ url: URL_, max: 4 });
for (const d of docs) await insertLinearThought(sql, d, lit(vectors[d.id]), body(d));
await sql.unsafe("VACUUM ANALYZE thoughts");
const loaded = new Set<string>((await sql`SELECT metadata->>'issue' AS issue FROM thoughts`).map((r: { issue: string }) => r.issue));
const idOf = new Map<string, string>(); // thought uuid → issue id
for (const d of docs) idOf.set(linearThoughtId(d.id), d.id);
console.log(`  loaded ${loaded.size} thoughts (${embedded} embedded now)\n`);

// Title → own body. A title is the query a person would type; the body is the gold.
const queries = docs.filter((d) => loaded.has(d.id) && d.title.trim()).map((d) => ({ q: d.title, want: d.id }));

type Row = { id: string; similarity: number | null };
async function run(qv: string, q: string, threshold: number): Promise<{ id: string; sim: number | null }[]> {
  const rows = (await sql`SELECT id, similarity FROM search_thoughts_hybrid(${qv}::vector, ${q}, ${threshold}::float, 10, ${{}}::jsonb)`) as Row[];
  return rows.map((r) => ({ id: idOf.get(String(r.id)) ?? String(r.id), sim: r.similarity == null ? null : Number(r.similarity) }));
}

type Cell = { n: number; rank1: number; rows: number; nonTarget: number };
const cell = (): Cell => ({ n: 0, rank1: 0, rows: 0, nonTarget: 0 });
// keyed `${threshold}|${bucket}` where bucket is dominant|weak|ALL
const table = new Map<string, Cell>();
const bump = (k: string, rank1: boolean, rows: number, nonTarget: number) => {
  const c = table.get(k) ?? cell();
  c.n++; if (rank1) c.rank1++; c.rows += rows; c.nonTarget += nonTarget;
  table.set(k, c);
};

const THRESHOLDS = [0.5, 0.0];
let rank1Changed = 0;
const t0 = Date.now();
for (let i = 0; i < queries.length; i++) {
  const { q, want } = queries[i];
  const qv = lit(await embed(EMBED_MODEL, q, true));
  const perThreshold: Record<number, { id: string; sim: number | null }[]> = {};
  for (const t of THRESHOLDS) perThreshold[t] = await run(qv, q, t);
  // The dominant/weak split uses the top raw cosine, read from the -1 (no-floor)
  // ranked list so the bucket is a property of the query, not of the threshold.
  const top = perThreshold[0.0][0]?.sim ?? perThreshold[0.5][0]?.sim ?? null;
  const bucket = top != null && top >= 0.5 ? "dominant" : "weak";
  for (const t of THRESHOLDS) {
    const res = perThreshold[t];
    const rank1 = res[0]?.id === want;
    const nonTarget = res.filter((r) => r.id !== want).length;
    bump(`${t}|${bucket}`, rank1, res.length, nonTarget);
    bump(`${t}|ALL`, rank1, res.length, nonTarget);
  }
  const r1a = perThreshold[0.5][0]?.id, r1b = perThreshold[0.0][0]?.id;
  if (r1a !== r1b) rank1Changed++;
  if ((i + 1) % 100 === 0) process.stdout.write(`\r  ${i + 1}/${queries.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
process.stdout.write("\n\n");

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "—");
console.log(`## Decoy / precision on the short Linear corpus (${queries.length} title→body queries, ${EMBED_MODEL})\n`);
console.log(`threshold 0.5 reproduces the OLD absolute floor exactly (sim>0.5 ⟹ sim>=0.5*top); threshold 0 is the shipped relative cutoff (027).\n`);
console.log(`| threshold | bucket | n | rank-1 correct | mean rows | mean non-target rows |`);
console.log(`| --- | --- | --- | --- | --- | --- |`);
for (const bucket of ["dominant", "weak", "ALL"]) {
  for (const t of THRESHOLDS) {
    const c = table.get(`${t}|${bucket}`);
    if (!c || !c.n) continue;
    const label = t === 0.5 ? "0.5 (old floor)" : "0 (relative)";
    console.log(`| ${label} | ${bucket} | ${c.n} | ${pct(c.rank1, c.n)} | ${(c.rows / c.n).toFixed(2)} | ${(c.nonTarget / c.n).toFixed(2)} |`);
  }
}
console.log(`\nrank-1 doc changed between 0.5 and 0 on ${rank1Changed} of ${queries.length} queries (the floor must not reorder).`);
console.log(`"dominant" = top raw cosine >= 0.5 (the short-thought case the relative cutoff loosens most); "weak" = top < 0.5.`);

await sql.end();
