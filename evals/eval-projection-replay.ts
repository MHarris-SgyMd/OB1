#!/usr/bin/env bun
/**
 * eval-projection-replay.ts — can the read model be rebuilt from the log
 * without re-embedding what has not changed? (Linear SMD-1998, Spike 1 of the
 * event-sourcing ADR SMD-1997; the number the ADR's go/no-go rests on.)
 *
 * Under CQRS-lite (SMD-1997) the thoughts row, the chunk rows, the entity
 * graph, the proposals and the capture-time metadata are projections folded
 * from thought_audit, and a projection can be thrown away and replayed. The
 * largest projection is the embedding index, and re-embedding the corpus is
 * the single most expensive operation in the system — so the ADR stands or
 * falls on one question: does a replay REUSE a stored vector whenever the
 * `(content_fingerprint, embedding_model)` key the schema already records
 * (003/023, 021) is unchanged, and recompute only what changed?
 *
 * This is a measurement, not a projector. It reads the live brain through
 * DATABASE_URL — every statement a SELECT, the session set read-only before
 * the first one — and, unless --no-provider, embeds a stratified sample of
 * rows through the REAL embedder (server-portable/embed.ts, the same windows,
 * template and fallback a capture takes) against the configured provider, to
 * price a recompute in wall-clock and to check that the cached value is what
 * a fresh one would be (cosine, fresh against stored). Nothing is written to
 * the brain, and the provider is called only for the sample.
 *
 * The contract was pre-registered on the ticket before the first run and is
 * projection-replay.ts's PROJECTIONS and decideEmbedding; the scenarios are
 * the ticket's five (a no-op rebuild, N edits, a model bump, a comprehension-
 * only change, a window-recipe change); the bar is projection-replay.ts's
 * verdict. What the schema cannot say is said, not guessed: a head-window
 * fallback parent is not recorded on the row (034 records it on a re-embed
 * claim row), a capture row in the log carries metadata and not content
 * (008), the chunk rows carry no recipe (022), the graph rows carry no
 * fingerprint (016).
 *
 *   DATABASE_URL=… bun eval-projection-replay.ts                 # the report over the live brain, the sample through the provider
 *   DATABASE_URL=… bun eval-projection-replay.ts --no-provider   # the counts only; no provider call
 *   DATABASE_URL=… bun eval-projection-replay.ts --sample 21 --edit 10 --json out.json
 *   bun eval-projection-replay.ts --self-check                   # the rules, probed with hand-known rows; no database, no provider (CI, portable-server)
 *
 * The provider is the server's own: OB1_LLM_BASE_URL, OB1_EMBEDDING_MODEL and
 * the rest resolved by resolveEmbedConfig, the egress gate included — a
 * provider not declared local (OB1_LLM_LOCAL=1) refuses the text, as it would
 * refuse a capture. The configured model must be the brain's recorded one, or
 * the cosine would compare two models; the run says so and stops.
 */

import { SQL } from "bun";
import { writeFileSync } from "node:fs";
import { DEFAULT_EMBEDDING_MODEL } from "../db/config.mjs";
import { createAssert } from "../db/test-support.ts";
import { chunkContent } from "../server-portable/chunk.ts";
import { createEmbedder, ProviderError, resolveEmbedConfig, type EmbedEnv } from "../server-portable/embed.ts";
import { loadEnv } from "./env.ts";
import { cosine } from "./lib.ts";
import {
  KEY_VERDICTS, MIN_REUSE, MISSES, PROJECTIONS, REPRO_COSINE, buildScenarios, comprehensionOnlyRebuild, costModel, decideEmbedding, describeMisses, editedRebuild, fmtSeconds, graphCost, median, modelBumpRebuild, noOpRebuild, recipeChangeRebuild, recomputed, renderReport, staleGraph, stratifiedSample, tally, verdict,
  type Census, type ClaimStat, type CostModel, type Observation, type Sample, type Scenarios, type ThoughtRow,
} from "./projection-replay.ts";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (f: string): string | undefined => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

export const DEFAULT_SAMPLE = 21;
export const DEFAULT_EDITS = 10;
/** The name scenario C bumps to: any name that is not the label; the arithmetic does not depend on which. */
export const BUMPED_MODEL = "another-model@1024";

/** The argument rules, pure, so the self-check probes every shape (SMD-1713's lesson: a flag read once, a stray word admitted). */
export function argumentProblem(argv: readonly string[]): string | null {
  const known = new Set(["--self-check", "--no-provider", "--sample", "--edit", "--json"]);
  const valued = new Set(["--sample", "--edit", "--json"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!known.has(a)) return `unknown argument ${a}`;
    if (valued.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) return `${a} needs a value`;
      if (a !== "--json" && !(/^\d+$/.test(v) && Number(v) > 0)) return `${a} takes a positive integer, not "${v}"`;
      i++;
    }
  }
  const counts = new Map<string, number>();
  for (const a of argv) if (known.has(a)) counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const [a, n] of counts) if (n > 1) return `${a} given ${n} times; a flag given twice would be read once`;
  if (argv.includes("--self-check") && argv.length > 1) return "--self-check takes no other argument";
  return null;
}

// ── The live brain ───────────────────────────────────────────────────────────

type RawRow = {
  id: string; content: string; chars: number; stored_fp: string | null; payload_fp: string; model: string | null; has_vector: boolean;
  chunk_rows: number; mentions: number; extraction_keys: string; extracted_at: string | null; content_moved_at: string | null; extraction_queue: "queued" | "failed" | "none" | null;
};

function toRow(r: RawRow): ThoughtRow & { content: string } {
  return {
    id: r.id, content: r.content, chars: Number(r.chars), storedFingerprint: r.stored_fp, payloadFingerprint: r.payload_fp, model: r.model, hasVector: r.has_vector,
    chunkRows: Number(r.chunk_rows), mentions: Number(r.mentions), extractionKeys: r.extraction_keys ? r.extraction_keys.split(",") : [],
    contentMovedAfterExtraction: r.extracted_at !== null && r.content_moved_at !== null && new Date(r.content_moved_at) > new Date(r.extracted_at),
    extractionQueue: r.extraction_queue ?? "none",
  };
}

async function readBrain(sql: SQL): Promise<{ rows: (ThoughtRow & { content: string })[]; census: Census; claims: ClaimStat[] }> {
  // Read-only for the session: a bug below cannot write to the brain.
  await sql`SET default_transaction_read_only = on`;
  const config: Record<string, string> = {};
  for (const r of (await sql`SELECT key, value FROM ob1_config WHERE key IN ('embedding_model', 'embedding_dim', 'chunk_context', 'entity_extraction_key')`) as { key: string; value: string }[]) config[r.key] = r.value;

  const raw = (await sql`
    SELECT t.id::text AS id, t.content, length(t.content) AS chars, t.content_fingerprint AS stored_fp,
           content_fingerprint_of(t.content) AS payload_fp, t.embedding_model AS model, (t.embedding IS NOT NULL) AS has_vector,
           (SELECT count(*) FROM thought_chunks c WHERE c.thought_id = t.id)::int AS chunk_rows,
           (SELECT count(*) FROM thought_entities e WHERE e.thought_id = t.id)::int AS mentions,
           (SELECT coalesce(string_agg(DISTINCT e.extraction_key, ','), '') FROM thought_entities e WHERE e.thought_id = t.id) AS extraction_keys,
           (SELECT max(e.extracted_at) FROM thought_entities e WHERE e.thought_id = t.id)::text AS extracted_at,
           (SELECT max(a.created_at) FROM thought_audit a WHERE a.thought_id = t.id AND a.action = 'update' AND a.diff ? 'content'
              AND content_fingerprint_of(a.diff->'content'->>'before') <> content_fingerprint_of(a.diff->'content'->>'after'))::text AS content_moved_at,
           (SELECT CASE WHEN bool_or(w.status IN ('pending', 'claimed')) THEN 'queued' WHEN bool_or(w.status = 'failed') THEN 'failed' ELSE 'none' END
              FROM thought_work_claims w WHERE w.thought_id = t.id AND w.work_type LIKE 'extract:%') AS extraction_queue
    FROM thoughts t ORDER BY t.created_at, t.id`) as RawRow[];
  const rows = raw.map(toRow);

  const audit = (await sql`
    SELECT count(*) FILTER (WHERE action = 'capture')::int AS capture, count(*) FILTER (WHERE action = 'update')::int AS update,
           count(*) FILTER (WHERE action = 'delete')::int AS delete, count(*) FILTER (WHERE action = 'update' AND diff ? 'content')::int AS content_updates,
           count(*) FILTER (WHERE action = 'update' AND diff ? 'content' AND content_fingerprint_of(diff->'content'->>'before') <> content_fingerprint_of(diff->'content'->>'after'))::int AS key_updates,
           pg_total_relation_size('thought_audit')::bigint AS bytes FROM thought_audit`)[0] as { capture: number; update: number; delete: number; content_updates: number; key_updates: number; bytes: number | string };
  const liveWithContentEvent = Number(((await sql`SELECT count(*)::int AS n FROM thoughts t WHERE EXISTS (SELECT 1 FROM thought_audit a WHERE a.thought_id = t.id AND a.action = 'update' AND a.diff ? 'content')`)[0] as { n: number }).n);
  const edges = Number(((await sql`SELECT count(*)::int AS n FROM ob1_entity_edges`)[0] as { n: number }).n);
  const proposals = Number(((await sql`SELECT count(*)::int AS n FROM supersession_proposals`)[0] as { n: number }).n);
  const claims = ((await sql`
    SELECT work_type AS key, count(*)::int AS n,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - claimed_at))::float AS median_s,
           avg(extract(epoch FROM finished_at - claimed_at))::float AS mean_s
    FROM thought_work_claims WHERE status = 'succeeded' AND finished_at IS NOT NULL AND claimed_at IS NOT NULL GROUP BY 1 ORDER BY 1`) as { key: string; n: number; median_s: number; mean_s: number }[])
    .map((r) => ({ key: r.key, n: Number(r.n), medianS: Number(r.median_s), meanS: Number(r.mean_s) }));

  const byModel = new Map<string | null, number>();
  for (const r of rows) if (r.hasVector) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
  const census: Census = {
    thoughts: rows.length,
    chars: rows.reduce((n, r) => n + r.chars, 0),
    withVector: rows.filter((r) => r.hasVector).length,
    byModel: [...byModel].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n),
    fingerprintAgrees: rows.filter((r) => r.storedFingerprint === r.payloadFingerprint).length,
    chunkedThoughts: rows.filter((r) => r.chunkRows > 0).length,
    chunkRows: rows.reduce((n, r) => n + r.chunkRows, 0),
    mentions: rows.reduce((n, r) => n + r.mentions, 0),
    edges,
    proposals,
    audit: { capture: Number(audit.capture), update: Number(audit.update), delete: Number(audit.delete), contentUpdates: Number(audit.content_updates), keyUpdates: Number(audit.key_updates), liveWithContentEvent, bytes: Number(audit.bytes) },
    config,
  };
  return { rows, census, claims };
}

/** The stored vectors of the sampled rows, as pgvector prints them (`[a,b,…]`, JSON). */
async function storedVectors(sql: SQL, ids: string[]): Promise<Map<string, number[]>> {
  if (!ids.length) return new Map();
  // `id::text IN (…)` rather than `= ANY($1::uuid[])`: Bun binds a JS array to ANY as one text value (SMD-1803's trap).
  const rows = (await sql`SELECT id::text AS id, embedding::text AS v FROM thoughts WHERE embedding IS NOT NULL AND id::text IN ${sql(ids)}`) as { id: string; v: string }[];
  return new Map(rows.map((r) => [r.id, JSON.parse(r.v) as number[]]));
}

// ── The run ──────────────────────────────────────────────────────────────────

function scenariosOf(rows: readonly (ThoughtRow & { content: string })[], target: string, editN: number, wouldChunk: (r: ThoughtRow & { content: string }) => boolean): Scenarios {
  const edited = new Set(stratifiedSample(rows, editN).map((r) => r.id));
  return buildScenarios(rows, target, edited, BUMPED_MODEL, (r) => wouldChunk(r as ThoughtRow & { content: string }));
}

async function run(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is not set — the report reads the live brain; --self-check needs no database."); process.exit(2); }
  const sampleN = Number(valueOf("--sample") ?? DEFAULT_SAMPLE);
  const editN = Number(valueOf("--edit") ?? DEFAULT_EDITS);
  const withProvider = !has("--no-provider");

  const cfg = resolveEmbedConfig(process.env as EmbedEnv);
  const sql = new SQL(url);
  const { rows, census, claims } = await readBrain(sql);
  const target = census.config.embedding_model;
  if (!target) { console.error("ob1_config records no embedding_model (migration 006): nothing to replay against."); await sql.end(); process.exit(2); }
  // The server's own windowing rule decides which thoughts a recipe writes chunk rows for.
  const wouldChunk = (r: { content: string }) => chunkContent(r.content, { maxTokens: cfg.chunkTokens, threshold: cfg.chunkThreshold, overlapTokens: cfg.chunkOverlap }).length > 0;
  const scenarios = scenariosOf(rows, target, editN, wouldChunk);
  const stale = staleGraph(rows);

  let samples: Sample[] | null = null;
  let cost: CostModel | null = null;
  let provider: string | null = null;
  if (withProvider) {
    if (cfg.embeddingModel !== target) {
      console.error(`OB1_EMBEDDING_MODEL is ${cfg.embeddingModel} and the brain is recorded at ${target}: the fresh vector would be another model's, so the cosine would say nothing. Set the model, or --no-provider for the counts alone.`);
      await sql.end(); process.exit(2);
    }
    const picked = stratifiedSample(rows, sampleN);
    const stored = await storedVectors(sql, picked.map((r) => r.id));
    // rememberRefusal off, as reembed.ts runs it: each row's fallback is its own.
    const embedder = createEmbedder(() => cfg, { rememberRefusal: false });
    samples = [];
    process.stderr.write(`embedding ${picked.length} sampled rows through ${cfg.embeddings.base} (${cfg.embeddingModel}), one at a time\n`);
    for (const r of picked) {
      const t0 = performance.now();
      try {
        const e = await embedder.embedCapture(r.content, { kind: "re-embed", content: r.content });
        const ms = performance.now() - t0;
        const was = stored.get(r.id);
        samples.push({ id: r.id, chars: r.chars, windows: e.chunks.length, calls: 1 + e.chunks.length, ms, cosineToStored: was ? cosine(e.embedding, was) : null, fellBack: e.wholeContentFellBack });
        process.stderr.write(`  ${r.id} ${r.chars} chars ${(ms / 1000).toFixed(2)} s${e.chunks.length ? ` (${e.chunks.length} windows)` : ""}\n`);
      } catch (e) {
        await sql.end();
        if (e instanceof ProviderError && e.kind === "egress") {
          console.error(`the egress gate refused the sample's text: ${e.message}\n  Declare the provider local (OB1_LLM_LOCAL=1) as the server does, or --no-provider for the counts alone.`);
          process.exit(2);
        }
        throw e;
      }
    }
    cost = costModel(samples, { rows: census.thoughts, chars: census.chars }, editN);
    provider = `${cfg.embeddings.base} ${cfg.embeddingModel}@${cfg.embeddingDim}`;
  }
  await sql.end();

  const o: Observation = { at: new Date().toISOString(), census, scenarios, stale, claims, samples, cost, provider, verdict: verdict(scenarios, cost) };
  console.log(renderReport(o));
  const out = valueOf("--json");
  if (out) { writeFileSync(out, JSON.stringify({ ...o, samples: o.samples }, null, 2) + "\n"); console.error(`\nwritten: ${out}`); }
  process.exit(o.verdict.go ? 0 : 1);
}

// ── The self-check ───────────────────────────────────────────────────────────

const row = (id: string, o: Partial<ThoughtRow> = {}): ThoughtRow => ({
  id, chars: 1000, storedFingerprint: `fp-${id}`, payloadFingerprint: `fp-${id}`, model: "m1", hasVector: true, chunkRows: 0, mentions: 3, extractionKeys: ["extract:x@p1"], contentMovedAfterExtraction: false, extractionQueue: "none", ...o,
});

function selfCheck(): void {
  const { assert, report } = createAssert();

  console.log("[1] The contract names every projection once, with a verdict from the list");
  assert(PROJECTIONS.length === 5 && new Set(PROJECTIONS.map((p) => p.name)).size === 5, "five projections, five names");
  assert(PROJECTIONS.every((p) => KEY_VERDICTS.includes(p.verdict) && p.derived.length > 0 && p.recorded.length > 0), "each carries a derived key, a recorded key and a verdict from KEY_VERDICTS");
  assert(PROJECTIONS.find((p) => p.name === "embedding")!.verdict === "recorded" && PROJECTIONS.find((p) => p.name === "metadata")!.verdict === "unkeyed", "the embedding's key is recorded; the capture-time metadata has none");

  console.log("[2] The replay rule, branch by branch, in order");
  assert(decideEmbedding(row("a"), "m1") === "reuse", "same fingerprint, a vector, the target's label: reuse");
  assert(decideEmbedding(row("a", { storedFingerprint: "stale" }), "m1") === "recompute:content", "the row's key is not the payload's: recompute for content (an edit, or a stale key)");
  assert(decideEmbedding(row("a", { hasVector: false }), "m1") === "recompute:no-vector", "no vector: recompute");
  assert(decideEmbedding(row("a", { model: null }), "m1") === "recompute:unlabelled", "a NULL label is unknown, and unknown is not the target (021)");
  assert(decideEmbedding(row("a", { model: "m0" }), "m1") === "recompute:model", "another model's label: recompute");
  assert(decideEmbedding(row("a", { hasVector: false, model: null, storedFingerprint: "x" }), "m1") === "recompute:content", "the fingerprint is judged before the vector and the label");
  assert(decideEmbedding(row("a", { hasVector: false, model: null }), "m1") === "recompute:no-vector", "…and the vector before the label");
  assert(decideEmbedding(row("a"), "m1", "other") === "recompute:content", "a payload fingerprint given explicitly overrides the row's own (how an edit is simulated)");

  console.log("[3] The scenarios on a hand-known corpus");
  const corpus = [row("a"), row("b", { chars: 500 }), row("c", { chars: 9000, chunkRows: 4 }), row("d", { chars: 200, mentions: 0, extractionKeys: [] }), row("e", { chars: 3000, contentMovedAfterExtraction: true }), row("f", { chars: 7000 })];
  const a = noOpRebuild(corpus, "m1");
  assert(a.total === 6 && a.reuse === 6 && recomputed(a) === 0 && a.recomputed.length === 0, "A: a no-op rebuild reuses every row");
  const staleKey = corpus.map((r) => (r.id === "b" ? { ...r, storedFingerprint: "held-by-another-text" } : r));
  const a2 = noOpRebuild(staleKey, "m1");
  assert(a2.reuse === 5 && a2.recompute.content === 1 && a2.recomputed.join() === "b", "A: a row whose key went stale is one recompute for content, named");
  const vectorless = corpus.map((r) => (r.id === "d" ? { ...r, hasVector: false, model: null } : r));
  assert(noOpRebuild(vectorless, "m1").recompute["no-vector"] === 1 && describeMisses(noOpRebuild(vectorless, "m1")) === "no-vector 1", "A: a capture that landed vectorless is one recompute, described");
  const b = editedRebuild(corpus, "m1", new Set(["a", "f"]));
  assert(b.reuse === 4 && b.recompute.content === 2 && recomputed(b) === 2 && b.recomputed.join() === "a,f", "B: two edits recompute exactly two, for content, by id");
  assert(editedRebuild(corpus, "m1", new Set(["zzz"])).reuse === 6, "B: an edit naming no row changes nothing");
  const c = modelBumpRebuild(corpus, "m2");
  assert(c.reuse === 0 && c.recompute.model === 6, "C: a model bump recomputes every row, for the model");
  const mixed = corpus.map((r) => (r.id === "a" ? { ...r, model: "m2" } : r));
  assert(modelBumpRebuild(mixed, "m2").reuse === 1 && modelBumpRebuild(mixed, "m2").recompute.model === 5, "C: a row already at the new model is reused — a switch back re-embeds nothing twice (021)");
  const d = comprehensionOnlyRebuild(corpus, "m1");
  assert(recomputed(d.embedding) === 0 && d.graph.thoughts === 6 && d.graph.mentionsReplaced === 15, "D: a comprehension-only change recomputes no vector; the graph re-reads every thought and replaces its mention rows");
  const e = recipeChangeRebuild(corpus, (r) => r.chars > 5000);
  assert(e.parentsReused === 6 && e.chunkedNow === 1 && e.chunkRowsNow === 4 && e.wouldChunk === 2 && e.fallbackParentsUnknowable === true, "E: parents stay, the chunked thought's rows go, the recipe's own count is separate, the fallback is unknowable");
  assert(staleGraph(corpus).thoughts === 1 && staleGraph(corpus).mentions === 3 && staleGraph(corpus).unqueued === 1, "the stale graph counts the thought whose key moved after extraction, its mention rows, and that no pool holds it");
  assert(staleGraph([row("x", { contentMovedAfterExtraction: true, mentions: 0 })]).thoughts === 0, "…and not a thought with no graph rows to be stale");
  const pooled = [row("q", { contentMovedAfterExtraction: true, extractionQueue: "queued" }), row("f", { contentMovedAfterExtraction: true, extractionQueue: "failed" }), row("n", { contentMovedAfterExtraction: true }), row("ok", { extractionQueue: "failed" })];
  const sg = staleGraph(pooled);
  assert(sg.thoughts === 3 && sg.queued === 1 && sg.failed === 1 && sg.unqueued === 1, "…and says of each stale thought whether a re-read is queued, gave up, or was never asked; a failed row on a fresh thought is not stale");
  assert(tally([], "m1").total === 0 && recomputed(tally([], "m1")) === 0, "an empty corpus tallies to nothing");

  console.log("[4] The sample is deterministic and spread by length");
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `id-${String(i).padStart(2, "0")}`, chars: (i * 37) % 50 * 100 + 100 }));
  const s1 = stratifiedSample(many, 7);
  const s2 = stratifiedSample([...many].reverse(), 7);
  assert(s1.length === 7 && s1.map((r) => r.id).join() === s2.map((r) => r.id).join(), "seven rows, the same seven whatever the input order");
  const sortedChars = [...many].sort((x, y) => x.chars - y.chars);
  assert(s1[0].chars === sortedChars[0].chars && s1[6].chars === sortedChars[49].chars, "the shortest and the longest are always in the sample");
  assert(s1.every((r, i) => i === 0 || r.chars >= s1[i - 1].chars), "…in length order");
  assert(stratifiedSample(many, 100).length === 50 && stratifiedSample(many, 1).length === 1 && stratifiedSample(many, 0).length === 0 && stratifiedSample([], 5).length === 0, "n over the corpus is the corpus; one is the shortest; zero and an empty corpus are empty");
  const ties = [{ id: "b", chars: 5 }, { id: "a", chars: 5 }, { id: "c", chars: 5 }];
  assert(stratifiedSample(ties, 2).map((r) => r.id).join() === "a,c", "equal lengths fall to the id, so the sample is total-ordered");

  console.log("[5] The cost model's arithmetic");
  assert(median([3, 1, 2]) === 2 && median([4, 1, 3, 2]) === 2.5 && Number.isNaN(median([])), "median, odd and even and empty");
  const samples: Sample[] = [
    { id: "a", chars: 1000, windows: 0, calls: 1, ms: 1000, cosineToStored: 1, fellBack: false },
    { id: "b", chars: 3000, windows: 0, calls: 1, ms: 3000, cosineToStored: 0.9995, fellBack: false },
    { id: "c", chars: 8000, windows: 6, calls: 7, ms: 8000, cosineToStored: null, fellBack: true },
  ];
  const k = costModel(samples, { rows: 400, chars: 1_200_000 }, 10);
  assert(k.sampled === 3 && k.sampledChars === 12000 && k.medianMsPerRow === 3000 && k.meanMsPerRow === 4000, "per-row median and mean");
  assert(k.msPerKChar === 1000, "one second per thousand characters here");
  assert(k.modelBumpSecondsByRows === 1600 && k.modelBumpSecondsByChars === 1200 && k.editSeconds === 40, "the model bump priced by rows and by characters; the edits by rows");
  assert(k.minCosine === 0.9995 && k.medianCosine === 0.99975 && k.fellBack === 1, "the cosine over rows that had a vector; the fallbacks counted");
  const none = costModel([], { rows: 400, chars: 1 }, 10);
  assert(Number.isNaN(none.meanMsPerRow) && none.minCosine === null, "no sample: no numbers, no cosine");
  assert(fmtSeconds(30) === "30.0 s" && fmtSeconds(600) === "10.0 min" && fmtSeconds(7200) === "2.00 h" && fmtSeconds(NaN) === "?", "seconds are printed at the unit that reads");
  const g = graphCost([{ key: "extract:x@p2", n: 10, medianS: 36, meanS: 40 }], 400);
  assert(g.length === 1 && g[0].rebuildHoursSequential === 4, "the graph's rebuild priced from the log's own seconds per row");

  console.log("[6] The verdict against the pre-registered bar");
  const ideal: Scenarios = buildScenarios(corpus, "m1", new Set(["a", "f"]), "m2", (r) => r.chars > 5000);
  assert(ideal.noOp.reuse === a.reuse && ideal.edited.n === 2 && recomputed(ideal.edited.tally) === recomputed(b) && ideal.modelBump.tally.recompute.model === c.recompute.model && ideal.recipe.chunkRowsNow === e.chunkRowsNow, "buildScenarios assembles the five from one corpus, as the runner does");
  const goodCost = costModel([{ id: "a", chars: 1000, windows: 0, calls: 1, ms: 1000, cosineToStored: 0.9999, fellBack: false }], { rows: 6, chars: 20700 }, 2);
  const v = verdict(ideal, goodCost);
  assert(v.go && !v.provisional && v.reasons.some((r) => r.startsWith("A:")) && v.reasons.some((r) => r.startsWith("B:")) && v.reasons.some((r) => r.startsWith("C:")) && v.reasons.some((r) => r.startsWith("D:")) && v.reasons.some((r) => r.startsWith("E:")), "the ideal corpus is GO with a line per scenario");
  assert(verdict(ideal, null).go && verdict(ideal, null).provisional && verdict(ideal, null).reasons.some((r) => /provisional: no provider/.test(r)), "no provider: GO but provisional, said so");
  const poor = { ...ideal, noOp: noOpRebuild(corpus.map((r, i) => (i < 2 ? { ...r, storedFingerprint: "stale" } : r)), "m1") };
  const pv = verdict(poor, goodCost);
  assert(!pv.go && pv.reasons.some((r) => /NO-GO: the no-op rebuild reuses 4\/6 \(66.7%\).*content 2/.test(r)), "two stale keys in six is under the bar: NO-GO, the misses named");
  assert(MIN_REUSE === 0.99 && REPRO_COSINE === 0.99, "the bars are the pre-registered ones");
  const twoHundred = Array.from({ length: 200 }, (_, i) => row(`r${i}`, i === 0 ? { storedFingerprint: "stale" } : {}));
  const ov = verdict(buildScenarios(twoHundred, "m1", new Set(["r5", "r6"]), "m2", () => false), goodCost);
  assert(ov.go && ov.reasons.some((r) => /^A: the no-op rebuild reuses 199\/200 — misses the key states: content 1/.test(r)) && ov.reasons.some((r) => /^B: 2 edits recompute exactly 2/.test(r)), "one stale key in two hundred is over the bar: GO, the miss stated, the edits counted beyond it");
  const wrongB = { ...ideal, edited: { n: 3, tally: b } };
  assert(!verdict(wrongB, goodCost).go && verdict(wrongB, goodCost).reasons.some((r) => /NO-GO: 3 edits recompute 2/.test(r)), "edits that do not recompute exactly N: NO-GO");
  const leakyC = { ...ideal, modelBump: { other: "m2", tally: modelBumpRebuild(mixed, "m2") } };
  assert(!verdict(leakyC, goodCost).go && verdict(leakyC, goodCost).reasons.some((r) => /NO-GO: a model bump reuses 1/.test(r)), "a model bump that reuses a vector under another label: NO-GO");
  const touchyD = { ...ideal, comprehensionOnly: { embedding: b, graph: d.graph } };
  assert(!verdict(touchyD, goodCost).go && verdict(touchyD, goodCost).reasons.some((r) => /NO-GO: a comprehension-only change recomputes 2 embeddings/.test(r)), "a comprehension-only change that touches a vector: NO-GO");
  const drifted = costModel([{ id: "a", chars: 1000, windows: 0, calls: 1, ms: 1000, cosineToStored: 0.97, fellBack: false }], { rows: 6, chars: 20700 }, 2);
  assert(!verdict(ideal, drifted).go && verdict(ideal, drifted).reasons.some((r) => /NO-GO: a reused row's fresh vector sits at cosine 0.9700/.test(r)), "a cached vector a fresh one does not reproduce: NO-GO — the vector is not a function of its key");
  assert(!verdict({ ...ideal, noOp: tally([], "m1") }, goodCost).go, "an empty brain is NO-GO");

  console.log("[7] The report carries the contract, the scenarios and the verdict");
  const o: Observation = {
    at: "2026-09-24T00:00:00.000Z",
    census: { thoughts: 6, chars: 20700, withVector: 6, byModel: [{ model: "m1", n: 6 }], fingerprintAgrees: 6, chunkedThoughts: 1, chunkRows: 4, mentions: 15, edges: 9, proposals: 2, audit: { capture: 6, update: 3, delete: 0, contentUpdates: 2, keyUpdates: 1, liveWithContentEvent: 1, bytes: 400000 }, config: { embedding_model: "m1", chunk_context: "false", entity_extraction_key: "extract:x@p1" } },
    scenarios: ideal, stale: staleGraph(corpus), claims: [{ key: "extract:x@p1", n: 6, medianS: 30, meanS: 31 }], samples, cost: costModel(samples, { rows: 6, chars: 20700 }, 2), provider: "http://p m1@1024", verdict: v,
  };
  const text = renderReport(o);
  for (const p of PROJECTIONS) assert(text.includes(p.table) && text.includes(p.verdict), `the report names ${p.table} and its verdict`);
  assert(/A no-op rebuild\s+6\s+100\.0%\s+0\s+none/.test(text) && /B 2 edits\s+4\s+66\.7%\s+2\s+content 2/.test(text) && /C model bump → m2\s+0\s+0\.0%\s+6\s+model 6/.test(text), "the scenario rows carry reuse, share, recompute and reasons");
  assert(/2 updates moved content, 1 of them the fingerprint; the log holds content for 1\/6 live thoughts/.test(text) && /1 thought\(s\) with 3 mention rows extracted before their fingerprint last moved — 0 queued for a re-read, 0 whose re-read failed \(terminal until --retry-failed\), 1 in no pool/.test(text), "the log's completeness and the stale graph, pool state included, are stated");
  assert(/per row: median 3\.00 s, mean 4\.00 s; 1\.000 s per 1k chars; 1 fell back/.test(text) && /worst \(C, 6 rows\): 24\.0 s by rows, 20\.7 s by characters/.test(text), "the cost lines carry the sample's numbers and the corpus's extrapolation");
  assert(/extract:x@p1\s+n\s+6\s+median\s+30\.0 s\/row\s+→ 6 thoughts ≈ 0\.1 h sequential/.test(text), "the graph's own cost from the log");
  assert(/^verdict: GO$/m.test(text), "the verdict line");
  const noCost = renderReport({ ...o, samples: null, cost: null, provider: null, verdict: verdict(ideal, null) });
  assert(/cost — not measured this run/.test(noCost) && /verdict: GO \(provisional\)/.test(noCost), "without a provider the report says the cost is unmeasured and the verdict provisional");

  console.log("[8] The argument rules");
  assert(argumentProblem([]) === null && argumentProblem(["--self-check"]) === null && argumentProblem(["--no-provider", "--sample", "7", "--edit", "3", "--json", "o.json"]) === null, "the shapes that run");
  assert(/^unknown argument bogus/.test(argumentProblem(["bogus"]) ?? "") && /^unknown argument --gate/.test(argumentProblem(["--gate"]) ?? ""), "a stray word and a flag from another eval are refused by name");
  assert(/needs a value/.test(argumentProblem(["--sample"]) ?? "") && /needs a value/.test(argumentProblem(["--sample", "--edit", "3"]) ?? ""), "a valued flag with no value, or another flag where the value should be");
  assert(/positive integer, not "x"/.test(argumentProblem(["--sample", "x"]) ?? "") && /positive integer, not "0"/.test(argumentProblem(["--edit", "0"]) ?? ""), "a count that is not a positive integer");
  assert(/given 2 times; a flag given twice would be read once/.test(argumentProblem(["--sample", "3", "--sample", "4"]) ?? ""), "a flag given twice is refused, not read once (SMD-1713 pass 3)");
  assert(/takes no other argument/.test(argumentProblem(["--self-check", "--no-provider"]) ?? ""), "--self-check stands alone");
  assert(MISSES.length === 4 && DEFAULT_SAMPLE === 21 && DEFAULT_EDITS === 10 && BUMPED_MODEL !== DEFAULT_EMBEDDING_MODEL, "the defaults, and the bumped name is not the shipped model's");

  report();
}

if (import.meta.main) {
  loadEnv();
  const problem = argumentProblem(args);
  if (problem) { console.error(problem); process.exit(2); }
  if (has("--self-check")) selfCheck();
  else await run();
}
