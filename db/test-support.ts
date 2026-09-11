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
import { DEFAULT_TRGM_INDEX, HNSW_BOUNDS, MATCH_THOUGHTS_SIGNATURE, SEARCH_THOUGHTS_HYBRID_SIGNATURE, SUPERSEDED_SIGNATURES, UPDATE_THOUGHT_SIGNATURE, migrationValues, quoteIdent, substituteMigration } from "./config.mjs";
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
  "ob1_entity_edges",
  "thought_entities",
  "ob1_entities",
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
  UPDATE_THOUGHT_SIGNATURE,
  "delete_thought(uuid, jsonb)",
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
  const p = Bun.spawn(cmd, { ...(opts.env ? { env: opts.env } : {}), stdout: "pipe", stderr: "pipe", cwd: opts.cwd });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
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
 * capped collection of matching ids that runs on EVERY filtered call. It is a
 * plpgsql SELECT INTO rather than a RETURN QUERY, so it is extracted on its own.
 */
export type Branch = "unfiltered" | "walk" | "exact" | "route";

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

export async function extractBody(sql: SQL, branch: Branch, dim: number): Promise<string> {
  const [{ def }] = await sql.unsafe(`SELECT pg_get_functiondef($1::oid) AS def`, [await matchThoughtsOid(sql)]);
  let block: string | undefined;
  if (branch === "route") {
    // `SELECT array_agg(s.id) INTO v_ids FROM (...) s;` — minus the INTO.
    const m = /SELECT array_agg\(s\.id\) INTO v_ids\s+(FROM \([\s\S]*?\) s);/.exec(def);
    if (!m) throw new Error("match_thoughts has no `SELECT array_agg(s.id) INTO v_ids` routing statement; the bench's rewrite does not apply");
    block = `SELECT array_agg(s.id) ${m[1]}`;
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
  // that statement in as a scalar subquery so the explained text stands alone —
  // before the locals are substituted, since that statement uses v_exact.
  const route = /SELECT array_agg\(s\.id\) INTO v_ids\s+(FROM \([\s\S]*?\) s);/.exec(def);
  if (route) body = body.replace(/\bv_ids\b/g, () => `((SELECT array_agg(s.id) ${route[1]})::uuid[])`);
  const declared = /DECLARE([\s\S]*?)BEGIN/.exec(def)?.[1] ?? "";
  const locals: [string, string][] = [];
  for (const line of declared.split("\n")) {
    // `name  type words  := expr;` — the type may be several words
    // (`double precision`, `timestamp with time zone`).
    const d = /^\s*(\w+)\s+[\w ]+?\s*:=\s*(.+);\s*$/.exec(line);
    if (d) locals.push([d[1], d[2]]);
  }
  // Replacer FUNCTIONS throughout: a replacement string would interpret `$1`,
  // `$&` or `$$` inside an expression as a pattern, and 014's SQL is one `$$`
  // away from that. Locals may reference earlier locals (v_fetch is built from
  // v_count), so substitute until none remain rather than in one pass.
  for (let pass = 0; pass < locals.length + 1; pass++) {
    for (const [name, expr] of locals) body = body.replace(new RegExp(`\\b${name}\\b`, "g"), () => `(${expr})`);
  }
  // 020's two parameters are $5 and $6; a body from before 020 (a bench's
  // "before" arm) reads neither, and a PREPARE that declares them is still
  // valid, so every explainer passes six arguments.
  body = body
    .replace(/\bquery_embedding\b/g, () => `$1::vector(${dim})`)
    .replace(/\bmatch_threshold\b/g, () => "$2::float")
    .replace(/\bmatch_count\b/g, () => "$3::int")
    .replace(/\bfilter\b/g, () => "$4::jsonb")
    .replace(/\brecency_weight\b/g, () => "$5::float")
    .replace(/\bhalf_life_days\b/g, () => "$6::float");
  const leftover = /\b(v_\w+)\b/.exec(body);
  if (leftover) throw new Error(`unrewritten local ${leftover[1]} in match_thoughts body`);
  return body;
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
 */
export async function explainPrepared(
  tx: SQL,
  opts: { body: string; dim: number; args: string; mode: "force_custom_plan" | "force_generic_plan"; warm?: boolean }
): Promise<{ text: string; ms: number; buffers: number }> {
  await tx.unsafe(`SET LOCAL plan_cache_mode = ${opts.mode}`);
  await tx.unsafe(`PREPARE ob1_explain(vector(${opts.dim}), float, int, jsonb, float, float) AS ${opts.body}`);
  if (opts.warm) await tx.unsafe(`EXECUTE ob1_explain(${opts.args})`);
  const rows = await tx.unsafe(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) EXECUTE ob1_explain(${opts.args})`);
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
export function buffersOf(plan: string): number {
  const m = /Buffers: shared(?: hit=(\d+))?(?: read=(\d+))?/.exec(plan);
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
