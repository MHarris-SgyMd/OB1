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
 *   ../db/with-postgres.sh bun eval-supersession.ts
 *   OB1_EVAL_TOPICS=48   OB1_EVAL_SEED=1253   tune the corpus (defaults shown)
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
  const ranked = rows.map((r: Record<string, unknown>) => String(r.id));
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
  const ranked = rows.map((r: Record<string, unknown>) => String(r.id));
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

await sql.close();
report();
