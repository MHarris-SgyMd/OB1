#!/usr/bin/env bun
/**
 * migrate.ts — apply db/migrations/*.sql in order, once each.
 *
 * Works against any Postgres 15+ with pgvector 0.8.0 or later — migration 014
 * declares HNSW settings that older pgvector rejects. Uses Bun's built-in SQL
 * client, so there is no driver dependency.
 *
 *   bun db/migrate.ts --url postgres://user:pass@host:5432/dbname
 *   DATABASE_URL=... bun db/migrate.ts
 *   bun db/migrate.ts --dry-run        # show what would run, touch nothing
 *   bun db/migrate.ts --reapply        # re-run every recorded migration, in one transaction
 *
 * Applied migrations are recorded in schema_migrations, so re-running is a no-op.
 * Every migration is also individually idempotent, so a database created by hand
 * from docs/01-getting-started.md can be adopted: mark the ones already applied
 * with --baseline, or just run them — they will not duplicate anything.
 *
 * --reapply re-runs EVERY migration — recorded or pending — in order, in ONE
 * transaction with a 10 s lock timeout; recorded rows stay as they are, pending
 * ones are recorded in the same transaction. It is the remedy for a database
 * adopted with --baseline whose schema is older than its ledger says —
 * reembed.ts and preflight name the command where they find that. Every file,
 * not a range from the one a symptom names: a later migration may redefine what
 * an earlier one created (022 and 025 redefine 021's upsert_thought; 020 drops a
 * form 014 recreates), and a file's body may reference what only an earlier
 * file installs (025's upsert_thought reads a column 021 adds, resolved when the
 * function first RUNS, not when it is created) — so a start point is safe only
 * when everything before it is really present, which nothing can check cheaply;
 * and pending files in the same ordered transaction, because a ledger hole (a
 * row deleted or misspelt by hand) would otherwise have an earlier-numbered file
 * apply AFTER the re-run and put its definitions over the later ones the re-run
 * had just restored. Every file is idempotent, so the run restores the latest
 * definition of everything. One transaction, so a failure part-way leaves the
 * schema as it was rather than with some objects at an older definition than
 * before. What a re-run repeats from the CURRENT shell, and refuses to change
 * silently: 006 and 013 re-record ob1_config (refused when the record differs
 * from the shell), 011 builds the trigram index when OB1_TRGM_INDEX is on and
 * it is absent, 023 runs its backfill call under OB1_BACKFILL_LIMIT (SMD-1193).
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  CLAIM_EVIDENCE_ROWS_SQL,
  REQUEUE_SET_SQL,
  UPDATE_THOUGHT_SIGNATURE,
  alignVectorSearchPath,
  DB_LEVEL_SETTINGS_SQL,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  HNSW_SEEDS,
  SHARED_SETTING_SOURCES,
  TRGM_INDEX,
  migrationValues,
  parseSetConfig,
  quoteIdent,
  substituteMigration,
  validateEmbeddingConfig,
  versionAtLeast,
} from "./config.mjs";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

// Every argument accounted for: a flag the runner does not have, a value where
// no flag takes one, a flag that takes a value followed by none, or a flag
// given twice (flag() reads the first; `--url A --url B` would run against A),
// is refused rather than dropped — `--reapply=021`, or a misspelt flag, would
// otherwise be a silent plain run that exits 0. reembed.ts scans its arguments
// the same way, with more shapes; the two are not yet one function.
{
  const TAKES_ONE = new Set(["url"]);
  const TAKES_NONE = new Set(["dry-run", "baseline", "reapply"]);
  const USAGE = "  flags: --url <postgres://…>, --dry-run, --baseline, --reapply";
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith("--") ? a.slice(2) : null;
    if (name !== null && (TAKES_ONE.has(name) || TAKES_NONE.has(name))) {
      if (seen.has(name)) {
        console.error(`--${name} given twice.\n${USAGE}`);
        process.exit(2);
      }
      seen.add(name);
    }
    if (name !== null && TAKES_ONE.has(name)) {
      if (i + 1 >= args.length || args[i + 1].startsWith("--")) {
        console.error(`--${name} takes a value.\n${USAGE}`);
        process.exit(2);
      }
      i++;
      continue;
    }
    if (name !== null && TAKES_NONE.has(name)) continue;
    // Echo the shape, not the value: `--url=postgres://user:PASSWORD@host/db`
    // or a bare URL would otherwise put a password in the log.
    const shown = name !== null ? (name.includes("=") ? `--${name.split("=")[0]}=… (a value joined with "="; give it as --${name.split("=")[0]} <value>)` : a) : /:\/\//.test(a) ? "<a URL>" : a;
    console.error(`unknown argument: ${shown}${name === null ? " (a value where no flag takes one)" : ""}\n${USAGE}`);
    process.exit(2);
  }
}

const url = flag("url") ?? process.env.DATABASE_URL;
const dryRun = has("dry-run");
const baseline = has("baseline");
const reapply = has("reapply");

if (!url) {
  console.error("No database URL. Pass --url or set DATABASE_URL.");
  process.exit(2);
}
if (reapply && baseline) {
  console.error("--reapply re-runs what the ledger records; --baseline records without running. One or the other.");
  process.exit(2);
}

type Migration = {
  name: string;
  sql: string;
  sha: string;
  /** From a `-- requires: pgvector >= X.Y.Z` line in the file's header, if any. */
  requiresPgvector: [number, number, number] | null;
  /** Database-level settings the file seeds through a DO block that can only warn — read from its text. */
  seeds: string[];
};

/**
 * A migration that needs a newer pgvector than the server may have says so in
 * its header — `-- requires: pgvector >= 0.8.0` — and the migrator judges the
 * floor from that line, so a later migration with the same need declares it
 * rather than being named here (the tenth review pass found 014's filename
 * hard-coded into four places of this loop).
 */
function requiresPgvector(template: string): [number, number, number] | null {
  const m = /^--\s*requires:\s*pgvector\s*>=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/m.exec(template);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * Values substituted into the migration templates. Defined in config.mjs, not
 * here, because db/test-support.ts and db/test-schema.ts substitute the same
 * templates and each used to carry its own hardcoded pair of replacements.
 */
const SUBSTITUTIONS = migrationValues();

function substitute(sql: string, file: string): string {
  return substituteMigration(sql, SUBSTITUTIONS, file);
}

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort() // 001_, 002_, … lexical order is the intended order
    .map((name) => {
      const template = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      return {
        name,
        requiresPgvector: requiresPgvector(template),
        seeds: [...new Set([...template.matchAll(/ALTER DATABASE %I SET (hnsw\.\w+)/g)].map((x) => x[1]))],
        sql: substitute(template, name),
        // Hash the TEMPLATE, not the substituted SQL. Otherwise choosing a
        // different embedding dimension would look like an edited migration and
        // trip the drift check, when the file has not changed at all.
        sha: createHash("sha256").update(template).digest("hex").slice(0, 12),
      };
    });
}

const configProblems = validateEmbeddingConfig();
if (configProblems.length > 0) {
  console.error("Embedding configuration is not usable:\n");
  for (const p of configProblems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(2);
}

const migrations = loadMigrations();
if (migrations.length === 0) {
  console.error(`No .sql files in ${MIGRATIONS_DIR}`);
  process.exit(2);
}

console.log(`  embedding: ${EMBEDDING_MODEL} @ ${EMBEDDING_DIM} dimensions`);
// Printed because it is the one setting that changes what the schema CONTAINS
// rather than how wide a column is, and because it takes effect only when 011
// runs — the first apply, and every --reapply — see the note in that
// migration's header.
console.log(`  trigram index: ${TRGM_INDEX ? "on" : "off"} (OB1_TRGM_INDEX)`);
console.log(`  023 backfill:  ${SUBSTITUTIONS.BACKFILL_LIMIT === "NULL" ? "every row waiting" : `one batch of ${SUBSTITUTIONS.BACKFILL_LIMIT} rows`} (OB1_BACKFILL_LIMIT)`);

const sql = new SQL({ url, max: 1 });

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Map<string, string>(
  (await sql`SELECT name, sha256 FROM schema_migrations`).map(
    (r: { name: string; sha256: string }) => [r.name, r.sha256]
  )
);

/** Recorded in the ledger under --reapply: re-run rather than skipped. */
const reapplies = (m: Migration): boolean => reapply && applied.has(m.name);

/**
 * Migration 014 declares HNSW settings that exist from pgvector 0.8.0. On an
 * older library its CREATE fails — by design, see its header — but "invalid
 * configuration parameter name" says nothing about versions, is localised, and
 * only appears once 001–013 have applied. So the floor each migration declares
 * is judged here, against the version the server's library REPORTS
 * (pg_available_extensions.default_version — the loaded code, whatever
 * pg_extension records for this database), and enforced in the loop: pending
 * migrations before it still apply and are recorded, --baseline still seeds
 * the ledger (it executes no SQL), and the migration itself is refused with a
 * message that names both versions. --dry-run reports the refusal the same
 * way. Unknown means proceed: a server whose control file is unreadable will
 * still say so on the migration.
 */
let pgvectorLibrary: string | null = null;
if (migrations.some((m) => m.requiresPgvector && (!applied.has(m.name) || reapplies(m)))) {
  try {
    const [ext] = await sql`SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`;
    pgvectorLibrary = ext?.default_version == null ? null : String(ext.default_version);
  } catch {
    // Not every role may read pg_available_extensions. Unknown means proceed;
    // an old library still fails the migration itself, and the catch below
    // explains it.
  }
}
/** The version a migration requires, when the server's library is known to be older. */
const tooOldFor = (m: Migration): string | null =>
  m.requiresPgvector && pgvectorLibrary !== null && !versionAtLeast(pgvectorLibrary, ...m.requiresPgvector)
    ? m.requiresPgvector.join(".")
    : null;
const pgvectorRemedy = (then: string) =>
  "  Upgrade pgvector on the server to 0.8.0 or later — the compose stack pins pgvector/pgvector:0.8.6-pg16;\n" +
  "  on RDS, Aurora, Neon, Cloud SQL or Timescale, take the platform's newer pgvector — then, in this database,\n" +
  "    ALTER EXTENSION vector UPDATE;\n" +
  `  and re-run. ${then}`;
const PGVECTOR_REMEDY = pgvectorRemedy("Migrations before it are applied and recorded; nothing needs undoing.");
// Under --reapply the whole set is one transaction that has not begun when the
// floor refuses, so the plain remedy's last sentence would be false there.
const floorMessage = (m: Migration, reapplying = false) =>
  `\n  ${m.name} needs pgvector ${tooOldFor(m)} or later; this server's pgvector library is ${pgvectorLibrary}.\n` +
  (reapplying ? pgvectorRemedy("Nothing ran: the re-run is one transaction, and it had not begun.") : PGVECTOR_REMEDY);
// pgvector may be installed into a schema off this connection's search_path —
// how Supabase and several managed providers ship it (upstream #319). There,
// `CREATE EXTENSION IF NOT EXISTS vector` finds it and does nothing, and then
// 001's `vector({{EMBEDDING_DIM}})` fails with `type "vector" does not exist` on
// a database that has pgvector. Put the schema on this session's path before any
// migration runs; it survives into each per-migration transaction below. A no-op
// where `vector` already resolves. This heals the migrating session only — the
// server's own connection is separate, and preflight's `vector extension` check
// names the persistent fix (ALTER ROLE / ALTER DATABASE) for it.
const vectorSchema = await alignVectorSearchPath(sql);
if (vectorSchema) {
  console.log(
    `  pgvector: installed in schema "${vectorSchema}", off this connection's search_path — added to this session so the migrations resolve the vector type`
  );
  console.log(
    `            (if a migration still fails on the vector type, this role lacks USAGE on ${vectorSchema}; the running server needs the path too — preflight's "vector extension" check names both fixes)`
  );
}

let ran = 0;
let reapplied = 0;
let skipped = 0;
let drifted = 0;
let floorBlocked: Migration | null = null;

/**
 * What a failed statement means, beyond its message — read by the plain run's
 * catch and the re-run's alike. Bun exposes the SQLSTATE as `errno`; the
 * message is localised, the code is not. 42602 (invalid_name) on an hnsw.*
 * setting is the reserved-prefix rejection: the loaded library predates the
 * setting, and only a server upgrade helps — the re-run reaches it when the
 * floor probe could not read the library's version. 42501
 * (insufficient_privilege) on an hnsw.* setting is a non-superuser in a session
 * that has not loaded pgvector — 014 loads it first, so this is reachable only
 * from a hand-run statement, but say what it means. 55P03 (lock_not_available)
 * is a lock_timeout: the re-run's 10 s, or on a plain run the session's — 023's
 * call sets 10 s for its own transaction, a role or provider default may set
 * one for every statement. What follows a failure differs by mode: a plain run
 * has applied and recorded the files before it; a re-run rolled back whole. A
 * HINT the statement raised with — 030's names --reapply — is printed as it
 * came.
 */
function explainFailure(err: unknown, m: Migration | null, mode: "plain" | "reapply" | "checks"): string[] {
  const message = (err as Error).message;
  const { errno: sqlstate, hint } = err as { errno?: string; hint?: string };
  const lines: string[] = [];
  if (/hnsw\./.test(message) && sqlstate === "42602") {
    lines.push(
      `\n  ${m?.name ?? "the migration"} needs pgvector ${m?.requiresPgvector?.join(".") ?? "0.8.0"} or later, and the loaded library rejected an hnsw.* setting.\n` +
        (mode === "reapply" ? pgvectorRemedy("Nothing ran: the re-run is one transaction, and it rolled back.") : PGVECTOR_REMEDY)
    );
  } else if (/hnsw\./.test(message) && sqlstate === "42501") {
    lines.push(
      `\n  A non-superuser may set hnsw.* settings only after pgvector's library is loaded in the session.\n` +
        `  Run SELECT '[1]'::vector; first in the same session, then the statement that failed.`
    );
  } else if (sqlstate === "55P03") {
    lines.push(
      mode === "reapply"
        ? "  A lock was not granted within the re-run's 10 s lock_timeout: a session holds one on a table the re-run alters — the server, a worker, or an idle transaction. End it first."
        : mode === "checks"
          ? "  A lock was not granted within the 10 s the checks before the run set for their reads: a session holds an exclusive lock on thoughts or the claim table — the server mid-ALTER, or an idle transaction. End it first."
          : "  A lock was not granted within the session's lock_timeout (023's call sets 10 s for its own transaction; a role or provider default may set one): a session holds one on a table this migration alters — the server, a worker, or an idle transaction. End it first."
    );
  }
  if (hint) lines.push(`  ${hint}`);
  return lines;
}

/**
 * A migration that seeds database-level settings does so from a DO block that
 * can only RAISE WARNING when the role does not own the database — and this
 * client surfaces no warnings. So look at the result rather than trust the
 * protocol. Called outside the applying transaction: the migration is applied
 * and recorded by then, and a catalog this role cannot read must not turn that
 * into "FAILED". Read on a first apply and on a re-run alike — a brain adopted
 * with --baseline never had the migrator run 014, so the re-run is the first
 * time it can say the walk bounds are unseeded.
 */
async function reportSeeds(m: Migration): Promise<void> {
  try {
    // "Set" means set where every role sees it: server configuration or the
    // database (SHARED_SETTING_SOURCES, as THIS session resolved them at
    // connect), or the database-level row the migration itself may just have
    // written — which this session, opened before the ALTER DATABASE, does
    // not yet see in pg_settings. A role-level value on the migrating role
    // is neither: it reaches this role alone (tenth review pass). The arrays
    // go through sql.array: a bare `${array}` is sent as comma-joined text,
    // and this whole check silently fell into the catch below on every run
    // until the eleventh review pass ran the migrator and read the output.
    const [row] = await sql`SELECT current_database() AS db`;
    const shared = (await sql`
      SELECT name FROM pg_settings
      WHERE name = ANY(${sql.array(m.seeds, "TEXT")}) AND source = ANY(${sql.array(SHARED_SETTING_SOURCES, "TEXT")})`) as { name: string }[];
    const [dbRow] = await sql.unsafe(DB_LEVEL_SETTINGS_SQL);
    const dbLevel = parseSetConfig(dbRow?.cfg);
    const missing = m.seeds.filter((name) => !shared.some((r) => r.name === name) && !(name in dbLevel));
    if (missing.length) {
      const statements = missing
        .map((name) => `       ALTER DATABASE ${quoteIdent(row?.db)} SET ${name} = ${(HNSW_SEEDS as Record<string, number>)[name] ?? "<value>"};`)
        .join("\n");
      console.error(
        `  ⚠  ${m.name}  applied, but the database-level HNSW walk bounds were not seeded (${missing.join(", ")}) —\n` +
          `     the migrating role does not own the database, or the platform refused ALTER DATABASE. Run as the owner, in one session:\n` +
          `       SELECT '[1]'::vector;   -- loads pgvector so a non-superuser may set hnsw.* settings\n` +
          `${statements}\n` +
          `     Until then a broad filter's walk runs with pgvector's defaults, which return short on large tables; preflight warns about it.`
      );
    }
  } catch (e) {
    console.error(`  ⚠  ${m.name}  applied; could not read pg_settings to confirm the walk bounds (${(e as Error).message}). Preflight checks them at startup.`);
  }
}

// ── The re-run, one transaction ─────────────────────────────────────────────
// Every migration — recorded or pending — in order, in ONE transaction: a
// failure part-way would otherwise leave the files before it at their own
// definitions while a later file's redefinition of the same objects — 022's and
// 025's of 021's upsert_thought; 020's drop of the 4-argument match_thoughts
// that 014 and 019 recreate — was not yet restored, with nothing in the catalog
// to say so; and a pending file left for the loop would apply AFTER the re-run,
// over what it restored. All or nothing, and the output says which. Judged
// before BEGIN: the drift (above), the pgvector floor, the two things a re-run
// must not do quietly — re-record ob1_config from a shell configured
// differently from the brain (006 and 013 write INSERT … ON CONFLICT DO UPDATE
// again), and let 021's block, run as written, label an unlabelled thought from
// an acceptance under a SUFFIXED key, which 030 cannot tell from the server's
// own label (030's header, "What it leaves"). A 10 s lock_timeout from the first
// statement, so an idle session holding a lock on thoughts fails the re-run at
// once rather than freezing every reader behind 001's ACCESS EXCLUSIVE for ever
// — the banner says to stop the writers first. The seeds check runs after the
// commit for every file that seeds, as on a first apply.
// 021's evidence backfill runs whenever 021 runs: under --reapply, and on a
// plain run where 021 is pending — a brain built by hand through 021 and later
// adopted by "just run them", or a ledger hole. Never under --baseline, which
// executes no SQL. The gate below reads the rows 021 would label from that 030
// would then leave — and whether 030 runs in THIS invocation decides what
// "leave" means: after 021 in the same run it takes an own-key acceptance's
// label back, so only the rest is refused; recorded and skipped (a hole at 021
// alone), nothing follows 021, and every acceptance it would read is refused.
// The other judgements are the re-run's own. The two filenames in this loop,
// because the hazard is one file's block and the correction the other's, and
// no header line could carry it (021 is hashed).
const pending = (prefix: string) => migrations.some((m) => m.name.startsWith(prefix) && !applied.has(m.name));
const runs021 = !baseline && (reapply || pending("021_"));
const runs030 = reapply || pending("030_");
if (runs021) {
  // Judged whole, before anything runs, and the same under --dry-run — which
  // says "would refuse" where the run says "refusing", so a green dry run is
  // never followed by a red run. Every refusal is reported, not the first.
  const refusals: { code: number; text: string }[] = [];
  const changed = reapply ? migrations.filter((m) => reapplies(m) && applied.get(m.name) !== m.sha) : [];
  if (changed.length > 0) {
    refusals.push({
      code: 1,
      text:
        `${changed.map((m) => `${m.name} (was ${applied.get(m.name)}, now ${m.sha})`).join(", ")} changed after being applied.\n` +
        "  Migrations are append-only. If the edit was intentional and the database already reflects it, update schema_migrations.sha256 by hand, then re-run.",
    });
  }
  const floor = reapply ? migrations.find((m) => tooOldFor(m)) : undefined;
  if (floor) refusals.push({ code: 1, text: `${floor.name} would fail on the pgvector floor.` + floorMessage(floor, true) });
  // The catalog, read by relation (to_regclass) rather than by name in
  // information_schema, which sees a `thoughts` in any schema the role can
  // read; and the eight-argument signature names the vector type, which
  // to_regprocedure cannot parse before pgvector is installed — asked only
  // where the type resolves. Every read here is guarded: a role without
  // SELECT on the claim table, or a row the query cannot evaluate, is a
  // refusal that names the error, not a stack trace with the connection open.
  let probe: { has_config: boolean; has_claims: boolean; has_label: boolean; has_edit: boolean; width: number | null };
  let hazards: { id: string; work_type: string }[] = [];
  let record: Record<string, string> = {};
  try {
    // The reads take ACCESS SHARE on thoughts and the claim table; behind a
    // session holding ACCESS EXCLUSIVE they would wait for ever, before the
    // transaction's own lock_timeout exists. Ten seconds here too, then reset.
    await sql.unsafe("SET lock_timeout = '10s'");
    [probe] = (await sql`
      SELECT to_regclass('ob1_config') IS NOT NULL AS has_config,
             to_regclass('thought_work_claims') IS NOT NULL AS has_claims,
             EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('thoughts') AND attname = 'embedding_model' AND NOT attisdropped) AS has_label,
             CASE WHEN to_regtype('vector') IS NULL THEN false
                  ELSE EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(${"public." + UPDATE_THOUGHT_SIGNATURE})
                                 AND prosrc LIKE '%ob1:unchanged-edit-not-duplicate%') END AS has_edit,
             (SELECT atttypmod FROM pg_attribute WHERE attrelid = to_regclass('thoughts') AND attname = 'embedding' AND NOT attisdropped) AS width`) as
      { has_config: boolean; has_claims: boolean; has_label: boolean; has_edit: boolean; width: number | null }[];
    if (probe.has_config && reapply) {
      const rows = (await sql`SELECT key, value::text AS value FROM ob1_config WHERE key IN ('embedding_model')`) as { key: string; value: string }[];
      record = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    }
    if (probe.has_claims) {
      // The rows 021's block, run as written, would label from an acceptance and
      // 030 would then leave: the difference of the two rules, not a case
      // encoded by hand. 021 labels an unlabelled thought with a vector from a
      // row at its latest finished_at when `updated_at <= finished_at` — one
      // row of a tie, unnamed, so every accepted row at that time counts here.
      // 030 takes the label back only for an own-key acceptance over a thought
      // not written since the row's enqueue. Whatever 021 labels that 030 does
      // not revert is refused — when 030 runs in this invocation; when it does
      // not, nothing takes any label back, and every acceptance counts. The
      // rows are config.mjs's, as 030 reads them. The accepted rows are picked
      // before "latest" is asked (a window over every row was the planner
      // barrier the shared text lost); one row per (thought, key) already, so
      // no DISTINCT.
      hazards = (await sql.unsafe(
        `SELECT t.id::text AS id, e.work_type FROM thoughts t JOIN (SELECT r.* FROM (${CLAIM_EVIDENCE_ROWS_SQL}) r WHERE r.accepted) e ON e.thought_id = t.id ` +
          `WHERE NOT EXISTS (SELECT 1 FROM (${CLAIM_EVIDENCE_ROWS_SQL}) l WHERE l.thought_id = e.thought_id AND l.finished_at > e.finished_at)` +
          " AND t.embedding IS NOT NULL AND t.updated_at <= e.finished_at" +
          (probe.has_label ? " AND t.embedding_model IS NULL" : "") +
          (runs030 ? " AND NOT (e.own_key AND COALESCE(t.updated_at, t.created_at) <= COALESCE(e.enqueued_at, e.claimed_at, e.finished_at, '-infinity'::timestamptz))" : "") +
          " ORDER BY 2, 1"
      )) as { id: string; work_type: string }[];
    }
    await sql.unsafe("RESET lock_timeout");
  } catch (err) {
    console.error(`  ✗  ${reapply ? "--reapply" : "021_embedding_model_per_row.sql"}  could not be judged: ${(err as Error).message}`);
    for (const line of explainFailure(err, null, "checks")) console.error(line);
    console.error("  The checks before the run read pg_attribute, pg_proc, ob1_config and thought_work_claims; this role could not, or was made to wait. Nothing was written.");
    await sql.close();
    process.exit(1);
  }
  const { has_config, has_label, has_edit, width } = probe;
  // The column is the width's authority (ob1_config's copy can be edited by
  // hand); 006 refuses a shell whose width differs from it — inside the
  // transaction, after a dry run had said green. Judged here, both modes.
  if (reapply && width !== null && Number(width) <= 0) {
    // pgvector allows a bare `vector` column (atttypmod -1); 006 requires the
    // declared width, so the re-run would refuse inside the transaction.
    refusals.push({
      code: 2,
      text:
        "thoughts.embedding declares no width (a bare vector column) and 006 requires vector(OB1_EMBEDDING_DIM), so the re-run would\n" +
        `  refuse inside the transaction. Declare it first — ALTER TABLE thoughts ALTER COLUMN embedding TYPE vector(${SUBSTITUTIONS.EMBEDDING_DIM}); — with\n` +
        "  every stored vector at that width.",
    });
  } else if (reapply && width !== null && Number(width) !== Number(SUBSTITUTIONS.EMBEDDING_DIM)) {
    refusals.push({
      code: 2,
      text:
        `thoughts.embedding is vector(${width}) and this shell says OB1_EMBEDDING_DIM=${SUBSTITUTIONS.EMBEDDING_DIM} — 006 would refuse the mismatch inside\n` +
        `  the transaction. Set OB1_EMBEDDING_DIM=${width}; changing the width is a re-embed of every row, not a re-run.`,
    });
  }
  // The record 006 would write again from this shell. The model only: the
  // width is the column's (above), and 013's chunk_context IS "what was
  // configured when the schema was last migrated" — a flag the operator may
  // flip between runs by 013's own header, so re-recording it is the update,
  // not a change to refuse.
  if (reapply && has_config && "embedding_model" in record && record.embedding_model !== SUBSTITUTIONS.EMBEDDING_MODEL) {
    refusals.push({
      code: 2,
      text:
        `ob1_config records embedding_model = ${record.embedding_model} and this shell would re-record it as ${SUBSTITUTIONS.EMBEDDING_MODEL} —\n` +
        "  006 writes its INSERT … ON CONFLICT DO UPDATE again on a re-run, and every reader of the record would follow the shell.\n" +
        "  Run from a shell configured as the brain is (OB1_EMBEDDING_MODEL), or change the record on purpose with\n" +
        "  reembed.ts --switch-model, which moves the corpus with it.",
    });
  }
  {
    if (hazards.length) {
      const keys = [...new Set(hazards.map((h) => h.work_type))];
      const shown = hazards.slice(0, 50);
      const again = reapply ? "--reapply" : "the migrator";
      // The way back depends on the schema: reembed.ts runs only against 021's
      // whole (the column and the eight-argument update_thought), so on an
      // older schema — where such a row can only have been written by hand,
      // since --accept-failed refuses it too — the remedy is the statement
      // --retry-fallbacks would run, or the tool loops the operator between
      // two refusals. One statement per key, every row of it.
      const wayBack = has_label && has_edit
        ? "  Return them to their pool first — bun reembed.ts --url … --job <key> --retry-fallbacks, which spends the acceptance — or retire\n" +
          `  the key if it is superseded (--retire <key>), then run ${again} again.`
        : `  reembed.ts refuses to run against this schema (${has_label ? "021's update_thought is not installed" : "it predates 021"}) and cannot return them; --accept-failed refuses it too, so\n` +
          `  these rows were written by hand. Return them as --retry-fallbacks would, then run ${again} again:\n` +
          // requeue()'s statement in reembed.ts, per key: the caveat gone, the
          // attempts reset, the lease cleared; claimed_at stays, as there.
          keys.map((k) => `    UPDATE thought_work_claims SET ${REQUEUE_SET_SQL} WHERE work_type = '${k.replace(/'/g, "''")}' AND thought_id IN (${hazards.filter((h) => h.work_type === k).map((h) => `'${h.id}'`).join(", ")});`).join("\n");
      refusals.push({
        code: 2,
        text:
          `021's evidence backfill, ${reapply ? "re-run" : "run"} as written, would label ${hazards.length} unlabelled thought(s) from an acceptance that\n` +
          (runs030
            ? `  migration 030 would not take back — under a suffixed key, or written since the row was enqueued (${keys.join(", ")}):\n`
            : `  nothing would take back — 030 is recorded, so it does not run after 021 here (${keys.join(", ")}):\n`) +
          shown.map((h) => `    ${h.id}  ${h.work_type}`).join("\n") +
          (hazards.length > shown.length ? `\n    … and ${hazards.length - shown.length} more` : "") +
          "\n" + wayBack,
      });
    }
  }
  if (refusals.length) {
    for (const r of refusals) console.error(`\n  ${dryRun ? "would refuse" : "refusing"} ${reapply ? "--reapply" : "to apply 021"}: ${r.text}`);
    console.error(`\n  Nothing was written.`);
    await sql.close();
    process.exit(Math.max(...refusals.map((r) => r.code)));
  }
  // Announced only once nothing refuses: a banner before a refusal read as a
  // run that never began.
  const recorded = migrations.filter(reapplies).length;
  if (reapply) {
    console.log(
      `  ${dryRun ? "would re-apply" : "re-applying"} every migration (${recorded} recorded, ${migrations.length - recorded} pending), in order, in one transaction with a 10 s lock timeout —\n` +
        "  recorded rows stay as they are, pending ones are recorded. Stop the server and any re-embed or extraction worker first:\n" +
        "  001 and 003 take ACCESS EXCLUSIVE locks on thoughts, 011 builds the trigram index if OB1_TRGM_INDEX is on and it is absent,\n" +
        "  023's backfill call locks thoughts (OB1_BACKFILL_LIMIT bounds it, as on a first apply), 025 re-validates its constraints."
    );
  }
}

if (reapply && !dryRun) {
  // An object, not a `let`: an assignment inside the callback is invisible to
  // the type checker's flow analysis, which would narrow a `let` to null.
  const progress: { current: Migration | null } = { current: null };
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL lock_timeout = '10s'");
      for (const m of migrations) {
        progress.current = m;
        await tx.unsafe(m.sql);
        if (!applied.has(m.name)) await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
      }
    });
  } catch (err) {
    console.error(`  ✗  ${progress.current?.name ?? "--reapply"}  FAILED: ${(err as Error).message}`);
    for (const line of explainFailure(err, progress.current, "reapply")) console.error(line);
    console.error(
      "  The re-run is one transaction: it rolled back, nothing was re-applied or applied, and the schema is as it was.\n" +
        "  Fix the cause and run --reapply again."
    );
    await sql.close();
    process.exit(1);
  }
  for (const m of migrations) {
    const again = applied.has(m.name);
    console.log(`  ✓  ${m.name}  ${again ? "re-applied" : "applied"}`);
    if (again) reapplied++;
    else ran++;
  }
  for (const m of migrations) if (m.seeds.length) await reportSeeds(m);
}

// Under a live --reapply every file ran above; this loop is the plain run's and --dry-run's.
for (const m of reapply && !dryRun ? [] : migrations) {
  const prior = applied.get(m.name);

  if (prior && prior !== m.sha) {
    // The file changed after being applied. Do not silently re-run it — that is
    // how a "working" migration set stops matching the database it produced.
    console.error(`  ⚠  ${m.name}  ALREADY APPLIED BUT FILE CHANGED (was ${prior}, now ${m.sha})`);
    drifted++;
    continue;
  }
  if (prior && !reapplies(m)) {
    console.log(`  ·  ${m.name}  already applied`);
    skipped++;
    continue;
  }
  if (dryRun) {
    // The plain run's judgement. A recorded file under --reapply reaches here
    // too — as "would re-apply" — but never with a floor: the checks above
    // refuse the whole re-run on one before this loop runs.
    if (tooOldFor(m)) {
      console.log(`  ✗  ${m.name}  would FAIL: pgvector ${pgvectorLibrary} < ${tooOldFor(m)}`);
      floorBlocked ??= m;
      continue;
    }
    // The live run exits at the first refusal, so nothing after it applies;
    // saying "would apply" for those would promise what the run cannot do.
    if (floorBlocked) {
      console.log(`  ·  ${m.name}  blocked behind ${floorBlocked.name}`);
      continue;
    }
    console.log(`  →  ${m.name}  would ${prior ? "re-apply" : "apply"} (${m.sha})`);
    if (prior) reapplied++;
    else ran++;
    continue;
  }
  if (baseline) {
    await sql`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
    console.log(`  ✓  ${m.name}  marked applied without running (--baseline)`);
    ran++;
    continue;
  }

  // The version floor, enforced only where it bites: earlier pending migrations
  // have already applied above, and --baseline never reaches here.
  if (tooOldFor(m)) {
    console.error(`  ✗  ${m.name}  refused` + floorMessage(m));
    await sql.close();
    process.exit(1);
  }

  // Each migration runs in its own transaction: a failure leaves earlier ones
  // applied and recorded, so a rerun resumes rather than starting over.
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
    });
    console.log(`  ✓  ${m.name}  applied`);
    ran++;
  } catch (err) {
    console.error(`  ✗  ${m.name}  FAILED: ${(err as Error).message}`);
    for (const line of explainFailure(err, m, "plain")) console.error(line);
    await sql.close();
    process.exit(1);
  }

  if (m.seeds.length) await reportSeeds(m);
}

await sql.close();

const verb = dryRun ? "would apply" : baseline ? "baselined" : "applied";
console.log(`\n${verb} ${ran}${reapplied ? `, ${dryRun ? "would re-apply" : "re-applied"} ${reapplied}` : ""}, skipped ${skipped}${drifted ? `, DRIFTED ${drifted}` : ""}`);

// Both conditions can hold in one --dry-run (the live path exits inside the
// loop). Say everything before exiting: a floor message that hid the drift
// remedy sent the operator to upgrade pgvector and back here for the sha.
if (floorBlocked) console.error(floorMessage(floorBlocked));
if (drifted > 0) {
  console.error(
    "\nA migration file changed after it was applied. Migrations are append-only:\n" +
      "add a new file rather than editing an old one. If the edit was intentional and\n" +
      "the database already reflects it, update schema_migrations.sha256 by hand."
  );
}
if (floorBlocked || drifted > 0) process.exit(1);
