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
 *
 * Applied migrations are recorded in schema_migrations, so re-running is a no-op.
 * Every migration is also individually idempotent, so a database created by hand
 * from docs/01-getting-started.md can be adopted: mark the ones already applied
 * with --baseline, or just run them — they will not duplicate anything.
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
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

const url = flag("url") ?? process.env.DATABASE_URL;
const dryRun = has("dry-run");
const baseline = has("baseline");

if (!url) {
  console.error("No database URL. Pass --url or set DATABASE_URL.");
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
// rather than how wide a column is, and because it only takes effect the first
// time 011 applies — see the note in that migration's header.
console.log(`  trigram index: ${TRGM_INDEX ? "on" : "off"} (OB1_TRGM_INDEX)`);

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
if (migrations.some((m) => m.requiresPgvector && !applied.has(m.name))) {
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

let ran = 0;
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
  if (prior) {
    console.log(`  ·  ${m.name}  already applied`);
    skipped++;
    continue;
  }
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
    console.log(`  →  ${m.name}  would apply (${m.sha})`);
    ran++;
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
console.log(`\n${verb} ${ran}, skipped ${skipped}${drifted ? `, DRIFTED ${drifted}` : ""}`);

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
