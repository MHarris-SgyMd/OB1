/**
 * corpus.ts — the retrieval corpus, shared by eval-retrieval.ts and eval-cascade.ts.
 *
 * Extracted so the cascade is measured on exactly the same twenty thoughts and
 * twenty queries as the single-tier baseline. Two copies would drift, and a
 * comparison across drifted corpora is worthless.
 */

export type Doc = { id: string; text: string; slice: string };
export type Query = { q: string; want: string; slice: string };

/**
 * ~460 words of plausible filler, so the payload sits past a 512-token window
 * (~616 tokens) while fitting a 2048-token one.
 *
 * Every long doc takes the SAME lead deliberately. An earlier version gave each
 * one a distinctive opening and the slice silently measured the wrong thing: a
 * 512-token model cannot see the tail at all, yet `bge-large` scored 3/3 by
 * matching the lead. With the leads made identical it scores 1/3, which is what
 * a truncating model should score. Only the final sentence now discriminates,
 * which is the failure mode this slice exists to catch.
 */
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

export const DOCS: Doc[] = [
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
      "Meeting notes, written up afterwards.",
      "The decision, finally: we approved eighty thousand for the observability migration, contingent on Priya signing off the vendor contract by the fourteenth.") },
  { id: "long-arch", slice: "long", text: padded(
      "Meeting notes, written up afterwards.",
      "The conclusion nobody wrote down at the time: we are keeping Kafka and dropping the direct-to-Postgres path entirely, because the reconciliation job cannot be made idempotent.") },
  { id: "long-people", slice: "long", text: padded(
      "Meeting notes, written up afterwards.",
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

export const QUERIES: Query[] = [
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

/**
 * `model@dims` requests MRL truncation via the OpenAI `dimensions` parameter.
 * This is how a model whose native width exceeds pgvector's 2000-dimension HNSW
 * ceiling can still be used: qwen3-embedding:4b is 2560 natively and unindexable,
 * but 1024 on request. Ollama honours the parameter.
 */
export const SLICES = ["easy", "near-dup", "temporal", "long"];
