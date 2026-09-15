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
 * transaction with a lock timeout (LOCK_TIMEOUT_S); recorded rows stay as they are, pending
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
 *
 * 021's evidence backfill — the one statement in the set that writes DATA from
 * a rule over other data, hashed and applied as written before SMD-1067 made an
 * operator's ACCEPTANCE of a failure a succeeded claim row — runs here with the
 * acceptances out of its sight, on a plain run or a re-run: a view of the claim
 * table without them shadows the real one for that file alone, so the block
 * labels from the latest row that is not an acceptance, or not at all. See
 * applyShadowed (SMD-1421). The session sets one lock_timeout, LOCK_TIMEOUT_S
 * (config.mjs), for everything the migrator does, so a held lock fails the run
 * rather than freezing it and every reader behind it.
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  ACCEPTED_CLAIM_SQL,
  LOCK_TIMEOUT_S,
  alignVectorSearchPath,
  migrationNameProblem,
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
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 001_, 002_, … lexical order is the intended order
  // The number is the file's identity — the order, and how prose names a file
  // — so every file carries one and two files may not share it: `021.sql`
  // would sort before `021_…` and run at its number, and a second 021_*.sql
  // sorting first would run before the one it collides with. The rule is
  // config.mjs's, shared with the fork checker, which refuses where the
  // collision is made.
  const problem = migrationNameProblem(names);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  return names.map((name) => {
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
 * The file whose evidence backfill runs with the acceptances out of its sight
 * — by its whole name, as test-schema pins 030's: the number alone would find
 * any 021_*.sql. See applyShadowed.
 */
const FILE_021 = "021_embedding_model_per_row.sql";
if (!migrations.some((m) => m.name === FILE_021)) {
  console.error(`${FILE_021} is not in the set: it is the file whose evidence backfill the migrator shadows the claim table for, by its whole name — a renamed or renumbered file would run bare, reading the acceptances.`);
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
// One lock_timeout for the session — the checks' reads before a re-run, the
// ledger reads below — and again, LOCAL, inside every transaction (begin): a
// held lock fails the run rather than freezing it and every reader behind it.
// The session setting alone would not do: through a transaction-mode pooler
// it may be another server connection's by the time a transaction opens, and
// the bound must hold where the locks are taken. (A pooled URL is not the
// migrator's — README §5 says so: the search_path it aligns is session state
// too.) 023's call sets its own, locally, for its transaction.
await sql.unsafe(`SET lock_timeout = '${LOCK_TIMEOUT_S}s'`);
/** A transaction with the run's lock_timeout set inside it, as its first statement. */
const begin = <T>(fn: (tx: SQL) => Promise<T>): Promise<T> =>
  sql.begin(async (tx: SQL) => {
    await tx.unsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_S}s'`);
    return fn(tx);
  }) as Promise<T>;

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
 * is a lock_timeout — LOCK_TIMEOUT_S, the session's (023's call sets its own
 * for its transaction). 40P01 (deadlock_detected) is the server choosing a victim
 * between two sessions taking the same tables in opposite orders — the
 * re-run's locks and a worker's start, which the banner says to stop first;
 * the victim may be the worker instead, and then this run goes on. What
 * follows a failure differs by mode: a plain run
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
  } else if (sqlstate === "40P01") {
    lines.push(
      "  A deadlock: another session took the same tables in the other order while this ran — a worker's enqueue, or a re-embed pass's start,\n" +
        "  against the locks the run takes. Stop the workers and the server, then run again."
    );
  } else if (sqlstate === "55P03") {
    lines.push(
      mode === "reapply"
        ? `  A lock was not granted within the run's ${LOCK_TIMEOUT_S} s lock_timeout: a session holds one on a table the re-run alters — the server, a worker, or an idle transaction. End it first.`
        : mode === "checks"
          ? `  A lock was not granted within the run's ${LOCK_TIMEOUT_S} s lock_timeout, on the checks' reads before it: a session holds an exclusive lock on ob1_config — an idle transaction that altered it. End it first.`
          : `  A lock was not granted within the run's ${LOCK_TIMEOUT_S} s lock_timeout (023's call sets its own for its transaction): a session holds one on a table this migration alters — the server, a worker, or an idle transaction. End it first.`
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

/** A search_path entry naming the temp schema, quoted or not. */
const PG_TEMP_ENTRY = /^"?pg_temp"?$/i;

/** search_path's entries: split on the commas outside double quotes, since a quoted schema name may hold one. */
function searchPathEntries(path: string): string[] {
  const out: string[] = [];
  let entry = "";
  let quoted = false;
  for (const ch of path) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(entry.trim());
      entry = "";
    } else entry += ch;
  }
  if (entry.trim()) out.push(entry.trim());
  return out;
}

/**
 * Run one migration's SQL in the caller's transaction — and 021's with the
 * operator's acceptances out of its sight (SMD-1421). 021's evidence backfill
 * labels an unlabelled thought from its latest succeeded claim row under a key
 * naming a model, when nothing has written the thought since the row finished;
 * the file is hashed and applied as written, from before SMD-1067 made an
 * operator's ACCEPTANCE of a failure a succeeded row — a thought that kept the
 * vector it had, by decision NOT at that key's model. Migration 030 takes such
 * a label back where it can tell it from the server's own (an acceptance under
 * the model's own key, and nothing written since the row's enqueue) and labels
 * the rest with accepted rows excluded — but 030 is a file too, applied once
 * and hashed, and cannot know which labels 021's block wrote a moment ago.
 *
 * The fix is at the block's INPUT, not its output. Before 021 runs, a TEMP
 * VIEW named thought_work_claims is created over the real table without the
 * accepted rows (ACCEPTED_CLAIM_SQL, the predicate 030's evidence rows carry)
 * — a view, not a copy: one catalog row, no rows materialised, and the block
 * reads the claim rows as they stand when it runs, through the filter, so no
 * window opens between a copy and the block (the seventh review pass measured
 * the copy at ~15 MB per 200k rows and found the window). An unqualified name
 * resolves in pg_temp before any schema on the search_path, and 021's block is
 * a DO block, resolved when it runs — so it reads the view, and labels from
 * the latest row that is NOT an acceptance, or not at all: 030's rule, by
 * 021's own text, with no second spelling and nothing wrong ever written. The
 * view is dropped right after the file, in the same transaction (a failure
 * rolls it back with everything else), so 022 onward — 029's function, 030's
 * block — read the real table again. pg_temp is searched first for
 * relations exactly when the path does NOT list it: listed, it is searched
 * where listed, and listed first it is also where CREATE puts things,
 * functions included — 021's update_thought landed there and vanished with the
 * transaction when the fifth review pass tried naming it first — so a role's
 * path is set, for the transaction, to itself without pg_temp (a quoted name
 * may hold a comma, so the split minds quotes) — a no-op where it is absent,
 * and not restored: unlisted, pg_temp is still searched first and is never a
 * creation target, so nothing after 021 differs — and that the name resolves
 * to the view is checked before the file runs,
 * and the file is refused if not. Creation targets are then unaffected: 021's
 * column and functions go where they went. The view takes ACCESS SHARE on the
 * claim table when the block reads it, as 021's block did, and nothing on
 * thoughts before 021's own ADD COLUMN — no lock the file alone never took,
 * and no order a worker's enqueue inverts. Needs TEMP on the database (023's
 * backfill call does too), judged before any SQL runs. Where the claim table
 * is missing, the file runs bare and fails on it as it always did; where a
 * temp relation of that name already exists on the connection — a pooled
 * connection handed over with one — the file is refused, since the block
 * would read it (asked of pg_temp by name, whatever the search_path). The view
 * projects the four columns the block reads. The tie 030 breaks by key is
 * 021's unnamed pick here, and a label from before
 * 021 that 030's first statement would take back — a paste of the body over an
 * acceptance — waits for 030's own run, which on a hole at 021 alone is the
 * re-run.
 *
 * Reports how many thoughts the block labelled — the rows its one UPDATE of
 * thoughts touched, read from the transaction's own statistics
 * (pg_stat_xact_user_tables, before and after; "not counted" where
 * track_counts is off), so nothing here reads thoughts and no lock is taken on
 * it before the file's own (the sixth review pass found a count(*) taking
 * ACCESS SHARE ahead of the ALTER's ACCESS EXCLUSIVE, the upgrade the first pass
 * had removed) — since the label is not an edit and nothing else records the
 * write. Returns the line to print beside the file, null for any other file.
 * Four review passes bracketed 021's OUTPUT instead — a snapshot of the
 * unlabelled ids, a set-back under a held trigger, 030's rule run after — and
 * each pass found a seam in the bracket; the fifth proposed the shadow and
 * verified it against 021's block. This replaced, in turn, a gate that refused
 * the run on the rows 021 would label and 030 would leave, and printed a way
 * back that spent the acceptance (SMD-1193) — 030's header, hashed, still
 * describes the gate.
 */
async function applyShadowed(tx: SQL, m: Migration): Promise<string | null> {
  if (m.name !== FILE_021) {
    await tx.unsafe(m.sql);
    return null;
  }
  // Catalog reads only: no lock on thoughts before the file's own ADD COLUMN.
  const [{ nsp, stale, path, counted }] = (await tx`
    SELECT (SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('thought_work_claims')) AS nsp,
           to_regclass('pg_temp.thought_work_claims') IS NOT NULL AS stale,
           current_setting('search_path') AS path,
           current_setting('track_counts') = 'on' AS counted`) as { nsp: string | null; stale: boolean; path: string; counted: boolean }[];
  if (stale) {
    // Not ours: nothing here creates one before this point, and a pooled
    // connection handed over with one is not a state to read the block from.
    throw new Error("a temp relation named thought_work_claims already exists on this connection; 021's backfill would read it in place of the claim table. Drop it and run again");
  }
  if (nsp === null) {
    await tx.unsafe(m.sql);
    return null;
  }
  // The rows 021's one UPDATE of thoughts touches, from the transaction's own
  // statistics: O(1), visible before commit, and no read of thoughts.
  const updated = async () => Number(((await tx`SELECT n_tup_upd AS n FROM pg_stat_xact_user_tables WHERE relid = to_regclass('thoughts')`) as { n: number }[])[0]?.n ?? 0);
  const before = await updated();
  // The four columns the block reads (021:214-217), over the source named by
  // its schema — once the view exists, an unqualified name is the view.
  await tx.unsafe(
    `CREATE TEMP VIEW thought_work_claims AS SELECT c.thought_id, c.work_type, c.status, c.finished_at FROM ${quoteIdent(nsp)}.thought_work_claims c WHERE NOT ${ACCEPTED_CLAIM_SQL}`
  );
  // pg_temp first for relations exactly when unlisted: the path, for the
  // transaction, without it — a no-op where it is absent, never added first
  // (see above), not restored (nothing after 021 differs).
  await tx`SELECT set_config('search_path', ${searchPathEntries(path).filter((e) => !PG_TEMP_ENTRY.test(e)).join(", ")}, true)`;
  const [{ shadowed }] = (await tx`SELECT to_regclass('thought_work_claims') = 'pg_temp.thought_work_claims'::regclass AS shadowed`) as { shadowed: boolean }[];
  if (!shadowed) {
    throw new Error(`the view of thought_work_claims without the acceptances does not shadow the table for 021 (search_path: ${path}); its backfill would have read them`);
  }
  await tx.unsafe(m.sql);
  await tx.unsafe("DROP VIEW pg_temp.thought_work_claims");
  // At zero too: a silent 021 is also what a claim table not found, or an
  // older migrator, prints. The label is not an edit, and nothing else
  // records the write.
  return counted
    ? `  ·  021's evidence backfill labelled ${(await updated()) - before} thought(s) from the claim rows, the operator's acceptances out of its sight`
    : "  ·  021's evidence backfill ran with the operator's acceptances out of its sight; what it labelled is not counted (track_counts is off)";
}

// ── Judged before any SQL runs ──────────────────────────────────────────────
// Every refusal, in one list with one tail — both modes, "would refuse" under
// --dry-run — so a green dry run is never followed by a red run and every
// refusal is reported, not the first. What 021's shadow needs: a temp table,
// which a hardened database may deny the role (023's backfill call needs one
// too, and orders after 021, so a fresh upgrade meets the need here first).
// Then the re-run's own judgements, below.
const refusals: { code: number; text: string }[] = [];
const shadows021 = !baseline && (reapply || !applied.has(FILE_021));
if (shadows021) {
  const [{ temp }] = (await sql`SELECT has_database_privilege(current_database(), 'TEMP') AS temp`) as { temp: boolean }[];
  if (!temp) {
    const [{ db, role }] = (await sql`SELECT current_database() AS db, current_user AS role`) as { db: string; role: string }[];
    refusals.push({
      code: 2,
      text:
        `this role may not create a temp relation, and 021's evidence backfill needs one — a view of the claim table without the operator's acceptances,\n` +
        `  for that file to read — as 023's backfill call does. GRANT TEMPORARY ON DATABASE ${quoteIdent(db)} TO ${quoteIdent(role)}; then run again.`,
    });
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
// before BEGIN, into the one list above: the drift, the pgvector floor, and
// the two things 006 would do inside the transaction from a shell configured
// differently from the brain — refuse the column's width, or re-record
// ob1_config's model (its INSERT … ON CONFLICT DO UPDATE, run again).
// The session's lock_timeout (LOCK_TIMEOUT_S) bounds every wait, so an idle session holding a
// lock on thoughts fails the re-run at once rather than freezing every reader
// behind 001's ACCESS EXCLUSIVE for ever — the banner says to stop the writers
// first. The seeds check runs after the commit for every file that seeds, as on
// a first apply. 021's evidence backfill runs as written, the acceptances out
// of its sight (applyShadowed), as on a plain run.
if (reapply) {
  const changed = migrations.filter((m) => reapplies(m) && applied.get(m.name) !== m.sha);
  if (changed.length > 0) {
    refusals.push({
      code: 1,
      text:
        `${changed.map((m) => `${m.name} (was ${applied.get(m.name)}, now ${m.sha})`).join(", ")} changed after being applied.\n` +
        "  Migrations are append-only. If the edit was intentional and the database already reflects it, update schema_migrations.sha256 by hand, then re-run.",
    });
  }
  const floor = migrations.find((m) => tooOldFor(m));
  if (floor) refusals.push({ code: 1, text: `${floor.name} would fail on the pgvector floor.` + floorMessage(floor, true) });
  // The catalog, read by relation (to_regclass) rather than by name in
  // information_schema, which sees a `thoughts` in any schema the role can
  // read. Both reads are guarded: a role without SELECT on ob1_config is a
  // refusal that names the error, not a stack trace with the connection open.
  let probe: { has_config: boolean; width: number | null };
  let record: Record<string, string> = {};
  try {
    // The read of ob1_config takes ACCESS SHARE; behind a session holding
    // ACCESS EXCLUSIVE on it, it waits — the session's lock_timeout bounds it.
    [probe] = (await sql`
      SELECT to_regclass('ob1_config') IS NOT NULL AS has_config,
             (SELECT atttypmod FROM pg_attribute WHERE attrelid = to_regclass('thoughts') AND attname = 'embedding' AND NOT attisdropped) AS width`) as
      { has_config: boolean; width: number | null }[];
    if (probe.has_config) {
      const rows = (await sql`SELECT key, value::text AS value FROM ob1_config WHERE key IN ('embedding_model')`) as { key: string; value: string }[];
      record = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    }
  } catch (err) {
    console.error(`  ✗  --reapply  could not be judged: ${(err as Error).message}`);
    for (const line of explainFailure(err, null, "checks")) console.error(line);
    console.error("  The checks before the run read pg_attribute and ob1_config; this role could not, or was made to wait. Nothing was written.");
    await sql.close();
    process.exit(1);
  }
  const { has_config, width } = probe;
  // The column is the width's authority (ob1_config's copy can be edited by
  // hand); 006 refuses a shell whose width differs from it — inside the
  // transaction, after a dry run had said green. Judged here, both modes.
  if (width !== null && Number(width) <= 0) {
    // pgvector allows a bare `vector` column (atttypmod -1); 006 requires the
    // declared width, so the re-run would refuse inside the transaction.
    refusals.push({
      code: 2,
      text:
        "thoughts.embedding declares no width (a bare vector column) and 006 requires vector(OB1_EMBEDDING_DIM), so the re-run would\n" +
        `  refuse inside the transaction. Declare it first — ALTER TABLE thoughts ALTER COLUMN embedding TYPE vector(${SUBSTITUTIONS.EMBEDDING_DIM}); — with\n` +
        "  every stored vector at that width.",
    });
  } else if (width !== null && Number(width) !== Number(SUBSTITUTIONS.EMBEDDING_DIM)) {
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
  if (has_config && "embedding_model" in record && record.embedding_model !== SUBSTITUTIONS.EMBEDDING_MODEL) {
    refusals.push({
      code: 2,
      text:
        `ob1_config records embedding_model = ${record.embedding_model} and this shell would re-record it as ${SUBSTITUTIONS.EMBEDDING_MODEL} —\n` +
        "  006 writes its INSERT … ON CONFLICT DO UPDATE again on a re-run, and every reader of the record would follow the shell.\n" +
        "  Run from a shell configured as the brain is (OB1_EMBEDDING_MODEL), or change the record on purpose with\n" +
        "  reembed.ts --switch-model, which moves the corpus with it.",
    });
  }
}
if (refusals.length) {
  for (const r of refusals) console.error(`\n  ${dryRun ? "would refuse" : "refusing"} ${reapply ? "--reapply" : `to apply ${FILE_021}`}: ${r.text}`);
  console.error(`\n  Nothing was written.`);
  await sql.close();
  process.exit(Math.max(...refusals.map((r) => r.code)));
}
// Announced only once nothing refuses: a banner before a refusal read as a
// run that never began.
if (reapply) {
  const recorded = migrations.filter(reapplies).length;
  console.log(
    `  ${dryRun ? "would re-apply" : "re-applying"} every migration (${recorded} recorded, ${migrations.length - recorded} pending), in order, in one transaction with a ${LOCK_TIMEOUT_S} s lock timeout —\n` +
      "  recorded rows stay as they are, pending ones are recorded. Stop the server and any re-embed or extraction worker first:\n" +
      "  001 and 003 take ACCESS EXCLUSIVE locks on thoughts, 011 builds the trigram index if OB1_TRGM_INDEX is on and it is absent,\n" +
      "  023's backfill call locks thoughts (OB1_BACKFILL_LIMIT bounds it, as on a first apply), 025 re-validates its constraints."
  );
}

if (reapply && !dryRun) {
  // An object, not a `let`: an assignment inside the callback is invisible to
  // the type checker's flow analysis, which would narrow a `let` to null.
  const progress: { current: Migration | null } = { current: null };
  /** What a file said beside its line, by name — 021's, with the acceptances out of its sight. */
  const notes = new Map<string, string>();
  try {
    await begin(async (tx: SQL) => {
      for (const m of migrations) {
        progress.current = m;
        const note = await applyShadowed(tx, m);
        if (note !== null) notes.set(m.name, note);
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
    if (notes.has(m.name)) console.log(notes.get(m.name));
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
    const note = await begin(async (tx: SQL) => {
      const n = await applyShadowed(tx, m);
      await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha})`;
      return n;
    });
    console.log(`  ✓  ${m.name}  applied`);
    if (note !== null) console.log(note);
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
