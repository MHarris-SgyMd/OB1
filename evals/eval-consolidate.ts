#!/usr/bin/env bun
/**
 * eval-consolidate.ts — how many pairs does the consolidation pass hand the
 * judge, does the judge agree with a human, and what does a full pass over a
 * real corpus cost and propose? (Linear SMD-1294; migration 029,
 * db/consolidate.ts, server-portable/consolidate.ts.)
 *
 * Three questions, asked against a throwaway Postgres loaded with the Linear
 * corpus — its real vectors (the shared cache) and its real capture dates, and
 * the entity graph replayed from eval-entities.ts's dump, because the candidate
 * rule pairs thoughts by the entities they share and is asked of the database
 * (`consolidation_candidates`), never re-derived here:
 *
 *   1. CANDIDATES. Pairs the rule yields at each k and cosine floor, and how
 *      many thoughts have any. The judge cost is per pair, so this table is
 *      what k and the floor were chosen from ("measure before picking k").
 *   2. JUDGE. On hand-labelled pairs (consolidate-labels.json: issue ids and a
 *      verdict, no text), precision and recall of "conflict" and the accuracy
 *      of the direction — the judge called directly on each labelled pair,
 *      whatever the candidate rule would have done with it.
 *   3. PASS (--full). db/consolidate.ts itself over the loaded corpus, so the
 *      wall clock is the tool's: pairs judged, calls per thousand thoughts,
 *      model seconds per pair, prompt tokens (what a hosted provider would
 *      bill), and the proposals — written to OB1_EVAL_OUT for a human to
 *      grade, and scored against the graded ones in the labels file.
 *
 *   OB1_EVAL_CORPUS=/tmp/linear-corpus-full.json ../db/with-postgres.sh bun eval-consolidate.ts          # 1 + 2
 *   … bun eval-consolidate.ts --full [--k N] [--min-sim F]                                              # + 3
 *   … bun eval-consolidate.ts --replay /tmp/consolidate-verdicts-<model>.jsonl                          # 2 and 3 scored from a worker dump, no model
 *   … bun eval-consolidate.ts --no-judge                                                                # 1 only
 *   … --allow-stale-dump    replay entity answers whose fingerprints no longer match the loaded text, by id (a corpus rebuilt since the extraction)
 *
 * Needs the entity answers dump (eval-entities.ts --corpus, about two hours
 * once) and an embedding provider for any document not in the vector cache.
 * The model, endpoint and temperature are the metadata-extraction ones
 * (OB1_METADATA_MODEL, OB1_LLM_BASE_URL or OB1_EVAL_BASE), through the same
 * resolver the worker uses.
 */

import { SQL } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";
import { embed, parseSpec } from "./lib.ts";
import { resolveEmbedConfig } from "../server-portable/embed.ts";
import { estimateTokens } from "../server-portable/chunk.ts";
import { extractionKey } from "../server-portable/entities.ts";
import {
  buildJudgeMessages, consolidateKey, judgePair, proposalVerdict, DEFAULT_CANDIDATES, DEFAULT_MIN_SIMILARITY, type Judgement,
} from "../server-portable/consolidate.ts";
import { requireDatabaseUrl, resetSchema, runScript } from "../db/test-support.ts";
import {
  loadLinearCorpus, linearThoughtText, linearThoughtId, insertLinearThought, entityAnswersPath, readEntityAnswers,
  cachedDocumentVectors, linearVectorCachePath,
} from "./linear-corpus.ts";

loadEnv();
const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = requireDatabaseUrl("eval-consolidate.ts");
const args = process.argv.slice(2);
const has = (n: string) => args.includes(`--${n}`);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && !args[i + 1]?.startsWith("--") ? args[i + 1] : undefined; };

const evalBase = process.env.OB1_EVAL_BASE ?? process.env.OLLAMA_BASE;
if (!process.env.OB1_LLM_BASE_URL && evalBase) process.env.OB1_LLM_BASE_URL = evalBase;
if (!process.env.OB1_LLM_API_KEY && process.env.OB1_EVAL_KEY) process.env.OB1_LLM_API_KEY = process.env.OB1_EVAL_KEY;

const FULL = has("full");
const REPLAY = flag("replay");
const NO_JUDGE = has("no-judge");
const ALLOW_STALE = has("allow-stale-dump");
const K = Number(flag("k") ?? DEFAULT_CANDIDATES);
const MIN_SIM = Number(flag("min-sim") ?? DEFAULT_MIN_SIMILARITY);
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? "qwen3-embedding:4b@1024";
const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? Number(process.env.OB1_EMBEDDING_DIM || 1024);
const OUT = process.env.OB1_EVAL_OUT ?? "/tmp/consolidate-proposals.md";
const cfg = resolveEmbedConfig(process.env);
const JOB = consolidateKey(cfg.metadataModel);
// The pass's verdicts, per judge model (OB1_EVAL_VERDICTS moves it); a --full
// run starts it empty, since the worker appends and a second run the same day
// would otherwise report the sum of both (review pass 2).
const DUMP = REPLAY ?? (process.env.OB1_EVAL_VERDICTS ?? `/tmp/consolidate-verdicts-${cfg.metadataModel.replace(/[^A-Za-z0-9.-]+/g, "_")}.jsonl`);
const { path: corpusPath, docs } = loadLinearCorpus();
const answersPath = entityAnswersPath(cfg.metadataModel);
if (!existsSync(answersPath)) {
  console.error(`No entity answers at ${answersPath}. Run eval-entities.ts --corpus first (about two hours); the candidate rule pairs thoughts by the entities they share.`);
  process.exit(2);
}

type LabelPair = { older: string; newer: string; label: "conflict" | "agree" | "unrelated"; supersedes?: "newer" | "older" | "unknown"; reason?: string };
type GradedProposal = { older: string; newer: string; true: boolean; reason?: string };
type Labels = { pairs: LabelPair[]; proposals?: GradedProposal[] };
const labels = JSON.parse(readFileSync(join(HERE, "consolidate-labels.json"), "utf8")) as Labels;

console.log(`  corpus: ${docs.length} documents from ${corpusPath}; ${labels.pairs.length} labelled pairs, ${labels.proposals?.length ?? 0} graded proposals`);
console.log(`  embed:  ${EMBED_MODEL} @ ${DIM}; graph from ${answersPath}; judge ${cfg.metadataModel} at temperature ${cfg.metadataTemperature} via ${cfg.chat.base}; key ${JOB}`);
console.log(`  k ${K}, cosine floor ${MIN_SIM}${REPLAY ? `; verdicts replayed from ${REPLAY}` : ""}\n`);

// ── Load: thoughts with vectors AND their capture dates, then the graph ──────

await resetSchema(URL_, { dim: DIM, model: spec.name });
const sql = new SQL({ url: URL_, max: 4 });
const lit = (v: number[]) => `[${v.join(",")}]`;
const t0 = Date.now();
const { vectors, embedded } = await cachedDocumentVectors(docs, {
  path: linearVectorCachePath(EMBED_MODEL, "thought"), dim: DIM, text: linearThoughtText, embed: (t) => embed(EMBED_MODEL, t),
});
// created_at is the issue's opening date: the candidate rule is about capture
// DAYS, and a corpus loaded at now() would have no pair a day apart.
for (const d of docs) await insertLinearThought(sql, d, lit(vectors[d.id]), linearThoughtText(d), d.createdAt);
const loaded = new Set<string>((await sql`SELECT metadata->>'issue' AS issue FROM thoughts`).map((r: { issue: string }) => r.issue));
console.log(`  loaded ${loaded.size} thoughts (${embedded} embedded now, ${docs.length - embedded} from cache) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const undated = docs.filter((d) => !d.createdAt).length;
if (undated) console.log(`  ! ${undated} documents carry no createdAt (a corpus built before 2026-09-08); they sit at now() and pair with nothing older`);

const key = extractionKey(cfg.metadataModel);
const { answers, unusable } = readEntityAnswers(answersPath);
let replayed = 0, stale = 0, missing = 0;
for (const a of answers) {
  const [{ r }] = await sql`SELECT record_thought_entities(${a.id}::uuid, ${a.key ?? key}, ${a.entities}::jsonb, ${a.relations}::jsonb, ${ALLOW_STALE ? null : (a.fingerprint ?? null)}) AS r`;
  const res = r as { ok: boolean; stale?: boolean };
  if (res.ok) replayed++; else if (res.stale) stale++; else missing++;
}
const [{ withEntities }] = await sql`SELECT count(DISTINCT thought_id)::int AS "withEntities" FROM thought_entities`;
console.log(`  graph:  ${replayed} of ${answers.length} extractions replayed${stale ? `, ${stale} stale` : ""}${missing ? `, ${missing} name no loaded thought` : ""}${unusable ? `, ${unusable} unusable` : ""}; ${withEntities} of ${loaded.size} thoughts carry at least one entity\n`);
if (stale > 0) { console.error("  the dump's fingerprints do not match this corpus's text; re-run eval-entities.ts --corpus, or pass --allow-stale-dump to replay by id anyway"); process.exit(2); }
if (ALLOW_STALE) console.log("  --allow-stale-dump: fingerprints not checked; an extraction is taken to be of the text now loaded");

// ── 1. Candidates: pairs per k and floor ─────────────────────────────────────

console.log("  ── 1. candidate pairs the rule yields (the judge cost is one call per pair) ──");
const KS = [1, 3, 5, 10];
const FLOORS = [0, 0.4, 0.5, 0.6, 0.7];
console.log(`  ${"k \\ floor".padEnd(10)}${FLOORS.map((f) => String(f).padStart(14)).join("")}`);
for (const k of KS) {
  const cells: string[] = [];
  for (const f of FLOORS) {
    const [{ pairs, thoughts }] = await sql`
      SELECT count(*)::int AS pairs, count(DISTINCT t.id)::int AS thoughts
      FROM thoughts t, LATERAL consolidation_candidates(t.id, ${k}::int, ${f}::float) c`;
    cells.push(`${String(pairs).padStart(6)} /${String(thoughts).padStart(4)}t`.padStart(14));
  }
  console.log(`  k=${String(k).padEnd(7)}${cells.join("")}`);
}
console.log("  (pairs / thoughts with at least one candidate)");
// Without the entity restriction: the same k nearest older thoughts by cosine
// alone, at the shipped floor — what the rule saves.
const [{ plain, plainThoughts }] = await sql`
  SELECT count(*)::int AS plain, count(DISTINCT t.id)::int AS "plainThoughts"
  FROM thoughts t, LATERAL (
    SELECT o.id FROM thoughts o
    WHERE o.embedding IS NOT NULL AND t.embedding IS NOT NULL
      AND (o.created_at AT TIME ZONE 'UTC')::date < (t.created_at AT TIME ZONE 'UTC')::date
      AND 1 - (o.embedding <=> t.embedding) >= ${MIN_SIM}::float
    ORDER BY o.embedding <=> t.embedding LIMIT ${K}::int) x`;
const [{ shipped, shippedThoughts }] = await sql`
  SELECT count(*)::int AS shipped, count(DISTINCT t.id)::int AS "shippedThoughts"
  FROM thoughts t, LATERAL consolidation_candidates(t.id, ${K}::int, ${MIN_SIM}::float) c`;
console.log(`  at k=${K}, floor ${MIN_SIM}: ${shipped} pairs over ${shippedThoughts} thoughts with the shared-entity rule; ${plain} pairs over ${plainThoughts} thoughts by cosine alone — the rule hands the judge ${plain ? Math.round((100 * shipped) / plain) : 0}% of the pairs`);
const simDist = (await sql`
  SELECT width_bucket(c.similarity, 0, 1, 10) AS b, count(*)::int AS n
  FROM thoughts t, LATERAL consolidation_candidates(t.id, ${K}::int, 0::float) c GROUP BY b ORDER BY b`) as { b: number; n: number }[];
console.log(`  cosine of the k=${K} candidates, by tenth: ${simDist.map((r) => `${((Number(r.b) - 1) / 10).toFixed(1)}:${r.n}`).join("  ")}\n`);

// ── 2. The judge on labelled pairs ───────────────────────────────────────────

type Side = { id: string; content: string; created_at: string };
const sideOf = async (issue: string): Promise<Side | null> => {
  const rows = (await sql`SELECT id, content, created_at FROM thoughts WHERE id = ${linearThoughtId(issue)}::uuid`) as Side[];
  return rows[0] ?? null;
};
type DumpLine = { newer: string; older: string; similarity?: number; key?: string; verdict: string; supersedes: string; confidence: number; reason: string; recorded: string | null };
const replayLines: DumpLine[] = REPLAY ? readFileSync(REPLAY, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as DumpLine) : [];
const replayByPair = new Map(replayLines.map((l) => [`${l.older}|${l.newer}`, l]));

const judgeOne = async (older: Side, newer: Side): Promise<Judgement | null> => {
  if (REPLAY) {
    const l = replayByPair.get(`${older.id}|${newer.id}`);
    if (!l) return null;
    return { verdict: l.verdict as Judgement["verdict"], supersedes: l.supersedes as Judgement["supersedes"], confidence: l.confidence, reason: l.reason, malformed: false };
  }
  return judgePair({ content: older.content, createdAt: older.created_at },
                   { content: newer.content, createdAt: newer.created_at },
                   cfg, AbortSignal.timeout(180_000));
};

if (!NO_JUDGE && labels.pairs.length) {
  console.log(`  ── 2. the judge on ${labels.pairs.length} labelled pairs${REPLAY ? " (verdicts from the dump; pairs the pass never judged are skipped)" : ""} ──`);
  let tp = 0, fp = 0, fn = 0, tn = 0, dirRight = 0, dirWrong = 0, dirUnknown = 0, malformed = 0, skipped = 0, judgeMs = 0;
  const reachable = { conflicts: 0, reached: 0 };
  const rows: string[] = [];
  for (const p of labels.pairs) {
    const older = await sideOf(p.older), newer = await sideOf(p.newer);
    if (!older || !newer) { skipped++; rows.push(`  · ${p.older} → ${p.newer}: not both in this load, skipped`); continue; }
    if (new Date(older.created_at) > new Date(newer.created_at)) { skipped++; rows.push(`  · ${p.older} → ${p.newer}: "older" was captured after "newer" in this corpus; skipped (fix the label)`); continue; }
    const isCandidate = (await sql`SELECT 1 FROM consolidation_candidates(${newer.id}::uuid, ${K}::int, ${MIN_SIM}::float) WHERE older_id = ${older.id}::uuid`).length > 0;
    if (p.label === "conflict") { reachable.conflicts++; if (isCandidate) reachable.reached++; }
    const t = Date.now();
    const j = await judgeOne(older, newer);
    judgeMs += Date.now() - t;
    if (!j) { skipped++; rows.push(`  · ${p.older} → ${p.newer}: not in the dump`); continue; }
    if (j.malformed) { malformed++; rows.push(`  ✗ ${p.older} → ${p.newer}: malformed answer (label ${p.label})`); continue; }
    const saidConflict = j.verdict === "conflict";
    const isConflict = p.label === "conflict";
    if (saidConflict && isConflict) {
      tp++;
      if (p.supersedes && p.supersedes !== "unknown") {
        if (j.supersedes === p.supersedes) dirRight++; else if (j.supersedes === "unknown") dirUnknown++; else dirWrong++;
      }
    } else if (saidConflict && !isConflict) fp++;
    else if (!saidConflict && isConflict) fn++;
    else tn++;
    const mark = saidConflict === isConflict ? "✓" : "✗";
    rows.push(`  ${mark} ${p.older} → ${p.newer}: label ${p.label}${p.supersedes ? `/${p.supersedes}` : ""}, judge ${j.verdict}${saidConflict ? `/${j.supersedes}` : ""} @${j.confidence.toFixed(2)}${isCandidate ? "" : "  (not a candidate at this k/floor)"}${j.reason ? ` — ${j.reason.slice(0, 90)}` : ""}`);
  }
  for (const r of rows) console.log(r);
  const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0;
  console.log(`\n  conflict: precision ${(prec * 100).toFixed(0)}% (${tp}/${tp + fp}), recall ${(rec * 100).toFixed(0)}% (${tp}/${tp + fn}); ${tn} agree/unrelated pairs correctly not flagged; ${malformed} malformed; ${skipped} skipped`);
  console.log(`  direction on the ${dirRight + dirWrong + dirUnknown} true conflicts with a labelled direction: ${dirRight} right, ${dirWrong} wrong, ${dirUnknown} left unknown`);
  console.log(`  reach: ${reachable.reached} of ${reachable.conflicts} labelled conflicts are candidates at k=${K}, floor ${MIN_SIM} — the pass can only propose what the rule hands it`);
  if (!REPLAY) console.log(`  judge time: ${(judgeMs / 1000).toFixed(0)} s for ${tp + fp + fn + tn + malformed} calls, ${(judgeMs / Math.max(1, tp + fp + fn + tn + malformed) / 1000).toFixed(1)} s per pair\n`);
}

// ── 3. The pass itself ───────────────────────────────────────────────────────

if (FULL || REPLAY) {
  console.log(`  ── 3. the pass: db/consolidate.ts over ${loaded.size} thoughts ──`);
  let wall = 0;
  let out = "";
  if (FULL) {
    writeFileSync(DUMP, "");
    const t = Date.now();
    const run = await runScript(["bun", join(HERE, "..", "db", "consolidate.ts"), "--url", URL_, "--k", String(K), "--min-sim", String(MIN_SIM), "--workers", "2", "--dump", DUMP],
      { cwd: join(HERE, "..", "db"), env: { ...process.env, DATABASE_URL: URL_ } as Record<string, string> });
    wall = (Date.now() - t) / 1000;
    out = run.out;
    for (const line of out.split("\n").filter((l) => /judged|proposal\(s\) recorded|model time per pair|pair\(s\) judged|queue:/.test(l))) console.log(`  worker: ${line.trim()}`);
    console.log(`  wall clock ${(wall / 60).toFixed(1)} min (exit ${run.code}); verdicts dumped to ${DUMP}`);
  } else {
    // Replay: re-record the dump's conflicts so the queue below is the pass's.
    for (const l of replayLines) {
      const j: Judgement = { verdict: l.verdict as Judgement["verdict"], supersedes: l.supersedes as Judgement["supersedes"], confidence: l.confidence, reason: l.reason, malformed: false };
      const v = proposalVerdict(j);
      if (v && l.recorded === "proposed") {
        // Under the key the dump line carries — the judge that made the verdict — not this run's.
        await sql`SELECT record_supersession_proposal(${l.older}::uuid, ${l.newer}::uuid, ${v}::text, ${l.confidence}::numeric, ${l.reason || null}::text, ${l.similarity ?? null}::float, ${l.key ?? JOB}::text, NULL::uuid)`;
      }
    }
  }
  const lines: DumpLine[] = existsSync(DUMP) ? readFileSync(DUMP, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as DumpLine) : [];
  // Prompt tokens: what a hosted provider bills. Rebuilt from the pair texts
  // with the worker's own prompt builder, estimated by chunk.ts's rule.
  let promptTokens = 0;
  for (const l of lines) {
    const [o] = (await sql`SELECT content, created_at FROM thoughts WHERE id = ${l.older}::uuid`) as Side[];
    const [n] = (await sql`SELECT content, created_at FROM thoughts WHERE id = ${l.newer}::uuid`) as Side[];
    if (o && n) promptTokens += estimateTokens(buildJudgeMessages({ content: o.content, createdAt: o.created_at }, { content: n.content, createdAt: n.created_at })[0].content);
  }
  const byVerdict = lines.reduce((m, l) => { m[l.verdict] = (m[l.verdict] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(`  ${lines.length} verdicts: ${Object.entries(byVerdict).map(([v, n]) => `${n} ${v}`).join(", ")}; ${lines.filter((l) => l.recorded === "proposed").length} proposed, ${lines.filter((l) => l.recorded === "under-confidence").length} conflicts under the confidence floor`);
  console.log(`  cost: ${lines.length} judge calls for ${loaded.size} thoughts (${withEntities} with entities) = ${Math.round((1000 * lines.length) / loaded.size)} calls per thousand thoughts; ~${promptTokens.toLocaleString()} estimated prompt tokens, ~${Math.round(promptTokens / lines.length || 0)} per call, ~${Math.round((promptTokens / loaded.size) * 1000).toLocaleString()} per thousand thoughts` +
    (wall ? `; ${(wall / 60).toFixed(1)} min wall on ${cfg.metadataModel}` : ""));

  const proposals = (await sql`SELECT * FROM list_supersession_proposals(NULL::text, 200)`) as Record<string, unknown>[];
  const issueOf = async (id: string) => (await sql`SELECT metadata->>'issue' AS i FROM thoughts WHERE id = ${id}::uuid`)[0]?.i as string | undefined;
  const graded = new Map((labels.proposals ?? []).map((g) => [`${g.older}|${g.newer}`, g]));
  let gTrue = 0, gFalse = 0, ungraded = 0;
  const md: string[] = [`# Supersession proposals — ${cfg.metadataModel}, k=${K}, floor ${MIN_SIM}, ${new Date().toISOString().slice(0, 10)}`, "", "Grade each: true (a real supersession/contradiction) or false, and copy the verdict into evals/consolidate-labels.json → proposals.", ""];
  for (const p of proposals) {
    const oi = await issueOf(String(p.older_id)), ni = await issueOf(String(p.newer_id));
    const g = graded.get(`${oi}|${ni}`);
    if (g) { if (g.true) gTrue++; else gFalse++; } else ungraded++;
    md.push(`## ${oi} (${String(p.older_created_at).slice(0, 10)}) → ${ni} (${String(p.newer_created_at).slice(0, 10)}) — ${p.verdict} @${Number(p.confidence).toFixed(2)}${g ? ` — graded ${g.true ? "TRUE" : "FALSE"}${g.reason ? `: ${g.reason}` : ""}` : ""}`,
      "", `judge: ${p.reason ?? ""}`, "", `**older ${oi}:** ${String(p.older_content).replace(/\s+/g, " ").slice(0, 700)}`, "", `**newer ${ni}:** ${String(p.newer_content).replace(/\s+/g, " ").slice(0, 700)}`, "");
  }
  writeFileSync(OUT, md.join("\n"));
  console.log(`  ${proposals.length} proposals written to ${OUT} for grading`);
  if (gTrue + gFalse) console.log(`  graded: ${gTrue} true, ${gFalse} false → precision ${Math.round((100 * gTrue) / (gTrue + gFalse))}% over ${gTrue + gFalse} graded (${ungraded} ungraded)`);
  const conflicts = labels.pairs.filter((p) => p.label === "conflict");
  if (conflicts.length) {
    let found = 0;
    for (const c of conflicts) {
      const o = linearThoughtId(c.older), n = linearThoughtId(c.newer);
      if (proposals.some((p) => String(p.older_id) === o && String(p.newer_id) === n)) found++;
    }
    console.log(`  recall over the ${conflicts.length} labelled conflicts: ${found} proposed by the pass (${Math.round((100 * found) / conflicts.length)}%)`);
  }
}

await sql.close();
