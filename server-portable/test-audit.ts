#!/usr/bin/env bun
/**
 * test-audit.ts — the audit trail, driven through the real MCP server.
 *
 * Migration 008 departs from the extension it was ported from in three ways,
 * and each departure is a claim that needs a test rather than a comment:
 *
 *   Append-only is enforced by a TRIGGER, not by grants. Upstream withheld
 *   UPDATE and DELETE from `service_role`, which is meaningless here because
 *   the application owns the schema and an owner's privileges cannot be
 *   revoked. [4] asserts the trigger refuses both, which a grant could not.
 *
 *   The audit row is written INSIDE the mutating transaction, so an event
 *   cannot be lost independently of the change it records. [5] asserts a
 *   rolled-back mutation leaves no audit row — the property fire-and-forget
 *   cannot offer.
 *
 *   The actor arrives on a transaction-local setting. [2] asserts the access
 *   key's name reaches the row, and [6] that it does not leak to the next
 *   caller on a pooled connection, which a session-level setting would.
 *
 *   ../db/with-postgres.sh bun test-audit.ts
 */

import { SQL } from "bun";
import { createAssert, requireDatabaseUrl, resetSchema } from "../db/test-support.ts";
import { mcpClient } from "./test-support.ts";
import { hashKey } from "./auth.ts";

const URL_ = requireDatabaseUrl("test-audit.ts");
const { assert, report } = createAssert();

const DIM = 64;
const EMB_MODEL = "stub-embed";

await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });

/** Deterministic provider — this suite is about audit, not about models. */
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
      choices: [{ message: { content: JSON.stringify({ topics: ["audit"], type: "observation", people: [] }) } }],
    });
  },
});

// Two named write keys, so [2] can show the row records WHICH key wrote it —
// the whole point of carrying an identity rather than a boolean.
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
process.env.MCP_ACCESS_KEYS = [
  `laptop:write:${hashKey(KEY_A)}`,
  `importer:write:${hashKey(KEY_B)}`,
].join(",");
delete process.env.MCP_ACCESS_KEY;

process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = `http://localhost:${provider.port}/v1`;
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_METADATA_MODEL = "stub-meta";
delete process.env.OPENROUTER_API_KEY;
delete process.env.SUPABASE_URL;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const laptop = mcpClient(BASE, KEY_A);
const importer = mcpClient(BASE, KEY_B);

const sql = new SQL({ url: URL_, max: 2 });
const audit = () => sql`SELECT action, actor_name, source, diff FROM thought_audit ORDER BY created_at`;

console.log("\n[1] A capture writes exactly one audit row");
{
  await laptop.call("capture_thought", { content: "the first captured thought" });
  const rows = await audit();
  assert(rows.length === 1, `one row (${rows.length})`);
  assert(rows[0].action === "capture", `action is capture (${rows[0].action})`);
  assert(rows[0].source === "mcp", `source carried through (${rows[0].source})`);
}

console.log("\n[2] The row records WHICH key wrote it");
{
  await importer.call("capture_thought", { content: "a thought from the importer" });
  const rows = await audit();
  const names = rows.map((r: { actor_name: string }) => r.actor_name);
  assert(names[0] === "laptop", `first capture attributed to laptop (${names[0]})`);
  assert(names[1] === "importer", `second attributed to importer (${names[1]})`);
  // Without this, audit answers "something changed" rather than "who changed it".
  assert(new Set(names).size === 2, "two distinct actors distinguished");
}

console.log("\n[3] A delete preserves enough to reconstruct what was lost");
{
  const [row] = await sql`SELECT id, content FROM thoughts WHERE content LIKE 'the first%'`;
  await sql`DELETE FROM thoughts WHERE id = ${row.id}`;

  const [ev] = await sql`SELECT action, diff FROM thought_audit WHERE action = 'delete'`;
  assert(ev !== undefined, "the delete produced an audit row");
  assert(ev.diff?.previous_content === row.content,
         "…preserving the full prior content, so a hard delete is recoverable");
  assert(ev.diff?.previous_metadata?.source === "mcp", "…and the prior metadata");

  // The FK omission is deliberate: the audit row must outlive its subject.
  const [orphan] = await sql`
    SELECT count(*)::int AS c FROM thought_audit a
    WHERE a.thought_id = ${row.id}`;
  assert(orphan.c >= 1, "audit rows survive deletion of the thought they describe");
}

console.log("\n[4] Append-only is enforced, not merely intended");
{
  // The claim that upstream's grant-based approach could not make here: the
  // connection below owns the schema, so a withheld GRANT would not have
  // stopped either statement.
  let updateRefused = "";
  try { await sql`UPDATE thought_audit SET action = 'capture'`; }
  catch (e) { updateRefused = (e as Error).message; }
  assert(/append-only/i.test(updateRefused), `UPDATE refused (${updateRefused.split("\n")[0].slice(0, 48)})`);

  let deleteRefused = "";
  try { await sql`DELETE FROM thought_audit`; }
  catch (e) { deleteRefused = (e as Error).message; }
  assert(/append-only/i.test(deleteRefused), "DELETE refused");
  assert(/drop trigger/i.test(deleteRefused), "…and the error says how to prune deliberately");

  const [c] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(c.c === 3, `history intact after both attempts (${c.c} rows)`);
}

console.log("\n[5] The audit row cannot commit without its mutation");
{
  const before = Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('ob1.actor', ${JSON.stringify({ name: "rollback" })}, true)`;
      await tx`INSERT INTO thoughts (content, metadata) VALUES ('doomed', '{}'::jsonb)`;
      throw new Error("deliberate rollback");
    });
  } catch { /* expected */ }
  const after = Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  assert(after === before, `a rolled-back mutation leaves no audit row (${before} → ${after})`);
  // Fire-and-forget would have logged an event for a change that never happened.
}

console.log("\n[6] The actor does not leak between transactions");
{
  // SET LOCAL is transaction-scoped. A session GUC would leave `laptop` set on
  // this pooled connection and mis-attribute the next writer.
  await sql`INSERT INTO thoughts (content, metadata) VALUES ('written with no actor', '{}'::jsonb)`;
  const [ev] = await sql`
    SELECT actor_name FROM thought_audit
    WHERE thought_id = (SELECT id FROM thoughts WHERE content = 'written with no actor')`;
  assert(ev.actor_name === null,
         `a mutation with no actor set records NULL, not a stale name (${ev.actor_name})`);
}

console.log("\n[7] A malformed actor setting does not break the mutation");
{
  // Audit observes; it must not obstruct. ob1_current_actor() swallows a bad
  // value rather than failing the capture that carried it.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('ob1.actor', 'not json at all', true)`;
    await tx`INSERT INTO thoughts (content, metadata) VALUES ('survived a bad actor', '{}'::jsonb)`;
  });
  const [t] = await sql`SELECT count(*)::int AS c FROM thoughts WHERE content = 'survived a bad actor'`;
  assert(t.c === 1, "the capture succeeded despite an unparseable actor");
  const [ev] = await sql`
    SELECT actor_name FROM thought_audit
    WHERE thought_id = (SELECT id FROM thoughts WHERE content = 'survived a bad actor')`;
  assert(ev?.actor_name === null, "…and was audited with a NULL actor");
}

await sql.close();
server.stop();
provider.stop();
report();
