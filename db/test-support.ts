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
import { DEFAULT_TRGM_INDEX, HNSW_BOUNDS, migrationValues, quoteIdent, substituteMigration } from "./config.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Every table the schema owns, in drop order — dependents first. `thoughts` is
 * dropped CASCADE, which removes constraints pointing AT it but not the tables
 * holding them, so anything with a foreign key has to be named before it.
 */
const TABLES = [
  "thought_audit",
  "thought_chunks",
  "thought_work_claims",
  "thoughts",
  "ob1_agent_keys",
  "ob1_agents",
  "schema_migrations",
  "ob1_config",
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
  "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)",
  "delete_thought(uuid, jsonb)",
  "thought_audit_refuse_mutation()",
  "thoughts_write_audit()",
  "ob1_current_actor()",
  "resolve_agent(text, text, text)",
  "revoke_agent_key(text, text)",
  "upsert_thought(text, jsonb)",
  "upsert_thought(text, jsonb, vector)",
  "upsert_thought(text, jsonb, vector, jsonb)",
  "match_thoughts(vector, float, int, jsonb)",
  "search_thoughts_keyword(text, int, int, jsonb)",
  "update_updated_at()",
  "enqueue_thoughts(text, uuid[])",
  "claim_thoughts(text, text, int, int, int)",
  "release_thought(uuid, text, text, text, text)",
  "release_claims_for_worker(text, text)",
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
  return substituteMigration(
    sql,
    migrationValues({ dim: opts.dim, model: opts.model, trgm: opts.trgm ?? DEFAULT_TRGM_INDEX })
  );
}

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
  if (process.env.OB1_ALLOW_REMOTE_DB === "1" || process.env.OB1_EVAL_ALLOW_REMOTE_DB === "1") return;
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

/** Apply the migrations, substituting the templates. */
export async function applyMigrations(url: string, opts: SchemaOptions): Promise<void> {
  const admin = new SQL({ url, max: 1 });
  try {
    const files = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => opts.only?.(f) ?? true)
      .sort();
    for (const f of files) {
      await admin.unsafe(substitute(readFileSync(join(MIGRATIONS, f), "utf8"), opts));
    }
  } finally {
    await admin.close();
  }
}

/** The common case: drop everything, then apply from scratch. */
export async function resetSchema(url: string, opts: SchemaOptions): Promise<void> {
  await dropSchema(url);
  await applyMigrations(url, opts);
}

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
export function requireDatabaseUrl(script: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`DATABASE_URL is not set. Try: ../db/with-postgres.sh bun ${script}`);
    process.exit(2);
  }
  return url;
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
} {
  let a = seed >>> 0;
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
  return { rnd, gauss, unitVector };
}
