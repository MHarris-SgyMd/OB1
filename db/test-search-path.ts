#!/usr/bin/env bun
/**
 * test-search-path.ts — pgvector installed OFF the connection's search_path.
 *
 * Every other suite runs against `pgvector/pgvector:0.8.6-pg16`, which installs
 * the extension into `public`, on the path. That is not how a managed Postgres
 * ships it: Supabase puts pgvector in an `extensions` schema, and several
 * providers do the same, off the default search_path. There
 * `CREATE EXTENSION IF NOT EXISTS vector` finds it and does nothing, and then
 * the bare type `vector` and the operator class `vector_cosine_ops` do not
 * resolve — `type "vector" does not exist` on a database that demonstrably has
 * pgvector (upstream #319, SMD-1247). The population this hits is exactly the
 * one the fork is for, and the whole matrix misses it because the test image
 * does not reproduce it.
 *
 * This suite reproduces it — `relocateVectorTo` moves the extension into `ext`,
 * off the database's `"$user", public` path — and asserts the two halves of the
 * fix:
 *
 *   1. The runner heals its own session. migrate.ts (and applyMigrations, the
 *      test path) add the extension's schema to the session search_path before
 *      any migration runs, so the chain applies. It does NOT persist that — the
 *      running server is a separate connection.
 *   2. Preflight catches the server. The `vector extension` check reads the
 *      catalog, fails when the type does not resolve, and names the schema and
 *      the persistent fix (ALTER ROLE / ALTER DATABASE), which coexists with the
 *      hnsw.* walk bounds rather than dropping them.
 *
 * It restores pgvector to `public` on the way out, in a finally: ci-parity.sh
 * shares one Postgres across suites, so a relocated extension left behind would
 * break the next one.
 *
 *   ./with-postgres.sh bun test-search-path.ts
 */

import { SQL } from "bun";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIM, EMBEDDING_MODEL } from "./config.mjs";
import {
  applyMigrations,
  createAssert,
  dropSchema,
  relocateVectorTo,
  requireDatabaseUrl,
  restoreVectorToPublic,
  runScript,
} from "./test-support.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server-portable");
const URL_ = requireDatabaseUrl("test-search-path.ts");
const { assert, report } = createAssert();

const OPTS = { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL };
const SCHEMA = "ext";

/** migrate.ts as a subprocess, so its real exit code and self-heal log are observed. */
const migrate = (...extra: string[]) =>
  runScript(["bun", join(HERE, "migrate.ts"), "--url", URL_, ...extra], { cwd: HERE });

/** preflight.ts as a subprocess, with a coherent SQL configuration so it reaches the direct-connection block. */
function preflight(extraEnv: Record<string, string | undefined> = {}) {
  const clean: Record<string, string> = {};
  const merged = {
    ...process.env,
    MCP_ACCESS_KEY: "x".repeat(64),
    OPENROUTER_API_KEY: "sk-stub",
    OB1_STORE: "sql",
    DATABASE_URL: URL_,
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = String(v);
  return runScript(["bun", join(SERVER, "preflight.ts")], { cwd: SERVER, env: clean });
}

/** A fresh session that has NOT added the schema — the state the server's connection is in. */
async function freshSession<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL({ url: URL_, max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

try {
  // ── The off-path condition ──────────────────────────────────────────────────
  // dropSchema first, while pgvector is still in public, so its vector-typed
  // DROP FUNCTION statements parse; then relocate the extension off the path.
  await dropSchema(URL_);
  await relocateVectorTo(URL_, SCHEMA);

  console.log(`[1] pgvector is genuinely off the search path (schema ${SCHEMA})`);
  {
    const off = await freshSession((sql) => sql`
      SELECT to_regtype('vector') IS NULL AS unresolved,
             (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector') AS schema,
             current_setting('search_path') AS path`);
    assert(off[0].unresolved === true, "a fresh session cannot resolve the bare vector type");
    assert(off[0].schema === SCHEMA, `…while the extension is installed, in schema ${SCHEMA} (${off[0].schema})`);
    assert(!off[0].path.includes(SCHEMA), `…and ${SCHEMA} is not on the default search_path (${off[0].path})`);
  }

  console.log("\n[2] The migration chain applies incrementally off-path (the upgrade shape)");
  {
    // applyMigrations self-heals its own session each call. A row is written
    // between migrations, so a migration that cannot cope with existing rows
    // off-path fails here rather than in production.
    const files = readdirSync(join(HERE, "migrations")).filter((f) => f.endsWith(".sql")).sort();
    let written = 0;
    await freshSession(async (sql) => {
      for (const file of files) {
        await applyMigrations(URL_, { ...OPTS, only: (f) => f === file });
        await sql`INSERT INTO thoughts (content, metadata) VALUES (${`written after ${file}`}, '{}'::jsonb)`;
        written++;
      }
      const [{ c }] = await sql`SELECT count(*)::int AS c FROM thoughts`;
      assert(c === written, `every one of the ${written} rows written between migrations survived (${c})`);
      // The column exists and carries the relocated type — the schema really
      // was built through the off-path extension, not around it.
      const [col] = await sql`
        SELECT format_type(a.atttypid, a.atttypmod) AS t
          FROM pg_attribute a WHERE a.attrelid = 'thoughts'::regclass AND a.attname = 'embedding'`;
      assert(/vector\(\d+\)$/.test(col.t) && col.t.startsWith(`${SCHEMA}.`),
             `thoughts.embedding is the relocated vector type (${col.t})`);
    });
  }

  console.log("\n[3] migrate.ts heals its own session, and does not persist the path");
  {
    // A clean rebuild from empty, through the real runner. Move the extension
    // back so dropSchema's vector-typed drops parse, drop, relocate off again.
    await restoreVectorToPublic(URL_);
    await dropSchema(URL_);
    await relocateVectorTo(URL_, SCHEMA);

    const run = await migrate();
    assert(run.code === 0, `migrate.ts exits 0 against an off-path database (${run.code})`);
    assert(/applied \d+, skipped 0/.test(run.out), "…having applied every migration");
    assert(new RegExp(`installed in schema "${SCHEMA}"`).test(run.out),
           "…and it says it added the extension's schema to its session");

    await freshSession(async (sql) => {
      const [{ present }] = await sql`SELECT to_regclass('public.thoughts') IS NOT NULL AS present`;
      assert(present === true, "the schema is built — the thoughts table is present");
      const [{ unresolved }] = await sql`SELECT to_regtype('vector') IS NULL AS unresolved`;
      assert(unresolved === true, "…yet a fresh session STILL cannot resolve vector — the runner healed only itself, it did not ALTER the database");
      const [{ ledger }] = await sql`SELECT count(*)::int AS ledger FROM schema_migrations`;
      assert(ledger > 0, `…and the real runner recorded the ledger (${ledger})`);
    });
  }

  console.log("\n[4] Preflight fails on the off-path database, naming the schema and the fix");
  {
    const r = await preflight();
    assert(r.code === 1, `preflight exits 1 while the server cannot resolve vector (${r.code})`);
    assert(new RegExp(`vector extension.*installed in schema "${SCHEMA}"`, "s").test(r.out),
           "…the vector extension check names the schema pgvector is in");
    assert(/type "vector" does not exist/.test(r.out), "…and the error the server would otherwise hit");
    assert(/ALTER ROLE .* SET search_path/.test(r.out) && /ALTER DATABASE .* SET search_path/.test(r.out),
           "…with both the role-scoped and database-wide remedies");
    assert(/beside any hnsw\.\* bounds, it does not replace them/.test(r.out),
           "…and the note that the fix coexists with the hnsw walk bounds");
    // The two capture forms are matched by a signature built from pg_type's
    // names; regprocedure's text would spell `ext.vector` here and call the
    // present 3-argument form missing (SMD-1250, second review pass).
    assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both 034's/.test(r.out),
           "…while atomic capture still finds both upsert_thought forms with pgvector off the path");
  }

  console.log("\n[5] A role that cannot see the schema is told to GRANT, not to set the path");
  {
    // Off-path and no-USAGE both make the type unresolvable, but only the first
    // is fixed by SET search_path. A fresh non-superuser has no USAGE on ext (a
    // schema created by postgres grants none to PUBLIC), so preflight as that
    // role must name the GRANT, not send it round the search_path loop.
    const npw = "nousagepw";
    await freshSession(async (sql) => {
      await sql.unsafe(`DROP ROLE IF EXISTS ob1_nousage`);
      await sql.unsafe(`CREATE ROLE ob1_nousage LOGIN PASSWORD '${npw}'`);
      await sql.unsafe(`REVOKE USAGE ON SCHEMA ${SCHEMA} FROM ob1_nousage`); // insurance; PUBLIC has none anyway
    });
    const nurl = URL_.replace(/\/\/[^@]+@/, `//ob1_nousage:${npw}@`);
    const r = await preflight({ DATABASE_URL: nurl });
    assert(r.code === 1, `preflight as a role with no USAGE exits 1 (${r.code})`);
    assert(new RegExp(`vector extension.*has no USAGE on that schema`, "s").test(r.out),
           "…the vector extension check names the missing USAGE, not an off-path schema");
    assert(new RegExp(`GRANT USAGE ON SCHEMA ${SCHEMA}`).test(r.out),
           "…and the remedy is a GRANT, which SET search_path alone would not have fixed");
  }

  console.log("\n[6] The database-wide fix makes preflight pass, and coexists with the hnsw bounds");
  {
    await freshSession(async (sql) => {
      const [{ db }] = await sql`SELECT current_database() AS db`;
      const ident = `"${String(db).replace(/"/g, '""')}"`;
      // The persistent fix preflight named, plus an hnsw bound beside it, to
      // prove SET search_path adds a setting rather than clearing the walk bounds.
      await sql.unsafe(`ALTER DATABASE ${ident} SET search_path = "$user", public, ${SCHEMA}`);
      // ALTER DATABASE takes effect for FUTURE sessions, not this one, so load
      // pgvector here through the schema-qualified type — a bare cast would fail
      // exactly as the server does. That loads the hnsw.* GUCs so the ALTER below
      // is accepted.
      await sql.unsafe(`SELECT '[1]'::${SCHEMA}.vector`);
      await sql.unsafe(`ALTER DATABASE ${ident} SET hnsw.max_scan_tuples = 40000`);
    });

    const r = await preflight();
    assert(r.code === 0, `with the schema on the database search_path, preflight passes (${r.code})`);
    assert(/vector extension\s+the vector type resolves/.test(r.out), "…the vector extension check is satisfied");

    const settings = await freshSession((sql) => sql`
      SELECT s.setconfig AS cfg FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = current_database() AND s.setrole = 0`);
    const cfg = (settings[0]?.cfg ?? []) as string[];
    assert(cfg.some((c) => c.startsWith("search_path=")) && cfg.some((c) => c.startsWith("hnsw.max_scan_tuples=")),
           `both the search_path and the hnsw bound are set on the database, side by side (${cfg.join("; ")})`);
  }
} finally {
  // ci-parity.sh shares one Postgres: leave pgvector in public and the database
  // search_path and hnsw bounds cleared, and drop the role [5] mints, whatever
  // happened above.
  await freshSession((sql) => sql.unsafe(`DROP ROLE IF EXISTS ob1_nousage`));
  await restoreVectorToPublic(URL_);
  await dropSchema(URL_);
}

report();
