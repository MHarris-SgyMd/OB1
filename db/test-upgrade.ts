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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_COMMENT_SQL, TABLE_COMMENT_SQL, TID_PROBE, applyMigrations, createAssert, dropSchema, ledgerStrangers, loadChunkRows, migrationFiles, migratorEnv, plantLegacyRow, requireDatabaseUrl, resetSchema, runMigrator, runScript, seededRandom, updatedAtTriggerState } from "./test-support.ts";
import { ACCEPTED_CAVEAT_PREFIX, ACCEPTED_CLAIM_SQL, LOCK_TIMEOUT_S, UPDATE_THOUGHT_SIGNATURE, reembedKey } from "./config.mjs";

const URL_ = requireDatabaseUrl("test-upgrade.ts");
const { assert, report } = createAssert();

const OPTS = { dim: 8, model: "stub-embed" };
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = migrationFiles();

/** The migrator, from the fixture's shell (test-support's migratorEnv: the test width and model, the overrides the runner would refuse stripped). */
const MIGRATOR_ENV = migratorEnv(URL_, OPTS);
const migrate = (...extra: string[]) => runMigrator(URL_, MIGRATOR_ENV, ...extra);

/** The migrator's lock message, as its one constant spells the timeout — the three modes share the opening. */
const LOCK_RE = new RegExp(`A lock was not granted within the run's ${LOCK_TIMEOUT_S} s lock_timeout`);

/** A script's exit for an assertion label, with its output when it failed. */
const shown = (x: { code: number; out: string }) => `(exit ${x.code})${x.code === 0 ? "" : `:\n${x.out}`}`;

/**
 * The corpus every case of 021's evidence backfill reads (SMD-1193, SMD-1421):
 * helpers over one connection, and the three thoughts with their claim rows —
 * a plain succeeded row under the model's own key; an ACCEPTED row (SMD-1067:
 * succeeded, the caveat prefix, the failure's own timestamps), so 021's block,
 * run as written, labels the thought at a model whose pass never wrote its
 * vector; and a thought with both, an earlier pass's plain row under its key
 * then the acceptance under the new key — the latest row, which 021 as
 * written trusts. Written two hours ago, the earlier pass an hour ago, the
 * acceptances now, so 021's bound (updated_at <= finished_at) holds for every
 * row and only the rule decides.
 */
function evidenceFixture(sql: SQL) {
  const vec = `[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]`;
  const KEY = reembedKey(OPTS.model, OPTS.dim);
  const EARLIER = reembedKey("earlier-model", OPTS.dim);
  const plant = async (content: string) =>
    (await sql`INSERT INTO thoughts (content, metadata, embedding, updated_at) VALUES (${content}, '{}'::jsonb, ${vec}::vector, now() - interval '2 hours') RETURNING id`)[0].id as string;
  const enqueue = (key: string, ids: string[]) => sql.unsafe(`SELECT enqueue_thoughts('${key}', ARRAY[${ids.map((i) => `'${i}'`).join(",")}]::uuid[])`);
  /** The rows as --accept-failed leaves them (SMD-1067): succeeded, the caveat, the failure's own timestamps. */
  const accept = (key: string, ids: string[], caveat = "refused") =>
    sql.unsafe(
      `UPDATE thought_work_claims SET status = 'succeeded', claimed_at = now(), finished_at = now(), last_error = $1 WHERE work_type = $2 AND thought_id IN (${ids.map((i) => `'${i}'`).join(",")})`,
      [ACCEPTED_CAVEAT_PREFIX + caveat, key]
    );
  const labels = async () => Object.fromEntries(((await sql`SELECT id, embedding_model AS m FROM thoughts ORDER BY id`) as { id: string; m: string | null }[]).map((r) => [r.id, r.m]));
  const corpus = async () => {
    const vouched = await plant("a finished pass wrote this vector");
    const accepted = await plant("the provider refused this; the operator accepted the failure");
    const earlierThenAccepted = await plant("an earlier pass wrote this; the pass to the new model was refused and accepted");
    await enqueue(EARLIER, [earlierThenAccepted]);
    await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() - interval '1 hour' WHERE work_type = ${EARLIER}`;
    await enqueue(KEY, [vouched, accepted, earlierThenAccepted]);
    await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE work_type = ${KEY} AND thought_id = ${vouched}::uuid`;
    await accept(KEY, [accepted, earlierThenAccepted], "the provider refused the content on every attempt");
    return { vouched, accepted, earlierThenAccepted };
  };
  return { vec, KEY, plant, enqueue, accept, labels, corpus };
}

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
  // 021's own signature, not UPDATE_THOUGHT_SIGNATURE: that names the form the
  // servers call today (032's nine arguments), and this section stops at 021.
  assert(dupCol.c === 1 && dupFn.c === 1 && (await sql`SELECT to_regprocedure('update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)') IS NOT NULL AS p`)[0].p === true,
         "re-applying 021 is a no-op: the column once, the function once, at 021's signature");
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

console.log("\n[7] --reapply onto a --baseline'd 020 — every migration in one transaction, 021's backfill with the acceptances out of its sight, and what the re-run refuses (SMD-1193, SMD-1421)");
{
  await dropSchema(URL_);
  // A brain adopted with --baseline: the schema as far as 020, by hand as it
  // were, and a ledger that says every migration. reembed.ts refuses to run
  // there and names the remedy; this is the remedy.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "021" });
  // The migrator's shell: the parent's without its OB1_* variables, plus the
  // suite's width and model (test-support's migratorEnv); the bare apply above
  // pinned the same chunk-context default, so the two halves of the fixture
  // agree. reembed.ts --status takes the same shell.
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0 && new RegExp(`baselined ${MIGRATIONS.length}, skipped 0`).test(baselined.out), `--baseline records every migration without running one (exit ${baselined.code})`);

  const sql = new SQL({ url: URL_, max: 1 });
  // The brain as it stood before this change: baselined through 029, so 030
  // is pending, and a PLAIN run — the compose stack's, which gates the server
  // on it — must not fail with a bare "does not exist".
  // 030 by name, not "the last file". The scenario deletes only 030 from the
  // ledger, so a plain run attempts only 030 — 031 (renew_claims, SMD-1023),
  // 032 (the provenance envelope, SMD-1323), 033 (the capture's fingerprint
  // lock, SMD-1043), 034 (the opt-in query log, SMD-1295), 035 (a
  // re-capture writes no provenance, SMD-1453), 036 (delete_thought's lock
  // order, SMD-1462), 037 (the routing count's gate, SMD-1463) and 038 (the
  // gate's sample by TID range, SMD-1526), 039 (the half-precision walk,
  // SMD-1501), 040 (jit off on the function, SMD-1624) and 041 (the cite
  // shape stated at the table, SMD-1749) stay recorded and are never tried.
  // 030 is the right one to make
  // pending
  // because its prerequisites — 015 and 021's embedding_model column — are
  // exactly what a through-020 schema lacks, so it fails by name rather than
  // with a bare error. The window guard trips whenever a migration lands past
  // 030, to force this note to be re-read (034 needs only 001/010; 035 needs
  // 016, 025, 032 and 033; 036 redefines delete_thought and needs only 009's
  // body and 029's supersession lock; 037 redefines 020's match_thoughts and
  // 038 037's; 039 redefines it again and swaps 001's and 007's two indexes,
  // which every schema has; 040 redefines it once more with one SET clause;
  // 041 comments 034's table and column and needs only 034, refusing by
  // name without it as 031 does without 015 ([19]) —
  // all recorded by the baseline with their prerequisites present, so none
  // becomes the plain-run failure point above).
  const last = MIGRATIONS.find((f) => f.startsWith("030_"))!;
  assert(last !== undefined && MIGRATIONS.indexOf(last) >= MIGRATIONS.length - 12, `030 is among the last twelve migrations (${last})`);
  await sql`DELETE FROM schema_migrations WHERE name = ${last}`;
  const plainRun = await migrate();
  const plainOk = plainRun.code === 1 && /030_label_from_claims_excludes_accepted\.sql\s+FAILED: migration 030 needs 015 \(thought_work_claims\) and 021 \(thoughts\.embedding_model\); this schema lacks thoughts\.embedding_model/.test(plainRun.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plainRun.out);
  assert(plainOk, `a plain run on the baselined brain fails at 030 naming what is missing and --reapply, not with a bare error (exit ${plainRun.code})${plainOk ? "" : `:\n${plainRun.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${last}`)[0].c) === 0, "…and records nothing");
  const { vec, KEY, plant, enqueue, accept, labels, corpus } = evidenceFixture(sql);
  const { vouched, accepted, earlierThenAccepted } = await corpus();
  const noEvidence = await plant("nothing ever re-embedded this");
  const column = async () => Number((await sql`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'embedding_model'`)[0].c);
  assert((await column()) === 0, "the schema stands at 020 — no embedding_model column — whatever the ledger says");

  // What the operator reads first. --status runs against any schema and says
  // what a run would refuse on; the ledgered remedy is the migrator's command.
  const status = await runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_, "--status"], { env: MIGRATOR_ENV, cwd: HERE });
  const recorded021 = async () => Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name LIKE '021%'`)[0].c);
  const ledger = async () => JSON.stringify(await sql`SELECT name, sha256, applied_at::text AS a FROM schema_migrations ORDER BY 1`);
  assert(status.code === 0 && /a run would refuse: the schema predates migration 021/.test(status.out) &&
           /schema_migrations records 021 as\n\s+applied \(--baseline\?\) but the schema installed is older\. Re-apply the recorded migrations with the migrator/.test(status.out) &&
           /cd db && bun migrate\.ts --url … --reapply\s*$/m.test(status.out) && !/re-run the body/.test(status.out),
         `reembed.ts --status on the baselined brain names \`migrate.ts --reapply\`, not a paste (exit ${status.code})`);

  // 021 pending too, from here on: a ledger hole on the very file whose block
  // applyShadowed runs with the acceptances out of its sight, so a plain run
  // reaches it.
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
  const otherShell = await runMigrator(URL_, { ...MIGRATOR_ENV, OB1_EMBEDDING_MODEL: "other-embed" }, "--reapply");
  assert(otherShell.code === 2 && /refusing --reapply: ob1_config records embedding_model = stub-embed and this shell would re-record it as other-embed/.test(otherShell.out),
         `a shell whose model differs from the record is refused — 006 would re-record it (exit ${otherShell.code})`);
  assert((await sql`SELECT value FROM ob1_config WHERE key = 'embedding_model'`)[0].value === OPTS.model && (await column()) === 0, "…and nothing was written");
  const otherDry = await runMigrator(URL_, { ...MIGRATOR_ENV, OB1_EMBEDDING_MODEL: "other-embed" }, "--reapply", "--dry-run");
  assert(otherDry.code === 2 && /would refuse --reapply: ob1_config records embedding_model = stub-embed/.test(otherDry.out) && !/would re-apply \(/.test(otherDry.out) && !/would re-apply every migration/.test(otherDry.out),
         `…and --dry-run from that shell says it would refuse, the same judgement, with no banner for a run that never begins (exit ${otherDry.code})`);
  // The width is the column's, judged before BEGIN in both modes — 006 would
  // refuse it inside the transaction, after a dry run had said green.
  const otherWidth = await runMigrator(URL_, { ...MIGRATOR_ENV, OB1_EMBEDDING_DIM: "9" }, "--reapply", "--dry-run");
  assert(otherWidth.code === 2 && /would refuse --reapply: thoughts\.embedding is vector\(8\) and this shell says OB1_EMBEDDING_DIM=9/.test(otherWidth.out) && /Set OB1_EMBEDDING_DIM=8/.test(otherWidth.out),
         `a shell whose width differs from the column is refused before BEGIN, dry run included (exit ${otherWidth.code})`);
  // The two rows 021's block labels from and 030 leaves: an acceptance under a
  // SUFFIXED key over an unlabelled thought (030 cannot tell that label from
  // the server's own), and an own-key acceptance over a thought written after
  // the row was enqueued (021's bound is the release, 030's the enqueue), here
  // written between the claim and the release. Until SMD-1421 the run was
  // refused on both and the operator sent to spend the acceptances; now the
  // block never sees them.
  const SUFFIXED = `${KEY}:ctx`;
  const suffixedHazard = await plant("unlabelled; a backfill under a suffixed key was refused and accepted");
  await enqueue(SUFFIXED, [suffixedHazard]);
  await accept(SUFFIXED, [suffixedHazard]);
  const writtenSince = (await sql`INSERT INTO thoughts (content, metadata, embedding, updated_at) VALUES ('unlabelled; written during the attempt that was refused and accepted', '{}'::jsonb, ${vec}::vector, now() - interval '30 minutes') RETURNING id`)[0].id as string;
  await enqueue(KEY, [writtenSince]);
  await sql`UPDATE thought_work_claims SET status = 'succeeded', enqueued_at = now() - interval '2 hours', claimed_at = now() - interval '1 hour', finished_at = now(), last_error = ${ACCEPTED_CAVEAT_PREFIX + "refused"} WHERE work_type = ${KEY} AND thought_id = ${writtenSince}::uuid`;
  // A session holding ACCESS EXCLUSIVE on ob1_config: the checks before the
  // run read it, and would wait for ever without a timeout of their own.
  const excl = new SQL({ url: URL_, max: 1 });
  await excl.unsafe("BEGIN");
  await excl.unsafe("LOCK TABLE ob1_config IN ACCESS EXCLUSIVE MODE");
  const blockedChecks = await migrate("--reapply");
  await excl.unsafe("ROLLBACK");
  await excl.close();
  assert(blockedChecks.code === 1 && /--reapply\s+could not be judged: .*lock timeout/.test(blockedChecks.out) && LOCK_RE.test(blockedChecks.out) && /on the checks' reads before it/.test(blockedChecks.out) && !/re-applying every migration/.test(blockedChecks.out),
         `an exclusive lock on ob1_config fails the checks before the run within their own timeout (exit ${blockedChecks.code})`);
  assert((await column()) === 0 && (await ledger()) === ledgerBefore, "…and nothing was written");
  // A session holding a lock on thoughts — an idle transaction, a server left
  // running: 001's DROP TRIGGER wants ACCESS EXCLUSIVE, the 10 s lock_timeout
  // fails it, and the one transaction rolls back with nothing changed.
  const holder = new SQL({ url: URL_, max: 1 });
  await holder.unsafe("BEGIN");
  await holder.unsafe("SELECT count(*) FROM thoughts");
  const locked = await migrate("--reapply");
  await holder.unsafe("ROLLBACK");
  await holder.close();
  assert(locked.code === 1 && /001_core_schema\.sql\s+FAILED: .*lock timeout/.test(locked.out) && LOCK_RE.test(locked.out) &&
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
  assert(run.code === 0, `--reapply exits 0 ${shown(run)}`);
  assert(new RegExp(`re-applying every migration \\(${MIGRATIONS.length - 3} recorded, 3 pending\\), in order, in one transaction with a ${LOCK_TIMEOUT_S} s lock timeout`).test(run.out) &&
           /Stop the server and any re-embed or extraction worker first/.test(run.out) &&
           /021_embedding_model_per_row\.sql\s+applied/.test(run.out) && /022_capture_replaces_chunks\.sql\s+applied/.test(run.out) && /030_label_from_claims_excludes_accepted\.sql\s+applied/.test(run.out) &&
           new RegExp(`applied 3, re-applied ${MIGRATIONS.length - 3}, skipped 0`).test(run.out) && !/already applied/.test(run.out),
         "…says what it ran: every file in order, the pending ones (021, the hole at 022, and 030) applied in their place, none skipped, and the operator's precondition");
  const models = await labels();
  assert(models[vouched] === OPTS.model, `a thought a finished pass vouches for is labelled from its plain succeeded row (${models[vouched]})`);
  assert(models[accepted] === null, `a thought whose only row is the operator's acceptance ends NULL — 021's block never saw the acceptance (${models[accepted]})`);
  assert(models[earlierThenAccepted] === "earlier-model", `with the acceptance excluded the latest row before it decides: the earlier pass that did write the vector (${models[earlierThenAccepted]})`);
  assert(models[noEvidence] === null, "a thought no pass touched stays NULL");
  assert(models[suffixedHazard] === null && models[writtenSince] === null, "the acceptance under a suffixed key and the own-key acceptance over a thought written since its enqueue — both rows 021's block as written labels from and 030 leaves — end NULL: the block never saw them");
  // By the one predicate the shadow excludes rows with, so the count and the exclusion cannot drift apart.
  const standing = async () => Number(((await sql.unsafe(`SELECT count(*)::int AS c FROM thought_work_claims c WHERE c.status = 'succeeded' AND ${ACCEPTED_CLAIM_SQL}`)) as { c: number }[])[0].c);
  assert((await standing()) === 4, "…and every acceptance stands, spent by nobody");
  assert(/021_embedding_model_per_row\.sql\s+applied\n\s+·\s+021's evidence backfill labelled 2 thought\(s\) from the claim rows, the operator's acceptances out of its sight/.test(run.out) &&
           /030_label_from_claims_excludes_accepted\.sql\s+applied\n(?!\s+·)/.test(run.out),
         "…and the run says, beside 021's line, what the block wrote with the acceptances out of its sight: the plain row's thought and the earlier pass's — and nothing beside 030: no note follows its line");
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

  // A hole at 021 ALONE, 030 recorded: nothing follows 021, so what its block
  // does not see it never writes. Here: the `accepted` thought — NULL, its
  // own-key acceptance standing, which 021's block as written labels from —
  // and a thought unlabelled since the upgrade whose only row is an acceptance
  // under a suffixed key. Until SMD-1421 this run was refused on the own-key
  // acceptance.
  await sql`DELETE FROM schema_migrations WHERE name LIKE '021%'`;
  const lateSuffixed = await plant("unlabelled since the upgrade; a backfill under a suffixed key was refused and accepted");
  await enqueue(SUFFIXED, [lateSuffixed]);
  await accept(SUFFIXED, [lateSuffixed]);
  // …and a label from BEFORE 021 — labelled at the model by a paste of the
  // body over an own-key acceptance, nothing written since its enqueue: 030's
  // first statement's to take back, at 030's own run, which the plain run
  // skips and the re-run reaches.
  const pasteMislabel = (await sql`INSERT INTO thoughts (content, metadata, embedding, embedding_model, updated_at) VALUES ('labelled at the model by a paste of 021 over an own-key acceptance', '{}'::jsonb, ${vec}::vector, ${OPTS.model}, now() - interval '2 hours') RETURNING id`)[0].id as string;
  await enqueue(KEY, [pasteMislabel]);
  await accept(KEY, [pasteMislabel]);
  // A session holding a lock on thoughts while the plain run reaches 021: the
  // file's own ADD COLUMN wants ACCESS EXCLUSIVE, and the run's 10 s
  // lock_timeout fails it in its own transaction rather than waiting for ever
  // behind the holder — and nothing is written or recorded.
  const heldPlain = new SQL({ url: URL_, max: 1 });
  await heldPlain.unsafe("BEGIN");
  await heldPlain.unsafe("LOCK TABLE thoughts IN ACCESS EXCLUSIVE MODE");
  const blockedPlain = await migrate();
  await heldPlain.unsafe("ROLLBACK");
  await heldPlain.close();
  assert(blockedPlain.code === 1 && /021_embedding_model_per_row\.sql\s+FAILED: .*lock timeout/.test(blockedPlain.out) && LOCK_RE.test(blockedPlain.out),
         `a held lock on thoughts fails a plain run's 021 within the run's 10 s (exit ${blockedPlain.code})`);
  assert((await recorded021()) === 0 && (await sql`SELECT embedding_model AS m FROM thoughts WHERE id = ${lateSuffixed}::uuid`)[0].m === null,
         "…and 021 is not recorded, nothing labelled");
  const holeAt021 = await migrate();
  assert(holeAt021.code === 0, `with 030 recorded and skipped, a plain run with a hole at 021 applies it ${shown(holeAt021)}`);
  assert(/021_embedding_model_per_row\.sql\s+applied/.test(holeAt021.out) && /030_label_from_claims_excludes_accepted\.sql\s+already applied/.test(holeAt021.out) &&
           /021's evidence backfill labelled 0 thought\(s\) from the claim rows/.test(holeAt021.out) && !/refus/.test(holeAt021.out),
         "…no refusal, 030 skipped as recorded, and the shadow's line says zero: every unlabelled thought's rows are acceptances, out of the block's sight");
  const afterHole = await labels();
  assert(afterHole[accepted] === null && afterHole[lateSuffixed] === null && afterHole[suffixedHazard] === null && afterHole[writtenSince] === null,
         "…the thoughts whose only evidence is an acceptance stay NULL, the new one included");
  assert(afterHole[pasteMislabel] === OPTS.model, "…and the paste's label from before 021 stands: 030's to take back, and 030 did not run");
  assert(afterHole[vouched] === OPTS.model && afterHole[earlierThenAccepted] === "earlier-model" && afterHole[noEvidence] === null,
         "…every other label is as the re-run left it — a labelled row is not in the snapshot");
  assert((await standing()) === 6 && (await updatedAtTriggerState(sql)) === "O" && (await recorded021()) === 1,
         "…every acceptance stands, the trigger is enabled again, and 021 is recorded");
  // The re-run over the same corpus: 021's block sees no acceptance and labels
  // nothing; 030 at its own place takes the paste's label back — and 022's
  // and 025's redefinitions of upsert_thought, which the plain run of 021
  // alone put 021's body over, are restored (the state preflight's `atomic
  // capture` names, with this remedy).
  const again = await migrate("--reapply");
  assert(again.code === 0 && /021's evidence backfill labelled 0 thought\(s\)/.test(again.out), `a second --reapply labels nothing at 021 — the acceptances out of its sight ${shown(again)}`);
  assert(JSON.stringify(await labels()) === JSON.stringify({ ...afterHole, [pasteMislabel]: null }), "…and 030, at its own place, takes the paste's label back; every other label as before");

  // Every recorded file, not a range: 022 and 025 redefine 021's 3-argument
  // upsert_thought, and a re-run of 021 by itself would have put 021's body
  // back — the very state preflight's `atomic capture` check warns about.
  const forms = (await sql`SELECT pronargs AS n FROM pg_proc WHERE proname = 'update_thought' ORDER BY 1`) as { n: number }[];
  // …and 021's 8-argument update_thought would have stayed beside 032's.
  assert(forms.length === 1 && Number(forms[0].n) === 9, `the nine-argument update_thought, alone — 032 ran after 021 and dropped 021's (${forms.map((f) => f.n).join(",")})`);
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

console.log("\n[9] Migration 031 on a schema without 015 — refused up front, naming 015 and --reapply (SMD-1023)");
{
  // A brain adopted with --baseline at a ledger through 031 whose schema stops
  // before 015. 031's CREATE FUNCTION would succeed there (plpgsql resolves
  // the table at first run) and its column COMMENT would fail bare; the file
  // opens with 030's guard instead, so a plain run — the compose stack's,
  // gating the server — fails naming what is missing and the remedy.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "015" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-015 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the031 = MIGRATIONS.find((f) => f.startsWith("031_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the031}`;
  const plain = await migrate();
  const ok = plain.code === 1 && /031_renew_claims\.sql\s+FAILED: migration 031 needs 015 \(thought_work_claims\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 031 naming 015 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the031}`)[0].c) === 0, "…records nothing");
  assert((await sql`SELECT to_regprocedure('renew_claims(text, text, int)') IS NULL AS absent`)[0].absent === true, "…and defines nothing: the guard runs before the function");
  await sql.close();
}

console.log("\n[10] Migration 032 onto a populated 031 — the nine-argument update_thought replaces 021's, the ACL crosses, and no row moves (SMD-1323)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "032" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]`;
  const UT_8 = "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)";

  // A corpus at 031: provenance set at capture through 025's envelope, and the
  // 8-argument form hardened — PUBLIC revoked, one role granted — the way a
  // Supabase brain's would be.
  const [{ r: olderR }] = await sql`SELECT upsert_thought('the earlier note', '{"metadata":{}}'::jsonb, ${vec}::vector) AS r`;
  const older = (olderR as { id: string }).id;
  const [{ r: newerR }] = await sql`SELECT upsert_thought('the later note', ${{ metadata: {}, supersedes: older, derived_from: [older] }}::jsonb, ${vec}::vector) AS r`;
  const newer = (newerR as { id: string }).id;
  const forms = async () => ((await sql`SELECT pronargs AS n FROM pg_proc WHERE proname = 'update_thought' ORDER BY 1`) as { n: number }[]).map((f) => Number(f.n));
  assert(JSON.stringify(await forms()) === "[8]", `at 031 update_thought takes eight arguments (${(await forms()).join(",")})`);
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_editor32') THEN CREATE ROLE ob1_upgrade_editor32 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${UT_8} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${UT_8} TO ob1_upgrade_editor32`);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, supersedes, derived_from, updated_at::text AS u FROM thoughts ORDER BY id`);
  const before = await snapshot();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("032") });

  assert(JSON.stringify(await forms()) === "[9]" && (await sql`SELECT to_regprocedure(${UPDATE_THOUGHT_SIGNATURE}) IS NOT NULL AS p`)[0].p === true,
         `after 032 one update_thought, of nine arguments, at the shipped signature (${(await forms()).join(",")})`);
  assert((await snapshot()) === before, "no row moved: supersedes, derived_from and updated_at as they were");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and no audit row was written");
  const acl = String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${UPDATE_THOUGHT_SIGNATURE}::regprocedure`)[0].a ?? "");
  assert(!/(^\{|,)=X\//.test(acl) && /ob1_upgrade_editor32=X\//.test(acl), `the 8-argument form's ACL crossed the DROP: PUBLIC still revoked, the role still granted (${acl})`);

  // The mirror: an 8-argument positional call — reembed.ts's — still resolves,
  // through the default; the envelope clears the capture-time pointer; and the
  // review function is 032's, calling update_thought.
  const [{ r: eight }] = await sql`SELECT ${sql.unsafe(`update_thought('${newer}'::uuid, 'the later note', NULL::jsonb, '${vec}'::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, '${OPTS.model}'::text)`)} AS r`;
  assert((eight as { ok: boolean }).ok === true, "an 8-argument positional call resolves through the ninth parameter's default");
  const [{ r: cleared }] = await sql`SELECT update_thought(${newer}::uuid, NULL::text, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text, '{"supersedes": null}'::jsonb) AS r`;
  const [row] = await sql`SELECT supersedes AS s, derived_from AS d FROM thoughts WHERE id = ${newer}::uuid`;
  assert((cleared as { ok: boolean }).ok === true && row.s === null && JSON.stringify(row.d) === JSON.stringify([older]), "…and the envelope clears the pointer set at capture, leaving derived_from");
  const review = (await sql`SELECT prosrc FROM pg_proc WHERE oid = 'review_supersession_proposal(uuid, text, text, text, jsonb, boolean)'::regprocedure`)[0].prosrc as string;
  assert(/update_thought\(/.test(review) && !/UPDATE\s+thoughts\b/i.test(review), "review_supersession_proposal is 032's: it writes through update_thought");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("032") });
  const again = String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${UPDATE_THOUGHT_SIGNATURE}::regprocedure`)[0].a ?? "");
  assert(JSON.stringify(await forms()) === "[9]" && again === acl, "re-applying 032 is a no-op: one function, the ACL as it was");
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_editor32`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_editor32`);
  await sql.close();
}

console.log("\n[11] 021 with the acceptances out of its sight on a plain run — the column absent, 030 recorded then pending, and a role without TEMP (SMD-1421)");
{
  /** A brain through 020 with the fixture's corpus and an acceptance under a SUFFIXED key over an unlabelled thought — the row 030 can never correct. */
  const build = async () => {
    await resetSchema(URL_, { ...OPTS, only: (f) => f < "021" });
    const sql = new SQL({ url: URL_, max: 1 });
    const fx = evidenceFixture(sql);
    const corpus = await fx.corpus();
    const suffixed = await fx.plant("unlabelled; a backfill under a suffixed key was refused and accepted");
    await fx.enqueue(`${fx.KEY}:ctx`, [suffixed]);
    await fx.accept(`${fx.KEY}:ctx`, [suffixed]);
    return { sql, ...fx, ...corpus, suffixed };
  };

  // The column absent and 030 recorded — a --baseline'd brain with a hole at
  // 021: the block labels from the plain rows alone, the suffixed-key
  // acceptance out of its sight like the own-key ones.
  let b = await build();
  await migrate("--baseline");
  await b.sql`DELETE FROM schema_migrations WHERE name LIKE '021%'`;
  const absent = await migrate();
  assert(absent.code === 0, `a plain run with a hole at 021 on a schema without the column applies it ${shown(absent)}`);
  assert(/021_embedding_model_per_row\.sql\s+applied\n\s+·\s+021's evidence backfill labelled 2 thought\(s\) from the claim rows, the operator's acceptances out of its sight/.test(absent.out) &&
           /030_label_from_claims_excludes_accepted\.sql\s+already applied/.test(absent.out),
         "…two labelled — the plain row's thought and the earlier pass's — 030 skipped as recorded");
  let now = await b.labels();
  assert(now[b.vouched] === OPTS.model && now[b.accepted] === null && now[b.earlierThenAccepted] === "earlier-model" && now[b.suffixed] === null,
         "…and the labels are the rule's: the acceptance-only thoughts unknown, the suffixed key's too, the earlier pass's at its model");
  await b.sql.close();

  // The same brain with both files pending — the ordinary upgrade, by ledger
  // hole, the column truly absent — a fresh own-key acceptance besides, and
  // the database's search_path listing pg_temp LAST, the hardening shape: the
  // view shadows only because the migrator strips the entry for 021's
  // transaction, and the run's "labelled 2" says it did.
  b = await build();
  const late = await b.plant("unlabelled; a pass to the model was refused and accepted");
  await b.enqueue(b.KEY, [late]);
  await b.accept(b.KEY, [late]);
  await migrate("--baseline");
  await b.sql`DELETE FROM schema_migrations WHERE name LIKE '021%' OR name LIKE '030%'`;
  const [{ db }] = (await b.sql`SELECT current_database() AS db`) as { db: string }[];
  await b.sql.unsafe(`ALTER DATABASE "${db}" SET search_path = "$user", public, pg_temp`);
  let both: { code: number; out: string };
  try {
    both = await migrate();
  } finally {
    await b.sql.unsafe(`ALTER DATABASE "${db}" RESET search_path`);
  }
  assert(both.code === 0, `a plain run with 021 and 030 pending, on a database whose search_path lists pg_temp last, applies both ${shown(both)}`);
  assert(/021_embedding_model_per_row\.sql\s+applied\n\s+·\s+021's evidence backfill labelled 2 thought\(s\)/.test(both.out) && /030_label_from_claims_excludes_accepted\.sql\s+applied\n/.test(both.out),
         "…021 labels the two thoughts with plain rows and 030 applies at its own place");
  now = await b.labels();
  assert(now[b.vouched] === OPTS.model && now[b.accepted] === null && now[b.earlierThenAccepted] === "earlier-model" && now[b.suffixed] === null && now[late] === null,
         "…and every acceptance-only thought is unknown, the suffixed key's and the fresh one's included");
  assert((await updatedAtTriggerState(b.sql)) === "O", "…and the updated_at trigger is enabled again afterwards");

  // A role without TEMP on the database: refused before anything runs, dry run
  // included, naming the GRANT — where the copy would otherwise fail at 021
  // after the files before it had committed.
  // The role is the cluster's, not the schema's: a leftover from an
  // interrupted run is removed first, and whatever happens the grant to PUBLIC
  // comes back and the role goes.
  const dropRole = async () => {
    await b.sql.unsafe("DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_notemp') THEN EXECUTE 'DROP OWNED BY ob1_notemp'; EXECUTE 'DROP ROLE ob1_notemp'; END IF; END $$");
  };
  await dropRole();
  const noTempUrl = new URL(URL_);
  noTempUrl.username = "ob1_notemp";
  noTempUrl.password = "notemp";
  try {
    await b.sql.unsafe("CREATE ROLE ob1_notemp LOGIN PASSWORD 'notemp'");
    await b.sql.unsafe(`REVOKE TEMP ON DATABASE "${db}" FROM PUBLIC`);
    await b.sql.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO ob1_notemp`);
    await b.sql.unsafe("GRANT USAGE, CREATE ON SCHEMA public TO ob1_notemp");
    await b.sql.unsafe("GRANT SELECT ON ALL TABLES IN SCHEMA public TO ob1_notemp");
    const noTemp = await runMigrator(noTempUrl.href, { ...MIGRATOR_ENV, DATABASE_URL: noTempUrl.href }, "--reapply", "--dry-run");
    assert(noTemp.code === 2 && /would refuse --reapply: this role may not create a temp relation, and 021's evidence backfill needs one/.test(noTemp.out) &&
             new RegExp(`GRANT TEMPORARY ON DATABASE "${db}" TO "ob1_notemp"; then run again`).test(noTemp.out) && !/would re-apply every migration/.test(noTemp.out),
           `a role without TEMP is refused before anything runs, with the GRANT, and the dry run says so too (exit ${noTemp.code})`);
  } finally {
    await b.sql.unsafe(`GRANT TEMP ON DATABASE "${db}" TO PUBLIC`);
    await dropRole();
    await b.sql.close();
  }
}

console.log("\n[12] Migration 033 onto a populated 032 — both capture forms take the fingerprint lock, no signature, row or privilege moves (SMD-1043)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "033" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const chunks = (axis: number) => [{ content: "window", embedding: vec(axis) }];
  const TWO = "upsert_thought(text, jsonb)";
  const THREE = "upsert_thought(text, jsonb, vector)";
  const bodyOf = async (sig: string) => (await sql`SELECT prosrc FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].prosrc as string;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");

  // A corpus at 032: a windowed thought with provenance, a 2-argument
  // capture, and the 3-argument form hardened the way a Supabase brain's is.
  const TEXT = "captured at 032 with a window, re-captured under 033";
  const [{ r: olderR }] = await sql`SELECT upsert_thought('the note it supersedes', '{"metadata":{}}'::jsonb, ${vec(0)}::vector) AS r`;
  const older = (olderR as { id: string }).id;
  const [{ r }] = await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: {}, embedding_model: OPTS.model, supersedes: older }}::jsonb, ${vec(1)}::vector, ${chunks(2)}::jsonb) AS r`;
  const id = (r as { id: string }).id;
  await sql`SELECT upsert_thought('a two-argument capture at 032', '{"metadata":{},"actor":{"name":"before","source":"test"}}'::jsonb)`;
  const windows = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${id}::uuid`)[0].c);
  assert(!/ob1:capture-takes-fingerprint-lock/.test(await bodyOf(THREE)) && !/pg_advisory_xact_lock/.test(await bodyOf(TWO)), "at 032 neither capture body takes an advisory lock");
  const edit032 = await bodyOf(UPDATE_THOUGHT_SIGNATURE);
  assert(edit032.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE") < edit032.indexOf("pg_advisory_xact_lock(hashtextextended"), "…and update_thought takes its row before the fingerprint lock (018's order)");
  const [{ a: unattributed }] = await sql`SELECT actor_name AS a FROM thought_audit WHERE action = 'capture' AND thought_id = (SELECT id FROM thoughts WHERE content = 'a two-argument capture at 032')`;
  assert(unattributed === null, "…and a capture through the 2-argument form is unattributed — 005's body never read the actor");
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_capturer33') THEN CREATE ROLE ob1_upgrade_capturer33 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${THREE} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${THREE} TO ob1_upgrade_capturer33`);
  const acl = await aclOf(THREE);
  const before = await shape(sql);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, supersedes, derived_from, embedding_model, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("033") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "033 adds no column and changes no signature — three upsert_thought overloads as before");
  assert((await snapshot()) === rows && (await windows()) === 1, "no row moved and no window went: nothing here is a backfill");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and no audit row was written");
  assert((await aclOf(THREE)) === acl && !/(^\{|,)=X\//.test(acl), `CREATE OR REPLACE under the same signature keeps the 3-argument form's ACL: PUBLIC still revoked, the role still granted (${acl})`);
  const LOCK = "PERFORM pg_advisory_xact_lock(hashtextextended(v_fingerprint, 0));";
  assert((await bodyOf(TWO)).includes(LOCK) && (await bodyOf(THREE)).includes(LOCK) && (await bodyOf(UPDATE_THOUGHT_SIGNATURE)).includes(LOCK), "both capture bodies spell the fingerprint lock as update_thought does");
  const edit = await bodyOf(UPDATE_THOUGHT_SIGNATURE);
  assert(Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'update_thought'`)[0].c) === 1 && edit.indexOf(LOCK) < edit.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE") && /ob1:unchanged-edit-not-duplicate/.test(edit),
         "…and update_thought, one function still, takes the fingerprint lock before its row read, 018's sentinel kept");
  assert(/ob1:vector-replaces-chunks/.test(await bodyOf(THREE)) && /p_payload->'derived_from'/.test(await bodyOf(THREE)) && /validate_derived_from\(/.test(await bodyOf(THREE)), "…the 3-argument body carrying 022's sentinel and 025's envelope, through 032's validate_derived_from");

  // The mirror: the paths a brain uses the day after. A same-model
  // re-capture keeps the window (022's rule, unchanged); a re-capture naming
  // provenance the row already has leaves it (025, unchanged); the 2-argument
  // form resolves and, since 033, attributes; and no lock outlives a call.
  await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: { k: 1 }, embedding_model: OPTS.model, supersedes: id }}::jsonb, ${vec(3)}::vector)`;
  const [row] = await sql`SELECT supersedes AS s, (metadata->>'k')::int AS k FROM thoughts WHERE id = ${id}::uuid`;
  assert((await windows()) === 1 && row.s === older && row.k === 1, "after 033 a same-model re-capture keeps the window and the pointer it already had, merging the metadata");
  const [{ r: twoR }] = await sql`SELECT upsert_thought('a two-argument capture at 033', '{"metadata":{},"actor":{"name":"after","source":"test"}}'::jsonb) AS r`;
  const [{ a: attributed }] = await sql`SELECT actor_name AS a FROM thought_audit WHERE action = 'capture' AND thought_id = ${(twoR as { id: string }).id}::uuid`;
  assert(attributed === "after", `…a capture through the 2-argument form resolves and is attributed (${attributed})`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory'`)[0].c) === 0, "…and no advisory lock is held once the calls return");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("033") });
  assert((await aclOf(THREE)) === acl && JSON.stringify(await shape(sql)) === JSON.stringify(after) && (await windows()) === 1, "re-applying 033 is a no-op: the ACL, the shape and the window as they were");
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_capturer33`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_capturer33`);
  await sql.close();
}

console.log("\n[13] Migration 035 onto a populated 033 — a re-capture no longer fills provenance, no capture takes the supersession lock, no row or privilege moves (SMD-1453)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "035" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const TWO = "upsert_thought(text, jsonb)";
  const THREE = "upsert_thought(text, jsonb, vector)";
  const bodyOf = async (sig: string) => (await sql`SELECT prosrc FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].prosrc as string;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");
  type R = { id: string; existed?: boolean };
  const cap = async (content: string, payload: Record<string, unknown>, axis: number) =>
    (await sql`SELECT upsert_thought(${content}, ${payload}::jsonb, ${vec(axis)}::vector) AS r`)[0].r as R;
  const pointer = async (id: string) => (await sql`SELECT supersedes AS s FROM thoughts WHERE id = ${id}::uuid`)[0].s as string | null;
  const twoRowLoops = async () => Number((await sql`SELECT count(*)::int AS c FROM thoughts a JOIN thoughts b ON b.id = a.supersedes AND b.supersedes = a.id AND a.id < b.id`)[0].c);

  // A corpus at 033, with the loop 033's header states written the way it
  // could be: R with no pointer, X superseding R, R's text re-captured
  // naming X. And a first-hand thought, and a hardened 3-argument form.
  const R_TEXT = "upgrade 035: the earlier note";
  const r = await cap(R_TEXT, { metadata: {} }, 0);
  const x = await cap("upgrade 035: the later note", { metadata: {}, supersedes: r.id }, 1);
  const filled = await cap(R_TEXT, { metadata: {}, supersedes: x.id }, 0);
  assert(filled.existed === undefined && (await pointer(r.id)) === x.id && (await twoRowLoops()) === 1, "at 033 a re-capture naming supersedes fills R's NULL pointer — R → X → R, one row from the header's query — and the return has no existed");
  assert(/supersession-review/.test(await bodyOf(THREE)) && /COALESCE\(thoughts\.supersedes/.test(await bodyOf(THREE)) && !/ob1:re-capture-writes-no-provenance/.test(await bodyOf(THREE)), "…the 3-argument body takes the supersession lock, fills, and carries no 035 sentinel");
  const plain = await cap("upgrade 035: a first-hand note", { metadata: {} }, 2);
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_capturer34') THEN CREATE ROLE ob1_upgrade_capturer34 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${THREE} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${THREE} TO ob1_upgrade_capturer34`);
  const acl = await aclOf(THREE);
  const before = await shape(sql);
  const editBefore = await bodyOf(UPDATE_THOUGHT_SIGNATURE);
  const twoBefore = await bodyOf(TWO);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, supersedes, derived_from, embedding_model, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("035") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "035 adds no column and changes no signature — three upsert_thought overloads as before");
  assert((await snapshot()) === rows && (await twoRowLoops()) === 1, "no row moved: the loop a re-capture wrote at 033 stays — nothing here is a backfill (the header says how to find and clear one)");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and no audit row was written");
  assert((await aclOf(THREE)) === acl && !/(^\{|,)=X\//.test(acl), `CREATE OR REPLACE under the same signature keeps the 3-argument form's ACL: PUBLIC still revoked, the role still granted (${acl})`);
  const three = await bodyOf(THREE);
  assert(/ob1:re-capture-writes-no-provenance/.test(three) && /ob1:capture-takes-fingerprint-lock/.test(three) && /ob1:vector-replaces-chunks/.test(three) && !/supersession-review/.test(three) && !/COALESCE\(thoughts\.(supersedes|derived_from)/.test(three),
         "…the 3-argument body carries 035's sentinel beside 022's and 033's, takes no supersession lock and fills nothing");
  assert((await bodyOf(TWO)) === twoBefore, "…the 2-argument body is byte-identical to 033's — carried, not changed");
  assert((await bodyOf(UPDATE_THOUGHT_SIGNATURE)) === editBefore && Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'update_thought'`)[0].c) === 1, "…and update_thought is untouched: one function, 033's body byte for byte");

  // The mirror: the day after. A re-capture naming supersedes over a row with
  // none fills nothing and says existed; a first capture naming one writes
  // it; the loop written at 033 is found by the header's query and cleared
  // through the envelope; no advisory lock outlives a call.
  const plainAgain = await cap("upgrade 035: a first-hand note", { metadata: { k: 1 }, supersedes: x.id }, 2);
  const [pRow] = await sql`SELECT supersedes AS s, (metadata->>'k')::int AS k FROM thoughts WHERE id = ${plain.id}::uuid`;
  assert(plainAgain.id === plain.id && plainAgain.existed === true && pRow.s === null && pRow.k === 1, "after 035 a re-capture naming supersedes over a row with none fills nothing, says existed: true, and merges the metadata as before");
  const fresh = await cap("upgrade 035: a note captured after", { metadata: {}, supersedes: plain.id }, 3);
  assert(fresh.existed === false && (await pointer(fresh.id)) === plain.id, "…a first capture naming supersedes writes it, existed: false");
  const cleared = (await sql`SELECT update_thought(${r.id}::uuid, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"supersedes": null}'::jsonb) AS r`)[0].r as { ok: boolean };
  assert(cleared.ok === true && (await twoRowLoops()) === 0 && (await pointer(x.id)) === r.id, "…the loop written at 033 is cleared through update_thought's envelope, X → R kept");
  const again = (await sql`SELECT update_thought(${r.id}::uuid, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${{ supersedes: x.id }}::jsonb) AS r`)[0].r as { ok: boolean; error?: string };
  assert(again.ok === false && again.error === "WOULD_CYCLE", `…and cannot be re-written by the one path left to it (${again.error})`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory'`)[0].c) === 0, "…and no advisory lock is held once the calls return");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("035") });
  assert((await aclOf(THREE)) === acl && JSON.stringify(await shape(sql)) === JSON.stringify(after) && (await bodyOf(THREE)) === three, "re-applying 035 is a no-op: the ACL, the shape and the body as they were");
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_capturer34`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_capturer34`);
  await sql.close();
}

console.log("\n[14] Migration 037 onto a populated 036 — match_thoughts gains its gate; no signature, row or privilege moves; and a hand-re-applied 014's 4-argument form is dropped as 020 dropped it (SMD-1463)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "037" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const SIX = "match_thoughts(vector, float, int, jsonb, float, float)";
  const bodyOf = async (sig: string) => (await sql`SELECT prosrc FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].prosrc as string;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");
  const forms = async () => Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'match_thoughts'`)[0].c);
  const answer = async (kind: string) => JSON.stringify((await sql`SELECT id FROM match_thoughts(${vec(0)}::vector, -1.0, 10, ${{ kind }}::jsonb)`).map((r: { id: string }) => r.id).sort());

  // A corpus at 035 — thirty rows of two kinds, both filters under the exact
  // threshold and the table far under the gate's floor — and a hardened
  // 6-argument form.
  for (let i = 0; i < 30; i++) {
    await sql`SELECT upsert_thought(${`upgrade 037: note ${i}`}, ${{ metadata: { kind: i % 10 === 0 ? "rare" : "common" } }}::jsonb, ${vec(i % OPTS.dim)}::vector)`;
  }
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_searcher36') THEN CREATE ROLE ob1_upgrade_searcher36 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO ob1_upgrade_searcher36`);
  const acl = await aclOf(SIX);
  const before = await shape(sql);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  const rareBefore = await answer("rare");
  const commonBefore = await answer("common");
  assert(!/TABLESAMPLE/.test(await bodyOf(SIX)) && (await forms()) === 1, "at 035 match_thoughts has no sample before its routing count, and one form");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("037") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "037 adds no column and changes no signature — one match_thoughts, as before");
  assert((await snapshot()) === rows, "no row moved — nothing here is a backfill");
  assert((await aclOf(SIX)) === acl && !/(^\{|,)=X\//.test(acl), `CREATE OR REPLACE under the same signature keeps the hardened ACL: PUBLIC still revoked, the role still granted (${acl})`);
  const body = await bodyOf(SIX);
  assert(/TABLESAMPLE SYSTEM \(v_pct\)/.test(body) && /IF NOT v_broad THEN/.test(body) && /ob1:filter-inside-scan/.test(body), "…the body samples the heap before it counts, runs the collection only when the sample did not decide, and carries 014's sentinel");
  const [{ cfg, prorows }] = await sql`SELECT array_to_string(proconfig, ',') AS cfg, prorows FROM pg_proc WHERE oid = ${SIX}::regprocedure`;
  assert(/hnsw\.iterative_scan=relaxed_order/.test(String(cfg)) && /enable_seqscan=off/.test(String(cfg)) && Number(prorows) === 10, `…with 014's and 019's clauses carried (${cfg}; ROWS ${prorows})`);
  assert((await answer("rare")) === rareBefore && (await answer("common")) === commonBefore, "…and both filters — 3 and 27 matching rows — return exactly the rows they returned at 035");

  // The state a hand re-apply of 014 leaves — the 4-argument form back beside
  // the 6-argument one, every 4-argument call ambiguous — and what the last
  // definer applied ALONE does about it, since that is what preflight's
  // remedy and the suites' restoreShipped apply: 037 carries 020's DROP.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("014") });
  assert((await forms()) === 2, "014 re-applied by hand puts the 4-argument form back beside 037's");
  let ambiguous = "";
  try {
    await sql`SELECT count(*) FROM match_thoughts(${vec(0)}::vector, 0.0, 10, '{}'::jsonb)`;
  } catch (e) {
    ambiguous = (e as Error).message;
  }
  assert(/not unique/.test(ambiguous), `…and a 4-argument call is ambiguous (${ambiguous.split("\n")[0] || "it succeeded"})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("037") });
  assert((await forms()) === 1 && (await aclOf(SIX)) === acl && (await bodyOf(SIX)) === body,
         "re-applying 037 alone drops the 4-argument form again and leaves the 6-argument form's ACL and body as they were — the last definer restores the shipped state by itself");
  assert((await answer("rare")) === rareBefore, "…and the filtered call answers as before");
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM ob1_upgrade_searcher36`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO PUBLIC`);
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_searcher36`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_searcher36`);
  await sql.close();
}

console.log("\n[15] A kept bench corpus's ledger against the tree: a schema applied bare has none, the migrator's names only the tree's files, and a name the tree lacks is reported where the migrator would not notice it (SMD-1493)");
{
  // bench-hnsw.ts reuses a corpus kept across runs only under a schema the
  // tree vouches for: migrate.ts brings a pending file onto it and refuses a
  // drifted one, and test-support's ledgerStrangers covers the case the
  // runner cannot — a ledger from another branch's tree.
  await resetSchema(URL_, OPTS);
  const sql = new SQL({ url: URL_, max: 1 });
  assert((await ledgerStrangers(sql)) === null, "a schema applied bare (applyMigrations) has no ledger, so nothing vouches for it");
  await dropSchema(URL_);
  const fresh = await migrate();
  assert(fresh.code === 0 && /^applied \d+, skipped 0$/m.test(fresh.out), `the migrator applies the tree onto the empty database and records every file ${shown(fresh)}`);
  assert(JSON.stringify(await ledgerStrangers(sql)) === "[]", "…and its ledger names only files the tree carries");
  await sql`INSERT INTO schema_migrations (name, sha256) VALUES ('999_from_another_branch.sql', '000000000000')`;
  assert(JSON.stringify(await ledgerStrangers(sql)) === JSON.stringify(["999_from_another_branch.sql"]), "a recorded name no file carries is reported by name");
  const again = await migrate();
  assert(again.code === 0 && /^applied 0, skipped \d+$/m.test(again.out), `…which a plain run of the migrator does not notice: it skips everything and exits 0 — the blind spot SMD-1504 closes, when this assertion inverts ${shown(again)}`);
  await sql.close();
}

console.log("\n[16] Migration 038 onto a populated 037 — the gate's sample is drawn by TID range; no signature, row or privilege moves; and a hand-re-applied 014's 4-argument form is dropped as 020 dropped it (SMD-1526)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "038" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const SIX = "match_thoughts(vector, float, int, jsonb, float, float)";
  const bodyOf = async (sig: string) => (await sql`SELECT prosrc FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].prosrc as string;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");
  const forms = async () => Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'match_thoughts'`)[0].c);
  const answer = async (kind: string) => JSON.stringify((await sql`SELECT id FROM match_thoughts(${vec(0)}::vector, -1.0, 10, ${{ kind }}::jsonb)`).map((r: { id: string }) => r.id).sort());

  // A corpus at 037 — thirty rows of two kinds, both filters under the exact
  // threshold and the table far under the gate's floor — and a hardened
  // 6-argument form.
  for (let i = 0; i < 30; i++) {
    await sql`SELECT upsert_thought(${`upgrade 038: note ${i}`}, ${{ metadata: { kind: i % 10 === 0 ? "rare" : "common" } }}::jsonb, ${vec(i % OPTS.dim)}::vector)`;
  }
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_searcher38') THEN CREATE ROLE ob1_upgrade_searcher38 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO ob1_upgrade_searcher38`);
  const acl = await aclOf(SIX);
  const before = await shape(sql);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  const rareBefore = await answer("rare");
  const commonBefore = await answer("common");
  assert(/TABLESAMPLE SYSTEM \(v_pct\)/.test(await bodyOf(SIX)) && !TID_PROBE.test(await bodyOf(SIX)) && (await forms()) === 1, "at 037 match_thoughts samples through TABLESAMPLE SYSTEM, and has one form");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("038") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "038 adds no column and changes no signature — one match_thoughts, as before");
  assert((await snapshot()) === rows, "no row moved — nothing here is a backfill");
  assert((await aclOf(SIX)) === acl && !/(^\{|,)=X\//.test(acl), `CREATE OR REPLACE under the same signature keeps the hardened ACL: PUBLIC still revoked, the role still granted (${acl})`);
  const body = await bodyOf(SIX);
  assert(TID_PROBE.test(body) && !/TABLESAMPLE/.test(body) && /IF NOT v_broad THEN/.test(body) && /ob1:filter-inside-scan/.test(body), "…the body draws its sample by TID range and carries no TABLESAMPLE, runs the collection only when the sample did not decide, and carries 014's sentinel");
  const [{ cfg, prorows }] = await sql`SELECT array_to_string(proconfig, ',') AS cfg, prorows FROM pg_proc WHERE oid = ${SIX}::regprocedure`;
  assert(/hnsw\.iterative_scan=relaxed_order/.test(String(cfg)) && /enable_seqscan=off/.test(String(cfg)) && Number(prorows) === 10, `…with 014's and 019's clauses carried (${cfg}; ROWS ${prorows})`);
  assert((await answer("rare")) === rareBefore && (await answer("common")) === commonBefore, "…and both filters — 3 and 27 matching rows — return exactly the rows they returned at 037");

  // The state a hand re-apply of 014 leaves — the 4-argument form back beside
  // the 6-argument one, every 4-argument call ambiguous — and what the last
  // definer applied ALONE does about it, since that is what preflight's
  // remedy and the suites' restoreShipped apply: 038 carries 020's DROP.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("014") });
  assert((await forms()) === 2, "014 re-applied by hand puts the 4-argument form back beside 038's");
  let ambiguous = "";
  try {
    await sql`SELECT count(*) FROM match_thoughts(${vec(0)}::vector, 0.0, 10, '{}'::jsonb)`;
  } catch (e) {
    ambiguous = (e as Error).message;
  }
  assert(/not unique/.test(ambiguous), `…and a 4-argument call is ambiguous (${ambiguous.split("\n")[0] || "it succeeded"})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("038") });
  assert((await forms()) === 1 && (await aclOf(SIX)) === acl && (await bodyOf(SIX)) === body,
         "re-applying 038 alone drops the 4-argument form again and leaves the 6-argument form's ACL and body as they were — the last definer restores the shipped state by itself");
  assert((await answer("rare")) === rareBefore, "…and the filtered call answers as before");
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM ob1_upgrade_searcher38`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO PUBLIC`);
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_searcher38`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_searcher38`);
  await sql.close();
}

console.log("\n[17] Migration 039 onto a populated 038 — both HNSW indexes swapped for half precision under their names with rows in place; no signature, row or privilege moves; the walk agrees with the exact answer before and after; a re-apply rebuilds nothing, 001 re-applied leaves it, a staging index built beforehand is adopted and an invalid one is not (SMD-1501)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "039" });
  const sql = new SQL({ url: URL_, max: 1 });
  const { unitVector } = seededRandom(1501);
  const lit = () => `[${unitVector(OPTS.dim).join(",")}]`;
  const SIX = "match_thoughts(vector, float, int, jsonb, float, float)";
  const bodyOf = async (sig: string) => (await sql`SELECT prosrc FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].prosrc as string;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");
  const def = async (name: string) => String((await sql`SELECT pg_get_indexdef(to_regclass(${name})) AS d`)[0].d ?? "");
  const oid = async (name: string) => (await sql`SELECT to_regclass(${name})::oid::text AS o`)[0].o as string | null;
  const validOf = async (name: string) => (await sql`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass(${name})`)[0]?.valid as boolean | undefined;
  const HALF = new RegExp(`USING hnsw \\(\\(\\(embedding\\)::halfvec\\(${OPTS.dim}\\)\\) halfvec_cosine_ops\\)$`);

  // A corpus at 038: three hundred random rows (content `row N`, the shape
  // loadChunkRows derives its rows from), a chunk row on every fifth carrying
  // its parent's vector (so the exact answer is the thoughts table's), and a
  // hardened 6-argument form.
  for (let i = 0; i < 300; i++) {
    await sql`SELECT upsert_thought(${`row ${i}`}, ${{ metadata: { kind: i % 3 === 0 ? "a" : "b" } }}::jsonb, ${lit()}::vector)`;
  }
  await loadChunkRows(sql, 5);
  await sql.unsafe(`VACUUM ANALYZE thoughts`);
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_searcher38') THEN CREATE ROLE ob1_upgrade_searcher38 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO ob1_upgrade_searcher38`);
  const acl = await aclOf(SIX);
  const before = await shape(sql);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, metadata, embedding::text AS e, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  assert(/USING hnsw \(embedding vector_cosine_ops\)$/.test(await def("thoughts_embedding_idx")) && /USING hnsw \(embedding vector_cosine_ops\)$/.test(await def("thought_chunks_embedding_idx")),
         "at 038 both indexes are 001's and 007's, over the vector column");
  const queries = Array.from({ length: 5 }, lit);
  // Exact by construction, not by the planner's mood: with the vector index
  // present the raw-column ORDER BY has an index path, so it is kept out.
  const exact = (q: string) => sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET LOCAL enable_indexscan = off`);
    await tx.unsafe(`SET LOCAL enable_bitmapscan = off`);
    return (await tx.unsafe(`SELECT id FROM thoughts ORDER BY embedding <=> $1::vector, id LIMIT 10`, [q])).map((r: { id: string }) => r.id) as string[];
  });
  const wants: string[][] = [];
  for (const q of queries) wants.push(await exact(q));
  const overlap = async () => {
    let o = 0;
    for (const [i, q] of queries.entries()) o += (await sql.unsafe(`SELECT id FROM match_thoughts($1::vector, -1.0, 10, '{}'::jsonb)`, [q])).filter((r: { id: string }) => wants[i].includes(r.id)).length;
    return o / (queries.length * 10);
  };
  const overlapBefore = await overlap();
  assert(overlapBefore >= 0.9, `at 038 the unfiltered walk agrees with the exact top-10 on 300 rows (overlap ${overlapBefore.toFixed(2)})`);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "039 adds no column and changes no signature — one match_thoughts, as before");
  assert((await snapshot()) === rows, "no row moved — the stored vectors are what they were (reembed.ts has nothing to do)");
  assert((await aclOf(SIX)) === acl && !/(^\{|,)=X\//.test(acl), `CREATE OR REPLACE under the same signature keeps the hardened ACL (${acl})`);
  assert(HALF.test(await def("thoughts_embedding_idx")) && HALF.test(await def("thought_chunks_embedding_idx")),
         `both indexes are HNSW over (embedding)::halfvec(${OPTS.dim}) with halfvec_cosine_ops, under their names`);
  assert((await oid("thoughts_embedding_halfvec_idx")) === null && (await oid("thought_chunks_embedding_halfvec_idx")) === null, "…and no staging index remains");
  const body = await bodyOf(SIX);
  const CAST = `embedding::halfvec(${OPTS.dim}) <=> query_embedding::halfvec(${OPTS.dim})`;
  assert(body.split(CAST).length - 1 === 4 && TID_PROBE.test(body) && /ob1:filter-inside-scan/.test(body),
         "…the body orders the four walk ORDER BYs by the cast on both sides and carries 038's gate and 014's sentinel");
  const [{ cfg, prorows }] = await sql`SELECT array_to_string(proconfig, ',') AS cfg, prorows FROM pg_proc WHERE oid = ${SIX}::regprocedure`;
  assert(/hnsw\.iterative_scan=relaxed_order/.test(String(cfg)) && /enable_seqscan=off/.test(String(cfg)) && Number(prorows) === 10, `…with 014's and 019's clauses carried (${cfg}; ROWS ${prorows})`);
  const plan = await sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET LOCAL enable_seqscan = off`);
    return (await tx.unsafe(`EXPLAIN SELECT id FROM thoughts ORDER BY ${CAST.replace("query_embedding", `'${queries[0]}'::vector`)} LIMIT 10`)).map((r: Record<string, string>) => Object.values(r)[0]).join(" ");
  });
  assert(/Index Scan using thoughts_embedding_idx/.test(plan), "…and the body's ORDER BY reaches the swapped index by its name");
  const overlapAfter = await overlap();
  assert(overlapAfter >= 0.9, `after 039 the unfiltered walk agrees with the exact top-10 on the same rows (overlap ${overlapAfter.toFixed(2)}, was ${overlapBefore.toFixed(2)})`);

  const oids = async () => JSON.stringify([await oid("thoughts_embedding_idx"), await oid("thought_chunks_embedding_idx")]);
  const kept = await oids();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  assert((await oids()) === kept, "re-applying 039 rebuilds nothing: both indexes keep their OIDs");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("001") });
  assert((await oids()) === kept && HALF.test(await def("thoughts_embedding_idx")), "001 re-applied by hand leaves it: CREATE INDEX IF NOT EXISTS finds the name");
  // The CONCURRENTLY path: a valid staging index built beforehand is adopted
  // (renamed, the same relation); an INVALID one — an interrupted concurrent
  // build — is dropped and a fresh one built.
  const stage = async () => {
    await sql.unsafe(`DROP INDEX thoughts_embedding_idx`);
    await sql.unsafe(`CREATE INDEX thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
    await sql.unsafe(`CREATE INDEX thoughts_embedding_halfvec_idx ON thoughts USING hnsw ((embedding::halfvec(${OPTS.dim})) halfvec_cosine_ops)`);
    return oid("thoughts_embedding_halfvec_idx");
  };
  const staged = await stage();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  assert((await oid("thoughts_embedding_idx")) === staged && (await oid("thoughts_embedding_halfvec_idx")) === null, "a valid staging index built by hand is adopted under the shipped name — the same relation");
  const invalid = await stage();
  await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('thoughts_embedding_halfvec_idx')`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  assert(HALF.test(await def("thoughts_embedding_idx")) && (await oid("thoughts_embedding_idx")) !== invalid && (await validOf("thoughts_embedding_idx")) === true, "an INVALID staging index is dropped and a fresh one built and renamed");
  assert((await overlap()) >= 0.9, "…and the walk still agrees with the exact answer over the rebuilt index");
  // An INVALID halfvec index under the SHIPPED name — a by-hand CREATE INDEX
  // CONCURRENTLY under that name, interrupted: the planner ignores it and
  // every walk seq-scans — is not "already done"; it is rebuilt (review pass 1).
  const broken = await oid("thoughts_embedding_idx");
  await sql.unsafe(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('thoughts_embedding_idx')`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  assert((await oid("thoughts_embedding_idx")) !== broken && (await validOf("thoughts_embedding_idx")) === true && HALF.test(await def("thoughts_embedding_idx")),
         "an INVALID halfvec index under the shipped name is rebuilt, not kept");
  // A valid index of another shape under the staging name is refused by
  // name, never renamed into place; dropped by hand, the re-run proceeds.
  await sql.unsafe(`DROP INDEX thoughts_embedding_idx`);
  await sql.unsafe(`CREATE INDEX thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
  await sql.unsafe(`CREATE INDEX thoughts_embedding_halfvec_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
  let refused = "";
  try {
    await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  } catch (e) {
    refused = (e as Error).message;
  }
  assert(/migration 039: thoughts_embedding_halfvec_idx exists but is not an HNSW index over \(embedding::halfvec\(8\)\)/.test(refused) && !HALF.test(await def("thoughts_embedding_idx")),
         `a staging index of another shape is refused by name and nothing is renamed (${refused.split("\n")[0] || "it was adopted"})`);
  await sql.unsafe(`DROP INDEX thoughts_embedding_halfvec_idx`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  assert(HALF.test(await def("thoughts_embedding_idx")) && (await oid("thoughts_embedding_halfvec_idx")) === null, "…dropped by hand, the re-run builds and swaps as on a fresh table");
  // A valid index under the SHIPPED name that names halfvec but is not this
  // shape — an IVFFlat over the cast — is refused, not taken for done.
  await sql.unsafe(`DROP INDEX thoughts_embedding_idx`);
  await sql.unsafe(`CREATE INDEX thoughts_embedding_idx ON thoughts USING ivfflat ((embedding::halfvec(${OPTS.dim})) halfvec_cosine_ops) WITH (lists = 1)`);
  refused = "";
  try {
    await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  } catch (e) {
    refused = (e as Error).message;
  }
  assert(/migration 039: thoughts_embedding_idx exists but is not an HNSW index over \(embedding::halfvec\(8\)\)/.test(refused) && /USING ivfflat/.test(await def("thoughts_embedding_idx")),
         `an IVFFlat index over the cast under the shipped name is refused by name (${refused.split("\n")[0] || "it was kept"})`);
  await sql.unsafe(`DROP INDEX thoughts_embedding_idx`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("039") });
  assert(HALF.test(await def("thoughts_embedding_idx")), "…dropped by hand, the re-run builds the HNSW index under the name");
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM ob1_upgrade_searcher38`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO PUBLIC`);
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_searcher38`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_searcher38`);
  await sql.close();
}

console.log("\n[18] Migration 040 onto a populated 039 — match_thoughts gains jit = off and nothing else: the body byte for byte 039's, no signature, row or privilege moves, and a hand-re-applied 014's 4-argument form is dropped as 020 dropped it (SMD-1624)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "040" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const SIX = "match_thoughts(vector, float, int, jsonb, float, float)";
  const bodyOf = async (sig: string) => (await sql`SELECT prosrc FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].prosrc as string;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");
  const settingsOf = async (sig: string) => String((await sql`SELECT array_to_string(proconfig, ',') AS c FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].c ?? "");
  const forms = async () => Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'match_thoughts'`)[0].c);
  const answer = async (kind: string) => JSON.stringify((await sql`SELECT id FROM match_thoughts(${vec(0)}::vector, -1.0, 10, ${{ kind }}::jsonb)`).map((r: { id: string }) => r.id).sort());

  // A corpus at 039 — thirty rows of two kinds, both filters under the exact
  // threshold and the table far under the gate's floor — and a hardened
  // 6-argument form.
  for (let i = 0; i < 30; i++) {
    await sql`SELECT upsert_thought(${`upgrade 040: note ${i}`}, ${{ metadata: { kind: i % 10 === 0 ? "rare" : "common" } }}::jsonb, ${vec(i % OPTS.dim)}::vector)`;
  }
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_searcher40') THEN CREATE ROLE ob1_upgrade_searcher40 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO ob1_upgrade_searcher40`);
  const acl = await aclOf(SIX);
  const before = await shape(sql);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  const rareBefore = await answer("rare");
  const commonBefore = await answer("common");
  const body039 = await bodyOf(SIX);
  const settings039 = await settingsOf(SIX);
  assert(TID_PROBE.test(body039) && /enable_seqscan=off/.test(settings039) && !/jit=off/.test(settings039) && (await forms()) === 1, `at 039 match_thoughts samples by TID range, carries 014's and 019's clauses and no jit clause (${settings039}), and has one form`);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("040") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "040 adds no column and changes no signature — one match_thoughts, as before");
  assert((await snapshot()) === rows, "no row moved — nothing here is a backfill");
  assert((await aclOf(SIX)) === acl && !/(^\{|,)=X\//.test(acl), `CREATE OR REPLACE under the same signature keeps the hardened ACL: PUBLIC still revoked, the role still granted (${acl})`);
  assert((await bodyOf(SIX)) === body039, "…the body is 039's byte for byte — 040 adds a SET clause and changes no statement");
  const [{ cfg, prorows }] = await sql`SELECT array_to_string(proconfig, ',') AS cfg, prorows FROM pg_proc WHERE oid = ${SIX}::regprocedure`;
  assert(/hnsw\.iterative_scan=relaxed_order/.test(String(cfg)) && /enable_seqscan=off/.test(String(cfg)) && /(^|,)jit=off(,|$)/.test(String(cfg)) && Number(prorows) === 10, `…with 014's and 019's clauses carried and jit = off beside them (${cfg}; ROWS ${prorows})`);
  assert((await answer("rare")) === rareBefore && (await answer("common")) === commonBefore, "…and both filters — 3 and 27 matching rows — return exactly the rows they returned at 039");

  // The state a hand re-apply of 014 leaves — the 4-argument form back beside
  // the 6-argument one, every 4-argument call ambiguous — and what the last
  // definer applied ALONE does about it, since that is what preflight's
  // remedy and the suites' restoreShipped apply: 040 carries 020's DROP.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("014") });
  assert((await forms()) === 2, "014 re-applied by hand puts the 4-argument form back beside 040's");
  let ambiguous = "";
  try {
    await sql`SELECT count(*) FROM match_thoughts(${vec(0)}::vector, 0.0, 10, '{}'::jsonb)`;
  } catch (e) {
    ambiguous = (e as Error).message;
  }
  assert(/not unique/.test(ambiguous), `…and a 4-argument call is ambiguous (${ambiguous.split("\n")[0] || "it succeeded"})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("040") });
  assert((await forms()) === 1 && (await aclOf(SIX)) === acl && (await bodyOf(SIX)) === body039 && /(^|,)jit=off(,|$)/.test(await settingsOf(SIX)),
         "re-applying 040 alone drops the 4-argument form again and leaves the 6-argument form's ACL, body and clauses as they were — the last definer restores the shipped state by itself");
  assert((await answer("rare")) === rareBefore, "…and the filtered call answers as before");
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM ob1_upgrade_searcher40`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO PUBLIC`);
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_searcher40`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_searcher40`);
  await sql.close();
}

console.log("\n[19] Migration 041 on a schema without 034 — refused up front, naming 034 and --reapply, and applied once the table exists (SMD-1749)");
{
  // A brain adopted with --baseline at a ledger through 041 whose schema stops
  // before 034 — a guide-built brain, or one baselined and never re-applied.
  // 041's two COMMENTs would fail bare there (relation "query_log" does not
  // exist), and a plain run — the compose stack's, gating the server — would
  // stop with no remedy named; the file opens with 031's guard instead.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "034" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-034 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the041 = MIGRATIONS.find((f) => f.startsWith("041_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the041}`;
  const plain = await migrate();
  const ok = plain.code === 1 && /041_query_log_tool_comment\.sql\s+FAILED: migration 041 needs 034 \(query_log\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 041 naming 034 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the041}`)[0].c) === 0, "…records nothing");
  // The guard is the only thing between the file and the table: with 034's
  // table in place the same pending file applies and both comments land.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("034") });
  const applied = await migrate();
  assert(applied.code === 0 && /041_query_log_tool_comment\.sql\s+applied/.test(applied.out), `…and once 034's table exists the plain run applies 041 (exit ${applied.code})${applied.code === 0 ? "" : `:\n${applied.out}`}`);
  const [{ c: col }] = (await sql.unsafe(COLUMN_COMMENT_SQL, ["query_log", "tool"])) as { c: string | null }[];
  const [{ c: tbl }] = (await sql.unsafe(TABLE_COMMENT_SQL, ["query_log"])) as { c: string | null }[];
  assert(/<writer>\/<pointer>/.test(col ?? "") && /<writer>\/<pointer>/.test(tbl ?? ""), "…and both live comments name <writer>/<pointer>");
  await sql.close();
  // The ledger records 035–040 already; applying them completes the schema
  // behind it, so this section leaves a full brain as every section before it
  // did, and [20] can start from it (second and fourth review passes).
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "035" });
}

console.log("\n[20] test-support's schema reset leaves nothing of the fork's in public — every table, function and type a migration creates is on its drop lists (SMD-1749)");
{
  // The reset drops a hand-kept list, and a name a migration added without a
  // line there survives every section boundary: 034's table did until [19]
  // built a schema "without 034" and found it standing, and three functions
  // (024, 025, 026) did until SMD-1749's second review pass listed the
  // survivors on a fully applied brain. So the catalog is asked here, after a
  // reset of a full brain, and the next omission fails in this section rather
  // than in whichever section happens to need the object gone. Members of an
  // extension (pgvector and pg_trgm install into public) are excepted — by
  // pg_depend's (classid, objid), the pair that names an object, not objid
  // alone (third review pass).
  //
  // The sweep is asked of itself first: five objects of the kinds the drop
  // lists do not cover — a standalone composite type, a partitioned table, an
  // enum, a domain, a function — are planted beside the fork's, and after the
  // reset each must be seen. A third pass found the first sweep blind to
  // exactly those: relkind 'c', 'p' and 'f' were outside its relation query,
  // and its type query excluded every composite, a table's row type and a
  // CREATE TYPE … AS alike. Then they are dropped by hand and the sweep must
  // come back empty. The brain is the full one [19] leaves.
  const sql = new SQL({ url: URL_, max: 1 });
  for (const ddl of [
    `CREATE TYPE ob1_probe_rowtype AS (a int)`,
    `CREATE TYPE ob1_probe_enum AS ENUM ('x')`,
    `CREATE DOMAIN ob1_probe_domain AS int`,
    `CREATE TABLE ob1_probe_part (k int) PARTITION BY RANGE (k)`,
    `CREATE FUNCTION ob1_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
  ]) await sql.unsafe(ddl);
  await dropSchema(URL_);
  const notExt = (catalog: string, oid: string) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`;
  // An extension's composite type records its membership on the TYPE, not on
  // the relation behind it, and a sequence behind an extension table's serial
  // column records only an 'a' dependency on that column — so a relation is an
  // extension's when it, its row type, or the table that owns it is (fourth
  // review pass; pgvector and pg_trgm ship neither today, so this is for the
  // next extension the test image gains).
  const notExtRel = `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.deptype = 'e' AND (
      (d.classid = 'pg_class'::regclass AND d.objid = c.oid)
      OR (d.classid = 'pg_type'::regclass AND d.objid = c.reltype)
      OR (d.classid = 'pg_class'::regclass AND d.objid = (SELECT a.refobjid FROM pg_depend a WHERE a.classid = 'pg_class'::regclass AND a.objid = c.oid AND a.deptype = 'a' LIMIT 1))))`;
  const sweep = async () => ({
    // Every relation kind: tables, partitioned and foreign tables, views,
    // materialized views, sequences, and the relation a standalone composite
    // type is backed by.
    rels: ((await sql.unsafe(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','f','v','m','S','c') AND ${notExtRel} ORDER BY 1`)) as { relname: string }[]).map((r) => r.relname),
    fns: ((await sql.unsafe(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND ${notExt("pg_proc", "p.oid")} ORDER BY 1`)) as { sig: string }[]).map((r) => r.sig),
    // The type kinds no relation backs: enums, domains, ranges, multiranges.
    types: ((await sql.unsafe(`SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e','d','r','m') AND ${notExt("pg_type", "t.oid")} ORDER BY 1`)) as { typname: string }[]).map((r) => r.typname),
  });
  const planted = await sweep();
  assert(planted.rels.includes("ob1_probe_rowtype") && planted.rels.includes("ob1_probe_part") && planted.fns.includes("ob1_probe_fn()") && planted.types.includes("ob1_probe_enum") && planted.types.includes("ob1_probe_domain"),
    `the sweep sees what the reset does not drop — a composite type, a partitioned table, a function, an enum and a domain planted beside the fork's objects (${[...planted.rels, ...planted.fns, ...planted.types].join(", ")})`);
  for (const ddl of [`DROP TABLE ob1_probe_part`, `DROP FUNCTION ob1_probe_fn()`, `DROP TYPE ob1_probe_rowtype`, `DROP TYPE ob1_probe_enum`, `DROP DOMAIN ob1_probe_domain`]) await sql.unsafe(ddl);
  const left = await sweep();
  assert(left.rels.length === 0, `no relation of the fork's survives the reset (${left.rels.join(", ") || "none"})`);
  assert(left.fns.length === 0, `no function of the fork's survives the reset (${left.fns.join(", ") || "none"})`);
  assert(left.types.length === 0, `no type of the fork's survives the reset (${left.types.join(", ") || "none"})`);
  await sql.close();
  await applyMigrations(URL_, OPTS);
}

report();
