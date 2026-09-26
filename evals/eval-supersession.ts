#!/usr/bin/env bun
/**
 * eval-supersession.ts — does EXCLUDING a superseded thought from retrieval help,
 * on the kind of relevance task this fork measures against? (Linear SMD-1253.)
 *
 * Migration 025 records that one thought supersedes another. The ticket asks the
 * question 020's recency blend had to answer before it could ship: a supersedes
 * column no search reads buys nothing, so does retrieval EXCLUDE, DOWN-WEIGHT, or
 * merely LABEL superseded rows — and "that needs an eval… if the numbers do not
 * move, the ranking change does not ship and the column is labelling only."
 *
 * Why this eval is deterministic and needs no model
 *   eval-recency/eval-real measure ranking QUALITY on the real Linear corpus, and
 *   they document the trap that decides this ticket: "the right answer for a title
 *   is the issue itself, whatever its age, so this corpus cannot show recency
 *   HELPING." The same is true of supersession — a superseded thought is still
 *   topically about its subject, so on a TOPICAL relevance task removing it can
 *   only cost, never help. The supersession decision is therefore not a tuning
 *   question (what weight?) but a STRUCTURAL one (does removing the stale twin
 *   move the metric, and under which definition of "relevant"?), which a
 *   controlled corpus answers exactly and reproducibly. So this harness seeds a
 *   corpus through the REAL write path (upsert_thought, as 016's eval does),
 *   with a fixed RNG, and needs only Postgres — not an embedding provider or the
 *   internal corpus, neither of which a CI-like run has.
 *
 * The corpus
 *   T topics, each a distinct axis, so a topic's query is near its own documents
 *   and orthogonal to the rest. For each topic: one CURRENT document. For half
 *   the topics (chosen by the seed) also an OLDER document that the current one
 *   SUPERSEDES — both near the topic axis with independent small noise, so which
 *   one a query ranks higher is a genuine coin-flip, not rigged. This is exactly
 *   "a corpus containing a superseded chain, against the same corpus without one":
 *   the superseded twin is present for label-only and removed for exclude.
 *
 * The two policies, one query set, a TS oracle (no shipped signature changed)
 *   For each topic query, match_thoughts returns the ranked ids as shipped
 *   (label-only). Exclude is that same list with the superseded ids removed in
 *   TypeScript — so the ranking change is PRICED before any SQL is written for it,
 *   the way eval-recency prices its window against a sequential-scan oracle.
 *
 * Two definitions of "relevant", because the answer depends on it
 *   TOPICAL   — any document of the topic counts (the fork's title→body task).
 *   CURRENT   — only the current (non-superseded) document counts (the reader who
 *               wants today's answer, not last month's — the ticket's premise).
 *   Reported for each: MRR and R@1, label-only vs exclude, plus a CONTROL (on a
 *   corpus seeded with zero superseded twins the two policies are identical).
 *
 *   ../db/with-postgres.sh bun eval-supersession.ts     (bun run supersession)
 *   OB1_EVAL_TOPICS=48   OB1_EVAL_SEED=1253   tune the corpus (defaults shown)
 *   OB1_EVAL_PER_CLASS=48   the second section's topics per class (SMD-2255)
 *
 * The second section (SMD-2255, below) prices search_thoughts' opt-in
 * down-weight on the hybrid, with its own wider schema.
 */

import { SQL } from "bun";
import { requireDatabaseUrl, resetSchema, createAssert } from "../db/test-support.ts";

const URL_ = requireDatabaseUrl("eval-supersession.ts");
const DIM = Number(process.env.OB1_EVAL_DIM ?? 64);
const TOPICS = Number(process.env.OB1_EVAL_TOPICS ?? 48);
const SEED = Number(process.env.OB1_EVAL_SEED ?? 1253);
const MODEL = "eval-supersession";

/** mulberry32 — a tiny seeded PRNG, so the corpus (and the verdict) is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A unit-ish vector on `axis`, plus independent small noise on other axes. */
function nearAxis(axis: number, noise: number, rand: () => number): string {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  for (let i = 0; i < DIM; i++) if (i !== axis) v[i] = (rand() - 0.5) * 2 * noise;
  return `[${v.join(",")}]`;
}
function axisQuery(axis: number): string {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  return `[${v.join(",")}]`;
}

type Topic = { axis: number; current: string; superseded: string | null };

async function seedCorpus(sql: SQL, withTwins: boolean): Promise<Topic[]> {
  const rand = rng(SEED);
  const topics: Topic[] = [];
  for (let t = 0; t < TOPICS; t++) {
    const axis = t % DIM;
    const hasTwin = withTwins && t % 2 === 0; // half the topics, deterministically
    let superseded: string | null = null;
    if (hasTwin) {
      // The OLDER document must exist before the current one references it.
      superseded = ((await sql`
        SELECT upsert_thought(${`topic ${t} — the older version`},
          ${{ metadata: { type: "note", topic: `t${t}` } }}::jsonb,
          ${nearAxis(axis, 0.05, rand)}::vector) AS r`)[0].r as { id: string }).id;
    }
    const env: Record<string, unknown> = { metadata: { type: "note", topic: `t${t}` } };
    if (superseded) env.supersedes = superseded;
    const current = ((await sql`
      SELECT upsert_thought(${`topic ${t} — the current version`},
        ${env}::jsonb,
        ${nearAxis(axis, 0.05, rand)}::vector) AS r`)[0].r as { id: string }).id;
    topics.push({ axis, current, superseded });
  }
  return topics;
}

/** 1-based rank of the first id in `ranked` that is in `gold`; 0 if none. */
function rankOf(ranked: string[], gold: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (gold.has(ranked[i])) return i + 1;
  return 0;
}

type Metrics = { mrr: number; r1: number; n: number };
function score(rankings: { ranked: string[]; gold: Set<string> }[]): Metrics {
  let mrrSum = 0, r1 = 0;
  for (const { ranked, gold } of rankings) {
    const r = rankOf(ranked, gold);
    if (r > 0) mrrSum += 1 / r;
    if (r === 1) r1++;
  }
  const n = rankings.length;
  return { mrr: mrrSum / n, r1: r1 / n, n };
}

const { assert, report } = createAssert();

await resetSchema(URL_, { dim: DIM, model: MODEL });
const sql = new SQL({ url: URL_, max: 4 });

console.log(`\n  eval-supersession — ${TOPICS} topics, seed ${SEED}, DIM ${DIM}\n`);

// ── The corpus WITH superseded twins ─────────────────────────────────────────
const topics = await seedCorpus(sql, true);
const twinTopics = topics.filter((t) => t.superseded !== null);
const supersededIds = new Set(twinTopics.map((t) => t.superseded!));
console.log(`  seeded ${topics.length} topics, ${twinTopics.length} with a superseded twin (${supersededIds.size} superseded rows)\n`);

// One query per topic. Only the topics that HAVE a twin can distinguish the
// policies; measure over those (the rest are a null case, covered by the control).
const label: { ranked: string[]; goldTopical: Set<string>; goldCurrent: Set<string> }[] = [];
const exclude: typeof label = [];
for (const t of twinTopics) {
  const rows = await sql`
    SELECT id::text AS id FROM match_thoughts(${axisQuery(t.axis)}::vector, -1.0, 10, ${{}}::jsonb)`;
  const ranked: string[] = rows.map((r: Record<string, unknown>) => String(r.id));
  const goldTopical = new Set([t.current, t.superseded!]);
  const goldCurrent = new Set([t.current]);
  label.push({ ranked, goldTopical, goldCurrent });
  // Exclude: the same result list with superseded rows removed (the TS oracle).
  exclude.push({ ranked: ranked.filter((id) => !supersededIds.has(id)), goldTopical, goldCurrent });
}

const topicalLabel = score(label.map((x) => ({ ranked: x.ranked, gold: x.goldTopical })));
const topicalExcl = score(exclude.map((x) => ({ ranked: x.ranked, gold: x.goldTopical })));
const currentLabel = score(label.map((x) => ({ ranked: x.ranked, gold: x.goldCurrent })));
const currentExcl = score(exclude.map((x) => ({ ranked: x.ranked, gold: x.goldCurrent })));

// How often the stale twin actually outranks its replacement — the thing the
// ticket is about ("ranked beside today's, higher if better written").
const oldAboveNew = label.filter((x, i) => {
  const t = twinTopics[i];
  const ro = x.ranked.indexOf(t.superseded!);
  const rn = x.ranked.indexOf(t.current);
  return ro !== -1 && (rn === -1 || ro < rn);
}).length;

// The exclude machinery must actually do what it claims: remove every
// superseded row label-only returned, and never remove a current one. Without
// these the one-directional metric assertions below would survive an exclude
// filter that dropped the wrong rows (review pass 1).
const supersededReturned = label.filter((x, i) => x.ranked.includes(twinTopics[i].superseded!)).length;
const supersededSurviving = exclude.filter((x, i) => x.ranked.includes(twinTopics[i].superseded!)).length;
const currentDropped = exclude.filter((x, i) => !x.ranked.includes(twinTopics[i].current)).length;
assert(supersededReturned > 0, "label-only returns superseded rows (so there is something to exclude)");
assert(supersededSurviving === 0, "exclude removes every superseded row label-only returned");
assert(currentDropped === 0, "exclude never removes the current version");

const pct = (m: Metrics) => `MRR ${m.mrr.toFixed(3)}  R@1 ${(m.r1 * 100).toFixed(0)}%`;
console.log(`  the stale twin outranks its replacement in ${oldAboveNew}/${twinTopics.length} topics (a coin-flip, by construction)\n`);
console.log(`  relevance = TOPICAL (any version of the topic counts — the fork's title→body task)`);
console.log(`     label-only : ${pct(topicalLabel)}`);
console.log(`     exclude    : ${pct(topicalExcl)}   Δ MRR ${(topicalExcl.mrr - topicalLabel.mrr >= 0 ? "+" : "") + (topicalExcl.mrr - topicalLabel.mrr).toFixed(3)}\n`);
console.log(`  relevance = CURRENT (only the non-superseded version counts — the ticket's premise)`);
console.log(`     label-only : ${pct(currentLabel)}`);
console.log(`     exclude    : ${pct(currentExcl)}   Δ MRR ${(currentExcl.mrr - currentLabel.mrr >= 0 ? "+" : "") + (currentExcl.mrr - currentLabel.mrr).toFixed(3)}\n`);

// ── The CONTROL: a corpus with NO twins — nothing is superseded, so the two
// policies are identical. The check that can actually FAIL is that seeding
// without twins leaves zero superseded rows (a seed bug that created a twin
// here would be caught) and that the exclude set computed FROM THIS corpus is
// empty — not filtered against the previous corpus's stale ids, which would be
// a vacuous no-op (review pass 1). ──
await sql`DELETE FROM thoughts`;
const plain = await seedCorpus(sql, false);
const plainSuperseded = Number((await sql`SELECT count(*)::int AS c FROM thoughts WHERE supersedes IS NOT NULL`)[0].c);
assert(plainSuperseded === 0, "CONTROL: seeding without twins leaves zero superseded rows");
// The set the exclude policy would remove, computed from THIS corpus, is empty,
// so exclude and label-only are provably the same list for every query.
const plainSupersededIds = new Set(
  (await sql`SELECT id::text AS id FROM thoughts WHERE id IN (SELECT supersedes FROM thoughts WHERE supersedes IS NOT NULL)`)
    .map((r: Record<string, unknown>) => String(r.id)));
let controlOk = true;
for (const t of plain) {
  const rows = await sql`SELECT id::text AS id FROM match_thoughts(${axisQuery(t.axis)}::vector, -1.0, 10, ${{}}::jsonb)`;
  const ranked: string[] = rows.map((r: Record<string, unknown>) => String(r.id));
  if (JSON.stringify(ranked) !== JSON.stringify(ranked.filter((id) => !plainSupersededIds.has(id)))) controlOk = false;
}
assert(plainSupersededIds.size === 0 && controlOk, "CONTROL: with no superseded rows, exclude and label-only return the same rows");

// ── The verdict ──────────────────────────────────────────────────────────────
const topicalMoves = Math.abs(topicalExcl.mrr - topicalLabel.mrr) > 0.005;
const currentMoves = currentExcl.mrr - currentLabel.mrr > 0.005;

console.log("  ── verdict ──");
console.log(`  On the TOPICAL task the fork measures against, excluding superseded rows ${topicalMoves ? "MOVES" : "does NOT move"} MRR` +
  ` (${(topicalExcl.mrr - topicalLabel.mrr >= 0 ? "+" : "") + (topicalExcl.mrr - topicalLabel.mrr).toFixed(3)}).`);
console.log(`  Under CURRENT-version relevance it ${currentMoves ? "helps" : "does not help"}` +
  ` (${(currentExcl.mrr - currentLabel.mrr >= 0 ? "+" : "") + (currentExcl.mrr - currentLabel.mrr).toFixed(3)}), by removing the stale twin that outranks its replacement.`);
console.log("");
console.log("  Decision (SMD-1253): the fork's relevance task is TOPICAL, on which the numbers do not move —");
console.log("  so per the ticket the ranking change does NOT ship; supersession is LABELLED, not excluded or");
console.log("  down-weighted. The label serves the current-version reader (who the CURRENT column shows would");
console.log("  benefit from exclusion) WITHOUT a ranking change the topical task cannot justify — the same");
console.log("  shape as 020's recency blend, measured to hurt and left at zero. A future exclude/down-weight");
console.log("  is a follow-up: this harness is the instrument to justify it.\n");

// The eval's own assertions, so it fails loudly if the structure regresses.
assert(topicalExcl.mrr <= topicalLabel.mrr + 0.005, "exclusion does not IMPROVE the topical metric (removing a still-relevant row cannot help it)");
assert(currentExcl.mrr >= currentLabel.mrr - 0.005, "exclusion does not HURT the current-version metric");


// ═════════════════════════════════════════════════════════════════════════════
// SMD-2255 (SMD-2074's second consumer): the down-weight, priced on the hybrid.
//
// The section above priced EXCLUDE on match_thoughts and kept 025's decision:
// label, do not demote. search_thoughts' opt-in `prefer_current` demotes
// instead, through search_thoughts_hybrid, and demotes two things — a thought
// a newer one supersedes, and a thought whose ticket is SETTLED (completed or
// canceled, by 058's node_state: a row carrying `ticket` or `issue` reads its
// ticket head's lifecycle). The rule, pre-registered before any number here
// was read: over the hybrid's top W = min(100, 4N), a demoted row's fused
// score is multiplied by 0.25 (one weight, once even when both apply), the
// window re-sorted — ties in the hybrid's own order — and cut to N. Amended
// after the first review pass: ties go to the current row first, then the
// hybrid's order (a literal-only query scores every other row 0, and a
// demoted zero stayed among the current ones); no query here is literal-only,
// so no number moved.
//
// PRICED BEFORE THE SQL EXISTS, as this file priced exclude: `demote` is a
// TypeScript oracle over the hybrid's window and node_state's columns, so the
// numbers decided whether migration 059 was written. It was; the oracle stays,
// and 059's search_thoughts_current is held to it on every query. Three policies, one query
// set: off (the hybrid at N, today's order), demote, and exclude (the demoted
// rows removed from the window). Every row sits at a controlled cosine to its
// topic's query (the axis), its remainder in axes no topic uses, so another
// topic's row is at cosine 0 and each topic is its own neighbourhood.
//
// The classes, and what each relevance says:
//   TWIN      a current row, the row it supersedes (a coin flip which scores
//             higher), and three live distractors interleaved by cosine.
//             TOPICAL either version; CURRENT only the new; PREVIOUS only the
//             old — SMD-1720's "what was it before" question, where demotion
//             costs and exclusion costs everything.
//   LIFECYCLE a live ticket (started), a settled one (completed), a note filed
//             under the settled ticket (`ticket`, no status of its own), and
//             two distractors with no lifecycle. LIVE the live ticket; ANY any
//             of the three; SETTLED the settled ticket; NOTE the note — 058's
//             ticket-head rule demotes it, and this prices that.
//   LITERAL   a settled ticket whose text holds its key, the query naming the
//             key, among live neighbours at higher cosine — sparse (3) and
//             dense (20). Under RRF the weight bites here: a demoted exact hit
//             can fall below meaning-only matches.
// The controls: a corpus with nothing to demote (demote is the hybrid's order,
// row for row); an all-settled corpus (a uniform multiplier: the off order —
// the tracker corpus's case, every issue completed).
//
// The decision, pre-registered (the default stays OFF whatever the numbers):
// the flag is built, opt-in, only if every control holds, CURRENT and LIVE
// MRR each improve by at least 0.05 over off, and demote is at least exclude
// on PREVIOUS. TOPICAL, NOTE, SETTLED and LITERAL costs are disclosed, not
// vetoes — the caller opts in.
// ═════════════════════════════════════════════════════════════════════════════

const N = 10;
const W = Math.min(100, 4 * N);
const WEIGHT = 0.25;
// 48 topics per class: the first run took 12 and landed CURRENT at +0.039
// against the +0.05 bar; the maintainer's call was one replication at four
// times the n, the same bar, bound by the result (recorded in the verdict).
const PER_CLASS = Number(process.env.OB1_EVAL_PER_CLASS ?? 48);
const LITERAL_PER_ARM = Math.max(4, Math.floor(PER_CLASS / 2));
// Every topic its own axis, then 24 axes that carry every row's remainder: the
// section's own schema, wider than the 64 dimensions 025's section above keeps.
const NOISE_FROM = 2 * PER_CLASS + 2 * LITERAL_PER_ARM;
const HDIM = NOISE_FROM + 24;
await sql.close();
await resetSchema(URL_, { dim: HDIM, model: MODEL });
const hsql = new SQL({ url: URL_, max: 4 });

/**
 * A row at cosine ≈ `cos` to axis `axis`, its remainder spread over the noise
 * axes, plus a jitter of ±0.01 on every other topic's axis: another topic's
 * row then sits near cosine 0 but never exactly, so no two rows tie. With
 * exact ties the tail at threshold -1 came back in whatever order the index
 * walk found them, and the controls compared that order (first run).
 */
function atCos(axis: number, cos: number, rand: () => number): string {
  const v = new Array(HDIM).fill(0);
  const r = Array.from({ length: HDIM - NOISE_FROM }, () => rand() - 0.5);
  const norm = Math.hypot(...r);
  const s = Math.sqrt(1 - cos * cos);
  for (let k = 0; k < r.length; k++) v[NOISE_FROM + k] = (r[k] / norm) * s;
  for (let k = 0; k < NOISE_FROM; k++) if (k !== axis) v[k] = (rand() - 0.5) * 0.02;
  v[axis] = cos;
  return `[${v.join(",")}]`;
}
const between = (rand: () => number, lo: number, hi: number) => lo + rand() * (hi - lo);

type HybridRow = { id: string; score: number };
type NodeRow = { open: boolean | null; superseded: boolean };

// Every row carries its class, and every query filters by it: match_thoughts
// answers a filter matching at most 1,000 thoughts EXACTLY, with no index walk
// (041's v_exact), so the policies see one candidate list at every count and
// differ by the rule alone. Unfiltered, the approximate walk returned
// different candidates at counts 10, 40 and 100 once the corpus reached 1,200
// rows, and the controls failed on that, not on the rule (the replication).
let klass = "";
const byClass = () => ({ eval_class: klass });
async function capture(content: string, vec: string, metadata: Record<string, unknown> = {}, supersedes?: string): Promise<string> {
  const env: Record<string, unknown> = { metadata: { type: "note", eval_class: klass, ...metadata } };
  if (supersedes) env.supersedes = supersedes;
  return ((await hsql`SELECT upsert_thought(${content}, ${env}::jsonb, ${vec}::vector) AS r`)[0].r as { id: string }).id;
}
/** Board-sync's stamp: the lifecycle keys on the row's own metadata. */
async function stamp(id: string, keys: Record<string, unknown>): Promise<void> {
  await hsql`UPDATE thoughts SET metadata = metadata || ${keys}::jsonb WHERE id = ${id}::uuid`;
}
async function hybrid(queryVec: string, queryText: string, threshold: number, count: number, filter: Record<string, unknown>): Promise<HybridRow[]> {
  const rows = await hsql`
    SELECT id::text AS id, score FROM search_thoughts_hybrid(${queryVec}::vector, ${queryText}, ${threshold}::float, ${count}::int, ${filter}::jsonb, 0.0::float, 90.0::float)`;
  return rows.map((r: Record<string, unknown>) => ({ id: String(r.id), score: Number(r.score) }));
}
/** 058's read, for the ids in hand: the two facts the rule reads. */
async function nodeFacts(ids: string[]): Promise<Map<string, NodeRow>> {
  if (ids.length === 0) return new Map();
  const rows = await hsql`SELECT thought_id::text AS id, open, superseded_by IS NOT NULL AS superseded FROM node_state(${hsql.array(ids, "TEXT")}::uuid[])`;
  return new Map(rows.map((r: Record<string, unknown>) => [String(r.id), { open: r.open as boolean | null, superseded: Boolean(r.superseded) }]));
}
const demotable = (f: NodeRow | undefined) => f !== undefined && (f.open === false || f.superseded);

type Ranked = { off: string[]; demote: string[]; exclude: string[]; exactAgrees: boolean | null; windowExact: boolean; sqlAgrees: boolean };
/** The three policies for one query, and the window's honesty: the oracle over W against the whole list re-weighted. */
async function policies(queryVec: string, queryText: string, threshold: number, filter: Record<string, unknown>): Promise<Ranked> {
  const off = (await hybrid(queryVec, queryText, threshold, N, filter)).map((r) => r.id);
  const win = await hybrid(queryVec, queryText, threshold, W, filter);
  const all = await hybrid(queryVec, queryText, threshold, 100, filter);
  const facts = await nodeFacts([...new Set([...win, ...all].map((r) => r.id))]);
  // Ties go to the current row, then to the hybrid's order — 059's ORDER BY
  // (first review pass: a literal-only query scores every other row 0, and a
  // demoted zero stayed among the current zeros).
  const weigh = (rows: HybridRow[]) =>
    rows.map((r, ord) => { const dem = demotable(facts.get(r.id)); return { id: r.id, w: r.score * (dem ? WEIGHT : 1), dem: dem ? 1 : 0, ord }; })
      .sort((a, b) => b.w - a.w || a.dem - b.dem || a.ord - b.ord).map((r) => r.id);
  const demote = weigh(win).slice(0, N);
  const exclude = win.filter((r) => !demotable(facts.get(r.id))).map((r) => r.id).slice(0, N);
  const current = win.filter((r) => !demotable(facts.get(r.id))).length;
  const windowExact = win.length < W || current >= N;
  const exact = weigh(all).slice(0, N);
  // Migration 059's function, the one the tool calls: it must be the oracle,
  // row for row, and say the same about its window.
  const sqlRows = await hsql`
    SELECT id::text AS id, window_exact FROM search_thoughts_current(${queryVec}::vector, ${queryText}, ${threshold}::float, ${N}::int, ${filter}::jsonb, 0.0::float, 90.0::float)`;
  const sqlAgrees = JSON.stringify(sqlRows.map((r: Record<string, unknown>) => String(r.id))) === JSON.stringify(demote)
    && sqlRows.every((r: Record<string, unknown>) => r.window_exact === windowExact);
  // Checkable only where the hybrid at 100 returned its whole list — fewer
  // than 100 rows; at 100 the list may go on (first review pass: `<= 100`
  // counted every query as checked).
  return { off, demote, exclude, windowExact, sqlAgrees, exactAgrees: all.length < 100 ? JSON.stringify(exact) === JSON.stringify(demote) : null };
}

type Query = { vec: string; text: string; filter: Record<string, unknown>; gold: Record<string, Set<string>> };
const queries: Record<"TWIN" | "LIFECYCLE" | "LITERAL_SPARSE" | "LITERAL_DENSE", Query[]> = { TWIN: [], LIFECYCLE: [], LITERAL_SPARSE: [], LITERAL_DENSE: [] };

await hsql`DELETE FROM thoughts`;
const rand2 = rng(SEED + 2255);
let axis = 0;
klass = "twin";
for (let t = 0; t < PER_CLASS; t++, axis++) {
  // TWIN: the old row first (the pointer is on the newer), a coin flip which scores higher.
  const [hi, lo] = [between(rand2, 0.86, 0.95), between(rand2, 0.78, 0.86)];
  const oldHigher = rand2() < 0.5;
  const oldRow = await capture(`twin ${t} — the older version`, atCos(axis, oldHigher ? hi : lo, rand2));
  const newRow = await capture(`twin ${t} — the current version`, atCos(axis, oldHigher ? lo : hi, rand2), {}, oldRow);
  for (let d = 0; d < 3; d++) await capture(`twin ${t} — distractor ${d}`, atCos(axis, between(rand2, 0.72, 0.97), rand2));
  queries.TWIN.push({ vec: atCos(axis, 1, rand2), text: `twin topic ${t}`, filter: byClass(),
    gold: { TOPICAL: new Set([newRow, oldRow]), CURRENT: new Set([newRow]), PREVIOUS: new Set([oldRow]) } });
}
klass = "lifecycle";
for (let t = 0; t < PER_CLASS; t++, axis++) {
  // LIFECYCLE: a live and a settled ticket, a note under the settled one, two distractors.
  const live = await capture(`lifecycle ${t} — the live ticket`, atCos(axis, between(rand2, 0.78, 0.95), rand2));
  await stamp(live, { source: "linear", issue: `LC-${t}-L`, status: "In Progress", status_type: "started" });
  const done = await capture(`lifecycle ${t} — the settled ticket`, atCos(axis, between(rand2, 0.78, 0.95), rand2));
  await stamp(done, { source: "linear", issue: `LC-${t}-D`, status: "Done", status_type: "completed" });
  const note = await capture(`lifecycle ${t} — a note under the settled ticket`, atCos(axis, between(rand2, 0.78, 0.95), rand2));
  await stamp(note, { ticket: `LC-${t}-D` });
  for (let d = 0; d < 2; d++) await capture(`lifecycle ${t} — distractor ${d}`, atCos(axis, between(rand2, 0.72, 0.97), rand2));
  queries.LIFECYCLE.push({ vec: atCos(axis, 1, rand2), text: `lifecycle topic ${t}`, filter: byClass(),
    gold: { LIVE: new Set([live]), ANY: new Set([live, done, note]), SETTLED: new Set([done]), NOTE: new Set([note]) } });
}
for (const [cls, neighbours] of [["LITERAL_SPARSE", 3], ["LITERAL_DENSE", 20]] as const) {
  klass = cls.toLowerCase();
  for (let t = 0; t < LITERAL_PER_ARM; t++, axis++) {
    // LITERAL: the settled ticket holds its key; its neighbours score higher by meaning.
    const key = `SMD-97${String(axis).padStart(2, "0")}`;
    const done = await capture(`${key} — the settled ticket, literal ${t}`, atCos(axis, between(rand2, 0.55, 0.65), rand2));
    await stamp(done, { source: "linear", issue: key, status: "Done", status_type: "completed" });
    for (let d = 0; d < neighbours; d++) await capture(`literal ${axis} — neighbour ${d}`, atCos(axis, between(rand2, 0.7, 0.97), rand2));
    queries[cls].push({ vec: atCos(axis, 1, rand2), text: `what happened with ${key}`, filter: byClass(), gold: { KEY: new Set([done]) } });
  }
}
console.log(`\n  ── the down-weight on the hybrid (SMD-2255): N ${N}, window ${W}, weight ${WEIGHT}, ${PER_CLASS} topics per class, ${HDIM} dimensions ──\n`);

type Cell = { off: Metrics; demote: Metrics; exclude: Metrics };
const cells: Record<string, Cell> = {};
let windowQueries = 0, windowInexact = 0, exactChecked = 0, exactDisagree = 0, sqlDisagree = 0;
for (const threshold of [0, -1]) {
  for (const [cls, qs] of Object.entries(queries)) {
    const perRel: Record<string, { off: { ranked: string[]; gold: Set<string> }[]; demote: typeof perRel[string]["off"]; exclude: typeof perRel[string]["off"] }> = {};
    for (const q of qs) {
      const p = await policies(q.vec, q.text, threshold, q.filter);
      windowQueries++;
      if (!p.sqlAgrees) sqlDisagree++;
      if (!p.windowExact) windowInexact++;
      if (p.windowExact && p.exactAgrees !== null) { exactChecked++; if (!p.exactAgrees) exactDisagree++; }
      for (const [rel, gold] of Object.entries(q.gold)) {
        perRel[rel] ??= { off: [], demote: [], exclude: [] };
        perRel[rel].off.push({ ranked: p.off, gold });
        perRel[rel].demote.push({ ranked: p.demote, gold });
        perRel[rel].exclude.push({ ranked: p.exclude, gold });
      }
    }
    for (const [rel, r] of Object.entries(perRel)) cells[`${cls}/${rel}@${threshold}`] = { off: score(r.off), demote: score(r.demote), exclude: score(r.exclude) };
  }
}
const d = (a: number, b: number) => `${a - b >= 0 ? "+" : ""}${(a - b).toFixed(3)}`;
for (const threshold of [0, -1]) {
  console.log(`  threshold ${threshold}           off (MRR  R@1)   demote            exclude           Δ demote`);
  for (const [key, c] of Object.entries(cells)) {
    if (!key.endsWith(`@${threshold}`)) continue;
    const name = key.replace(`@${threshold}`, "").padEnd(22);
    const m = (x: Metrics) => `${x.mrr.toFixed(3)} ${(x.r1 * 100).toFixed(0).padStart(3)}%`;
    console.log(`  ${name} ${m(c.off)}      ${m(c.demote)}      ${m(c.exclude)}      ${d(c.demote.mrr, c.off.mrr)}`);
  }
  console.log("");
}
console.log(`  window: ${windowInexact}/${windowQueries} queries held fewer than ${N} current rows in the top ${W}; of the ${exactChecked} whose whole admitted list fits in 100 rows, the window's top ${N} was that list re-weighted on ${exactChecked - exactDisagree}\n`);
assert(exactDisagree === 0, "WINDOW: wherever the window held N current rows (or the whole list), its top N is the whole admitted list re-weighted");
assert(sqlDisagree === 0, `SQL: migration 059's search_thoughts_current returns the oracle's rows, in its order, with its window flag, on every query (${windowQueries - sqlDisagree}/${windowQueries})`);

// ── Controls ─────────────────────────────────────────────────────────────────
// Nothing to demote: a copy of every class with no pointer and no lifecycle.
await hsql`DELETE FROM thoughts`;
const rand3 = rng(SEED + 22551);
const plainQs: Query[] = [];
klass = "plain";
for (let t = 0; t < PER_CLASS; t++) {
  for (let k = 0; k < 5; k++) await capture(`plain ${t} — row ${k}`, atCos(t, between(rand3, 0.72, 0.97), rand3));
  plainQs.push({ vec: atCos(t, 1, rand3), text: `plain topic ${t}`, filter: byClass(), gold: {} });
}
let plainSame = true;
for (const q of plainQs) for (const th of [0, -1]) { const p = await policies(q.vec, q.text, th, q.filter); if (JSON.stringify(p.off) !== JSON.stringify(p.demote) || !p.sqlAgrees) plainSame = false; }
assert(plainSame, "CONTROL: with nothing to demote, demote returns the hybrid's rows in the hybrid's order");
// Every row settled: a uniform multiplier leaves the order alone.
await hsql`UPDATE thoughts SET metadata = metadata || '{"source": "linear", "status": "Done", "status_type": "completed"}'::jsonb || jsonb_build_object('issue', 'ALL-' || id::text)`;
let settledSame = true;
for (const q of plainQs) for (const th of [0, -1]) { const p = await policies(q.vec, q.text, th, q.filter); if (JSON.stringify(p.off) !== JSON.stringify(p.demote) || !p.sqlAgrees) settledSame = false; }
const settledCount = Number((await hsql`SELECT count(*)::int AS c FROM node_state() WHERE open = false`)[0].c);
assert(settledSame && settledCount === PER_CLASS * 5, `CONTROL: with every row settled (${settledCount}), the uniform multiplier leaves the order as off returns it`);

// ── The verdict, by the pre-registered rule ─────────────────────────────────
const at0 = (k: string) => cells[`${k}@0`];
const liftCurrent = at0("TWIN/CURRENT").demote.mrr - at0("TWIN/CURRENT").off.mrr;
const liftLive = at0("LIFECYCLE/LIVE").demote.mrr - at0("LIFECYCLE/LIVE").off.mrr;
const previousOk = at0("TWIN/PREVIOUS").demote.mrr >= at0("TWIN/PREVIOUS").exclude.mrr - 1e-9;
const controlsOk = plainSame && settledSame && exactDisagree === 0 && sqlDisagree === 0;
const builds = controlsOk && liftCurrent >= 0.05 && liftLive >= 0.05 && previousOk;
console.log("  ── verdict (SMD-2255, pre-registered) ──");
console.log(`  CURRENT ${d(at0("TWIN/CURRENT").demote.mrr, at0("TWIN/CURRENT").off.mrr)}, LIVE ${d(at0("LIFECYCLE/LIVE").demote.mrr, at0("LIFECYCLE/LIVE").off.mrr)} (bar: +0.050 each); PREVIOUS demote ${at0("TWIN/PREVIOUS").demote.mrr.toFixed(3)} against exclude ${at0("TWIN/PREVIOUS").exclude.mrr.toFixed(3)}; controls ${controlsOk ? "hold" : "FAIL"}.`);
const costs = (th: number) => { const at = (k: string) => cells[`${k}@${th}`]; return `TOPICAL ${d(at("TWIN/TOPICAL").demote.mrr, at("TWIN/TOPICAL").off.mrr)}, PREVIOUS ${d(at("TWIN/PREVIOUS").demote.mrr, at("TWIN/PREVIOUS").off.mrr)}, NOTE ${d(at("LIFECYCLE/NOTE").demote.mrr, at("LIFECYCLE/NOTE").off.mrr)}, SETTLED ${d(at("LIFECYCLE/SETTLED").demote.mrr, at("LIFECYCLE/SETTLED").off.mrr)}, LITERAL sparse ${d(at("LITERAL_SPARSE/KEY").demote.mrr, at("LITERAL_SPARSE/KEY").off.mrr)}, dense ${d(at("LITERAL_DENSE/KEY").demote.mrr, at("LITERAL_DENSE/KEY").off.mrr)}`; };
console.log(`  Costs, disclosed: at threshold 0 ${costs(0)}; at -1, where the window fills, ${costs(-1)}.`);
console.log(`  Decision: ${builds ? "BUILD prefer_current, opt-in, default off" : "do NOT build the flag"} — the default ranking is unchanged either way (025's label stands for every caller who does not ask).\n`);

await hsql.close();
report();
