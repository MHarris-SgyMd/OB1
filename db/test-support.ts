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
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Every table the schema owns, in drop order — dependents first. `thoughts` is
 * dropped CASCADE, which removes constraints pointing AT it but not the tables
 * holding them, so anything with a foreign key has to be named before it.
 */
const TABLES = ["thought_audit", "thought_chunks", "thoughts", "schema_migrations", "ob1_config"];

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
  "thought_audit_refuse_mutation()",
  "thoughts_write_audit()",
  "ob1_current_actor()",
  "upsert_thought(text, jsonb)",
  "upsert_thought(text, jsonb, vector)",
  "upsert_thought(text, jsonb, vector, jsonb)",
  "match_thoughts(vector, float, int, jsonb)",
  "update_updated_at()",
];

export type SchemaOptions = {
  /** Vector width to substitute for `{{EMBEDDING_DIM}}`. */
  dim: number;
  /** Model name to substitute for `{{EMBEDDING_MODEL}}`. */
  model: string;
  /** Apply only these migrations, by filename prefix. Defaults to all of them. */
  only?: (name: string) => boolean;
};

/** Substitute the template placeholders. Applying a migration raw fails. */
export function substitute(sql: string, opts: SchemaOptions): string {
  return sql
    .replace(/\{\{EMBEDDING_DIM\}\}/g, String(opts.dim))
    .replace(/\{\{EMBEDDING_MODEL\}\}/g, opts.model);
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
  const admin = new SQL({ url, max: 1 });
  try {
    for (const t of TABLES) await admin.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
    for (const f of FUNCTIONS) await admin.unsafe(`DROP FUNCTION IF EXISTS ${f}`);
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
