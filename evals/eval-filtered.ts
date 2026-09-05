#!/usr/bin/env bun
/**
 * eval-filtered.ts — what a filtered `match_thoughts` call returns on real
 * data, before and after migration 014.
 *
 * SMD-968: `match_thoughts` chose its candidates first and applied the metadata
 * filter afterwards, so a filter matching a small share of the corpus saw a
 * small share of 40 candidates. db/bench-hnsw.ts shows the mechanism on random
 * vectors. This asks whether it matters on the corpus the fork's other numbers
 * come from — 441 real issues with their real labels — using the function as
 * deployed, in a real Postgres, with the rows stored the way the server stores
 * them (whole-content vector plus bare windows for the long ones).
 *
 * Who sends a filter: not the server's own `search_thoughts`, whose input has
 * no filter and which passes `{}` on every call. The filter argument is reached
 * by direct SQL, by PostgREST RPC callers, and by community code — the
 * enhanced-mcp integration's `metadata_filter`, the local-brain recipe's search
 * function. This eval measures the function they call.
 *
 * ── The task, and why it is not "title finds its document" ──────────────────
 *
 * Every retrieval eval here so far asks whether a document's title retrieves
 * that document. Under a filter that question is nearly meaningless: the target
 * is the global nearest neighbour of its own title (MRR 0.90 on this corpus),
 * and the first 40 candidates always contain the global nearest neighbour, so
 * no post-filter can lose it. A harness built on that would report the defect
 * as harmless. The first draft of the synthetic bench did exactly that.
 *
 * The query a filter exists for is different: "things about X among my `portal`
 * issues", where the best `portal` match is NOT the global best match. So:
 *
 *   OTHER-LABEL  the query is a document's title; the filter is a label that
 *                document does NOT carry. The right answer is the exact top-10
 *                within the label — computed here in JavaScript from the same
 *                vectors, MAX over a document's whole vector and its windows,
 *                which is the function's own scoring rule with no index in the
 *                way. Reported: rows returned of 10 asked, overlap with the
 *                exact top-10, and how often the result was empty.
 *
 *   OWN-LABEL    the same query, filtered to the rarest label the target DOES
 *                carry. This is the flattering case, kept as a control: the
 *                target's rank should be unchanged, and the REST of the list —
 *                the other nine rows — is where the two arms differ.
 *
 *   UNFILTERED   every query with `{}`. Must be identical before and after,
 *                row for row; the run fails if it is not, because "the default
 *                path did not change" is the claim 014 makes about itself.
 *
 * Filters are the corpus's real labels at four sizes (~36%, ~14%, ~4.5%, ~2.7%
 * of documents) plus two seeded synthetic tiers at 10% and 2%, so the effect
 * can be read against selectivity on labels that mean something and on labels
 * that are pure chance.
 *
 * ── Data handling ────────────────────────────────────────────────────────────
 * The corpus is internal engineering data. It is read from outside the
 * repository, goes only to a local Ollama and a throwaway local Postgres, and
 * the embedding cache written beside it is exactly as sensitive as it is —
 * the script refuses to put either inside the repo, and refuses a database
 * host that is not loopback, because it drops the schema it is pointed at.
 *
 *   ../db/with-postgres.sh bun eval-filtered.ts
 *   OB1_EVAL_EMBED=embeddinggemma ../db/with-postgres.sh bun eval-filtered.ts
 */

import { SQL } from "bun";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkContent, DEFAULT_MAX_TOKENS } from "../server-portable/chunk.ts";
import { BOUNDS_IN_FORCE_SQL, DEFAULT_EMBEDDING_MODEL } from "../db/config.mjs";
import { applyMigrations, assertThrowawayDatabase, requireDatabaseUrl, resetSchema, seededRandom } from "../db/test-support.ts";
import { embed, cosine, parseSpec } from "./lib.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = process.env.OB1_EVAL_CORPUS ?? "/tmp/linear-corpus-full.json";
const EMBED_MODEL = process.env.OB1_EVAL_EMBED ?? `${DEFAULT_EMBEDDING_MODEL}@1024`;
const CACHE = process.env.OB1_EVAL_EMBED_CACHE ?? "/tmp/ob1-filtered-embed-cache.json";
/** Queries per filter in the other-label arm. 0 means every eligible document. */
const PER_FILTER = Number(process.env.OB1_EVAL_PER_FILTER ?? 60);
const K = 10;

for (const [what, p] of [["corpus", CORPUS], ["embedding cache", CACHE]] as const) {
  if (resolve(p).startsWith(REPO_ROOT + "/")) {
    console.error(`Refusing to use a ${what} inside the repository: ${p}. Keep it in /tmp.`);
    process.exit(2);
  }
}
const DB_URL = requireDatabaseUrl("evals/eval-filtered.ts");
// dropSchema enforces this too; checking here fails before the embedding work.
assertThrowawayDatabase(DB_URL);

/**
 * Read and parse a JSON file, telling a missing file apart from a broken one.
 * "Cannot read the corpus, build it" is the wrong advice for a corpus that
 * exists and was truncated by a build that died mid-write; that needs the parse
 * error, not a hint to run the builder again.
 */
async function readJson<T>(path: string): Promise<{ ok: true; value: T } | { ok: false; missing: boolean; error: string }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { ok: false, missing: true, error: "no such file" };
  try {
    return { ok: true, value: JSON.parse(await file.text()) as T };
  } catch (e) {
    return { ok: false, missing: false, error: (e as Error).message };
  }
}

type Item = { id: string; title: string; text: string; labels: string[] };
const corpus = await readJson<Item[]>(CORPUS);
if (!corpus.ok) {
  if (corpus.missing) console.error(`No corpus at ${CORPUS}. Build it with \`bun build-linear-corpus.ts\` (output stays in /tmp).`);
  else console.error(`The corpus at ${CORPUS} exists but does not parse: ${corpus.error}\nRebuild it rather than trusting a partial file.`);
  process.exit(2);
}
const ITEMS = corpus.value;

// ── Embeddings, cached ──────────────────────────────────────────────────────
//
// One write, at the end. A periodic rewrite of the whole cache on the embedding
// path costs O(n^2) bytes and, being non-atomic, can leave a truncated file
// that the next run would mistake for an empty one.

const spec = parseSpec(EMBED_MODEL);
const DIM = spec.dims ?? Number(process.env.OB1_EMBEDDING_DIM ?? 1024);
const cached = await readJson<Record<string, number[]>>(CACHE);
if (!cached.ok && !cached.missing) {
  console.error(`The embedding cache at ${CACHE} exists but does not parse: ${cached.error}`);
  console.error("Refusing to overwrite it. Move it aside (or delete it) and run again.");
  process.exit(2);
}
const cache: Record<string, number[]> = cached.ok ? cached.value : {};
let cacheDirty = false;
async function vec(text: string, isQuery = false): Promise<number[]> {
  const key = `${EMBED_MODEL}|${isQuery ? "q" : "d"}|${createHash("sha256").update(text).digest("hex")}`;
  if (cache[key]) return cache[key];
  const v = await embed(EMBED_MODEL, text, isQuery);
  cache[key] = v;
  cacheDirty = true;
  return v;
}

// ── Documents, with seeded synthetic tiers ──────────────────────────────────

const { rnd } = seededRandom(968);
type Doc = Item & { tiers: string[]; whole: number[]; windowText: string[]; windows: number[][]; query: number[] };

process.stdout.write(`  embedding ${ITEMS.length} documents with ${EMBED_MODEL}`);
const DOCS: Doc[] = [];
for (const it of ITEMS) {
  const r = rnd();
  const tiers = [r < 0.1 ? "t10" : null, r < 0.02 ? "t2" : null].filter((x): x is string => !!x);
  const windowText = chunkContent(it.text, { maxTokens: DEFAULT_MAX_TOKENS }).map((c) => c.content);
  DOCS.push({
    ...it,
    tiers,
    whole: await vec(it.text),
    windowText,
    windows: await Promise.all(windowText.map((w) => vec(w))),
    query: await vec(it.title, true),
  });
  if (DOCS.length % 50 === 0) process.stdout.write(".");
}
if (cacheDirty) await Bun.write(CACHE, JSON.stringify(cache));
console.log(` done (${DOCS.filter((d) => d.windows.length).length} chunk)`);

/** The function's scoring rule, exactly: MAX over the whole vector and every window. */
const score = (q: number[], d: Doc) => Math.max(cosine(q, d.whole), ...d.windows.map((w) => cosine(q, w)));

// ── Filters ─────────────────────────────────────────────────────────────────

type Filter = { name: string; json: Record<string, unknown>; member: (d: Doc) => boolean };
const labelFilter = (l: string): Filter => ({ name: l, json: { labels: [l] }, member: (d) => d.labels.includes(l) });
const tierFilter = (t: string): Filter => ({ name: t, json: { tiers: [t] }, member: (d) => d.tiers.includes(t) });
const FILTERS: Filter[] = ["api", "web", "portal", "design"].map(labelFilter).concat(["t10", "t2"].map(tierFilter));

// ── Load Postgres the way the server would ──────────────────────────────────

const lit = (v: number[]) => `[${v.join(",")}]`;
console.log(`  loading Postgres via upsert_thought (whole vector + ${DOCS.reduce((n, d) => n + d.windows.length, 0)} windows)`);
await resetSchema(DB_URL, { dim: DIM, model: spec.name, only: (f) => f < "014" });
let sql = new SQL({ url: DB_URL, max: 1 });
for (const d of DOCS) {
  const payload = { metadata: { ref: d.id, labels: d.labels, tiers: d.tiers } };
  const chunks = d.windows.map((w, i) => ({ content: d.windowText[i], embedding: lit(w) }));
  await sql`SELECT upsert_thought(${d.text}, ${payload}::jsonb, ${lit(d.whole)}::vector, ${chunks}::jsonb)`;
}
await sql.unsafe("VACUUM ANALYZE thoughts");
await sql.unsafe("VACUUM ANALYZE thought_chunks");

/**
 * upsert_thought de-duplicates on a content fingerprint, so two documents with
 * the same normalised text become one row. Those cannot be scored by ref and are
 * dropped from every arm — reported, not hidden.
 */
const stored = new Map<string, string>();
for (const r of await sql`SELECT id, metadata->>'ref' AS ref FROM thoughts`) stored.set(String(r.ref), String(r.id));
const EVAL = DOCS.filter((d) => stored.has(d.id));
if (EVAL.length < DOCS.length) console.log(`  ${DOCS.length - EVAL.length} documents collapsed by the content fingerprint and are excluded`);

// ── The question set, built once ────────────────────────────────────────────
//
// Both arms answer the same questions against the same exact answers. The
// answers depend only on the corpus, so they are computed here, not per arm.

/** Pick a deterministic, evenly spaced sample of the eligible queries. */
function sample<T>(xs: T[], n: number): T[] {
  if (!n || xs.length <= n) return xs;
  const step = xs.length / n;
  return Array.from({ length: n }, (_, i) => xs[Math.floor(i * step)]);
}
const exactTop = (q: number[], members: Doc[]) =>
  new Set(members.map((m) => ({ id: m.id, s: score(q, m) })).sort((a, b) => b.s - a.s).slice(0, K).map((x) => x.id));

type OtherQ = { filter: Filter; doc: Doc; want: Set<string> };
const OTHER: OtherQ[] = [];
for (const f of FILTERS) {
  const members = EVAL.filter(f.member);
  for (const doc of sample(EVAL.filter((d) => !f.member(d)), PER_FILTER)) OTHER.push({ filter: f, doc, want: exactTop(doc.query, members) });
}

type OwnQ = { doc: Doc; label: string; want: Set<string> };
const OWN: OwnQ[] = [];
{
  const freq = new Map<string, number>();
  for (const d of EVAL) for (const l of d.labels) freq.set(l, (freq.get(l) ?? 0) + 1);
  for (const doc of EVAL) {
    if (!doc.labels.length) continue;
    const label = [...doc.labels].sort((a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0))[0];
    OWN.push({ doc, label, want: exactTop(doc.query, EVAL.filter((m) => m.labels.includes(label))) });
  }
}
// A corpus with no labelled documents — an export whose issues carry
// `labels: []`, which build-linear-corpus.ts does not refuse — would sail
// through: the row-identity control passes on 0 of 0, and every table below
// prints NaN as a measurement, exit 0 (tenth review pass). Refuse instead.
if (!EVAL.length || !OTHER.length || !OWN.length) {
  console.error(`  nothing to measure: ${EVAL.length} stored documents, ${OTHER.length} other-label queries, ${OWN.length} own-label queries — the corpus needs labelled issues`);
  process.exit(2);
}

// ── The arms ────────────────────────────────────────────────────────────────

async function search(q: number[], filter: Record<string, unknown>): Promise<string[]> {
  const rows = await sql`SELECT metadata->>'ref' AS ref FROM match_thoughts(${lit(q)}::vector, -1.0, ${K}, ${filter}::jsonb)`;
  return rows.map((r: { ref: string }) => String(r.ref));
}

type Other = { filter: string; returned: number; overlap: number };
type Own = { rank: number; returned: number; overlap: number };
type Run = { unfiltered: Map<string, string[]>; other: Other[]; own: Own[] };

async function run(label: string): Promise<Run> {
  process.stdout.write(`  ${label.padEnd(18)}`);
  const unfiltered = new Map<string, string[]>();
  for (const d of EVAL) unfiltered.set(d.id, await search(d.query, {}));
  process.stdout.write(".");

  const other: Other[] = [];
  for (const { filter, doc, want } of OTHER) {
    const got = await search(doc.query, filter.json);
    other.push({ filter: filter.name, returned: got.length, overlap: got.filter((id) => want.has(id)).length });
  }
  process.stdout.write(".");

  const own: Own[] = [];
  for (const { doc, label, want } of OWN) {
    const got = await search(doc.query, { labels: [label] });
    own.push({ rank: got.indexOf(doc.id) + 1, returned: got.length, overlap: got.filter((id) => want.has(id)).length });
  }
  console.log(" done");
  return { unfiltered, other, own };
}

const before = await run("before (001–013)");
await applyMigrations(DB_URL, { dim: DIM, model: spec.name, only: (f) => f.startsWith("014") });
// 014 seeds the walk's bounds at DATABASE level, read at session start: a
// session opened before it keeps pgvector's defaults. Reconnect, and say what
// the after arm actually ran under.
await sql.close();
sql = new SQL({ url: DB_URL, max: 1 });
{
  const bounds = await sql.unsafe(BOUNDS_IN_FORCE_SQL);
  console.log(`  after arm runs with ${bounds.map((r: { name: string; value: string | null }) => `${r.name}=${r.value}`).join(", ")}`);
}
const after = await run("after (014)");
await sql.close();

// ── The control: the unfiltered path did not move ───────────────────────────

let moved = 0;
for (const d of EVAL) if (before.unfiltered.get(d.id)!.join() !== after.unfiltered.get(d.id)!.join()) moved++;
console.log(`\n  unfiltered control: ${EVAL.length - moved}/${EVAL.length} queries return identical rows before and after`);
if (moved) {
  console.error("  The unfiltered path changed. 014 claims it does not; nothing below is trustworthy until that is understood.");
  process.exit(1);
}
const mrr = (ranks: number[]) => (ranks.length ? ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length : NaN);
const unfilteredRank = (r: Run) => EVAL.map((d) => r.unfiltered.get(d.id)!.indexOf(d.id) + 1);
console.log(`  unfiltered title→document MRR ${mrr(unfilteredRank(after)).toFixed(3)} (the eval-real number, as a sanity check)`);

// ── Report ──────────────────────────────────────────────────────────────────

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

console.log(`\n### Other-label: filtered to a label the query's document does NOT carry (${K} asked)\n`);
console.log("| filter | share | n | arm | returned | in exact top-10 | empty |");
console.log("| --- | ---: | ---: | --- | ---: | ---: | ---: |");
for (const f of FILTERS) {
  const share = ((100 * EVAL.filter(f.member).length) / EVAL.length).toFixed(1) + "%";
  for (const [arm, r] of [["before", before], ["after", after]] as const) {
    const rows = r.other.filter((o) => o.filter === f.name);
    console.log(
      `| ${f.name} | ${share} | ${rows.length} | ${arm} | ${mean(rows.map((o) => o.returned)).toFixed(1)} | ${mean(rows.map((o) => o.overlap)).toFixed(1)} | ${rows.filter((o) => o.returned === 0).length} |`
    );
  }
}
{
  const pairs = before.other.map((b, i) => [b, after.other[i]] as const);
  const helped = pairs.filter(([b, a]) => a.overlap > b.overlap).length;
  const hurt = pairs.filter(([b, a]) => a.overlap < b.overlap).length;
  console.log(`\n  paired: 014 improved overlap on ${helped}, worsened it on ${hurt}, of ${pairs.length} queries`);
}

console.log(`\n### Own-label: filtered to the rarest label the document DOES carry\n`);
console.log("| arm | n | target MRR | target in top-10 | returned | list overlap with exact top-10 |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const [arm, r] of [["before", before], ["after", after]] as const) {
  console.log(
    `| ${arm} | ${r.own.length} | ${mrr(r.own.map((o) => o.rank)).toFixed(3)} | ${r.own.filter((o) => o.rank > 0).length}/${r.own.length} | ${mean(r.own.map((o) => o.returned)).toFixed(1)} | ${mean(r.own.map((o) => o.overlap)).toFixed(1)} |`
  );
}
{
  const pairs = before.own.map((b, i) => [b, after.own[i]] as const);
  const rankMoved = pairs.filter(([b, a]) => a.rank !== b.rank).length;
  const helped = pairs.filter(([b, a]) => a.overlap > b.overlap).length;
  const hurt = pairs.filter(([b, a]) => a.overlap < b.overlap).length;
  console.log(`\n  paired: target rank changed on ${rankMoved} queries; list overlap improved on ${helped}, worsened on ${hurt}`);
}
console.log();
