#!/usr/bin/env bun
/**
 * preflight.ts — fail a bad deployment before it serves traffic.
 *
 * Phase 4 of the migration. Without this the server starts happily when
 * misconfigured: `initialize` succeeds, `tools/list` returns every tool, and the
 * first real tool call returns "Error: OB1_STORE is unset, which selects the SQL
 * store, and DATABASE_URL is not set. …" inside a tool response. Every liveness
 * probe reports green, including the container healthcheck, because the HTTP layer genuinely is fine — the data layer is built
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
 *   bun preflight.ts --deep      # also calls the embedding and chat providers (costs a token per model)
 *   bun preflight.ts --json      # machine-readable, for a pipeline step
 *
 * Exit codes: 0 all good, 1 something is wrong, 2 could not run the checks.
 */

import { createStore, databaseUrl, DEFAULT_STORE, DIRECT_CHECK_SKIP_OVER_POSTGREST, maskUrl, missingDatabaseUrl, postgrestOnBunNotice, postgrestOverPostgresUrl, storeKind, type StoreEnv } from "./store.ts";
import { parseKeyRecords } from "./auth.ts";
import { DEFAULT_MAX_TOKENS } from "./chunk.ts";
import { resolveEmbedConfig, resolveProviderEndpoints, stringOr, type ProviderEndpoint } from "./embed.ts";
import { EGRESS_UNITS, hostOf, localKnob, type EgressTerm } from "./egress.ts";
import { jevDecide, jevInfo, resolveJevConfig } from "./jev.ts";
import { ledgerStatus, pad3, readDatabaseFacts } from "./brain-info.ts";
import { LATEST_MIGRATION } from "./version.ts";
import { tierProblem, trimmedEnv } from "../db/config.mjs"; // static: `env` below is built before the dynamic import above resolves
import type { PassCounts } from "../db/config.mjs";

type Status = "ok" | "fail" | "warn" | "skip";
type Check = { name: string; status: Status; detail: string; fix?: string };

const args = process.argv.slice(2);
const deep = args.includes("--deep");
const asJson = args.includes("--json");

const results: Check[] = [];
const add = (name: string, status: Status, detail: string, fix?: string) =>
  results.push({ name, status, detail, fix });

// Trimmed once, as index.ts's initEnv trims the server's — the gate judges the
// values the server will read (SMD-1843).
const env = trimmedEnv(process.env as Record<string, string | undefined>);
const store = storeKind(env);
// Defaults come from db/config.mjs, not from copies. These four were hardcoded
// here and went stale the moment the defaults changed, so preflight validated
// openai/text-embedding-3-small @ 1536 while the server ran qwen3-embedding:4b @
// 1024 — a gate checking a configuration that was never going to run. It was
// invisible in the container only because compose sets every one of these
// explicitly.
const {
  DEFAULT_EMBEDDING_MODEL: DEF_EMB,
  DEFAULT_EMBEDDING_DIM: DEF_DIM,
  isLocalHostname,
  LOCAL_PROVIDER_SERVICES,
  REAPPLY_COMMAND,
} = await import("../db/config.mjs");

// The embedding model read as embed.ts's resolveEmbedConfig reads it, trimmed
// the same way, so the gate judges the value the server will use.
const embModel = stringOr(env.OB1_EMBEDDING_MODEL, DEF_EMB);
const embDim = env.OB1_EMBEDDING_DIM ? Number(env.OB1_EMBEDDING_DIM) : DEF_DIM;
/**
 * The two chat models by embed.ts's rule, the one the extractor and the judge
 * run by: the judge's is OB1_JUDGE_MODEL, else the metadata model (SMD-1901).
 * Resolved here rather than copied, so the row, the pass remedy and the --deep
 * probe cannot name a model the worker would not use.
 */
const resolvedEmbed = resolveEmbedConfig(env);
const { metadataModel: metaModel, judgeModel, egress } = resolvedEmbed;
/**
 * The two endpoints, by embed.ts's rule — the one the server dials by — so the
 * rows below print what a capture will do, not a second opinion of it. Until
 * SMD-1902 there was one base and one key, resolved here a second time.
 */
const { embeddings: embEndpoint, chat: chatEndpoint } = resolveProviderEndpoints(env);
/** Whether the chat knobs name an endpoint of their own; the report then carries a provider and a credential row for it. */
const chatIsOwn = Boolean(env.OB1_CHAT_BASE_URL || env.OB1_CHAT_API_KEY);

/**
 * A loopback or private-network endpoint — Ollama, LM Studio, vLLM on the same
 * host or compose network — needs no credential. Anything reachable over the
 * internet does, and a missing key there is a hard failure rather than a warning.
 */
function isLocalEndpoint(url: string): boolean {
  try {
    return isLocalHostname(new URL(url).hostname, [...LOCAL_PROVIDER_SERVICES]); // the compose service name, from the contract
  } catch {
    return false;
  }
}
const localEmbeddings = isLocalEndpoint(embEndpoint.base);
const localChat = isLocalEndpoint(chatEndpoint.base);
/**
 * Migration 014's exposure and remedy, once, for both store paths. The
 * PostgREST and SQL checks below used to each carry their own copy; the next
 * edit to either — say, when search_thoughts gains a filter input — would have
 * landed in one and left the two stores contradicting each other.
 */
const EXPOSURE =
  "a filtered match_thoughts call — direct SQL, a PostgREST RPC, or a community integration's metadata filter; the server's own search_thoughts sends no filter — silently returns fewer rows than match";
const APPLY_014 = "Apply the migrations through db/migrations/014_filtered_match_thoughts.sql.";
const CATALOG_HINT = "run once as the SQL store (OB1_STORE unset, DATABASE_URL set) against the same database to read the catalog";
// Every check the direct-connection block owns, in the order the SQL path reports them.
// A throw anywhere in that block lands in one catch, and a check that prints
// nothing looks like one that passed — so the catch reports each of these
// that has not reported yet, rather than one name for whatever went wrong.
const DIRECT_CHECKS = [
  "vector extension",
  "atomic capture", "write privileges", "fingerprint backfill", "audit trail", "audit events", "agent identity",
  "keyword search", "hybrid search", "stats summary", "provenance", "work claims", "search signatures", "edit signature", "delete signature", "transaction isolation", "filtered search",
  "candidate scan", "walk index", "chunk context", "trigram index", "embedding contract", "vector models",
  "updated_at trigger", "re-embed pass", "consolidate pass", "migration ledger", "schema version", "query log", "tier",
];
/**
 * 020 gave match_thoughts and search_thoughts_hybrid the forms the servers
 * call; 027 last defines search_thoughts_hybrid (the relative floor) and 041
 * match_thoughts (039's half-precision walk over 038's gate, run with jit
 * off and its two planner paths pinned), both under 020's signatures. A remedy
 * that applied 020 alone would leave 020's bodies over theirs — the
 * stale-body state the ledger then cannot see — so the signature remedies
 * name all three, in order.
 */
const APPLY_020 = "Apply db/migrations/020_match_thoughts_recency.sql, then 027_search_thoughts_relative_floor.sql and 041_match_thoughts_pin_paths.sql (the last definers of search_thoughts_hybrid and match_thoughts).";
/**
 * PostgREST answers a call it cannot resolve with PGRST202 both when the
 * function is missing and while its schema cache predates the migration that
 * added it — so a remedy that says only "apply" would send an operator who
 * has just applied it back to the migrator (first review pass of 021).
 */
const RELOAD_HINT = "If the ledger already records it, PostgREST may not have reloaded its schema cache: NOTIFY pgrst, 'reload schema';";
const APPLY_020_POSTGREST = `Apply the migrations through db/migrations/042_thought_citations.sql against the project's direct connection (server-portable/README.md §4) — 020 gives both functions the forms the server sends; 027 and 041 last define search_thoughts_hybrid and match_thoughts, and 042 delete_thought's three-argument form, which the next start checks too. ${RELOAD_HINT}`;
/** An id no row has: the probes below call a function with it and read the NOT_FOUND it answers, writing nothing. */
const NOBODY = "00000000-0000-4000-8000-000000000000";
const APPLY_021 = "Apply db/migrations/021_embedding_model_per_row.sql.";
const APPLY_042 = "Apply db/migrations/042_thought_citations.sql.";
/**
 * 046 also holds the audit trigger and the refusal trigger, which 055 last
 * defines (SMD-2115): 046 applied by hand alone puts their 046 bodies back —
 * no payload in the capture event, no payload arm in the amendment gate — so
 * every remedy that names 046 names 055 after it (cold read, SMD-2115's first
 * review pass; `migrate.ts --reapply` runs every file in order and is the
 * remedy that cannot get this wrong).
 */
const THEN_055 = " Then apply db/migrations/055_capture_event_payload.sql — it last defines the audit trigger and the refusal trigger 046 also holds, so 046 alone puts their 046 bodies back (bun migrate.ts --reapply runs every file in order).";
const APPLY_046 = "Apply db/migrations/046_thought_audit_event_shape.sql.";
const APPLY_055 = "Apply db/migrations/055_capture_event_payload.sql.";
/**
 * 046's rule — the kind from the key, never the payload — stands when the audit
 * trigger's body carries its sentinel (046) or calls ob1_append_thought_event
 * and THAT body carries it (055). A trigger that calls the function it is
 * judged by, not the function's mere presence: 025 re-applied by hand beside
 * 055's function reads no key, and the function nobody calls proves nothing.
 */
const keyRuleHolds = (trigSrc: string, appendSrc: string): boolean =>
  /ob1_append_thought_event\(/.test(trigSrc) ? /ob1:audit-event-from-the-key/.test(appendSrc) : /ob1:audit-event-from-the-key/.test(trigSrc);
/** The most capture rows without content the `audit events` census derives one by one; above it the line says "at least" and the pass is the remedy (SMD-2115). */
const PAYLOAD_CENSUS_BOUND = 2000;
const APPLY_042_POSTGREST = `Apply the migrations through db/migrations/042_thought_citations.sql against the project's direct connection (server-portable/README.md §4). ${RELOAD_HINT}`;
/**
 * Where the ledger already records the migration a check finds absent — a
 * brain adopted with --baseline whose schema is the guide's — "apply it" is a
 * loop: a plain run skips a recorded file. The migrator's re-run is the remedy
 * (SMD-1193); the 014, 019 and 023 remedies read the ledger the same way.
 */
const REAPPLY = `The ledger records that migration but the schema installed is older — adopted with --baseline, or a body put there or removed from outside the migrations (an earlier migration re-applied by hand, a vendored schema's CREATE OR REPLACE or DROP; SMD-1250): re-apply the recorded migrations with the migrator — ${REAPPLY_COMMAND} — with the server and every worker stopped; a plain run skips a recorded file.`;
const APPLY_032_POSTGREST = `Apply the migrations through db/migrations/032_update_thought_provenance.sql against the project's direct connection (server-portable/README.md §4). ${RELOAD_HINT}`;
/** PostgREST's wording for a function it cannot resolve — missing, or not at the argument shape sent. */
const missing = (msg: string) => /could not find the function|does not exist/i.test(msg);

// ── Configuration ────────────────────────────────────────────────────────────

// The SQL store is the default (change 97, SMD-1797); PostgREST is kept for
// Cloudflare Workers, where the SQL store's driver does not run, and is said to
// be retired wherever it does — this process runs on Bun, so a PostgREST
// selection here is that case. A warning, not a failure: the deployment works.
const retired = postgrestOnBunNotice(store);
if (store !== "postgrest" && store !== "sql") {
  add("store selection", "fail", `OB1_STORE="${store}" is not a known store`,
      `Set OB1_STORE to "${DEFAULT_STORE}" (the default — leave it unset) or "postgrest" (Cloudflare Workers only).`);
} else if (retired) {
  add("store selection", "warn", "OB1_STORE=postgrest — the PostgREST store, kept for Cloudflare Workers", retired);
} else {
  add("store selection", "ok", env.OB1_STORE === undefined ? `OB1_STORE unset — ${DEFAULT_STORE}, the default` : `OB1_STORE=${store}`);
}

// ── Model provider ──────────────────────────────────────────────────────────

add("model provider", "ok",
    `${maskUrl(embEndpoint.base)} — embeddings${chatIsOwn ? "" : " and chat"}${localEmbeddings ? " (local — no credential needed)" : ""}`);
if (chatIsOwn) {
  // A second endpoint is a second row, so an operator reading the report sees
  // where each of the two calls goes; unsplit, the one row says "and chat".
  add("chat provider", "ok",
      `${maskUrl(chatEndpoint.base)} — chat${env.OB1_CHAT_BASE_URL ? " (OB1_CHAT_BASE_URL)" : ", the embeddings endpoint with its own credential (OB1_CHAT_API_KEY)"}${localChat ? " (local — no credential needed)" : ""}`);
}
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
{
  // The window db/extract-entities.ts extracts a long thought in, and where
  // the number came from (SMD-1879): entities.ts's one sentence, the worker's
  // banner verbatim. An explicit size whose text and answer would not fit the
  // model's served context beside the rules is the one configuration that
  // defeats the windows — the call is truncated or refused, which is what they
  // exist to prevent — so it warns, naming the most that fits.
  const { extractWindowThatFits, extractContextNeeded, EXTRACT_MIN_WINDOW_TOKENS } = await import("../db/config.mjs");
  const { describeExtractWindow } = await import("./entities.ts");
  // The one resolution of the environment this file makes (second review pass).
  const extractCfg = resolvedEmbed;
  // The resolver's own arithmetic (first review pass): a copy here omitted the
  // answer floor and the part marker, and recommended a value that requested
  // 280 tokens more than the context.
  const fits = extractCfg.extractModelWindow !== undefined ? extractWindowThatFits(extractCfg.extractModelWindow) : undefined;
  // A context that holds no window is a fact about the model whatever the
  // knob says (third review pass: with the knob set, the branch below
  // recommended a negative size). `unfit` is the resolver's answer for the
  // derived path; the same arithmetic decides the explicit one.
  if (fits !== undefined && fits < EXTRACT_MIN_WINDOW_TOKENS) {
    add("extraction window", "warn",
        `${metaModel}'s ${extractCfg.extractModelWindow}-token served context holds under ${EXTRACT_MIN_WINDOW_TOKENS} tokens of thought text beside the rules and an answer — no window fits it; ${extractCfg.extractChunkTokensUnfit ? `the default ${extractCfg.extractChunkTokens} is in force` : `OB1_EXTRACT_CHUNK_TOKENS=${extractCfg.extractChunkTokens} cannot fit either`} and every extraction call will be truncated or refused`,
        `Serve the model with a larger context (a Modelfile's num_ctx, or the provider's setting), or set OB1_METADATA_MODEL to one that has it.`);
  } else if (extractCfg.extractChunkTokensFrom === "OB1_EXTRACT_CHUNK_TOKENS" && extractCfg.extractChunkTokens < EXTRACT_MIN_WINDOW_TOKENS) {
    // The explicit path had no floor (third review pass): a 1-token window is
    // one model call per word.
    add("extraction window", "warn",
        `OB1_EXTRACT_CHUNK_TOKENS=${extractCfg.extractChunkTokens} is under ${EXTRACT_MIN_WINDOW_TOKENS} tokens — a window that small is one model call per few words of every thought`,
        `Set OB1_EXTRACT_CHUNK_TOKENS at or above ${EXTRACT_MIN_WINDOW_TOKENS}, or unset it to derive the window from the model's context.`);
  } else if (extractCfg.extractChunkTokensFrom === "OB1_EXTRACT_CHUNK_TOKENS" && fits !== undefined && extractCfg.extractChunkTokens > fits) {
    add("extraction window", "warn",
        `OB1_EXTRACT_CHUNK_TOKENS=${extractCfg.extractChunkTokens} — a window that long, its answer budget and the rules do not fit ${metaModel}'s ${extractCfg.extractModelWindow}-token served context; the call is truncated or refused`,
        `Unset OB1_EXTRACT_CHUNK_TOKENS to derive the window from the context, or set it at or under ${fits}.`);
  } else if (extractCfg.extractChunkTokensFrom === "default") {
    add("extraction window", "ok",
        `${describeExtractWindow(extractCfg)} — set OB1_EXTRACT_CHUNK_TOKENS if the model serves fewer than ${extractContextNeeded(extractCfg.extractChunkTokens)} tokens`);
  } else {
    add("extraction window", "ok", describeExtractWindow(extractCfg));
  }
}
// The judge's own row, so a report says which model db/consolidate.ts will
// pool under: the pass key carries the name, and a reader of the consolidate
// pass row below can match the two.
add("judge model", "ok", env.OB1_JUDGE_MODEL
    ? `${judgeModel} (OB1_JUDGE_MODEL)${judgeModel === metaModel ? " — the same as the metadata model" : ""}`
    : `${judgeModel} — the metadata model; OB1_JUDGE_MODEL gives the judge its own`);

/**
 * One credential row per endpoint. A hosted endpoint with no key is a hard
 * failure naming the knob that sets one; a local endpoint needs none, and a
 * key sent to one is worth a warning. `unshared` names a key that IS set for
 * the other endpoint and is not sent to this one — embed.ts's rule that a
 * different endpoint gets only its own credential, said where an operator
 * expecting the inherited key would look for it (SMD-1902).
 */
function credentialRow(row: string, at: ProviderEndpoint, local: boolean, keyKnob: string, baseKnob: string, unshared?: string): void {
  const aside = unshared ? ` — ${unshared} belongs to the other endpoint and is not sent here` : "";
  if (!at.key) {
    if (local) {
      add(row, "ok", `not required for a local endpoint${aside}`);
    } else {
      add(row, "fail", `no ${keyKnob}, and ${at.base} is not local${aside}`,
          `Set ${keyKnob}, or point ${baseKnob} at a local provider.`);
    }
    return;
  }
  add(row, "ok", `set (${at.key.length} chars)`);
  if (local) {
    add(row, "warn", "a key is set but the endpoint is local — it will be sent anyway",
        "Unset it to keep local traffic credential-free.");
  }
}
credentialRow("provider credential", embEndpoint, localEmbeddings, "OB1_LLM_API_KEY or OPENROUTER_API_KEY", "OB1_LLM_BASE_URL");
if (chatIsOwn) {
  // The same base spelled twice shares the embeddings key (embed.ts); only a
  // different base leaves OB1_LLM_API_KEY behind, and only then is it named.
  const unshared = embEndpoint.key && !chatEndpoint.key && chatEndpoint.base !== embEndpoint.base
    ? (env.OB1_LLM_API_KEY ? "OB1_LLM_API_KEY" : "OPENROUTER_API_KEY")
    : undefined;
  credentialRow("chat credential", chatEndpoint, localChat, "OB1_CHAT_API_KEY", "OB1_CHAT_BASE_URL", unshared);
}

// ── Is the local endpoint there at all? (SMD-1875) ──────────────────────────

/**
 * A local endpoint is dialled once, by default: one GET of `/models` with no
 * body and no credential, under a short timeout, and only the connection is
 * judged — any HTTP status is an endpoint that answers; what it serves is
 * --deep's question. Until this row preflight's credential rule
 * (isLocalEndpoint, above) called an endpoint local by its hostname and
 * connected to nothing without --deep, so an address that reached nothing
 * — the container's own loopback (the code's default, inside a container), the
 * `ollama` service name with no profile, `host.docker.internal` where the
 * runtime does not provide it, a typo in the port — was `preflight OK`, and the
 * first capture failed in 7 ms with the server log ending at `Started server`
 * (measured 2026-09-21 on SMD-1843's baseline). A hosted endpoint is not
 * dialled here: it costs a credential to prove anything about, which is --deep.
 */
const LOCAL_PROBE_TIMEOUT_MS = 2500;
const LOCAL_PROBE_SECONDS = `${LOCAL_PROBE_TIMEOUT_MS / 1000} s`;
/** The three spellings an operator reaches for, in the remedy's own words: the two host aliases, and the stack's own service. */
const HOST_ALIASES = "http://host.containers.internal:11434/v1 under podman or http://host.docker.internal:11434/v1 under Docker";
const STACK_OWN = "http://ollama:11434/v1 with --profile local-models";
const HOST_SPELLINGS = `an Ollama on the host is ${HOST_ALIASES}, and the stack's own is ${STACK_OWN}`;
/**
 * What went wrong at the connection, in words, from Bun's error for it — and
 * what the first capture would have done there, which differs by kind: a
 * refusal or an unresolved name fails it in milliseconds; a silent endpoint
 * (a SYN dropped, a listener that never answers) holds it for the whole
 * request budget (first review pass). Resolution is judged by the syscall,
 * not one code: ENOTFOUND is the common case, and a resolver that answers
 * ETIMEOUT or EAI_AGAIN inside the probe's window is the same finding with
 * its code shown; a resolver stalled past the window reads as the timeout
 * kind, which is why that kind says "up to" — measured on Linux, Bun's fetch
 * reports a blackholed resolver as `getaddrinfo ETIMEOUT` at about 2.5 s
 * (second review pass). "Up to" is one request budget, the default path: with
 * OB1_CHUNK_CONTEXT=on a windowed capture spends a blurb budget first, then
 * the embedding's (third review pass).
 */
function probeFailure(e: unknown): { kind: "silent" | "unresolved" | "refused" | "reset" | "tls" | "other"; why: string; then: string } {
  const err = e as Error & { code?: string | number; syscall?: string };
  const code = String(err.code ?? "");
  const fast = "the first capture would fail on it in milliseconds";
  if (err.name === "TimeoutError") return { kind: "silent", why: `no HTTP answer in ${LOCAL_PROBE_SECONDS}`, then: "the first capture would wait on it, up to the whole request timeout (OB1_LLM_TIMEOUT), and then fail" };
  if (err.syscall === "getaddrinfo" || code === "ENOTFOUND") return { kind: "unresolved", why: `the name does not resolve${code && code !== "ENOTFOUND" ? ` (${code})` : ""}`, then: fast };
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return { kind: "refused", why: "the connection was refused", then: fast };
  // Accepted and closed with no HTTP: an https endpoint dialled as http, or a
  // listener that is not HTTP at all. Bun's message ends in advice about its
  // own `verbose` option, which is nothing to an operator (fifth review pass).
  if (code === "ECONNRESET") return { kind: "reset", why: "the connection was accepted and closed with no HTTP answer, as an https endpoint dialled as http does", then: fast };
  // Something answered and its certificate was refused; the server's own
  // calls fail the same way, and pass under the same trust (fifth review pass).
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(err.message)) return { kind: "tls", why: `its TLS certificate is not trusted (${code || err.message})`, then: "every capture would fail the same way" };
  return { kind: "other", why: err.message.replace(/\.?\s*For more information.*$/s, ""), then: fast };
}
/** The hostname of a base URL, lower-cased as the URL parser leaves it; "" for a value that is not a URL (which isLocalEndpoint already calls not local). */
function hostnameOf(base: string): string {
  try { return new URL(base).hostname.toLowerCase(); } catch { return ""; }
}
/** The remedy for the hostname's kind: which of the three spellings this one is, and what it needs. */
function probeRemedy(base: string, knob: string): string {
  const host = hostnameOf(base);
  if (LOCAL_PROVIDER_SERVICES.includes(host)) {
    return `\`${host}\` is the local-models profile's service and exists only under it: start the stack with --profile local-models, or set ${knob} to an Ollama on the host (${HOST_ALIASES}) or to a hosted provider with a key.`;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0") {
    return `Inside a container ${host} is the container itself, not the host: ${HOST_SPELLINGS}. From a shell on the host, start the provider or fix the port in ${knob}.`;
  }
  if (host === "host.docker.internal" || host === "host.containers.internal") {
    return `Nothing on the host answers at that port, or this runtime does not provide the name: podman writes both names; Docker Desktop only host.docker.internal; Docker on Linux neither unless extra_hosts host-gateway is set, and deploy/compose.yaml sets it for host.docker.internal. Start the provider on the host and name it in ${knob} (${HOST_ALIASES}), or use the stack's own (${STACK_OWN}).`;
  }
  return `Start the provider at that address or fix the host and port in ${knob}; ${HOST_SPELLINGS}.`;
}
const TLS_REMEDY = "Serve it over http:// on the box, or trust its issuer for the server (NODE_EXTRA_CA_CERTS=<ca.pem>); NODE_TLS_REJECT_UNAUTHORIZED=0 disables the check for every call the server makes.";
/**
 * Whether NO_PROXY / no_proxy exempts this base, by the rule Bun 1.4's fetch
 * applies (measured by SMD-2050's seventh review pass): `*` exempts every
 * host; an entry exempts its own host and every subdomain of it, with or
 * without a leading dot (`internal`, `.internal` and `b.internal` all exempt
 * `a.b.internal`); an entry with a port exempts only that port. Not matched,
 * as Bun does not: `*.internal`, CIDR ranges, `localhost` for 127.0.0.1.
 */
function noProxyExempts(base: string): boolean {
  let url: URL;
  try { url = new URL(base); } catch { return false; }
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const entries = [process.env.NO_PROXY, process.env.no_proxy].flatMap((v) => (v ?? "").split(",")).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return entries.some((entry) => {
    if (entry === "*") return true;
    const at = entry.lastIndexOf(":");
    const [name, wantPort] = at > 0 && /^\d+$/.test(entry.slice(at + 1)) ? [entry.slice(0, at), entry.slice(at + 1)] : [entry, null];
    const bare = name.replace(/^\./, "");
    return (host === bare || host.endsWith(`.${bare}`)) && (wantPort === null || wantPort === port);
  });
}
/**
 * The proxy variable Bun's fetch reads for this base — HTTP_PROXY/http_proxy
 * for http, HTTPS_PROXY/https_proxy for https — or null, also when NO_PROXY
 * exempts the base (noProxyExempts). Loopback and private addresses go
 * through it too unless exempted, and so does every call the server makes, so
 * a failure here is the route's before it is the endpoint's; podman forwards
 * the host's proxy variables into containers by default (fifth review pass).
 */
function proxyKnobFor(base: string): string | null {
  if (noProxyExempts(base)) return null;
  const names = base.startsWith("https:") ? ["HTTPS_PROXY", "https_proxy"] : ["HTTP_PROXY", "http_proxy"];
  return names.find((n) => process.env[n]) ?? null;
}
/**
 * The name, resolved before anything is dialled, under the same bound as the
 * connection. Judged apart because on a GitHub runner the first run of PR #138
 * read the unknown `ollama` name as the TIMEOUT kind — the resolver took
 * longer than the probe's window to say NXDOMAIN, so the fetch aborted first —
 * and a resolver that never answers deserves its own words either way. An IP
 * literal resolves to itself. `Bun.dns.lookup` is the resolver the suite asks
 * too, so the two agree by construction (caught: CI, PR #138).
 */
async function resolveFirst(host: string): Promise<{ why: string; then: string } | null> {
  if (!host || /^[\d.]+$/.test(host) || host.startsWith("[")) return null;
  const outcome = await Promise.race([
    Bun.dns.lookup(host).then(() => null, (e) => (e as Error & { code?: string })),
    Bun.sleep(LOCAL_PROBE_TIMEOUT_MS).then(() => "stall" as const),
  ]);
  if (outcome === null) return null;
  if (outcome === "stall") return { why: `the name does not resolve within ${LOCAL_PROBE_SECONDS} — the resolver did not answer`, then: "the first capture would wait on the resolver, up to its request timeout (OB1_LLM_TIMEOUT), and then fail" };
  const code = String(outcome.code ?? "").replace(/^DNS_/, "");
  return { why: `the name does not resolve${code && code !== "ENOTFOUND" ? ` (${code})` : ""}`, then: "the first capture would fail on it in milliseconds" };
}
async function probeLocal(row: string, at: ProviderEndpoint, knob: string): Promise<void> {
  const started = performance.now();
  // Userinfo in the URL is never sent by fetch and would otherwise land in the
  // log on every start (fifth review pass); maskUrl is store.ts's, the one the
  // DATABASE_URL row uses.
  const shown = maskUrl(at.base);
  const unresolved = await resolveFirst(hostnameOf(at.base));
  if (unresolved) {
    add(row, "fail", `nothing answers at ${shown} — ${unresolved.why} (GET /models, ${LOCAL_PROBE_SECONDS} timeout); ${unresolved.then}`, probeRemedy(at.base, knob));
    return;
  }
  try {
    // No redirects followed: a 3xx is an answer from THIS address, and
    // following one would judge — and dial — wherever it points, off the box
    // included, under a row that names the base (first review pass).
    const r = await fetch(`${at.base}/models`, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
    await r.body?.cancel();
    add(row, "ok", `${shown} answers — HTTP ${r.status} to GET /models in ${Math.max(1, Math.round(performance.now() - started))} ms; what it serves is checked under --deep`);
  } catch (e) {
    const { kind, why, then } = probeFailure(e);
    const proxy = proxyKnobFor(at.base);
    const host = hostnameOf(at.base);
    const lead = kind === "tls" ? `${shown} answers, but ${why}` : `nothing answers at ${shown} — ${why}`;
    const route = proxy ? `; ${proxy} is set, so this call and every one the server makes go through that proxy unless NO_PROXY names ${host}` : "";
    add(row, "fail", `${lead} (GET /models, ${LOCAL_PROBE_SECONDS} timeout)${route}; ${then}`,
        (proxy ? `Add ${host} to NO_PROXY (and no_proxy) for the server, or unset ${proxy} for it. Otherwise: ` : "") + (kind === "tls" ? TLS_REMEDY : probeRemedy(at.base, knob)));
  }
}
if (localEmbeddings) await probeLocal("provider endpoint", embEndpoint, "OB1_LLM_BASE_URL");
// A chat endpoint at the same base is the same socket: one probe. Its own
// local base is its own row, so a down chat server fails by its own name.
if (chatIsOwn && chatEndpoint.base !== embEndpoint.base && localChat) await probeLocal("chat endpoint", chatEndpoint, "OB1_CHAT_BASE_URL");

// ── Egress: what may leave the box (SMD-1903) ───────────────────────────────

/**
 * The gate's mode and terms, then per endpoint what a capture's text will do
 * — in words, before the first capture. A policy that did not parse FAILS:
 * the gate then refuses everything, and only this row says which line is
 * wrong. `off` is a warning, not a failure: the operator may choose it, and
 * this is where the choice is read back.
 */
const showTerms = (ts: EgressTerm[]) => (ts.length ? `${ts.length} term(s): ${ts.map((t) => `${t.unit}:${t.value}`).join(", ")}` : "no terms");
for (const problem of egress.problems) {
  add("egress policy", "fail", `${problem} — the gate fails closed (deny) until this is fixed`,
      `OB1_EGRESS_POLICY is deny, allow or off; OB1_EGRESS_ALLOW and OB1_EGRESS_DENY are comma-separated unit:value terms (units: ${EGRESS_UNITS.join(", ")}).`);
}
if (!egress.problems.length) {
  if (egress.mode === "off") {
    add("egress policy", "warn", "off — nothing decides what leaves the box; every model call carries the thought's full text to its endpoint",
        "Set OB1_EGRESS_POLICY=deny and declare the endpoints on this box (OB1_LLM_LOCAL=1, OB1_CHAT_LOCAL=1), or allow with OB1_EGRESS_DENY terms for what must stay.");
  } else if (egress.mode === "deny") {
    add("egress policy", "ok", `deny${egress.configured === undefined ? " (the default)" : ""} — a thought's text reaches an endpoint not declared local only under an OB1_EGRESS_ALLOW term; ${showTerms(egress.allow)}`);
  } else {
    add("egress policy", "ok", `allow — a thought's text reaches an endpoint not declared local unless an OB1_EGRESS_DENY term matches; ${showTerms(egress.deny)}`);
  }
  // A `source:` term does NOT gate a capture_thought capture: its `source` is
  // the caller's claim (SMD-1298), dodged by naming another label or none, so
  // the handler keeps it off the subject and no term can match it (SMD-1941).
  // It gates the row's OWN label — the value the server wrote — at an edit and
  // at the re-embed and consolidation passes that read the row back (and at
  // db/sync-linear.ts's captures, whose `source` is the server's). Who may
  // capture is `actor:`, which the key proves. Said here, where a policy is
  // read back (ninth review pass; SMD-1941).
  const sourceTerms = [...egress.allow, ...egress.deny].filter((t) => t.unit === "source");
  if (sourceTerms.length && egress.mode !== "off") {
    add("egress policy", "warn", `${sourceTerms.length} source: term(s) (${sourceTerms.map((t) => `source:${t.value}`).join(", ")}) do NOT gate a capture — its \`source\` is the caller's claim (SMD-1941); they gate a row's stored label at an edit and at the re-embed and consolidation passes`,
        "Gate who may capture with actor:<key name>; keep source: terms for what a row's label says, not for who may send.");
  }
  // Terms in the knob the mode does not read decide nothing — a natural
  // misreading (deny + OB1_EGRESS_DENY) that fails closed and silently
  // (first review pass). Said, with the knob the mode reads.
  const unread: [string, EgressTerm[]][] = egress.mode === "deny" ? [["OB1_EGRESS_DENY", egress.deny]] : egress.mode === "allow" ? [["OB1_EGRESS_ALLOW", egress.allow]] : [["OB1_EGRESS_ALLOW", egress.allow], ["OB1_EGRESS_DENY", egress.deny]];
  for (const [knob, terms] of unread) {
    if (!terms.length) continue;
    add("egress policy", "warn", `${knob} has ${terms.length} term(s) but the mode is ${egress.mode}, which reads ${egress.mode === "deny" ? "OB1_EGRESS_ALLOW" : egress.mode === "allow" ? "OB1_EGRESS_DENY" : "neither knob"} — they decide nothing`,
        egress.mode === "off" ? "Set OB1_EGRESS_POLICY to deny or allow for the terms to be read, or drop them." : `Move them to ${egress.mode === "deny" ? "OB1_EGRESS_ALLOW" : "OB1_EGRESS_DENY"}, or change OB1_EGRESS_POLICY.`);
  }
}
/** What a refused call costs, per endpoint, for the rows below. */
const EMB_REFUSED = "captures land without a vector, findable by exact text only, until a re-embed pass against an endpoint the gate allows";
const CHAT_REFUSED = "captures land untagged (no topics, no type) and the entity and consolidation passes fail every row they claim";
/**
 * One row per endpoint: declared local (the gate does not apply), or what
 * leaves and under what rule. An endpoint the credential rule above CALLS
 * local but nothing declared so is the upgrade case — every stack from
 * before the gate — said with its one-line fix: the gate treats it as remote,
 * declared and not guessed, and under the default that refuses every call.
 */
function egressRow(row: string, at: ProviderEndpoint, knob: string, calls: string, refusedMeans: string): void {
  const host = hostOf(at.base);
  if (at.local) {
    add(row, "ok", `${maskUrl(at.base)} is declared local (${knob}) — the ${calls} text stays on the box; the gate does not apply`);
    return;
  }
  if (isLocalEndpoint(at.base)) {
    // The consequence follows the mode (first review pass): under deny with
    // terms every call a term does not match is refused; under allow, any a
    // deny term matches; under off nothing is, today.
    const consequence = egress.problems.length
      ? `, and while the policy does not parse every ${calls} call is refused: ${refusedMeans}`
      : egress.mode === "deny"
        ? egress.allow.length
          ? `, and under deny every ${calls} call no OB1_EGRESS_ALLOW term matches is refused: ${refusedMeans}`
          : `, and under deny with no allow term every ${calls} call is refused: ${refusedMeans}`
        : egress.mode === "allow"
          ? `, and under allow any ${calls} call an OB1_EGRESS_DENY term matches is refused`
          : "; the gate is off, so nothing is refused today — a later deny would refuse every call";
    add(row, "warn", `${maskUrl(at.base)} looks local but is not declared so — the gate treats it as remote${consequence}`,
        `Set ${knob}=1 if this endpoint is on this machine or its private network (declared, not guessed — SMD-1903).`);
    return;
  }
  if (egress.problems.length) {
    add(row, "warn", `every ${calls} call to ${host} is refused while the policy does not parse — ${refusedMeans}`);
    return;
  }
  switch (egress.mode) {
    case "off":
      add(row, "ok", `the full text of every ${calls} call leaves to ${host} — the gate is off`);
      return;
    case "allow":
      add(row, "ok", `the full text of every ${calls} call leaves to ${host}${egress.deny.length ? " unless an OB1_EGRESS_DENY term matches" : " — no OB1_EGRESS_DENY term holds any back"}`);
      return;
    case "deny":
      if (egress.allow.length) add(row, "ok", `the ${calls} text leaves to ${host} only under an OB1_EGRESS_ALLOW term; otherwise ${refusedMeans}`);
      else add(row, "warn", `every ${calls} call to ${host} is refused — deny with no OB1_EGRESS_ALLOW term — so ${refusedMeans}`,
               `Declare the endpoint local (${knob}=1) if it is, name what may leave in OB1_EGRESS_ALLOW (actor:<key name>, marker:<tag>, …), or set OB1_EGRESS_POLICY=allow or off — in words, in deploy/.env.`);
  }
}
if (chatEndpoint === embEndpoint) {
  // One endpoint, either knob declares it; the row names the one that did
  // (the endpoint carries it), or OB1_LLM_LOCAL as the one to set.
  egressRow("embeddings egress", embEndpoint, localKnob({ embeddings: embEndpoint, chat: chatEndpoint }, "embeddings"), "embeddings and chat", `${EMB_REFUSED}; ${CHAT_REFUSED}`);
} else {
  egressRow("embeddings egress", embEndpoint, "OB1_LLM_LOCAL", "embeddings", EMB_REFUSED);
  egressRow("chat egress", chatEndpoint, localKnob({ embeddings: embEndpoint, chat: chatEndpoint }, "chat"), "chat", CHAT_REFUSED);
}

// ── Access keys ──────────────────────────────────────────────────────────────

// Parsed once; the `agent identity` row reads the same records (eighth review pass).
const accessKeys: ReturnType<typeof parseKeyRecords> = env.MCP_ACCESS_KEYS ? parseKeyRecords(env.MCP_ACCESS_KEYS) : { keys: [], problems: [] };
if (!env.MCP_ACCESS_KEYS && !env.MCP_ACCESS_KEY) {
  add("access keys", "fail", "neither MCP_ACCESS_KEYS nor MCP_ACCESS_KEY is set",
      "Mint one: bun keygen.ts --name laptop --scope write");
} else if (env.MCP_ACCESS_KEYS) {
  const { keys, problems } = accessKeys;
  if (problems.length) {
    for (const p of problems) add("access keys", "fail", p, "bun keygen.ts --name <client> --scope read|write|capture");
  } else {
    // A capture-only key (SMD-1298) adds thoughts and reads nothing: it counts
    // as a capturer here and as a writer for the "every key can write" warning,
    // since either kind of leak can put a thought into the brain.
    const capturers = keys.filter((k) => k.scope !== "read").length;
    add("access keys", "ok",
        `${keys.length} key(s): ${keys.map((k) => `${k.name}(${k.scope})`).join(", ")}`);
    if (capturers === 0) {
      add("access keys scope", "warn", "every key is read-only — capture_thought will not be registered for anyone",
          "Mint a write key (or a capture key for a hook) if you intend to capture thoughts.");
    }
    // Write keys alone here: a capture key can add a thought and nothing else,
    // so a laptop's write key beside a hook's capture key is not "every key
    // can write" (second review pass).
    const writers = keys.filter((k) => k.scope === "write").length;
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

// The connection string comes from DATABASE_URL, or from SUPABASE_URL when it
// holds a postgres:// URL (store.ts:databaseUrl — the SQL shim's spelling, so a
// box running a shim-migrated vendored server beside this one sets one name).
// Read here once and reused by every direct-connection check below, so the
// checks cannot dial a different database from the one the store was built on.
const conn = store === "sql" ? databaseUrl(env) : null;
if (store === "sql") {
  if (!conn) {
    const { problem, fix } = missingDatabaseUrl(env);
    add("DATABASE_URL", "fail", problem, fix);
  } else {
    add("DATABASE_URL", "ok",
        maskUrl(conn.url) + (conn.from === "SUPABASE_URL" ? " (from SUPABASE_URL, which holds a postgres:// URL; DATABASE_URL is unset)" : ""));
  }
  // The "unused" warns only once the connection string is in hand: with no
  // DATABASE_URL the fail line above may have just named OB1_STORE=postgrest
  // as a way out, and a warn telling the operator to remove SUPABASE_URL two
  // lines later would contradict it (first review pass).
  if (conn && env.SUPABASE_URL && conn.from !== "SUPABASE_URL") {
    add("SUPABASE_URL", "warn", "set but unused with the SQL store",
        "Remove SUPABASE_URL to avoid confusion about which backend is live.");
  }
  if (conn && env.SUPABASE_SERVICE_ROLE_KEY) {
    add("SUPABASE_SERVICE_ROLE_KEY", "warn", "set but unused with the SQL store",
        "Remove SUPABASE_SERVICE_ROLE_KEY to avoid confusion about which backend is live.");
  }
} else {
  // A postgres:// URL under the PostgREST selection is the one-box operator's
  // slip (an old OB1_STORE=postgrest kept beside a shim-migrated neighbour's
  // SUPABASE_URL): refused here by name, and never printed raw — it carries a
  // password, and the first version of this branch echoed it (first review pass).
  const mismatch = postgrestOverPostgresUrl(env);
  const unset = (k: string) => add(k, "fail", `not set, but OB1_STORE=${store}`, `Set ${k}, or use the SQL store (OB1_STORE unset) with DATABASE_URL.`);
  if (!env.SUPABASE_URL) unset("SUPABASE_URL");
  else if (mismatch) add("SUPABASE_URL", "fail", `holds a postgres:// connection string (${maskUrl(env.SUPABASE_URL)}), which the PostgREST store cannot dial`, mismatch);
  else add("SUPABASE_URL", "ok", maskUrl(env.SUPABASE_URL));
  if (!env.SUPABASE_SERVICE_ROLE_KEY) unset("SUPABASE_SERVICE_ROLE_KEY");
  else add("SUPABASE_SERVICE_ROLE_KEY", "ok", `set (${env.SUPABASE_SERVICE_ROLE_KEY.length} chars)`);
}

// The generated version module against the tree it sits in (SMD-2041 review
// pass 4). In a checkout db/migrations/ is beside the server, and a migration
// added without `bun scripts/gen-version.ts` leaves version.ts naming the
// previous tree: the brain the migrator just brought up would read as "ahead"
// of this server. The image carries no db/migrations/, so there is nothing to
// compare there and no row; check 17e holds the committed file in CI.
{
  const { latestMigration } = await import("../db/version.mjs");
  const treeLast = latestMigration();
  {
    if (treeLast !== null && treeLast !== LATEST_MIGRATION)
      add("version module", "warn",
          `server-portable/version.ts says the tree ends at ${pad3(LATEST_MIGRATION)}, but db/migrations/ ends at ${pad3(treeLast)} — brain_info and the ledger rows would judge this brain against the wrong tree`,
          "Regenerate it: bun scripts/gen-version.ts");
    else if (treeLast !== null) add("version module", "ok", `server-portable/version.ts matches db/migrations/ (${pad3(treeLast)})`);
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
          `Confirm db/migrations/013_chunk_context.sql is applied, or ${CATALOG_HINT}.`);
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
      // The migrator takes the connection string by name; say the variable
      // that holds it here (the alias included), and for PostgREST — which has
      // no connection string of its own — say what to hand it instead.
      const urlArg = conn ? `$${conn.from}` : "<the brain's postgres:// connection string — Supabase's direct connection, not the pooler>";
      add("schema", "fail", msg,
          /does not exist|relation/i.test(msg)
            ? `Apply the migrations: cd db && bun migrate.ts --url ${urlArg}`
            : "Check credentials and network reachability to the database.");
    }

    /**
     * Migration 014 through PostgREST, where the catalog cannot be read. The
     * body can still be told apart from 007's: 007 evaluated a NULL filter as
     * `NULL = '{}' OR metadata @> NULL`, which excluded every row, and 014
     * treats NULL as unfiltered. So one RPC with `filter := null` against a
     * non-empty table returns a row under 014 and nothing under 007. That
     * proves the body, not the SET clauses — those need the SQL store — and
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
     * `search_thoughts_hybrid` unconditionally since SMD-958, so a Supabase
     * project served over PostgREST whose migrations stop at 016 would pass
     * every check here, advertise both tools, and fail every call to them. The
     * catalog cannot be read over PostgREST, but the function can be
     * called: an RPC with an empty query text and a unit vector returns rows or
     * nothing under 017, and "Could not find the function" without it. The
     * first version of this check lived only on the SQL branch (review pass).
     */
    if (built.kind !== "sql") {
      if (rowCount === null) {
        add("keyword search", "skip", "not probed — the schema check above failed first");
        add("hybrid search", "skip", "not probed — the schema check above failed first");
        add("search signatures", "skip", "not probed — the schema check above failed first");
        add("edit signature", "skip", "not probed — the schema check above failed first");
        add("delete signature", "skip", "not probed — the schema check above failed first");
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
         * Migration 020's form, over PostgREST: the store's own call sends every
         * argument by name, so a database whose only match_thoughts predates 020
         * answers it with PGRST202 — reported as such rather than as a resolved
         * function (second review pass of 020). What this cannot see is 020's
         * OTHER failure state: a 4-argument match_thoughts re-created BESIDE
         * 020's by a hand re-apply of 007/014/019, which resolves the store's
         * six-argument call uniquely while every PostgREST caller that sends
         * the four arguments the old form took (the community integrations, a
         * dashboard) fails with PGRST203. Until change 97 this check probed
         * that as such a caller would, through a supabase-js client of its
         * own; preflight no longer carries one (the PostgREST store is kept for
         * Workers, and this file runs on Bun), and the overload count is a
         * pg_proc fact the SQL branch reads — so the detail says which half is
         * proved and names the run that proves the rest.
         */
        try {
          const probe = new Array(embDim).fill(0);
          probe[0] = 1;
          await built.matchThoughts({ embedding: probe, threshold: -1, limit: 1, filter: {} });
          add("search signatures", "ok",
              `match_thoughts takes 020's arguments over PostgREST; whether an earlier form sits beside it — which fails every 4-argument caller by name with PGRST203 — is read from pg_proc (${CATALOG_HINT})`);
        } catch (e) {
          const msg = (e as Error).message;
          if (missing(msg)) {
            add("search signatures", "fail",
                "match_thoughts does not take recency_weight and half_life_days over PostgREST — it is missing or is the form from before migration 020 — and the server sends them on every search, so every search would fail",
                APPLY_020_POSTGREST);
          } else {
            add("search signatures", "skip", `could not probe match_thoughts over PostgREST (${msg}); ${CATALOG_HINT}`);
          }
        }

        /**
         * Migration 032 gave update_thought a ninth parameter, the provenance
         * envelope, by dropping the 8-argument form — as 021 gave it the
         * eighth, the model beside the vector, by dropping the seventh — and
         * the store sends all nine by name on every edit. Probed AS the store
         * calls it (its own updateThought), with an id no row has:
         * update_thought answers {ok:false, error:'NOT_FOUND'} from its
         * row-lock read and writes nothing, so the probe is free. PGRST202 is a
         * form from before 032 (or no function). Whether an earlier form —
         * 018's or 021's re-applied by hand — sits beside 032's, which makes
         * every call with fewer than nine arguments ambiguous for PostgREST, is
         * the pg_proc read the SQL branch does; change 97 dropped the 7-argument
         * probe this check sent through a client of its own (see search
         * signatures above), so the detail names the run that reads it.
         */
        try {
          const r = await built.updateThought({ id: NOBODY });
          if (!r.ok && r.error === "NOT_FOUND") {
            add("edit signature", "ok",
                `update_thought takes 032's arguments over PostgREST; whether an earlier form sits beside it — which fails every caller by name with fewer than nine arguments — is read from pg_proc (${CATALOG_HINT})`);
          } else {
            add("edit signature", "skip", `update_thought answered a probe for an id no row has with ${JSON.stringify(r)} rather than NOT_FOUND; ${CATALOG_HINT}`);
          }
        } catch (e) {
          const msg = (e as Error).message;
          if (missing(msg)) {
            add("edit signature", "fail",
                "update_thought does not take p_provenance over PostgREST — it is missing or is a form from before migration 032 — and the server sends it on every edit, so every update_thought call would fail",
                APPLY_032_POSTGREST);
          } else {
            add("edit signature", "skip", `could not probe update_thought over PostgREST (${msg}); ${CATALOG_HINT}`);
          }
        }
        /**
         * Migration 042 gave delete_thought a third parameter, p_detach, by
         * dropping the two-argument form, and the store sends all three by
         * name on every delete. Probed as the store calls it, with an id no
         * row has: the function answers {ok:false, error:'NOT_FOUND'} and
         * writes nothing. PGRST202 is a form from before 042 (or no
         * function); then two named arguments, which only a two-argument form
         * re-created beside 042's by a hand re-apply of 009 or 036 makes
         * ambiguous — and that breaks every PostgREST caller by name from
         * before this change (third review pass of 042). Probed AS the store
         * calls it (its own deleteThought) since change 97, which dropped the
         * supabase-js client preflight sent the two-argument call through: the
         * overload half is the pg_proc read the SQL branch does, and the detail
         * names the run that reads it (see search signatures above).
         */
        try {
          const r = await built.deleteThought({ id: NOBODY });
          if (!r.ok && r.error === "NOT_FOUND") {
            add("delete signature", "ok",
                `delete_thought takes 042's arguments over PostgREST; whether a two-argument form sits beside it — which fails every caller by name with two arguments — is read from pg_proc (${CATALOG_HINT})`);
          } else {
            add("delete signature", "skip", `delete_thought answered a probe for an id no row has with ${JSON.stringify(r)} rather than NOT_FOUND; ${CATALOG_HINT}`);
          }
        } catch (e) {
          const msg = (e as Error).message;
          if (missing(msg)) {
            add("delete signature", "fail",
                "delete_thought does not take p_detach over PostgREST — it is missing or is a form from before migration 042 — and the server sends it on every delete, so every delete_thought call would fail",
                APPLY_042_POSTGREST);
          } else if (/permission denied/i.test(msg)) {
            // 042's guard reads and writes thought_facets as the caller on
            // every delete, a zero-row one included — so the probe itself
            // meets the missing privilege, and the evidence is in hand: not a
            // skip (seventh review pass of 042). The direct path's `write
            // privileges` says the same from the catalog.
            add("delete signature", "fail",
                `the connection's role lacks a privilege 042's citation guard needs on every delete (${msg}) — so every delete_thought call would fail`,
                "GRANT SELECT, UPDATE ON thought_facets TO <the connector's role>; against the project's direct connection (db/README.md, Grants for a capturing role).");
          } else {
            add("delete signature", "skip", `could not probe delete_thought over PostgREST (${msg}); ${CATALOG_HINT}`);
          }
        }
      }
      // The 3-argument upsert_thought's body (022's sentinel) and the role's
      // DELETE on thought_chunks are catalog facts; over PostgREST neither is
      // reachable, and a check that prints nothing looks like one that passed.
      add("atomic capture", "skip", `not checked over PostgREST — whether the 3-argument upsert_thought is 022's is read from the catalog; ${CATALOG_HINT}`);
      add("write privileges", "skip", `not checked over PostgREST — the capture path's table privileges are read over a direct connection; ${CATALOG_HINT}`);
      add("fingerprint backfill", "skip", `not checked over PostgREST — whether a thought without a fingerprint has one waiting is decided by hashing rows on the server; ${CATALOG_HINT}`);
      // The query log (034) and whether upsert_thought answers `existed` (035,
      // without which no cite row is logged, SMD-1719) are catalog facts too.
      // A seventh review pass walked the hosted path and found this check
      // printed nothing there — the one shape the comment above forbids.
      add("query log", "skip", `not checked over PostgREST — whether query_log (034) is present, and whether upsert_thought answers \`existed\` (035), without which a write that cites a returned id logs no cite row (SMD-1719), are read from the catalog; ${CATALOG_HINT}`);
      // The connection's isolation level is a direct-connection read whether or
      // not the schema check answered — reported beside the other catalog facts,
      // not inside the rows-present branch (moved at change 97's merge of change 95).
      add("transaction isolation", "skip", `not checked over PostgREST — the connection's default isolation level is read over a direct connection; ${CATALOG_HINT}`);
      // The rest of the direct-connection block — catalog reads with no
      // PostgREST form at all — reported by name too, so this path prints
      // every check the SQL path does. Before the first review pass of change
      // 97 sixteen of them printed nothing here, the one shape the DIRECT_CHECKS
      // comment forbids, while the README said they were skips.
      for (const name of DIRECT_CHECKS) {
        if (!results.some((r) => r.name === name)) add(name, "skip", `${DIRECT_CHECK_SKIP_OVER_POSTGREST}; ${CATALOG_HINT}`);
      }
    }

    // The atomic capture path needs migration 004. Its absence is not fatal — the
    // PostgREST store falls back — but the fallback is the failure mode migration
    // 004 exists to remove, so say so.
    if (built.kind === "sql" && conn) {
      try {
        const { SQL } = await import("bun");
        const sql = new SQL({ url: conn.url, max: 1 });

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
        // What the database says about itself, read ONCE through brain-info.ts —
        // the read brain_info and the keyed /health body make (SMD-2041) — so
        // this row, `migration ledger` and `schema version` below report what
        // the tool reports. After the probe above, which carries a refused
        // connection by this check's name.
        // No counts or size: preflight reads neither, and on a large brain
        // they are its startup's cost (review pass 2).
        const facts = await readDatabaseFacts(sql, { stats: false });
        if (vec.resolves) {
          add("vector extension", "ok", `the vector type resolves${facts.pgvector ? ` (pgvector ${facts.pgvector.version} in schema ${facts.pgvector.schema})` : ""}`);
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
        // Whether the 3-argument upsert_thought carries 035's sentinel — set by
        // the `atomic capture` check from the body it reads below, read by the
        // `query log` check further down this block (cite rows, SMD-1719, are
        // logged only when that body answers `existed`). One detector of 035,
        // not a second grep of the same body (seventh review pass); scoped to
        // this block rather than the module (eighth). A boolean, not a
        // tri-state: the assignment is unconditional once the forms are read,
        // and a throw before it leaves this block through the catch below,
        // which reports the query-log check as not run (ninth).
        let threeArgIs035 = false;
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
        // Which of the migrations that have a ledger-aware remedy the ledger
        // records — read ONCE, in `facts` above, for every check below that
        // asks (014, 019, 020 for the search functions; 023 for the fingerprint
        // backfill). A role without SELECT on the ledger, or no ledger, reads
        // as none. Every recorded name, as its three-digit prefix: the ledger
        // holds a few dozen short rows, and a list of the migrations that have a
        // ledger-aware remedy was one more thing to keep in step (it had drifted
        // from its own comment by the seventh review pass of SMD-1193).
        const ledgerPresent = facts.ledger.present;
        const ledgerRead = ledgerPresent && facts.ledger.names !== null;
        const ledger = new Set((facts.ledger.names ?? []).map((n) => n.slice(0, 3)));
        // Why an unread ledger is unread, in a remedy's words: a refusal is the
        // role's grants; a timeout or a ledger off this role's path is not
        // (review pass 2: every unread ledger was called a missing grant).
        const ledgerUnread = facts.unread.ledger;
        const whyUnread = ledgerUnread === undefined || ledgerUnread.reason === "refused"
          ? "this role cannot read schema_migrations"
          : ledgerUnread.reason === "invisible"
            ? "schema_migrations does not resolve for this role"
            : `schema_migrations could not be read: ${ledgerUnread.message}`;
        /**
         * The remedy for a migration a check finds absent: recorded in the
         * ledger, the migrator's re-run (a plain run skips a recorded file);
         * not recorded, or no ledger, apply it; the ledger unreadable to this
         * role, apply it — or, if the ledger records it, the re-run — said as
         * the 023 remedy says it, so an unread ledger is never mistaken for one
         * that does not record the migration.
         */
        const ledgerRemedy = (migration: string, apply: string, reapplied = ""): string => {
          // `reapplied`: what the re-run does that the apply text says of the
          // apply — 046's DROP chain — said again when the ledger records the
          // file and the remedy is the re-run alone (cold read, fourth review
          // pass: the sentence rode the apply text and the re-run lost it).
          if (ledger.has(migration)) return reapplied ? `${REAPPLY} ${reapplied}` : REAPPLY;
          // 046 applied by hand alone puts 046's audit and refusal bodies back
          // over 055's (SMD-2115): every remedy that names 046 names 055 after
          // it — before the "or, if the ledger…" clause, which is the whole
          // re-apply and needs no second step (second review pass).
          const applied = migration === "046" ? `${apply}${THEN_055}` : apply;
          return ledgerRead || !ledgerPresent
            ? applied
            : `${applied} — or, if the ledger already records ${migration} (${whyUnread}): ${REAPPLY.charAt(0).toLowerCase()}${REAPPLY.slice(1)}${reapplied ? ` ${reapplied}` : ""}`;
        };
        // By signature, not arity: a vendored bootstrap's upsert_thought(text,
        // vector, jsonb) is a third 3-argument form, and reading whichever the
        // catalog returned first judged a healthy brain by the wrong body
        // (first review pass; SMD-1245's arity-alone finding).
        const three = forms.find((f) => f.sig === "upsert_thought(text,jsonb,vector)");
        const two = forms.find((f) => f.sig === "upsert_thought(text,jsonb)");
        threeArgIs035 = three !== undefined && /ob1:re-capture-writes-no-provenance/.test(three.src);
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
        // which migration owns it. 046 is the last definer of BOTH forms
        // (035's bodies, each with the write event set beside the actor —
        // SMD-1730; the recognisers below still tell 035's shape, which 046
        // carries), so one file is the remedy for every stale state.
        const LAST = "046_thought_audit_event_shape.sql";
        const LOCKED = /ob1:capture-takes-fingerprint-lock/;
        const NO_FILL = /ob1:re-capture-writes-no-provenance/;
        const applyLast = (why: string) => ledgerRemedy("046", `Apply db/migrations/${LAST}${why}`);
        // The 2-argument body is judged on its own and said beside whichever
        // 3-argument state fires, so a brain with both replaced hears it once
        // rather than on the run after the first remedy (first review pass).
        // Two stale states: from before 005 (no guard) and from before 033
        // (005's guard, no lock).
        const twoStale = two !== undefined && !UPSERT_TWO_ARG_SHIPPED_RE.test(two.src);
        const twoUnlocked = two !== undefined && !twoStale && !LOCKED.test(two.src);
        // 046's own sentinel: the body sets the write event beside the actor
        // before its INSERT. Without a recogniser, 035 re-applied by hand
        // read as the shipped pair and every event a capture declared was
        // dropped silently (sixth review pass).
        const EVENT_SET = /ob1:capture-sets-write-event/;
        const twoNoEvent = two !== undefined && !twoStale && !twoUnlocked && !EVENT_SET.test(two.src);
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
          // The unapplied files, named: the definers from `stage` through 046
          // — 046 alone when `stage` is 046 or the ledger has it (a brain at
          // 032 lacks 033, 035 and 046).
          const list = (fs: string[]) => fs.length === 1 ? `migration ${fs[0]} is` : `migrations ${fs.slice(0, -1).join(", ")} and ${fs[fs.length - 1]} are`;
          const files = ["033", "035", "046"].filter((f) => f >= stage);
          return ledger.has("046") ? `${earlier} re-applied by hand puts it back`
            : ledgerRead && ledger.has(stage) ? `${earlier} re-applied by hand puts it back, and ${list(files.slice(1))} not yet applied`
            : ledgerRead ? `${list(files)} not yet applied`
              : `${list(files)} not yet applied, or ${earlier} was re-applied by hand`;
        };
        const TWO_UNLOCKED_WHY = `it is from before migration 033 (${pre("033", "005")}): it takes no fingerprint lock, so a capture through it racing an edit of the same text raises the unique violation`;
        // 033's and 035's 2-argument bodies are byte-identical, so either
        // re-apply is named (run-it, seventh review pass).
        const TWO_NO_EVENT_WHY = `it is from before migration 046 (${pre("046", "033 or 035")}): it sets no write event beside the actor, so a stance, cites or a window a PostgREST caller declares in the payload reaches no audit row`;
        const andTwo = twoStale ? `; and the 2-argument body is not 005's either — ${TWO_STALE_WHY}` : twoUnlocked ? `; and the 2-argument body is not 046's either — ${TWO_UNLOCKED_WHY}` : twoNoEvent ? `; and the 2-argument body is not 046's either — ${TWO_NO_EVENT_WHY}` : "";
        if (!three) {
          add("atomic capture", "fail", `${forms.length} upsert_thought overload(s) — the 3-argument form, the atomic capture, is missing${twoStale ? `; and the 2-argument body present is not 005's — ${TWO_STALE_WHY}` : twoUnlocked ? `; and the 2-argument body present is not 046's — ${TWO_UNLOCKED_WHY}` : twoNoEvent ? `; and the 2-argument body present is not 046's — ${TWO_NO_EVENT_WHY}` : ""}${andOthers}`,
              applyLast(" — the last definer of both forms (004 created the 3-argument one; 005, 008, 021, 022, 025, 033, 035 and 046 redefined it, and an earlier file's body alone would drop what every later one added)."));
        } else if (!two) {
          // This server never calls the 2-argument form; PostgREST callers by
          // name and the two-step fallback do. A warning.
          add("atomic capture", "warn", `${forms.length} upsert_thought overload(s) — the 2-argument form is missing; this server does not call it, PostgREST callers by name and the two-step capture fallback do${andOthers}`,
              applyLast(" — the last definer of the 2-argument form as well."));
        } else if (!/ob1:vector-replaces-chunks/.test(three.src)) {
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present, but the 3-argument body is from before migration 022 (004, 005, 008 or 021 re-applied by hand without 046 after them): a re-capture that makes no windows — the Edge Function server, or a window that grew — at another model replaces the vector and leaves the previous vector's chunk rows under it, so search finds the thought by windows it no longer has; and it takes no fingerprint lock${andTwo}${andOthers}`,
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
        } else if (!EVENT_SET.test(three.src)) {
          // 035's body: locked, no fill — and no write event. The 2-argument
          // body is 035's too, said beside it through andTwo.
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present, and the 3-argument body carries 022's rule, 025's envelope, the fingerprint lock and writes provenance on a first capture only, but it is from before migration 046 (${pre("046", "035")}): the write event a capture declares — stance, cites, the valid window, trust — is dropped silently, so no audit row carries it and every read built on the event shape (SMD-1729) sees a capture that declared nothing${andTwo}${andOthers}`,
              applyLast("."));
        } else if (twoStale || twoUnlocked || twoNoEvent) {
          add("atomic capture", "warn",
              `the 2- and 3-argument upsert_thought present and the 3-argument body is 046's, but the 2-argument body is ${twoStale ? `not 005's — ${TWO_STALE_WHY}` : twoUnlocked ? `not 046's — ${TWO_UNLOCKED_WHY}` : `not 046's — ${TWO_NO_EVENT_WHY}`}${andOthers}`,
              applyLast(" — the last definer of the 2-argument form as well."));
        } else {
          add("atomic capture", "ok", `the 2- and 3-argument upsert_thought present, both 046's — the 3-argument body carries 022's rule, so a re-capture's windows stay only while the label vouches for them, 025's provenance envelope, the fingerprint lock, so a capture and an edit of one text are serialised, and writes provenance on a first capture only, so no capture can close a supersession loop, and both set the write event beside the actor (046); the 2-argument body refuses a non-object payload (005) and takes the lock${andOthers}`);
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
        // 046's audit trigger reads ob1_agents as the caller; 025's does not. The
        // capture set lists the SELECT (db/README.md's table, --grant), and the
        // check requires it only while the body that reads it is installed — a
        // brain still at 044 under this server writes without it, and the
        // `audit events` check says so (second review pass). Read from pg_proc
        // by its sentinel, as the capture-body checks read theirs.
        // Since 055 the rule (and its sentinel) live in ob1_append_thought_event,
        // which the trigger calls; a brain before 055 has it in the trigger.
        const auditBodies = (await sql`
          SELECT p.proname AS name, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('thoughts_write_audit', 'ob1_append_thought_event')`) as { name: string; src: string }[];
        const auditReadsAgents = keyRuleHolds(String(auditBodies.find((b) => b.name === "thoughts_write_audit")?.src ?? ""), String(auditBodies.find((b) => b.name === "ob1_append_thought_event")?.src ?? ""));
        const required = [...CAPTURE_WRITES.filter((w) => w.table !== "ob1_agents" || auditReadsAgents), ...conditional];
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
          // What would fail, by what is missing: the capture path's writers
          // for any capture-path table, and — 042's guard reads and writes
          // thought_facets as the caller on every delete — every delete of a
          // thought for that one, said separately so an operator whose
          // capture succeeds is not told the check was wrong (seventh pass).
          const captureMiss = [...missingByTable.keys()].some((t) => t !== "thought_facets");
          // 046's audit trigger reads the key's kind from ob1_agents as the caller
          // on every write that carries an actor — captures, edits AND deletes
          // — so that one is named with the trigger (SMD-1730).
          const agentsMiss = missingByTable.has("ob1_agents");
          const fails: string[] = [];
          if (captureMiss) fails.push((triggerMiss
            ? "a windowed capture, an edit with content, 008's audit trigger, or 016's enqueue trigger — which as the caller reads ob1_config on every capture, and upserts a work claim while entity extraction is enabled —"
            : "a windowed capture, an edit with content, or 008's audit trigger")
            + (agentsMiss ? " (046's audit trigger reads ob1_agents as the caller on every capture, edit and delete that carries an actor)" : ""));
          if (missingByTable.has("thought_facets")) fails.push("every delete of a thought (042's citation guard reads and writes thought_facets as the caller)");
          const why = ` — so ${fails.join(", and ")} would fail`;
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
                    : ledgerRead || !ledgerPresent
                      ? "Apply db/migrations/023_content_fingerprint_backfill.sql."
                      : `Apply db/migrations/023_content_fingerprint_backfill.sql — or, if the ledger already records 023 (${whyUnread}), ${byHand}`);
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
         * 046's event shape (SMD-1730): the columns the log of record carries
         * beyond 008's and 010's; the trigger body that derives actor_kind and
         * trust from the key and stamps the event (its sentinel); the refusal
         * trigger's one lawful amendment (its sentinel). The columns are FATAL
         * as the trail is: 046's upsert_thought and update_thought fire a
         * trigger that INSERTs into them, so without them every write through
         * this server fails. An older body over the columns is a WARN: writes
         * go through and every row records an unknown kind and no event — the
         * backfill fills the kind later, the event is lost. 055's payload
         * (SMD-2115): the trigger body that carries a capture's content and an
         * update's key move (its sentinel) — an older body over 055's schema is
         * a WARN of the same kind: the log cannot rebuild what those rows
         * describe, the payload backfill fills the captures later, the key
         * moves are lost. Then the census: keys nobody has classified and rows
         * waiting on one, and capture rows still without content, with the
         * remedy — a WARN, since NULL is the honest value until the operator
         * says; a capture row nothing derives for (its thought gone without a
         * tombstone) is named in the ok line, not a warning to carry forever.
         */
        try {
          const EVENT_COLUMNS = ["actor_kind", "trust", "origin", "stance", "cites", "valid_from", "valid_until", "backfilled_at"];
          // The eight names spelled into the query, not bound as an array: Bun's
          // SQL binds a JS array to ANY() as one text value (SMD-1803's trap).
          const evCols = (await sql`
            SELECT column_name AS c FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'thought_audit'
              AND column_name IN ('actor_kind', 'trust', 'origin', 'stance', 'cites', 'valid_from', 'valid_until', 'backfilled_at')`) as { c: string }[];
          const missingCols = EVENT_COLUMNS.filter((c) => !evCols.some((r) => r.c === c));
          const bodies = (await sql`
            SELECT p.proname AS name, p.prosrc AS src
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('thoughts_write_audit', 'thought_audit_refuse_mutation', 'ob1_append_thought_event')`) as { name: string; src: string }[];
          const trigSrc = String(bodies.find((b) => b.name === "thoughts_write_audit")?.src ?? "");
          const refuseSrc = String(bodies.find((b) => b.name === "thought_audit_refuse_mutation")?.src ?? "");
          // 046's rule — the kind from the key, never the payload — stands in
          // ob1_append_thought_event since 055 and in the trigger before it;
          // the trigger names the sentinel either way, so the rule is read
          // where it lives, not where it is mentioned (cold read, SMD-2115's
          // first review pass).
          const appendSrc = String(bodies.find((b) => b.name === "ob1_append_thought_event")?.src ?? "");
          const keyRule = keyRuleHolds(trigSrc, appendSrc);
          const [{ tableThere }] = (await sql`SELECT to_regclass('public.thought_audit') IS NOT NULL AS "tableThere"`) as { tableThere: boolean }[];
          if (!tableThere) {
            // No table: nothing here predates 046 in particular, and the `audit
            // trail` check above has already refused for 008 (fourth review pass).
            add("audit events", "skip", "not checked — thought_audit is missing; the audit trail check names 008");
          } else if (missingCols.length && keyRule) {
            // 046's trigger INSERTs into the columns: dropped from under it, every
            // capture, edit and delete fails in the trigger.
            add("audit events", "fail",
                `thought_audit lacks ${missingCols.length} of 046's eight columns (${missingCols.join(", ")}) while the audit trigger is 046's, which writes them — every capture, edit and delete would fail in the trigger`,
                ledgerRemedy("046", APPLY_046));
          } else if (missingCols.length) {
            // A brain from before 046 under this server: 025's trigger writes 008's
            // and 010's columns, the servers send no event, so every write goes
            // through — recording no kind, trust, door or event (first review pass:
            // the first draft called this a failure it is not).
            add("audit events", "warn",
                `thought_audit lacks ${missingCols.length} of 046's eight columns (${missingCols.join(", ")}) — the brain predates migration 046: writes go through, and every row records no kind, trust, door or event until it is applied`,
                ledgerRemedy("046", APPLY_046));
          } else if (!keyRule) {
            add("audit events", "warn",
                "the columns are there but the audit trigger's body is from before 046 (025 or an earlier file re-applied by hand): every write records an unknown kind, no door and no event — the backfill can fill the kind and the door later, the event is lost",
                ledgerRemedy("046", APPLY_046));
          } else if (!/ob1:audit-amend-fills-null-only/.test(refuseSrc)) {
            add("audit events", "warn",
                "the refusal trigger's body is from before 046 (008 re-applied by hand): every UPDATE of thought_audit is refused, the backfill's included, so rows written before a key was classified can never gain their kind",
                ledgerRemedy("046", APPLY_046));
          } else {
            // 055's sentinel (SMD-2115): the body that carries a capture's
            // content and an update's key move. Without it — 055 not yet
            // applied (a brain at 053 under this server), or 046 re-applied
            // by hand over 055 — writes go through, the kind and the event
            // are recorded, and the log cannot rebuild what these rows
            // describe: the payload backfill fills the captures later, the
            // key moves are lost for good. Said BESIDE the census, not instead
            // of it (cold read, first review pass: the first draft's rung sat
            // in this ladder and a brain at 053 lost its kind census), and the
            // payload census below is skipped on such a brain, whose schema
            // has no ob1_capture_payload to derive with.
            const pre055 = !/ob1:capture-event-carries-content/.test(trigSrc);
            const PRE055 = "the audit trigger's body is from before 055 (migration 055 not yet applied, or 046 re-applied by hand): a capture records no content and an update no key move, so the log alone cannot rebuild those thoughts — backfill_thought_payloads fills the captures later, the key moves are lost";
            // The census names what waits, not only how many: the names the
            // waiting rows carry that no classified key answers to (the
            // set_agent_kind the remedy asks for), and the rows whose key IS
            // classified since and want only the backfill (run-it, first review
            // pass: a brain with 9,008 waiting rows and no unclassified key was
            // told to classify "<label>").
            // One pass over the waiting rows — 046's partial index on them, by
            // name — resolving each as the backfill does (by id, else by name,
            // through ob1_registry_kind), so "waiting only on the backfill" is
            // what the backfill would fill (second review pass: three scans,
            // and a by-name count that promised a fill the id refused).
            // Grouped by writer before the lookup, so the cost is one resolution
            // per distinct (id, name) pair, not per waiting row; and an
            // unclassified key counts only while it still holds an unrevoked
            // key — a key retired through revoke_agent_key (010) can never write
            // again and must not keep the warning lit (third review pass).
            const [census] = (await sql.unsafe(`
              WITH waiting AS (
                SELECT a.canonical_agent_id AS agent, a.actor_name AS name, count(*)::int AS n
                  FROM thought_audit a
                 WHERE a.actor_kind IS NULL AND (a.actor_name IS NOT NULL OR a.canonical_agent_id IS NOT NULL)
                 GROUP BY 1, 2),
              -- A row with an id and no name is named by the registry's label
              -- for that id, which set_agent_kind takes; only an id the
              -- registry has no row for is named as the id (seventh review
              -- pass: the remedy said set_agent_kind('<label>') and showed a uuid).
              resolved AS (
                SELECT COALESCE(w.name, (SELECT g.label FROM ob1_agents g WHERE g.canonical_agent_id = w.agent), 'agent ' || w.agent::text) AS name,
                       w.n, ob1_registry_kind(w.agent, w.name) IS NOT NULL AS fillable
                  FROM waiting w),
              -- An unclassified key: a registry row with no kind, an unrevoked
              -- digest, and no write of its own that resolves by name — a key
              -- renamed in the env and pre-classified under its new name keeps
              -- its old row unclassified when 010's rename meets label_conflict,
              -- while every write it makes resolves through the name (fifth
              -- review pass); 010's agent index makes the row read cheap.
              unclassified AS (
                SELECT g.label FROM ob1_agents g
                 WHERE g.kind IS NULL
                   AND EXISTS (SELECT 1 FROM ob1_agent_keys k WHERE k.canonical_agent_id = g.canonical_agent_id AND k.revoked_at IS NULL)
                   -- The names first, then the lookup once per name, not once
                   -- per row (sixth review pass: a key with a million writes
                   -- probed the registry a million times). OFFSET 0 is the
                   -- fence: without it the planner pushes the STABLE lookup
                   -- down through the DISTINCT onto every row — the sixth
                   -- pass's rewrite changed nothing until measured (run-it,
                   -- seventh review pass: 1.7 s → 0.17 s at a million rows).
                   AND NOT EXISTS (SELECT 1 FROM (SELECT DISTINCT a.actor_name
                                                    FROM thought_audit a
                                                   WHERE a.canonical_agent_id = g.canonical_agent_id AND a.actor_name IS NOT NULL
                                                  OFFSET 0) d
                                    WHERE ob1_registry_kind(NULL, d.actor_name) IS NOT NULL))${pre055 ? "" : `,
              -- 055's payload (SMD-2115): the capture rows still without
              -- content, read through 055's partial index on exactly them —
              -- empty on a brain whose pass has run and whose every capture
              -- derives — bounded, ordered as the
              -- index is so the planner takes it with stale statistics too
              -- (run-it, first review pass: a seq scan the first start after
              -- the migration), and each one derived as the backfill derives
              -- it, so the line can say how many the pass would fill and how
              -- many nothing derives for (a thought gone without a tombstone:
              -- named, not a warning carried on every start). Above the bound
              -- the derivation is skipped and the count says "more than".
              payload AS (
                SELECT a.thought_id, a.created_at, a.seq
                  FROM thought_audit a
                 WHERE a.action = 'capture' AND NOT COALESCE(a.diff ? 'content', false)
                   AND jsonb_typeof(COALESCE(a.diff, '{}'::jsonb)) = 'object'
                 ORDER BY a.created_at, a.seq
                 LIMIT $1),
              derivable AS (
                SELECT count(*)::int AS n
                  FROM payload p CROSS JOIN LATERAL ob1_capture_payload(p.thought_id, p.created_at, p.seq) d
                 WHERE d.content IS NOT NULL AND (SELECT count(*) FROM payload) <= $2)`}
              SELECT (SELECT count(*)::int FROM unclassified) AS unclassified,
                     (SELECT string_agg(label, ', ' ORDER BY label) FROM unclassified) AS labels,
                     COALESCE(sum(n), 0)::int AS awaiting,
                     COALESCE(sum(n) FILTER (WHERE fillable), 0)::int AS fillable,
                     (SELECT string_agg(nm, ', ' ORDER BY nm) FROM (SELECT DISTINCT name AS nm FROM resolved WHERE NOT fillable LIMIT 8) s) AS unnamed,
                     ${pre055 ? "0 AS payload, 0 AS recoverable" : "(SELECT count(*)::int FROM payload) AS payload, (SELECT n FROM derivable) AS recoverable"}
                FROM resolved`, pre055 ? [] : [PAYLOAD_CENSUS_BOUND + 1, PAYLOAD_CENSUS_BOUND])) as Record<string, unknown>[];
            const unclassified = Number(census.unclassified), awaiting = Number(census.awaiting), fillable = Number(census.fillable);
            const payload = Number(census.payload), recoverable = Number(census.recoverable);
            const overBound = payload > PAYLOAD_CENSUS_BOUND;
            // What the payload census says beside the kind census, and its remedy.
            const payloadClause = overBound
              ? `more than ${PAYLOAD_CENSUS_BOUND.toLocaleString("en-US")} capture event(s) carry no content (written before migration 055, or under a re-applied 046)`
              : `${payload} capture event(s) carry no content (written before migration 055, or under a re-applied 046)${payload > recoverable ? `, ${payload - recoverable} of them with nothing to derive from — the thought gone without a tombstone` : ""}${payload > 0 && recoverable > 0 ? ` — ${recoverable} of them the payload backfill fills` : ""}`;
            const payloadFinding = payload > 0 && (overBound || recoverable > 0);
            const PAYLOAD_REMEDY = "As the owner (the pass amends thought_audit), SELECT backfill_thought_payloads(); fills them from the first content-moving update, the tombstone or the live row, and reports any row nothing derives for (db/README.md).";
            const PAYLOAD_REMEDY_THEN = "Then, as the owner (the pass amends thought_audit), SELECT backfill_thought_payloads(); fills the capture events written before 055 from the first content-moving update, the tombstone or the live row, and reports any row nothing derives for (db/README.md).";
            const apply055 = ledgerRemedy("055", APPLY_055);
            const THEN_APPLY_055 = ` Then, ${apply055.charAt(0).toLowerCase()}${apply055.slice(1)}`;
            if (unclassified > 0 || awaiting > 0) {
              const needsKinds = unclassified > 0 || Boolean(census.unnamed);
              // The payload census's finding — or the pre-055 body — rides the
              // same line, message AND remedy (cold read, first review pass: the
              // first draft appended the remedy and dropped the clause).
              add("audit events", "warn",
                  `${unclassified} key(s) with no kind${unclassified ? ` (${census.labels})` : ""} and ${awaiting} audit row(s) naming a key with no kind${census.unnamed ? ` (names: ${census.unnamed})` : ""}${fillable ? `, ${fillable} of them naming a key classified since — waiting only on the backfill` : ""} — every write through an unclassified key is recorded with actor_kind and trust unknown, which every read built on them will say${pre055 ? `; and ${PRE055}` : payload > 0 ? `; and ${payloadClause}` : ""}`,
                  // The backfill is the owner's call: its pass holds a share lock on
                  // ob1_agents, which needs UPDATE there (seventh review pass: the
                  // remedy read as a plain SELECT and a connector role following it
                  // met a permission error that looked like a grant bug). A name
                  // shaped `agent <uuid>` is an id the registry has no row for.
                  (needsKinds
                    ? "For each name: SELECT set_agent_kind('<label>', '<operator | agent | ingested>'); then, as the owner (the pass amends thought_audit and locks ob1_agents), SELECT backfill_thought_audit_events(); fills the rows already written (db/README.md)."
                    : "As the owner (the pass amends thought_audit and locks ob1_agents), SELECT backfill_thought_audit_events(); fills them — every key they name is classified (db/README.md).")
                  + (/(^|, )agent [0-9a-f-]{36}/.test(String(census.unnamed ?? "")) ? " A name shaped `agent <uuid>` is an id the registry has no row for: set_agent_kind cannot reach those rows, and they stay unknown." : "")
                  + (pre055 ? THEN_APPLY_055 : payloadFinding ? ` ${PAYLOAD_REMEDY_THEN}` : ""));
            } else if (pre055) {
              add("audit events", "warn", `046's event shape present and every key classified, but ${PRE055}`, ledgerRemedy("055", APPLY_055));
            } else if (payloadFinding) {
              // Every key classified, and captures the log cannot rebuild yet
              // (SMD-2115): the pass is the remedy, and it says what it filled.
              add("audit events", "warn",
                  `046's event shape present and every key classified, but ${payloadClause}; the log alone cannot rebuild those thoughts until it runs`,
                  PAYLOAD_REMEDY);
            } else {
              add("audit events", "ok", `046's event shape present — the columns, the trigger that derives the kind from the key, the one lawful amendment — and every key classified; 055's payload in every capture event${payload > 0 ? ` that has one — ${payload} with nothing to derive it from (the thought gone without a tombstone; the fold names them)` : ""}`);
            }
          }
        } catch (e) {
          const msg = (e as Error).message;
          // The census SELECTs thought_audit and ob1_agents; the hard capture set
          // grants INSERT on the one and SELECT on the other, so a role granted
          // exactly that set cannot run it — not a warning about the brain
          // (second review pass, run-it): the community group's SELECT, which
          // --grant issues, is what lets this role read the log it writes.
          if (/permission denied/i.test(msg)) {
            // The table the denial names, not a guess: thought_audit's SELECT is
            // the community group's, ob1_agents' the capture group's since 046
            // (run-it, third review pass: the remedy named the wrong one).
            const denied = /permission denied for table (\w+)/i.exec(msg)?.[1] ?? "thought_audit";
            // The group each table the census reads belongs to, as db/config.mjs's
            // ROLE_GRANTS has them (fifth review pass: ob1_agent_keys is the
            // server group's, and was sent to the community group).
            // thoughts joined the census with 055 (ob1_capture_payload reads the
            // live row); the fallback is a whole clause, not a fragment (run-it,
            // SMD-2115's first review pass: "— a row of, which").
            const group = denied === "ob1_agents" ? "the capture group's row since 046"
              : denied === "ob1_agent_keys" ? "the server group's row"
              : denied === "thought_audit" ? "the community group's row"
              : denied === "thoughts" ? "the capture group's row since 001, read by the payload census since 055"
              : denied === "ob1_config" ? "the server group's row since 006, read by the payload census since 055 (the boundary from which seq is exact)"
              : "a row of the grants table";
            add("audit events", "skip", `not checked — this role cannot read the census (${msg}); the shape is checked, the waiting keys are not`,
                `GRANT SELECT ON ${denied} TO <the connector's role>; — ${group}, which migrate.ts --grant issues (db/README.md, Grants for a capturing role).`);
          } else {
            add("audit events", "warn", `could not verify: ${msg}`, "The check reads information_schema.columns, pg_proc, ob1_agents and thought_audit.");
          }
        }

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
        if (Number(registry[0].c) >= 1) {
          // A capture-scoped key (SMD-1298) needs 049's wider CHECK on
          // ob1_agent_keys.scope: without it resolve_agent raises, agents.ts
          // degrades to no id, and every hook capture lands unattributed while
          // nothing says why (third review pass).
          const captureKeys = accessKeys.keys.filter((k) => k.scope === "capture");
          // Read whatever keys are configured (a list lacking read or write is
          // everyone's problem); a brain without the CHECK at all is said as
          // such, not as 010's two-value CHECK.
          // Found by the column it is on, not by its name: a restore or a
          // hand-written 010 can leave the two-value rule under another name,
          // which a lookup by name read as "no CHECK at all" (ninth review
          // pass). conkey = {scope} is the rule 049 drops and re-adds — one
          // shape in the migration, here and in test-schema (tenth review pass:
          // three regexes over the definition disagreed at the edges).
          const scopeChecks = await sql`
            SELECT c.conname AS n, pg_get_constraintdef(c.oid) AS d FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace ns ON ns.oid = t.relnamespace
            JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'scope'
            WHERE t.relname = 'ob1_agent_keys' AND ns.nspname = 'public' AND c.contype = 'c'
              AND c.conkey = ARRAY[a.attnum]`;
          // The scope RULE is a value list naming read and write; a CHECK on the
          // column alone that is not one (`scope <> ''`) is neither the rule nor
          // "read and write only" — said by its definition, as what 049 will
          // drop (eleventh review pass: it was described as the two-value rule).
          const checks = (scopeChecks as { n?: unknown; d?: unknown }[]).map((r) => ({ n: String(r.n ?? ""), d: String(r.d ?? "") }));
          // A value list by its SHAPE (`= ANY (ARRAY[...])`, `scope = '...'`), not
          // by the values it names — one naming capture alone was "not the
          // scope rule" and told to be dropped (twelfth review pass).
          // …in every spelling pg_get_constraintdef gives it: `= ANY (ARRAY['read'::text, …])`,
          // `= ANY ('{read,write}'::text[])`, `scope = 'capture'::text` (thirteenth review pass).
          const isValueList = (c: { d: string }) => /= ANY \((?:ARRAY\[|'\{)|scope = '/.test(c.d);
          const admits = (c: { d: string }, v: string) => c.d.includes(`'${v}'`) || new RegExp(`[{,]${v}[},]`).test(c.d);
          const valueLists = checks.filter(isValueList);
          const others = checks.filter((c) => !isValueList(c));
          // A list that omits read or write refuses every key of that scope at
          // resolve_agent — a failure when such a key is configured, a warning
          // when none is (thirteenth review pass: a read-only mirror carrying
          // CHECK (scope IN ('read')) on purpose failed over keys it has none of).
          // (one expression, no Set.add call: the suite reads every check-add in this block by its name)
          const configured = new Set<string>([...accessKeys.keys.map((k) => k.scope), ...(env.MCP_ACCESS_KEY ? ["write"] : [])]);
          const missing = ["read", "write"].filter((v) => valueLists.some((c) => !admits(c, v)));
          const lacking = valueLists.filter((c) => missing.some((v) => !admits(c, v)));
          const admitsCapture = valueLists.every((c) => admits(c, "capture"));
          if (missing.length) {
            const named = lacking.map((c) => `${c.n}: ${c.d.replace(/^CHECK \(\(|\)\)$/g, "")}`).join("; ");
            const presented = missing.filter((v) => configured.has(v));
            add("agent identity", presented.length ? "fail" : "warn",
                `ob1_agent_keys.scope's CHECK does not admit ${missing.join(" or ")} (${named}) — ${presented.length ? `every ${presented.join(" and ")} key configured lands unattributed` : "no key of that scope is configured, so nothing is refused today"}`,
                "Apply db/migrations/049_agent_key_scope_capture.sql (cd db && bun migrate.ts --url $DATABASE_URL) — it drops every CHECK on the column and adds the three-value one.");
          } else if (captureKeys.length && scopeChecks.length === 0) {
            add("agent identity", "warn", `resolve_agent present; ${captureKeys.length} capture-scoped key(s) configured and ob1_agent_keys.scope carries no CHECK at all (010's was dropped or the table restored without it) — any scope is recorded`,
                "Apply db/migrations/049_agent_key_scope_capture.sql to put the three-value CHECK back (cd db && bun migrate.ts --url $DATABASE_URL).");
          } else if (captureKeys.length && !admitsCapture) {
            const odd = valueLists.filter((c) => !/'capture'/.test(c.d) && c.n !== "ob1_agent_keys_scope_check").map((c) => c.n);
            add("agent identity", "fail",
                `${captureKeys.length} capture-scoped key(s) configured (${captureKeys.map((k) => k.name).join(", ")}) but ob1_agent_keys.scope admits read and write only${odd.length ? ` (under the name ${odd.join(", ")})` : ""} — every capture through them would land without an agent id`,
                "Apply db/migrations/049_agent_key_scope_capture.sql (cd db && bun migrate.ts --url $DATABASE_URL) — it drops every CHECK on the column, whatever its name, and adds the three-value one.");
          } else if (others.length) {
            add("agent identity", "warn", `resolve_agent present; ${valueLists.length ? "the scope CHECK admits capture (049), and " : ""}${others.length} other CHECK(s) on ob1_agent_keys.scope alone (${others.map((c) => `${c.n}: ${c.d}`).join("; ")}) — not the scope rule, and 049 drops every CHECK on the column alone when re-applied`,
                "Drop it, or move the rule to a CHECK spanning another column, which 049 leaves alone.");
          } else add("agent identity", "ok", `resolve_agent present${captureKeys.length ? `; the scope CHECK admits capture (049)` : ""}`);
        } else add("agent identity", "warn",
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
        // edge-function-cost-optimization recipe (retired by SMD-1800) and hardened it — topics and
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
          // The shipped arity, read from the signature the stores call rather
          // than spelled here — the next defaulted parameter moves one constant
          // (fifth review pass); the form one short of it is the one the
          // migration before the current one left.
          const ARITY = UPDATE_THOUGHT_SIGNATURE.split(",").length;
          const ut = (await sql`
            SELECT p.pronargs AS nargs, p.oid::regprocedure::text AS sig
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname = 'update_thought' AND n.nspname = 'public'
            ORDER BY (p.pronargs = ${ARITY}) DESC, p.oid`) as { nargs: number; sig: string }[];
          // 046 (SMD-1730) gave update_thought a tenth argument, the write
          // event, by dropping the 9-argument form — 032's mechanism, one form
          // later. A 9-argument form ALONE is a brain that predates 046: every
          // edit still resolves (the servers send nine by name; a defaulted
          // tenth is the same call), so it is a WARN naming what is lost — the
          // event — where a 7- or 8-argument form alone is the FAIL it was.
          const current = ut.filter((r) => Number(r.nargs) === ARITY);
          const extra = ut.filter((r) => Number(r.nargs) !== ARITY).map((r) => r.sig);
          const nineAlone = ut.length === 1 && Number(ut[0].nargs) === ARITY - 1;
          if (!ut.length) {
            add("edit signature", "fail", "update_thought is missing — the update_thought tool and db/reembed.ts call it", ledgerRemedy("046", APPLY_046));
          } else if (current.length && extra.length === 0) {
            add("edit signature", "ok", `${current[0].sig}: the form the servers and reembed.ts call since migration 046 (${UPDATE_THOUGHT_SIGNATURE}), alone`);
          } else if (current.length) {
            add("edit signature", "fail",
                `beside the form the servers call there ${extra.length === 1 ? "is an earlier one" : `are ${extra.length} earlier ones`}: ${extra.join(", ")} — an earlier migration re-applied by hand over 046 — so every call that sends fewer than ten arguments to update_thought, which is every PostgREST caller by name, every hand-written SELECT and db/reembed.ts's positional eight, fails with "function is not unique"`,
                `Drop the earlier form, as 046 does: ${extra.map((sig) => `DROP FUNCTION ${sig};`).join(" ")}`);
          } else if (nineAlone) {
            add("edit signature", "warn",
                `${ut[0].sig} is the form from before migration 046: every edit resolves, but no write event (p_event — stance, cites, the valid window, trust) reaches the audit row, and db/reembed.ts, which resolves the body by ${UPDATE_THOUGHT_SIGNATURE}, refuses to run`,
                ledgerRemedy("046", APPLY_046));
          } else if (ut.some((r) => Number(r.nargs) === ARITY - 1)) {
            // A 9-argument form among the leftovers and no 10: 032 re-applied
            // would drop the 8 and 7 and leave its own 9 to be named on the next
            // start; 046's chain reaches all three (second review pass).
            add("edit signature", "fail",
                `${extra.join(" and ")} are forms from before migration 046 with none the servers call — every call with fewer than ten arguments is "function is not unique"`,
                ledgerRemedy("046", `${APPLY_046} Its DROP chain reaches the 9-, 8- and 7-argument forms and leaves the one form.`, "Re-applied, 046's DROP chain reaches the 9-, 8- and 7-argument forms and leaves the one form."));
          } else {
            // 046 is the remedy here too: its DROP chain reaches the 8- and
            // 7-argument forms and leaves the one form the servers call, where
            // 032's would leave its own 9-argument form to be named on the next
            // start (run-it, third review pass).
            add("edit signature", "fail",
                `${extra.join(" and ")} ${extra.length === 1 ? "is the form" : "are the forms"} from before migration 032; the server sends p_provenance, which only 032's form and its successors take — so every edit would fail, and db/reembed.ts refuses to run`,
                ledgerRemedy("046", `${APPLY_046} Its DROP chain reaches every older form and leaves the one the servers call.`, "Re-applied, 046's DROP chain reaches every older form and leaves the one the servers call."));
          }
        } catch (e) {
          add("edit signature", "warn", `could not verify: ${(e as Error).message}`, "The catalog read behind this check needs SELECT on pg_proc.");
        }

        /**
         * Migration 042 changed delete_thought the way 021 and 032 changed
         * update_thought: a defaulted third parameter (p_detach), the
         * two-argument form dropped, both stores sending all three. The same
         * two states break every delete and neither shows in a presence
         * check: the function predates 042 (the call has no function to
         * resolve to — a server deployed ahead of the migration fails at the
         * first user delete, not at start), or the two-argument form was
         * re-created BESIDE 042's by a hand re-apply of 009 or 036 (every
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
            add("delete signature", "fail", "delete_thought is missing — the delete_thought tool calls it", ledgerRemedy("042", APPLY_042));
          } else if (current.length && extra.length === 0) {
            add("delete signature", "ok", `${current[0].sig}: the form the servers call since migration 042, alone`);
          } else if (current.length) {
            add("delete signature", "fail",
                `beside the form the servers call there ${extra.length === 1 ? "is an earlier one" : `are ${extra.length} earlier ones`}: ${extra.join(", ")} — 009 or 036 re-applied by hand over 042 — so every call that sends two arguments to delete_thought, which is every PostgREST caller by name from before this change and every hand-written SELECT, fails with "function is not unique"`,
                `Drop the earlier form, as 042 does: ${extra.map((sig) => `DROP FUNCTION ${sig};`).join(" ")}`);
          } else {
            add("delete signature", "fail",
                `${extra.join(" and ")} ${extra.length === 1 ? "is the form" : "are the forms"} from before migration 042; the server sends p_detach, which only 042's form takes — so every delete would fail`,
                ledgerRemedy("042", APPLY_042));
          }
        } catch (e) {
          add("delete signature", "warn", `could not verify: ${(e as Error).message}`, "The catalog read behind this check needs SELECT on pg_proc.");
        }

        /**
         * Every lock-order argument on this fork — 018's fingerprint lock,
         * 033's one order for the writers, 036's delete, 042's citation guard
         * — holds under READ COMMITTED, Postgres's default: a writer that
         * waits on a row lock re-reads the row the lock won. A connection whose
         * default is REPEATABLE READ or SERIALIZABLE (a role or database
         * setting, a pooler) reads its transaction's snapshot instead, and
         * 042's guard then cannot see a citation committed after that
         * snapshot — its source goes from under it. A warning, not a refusal:
         * the server still works, the guarantees named do not (third review
         * pass, SMD-1712).
         */
        try {
          const [{ level }] = (await sql`SELECT current_setting('default_transaction_isolation') AS level`) as { level: string }[];
          if (/^read (committed|uncommitted)$/i.test(level)) {
            add("transaction isolation", "ok", `default_transaction_isolation is ${level} — the level the writers' lock order (018/033/036) and the citation guard (042) are argued under`);
          } else {
            add("transaction isolation", "warn",
                `default_transaction_isolation is ${level}: the writers' lock order (018/033/036) and the citation guard (042) are argued under read committed — under ${level} a transaction reads its own snapshot, so a citation committed after it began is invisible to a delete of its source`,
                `Set the connection's default back: ALTER ROLE ${ident} SET default_transaction_isolation = 'read committed'; (or at the database or pooler where it was changed).`);
          }
        } catch (e) {
          add("transaction isolation", "warn", `could not verify: ${(e as Error).message}`);
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
            `Put it back: SELECT '[1]'::vector; ALTER FUNCTION ${mt[0]?.sig ?? "match_thoughts"} SET hnsw.iterative_scan = relaxed_order;  — a redefinition that dropped this clause dropped 019's, 040's and 041's too (the candidate scan check below says) — and carry them into the migration that redefined it.`;
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
         * So is 040's `SET jit = off` (SMD-1624): without it a planner path an
         * operator disables at any level — enable_tidscan, enable_nestloop,
         * hashagg with sort — adds disable_cost to the gate's sample on
         * PostgreSQL 14–17 and the executor JIT-compiles it on every filtered
         * call, ~50 ms, with the plan, the rows and the ledger unchanged (040's
         * header has the table; 18 counts disabled nodes instead, and there
         * the clause guards the generic plan's flat estimate). And 041's two
         * pins (SMD-1677, SMD-1703): without `enable_nestloop = on` an
         * operator's `enable_nestloop = off` reaches every join in the call —
         * merge and hash joins over the whole table, 1.3–2.2 s a call at a
         * million rows, the unfiltered call included, the walk's rows changed;
         * without `enable_tidscan = on` PostgreSQL 18 under `enable_tidscan =
         * off` gives the gate's probe no TID Range path and scans the whole
         * heap eight times a call (041's header has the tables). A WARNING:
         * every search still answers, at the seq scan's, the compiler's or
         * the whole-table join's cost.
         */
        try {
          if (catalog instanceof Error) throw catalog;
          const { mt, kwRows, ledger } = catalog;
          if (!mt.length) {
            add("candidate scan", "skip", "not checked — match_thoughts is not defined (filtered search says so)");
          } else {
            const seqOff = mt[0].settings["enable_seqscan"] === "off";
            const jitOff = mt[0].settings["jit"] === "off";
            // Each pin read on its own, so the warning names the one that is
            // missing — after the header's escape (`ALTER FUNCTION … RESET
            // enable_nestloop`) one is, and "both" would be false (review pass 1).
            const nestloopOn = mt[0].settings["enable_nestloop"] === "on";
            const tidscanOn = mt[0].settings["enable_tidscan"] === "on";
            const pinned = nestloopOn && tidscanOn;
            const rows = mt[0].rows;
            const kwOff = kwRows !== null && kwRows !== 25;
            const ledgerHas019 = ledger.has("019");
            const ledgerHas040 = ledger.has("040");
            const ledgerHas041 = ledger.has("041");
            // Whether THIS server would compile at all: Supabase's images are
            // built without LLVM JIT and its upgrades set jit = off, so there a
            // missing clause costs nothing today and the warning says so.
            const [{ jitOn }] = await sql`SELECT pg_jit_available() AND current_setting('jit') = 'on' AS "jitOn"`;
            const today = jitOn ? "" : " (not on this server today: it has no JIT, or its own jit is off — Supabase ships both; the clause is for a server that compiles)";
            const missing019 = !seqOff || rows !== 10 || kwOff;
            const mtMissing = !seqOff || rows !== 10 || !jitOff || !pinned;
            // match_thoughts' five clauses and its row estimate are restored by
            // its LAST definer, 041 — never by 019's file, whose CREATE is the
            // 4-argument form 020 dropped and would put a second overload beside
            // the shipped one on any brain past 020 (review pass 2) — named
            // while the ledger does not record 041, ALTERed once it does (a
            // plain run skips a recorded file). The keyword estimate is 019's
            // and 041 does not define that function, so its remedy is the ALTER
            // in either case, beside the file or in the Put-it-back list.
            const mtAlter = mtMissing ? `ALTER FUNCTION ${mt[0].sig}${seqOff ? "" : " SET enable_seqscan = off"}${jitOff ? "" : " SET jit = off"}${nestloopOn ? "" : " SET enable_nestloop = on"}${tidscanOn ? "" : " SET enable_tidscan = on"}${rows !== 10 ? " ROWS 10" : ""};` : "";
            const kwAlter = kwOff ? "ALTER FUNCTION search_thoughts_keyword(text, int, int, jsonb) ROWS 25;" : "";
            const remedy = mtMissing && !ledgerHas041
              ? `Apply db/migrations/041_match_thoughts_pin_paths.sql${!seqOff || rows !== 10 ? " — the last definer of match_thoughts, which carries 019's clauses and ROWS 10 with its own (019's file alone would re-create the 4-argument form 020 dropped)" : ""}.${kwOff ? ` Then put the keyword estimate back: SELECT '[1]'::vector; ${kwAlter}  and carry it into the migration that redefined that function.` : ""}`
              : `Put it back — after any re-apply of a migration body, since CREATE OR REPLACE resets these: SELECT '[1]'::vector; ${[mtAlter, kwAlter].filter(Boolean).join(" ")}  and carry them into the migration that redefined the function.`;
            const estimates = [
              ...(rows !== 10 ? [`match_thoughts' row estimate is ${rows} rather than 10`] : []),
              ...(kwOff ? [`search_thoughts_keyword's row estimate is ${kwRows} rather than 25`] : []),
            ];
            const jitNote = jitOff
              ? ""
              : `; and it does not carry jit = off${ledgerHas040 ? " although migration 040 is recorded as applied — a later redefinition dropped its SET clause" : " — migration 040 is not applied"}, so a planner path disabled at any level (enable_tidscan, enable_nestloop, hashagg with sort) JIT-compiles the gate's sample on every filtered call, ~50 ms, on PostgreSQL 14–17 (on 18 the clause guards the generic plan's flat estimate; 040's header has the table)${today}`;
            const missingPins = [...(nestloopOn ? [] : ["enable_nestloop = on"]), ...(tidscanOn ? [] : ["enable_tidscan = on"])].join(" and ");
            // One pin gone of two can only be a RESET — a redefinition drops both —
            // so that sentence leads with it (review pass 2, cut for space).
            const pinLedger = ledgerHas041
              ? (nestloopOn || tidscanOn
                ? " although migration 041 is recorded as applied — an ALTER FUNCTION … RESET took it off (a redefinition would have dropped both)"
                : " although migration 041 is recorded as applied — a later redefinition dropped them, or an ALTER FUNCTION … RESET took them off")
              : " — migration 041 is not applied";
            const pinWhy = [
              ...(nestloopOn ? [] : ["an operator's enable_nestloop = off at any level reaches every join in the call — the parent lookups and the walk's chunk join become merge and hash joins over the whole table, 1.3–2.2 s a call at a million rows, the unfiltered call included, and the walk's rows change"]),
              ...(tidscanOn ? [] : ["on PostgreSQL 18 enable_tidscan = off leaves the gate's probe no TID Range path, so every filtered call scans the whole heap eight times"]),
            ].join(" — and ") + " (041's header has the tables)";
            const pinNote = pinned ? "" : `; and it does not carry ${missingPins}${pinLedger}, so ${pinWhy}`;
            if (!missing019 && jitOff && pinned) {
              add("candidate scan", "ok", "match_thoughts declares enable_seqscan = off and ROWS 10, search_thoughts_keyword ROWS 25 (019), match_thoughts jit = off (040) and enable_nestloop = on with enable_tidscan = on (041): the candidate scan takes the HNSW indexes at the shipped width, callers plan against real row counts, no statement of the body is JIT-compiled, and the call's joins and the gate's probe keep their paths whatever the session sets");
            } else if (!seqOff) {
              add("candidate scan", "warn",
                  `match_thoughts does not carry enable_seqscan = off${ledgerHas019 ? " although migration 019 is recorded as applied — a later redefinition dropped its SET clause" : " — migration 019 is not applied"}${estimates.length ? `, and ${estimates.join(", and ")}` : ""} — so at the shipped width the planner seq-scans the chunk table on every search and both tables above the default count, on brains up to some tens of thousands of thoughts (019's header has the numbers)${jitNote}${pinNote}`,
                  remedy);
            } else if (estimates.length) {
              add("candidate scan", "warn",
                  `match_thoughts carries enable_seqscan = off but ${estimates.join(", and ")}${ledgerHas019 ? " — a redefinition reset what 019 declared" : " — migration 019 is not applied"}; every query composing the function is planned against that count (017's header records what a 1,000-row estimate cost)${jitNote}${pinNote}`,
                  remedy);
            } else if (!jitOff) {
              add("candidate scan", "warn",
                  `match_thoughts carries enable_seqscan = off and both row estimates hold, but not jit = off${ledgerHas040 ? " although migration 040 is recorded as applied — a later redefinition dropped its SET clause" : " — migration 040 is not applied"}: a planner path disabled at any level (enable_tidscan, enable_nestloop, hashagg with sort) JIT-compiles the gate's sample on every filtered call, ~50 ms, with the plan, the rows and the ledger unchanged, on PostgreSQL 14–17 (on 18 the clause guards the generic plan's flat estimate; 040's header has the table)${today}${pinNote}`,
                  remedy);
            } else {
              add("candidate scan", "warn",
                  `match_thoughts carries enable_seqscan = off, both row estimates hold and jit = off, but not ${missingPins}${pinLedger}: ${pinWhy}`,
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
              // consolidate.ts pools under another key. The judge's own knob
              // since SMD-1901, so the remedy leaves the extractor where it is.
              const model = /^(.+)@p\d+$/.exec(key.slice(CONSOLIDATE_KEY_PREFIX.length))?.[1];
              const envPrefix = model && model !== judgeModel ? `OB1_JUDGE_MODEL=${model} ` : "";
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

        // The ledger's highest migration against the tree this server was built
        // from (server-portable/version.ts, SMD-2041) — the judgement brain_info
        // makes. Behind is a brain this server's tools expect more of; ahead, a
        // brain a newer tree migrated. Both warn: each still serves.
        const tree = pad3(LATEST_MIGRATION);
        const hi = facts.highestMigration;
        const status = ledgerStatus(hi, LATEST_MIGRATION); // brain_info's rule, one definition
        if (!ledgerPresent)
          add("migration ledger", "warn", "no schema_migrations table — the schema was applied by hand",
              "Adopt it with: cd db && bun migrate.ts --url $DATABASE_URL --baseline");
        else if (!ledgerRead) {
          // A present ledger with no names always has its reason recorded:
          // every path in readDatabaseFacts that leaves them null writes it.
          const u = ledgerUnread!;
          if (u.reason === "refused")
            add("migration ledger", "ok", `schema_migrations present, not readable by this role (${u.message}) — this server's tree ends at ${tree}`);
          else if (u.reason === "invisible")
            add("migration ledger", "warn", `${u.message} — the ledger cannot be judged against this server's tree (${tree})`,
                u.message.includes("reaches")
                  ? "Put the ledger's schema ahead of the other schema_migrations on the server role's search_path (ALTER ROLE … SET search_path); --baseline would record the ledger a second time."
                  : "Put the ledger's schema on the server role's search_path (ALTER ROLE … SET search_path), or GRANT USAGE on it; --baseline would record the ledger a second time.");
          else
            add("migration ledger", "warn", `could not verify: schema_migrations could not be read (${u.message}) — this server's tree ends at ${tree}`,
                "A migration or a long transaction may hold the ledger; run preflight again once it has finished.");
        }
        else if (hi === null) add("migration ledger", "ok", `schema_migrations present, recording none — this server's tree ends at ${tree}`);
        else if (status === "behind")
          add("migration ledger", "warn", `the ledger reaches ${pad3(hi)} but this server's tree ends at ${tree} — the brain is behind the server it serves, and a tool that needs a later migration fails`,
              "Apply the pending migrations: cd db && bun migrate.ts --url $DATABASE_URL (--dry-run lists them).");
        else if (status === "ahead")
          add("migration ledger", "warn", `the ledger reaches ${pad3(hi)}, past this server's tree (${tree}) — a newer tree migrated this brain`,
              "Deploy the server built from the tree that migrated it, or confirm this older one is intended.");
        else add("migration ledger", "ok", `schema_migrations present, highest ${pad3(hi)} — this server's tree ends there too`);

        // The version the brain was migrated under (044, SMD-1804): schema_version
        // in ob1_config, reported beside the highest migration the ledger records.
        // The server carries its own FORK_VERSION (db/version.mjs). A mismatch is a
        // named warning, never a refusal — a brain and a server at different
        // releases still serve; the operator decides whether that is intended.
        try {
          // Dynamic import, as the config.mjs value reads above are: a static
          // value import of a .mjs trips noImplicitAny (TS7016) under this tsconfig.
          const { FORK_VERSION, semverCompare, readReleases, highestReleasedMigration } = await import("../db/version.mjs");
          const highestApplied = facts.highestMigration;
          const highest = highestApplied === null ? "unknown" : pad3(highestApplied);
          // ob1_config's schema_version, from `facts` (SMD-2041); a read it
          // could not make is this row's to report, as the read here once raised.
          if ("ob1_config" in facts.unread) throw new Error(facts.unread.ob1_config.message);
          const brain = facts.schemaVersion;
          if (!brain) {
            add("schema version", "warn",
              `ob1_config records no schema_version — this brain predates migration 044 (highest migration ${highest}); the server runs ${FORK_VERSION}`,
              "Apply the migrations: cd db && bun migrate.ts --url $DATABASE_URL — a plain run applies 044, or --reapply if the ledger already records it.");
          } else {
            const releasedHi = highestReleasedMigration(readReleases());
            // semverCompare ignores build metadata, so 0.0.0+upstream.<a> and
            // 0.0.0+upstream.<b> compare equal — a fresh brain at the baseline is ok.
            const cmp = semverCompare(FORK_VERSION, brain);
            if (cmp < 0) {
              add("schema version", "warn",
                `the brain is at ${brain} but this server is ${FORK_VERSION} — a server older than the brain it serves`,
                "Deploy the server for the brain's release (its tag names the server commit), or roll the brain back to a server that matches.");
            } else if (highestApplied !== null && releasedHi > 0 && highestApplied > releasedHi) {
              add("schema version", "warn",
                `the brain reports ${brain} but its ledger reaches migration ${highest}, past that release's range (…${pad3(releasedHi)}) — migrations applied beyond the version it names`,
                "Cut a release that closes the new range, or roll the extra migrations back; releases.json maps versions to ranges.");
            } else if (highestApplied === null && ledgerUnread && ledgerUnread.reason !== "refused") {
              // The range check needs the ledger's highest; a ledger held by a
              // migration, or off this role's path, is not "unknown and fine"
              // (review pass 3: a locked ledger turned this row's warning into ✓).
              // The remedy is the ledger row's, by why it is unread: a lock
              // passes, a ledger off the role's path does not (review pass 4:
              // "run it again" was given for both).
              add("schema version", "warn",
                `could not verify against the ledger: ${brain}, but ${whyUnread} — the release-range check needs its highest migration`,
                ledgerUnread.reason === "invisible"
                  ? "Fix the ledger's visibility as the migration ledger row says (the role's search_path, or USAGE on the ledger's schema), then run preflight again."
                  : ledgerUnread.reason === "timeout"
                    ? "A migration or a long transaction holds the ledger; run preflight again once it has finished."
                    : "See the migration ledger row for why the ledger could not be read.");
            } else {
              add("schema version", "ok", `${brain} · highest migration ${highest}${cmp > 0 ? ` (server ${FORK_VERSION} is newer)` : ""}`);
            }
          }
        } catch (e) {
          add("schema version", "warn", `could not verify: ${(e as Error).message}`,
              "The check reads ob1_config.schema_version and db/version.mjs.");
        }

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
            // Cite rows (SMD-1719) are logged only when 035's upsert_thought
            // answers `existed` — the store's affirmative "fresh row". On a
            // brain at 034 without 035 the log records opens and never a cite,
            // and a utilization report would read that as callers never citing.
            // Whether the body is 035's is the atomic-capture check's verdict,
            // read from the sentinel that body declares (threeArgIs035 above).
            const cites = threeArgIs035;
            add("query log", cites ? "ok" : "warn",
              `present; ${on ? "ON (OB1_QUERY_LOG=on) here" : "off by default — set OB1_QUERY_LOG=on to record"}. ` +
              (cites ? "" : "Cite rows (a write naming a returned id as its source, SMD-1719) need migration 035's upsert_thought and will NOT be logged on this brain — utilization would read as callers never citing (the `atomic capture` check above names the remedy). ") +
              `Logs each search and the fetch/edit/delete of a returned id, and a write that cites one (SMD-1719) (query text, arguments, returned ids — personal data at rest), read offline by evals/export-queries.ts and evals/eval-utilization.ts (which also joins the returned ids to thoughts content for a token estimate). ` +
              `Retention: prune_query_log(${days}); a self-hosted role needs query_log INSERT (db/README.md).`);
          }
        } catch (e) {
          add("query log", "warn", `could not verify: ${(e as Error).message}`, "The check reads to_regclass('public.query_log').");
        }

        // Which pipeline tier this brain is (SMD-1806): stable | canary | working.
        // The records ingester (db/ingest-records.ts) stamps ob1_config.tier and
        // .last_ingest on every rebuild; this reports them beside the schema
        // version. Never fatal — a plain brain has no tier — but it warns when the
        // running server's OB1_TIER disagrees with the stamped tier (a working
        // server pointed at the stable database), the failure the one-writer rule
        // exists to prevent.
        try {
          const rows = await sql`SELECT key, value FROM ob1_config WHERE key IN ('tier', 'last_ingest')`;
          const cfg = Object.fromEntries((rows as { key: string; value: string }[]).map((r) => [r.key, r.value]));
          const stamped = cfg.tier;
          const wantTier = (env as unknown as Record<string, string | undefined>).OB1_TIER?.trim() || undefined;
          const tierIssue = tierProblem(wantTier);
          if (tierIssue) {
            // A wrong OB1_TIER silently drops every query_log row (it fails 045's
            // CHECK and the best-effort write swallows it) — fatal, so the
            // container entrypoint (bun preflight.ts && …) refuses to serve
            // (SMD-1953). The server itself also refuses it in initEnv.
            add("tier", "fail", tierIssue, "Set OB1_TIER to stable, canary or working, or leave it unset (a plain brain).");
          } else if (!stamped) {
            add("tier", "skip", `no tier recorded — db/ingest-records.ts has not run against this brain${wantTier ? ` (server OB1_TIER=${wantTier})` : ""}. A plain brain, not a pipeline tier.`);
          } else {
            const ingest = cfg.last_ingest ? `, last ingest ${cfg.last_ingest}` : ", never ingested";
            if (wantTier && wantTier !== stamped) {
              add("tier", "warn", `the database is tier '${stamped}'${ingest}, but this server runs OB1_TIER=${wantTier} — a server pointed at another tier's database.`,
                "Point the server at its own tier's database, or set OB1_TIER to match. The tiers are one corpus read through three schemas with one writer (SMD-1806).");
            } else {
              add("tier", "ok", `${stamped}${ingest}`);
            }
          }
        } catch (e) {
          add("tier", "warn", `could not verify: ${(e as Error).message}`, "The check reads ob1_config.tier / last_ingest.");
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

// Two probes, one per endpoint, each in its own try: a chat base that is down
// fails the metadata row by its own name and leaves the embeddings row to say
// what it found, where one try around both reported every chat failure as the
// embedding provider's (SMD-1902). Each sends exactly what the server sends —
// the endpoint's own headers, and for embeddings the `dimensions` parameter
// when the server would — so a pass here is a pass for the first capture.

if (!deep) {
  add("embedding provider", "skip", "not checked — pass --deep to call the provider");
} else if (!embEndpoint.key && !localEmbeddings) {
  add("embedding provider", "skip", "no credential to test with");
} else {
  try {
    const { resolveEmbeddingDimensions: resolveDims } = await import("../db/config.mjs");
    const wantsTruncation = resolveDims(env.OB1_EMBEDDING_DIMENSIONS, embDim, embModel);
    const r = await fetch(`${embEndpoint.base}/embeddings`, {
      method: "POST",
      headers: embEndpoint.headers,
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
      add("embedding provider", "fail", `${embEndpoint.base} returned ${r.status}`,
          r.status === 401 ? "The key is rejected. Check OB1_LLM_API_KEY (or OPENROUTER_API_KEY)." : "Check the provider's status and credit balance.");
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
    }
  } catch (e) {
    add("embedding provider", "fail", (e as Error).message, `Network reachability to ${hostOf(embEndpoint.base)}.`);
  }
}

if (deep) {
  // Both chat models need JSON mode — extraction and the judge each parse the
  // reply as an object — so each is probed under its own row when they differ,
  // and a judge model the endpoint does not serve fails the `judge model` row
  // rather than the first pass of db/consolidate.ts (SMD-1901). One model,
  // one probe: the two rows would otherwise report one call twice.
  const probes: [row: string, model: string, consequence: string][] = [
    ["metadata model", metaModel, "Capture would still succeed, but every thought would be tagged uncategorized."],
    ...(judgeModel !== metaModel
      ? [["judge model", judgeModel, "Capture is unaffected; db/consolidate.ts would fail every pair it judges."] as [string, string, string]]
      : []),
  ];
  for (const [row, model, consequence] of probes) {
    if (!chatEndpoint.key && !localChat) {
      add(row, "skip", `no credential to test ${chatEndpoint.base} with`);
      continue;
    }
    try {
      // Both callers parse the reply as JSON. Providers differ here — Ollama's
      // OpenAI layer has been inconsistent about response_format — and one that
      // ignores it degrades every capture to "uncategorized", or fails every
      // pair the judge is shown, without ever failing a request.
      const m = await fetch(`${chatEndpoint.base}/chat/completions`, {
        method: "POST",
        headers: chatEndpoint.headers,
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: 'Reply with only this JSON: {"ok":true}' }],
        }),
      });
      if (!m.ok) {
        add(row, "fail", `${model} returned ${m.status} from ${chatEndpoint.base}`,
            (m.status === 401 ? `The key is rejected. Check ${chatIsOwn ? "OB1_CHAT_API_KEY" : "OB1_LLM_API_KEY (or OPENROUTER_API_KEY)"}. ` : "") + consequence);
      } else {
        const md = (await m.json()) as { choices?: [{ message?: { content?: string } }] };
        const content = md.choices?.[0]?.message?.content ?? "";
        try {
          const parsed = JSON.parse(content);
          add(row, typeof parsed === "object" && parsed !== null ? "ok" : "warn",
              typeof parsed === "object" && parsed !== null
                ? `${model} honours JSON mode at ${chatEndpoint.base}`
                : `${model} returned JSON that is not an object`);
        } catch {
          add(row, "warn", `${model} did not return parseable JSON in JSON mode`, consequence);
        }
      }
    } catch (e) {
      add(row, "fail", `${model} at ${chatEndpoint.base}: ${(e as Error).message}`,
          `Network reachability to ${hostOf(chatEndpoint.base)}. ${consequence}`);
    }
  }
}

// ── Optional: the typed-decision tier (SMD-2050) ─────────────────────────────

// Off unless OB1_JEV_BASE_URL is set. Set, the tier is dialled on every run,
// not only under --deep: GET /info sends no text and costs no model call, and
// a wrong or unreachable URL then fails here rather than at the first spike's
// first decision. --deep also makes one decision, through the client and its
// egress gate, and checks the answer's shape.
const jevCfg = resolveJevConfig(env);
if (!jevCfg) {
  add("jev tier", "skip", "OB1_JEV_BASE_URL is unset — the typed-decision tier is off (nothing the server does needs it)");
} else {
  // SMD-1875's rules for a probed endpoint, followed here (the merge review):
  // the base shown masked, since this row runs on every start; the name
  // resolved before it is dialled; the failure in probeFailure's words.
  const base = jevCfg.endpoint.base;
  const at = maskUrl(base);
  const masked = (message: string) => message.split(base).join(at);
  const START = "Start it — compose --profile jev, reached as http://jev:8020, or bun jev/serve.ts on the host, reached as http://127.0.0.1:8020 from a checkout and from a container as http://host.containers.internal:8020 under podman machine or http://host.docker.internal:8020 under Docker Desktop (serve.ts binds loopback, which rootless podman and Docker on Linux do not reach: the profile is the route there) — fix OB1_JEV_BASE_URL, or unset it to turn the tier off.";
  const host = hostnameOf(base);
  // The stack's own service name resolves only while the service runs: the
  // profile is down, or `compose restart server` ran — which does not start
  // what the server depends on (fifth review pass: ~5 restarts a second).
  const NOT_RUNNING = "The jev service is not running: bring the profile up — compose --profile jev up -d (compose restart server does not start it) — or unset OB1_JEV_BASE_URL to turn the tier off.";
  // It resolves and answers nothing: it runs but does not listen yet — it
  // listens only after the fetch and the load, ~20 s on a first start — or is
  // restarting, or the port is not its 8020 (sixth review pass: the
  // not-running remedy was given here too, and dropped "fix the URL").
  const NOT_LISTENING = "The jev service is up but not listening: on a first start it fetches the weights (~20 s) before it listens — compose ps shows its health — or it is restarting (compose logs jev), or OB1_JEV_BASE_URL's port is not the service's 8020.";
  const unresolved = await resolveFirst(host);
  if (unresolved) {
    add("jev tier", "fail", `nothing answers at ${at} — ${unresolved.why} (GET /info, ${LOCAL_PROBE_SECONDS} timeout)`, host === "jev" ? NOT_RUNNING : START);
  } else try {
    const info = await jevInfo(jevCfg, { timeoutMs: LOCAL_PROBE_TIMEOUT_MS });
    const pins = `${info.model.name} (${info.model.source}@${info.model.revision.slice(0, 8)}, weights ${info.model.weights_sha256.slice(0, 12)}…)`;
    if (jevCfg.model && info.model.name !== jevCfg.model) {
      add("jev tier", "fail", `${at} serves ${pins}, and OB1_JEV_MODEL expects ${jevCfg.model}`,
          `Point OB1_JEV_BASE_URL at the tier serving ${jevCfg.model}, or set OB1_JEV_MODEL=${info.model.name}.`);
    } else {
      add("jev tier", "ok", `${at} serves ${pins} — ${info.contract}, ${info.kinds.join(" and ")} decisions, up to ${info.max_options} options, ${info.max_tokens} tokens${jevCfg.model ? " (OB1_JEV_MODEL)" : ""}`);
    }
  } catch (e) {
    // Four answers, worded as the provider rows word them (fifth review pass):
    // something answered but not as the tier (a status, a redirect, a body
    // outside the contract — often a base with Ollama's /v1 on it); it
    // answered with a certificate this runtime does not trust (the tier
    // serves plain http); nothing answered; and in each, a proxy variable
    // that routes the call is named, since podman forwards the host's.
    const err = e as Error & { kind?: string };
    const failure = err.kind ? null : probeFailure(e); // the connection's own failure, when the client did not name one
    // An exempt host is dialled direct: the proxy is then not the route, and
    // not the fix (proxyKnobFor, by Bun's NO_PROXY rule).
    const proxy = proxyKnobFor(base);
    const route = proxy ? `; ${proxy} is set, so this call goes through that proxy unless NO_PROXY names ${host}` : "";
    const viaProxy = proxy ? `Add ${host} to NO_PROXY (and no_proxy) for the server, or unset ${proxy} for it. Otherwise: ` : "";
    if (err.kind === "http" || err.kind === "body") {
      add("jev tier", "fail", `${at} answers, but not as the tier: ${masked(err.message)}${route}`,
          `${viaProxy}Check OB1_JEV_BASE_URL is the tier's base with no path — its routes are /health, /info and /decide (not Ollama's /v1) — and that it names the jev service, not another.`);
    } else if (failure?.kind === "tls") {
      add("jev tier", "fail", `${at} answers, but ${failure.why}${route}`,
          `${viaProxy}The tier serves plain http: use http:// in OB1_JEV_BASE_URL, or trust the issuer of whatever terminates TLS in front of it for the server (NODE_EXTRA_CA_CERTS=<ca.pem>).`);
    } else {
      const why = failure ? failure.why : `no HTTP answer in ${LOCAL_PROBE_SECONDS}`;
      add("jev tier", "fail", `nothing answers at ${at} — ${why} (GET /info, ${LOCAL_PROBE_SECONDS} timeout)${route}`, viaProxy + (host === "jev" ? NOT_LISTENING : START));
    }
  }
  egressRow("jev egress", jevCfg.endpoint, "OB1_JEV_LOCAL", "decision",
            "every decision a spike asks for is refused before it is sent (a ProviderError of kind egress)");
  if (!deep) {
    add("jev decision", "skip", "not checked — pass --deep to make one decision");
  } else if (!results.some((r) => r.name === "jev tier" && r.status === "ok")) {
    add("jev decision", "skip", "not checked — the jev tier row failed");
  } else {
    try {
      const t0 = performance.now();
      const probe = await jevDecide(jevCfg, { proposition: "the note is about a preflight check", context: "preflight: checking that the decision tier answers" }, { kind: "decision", actor: "preflight" });
      add("jev decision", "ok", `one binary decision in ${(performance.now() - t0).toFixed(0)} ms: p ${probe.p === null ? "null" : probe.p.toFixed(3)}, insufficient ${probe.pInsufficient.toFixed(3)}, temperature ${probe.result.temperature} — the answer is a distribution over the decision's options`);
    } catch (e) {
      const err = e as Error & { kind?: string };
      add("jev decision", err.kind === "egress" ? "warn" : "fail", masked(err.message),
          err.kind === "egress" ? "See the jev egress row." : "The tier answered /info but not /decide in the contract's shape — check its log.");
    }
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
