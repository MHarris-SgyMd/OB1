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
 *
 * SMD-1738 adds a sixth arm, `composed`: the graph as an EXPANSION / rerank stage over
 * vector recall (stage 1 coarse vector recall K′; stage 2 seed from the vector hits'
 * entities, expand `hops`, rerank the union), with a `comp-cos` cosine-only control. It
 * is scored against the labelled gold and gated by a pre-registered bar (see the report).
 *   OB1_GRAPH_KPRIME=10,20,50,100   coarse depths K′ to sweep (composed arm)
 *   OB1_GRAPH_HOPS=1,2              hop depths to sweep
 *   … --scale 1000000    skip the corpus; synthesize a graph of this many thoughts and
 *                        time the expansion stage only (latency, not quality). Knobs:
 *                        OB1_GRAPH_SCALE_ENTITIES / _MENTIONS_PER / _EDGES_PER / _SKEW /
 *                        _REPEAT. Use a small OB1_EVAL_EMBED dim (e.g. syn@64) at scale.
 */

import { SQL } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";
import { embed, cosine, parseSpec } from "./lib.ts";
import { loadLinearCorpus, linearThoughtText, insertLinearThought, entityAnswersPath, readEntityAnswers, cachedDocumentVectors, linearVectorCachePath } from "./linear-corpus.ts";
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
// SMD-1738: the composed arm's coarse depths (K′ ≫ k) and its hop depths, swept as
// comma lists so a run traces the whole curve. The headline cell is chosen after the
// sweep as the arm's best cell (see below), so graph gets its best shot.
const numList = (s: string | undefined, d: number[]) => (s ? s.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0) : d);
const KPRIMES = numList(process.env.OB1_GRAPH_KPRIME, [10, 20, 50, 100]);
const HOPS = numList(process.env.OB1_GRAPH_HOPS, [1, 2]);
// A truthy-but-all-invalid value (OB1_GRAPH_KPRIME=0/abc) filters to [] — refuse it the
// way --k does, rather than crash on an empty sweep later.
if (KPRIMES.length === 0) { console.error("OB1_GRAPH_KPRIME needs a comma list of positive integers."); process.exit(2); }
if (HOPS.length === 0) { console.error("OB1_GRAPH_HOPS needs a comma list of positive integers."); process.exit(2); }
function median(xs: number[]): number { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; }
// --scale N: skip the corpus and synthesize N thoughts + a synthetic entity graph, to
// measure the EXPANSION stage latency at scale (latency only — quality on a planted
// graph is circular). Density is modelled on the real graph's printed stats; the skew
// exponent makes a few hot entities so the hub cap does real work.
const SCALE = Number(flag("scale") ?? 0);
const SYN_ENT = Number(process.env.OB1_GRAPH_SCALE_ENTITIES ?? Math.max(1, Math.round(SCALE * 4))); // real: ~2000 entities for 441 docs
const SYN_MENTIONS = Number(process.env.OB1_GRAPH_SCALE_MENTIONS_PER ?? 6); // real: ~6.4 mentions/doc
const SYN_EDGES = Number(process.env.OB1_GRAPH_SCALE_EDGES_PER ?? 2); // real: ~2 edges/entity
const SYN_SKEW = Number(process.env.OB1_GRAPH_SCALE_SKEW ?? 2); // exponent on random() → hub skew
const SYN_REPEAT = Number(process.env.OB1_GRAPH_SCALE_REPEAT ?? 5); // timed runs per (K′, hops)
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? Number(process.env.OB1_EMBEDDING_DIM || 1024); // "" is unset, not zero; the first vector is checked against this below
const cfg = resolveEmbedConfig(process.env);
const { path: corpusPath, docs } = SCALE ? { path: "(synthetic)", docs: [] as ReturnType<typeof loadLinearCorpus>["docs"] } : loadLinearCorpus();
const answersPath = entityAnswersPath(cfg.metadataModel);

type Question = { id: string; type: "multi-hop" | "aggregation" | "corpus"; question: string; expected: string[]; keyword?: string };
const questions = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "graphrag-questions.json"), "utf8")) as { questions: Question[] }).questions;
if (!SCALE && !existsSync(answersPath)) {
  console.error(`No entity answers at ${answersPath}. Run eval-entities.ts --corpus first (about two hours); this spike replays its graph.`);
  process.exit(2);
}
const lit = (v: number[]) => `[${v.join(",")}]`;

if (!SCALE) {
  console.log(`  corpus: ${docs.length} documents from ${corpusPath}; ${questions.length} questions; k = ${K}`);
  console.log(`  embed:  ${EMBED_MODEL} @ ${DIM}; graph from ${answersPath}; extraction and summaries by ${cfg.metadataModel} at temperature ${cfg.metadataTemperature} via ${cfg.llmBase}\n`);
}

// ── Load: thoughts with vectors, then the graph ──────────────────────────────

await resetSchema(URL_, { dim: DIM, model: spec.name });
const sql = new SQL({ url: URL_, max: 4 });

// ── --scale N: synthetic graph, expansion-latency only (SMD-1738) ─────────────
if (SCALE) { await runScale(); await sql.close(); process.exit(0); }

// Document vectors from the shared cache in linear-corpus.ts: keyed by the
// text's hash so a rebuilt corpus with edited text re-embeds those documents,
// written atomically. This harness had its own copy until the hybrid eval
// needed the same thing; one definition now.
const t0 = Date.now();
const { vectors, embedded } = await cachedDocumentVectors(docs, {
  path: linearVectorCachePath(EMBED_MODEL, "thought"), dim: DIM, text: linearThoughtText, embed: (t) => embed(EMBED_MODEL, t),
});
for (const d of docs) await insertLinearThought(sql, d, lit(vectors[d.id]));
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

/**
 * SMD-1738 — the composed arm: the graph as an EXPANSION / rerank STAGE over vector
 * recall, not a substitute. Stage 1 is a coarse vector recall of K′ ≫ k thoughts;
 * stage 2 seeds the graph from THOSE hits' entities (not the question, as graphArm
 * does), expands `hops` over ob1_entity_edges, and reranks the union of the vector
 * candidates and the graph-reached thoughts. This is the substitute→complement reframe
 * SMD-948's 0.51 could not test: a thought that is a weak vector neighbour but strongly
 * connected by entity edges to the vector hits can be promoted into the top-k — the
 * multi-hop answer that is not the nearest neighbour.
 *
 * Weighting follows graphArm's philosophy: an entity's weight is its rarity ln(N/df),
 * an entity mentioned by more than a tenth of the corpus is no seed and no hop target
 * (the hub cap), and each hop decays by 0.3 — generalised to n hops as 0.3^(min hop
 * distance from a seed). `fuse`:
 *   "rrf"    symmetric reciprocal-rank fusion of the vector-similarity rank and the
 *            graph-score rank over the union — the headline. Symmetric because a raw
 *            cosine (~1) added to a raw IDF weight sum is the SMD-1707 scale-mismatch
 *            trap; both sides go on the RRF scale.
 *   "cosine" the same union ordered by cosine only — the control that isolates "did
 *            adding graph-reached candidates help?" from "did the graph rerank help?".
 * Returns the ranked issue ids and the two stage latencies.
 */
// Stage 2 alone: seed the graph from the candidate thoughts' entities, expand `hops`
// over the edges, score every thought that mentions a weighted entity, and return the
// union of the candidates and the graph-reached thoughts with their graph score and
// cosine distance. One statement, so its wall time is the bounded expansion cost the
// scale run measures directly (with candidates picked, not vector-recalled).
async function expandStage(candIds: string[], vecLit: string, hops: number): Promise<{ rows: { issue: string; gs: number; dist: number }[]; ms: number }> {
  const t = Date.now();
  const rows = (await sql`
    WITH RECURSIVE
    n AS (SELECT count(*)::float AS total FROM thoughts),
    df AS (SELECT entity_id, count(*)::float AS docs FROM thought_entities GROUP BY entity_id),
    cand(id) AS (SELECT unnest(${sql.array(candIds, "TEXT")}::uuid[])),
    -- seeds: the entities the candidates mention, hub-capped as in graphArm
    seed(id) AS (
      SELECT DISTINCT m.entity_id
      FROM thought_entities m JOIN cand ON cand.id = m.thought_id
      JOIN df ON df.entity_id = m.entity_id CROSS JOIN n
      WHERE df.docs <= n.total * 0.1
    ),
    -- expand up to hops over the edges; UNION dedups so cycles terminate
    reach(id, hop) AS (
      SELECT id, 0 FROM seed
      UNION
      SELECT nb.id, r.hop + 1
      FROM reach r
      JOIN ob1_entity_edges g ON r.id IN (g.from_entity_id, g.to_entity_id)
      CROSS JOIN LATERAL (SELECT CASE WHEN g.from_entity_id = r.id THEN g.to_entity_id ELSE g.from_entity_id END AS id) nb
      JOIN df ON df.entity_id = nb.id CROSS JOIN n
      WHERE r.hop < ${hops} AND df.docs <= n.total * 0.1
    ),
    mindist AS (SELECT id, min(hop) AS hop FROM reach GROUP BY id),
    weights AS (
      SELECT md.id, ln(n.total / df.docs) * power(0.3, md.hop) AS w
      FROM mindist md JOIN df ON df.entity_id = md.id CROSS JOIN n
    ),
    scored AS (
      SELECT m.thought_id, sum(w.w) AS gs
      FROM thought_entities m JOIN weights w ON w.id = m.entity_id
      GROUP BY m.thought_id
    )
    SELECT t.metadata->>'issue' AS issue, COALESCE(s.gs, 0) AS gs, (t.embedding <=> ${vecLit}::vector) AS dist
    FROM (SELECT id FROM cand UNION SELECT thought_id FROM scored) u
    JOIN thoughts t ON t.id = u.id
    LEFT JOIN scored s ON s.thought_id = t.id
    LEFT JOIN cand cc ON cc.id = t.id
    -- keep every vector candidate before the LIMIT bites: they carry gs = 0 and would
    -- otherwise be the first rows dropped, silently starving the arm of its own recall
    ORDER BY (cc.id IS NOT NULL) DESC, s.gs DESC NULLS LAST
    LIMIT 5000`) as { issue: string; gs: number; dist: number }[];
  return { rows, ms: Date.now() - t };
}

// Coarse vector recall: the top-K′ thought ids. Depends only on (q, K′), so a caller
// sweeping hops computes it once per K′ and reuses it across hops.
async function coarseRecall(qv: number[], kprime: number): Promise<{ ids: string[]; ms: number }> {
  const t = Date.now();
  const rows = (await sql`SELECT id FROM thoughts ORDER BY embedding <=> ${lit(qv)}::vector LIMIT ${kprime}`) as { id: string }[];
  return { ids: rows.map((r) => r.id), ms: Date.now() - t };
}

// Two rankings over one expansion union, from the same rows: the symmetric-RRF fuse of
// the cosine rank and the graph-score rank (the composed arm), and the cosine-only order
// (the comp-cos control). RRF is symmetric because a raw cosine added to a raw weight sum
// is change 87's scale-mismatch trap; both sides go on the rank scale.
function fuseUnion(rows: { issue: string; gs: number; dist: number }[]): { rrf: Ranked; cos: Ranked } {
  const byVec = rows.slice().sort((a, b) => a.dist - b.dist).map((r) => r.issue);
  const byGraph = rows.slice().sort((a, b) => b.gs - a.gs || a.dist - b.dist).map((r) => r.issue);
  return { rrf: rrf([byVec, byGraph]), cos: byVec.slice(0, FETCH) };
}

/**
 * --scale N (SMD-1738): synthesize N thoughts and a synthetic entity graph, then time
 * the EXPANSION stage (expandStage) across the K′ × hop grid. Latency only — quality on
 * a planted graph is circular (the edges reward the thoughts that planted them), so the
 * quality answer stays the real-corpus run. Density is modelled on the real graph's
 * printed stats, with a skew exponent so a few entities become hubs the 0.1·N cap must
 * exclude, as real hubs are. The candidate set is picked by id, so the coarse vector
 * cost (SMD-1707's result) is deliberately out of the measurement.
 */
async function runScale(): Promise<void> {
  const N = SCALE, M = SYN_ENT;
  console.log(`  --scale ${N.toLocaleString()}: synthesizing ${N.toLocaleString()} thoughts, ${M.toLocaleString()} entities, ~${SYN_MENTIONS} mentions/thought, ~${SYN_EDGES} edges/entity (skew ${SYN_SKEW}), dim ${DIM}`);
  const constVec = "[" + Array(DIM).fill(0.1).join(",") + "]";
  // We never vector-search here, and the thoughts triggers (audit + extraction enqueue)
  // would fire per row — drop the index and disable user triggers for the bulk load.
  await sql.unsafe(`DROP INDEX IF EXISTS thoughts_embedding_idx`);
  await sql.unsafe(`ALTER TABLE thoughts DISABLE TRIGGER USER`);
  const t0 = Date.now();
  await sql.unsafe(`CREATE TEMP TABLE syn_t AS SELECT g AS gid, gen_random_uuid() AS tid FROM generate_series(1, ${N}) g`);
  await sql.unsafe(`CREATE TEMP TABLE syn_e AS SELECT g AS gid, gen_random_uuid() AS eid FROM generate_series(1, ${M}) g`);
  await sql.unsafe(`CREATE INDEX ON syn_t (gid)`);
  await sql.unsafe(`CREATE INDEX ON syn_e (gid)`);
  await sql.unsafe(`INSERT INTO thoughts (id, content, embedding, metadata) SELECT tid, 'syn '||gid, '${constVec}'::vector, jsonb_build_object('issue', 'SYN-'||gid) FROM syn_t`);
  await sql.unsafe(`INSERT INTO ob1_entities (id, entity_type, name, normalized_name) SELECT eid, 'topic', 'e'||gid, 'e'||gid FROM syn_e`);
  // Mentions: each thought mentions SYN_MENTIONS entities, chosen with a skew so a few
  // entities are hot (and then excluded by the hub cap, as real hubs are). The random
  // target gid is computed per row in a MATERIALIZED CTE — random() in a JOIN ON, or in
  // an uncorrelated LATERAL, is evaluated once and every thought lands on one entity.
  await sql.unsafe(`
    WITH picks AS MATERIALIZED (
      SELECT t.tid, 1 + floor(power(random(), ${SYN_SKEW}) * ${M})::int AS egid
      FROM syn_t t CROSS JOIN generate_series(1, ${SYN_MENTIONS}) k
    )
    INSERT INTO thought_entities (thought_id, entity_id, confidence, extraction_key)
    SELECT p.tid, e.eid, 1.0, 'syn'
    FROM picks p JOIN syn_e e ON e.gid = p.egid
    ON CONFLICT DO NOTHING`);
  // Edges: SYN_EDGES per entity to skewed-random neighbours, each evidenced by a random
  // thought. Same per-row-random pattern.
  await sql.unsafe(`
    WITH picks AS MATERIALIZED (
      SELECT a.eid AS from_eid,
             1 + floor(power(random(), ${SYN_SKEW}) * ${M})::int AS to_gid,
             1 + floor(random() * ${N})::int AS t_gid
      FROM syn_e a CROSS JOIN generate_series(1, ${SYN_EDGES}) k
    )
    INSERT INTO ob1_entity_edges (thought_id, from_entity_id, to_entity_id, relation, confidence, extraction_key)
    SELECT t.tid, p.from_eid, b.eid, 'related_to', 1.0, 'syn'
    FROM picks p JOIN syn_e b ON b.gid = p.to_gid JOIN syn_t t ON t.gid = p.t_gid
    WHERE p.from_eid <> b.eid
    ON CONFLICT DO NOTHING`);
  await sql.unsafe(`ALTER TABLE thoughts ENABLE TRIGGER USER`);
  for (const tbl of ["thoughts", "ob1_entities", "thought_entities", "ob1_entity_edges"]) await sql.unsafe(`ANALYZE ${tbl}`);
  const loadS = ((Date.now() - t0) / 1000).toFixed(0);
  const [st] = await sql`SELECT
    (SELECT count(*)::int FROM thoughts) AS thoughts, (SELECT count(*)::int FROM ob1_entities) AS entities,
    (SELECT count(*)::int FROM thought_entities) AS mentions, (SELECT count(*)::int FROM ob1_entity_edges) AS edges`;
  const [deg] = await sql`SELECT avg(d)::float AS avg_deg, max(d)::int AS max_deg,
      count(*) FILTER (WHERE d > (SELECT count(*) FROM thoughts) * 0.1)::int AS hubs
    FROM (SELECT entity_id, count(*) AS d FROM thought_entities GROUP BY entity_id) q`;
  console.log(`  loaded in ${loadS} s → ${st.thoughts.toLocaleString()} thoughts, ${st.entities.toLocaleString()} entities, ${st.mentions.toLocaleString()} mentions, ${st.edges.toLocaleString()} edges`);
  console.log(`  entity mention degree: avg ${deg.avg_deg.toFixed(1)}, max ${deg.max_deg}, ${deg.hubs} above the 0.1·N hub cap (excluded from seeds and hops)`);
  console.log(`\n  expansion-stage latency (stage 2 only; candidates picked by id, so the coarse vector cost is out — that is SMD-1707's result). Median/p95 of ${SYN_REPEAT} runs.`);
  console.log(`    K′    hops   union rows   expand p50   expand p95`);
  console.log("    " + "─".repeat(58));
  for (const kprime of KPRIMES) for (const hops of HOPS) {
    const cand = (await sql`SELECT tid AS id FROM syn_t WHERE gid <= ${kprime}`).map((r: { id: string }) => r.id);
    const ms: number[] = []; let unionRows = 0;
    for (let i = 0; i < SYN_REPEAT; i++) { const r = await expandStage(cand, constVec, hops); ms.push(r.ms); unionRows = r.rows.length; }
    ms.sort((a, b) => a - b);
    console.log(`    ${String(kprime).padStart(4)}  ${String(hops).padStart(4)}   ${String(unionRows).padStart(9)}   ${ms[Math.floor(ms.length / 2)].toFixed(1)} ms    ${ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))].toFixed(1)} ms`);
  }
  console.log(`\n  Note: latency only. df is recomputed per call as in graphArm; a materialized df is the obvious production optimization. union rows caps at the query's LIMIT 5000.`);
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
// nDCG@k is binary-relevance over the labelled `expected` SET (gain 1 if a returned
// id is expected, discounted by log2(position+2)) divided by the ideal DCG of putting
// all min(|expected|, K) hits first. The set is the gold, not a ranked oracle, so
// this is the right nDCG here — a cosine oracle would be the wrong gold for a
// relational objective the graph expansion deliberately reorders toward (SMD-1707).
type Score = { recall: number; complete: boolean; mrr: number; ndcg: number; missed: string[] };
function score(ranked: Ranked, expected: string[]): Score {
  const top = ranked.slice(0, K);
  const missed = expected.filter((e) => !top.includes(e));
  const first = top.findIndex((r) => expected.includes(r));
  const exp = new Set(expected);
  const dcg = top.reduce((s, r, i) => s + (exp.has(r) ? 1 / Math.log2(i + 2) : 0), 0);
  let idcg = 0; for (let i = 0; i < Math.min(expected.length, K); i++) idcg += 1 / Math.log2(i + 2);
  return { recall: 1 - missed.length / expected.length, complete: missed.length === 0, mrr: first >= 0 ? 1 / (first + 1) : 0, ndcg: idcg > 0 ? dcg / idcg : 0, missed };
}

// The headline composed arms sit in the main table beside the substitute; `composed`
// is the RRF fuse and `comp-cos` the cosine-only control, both at the headline K′/hops.
type Result = { q: Question; seeds: string[]; scores: { vector: Score; graph: Score; hybrid: Score; composed: Score; "comp-cos": Score; global?: Score; keyword?: Score } };
type Arm = keyof Result["scores"];
const arms: Arm[] = ["vector", "graph", "hybrid", "composed", "comp-cos", ...(GLOBAL ? (["global"] as Arm[]) : []), "keyword"];
const results: Result[] = [];
// The full K′ × hop sweep of the composed arm, one cell per (K′, hops). Each row keeps
// both the RRF fuse (the composed arm) and the cosine-only order (the comp-cos control)
// derived from the same expansion union, so comp-cos is the control for whatever cell
// becomes the headline — not a different depth.
type SweepRow = { q: Question; s: Score; sCos: Score; coarseMs: number; expandMs: number };
const sweep: { kprime: number; hops: number; rows: SweepRow[] }[] = [];
for (const kprime of KPRIMES) for (const hops of HOPS) sweep.push({ kprime, hops, rows: [] });
const cellOf = new Map(sweep.map((c) => [`${c.kprime}:${c.hops}`, c]));
let seedMs = 0;
for (const q of questions) {
  const qv = await embed(EMBED_MODEL, q.question, true);
  const ts = Date.now();
  const seeds = await seedEntities(q.question);
  seedMs += Date.now() - ts;
  const vector = await vectorArm(qv);
  const graph = await graphArm(seeds.ids, qv);
  // Coarse recall once per K′ (reused across hops); expansion once per (K′, hops); both
  // rankings from the one union. The headline cell (which feeds the main table and the
  // bar) is chosen after the sweep as the arm's BEST cell, so the graph gets its best shot.
  for (const kprime of KPRIMES) {
    const c = await coarseRecall(qv, kprime);
    for (const hops of HOPS) {
      const { rows, ms } = await expandStage(c.ids, lit(qv), hops);
      const f = fuseUnion(rows);
      cellOf.get(`${kprime}:${hops}`)!.rows.push({ q, s: score(f.rrf, q.expected), sCos: score(f.cos, q.expected), coarseMs: c.ms, expandMs: ms });
    }
  }
  const scores: Result["scores"] = {
    vector: score(vector, q.expected), graph: score(graph, q.expected), hybrid: score(rrf([vector, graph]), q.expected),
    composed: score([], q.expected), "comp-cos": score([], q.expected), // both filled from the best cell after the sweep
  };
  if (GLOBAL) scores.global = score(await globalArm(qv), q.expected);
  const kw = await keywordArm(q.keyword);
  if (kw) scores.keyword = score(kw, q.expected);
  results.push({ q, seeds: seeds.names, scores });
  process.stderr.write(`  … ${q.id}\n`);
}
// Headline = the composed arm's best cell by multi-hop recall (tie-break: cheaper
// expansion). Fill each result's composed and comp-cos scores from it; results and every
// cell's rows are in the same question order.
const meanMH = (rows: SweepRow[]) => { const mh = rows.filter((r) => r.q.type === "multi-hop"); return mh.length ? mh.reduce((a, r) => a + r.s.recall, 0) / mh.length : 0; };
const bestCell = sweep.slice().sort((a, b) => meanMH(b.rows) - meanMH(a.rows) || median(a.rows.map((r) => r.expandMs)) - median(b.rows.map((r) => r.expandMs)))[0];
const headK = bestCell.kprime, headH = bestCell.hops;
results.forEach((r, i) => { r.scores.composed = bestCell.rows[i].s; r.scores["comp-cos"] = bestCell.rows[i].sCos; });
const of = (r: Result, a: Arm): Score | undefined => r.scores[a];

const types = ["multi-hop", "aggregation", "corpus"] as const;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`\n  ${questions.length} questions, recall@${K} (share of the expected documents in the top ${K}), nDCG@${K} (position-discounted, over the labelled set), complete@${K} (all of them), MRR@${K} (rank of the first expected document, 0 if none in the top ${K})`);
console.log(`  composed = vector coarse recall K′=${headK} → graph expansion ${headH} hop(s) → RRF rerank, the arm's best cell (SMD-1738); comp-cos = that same union ordered by cosine only (control); graph = the SMD-948 substitute (question-seeded)`);
console.log(`  keyword is scored only on the ${questions.filter((q) => q.keyword).length} aggregation and corpus questions that carry a needle`);
if (seedFailures || summaryCost.failed) console.log(`  ! HARNESS: ${seedFailures} of ${questions.length} seed extractions failed; ${summaryCost.failed} of ${summaryCost.calls} summaries failed — the graph arms below were measured with those gaps`);
console.log("");
console.log("  arm       " + types.map((t) => `${t.padEnd(10)} R@k  nDCG compl  MRR  `).join("") + "all        R@k  nDCG compl  MRR");
console.log("  " + "─".repeat(140));
for (const a of arms) {
  const cells = [...types, "all"].map((t) => {
    const rs = results.filter((r) => (t === "all" || r.q.type === t) && of(r, a));
    if (rs.length === 0) return `${String(t).padEnd(10)}   —    —     —     —  `;
    const R = mean(rs.map((r) => of(r, a)!.recall)); const N = mean(rs.map((r) => of(r, a)!.ndcg)); const C = rs.filter((r) => of(r, a)!.complete).length; const M = mean(rs.map((r) => of(r, a)!.mrr));
    return `${String(t).padEnd(10)} ${R.toFixed(2)} ${N.toFixed(2)} ${`${C}/${rs.length}`.padStart(5)}  ${M.toFixed(2)} `;
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

// ── The composed arm: SMD-1738 ───────────────────────────────────────────────
// The K′ × hop sweep of the composed RRF arm — recall recovers with coarse depth if
// it recovers at all, so the curve, not one point, is the finding. Latency is the
// stage cost: coarse (vector) p50 and expansion (graph) p50.
const mhOf = (rows: SweepRow[]) => rows.filter((r) => r.q.type === "multi-hop");
console.log(`\n  composed arm (SMD-1738) — K′ × hop sweep, RRF fuse, scored vs the labelled gold`);
console.log(`    K′    hops   R@k(all)  R@k(mh)  nDCG(mh)   coarse p50   expand p50`);
console.log("    " + "─".repeat(72));
for (const cell of sweep) {
  const mh = mhOf(cell.rows);
  const Rall = mean(cell.rows.map((r) => r.s.recall)); const Rmh = mean(mh.map((r) => r.s.recall)); const Nmh = mean(mh.map((r) => r.s.ndcg));
  const head = cell.kprime === headK && cell.hops === headH ? " ←headline (best)" : "";
  console.log(`    ${String(cell.kprime).padStart(4)}  ${String(cell.hops).padStart(4)}     ${Rall.toFixed(2)}     ${Rmh.toFixed(2)}     ${Nmh.toFixed(2)}     ${median(cell.rows.map((r) => r.coarseMs)).toFixed(1)} ms     ${median(cell.rows.map((r) => r.expandMs)).toFixed(1)} ms${head}`);
}

// Recovery: on the multi-hop subset — where the answer is not the nearest vector
// neighbour — does the composed arm recover what vector-only misses, and net of what
// it breaks? This is the ticket's crux and the pre-registered bar's subject.
const mhR = results.filter((r) => r.q.type === "multi-hop");
const recovered = mhR.filter((r) => r.scores.composed.recall > r.scores.vector.recall);
const brokenMH = mhR.filter((r) => r.scores.composed.recall < r.scores.vector.recall);
const vecMH = mean(mhR.map((r) => r.scores.vector.recall));
const compMH = mean(mhR.map((r) => r.scores.composed.recall));
const vecAll = mean(results.map((r) => r.scores.vector.recall));
const compAll = mean(results.map((r) => r.scores.composed.recall));
console.log(`\n  composed vs vector on the ${mhR.length} multi-hop questions (best cell K′=${headK}, ${headH} hop):`);
console.log(`    multi-hop recall@${K}: vector ${vecMH.toFixed(2)} → composed ${compMH.toFixed(2)}  (lift ${(compMH - vecMH >= 0 ? "+" : "") + (compMH - vecMH).toFixed(2)})`);
console.log(`    recovers ${recovered.length}, breaks ${brokenMH.length}  (net ${recovered.length - brokenMH.length >= 0 ? "+" : ""}${recovered.length - brokenMH.length})`);
for (const r of recovered) console.log(`      recovers  ${r.q.id}: vector ${r.scores.vector.recall.toFixed(2)} → composed ${r.scores.composed.recall.toFixed(2)}`);
for (const r of brokenMH) console.log(`      breaks    ${r.q.id}: vector ${r.scores.vector.recall.toFixed(2)} → composed ${r.scores.composed.recall.toFixed(2)} (dropped ${r.scores.composed.missed.filter((m) => !r.scores.vector.missed.includes(m)).join(", ")})`);
console.log(`    aggregate recall@${K} (all ${results.length}): vector ${vecAll.toFixed(2)} → composed ${compAll.toFixed(2)}  (Δ ${(compAll - vecAll >= 0 ? "+" : "") + (compAll - vecAll).toFixed(2)})`);

// The pre-registered adoption bar (SMD-1738, committed before the numbers): build the
// stage iff multi-hop recall lifts ≥ 0.05 over vector AND it recovers more than it
// breaks AND it does not cut aggregate recall. SMD-1038 posture — the bar, not the
// number, decides.
const lift = compMH - vecMH, net = recovered.length - brokenMH.length, agg = compAll - vecAll;
const pass = lift >= 0.05 && net > 0 && agg >= 0;
console.log(`\n  PRE-REGISTERED BAR (SMD-1738): multi-hop lift ≥ +0.05 AND net-positive AND aggregate not cut`);
console.log(`    lift ${(lift >= 0 ? "+" : "") + lift.toFixed(2)} ${lift >= 0.05 ? "✓" : "✗"} | net ${net >= 0 ? "+" : ""}${net} ${net > 0 ? "✓" : "✗"} | aggregate Δ ${(agg >= 0 ? "+" : "") + agg.toFixed(2)} ${agg >= 0 ? "✓" : "✗"}`);
console.log(`    VERDICT: ${pass ? "PASS → a graph expansion stage clears the bar; a product path is a separately scoped issue" : "FAIL → do not build; confirms SMD-948's decision, now on the composed axis"}`);

console.log(`\n  cost`);
console.log(`    graph construction: not measured by this run — it replays a dump. The extraction pass that made it is eval-entities.ts --corpus; FORK.md change 30 records 82 min for 441 issues at two workers on qwen2.5:7b. One call per new thought after that.`);
console.log(`    composed arm: no per-question model call — it expands from the vector hits, not question-extracted seeds; the cost is the coarse vector query plus the bounded expansion above`);
if (GLOBAL) console.log(`    community summaries: ${summaryCost.calls} calls, ${summaryCost.seconds.toFixed(0)} s of model time, ~${Math.round(summaryCost.chars / 4).toLocaleString()} tokens; regenerated whenever a community's membership changes`);
console.log(`    per question: seed extraction (one model call) ${(seedMs / questions.length / 1000).toFixed(1)} s on average, on top of the embedding call every arm pays`);
await sql.close();
