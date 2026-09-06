#!/usr/bin/env bun
/**
 * eval-graphrag.ts — is retrieval over the entity graph worth building?
 *
 * SMD-948 asks for a spike with a decision at the end, and its first rule is
 * that the question set exists before the graph is judged. The questions are
 * `graphrag-questions.json`: twenty-seven asked over the 441-issue Linear
 * corpus, each answered by two or more documents — multi-hop (combine specific
 * documents), aggregation (every document of one kind), corpus-level (the shape
 * of the corpus). The metric is retrieval: did the expected documents come back
 * in the top ten. Any answering step has to work from what was retrieved, and a
 * generated answer over the wrong documents is a confident fabrication.
 *
 * Five arms, all over the same throwaway Postgres holding the corpus with real
 * embeddings and the entity graph SMD-947 extracted:
 *
 *   vector   `match_thoughts` — the baseline the product ships today.
 *   graph    "local" GraphRAG: entities named in the question are matched to
 *            ob1_entities, expanded one hop over ob1_entity_edges, and the
 *            thoughts mentioning them are ranked by how many seed entities they
 *            touch, vector similarity breaking ties.
 *   hybrid   reciprocal-rank fusion of the two lists above.
 *   global   "global" GraphRAG: entities are clustered into communities (label
 *            propagation over co-mention weights), each community gets a
 *            generated summary, the question is matched to summaries, and the
 *            thoughts of the best communities are ranked by vector similarity.
 *            The construction cost — calls, wall clock — is measured, since it
 *            is the standing cost the ticket warns about.
 *   keyword  `search_thoughts_keyword` (SMD-944) with the needle a person would
 *            type — only the aggregation and corpus questions carry one. It is
 *            here because "every issue of this kind" is the question a graph is
 *            supposed to answer, and the tool the product already ships should
 *            be beaten before a graph is built for it.
 *
 * The entity graph is REPLAYED from the answers `eval-entities.ts --corpus`
 * dumped, not re-extracted: that is the two-hour pass this spike does not need
 * to repeat, and the replay reproduces its graph exactly. Document vectors are
 * cached in /tmp for the same reason.
 *
 *   OB1_EVAL_CORPUS=/tmp/linear-corpus-full.json ../db/with-postgres.sh bun eval-graphrag.ts
 *   … --no-global        skip the community summaries (the only slow, LLM-heavy arm)
 *   … --k 10             documents retrieved per question (default 10)
 */

import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { embed, cosine } from "./lib.ts";
import { resolveEmbedConfig } from "../server-portable/embed.ts";
import { extractEntities, extractionKey } from "../server-portable/entities.ts";
import { requireDatabaseUrl, resetSchema } from "../db/test-support.ts";

loadEnv();
const URL_ = requireDatabaseUrl("eval-graphrag.ts");
const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && !args[i + 1]?.startsWith("--") ? args[i + 1] : undefined; };
if (!process.env.OB1_LLM_BASE_URL && process.env.OB1_EVAL_BASE) process.env.OB1_LLM_BASE_URL = process.env.OB1_EVAL_BASE;

const K = Number(flag("k") ?? 10);
const GLOBAL = !has("no-global");
const EMBED_MODEL = process.env.OB1_EMBEDDING_MODEL ?? "qwen3-embedding:4b@1024";
const DIM = Number(process.env.OB1_EMBEDDING_DIM ?? 1024);
const cfg = resolveEmbedConfig(process.env);
const corpusPath = process.env.OB1_EVAL_CORPUS ?? "/tmp/linear-corpus-full.json";
const answersPath = process.env.OB1_EVAL_ANSWERS ?? `/tmp/entity-answers-${cfg.metadataModel.replace(/[^A-Za-z0-9.-]+/g, "_")}.jsonl`;
const vectorCache = `/tmp/graphrag-vectors-${EMBED_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;

type Doc = { id: string; title: string; text: string };
type Question = { id: string; type: "multi-hop" | "aggregation" | "corpus"; question: string; expected: string[]; keyword?: string };
const docs = (JSON.parse(readFileSync(corpusPath, "utf8")) as Doc[]).filter((d) => (d.text ?? "").trim().length > 0);
const questions = (JSON.parse(readFileSync(new URL("./graphrag-questions.json", import.meta.url).pathname, "utf8")) as { questions: Question[] }).questions;
if (!existsSync(answersPath)) {
  console.error(`No entity answers at ${answersPath}. Run eval-entities.ts --corpus first (about two hours); this spike replays its graph.`);
  process.exit(2);
}
const idOf = (id: string) => Bun.hash.crc32(id).toString(16).padStart(8, "0") + "-0000-4000-8000-" + Bun.hash.xxHash64(id).toString(16).padStart(16, "0").slice(0, 12);
const lit = (v: number[]) => `[${v.join(",")}]`;

console.log(`  corpus: ${docs.length} documents; ${questions.length} questions; k = ${K}`);
console.log(`  embed:  ${EMBED_MODEL} @ ${DIM}; graph from ${answersPath}; summaries by ${cfg.metadataModel}\n`);

// ── Load: thoughts with vectors, then the graph ──────────────────────────────

await resetSchema(URL_, { dim: DIM, model: EMBED_MODEL.split("@")[0] });
const sql = new SQL({ url: URL_, max: 4 });

let vectors: Record<string, number[]> = {};
if (existsSync(vectorCache)) vectors = JSON.parse(readFileSync(vectorCache, "utf8"));
let embedded = 0;
const t0 = Date.now();
for (const d of docs) {
  const text = `${d.title}\n\n${d.text}`;
  if (!vectors[d.id]) { vectors[d.id] = await embed(EMBED_MODEL, text); embedded++; }
  await sql`INSERT INTO thoughts (id, content, metadata, content_fingerprint, embedding)
            VALUES (${idOf(d.id)}::uuid, ${text}, ${{ source: "linear", issue: d.id }}::jsonb,
                    encode(sha256(convert_to(lower(trim(regexp_replace(${text}, '\s+', ' ', 'g'))), 'UTF8')), 'hex'), ${lit(vectors[d.id])}::vector)
            ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING`;
}
if (embedded) writeFileSync(vectorCache, JSON.stringify(vectors));
const [{ loaded }] = await sql`SELECT count(*)::int AS loaded FROM thoughts`;
console.log(`  loaded ${loaded} thoughts (${embedded} embedded now, ${docs.length - embedded} from cache) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const key = extractionKey(cfg.metadataModel);
let replayed = 0;
for (const line of readFileSync(answersPath, "utf8").split("\n").filter(Boolean)) {
  const a = JSON.parse(line) as { id: string; entities: unknown[]; relations: unknown[] };
  const [{ r }] = await sql`SELECT record_thought_entities(${a.id}::uuid, ${key}, ${a.entities}::jsonb, ${a.relations}::jsonb) AS r`;
  if ((r as { ok: boolean }).ok) replayed++;
}
await sql.unsafe("VACUUM ANALYZE thoughts"); await sql.unsafe("ANALYZE ob1_entities"); await sql.unsafe("ANALYZE thought_entities"); await sql.unsafe("ANALYZE ob1_entity_edges");
const [g] = await sql`SELECT (SELECT count(*)::int FROM ob1_entities) AS entities, (SELECT count(*)::int FROM thought_entities) AS mentions, (SELECT count(*)::int FROM ob1_entity_edges) AS edges`;
console.log(`  graph:  ${replayed} thoughts' extractions replayed → ${g.entities} entities, ${g.mentions} mentions, ${g.edges} edges\n`);

const issueOf = new Map<string, string>((await sql`SELECT id, metadata->>'issue' AS issue FROM thoughts`).map((r: { id: string; issue: string }) => [r.id, r.issue]));

// ── The arms ────────────────────────────────────────────────────────────────

type Ranked = string[]; // issue ids, best first

async function vectorArm(qv: number[]): Promise<Ranked> {
  const rows = await sql`SELECT metadata->>'issue' AS issue FROM match_thoughts(${lit(qv)}::vector, -1.0, ${Math.max(K, 20)}, '{}'::jsonb)`;
  return rows.map((r: { issue: string }) => r.issue);
}

/**
 * The keyword tool the product already ships (migration 012, SMD-944), given
 * the needle a person would type for the question. Only aggregation and
 * corpus questions have one; it is the arm to beat for "every issue of this
 * kind", since those issues tend to share a literal string — a title prefix,
 * an error class — that no vector or graph needs to infer.
 */
async function keywordArm(needle: string | undefined): Promise<Ranked | null> {
  if (!needle) return null;
  const rows = await sql`SELECT metadata->>'issue' AS issue FROM search_thoughts_keyword(${needle}, ${Math.max(K, 20)}, 0, '{}'::jsonb)`;
  return rows.map((r: { issue: string }) => r.issue);
}

/**
 * Seed entities for a question: the names the extraction model finds in it,
 * matched to ob1_entities by the resolution rule and, failing that, by trigram
 * similarity; plus any entity whose name appears verbatim in the question,
 * which catches the proper nouns a 7B model sometimes types as topics.
 */
async function seedEntities(question: string): Promise<{ ids: string[]; names: string[] }> {
  const ex = await extractEntities(question, cfg, AbortSignal.timeout(120_000)).catch(() => null);
  const names = ex && !ex.malformed ? ex.entities.map((e) => e.name) : [];
  const ids = new Set<string>();
  const matched: string[] = [];
  for (const n of names) {
    const rows = (await sql`
      SELECT id, name FROM ob1_entities
      WHERE normalized_name = normalize_entity_name(${n}) OR normalize_entity_name(${n}) = ANY(merged_from)
      UNION ALL
      (SELECT id, name FROM ob1_entities WHERE similarity(normalized_name, normalize_entity_name(${n})) >= 0.55 ORDER BY similarity(normalized_name, normalize_entity_name(${n})) DESC LIMIT 2)`) as { id: string; name: string }[];
    for (const r of rows) { if (!ids.has(r.id)) { ids.add(r.id); matched.push(r.name); } }
  }
  const verbatim = (await sql`
    SELECT id, name FROM ob1_entities
    WHERE length(name) >= 4 AND position(lower(name) IN lower(${question})) > 0`) as { id: string; name: string }[];
  for (const r of verbatim) { if (!ids.has(r.id)) { ids.add(r.id); matched.push(r.name); } }
  return { ids: [...ids], names: matched };
}

/**
 * Seeds are weighted by rarity — log(N / documents mentioning the entity) — and
 * an entity mentioned by more than a tenth of the corpus ("backend", "client",
 * "intake", "Healthie") is no seed at all: it says nothing about which
 * documents the question wants. The first draft weighted every seed 1.0 and
 * lost to vector on 18 of 27 questions; this is the fairest version of the
 * local walk the author could build, and the numbers reported are its.
 */
async function graphArm(seeds: string[], qv: number[]): Promise<Ranked> {
  if (seeds.length === 0) return [];
  const rows = await sql`
    WITH n AS (SELECT count(*)::float AS total FROM thoughts),
    df AS (SELECT entity_id, count(DISTINCT thought_id)::float AS docs FROM thought_entities GROUP BY entity_id),
    seeds AS (
      SELECT s.id, ln(n.total / df.docs) AS w
      FROM unnest(${sql.array(seeds, "TEXT")}::uuid[]) AS s(id) JOIN df ON df.entity_id = s.id CROSS JOIN n
      WHERE df.docs <= n.total * 0.1
    ),
    neigh AS (
      SELECT CASE WHEN g.from_entity_id = s.id THEN g.to_entity_id ELSE g.from_entity_id END AS id, max(s.w) * 0.3 AS w
      FROM ob1_entity_edges g JOIN seeds s ON s.id IN (g.from_entity_id, g.to_entity_id)
      GROUP BY 1
    ),
    weights AS (
      SELECT id, w FROM seeds
      UNION ALL
      SELECT nb.id, nb.w FROM neigh nb WHERE nb.id NOT IN (SELECT id FROM seeds)
    ),
    scored AS (
      SELECT m.thought_id, sum(w.w) AS score
      FROM thought_entities m JOIN weights w ON w.id = m.entity_id
      GROUP BY m.thought_id
    )
    SELECT t.metadata->>'issue' AS issue
    FROM scored s JOIN thoughts t ON t.id = s.thought_id
    ORDER BY s.score DESC, t.embedding <=> ${lit(qv)}::vector
    LIMIT ${Math.max(K, 20)}`;
  return rows.map((r: { issue: string }) => r.issue);
}

function rrf(lists: Ranked[], k = 60): Ranked {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// ── Communities, for the global arm ─────────────────────────────────────────

type Community = { label: number; entities: string[]; names: string[]; thoughts: Set<string>; summary?: string; vector?: number[] };
let communities: Community[] = [];
let summaryCost = { calls: 0, seconds: 0, chars: 0 };
if (GLOBAL) {
  const tc = Date.now();
  // Nodes: entities mentioned by at least two thoughts (1,767 of 2,044 are
  // mentioned once and would each be a community of one). Weights: thoughts
  // co-mentioning the pair, plus edge evidence.
  const nodes = (await sql`
    SELECT e.id, e.name FROM ob1_entities e WHERE (SELECT count(*) FROM thought_entities m WHERE m.entity_id = e.id) >= 2`) as { id: string; name: string }[];
  const nodeSet = new Set(nodes.map((n) => n.id));
  const nameOf = new Map(nodes.map((n) => [n.id, n.name]));
  const pairs = (await sql`
    SELECT a.entity_id AS x, b.entity_id AS y, count(*)::int AS w
    FROM thought_entities a JOIN thought_entities b ON a.thought_id = b.thought_id AND a.entity_id < b.entity_id
    GROUP BY 1, 2`) as { x: string; y: string; w: number }[];
  const edgeRows = (await sql`SELECT from_entity_id AS x, to_entity_id AS y, count(*)::int AS w FROM ob1_entity_edges GROUP BY 1, 2`) as { x: string; y: string; w: number }[];
  const adj = new Map<string, Map<string, number>>();
  const add = (x: string, y: string, w: number) => {
    if (!nodeSet.has(x) || !nodeSet.has(y)) return;
    if (!adj.has(x)) adj.set(x, new Map()); if (!adj.has(y)) adj.set(y, new Map());
    adj.get(x)!.set(y, (adj.get(x)!.get(y) ?? 0) + w); adj.get(y)!.set(x, (adj.get(y)!.get(x) ?? 0) + w);
  };
  for (const p of pairs) add(p.x, p.y, p.w);
  for (const e of edgeRows) add(e.x, e.y, e.w);
  // Label propagation, deterministic: nodes in a fixed order, ties to the
  // smallest label, ten sweeps or convergence. The order is by NAME — entity
  // ids are minted afresh each time the graph is replayed, and the first two
  // runs of this harness ordered by id and found 18 communities one time and 6
  // the next, the second with one of 201 entities. Label propagation is
  // order-dependent; that is a property of the method worth knowing before
  // anyone builds summaries on it.
  const order = [...nodeSet].sort((a, b) => (nameOf.get(a)! + a).localeCompare(nameOf.get(b)! + b));
  const label = new Map(order.map((id, i) => [id, i]));
  for (let sweep = 0; sweep < 10; sweep++) {
    let changed = 0;
    for (const id of order) {
      const votes = new Map<number, number>();
      for (const [nb, w] of adj.get(id) ?? []) votes.set(label.get(nb)!, (votes.get(label.get(nb)!) ?? 0) + w);
      if (votes.size === 0) continue;
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      if (best !== label.get(id)) { label.set(id, best); changed++; }
    }
    if (changed === 0) break;
  }
  const groups = new Map<number, string[]>();
  for (const [id, l] of label) { if (!groups.has(l)) groups.set(l, []); groups.get(l)!.push(id); }
  for (const [l, ids] of groups) {
    if (ids.length < 3) continue;
    const thoughts = new Set<string>((await sql`SELECT DISTINCT thought_id FROM thought_entities WHERE entity_id = ANY(${sql.array(ids, "TEXT")}::uuid[])`).map((r: { thought_id: string }) => r.thought_id));
    communities.push({ label: l, entities: ids, names: ids.map((i) => nameOf.get(i)!), thoughts });
  }
  communities.sort((a, b) => b.entities.length - a.entities.length);
  const sizes = communities.map((c) => c.entities.length);
  console.log(`  communities: ${groups.size} labels over ${nodes.length} entities with two or more mentions; ${communities.length} of size ≥ 3 (largest ${sizes[0] ?? 0}, median ${sizes[Math.floor(sizes.length / 2)] ?? 0}); detection ${((Date.now() - tc) / 1000).toFixed(1)} s`);

  // One summary per community: the entity names and up to eight issue titles.
  // This is the standing cost — every community whose membership changes
  // needs its summary regenerated.
  const ts = Date.now();
  for (const c of communities) {
    const titles = (await sql`SELECT t.metadata->>'issue' AS issue, split_part(t.content, E'\n', 1) AS title FROM thoughts t WHERE t.id = ANY(${sql.array([...c.thoughts], "TEXT")}::uuid[]) LIMIT 8`) as { issue: string; title: string }[];
    const prompt = `These entities were extracted from one team's engineering issues and cluster together:\n${c.names.slice(0, 40).join(", ")}\n\nSome of the issues that mention them:\n${titles.map((t) => `- ${t.title}`).join("\n")}\n\nIn three sentences, say what this cluster is about — the system, feature or concern it concerns — so that a question about that area could be matched to it. Answer with the sentences and nothing else.`;
    const r = await fetch(`${cfg.llmBase}/chat/completions`, {
      method: "POST", headers: cfg.headers,
      body: JSON.stringify({ model: cfg.metadataModel, temperature: 0, ...cfg.metadataReasoning, messages: [{ role: "user", content: prompt }] }),
    });
    const d = (await r.json()) as { choices?: [{ message?: { content?: string } }] };
    c.summary = (d?.choices?.[0]?.message?.content ?? "").trim() || c.names.slice(0, 20).join(", ");
    summaryCost.calls++; summaryCost.chars += prompt.length + c.summary.length;
    c.vector = await embed(EMBED_MODEL, c.summary);
  }
  summaryCost.seconds = (Date.now() - ts) / 1000;
  console.log(`  summaries: ${summaryCost.calls} generated and embedded in ${summaryCost.seconds.toFixed(0)} s (${(summaryCost.seconds / Math.max(summaryCost.calls, 1)).toFixed(1)} s each)\n`);
}

async function globalArm(qv: number[]): Promise<Ranked> {
  if (communities.length === 0) return [];
  const best = communities.map((c) => ({ c, s: cosine(qv, c.vector!) })).sort((a, b) => b.s - a.s).slice(0, 2);
  const ids = [...new Set(best.flatMap((b) => [...b.c.thoughts]))];
  if (ids.length === 0) return [];
  const rows = await sql`
    SELECT metadata->>'issue' AS issue FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])
    ORDER BY embedding <=> ${lit(qv)}::vector LIMIT ${Math.max(K, 20)}`;
  return rows.map((r: { issue: string }) => r.issue);
}

// ── Score ───────────────────────────────────────────────────────────────────

type Score = { recall: number; complete: boolean; mrr: number };
function score(ranked: Ranked, expected: string[]): Score {
  const top = ranked.slice(0, K);
  const hits = expected.filter((e) => top.includes(e)).length;
  const first = ranked.findIndex((r) => expected.includes(r));
  return { recall: hits / expected.length, complete: hits === expected.length, mrr: first >= 0 ? 1 / (first + 1) : 0 };
}

const arms = ["vector", "graph", "hybrid", ...(GLOBAL ? ["global"] : []), "keyword"] as const;
type Arm = (typeof arms)[number];
const results: { q: Question; seeds: string[]; scores: Partial<Record<Arm, Score>>; lists: Partial<Record<Arm, Ranked>> }[] = [];
let seedMs = 0;
for (const q of questions) {
  const qv = await embed(EMBED_MODEL, q.question, true);
  const ts = Date.now();
  const seeds = await seedEntities(q.question);
  seedMs += Date.now() - ts;
  const vector = await vectorArm(qv);
  const graph = await graphArm(seeds.ids, qv);
  const hybrid = rrf([vector, graph]);
  const lists: Partial<Record<Arm, Ranked>> = { vector, graph, hybrid };
  if (GLOBAL) lists.global = await globalArm(qv);
  const kw = await keywordArm(q.keyword);
  if (kw) lists.keyword = kw;
  const scores: Partial<Record<Arm, Score>> = {};
  for (const a of arms) if (lists[a]) scores[a] = score(lists[a]!, q.expected);
  results.push({ q, seeds: seeds.names, scores, lists });
  process.stderr.write(`  … ${q.id}\n`);
}

const types = ["multi-hop", "aggregation", "corpus"] as const;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`\n  ${questions.length} questions, recall@${K} (share of the expected documents in the top ${K}), complete@${K} (all of them), MRR of the first expected document`);
console.log(`  keyword is scored only on the ${questions.filter((q) => q.keyword).length} aggregation and corpus questions that carry a needle\n`);
console.log("  arm       " + types.map((t) => `${t.padEnd(12)} R@k  compl  MRR   `).join("") + "all          R@k  compl  MRR");
console.log("  " + "─".repeat(120));
for (const a of arms) {
  const cells = [...types, "all"].map((t) => {
    const rs = results.filter((r) => (t === "all" || r.q.type === t) && r.scores[a]);
    if (rs.length === 0) return `${String(t).padEnd(12)}    —     —     —   `;
    const R = mean(rs.map((r) => r.scores[a]!.recall)); const C = rs.filter((r) => r.scores[a]!.complete).length; const M = mean(rs.map((r) => r.scores[a]!.mrr));
    return `${String(t).padEnd(12)} ${R.toFixed(2)} ${`${C}/${rs.length}`.padStart(5)}  ${M.toFixed(2)}  `;
  });
  console.log(`  ${a.padEnd(9)} ${cells.join("")}`);
}

console.log(`\n  per question — recall@${K} by arm; seeds are the entities the question matched in the graph`);
console.log("  " + "question".padEnd(30) + arms.map((a) => a.padStart(8)).join("") + "   seeds");
for (const r of results) {
  console.log(`  ${r.q.id.padEnd(30)}${arms.map((a) => (r.scores[a] ? r.scores[a]!.recall.toFixed(2) : "—").padStart(8)).join("")}   ${r.seeds.slice(0, 6).join(", ")}${r.seeds.length > 6 ? ` (+${r.seeds.length - 6})` : ""}`);
}

const worse = results.filter((r) => r.scores.graph!.recall < r.scores.vector!.recall);
const better = results.filter((r) => r.scores.graph!.recall > r.scores.vector!.recall);
const hybridWorse = results.filter((r) => r.scores.hybrid!.recall < r.scores.vector!.recall);
console.log(`\n  graph beats vector on ${better.length} questions and loses on ${worse.length}; hybrid loses to vector on ${hybridWorse.length}`);
for (const r of worse) console.log(`    graph < vector  ${r.q.id}: missed ${r.q.expected.filter((e) => !r.lists.graph!.slice(0, K).includes(e)).join(", ")}`);
for (const r of results.filter((x) => x.scores.vector!.recall < 1)) {
  console.log(`    vector misses   ${r.q.id}: ${r.q.expected.filter((e) => !r.lists.vector!.slice(0, K).includes(e)).join(", ")}` +
    (r.scores.keyword ? `  — keyword "${r.q.keyword}" recall ${r.scores.keyword.recall.toFixed(2)}` : ""));
}

console.log(`\n  cost`);
console.log(`    graph construction: the SMD-947 extraction pass — 82 min for these 441 issues at two workers on qwen2.5:7b (FORK.md change 30); one call per new thought after that`);
if (GLOBAL) console.log(`    community summaries: ${summaryCost.calls} calls, ${summaryCost.seconds.toFixed(0)} s, ~${Math.round(summaryCost.chars / 4).toLocaleString()} tokens; regenerated whenever a community's membership changes`);
console.log(`    per question: seed extraction (one model call) ${(seedMs / questions.length / 1000).toFixed(1)} s on average, on top of the embedding call every arm pays`);
await sql.close();
