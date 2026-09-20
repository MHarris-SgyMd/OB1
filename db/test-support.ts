/**
 * test-support.ts — the scaffolding every database-backed suite was rewriting.
 *
 * Nine files reset the schema, six applied migrations, eight defined the same
 * `assert`. That is not merely repetitive: when migration 007 added
 * `thought_chunks`, the reset had to change in nine places, and `DROP TABLE
 * thoughts CASCADE` drops the foreign-key constraint rather than the dependent
 * table — so a suite that missed the new line left a stale chunk table at the
 * previous suite's vector width, and the next suite died on a dimension mismatch.
 * That failure was invisible locally, where each run gets a fresh container, and
 * only appeared in CI, where one Postgres is shared across every step.
 *
 * One definition means the next table added here is added once.
 */

import { SQL } from "bun";
import { alignVectorSearchPath, DEFAULT_CHUNK_CONTEXT, DEFAULT_TRGM_INDEX, HNSW_BOUNDS, MATCH_THOUGHTS_SIGNATURE, SEARCH_THOUGHTS_HYBRID_SIGNATURE, SUPERSEDED_SIGNATURES, UPDATE_THOUGHT_SIGNATURE, grantedTables, migrationValues, quoteIdent, substituteMigration } from "./config.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "migrations");

/** bench-hnsw.ts's kept-corpus marker table (SMD-1493): the bench writes and reads it by this name, the reuse suite plants and drops its own, and `dropSchema` refuses a database holding one. */
export const BENCH_MARKER = "bench_hnsw_corpus";
/** Whether the database holds the marker table — the one probe the bench, the reuse suite and `dropSchema` share. */
export async function hasKeptCorpus(sql: SQL): Promise<boolean> {
  const [{ has }] = await sql`SELECT to_regclass(${BENCH_MARKER}) IS NOT NULL AS has`;
  return Boolean(has);
}

/**
 * Every table the schema owns, in drop order — dependents first. `thoughts` is
 * dropped CASCADE, which removes constraints pointing AT it but not the tables
 * holding them, so anything with a foreign key has to be named before it.
 */
const TABLES = [
  "thought_facets",
  "thought_audit",
  "thought_chunks",
  "thought_work_claims",
  "supersession_proposals",
  "ob1_entity_edges",
  "thought_entities",
  "ob1_entities",
  "thoughts",
  "ob1_agent_keys",
  "ob1_agents",
  "schema_migrations",
  "ob1_config",
  // bench-hnsw.ts's kept-corpus marker (SMD-1493): dropped with the schema it
  // vouches for, so a suite run in a kept database cannot leave a marker over
  // rows that are gone.
  BENCH_MARKER,
  // The community schemas' tables (SMD-1796): test-live [18] applies every
  // schemas/*.sql to the migrated brain, and a reset that left them would hand
  // the next run tables whose foreign keys to `thoughts` the CASCADE above cut.
  // Their bigserial sequences go with them; their functions stay (CREATE OR
  // REPLACE re-applies cleanly, and none is a migration's). thought_audit and
  // thought_entities are above already; the view is not a table and goes with
  // `thoughts`. They follow `thoughts` although several reference it: the
  // CASCADE above has already cut those constraints by the time they drop.
  ...grantedTables(["community"]).filter((t) => t !== "thought_audit" && t !== "thought_entities"),
];

/**
 * Functions the schema owns, by signature. `CREATE OR REPLACE` masks a stale one
 * most of the time, which is exactly why this list is easy to let rot: db/test-live
 * dropped three overloads of `upsert_thought` and never learned about the 4-argument
 * form migration 007 added, so a "reset" left it behind. Dropping is part of owning
 * the schema, not a special case for one suite.
 *
 * `vector` needs no dimension here — a typmod is not part of the signature Postgres
 * matches on, so one entry covers every width the column has ever been.
 */
const FUNCTIONS = [
  UPDATE_THOUGHT_SIGNATURE,
  // 042 dropped the two-argument form for the three-argument one; both named,
  // so a reset after a partial apply leaves neither behind.
  "delete_thought(uuid, jsonb)",
  "delete_thought(uuid, jsonb, boolean)",
  "thought_audit_refuse_mutation()",
  "thoughts_write_audit()",
  "ob1_current_actor()",
  "resolve_agent(text, text, text)",
  "revoke_agent_key(text, text)",
  "upsert_thought(text, jsonb)",
  "upsert_thought(text, jsonb, vector)",
  "upsert_thought(text, jsonb, vector, jsonb)",
  // The shipped signatures and the ones 020 and 021 dropped: a bench's "before"
  // arm re-creates the old search forms and test-schema [22] re-applies 018, and
  // a reset that left one behind would hand the next section an ambiguous call.
  MATCH_THOUGHTS_SIGNATURE,
  "recency_score(float, timestamptz, float, float)",
  ...SUPERSEDED_SIGNATURES,
  "search_thoughts_keyword(text, int, int, jsonb)",
  "update_updated_at()",
  "enqueue_thoughts(text, uuid[])",
  "claim_thoughts(text, text, int, int, int)",
  "release_thought(uuid, text, text, text, text)",
  "release_claims_for_worker(text, text)",
  "renew_claims(text, text, int)",
  "normalize_entity_name(text)",
  "content_fingerprint_of(text)",
  "backfill_content_fingerprints(integer)",
  "record_thought_entities(uuid, text, jsonb, jsonb, text, uuid)",
  "merge_entities(uuid, uuid)",
  "prune_orphan_entities()",
  "requeue_thought_work(text, uuid)",
  "thoughts_enqueue_entity_extraction()",
  SEARCH_THOUGHTS_HYBRID_SIGNATURE,
  "extract_search_needles(text)",
  // 029 (SMD-1294)
  "consolidation_candidates(uuid, int, float)",
  "record_supersession_proposal(uuid, uuid, text, numeric, text, float, text, uuid, text, text)",
  "review_supersession_proposal(uuid, text, text, text, jsonb, boolean)",
  "list_supersession_proposals(text, int)",
  "consolidation_pool(text)",
  "stale_entities(interval, int)",
  // 032 (SMD-1323)
  "validate_derived_from(jsonb)",
  // 042 (SMD-1712)
  "thought_facets_validate()",
  "thoughts_guard_citation_sources()",
  "thought_facet_active(thought_facets)",
  "record_citation(uuid, uuid, text, text)",
];

export type SchemaOptions = {
  /** Vector width to substitute for `{{EMBEDDING_DIM}}`. */
  dim: number;
  /** Model name to substitute for `{{EMBEDDING_MODEL}}`. */
  model: string;
  /** Apply only these migrations, by filename prefix. Defaults to all of them. */
  only?: (name: string) => boolean;
  /**
   * Build the trigram index in 011. Defaults to `DEFAULT_TRGM_INDEX`, so most
   * suites exercise the schema a stock deployment gets. Read from config rather
   * than written as a literal here: SMD-944 flipped that default from off to on
   * and a hardcoded copy would have silently kept the old one, which is the
   * defined-twice failure this fork keeps removing.
   */
  trgm?: boolean;
  /** Rows migration 023's call writes: NULL (every row) unless a suite asks for a batch. Pinned so the shell's OB1_BACKFILL_LIMIT cannot change what a suite applies. */
  backfillLimit?: number | null;
  /**
   * The heap size, in pages, under which the routing gate (037; its sample
   * drawn by TID range since 038) does not run before the routing count. The
   * shipped floor (ROUTE_ESTIMATE_MIN_PAGES) is 64 MB of heap; a suite that
   * wants the gate on a table of a few thousand rows applies the last definer
   * with 0 and restores the default afterwards.
   */
  routeEstimateMinPages?: number;
};

/**
 * Substitute the template placeholders. Applying a migration raw fails.
 *
 * Delegates to config.mjs rather than doing its own replacements. The version
 * here was two hardcoded `.replace()` calls, which cannot fail on a variable it
 * does not know about — it leaves `{{TRGM_INDEX}}` in the SQL and Postgres
 * reports a syntax error with no hint where it came from. The shared one throws
 * by name.
 */
export function substitute(sql: string, opts: SchemaOptions): string {
  // chunkContext pinned to the default as trgm is: 013 records it into
  // ob1_config, and a fixture applied bare here and through migrate.ts (whose
  // shell migratorEnv strips) must not disagree by which helper applied it.
  return substituteMigration(
    sql,
    migrationValues({ dim: opts.dim, model: opts.model, trgm: opts.trgm ?? DEFAULT_TRGM_INDEX, chunkContext: DEFAULT_CHUNK_CONTEXT, backfillLimit: opts.backfillLimit ?? null, routeEstimateMinPages: opts.routeEstimateMinPages })
  );
}

/** The deliberate overrides of the loopback rule below, named once so a suite that spawns another checked script can pass them on. */
export const REMOTE_DB_FLAGS = ["OB1_ALLOW_REMOTE_DB", "OB1_EVAL_ALLOW_REMOTE_DB"] as const;

/**
 * Refuse to drop a database that is not obviously a throwaway.
 *
 * Every suite and bench in this repo resets the schema, and two of them then
 * load internal engineering data into what they cleared. Pointed at anything
 * real by a stale `DATABASE_URL` in a shell, one command destroys that database
 * with no prompt. The check lives in `dropSchema` so every caller that goes
 * through it inherits it; the one eval that drops tables on its own calls it
 * directly.
 *
 * "Throwaway" means LOOPBACK. Not "local enough to skip a credential": the
 * fifth review pass suggested sharing
 * preflight's `isLocalHostname`, which accepts RFC1918 addresses, the container
 * aliases and compose service names, and the sixth caught what that widened —
 * a LAN-hosted stack at 192.168.x.x holding a real database is the documented
 * deployment topology, and a stale DATABASE_URL to it would have been dropped
 * without a prompt. The two questions have different answers. An EMPTY host is
 * refused rather than trusted: Bun's SQL client resolves `postgres:///db`
 * through PGHOST, exactly as libpq does, so an empty hostname is whatever the
 * shell says it is. IPv6 loopback is `[::1]` as WHATWG URL reports it. A
 * libpq-style socket URL (`postgres://u@/db?host=/var/run/...`) does not parse
 * and is refused; the client does not honour that form either, so the override
 * is the way through for it.
 *
 * `OB1_ALLOW_REMOTE_DB=1` is the deliberate override, which is a thing you have
 * to mean. `OB1_EVAL_ALLOW_REMOTE_DB=1`, the name the eval-local copy used, is
 * honoured too so a shell profile that set it keeps working.
 */
export function assertThrowawayDatabase(url: string): void {
  if (REMOTE_DB_FLAGS.some((flag) => process.env[flag] === "1")) return;
  let host: string | null = null;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* unparseable: refuse below */
  }
  const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
  if (host !== null && LOOPBACK.has(host)) return;
  const shown = host === null ? "an unparseable URL" : host === "" ? "a URL with no host (the client would resolve PGHOST)" : host;
  console.error(
    `  Refusing to drop the schema at ${shown}.\n\n` +
      `  This command DROPS every table Open Brain owns in that database. That is\n` +
      `  safe against a throwaway container and destructive against anything else.\n` +
      `  Run it under db/with-postgres.sh, name a loopback host explicitly, or set\n` +
      `  OB1_ALLOW_REMOTE_DB=1 if you are certain.`
  );
  process.exit(2);
}

/**
 * Drop every table and function the schema owns.
 *
 * Separate from applying, because one suite legitimately needs to observe the
 * empty state in between: test-preflight asserts that an un-migrated database
 * exits 1 before it migrates. Composing two exported steps beats an option that
 * exists for a single caller.
 */
export async function dropSchema(url: string): Promise<void> {
  assertThrowawayDatabase(url);
  const admin = new SQL({ url, max: 1 });
  try {
    // A kept bench corpus (SMD-1493) is thirty minutes of build behind a
    // marker; a suite run under the same OB1_PG_KEEP name would drop it here
    // with no word. The bench itself never reaches this with a marker present
    // (it reuses or refuses first), so a marker here means another caller.
    if ((await hasKeptCorpus(admin)) && process.env.OB1_DROP_KEPT_CORPUS !== "1") {
      throw new Error(`this database holds a kept bench-hnsw corpus (${BENCH_MARKER}); a schema reset would drop it. Run this suite without OB1_PG_KEEP, or set OB1_DROP_KEPT_CORPUS=1 to drop the corpus deliberately.`);
    }
    for (const t of TABLES) await admin.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
    for (const f of FUNCTIONS) await admin.unsafe(`DROP FUNCTION IF EXISTS ${f}`);
    // 014 seeds two database-level settings. They are not schema, so a fresh
    // start must clear them too, or every later run inherits whatever the
    // previous one left. Best effort: only the owner may, and a throwaway
    // container's role is. The RESET names hnsw.* settings, which a
    // non-superuser may touch only once pgvector is loaded in the session —
    // dropping the HNSW indexes above loads it incidentally, but not when the
    // tables were already gone — so load it explicitly first.
    try {
      await admin`SELECT '[1]'::vector`;
      const [{ db }] = await admin`SELECT current_database() AS db`;
      for (const bound of HNSW_BOUNDS) await admin.unsafe(`ALTER DATABASE ${quoteIdent(db)} RESET ${bound}`);
    } catch {
      /* not the owner of the database, or no pgvector to load — left as found */
    }
  } finally {
    await admin.close();
  }
}

/**
 * Apply the migrations, substituting the templates — bare: 021's evidence
 * backfill reads the real claim table here, the operator's acceptances
 * included, where migrate.ts runs it with a view without them (applyShadowed,
 * SMD-1421). A fixture that plants an acceptance before 021 and applies 021
 * through this gets 021's labels as written, not the migrator's; plant after,
 * or run migrate.ts through runScript, as test-upgrade [7] and [11] do.
 */
export async function applyMigrations(url: string, opts: SchemaOptions): Promise<void> {
  const admin = new SQL({ url, max: 1 });
  try {
    // Same self-heal migrate.ts does: if pgvector is off this session's
    // search_path (test-search-path.ts puts it there deliberately), add its
    // schema so 001's bare `vector({{EMBEDDING_DIM}})` resolves. A no-op on the
    // normal container, where pgvector installs into public.
    await alignVectorSearchPath(admin);
    const files = migrationFiles().filter((f) => opts.only?.(f) ?? true);
    for (const f of files) {
      await admin.unsafe(substitute(readFileSync(join(MIGRATIONS, f), "utf8"), opts));
    }
  } finally {
    await admin.close();
  }
}

/**
 * A row from before 003, or loaded around upsert_thought: NULL fingerprint, the
 * vector and created_at given. test-live [6c] and test-upgrade [6] planted it
 * verbatim (fourth review pass of SMD-1042).
 */
export async function plantLegacyRow(sql: SQL, content: string, vector: string, createdAt: string | null): Promise<string> {
  return (await sql`INSERT INTO thoughts (content, content_fingerprint, embedding, created_at) VALUES (${content}, NULL, ${vector}::vector, ${createdAt}::timestamptz) RETURNING id`)[0].id as string;
}

/**
 * 001's updated_at trigger's state from pg_trigger: 'O' is enabled. A backfill
 * that holds the trigger must leave it so, and three sections asked the
 * catalog the same way.
 */
export async function updatedAtTriggerState(sql: SQL): Promise<string> {
  return String((await sql`SELECT tgenabled AS e FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND tgname = 'thoughts_updated_at'`)[0].e);
}

/** The common case: drop everything, then apply from scratch. */
export async function resetSchema(url: string, opts: SchemaOptions): Promise<void> {
  await dropSchema(url);
  await applyMigrations(url, opts);
}

/**
 * Move pgvector into `schema`, off the database's default search_path, to
 * reproduce how Supabase and several managed providers ship it (SMD-1247). The
 * throwaway container installs it into `public`, on the path; this relocates it
 * so `to_regtype('vector')` returns NULL for a session that does not add the
 * schema. Call after dropSchema, so no table's column depends on the type mid-move.
 *
 * Leaves the database-level search_path untouched (still `"$user", public`), so
 * a fresh connection genuinely cannot resolve `vector` — that is the condition
 * under test. `restoreVectorToPublic` undoes it, which ci-parity.sh needs since
 * one Postgres is shared across suites.
 */
export async function relocateVectorTo(url: string, schema: string): Promise<void> {
  const admin = new SQL({ url, max: 1 });
  try {
    await admin.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await admin.unsafe(`ALTER EXTENSION vector SET SCHEMA ${quoteIdent(schema)}`);
  } finally {
    await admin.close();
  }
}

/** Undo relocateVectorTo: pgvector back in public, any database search_path we set cleared. */
export async function restoreVectorToPublic(url: string): Promise<void> {
  const admin = new SQL({ url, max: 1 });
  try {
    const [{ db }] = await admin`SELECT current_database() AS db`;
    await admin.unsafe(`ALTER EXTENSION vector SET SCHEMA public`);
    await admin.unsafe(`ALTER DATABASE ${quoteIdent(db)} RESET search_path`);
  } finally {
    await admin.close();
  }
}

/**
 * The one form `store.ts`'s `isoTimestamp` emits for a finite timestamp —
 * `Date.prototype.toISOString`, always three fraction digits and `Z`. Both
 * store suites assert against this, not a hand-copied regex or `endsWith("Z")`,
 * so the two hold the same contract on the shared normalisers' output.
 */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A counting assert. Returned as an object rather than module state so two suites
 * in one process cannot pollute each other's tally — and so `report()` owns the
 * exit code, which every suite was also duplicating.
 */
export function createAssert(): {
  assert: (cond: unknown, label: string) => void;
  /**
   * Record a case that could not run. Distinct from a pass on purpose: a suite
   * that silently counts an unrunnable case as green is worse than one that fails,
   * because it reports confidence it does not have. Only the report line shows it.
   */
  skip: (label: string, reason?: string) => void;
  report: () => never;
} {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  return {
    assert(cond: unknown, label: string): void {
      if (cond) {
        console.log(`  ✓  ${label}`);
        passed++;
      } else {
        console.error(`  ✗  ${label}`);
        failed++;
      }
    },
    skip(label: string, reason?: string): void {
      console.log(`  ·  ${label}${reason ? ` (${reason})` : ""}`);
      skipped++;
    },
    report(): never {
      console.log(`\n${"─".repeat(52)}`);
      console.log(
        `${passed + failed} assertions: ${passed} passed, ${failed} failed` +
          (skipped ? `, ${skipped} skipped` : "")
      );
      console.log(failed > 0 ? "FAIL\n" : "PASS\n");
      process.exit(failed > 0 ? 1 : 0);
    },
  };
}

/** The DATABASE_URL check every suite opens with. */
/**
 * A stub provider's answer that never comes: the request stays open until the
 * client's own deadline (OB1_LLM_TIMEOUT) abandons it. Two things follow for
 * the test: the stub decides WHICH request hangs from its body, since a
 * hanging window would fail a long capture where a hanging whole-content call
 * only degrades it; and the stub is stopped with `stop(true)`, because the
 * handler is still pending when the test ends.
 */
export function neverAnswers(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * Run a script as a subprocess and collect its exit code with everything it
 * printed, stdout then stderr — so a suite observes the real exit code, and an
 * assertion can read a message whichever stream it went to. Five suites had
 * written this body (SMD-1024's second review pass counted). `env` replaces
 * the inherited environment when given; a caller that wants the parent's plus
 * a few builds that object itself.
 */
export async function runScript(cmd: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<{ code: number; out: string }> {
  // A child given its own environment gets exactly that: Bun loads the cwd's
  // .env into a child for every variable the passed environment lacks — which
  // after a fixture's strip is every OB1_* name, and db/.env is where a
  // migrator-only flag is documented to live — so `--no-env-file` rides on
  // every `bun` spawn that passes an env (review passes, reproduced) — a
  // spawn whose command IS bun, by basename, so a binary spelled by path
  // gets the flag too; a spawn fronted by another program spells it itself.
  const argv = opts.env && basename(cmd[0]) === "bun" ? [cmd[0], "--no-env-file", ...cmd.slice(1)] : cmd;
  const p = Bun.spawn(argv, { ...(opts.env ? { env: opts.env } : {}), stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

/** This process's environment with every `OB1_*` variable removed — the allowlist `migratorEnv` and test-bench-reuse.ts build their spawns' shells on. */
export function shellWithoutOb1(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("OB1_")) env[k] = v;
  return env;
}

/**
 * The migrator's shell for a fixture: this process's environment with every
 * `OB1_*` variable REMOVED — an allowlist, so a flag the shell happens to
 * carry (a truncation request, a backfill batch, a chunk-context choice 013
 * records into ob1_config) cannot reach the spawned migrator, today's flag or
 * a future one — then the fixture's width, model and trigram choice; the bare
 * apply (`substitute`) pins the same values from the fixture. For running
 * `migrate.ts` through `runMigrator` where a suite or bench wants the ledger
 * the runner keeps — test-upgrade's incremental cases, bench-hnsw.ts's kept
 * corpus — rather than `applyMigrations`' bare apply. (The first draft was a
 * denylist of three names, one of them read by nothing; review pass.)
 */
export function migratorEnv(url: string, opts: Pick<SchemaOptions, "dim" | "model" | "trgm">): Record<string, string> {
  const env = shellWithoutOb1();
  env.DATABASE_URL = url;
  env.OB1_EMBEDDING_DIM = String(opts.dim);
  env.OB1_EMBEDDING_MODEL = opts.model;
  env.OB1_TRGM_INDEX = (opts.trgm ?? DEFAULT_TRGM_INDEX) ? "on" : "off";
  return env;
}

/**
 * `migrate.ts` against a URL, from a shell `migratorEnv` built, with any of its
 * flags — for bench-hnsw's kept corpus and test-upgrade's plain runs; the other
 * suites still spell the spawn for themselves. Exit code and combined output,
 * as runScript gives them.
 */
export function runMigrator(url: string, env: Record<string, string> | undefined, ...flags: string[]): Promise<{ code: number; out: string }> {
  return runScript(["bun", join(HERE, "migrate.ts"), "--url", url, ...flags], { ...(env ? { env } : {}), cwd: HERE });
}

/** The migration files, sorted — the one listing for the bare apply, the ledger comparison and the suites that count them. */
/** The community schemas' directory, `schemas/` beside `db/`. */
export const SCHEMAS_DIR = join(HERE, "..", "schemas");
/**
 * The community SQL files with a prerequisite, in the order it requires:
 * enhanced-thoughts before readwise-books (whose function filters on its
 * source_type column) and text-search-trgm; entity-extraction before
 * typed-reasoning-edges (which alters its edges table). The rest of the files
 * follow alphabetically.
 */
export const SCHEMA_FILES_FIRST: readonly string[] = ["enhanced-thoughts/schema.sql", "text-search-trgm/schema.sql", "readwise-books/schema.sql", "entity-extraction/schema.sql", "typed-reasoning-edges/schema.sql"];
/**
 * Every SQL file under schemas/, as `<dir>/<file>`, SCHEMA_FILES_FIRST first
 * and the rest alphabetical — the order test-schema [40] and test-live [18]
 * apply them in (SMD-1796). Read from the tree, never listed, so a new
 * community schema is applied by both suites the day it lands.
 */
export function communitySchemaFiles(): string[] {
  const rank = (f: string) => (SCHEMA_FILES_FIRST.indexOf(f) === -1 ? SCHEMA_FILES_FIRST.length : SCHEMA_FILES_FIRST.indexOf(f));
  const files: string[] = [];
  for (const d of readdirSync(SCHEMAS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(SCHEMAS_DIR, d.name))) if (f.endsWith(".sql")) files.push(`${d.name}/${f}`);
  }
  return files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * The migrator's ledger against the tree: `null` where the database has no
 * ledger (its schema was applied bare, or is not this schema), else the names
 * recorded as applied that no file under db/migrations carries. migrate.ts
 * applies what is pending and refuses a file edited since it was recorded, but
 * it never looks for a recorded name it has no file for — a database migrated
 * from another branch's tree looks fully applied to it. A bench reusing a kept
 * corpus asks this first (SMD-1493). A stand-in: SMD-1504 moves the check into
 * migrate.ts, after which this goes.
 */
export async function ledgerStrangers(sql: SQL): Promise<string[] | null> {
  const names = await ledgerNames(sql);
  if (names === null) return null;
  const files = new Set(migrationFiles());
  return names.filter((name) => !files.has(name));
}

/** The names the migrator's ledger records, or `null` where there is no ledger. */
export async function ledgerNames(sql: SQL): Promise<string[] | null> {
  const [{ has }] = await sql`SELECT to_regclass('schema_migrations') IS NOT NULL AS has`;
  if (!has) return null;
  return (await sql`SELECT name FROM schema_migrations ORDER BY name`).map((r: { name: string }) => r.name);
}

export function requireDatabaseUrl(script: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. Try: ../db/with-postgres.sh bun ${script}`);
    process.exit(2);
  }
  return url;
}

/**
 * match_thoughts' own statements, as parameterised SQL. Read from the catalog so
 * it is the DEPLOYED text — EXPLAIN cannot see inside a plpgsql function, and
 * a copy of the body kept here would be the body as someone remembered it. The
 * rewrite is deliberately narrow — the six parameters (four before 020) and the DECLAREd locals
 * — and refuses anything it does not recognise rather than explaining a
 * statement that is not the function's.
 *
 * Shared by db/bench-hnsw.ts (the filtered branches), db/bench-plan.ts and
 * db/test-live.ts [5c] (the unfiltered one), so the three explain the same
 * text under the same rewrite.
 *
 * `route` is the statement that decides between the filtered branches: the
 * capped collection of matching ids that ran on EVERY filtered call until 037
 * gated it. It is a plpgsql SELECT INTO rather than a RETURN QUERY, so it is
 * extracted on its own. `estimate` is 037's gate — the sample of the heap
 * that runs before it on a large heap and decides whether it runs at all —
 * the other SELECT INTO in the body: 037 sampled through TABLESAMPLE SYSTEM,
 * 038 reads eight TID ranges, and both shapes are recognised so a bench's
 * before arm (OB1_BENCH_UPTO=037) explains its estimate too.
 */
export type Branch = "unfiltered" | "walk" | "exact" | "route" | "estimate";

/**
 * The one match_thoughts in `public`, whatever its signature: the benches'
 * "before" arms hold 014's 4-argument function and the shipped schema 020's
 * 6-argument one. Two of them is the ambiguity 020 exists to avoid, and is
 * refused here rather than explained.
 */
export async function matchThoughtsOid(sql: SQL): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname = 'match_thoughts' AND n.nspname = 'public'`
  );
  if (rows.length !== 1) throw new Error(`${rows.length} match_thoughts functions in public; expected exactly one`);
  return Number(rows[0].oid);
}

/**
 * The deployed match_thoughts' definition and its INPUT argument names, for
 * the rewriters below. proargnames lists the RETURNS TABLE columns too (mode
 * 't'), and `id` is a column in every body, so only the IN modes count.
 */
async function matchThoughtsDef(sql: SQL): Promise<{ def: string; argNames: string[] }> {
  const [{ def, argNames }] = await sql.unsafe(
    `SELECT pg_get_functiondef(p.oid) AS def,
            COALESCE((SELECT array_agg(a.n ORDER BY a.ord) FROM unnest(p.proargnames, p.proargmodes) WITH ORDINALITY AS a(n, m, ord)
                      WHERE a.m IS NULL OR a.m IN ('i', 'b', 'v')), p.proargnames) AS "argNames"
     FROM pg_proc p WHERE p.oid = $1::oid`,
    [await matchThoughtsOid(sql)]
  );
  return { def, argNames: argNames ?? [] };
}

export async function extractBody(sql: SQL, branch: Branch, dim: number, opts: { overrides?: Record<string, string> } = {}): Promise<string> {
  const { def, argNames } = await matchThoughtsDef(sql);
  let block: string | undefined;
  if (branch === "route") {
    // `SELECT array_agg(s.id) INTO v_ids FROM (...) s;` — minus the INTO.
    const m = /SELECT array_agg\(s\.id\) INTO v_ids\s+(FROM \([\s\S]*?\) s);/.exec(def);
    if (!m) throw new Error("match_thoughts has no `SELECT array_agg(s.id) INTO v_ids` routing statement; the bench's rewrite does not apply");
    block = `SELECT array_agg(s.id) ${m[1]}`;
  } else if (branch === "estimate") {
    // The gate's statement: `SELECT <three counts> INTO v_hits, v_hit_pages,
    // v_pages_seen FROM (... TABLESAMPLE SYSTEM (v_pct)) s;` under 037, and
    // `... FROM (<eight distinct blocks>) b LEFT JOIN LATERAL (<one TID range>)
    // p ON true;` under 038 — minus the INTO, either shape. A body from before
    // 037 has none, and says so.
    // Comment lines stripped first: 038's header quotes the statement, and a
    // body that did the same in a comment would have the bench explain the
    // comment (review pass 3).
    const m = /SELECT (count\(\*\) FILTER[\s\S]*?)\s+INTO v_hits, v_hit_pages, v_pages_seen\s+(FROM \([\s\S]*?(?:TABLESAMPLE SYSTEM[\s\S]*?\) s|LEFT JOIN LATERAL \([\s\S]*?\) p ON true));/.exec(def.replace(/^[ \t]*--.*$/gm, ""));
    if (!m) throw new Error("match_thoughts has no sample of the heap in a shape this rewrite recognises — a body from before 037, or a redefinition that re-aliased the statement; the bench's rewrite does not apply");
    block = `SELECT ${m[1]} ${m[2]}`;
  } else {
    // Three RETURN QUERY branches: unfiltered, the exact answer for a thin
    // filter, and the HNSW walk for a broad one. Only the walk tests
    // `metadata @> filter` and LIMITs its candidate CTEs; the exact branch
    // reads the ids the routing statement collected; the unfiltered one does
    // neither.
    const blocks = [...def.matchAll(/RETURN QUERY\s+([\s\S]*?);\s*(?=ELSE|ELSIF|END IF;|END;)/g)].map((x) => x[1]);
    block =
      branch === "walk"
        ? blocks.find((b) => /@>\s*filter/.test(b) && /LIMIT\s+v_fetch/.test(b))
        : branch === "exact"
          ? blocks.find((b) => /ANY \(v_ids\)/.test(b))
          : blocks.find((b) => !/@>\s*filter/.test(b) && !/ANY \(v_ids\)/.test(b));
    if (!block) throw new Error(`match_thoughts has ${blocks.length} RETURN QUERY block(s) and no ${branch} branch; the bench's rewrite does not apply`);
  }
  let body = block;
  // The exact branch reads `v_ids`, which the routing statement fills; splice
  // that statement in so the explained text stands alone — before the locals
  // are substituted, since that statement uses v_exact. As ONE materialized
  // CTE at the head of the branch's WITH, not a scalar subquery per reference:
  // the branch reads v_ids twice (direct and chunked), and two spliced
  // subqueries became two InitPlans that each ran the GIN collection, where
  // the function runs `SELECT … INTO v_ids` once (SMD-1018 review pass).
  const route = /SELECT array_agg\(s\.id\) INTO v_ids\s+(FROM \([\s\S]*?\) s);/.exec(def);
  if (route && /\bv_ids\b/.test(body)) {
    if (!/^\s*WITH\s/.test(body)) throw new Error("the branch that reads v_ids no longer opens with WITH; the bench's rewrite does not apply");
    // The routing statement aliases thought_chunks as `k`, as the exact
    // branch's own chunk probe does; renamed on the way in so a plan reader
    // attributing nodes by alias (bench-hnsw.ts shapeOf) cannot take the
    // routing CTE's EXISTS probe for the branch's (fourth review pass).
    const routeText = route[1].replace(/\bk\b/g, "rk");
    body = body.replace(/^\s*WITH\s/, () => `WITH ob1_ids AS MATERIALIZED (SELECT array_agg(s.id) AS ids ${routeText}), `);
    body = body.replace(/\bv_ids\b/g, () => `((SELECT ids FROM ob1_ids)::uuid[])`);
  }
  // 020's two parameters are $5 and $6; a body from before 020 (a bench's
  // "before" arm) reads neither, and a PREPARE that declares them is still
  // valid, so every explainer passes six arguments.
  return resolveLocals(body, declaredLocals(def), {
    overrides: opts.overrides,
    argNames,
    params: {
      query_embedding: `$1::vector(${dim})`,
      match_threshold: "$2::float",
      match_count: "$3::int",
      filter: "$4::jsonb",
      recency_weight: "$5::float",
      half_life_days: "$6::float",
    },
  });
}

/**
 * Substitute the DECLARE locals and the function's parameters into a piece
 * of its body, so the text stands alone. Replacer FUNCTIONS throughout: a
 * replacement string would interpret `$1`, `$&` or `$$` inside an expression
 * as a pattern, and 014's SQL is one `$$` away from that. Locals may reference
 * earlier locals (v_fetch is built from v_count), so substitute until none
 * remain rather than in one pass. A caller may override a local's expression
 * — bench-hnsw.ts section E lifts `v_exact` to route a broader tier to the
 * exact branch — and the override is substituted where the local was, so
 * nothing downstream is split on a literal. One routine for extractBody and
 * routingAt (third review pass of SMD-1018: two copies had already diverged
 * on overrides and on the leftover check). `argNames` are the function's own
 * (pg_proc.proargnames): a parameter the caller's table does not name — a
 * seventh argument a redefinition adds — is refused here by name, not by the
 * server after the load with "column does not exist" (fourth review pass).
 */
function resolveLocals(text: string, locals: Map<string, string>, opts: { overrides?: Record<string, string>; params: Record<string, string>; argNames: string[] }): string {
  let out = text;
  for (let pass = 0; pass < locals.size + 1; pass++) {
    for (const [name, expr] of locals) out = out.replace(new RegExp(`\\b${name}\\b`, "g"), () => `(${opts.overrides?.[name] ?? expr})`);
  }
  for (const [name, value] of Object.entries(opts.params)) out = out.replace(new RegExp(`\\b${name}\\b`, "g"), () => value);
  const leftover = /\b(v_\w+)\b/.exec(out);
  if (leftover) throw new Error(`unrewritten local ${leftover[1]} in match_thoughts body`);
  for (const arg of opts.argNames) {
    if (!(arg in opts.params) && new RegExp(`\\b${arg}\\b`).test(out)) throw new Error(`match_thoughts parameter ${arg} is read by the extracted text and this rewrite does not name it`);
  }
  return out;
}

/** The PREPARE parameter list every explainer declares — match_thoughts' six arguments since 020, in one place. */
export const preparedSignature = (dim: number) => `(vector(${dim}), float, int, jsonb, float, float)`;

/**
 * 038's probe as the body spells it — every tuple of one block, half-open at
 * the next. test-schema [8e], test-live [5d] and test-upgrade [16] read the
 * installed body for it; one spelling here rather than three that drift.
 */
export const TID_PROBE = /t\.ctid >= \('\(' \|\| b\.blk \|\| ',0\)'\)::tid\s+AND t\.ctid <\s+\('\(' \|\| b\.blk \+ 1 \|\| ',0\)'\)::tid/;

/**
 * 038's sample statement in a body: group 1 the three counts, group 2 the
 * FROM clause from the draw through `) p ON true`. The INTO is left out, so
 * the text runs on its own once the two plpgsql-supplied values are in.
 */
export const SAMPLE_STATEMENT = /SELECT (count\(\*\) FILTER[\s\S]*?)\s+INTO v_hits, v_hit_pages, v_pages_seen\s+(FROM \([\s\S]*?\) p ON true);/;

/**
 * The sample statement read out of an installed body (pg_proc.prosrc) with
 * the page count and the filter substituted as literals — what test-schema
 * [8e] draws with and test-live [5d] times, so neither keeps a copy of the
 * statement (a copy passed every drop-the-mechanism mutant, SMD-1526 review
 * pass 1). Null when the body has no statement of that shape.
 */
export function sampleStatementOf(prosrc: string, pageCount: number, filterJson: string): string | null {
  const m = SAMPLE_STATEMENT.exec(prosrc);
  if (!m) return null;
  return `SELECT ${m[1]} ${m[2]}`.replace(/\bv_pages\b/g, () => String(pageCount)).replace(/\bfilter\b/g, () => `'${filterJson}'::jsonb`);
}


/**
 * The DECLARE block's locals, name → expression text: `name  type words  :=
 * expr;` — the type may be several words (`double precision`, `timestamp with
 * time zone`).
 */
function declaredLocals(def: string): Map<string, string> {
  const declared = /DECLARE([\s\S]*?)BEGIN/.exec(def)?.[1] ?? "";
  const locals = new Map<string, string>();
  for (const line of declared.split("\n")) {
    const d = /^\s*(\w+)\s+[\w ]+?\s*:=\s*(.+);\s*$/.exec(line);
    if (d) locals.set(d[1], d[2]);
  }
  return locals;
}

/**
 * `v_fetch` and `v_exact` as the deployed match_thoughts computes them for a
 * call with this match_count and no recency weight — its own DECLARE
 * expressions, resolved through the locals they read and evaluated by the
 * server. The benches route their tiers by these rather than by a copy of
 * the arithmetic kept in each file: 014 wrote GREATEST(v_fetch * 4, 1000),
 * 020 re-based it on v_base, and a redefinition that raises the floor
 * (SMD-1464) moves every consumer at once (SMD-1018 review pass).
 */
export async function routingAt(sql: SQL, matchCount: number): Promise<{ vFetch: number; vExact: number; vPages?: number; vPct?: number }> {
  const { def, argNames } = await matchThoughtsDef(sql);
  const locals = declaredLocals(def);
  if (!locals.has("v_exact") || !locals.has("v_fetch")) throw new Error("the deployed match_thoughts declares no v_exact / v_fetch; it is not a 014-or-later body");
  // The same substitution the explainers use, with the arguments the benches
  // call with in place of every parameter (the threshold is -1.0 in every
  // bench call; a local that read it would route by the call's value); a
  // parameter a redefinition adds is refused by name in resolveLocals.
  const resolve = (name: string) =>
    resolveLocals(`(${name})`, locals, {
      argNames,
      params: {
        query_embedding: "NULL::vector",
        match_threshold: "-1.0::float",
        match_count: `${matchCount}::int`,
        filter: "'{}'::jsonb",
        recency_weight: "0.0::float",
        half_life_days: "90.0::float",
      },
    });
  // The gate's locals too, where the body declares them, evaluated NOW
  // against this table — the heap's page count (v_pages; 037 and 038, the
  // range 038 draws its blocks from) and 037's sample share (v_pct, the
  // fraction of the heap its TABLESAMPLE read) — so the bench can substitute
  // the values the function's own custom plan sees. Under 037 that was
  // load-bearing: an explainer that substituted the declaring expression
  // (pg_relation_size is volatile) left the planner unable to size the
  // sample scan, which it then priced as the whole heap, past jit_above_cost
  // at ten million rows — ~50 ms of JIT the function never pays (SMD-1463).
  // Under 038 the literal only makes the explained plan the function's; the
  // probes are priced alike whatever the planner knows (SMD-1526).
  const gate = ["v_pages", "v_pct"].filter((name) => locals.has(name));
  const [row] = await sql.unsafe(
    `SELECT ${resolve("v_fetch")}::int AS v_fetch, ${resolve("v_exact")}::int AS v_exact${gate.map((name) => `, ${resolve(name)}::float AS ${name}`).join("")}`
  );
  return {
    vFetch: Number(row.v_fetch),
    vExact: Number(row.v_exact),
    ...(locals.has("v_pages") ? { vPages: Number(row.v_pages) } : {}),
    ...(locals.has("v_pct") ? { vPct: Number(row.v_pct) } : {}),
  };
}

/**
 * Apply match_thoughts' function-level SET clauses to the current transaction,
 * so a statement extracted from its body is planned as the function plans it.
 * proconfig is read as an array and applied through set_config with bound
 * parameters: a joined string split on commas would break the first time a
 * list-valued setting such as `search_path = public, extensions` is added to
 * the function. A plan mode is skipped: the callers exist to show both plans,
 * and a successor that forced one would otherwise hide the other.
 */
export async function applyFunctionSettings(tx: SQL, opts: { scope?: "transaction" | "session" } = {}): Promise<string[]> {
  const entries = await tx.unsafe(`SELECT unnest(proconfig) AS kv FROM pg_proc WHERE oid = $1::oid`, [await matchThoughtsOid(tx)]);
  const applied: string[] = [];
  for (const { kv } of entries as { kv: string }[]) {
    const eq = kv.indexOf("=");
    if (eq < 0) throw new Error(`unexpected proconfig entry ${JSON.stringify(kv)}`);
    if (kv.slice(0, eq) === "plan_cache_mode") continue;
    // Transaction scope (set_config's is_local) is the default and matches
    // SET LOCAL; a caller that PREPAREs once and EXECUTEs many statements
    // outside a transaction asks for session scope and RESETs the names
    // returned here when it is done (bench-hnsw.ts section D).
    await tx.unsafe(`SELECT set_config($1, $2, $3)`, [kv.slice(0, eq), kv.slice(eq + 1), opts.scope !== "session"]);
    applied.push(kv.slice(0, eq));
  }
  return applied;
}

/**
 * PREPARE a statement extracted by `extractBody`, optionally run it once to
 * warm the buffers, EXPLAIN (ANALYZE, BUFFERS) the EXECUTE, DEALLOCATE. The
 * caller has applied the settings it wants on `tx` (applyFunctionSettings, or
 * SET LOCAL for an arm the function does not have) and chooses the plan mode.
 * One body for the four explainers (second review pass), so a change to the
 * EXPLAIN form or the parameter list has one place to land. `args` is the
 * function's six arguments as SQL text — `query, threshold, count, filter,
 * recency_weight, half_life_days` (020); a pre-020 body simply reads the last
 * two of them nowhere.
 *
 * COSTS stays ON. It was OFF for legibility until SMD-1018 found every generic
 * plan at ten million rows carrying 30–110 ms of startup the custom plan of
 * the same shape did not, and could not say why: EXPLAIN prints its JIT
 * summary only when costs are printed, so the one line that would have named
 * the cost was suppressed with them. The estimated cost is also what decides
 * whether JIT fires, so a reader of the plan text needs it. The shape regexes
 * in the explainers match on the node's name and alias, which precede the
 * `(cost=…)` annotation on the line.
 */
export async function explainPrepared(
  tx: SQL,
  opts: { body: string; dim: number; args: string; mode: "force_custom_plan" | "force_generic_plan"; warm?: boolean }
): Promise<{ text: string; ms: number; buffers: number }> {
  await tx.unsafe(`SET LOCAL plan_cache_mode = ${opts.mode}`);
  await tx.unsafe(`PREPARE ob1_explain${preparedSignature(opts.dim)} AS ${opts.body}`);
  if (opts.warm) await tx.unsafe(`EXECUTE ob1_explain(${opts.args})`);
  const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, COSTS) EXECUTE ob1_explain(${opts.args})`);
  await tx.unsafe(`DEALLOCATE ob1_explain`);
  const text = rows.map((r: Record<string, string>) => Object.values(r)[0]).join("\n");
  return { text, ms: Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? NaN), buffers: buffersOf(text) };
}

/**
 * Give every `every`-th synthetic thought (content `row N`) one chunk row
 * carrying the parent's own vector, so the chunk CTE has an index to reach and
 * a table to scan. The parent's vector on purpose: the point is rows in the
 * chunk table, not a chunk that out-scores its parent, so a MAX over parent
 * and chunk is the parent's score and every exactness assertion is unaffected.
 * db/bench-plan.ts and db/test-live.ts [5b] both load this shape.
 */
export async function loadChunkRows(sql: SQL, every: number): Promise<void> {
  await sql.unsafe(`INSERT INTO thought_chunks (thought_id, chunk_index, content, embedding)
                    SELECT id, 0, 'chunk', embedding FROM thoughts WHERE substr(content, 5)::int % ${Math.max(1, Math.floor(every))} = 0`);
}

/**
 * Shared buffers the whole statement touched, from EXPLAIN (ANALYZE, BUFFERS)
 * text: the TOP node's `Buffers:` line, hits AND reads. A regex for `hit=`
 * alone under-counts whenever part of the I/O missed shared_buffers — the
 * default 128 MB container cannot hold a 527 MB TOAST relation, so a seq scan
 * there lands mostly in `read=` — and under-counts in the direction that
 * flatters the plan that read less (first review pass).
 */
export function buffersOf(plan: string, node?: RegExp): number {
  // With `node`, that node's own Buffers line (its total across loops) inside
  // the plan tree — `Planning:` and its Buffers line follow the tree — rather
  // than the top node's cumulative one, which counts catalog reads under a
  // cold syscache too (test-schema [8e], review pass 3).
  const scope = node ? new RegExp(`${node.source}[^\\n]*\\n(?:[^\\n]*\\n)*?\\s*(Buffers: [^\\n]*)`).exec(plan.split(/\nPlanning:/)[0])?.[1] ?? "" : plan;
  const m = /Buffers: shared(?: hit=(\d+))?(?: read=(\d+))?/.exec(scope);
  return m ? Number(m[1] ?? 0) + Number(m[2] ?? 0) : 0;
}

/**
 * A seeded PRNG for suites that need reproducible random vectors, so the same
 * seed produces the same rows on every machine and in CI. bench-hnsw.ts,
 * test-live.ts and evals/eval-filtered.ts each carried a copy; this is the one.
 *
 * mulberry32, in 32-bit integer arithmetic via Math.imul. The copy this
 * replaced was an LCG written as `s * 1103515245` in doubles: the product
 * passes 2^53, the low bits become rounding artefacts, and the stream collapsed
 * into a 10,466-draw cycle. At 100,000 bench rows that meant ~10,000 distinct
 * vectors, each stored up to ten times, and every "random" query bit-identical
 * to a stored row — exactly the query-is-its-own-nearest-neighbour confound the
 * bench's header says its design avoids. Found by the second review pass; the
 * numbers published before it were re-measured.
 */
export function seededRandom(seed: number): {
  rnd: () => number;
  gauss: () => number;
  unitVector: (dim: number) => number[];
  /** Advance the stream by k draws without producing them — the Weyl step is additive, so this is one multiply. */
  skip: (k: number) => void;
} {
  let a = seed >>> 0;
  const skip = (k: number) => {
    // a += k * 0x6d2b79f5 (mod 2^32). Math.imul takes k through ToInt32, which
    // is the reduction mod 2^32 itself; k is exact below 2^53, far past a
    // hundred million rows' draws.
    a = (a + Math.imul(k, 0x6d2b79f5)) >>> 0;
  };
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = rnd() || 1e-9;
    const v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const unitVector = (dim: number) => {
    const v = Array.from({ length: dim }, gauss);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  return { rnd, gauss, unitVector, skip };
}
