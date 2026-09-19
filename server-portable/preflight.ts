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
import { DEFAULT_MAX_TOKENS } from "./chunk.ts";
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
  REAPPLY_COMMAND,
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
  "atomic capture", "write privileges", "fingerprint backfill", "audit trail", "agent identity",
  "keyword search", "hybrid search", "stats summary", "provenance", "work claims", "search signatures", "edit signature", "delete signature", "filtered search",
  "candidate scan", "walk index", "chunk context", "trigram index", "embedding contract", "vector models",
  "updated_at trigger", "re-embed pass", "consolidate pass", "migration ledger", "query log",
];
/**
 * 020 gave match_thoughts and search_thoughts_hybrid the forms the servers
 * call; 027 last defines search_thoughts_hybrid (the relative floor) and 039
 * match_thoughts (the half-precision walk, over 038's gate), both under 020's
 * signatures. A remedy
 * that applied 020 alone would leave 020's bodies over theirs — the
 * stale-body state the ledger then cannot see — so the signature remedies
 * name all three, in order.
 */
const APPLY_020 = "Apply db/migrations/020_match_thoughts_recency.sql, then 027_search_thoughts_relative_floor.sql and 039_match_thoughts_halfvec_index.sql (the last definers of search_thoughts_hybrid and match_thoughts).";
/**
 * PostgREST answers a call it cannot resolve with PGRST202 both when the
 * function is missing and while its schema cache predates the migration that
 * added it — so a remedy that says only "apply" would send an operator who
 * has just applied it back to the migrator (first review pass of 021).
 */
const RELOAD_HINT = "If the ledger already records it, PostgREST may not have reloaded its schema cache: NOTIFY pgrst, 'reload schema';";
const APPLY_020_POSTGREST = `Apply the migrations through db/migrations/039_match_thoughts_halfvec_index.sql against the project's direct connection (server-portable/README.md §4) — 020 gives both functions the forms the server sends; 027 and 039 last define search_thoughts_hybrid and match_thoughts. ${RELOAD_HINT}`;
const APPLY_021 = "Apply db/migrations/021_embedding_model_per_row.sql.";
const APPLY_032 = "Apply db/migrations/032_update_thought_provenance.sql.";
const APPLY_041 = "Apply db/migrations/041_thought_citations.sql.";
/**
 * Where the ledger already records the migration a check finds absent — a
 * brain adopted with --baseline whose schema is the guide's — "apply it" is a
 * loop: a plain run skips a recorded file. The migrator's re-run is the remedy
 * (SMD-1193); the 014, 019 and 023 remedies read the ledger the same way.
 */
const REAPPLY = `The ledger records that migration but the schema installed is older — adopted with --baseline, or a body put there or removed from outside the migrations (an earlier migration re-applied by hand, a vendored schema's CREATE OR REPLACE or DROP; SMD-1250): re-apply the recorded migrations with the migrator — ${REAPPLY_COMMAND} — with the server and every worker stopped; a plain run skips a recorded file.`;
const APPLY_021_POSTGREST = `Apply the migrations through db/migrations/021_embedding_model_per_row.sql against the project's direct connection (server-portable/README.md §4). ${RELOAD_HINT}`;
const APPLY_032_POSTGREST = `Apply the migrations through db/migrations/032_update_thought_provenance.sql against the project's direct connection (server-portable/README.md §4). ${RELOAD_HINT}`;
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
{
  // The window a capture is split at, and where the number came from
  // (SMD-1305). The rule is db/config.mjs's — the call embed.ts makes — so this
  // prints what the server will do, not a second opinion of it. An explicit
  // limit over the model's window is the one configuration that defeats the
  // windows: a window that long is cut silently, which is what they exist to
  // prevent.
  const { resolveChunkTokens, MAX_WHOLE_TOKENS, DEFAULT_MODEL_WINDOW } = await import("../db/config.mjs");
  const chunk = resolveChunkTokens(env.OB1_CHUNK_TOKENS, embModel, DEFAULT_MAX_TOKENS);
  const windowText = chunk.window !== undefined
    ? `${embModel}'s ${chunk.window}-token window`
    : `${embModel}'s window, which db/config.mjs's KNOWN_MODEL_WINDOW does not list`;
  const rule = `captures over ${chunk.threshold} tokens are windowed at ${chunk.tokens}`;
  /** The most an explicit limit can be and keep the ratio the default keeps under this window. */
  const headroom = chunk.window !== undefined ? Math.floor((chunk.window * DEFAULT_MAX_TOKENS) / DEFAULT_MODEL_WINDOW) : undefined;
  if (chunk.from === "OB1_CHUNK_TOKENS" && chunk.window !== undefined && chunk.tokens > chunk.window) {
    add("chunk window", "warn",
        `OB1_CHUNK_TOKENS=${chunk.tokens} is over ${windowText} — a window that long is cut at ${chunk.window} tokens silently, which is the failure the windows exist to prevent`,
        `Unset OB1_CHUNK_TOKENS to derive the rule from the window, or set it under ${chunk.window}.`);
  } else if (chunk.from === "OB1_CHUNK_TOKENS" && headroom !== undefined && chunk.tokens > headroom) {
    // Under the window but over the headroom the estimate needs: chunk.ts
    // assembled a 1730-token window against a 1200 target on randomised prose
    // before its post-condition, and the estimate itself is a guess — the
    // ratio the constant fixes is the measured margin (second review pass).
    add("chunk window", "warn",
        `OB1_CHUNK_TOKENS=${chunk.tokens} leaves little headroom under ${windowText} — the token count is an estimate, and a window that overshoots is cut at ${chunk.window} tokens silently`,
        `Set OB1_CHUNK_TOKENS at or under ${headroom}, the ratio the default keeps, or unset it.`);
  } else if (chunk.from === "OB1_CHUNK_TOKENS") {
    add("chunk window", "ok", `${rule}, from OB1_CHUNK_TOKENS (${windowText})`);
  } else if (chunk.from === "window") {
    add("chunk window", "ok",
        `${rule}, derived from ${windowText}${chunk.capped ? ` — the threshold capped at ${MAX_WHOLE_TOKENS}, past which the whole vector alone was measured to lose recall, the window at the shipped size, which larger windows were measured not to beat (evals/README.md, SMD-1305)` : ""}`);
  } else {
    add("chunk window", "ok",
        `${rule}, the default for ${windowText} — set OB1_CHUNK_TOKENS if the provider embeds fewer than ${DEFAULT_MODEL_WINDOW} tokens in one request`);
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
         * Migration 032 gave update_thought a ninth parameter, the provenance
         * envelope, by dropping the 8-argument form — as 021 gave it the
         * eighth, the model beside the vector, by dropping the seventh — and
         * the store sends all nine by name on every edit. Probed as the store
         * calls it, with an id no row has: update_thought answers {ok:false,
         * error:'NOT_FOUND'} from its row-lock read and writes nothing, so
         * the probe is free. PGRST202 is a form from before 032 (or no
         * function). Then seven named arguments, which only two forms — 018's
         * or 021's re-applied by hand beside 032's — make ambiguous, and that
         * breaks every PostgREST caller by name that predates this change.
         */
        try {
          const { SUPERSEDED_SIGNATURES } = await import("../db/config.mjs");
          const nobody = "00000000-0000-4000-8000-000000000000";
          const seven = { p_id: nobody, p_content: null, p_metadata_patch: null, p_embedding: null, p_chunks: null, p_if_unchanged_since: null, p_actor: null };
          const { data: nine, error: nineErr } = await legacy.rpc("update_thought", { ...seven, p_embedding_model: null, p_provenance: null });
          if (nineErr && missing(nineErr.message)) {
            add("edit signature", "fail",
                "update_thought does not take p_provenance over PostgREST — it is missing or is a form from before migration 032 — and the server sends it on every edit, so every update_thought call would fail",
                APPLY_032_POSTGREST);
          } else if (nineErr) {
            add("edit signature", "skip", `could not probe update_thought over PostgREST (${nineErr.message}); ${CATALOG_HINT}`);
          } else if ((nine as { error?: string } | null)?.error !== "NOT_FOUND") {
            add("edit signature", "skip", `update_thought answered a probe for an id no row has with ${JSON.stringify(nine)} rather than NOT_FOUND; ${CATALOG_HINT}`);
          } else {
            const { error: sevenErr } = await legacy.rpc("update_thought", seven);
            if (!sevenErr) {
              add("edit signature", "ok", "update_thought takes 032's arguments over PostgREST, and a 7-argument call resolves to one function — no earlier form beside it");
            } else if (/could not choose|PGRST203|not unique/i.test(sevenErr.message)) {
              add("edit signature", "fail",
                  "update_thought has more than one form — an earlier migration re-applied by hand beside 032's — and PostgREST cannot choose between them for a call with fewer than nine arguments, so every caller by name from before this change fails",
                  // IF EXISTS: this path cannot read the catalog, so both older
                  // forms are named and the absent one must not error when pasted.
                  `Drop the earlier form, as 032 does, against the project's direct connection — whichever the catalog shows: ${SUPERSEDED_SIGNATURES.filter((s) => s.startsWith("update_thought")).map((s) => `DROP FUNCTION IF EXISTS ${s};`).join(" ")}`);
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
      add("write privileges", "skip", `not checked over PostgREST — the capture path's table privileges are read over a direct connection; ${CATALOG_HINT}`);
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

        // One schema-qualified read of every form, signature and body; no name
        // or type resolved through the session's search_path (to_regprocedure
        // returns NULL where `vector` is out of the path on PG16, and raises
        // on PG15 — into the catch below, taking every later check with it).
        // The signature is built from pg_type's names, not regprocedure's
        // text: that text schema-qualifies `vector` when pgvector is off the
        // path (the shape the `vector extension` check above fails), and a
        // pick by it would then have called a present form missing (second
        // review pass, SMD-1250).
        const forms = (await sql`
          SELECT p.proname || '(' || COALESCE((SELECT string_agg(t.typname, ',' ORDER BY a.n)
                                                 FROM unnest(p.proargtypes) WITH ORDINALITY AS a(o, n)
                                                 JOIN pg_type t ON t.oid = a.o), '') || ')' AS sig,
                 p.prosrc AS src
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'upsert_thought' AND n.nspname = 'public'`) as { sig: string; src: string }[];
        const { UPSERT_TWO_ARG_SHIPPED_RE, UPSERT_THREE_ARG_SHIPPED_RE, RELEASE_SHIPPED_RE, THOUGHT_STATS_SHIPPED_RE } = await import("../db/config.mjs");
        /** A function's signature from pg_type's names — the same text on every search_path (see `forms` below). */
        const SIG_SQL = `p.proname || '(' || COALESCE((SELECT string_agg(t.typname, ',' ORDER BY a.n) FROM unnest(p.proargtypes) WITH ORDINALITY AS a(o, n) JOIN pg_type t ON t.oid = a.o), '') || ')'`;
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
            // Every recorded name, as its three-digit prefix: the ledger holds a
            // few dozen short rows, and a list of the migrations that have a
            // ledger-aware remedy was one more thing to keep in step (it had
            // drifted from its own comment by the seventh review pass of SMD-1193).
            const led = await sql`SELECT name FROM schema_migrations`;
            ledger = new Set(led.map((r: { name: string }) => String(r.name).slice(0, 3)));
            ledgerRead = true;
          } catch {
            /* no SELECT on the ledger for this role: a remedy that depends on it says so */
          }
        }
        /**
         * The remedy for a migration a check finds absent: recorded in the
         * ledger, the migrator's re-run (a plain run skips a recorded file);
         * not recorded, or no ledger, apply it; the ledger unreadable to this
         * role, apply it — or, if the ledger records it, the re-run — said as
         * the 023 remedy says it, so an unread ledger is never mistaken for one
         * that does not record the migration.
         */
        const ledgerRemedy = (migration: string, apply: string): string =>
          ledger.has(migration)
            ? REAPPLY
            : ledgerRead || Number(applied[0].c) === 0
              ? apply
              : `${apply} — or, if the ledger already records ${migration} (this role cannot read schema_migrations): ${REAPPLY.charAt(0).toLowerCase()}${REAPPLY.slice(1)}`;
        // By signature, not arity: a vendored bootstrap's upsert_thought(text,
        // vector, jsonb) is a third 3-argument form, and reading whichever the
        // catalog returned first judged a healthy brain by the wrong body
        // (first review pass; SMD-1245's arity-alone finding).
        const three = forms.find((f) => f.sig === "upsert_thought(text,jsonb,vector)");
        const two = forms.find((f) => f.sig === "upsert_thought(text,jsonb)");
        // 007/013's 4-argument form — the windowed capture the servers call —
        // is the third form the migrations define; anything else is a
        // vendored file's, and is named.
        const FOUR = "upsert_thought(text,jsonb,vector,jsonb)";
        const others = forms.filter((f) => f !== three && f !== two && f.sig !== FOUR).map((f) => f.sig);
        const andOthers = others.length ? `; ${others.length} other upsert_thought overload(s) (${others.join(", ")}), which no migration defines and the servers never call` : "";
        // The bodies' semantics are declared by sentinels in the bodies
        // themselves (the 014 convention): `ob1:vector-replaces-chunks` (022)
        // — the windows stay while the label vouches for them and go
        // otherwise — `ob1:capture-takes-fingerprint-lock` (033, in BOTH
        // forms) — a capture takes the advisory lock update_thought takes, so
        // a capture and an edit of one text are serialised — and
        // `ob1:re-capture-writes-no-provenance` (035, the 3-argument form) —
        // a re-capture leaves an existing thought's provenance as it is, so
        // no capture can close a supersession loop and none takes the
        // supersession lock. 025 kept 022's sentinel and added the provenance
        // envelope, so 025's body is told from 022's by the clause 022's
        // lacks; and 005's 2-argument body, from before the convention, by
        // the guard 005 added. db/config.mjs holds those two recognisers and
        // test-schema [31] pins them to the bodies they name. Any CREATE OR
        // REPLACE from outside the migrations — an earlier migration by hand,
        // the getting-started guide pasted again, a vendored schema or recipe
        // (SMD-1250) — replaces a body with no error when the signature
        // matches; this is where the operator learns which body is there, and
        // which migration owns it. 035 is the last definer of BOTH forms (the
        // 2-argument body carried verbatim from 033), so one file is the
        // remedy for every stale state.
        const LAST = "035_recapture_writes_no_provenance.sql";
        const LOCKED = /ob1:capture-takes-fingerprint-lock/;
        const NO_FILL = /ob1:re-capture-writes-no-provenance/;
        const applyLast = (why: string) => ledgerRemedy("035", `Apply db/migrations/${LAST}${why}`);
        // The 2-argument body is judged on its own and said beside whichever
        // 3-argument state fires, so a brain with both replaced hears it once
        // rather than on the run after the first remedy (first review pass).
        // Two stale states: from before 005 (no guard) and from before 033
        // (005's guard, no lock).
        const twoStale = two !== undefined && !UPSERT_TWO_ARG_SHIPPED_RE.test(two.src);
        const twoUnlocked = two !== undefined && !twoStale && !LOCKED.test(two.src);
        const TWO_STALE_WHY = "it does not refuse a non-object payload, the one thing 005 added — so a CREATE OR REPLACE from outside the migrations put another there (the getting-started guide or the fingerprint recipe's Step 2 pasted onto a migrated brain, or a community schema that mirrors columns on write): PostgREST callers by name and the two-step fallback capture through that body, and a double-encoded payload is emptied silently again";
        // Why a body predates the migration that added what it lacks (`stage`:
        // 033 for the lock, 035 for the fill): the ordinary state on a brain
        // whose ledger stops before it — the run before `migrate.ts` — is not
        // a hand re-apply, and the cause must not say it is (SMD-1043's first
        // review pass). With the ledger recording 035, the last definer, a
        // hand re-apply is the only way; with it recording `stage` but not
        // 035, the earlier file was re-applied by hand AND the remedy is still
        // pending, and the cause says both.
        const pre = (stage: string, earlier: string) => {
          // The unapplied files, named: 035 alone when `stage` is 035 or the
          // ledger has it, both otherwise (a brain at 032 lacks 033 as well).
          const pending = stage === "035" ? "migration 035 is" : `migrations ${stage} and 035 are`;
          return ledger.has("035") ? `${earlier} re-applied by hand puts it back`
            : ledgerRead && ledger.has(stage) ? `${earlier} re-applied by hand puts it back, and migration 035 is not yet applied`
            : ledgerRead ? `${pending} not yet applied`
              : `${pending} not yet applied, or ${earlier} was re-applied by hand`;
        };
        const TWO_UNLOCKED_WHY = `it is from before migration 033 (${pre("033", "005")}): it takes no fingerprint lock, so a capture through it racing an edit of the same text raises the unique violation`;
        const andTwo = twoStale ? `; and the 2-argument body is not 005's either — ${TWO_STALE_WHY}` : twoUnlocked ? `; and the 2-argument body is not 035's either — ${TWO_UNLOCKED_WHY}` : "";
        if (!three) {
          add("atomic capture", "fail", `${forms.length} upsert_thought overload(s) — the 3-argument form, the atomic capture, is missing${twoStale ? `; and the 2-argument body present is not 005's — ${TWO_STALE_WHY}` : twoUnlocked ? `; and the 2-argument body present is not 035's — ${TWO_UNLOCKED_WHY}` : ""}${andOthers}`,
              applyLast(" — the last definer of both forms (004 created the 3-argument one; 005, 008, 021, 022, 025, 033 and 035 redefined it, and an earlier file's body alone would drop what every later one added)."));
        } else if (!two) {
          // This server never calls the 2-argument form; PostgREST callers by
          // name and the two-step fallback do. A warning.
          add("atomic capture", "warn", `${forms.length} upsert_thought overload(s) — the 2-argument form is missing; this server does not call it, PostgREST callers by name and the two-step capture fallback do${andOthers}`,
              applyLast(" — the last definer of the 2-argument form as well."));
        } else if (!/ob1:vector-replaces-chunks/.test(three.src)) {
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present, but the 3-argument body is from before migration 022 (004, 005, 008 or 021 re-applied by hand without 035 after them): a re-capture that makes no windows — the Edge Function server, or a window that grew — at another model replaces the vector and leaves the previous vector's chunk rows under it, so search finds the thought by windows it no longer has; and it takes no fingerprint lock${andTwo}${andOthers}`,
              applyLast(" — the last definer; 022's or 025's file alone would leave what the later ones added out."));
        } else if (!UPSERT_THREE_ARG_SHIPPED_RE.test(three.src)) {
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule, but it is from before migration 025 (022 re-applied by hand puts it back): a capture that names derived_from or supersedes has them dropped silently, and nothing downstream can tell; and it takes no fingerprint lock${andTwo}${andOthers}`,
              applyLast("."));
        } else if (!LOCKED.test(three.src)) {
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule and 025's envelope, but it is from before migration 033 (${pre("033", "025")}): it takes no fingerprint lock, so a capture racing an edit of the same text raises the unique violation 018 removed for edits, and a re-capture racing a first capture leaves windows nothing vouches for${andTwo}${andOthers}`,
              applyLast("."));
        } else if (!NO_FILL.test(three.src)) {
          // 033's body: locked, and still filling a NULL supersedes on a
          // re-capture without walking the chain, under the brain-wide
          // supersession lock (SMD-1453). The 2-argument body is 033's = 035's.
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule, 025's envelope and the fingerprint lock, but it is from before migration 035 (${pre("035", "033")}): a re-capture naming supersedes fills a NULL pointer without walking the chain, so a dedup can write a two-row loop, and every capture naming supersedes holds the supersession lock through its insert — about 145 a second at 1,024 dimensions whatever the worker count${andTwo}${andOthers}`,
              applyLast("."));
        } else if (twoStale || twoUnlocked) {
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present and the 3-argument body is 035's, but the 2-argument body is ${twoStale ? `not 005's — ${TWO_STALE_WHY}` : `not 035's — ${TWO_UNLOCKED_WHY}`}${andOthers}`,
              applyLast(" — the last definer of the 2-argument form as well."));
        } else {
          add("atomic capture", "ok", `the 2- and 3-argument upsert_thought present, both 035's — the 3-argument body carries 022's rule, so a re-capture's windows stay only while the label vouches for them, 025's provenance envelope, the fingerprint lock, so a capture and an edit of one text are serialised, and writes provenance on a first capture only, so no capture can close a supersession loop; the 2-argument body refuses a non-object payload (005) and takes the lock${andOthers}`);
        }

        // The privileges the capture path's SECURITY INVOKER writers need to run
        // as their caller, checked as one set: every windowed capture INSERTs —
        // and since 022, on a re-capture the label does not vouch for, DELETEs —
        // thought_chunks, every edit with content replaces those rows, and 008's
        // trigger INSERTs thought_audit on every capture, edit and delete. So a
        // role granted `thoughts` alone, as the guide's grant step gives, fails
        // its first windowed capture on thought_chunks and its first capture of
        // any kind on the audit trigger. CAPTURE_WRITES is db/config.mjs's list,
        // the one shared with `migrate.ts --grant` and db/README.md's grants
        // section. Schema-qualified and gated on presence: the text form of
        // has_table_privilege RAISES for a relation it cannot see, and a raise
        // here would land in the catch below and take every later check with it,
        // so a table absent before its migration is skipped, not failed.
        const { CAPTURE_WRITES, EXTRACTION_TRIGGER_WRITES } = await import("../db/config.mjs");
        // 016's enqueue trigger fires AFTER INSERT OR UPDATE OF content on
        // thoughts and runs as the calling role. It reads ob1_config on EVERY
        // capture — unconditionally, before it even looks at the key — and, while
        // entity_extraction_key is set, upserts a thought_work_claims row. So the
        // trigger's mere presence makes SELECT on ob1_config a hard capture-path
        // requirement, and a set key adds thought_work_claims INSERT/UPDATE. The
        // trigger is read via pg_trigger (tgrelid = to_regclass, so an absent
        // thoughts matches nothing rather than raising); the key inside CASE
        // guards, so has_table_privilege — which raises for a relation it cannot
        // see — is reached only when the trigger, hence 006's ob1_config, exists.
        const [{ role, ident, triggerPresent, canReadConfig }] = (await sql`
          SELECT current_user::text AS role, quote_ident(current_user::text) AS ident,
                 EXISTS (SELECT 1 FROM pg_trigger
                          WHERE tgrelid = to_regclass('public.thoughts')
                            AND tgname = 'thoughts_entity_extraction' AND NOT tgisinternal) AS "triggerPresent",
                 CASE WHEN to_regclass('public.ob1_config') IS NOT NULL
                      THEN has_table_privilege('public.ob1_config', 'SELECT') ELSE false END AS "canReadConfig"`) as
          { role: string; ident: string; triggerPresent: boolean; canReadConfig: boolean }[];
        // Read the key in its own statement, run only when the role can SELECT
        // ob1_config — an uncorrelated `(SELECT … FROM ob1_config)` in the query
        // above would become an InitPlan Postgres evaluates regardless of any
        // CASE guard, raising `permission denied` for a role without that SELECT
        // and taking every later check down with it. When the trigger is present
        // but the role cannot read the key, extraction is treated as off — but
        // ob1_config SELECT is still required below (the trigger reads it), so the
        // role is refused for that, not blessed.
        let ek: string | null = null;
        if (canReadConfig) {
          const [row] = (await sql`SELECT value FROM ob1_config WHERE key = 'entity_extraction_key'`) as { value: string | null }[];
          ek = row?.value ?? null;
        }
        const extracting = triggerPresent && canReadConfig && typeof ek === "string" && ek !== "";
        // What the 016 trigger adds to the capture path when it is present: its
        // own ob1_config read always, the work-claim upsert while extraction is on.
        const conditional = triggerPresent
          ? [{ table: "ob1_config", privilege: "SELECT", since: "016" }, ...(extracting ? EXTRACTION_TRIGGER_WRITES : [])]
          : [];
        const required = [...CAPTURE_WRITES, ...conditional];
        const reqTables = required.map((w) => w.table);
        const reqPrivs = required.map((w) => w.privilege);
        const privRows = (await sql`
          WITH req AS (
            SELECT tbl, priv
              FROM unnest(${sql.array(reqTables, "TEXT")}::text[], ${sql.array(reqPrivs, "TEXT")}::text[]) AS r(tbl, priv)
          ), present AS (
            SELECT DISTINCT tbl, to_regclass('public.' || tbl) IS NOT NULL AS ok FROM req
          )
          SELECT req.tbl, req.priv, present.ok AS present,
                 CASE WHEN present.ok THEN has_table_privilege('public.' || req.tbl, req.priv) END AS granted
            FROM req JOIN present USING (tbl)`) as { tbl: string; priv: string; present: boolean; granted: boolean | null }[];
        const grantState = new Map(privRows.map((r) => [`${r.tbl} ${r.priv}`, r.granted]));
        const presentTables = new Set(privRows.filter((r) => r.present).map((r) => r.tbl));
        if (!presentTables.has("thoughts")) {
          add("write privileges", "skip", "not checked — thoughts does not exist (before migration 001)");
        } else {
          // Present tables only, in `required` order (SELECT, INSERT, …), so a
          // GRANT reads the way the guide writes one and names only what is
          // missing — never what the role already holds. Keyed by table, so a
          // table's privileges land in one entry (de-duplicated).
          const missingByTable = new Map<string, string[]>();
          const heldByTable = new Map<string, string[]>();
          for (const w of required) {
            if (!presentTables.has(w.table)) continue;
            const target = grantState.get(`${w.table} ${w.privilege}`) ? heldByTable : missingByTable;
            const into = target.get(w.table) ?? [];
            if (!into.includes(w.privilege)) into.push(w.privilege);
            target.set(w.table, into);
          }
          const absent = reqTables.filter((t, i) => reqTables.indexOf(t) === i && !presentTables.has(t));
          const triggerMiss = triggerPresent && (missingByTable.has("ob1_config") || missingByTable.has("thought_work_claims"));
          const why = triggerMiss
            ? " — a windowed capture, an edit with content, 008's audit trigger, or 016's enqueue trigger — which as the caller reads ob1_config on every capture, and upserts a work claim while entity extraction is enabled — would fail"
            : " — so a windowed capture, an edit with content, or 008's audit trigger would fail";
          if (missingByTable.size) {
            const phrase = [...missingByTable].map(([t, ps]) => `${ps.join(", ")} on ${t}`).join("; ");
            const grants = [...missingByTable].map(([t, ps]) => `GRANT ${ps.join(", ")} ON ${t} TO ${ident};`).join("  ");
            add("write privileges", "fail",
                `this connection's role (${role}) is missing privileges the capture path's writers need, run as their caller: ${phrase}${why}`,
                grants);
          } else {
            const held = [...heldByTable].map(([t, ps]) => `${ps.join("/")} on ${t}`).join(", ");
            const note = extracting ? " — entity extraction is enabled, so the enqueue trigger's work-claim writes are included" : "";
            add("write privileges", "ok",
                `${role} holds the capture path's privileges — ${held}${note}${absent.length ? ` (${absent.join(", ")} not yet present)` : ""} (the agent, worker and extraction grants are documented and granted separately — see db/README.md)`);
          }
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
              const byHand = `re-apply the recorded migrations with the migrator — ${REAPPLY_COMMAND} — which re-runs every migration in one transaction (OB1_BACKFILL_LIMIT bounds 023's call as on a first apply; stop the server and any worker first).`;
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
                 "Apply the migrations through db/migrations/027_search_thoughts_relative_floor.sql (017_search_thoughts_hybrid.sql defines it; 020_match_thoughts_recency.sql redefines it with the arguments the server sends; 027 last defines it — stopping at 020 would leave 020's body over 027's).");

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
          SELECT p.prosrc AS src FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname = 'thought_stats_summary' AND n.nspname = 'public'`;
        // And whose body (SMD-1250): 024 took this function from the
        // edge-function-cost-optimization recipe and hardened it — topics and
        // people unnested only when they are arrays, null elements dropped. The
        // recipe's migration, pasted onto a migrated brain, puts the recipe's
        // body back under the same signature with no error, and thought_stats
        // then raises on the first thought whose topics hold a null element.
        if (stats.length === 0) add("stats summary", "fail",
                 "thought_stats_summary is missing, but thought_stats calls it on the SQL path — every thought_stats call would fail",
                 ledgerRemedy("024", "Apply db/migrations/024_thought_stats_summary.sql."));
        else if (!stats.some((s: { src: string }) => THOUGHT_STATS_SHIPPED_RE.test(String(s.src)))) add("stats summary", "warn",
                 "thought_stats_summary present, but its body is not 024's — it does not guard the topics array by type, so a thought whose topics hold a null element or are not an array makes every thought_stats call raise (field name must not be null) — a CREATE OR REPLACE from outside the migrations put another there (the edge-function-cost-optimization recipe's migration, which 024 took this function from)",
                 ledgerRemedy("024", "Apply db/migrations/024_thought_stats_summary.sql."));
        else add("stats summary", "ok", "thought_stats_summary present, 024's body");

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
            count(*) FILTER (WHERE p.proname = 'find_derivatives')::int AS f,
            bool_or(p.proname = 'trace_provenance' AND p.prosrc LIKE '%ob1:provenance-walk-bounded%') AS bounded
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname IN ('trace_provenance', 'find_derivatives') AND n.nspname = 'public'`;
        // Per function, not a combined count: a double-overload of one plus the
        // other absent must still fail, as the sibling signature checks do
        // (review pass 1, SMD-1253). And whose body: 026 redefined
        // trace_provenance as a walk-global BFS under the sentinel
        // `ob1:provenance-walk-bounded` (SMD-1288); 025 re-applied by hand puts
        // 025's per-path walk back with no error. Upstream's provenance-chains
        // body, under the same signature, does NOT install over it — its
        // RETURNS TABLE differs, so CREATE OR REPLACE fails on the return type
        // — but does after the DROP its own rollback runs, and the migrator's
        // re-run then fails on the same return type until both functions are
        // dropped again (SMD-1250, fourth review pass, which ran it).
        const DROP_FIRST = " If the body there returns other columns than 026's (upstream's provenance-chains, installed after a DROP), the re-run fails with 'cannot change return type': run DROP FUNCTION trace_provenance(uuid, int, int), find_derivatives(uuid, int); first.";
        if (Number(prov[0].t) >= 1 && Number(prov[0].f) >= 1) {
          if (prov[0].bounded) add("provenance", "ok", "trace_provenance and find_derivatives present; trace_provenance's body is 026's, the walk bounded");
          else add("provenance", "warn",
                   "trace_provenance and find_derivatives present, but trace_provenance's body is not 026's — the bounded walk's sentinel is absent — so a CREATE OR REPLACE from outside the migrations put another there (025 re-applied by hand, or upstream's provenance-chains body after a DROP): a dense derivation graph expands multiplicatively again and a trace can run to the statement timeout (SMD-1288)",
                   ledgerRemedy("026", "Apply db/migrations/026_trace_provenance_bounded.sql.") + DROP_FIRST);
        } else add("provenance", "fail",
                 "migration 025's provenance functions are missing, but capture_thought accepts derived_from/supersedes (silently dropped by the pre-025 upsert_thought) and search labels superseded hits",
                 ledgerRemedy("025", "Apply db/migrations/025_thought_provenance.sql."));

        /**
         * Migration 015's claim functions, and 031's (SMD-1250, fourth review
         * pass). Upstream's thought-work-claims schema defines release_thought
         * and release_claims_for_worker under 015's exact signatures, so a
         * paste replaces both bodies with no error, and the three workers
         * then break at the first release: upstream's release leaves the lease
         * set, which 015's CHECK refuses, and its release_claims_for_worker
         * DELETEs the worker's rows instead of returning them to the pool.
         * 015's bodies are recognised by the one clause both share and
         * upstream's lack — the lease cleared (db/config.mjs holds it;
         * test-schema [31] pins it). Any overload of these names no migration
         * defines is a vendored install too — upstream's claim_thoughts takes
         * an id list where 015's takes a pool — and is named. Nothing to read
         * before 015: a skip, as the re-embed pass check says it.
         */
        const KNOWN_CLAIM_SIGS = new Set(["claim_thoughts(text,text,int4,int4,int4)", "release_thought(uuid,text,text,text,text)", "release_claims_for_worker(text,text)", "renew_claims(text,text,int4)"]);
        const wc = (await sql.unsafe(`
          SELECT ${SIG_SQL} AS sig, p.prosrc AS src FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.proname IN ('claim_thoughts', 'release_thought', 'release_claims_for_worker', 'renew_claims') AND n.nspname = 'public'`)) as { sig: string; src: string }[];
        const release = wc.find((f) => f.sig === "release_thought(uuid,text,text,text,text)");
        const forWorker = wc.find((f) => f.sig === "release_claims_for_worker(text,text)");
        // Spelled as pg_type spells them (_uuid, int4) — a spelling DROP FUNCTION accepts.
        const strays = wc.filter((f) => !KNOWN_CLAIM_SIGS.has(f.sig)).map((f) => f.sig);
        const andStrays = strays.length ? `; ${strays.length} overload(s) no migration defines: ${strays.join(", ")} — a vendored schema's (upstream's thought-work-claims takes an id list where 015's claim_thoughts takes a pool)` : "";
        if (wc.length === 0) {
          add("work claims", "skip", "not checked — the claim functions do not exist (migration 015 not applied)");
        } else if (!release || !forWorker) {
          add("work claims", "fail", `015's release_thought or release_claims_for_worker is missing under 015's signature; the three workers call both${andStrays}`,
              ledgerRemedy("015", "Apply db/migrations/015_thought_work_claims.sql, then 028 (its comment on release_thought) and 031 (renew_claims) again."));
        } else if (!RELEASE_SHIPPED_RE.test(release.src) || !RELEASE_SHIPPED_RE.test(forWorker.src)) {
          add("work claims", "fail",
              `release_thought's or release_claims_for_worker's body is not 015's — it does not clear the lease as 015's CHECK requires — so a CREATE OR REPLACE from outside the migrations put another there (upstream's thought-work-claims schema shares both signatures): every worker release fails the constraint, and a clean shutdown deletes the worker's rows instead of returning them to the pool${andStrays}`,
              ledgerRemedy("015", "Apply db/migrations/015_thought_work_claims.sql, then 028 again — the same paste overwrites 028's comment on release_thought."));
        } else if (strays.length) {
          add("work claims", "warn", `claim_thoughts, release_thought, release_claims_for_worker and renew_claims present with 015's and 031's bodies${andStrays}`,
              strays.map((s) => `DROP FUNCTION ${s};`).join(" "));
        } else {
          add("work claims", "ok", "claim_thoughts, release_thought, release_claims_for_worker and renew_claims present with 015's and 031's bodies");
        }

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
         * Migrations 021 and 032 changed update_thought's signature the same
         * way — a defaulted parameter added (021 the model beside the vector,
         * 032 the provenance envelope), the earlier form dropped — and both
         * stores send all nine. The same two states break every edit and
         * neither shows in a presence check: the function predates 032 (the
         * call has no function to resolve to), or an old form was re-created
         * BESIDE 032's by a hand re-apply of 009/013/018/021 (032's answers
         * the server; every call with fewer arguments — a PostgREST caller by
         * name from before this change, hand-written SQL, community
         * integrations, reembed.ts's positional eight — is "function is not
         * unique").
         */
        try {
          const { UPDATE_THOUGHT_SIGNATURE } = await import("../db/config.mjs");
          const ut = (await sql`
            SELECT p.pronargs AS nargs, p.oid::regprocedure::text AS sig
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'update_thought' AND n.nspname = 'public'
            ORDER BY (p.pronargs = 9) DESC, p.oid`) as { nargs: number; sig: string }[];
          const current = ut.filter((r) => Number(r.nargs) === 9);
          const extra = ut.filter((r) => Number(r.nargs) !== 9).map((r) => r.sig);
          if (!ut.length) {
            add("edit signature", "fail", "update_thought is missing — the update_thought tool and db/reembed.ts call it", ledgerRemedy("032", APPLY_032));
          } else if (current.length && extra.length === 0) {
            add("edit signature", "ok", `${current[0].sig}: the form the servers and reembed.ts call since migration 032 (${UPDATE_THOUGHT_SIGNATURE}), alone`);
          } else if (current.length) {
            add("edit signature", "fail",
                `beside the form the servers call there ${extra.length === 1 ? "is an earlier one" : `are ${extra.length} earlier ones`}: ${extra.join(", ")} — an earlier migration re-applied by hand over 032 — so every call that sends fewer than nine arguments to update_thought, which is every PostgREST caller by name from before this change, every hand-written SELECT and db/reembed.ts's positional eight, fails with "function is not unique"`,
                `Drop the earlier form, as 032 does: ${extra.map((sig) => `DROP FUNCTION ${sig};`).join(" ")}`);
          } else {
            add("edit signature", "fail",
                `${extra.join(" and ")} ${extra.length === 1 ? "is the form" : "are the forms"} from before migration 032; the server sends p_provenance, which only 032's form takes — so every edit would fail, and db/reembed.ts refuses to run`,
                ledgerRemedy("032", APPLY_032));
          }
        } catch (e) {
          add("edit signature", "warn", `could not verify: ${(e as Error).message}`, "The catalog read behind this check needs SELECT on pg_proc.");
        }

        /**
         * Migration 041 changed delete_thought the way 021 and 032 changed
         * update_thought: a defaulted third parameter (p_detach), the
         * two-argument form dropped, both stores sending all three. The same
         * two states break every delete and neither shows in a presence
         * check: the function predates 041 (the call has no function to
         * resolve to — a server deployed ahead of the migration fails at the
         * first user delete, not at start), or the two-argument form was
         * re-created BESIDE 041's by a hand re-apply of 009 or 036 (every
         * two-argument caller — the vendored servers' rpc by name, hand SQL —
         * is "function is not unique").
         */
        try {
          const dt = (await sql`
            SELECT p.pronargs AS nargs, p.oid::regprocedure::text AS sig
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'delete_thought' AND n.nspname = 'public'
            ORDER BY (p.pronargs = 3) DESC, p.oid`) as { nargs: number; sig: string }[];
          const current = dt.filter((r) => Number(r.nargs) === 3);
          const extra = dt.filter((r) => Number(r.nargs) !== 3).map((r) => r.sig);
          if (!dt.length) {
            add("delete signature", "fail", "delete_thought is missing — the delete_thought tool calls it", ledgerRemedy("041", APPLY_041));
          } else if (current.length && extra.length === 0) {
            add("delete signature", "ok", `${current[0].sig}: the form the servers call since migration 041, alone`);
          } else if (current.length) {
            add("delete signature", "fail",
                `beside the form the servers call there ${extra.length === 1 ? "is an earlier one" : `are ${extra.length} earlier ones`}: ${extra.join(", ")} — 009 or 036 re-applied by hand over 041 — so every call that sends two arguments to delete_thought, which is every PostgREST caller by name from before this change and every hand-written SELECT, fails with "function is not unique"`,
                `Drop the earlier form, as 041 does: ${extra.map((sig) => `DROP FUNCTION ${sig};`).join(" ")}`);
          } else {
            add("delete signature", "fail",
                `${extra.join(" and ")} ${extra.length === 1 ? "is the form" : "are the forms"} from before migration 041; the server sends p_detach, which only 041's form takes — so every delete would fail`,
                ledgerRemedy("041", APPLY_041));
          }
        } catch (e) {
          add("delete signature", "warn", `could not verify: ${(e as Error).message}`, "The catalog read behind this check needs SELECT on pg_proc.");
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
                `Upgrade the server's pgvector to 0.8.0 or later (deploy/compose.yaml pins 0.8.6), then ${ledgerHas014 ? `re-apply the recorded migrations with the migrator — ${REAPPLY_COMMAND} — since a plain run skips a recorded file (--baseline recorded it)` : "apply db/migrations/014_filtered_match_thoughts.sql"}.`);
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
                  ? `Re-apply the recorded migrations with the migrator — ${REAPPLY_COMMAND} — which restores the last definer's body (a plain run skips a recorded file), or carry the SET clause into the migration that redefined match_thoughts.`
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
         * Migration 039: match_thoughts' walk branches order by
         * `embedding::halfvec(D)`, and the two HNSW indexes are built over that
         * expression under 001's and 007's names. The planner matches the two
         * structurally, so they are one contract in two halves, and each half
         * can be moved by hand without the other: 037 or 020 re-applied over
         * 039 (a raw-column body over the halfvec index), 001's DDL re-run
         * after a drop (the cast body over a vector index), an interrupted
         * CREATE INDEX CONCURRENTLY left INVALID under the name. Each leaves
         * every unfiltered and broad-filter search a sequential scan of both
         * tables under `enable_seqscan = off` — exact, at 019's cost — and
         * nothing else reads as wrong: proconfig is intact, the ledger
         * records 039. Read from the catalog: the ORDER BY of the body (the
         * statement, not a word a comment could carry) and each index's
         * definition and validity. A WARNING, as 019's: searches answer.
         */
        try {
          if (catalog instanceof Error) throw catalog;
          const { mt, ledger } = catalog;
          if (!mt.length) {
            add("walk index", "skip", "not checked — match_thoughts is not defined (filtered search says so)");
          } else {
            const bodyCasts = /ORDER BY \w+\.embedding::halfvec\(\d+\) <=> query_embedding::halfvec\(\d+\)/.test(mt[0].src);
            const HALF = /USING hnsw \(\(\(embedding\)::(\w+\.)?halfvec\(\d+\)\) (\w+\.)?halfvec_cosine_ops\)$/;
            const idx = (await sql`
              SELECT n.name, pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
              FROM (VALUES ('thoughts_embedding_idx'), ('thought_chunks_embedding_idx')) AS n(name)
              LEFT JOIN pg_index i ON i.indexrelid = to_regclass('public.' || n.name)`) as { name: string; def: string | null; valid: boolean | null }[];
            const problems: string[] = [];
            for (const r of idx) {
              if (r.def === null) problems.push(`${r.name} does not exist`);
              else if (r.valid === false) problems.push(`${r.name} is INVALID (an interrupted CREATE INDEX CONCURRENTLY), which the planner ignores`);
              else if (HALF.test(r.def) !== bodyCasts) problems.push(`${r.name} is over ${HALF.test(r.def) ? "embedding::halfvec" : /\(embedding vector_cosine_ops\)$/.test(r.def) ? "the vector column" : `another expression (${r.def.replace(/^.*USING /, "")})`}`);
            }
            const ledgerHas039 = ledger.has("039");
            if (!problems.length) {
              add("walk index", "ok", bodyCasts
                ? "match_thoughts orders its walk by embedding::halfvec and both HNSW indexes are over that expression (039)"
                : "match_thoughts orders its walk by the vector column and both HNSW indexes are over it (before 039)");
            } else {
              add("walk index", "warn",
                  `match_thoughts orders its walk by ${bodyCasts ? "embedding::halfvec" : "the vector column"} but ${problems.join("; ")}${ledgerHas039 ? " — although migration 039 is recorded as applied: an earlier definer re-applied by hand, or an index rebuilt by hand" : ""} — the planner has no index path for the walk, so every unfiltered and broad-filter search sequentially scans both tables (exact; 019's latency back)`,
                  `Apply db/migrations/039_match_thoughts_halfvec_index.sql — \`bun db/migrate.ts\` where the ledger does not record it, \`--reapply\` or the file alone against the direct connection where it does — which swaps a vector index under the name for the halfvec one, builds where the name is free, rebuilds an INVALID one and restores the body's cast; on a brain past a million rows build the staging indexes CONCURRENTLY first, as its header says.`);
            }
          }
        } catch (e) {
          add("walk index", "warn", `could not verify: ${(e as Error).message}`, "The catalog reads behind this check need SELECT on pg_proc, pg_index and pg_class.");
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
         * label and every edit would fail (update_thought writes the column
         * too — `edit signature` above reads its form).
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
                ledgerRemedy("021", APPLY_021));
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

        /**
         * An unfinished consolidation pass, and the review queue (SMD-1294).
         * db/consolidate.ts is the third consumer of the claim table, under
         * keys with the consolidate: prefix (one per judge model and prompt
         * version), and its product is migration 029's proposal table. The
         * same rule as the re-embed check — a pass is unfinished while any
         * row under its key is pending, leased or failed — read from the same
         * counts; "not yet in the pool" is the worker's own pool rule, the
         * thoughts WITH entities and no row under the key, since a thought
         * without entities has no candidates and is not pooled. Pending
         * proposals are not a defect — the pass proposes and a reviewer
         * decides — so they ride the ok line as a count with the command that
         * lists them, and appear on the warn line too while a pass is open.
         */
        try {
          const { CONSOLIDATE_KEY_PREFIX, formatPassCounts, passUnfinished } = await import("../db/config.mjs");
          const [{ claimsPresent, proposalsPresent }] = await sql`
            SELECT to_regclass('thought_work_claims') IS NOT NULL AS "claimsPresent", to_regclass('supersession_proposals') IS NOT NULL AS "proposalsPresent"`;
          if (!claimsPresent) {
            add("consolidate pass", "skip", "not checked — thought_work_claims does not exist (migration 015 not applied)");
          } else if (!proposalsPresent) {
            add("consolidate pass", "skip", "not checked — supersession_proposals does not exist (migration 029 not applied)");
          } else {
            // The universe and "not yet in the pool" both come from migration
            // 029's consolidation_pool — the worker's own rule, one definition
            // — the second counted per key rather than subtracted: a thought
            // re-extracted to no entities keeps its claim row, and a
            // subtraction went negative (review pass 1; the second pass found
            // three copies of the rule and made it one).
            const rows = (await sql`
              SELECT work_type, status, count(*)::int AS c,
                     (SELECT count(*)::int FROM consolidation_pool(NULL)) AS thoughts
              FROM thought_work_claims WHERE work_type LIKE ${CONSOLIDATE_KEY_PREFIX + "%"} GROUP BY work_type, status`) as
              { work_type: string; status: string; c: number; thoughts: number }[];
            const [{ pending: queued }] = await sql`SELECT count(*)::int AS pending FROM supersession_proposals WHERE status = 'pending'`;
            const queue = Number(queued) > 0 ? `${queued} proposal(s) pending review — cd db && bun consolidate.ts --url $DATABASE_URL --list` : "";
            const byKey = new Map<string, PassCounts>();
            for (const r of rows) {
              const c = byKey.get(r.work_type) ?? { thoughts: Number(r.thoughts), succeeded: 0, fellBack: 0, accepted: 0, failed: 0, claimed: 0, pending: 0, unpooled: Number(r.thoughts) };
              const n = Number(r.c);
              if (r.status === "succeeded") c.succeeded = n;
              else if (r.status === "failed") c.failed = n;
              else if (r.status === "claimed") c.claimed = n;
              else if (r.status === "pending") c.pending = n;
              byKey.set(r.work_type, c);
            }
            let unfinished = 0;
            for (const [key, c] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
              if (!passUnfinished(c)) continue;
              unfinished++;
              const [{ n: unpooled }] = await sql`SELECT count(*)::int AS n FROM consolidation_pool(${key})`;
              c.unpooled = Number(unpooled);
              // The key names the judge model between the prefix and the
              // prompt version; the command has to run under that model, or
              // consolidate.ts pools under another key.
              const model = /^(.+)@p\d+$/.exec(key.slice(CONSOLIDATE_KEY_PREFIX.length))?.[1];
              const envPrefix = model && model !== metaModel ? `OB1_METADATA_MODEL=${model} ` : "";
              add("consolidate pass", "warn",
                  `${key}: ${formatPassCounts(c).replace(/ thoughts — /, " thoughts with entities — ")} — a consolidation pass under this key stopped before it finished${queue ? `; ${queue}` : ""}`,
                  `Finish it: cd db && ${envPrefix}bun consolidate.ts --url $DATABASE_URL${c.failed ? ` (--retry-failed for the ${c.failed} failed row(s) once their cause is fixed)` : ""}; ${envPrefix}bun consolidate.ts --url $DATABASE_URL --status shows where it stands.`);
            }
            if (unfinished === 0) add("consolidate pass", "ok", `none unfinished${queue ? `; ${queue}` : ""}`);
          }
        } catch (e) {
          add("consolidate pass", "warn", `could not verify: ${(e as Error).message}`,
              "The check reads thought_work_claims, consolidation_pool() and supersession_proposals.");
        }

        if (Number(applied[0].c) === 0)
          add("migration ledger", "warn", "no schema_migrations table — the schema was applied by hand",
              "Adopt it with: cd db && bun migrate.ts --url $DATABASE_URL --baseline");
        else add("migration ledger", "ok", "schema_migrations present");

        // The opt-in query log (034, SMD-1295). Never fatal: it is off by default
        // and its write is best-effort, so this reports its presence and setting
        // rather than refuses. A self-hosted role also needs query_log INSERT to
        // record it — documented, not enforced (db/README.md grants).
        try {
          const [{ present }] = await sql`SELECT to_regclass('public.query_log') IS NOT NULL AS present`;
          if (!present) {
            add("query log", "skip", "not present — the opt-in query log (migration 034) is not applied");
          } else {
            const { queryLogEnabled, queryLogRetentionDays } = await import("../db/config.mjs");
            const on = queryLogEnabled(env as unknown as Record<string, string | undefined>);
            const days = queryLogRetentionDays(env as unknown as Record<string, string | undefined>);
            add("query log", "ok",
              `present; ${on ? "ON (OB1_QUERY_LOG=on) here" : "off by default — set OB1_QUERY_LOG=on to record"}. ` +
              `Logs each search and the fetch/edit/delete of a returned id (query text, arguments, returned ids — personal data at rest), read offline by evals/export-queries.ts. ` +
              `Retention: prune_query_log(${days}); a self-hosted role needs query_log INSERT (db/README.md).`);
          }
        } catch (e) {
          add("query log", "warn", `could not verify: ${(e as Error).message}`, "The check reads to_regclass('public.query_log').");
        }

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
