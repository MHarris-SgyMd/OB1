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
const TABLES = ["thought_chunks", "thoughts", "schema_migrations", "ob1_config"];

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

/** Drop everything the schema owns and apply the migrations from scratch. */
export async function resetSchema(url: string, opts: SchemaOptions): Promise<void> {
  const admin = new SQL({ url, max: 1 });
  try {
    for (const t of TABLES) await admin.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
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

/**
 * A counting assert. Returned as an object rather than module state so two suites
 * in one process cannot pollute each other's tally — and so `report()` owns the
 * exit code, which every suite was also duplicating.
 */
export function createAssert(): {
  assert: (cond: unknown, label: string) => void;
  report: () => never;
} {
  let passed = 0;
  let failed = 0;
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
    report(): never {
      console.log(`\n${"─".repeat(52)}`);
      console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`);
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
