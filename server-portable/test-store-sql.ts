#!/usr/bin/env bun
/**
 * test-store-sql.ts — the SQL store against a real Postgres server.
 *
 * The point of Phase 2 is that swapping PostgREST for SQL changes *nothing* the
 * tools can observe. That is only credible if the replacement is exercised against
 * a real server with real pgvector, so this suite requires one.
 *
 *   ../db/with-postgres.sh bun test-store-sql.ts
 *   DATABASE_URL=… bun test-store-sql.ts
 *
 * It applies db/migrations first, so the database only needs to exist.
 */

import { SqlStore } from "./store-sql.ts";
import { createAssert, ISO_RE, resetSchema } from "../db/test-support.ts";
import { MATCH_THOUGHTS_SIGNATURE } from "../db/config.mjs";
import { createStore } from "./store.ts";
import { SQL } from "bun";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "db", "migrations");
const URL_ = process.env.DATABASE_URL;

if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-store-sql.ts");
  process.exit(2);
}

/**
 * db/migrations/*.sql are templates — migrate.ts substitutes these at apply time.
 * Applying them raw fails with `syntax error at or near "{"`.
 */
const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? 1536);
const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
function subst(sql: string): string {
  return sql
    .replace(/\{\{EMBEDDING_DIM\}\}/g, String(EMBEDDING_DIM))
    .replace(/\{\{EMBEDDING_MODEL\}\}/g, EMBEDDING_MODEL);
}

const { assert, report } = createAssert();

const unit = (i: number) => {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[i] = 1;
  return v;
};
const blend = () => {
  const v = new Array(EMBEDDING_DIM).fill(0);
  v[0] = 0.9;
  v[1] = 0.44;
  return v;
};

// Fresh schema.
await resetSchema(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

const store = new SqlStore(URL_, { max: 4 });

console.log("[1] The factory selects and validates");
{
  const s = await createStore({ OB1_STORE: "sql", DATABASE_URL: URL_ });
  assert(s.kind === "sql", "OB1_STORE=sql yields the SQL store");
  await s.close();

  let threw = "";
  try {
    await createStore({ OB1_STORE: "sql" });
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(/requires DATABASE_URL/.test(threw), "sql without DATABASE_URL is rejected up front");

  threw = "";
  try {
    await createStore({ OB1_STORE: "nonsense" });
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(/Unknown OB1_STORE/.test(threw), "an unknown store name is rejected, not defaulted");

  const p = await createStore({ OB1_STORE: "postgrest", SUPABASE_URL: "https://x.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
  assert(p.kind === "postgrest", "postgrest remains the other option");
  await p.close();
}

console.log("\n[2] captureThought writes content, metadata and vector atomically");
{
  const r = await store.captureThought({
    content: "exact",
    payload: { metadata: { kind: "a", source: "mcp" } },
    embedding: unit(0),
    embeddingModel: "unit-test-model",
  });
  assert(typeof r.id === "string" && r.id.length === 36, `returns a uuid (${r.id?.slice(0, 8)}…)`);
  assert(r.embeddingFailed === undefined, "no degraded-write flag on the SQL path");

  const back = await store.getThought(r.id);
  assert(back?.content === "exact", "the row reads back");
  assert(back?.metadata.kind === "a", `metadata survived binding (${JSON.stringify(back?.metadata)})`);
  assert(back?.metadata.source === "mcp", "…including every key, not just the first");

  // The model rides in the envelope beside the actor (021), and follows the
  // vector through an edit: relabelled with content, untouched without.
  const admin = new SQL({ url: URL_, max: 1 });
  const label = async () => (await admin`SELECT embedding_model AS m FROM thoughts WHERE id = ${r.id}`)[0].m as string | null;
  assert((await label()) === "unit-test-model", `the row carries the model the store was told (${await label()})`);
  await store.updateThought({ id: r.id, content: "exact", embedding: unit(0), embeddingModel: "unit-test-model-2" });
  assert((await label()) === "unit-test-model-2", "an edit with content relabels the row");
  await store.updateThought({ id: r.id, metadataPatch: { labelled: true } });
  assert((await label()) === "unit-test-model-2", "…and a metadata-only edit leaves the label with the vector");
  await admin.close();
}

console.log("\n[3] Search ranks and filters exactly as the RPC defines");
{
  await store.captureThought({ content: "near", payload: { metadata: { kind: "a" } }, embedding: blend() });
  await store.captureThought({ content: "distant", payload: { metadata: { kind: "b" } }, embedding: unit(1) });

  const all = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 10, filter: {} });
  assert(all.length === 3, `three rows above threshold -1 (got ${all.length})`);
  assert(all[0].content === "exact", `closest first (${all[0].content})`);
  assert(all[1].content === "near", `then the blend (${all[1].content})`);
  assert(Math.abs(all[0].similarity - 1) < 1e-6, "similarity is a number, ~1.0 for the exact match");
  assert(typeof all[0].created_at === "string" && ISO_RE.test(all[0].created_at), `created_at is an ISO string (got ${all[0].created_at})`);

  // The strict comparison. An orthogonal row has similarity exactly 0 and must be
  // excluded at threshold 0 — reimplementing this with >= would silently change
  // every result count in the product.
  const strict = await store.matchThoughts({ embedding: unit(0), threshold: 0, limit: 10, filter: {} });
  assert(strict.length === 2, `threshold 0 excludes the exactly-orthogonal row (got ${strict.length})`);

  const filtered = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 10, filter: { kind: "b" } });
  assert(filtered.length === 1 && filtered[0].content === "distant", "jsonb containment filter applies");

  const capped = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 1, filter: {} });
  assert(capped.length === 1, "limit is honoured");
}

console.log("\n[3b] keywordThoughts is exact where matchThoughts is approximate");
{
  // The pair the whole feature exists for. These three rows differ by one
  // character in a position an embedding cannot possibly distinguish, and the
  // store must return exactly the one that contains the literal string.
  for (const c of ["ticket SMD-944 is open", "ticket SMD-9440 is open", "ticket SMD-94 is open"]) {
    await store.captureThought({ content: c, payload: { metadata: { kind: "ticket" } }, embedding: unit(2) });
  }

  const hits = await store.keywordThoughts({ query: "SMD-944 ", limit: 10, offset: 0, filter: {} });
  assert(hits.length === 1 && hits[0].content === "ticket SMD-944 is open",
         `an exact needle returns exactly its row (got ${hits.length}: ${hits.map((h) => h.content).join(" | ")})`);
  assert(hits[0].totalCount === 1, `totalCount is mapped from total_count, not left undefined (${hits[0].totalCount})`);
  assert(hits[0].occurrences === 1, `occurrences is a number (${hits[0].occurrences})`);
  assert(typeof hits[0].created_at === "string" && ISO_RE.test(hits[0].created_at),
         "created_at is normalised to an ISO string, as every other store method does");

  // The prefix reaches all three, and totalCount says so on every row so a
  // caller reading only the first still knows the size of the set.
  const prefix = await store.keywordThoughts({ query: "SMD-94", limit: 2, offset: 0, filter: {} });
  assert(prefix.length === 2, `limit bounds the page (got ${prefix.length})`);
  assert(prefix.every((h) => h.totalCount === 3), `…while totalCount reports all 3 (${prefix.map((h) => h.totalCount).join(",")})`);

  const filtered = await store.keywordThoughts({ query: "ticket", limit: 10, offset: 0, filter: { kind: "nope" } });
  assert(filtered.length === 0, "the jsonb filter reaches the function");

  assert((await store.keywordThoughts({ query: "", limit: 10, offset: 0, filter: {} })).length === 0,
         "an empty query is zero rows, not the whole table");

  for (const c of ["ticket SMD-944 is open", "ticket SMD-9440 is open", "ticket SMD-94 is open"]) {
    await store.deleteThought({ id: (await store.keywordThoughts({ query: c, limit: 1, offset: 0, filter: {} }))[0].id });
  }
}

console.log("\n[3c] hybridThoughts fuses the two, and maps the fused row's shape");
{
  // Four scoreable rows at DISTINCT angles to the query — exact 1.0, near 0.9,
  // the literal's row 0.2, distant 0 — and a fifth, also carrying the literal,
  // with no vector at all. Distinct on purpose: match_thoughts breaks a
  // similarity tie in whatever order the plan produced, the fused function
  // breaks it by id, and a test with two orthogonal rows compared the two
  // conventions instead of the ranking.
  const faint = new Array(EMBEDDING_DIM).fill(0); faint[0] = 0.2; faint[1] = 0.98;
  await store.captureThought({ content: "ticket SMD-507 came up in the distant note", payload: { metadata: { kind: "b" } }, embedding: faint });
  const bare = new SQL({ url: URL_, max: 1 });
  await bare`SELECT upsert_thought(${"ticket SMD-507 with no vector yet"}, ${{ metadata: { kind: "b" } }}::jsonb)`;
  await bare.close();

  // No needle: the same rows in the same order as matchThoughts, similarity intact.
  const plain = await store.hybridThoughts({ query: "the exact thing", embedding: unit(0), threshold: -1, limit: 10, filter: {} });
  const vector = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 10, filter: {} });
  assert(plain.map((r) => r.id).join() === vector.map((r) => r.id).join(), `with no needle the fused order is matchThoughts' order (${plain.map((r) => r.content).join(" | ")})`);
  assert(plain.every((r) => Array.isArray(r.needles) && r.needles.length === 0 && Array.isArray(r.matchedNeedles) && r.literalOnly === false), "arrays come back as arrays, empty, and literalOnly false");
  // Migration 020: the store passes the recency blend's two inputs (defaults
  // 0 and 90) and maps the new `score` column, which equals similarity at
  // weight 0. Age the exact row two years and weight age fully: it drops from
  // first, its reported similarity unchanged; both stores must reorder alike.
  assert(vector.every((r) => typeof r.score === "number" && r.score === r.similarity), "matchThoughts maps score, equal to similarity at weight 0");
  const exact = vector[0]; // the row nearest the query, "exact"
  const aged = new SQL({ url: URL_, max: 1 });
  await aged`UPDATE thoughts SET created_at = now() - interval '2 years' WHERE id = ${exact.id}::uuid`;
  const byAge = await store.matchThoughts({ embedding: unit(0), threshold: -1, limit: 10, filter: {}, recencyWeight: 1 });
  const agedRow = byAge.find((r) => r.id === exact.id);
  assert(byAge[0].id !== exact.id && agedRow !== undefined && agedRow.similarity === exact.similarity && agedRow.score < agedRow.similarity,
         `at recency weight 1 the two-year-old exact match is no longer first (${byAge[0].content}), its similarity is still the raw cosine and its score is below it`);
  const fusedByAge = await store.hybridThoughts({ query: "the exact thing", embedding: unit(0), threshold: -1, limit: 10, filter: {}, recencyWeight: 1 });
  assert(fusedByAge.map((r) => r.id).join() === byAge.map((r) => r.id).join(), "…and the fused search follows the weighted order through its vector arm");
  await aged`UPDATE thoughts SET created_at = now() WHERE id = ${exact.id}::uuid`;
  await aged.close();

  // An identifier: exact hits first, the unembedded one with a null similarity.
  const hits = await store.hybridThoughts({ query: "SMD-507", embedding: unit(0), threshold: 0.5, limit: 10, filter: {} });
  assert(hits[0].content === "ticket SMD-507 came up in the distant note" && hits[0].matchedNeedles.join() === "SMD-507",
         `the exact hit comes first with its needle (${hits.map((h) => h.content).join(" | ")})`);
  assert(hits[1].content === "ticket SMD-507 with no vector yet" && hits[1].similarity === null,
         `a hit with no vector reports similarity null, not 0 (${JSON.stringify(hits[1]?.similarity)})`);
  assert(hits.every((h) => h.literalOnly === true && h.needles.join() === "SMD-507"), "every row carries the query-level fields");
  assert(typeof hits[0].score === "number" && hits[0].score > hits[2].score, "the score is a number and orders the rows");
  assert(typeof hits[0].created_at === "string" && ISO_RE.test(hits[0].created_at), "created_at is normalised to an ISO string, as every other store method does");

  const filtered = await store.hybridThoughts({ query: "SMD-507", embedding: unit(0), threshold: -1, limit: 10, filter: { kind: "a" } });
  assert(filtered.every((r) => r.matchedNeedles.length === 0), "the jsonb filter reaches the keyword arm");

  for (const c of ["ticket SMD-507 came up in the distant note", "ticket SMD-507 with no vector yet"]) {
    await store.deleteThought({ id: (await store.keywordThoughts({ query: c, limit: 1, offset: 0, filter: {} }))[0].id });
  }
}

console.log("\n[4] listThoughts reproduces the PostgREST filters");
{
  const all = await store.listThoughts({ limit: 10 });
  assert(all.length === 3, `unfiltered returns everything (got ${all.length})`);
  assert(all[0].created_at >= all[all.length - 1].created_at, "newest first");

  const byType = await store.listThoughts({ limit: 10, type: "note" });
  assert(byType.length === 0, "an unmatched type filter returns nothing");

  await store.captureThought({
    content: "tagged",
    payload: { metadata: { type: "note", topics: ["alpha", "beta"], people: ["Ada"] } },
    embedding: unit(2),
  });

  assert((await store.listThoughts({ limit: 10, type: "note" })).length === 1, "type filter matches");
  assert((await store.listThoughts({ limit: 10, topic: "alpha" })).length === 1, "topic filter matches inside an array");
  assert((await store.listThoughts({ limit: 10, topic: "gamma" })).length === 0, "a topic not present does not match");
  assert((await store.listThoughts({ limit: 10, person: "Ada" })).length === 1, "person filter matches inside an array");
  assert((await store.listThoughts({ limit: 10, days: 1 })).length === 4, "days window includes today's rows");
  assert((await store.listThoughts({ limit: 2 })).length === 2, "limit is honoured");

  const combined = await store.listThoughts({ limit: 10, type: "note", topic: "beta", person: "Ada", days: 1 });
  assert(combined.length === 1, "filters combine with AND");
}

console.log("\n[5] Stats counting and paging");
{
  assert((await store.countThoughts()) === 4, "countThoughts sees the whole corpus");

  const p1 = await store.pageThoughtMeta(0, 2);
  const p2 = await store.pageThoughtMeta(2, 2);
  const p3 = await store.pageThoughtMeta(4, 2);
  assert(p1.length === 2 && p2.length === 2, "pages fill to the requested size");
  assert(p3.length === 0, "a page past the end is empty, which ends the loop");

  const seen = new Set([...p1, ...p2].map((r) => String(r.created_at) + JSON.stringify(r.metadata)));
  assert(seen.size === 4, "pages do not overlap");
  assert(String(p1[0].created_at) >= String(p2[p2.length - 1].created_at), "ordering is stable across pages");
}

console.log("\n[5b] statsSummary aggregates the whole corpus in one SQL call (migration 024)");
{
  // The seeded corpus is a mix: three rows carry `kind` and no `type`/`topics`/
  // `people`, one row (the [4] listThoughts seed) carries type:"note",
  // topics:[alpha,beta], people:[Ada]. So this also covers rows with no arrays.
  const s = await store.statsSummary();
  assert(s.total === (await store.countThoughts()), "statsSummary.total equals countThoughts");
  assert(s.aggregated === s.total, "the SQL path covers the whole corpus — never truncates");
  assert(s.types["note"] === 1, `type tally is exact (${JSON.stringify(s.types)})`);
  assert(s.topics["alpha"] === 1 && s.topics["beta"] === 1, "topics unnest from the array");
  assert(s.people["Ada"] === 1, "people unnest from the array");
  assert(Object.keys(s.topics).length === 2, "a row with no topics array contributes none");
  assert(s.oldest !== null && s.newest !== null && s.oldest <= s.newest, "date range is a real span");
}

console.log("\n[6] Dedup and merge behave as the tools expect");
{
  const before = await store.countThoughts();
  const again = await store.captureThought({
    content: "  EXACT  ",
    payload: { metadata: { extra: 1 } },
    embedding: unit(0),
  });
  assert((await store.countThoughts()) === before, "a normalised duplicate adds no row");

  const merged = await store.getThought(again.id);
  assert(merged?.metadata.kind === "a" && merged?.metadata.extra === 1, "metadata merged rather than replaced");

  // 022: a thought captured with windows, re-captured through this store with
  // a vector and no chunks — the routing every chunkless capture takes —
  // keeps them while the label vouches for them, and loses them otherwise.
  const admin = new SQL({ url: URL_, max: 1 });
  const windowed = await store.captureThought({
    content: "a long thought, later short",
    payload: { metadata: {} },
    embedding: unit(1),
    embeddingModel: "unit-test-model",
    chunks: [{ content: "window one", embedding: unit(1) }, { content: "window two", embedding: unit(2) }],
  });
  const windows = async () => Number((await admin`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${windowed.id}`)[0].c);
  assert((await windows()) === 2, "a capture with two windows writes both");
  await store.captureThought({ content: "a long thought, later short", payload: { metadata: {} }, embedding: unit(3), embeddingModel: "unit-test-model" });
  assert((await windows()) === 2, "a re-capture with a vector and no chunks at the same model — the 3-argument routing — keeps the windows (migration 022)");
  await store.captureThought({ content: "a long thought, later short", payload: { metadata: {} }, embedding: unit(3), embeddingModel: "unit-test-model-2" });
  assert((await windows()) === 0, "…and at another model leaves none behind");
  await admin.close();
}

console.log("\n[7] Missing and malformed ids");
{
  assert((await store.getThought("11111111-2222-3333-4444-555555555555")) === null, "an absent uuid returns null");
  assert((await store.getThought("not-a-uuid")) === null, "a malformed id returns null, not a Postgres cast error");
}

console.log("\n[8] Errors surface rather than being swallowed");
{
  const broken = new SqlStore(URL_, { max: 1 });
  const admin = new SQL({ url: URL_, max: 1 });
  await admin.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE} RENAME TO match_thoughts_hidden`);
  let threw = false;
  try {
    await broken.matchThoughts({ embedding: unit(0), threshold: 0, limit: 1, filter: {} });
  } catch {
    threw = true;
  }
  assert(threw, "a missing RPC throws instead of returning an empty result set");
  await admin.unsafe(`ALTER FUNCTION ${MATCH_THOUGHTS_SIGNATURE.replace("match_thoughts(", "match_thoughts_hidden(")} RENAME TO match_thoughts`);
  await admin.close();
  await broken.close();
}

console.log("\n[9] Provenance: capture writes it, the read methods walk it, and the label lookup finds it (migration 025)");
{
  const parent = await store.captureThought({
    content: "provenance source: the original observation",
    payload: { metadata: { type: "observation", source: "mcp" } },
    embedding: unit(4),
  });
  const child = await store.captureThought({
    content: "provenance synthesis: a digest of the observation",
    payload: { metadata: { type: "synthesis", derivation_method: "synthesis", source: "mcp" } },
    embedding: unit(5),
    derivedFrom: [parent.id],
    supersedes: parent.id,
  });

  const back = await store.getThought(child.id);
  assert(back !== null, "the synthesis reads back");

  // trace UP: depth 0 is the child, depth 1 the source.
  const anc = await store.traceProvenance({ id: child.id });
  assert(anc.some((n) => n.thoughtId === child.id && n.depth === 0), "traceProvenance returns the thought itself at depth 0");
  const src = anc.find((n) => n.thoughtId === parent.id);
  assert(src?.depth === 1 && src.parentId === child.id, "…and its source at depth 1, parented by the child");
  // derivation_method is read from each node's metadata: the synthesis child has
  // one, the plain observation source does not.
  const self = anc.find((n) => n.thoughtId === child.id);
  assert(self?.derivationMethod === "synthesis" && src?.derivationMethod === null,
         `…derivation_method comes from metadata (child ${self?.derivationMethod}, source ${src?.derivationMethod})`);

  // find DOWN: the source's one derivative is the synthesis.
  const der = await store.findDerivatives({ id: parent.id });
  assert(der.length === 1 && der[0].id === child.id, `findDerivatives walks down to the synthesis (${der.length} found)`);

  // the label lookup: the source is superseded, by the child; the child is not.
  const sup = await store.supersededAmong([parent.id, child.id]);
  assert(sup[parent.id] === child.id, "supersededAmong maps the superseded source to its replacement");
  assert(!(child.id in sup), "…and does not mark the replacement itself");

  // An empty derived_from is "not derived", not "derived from nothing": it
  // normalises to a NULL column, end to end (review pass 1).
  const emptyProv = await store.captureThought({
    content: "provenance empty: an array that says nothing",
    payload: { metadata: {} },
    embedding: unit(7),
    derivedFrom: [],
  });
  const admin2 = new SQL({ url: URL_, max: 1 });
  const emptyRow = (await admin2`SELECT derived_from FROM thoughts WHERE id = ${emptyProv.id}`)[0] as { derived_from: unknown };
  await admin2.close();
  assert(emptyRow.derived_from === null, `an empty derivedFrom stores as NULL, not [] (${JSON.stringify(emptyRow.derived_from)})`);

  // validation lives at the write: a derived_from element that is not an
  // existing thought is refused, so a synthesis cannot claim a source it lacks.
  let bad = "";
  try {
    await store.captureThought({
      content: "provenance liar: derived from a ghost",
      payload: { metadata: {} },
      embedding: unit(6),
      derivedFrom: ["11111111-1111-1111-1111-111111111111"],
    });
  } catch (e) { bad = (e as Error).message; }
  assert(/does not exist/.test(bad), `a derived_from naming no thought is refused at the write (${bad.slice(0, 60)})`);

  // a malformed id is a clean no-match on the read methods, not a cast error.
  assert((await store.traceProvenance({ id: "not-a-uuid" })).length === 0, "traceProvenance of a malformed id is empty, not an error");
  assert((await store.findDerivatives({ id: "not-a-uuid" })).length === 0, "findDerivatives of a malformed id is empty, not an error");
  assert(Object.keys(await store.supersededAmong(["not-a-uuid"])).length === 0, "supersededAmong drops malformed ids");

  // Boyscout (SMD-1253 review): the two thin spots the passes named but held.
  //
  // (a) supersededAmong's id tiebreak. Two thoughts supersede one id; force
  // their created_at equal (a batch import in one transaction does this via
  // now()), and the winner must be the higher id — deterministically, and the
  // same one the PostgREST store's (created_at, id) DESC order picks.
  const admin3 = new SQL({ url: URL_, max: 1 });
  const old = await store.captureThought({ content: "tiebreak: the superseded original", payload: { metadata: {} }, embedding: unit(0) });
  const newA = await store.captureThought({ content: "tiebreak: replacement A", payload: { metadata: {} }, embedding: unit(1), supersedes: old.id });
  const newB = await store.captureThought({ content: "tiebreak: replacement B", payload: { metadata: {} }, embedding: unit(2), supersedes: old.id });
  await admin3`UPDATE thoughts SET created_at = now() WHERE id = ANY(${admin3.array([newA.id, newB.id], "TEXT")}::uuid[])`;
  const tie = await store.supersededAmong([old.id]);
  const higher = newA.id > newB.id ? newA.id : newB.id;
  assert(tie[old.id] === higher, `on an equal-created_at tie the higher id wins deterministically (${tie[old.id]?.slice(0, 8)} = ${higher.slice(0, 8)})`);
  await admin3.close();

  // (b) the cycle flag through the store's row mapper (test-live proves it at
  // the SQL level; this exercises `cycle: r.cycle === true` in the mapper). A
  // cycle cannot form through the validated write path, so force it by hand.
  const a = await store.captureThought({ content: "cycle A", payload: { metadata: {} }, embedding: unit(3) });
  const b = await store.captureThought({ content: "cycle B", payload: { metadata: {} }, embedding: unit(4), derivedFrom: [a.id] });
  const admin4 = new SQL({ url: URL_, max: 1 });
  await admin4`UPDATE thoughts SET derived_from = ${[b.id]}::jsonb WHERE id = ${a.id}`;
  await admin4.close();
  const walk = await store.traceProvenance({ id: b.id, maxDepth: 10 });
  assert(walk.some((n) => n.cycle === true), "traceProvenance surfaces the cycle flag through the store mapper");
}

await store.close();

report();
