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
 * Postgres, as the same role (SMD-2219). What the cluster shares — a role and
 * its settings, pg_locks, pg_stat_activity — is scoped here to the current
 * database, or named for this suite (ob1_upgrade_*, ob1_notemp). [12] opens
 * a session in `postgres` on purpose, to hold a lock its count must not see.
 *
 *   ./with-postgres.sh bun test-upgrade.ts
 */

import { SQL } from "bun";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_COMMENT_SQL, TABLE_COMMENT_SQL, TID_PROBE, applyMigrations, createAssert, dropSchema, ledgerStrangers, loadChunkRows, migrationFiles, migratorEnv, plantLegacyRow, requireDatabaseUrl, resetSchema, runMigrator, runScript, seededRandom, updatedAtTriggerState } from "./test-support.ts";
import { ACCEPTED_CAVEAT_PREFIX, ACCEPTED_CLAIM_SQL, LOCK_TIMEOUT_S, UPDATE_THOUGHT_SIGNATURE, UPDATE_THOUGHT_SIGNATURE_9, UPDATE_THOUGHT_SIGNATURE_10, reembedKey } from "./config.mjs";

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
  // SMD-2297) and 068 (the node_state projection kept current on write,
  // SMD-2256) stay recorded and
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
  // refuse, so it applies cleanly over an older baseline ([20u]) — all recorded
  // by the baseline with their prerequisites present, so none becomes the
  // plain-run failure point above).
  const last = MIGRATIONS.find((f) => f.startsWith("030_"))!;
  assert(last !== undefined && MIGRATIONS.indexOf(last) >= MIGRATIONS.length - 40, `030 is among the last forty migrations (${last}) — a migration landed past the window: extend the enumeration above and move this guard`);
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
  // Its colour codes stripped: a shell with FORCE_COLOR set (MIGRATOR_ENV
  // keeps it) ends the refusal with a reset after --reapply, where the regex
  // anchors the line's end (SMD-2219).
  const statusRun = await runScript(["bun", join(HERE, "reembed.ts"), "--url", URL_, "--status"], { env: MIGRATOR_ENV, cwd: HERE });
  const status = { ...statusRun, out: statusRun.out.replace(/\x1b\[[0-9;]*m/g, "") };
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
  // typo); a flag the runner does not have; --baseline beside it; a recorded
  // file changed since it was applied — before anything runs.
  const value = await migrate("--reapply", "021");
  assert(value.code === 2 && /unknown argument 4: a value where no flag takes one/.test(value.out), `--reapply takes no value; one beside it is refused, not dropped (exit ${value.code})`);
  const typo = await migrate("--reapply=021");
  assert(typo.code === 2 && /argument 3 gives --reapply a value with "=", and --reapply takes none/.test(typo.out), `a flag the runner does not have is refused, not a silent plain run (exit ${typo.code})`);
  const joined = await migrate("--url=postgres://u:s3cret@h/d");
  assert(joined.code === 2 && /argument 3 joins a value to --url with "="/.test(joined.out) && !/s3cret/.test(joined.out), `a value joined with "=" is refused without echoing it — a URL carries a password (exit ${joined.code})`);
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
  // A brain adopted with --baseline at a ledger through 043 whose schema stops
  // before 034 — a guide-built brain, or one baselined and never re-applied.
  // 043's two COMMENTs would fail bare there (relation "query_log" does not
  // exist), and a plain run — the compose stack's, gating the server — would
  // stop with no remedy named; the file opens with 031's guard instead.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "034" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-034 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the043 = MIGRATIONS.find((f) => f.startsWith("043_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the043}`;
  const plain = await migrate();
  const ok = plain.code === 1 && /043_query_log_tool_comment\.sql\s+FAILED: migration 043 needs 034 \(query_log\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  // own connection, which can read pg_stat_activity inside its transaction.
  let waited = false;
  for (let i = 0; i < 100 && !waited; i++) {
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
  // 047's guard is 043's ([20]) verbatim: on a brain baselined at a ledger through
  // 047 whose schema stops before 034, its CREATE INDEX would fail bare (relation
  // "query_log" does not exist), and a plain run — the compose stack's, gating the
  // server — would stop with no remedy named. [20] drives 043's guard and [20b]
  // 046's; 045 and 047 carry the same guard but had no driver, so a typo in 047's
  // refusal message or a guard that failed to fire went uncaught. This drives it.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "034" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-034 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the047 = MIGRATIONS.find((f) => f.startsWith("047_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the047}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /047_query_log_logged_at_index\.sql\s+FAILED: migration 047 needs 034 \(query_log\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  // guard, this file did not). Same drive: a ledger baselined over a schema that
  // stops before 010, 049 alone made pending.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "010" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-010 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the049 = MIGRATIONS.find((f) => f.startsWith("049_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the049}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /049_agent_key_scope_capture\.sql\s+FAILED: migration 049 needs 010 \(ob1_agent_keys\.scope\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  // 052's guard is 047's shape ([20c]): a brain baselined at a ledger through
  // 052 whose schema stops before 008 would take the function and fail at its
  // first call with a bare "relation thought_audit does not exist"; the file
  // refuses at apply instead, naming 008 — and, on 008's table as a hand-applied
  // 008 leaves it, naming 046. A guard with no driver is prose ([20c]'s
  // lesson), so both are driven.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "008" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-008 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the052 = MIGRATIONS.find((f) => f.startsWith("052_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the052}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /052_thought_changes\.sql\s+FAILED: migration 052 needs 008 \(thought_audit\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  // 053's guard is 052's shape ([20f]): a brain baselined at a ledger through
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
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-016 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the053 = MIGRATIONS.find((f) => f.startsWith("053_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the053}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /053_thought_sources_and_links\.sql\s+FAILED: migration 053 needs 016 \(ob1_entity_edges\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  // fail bare at its COMMENT ON COLUMN. Same drive: a ledger baselined over a
  // schema that stops before 010, 054 alone made pending.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "010" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-010 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the054 = MIGRATIONS.find((f) => f.startsWith("054_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the054}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /054_resolve_agent_stale_touch\.sql\s+FAILED: migration 054 needs 010 \(ob1_agent_keys\.last_used_at, revoked_at, scope\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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

  // The guard, driven ([20g]'s shape): a brain baselined at a ledger through
  // 055 whose schema stops before 046, then before 050.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "046" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-046 schema (exit ${baselined.code})`);
  const sql2 = new SQL({ url: URL_, max: 1 });
  const the055 = MIGRATIONS.find((f) => f.startsWith("055_"))!;
  await sql2`DELETE FROM schema_migrations WHERE name = ${the055}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /055_capture_event_payload\.sql\s+FAILED: migration 055 needs 046 \(thought_audit\.actor_kind, ob1_registry_kind\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-016 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the056 = MIGRATIONS.find((f) => f.startsWith("056_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the056}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /056_entity_name_gate\.sql\s+FAILED: migration 056 needs 016 \(ob1_entity_edges\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-025 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the058 = MIGRATIONS.find((f) => f.startsWith("058_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the058}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /058_node_state\.sql\s+FAILED: migration 058 needs 025 \(thoughts\.supersedes\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-058 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the058 = MIGRATIONS.find((f) => f.startsWith("058_"))!;
  const the059 = MIGRATIONS.find((f) => f.startsWith("059_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the059}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /059_search_prefers_current\.sql\s+FAILED: migration 059 needs 058 \(node_state\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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

  // The guard, driven ([20g]'s shape): a brain baselined at a ledger through
  // 060 whose schema stops before 042, then before 050, then before 055.
  for (const [stop, needs] of [["042", "migration 060 needs 042 \\(delete_thought\\(uuid, jsonb, boolean\\), thoughts_guard_citation_sources\\); this schema lacks it"], ["050", "migration 060 needs 050 \\(ob1_stamp_actor, thought_audit\\.seq\\); this schema lacks it"], ["055", "migration 060 needs 055 \\(ob1_thought_diff, ob1_append_thought_event, ob1_actor_stamp, ob1_actor_stamp_kept\\); this schema lacks it"]] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const baselined = await migrate("--baseline");
    assert(baselined.code === 0, `--baseline records every migration over the pre-${stop} schema (exit ${baselined.code})`);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the060 = MIGRATIONS.find((f) => f.startsWith("060_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the060}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`060_append_then_project\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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

  // The guard, driven ([20g]'s shape): a brain baselined at a ledger through
  // 061 whose schema stops before 013, then 029, then 056, then 060.
  for (const [stop, needs] of [["013", "migration 061 needs 013 \\(thought_chunks\\.context, the 4-argument upsert_thought's context arm\\); this schema lacks it"], ["029", "migration 061 needs 029 \\(supersession_proposals\\); this schema lacks it"], ["056", "migration 061 needs 056 \\(entity_type_gate, record_thought_entities' body\\); this schema lacks it"], ["060", "migration 061 needs 060 \\(ob1_refresh_thought_vector, ob1_embedding_snapshot\\); this schema lacks it"]] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const baselined = await migrate("--baseline");
    assert(baselined.code === 0, `--baseline records every migration over the pre-${stop} schema (exit ${baselined.code})`);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the061 = MIGRATIONS.find((f) => f.startsWith("061_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the061}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`061_derivations\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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

  // The guard, driven ([20g]'s shape): a brain baselined at a ledger through
  // 063 whose schema stops before 016, then 029, then 060, then 061.
  for (const [stop, needs] of [
    ["016", "migration 063 needs 016 \\(requeue_thought_work, the entity tables\\); this schema lacks it"],
    ["029", "migration 063 needs 029 \\(supersession_proposals, consolidation_candidates\\); this schema lacks it"],
    ["060", "migration 063 needs 060 \\(ob1_refresh_thought_vector, ob1_embedding_snapshot\\); this schema lacks it"],
    ["061", "migration 063 needs 061 \\(derivations, ob1_record_derivation, the 11-argument record_supersession_proposal\\); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const baselined = await migrate("--baseline");
    assert(baselined.code === 0, `--baseline records every migration over the pre-${stop} schema (exit ${baselined.code})`);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the063 = MIGRATIONS.find((f) => f.startsWith("063_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the063}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`063_rebuild_derived\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  const stamps = async () => JSON.stringify(await sql`SELECT id, content, content_fingerprint, metadata, embedding::text AS e, embedding_model, derived_from, updated_at::text AS u FROM thoughts ORDER BY id`);
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

  // The guard, driven ([20n]'s shape): a brain baselined at a ledger through
  // 064 whose schema stops before 025, then 032, then 060, then 061, then 063.
  for (const [stop, needs] of [["025", "migration 064 needs 025 \\(thoughts\\.derived_from\\); this schema lacks it"], ["032", "migration 064 needs 032 \\(validate_derived_from, update_thought's provenance envelope\\); this schema lacks it"], ["060", "migration 064 needs 060 \\(ob1_project_thought_event, the write functions that append then project\\); this schema lacks it"], ["061", "migration 064 needs 061 \\(derivations, ob1_record_derivation, ob1_actor_agent_id\\); this schema lacks it"], ["063", "migration 064 needs 063 \\(derivations\\.stale_since, the rebuild's mark ob1_record_derivation clears\\); this schema lacks it"]] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const baselined = await migrate("--baseline");
    assert(baselined.code === 0, `--baseline records every migration over the pre-${stop} schema (exit ${baselined.code})`);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the064 = MIGRATIONS.find((f) => f.startsWith("064_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the064}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`064_pages\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-016 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the065 = MIGRATIONS.find((f) => f.startsWith("065_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the065}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /065_identifier_allowlist\.sql\s+FAILED: migration 065 needs 016 \(ob1_entities\) and 056 \(entity_type_gate, apply_entity_type_gate\); this schema lacks 016/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  // brain has its ledger). The files after 066 first too: --baseline records
  // EVERY file in the tree as applied, so a --reapply over a schema stopped
  // at 066 would apply a later file for real and move the shape — the
  // ledger's claim, not the file's (SMD-2297's 067 was the first such file;
  // caught when it landed beside this leg). Each condition named on failure:
  // a bundled assertion said only "no".
  await applyMigrations(URL_, { ...OPTS, only: (f) => f > "066" });
  const baseline = await migrate("--baseline");
  assert(baseline.code === 0, `--baseline records the ledger over the schema at the tree's head (exit ${baseline.code})`);
  const shapeAfter = await shape(sql), stampsAfter = await stamps(), proposalsAfter = await proposals();
  const re2 = await migrate("--reapply");
  const firstDiff = (a: string, b: string) => { const x = JSON.parse(a) as Record<string, unknown>[], y = JSON.parse(b) as Record<string, unknown>[]; for (let i = 0; i < Math.max(x.length, y.length); i++) for (const k of new Set([...Object.keys(x[i] ?? {}), ...Object.keys(y[i] ?? {})])) if (JSON.stringify(x[i]?.[k]) !== JSON.stringify(y[i]?.[k])) return `row ${i} ${k}: ${JSON.stringify(x[i]?.[k])} -> ${JSON.stringify(y[i]?.[k])}`; return ""; };
  const stampsRe = await stamps();
  const failed = [re2.code !== 0 && `exit ${re2.code}`, JSON.stringify(await shape(sql)) !== JSON.stringify(shapeAfter) && "shape moved", stampsRe !== stampsAfter && `a thought moved (${firstDiff(stampsAfter, stampsRe)})`, (await proposals()) !== proposalsAfter && "a proposal moved", (await excludes()).x !== true && "the rule gone", (await cands()) !== d.id && `candidates ${await cands()}`].filter(Boolean);
  assert(failed.length === 0, `a re-apply is a no-op: the shape as it left it, no thought moved, the rule standing (${failed.join("; ") || "exit 0"})`);
  await sql.close();

  // The guard, driven ([20p]'s shape): a brain baselined at a ledger through
  // 066 whose schema stops before 025, then 029, then 063.
  for (const [stop, needs] of [
    ["025", "migration 066 needs 025 \\(thoughts\\.derived_from\\); this schema lacks it"],
    ["029", "migration 066 needs 029 \\(supersession_proposals, consolidation_candidates\\); this schema lacks it"],
    ["063", "migration 066 needs 063 \\(the stale proposal status this body reads\\); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const baselined = await migrate("--baseline");
    assert(baselined.code === 0, `--baseline records every migration over the pre-${stop} schema (exit ${baselined.code})`);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the066 = MIGRATIONS.find((f) => f.startsWith("066_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the066}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`066_lineage_excludes_candidates\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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

  // The guard, driven ([20g]'s shape): a brain baselined at a ledger through
  // 067 whose schema stops before 036, then 061, then 063.
  for (const [stop, needs] of [
    ["036", "migration 067 needs 036 \\(review_supersession_proposal\\) and 061 \\(ob1_record_derivation\\); this schema lacks them"],
    ["061", "migration 067 needs 036 \\(review_supersession_proposal\\) and 061 \\(ob1_record_derivation\\); this schema lacks them"],
    ["063", "migration 067 needs 063 \\(rebuild_derived, the mark's columns, the stale proposal status\\); this schema lacks it"],
  ] as const) {
    await dropSchema(URL_);
    await applyMigrations(URL_, { ...OPTS, only: (f) => f < stop });
    const baselined = await migrate("--baseline");
    assert(baselined.code === 0, `--baseline records every migration over the pre-${stop} schema (exit ${baselined.code})`);
    const sql2 = new SQL({ url: URL_, max: 1 });
    const the067 = MIGRATIONS.find((f) => f.startsWith("067_"))!;
    await sql2`DELETE FROM schema_migrations WHERE name = ${the067}`;
    const plain = await migrate();
    const ok = plain.code === 1 && new RegExp(`067_pass_settles_stale\\.sql\\s+FAILED: ${needs}`).test(plain.out) &&
      /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-058 schema (exit ${baselined.code})`);
  const sql = new SQL({ url: URL_, max: 1 });
  const the068 = MIGRATIONS.find((f) => f.startsWith("068_"))!;
  await sql`DELETE FROM schema_migrations WHERE name = ${the068}`;
  const plain = await migrate();
  const ok = plain.code === 1 &&
    /068_node_state_projection\.sql\s+FAILED: migration 068 needs 058 \(node_state\); this schema lacks it/.test(plain.out) &&
    /adopted with --baseline\?\)\. Re-apply every migration in one transaction: cd db && bun migrate\.ts --url <url> --reapply/.test(plain.out);
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

console.log("\n[20u] Migration 069 adds the durable jobs table and prune_jobs with nothing to refuse — applied cleanly over a pre-069 baseline, and the objects work (SMD-2318)");
{
  // 069 references no earlier migration (no FK, no function it redefines), so
  // unlike the guarded migrations above there is nothing to refuse: a plain run
  // over an older baseline just applies it. The point here is that it applies
  // cleanly through the upgrade harness and its table and function work.
  await dropSchema(URL_);
  await applyMigrations(URL_, { ...OPTS, only: (f) => f < "069" });
  const baselined = await migrate("--baseline");
  assert(baselined.code === 0, `--baseline records every migration over the pre-069 schema (exit ${baselined.code})`);
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

console.log("\n[22] --baseline on an empty database refuses, naming public.thoughts, the plain run and --force; --force records the ledger over it (SMD-2237)");
{
  await dropSchema(URL_);
  // A fresh database with no fork schema. --baseline would record every migration
  // as applied without running one, leaving a ledger the next plain run reads as
  // done — so it refuses (exit 2), naming what is missing, the plain run and the
  // override, and before the ledger table is even created: nothing is written.
  const refused = await migrate("--baseline");
  assert(refused.code === 2 &&
         /--baseline refused: public\.thoughts does not exist/.test(refused.out) &&
         /Apply the migrations instead: cd db && bun migrate\.ts/.test(refused.out) &&
         /pass --force/.test(refused.out),
         `--baseline on an empty database refuses, naming public.thoughts, the plain run and --force (exit ${refused.code})`);

  const sql = new SQL({ url: URL_, max: 1 });
  const [{ present: ledger }] = (await sql`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`) as { present: boolean }[];
  await sql.close();
  assert(ledger === false, "…and creates no schema_migrations table — the refusal is before any write");

  // Another tool's thoughts, in a schema of its own, is not public.thoughts: the
  // guard reads public alone (pg_class, nspname='public'), so --baseline still
  // refuses over an empty public. A probe that dropped the schema qualifier would
  // read the stray table as "present" and let --baseline record the ledger over an
  // empty public — the exact bricking SMD-2237 prevents. Plant it, prove the
  // refusal, drop it.
  const stray = new SQL({ url: URL_, max: 1 });
  let strayRefused: { code: number; out: string };
  try {
    await stray.unsafe("DROP SCHEMA IF EXISTS tu_stray CASCADE; CREATE SCHEMA tu_stray; CREATE TABLE tu_stray.thoughts (id int)");
    strayRefused = await migrate("--baseline");
  } finally {
    await stray.unsafe("DROP SCHEMA IF EXISTS tu_stray CASCADE");
    await stray.close();
  }
  assert(strayRefused.code === 2 && /--baseline refused: public\.thoughts does not exist/.test(strayRefused.out),
         `--baseline reads public alone: another schema's thoughts over an empty public still refuses (exit ${strayRefused.code})`);

  // --force is the operator's override: it records every migration over the empty
  // schema, exactly as --baseline does over a hand-built one.
  const forced = await migrate("--baseline", "--force");
  assert(forced.code === 0 && new RegExp(`baselined ${MIGRATIONS.length}, skipped 0`).test(forced.out),
         `--baseline --force records every migration over an empty database (exit ${forced.code})`);

  // --force without --baseline is refused, not a silent plain run — it exits at
  // the flag-combo check, before any database connection, whatever the DB holds.
  const forceAlone = await migrate("--force");
  assert(forceAlone.code === 2 && /--force overrides --baseline's empty-database guard/.test(forceAlone.out),
         `--force without --baseline is refused (exit ${forceAlone.code})`);

  // Protective direction of the public-qualified guard: a hand-built public
  // schema present but OFF the migrator role's search_path must still be found
  // (pg_class, not to_regclass), so --baseline adopts it rather than refusing.
  // Build a minimal public.thoughts and a separate schema, then run --baseline
  // with search_path set to that other schema: the guard finds public.thoughts
  // and records the ledger (into the off-path schema). A to_regclass spelling —
  // the "obvious" refactor — would miss public.thoughts here and wrongly refuse,
  // reintroducing the search_path-hiding the pg_class probe exists to avoid
  // (SMD-2237, and SMD-2062's restricted-role deployments).
  const offPathSql = new SQL({ url: URL_, max: 1 });
  let offPathBaseline: { code: number; out: string };
  try {
    await offPathSql.unsafe("CREATE TABLE IF NOT EXISTS public.thoughts (id int); DROP SCHEMA IF EXISTS tu_offpath CASCADE; CREATE SCHEMA tu_offpath");
    const sep = URL_.includes("?") ? "&" : "?";
    offPathBaseline = await runMigrator(`${URL_}${sep}options=-csearch_path%3Dtu_offpath`, MIGRATOR_ENV, "--baseline");
  } finally {
    await offPathSql.unsafe("DROP SCHEMA IF EXISTS tu_offpath CASCADE; DROP TABLE IF EXISTS public.thoughts");
    await offPathSql.close();
  }
  assert(offPathBaseline.code === 0 && new RegExp(`baselined ${MIGRATIONS.length}, skipped 0`).test(offPathBaseline.out),
         `--baseline finds public.thoughts by pg_class even with public off the role's search_path — adoption holds off-path (exit ${offPathBaseline.code})`);

  // Leave the database clean and migrated, as the blocks before this one do.
  await dropSchema(URL_);
  await applyMigrations(URL_, OPTS);
}

report();
