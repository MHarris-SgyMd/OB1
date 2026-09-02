#!/usr/bin/env bun
/**
 * eval-embed2.ts — a benchmark that actually discriminates.
 *
 * v1 was saturated: everything scored 85–95% and a 45 MB model tied a 669 MB one.
 * Short one-line thoughts with distinct topics are easy, so the test measured
 * nothing. Three additions, each targeting a real failure mode:
 *
 *   NEAR-DUPLICATES. Clusters of thoughts on the same subject where only one
 *   answers the query. This is what a growing brain looks like — the tenth note
 *   about certificates — and it needs discrimination, not topic matching.
 *
 *   LONG DOCUMENTS with the answer at the END. Context windows here span 512 to
 *   8192 tokens. A 512-token model silently truncates a long thought and the tail
 *   becomes unsearchable, with no error anywhere. Short test docs hide that
 *   completely.
 *
 *   TEMPORAL / NUMERIC specificity, where the distractor is lexically closer than
 *   the answer.
 *
 * Reported per-slice, because an average over easy and hard queries hides exactly
 * the thing worth knowing.
 */

const BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";

type Doc = { id: string; text: string; slice: string };
type Query = { q: string; want: string; slice: string };

/** ~700 words of plausible filler, so the payload sits past a 512-token window. */
function padded(lead: string, tail: string): string {
  const filler = [
    "Context from the meeting, written up afterwards so it is not lost.",
    "We went round the same arguments as last quarter without much new evidence.",
    "There was a long digression about whether the previous vendor evaluation was still valid,",
    "and whether anyone had actually re-run the load tests since the schema change landed.",
    "Nobody had. The action from that was to book time before the next review.",
    "Separately, the cost model came up again: the finance sheet assumes steady traffic,",
    "which has not matched reality for two quarters, and the variance is mostly weekend batch work.",
    "Someone suggested we move the batch to a spot fleet, which was noted but not owned.",
    "We also revisited the on-call rotation and agreed the current split is unsustainable",
    "for a team of five, particularly with two people on parental leave in the spring.",
    "The hiring conversation was deferred. Notes on tooling: the dashboards are stale,",
    "half the panels point at metrics that were renamed in the last migration,",
    "and nobody trusts the alerting thresholds enough to page on them.",
    "A cleanup was proposed and scoped at roughly a week, which felt optimistic.",
    "There was general agreement that documentation has drifted far from the code,",
    "and that the runbooks reference at least two systems that no longer exist.",
  ].join(" ");
  return `${lead} ${filler} ${filler} ${tail}`;
}

const DOCS: Doc[] = [
  // ── near-duplicate cluster: certificates ──────────────────────────────────
  { id: "cert-staging", slice: "near-dup", text: "Renew the SSL certificate for the staging cluster before it expires at the end of the month." },
  { id: "cert-prod", slice: "near-dup", text: "The production SSL certificate auto-renews through cert-manager, so it needs no manual action." },
  { id: "cert-wildcard", slice: "near-dup", text: "We should move to a wildcard certificate so each new subdomain does not need its own issuance." },
  { id: "cert-pinning", slice: "near-dup", text: "The mobile client pins the old certificate authority, which will break when we rotate issuers." },

  // ── near-duplicate cluster: databases ─────────────────────────────────────
  { id: "db-jsonb", slice: "near-dup", text: "Postgres stores jsonb containment with the @> operator, and a GIN index makes it fast." },
  { id: "db-hnsw", slice: "near-dup", text: "pgvector's HNSW index tops out at 2000 dimensions, so the large embedding model cannot be indexed." },
  { id: "db-pool", slice: "near-dup", text: "Serverless functions cannot hold a Postgres connection pool, which is what Hyperdrive exists to absorb." },
  { id: "db-vacuum", slice: "near-dup", text: "Autovacuum was never keeping up on the events table because the fill factor was left at the default." },

  // ── long documents, answer at the very end ────────────────────────────────
  { id: "long-budget", slice: "long", text: padded(
      "Quarterly planning session, third of the year.",
      "The decision, finally: we approved eighty thousand for the observability migration, contingent on Priya signing off the vendor contract by the fourteenth.") },
  { id: "long-arch", slice: "long", text: padded(
      "Architecture review for the ingestion rewrite.",
      "The conclusion nobody wrote down at the time: we are keeping Kafka and dropping the direct-to-Postgres path entirely, because the reconciliation job cannot be made idempotent.") },
  { id: "long-people", slice: "long", text: padded(
      "Skip-level notes, second round.",
      "The thing worth remembering: Dev wants to move into platform work next cycle, and Anita is the one who should mentor that transition.") },

  // ── temporal / numeric specificity ────────────────────────────────────────
  { id: "date-dentist-14", slice: "temporal", text: "Dentist appointment moved to the 14th at 3pm, the one on Ashworth Road." },
  { id: "date-flight-19", slice: "temporal", text: "Booked the Lisbon flights for the 19th, returning on the 27th, aisle seats both ways." },
  { id: "date-oncall-20", slice: "temporal", text: "Swapped on-call with Dev for the week of the 20th because of the trip to Lisbon." },
  { id: "date-tax-jan", slice: "temporal", text: "Self assessment is due at the end of January and last year I left it far too late." },

  // ── ordinary distractors ──────────────────────────────────────────────────
  { id: "sourdough", slice: "easy", text: "Sourdough starter needs feeding every twelve hours once it doubles reliably." },
  { id: "coffee", slice: "easy", text: "Grinding finer fixed the sour shots but the pull time went over thirty five seconds." },
  { id: "guitar", slice: "easy", text: "The B string keeps going sharp after about twenty minutes, probably the nut needs filing." },
  { id: "book-rec", slice: "easy", text: "Anita recommended Seeing Like a State, said it changed how she thinks about central planning." },
  { id: "hiring", slice: "easy", text: "We should drop the take-home from the hiring loop, three candidates said it took a full weekend." },
];

const QUERIES: Query[] = [
  // near-duplicate discrimination
  { q: "which certificate do I have to renew by hand?", want: "cert-staging", slice: "near-dup" },
  { q: "which cert renewal is already automated?", want: "cert-prod", slice: "near-dup" },
  { q: "what will break in the phone app when we change CA?", want: "cert-pinning", slice: "near-dup" },
  { q: "how do I avoid issuing a new cert per subdomain?", want: "cert-wildcard", slice: "near-dup" },
  { q: "why can't the big embedding model be indexed?", want: "db-hnsw", slice: "near-dup" },
  { q: "how do I query inside a JSON column efficiently?", want: "db-jsonb", slice: "near-dup" },
  { q: "what is the problem with database connections on serverless?", want: "db-pool", slice: "near-dup" },
  { q: "why was dead tuple cleanup falling behind?", want: "db-vacuum", slice: "near-dup" },

  // long-document retrieval — the answer is in the final sentence
  { q: "how much did we approve for the observability work?", want: "long-budget", slice: "long" },
  { q: "did we decide to keep Kafka?", want: "long-arch", slice: "long" },
  { q: "who should mentor Dev's move into platform?", want: "long-people", slice: "long" },

  // temporal
  { q: "what is happening on the 14th?", want: "date-dentist-14", slice: "temporal" },
  { q: "what week am I not on call?", want: "date-oncall-20", slice: "temporal" },
  { q: "when do I fly out?", want: "date-flight-19", slice: "temporal" },
  { q: "what is my January deadline?", want: "date-tax-jan", slice: "temporal" },

  // easy
  { q: "how often should I feed the starter?", want: "sourdough", slice: "easy" },
  { q: "my espresso tasted acidic, what did I change?", want: "coffee", slice: "easy" },
  { q: "which book did a friend suggest?", want: "book-rec", slice: "easy" },
  { q: "what feedback did we get on interviewing?", want: "hiring", slice: "easy" },
  { q: "why does my instrument drift out of tune?", want: "guitar", slice: "easy" },
];

async function embed(model: string, input: string): Promise<number[]> {
  const r = await fetch(`${BASE}/embeddings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 80)}`);
  return ((await r.json()) as { data: [{ embedding: number[] }] }).data[0].embedding;
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

const SLICES = ["easy", "near-dup", "temporal", "long"];

async function evaluate(model: string) {
  const t0 = Date.now();
  const vecs: Record<string, number[]> = {};
  for (const d of DOCS) vecs[d.id] = await embed(model, d.text);
  const dims = vecs[DOCS[0].id].length;

  const per: Record<string, { n: number; hit1: number; mrr: number }> = {};
  for (const s of SLICES) per[s] = { n: 0, hit1: 0, mrr: 0 };
  const misses: string[] = [];

  for (const { q, want, slice } of QUERIES) {
    const qv = await embed(model, q);
    const ranked = DOCS.map((d) => ({ id: d.id, s: cosine(qv, vecs[d.id]) })).sort((a, b) => b.s - a.s);
    const rank = ranked.findIndex((r) => r.id === want) + 1;
    per[slice].n++;
    if (rank === 1) per[slice].hit1++;
    per[slice].mrr += 1 / rank;
    if (rank !== 1) misses.push(`${slice}: "${q.slice(0, 44)}" → wanted ${want} (rank ${rank}), got ${ranked[0].id}`);
  }

  const overall = SLICES.reduce((a, s) => a + per[s].mrr, 0) / QUERIES.length;
  return { model, dims, per, overall, misses, seconds: (Date.now() - t0) / 1000 };
}

const models = process.argv.slice(2);
const results = [];
for (const m of models) {
  process.stderr.write(`  … ${m}\n`);
  try { results.push(await evaluate(m)); }
  catch (e) { process.stderr.write(`  ✗ ${m}: ${(e as Error).message}\n`); }
}

console.log(`\n  ${DOCS.length} thoughts, ${QUERIES.length} queries — R@1 per slice, then overall MRR\n`);
console.log("  model                       dims  " + SLICES.map((s) => s.padStart(9)).join("") + "   MRR    sec");
console.log("  " + "─".repeat(88));
for (const r of results.sort((a, b) => b.overall - a.overall)) {
  const cells = SLICES.map((s) => {
    const p = r.per[s];
    return `${p.hit1}/${p.n}`.padStart(9);
  }).join("");
  console.log(`  ${r.model.padEnd(27)} ${String(r.dims).padStart(4)}  ${cells}   ${r.overall.toFixed(3)}  ${r.seconds.toFixed(1).padStart(5)}`);
}

for (const r of results) {
  if (!r.misses.length) continue;
  console.log(`\n  ${r.model} missed ${r.misses.length}:`);
  for (const m of r.misses) console.log(`    ${m}`);
}
