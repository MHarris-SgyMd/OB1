#!/usr/bin/env bun
/**
 * test-upgrade.ts — migrations applied INCREMENTALLY, onto a database with data
 * already in it.
 *
 * Every other suite calls `resetSchema`, which drops everything and applies all
 * ten from scratch against an empty database. That is the one situation a real
 * deployment is never in. A migration that silently only works on an empty
 * table — an ADD COLUMN with a NOT NULL and no default, an ALTER that a trigger
 * refuses, a CREATE OR REPLACE that reverts an earlier one — passes the entire
 * gate and fails the first time somebody upgrades.
 *
 * Migration 010 made that gap concrete: it adds a column to `thought_audit`,
 * which is append-only and enforced by a trigger, and its header claims the
 * existing rows "correctly read NULL". Nothing held that claim. This does, and
 * generalises it, so the next migration is covered before it is written.
 *
 *   ./with-postgres.sh bun test-upgrade.ts
 */

import { SQL } from "bun";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, createAssert, dropSchema, requireDatabaseUrl, resetSchema } from "./test-support.ts";
import { UPDATE_THOUGHT_SIGNATURE } from "./config.mjs";

const URL_ = requireDatabaseUrl("test-upgrade.ts");
const { assert, report } = createAssert();

const OPTS = { dim: 8, model: "stub-embed" };
const MIGRATIONS = readdirSync(join(dirname(fileURLToPath(import.meta.url)), "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** The schema's shape, as a comparable string: every column, and every function signature. */
async function shape(sql: SQL): Promise<{ columns: string; functions: string }> {
  const cols = await sql`
    SELECT table_name || '.' || column_name || ':' || data_type AS c
      FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY 1`;
  const fns = await sql`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS f
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname NOT LIKE 'vector%' AND p.proname NOT LIKE 'halfvec%'
       AND p.proname NOT LIKE 'sparsevec%' AND p.proname NOT LIKE 'ivfflat%'
       AND p.proname NOT LIKE 'hnsw%' AND p.proname NOT LIKE 'l2_%'
       AND p.proname NOT LIKE 'cosine_%' AND p.proname NOT LIKE 'inner_%'
       AND p.proname NOT LIKE 'binary_quantize%' AND p.proname NOT LIKE 'subvector%'
       AND p.proname NOT LIKE 'array_to_%' AND p.proname NOT LIKE '%_to_vector'
       AND p.proname NOT LIKE '%_to_halfvec' AND p.proname NOT LIKE '%_to_sparsevec'
       AND p.proname NOT LIKE 'avg' AND p.proname NOT LIKE 'sum'
       AND p.proname NOT LIKE 'l1_%' AND p.proname NOT LIKE 'jaccard_%'
       AND p.proname NOT LIKE 'hamming_%' AND p.proname NOT LIKE 'quantize%'
     ORDER BY 1`;
  return {
    columns: cols.map((r: { c: string }) => r.c).join("\n"),
    functions: fns.map((r: { f: string }) => r.f).join("\n"),
  };
}

console.log("[1] Every migration applies onto a database that already holds data");
{
  await dropSchema(URL_);
  const sql = new SQL({ url: URL_, max: 1 });

  let written = 0;
  for (const file of MIGRATIONS) {
    await applyMigrations(URL_, { ...OPTS, only: (f) => f === file });

    // From 001 onward there is a `thoughts` table to write to. Each step leaves
    // one more row behind, so a later migration that cannot cope with existing
    // rows fails here rather than in production.
    await sql`INSERT INTO thoughts (content, metadata)
              VALUES (${`written just after ${file}`}, '{}'::jsonb)`;
    written++;
  }

  const [rows] = await sql`SELECT count(*)::int AS c FROM thoughts`;
  assert(rows.c === written,
         `all ${written} rows written between migrations survived every later one (${rows.c})`);

  // The mirror that makes the loop above mean something: an incremental build
  // must end in the SAME schema as a from-scratch one. Without this, a migration
  // could quietly no-op on an existing object and the row count would still pass.
  const incremental = await shape(sql);
  await sql.close();

  await resetSchema(URL_, OPTS);
  const fresh = new SQL({ url: URL_, max: 1 });
  const scratch = await shape(fresh);
  await fresh.close();

  assert(incremental.columns === scratch.columns, "the incremental schema has the same columns as a fresh one");
  assert(incremental.functions === scratch.functions, "…and the same functions");
}

console.log("\n[2] Migration 010 onto a populated 009 — the actual upgrade");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "010" });
  const sql = new SQL({ url: URL_, max: 1 });

  // History written by a server that predates the registry: it has a name,
  // because migration 008 recorded one, and it can never have an id.
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('ob1.actor', ${JSON.stringify({ name: "legacy" })}, true)`;
    await tx`INSERT INTO thoughts (content, metadata) VALUES ('written before 010', '{}'::jsonb)`;
  });

  const [absent] = await sql`
    SELECT count(*)::int AS c FROM information_schema.columns
     WHERE table_name = 'thought_audit' AND column_name = 'canonical_agent_id'`;
  assert(absent.c === 0, "at migration 009 there is no canonical_agent_id column");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("010") });

  const [old] = await sql`SELECT actor_name, canonical_agent_id FROM thought_audit`;
  assert(old.canonical_agent_id === null, "a row written before 010 reads NULL, not a fabricated id");
  assert(old.actor_name === "legacy", "…and keeps the only attribution it ever had");

  /**
   * The mirror. Every assertion above would also pass if 010 had failed to add
   * the column at all, or if the trigger had stopped recording ids — so the
   * next write has to prove the upgrade actually took.
   */
  const agent = (await sql`SELECT resolve_agent(${"a".repeat(64)}, 'laptop', 'write') AS r`)[0].r;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('ob1.actor', ${JSON.stringify({ name: "laptop", agent_id: agent.agent_id })}, true)`;
    await tx`INSERT INTO thoughts (content, metadata) VALUES ('written after 010', '{}'::jsonb)`;
  });
  const [fresh] = await sql`
    SELECT canonical_agent_id FROM thought_audit
     WHERE thought_id = (SELECT id FROM thoughts WHERE content = 'written after 010')`;
  assert(fresh.canonical_agent_id === agent.agent_id, "a write after the upgrade does carry an id");

  // ALTER TABLE is DDL and the append-only guard is a ROW trigger on UPDATE and
  // DELETE, so adding a column is not supposed to trip it — and the guard is
  // not supposed to be weakened by having done so.
  let refused = "";
  try { await sql`UPDATE thought_audit SET action = 'capture'`; }
  catch (e) { refused = (e as Error).message; }
  assert(/append-only/i.test(refused), "the append-only trigger still refuses UPDATE after the ALTER");

  // A second audit trigger would double-record every mutation from here on.
  const trg = await sql`
    SELECT tgname FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND NOT tgisinternal`;
  const names = trg.map((t: { tgname: string }) => t.tgname).sort();
  assert(names.length === 2 && names[0] === "thoughts_audit",
         `exactly one audit trigger on thoughts, not two (${names.join(", ")})`);
  await sql.close();
}

console.log("\n[3] Re-applying is a no-op, not a second copy");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const before = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const agentsBefore = await sql`SELECT count(*)::int AS c FROM ob1_agents`;

  // Twice: 010 alone, then the whole set over the top. `bun migrate.ts` tracks
  // what it has applied, but test-support does not, and a migration that is not
  // idempotent breaks a re-run either way.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("010") });
  await applyMigrations(URL_, OPTS);

  const after = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const agentsAfter = await sql`SELECT count(*)::int AS c FROM ob1_agents`;
  assert(after[0].c === before[0].c, `audit history unchanged by re-applying (${before[0].c} → ${after[0].c})`);
  assert(agentsAfter[0].c === agentsBefore[0].c, "the agent registry is not duplicated either");

  const [dupCol] = await sql`
    SELECT count(*)::int AS c FROM information_schema.columns
     WHERE table_name = 'thought_audit' AND column_name = 'canonical_agent_id'`;
  assert(dupCol.c === 1, "the added column exists exactly once");
  await sql.close();
}

console.log("\n[4] Migration 021 onto a populated 020 — the column, and the function it replaces");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "021" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]`;

  // A corpus written before 021: through the writers and around them, and
  // what the claim table remembers of it — the one evidence 021 labels from.
  const [{ r: viaUpsert }] = await sql`SELECT upsert_thought('captured before 021', '{"metadata":{}}'::jsonb, ${vec}::vector) AS r`;
  const viaUpsertId = (viaUpsert as { id: string }).id;
  await sql`INSERT INTO thoughts (content, metadata, embedding) VALUES ('inserted before 021', '{}'::jsonb, ${vec}::vector)`;
  const [{ id: editedId }] = await sql`INSERT INTO thoughts (content, metadata, embedding) VALUES ('re-embedded, then edited', '{}'::jsonb, ${vec}::vector) RETURNING id`;
  const [{ id: nightlyId }] = await sql`INSERT INTO thoughts (content, metadata, embedding) VALUES ('re-embedded under a key naming no model', '{}'::jsonb, ${vec}::vector) RETURNING id`;
  const [{ id: vectorlessId }] = await sql`INSERT INTO thoughts (content, metadata) VALUES ('re-embedded, vector since removed', '{}'::jsonb) RETURNING id`;
  const KEY = `reembed:${OPTS.model}@${OPTS.dim}`;
  // Finished passes: the model's own key over four rows (an earlier pass to
  // another model over one of them, so the LATEST claim must win), a key that
  // names no model over one row. Every claim finished after its row was written.
  await sql.unsafe(`SELECT enqueue_thoughts('reembed:earlier-model@${OPTS.dim}', ARRAY['${viaUpsertId}']::uuid[])`);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() - interval '1 hour' WHERE work_type = ${"reembed:earlier-model@" + OPTS.dim}`;
  await sql.unsafe(`SELECT enqueue_thoughts('${KEY}', ARRAY['${viaUpsertId}', '${editedId}', '${vectorlessId}']::uuid[])`);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${KEY}`;
  await sql.unsafe(`SELECT enqueue_thoughts('reembed:nightly', ARRAY['${nightlyId}']::uuid[])`);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = 'reembed:nightly'`;
  // Written since its pass: the updated_at trigger moves it past finished_at.
  await sql`UPDATE thoughts SET content = 're-embedded, then edited (edited)' WHERE id = ${editedId}::uuid`;
  const [absent] = await sql`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'embedding_model'`;
  assert(absent.c === 0, "at migration 020 there is no embedding_model column");
  const [seven] = await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'update_thought' AND pronargs = 7`;
  assert(seven.c === 1, "…and update_thought takes seven arguments");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("021") });

  const models = Object.fromEntries(
    ((await sql`SELECT content, embedding_model AS m FROM thoughts`) as { content: string; m: string | null }[]).map((r) => [r.content, r.m])
  );
  assert(models["captured before 021"] === OPTS.model, `a row a finished pass wrote, and nothing wrote since, is labelled from its latest succeeded claim (${models["captured before 021"]})`);
  assert(models["inserted before 021"] === null, "a row no pass touched reads NULL — unknown, not stamped with the recorded model");
  assert(models["re-embedded, then edited (edited)"] === null, "a row written since its pass reads NULL — the claim no longer vouches for its vector");
  assert(models["re-embedded under a key naming no model"] === null, "a claim under a key naming no model is no evidence");
  assert(models["re-embedded, vector since removed"] === null, "a row with no vector takes no label, whatever its claim says");
  const forms = (await sql`SELECT pronargs AS n FROM pg_proc WHERE proname = 'update_thought' ORDER BY 1`) as { n: number }[];
  assert(forms.length === 1 && Number(forms[0].n) === 8, `the 7-argument form is gone and the eight-argument one is the only update_thought (${forms.map((f) => f.n).join(",")})`);

  // The mirror: a write after the upgrade carries the label, on both writers.
  const [{ r: after }] = await sql`SELECT upsert_thought('captured after 021', ${{ metadata: {}, embedding_model: OPTS.model }}::jsonb, ${vec}::vector) AS r`;
  const [labelled] = await sql`SELECT embedding_model AS m FROM thoughts WHERE id = ${(after as { id: string }).id}::uuid`;
  assert(labelled.m === OPTS.model, `a capture after the upgrade carries the label (${labelled.m})`);
  const [{ r: edited }] = await sql`SELECT ${sql.unsafe(`update_thought('${(viaUpsert as { id: string }).id}'::uuid, 'captured before 021', NULL::jsonb, '${vec}'::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, '${OPTS.model}'::text)`)} AS r`;
  const [relabelled] = await sql`SELECT embedding_model AS m FROM thoughts WHERE id = ${(viaUpsert as { id: string }).id}::uuid`;
  assert((edited as { ok: boolean }).ok === true && relabelled.m === OPTS.model, `a re-embed of a pre-021 row through update_thought labels it (${relabelled.m})`);
  const [still] = await sql`SELECT embedding_model AS m FROM thoughts WHERE content = 'inserted before 021'`;
  assert(still.m === null, "…while the row nothing re-embedded stays unknown");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("021") });
  const [dupCol] = await sql`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'embedding_model'`;
  const [dupFn] = await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'update_thought'`;
  assert(dupCol.c === 1 && dupFn.c === 1 && (await sql`SELECT to_regprocedure(${UPDATE_THOUGHT_SIGNATURE}) IS NOT NULL AS p`)[0].p === true,
         "re-applying 021 is a no-op: the column once, the function once, at the shipped signature");
  await sql.close();
}

report();
