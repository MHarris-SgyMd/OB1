#!/usr/bin/env bun
/**
 * preflight.ts — fail a bad deployment before it serves traffic.
 *
 * Phase 4 of the migration. Without this the server starts happily when
 * misconfigured: `initialize` succeeds, `tools/list` returns every tool, and the
 * first real tool call returns "Error: OB1_STORE=sql requires DATABASE_URL" inside
 * a tool response. Every liveness probe reports green, including the container
 * healthcheck, because the HTTP layer genuinely is fine — the data layer is built
 * lazily on first use.
 *
 * On Supabase that mattered less: the platform injected SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY, so they could not be wrong. Off Supabase every one of
 * them is a hand-written environment variable, and the failure is silent until a
 * user tries to capture a thought.
 *
 * Run it as a deploy gate, an init container, or a readiness probe:
 *
 *   bun preflight.ts             # config + connectivity + schema
 *   bun preflight.ts --deep      # also calls the embedding provider (costs a token)
 *   bun preflight.ts --json      # machine-readable, for a pipeline step
 *
 * Exit codes: 0 all good, 1 something is wrong, 2 could not run the checks.
 */

import { createStore, type StoreEnv } from "./store.ts";
import { parseKeyRecords } from "./auth.ts";

type Status = "ok" | "fail" | "warn" | "skip";
type Check = { name: string; status: Status; detail: string; fix?: string };

const args = process.argv.slice(2);
const deep = args.includes("--deep");
const asJson = args.includes("--json");

const results: Check[] = [];
const add = (name: string, status: Status, detail: string, fix?: string) =>
  results.push({ name, status, detail, fix });

const env = process.env as Record<string, string | undefined>;
const store = (env.OB1_STORE ?? "postgrest").toLowerCase();
// Defaults come from db/config.mjs, not from copies. These four were hardcoded
// here and went stale the moment the defaults changed, so preflight validated
// openai/text-embedding-3-small @ 1536 while the server ran qwen3-embedding:4b @
// 1024 — a gate checking a configuration that was never going to run. It was
// invisible in the container only because compose sets every one of these
// explicitly.
const {
  DEFAULT_EMBEDDING_MODEL: DEF_EMB,
  DEFAULT_EMBEDDING_DIM: DEF_DIM,
  DEFAULT_METADATA_MODEL: DEF_META,
  DEFAULT_LLM_BASE_URL: DEF_BASE,
  isLocalHostname,
} = await import("../db/config.mjs");

const embModel = env.OB1_EMBEDDING_MODEL || DEF_EMB;
const embDim = env.OB1_EMBEDDING_DIM ? Number(env.OB1_EMBEDDING_DIM) : DEF_DIM;
const metaModel = env.OB1_METADATA_MODEL || DEF_META;
const llmBase = (env.OB1_LLM_BASE_URL || DEF_BASE).replace(/\/+$/, "");
const llmKey = env.OB1_LLM_API_KEY || env.OPENROUTER_API_KEY;

/**
 * A loopback or private-network endpoint — Ollama, LM Studio, vLLM on the same
 * host or compose network — needs no credential. Anything reachable over the
 * internet does, and a missing key there is a hard failure rather than a warning.
 */
function isLocalEndpoint(url: string): boolean {
  try {
    return isLocalHostname(new URL(url).hostname, ["ollama"]); // "ollama" is the compose service name
  } catch {
    return false;
  }
}
const localProvider = isLocalEndpoint(llmBase);

/**
 * Migration 014's exposure and remedy, once, for both store paths. The
 * PostgREST and SQL checks below used to each carry their own copy; the next
 * edit to either — say, when search_thoughts gains a filter input — would have
 * landed in one and left the two stores contradicting each other.
 */
const EXPOSURE =
  "a filtered match_thoughts call — direct SQL, a PostgREST RPC, or a community integration's metadata filter; the server's own search_thoughts sends no filter — silently returns fewer rows than match";
const APPLY_014 = "Apply the migrations through db/migrations/014_filtered_match_thoughts.sql.";
const CATALOG_HINT = "run once with OB1_STORE=sql to read the catalog";

// ── Configuration ────────────────────────────────────────────────────────────

if (store !== "postgrest" && store !== "sql") {
  add("store selection", "fail", `OB1_STORE="${store}" is not a known store`,
      'Set OB1_STORE to "postgrest" or "sql", or leave it unset for postgrest.');
} else {
  add("store selection", "ok", `OB1_STORE=${store}`);
}

// ── Model provider ──────────────────────────────────────────────────────────

add("model provider", "ok", `${llmBase}${localProvider ? " (local — no credential needed)" : ""}`);
{
  const { resolveEmbeddingDimensions } = await import("../db/config.mjs");
  const truncate = resolveEmbeddingDimensions(env.OB1_EMBEDDING_DIMENSIONS, embDim, embModel);
  add("embedding model", "ok",
      `${embModel} @ ${embDim} dimensions${truncate ? " (requesting truncation)" : ""}`);

  // Fatal contradictions (asking to widen, a dim over the HNSW ceiling) and the
  // non-fatal smell of truncating a model not trained for it. Both come from
  // db/config.mjs so the migration runner and the server cannot disagree.
  const { validateEmbeddingConfig, embeddingConfigWarnings } = await import("../db/config.mjs");
  for (const p of validateEmbeddingConfig(embDim, embModel, truncate)) {
    add("embedding config", "fail", p, "Fix OB1_EMBEDDING_DIM / OB1_EMBEDDING_MODEL / OB1_EMBEDDING_DIMENSIONS.");
  }
  for (const w of embeddingConfigWarnings(embDim, embModel, truncate)) {
    add("embedding config", "warn", w, "Benchmark it on your own corpus — see evals/README.md.");
  }
}
add("metadata model", "ok", metaModel);

if (!llmKey) {
  if (localProvider) {
    add("provider credential", "ok", "not required for a local endpoint");
  } else {
    add("provider credential", "fail",
        `no OB1_LLM_API_KEY or OPENROUTER_API_KEY, and ${llmBase} is not local`,
        "Set OB1_LLM_API_KEY, or point OB1_LLM_BASE_URL at a local provider.");
  }
} else {
  add("provider credential", "ok", `set (${llmKey.length} chars)`);
  if (localProvider) {
    add("provider credential", "warn", "a key is set but the endpoint is local — it will be sent anyway",
        "Unset it to keep local traffic credential-free.");
  }
}

// ── Access keys ──────────────────────────────────────────────────────────────

if (!env.MCP_ACCESS_KEYS && !env.MCP_ACCESS_KEY) {
  add("access keys", "fail", "neither MCP_ACCESS_KEYS nor MCP_ACCESS_KEY is set",
      "Mint one: bun keygen.ts --name laptop --scope write");
} else if (env.MCP_ACCESS_KEYS) {
  const { keys, problems } = parseKeyRecords(env.MCP_ACCESS_KEYS);
  if (problems.length) {
    for (const p of problems) add("access keys", "fail", p, "bun keygen.ts --name <client> --scope read|write");
  } else {
    const writers = keys.filter((k) => k.scope === "write").length;
    add("access keys", "ok",
        `${keys.length} key(s): ${keys.map((k) => `${k.name}(${k.scope})`).join(", ")}`);
    if (writers === 0) {
      add("access keys scope", "warn", "every key is read-only — capture_thought will not be registered for anyone",
          "Mint a write key if you intend to capture thoughts.");
    }
    if (writers === keys.length && keys.length > 1) {
      add("access keys scope", "warn", "every key can write",
          "Prefer --scope read for clients that only search, especially URL-embedded connectors.");
    }
  }
} else {
  // Legacy form: one raw key, full write access, stored in plaintext.
  add("access keys", "warn",
      "using the legacy single MCP_ACCESS_KEY — unhashed, unnamed, write scope, not individually revocable",
      "Move to MCP_ACCESS_KEYS: bun keygen.ts --name laptop --scope write");
  if (env.MCP_ACCESS_KEY!.length < 32) {
    add("access key strength", "warn",
        `${env.MCP_ACCESS_KEY!.length} chars — this key is the only thing protecting the endpoint`,
        "Generate 32 bytes: openssl rand -hex 32");
  }
}

if (store === "sql") {
  if (!env.DATABASE_URL) {
    add("DATABASE_URL", "fail", "not set, but OB1_STORE=sql", "Set DATABASE_URL, or use OB1_STORE=postgrest.");
  } else {
    add("DATABASE_URL", "ok", env.DATABASE_URL.replace(/:\/\/[^@]*@/, "://***@"));
  }
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (env[k]) add(k, "warn", "set but unused with OB1_STORE=sql", `Remove ${k} to avoid confusion about which backend is live.`);
  }
} else {
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!env[k]) add(k, "fail", `not set, but OB1_STORE=${store}`, `Set ${k}, or use OB1_STORE=sql with DATABASE_URL.`);
    else add(k, "ok", k.endsWith("URL") ? env[k]! : `set (${env[k]!.length} chars)`);
  }
}

const configFailed = results.some((r) => r.status === "fail");

// ── Connectivity and schema ──────────────────────────────────────────────────
// Only worth attempting once the configuration itself is coherent.

if (configFailed) {
  add("data layer", "skip", "skipped — fix the configuration above first");
  add("schema", "skip", "skipped — fix the configuration above first");
} else {
  let built: Awaited<ReturnType<typeof createStore>> | null = null;
  try {
    built = await createStore(env as StoreEnv);
    add("data layer", "ok", `${built.kind} store constructed`);
  } catch (e) {
    add("data layer", "fail", (e as Error).message, "Check the store configuration above.");
  }

  if (built) {
    /**
     * Every schema check below is gated on the SQL store, because they read
     * pg_proc and information_schema over a direct connection that the PostgREST
     * path does not have. That has been true since migration 004's check and is
     * a limitation of the deployment shape rather than of any one migration.
     *
     * It is called out here only for chunk context, because that is the setting
     * whose unchecked state is silent in a way the others are not: with the flag
     * on against a database still at 012, the RPC accepts the extra key and
     * ignores it, so blurbs reach the vector and nothing records that they did.
     * Every other gated check fails loudly at first use instead.
     */
    const { CHUNK_CONTEXT: wantCtxAnywhere } = await import("../db/config.mjs");
    if (built.kind !== "sql" && wantCtxAnywhere) {
      add("chunk context", "warn",
          "OB1_CHUNK_CONTEXT is on, but the PostgREST store cannot be checked against the schema from here — if migration 013 is not applied, every blurb is embedded and none is recorded",
          "Confirm db/migrations/013_chunk_context.sql is applied, or run preflight once with OB1_STORE=sql against the same database.");
    }
    // countThoughts is the cheapest call that proves the connection works, the
    // table exists and the credentials are accepted.
    let rowCount: number | null = null;
    try {
      const n = await built.countThoughts();
      rowCount = n;
      add("schema", "ok", `thoughts table reachable, ${n} row(s)`);
    } catch (e) {
      const msg = (e as Error).message;
      add("schema", "fail", msg,
          /does not exist|relation/i.test(msg)
            ? "Apply the migrations: cd db && bun migrate.ts --url $DATABASE_URL"
            : "Check credentials and network reachability to the database.");
    }

    /**
     * Migration 014 through PostgREST, where the catalog cannot be read. The
     * body can still be told apart from 007's: 007 evaluated a NULL filter as
     * `NULL = '{}' OR metadata @> NULL`, which excluded every row, and 014
     * treats NULL as unfiltered. So one RPC with `filter := null` against a
     * non-empty table returns a row under 014 and nothing under 007. That
     * proves the body, not the SET clauses — those need OB1_STORE=sql — and
     * the message says so. With no rows there is nothing to probe with, and
     * that is reported as a skip rather than as a permanent warning nobody can
     * clear (which is what the first version of this check was).
     *
     * The gap it guards is narrow: the server's own search_thoughts sends no
     * filter, so 007's recall loss reached only direct SQL, PostgREST RPC
     * callers and community code with a metadata filter of their own.
     */
    if (built.kind !== "sql") {
      if (rowCount === null) {
        add("filtered search", "skip", "not probed — the schema check above failed first");
      } else if (rowCount === 0) {
        add("filtered search", "skip", `no rows to probe with; ${CATALOG_HINT}`);
      } else {
        try {
          const probe = new Array(embDim).fill(0);
          probe[0] = 1;
          // Zero rows for a NULL filter proves 007's body only if the same
          // call WITH an empty filter returns something: a table whose rows all
          // lack an embedding (the 2-arg capture fallback leaves them that way)
          // returns nothing under either body, and must not be read as "014
          // missing" — that warning could never be cleared.
          const anyEmbedded = await built.matchThoughts({ embedding: probe, threshold: -1, limit: 1, filter: {} });
          const rows = anyEmbedded.length
            ? await built.matchThoughts({
                embedding: probe,
                threshold: -1,
                limit: 1,
                filter: null as unknown as Record<string, unknown>,
              })
            : [];
          if (!anyEmbedded.length) {
            add("filtered search", "skip", `${rowCount} row(s) but none with an embedding to probe with; ${CATALOG_HINT}`);
          } else if (rows.length >= 1) {
            add("filtered search", "ok",
                `match_thoughts treats a NULL filter as unfiltered, which only 014's body does (its SET clauses cannot be read over PostgREST — ${CATALOG_HINT})`);
          } else {
            // Over PostgREST the body cannot be read, and a NULL-filter miss has
            // two causes the SQL path tells apart by the body's sentinel: 014
            // not applied, or a later redefinition that kept the in-scan filter
            // and changed NULL handling. Re-running 014 over the second would
            // revert it, so the remedy names both (tenth review pass).
            add("filtered search", "warn",
                `match_thoughts returned nothing for a NULL filter, which every body before 014 does — either the migrations are not applied through 014 (then ${EXPOSURE}) or a later migration redefined match_thoughts and changed how a NULL filter is treated; over PostgREST the two cannot be told apart (${CATALOG_HINT})`,
                `If the ledger stops before 014: ${APPLY_014} If a later migration redefined match_thoughts, verify it kept the filter inside the scan rather than re-running 014 over it.`);
          }
        } catch (e) {
          // A failed probe is not evidence either way — a width mismatch or a
          // permission error says nothing about the body — so it is a skip.
          add("filtered search", "skip", `could not probe match_thoughts over PostgREST (${(e as Error).message}); ${CATALOG_HINT}`);
        }
      }
    }

    // The atomic capture path needs migration 004. Its absence is not fatal — the
    // PostgREST store falls back — but the fallback is the failure mode migration
    // 004 exists to remove, so say so.
    if (built.kind === "sql" && env.DATABASE_URL) {
      try {
        const { SQL } = await import("bun");
        const sql = new SQL({ url: env.DATABASE_URL, max: 1 });
        const rows = await sql`
          SELECT count(*)::int AS c FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'upsert_thought' AND n.nspname = 'public'`;
        const applied = await sql`
          SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name = 'schema_migrations'`;
        if (Number(rows[0].c) >= 2) add("atomic capture", "ok", "both upsert_thought overloads present");
        else add("atomic capture", "fail", `${rows[0].c} upsert_thought overload(s) — the 3-arg form is missing`,
                 "Apply db/migrations/004_upsert_thought_with_embedding.sql.");

        /**
         * The audit trail, treated as fatal for the same reason migration 004 is:
         * without it the server runs and captures succeed, and the only symptom
         * is history that was never recorded. Audit cannot describe events that
         * predate it, so serving unaudited for a week is a week that can never
         * be reconstructed — worse than a crashloop, which is at least visible.
         *
         * Checking the TRIGGER rather than the table: the table alone would pass
         * while nothing wrote to it.
         */
        const audit = await sql`
          SELECT count(*)::int AS c FROM pg_trigger
          WHERE tgname = 'thoughts_audit' AND NOT tgisinternal`;
        if (Number(audit[0].c) >= 1) add("audit trail", "ok", "thoughts_audit trigger present");
        else add("audit trail", "fail", "the thoughts_audit trigger is missing — mutations would go unrecorded",
                 "Apply db/migrations/008_thought_audit.sql.");

        /**
         * The agent registry, treated as a WARNING where audit is fatal.
         *
         * The distinction is not squeamishness. Without the audit trigger,
         * history is lost and cannot be reconstructed. Without migration 010,
         * every mutation is still attributed — by the key's name, in
         * actor_name, exactly as it was before 010 existed. What is lost is the
         * ability to survive a RENAME and the ability to revoke without a
         * redeploy, neither of which makes the running deployment wrong.
         *
         * Refusing to start over a feature whose absence degrades cleanly would
         * make applying migrations a hostage situation rather than an upgrade.
         */
        const registry = await sql`
          SELECT count(*)::int AS c FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'resolve_agent' AND n.nspname = 'public'`;
        if (Number(registry[0].c) >= 1) add("agent identity", "ok", "resolve_agent present");
        else add("agent identity", "warn",
                 "resolve_agent is missing — writes are attributed by key name only, and a rename would orphan the history",
                 "Apply db/migrations/010_agent_identity.sql.");

        /**
         * Migration 012's function, checked because the tool that calls it is
         * registered unconditionally.
         *
         * A server built after SMD-944 running against a database still at 011
         * advertises `search_thoughts_keyword` in tools/list and answers every
         * call to it with `function search_thoughts_keyword(unknown) does not
         * exist`. Nothing else notices: the handshake succeeds, the liveness
         * probe passes, the other eight tools work. That is precisely the
         * failure this file exists to convert into a startup message, and every
         * other migration that backs a registered feature is already checked
         * here — 004, 008, 010, 011. This one was missed.
         *
         * A failure rather than a warning, matching `atomic capture` and `audit
         * trail`: the absence does not degrade the tool, it breaks it. The
         * compose stack runs the migrator to completion before the server
         * starts, so the ordinary upgrade path never reaches this.
         */
        const keyword = await sql`
          SELECT count(*)::int AS c FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'search_thoughts_keyword' AND n.nspname = 'public'`;
        if (Number(keyword[0].c) >= 1) add("keyword search", "ok", "search_thoughts_keyword present");
        else add("keyword search", "fail",
                 "search_thoughts_keyword is missing, but the tool that calls it is registered — every call to it would fail",
                 "Apply db/migrations/012_search_thoughts_keyword.sql.");

        /**
         * Migration 014: the metadata filter is applied inside the HNSW scan,
         * which is correct only when the scan is iterative — hnsw.iterative_scan
         * in force for the call, normally as the function's own SET clause,
         * possibly inherited from the database or role — AND only for 014's
         * body. 007's body applies the filter after its LIMIT, and no setting
         * repairs that. So the BODY is decided first — by the sentinel comment
         * `ob1:filter-inside-scan` in pg_proc.prosrc, which every CREATE OR
         * REPLACE rewrites, with a NULL-filter probe beside it that gets its
         * own verdict when it disagrees — then the setting, then the version — the
         * version only explains an absence or advises `ALTER EXTENSION vector
         * UPDATE` where the catalog record lags a working library.
         *
         * The lookup matches its siblings — proname, namespace, argument count —
         * rather than casting a signature through search_path. The migration
         * ledger is consulted to word the remedy: "apply 014" is a no-op when
         * 014 is recorded and a later redefinition dropped the clause.
         *
         * Everything here has its own error boundary. These catalog reads can
         * fail on a hardened server (pg_available_extensions is not always
         * readable), and a throw must not be reported as "atomic capture" or
         * take the checks after this one down with it.
         *
         * A WARNING throughout: without the setting the tool still answers,
         * with the recall it had before 014.
         */
        try {
          const { versionAtLeast, HNSW_BOUNDS, HNSW_SEEDS, HNSW_SEED_MAX_SCAN_TUPLES, HNSW_SEED_SCAN_MEM_MULTIPLIER, BOUNDS_IN_FORCE_SQL } = await import("../db/config.mjs");
          // The one signature the servers call, resolved as the call would
          // resolve it; to_regprocedure is NULL rather than an error when it
          // is not defined, so "not defined" stays a verdict and not a throw.
          // (By name and arity, an earlier draft read the first of however
          // many 4-argument overloads existed.)
          const mt = await sql`
            SELECT array_to_string(p.proconfig, ',') AS cfg, p.prosrc AS src FROM pg_proc p
            WHERE p.oid = to_regprocedure('public.match_thoughts(vector, double precision, integer, jsonb)')`;
          // The body's semantics are declared by a sentinel comment in the body
          // itself, `ob1:filter-inside-scan`, which 014 carries and any successor
          // that keeps the in-scan filter must carry forward. In prosrc, not in
          // COMMENT ON FUNCTION: a replace rewrites the source but preserves
          // the OID that pg_description is keyed on, so a marker there survived
          // a successor that forgot its own COMMENT (eighth review pass). And
          // because a sentinel is still a claim, the behaviour it stands for is
          // probed too when there is a row to probe with: 014 treats a NULL
          // filter as unfiltered; every earlier body returned nothing for it.
          const sentinel = /ob1:filter-inside-scan/.test(String(mt[0]?.src ?? ""));
          let probed: boolean | null = null;
          if (mt.length) {
            try {
              const probe = new Array(embDim).fill(0);
              probe[0] = 1;
              const vec = `[${probe.join(",")}]`;
              const any = await sql`SELECT count(*)::int AS c FROM match_thoughts(${vec}::vector, -1.0, 1, ${{}}::jsonb)`;
              if (Number(any[0]?.c ?? 0) > 0) {
                const nul = await sql`SELECT count(*)::int AS c FROM match_thoughts(${vec}::vector, -1.0, 1, NULL::jsonb)`;
                probed = Number(nul[0]?.c ?? 0) > 0;
              }
            } catch {
              probed = null; // a call that fails proves nothing about the body
            }
          }
          // The sentinel and the probe answer different questions: the sentinel
          // is the successor's declaration that the filter sits inside the
          // scan; the probe checks one behaviour of 014's body (NULL is
          // unfiltered) that a successor may legitimately change. A sentinel
          // with a failed probe therefore gets its own verdict below, not the
          // pre-014 remedy — which would re-run 014 over the successor.
          const bodyIs014 = sentinel;
          const probeDisagrees = sentinel && probed === false;
          const cfgText = String(mt[0]?.cfg ?? "");
          const declared = /(^|,)hnsw\.iterative_scan=(relaxed_order|strict_order)(,|$)/.exec(cfgText)?.[2];
          const inherited = String((await sql`SELECT current_setting('hnsw.iterative_scan', true) AS v`)[0]?.v ?? "off");
          const inForce = declared ?? (inherited === "relaxed_order" || inherited === "strict_order" ? inherited : undefined);
          const pgv = await sql`
            SELECT e.extversion, a.default_version
            FROM pg_extension e LEFT JOIN pg_available_extensions a ON a.name = e.extname
            WHERE e.extname = 'vector'`;
          const installed = pgv.length ? String(pgv[0].extversion) : null;
          const available = pgv.length && pgv[0].default_version != null ? String(pgv[0].default_version) : null;
          const installedOld = installed !== null && !versionAtLeast(installed, 0, 8);
          const libraryNew = available !== null && versionAtLeast(available, 0, 8);
          let ledgerHas014 = false;
          try {
            const led = await sql`SELECT count(*)::int AS c FROM schema_migrations WHERE name LIKE '014\\_%'`;
            ledgerHas014 = Number(led[0]?.c ?? 0) > 0;
          } catch {
            /* no ledger */
          }
          const bounds = Object.fromEntries(
            (await sql.unsafe(BOUNDS_IN_FORCE_SQL)).map((r: { name: string; value: string | null }) => [r.name, r.value])
          ) as Record<string, string | null>;
          const boundsText = `walk bounded at ${bounds["hnsw.max_scan_tuples"] ?? "default"} tuples, memory x${bounds["hnsw.scan_mem_multiplier"] ?? "default"}`;
          // Whether the bounds are SET for THIS connection — from anywhere it
          // resolves them: ALTER DATABASE, ALTER ROLE on the server's role,
          // ALTER SYSTEM, a parameter group — not whether they are large, and
          // not merely whether a database-level row exists. An operator who
          // lowered one on purpose is tuning; one who set it on the role
          // because the platform refuses ALTER DATABASE has set it for the
          // role that matters here. (The migrator asks a different question —
          // set for EVERY role — and so does not count a role-level value.)
          // pg_settings.source is 'default' only when nothing has. The probe
          // above loaded pgvector, so hnsw.* rows are present; if the probe did
          // not run, load it here.
          await sql`SELECT '[1]'::vector`;
          // sql.array, not a bare `${HNSW_BOUNDS}`: Bun sends a bare array as
          // comma-joined text and Postgres rejects it (eleventh review pass).
          const srcRows = await sql`
            SELECT name, source FROM pg_settings WHERE name = ANY(${sql.array(HNSW_BOUNDS, "TEXT")})`;
          const boundsUnset = srcRows.length < HNSW_BOUNDS.length || srcRows.some((r: { source: string }) => r.source === "default");
          const seedBounds =
            `Run as the database owner, in one session: SELECT '[1]'::vector; ${Object.entries(HNSW_SEEDS).map(([n, v]) => `ALTER DATABASE <db> SET ${n} = ${v};`).join(" ")}  then restart the server so its pool reconnects.`;
          const putBack =
            "Put it back: SELECT '[1]'::vector; ALTER FUNCTION match_thoughts(vector, float, int, jsonb) SET hnsw.iterative_scan = relaxed_order;  and carry it into the migration that redefined it.";
          const staleRecord = installedOld && libraryNew;

          if (mt.length === 0) {
            add("filtered search", "warn", "match_thoughts is not defined, so nothing here can be checked", "Apply the migrations.");
          } else if (probeDisagrees) {
            add("filtered search", "warn",
                `match_thoughts declares the in-scan filter (sentinel present) but returned nothing for a NULL filter, which 014's body treats as unfiltered — a later redefinition changed NULL handling. Not a recall defect by itself; verify the redefinition was intended${inForce ? "" : ", and note no iterative scan is in force for it"}`,
                "If the redefinition is deliberate, no action; if not, compare the installed body with db/migrations/014_filtered_match_thoughts.sql.");
          } else if (bodyIs014 && inForce) {
            const source = declared ? "its own SET clause" : "hnsw.iterative_scan inherited from the database or role";
            if (boundsUnset) {
              add("filtered search", "warn",
                  `match_thoughts scans iteratively under a metadata filter (${inForce}, via ${source}) but the walk's bounds are at pgvector's defaults, set nowhere this connection resolves them from (${boundsText}; 014 seeds ${HNSW_SEED_MAX_SCAN_TUPLES} tuples, memory x${HNSW_SEED_SCAN_MEM_MULTIPLIER}) — on a large table a broad filter's walk returns short. 014's DO block could not seed them: a non-owner role, --baseline, or a platform refusing ALTER DATABASE`,
                  seedBounds);
            } else if (staleRecord) {
              add("filtered search", "warn",
                  `match_thoughts scans iteratively under a metadata filter (${inForce}, via ${source}; ${boundsText}) and works, but pg_extension records pgvector ${installed} while the server's library is ${available} — the extension was never updated after a binary upgrade`,
                  "ALTER EXTENSION vector UPDATE;  (advisable, not required for 014 — it keeps the catalog honest for the next migration that checks it)");
            } else {
              add("filtered search", "ok",
                  `match_thoughts scans iteratively under a metadata filter (${inForce}, via ${source}; ${boundsText}; pgvector ${installed ?? "unknown"})`);
            }
          } else if (bodyIs014) {
            add("filtered search", "warn",
                `match_thoughts has 014's body but no iterative scan in force${ledgerHas014 ? " although migration 014 is recorded as applied" : ""} — a later redefinition dropped its SET clause — so ${EXPOSURE}`,
                putBack);
          } else if (installedOld && !libraryNew) {
            add("filtered search", "warn",
                `pgvector ${installed} predates iterative HNSW scans, so migration 014 cannot apply and ${EXPOSURE} — near zero for a filter matching under 1% of the corpus`,
                `Upgrade the server's pgvector to 0.8.0 or later (deploy/compose.yaml pins 0.8.6), then ${ledgerHas014 ? "re-run the body of db/migrations/014_filtered_match_thoughts.sql — the migrator will skip it as already applied (--baseline recorded it)" : "apply db/migrations/014_filtered_match_thoughts.sql"}.`);
          } else {
            // The body predates 014. Say what IS on the function accurately: a
            // SET clause an operator added by hand is present and useless here.
            // Recorded without 014's body in place has two causes and the ledger
            // cannot tell them apart: `migrate.ts --baseline` records a migration
            // without running it (the documented route for a database built by
            // hand from the guide, whose match_thoughts is 007's), or a later
            // redefinition replaced the body. Name both (eleventh review pass).
            const dropped = ledgerHas014
              ? " although migration 014 is recorded as applied — --baseline recorded it without running it, or a later redefinition replaced its body"
              : " — migration 014 is not applied";
            const setting = declared
              ? `carries hnsw.iterative_scan=${declared} as a SET clause, which cannot help this body, whose LIMIT sits before the filter`
              : inForce
                ? `inherits hnsw.iterative_scan=${inForce} from the database or role, which cannot help this body, whose LIMIT sits before the filter`
                : "does not carry hnsw.iterative_scan";
            const stale = staleRecord ? `; pg_extension records pgvector ${installed} while the server's library is ${available}, so run ALTER EXTENSION vector UPDATE first` : "";
            add("filtered search", "warn",
                `match_thoughts ${setting}, and its body predates 014${dropped}${stale} — so ${EXPOSURE}`,
                ledgerHas014
                  ? "Re-run the body of db/migrations/014_filtered_match_thoughts.sql (the migrator will skip it as applied), or carry it into the migration that redefined match_thoughts."
                  : APPLY_014);
          }
        } catch (e) {
          add("filtered search", "warn", `could not verify: ${(e as Error).message}`,
              "The catalog reads behind this check need SELECT on pg_proc, pg_extension and pg_available_extensions.");
        }

        /**
         * Chunk context, checked in two directions because the flag and the
         * corpus can disagree in both.
         *
         * `OB1_CHUNK_CONTEXT` is read per capture, not at migration time, so a
         * server restarted with it on starts writing contextualized chunks
         * immediately. If migration 013 has not been applied, the column those
         * blurbs go into does not exist — and the chunk-writing functions from
         * 007 and 009 simply do not select the key, so every capture succeeds
         * while the context is dropped on the floor. The embedding includes the
         * blurb, the stored row does not record it, and nothing anywhere says
         * so. That is the one combination worth failing on.
         *
         * The other direction is a corpus holding both kinds of chunk, which is
         * legal, has no effect on any query, and is reported rather than
         * refused: it is what flipping the flag mid-life looks like, and the
         * only way to resolve it is a re-embed of the affected thoughts.
         */
        const { CHUNK_CONTEXT: wantContext } = await import("../db/config.mjs");
        const ctxCol = await sql`
          SELECT count(*)::int AS c FROM information_schema.columns
          WHERE table_name = 'thought_chunks' AND column_name = 'context'`;
        const haveCtxCol = Number(ctxCol[0].c) >= 1;
        if (wantContext && !haveCtxCol) {
          add("chunk context", "fail",
              "OB1_CHUNK_CONTEXT is on but thought_chunks.context does not exist — the chunk writers from 007 and 009 do not select the key, so every blurb would reach the VECTOR and none would be recorded: captures would silently become contextualized with nothing able to tell them apart from bare ones afterwards",
              "Apply db/migrations/013_chunk_context.sql.");
        } else if (!haveCtxCol) {
          add("chunk context", "ok", "off (migration 013 not applied)");
        } else {
          /**
           * Counted from the rows rather than read from ob1_config, because the
           * config row records what was INTENDED at the last migration and the
           * rows record what actually happened. Only the second one can be wrong
           * in a way anybody cares about.
           */
          const split = await sql`
            SELECT count(*) FILTER (WHERE context IS NOT NULL)::int AS with_ctx,
                   count(*)::int AS total
            FROM thought_chunks`;
          const withCtx = Number(split[0].with_ctx);
          const total = Number(split[0].total);
          const bare = total - withCtx;
          if (total === 0) {
            add("chunk context", "ok", `${wantContext ? "on" : "off"}, no chunks stored yet`);
          } else if (withCtx > 0 && bare > 0) {
            add("chunk context", "warn",
                `${withCtx} of ${total} chunks carry a situating context and ${bare} do not — the corpus was captured under both settings, so those thoughts are not ranked on comparable vectors`,
                "Re-capture the affected thoughts under one setting, or leave it: the effect is a ranking inconsistency, not an error.");
          } else if (withCtx === total && !wantContext) {
            add("chunk context", "warn",
                `all ${total} chunks carry a context but OB1_CHUNK_CONTEXT is off — the next long capture will be inconsistent with everything already stored`,
                "Set OB1_CHUNK_CONTEXT=on, or re-capture the existing thoughts.");
          } else if (bare === total && wantContext) {
            add("chunk context", "warn",
                `OB1_CHUNK_CONTEXT is on but none of the ${total} stored chunks has one — everything captured so far predates the setting`,
                "Expected right after turning it on; new captures will differ from old ones until they are re-embedded.");
          } else {
            add("chunk context", "ok", wantContext ? `on, ${withCtx}/${total} chunks` : `off, ${total} bare chunks`);
          }
        }

        /**
         * The trigram flag is read only when migration 011 applies. Migrations
         * run once, so someone who changes OB1_TRGM_INDEX against a database
         * that already has 011 in its ledger and re-runs the migrator gets a
         * clean "skipped, already applied" and no change to the index. That is a
         * silent no-op on an explicit instruction, which is exactly the kind of
         * quiet this fork keeps removing — so the two are compared here.
         *
         * This matters more since SMD-944 flipped the default to on: every
         * deployment that applied 011 before then is in the mismatched state by
         * default, with a working `search_thoughts_keyword` that sequentially
         * scans. This check is the only thing that tells them.
         *
         * A warning either way, never a failure: the index changes how fast a
         * pattern match runs, never what it returns. Refusing to serve over it
         * would be absurd.
         */
        const { TRGM_INDEX: wantTrgm } = await import("../db/config.mjs");
        const trgmIdx = await sql`
          SELECT count(*)::int AS c FROM pg_indexes
          WHERE tablename = 'thoughts' AND indexname = 'idx_thoughts_content_trgm'`;
        const haveTrgm = Number(trgmIdx[0].c) >= 1;
        if (wantTrgm === haveTrgm) {
          add("trigram index", "ok", haveTrgm ? "enabled and present" : "disabled (OB1_TRGM_INDEX=off)");
        } else if (wantTrgm) {
          add("trigram index", "warn",
              "OB1_TRGM_INDEX is on but idx_thoughts_content_trgm does not exist — migration 011 already applied with it off, so the setting is doing nothing and search_thoughts_keyword sequentially scans",
              "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_thoughts_content_trgm ON thoughts USING gin (content gin_trgm_ops);");
        } else {
          add("trigram index", "warn",
              "idx_thoughts_content_trgm exists but OB1_TRGM_INDEX is off — every capture pays for an index this configuration says it does not want",
              "DROP INDEX CONCURRENTLY IF EXISTS idx_thoughts_content_trgm;  (or set OB1_TRGM_INDEX=on)");
        }
        // ob1_config records the width and model the schema was created with.
        // A same-width model from a different family produces numerically valid,
        // semantically meaningless vectors — search degrades and nothing errors.
        let recorded: Record<string, string> = {};
        try {
          const cfg = await sql`
            SELECT key, value FROM ob1_config WHERE key IN ('embedding_dim','embedding_model')`;
          recorded = Object.fromEntries((cfg as { key: string; value: string }[]).map((r) => [r.key, r.value]));
        } catch (e) {
          // Never swallow this: a silent catch here previously made the whole
          // embedding-contract check disappear without a trace.
          add("embedding contract", "warn", `could not read ob1_config: ${(e as Error).message}`,
              "Apply db/migrations/006_embedding_config.sql.");
        }
        if (recorded.embedding_dim && Number(recorded.embedding_dim) !== embDim) {
          add("embedding contract", "fail",
              `schema was built for ${recorded.embedding_dim} dimensions, but OB1_EMBEDDING_DIM=${embDim}`,
              "Match the running config to the schema, or migrate and re-embed.");
        } else if (recorded.embedding_model && recorded.embedding_model !== embModel) {
          add("embedding contract", "warn",
              `schema was built with ${recorded.embedding_model}, now configured for ${embModel}`,
              "Same width, different family: existing vectors are not comparable to new ones. Re-embed.");
        } else if (recorded.embedding_dim) {
          add("embedding contract", "ok", `${recorded.embedding_model} @ ${recorded.embedding_dim} dimensions, matching`);
        }

        if (Number(applied[0].c) === 0)
          add("migration ledger", "warn", "no schema_migrations table — the schema was applied by hand",
              "Adopt it with: cd db && bun migrate.ts --url $DATABASE_URL --baseline");
        else add("migration ledger", "ok", "schema_migrations present");

        await sql.close();
      } catch (e) {
        add("atomic capture", "warn", `could not verify: ${(e as Error).message}`);
      }
    }

    await built.close();
  }
}

// ── Optional: the model provider ─────────────────────────────────────────────

if (!deep) {
  add("embedding provider", "skip", "not checked — pass --deep to call OpenRouter");
} else if (!llmKey && !localProvider) {
  add("embedding provider", "skip", "no credential to test with");
} else {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (llmKey) headers.Authorization = `Bearer ${llmKey}`;

    const { resolveEmbeddingDimensions: resolveDims } = await import("../db/config.mjs");
    const wantsTruncation = resolveDims(env.OB1_EMBEDDING_DIMENSIONS, embDim, embModel);
    const r = await fetch(`${llmBase}/embeddings`, {
      method: "POST",
      headers,
      // Send exactly what the server will send. Omitting `dimensions` here would
      // let preflight pass against a provider that ignores or rejects it, and the
      // failure would surface on the first real capture instead.
      body: JSON.stringify({
        model: embModel,
        input: "preflight",
        ...(wantsTruncation ? { dimensions: embDim } : {}),
      }),
    });
    if (!r.ok) {
      add("embedding provider", "fail", `OpenRouter returned ${r.status}`,
          r.status === 401 ? "The key is rejected. Check OPENROUTER_API_KEY." : "Check OpenRouter status and credit balance.");
    } else {
      const d = (await r.json()) as { data?: [{ embedding?: number[] }] };
      const dim = d.data?.[0]?.embedding?.length;
      if (dim === embDim) add("embedding provider", "ok", `${embModel} returns ${dim} dimensions, matching the schema`);
      else if (wantsTruncation)
        add("embedding provider", "fail",
            `${embModel} returned ${dim} dimensions despite being asked for ${embDim}`,
            "The provider ignored the `dimensions` parameter. Unset OB1_EMBEDDING_DIMENSIONS and " +
            `set OB1_EMBEDDING_DIM=${dim}, or choose a provider that honours it.`);
      else add("embedding provider", "fail", `${embModel} returned ${dim} dimensions, but the schema is vector(${embDim})`,
               `Set OB1_EMBEDDING_DIM=${dim} before any data exists, choose a model that returns ${embDim}, ` +
               (dim && dim > embDim ? "or set OB1_EMBEDDING_DIMENSIONS=on if the model supports truncation." : "."));

      // Metadata extraction needs JSON mode. Providers differ here — Ollama's
      // OpenAI layer has been inconsistent about response_format — and a provider
      // that ignores it degrades every capture to "uncategorized" without failing.
      const m = await fetch(`${llmBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: metaModel,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: 'Reply with only this JSON: {"ok":true}' }],
        }),
      });
      if (!m.ok) {
        add("metadata model", "fail", `${metaModel} returned ${m.status} from ${llmBase}`,
            "Capture would still succeed, but every thought would be tagged uncategorized.");
      } else {
        const md = (await m.json()) as { choices?: [{ message?: { content?: string } }] };
        const content = md.choices?.[0]?.message?.content ?? "";
        try {
          const parsed = JSON.parse(content);
          add("metadata model", typeof parsed === "object" && parsed !== null ? "ok" : "warn",
              typeof parsed === "object" && parsed !== null
                ? `${metaModel} honours JSON mode`
                : `${metaModel} returned JSON that is not an object`);
        } catch {
          add("metadata model", "warn", `${metaModel} did not return parseable JSON in JSON mode`,
              "Captures will still work but will fall back to uncategorized metadata.");
        }
      }
    }
  } catch (e) {
    add("embedding provider", "fail", (e as Error).message, "Network reachability to openrouter.ai.");
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

const failed = results.filter((r) => r.status === "fail");
const warned = results.filter((r) => r.status === "warn");

if (asJson) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
} else {
  const glyph: Record<Status, string> = { ok: "✓", fail: "✗", warn: "!", skip: "·" };
  for (const r of results) {
    console.log(`  ${glyph[r.status]}  ${r.name.padEnd(26)} ${r.detail}`);
    if (r.fix && r.status !== "ok") console.log(`     → ${r.fix}`);
  }
  console.log(`\n${"─".repeat(52)}`);
  console.log(
    failed.length === 0
      ? `preflight OK${warned.length ? ` (${warned.length} warning${warned.length > 1 ? "s" : ""})` : ""}\n`
      : `preflight FAILED — ${failed.length} problem${failed.length > 1 ? "s" : ""}\n`
  );
}

process.exit(failed.length === 0 ? 0 : 1);
