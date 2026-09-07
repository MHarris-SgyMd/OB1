#!/usr/bin/env bun
/**
 * eval-hybrid.ts — does fusing the two retrievers beat the better of them?
 *
 * SMD-958 fuses `match_thoughts` and `search_thoughts_keyword` behind the tools
 * the product exposes (migration 017, `search_thoughts_hybrid`). The ticket's
 * first rule is that the eval exists before the ranker is tuned, because the
 * eval this fork already has cannot judge a blend: eval-keyword.ts's queries are
 * hapax by construction, so any fusion that contains the keyword arm scores
 * ~100% on it, good blend or bad. This harness builds four query sets from the
 * same 441-issue corpus, each mechanically and each stated, and asks every arm
 * the same questions:
 *
 *   identifier  eval-keyword.ts's set exactly: identifier-shaped tokens unique to
 *               one document by substring, the token alone as the query. The
 *               keyword arm scores 1.0 here by construction, and the bar for the
 *               fusion is to match it — an identifier query must not be diluted.
 *   semantic    eval-real.ts's task exactly: the issue title is the query, the
 *               body is the document. The vector arm's MRR here is the 0.903 in
 *               evals/README.md, re-measured on this load; the bar is that the
 *               fusion does not fall below it. Titles sometimes carry an
 *               identifier, so this set also shows what the needle rule does to
 *               ordinary queries.
 *   mixed       where each arm alone is wrong. Documents the vector arm misses at
 *               rank 1 on their title, plus an identifier from the body that is
 *               in 2–30 documents and absent from the document vector wrongly
 *               ranked first. Query = title + token. Vector alone is wrong by
 *               selection; keyword alone returns 2–30 documents in an order that
 *               is not relevance. The fusion should place the target first.
 *   decoy       a strong semantic match with a wrong identifier appended:
 *               documents the vector arm gets right at rank 1 on their title,
 *               plus a token unique to a DIFFERENT document. Keyword alone is
 *               wrong by construction. The fusion should keep the target first —
 *               this is the set that punishes trusting a literal blindly.
 *
 * Arms: vector (`match_thoughts`, as the tools call it), keyword (the needles
 * `extract_search_needles` finds, each through `search_thoughts_keyword`, in
 * needle order), hybrid as shipped, and six variants computed in TypeScript from
 * the raw arm outputs — the gate off, needles-first tiebreak, plain RRF over
 * both lists (the fusion the ticket names as the one not to inherit), the wider
 * vector window the first draft used, rarity-weighted presence, and the two
 * together. Two settings: as shipped (10 results, threshold 0.5 — what `search`
 * and `search_thoughts` send) and unbounded (100, −1), which is comparable to
 * the two existing baselines.
 *
 * THE CONTROL. On every query the shipped function's order must equal the
 * TypeScript fusion under the shipped rule; on every identifier query the
 * keyword arm must return exactly one row. Either failing means the harness and
 * the function disagree about what the rule is, and no table is printed.
 *
 * The corpus is internal engineering data: read from /tmp, loaded into a
 * throwaway loopback Postgres, embedded by a local model. Document vectors are
 * cached in /tmp keyed by text hash.
 *
 *   OB1_EVAL_CORPUS=/tmp/linear-corpus-full.json ../db/with-postgres.sh bun eval-hybrid.ts
 *   OB1_EVAL_EMBED=qwen3-embedding:4b@1024   the embedding spec, as the other harnesses take it
 *   OB1_EVAL_MAX_QUERIES=50                  cap the semantic, mixed and decoy sets (0 = all)
 *   OB1_EVAL_MAX_IDENTIFIER=60               cap the identifier set (eval-keyword's default)
 */

import { SQL } from "bun";
import { loadEnv } from "./env.ts";
import { embed, parseSpec } from "./lib.ts";
import { loadLinearCorpus, insertLinearThought, linearThoughtId, linearVectorCachePath, cachedDocumentVectors, type LinearDoc } from "./linear-corpus.ts";
import { selectIdentifierQueries, documentFrequency, substringContainers, shapeOf, strideSample } from "./identifiers.ts";
import { requireDatabaseUrl, resetSchema } from "../db/test-support.ts";

loadEnv();
const URL_ = requireDatabaseUrl("eval-hybrid.ts");
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? Number(process.env.OB1_EMBEDDING_DIM || 1024);
const MAX = Number(process.env.OB1_EVAL_MAX_QUERIES ?? 0);
const MAX_ID = Number(process.env.OB1_EVAL_MAX_IDENTIFIER ?? 60);
/** RRF's constant, as the migration has it. */
const K = 60;
/** The over-fetch the first version of the migration used, kept as a variant: least(100, greatest(4N, 40)). */
const wideWindow = (n: number) => Math.min(100, Math.max(4 * n, 40));

type Setting = { name: string; n: number; threshold: number };
const SETTINGS: Setting[] = [
  { name: "as shipped — 10 results, threshold 0.5, what search and search_thoughts send", n: 10, threshold: 0.5 },
  { name: "unbounded — 100 results, threshold −1, comparable to eval-real and eval-keyword", n: 100, threshold: -1 },
];

const lit = (v: number[]) => `[${v.join(",")}]`;

// ── Load: bodies as thoughts, with real vectors ──────────────────────────────

const { path: corpusPath, docs } = loadLinearCorpus();
const body = (d: LinearDoc) => d.text;
console.log(`  corpus: ${docs.length} documents from ${corpusPath}; embed ${EMBED_MODEL} @ ${DIM}`);

/** The corpus size the rarity weight is relative to; read after the load. */
let THOUGHTS = 0;
const t0 = Date.now();
const { vectors, embedded } = await cachedDocumentVectors(docs, {
  path: linearVectorCachePath(EMBED_MODEL, "body"), dim: DIM, text: body, embed: (t) => embed(EMBED_MODEL, t),
});
await resetSchema(URL_, { dim: DIM, model: spec.name });
const sql = new SQL({ url: URL_, max: 4 });
for (const d of docs) await insertLinearThought(sql, d, lit(vectors[d.id]), body(d));
await sql.unsafe("VACUUM ANALYZE thoughts");
const loaded = new Set<string>((await sql`SELECT metadata->>'issue' AS issue FROM thoughts`).map((r: { issue: string }) => r.issue));
console.log(`  loaded ${loaded.size} thoughts (${embedded} embedded now, ${docs.length - embedded} from cache) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
THOUGHTS = loaded.size;
const collapsed = docs.filter((d) => !loaded.has(d.id)).map((d) => d.id);
if (collapsed.length) console.log(`  ! ${collapsed.length} documents collapsed onto an earlier one by content fingerprint and are unreachable: ${collapsed.join(", ")}`);
const byId = new Map(docs.map((d) => [d.id, d]));
const idOf = new Map<string, string>(); // thought uuid → issue id
for (const d of docs) idOf.set(linearThoughtId(d.id), d.id);

// ── The raw arms, per query ─────────────────────────────────────────────────

type Raw = {
  needles: string[];                 // used by the function
  common: string[];                  // extracted, in > 100 thoughts, not used
  literalOnly: boolean;
  hits: Map<string, string[]>;       // issue id → needles it contains
  df: Map<string, number>;           // used needle → thoughts containing it (the function's total_count)
  kwOrder: string[][];               // per used needle, the keyword function's own order
  sims: Map<string, number>;         // every candidate's similarity
  vec: Record<number, { id: string; sim: number }[]>; // per F, match_thoughts(qv, −1, F)
  shipped: Record<string, string[]>; // per setting name, search_thoughts_hybrid's order
};

const qcache = new Map<string, number[]>();
async function queryVector(q: string): Promise<number[]> {
  let v = qcache.get(q);
  if (!v) { v = await embed(EMBED_MODEL, q, true); qcache.set(q, v); }
  return v;
}

async function raw(q: string): Promise<Raw> {
  const qv = lit(await queryVector(q));

  // The shipped function first, and the query-level facts — which needles were
  // used, which were common, whether the query was literal-only — come from
  // its rows rather than from a TypeScript re-implementation of the needle
  // rule and the gate. Two copies of those drifted once (the gate's case
  // handling, the common rule's constant) without the control noticing,
  // because no query in the four sets exercised the difference (review pass).
  // At threshold −1 the function returns a row whenever the corpus has one.
  const shipped: Raw["shipped"] = {};
  let facts: { needles: string[]; common_needles: string[]; literal_only: boolean } | undefined;
  for (const s of SETTINGS) {
    const rows = await sql`SELECT id, needles, common_needles, literal_only FROM search_thoughts_hybrid(${qv}::vector, ${q}, ${s.threshold}, ${s.n}, '{}'::jsonb)`;
    shipped[s.name] = rows.map((r: { id: string }) => idOf.get(r.id)!);
    if (rows.length && s.threshold < 0) facts = rows[0];
  }
  if (!facts) throw new Error(`search_thoughts_hybrid returned no row at threshold −1 for ${JSON.stringify(q)}; is the corpus loaded?`);
  const needles = facts.needles as string[];
  const common = facts.common_needles as string[];
  const literalOnly = facts.literal_only === true;

  const hits = new Map<string, string[]>();
  const df = new Map<string, number>();
  const kwOrder: string[][] = [];
  for (const nd of needles) {
    const rows = await sql`SELECT id, total_count FROM search_thoughts_keyword(${nd}, 100, 0, '{}'::jsonb)`;
    df.set(nd, rows.length ? Number(rows[0].total_count) : 0);
    const order: string[] = [];
    for (const r of rows as { id: string }[]) {
      const issue = idOf.get(r.id)!;
      order.push(issue);
      hits.set(issue, [...(hits.get(issue) ?? []), nd]);
    }
    kwOrder.push(order);
  }

  const vec: Raw["vec"] = {};
  const sims = new Map<string, number>();
  for (const F of new Set(SETTINGS.flatMap((s) => [wideWindow(s.n), s.n]))) {
    const rows = await sql`SELECT id, similarity FROM match_thoughts(${qv}::vector, -1.0, ${F}, '{}'::jsonb)`;
    vec[F] = rows.map((r: { id: string; similarity: number }) => ({ id: idOf.get(r.id)!, sim: Number(r.similarity) }));
    for (const r of vec[F]) sims.set(r.id, r.sim);
  }
  const missing = [...hits.keys()].filter((id) => !sims.has(id)).map((id) => linearThoughtId(id));
  if (missing.length) {
    // A Postgres array literal, not a bound JS array: Bun binds a one-element
    // array as its bare element, which uuid[] refuses.
    // The thought's own vector only: this load has no chunk rows, so the
    // function's best-of-vector-and-chunks probe reduces to this.
    const rows = await sql`SELECT id, 1 - (embedding <=> ${qv}::vector) AS sim FROM thoughts WHERE id = ANY(${`{${missing.join(",")}}`}::uuid[])`;
    for (const r of rows as { id: string; sim: number }[]) sims.set(idOf.get(r.id)!, Number(r.sim));
  }
  return { needles, common, literalOnly, hits, df, kwOrder, sims, vec, shipped };
}

// ── The fusions, in TypeScript, from the raw arms ───────────────────────────

/**
 * The shipped rule and the variants measured against it.
 *
 * `window`: how deep the vector arm's rank counts. `n` is the migration's rule —
 * the N rows match_thoughts would itself have returned for this call. `wide` is
 * the over-fetch the first draft used, least(100, greatest(4N, 40)); it promoted
 * decoys and is kept so the difference stays measured.
 * `idf`: presence weighted by the needle's rarity, ln(T/df)/ln(T) over T
 * thoughts. Measured neutral on its own and worth one query in 441 with the
 * narrow window; not shipped, kept as the record of that.
 * `gate`, `needleFirst`, `rrfKeyword`: the header's three alternatives.
 */
type Variant = { gate: boolean; needleFirst: boolean; rrfKeyword: boolean; window: "wide" | "n"; idf: boolean };
const SHIPPED_RULE: Variant = { gate: true, needleFirst: false, rrfKeyword: false, window: "n", idf: false };
const VARIANTS: { key: string; label: string; v: Variant }[] = [
  { key: "hybrid", label: "hybrid (shipped)", v: SHIPPED_RULE },
  { key: "nogate", label: "  variant: no gate", v: { ...SHIPPED_RULE, gate: false } },
  { key: "needlefirst", label: "  variant: needles-first tiebreak", v: { ...SHIPPED_RULE, needleFirst: true } },
  { key: "rrf", label: "  variant: plain RRF over both lists", v: { ...SHIPPED_RULE, gate: false, rrfKeyword: true } },
  { key: "wide", label: "  variant: window F = 4N, at least 40", v: { ...SHIPPED_RULE, window: "wide" } },
  { key: "idf", label: "  variant: rarity-weighted presence", v: { ...SHIPPED_RULE, idf: true } },
  { key: "wideidf", label: "  variant: wide window and rarity-weighted", v: { ...SHIPPED_RULE, window: "wide", idf: true } },
];

function fuse(r: Raw, v: Variant, s: Setting): string[] {
  const score = new Map<string, number>();
  const wv = v.gate && r.literalOnly ? 0 : 1;
  r.vec[v.window === "n" ? s.n : wideWindow(s.n)].forEach((x, i) => score.set(x.id, wv / (K + i + 1)));
  if (v.rrfKeyword) {
    for (const list of r.kwOrder) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (K + i + 1)));
  } else {
    const weight = (nd: string) => (v.idf ? Math.log(THOUGHTS / (r.df.get(nd) ?? 1)) / Math.log(THOUGHTS) : 1);
    for (const [id, m] of r.hits) score.set(id, (score.get(id) ?? 0) + m.reduce((a, nd) => a + weight(nd), 0) / (K + 1));
  }
  const rows = [...score.keys()].filter((id) => r.hits.has(id) || (r.sims.get(id) ?? -Infinity) > s.threshold);
  rows.sort((a, b) => {
    const ds = score.get(b)! - score.get(a)!;
    if (Math.abs(ds) > 1e-12) return ds;
    if (v.needleFirst) {
      const dn = (r.hits.get(b)?.length ?? 0) - (r.hits.get(a)?.length ?? 0);
      if (dn) return dn;
    }
    const sa = r.sims.get(a) ?? -Infinity, sb = r.sims.get(b) ?? -Infinity;
    if (sb !== sa) return sb - sa;
    return linearThoughtId(a) < linearThoughtId(b) ? -1 : 1; // the migration's last key is the row id
  });
  return rows.slice(0, s.n);
}

/** The vector arm as the tools call it: top n above the threshold, in order. */
const vectorArm = (r: Raw, s: Setting) => r.vec[s.n].filter((x) => x.sim > s.threshold).map((x) => x.id);
/** The keyword arm alone: each used needle's page in needle order, first sighting wins. */
const keywordArm = (r: Raw, s: Setting) => { const seen = new Set<string>(); const out: string[] = []; for (const list of r.kwOrder) for (const id of list) if (!seen.has(id)) { seen.add(id); out.push(id); } return out.slice(0, s.n); };

// ── The four sets ───────────────────────────────────────────────────────────

type Query = { set: string; q: string; want: string; note?: string };
const cap = strideSample;

const bodies = docs.filter((d) => loaded.has(d.id)).map((d) => ({ id: d.id, text: body(d) }));
const identifierQueries = selectIdentifierQueries(bodies, { max: MAX_ID });
const identifier: Query[] = identifierQueries.map((c) => ({ set: "identifier", q: c.token, want: c.want, note: c.shape }));
const semantic: Query[] = cap(docs.filter((d) => loaded.has(d.id) && d.title.trim()).map((d) => ({ set: "semantic", q: d.title, want: d.id })), MAX);

console.log(`  sets:   identifier ${identifier.length} (eval-keyword's rule; ${MAX_ID ? `capped at ${MAX_ID}` : "all"}), semantic ${semantic.length} (title → body${MAX ? `, capped at ${MAX}` : ""})`);
process.stdout.write("  … identifier and semantic arms");
const results = new Map<Query, Raw>();
for (const list of [identifier, semantic]) for (const q of list) results.set(q, await raw(q.q));

// The mixed and decoy sets depend on which titles the vector arm gets right, so
// they are built from the semantic results at the unbounded setting.
const unbounded = SETTINGS[1];
const vectorRank1 = (r: Raw, want: string) => vectorArm(r, unbounded)[0] === want;
const df = documentFrequency(bodies);
const containers = substringContainers(bodies);
const mixed: Query[] = [];
for (const q of semantic) {
  const r = results.get(q)!;
  if (vectorRank1(r, q.want)) continue;
  const wrong = vectorArm(r, unbounded)[0];
  const wrongText = wrong ? body(byId.get(wrong)!).toLowerCase() : "";
  const title = byId.get(q.want)!.title.toLowerCase();
  const candidates = [...df.keys()]
    .filter((t) => df.get(t)!.has(q.want) && shapeOf(t) !== "word" && !title.includes(t.toLowerCase()) && !wrongText.includes(t.toLowerCase()))
    .filter((t) => { const n = containers(t).length; return n >= 2 && n <= 30; })
    .sort();
  // The appended token must be one the PRODUCT's rule extracts from the whole
  // query, or the "mixed" query would be served semantic-only and counted as a
  // fusion result (review pass). The TS shape rule is only the first pass.
  let chosen: string | undefined;
  for (const t of candidates) {
    const [{ n }] = await sql`SELECT extract_search_needles(${`${q.q} ${t}`}) AS n`;
    if ((n as string[]).some((x) => x.toLowerCase() === t.toLowerCase())) { chosen = t; break; }
  }
  if (!chosen) continue;
  mixed.push({ set: "mixed", q: `${q.q} ${chosen}`, want: q.want, note: `${chosen} in ${containers(chosen).length} docs; vector's top-1 was ${wrong}` });
}
const decoy: Query[] = [];
// A corpus with no identifier-shaped hapax has nothing to append; eval-keyword
// exits in that case, and this set is simply empty (the report says so).
if (identifierQueries.length) {
  const right = semantic.filter((q) => vectorRank1(results.get(q)!, q.want));
  const sample = cap(right, identifierQueries.length || 60);
  sample.forEach((q, i) => {
    let j = i % identifierQueries.length, tries = 0;
    while (identifierQueries[j].want === q.want && tries++ < identifierQueries.length) j = (j + 1) % identifierQueries.length;
    const tok = identifierQueries[j];
    if (tok.want === q.want) return;
    decoy.push({ set: "decoy", q: `${q.q} ${tok.token}`, want: q.want, note: `${tok.token} is unique to ${tok.want}` });
  });
}
process.stdout.write(`\r  sets:   mixed ${mixed.length} (vector misses at rank 1 with a shared identifier appended), decoy ${decoy.length} (vector hits at rank 1 with another document's unique identifier appended)\n`);
process.stdout.write("  … mixed and decoy arms");
for (const list of [mixed, decoy]) for (const q of list) results.set(q, await raw(q.q));
process.stdout.write("\r                          \r");

// ── Controls ────────────────────────────────────────────────────────────────

const disagreements: string[] = [];
for (const [q, r] of results) {
  for (const s of SETTINGS) {
    const ts = fuse(r, SHIPPED_RULE, s);
    const got = r.shipped[s.name];
    if (ts.length !== got.length || ts.some((id, i) => id !== got[i])) disagreements.push(`${q.set} "${q.q.slice(0, 50)}" [${s.n}/${s.threshold}]: function ${got.slice(0, 5).join(",")}… harness ${ts.slice(0, 5).join(",")}…`);
  }
}
// An identifier the tokenizer chose but the product's rule does not extract is
// not a control failure — it is scored as the product would serve it, and
// reported below — so it is set aside before the hapax control looks.
const notExtracted = identifier.filter((q) => results.get(q)!.needles.length === 0 && results.get(q)!.common.length === 0);
const notHapax = identifier.filter((q) => { const r = results.get(q)!; return !notExtracted.includes(q) && (r.kwOrder.length !== 1 || r.kwOrder[0].length !== 1 || r.kwOrder[0][0] !== q.want); });
if (disagreements.length || notHapax.length) {
  if (disagreements.length) console.error(`\n  ${disagreements.length} of ${results.size * SETTINGS.length} calls: the shipped function and the harness's fusion disagree — no table is printed until they say the same thing:\n    ${disagreements.slice(0, 6).join("\n    ")}`);
  if (notHapax.length) console.error(`\n  ${notHapax.length} identifier queries are hapax by the tokenizer but not by the SQL function:\n    ${notHapax.slice(0, 5).map((q) => `"${q.q}" → ${JSON.stringify(results.get(q)!.kwOrder)}`).join("\n    ")}`);
  await sql.close();
  process.exit(1);
}

// ── Report ──────────────────────────────────────────────────────────────────

const rankOf = (list: string[], want: string) => { const i = list.indexOf(want); return i < 0 ? Infinity : i + 1; };
type Arm = { key: string; label: string; order: (r: Raw, s: Setting) => string[] };
const ARMS: Arm[] = [
  { key: "vector", label: "vector (match_thoughts)", order: vectorArm },
  { key: "keyword", label: "keyword (the needles, in order)", order: keywordArm },
  ...VARIANTS.map((v) => ({ key: v.key, label: v.label, order: (r: Raw, s: Setting) => (v.v === SHIPPED_RULE ? r.shipped[s.name] : fuse(r, v.v, s)) })),
];
function stats(qs: Query[], arm: Arm, s: Setting) {
  const ranks = qs.map((q) => rankOf(arm.order(results.get(q)!, s), q.want));
  const n = ranks.length || 1;
  return {
    r1: ranks.filter((r) => r === 1).length / n,
    r5: ranks.filter((r) => r <= 5).length / n,
    miss: ranks.filter((r) => r > 10).length,
    mrr: ranks.reduce((a, r) => a + (r === Infinity ? 0 : 1 / r), 0) / n,
  };
}

const sets: [string, Query[]][] = [["identifier", identifier], ["semantic", semantic], ["mixed", mixed], ["decoy", decoy]];
console.log(`\n  ${results.size} queries in four sets; the control passed on every one (function order = harness order at both settings, with the needles, the common rule and the gate read from the function; every identifier query is hapax to the SQL function).`);
if (notExtracted.length) console.log(`  ! ${notExtracted.length} identifier queries yield no needle under the product's rule (extract_search_needles) and are scored as the product would serve them: ${notExtracted.slice(0, 6).map((q) => `"${q.q}"`).join(", ")}${notExtracted.length > 6 ? "…" : ""}`);
const withNeedle = semantic.filter((q) => results.get(q)!.needles.length).length;
const withCommon = [...results.values()].filter((r) => r.common.length).length;
console.log(`  ${withNeedle} of ${semantic.length} semantic queries carry a needle under the product's rule; ${withCommon} queries had a needle dropped as common (> 100 thoughts).`);

for (const s of SETTINGS) {
  console.log(`\n  ${s.name}\n`);
  console.log("  set          n   arm                                        R@1     R@5   not in top-10   MRR");
  console.log("  ──────────  ───  ─────────────────────────────────────────  ─────  ─────  ─────────────  ─────");
  for (const [name, qs] of sets) {
    if (!qs.length) { console.log(`  ${name.padEnd(10)}   0  (no queries)`); continue; }
    ARMS.forEach((arm, i) => {
      const st = stats(qs, arm, s);
      console.log(
        `  ${(i === 0 ? name : "").padEnd(10)}  ${String(i === 0 ? qs.length : "").padStart(3)}  ${arm.label.padEnd(41)}  ` +
        `${(st.r1 * 100).toFixed(0).padStart(4)}%  ${(st.r5 * 100).toFixed(0).padStart(4)}%  ${`${st.miss}/${qs.length}`.padStart(13)}  ${st.mrr.toFixed(3)}`);
    });
    console.log("");
  }
}

// Where the fusion lost to the better arm, at the shipped setting.
const shippedSetting = SETTINGS[0];
console.log(`  Where hybrid (shipped) ranks the answer below the better single arm, at ${shippedSetting.n}/${shippedSetting.threshold}:\n`);
let losses = 0;
for (const [name, qs] of sets) {
  for (const q of qs) {
    const r = results.get(q)!;
    const h = rankOf(r.shipped[shippedSetting.name], q.want);
    const best = Math.min(rankOf(vectorArm(r, shippedSetting), q.want), rankOf(keywordArm(r, shippedSetting), q.want));
    if (h > best) {
      losses++;
      if (losses <= 25) console.log(`    ${name.padEnd(10)} "${q.q.slice(0, 60)}" → ${q.want}: hybrid ${h === Infinity ? "—" : h}, vector ${rankOf(vectorArm(r, shippedSetting), q.want) === Infinity ? "—" : rankOf(vectorArm(r, shippedSetting), q.want)}, keyword ${rankOf(keywordArm(r, shippedSetting), q.want) === Infinity ? "—" : rankOf(keywordArm(r, shippedSetting), q.want)}; needles ${JSON.stringify(r.needles)}${r.literalOnly ? " literal-only" : ""}${q.note ? ` (${q.note})` : ""}`);
    }
  }
}
console.log(losses ? `\n  ${losses} of ${results.size} queries.` : "    none.");

// Where the fusion WON — the mixed set's reason to exist — at the shipped setting.
console.log(`\n  Where hybrid (shipped) ranks the answer above both single arms, at ${shippedSetting.n}/${shippedSetting.threshold}:`);
let wins = 0;
for (const [name, qs] of sets) for (const q of qs) {
  const r = results.get(q)!;
  const h = rankOf(r.shipped[shippedSetting.name], q.want);
  const best = Math.min(rankOf(vectorArm(r, shippedSetting), q.want), rankOf(keywordArm(r, shippedSetting), q.want));
  if (h < best) { wins++; if (wins <= 12) console.log(`    ${name.padEnd(10)} "${q.q.slice(0, 60)}" → ${q.want}: hybrid ${h}, vector ${rankOf(vectorArm(r, shippedSetting), q.want) === Infinity ? "—" : rankOf(vectorArm(r, shippedSetting), q.want)}, keyword ${rankOf(keywordArm(r, shippedSetting), q.want) === Infinity ? "—" : rankOf(keywordArm(r, shippedSetting), q.want)}`); }
}
console.log(wins ? `  ${wins} of ${results.size} queries.\n` : "    none.\n");

await sql.close();
