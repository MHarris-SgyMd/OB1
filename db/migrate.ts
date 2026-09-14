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
 *   bun db/migrate.ts --reapply 021    # re-run 021 and every recorded migration after it
 *
 * Applied migrations are recorded in schema_migrations, so re-running is a no-op.
 * Every migration is also individually idempotent, so a database created by hand
 * from docs/01-getting-started.md can be adopted: mark the ones already applied
 * with --baseline, or just run them — they will not duplicate anything.
 *
 * --reapply <migration> re-runs a migration the ledger records, and every
 * recorded one after it, in order; pending ones apply as usual and the ledger is
 * not touched. It is the remedy for a database adopted with --baseline whose
 * schema is older than its ledger says — reembed.ts and preflight name the
 * command where they find that. After it, not it alone: a later migration may
 * redefine what an earlier one created (022 and 025 redefine 021's
 * upsert_thought), and since every file is idempotent the run restores the
 * latest definition of everything from that point. The one file not run
 * verbatim is 021 — see reapply021 below (SMD-1193).
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  ACCEPTED_CAVEAT_PREFIX,
  ACCEPTED_EVIDENCE_COUNT_SQL,
  alignVectorSearchPath,
  DB_LEVEL_SETTINGS_SQL,
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  HNSW_SEEDS,
  LABEL_FROM_CLAIMS_SQL,
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

const url = flag("url") ?? process.env.DATABASE_URL;
const dryRun = has("dry-run");
const baseline = has("baseline");
const reapply = has("reapply");
/** `--reapply 021`, or `--reapply 021_embedding_model_per_row.sql`: where the re-run starts. */
const reapplyArg = flag("reapply");

if (!url) {
  console.error("No database URL. Pass --url or set DATABASE_URL.");
  process.exit(2);
}
if (reapply && (reapplyArg === undefined || reapplyArg.startsWith("--"))) {
  console.error("--reapply takes the migration to start from: its number (021) or its filename.");
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

/**
 * The migration --reapply starts from, resolved by number or by name against
 * the files present — exactly one, or the run stops before it connects.
 */
const reapplyFrom: Migration | null = (() => {
  if (!reapply) return null;
  const want = reapplyArg!.replace(/\.sql$/, "");
  const hits = migrations.filter((m) => m.name.slice(0, -4) === want || (/^\d+$/.test(want) && m.name.startsWith(`${want}_`)));
  if (hits.length !== 1) {
    console.error(
      hits.length === 0
        ? `--reapply ${reapplyArg}: no migration by that number or name in ${MIGRATIONS_DIR}`
        : `--reapply ${reapplyArg} names ${hits.length} migrations: ${hits.map((m) => m.name).join(", ")}`
    );
    process.exit(2);
  }
  return hits[0];
})();

/**
 * 021 is the one file --reapply does not run verbatim. Its evidence backfill —
 * the `DO $bf$ … $bf$;` block, the tag unique to that file — labels a thought
 * from its latest succeeded claim row under a key naming a model, and since
 * SMD-1067 a succeeded row can be the operator's acceptance of a FAILURE
 * (`--accept-failed`), whose thought is by decision not at that model. The file
 * is applied and hashed, so the rule cannot be corrected where it is written:
 * the block is replaced by LABEL_FROM_CLAIMS_SQL — 021's rule with accepted
 * rows excluded, spelled once in config.mjs — and the rest of the file runs as
 * written, before and after it, in the one transaction. The trigger hold is
 * 021's own: the label is a fact about a vector already there, not an edit
 * (SMD-1193). Returns what the run should say about it.
 */
const BACKFILL_021 = /DO \$bf\$[\s\S]*?\$bf\$;/;
async function reapply021(tx: SQL, m: Migration): Promise<string> {
  const parts = m.sql.split(BACKFILL_021);
  if (parts.length !== 2) throw new Error(`${m.name} should hold exactly one DO $bf$ … $bf$ block, its evidence backfill; found ${parts.length - 1}`);
  await tx.unsafe(parts[0]);
  await tx.unsafe("ALTER TABLE thoughts DISABLE TRIGGER thoughts_updated_at");
  const labelled = await tx.unsafe(LABEL_FROM_CLAIMS_SQL, [ACCEPTED_CAVEAT_PREFIX]);
  await tx.unsafe("ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at");
  await tx.unsafe(parts[1]);
  const [{ n: accepted }] = await tx.unsafe(ACCEPTED_EVIDENCE_COUNT_SQL, [ACCEPTED_CAVEAT_PREFIX]);
  return ` — its evidence backfill labelled ${labelled.count} row(s); ${accepted} accepted row(s) under a key naming a model were not read as evidence`;
}

console.log(`  embedding: ${EMBEDDING_MODEL} @ ${EMBEDDING_DIM} dimensions`);
// Printed because it is the one setting that changes what the schema CONTAINS
// rather than how wide a column is, and because it only takes effect the first
// time 011 applies — see the note in that migration's header.
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

/** Recorded in the ledger, and at or after where --reapply starts: re-run rather than skipped. */
const reapplies = (m: Migration): boolean => reapplyFrom !== null && m.name >= reapplyFrom.name && applied.has(m.name);

// --reapply is judged whole before anything runs: the start must be recorded
// (a pending migration is applied by a plain run), and no file in the range may
// have changed since it was applied — the drift check below reports a drifted
// file and moves on, which for a re-run would skip one file's definitions and
// restore the next one's over whatever the skipped one left.
if (reapplyFrom !== null) {
  if (!applied.has(reapplyFrom.name)) {
    console.error(`  ${reapplyFrom.name} is not recorded as applied; --reapply re-runs what the ledger records. Run without it to apply what is pending.`);
    await sql.close();
    process.exit(2);
  }
  const drifted = migrations.filter((m) => reapplies(m) && applied.get(m.name) !== m.sha);
  if (drifted.length > 0) {
    console.error(
      `  refusing --reapply: ${drifted.map((m) => `${m.name} (was ${applied.get(m.name)}, now ${m.sha})`).join(", ")} changed after being applied.\n` +
        "  Migrations are append-only. If the edit was intentional and the database already reflects it, update schema_migrations.sha256 by hand, then re-run."
    );
    await sql.close();
    process.exit(1);
  }
  const after = migrations.filter((m) => reapplies(m)).length - 1;
  console.log(
    `  re-applying ${reapplyFrom.name} and the ${after} recorded migration(s) after it, in order — a later file may redefine what an earlier one created; the ledger is not touched`
  );
}

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
const PGVECTOR_REMEDY =
  "  Upgrade pgvector on the server to 0.8.0 or later — the compose stack pins pgvector/pgvector:0.8.6-pg16;\n" +
  "  on RDS, Aurora, Neon, Cloud SQL or Timescale, take the platform's newer pgvector — then, in this database,\n" +
  "    ALTER EXTENSION vector UPDATE;\n" +
  "  and re-run. Migrations before it are applied and recorded; nothing needs undoing.";
const floorMessage = (m: Migration) =>
  `\n  ${m.name} needs pgvector ${tooOldFor(m)} or later; this server's pgvector library is ${pgvectorLibrary}.\n${PGVECTOR_REMEDY}`;
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

for (const m of migrations) {
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
  const again = reapplies(m);
  if (dryRun) {
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
    console.log(`  →  ${m.name}  would ${again ? "re-apply" : "apply"} (${m.sha})`);
    if (again) reapplied++;
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
    let note = "";
    await sql.begin(async (tx) => {
      if (again && m.name.startsWith("021_")) note = await reapply021(tx, m);
      else await tx.unsafe(m.sql);
      // A re-run is already recorded; its row, sha and applied_at stand.
      if (!again) await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
    });
    console.log(`  ✓  ${m.name}  ${again ? "re-applied" : "applied"}${note}`);
    if (again) reapplied++;
    else ran++;
  } catch (err) {
    const message = (err as Error).message;
    // Bun exposes the SQLSTATE as `errno`; the message is localised, the code
    // is not. 42602 (invalid_name) is the reserved-prefix rejection: the loaded
    // library predates the hnsw.* setting, and only a server upgrade helps.
    // 42501 (insufficient_privilege) on an hnsw.* setting is a non-superuser
    // in a session that has not loaded pgvector — 014 now loads it first, so
    // this is reachable only from a hand-run statement, but say what it means.
    const sqlstate = (err as { errno?: string }).errno;
    console.error(`  ✗  ${m.name}  FAILED: ${message}`);
    if (/hnsw\./.test(message) && sqlstate === "42602") {
      console.error(`\n  ${m.name} needs pgvector ${m.requiresPgvector?.join(".") ?? "0.8.0"} or later, and the loaded library rejected an hnsw.* setting.\n${PGVECTOR_REMEDY}`);
    } else if (/hnsw\./.test(message) && sqlstate === "42501") {
      console.error(
        `\n  A non-superuser may set hnsw.* settings only after pgvector's library is loaded in the session.\n` +
          `  Run SELECT '[1]'::vector; first in the same session, then the statement that failed.`
      );
    }
    await sql.close();
    process.exit(1);
  }

  // A migration that seeds database-level settings does so from a DO block
  // that can only RAISE WARNING when the role does not own the database — and
  // this client surfaces no warnings. So look at the result rather than trust
  // the protocol. Outside the try above: the migration is applied and recorded
  // by now, and a catalog this role cannot read must not turn that into
  // "FAILED".
  if (m.seeds.length) {
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
