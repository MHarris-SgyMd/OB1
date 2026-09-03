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
    const h = new URL(url).hostname;
    return (
      h === "localhost" || h === "127.0.0.1" || h === "::1" ||
      h === "host.docker.internal" || h === "host.containers.internal" ||
      h === "ollama" ||                       // the compose service name
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  } catch {
    return false;
  }
}
const localProvider = isLocalEndpoint(llmBase);

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
