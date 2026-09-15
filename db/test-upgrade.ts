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
import { applyMigrations, createAssert, dropSchema, plantLegacyRow, requireDatabaseUrl, resetSchema, runScript, updatedAtTriggerState } from "./test-support.ts";
import { ACCEPTED_CAVEAT_PREFIX, UPDATE_THOUGHT_SIGNATURE } from "./config.mjs";

const URL_ = requireDatabaseUrl("test-upgrade.ts");
const { assert, report } = createAssert();

const OPTS = { dim: 8, model: "stub-embed" };
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = readdirSync(join(HERE, "migrations"))
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

  const stampsBefore = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("021") });

  const stampsAfter = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  assert(Object.keys(stampsBefore).every((id) => stampsBefore[id] === stampsAfter[id]), "labelling moves no row's updated_at — the label is a fact about a vector already there, not an edit");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and writes no audit row");
  const trg = await updatedAtTriggerState(sql);
  assert(trg === "O", `…and the updated_at trigger is enabled again afterwards (${trg})`);

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

console.log("\n[5] Migration 022 onto a populated 021 — the chunks follow the vector on the 3-argument path");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "022" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  // Bound as an object, not pre-stringified: a string binds as a jsonb scalar
  // and jsonb_array_length fails with "cannot get array length of a scalar".
  const chunks = (axis: number) => [{ content: "window", embedding: vec(axis) }];
  const TEXT = "captured long before 022, re-captured short";
  const [{ r }] = await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: {}, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector, ${chunks(1)}::jsonb) AS r`;
  const id = (r as { id: string }).id;
  const windows = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${id}::uuid`)[0].c);
  const label = async () => (await sql`SELECT embedding_model AS m FROM thoughts WHERE id = ${id}::uuid`)[0].m as string | null;
  const overloads = async () => Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'upsert_thought'`)[0].c);
  const body3 = async () => (await sql`SELECT prosrc FROM pg_proc WHERE oid = 'upsert_thought(text, jsonb, vector)'::regprocedure`)[0].prosrc as string;

  // At 021: the defect this migration removes, shown before it is applied.
  await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: {}, embedding_model: "new-model" }}::jsonb, ${vec(2)}::vector)`;
  let n = await windows();
  let m = await label();
  assert(n === 1 && m === "new-model", `at 021 a chunkless re-capture moves the vector and label and leaves the window under them (${n} window at ${m})`);
  assert(!/ob1:vector-replaces-chunks/.test(await body3()), "…and 021's 3-argument body carries no sentinel");
  const before = await shape(sql);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("022") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "022 adds no column and changes no signature");
  assert((await windows()) === 1, "…and removes nothing on its own: the window left before it stays (no backfill — nothing can tell it from a live one)");
  await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: {}, embedding_model: "new-model" }}::jsonb, ${vec(3)}::vector)`;
  n = await windows();
  assert(n === 1 && (await label()) === "new-model", `after 022 a re-capture at the model the row is labelled with keeps the window — the label vouches for it (${n} window)`);
  await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: {}, embedding_model: "newer-model" }}::jsonb, ${vec(3)}::vector)`;
  n = await windows();
  m = await label();
  assert(n === 0 && m === "newer-model", `…and one at another model removes the window as it moves the vector and label (${n} windows at ${m})`);
  await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: {}, embedding_model: "newer-model" }}::jsonb, ${vec(4)}::vector, ${chunks(5)}::jsonb)`;
  await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: { k: 1 } }}::jsonb, NULL::vector)`;
  n = await windows();
  assert(n === 1 && (await label()) === "newer-model", "a re-capture with no vector keeps the windows with the vector and its label");
  assert((await overloads()) === 3 && /ob1:vector-replaces-chunks/.test(await body3()), "three upsert_thought overloads, the 3-argument body carrying the sentinel");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("022") });
  assert((await overloads()) === 3 && /ob1:vector-replaces-chunks/.test(await body3()) && (await windows()) === 1,
         "re-applying 022 is a no-op: three overloads, the sentinel, the window untouched");
  await sql.close();
}

console.log("\n[6] Migration 023 onto a populated 022 — the legacy rows take their fingerprints once");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "023" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]`;
  // A corpus from before 003, or loaded around upsert_thought: NULL
  // fingerprints throughout, and one row captured through the writer.
  const legacy = (content: string, createdAt: string) => plantLegacyRow(sql, content, vec, createdAt);
  const rows = async () => Number((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c);
  const fp = async (id: string) => (await sql`SELECT content_fingerprint AS fp FROM thoughts WHERE id = ${id}::uuid`)[0].fp as string | null;
  const fns = async () => Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'backfill_content_fingerprints'`)[0].c);
  const doubled = await legacy("captured before 003", "2024-01-01");
  const singleton = await legacy("another from before 003", "2024-01-01");
  const twinOld = await legacy("Same Text", "2024-01-01");
  const twinNew = await legacy("same   text", "2024-06-01");
  await sql`SELECT upsert_thought('a fingerprinted note', '{"metadata":{}}'::jsonb, ${vec}::vector)`;
  const owned = await legacy("A Fingerprinted Note", "2020-01-01");

  // At 022: the defect this migration removes, shown before it is applied.
  const before = await rows();
  const [{ r: second }] = await sql`SELECT upsert_thought('captured  before 003', '{"metadata":{}}'::jsonb, ${vec}::vector) AS r`;
  assert((second as { id: string }).id !== doubled && (await rows()) === before + 1, "at 022 a capture of a legacy row's text inserts a second row — ON CONFLICT cannot see a NULL");
  assert((await fns()) === 0, "…and there is no backfill_content_fingerprints");
  const stampsBefore = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const shapeBefore = await shape(sql);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("023") });

  const shapeAfter = await shape(sql);
  const added = shapeAfter.functions.split("\n").filter((f) => !shapeBefore.functions.split("\n").includes(f));
  assert(shapeBefore.columns === shapeAfter.columns && added.length === 1 && added[0] === "backfill_content_fingerprints(p_limit integer)",
         `023 adds no column and one function, backfill_content_fingerprints (${added.join(", ")})`);
  const stampsAfter = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  assert(Object.keys(stampsBefore).every((id) => stampsBefore[id] === stampsAfter[id]), "the backfill moves no row's updated_at — the fingerprint is not an edit");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and writes no audit row");
  const trg = await updatedAtTriggerState(sql);
  assert(trg === "O", `…and the updated_at trigger is enabled again afterwards (${trg})`);
  assert((await fp(singleton)) !== null, "a legacy singleton carries its fingerprint");
  assert((await fp(twinOld)) !== null && (await fp(twinNew)) === null, "of the twins the older carries the key and the newer stays NULL");
  assert((await fp(owned)) === null && (await fp(doubled)) === null, "a NULL row whose text a fingerprinted row holds stays NULL — the note captured through the writer, and the row 022 doubled, whose second copy holds the key");

  // The mirror: the defect is gone for the rows this migration reached.
  const [{ r: merged }] = await sql`SELECT upsert_thought('another  from before 003', '{"metadata":{"k":1}}'::jsonb, ${vec}::vector) AS r`;
  assert((merged as { id: string }).id === singleton && (await rows()) === before + 1, "after 023 a capture of the former singleton's text merges into it — no second row");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("023") });
  const [{ n: found }] = await sql`SELECT backfill_content_fingerprints() AS n`;
  assert((await fns()) === 1 && Number(found) === 0 && (await rows()) === before + 1,
         "re-applying 023 is a no-op: the function once, a further call writes nothing");
  await sql.close();
}

console.log("\n[7] --reapply onto a --baseline'd 020 — every migration in one transaction, 021's backfill bracketed by the migrator, and what the re-run refuses (SMD-1193, SMD-1421)");
{
  await dropSchema(URL_);
  // A brain adopted with --baseline: the schema as far as 020, by hand as it
  // were, and a ledger that says every migration. reembed.ts refuses to run
  // there and names the remedy; this is the remedy.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "021" });
  // The migrator's shell: the parent's, with the suite's width and model. The
  // schema above was applied with the parent's OB1_CHUNK_CONTEXT (applyMigrations
  // reads it), so the child must see the same value or --reapply rightly refuses
  // to re-record it. reembed.ts --status gets the narrower environment test-live
  // gives it.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, DATABASE_URL: URL_, OB1_EMBEDDING_DIM: String(OPTS.dim), OB1_EMBEDDING_MODEL: OPTS.model }))
    if (v !== undefined && !/^OB1_(EMBEDDING_DIMENSIONS|LLM_API_KEY|BACKFILL_LIMIT)$/.test(k)) env[k] = String(v);
  const statusEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (k !== "OB1_CHUNK_CONTEXT") statusEnv[k] = v;
  const migrate = (...extra: string[]) => runScript(["bun", join(HERE, "migrate.ts"), "--url", URL_, ...extra], { env, cwd: HERE });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0 && new RegExp(`baselined ${MIGRATIONS.length}, skipped 0`).test(baselined.out), `--baseline records every migration without running one (exit ${baselined.code})`);

  const sql = new SQL({ url: URL_, max: 1 });
  // The brain as it stood before this change: baselined through 029, so 030
  // is pending, and a PLAIN run — the compose stack's, which gates the server
  // on it — must not fail with a bare "does not exist".
  const last = MIGRATIONS[MIGRATIONS.length - 1];
  assert(last.startsWith("030_"), `the last migration is 030 (${last})`);
  await sql`DELETE FROM schema_migrations WHERE name = ${last}`;
  const plainRun = await migrate();
  const plainOk = plainRun.code === 1 && /030_label_from_claims_excludes_accepted\.sql\s+FAILED: migration 030 needs 015 \(thought_work_claims\) and 021 \(thoughts\.embedding_model\); this schema lacks thoughts\.embedding_model/.test(plainRun.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plainRun.out);
  assert(plainOk, `a plain run on the baselined brain fails at 030 naming what is missing and --reapply, not with a bare error (exit ${plainRun.code})${plainOk ? "" : `:\n${plainRun.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${last}`)[0].c) === 0, "…and records nothing");
  const vec = `[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]`;
  const KEY = `reembed:${OPTS.model}@${OPTS.dim}`;
  const EARLIER = `reembed:earlier-model@${OPTS.dim}`;
  // Written two hours ago, so every pass below — the earlier one an hour ago,
  // the acceptances now — finished after the thought was written: 021's bound
  // (updated_at <= finished_at) holds for each row, and only the rule decides.
  const plant = async (content: string) =>
    (await sql`INSERT INTO thoughts (content, metadata, embedding, updated_at) VALUES (${content}, '{}'::jsonb, ${vec}::vector, now() - interval '2 hours') RETURNING id`)[0].id as string;
  const vouched = await plant("a finished pass wrote this vector");
  const accepted = await plant("the provider refused this; the operator accepted the failure");
  const earlierThenAccepted = await plant("an earlier pass wrote this; the pass to the new model was refused and accepted");
  const noEvidence = await plant("nothing ever re-embedded this");
  // The claim rows as the tool leaves them. A plain succeeded row under the
  // model's own key. An ACCEPTED row (SMD-1067): succeeded, the caveat prefix,
  // and the failure's own timestamps — so 021's block, run as written, labels
  // the thought at a model whose pass never wrote its vector, and 030 must
  // take that back. And a thought with both: an earlier pass's plain row under
  // its key, then the acceptance under the new key — the latest row, which 021
  // trusts and 030 excludes.
  const enqueue = (key: string, ids: string[]) => sql.unsafe(`SELECT enqueue_thoughts('${key}', ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[])`);
  await enqueue(EARLIER, [earlierThenAccepted]);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() - interval '1 hour' WHERE work_type = ${EARLIER}`;
  await enqueue(KEY, [vouched, accepted, earlierThenAccepted]);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${KEY} AND thought_id = ${vouched}::uuid`;
  await sql`UPDATE thought_work_claims SET status = 'succeeded', claimed_at = now(), finished_at = now(), last_error = ${ACCEPTED_CAVEAT_PREFIX + "the provider refused the content on every attempt"}
             WHERE work_type = ${KEY} AND thought_id IN (${accepted}::uuid, ${earlierThenAccepted}::uuid)`;
  const [absent] = await sql`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'embedding_model'`;
  assert(absent.c === 0, "the schema stands at 020 — no embedding_model column — whatever the ledger says");

  // What the operator reads first. --status runs against any schema and says
  // what a run would refuse on; the ledgered remedy is the migrator's command.
  const status = await runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_, "--status"], { env: statusEnv, cwd: HERE });
  const column = async () => Number((await sql`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'embedding_model'`)[0].c);
  const ledger = async () => JSON.stringify(await sql`SELECT name, sha256, applied_at::text AS a FROM schema_migrations ORDER BY 1`);
  assert(status.code === 0 && /a run would refuse: the schema predates migration 021/.test(status.out) &&
           /schema_migrations records 021 as\n\s+applied \(--baseline\?\) but the schema installed is older\. Re-apply the recorded migrations with the migrator/.test(status.out) &&
           /cd db && bun migrate\.ts --url … --reapply\s*$/m.test(status.out) && !/re-run the body/.test(status.out),
         `reembed.ts --status on the baselined brain names \`migrate.ts --reapply\`, not a paste (exit ${status.code})`);

  // 021 pending too, from here on: a ledger hole on the very file whose block
  // the gate is about, so a plain run reaches it.
  await sql`DELETE FROM schema_migrations WHERE name LIKE '021%'`;
  const ledgerBefore = await ledger();

  // --dry-run says what a re-run is, and writes nothing.
  const dry = await migrate("--reapply", "--dry-run");
  assert(dry.code === 0 && /would re-apply every migration/.test(dry.out) && !/^\s+re-applying every migration/m.test(dry.out) &&
           /021_embedding_model_per_row\.sql\s+would apply/.test(dry.out) && /022_capture_replaces_chunks\.sql\s+would re-apply/.test(dry.out) && /030_label_from_claims_excludes_accepted\.sql\s+would apply/.test(dry.out) &&
           new RegExp(`would apply 2, would re-apply ${MIGRATIONS.length - 2}, skipped 0`).test(dry.out),
         `--reapply --dry-run says it would re-apply every recorded migration and apply the pending ones (exit ${dry.code})`);
  assert((await column()) === 0, "…and writes nothing");

  // Refused before BEGIN, nothing written. A shell configured differently from
  // the brain: 006 would re-record ob1_config from it.
  const otherShell = await runScript(["bun", join(HERE, "migrate.ts"), "--url", URL_, "--reapply"], { env: { ...env, OB1_EMBEDDING_MODEL: "other-embed" }, cwd: HERE });
  assert(otherShell.code === 2 && /refusing --reapply: ob1_config records embedding_model = stub-embed and this shell would re-record it as other-embed/.test(otherShell.out),
         `a shell whose model differs from the record is refused — 006 would re-record it (exit ${otherShell.code})`);
  assert((await sql`SELECT value FROM ob1_config WHERE key = 'embedding_model'`)[0].value === OPTS.model && (await column()) === 0, "…and nothing was written");
  const otherDry = await runScript(["bun", join(HERE, "migrate.ts"), "--url", URL_, "--reapply", "--dry-run"], { env: { ...env, OB1_EMBEDDING_MODEL: "other-embed" }, cwd: HERE });
  assert(otherDry.code === 2 && /would refuse --reapply: ob1_config records embedding_model = stub-embed/.test(otherDry.out) && !/would re-apply \(/.test(otherDry.out) && !/would re-apply every migration/.test(otherDry.out),
         `…and --dry-run from that shell says it would refuse, the same judgement, with no banner for a run that never begins (exit ${otherDry.code})`);
  // The width is the column's, judged before BEGIN in both modes — 006 would
  // refuse it inside the transaction, after a dry run had said green.
  const otherWidth = await runScript(["bun", join(HERE, "migrate.ts"), "--url", URL_, "--reapply", "--dry-run"], { env: { ...env, OB1_EMBEDDING_DIM: "9" }, cwd: HERE });
  assert(otherWidth.code === 2 && /would refuse --reapply: thoughts\.embedding is vector\(8\) and this shell says OB1_EMBEDDING_DIM=9/.test(otherWidth.out) && /Set OB1_EMBEDDING_DIM=8/.test(otherWidth.out),
         `a shell whose width differs from the column is refused before BEGIN, dry run included (exit ${otherWidth.code})`);
  // The two rows 021's block labels from and 030 leaves: an acceptance under a
  // SUFFIXED key over an unlabelled thought (030 cannot tell that label from
  // the server's own), and an own-key acceptance over a thought written after
  // the row was enqueued (021's bound is the release, 030's the enqueue), here
  // written between the claim and the release. Until SMD-1421 the run was
  // refused on both and the operator sent to spend the acceptances; the
  // migrator's bracket around 021 sets both back itself.
  const SUFFIXED = `${KEY}:ctx`;
  const suffixedHazard = await plant("unlabelled; a backfill under a suffixed key was refused and accepted");
  await enqueue(SUFFIXED, [suffixedHazard]);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', claimed_at = now(), finished_at = now(), last_error = ${ACCEPTED_CAVEAT_PREFIX + "refused"} WHERE work_type = ${SUFFIXED}`;
  const writtenSince = (await sql`INSERT INTO thoughts (content, metadata, embedding, updated_at) VALUES ('unlabelled; written during the attempt that was refused and accepted', '{}'::jsonb, ${vec}::vector, now() - interval '30 minutes') RETURNING id`)[0].id as string;
  await enqueue(KEY, [writtenSince]);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', enqueued_at = now() - interval '2 hours', claimed_at = now() - interval '1 hour', finished_at = now(), last_error = ${ACCEPTED_CAVEAT_PREFIX + "refused"} WHERE work_type = ${KEY} AND thought_id = ${writtenSince}::uuid`;
  // A session holding a lock on thoughts — an idle transaction, a server left
  // running: 001's DROP TRIGGER wants ACCESS EXCLUSIVE, the 10 s lock_timeout
  // fails it, and the one transaction rolls back with nothing changed.
  const holder = new SQL({ url: URL_, max: 1 });
  await holder.unsafe("BEGIN");
  await holder.unsafe("SELECT count(*) FROM thoughts");
  const locked = await migrate("--reapply");
  await holder.unsafe("ROLLBACK");
  await holder.close();
  assert(locked.code === 1 && /001_core_schema\.sql\s+FAILED: .*lock timeout/.test(locked.out) && /A lock was not granted within the re-run's 10 s lock_timeout/.test(locked.out) &&
           /it rolled back, nothing was re-applied or applied, and the schema is as it was/.test(locked.out) && !/re-applied\b(?! or)/.test(locked.out.replace(/nothing was re-applied or applied/, "")),
         `a held lock fails the re-run within the lock timeout, at the first file (exit ${locked.code})`);
  assert((await column()) === 0 && (await ledger()) === ledgerBefore, "…and the one transaction rolled back: no column, the ledger as before");

  // A ledger hole — a row deleted or misspelt by hand: the pending file runs in
  // its place in the same transaction and is recorded, so 021's body does not
  // come back over 022's afterwards.
  // Captured after every plant above, so the run's own writes are what is compared.
  const stampsBefore = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await sql`DELETE FROM schema_migrations WHERE name LIKE '022%'`;
  const ledgerHole = await ledger();
  const run = await migrate("--reapply");
  assert(run.code === 0, `--reapply exits 0 (${run.code})${run.code === 0 ? "" : `:\n${run.out}`}`);
  assert(new RegExp(`re-applying every migration \\(${MIGRATIONS.length - 3} recorded, 3 pending\\), in order, in one transaction with a 10 s lock timeout`).test(run.out) &&
           /Stop the server and any re-embed or extraction worker first/.test(run.out) &&
           /021_embedding_model_per_row\.sql\s+applied/.test(run.out) && /022_capture_replaces_chunks\.sql\s+applied/.test(run.out) && /030_label_from_claims_excludes_accepted\.sql\s+applied/.test(run.out) &&
           new RegExp(`applied 3, re-applied ${MIGRATIONS.length - 3}, skipped 0`).test(run.out) && !/already applied/.test(run.out),
         "…says what it ran: every file in order, the pending ones (021, the hole at 022, and 030) applied in their place, none skipped, and the operator's precondition");
  const models = Object.fromEntries(
    ((await sql`SELECT id, embedding_model AS m FROM thoughts`) as { id: string; m: string | null }[]).map((r) => [r.id, r.m])
  );
  assert(models[vouched] === OPTS.model, `a thought a finished pass vouches for is labelled from its plain succeeded row (${models[vouched]})`);
  assert(models[accepted] === null, `a thought whose only row is the operator's acceptance ends NULL — 021's block labelled it, the bracket set it back before 030 could (${models[accepted]})`);
  assert(models[earlierThenAccepted] === "earlier-model", `with the acceptance excluded the latest row before it decides: the earlier pass that did write the vector (${models[earlierThenAccepted]})`);
  assert(models[noEvidence] === null, "a thought no pass touched stays NULL");
  assert(models[suffixedHazard] === null && models[writtenSince] === null, "the acceptance under a suffixed key and the own-key acceptance over a thought written since its enqueue — both labels 021's block wrote and 030 leaves — end NULL: the bracket set them back");
  const standing = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE status = 'succeeded' AND starts_with(last_error, ${ACCEPTED_CAVEAT_PREFIX})`)[0].c);
  assert((await standing()) === 4, "…and every acceptance stands, spent by nobody");
  assert(/021_embedding_model_per_row\.sql\s+applied\n\s+·\s+021's evidence backfill wrote 4 label\(s\) from an acceptance; set back/.test(run.out),
         "…and the run says, beside 021's line, how many labels the bracket set back: the four 021's block wrote from an acceptance");
  const stampsAfter = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  assert(Object.keys(stampsBefore).every((id) => stampsBefore[id] === stampsAfter[id]), "labelling moves no row's updated_at — both files hold the trigger");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and writes no audit row");
  assert((await updatedAtTriggerState(sql)) === "O", "…and the updated_at trigger is enabled again afterwards");
  const ledgerAfter = JSON.parse(await ledger()) as { name: string; sha256: string; a: string }[];
  assert(JSON.stringify(ledgerAfter.filter((r) => !/^(021|022|030)/.test(r.name))) === JSON.stringify((JSON.parse(ledgerHole) as { name: string }[])) &&
           ["021", "022", "030"].every((n) => ledgerAfter.some((r) => r.name.startsWith(n))),
         "the recorded rows are not touched — every row, sha and applied_at as before — and the pending files are recorded");

  // A hole at 021 ALONE, 030 recorded: nothing follows 021 to take a label
  // back, so the bracket is the only correction, and it runs whenever 021
  // does. Here: the `accepted` thought — NULL, its own-key acceptance
  // standing, so 021's block labels it again — and a thought unlabelled since
  // the upgrade whose only row is an acceptance under a suffixed key. Until
  // SMD-1421 this run was refused on the own-key acceptance.
  await sql`DELETE FROM schema_migrations WHERE name LIKE '021%'`;
  const lateSuffixed = await plant("unlabelled since the upgrade; a backfill under a suffixed key was refused and accepted");
  await enqueue(SUFFIXED, [lateSuffixed]);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', claimed_at = now(), finished_at = now(), last_error = ${ACCEPTED_CAVEAT_PREFIX + "refused"} WHERE work_type = ${SUFFIXED} AND thought_id = ${lateSuffixed}::uuid`;
  const holeAt021 = await migrate();
  assert(holeAt021.code === 0 && /021_embedding_model_per_row\.sql\s+applied/.test(holeAt021.out) && /030_label_from_claims_excludes_accepted\.sql\s+already applied/.test(holeAt021.out) &&
           /021's evidence backfill wrote 4 label\(s\) from an acceptance; set back/.test(holeAt021.out) && !/refus/.test(holeAt021.out),
         `with 030 recorded and skipped, a plain run with a hole at 021 applies it bracketed — no refusal, the four labels its block wrote from acceptances set back (exit ${holeAt021.code})${holeAt021.code === 0 ? "" : `:\n${holeAt021.out}`}`);
  const labels = async () => Object.fromEntries(((await sql`SELECT id, embedding_model AS m FROM thoughts ORDER BY id`) as { id: string; m: string | null }[]).map((r) => [r.id, r.m]));
  const afterHole = await labels();
  assert(afterHole[accepted] === null && afterHole[lateSuffixed] === null && afterHole[suffixedHazard] === null && afterHole[writtenSince] === null,
         "…the thoughts whose only evidence is an acceptance end NULL, the new one included");
  assert(afterHole[vouched] === OPTS.model && afterHole[earlierThenAccepted] === "earlier-model" && afterHole[noEvidence] === null,
         "…every other label is as the re-run left it — a labelled row is not in the snapshot");
  assert((await standing()) === 5 && (await updatedAtTriggerState(sql)) === "O" && Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name LIKE '021%'`)[0].c) === 1,
         "…every acceptance stands, the trigger is enabled again, and 021 is recorded");
  // The re-run over the same corpus: 021's block labels the same rows again
  // and the bracket sets them back again — and 022's and 025's redefinitions
  // of upsert_thought, which the plain run of 021 alone put 021's body over,
  // are restored (the state preflight's `atomic capture` names, with this
  // remedy).
  const again = await migrate("--reapply");
  assert(again.code === 0 && /021's evidence backfill wrote 4 label\(s\) from an acceptance/.test(again.out), `a second --reapply brackets 021 the same way (exit ${again.code})`);
  assert(JSON.stringify(await labels()) === JSON.stringify(afterHole), "…and every label is as before: the bracket is idempotent");

  // Every recorded file, not a range: 022 and 025 redefine 021's 3-argument
  // upsert_thought, and a re-run of 021 by itself would have put 021's body
  // back — the very state preflight's `atomic capture` check warns about.
  const forms = (await sql`SELECT pronargs AS n FROM pg_proc WHERE proname = 'update_thought' ORDER BY 1`) as { n: number }[];
  assert(forms.length === 1 && Number(forms[0].n) === 8, `the eight-argument update_thought, alone (${forms.map((f) => f.n).join(",")})`);
  const body3 = (await sql`SELECT prosrc FROM pg_proc WHERE oid = 'upsert_thought(text, jsonb, vector)'::regprocedure`)[0].prosrc as string;
  assert(/ob1:vector-replaces-chunks/.test(body3) && /derived_from/.test(body3), "the 3-argument upsert_thought is the LAST definer's body (022's sentinel, 025's provenance), not 021's");

  // Refused, nothing written: a value beside the flag (the old shape, or a
  // typo); a flag the runner does not have; --baseline beside it; a recorded
  // file changed since it was applied — before anything runs.
  const value = await migrate("--reapply", "021");
  assert(value.code === 2 && /unknown argument: 021 \(a value where no flag takes one\)/.test(value.out), `--reapply takes no value; one beside it is refused, not dropped (exit ${value.code})`);
  const typo = await migrate("--reapply=021");
  assert(typo.code === 2 && /unknown argument: --reapply=… \(a value joined with "="; give it as --reapply <value>\)/.test(typo.out), `a flag the runner does not have is refused, not a silent plain run (exit ${typo.code})`);
  const joined = await migrate("--url=postgres://u:s3cret@h/d");
  assert(joined.code === 2 && /unknown argument: --url=…/.test(joined.out) && !/s3cret/.test(joined.out), `a value joined with "=" is refused without echoing it — a URL carries a password (exit ${joined.code})`);
  const both = await migrate("--reapply", "--baseline");
  assert(both.code === 2 && /One or the other/.test(both.out), `--reapply beside --baseline is refused (exit ${both.code})`);
  await sql`UPDATE schema_migrations SET sha256 = 'edited-after-apply' WHERE name LIKE '024%'`;
  const drift = await migrate("--reapply");
  assert(drift.code === 1 && /refusing --reapply: 024_thought_stats_summary\.sql \(was edited-after-apply, now [0-9a-f]{12}\) changed after being applied/.test(drift.out),
         `a drifted recorded file refuses the whole re-run before anything runs (exit ${drift.code})`);
  assert(!/re-applied/.test(drift.out), "…and nothing was re-applied");

  // The mirror: a schema this re-run produced is the schema a fresh apply
  // produces. The ledger is the migrator's, not the schema's — applyMigrations
  // never creates one — so it is dropped before the two are compared.
  await sql`DROP TABLE schema_migrations`;
  const reapplied = await shape(sql);
  await sql.close();
  await resetSchema(URL_, OPTS);
  const fresh = new SQL({ url: URL_, max: 1 });
  const scratch = await shape(fresh);
  await fresh.close();
  assert(reapplied.columns === scratch.columns, "the re-applied schema has the same columns as a fresh one");
  assert(reapplied.functions === scratch.functions, "…and the same functions");
}

console.log("\n[8] Migration 030 onto a populated 029 — a label whose only evidence is an acceptance goes back to unknown (SMD-1193)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "030" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]`;
  const M = OPTS.model;
  const OWN = `reembed:${M}@${OPTS.dim}`;
  const SUFFIXED = `${OWN}:ctx`;
  const OTHER_OWN = `reembed:other-model@${OPTS.dim}`;
  const EARLIER = `reembed:earlier-model@${OPTS.dim}`;
  const CAVEAT = ACCEPTED_CAVEAT_PREFIX + "the provider refused the content on every attempt";
  // The corpus a brain has after following the old remedy — 021's body pasted
  // over accepted rows — beside the labels 030 must leave alone. Every thought
  // written two hours ago unless said otherwise.
  const plant = async (content: string, label: string | null, updatedAgo = "2 hours") =>
    (await sql`INSERT INTO thoughts (content, metadata, embedding, embedding_model, updated_at) VALUES (${content}, '{}'::jsonb, ${vec}::vector, ${label}, now() - ${updatedAgo}::interval) RETURNING id`)[0].id as string;
  const enqueue = (key: string, id: string) => sql.unsafe(`SELECT enqueue_thoughts('${key}', ARRAY['${id}']::uuid[])`);
  // A row's enqueue precedes its claim, which precedes its release: a minute
  // before the claim unless said otherwise — 030's bound is the enqueue.
  const row = async (key: string, id: string, opts: { accepted?: boolean; ago?: string; claimedAgo?: string; enqueuedAgo?: string } = {}) => {
    await enqueue(key, id);
    const claimedAgo = opts.claimedAgo ?? opts.ago ?? "0 seconds";
    await sql`UPDATE thought_work_claims SET status = 'succeeded', enqueued_at = now() - ${opts.enqueuedAgo ?? claimedAgo}::interval - interval '1 minute',
                 claimed_at = now() - ${claimedAgo}::interval, finished_at = now() - ${opts.ago ?? "0 seconds"}::interval,
                 last_error = ${opts.accepted ? CAVEAT : null} WHERE work_type = ${key} AND thought_id = ${id}::uuid`;
  };
  const mislabelled = await plant("labelled at M by a paste of 021 over an acceptance under M's own key", M);
  await row(OWN, mislabelled, { accepted: true });
  const legitOtherKey = await plant("at M by a real pass; the pass to another model was refused and accepted", M);
  await row(OWN, legitOtherKey, { ago: "1 hour" });
  await row(OTHER_OWN, legitOtherKey, { accepted: true });
  const suffixed = await plant("at M by the server's own capture; a backfill under a suffixed key was refused and accepted", M);
  await row(SUFFIXED, suffixed, { accepted: true });
  const editedSince = await plant("labelled at M by a paste, then edited by a server at M", M, "0 seconds");
  await row(OWN, editedSince, { accepted: true, ago: "1 hour" });
  const relabel = await plant("unlabelled; an earlier pass wrote it, the pass to M was refused and accepted", null);
  await row(EARLIER, relabel, { ago: "1 hour" });
  await row(OWN, relabel, { accepted: true });
  const mislabelledWithEarlier = await plant("labelled at M by a paste over an acceptance; an earlier pass did write it", M);
  await row(EARLIER, mislabelledWithEarlier, { ago: "1 hour" });
  await row(OWN, mislabelledWithEarlier, { accepted: true });
  const plain = await plant("unlabelled; a plain succeeded row under M's own key", null);
  await row(OWN, plain);
  const untouched = await plant("labelled at M; no claim row at all", M);
  // The worker wrote a head window at M (label M, updated_at moved) after the
  // claim and before the row failed and was accepted: the label is the worker's
  // own, and the bound is the attempt's read, not the release.
  const headWindow = await plant("the worker wrote a head window at M, then the whole-content call failed and the operator accepted", M, "30 minutes");
  await row(OWN, headWindow, { accepted: true, claimedAgo: "1 hour", ago: "0 seconds" });
  // The pool took the thought unlabelled; a server capture at M landed before
  // the worker claimed it; the provider failed; the operator accepted (a
  // thought at the target is accepted whatever its timestamps). The label is
  // the server's, and the bound — the enqueue — says so.
  const capturedBeforeClaim = await plant("captured at M by the server between the row's enqueue and its claim; the attempt failed and was accepted", M, "90 minutes");
  await row(OWN, capturedBeforeClaim, { accepted: true, enqueuedAgo: "2 hours", claimedAgo: "1 hour", ago: "0 seconds" });
  // A paste's mislabel, then a switch to another model that pooled the thought
  // (its label is not B), refused, and accepted again: the later acceptance
  // under B's key is the latest row, and vouches for nothing about M.
  const twiceAccepted = await plant("labelled at M by a paste over an acceptance under M's own key; later refused and accepted under B's own key", M);
  await row(OWN, twiceAccepted, { accepted: true, ago: "1 hour" });
  await row(OTHER_OWN, twiceAccepted, { accepted: true });

  const stampsBefore = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const before = await shape(sql);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("030") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "030 adds no column and no function");
  const label = async (id: string) => (await sql`SELECT embedding_model AS m FROM thoughts WHERE id = ${id}::uuid`)[0].m as string | null;
  assert((await label(mislabelled)) === null, "a label whose only evidence is an acceptance under the model's own key goes back to unknown");
  assert((await label(legitOtherKey)) === M, "a label a real pass wrote stays, though a later pass to another model was accepted");
  assert((await label(suffixed)) === M, "an acceptance under a suffixed key is not read against the label — a backfill pools thoughts at the model too");
  assert((await label(editedSince)) === M, "a thought written since the acceptance keeps its label — the write is a server's, and the label is the server's");
  assert((await label(relabel)) === "earlier-model", "an unlabelled thought is labelled from the latest row that is not an acceptance — the earlier pass that did write it");
  assert((await label(mislabelledWithEarlier)) === "earlier-model", "…and a mislabelled one is taken back and labelled from that earlier pass, in the one block");
  assert((await label(plain)) === M, "a plain succeeded row labels as 021 would");
  assert((await label(untouched)) === M, "a label with no claim row is not this migration's to read");
  assert((await label(headWindow)) === M, "a thought the worker itself labelled between the claim and the failure keeps its label — written after the enqueue");
  assert((await label(capturedBeforeClaim)) === M, "a thought the server captured at the model between the enqueue and the claim keeps its label — the pool saw it unlabelled, the server wrote it since");
  assert((await label(twiceAccepted)) === null, "a mislabel accepted again under another model's own key goes back to unknown — the later acceptance is the latest row, and vouches for nothing about the label");
  const stampsAfter = Object.fromEntries(
    ((await sql`SELECT id, updated_at::text AS u FROM thoughts`) as { id: string; u: string }[]).map((r) => [r.id, r.u])
  );
  assert(Object.keys(stampsBefore).every((id) => stampsBefore[id] === stampsAfter[id]), "no row's updated_at moves — the label is not an edit");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and no audit row is written");
  assert((await updatedAtTriggerState(sql)) === "O", "…and the updated_at trigger is enabled again afterwards");

  const labelsOnce = JSON.stringify(await sql`SELECT id, embedding_model FROM thoughts ORDER BY id`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("030") });
  assert(JSON.stringify(await sql`SELECT id, embedding_model FROM thoughts ORDER BY id`) === labelsOnce, "re-applying 030 is a no-op: every label as after the first run");
  await sql.close();
}

report();
