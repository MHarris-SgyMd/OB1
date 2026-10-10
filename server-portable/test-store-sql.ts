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
import { createHash } from "node:crypto";
import { applyMigrations, createAssert, ISO_RE, plantLegacyRow, resetSchema } from "../db/test-support.ts";
import { MATCH_THOUGHTS_SIGNATURE } from "../db/config.mjs";
import { createStore } from "./store.ts";
import { SQL } from "bun";

const URL_ = process.env.DATABASE_URL;

if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-store-sql.ts");
  process.exit(2);
}

/** The schema's shape for this suite; resetSchema substitutes them into the migration templates. */
const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? 1536);
const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

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

  // Change 97 (SMD-1797): so does no OB1_STORE at all — the default this job
  // runs against real Postgres. The factory's refusals are test-server [14]'s.
  const d = await createStore({ DATABASE_URL: URL_ });
  assert(d.kind === "sql", "OB1_STORE unset yields the SQL store — the default");
  assert((await d.countThoughts()) === 0, "…and it reaches the database");
  await d.close();

  let threw = "";
  try {
    await createStore({ OB1_STORE: "sql" });
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(/OB1_STORE=sql selects the SQL store, and DATABASE_URL is not set/.test(threw), "sql without DATABASE_URL is rejected up front, naming the selection");

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

  // The provenance envelope rides as the ninth argument (032): a key named
  // is written, a key absent is left, null clears; a refusal comes back as
  // the store's discriminated union rather than a throw.
  const older = await store.captureThought({ content: "the earlier version", payload: { metadata: {} }, embedding: unit(1) });
  const prov = async () => (await admin`SELECT supersedes AS s, derived_from AS d FROM thoughts WHERE id = ${r.id}`)[0] as { s: string | null; d: string[] | null };
  const set = await store.updateThought({ id: r.id, provenance: { supersedes: older.id } });
  assert(set.ok && (await prov()).s === older.id, "an edit naming supersedes writes the pointer through update_thought's envelope");
  const derived = await store.updateThought({ id: r.id, provenance: { derivedFrom: [older.id] } });
  assert(derived.ok && (await prov()).s === older.id && JSON.stringify((await prov()).d) === JSON.stringify([older.id]), "…derivedFrom alone replaces the array and leaves the pointer");
  const untouched = await store.updateThought({ id: r.id, metadataPatch: { again: true } });
  assert(untouched.ok && (await prov()).s === older.id, "…an edit without provenance sends NULL and leaves both");
  const cleared = await store.updateThought({ id: r.id, provenance: { supersedes: null, derivedFrom: null } });
  assert(cleared.ok && (await prov()).s === null && (await prov()).d === null, "…and null clears both");
  const loop = await store.updateThought({ id: older.id, provenance: { supersedes: older.id } });
  assert(!loop.ok && loop.error === "WOULD_CYCLE", `a self-pointer is the WOULD_CYCLE refusal, not a throw (${JSON.stringify(loop)})`);
  const ghost = await store.updateThought({ id: r.id, provenance: { supersedes: "00000000-0000-4000-8000-000000000000" } });
  assert(!ghost.ok && ghost.error === "SUPERSEDES_NOT_FOUND", `a pointer at no thought is SUPERSEDES_NOT_FOUND (${JSON.stringify(ghost)})`);
  await admin`DELETE FROM thoughts WHERE id = ${older.id}`;
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

  // prefer_current (059, SMD-2255): the store calls search_thoughts_current and
  // maps its three extra fields; without the flag the rows carry fused =
  // score, nothing demoted and no window. The row nearest the query, stamped a
  // completed ticket, is demoted: no longer first, weighted exactly 0.25.
  assert(plain.every((r) => r.fused === r.score && r.demoted.length === 0 && r.window === undefined), "without prefer_current every row carries fused = score, nothing demoted and no window");
  const stampSql = new SQL({ url: URL_, max: 1 });
  await stampSql`UPDATE thoughts SET metadata = metadata || ${{ source: "linear", issue: "SMD-9901", status: "Done", status_type: "completed", linear_updated_at: "2026-09-25T00:00:00.000Z" }}::jsonb WHERE id = ${plain[0].id}::uuid`;
  const offAgain = await store.hybridThoughts({ query: "the exact thing", embedding: unit(0), threshold: -1, limit: 10, filter: {} });
  const onCurrent = await store.hybridThoughts({ query: "the exact thing", embedding: unit(0), threshold: -1, limit: 10, filter: {}, preferCurrent: true });
  const demotedRow = onCurrent.find((r) => r.id === plain[0].id);
  assert(offAgain[0].id === plain[0].id && onCurrent[0].id !== plain[0].id && demotedRow !== undefined && demotedRow.demoted.join() === "completed" && demotedRow.score === demotedRow.fused * 0.25
      && onCurrent.filter((r) => r.id !== plain[0].id).every((r) => r.demoted.length === 0 && r.score === r.fused)
      && onCurrent.every((r) => r.window !== undefined && r.window.demoted === 1 && r.window.known === 1 && r.window.syncedAt === "2026-09-25T00:00:00.000Z" && r.window.exact === true)
      && [...onCurrent.map((r) => r.id)].sort().join() === [...offAgain.map((r) => r.id)].sort().join(),
    `with preferCurrent the completed row nearest the query is demoted — no longer first, marked completed, 0.25 of its fused score — the rest untouched, the window mapped on every row (${onCurrent.map((r) => r.demoted.join("+") || "-").join(" ")})`);
  await stampSql`UPDATE thoughts SET metadata = metadata - 'source' - 'issue' - 'status' - 'status_type' - 'linear_updated_at' WHERE id = ${plain[0].id}::uuid`;
  await stampSql.close();

  for (const c of ["ticket SMD-507 came up in the distant note", "ticket SMD-507 with no vector yet"]) {
    await store.deleteThought({ id: (await store.keywordThoughts({ query: c, limit: 1, offset: 0, filter: {} }))[0].id });
  }
}

console.log("\n[4] listThoughts reproduces the PostgREST filters");
{
  const all = await store.listThoughts({ limit: 10 });
  assert(all.length === 3, `unfiltered returns everything (got ${all.length})`);
  const firstDate = all[0].created_at, lastDate = all[all.length - 1].created_at;
  assert(firstDate != null && lastDate != null && firstDate >= lastDate, "newest first");

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

  // SMD-1726: the two keys migration 050 stamps from the write's envelope, as
  // containment beside the others. The store's own capture carries the actor;
  // the registry classifies the key. Two rows in, two rows out, so [5]'s
  // counts hold.
  const raw = new SQL({ url: URL_, max: 1 });
  await raw`SELECT set_agent_kind('op-key', 'operator')`;
  const opRow = await store.captureThought({ content: "the operator's own line", payload: { metadata: { type: "note" } }, embedding: unit(3), actor: { name: "op-key", via: "test-store-sql" } });
  const whoRow = await store.captureThought({ content: "an unclassified key's line", payload: { metadata: {} }, embedding: unit(4), actor: { name: "who-key", via: "test-store-sql" } });
  assert((await store.listThoughts({ limit: 10, saidBy: "operator" })).map((r) => r.id).join() === opRow.id, "saidBy matches metadata.actor_kind — the operator's row and no other");
  assert((await store.listThoughts({ limit: 10, actor: "op-key" })).length === 1 && (await store.listThoughts({ limit: 10, actor: "who-key" })).map((r) => r.id).join() === whoRow.id, "actor matches metadata.actor_name, classified key or not");
  assert((await store.listThoughts({ limit: 10, saidBy: "agent" })).length === 0, "an unmatched kind returns nothing");
  assert((await store.listThoughts({ limit: 10, saidBy: "operator", type: "note" })).length === 1 && (await store.listThoughts({ limit: 10, saidBy: "operator", type: "idea" })).length === 0, "…and they combine with the others by AND");
  await raw`DELETE FROM thoughts WHERE id = ${opRow.id}::uuid OR id = ${whoRow.id}::uuid`;
  await raw.close();
}

console.log("\n[5] Stats counting and paging");
{
  assert((await store.countThoughts()) === 4, "countThoughts sees the whole corpus");

  const p1 = await store.pageThoughtMeta(0, 2);
  const p2 = await store.pageThoughtMeta(2, 2);
  const p3 = await store.pageThoughtMeta(4, 2);
  assert(p1.length === 2 && p2.length === 2, "pages fill to the requested size");
  assert(p3.length === 0, "a page past the end is empty, which ends the loop");

  // Every seeded row is dated, so the walk's column must come back ISO on each —
  // a null here would mean the column went missing, not that a row is undated.
  assert([...p1, ...p2].every((r) => r.created_at !== null && ISO_RE.test(r.created_at)), "every page row carries an ISO created_at");
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

console.log("\n[5c] listThoughtIds — the id set, its digest and keyset paging (SMD-2244)");
{
  const total = await store.countThoughts();
  const first = await store.listThoughtIds({ limit: 100, after: null });
  assert(first.ids.length === total && first.total === total, `first page returns the whole small corpus and its total (${first.ids.length}/${first.total} of ${total})`);
  assert(first.cursor === null, "a page shorter than the limit ends the walk (null cursor)");
  const sorted = [...first.ids].sort();
  assert(first.ids.join() === sorted.join(), "ids come back in id order");
  // The digest is md5 of all ids joined by ',' in id order — recompute it to prove it.
  const want = createHash("md5").update(sorted.join(",")).digest("hex");
  assert(first.digest === want, `the first-page digest is md5(sorted ids) (${first.digest})`);

  // Keyset paging: two pages of two cover the set with no overlap, and total/digest
  // ride only the first page.
  const pa = await store.listThoughtIds({ limit: 2, after: null });
  assert(pa.ids.length === 2 && pa.cursor === pa.ids[1], "a full page carries a cursor = its last id");
  assert(pa.total === total && pa.digest !== null, "total and digest ride the first page");
  const pb = await store.listThoughtIds({ limit: 2, after: pa.cursor });
  assert(pb.total === 0 && pb.digest === null, "a later page carries no total and no digest");
  const walked = [...pa.ids, ...pb.ids];
  assert(new Set(walked).size === Math.min(4, total) && walked.every((id, i) => i === 0 || id > walked[i - 1]), "the walk is strictly increasing and does not repeat");

  // A malformed cursor is treated as the start, not a driver cast error.
  const bad = await store.listThoughtIds({ limit: 100, after: "not-a-uuid" });
  assert(bad.ids.length === total, "a non-uuid cursor reads as the first page");

  // limit 0: an empty page whose cursor is null, not undefined (review pass 3).
  const zero = await store.listThoughtIds({ limit: 0, after: null });
  assert(zero.ids.length === 0 && zero.cursor === null, "limit 0 yields no ids and a null cursor (not undefined)");
}

console.log("\n[5d] listLoggedSearches — the search rows of query_log, windowed and bounded (SMD-2245)");
{
  const raw = new SQL({ url: URL_, max: 1 });
  try {
    await raw`DELETE FROM query_log`; // isolate this section
    await raw`INSERT INTO query_log (kind, tool, query, arm, match_count, threshold, recency_weight, filter, tier, logged_at) VALUES
      ('search','search_thoughts_keyword','older query','keyword',25,NULL,NULL,'{}'::jsonb,'stable', now() - interval '2 hours'),
      ('search','search_thoughts','newer query','hybrid',10,0.5,0.25,'{"type":"note"}'::jsonb,NULL, now() - interval '1 hour')`;
    await raw`INSERT INTO query_log (kind, tool, target_id) VALUES ('action','fetch', gen_random_uuid())`; // an action row — excluded by kind='search'
    const all = await store.listLoggedSearches({ since: null, limit: 100 });
    assert(all.searches.length === 2 && !all.truncated, `two search rows — the action row is excluded (${all.searches.length})`);
    assert(all.searches[0].query === "newer query" && all.searches[0].arm === "hybrid", "most recent first");
    assert(all.searches[0].matchCount === 10 && all.searches[0].threshold === 0.5 && all.searches[0].recencyWeight === 0.25, "the search's arguments come back");
    assert(JSON.stringify(all.searches[0].filter) === JSON.stringify({ type: "note" }), "the filter is an object, not a string");
    assert(all.searches[1].query === "older query" && all.searches[1].tier === "stable", "the older row, with its tier");
    assert(all.searches.every((s) => s.loggedAt !== null && ISO_RE.test(s.loggedAt)), "loggedAt is ISO on each");
    const one = await store.listLoggedSearches({ since: null, limit: 1 });
    assert(one.searches.length === 1 && one.truncated === true && one.searches[0].query === "newer query", "limit 1 returns the newest and flags truncated");
    const recent = await store.listLoggedSearches({ since: new Date(Date.now() - 90 * 60 * 1000).toISOString(), limit: 100 });
    assert(recent.searches.length === 1 && recent.searches[0].query === "newer query", "since excludes the two-hour-old row");
    const emptySince = await store.listLoggedSearches({ since: "", limit: 100 });
    assert(emptySince.searches.length === 2, "an empty since is no window, not a ''::timestamptz cast error (review pass 2)");
    await raw`DELETE FROM query_log`;
  } finally {
    await raw.close();
  }
}

console.log("\n[5e] workerStatus — per-work_type counts, stale leases and the active flag (SMD-2131)");
{
  const raw = new SQL({ url: URL_, max: 1 });
  try {
    // Ten thoughts of our own to pool, so the counts are exact regardless of the
    // corpus this section inherits. Captured before the key is set, so the capture
    // trigger enqueues nothing; the DELETE then clears the slate.
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await store.captureThought({ content: `worker-status pool thought ${i}`, payload: { metadata: {} }, embedding: unit(i % EMBEDDING_DIM) })).id);
    await raw`DELETE FROM thought_work_claims`; // isolate this section from any trigger-enqueued rows
    const total = await store.countThoughts();
    const ACTIVE = "extract:test-model@p2";
    const ORPHAN = "extract:test-model@p1";
    const CONSOL = "consolidate:test-judge@p1";
    // Set the active extraction key so ACTIVE reads active:true and ORPHAN false.
    await raw`INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', ${ACTIVE}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    // Exact rows for ACTIVE, DISTINCT per status so a swapped filter is caught:
    // 4 pending, 3 claimed (1 fresh + 2 stale, oldest = w-dead at −26h), 2 succeeded, 1 failed.
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status) VALUES
      (${ids[0]}::uuid, ${ACTIVE}, 'pending'), (${ids[1]}::uuid, ${ACTIVE}, 'pending'),
      (${ids[2]}::uuid, ${ACTIVE}, 'pending'), (${ids[3]}::uuid, ${ACTIVE}, 'pending')`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at) VALUES
      (${ids[4]}::uuid, ${ACTIVE}, 'claimed', 'w-fresh', now(), now() + interval '5 minutes'),
      (${ids[5]}::uuid, ${ACTIVE}, 'claimed', 'w-dead', now() - interval '26 hours', now() - interval '26 hours'),
      (${ids[6]}::uuid, ${ACTIVE}, 'claimed', 'w-stale2', now() - interval '25 hours', now() - interval '25 hours')`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, finished_at) VALUES
      (${ids[7]}::uuid, ${ACTIVE}, 'succeeded', 'w1', now()), (${ids[8]}::uuid, ${ACTIVE}, 'succeeded', 'w1', now())`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, finished_at, last_error) VALUES
      (${ids[9]}::uuid, ${ACTIVE}, 'failed', 'w1', now(), 'boom')`;
    // A superseded pool and a consolidate pool, one pending row each.
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status) VALUES (${ids[0]}::uuid, ${ORPHAN}, 'pending'), (${ids[0]}::uuid, ${CONSOL}, 'pending')`;

    const st = await store.workerStatus();
    const active = st.find((r) => r.workType === ACTIVE);
    assert(!!active && active.pending === 4 && active.claimed === 3 && active.succeeded === 2 && active.failed === 1, `ACTIVE counts: 4 pending, 3 claimed (1 fresh + 2 stale), 2 succeeded, 1 failed (${JSON.stringify(active)})`);
    assert(active!.thoughts === total && active!.unpooled === total - 10, `thoughts is the corpus (${active!.thoughts}), unpooled = corpus − 10 pooled (${active!.unpooled})`);
    assert(active!.stale === 2 && active!.staleWorkerId === "w-dead" && active!.oldestStaleClaimedAt !== null && ISO_RE.test(active!.oldestStaleClaimedAt), `2 stale leases; the OLDEST is the dead worker's, with its claimed_at (${active!.stale}, ${active!.staleWorkerId})`);
    assert(active!.active === true, "the entity_extraction_key work_type reads active: true");
    const orphan = st.find((r) => r.workType === ORPHAN);
    assert(!!orphan && orphan.pending === 1 && orphan.stale === 0 && orphan.active === false, "a superseded extract pool reads active: false");
    const consol = st.find((r) => r.workType === CONSOL);
    assert(!!consol && consol.active === null, "a consolidate pool (no recorded active key) reads active: null");
    // Cleanup so later sections and their capture trigger are not polluted.
    await raw`DELETE FROM thought_work_claims`;
    await raw`DELETE FROM ob1_config WHERE key = 'entity_extraction_key'`;
  } finally {
    await raw.close();
  }
}

console.log("\n[5f] retryFailed and releaseStaleLeases — the write half of worker_status (SMD-2132)");
{
  const raw = new SQL({ url: URL_, max: 1 });
  try {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await store.captureThought({ content: `worker-action pool thought ${i}`, payload: { metadata: {} }, embedding: unit(i % EMBEDDING_DIM) })).id);
    await raw`DELETE FROM thought_work_claims`; // isolate from any trigger-enqueued rows
    const A = "extract:action-model@p2";
    const B = "extract:action-model@p1";

    // ── retryFailed: pool A has 2 failed + 1 succeeded + 1 pending; pool B has 1 failed.
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, finished_at, last_error, attempt_count) VALUES
      (${ids[0]}::uuid, ${A}, 'failed', 'w1', now(), 'boom', 3),
      (${ids[1]}::uuid, ${A}, 'failed', 'w1', now(), 'boom', 3)`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, finished_at) VALUES (${ids[2]}::uuid, ${A}, 'succeeded', 'w1', now())`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status) VALUES (${ids[3]}::uuid, ${A}, 'pending')`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, finished_at, last_error, attempt_count) VALUES (${ids[4]}::uuid, ${B}, 'failed', 'w1', now(), 'boom', 3)`;

    const rf = await store.retryFailed(A);
    assert(rf.workType === A && rf.retried === 2 && rf.ids.length === 2 && new Set(rf.ids).size === 2, `retryFailed reports 2 requeued ids for A (${JSON.stringify(rf)})`);
    assert([ids[0], ids[1]].every((id) => rf.ids.includes(id)), "the reported ids are A's two failed thoughts");
    const aRows = await raw`SELECT thought_id::text AS id, status, last_error, finished_at, attempt_count FROM thought_work_claims WHERE work_type = ${A}`;
    const aReset = (aRows as Record<string, unknown>[]).filter((r) => r.id === ids[0] || r.id === ids[1]);
    assert(aReset.length === 2 && aReset.every((r) => r.status === "pending" && r.last_error === null && r.finished_at === null && Number(r.attempt_count) === 0), `A's failed rows are pending with error/finish/attempt reset (${JSON.stringify(aReset)})`);
    const bStill = await raw`SELECT status FROM thought_work_claims WHERE work_type = ${B} AND thought_id = ${ids[4]}::uuid`;
    assert(bStill.length === 1 && bStill[0].status === "failed", "a sibling pool's failed row is untouched — retryFailed is scoped to its work_type");
    const aSucc = await raw`SELECT status FROM thought_work_claims WHERE work_type = ${A} AND thought_id = ${ids[2]}::uuid`;
    assert(aSucc[0].status === "succeeded", "a succeeded row in the same pool is not requeued");
    // Idempotent: nothing failed now, so a second call moves nothing.
    const rf2 = await store.retryFailed(A);
    assert(rf2.retried === 0 && rf2.ids.length === 0, "retryFailed on a pool with no failures reports 0");

    // ── releaseStaleLeases: A has 1 stale (w-dead, attempt 2) + 1 live (w-live); B has 1 stale (w-dead-b).
    await raw`DELETE FROM thought_work_claims`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at, attempt_count) VALUES
      (${ids[0]}::uuid, ${A}, 'claimed', 'w-dead', now() - interval '26 hours', now() - interval '26 hours', 2),
      (${ids[1]}::uuid, ${A}, 'claimed', 'w-live', now(), now() + interval '10 minutes', 1)`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at, attempt_count) VALUES
      (${ids[2]}::uuid, ${B}, 'claimed', 'w-dead-b', now() - interval '25 hours', now() - interval '25 hours', 1)`;

    // Default: release every STALE lease across pools; the live one survives.
    const rl = await store.releaseStaleLeases({});
    assert(rl.released === 2 && rl.ids.length === 2 && new Set(rl.workers).size === 2 && rl.workers.includes("w-dead") && rl.workers.includes("w-dead-b"), `default release returns the 2 stale leases and their holders (${JSON.stringify(rl)})`);
    const live = await raw`SELECT status, worker_id, ttl_expires_at FROM thought_work_claims WHERE thought_id = ${ids[1]}::uuid AND work_type = ${A}`;
    assert(live.length === 1 && live[0].status === "claimed" && live[0].worker_id === "w-live", "the LIVE lease is left claimed — a default release never touches an unexpired lease");
    const deadRow = await raw`SELECT status, ttl_expires_at, attempt_count FROM thought_work_claims WHERE thought_id = ${ids[0]}::uuid AND work_type = ${A}`;
    assert(deadRow[0].status === "pending" && deadRow[0].ttl_expires_at === null && Number(deadRow[0].attempt_count) === 1, `a released stale lease is pending, ttl cleared, attempt decremented 2→1 (${JSON.stringify(deadRow[0])})`);

    // Scoping: re-seed A stale + B stale; release A only.
    await raw`DELETE FROM thought_work_claims`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at) VALUES
      (${ids[0]}::uuid, ${A}, 'claimed', 'w-dead', now() - interval '2 hours', now() - interval '2 hours'),
      (${ids[1]}::uuid, ${B}, 'claimed', 'w-dead', now() - interval '2 hours', now() - interval '2 hours')`;
    const rlA = await store.releaseStaleLeases({ workType: A });
    assert(rlA.released === 1 && rlA.ids[0] === ids[0], "releaseStaleLeases scoped to a work_type touches only that pool");
    const bStale = await raw`SELECT status FROM thought_work_claims WHERE work_type = ${B} AND thought_id = ${ids[1]}::uuid`;
    assert(bStale[0].status === "claimed", "the other pool's stale lease is left for a call that names it");

    // include_live: reach a lease that has NOT lapsed, by holder.
    await raw`DELETE FROM thought_work_claims`;
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at) VALUES
      (${ids[0]}::uuid, ${A}, 'claimed', 'w-live', now(), now() + interval '10 minutes'),
      (${ids[1]}::uuid, ${A}, 'claimed', 'w-other', now(), now() + interval '10 minutes')`;
    const rlLive = await store.releaseStaleLeases({ workType: A, workerId: "w-live", includeLive: true });
    assert(rlLive.released === 1 && rlLive.ids[0] === ids[0] && rlLive.workers[0] === "w-live", "include_live with a worker_id releases that holder's live lease alone");
    const other = await raw`SELECT status FROM thought_work_claims WHERE thought_id = ${ids[1]}::uuid AND work_type = ${A}`;
    assert(other[0].status === "claimed", "another holder's live lease is untouched");
    // Backstop: includeLive without a workerId throws rather than releasing every live lease.
    let threw = "";
    try { await store.releaseStaleLeases({ includeLive: true }); } catch (e) { threw = (e as Error).message; }
    assert(/includeLive requires a workerId/.test(threw), `includeLive with no workerId is refused at the store (${threw.slice(0, 60)})`);
    const stillClaimed = await raw`SELECT count(*)::int AS n FROM thought_work_claims WHERE status = 'claimed'`;
    assert(stillClaimed[0].n === 1, "…and released nothing (the w-other live lease still stands)");

    await raw`DELETE FROM thought_work_claims`;
  } finally {
    await raw.close();
  }
}

console.log("\n[5g] dryRunClaim — run_worker's dry_run preview: the census matches workerStatus, bounded by limit, claiming nothing (SMD-2272)");
{
  const raw = new SQL({ url: URL_, max: 1 });
  try {
    const ids = (await raw`SELECT id::text AS id FROM thoughts ORDER BY id LIMIT 5`).map((r: { id: string }) => r.id);
    assert(ids.length === 5, "five corpus thoughts to pool");
    await raw`DELETE FROM thought_work_claims`;
    const WT = "extract:dryrun-model@p2";
    const total = await store.countThoughts();
    // A mixed pool of 5: pending, stale-claimed, live-claimed, succeeded, failed.
    // ttl_expires_at is set iff status='claimed' (migration 015's CHECK); a
    // terminal row carries finished_at, not a ttl.
    await raw`INSERT INTO thought_work_claims (thought_id, work_type, status, worker_id, claimed_at, ttl_expires_at, finished_at) VALUES
      (${ids[0]}::uuid, ${WT}, 'pending',   NULL,     NULL,                       NULL,                          NULL),
      (${ids[1]}::uuid, ${WT}, 'claimed',   'w-dead', now() - interval '2 hours', now() - interval '2 hours',    NULL),
      (${ids[2]}::uuid, ${WT}, 'claimed',   'w-live', now(),                      now() + interval '10 minutes', NULL),
      (${ids[3]}::uuid, ${WT}, 'succeeded', 'w',      now(),                      NULL,                          now()),
      (${ids[4]}::uuid, ${WT}, 'failed',    'w',      now(),                      NULL,                          now())`;
    const beforeN = Number((await raw`SELECT count(*)::int AS n FROM thought_work_claims WHERE work_type = ${WT}`)[0].n);

    // ── The census: same four counts and stale subset as workerStatus.
    const dr = await store.dryRunClaim(WT);
    assert(dr.workType === WT && dr.pending === 1 && dr.claimed === 2 && dr.stale === 1 && dr.succeeded === 1 && dr.failed === 1, `dryRunClaim reports the pool census (${JSON.stringify(dr)})`);
    assert(dr.thoughts === total && dr.unpooled === total - 5, `unpooled = corpus − pooled (${dr.unpooled} = ${total} − 5)`);
    assert(dr.backlog === dr.pending + dr.stale + dr.unpooled && dr.wouldClaim === dr.backlog && dr.limit === null, `backlog = pending + stale + unpooled (stale leases reap and drain too), wouldClaim = backlog with no limit (${JSON.stringify(dr)})`);
    // Concretely: the 1 pending AND the 1 stale lease both count toward the backlog
    // (a pass reaps the stale one back to pending before claiming), so it is unpooled+2, not unpooled+1.
    assert(dr.backlog === dr.unpooled + 2, `the stale lease is in the backlog, not only the pending row (unpooled + 2 = ${dr.unpooled} + 2, got ${dr.backlog})`);

    // ── limit bounds wouldClaim, never the backlog; a limit above the backlog does not inflate it.
    const drLim = await store.dryRunClaim(WT, 1);
    assert(drLim.wouldClaim === 1 && drLim.limit === 1 && drLim.backlog === dr.backlog, `a limit caps wouldClaim (${JSON.stringify(drLim)})`);
    const drBig = await store.dryRunClaim(WT, dr.backlog + 100);
    assert(drBig.wouldClaim === dr.backlog && drBig.limit === dr.backlog + 100, "a limit above the backlog leaves wouldClaim at the backlog");

    // ── It claims NOTHING — the pool is unchanged (count and the status multiset).
    assert(Number((await raw`SELECT count(*)::int AS n FROM thought_work_claims WHERE work_type = ${WT}`)[0].n) === beforeN, "dryRunClaim inserted/claimed nothing");
    const statuses = (await raw`SELECT status FROM thought_work_claims WHERE work_type = ${WT}`).map((r: { status: string }) => r.status).sort();
    assert(JSON.stringify(statuses) === JSON.stringify(["claimed", "claimed", "failed", "pending", "succeeded"]), `no status changed (${JSON.stringify(statuses)})`);

    // ── An un-enqueued pool: no claim rows → all-zero census, unpooled = the whole corpus.
    const drEmpty = await store.dryRunClaim("extract:never-enqueued@p9");
    assert(drEmpty.pending === 0 && drEmpty.claimed === 0 && drEmpty.stale === 0 && drEmpty.unpooled === total && drEmpty.backlog === total, `an un-enqueued pool reads all-zero with unpooled = corpus (${JSON.stringify(drEmpty)})`);

    // ── It agrees with workerStatus for the same pool (the guard's "same pool worker_status shows").
    const ws = (await store.workerStatus()).find((r) => r.workType === WT);
    assert(!!ws && ws.pending === dr.pending && ws.claimed === dr.claimed && ws.stale === dr.stale && ws.unpooled === dr.unpooled && ws.thoughts === dr.thoughts, `dryRunClaim and workerStatus agree on the pool (${JSON.stringify(ws)})`);

    await raw`DELETE FROM thought_work_claims`;
  } finally {
    await raw.close();
  }
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
  assert(again.existed === true && again.supersedes === null, "…and the store passes 035's existed and the row's supersedes (none) through, so the capture tool can say what stands");

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

console.log("\n[8b] captureActorOf reads the capture row's actor, the lower id first on a tied created_at (SMD-1298)");
{
  const owned = await store.captureThought({
    content: "a thought whose capture row names its owner",
    payload: { metadata: { source: "mcp" } },
    embedding: unit(6),
    actor: { name: "owner", via: "store-test" },
  });
  const first = await store.captureActorOf(owned.id);
  assert(first?.actorName === "owner", `the capture row's actor is read back (${first?.actorName})`);
  // A second capture row with the SAME created_at (theory: one per thought by construction) — the tiebreak is the id, a uuid, so the lowest id is the owner every time, not whichever row the planner met first.
  const sql = new SQL({ url: URL_, max: 1 });
  // A whole-row copy carries thought_audit.seq (050's identity, GENERATED ALWAYS — a
  // writer may not assign it); the copy keeps the source's value by saying so.
  await sql`INSERT INTO thought_audit OVERRIDING SYSTEM VALUE SELECT (json_populate_record(t, '{"id":"00000000-0000-4000-8000-000000000000","actor_name":"first-by-id"}'::json)).* FROM thought_audit t WHERE t.thought_id = ${owned.id}::uuid AND t.action = 'capture'`;
  const tied = await store.captureActorOf(owned.id);
  assert(tied?.actorName === "first-by-id", `on a tied created_at the lower id's actor is returned (${tied?.actorName})`);
  assert((await store.captureActorOf("0000dead-0000-4000-8000-000000000000")) === null && (await store.captureActorOf("not-an-id")) === null, "a ghost and a malformed id read as no row");
  await sql.close();
}

console.log("\n[8c] takenFromCapturer, the re-capture note and the lapse: migration 082's one rule (SMD-2638)");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const resolved = async (label: string, scope: string, seed: string) => {
    const r = await store.resolveAgent({ keyHash: seed.repeat(32), label, scope });
    return r.ok ? r.agentId : "";
  };
  const hookId = await resolved("hook-8c", "capture", "8c");
  const writerId = await resolved("writer-8c", "write", "c8");
  const otherId = await resolved("other-8c", "write", "d8");
  assert(hookId !== "" && writerId !== "" && otherId !== "" && new Set([hookId, writerId, otherId]).size === 3, "setup: three agents resolved");
  const hook = { name: "hook-8c", agentId: hookId, via: "store-test", scope: "capture" as const };
  const writer = { name: "writer-8c", agentId: writerId, via: "store-test" };
  const other = { name: "other-8c", agentId: otherId, via: "store-test" };
  const boardSync = { name: "board-sync", via: "db/sync-linear.ts" };
  const backfill = { name: "backfill", via: "backfill_thought_actors" };
  const made: string[] = [];
  const capture = async (content: string, actor: typeof hook | typeof writer, extra: { supersedes?: string; recapture?: "keep"; metadata?: Record<string, unknown> } = {}) => {
    const r = await store.captureThought({ content, payload: { metadata: { source: "mcp", ...(extra.metadata ?? {}) } }, embedding: unit(7), actor, supersedes: extra.supersedes, recapture: extra.recapture });
    made.push(r.id);
    return r;
  };
  const taken = (id: string) => store.takenFromCapturer(id);
  const rows = async (id: string) => (await sql`SELECT canonical_agent_id::text AS agent, diff FROM thought_audit WHERE thought_id = ${id}::uuid AND action = 'update' ORDER BY seq`) as { agent: string | null; diff: Record<string, unknown> }[];

  // What does not take a thought from its capturer.
  const own = await capture("[8c] the hook's thought, taken by nobody", hook);
  const older = await capture("[8c] an older thought the writer points the hook's at", hook);
  assert((await taken(own.id)) === false, "the capturer's own thought, untouched: not taken");
  await sql`UPDATE thoughts SET embedding = NULL WHERE id = ${own.id}::uuid`;
  assert((await store.updateThought({ id: own.id, provenance: { supersedes: older.id }, actor: writer })).ok === true, "setup: the writer's pointer-only edit lands");
  await store.updateThought({ id: own.id, metadataPatch: { note: "its own" }, actor: hook });
  await store.updateThought({ id: own.id, metadataPatch: { enriched: true }, actor: backfill });
  const quiet = await rows(own.id);
  assert(quiet.length === 4 && quiet.filter((r) => r.agent === null && "metadata" in r.diff).length === 1 && quiet.filter((r) => r.agent === writerId && "supersedes" in r.diff).length === 1,
    `setup: a vector row and an unattributed metadata row with no agent, the writer's pointer row, its own metadata row (${JSON.stringify(quiet.map((r) => [r.agent === null ? "none" : r.agent === hookId ? "hook" : "writer", Object.keys(r.diff)]))})`);
  assert((await taken(own.id)) === false, "…a vector, a pointer set by another, its own metadata move and an unattributed metadata move with no `issue` (an operator's backfill) do not take it");
  const kept = await capture("[8c] the hook's thought another capture key re-sends", hook);
  await capture("[8c] the hook's thought another capture key re-sends", { ...hook, name: "other-hook", agentId: otherId }, { recapture: "keep" });
  assert((await rows(kept.id)).length === 0 && (await taken(kept.id)) === false, "a capture-only key's re-capture ('keep') records nothing and does not take it");

  // What does.
  const merged = await capture("[8c] the hook's thought the writer merges onto", hook);
  await capture("[8c] the hook's thought the writer merges onto", writer, { metadata: { project: "8c" } });
  const recaptured = await capture("[8c] the hook's thought the writer re-captures, changing nothing", hook);
  const noop = await capture("[8c] the hook's thought the writer re-captures, changing nothing", writer);
  const adopted = await capture("[8c] the hook's thought board-sync adopts", hook);
  await store.updateThought({ id: adopted.id, metadataPatch: { issue: "TKT-2638", status: "In Progress" }, actor: boardSync });
  const rewritten = await capture("[8c] the hook's thought an unattributed writer rewrites", hook);
  await sql`UPDATE thoughts SET content = '[8c] a raw writer''s text' WHERE id = ${rewritten.id}::uuid`;
  const edited = await capture("[8c] the hook's thought the writer edits", hook);
  await store.updateThought({ id: edited.id, metadataPatch: { project: "8c" }, actor: writer });
  const noopRows = await rows(recaptured.id);
  assert(noop.existed === true && noopRows.length === 1 && noopRows[0].agent === writerId && JSON.stringify(noopRows[0].diff) === '{"recaptured":true}',
    `the writer's re-capture that changes nothing is recorded: one event under its agent id, diff {"recaptured": true} (${JSON.stringify(noopRows)})`);
  const rawRows = await rows(rewritten.id);
  assert(rawRows.length === 1 && rawRows[0].agent === null && "content" in rawRows[0].diff, `setup: the raw rewrite is a content row with no agent id (${JSON.stringify(rawRows.map((r) => Object.keys(r.diff)))})`);
  for (const [what, id] of [["the writer's merge", merged.id], ["the writer's re-capture that changes nothing", recaptured.id], ["board-sync's adoption (`issue` gained, no agent id)", adopted.id], ["a text edit with no agent id", rewritten.id]] as const) {
    assert((await taken(id)) === true, `${what}: taken`);
  }
  assert((await taken(edited.id)) === false, "a write key's metadata edit alone (a tag) does not take it: the text is still only the hook's");
  const filed = await capture("[8c] the hook's thought a write key files under a ticket", hook);
  await store.updateThought({ id: filed.id, metadataPatch: { issue: "TKT-2638" }, actor: writer });
  assert((await taken(filed.id)) === false, "…nor does a write key filing it under a ticket: `issue` takes a thought only under no agent id, as board-sync adopts");
  const [noopAt] = await sql`SELECT (SELECT updated_at FROM thoughts WHERE id = ${recaptured.id}::uuid) > (SELECT max(created_at) FROM thought_audit WHERE thought_id = ${recaptured.id}::uuid AND action = 'capture') AS moved`;
  assert(noopAt?.moved === true, "…and the noted re-capture moved updated_at, as its projection does");
  // The note is a capture-only key's rows': a write key's re-capture of another write key's thought records nothing and moves nothing.
  const writersOwn = await capture("[8c] the writer's own note another write key re-sends", writer);
  const [beforeAt] = await sql`SELECT updated_at::text AS u FROM thoughts WHERE id = ${writersOwn.id}::uuid`;
  await capture("[8c] the writer's own note another write key re-sends", other);
  const [afterAt] = await sql`SELECT updated_at::text AS u FROM thoughts WHERE id = ${writersOwn.id}::uuid`;
  assert((await rows(writersOwn.id)).length === 0 && beforeAt?.u === afterAt?.u, "a write key's re-capture of another write key's thought records nothing and moves no updated_at");
  assert((await rows(merged.id)).filter((r) => "recaptured" in r.diff).length === 1 && (await rows(merged.id)).filter((r) => "metadata" in r.diff).length === 1, "…a merge is its metadata event and one recaptured event: the metadata move alone would not take it");
  assert((await taken("not-an-id")) === true && (await taken("0000dead-0000-4000-8000-000000000000")) === false, "a malformed id is never owned; a ghost has no rows (the existence read is the caller's)");

  // The lapse: a pointer the hook wrote onto its own thought, under the
  // capture scope, is cleared when another takes that thought.
  const chain = async (what: string) => {
    const t = await capture(`[8c] the hook's earlier summary ${what}`, hook);
    const s = await capture(`[8c] the hook's next summary ${what}`, hook, { supersedes: t.id });
    const [p] = await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${s.id}::uuid`;
    assert(p?.s === t.id, `setup: the hook's pointer ${what} is written`);
    return { t: t.id, s: s.id };
  };
  const pointerOf = async (id: string) => ((await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${id}::uuid`)[0] as { s: string | null } | undefined)?.s ?? null;
  const lapsedMerge = await chain("the writer then merges onto");
  await capture("[8c] the hook's earlier summary the writer then merges onto", writer, { metadata: { project: "8c" } });
  const lapsedNoop = await chain("the writer then re-captures");
  await capture("[8c] the hook's earlier summary the writer then re-captures", writer);
  const lapsedSync = await chain("board-sync then adopts");
  await store.updateThought({ id: lapsedSync.t, metadataPatch: { issue: "TKT-2638" }, actor: boardSync });
  const lapseRows = await rows(lapsedMerge.s);
  assert((await pointerOf(lapsedMerge.s)) === null && (await pointerOf(lapsedNoop.s)) === null && (await pointerOf(lapsedSync.s)) === null,
    "a pointer the hook wrote before the taking lapses: after the writer's merge, its re-capture that changes nothing, and board-sync's adoption");
  assert(lapseRows.length === 1 && lapseRows[0].agent === writerId && Object.keys(lapseRows[0].diff).join() === "supersedes" && (lapseRows[0].diff.supersedes as { before?: string; after?: unknown })?.before === lapsedMerge.t && (lapseRows[0].diff.supersedes as { after?: unknown })?.after === null,
    `…each an event of its own on the pointing thought, under the agent of the write that took the target (${JSON.stringify(lapseRows)})`);
  const keptBackfill = await chain("an operator's backfill then restamps");
  await store.updateThought({ id: keptBackfill.t, metadataPatch: { enriched: true }, actor: backfill });
  const keptVector = await chain("a worker then re-embeds");
  await sql`UPDATE thoughts SET embedding = NULL WHERE id = ${keptVector.t}::uuid`;
  await sql`UPDATE thoughts SET embedding = (SELECT embedding FROM thoughts WHERE id = ${older.id}::uuid) WHERE id = ${keptVector.t}::uuid`;
  assert((await pointerOf(keptBackfill.s)) === keptBackfill.t && (await pointerOf(keptVector.s)) === keptVector.t, "…and stands after an unattributed metadata move with no `issue`, and a vector moved by no agent");
  // A write key's pointer is never lapsed: its capture row carries no scope.
  const wt = await capture("[8c] the writer's earlier note", writer);
  const ws = await capture("[8c] the writer's next note", writer, { supersedes: wt.id });
  await store.updateThought({ id: wt.id, metadataPatch: { project: "8c" }, actor: other });
  assert((await pointerOf(ws.id)) === wt.id, "a write key's own pointer stands when another key takes its target");
  // A pointer a write key set on the hook's thought after a lapse is the write key's: a later taking leaves it.
  assert((await store.updateThought({ id: lapsedMerge.s, provenance: { supersedes: lapsedMerge.t }, actor: writer })).ok === true, "setup: the writer re-points the hook's thought");
  await store.updateThought({ id: lapsedMerge.t, content: "[8c] the hook's earlier summary, rewritten by another", embedding: unit(6), actor: other });
  assert((await pointerOf(lapsedMerge.s)) === lapsedMerge.t, "a write key's re-set pointer on the hook's thought stands when the target is taken again");
  // The check at the write: a capture-scoped capture naming a taken target is refused through the store.
  let refusal = "";
  try { await capture("[8c] the hook names a taken thought at the write", hook, { supersedes: lapsedNoop.t }); } catch (e) { refusal = (e as Error).message; }
  assert(/ob1_check_capture_pointer/.test(refusal), `a capture-scoped capture naming a taken thought is refused at the write (${refusal.slice(0, 90)})`);
  // Two capture-scoped captures naming one target at once: the second waits for
  // the first and is refused, so the target keeps one superseder (review pass 3:
  // FOR SHARE alone let concurrent captures all pass the rule).
  const raced = await capture("[8c] the hook's thought two captures race to supersede", hook);
  const envelope = (_content: string) => ({ metadata: { source: "codex" }, actor: { name: hook.name, agent_id: hookId, via: hook.via, scope: "capture" }, recapture: "keep", supersedes: raced.id });
  const first = new SQL({ url: URL_, max: 1 }), second = new SQL({ url: URL_, max: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const firstDone = first.begin(async (tx) => {
    await tx`SELECT upsert_thought(${"[8c] the first racer"}::text, ${envelope("first")}::jsonb, NULL::vector)`;
    await gate;
  });
  await Bun.sleep(200);
  const secondDone = second`SELECT upsert_thought(${"[8c] the second racer"}::text, ${envelope("second")}::jsonb, NULL::vector)`.then(() => "written", (e: Error) => e.message);
  await Bun.sleep(300);
  release();
  await firstDone;
  const secondResult = await secondDone;
  const [{ n: superseders }] = await sql`SELECT count(*)::int AS n FROM thoughts WHERE supersedes = ${raced.id}::uuid`;
  await first.close();
  await second.close();
  await sql`DELETE FROM thoughts WHERE content IN ('[8c] the first racer', '[8c] the second racer')`;
  assert(/ob1_check_capture_pointer/.test(secondResult) && superseders === 1, `two capture-scoped captures naming one target at once: the second waits and is refused, one superseder (${secondResult.slice(0, 80)}; ${superseders})`);
  // The reads fail closed: the taken read throws when it cannot be made, and so does a note that fails —
  // save a database before 082, where the capture stands without one.
  await sql`ALTER FUNCTION ob1_thought_taken(uuid) RENAME TO ob1_thought_taken_away`;
  let readError = "";
  try { await store.takenFromCapturer(own.id); } catch (e) { readError = (e as Error).message; }
  await sql`ALTER FUNCTION ob1_thought_taken_away(uuid) RENAME TO ob1_thought_taken`;
  assert(/ob1_thought_taken/.test(readError), `takenFromCapturer throws when the read cannot be made, never answering not-taken (${readError.slice(0, 80)})`);
  await sql`ALTER FUNCTION ob1_note_recapture(uuid, jsonb) RENAME TO ob1_note_recapture_away`;
  let missing = "";
  try { await capture("[8c] the hook's thought the writer re-captures before 082", hook); await capture("[8c] the hook's thought the writer re-captures before 082", writer); } catch (e) { missing = (e as Error).message; }
  await sql`ALTER FUNCTION ob1_note_recapture_away(uuid, jsonb) RENAME TO ob1_note_recapture`;
  assert(missing === "", `a database without the note: the capture stands (${missing.slice(0, 80)})`);
  await sql.unsafe(`CREATE OR REPLACE FUNCTION ob1_note_recapture_failing() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the note failed for [8c]'; END $$`);
  await sql`ALTER FUNCTION ob1_note_recapture(uuid, jsonb) RENAME TO ob1_note_recapture_real`;
  await sql.unsafe(`CREATE FUNCTION ob1_note_recapture(p_id uuid, p_actor jsonb DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the note failed for [8c]'; END $$`);
  let failed = "";
  try { await capture("[8c] the hook's thought the writer re-captures while the note fails", hook); await capture("[8c] the hook's thought the writer re-captures while the note fails", writer); } catch (e) { failed = (e as Error).message; }
  await sql`DROP FUNCTION ob1_note_recapture(uuid, jsonb)`;
  await sql`DROP FUNCTION ob1_note_recapture_failing()`;
  await sql`ALTER FUNCTION ob1_note_recapture_real(uuid, jsonb) RENAME TO ob1_note_recapture`;
  assert(/the note failed/.test(failed), `a note that fails throws, so the caller's retry makes it (${failed.slice(0, 80)})`);
  // Its thoughts go, so a later section's nearest-neighbour read meets none of
  // them (exact ties on one axis crowded [8]'s undated row out of a limit of 5).
  await sql`DELETE FROM thoughts WHERE id = ANY(${sql.array(made, "TEXT")}::uuid[])`;
  await sql.close();
}

console.log("\n[8d] A capture-only key's stamp yields to a re-capture by a key that can read at a higher trust: the store calls migration 085's restamp after the note, with the text's fingerprint and the trust the write declared (SMD-2664)");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const resolved = async (label: string, scope: string, seed: string) => {
    const r = await store.resolveAgent({ keyHash: seed.repeat(32), label, scope });
    return r.ok ? r.agentId : "";
  };
  const hook = { name: "hook-8d", agentId: await resolved("hook-8d", "capture", "8e"), via: "store-test", scope: "capture" as const };
  const writer = { name: "writer-8d", agentId: await resolved("writer-8d", "write", "e8"), via: "store-test" };
  await sql`SELECT set_agent_kind('hook-8d', 'agent')`;
  await sql`SELECT set_agent_kind('writer-8d', 'operator')`;
  const made: string[] = [];
  const capture = async (content: string, actor: typeof hook | typeof writer, trust?: string) => {
    const r = await store.captureThought({ content, payload: { metadata: { source: "mcp" } }, embedding: unit(7), actor, ...(trust ? { event: { trust } } : {}), ...(actor === hook ? { recapture: "keep" as const } : {}) });
    made.push(r.id);
    return r;
  };
  const stamp = async (id: string) => {
    const [m] = await sql`SELECT metadata->>'actor_kind' AS k, metadata->>'actor_name' AS n, metadata->>'trust' AS t FROM thoughts WHERE id = ${id}::uuid`;
    return `${m?.k ?? "-"}/${m?.n ?? "-"}/${m?.t ?? "-"}`;
  };
  const restamps = async (id: string) => (await sql`SELECT canonical_agent_id::text AS agent, trust FROM thought_audit WHERE thought_id = ${id}::uuid AND diff ? 'restamped'`) as { agent: string | null; trust: string | null }[];

  const lowered = await capture("[8d] the hook's outside text the writer sends too", hook, "ingested");
  assert((await stamp(lowered.id)) === "agent/hook-8d/ingested", `setup: the hook's capture carries its declared lowering (${await stamp(lowered.id)})`);
  const landed = await capture("[8d] the hook's outside text the writer sends too", writer);
  const moved = await restamps(lowered.id);
  assert(landed.existed === true && (await stamp(lowered.id)) === "operator/writer-8d/operator" && moved.length === 1 && moved[0].agent === writer.agentId && moved[0].trust === "operator",
    `the writer's re-capture moves the stamp to it — one restamp event under its agent id (${await stamp(lowered.id)}; ${JSON.stringify(moved)})`);
  await capture("[8d] the hook's outside text the writer sends too", hook, "ingested");
  assert((await stamp(lowered.id)) === "operator/writer-8d/operator" && (await restamps(lowered.id)).length === 1, "the hook's re-capture after it ('keep') moves nothing back");
  const declared = await capture("[8d] the hook's text the writer re-sends as outside text", hook);
  await capture("[8d] the hook's text the writer re-sends as outside text", writer, "ingested");
  assert((await stamp(declared.id)) === "agent/hook-8d/agent" && (await restamps(declared.id)).length === 0, `the writer declaring a trust below the row's moves nothing: the store passes the write's declaration (${await stamp(declared.id)})`);
  const between = await capture("[8d] the hook's outside text the writer re-sends as agent", hook, "ingested");
  await capture("[8d] the hook's outside text the writer re-sends as agent", writer, "agent");
  assert((await stamp(between.id)) === "operator/writer-8d/agent", `…and one between the two moves the stamp at the declared trust (${await stamp(between.id)})`);

  // A database before 085: the capture stands. A restamp that fails throws, so the caller's retry makes it.
  await sql`ALTER FUNCTION ob1_restamp_recapture(uuid, text, jsonb, text) RENAME TO ob1_restamp_recapture_away`;
  let missing = "";
  try { await capture("[8d] the hook's text the writer re-captures before 085", hook, "ingested"); await capture("[8d] the hook's text the writer re-captures before 085", writer); } catch (e) { missing = (e as Error).message; }
  await sql`ALTER FUNCTION ob1_restamp_recapture_away(uuid, text, jsonb, text) RENAME TO ob1_restamp_recapture`;
  assert(missing === "", `a database without the restamp: the capture stands (${missing.slice(0, 80)})`);
  await sql`ALTER FUNCTION ob1_restamp_recapture(uuid, text, jsonb, text) RENAME TO ob1_restamp_recapture_real`;
  await sql.unsafe(`CREATE FUNCTION ob1_restamp_recapture(p_id uuid, p_fingerprint text, p_actor jsonb DEFAULT NULL, p_declared text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the restamp failed for [8d]'; END $$`);
  let failed = "";
  try { await capture("[8d] the hook's text the writer re-captures while the restamp fails", hook, "ingested"); await capture("[8d] the hook's text the writer re-captures while the restamp fails", writer); } catch (e) { failed = (e as Error).message; }
  await sql`DROP FUNCTION ob1_restamp_recapture(uuid, text, jsonb, text)`;
  await sql`ALTER FUNCTION ob1_restamp_recapture_real(uuid, text, jsonb, text) RENAME TO ob1_restamp_recapture`;
  const [noted] = await sql`SELECT count(*)::int AS n FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id
     WHERE t.content = '[8d] the hook''s text the writer re-captures while the restamp fails' AND a.action = 'update' AND a.diff ? 'recaptured'`;
  assert(/the restamp failed/.test(failed) && noted?.n === 1, `a restamp that fails throws, so the caller's retry makes it — and the note before it is made (${failed.slice(0, 80)}; ${noted?.n})`);
  await sql`DELETE FROM thoughts WHERE id = ANY(${sql.array(made, "TEXT")}::uuid[])`;
  await sql.close();
}

console.log("\n[8e] The operator's reset of a capture-only key's settled or moved label: the store calls migration 086's ob1_reset_capture_stamp with the actor, and reads its answer — the operator's key resets and is named in the event, any other key is refused (SMD-2744)");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const resolved = async (label: string, scope: string, seed: string) => {
    const r = await store.resolveAgent({ keyHash: seed.repeat(32), label, scope });
    return r.ok ? r.agentId : "";
  };
  const hook = { name: "hook-8e", agentId: await resolved("hook-8e", "capture", "9a"), via: "store-test", scope: "capture" as const };
  const bot = { name: "bot-8e", agentId: await resolved("bot-8e", "write", "a9"), via: "store-test" };
  const op = { name: "op-8e", agentId: await resolved("op-8e", "write", "9b"), via: "store-test" };
  await sql`SELECT set_agent_kind('hook-8e', 'agent')`;
  await sql`SELECT set_agent_kind('bot-8e', 'agent')`;
  await sql`SELECT set_agent_kind('op-8e', 'operator')`;
  const made: string[] = [];
  const capture = async (content: string, actor: typeof hook | typeof bot, trust?: string) => {
    const r = await store.captureThought({ content, payload: { metadata: { source: "mcp" } }, embedding: unit(7), actor, ...(trust ? { event: { trust } } : {}), ...(actor === hook ? { recapture: "keep" as const } : {}) });
    made.push(r.id);
    return r;
  };
  const stamp = async (id: string) => {
    const [m] = await sql`SELECT metadata->>'actor_kind' AS k, metadata->>'actor_name' AS n, metadata->>'trust' AS t FROM thoughts WHERE id = ${id}::uuid`;
    return `${m?.k ?? "-"}/${m?.n ?? "-"}/${m?.t ?? "-"}`;
  };

  const T = "[8e] the hook's outside text an agent re-sent first";
  const row = await capture(T, hook, "ingested");
  await capture(T, bot);
  assert((await stamp(row.id)) === "agent/bot-8e/agent", `setup: the agent's re-capture moved the stamp (${await stamp(row.id)})`);
  const refused = await store.resetCaptureStamp({ id: row.id, actor: bot });
  assert(!refused.ok && refused.error === "NOT_OPERATOR" && (await stamp(row.id)) === "agent/bot-8e/agent", `an agent key is refused NOT_OPERATOR, nothing moved (${JSON.stringify(refused)})`);
  const done = await store.resetCaptureStamp({ id: row.id, actor: op });
  const [ev] = await sql`SELECT actor_name, canonical_agent_id::text AS agent, actor_kind FROM thought_audit WHERE thought_id = ${row.id}::uuid AND diff ? 'restamp_reset'`;
  assert(done.ok && done.reset && done.restored && done.declines === 0 && done.stamp.actorKind === "agent" && done.stamp.actorName === "hook-8e" && done.stamp.trust === "ingested"
      && ev?.actor_name === "op-8e" && ev.agent === op.agentId && ev.actor_kind === "operator",
    `the operator's key resets it: the capture key's stamp back, read into the store's shape, the event in the operator's name and id (${JSON.stringify(done)}; ${JSON.stringify(ev)})`);
  await capture(T, op);
  assert((await stamp(row.id)) === "operator/op-8e/operator", `…and the operator's re-capture through the store then moves it (${await stamp(row.id)})`);
  const fresh = await capture("[8e] the hook's text nobody re-sent", hook, "ingested");
  const idle = await store.resetCaptureStamp({ id: fresh.id, actor: op });
  assert(idle.ok && !idle.reset && !idle.restored && idle.stamp.actorName === "hook-8e" && idle.stamp.trust === "ingested", `a reset with nothing to reset answers reset false, and the label (${JSON.stringify(idle)})`);
  const gone = await store.resetCaptureStamp({ id: "00000000-0000-4000-8000-0000000000e8", actor: op });
  const own = await capture("[8e] the operator's own text", op);
  const notCapture = await store.resetCaptureStamp({ id: own.id, actor: op });
  assert(!gone.ok && gone.error === "NOT_FOUND" && !notCapture.ok && notCapture.error === "NOT_CAPTURE_STAMP", `no row: NOT_FOUND; the operator's own row: NOT_CAPTURE_STAMP (${JSON.stringify([gone, notCapture])})`);

  // The row lock: a text edit held open on another connection makes the
  // reset wait, and then read the edit — a rewritten row is refused. Without
  // the lock the reset read the row before the edit and reset it (run-it,
  // review pass 1).
  const held = await capture("[8e] the hook's text an edit is held open on", hook, "ingested");
  await capture("[8e] the hook's text an edit is held open on", bot, "ingested");
  const editConn = new SQL({ url: URL_, max: 1 });
  let release!: () => void, editing!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const editHeld = new Promise<void>((r) => { editing = r; });
  const editDone = editConn.begin(async (tx) => {
    await tx`SELECT update_thought(p_id := ${held.id}::uuid, p_content := ${"[8e] the agent's rewrite, committed while the reset waits"}::text, p_actor := ${{ name: bot.name, agent_id: bot.agentId, via: "store-test" }}::jsonb)`;
    editing();
    await gate;
  });
  await editHeld;
  let waited = false;
  const resetting = store.resetCaptureStamp({ id: held.id, actor: op }).then((r) => { waited = true; return r; });
  await Bun.sleep(200);
  const blocked = !waited;
  release();
  await editDone;
  await editConn.close();
  const afterEdit = await resetting;
  assert(blocked && !afterEdit.ok && afterEdit.error === "NOT_CAPTURE_STAMP" && (await stamp(held.id)) === "agent/bot-8e/agent",
    `a reset meeting a text edit in flight waits for it on the row lock, then refuses the rewritten row (waited ${blocked}; ${JSON.stringify(afterEdit)})`);
  // The operator is asked again once the row is held: a key demoted while
  // its reset waited is refused, and nothing is written in its name (run-it,
  // review pass 2: the event named an agent).
  const waits = await capture("[8e] the hook's text a reset waits on while its key is demoted", hook, "ingested");
  await capture("[8e] the hook's text a reset waits on while its key is demoted", bot, "ingested");
  const holdConn = new SQL({ url: URL_, max: 1 });
  let free!: () => void, holding!: () => void;
  const held2 = new Promise<void>((r) => { holding = r; });
  const gate2 = new Promise<void>((r) => { free = r; });
  const holdDone = holdConn.begin(async (tx) => {
    await tx`SELECT 1 FROM thoughts WHERE id = ${waits.id}::uuid FOR UPDATE`;
    holding();
    await gate2;
  });
  await held2;
  const demoted = store.resetCaptureStamp({ id: waits.id, actor: op });
  await Bun.sleep(200);
  await sql`SELECT set_agent_kind('op-8e', 'agent')`;
  free();
  await holdDone;
  await holdConn.close();
  const afterDemote = await demoted;
  await sql`SELECT set_agent_kind('op-8e', 'operator')`;
  const [resets] = await sql`SELECT count(*)::int AS n FROM thought_audit WHERE thought_id = ${waits.id}::uuid AND diff ? 'restamp_reset'`;
  assert(!afterDemote.ok && afterDemote.error === "NOT_OPERATOR" && afterDemote.kind === "agent" && resets?.n === 0,
    `a key demoted while its reset waited on the row is refused once it holds the row, and no reset is written (${JSON.stringify(afterDemote)}; ${resets?.n})`);

  // An answer the store cannot read is a fault, not a guess.
  await sql`ALTER FUNCTION ob1_reset_capture_stamp(uuid, jsonb) RENAME TO ob1_reset_capture_stamp_real`;
  await sql.unsafe(`CREATE FUNCTION ob1_reset_capture_stamp(p_id uuid, p_actor jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok": false, "error": "SOMETHING_NEW"}'::jsonb $$`);
  let odd = "";
  try { await store.resetCaptureStamp({ id: row.id, actor: op }); } catch (e) { odd = (e as Error).message; }
  await sql`DROP FUNCTION ob1_reset_capture_stamp(uuid, jsonb)`;
  await sql`ALTER FUNCTION ob1_reset_capture_stamp_real(uuid, jsonb) RENAME TO ob1_reset_capture_stamp`;
  assert(/no envelope this server reads/.test(odd) && /SOMETHING_NEW/.test(odd), `an error the function does not name throws, quoting the answer (${odd.slice(0, 120)})`);
  await sql`DELETE FROM thoughts WHERE id = ANY(${sql.array(made, "TEXT")}::uuid[])`;
  await sql.close();
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

console.log("\n[10] listSupersessionProposals reads migration 029's queue through the one row mapper (SMD-1294)");
{
  // The worker writes the row (its call, made directly here); the store reads
  // it back in the shape the tool prints, both thoughts inline.
  const older = await store.captureThought({ content: "queue: we bill monthly", payload: { metadata: {} }, embedding: unit(5) });
  const newer = await store.captureThought({ content: "queue: we bill annually now", payload: { metadata: {} }, embedding: unit(5) });
  const admin5 = new SQL({ url: URL_, max: 1 });
  await admin5`UPDATE thoughts SET created_at = now() - interval '10 days' WHERE id = ${older.id}`;
  const [{ id: pid }] = await admin5`
    SELECT record_supersession_proposal(${older.id}::uuid, ${newer.id}::uuid, 'newer_supersedes_older', 0.85, 'monthly versus annual', 0.97, 'consolidate:stub@p1', NULL) AS id`;
  const pending = await store.listSupersessionProposals({});
  assert(pending.length === 1 && pending[0].id === pid, `the default lists the pending proposal (${pending.length})`);
  const row = pending[0];
  assert(row.status === "pending" && row.verdict === "newer_supersedes_older" && row.confidence === 0.85 && row.reason === "monthly versus annual" && Math.abs((row.similarity ?? 0) - 0.97) < 1e-5 && row.judgeKey === "consolidate:stub@p1",
         `…mapped: status, verdict, a numeric confidence, the reason, the cosine and the judge key (${JSON.stringify({ ...row, older: undefined, newer: undefined })})`);
  assert(row.older.id === older.id && /monthly/.test(row.older.content) && row.newer.id === newer.id && /annually/.test(row.newer.content)
         && row.older.created_at != null && row.newer.created_at != null && row.older.created_at < row.newer.created_at,
         "…with both thoughts inline, the older captured first");
  assert(row.reviewedAt === null && row.reviewNote === null && row.supersedingId === null, "…and the review fields null while pending");
  assert((await store.listSupersessionProposals({ status: "accepted" })).length === 0, "a status filter applies");
  await admin5`SELECT review_supersession_proposal(${pid}::uuid, 'accept', 'confirmed', NULL, NULL)`;
  assert((await store.listSupersessionProposals({})).length === 0, "an accepted proposal leaves the pending list");
  const all = await store.listSupersessionProposals({ status: null });
  assert(all.length === 1 && all[0].status === "accepted" && all[0].supersedingId === newer.id && all[0].reviewNote === "confirmed" && all[0].reviewedAt !== null,
         "null lists every state, and the accepted row names the thought it wrote");
  // 070 (SMD-2313): the flag, false on this pair; the newer thought's
  // derived_from set raw to name the older — the shape 066 stops the pass
  // proposing, a page and its evidence — and the row reads lineage, the
  // selector picks it, false leaves it out.
  assert(all[0].lineage === false && (await store.listSupersessionProposals({ status: null, lineage: false })).length === 1 && (await store.listSupersessionProposals({ status: null, lineage: true })).length === 0,
         "…and lineage is false on a pair neither side of which names the other (070): false selects it, true does not");
  await admin5`UPDATE thoughts SET derived_from = jsonb_build_array(${older.id}::text) WHERE id = ${newer.id}::uuid`;
  const flaggedRows = await store.listSupersessionProposals({ status: null });
  assert(flaggedRows.length === 1 && flaggedRows[0].lineage === true, "with the newer thought's derived_from naming the older, the row reads lineage");
  assert((await store.listSupersessionProposals({ status: null, lineage: true })).length === 1 && (await store.listSupersessionProposals({ status: null, lineage: false })).length === 0,
         "lineage: true selects it, false leaves it out — the third argument on every call");
  await admin5.close();
}

console.log("\n[11] logActions: the one writer of action rows — a batch in one statement, an absent agent as SQL NULL, a malformed agent or target refused loudly by column (migration 034, SMD-1719)");
{
  const admin6 = new SQL({ url: URL_, max: 1 });
  await admin6`DELETE FROM query_log`;
  const AG = "99999999-9999-4999-8999-999999999999";
  const X = "aaaaaaaa-0000-4000-8000-000000000001";
  const Y = "aaaaaaaa-0000-4000-8000-000000000002";
  await store.logActions([]);
  assert((await admin6<{ n: number }[]>`SELECT count(*)::int AS n FROM query_log`)[0].n === 0, "an empty batch writes nothing");
  // undefined AND the empty string are absent agents — `??` alone would have
  // let "" through as a malformed array element (fifth review pass).
  await store.logActions([
    { tool: "fetch", agentId: AG, targetId: X },
    { tool: "capture_thought/derived_from", agentId: undefined, targetId: Y },
    { tool: "update_thought/supersedes", agentId: "", targetId: X },
  ]);
  const rows = await admin6<{ tool: string; agent_id: string | null; target_id: string }[]>`SELECT tool, agent_id, target_id FROM query_log ORDER BY tool`;
  assert(rows.length === 3, `three rows in one statement (${rows.length})`);
  assert(rows.find((r) => r.tool === "fetch")?.agent_id === AG, "a present agent lands");
  assert(rows.find((r) => r.tool === "capture_thought/derived_from")?.agent_id === null, "an undefined agent lands as SQL NULL");
  assert(rows.find((r) => r.tool === "update_thought/supersedes")?.agent_id === null, "an empty-string agent lands as SQL NULL, not as a malformed literal");
  // A non-uuid agent is refused before the statement, loudly, so a caller's
  // best-effort catch drops a batch it can name rather than array_in failing
  // on a literal it cannot.
  let refused = "";
  try { await store.logActions([{ tool: "fetch", agentId: "not-a-uuid", targetId: X }]); } catch (e) { refused = (e as Error).message; }
  assert(/logActions: not a uuid for agent_id: not-a-uuid/.test(refused), `a malformed agent id is refused by name (${refused.slice(0, 60)})`);
  // The target column too (sixth review pass: agents were checked and targets
  // trusted — one bad target in a batch of three would have malformed the
  // literal and lost all three, with no message naming the culprit).
  refused = "";
  try { await store.logActions([{ tool: "fetch", agentId: AG, targetId: X }, { tool: "fetch", agentId: AG, targetId: "abc}" }]); } catch (e) { refused = (e as Error).message; }
  assert(/logActions: not a uuid for target_id: abc\}/.test(refused), `a malformed target id is refused by name (${refused.slice(0, 60)})`);
  refused = "";
  try { await store.logActions([{ tool: "fetch", agentId: AG, targetId: "" }]); } catch (e) { refused = (e as Error).message; }
  assert(/logActions: target_id is absent/.test(refused), `an absent target is refused, not bound as NULL for the CHECK to catch (${refused.slice(0, 60)})`);
  assert((await admin6<{ n: number }[]>`SELECT count(*)::int AS n FROM query_log`)[0].n === 3, "…and none of the refused batches wrote a row");
  await admin6`DELETE FROM query_log`;
  await admin6.close();
}

console.log("\n[12] A NULL created_at reads back as null on every read method, not the fabricated epoch (SMD-1328)");
{
  // The column is nullable and no capture path sets it — every INSERT takes the
  // DEFAULT now() — so only a direct INSERT reaches this. When one did, every
  // mapper here ran the NULL through new Date(null) and returned the epoch
  // string 1970-01-01T00:00:00.000Z as if it were a real capture date. It is
  // now null. unit(6) is an axis [3]'s seeds do not use, so the planted row is
  // the only hit above the threshold.
  const sql = new SQL({ url: URL_, max: 1 });
  const undatedId = await plantLegacyRow(sql, "an undated row for SMD-1328", "[" + unit(6).join(",") + "]", null);
  try {
    const hit = (await store.matchThoughts({ embedding: unit(6), threshold: 0.5, limit: 5, filter: {} })).find((r) => r.id === undatedId);
    assert(hit?.created_at === null, `matchThoughts returns null, not the epoch (got ${JSON.stringify(hit?.created_at)})`);
    const rec = await store.getThought(undatedId);
    assert(rec?.created_at === null, `getThought returns null (got ${JSON.stringify(rec?.created_at)})`);
    const listed = (await store.listThoughts({ limit: 50 })).find((r) => r.id === undatedId);
    assert(listed?.created_at === null, `listThoughts returns null (got ${JSON.stringify(listed?.created_at)})`);
    // The bug's fingerprint: the fabricated epoch string appears nowhere.
    assert(rec?.created_at !== "1970-01-01T00:00:00.000Z", "the fabricated epoch string is gone");
  } finally {
    await sql`DELETE FROM thoughts WHERE id = ${undatedId}::uuid`;
    await sql.close();
  }
}

console.log("\n[13] A NULL/infinity created_at survives the provenance and proposal mappers — null or its own text, never the fabricated epoch, and list_supersession_proposals no longer THROWS on infinity (SMD-1803)");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const undatedAncestor = await plantLegacyRow(sql, "smd-1803 undated ancestor", "[" + unit(7).join(",") + "]", null);
  const heir = await store.captureThought({ content: "smd-1803 heir of an undated ancestor", payload: { metadata: {} }, embedding: unit(8), derivedFrom: [undatedAncestor] });
  const parent = await store.captureThought({ content: "smd-1803 dated parent of an undated derivative", payload: { metadata: {} }, embedding: unit(9) });
  const undatedChild = await plantLegacyRow(sql, "smd-1803 undated derivative", "[" + unit(10).join(",") + "]", null);
  const infOlder = await plantLegacyRow(sql, "smd-1803 proposal thought dated infinity", "[" + unit(11).join(",") + "]", "infinity");
  const undatedNewer = await plantLegacyRow(sql, "smd-1803 proposal thought undated", "[" + unit(12).join(",") + "]", null);
  try {
    // (a) trace UP: the NULL ancestor maps to null, not the epoch string
    // derivationFields fabricated with new Date(null).toISOString() before 1803.
    const anc = await store.traceProvenance({ id: heir.id });
    const ancNode = anc.find((n) => n.thoughtId === undatedAncestor);
    assert(ancNode?.created_at === null, `traceProvenance maps a NULL ancestor to null (got ${JSON.stringify(ancNode?.created_at)})`);

    // (b) walk DOWN: same shared mapper (derivationFields), so a NULL-dated
    // derivative is null too. A hand-set derived_from reaches this; no capture
    // path leaves created_at NULL.
    await sql`UPDATE thoughts SET derived_from = jsonb_build_array(${parent.id}::text) WHERE id = ${undatedChild}::uuid`;
    const der = await store.findDerivatives({ id: parent.id });
    const derNode = der.find((d) => d.id === undatedChild);
    assert(derNode !== undefined && derNode.created_at === null, `findDerivatives maps a NULL derivative to null (got ${JSON.stringify(derNode?.created_at)})`);

    // (c) the more severe half: normaliseProposal's old local iso THREW
    // RangeError on an infinity-dated proposal thought, taking the whole tool
    // down; a NULL one it fabricated to the epoch. Both now render as their own
    // value, and the call returns.
    await sql`SELECT record_supersession_proposal(${infOlder}::uuid, ${undatedNewer}::uuid, 'conflict_undirected', 0.7, 'infinity vs undated', 0.9, 'consolidate:smd1803@p1', NULL)`;
    let proposals: Awaited<ReturnType<typeof store.listSupersessionProposals>> = [];
    let threw = "";
    try { proposals = await store.listSupersessionProposals({ status: null }); } catch (e) { threw = (e as Error).message; }
    assert(threw === "", `listSupersessionProposals returns rather than throwing on an infinity/NULL-dated pair (threw: ${threw.slice(0, 80)})`);
    const p = proposals.find((x) => x.older.id === infOlder && x.newer.id === undatedNewer);
    assert(p !== undefined, "…the planted proposal is listed");
    assert(p!.older.created_at === "infinity", `…infinity is kept as its own text, not "Invalid Date" or a throw (got ${JSON.stringify(p!.older.created_at)})`);
    assert(p!.newer.created_at === null, `…a NULL proposal thought is null, not the epoch (got ${JSON.stringify(p!.newer.created_at)})`);
    assert(p!.judgedAt !== "1970-01-01T00:00:00.000Z" && ISO_RE.test(p!.judgedAt), `…judged_at (NOT NULL) is still a real timestamp (got ${JSON.stringify(p!.judgedAt)})`);
  } finally {
    await sql`DELETE FROM supersession_proposals`;
    await sql`DELETE FROM thoughts WHERE id IN (${undatedAncestor}::uuid, ${heir.id}::uuid, ${parent.id}::uuid, ${undatedChild}::uuid, ${infOlder}::uuid, ${undatedNewer}::uuid)`;
    await sql.close();
  }
}

console.log("\n[14] listChanges: one page of the log from a cursor, the actions bound as text[], and the function's refusals surfaced (migration 052, SMD-1296)");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const cursor0 = String((await sql`SELECT id FROM thought_audit ORDER BY created_at DESC, id DESC LIMIT 1`)[0].id);
  const actor = { name: "store-sql-14" };
  const { id } = await store.captureThought({ content: "smd-1296 a thought the feed will list", payload: { metadata: { type: "idea" } }, embedding: unit(13), actor });
  await store.updateThought({ id, content: "smd-1296 the thought, edited", embedding: unit(13), embeddingModel: EMBEDDING_MODEL, actor });
  await store.deleteThought({ id, actor });
  const rows = await store.listChanges({ after: cursor0, limit: 10 });
  assert(rows.map((r) => r.action).join(",") === "capture,update,delete" && rows.every((r) => r.thoughtId === id && r.actorName === "store-sql-14" && ISO_RE.test(r.createdAt)),
    `three rows after the cursor, oldest first, each the actor's and dated (${rows.map((r) => r.action).join(",")})`);
  assert(rows[0].present === false && rows[0].head === null && rows[1].head === "smd-1296 the thought, edited" && rows[1].changed.includes("content") && rows[2].head === "smd-1296 the thought, edited",
    "the capture's text is gone with the thought; the edit and the delete carry the edited text");
  assert((await store.listChanges({ after: rows[0].id, limit: 10 })).length === 2, "a cursor at the first row yields the two after it");
  assert((await store.listChanges({ after: cursor0, actions: ["delete"], limit: 10 })).length === 1 && (await store.listChanges({ after: cursor0, actions: ["capture", "delete"], limit: 10 })).length === 2,
    "actions bind as text[] through sql.array");
  // Both from the cursor, where only this actor's rows are: a `since` from 2000
  // with a limit of five read the oldest rows of the log, which were never this
  // actor's, so the notAgent half passed with the filter removed (second review pass).
  assert((await store.listChanges({ after: cursor0, agent: "store-sql-14", limit: 10 })).length === 3 && (await store.listChanges({ after: cursor0, notAgent: "store-sql-14", limit: 10 })).length === 0,
    "agent keeps one key's rows, notAgent drops them — three and none after the cursor");
  let ghost = "";
  // Not the all-zero id: SMD-1298's section above plants an audit row under it.
  try { await store.listChanges({ after: "00000000-0000-4000-8000-0000000000ff", limit: 1 }); } catch (e) { ghost = (e as Error).message; }
  assert(/no audit row/.test(ghost), "a cursor naming no row throws the function's message");
  let both = "";
  try { await store.listChanges({ since: "2000-01-01T00:00:00Z", after: cursor0, limit: 1 }); } catch (e) { both = (e as Error).message; }
  assert(/not both/.test(both), "a time beside a cursor throws the function's message");
  await sql.close();
}

console.log("\n[15] resolveAgent caps each lock wait in its own statement — 55P03 at the cap, a stricter setting kept, nothing left on the connection (SMD-2072)");
{
  // One connection, so the statements after a lookup run where it ran.
  const one = new SqlStore(URL_, { max: 1 });
  const conn = (one as unknown as { sql: SQL }).sql;
  const hash = "e".repeat(64);
  const setting = async () => (await conn`SELECT current_setting('lock_timeout') AS lt`)[0].lt as string;
  // The connection's own, whatever the database or role sets it to.
  const own = await setting();
  const ok = await one.resolveAgent({ keyHash: hash, label: "store-sql-2072", scope: "write" });
  assert(ok.ok === true, `an unlocked registry answers (${JSON.stringify(ok).slice(0, 60)})`);
  assert(await setting() === own, `the lookup's ceiling ends with its statement: the connection's lock_timeout is its own (${own}) afterwards`);

  const locker = new SQL({ url: URL_, max: 1 });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  let locked: () => void = () => {};
  const isLocked = new Promise<void>((r) => { locked = r; });
  const tx = locker.begin(async (t) => {
    await t`LOCK TABLE ob1_agent_keys IN ACCESS EXCLUSIVE MODE`;
    locked();
    await held;
  });
  await isLocked;
  try {
    const timed = async () => {
      const t0 = performance.now();
      let err: { errno?: string; message?: string } = {};
      try { await one.resolveAgent({ keyHash: hash, label: "store-sql-2072", scope: "write" }); } catch (e) { err = e as typeof err; }
      return { errno: err.errno, message: err.message, ms: performance.now() - t0 };
    };
    const capped = await timed();
    assert(capped.errno === "55P03" && capped.ms >= 200 && capped.ms < 1000,
      `with ob1_agent_keys locked, the lookup raises lock_timeout's 55P03 at the 250 ms cap (${capped.errno}, ${Math.round(capped.ms)} ms: ${capped.message})`);
    assert(await setting() === own, "…and the connection is healthy after it, its lock_timeout its own");
    // A stricter setting already on the connection is kept, not raised.
    await conn`SET lock_timeout = '80ms'`;
    const stricter = await timed();
    assert(stricter.errno === "55P03" && stricter.ms < 200, `a stricter lock_timeout (80 ms) is kept, not raised to the cap (${Math.round(stricter.ms)} ms)`);
    assert(await setting() === "80ms", `…and is still the connection's afterwards (${await setting()})`);
  } finally {
    await conn`RESET lock_timeout`;
    release();
    await tx;
    await locker.close();
  }
  await one.close();
}

console.log("\n[16] min_trust and the write's declared trust (SMD-1724): capture's event.trust lowers the row's trust; minTrust keeps rows at or above it on every arm; and 074's and 075's forms are called only when it is set, so a brain without them answers every other search and refuses a min_trust one by name");
{
  const raw = new SQL({ url: URL_, max: 1 });
  await raw`SELECT set_agent_kind('op-key', 'operator')`;
  const actor = { name: "op-key", via: "test-store-sql" };
  const own = await store.captureThought({ content: "kappa the operator's own line", payload: { metadata: {} }, embedding: unit(5), actor });
  const pasted = await store.captureThought({ content: "kappa a page the operator pasted", payload: { metadata: {} }, embedding: unit(6), actor, event: { trust: "ingested" } });
  const trustOf = async (id: string) => String((await raw`SELECT metadata->>'trust' AS t FROM thoughts WHERE id = ${id}::uuid`)[0].t);
  assert(await trustOf(own.id) === "operator" && await trustOf(pasted.id) === "ingested", "capture's event.trust reaches the row: the operator's key's own text is operator, its declared lowering ingested");
  const has = (rows: { id: string }[], id: string) => rows.some((r) => r.id === id);
  const kw = (minTrust?: string) => store.keywordThoughts({ query: "kappa", limit: 10, offset: 0, filter: {}, ...(minTrust ? { minTrust } : {}) });
  const hy = (minTrust?: string, preferCurrent = false) => store.hybridThoughts({ query: "kappa", embedding: unit(6), threshold: -1, limit: 10, filter: {}, preferCurrent, ...(minTrust ? { minTrust } : {}) });
  const [kwAll, kwOp, hyAll, hyOp, cuOp] = [await kw(), await kw("operator"), await hy(), await hy("operator"), await hy("operator", true)];
  assert(has(kwAll, pasted.id) && has(kwOp, own.id) && !has(kwOp, pasted.id), "keyword: minTrust operator keeps the operator's text and leaves the ingested one out");
  assert(has(hyAll, pasted.id) && has(hyOp, own.id) && !has(hyOp, pasted.id) && has(cuOp, own.id) && !has(cuOp, pasted.id), "hybrid and the current read: the same, through 075's 8-argument forms");
  const ls = await store.listThoughts({ limit: 10, trustIn: ["operator"] });
  assert(has(ls, own.id) && !has(ls, pasted.id) && has(await store.listThoughts({ limit: 10, trustIn: ["operator", "agent", "ingested"] }), pasted.id), "list: trustIn keeps the rows whose trust is one of the words");

  // A brain before 074 and 075: 019's 4-argument keyword, 027's 7-argument
  // hybrid and 068's current read (each the last to define it before them),
  // the 8- and 5-argument forms gone. Every search without min_trust answers
  // as before; one with it is refused by name.
  await applyMigrations(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("019") || f.startsWith("027") || f.startsWith("068") });
  await raw.unsafe(`DROP FUNCTION search_thoughts_keyword(text, int, int, jsonb, text)`);
  await raw.unsafe(`DROP FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text)`);
  await raw.unsafe(`DROP FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float, text)`);
  const refusal = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { return (e as Error).message; } };
  assert(has(await kw(), pasted.id) && has(await hy(), pasted.id) && has(await hy(undefined, true), pasted.id), "before 074 and 075, every search without minTrust answers — the store sends the forms that brain has");
  const [kwNo, hyNo, cuNo] = [await refusal(kw("operator")), await refusal(hy("operator")), await refusal(hy("operator", true))];
  assert(/search_thoughts_keyword/.test(kwNo) && /does not exist|could not find/i.test(kwNo) && /search_thoughts_hybrid/.test(hyNo) && /does not exist|could not find/i.test(hyNo) && /search_thoughts_current/.test(cuNo) && /does not exist|could not find/i.test(cuNo),
    `…and a minTrust search is refused by the function it names, which the tools' hint reads (${kwNo.slice(0, 90)} | ${hyNo.slice(0, 90)})`);
  await applyMigrations(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL, only: (f) => f.startsWith("074") || f.startsWith("075") });
  assert(!has(await hy("operator"), pasted.id) && !has(await kw("operator"), pasted.id), "074 and 075 re-applied: minTrust answers again");
  await raw`DELETE FROM thoughts WHERE id = ${own.id}::uuid OR id = ${pasted.id}::uuid`;
  await raw.close();
}

await store.close();

report();
