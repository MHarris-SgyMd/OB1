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
 * CI runs this suite beside test-preflight.ts, each in its own database of one
 * Postgres, as the same role (SMD-2219), a Postgres the two have to themselves
 * while the data-layer job's other suites run (SMD-3195). What the cluster
 * shares — a role and its settings, pg_locks, pg_stat_activity — is scoped
 * here to the current database, or named for this suite (ob1_upgrade_*,
 * ob1_notemp, tu_*). [12] opens a session in `postgres` on purpose, to hold a
 * lock its count must not see.
 *
 *   ./with-postgres.sh bun test-upgrade.ts
 */

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_COMMENT_SQL, TABLE_COMMENT_SQL, TID_PROBE, applyMigrations, createAssert, dropSchema, ledgerStrangers, ledgerNames, loadChunkRows, migrationFiles, migratorEnv, plantLedger, plantLegacyRow, requireDatabaseUrl, resetSchema, runMigrator, runScript, seededRandom, updatedAtTriggerState } from "./test-support.ts";
import { ACCEPTED_CAVEAT_PREFIX, ACCEPTED_CLAIM_SQL, LOCK_TIMEOUT_S, UPDATE_THOUGHT_SIGNATURE, UPDATE_THOUGHT_SIGNATURE_9, UPDATE_THOUGHT_SIGNATURE_10, quoteIdent, reembedKey } from "./config.mjs";
import { sweepSubjects } from "./subject-sweep.ts";

/**
 * 032's update_thought, by its own signature — the form a brain holds from 032
 * through 044. UPDATE_THOUGHT_SIGNATURE names the shipped form, 046's
 * 10-argument one (SMD-1730), which the sections that stop at 032, 033 or 035
 * never have; they read this one, as [4] reads 021's.
 */
const UT_9 = UPDATE_THOUGHT_SIGNATURE_9;

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
 * The advisory locks held in this database. pg_locks is the cluster's, and CI
 * runs this suite beside test-preflight.ts, whose captures take the same locks
 * in a database of its own (SMD-2219).
 */
const advisoryLocksHere = async (sql: SQL) =>
  Number((await sql`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)[0].c);

/**
 * A session in another database, `postgres`, holding an advisory lock until
 * released — so a count that reads the cluster's locks fails here, not only
 * when a neighbour's capture happens to overlap it. Tried, not waited for: a
 * key some other session holds is a lock in another database all the same.
 * Null when this suite's database is `postgres` or the role may not connect
 * there; any other error fails the run.
 */
async function neighbourAdvisoryLock(sql: SQL): Promise<{ release: () => Promise<void> } | null> {
  const [{ db }] = (await sql`SELECT current_database() AS db`) as { db: string }[];
  if (db === "postgres") return null;
  const u = new URL(URL_);
  u.pathname = "/postgres";
  const other = new SQL({ url: u.toString(), max: 1 });
  try {
    await other`SELECT pg_try_advisory_lock(2219)`;
  } catch (e) {
    await other.close();
    if (/^(42501|3D000|55000|28)/.test((e as { errno?: string }).errno ?? "")) return null;
    throw e;
  }
  return { release: async () => { try { await other`SELECT pg_advisory_unlock(2219)`; } finally { await other.close(); } } };
}

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
  // [2] left the brain at 010. The rest applies once here FIRST — an apply, not
  // a re-apply, and one that writes: 050's backfill gives [2]'s two rows their
  // writers' marks through 008's trigger, one audit row each (SMD-1726). The
  // baseline is taken after it, so what follows compares a re-run to a brain
  // that has every migration, which is what "re-applying" means.
  await applyMigrations(URL_, OPTS);
  const before = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const agentsBefore = await sql`SELECT count(*)::int AS c FROM ob1_agents`;
  const marksBefore = await sql`SELECT id, metadata FROM thoughts ORDER BY id`;

  // Twice: 010 alone, then the whole set over the top. `bun migrate.ts` tracks
  // what it has applied, but test-support does not, and a migration that is not
  // idempotent breaks a re-run either way.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("010") });
  await applyMigrations(URL_, OPTS);
  assert(JSON.stringify(await sql`SELECT id, metadata FROM thoughts ORDER BY id`) === JSON.stringify(marksBefore), "050's backfill on a re-run finds every row agreeing with the log and writes nothing (SMD-1726)");

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

console.log("\n[7] --reapply onto a 020 under a ledger of every file — every migration in one transaction, 021's backfill with the acceptances out of its sight, and what the re-run refuses (SMD-1193, SMD-1421)");
{
  await dropSchema(URL_);
  // A ledger ahead of its schema: the schema as far as 020, applied bare, and a
  // ledger planted with every migration. reembed.ts refuses to run there and
  // names the remedy; this is the remedy.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "021" });
  await plantLedger(URL_);
  // The migrator's shell, for its runs below: the parent's without its OB1_*
  // variables, plus the suite's width and model (test-support's migratorEnv);
  // the bare apply above pinned the same chunk-context default, so the two
  // agree. reembed.ts --status takes the same shell.

  const sql = new SQL({ url: URL_, max: 1 });
  // The brain as it stood before this change: recorded through 029, so 030
  // is pending, and a PLAIN run — the compose stack's, which gates the server
  // on it — must not fail with a bare "does not exist".
  // 030 by name, not "the last file". The scenario deletes only 030 from the
  // ledger, so a plain run attempts only 030 — 031 (renew_claims, SMD-1023),
  // 032 (the provenance envelope, SMD-1323), 033 (the capture's fingerprint
  // lock, SMD-1043), 034 (the opt-in query log, SMD-1295), 035 (a
  // re-capture writes no provenance, SMD-1453), 036 (delete_thought's lock
  // order, SMD-1462), 037 (the routing count's gate, SMD-1463) and 038 (the
  // gate's sample by TID range, SMD-1526), 039 (the half-precision walk,
  // SMD-1501), 040 (jit off on the function, SMD-1624), 041 (its two planner
  // paths pinned, SMD-1677 and SMD-1703), 042 (the citations facet and
  // delete_thought's third argument, SMD-1712) and 043 (the cite shape stated
  // at the table, SMD-1749), 044 (the schema_version row, SMD-1804), 045
  // (the query_log column set — filter, arm and tier, SMD-1490), 046 (the
  // audit row's event shape, SMD-1730), 047 (the query_log.logged_at prune
  // index, SMD-1492), 048 (the first release's schema_version, 1.0.0 — the
  // cut's last migration, SMD-1804/SMD-1860), 049 (the three-value CHECK on
  // ob1_agent_keys.scope, SMD-1298), 050 (the writer's mark on the row,
  // SMD-1726), 051 (the second release's schema_version, 1.1.0), 052
  // (thought_changes, the read over the audit log, SMD-1296), 053
  // (thought_sources, the link facet kind and the structured-wins rule,
  // SMD-1867), 054 (resolve_agent's stale-only write, SMD-2090), 055 (the
  // capture event carries the payload — the content, a backdating writer's
  // created_at, an update's key move — 046's rules as functions, the payload
  // amendment and its backfill, SMD-2115), 056 (the entity name gate,
  // SMD-1935), 057 (the third release's schema_version, 1.2.0), 058
  // (node_state, the shared read of a thought's lifecycle and blockers,
  // SMD-2074), 059 (search_thoughts_current, the hybrid with settled and
  // superseded thoughts ranked below current ones, SMD-2255), 060 to 067
  // (append then project, SMD-2116; lineage, SMD-1731; the fourth release's
  // schema_version, 1.3.0; rebuild_derived, SMD-1732; the page store,
  // SMD-1812; the entity name gate's allowlist, SMD-2300; a derivation never
  // paired with its inputs, SMD-2292; the pass settling stale proposals,
  // SMD-2297), 068 (the node_state projection kept current on write,
  // SMD-2256), 071 (node_state's dependency columns keyed, the gate
  // stored, SMD-2267), 073 (the content's trust on the row, SMD-1724), 074
  // (min_trust on match_thoughts and the keyword arm, SMD-1724), 075
  // (min_trust on the hybrid and the current read, SMD-1724), 077 (the
  // current read by the tickets a thought names, SMD-2271), 079 (two
  // tickets Linear links never paired for judgement, SMD-2448), 080 (a
  // capture-only key's re-capture leaves the row, SMD-2539), 082 (a
  // capture-only key's pointer lapses when another takes its target,
  // SMD-2638), 084 (the judge's relations stored, SMD-1873), 085 (a
  // capture-only key's stamp yields to the first classified key that can read
  // at a higher trust, SMD-2664), 086 (the operator resets such a label,
  // SMD-2744), 087 (what the findings step posted to the board,
  // SMD-2681), 088 (update_thought answers what it did, SMD-2744), 089 (the
  // 1.8.0 cut's schema_version, SMD-1804), 090 (a re-capture says what it
  // did to a capture-only key's label, SMD-2898), 091 (each settle by the
  // pass kept on its proposal, SMD-2913), 092 (another key's pointer
  // takes a capture-only key's thought, SMD-2708), 093 (a long thought's
  // extraction windows kept, SMD-2694), 094 (a proposal's listing names
  // who wrote each side, SMD-2707), 095 (what the stated-status label
  // reads, SMD-2540), 096 (pg_stat_statements where the server offers
  // it, SMD-1849), 097 (one walk for 082's lapse, SMD-3035), 098 (the
  // stated-status label's read bounded, SMD-2540), 099 (an unlink
  // takes the review lock, SMD-3045), 100 (the thoughts with no vector
  // by an index of their own, SMD-3056), 101 (the sleep scheduler's
  // cuts counted apart from the stops, SMD-3060), 102 (the
  // consolidation judge's distinct stored, SMD-3117), 103 (the 1.9.0 cut's
  // schema_version, SMD-1804), 104 (the lapse locks its own tree,
  // SMD-3046), 105 (Linear's duplicate status type known and
  // settled, SMD-2935), 106 (the query log's literal arm, SMD-2891),
  // 107 (the listing caps the walks it runs, SMD-3036), 108 (a keyed
  // rebuild of 071's mirror for a status-set change, SMD-3160), 109
  // (the listing selects one pass's proposals, SMD-3248), 110 (the
  // listing pages, SMD-3249), 111 (a thought's own subject
  // recorded, SMD-3306), 112 (a thought's client_key, one thought
  // per key, SMD-3314), 113 (the subject pool, SMD-3306) and
  // 114 (who decided a proposal, SMD-2608)
  // stay recorded and
  // are never tried. 030 is the right one to make pending because its
  // prerequisites — 015 and 021's
  // embedding_model column — are
  // exactly what a through-020 schema lacks, so it fails by name rather than
  // with a bare error. The window guard trips whenever a migration lands past
  // 030, to force this note to be re-read (034 needs only 001/010; 035 needs
  // 016, 025, 032 and 033; 036 redefines delete_thought and needs only 009's
  // body and 029's supersession lock; 037 redefines 020's match_thoughts and
  // 038 037's; 039 redefines it again and swaps 001's and 007's two indexes,
  // which every schema has; 040 and 041 redefine it once more each, with SET
  // clauses only; 042 adds a table on 001's and redefines delete_thought on
  // 009's body and 036's lock key, all present; 043 comments 034's table and
  // column and needs only 034, refusing by name without it as 031 does without
  // 015 ([20]); 044 upserts ob1_config.schema_version and needs only 006's
  // table; 045 adds tier and arm to query_log and populates its filter, needing
  // only 034 and refusing by name without it as 043 does; 046 adds columns to
  // 008's thought_audit and 010's ob1_agents and redefines 025's trigger, 035's
  // two capture forms and 033's update_thought on their own bodies, all present
  // ([20b]); 047 adds a btree on 034's query_log.logged_at ([20c]); 048 upserts
  // ob1_config.schema_version for the 1.0.0 cut, needing only 006's table; 049
  // admits the capture scope on 010's ob1_agent_keys, refusing by name without
  // 010 ([20d]); 050 adds a BEFORE trigger to 001's thoughts and a backfill over
  // 008's thought_audit through 046's ob1_registry_kind, all present ([20e]);
  // 052 adds one read function over 008's table and 046's columns, refusing by
  // name without either ([20f]); 053 adds a table on 001's thoughts, two
  // indexes on 042's thought_facets and redefines 016's
  // record_thought_entities and 042's thought_facets_validate on their own
  // bodies, refusing by name without 016 or 042 ([20g]); 054 redefines 010's
  // resolve_agent on its own body, refusing by name without 010's table
  // ([20h]) or its last_used_at or scope (test-schema [49]); 055 redefines
  // 046's audit trigger, 046's refusal trigger and 050's stamp trigger on
  // their own bodies, adds functions and one partial index on 008's table,
  // refusing by name without 008, 046 or 050 ([20i]); 056 adds two functions
  // over 016's tables and redefines 053's record_thought_entities on its own
  // body, refusing by name without 016 or 053 ([20j]); 057 upserts
  // ob1_config.schema_version for the 1.2.0 cut, needing only 006's table;
  // 058 adds five read functions over 001's thoughts, 025's supersedes and
  // 053's tables and resolver, refusing by name without 025 or 053 ([20k]);
  // 059 adds two functions over 027's hybrid and 058's node_state and widens
  // 045's query_log.arm CHECK, refusing by name without 027, 058 or 045
  // ([20l]); 060 redefines the three write functions, 046's audit trigger
  // and 001's updated_at trigger on their own bodies, adds the projector,
  // the refresh and the vector snapshot with its trigger on 001's table,
  // refusing by name without 042, 050 or 055 ([20m]); 061 adds the lineage
  // table, its writer, the vector-lineage trigger and two drop triggers on
  // 001's and 029's tables, redefines the 3- and 4-argument upsert_thought,
  // update_thought (an eleventh argument), 056's record_thought_entities (a
  // seventh) and 029's record_supersession_proposal (an eleventh) on their
  // own bodies and backfills the table from the artifacts standing, refusing
  // by name without 013, 029, 056 or 060 ([20n]); 062 upserts
  // ob1_config.schema_version for the 1.3.0 cut, needing only 006's table;
  // 063 adds two columns to 061's table, widens 029's status CHECKs, adds
  // the lineage walk and rebuild_derived and redefines 061's writer, 029's
  // consolidation_candidates and 061's record_supersession_proposal on their
  // own bodies, refusing by name without 016, 029, 060 or 061 ([20o]); 064 adds the page
  // store's three tables (the first keyed to 001's thoughts), widens 061's
  // kind CHECK and redefines its writer on 063's body, and adds the store's
  // functions over 025's derived_from, 032's validator, 060's write functions
  // and 061's lineage, refusing by name without 025, 032, 060, 061 or 063
  // ([20p]); 065 redefines 056's entity_type_gate on its own body (the SMD-2300
  // good-shape allowlist) and re-runs apply_entity_type_gate over 016's tables,
  // refusing by name without 016 or 056 ([20q]); 066 redefines 029's
  // consolidation_candidates on 063's body
  // over 025's derived_from, refusing by name without 025, 029 or 063
  // ([20r]); 067 adds settle_supersession_proposal and redefines 063's
  // rebuild_derived on its own body, refusing by name without 036, 061 or
  // 063 ([20s]); 068 adds two tables, an index and four triggers on 001's
  // thoughts and redefines 058's node_lifecycle and node_state on their own
  // signatures, refusing by name without 025 or 058 ([20t]); 069 adds the
  // durable jobs table and prune_jobs, keyed to nothing prior — nothing to
  // refuse, so it applies cleanly under an older schema ([20u]); 070 redefines 029's
  // listing under a third argument with a lineage column, the two-argument
  // form dropped first, refusing by name without 016, 025 or 029 ([20v]); 071 adds a
  // table, an index and four triggers on 053's thought_sources and one on
  // 001's thoughts, and redefines 053's source_thought, 058's
  // node_dependencies and node_state and 068's drift on their own signatures,
  // refusing by name without 053 or 068
  // ([20w]); 072 upserts ob1_config.schema_version for the 1.4.0 cut, needing
  // only 006's table; 073 redefines 055's two stamp arms and 050's stamp
  // trigger and backfill, adds a third stamp form and the trust fold, and
  // redefines the 2- and 3-argument upsert_thought and update_thought on 060's
  // and 061's bodies, refusing by name without 061 ([20x]); 074 redefines
  // 041's match_thoughts and 019's search_thoughts_keyword on their own
  // bodies under a seventh and a fifth argument, the earlier forms dropped
  // and their privileges replayed, and adds an index on 001's thoughts over
  // a function of its own — nothing to refuse, a function body binds its
  // names at call time ([20y]); 075 adds an 8-argument search_thoughts_hybrid
  // and search_thoughts_current beside 027's and 068's and makes those two
  // call them, nothing to refuse either ([20z]); 076 upserts
  // ob1_config.schema_version for the 1.5.0 cut, needing only 006's table; 077
  // adds ticket_references and ticket_references_settled and redefines 075's
  // 8-argument search_thoughts_current on its own body, refusing by name
  // without 068 or 075 ([20aa]); 078 adds a column to 069's jobs, refusing by
  // name without 069 ([20ab]); 079 redefines 066's consolidation_candidates
  // on its own body and adds a predicate and a count beside it, refusing by
  // name without 025, 029, 053 or 063 ([20ac]); 080 redefines the three
  // upsert_thought forms on 073's and 061's bodies, refusing by name without
  // 060, 061 or 073 ([20ad]); 081 upserts ob1_config.schema_version for the
  // 1.6.0 cut, needing only 006's table; 082 adds the taking rule, its two
  // reads, the re-capture note and the lapse and write-time triggers on
  // 008's thought_audit, refusing by name without 060 or 061 ([20ae]); 083
  // upserts ob1_config.schema_version for the 1.7.0 cut, needing only 006's
  // table; 084 adds the relation facet kind, its write, the triggers on
  // thoughts and thought_facets and the lineage kind, refusing by name
  // without 042, 053, 061 or 064 ([20af]); 085 adds the restamp and
  // redefines 073's backfill_thought_actors on its own body, refusing by
  // name without 055, 060, 073 or 074 ([20ag]); 086 adds the reset and
  // redefines 085's restamp and backfill on their own bodies, refusing by
  // name without 046 or 085 ([20ah]); 087 adds a table and
  // needs nothing ([20ai]); 088 redefines 073's update_thought on
  // its own body, refusing by name without 073 ([20aj]); 089 upserts
  // ob1_config.schema_version for the 1.8.0 cut, needing only 006's table; 090 adds the
  // weighing that answers and redefines 086's restamp as a call of it,
  // refusing by name without 085 or 086 ([20ak]); 091 adds a column and
  // its trigger to 029's table, refusing by name without 067 ([20al]); 092
  // redefines 082's taken read, lapse and check and adds the chain, refusing
  // by name without 082 ([20am]); 093 adds a table and two functions over
  // 015's claims ([20an]); 094 adds the writers' read beside 070's listing,
  // refusing by name without 016, 025, 029, 082 or 092 ([20ao]); 095 adds one
  // read function and redefines 060's order over its own signature, refusing
  // by name without 068 or 060 ([20ap]); 096 creates pg_stat_statements
  // where the server offers it, needing nothing; 097 adds the lapse's walk
  // and redefines 092's lapse and 094's read as calls of it, refusing by
  // name without 092 or 094 ([20aq]); 098 redefines 095's read over its own
  // signature, refusing by name without 095 ([20ar]); 099 redefines 088's
  // update_thought, refusing by name without 073 ([20as]); 100 adds a partial index on
  // thoughts, needing nothing past 001; 101 adds a column and a function
  // to 093's table and redefines its two, refusing by name without 093
  // ([20at]); 102 redefines 084's validator and record_thought_relation on
  // their own bodies, refusing by name without 084 ([20au]); 103 upserts
  // ob1_config.schema_version for the 1.9.0 cut, needing only 006's table;
  // 104 adds the lapse's tree and redefines 097's walk over it and its
  // trigger to lock it, refusing by name without 097 ([20av]); 105 redefines 058's two status sets and rebuilds 071's mirror,
  // refusing by name without 058 or 071 ([20aw]); 106 widens 059's query_log arm check, refusing by name
  // without 034 or 045 ([20ax]); 107 adds
  // the listing's cap and redefines 094's listing behind it, refusing by
  // name without 094 ([20ay]); 108 adds the mirror's keyed rebuild,
  // refusing by name without 071 ([20az]); 109 redefines 070's listing
  // under a fourth argument, refusing by name without 016, 025 or 029
  // ([20ba]); 110 redefines it under the after-cursor's three, refusing
  // by name without the same ([20bb]); 111 adds the subject facet kind, its
  // key's shape, its write, two indexes, a drop trigger and the lineage
  // kind, and redefines 102's validator and 084's lineage writer on their
  // own bodies, refusing by name without 016, 042, 061, 084 or 102
  // ([20bc]); 112 adds a unique partial index on thoughts' client_key,
  // refusing by name rows that share one ([20bd]); 113 adds the subject
  // pool's trigger on thoughts and a close of the subject read, refusing by
  // name without 015, 016 or 111 ([20be]); 114 adds the reviewer
  // columns, their trigger and two CHECKs, refusing by name without 008,
  // 029, 046 or 050 ([20bf]) — all
  // recorded by the
  // planted ledger with their
  // prerequisites present, so none becomes the plain-run failure point
  // above).
  const last = MIGRATIONS.find((f) => f.startsWith("030_"))!;
  assert(last !== undefined && MIGRATIONS.indexOf(last) >= MIGRATIONS.length - 85, `030 is among the last eighty-five migrations (${last}) — a migration landed past the window: extend the enumeration above and move this guard`);
  await sql`DELETE FROM schema_migrations WHERE name = ${last}`;
  const plainRun = await migrate();
  const plainOk = plainRun.code === 1 && /030_label_from_claims_excludes_accepted\.sql\s+FAILED: migration 030 needs 015 \(thought_work_claims\) and 021 \(thoughts\.embedding_model\); this schema lacks thoughts\.embedding_model/.test(plainRun.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plainRun.out);
  assert(plainOk, `a plain run on the brain whose ledger is ahead fails at 030 naming what is missing and --reapply, not with a bare error (exit ${plainRun.code})${plainOk ? "" : `:\n${plainRun.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${last}`)[0].c) === 0, "…and records nothing");
  const { vec, KEY, plant, enqueue, accept, labels, corpus } = evidenceFixture(sql);
  const { vouched, accepted, earlierThenAccepted } = await corpus();
  const noEvidence = await plant("nothing ever re-embedded this");
  const column = async () => Number((await sql`SELECT count(*)::int AS c FROM information_schema.columns WHERE table_name = 'thoughts' AND column_name = 'embedding_model'`)[0].c);
  assert((await column()) === 0, "the schema stands at 020 — no embedding_model column — whatever the ledger says");

  // What the operator reads first. --status runs against any schema and says
  // what a run would refuse on; the ledgered remedy is the migrator's command.
  // Its colour codes stripped: a shell with FORCE_COLOR set (MIGRATOR_ENV
  // keeps it) ends the refusal with a reset after --reapply, where the regex
  // anchors the line's end (SMD-2219).
  const statusRun = await runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_, "--status"], { env: MIGRATOR_ENV, cwd: HERE });
  const status = { ...statusRun, out: statusRun.out.replace(/\x1b\[[0-9;]*m/g, "") };
  const recorded021 = async () => Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name LIKE '021%'`)[0].c);
  const ledger = async () => JSON.stringify(await sql`SELECT name, sha256, applied_at::text AS a FROM schema_migrations ORDER BY 1`);
  assert(status.code === 0 && /a run would refuse: the schema predates migration 021/.test(status.out) &&
           /schema_migrations records 021 as\n\s+applied but the schema installed is older\. Re-apply the recorded migrations with the migrator/.test(status.out) &&
           /cd db && bun migrate\.ts --url … --reapply\s*$/m.test(status.out) && !/re-run the body/.test(status.out),
         `reembed.ts --status on the brain whose ledger is ahead names \`migrate.ts --reapply\`, not a paste (exit ${status.code})`);

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
           /061 backfills the lineage table from the proposals, the mentions and edges, the chunks and the vectors \(reads; ON CONFLICT DO NOTHING on a re-apply\)\./.test(run.out) &&
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
  assert(forms.length === 1 && Number(forms[0].n) === 11, `the eleven-argument update_thought, alone — 032 ran after 021 and dropped 021's, 046 after 033 and dropped its, 061 after 060 and dropped its (${forms.map((f) => f.n).join(",")})`);
  const body3 = (await sql`SELECT prosrc FROM pg_proc WHERE oid = 'upsert_thought(text, jsonb, vector)'::regprocedure`)[0].prosrc as string;
  assert(/ob1:vector-replaces-chunks/.test(body3) && /derived_from/.test(body3), "the 3-argument upsert_thought is the LAST definer's body (022's sentinel, 025's provenance), not 021's");

  // Refused, nothing written: a value beside the flag (the old shape, or a
  // typo); a flag the runner does not have; the retired --baseline beside it; a recorded
  // file changed since it was applied — before anything runs.
  const value = await migrate("--reapply", "021");
  assert(value.code === 2 && /unknown argument 4: a value where no flag takes one/.test(value.out), `--reapply takes no value; one beside it is refused, not dropped (exit ${value.code})`);
  const typo = await migrate("--reapply=021");
  assert(typo.code === 2 && /argument 3 gives --reapply a value with "=", and --reapply takes none/.test(typo.out), `a flag the runner does not have is refused, not a silent plain run (exit ${typo.code})`);
  const joined = await migrate("--url=postgres://u:s3cret@h/d");
  assert(joined.code === 2 && /argument 3 joins a value to --url with "="/.test(joined.out) && !/s3cret/.test(joined.out), `a value joined with "=" is refused without echoing it — a URL carries a password (exit ${joined.code})`);
  const both = await migrate("--reapply", "--baseline");
  assert(both.code === 2 && /--baseline was retired \(SMD-3325\)/.test(both.out), `--reapply beside the retired --baseline is refused (exit ${both.code})`);
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
  // A brain with a ledger planted through 031 whose schema stops
  // before 015. 031's CREATE FUNCTION would succeed there (plpgsql resolves
  // the table at first run) and its column COMMENT would fail bare; the file
  // opens with 030's guard instead, so a plain run — the compose stack's,
  // gating the server — fails naming what is missing and the remedy.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "015" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the031 = MIGRATIONS.find((f) => f.startsWith("031_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the031}`;
  const plain = await migrate();
  const ok = plain.code === 1 && /031_renew_claims\.sql\s+FAILED: migration 031 needs 015 \(thought_work_claims\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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

  assert(JSON.stringify(await forms()) === "[9]" && (await sql`SELECT to_regprocedure(${UT_9}) IS NOT NULL AS p`)[0].p === true,
         `after 032 one update_thought, of nine arguments, at 032's signature (${(await forms()).join(",")})`);
  assert((await snapshot()) === before, "no row moved: supersedes, derived_from and updated_at as they were");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore), "…and no audit row was written");
  const acl = String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${UT_9}::regprocedure`)[0].a ?? "");
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
  const again = String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${UT_9}::regprocedure`)[0].a ?? "");
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

  // The column absent and 030 recorded — a planted ledger with a hole at
  // 021: the block labels from the plain rows alone, the suffixed-key
  // acceptance out of its sight like the own-key ones.
  let b = await build();
  await plantLedger(URL_);
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
  await plantLedger(URL_);
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
  const edit032 = await bodyOf(UT_9);
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
  assert((await bodyOf(TWO)).includes(LOCK) && (await bodyOf(THREE)).includes(LOCK) && (await bodyOf(UT_9)).includes(LOCK), "both capture bodies spell the fingerprint lock as update_thought does");
  const edit = await bodyOf(UT_9);
  assert(Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'update_thought'`)[0].c) === 1 && edit.indexOf(LOCK) < edit.indexOf("FROM thoughts WHERE id = p_id FOR NO KEY UPDATE") && /ob1:unchanged-edit-not-duplicate/.test(edit),
         "…and update_thought, one function still, takes the fingerprint lock before its row read, 018's sentinel kept");
  assert(/ob1:vector-replaces-chunks/.test(await bodyOf(THREE)) && /p_payload->'derived_from'/.test(await bodyOf(THREE)) && /validate_derived_from\(/.test(await bodyOf(THREE)), "…the 3-argument body carrying 022's sentinel and 025's envelope, through 032's validate_derived_from");

  // The mirror: the paths a brain uses the day after. A same-model
  // re-capture keeps the window (022's rule, unchanged); a re-capture naming
  // provenance the row already has leaves it (025, unchanged); the 2-argument
  // form resolves and, since 033, attributes; and no lock outlives a call in
  // this database, counted while another database holds one.
  await sql`SELECT upsert_thought(${TEXT}, ${{ metadata: { k: 1 }, embedding_model: OPTS.model, supersedes: id }}::jsonb, ${vec(3)}::vector)`;
  const [row] = await sql`SELECT supersedes AS s, (metadata->>'k')::int AS k FROM thoughts WHERE id = ${id}::uuid`;
  assert((await windows()) === 1 && row.s === older && row.k === 1, "after 033 a same-model re-capture keeps the window and the pointer it already had, merging the metadata");
  const [{ r: twoR }] = await sql`SELECT upsert_thought('a two-argument capture at 033', '{"metadata":{},"actor":{"name":"after","source":"test"}}'::jsonb) AS r`;
  const [{ a: attributed }] = await sql`SELECT actor_name AS a FROM thought_audit WHERE action = 'capture' AND thought_id = ${(twoR as { id: string }).id}::uuid`;
  assert(attributed === "after", `…a capture through the 2-argument form resolves and is attributed (${attributed})`);
  const neighbour = await neighbourAdvisoryLock(sql);
  try {
    assert((await advisoryLocksHere(sql)) === 0, `…and no advisory lock is held once the calls return (${neighbour ? "counted while another database holds one" : "no lock could be planted in another database"})`);
  } finally {
    await neighbour?.release();
  }

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
  const editBefore = await bodyOf(UT_9);
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
  assert((await bodyOf(UT_9)) === editBefore && Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'update_thought'`)[0].c) === 1, "…and update_thought is untouched: one function, 033's body byte for byte");

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
  assert((await advisoryLocksHere(sql)) === 0, "…and no advisory lock is held once the calls return");

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

console.log("\n[19] Migration 041 onto a populated 040 — match_thoughts gains enable_nestloop = on and enable_tidscan = on and nothing else: the body byte for byte 040's (039's), no signature, row or privilege moves, and a hand-re-applied 014's 4-argument form is dropped as 020 dropped it (SMD-1677, SMD-1703)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "041" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const SIX = "match_thoughts(vector, float, int, jsonb, float, float)";
  const bodyOf = async (sig: string) => (await sql`SELECT prosrc FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].prosrc as string;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");
  const settingsOf = async (sig: string) => String((await sql`SELECT array_to_string(proconfig, ',') AS c FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].c ?? "");
  const forms = async () => Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'match_thoughts'`)[0].c);
  const answer = async (kind: string) => JSON.stringify((await sql`SELECT id FROM match_thoughts(${vec(0)}::vector, -1.0, 10, ${{ kind }}::jsonb)`).map((r: { id: string }) => r.id).sort());

  // A corpus at 040 — thirty rows of two kinds, both filters under the exact
  // threshold and the table far under the gate's floor — and a hardened
  // 6-argument form.
  for (let i = 0; i < 30; i++) {
    await sql`SELECT upsert_thought(${`upgrade 041: note ${i}`}, ${{ metadata: { kind: i % 10 === 0 ? "rare" : "common" } }}::jsonb, ${vec(i % OPTS.dim)}::vector)`;
  }
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_searcher41') THEN CREATE ROLE ob1_upgrade_searcher41 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO ob1_upgrade_searcher41`);
  const acl = await aclOf(SIX);
  const before = await shape(sql);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  const rareBefore = await answer("rare");
  const commonBefore = await answer("common");
  const body040 = await bodyOf(SIX);
  const settings040 = await settingsOf(SIX);
  assert(TID_PROBE.test(body040) && /enable_seqscan=off/.test(settings040) && /(^|,)jit=off(,|$)/.test(settings040) && !/enable_nestloop/.test(settings040) && !/enable_tidscan/.test(settings040) && (await forms()) === 1, `at 040 match_thoughts samples by TID range, carries 014's, 019's and 040's clauses and no pinned path (${settings040}), and has one form`);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("041") });

  const after = await shape(sql);
  assert(before.columns === after.columns && before.functions === after.functions, "041 adds no column and changes no signature — one match_thoughts, as before");
  assert((await snapshot()) === rows, "no row moved — nothing here is a backfill");
  assert((await aclOf(SIX)) === acl && !/(^\{|,)=X\//.test(acl), `CREATE OR REPLACE under the same signature keeps the hardened ACL: PUBLIC still revoked, the role still granted (${acl})`);
  assert((await bodyOf(SIX)) === body040, "…the body is 040's byte for byte — 041 adds two SET clauses and changes no statement");
  const [{ cfg, prorows }] = await sql`SELECT array_to_string(proconfig, ',') AS cfg, prorows FROM pg_proc WHERE oid = ${SIX}::regprocedure`;
  assert(/hnsw\.iterative_scan=relaxed_order/.test(String(cfg)) && /enable_seqscan=off/.test(String(cfg)) && /(^|,)jit=off(,|$)/.test(String(cfg)) && /(^|,)enable_nestloop=on(,|$)/.test(String(cfg)) && /(^|,)enable_tidscan=on(,|$)/.test(String(cfg)) && Number(prorows) === 10, `…with 014's, 019's and 040's clauses carried and the two pins beside them (${cfg}; ROWS ${prorows})`);
  assert((await answer("rare")) === rareBefore && (await answer("common")) === commonBefore, "…and both filters — 3 and 27 matching rows — return exactly the rows they returned at 040");

  // The state a hand re-apply of 014 leaves — the 4-argument form back beside
  // the 6-argument one, every 4-argument call ambiguous — and what the last
  // definer applied ALONE does about it, since that is what preflight's
  // remedy and the suites' restoreShipped apply: 041 carries 020's DROP.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("014") });
  assert((await forms()) === 2, "014 re-applied by hand puts the 4-argument form back beside 041's");
  let ambiguous = "";
  try {
    await sql`SELECT count(*) FROM match_thoughts(${vec(0)}::vector, 0.0, 10, '{}'::jsonb)`;
  } catch (e) {
    ambiguous = (e as Error).message;
  }
  assert(/not unique/.test(ambiguous), `…and a 4-argument call is ambiguous (${ambiguous.split("\n")[0] || "it succeeded"})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("041") });
  assert((await forms()) === 1 && (await aclOf(SIX)) === acl && (await bodyOf(SIX)) === body040 && /(^|,)jit=off(,|$)/.test(await settingsOf(SIX)) && /(^|,)enable_nestloop=on(,|$)/.test(await settingsOf(SIX)) && /(^|,)enable_tidscan=on(,|$)/.test(await settingsOf(SIX)),
         "re-applying 041 alone drops the 4-argument form again and leaves the 6-argument form's ACL, body and clauses as they were — the last definer restores the shipped state by itself");
  assert((await answer("rare")) === rareBefore, "…and the filtered call answers as before");
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIX} FROM ob1_upgrade_searcher41`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIX} TO PUBLIC`);
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_searcher41`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_searcher41`);
  await sql.close();
}

console.log("\n[20] Migration 043 on a schema without 034 — refused up front, naming 034 and --reapply, and applied once the table exists (SMD-1749)");
{
  // A brain with a ledger planted through 043 whose schema stops before 034:
  // a ledger ahead of its schema, damaged from outside.
  // 043's two COMMENTs would fail bare there (relation "query_log" does not
  // exist), and a plain run — the compose stack's, gating the server — would
  // stop with no remedy named; the file opens with 031's guard instead.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "034" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the043 = MIGRATIONS.find((f) => f.startsWith("043_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the043}`;
  const plain = await migrate();
  const ok = plain.code === 1 && /043_query_log_tool_comment\.sql\s+FAILED: migration 043 needs 034 \(query_log\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 043 naming 034 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the043}`)[0].c) === 0, "…records nothing");
  // The guard is the only thing between the file and the table: with 034's
  // table in place the same pending file applies and both comments land.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("034") });
  const applied = await migrate();
  assert(applied.code === 0 && /043_query_log_tool_comment\.sql\s+applied/.test(applied.out), `…and once 034's table exists the plain run applies 043 (exit ${applied.code})${applied.code === 0 ? "" : `:\n${applied.out}`}`);
  const [{ c: col }] = (await sql.unsafe(COLUMN_COMMENT_SQL, ["query_log", "tool"])) as { c: string | null }[];
  const [{ c: tbl }] = (await sql.unsafe(TABLE_COMMENT_SQL, ["query_log"])) as { c: string | null }[];
  assert(/<writer>\/<pointer>/.test(col ?? "") && /<writer>\/<pointer>/.test(tbl ?? ""), "…and both live comments name <writer>/<pointer>");
  await sql.close();
  // The ledger records 035–043 already; applying them completes the schema
  // behind it, so this section leaves a full brain as every section before it
  // did, and [21] can start from it (second and fourth review passes). Bounded
  // at the file under test, which the migrator has just applied and recorded:
  // an open-ended `>= "035"` re-applied it bare a second time (fifth pass).
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "035" && f < the043 });
}

console.log("\n[20b] Migration 046 onto a populated 044 — the audit row gains the event shape, the door moves from the blob to a column on rows already written, the append-only rule holds after the ALTER, update_thought's tenth argument crosses with its ACL, and no thought or audit row moves (SMD-1730)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "046" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const aclOf = async (sig: string) => String((await sql`SELECT proacl::text AS a FROM pg_proc WHERE oid = ${sig}::regprocedure`)[0].a ?? "");
  const cols = async (table: string) => (await sql`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY 1`).map((r: { c: string }) => r.c);
  type Ev = { actor_name: string | null; source: string | null; actor_context: Record<string, unknown> | null; actor_kind?: string | null; trust?: string | null; origin?: string | null; stance?: string | null; backfilled_at?: string | null };
  // The row as whichever schema holds it: every column, read by name at call
  // time, so the same helper serves before and after the ALTER.
  const rowOf = async (id: string) => (await sql.unsafe(`SELECT ${(await cols("thought_audit")).join(", ")} FROM thought_audit WHERE thought_id = '${id}' AND action = 'capture'`))[0] as Ev;

  // A corpus at 044: a key resolved through 010; a write through a SMD-1541
  // server — the door in the blob — and one through the main server as it
  // was, its actor naming `source: "mcp"`; and a hardened 9-argument
  // update_thought.
  const laptop = (await sql`SELECT resolve_agent(${"a".repeat(64)}, 'laptop', 'write') AS r`)[0].r as { agent_id: string };
  const viaRow = (await sql`SELECT upsert_thought('upgrade 046: through a vendored door', ${{ metadata: { source: "planted" }, actor: { name: "MCP_ACCESS_KEY", via: "rest-api" } }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  const mcpRow = (await sql`SELECT upsert_thought('upgrade 046: through the main server as it was', ${{ metadata: { source: "mcp" }, actor: { name: "laptop", agent_id: laptop.agent_id, source: "mcp" } }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string };
  let ev = await rowOf(viaRow.id);
  assert(ev.actor_context?.via === "rest-api" && ev.source === "planted" && !("origin" in ev), "at 044 the door rides in actor_context.via and there is no origin column");
  ev = await rowOf(mcpRow.id);
  assert(ev.source === "mcp" && ev.actor_context === null, "…and an actor's source is written into the column over the row's own");
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_editor45') THEN CREATE ROLE ob1_upgrade_editor45 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${UT_9} FROM PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${UT_9} TO ob1_upgrade_editor45`);
  // A capturing role as 044 granted it — INSERT on thought_audit, nothing on
  // ob1_agents — is NOT granted the SELECT by the apply: that is --grant's, by
  // the convention every privilege has landed under, and preflight names it.
  // Asserted so a later hand does not put an in-file grant back (ninth
  // review pass cut one after three passes of catalog edges).
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_capturer45') THEN CREATE ROLE ob1_upgrade_capturer45 NOLOGIN; END IF; END $r$`);
  await sql.unsafe(`GRANT INSERT ON thought_audit TO ob1_upgrade_capturer45`);
  const readsAgents = async () => (await sql`SELECT has_table_privilege('ob1_upgrade_capturer45', 'ob1_agents', 'SELECT') AS p`)[0].p as boolean;
  assert((await readsAgents()) === false, "at 044 a capturing role holds no SELECT on ob1_agents — the audit trigger did not read it");
  const acl9 = await aclOf(UT_9);
  const snapshot = async () => JSON.stringify(await sql`SELECT id, content_fingerprint, metadata, embedding_model, updated_at::text AS u FROM thoughts ORDER BY id`);
  const rows = await snapshot();
  // 008's and 010's columns on every audit row, byte for byte.
  const auditSnapshot = async () => JSON.stringify(await sql`SELECT thought_id, action, source, actor_name, canonical_agent_id, author_session_id, diff, actor_context, created_at::text AS t FROM thought_audit ORDER BY created_at, thought_id`);
  const auditRows = await auditSnapshot();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const before = await cols("thought_audit");
  assert(!before.includes("actor_kind") && !(await cols("ob1_agents")).includes("kind"), "…no actor_kind on thought_audit, no kind on ob1_agents");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("046") });

  const after = await cols("thought_audit");
  assert(after.length === before.length + 8 && ["actor_kind", "trust", "origin", "stance", "cites", "valid_from", "valid_until", "backfilled_at"].every((c) => after.includes(c)) && (await cols("ob1_agents")).includes("kind"),
    "046 adds eight columns to thought_audit and kind to ob1_agents, each exactly once");
  assert((await snapshot()) === rows, "no thought moved");
  assert((await auditSnapshot()) === auditRows && Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === Number(auditBefore), "…no audit row was added, and 008's and 010's columns on every existing row are byte for byte what they were");
  assert((await readsAgents()) === false, "…and 046 grants it to nobody: the SELECT on ob1_agents its trigger needs is ROLE_GRANTS' row since 046, --grant's to issue and preflight's to name (ninth review pass)");
  ev = await rowOf(viaRow.id);
  assert(ev.origin === "rest-api" && ev.backfilled_at != null && ev.actor_context?.via === "rest-api" && ev.actor_kind === null && ev.trust === null,
    `the file's own backfill call gives the SMD-1541 row its origin from the blob, stamped — the blob untouched, no kind: nobody has classified MCP_ACCESS_KEY (${ev.origin}, ${ev.backfilled_at})`);
  ev = await rowOf(mcpRow.id);
  assert(ev.origin === null && ev.backfilled_at == null && ev.source === "mcp" && ev.actor_kind === null, "…the main server's row names no door and is left as it was: source mcp, nothing derived, nothing stamped");
  let refused = "";
  try { await sql`UPDATE thought_audit SET action = 'update' WHERE thought_id = ${viaRow.id}::uuid`; } catch (e) { refused = (e as Error).message; }
  assert(/append-only/i.test(refused), "the append-only trigger still refuses UPDATE after the ALTER (010's lesson, [2])");
  const forms = await sql`SELECT p.pronargs AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE p.proname = 'update_thought' AND ns.nspname = 'public'`;
  assert(forms.length === 1 && Number(forms[0].n) === 10, `one update_thought, of ten arguments — the 9-argument form dropped (${forms.map((f: { n: number }) => f.n).join(", ")})`);
  // 046's form is the 10-argument one — UPDATE_THOUGHT_SIGNATURE names 061's
  // eleven, which this brain, at 046, does not have (SMD-1731).
  const acl10 = await aclOf(UPDATE_THOUGHT_SIGNATURE_10);
  assert(acl10 === acl9 && !/(^\{|,)=X\//.test(acl10) && /ob1_upgrade_editor45=X\//.test(acl10), `the 9-argument form's ACL crosses the DROP onto the 10-argument one: PUBLIC still revoked, the role still granted (${acl10})`);
  const nine = (await sql`SELECT update_thought(${mcpRow.id}::uuid, NULL, ${{ k: 1 }}::jsonb, NULL, NULL, NULL, ${{ name: "laptop", agent_id: laptop.agent_id }}::jsonb, NULL, NULL) AS r`)[0].r as { ok: boolean };
  assert(nine.ok === true, "a 9-argument call — every caller before this change — still resolves, through the default");

  // The mirror: the day after. A key classified, a write through it stamps
  // the kind; the backfill called again classifies the rows already written.
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const fresh = (await sql`SELECT upsert_thought('upgrade 046: a note captured after', ${{ metadata: { source: "mcp" }, actor: { name: "laptop", agent_id: laptop.agent_id, via: "open-brain" }, event: { stance: "stated" } }}::jsonb, ${vec(2)}::vector) AS r`)[0].r as { id: string };
  ev = await rowOf(fresh.id);
  assert(ev.actor_kind === "operator" && ev.trust === "operator" && ev.origin === "open-brain" && ev.actor_context === null && ev.backfilled_at == null && ev.stance === "stated",
    "after 046 a write through a classified key stamps its kind, trust and door, and the event");
  // Two passes at once — the capture and the edit are the two rows to fill: A
  // takes one and holds its transaction open; B, started meanwhile, waits on
  // that row's lock, and when A commits re-reads it as filled and skips it
  // (READ COMMITTED; the UPDATE's WHERE is re-evaluated on the locked row), so
  // B fills the other row only and counts one — not two, and A's stamp is not
  // written over (run-it, first review pass: the first UPDATE re-stamped and
  // re-counted every row the other pass had filled).
  const passA = new SQL({ url: URL_, max: 1 });
  await passA`BEGIN`;
  const bfA = (await passA`SELECT backfill_thought_audit_events(1) AS r`)[0].r as { rows: number };
  const bPid = Number((await sql`SELECT pg_backend_pid() AS p`)[0].p);
  // .execute(): Bun runs a query when it is awaited, not when it is written — the
  // first form of this arm never had B in flight before A committed.
  const pendingB = sql`SELECT backfill_thought_audit_events() AS r`.execute();
  // B must actually be waiting on A's lock before A commits, or the arm proves
  // nothing about the re-evaluated WHERE (third review pass: a sleep alone
  // passed the same assertions when B simply ran after A). Watched from A's
  // own connection, the section's only other connection being B's. Each poll
  // clears A's view first: inside an open transaction Postgres keeps the
  // sessions and their query text as first read, only the wait columns live.
  // B's session is in A's view already, so this poll sees B's wait either
  // way; the clear keeps it from depending on that (SMD-2742).
  let waited = false;
  for (let i = 0; i < 100 && !waited; i++) {
    await passA`SELECT pg_stat_clear_snapshot()`;
    const [w] = await passA`SELECT wait_event_type AS t FROM pg_stat_activity WHERE pid = ${bPid}`;
    waited = w?.t === "Lock";
    if (!waited) await new Promise((r) => setTimeout(r, 50));
  }
  await passA`COMMIT`;
  await passA.close();
  const bf = (await pendingB)[0].r as { rows: number; awaiting_kind: number };
  ev = await rowOf(mcpRow.id);
  const stamps = (await sql`SELECT count(DISTINCT backfilled_at)::int AS c FROM thought_audit WHERE thought_id = ${mcpRow.id}::uuid AND backfilled_at IS NOT NULL`)[0].c as number;
  assert(waited, "the second pass was seen waiting on the first's row lock before the first committed — the state the re-evaluated WHERE exists for");
  assert(bfA.rows === 1 && bf.rows === 1 && Number(stamps) === 2 && ev.actor_kind === "operator" && ev.trust === "operator" && ev.backfilled_at != null && ev.source === "mcp",
    `…and the backfill classifies the rows written before — the capture and the edit — by their agent id, stamped; two passes at once fill one row each and neither re-stamps the other's (${bfA.rows} + ${bf.rows}, ${stamps} stamp(s)); the source stays what 044 wrote`);
  assert(bf.awaiting_kind === 1, `…leaving the SMD-1541 row waiting on a kind for MCP_ACCESS_KEY (${bf.awaiting_kind})`);

  const shapeAfter = await shape(sql);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("046") });
  assert(JSON.stringify(await shape(sql)) === JSON.stringify(shapeAfter) && (await aclOf(UPDATE_THOUGHT_SIGNATURE_10)) === acl10 && ((await sql`SELECT backfill_thought_audit_events() AS r`)[0].r as { rows: number }).rows === 0,
    "re-applying 046 is a no-op: the shape and the ACL as they were, the backfill finds nothing");
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_editor45`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_editor45`);
  await sql.unsafe(`DROP OWNED BY ob1_upgrade_capturer45`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_capturer45`);
  await sql.close();
}

console.log("\n[20c] Migration 047 on a schema without 034 — refused up front, naming 034 and --reapply, and applied once the table exists (SMD-1492)");
{
  // 047's guard is 043's ([20]) verbatim: on a brain with a ledger planted through
  // 047 whose schema stops before 034, its CREATE INDEX would fail bare (relation
  // "query_log" does not exist), and a plain run — the compose stack's, gating the
  // server — would stop with no remedy named. [20] drives 043's guard and [20b]
  // 046's; 045 and 047 carry the same guard but had no driver, so a typo in 047's
  // refusal message or a guard that failed to fire went uncaught. This drives it.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "034" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the047 = MIGRATIONS.find((f) => f.startsWith("047_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the047}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /047_query_log_logged_at_index\.sql\s+FAILED: migration 047 needs 034 \(query_log\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 047 naming 034 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the047}`)[0].c) === 0, "…047 records nothing");
  // The guard is the only thing between the file and the table: with 034..046 in
  // place the same pending file applies — the heading's second half, asserted
  // (the apply throwing was its only check before SMD-1726's boyscout pass).
  // [20e] drops and rebuilds its own brain later, so this is the file's own
  // mirror, not [21]'s fixture.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "034" });
  assert((await sql`SELECT 1 FROM pg_indexes WHERE tablename = 'query_log' AND indexname = 'query_log_logged_at_idx'`).length === 1,
    "…and applied once the table exists: 047's index is on query_log");
  await sql.close();
}

console.log("\n[20d] Migration 049 on a schema without 010 — refused up front, naming 010 and --reapply (SMD-1298)");
{
  // 049's guard is 047's ([20c]) on 010's table: its `'ob1_agent_keys'::regclass`
  // would otherwise fail bare (tenth review pass: every sibling carried the
  // guard, this file did not). Same drive: a ledger planted over a schema that
  // stops before 010, 049 alone made pending.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "010" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the049 = MIGRATIONS.find((f) => f.startsWith("049_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the049}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /049_agent_key_scope_capture\.sql\s+FAILED: migration 049 needs 010 \(ob1_agent_keys\.scope\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 049 naming 010 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the049}`)[0].c) === 0, "…049 records nothing");
  await sql.close();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "010" });
}

console.log("\n[20e] Migration 050 onto a populated 046 — every thought gains its writer's mark from the log, a planted claim is corrected, updated_at does not move, one audit row per row written, the trigger stamps every write after, and a re-apply writes nothing (SMD-1726)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "050" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const marks = async (id: string) => { const [r] = await sql`SELECT metadata->>'actor_kind' AS k, metadata->>'actor_name' AS n FROM thoughts WHERE id = ${id}::uuid`; return `${r.k ?? "-"}/${r.n ?? "-"}`; };
  // A corpus at 046: a classified key resolved through 010 writing through the
  // main server; an unclassified vendored key whose payload claims the operator's
  // mark; a raw load with no envelope. No row carries a database mark yet.
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const laptop = (await sql`SELECT resolve_agent(${"a".repeat(64)}, 'laptop', 'write') AS r`)[0].r as { agent_id: string };
  const opRow = (await sql`SELECT upsert_thought('upgrade 050: typed by the operator', ${{ metadata: { source: "mcp" }, actor: { name: "laptop", agent_id: laptop.agent_id, via: "open-brain" } }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  const claimRow = (await sql`SELECT upsert_thought('upgrade 050: an agent claiming the operator', ${{ metadata: { actor_kind: "operator", actor_name: "laptop", source: "planted" }, actor: { name: "MCP_ACCESS_KEY", via: "rest-api" } }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string };
  const RAW = "47474747-4747-4747-8747-474747474750";
  await sql.unsafe(`INSERT INTO thoughts (id, content, metadata, embedding) VALUES ('${RAW}', 'upgrade 050: a raw load', '{"source": "load"}'::jsonb, '${vec(2)}'::vector)`);
  assert((await marks(opRow.id)) === "-/-" && (await marks(claimRow.id)) === "operator/laptop" && (await marks(RAW)) === "-/-", "at 046 no row carries a mark the database wrote, and a payload's claim sits in metadata unchecked");
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, updated_at::text AS u, embedding_model, content_fingerprint FROM thoughts ORDER BY id`);
  const before = await stamps();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert((await sql`SELECT 1 FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND tgname = 'thoughts_stamp_actor'`).length === 0, "…and there is no stamp trigger");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("050") });

  assert((await sql`SELECT tgtype FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND tgname = 'thoughts_stamp_actor'`)[0]?.tgtype === 23, "050 adds the BEFORE INSERT OR UPDATE row trigger");
  assert((await marks(opRow.id)) === "operator/laptop", `the file's own backfill call gives the operator's row its mark from the capture's audit row, by the agent id 010 resolved (${await marks(opRow.id)})`);
  assert((await marks(claimRow.id)) === "-/MCP_ACCESS_KEY", `…corrects the planted claim to the log's writer — the vendored key's name, no kind since nobody has classified it (${await marks(claimRow.id)})`);
  assert((await marks(RAW)) === "-/-" && (await sql`SELECT metadata->>'source' AS s FROM thoughts WHERE id = ${RAW}::uuid`)[0].s === "load", "…and leaves the raw load unmarked, its own metadata kept: no audit row names a writer");
  assert((await stamps()) === before, "no thought's content, fingerprint, label or updated_at moved: a stamp is not an edit");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore) + 2, `one audit row per row written, and none for the row already agreeing (${Number(auditAfter) - Number(auditBefore)})`);
  const bfRows = await sql`SELECT thought_id, action, actor_name, origin, diff->'metadata'->'after'->>'actor_kind' AS k FROM thought_audit WHERE origin = 'backfill_thought_actors' ORDER BY thought_id`;
  assert(bfRows.length === 2 && bfRows.every((r: { action: string; actor_name: string | null }) => r.action === "update" && r.actor_name === null) && bfRows.some((r: { thought_id: string; k: string | null }) => r.thought_id === opRow.id && r.k === "operator"),
    "…each an update under the backfill's door and nobody's name, its diff the mark arriving");

  // The mirror: the day after. A write through a classified key is stamped by
  // the trigger with no backfill; the vendored key classified, the next pass
  // fills its row.
  const fresh = (await sql`SELECT upsert_thought('upgrade 050: a note captured after', ${{ metadata: { source: "mcp" }, actor: { name: "laptop", agent_id: laptop.agent_id, via: "open-brain" } }}::jsonb, ${vec(3)}::vector) AS r`)[0].r as { id: string };
  assert((await marks(fresh.id)) === "operator/laptop", "after 050 a write through a classified key is stamped as it lands");
  let bf = (await sql`SELECT backfill_thought_actors() AS r`)[0].r as { rows: number; differing: number; awaiting: number };
  assert(bf.rows === 0 && bf.differing === 0 && bf.awaiting === 1, `a pass after finds every row agreeing with the log and the vendored key's row awaiting a kind (${JSON.stringify(bf)})`);
  await sql`SELECT set_agent_kind('MCP_ACCESS_KEY', 'ingested')`;
  bf = (await sql`SELECT backfill_thought_actors() AS r`)[0].r as { rows: number; differing: number; awaiting: number };
  assert(bf.rows === 1 && bf.awaiting === 0 && (await marks(claimRow.id)) === "ingested/MCP_ACCESS_KEY", `once the key is classified the next pass fills its row (${JSON.stringify(bf)}, ${await marks(claimRow.id)})`);

  // An edit in flight: B holds update_thought's row lock (FOR NO KEY UPDATE)
  // and has not written yet; the pass must wait for B's transaction, not
  // deadlock against it (run-it, first review pass: the ALTER's SHARE ROW
  // EXCLUSIVE did not conflict with B's ROW SHARE, B's UPDATE then waited on
  // the table while the pass waited on the row, and the pass was the victim).
  const passB = new SQL({ url: URL_, max: 1 });
  await passB`BEGIN`;
  await passB`SELECT id FROM thoughts WHERE id = ${fresh.id}::uuid FOR NO KEY UPDATE`;
  const aPid = Number((await sql`SELECT pg_backend_pid() AS p`)[0].p);
  await sql.unsafe(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await sql.unsafe(`UPDATE thoughts SET metadata = metadata - 'actor_kind' - 'actor_name' WHERE id = '${opRow.id}'`);
  await sql.unsafe(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  const pendingA = sql`SELECT backfill_thought_actors() AS r`.execute();
  let waitedOnB = false;
  for (let i = 0; i < 100 && !waitedOnB; i++) {
    await passB`SELECT pg_stat_clear_snapshot()`;  // as [20b]'s poll: the polled session (aPid, sql's one connection) is in the view already (SMD-2742)
    const [w] = await passB`SELECT wait_event_type AS t FROM pg_stat_activity WHERE pid = ${aPid}`;
    waitedOnB = w?.t === "Lock";
    if (!waitedOnB) await new Promise((r) => setTimeout(r, 50));
  }
  const bEdit = (await passB`SELECT update_thought(${fresh.id}::uuid, 'upgrade 050: edited while a pass waited', NULL, NULL, NULL, NULL, ${{ name: "laptop", agent_id: laptop.agent_id }}::jsonb, NULL, NULL, NULL) AS r`)[0].r as { ok: boolean };
  await passB`COMMIT`;
  await passB.close();
  const passRes = (await pendingA)[0].r as { rows: number };
  assert(waitedOnB && bEdit.ok === true && passRes.rows === 1 && (await marks(opRow.id)) === "operator/laptop" && (await marks(fresh.id)) === "operator/laptop",
    `a pass meeting an edit in flight waits for it (seen waiting on a lock), the edit lands, the pass then writes its one row and neither deadlocks (${JSON.stringify(passRes)})`);
  // Two passes at once: the second waits on the first's table lock and,
  // re-checking the marks under it, writes and counts nothing the first did.
  await sql.unsafe(`ALTER TABLE thoughts DISABLE TRIGGER thoughts_stamp_actor`);
  await sql.unsafe(`UPDATE thoughts SET metadata = metadata - 'actor_kind' - 'actor_name' WHERE id IN ('${opRow.id}', '${fresh.id}')`);
  await sql.unsafe(`ALTER TABLE thoughts ENABLE TRIGGER thoughts_stamp_actor`);
  const passC = new SQL({ url: URL_, max: 1 });
  await passC`BEGIN`;
  const bfC = (await passC`SELECT backfill_thought_actors() AS r`)[0].r as { rows: number };
  const pendingD = sql`SELECT backfill_thought_actors() AS r`.execute();
  let waitedOnC = false;
  for (let i = 0; i < 100 && !waitedOnC; i++) {
    await passC`SELECT pg_stat_clear_snapshot()`;  // as [20b]'s poll: the polled session (aPid, sql's one connection) is in the view already (SMD-2742)
    const [w] = await passC`SELECT wait_event_type AS t FROM pg_stat_activity WHERE pid = ${aPid}`;
    waitedOnC = w?.t === "Lock";
    if (!waitedOnC) await new Promise((r) => setTimeout(r, 50));
  }
  await passC`COMMIT`;
  await passC.close();
  const bfD = (await pendingD)[0].r as { rows: number; differing: number };
  assert(waitedOnC && bfC.rows === 2 && bfD.rows === 0 && bfD.differing === 2,
    `two passes at once: the second waits, finds the first's marks under the lock and writes nothing — rows ${bfC.rows} + ${bfD.rows} (run-it, first review pass: each had reported every row)`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM thought_audit WHERE origin = 'backfill_thought_actors'`)[0].c) === 2 + 1 + 1 + 2, "…and the audit rows count what was written, once");

  const shapeAfter = await shape(sql);
  const again = await stamps();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("050") });
  assert(JSON.stringify(await shape(sql)) === JSON.stringify(shapeAfter) && (await stamps()) === again && Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === Number(auditAfter) + 9,
    "re-applying 050 is a no-op: the shape as it was, no row moved, no audit row added beyond the nine above — the capture, the classified key's pass, three raw strips of the marks (008 records a metadata change), the edit in flight, its pass, and the two-pass arm's two");
  await sql.close();
}

console.log("\n[20f] Migration 052 on a schema without 008, and on 008's table without 046's columns — refused up front, naming the migration and --reapply, and applied once both are there (SMD-1296)");
{
  // 052's guard is 047's shape ([20c]): a brain with a ledger planted through
  // 052 whose schema stops before 008 would take the function and fail at its
  // first call with a bare "relation thought_audit does not exist"; the file
  // refuses at apply instead, naming 008 — and, on 008's table as a hand-applied
  // 008 leaves it, naming 046. A guard with no driver is prose ([20c]'s
  // lesson), so both are driven.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "008" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the052 = MIGRATIONS.find((f) => f.startsWith("052_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the052}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /052_thought_changes\.sql\s+FAILED: migration 052 needs 008 \(thought_audit\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 052 naming 008 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the052}`)[0].c) === 0, "…052 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "008" && f < "046" });
  const half = await migrate();
  assert(half.code === 1 && /052_thought_changes\.sql\s+FAILED: migration 052 needs 046 \(thought_audit\.actor_kind, origin\); this schema lacks it/.test(half.out),
    `…and on 008's table without 046's columns it names 046 (exit ${half.code})${half.code === 1 ? "" : `:\n${half.out}`}`);
  // Complete the schema (046 onward) so [21] resets a full brain, through 052 —
  // and say so: the heading promises the file applies once both are there, and
  // an apply that did not throw is not the function present.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "046" });
  assert((await sql`SELECT to_regprocedure('thought_changes(timestamptz, uuid, text, text, text[], int)') IS NOT NULL AS ok`)[0].ok === true, "…and applied once both are there: the function is present");
  await sql.close();
}

console.log("\n[20g] Migration 053 on a schema without 016, and on 016's tables without 042's — refused up front, naming the missing migration and --reapply, and applied once both are there (SMD-1867)");
{
  // 053's guard is 052's shape ([20f]): a brain with a ledger planted through
  // 053 whose schema stops before 016 would fail at source_thought's SQL body
  // — validated at CREATE — with a bare "column n.supersedes does not exist"
  // (025's column; a plpgsql body is not checked against the catalog until it
  // runs), and one through 041 at the link index with a bare "relation
  // thought_facets does not exist"; the file refuses at apply instead, naming
  // 016 — and, with 016's tables but not 042's thought_facets, naming 042. A guard
  // with no driver is prose ([20c]'s lesson), so both are driven (eighth
  // review pass: the guard had none).
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "016" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the053 = MIGRATIONS.find((f) => f.startsWith("053_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the053}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /053_thought_sources_and_links\.sql\s+FAILED: migration 053 needs 016 \(ob1_entity_edges\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 053 naming 016 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the053}`)[0].c) === 0, "…053 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "016" && f < "042" });
  const half = await migrate();
  assert(half.code === 1 && /053_thought_sources_and_links\.sql\s+FAILED: migration 053 needs 042 \(thought_facets\); this schema lacks it/.test(half.out),
    `…and with 016's tables but not 042's it names 042 (exit ${half.code})${half.code === 1 ? "" : `:\n${half.out}`}`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "042" });
  const present = (await sql`SELECT to_regclass('thought_sources') IS NOT NULL AS t, to_regprocedure('record_source_links(uuid, text, jsonb)') IS NOT NULL AS f`)[0] as { t: boolean; f: boolean };
  assert(present.t === true && present.f === true, "…and applied once both are there: the table and the writer are present");
  await sql.close();
}

console.log("\n[20h] Migration 054 on a schema without 010 — refused up front, naming 010 and --reapply (SMD-2090)");
{
  // 054's guard is 049's ([20d]): a plpgsql body is not checked against the
  // catalog at CREATE, so without it 054 would apply over a pre-010 schema and
  // fail bare at its COMMENT ON COLUMN. Same drive: a ledger planted over a
  // schema that stops before 010, 054 alone made pending.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "010" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the054 = MIGRATIONS.find((f) => f.startsWith("054_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the054}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /054_resolve_agent_stale_touch\.sql\s+FAILED: migration 054 needs 010 \(ob1_agent_keys\.last_used_at, revoked_at, scope\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 054 naming 010 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the054}`)[0].c) === 0, "…054 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "010" });
  // An apply that did not throw is not the function present ([20c]'s lesson): read 054's sentinel off the live body.
  const [body] = await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = to_regprocedure('resolve_agent(text, text, text)')`;
  assert(/ob1:stale-only-touch/.test(String(body?.s ?? "")), "…and applied once 010's table is there: the live resolve_agent is 054's");
  await sql.close();
}

console.log("\n[20i] Migration 055 onto a populated brain at the file before it — every capture row written before gains its payload from the log and the row at apply, the pass writes no event and moves no row, a second pass finds nothing; and on a schema without 046 or 050 the file is refused up front, naming the migration and --reapply (SMD-2115)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "055" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const laptop = (await sql`SELECT resolve_agent(${"a".repeat(64)}, 'laptop', 'write') AS r`)[0].r as { agent_id: string };
  const actor = { name: "laptop", agent_id: laptop.agent_id, via: "open-brain" };
  // A corpus at 053, in 046's shape: a thought whose text later moved, one
  // deleted, one standing, and a backdated raw record (ingest-records' shape).
  const moved = (await sql`SELECT upsert_thought('upgrade 055: the first text', ${{ metadata: { source: "mcp" }, actor }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  await sql`SELECT update_thought(${moved.id}::uuid, 'upgrade 055: the second text', NULL, NULL, NULL, NULL, ${actor}::jsonb, NULL, NULL, NULL)`;
  const gone = (await sql`SELECT upsert_thought('upgrade 055: deleted before 055', ${{ metadata: { source: "mcp" }, actor }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string };
  await sql`SELECT delete_thought(${gone.id}::uuid, ${actor}::jsonb, false)`;
  const still = (await sql`SELECT upsert_thought('upgrade 055: still standing', ${{ metadata: { source: "mcp" }, actor }}::jsonb, ${vec(2)}::vector) AS r`)[0].r as { id: string };
  const RAW = "54545454-2054-4054-8054-000000000001";
  await sql.unsafe(`INSERT INTO thoughts (id, content, metadata, embedding, created_at) VALUES ('${RAW}', 'upgrade 055: a backdated record', '{"source": "load"}'::jsonb, '${vec(3)}'::vector, '2024-02-03T04:05:06Z')`);
  const waiting = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit WHERE action = 'capture' AND NOT COALESCE(diff ? 'content', false) AND jsonb_typeof(COALESCE(diff, '{}'::jsonb)) = 'object'`)[0].c);
  const captureOf = async (id: string) => (await sql`SELECT diff FROM thought_audit WHERE thought_id = ${id}::uuid AND action = 'capture' ORDER BY created_at, seq LIMIT 1`)[0]?.diff as Record<string, unknown> | undefined;
  assert((await waiting()) === 4 && !("content" in (await captureOf(moved.id))!) && !("created_at" in (await captureOf(RAW))!), "at 053 four capture rows carry no content, and the backdated record's event no created_at — the log alone cannot rebuild them");
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, updated_at::text AS u FROM thoughts ORDER BY id`);
  const before = await stamps();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const shapeBefore = await shape(sql);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("055") });

  assert((await waiting()) === 0, `the file's own backfill call fills every waiting capture row (${await waiting()} left)`);
  assert((await captureOf(moved.id))?.content === "upgrade 055: the first text", "…the moved thought's capture holds the text AS CAPTURED, from the update's before — not the text that stands");
  assert((await captureOf(gone.id))?.content === "upgrade 055: deleted before 055", "…the deleted thought's from its tombstone");
  assert((await captureOf(still.id))?.content === "upgrade 055: still standing" && !("created_at" in (await captureOf(still.id))!), "…the standing thought's from its row, and no created_at for a row that took now()");
  const raw = (await sql`SELECT (a.diff->>'created_at')::timestamptz = t.created_at AS same, a.diff->>'content' AS c FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE a.thought_id = ${RAW}::uuid AND a.action = 'capture'`)[0] as { same: boolean; c: string };
  assert(raw.same === true && raw.c === "upgrade 055: a backdated record", "…and the backdated record's from its row, with the row's own created_at since it differs from the event's");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore) && (await stamps()) === before, "the pass is an amendment, not an event: no audit row written, no thought's content, key or updated_at moved");
  let bf = (await sql`SELECT backfill_thought_payloads() AS r`)[0].r as { rows: number; unrecoverable: number; awaiting: number };
  assert(bf.rows === 0 && bf.unrecoverable === 0 && bf.awaiting === 0, `a second pass fills nothing (${JSON.stringify(bf)})`);
  // The mirror: the day after, a capture carries its content as it lands and
  // a backdated raw insert its created_at; an edit carries the key's move.
  const fresh = (await sql`SELECT upsert_thought('upgrade 055: captured after', ${{ metadata: { source: "mcp" }, actor }}::jsonb, ${vec(4)}::vector) AS r`)[0].r as { id: string };
  assert((await captureOf(fresh.id))?.content === "upgrade 055: captured after", "after 055 a capture's event carries the content as it lands");
  const RAW2 = "54545454-2054-4054-8054-000000000002";
  await sql.unsafe(`INSERT INTO thoughts (id, content, metadata, created_at) VALUES ('${RAW2}', 'upgrade 055: backdated after', '{"source": "load"}'::jsonb, '2024-02-03T04:05:07Z')`);
  const raw2 = (await sql`SELECT (a.diff->>'created_at')::timestamptz = t.created_at AS same FROM thought_audit a JOIN thoughts t ON t.id = a.thought_id WHERE a.thought_id = ${RAW2}::uuid AND a.action = 'capture'`)[0] as { same: boolean };
  assert(raw2.same === true, "…a backdated raw insert its created_at");
  await sql`SELECT update_thought(${fresh.id}::uuid, 'upgrade 055: edited after', NULL, NULL, NULL, NULL, ${actor}::jsonb, NULL, NULL, NULL)`;
  const move = (await sql`SELECT diff->'content_fingerprint' AS k FROM thought_audit WHERE thought_id = ${fresh.id}::uuid AND action = 'update'`)[0]?.k as { before: string | null; after: string | null } | null;
  assert(typeof move?.before === "string" && typeof move?.after === "string" && move.before !== move.after, `…and an edit the key's move (${JSON.stringify(move)})`);
  // Re-apply: a no-op.
  const shapeAfter = await shape(sql), again = await stamps();
  const [{ c: auditAgain }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("055") });
  assert(JSON.stringify(await shape(sql)) === JSON.stringify(shapeAfter) && (await stamps()) === again && Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === Number(auditAgain) && JSON.stringify(shapeAfter) !== JSON.stringify(shapeBefore),
    "re-applying 055 is a no-op: the shape as it left it (six functions and an index more than 053), no row moved, no audit row added, nothing to fill");
  await sql.close();

  // The guard, driven ([20g]'s shape): a brain with a ledger planted through
  // 055 whose schema stops before 046, then before 050.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "046" });
  await plantLedger(URL_);
  const sql2 = new SQL({ url: URL_, max: 1 });
  const the055 = MIGRATIONS.find((f) => f.startsWith("055_"))!;
  await sql2`DELETE FROM schema_migrations WHERE name = ${the055}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /055_capture_event_payload\.sql\s+FAILED: migration 055 needs 046 \(thought_audit\.actor_kind, ob1_registry_kind\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 055 naming 046 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the055}`)[0].c) === 0, "…055 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "046" && f < "050" });
  const half = await migrate();
  assert(half.code === 1 && /055_capture_event_payload\.sql\s+FAILED: migration 055 needs 050 \(thought_audit\.seq, ob1_stamp_actor\); this schema lacks it/.test(half.out),
    `…and with 046's columns but not 050's it names 050 (exit ${half.code})${half.code === 1 ? "" : `:\n${half.out}`}`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "050" && f < "055" });
  const full = await migrate();
  const present = (await sql2`SELECT to_regprocedure('backfill_thought_payloads(integer)') IS NOT NULL AS f, to_regclass('thought_audit_awaiting_payload_idx') IS NOT NULL AS i`)[0] as { f: boolean; i: boolean };
  assert(full.code === 0 && present.f === true && present.i === true, `…and applied once both are there: the backfill and the index are present (exit ${full.code})`);
  await sql2.close();
}

console.log("\n[20j] Migration 056 on a schema without 016, and on 016's tables without 053's — refused up front, naming the missing migration and --reapply, and applied once both are there (SMD-1935)");
{
  // 056's guard is 053's ([20g]): without it a schema stopping before 016
  // would fail at entity_type_gate's SQL body — validated at CREATE — with a
  // bare "function normalize_entity_name(text) does not exist", and one with
  // 016's tables but not 053's would apply, installing 053's writer body — the
  // structured-wins rule — without the table and facet kind 053 ships beside it.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "016" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the056 = MIGRATIONS.find((f) => f.startsWith("056_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the056}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /056_entity_name_gate\.sql\s+FAILED: migration 056 needs 016 \(ob1_entity_edges\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 056 naming 016 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the056}`)[0].c) === 0, "…056 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "016" && f < "053" });
  const half = await migrate();
  assert(half.code === 1 && /056_entity_name_gate\.sql\s+FAILED: migration 056 needs 053 \(thought_sources, and its record_thought_entities body\); this schema lacks it/.test(half.out),
    `…and with 016's tables but not 053's it names 053 (exit ${half.code})${half.code === 1 ? "" : `:\n${half.out}`}`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "053" });
  // An apply that did not throw is not the function present ([20c]'s lesson): read 056's sentinel off the live body.
  // 061, applied in the same run, moved the writer to seven arguments and dropped the six (SMD-1731): whichever form stands is the live body.
  const [body] = await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = COALESCE(to_regprocedure('record_thought_entities(uuid, text, jsonb, jsonb, text, uuid, jsonb)'), to_regprocedure('record_thought_entities(uuid, text, jsonb, jsonb, text, uuid)'))`;
  assert(/ob1:name-gate/.test(String(body?.s ?? "")) && (await sql`SELECT to_regprocedure('apply_entity_type_gate()') IS NOT NULL AS p`)[0].p === true, "…and applied once both are there: the live writer carries 056's gate (under 061's seven-argument form) and the pass is present");
  await sql.close();
}

console.log("\n[20k] Migration 058 on a schema without 025, and on 025's pointer without 053's tables — refused up front, naming the missing migration and --reapply, and applied once both are there (SMD-2074)");
{
  // 058's bodies are SQL, validated at CREATE: without the guard a schema
  // stopping before 025 would fail at node_lifecycle() with a bare "column
  // s.supersedes does not exist", and one with 025 but not 053 at
  // node_dependencies() with "relation thought_sources does not exist".
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "025" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the058 = MIGRATIONS.find((f) => f.startsWith("058_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the058}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /058_node_state\.sql\s+FAILED: migration 058 needs 025 \(thoughts\.supersedes\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 058 naming 025 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the058}`)[0].c) === 0, "…058 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "025" && f < "053" });
  const half = await migrate();
  assert(half.code === 1 && /058_node_state\.sql\s+FAILED: migration 058 needs 053 \(thought_sources, source_thought\); this schema lacks it/.test(half.out),
    `…and with 025's pointer but not 053's tables it names 053 (exit ${half.code})${half.code === 1 ? "" : `:\n${half.out}`}`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "053" });
  // An apply that did not throw is not the function present ([20c]'s lesson): call it.
  const [probe] = await sql`SELECT to_regprocedure('node_state(uuid[])') IS NOT NULL AS p, (SELECT count(*)::int FROM node_state()) AS n, (SELECT count(*)::int FROM thoughts) AS t`;
  assert(probe.p === true && probe.n === probe.t, `…and applied once both are there: node_state() is present and reads every thought (${probe.n} of ${probe.t})`);
  await sql.close();
}

console.log("\n[20l] Migration 059 on a schema without 058, and on 058 without 045's query_log.arm — refused up front, naming the missing migration and --reapply, and applied once both are there (SMD-2255)");
{
  // 059's function body is SQL, validated at CREATE: without the guard a schema
  // stopping before 058 would fail at the wrapper with a bare "function
  // node_state(unknown) does not exist". 027 is older than every schema that
  // reaches 058, so the checks that can be reached here are 058 and 045.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "058" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the058 = MIGRATIONS.find((f) => f.startsWith("058_"))!;
  const the059 = MIGRATIONS.find((f) => f.startsWith("059_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the059}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /059_search_prefers_current\.sql\s+FAILED: migration 059 needs 058 \(node_state\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 059 naming 058 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the059}`)[0].c) === 0, "…059 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the058 });
  await sql`ALTER TABLE query_log DROP COLUMN arm`;
  const half = await migrate();
  assert(half.code === 1 && /059_search_prefers_current\.sql\s+FAILED: migration 059 needs 045 \(query_log\.arm\); this schema lacks it/.test(half.out),
    `…and with 058 but without query_log.arm it names 045 (exit ${half.code})${half.code === 1 ? "" : `:\n${half.out}`}`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "045" && f < "046" });
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "059" });
  // An apply that did not throw is not the function present ([20c]'s lesson): read its signature and the widened CHECK.
  const [probe] = await sql`SELECT to_regprocedure('search_thoughts_current(vector, text, float, int, jsonb, float, float)') IS NOT NULL AS p,
                                   pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'query_log_arm_check')) AS chk`;
  assert(probe.p === true && /'current'/.test(String(probe.chk)), `…and applied once both are there: the wrapper is present and query_log.arm admits current (${probe.chk})`);
  await sql.close();
}

console.log("\n[20m] Migration 060 onto a populated brain at the file before it — the snapshot seeded from every row holding key, model and vector and no other, no audit row written, no row moved, the writers redefined; a re-apply a no-op; refused up front without 042, 050 or 055, naming the migration and --reapply (SMD-2116)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "060" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const laptop = (await sql`SELECT resolve_agent(${"a".repeat(64)}, 'laptop', 'write') AS r`)[0].r as { agent_id: string };
  const actor = { name: "laptop", agent_id: laptop.agent_id, via: "open-brain" };
  // A corpus at 058, the file before this one: a labelled vector, an unlabelled one (021: a vector of
  // unknown model), a row without a vector, a raw row with a NULL key, and
  // one edited so its stamp differs from its clock.
  const labelled = (await sql`SELECT upsert_thought('upgrade 060: labelled', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  const unlabelled = (await sql`SELECT upsert_thought('upgrade 060: unlabelled', ${{ metadata: { source: "mcp" }, actor }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string };
  const bare = (await sql`SELECT upsert_thought('upgrade 060: no vector', ${{ metadata: { source: "mcp" }, actor }}::jsonb) AS r`)[0].r as { id: string };
  const RAW = "57575757-2057-4057-8057-000000000001";
  await sql.unsafe(`INSERT INTO thoughts (id, content, metadata, embedding, embedding_model) VALUES ('${RAW}', 'upgrade 060: raw, no key', '{"source": "load"}'::jsonb, '${vec(2)}'::vector, '${OPTS.model}')`);
  await sql.unsafe(`UPDATE thoughts SET content_fingerprint = NULL WHERE id = '${RAW}'`);
  const edited = (await sql`SELECT upsert_thought('upgrade 060: edited once', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(3)}::vector) AS r`)[0].r as { id: string };
  await sql`SELECT update_thought(${edited.id}::uuid, NULL, '{"k": 1}'::jsonb, NULL, NULL, NULL, ${actor}::jsonb, NULL, NULL, NULL)`;
  assert((await sql`SELECT to_regclass('ob1_embedding_snapshot') IS NULL AS none`)[0].none === true, "before 060 there is no snapshot table");
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata, embedding::text AS e, embedding_model, updated_at::text AS u FROM thoughts ORDER BY id`);
  const before = await stamps();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const shapeBefore = await shape(sql);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("060") });

  const snap = await sql`SELECT s.content_fingerprint AS fp, s.embedding_model AS m, s.embedding::text AS e, s.dims, s.taken_at::text AS t, t.id::text AS id, COALESCE(t.updated_at, t.created_at)::text AS stamp FROM ob1_embedding_snapshot s JOIN thoughts t ON t.content_fingerprint = s.content_fingerprint ORDER BY t.id` as { fp: string; m: string; e: string; dims: number; t: string; id: string; stamp: string }[];
  assert(snap.length === 2 && snap.every((r) => r.m === OPTS.model && r.dims === OPTS.dim && r.t === r.stamp) && snap.some((r) => r.id === labelled.id && r.e === vec(0)) && snap.some((r) => r.id === edited.id && r.e === vec(3)),
    `the seed holds exactly the rows with key, model and vector — the labelled and the edited thought, each under its key with the row's stamp as taken_at — and not the unlabelled vector, the row without one or the raw row with no key (${JSON.stringify(snap.map((r) => [r.id === labelled.id ? "labelled" : r.id === edited.id ? "edited" : r.id, r.m, r.dims]))})`);
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore) && (await stamps()) === before, "the seed is a read of the rows: no audit row written, no thought's content, key, vector or updated_at moved");
  for (const [fn, sig] of [["upsert_thought", "upsert_thought(text, jsonb, vector)"], ["update_thought", "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)"], ["delete_thought", "delete_thought(uuid, jsonb, boolean)"]]) {
    const [body] = await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = to_regprocedure(${sig})`;
    assert(/ob1:capture-appends-then-projects/.test(String(body?.s ?? "")), `${fn} is 060's body`);
  }
  const [trigBody] = await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = to_regprocedure('thoughts_write_audit()')`;
  assert(/ob1:projection-checked-against-its-event/.test(String(trigBody?.s ?? "")) && /ob1:capture-event-carries-content/.test(String(trigBody?.s ?? "")), "the audit trigger is 060's check, carrying 055's sentinel");
  // The mirror: the day after, a capture is an event first and its row the
  // projection; an identical re-capture writes nothing; the snapshot follows.
  const fresh = (await sql`SELECT upsert_thought('upgrade 060: captured after', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(4)}::vector) AS r`)[0].r as { id: string };
  const [freshEv] = await sql`SELECT count(*)::int AS c, min(diff->>'content') AS content FROM thought_audit WHERE thought_id = ${fresh.id}::uuid`;
  const [freshRow] = await sql`SELECT content, updated_at = created_at AS same FROM thoughts WHERE id = ${fresh.id}::uuid`;
  assert(Number(freshEv.c) === 1 && freshEv.content === "upgrade 060: captured after" && freshRow.content === freshEv.content && freshRow.same === true && Number((await sql`SELECT count(*)::int AS c FROM ob1_embedding_snapshot WHERE embedding_model = ${OPTS.model}`)[0].c) === 3,
    "after 060 a capture's event carries the content, the row is its image and the snapshot gains the vector");
  const [{ u: stampBefore }] = await sql`SELECT updated_at::text AS u FROM thoughts WHERE id = ${fresh.id}::uuid`;
  await sql`SELECT upsert_thought('upgrade 060: captured after', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(4)}::vector)`;
  const [{ u: stampAfter }] = await sql`SELECT updated_at::text AS u FROM thoughts WHERE id = ${fresh.id}::uuid`;
  assert(stampAfter === stampBefore && Number((await sql`SELECT count(*)::int AS c FROM thought_audit WHERE thought_id = ${fresh.id}::uuid`)[0].c) === 1, "…and an identical re-capture writes no event and moves no updated_at (the accepted delta)");
  // Re-apply: a no-op — the seed's ON CONFLICT DO NOTHING keeps the trigger's rows.
  const shapeAfter = await shape(sql), again = await stamps();
  const snapAfter = JSON.stringify(await sql`SELECT content_fingerprint, embedding_model, embedding::text AS e, taken_at::text AS t FROM ob1_embedding_snapshot ORDER BY 1, 2`);
  const [{ c: auditAgain }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("060") });
  assert(JSON.stringify(await shape(sql)) === JSON.stringify(shapeAfter) && (await stamps()) === again && Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === Number(auditAgain)
    && JSON.stringify(await sql`SELECT content_fingerprint, embedding_model, embedding::text AS e, taken_at::text AS t FROM ob1_embedding_snapshot ORDER BY 1, 2`) === snapAfter && JSON.stringify(shapeAfter) !== JSON.stringify(shapeBefore),
    "re-applying 060 is a no-op: the shape as it left it (four functions and a table more than 058), no row moved, no audit row added, no snapshot row re-seeded");
  await sql.close();

  // The guard, driven ([20g]'s shape): a brain with a ledger planted through
  // 060 whose schema stops before 042, then before 050, then before 055.
  for (const [stop, needs] of [["042", "migration 060 needs 042 \\(delete_thought\\(uuid, jsonb, boolean\\), thoughts_guard_citation_sources\\); this schema lacks it"], ["050", "migration 060 needs 050 \\(ob1_stamp_actor, thought_audit\\.seq\\); this schema lacks it"], ["055", "migration 060 needs 055 \\(ob1_thought_diff, ob1_append_thought_event, ob1_actor_stamp, ob1_actor_stamp_kept\\); this schema lacks it"]] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    await plantLedger(URL_);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the060 = MIGRATIONS.find((f) => f.startsWith("060_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the060}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`060_append_then_project\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
    assert(ok, `a plain run fails at 060 naming ${stop} and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
    assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the060}`)[0].c) === 0, `…060 records nothing without ${stop}`);
    await sql2.close();
  }
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "055" });
  const sql3 = new SQL({ url: URL_, max: 1 });
  const [present] = await sql3`SELECT to_regprocedure('ob1_project_thought_event(uuid, vector, text, boolean)') IS NOT NULL AS p, to_regprocedure('ob1_refresh_thought_vector(uuid, vector, text)') IS NOT NULL AS r, to_regclass('ob1_embedding_snapshot') IS NOT NULL AS s`;
  assert(present.p === true && present.r === true && present.s === true, "…and applied once every prerequisite is there: the projector, the refresh and the snapshot are present");
  await sql3.close();
}

console.log("\n[20n] Migration 061 onto a populated brain at the file before it — every artifact standing gains its lineage row, marked legacy, at the thought's current fingerprint: the vectors (a raw row's NULL key hashed again), the chunk set, the extraction under each key, the proposals (the judge key parsed where it has 029's shape); no audit row written, no row moved, three arities moved under their own DROP; a re-apply a no-op; refused up front without 013, 029, 056 or 060, naming the migration and --reapply (SMD-1731)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "061" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const laptop = (await sql`SELECT resolve_agent(${"a".repeat(64)}, 'laptop', 'write') AS r`)[0].r as { agent_id: string };
  const actor = { name: "laptop", agent_id: laptop.agent_id, via: "open-brain" };
  // A corpus at 060, the file before this one: a labelled vector, an
  // unlabelled one, a row without a vector, a raw row with a NULL key, a
  // windowed thought, an extraction under two keys, two proposals — one under
  // a judge key of another shape.
  const labelled = (await sql`SELECT upsert_thought('upgrade 061: labelled', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  const unlabelled = (await sql`SELECT upsert_thought('upgrade 061: unlabelled', ${{ metadata: { source: "mcp" }, actor }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  await sql`SELECT upsert_thought('upgrade 061: no vector', ${{ metadata: { source: "mcp" }, actor }}::jsonb)`;
  const RAW = "57575757-2061-4061-8061-000000000001";
  await sql.unsafe(`INSERT INTO thoughts (id, content, metadata, embedding, embedding_model) VALUES ('${RAW}', 'upgrade 061: raw, no key', '{"source": "load"}'::jsonb, '${vec(2)}'::vector, '${OPTS.model}')`);
  await sql.unsafe(`UPDATE thoughts SET content_fingerprint = NULL WHERE id = '${RAW}'`);
  const windowed = (await sql`SELECT upsert_thought('upgrade 061: windowed', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(3)}::vector, ${[{ content: "w1", embedding: vec(3) }, { content: "w2", embedding: vec(4) }]}::jsonb) AS r`)[0].r as { id: string; fingerprint: string };
  const e1 = (await sql`SELECT record_thought_entities(${labelled.id}::uuid, 'extract:m@p2', '[{"name": "Alice", "type": "person", "confidence": 0.9}]'::jsonb, '[]'::jsonb, NULL, ${laptop.agent_id}::uuid) AS r`)[0].r as { ok: boolean };
  const e2 = (await sql`SELECT record_thought_entities(${labelled.id}::uuid, 'source:test', '[{"name": "Open Brain", "type": "project", "confidence": 1}]'::jsonb, '[]'::jsonb, NULL, NULL) AS r`)[0].r as { ok: boolean };
  assert(e1.ok === true && e2.ok === true, "the corpus at 060 carries an extraction under two keys");
  const p1 = (await sql`SELECT record_supersession_proposal(${labelled.id}::uuid, ${unlabelled.id}::uuid, 'newer_supersedes_older', 0.9, 'because', 0.8, 'consolidate:judge@p3', ${laptop.agent_id}::uuid) AS id`)[0].id as string;
  const p2 = (await sql`SELECT record_supersession_proposal(${labelled.id}::uuid, ${windowed.id}::uuid, 'conflict_undirected', 0.6, NULL, 0.7, 'test:1731') AS id`)[0].id as string;
  assert((await sql`SELECT to_regclass('derivations') IS NULL AS none`)[0].none === true, "before 061 there is no lineage table");
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata, embedding::text AS e, embedding_model, updated_at::text AS u FROM thoughts ORDER BY id`);
  const before = await stamps();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const shapeBefore = await shape(sql);
  const [arities] = await sql`SELECT (SELECT pronargs FROM pg_proc WHERE proname = 'update_thought') AS u, (SELECT pronargs FROM pg_proc WHERE proname = 'record_thought_entities') AS e, (SELECT pronargs FROM pg_proc WHERE proname = 'record_supersession_proposal') AS p`;
  assert(Number(arities.u) === 10 && Number(arities.e) === 6 && Number(arities.p) === 10, "at 060 the three producers stand at ten, six and ten arguments");
  // db/reembed.ts on this brain refuses naming 061 and the plain run through
  // it — not 046, which this brain has (cold read, first review pass: the
  // refusal named 061 and told the operator to apply through 046).
  const status060 = await runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_, "--status"], { env: MIGRATOR_ENV, cwd: HERE });
  const out060 = status060.out.replace(/\x1b\[[0-9;]*m/g, "");
  assert(status060.code === 0 && /a run would refuse: update_thought predates migration 061/.test(out060) && /eleven-argument update_thought/.test(out060) && /every file through 061, in order/.test(out060) && !/through 046/.test(out060),
         `reembed.ts --status on a brain at 060 names 061 as the missing file and the plain run through it as the remedy (exit ${status060.code}: ${out060.split("\n").find((l) => /would refuse/.test(l))?.trim().slice(0, 200)})`);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("061") });

  type L = { kind: string; artifact: string; by: string; fps: string[]; recipe: Record<string, unknown>; at: string; agent: string | null };
  const rows = (await sql`SELECT artifact_kind AS kind, artifact_id::text AS artifact, produced_by AS by, input_fingerprints AS fps, recipe, produced_at::text AS at, canonical_agent_id::text AS agent FROM derivations ORDER BY artifact_kind, artifact_id, produced_by`) as L[];
  const of = (kind: string, artifact?: string) => rows.filter((r) => r.kind === kind && (artifact === undefined || r.artifact === artifact));
  assert(rows.length === 9 && rows.every((r) => r.recipe.legacy === true) && rows.every((r) => r.fps.every((f) => typeof f === "string" && f.length > 0)),
    `nine rows, every one legacy, no NULL fingerprint (${rows.map((r) => r.kind).join(",")})`);
  const rawFp = (await sql`SELECT content_fingerprint_of('upgrade 061: raw, no key') AS f`)[0].f as string;
  assert(of("vector").length === 4 && of("vector", RAW)[0]?.fps[0] === rawFp && of("vector", unlabelled.id)[0]?.recipe.model === undefined && of("vector", labelled.id)[0]?.recipe.model === OPTS.model && of("vector").every((r) => r.recipe.dims === OPTS.dim && r.by === "thoughts_record_vector_lineage" && r.recipe.deterministic === true),
    "four vector rows — the raw row's NULL key hashed again, the unlabelled row's model absent, every width the column's — under the trigger's name; the row without a vector has none");
  assert(of("chunks").length === 1 && of("chunks")[0].artifact === windowed.id && of("chunks")[0].recipe.count === 2 && of("chunks")[0].recipe.model === OPTS.model && of("chunks")[0].by === "capture", "one chunks row for the windowed thought: the set's size, the parent's label");
  assert(of("entities").map((r) => r.by).join() === "extract:m@p2,source:test" && of("entities").every((r) => r.fps[0] === labelled.fingerprint) && of("entities")[0].recipe.deterministic === false && of("entities")[1].recipe.deterministic === true && of("entities")[0].agent === laptop.agent_id,
    "two entities rows, one per key, at the thought's current fingerprint — the extraction non-deterministic, the structured pass deterministic — the agent carried from the mentions");
  const pj = of("proposal", p1)[0], pt = of("proposal", p2)[0];
  assert(pj !== undefined && pj.recipe.model === "judge" && pj.recipe.prompt_version === 3 && pj.fps.length === 2 && pj.agent === laptop.agent_id && pt !== undefined && !("model" in pt.recipe) && !("prompt_version" in pt.recipe) && pt.recipe.key === "test:1731",
    "two proposal rows: the judge key parsed into model and prompt version where it has 029's shape, the key alone where it has not");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore) && (await stamps()) === before, "the backfill is a read of the artifacts: no audit row written, no thought moved");
  const [after] = await sql`SELECT (SELECT pronargs FROM pg_proc WHERE proname = 'update_thought') AS u, (SELECT count(*)::int FROM pg_proc WHERE proname = 'update_thought') AS un, (SELECT pronargs FROM pg_proc WHERE proname = 'record_thought_entities') AS e, (SELECT count(*)::int FROM pg_proc WHERE proname = 'record_thought_entities') AS en, (SELECT pronargs FROM pg_proc WHERE proname = 'record_supersession_proposal') AS p, (SELECT count(*)::int FROM pg_proc WHERE proname = 'record_supersession_proposal') AS pn`;
  assert(Number(after.u) === 11 && Number(after.un) === 1 && Number(after.e) === 7 && Number(after.en) === 1 && Number(after.p) === 11 && Number(after.pn) === 1, "…and the three producers stand alone at eleven, seven and eleven arguments — the older forms dropped");
  for (const [fn, sig] of [["upsert_thought", "upsert_thought(text, jsonb, vector)"], ["update_thought", UPDATE_THOUGHT_SIGNATURE], ["record_thought_entities", "record_thought_entities(uuid, text, jsonb, jsonb, text, uuid, jsonb)"], ["record_supersession_proposal", "record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid, text, text, jsonb)"]]) {
    const [body] = await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = to_regprocedure(${sig})`;
    assert(/ob1:derivation-recorded-with-its-artifact/.test(String(body?.s ?? "")), `${fn} is 061's body`);
  }
  // The mirror: the day after, a capture with a vector records its row live,
  // not marked legacy; a re-apply re-seeds nothing and moves no produced_at.
  const fresh = (await sql`SELECT upsert_thought('upgrade 061: captured after', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(5)}::vector) AS r`)[0].r as { id: string };
  const freshRows = (await sql`SELECT artifact_kind AS kind, recipe FROM derivations WHERE artifact_id = ${fresh.id}::uuid`) as { kind: string; recipe: Record<string, unknown> }[];
  assert(freshRows.length === 1 && freshRows[0].kind === "vector" && freshRows[0].recipe.legacy === undefined, "after 061 a capture's vector row is written live, not marked legacy");
  const lineage = async () => JSON.stringify(await sql`SELECT artifact_kind, artifact_id, produced_by, produced_at::text AS at, recipe FROM derivations ORDER BY 1, 2, 3`);
  const shapeAfter = await shape(sql), again = await stamps(), lineageAfter = await lineage();
  const [{ c: auditAgain }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("061") });
  assert(JSON.stringify(await shape(sql)) === JSON.stringify(shapeAfter) && (await stamps()) === again && Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === Number(auditAgain) && (await lineage()) === lineageAfter && JSON.stringify(shapeAfter) !== JSON.stringify(shapeBefore),
    "re-applying 061 is a no-op: the shape as it left it (a table and five functions more than 060), no row moved, no audit row added, no lineage row re-seeded or moved");
  await sql.close();

  // The guard, driven ([20g]'s shape): a brain with a ledger planted through
  // 061 whose schema stops before 013, then 029, then 056, then 060.
  for (const [stop, needs] of [["013", "migration 061 needs 013 \\(thought_chunks\\.context, the 4-argument upsert_thought's context arm\\); this schema lacks it"], ["029", "migration 061 needs 029 \\(supersession_proposals\\); this schema lacks it"], ["056", "migration 061 needs 056 \\(entity_type_gate, record_thought_entities' body\\); this schema lacks it"], ["060", "migration 061 needs 060 \\(ob1_refresh_thought_vector, ob1_embedding_snapshot\\); this schema lacks it"]] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    await plantLedger(URL_);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the061 = MIGRATIONS.find((f) => f.startsWith("061_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the061}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`061_derivations\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
    assert(ok, `a plain run fails at 061 naming ${stop} and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
    assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the061}`)[0].c) === 0, `…061 records nothing without ${stop}`);
    await sql2.close();
  }
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "060" });
  const sql3 = new SQL({ url: URL_, max: 1 });
  const [present] = await sql3`SELECT to_regclass('derivations') IS NOT NULL AS t, to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)') IS NOT NULL AS w, to_regprocedure('record_thought_entities(uuid, text, jsonb, jsonb, text, uuid, jsonb)') IS NOT NULL AS e`;
  assert(present.t === true && present.w === true && present.e === true, "…and applied once every prerequisite is there: the table, the writer and the seven-argument extraction writer are present");
  await sql3.close();
}

console.log("\n[20o] Migration 063 onto a populated brain at the file before it — the mark's two columns land NULL on every row, 029's status CHECK admits stale, the writer, the candidate filter and the proposal writer are 063's; a rebuild acts on the corpus as it stands (an orphan row deleted, a stale extraction and vector handed on, a stale proposal set stale); a re-apply is a no-op; refused by name without 016, 029, 060 or 061 (SMD-1732)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "063" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  // A corpus at 062: an older and a newer thought sharing Alice, a pending
  // proposal on the pair, a window set on the newer (raw, as PGlite's suite
  // plants it) whose windows a raw delete then removes — an orphan lineage
  // row — and a raw text move on the newer: its extraction, its vector and
  // the proposal stale by fingerprint.
  const older = (await sql`SELECT upsert_thought('upgrade 063: the older note', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  await sql`UPDATE thoughts SET created_at = now() - interval '3 days' WHERE id = ${older.id}::uuid`;
  const newer = (await sql`SELECT upsert_thought('upgrade 063: the newer note', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  for (const id of [older.id, newer.id]) {
    const e = (await sql`SELECT record_thought_entities(${id}::uuid, 'extract:m@p2', '[{"name": "Alice", "type": "person", "confidence": 0.9}]'::jsonb, '[]'::jsonb, NULL, NULL) AS r`)[0].r as { ok: boolean };
    assert(e.ok === true, "the corpus at 062 carries an extraction on each thought");
  }
  const pid = (await sql`SELECT record_supersession_proposal(${older.id}::uuid, ${newer.id}::uuid, 'newer_supersedes_older', 0.9, 'because', 0.8, 'consolidate:judge@p3') AS id`)[0].id as string;
  await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding) VALUES (${newer.id}::uuid, 0, 'w', ${vec(1)}::vector)`;
  await sql`SELECT ob1_record_derivation('chunks', ${newer.id}::uuid, ARRAY[${newer.id}::uuid], ARRAY[${newer.fingerprint}::text], 'capture', '{"deterministic": true, "count": 1}'::jsonb)`;
  await sql`DELETE FROM thought_chunks WHERE thought_id = ${newer.id}::uuid`;
  await sql`UPDATE thoughts SET content = 'upgrade 063: the newer note, rewritten', content_fingerprint = content_fingerprint_of('upgrade 063: the newer note, rewritten') WHERE id = ${newer.id}::uuid`;
  const [pre] = await sql`SELECT to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NULL AS none,
                                 (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'derivations' AND column_name IN ('stale_since', 'stale_reason')) AS cols,
                                 (SELECT count(*)::int FROM derivations) AS rows`;
  assert(pre.none === true && Number(pre.cols) === 0 && Number(pre.rows) === 6, `before 063 there is no rebuild and no mark, and six lineage rows stand — two vectors, two extractions, a proposal, the orphaned chunks row (${pre.rows})`);
  let refusedStale = "";
  try { await sql`UPDATE supersession_proposals SET status = 'stale' WHERE id = ${pid}::uuid`; } catch (e) { refusedStale = (e as Error).message; }
  assert(/check constraint/.test(refusedStale), "at 062 the status CHECK refuses stale");
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata, embedding::text AS e, embedding_model, updated_at::text AS u FROM thoughts ORDER BY id`);
  const lineage = async () => JSON.stringify(await sql`SELECT id, artifact_kind, artifact_id, produced_by, produced_at::text AS at, recipe, input_fingerprints FROM derivations ORDER BY 1`);
  const before = await stamps(), lineageBefore = await lineage();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("063") });

  const [post] = await sql`SELECT (SELECT count(*)::int FROM derivations WHERE stale_since IS NOT NULL OR stale_reason IS NOT NULL) AS marked,
                                  (SELECT count(*)::int FROM derivations) AS rows,
                                  to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NOT NULL AS rb,
                                  to_regprocedure('derivation_descendants(uuid, int, int)') IS NOT NULL AS walk,
                                  (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('consolidation_candidates(uuid, int, float)')) LIKE '%p.status <> ''stale''%' AS cands,
                                  (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid, text, text, jsonb)')) LIKE '%WHERE supersession_proposals.status = ''stale''%' AS writer,
                                  (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('ob1_record_derivation(text, uuid, uuid[], text[], text, jsonb, uuid)')) LIKE '%ob1:rerun-clears-the-mark%' AS mark,
                                  (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'supersession_proposals'::regclass AND conname IN ('supersession_proposals_status_check', 'supersession_proposals_unreviewed_check')) AS checks`;
  assert(Number(post.marked) === 0 && Number(post.rows) === Number(pre.rows) && post.rb === true && post.walk === true && post.cands === true && post.writer === true && post.mark === true && Number(post.checks) === 2,
    "063 lands: the two columns NULL on every row, no row added or removed, the walk and the primitive present, the three bodies redefined, the two named CHECKs in place");
  assert(Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === Number(auditBefore) && (await stamps()) === before && (await lineage()) === lineageBefore, "the file is DDL alone: no audit row, no thought moved, no lineage row moved");
  // The rebuild on the corpus as it stands: the orphan chunks row deleted,
  // the stale extraction handed on under its own key (ob1_config records no
  // extraction key on this brain), the stale vector to the reembed pool under the model 006
  // recorded, the pending proposal set stale and the pair requeued.
  const r = (await sql`SELECT rebuild_derived(${newer.id}::uuid, 'upgrade') AS r`)[0].r as { ok: boolean; deleted: number; enqueued: number; marked: number; rebuilt: number; pools: string[]; current: number };
  const claims = (await sql`SELECT work_type AS w FROM thought_work_claims WHERE thought_id = ${newer.id}::uuid AND status = 'pending' ORDER BY 1`).map((c: { w: string }) => c.w).join();
  assert(r.ok === true && r.deleted === 1 && r.enqueued === 3 && r.rebuilt === 0 && r.marked === 2 && r.current === 0 && claims === `consolidate:judge@p3,extract:m@p2,reembed:${OPTS.model}@${OPTS.dim}`
      && (await sql`SELECT status FROM supersession_proposals WHERE id = ${pid}::uuid`)[0].status === "stale",
    `a rebuild the day after: the orphan row deleted, the extraction, the vector and the pair handed to three pools, the proposal stale (${JSON.stringify(r)}; claims ${claims})`);
  // A re-apply is a no-op: the same shape, no row moved, the marks kept.
  const checks = async () => JSON.stringify(await sql`SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'supersession_proposals'::regclass AND contype = 'c' ORDER BY conname`);
  const shapeAfter = await shape(sql), again = await stamps(), lineageAfter = await lineage(), checksAfter = await checks();
  const marksAfter = JSON.stringify(await sql`SELECT id, stale_since::text AS s, stale_reason AS r FROM derivations ORDER BY 1`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("063") });
  assert(JSON.stringify(await shape(sql)) === JSON.stringify(shapeAfter) && (await stamps()) === again && (await lineage()) === lineageAfter && JSON.stringify(await sql`SELECT id, stale_since::text AS s, stale_reason AS r FROM derivations ORDER BY 1`) === marksAfter
      && (await checks()) === checksAfter && /'stale'/.test(checksAfter)
      && (await sql`SELECT status FROM supersession_proposals WHERE id = ${pid}::uuid`)[0].status === "stale",
    "re-applying 063 is a no-op: the shape as it left it, the proposal CHECKs as it wrote them (dropped and re-added by the same definitions), no row moved, the marks and the stale status kept");
  await sql.close();

  // The guard, driven ([20g]'s shape): a brain with a ledger planted through
  // 063 whose schema stops before 016, then 029, then 060, then 061.
  for (const [stop, needs] of [
    ["016", "migration 063 needs 016 \\(requeue_thought_work, the entity tables\\); this schema lacks it"],
    ["029", "migration 063 needs 029 \\(supersession_proposals, consolidation_candidates\\); this schema lacks it"],
    ["060", "migration 063 needs 060 \\(ob1_refresh_thought_vector, ob1_embedding_snapshot\\); this schema lacks it"],
    ["061", "migration 063 needs 061 \\(derivations, ob1_record_derivation, the 11-argument record_supersession_proposal\\); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    await plantLedger(URL_);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the063 = MIGRATIONS.find((f) => f.startsWith("063_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the063}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`063_rebuild_derived\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
    assert(ok, `a plain run fails at 063 naming ${stop} and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
    assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the063}`)[0].c) === 0, `…063 records nothing without ${stop}`);
    await sql2.close();
  }
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "061" });
  const sql3 = new SQL({ url: URL_, max: 1 });
  const [present] = await sql3`SELECT to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)') IS NOT NULL AS rb, (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'derivations' AND column_name IN ('stale_since', 'stale_reason')) AS cols`;
  assert(present.rb === true && Number(present.cols) === 2, "…and applied once every prerequisite is there: the primitive and the mark's columns are present");
  await sql3.close();
}

console.log("\n[20p] Migration 064 onto a populated brain at the file before it — the three tables and the store's functions added, 061's kind CHECK widened and its writer redefined on its own body, no audit row written, no row moved, no lineage row moved; a page written the day after is a thought with its render; a re-apply a no-op; refused up front without 025, 032, 060 or 061, naming the migration and --reapply (SMD-1812)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "064" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const laptop = (await sql`SELECT resolve_agent(${"a".repeat(64)}, 'laptop', 'write') AS r`)[0].r as { agent_id: string };
  const actor = { name: "laptop", agent_id: laptop.agent_id, via: "open-brain" };
  // A corpus at 063: two thoughts with vectors (each with a vector lineage row).
  const a = (await sql`SELECT upsert_thought('upgrade 064: evidence a', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  await sql`SELECT upsert_thought('upgrade 064: evidence b', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(1)}::vector)`;
  // metadata.trust left out: the re-apply below applies the files after 064
  // as pending, and 073's backfill stamps trust onto these rows on its first
  // apply — 073's own move, held by [20x], not 064's.
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata - 'trust' AS metadata, embedding::text AS e, embedding_model, derived_from, updated_at::text AS u FROM thoughts ORDER BY id`);
  const lineage = async () => JSON.stringify(await sql`SELECT artifact_kind, artifact_id, produced_by, produced_at::text AS at, recipe FROM derivations ORDER BY 1, 2, 3`);
  const before = await stamps(), lineageBefore = await lineage();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  const [pre] = await sql`SELECT to_regclass('pages') IS NULL AS no_pages, pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'derivations_artifact_kind_check')) AS chk`;
  assert(pre.no_pages === true && !/'section'/.test(String(pre.chk)), "before 064 there is no page store and the lineage kinds are 061's five");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("064") });

  const [post] = await sql`SELECT to_regclass('pages') IS NOT NULL AS pages, to_regclass('page_sections') IS NOT NULL AS sections, to_regclass('page_section_revisions') IS NOT NULL AS revisions,
                                  pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'derivations_artifact_kind_check')) AS chk,
                                  (SELECT count(*)::int FROM pg_proc WHERE proname IN ('upsert_page', 'write_page_section', 'accept_page_section', 'release_page_section', 'lock_page_section', 'delete_page_section', 'render_page', 'page_sections_as_of')) AS fns,
                                  (SELECT count(*)::int FROM pg_proc WHERE proname = 'ob1_record_derivation') AS writers,
                                  (SELECT prosrc LIKE '%''section''%' FROM pg_proc WHERE proname = 'ob1_record_derivation') AS widened`;
  assert(post.pages === true && post.sections === true && post.revisions === true && /'section'/.test(String(post.chk)) && Number(post.fns) === 8 && Number(post.writers) === 1 && post.widened === true,
    "…and after: the three tables, the eight functions, the kind CHECK carrying section, one ob1_record_derivation admitting it");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore) && (await stamps()) === before && (await lineage()) === lineageBefore, "the file is additive: no audit row written, no thought moved, no lineage row moved");
  assert(Number((await sql`SELECT count(*)::int AS c FROM pages`)[0].c) === 0, "no seed row: core ships no fixture page");

  // The day after: a page is a thought whose content is its render, its
  // generated section's lineage recorded live.
  const pg = (await sql`SELECT upsert_page('upgrade-064', 'Upgrade 064', 'topic', '{}'::jsonb, 'alice') AS r`)[0].r as { page_id: string; created: boolean };
  const sec = (await sql`SELECT write_page_section(${pg.page_id}::uuid, 'body', 'Written after the upgrade.', 'generated', 'Body', '{"model": "stub"}'::jsonb, ${sql.array([a.id], "TEXT")}::uuid[], 10, 'gen') AS r`)[0].r as { section_id: string; action: string };
  const [th] = await sql`SELECT content, derived_from, embedding IS NULL AS novec, metadata->>'source' AS source FROM thoughts WHERE id = ${pg.page_id}::uuid`;
  const [ln] = await sql`SELECT input_fingerprints AS fps, recipe FROM derivations WHERE artifact_kind = 'section' AND artifact_id = ${sec.section_id}::uuid`;
  assert(pg.created === true && sec.action === "created" && th.content === "# Upgrade 064\n\n## Body\n\nWritten after the upgrade." && JSON.stringify(th.derived_from) === JSON.stringify([a.id]) && th.novec === true && th.source === "pages" && (ln.fps as string[]).join() === a.fingerprint && (ln.recipe as { deterministic: boolean }).deterministic === false,
    "a page written after the upgrade is a thought holding its render and its evidence, its generated section's lineage recorded at the evidence's fingerprint");
  // A re-apply moves nothing.
  const stampsAfter = await stamps(), lineageAfter = await lineage();
  const [{ c: revsBefore }] = await sql`SELECT count(*)::int AS c FROM page_section_revisions`;
  const re = await migrate("--reapply");
  const [{ c: revsAfter }] = await sql`SELECT count(*)::int AS c FROM page_section_revisions`;
  assert(re.code === 0 && (await stamps()) === stampsAfter && (await lineage()) === lineageAfter && Number(revsAfter) === Number(revsBefore) && Number((await sql`SELECT count(*)::int AS c FROM pg_proc WHERE proname = 'write_page_section'`)[0].c) === 1,
    `a re-apply is a no-op: no thought, lineage row or revision moved, one write_page_section (exit ${re.code})`);
  await sql.close();

  // The guard, driven ([20n]'s shape): a brain with a ledger planted through
  // 064 whose schema stops before 025, then 032, then 060, then 061, then 063.
  for (const [stop, needs] of [["025", "migration 064 needs 025 \\(thoughts\\.derived_from\\); this schema lacks it"], ["032", "migration 064 needs 032 \\(validate_derived_from, update_thought's provenance envelope\\); this schema lacks it"], ["060", "migration 064 needs 060 \\(ob1_project_thought_event, the write functions that append then project\\); this schema lacks it"], ["061", "migration 064 needs 061 \\(derivations, ob1_record_derivation, ob1_actor_agent_id\\); this schema lacks it"], ["063", "migration 064 needs 063 \\(derivations\\.stale_since, the rebuild's mark ob1_record_derivation clears\\); this schema lacks it"]] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    await plantLedger(URL_);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the064 = MIGRATIONS.find((f) => f.startsWith("064_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the064}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`064_pages\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
    assert(ok, `a plain run fails at 064 naming ${stop} and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
    assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the064}`)[0].c) === 0, `…064 records nothing without ${stop}`);
    await sql2.close();
  }
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "061" });
  const sql3 = new SQL({ url: URL_, max: 1 });
  const [present] = await sql3`SELECT to_regclass('pages') IS NOT NULL AS t, to_regprocedure('write_page_section(uuid, text, text, text, text, jsonb, uuid[], integer, text)') IS NOT NULL AS w`;
  assert(present.t === true && present.w === true, "…and applied once every prerequisite is there: the table and the guard are present");
  await sql3.close();
}

console.log("\n[20q] Migration 065 on a schema without 016, and on 016's tables without 056's — refused up front, naming the missing migration and --reapply, and applied once both are there (SMD-2300)");
{
  // 065's guard is 056's shape ([20j]): it redefines entity_type_gate (whose SQL
  // body reads normalize_entity_name, 016) and re-runs apply_entity_type_gate
  // (056), so a schema stopping before 016 would fail at the CREATE with a bare
  // "function normalize_entity_name(text) does not exist", and one with 016's
  // tables but not 056's at the pass with a bare "apply_entity_type_gate() does
  // not exist".
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "016" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the065 = MIGRATIONS.find((f) => f.startsWith("065_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the065}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /065_identifier_allowlist\.sql\s+FAILED: migration 065 needs 016 \(ob1_entities\) and 056 \(entity_type_gate, apply_entity_type_gate\); this schema lacks 016/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 065 naming 016 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the065}`)[0].c) === 0, "…065 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "016" && f < "056" });
  const half = await migrate();
  assert(half.code === 1 && /065_identifier_allowlist\.sql\s+FAILED: migration 065 needs 056 \(entity_type_gate, apply_entity_type_gate\); this schema lacks them/.test(half.out),
    `…and with 016's tables but not 056's it names 056 (exit ${half.code})${half.code === 1 ? "" : `:\n${half.out}`}`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "056" });
  const [body] = await sql`SELECT prosrc AS s FROM pg_proc WHERE oid = 'entity_type_gate(text, text)'::regprocedure`;
  assert(/SMD-2300/.test(String(body?.s ?? "")) && String(body?.s ?? "").includes("[A-Za-z]{2,}-[0-9]{3,}"), "…and applied once both are there: the live entity_type_gate carries 065's good-shape allowlist (the three-or-more-digit ticket shape)");
}

console.log("\n[20r] Migration 066 onto a populated brain at the file before it — the candidate filter redefined on 063's body, no audit row written, no row moved, no lineage row moved; a page re-embedded and extracted at 064 listed its own evidence as a candidate before the file and lists the unrelated note alone after it; a re-apply a no-op; refused by name without 025, 029 or 063 (SMD-2292)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "066" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  const SIG = "consolidation_candidates(uuid, int, float)";
  // A corpus at 064: the evidence E and an unrelated note D on E's axis, ten
  // days old, both mentioning Alice; a page generated from E, re-embedded
  // through the 11-argument update_thought and extracted — the state
  // SMD-2292 measured.
  const e = (await sql`SELECT upsert_thought('upgrade 066: the evidence', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  const d = (await sql`SELECT upsert_thought('upgrade 066: an unrelated note', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  await sql`UPDATE thoughts SET created_at = now() - interval '10 days' WHERE id IN (${e.id}::uuid, ${d.id}::uuid)`;
  // A second evidence thought, e2: the page cites both, and a proposal on
  // (e2, page) is planted under 063's body before the file — the row 066
  // leaves standing (second review pass: "left as it stands" was unpinned).
  const e2 = (await sql`SELECT upsert_thought('upgrade 066: the second evidence', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  // A third, e3, whose proposal is set stale raw (063's status; the table's
  // one trigger is 061's lineage drop) — under 063's body a stale pair is
  // re-found, the consequence measured before the file; and the table is
  // read whole beside stamps(), so "no row moves" is pinned for every row,
  // not the pending one alone (run-it, third review pass: an auto-reject of
  // stale rows survived this suite).
  const e3 = (await sql`SELECT upsert_thought('upgrade 066: the third evidence', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  await sql`UPDATE thoughts SET created_at = now() - interval '10 days' WHERE id IN (${e2.id}::uuid, ${e3.id}::uuid)`;
  const pg = (await sql`SELECT upsert_page('upgrade-066', 'Upgrade 066', 'topic', '{}'::jsonb, 'alice') AS r`)[0].r as { page_id: string };
  const sec = (await sql`SELECT write_page_section(${pg.page_id}::uuid, 'body', 'Generated from the evidence.', 'generated', 'Body', '{"model": "stub"}'::jsonb, ${sql.array([e.id, e2.id, e3.id], "TEXT")}::uuid[], 10, 'gen') AS r`)[0].r as { action: string };
  const [{ content }] = await sql`SELECT content FROM thoughts WHERE id = ${pg.page_id}::uuid`;
  const re = (await sql`SELECT update_thought(${pg.page_id}::uuid, ${content}::text, NULL::jsonb, ${vec(0)}::vector, NULL::jsonb, NULL::timestamptz, ${actor}::jsonb, ${OPTS.model}::text, NULL::jsonb, NULL::jsonb, NULL::jsonb) AS r`)[0].r as { ok: boolean };
  const extracted: boolean[] = [];
  for (const id of [e.id, e2.id, e3.id, d.id, pg.page_id])
    extracted.push(((await sql`SELECT record_thought_entities(${id}::uuid, 'extract:m@p2', '[{"name": "Alice", "type": "person", "confidence": 0.9}]'::jsonb, '[]'::jsonb, NULL, NULL) AS r`)[0].r as { ok: boolean }).ok);
  assert(extracted.length === 5 && extracted.every((ok) => ok === true), `the corpus at 064 carries an extraction on each of the five thoughts (${extracted.join()})`);
  const pid = (await sql`SELECT record_supersession_proposal(${e2.id}::uuid, ${pg.page_id}::uuid, 'newer_supersedes_older', 0.9, 'a page over its evidence, judged at 064', 0.99, 'consolidate:judge@p3') AS id`)[0].id as string;
  const proposalRow = async () => JSON.stringify((await sql`SELECT status, verdict, judge_key, judged_at::text AS j, reviewed_at::text AS r, older_id, newer_id FROM supersession_proposals WHERE id = ${pid}::uuid`)[0]);
  const proposalBefore = await proposalRow();
  const pid3 = (await sql`SELECT record_supersession_proposal(${e3.id}::uuid, ${pg.page_id}::uuid, 'newer_supersedes_older', 0.9, 'a page over its third evidence, judged at 064', 0.99, 'consolidate:judge@p3') AS id`)[0].id as string;
  await sql`UPDATE supersession_proposals SET status = 'stale' WHERE id = ${pid3}::uuid`;
  const proposals = async () => JSON.stringify(await sql`SELECT id, older_id, newer_id, status, reviewed_at::text AS r, review_note FROM supersession_proposals ORDER BY id`);
  const proposalsBefore = await proposals();
  assert(typeof pid === "string" && /"status":"pending"/.test(proposalBefore) && typeof pid3 === "string" && (await sql`SELECT status FROM supersession_proposals WHERE id = ${pid3}::uuid`)[0].status === "stale",
    "…and a proposal that the page supersedes its second evidence stands pending, recorded under 063's body, and one on its third evidence stands stale");
  const cands = async (): Promise<string> => (await sql`SELECT older_id::text AS o FROM consolidation_candidates(${pg.page_id}::uuid, 5, 0) ORDER BY 1`).map((r: { o: string }) => r.o).join();
  const excludes = async () => (await sql`SELECT prosrc LIKE '%ob1:lineage-excludes-the-pair%' AS x, (SELECT count(*)::int FROM pg_proc WHERE proname = 'consolidation_candidates') AS n FROM pg_proc WHERE oid = to_regprocedure(${SIG})`)[0] as { x: boolean; n: number };
  const pre = await excludes();
  const name = (o: string) => (o === e.id ? "E" : o === d.id ? "D" : o === e2.id ? "E2" : o === e3.id ? "E3" : o);
  assert(sec.action === "created" && re.ok === true && pre.x === false && Number(pre.n) === 1 && (await cands()) === [d.id, e.id, e3.id].sort().join(),
    `before 066 the page's candidates are its own evidence, the unrelated note and the third evidence whose pair is stale (063 re-finds it) — the pairs SMD-2292 measured — and not the second evidence, whose pending proposal holds the pair (029's rule) (${(await cands()).split(",").map(name).join()})`);
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata, embedding::text AS e, embedding_model, derived_from, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const lineage = async () => JSON.stringify(await sql`SELECT artifact_kind, artifact_id, produced_by, produced_at::text AS at, recipe FROM derivations ORDER BY 1, 2, 3`);
  const before = await stamps(), lineageBefore = await lineage();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("066") });

  const post = await excludes();
  assert(post.x === true && Number(post.n) === 1 && (await cands()) === d.id, "…and after: one consolidation_candidates carrying the rule, and the page's candidates are the unrelated note alone");
  assert((await proposalRow()) === proposalBefore && (await proposals()) === proposalsBefore, "…and the proposals planted on the lineage pairs stand as they were — the pending one unreviewed with the same verdict and key, the stale one stale, the table whole: the file writes no verdict (SMD-2313 will flag them)");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore) && (await stamps()) === before && (await lineage()) === lineageBefore, "the file is DDL alone: no audit row written, no thought moved, no lineage row moved");
  // The other direction, on a real server: the page moved older than its
  // evidence (a created_at set by hand), E never lists it while D does. After
  // the DDL-alone read: the raw UPDATE moves updated_at through 001's
  // trigger, so the created_at is put back and the re-apply's stamps are
  // taken after it (run-it, first review pass: the condition's drop survived
  // this suite).
  const [{ c0 }] = await sql`SELECT created_at::text AS c0 FROM thoughts WHERE id = ${pg.page_id}::uuid`;
  await sql`UPDATE thoughts SET created_at = now() - interval '20 days' WHERE id = ${pg.page_id}::uuid`;
  const listsPage = async (id: string) => (await sql`SELECT 1 FROM consolidation_candidates(${id}::uuid, 5, 0) WHERE older_id = ${pg.page_id}::uuid`).length === 1;
  assert((await listsPage(e.id)) === false && (await listsPage(d.id)) === true, "…and the older page is never a candidate of the evidence it names, while it is one of the note it does not");
  await sql`UPDATE thoughts SET created_at = ${c0}::timestamptz WHERE id = ${pg.page_id}::uuid`;
  // A re-apply moves nothing. The ledger first: the suite's applier writes
  // none, and the migrator's first run would create schema_migrations — a
  // shape move that is the ledger's, not the file's (run-it, the build; a
  // brain has its ledger). The files after 066 first too: the planted ledger
  // records EVERY file in the tree as applied, so a --reapply over a schema stopped
  // at 066 would apply a later file for real and move the shape — the
  // ledger's claim, not the file's (SMD-2297's 067 was the first such file;
  // caught when it landed beside this leg). Each condition named on failure:
  // a bundled assertion said only "no".
  await applyMigrations(URL_, { ...OPTS, only: (f) => f > "066" });
  await plantLedger(URL_);
  const shapeAfter = await shape(sql), stampsAfter = await stamps(), proposalsAfter = await proposals();
  const re2 = await migrate("--reapply");
  const firstDiff = (a: string, b: string) => { const x = JSON.parse(a) as Record<string, unknown>[], y = JSON.parse(b) as Record<string, unknown>[]; for (let i = 0; i < Math.max(x.length, y.length); i++) for (const k of new Set([...Object.keys(x[i] ?? {}), ...Object.keys(y[i] ?? {})])) if (JSON.stringify(x[i]?.[k]) !== JSON.stringify(y[i]?.[k])) return `row ${i} ${k}: ${JSON.stringify(x[i]?.[k])} -> ${JSON.stringify(y[i]?.[k])}`; return ""; };
  const stampsRe = await stamps();
  const failed = [re2.code !== 0 && `exit ${re2.code}`, JSON.stringify(await shape(sql)) !== JSON.stringify(shapeAfter) && "shape moved", stampsRe !== stampsAfter && `a thought moved (${firstDiff(stampsAfter, stampsRe)})`, (await proposals()) !== proposalsAfter && "a proposal moved", (await excludes()).x !== true && "the rule gone", (await cands()) !== d.id && `candidates ${await cands()}`].filter(Boolean);
  assert(failed.length === 0, `a re-apply is a no-op: the shape as it left it, no thought moved, the rule standing (${failed.join("; ") || "exit 0"})`);
  await sql.close();

  // The guard, driven ([20p]'s shape): a brain with a ledger planted through
  // 066 whose schema stops before 025, then 029, then 063.
  for (const [stop, needs] of [
    ["025", "migration 066 needs 025 \\(thoughts\\.derived_from\\); this schema lacks it"],
    ["029", "migration 066 needs 029 \\(supersession_proposals, consolidation_candidates\\); this schema lacks it"],
    ["063", "migration 066 needs 063 \\(the stale proposal status this body reads\\); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    await plantLedger(URL_);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the066 = MIGRATIONS.find((f) => f.startsWith("066_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the066}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`066_lineage_excludes_candidates\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
    assert(ok, `a plain run fails at 066 naming ${stop} and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
    assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the066}`)[0].c) === 0, `…066 records nothing without ${stop}`);
    await sql2.close();
  }
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "063" });
  const sql3 = new SQL({ url: URL_, max: 1 });
  const [present] = await sql3`SELECT prosrc LIKE '%ob1:lineage-excludes-the-pair%' AS x FROM pg_proc WHERE oid = to_regprocedure(${SIG})`;
  assert(present.x === true, "…and applied once every prerequisite is there: the body carries the rule");
  await sql3.close();
}

console.log("\n[20s] Migration 067 onto a populated brain at 063 — settle_supersession_proposal lands, rebuild_derived is 067's, the status column's and the table's comments name it; a proposal the pass settled (its note carrying the marker) goes stale again on a text move while a person's rejection is kept; a re-apply is a no-op; refused by name without 036, 061 or 063 (SMD-2297)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "067" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  const MARKER = "settled by the pass:";
  const JUDGE = "consolidate:judge@p3";
  const status = async (id: string) => (await sql`SELECT status, reviewed_at::text AS at, review_note AS note FROM supersession_proposals WHERE id = ${id}::uuid`)[0] as { status: string; at: string | null; note: string | null };
  // A corpus at 063: an older thought and two newer ones sharing Alice, a
  // proposal on each pair, both rejected through review_supersession_proposal
  // — one with the note 067's pass writes (what a pass at 063 could only have
  // done by hand), one with a person's.
  const older = (await sql`SELECT upsert_thought('upgrade 067: the older note', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  await sql`UPDATE thoughts SET created_at = now() - interval '3 days' WHERE id = ${older.id}::uuid`;
  const settledNewer = (await sql`SELECT upsert_thought('upgrade 067: the newer note the pass settled', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  const personNewer = (await sql`SELECT upsert_thought('upgrade 067: the newer note a person rejected', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(2)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  for (const id of [older.id, settledNewer.id, personNewer.id]) {
    const e = (await sql`SELECT record_thought_entities(${id}::uuid, 'extract:m@p2', '[{"name": "Alice", "type": "person", "confidence": 0.9}]'::jsonb, '[]'::jsonb, NULL, NULL) AS r`)[0].r as { ok: boolean };
    assert(e.ok === true, "the corpus at 063 carries an extraction on each thought");
  }
  const pSettled = (await sql`SELECT record_supersession_proposal(${older.id}::uuid, ${settledNewer.id}::uuid, 'newer_supersedes_older', 0.9, 'because', 0.8, ${JUDGE}) AS id`)[0].id as string;
  const pPerson = (await sql`SELECT record_supersession_proposal(${older.id}::uuid, ${personNewer.id}::uuid, 'newer_supersedes_older', 0.9, 'because', 0.8, ${JUDGE}) AS id`)[0].id as string;
  const passNote = `${MARKER} judged again after a text moved — unrelated at ${JUDGE}`;
  for (const [id, note] of [[pSettled, passNote], [pPerson, "no: the operator read both"]] as const) {
    const r = (await sql`SELECT review_supersession_proposal(${id}::uuid, 'reject', ${note}::text, NULL, ${actor}::jsonb, false) AS r`)[0].r as { ok: boolean };
    assert(r.ok === true, "each proposal is rejected at 063");
  }
  const [pre] = await sql`SELECT to_regprocedure('settle_supersession_proposal(uuid, text, jsonb, text, text, text, jsonb, uuid)') IS NULL AS none,
                                 (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)')) LIKE '%ob1:pass-settled-is-the-pass-to-reopen%' AS reopens,
                                 col_description('supersession_proposals'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'supersession_proposals'::regclass AND attname = 'status')) LIKE '%067%' AS named`;
  assert(pre.none === true && pre.reopens === false && pre.named === false, "before 067 there is no settle function, rebuild_derived keeps every rejected row, and the status comment is 063's");
  // 063's rule, shown: a text move under the pass-noted rejection keeps it.
  await sql`UPDATE thoughts SET content = 'upgrade 067: the newer note the pass settled, rewritten', content_fingerprint = content_fingerprint_of('upgrade 067: the newer note the pass settled, rewritten') WHERE id = ${settledNewer.id}::uuid`;
  const at063 = (await sql`SELECT rebuild_derived(${settledNewer.id}::uuid, 'upgrade at 063') AS r`)[0].r as { ok: boolean; kept: number; stale_proposals: number };
  assert(at063.ok === true && at063.kept === 1 && at063.stale_proposals === 0 && (await status(pSettled)).status === "rejected", `at 063 the pass-noted rejection is kept as any decision (${JSON.stringify(at063)})`);
  await sql`DELETE FROM thought_work_claims WHERE thought_id = ${settledNewer.id}::uuid`;
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata, embedding::text AS e, embedding_model, updated_at::text AS u FROM thoughts ORDER BY id`);
  const lineage = async () => JSON.stringify(await sql`SELECT id, artifact_kind, artifact_id, produced_by, produced_at::text AS at, recipe, input_fingerprints, stale_since::text AS s, stale_reason AS r FROM derivations ORDER BY 1`);
  const rows = async () => JSON.stringify(await sql`SELECT id, status, reviewed_at::text AS at, review_note, judge_key FROM supersession_proposals ORDER BY id`);
  const before = await stamps(), lineageBefore = await lineage(), rowsBefore = await rows();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("067") });

  const [post] = await sql`SELECT to_regprocedure('settle_supersession_proposal(uuid, text, jsonb, text, text, text, jsonb, uuid)') IS NOT NULL AS settle,
                                  (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)')) LIKE '%ob1:pass-settled-is-the-pass-to-reopen%' AS reopens,
                                  (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)')) LIKE '%ob1:rebuild-acts-on-a-held-frontier%' AS frontier,
                                  col_description('supersession_proposals'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'supersession_proposals'::regclass AND attname = 'status')) LIKE '%067%' AS named,
                                  obj_description('supersession_proposals'::regclass, 'pg_class') LIKE '%067%' AS table_named,
                                  obj_description(to_regprocedure('rebuild_derived(uuid, text, boolean, text[], boolean, boolean)'), 'pg_proc') LIKE '%067%' AS fn_named,
                                  (SELECT count(*)::int FROM pg_proc WHERE proname = 'rebuild_derived') AS forms`;
  assert(post.settle === true && post.reopens === true && post.frontier === true && post.named === true && post.table_named === true && post.fn_named === true && Number(post.forms) === 1,
    "067 lands: the settle function present, rebuild_derived redefined in one form carrying both sentinels, the three comments naming 067");
  assert(Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === Number(auditBefore) && (await stamps()) === before && (await lineage()) === lineageBefore && (await rows()) === rowsBefore, "the file is DDL alone: no audit row, no thought, lineage row or proposal moved");
  // 067's rule: the pass-noted rejection is reopened by the move it kept at
  // 063 — stale, unreviewed, the note cleared, the pair requeued — while a
  // person's rejection is kept.
  const reopened = (await sql`SELECT rebuild_derived(${settledNewer.id}::uuid, 'upgrade') AS r`)[0].r as { ok: boolean; kept: number; stale_proposals: number };
  const s1 = await status(pSettled);
  assert(reopened.ok === true && reopened.stale_proposals === 1 && reopened.kept === 0 && s1.status === "stale" && s1.at === null && s1.note === null
      && (await sql`SELECT count(*)::int AS c FROM thought_work_claims WHERE thought_id = ${settledNewer.id}::uuid AND work_type = ${JUDGE} AND status = 'pending'`)[0].c === 1,
    `the day after: the same move reopens the pass-settled row — stale, unreviewed, no note, the pair requeued under the judge's key (${JSON.stringify(reopened)}; ${JSON.stringify(s1)})`);
  await sql`UPDATE thoughts SET content = 'upgrade 067: the newer note a person rejected, rewritten', content_fingerprint = content_fingerprint_of('upgrade 067: the newer note a person rejected, rewritten') WHERE id = ${personNewer.id}::uuid`;
  const kept = (await sql`SELECT rebuild_derived(${personNewer.id}::uuid, 'upgrade') AS r`)[0].r as { ok: boolean; kept: number; stale_proposals: number };
  assert(kept.ok === true && kept.kept === 1 && kept.stale_proposals === 0 && (await status(pPerson)).status === "rejected", `…and a person's rejection is kept (${JSON.stringify(kept)})`);
  // The settle, as the pass calls it: rejected with the marker, the lineage row at the texts judged under the settling key.
  const settledFp = (await sql`SELECT content_fingerprint_of(content) AS f FROM thoughts WHERE id = ${settledNewer.id}::uuid`)[0].f as string;
  const settled = (await sql`SELECT settle_supersession_proposal(${pSettled}::uuid, ${passNote}::text, ${actor}::jsonb, 'consolidate:judge@p4', ${older.fingerprint}::text, ${settledFp}::text, '{"deterministic": false, "settled": "unrelated"}'::jsonb) AS r`)[0].r as { ok: boolean; settled?: boolean };
  const s2 = await status(pSettled);
  const lin = (await sql`SELECT produced_by AS by, input_fingerprints AS fps FROM derivations WHERE artifact_kind = 'proposal' AND artifact_id = ${pSettled}::uuid`) as { by: string; fps: string[] }[];
  assert(settled.ok === true && settled.settled === true && s2.status === "rejected" && s2.note === passNote && lin.length === 1 && lin[0].by === "consolidate:judge@p4" && lin[0].fps.join() === `${older.fingerprint},${settledFp}`,
    `the settle rejects the stale row with the marker and rewrites its lineage row at the texts judged under the settling key (${JSON.stringify(lin)})`);
  // A re-apply is a no-op.
  const shapeAfter = await shape(sql), again = await stamps(), lineageAfter = await lineage(), rowsAfter = await rows();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("067") });
  assert(JSON.stringify(await shape(sql)) === JSON.stringify(shapeAfter) && (await stamps()) === again && (await lineage()) === lineageAfter && (await rows()) === rowsAfter,
    "re-applying 067 is a no-op: the shape as it left it, no thought, lineage row or proposal moved");
  await sql.close();

  // The guard, driven ([20g]'s shape): a brain with a ledger planted through
  // 067 whose schema stops before 036, then 061, then 063.
  for (const [stop, needs] of [
    ["036", "migration 067 needs 036 \\(review_supersession_proposal\\) and 061 \\(ob1_record_derivation\\); this schema lacks them"],
    ["061", "migration 067 needs 036 \\(review_supersession_proposal\\) and 061 \\(ob1_record_derivation\\); this schema lacks them"],
    ["063", "migration 067 needs 063 \\(rebuild_derived, the mark's columns, the stale proposal status\\); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    await plantLedger(URL_);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the067 = MIGRATIONS.find((f) => f.startsWith("067_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the067}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`067_pass_settles_stale\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
    assert(ok, `a plain run fails at 067 naming ${stop} and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
    assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the067}`)[0].c) === 0, `…067 records nothing without ${stop}`);
    await sql2.close();
  }
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "063" });
  const sql3 = new SQL({ url: URL_, max: 1 });
  const [present] = await sql3`SELECT to_regprocedure('settle_supersession_proposal(uuid, text, jsonb, text, text, text, jsonb, uuid)') IS NOT NULL AS settle`;
  assert(present.settle === true, "…and applied once every prerequisite is there: the settle function is present");
  await sql3.close();
}

console.log("\n[20t] Migration 068 on a schema without 058 — refused up front, naming 058 and --reapply; applied over a brain with tickets and pointers, node_state() reads what 058's did and the seed leaves no drift (SMD-2256)");
{
  // 068's bodies are SQL, validated at CREATE, and it redefines 058's two
  // reads: without the guard a schema stopping before 058 would fail at a
  // bare "function node_dependencies() does not exist". 025 is older than
  // every schema that reaches 058, so 058 is the check reached here.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "058" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the068 = MIGRATIONS.find((f) => f.startsWith("068_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the068}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /068_node_state_projection\.sql\s+FAILED: migration 068 needs 058 \(node_state\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 068 naming 058 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the068}`)[0].c) === 0, "…068 records nothing");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "058" && f < "068" });
  // A brain 058 already reads: a ticket whose earlier row its head
  // supersedes, a note under it, a Done ticket, a row superseded twice.
  const row = async (content: string, meta: Record<string, unknown>) =>
    (await sql`INSERT INTO thoughts (content, metadata) VALUES (${content}, ${meta}::jsonb) RETURNING id`)[0].id as string;
  const head = await row("[20t] the head", { issue: "U-1", status: "Done", status_type: "completed", linear_updated_at: "2026-09-01" });
  const prev = await row("[20t] the earlier row", { issue: "U-1", status: "In Progress", status_type: "started", linear_updated_at: "2026-09-02" });
  await row("[20t] a note", { ticket: "U-1" });
  await row("[20t] a live ticket", { issue: "U-2", status: "Todo", status_type: "unstarted" });
  const old = await row("[20t] superseded twice", {});
  await sql`UPDATE thoughts SET supersedes = ${prev} WHERE id = ${head}`;
  await row("[20t] first successor", {}).then((id) => sql`UPDATE thoughts SET supersedes = ${old}, created_at = now() - interval '1 hour' WHERE id = ${id}`);
  await row("[20t] second successor", {}).then((id) => sql`UPDATE thoughts SET supersedes = ${old} WHERE id = ${id}`);
  const before = (await sql`SELECT * FROM node_state() ORDER BY thought_id`).map((r: Record<string, unknown>) => JSON.stringify(r));
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "068" });
  const after = (await sql`SELECT * FROM node_state() ORDER BY thought_id`).map((r: Record<string, unknown>) => JSON.stringify(r));
  const [state] = await sql`SELECT (SELECT count(*)::int FROM ob1_node_projection_drift()) AS drift, (SELECT count(*)::int FROM ob1_ticket_head) AS heads,
                                   (SELECT count(*)::int FROM ob1_superseded_by) AS sup, (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('node_lifecycle()')) AS body`;
  assert(before.length === 7 && JSON.stringify(after) === JSON.stringify(before) && state.drift === 0 && state.heads === 2 && state.sup === 2 && /ob1_ticket_head/.test(String(state.body)),
    `…and applied once 058 is there: node_state() reads what 058's did row for row, the seed wrote two heads and two superseders, drift() is empty and node_lifecycle() reads the table (${after.length} rows, drift ${state.drift}, ${state.heads}/${state.sup})`);
  await sql.close();
}

console.log("\n[20u] Migration 069 adds the durable jobs table and prune_jobs with nothing to refuse — applied cleanly under a ledger ahead of a pre-069 schema, and the objects work (SMD-2318)");
{
  // 069 references no earlier migration (no FK, no function it redefines), so
  // unlike the guarded migrations above there is nothing to refuse: a plain run
  // under a ledger ahead of an older schema just applies it. The point here is that it applies
  // cleanly through the upgrade harness and its table and function work.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "069" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the069 = MIGRATIONS.find((f) => f.startsWith("069_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the069}`;
  const plain = await migrate();
  assert(plain.code === 0 && !/FAILED/.test(plain.out), `a plain run applies 069 cleanly, nothing refused (exit ${plain.code})${plain.code === 0 ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the069}`)[0].c) === 1, "…069 is recorded once");
  // The table and function work: an aged terminal row prunes, a live one never does.
  const OWNER = "b".repeat(64);
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status) VALUES (gen_random_uuid(), 'scan', ${OWNER}, 'a', 'running')`;
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, ended_at) VALUES (gen_random_uuid(), 'scan', ${OWNER}, 'a', 'succeeded', now() - interval '2 hours')`;
  const pruned = Number((await sql`SELECT prune_jobs(60) AS n`)[0].n);
  const live = Number((await sql`SELECT count(*)::int AS c FROM jobs WHERE ended_at IS NULL`)[0].c);
  assert(pruned === 1 && live === 1, `prune_jobs drops the aged terminal row and keeps the live one (pruned ${pruned}, live ${live})`);
  await sql.close();
}

console.log("\n[20v] Migration 070 onto a populated brain at 068 — the listing redefined on 029's body under three arguments with a lineage column, the two-argument form gone, no audit row written, no row moved, no lineage row moved; proposals planted on lineage pairs before the file (pending, and stale raw) read lineage after it while an unrelated one reads false, the selector works and the proposals table is whole; a re-apply a no-op; refused by name without 016, 025 or 029 (SMD-2313)");
{
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "070" });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  const SIG2 = "list_supersession_proposals(text, int)", SIG3 = "list_supersession_proposals(text, int, boolean)";
  // A corpus at 068: the evidence E and an unrelated note D, ten days old; a
  // page generated from E and re-embedded; a digest G captured with
  // derived_from [E]. Proposals recorded under 063's writer as a pass before
  // 066 recorded them — the page over E (pending), the digest over E (set
  // stale raw, 063's status), the page over D (pending, no lineage).
  const e = (await sql`SELECT upsert_thought('upgrade 070: the evidence', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  const d = (await sql`SELECT upsert_thought('upgrade 070: an unrelated note', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  await sql`UPDATE thoughts SET created_at = now() - interval '10 days' WHERE id IN (${e.id}::uuid, ${d.id}::uuid)`;
  const pg = (await sql`SELECT upsert_page('upgrade-070', 'Upgrade 070', 'topic', '{}'::jsonb, 'alice') AS r`)[0].r as { page_id: string };
  await sql`SELECT write_page_section(${pg.page_id}::uuid, 'body', 'Generated from the evidence.', 'generated', 'Body', '{"model": "stub"}'::jsonb, ${sql.array([e.id], "TEXT")}::uuid[], 10, 'gen')`;
  const [{ content }] = await sql`SELECT content FROM thoughts WHERE id = ${pg.page_id}::uuid`;
  await sql`SELECT update_thought(${pg.page_id}::uuid, ${content}::text, NULL::jsonb, ${vec(0)}::vector, NULL::jsonb, NULL::timestamptz, ${actor}::jsonb, ${OPTS.model}::text, NULL::jsonb, NULL::jsonb, NULL::jsonb)`;
  const g = (await sql`SELECT upsert_thought('upgrade 070: a digest of the evidence', ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model, derived_from: [e.id] }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string };
  const propose = async (older: string, newer: string, reason: string) =>
    (await sql`SELECT record_supersession_proposal(${older}::uuid, ${newer}::uuid, 'newer_supersedes_older', 0.9, ${reason}::text, 0.99, 'consolidate:judge@p3') AS id`)[0].id as string;
  const pE = await propose(e.id, pg.page_id, "a page over its evidence, judged before 066");
  const pG = await propose(e.id, g.id, "a digest over its source, judged before 066");
  const pD = await propose(d.id, pg.page_id, "a page over an unrelated note");
  await sql`UPDATE supersession_proposals SET status = 'stale' WHERE id = ${pG}::uuid`;
  const name = (id: string) => (id === pE ? "pE" : id === pG ? "pG" : id === pD ? "pD" : id);
  // The flag read off whichever form carries 070's body: its own, or 109's (SMD-3248), which the re-apply below reaches.
  const forms = async () => (await sql`
    SELECT to_regprocedure(${SIG2}) IS NOT NULL AS two, to_regprocedure(${SIG3}) IS NOT NULL AS three,
           (SELECT count(*)::int FROM pg_proc WHERE proname = 'list_supersession_proposals') AS n,
           (SELECT prosrc LIKE '%ob1:listing-flags-the-lineage-pair%' FROM pg_proc
             WHERE oid = COALESCE(to_regprocedure('list_supersession_proposals(text, int, boolean, text, numeric, timestamptz, uuid)'), to_regprocedure('list_supersession_proposals(text, int, boolean, text)'), to_regprocedure(${SIG3}))) AS flags`)[0] as { two: boolean; three: boolean; n: number; flags: boolean | null };
  const proposals = async () => JSON.stringify(await sql`SELECT id, older_id, newer_id, status, verdict, judge_key, judged_at::text AS j, reviewed_at::text AS r, review_note FROM supersession_proposals ORDER BY id`);
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata, embedding::text AS e, embedding_model, derived_from, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const lineage = async () => JSON.stringify(await sql`SELECT artifact_kind, artifact_id, produced_by, produced_at::text AS at, recipe FROM derivations ORDER BY 1, 2, 3`);
  const pre = await forms();
  const twoArgRows = (await sql`SELECT * FROM list_supersession_proposals(NULL::text, 50)`) as Record<string, unknown>[];
  assert(pre.two === true && pre.three === false && Number(pre.n) === 1 && pre.flags === null && twoArgRows.length === 3 && !("lineage" in twoArgRows[0]),
    `before 070 the listing is 029's two-argument form alone, and its rows carry no lineage column (${twoArgRows.length} rows: ${Object.keys(twoArgRows[0] ?? {}).length} columns)`);
  const proposalsBefore = await proposals(), before = await stamps(), lineageBefore = await lineage();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;

  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("070") });

  const post = await forms();
  type Row = { id: string; status: string; lineage: boolean };
  const list = async (status: string | null, lin: boolean | null) => (await sql`SELECT id, status, lineage FROM list_supersession_proposals(${status}::text, 50, ${lin}::boolean)`) as Row[];
  const idsOf = (rows: Row[]) => rows.map((r) => r.id).sort().join();
  const all = await list(null, null);
  assert(post.two === false && post.three === true && Number(post.n) === 1 && post.flags === true,
    "…and after: the three-argument form alone, carrying the flag, the two-argument one gone");
  assert(all.length === 3 && all.find((r) => r.id === pE)?.lineage === true && all.find((r) => r.id === pG)?.lineage === true && all.find((r) => r.id === pD)?.lineage === false && all.find((r) => r.id === pG)?.status === "stale",
    `the proposals planted before the file read the flag after it — the page over its evidence and the stale digest over its source true, the page over the unrelated note false (${all.map((r) => `${name(r.id)}:${r.status}:${r.lineage}`).join()})`);
  assert(idsOf(await list("pending", true)) === pE && idsOf(await list("stale", true)) === pG && idsOf(await list("pending", false)) === pD && idsOf(await list(null, true)) === [pE, pG].sort().join(),
    "the selector: true under pending is the page's row, under stale the digest's, false under pending the unrelated one, true over every status both");
  assert(((await sql`SELECT lineage FROM list_supersession_proposals('pending', 50)`) as { lineage: boolean }[]).length === 2, "a two-argument call — the callers' form before this file — resolves to the new form through the default");
  assert((await proposals()) === proposalsBefore, "…and the proposals table is whole: every row as it was, the pending one unreviewed with the same verdict and key, the stale one stale — the file writes no verdict");
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert(Number(auditAfter) === Number(auditBefore) && (await stamps()) === before && (await lineage()) === lineageBefore, "the file is DDL alone: no audit row written, no thought moved, no lineage row moved");
  // A re-apply moves nothing. The ledger first, and the files after 070 first
  // (the planted ledger records every file as applied, so a later one would otherwise
  // apply for real under --reapply — [20r]'s lesson from 067; 109 redefines
  // this listing under a fourth argument, [20ba], and the flag reads in its
  // body). Each condition named on failure.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f > "070" });
  await plantLedger(URL_);
  const shapeAfter = await shape(sql), stampsAfter = await stamps(), proposalsAfter = await proposals();
  const re2 = await migrate("--reapply");
  const failed = [re2.code !== 0 && `exit ${re2.code}`, JSON.stringify(await shape(sql)) !== JSON.stringify(shapeAfter) && "shape moved", (await stamps()) !== stampsAfter && "a thought moved", (await proposals()) !== proposalsAfter && "a proposal moved", (await forms()).flags !== true && "the flag gone", Number((await forms()).n) !== 1 && "two forms", idsOf(await list(null, true)) !== [pE, pG].sort().join() && "the selection moved"].filter(Boolean);
  assert(failed.length === 0, `a re-apply is a no-op: the shape as it left it, no thought or proposal moved, one form carrying the flag (${failed.join("; ") || "exit 0"})`);
  await sql.close();

  // The guard, driven ([20r]'s shape): a brain with a ledger planted through
  // 070 whose schema stops before 016, then 025, then 029.
  for (const [stop, needs] of [
    ["016", "migration 070 needs 016 \\(content_fingerprint_of\\); this schema lacks it"],
    ["025", "migration 070 needs 025 \\(thoughts\\.derived_from\\); this schema lacks it"],
    ["029", "migration 070 needs 029 \\(supersession_proposals\\); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    await plantLedger(URL_);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the070 = MIGRATIONS.find((f) => f.startsWith("070_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the070}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`070_listing_flags_lineage_pair\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
    assert(ok, `a plain run fails at 070 naming ${stop} and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
    assert(Number((await sql2`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the070}`)[0].c) === 0, `…070 records nothing without ${stop}`);
    await sql2.close();
  }
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= "029" });
  const sql3 = new SQL({ url: URL_, max: 1 });
  // Every file from 029 on, 110 among them: the flag in 110's body — 109's plus the cursor, 109's being 070's under a fourth argument (SMD-3248, SMD-3249).
  const [present] = await sql3`SELECT prosrc LIKE '%ob1:listing-flags-the-lineage-pair%' AS x FROM pg_proc WHERE oid = COALESCE(to_regprocedure('list_supersession_proposals(text, int, boolean, text, numeric, timestamptz, uuid)'), to_regprocedure('list_supersession_proposals(text, int, boolean, text)'), to_regprocedure(${SIG3}))`;
  assert(present?.x === true, "…and applied once every prerequisite is there: the body carries the flag");
  await sql3.close();
}

console.log("\n[20w] Migration 071 on a schema without 068 — refused up front, naming 068 and --reapply; applied over a brain with source rows and links, node_state() and node_dependencies() read what they did and the seed leaves no drift (SMD-2267)");
{
  // 071 redefines 068's drift and reads its tables from node_state: without
  // the guard a schema stopping before 068 would fail at a bare "relation
  // ob1_superseded_by does not exist" in the first call. 053 is older than
  // every schema that reaches 058, so 068 is the check reached here.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "068" });
  await plantLedger(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the068 = MIGRATIONS.find((f) => f.startsWith("068_"))!;
  const the071 = MIGRATIONS.find((f) => f.endsWith("_node_dependencies_keyed.sql"))!;  // by name: renumbered when main takes its number
  await sql`DELETE FROM schema_migrations WHERE name = ${the071}`;
  // 068 stays recorded and never tried — the planted ledger says so — so
  // 071 is the first file the plain run applies.
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /071_node_dependencies_keyed\.sql\s+FAILED: migration 071 needs 068 \(ob1_ticket_head, ob1_superseded_by\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 071 naming 068 and --reapply, not with a bare "does not exist" (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the071}`)[0].c) === 0, "…071 records nothing");
  // The file locks thoughts, then thought_sources, before its first trigger:
  // CREATE TRIGGER would take thought_sources' lock first, the order opposite
  // to a delete's cascade, and a delete of a sourced thought during the
  // migration deadlocked with it — nine runs in ten under six writers, five of
  // them failing the migration (fourth and fifth review passes).
  const src071 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "migrations", the071), "utf8").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const lockAt = src071.search(/LOCK TABLE thoughts, thought_sources IN SHARE ROW EXCLUSIVE MODE;/);
  const firstTrigger = src071.search(/CREATE TRIGGER/);
  assert(lockAt >= 0 && firstTrigger > lockAt,
    `…and it locks thoughts, then thought_sources, before its first CREATE TRIGGER (${lockAt}, ${firstTrigger})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the068 });
  // A brain 068 already reads: two linear tickets and a github issue with
  // source rows, blocked_by and blocks links between them, one closed, a
  // markdown doc whose system states no status (so its link holds nothing),
  // and a comment on the blocked ticket.
  const row = async (content: string, meta: Record<string, unknown>) =>
    (await sql`INSERT INTO thoughts (content, metadata) VALUES (${content}, ${meta}::jsonb) RETURNING id`)[0].id as string;
  const blocked = await row("[20w] the blocked ticket", { source: "linear", issue: "U-10", status: "Todo", status_type: "unstarted" });
  const blocker = await row("[20w] its blocker", { source: "linear", issue: "U-11", status: "In Progress", status_type: "started" });
  const issue = await row("[20w] a github issue", { status_type: "completed" });
  const doc = await row("[20w] a markdown doc", {});
  await row("[20w] a comment", { ticket: "U-10" });
  for (const [id, system, identity] of [[blocked, "linear", "U-10"], [blocker, "linear", "U-11"], [issue, "github", "G-10"], [doc, "markdown", "notes.md"]] as const)
    await sql`SELECT record_thought_source(${id}::uuid, ${system}, ${identity}, 'x', 'text/plain')`;
  await sql`SELECT record_source_links(${blocked}::uuid, 'linear', ${JSON.stringify([{ relation: "blocked_by", target: "U-11" }, { relation: "blocked_by", target: "U-12" }])}::text::jsonb)`;
  await sql`SELECT record_source_links(${blocked}::uuid, 'linear', ${JSON.stringify([{ relation: "blocked_by", target: "U-11" }])}::text::jsonb)`;
  await sql`SELECT record_source_links(${issue}::uuid, 'github', ${JSON.stringify([{ relation: "blocks", target: "G-11" }])}::text::jsonb)`;
  await sql`SELECT record_source_links(${doc}::uuid, 'markdown', ${JSON.stringify([{ relation: "blocks", target: "other.md" }])}::text::jsonb)`;
  const read = async () => ({
    state: (await sql`SELECT * FROM node_state() ORDER BY thought_id`).map((r: Record<string, unknown>) => JSON.stringify(r)),
    deps: (await sql`SELECT * FROM node_dependencies() ORDER BY system, blocked, blocker, active`).map((r: Record<string, unknown>) => JSON.stringify(r)),
  });
  const before = await read();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the071 });
  const after = await read();
  const keyed = (await sql`SELECT * FROM node_state(${`{${blocked}}`}::uuid[])`)[0] as { blocked: boolean; blockers: string[] | null };
  const [state] = await sql`SELECT (SELECT count(*)::int FROM ob1_node_projection_drift()) AS drift, (SELECT count(*)::int FROM ob1_source_gate) AS rows,
                                   (SELECT count(*)::int FROM ob1_source_gate WHERE gates) AS gating, (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('node_state(uuid[])')) AS body`;
  assert(before.state.length === 5 && before.deps.length === 4 && JSON.stringify(after) === JSON.stringify(before)
      && keyed.blocked === true && JSON.stringify(keyed.blockers) === JSON.stringify(["U-11"])
      && state.drift === 0 && state.rows === 4 && state.gating === 3 && /ob1_node_dependencies_of/.test(String(state.body)),
    `…and applied once 068 is there: node_state() and node_dependencies() read what they did row for row, the blocked ticket read by id is blocked by U-11 alone (U-12's link closed), the seed mirrored four source rows, three gating, and drift() is empty (${after.state.length} rows, ${after.deps.length} links, drift ${state.drift}, ${state.gating}/${state.rows})`);
  await sql.close();
}

console.log("\n[20x] Migration 073 on a schema without 061 — refused up front, naming 061 and --reapply; applied over a brain at the file before it, every thought takes the trust of the write of its text from the log — the key's kind, a declared ingested, a clamp, an edit's, none for an unclassified key — no text, vector or updated_at moves, and a re-apply writes nothing (SMD-1724)");
{
  // 073 redefines 061's writers on their bodies (the lineage writer among
  // their calls): without the guard a schema stopping before 061 would take
  // the bodies and fail at the first capture, not at the migration.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "061" });
  await plantLedger(URL_);
  let sql = new SQL({ url: URL_, max: 1 });
  const the073 = MIGRATIONS.find((f) => f.endsWith("_thought_trust_on_the_row.sql"))!;  // by name: renumbered when main takes its number
  await sql`DELETE FROM schema_migrations WHERE name = ${the073}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /073_thought_trust_on_the_row\.sql\s+FAILED: migration 073 needs 061 \(derivations, ob1_record_derivation\); this schema lacks it/.test(plain.out) &&
    /\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
  assert(ok, `a plain run fails at 073 naming 061 and --reapply, not at the first capture after it (exit ${plain.code})${ok ? "" : `:\n${plain.out}`}`);
  assert(Number((await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name = ${the073}`)[0].c) === 0, "…073 records nothing");
  await sql.close();

  // A brain at the file before 073, written through its own writers.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the073 });
  sql = new SQL({ url: URL_, max: 1 });
  await sql`SELECT set_agent_kind('op-key', 'operator'), set_agent_kind('bot-key', 'agent'), set_agent_kind('imp-key', 'ingested')`;
  const cap = async (content: string, envelope: Record<string, unknown>) =>
    ((await sql`SELECT upsert_thought(${content}, ${JSON.stringify(envelope)}::text::jsonb) AS r`)[0].r as { id: string }).id;
  const OP = { name: "op-key", via: "open-brain" }, BOT = { name: "bot-key", via: "open-brain" }, IMP = { name: "imp-key", via: "ingest-records" };
  const typed = await cap("[20x] typed by the operator", { metadata: { source: "mcp" }, actor: OP });
  const pasted = await cap("[20x] a page the operator pasted", { metadata: {}, event: { trust: "ingested" }, actor: OP });
  const clamped = await cap("[20x] a page claiming the operator's trust", { metadata: {}, event: { trust: "operator" }, actor: IMP });
  const planted = await cap("[20x] a page whose payload says operator", { metadata: { trust: "operator" }, actor: IMP });
  const edited = await cap("[20x] an agent's note", { metadata: {}, actor: BOT });
  await sql`SELECT update_thought(${edited}::uuid, '[20x] the agent''s note, rewritten by the operator', NULL, NULL, NULL, NULL, ${JSON.stringify(OP)}::text::jsonb)`;
  const ghost = await cap("[20x] an unclassified key", { metadata: {}, actor: { name: "ghost-key" } });
  // A writer before 073 that set metadata.trust below its key: 072 stored the
  // word as sent, and the backfill, which never raises, keeps it (run-it,
  // first review pass: the first draft raised it to the key's kind).
  const lowered = await cap("[20x] a page the operator marked ingested before 073", { metadata: { trust: "ingested" }, actor: OP });
  const rowsOf = async () => (await sql`SELECT id::text AS id, content, embedding IS NULL AS no_vec, updated_at::text AS u, metadata FROM thoughts ORDER BY id`) as { id: string; content: string; no_vec: boolean; u: string; metadata: Record<string, unknown> }[];
  const before = await rowsOf();
  // At 072 a payload's trust is kept as sent — the gap 073 closes.
  assert(before.find((r) => r.id === planted)?.metadata.trust === "operator" && before.find((r) => r.id === lowered)?.metadata.trust === "ingested"
      && before.every((r) => r.id === planted || r.id === lowered || !("trust" in r.metadata)),
    "before 073 no writer stamps trust, and a payload's metadata.trust is stored as the caller said it");
  const audits = Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  // The ingester's key reclassified up before the upgrade: the clamped row's
  // log says ingested and its claim operator, and the backfill takes the
  // log's word under the new kind, never the claim — a recorded trust is not
  // raised (run-it, second review pass: the claim read over it survived).
  await sql`SELECT set_agent_kind('imp-key', 'agent')`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the073 });
  const after = await rowsOf();
  const trustOf = (id: string) => after.find((r) => r.id === id)?.metadata.trust ?? "-";
  const got = [typed, pasted, clamped, planted, edited, ghost, lowered].map(trustOf).join(",");
  assert(got === "operator,ingested,ingested,ingested,operator,-,ingested",
    `the backfill stamps each thought from the log: the operator's kind, a declared ingested, a clamp to the key, a planted raise lowered to the key, the editor's for a rewritten text, none for an unclassified key, and a lowering a writer set before 073 kept (${got})`);
  assert(after.length === before.length && after.every((r, i) => r.id === before[i].id && r.content === before[i].content && r.no_vec === before[i].no_vec && r.u === before[i].u),
    "…no text, vector or updated_at moved (a stamp is not an edit)");
  const wrote = Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) - audits;
  assert(wrote === 5, `…and each of the five rows the pass wrote — every one but the unclassified key's and the one already carrying its word — left one audit row under its door (${wrote})`);
  const n = Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the073 });
  assert(Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c) === n && JSON.stringify(await rowsOf()) === JSON.stringify(after),
    "a re-apply of 073 is a no-op: no audit row, no row moved — its backfill finds the rows agreeing with the log");
  await sql.close();
}

console.log("\n[20y] Migration 074 onto a populated brain at the file before it — match_thoughts and search_thoughts_keyword replaced by their min_trust forms, the earlier forms gone, an operator's REVOKE on each carried to its successor, every call without min_trust answering row for row as before, min_trust read through the new index, no audit row and no row moved; a re-apply a no-op (SMD-1724)");
{
  await dropSchema(URL_);
  const the074 = MIGRATIONS.find((f) => f.endsWith("_min_trust.sql"))!;  // by name: renumbered when main takes its number
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the074 });
  const sql = new SQL({ url: URL_, max: 1 });
  await sql`SELECT set_agent_kind('op-key', 'operator'), set_agent_kind('imp-key', 'ingested')`;
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : i === axis + 1 ? 0.5 : 0)).join(",")}]`;
  for (let i = 0; i < 6; i++) {
    const key = i % 2 === 0 ? "op-key" : "imp-key";
    await sql`SELECT upsert_thought(${`[20y] row ${i}`}, ${JSON.stringify({ metadata: { kind: i < 3 ? "a" : "b" }, actor: { name: key, via: "test-upgrade" } })}::text::jsonb, ${vec(i)}::vector)`;
  }
  // An operator's hardening on both forms before the upgrade.
  await sql.unsafe(`REVOKE ALL ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float) FROM PUBLIC`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION search_thoughts_keyword(text, int, int, jsonb) FROM PUBLIC`);
  const reads = async () => JSON.stringify({
    mt: await sql.unsafe(`SELECT id, similarity, score FROM match_thoughts('${vec(1)}'::vector, -1.0, 10, '{}'::jsonb)`),
    mtFiltered: await sql.unsafe(`SELECT id FROM match_thoughts('${vec(4)}'::vector, -1.0, 10, '{"kind":"b"}'::jsonb)`),
    kw: await sql.unsafe(`SELECT id, occurrences, total_count FROM search_thoughts_keyword('[20y]', 25, 0, '{"kind":"a"}'::jsonb)`),
  });
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, metadata, embedding::text AS e, updated_at::text AS u FROM thoughts ORDER BY id`);
  const before = await reads(), rowsBefore = await stamps();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the074 });
  const forms = (await sql`SELECT p.oid::regprocedure::text AS sig, p.proacl::text AS acl FROM pg_proc p WHERE p.proname IN ('match_thoughts', 'search_thoughts_keyword') AND p.pronamespace = 'public'::regnamespace ORDER BY 1`) as { sig: string; acl: string | null }[];
  assert(forms.length === 2 && /^match_thoughts\(vector,double precision,integer,jsonb,double precision,double precision,text\)$/.test(forms[0].sig) && /^search_thoughts_keyword\(text,integer,integer,jsonb,text\)$/.test(forms[1].sig),
    `one form of each, the min_trust ones (${forms.map((f) => f.sig).join("; ")})`);
  assert(forms.every((f) => f.acl !== null && !/(^|[{,])=X/.test(f.acl)), `…an operator's REVOKE FROM PUBLIC on each earlier form is carried to its successor (${forms.map((f) => f.acl).join("; ")})`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION match_thoughts(vector, float, int, jsonb, float, float, text) TO PUBLIC`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION search_thoughts_keyword(text, int, int, jsonb, text) TO PUBLIC`);
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert((await reads()) === before && (await stamps()) === rowsBefore && Number(auditAfter) === Number(auditBefore),
    "…every call without min_trust answers row for row as before (the unfiltered, a filtered and the keyword arm), and no row or audit row moved");
  const op = (await sql.unsafe(`SELECT metadata->>'trust' AS t FROM match_thoughts('${vec(1)}'::vector, -1.0, 10, '{}'::jsonb, 0.0, 90.0, 'operator')`)) as { t: string }[];
  assert(op.length === 3 && op.every((r) => r.t === "operator"), `min_trust operator keeps the operator's three rows of six (${op.length})`);
  const [idx] = await sql`SELECT pg_get_indexdef(to_regclass('thoughts_trust_rank_idx')) AS d`;
  assert(/ob1_trust_rank\(\(metadata ->> 'trust'::text\)\)/.test(String(idx.d)), "…and thoughts_trust_rank_idx stands over the ladder");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the074 });
  const again = (await sql`SELECT count(*)::int AS c FROM pg_proc p WHERE p.proname IN ('match_thoughts', 'search_thoughts_keyword') AND p.pronamespace = 'public'::regnamespace`)[0].c;
  assert(Number(again) === 2 && (await reads()) === before, "a re-apply of 074 is a no-op: one form of each, the same answers");
  await sql.close();
}

console.log("\n[20z] Migration 075: refused without 074 or 068, naming each; onto a populated brain at the file before it — an 8-argument hybrid and current read beside the 7-argument forms, every argument required, an operator's REVOKE on each 7 carried to its 8, every 7-argument call answering row for row as before, min_trust read through both arms, no audit row and no row moved; a re-apply a no-op (SMD-1724)");
{
  // The guard, driven: a schema stopping before 074, its ledger planted. A plpgsql
  // body binds its calls when it runs, so without it 075 would apply and
  // every search through the 7-argument forms fail at its first call.
  const the075 = MIGRATIONS.find((f) => f.endsWith("_min_trust_hybrid.sql"))!;  // by name: renumbered when main takes its number
  const the074 = MIGRATIONS.find((f) => f.endsWith("_min_trust.sql"))!;
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the074 });
  const planted = await plantLedger(URL_);
  let probe = new SQL({ url: URL_, max: 1 });
  await probe`DELETE FROM schema_migrations WHERE name = ${the075}`;
  await probe.close();
  const plain = await migrate();
  const refusedOk = planted === MIGRATIONS.length && plain.code === 1 &&
    /_min_trust_hybrid\.sql\s+FAILED: migration 075 needs 074 \(ob1_min_trust_rank, match_thoughts and search_thoughts_keyword with min_trust\); this schema lacks it/.test(plain.out);
  assert(refusedOk, `075 on a schema without 074 is refused up front, naming 074, not left to fail at the first search (exit ${plain.code})${refusedOk ? "" : `:\n${plain.out}`}`);
  // …and without 068: 074 has no guard of its own requiring it, so 074 lands
  // on a schema before 068 and 075 must refuse there (second review pass).
  const the068 = MIGRATIONS.find((f) => f.endsWith("_node_state_projection.sql"))!;
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the068 || f === the074 });
  const no068 = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the075 }).then(() => "applied", (e: Error) => e.message);
  assert(no068 === "migration 075 needs 068 (node_state, ob1_superseded_by); this schema lacks it",
    `…and on a schema with 074 but not 068 it is refused, naming 068 (${no068})`);
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the075 });
  const sql = new SQL({ url: URL_, max: 1 });
  await sql`SELECT set_agent_kind('op-key', 'operator'), set_agent_kind('imp-key', 'ingested')`;
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : i === axis + 1 ? 0.5 : 0)).join(",")}]`;
  for (let i = 0; i < 6; i++) {
    const key = i % 2 === 0 ? "op-key" : "imp-key";
    await sql`SELECT upsert_thought(${`[20z] UPG-75 row ${i}`}, ${JSON.stringify({ metadata: {}, actor: { name: key, via: "test-upgrade" } })}::text::jsonb, ${vec(i)}::vector)`;
  }
  await sql.unsafe(`REVOKE ALL ON FUNCTION search_thoughts_hybrid(vector, text, float, int, jsonb, float, float) FROM PUBLIC`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float) FROM PUBLIC`);
  const reads = async () => JSON.stringify({
    hy: await sql.unsafe(`SELECT id, similarity, matched_needles, score FROM search_thoughts_hybrid('${vec(1)}'::vector, 'UPG-75', 0.0, 10, '{}'::jsonb)`),
    cu: await sql.unsafe(`SELECT id, score FROM search_thoughts_current('${vec(2)}'::vector, 'UPG-75', 0.0, 10, '{}'::jsonb)`),
  });
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, metadata, embedding::text AS e, updated_at::text AS u FROM thoughts ORDER BY id`);
  const before = await reads(), rowsBefore = await stamps();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the075 });
  const forms = (await sql`SELECT p.oid::regprocedure::text AS sig, p.pronargs::int AS n, p.pronargdefaults::int AS d, p.proacl::text AS acl FROM pg_proc p
                           WHERE p.proname IN ('search_thoughts_hybrid', 'search_thoughts_current') AND p.pronamespace = 'public'::regnamespace ORDER BY 1`) as { sig: string; n: number; d: number; acl: string | null }[];
  assert(forms.length === 4 && forms.filter((f) => f.n === 8).every((f) => f.d === 0) && forms.filter((f) => f.n === 7).every((f) => f.d === 5),
    `two forms of each: the 7-argument ones with their five defaults, the 8-argument ones with none (${forms.map((f) => `${f.sig}:${f.d}`).join("; ")})`);
  assert(forms.every((f) => f.acl !== null && !/(^|[{,])=X/.test(f.acl)), `…an operator's REVOKE FROM PUBLIC on each 7-argument form stands, and reaches the 8-argument form created beside it (${forms.map((f) => f.acl).join("; ")})`);
  for (const f of forms) await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${f.sig} TO PUBLIC`);
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert((await reads()) === before && (await stamps()) === rowsBefore && Number(auditAfter) === Number(auditBefore),
    "…every 7-argument call answers row for row as before (the hybrid and the current read), and no row or audit row moved");
  const op = (await sql.unsafe(`SELECT metadata->>'trust' AS t FROM search_thoughts_hybrid('${vec(1)}'::vector, 'UPG-75', 0.0, 10, '{}'::jsonb, 0.0, 90.0, 'operator')`)) as { t: string }[];
  const opCur = (await sql.unsafe(`SELECT metadata->>'trust' AS t FROM search_thoughts_current('${vec(1)}'::vector, 'UPG-75', 0.0, 10, '{}'::jsonb, 0.0, 90.0, 'operator')`)) as { t: string }[];
  assert(op.length === 3 && op.every((r) => r.t === "operator") && opCur.length === 3 && opCur.every((r) => r.t === "operator"),
    `min_trust operator through the hybrid and the current read keeps the operator's three rows of six (${op.length}, ${opCur.length})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the075 });
  const again = (await sql`SELECT count(*)::int AS c FROM pg_proc p WHERE p.proname IN ('search_thoughts_hybrid', 'search_thoughts_current') AND p.pronamespace = 'public'::regnamespace`)[0].c;
  assert(Number(again) === 4 && (await reads()) === before, "a re-apply of 075 is a no-op: two forms of each, the same answers");
  await sql.close();
}

console.log("\n[20aa] Migration 077: refused without 068 or 075, naming each; onto a populated brain at the file before it — ticket_references and ticket_references_settled added, search_thoughts_current's columns, forms and an operator's REVOKE kept, every read of a thought naming no settled ticket answering row for row as before, a summary whose ticket is Done demoted with its keys, no audit row and no row moved; a re-apply a no-op (SMD-2271)");
{
  // The guard, driven: without 068's ticket heads, and with 068 but not
  // 075's 8-argument search_thoughts_current. A plpgsql body binds its calls
  // when it runs, so without the guard 077 would apply and every
  // prefer_current search fail at its first call.
  const the077 = MIGRATIONS.find((f) => f.endsWith("_references_settled.sql"))!;  // by name: renumbered when main takes its number
  const the075 = MIGRATIONS.find((f) => f.endsWith("_min_trust_hybrid.sql"))!;
  const the068 = MIGRATIONS.find((f) => f.endsWith("_node_state_projection.sql"))!;
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the068 });
  const no068 = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the077 }).then(() => "applied", (e: Error) => e.message);
  assert(no068 === "migration 077 needs 068 (ob1_ticket_head, node_state); this schema lacks it", `077 on a schema without 068 is refused up front, naming 068 (${no068})`);
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the075 });
  const no075 = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the077 }).then(() => "applied", (e: Error) => e.message);
  assert(no075 === "migration 077 needs 075 (the 8-argument search_thoughts_current); this schema lacks it", `…and on a schema with 068 but not 075 it is refused, naming 075 (${no075})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the077 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : i === axis + 1 ? 0.5 : 0)).join(",")}]`;
  const put = async (content: string, axis: number, metadata: Record<string, unknown>) =>
    ((await sql`SELECT upsert_thought(${content}, ${JSON.stringify({ metadata })}::text::jsonb, ${vec(axis)}::vector) AS r`)[0].r as { id: string }).id;
  const done = await put("[20aa] UPG-77 ticket", 0, { type: "task", source: "linear", issue: "SMD-7701", status: "Done", status_type: "completed", linear_updated_at: "2026-10-02T00:00:00.000Z" });
  const plainIds: string[] = [];
  for (let i = 0; i < 4; i++) plainIds.push(await put(`[20aa] UPG-77 note ${i}`, i, { type: "note" }));
  const summary = await put("Session summary — SMD-7701 — [20aa] UPG-77 recommends SMD-7701", 1, { type: "observation" });
  await sql.unsafe(`REVOKE ALL ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text) FROM PUBLIC`);
  const read = async (only: "plain" | "all") => {
    const rows = (await sql.unsafe(`SELECT id::text AS id, score, demoted FROM search_thoughts_current('${vec(1)}'::vector, 'UPG-77', 0.0, 10, '{}'::jsonb)`)) as { id: string; score: number; demoted: string[] | null }[];
    return only === "plain" ? JSON.stringify(rows.filter((r) => r.id !== summary)) : rows;
  };
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, metadata, embedding::text AS e, updated_at::text AS u FROM thoughts ORDER BY id`);
  const before = await read("plain"), rowsBefore = await stamps();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the077 });
  const fns = (await sql`SELECT p.oid::regprocedure::text AS sig, p.proacl::text AS acl, pg_get_function_result(p.oid) AS r FROM pg_proc p
                         WHERE p.proname IN ('ticket_references', 'ticket_references_settled', 'search_thoughts_current') AND p.pronamespace = 'public'::regnamespace ORDER BY 1`) as { sig: string; acl: string | null; r: string }[];
  const cur8 = fns.find((f) => f.sig.endsWith("text)") && f.sig.startsWith("search_thoughts_current"));
  assert(fns.length === 4 && fns.some((f) => f.sig === "ticket_references(text,jsonb)") && fns.some((f) => f.sig === "ticket_references_settled(text,jsonb)")
      && cur8 !== undefined && cur8.acl !== null && !/(^|[{,])=X/.test(cur8.acl) && /window_exact boolean\)$/.test(cur8.r),
    `the two functions added; search_thoughts_current's two forms kept, their columns unchanged, an operator's REVOKE on the 8-argument form standing (${fns.map((f) => f.sig).join("; ")})`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION search_thoughts_current(vector, text, float, int, jsonb, float, float, text) TO PUBLIC`);
  const after = await read("all") as { id: string; score: number; demoted: string[] | null }[];
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert((await read("plain")) === before && (await stamps()) === rowsBefore && Number(auditAfter) === Number(auditBefore),
    "…every row naming no settled ticket answers as before, and no row or audit row moved");
  const sum = after.find((r) => r.id === summary);
  const lastCurrent = Math.max(...after.map((r, i) => (r.demoted === null ? i : -1)));
  assert(sum?.demoted?.join() === "references settled work (SMD-7701)" && after.findIndex((r) => r.id === summary) > lastCurrent && after.find((r) => r.id === done)?.demoted?.join() === "completed",
    `…and the summary whose header ticket is Done is demoted below the current rows, naming it, beside the ticket's own row (${JSON.stringify(sum?.demoted)})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the077 });
  const again = (await sql`SELECT count(*)::int AS c FROM pg_proc p WHERE p.proname IN ('ticket_references', 'ticket_references_settled', 'search_thoughts_current') AND p.pronamespace = 'public'::regnamespace`)[0].c;
  assert(Number(again) === 4 && JSON.stringify(await read("all")) === JSON.stringify(after), "a re-apply of 077 is a no-op: the same functions, the same answers");
  await sql.close();
}

console.log("\n[20ab] Migration 078: refused without 069, naming it; onto a jobs table at the file before it — every row the MCP server's (door open-brain), a new row too unless it names its own, an empty door refused; a re-apply a no-op (SMD-2284)");
{
  const the078 = MIGRATIONS.find((f) => f.endsWith("_jobs_door.sql"))!;  // by name: renumbered when main takes its number
  const the069 = MIGRATIONS.find((f) => f.endsWith("_jobs.sql"))!;
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the069 });
  const planted = await plantLedger(URL_);
  let probe = new SQL({ url: URL_, max: 1 });
  await probe`DELETE FROM schema_migrations WHERE name = ${the078}`;
  await probe.close();
  const plain = await migrate();
  const refusedOk = planted === MIGRATIONS.length && plain.code === 1 &&
    /_jobs_door\.sql\s+FAILED: migration 078 needs 069 \(the jobs table\); this schema lacks it/.test(plain.out);
  assert(refusedOk, `078 on a schema without 069 is refused up front, naming 069 (exit ${plain.code})${refusedOk ? "" : `:\n${plain.out}`}`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the078 });
  const sql = new SQL({ url: URL_, max: 1 });
  const OWNER = "c".repeat(64);
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status) VALUES (gen_random_uuid(), 'scan_thoughts', ${OWNER}, 'a', 'running')`;
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, ended_at) VALUES (gen_random_uuid(), 'scan_thoughts', ${OWNER}, 'a', 'succeeded', now())`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the078 });
  const doors = (await sql`SELECT door, count(*)::int AS c FROM jobs GROUP BY door`) as { door: string; c: number }[];
  assert(doors.length === 1 && doors[0].door === "open-brain" && doors[0].c === 2, `every row from before 078 is the MCP server's, the one serving process then (${JSON.stringify(doors)})`);
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status) VALUES (gen_random_uuid(), 'scan_thoughts', ${OWNER}, 'a', 'running')`;
  await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, door) VALUES (gen_random_uuid(), 'scan_thoughts', ${OWNER}, 'a', 'running', 'open-brain-api')`;
  const [{ c: api }] = await sql`SELECT count(*)::int AS c FROM jobs WHERE door = 'open-brain-api'`;
  const [{ c: mcp }] = await sql`SELECT count(*)::int AS c FROM jobs WHERE door = 'open-brain'`;
  assert(Number(api) === 1 && Number(mcp) === 3, `a row that names no door is the MCP server's (a server from before 078), one that names its own keeps it (${api} api, ${mcp} mcp)`);
  const empty = await sql`INSERT INTO jobs (id, kind, owner_key_hash, actor, status, door) VALUES (gen_random_uuid(), 'scan_thoughts', ${OWNER}, 'a', 'running', '')`.then(() => "accepted", (e: Error) => e.message);
  assert(/jobs_door_named/.test(empty), `an empty door is refused (${empty})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the078 });
  const [{ c: checks }] = await sql`SELECT count(*)::int AS c FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_door_named'`;
  const [{ c: rows }] = await sql`SELECT count(*)::int AS c FROM jobs`;
  assert(Number(checks) === 1 && Number(rows) === 4, `a re-apply of 078 is a no-op: one constraint, the rows unmoved (${checks}, ${rows})`);
  await sql.close();
}

console.log("\n[20ac] Migration 079: refused by name without 025, 029, 053 or 063; onto a populated brain at the file before it — the candidate filter redefined on 066's body plus the linked-tickets rule, the predicate and the count added, an operator's REVOKE kept, no audit row and no row moved, a proposal standing on two linked tickets left as it stands; a newer ticket row listed a ticket Linear relates to it before the file and lists its own ticket's row, an unlinked ticket and the note after it; a re-apply a no-op (SMD-2448)");
{
  const the079 = MIGRATIONS.find((f) => f.endsWith("_linked_tickets_not_paired.sql"))!;  // by name: renumbered when main takes its number
  // The guard, driven, one probe at a time: a schema at 024 lacks 025's
  // derived_from (which 066's terms read), one at 028 lacks 029's queue and
  // filter, one at 052 lacks 053's link rows and their index, and one at 062
  // has all of those but not 063's stale status.
  for (const [upTo, needs] of [["025", "migration 079 needs 025 (thoughts.derived_from); this schema lacks it"], ["029", "migration 079 needs 029 (supersession_proposals, consolidation_candidates); this schema lacks it"],
                               ["053", "migration 079 needs 053 (link rows on thought_facets, thought_facets_link_target_idx); this schema lacks it"]] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < upTo });
    const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the079 }).then(() => "applied", (e: Error) => e.message);
    assert(refused === needs, `079 on a schema stopped before ${upTo} is refused up front, naming ${upTo} (${refused})`);
  }
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "063" });
  const no063 = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the079 }).then(() => "applied", (e: Error) => e.message);
  assert(no063 === "migration 079 needs 063 (the stale proposal status this body reads); this schema lacks it", `079 on a schema without 063 is refused up front, naming 063 (${no063})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the079 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  const SIG = "consolidation_candidates(uuid, int, float)";
  const put = async (content: string, metadata: Record<string, unknown>) =>
    ((await sql`SELECT upsert_thought(${content}, ${{ metadata, actor, embedding_model: OPTS.model }}::jsonb, ${vec(0)}::vector) AS r`)[0].r as { id: string }).id;
  // A corpus at 077, ten days old, each row mentioning billing: ticket
  // SMD-7801's row; SMD-7802, which Linear relates to SMD-7801 (its row
  // holds the link, as board-sync records it); SMD-7803, related too, with a
  // proposal planted on it before the file; SMD-7804, related to nothing;
  // and a note; then today's row of SMD-7801.
  const t1 = await put("upgrade 079: SMD-7801 bills monthly", { source: "linear", issue: "SMD-7801" });
  const t2 = await put("upgrade 079: SMD-7802 bills annually", { source: "linear", issue: "SMD-7802" });
  const t3 = await put("upgrade 079: SMD-7803, judged at 077", { source: "linear", issue: "SMD-7803" });
  const t4 = await put("upgrade 079: SMD-7804, a ticket nothing relates", { source: "linear", issue: "SMD-7804" });
  const note = await put("upgrade 079: a note on billing", { source: "mcp" });
  await sql`UPDATE thoughts SET created_at = now() - interval '10 days' WHERE id IN (${t1}::uuid, ${t2}::uuid, ${t3}::uuid, ${t4}::uuid, ${note}::uuid)`;
  for (const holder of [t2, t3])
    await sql`INSERT INTO thought_facets (thought_id, kind, payload) VALUES (${holder}::uuid, 'link', jsonb_build_object('system', 'linear', 'relation', 'relates_to', 'target', 'SMD-7801'))`;
  const newer = await put("upgrade 079: SMD-7801 moved to annual billing", { source: "linear", issue: "SMD-7801" });
  for (const id of [t1, t2, t3, t4, note, newer])
    await sql`SELECT record_thought_entities(${id}::uuid, 'extract:m@p2', '[{"name": "billing", "type": "topic", "confidence": 0.9}]'::jsonb, '[]'::jsonb, NULL, NULL)`;
  const pid = (await sql`SELECT record_supersession_proposal(${t3}::uuid, ${newer}::uuid, 'newer_supersedes_older', 0.9, 'one ticket over another, judged at 077', 0.99, 'consolidate:judge@p3') AS id`)[0].id as string;
  const name = (o: string) => new Map([[t1, "T1"], [t2, "T2"], [t3, "T3"], [t4, "T4"], [note, "N"]]).get(o) ?? o;
  const cands = async (): Promise<string> => (await sql`SELECT older_id::text AS o FROM consolidation_candidates(${newer}::uuid, 10, 0) ORDER BY 1`).map((r: { o: string }) => r.o).join();
  assert(typeof pid === "string" && (await cands()) === [t1, t2, t4, note].sort().join(),
    `before 079 the newer SMD-7801 row's candidates include SMD-7802, which Linear relates to it — the pair SMD-2448 measured — beside its own ticket's row, the unrelated SMD-7804 and the note, and not SMD-7803, whose pending proposal holds the pair (${(await cands()).split(",").map(name).join()})`);
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC`);
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, metadata, embedding::text AS e, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const proposals = async () => JSON.stringify(await sql`SELECT id, older_id, newer_id, status, verdict, judged_at::text AS j, reviewed_at::text AS r, review_note FROM supersession_proposals ORDER BY id`);
  const before = await stamps(), proposalsBefore = await proposals();
  const [{ c: auditBefore }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the079 });
  const [shape] = await sql`SELECT p.prosrc LIKE '%ob1:linked-tickets-not-paired%' AS x, p.prosrc LIKE '%ob1:lineage-excludes-the-pair%' AS l, p.proacl::text AS acl,
                                   (SELECT count(*)::int FROM pg_proc WHERE proname = 'consolidation_candidates') AS n,
                                   to_regprocedure('consolidation_linked_ticket_pairs_left_out(uuid, float)') IS NOT NULL AND to_regprocedure('consolidation_tickets_linked(jsonb, jsonb)') IS NOT NULL AS counter
                              FROM pg_proc p WHERE p.oid = to_regprocedure(${SIG})`;
  assert(shape.x === true && shape.l === true && Number(shape.n) === 1 && shape.counter === true && shape.acl !== null && !/(^|[{,])=X/.test(shape.acl),
    `one candidate filter carrying both rules, the count and the predicate added, and an operator's REVOKE standing (${JSON.stringify(shape)})`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${SIG} TO PUBLIC`);
  const [{ c: auditAfter }] = await sql`SELECT count(*)::int AS c FROM thought_audit`;
  assert((await stamps()) === before && (await proposals()) === proposalsBefore && Number(auditAfter) === Number(auditBefore),
    "…no row, no proposal and no audit row moved — the proposal on two linked tickets stands pending for its reviewer");
  const [{ n: left }] = await sql`SELECT consolidation_linked_ticket_pairs_left_out(${newer}::uuid, 0) AS n`;
  assert((await cands()) === [t1, t4, note].sort().join() && Number(left) === 1,
    `…and the newer SMD-7801 row is judged against its own ticket's row, the unrelated SMD-7804 and the note, the one related ticket left out and counted (${(await cands()).split(",").map(name).join()}; left out ${left})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the079 });
  const [{ n: again }] = await sql`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('consolidation_candidates', 'consolidation_linked_ticket_pairs_left_out', 'consolidation_tickets_linked')`;
  assert(Number(again) === 3 && (await cands()) === [t1, t4, note].sort().join(), "a re-apply of 079 is a no-op: one of each, the same answers");
  await sql.close();
}

console.log("\n[20ad] Migration 080: refused by name without 073; onto a populated brain at the file before it — the three upsert_thought forms redefined with 'keep', an operator's REVOKE kept, no row and no audit row moved; a capture-only key's re-capture of a windowed thought through the 4-argument form leaves its vector, windows and lineage row, while a write key's still replaces them; a re-apply a no-op (SMD-2539)");
{
  const the080 = MIGRATIONS.find((f) => f.endsWith("_recapture_keep.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "073" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the080 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 080 needs 060, 061 and 073 (ob1_refresh_thought_vector, ob1_record_derivation, ob1_declared_trust, ob1_actor_stamp); this schema lacks it",
    `080 on a schema stopped before 073 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the080 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const WRITER = { name: "writer-key", via: "open-brain" }, HOOK = { name: "hook-key", via: "open-brain" };
  const FOUR = "upsert_thought(text, jsonb, vector, jsonb)";
  const windows = (n: number, axis: number) => Array.from({ length: n }, (_, i) => ({ content: `window ${i}`, embedding: vec(axis), context: null }));
  const cap4 = async (content: string, payload: Record<string, unknown>, axis: number, chunks: unknown[]) =>
    (await sql`SELECT upsert_thought(${content}::text, ${payload}::jsonb, ${vec(axis)}::vector, ${chunks}::jsonb) AS r`)[0].r as { id: string; existed: boolean; chunks: number };
  // A brain at 079: a long thought the writer key captured with two windows,
  // and the 4-argument form's grant revoked from PUBLIC by its operator.
  const long = "upgrade 080: the writer's long thought, captured in windows";
  const w = await cap4(long, { metadata: { source: "mcp", topic: "billing" }, actor: WRITER, embedding_model: OPTS.model, lineage: { chunks: { deterministic: true } } }, 0, windows(2, 1));
  await sql.unsafe(`REVOKE ALL ON FUNCTION ${FOUR} FROM PUBLIC`);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, embedding::text AS e, embedding_model AS m, updated_at::text AS u FROM thoughts ORDER BY id`);
  const windowsOf = async () => JSON.stringify(await sql`SELECT chunk_index, content, embedding::text AS e FROM thought_chunks WHERE thought_id = ${w.id}::uuid ORDER BY chunk_index`);
  const lineageOf = async () => JSON.stringify(await sql`SELECT recipe, produced_at::text AS p FROM derivations WHERE artifact_kind = 'chunks' AND artifact_id = ${w.id}::uuid`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), windowsBefore = await windowsOf(), lineageBefore = await lineageOf(), auditBefore = await audits();
  assert(JSON.parse(windowsBefore).length === 2 && JSON.parse(lineageBefore).length === 1, "[20ad] setup: the writer's thought holds two windows and their lineage row");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the080 });
  const forms = await sql`SELECT p.oid::regprocedure::text AS sig, p.prosrc LIKE '%ob1:recapture-keep-leaves-the-row%' AS keeps, p.proacl::text AS acl FROM pg_proc p WHERE p.proname = 'upsert_thought' ORDER BY 1`;
  const fourAcl = (forms as { sig: string; acl: string | null }[]).find((f) => f.sig.startsWith("upsert_thought(text,jsonb,vector,jsonb)"))?.acl ?? null;
  assert(forms.length === 3 && (forms as { keeps: boolean }[]).every((f) => f.keeps) && fourAcl !== null && !/(^|[{,])=X/.test(fourAcl),
    `three upsert_thought forms, each carrying 'keep', and the operator's REVOKE on the 4-argument form standing (${JSON.stringify(forms.map((f: { sig: string; keeps: boolean; acl: string | null }) => [f.sig, f.keeps, f.acl]))})`);
  await sql.unsafe(`GRANT EXECUTE ON FUNCTION ${FOUR} TO PUBLIC`);
  assert((await rows()) === before && (await windowsOf()) === windowsBefore && (await lineageOf()) === lineageBefore && (await audits()) === auditBefore,
    "…no row, no window, no lineage row and no audit row moved");
  // The capture key re-sends the long text with its own windows and a vector
  // at another model: the row, its windows and their lineage row stand.
  const kept = await cap4(long, { metadata: { source: "codex", probe_note: "relabelled" }, actor: HOOK, embedding_model: "other-model", recapture: "keep", lineage: { chunks: { deterministic: true } } }, 2, windows(3, 3));
  assert(kept.id === w.id && kept.existed === true && kept.chunks === 0, `a 'keep' re-capture through the 4-argument form returns the row's id, existed, chunks 0 (${JSON.stringify(kept)})`);
  assert((await rows()) === before && (await windowsOf()) === windowsBefore && (await lineageOf()) === lineageBefore && (await audits()) === auditBefore,
    "…and leaves the row, its two windows and their lineage row as they were, with no audit row");
  // A write key's re-capture is the merge, as before: its windows replace the row's.
  const merged = await cap4(long, { metadata: { source: "mcp", note: "the writer again" }, actor: WRITER, embedding_model: OPTS.model, lineage: { chunks: { deterministic: true } } }, 0, windows(3, 4));
  assert(merged.id === w.id && merged.chunks === 3 && JSON.parse(await windowsOf()).length === 3 && JSON.parse((await rows()))[0].metadata.note === "the writer again",
    "a write key's re-capture still merges and replaces the windows with its own");
  // …and so does one that says 'merge' outright (review pass 2: a 4-argument
  // form reading any word as 'keep' was held by a regex on its source alone).
  const mergedWord = await cap4(long, { metadata: { source: "mcp", note: "the writer, saying merge" }, actor: WRITER, embedding_model: OPTS.model, recapture: "merge", lineage: { chunks: { deterministic: true } } }, 0, windows(2, 5));
  const [{ note: mergedNote }] = await sql`SELECT metadata->>'note' AS note FROM thoughts WHERE id = ${w.id}::uuid`;
  assert(mergedWord.id === w.id && mergedWord.chunks === 2 && JSON.parse(await windowsOf()).length === 2 && mergedNote === "the writer, saying merge",
    `…and so does one saying 'merge' outright: its windows replace the row's (${JSON.stringify({ chunks: mergedWord.chunks, note: mergedNote })})`);
  // A capture key's FRESH long text is captured with its windows, as any
  // fresh text — 'keep' reads only on a row that was there (review pass 1:
  // an early return on every 'keep' passed every suite).
  const freshLong = await cap4("upgrade 080: a capture key's fresh long summary", { metadata: { source: "codex" }, actor: HOOK, embedding_model: OPTS.model, recapture: "keep", lineage: { chunks: { deterministic: true } } }, 5, windows(2, 6));
  const [{ n: freshWindows }] = await sql`SELECT count(*)::int AS n FROM thought_chunks WHERE thought_id = ${freshLong.id}::uuid`;
  assert(freshLong.existed === false && freshLong.chunks === 2 && Number(freshWindows) === 2, `a capture key's fresh long text lands with its two windows (${JSON.stringify(freshLong)}, ${freshWindows} rows)`);
  // A vectorless row holding a window (a raw writer's): the vector a 'keep'
  // re-capture attaches drops it by 022's rule unless the row's label is the
  // arriving vector's, and writes none of the caller's (review pass 1: a
  // guard keeping every window under 'keep' passed every suite).
  for (const [label, left] of [[null, 0], [OPTS.model, 1]] as const) {
    const text = `upgrade 080: a vectorless thought holding a window, labelled ${label ?? "nothing"}`;
    const [{ id: bare }] = await sql`INSERT INTO thoughts (content, content_fingerprint, metadata, embedding_model) VALUES (${text}, content_fingerprint_of(${text}), '{"source": "mcp"}'::jsonb, ${label}) RETURNING id::text AS id`;
    await sql`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding, context) VALUES (${bare}::uuid, 0, 'the raw window', ${vec(7)}::vector, NULL)`;
    const r = await cap4(text, { metadata: { source: "codex" }, actor: HOOK, embedding_model: OPTS.model, recapture: "keep" }, 3, windows(3, 4));
    const [after] = await sql`SELECT embedding IS NOT NULL AS v, metadata->>'source' AS s, (SELECT count(*)::int FROM thought_chunks c WHERE c.thought_id = t.id) AS n FROM thoughts t WHERE id = ${bare}::uuid`;
    assert(r.id === bare && r.chunks === 0 && after.v === true && after.s === "mcp" && Number(after.n) === left,
      `a vectorless row labelled ${label ?? "nothing"} takes the vector under 'keep', keeps its metadata, and holds ${left} window(s) after — none of the caller's (${JSON.stringify(after)})`);
  }
  // The rolled-back fresh path: a raw writer, holding no fingerprint lock,
  // commits the text while a 'keep' capture of it waits on the unique index
  // in its projection; the capture lands on the raw row through the
  // unique_violation fallback. It writes nothing there — not even the tags'
  // lineage row its recipe names, which the rolled-back capture diff once
  // let through (review pass 1, two reviewers' repro) — through the
  // 3-argument form and through the 2-argument one, whose fallback is its
  // own (review pass 2: a 2-argument fallback dropping 'keep' passed).
  for (const form of ["three", "two"] as const) {
    const rawText = `upgrade 080: a raw writer's text that lands mid-capture (${form}-argument form)`;
    const racer = new SQL({ url: URL_, max: 1 }), watch = new SQL({ url: URL_, max: 1 });
    let release!: () => void, inserted!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), rawIn = new Promise<void>((r) => { inserted = r; });
    let rawId = "";
    const raw = racer.begin(async (tx) => {
      // With a vector of its own: a vectorless row would take the capture's
      // vector, whose diff hides the leftover one (mutant, review pass 1).
      [{ id: rawId }] = await tx`INSERT INTO thoughts (content, content_fingerprint, metadata, embedding, embedding_model) VALUES (${rawText}, content_fingerprint_of(${rawText}), '{"source": "import"}'::jsonb, ${vec(1)}::vector, ${OPTS.model}) RETURNING id::text AS id`;
      inserted();
      await gate;
    });
    await rawIn;
    const payload = { metadata: { source: "codex", probe_note: "raced" }, actor: HOOK, embedding_model: OPTS.model, recapture: "keep", lineage: { metadata: { deterministic: false, model: "probe-model" } } };
    const capPid = Number((await sql`SELECT pg_backend_pid() AS p`)[0].p);
    const capture = (form === "three"
      ? sql`SELECT upsert_thought(${rawText}::text, ${payload}::jsonb, ${vec(2)}::vector) AS r`
      : sql`SELECT upsert_thought(${rawText}::text, ${payload}::jsonb) AS r`).execute();  // sent now, not at the await
    // Wait until the capture is blocked on the raw row's index entry — its
    // fresh path taken — before the raw writer commits. Its own backend, by
    // pid: any other backend waiting in an upsert_thought, in this database
    // or another, released the raw writer early, and the fallback went
    // untested with every assertion passing (SMD-3195, review pass 1 mutant).
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      [{ blocked }] = await watch`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = ${capPid} AND wait_event_type = 'Lock') AS blocked`;
      if (!blocked) await Bun.sleep(50);
    }
    release();
    await raw;
    const [{ r: raced }] = await capture;
    const [landed] = await sql`SELECT metadata, (SELECT count(*)::int FROM derivations d WHERE d.artifact_id = t.id AND d.artifact_kind = 'metadata') AS meta_lineage,
        (SELECT count(*)::int FROM thought_audit a WHERE a.thought_id = t.id) AS events FROM thoughts t WHERE id = ${rawId}::uuid`;
    assert(blocked && raced.id === rawId && (form === "two" || raced.existed === true) && JSON.stringify(landed.metadata) === JSON.stringify({ source: "import" }) && Number(landed.meta_lineage) === 0 && Number(landed.events) === 1,
      `a 'keep' capture through the ${form}-argument form that meets a raw writer's row through the fallback leaves it: its metadata, no event past the raw write's, no tags' lineage row (blocked ${blocked}; ${JSON.stringify({ id: raced.id === rawId, existed: raced.existed, metadata: landed.metadata, lineage: landed.meta_lineage, events: landed.events })})`);
    await racer.close();
    await watch.close();
  }
  // A re-apply moves nothing: the forms, the rows, the windows.
  const rowsBeforeReapply = await rows(), windowsBeforeReapply = await windowsOf();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the080 });
  const [{ n: again }] = await sql`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'upsert_thought' AND prosrc LIKE '%ob1:recapture-keep-leaves-the-row%'`;
  assert(Number(again) === 3 && (await rows()) === rowsBeforeReapply && (await windowsOf()) === windowsBeforeReapply, "a re-apply of 080 is a no-op: three forms, each carrying 'keep', and no row or window moved");
  await sql.close();
}

console.log("\n[20ae] Migration 082: refused by name without 060; onto a populated brain at the file before it — the rule, its reads, the note, the lapse and the check at the write, no row and no audit row moved; a capture-scoped pointer written before the upgrade lapses when a write key takes its target after it, by a merge or by a re-capture that changes nothing, and an unmarked one stands; a re-apply a no-op (SMD-2638)");
{
  const the082 = MIGRATIONS.find((f) => f.endsWith("_capture_pointer_lapse.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "060" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the082 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 082 needs 060 and 061 (ob1_append_thought_event, ob1_project_thought_event, ob1_actor_agent_id); this schema lacks it",
    `082 on a schema stopped before 060 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the082 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const agent = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  const HOOK = { name: "hook-key", agent_id: await agent("e", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const OLD_HOOK = { name: "hook-key", agent_id: HOOK.agent_id, via: "open-brain" };  // a server from before SMD-2638 marks no scope
  const WRITER = { name: "writer-key", agent_id: await agent("f", "writer-key", "write"), via: "open-brain" };
  const cap = async (content: string, payload: Record<string, unknown>) =>
    (await sql`SELECT upsert_thought(${content}::text, ${payload}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string; existed: boolean };
  const pointerOf = async (id: string) => ((await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${id}::uuid`)[0] as { s: string | null }).s;
  // A brain at 080: three chains the hook key wrote — two under the capture
  // scope's mark, one by a server that sent none.
  const chain = async (what: string, actor: Record<string, unknown>) => {
    const t = await cap(`upgrade 082: the hook's summary ${what}`, { metadata: { source: "codex" }, actor, recapture: "keep" });
    const n = await cap(`upgrade 082: the hook's next summary ${what}`, { metadata: { source: "codex" }, actor, recapture: "keep", supersedes: t.id });
    return { t: t.id, s: n.id, text: `upgrade 082: the hook's summary ${what}` };
  };
  const merged = await chain("a write key merges onto", HOOK);
  const noop = await chain("a write key re-captures unchanged", HOOK);
  const unmarked = await chain("from before the mark", OLD_HOOK);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits();
  assert((await pointerOf(merged.s)) === merged.t && (await pointerOf(noop.s)) === noop.t && (await pointerOf(unmarked.s)) === unmarked.t, "[20ae] setup: the hook's three pointers are written at 080");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the082 });
  const [made] = await sql`SELECT
      (SELECT count(*)::int FROM pg_proc WHERE proname IN ('ob1_takes_thought', 'ob1_capturer_of', 'ob1_thought_taken', 'ob1_note_recapture', 'ob1_lapse_capture_pointers', 'ob1_check_capture_pointer')) AS fns,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('thought_audit_lapse_capture_pointers', 'thought_audit_check_capture_pointer') AND tgrelid = 'thought_audit'::regclass) AS trg,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'ob1_lapse_capture_pointers' AND prosrc LIKE '%ob1:capture-pointer-lapses%') AS sentinel`;
  assert(made?.fns === 6 && made?.trg === 2 && made?.sentinel === 1, `the six functions and the two triggers, the lapse's sentinel in its body (${JSON.stringify(made)})`);
  assert((await rows()) === before && (await audits()) === auditBefore, "…no row and no audit row moved");
  // The write key lands on two of the hook's targets after the upgrade.
  await cap(merged.text, { metadata: { source: "mcp", project: "upgrade" }, actor: WRITER });
  await sql`SELECT ob1_note_recapture(${merged.t}::uuid, ${WRITER}::jsonb)`;  // as the stores do after a capture that lands on a row
  const again = await cap(noop.text, { metadata: { source: "codex" }, actor: WRITER });
  const [{ noted }] = await sql`SELECT ob1_note_recapture(${again.id}::uuid, ${WRITER}::jsonb) AS noted`;
  await cap(unmarked.text, { metadata: { source: "mcp", project: "upgrade" }, actor: WRITER });
  assert((await pointerOf(merged.s)) === null, "a capture-scoped pointer written before the upgrade lapses when a write key's re-capture of its target is noted after it (a pointer only a server sending the mark writes, onto 080 — a state this leg builds by hand)");
  assert(again.existed === true && noted === true && (await pointerOf(noop.s)) === null, `…and when its re-capture that changed nothing is noted (${noted})`);
  assert((await pointerOf(unmarked.s)) === unmarked.t, "…while a pointer whose capture row carries no scope stands");
  // A re-apply moves nothing.
  const rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the082 });
  const [{ trg }] = await sql`SELECT count(*)::int AS trg FROM pg_trigger WHERE tgname IN ('thought_audit_lapse_capture_pointers', 'thought_audit_check_capture_pointer')`;
  assert(trg === 2 && (await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 082 is a no-op: two triggers, and no row or audit row moved");
  await sql.close();
}

console.log("\n[20af] Migration 084: refused by name without 064; onto a populated brain at the file before it — the relation kind, the write, the two triggers and the lineage kind, no row moved and a link still admitted; a relation written after it; a re-apply a no-op (SMD-1873)");
{
  const the084 = MIGRATIONS.find((f) => f.endsWith("_judged_relations.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "064" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the084 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 084 needs 042, 053, 061 and 064 (thought_facets, record_source_links, ob1_record_derivation, page_sections); this schema lacks them",
    `084 on a schema stopped before 064 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the084 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const cap = async (content: string) => ((await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" } }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string }).id;
  // A brain at 083: two thoughts, a link between them, their lineage rows.
  const older = await cap("upgrade 084: the older note"), newer = await cap("upgrade 084: the newer note");
  await sql`SELECT record_thought_source(${older}::uuid, 'linear', 'SMD-1', 'x', 'text/plain')`;
  await sql`SELECT record_source_links(${newer}::uuid, 'linear', ${[{ relation: "relates_to", target: "SMD-1" }]}::jsonb)`;
  const rows = async () => JSON.stringify(await sql`SELECT
      (SELECT json_agg(t ORDER BY t.id) FROM (SELECT id, content, metadata, updated_at::text AS u FROM thoughts) t) AS t,
      (SELECT json_agg(f ORDER BY f.id) FROM (SELECT id, kind, payload, valid_until FROM thought_facets) f) AS f,
      (SELECT json_agg(d ORDER BY d.id) FROM (SELECT id, artifact_kind, input_fingerprints FROM derivations) d) AS d`);
  const before = await rows();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the084 });
  const [made] = await sql`SELECT
      to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)') IS NOT NULL AS fn,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('thoughts_close_relations', 'thought_facets_drop_relation_derivation')) AS trg,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'derivations_artifact_kind_check') AS chk`;
  assert(made?.fn === true && made?.trg === 2 && /'relation'/.test(String(made?.chk)), `the write, the two triggers, and relation among the lineage kinds (${JSON.stringify(made)})`);
  assert((await rows()) === before, "…no thought, facet or lineage row moved");
  const linked = await sql`SELECT record_source_links(${newer}::uuid, 'linear', ${[{ relation: "relates_to", target: "SMD-1" }, { relation: "blocks", target: "SMD-1" }]}::jsonb) AS r`;
  assert((linked[0].r as { added: number }).added === 1, "the link kind still admits a link after the validator's re-issue");
  const [{ r }] = await sql`SELECT record_thought_relation(${newer}::uuid, ${older}::uuid, 'evolves', 0.7, 'consolidate:t@p4', NULL, 'fo', 'fn', NULL) AS r`;
  assert((r as { action: string }).action === "added", `a relation is written on the upgraded brain (${JSON.stringify(r)})`);
  // A re-apply moves nothing.
  const beforeReapply = await rows();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the084 });
  const [{ trg }] = await sql`SELECT count(*)::int AS trg FROM pg_trigger WHERE tgname IN ('thoughts_close_relations', 'thought_facets_drop_relation_derivation')`;
  assert(trg === 2 && (await rows()) === beforeReapply, "a re-apply of 084 is a no-op: two triggers, and no row moved");
  await sql.close();
}

console.log("\n[20ag] Migration 085: refused by name without 074; onto a populated brain at the file before it — the restamp and the backfill's new body, no row and no audit row moved, a stamp a write key's re-capture kept before the upgrade left as it is; after it, a re-capture moves the stamp through the stores' path, a note written under 082 settles nothing, a backfill pass keeps the restamp, and an edit racing a restamp stays the writer by seq; a re-apply a no-op (SMD-2664)");
{
  const the085 = MIGRATIONS.find((f) => f.endsWith("_recapture_restamps_trust.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "074" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the085 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 085 needs 055, 060, 073 and 074 (ob1_append_thought_event, ob1_project_thought_event, ob1_actor_stamp, ob1_trust_rank); this schema lacks it",
    `085 on a schema stopped before 074 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the085 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('hook-key', 'agent')`;
  await sql`SELECT set_agent_kind('writer-key', 'operator')`;
  // Agent ids, as every key the server resolves carries: 082's note is written for them.
  const agent = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  await sql`SELECT set_agent_kind('other-key', 'operator')`;
  const HOOK = { name: "hook-key", agent_id: await agent("a", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const WRITER = { name: "writer-key", agent_id: await agent("b", "writer-key", "write"), via: "open-brain" };
  const OTHER = { name: "other-key", agent_id: await agent("c", "other-key", "write"), via: "open-brain" };
  const cap = async (content: string, payload: Record<string, unknown>) =>
    (await sql`SELECT upsert_thought(${content}::text, ${payload}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string; fingerprint: string; existed: boolean };
  const marks = async (id: string) => {
    const m = ((await sql`SELECT metadata AS m FROM thoughts WHERE id = ${id}::uuid`)[0] as { m: Record<string, unknown> }).m;
    return `${m.actor_kind ?? "-"}/${m.actor_name ?? "-"}/${m.trust ?? "-"}`;
  };
  // A brain at 082: the hook's outside text, which the writer re-captured
  // there — its stamp kept, the bug — and one the writer has not yet sent.
  const kept = await cap("upgrade 085: the hook's text the writer re-captured before", { metadata: { source: "codex" }, actor: HOOK, event: { trust: "ingested" }, recapture: "keep" });
  await cap("upgrade 085: the hook's text the writer re-captured before", { metadata: { source: "mcp", project: "upgrade" }, actor: WRITER });
  const [{ notedAt082 }] = await sql`SELECT ob1_note_recapture(${kept.id}::uuid, ${WRITER}::jsonb) AS "notedAt082"`;  // as an 082 server does after it
  const later = await cap("upgrade 085: the hook's text the writer sends after", { metadata: { source: "codex" }, actor: HOOK, event: { trust: "ingested" }, recapture: "keep" });
  assert(notedAt082 === true && (await marks(kept.id)) === "agent/hook-key/ingested" && (await marks(later.id)) === "agent/hook-key/ingested", "[20af] setup: at 082 the writer's re-capture is noted and keeps the hook's lowered stamp");
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the085 });
  const [made] = await sql`SELECT
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'ob1_restamp_recapture' AND prosrc LIKE '%ob1:recapture-restamps-capture-key%') AS fn,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'backfill_thought_actors' AND prosrc LIKE '%a.diff ? ''restamped''%') AS bf`;
  assert(made?.fn === 1 && made?.bf === 1, `the restamp with its sentinel, and the backfill reading a restamp (${JSON.stringify(made)})`);
  assert((await rows()) === before && (await audits()) === auditBefore && (await marks(kept.id)) === "agent/hook-key/ingested", "…no row and no audit row moved: a stamp kept before the upgrade stays until the writer's next re-capture");
  // After it, the stores' path: the capture, 082's note, then the restamp.
  const again = await cap("upgrade 085: the hook's text the writer sends after", { metadata: { source: "mcp" }, actor: WRITER });
  await sql`SELECT ob1_note_recapture(${again.id}::uuid, ${WRITER}::jsonb)`;
  const [{ moved }] = await sql`SELECT ob1_restamp_recapture(${again.id}::uuid, ${again.fingerprint}::text, ${WRITER}::jsonb, NULL::text) AS moved`;
  assert(again.existed === true && moved === true && (await marks(later.id)) === "operator/writer-key/operator", `a write key's re-capture after the upgrade moves the stamp to it (${moved}, ${await marks(later.id)})`);
  const keptAgain = await cap("upgrade 085: the hook's text the writer re-captured before", { metadata: { source: "mcp" }, actor: OTHER });
  await sql`SELECT ob1_note_recapture(${keptAgain.id}::uuid, ${OTHER}::jsonb)`;
  const [{ keptMoved }] = await sql`SELECT ob1_restamp_recapture(${keptAgain.id}::uuid, ${keptAgain.fingerprint}::text, ${OTHER}::jsonb, NULL::text) AS "keptMoved"`;
  assert(keptMoved === true && (await marks(kept.id)) === "operator/other-key/operator", `…and a stamp kept before the upgrade moves at the next re-capture by a key that can read — another key than the one 082 noted: an 082 note settles nothing (${keptMoved}, ${await marks(kept.id)})`);
  const bf = (await sql`SELECT backfill_thought_actors() AS r`)[0].r as { differing: number };
  assert(bf.differing === 0 && (await marks(later.id)) === "operator/writer-key/operator", `…and a backfill pass after it changes nothing (${JSON.stringify(bf)})`);
  // An edit that began before a restamp and committed after it carries the
  // earlier clock (created_at is the transaction's) and the later seq: the
  // backfill reads the edit, not the restamp, as the writer of the text that
  // stands (review pass 1, on two connections).
  await sql`SELECT set_agent_kind('editor-key', 'agent')`;
  const EDITOR = { name: "editor-key", via: "open-brain" };
  const raced = await cap("upgrade 085: the hook's text an edit races a restamp on", { metadata: { source: "codex" }, actor: HOOK, event: { trust: "ingested" }, recapture: "keep" });
  const editConn = new SQL({ url: URL_, max: 1 });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const clockFixed = new Promise<void>((r) => { started = r; });
  const editDone = editConn.begin(async (tx) => {
    await tx`SELECT now()`;  // the transaction's clock, fixed before the restamp
    started();
    await gate;
    await tx`SELECT update_thought(p_id := ${raced.id}::uuid, p_content := ${"upgrade 085: the editor's text, written after the restamp"}::text, p_actor := ${EDITOR}::jsonb)`;
  });
  await clockFixed;
  await Bun.sleep(20);  // a clock tick apart: created_at is microseconds
  const reRaced = await cap("upgrade 085: the hook's text an edit races a restamp on", { metadata: { source: "mcp" }, actor: WRITER });
  const [{ racedMoved }] = await sql`SELECT ob1_restamp_recapture(${reRaced.id}::uuid, ${reRaced.fingerprint}::text, ${WRITER}::jsonb, NULL::text) AS "racedMoved"`;
  release();
  await editDone;
  await editConn.close();
  const [order] = await sql`SELECT bool_and(r.created_at > e.created_at AND r.seq < e.seq) AS inverted FROM thought_audit r, thought_audit e
     WHERE r.thought_id = ${raced.id}::uuid AND r.diff ? 'restamped' AND e.thought_id = ${raced.id}::uuid AND e.action = 'update' AND e.diff ? 'content'`;
  assert(racedMoved === true && order?.inverted === true && (await marks(raced.id)) === "agent/editor-key/agent",
    `setup: the restamp landed between the edit's start and its write — a later clock, an earlier seq — and the edit's stamp stands live (${racedMoved}, ${JSON.stringify(order)}, ${await marks(raced.id)})`);
  const bfRaced = (await sql`SELECT backfill_thought_actors() AS r`)[0].r as { differing: number };
  assert(bfRaced.differing === 0 && (await marks(raced.id)) === "agent/editor-key/agent", `…and a backfill pass reads the edit as the writer, by seq, changing nothing (${JSON.stringify(bfRaced)}, ${await marks(raced.id)})`);
  // A re-apply moves nothing.
  const rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the085 });
  assert((await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 085 is a no-op: no row or audit row moved");
  await sql.close();
}

console.log("\n[20ah] Migration 086: refused by name without 085; onto a populated brain at the file before it — the reset, the restamp and the backfill's new bodies, no row and no audit row moved; after it, a row an agent key settled under 085 and one it moved there are reset by the operator, and its re-capture moves each; a backfill pass changes nothing; a re-apply a no-op (SMD-2744)");
{
  const the086 = MIGRATIONS.find((f) => f.endsWith("_capture_stamp_reset.sql"))!;  // by name: renumbered when main takes its number
  const the085 = MIGRATIONS.find((f) => f.endsWith("_recapture_restamps_trust.sql"))!;
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the085 });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the086 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 086 needs 046 and 085 (ob1_registry_kind, ob1_restamp_recapture); this schema lacks it",
    `086 on a schema stopped before 085 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the086 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const agent = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  await sql`SELECT set_agent_kind('hook-key', 'agent')`;
  await sql`SELECT set_agent_kind('bot-key', 'agent')`;
  await sql`SELECT set_agent_kind('op-key', 'operator')`;
  const HOOK = { name: "hook-key", agent_id: await agent("d", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const BOT = { name: "bot-key", agent_id: await agent("e", "bot-key", "write"), via: "open-brain" };
  const OP = { name: "op-key", agent_id: await agent("f", "op-key", "write"), via: "open-brain" };
  const cap = async (content: string, payload: Record<string, unknown>) =>
    (await sql`SELECT upsert_thought(${content}::text, ${payload}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string; fingerprint: string; existed: boolean };
  /** A re-capture as the stores make it: the capture, 082's note, 085's restamp. */
  const recapture = async (content: string, actor: Record<string, unknown>, trust: string | null = null) => {
    const r = await cap(content, { metadata: { source: "mcp" }, actor, ...(trust ? { event: { trust } } : {}) });
    await sql`SELECT ob1_note_recapture(${r.id}::uuid, ${actor}::jsonb)`;
    return ((await sql`SELECT ob1_restamp_recapture(${r.id}::uuid, ${r.fingerprint}::text, ${actor}::jsonb, ${trust}::text) AS m`)[0] as { m: boolean }).m;
  };
  const marks = async (id: string) => {
    const m = ((await sql`SELECT metadata AS m FROM thoughts WHERE id = ${id}::uuid`)[0] as { m: Record<string, unknown> }).m;
    return `${m.actor_kind ?? "-"}/${m.actor_name ?? "-"}/${m.trust ?? "-"}`;
  };
  // A brain at 085: the hook's outside text an agent key re-sent at its equal
  // trust — settled — and one it re-sent undeclared — moved to it.
  const S = "upgrade 086: the hook's text an agent settled";
  const M = "upgrade 086: the hook's text an agent moved";
  const settled = await cap(S, { metadata: { source: "codex" }, actor: HOOK, event: { trust: "ingested" }, recapture: "keep" });
  const moved = await cap(M, { metadata: { source: "codex" }, actor: HOOK, event: { trust: "ingested" }, recapture: "keep" });
  assert((await recapture(S, BOT, "ingested")) === false && (await recapture(S, OP)) === false && (await recapture(M, BOT)) === true
      && (await marks(settled.id)) === "agent/hook-key/ingested" && (await marks(moved.id)) === "agent/bot-key/agent",
    "[20ah] setup: at 085 the agent's equal re-capture settled one row against the operator, and its re-capture moved the other");
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the086 });
  const [made] = await sql`SELECT
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'ob1_reset_capture_stamp' AND prosrc LIKE '%ob1:reset-is-the-operators%') AS fn,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'ob1_restamp_recapture' AND prosrc LIKE '%v_since%') AS rs,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'backfill_thought_actors' AND prosrc LIKE '%a.diff ? ''restamp_reset''%') AS bf`;
  assert(made?.fn === 1 && made?.rs === 1 && made?.bf === 1, `the reset with its sentinel, the restamp reading since a reset, and the backfill reading a reset (${JSON.stringify(made)})`);
  assert((await rows()) === before && (await audits()) === auditBefore, "…no row and no audit row moved");
  // After it: the operator resets both, and its re-capture moves each.
  const reset = async (id: string, actor: Record<string, unknown>) => (await sql`SELECT ob1_reset_capture_stamp(${id}::uuid, ${actor}::jsonb) AS r`)[0].r as { ok: boolean; error?: string; reset?: boolean; restored?: boolean; declines?: number };
  const byAgent = await reset(settled.id, BOT);
  const freed = await reset(settled.id, OP);
  const putBack = await reset(moved.id, OP);
  assert(byAgent.error === "NOT_OPERATOR" && freed.reset === true && freed.declines === 1 && putBack.restored === true && (await marks(moved.id)) === "agent/hook-key/ingested",
    `the agent key is refused; the operator frees the row settled under 085 and puts back the stamp moved there (${JSON.stringify([byAgent, freed, putBack])})`);
  assert((await recapture(S, OP)) === true && (await recapture(M, OP)) === true && (await marks(settled.id)) === "operator/op-key/operator" && (await marks(moved.id)) === "operator/op-key/operator",
    "…and the operator's re-capture then moves each to it");
  const bf = (await sql`SELECT backfill_thought_actors() AS r`)[0].r as { differing: number };
  assert(bf.differing === 0, `…and a backfill pass after it changes nothing (${JSON.stringify(bf)})`);
  // A re-apply moves nothing.
  const rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the086 });
  assert((await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 086 is a no-op: no row or audit row moved");
  await sql.close();
}

console.log("\n[20ai] Migration 087: onto a populated brain at the file before it — the table, its key and its index, no thought moved; a row recorded after it; a re-apply a no-op that keeps the row (SMD-2681)");
{
  await dropSchema(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the087 = MIGRATIONS.find((f) => f.endsWith("_board_findings_posted.sql"))!;  // by name: renumbered when main takes its number
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the087 });
  await sql`INSERT INTO thoughts (content, metadata) VALUES ('upgrade 087: a ticket row', '{"issue": "SMD-1"}'::jsonb)`;
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at FROM thoughts ORDER BY id`);
  const before = await rows();
  assert((await sql`SELECT to_regclass('board_findings_posted') IS NULL AS absent`)[0].absent === true, "before 087 there is no posted record");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the087 });
  const [shape] = await sql`SELECT to_regclass('board_findings_posted') IS NOT NULL AS t, to_regclass('board_findings_posted_at_idx') IS NOT NULL AS i`;
  assert(shape.t && shape.i && (await rows()) === before, "087 onto the populated brain: the table and the cap's index, and no thought moved");
  await sql`INSERT INTO board_findings_posted (ticket_a, ticket_b, word, posted_on, origin, comment_id, finding_ids) VALUES ('SMD-1', 'SMD-2', 'related', 'SMD-2', 'posted', 'c1', ARRAY[gen_random_uuid()])`;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the087 });
  const [n] = await sql`SELECT count(*)::int AS n FROM board_findings_posted`;
  assert(n.n === 1 && (await rows()) === before, "a re-apply of 087 is a no-op: the posted row kept, no thought moved");
  await sql.close();
}

console.log("\n[20aj] Migration 088: refused by name without 073; onto a populated brain at the file before it — update_thought's new answer, no row and no audit row moved; after it, an edit answers its stamp, whether the text counts as the same and whether the patch merged; a re-apply a no-op (SMD-2744)");
{
  const the088 = MIGRATIONS.find((f) => f.endsWith("_update_thought_says_what_it_did.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "073" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the088 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 088 needs 073 (ob1_declared_trust, ob1_actor_stamp); this schema lacks it",
    `088 on a schema stopped before 073 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the088 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('lap-key', 'agent')`;
  const LAP = { name: "lap-key", via: "open-brain" };
  const made = ((await sql`SELECT upsert_thought(${"upgrade 088: the laptop's note"}::text, ${{ metadata: { source: "mcp" }, actor: LAP }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string }).id;
  const before088 = (await sql`SELECT update_thought(p_id := ${made}::uuid, p_metadata_patch := ${{ topic: "before" }}::jsonb, p_actor := ${LAP}::jsonb) AS r`)[0].r as Record<string, unknown>;
  assert(before088.ok === true && !("stamp" in before088) && !("metadata_merged" in before088), "[20aj] setup: before 088 the answer carries no stamp and no verdict");
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the088 });
  const [made88] = await sql`SELECT count(*)::int AS fns, max(prosrc) AS body FROM pg_proc WHERE proname = 'update_thought'`;
  assert(made88?.fns === 1 && /ob1:patch-merged-beside-the-stamp/.test(String(made88.body)), `one update_thought, with 088's answer (${made88?.fns})`);
  assert((await rows()) === before && (await audits()) === auditBefore, "…no row and no audit row moved");
  const after = (await sql`SELECT update_thought(p_id := ${made}::uuid, p_metadata_patch := ${{ trust: "ingested", topic: "after" }}::jsonb, p_actor := ${LAP}::jsonb) AS r`)[0].r as { ok: boolean; stamp?: Record<string, unknown>; same_text?: boolean; metadata_merged?: boolean };
  assert(after.ok && after.stamp?.trust === "agent" && after.stamp?.actor_name === "lap-key" && after.same_text === true && after.metadata_merged === true,
    `after it, an edit answers the stamp the row keeps, the same text, and the patch merged by its other key (${JSON.stringify(after)})`);
  // A re-apply moves nothing.
  const rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the088 });
  assert((await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 088 is a no-op: no row or audit row moved");
  await sql.close();
}

console.log("\n[20ak] Migration 090: refused by name without 086; onto a populated brain at the file before it — the weighing that answers, no row and no audit row moved; after it, a row 086's body settled answers settled, a fresh one moved, and 085's function still answers whether it moved; a re-apply a no-op (SMD-2898)");
{
  const the090 = MIGRATIONS.find((f) => f.endsWith("_recapture_says_what_it_did.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "086" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the090 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 090 needs 085 and 086 (ob1_restamp_recapture, ob1_reset_capture_stamp); this schema lacks it",
    `090 on a schema stopped before 086 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the090 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  for (const [k, kind] of [["hook-key", "agent"], ["op-key", "operator"], ["bot-key", "agent"]]) await sql`SELECT set_agent_kind(${k}, ${kind})`;
  const HOOK = { name: "hook-key", via: "open-brain", scope: "capture" }, OP = { name: "op-key", via: "open-brain" }, BOT = { name: "bot-key", via: "open-brain" };
  const hookCapture = async (content: string) =>
    (await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" }, actor: HOOK, event: { trust: "ingested" }, recapture: "keep" }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  const settled = await hookCapture("upgrade 090: the hook's outside text an agent keeps");
  const [{ kept }] = await sql`SELECT ob1_restamp_recapture(${settled.id}::uuid, ${settled.fingerprint}::text, ${BOT}::jsonb, 'ingested') AS kept`;
  assert(kept === false && (await sql`SELECT to_regprocedure('ob1_weigh_recapture(uuid, text, jsonb, text)') AS f`)[0].f === null,
    "[20ak] setup: before 090 an agent key's equal re-capture declines through 085's function, and nothing answers more");
  const fresh = await hookCapture("upgrade 090: the hook's outside text the operator lifts");
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the090 });
  const [made] = await sql`SELECT count(*)::int AS fns, max(prosrc) AS body FROM pg_proc WHERE proname = 'ob1_weigh_recapture'`;
  assert(made?.fns === 1 && /ob1:recapture-weighed-once/.test(String(made.body)), `one ob1_weigh_recapture, carrying 086's body (${made?.fns})`);
  assert((await rows()) === before && (await audits()) === auditBefore, "…no row and no audit row moved");
  type Answer = { outcome: string; by?: string; stamp?: Record<string, unknown>; mine?: boolean };
  const onSettled = (await sql`SELECT ob1_weigh_recapture(${settled.id}::uuid, ${settled.fingerprint}::text, ${OP}::jsonb, NULL::text) AS r`)[0].r as Answer;
  assert(onSettled.outcome === "settled" && onSettled.by === "decline" && onSettled.stamp?.actor_name === "hook-key" && onSettled.stamp?.trust === "ingested",
    `after it, the operator on the row the decline before it settled: settled, the capture-only key's stamp (${JSON.stringify(onSettled)})`);
  const [{ moved }] = await sql`SELECT ob1_restamp_recapture(${fresh.id}::uuid, ${fresh.fingerprint}::text, ${OP}::jsonb, NULL::text) AS moved`;
  const onMoved = (await sql`SELECT ob1_weigh_recapture(${fresh.id}::uuid, ${fresh.fingerprint}::text, ${OP}::jsonb, NULL::text) AS r`)[0].r as Answer;
  assert(moved === true && onMoved.outcome === "settled" && onMoved.by === "restamp" && onMoved.mine === true && onMoved.stamp?.actor_name === "op-key",
    `…085's function still moves a fresh row and answers true, and the operator's next re-capture finds the label its own (${JSON.stringify(onMoved)})`);
  // A re-apply moves nothing.
  const rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the090 });
  assert((await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 090 is a no-op: no row or audit row moved");
  await sql.close();
}

console.log("\n[20al] Migration 091: refused by name without 067; onto a populated brain at the file before it — a row the pass settled is backfilled with its reviewed_at, a pending, a stale and a person's rejected one start empty, no other column moved; after it a reopen keeps the settle; a re-apply a no-op (SMD-2913)");
{
  const the091 = MIGRATIONS.find((f) => f.endsWith("_proposal_settles_kept.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "067" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the091 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 091 needs 067 (settle_supersession_proposal); this schema lacks it",
    `091 on a schema stopped before 067 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the091 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const ACTOR = { name: "op-key", via: "open-brain" };
  const cap = async (content: string, axis: number) =>
    (await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" }, actor: ACTOR }}::jsonb, ${vec(axis)}::vector) AS r`)[0].r as { id: string; fingerprint: string };
  const ts = await Promise.all([0, 1, 2, 3, 4].map((i) => cap(`upgrade 091: note ${i} about Cy`, i + 1)));
  const propose = async (o: number, n: number) =>
    String((await sql`SELECT record_supersession_proposal(${ts[o].id}::uuid, ${ts[n].id}::uuid, 'newer_supersedes_older', 0.9, 'because', 0.8, 'consolidate:stub@p91', NULL, NULL, NULL, '{"deterministic": false}'::jsonb) AS r`)[0].r);
  const settledP = await propose(0, 1), pendingP = await propose(0, 2), staleP = await propose(0, 3), rejectedP = await propose(0, 4);
  // The settle path as 067 runs it: a stale row, then the pass's settle.
  await sql`UPDATE supersession_proposals SET status = 'stale' WHERE id IN (${settledP}::uuid, ${staleP}::uuid)`;
  const settled = (await sql`SELECT settle_supersession_proposal(${settledP}::uuid, 'settled by the pass: unrelated at consolidate:stub@p91', '{}'::jsonb, 'consolidate:stub@p91', ${ts[0].fingerprint}, ${ts[1].fingerprint}, '{"deterministic": false}'::jsonb) AS r`)[0].r as { ok: boolean };
  await sql`SELECT review_supersession_proposal(${rejectedP}::uuid, 'reject', 'not the same claim')`;
  assert(settled.ok === true, "[20al] setup: before 091 the pass settles a stale row");
  const rows = async () => JSON.stringify(await sql`SELECT id, older_id, newer_id, status, reviewed_at::text AS r, review_note, judged_at::text AS j FROM supersession_proposals ORDER BY id`);
  const before = await rows();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the091 });
  const settles = Object.fromEntries((await sql`SELECT id::text AS id, pass_settled_at::text[] AS s, reviewed_at::text AS r FROM supersession_proposals`).map((x: { id: string; s: string[]; r: string | null }) => [x.id, x]));
  assert((await rows()) === before && settles[settledP].s.length === 1 && Date.parse(settles[settledP].s[0]) === Date.parse(settles[settledP].r!)
      && [pendingP, staleP, rejectedP].every((id) => settles[id].s.length === 0),
    `the settled row is backfilled with its reviewed_at, the pending, stale and person's rejected rows start empty, and no other column moved (${JSON.stringify(Object.values(settles).map((x) => x.s.length))})`);
  // After it: 067's reopen clears reviewed_at and keeps the settle.
  await sql`UPDATE thoughts SET content = 'upgrade 091: note 1 about Cy, moved', content_fingerprint = content_fingerprint_of('upgrade 091: note 1 about Cy, moved') WHERE id = ${ts[1].id}::uuid`;
  const reb = (await sql`SELECT rebuild_derived(${ts[1].id}::uuid, 'edit') AS r`)[0].r as { stale_proposals: number };
  const [after] = await sql`SELECT status, reviewed_at, pass_settled_at::text[] AS s FROM supersession_proposals WHERE id = ${settledP}::uuid`;
  assert(reb.stale_proposals === 1 && after.status === "stale" && after.reviewed_at === null && JSON.stringify(after.s) === JSON.stringify(settles[settledP].s),
    `after it, 067's reopen clears reviewed_at and the backfilled settle stays (${JSON.stringify(after)})`);
  const beforeReapply = JSON.stringify(await sql`SELECT id, status, pass_settled_at::text FROM supersession_proposals ORDER BY id`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the091 });
  assert(JSON.stringify(await sql`SELECT id, status, pass_settled_at::text FROM supersession_proposals ORDER BY id`) === beforeReapply
      && Number((await sql`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'supersession_proposals_keep_settles'`)[0].n) === 1,
    "a re-apply of 091 is a no-op: one trigger, no settle moved");
  await sql.close();
}

console.log("\n[20am] Migration 092: refused by name without 082; onto a populated brain at the file before it — another key's pointer among the takers and the lapse firing on it, no row and no audit row moved; after it, an accept made before reads taken while the hook's pointer written before stands (no sweep); a re-apply a no-op (SMD-2708)");
{
  const the092 = MIGRATIONS.find((f) => f.endsWith("_pointer_takes_capture_thought.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "082" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the092 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 092 needs 082 (ob1_takes_thought, ob1_capturer_of, ob1_lapse_capture_pointers, ob1_check_capture_pointer, ob1_note_recapture); this schema lacks it",
    `092 on a schema stopped before 082 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the092 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const agentOf = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  const HOOK = { name: "hook-key", agent_id: await agentOf("5", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const WRITER = { name: "writer-key", agent_id: await agentOf("4", "writer-key", "write"), via: "open-brain" };
  const cap = async (content: string, actor: Record<string, unknown>, supersedes?: string) =>
    ((await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" }, actor, ...(actor.scope === "capture" ? { recapture: "keep" } : {}), ...(supersedes ? { supersedes } : {}) }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string }).id;
  const taken = async (id: string) => ((await sql`SELECT ob1_thought_taken(${id}::uuid) AS t`)[0] as { t: boolean }).t;
  const pointerOf = async (id: string) => ((await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${id}::uuid`)[0] as { s: string | null }).s;
  const W = await cap("upgrade 092: the writer's rota, weekly", WRITER);
  const C = await cap("upgrade 092: the hook's rota, daily", HOOK);
  const N = await cap("upgrade 092: the hook's next word on the rota", HOOK, C);
  const pid = ((await sql`SELECT record_supersession_proposal(${W}::uuid, ${C}::uuid, 'newer_supersedes_older', 0.9, '[20am]', 0.9, 'consolidate:stub@p92') AS id`)[0] as { id: string }).id;
  const accepted = ((await sql`SELECT review_supersession_proposal(${pid}::uuid, 'accept', NULL, NULL, ${{ name: "consolidate", via: "consolidate" }}::jsonb, false) AS r`)[0] as { r: { ok: boolean } }).r;
  assert(accepted.ok === true && (await taken(C)) === false && (await pointerOf(N)) === C,
    "[20am] setup: before 092 an accept making the hook's thought current takes nothing, and the hook's pointer onto it stands");
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the092 });
  const [trg] = await sql`SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgname = 'thought_audit_lapse_capture_pointers'`;
  assert(/'supersedes'/.test(String(trg?.d)) && (await rows()) === before && (await audits()) === auditBefore, "092 applied: the lapse fires on a pointer too, and no row or audit row moved");
  assert((await taken(C)) === true && (await pointerOf(N)) === C,
    "after it, the accept made before reads as a taking — the hook's pointer written before it stands, no sweep (the documented gap)");
  let refusal = "written";
  try { await cap("upgrade 092: the hook's unreviewed word", HOOK, C); } catch (e) { refusal = (e as Error).message; }
  assert(/ob1_check_capture_pointer/.test(refusal), `…and a new pointer from the hook onto it is refused at the write (${refusal.slice(0, 80)})`);
  // A re-apply moves nothing.
  const rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the092 });
  assert((await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 092 is a no-op: no row or audit row moved");
  await sql.close();
}

console.log("\n[20an] Migration 093: onto a populated brain at the file before it, a claim in flight — the table and its two functions, no thought or claim moved; the claim's holder keeps a window after it; a re-apply a no-op that keeps it (SMD-2694)");
{
  await dropSchema(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the093 = MIGRATIONS.find((f) => f.endsWith("_extraction_progress.sql"))!;  // by name: renumbered when main takes its number
  // Refused by name on a schema before 015, as 031 is (review pass 4).
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "015" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the093 }).then(() => "applied", (e: Error) => e.message);
  assert(/^migration 0\d\d needs 015 \(thought_work_claims\); this schema lacks it$/.test(refused), `093 on a schema before 015 is refused up front, naming what it needs (${refused})`);
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the093 });
  const [{ id }] = await sql`INSERT INTO thoughts (content) VALUES ('upgrade 093: a long document') RETURNING id`;
  await sql`SELECT enqueue_thoughts('extract:stub@p2', ARRAY[${id}::uuid])`;
  await sql`SELECT * FROM claim_thoughts('extract:stub@p2', 'w-upgrade', 1, 900)`;
  const state = async () => JSON.stringify(await sql`SELECT t.id, t.content, t.updated_at, c.status, c.worker_id, c.enqueued_at, c.attempt_count FROM thoughts t JOIN thought_work_claims c ON c.thought_id = t.id ORDER BY t.id`);
  const before = await state();
  assert((await sql`SELECT to_regclass('extraction_progress') IS NULL AS absent`)[0].absent === true, "before 093 there is no table of kept windows");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the093 });
  const [shape] = await sql`SELECT to_regclass('extraction_progress') IS NOT NULL AS t,
    to_regprocedure('save_extraction_window(uuid, text, text, text, text, int, int, jsonb)') IS NOT NULL AS s,
    to_regprocedure('note_extraction_stop(uuid, text, text, text, text, boolean)') IS NOT NULL AS n`;
  assert(shape.t && shape.s && shape.n && (await state()) === before, "093 onto the populated brain: the table and both functions, and no thought or claim moved");
  const [{ ok }] = await sql`SELECT save_extraction_window(${id}::uuid, 'extract:stub@p2', 'w-upgrade', 'fp', 'win', 3, 0, ${{ index: 0, h: "h0" }}::jsonb) AS ok`;
  assert(ok === true, "the claim in flight across the upgrade: its holder keeps a window after it");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the093 });
  const [n] = await sql`SELECT count(*)::int AS n FROM extraction_progress`;
  assert(n.n === 1 && (await state()) === before, "a re-apply of 093 is a no-op: the kept window stands, no thought or claim moved");
}

console.log("\n[20ao] Migration 094: refused by name without 092; onto a populated brain at the file before it — proposals recorded before it read their writers after it, 070's listing untouched, no row and no audit row moved; a re-apply a no-op (SMD-2707)");
{
  const the094 = MIGRATIONS.find((f) => f.endsWith("_listing_names_the_writers.sql"))!;  // by name: renumbered when main takes its number
  const before094 = (f: string) => f < the094;
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "092" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the094 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 094 needs 092 (ob1_capture_taken_by_log); this schema lacks it",
    `094 on a schema stopped before 092 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: before094 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const agentOf = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  const HOOK = { name: "hook-key", agent_id: await agentOf("5", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const WRITER = { name: "writer-key", agent_id: await agentOf("4", "writer-key", "write"), via: "open-brain" };
  await sql`SELECT set_agent_kind('hook-key', 'agent'), set_agent_kind('writer-key', 'operator')`;
  const cap = async (content: string, actor: Record<string, unknown>, supersedes?: string) =>
    ((await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" }, actor, ...(actor.scope === "capture" ? { recapture: "keep" } : {}), ...(supersedes ? { supersedes } : {}) }}::jsonb, ${vec(1)}::vector) AS r`)[0].r as { id: string }).id;
  const W = await cap("upgrade 094: the writer's rota, weekly", WRITER);
  const C = await cap("upgrade 094: the hook's rota, daily", HOOK);
  const N = await cap("upgrade 094: the hook's next word on the rota", HOOK, C);
  const pid = ((await sql`SELECT record_supersession_proposal(${W}::uuid, ${C}::uuid, 'newer_supersedes_older', 0.9, '[20ao]', 0.9, 'consolidate:stub@p93') AS id`)[0] as { id: string }).id;
  // As Postgres spells it: the driver decodes the real similarity as 0.9 on one read and 0.8999999761581421 on the next.
  const listing = async () => String((await sql`SELECT jsonb_agg(l ORDER BY l.id)::text AS j FROM list_supersession_proposals(NULL::text, 200, NULL::boolean) l`)[0].j);
  const listingSrc = async () => String((await sql`SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('list_supersession_proposals(text, int, boolean)')`)[0].prosrc);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits(), listedBefore = await listing(), srcBefore = await listingSrc();
  assert((await sql`SELECT to_regprocedure('list_proposal_writers(uuid[])') AS f`)[0].f === null, "[20ao] setup: before 094 there is no writers' read");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the094 });
  const listedAfter = await listing();
  const at = [...listedAfter].findIndex((ch, i) => ch !== listedBefore[i]);
  assert((await rows()) === before && (await audits()) === auditBefore && listedAfter === listedBefore && (await listingSrc()) === srcBefore,
    `094 applied: no row or audit row moved, and 070's listing reads and is defined as before (${at < 0 ? "same" : `${listedBefore.slice(at - 80, at + 80)} → ${listedAfter.slice(at - 80, at + 80)}`})`);
  const [w] = (await sql`SELECT * FROM list_proposal_writers(ARRAY[${pid}::uuid])`) as Record<string, unknown>[];
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  assert(w?.older_actor_name === "writer-key" && w?.older_trust === "operator" && w?.older_capture_only === false
      && w?.newer_actor_name === "hook-key" && w?.newer_trust === "agent" && w?.newer_capture_only === true
      && w?.newer_superseded_by === N && JSON.stringify(json(w?.newer_lapses)) === JSON.stringify([{ id: N, onto: C }]) && JSON.stringify(json(w?.older_lapses)) === "[]" && w?.same_capturer === false,
    `after it, the proposal recorded before reads its writers: the writer's side an operator's, the hook's a capture-only key's text the hook has since superseded, the pointer an accept making it stand would lapse (${JSON.stringify(w)})`);
  // A re-apply moves nothing.
  const read = async () => JSON.stringify(await sql`SELECT * FROM list_proposal_writers(ARRAY[${pid}::uuid])`);
  const readBefore = await read(), rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the094 });
  assert((await read()) === readBefore && (await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 094 is a no-op: the same writers, no row or audit row moved");
  // 070 re-applied over it — the re-apply order passes through 070 first — stands, and the writers still read.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f.startsWith("070_") });
  assert((await read()) === readBefore && (await listing()) === listedBefore, "070 re-applied after it: its listing and 094's read both stand");
  await sql.close();
}

console.log("\n[20ap] Migration 095: refused by name without 068; onto a populated brain at the file before it — the label's inputs read the tickets board-sync moved before it, in the log's order, and no row moved; a re-apply a no-op (SMD-2540)");
{
  const the094 = MIGRATIONS.find((f) => f.endsWith("_ticket_status_inputs.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "068" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the094 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 095 needs 068 (ob1_ticket_head, node_state); this schema lacks it",
    `095 on a schema stopped before 068 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the094 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${Array.from({ length: OPTS.dim }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  const [{ r }] = await sql`SELECT upsert_thought('ticket SMD-1'::text, ${{ metadata: { source: "linear", issue: "SMD-1", status: "Backlog", status_type: "backlog" } }}::jsonb, ${vec}::vector) AS r`;
  const id = (r as { id: string }).id;
  for (const [status, type] of [["In Progress", "started"], ["Done", "completed"]]) await sql`UPDATE thoughts SET metadata = metadata || ${{ status, status_type: type }}::jsonb WHERE id = ${id}::uuid`;
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata FROM thoughts ORDER BY id`);
  const before = await rows();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the094 });
  const read = async () => (await sql`SELECT kind, issue, status, history FROM ticket_status_inputs(ARRAY[${id}]::uuid[], ARRAY['SMD-1'])`) as { kind: string; issue: string; status: string; history: { status: string }[] | null }[];
  const got = await read();
  const events = (got.find((x) => x.kind === "history")?.history ?? []).map((x) => x.status);
  assert((await rows()) === before && JSON.stringify(events) === JSON.stringify(["Backlog", "In Progress", "Done"])
      && got.some((x) => x.kind === "head" && x.status === "Done") && got.some((x) => x.kind === "lifecycle"),
    `onto a brain at 094: the moves made before 095 are read back in order, the head is Done, the ticket row is its own lifecycle, and no row moved (${JSON.stringify(got.map((x) => [x.kind, x.status]))})`);
  const beforeReapply = JSON.stringify(await read());
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the094 });
  assert(JSON.stringify(await read()) === beforeReapply && (await rows()) === before, "a re-apply of 095 is a no-op");
  await sql.close();
}

console.log("\n[20aq] Migration 097: refused by name without 092 or 094; onto a populated brain at the file before it — a pending proposal's lapses read the same after it, the accept clears what the read said, no row and no audit row moved by the file; a re-apply a no-op (SMD-3035)");
{
  const the097 = MIGRATIONS.find((f) => f.endsWith("_one_lapse_definition.sql"))!;  // by name: renumbered when main takes its number
  for (const [stop, needs] of [["092", "migration 097 needs 092 (ob1_lapse_capture_pointers, ob1_capture_taken_by_log); this schema lacks it"],
                               ["094", "migration 097 needs 094 (ob1_accept_takes, ob1_accept_lapses); this schema lacks it"]]) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the097 }).then(() => "applied", (e: Error) => e.message);
    assert(refused === needs, `097 on a schema stopped before ${stop} is refused up front, naming what it needs (${refused})`);
  }

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the097 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${Array.from({ length: OPTS.dim }, (_, i) => (i === 1 ? 1 : 0)).join(",")}]`;
  const agentOf = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  const HOOK = { name: "hook-key", agent_id: await agentOf("5", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const WRITER = { name: "writer-key", agent_id: await agentOf("4", "writer-key", "write"), via: "open-brain" };
  const REVIEWER = { name: "consolidate", via: "consolidate", session: "job-20aq" };
  const cap = async (content: string, actor: Record<string, unknown>, supersedes?: string) =>
    ((await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" }, actor, ...(actor.scope === "capture" ? { recapture: "keep" } : {}), ...(supersedes ? { supersedes } : {}) }}::jsonb, ${vec}::vector) AS r`)[0].r as { id: string }).id;
  const W = await cap("upgrade 097: the writer's rota, weekly", WRITER);
  const C = await cap("upgrade 097: the hook's rota, daily", HOOK);
  const N = await cap("upgrade 097: the hook's next word on the rota", HOOK, C);
  const pid = ((await sql`SELECT record_supersession_proposal(${W}::uuid, ${C}::uuid, 'newer_supersedes_older', 0.9, '[20aq]', 0.9, 'consolidate:stub@p95') AS id`)[0] as { id: string }).id;
  const lapses = async () => JSON.stringify((await sql`SELECT ob1_accept_lapses(${C}::uuid, ${W}::uuid) AS l`)[0].l);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits(), lapsesBefore = await lapses();
  assert(lapsesBefore === JSON.stringify([{ id: N, onto: C }]) && (await sql`SELECT to_regprocedure('ob1_lapse_walk(uuid, uuid)') AS f`)[0].f === null,
    `[20aq] setup: at 095 the read names the hook's pointer, and there is no walk of its own (${lapsesBefore})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the097 });
  assert((await rows()) === before && (await audits()) === auditBefore && (await lapses()) === lapsesBefore,
    "097 applied: no row or audit row moved, and the pending proposal's lapses read the same");
  // A re-apply moves nothing.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the097 });
  assert((await rows()) === before && (await audits()) === auditBefore && (await lapses()) === lapsesBefore, "a re-apply of 097 is a no-op");
  // The accept after it clears what the read said, through the walk.
  const [{ r }] = await sql`SELECT review_supersession_proposal(${pid}::uuid, 'accept', NULL, NULL, ${REVIEWER}::jsonb, false) AS r`;
  const [{ s }] = await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${N}::uuid`;
  assert((r as { ok: boolean }).ok === true && s === null, `the accept after it lapses the hook's pointer the read named (${JSON.stringify(r)}, ${s})`);
  await sql.close();
}

console.log("\n[20ar] Migration 098: refused by name without 095; onto a populated brain at the file before it — the label's inputs read the same, now bounded: a lock waited for at most 200 ms, no JIT, each event's diff read once (SMD-2540)");
{
  // By name: renumbered when main takes a number.
  const the095 = MIGRATIONS.find((f) => f.endsWith("_ticket_status_inputs.sql"))!;
  const the098 = MIGRATIONS.find((f) => f.endsWith("_ticket_status_inputs_bounded.sql"))!;
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the095 });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the098 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 098 needs 095 (ticket_status_inputs); this schema lacks it",
    `098 on a schema stopped before 095 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the098 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${Array.from({ length: OPTS.dim }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  const [{ r }] = await sql`SELECT upsert_thought('ticket SMD-1'::text, ${{ metadata: { source: "linear", issue: "SMD-1", status: "Backlog", status_type: "backlog" } }}::jsonb, ${vec}::vector) AS r`;
  const id = (r as { id: string }).id;
  for (const [status, type] of [["In Progress", "started"], ["Done", "completed"]]) await sql`UPDATE thoughts SET metadata = metadata || ${{ status, status_type: type }}::jsonb WHERE id = ${id}::uuid`;
  const read = async () => JSON.stringify(await sql`SELECT kind, thought_id::text, issue, status, status_type, history FROM ticket_status_inputs(ARRAY[${id}]::uuid[], ARRAY['SMD-1'])`);
  const cfg = async () => JSON.stringify([...((await sql`SELECT proconfig AS c FROM pg_proc WHERE oid = 'ticket_status_inputs(uuid[], text[])'::regprocedure`)[0].c ?? [])].sort());
  const before = await read(), cfgBefore = await cfg();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the098 });
  const after = await read();
  assert(after === before && cfgBefore === JSON.stringify(["max_parallel_workers_per_gather=0"]) && (await cfg()) === JSON.stringify(["jit=off", "lock_timeout=200ms", "max_parallel_workers_per_gather=0"]),
    `onto a brain at 097: the same rows as 095's body (${after.length} bytes), now with no JIT and a 200 ms lock timeout beside 095's no parallel workers (${await cfg()})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the098 });
  assert((await read()) === before, "a re-apply of 098 is a no-op");
  await sql.close();
}

console.log("\n[20as] Migration 099: refused by name without 073; onto a populated brain at the file before it — an unlink there holds no review lock, after it holds one, and an edit answers as it did; no row and no audit row moved by the file; a re-apply a no-op (SMD-3045)");
{
  const the099 = MIGRATIONS.find((f) => f.endsWith("_unlink_takes_review_lock.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "073" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the099 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 099 needs 073 (ob1_declared_trust, ob1_actor_stamp); this schema lacks it",
    `099 on a schema stopped before 073 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the099 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('lap-key', 'agent')`;
  const LAP = { name: "lap-key", via: "open-brain" };
  const made = async (content: string, axis: number) => ((await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" }, actor: LAP }}::jsonb, ${vec(axis)}::vector) AS r`)[0].r as { id: string }).id;
  const older = await made("upgrade 099: the older note", 1), newer = await made("upgrade 099: the newer note", 2), third = await made("upgrade 099: a third note", 3);
  await sql`SELECT update_thought(p_id := ${newer}::uuid, p_actor := ${LAP}::jsonb, p_provenance := jsonb_build_object('supersedes', ${older}::uuid))`;
  await sql`SELECT update_thought(p_id := ${third}::uuid, p_actor := ${LAP}::jsonb, p_provenance := jsonb_build_object('supersedes', ${older}::uuid))`;
  // Whether a call's transaction holds the review lock, exclusive, once the
  // call returns — and whether this connection still holds it, in any mode,
  // after the transaction (a session-level lock would; review pass 3).
  // One predicate for both reads, on the connection given: inside the
  // transaction the exclusive mode, after it any.
  const locks = (q: SQL, exclusive: boolean) => q`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid() AND objsubid = 1 AND classid::bigint = ((hashtext('ob1:supersession-review')::bigint >> 32) & 4294967295) AND objid::bigint = (hashtext('ob1:supersession-review')::bigint & 4294967295) AND (NOT ${exclusive} OR mode = 'ExclusiveLock')`.then((r) => Number(r[0].n));
  const holdsReviewLock = async (id: string) => {
    let n = -1;
    await sql.begin(async (tx: SQL) => {
      await tx`SELECT update_thought(p_id := ${id}::uuid, p_actor := ${LAP}::jsonb, p_provenance := '{"supersedes": null}'::jsonb)`;
      n = await locks(tx, true);
    });
    return { n, after: await locks(sql, false) };
  };
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const beforeLock = await holdsReviewLock(third);
  assert(beforeLock.n === 0 && beforeLock.after === 0, `[20as] setup: at 098 an unlink holds no review lock (${beforeLock.n}/${beforeLock.after})`);
  const before = await rows(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the099 });
  const [fn] = await sql`SELECT count(*)::int AS fns, max(prosrc) AS body FROM pg_proc WHERE proname = 'update_thought'`;
  assert(fn?.fns === 1 && /ob1:pointer-write-takes-review-lock/.test(String(fn.body)) && /ob1:patch-merged-beside-the-stamp/.test(String(fn.body)), `one update_thought, 099's gate on 088's body (${fn?.fns})`);
  assert((await rows()) === before && (await audits()) === auditBefore, "…no row and no audit row moved");
  const afterLock = await holdsReviewLock(newer);
  const edit = (await sql`SELECT update_thought(p_id := ${older}::uuid, p_metadata_patch := ${{ topic: "after" }}::jsonb, p_actor := ${LAP}::jsonb) AS r`)[0].r as { ok: boolean; stamp?: Record<string, unknown>; same_text?: boolean; metadata_merged?: boolean };
  const [{ s }] = await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${newer}::uuid`;
  assert(afterLock.n === 1 && afterLock.after === 0 && s === null && edit.ok && edit.same_text === true && edit.metadata_merged === true && edit.stamp?.actor_name === "lap-key",
    `after it, an unlink holds the review lock, exclusive, to the end of its transaction and not past it, and clears the pointer (${afterLock.n}/${afterLock.after}, ${s}), and an edit answers as 088's did (${JSON.stringify(edit)})`);
  // A re-apply moves nothing.
  const rowsBeforeReapply = await rows(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the099 });
  assert((await rows()) === rowsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 099 is a no-op: no row or audit row moved");
  await sql.close();
}

console.log("\n[20at] Migration 101: refused by name without 093; onto a populated brain at the file before it, a claim in flight with its stops counted — the column at 0 on the row, no thought, claim or kept window moved; the holder's cut counted apart from its stops, and a stop under other text resetting it; a re-apply a no-op that keeps it (SMD-3060)");
{
  await dropSchema(URL_);
  const sql = new SQL({ url: URL_, max: 1 });
  const the101 = MIGRATIONS.find((f) => f.endsWith("_extraction_cuts.sql"))!;  // by name: renumbered when main takes its number
  const the093 = MIGRATIONS.find((f) => f.endsWith("_extraction_progress.sql"))!;
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the093 });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the101 }).then(() => "applied", (e: Error) => e.message);
  assert(/^migration \d{3} needs 093 \(extraction_progress\); this schema lacks it$/.test(refused), `101 on a schema before 093 is refused up front, naming what it needs (${refused})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f >= the093 && f < the101 });
  const [{ id }] = await sql`INSERT INTO thoughts (content) VALUES ('upgrade 101: a long document') RETURNING id`;
  await sql`SELECT enqueue_thoughts('extract:stub@p2', ARRAY[${id}::uuid])`;
  await sql`SELECT * FROM claim_thoughts('extract:stub@p2', 'w-upgrade', 1, 900)`;
  await sql`SELECT save_extraction_window(${id}::uuid, 'extract:stub@p2', 'w-upgrade', 'fp', 'win', 3, 0, ${{ index: 0, h: "h0" }}::jsonb)`;
  await sql`SELECT note_extraction_stop(${id}::uuid, 'extract:stub@p2', 'w-upgrade', 'fp', 'win', true)`;
  await sql`SELECT note_extraction_stop(${id}::uuid, 'extract:stub@p2', 'w-upgrade', 'fp', 'win', true)`;
  const state = async () => JSON.stringify(await sql`SELECT t.id, t.content, t.updated_at, c.status, c.worker_id, c.enqueued_at, c.attempt_count FROM thoughts t JOIN thought_work_claims c ON c.thought_id = t.id ORDER BY t.id`);
  const kept = async () => JSON.stringify(await sql`SELECT thought_id, work_type, fingerprint, windowing, windows, parts, stops, stalled, gained, updated_at FROM extraction_progress ORDER BY thought_id`);
  const before = await state();
  const keptBefore = await kept();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the101 });
  const [shape] = await sql`SELECT (SELECT cuts FROM extraction_progress WHERE thought_id = ${id}::uuid) AS cuts,
    to_regprocedure('note_extraction_cut(uuid, text, text, text, text)') IS NOT NULL AS c`;
  assert(shape.cuts === 0 && shape.c && (await state()) === before && (await kept()) === keptBefore,
    `101 onto the populated brain: the row's cuts at 0, the cut's function, and no thought, claim or kept window moved (${JSON.stringify(shape)})`);
  const [{ ok }] = await sql`SELECT note_extraction_cut(${id}::uuid, 'extract:stub@p2', 'w-upgrade', 'fp', 'win') AS ok`;
  const progress = async () => (await sql`SELECT stops, stalled, cuts, (SELECT count(*)::int FROM jsonb_object_keys(parts)) AS kept FROM extraction_progress WHERE thought_id = ${id}::uuid`)[0] as { stops: number; stalled: number; cuts: number; kept: number };
  const cut = await progress();
  assert(ok === true && cut.stops === 2 && cut.stalled === 1 && cut.cuts === 1 && cut.kept === 1,
    `the claim in flight across the upgrade: its holder's cut counted apart, its stops, stall and window as they were (${JSON.stringify(cut)})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the101 });
  assert((await progress()).cuts === 1 && (await state()) === before, "a re-apply of 101 is a no-op: the cut stands, no thought or claim moved");
  // The stop redefined: a row of other text is replaced, its cuts with it.
  await sql`SELECT note_extraction_stop(${id}::uuid, 'extract:stub@p2', 'w-upgrade', 'fp-edited', 'win', false)`;
  const edited = await progress();
  assert(edited.stops === 1 && edited.cuts === 0 && edited.kept === 0, `after 101 a stop under other text replaces the row, its cuts too (${JSON.stringify(edited)})`);
  await sql.close();
}

console.log("\n[20au] Migration 102: refused by name without 084; onto a populated brain at the file before it — the door refuses distinct there and takes it after, a relation standing before stands after, the sentinel the pass reads is in; no row and no audit row moved by the file; a re-apply a no-op (SMD-3117)");
{
  const the102 = MIGRATIONS.find((f) => f.endsWith("_judged_distinct.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "084" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the102 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 102 needs 084 (thought_facets and record_thought_relation); this schema lacks them",
    `102 on a schema stopped before 084 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the102 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const made = async (content: string, axis: number) => ((await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" } }}::jsonb, ${vec(axis)}::vector) AS r`)[0].r as { id: string }).id;
  const older = await made("upgrade 102: the older note", 1), newer = await made("upgrade 102: the newer note", 2), apart = await made("upgrade 102: a note about something else", 3);
  const relate = (n: string, o: string, word: string) => sql`SELECT record_thought_relation(${n}::uuid, ${o}::uuid, ${word}, 0.7, 'consolidate:t@p4', NULL, 'a', 'b', NULL) AS r`;
  await relate(newer, older, "related");
  const atBefore = await relate(apart, older, "distinct").then(() => "taken", (e: Error) => e.message);
  assert(/relation must be related, evolves, duplicate or NULL/.test(atBefore), `[20au] setup: at the file before it the door refuses distinct (${atBefore.slice(0, 80)})`);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const facets = async () => JSON.stringify(await sql`SELECT id, thought_id, payload, valid_until IS NULL AS active FROM thought_facets WHERE kind = 'relation' ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), facetsBefore = await facets(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the102 });
  const [door] = await sql`SELECT prosrc AS body FROM pg_proc WHERE oid = to_regprocedure('record_thought_relation(uuid, uuid, text, numeric, text, uuid, text, text, jsonb)')`;
  assert(/ob1:relation-distinct/.test(String(door?.body)) && (await rows()) === before && (await facets()) === facetsBefore && (await audits()) === auditBefore,
    "102 applied: the door carries the sentinel the pass reads, and no thought, relation or audit row moved");
  const taken = (await relate(apart, older, "distinct"))[0].r as { action: string };
  const [standing] = await sql`SELECT count(*) FILTER (WHERE payload->>'relation' = 'related')::int AS related, count(*) FILTER (WHERE payload->>'relation' = 'distinct')::int AS apart
                                 FROM thought_facets WHERE kind = 'relation' AND valid_until IS NULL`;
  assert(taken.action === "added" && standing.related === 1 && standing.apart === 1, `after it the door takes distinct, and the relation standing before stands (${JSON.stringify([taken, standing])})`);
  // A re-apply moves nothing.
  const facetsBeforeReapply = await facets(), auditsBeforeReapply = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the102 });
  assert((await facets()) === facetsBeforeReapply && (await audits()) === auditsBeforeReapply, "a re-apply of 102 is a no-op: no relation or audit row moved");
  await sql.close();
}

console.log("\n[20av] Migration 104: refused by name without 097; onto a populated brain at the file before it — a pending proposal's lapses read the same after it, the accept clears what the read said through the locking trigger, no row and no audit row moved by the file; a re-apply a no-op (SMD-3046)");
{
  const theFile = MIGRATIONS.find((f) => f.endsWith("_lapse_locks_its_tree.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "097" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === theFile }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 104 needs 097 (ob1_lapse_walk, ob1_lapse_capture_pointers); this schema lacks it",
    `104 on a schema stopped before 097 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < theFile });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${Array.from({ length: OPTS.dim }, (_, i) => (i === 1 ? 1 : 0)).join(",")}]`;
  const agentOf = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  // [20aq]'s two keys, as it made them.
  const HOOK = { name: "hook-key", agent_id: await agentOf("5", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const WRITER = { name: "writer-key", agent_id: await agentOf("4", "writer-key", "write"), via: "open-brain" };
  const REVIEWER = { name: "consolidate", via: "consolidate", session: "job-20at" };
  const cap = async (content: string, actor: Record<string, unknown>, supersedes?: string) =>
    ((await sql`SELECT upsert_thought(${content}::text, ${{ metadata: { source: "mcp" }, actor, ...(actor.scope === "capture" ? { recapture: "keep" } : {}), ...(supersedes ? { supersedes } : {}) }}::jsonb, ${vec}::vector) AS r`)[0].r as { id: string }).id;
  const W = await cap("upgrade 104: the writer's rota, weekly", WRITER);
  const C = await cap("upgrade 104: the hook's rota, daily", HOOK);
  const N = await cap("upgrade 104: the hook's next word on the rota", HOOK, C);
  const pid = ((await sql`SELECT record_supersession_proposal(${W}::uuid, ${C}::uuid, 'newer_supersedes_older', 0.9, '[20av]', 0.9, 'consolidate:stub@p95') AS id`)[0] as { id: string }).id;
  const lapses = async () => JSON.stringify((await sql`SELECT ob1_accept_lapses(${C}::uuid, ${W}::uuid) AS l`)[0].l);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits(), lapsesBefore = await lapses();
  assert(lapsesBefore === JSON.stringify([{ id: N, onto: C }]) && (await sql`SELECT to_regprocedure('ob1_lapse_tree(uuid, uuid)') AS f`)[0].f === null,
    `[20av] setup: at 103 the read names the hook's pointer, and there is no tree (${lapsesBefore})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === theFile });
  const [fn] = await sql`SELECT (SELECT prosrc FROM pg_proc WHERE proname = 'ob1_lapse_capture_pointers') AS lapse, to_regprocedure('ob1_lapse_tree(uuid, uuid)') IS NOT NULL AS tree`;
  assert(fn?.tree === true && /ob1:lapse-locks-its-tree/.test(String(fn?.lapse)) && (await rows()) === before && (await audits()) === auditBefore && (await lapses()) === lapsesBefore,
    "104 applied: the tree, and the trigger locking it; no row or audit row moved, and the pending proposal's lapses read the same");
  // A re-apply moves nothing.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === theFile });
  assert((await rows()) === before && (await audits()) === auditBefore && (await lapses()) === lapsesBefore, "a re-apply of 104 is a no-op");
  // The accept after it clears what the read said, through the locking trigger.
  const [{ r }] = await sql`SELECT review_supersession_proposal(${pid}::uuid, 'accept', NULL, NULL, ${REVIEWER}::jsonb, false) AS r`;
  const [{ s: left }] = await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${N}::uuid`;
  assert((r as { ok: boolean }).ok === true && left === null, `the accept after it lapses the hook's pointer the read named (${JSON.stringify(r)}, ${left})`);
  await sql.close();
}

console.log("\n[20aw] Migration 105: refused by name without 058, then without 071; onto a populated brain at the file before it — a Duplicate ticket unknown and its blocker blocking there, settled and cleared after it, the gate mirror rebuilt with it, and every session's cached plans dropped through the brain's own readers, no other role's function touched; no thought or audit row moved by the file; a re-apply a no-op (SMD-2935)");
{
  const the105 = MIGRATIONS.find((f) => f.endsWith("_duplicate_settles.sql"))!;  // by name: renumbered when main takes its number
  const refusal = async (before: string) => {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < before });
    return applyMigrations(URL_, { ...OPTS, only: (f) => f === the105 }).then(() => "applied", (e: Error) => e.message);
  };
  const no058 = await refusal("058"), no071 = await refusal("071");
  assert(no058 === "migration 105 needs 058 (node_lifecycle_types, node_settled_types); this schema lacks it" && no071 === "migration 105 needs 071 (ob1_source_gate, ob1_rebuild_source_gate); this schema lacks it",
    `105 on a schema stopped before 058, or before 071, is refused up front, naming what it needs (${no058}; ${no071})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the105 });
  const sql = new SQL({ url: URL_, max: 1 });
  const VEC = `[${Array.from({ length: OPTS.dim }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  const ticket = async (key: string, status: string, type: string) =>
    ((await sql`INSERT INTO thoughts (content, metadata, embedding) VALUES (${`upgrade 105: ${key}`}, ${{ source: "linear", issue: key, status, status_type: type, linear_updated_at: "2026-10-19T00:00:00.000Z" }}::jsonb, ${VEC}::vector) RETURNING id::text AS id`)[0] as { id: string }).id;
  const dup = await ticket("UPG-2", "Duplicate", "duplicate"), open = await ticket("UPG-1", "Todo", "unstarted");
  for (const [id, key] of [[dup, "UPG-2"], [open, "UPG-1"]]) await sql`SELECT record_thought_source(${id}::uuid, 'linear', ${key}, ${key}, 'text/markdown')`;
  await sql`SELECT record_source_links(${open}::uuid, 'linear', '[{"relation": "blocked_by", "target": "UPG-2"}]'::jsonb)`;
  const state = async () => JSON.stringify(await sql`SELECT thought_id::text AS id, open, blocked, blockers, unknown_blockers FROM node_state(${sql.array([dup, open], "TEXT")}::uuid[]) ORDER BY thought_id`);
  const gate = async () => ((await sql`SELECT gates FROM ob1_source_gate WHERE thought_id = ${dup}::uuid`)[0] as { gates: boolean }).gates;
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const [was] = await sql`SELECT (SELECT open FROM node_state(ARRAY[${dup}::uuid])) AS dup_open, (SELECT blocked FROM node_state(ARRAY[${open}::uuid])) AS blocked`;
  assert(was.dup_open === null && was.blocked === true && (await gate()) === false, `[20aw] setup: at the file before 105 a Duplicate is an unknown status and blocks what it blocks, and its row does not gate (${JSON.stringify(was)})`);
  const before = await rows(), auditBefore = await audits();
  // The warm session below reads node_state's path alone; every other
  // reader of the sets is held by its catalog row: each one's xmin moves
  // (review pass 2).
  const readers = async () => new Map(((await sql`SELECT p.oid::regprocedure::text AS f, p.xmin::text AS x FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ 'node_(lifecycle|settled)_types[[:space:]]*[(]'
        AND p.proname NOT IN ('node_lifecycle_types', 'node_settled_types')`) as { f: string; x: string }[]).map((r) => [r.f, r.x]));
  const readersBefore = await readers();
  // A server's pooled connection: one session that has searched with
  // prefer_current enough times for plpgsql to cache a generic plan. 105 must
  // reach it — CREATE OR REPLACE of the sets alone did not (review pass 1).
  const warm = new SQL({ url: URL_, max: 1 });
  const demotedFor = async () => (((await warm`SELECT demoted FROM search_thoughts_current(${VEC}::vector, 'upgrade 105', 0, 10, '{}'::jsonb, 0, 30, NULL) WHERE id = ${dup}::uuid`)[0] as { demoted: string[] | null } | undefined)?.demoted ?? null);
  const warmBefore: (string[] | null)[] = [];
  for (let i = 0; i < 8; i++) warmBefore.push(await demotedFor());
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the105 });
  const readersAfter = await readers();
  const unaltered = [...readersBefore].filter(([f, x]) => readersAfter.get(f) === x).map(([f]) => f);
  assert(readersBefore.size >= 5 && ["node_state(uuid[])", "ticket_references_settled(text,jsonb)", "ticket_status_inputs(uuid[],text[])"].every((f) => readersBefore.has(f)) && unaltered.length === 0,
    `105 alters every function whose body names a set, so each one's cached plans are dropped (${readersBefore.size} of them; unaltered: ${unaltered.join(", ") || "none"})`);
  const warmAfter = await demotedFor();
  await warm.close();
  assert(warmBefore.every((d) => d === null) && warmAfter?.join() === "duplicate",
    `a session that searched eight times before 105 (a cached generic plan) demotes the Duplicate after it, as a fresh one would (${JSON.stringify([warmBefore[0], warmAfter])})`);
  const [now] = await sql`SELECT (SELECT open FROM node_state(ARRAY[${dup}::uuid])) AS dup_open, (SELECT blocked FROM node_state(ARRAY[${open}::uuid])) AS blocked,
                                 (SELECT unknown_blockers FROM node_state(ARRAY[${open}::uuid])) AS unknown, (SELECT count(*)::int FROM ob1_node_projection_drift()) AS drift`;
  assert(now.dup_open === false && now.blocked === false && (now.unknown ?? []).length === 0 && (await gate()) === true && now.drift === 0,
    `after it the Duplicate is settled, the ticket it blocked is not blocked, and the file's own rebuild leaves the mirror exact (${JSON.stringify(now)})`);
  assert((await rows()) === before && (await audits()) === auditBefore, "…no thought and no audit row moved");
  const stateBefore = await state();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the105 });
  assert((await state()) === stateBefore && (await rows()) === before && (await audits()) === auditBefore, "a re-apply of 105 is a no-op: no state, row or audit row moved");
  // The brain's own readers the text match alone missed — named in upper
  // case, quoted, or only by a BEGIN ATOMIC body's dependency — are altered;
  // a procedure, a function in another schema and one another role owns are
  // not, even with that role holding its lock (review passes 2, 5, 7).
  // Planted only now, for a re-apply: present beside the warm session above
  // they dropped its plan by themselves (review pass 3).
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_other105') THEN CREATE ROLE ob1_upgrade_other105 NOLOGIN; END IF; END $r$;
    CREATE FUNCTION upg105_shouted() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT ''duplicate'' = ANY(PUBLIC.NODE_SETTLED_TYPES())';
    CREATE FUNCTION upg105_quoted() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT ''duplicate'' = ANY("node_settled_types"())';
    CREATE FUNCTION upg105_atomic() RETURNS text[] LANGUAGE sql STABLE BEGIN ATOMIC SELECT node_settled_types(); END;
    CREATE PROCEDURE upg105_proc() LANGUAGE plpgsql AS $$ BEGIN PERFORM node_settled_types(); END $$;
    CREATE SCHEMA upg105;
    CREATE FUNCTION upg105.elsewhere() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT ''duplicate'' = ANY(public.node_settled_types())';
    CREATE FUNCTION upg105_theirs() RETURNS boolean LANGUAGE sql STABLE AS 'SELECT ''duplicate'' = ANY(node_settled_types())';
    ALTER FUNCTION upg105_theirs() OWNER TO ob1_upgrade_other105`);
  const PLANTED = ["upg105_shouted()", "upg105_quoted()", "upg105_atomic()", "upg105_proc()", "upg105.elsewhere()", "upg105_theirs()"];
  const planted = async () => new Map(((await sql`SELECT p.oid::regprocedure::text AS f, p.xmin::text AS x FROM pg_proc p WHERE p.oid::regprocedure::text = ANY(${sql.array(PLANTED, "TEXT")}::text[])`) as { f: string; x: string }[]).map((r) => [r.f, r.x]));
  const plantedBefore = await planted();
  // Another role's function held: an open ALTER on it, as a role that may
  // create one in public (PG 14 and older) can hold. The block never waits on
  // it, as it never touches it; bounded at 5 s in case it did.
  const holder = new SQL({ url: URL_, max: 1 });
  let heldRun: string, heldMs = 0;
  try {
    await holder.unsafe(`BEGIN; ALTER FUNCTION upg105_theirs() IMMUTABLE; ALTER FUNCTION upg105.elsewhere() IMMUTABLE`);
    const t0 = performance.now();
    const letGo = setTimeout(() => { holder.unsafe(`ROLLBACK`).catch(() => undefined); }, 5000);
    heldRun = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the105 }).then(() => "applied", (e: Error) => e.message);
    clearTimeout(letGo);
    heldMs = performance.now() - t0;
  } finally {
    await holder.unsafe(`ROLLBACK`).catch(() => undefined);
    await holder.close();
  }
  const plantedAfter = await planted();
  const moved = (f: string) => plantedAfter.get(f) !== plantedBefore.get(f);
  assert(plantedBefore.size === 6 && heldRun === "applied" && heldMs < 4000
      && ["upg105_shouted()", "upg105_quoted()", "upg105_atomic()"].every(moved) && !["upg105_proc()", "upg105.elsewhere()", "upg105_theirs()"].some(moved),
    `105 re-applied alters the brain's own readers named in upper case, quoted, or by a BEGIN ATOMIC body, and leaves a procedure, another schema's function and another role's — never waiting on that role's held lock (${heldRun.slice(0, 80)}; ${Math.round(heldMs)} ms)`);
  await sql.unsafe(`DROP PROCEDURE upg105_proc(); DROP FUNCTION upg105_atomic(); DROP FUNCTION upg105_quoted(); DROP FUNCTION upg105_shouted();
    DROP FUNCTION upg105.elsewhere(); DROP SCHEMA upg105; DROP FUNCTION upg105_theirs(); DROP ROLE ob1_upgrade_other105`);
  // A brain whose owner is no superuser (a managed Postgres's): the sets and
  // their readers owned by one role, the block run as it — it alters them all.
  const touch = readFileSync(join(HERE, "migrations", the105), "utf8").match(/DO \$touch\$[\s\S]*?\$touch\$;/)?.[0] ?? "no touch block";
  await sql.unsafe(`DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_upgrade_mig105') THEN CREATE ROLE ob1_upgrade_mig105 NOLOGIN; END IF; END $r$`);
  const owned = [...readersBefore.keys()];
  const brain = ["node_lifecycle_types()", "node_settled_types()", ...owned];
  for (const f of brain) await sql.unsafe(`ALTER FUNCTION ${f} OWNER TO ob1_upgrade_mig105`);
  const ownedBefore = await readers();
  let asOwner: string;
  try {
    await sql.begin(async (tx: SQL) => { await tx.unsafe(`SET LOCAL ROLE ob1_upgrade_mig105`); await tx.unsafe(touch); });
    asOwner = "applied";
  } catch (e) { asOwner = (e as Error).message; }
  const ownedAfter = await readers();
  for (const f of brain) await sql.unsafe(`ALTER FUNCTION ${f} OWNER TO CURRENT_USER`);
  await sql.unsafe(`DROP ROLE ob1_upgrade_mig105`);
  assert(asOwner === "applied" && owned.length >= 5 && owned.every((f) => ownedAfter.get(f) !== ownedBefore.get(f)),
    `run by a brain owner that is no superuser, the block alters every reader of its own (${asOwner.slice(0, 80)}; ${owned.length})`);
  await sql.close();
}

console.log("\n[20ax] Migration 106: refused by name without 045; onto a brain at the file before it holding a row of every arm — `literal` refused there and taken after, every row as it was, any other word still refused; a re-apply a no-op (SMD-2891)");
{
  const the106 = MIGRATIONS.find((f) => f.endsWith("_query_log_literal_arm.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "045" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the106 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 106 needs query_log (034) and its arm column (045); this schema lacks them",
    `106 on a schema stopped before 045 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the106 });
  const sql = new SQL({ url: URL_, max: 1 });
  const log = (arm: string | null) => sql`INSERT INTO query_log (kind, tool, query, arm) VALUES ('search', 'search_thoughts', 'upgrade 106', ${arm})`.then(() => "taken", (e: Error) => e.message);
  for (const arm of ["hybrid", "keyword", "current", null]) assert((await log(arm)) === "taken", `[20ax] setup: at the file before it the log takes arm ${arm}`);
  assert(/query_log_arm_check/.test(await log("literal")), "at the file before it the log refuses arm literal");
  const rows = async () => JSON.stringify(await sql`SELECT id, logged_at::text AS t, kind, tool, query, arm FROM query_log ORDER BY id`);
  const check = async () => String((await sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'query_log_arm_check'`)[0]?.d);
  const before = await rows();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the106 });
  assert((await rows()) === before, "106 applied: every row as it was");
  assert((await log("literal")) === "taken" && /query_log_arm_check/.test(await log("vector")), "after it the log takes arm literal, and still refuses a word it does not know");
  const rowsBeforeReapply = await rows(), checkBeforeReapply = await check();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the106 });
  assert((await rows()) === rowsBeforeReapply && (await check()) === checkBeforeReapply && /'literal'/.test(checkBeforeReapply), `a re-apply of 106 is a no-op: no row moved, the same check (${checkBeforeReapply})`);
  await sql.close();
}

console.log("\n[20ay] Migration 107: refused by name without 094; onto a populated brain at the file before it — a proposal within the cap lists the same, one over a 26-row chain has that side's takes and lapses unread after it, no row and no audit row moved; a re-apply a no-op (SMD-3036)");
{
  const theFile = MIGRATIONS.find((f) => f.endsWith("_listing_caps_its_walks.sql"))!;  // by name: renumbered when main takes its number
  const number = theFile.slice(0, 3);
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "094" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === theFile }).then(() => "applied", (e: Error) => e.message);
  assert(refused === `migration ${number} needs 094 (list_proposal_writers, ob1_accept_takes, ob1_accept_lapses); this schema lacks it`,
    `${number} on a schema stopped before 094 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < theFile });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${Array.from({ length: OPTS.dim }, (_, i) => (i === 1 ? 1 : 0)).join(",")}]`;
  const agentOf = async (seed: string, label: string, scope: string) => ((await sql`SELECT resolve_agent(${seed.repeat(64)}, ${label}, ${scope}) AS r`)[0].r as { agent_id: string }).agent_id;
  // [20aq]'s two keys, as it made them.
  const HOOK = { name: "hook-key", agent_id: await agentOf("5", "hook-key", "capture"), via: "open-brain", scope: "capture" };
  const WRITER = { name: "writer-key", agent_id: await agentOf("4", "writer-key", "write"), via: "open-brain" };
  let serial = 0;
  const cap = async (content: string, actor: Record<string, unknown>, supersedes?: string) =>
    ((await sql`SELECT upsert_thought(${`upgrade ${number}: ${content} ${++serial}`}::text, ${{ metadata: { source: "mcp" }, actor, ...(actor.scope === "capture" ? { recapture: "keep" } : {}), ...(supersedes ? { supersedes } : {}) }}::jsonb, ${vec}::vector) AS r`)[0].r as { id: string }).id;
  const propose = async (older: string, newer: string) =>
    ((await sql`SELECT record_supersession_proposal(${older}::uuid, ${newer}::uuid, 'newer_supersedes_older', 0.9, '[20ay]', 0.9, 'consolidate:stub@p96') AS id`)[0] as { id: string }).id;
  // Within the cap: the hook's rota proposed over the writer's, its next word onto it.
  const W = await cap("the writer's rota, weekly", WRITER);
  const C = await cap("the hook's rota, daily", HOOK);
  await cap("the hook's next word on the rota", HOOK, C);
  const near = await propose(W, C);
  // Past it: the hook's S proposed over the top of 25 of the hook's rows on the writer's B — 26 below.
  // The hook's pointers planted with the check off, as a brain from before 082 holds them.
  let below = await cap("B, the writer's", WRITER);
  await sql`ALTER TABLE thought_audit DISABLE TRIGGER thought_audit_check_capture_pointer`;
  try { for (let i = 1; i <= 25; i++) below = await cap(`c${i}`, HOOK, below); }
  finally { await sql`ALTER TABLE thought_audit ENABLE TRIGGER thought_audit_check_capture_pointer`; }
  const S = await cap("S, the hook's", HOOK);
  const far = await propose(below, S);
  const listed = async () => JSON.stringify(await sql`SELECT * FROM list_proposal_writers(${sql.array([near, far], "UUID")}::uuid[])`);
  const one = async (pid: string) => (await sql`SELECT * FROM list_proposal_writers(ARRAY[${pid}::uuid])`)[0] as Record<string, unknown>;
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), auditBefore = await audits(), nearBefore = JSON.stringify(await one(near)), farBefore = await one(far);
  assert(farBefore.newer_takes === true && (await sql`SELECT to_regprocedure('ob1_listing_walk_fits(uuid, uuid)') AS f`)[0].f === null,
    `[20ay] setup: before ${number} the listing reads the side over the 26-row chain, and there is no cap (${farBefore.newer_takes})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === theFile });
  const farAfter = await one(far), listedAfter = await listed();
  assert(JSON.stringify(await one(near)) === nearBefore && farAfter.newer_takes === null && farAfter.newer_lapses === null
      && farAfter.older_takes === farBefore.older_takes && farAfter.newer_actor_name === farBefore.newer_actor_name && farAfter.same_capturer === farBefore.same_capturer
      && (await rows()) === before && (await audits()) === auditBefore,
    `${number} applied: the proposal within the cap lists the same; the side over 26 rows has its takes and lapses unread, the rest of its row as before; no row or audit row moved`);
  // A re-apply moves nothing.
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === theFile });
  assert((await listed()) === listedAfter && (await rows()) === before && (await audits()) === auditBefore, `a re-apply of ${number} is a no-op`);
  await sql.close();
}

console.log("\n[20az] Migration 108: refused by name without 071; onto a populated brain at the file before it — the keyed rebuild there, no thought, audit or gate row moved by the file; a status write and a source row's write wait for the keyed form's locks, as for the full rebuild's; a set change run by the recipe reaching a session that searched eight times before it; a re-apply a no-op (SMD-3160)");
{
  const the108 = MIGRATIONS.find((f) => f.endsWith("_source_gate_keyed_rebuild.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "071" });
  const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the108 }).then(() => "applied", (e: Error) => e.message);
  assert(refused === "migration 108 needs 071 (ob1_source_gate_reconcile, ob1_rebuild_source_gate); this schema lacks it",
    `108 on a schema stopped before 071 is refused up front, naming what it needs (${refused})`);

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the108 });
  const sql = new SQL({ url: URL_, max: 1 });
  const ticket = async (key: string, type: string) =>
    ((await sql`INSERT INTO thoughts (content, metadata) VALUES (${`upgrade 108: ${key}`}, ${{ source: "linear", issue: key, status: type, status_type: type }}::jsonb) RETURNING id::text AS id`)[0] as { id: string }).id;
  const a = await ticket("UPK-1", "duplicate"), b = await ticket("UPK-2", "started");
  for (const [id, key] of [[a, "UPK-1"], [b, "UPK-2"]]) await sql`SELECT record_thought_source(${id}::uuid, 'linear', ${key}, ${key}, 'text/markdown')`;
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const mirror = async () => JSON.stringify(await sql`SELECT thought_id, system, gates FROM ob1_source_gate ORDER BY thought_id`);
  const before = await rows(), auditBefore = await audits(), mirrorBefore = await mirror();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the108 });
  const [fn] = await sql`SELECT to_regprocedure('ob1_rebuild_source_gate_for_types(text[])') IS NOT NULL AS ok`;
  const [r] = await sql`SELECT * FROM ob1_rebuild_source_gate_for_types('{duplicate}')`;
  assert(fn.ok && (await rows()) === before && (await audits()) === auditBefore && (await mirror()) === mirrorBefore && r.written === 0 && r.deleted === 0,
    `108 onto the populated brain: the keyed rebuild there, finding the exact mirror exact (${JSON.stringify(r)}), and no thought, audit or gate row moved`);

  // The keyed form holds SHARE on thoughts and on thought_sources to its
  // transaction's end, as the full rebuild does: a status write and a source
  // row's write in the meantime each wait, here cut at 1 s. The second is the
  // one only thought_sources' lock holds off — a source row recorded meanwhile
  // would take its gate from the set as it was (review pass 1).
  const c = await ticket("UPK-3", "duplicate");
  const holder = new SQL({ url: URL_, max: 1 });
  const errOf = (e: Error) => (e as Error & { errno?: string }).errno ?? (e as Error & { code?: string }).code ?? e.message;
  const cut = (write: (tx: SQL) => Promise<unknown>) => sql.begin(async (tx: SQL) => { await tx.unsafe(`SET LOCAL lock_timeout = '1s'`); await write(tx); return "ran"; }).catch(errOf);
  let waited = "ran", sourceWaited = "ran", after = "unread", sourceAfter = "unread";
  try {
    await holder.unsafe(`BEGIN; SELECT * FROM ob1_rebuild_source_gate_for_types('{duplicate}')`);
    waited = await cut((tx) => tx`UPDATE thoughts SET metadata = metadata || '{"status_type": "completed"}'::jsonb WHERE id = ${b}::uuid`);
    sourceWaited = await cut((tx) => tx`SELECT record_thought_source(${c}::uuid, 'linear', 'UPK-3', 'UPK-3', 'text/markdown')`);
    await holder.unsafe(`COMMIT`);
    await sql`UPDATE thoughts SET metadata = metadata || '{"status_type": "completed"}'::jsonb WHERE id = ${b}::uuid`;
    await sql`SELECT record_thought_source(${c}::uuid, 'linear', 'UPK-3', 'UPK-3', 'text/markdown')`;
    after = String(((await sql`SELECT gates FROM ob1_source_gate WHERE thought_id = ${b}::uuid`)[0] as { gates: boolean }).gates);
    sourceAfter = String(((await sql`SELECT gates FROM ob1_source_gate WHERE thought_id = ${c}::uuid`)[0] as { gates: boolean } | undefined)?.gates ?? "no row");
  } finally {
    await holder.unsafe(`ROLLBACK`).catch(() => undefined);
    await holder.close();
  }
  assert(waited === "55P03" && sourceWaited === "55P03" && after === "true" && sourceAfter === "true",
    `a status write and a source row's write each wait for the keyed form's locks to its transaction's end (${waited}, ${sourceWaited} at a 1 s lock_timeout), and go through after, the mirror following both (${after}, ${sourceAfter})`);

  // A set change as the recipe runs it, against a server's pooled
  // connection: a session that searched eight times with prefer_current
  // before it (a cached generic plan) demotes a ticket of the newly settled
  // type after it — the refresh is what reaches it, as [20aw] shows a session
  // without 105's block keeps the old set (review pass 3).
  const VEC = `[${Array.from({ length: OPTS.dim }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  const [{ id: kdone }] = await sql`INSERT INTO thoughts (content, metadata, embedding) VALUES ('upgrade 108: UPK-9', ${{ source: "linear", issue: "UPK-9", status: "Kgdone", status_type: "kgdone" }}::jsonb, ${VEC}::vector) RETURNING id::text AS id`;
  await sql`SELECT record_thought_source(${kdone}::uuid, 'linear', 'UPK-9', 'UPK-9', 'text/markdown')`;
  const [sets0] = await sql`SELECT node_lifecycle_types() AS k, node_settled_types() AS st`;
  const warm = new SQL({ url: URL_, max: 1 });
  const demoted = async () => (((await warm`SELECT demoted FROM search_thoughts_current(${VEC}::vector, 'upgrade 108', 0, 10, '{}'::jsonb, 0, 30, NULL) WHERE id = ${kdone}::uuid`)[0] as { demoted: string[] | null } | undefined)?.demoted ?? null);
  const warmBefore: (string[] | null)[] = [];
  for (let i = 0; i < 8; i++) warmBefore.push(await demoted());
  const setSql = (k: string[], st: string[]) => `CREATE OR REPLACE FUNCTION node_lifecycle_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{${k.join(",")}}'::text[] $$;
    CREATE OR REPLACE FUNCTION node_settled_types() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT '{${st.join(",")}}'::text[] $$;`;
  await sql.begin(async (tx: SQL) => {
    await tx.unsafe(setSql([...(sets0.k as string[]), "kgdone"], [...(sets0.st as string[]), "kgdone"]));
    await tx`SELECT ob1_refresh_set_readers()`;
    await tx`SELECT * FROM ob1_rebuild_source_gate_for_types('{kgdone}')`;
  });
  const warmAfter = await demoted();
  await warm.close();
  const [g9] = await sql`SELECT gates FROM ob1_source_gate WHERE thought_id = ${kdone}::uuid`;
  const [d9] = await sql`SELECT count(*)::int AS n FROM ob1_node_projection_drift()`;
  assert(warmBefore.every((d) => d === null) && warmAfter?.join() === "kgdone" && g9.gates === true && d9.n === 0,
    `a set change run as the recipe says — the set, ob1_refresh_set_readers(), the keyed rebuild — reaches a session that searched eight times before it (${JSON.stringify([warmBefore[0], warmAfter])}), and the gate follows with nothing drifting`);
  // The sets as they were, by the same recipe.
  await sql.begin(async (tx: SQL) => {
    await tx.unsafe(setSql(sets0.k as string[], sets0.st as string[]));
    await tx`SELECT ob1_refresh_set_readers()`;
    await tx`SELECT * FROM ob1_rebuild_source_gate_for_types('{kgdone}')`;
  });

  // A re-apply moves nothing.
  const rowsAgain = await rows(), mirrorAgain = await mirror(), auditsAgain = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the108 });
  assert((await rows()) === rowsAgain && (await mirror()) === mirrorAgain && (await audits()) === auditsAgain, "a re-apply of 108 is a no-op: no thought, gate or audit row moved");
  await sql.close();
}

console.log("\n[20ba] Migration 109: refused by name without 016, 025 or 029; onto a populated brain at the file before it — 070's three-argument listing replaced by one form of four, the proposals planted before it listing the same through a three-argument call after it and selecting by their judge key, no proposal, thought or audit row moved; a re-apply a no-op (SMD-3248)");
{
  const the109 = MIGRATIONS.find((f) => f.endsWith("_listing_selects_a_pass.sql"))!;  // by name: renumbered when main takes its number
  // Each prerequisite in turn (review pass 1: 016's and 025's refusals survived a mutant).
  for (const [stop, needs] of [
    ["016", "migration 109 needs 016 (content_fingerprint_of); this schema lacks it"],
    ["025", "migration 109 needs 025 (thoughts.derived_from); this schema lacks it"],
    ["029", "migration 109 needs 029 (supersession_proposals); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the109 }).then(() => "applied", (e: Error) => e.message);
    assert(refused === needs, `109 on a schema stopped before ${stop} is refused up front, naming what it needs (${refused})`);
  }

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the109 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  const t: string[] = [];
  for (let i = 0; i < 4; i++) {
    t.push(((await sql`SELECT upsert_thought(${`upgrade 109: thought ${i}`}::text, ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(i)}::vector) AS r`)[0].r as { id: string }).id);
    await sql`UPDATE thoughts SET created_at = now() - make_interval(days => ${10 - i}::int) WHERE id = ${t[i]}::uuid`;
  }
  // Two passes' proposals, as the canary holds them: an older decide version's and a newer one's.
  const A = "consolidate:h2o-lightning-4b+qwen3.8:27b@p4d1", B = "consolidate:h2o-lightning-4b+qwen3.8:27b@p4d3";
  const propose = async (o: number, n: number, confidence: number, key: string) =>
    ((await sql`SELECT record_supersession_proposal(${t[o]}::uuid, ${t[n]}::uuid, 'newer_supersedes_older', ${confidence}::numeric, 'stub', 0.9, ${key}::text) AS id`)[0] as { id: string }).id;
  const a1 = await propose(0, 1, 0.7, A), a2 = await propose(0, 2, 0.6, A), b1 = await propose(1, 3, 0.9, B);
  const SIG3 = "list_supersession_proposals(text, int, boolean)", SIG4 = "list_supersession_proposals(text, int, boolean, text)";
  const forms = async () => (await sql`
    SELECT to_regprocedure(${SIG3}) IS NOT NULL AS three, to_regprocedure(${SIG4}) IS NOT NULL AS four,
           (SELECT count(*)::int FROM pg_proc WHERE proname = 'list_supersession_proposals') AS n,
           (SELECT prosrc LIKE '%ob1:listing-selects-a-pass%' AND prosrc LIKE '%ob1:listing-flags-the-lineage-pair%' FROM pg_proc WHERE oid = to_regprocedure(${SIG4})) AS sentinels`)[0] as { three: boolean; four: boolean; n: number; sentinels: boolean | null };
  // The listing as a caller from before 109 reads it: three arguments, every status, each row whole.
  const listing = async () => String((await sql`SELECT jsonb_agg(l ORDER BY l.id)::text AS j FROM list_supersession_proposals(NULL::text, 200, NULL::boolean) l`)[0].j);
  const proposals = async () => JSON.stringify(await sql`SELECT id, older_id, newer_id, status, verdict, confidence::text AS c, judge_key, judged_at::text AS j FROM supersession_proposals ORDER BY id`);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const pre = await forms();
  const listedBefore = await listing(), proposalsBefore = await proposals(), before = await rows(), auditBefore = await audits();
  assert(pre.three === true && pre.four === false && Number(pre.n) === 1, "before 109 the listing is 070's three-argument form alone");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the109 });

  const post = await forms();
  const byKey = async (key: string | null) => ((await sql`SELECT id::text FROM list_supersession_proposals('pending'::text, 50, NULL::boolean, ${key}::text)`) as { id: string }[]).map((r) => r.id).join();
  assert(post.three === false && post.four === true && Number(post.n) === 1 && post.sentinels === true,
    "…and after: the four-argument form alone, carrying both sentinels, the three-argument one gone");
  assert((await listing()) === listedBefore,
    "the proposals planted before the file list the same after it through a three-argument call — every column, every row");
  assert((await byKey(A)) === [a1, a2].join() && (await byKey(B)) === b1 && (await byKey(null)) === [b1, a1, a2].join(),
    "…and select by their judge key: the older pass's two, the newer's one, every pass on NULL, most confident first");
  assert((await proposals()) === proposalsBefore && (await rows()) === before && (await audits()) === auditBefore,
    "the file is DDL alone: no proposal, thought or audit row moved");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the109 });
  const again = await forms();
  assert(Number(again.n) === 1 && again.sentinels === true && (await listing()) === listedBefore && (await byKey(A)) === [a1, a2].join(),
    "a re-apply is a no-op: one form, the same rows, the same selection");
  await sql.close();
}

console.log("\n[20bb] Migration 110: refused by name without 016, 025 or 029; onto a populated brain at the file before it — 109's four-argument listing replaced by one form of seven, the proposals planted before it listing the same through a four-argument call after it (110's two columns beside), walked page by page with the cursor; no proposal, thought or audit row moved; a re-apply a no-op (SMD-3249)");
{
  const the110 = MIGRATIONS.find((f) => f.endsWith("_listing_pages.sql"))!;  // by name: renumbered when main takes its number
  for (const [stop, needs] of [
    ["016", "migration 110 needs 016 (content_fingerprint_of); this schema lacks it"],
    ["025", "migration 110 needs 025 (thoughts.derived_from); this schema lacks it"],
    ["029", "migration 110 needs 029 (supersession_proposals); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the110 }).then(() => "applied", (e: Error) => e.message);
    assert(refused === needs, `110 on a schema stopped before ${stop} is refused up front, naming what it needs (${refused})`);
  }

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the110 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  const t: string[] = [];
  for (let i = 0; i < 4; i++) {
    t.push(((await sql`SELECT upsert_thought(${`upgrade 110: thought ${i}`}::text, ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(i)}::vector) AS r`)[0].r as { id: string }).id);
  }
  // Five proposals over distinct pairs, two of one confidence, under one pass.
  let n = 0;
  for (let i = 0; i < 4 && n < 5; i++) for (let j = 0; j < 4 && n < 5; j++) {
    if (i === j) continue;
    await sql`SELECT record_supersession_proposal(${t[i]}::uuid, ${t[j]}::uuid, 'newer_supersedes_older', ${[0.9, 0.8, 0.8, 0.7, 0.6][n]}::numeric, 'stub', 0.9, 'consolidate:stub@p110')`;
    n++;
  }
  const SIG4 = "list_supersession_proposals(text, int, boolean, text)", SIG7 = "list_supersession_proposals(text, int, boolean, text, numeric, timestamptz, uuid)";
  const forms = async () => (await sql`
    SELECT to_regprocedure(${SIG4}) IS NOT NULL AS four, to_regprocedure(${SIG7}) IS NOT NULL AS seven,
           (SELECT count(*)::int FROM pg_proc WHERE proname = 'list_supersession_proposals') AS n,
           (SELECT prosrc LIKE '%ob1:listing-pages%' AND prosrc LIKE '%ob1:listing-selects-a-pass%' AND prosrc LIKE '%ob1:listing-flags-the-lineage-pair%' FROM pg_proc WHERE oid = to_regprocedure(${SIG7})) AS sentinels`)[0] as { four: boolean; seven: boolean; n: number; sentinels: boolean | null };
  // The listing as a caller from before 110 reads it — four arguments — each row's 109 columns, by name.
  const COLS = "id, status, verdict, confidence, reason, similarity, judge_key, judged_at, reviewed_at, review_note, superseding_id, older_id, older_content, older_created_at, newer_id, newer_content, newer_created_at, older_edited, newer_edited, lineage";
  const listing = async () => String((await sql.unsafe(`SELECT jsonb_agg(l ORDER BY l.id)::text AS j FROM (SELECT ${COLS} FROM list_supersession_proposals(NULL::text, 200, NULL::boolean, NULL::text)) l`))[0].j);
  const proposals = async () => JSON.stringify(await sql`SELECT id, older_id, newer_id, status, verdict, confidence::text AS c, judge_key, judged_at::text AS j FROM supersession_proposals ORDER BY id`);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const pre = await forms();
  const listedBefore = await listing(), proposalsBefore = await proposals(), before = await rows(), auditBefore = await audits();
  assert(pre.four === true && pre.seven === false && Number(pre.n) === 1, "before 110 the listing is 109's four-argument form alone");

  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the110 });

  const post = await forms();
  assert(post.four === false && post.seven === true && Number(post.n) === 1 && post.sentinels === true,
    "…and after: the seven-argument form alone, carrying the three sentinels, the four-argument one gone");
  assert((await listing()) === listedBefore, "the proposals planted before the file list the same after it through a four-argument call — every one of 109's columns, every row");
  // A walk in pages of two with the cursor, as the store reads it: each row once, in the listing's order.
  const order = ((await sql`SELECT id::text FROM supersession_proposals ORDER BY confidence DESC, judged_at, id`) as { id: string }[]).map((r) => r.id);
  const seen: string[] = [];
  let after: string[] | null = null;
  for (let k = 0; k < 10; k++) {
    const page = (await sql`SELECT id::text, page_key, remaining FROM list_supersession_proposals('pending'::text, 2, NULL::boolean, NULL::text, ${after?.[0] ?? null}::numeric, ${after?.[1] ?? null}::timestamptz, ${after?.[2] ?? null}::uuid)`) as { id: string; page_key: string; remaining: string }[];
    seen.push(...page.map((r) => r.id));
    if (!page.length || Number(page[0].remaining) <= page.length) break;
    after = JSON.parse(page[page.length - 1].page_key) as string[];
  }
  assert(seen.join() === order.join() && order.length === 5, `walked in pages of two with the cursor: each of the five once, in the listing's order (${seen.length})`);
  assert((await proposals()) === proposalsBefore && (await rows()) === before && (await audits()) === auditBefore, "the file is DDL alone: no proposal, thought or audit row moved");
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the110 });
  const again = await forms();
  assert(Number(again.n) === 1 && again.sentinels === true && (await listing()) === listedBefore, "a re-apply is a no-op: one form, the same rows");
  await sql.close();
}

console.log("\n[20bc] Migration 111: refused by name without 016, 042, 061, 084 or 102; onto a populated brain at the file before it — a relation, a citation and their lineage planted before it standing as they were, a subject refused as an unregistered kind before and written by record_thought_subject after, with its lineage; no thought or audit row moved; a re-apply a no-op (SMD-3306)");
{
  const the111 = MIGRATIONS.find((f) => f.endsWith("_thought_subject.sql"))!;  // by name: renumbered when main takes its number
  // Each prerequisite in turn, the first missing named.
  for (const [stop, needs] of [
    ["016", "migration 111 needs 016 (content_fingerprint_of); this schema lacks it"],
    ["042", "migration 111 needs 042 (thought_facets); this schema lacks it"],
    ["061", "migration 111 needs 061 (ob1_record_derivation); this schema lacks it"],
    ["084", "migration 111 needs 084 (record_thought_relation); this schema lacks it"],
    ["102", "migration 111 needs 102 (record_thought_relation taking distinct); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the111 }).then(() => "applied", (e: Error) => e.message);
    assert(refused === needs, `111 on a schema stopped before ${stop} is refused up front, naming what it needs (${refused})`);
  }

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the111 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  await sql`SELECT set_agent_kind('laptop', 'operator')`;
  const actor = { name: "laptop", via: "open-brain" };
  const t: string[] = [];
  for (let i = 0; i < 3; i++)
    t.push(((await sql`SELECT upsert_thought(${`upgrade 111: Session summary — SMD-${3300 + i} — thought ${i}`}::text, ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(i)}::vector) AS r`)[0].r as { id: string }).id);
  const fpOf = async (id: string) => String((await sql`SELECT COALESCE(content_fingerprint, content_fingerprint_of(content)) AS f FROM thoughts WHERE id = ${id}::uuid`)[0].f);
  // A brain before 111 holds relations, with their lineage, and citations: planted here as the pass and a writer leave them.
  await sql`SELECT record_thought_relation(${t[1]}::uuid, ${t[0]}::uuid, 'evolves', 0.8, 'consolidate:h2o-lightning-4b+qwen3.8:27b@p4d4', NULL::uuid, ${await fpOf(t[0])}::text, ${await fpOf(t[1])}::text, NULL::jsonb)`;
  await sql`INSERT INTO thought_facets (thought_id, kind, payload) VALUES (${t[2]}::uuid, 'citation', ${{ text: "rests on thought 0", stance: "stated", source_id: t[0] }}::jsonb)`;
  const facets = async () => JSON.stringify(await sql`SELECT id, thought_id, kind, payload, valid_until::text AS v FROM thought_facets ORDER BY id`);
  const lineage = async () => JSON.stringify(await sql`SELECT artifact_kind, artifact_id, input_ids, input_fingerprints, produced_by, recipe FROM derivations ORDER BY id`);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const facetsBefore = await facets(), lineageBefore = await lineage(), before = await rows(), auditBefore = await audits();
  const unregistered = await sql`INSERT INTO thought_facets (thought_id, kind, payload) VALUES (${t[0]}::uuid, 'subject', ${{ key: "ticket:SMD-3300", by: "first_line", judge_key: "subject:x@p1" }}::jsonb)`.then(() => "admitted", (e: Error) => e.message);
  assert(/is not a registered facet kind/.test(unregistered) && JSON.parse(facetsBefore).length === 2, `before 111 a subject is not a registered kind (${unregistered.slice(0, 80)})`);

  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the111 });

  assert((await facets()) === facetsBefore && (await lineage()) === lineageBefore && (await rows()) === before && (await audits()) === auditBefore,
    "the file moves nothing it finds: the relation and the citation, their lineage, every thought and audit row stand as they were");
  const w = (await sql`SELECT record_thought_subject(${t[0]}::uuid, 'ticket:SMD-3300', 'first_line', 'subject:qwen3.8:27b@p1', NULL::uuid, ${await fpOf(t[0])}::text, NULL::jsonb) AS r`)[0].r as { action: string; id: string };
  const [row] = (await sql`SELECT artifact_kind AS k, input_ids::text[] AS i FROM derivations WHERE artifact_kind = 'subject' AND artifact_id = ${w.id}::uuid`) as { k: string; i: string[] }[];
  assert(w.action === "added" && row?.k === "subject" && row?.i.join() === t[0], `after it, record_thought_subject writes a subject with its lineage row (${JSON.stringify(w)})`);
  const facetsAfter = await facets(), lineageAfter = await lineage();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the111 });
  assert((await facets()) === facetsAfter && (await lineage()) === lineageAfter && (await rows()) === before,
    "a re-apply is a no-op: every facet, lineage row and thought as it was");
  await sql.close();
}

console.log("\n[20bd] Migration 112: onto a populated brain at the file before it — thoughts with metadata, a caller's client_key among them, standing as they were, and one thought per key after it; rows a caller left sharing a key refused by name, nothing built, then applied once they are cleared; a re-apply a no-op (SMD-3314)");
{
  const the112 = MIGRATIONS.find((f) => f.endsWith("_thought_client_key.sql"))!;  // by name: renumbered when main takes its number
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the112 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const actor = { name: "laptop", via: "open-brain" };
  const key = "0d3f4e1a-2b3c-4d5e-8f60-718293a4b5c6";
  // A brain before 112: a caller's metadata could set client_key like any key of its own (SMD-2014).
  for (const [i, meta] of [{ source: "mcp" }, { source: "mcp", client_key: key }, { source: "mcp", note: "kept" }].entries())
    await sql`SELECT upsert_thought(${`upgrade 112: thought ${i}`}::text, ${{ metadata: meta, actor, embedding_model: OPTS.model }}::jsonb, ${vec(i)}::vector) AS r`;
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const index = async () => String((await sql`SELECT pg_get_indexdef(to_regclass('thoughts_client_key_unique')) AS d`)[0].d ?? "");

  // A second row sharing the key: refused by name, nothing built, nothing recorded.
  await sql`SELECT upsert_thought('upgrade 112: a second caller''s copy of the key'::text, ${{ metadata: { source: "mcp", client_key: key }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(3)}::vector) AS r`;
  const shared = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the112 }).then(() => "applied", (e: Error) => e.message);
  assert(/^migration 112: 1 metadata\.client_key value\(s\) are kept by more than one thought \(the first: 0d3f4e1a-/.test(shared) && (await index()) === "",
    `rows sharing a key: refused by name, no index built (${shared.slice(0, 100)})`);
  await sql`UPDATE thoughts SET metadata = metadata - 'client_key' WHERE content = 'upgrade 112: a second caller''s copy of the key'`;

  const before = await rows(), auditBefore = await audits();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the112 });
  assert((await rows()) === before && (await audits()) === auditBefore && /^CREATE UNIQUE INDEX thoughts_client_key_unique /.test(await index()),
    "cleared, the file builds the index and moves nothing it finds: every thought and audit row as it was, the caller's key kept");
  const dup = await sql`SELECT upsert_thought('upgrade 112: a third copy'::text, ${{ metadata: { source: "mcp", client_key: key }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(4)}::vector) AS r`.then(() => "admitted", (e: Error) => e.message);
  assert(/thoughts_client_key_unique/.test(dup), `after it, one thought per key (${dup.slice(0, 80)})`);
  const moved = await sql`UPDATE thoughts SET metadata = metadata || ${{ client_key: "0d3f4e1a-2b3c-4d5e-8f60-718293a4b5c7" }}::jsonb WHERE content = 'upgrade 112: thought 1'`.then(() => "applied", (e: Error) => e.message);
  assert(/^client_key is set once: thought /.test(moved), `…and the caller's key, kept from before, is set once: a write moving it refused (${moved.slice(0, 80)})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the112 });
  assert((await rows()) === before && /^CREATE UNIQUE INDEX thoughts_client_key_unique /.test(await index()), "a re-apply is a no-op");
  await sql.close();
}

console.log("\n[20be] Migration 113: refused by name without 015, 016 or 111; onto a populated brain at the file before it — thoughts, a subject and the extraction pool standing as they were, and no subject claim until a pool is named; after it a new or edited thought joins the named pool, a metadata edit does not unless it changes metadata.ticket or metadata.issue, and close_thought_subject closes the subject read; a re-apply is a no-op (SMD-3306)");
{
  const the113 = MIGRATIONS.find((f) => f.endsWith("_subject_pool.sql"))!;  // by name: renumbered when main takes its number
  // Each prerequisite in turn, the first missing named.
  for (const [stop, needs] of [
    ["015", "migration 113 needs 015 (claim_thoughts); this schema lacks it"],
    ["016", "migration 113 needs 016 (requeue_thought_work); this schema lacks it"],
    ["111", "migration 113 needs 111 (record_thought_subject); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the113 }).then(() => "applied", (e: Error) => e.message);
    assert(refused === needs, `113 on a schema stopped before ${stop} is refused up front, naming what it needs (${refused})`);
  }
  // A database not UTF8 is refused by name, before anything else: the file holds no escape a SQL_ASCII server cannot
  // read (review pass 6, run-it: it failed on them, "conversion between UTF8 and SQL_ASCII is not supported").
  {
    const admin = new SQL({ url: URL_, max: 1 });
    const ascii = new URL(URL_);
    ascii.pathname = "/ob1_up113_ascii";
    try {
      await admin.unsafe("DROP DATABASE IF EXISTS ob1_up113_ascii");
      await admin.unsafe("CREATE DATABASE ob1_up113_ascii ENCODING 'SQL_ASCII' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'");
      const refusedAscii = await applyMigrations(ascii.toString(), { ...OPTS, only: (f) => f === the113 }).then(() => "applied", (e: Error) => e.message);
      assert(refusedAscii === "migration 113 needs a UTF8 database; this one's encoding is SQL_ASCII",
        `113 on a SQL_ASCII database is refused by name (${refusedAscii.slice(0, 120)})`);
    } finally {
      await admin.unsafe("DROP DATABASE IF EXISTS ob1_up113_ascii").catch(() => {});
      await admin.close();
    }
  }

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the113 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const actor = { name: "laptop", via: "open-brain" };
  const POOL = "subjects:r1.2:p2r";
  // A brain before 113: the extraction pool named, so its trigger enqueues; a subject the sweep wrote.
  await sql`INSERT INTO ob1_config (key, value) VALUES ('entity_extraction_key', 'extract:x@p2')`;
  const t: string[] = [];
  for (let i = 0; i < 2; i++)
    t.push(((await sql`SELECT upsert_thought(${`upgrade 113: thought ${i}`}::text, ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(i)}::vector) AS r`)[0].r as { id: string }).id);
  const fpOf = async (id: string) => String((await sql`SELECT COALESCE(content_fingerprint, content_fingerprint_of(content)) AS f FROM thoughts WHERE id = ${id}::uuid`)[0].f);
  const subject = (await sql`SELECT record_thought_subject(${t[0]}::uuid, 'phrase:upgrade', 'model', 'subject:x@p2', NULL::uuid, ${await fpOf(t[0])}::text, NULL::jsonb) AS r`)[0].r as { id: string };
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, created_at::text AS c, updated_at::text AS u FROM thoughts ORDER BY id`);
  const facets = async () => JSON.stringify(await sql`SELECT id, thought_id, kind, payload, valid_until::text AS v FROM thought_facets ORDER BY id`);
  const claims = async () => JSON.stringify(await sql`SELECT thought_id, work_type, status FROM thought_work_claims ORDER BY thought_id, work_type`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = await rows(), facetsBefore = await facets(), claimsBefore = await claims(), auditBefore = await audits();

  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the113 });

  assert((await rows()) === before && (await facets()) === facetsBefore && (await claims()) === claimsBefore && (await audits()) === auditBefore,
    "the file moves nothing it finds: every thought, facet, claim and audit row stands as it was");
  const inPool = async (id: string) => String((await sql`SELECT status FROM thought_work_claims WHERE thought_id = ${id}::uuid AND work_type = ${POOL}`)[0]?.status ?? "none");
  const third = ((await sql`SELECT upsert_thought('upgrade 113: thought 2, before a pool is named'::text, ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(2)}::vector) AS r`)[0].r as { id: string }).id;
  assert((await inPool(third)) === "none", "no pool named: a new thought joins none");
  await sql`INSERT INTO ob1_config (key, value) VALUES ('subject_pool_key', ${POOL})`;
  const fourth = ((await sql`SELECT upsert_thought('upgrade 113: thought 3, after'::text, ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(3)}::vector) AS r`)[0].r as { id: string }).id;
  await sql`UPDATE thought_work_claims SET status = 'succeeded', finished_at = now() WHERE thought_id = ${fourth}::uuid AND work_type = ${POOL}`;
  await sql`SELECT update_thought(${t[1]}::uuid, 'upgrade 113: thought 1, edited')`;
  await sql`UPDATE thoughts SET metadata = metadata || '{"note": "a metadata edit"}'::jsonb WHERE id = ${third}::uuid`;
  assert((await inPool(t[1])) === "pending" && (await inPool(third)) === "none" && (await inPool(fourth)) === "succeeded",
    "after it, with a pool named, an edited thought joins it; a metadata edit does not");
  await sql`UPDATE thoughts SET metadata = metadata || '{"issue": "SMD-113"}'::jsonb WHERE id = ${third}::uuid`;
  assert((await inPool(third)) === "pending", "…but filing it under a ticket does: the metadata rule reads it");
  await sql`SELECT update_thought(${fourth}::uuid, 'upgrade 113: thought 3, edited after it was asked')`;
  assert((await inPool(fourth)) === "pending", "…and a thought finished in the pool is put back in it once its text changes");
  const closed = (await sql`SELECT close_thought_subject(${t[0]}::uuid, ${subject.id}::uuid, ${await fpOf(t[0])}::text) AS c`)[0].c as { action: string; id: string };
  assert(closed.action === "closed" && closed.id === subject.id, `close_thought_subject closes the subject read (${JSON.stringify(closed)})`);
  // The door 113 redefines, on the upgraded brain: a model's subject on a thought filed under a ticket is refused as
  // stale, the ticket's rule subject written (review pass 5).
  const door = async (id: string, key: string, by: string) =>
    (await sql`SELECT record_thought_subject(${id}::uuid, ${key}, ${by}, ${`subject:${by}@r1`}, NULL, ${await fpOf(id)}, NULL) AS r`)[0].r as { action: string; stale?: boolean };
  const [modelUp, ruleUp] = [await door(third, "phrase:an upgraded note", "model"), await door(third, "ticket:SMD-113", "metadata")];
  assert(modelUp.action === "none" && modelUp.stale === true && ruleUp.action === "added",
    `the door 113 redefines: a model's subject on a thought filed under a ticket refused as stale, the rule's at its ticket added (${modelUp.action}, ${ruleUp.action})`);
  const after = await rows(), facetsAfter = await facets(), claimsAfter = await claims();
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the113 });
  assert((await rows()) === after && (await facets()) === facetsAfter && (await claims()) === claimsAfter, "a re-apply is a no-op: every thought, facet and claim as it was");
  await sql.close();
  // A naming waits for the writers of this database's thoughts alone: a template copy of the brain, its thoughts the
  // same relation by oid, a capture open in it, holds up no naming here (review pass 7, run-it: without the lock read's
  // database filter it listed that writer, and the wait, which has no end of its own, would wait on it). Bounded by a
  // stop, should it wait.
  {
    // A brain of its own, at 113, whose copy is made with no session on it: the suite's database has the earlier
    // sections' sessions on it.
    const pg = new URL(URL_), brain = new URL(URL_), copy = new URL(URL_);
    pg.pathname = "/postgres";
    brain.pathname = "/ob1_up113_brain";
    copy.pathname = "/ob1_up113_copy";
    const admin = new SQL({ url: pg.toString(), max: 1 });
    const copyClient = new SQL({ url: copy.toString(), max: 1 });
    try {
      await admin.unsafe("DROP DATABASE IF EXISTS ob1_up113_copy");
      await admin.unsafe("DROP DATABASE IF EXISTS ob1_up113_brain");
      await admin.unsafe("CREATE DATABASE ob1_up113_brain");
      await applyMigrations(brain.toString(), OPTS);
      await admin.unsafe("CREATE DATABASE ob1_up113_copy TEMPLATE ob1_up113_brain");
      const w = await copyClient.reserve();
      await w`BEGIN`;
      await w`SELECT upsert_thought('upgrade 113: a capture open in a copy of the brain'::text, ${{ metadata: { source: "mcp" }, actor, embedding_model: OPTS.model }}::jsonb, ${vec(5)}::vector)`;
      const bound = new AbortController();
      const timer = setTimeout(() => bound.abort(), 10_000);
      const lines: string[] = [];
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OB1_LLM_BASE_URL: "http://127.0.0.1:9/v1", OB1_LLM_LOCAL: "1", OB1_METADATA_MODEL: "stub-meta", OB1_JUDGE_MODEL: "stub-judge" };
      const code = await sweepSubjects({ url: brain.toString(), env, model: false, switchKey: true, signal: bound.signal, writer: { out: (l) => lines.push(l), err: (l) => lines.push(l) } })
        .finally(() => clearTimeout(timer));
      await w`ROLLBACK`;
      w.release();
      assert(code === 0 && !lines.some((l) => /waiting for/.test(l)),
        `a capture open in a template copy of the brain holds up no naming here (exit ${code}: ${lines.find((l) => /waiting|stopped/.test(l))?.trim().slice(0, 100) ?? "no wait"})`);
    } finally {
      await copyClient.close({ timeout: 5 });
      await admin.unsafe("DROP DATABASE IF EXISTS ob1_up113_copy").catch(() => {});
      await admin.unsafe("DROP DATABASE IF EXISTS ob1_up113_brain").catch(() => {});
      await admin.close();
    }
  }
}

console.log("\n[20bf] Migration 114: refused by name without 008, 029, 046 or 050; onto a populated brain at the file before it — proposals decided before it, the reviewer backfilled from the audit for an accept that wrote its pointer and a reject that cleared one, none guessed for a reject that cleared nothing; no thought, audit row or decision moved; a decision after it stamped with its key; a re-apply a no-op (SMD-2608)");
{
  const the114 = MIGRATIONS.find((f) => f.endsWith("_proposal_reviewer.sql"))!;  // by name: renumbered when main takes its number
  for (const [stop, needs] of [
    ["008", "migration 114 needs 008 (ob1_current_actor); this schema lacks it"],
    ["029", "migration 114 needs 029 (supersession_proposals); this schema lacks it"],
    ["046", "migration 114 needs 046 (ob1_registry_kind); this schema lacks it"],
    ["050", "migration 114 needs 050 (thought_audit.seq); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const refused = await applyMigrations(URL_, { ...OPTS, only: (f) => f === the114 }).then(() => "applied", (e: Error) => e.message);
    assert(refused === needs, `114 on a schema stopped before ${stop} is refused up front, naming what it needs (${refused})`);
  }

  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < the114 });
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = (axis: number) => `[${Array.from({ length: OPTS.dim }, (_, i) => (i === axis ? 1 : 0)).join(",")}]`;
  const t: string[] = [];
  for (let i = 0; i < 10; i++)
    t.push(((await sql`SELECT upsert_thought(${`upgrade 114: thought ${i}`}::text, ${{ metadata: { source: "mcp" }, embedding_model: OPTS.model }}::jsonb, ${vec(i)}::vector) AS r`)[0].r as { id: string }).id);
  const [{ id: agent }] = await sql`INSERT INTO ob1_agents (label, kind) VALUES ('upgrade-114-operator', 'operator') RETURNING canonical_agent_id::text AS id`;
  const OPERATOR = { name: "upgrade-114-operator", via: "consolidate", agent_id: agent };
  // A second key clears what the first accepted: the backfill must name the clear's own row, by its time.
  const [{ id: agent2 }] = await sql`INSERT INTO ob1_agents (label, kind) VALUES ('upgrade-114-agent', 'agent') RETURNING canonical_agent_id::text AS id`;
  const AGENT = { name: "upgrade-114-agent", via: "open-brain-api", agent_id: agent2 };
  const propose = async (o: number, n: number) =>
    String((await sql`SELECT record_supersession_proposal(${t[o]}::uuid, ${t[n]}::uuid, 'newer_supersedes_older', 0.9, 'stub', 0.9, 'consolidate:stub@p1') AS id`)[0].id);
  const review = async (id: string, decision: string, actor: object = OPERATOR) =>
    (await sql`SELECT review_supersession_proposal(${id}::uuid, ${decision}, 'decided before 114', NULL, ${actor}::jsonb, false) AS r`)[0].r as { ok: boolean; cleared?: boolean };
  // Before 114: an accept that writes its pointer, an accept then a clearing reject, a reject that clears nothing.
  // reRejected: cleared by one key, then rejected again by another, clearing nothing — the clear's row is an earlier
  // decision's, and the standing one has none.
  const accepted = await propose(0, 1), cleared = await propose(2, 3), plain = await propose(4, 5), reRejected = await propose(3, 5);
  const decisions = [await review(accepted, "accept"), await review(cleared, "accept"), await review(cleared, "reject", AGENT), await review(plain, "reject"),
    await review(reRejected, "accept"), await review(reRejected, "reject", AGENT), await review(reRejected, "reject")];
  // The audit's kind is not always a key's at its decision: a keyless accept under a classified name (055 reads the
  // kind by name), and a key classified after it decided, its audit row's kind filled in by 046's backfill.
  await sql`INSERT INTO ob1_agents (label, kind) VALUES ('consolidate', 'operator')`;
  const keyless = await propose(6, 7), lateKind = await propose(8, 9);
  const [{ id: late }] = await sql`INSERT INTO ob1_agents (label) VALUES ('upgrade-114-late') RETURNING canonical_agent_id::text AS id`;
  const LATE = { name: "upgrade-114-late", via: "consolidate", agent_id: late };
  decisions.push(await review(keyless, "accept", { name: "consolidate", via: "consolidate" }), await review(lateKind, "accept", LATE));
  await sql`SELECT set_agent_kind('upgrade-114-late', 'agent')`;
  await sql`SELECT backfill_thought_audit_events(NULL)`;
  const auditKinds = await sql`SELECT actor_name, actor_kind, backfilled_at IS NOT NULL AS late FROM thought_audit WHERE actor_name IN ('consolidate', 'upgrade-114-late') AND diff ? 'supersedes' ORDER BY actor_name`;
  assert(JSON.stringify(auditKinds) === JSON.stringify([{ actor_name: "consolidate", actor_kind: "operator", late: false }, { actor_name: "upgrade-114-late", actor_kind: "agent", late: true }]),
    `before 114 the audit holds a kind for both: the keyless accept's from the name, the late key's filled in (${JSON.stringify(auditKinds)})`);
  assert(decisions.every((d) => d.ok) && decisions[2].cleared === true && decisions[3].cleared === false && decisions[5].cleared === true && decisions[6].cleared === false,
    `the decisions before 114: an accept, a clearing reject, a reject clearing nothing, and a clear then a reject clearing nothing (${JSON.stringify(decisions)})`);
  const rows = async () => JSON.stringify(await sql`SELECT id, content, metadata, supersedes, updated_at::text AS u FROM thoughts ORDER BY id`);
  const decided = async () => JSON.stringify(await sql`SELECT id, status, reviewed_at::text AS r, review_note, superseding_id, pointer_written FROM supersession_proposals ORDER BY id`);
  const audits = async () => Number((await sql`SELECT count(*)::int AS c FROM thought_audit`)[0].c);
  const before = { rows: await rows(), decided: await decided(), audits: await audits() };

  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the114 });
  const who = async (id: string) => JSON.stringify((await sql`SELECT reviewed_by AS by, reviewed_by_agent_id::text AS agent, reviewed_by_kind AS kind FROM supersession_proposals WHERE id = ${id}::uuid`)[0]);
  const named = JSON.stringify({ by: OPERATOR.name, agent, kind: "operator" }), none = JSON.stringify({ by: null, agent: null, kind: null });
  const namedAgent = JSON.stringify({ by: AGENT.name, agent: agent2, kind: "agent" });
  assert((await who(keyless)) === JSON.stringify({ by: "consolidate", agent: null, kind: null }) && (await who(lateKind)) === JSON.stringify({ by: LATE.name, agent: late, kind: null }),
    `the backfill takes no kind from a name alone, nor one the audit filled in after the decision (${await who(keyless)}, ${await who(lateKind)})`);
  assert((await who(accepted)) === named && (await who(cleared)) === namedAgent && (await who(plain)) === none && (await who(reRejected)) === none,
    `the backfill names the reviewer the audit holds — the accept's write, and the clearing reject's by the other key, not the accept before it — and none for a reject that cleared nothing, after a clear or not (${await who(accepted)}, ${await who(cleared)}, ${await who(plain)}, ${await who(reRejected)})`);
  assert((await rows()) === before.rows && (await decided()) === before.decided && (await audits()) === before.audits,
    "nothing else moved: every thought, every decision and the audit's rows as they were");
  // After it, a reject that clears nothing records its key — the case SMD-2608 found recording nothing.
  const later = await propose(1, 4);
  await review(later, "reject");
  assert((await who(later)) === named, `after 114 a reject that clears nothing records the key that decided it (${await who(later)})`);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f === the114 });
  assert((await who(later)) === named && (await who(plain)) === none, "a re-apply a no-op: the stamped row kept, none guessed");
  await sql.close();
}

console.log("\n[21] test-support's schema reset leaves nothing of the fork's in public — every table, function and type a migration creates is on its drop lists (SMD-1749)");
{
  // The reset drops a hand-kept list, and a name a migration added without a
  // line there survives every section boundary: 034's table did until [20]
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
  // come back empty. The brain is the full one [20] leaves.
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
  // or identity column records only an 'a' or 'i' dependency on that column —
  // so a relation is an extension's when it, its row type, or the table that
  // owns it is (fourth and fifth review passes; pgvector and pg_trgm ship
  // neither today, so this is for the next extension the test image gains).
  const notExtRel = `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.deptype = 'e' AND (
      (d.classid = 'pg_class'::regclass AND d.objid = c.oid)
      OR (d.classid = 'pg_type'::regclass AND d.objid = c.reltype)
      OR (d.classid = 'pg_class'::regclass AND d.objid = (SELECT a.refobjid FROM pg_depend a WHERE a.classid = 'pg_class'::regclass AND a.objid = c.oid AND a.deptype IN ('a','i') LIMIT 1))))`;
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
  // A survivor is the fork's when some migration names it — then a line is
  // missing from test-support's lists and this section fails. One no migration
  // names is another suite's: a run against a kept database meets whatever
  // the last suite left there (CI's data-layer job gives this suite a fresh
  // database of its own, SMD-2219). Those are reported in the label and do
  // not fail the section, which is about the drop lists, not about the
  // neighbours (fifth review pass).
  const texts = await Promise.all(MIGRATIONS.map((f) => Bun.file(join(HERE, "migrations", f)).text()));
  const named = (name: string) => texts.some((t) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
  const split = (all: string[], base: (x: string) => string) => {
    const ours = all.filter((x) => named(base(x))), foreign = all.filter((x) => !named(base(x)));
    return { ours, note: foreign.length ? `; present but named by no migration, so another suite's: ${foreign.join(", ")}` : "" };
  };
  const left = await sweep();
  const rels = split(left.rels, (x) => x), fns = split(left.fns, (x) => x.slice(0, x.indexOf("("))), types = split(left.types, (x) => x);
  assert(rels.ours.length === 0, `no relation of the fork's survives the reset (${rels.ours.join(", ") || "none"}${rels.note})`);
  assert(fns.ours.length === 0, `no function of the fork's survives the reset (${fns.ours.join(", ") || "none"}${fns.note})`);
  assert(types.ours.length === 0, `no type of the fork's survives the reset (${types.ours.join(", ") || "none"}${types.note})`);
  await sql.close();
  await applyMigrations(URL_, OPTS);
}

console.log("\n[22] --baseline and --force are retired: each is refused by name, on an empty database and over a schema with no ledger alike, changing nothing; a plain run and its dry run are refused over that schema too (SMD-3425), and --reapply brings it under the ledger, refusing first from a shell unlike the brain (SMD-3325)");
{
  await dropSchema(URL_);
  // One probe for the section: the ledger's names, or null with no ledger table (test-support's ledgerNames).
  const probe = new SQL({ url: URL_, max: 1 });
  const ledger = () => ledgerNames(probe);
  const retiredBaseline = /--baseline was retired \(SMD-3325\): it recorded every migration as applied without running one/;
  const retiredForce = /--force was retired with --baseline \(SMD-3325\)/;
  // An empty database: before SMD-3325 --baseline refused here and --force
  // recorded the ledger over nothing anyway (SMD-2237). Now each is refused by
  // name before the run reads anything, so no ledger is created.
  const empty = await migrate("--baseline");
  assert(empty.code === 2 && retiredBaseline.test(empty.out) && /On an empty database run the migrations plainly; to bring a schema with no ledger under the migrator, re-apply them with --reapply/.test(empty.out) && /Nothing was changed\./.test(empty.out) && !retiredForce.test(empty.out),
         `--baseline on an empty database is refused as retired, naming the plain run there and --reapply over a schema (exit ${empty.code})`);
  assert((await ledger()) === null, "…and creates no schema_migrations table");
  const forceAlone = await migrate("--force");
  assert(forceAlone.code === 2 && retiredForce.test(forceAlone.out) && !retiredBaseline.test(forceAlone.out) && (await ledger()) === null,
         `--force alone is refused as retired, not run as a plain run (exit ${forceAlone.code})`);
  const both = await migrate("--baseline", "--force");
  assert(both.code === 2 && retiredBaseline.test(both.out) && retiredForce.test(both.out) && (await ledger()) === null,
         `--baseline --force, which recorded every migration over an empty database, is refused naming both (exit ${both.code})`);

  // The schema --baseline was for: applied without the migrator, no ledger.
  // Still refused, still nothing written, whatever it is beside.
  await applyMigrations(URL_, OPTS);
  // ([7] refuses it beside --reapply.)
  const beside = [["--baseline", "--dry-run"], ["--baseline", "--grant", "tu_nobody"]] as const;
  for (const flags of beside) {
    const r = await migrate(...flags);
    assert(r.code === 2 && retiredBaseline.test(r.out) && (await ledger()) === null,
           `${flags.join(" ")} over a schema with no ledger is refused as retired, no ledger written (exit ${r.code})`);
  }
  // A plain run over that schema is refused too, its dry run with it (SMD-3425):
  // it would give each file its own transaction and check nothing first.
  // Nothing written, --reapply named; and over an empty ledger beside it, as a
  // --dry-run on an empty database leaves one (SMD-2291).
  for (const flags of [[], ["--dry-run"]] as const) {
    const r = await migrate(...flags);
    assert(r.code === 2 && /refused: public\.thoughts is here and the migration ledger records no migration \(no schema_migrations table\)/.test(r.out)
      && /cd db && bun migrate\.ts --url … --reapply/.test(r.out) && /Nothing was changed\./.test(r.out) && (await ledger()) === null,
      `${flags.length ? "--dry-run" : "a plain run"} over a schema with no ledger is refused naming --reapply, no ledger written (exit ${r.code})${r.code === 2 ? "" : `:\n${r.out}`}`);
  }
  await probe.unsafe("CREATE TABLE public.schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const overEmpty = await migrate();
  assert(overEmpty.code === 2 && /refused: public\.thoughts is here and the migration ledger records no migration \(schema_migrations holds none\)/.test(overEmpty.out) && (await ledger())?.length === 0,
    `a plain run over the schema beside an empty ledger is refused the same way, nothing recorded (exit ${overEmpty.code})`);
  await probe.unsafe("DROP TABLE public.schema_migrations");
  // The remedy the refusal and preflight name, over that schema with a thought
  // in it: --reapply. From a shell whose model is not the one ob1_config
  // records it refuses first and writes nothing — not even the ledger table,
  // which a live --reapply makes inside its transaction: an empty one left
  // behind reads to preflight as a ledger recording none (review pass 3). 006
  // would re-record the model, which a plain run does unasked (review pass 2).
  // Another tool's schema_migrations (Rails': a version, no sha256) on the
  // path is not this ledger: the run still makes public's inside its
  // transaction, so the refusal leaves none there either (review pass 4).
  await probe`INSERT INTO thoughts (content, metadata) VALUES ('written with no ledger', '{}'::jsonb)`;
  await probe.unsafe("DROP SCHEMA IF EXISTS tu_rails_22 CASCADE; CREATE SCHEMA tu_rails_22; CREATE TABLE tu_rails_22.schema_migrations (version text PRIMARY KEY)");
  let otherShell: { code: number; out: string };
  try {
    otherShell = await runMigrator(`${URL_}${URL_.includes("?") ? "&" : "?"}options=-csearch_path%3Dtu_rails_22%2Cpublic`, { ...MIGRATOR_ENV, OB1_EMBEDDING_MODEL: "other-embed" }, "--reapply");
  } finally {
    await probe.unsafe("DROP SCHEMA IF EXISTS tu_rails_22 CASCADE");
  }
  assert(otherShell.code === 2 && /this shell would re-record it as other-embed/.test(otherShell.out) && /Nothing was written\./.test(otherShell.out) && (await ledger()) === null,
         `--reapply over a schema with no ledger from a shell of another model, another tool's schema_migrations on the path, refuses up front, and no ledger table is left in public (exit ${otherShell.code})`);
  // From the brain's shell, with public off the connection's path (the brain
  // preflight reads off-path is told the same): every file again, in one
  // transaction, each recorded — in public, which the migrator puts first.
  const offPath = await runMigrator(`${URL_}${URL_.includes("?") ? "&" : "?"}options=-csearch_path%3Dnowhere`, MIGRATOR_ENV, "--reapply");
  const recorded = await ledger();
  assert(offPath.code === 0 && new RegExp(`applied ${MIGRATIONS.length}, skipped 0`).test(offPath.out) && /search_path: public put first for this run only \(it was nowhere\)/.test(offPath.out) && recorded?.length === MIGRATIONS.length,
         `--reapply over a schema with no ledger, public off the path, runs every file again in one transaction and records each in public (exit ${offPath.code}, ${recorded?.length ?? "no"} rows)${offPath.code === 0 ? "" : `:\n${offPath.out}`}`);
  assert(Number(((await probe`SELECT count(*)::int AS c FROM thoughts WHERE content = 'written with no ledger'`) as { c: number }[])[0].c) === 1, "…and the thought written before it is there once");
  const again = await migrate();
  assert(again.code === 0 && new RegExp(`applied 0, skipped ${MIGRATIONS.length}`).test(again.out), `…and the next plain run finds every file recorded (exit ${again.code})`);
  // The schema the guide built, older: the files through 007 applied bare, a
  // thought in it, no ledger. The same --reapply runs every file in order over
  // it, the first seven again, and the thought comes through (review pass 1:
  // only the whole-schema case was driven).
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "008" });
  await probe`INSERT INTO thoughts (content, metadata) VALUES ('written before any ledger', '{}'::jsonb)`;
  const plainOlder = await migrate();
  assert(plainOlder.code === 2 && /refused: public\.thoughts is here/.test(plainOlder.out) && (await ledger()) === null,
    `a plain run over the schema through 007 with no ledger is refused, nothing written (exit ${plainOlder.code})`);
  const fromOlder = await migrate("--reapply");
  assert(fromOlder.code === 0 && new RegExp(`applied ${MIGRATIONS.length}, skipped 0`).test(fromOlder.out) && (await ledger())?.length === MIGRATIONS.length,
         `--reapply over the schema through 007 with no ledger applies every file and records each (exit ${fromOlder.code})${fromOlder.code === 0 ? "" : `:\n${fromOlder.out}`}`);
  const [{ c }] = (await probe`SELECT count(*)::int AS c FROM thoughts WHERE content = 'written before any ledger'`) as { c: number }[];
  assert(c === 1, `…and the thought written before it is there once (${c})`);
  await probe.close();

  // Leave the database clean and migrated, as the blocks before this one do.
  await dropSchema(URL_);
  await applyMigrations(URL_, OPTS);
}

console.log("\n[23] The migrator builds in public whatever the session's search_path puts first, and refuses, changing nothing, where the path reaches another brain or public cannot come first (SMD-2247)");
{
  // Every migration and the ledger are unqualified: they land in the path's
  // first schema and find the first table of a name. The migrator puts
  // public first on its own session, the rest of the path after it.
  const sep = URL_.includes("?") ? "&" : "?";
  const withPath = (path: string) => `${URL_}${sep}options=-csearch_path%3D${encodeURIComponent(path)}`;
  const admin = new SQL({ url: URL_, max: 1 });
  /** The schemas holding a relation of this name, in order. */
  const schemasOf = async (rel: string) =>
    ((await admin`SELECT n.nspname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = ${rel} ORDER BY 1`) as { s: string }[]).map((r) => r.s).join(", ");
  const current = new RegExp(`applied 0, skipped ${MIGRATIONS.length}`);
  try {
    // A path naming no schema: the ledger's CREATE failed with 3F000.
    await dropSchema(URL_);
    const nowhere = await runMigrator(withPath("nowhere"), MIGRATOR_ENV);
    assert(nowhere.code === 0 && /search_path: public put first for this run only \(it was nowhere\); the server's connection keeps its own path/.test(nowhere.out) && new RegExp(`applied ${MIGRATIONS.length}, skipped 0`).test(nowhere.out),
           `a path naming no schema: public is put first for the run, the run says so and that the server keeps its own path, and every migration applies (exit ${nowhere.code})`);
    assert((await schemasOf("schema_migrations")) === "public" && (await schemasOf("thoughts")) === "public",
           "…with the ledger and thoughts in public");
    const plain = await migrate();
    assert(plain.code === 0 && !/search_path: public put first/.test(plain.out),
           `…and a run whose path has public first changes nothing and says nothing of it (exit ${plain.code})`);

    // A schema ahead of public — the default path's "$user" when a schema is
    // named for the role, or a connection string's — holding another tool's
    // thoughts: 001's CREATE TABLE IF NOT EXISTS thoughts found that table and
    // the build failed on it; with the schema empty, the build went there.
    await dropSchema(URL_);
    await admin.unsafe("DROP SCHEMA IF EXISTS tu_ahead CASCADE; CREATE SCHEMA tu_ahead; CREATE TABLE tu_ahead.thoughts (id int)");
    const ahead = await runMigrator(withPath("tu_ahead,public"), MIGRATOR_ENV);
    const [{ embedding, aheadRels }] = (await admin`
      SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('public.thoughts') AND attname = 'embedding') AS embedding,
             (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'tu_ahead') AS "aheadRels"`) as { embedding: boolean; aheadRels: number }[];
    assert(ahead.code === 0 && /public put first for this run only \(it was tu_ahead,public\)/.test(ahead.out) && embedding && aheadRels === 1,
           `another schema's thoughts first on the path: the brain is built in public, and that schema keeps its one table (exit ${ahead.code}, ${aheadRels} relation(s) in tu_ahead)`);
    // --grant's statements are unqualified too: under that path they named
    // tu_ahead's thoughts, and the check after them failed the grant.
    await admin.unsafe("DROP ROLE IF EXISTS tu_granted; CREATE ROLE tu_granted");
    let granted: { code: number; out: string };
    let held = false;
    try {
      granted = await runMigrator(withPath("tu_ahead,public"), MIGRATOR_ENV, "--grant", "tu_granted");
      held = ((await admin`SELECT has_table_privilege('tu_granted', 'public.thoughts', 'SELECT') AS held`) as { held: boolean }[])[0].held;
    } finally {
      await admin.unsafe("DROP OWNED BY tu_granted; DROP ROLE IF EXISTS tu_granted");
    }
    assert(granted.code === 0 && held,
           `…and --grant under that path grants on public's objects (exit ${granted.code}: ${granted.out.split("\n").find((l) => /failed|not granted/.test(l))?.trim() ?? "granted"})`);

    // An extension in a schema of its own, reached through the path alone —
    // Supabase's `extensions`: the path after public is kept, so 011 finds
    // pg_trgm's functions and operator class there.
    await dropSchema(URL_);
    await admin.unsafe("DROP SCHEMA IF EXISTS tu_ahead CASCADE; DROP EXTENSION IF EXISTS pg_trgm CASCADE; DROP SCHEMA IF EXISTS tu_ext CASCADE; CREATE SCHEMA tu_ext; CREATE EXTENSION pg_trgm SCHEMA tu_ext");
    let extRun: { code: number; out: string };
    try {
      extRun = await runMigrator(withPath("tu_ext"), MIGRATOR_ENV);
    } finally {
      await admin.unsafe("DROP EXTENSION IF EXISTS pg_trgm CASCADE; DROP SCHEMA IF EXISTS tu_ext CASCADE; CREATE EXTENSION IF NOT EXISTS pg_trgm");
    }
    assert(extRun.code === 0 && /public put first for this run only \(it was tu_ext\)/.test(extRun.out) && new RegExp(`applied ${MIGRATIONS.length}, skipped 0`).test(extRun.out),
           `an extension's schema first on the path: public goes ahead of it and it stays on, so every migration applies (exit ${extRun.code}: ${extRun.out.split("\n").find((l) => /FAILED/.test(l))?.trim() ?? "no failure"})`);

    // A brain in another schema, public empty — as the old migrator left one
    // under a path that put another schema first; here, the brain built in
    // public and the schema renamed. Building on would start a second brain.
    // Built as a first run often goes: a --dry-run, whose empty ledger in
    // public is no brain in another schema, then the plain run.
    await dropSchema(URL_);
    const dryFirst = await migrate("--dry-run");
    const built = await migrate();
    assert(dryFirst.code === 0 && built.code === 0 && new RegExp(`applied ${MIGRATIONS.length}, skipped 0`).test(built.out),
           `a --dry-run then a plain run on a fresh database builds the brain in public (exit ${dryFirst.code}, ${built.code})`);
    // With the brain in public, another schema's ledger of this shape on the
    // path is not a brain to refuse over: the run goes on in public.
    await admin.unsafe("DROP SCHEMA IF EXISTS tu_copy CASCADE; CREATE SCHEMA tu_copy; CREATE TABLE tu_copy.schema_migrations (name text PRIMARY KEY, sha256 text)");
    const alongside = await runMigrator(withPath("tu_copy,public"), MIGRATOR_ENV);
    await admin.unsafe("DROP SCHEMA tu_copy CASCADE");
    assert(alongside.code === 0 && current.test(alongside.out),
           `…while with the brain in public, another schema's ledger of this shape on the path refuses nothing (exit ${alongside.code})`);
    await admin.unsafe("DROP SCHEMA IF EXISTS tu_brain CASCADE; DROP SCHEMA IF EXISTS tu_rails CASCADE; ALTER SCHEMA public RENAME TO tu_brain; CREATE SCHEMA public");
    try {
      const second = await runMigrator(withPath("tu_brain,public"), MIGRATOR_ENV);
      assert(second.code === 2 && /Refused: this connection's search_path reaches a brain in schema "tu_brain" — this migrator's ledger — and public holds no brain of its own \(a ledger beside thoughts\)/.test(second.out)
               && /take "tu_brain" off this connection's search_path/.test(second.out) && /a move by hand, as the owner of both schemas, minding whatever else public holds\. Nothing was changed\./.test(second.out)
               && !/ALTER SCHEMA/.test(second.out) && (await schemasOf("schema_migrations")) === "tu_brain",
             `a brain in another schema on the path, none in public: refused in words — take it off the path, or move it by hand — no statement printed, and nothing created in public (exit ${second.code})`);
      // A thoughts in public with no ledger of this migrator's is no brain
      // there: refused alike.
      await admin.unsafe("CREATE TABLE public.thoughts (id int)");
      const halfPublic = await runMigrator(withPath("tu_brain,public"), MIGRATOR_ENV);
      await admin.unsafe("DROP TABLE public.thoughts");
      assert(halfPublic.code === 2 && /reaches a brain in schema "tu_brain"/.test(halfPublic.out),
             `…and refused alike where public holds a thoughts but no ledger of this migrator's (exit ${halfPublic.code})`);
      // Behind another tool's ledger earlier on the path (Rails': a version
      // column, no sha256), and behind an empty public first: every schema
      // on the path is read, not the first ledger a name resolves to.
      await admin.unsafe("CREATE SCHEMA tu_rails; CREATE TABLE tu_rails.schema_migrations (version varchar PRIMARY KEY)");
      const hidden = await runMigrator(withPath("tu_rails,tu_brain,public"), MIGRATOR_ENV);
      const behind = await runMigrator(withPath("public,tu_brain"), MIGRATOR_ENV);
      assert(hidden.code === 2 && behind.code === 2 && [hidden, behind].every((r) => /reaches a brain in schema "tu_brain"/.test(r.out))
               && (await schemasOf("schema_migrations")) === "tu_brain, tu_rails",
             `…behind another tool's ledger first on the path, and behind an empty public first, refused alike (exit ${hidden.code}, ${behind.code})`);
      // An empty ledger in public — what --dry-run leaves (SMD-2291), here
      // under a path that does not reach the brain — is no brain there: the
      // next run over the brain's path still refuses.
      const dry = await migrate("--dry-run");
      const emptyLedger = await runMigrator(withPath("tu_brain,public"), MIGRATOR_ENV);
      assert(dry.code === 0 && (await schemasOf("schema_migrations")) === "public, tu_brain, tu_rails" && emptyLedger.code === 2 && /reaches a brain in schema "tu_brain"/.test(emptyLedger.out),
             `…and still refused over the empty ledger a --dry-run left in public (exit ${dry.code}, ${emptyLedger.code})`);
      // --grant grants on public's objects: refused alike, in its own words.
      await admin.unsafe("DROP ROLE IF EXISTS tu_granted; CREATE ROLE tu_granted");
      let grantRefused: { code: number; out: string };
      try {
        grantRefused = await runMigrator(withPath("tu_brain,public"), MIGRATOR_ENV, "--grant", "tu_granted");
      } finally {
        await admin.unsafe("DROP OWNED BY tu_granted; DROP ROLE IF EXISTS tu_granted");
      }
      assert(grantRefused.code === 2 && /--grant grants on the brain's objects in public, and there are none there/.test(grantRefused.out) && !/second brain/.test(grantRefused.out),
             `…and --grant is refused there, in its own words (exit ${grantRefused.code})`);
      // The brain in the role's own schema, reached through the default
      // path's "$user": the refusal says so, since the path does not spell it.
      const [{ me }] = (await admin`SELECT current_user AS me`) as { me: string }[];
      await admin.unsafe(`ALTER SCHEMA tu_brain RENAME TO ${quoteIdent(me)}`);
      let viaUser: { code: number; out: string };
      try {
        viaUser = await migrate();
      } finally {
        await admin.unsafe(`ALTER SCHEMA ${quoteIdent(me)} RENAME TO tu_brain`);
      }
      assert(viaUser.code === 2 && viaUser.out.includes(`reaches a brain in schema ${quoteIdent(me)} (the path's "$user")`),
             `…and a brain in the role's own schema, under the default path, is named as the path's "$user" (exit ${viaUser.code})`);
    } finally {
      // The brain back as public, the empty one gone.
      await admin.unsafe(`DO $r$ BEGIN
        IF to_regnamespace('tu_brain') IS NOT NULL THEN EXECUTE 'DROP SCHEMA public CASCADE'; EXECUTE 'ALTER SCHEMA tu_brain RENAME TO public'; END IF;
        EXECUTE 'DROP SCHEMA IF EXISTS tu_rails CASCADE';
      END $r$`);
    }

    // Another tool's ledger beside an app's thoughts is not a brain — Rails'
    // version, and a name beside it but no sha256: the build goes to public
    // beside them.
    await dropSchema(URL_);
    await admin.unsafe("CREATE SCHEMA tu_rails; CREATE TABLE tu_rails.schema_migrations (version varchar PRIMARY KEY, name text); CREATE TABLE tu_rails.thoughts (id int)");
    const tool = await runMigrator(withPath("tu_rails,public"), MIGRATOR_ENV);
    assert(tool.code === 0 && (await schemasOf("schema_migrations")) === "public, tu_rails" && (await schemasOf("thoughts")) === "public, tu_rails",
           `another tool's ledger — a name column, no sha256 — beside an app's thoughts is no brain: it is left alone, and the brain is built in public (exit ${tool.code})`);

    // No schema public: nothing can put it first.
    await dropSchema(URL_);
    await admin.unsafe("DROP SCHEMA IF EXISTS tu_rails CASCADE; DROP ROLE IF EXISTS tu_granted; CREATE ROLE tu_granted; ALTER SCHEMA public RENAME TO tu_public_away");
    let noPublic: { code: number; out: string };
    let noPublicGrant: { code: number; out: string };
    try {
      noPublic = await migrate();
      noPublicGrant = await migrate("--grant", "tu_granted");
    } finally {
      await admin.unsafe("ALTER SCHEMA tu_public_away RENAME TO public; DROP OWNED BY tu_granted; DROP ROLE IF EXISTS tu_granted");
    }
    assert(noPublic.code === 2 && /Refused: this database has no schema named public/.test(noPublic.out) && /CREATE SCHEMA public;  as the database's owner, then run again\. Nothing was changed\./.test(noPublic.out)
             && (await schemasOf("schema_migrations")) === "",
           `no schema public: refused, naming CREATE SCHEMA public, and no ledger created anywhere (exit ${noPublic.code})`);
    assert(noPublicGrant.code === 2 && /no schema named public, where --grant grants on the brain's objects, so there are none to grant on/.test(noPublicGrant.out)
             && /CREATE SCHEMA public;  as the database's owner, apply the migrations, then run --grant\./.test(noPublicGrant.out),
           `…and --grant there is refused in its own words: create public and apply the migrations first (exit ${noPublicGrant.code})`);

    // A role without USAGE on public, which Postgres leaves off its path. The
    // printed GRANT, run as printed, lets it build in public: its first files
    // apply there (the migrations that create extensions still need the
    // database's owner, as the refusal says).
    const asNoUsage = URL_.replace(/\/\/[^@]*@/, "//tu_nousage:nousage@");
    let noUsage: { code: number; out: string };
    let granted2: { code: number; out: string } | undefined;
    let noUsageGrant: { code: number; out: string } | undefined;
    let noUsageLedger = "", grantedLedger = "";
    try {
      await admin.unsafe("DROP ROLE IF EXISTS tu_nousage; CREATE ROLE tu_nousage LOGIN PASSWORD 'nousage'; DROP ROLE IF EXISTS tu_granted; CREATE ROLE tu_granted; REVOKE USAGE ON SCHEMA public FROM PUBLIC");
      noUsage = await runMigrator(asNoUsage, MIGRATOR_ENV);
      noUsageGrant = await runMigrator(asNoUsage, MIGRATOR_ENV, "--grant", "tu_granted");
      noUsageLedger = await schemasOf("schema_migrations");
      const printed = /GRANT USAGE, CREATE ON SCHEMA public TO \S+;/.exec(noUsage.out)?.[0];
      if (printed) {
        await admin.unsafe(printed);
        granted2 = await runMigrator(asNoUsage, MIGRATOR_ENV);
        grantedLedger = await schemasOf("schema_migrations");
      }
    } finally {
      await admin.unsafe("GRANT USAGE ON SCHEMA public TO PUBLIC; DROP OWNED BY tu_nousage; DROP ROLE IF EXISTS tu_nousage; DROP OWNED BY tu_granted; DROP ROLE IF EXISTS tu_granted");
    }
    assert(noUsage.code === 2 && /Refused: role tu_nousage has no USAGE on schema public/.test(noUsage.out) && /Run the migrator as the database's owner, postgres, or a role that is a member of it\./.test(noUsage.out)
             && /GRANT USAGE, CREATE ON SCHEMA public TO tu_nousage;/.test(noUsage.out) && /001's vector needs a superuser unless it is installed, and 011's pg_trgm needs CREATE on the database, which its owner has;\n {2}096's pg_stat_statements needs a superuser too, and is left out without one\./.test(noUsage.out)
             && noUsageLedger === "",
           `a role without USAGE on public: refused, naming the database's owner, the GRANT and what each extension needs, and no ledger created anywhere (exit ${noUsage.code})`);
    assert(!!noUsageGrant && noUsageGrant.code === 2 && /Run --grant as the objects' owner — the role that ran the migrations — or a superuser\./.test(noUsageGrant.out) && !/GRANT USAGE, CREATE/.test(noUsageGrant.out),
           `…and --grant as that role is refused in its own words: run it as the objects' owner (exit ${noUsageGrant?.code})`);
    // Exit 0 and no FAILED line: 096 met pg_stat_statements an earlier superuser run left confined here, and failed this run (SMD-1849 PR 3b review pass 2), which a check of 001 alone passed.
    assert(!!granted2 && granted2.code === 0 && !/Refused|FAILED/.test(granted2.out) && /001_\S+\s+applied/.test(granted2.out) && grantedLedger === "public",
           `…and the GRANT, run as printed, puts public back on the role's path, and it builds there (${granted2 ? granted2.out.split("\n").find((l) => /FAILED|Refused/.test(l))?.trim() ?? "no failure line" : "no GRANT printed"})`);
  } finally {
    await admin.unsafe("DROP SCHEMA IF EXISTS tu_ahead CASCADE; DROP SCHEMA IF EXISTS tu_brain CASCADE; DROP SCHEMA IF EXISTS tu_rails CASCADE");
    await admin.close();
  }
  // Leave the database clean and migrated, as the blocks before this one do.
  await dropSchema(URL_);
  await applyMigrations(URL_, OPTS);
}

report();
