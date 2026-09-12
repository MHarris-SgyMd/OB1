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
import { createClient } from "@supabase/supabase-js";
import { parseKeyRecords } from "./auth.ts";
import type { PassCounts } from "../db/config.mjs";

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
// Every check the direct-connection block owns, in the order it reports them.
// A throw anywhere in that block lands in one catch, and a check that prints
// nothing looks like one that passed — so the catch reports each of these
// that has not reported yet, rather than one name for whatever went wrong.
const DIRECT_CHECKS = [
  "vector extension",
  "atomic capture", "chunk delete privilege", "fingerprint backfill", "audit trail", "agent identity",
  "keyword search", "hybrid search", "stats summary", "provenance", "search signatures", "edit signature", "filtered search",
  "candidate scan", "chunk context", "trigram index", "embedding contract", "vector models",
  "updated_at trigger", "re-embed pass", "migration ledger",
];
const APPLY_020 = "Apply db/migrations/020_match_thoughts_recency.sql.";
/**
 * PostgREST answers a call it cannot resolve with PGRST202 both when the
 * function is missing and while its schema cache predates the migration that
 * added it — so a remedy that says only "apply" would send an operator who
 * has just applied it back to the migrator (first review pass of 021).
 */
const RELOAD_HINT = "If the ledger already records it, PostgREST may not have reloaded its schema cache: NOTIFY pgrst, 'reload schema';";
const APPLY_020_POSTGREST = `Apply the migrations through db/migrations/020_match_thoughts_recency.sql against the project's direct connection (server-portable/README.md §4). ${RELOAD_HINT}`;
const APPLY_021 = "Apply db/migrations/021_embedding_model_per_row.sql.";
const APPLY_021_POSTGREST = `Apply the migrations through db/migrations/021_embedding_model_per_row.sql against the project's direct connection (server-portable/README.md §4). ${RELOAD_HINT}`;
/** PostgREST's wording for a function it cannot resolve — missing, or not at the argument shape sent. */
const missing = (msg: string) => /could not find the function|does not exist/i.test(msg);

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
                `If the ledger stops before 014 — including a Supabase project built from the guide, which has never run the fork's migrator — apply db/migrations through 014 against the project's direct connection (server-portable/README.md §4). If a later migration redefined match_thoughts, verify it kept the filter inside the scan rather than re-running 014 over it.`);
          }
        } catch (e) {
          // A failed probe is not evidence either way — a width mismatch or a
          // permission error says nothing about the body — so it is a skip. A
          // function PostgREST cannot resolve at the shape the store sends is
          // the `search signatures` check's finding, and it says so.
          const msg = (e as Error).message;
          add("filtered search", "skip", missing(msg)
            ? `match_thoughts does not take the arguments the server sends over PostgREST — the search signatures check below says whether it is missing or predates migration 020`
            : `could not probe match_thoughts over PostgREST (${msg}); ${CATALOG_HINT}`);
        }
      }
    }

    /**
     * Migration 017 through PostgREST. `search` and `search_thoughts` call
     * `search_thoughts_hybrid` unconditionally since SMD-958, and PostgREST is
     * the default store, so a Supabase project whose migrations stop at 016
     * would pass every check here, advertise both tools, and fail every call to
     * them. The catalog cannot be read over PostgREST, but the function can be
     * called: an RPC with an empty query text and a unit vector returns rows or
     * nothing under 017, and "Could not find the function" without it. The
     * first version of this check lived only on the SQL branch (review pass).
     */
    if (built.kind !== "sql") {
      if (rowCount === null) {
        add("keyword search", "skip", "not probed — the schema check above failed first");
        add("hybrid search", "skip", "not probed — the schema check above failed first");
        add("search signatures", "skip", "not probed — the schema check above failed first");
      } else {
        // 012 first, because 017 calls it: a missing search_thoughts_keyword
        // surfaces inside search_thoughts_hybrid with the same "does not
        // exist" wording, and a check that only probed 017 would send the
        // operator to re-apply the wrong migration (review pass).
        let keywordOk = false;
        try {
          await built.keywordThoughts({ query: "ob1-preflight-probe-zylotrope", limit: 1, offset: 0, filter: {} });
          keywordOk = true;
          add("keyword search", "ok", "search_thoughts_keyword answers over PostgREST");
        } catch (e) {
          const msg = (e as Error).message;
          if (missing(msg)) {
            add("keyword search", "fail",
                "search_thoughts_keyword is missing, but the tool that calls it is registered — every call to it, and every search through search_thoughts_hybrid, would fail",
                "Apply db/migrations/012_search_thoughts_keyword.sql against the project's direct connection (server-portable/README.md §4).");
          } else {
            add("keyword search", "skip", `could not probe search_thoughts_keyword over PostgREST (${msg}); ${CATALOG_HINT}`);
          }
        }
        try {
          const probe = new Array(embDim).fill(0);
          probe[0] = 1;
          await built.hybridThoughts({ query: "", embedding: probe, threshold: -1, limit: 1, filter: {} });
          add("hybrid search", "ok", "search_thoughts_hybrid answers over PostgREST");
        } catch (e) {
          const msg = (e as Error).message;
          if (missing(msg) && (/search_thoughts_keyword/.test(msg) || !keywordOk)) {
            add("hybrid search", "fail",
                "search_thoughts_hybrid cannot run because search_thoughts_keyword is missing — every semantic search would fail",
                "Apply db/migrations/012_search_thoughts_keyword.sql first; 017 is present or will run once it is.");
          } else if (missing(msg)) {
            // The probe sends 020's two extra arguments, so over PostgREST a
            // function from before 020 reads exactly like a missing one.
            add("hybrid search", "fail",
                "search_thoughts_hybrid is missing, or is the form from before migration 020 (the server sends recency_weight and half_life_days, which only 020's takes) — either way search and search_thoughts, which call it, would fail on every call",
                APPLY_020_POSTGREST);
          } else {
            add("hybrid search", "skip", `could not probe search_thoughts_hybrid over PostgREST (${msg}); ${CATALOG_HINT}`);
          }
        }
        /**
         * Migration 020's other failure state, over PostgREST. The store's own
         * calls send every argument by name and resolve uniquely whatever else
         * is defined, so the probes above cannot see a 4-argument match_thoughts
         * re-created BESIDE 020's by a hand re-apply of 007/014/019 — while every
         * PostgREST caller that sends the four arguments the old form took (the
         * community integrations, a dashboard) fails with PGRST203 on every
         * call. So probe as such a caller would: four named arguments, count 1.
         * One function resolves it through its defaults; two make PostgREST
         * refuse to choose. The SQL branch reads pg_proc instead (first review
         * pass of 020 — this check lived only there).
         */
        // A client of its own for the probes below, which call as an outside
        // caller would — by name, with the arguments an older form took — rather
        // than through the store's own shape.
        const legacy = createClient(env.SUPABASE_URL ?? "", env.SUPABASE_SERVICE_ROLE_KEY ?? "");
        try {
          const probe = new Array(embDim).fill(0);
          probe[0] = 1;
          // 020's form first, with every argument by name — the store's own
          // call — so a database whose only match_thoughts predates 020 is
          // reported as such rather than passing the 4-argument probe below
          // (second review pass). Then the 4-argument call, which only two
          // overloads make ambiguous.
          let current = "";
          try {
            await built.matchThoughts({ embedding: probe, threshold: -1, limit: 1, filter: {} });
          } catch (e) {
            current = (e as Error).message;
          }
          const { error } = current ? { error: null } : await legacy.rpc("match_thoughts", { query_embedding: probe, match_threshold: -1, match_count: 1, filter: {} });
          if (current && missing(current)) {
            add("search signatures", "fail",
                "match_thoughts does not take recency_weight and half_life_days over PostgREST — it is missing or is the form from before migration 020 — and the server sends them on every search, so every search would fail",
                APPLY_020_POSTGREST);
          } else if (current) {
            add("search signatures", "skip", `could not probe match_thoughts over PostgREST (${current}); ${CATALOG_HINT}`);
          } else if (!error) {
            add("search signatures", "ok", "match_thoughts takes 020's arguments over PostgREST, and a 4-argument call resolves to one function — no earlier form beside it");
          } else if (/could not choose|PGRST203|not unique/i.test(error.message)) {
            add("search signatures", "fail",
                "match_thoughts has more than one form — an earlier migration re-applied by hand beside 020's — and PostgREST cannot choose between them for a 4-argument call, so every caller sending four arguments fails",
                "DROP FUNCTION match_thoughts(vector, float, int, jsonb); against the project's direct connection — the form 020 drops.");
          } else if (missing(error.message)) {
            add("search signatures", "fail", "match_thoughts is missing over PostgREST — every search would fail",
                APPLY_020_POSTGREST);
          } else {
            add("search signatures", "skip", `could not probe match_thoughts over PostgREST (${error.message}); ${CATALOG_HINT}`);
          }
        } catch (e) {
          add("search signatures", "skip", `could not probe match_thoughts over PostgREST (${(e as Error).message}); ${CATALOG_HINT}`);
        }

        /**
         * Migration 021 gave update_thought an eighth parameter, the model
         * beside the vector, by dropping the 7-argument form — and the store
         * sends all eight by name on every edit. Probed as the store calls it,
         * with an id no row has: update_thought answers {ok:false,
         * error:'NOT_FOUND'} from its FOR UPDATE read and writes nothing, so
         * the probe is free. PGRST202 is the form from before 021 (or no
         * function). Then seven named arguments, which only two forms — 018
         * re-applied by hand beside 021's — make ambiguous, and that breaks
         * every PostgREST caller by name that predates this change.
         */
        try {
          const nobody = "00000000-0000-4000-8000-000000000000";
          const seven = { p_id: nobody, p_content: null, p_metadata_patch: null, p_embedding: null, p_chunks: null, p_if_unchanged_since: null, p_actor: null };
          const { data: eight, error: eightErr } = await legacy.rpc("update_thought", { ...seven, p_embedding_model: null });
          if (eightErr && missing(eightErr.message)) {
            add("edit signature", "fail",
                "update_thought does not take p_embedding_model over PostgREST — it is missing or is the form from before migration 021 — and the server sends it on every edit, so every update_thought call would fail",
                APPLY_021_POSTGREST);
          } else if (eightErr) {
            add("edit signature", "skip", `could not probe update_thought over PostgREST (${eightErr.message}); ${CATALOG_HINT}`);
          } else if ((eight as { error?: string } | null)?.error !== "NOT_FOUND") {
            add("edit signature", "skip", `update_thought answered a probe for an id no row has with ${JSON.stringify(eight)} rather than NOT_FOUND; ${CATALOG_HINT}`);
          } else {
            const { error: sevenErr } = await legacy.rpc("update_thought", seven);
            if (!sevenErr) {
              add("edit signature", "ok", "update_thought takes 021's arguments over PostgREST, and a 7-argument call resolves to one function — no earlier form beside it");
            } else if (/could not choose|PGRST203|not unique/i.test(sevenErr.message)) {
              add("edit signature", "fail",
                  "update_thought has more than one form — an earlier migration re-applied by hand beside 021's — and PostgREST cannot choose between them for a 7-argument call, so every caller sending seven arguments fails",
                  "DROP FUNCTION update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb); against the project's direct connection — the form 021 drops.");
            } else {
              add("edit signature", "skip", `could not probe update_thought over PostgREST (${sevenErr.message}); ${CATALOG_HINT}`);
            }
          }
        } catch (e) {
          add("edit signature", "skip", `could not probe update_thought over PostgREST (${(e as Error).message}); ${CATALOG_HINT}`);
        }
      }
      // The 3-argument upsert_thought's body (022's sentinel) and the role's
      // DELETE on thought_chunks are catalog facts; over PostgREST neither is
      // reachable, and a check that prints nothing looks like one that passed.
      add("atomic capture", "skip", `not checked over PostgREST — whether the 3-argument upsert_thought is 022's is read from the catalog; ${CATALOG_HINT}`);
      add("chunk delete privilege", "skip", `not checked over PostgREST — whether the role can remove a thought's windows is read from the catalog; ${CATALOG_HINT}`);
      add("fingerprint backfill", "skip", `not checked over PostgREST — whether a thought without a fingerprint has one waiting is decided by hashing rows on the server; ${CATALOG_HINT}`);
    }

    // The atomic capture path needs migration 004. Its absence is not fatal — the
    // PostgREST store falls back — but the fallback is the failure mode migration
    // 004 exists to remove, so say so.
    if (built.kind === "sql" && env.DATABASE_URL) {
      try {
        const { SQL } = await import("bun");
        const sql = new SQL({ url: env.DATABASE_URL, max: 1 });

        // Before anything reads the schema: can this connection resolve the
        // bare `vector` type at all? pgvector installed into a schema off the
        // search_path — how Supabase and several managed providers ship it
        // (upstream #319) — makes `vector` and `vector_cosine_ops` unresolvable,
        // so every capture and search fails with `type "vector" does not exist`
        // on a database that demonstrably has pgvector. migrate.ts heals its own
        // session; the server's connection is separate, so this is the check
        // that catches the running server and names the persistent fix. A
        // catalog read, not a `SELECT '[1]'::vector` cast: to_regtype returns
        // NULL rather than raising when the type is off the path, so an
        // off-path database reports cleanly here instead of raising into the
        // catch below (which the schema-qualified reads that follow avoid for
        // the same reason). First in DIRECT_CHECKS: a connection that fails
        // outright raises here and this name carries the error.
        // The extension's schema resolved once, and whether this role can even
        // see into it: an off-path schema and a schema this role has no USAGE on
        // both make the bare type unresolvable, but only the first is fixed by
        // SET search_path — the second needs a GRANT, so the remedy has to tell
        // them apart.
        const [vec] = await sql`
          SELECT to_regtype('vector') IS NOT NULL AS resolves,
                 v.schema, quote_ident(v.schema) AS schema_ident,
                 CASE WHEN v.schema IS NOT NULL THEN has_schema_privilege(v.schema, 'USAGE') END AS usage,
                 current_user::text AS role, quote_ident(current_user) AS role_ident,
                 current_database()::text AS db, quote_ident(current_database()) AS db_ident
            FROM (SELECT (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector') AS schema) v`;
        const setPath = (verb: string, ident: string) => `${verb} ${ident} SET search_path = "$user", public, ${vec.schema_ident};`;
        if (vec.resolves) {
          add("vector extension", "ok", `the vector type resolves${vec.schema ? ` (pgvector in schema ${vec.schema})` : ""}`);
        } else if (!vec.schema) {
          // Not installed here at all — not this check's failure to raise:
          // migration 001 runs CREATE EXTENSION, and the schema check below
          // fails an un-migrated database with the migrate command. A skip, so
          // it does not double as an alarming FAIL on a database about to be built.
          add("vector extension", "skip", "pgvector is not installed in this database — migration 001 creates it, and the schema check covers an un-migrated database");
        } else if (vec.usage === false) {
          add("vector extension", "fail",
              `pgvector is installed in schema "${vec.schema}", but role ${vec.role} has no USAGE on that schema, so the bare type "vector" does not resolve and every capture and search would fail with 'type "vector" does not exist' — SET search_path alone will not help here`,
              `GRANT USAGE ON SCHEMA ${vec.schema_ident} TO ${vec.role_ident};  (as a role that can), then put it on the path: ${setPath("ALTER ROLE", vec.role_ident)}`);
        } else {
          add("vector extension", "fail",
              `pgvector is installed in schema "${vec.schema}", which is not on this connection's search_path (role ${vec.role}, database ${vec.db}) — so the bare type "vector" does not resolve and every capture and search would fail with 'type "vector" does not exist'`,
              `Put ${vec.schema} on the connection's search_path. Least-scoped (this role only): ${setPath("ALTER ROLE", vec.role_ident)}  — or database-wide: ${setPath("ALTER DATABASE", vec.db_ident)}  then reconnect. This adds a setting beside any hnsw.* bounds, it does not replace them.`);
        }

        // One schema-qualified read of every form, arity and body; no name or
        // type resolved through the session's search_path (to_regprocedure
        // returns NULL where `vector` is out of the path on PG16, and raises
        // on PG15 — into the catch below, taking every later check with it).
        const forms = (await sql`
          SELECT p.pronargs::int AS n, p.prosrc AS src FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'upsert_thought' AND n.nspname = 'public'`) as { n: number; src: string }[];
        const applied = await sql`
          SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name = 'schema_migrations'`;
        // Which of the migrations that have a ledger-aware remedy the ledger
        // records — read ONCE, here, for every check below that asks (014,
        // 019, 020 for the search functions; 023 for the fingerprint backfill).
        // A role without SELECT on the ledger, or no ledger, reads as none.
        let ledger = new Set<string>();
        let ledgerRead = false;
        if (Number(applied[0].c) > 0) {
          try {
            const led = await sql`SELECT name FROM schema_migrations WHERE name LIKE '014\\_%' OR name LIKE '019\\_%' OR name LIKE '020\\_%' OR name LIKE '023\\_%'`;
            ledger = new Set(led.map((r: { name: string }) => String(r.name).slice(0, 3)));
            ledgerRead = true;
          } catch {
            /* no SELECT on the ledger for this role: a remedy that depends on it says so */
          }
        }
        const three = forms.find((f) => f.n === 3);
        const two = forms.find((f) => f.n === 2);
        // The 3-arg body's semantics are declared by a sentinel in the body
        // itself, `ob1:vector-replaces-chunks` (022, the 014 convention): the
        // windows stay while the label vouches for them and go otherwise. 021
        // re-applied by hand puts 021's body back — CREATE OR REPLACE, no
        // error — and a chunkless re-capture at another model then leaves the
        // previous vector's windows under the new one, found by search and
        // named by nothing.
        if (!three) {
          add("atomic capture", "fail", `${forms.length} upsert_thought overload(s) — the 3-argument form, the atomic capture, is missing`,
              "Apply db/migrations/022_capture_replaces_chunks.sql — the last definer of the 3-argument form (004 created it; 005, 008, 021 and 022 redefined it, and 004's body alone would drop each of theirs).");
        } else if (!two) {
          // This server never calls the 2-argument form; PostgREST callers by
          // name and the two-step fallback do. A warning, and the remedy says
          // "then 022": 005 redefines the 3-argument form too, with its body.
          add("atomic capture", "warn", `${forms.length} upsert_thought overload(s) — the 2-argument form is missing; this server does not call it, PostgREST callers by name and the two-step capture fallback do`,
              "Apply db/migrations/005_reject_non_object_payload.sql (the last definer of the 2-argument form), then 022 again — 005 redefines the 3-argument form as well, with a body from before 008, 021 and 022.");
        } else if (!/ob1:vector-replaces-chunks/.test(three.src)) {
          add("atomic capture", "warn",
              "the 2- and 3-argument upsert_thought present, but the 3-argument body is from before migration 022 (021 re-applied by hand puts it back): a re-capture that makes no windows — the Edge Function server, or a window that grew — at another model replaces the vector and leaves the previous vector's chunk rows under it, so search finds the thought by windows it no longer has",
              "Apply db/migrations/022_capture_replaces_chunks.sql.");
        } else {
          add("atomic capture", "ok", "the 2- and 3-argument upsert_thought present; the 3-argument body is 022's, so a re-capture's windows stay only while the label vouches for them");
        }

        // A fact of its own, with its own remedy: every writer that replaces a
        // thought's windows — 007's 4-argument form, update_thought, and since
        // 022 the 3-argument form on a re-capture the label does not vouch for
        // — runs as its caller, so the connection's role needs DELETE on
        // thought_chunks whatever body is installed. Schema-qualified: the
        // text form of has_table_privilege resolves through search_path and
        // RAISES for a relation it cannot see, and a raise here would land in
        // the catch below and take every later check with it.
        const [chunks] = await sql`
          SELECT t.present,
                 CASE WHEN t.present THEN has_table_privilege('public.thought_chunks', 'DELETE') END AS can,
                 current_user::text AS role, quote_ident(current_user::text) AS ident
          FROM (SELECT to_regclass('public.thought_chunks') IS NOT NULL AS present) t`;
        if (!chunks.present) {
          add("chunk delete privilege", "skip", "not checked — thought_chunks does not exist (before migration 007)");
        } else if (!chunks.can) {
          add("chunk delete privilege", "fail",
              `this connection's role (${chunks.role}) cannot DELETE from thought_chunks — the chunk writers run as their caller, so every edit with content, every capture with windows, and since 022 every re-capture with a vector the row's label does not vouch for would fail`,
              `GRANT DELETE ON thought_chunks TO ${chunks.ident};`);
        } else {
          add("chunk delete privilege", "ok", `${chunks.role} can DELETE from thought_chunks (INSERT on it, and on thought_audit, are not checked here)`);
        }

        // 003's missing half (023). A thought without a fingerprint whose key
        // no row holds is a capture doubled in waiting: ON CONFLICT cannot
        // see a NULL, so a capture of that text inserts a second row and
        // search returns both. backfill_content_fingerprints() writes such
        // rows — at 023, and again after a load that inserted into thoughts
        // directly — and the remedy is that one statement, as the table's
        // owner (it holds the updated_at trigger). A NULL row whose key
        // another row holds — a twin, or a stale key — is the state 018
        // leaves after a pass, and stays. A stale key on a row that HAS one
        // doubles on capture too, and is not read here: finding it means
        // hashing every fingerprinted row on every start. The EXISTS stops
        // at the first pending row, so a brain before 023 answers at once;
        // after it the NULL rows are few. Presence first, from the catalog:
        // the table or the column missing must be a skip, and a reference
        // to either in the same statement would raise instead. Its own
        // boundary: a throw here must not report as `atomic capture`.
        try {
          const [t] = (await sql`
            SELECT to_regclass('public.thoughts') IS NOT NULL AS present,
                   EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.thoughts')
                            AND a.attname = 'content_fingerprint' AND NOT a.attisdropped) AS has_column,
                   EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE p.proname = 'content_fingerprint_of' AND n.nspname = 'public') AS hash_fn,
                   EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE p.proname = 'backfill_content_fingerprints' AND n.nspname = 'public') AS backfill_fn,
                   (SELECT pg_get_userbyid(c.relowner)::text FROM pg_class c WHERE c.oid = to_regclass('public.thoughts')) AS owner`) as
            { present: boolean; has_column: boolean; hash_fn: boolean; backfill_fn: boolean; owner: string | null }[];
          if (!t.present || !t.has_column) {
            add("fingerprint backfill", "skip", `not checked — ${t.present ? "thoughts.content_fingerprint does not exist (before migration 003)" : "thoughts does not exist"}`);
          } else if (!t.hash_fn) {
            add("fingerprint backfill", "skip", "not checked — content_fingerprint_of does not exist (before migration 016)");
          } else {
            // Since 023 the rows without a key have their own partial index
            // (ob1_fp_backfill_idx), so this is an index walk; before it, a
            // pass over the heap, as `schema`'s row count is. The hash behind
            // "pending" is 17 µs a row, so both are bounded to 10,001 NULL
            // rows — a start costs the same on a brain with a million twins as
            // on one with ten — and past the bound the ok says what it did not
            // read. The number is for the message only.
            const [{ nulls: nullsRaw, pending }] = (await sql`
              WITH b AS (SELECT content FROM public.thoughts WHERE content_fingerprint IS NULL LIMIT 10001)
              SELECT (SELECT count(*)::int FROM b) AS nulls,
                     EXISTS (
                       SELECT 1 FROM b x
                        WHERE NOT EXISTS (SELECT 1 FROM public.thoughts h WHERE h.content_fingerprint = public.content_fingerprint_of(x.content))
                     ) AS pending`) as { nulls: number; pending: boolean }[];
            const capped = Number(nullsRaw) > 10000;
            const nulls = capped ? "more than 10,000" : String(nullsRaw);
            const waiting = `${nulls} thought(s) without a fingerprint, at least one whose text no row holds`;
            if (Number(nullsRaw) === 0) {
              add("fingerprint backfill", "ok", "no thought is missing a fingerprint (a stale key on a row that has one is not read here)");
            } else if (pending && !t.backfill_fn) {
              // Ledger-aware, as reembed.ts is for 021: a brain adopted with
              // --baseline says 023 while the function is absent, and "apply
              // 023" would be a loop — the migrator skips a ledgered file.
              const byHand = "re-run the body of db/migrations/023_content_fingerprint_backfill.sql by hand, substituting NULL for {{BACKFILL_LIMIT}} — the migrator will skip it as applied.";
              add("fingerprint backfill", "warn",
                  `${waiting}: a capture of that text inserts a second row, since 003's conflict target cannot see a NULL`,
                  ledger.has("023")
                    ? `The ledger says 023 but backfill_content_fingerprints is absent (adopted with --baseline): ${byHand}`
                    : ledgerRead || Number(applied[0].c) === 0
                      ? "Apply db/migrations/023_content_fingerprint_backfill.sql."
                      : `Apply db/migrations/023_content_fingerprint_backfill.sql — or, if the ledger already records 023 (this role cannot read schema_migrations), ${byHand}`);
            } else if (pending) {
              // Which rows these are cannot be read here: a batched upgrade
              // still running, or a load around upsert_thought since 023.
              add("fingerprint backfill", "warn",
                  `${waiting} — 023's call has not reached them (a batched upgrade still running, or rows loaded around upsert_thought since): a capture of that text inserts a second row`,
                  `As ${t.owner ?? "the table's owner"}: SELECT backfill_content_fingerprints(); — or, keeping each lock short, SELECT backfill_content_fingerprints(10000); until it returns 0, each call its own transaction.`);
            } else {
              add("fingerprint backfill", "ok", capped
                ? "more than 10,000 thought(s) without a fingerprint; of 10,001 sampled, none is waiting — each shares its text with the row that holds it (a twin, or a stale key); the rest were not read, and SELECT backfill_content_fingerprints() settles them if any is (it writes nothing when none is) — reembed.ts --status lists the groups"
                : `${nulls} thought(s) without a fingerprint, each sharing its text with the row that holds it (a twin, or a stale key) — reembed.ts --status lists the groups`);
            }
          }
        } catch (e) {
          add("fingerprint backfill", "warn", `could not verify: ${(e as Error).message}`, "The check reads thoughts, pg_proc and pg_class.");
        }

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
         * Migration 017's function. `search` and `search_thoughts` call it
         * unconditionally since SMD-958, so a database that stops at 016 breaks
         * the two most-used tools rather than a new one — the same shape of
         * failure as the 012 check above, on a bigger surface, same severity.
         */
        const hybrid = await sql`
          SELECT count(*)::int AS c FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'search_thoughts_hybrid' AND n.nspname = 'public'`;
        if (Number(hybrid[0].c) >= 1) add("hybrid search", "ok", "search_thoughts_hybrid present");
        else add("hybrid search", "fail",
                 "search_thoughts_hybrid is missing, but search and search_thoughts call it — every semantic search would fail",
                 "Apply the migrations through db/migrations/020_match_thoughts_recency.sql (017_search_thoughts_hybrid.sql defines it; 020 redefines it with the arguments the server sends).");

        /**
         * Migration 024's function. On the SQL path thought_stats calls
         * thought_stats_summary() to aggregate the whole corpus in one statement
         * (SMD-1249); a database that stops at 023 has the tool registered but no
         * function behind it, so every thought_stats call fails with `function
         * thought_stats_summary() does not exist` while the other tools work —
         * the same shape the keyword and hybrid checks above convert to a startup
         * message. A fail, not a warn: the absence breaks the tool, it does not
         * degrade it. (Only the SQL store calls it — the PostgREST store still
         * walks pages — and this whole block is SQL-only, so the check is where
         * it belongs.)
         */
        const stats = await sql`
          SELECT count(*)::int AS c FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'thought_stats_summary' AND n.nspname = 'public'`;
        if (Number(stats[0].c) >= 1) add("stats summary", "ok", "thought_stats_summary present");
        else add("stats summary", "fail",
                 "thought_stats_summary is missing, but thought_stats calls it on the SQL path — every thought_stats call would fail",
                 "Apply db/migrations/024_thought_stats_summary.sql.");

        /**
         * Migration 025's provenance functions (SMD-1253). trace_provenance and
         * find_derivatives back the store's read methods, and 025 also teaches
         * upsert_thought to write derived_from/supersedes and the search tools to
         * label a superseded hit. A database that stops at 024 has the OLD
         * upsert_thought, which ignores the derived_from/supersedes envelope keys
         * SILENTLY — a capture that names a source or a supersession is accepted
         * and the provenance dropped — and lacks the read/label functions. A
         * fail, not a warn: the write path accepts input it cannot honour, the
         * exact silent-and-wrong shape this fork removes. (SQL-only, like the
         * checks around it; the store's label lookup is best-effort so search
         * itself survives a pre-025 schema — this check is how the operator
         * learns why the labels never appear.)
         */
        const prov = await sql`
          SELECT
            count(*) FILTER (WHERE p.proname = 'trace_provenance')::int AS t,
            count(*) FILTER (WHERE p.proname = 'find_derivatives')::int AS f
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname IN ('trace_provenance', 'find_derivatives') AND n.nspname = 'public'`;
        // Per function, not a combined count: a double-overload of one plus the
        // other absent must still fail, as the sibling signature checks do
        // (review pass 1, SMD-1253).
        if (Number(prov[0].t) >= 1 && Number(prov[0].f) >= 1) add("provenance", "ok", "trace_provenance and find_derivatives present");
        else add("provenance", "fail",
                 "migration 025's provenance functions are missing, but capture_thought accepts derived_from/supersedes (silently dropped by the pre-025 upsert_thought) and search labels superseded hits",
                 "Apply db/migrations/025_thought_provenance.sql.");

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
         * The lookup resolves the one signature the servers call, through
         * to_regprocedure, which is NULL rather than an error when the function
         * is not defined (an earlier draft matched by name and arity and read
         * the first of however many overloads existed). The migration ledger is
         * consulted to word the remedy: "apply 014" is a no-op when 014 is
         * recorded and a later redefinition dropped the clause.
         *
         * Everything here has its own error boundary. These catalog reads can
         * fail on a hardened server (pg_available_extensions is not always
         * readable), and a throw must not be reported as "atomic capture" or
         * take the checks after this one down with it.
         *
         * A WARNING throughout: without the setting the tool still answers,
         * with the recall it had before 014.
         */
        /**
         * The catalog rows the function checks read — every match_thoughts in
         * `public` with its arity and signature (the 6-argument form the
         * servers call since 020 first, so `mt[0]` is the one a call resolves
         * to when it exists; a lone earlier form otherwise, so the 014 and 019
         * checks can still describe a database that predates 020), every
         * search_thoughts_hybrid likewise, search_thoughts_keyword's row
         * estimate, and which of 014, 019 and 020 the ledger records — read
         * ONCE, so the checks judge the same definitions (second review pass
         * of 019). A failed read is re-thrown inside each check, whose catch
         * words it.
         */
        type Overload = { cfg: string; settings: Record<string, string>; src: string; rows: number; nargs: number; sig: string };
        let catalog: { mt: Overload[]; hy: { nargs: number; sig: string }[]; kwRows: number | null; ledger: Set<string> } | Error;
        try {
          const { parseSetConfig } = await import("../db/config.mjs");
          const mtRows = await sql`
            SELECT p.proconfig AS cfg, p.prosrc AS src, p.prorows AS rows, p.pronargs AS nargs, p.oid::regprocedure::text AS sig
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'match_thoughts' AND n.nspname = 'public'
            ORDER BY (p.pronargs = 6) DESC, p.oid`;
          const hyRows = await sql`
            SELECT p.pronargs AS nargs, p.oid::regprocedure::text AS sig
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'search_thoughts_hybrid' AND n.nspname = 'public'
            ORDER BY (p.pronargs = 7) DESC, p.oid`;
          const kw = await sql`SELECT p.prorows AS rows FROM pg_proc p WHERE p.oid = to_regprocedure('public.search_thoughts_keyword(text, integer, integer, jsonb)')`;
          catalog = {
            mt: mtRows.map((r: { cfg: string[] | null; src: string; rows: number; nargs: number; sig: string }) => ({ cfg: (r.cfg ?? []).join(","), settings: parseSetConfig(r.cfg) as Record<string, string>, src: String(r.src ?? ""), rows: Number(r.rows ?? 0), nargs: Number(r.nargs), sig: String(r.sig) })),
            hy: hyRows.map((r: { nargs: number; sig: string }) => ({ nargs: Number(r.nargs), sig: String(r.sig) })),
            kwRows: kw.length ? Number(kw[0].rows) : null,
            ledger,
          };
        } catch (e) {
          catalog = e as Error;
        }

        /**
         * Migration 020 changed both search functions' signatures — two
         * defaulted parameters, recency_weight and half_life_days — by DROPPING
         * the earlier forms, and both stores send all the arguments. Two states
         * break every search and neither shows in the presence checks above:
         *
         *   * the functions predate 020 (the ledger stops at 019, or a hand
         *     re-apply of 007/014/019 or 017 replaced them): the call the
         *     server makes has no function to resolve to;
         *   * an earlier form was re-created BESIDE 020's — the same hand
         *     re-apply on a database that had reached 020: 020's function still
         *     answers the server, but every 4-argument (5-) call — PostgREST
         *     callers by name, hand-written SQL, community integrations — is
         *     "function is not unique", the ambiguity 004's header names.
         *
         * A failure in both, as `hybrid search` is: the absence does not
         * degrade a tool, it breaks it. The remedy for the second is the DROP
         * 020 itself runs, named with the exact signature the catalog holds.
         */
        try {
          if (catalog instanceof Error) throw catalog;
          const { mt, hy } = catalog;
          if (!mt.length || !hy.length) {
            add("search signatures", "skip", "not checked — a search function is missing, and the checks above say which");
          } else {
            const mtNew = mt.some((r) => r.nargs === 6);
            const hyNew = hy.some((r) => r.nargs === 7);
            const extra = [...mt.filter((r) => r.nargs !== 6), ...hy.filter((r) => r.nargs !== 7)].map((r) => r.sig);
            if (mtNew && hyNew && extra.length === 0) {
              add("search signatures", "ok", `${mt[0].sig} and ${hy[0].sig}: the forms the servers call since migration 020, one of each`);
            } else if (mtNew && hyNew) {
              add("search signatures", "fail",
                  `beside the forms the servers call there ${extra.length === 1 ? "is an earlier one" : `are ${extra.length} earlier ones`}: ${extra.join(", ")} — an earlier migration re-applied by hand over 020 — so every call that sends four arguments to match_thoughts (five to search_thoughts_hybrid), which is every PostgREST caller by name and every hand-written SELECT, fails with "function is not unique"`,
                  `Drop the earlier form, as 020 does: ${extra.map((sig) => `DROP FUNCTION ${sig};`).join(" ")}`);
            } else {
              const old = [...(mtNew ? [] : mt), ...(hyNew ? [] : hy)].map((r) => r.sig);
              add("search signatures", "fail",
                  `${old.join(" and ")} ${old.length === 1 ? "is the form" : "are the forms"} from before migration 020; the server sends recency_weight and half_life_days, which only 020's forms take — so every search would fail`,
                  APPLY_020);
            }
          }
        } catch (e) {
          add("search signatures", "warn", `could not verify: ${(e as Error).message}`, "The catalog read behind this check needs SELECT on pg_proc.");
        }

        /**
         * Migration 021 changed update_thought's signature the same way — an
         * eighth, defaulted parameter, the model beside the vector, the
         * 7-argument form dropped — and both stores send all eight. The same
         * two states break every edit and neither shows in a presence check:
         * the function predates 021 (the call has no function to resolve to),
         * or the old form was re-created BESIDE 021's by a hand re-apply of
         * 009/013/018 (021's answers the server; every 7-argument call — a
         * PostgREST caller by name, hand-written SQL, community integrations —
         * is "function is not unique").
         */
        try {
          const { UPDATE_THOUGHT_SIGNATURE } = await import("../db/config.mjs");
          const ut = (await sql`
            SELECT p.pronargs AS nargs, p.oid::regprocedure::text AS sig
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'update_thought' AND n.nspname = 'public'
            ORDER BY (p.pronargs = 8) DESC, p.oid`) as { nargs: number; sig: string }[];
          const current = ut.filter((r) => Number(r.nargs) === 8);
          const extra = ut.filter((r) => Number(r.nargs) !== 8).map((r) => r.sig);
          if (!ut.length) {
            add("edit signature", "fail", "update_thought is missing — the update_thought tool and db/reembed.ts call it", APPLY_021);
          } else if (current.length && extra.length === 0) {
            add("edit signature", "ok", `${current[0].sig}: the form the servers and reembed.ts call since migration 021 (${UPDATE_THOUGHT_SIGNATURE}), alone`);
          } else if (current.length) {
            add("edit signature", "fail",
                `beside the form the servers call there ${extra.length === 1 ? "is an earlier one" : `are ${extra.length} earlier ones`}: ${extra.join(", ")} — an earlier migration re-applied by hand over 021 — so every call that sends seven arguments to update_thought, which is every PostgREST caller by name and every hand-written SELECT from before this change, fails with "function is not unique"`,
                `Drop the earlier form, as 021 does: ${extra.map((sig) => `DROP FUNCTION ${sig};`).join(" ")}`);
          } else {
            add("edit signature", "fail",
                `${extra.join(" and ")} ${extra.length === 1 ? "is the form" : "are the forms"} from before migration 021; the server sends p_embedding_model, which only 021's form takes — so every edit, and every db/reembed.ts run, would fail`,
                APPLY_021);
          }
        } catch (e) {
          add("edit signature", "warn", `could not verify: ${(e as Error).message}`, "The catalog read behind this check needs SELECT on pg_proc.");
        }

        try {
          const { versionAtLeast, HNSW_BOUNDS, HNSW_SEEDS, HNSW_SEED_MAX_SCAN_TUPLES, HNSW_SEED_SCAN_MEM_MULTIPLIER, BOUNDS_IN_FORCE_SQL } = await import("../db/config.mjs");
          if (catalog instanceof Error) throw catalog;
          const mt = catalog.mt;
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
          const ledgerHas014 = catalog.ledger.has("014");
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
            `Put it back: SELECT '[1]'::vector; ALTER FUNCTION ${mt[0]?.sig ?? "match_thoughts"} SET hnsw.iterative_scan = relaxed_order;  — a redefinition that dropped this clause dropped 019's too (the candidate scan check below says) — and carry them into the migration that redefined it.`;
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
         * Migration 019: `SET enable_seqscan = off` on match_thoughts. At the
         * shipped width a vector is TOASTed and the planner's seq-scan estimate
         * never counts the detoast reads, so on brains up to some tens of
         * thousands of thoughts it chose a sequential scan of the chunk table
         * on every search and of both tables above the default count — five to
         * twenty times the buffers the index reads (019's header has the
         * table). The clause lives on the function and CREATE OR REPLACE drops
         * it silently, exactly as 014's does, so it is checked the same way and
         * by the same rule: the catalog says what the deployed function carries
         * (CI proves the plan; db/test-live.ts [5c]). The two row estimates 019
         * declares — match_thoughts ROWS 10, search_thoughts_keyword ROWS 25 —
         * are read beside it, since the same kind of redefinition resets each.
         * A WARNING: every search still answers, at the seq scan's cost.
         */
        try {
          if (catalog instanceof Error) throw catalog;
          const { mt, kwRows, ledger } = catalog;
          if (!mt.length) {
            add("candidate scan", "skip", "not checked — match_thoughts is not defined (filtered search says so)");
          } else {
            const seqOff = mt[0].settings["enable_seqscan"] === "off";
            const rows = mt[0].rows;
            const kwOff = kwRows !== null && kwRows !== 25;
            const ledgerHas019 = ledger.has("019");
            // One statement per function that needs it, in the order to run them.
            const alters = [
              ...(!seqOff || rows !== 10 ? [`ALTER FUNCTION ${mt[0].sig}${seqOff ? "" : " SET enable_seqscan = off"}${rows !== 10 ? " ROWS 10" : ""};`] : []),
              ...(kwOff ? ["ALTER FUNCTION search_thoughts_keyword(text, int, int, jsonb) ROWS 25;"] : []),
            ];
            const remedy = ledgerHas019
              ? `Put it back — after any re-apply of a migration body, since CREATE OR REPLACE resets these: SELECT '[1]'::vector; ${alters.join(" ")}  and carry them into the migration that redefined the function.`
              : "Apply db/migrations/019_match_thoughts_plan_and_rows.sql.";
            const estimates = [
              ...(rows !== 10 ? [`match_thoughts' row estimate is ${rows} rather than 10`] : []),
              ...(kwOff ? [`search_thoughts_keyword's row estimate is ${kwRows} rather than 25`] : []),
            ];
            if (seqOff && rows === 10 && !kwOff) {
              add("candidate scan", "ok", "match_thoughts declares enable_seqscan = off and ROWS 10, search_thoughts_keyword ROWS 25 (019): the candidate scan takes the HNSW indexes at the shipped width and callers plan against real row counts");
            } else if (!seqOff) {
              add("candidate scan", "warn",
                  `match_thoughts does not carry enable_seqscan = off${ledgerHas019 ? " although migration 019 is recorded as applied — a later redefinition dropped its SET clause" : " — migration 019 is not applied"}${estimates.length ? `, and ${estimates.join(", and ")}` : ""} — so at the shipped width the planner seq-scans the chunk table on every search and both tables above the default count, on brains up to some tens of thousands of thoughts (019's header has the numbers)`,
                  remedy);
            } else {
              add("candidate scan", "warn",
                  `match_thoughts carries enable_seqscan = off but ${estimates.join(", and ")}${ledgerHas019 ? " — a redefinition reset what 019 declared" : " — migration 019 is not applied"}; every query composing the function is planned against that count (017's header records what a 1,000-row estimate cost)`,
                  remedy);
            }
          }
          // Not defined: the check above already said so.
        } catch (e) {
          add("candidate scan", "warn", `could not verify: ${(e as Error).message}`, "The catalog read behind this check needs SELECT on pg_proc.");
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
        // The column's width, for where the record has none (a hand-applied
        // schema): the re-embed pass check judges a key's width by it, as
        // reembed.ts does, so the two agree on which keys are superseded — this
        // server's OB1_EMBEDDING_DIM stood in before, and a server misconfigured
        // for another width called the live pass one nothing could finish
        // (SMD-1067's second review pass).
        let columnWidth: number | undefined;
        try {
          const [w] = (await sql`SELECT atttypmod AS width FROM pg_attribute WHERE attrelid = 'thoughts'::regclass AND attname = 'embedding'`) as { width: number }[];
          if (w && Number(w.width) > 0) columnWidth = Number(w.width);
        } catch {
          // The schema checks below report a missing table or column.
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
        // The chain above reports nothing for a record without a width — 006's table
        // present but its embedding_dim row gone, or a record written by a tool that
        // set only the model — and a check that prints nothing looks like one that passed.
        if (!recorded.embedding_dim && results.every((r) => r.name !== "embedding contract")) {
          add("embedding contract", "warn", `ob1_config records no embedding_dim${recorded.embedding_model ? ` (only embedding_model = ${recorded.embedding_model})` : ""} — the width the schema was built for is unrecorded, so nothing here can compare it to OB1_EMBEDDING_DIM=${embDim}`,
              "Apply db/migrations/006_embedding_config.sql, or record the width: INSERT INTO ob1_config (key, value) VALUES ('embedding_dim', '<width>').");
        }

        /**
         * The rows themselves (migration 021, SMD-1068). ob1_config records the
         * model the corpus is MEANT to be at and the claim table (below) says
         * how far a pass got; neither is a fact about a row, and the claim rows
         * vanish when an operator clears them. Since 021 every vector carries
         * the model that produced it, written by the same statement — so this
         * is the one check that reads what the corpus IS at. Counted from the
         * rows as the chunk-context check is: every labelled vector at the
         * recorded model (the configured one when 006 recorded none) is ok;
         * vectors at another model are a warning, whether or not any claim row
         * remembers the pass that left them — the remedy is the pass, which
         * takes exactly those rows; unlabelled vectors (a row from before 021 no
         * pass vouched for, a raw INSERT, a writer naming no model) are detail:
         * unknown, not wrong. A vector at another model whose thought the
         * operator ACCEPTED — a failed row `reembed.ts --accept-failed` marked
         * succeeded under a key naming the recorded model, and nothing has
         * written the thought since — is detail too (SMD-1067): the acceptance
         * is the operator's word about exactly that vector, and clearing the
         * claim table brings the warning back, which is right. The column
         * absent under this server is a failure: every capture would drop the
         * label and every edit would fail (the 8-argument update_thought is
         * 021's too — `edit signature` above says so).
         */
        let haveLabel = false;
        try {
          const labelCol = await sql`
            SELECT count(*)::int AS c FROM information_schema.columns
            WHERE table_name = 'thoughts' AND column_name = 'embedding_model'`;
          haveLabel = Number(labelCol[0].c) >= 1;
          if (!haveLabel) {
            add("vector models", "fail",
                "thoughts.embedding_model does not exist — the server records the model on every vector it stores, and the writers before migration 021 cannot hold it: captures would silently lose the label and edits would fail",
                APPLY_021);
          } else {
            // The queries and the arithmetic are config.mjs's, shared with reembed.ts.
            const { ACCEPTED_BY_MODEL_SQL, ACCEPTED_CAVEAT_PREFIX, CORPUS_BY_MODEL_SQL, reembedKey, summariseCorpusByModel } = await import("../db/config.mjs");
            const atModel = recorded.embedding_model ?? embModel;
            // The column's width first: the key reembed.ts writes is at the
            // column's width whatever a hand-edited record says (third review pass).
            const atDim = Number(columnWidth ?? recorded.embedding_dim ?? embDim);
            const corpus = (await sql.unsafe(CORPUS_BY_MODEL_SQL)) as { model: string | null; c: number }[];
            // The acceptances — under the recorded model's OWN key, exactly
            // (config.mjs says why) — are read only when a vector at another
            // model needs explaining, and only where the claim table exists: a
            // relation named in a statement is resolved when it is parsed.
            let acceptedRows: { model: string | null; accepted: number }[] = [];
            if (corpus.some((r) => r.model !== null && r.model !== atModel)) {
              const [{ haveClaims }] = await sql`SELECT to_regclass('thought_work_claims') IS NOT NULL AS "haveClaims"`;
              if (haveClaims) acceptedRows = (await sql.unsafe(ACCEPTED_BY_MODEL_SQL, [reembedKey(atModel, atDim), ACCEPTED_CAVEAT_PREFIX])) as { model: string | null; accepted: number }[];
            }
            const { at, unlabelled, others, otherCount, acceptedCount, unaccepted } = summariseCorpusByModel(corpus, atModel, acceptedRows);
            // What is known about the rows NOT at the model: said the same way in
            // every branch, so an accepted vector never drops out of one of them.
            const rest = [
              acceptedCount ? `${acceptedCount} at another model accepted by the operator (${others.filter((r) => r.accepted).map((r) => `${r.model}: ${r.accepted}`).join(", ")})` : null,
              unlabelled ? `${unlabelled} unlabelled (model unknown)` : null,
            ].filter((s): s is string => s !== null);
            const detail = [`${at} at ${atModel}`, ...rest].join(", ");
            if (unaccepted > 0) {
              // Judged against the RECORD — what the corpus is meant to be at.
              // When the record and this server's configuration disagree the
              // rows are mid-switch and the direction is the operator's: a
              // `--switch-model` from this shell would record THIS model and
              // re-embed the rows at the recorded one — reverting the switch
              // whose finished rows are the majority (first review pass).
              const recordDiffers = recorded.embedding_model !== undefined && recorded.embedding_model !== embModel;
              add("vector models", "warn",
                  `${unaccepted} vector(s) at another model (${others.filter((r) => r.c > r.accepted).map((r) => `${r.model}: ${r.c - r.accepted}`).join(", ")}) beside ${detail} — searches rank across the two${recordDiffers ? `; the record says ${recorded.embedding_model} and this server embeds with ${embModel}` : ""}`,
                  recordDiffers
                    ? `The record (${recorded.embedding_model}) and this server (${embModel}) disagree, so which rows are out of place depends on which stands. Finish the switch to ${recorded.embedding_model}: cd db && OB1_EMBEDDING_MODEL=${recorded.embedding_model} bun reembed.ts --url $DATABASE_URL, and configure the server for it; or, if ${embModel} stands: cd db && bun reembed.ts --url $DATABASE_URL --switch-model, which re-embeds the rows at ${recorded.embedding_model} instead.`
                    : `Re-embed them: cd db && bun reembed.ts --url $DATABASE_URL — the pass takes exactly the rows not at ${embModel}.`);
            } else if (at + unlabelled + otherCount === 0) {
              add("vector models", "ok", "no vectors stored yet");
            } else if (at === 0) {
              // The migration's own motivating corpus: a switch that died, its
              // claim rows cleared, nothing labelled — every vector unknown and
              // none known to be at the model the record names. Unknown is not
              // wrong, but a corpus with NO vector known to be at its model is
              // the state this column exists to make visible (third review pass
              // of SMD-1068) — and so is one whose every vector is at another
              // model with the operator's acceptance: a switch during an outage,
              // every row failed and accepted with --all, would otherwise be
              // green with no vector at the model the server embeds with
              // (SMD-1067's first review pass).
              const recordDiffers = recorded.embedding_model !== undefined && recorded.embedding_model !== embModel;
              add("vector models", "warn",
                  `no vector is known to be at ${atModel}: ${rest.join(", ")} — ${acceptedCount ? "nothing is at the model the record names" : "nothing vouches for them, and the corpus may be at any model the record was ever moved to"}`,
                  `Re-embed them: cd db && bun reembed.ts --url $DATABASE_URL${recordDiffers ? " --switch-model" : ""} — the pass takes every row nothing vouches for, and labels it${acceptedCount ? "; the accepted rows return through --retry-fallbacks, or when their thought is edited" : ""}.`);
            } else {
              add("vector models", "ok", detail);
            }
          }
        } catch (e) {
          add("vector models", "warn", `could not verify: ${(e as Error).message}`, "The check reads thoughts.embedding_model.");
        }

        /**
         * 001's updated_at trigger, still enabled. 021's backfill holds it off
         * inside one DO block, so nothing this fork ships can leave it off; a
         * hand DISABLE, or an interrupted statement of the operator's own, can
         * — and from then on no raw or community UPDATE moves updated_at, so
         * 009's if_unchanged_since guard and 021's evidence rule degrade
         * silently. Its own try, before the corpus scan, so a scan that fails
         * cannot hide it (fourth review pass). Read once per start; the remedy
         * is one line.
         */
        try {
          const trg = await sql`SELECT tgenabled AS e FROM pg_trigger WHERE tgrelid = 'thoughts'::regclass AND tgname = 'thoughts_updated_at'`;
          if (!trg.length) add("updated_at trigger", "fail", "thoughts_updated_at is missing — updated_at would never move", "Apply db/migrations/001_core_schema.sql.");
          else if (trg[0].e === "D") add("updated_at trigger", "fail", "thoughts_updated_at is disabled, so updated_at no longer moves on an update — the if_unchanged_since guard and 021's evidence rule are blind to edits", "ALTER TABLE thoughts ENABLE TRIGGER thoughts_updated_at;");
          else add("updated_at trigger", "ok", "thoughts_updated_at enabled");
        } catch (e) {
          add("updated_at trigger", "warn", `could not verify: ${(e as Error).message}`, "The check reads pg_trigger.");
        }

        /**
         * An unfinished re-embed pass (SMD-1024). `db/reembed.ts --switch-model`
         * records the new model in ob1_config before any row is re-embedded —
         * deliberately: that is what lets a server configured for the new model
         * pass the check above and be switched while the pass runs. So the line
         * above says "matching" for a pass that died at 5%, or was never re-run
         * after --retry-failed, while most vectors are another model's and every
         * search ranks across the two. The claim table is the record of the
         * pass (migration 015's fourth principle) and reembed.ts writes the
         * record and the pool in one transaction, so its counts are the whole
         * signal: a pass is unfinished while any row under its key is pending,
         * leased or failed — passUnfinished() in db/config.mjs, the rule
         * reembed.ts prints by, in the phrase formatPassCounts() gives both. No
         * marker row: a second record could disagree with the first and would
         * need clearing across processes. Every key with the tool's prefix is
         * read, so a backfill under --job is reported too; extraction keys are
         * not — 016's trigger keeps that pool fed between worker runs. Thoughts
         * with no row under a key are detail, not a signal: after a finished
         * switch every new capture is one.
         *
         * A warning, as the model mismatch above is: the server answers, and
         * ranks across the old and the new vectors until the pass is finished.
         * A row the provider refuses permanently is the operator's to accept
         * (`reembed.ts --accept-failed`), and a superseded key's record theirs
         * to retire (`--retire`); the remedies name both, in place of the hand
         * DELETE they named before (SMD-1067).
         */
        try {
          const { ACCEPTED_CAVEAT_PREFIX, formatPassCounts, parseReembedKey, passUnfinished, poolModelFor, REEMBED_KEY_PREFIX, reembedKey } = await import("../db/config.mjs");
          const [{ present }] = await sql`SELECT to_regclass('thought_work_claims') IS NOT NULL AS present`;
          if (!present) {
            add("re-embed pass", "skip", "not checked — thought_work_claims does not exist (migration 015 not applied)");
          } else {
            // A prefix LIKE cannot use the key's btree index under a non-C
            // collation, so this reads the claim table once per start; it is
            // one row per (thought, pass), grouped, and the corpus count is
            // evaluated only when there are groups.
            const rows = (await sql`
              SELECT work_type, status, count(*)::int AS c, count(*) FILTER (WHERE last_error IS NOT NULL)::int AS noted,
                     count(*) FILTER (WHERE last_error IS NOT NULL AND starts_with(last_error, ${ACCEPTED_CAVEAT_PREFIX})
                                      AND EXISTS (SELECT 1 FROM thoughts x WHERE x.id = thought_id AND COALESCE(x.updated_at, x.created_at) <= COALESCE(claimed_at, finished_at, '-infinity'::timestamptz)))::int AS accepted,
                     (SELECT count(*)::int FROM thoughts) AS thoughts
              FROM thought_work_claims WHERE work_type LIKE ${REEMBED_KEY_PREFIX + "%"} GROUP BY work_type, status`) as
              { work_type: string; status: string; c: number; noted: number; accepted: number; thoughts: number }[];
            const byKey = new Map<string, PassCounts>();
            for (const r of rows) {
              const c = byKey.get(r.work_type) ?? { thoughts: Number(r.thoughts), succeeded: 0, fellBack: 0, accepted: 0, failed: 0, claimed: 0, pending: 0, unpooled: Number(r.thoughts) };
              const n = Number(r.c);
              if (r.status === "succeeded") { c.succeeded = n; c.fellBack = Number(r.noted); c.accepted = Number(r.accepted); }
              else if (r.status === "failed") c.failed = n;
              else if (r.status === "claimed") c.claimed = n;
              else if (r.status === "pending") c.pending = n;
              c.unpooled -= n;
              byKey.set(r.work_type, c);
            }
            // "Not yet in the pool" is what a run under the key would add, and
            // reembed.ts builds its pool by the key's shape: under a model's own
            // key (`reembed:<model>@<dim>`, nothing after) the thoughts NOT AT
            // THAT MODEL — no vector, or another or no label — with no row under
            // it, rather than every thought with no row, which after a finished
            // switch is every new capture; under any other key (a suffix, or no
            // model named) every thought with no row, as every pass did before
            // 021 — a backfill's reason is not the model. One rule, poolModelFor
            // in db/config.mjs, read by both tools, or the two would print
            // different numbers for one key (the first review pass found a key
            // naming no model counted two ways; the second, a key naming another
            // model).
            if (haveLabel) {
              for (const [key, c] of byKey) {
                // Only for the keys whose counts are printed: a finished key's
                // count is never shown, and each is a scan of thoughts.
                const poolModel = poolModelFor(key);
                if (poolModel === null || !passUnfinished(c)) continue;
                const [{ n }] = await sql`
                  SELECT count(*)::int AS n FROM thoughts t
                  WHERE (t.embedding IS NULL OR t.embedding_model IS DISTINCT FROM ${poolModel})
                    AND NOT EXISTS (SELECT 1 FROM thought_work_claims c WHERE c.thought_id = t.id AND c.work_type = ${key})`;
                c.unpooled = Number(n);
              }
            }
            const configuredKey = reembedKey(embModel, embDim);
            // The command has to be one reembed.ts will run: --switch-model when
            // the record disagrees with the configuration (it refuses without) —
            // unless the command sets the recorded model in its environment,
            // where there is no disagreement; and the model the key names in the
            // environment when that is not this shell's (it refuses a --job
            // naming another model).
            const recordDiffers = recorded.embedding_model !== undefined && recorded.embedding_model !== embModel;
            const cmd = (envPrefix: string, flags: string) => `${envPrefix}bun reembed.ts --url $DATABASE_URL${flags}`;
            const finishIt = (envPrefix: string, jobFlag: string, c: PassCounts, needsSwitch: boolean) =>
              `Finish it: cd db && ${cmd(envPrefix, `${jobFlag}${needsSwitch ? " --switch-model" : ""}`)}` +
              // Acceptance is a command of its own, under the KEY (the shell's
              // default key is another pass), and not offered beside
              // --switch-model: reembed.ts refuses it under a model change, and
              // refuses the two flags together (second review pass).
              `${c.failed ? ` (--retry-failed for the ${c.failed} failed row(s) once their cause is fixed${needsSwitch ? "" : `, or ${cmd(envPrefix, `${jobFlag} --accept-failed <thought-id…>`)} for one the provider refuses permanently`})` : ""}; ` +
              `${cmd(envPrefix, `${jobFlag} --status`)} shows where it stands.`;
            let unfinished = 0;
            for (const [key, c] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
              if (!passUnfinished(c)) continue;
              unfinished++;
              const named = parseReembedKey(key);
              // Superseded: the key names a model or width that is not the
              // current one — the recorded model, or this server's when nothing
              // is recorded (as reembed.ts's --retire judges, so the two agree:
              // with no record a stale key fell to "finish it under X", which
              // would have re-embedded the corpus to X — SMD-1067's third review
              // pass); the COLUMN's width, before any record (a hand-edited
              // record must not make the one finishable key superseded — third
              // pass; before that, a missing width row made every width "other"
              // — SMD-1024's second review pass — then no width at all, then
              // this server's configured width, which a misconfigured server
              // made wrong — SMD-1067's first and second passes).
              const currentModelHere = recorded.embedding_model ?? embModel;
              const otherModel = named !== null && named.model !== currentModelHere;
              const widthHere = Number(columnWidth ?? recorded.embedding_dim ?? embDim);
              const otherWidth = named !== null && named.dim !== widthHere;
              // The tool's own flag, not a hand DELETE: it refuses the recorded
              // model's keys and a key with a live lease (SMD-1067).
              const retire = `retire its record: cd db && ${cmd("", ` --retire ${key}`)}`;
              if (otherModel) {
                // A switch that was abandoned or reverted: the recorded model
                // has moved on, so finishing this pass under the current shell
                // would write the wrong model's vectors — reembed.ts refuses
                // it. Either that switch is completed, or its record retired.
                // Judged before the configured key: a server still configured
                // for the model the record moved on from has THIS key, and its
                // operator has the same two choices — the first review pass's
                // "finish it" alone offered no way to let the revert stand
                // (third review pass).
                add("re-embed pass", "warn",
                    `${key}: ${formatPassCounts(c)} — a pass to ${named.model} @ ${named.dim}, which is ${recorded.embedding_model === undefined ? `not this server's model (${embModel}; nothing is recorded)` : `no longer the recorded model (${recorded.embedding_model} @ ${recorded.embedding_dim ?? widthHere})`}; its rows describe a switch that was abandoned or reverted`,
                    `Either finish that switch — cd db && ${cmd(`OB1_EMBEDDING_MODEL=${named.model} OB1_EMBEDDING_DIM=${named.dim} `, " --switch-model")} — or, if the revert stands, ${retire}`);
              } else if (key === configuredKey) {
                add("re-embed pass", "warn",
                    `the pass to ${embModel} @ ${embDim} has not finished: ${formatPassCounts(c)} — until it does, the rows it has not reached carry what they had before it (another model's vector, after --switch-model), and searches rank across the two`,
                    finishIt("", "", c, recordDiffers));
              } else if (otherWidth) {
                // The same model at another width. Migration 006 keeps the
                // recorded width equal to the column's, so no run can finish
                // this: a width change is a schema migration that does not
                // exist, and reembed.ts refuses one. Only the record can go.
                add("re-embed pass", "warn",
                    `${key}: ${formatPassCounts(c)} — a pass to ${named.model} at ${named.dim} dimensions, where the column and the record are ${widthHere}; a width change is a schema migration that does not exist yet, so no run can finish this`,
                    `Nothing can complete it (reembed.ts refuses a width other than the column's); ${retire}`);
              } else {
                const envPrefix = named && named.model !== embModel ? `OB1_EMBEDDING_MODEL=${named.model} ` : "";
                add("re-embed pass", "warn",
                    `${key}: ${formatPassCounts(c)} — a pass under this key stopped before it finished`,
                    finishIt(envPrefix, ` --job ${key}`, c, recordDiffers && envPrefix === ""));
              }
            }
            if (unfinished === 0) add("re-embed pass", "ok", "none unfinished");
          }
        } catch (e) {
          add("re-embed pass", "warn", `could not verify: ${(e as Error).message}`,
              "The check reads thought_work_claims and counts thoughts.");
        }

        if (Number(applied[0].c) === 0)
          add("migration ledger", "warn", "no schema_migrations table — the schema was applied by hand",
              "Adopt it with: cd db && bun migrate.ts --url $DATABASE_URL --baseline");
        else add("migration ledger", "ok", "schema_migrations present");

        await sql.close();
      } catch (e) {
        // The connection, or a read between two checks, failed: the first
        // check that has not reported carries the error as a warning, and
        // every later one says it was not reached — never a second row for a
        // check that already reported, never silence for one that did not.
        const missing = DIRECT_CHECKS.filter((name) => !results.some((r) => r.name === name));
        if (missing.length) add(missing[0], "warn", `could not verify: ${(e as Error).message}`);
        else add("direct connection", "warn", `every check reported, then the connection failed to close: ${(e as Error).message}`);
        for (const name of missing.slice(1)) add(name, "skip", `not checked — the direct connection failed before it: ${(e as Error).message}`);
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
