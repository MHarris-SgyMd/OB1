#!/usr/bin/env bun
/**
 * preflight.ts — fail a bad deployment before it serves traffic.
 *
 * Phase 4 of the migration. Without this the server starts happily when
 * misconfigured: `initialize` succeeds, `tools/list` returns all six tools, and the
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

// ── Configuration ────────────────────────────────────────────────────────────

if (store !== "postgrest" && store !== "sql") {
  add("store selection", "fail", `OB1_STORE="${store}" is not a known store`,
      'Set OB1_STORE to "postgrest" or "sql", or leave it unset for postgrest.');
} else {
  add("store selection", "ok", `OB1_STORE=${store}`);
}

for (const key of ["MCP_ACCESS_KEY", "OPENROUTER_API_KEY"]) {
  if (!env[key]) {
    add(key, "fail", "not set", `Provide ${key} in the environment or your secret store.`);
  } else {
    add(key, "ok", `set (${env[key]!.length} chars)`);
  }
}

// A short access key is the whole authentication story for this server; there is
// no second factor behind it.
if (env.MCP_ACCESS_KEY && env.MCP_ACCESS_KEY.length < 32) {
  add("MCP_ACCESS_KEY strength", "warn",
      `${env.MCP_ACCESS_KEY.length} chars — this key is the only thing protecting the endpoint`,
      "Generate 32 bytes: openssl rand -hex 32");
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
    // countThoughts is the cheapest call that proves the connection works, the
    // table exists and the credentials are accepted.
    try {
      const n = await built.countThoughts();
      add("schema", "ok", `thoughts table reachable, ${n} row(s)`);
    } catch (e) {
      const msg = (e as Error).message;
      add("schema", "fail", msg,
          /does not exist|relation/i.test(msg)
            ? "Apply the migrations: cd db && bun migrate.ts --url $DATABASE_URL"
            : "Check credentials and network reachability to the database.");
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
        await sql.close();
        if (Number(rows[0].c) >= 2) add("atomic capture", "ok", "both upsert_thought overloads present");
        else add("atomic capture", "fail", `${rows[0].c} upsert_thought overload(s) — the 3-arg form is missing`,
                 "Apply db/migrations/004_upsert_thought_with_embedding.sql.");
        if (Number(applied[0].c) === 0)
          add("migration ledger", "warn", "no schema_migrations table — the schema was applied by hand",
              "Adopt it with: cd db && bun migrate.ts --url $DATABASE_URL --baseline");
        else add("migration ledger", "ok", "schema_migrations present");
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
} else if (!env.OPENROUTER_API_KEY) {
  add("embedding provider", "skip", "no key to test with");
} else {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "preflight" }),
    });
    if (!r.ok) {
      add("embedding provider", "fail", `OpenRouter returned ${r.status}`,
          r.status === 401 ? "The key is rejected. Check OPENROUTER_API_KEY." : "Check OpenRouter status and credit balance.");
    } else {
      const d = (await r.json()) as { data?: [{ embedding?: number[] }] };
      const dim = d.data?.[0]?.embedding?.length;
      if (dim === 1536) add("embedding provider", "ok", "returns 1536 dimensions, matching vector(1536)");
      else add("embedding provider", "fail", `returned ${dim} dimensions, but the schema is vector(1536)`,
               "A different embedding model needs a schema change and a full re-embed.");
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
