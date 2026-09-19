#!/usr/bin/env bun
/**
 * test-store-postgrest.ts — the PostgREST store against a real database.
 *
 * This path had no test at all. Everything else in the suite exercises
 * OB1_STORE=sql, so `PostgrestStore`'s RPC argument shapes were only ever verified
 * by running against a live PostgREST, which nothing in CI does. That went
 * unnoticed until chunking added a fourth argument to `upsert_thought` and there
 * was no way to check it arrived.
 *
 * The fixture is `compat/supabase-sql`, this fork's supabase-js-shaped client over
 * Bun.sql. It is not a mock: it builds real SQL and runs it against real Postgres,
 * so an argument name the function does not have, or a value the wrong shape,
 * fails here exactly as it would against PostgREST.
 *
 * What this does NOT prove: PostgREST's own HTTP layer, its type coercion, or its
 * error codes. Those differ from Bun's, which is why `toPostgrestError` exists.
 * This covers the argument shapes and the round trip, which is where the untested
 * risk actually was.
 *
 *   ../db/with-postgres.sh bun test-store-postgrest.ts
 */

import { SQL } from "bun";
import { createAssert, ISO_RE, plantLegacyRow, resetSchema } from "../db/test-support.ts";
import { createClient } from "../compat/supabase-sql/index.ts";
import { PostgrestStore } from "./store-postgrest.ts";
import { isoTimestamp, isoTimestampOrNull } from "./store.ts";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-store-postgrest.ts");
  process.exit(2);
}

const DIM = 8;
const { assert, report } = createAssert();

await resetSchema(URL_, { dim: DIM, model: "stub" });

/** One-hot vectors, so similarity is exact and ranking is predictable. */
const vec = (axis: number): number[] => Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0));

// The seam: a supabase-js-shaped client that is really SQL.
const client = createClient(URL_);
const store = new PostgrestStore("unused", "unused", client as never);

console.log("\n  PostgrestStore over compat/supabase-sql, against real Postgres\n");

console.log("[1] captureThought without chunks — the 3-arg RPC, unchanged");
{
  const { id } = await store.captureThought({
    content: "a short thought that needs no chunking",
    payload: { metadata: { type: "idea", topics: ["short"] } },
    embedding: vec(0),
    embeddingModel: "unit-test-model",
  });
  assert(/^[0-9a-f-]{36}$/.test(id), `returns a uuid (${id.slice(0, 8)}…)`);
  // 035: the RPC's jsonb return carries `existed`, and the store passes it on.
  const again = await store.captureThought({ content: "a short thought that needs no chunking", payload: { metadata: {} }, embedding: vec(0), embeddingModel: "unit-test-model" });
  assert(again.id === id && again.existed === true && again.supersedes === null, "a re-capture over PostgREST reports existed: true and supersedes: null — the keys ride the RPC's return");

  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT metadata, vector_dims(embedding) AS d, embedding_model AS m FROM thoughts WHERE id = ${id}`;
  assert(Number(row.d) === DIM, "the embedding was stored, not dropped");
  assert(row.metadata?.type === "idea", `metadata survived the RPC (${JSON.stringify(row.metadata)})`);
  assert(row.m === "unit-test-model", `the model rode in the envelope over PostgREST too (${row.m})`);
  // The eighth argument by name (021): relabelled with content, untouched without.
  await store.updateThought({ id, content: "a short thought that needs no chunking", embedding: vec(0), embeddingModel: "unit-test-model-2" });
  await store.updateThought({ id, metadataPatch: { type: "note" } });
  const [edited] = await sql`SELECT embedding_model AS m, metadata->>'type' AS t FROM thoughts WHERE id = ${id}`;
  assert(edited.m === "unit-test-model-2" && edited.t === "note", `update_thought's p_embedding_model reaches the row by name, and a metadata-only edit leaves it (${edited.m})`);
  const [c] = await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${id}`;
  assert(c.c === 0, "no chunk rows for short content");
  // The ninth argument by name (032): p_provenance sets, a call without it
  // sends null and leaves, a JSON null in it clears; a refusal is the union.
  const { id: older } = await store.captureThought({ content: "the earlier version, over PostgREST", payload: { metadata: {} }, embedding: vec(1) });
  const prov = async () => (await sql`SELECT supersedes AS s, derived_from AS d FROM thoughts WHERE id = ${id}`)[0] as { s: string | null; d: string[] | null };
  const set = await store.updateThought({ id, provenance: { supersedes: older, derivedFrom: [older] } });
  assert(set.ok && (await prov()).s === older && JSON.stringify((await prov()).d) === JSON.stringify([older]), "p_provenance reaches update_thought by name: supersedes and derived_from written");
  await store.updateThought({ id, metadataPatch: { type: "idea" } });
  assert((await prov()).s === older, "…an edit naming no provenance leaves them");
  const cleared = await store.updateThought({ id, provenance: { supersedes: null, derivedFrom: null } });
  assert(cleared.ok && (await prov()).s === null && (await prov()).d === null, "…and null clears both");
  const loop = await store.updateThought({ id: older, provenance: { supersedes: older } });
  assert(!loop.ok && loop.error === "WOULD_CYCLE", `a self-pointer comes back as WOULD_CYCLE over PostgREST too (${JSON.stringify(loop)})`);
  await sql`DELETE FROM thoughts WHERE id = ${older}`;
  await sql.close();
}

console.log("\n[1b] The actor reaches the audit trail on THIS store too");
{
  // The gap this suite exists to catch: an earlier version set the audit actor
  // with a transaction-local setting in store-sql only, so every audit row
  // written through PostgREST recorded a NULL actor — present, plausible, wrong.
  const { id } = await store.captureThought({
    content: "a thought captured with an actor",
    payload: { metadata: { source: "postgrest-test" } },
    embedding: vec(5),
    actor: { name: "importer", source: "postgrest-test" },
  });
  const sql = new SQL({ url: URL_, max: 1 });
  const [ev] = await sql`
    SELECT action, actor_name, source FROM thought_audit WHERE thought_id = ${id}`;
  assert(ev?.actor_name === "importer", `attributed to the key name (${ev?.actor_name})`);
  assert(ev?.action === "capture", "recorded as a capture");
  assert(ev?.source === "postgrest-test", `source carried (${ev?.source})`);

  // And the actor must not leak into the thought's own metadata — it rides in
  // the payload envelope, which upsert_thought reads but does not store.
  const [t] = await sql`SELECT metadata FROM thoughts WHERE id = ${id}`;
  assert(t.metadata?.actor === undefined, "the actor is not stored on the thought itself");
  await sql.close();
}

console.log("\n[2] captureThought WITH chunks — the 4-arg RPC arrives intact");
{
  // This is the argument shape that shipped unverified: p_chunks as a jsonb array
  // whose embeddings are pgvector text literals.
  const { id } = await store.captureThought({
    content: "a long thought split into windows",
    payload: { metadata: { type: "reference" } },
    embedding: vec(1),
    chunks: [
      { content: "window one, the opening", embedding: vec(1) },
      { content: "window two, the middle", embedding: vec(2) },
      { content: "window three, the conclusion", embedding: vec(3) },
    ],
  });

  const sql = new SQL({ url: URL_, max: 1 });
  const rows = await sql`
    SELECT chunk_index, content, vector_dims(embedding) AS d
    FROM thought_chunks WHERE thought_id = ${id} ORDER BY chunk_index`;
  assert(rows.length === 3, `three chunk rows written (${rows.length})`);
  type ChunkRow = { chunk_index: number; content: string; d: number };
  assert(rows.every((r: ChunkRow, i: number) => Number(r.chunk_index) === i), "indices are dense and ordered");
  assert(rows.every((r: ChunkRow) => Number(r.d) === DIM), "every chunk embedding is a real vector, not a string");
  assert(rows[2].content === "window three, the conclusion", "chunk content round-trips");
  await sql.close();
}

console.log("\n[3] matchThoughts finds a thought by a CHUNK, through the RPC");
{
  // vec(3) matches only the third window. Before chunking this thought would have
  // been unreachable by anything in its conclusion.
  const hits = await store.matchThoughts({ embedding: vec(3), threshold: 0.5, limit: 5, filter: {} });
  assert(hits.length === 1, `one thought returned (${hits.length})`);
  assert(hits[0]?.content === "a long thought split into windows",
         "…retrieved by its final window, not its opening");
  assert(Math.abs((hits[0]?.similarity ?? 0) - 1) < 1e-6,
         `scored by the matching chunk (${hits[0]?.similarity?.toFixed(4)})`);
  // This method returned the client's own value under `created_at: string`
  // until SMD-1040 — a Date over this fixture. `typeof` first so the message
  // names what arrived rather than a coerced Date failing the regex.
  assert(typeof hits[0]?.created_at === "string" && ISO_RE.test(hits[0].created_at),
         `created_at is an ISO string, as the SQL store returns (got ${typeof hits[0]?.created_at} ${String(hits[0]?.created_at)})`);
  // isFinite, not typeof: `typeof NaN` is "number", so a dropped or renamed
  // column would pass a typeof check under Number().
  assert(Number.isFinite(hits[0]?.score) && Number.isFinite(hits[0]?.similarity),
         "similarity and score arrive as finite numbers, not NaN from a missing column");

  // The fixture hands the store an ISO string in JS's spelling (the shim renders
  // Bun's Date so, since FORK.md change 73); real PostgREST hands it Postgres's
  // own JSON spelling, which no suite here can produce; the SQL store a Date.
  // Feed the helper all three, plus the spellings of an infinite timestamp on
  // each client (see [3d]).
  assert(isoTimestamp("2026-09-14T16:27:09.123456+00:00") === "2026-09-14T16:27:09.123Z", "PostgREST's +00:00 string normalises to the SQL store's form");
  assert(isoTimestamp("2026-09-14 16:27:09+00") === "2026-09-14T16:27:09.000Z", "a space-separated timestamptz text form normalises too");
  assert(isoTimestamp(new Date("2026-09-14T16:27:09.123Z")) === "2026-09-14T16:27:09.123Z", "a Date passes through unchanged");
  assert(isoTimestamp(Infinity) === "infinity" && isoTimestamp("infinity") === "infinity", "an infinite timestamp keeps Postgres's spelling on either client");
  assert(isoTimestamp(-Infinity) === "-infinity" && isoTimestamp("-infinity") === "-infinity", "…and so does -infinity");
  assert(isoTimestamp("0044-03-15T00:00:00+00:00 BC") === "0044-03-15T00:00:00+00:00 BC", "a value with no ISO form keeps Postgres's text — one odd row, not a failed result");
  assert((() => { try { isoTimestamp(undefined); return false; } catch { return true; } })(), "a column missing from the row throws — a SELECT bug, not data");
}

console.log("\n[3b] keywordThoughts over PostgREST returns the same shape");
{
  // The reason this store has a suite at all: an RPC argument shape that is
  // wrong here type-checks, runs, and silently returns nothing. `total_count`
  // is the specific hazard — PostgREST hands back the function's snake_case
  // column names, and a cast rather than a mapping would deliver
  // `totalCount: undefined` to every caller with no error anywhere.
  await store.captureThought({
    content: "postgrest keyword needle PGRST202 mentioned once",
    payload: { metadata: { kind: "kw" } },
    embedding: vec(9),
  });

  const hits = await store.keywordThoughts({ query: "PGRST202", limit: 10, offset: 0, filter: {} });
  assert(hits.length === 1, `the RPC reaches the function (${hits.length})`);
  assert(hits[0].totalCount === 1, `total_count is mapped to totalCount, not undefined (${hits[0].totalCount})`);
  assert(hits[0].occurrences === 1, `occurrences arrives as a number (${hits[0].occurrences})`);
  assert(typeof hits[0].id === "string" && hits[0].id.length === 36, "…with a uuid id");

  // The two stores must agree on the SHAPE of a field, not merely have one. This
  // path returned a locale- and timezone-formatted date where the SQL store
  // returns ISO, and every assertion that only checked presence passed.
  assert(ISO_RE.test(hits[0].created_at),
         `created_at is an ISO string, as the SQL store returns (got ${hits[0].created_at})`);

  // The p_filter argument, which is the jsonb one and therefore the one that
  // binds wrongly if it is pre-stringified.
  const kept = await store.keywordThoughts({ query: "PGRST202", limit: 10, offset: 0, filter: { kind: "kw" } });
  assert(kept.length === 1, "a matching jsonb filter is passed through as an object, not a scalar string");
  const dropped = await store.keywordThoughts({ query: "PGRST202", limit: 10, offset: 0, filter: { kind: "nope" } });
  assert(dropped.length === 0, "…and a non-matching one actually filters");
}

console.log("\n[3c] hybridThoughts over PostgREST — the path every search takes on the default store");
{
  // Argument names bind against the real function here, so a rename in 017 or
  // in store-postgrest.ts fails this section rather than every search in
  // production (review pass: the SQL store had [3c], this one did not).
  // vec(1), orthogonal to the vec(3) query: an axis beyond DIM would be the
  // zero vector, whose cosine is NaN.
  await store.captureThought({
    content: "postgrest hybrid needle SMD-507 in a distant thought",
    payload: { metadata: { kind: "hy" } },
    embedding: vec(1),
  });
  const rows = await store.hybridThoughts({ query: "SMD-507", embedding: vec(3), threshold: 0.5, limit: 5, filter: {} });
  assert(rows.length >= 1 && rows[0].content === "postgrest hybrid needle SMD-507 in a distant thought", `the RPC reaches the function and the exact hit comes first (${rows.map((r) => r.content.slice(0, 30)).join(" | ")})`);
  assert(rows[0].matchedNeedles.join() === "SMD-507" && rows[0].needles.join() === "SMD-507", "matched_needles and needles arrive as arrays, mapped to the store's names");
  assert(rows[0].needleCounts.length === 1 && rows[0].needleCounts[0] === 1, `needle_counts is mapped to numbers (${JSON.stringify(rows[0].needleCounts)})`);
  assert(rows[0].literalOnly === true && rows[0].commonNeedles.length === 0, "literal_only and common_needles are mapped, not left undefined");
  assert(typeof rows[0].similarity === "number" && Math.abs(rows[0].similarity) < 1e-6, `a keyword hit orthogonal to the query reports similarity 0, not null (${rows[0].similarity})`);
  assert(ISO_RE.test(rows[0].created_at), `created_at is an ISO string (got ${rows[0].created_at})`);

  const plain = await store.hybridThoughts({ query: "windows", embedding: vec(3), threshold: 0.5, limit: 5, filter: {} });
  const vector = await store.matchThoughts({ embedding: vec(3), threshold: 0.5, limit: 5, filter: {} });
  assert(plain.map((r) => r.id).join() === vector.map((r) => r.id).join(), "with no needle the fused order is matchThoughts' order over this store too");
  // Migration 020's two named arguments reach the function by name over this
  // client too, and the new column comes back — the RPC argument shape is what
  // this suite exists to hold.
  assert(vector.every((r) => Number.isFinite(r.score) && r.score === r.similarity), "match_thoughts' score column comes back through the RPC, equal to similarity at weight 0");
  const weighted = await store.hybridThoughts({ query: "windows", embedding: vec(3), threshold: 0.5, limit: 5, filter: {}, recencyWeight: 0.5, halfLifeDays: 30 });
  assert(weighted.length === plain.length && weighted.every((r) => Number.isFinite(r.score)), `recency_weight and half_life_days are accepted as named RPC arguments (${weighted.length} rows)`);
  const filtered = await store.hybridThoughts({ query: "SMD-507", embedding: vec(3), threshold: 0.5, limit: 5, filter: { kind: "nope" } });
  assert(filtered.every((r) => r.matchedNeedles.length === 0), "the jsonb filter is passed as an object and reaches the keyword arm");
}

console.log("\n[3d] Every read method returns the SQL store's timestamp form — and a row dated infinity does not throw");
{
  // getThought, listThoughts and pageThoughtMeta were bare casts too, and
  // getThought is the one the `fetch` tool prints verbatim (SMD-1040 review).
  const kw = await store.keywordThoughts({ query: "PGRST202", limit: 1, offset: 0, filter: {} });
  assert(kw.length === 1, `[3b]'s keyword thought is still there to read back (${kw.length})`);
  const rec = await store.getThought(kw[0].id);
  assert(rec !== null && ISO_RE.test(rec.created_at), `getThought's created_at is ISO (got ${String(rec?.created_at)})`);
  assert(rec !== null && (rec.updated_at == null || ISO_RE.test(rec.updated_at)), `getThought's updated_at is null or ISO (got ${String(rec?.updated_at)})`);
  assert((await store.getThought("not-a-uuid")) === null, "a malformed id is null on this store too, not a uuid cast error");

  // Migration 020 ranks an infinite created_at by design and test-schema plants
  // one; Date.toISOString throws on it, which would abort the whole result
  // array and turn preflight's probes into "skip". Bun hands it back as the
  // number Infinity, PostgREST as the string "infinity"; both come out as
  // Postgres's spelling. vec(6) is an axis no section before this one has used.
  const sql = new SQL({ url: URL_, max: 1 });
  const plantedId = await plantLegacyRow(sql, "a row dated infinity", "[" + vec(6).join(",") + "]", "infinity");
  try {
    const far = await store.matchThoughts({ embedding: vec(6), threshold: 0.5, limit: 5, filter: {} });
    const hit = far.find((r) => r.id === plantedId);
    assert(hit !== undefined, `the infinite row is returned, not thrown on (${far.length} rows)`);
    assert(hit?.created_at === "infinity", `…with created_at spelled as Postgres does (got ${hit?.created_at})`);
    // By id, not position: a NULL created_at sorts above +infinity under DESC,
    // so a later undated fixture must not turn this into a misleading failure.
    const list = await store.listThoughts({ limit: 50 });
    assert(list.find((r) => r.id === plantedId)?.created_at === "infinity" && list.filter((r) => r.id !== plantedId).every((r) => ISO_RE.test(r.created_at)),
           `listThoughts: the planted row is "infinity", every other created_at is ISO (${list.map((r) => r.created_at).join(" ").slice(0, 80)})`);
    const page = await store.pageThoughtMeta(0, 50);
    assert(page.some((r) => r.created_at === "infinity") && page.filter((r) => r.created_at !== "infinity").every((r) => r.created_at !== null && ISO_RE.test(r.created_at)),
           "pageThoughtMeta: the same on the stats walk's rows");
    const got = await store.getThought(plantedId);
    assert(got?.created_at === "infinity", "getThought: the same");
  } finally {
    // Gone before [8]'s date-range assertions, which expect a finite span —
    // and gone even if a store call above threw, so a later section of THIS
    // run is not misled (the next run starts from resetSchema regardless).
    await sql`DELETE FROM thoughts WHERE id = ${plantedId}::uuid`;
    await sql.close();
  }
}

console.log("\n[4] A thought is deduplicated across its own chunks");
{
  await store.captureThought({
    content: "a thought whose windows all look alike",
    payload: { metadata: {} },
    embedding: vec(4),
    chunks: [
      { content: "alike one", embedding: vec(4) },
      { content: "alike two", embedding: vec(4) },
      { content: "alike three", embedding: vec(4) },
    ],
  });
  const hits = await store.matchThoughts({ embedding: vec(4), threshold: 0.5, limit: 10, filter: {} });
  const mine = hits.filter((h) => h.content === "a thought whose windows all look alike");
  assert(mine.length === 1, `three matching chunks yield one row (${mine.length})`);
}

console.log("\n[5] The metadata filter still applies to chunk-sourced hits");
{
  const match = await store.matchThoughts({
    embedding: vec(3), threshold: 0.5, limit: 5, filter: { type: "reference" },
  });
  assert(match.length === 1, "a matching filter keeps the chunk-sourced hit");

  const miss = await store.matchThoughts({
    embedding: vec(3), threshold: 0.5, limit: 5, filter: { type: "person_note" },
  });
  assert(miss.length === 0, "a non-matching filter excludes it, rather than leaking it through the chunk path");
}

console.log("\n[6] Re-capture replaces chunks instead of accumulating them");
{
  await store.captureThought({
    content: "a long thought split into windows",     // same content → dedup path
    payload: { metadata: { type: "reference" } },
    embedding: vec(1),
    chunks: [{ content: "now a single window", embedding: vec(1) }],
  });
  const sql = new SQL({ url: URL_, max: 1 });
  const [c] = await sql`
    SELECT count(*)::int AS c FROM thought_chunks ch
    JOIN thoughts t ON t.id = ch.thought_id
    WHERE t.content = 'a long thought split into windows'`;
  assert(c.c === 1, `three windows replaced by one, not appended (${c.c})`);
  // 022: a re-capture with a vector and no chunks takes the 3-arg RPC, which
  // until 022 left the windows of the vector it replaced. The row's label is
  // unknown here (no model was named above), so nothing vouches for them.
  await store.captureThought({
    content: "a long thought split into windows",
    payload: { metadata: {} },
    embedding: vec(2),
    embeddingModel: "unit-test-model",
  });
  const [none] = await sql`
    SELECT count(*)::int AS c FROM thought_chunks ch
    JOIN thoughts t ON t.id = ch.thought_id
    WHERE t.content = 'a long thought split into windows'`;
  assert(none.c === 0, `…and a re-capture with a vector and no chunks — the 3-arg RPC — over a row whose label is unknown leaves none (${none.c})`);
  // Labelled with windows, then re-captured chunkless at the same model and at another.
  await store.captureThought({
    content: "a long thought split into windows",
    payload: { metadata: {} },
    embedding: vec(1),
    embeddingModel: "unit-test-model",
    chunks: [{ content: "one window again", embedding: vec(1) }],
  });
  const windows = async () => Number((await sql`
    SELECT count(*)::int AS c FROM thought_chunks ch JOIN thoughts t ON t.id = ch.thought_id
    WHERE t.content = 'a long thought split into windows'`)[0].c);
  await store.captureThought({ content: "a long thought split into windows", payload: { metadata: {} }, embedding: vec(2), embeddingModel: "unit-test-model" });
  assert((await windows()) === 1, "at the same model the 3-arg RPC keeps the windows");
  await store.captureThought({ content: "a long thought split into windows", payload: { metadata: {} }, embedding: vec(2), embeddingModel: "unit-test-model-2" });
  assert((await windows()) === 0, "…and at another model leaves none");
  await sql.close();
}

console.log("\n[7] resolveAgent's RPC argument shape, and the id it produces");
{
  /**
   * The same gap [1b] exists for, one migration later. Every other suite runs
   * OB1_STORE=sql, so `resolve_agent`'s three named arguments on this path —
   * p_key_hash, p_label, p_scope — were unverified. A Workers deployment
   * speaking PostgREST would have silently gone unattributed.
   */
  const hash = "e".repeat(64);
  const first = await store.resolveAgent({ keyHash: hash, label: "connector", scope: "read" });
  assert(first.ok === true, "the RPC resolves through the PostgREST client");
  assert(first.ok === true && /^[0-9a-f-]{36}$/.test(first.agentId), "…returning a uuid");
  assert(first.ok === true && first.created === true, "…and reporting first sight");

  const again = await store.resolveAgent({ keyHash: hash, label: "connector", scope: "read" });
  assert(again.ok === true && first.ok === true && again.agentId === first.agentId,
         "the same pair resolves to the same id on this store");

  // The end-to-end claim, on the path that had no coverage: an id resolved here
  // lands in the audit row when passed as the actor.
  const agentId = first.ok ? first.agentId : "";
  const { id } = await store.captureThought({
    content: "a thought captured by a resolved agent",
    payload: { metadata: { source: "postgrest-test" } },
    embedding: vec(6),
    actor: { name: "connector", source: "postgrest-test", agentId },
  });
  const sql = new SQL({ url: URL_, max: 1 });
  const [ev] = await sql`
    SELECT canonical_agent_id FROM thought_audit WHERE thought_id = ${id}`;
  assert(ev?.canonical_agent_id === agentId,
         `the resolved id reaches canonical_agent_id (${ev?.canonical_agent_id})`);
  await sql.close();
}

console.log("\n[8] statsSummary aggregates the corpus through the page walk this store owns (SMD-1249)");
{
  // The SQL store aggregates in one statement (migration 024); PostgREST cannot,
  // so it keeps the capped page walk, and this is where that walk is exercised.
  // Unique markers, so the counts are exact against a corpus other sections have
  // already filled.
  await store.captureThought({
    content: "a thought that marks the stats corpus",
    payload: { metadata: { type: "statmark", topics: ["stattopic"], people: ["StatPerson"] } },
    embedding: vec(7),
  });
  // A JSON null inside a topics array: the walk must drop it, exactly as
  // migration 024's function does, so the two stores render the same corpus
  // identically rather than this store emitting a spurious "null" bucket.
  await store.captureThought({
    content: "a thought whose topics array carries a null element",
    payload: { metadata: { type: "statmark", topics: ["stattopic", null] } },
    embedding: vec(7),
  });
  // A row with no created_at (the column is nullable; 020 and 023 name the
  // state). It sorts FIRST under ORDER BY created_at DESC, so before the walk
  // skipped it the epoch was reported as the corpus's newest thought — while
  // the SQL store's min/max ignore it. The range must match what SQL says.
  const sql = new SQL({ url: URL_, max: 1 });
  const undatedId = await plantLegacyRow(sql, "a row with no date", "[" + vec(7).join(",") + "]", null);
  const s = await (async () => {
    try {
      const [range] = await sql`SELECT min(created_at) AS oldest, max(created_at) AS newest FROM thoughts`;
      const s = await store.statsSummary();
      // The store's own formatter as the oracle, not a second one: on the edges
      // this PR added (an infinity, an empty range) `new Date(x).toISOString()`
      // throws or fabricates where the store returns "infinity" or null.
      assert(s.newest === isoTimestampOrNull(range.newest) && s.oldest === isoTimestampOrNull(range.oldest),
             `the date range ignores the undated row, as 024's min/max do (${s.oldest} → ${s.newest})`);
      assert(s.total === (await store.countThoughts()), "statsSummary.total equals countThoughts");
      return s;
    } finally {
      // The same cleanup contract as [3d]: gone before [9], thrown or not.
      await sql`DELETE FROM thoughts WHERE id = ${undatedId}::uuid`;
      await sql.close();
    }
  })();
  assert(s.aggregated === s.total, "a corpus under the cap is fully covered — the tool prints no truncation note");
  assert(s.types["statmark"] === 2, `the unique type is tallied across both rows (${JSON.stringify(s.types)})`);
  assert(s.topics["stattopic"] === 2, "the unique topic unnests from both arrays");
  assert(!("null" in s.topics), "a null array element is dropped, not counted as a \"null\" topic");
  assert(s.people["StatPerson"] === 1, "the unique person unnests from the array once");
  assert(s.oldest !== null && s.newest !== null && s.oldest <= s.newest, "date range spans the corpus");
}

console.log("\n[9] Provenance rides the envelope and reads back over PostgREST too (migration 025)");
{
  const { id: parent } = await store.captureThought({
    content: "postgrest provenance source",
    payload: { metadata: { type: "observation" } },
    embedding: vec(4),
  });
  const { id: child } = await store.captureThought({
    content: "postgrest provenance synthesis",
    payload: { metadata: { type: "synthesis", derivation_method: "synthesis" } },
    embedding: vec(5),
    derivedFrom: [parent],
    supersedes: parent,
  });

  // The RPC argument shapes for the two read functions, verified on this store —
  // the reason this suite exists (the default store speaks PostgREST).
  const anc = await store.traceProvenance({ id: child });
  assert(anc.some((n) => n.thoughtId === parent && n.depth === 1), "traceProvenance's rpc shape returns the source at depth 1");
  const der = await store.findDerivatives({ id: parent });
  assert(der.some((d) => d.id === child), "findDerivatives's rpc shape returns the synthesis");

  // The label lookup is a .from().in().order() here, not an rpc; its reduce must
  // keep the newest per superseded id and agree with the SQL store's DISTINCT ON.
  const sup = await store.supersededAmong([parent, child]);
  assert(sup[parent] === child, "supersededAmong maps the source to its replacement over PostgREST");
  assert(!(child in sup), "…and not the replacement itself");

  // Validation is the SQL function's, so it fires identically on this path.
  let bad = "";
  try {
    await store.captureThought({
      content: "postgrest provenance liar",
      payload: { metadata: {} },
      embedding: vec(6),
      derivedFrom: ["11111111-1111-1111-1111-111111111111"],
    });
  } catch (e) { bad = (e as Error).message; }
  assert(/does not exist/.test(bad), `a derived_from naming no thought is refused over PostgREST too (${bad.slice(0, 60)})`);
}

console.log("\n[10] listSupersessionProposals's rpc shape over PostgREST (migration 029, SMD-1294)");
{
  const { id: older } = await store.captureThought({ content: "postgrest queue: monthly", payload: { metadata: {} }, embedding: vec(7) });
  const { id: newer } = await store.captureThought({ content: "postgrest queue: annually", payload: { metadata: {} }, embedding: vec(7) });
  const admin = new SQL({ url: URL_, max: 1 });
  await admin`UPDATE thoughts SET created_at = now() - interval '10 days' WHERE id = ${older}`;
  const [{ id: pid }] = await admin`
    SELECT record_supersession_proposal(${older}::uuid, ${newer}::uuid, 'conflict_undirected', 0.6, 'neither says', 0.9, 'consolidate:stub@p1', NULL) AS id`;
  // The named-argument rpc, with a NULL limit taking the function's default.
  const pending = await store.listSupersessionProposals({});
  assert(pending.length === 1 && pending[0].id === pid && pending[0].verdict === "conflict_undirected" && pending[0].confidence === 0.6,
         `the rpc returns the pending proposal, mapped (${pending.length}: ${pending[0]?.verdict})`);
  assert(pending[0].older.id === older && pending[0].newer.id === newer && /monthly/.test(pending[0].older.content), "…with both thoughts inline");
  assert((await store.listSupersessionProposals({ status: null, limit: 5 })).length === 1, "p_status NULL and an explicit limit bind");
  assert((await store.listSupersessionProposals({ status: "rejected" })).length === 0, "…and a status with no rows is an empty list, not an error");
  await admin.close();
}

console.log("\n[11] deleteThought's rpc shape over PostgREST: p_detach named and bound as a boolean, the CITED refusal and the detach count normalised (migration 041, SMD-1712)");
{
  const admin = new SQL({ url: URL_, max: 1 });
  const { id: source } = await store.captureThought({ content: "postgrest source: the limit is 600 a minute", payload: { metadata: {} }, embedding: vec(0) });
  const { id: citer } = await store.captureThought({ content: "postgrest note resting on the source", payload: { metadata: {} }, embedding: vec(1) });
  const [{ r: wrote }] = (await admin`SELECT record_citation(${citer}::uuid, ${source}::uuid, 'the limit is 600', 'retrieved') AS r`) as { r: { ok: boolean } }[];
  assert(wrote.ok === true, `record_citation writes the citing row (${JSON.stringify(wrote)})`);
  // Without detach: refused, the count and the citing row mapped to the store's shape.
  const refused = await store.deleteThought({ id: source, actor: { name: "importer", source: "postgrest-test" } });
  assert(refused.ok === false && refused.error === "CITED" && refused.citedBy === 1 && refused.citations?.length === 1 && refused.citations[0].thoughtId === citer && refused.citations[0].stance === "retrieved" && refused.citations[0].text === "the limit is 600" && ISO_RE.test(refused.citations[0].createdAt ?? ""),
         `the CITED envelope normalises to citedBy and citations, created_at an ISO string (${JSON.stringify(refused)})`);
  assert(Number((await admin`SELECT count(*)::int AS c FROM thoughts WHERE id = ${source}`)[0].c) === 1, "…and the source stands");
  const spelled = await store.deleteThought({ id: source, detach: false });
  assert(spelled.ok === false && spelled.error === "CITED", "detach: false spelled is the default's refusal");
  // With detach: deleted, the count read back, the actor on the audit row.
  const detached = await store.deleteThought({ id: source, actor: { name: "importer", source: "postgrest-test" }, detach: true });
  assert(detached.ok === true && detached.id === source && detached.detached === 1 && detached.inactive === undefined, `p_detach binds and the count comes back (${JSON.stringify(detached)})`);
  const [ev] = await admin`SELECT actor_name FROM thought_audit WHERE thought_id = ${source} AND action = 'delete'`;
  assert(ev?.actor_name === "importer", `the delete is attributed over this path too (${ev?.actor_name})`);
  const [facet] = (await admin`SELECT payload FROM thought_facets WHERE thought_id = ${citer}`) as { payload: Record<string, unknown> }[];
  assert(facet?.payload?.source_id === null && facet?.payload?.source_deleted_id === source, "the citation records the deleted source");
  // A named call with p_id and p_actor alone — the vendored servers' rpc shape — still resolves.
  const { data, error } = await client.rpc("delete_thought", { p_id: citer, p_actor: null });
  assert(error === null && (data as { ok: boolean }).ok === true, `rpc with p_id and p_actor alone resolves through the default (${JSON.stringify(data ?? error)})`);
  await admin.close();
}

await store.close();
report();
