#!/usr/bin/env bun
/**
 * test-update-delete.ts — correcting and removing a thought, over real MCP.
 *
 * Two of these assertions exist because the extension this was ported from gets
 * them wrong, and porting the behaviour would have imported the bugs:
 *
 *   [3] content_fingerprint follows the content. Upstream issues a plain UPDATE
 *   and leaves the fingerprint describing text the row no longer holds, which
 *   breaks dedup in both directions — the OLD text merges into the edited row,
 *   the NEW text creates a duplicate of it.
 *
 *   [5] the concurrency guard is atomic. Upstream SELECTs updated_at, compares
 *   in application code, then UPDATEs, so a writer landing in between is exactly
 *   the lost update the feature exists to prevent.
 *
 * And two exist because this fork has machinery upstream does not: chunks must
 * follow the content [4], and a read-scoped key must not see the tools at all
 * [7].
 *
 *   ../db/with-postgres.sh bun test-update-delete.ts
 */

import { SQL } from "bun";
import { createAssert, requireDatabaseUrl, resetSchema } from "../db/test-support.ts";
import { mcpClient } from "./test-support.ts";
import { hashKey } from "./auth.ts";

const URL_ = requireDatabaseUrl("test-update-delete.ts");
const { assert, report } = createAssert();

const DIM = 64;
const EMB_MODEL = "stub-embed";
await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });

/** Vector keyed off text length, so a changed embedding is observable. */
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    if (url.pathname.endsWith("/embeddings")) {
      const v = new Array(DIM).fill(0);
      v[String(body.input ?? "").length % DIM] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ topics: ["edit"], type: "observation", people: [] }) } }],
    });
  },
});

const WRITE = "w".repeat(64);
const READ = "r".repeat(64);
process.env.MCP_ACCESS_KEYS = [
  `laptop:write:${hashKey(WRITE)}`,
  `viewer:read:${hashKey(READ)}`,
].join(",");
delete process.env.MCP_ACCESS_KEY;

process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = `http://localhost:${provider.port}/v1`;
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_METADATA_MODEL = "stub-meta";
// Small enough that a modest thought chunks, so [4] has chunks to check.
process.env.OB1_CHUNK_TOKENS = "60";
delete process.env.OPENROUTER_API_KEY;
delete process.env.SUPABASE_URL;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const writer = mcpClient(BASE, WRITE);
const viewer = mcpClient(BASE, READ);
const sql = new SQL({ url: URL_, max: 2 });

const LONG = "A decision recorded at length. " + "Filler that pads this note well past one chunk window. ".repeat(12) + "The conclusion: we chose the zeppelin.";

console.log("\n[1] Both tools are registered for a write key");
{
  const listed = (await writer.rpc("tools/list")) as { result?: { tools?: { name: string }[] } };
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  assert(names.includes("update_thought"), "update_thought present");
  assert(names.includes("delete_thought"), "delete_thought present");
  assert(names.length === 10, `ten tools in total (${names.length})`);
}

console.log("\n[2] An update with neither content nor metadata is refused");
{
  let msg = "";
  try { await writer.call("update_thought", { id: "00000000-0000-0000-0000-000000000000" }); }
  catch (e) { msg = (e as Error).message; }
  assert(/would do nothing/i.test(msg), `refused before touching the database (${msg.slice(0, 44)})`);
}

console.log("\n[3] Editing content moves the fingerprint with it");
{
  await writer.call("capture_thought", { content: "the original text" });
  const [row] = await sql`SELECT id, content_fingerprint AS fp FROM thoughts`;

  await writer.call("update_thought", { id: row.id, content: "the corrected text" });
  const [after] = await sql`SELECT content, content_fingerprint AS fp, embedding_model AS m FROM thoughts WHERE id = ${row.id}`;
  assert(after.content === "the corrected text", "the text changed");
  assert(after.fp !== row.fp, "…and the fingerprint changed with it");
  assert(after.m === EMB_MODEL, `…and the new vector carries the model the server embedded with (${after.m})`);

  // The consequence, which is the actual reason it matters: capturing the OLD
  // text must create a NEW thought, not merge into the edited one.
  await writer.call("capture_thought", { content: "the original text" });
  const [n] = await sql`SELECT count(*)::int AS c FROM thoughts`;
  assert(n.c === 2, `re-capturing the old text creates a separate thought (${n.c})`);
}

console.log("\n[4] Chunks and the embedding follow the content");
{
  const captured = await writer.call("capture_thought", { content: LONG });
  const id = captured.match(/id ([0-9a-f-]{36})/)?.[1] ?? "";
  assert(id.length === 36, `capture_thought returns the id, so it can be edited (${id.slice(0, 8)}…)`);
  const before = await sql`SELECT content FROM thought_chunks WHERE thought_id = ${id} ORDER BY chunk_index`;
  assert(before.length >= 2, `the long thought chunked (${before.length} chunks)`);

  await writer.call("update_thought", { id, content: "now it is short." });
  const after = await sql`SELECT content FROM thought_chunks WHERE thought_id = ${id}`;
  assert(after.length === 0, "editing to short content removes the stale chunks");

  // Otherwise the search index still describes the previous text: findable by
  // words no longer present, and not by the ones that are.
  const hit = await writer.call("search_thoughts", { query: "zeppelin", limit: 5, threshold: 0.9 });
  assert(!/now it is short/.test(hit), "the edited thought is no longer found by its old wording");
}

console.log("\n[5] The concurrency guard refuses a stale write");
{
  await writer.call("capture_thought", { content: "a contested thought" });
  const [row] = await sql`SELECT id, updated_at FROM thoughts WHERE content = 'a contested thought'`;
  const readAt = new Date(row.updated_at).toISOString();

  // Someone else edits after our read.
  await writer.call("update_thought", { id: row.id, metadata_patch: { other: "writer" } });

  let msg = "";
  try {
    await writer.call("update_thought", {
      id: row.id, content: "our overwrite", if_unchanged_since: readAt,
    });
  } catch (e) { msg = (e as Error).message; }
  assert(/STALE|changed after/i.test(msg), `refused as stale (${msg.slice(0, 46)})`);
  assert(/re-read/i.test(msg), "…and the message says how to recover");

  const [still] = await sql`SELECT content, metadata FROM thoughts WHERE id = ${row.id}`;
  assert(still.content === "a contested thought", "the other writer's edit survived");
  assert(still.metadata?.other === "writer", "…including their metadata");
}

console.log("\n[5b] Reading and immediately writing back is NOT a stale read");
{
  // The case [5] could not distinguish: it asserted a refusal when there really
  // had been an intervening edit, so it passed even while the guard refused
  // everything. Postgres keeps microseconds; JavaScript's Date keeps
  // milliseconds — so a client passing back exactly what it read was told
  // STALE_READ on a thought nobody had touched. Every well-behaved caller.
  await writer.call("capture_thought", { content: "a thought edited immediately" });
  const [row] = await sql`SELECT id, updated_at FROM thoughts WHERE content = 'a thought edited immediately'`;
  const asAClientWouldSeeIt = new Date(row.updated_at).toISOString();
  assert(String(row.updated_at) !== asAClientWouldSeeIt,
         "the stored timestamp really does carry precision a client cannot");

  const out = await writer.call("update_thought", {
    id: row.id, content: "edited with no intervening writer",
    if_unchanged_since: asAClientWouldSeeIt,
  });
  assert(/Updated/.test(out), "…and passing it straight back is accepted");

  // The guard must still bite when something genuinely changed.
  await writer.call("update_thought", { id: row.id, metadata_patch: { touched: true } });
  let msg = "";
  try {
    await writer.call("update_thought", {
      id: row.id, content: "should not land", if_unchanged_since: asAClientWouldSeeIt,
    });
  } catch (e) { msg = (e as Error).message; }
  assert(/STALE|changed after/i.test(msg), "…while a genuinely stale value is still refused");
}

console.log("\n[5c] Under genuine contention, exactly one writer wins");
{
  // [5] and [5b] test the guard sequentially, which cannot distinguish a real
  // atomic check from upstream's read-then-write race — that version passes a
  // sequential test too and only loses updates under concurrency.
  await writer.call("capture_thought", { content: "a thought two writers want" });
  const [row] = await sql`SELECT id, updated_at FROM thoughts WHERE content = 'a thought two writers want'`;
  const seen = new Date(row.updated_at).toISOString();

  const attempt = (text: string) =>
    writer.call("update_thought", { id: row.id, content: text, if_unchanged_since: seen })
      .then(() => "won").catch(() => "refused");
  const outcomes = await Promise.all([attempt("writer A got there"), attempt("writer B got there")]);

  assert(outcomes.filter((o) => o === "won").length === 1,
         `exactly one of two racing writers succeeded (${outcomes.join(", ")})`);

  // And the survivor is one of them intact, not a blend.
  const [final] = await sql`SELECT content FROM thoughts WHERE id = ${row.id}`;
  assert(/writer [AB] got there/.test(final.content), `the winner's text stands whole (${final.content})`);
}

console.log("\n[6] Delete removes the thought, its chunks, and reports a missing id");
{
  const captured = await writer.call("capture_thought", { content: LONG.replace("zeppelin", "harpsichord") });
  const id = captured.match(/id ([0-9a-f-]{36})/)?.[1] ?? "";
  const chunks = Number((await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${id}`)[0].c);
  assert(chunks >= 2, `it has ${chunks} chunks to cascade`);

  await writer.call("delete_thought", { id });
  const gone = Number((await sql`SELECT count(*)::int AS c FROM thoughts WHERE id = ${id}`)[0].c);
  const orphans = Number((await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${id}`)[0].c);
  assert(gone === 0, "the thought is gone");
  assert(orphans === 0, "…and its chunks cascaded, leaving no vectors answering searches");

  // The audit row is what makes a HARD delete defensible.
  const [ev] = await sql`SELECT diff, actor_name FROM thought_audit WHERE thought_id = ${id} AND action = 'delete'`;
  assert(/harpsichord/.test(String(ev?.diff?.previous_content)), "the prior content is recoverable from the audit trail");
  assert(ev?.actor_name === "laptop", `attributed to the key that deleted it (${ev?.actor_name})`);

  let msg = "";
  try { await writer.call("delete_thought", { id }); } catch (e) { msg = (e as Error).message; }
  assert(/No thought with id/i.test(msg), "deleting it again is a clean error, not a silent success");
}

console.log("\n[7] A read-scoped key cannot see either tool");
{
  const listed = (await viewer.rpc("tools/list")) as { result?: { tools?: { name: string }[] } };
  const names = (listed.result?.tools ?? []).map((t) => t.name);
  assert(!names.includes("update_thought"), "update_thought is not registered for a read key");
  assert(!names.includes("delete_thought"), "delete_thought is not registered either");
  assert(names.length === 7, `seven read-only tools (${names.length})`);

  // Not merely hidden — calling it must fail rather than being served.
  let msg = "";
  try { await viewer.call("delete_thought", { id: "00000000-0000-0000-0000-000000000000" }); }
  catch (e) { msg = (e as Error).message; }
  assert(msg.length > 0, "and invoking it directly is refused");
}

console.log("\n[8] Editing into an exact duplicate is refused");
{
  const [a] = await sql`SELECT id FROM thoughts WHERE content = 'the corrected text'`;
  let msg = "";
  try { await writer.call("update_thought", { id: a.id, content: "the original text" }); }
  catch (e) { msg = (e as Error).message; }
  assert(/already exists/i.test(msg), `refused rather than violating the unique index (${msg.slice(0, 40)})`);
  assert(/delete the other/i.test(msg), "…and suggests what to do about it");
}

console.log("\n[8b] Re-saving a legacy twin's own text is accepted, and the reply names the pair (migration 018)");
{
  // Two rows from before migration 003: NULL fingerprints, the same text but
  // for whitespace. 013's update_thought refused the second's own text once
  // the first had a fingerprint; the tool now keeps the edit and says so.
  const [a] = await sql`INSERT INTO thoughts (content, content_fingerprint) VALUES ('Legacy Twin Note', NULL) RETURNING id`;
  const [b] = await sql`INSERT INTO thoughts (content, content_fingerprint) VALUES ('legacy   twin note', NULL) RETURNING id`;
  const first = await writer.call("update_thought", { id: a.id, content: "Legacy Twin Note" });
  assert(/^Updated /.test(first) && !/Note: this thought holds the same text/.test(first), "the first twin is updated with no pair named — it simply gains its fingerprint");
  const second = await writer.call("update_thought", { id: b.id, content: "legacy   twin note" });
  assert(/^Updated /.test(second), `the second twin's own text is accepted rather than refused (${second.slice(0, 40)})`);
  assert(new RegExp(`Note: this thought holds the same text as ${a.id}`).test(second), "…and the reply names the thought it duplicates");
  assert(/Read both before deciding/.test(second), "…and says what to do about it without asserting which is older");
  const rows = (await sql`SELECT id, content_fingerprint AS fp FROM thoughts WHERE id IN (${a.id}::uuid, ${b.id}::uuid)`) as { id: string; fp: string | null }[];
  const fa = rows.find((r) => r.id === a.id), fb = rows.find((r) => r.id === b.id);
  assert(rows.length === 2 && fa?.fp != null && fb !== undefined && fb.fp === null, `the first carries the fingerprint, the second stays NULL (${JSON.stringify(rows.map((r) => r.fp !== null))})`);
  // The refusal in [8] is for a genuine edit, and still stands.
  let msg = "";
  try { await writer.call("update_thought", { id: b.id, content: "the corrected text" }); }
  catch (e) { msg = (e as Error).message; }
  assert(/already exists/i.test(msg), "editing the twin INTO another thought's text is still refused");
}

console.log("\n[9] `supersedes` through the tool: set, clear, a loop and a ghost refused by name (migration 032)");
{
  const idOf = (reply: string) => reply.match(/id ([0-9a-f-]{36})/)?.[1] ?? "";
  const older = idOf(await writer.call("capture_thought", { content: "the plan, first version: ship on Monday" }));
  const newer = idOf(await writer.call("capture_thought", { content: "the plan, revised: ship on Wednesday" }));
  assert(older.length === 36 && newer.length === 36, "(two versions captured)");
  const pointer = async (id: string) => ((await sql`SELECT supersedes AS s FROM thoughts WHERE id = ${id}::uuid`)[0] as { s: string | null }).s;

  // A supersedes-only edit is an edit — not "would do nothing" — and the
  // reply says what it did.
  const set = await writer.call("update_thought", { id: newer, supersedes: older });
  assert(/^Updated /.test(set) && new RegExp(`now supersedes ${older}`).test(set) && /updated_at:/.test(set), `the pointer is set and the reply names it (${set.split("\n")[0]})`);
  assert((await pointer(newer)) === older, "…and the column holds it");
  const [audit] = await sql`SELECT actor_name, diff FROM thought_audit WHERE thought_id = ${newer}::uuid AND action = 'update' ORDER BY created_at DESC, id LIMIT 1`;
  assert(audit?.actor_name === "laptop" && audit?.diff?.supersedes?.after === older, `…audited under the key's name with the supersedes diff (${JSON.stringify(audit?.diff)})`);

  // The refusals, in the tool's words.
  let msg = "";
  try { await writer.call("update_thought", { id: older, supersedes: newer }); } catch (e) { msg = (e as Error).message; }
  assert(/would close a loop/.test(msg) && /point the newer thought at the older/.test(msg), `pointing the older at the newer is refused as a loop, with the fix (${msg.slice(0, 60)})`);
  try { await writer.call("update_thought", { id: newer, supersedes: "00000000-0000-4000-8000-000000000000" }); } catch (e) { msg = (e as Error).message; }
  assert(/no thought with the id given as supersedes/.test(msg), `a pointer at no thought is refused by name (${msg.slice(0, 60)})`);
  try { await writer.call("update_thought", { id: newer, supersedes: "null" }); } catch (e) { msg = (e as Error).message; }
  assert(/must be a thought id/.test(msg) && /not "null"/.test(msg), `a value that is not an id — the word "null" included — is refused at the tool, not raised by the function (${msg.slice(0, 60)})`);
  assert((await pointer(newer)) === older && (await pointer(older)) === null, "…and no refusal wrote anything");
  const [{ c: rowsBefore }] = await sql`SELECT count(*)::int AS c FROM thoughts`;
  try { await writer.call("capture_thought", { content: "a capture naming no id", supersedes: "not-an-id" }); } catch (e) { msg = (e as Error).message; }
  assert(/must be a thought id/.test(msg) && Number((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c) === Number(rowsBefore), `capture_thought refuses a non-id supersedes the same way, before it embeds or writes (${msg.slice(0, 60)})`);

  // null clears; omitting the key leaves.
  const meta = await writer.call("update_thought", { id: newer, metadata_patch: { reviewed: true } });
  assert(/^Updated /.test(meta) && !/supersedes/.test(meta) && (await pointer(newer)) === older, "an edit that omits supersedes leaves the pointer and says nothing about it");
  const cleared = await writer.call("update_thought", { id: newer, supersedes: null });
  assert(/supersedes cleared/.test(cleared) && (await pointer(newer)) === null, `null clears it, and the reply says so (${cleared.split("\n")[0]})`);
}

console.log("\n[10] A thought cited as a source is refused by name and detached on request; expired and superseded citations never block and are marked; thirteen are counted and ten shown; a real foreign-key failure is a fault, not a refusal (migration 042)");
{
  const idOf = (reply: string) => reply.match(/id ([0-9a-f-]{36})/)?.[1] ?? "";
  const cite = async (thought: string, src: string, text: string, stance = "retrieved") =>
    ((await sql`SELECT record_citation(${thought}::uuid, ${src}::uuid, ${text}, ${stance}) AS r`)[0] as { r: { ok: boolean; id?: string; error?: string } }).r;
  const source = idOf(await writer.call("capture_thought", { content: "the source: the API allows 600 calls a minute" }));
  const note = idOf(await writer.call("capture_thought", { content: "the note: our ceiling is 500 a minute because of the limit" }));
  const c1 = await cite(note, source, "the limit is 600 a minute");
  assert(c1.ok === true, `record_citation writes the citing row (${JSON.stringify(c1)})`);

  // Refused in the tool's words, the citing thought and its statement named,
  // the way through spelled; nothing deleted, nothing audited.
  let msg = "";
  try { await writer.call("delete_thought", { id: source }); } catch (e) { msg = (e as Error).message; }
  assert(/Refused: 1 citation on other thoughts rests on/.test(msg) && new RegExp(`- ${note} \\(retrieved\\): the limit is 600 a minute`).test(msg) && /pass detach_citations: true/.test(msg),
    `deleting the source is refused, the citing thought and its statement named, the way through spelled (${msg.slice(0, 70)})`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM thoughts WHERE id = ${source}::uuid`)[0].c) === 1 &&
         Number((await sql`SELECT count(*)::int AS c FROM thought_audit WHERE thought_id = ${source}::uuid AND action = 'delete'`)[0].c) === 0,
    "…and the source stands, no audit delete row written");
  // Detach: deleted, the reply counts, the citation keeps its text and records the source.
  const detached = await writer.call("delete_thought", { id: source, detach_citations: true });
  assert(new RegExp(`^Deleted ${source}\\. Its previous content is preserved in the audit trail\\.`).test(detached) && /1 citation on other thoughts rested on it and was detached/.test(detached) && new RegExp(`records ${source} as its deleted source`).test(detached),
    `with detach_citations the source is deleted and the reply says what became of the citation (${detached.slice(0, 60)})`);
  const [facet] = (await sql`SELECT payload FROM thought_facets WHERE thought_id = ${note}::uuid`) as { payload: Record<string, unknown> }[];
  assert(facet?.payload?.source_id === null && facet?.payload?.source_deleted_id === source && typeof facet?.payload?.source_deleted_at === "string" && facet?.payload?.text === "the limit is 600 a minute" && facet?.payload?.stance === "retrieved",
    `the citation keeps its text and stance, loses its source and records which thought was deleted and when (${JSON.stringify(facet?.payload)})`);
  const [ev] = await sql`SELECT actor_name, diff FROM thought_audit WHERE thought_id = ${source}::uuid AND action = 'delete'`;
  assert(ev?.actor_name === "laptop" && /600 calls a minute/.test(String(ev?.diff?.previous_content)), "…and the delete is audited under the key's name with the previous content — the actor was set outside the block the refusal rolls back");

  // Expired and superseded citations never block, and are marked when the source goes.
  const source2 = idOf(await writer.call("capture_thought", { content: "a second source with only stale citations" }));
  const note2 = idOf(await writer.call("capture_thought", { content: "a note whose citations of the second source are history" }));
  const expired = (await cite(note2, source2, "an old claim")).id!;
  await sql`UPDATE thought_facets SET valid_until = now() - interval '1 day' WHERE id = ${expired}::uuid`;
  const replaced = (await cite(note2, source2, "a replaced claim")).id!;
  const replacing = (await cite(note2, source2, "the replacing claim")).id!;
  await sql`UPDATE thought_facets SET superseded_by = ${replacing}::uuid WHERE id = ${replaced}::uuid`;
  msg = "";
  try { await writer.call("delete_thought", { id: source2 }); } catch (e) { msg = (e as Error).message; }
  assert(/Refused: 1 citation/.test(msg) && /the replacing claim/.test(msg) && !/an old claim|a replaced claim/.test(msg), `only the active citation counts and is named — the expired and the superseded are not (${msg.slice(0, 50)})`);
  await sql`UPDATE thought_facets SET valid_until = now() - interval '1 hour' WHERE id = ${replacing}::uuid`;
  const clean = await writer.call("delete_thought", { id: source2 });
  assert(new RegExp(`^Deleted ${source2}\\.`).test(clean) && /3 expired or superseded citations that named it were marked with the deletion/.test(clean) && !/detached/.test(clean),
    `with every citation expired or superseded the delete goes through without detach_citations, and the reply says the three were marked (${clean.slice(0, 60)})`);
  const marked = (await sql`SELECT payload->>'source_id' AS s, payload->>'source_deleted_id' AS d FROM thought_facets WHERE thought_id = ${note2}::uuid`) as { s: string | null; d: string }[];
  assert(marked.length === 3 && marked.every((m) => m.s === null && m.d === source2), "…and all three record the deleted source, so no row names a thought that is gone");

  // Thirteen citing thoughts: the count is the whole, the sample ten.
  const source3 = idOf(await writer.call("capture_thought", { content: "a source thirteen notes cite" }));
  for (let i = 0; i < 13; i++) await cite(idOf(await writer.call("capture_thought", { content: `citing note number ${i} of thirteen` })), source3, `statement ${i}`);
  msg = "";
  try { await writer.call("delete_thought", { id: source3 }); } catch (e) { msg = (e as Error).message; }
  assert(/Refused: 13 citations on other thoughts rest on/.test(msg) && (msg.match(/^  - [0-9a-f-]{36} \(retrieved\): statement \d+$/gm) ?? []).length === 10 && /…and 3 more/.test(msg),
    `thirteen citations: the count says 13, ten are listed, the rest counted (${(msg.match(/^  - /gm) ?? []).length} listed)`);

  // A citation's text in the reply goes through the cleaner every other
  // thought-derived text does: control characters never reach the terminal.
  const source4 = idOf(await writer.call("capture_thought", { content: "a source cited with control characters" }));
  await cite(idOf(await writer.call("capture_thought", { content: "a note whose citation text carries an escape" })), source4, "limit is 600[2J and more");
  msg = "";
  try { await writer.call("delete_thought", { id: source4 }); } catch (e) { msg = (e as Error).message; }
  assert(/limit is 600\[2J and more/.test(msg) && !/[ --]/.test(msg), `the citation's text is cleaned for display in the refusal (${JSON.stringify(msg.match(/limit is 600.{0,12}/)?.[0])})`);

  // A real foreign-key failure on the delete is a fault, not CITED: the
  // function catches only the guard's SQLSTATE.
  const pinned = idOf(await writer.call("capture_thought", { content: "a thought a foreign table pins" }));
  await sql`CREATE TABLE zz_pin_1712 (thought_id uuid REFERENCES thoughts(id))`;
  await sql`INSERT INTO zz_pin_1712 VALUES (${pinned}::uuid)`;
  msg = "";
  try { await writer.call("delete_thought", { id: pinned }); } catch (e) { msg = (e as Error).message; }
  assert(/delete_thought failed: .*violates foreign key constraint "zz_pin_1712_thought_id_fkey"/.test(msg) && !/Refused/.test(msg), `a foreign-key violation surfaces as the fault it is, not as a refusal (${msg.slice(0, 80)})`);
  await sql`DROP TABLE zz_pin_1712`;
}

await sql.close();
server.stop();
provider.stop();
report();
