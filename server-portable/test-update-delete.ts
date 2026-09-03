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
  assert(names.length === 8, `eight tools in total (${names.length})`);
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
  const [after] = await sql`SELECT content, content_fingerprint AS fp FROM thoughts WHERE id = ${row.id}`;
  assert(after.content === "the corrected text", "the text changed");
  assert(after.fp !== row.fp, "…and the fingerprint changed with it");

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
  assert(names.length === 5, `five read-only tools (${names.length})`);

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

await sql.close();
server.stop();
provider.stop();
report();
