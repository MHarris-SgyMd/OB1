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
 *      the persistent fix — the login role's setting IN DATABASE, its path kept
 *      and the schema added, or the connection string's options= value where
 *      the connection sets the path (SMD-2238) — which, run as printed, makes
 *      the type resolve and coexists with the hnsw.* walk bounds.
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
  runMigrator,
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
  runMigrator(URL_, undefined, ...extra);

/** preflight.ts as a subprocess, with a coherent SQL configuration so it reaches the direct-connection block. */
function preflight(extraEnv: Record<string, string | undefined> = {}) {
  const clean: Record<string, string> = {};
  const merged = {
    ...process.env,
    MCP_ACCESS_KEY: "x".repeat(64),
    OPENROUTER_API_KEY: "sk-stub",
    // A hosted name with a key: not dialled without --deep. The default base
    // is the loopback, which preflight dials since SMD-1875 and which reaches
    // nothing in CI; this suite's subject is the search_path.
    OB1_LLM_BASE_URL: "https://provider.invalid/v1",
    OB1_STORE: "sql",
    DATABASE_URL: URL_,
    SUPABASE_URL: undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) clean[k] = String(v);
  return runScript(["bun", join(SERVER, "preflight.ts")], { cwd: SERVER, env: clean });
}

/** `url` with an options= value on it: the connection string that sets the session's path. */
const withOptions = (url: string, value: string | undefined) => `${url}${url.includes("?") ? "&" : "?"}options=${value}`;

/** A fresh session that has NOT added the schema — the state the server's connection is in. */
async function freshSession<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL({ url: URL_, max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

/** [4]'s printed statement, which [6] runs. */
let printedFix: string | undefined;

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
      // …and the last write through the FUNCTIONS, in this off-path session:
      // a text capture, an edit and a delete. A plpgsql body that declares a
      // `vector` local by name compiles in the caller's session and fails
      // here with `type "vector" does not exist` — 060's projector did until
      // its first review pass, and no raw INSERT above could have said so.
      const fn = (await sql`SELECT upsert_thought('written through the functions, off-path', '{"metadata": {"source": "test"}}'::jsonb) AS r`)[0].r as { id: string };
      // The edit carries windows: their vectors are assigned through the
      // column's type, not cast to `vector` by name (046's cast failed here).
      const windows = [{ content: "a window", embedding: `[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]`, context: null }];
      const ed = (await sql`SELECT update_thought(${fn.id}::uuid, 'written through the functions, off-path, edited', NULL, NULL, ${windows}::jsonb, NULL, NULL, NULL, NULL, NULL) AS r`)[0].r as { ok: boolean };
      const [{ c: windowRows }] = await sql`SELECT count(*)::int AS c FROM thought_chunks WHERE thought_id = ${fn.id}::uuid`;
      const dl = (await sql`SELECT delete_thought(${fn.id}::uuid, NULL, false) AS r`)[0].r as { ok: boolean };
      assert(ed.ok === true && Number(windowRows) === 1 && dl.ok === true, "a text capture, an edit with a window and a delete through the write functions run in the off-path session — no body 060 defines names the vector type where the session cannot resolve it (the 4-argument capture's window INSERT is 013's and still does)");
      // …and a capture WITH a vector, bound through the relocated type's own
      // schema: the snapshot trigger's write runs in this session too.
      const withVec = (await sql.unsafe(`SELECT upsert_thought('written with a vector, off-path', '{"metadata": {"source": "test"}, "embedding_model": "${OPTS.model}"}'::jsonb, '[${[1, ...new Array(OPTS.dim - 1).fill(0)].join(",")}]'::${SCHEMA}.vector) AS r`))[0].r as { id: string };
      const [{ c: snapRows }] = await sql`SELECT count(*)::int AS c FROM ob1_embedding_snapshot s JOIN thoughts t ON t.content_fingerprint = s.content_fingerprint WHERE t.id = ${withVec.id}::uuid`;
      assert(Number(snapRows) === 1, "a capture with a vector in the off-path session feeds the snapshot — the trigger's casts resolve by type, not by name");
      await sql`SELECT delete_thought(${withVec.id}::uuid, NULL, false)`;  // the row count below is the raw rows'
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
    // The login role's setting in this database, its path kept and the schema
    // added once — never a plain ALTER ROLE or ALTER DATABASE, which a role's
    // setting in the database outranks (SMD-2238).
    printedFix = new RegExp(`(ALTER ROLE \\S+ IN DATABASE \\S+ SET search_path = "\\$user", public, "${SCHEMA}";)`).exec(r.out)?.[1];
    assert(!!printedFix && !/ALTER DATABASE .* SET search_path/.test(r.out),
           `…with the login role's setting in this database, the path kept and ${SCHEMA} added (${printedFix})`);
    // The whole line, so a remedy that ran anything beside the statement
    // (a RESET, say) — which [6], running the statement alone, would not see —
    // fails here (review pass 2).
    const vectorFix = r.out.split("\n").find((l) => /^\s*→ Put "ext" on the connection's search_path: /.test(l))?.trim();
    assert(vectorFix === `→ Put "${SCHEMA}" on the connection's search_path: ${printedFix}  Then reconnect. This adds a setting beside any hnsw.* bounds, it does not replace them.`,
           `…and the remedy line is that statement, then reconnect, and the note that it keeps the hnsw walk bounds (${vectorFix})`);
    // The two capture forms are matched by a signature built from pg_type's
    // names; regprocedure's text would spell `ext.vector` here and call the
    // present 3-argument form missing (SMD-1250, second review pass).
    assert(/atomic capture\s+the 2- and 3-argument upsert_thought present, both shipped/.test(r.out),
           "…while atomic capture still finds both upsert_thought forms with pgvector off the path");
  }

  console.log("\n[5] A role that cannot see the schema is told to GRANT, and to set the path only while it is off it");
  {
    // Off-path and no-USAGE both make the type unresolvable, but only the first
    // is fixed by SET search_path. A fresh non-superuser has no USAGE on ext (a
    // schema created by postgres grants none to PUBLIC), so preflight as that
    // role must name the GRANT, not send it round the search_path loop.
    const npw = "nousagepw";
    await freshSession(async (sql) => {
      // A run cut short leaves [5]'s grant on ext, which DROP ROLE refuses.
      await sql.unsafe(`DO $r$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_nousage') THEN EXECUTE 'DROP OWNED BY ob1_nousage'; END IF; END $r$`);
      await sql.unsafe(`DROP ROLE IF EXISTS ob1_nousage`);
      await sql.unsafe(`CREATE ROLE ob1_nousage LOGIN PASSWORD '${npw}'`);
      await sql.unsafe(`REVOKE USAGE ON SCHEMA ${SCHEMA} FROM ob1_nousage`); // insurance; PUBLIC has none anyway
    });
    const nurl = URL_.replace(/\/\/[^@]+@/, `//ob1_nousage:${npw}@`);
    const r = await preflight({ DATABASE_URL: nurl });
    assert(r.code === 1, `preflight as a role with no USAGE exits 1 (${r.code})`);
    assert(new RegExp(`vector extension.*has no USAGE on that schema`, "s").test(r.out),
           "…the vector extension check names the missing USAGE, not an off-path schema");
    const grant = new RegExp(`(GRANT USAGE ON SCHEMA ${SCHEMA} TO ob1_nousage;)  \\(as a role that can\\)`).exec(r.out)?.[1];
    const pathStmt = new RegExp(`then put it on the path: (ALTER ROLE ob1_nousage IN DATABASE \\S+ SET search_path = "\\$user", public, "${SCHEMA}";)  Then reconnect\\.\\n`).exec(r.out)?.[1];
    assert(!!grant && !!pathStmt, `…and the remedy is the GRANT, which SET search_path alone would not fix, then the path (${grant} | ${pathStmt})`);
    // The path from the connection string: the GRANT, then its options= value
    // in the one-sentence form the off-path branch prints (review pass 2).
    const viaOptions = await preflight({ DATABASE_URL: withOptions(nurl, "-csearch_path%3Dpublic") });
    const clientLine = viaOptions.out.split("\n").find((l) => /^\s*→ GRANT USAGE ON SCHEMA/.test(l))?.trim() ?? "";
    assert(new RegExp(`^→ GRANT USAGE ON SCHEMA ${SCHEMA} TO ob1_nousage;  \\(as a role that can\\)  The connection string sets search_path .*\\(separated by %20\\): -csearch_path%3Dpublic%2C%22${SCHEMA}%22  Then reconnect\\.$`).test(clientLine),
           `…and with the path from the connection string, the GRANT and then its options= value (${clientLine})`);
    // Followed in two steps: the path first, and the row then asks for the
    // GRANT alone — the schema on the path, "put it on the path" is not said.
    if (pathStmt) await freshSession((sql) => sql.unsafe(pathStmt));
    const onPath = await preflight({ DATABASE_URL: nurl });
    assert(new RegExp(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ob1_nousage;  \\(as a role that can\\)\\n`).test(onPath.out) && !/put it on the path/.test(onPath.out),
           `…and with ${SCHEMA} on its path, the GRANT alone`);
    if (grant) await freshSession((sql) => sql.unsafe(grant));
    const granted = await preflight({ DATABASE_URL: nurl });
    assert(!!grant && !!pathStmt && /vector extension\s+the vector type resolves/.test(granted.out),
           `…and both, run as printed, make the type resolve for it (${granted.out.split("\n").find((l) => /vector extension/.test(l))?.trim()})`);
  }

  console.log("\n[5b] A path from the connection string is replaced there, not overridden by ALTER ROLE");
  {
    const r = await preflight({ DATABASE_URL: withOptions(URL_, "-csearch_path%3D%22%24user%22%2Cpublic") });
    const value = new RegExp(`→ The connection string sets search_path .*\\(separated by %20\\): (-csearch_path%3D%22%24user%22%2Cpublic%2C%22${SCHEMA}%22)  Then reconnect\\.\\n`).exec(r.out)?.[1];
    assert(!!value, `a path from the connection string gets the options= value, with ${SCHEMA} added (${r.out.split("\n").find((l) => /connection string sets search_path/.test(l))?.trim()})`);
    const replaced = await preflight({ DATABASE_URL: withOptions(URL_, value) });
    assert(!!value && /vector extension\s+the vector type resolves/.test(replaced.out),
           "…and with the setting replaced as printed, the type resolves");
  }

  console.log("\n[5c] With public off the path too, the schema row and the vector row print one fix, which puts both on the path");
  {
    // thoughts and pgvector both off the connection's path: the schema row's
    // statement adds pgvector's schema as well, so the two rows agree, and the
    // one value, followed, puts both on the path (SMD-2238).
    const r = await preflight({ DATABASE_URL: withOptions(URL_, "-csearch_path%3Dnowhere") });
    const rowFix = (name: string) => {
      const ls = r.out.split("\n");
      const i = ls.findIndex((l) => new RegExp(`^\\s*[✓✗!·]\\s+${name}\\s`).test(l));
      return /-csearch_path%3D\S+/.exec(ls[i + 1] ?? "")?.[0];
    };
    const schemaValue = rowFix("schema"), vectorValue = rowFix("vector extension");
    assert(schemaValue === `-csearch_path%3D%22nowhere%22%2Cpublic%2C%22${SCHEMA}%22` && vectorValue === schemaValue,
           `both rows print one options= value, public and ${SCHEMA} added (${schemaValue} | ${vectorValue})`);
    const mended = await preflight({ DATABASE_URL: withOptions(URL_, schemaValue) });
    assert(!!schemaValue && /✓\s+schema\s+thoughts table reachable/.test(mended.out) && /vector extension\s+the vector type resolves/.test(mended.out),
           "…and with it in place, thoughts and the vector type both resolve");
  }

  console.log("\n[6] The printed fix makes preflight pass, and coexists with the hnsw bounds");
  {
    await freshSession(async (sql) => {
      // An hnsw bound on the row the fix writes — the login role's in this
      // database — first, then the fix preflight printed in [4], run as
      // printed: it adds the path beside the bound, not in its place. Load
      // pgvector through the schema-qualified type first, as a bare cast would
      // fail exactly as the server does, so the hnsw.* GUCs are known.
      await sql.unsafe(`SELECT '[1]'::${SCHEMA}.vector`);
      await sql.unsafe(`DO $r$ BEGIN EXECUTE format('ALTER ROLE %I IN DATABASE %I SET hnsw.max_scan_tuples = 40000', session_user, current_database()); END $r$`);
      if (printedFix) await sql.unsafe(printedFix);
    });

    const r = await preflight();
    assert(!!printedFix && r.code === 0, `with [4]'s statement run as printed, preflight passes (${r.code})`);
    assert(/vector extension\s+the vector type resolves/.test(r.out), "…the vector extension check is satisfied");

    const settings = await freshSession((sql) => sql`
      SELECT s.setrole = 0 AS "onDatabase", s.setconfig AS cfg FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = current_database() AND s.setrole IN (0, (SELECT oid FROM pg_roles WHERE rolname = session_user))`);
    const dbCfg = (settings.find((x: { onDatabase: boolean }) => x.onDatabase)?.cfg ?? []) as string[];
    const roleCfg = (settings.find((x: { onDatabase: boolean }) => !x.onDatabase)?.cfg ?? []) as string[];
    assert(roleCfg.some((c) => c.startsWith("search_path=")) && roleCfg.some((c) => c.startsWith("hnsw.max_scan_tuples=")),
           `the path and the hnsw bound are both the role's settings in the database, side by side (${roleCfg.join("; ")} | database: ${dbCfg.join("; ")})`);
  }
} finally {
  // ci-parity.sh shares one Postgres: leave pgvector in public, this role's
  // path and hnsw bound in the database ([6]) cleared, and the role [5] mints —
  // with its USAGE on ext and its setting here — dropped, whatever happened
  // above.
  await freshSession((sql) => sql.unsafe(`DO $r$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ob1_nousage') THEN EXECUTE 'DROP OWNED BY ob1_nousage'; END IF;
    EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET search_path', session_user, current_database());
    EXECUTE format('ALTER ROLE %I IN DATABASE %I RESET hnsw.max_scan_tuples', session_user, current_database());
  END $r$`));
  await freshSession((sql) => sql.unsafe(`DROP ROLE IF EXISTS ob1_nousage`));
  await restoreVectorToPublic(URL_);
  await dropSchema(URL_);
}

report();
