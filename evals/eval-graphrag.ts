#!/usr/bin/env bun
/**
 * eval-graphrag.ts — is retrieval over the entity graph worth building?
 *
 * SMD-948 asks for a spike with a decision at the end, and its first rule is
 * that the question set exists before the graph is judged. The questions are
 * `graphrag-questions.json`: twenty-seven asked over the Linear corpus, each
 * answered by two or more documents — multi-hop (combine specific documents),
 * aggregation (every document of one kind), corpus-level (the shape of the
 * corpus). The metric is retrieval: did the expected documents come back in
 * the top K. Any answering step has to work from what was retrieved, and a
 * generated answer over the wrong documents is a confident fabrication.
 *
 * Five arms, all over the same throwaway Postgres holding the corpus with real
 * embeddings and the entity graph SMD-947 extracted:
 *
 *   vector   `match_thoughts` — the baseline the product ships today.
 *   graph    "local" GraphRAG: the question's entities are found three ways —
 *            the extraction prompt over the question, resolved by the
 *            product's rule and by trigram similarity ≥ 0.55, plus any entity
 *            whose normalised name appears as whole words in the normalised
 *            question — weighted by rarity, expanded one hop over
 *            ob1_entity_edges, and the thoughts mentioning them ranked by
 *            summed weight, vector similarity breaking ties. That is more
 *            generous to the graph than the product's resolution rule alone;
 *            the README says so.
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
 * cached in /tmp keyed by model and text, so an edited corpus re-embeds.
 *
 * Every model call the graph arms depend on is counted when it fails, and the
 * report says so beside the table. An arm that never reached the model must
 * not read as an arm that lost; the first version of this file swallowed those
 * errors, and the numbers would have looked the same either way.
 *
 * Written for a corpus of hundreds of documents: the graph walk aggregates
 * document frequency per question and the community step reads every
 * co-mention pair. At tens of thousands of documents both want restructuring
 * before the run is quick.
 *
 *   OB1_EVAL_CORPUS=/tmp/linear-corpus-full.json ../db/with-postgres.sh bun eval-graphrag.ts
 *   … --no-global        skip the community summaries (the only slow, LLM-heavy arm)
 *   … --k 10             documents retrieved per question (default 10)
 *   … --allow-stale-dump replay a dump whose fingerprints do not match the loaded text, by id
 *   OB1_EVAL_EMBED=qwen3-embedding:4b@1024   the embedding spec, as the other harnesses take it
 */

import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";
import { embed, cosine, parseSpec } from "./lib.ts";
import { loadLinearCorpus, linearThoughtText, insertLinearThought, entityAnswersPath, readEntityAnswers } from "./linear-corpus.ts";
import { resolveEmbedConfig } from "../server-portable/embed.ts";
import { extractEntities, extractionKey } from "../server-portable/entities.ts";
import { requireDatabaseUrl, resetSchema } from "../db/test-support.ts";

loadEnv();
const URL_ = requireDatabaseUrl("eval-graphrag.ts");
const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && !args[i + 1]?.startsWith("--") ? args[i + 1] : undefined; };
// OB1_EVAL_BASE / OB1_EVAL_KEY (and lib.ts's OLLAMA_BASE fallback) are what the
// other harnesses use; the chat calls go through the server's resolver, which
// reads the OB1_LLM_* names. Bridge all three here, and lib.ts falls back to
// the OB1_LLM_* names in turn, so embeddings and the extraction and summary
// calls reach the same host with the same key whichever set was configured —
// the first version bridged only the URL, so a hosted run embedded with a key
// and extracted without one.
const evalBase = process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE;
if (!process.env.OB1_LLM_BASE_URL && evalBase) process.env.OB1_LLM_BASE_URL = evalBase;
if (!process.env.OB1_LLM_API_KEY && process.env.OB1_EVAL_KEY) process.env.OB1_LLM_API_KEY = process.env.OB1_EVAL_KEY;

const K = Number(flag("k") ?? 10);
if (!Number.isInteger(K) || K < 1) { console.error("--k needs a positive integer."); process.exit(2); }
// search_thoughts_keyword clamps its page at 100 (migration 012); above that the
// keyword arm would be scored over a shorter window than the others.
if (K > 100) { console.error("--k above 100 cannot be scored fairly: search_thoughts_keyword returns at most 100 rows."); process.exit(2); }
const FETCH = Math.max(K, 20); // every arm returns this many; scoring cuts at K
const GLOBAL = !has("no-global");
const ALLOW_STALE = has("allow-stale-dump");
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? Number(process.env.OB1_EMBEDDING_DIM || 1024); // "" is unset, not zero; the first vector is checked against this below
const cfg = resolveEmbedConfig(process.env);
const { path: corpusPath, docs } = loadLinearCorpus();
const answersPath = entityAnswersPath(cfg.metadataModel);
const vectorCache = `/tmp/graphrag-vectors-${EMBED_MODEL.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;

type Question = { id: string; type: "multi-hop" | "aggregation" | "corpus"; question: string; expected: string[]; keyword?: string };
const questions = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "graphrag-questions.json"), "utf8")) as { questions: Question[] }).questions;
if (!existsSync(answersPath)) {
  console.error(`No entity answers at ${answersPath}. Run eval-entities.ts --corpus first (about two hours); this spike replays its graph.`);
  process.exit(2);
}
const lit = (v: number[]) => `[${v.join(",")}]`;

console.log(`  corpus: ${docs.length} documents from ${corpusPath}; ${questions.length} questions; k = ${K}`);
console.log(`  embed:  ${EMBED_MODEL} @ ${DIM}; graph from ${answersPath}; extraction and summaries by ${cfg.metadataModel} at temperature ${cfg.metadataTemperature} via ${cfg.llmBase}\n`);

// ── Load: thoughts with vectors, then the graph ──────────────────────────────

await resetSchema(URL_, { dim: DIM, model: spec.name });
const sql = new SQL({ url: URL_, max: 4 });

// Cache entry per issue: the text hash it was embedded from, and the vector.
// A rebuilt corpus with edited text re-embeds those documents; the first
// version keyed by id alone and would have ranked new text on old vectors.
type Cached = { h: string; v: number[] };
let vectors: Record<string, Cached> = {};
if (existsSync(vectorCache)) {
  try { vectors = JSON.parse(readFileSync(vectorCache, "utf8")); } catch { console.error(`Unreadable vector cache ${vectorCache}; delete it and re-run.`); process.exit(2); }
}
let embedded = 0;
const t0 = Date.now();
for (const d of docs) {
  const text = linearThoughtText(d);
  const h = Bun.hash.xxHash64(text).toString(16);
  if (vectors[d.id]?.h !== h) { vectors[d.id] = { h, v: await embed(EMBED_MODEL, text) }; embedded++; }
  if (vectors[d.id].v.length !== DIM) { console.error(`  ${EMBED_MODEL} returned ${vectors[d.id].v.length}-wide vectors but the column is vector(${DIM}); give the spec an @dims suffix that matches the model.`); process.exit(2); }
  await insertLinearThought(sql, d, lit(vectors[d.id].v));
}
if (embedded) { writeFileSync(`${vectorCache}.tmp`, JSON.stringify(vectors)); renameSync(`${vectorCache}.tmp`, vectorCache); }
const loadedIssues = new Set<string>((await sql`SELECT metadata->>'issue' AS issue FROM thoughts`).map((r: { issue: string }) => r.issue));
console.log(`  loaded ${loadedIssues.size} thoughts (${embedded} embedded now, ${docs.length - embedded} from cache) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const dropped = docs.map((d) => d.id).filter((id) => !loadedIssues.has(id));
if (dropped.length) console.log(`  ! ${dropped.length} documents collapsed onto an earlier one by content fingerprint and are unreachable by every arm: ${dropped.join(", ")}`);
const unreachable = questions.flatMap((q) => q.expected.filter((e) => !loadedIssues.has(e)).map((e) => `${q.id}:${e}`));
if (unreachable.length) { console.error(`  expected documents not in this load — fix the question set or the corpus: ${unreachable.join(", ")}`); process.exit(2); }

// Each dump line carries the fingerprint of the row as the entity eval loaded
// it, and record_thought_entities takes it as its fifth argument: a line whose
// fingerprint no longer matches the row is refused as stale and writes nothing.
// A stale dump therefore cannot be scored as if it were of this text — the run
// stops, unless --allow-stale-dump says the operator knows (a dump written
// before the loader used content_fingerprint_of() matches nothing).
const key = extractionKey(cfg.metadataModel);
let replayed = 0, missing = 0, stale = 0, unfingerprinted = 0;
const { answers: dumpLines, unusable } = readEntityAnswers(answersPath);
// A dump extracted under another key is another model's graph; the header
// would attribute it to this one and the question-side extraction would come
// from a different model than the document side. Refuse, no override.
const wrongKey = dumpLines.filter((a) => a.key && a.key !== key).length;
const unkeyed = dumpLines.filter((a) => !a.key).length;
if (wrongKey) { console.error(`  ${wrongKey} dump lines were extracted under a different key than ${key}; point OB1_METADATA_MODEL at the model that made ${answersPath}`); process.exit(2); }
for (const a of dumpLines) {
  if (!a.fingerprint) unfingerprinted++;
  const [{ r }] = await sql`SELECT record_thought_entities(${a.id}::uuid, ${key}, ${a.entities}::jsonb, ${a.relations}::jsonb, ${ALLOW_STALE ? null : (a.fingerprint ?? null)}) AS r`;
  const res = r as { ok: boolean; stale?: boolean; error?: string };
  if (res.ok) replayed++; else if (res.stale) stale++; else missing++;
}
console.log(`  graph:  ${replayed} of ${dumpLines.length} dumped extractions replayed${missing ? `; ${missing} named thoughts not in this load` : ""}${stale ? `; ${stale} STALE (text changed since extraction)` : ""}${unfingerprinted ? `; ${unfingerprinted} carry no fingerprint` : ""}${unusable ? `; ${unusable} lines unusable` : ""}${unkeyed ? `; ${unkeyed} lines carry no extraction key (older dump), attributed to ${key}` : ""}`);
if ((stale || unfingerprinted) && !ALLOW_STALE) { console.error(`  the dump cannot be verified against this corpus for ${stale + unfingerprinted} thoughts and must not be scored as it; re-run eval-entities.ts --corpus, or pass --allow-stale-dump to replay by id anyway`); process.exit(2); }
if (replayed === 0) { console.error(`  no dump line named a loaded thought — the graph is empty; is ${answersPath} from this corpus?`); process.exit(2); }
if (ALLOW_STALE) console.log(`          --allow-stale-dump: fingerprints not checked; the extraction's text is taken to be this text`);
await sql.unsafe("VACUUM ANALYZE thoughts"); await sql.unsafe("ANALYZE ob1_entities"); await sql.unsafe("ANALYZE thought_entities"); await sql.unsafe("ANALYZE ob1_entity_edges");
const [g] = await sql`SELECT (SELECT count(*)::int FROM ob1_entities) AS entities, (SELECT count(*)::int FROM thought_entities) AS mentions, (SELECT count(*)::int FROM ob1_entity_edges) AS edges`;
console.log(`          → ${g.entities} entities, ${g.mentions} mentions, ${g.edges} edges`);

// A thought with no mention — its extraction timed out, or found nothing — is
// unreachable by the graph and global arms whatever the retrieval quality, so
// an expected document in that state caps the graph arms' recall below 1.0 on
// its question. Say which, per question, so those rows are read as coverage
// and not as ranking.
const mentioned = new Set<string>((await sql`SELECT DISTINCT t.metadata->>'issue' AS issue FROM thought_entities m JOIN thoughts t ON t.id = m.thought_id`).map((r: { issue: string }) => r.issue));
const uncovered = questions.map((q) => ({ q, ids: q.expected.filter((e) => !mentioned.has(e)) })).filter((x) => x.ids.length);
if (uncovered.length) {
  console.log(`  ! ${uncovered.reduce((n, x) => n + x.ids.length, 0)} expected documents have no entity mentions (extraction timed out or found nothing) and cannot be returned by the graph or global arm:`);
  for (const x of uncovered) console.log(`      ${x.q.id}: ${x.ids.join(", ")} — graph ceiling ${((x.q.expected.length - x.ids.length) / x.q.expected.length).toFixed(2)}`);
}
console.log("");

// ── The arms ────────────────────────────────────────────────────────────────

type Ranked = string[]; // issue ids, best first

async function vectorArm(qv: number[]): Promise<Ranked> {
  const rows = await sql`SELECT metadata->>'issue' AS issue FROM match_thoughts(${lit(qv)}::vector, -1.0, ${FETCH}, '{}'::jsonb)`;
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
  const rows = await sql`SELECT metadata->>'issue' AS issue FROM search_thoughts_keyword(${needle}, ${FETCH}, 0, '{}'::jsonb)`;
  return rows.map((r: { issue: string }) => r.issue);
}

// Every entity's normalised name, once, for the whole-word literal match below.
const entityNames = (await sql`SELECT id, name, normalized_name FROM ob1_entities WHERE length(normalized_name) >= 4`) as { id: string; name: string; normalized_name: string }[];

/**
 * Seed entities for a question, three ways, each marked in the seeds column:
 * the names the extraction model finds in the question, matched to
 * ob1_entities by the product's resolution rule (`normalize_entity_name`, and
 * `merged_from`) and, in addition, by trigram similarity ≥ 0.55 (two closest);
 * and any entity whose normalised name appears as whole words in the
 * normalised question (marked †), which catches the proper nouns a 7B model
 * types as topics. The first version tested a raw substring of the display
 * name and seeded "Expo" from "exposes". An extraction call that fails is
 * counted in `seedFailures` and the question falls back to literal matches
 * only — visibly, not silently.
 */
let seedFailures = 0;
const words = (t: string) => t.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
async function seedEntities(question: string): Promise<{ ids: string[]; names: string[] }> {
  let names: string[] = [];
  try {
    const ex = await extractEntities(question, cfg, AbortSignal.timeout(120_000));
    if (ex.malformed) { seedFailures++; console.error(`    seed extraction returned a malformed answer for: ${question.slice(0, 60)}…`); }
    else names = ex.entities.map((e) => e.name);
  } catch (e) {
    seedFailures++;
    console.error(`    seed extraction failed: ${(e as Error).message.slice(0, 160)}`);
  }
  const seen = new Map<string, string>();
  for (const n of names) {
    const rows = (await sql`
      SELECT id, name FROM ob1_entities
      WHERE normalized_name = normalize_entity_name(${n}) OR normalize_entity_name(${n}) = ANY(merged_from)
      UNION ALL
      (SELECT id, name FROM ob1_entities WHERE similarity(normalized_name, normalize_entity_name(${n})) >= 0.55 ORDER BY similarity(normalized_name, normalize_entity_name(${n})) DESC LIMIT 2)`) as { id: string; name: string }[];
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r.name);
  }
  // normalize_entity_name strips punctuation only at the ends of the string and
  // folds -_/\# inside it, so "Siggy Score, how" keeps its comma; both sides
  // are reduced to letters, digits and single spaces before the whole-word test.
  const [{ nq }] = await sql`SELECT normalize_entity_name(${question}) AS nq`;
  const padded = ` ${words(nq)} `;
  for (const e of entityNames) if (!seen.has(e.id) && padded.includes(` ${words(e.normalized_name)} `)) seen.set(e.id, `${e.name}†`);
  return { ids: [...seen.keys()], names: [...seen.values()] };
}

/**
 * Seeds are weighted by rarity — log(N / documents mentioning the entity) — and
 * an entity mentioned by more than a tenth of the corpus ("backend", "client",
 * "intake", "Healthie") is no seed at all: it says nothing about which
 * documents the question wants. The same cap applies to the neighbours the
 * hop reaches — the first version capped seeds only, and every hub came back
 * through the side door at 0.3 of its neighbour's weight. The first draft
 * weighted every seed 1.0 and lost to vector on 18 of 27 questions; this is
 * the fairest version of the local walk the author could build, and the
 * numbers reported are its.
 */
async function graphArm(seeds: string[], qv: number[]): Promise<Ranked> {
  if (seeds.length === 0) return [];
  const rows = await sql`
    WITH n AS (SELECT count(*)::float AS total FROM thoughts),
    df AS (SELECT entity_id, count(*)::float AS docs FROM thought_entities GROUP BY entity_id),
    seeds AS (
      SELECT s.id, ln(n.total / df.docs) AS w
      FROM unnest(${sql.array(seeds, "TEXT")}::uuid[]) AS s(id) JOIN df ON df.entity_id = s.id CROSS JOIN n
      WHERE df.docs <= n.total * 0.1
    ),
    neigh AS (
      SELECT nb.id, max(s.w) * 0.3 AS w
      FROM ob1_entity_edges g
      JOIN seeds s ON s.id IN (g.from_entity_id, g.to_entity_id)
      CROSS JOIN LATERAL (SELECT CASE WHEN g.from_entity_id = s.id THEN g.to_entity_id ELSE g.from_entity_id END AS id) nb
      JOIN df ON df.entity_id = nb.id CROSS JOIN n
      WHERE df.docs <= n.total * 0.1
      GROUP BY nb.id
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
    LIMIT ${FETCH}`;
  return rows.map((r: { issue: string }) => r.issue);
}

function rrf(lists: Ranked[], k = 60): Ranked {
  const score = new Map<string, number>();
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, FETCH);
}

// ── Communities, for the global arm ─────────────────────────────────────────

type Community = { names: string[]; thoughts: Set<string>; summary?: string; vector?: number[] };
let communities: Community[] = [];
let summaryCost = { calls: 0, failed: 0, seconds: 0, chars: 0 };
if (GLOBAL) {
  const tc = Date.now();
  // Nodes: entities mentioned by at least two thoughts (most are mentioned once
  // and would each be a community of one). Weights: thoughts co-mentioning the
  // pair, plus edge evidence.
  const nodes = (await sql`
    SELECT e.id, e.name, e.normalized_name, e.entity_type
    FROM ob1_entities e WHERE (SELECT count(*) FROM thought_entities m WHERE m.entity_id = e.id) >= 2`) as { id: string; name: string; normalized_name: string; entity_type: string }[];
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
  // smallest label, ten sweeps or convergence. The order is the table's unique
  // key, (normalized_name, entity_type) — entity ids are minted afresh each
  // time the graph is replayed, and the first two runs of this harness ordered
  // by id and found 18 communities one time and 6 the next, the second with
  // one of 201 entities. Ordering by display name was tried next and is not
  // enough either: the same name exists under several types. Label
  // propagation is order-dependent; that is a property of the method worth
  // knowing before anyone builds summaries on it.
  const order = nodes.slice().sort((a, b) => a.normalized_name.localeCompare(b.normalized_name) || a.entity_type.localeCompare(b.entity_type)).map((n) => n.id);
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
  for (const id of order) { const l = label.get(id)!; if (!groups.has(l)) groups.set(l, []); groups.get(l)!.push(id); }
  for (const ids of groups.values()) {
    if (ids.length < 3) continue;
    const thoughts = new Set<string>((await sql`SELECT DISTINCT thought_id FROM thought_entities WHERE entity_id = ANY(${sql.array(ids, "TEXT")}::uuid[])`).map((r: { thought_id: string }) => r.thought_id));
    communities.push({ names: ids.map((i) => nameOf.get(i)!), thoughts });
  }
  communities.sort((a, b) => b.names.length - a.names.length || a.names[0].localeCompare(b.names[0]));
  const sizes = communities.map((c) => c.names.length);
  console.log(`  communities: ${groups.size} labels over ${nodes.length} entities with two or more mentions; ${communities.length} of size ≥ 3 (largest ${sizes[0] ?? 0}, median ${sizes[Math.floor(sizes.length / 2)] ?? 0}); detection ${((Date.now() - tc) / 1000).toFixed(1)} s`);

  // One summary per community: the entity names and up to eight issue titles,
  // in a fixed order so the prompt is pinned and any run-to-run difference in
  // the summary is the model's. Same temperature knob as the extraction call
  // (OB1_METADATA_TEMPERATURE, default 0), printed in the header. This is the standing cost — every community
  // whose membership changes needs its summary regenerated. A failed call is
  // counted and the community falls back to its name list, visibly.
  const promptHashes: string[] = [];
  for (const c of communities) {
    const titles = (await sql`SELECT split_part(t.content, E'\n', 1) AS title FROM thoughts t WHERE t.id = ANY(${sql.array([...c.thoughts], "TEXT")}::uuid[]) ORDER BY t.metadata->>'issue' LIMIT 8`) as { title: string }[];
    const prompt = `These entities were extracted from one team's engineering issues and cluster together:\n${c.names.slice(0, 40).join(", ")}\n\nSome of the issues that mention them:\n${titles.map((t) => `- ${t.title}`).join("\n")}\n\nIn three sentences, say what this cluster is about — the system, feature or concern it concerns — so that a question about that area could be matched to it. Answer with the sentences and nothing else.`;
    promptHashes.push(Bun.hash.xxHash64(prompt).toString(16).slice(0, 6));
    const ts = Date.now();
    try {
      const r = await fetch(`${cfg.llmBase}/chat/completions`, {
        method: "POST", headers: cfg.headers, signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model: cfg.metadataModel, temperature: cfg.metadataTemperature, ...cfg.metadataReasoning, messages: [{ role: "user", content: prompt }] }),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
      const d = (await r.json()) as { choices?: [{ message?: { content?: string } }] };
      const text = (d?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error("empty completion");
      c.summary = text;
    } catch (e) {
      summaryCost.failed++;
      console.error(`    summary failed: ${(e as Error).message}`);
      c.summary = c.names.slice(0, 20).join(", ");
    } finally {
      summaryCost.seconds += (Date.now() - ts) / 1000;
    }
    summaryCost.calls++; summaryCost.chars += prompt.length + c.summary.length;
    c.vector = await embed(EMBED_MODEL, c.summary);
  }
  console.log(`  summaries: ${summaryCost.calls - summaryCost.failed} generated${summaryCost.failed ? `, ${summaryCost.failed} FAILED (name-list fallback)` : ""} in ${summaryCost.seconds.toFixed(0)} s of model time (${(summaryCost.seconds / Math.max(summaryCost.calls, 1)).toFixed(1)} s each); prompt hashes ${promptHashes.join(" ")}`);
  console.log(`  summary hashes ${communities.map((c) => Bun.hash.xxHash64(c.summary!).toString(16).slice(0, 6)).join(" ")}\n`);
}

async function globalArm(qv: number[]): Promise<Ranked> {
  if (communities.length === 0) return [];
  const best = communities.map((c) => ({ c, s: cosine(qv, c.vector!) })).sort((a, b) => b.s - a.s).slice(0, 2);
  const ids = [...new Set(best.flatMap((b) => [...b.c.thoughts]))];
  if (ids.length === 0) return [];
  const rows = await sql`
    SELECT metadata->>'issue' AS issue FROM thoughts WHERE id = ANY(${sql.array(ids, "TEXT")}::uuid[])
    ORDER BY embedding <=> ${lit(qv)}::vector LIMIT ${FETCH}`;
  return rows.map((r: { issue: string }) => r.issue);
}

// ── Score ───────────────────────────────────────────────────────────────────

// All three at K: recall (share of the expected documents in the top K),
// complete (all of them), MRR (rank of the first, zero if none in the top K).
// The first version took MRR over the whole returned list, which made it the
// same number at every K and gave the longer hybrid list a deeper window.
type Score = { recall: number; complete: boolean; mrr: number; missed: string[] };
function score(ranked: Ranked, expected: string[]): Score {
  const top = ranked.slice(0, K);
  const missed = expected.filter((e) => !top.includes(e));
  const first = top.findIndex((r) => expected.includes(r));
  return { recall: 1 - missed.length / expected.length, complete: missed.length === 0, mrr: first >= 0 ? 1 / (first + 1) : 0, missed };
}

type Result = { q: Question; seeds: string[]; scores: { vector: Score; graph: Score; hybrid: Score; global?: Score; keyword?: Score } };
type Arm = keyof Result["scores"];
const arms: Arm[] = ["vector", "graph", "hybrid", ...(GLOBAL ? (["global"] as Arm[]) : []), "keyword"];
const results: Result[] = [];
let seedMs = 0;
for (const q of questions) {
  const qv = await embed(EMBED_MODEL, q.question, true);
  const ts = Date.now();
  const seeds = await seedEntities(q.question);
  seedMs += Date.now() - ts;
  const vector = await vectorArm(qv);
  const graph = await graphArm(seeds.ids, qv);
  const scores: Result["scores"] = { vector: score(vector, q.expected), graph: score(graph, q.expected), hybrid: score(rrf([vector, graph]), q.expected) };
  if (GLOBAL) scores.global = score(await globalArm(qv), q.expected);
  const kw = await keywordArm(q.keyword);
  if (kw) scores.keyword = score(kw, q.expected);
  results.push({ q, seeds: seeds.names, scores });
  process.stderr.write(`  … ${q.id}\n`);
}
const of = (r: Result, a: Arm): Score | undefined => r.scores[a];

const types = ["multi-hop", "aggregation", "corpus"] as const;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`\n  ${questions.length} questions, recall@${K} (share of the expected documents in the top ${K}), complete@${K} (all of them), MRR@${K} (rank of the first expected document, 0 if none in the top ${K})`);
console.log(`  keyword is scored only on the ${questions.filter((q) => q.keyword).length} aggregation and corpus questions that carry a needle`);
if (seedFailures || summaryCost.failed) console.log(`  ! HARNESS: ${seedFailures} of ${questions.length} seed extractions failed; ${summaryCost.failed} of ${summaryCost.calls} summaries failed — the graph arms below were measured with those gaps`);
console.log("");
console.log("  arm       " + types.map((t) => `${t.padEnd(12)} R@k  compl  MRR   `).join("") + "all          R@k  compl  MRR");
console.log("  " + "─".repeat(120));
for (const a of arms) {
  const cells = [...types, "all"].map((t) => {
    const rs = results.filter((r) => (t === "all" || r.q.type === t) && of(r, a));
    if (rs.length === 0) return `${String(t).padEnd(12)}    —     —     —   `;
    const R = mean(rs.map((r) => of(r, a)!.recall)); const C = rs.filter((r) => of(r, a)!.complete).length; const M = mean(rs.map((r) => of(r, a)!.mrr));
    return `${String(t).padEnd(12)} ${R.toFixed(2)} ${`${C}/${rs.length}`.padStart(5)}  ${M.toFixed(2)}  `;
  });
  console.log(`  ${a.padEnd(9)} ${cells.join("")}`);
}

console.log(`\n  per question — recall@${K} by arm; seeds are the entities the question matched in the graph († = whole-word literal match, not from the extraction call)`);
console.log("  " + "question".padEnd(30) + arms.map((a) => a.padStart(8)).join("") + "   seeds");
for (const r of results) {
  console.log(`  ${r.q.id.padEnd(30)}${arms.map((a) => (of(r, a) ? of(r, a)!.recall.toFixed(2) : "—").padStart(8)).join("")}   ${r.seeds.slice(0, 6).join(", ")}${r.seeds.length > 6 ? ` (+${r.seeds.length - 6})` : ""}`);
}

const worse = results.filter((r) => r.scores.graph.recall < r.scores.vector.recall);
const better = results.filter((r) => r.scores.graph.recall > r.scores.vector.recall);
const hybridWorse = results.filter((r) => r.scores.hybrid.recall < r.scores.vector.recall);
const hybridBetter = results.filter((r) => r.scores.hybrid.recall > r.scores.vector.recall);
console.log(`\n  graph beats vector on ${better.length} questions and loses on ${worse.length}; hybrid beats vector on ${hybridBetter.length} and loses on ${hybridWorse.length}`);
for (const r of better) console.log(`    graph > vector  ${r.q.id}`);
for (const r of worse) console.log(`    graph < vector  ${r.q.id}: missed ${r.scores.graph.missed.join(", ")}`);
for (const r of results.filter((x) => x.scores.vector.recall < 1)) {
  console.log(`    vector misses   ${r.q.id}: ${r.scores.vector.missed.join(", ")}` + (r.scores.keyword ? `  — keyword "${r.q.keyword}" recall ${r.scores.keyword.recall.toFixed(2)}` : ""));
}

console.log(`\n  cost`);
console.log(`    graph construction: not measured by this run — it replays a dump. The extraction pass that made it is eval-entities.ts --corpus; FORK.md change 30 records 82 min for 441 issues at two workers on qwen2.5:7b. One call per new thought after that.`);
if (GLOBAL) console.log(`    community summaries: ${summaryCost.calls} calls, ${summaryCost.seconds.toFixed(0)} s of model time, ~${Math.round(summaryCost.chars / 4).toLocaleString()} tokens; regenerated whenever a community's membership changes`);
console.log(`    per question: seed extraction (one model call) ${(seedMs / questions.length / 1000).toFixed(1)} s on average, on top of the embedding call every arm pays`);
await sql.close();
