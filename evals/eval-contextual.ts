#!/usr/bin/env bun
/**
 * eval-contextual.ts — does situating a chunk in its document improve retrieval?
 *
 * Anthropic's Contextual Retrieval (September 2024) prepends a short generated
 * blurb to each chunk before embedding it, so a window reading "revenue grew 3%
 * over the previous quarter" carries which company and which quarter into its
 * vector. They report roughly a 35% reduction in top-20 retrieval failure. Those
 * are their numbers on their corpora; this fork's standing rule is that a claim
 * gets measured here before it ships, and this is that measurement.
 *
 * ── What this harness exists to avoid ────────────────────────────────────────
 *
 * `eval-real.ts` embeds each document with ONE call and compares one vector per
 * document. That is not what the server stores for a long capture, and the
 * difference is the whole subject of this file. For content over the chunking
 * threshold, `embedCapture` in server-portable/index.ts:
 *
 *   * splits the content into overlapping windows,
 *   * embeds each window,
 *   * stores the FIRST WINDOW's vector as `thoughts.embedding` — deliberately,
 *     so that column never holds a provider-truncated vector,
 *   * stores every window in `thought_chunks`,
 *
 * and `match_thoughts` scores a thought as MAX over its own vector and all of
 * its chunk vectors. So for a chunked document the whole-document vector that
 * `eval-real.ts` measures is never computed by the server at all. Reporting a
 * contextual-retrieval delta against that baseline would be comparing a change
 * to a system that does not exist.
 *
 * ── The arms ─────────────────────────────────────────────────────────────────
 *
 *   whole          one vector for the whole text. The pre-007 server, and what
 *                  eval-real.ts still measures.
 *   windows        MAX over bare window vectors. What the server stored before
 *                  change 27, and the baseline every row is measured against.
 *                  `whole+chunks` is what it stores now — this harness is what
 *                  changed it, so the deltas are all from the older behaviour.
 *   ctx-doc        MAX over windows each prefixed with ONE blurb describing the
 *                  document. One LLM call per document.
 *   ctx-chunk      MAX over windows each prefixed with its OWN blurb. One LLM
 *                  call per chunk — Anthropic's method, and the expensive one.
 *   ctx-tight      the same, with a 20-word budget and a banned opener. It
 *                  exists because the first run's blurbs ran to a median of 388
 *                  characters and every one of them opened "This chunk
 *                  outlines" — length dilutes the window, and a shared opening
 *                  is identical text in front of every chunk in the corpus.
 *   whole+chunks   MAX over the whole-text vector and the bare windows.
 *   whole+tight    MAX over the whole-text vector and the 20-word contextual
 *                  windows.
 *   whole+ctx      MAX over the whole-text vector and the per-chunk contextual
 *                  windows: keep the long-document vector as well.
 *
 * Only chunked documents differ between arms. Everything else in the corpus is
 * embedded once and shared, so the 426 unchunked documents are a real control:
 * their vectors are identical in every arm, and any movement in their score is a
 * chunked document changing rank around them.
 *
 * ── Reporting ────────────────────────────────────────────────────────────────
 *
 * Scores are reported over the chunked subset SEPARATELY from the corpus. On
 * this corpus 15 of 441 documents chunk — 3.4% — so a whole-corpus average
 * cannot move enough to distinguish a real effect from noise, and quoting one
 * would either bury a genuine improvement or manufacture a fake one.
 *
 *   ../db/with-postgres.sh is NOT needed — this touches no database.
 *   bun eval-contextual.ts                       # defaults from db/config.mjs
 *   OB1_EVAL_EMBED=embeddinggemma bun eval-contextual.ts
 *
 * Needs a running Ollama. The corpus is internal engineering data and stays on
 * this machine: nothing here writes inside the repository, and the blurb cache
 * lives beside the corpus in /tmp.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkContent, DEFAULT_MAX_TOKENS } from "../server-portable/chunk.ts";
import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_METADATA_MODEL,
  CHUNK_CONTEXT_PROMPTS,
  composeChunkForEmbedding,
  usableChunkContext,
} from "../db/config.mjs";
import { embed, cosine, EVAL_BASE, EVAL_HEADERS } from "./lib.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CORPUS = process.env.OB1_EVAL_CORPUS ?? "/tmp/linear-corpus-full.json";
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? `${DEFAULT_EMBEDDING_MODEL}@1024`;
const CTX_MODEL = process.env.OB1_EVAL_CTX_MODEL ?? DEFAULT_METADATA_MODEL;
const CHUNK_TOKENS = Number(process.env.OB1_CHUNK_TOKENS) || DEFAULT_MAX_TOKENS;

/**
 * The corpus never enters the repository, and neither does anything derived from
 * it. `build-linear-corpus.ts` enforces that on the way in; this enforces it on
 * the way out, because a cache of generated blurbs is generated FROM that data
 * and is exactly as sensitive as the data.
 */
if (resolve(CORPUS).startsWith(REPO_ROOT + "/")) {
  console.error(`Refusing to read a corpus inside the repository: ${CORPUS}`);
  console.error("The corpus is internal data and stays out of git. Keep it in /tmp.");
  process.exit(2);
}
const CACHE = process.env.OB1_EVAL_CTX_CACHE ?? "/tmp/ob1-contextual-cache.json";
if (resolve(CACHE).startsWith(REPO_ROOT + "/")) {
  console.error(`Refusing to write the blurb cache inside the repository: ${CACHE}`);
  process.exit(2);
}

type Item = { id: string; title: string; text: string; labels: string[] };
const ITEMS: Item[] = JSON.parse(await Bun.file(CORPUS).text());

type Doc = Item & { windows: string[] };
const DOCS: Doc[] = ITEMS.map((it) => ({
  ...it,
  windows: chunkContent(it.text, { maxTokens: CHUNK_TOKENS }).map((w) => w.content),
}));
const CHUNKED = DOCS.filter((d) => d.windows.length > 0);
const PLAIN = DOCS.filter((d) => d.windows.length === 0);

if (CHUNKED.length === 0) {
  console.error(
    `No document in ${CORPUS} reaches the ${CHUNK_TOKENS}-token chunking threshold, so there is ` +
      `nothing for this harness to measure. The truncated 97-document corpus had this problem; ` +
      `rebuild with evals/build-linear-corpus.ts.`
  );
  process.exit(2);
}

// ── Does this model even truncate? ───────────────────────────────────────────
/**
 * The `whole` arm is only an honest baseline if the provider actually reads the
 * whole document. Migration 007 was written against a 2048-token batch, which is
 * a property of the MODEL rather than of Ollama: measure it rather than assume
 * it, by finding the shortest prefix that embeds to a bit-identical vector.
 *
 * No tokeniser is involved, deliberately, for the same reason chunk.ts refuses
 * one: it would tie this to a model family.
 */
async function providerCeiling(text: string): Promise<{ chars: number; truncates: boolean }> {
  const full = await embed(EMBED_MODEL, text);
  const same = (a: number[], b: number[]): boolean => a.every((x, i) => x === b[i]);
  const appended = await embed(EMBED_MODEL, `${text}\n\nOne more sentence, added at the very end.`);
  if (!same(full, appended)) return { chars: text.length, truncates: false };
  let lo = 0;
  let hi = text.length;
  while (hi - lo > 250) {
    const mid = Math.floor((lo + hi) / 2);
    if (same(await embed(EMBED_MODEL, text.slice(0, mid)), full)) hi = mid;
    else lo = mid;
  }
  return { chars: hi, truncates: true };
}

const longest = CHUNKED.reduce((a, b) => (a.text.length > b.text.length ? a : b));
const ceiling = await providerCeiling(longest.text);

// ── Contextual blurbs ────────────────────────────────────────────────────────

type Cache = Record<string, string>;
let cache: Cache = {};
try {
  cache = JSON.parse(await Bun.file(CACHE).text()) as Cache;
} catch {
  cache = {};
}
let cacheDirty = false;

let llmCalls = 0;
let llmMs = 0;
let llmFailures = 0;

/** One chat completion. Returns "" on any failure — the caller counts those. */
async function complete(prompt: string): Promise<string> {
  const t0 = Date.now();
  llmCalls++;
  try {
    const r = await fetch(`${EVAL_BASE}/chat/completions`, {
      method: "POST",
      headers: EVAL_HEADERS,
      body: JSON.stringify({
        model: CTX_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      llmFailures++;
      return "";
    }
    const body = (await r.json()) as { choices?: [{ message?: { content?: string } }] };
    const out = (body.choices?.[0]?.message?.content ?? "").trim();
    if (!out) llmFailures++;
    return out;
  } catch {
    llmFailures++;
    return "";
  } finally {
    llmMs += Date.now() - t0;
  }
}

let rejected = 0;
async function blurb(key: string, prompt: string, target: string): Promise<string> {
  const cacheKey = `${CTX_MODEL}::${key}`;
  if (!(cacheKey in cache)) {
    cache[cacheKey] = await complete(prompt);
    cacheDirty = true;
  }
  const out = cache[cacheKey];
  if (!usableChunkContext(out, target)) {
    rejected++;
    return "";
  }
  return out;
}

process.stderr.write(`  … generating blurbs with ${CTX_MODEL}\n`);

/** Per-document blurbs — the cheap arm: one call, reused for every window. */
const docBlurb: Record<string, string> = {};
for (const d of CHUNKED) {
  docBlurb[d.id] = await blurb(
    `doc::${d.id}`,
    CHUNK_CONTEXT_PROMPTS.document.replace("{document}", d.text),
    d.text
  );
}

/** Per-chunk blurbs — Anthropic's method: the whole document in every prompt. */
const chunkBlurb: Record<string, string[]> = {};
for (const d of CHUNKED) {
  chunkBlurb[d.id] = [];
  for (let i = 0; i < d.windows.length; i++) {
    chunkBlurb[d.id].push(
      await blurb(
        `chunk::${d.id}::${i}`,
        CHUNK_CONTEXT_PROMPTS.chunk.replace("{document}", d.text).replace("{chunk}", d.windows[i]),
        d.windows[i]
      )
    );
  }
}

/** The same per-window call with a word budget and a banned opener. */
const tightBlurb: Record<string, string[]> = {};
for (const d of CHUNKED) {
  tightBlurb[d.id] = [];
  for (let i = 0; i < d.windows.length; i++) {
    tightBlurb[d.id].push(
      await blurb(
        `tight::${d.id}::${i}`,
        CHUNK_CONTEXT_PROMPTS.chunkTight.replace("{document}", d.text).replace("{chunk}", d.windows[i]),
        d.windows[i]
      )
    );
  }
}

if (cacheDirty) await Bun.write(CACHE, JSON.stringify(cache));

// ── Embeddings ───────────────────────────────────────────────────────────────

process.stderr.write(`  … embedding with ${EMBED_MODEL}\n`);

const t0 = Date.now();
/** Whole-text vector for every document. Shared by `whole` and the controls. */
const whole: Record<string, number[]> = {};
for (const d of DOCS) whole[d.id] = await embed(EMBED_MODEL, d.text);

/** Window vectors, per arm, for the chunked documents only. */
const bareVecs: Record<string, number[][]> = {};
const ctxDocVecs: Record<string, number[][]> = {};
const ctxChunkVecs: Record<string, number[][]> = {};
const ctxTightVecs: Record<string, number[][]> = {};
for (const d of CHUNKED) {
  bareVecs[d.id] = [];
  ctxDocVecs[d.id] = [];
  ctxChunkVecs[d.id] = [];
  ctxTightVecs[d.id] = [];
  for (let i = 0; i < d.windows.length; i++) {
    const w = d.windows[i];
    bareVecs[d.id].push(await embed(EMBED_MODEL, w));
    ctxDocVecs[d.id].push(await embed(EMBED_MODEL, composeChunkForEmbedding(docBlurb[d.id], w)));
    ctxChunkVecs[d.id].push(await embed(EMBED_MODEL, composeChunkForEmbedding(chunkBlurb[d.id][i], w)));
    ctxTightVecs[d.id].push(await embed(EMBED_MODEL, composeChunkForEmbedding(tightBlurb[d.id][i], w)));
  }
}

/** Queries: the issue title, which build-linear-corpus.ts keeps out of the text. */
const queries: Record<string, number[]> = {};
for (const d of DOCS) queries[d.id] = await embed(EMBED_MODEL, d.title, true);
const embedSeconds = (Date.now() - t0) / 1000;

// ── The task that can actually discriminate ──────────────────────────────────
/**
 * A title is a description of a whole document, so a title query is answered
 * best by a whole-document vector — which means the table above cannot separate
 * these arms no matter what contextualization does. It is kept as the control
 * that the change costs nothing on ordinary queries, not as the measurement.
 *
 * The query contextual retrieval exists for names the SUBJECT and asks for a
 * DETAIL that lives in one window: "how long is the rollback window we agreed
 * for the payments service?", where the window says "thirty minutes, anything
 * longer needs sign-off" and never says "payments". A bare window cannot match
 * the subject half. A contextualized one can — that is the entire mechanism, and
 * it is what has to be measured.
 *
 * Generating these fairly is the delicate part:
 *
 *   The generator sees the TITLE and ONE WINDOW, never the document. The title
 *   is not in the document text (build-linear-corpus.ts keeps it out), so it
 *   cannot leak into a bare window's vector — and the blurb, which is generated
 *   from the text alone, has to recover the subject independently to compete.
 *
 *   The detail half comes from the window itself, which hands the BARE arm the
 *   strongest advantage available. That is deliberate: this harness should be
 *   biased against the change it is testing, so a win means something.
 */
const detailPrompt = (title: string, chunk: string): string =>
  `A colleague is searching an internal notes system for the excerpt below, which comes from a ` +
  `document titled "${title}".\n\n<excerpt>\n${chunk}\n</excerpt>\n\n` +
  `Write the one-sentence question they would type. It must name what the document is about AND ` +
  `ask for a specific detail found only in this excerpt. Do not quote the excerpt. Answer with ` +
  `the question and nothing else.`;

type Detail = { docId: string; window: number; text: string };
const DETAILS: Detail[] = [];
for (const d of CHUNKED) {
  for (let i = 0; i < d.windows.length; i++) {
    const key = `detail::${d.id}::${i}`;
    if (!(key in cache)) {
      cache[key] = await complete(detailPrompt(d.title, d.windows[i]));
      cacheDirty = true;
    }
    const q = cache[key];
    if (q) DETAILS.push({ docId: d.id, window: i, text: q });
  }
}
if (cacheDirty) await Bun.write(CACHE, JSON.stringify(cache));

const detailVecs: number[][] = [];
for (const q of DETAILS) detailVecs.push(await embed(EMBED_MODEL, q.text, true));

// ── Arms ─────────────────────────────────────────────────────────────────────

/**
 * Every delta is measured from the bare windows, which is what the server stored
 * before this harness changed its mind. `whole+chunks` is what it stores now:
 * the row to read for "would turning contextualization on help TODAY" is that
 * one against the ctx rows, not the baseline against them.
 */
const BASELINE = "windows";

type Arm = { name: string; note: string; score: (d: Doc, q: number[]) => number };
const max = (xs: number[]): number => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

const ARMS: Arm[] = [
  { name: "whole", note: "one vector, whole text (pre-007)",
    score: (d, q) => cosine(q, whole[d.id]) },
  { name: "windows", note: "bare windows only (the server before change 27)",
    score: (d, q) => (d.windows.length ? max(bareVecs[d.id].map((v) => cosine(q, v))) : cosine(q, whole[d.id])) },
  { name: "whole+chunks", note: "whole text AND bare windows — THE SERVER TODAY",
    score: (d, q) => Math.max(cosine(q, whole[d.id]),
      d.windows.length ? max(bareVecs[d.id].map((v) => cosine(q, v))) : -Infinity) },
  { name: "ctx-doc", note: "one blurb per document, prepended to every window",
    score: (d, q) => (d.windows.length ? max(ctxDocVecs[d.id].map((v) => cosine(q, v))) : cosine(q, whole[d.id])) },
  { name: "ctx-chunk", note: "a blurb per window (Anthropic)",
    score: (d, q) => (d.windows.length ? max(ctxChunkVecs[d.id].map((v) => cosine(q, v))) : cosine(q, whole[d.id])) },
  { name: "ctx-tight", note: "a 20-word blurb per window",
    score: (d, q) => (d.windows.length ? max(ctxTightVecs[d.id].map((v) => cosine(q, v))) : cosine(q, whole[d.id])) },
  { name: "whole+tight", note: "whole text AND 20-word-blurb windows",
    score: (d, q) => Math.max(cosine(q, whole[d.id]),
      d.windows.length ? max(ctxTightVecs[d.id].map((v) => cosine(q, v))) : -Infinity) },
  { name: "whole+ctx", note: "whole text AND contextual windows",
    score: (d, q) => Math.max(cosine(q, whole[d.id]),
      d.windows.length ? max(ctxChunkVecs[d.id].map((v) => cosine(q, v))) : -Infinity) },
];

type Score = { r1: number; r5: number; mrr: number; n: number };
function measure(arm: Arm, subset: Doc[]): Score {
  let h1 = 0;
  let h5 = 0;
  let mrr = 0;
  for (const target of subset) {
    const q = queries[target.id];
    const ranked = DOCS.map((d) => ({ id: d.id, s: arm.score(d, q) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((r) => r.id === target.id) + 1;
    if (rank === 1) h1++;
    if (rank <= 5) h5++;
    mrr += 1 / rank;
  }
  const n = subset.length;
  return { r1: h1 / n, r5: h5 / n, mrr: mrr / n, n };
}

const chunkedScores = ARMS.map((a) => ({ arm: a, s: measure(a, CHUNKED) }));
const plainScores = ARMS.map((a) => ({ arm: a, s: measure(a, PLAIN) }));

/**
 * The detail task, scored per query rather than per document, and kept as a
 * RANK PER QUERY rather than only an average.
 *
 * Thirty-seven queries is a small sample, and a difference in mean MRR across
 * one is easy to over-read: two arms separated by 0.03 may differ on a single
 * query. A paired count — how many queries each arm moved up, down, or not at
 * all against the baseline — says what an average cannot, and is the honest
 * statistic at this size.
 */
function detailRanks(arm: Arm): number[] {
  return DETAILS.map((q, i) => {
    const qv = detailVecs[i];
    const ranked = DOCS.map((d) => ({ id: d.id, s: arm.score(d, qv) })).sort((a, b) => b.s - a.s);
    return ranked.findIndex((r) => r.id === q.docId) + 1;
  });
}
const detailByArm = new Map<string, number[]>(ARMS.map((a) => [a.name, detailRanks(a)]));
const summarise = (ranks: number[]): Score => ({
  r1: ranks.filter((r) => r === 1).length / ranks.length,
  r5: ranks.filter((r) => r <= 5).length / ranks.length,
  mrr: ranks.reduce((s, r) => s + 1 / r, 0) / ranks.length,
  n: ranks.length,
});

// ── Report ───────────────────────────────────────────────────────────────────

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
console.log(`\n  corpus ${CORPUS.split("/").pop()} — ${DOCS.length} documents, embed ${EMBED_MODEL}`);
console.log(
  `  chunking at ${CHUNK_TOKENS} tokens splits ${CHUNKED.length} of ${DOCS.length} ` +
    `(${((CHUNKED.length / DOCS.length) * 100).toFixed(1)}%) into ${Object.values(bareVecs).flat().length} windows`
);
console.log(
  ceiling.truncates
    ? `  provider ceiling: ~${ceiling.chars} chars — a ${longest.text.length}-char document is CUT, so \`whole\` is a truncated vector`
    : `  provider ceiling: none found — ${EMBED_MODEL} read all ${longest.text.length} chars of the longest document`
);

console.log(`\n  ${CHUNKED.length} chunked documents — the subset any of this can affect\n`);
console.log(`  arm                R@1    R@5    MRR    vs ${BASELINE}`);
console.log("  " + "─".repeat(62));
const serverMrr = chunkedScores.find((r) => r.arm.name === BASELINE)!.s.mrr;
for (const { arm, s } of chunkedScores) {
  const d = s.mrr - serverMrr;
  const delta = arm.name === BASELINE ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(3)}`;
  console.log(
    `  ${arm.name.padEnd(15)} ${pct(s.r1).padStart(5)}  ${pct(s.r5).padStart(5)}  ` +
      `${s.mrr.toFixed(3)}  ${delta.padStart(9)}   ${arm.note}`
  );
}

console.log(
  `\n  ${DETAILS.length} detail queries — subject named by the title, answer inside one window\n`
);
console.log(`  arm                R@1    R@5    MRR    vs ${BASELINE}     helped  hurt  same`);
console.log("  " + "─".repeat(76));
const serverRanks = detailByArm.get(BASELINE)!;
for (const arm of ARMS) {
  const ranks = detailByArm.get(arm.name)!;
  const s = summarise(ranks);
  const d = s.mrr - summarise(serverRanks).mrr;
  const better = ranks.filter((r, i) => r < serverRanks[i]).length;
  const worse = ranks.filter((r, i) => r > serverRanks[i]).length;
  const same = ranks.length - better - worse;
  const delta = arm.name === BASELINE ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(3)}`;
  console.log(
    `  ${arm.name.padEnd(15)} ${pct(s.r1).padStart(5)}  ${pct(s.r5).padStart(5)}  ${s.mrr.toFixed(3)}  ` +
      `${delta.padStart(9)}   ${String(better).padStart(6)}  ${String(worse).padStart(4)}  ${String(same).padStart(4)}`
  );
}

console.log(`\n  ${PLAIN.length} unchunked documents — the control, nothing here is chunked\n`);
console.log("  arm                R@1    R@5    MRR");
console.log("  " + "─".repeat(42));
for (const { arm, s } of plainScores) {
  console.log(`  ${arm.name.padEnd(15)} ${pct(s.r1).padStart(5)}  ${pct(s.r5).padStart(5)}  ${s.mrr.toFixed(3)}`);
}

/**
 * Two things that would make the table above a lie, checked rather than assumed.
 *
 * The control must be flat where it cannot legitimately move: an unchunked
 * document's own vector is byte-identical in every arm, so its rank can only
 * change if a CHUNKED document moved past it. A control that moves a lot is not
 * a finding about contextual retrieval, it is a bug in this file.
 *
 * And a contextual arm must actually be contextual: if every blurb were rejected
 * or empty, `composeChunkForEmbedding` returns the bare window, every arm embeds
 * the same text, and the table would report a clean, meaningless wash.
 */
console.log("\n  controls");
const plainMrrs = plainScores.map((p) => p.s.mrr);
console.log(
  `    control spread ${(Math.max(...plainMrrs) - Math.min(...plainMrrs)).toFixed(4)} MRR ` +
    `across arms (chunked documents moving around the other ${PLAIN.length})`
);
const distinct = CHUNKED.filter((d) =>
  ctxChunkVecs[d.id].some((v, i) => v.some((x, j) => x !== bareVecs[d.id][i][j]))
).length;
console.log(`    ctx-chunk vectors differ from bare in ${distinct}/${CHUNKED.length} documents`);
console.log(
  `    blurbs: ${llmCalls} calls, ${(llmMs / Math.max(llmCalls, 1) / 1000).toFixed(1)}s each, ` +
    `${llmFailures} provider failures, ${rejected} rejected as unusable`
);
console.log(`    embedding: ${embedSeconds.toFixed(1)}s for ${Object.keys(queries).length * 2 + Object.values(bareVecs).flat().length * 3} calls`);

/**
 * WHY a contextual arm moves, rather than only that it did.
 *
 * A blurb can only change a ranking by changing the cosine between a query and
 * the window it is asking about. Measuring that directly separates the two
 * stories available for a drop: the blurb pulled the window AWAY from its own
 * query (dilution — the added words compete for a fixed-size vector), or it left
 * the window alone and merely moved other documents around it.
 *
 * Each detail query names the window it came from, so this is a paired
 * comparison on exactly the vector the query was written against.
 */
{
  const pairs = DETAILS.map((q, i) => {
    const bare = cosine(detailVecs[i], bareVecs[q.docId][q.window]);
    return {
      tight: cosine(detailVecs[i], ctxTightVecs[q.docId][q.window]) - bare,
      verbose: cosine(detailVecs[i], ctxChunkVecs[q.docId][q.window]) - bare,
    };
  });
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const down = (xs: number[]): number => xs.filter((x) => x < 0).length;
  const t = pairs.map((p) => p.tight);
  const v = pairs.map((p) => p.verbose);
  console.log(
    `    target-window similarity vs bare: 20-word ${mean(t) >= 0 ? "+" : ""}${mean(t).toFixed(4)} ` +
      `(lower on ${down(t)}/${t.length}), full ${mean(v) >= 0 ? "+" : ""}${mean(v).toFixed(4)} ` +
      `(lower on ${down(v)}/${v.length})`
  );
}

/**
 * The leak this task is prone to. The query is the issue title, and a blurb
 * summarising the document can arrive at the same words — which would make
 * contextualization look like it helps retrieval when what it did was restate
 * the query inside the answer. `build-linear-corpus.ts` keeps the title out of
 * the document text for exactly this reason, so any overlap here is the model's,
 * and worth knowing before the number is quoted.
 */
const stop = new Set(["the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "with", "that", "this", "it", "as", "at", "by", "be"]);
const words = (s: string): Set<string> =>
  new Set(s.toLowerCase().match(/[a-z0-9_-]{3,}/g)?.filter((w) => !stop.has(w)) ?? []);
let leaked = 0;
let totalBlurbs = 0;
for (const d of CHUNKED) {
  const tw = words(d.title);
  for (const b of chunkBlurb[d.id]) {
    if (!b) continue;
    totalBlurbs++;
    const bw = words(b);
    const shared = [...tw].filter((w) => bw.has(w)).length;
    if (tw.size > 0 && shared / tw.size >= 0.6) leaked++;
  }
}
console.log(
  `    title leak: ${leaked}/${totalBlurbs} per-chunk blurbs reproduce 60%+ of their document's title words` +
    (leaked > totalBlurbs * 0.3 ? "  ← treat ctx-* as an upper bound" : "")
);
