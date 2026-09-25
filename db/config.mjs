/**
 * config.mjs — the embedding contract, in one place.
 *
 * The vector column's width and the model that fills it must agree, and neither
 * can be changed later without re-embedding every row. Declaring both here — and
 * recording the choice in the database — means a mismatch is caught at deploy
 * rather than discovered as bad search results.
 *
 * Both are read from the environment so they can be chosen ONCE, before there is
 * any data. After the first captures, changing them means a schema migration plus
 * a full re-embed.
 */

/** Width of the `thoughts.embedding` column. */
/**
 * Environment access that survives Cloudflare Workers, which has no `process`.
 * This module is imported by server-portable/embed.ts, which index.ts bundles for Workers,
 * so a bare `process.env` at module scope would throw at load. The values below
 * are defaults only; the server reads live configuration through its own lazy
 * `env()` so Workers bindings still apply.
 */
const RAW_ENV = /** @type {Record<string, string|undefined>} */ (
  globalThis.process?.env ?? {}
);

/**
 * An empty variable means unset, not "", and whitespace around a value is not
 * part of it — the server trims its own reads the same way (embed.ts stringOr),
 * so a quoted `"qwen3-embedding:4b "` in deploy/.env is one model name to the
 * migrator that records it and the server that checks the record (SMD-1843).
 *
 * `??` only catches undefined, so `OB1_EMBEDDING_DIM=` — trivially produced by a
 * blank line in a .env file or a compose `${VAR}` that resolves to nothing — gave
 * `Number("") === 0` and a config refused as "must be a positive integer, got 0".
 * server-portable/index.ts already treated empty as unset because it tests
 * truthiness, so the two disagreed about the same environment: the server would
 * run at the default width while the migration runner refused to start.
 */
/**
 * The same rule for a whole environment record: every string value trimmed,
 * everything else as it was. server-portable/index.ts applies it once in
 * initEnv and preflight.ts once to process.env, so a quoted `"sk-abc "` in
 * deploy/.env is the key and not the key plus a space — for all nineteen
 * declared knobs at once, not one reader at a time (SMD-1843, eighth pass).
 * "" stays "": every reader already treats it as unset.
 *
 * @param {Record<string, unknown>} record
 * @returns {Record<string, unknown>}
 */
export function trimmedEnv(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

/**
 * The pipeline tiers (SMD-1806): the three brains one corpus is read through.
 * Migration 045's `query_log.tier` CHECK and db/ingest-records.ts's `TIERS`
 * mirror this — it is the one source the server (initEnv) and preflight validate
 * OB1_TIER against, so a wrong value is caught at one place, not four.
 */
export const PIPELINE_TIERS = Object.freeze(["stable", "canary", "working"]);

/**
 * Validate an OB1_TIER value, returning a problem string or null when it is fine:
 * unset/empty (a plain brain) or exactly one of PIPELINE_TIERS. Fail-fast and
 * exact — "Stable" or "prod" is a problem, NOT silently lowercased. The reason it
 * cannot be lenient: a tier that fails migration 045's CHECK makes the best-effort
 * query_log write throw, the write swallows it, and every query_log row is
 * silently dropped — emptying SMD-1806's canary replay (SMD-1953). The env is
 * already trimmed (trimmedEnv), so this does not re-trim: a value with surrounding
 * space reaching here is itself the problem.
 * @param {string | undefined} raw
 * @returns {string | null}
 */
export function tierProblem(raw) {
  if (raw === undefined || raw === "") return null;
  if (PIPELINE_TIERS.includes(raw)) return null;
  return `OB1_TIER is ${JSON.stringify(raw)}, which is not a pipeline tier — set it to one of ${PIPELINE_TIERS.join(", ")}, or leave it unset for a plain brain. An unrecognised tier fails migration 045's query_log.tier CHECK, and because the log write is best-effort every query_log row is then silently dropped (SMD-1953).`;
}

const ENV = new Proxy(/** @type {Record<string, string|undefined>} */ ({}), {
  get: (_t, k) => {
    const v = RAW_ENV[/** @type {string} */ (k)];
    const t = typeof v === "string" ? v.trim() : v;
    return t === "" ? undefined : t;
  },
});

/**
 * Defaults, exported so server-portable/embed.ts uses these exact values rather
 * than its own copy. They drifted before; one definition cannot.
 *
 * `qwen3-embedding:4b` at 1024 dimensions is the best configuration measured on
 * real data — **0.903 MRR against `embeddinggemma`'s 0.873** over 441 Linear
 * issues with full descriptions and comment threads — and the only local model
 * that embeds a long capture whole. It is 2560 dimensions natively, so it relies
 * on Matryoshka truncation to fit under pgvector's 2000-dimension HNSW ceiling.
 *
 * Those numbers replace an earlier 0.933/0.914 measured over 97 issues that had
 * been silently truncated to ~500 characters at ingestion. The ranking survived
 * the correction, which is what matters for this default.
 *
 * The margin did not grow, and an earlier version of this comment said it had.
 * Eighteen of the 441 documents are under 120 characters — three of them are 3,
 * 15 and 21 characters — and a body that short cannot encode its own title, so
 * those queries are unanswerable by construction. Excluding them (423 documents)
 * gives 0.914 against 0.894: a gap of 0.020, statistically indistinguishable from
 * the 0.019 measured on the truncated corpus. The apparent doubling to 0.030 was
 * an artifact of degenerate rows, which `embeddinggemma` happened to handle worse.
 *
 * So the "embeds a long capture whole" advantage remains an argument from
 * architecture, NOT something these measurements demonstrate.
 *
 * The cost did not survive intact. It is 2.5 GB, and the latency multiple is
 * **about 5x, not the 3x recorded here before**: 109.6s against 22.4s to embed
 * the same 441 documents. The old figure was measured on 500-character stubs, and
 * the penalty grows with document length. See evals/README.md; SETUP.md lists the
 * cheaper alternatives.
 */
export const DEFAULT_EMBEDDING_MODEL = "qwen3-embedding:4b";
export const DEFAULT_EMBEDDING_DIM = 1024;

/**
 * Ollama, because the model defaults are local. These three move together or not
 * at all: pointing local model names at OpenRouter produces a 404 per capture, and
 * the embedding one is fatal rather than degraded. Overriding the provider means
 * overriding the models too, which SETUP.md says and
 * scripts/check-fork-consistency.ts enforces.
 */
export const DEFAULT_LLM_BASE_URL = "http://127.0.0.1:11434/v1";

export const EMBEDDING_DIM = Number(ENV.OB1_EMBEDDING_DIM ?? DEFAULT_EMBEDDING_DIM);

/** The model that must produce exactly EMBEDDING_DIM numbers. */
export const EMBEDDING_MODEL = ENV.OB1_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;

/** Metadata extraction. No schema dependency, so safe to change at any time. */
/**
 * Paired with DEFAULT_EMBEDDING_MODEL deliberately. Once the embedding default
 * became local, leaving this hosted made the shipped pair incoherent: pointed at
 * Ollama, every capture logged a 404 for `openai/gpt-4o-mini` and stored a thought
 * with no topics, people or type. The server degrades rather than failing, so it
 * was quiet — which is exactly the kind of quiet this fork keeps removing.
 *
 * NOT the top scorer, and the asymmetry with the embedding default is deliberate.
 * qwen3.8:27b is the only model to score a perfect 84/84, at 3.5s per capture and
 * 18 GB. qwen2.5:7b scores 81/84 at 1.4s and 4.7 GB, with the same zero structural
 * failures — the missing three points are field-level accuracy, not invented
 * people or empty topics.
 *
 * Why pay for the best embedding model but not the best extraction model:
 *
 *   The embedding choice is PERMANENT. Its width is baked into the column, so
 *   changing it means a migration and re-embedding every row. This one has no
 *   schema dependency and can be swapped between two captures, so overpaying up
 *   front buys much less.
 *
 *   Retrieval is the product. A weak embedding means a thought cannot be found;
 *   weak extraction means list_thoughts filters and thought_stats tallies are a
 *   little worse.
 *
 *   18 GB resident is the cost that disqualified the rerank tier (see
 *   evals/README.md). Defaulting to it here would take the shipped footprint from
 *   7.2 GB to 20.5 GB for three points on a secondary signal.
 *
 * Set OB1_METADATA_MODEL=qwen3.8:27b if you want the perfect score and can afford
 * the memory; nothing needs re-embedding when you change your mind.
 */
export const DEFAULT_METADATA_MODEL = "qwen2.5:7b";
export const METADATA_MODEL = ENV.OB1_METADATA_MODEL ?? DEFAULT_METADATA_MODEL;
// Trailing slashes off, and a value that was slashes alone is unset — the rule
// server-portable/embed.ts's baseUrlOr applies (SMD-1843).
export const LLM_BASE_URL = (ENV.OB1_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "") || DEFAULT_LLM_BASE_URL.replace(/\/+$/, "");

/** Widths pgvector supports for an HNSW index. Beyond this, indexing fails. */
export const MAX_HNSW_DIM = 2000;

/** Known model widths, so an obvious mismatch is caught without a network call. */
/**
 * Native output width per model, used to catch a configuration mistake before it
 * becomes a schema you cannot change.
 *
 * Provenance matters here, because a WRONG entry is worse than a missing one — it
 * produces a confident error against a correct config. Every local entry below was
 * verified against a live Ollama by requesting an embedding and counting the
 * numbers. Hosted entries are marked with how they are known; two earlier entries
 * (`voyage/voyage-3`, `mistral/mistral-embed`) were removed because those model IDs
 * do not exist on OpenRouter at all — checked against its public model list, which
 * needs no key: `curl https://openrouter.ai/api/v1/embeddings/models`.
 */
export const KNOWN_MODEL_DIMS = {
  // ── Hosted, from provider documentation. Not verified here: no key. ─────────
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,   // exceeds MAX_HNSW_DIM — truncate or no index
  "openai/text-embedding-ada-002": 1536,
  "mistralai/mistral-embed-2312": 1024,    // width stated in OpenRouter's own listing

  // ── Hosted, but the same open weights measured locally below, so the width
  //    carries over. IDs confirmed against OpenRouter's public listing. ────────
  "qwen/qwen3-embedding-4b": 2560,
  "qwen/qwen3-embedding-8b": 4096,
  "baai/bge-m3": 1024,

  // ── Local via Ollama. Every width below was MEASURED, not read off a card,
  //    and the retrieval scores behind the recommendations are in evals/. ──────
  embeddinggemma: 768,
  "nomic-embed-text": 768,
  "nomic-embed-text-v2-moe": 768,
  "bge-m3": 1024,
  "bge-large": 1024,
  "snowflake-arctic-embed2": 1024,
  "mxbai-embed-large": 1024,
  "granite-embedding": 384,
  "all-minilm": 384,
  "qwen3-embedding:0.6b": 1024,
  "qwen3-embedding:4b": 2560,              // exceeds MAX_HNSW_DIM — needs truncation
  "qwen3-embedding:8b": 4096,              // likewise
};

/**
 * Tokens a provider embeds in one request before cutting the rest silently —
 * the window the chunk limit is derived from (SMD-1305).
 *
 * Measured, not read off a card, because the card is wrong in both directions
 * (evals/README.md, "Ollama caps embeddings at 2048 tokens by default"):
 * Ollama's default batch cuts `bge-m3` at 2048 although it advertises 8192, and
 * `qwen3-embedding` embeds 18,919 tokens whole — the longest LongMemEval
 * session, `prompt_eval_count` checked — although its manifest sets no batch at
 * all. Each local entry is what `/api/embed` reported as `prompt_eval_count`
 * for a document longer than it, or the served context where a document that
 * long went through whole. A model rebuilt past its default with a Modelfile
 * (`PARAMETER num_batch 8192`) has another name and is not here: set
 * OB1_CHUNK_TOKENS for it, or add the entry once it is measured. Hosted models
 * are deliberately absent (first review pass): a provider's document states
 * the MODEL's maximum input, not what the serving provider behind an
 * OpenRouter route admits, and this fork has no key to measure with. A WRONG
 * entry here truncates windows silently, which is the failure the windows
 * exist to prevent, so a model that is not measured is not listed — it keeps
 * the fallback, which is exactly what it had.
 */
export const KNOWN_MODEL_WINDOW = {
  // ── Local via Ollama, at each model's default parameters. ───────────────────
  embeddinggemma: 2048,                    // prompt_eval_count 2048 on a 4K and on an 8K document
  "nomic-embed-text": 2048,                // card says 8192; served at 2048, at chance on a 4K document
  "bge-m3": 2048,                          // card says 8192; the default batch cuts at 2048
  "snowflake-arctic-embed2": 2048,         // likewise
  "granite-embedding": 512,                // prompt_eval_count 512 — a 1200-token window was cut here
  "qwen3-embedding:0.6b": 32768,           // served context; 18,919 tokens embedded whole
  "qwen3-embedding:4b": 40960,             // served context; 18,919 tokens embedded whole
};

/**
 * Ollama's default batch: the window the shipped chunk limit was set under.
 * The limit-to-window ratio it fixes (1200 of 2048) is the headroom the
 * tokenless estimate in server-portable/chunk.ts needs, and a known model's
 * threshold — and, for a smaller window, its window size — is derived at the
 * same ratio of its own window.
 */
export const DEFAULT_MODEL_WINDOW = 2048;

/**
 * The longest capture a whole vector alone was measured to hold, in chunk.ts's
 * estimated tokens: the length a derived rule windows above, whatever the
 * window. The estimate under-counts scripts without spaces (evals/README.md,
 * the caveats; SMD-1314), so in real tokens the cap sits higher there. Measured on LongMemEval-S under both qwen3-embedding models
 * (evals/README.md, SMD-1305): with the whole vector alone, strict recall held
 * within half a point of best-of-whole-and-windows for every question whose
 * longest gold session was under 4096 estimated tokens, and fell 1.8 (4b) and
 * 3.6 (0.6b) points above it. So a model with a 40,960-token window embeds a
 * 3,000-token capture whole and still windows a 5,000-token one — at 1200 a
 * window, the shipped size, because 4096-token windows over those same
 * sessions were measured to buy nothing (88.7% strict recall@5 with them or
 * without) where 1200-token ones bought 0.9 points.
 */
export const MAX_WHOLE_TOKENS = 4096;

/**
 * How a model's captures are windowed: `threshold`, the estimated length a
 * capture is windowed above, and `tokens`, the size of each window. Both are
 * OB1_CHUNK_TOKENS when it is set to a positive number, as before SMD-1305.
 * Otherwise a model in KNOWN_MODEL_WINDOW derives them from its window at the
 * shipped ratio (1200 of 2048): the window size never above `fallback`, the
 * threshold never above MAX_WHOLE_TOKENS — so a 2048-token model gets 1200 and
 * 1200 as it always did, a 512-token model gets 300 and 300 where 1200 cut its
 * windows, and the default model windows above 4096 at 1200. A model the table
 * does not know gets `fallback` for both (server-portable/chunk.ts's
 * DEFAULT_MAX_TOKENS, passed in because this file cannot import it under
 * Node). One rule for the server, reembed.ts and preflight, which names the
 * source it reports; `capped` says the threshold stopped at MAX_WHOLE_TOKENS.
 *
 * Empty, non-numeric and non-positive mean unset, as every numeric variable
 * server-portable/embed.ts reads (deploy/compose.yaml forwards `${VAR:-}`).
 */
export function resolveChunkTokens(raw, model, fallback) {
  const n = raw ? Number(raw) : NaN;
  // Exact name first; then the name without its Ollama tag (`granite-embedding:278m`
  // → `granite-embedding`), because a miss here is not harmless as it is for
  // KNOWN_MODEL_DIMS: a 512-token model that misses the table keeps 1200-token
  // windows and has them cut silently. A tag that names a different window is a
  // different entry (`qwen3-embedding:0.6b`, `:4b`); a base that is not listed
  // stays unlisted (second review pass).
  const window = KNOWN_MODEL_WINDOW[model] ?? KNOWN_MODEL_WINDOW[model.replace(/:[^:]*$/, "")];
  if (Number.isFinite(n) && n > 0) return { tokens: n, threshold: n, from: "OB1_CHUNK_TOKENS", window, capped: false };
  if (window === undefined) return { tokens: fallback, threshold: fallback, from: "default", window, capped: false };
  const atRatio = Math.floor((window * fallback) / DEFAULT_MODEL_WINDOW);
  return { tokens: Math.min(atRatio, fallback), threshold: Math.min(atRatio, MAX_WHOLE_TOKENS), from: "window", window, capped: atRatio > MAX_WHOLE_TOKENS };
}

/**
 * Served context of the CHAT models the extraction pass runs on, in tokens —
 * the window `resolveExtractWindow` sizes an extraction call to (SMD-1879).
 * Not KNOWN_MODEL_WINDOW: that table is what an EMBEDDING model embeds in one
 * request, and the extraction and embedding models differ, so the limit is a
 * property of the metadata model, not of the pipeline. Measured, as that table
 * is: each local entry is the context Ollama reports serving the model at
 * (`/api/ps` context_length) at its default parameters, confirmed by a prompt
 * longer than the previous default going through whole (`usage.prompt_tokens`
 * 14,432 for `qwen2.5:7b`, Ollama 0.33) — a card's trained length says what
 * the weights can do, not what the server admits, and an older Ollama served
 * every model at 2,048 by default. A model rebuilt with a Modelfile has
 * another name and is not here: set OB1_EXTRACT_CHUNK_TOKENS for it. Hosted
 * models are absent until measured, for the reason KNOWN_MODEL_WINDOW gives.
 */
export const KNOWN_CHAT_MODEL_WINDOW = {
  // ── Local via Ollama 0.33, at each model's default parameters. ─────────────
  "qwen2.5:7b": 32768,                     // /api/ps context_length; a 14,432-token prompt evaluated whole
  "qwen3.8:27b": 262144,                   // /api/ps context_length while extracting the p2 residue (SMD-1879)
};

/**
 * What an extraction call costs beyond the thought's text, and what its answer
 * may cost, so a window fits a served context with room for both (SMD-1879).
 *
 * EXTRACT_PROMPT_TOKENS is the rules and the delimiter with an empty thought,
 * as the qwen2.5 tokeniser counts them (`usage.prompt_tokens` 398). The answer
 * grows with the text, but not only with the text: on the fork's own brain,
 * 262 thoughts `qwen2.5:7b` extracted averaged 0.48 answer tokens per
 * estimated input token (25 tokens per entity or edge row, compact JSON) with
 * a 95th percentile of 1.6 — and `qwen3.8:27b`, asked the same of four short,
 * dense notes it then extracted correctly, answered at 3.5 to 9.4 times the
 * input (659 tokens for a 70-token note, 2,301 for a 525-token one), in
 * pretty-printed JSON 1.6× the compact size. A budget of twice the text plus
 * 256 — the first cut, sized to the 7B — cut every one of those answers and
 * read them as runaways. So the budget is three times the text plus a floor
 * of 1,536: over every legitimate answer measured on both models, and still a
 * bound — a runaway on the 7B ends at it in a minute or so rather than at the
 * context's end and the worker's timeout (evals/README.md, "Entity extraction
 * in windows", the second model).
 */
export const EXTRACT_PROMPT_TOKENS = 398;
export const EXTRACT_OUTPUT_RATIO = 3;
export const EXTRACT_OUTPUT_FLOOR = 1536;
/** What a window carries inside the delimiter besides the text: the `[Part i of n …]` marker (~12 tokens) and, with EXTRACT_WINDOW_HEADER on, the note's first 200 characters (~50) — reserved whether or not the header is on, so the arithmetic holds for both (third review pass). */
export const EXTRACT_MARKER_TOKENS = 80;

/**
 * The most thought text one extraction call can carry in a served context of
 * `window` tokens with everything the call requests beside it: the rules, the
 * part marker, and the answer budget for that much text —
 * `(window − rules − marker − floor) / (1 + ratio)`. One function for the
 * resolver, preflight's warning and its "fewer than N tokens" hint (first
 * review pass: the three had the arithmetic each, and all three omitted the
 * floor and the marker, so the value preflight recommended requested
 * window + 280 tokens of a `window`-token context).
 */
export function extractWindowThatFits(window) {
  return Math.floor((window - EXTRACT_PROMPT_TOKENS - EXTRACT_MARKER_TOKENS - EXTRACT_OUTPUT_FLOOR) / (1 + EXTRACT_OUTPUT_RATIO));
}

/** The served context a window of `tokens` needs: the inverse of extractWindowThatFits. */
export function extractContextNeeded(tokens) {
  return EXTRACT_PROMPT_TOKENS + EXTRACT_MARKER_TOKENS + EXTRACT_OUTPUT_FLOOR + tokens * (1 + EXTRACT_OUTPUT_RATIO);
}

/**
 * Whether a window after a thought's first carries the thought's opening line
 * (server-portable/entities.ts, documentHeader): the contextual-retrieval
 * pattern SMD-951 measured mixed for embeddings, applied to extraction where
 * the loss it addresses is a relation whose subject a later window names only
 * as "the project". Decided by measurement — evals/README.md, "Entity
 * extraction in windows" — not by intuition, and not a knob: one rule for the
 * worker and the eval, so the graph a pass writes is the one the eval scored.
 */
export const EXTRACT_WINDOW_HEADER = false;

/**
 * Whether an extraction call that ran to its answer budget is made once more
 * with a frequency penalty (server-portable/entities.ts, RUNAWAY_PENALTY).
 * The runaways measured for SMD-1879 are repetition; the penalty taxes it, and
 * it is the one lever that reached the thoughts a single call could not
 * finish at any window: on the 32 stragglers, one call extracted 2, windows
 * of 1200 tokens 10, of 600 tokens 13, and one call with this retry 27 —
 * at the cost of a thinner answer on the retried call (the penalty taxes
 * the JSON's repeated keys too; evals/README.md has the counts). On, and not
 * a knob, for the reason the header is not: the eval scored this shape.
 */
export const EXTRACT_RETRY_RUNAWAY = true;

/**
 * Whether an extraction call's answer is streamed and aborted the moment it
 * is a runaway — RUNAWAY_REPEATS copies of one item (server-portable/entities.ts,
 * RunawayDetector) — rather than read whole once it has run to its budget
 * (SMD-1960). The budget stays the bound and this is the early exit: a call
 * aborted so is a runaway, and is retried as a cut one is. On, and not a knob,
 * as the retry is not: measured in evals/README.md.
 */
export const EXTRACT_STREAM_ABORT = true;

/** `max_tokens` for an extraction call over `inputTokens` estimated tokens of thought text. */
export function extractOutputBudget(inputTokens) {
  return Math.ceil(inputTokens * EXTRACT_OUTPUT_RATIO) + EXTRACT_OUTPUT_FLOOR;
}

/**
 * How many estimated tokens of thought text one extraction call carries, for
 * the metadata model (SMD-1879): OB1_EXTRACT_CHUNK_TOKENS when it is set to a
 * positive number; otherwise, for a model in KNOWN_CHAT_MODEL_WINDOW, what its
 * served context holds beside the rules, the part marker and an answer at the
 * output ratio (extractWindowThatFits) — never above `fallback`, the window
 * measured to extract reliably (chunk.ts's DEFAULT_EXTRACT_WINDOW_TOKENS,
 * passed in because this file cannot import it under Node); a model the table
 * does not know gets `fallback`. So a 32,768-token model derives the fallback
 * (its context would hold 7,688 and the cap holds it to what the model was
 * measured to finish), a 4,096-token one 520, where the fallback's text plus
 * its answer would not fit, and a 2,048-token one holds no window at all
 * (`unfit`: the rules, the reserve and the answer floor leave 34 tokens). One
 * rule for the worker, the evals and preflight, which names the source it
 * reports; `capped` says the context would have allowed more. Not the
 * embedding rule (resolveChunkTokens): the two models differ, and so do the two
 * costs — an embedding has no answer to budget for.
 *
 * Empty, non-numeric and non-positive mean unset, as every numeric variable
 * server-portable/embed.ts reads (deploy/compose.yaml forwards `${VAR:-}`).
 */
/** The smallest window a served context is derived into; below it the context cannot hold an extraction call at all. */
export const EXTRACT_MIN_WINDOW_TOKENS = 64;

/**
 * The most windows one thought may be extracted in — the per-thought cost
 * bound the 8,000-character cut used to be (fifth review pass). At the default
 * window that is ~29,000 estimated tokens, ~115,000 characters, four times the
 * longest thought on the fork's brain; a thought over it is recorded failed
 * with the count, not extracted for hours or billed for hundreds of calls.
 */
export const EXTRACT_MAX_WINDOWS = 24;

export function resolveExtractWindow(raw, model, fallback) {
  // Floored BEFORE the positivity test (fifth review pass): 0.5 passed `n > 0`
  // and floored to a 0-token window, one call per word.
  const n = raw ? Math.floor(Number(raw)) : NaN;
  // Exact name, then the name without its Ollama tag — resolveChunkTokens's rule.
  const window = KNOWN_CHAT_MODEL_WINDOW[model] ?? KNOWN_CHAT_MODEL_WINDOW[model.replace(/:[^:]*$/, "")];
  if (Number.isFinite(n) && n > 0) return { tokens: n, from: "OB1_EXTRACT_CHUNK_TOKENS", window, capped: false, unfit: false };
  if (window === undefined) return { tokens: fallback, from: "default", window, capped: false, unfit: false };
  const fits = extractWindowThatFits(window);
  // A context that holds less than EXTRACT_MIN_WINDOW_TOKENS of text beside
  // the rules and an answer cannot be windowed into — a 1-token window would
  // be one call per word (second review pass: the floor was Math.max(1, …)).
  // The default is returned with `unfit` set, and preflight warns.
  if (fits < EXTRACT_MIN_WINDOW_TOKENS) return { tokens: fallback, from: "default", window, capped: false, unfit: true };
  return { tokens: Math.min(fits, fallback), from: "window", window, capped: fits > fallback, unfit: false };
}

/**
 * Models trained with Matryoshka Representation Learning, which concentrates
 * meaning in the leading dimensions so a prefix of the vector is still a good
 * vector. Truncating one of these is a supported operation; truncating anything
 * else is just throwing away numbers.
 *
 * This matters because **providers truncate for every model regardless** — asking
 * a non-MRL model for 256 dimensions returns 256 numbers and no warning.
 *
 * Membership is taken from each model's own card, not inferred from the family or
 * the vendor, because inferring it got four of these wrong. Measured on 97 real
 * documents, at a matched 4x reduction to 256 dimensions:
 *
 *   mxbai-embed-large        MRL      −0.011 MRR
 *   snowflake-arctic-embed2  MRL      −0.020      (its card claims <3%; it held)
 *   bge-m3                   not MRL  −0.042
 *
 * Two to four times the loss for the model not trained for it, at the same cut.
 * `granite-embedding` loses 0.018 at only a 1.5x cut, which is worse than
 * `mxbai-embed-large` manages at 4x.
 */
export const MRL_MODELS = new Set([
  // OpenAI documents a `dimensions` parameter for both.
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
  // Card: "supports user-defined output dimensions ranging from 32 to N", and the
  // comparison table marks MRL support for every Qwen3-Embedding variant.
  "qwen3-embedding:0.6b",
  "qwen3-embedding:4b",
  "qwen3-embedding:8b",
  "qwen/qwen3-embedding-4b",
  "qwen/qwen3-embedding-8b",
  // Card: MRL truncation to 512, 256 or 128 after re-normalisation.
  "embeddinggemma",
  // Card: "utilizes Matryoshka Representation Learning" — 768 to 512/256/128/64.
  "nomic-embed-text",
  // Card: "Trained with Matryoshka Embeddings" — 768 down to 256.
  "nomic-embed-text-v2-moe",
  // Card: "The model supports both approaches!" (MRL and binary quantization).
  "mxbai-embed-large",
  // Card: MRL at 256 dimensions, "less than 3% degradation in quality".
  "snowflake-arctic-embed2",
]);

/**
 * Checked against their cards and found to make NO Matryoshka claim, so the
 * warning is correct for these. Recorded so the next person need not re-check.
 */
export const VERIFIED_NOT_MRL = new Set([
  "bge-m3", "bge-large", "granite-embedding", "all-minilm",
]);

/**
 * Asymmetric prompt templates, from each model's own card.
 *
 * Several embedding models are trained to see a query and a document differently,
 * and sending both bare is not a small loss. Measured on 97 real issues,
 * `qwen3-embedding:4b` at 1024 dimensions scores **0.933 MRR with its query
 * instruction and 0.860 without** — worse, unprompted, than `embeddinggemma`'s
 * 0.914. That is the difference between the best model tested and a regression, so
 * the templates are part of the model's identity here rather than an option.
 *
 * Those three figures come from the truncated 97-issue corpus and, unlike the
 * head-to-head above, have NOT been re-measured on the rebuilt one. They are kept
 * because the gap is far too large to be an artifact of document length, but the
 * absolute values belong to the old corpus and should be re-run before they are
 * quoted as current.
 *
 * `{q}` and `{d}` are replaced with the query and the document. A model absent
 * from this table is sent bare, which is correct for most of them:
 * `embeddinggemma` gains only 0.002 from its documented format, and applying
 * nomic's `search_query:`/`search_document:` prefixes measurably HURT retrieval in
 * this fork's benchmarks, so neither is listed.
 *
 * Changing a template silently invalidates every stored vector, exactly like
 * changing the model. Keying off the model name rather than a free-form setting
 * means the existing model-change detection in preflight already covers it.
 */
export const EMBEDDING_PROMPTS = {
  "qwen3-embedding:0.6b": {
    query: "Instruct: Given a search query, retrieve the note that answers it\nQuery: {q}",
    document: "{d}",
  },
  "qwen3-embedding:4b": {
    query: "Instruct: Given a search query, retrieve the note that answers it\nQuery: {q}",
    document: "{d}",
  },
  "qwen3-embedding:8b": {
    query: "Instruct: Given a search query, retrieve the note that answers it\nQuery: {q}",
    document: "{d}",
  },
};

/**
 * Apply a model's query/document template. Lives beside the table it reads so the
 * server and the benchmark cannot diverge on HOW a template is applied, having
 * already diverged once on WHICH template to use.
 *
 * Returns the text unchanged for a model with no entry, which is correct for most
 * of them and is why the caller does not need to check first.
 */
export function applyEmbeddingPrompt(model, text, isQuery) {
  const tpl = EMBEDDING_PROMPTS[model];
  if (!tpl) return text;
  // A replacer FUNCTION, not the string: String.replace reads `$&`, `$'`, `` $` ``
  // and `$$` in a string replacement as substitution patterns, so a note with a
  // price written `$$5` embedded as `$5`, and a query containing `$&` became
  // the template's own placeholder. The function form inserts the text as it is.
  return isQuery ? tpl.query.replace("{q}", () => text) : tpl.document.replace("{d}", () => text);
}

/**
 * Contextual retrieval — the blurb prepended to a chunk before it is embedded.
 *
 * A window of a long capture is embedded on its own, so it carries none of the
 * document's framing: "we went with the second option" embeds into roughly the
 * wrong neighbourhood because nothing in those words says which decision. The
 * technique (Anthropic, September 2024) is to generate a short situating
 * sentence and put it in front of the window before embedding.
 *
 * `{document}` and `{chunk}` are substituted. Both templates are here rather
 * than in the server because `evals/eval-contextual.ts` measures the same text
 * the server would embed, and a benchmark that prompts differently from
 * production measures nothing about production — the exact defect lib.ts was
 * written to end for the embedding templates.
 *
 * The instruction to answer with the context and nothing else is load-bearing.
 * Without it a 7B model returns "Certainly! Here is the context:" and that
 * preamble is embedded along with everything else, in every chunk, pulling every
 * window in the corpus very slightly toward each other.
 */
export const CHUNK_CONTEXT_PROMPTS = {
  /** One call per document; the same blurb goes in front of every window. */
  document:
    "<document>\n{document}\n</document>\n\n" +
    "Write one short sentence describing what this document is about, so that an " +
    "excerpt from it can be understood without the rest. Answer with the sentence " +
    "and nothing else.",
  /** One call per window — more expensive, and what Anthropic actually measured. */
  chunk:
    "<document>\n{document}\n</document>\n\n" +
    "Here is a chunk we want to situate within the whole document:\n\n" +
    "<chunk>\n{chunk}\n</chunk>\n\n" +
    "Give a short succinct context to situate this chunk within the overall document " +
    "for the purposes of improving search retrieval of the chunk. Answer with the " +
    "succinct context and nothing else.",
  /**
   * The same request with the two failure modes of the one above closed off.
   *
   * "Short succinct" is not a length, and a 7B model reads it as a paragraph:
   * qwen2.5:7b returned a median of 388 characters, every one of them opening
   * with "This chunk outlines" or "This chunk discusses". Both halves of that
   * hurt. The length dilutes the window it is supposed to situate, and the
   * shared opening is identical text prepended to every chunk in the corpus,
   * which pulls all of them toward each other and costs exactly the
   * discrimination the blurb was added to buy.
   *
   * A word budget and a banned opener are the whole difference.
   */
  chunkTight:
    "<document>\n{document}\n</document>\n\n" +
    "Here is an excerpt from that document:\n\n" +
    "<chunk>\n{chunk}\n</chunk>\n\n" +
    "In at most 20 words, name what this excerpt is about: the system, feature or " +
    "decision it concerns. Do not begin with \"This\". Do not describe the excerpt " +
    "or the document. Answer with the phrase and nothing else.",
};

/**
 * Fill a CHUNK_CONTEXT_PROMPTS template with the document and, for the
 * per-window templates, the window.
 *
 * One pass, with a function, for the same reason applyEmbeddingPrompt uses one:
 * a string replacement reads `$&`, `$'` and `$$` in the document as
 * substitution patterns, and two chained replaces would drop the window into a
 * document that itself contains the literal `{chunk}` and leave the real
 * placeholder unfilled. Shared by server-portable/embed.ts and
 * evals/eval-contextual.ts so the harness measures the prompt the server sends;
 * the eval kept its own chained replaces after the server's were fixed, which
 * is the defect this file exists to prevent.
 */
export function applyChunkContextPrompt(template, fill) {
  return template.replace(/\{document\}|\{chunk\}/g, (m) => {
    const v = m === "{document}" ? fill.document : fill.chunk;
    return v === undefined ? m : v;
  });
}

/**
 * Whether a generated blurb is worth prepending.
 *
 * Here rather than in the server for the same reason as the composition rule
 * below: `evals/eval-contextual.ts` decides which blurbs a run would actually
 * embed, and if it applied a looser rule than production it would be measuring
 * text the server would have thrown away. The threshold was written twice
 * before this function existed, which is the defect this file exists to prevent.
 *
 * A blurb at or over 60% of the length of what it situates is not context, it is
 * a second copy: it roughly doubles the embedded text and dilutes the window
 * with a paraphrase of itself. The measured harm from contextualization already
 * tracks blurb length — see DEFAULT_CHUNK_CONTEXT — so the long ones are exactly
 * the ones worth refusing.
 *
 * Dilution is not the worst of it. Windows are sized to leave headroom under the
 * provider's batch, and a blurb of comparable length spends that headroom: with
 * this rule removed, `server-portable/test-chunk-context.ts` [5] stops failing
 * an assertion and starts failing the CAPTURE, because the composed text no
 * longer fits. A rule that looks like quality control is also the thing keeping
 * a runaway blurb from making a long thought unstorable.
 */
export function usableChunkContext(context, chunk) {
  const ctx = (context ?? "").trim();
  return ctx.length > 0 && ctx.length < chunk.length * 0.6;
}

/**
 * How a blurb and a window become the text that gets embedded.
 *
 * One line, and it still belongs here. The server composes it at capture, the
 * benchmark composes it to measure, and a backfill would compose it again; if
 * any of the three used a different separator the vectors would not be
 * comparable and nothing would say so. This fork's recurring defect is a value
 * defined twice.
 *
 * An empty or missing context returns the window unchanged, which is what makes
 * a failed blurb degrade to today's behaviour rather than embedding a stray
 * separator.
 */
export function composeChunkForEmbedding(context, chunk) {
  const ctx = (context ?? "").trim();
  return ctx ? `${ctx}\n\n${chunk}` : chunk;
}

/**
 * Whether to ask the provider to shorten the vector, via the OpenAI `dimensions`
 * parameter. Off by default: a silently shortened vector from a model that was not
 * trained for it is precisely the kind of quiet quality loss this fork tries to
 * make loud.
 *
 * Turn it on to use a model whose native width exceeds pgvector's 2000-dimension
 * HNSW ceiling. `qwen3-embedding:4b` is 2560 natively and unindexable, but scored
 * the best result measured on real data at 1024 — better than any model that fits
 * natively. That is what this flag is for.
 */
/**
 * Resolve the truncation decision. A FUNCTION rather than only the constant
 * below, because server-portable/index.ts reads its environment lazily so
 * Cloudflare Workers bindings apply — it cannot use a value computed at module
 * load. Both it and preflight.ts call this, so the rule exists once.
 *
 * Getting that wrong is not theoretical: the auto-enable below was added here
 * while index.ts and preflight.ts kept their own copy of the old regex, and the
 * container crashlooped on a default configuration that was in fact valid.
 */
export function resolveEmbeddingDimensions(raw, dim, model) {
  raw = typeof raw === "string" ? raw.trim() : raw; // one decision for a padded value, wherever it is read (SMD-1843)
  if (raw !== undefined && raw !== "") return /^(1|on|true|yes)$/i.test(raw);
  const native = KNOWN_MODEL_DIMS[model];
  return MRL_MODELS.has(model) && native !== undefined && dim < native;
}

export const EMBEDDING_DIMENSIONS = resolveEmbeddingDimensions(
  ENV.OB1_EMBEDDING_DIMENSIONS,
  EMBEDDING_DIM,
  EMBEDDING_MODEL
);

/**
 * Whether migration 011 builds the trigram index on `thoughts.content`.
 *
 * ON by default as of SMD-944, and it was off before that. The reason for off
 * was narrow and specific: no query in core issued an ILIKE against
 * `thoughts.content`, so the index was unreachable and every capture paid for
 * it anyway. Migration 012 adds `search_thoughts_keyword`, which is exactly that
 * query, so the one argument for off no longer holds and the default flips with
 * it.
 *
 * The costs did not change, and they are still real. Measured on this fork's own
 * corpus (db/bench-trgm.ts): the index does nothing below ~10,000 rows — the
 * planner correctly declines it — nothing at any scale for a common word, and
 * nothing for a pattern under three characters. It costs roughly +70 to +95
 * microseconds on every capture, and about as much storage as the table itself.
 *
 * So a stock deployment below ~10,000 thoughts now pays that write cost for no
 * read benefit. That is the unflattering half, and it is the reason this stayed
 * a flag rather than becoming unconditional: `OB1_TRGM_INDEX=off` before the
 * first migration run restores the previous behaviour exactly, and keyword
 * search still returns the right rows without it — by sequential scan, which at
 * that size is what the planner would have chosen regardless.
 *
 * Above the crossover the trade is not close: 267 ms versus 0.20 ms for a rare
 * term at 100,000 rows.
 */
export const DEFAULT_TRGM_INDEX = true;

/**
 * Parse OB1_TRGM_INDEX. Same accepted spellings as OB1_EMBEDDING_DIMENSIONS.
 *
 * Note what flipping the default did to a typo: anything unrecognised is false,
 * so `OB1_TRGM_INDEX=onn` now turns the index OFF, where before it landed on the
 * default and was invisible. That is not silent — preflight compares the setting
 * against pg_indexes on every boot and warns — but it is worth knowing that an
 * unrecognised value is a decision here, not a fallback to the default.
 */
export function resolveTrgmIndex(raw) {
  raw = typeof raw === "string" ? raw.trim() : raw; // one decision for a padded value, wherever it is read (SMD-1843)
  if (raw === undefined || raw === "") return DEFAULT_TRGM_INDEX;
  return /^(1|on|true|yes)$/i.test(raw);
}

export const TRGM_INDEX = resolveTrgmIndex(ENV.OB1_TRGM_INDEX);

/**
 * How many rows migration 023's fingerprint backfill writes in the migrator's
 * one call: unset, every row waiting (the default — one transaction, one
 * lock); an integer, one batch of that many, for a brain with millions of
 * legacy rows that finishes the rest by hand with the same function. Read by
 * the migrator only, from its environment at that invocation — a `.env` beside
 * it counts, so it does not belong in one — where a role-level setting would
 * have batched every later run of every brain under that role, and a typo in
 * it would have failed 023 with a message naming neither the setting nor the
 * fix. Throws on a bad value; the migrator, not a server, is what calls it.
 */
export function resolveBackfillLimit(raw) {
  if (raw === undefined || raw === "") return null;
  // int4, as the function's parameter is: a larger literal would be typed
  // bigint and match no overload, failing 023 with a message naming neither.
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 2147483647) {
    throw new Error(`OB1_BACKFILL_LIMIT must be a whole number of rows, at least 1 and at most 2147483647, or unset for every row (got ${JSON.stringify(raw)})`);
  }
  return Number(raw);
}
// No module-scope constant: this module is imported by the servers, preflight
// and reembed.ts, none of which run a migration, and a value only the migrator
// reads must not be able to stop them at import. migrationValues() resolves it
// where the migrator (and the schema tests) ask for the template's values.

/**
 * Whether a capture generates a situating blurb for each of its chunks.
 *
 * OFF, and measured off rather than assumed off. `evals/eval-contextual.ts`
 * scores it over 37 queries that name a document's subject and ask for a detail
 * that lives in exactly one window — the query the technique exists for, and one
 * that title-as-query benchmarks cannot pose. Against the bare windows the
 * server stores today, on the configured default model:
 *
 *   arm                                    MRR      helped   hurt
 *   bare windows (before change 27)        0.904         —      —
 *   whole content + windows (TODAY)        0.935         3      0
 *   a blurb per window                     0.826         1      8
 *   a 20-word blurb per window             0.847         0      5
 *   one blurb per document                 0.759         1     13
 *
 * Helped/hurt are against the baseline row. Against what the server actually
 * stores today the gap is wider still: 0.935 to 0.867 for the best contextual
 * arm, because keeping the whole-content vector helped the same queries a blurb
 * was supposed to.
 *
 * The mechanism is dilution, not a bad blurb: the same harness measures the
 * cosine between each query and the exact window it was written against, and
 * prepending context moves that window AWAY from its own query — by 0.034 with
 * a full blurb (lower on 32 of 37) and 0.014 with a 20-word one (27 of 37). The
 * loss tracks blurb length, which is why `chunkTight` exists and why it is less
 * bad rather than good.
 *
 * It is a flag rather than deleted code because the sign is a property of the
 * MODEL, not of the technique. The same harness on `embeddinggemma` — 768
 * dimensions against 1024, and a real 2048-token ceiling — reverses it: a blurb
 * per window scores +0.041 there, helping 5 queries and hurting 4. A weaker
 * window vector has more to gain from the extra subject signal than it loses to
 * dilution. Anyone running a smaller embedding model, or capturing transcripts
 * rather than issue threads, should measure before accepting this default.
 *
 * Turning it on costs one LLM call per chunk at capture — 1.2 to 2.2 seconds
 * each at `qwen2.5:7b` locally across four runs, on the 3.4% of captures long
 * enough to chunk. Quoted as a range because it is one: a single figure here
 * would invite someone to treat run-to-run variance as a regression.
 */
export const DEFAULT_CHUNK_CONTEXT = false;

/**
 * Parse OB1_CHUNK_CONTEXT. Same accepted spellings as the other flags.
 *
 * Unlike OB1_TRGM_INDEX this is read per capture rather than once at migration
 * time, so flipping it mid-life leaves a corpus where some chunks carry context
 * and some do not. That state is legal, silent in every query, and detectable:
 * `thought_chunks.context` is NULL for a bare chunk, and preflight counts both.
 */
export function resolveChunkContext(raw) {
  raw = typeof raw === "string" ? raw.trim() : raw; // one decision for a padded value, wherever it is read (SMD-1843)
  if (raw === undefined || raw === "") return DEFAULT_CHUNK_CONTEXT;
  return /^(1|on|true|yes)$/i.test(raw);
}

export const CHUNK_CONTEXT = resolveChunkContext(ENV.OB1_CHUNK_CONTEXT);

/**
 * The values substituted into `{{...}}` in db/migrations/*.sql.
 *
 * Here rather than in the runner because there are three callers — migrate.ts,
 * db/test-support.ts and db/test-schema.ts — and until this existed each kept its
 * own pair of hardcoded `.replace()` calls. Two of them would have silently
 * ignored a new variable: a `{{TRGM_INDEX}}` nobody substitutes is not an error
 * in a `.replace()` chain, it is a literal left in the SQL. This fork's recurring
 * defect is a value defined twice, and adding a third variable to three copies is
 * how that happens again.
 *
 * @param {{ dim?: number, model?: string, trgm?: boolean, chunkContext?: boolean, backfillLimit?: number | null, routeEstimateMinPages?: number }} overrides
 */
export function migrationValues(overrides = {}) {
  return {
    EMBEDDING_DIM: String(overrides.dim ?? EMBEDDING_DIM),
    EMBEDDING_MODEL: overrides.model ?? EMBEDDING_MODEL,
    TRGM_INDEX: String(overrides.trgm ?? TRGM_INDEX),
    CHUNK_CONTEXT: String(overrides.chunkContext ?? CHUNK_CONTEXT),
    // 023's one call: NULL is every row waiting; an integer, one batch.
    BACKFILL_LIMIT: String((overrides.backfillLimit === undefined ? resolveBackfillLimit(ENV.OB1_BACKFILL_LIMIT) : overrides.backfillLimit) ?? "NULL"),
    // 030 reads the claim rows an evidence backfill may trust, and the key
    // grammar for its early return; one spelling of each, substituted into the
    // file (SMD-1193). The caveat prefix rides inside the rows.
    REEMBED_KEY_MODEL_RE: REEMBED_KEY_MODEL_SQL_RE,
    CLAIM_EVIDENCE_ROWS: CLAIM_EVIDENCE_ROWS_SQL,
    // Not operator configuration — ALTER DATABASE owns that — but the one
    // definition of what 014 seeds, so the SQL, the migrator's remedy,
    // preflight's report and the schema test cannot disagree about it.
    HNSW_SEED_MAX_SCAN_TUPLES: String(HNSW_SEED_MAX_SCAN_TUPLES),
    HNSW_SEED_SCAN_MEM_MULTIPLIER: String(HNSW_SEED_SCAN_MEM_MULTIPLIER),
    MATCH_COUNT_CEILING: String(MATCH_COUNT_CEILING),
    // 037's gate on the routing count: the pages it samples, and the heap size
    // under which it does not sample at all. The floor is the one value a
    // suite overrides — to 0, so a table of a few thousand rows reaches the
    // gate (test-schema [8e], test-live [5d]); the shipped default otherwise.
    ROUTE_SAMPLE_PAGES: String(ROUTE_SAMPLE_PAGES),
    ROUTE_ESTIMATE_MIN_PAGES: String(overrides.routeEstimateMinPages ?? ROUTE_ESTIMATE_MIN_PAGES),
    SHARED_SETTING_SOURCES: SHARED_SETTING_SOURCES.map((s) => `'${s}'`).join(", "),
  };
}

/**
 * Substitute a migration template. Throws on an unknown variable rather than
 * leaving it in place, so a typo fails loudly at apply time instead of reaching
 * Postgres as a syntax error with no clue where it came from.
 */
export function substituteMigration(sql, values, file = "a migration") {
  return sql.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${file}: unknown template variable {{${key}}}`);
    return value;
  });
}

export function validateEmbeddingConfig(dim = EMBEDDING_DIM, model = EMBEDDING_MODEL, truncate = EMBEDDING_DIMENSIONS) {
  const problems = [];
  if (!Number.isInteger(dim) || dim < 1) {
    problems.push(`OB1_EMBEDDING_DIM must be a positive integer, got "${dim}"`);
  }
  if (dim > MAX_HNSW_DIM) {
    problems.push(
      `OB1_EMBEDDING_DIM=${dim} exceeds pgvector's HNSW limit of ${MAX_HNSW_DIM}. ` +
        `The column would work but the index could not be built, so every search becomes a full scan. ` +
        `If the model supports Matryoshka truncation, set OB1_EMBEDDING_DIM to 1024 or 1536 and ` +
        `OB1_EMBEDDING_DIMENSIONS=on to request a narrower vector that can be indexed.`
    );
  }
  const known = KNOWN_MODEL_DIMS[model];
  if (known !== undefined && known !== dim) {
    if (!truncate) {
      problems.push(
        `OB1_EMBEDDING_MODEL="${model}" returns ${known} dimensions but OB1_EMBEDDING_DIM=${dim}. ` +
          `Set the dimension to ${known}, choose a model that matches, or — if ${dim} < ${known} and ` +
          `the model supports Matryoshka truncation — set OB1_EMBEDDING_DIMENSIONS=on to request ` +
          `${dim} from the provider.`
      );
    } else if (dim > known) {
      problems.push(
        `OB1_EMBEDDING_DIMENSIONS=on cannot widen a vector: OB1_EMBEDDING_MODEL="${model}" returns ` +
          `${known} dimensions and OB1_EMBEDDING_DIM=${dim} is larger. Truncation only shortens.`
      );
    }
    // Truncating a non-MRL model is not fatal — it works, it is just quietly
    // worse — so it is reported by embeddingConfigWarnings() rather than here.
  }
  return problems;
}

/**
 * Non-fatal configuration smells. Separate from validateEmbeddingConfig because
 * callers exit non-zero on anything that function returns, and "this will work but
 * retrieval will be worse" must not block a migration. Preflight surfaces these.
 */
export function embeddingConfigWarnings(dim = EMBEDDING_DIM, model = EMBEDDING_MODEL, truncate = EMBEDDING_DIMENSIONS) {
  const warnings = [];
  const known = KNOWN_MODEL_DIMS[model];
  if (truncate && known !== undefined && dim < known && !MRL_MODELS.has(model)) {
    warnings.push(
      `"${model}" is not known to be trained for Matryoshka truncation, but ` +
        `OB1_EMBEDDING_DIMENSIONS=on will shorten it from ${known} to ${dim}. Providers do this ` +
        `silently and retrieval quality drops — measured at roughly twice the loss of an MRL ` +
        `model on the same corpus. Benchmark it on your own notes: see evals/README.md.`
    );
  }
  if (truncate && known === undefined) {
    warnings.push(
      `OB1_EMBEDDING_DIMENSIONS=on but "${model}" has no known native width, so the request ` +
        `cannot be sanity-checked. If the provider ignores the parameter the server will refuse ` +
        `the mismatched vector at capture time rather than storing a bad one.`
    );
  }
  return warnings;
}

/**
 * A bulk pass's counts, in one phrase — the one db/reembed.ts prints under
 * --status and at the end of a run, and the one server-portable/preflight.ts
 * embeds when it reports a re-embed pass unfinished. Defined once so the two
 * cannot describe the same claim rows in two vocabularies (SMD-1024).
 *
 * A row the operator accepted (SMD-1067) is a succeeded row with a caveat,
 * and is counted inside that parenthesis so the two numbers cannot disagree —
 * counted while the acceptance STANDS (nothing has written the thought since),
 * the same bound the data rule and preflight's `vector models` apply, so one
 * report cannot call a row accepted on its counts line and not two lines
 * later (first review pass).
 *
 * @param {{thoughts:number, succeeded:number, fellBack:number, accepted:number, failed:number, claimed:number, pending:number, unpooled:number}} c
 * @returns {string}
 */
export function formatPassCounts(c) {
  return (
    `${c.thoughts} thoughts — ${c.succeeded} succeeded${c.fellBack ? ` (${c.fellBack} with a caveat${c.accepted ? `, ${c.accepted} accepted by the operator` : ""})` : ""}, ${c.failed} failed, ` +
    `${c.claimed} in flight, ${c.pending} pending, ${c.unpooled} not yet in the pool`
  );
}

/**
 * The rule preflight and reembed.ts share for "this pass has not finished": a
 * row under the key is still pending, still leased, or failed. Succeeded rows
 * that carry a caveat are finished (SMD-1021); thoughts with no row under the
 * key are not a signal by themselves — after a completed model switch every
 * new capture is one — and are reported as detail while a pass is unfinished.
 *
 * @param {{pending:number, claimed:number, failed:number}} c
 * @returns {boolean}
 */
export function passUnfinished(c) {
  return c.pending + c.claimed + c.failed > 0;
}

/**
 * The shape of a re-embed job key, built and read here and nowhere else:
 * `reembed:<model>@<dim>`, optionally `:<suffix>` for a backfill under the
 * same model. The prefix is how preflight attributes a claim-table key to
 * reembed.ts; the model part may itself contain ":" (qwen3-embedding:4b), so
 * the width is read from the LAST "@", and a suffix may not contain "@" — a
 * key that does is of another shape and names no model. reembed.ts refuses a
 * --job whose named model or width is not the configured one (the run would
 * write one model's vectors under another's key); preflight tells a pass to a
 * model that is no longer the recorded one from a backfill (SMD-1024).
 */
export const REEMBED_KEY_PREFIX = "reembed:";

/**
 * @param {string} model
 * @param {number} dim
 * @returns {string}
 */
export function reembedKey(model, dim) {
  return `${REEMBED_KEY_PREFIX}${model}@${dim}`;
}

/**
 * The same grammar for SQL that reads claim rows, as Postgres regexes: the
 * model up to the LAST "@" of `reembed:<model>@<dim>[:suffix]`, and the width
 * after it. Byte for byte 021's — `[0-9]+`, a leading zero included — because
 * 021's hashed backfill decides which rows ARE evidence, and a reader with a
 * narrower grammar would let 021 label from a row it never saw (the fourth
 * review pass tightened this to a canonical width and the fifth found exactly
 * that hole). "The model's own key" is the canonical spelling, as poolModelFor
 * has it — a width without a leading zero and no suffix — as a regex, never a
 * cast of the width (a hand-written width past bigint raised out of 030 and
 * the migrator; the sixth review pass), so `reembed:m@08` names a model on
 * both sides and is nobody's own key on both. 030 takes the first as a
 * template value ({{REEMBED_KEY_MODEL_RE}}) and the rows below as another;
 * migrate.ts shadows the claim table for 021's backfill with a view that
 * carries no row ACCEPTED_CLAIM_SQL names (SMD-1193, SMD-1421).
 *
 * These, and ACCEPTED_CAVEAT_PREFIX, are substituted into migration 030 —
 * whose file the migrator hashes as a TEMPLATE. Changing any of them changes
 * what 030 does on every brain where it is still pending, and what every
 * --reapply does, with no drift signal: that is a data migration, and gets a
 * new file. db/test-schema.ts pins the literals.
 */
export const REEMBED_KEY_MODEL_SQL_RE = "^reembed:(.+)@[0-9]+(?::[^@]*)?$";
export const REEMBED_OWN_KEY_SQL_RE = "^reembed:.+@(0|[1-9][0-9]*)$";

/**
 * @param {string} key
 * @returns {{model: string, dim: number} | null}
 */
export function parseReembedKey(key) {
  if (!key.startsWith(REEMBED_KEY_PREFIX)) return null;
  // `\d+`, as 021's `[0-9]+` reads it: a key names a model whatever its
  // width's spelling, so `--job reembed:other@01024` is still refused as a
  // pass to another model and `--retire` still knows the current one. Whether
  // the key is the model's OWN is poolModelFor's canonical comparison.
  const m = /^(.+)@(\d+)(?::[^@]*)?$/.exec(key.slice(REEMBED_KEY_PREFIX.length));
  return m ? { model: m[1], dim: Number(m[2]) } : null;
}

/**
 * How a pass under `key` builds its pool (migration 021): a model's OWN key —
 * exactly `reembed:<model>@<dim>`, nothing after — pools the thoughts not at
 * that model (no vector, or another or no label), and this returns the model;
 * any other key (a suffix, or no model named) is a backfill whose reason is
 * not the model, pools every thought, and this returns null. Read by
 * reembed.ts for its pool and by preflight for "not yet in the pool", so the
 * two cannot count one key two ways (second review pass of SMD-1068).
 *
 * @param {string} key
 * @returns {string | null}
 */
export function poolModelFor(key) {
  const named = parseReembedKey(key);
  return named !== null && key === reembedKey(named.model, named.dim) ? named.model : null;
}

/**
 * The shape of a consolidation pass key (migration 029, SMD-1294):
 * `consolidate:<model>@p<prompt version>`, built by
 * server-portable/consolidate.ts's consolidateKey() and read back by its
 * parseConsolidateKey(). The prefix lives here so preflight can attribute a
 * claim-table key to db/consolidate.ts the way REEMBED_KEY_PREFIX attributes
 * one to reembed.ts, without importing the prompt module.
 */
export const CONSOLIDATE_KEY_PREFIX = "consolidate:";

/**
 * The corpus by the model its vectors carry (migration 021): one row per
 * label, NULL for unknown, vectorless rows left out — what preflight's
 * `vector models` check and reembed.ts's corpus line both read. Plain SQL with
 * no parameters, so either client runs it with `unsafe`.
 */
export const CORPUS_BY_MODEL_SQL =
  "SELECT embedding_model AS model, count(*)::int AS c FROM thoughts WHERE embedding IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1";

/**
 * Those rows read against one model: how many are at it, how many carry no
 * label, and the other models with their counts. One reduction for both
 * tools, so they cannot describe one corpus two ways (SMD-1068's review
 * passes found the query and this arithmetic written twice).
 *
 * The third argument is ACCEPTED_BY_MODEL_SQL's rows, when the caller has
 * them: `unaccepted` is what a warning counts, the rest is detail (SMD-1067).
 *
 * @param {{model: string | null, c: number}[]} rows
 * @param {string} atModel
 * @param {{model: string | null, accepted: number}[]} [acceptedRows]
 * @returns {{at: number, unlabelled: number, others: {model: string, c: number, accepted: number}[], otherCount: number, acceptedCount: number, unaccepted: number}}
 */
export function summariseCorpusByModel(rows, atModel, acceptedRows = []) {
  const at = Number(rows.find((r) => r.model === atModel)?.c ?? 0);
  const unlabelled = Number(rows.find((r) => r.model === null)?.c ?? 0);
  const acceptedFor = (model) => Number(acceptedRows.find((r) => r.model === model)?.accepted ?? 0);
  const others = rows
    .filter((r) => r.model !== null && r.model !== atModel)
    .map((r) => ({ model: /** @type {string} */ (r.model), c: Number(r.c), accepted: acceptedFor(r.model) }));
  const otherCount = others.reduce((a, r) => a + r.c, 0);
  const acceptedCount = others.reduce((a, r) => a + r.accepted, 0);
  return { at, unlabelled, others, otherCount, acceptedCount, unaccepted: otherCount - acceptedCount };
}

/**
 * The caveat an accepted failure carries (SMD-1067). A row the provider
 * refuses permanently — a content filter that rejects one thought on every
 * attempt — has no partial result to store and no retry that will change it;
 * `reembed.ts --accept-failed` marks it succeeded with this prefix and the
 * failure after it, under SMD-1021's rule that a succeeded row's last_error is
 * what the worker could not do — here, what the operator has accepted it will
 * not do. Both readers recognise an accepted row by this prefix: reembed.ts's
 * data rule leaves it in place, and preflight's `vector models` counts its
 * vector as detail rather than as a warning — each only while nothing has
 * written the thought since (`updated_at <= claimed_at` — the moment the
 * attempt read the content; finished_at for a row never claimed — the shape
 * of 021's own evidence rule): an edit is a new question. `--retry-fallbacks` returns it like any
 * caveat, which spends the acceptance.
 */
export const ACCEPTED_CAVEAT_PREFIX = "kept the vector it had; accepted by the operator: ";

/**
 * The accepted vectors by label, for the same reduction: per embedding_model,
 * how many rows with a vector have an accepted row — standing: nothing has
 * written the thought since the attempt READ it, claimed_at (015 keeps it on
 * the row after release; finished_at stands in for a row never claimed, and a
 * hand-written row with neither is never standing — -infinity, so no reader
 * evaluates NULL and leaves it stuck between them) —
 * under $1, the OWN key of the model the corpus is
 * judged against (`reembedKey(model, dim)`, exactly). The own key only: a
 * backfill key's failure is about the backfill, and its acceptance tells the
 * backfill; whether the VECTOR is at the model is the own pass's question, and
 * that pass pools the thought by its label whatever another key accepted — so
 * an acceptance under `reembed:B@d:ctx` counted here would have silenced this
 * check while the own key's pass re-failed the same thought on every run
 * (first review pass). And judged against C, an acceptance under B's key says
 * nothing: C's own pass asks the thought again. Parameters: $1 the key, $2
 * ACCEPTED_CAVEAT_PREFIX. Needs thought_work_claims (015) — run it only where
 * that exists, and only when a vector at another model was found.
 */
export const ACCEPTED_BY_MODEL_SQL =
  "SELECT t.embedding_model AS model, count(*)::int AS accepted FROM thoughts t " +
  "WHERE t.embedding IS NOT NULL AND EXISTS (" +
  "SELECT 1 FROM thought_work_claims k WHERE k.thought_id = t.id AND k.work_type = $1 " +
  "AND k.status = 'succeeded' AND k.last_error IS NOT NULL AND starts_with(k.last_error, $2) " +
  "AND COALESCE(t.updated_at, t.created_at) <= COALESCE(k.claimed_at, k.finished_at, '-infinity'::timestamptz)) GROUP BY 1";

/**
 * The claim rows an evidence backfill reads (SMD-1193): every succeeded row
 * under a key naming a model, with the model, whether the key is the model's
 * OWN (no suffix), whether the row is the operator's acceptance, its three
 * timestamps. No window column: a window function inside the shared subquery
 * made it a barrier the planner could not push `accepted AND own_key` through,
 * so 030's first statement evaluated the regexes over every succeeded row (55×
 * slower at 100k rows, measured in the sixth review pass); a reader that wants
 * "latest" wraps this text. Spelled once: migration 030 takes it as the
 * template value {{CLAIM_EVIDENCE_ROWS}}; migrate.ts reads ACCEPTED_CLAIM_SQL
 * above, the one predicate these rows carry, for the view of the claim table
 * it shadows 021's backfill with, so what 030 excludes and what 021 never
 * sees are decided by one text. The caveat prefix is inlined as a literal, so
 * it may hold no quote — asserted below.
 */
/**
 * What returning a claim row to its pool sets — reembed.ts's requeue() for
 * --retry-fallbacks and --retry-failed. One spelling (the seventh review pass
 * of SMD-1193 counted four; the statement migrate.ts printed as a way back
 * went with SMD-1421, and nothing prints it now). claimed_at stays: 030's
 * bound is the enqueue, and readers of an acceptance read the claim — neither
 * is this row's to move.
 */
/**
 * The migrator's re-run, as every remedy that names it prints it — reembed.ts's
 * 021 refusal, preflight's ledger-aware remedies. One spelling (the fourth
 * review pass of SMD-1193 counted seven). Migration 030's own HINT spells it
 * with `<url>` instead, ASCII-only, for Bun's sake.
 */
export const REAPPLY_COMMAND = "cd db && bun migrate.ts --url … --reapply";

/**
 * The lock timeout, in seconds, migrate.ts sets for its session — every
 * transaction it opens, the checks' reads before a re-run, the ledger reads —
 * and quotes in every message of its own that names it; db/test-upgrade.ts
 * derives its expectations from it. Ten seconds: long enough for a live
 * server's statements to finish, short enough that an idle transaction holding
 * thoughts fails the run rather than freezing it and every reader behind 001's
 * ACCESS EXCLUSIVE. A session setting overrides a role's or provider's default
 * for the migrator alone; 023's call sets its own, locally, for its
 * transaction. db/README.md spells the number in prose. Ten, and only ten:
 * 023's hashed body sets 10 s with set_config(…, true) — transaction-local,
 * and under --reapply the transaction is the whole run — so from 023 on the
 * bound is 023's whatever this says; another value here would be false for
 * the re-run's tail.
 */
export const LOCK_TIMEOUT_S = 10;

/**
 * What is wrong with a listing of migration files, or null: a .sql not named
 * NNN_name.sql (the number is a file's identity and its order — `021.sql` or
 * `021-fix.sql` would sort before `021_…` and run at its number), or two files
 * sharing a number (two branches each adding "the next number" is how it
 * happens; the fork has renumbered twice; SMD-1421). One rule, read by
 * migrate.ts at load — every operator's run and every compose start — and by
 * scripts/check-fork-consistency.ts on every push, where the collision is
 * made. Only .sql files are judged.
 * @param {string[]} names
 * @returns {string | null}
 */
export function migrationNameProblem(names) {
  const sorted = names.filter((n) => n.endsWith(".sql")).sort();
  const odd = sorted.find((n) => !/^\d{3}_.+\.sql$/.test(n));
  if (odd) return `${odd} is not a migration name: NNN_name.sql, three digits and an underscore — the number is the file's identity and its order`;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].slice(0, 3) === sorted[i - 1].slice(0, 3)) {
      return `two migrations share the number ${sorted[i].slice(0, 3)}: ${sorted[i - 1]}, ${sorted[i]} — the number is the file's identity and its order; renumber one`;
    }
  }
  return null;
}

export const REQUEUE_SET_SQL = "status = 'pending', last_error = NULL, finished_at = NULL, attempt_count = 0, ttl_expires_at = NULL";

/**
 * Whether claim row `c` is the operator's acceptance of a failure — the caveat
 * prefix on last_error (starts_with(NULL, …) is NULL, and NOT NULL is not
 * true, so the IS NOT NULL is load-bearing). Spelled once for the evidence
 * rows below and for the view of the claim table migrate.ts shadows 021's
 * backfill with (SMD-1421). Inlined into 030 through the rows: changing it is
 * a data migration.
 */
export const ACCEPTED_CLAIM_SQL = `(c.last_error IS NOT NULL AND starts_with(c.last_error, '${ACCEPTED_CAVEAT_PREFIX}'))`;

export const CLAIM_EVIDENCE_ROWS_SQL =
  "SELECT c.thought_id, c.work_type, c.enqueued_at, c.claimed_at, c.finished_at, " +
  `substring(c.work_type FROM '${REEMBED_KEY_MODEL_SQL_RE}') AS model, ` +
  `c.work_type ~ '${REEMBED_OWN_KEY_SQL_RE}' AS own_key, ` +
  `${ACCEPTED_CLAIM_SQL} AS accepted ` +
  `FROM thought_work_claims c WHERE c.status = 'succeeded' AND c.finished_at IS NOT NULL AND c.work_type ~ '${REEMBED_KEY_MODEL_SQL_RE}'`;
if (ACCEPTED_CAVEAT_PREFIX.includes("'")) throw new Error("ACCEPTED_CAVEAT_PREFIX is inlined into SQL as a literal and may not contain a quote");

/**
 * Version floor for "major.minor[.patch]" strings such as pg_extension's
 * extversion. Compared numerically per component — as strings, "0.10.0" sorts
 * before "0.8.0" — and defined once so preflight.ts and the live suite cannot
 * disagree about the same value.
 *
 * @param {string} version
 * @param {number} major
 * @param {number} [minor]
 * @param {number} [patch]
 * @returns {boolean}
 */
export function versionAtLeast(version, major, minor = 0, patch = 0) {
  const [a = 0, b = 0, c = 0] = String(version)
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

/**
 * The compose service names a model endpoint may live at — the `ollama`
 * service deploy/compose.yaml's `local-models` profile adds. preflight.ts
 * passes these to isLocalHostname (a service name is local: the compose
 * network), and check 14 of scripts/check-fork-consistency.ts holds
 * compose.yaml's OB1_LLM_BASE_URL fallback to one of them — so the address
 * the file defaults to is one the container will call local (SMD-1843).
 */
export const LOCAL_PROVIDER_SERVICES = Object.freeze(["ollama"]);

/**
 * Is this hostname the local machine or the private network it sits on?
 * Used by preflight alone (does a model endpoint need a credential?). It is
 * deliberately NOT the test scaffolding's "may this database be dropped"
 * test: that one is loopback-only (db/test-support.ts assertThrowawayDatabase),
 * because a LAN-hosted stack holding a real brain is a documented deployment
 * and "local enough to skip a credential" is a different question from "safe
 * to drop". An earlier draft shared this predicate for both and widened the
 * drop guard to every private network (sixth review pass); do not re-share
 * it. Compose service names and the container-to-host aliases count; an EMPTY
 * host does not — a URL with no host resolves through PGHOST, which is
 * whatever the shell says it is.
 *
 * @param {string} host  as `new URL(...).hostname` reports it — IPv6 keeps its brackets
 * @param {string[]} [serviceNames]  compose service names to accept, e.g. ["postgres"]
 * @returns {boolean}
 */
export function isLocalHostname(host, serviceNames = []) {
  const h = String(host).toLowerCase();
  if (h === "") return false;
  return (
    h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h === "0.0.0.0" ||
    h === "host.docker.internal" || h === "host.containers.internal" ||
    serviceNames.includes(h) ||
    /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * What migration 014 seeds as the HNSW walk's bounds at database level, and
 * what preflight and the migrator quote when they are missing. These are the
 * measured defaults (014's header); they are NOT an operator setting — an
 * operator tunes with `ALTER DATABASE … SET`, which 014 never overwrites — so
 * there is no environment variable behind them. One definition, because the
 * eighth review pass found the pair written as literals in seven places.
 */
export const HNSW_SEEDS = Object.freeze({
  "hnsw.max_scan_tuples": 100000,
  "hnsw.scan_mem_multiplier": 8,
});
export const HNSW_SEED_MAX_SCAN_TUPLES = HNSW_SEEDS["hnsw.max_scan_tuples"];
export const HNSW_SEED_SCAN_MEM_MULTIPLIER = HNSW_SEEDS["hnsw.scan_mem_multiplier"];
/**
 * The bound names, in the order the remedies print them. Every place that
 * reads, resets or asserts the bounds goes through this list (preflight,
 * dropSchema, the bench, the live and schema tests, the eval), so a third
 * bound added here is checked, reset and reported everywhere at once; the
 * migrator reads the names a migration actually seeds from that migration's
 * own text. Binding this array into Bun.sql needs `sql.array(HNSW_BOUNDS,
 * "TEXT")` — a bare `${HNSW_BOUNDS}` is sent as comma-joined text, which
 * Postgres rejects as a malformed array literal (eleventh review pass).
 */
export const HNSW_BOUNDS = Object.keys(HNSW_SEEDS);

/** A database name as an SQL identifier — `open-brain` and `OpenBrain` both need the quotes. */
export function quoteIdent(name) {
  return name == null ? "<database>" : `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * The bounds as this session sees them: `current_setting` per name, NULL for
 * a placeholder pgvector has not defined yet. One SQL text, with the names
 * inlined as literals (they are this module's constants, not input), so a
 * caller on any client — Bun.sql, PGlite — can run it with `unsafe`/`query`.
 */
export const BOUNDS_IN_FORCE_SQL =
  `SELECT n AS name, current_setting(n, true) AS value FROM unnest(ARRAY[${HNSW_BOUNDS.map((n) => `'${n}'`).join(", ")}]) AS n`;

/**
 * match_thoughts clamps match_count to this INSIDE the function (migration
 * 014, templated as {{MATCH_COUNT_CEILING}}). 500 covers every caller in the
 * repo: enhanced-mcp asks for up to 500 under a date filter, rest-api up to
 * 200, agent-memory-api up to 200. The servers' own search_thoughts tools
 * clamp their `limit` to 100 separately — a tool-level choice about what to
 * hand a model, not this cost bound. The bench measures asked-500.
 */
export const MATCH_COUNT_CEILING = 500;

/**
 * The gate on match_thoughts' routing count (migration 037, SMD-1463). Every
 * filtered call used to open with the capped GIN collection — `SELECT id …
 * WHERE metadata @> filter … LIMIT v_exact + 1` — and GIN builds its whole
 * bitmap before the LIMIT can stop anything, so that statement cost the
 * number of MATCHING rows (~50 ns each: 25–27 ms at 50% of a million rows, 240
 * at 50% of ten million) before the walk began. 037 samples the heap first —
 * ROUTE_SAMPLE_PAGES pages, read since 038 as eight TID range probes — eight
 * page reads whatever the heap holds, ~0.05 ms with one row a page and ~0.3
 * at the shipped width (037's TABLESAMPLE SYSTEM decided page by page
 * over the whole heap and cost ~2 ns a heap page besides, a millisecond at
 * ten million rows; 038's header, SMD-1526) — and skips the collection when
 * the sample says the filter is
 * far too broad for the exact branch. The sample runs only on a heap of at
 * least ROUTE_ESTIMATE_MIN_PAGES pages (64 MB; some 160,000 rows at the
 * bench's width, fewer with long content): under that the whole bitmap costs
 * a few milliseconds at worst and the sample would be paid on every filtered
 * call for nothing. Both are templated into the file so the header, the bench
 * and the tests cannot disagree about them; a suite lowers the floor to reach
 * the gate on a small table (SchemaOptions.routeEstimateMinPages). Not an
 * operator knob — the exact branch's threshold and the walk's bounds are the
 * tuning surface, and the gate's job is to leave them alone.
 */
export const ROUTE_SAMPLE_PAGES = 8;
export const ROUTE_ESTIMATE_MIN_PAGES = 8192;

/**
 * The two search functions' signatures, as regprocedure text — the forms the
 * servers call. Migration 020 (SMD-945) gave both two defaulted parameters,
 * `recency_weight` and `half_life_days`, by DROPPING the earlier form first: a
 * 6-argument match_thoughts beside the 4-argument one makes every 4-argument
 * call fail with "function is not unique", the ambiguity 004's header names
 * for upsert_thought. Written once here because a dozen places resolve a
 * function by signature — `dropSchema`, extractBody, preflight's catalog
 * reads, the test fixtures' ALTER FUNCTION — and a stale copy in any of them
 * goes on resolving a function that no longer exists. `float` and `int` are the
 * aliases regprocedure accepts; `vector` needs no typmod (not part of the
 * signature).
 */
export const MATCH_THOUGHTS_SIGNATURE = "match_thoughts(vector, float, int, jsonb, float, float)";
export const SEARCH_THOUGHTS_HYBRID_SIGNATURE = "search_thoughts_hybrid(vector, text, float, int, jsonb, float, float)";
/**
 * update_thought's signature since migration 046 (SMD-1730): a tenth,
 * defaulted parameter, `p_event`, the write event {stance, cites, valid_from,
 * valid_until, trust, actor_kind} the audit trigger stamps on the row — after
 * 032's ninth, `p_provenance`, the envelope that sets or clears `supersedes`
 * and `derived_from`, and 021's eighth, `p_embedding_model`, the model that
 * produced the vector being written. Each dropped the form before it first,
 * for the reason above: CREATE OR REPLACE with a new parameter leaves the old
 * form beside it, and every call with fewer arguments is then "function is
 * not unique". reembed.ts resolves the body it will call by this text (for
 * 018's sentinel), and preflight's `edit signature` check reads the forms
 * beside it.
 */
export const UPDATE_THOUGHT_SIGNATURE = "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb, jsonb)";
/**
 * 032's form, the one 046 replaced: what a brain at 044 still carries, what
 * reembed.ts probes for to name 046 as the missing file, and what a test that
 * stops at 032 or 033 reads. One spelling (sixth review pass: three). Every
 * type in both signatures is unparameterised — preflight's `edit signature`
 * counts the commas for the arity, and a `vector(1024)` or `numeric(10,2)`
 * here would count one too many.
 */
export const UPDATE_THOUGHT_SIGNATURE_9 = "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)";
/**
 * The forms 020, 021, 032 and 046 dropped. Still owned: a bench's "before"
 * arm re-applies 014 or 017, and a test re-applies 018, 021, 032 or 033,
 * re-creating them, so a schema reset must drop them too.
 */
export const SUPERSEDED_SIGNATURES = Object.freeze([
  "match_thoughts(vector, float, int, jsonb)",
  "search_thoughts_hybrid(vector, text, float, int, jsonb)",
  "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)",
  "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)",
  UPDATE_THOUGHT_SIGNATURE_9,
]);

/**
 * The functions the core migrations define, each with the file that last
 * defines it (SMD-1250). `files` is the migrations as [name, text] pairs in
 * apply order — read by the caller, since this module is imported by the
 * Workers build and cannot touch the filesystem. A statement at the start of
 * a line, comments stripped first so a header quoting one is not it
 * (test-schema [10]'s rule). Read from the files, never typed: a list would
 * lag the next migration. scripts/check-fork-consistency.ts check 7 fails a
 * vendored file that redefines or drops one of these; test-schema [31] holds
 * the set to what preflight's remedies name.
 */
export function ownedFunctionsIn(files) {
  const owned = new Map();
  for (const [name, text] of files) {
    // Dollar-quoted bodies first (a `/*` inside one would otherwise swallow
    // every definition up to the next `*/`, shrinking the set with no error;
    // a CREATE inside a DO block is not a definition), then comments.
    const sql = text.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    for (const m of sql.matchAll(/^\s*CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gim)) owned.set(m[1].toLowerCase(), name);
  }
  return owned;
}

/**
 * The statement shapes that redefine, remove or re-comment the function `fn`,
 * at the start of a line (a blockquote prefix allowed, a `--` comment not),
 * any case, the name bare or schema-qualified, quoted or not — the quoting a
 * Supabase dashboard export or `supabase db diff` emits (first review pass) —
 * and the name on the line after the keyword (fourth pass), which is why the
 * regex is multiline and tested against a whole text, not a line. PROCEDURE
 * and ROUTINE too: a procedure shares pg_proc's namespace with a function of
 * the same name and argument types. check 7 tests every vendored file against
 * this; test-schema [31] tests the fixed enhanced-thoughts file against it.
 */
export const coreFunctionStatement = (fn) =>
  new RegExp(String.raw`^[ \t]*(?:>[ \t]*)*(?:(?:CREATE(?:\s+OR\s+REPLACE)?|DROP|ALTER)\s+(?:FUNCTION|PROCEDURE|ROUTINE)|COMMENT\s+ON\s+(?:FUNCTION|PROCEDURE|ROUTINE))\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:"?public"?\.)?"?${fn}"?\s*(?:\(|;|\bIS\b|$)`, "im");

/**
 * The columns of `thoughts` whose COMMENT a core migration writes, each with
 * the file that last writes it (SMD-1250, fourth review pass). 021 and 025
 * put a data contract in a column comment (the SMD-1052 rule), and upstream's
 * provenance-chains schema carried a `COMMENT ON COLUMN thoughts.derived_from`
 * that would have overwritten 025's — the one thing that file did do
 * silently, its function bodies having failed on the return type. Same
 * reading as ownedFunctionsIn: bodies and comments stripped, start of line.
 */
export function ownedColumnCommentsIn(files) {
  const owned = new Map();
  for (const [name, text] of files) {
    const sql = text.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
    for (const m of sql.matchAll(/^\s*COMMENT\s+ON\s+COLUMN\s+(?:public\.)?thoughts\.([a-z_][a-z0-9_]*)\s+IS\b/gim)) owned.set(m[1].toLowerCase(), name);
  }
  return owned;
}
/** The statement that re-comments `thoughts.col`, at the start of a line, any case, quoted or schema-qualified or not. */
export const coreColumnCommentStatement = (col) =>
  new RegExp(String.raw`^[ \t]*(?:>[ \t]*)*COMMENT\s+ON\s+COLUMN\s+(?:"?public"?\.)?"?thoughts"?\."?${col}"?\s*(?:\bIS\b|$)`, "im");

/**
 * How preflight recognises the shipped upsert_thought bodies where no sentinel
 * declares them (SMD-1250). A CREATE OR REPLACE from outside the migrations —
 * a vendored schema, the getting-started guide pasted again, an earlier
 * migration re-applied by hand — replaces a body without an error when the
 * signature matches, and 005 predates the sentinel convention while 025 kept
 * 022's sentinel rather than adding one. Each regex is the one clause that
 * migration added and no earlier body has: 005 refuses a non-object payload;
 * 025 writes the provenance envelope. test-schema [31] holds each against the
 * body it names and against the body before it. 033 declares itself with a
 * sentinel of its own, `ob1:capture-takes-fingerprint-lock`, and 035 — the
 * last definer of both forms — with `ob1:re-capture-writes-no-provenance` in
 * the 3-argument body; both read inline as 022's is. The two regexes still
 * tell which earlier body an unlocked one is.
 */
export const UPSERT_TWO_ARG_SHIPPED_RE = /jsonb_typeof\(p_payload\)\s*<>\s*'object'/;
export const UPSERT_THREE_ARG_SHIPPED_RE = /p_payload\s*->\s*'derived_from'/;
/**
 * Two more, from the fourth review pass, which installed upstream's files on
 * a real brain: 015's release_thought and release_claims_for_worker clear the
 * lease (`ttl_expires_at = NULL`) as 015's CHECK requires — upstream's
 * release_thought leaves it set, so every worker release fails the
 * constraint, and its release_claims_for_worker deletes the rows instead;
 * 024's thought_stats_summary unnests topics only when they are an array —
 * the recipe's body it came from raises on a null element.
 */
export const RELEASE_SHIPPED_RE = /ttl_expires_at\s*=\s*NULL/;
export const THOUGHT_STATS_SHIPPED_RE = /jsonb_typeof\(metadata\s*->\s*'topics'\)/;

/**
 * `pg_settings.source` values under which a setting reaches EVERY role in the
 * database — the server's configuration (postgresql.conf and ALTER SYSTEM both
 * report 'configuration file'; a managed parameter group, the command line,
 * the environment likewise server-wide) or the database itself. 'global' and
 * 'override' are internal sources kept for completeness. A role-level value
 * ('user', 'database user') reaches one role, and a session value nobody else;
 * neither is a reason for 014 to skip seeding the database-level default,
 * which sits BELOW a role's value in precedence and ABOVE the server's — so
 * seeding over a role-level value undoes nothing, and seeding over ALTER
 * SYSTEM would silently undo it (tenth review pass). One limit: the migrating
 * session sees server configuration as of its connect, so an ALTER SYSTEM that
 * has not been reloaded looks unset and is seeded over; reload before
 * migrating (deploy/.env.example says so).
 */
export const SHARED_SETTING_SOURCES = ["environment variable", "configuration file", "command line", "global", "override", "database"];

/**
 * The database-level settings row for the current database, as `setconfig`
 * (`name=value` strings). One text because the tenth review pass found it
 * written five times in three idioms. Parse with parseSetConfig.
 */
export const DB_LEVEL_SETTINGS_SQL =
  "SELECT s.setconfig AS cfg FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = current_database() AND s.setrole = 0";

/** `["a=1","b=x"]` → `{a: "1", b: "x"}`; a value may itself contain `=`. */
export function parseSetConfig(cfg) {
  const out = {};
  for (const kv of cfg ?? []) {
    const eq = kv.indexOf("=");
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

/**
 * Make the bare `vector` type resolve for THIS session, when pgvector is
 * installed into a schema that is not on the connection's search_path.
 *
 * `CREATE EXTENSION IF NOT EXISTS vector` finds an extension already installed
 * elsewhere and does nothing, and then `vector(N)` and `vector_cosine_ops` do
 * not resolve — the `type "vector" does not exist` error on a database that
 * demonstrably has pgvector (Supabase's `extensions` schema, and several managed
 * providers, ship it this way; upstream #319). The migration chain is ours, so
 * the fix is: resolve the extension's schema and append it to the session's
 * search_path, once, before any migration runs. One place covers every
 * migration, where schema-qualifying spreads across 001, 002, 014, 019, 020,
 * 021 and every future one and fails the same way at the first missed site.
 *
 * This changes only the calling SESSION (`set_config(..., false)` is session
 * scope and survives into each later transaction on the same connection); it
 * does not `ALTER DATABASE` or `ALTER ROLE`, so it leaves no persistent change
 * on the caller's database — the running server's own connection is a separate
 * session, and preflight's `vector extension` check is what names the persistent
 * fix (ALTER ROLE / ALTER DATABASE) for that. Appending a schema at the END of
 * the path can only make more names resolve, never shadow one that already did.
 *
 * A no-op in the normal case: on a database where `vector` already resolves the
 * query returns no row, and where pgvector is not installed at all it also
 * returns none (migration 001 then creates it into the first schema on the
 * path). Returns the schema it added, or null.
 *
 * Bun.sql only (a tagged-template client); PGlite loads pgvector into the path
 * itself and does not need this.
 */
export async function alignVectorSearchPath(sql) {
  const rows = await sql`
    SELECT n.nspname AS schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'vector' AND to_regtype('vector') IS NULL`;
  const schema = rows[0]?.schema ?? null;
  if (schema) {
    await sql`SELECT set_config('search_path', current_setting('search_path') || ', ' || quote_ident(${schema}), false)`;
  }
  return schema;
}

/**
 * The table privileges this fork's SECURITY INVOKER functions need to run as
 * their caller. Every function 010/012/015 declares is SECURITY INVOKER, so the
 * writes they make — chunk rows, audit rows, work claims, entity rows — run as
 * the connecting role, not the definer, and reach beyond `thoughts` since 007.
 * Upstream never hit this: Supabase's `service_role` holds default privileges on
 * the public schema. A self-hosted role set up from the guide's `GRANT … ON
 * thoughts` alone can capture nothing — its first windowed capture fails on
 * `thought_chunks`, and the audit trigger fails on `thought_audit`.
 *
 * One list, grouped by the role that needs each group, each row naming the
 * migration that introduced the requirement. This is the single spelling:
 * preflight's `write privileges` check reads CAPTURE_WRITES, `migrate.ts
 * --grant` issues every group through grantStatements(), and db/README.md's
 * "Grants for a capturing role" is rendered from the same groups — a
 * check-fork-consistency check asserts the README names each table.
 *
 * Privileges are the DML a group's functions actually run, no more: SELECT where
 * a function reads, and only the write verbs its statements use.
 */
export const ROLE_GRANTS = Object.freeze({
  // The server's own connection. Every item is unconditional on the core path —
  // a windowed capture, an edit with content, a search, a delete — so a role
  // missing any of these fails a capture outright, and preflight refuses it.
  capture: Object.freeze([
    Object.freeze({ table: "thoughts",       privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "001" }),
    Object.freeze({ table: "thought_chunks", privileges: Object.freeze(["SELECT", "INSERT", "DELETE"]),           since: "007" }),
    Object.freeze({ table: "thought_audit",  privileges: Object.freeze(["INSERT"]),                                since: "008" }),
    // 042's guard runs as the caller on EVERY delete of a thought: it reads the
    // citations that name the row and, detaching, writes them. A role without
    // these cannot delete any thought, cited or not.
    Object.freeze({ table: "thought_facets", privileges: Object.freeze(["SELECT", "UPDATE"]),                     since: "042" }),
    // 046's audit trigger runs as the caller on EVERY write that carries an
    // actor: it reads the key's kind from ob1_agents (by id, else by name). A
    // role without SELECT there fails every capture, edit and delete inside the
    // trigger — so SELECT is hard here, while the writes resolve_agent makes
    // stay soft, in `server` below (SMD-1730, first review pass).
    Object.freeze({ table: "ob1_agents",     privileges: Object.freeze(["SELECT"]),                               since: "046" }),
  ]),
  // The server's soft extras, beyond the hard capture set: preflight reads its
  // own `ob1_config` as this role, and `resolve_agent` (010, SECURITY INVOKER)
  // attributes a write when a key is presented — and it UPSERTs both agent
  // tables (last_used_at, and registering an agent/key), so SELECT alone leaves
  // it raising. Since 054 a known key's lookup writes only when stale or on a
  // scope change, so a missing UPDATE can show up minutes after a start that
  // looked fine (a registration still needs it at once). A capture tolerates
  // all of this (SELECT on ob1_agents excepted, which 046's trigger made hard
  // — above): the resolve step is caught
  // (agents.ts) and attribution degrades, and preflight only warns on the
  // config read. Documented and granted, not enforced — but granted with the
  // writes `resolve_agent` actually makes, so attribution works when it lands.
  server: Object.freeze([
    Object.freeze({ table: "ob1_config",     privileges: Object.freeze(["SELECT"]),                    since: "006" }),
    Object.freeze({ table: "ob1_agents",     privileges: Object.freeze(["SELECT", "INSERT", "UPDATE"]), since: "010" }),
    Object.freeze({ table: "ob1_agent_keys", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE"]), since: "010" }),
    // capture_thought reads a target's capture row when a capture-only key names
    // `supersedes` (SMD-1298): that key may replace only what it wrote. Soft as
    // the rest of this group — a role without it is refused THAT pointer, with
    // this grant named, and captures on (second review pass: the capture group
    // holds INSERT alone, and the read failed under the documented role).
    Object.freeze({ table: "thought_audit",  privileges: Object.freeze(["SELECT"]),                    since: "008" }),
  ]),
  // A worker role — reembed.ts, consolidate.ts, extract-entities.ts — claims and
  // releases work, upserts its job key into `ob1_config` (reembed's
  // --switch-model, extract's key), and, for consolidate.ts, records and
  // resolves proposals in `supersession_proposals` (029's SECURITY INVOKER
  // record/accept functions run as the caller).
  worker: Object.freeze([
    Object.freeze({ table: "thought_work_claims",    privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "015" }),
    Object.freeze({ table: "ob1_config",             privileges: Object.freeze(["INSERT", "UPDATE"]),                     since: "006" }),
    Object.freeze({ table: "supersession_proposals", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE"]),          since: "029" }),
  ]),
  // The entity-extraction worker, additionally, writes the entity graph.
  extraction: Object.freeze([
    Object.freeze({ table: "ob1_entities",     privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "016" }),
    Object.freeze({ table: "thought_entities", privileges: Object.freeze(["SELECT", "INSERT", "DELETE"]),           since: "016" }),
    Object.freeze({ table: "ob1_entity_edges", privileges: Object.freeze(["SELECT", "INSERT", "DELETE"]),           since: "016" }),
  ]),
  // The opt-in query log (034, SMD-1295): the server writes one row per search
  // and one per follow-up touch, but ONLY when OB1_QUERY_LOG=on. INSERT is all
  // the server does; prune_query_log runs as the owner. Granted so a self-hosted
  // role can turn the flag on and have it work — but off by default and not read
  // by preflight (it cannot see a server env flag), so unlike the capture set a
  // role missing this INSERT is not refused, only reported by the `query log`
  // check as "log off; grant needed if you enable it".
  querylog: Object.freeze([
    Object.freeze({ table: "query_log", privileges: Object.freeze(["INSERT"]), since: "034" }),
  ]),
  // The community schemas under schemas/ (SMD-1796), applied by hand beside the
  // migrations. Upstream's files granted these to Supabase's `service_role`
  // (and enabled RLS with a policy for it) — a role that does not exist on plain
  // Postgres, so the first GRANT stopped each file there. Those statements are
  // gone from the files; this group is what replaces them, so the one grant
  // path knows the community tables too. `since` names the file, not a
  // migration. The privileges are the ones upstream gave its service role
  // (GRANT ALL read as the four DML verbs; append-only tables keep SELECT,
  // INSERT), plus the two things Supabase's default privileges hid: a
  // BIGSERIAL column needs USAGE on its sequence (an identity column does not —
  // test-schema [40] measures both), and a function REVOKEd FROM PUBLIC needs
  // an EXECUTE. Functions upstream left executable by PUBLIC are not listed:
  // EXECUTE is PUBLIC's by default. thought-work-claims adds nothing a grant
  // could cover (015 already created what it creates); thought-audit's table is
  // 008's, listed here for the SELECT upstream gave beside `capture`'s INSERT.
  // Presence is per object, not per file: the two rows whose tables a
  // migration also creates (thought_audit, thought_entities) are therefore
  // issued on every migrated brain, community schema applied or not — so the
  // audit row adds only the SELECT upstream gave (the operator reading its own
  // audit log; nothing under schemas/ reads the table — the first review pass
  // caught the claim that author-session-id's readers do: they read `thoughts`),
  // and the mention row is kept to exactly what `extraction` already grants, so
  // the merge widens nothing. A `view` row is a SELECT on a view: GRANT and
  // to_regclass take a view as a table, but DROP TABLE does not, so it is its
  // own kind and grantedTables() leaves it out (test-support's drop list).
  community: Object.freeze([
    // schemas/thought-audit (008's table, and author-session-id.sql's view over `thoughts` — a view needs its own SELECT)
    Object.freeze({ table: "thought_audit", privileges: Object.freeze(["SELECT", "INSERT"]), since: "schemas/thought-audit" }),
    Object.freeze({ view: "thought_provenance", privileges: Object.freeze(["SELECT"]), since: "schemas/thought-audit" }),
    // schemas/agent-memory
    Object.freeze({ table: "agent_memories",              privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    Object.freeze({ table: "agent_memory_source_refs",    privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    Object.freeze({ table: "agent_memory_artifacts",      privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    Object.freeze({ table: "agent_memory_relations",      privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    Object.freeze({ table: "agent_memory_review_actions", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    Object.freeze({ table: "agent_memory_recall_traces",  privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    Object.freeze({ table: "agent_memory_recall_items",   privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    Object.freeze({ table: "agent_memory_audit_events",   privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/agent-memory" }),
    // schemas/per-agent-identity (the SECURITY DEFINER lookup is REVOKEd FROM PUBLIC)
    Object.freeze({ table: "openbrain_agents",  privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/per-agent-identity" }),
    Object.freeze({ table: "agent_memory_keys", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/per-agent-identity" }),
    Object.freeze({ function: "lookup_agent_memory_key(text)", privileges: Object.freeze(["EXECUTE"]), since: "schemas/per-agent-identity" }),
    // schemas/smart-ingest (bigserial ids; the SECURITY DEFINER append is REVOKEd FROM PUBLIC)
    Object.freeze({ table: "ingestion_jobs",  privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/smart-ingest" }),
    Object.freeze({ table: "ingestion_items", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/smart-ingest" }),
    Object.freeze({ sequence: "ingestion_jobs_id_seq",  privileges: Object.freeze(["USAGE", "SELECT"]), since: "schemas/smart-ingest" }),
    Object.freeze({ sequence: "ingestion_items_id_seq", privileges: Object.freeze(["USAGE", "SELECT"]), since: "schemas/smart-ingest" }),
    Object.freeze({ function: "append_thought_evidence(bigint, jsonb)", privileges: Object.freeze(["EXECUTE"]), since: "schemas/smart-ingest" }),
    // schemas/entity-extraction (upstream's `entities`/`edges`, not 016's ob1_* tables; three bigserial ids;
    // `thought_entities` is the one name the two share — on a migrated brain the file's IF NOT EXISTS
    // leaves 016's table, so this row is `extraction`'s privileges exactly, not upstream's GRANT ALL:
    // a row issued on every migrated brain must not widen what 016's own group grants)
    Object.freeze({ table: "entities",                privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/entity-extraction" }),
    Object.freeze({ table: "edges",                   privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/entity-extraction" }),
    Object.freeze({ table: "thought_entities",        privileges: Object.freeze(["SELECT", "INSERT", "DELETE"]),           since: "schemas/entity-extraction" }),
    Object.freeze({ table: "entity_extraction_queue", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/entity-extraction" }),
    Object.freeze({ table: "consolidation_log",       privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/entity-extraction" }),
    Object.freeze({ sequence: "entities_id_seq",          privileges: Object.freeze(["USAGE", "SELECT"]), since: "schemas/entity-extraction" }),
    Object.freeze({ sequence: "edges_id_seq",             privileges: Object.freeze(["USAGE", "SELECT"]), since: "schemas/entity-extraction" }),
    Object.freeze({ sequence: "consolidation_log_id_seq", privileges: Object.freeze(["USAGE", "SELECT"]), since: "schemas/entity-extraction" }),
    // schemas/typed-reasoning-edges (bigserial id; the upsert RPC is REVOKEd FROM PUBLIC)
    Object.freeze({ table: "thought_edges", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/typed-reasoning-edges" }),
    Object.freeze({ sequence: "thought_edges_id_seq", privileges: Object.freeze(["USAGE", "SELECT"]), since: "schemas/typed-reasoning-edges" }),
    Object.freeze({ function: "thought_edges_upsert(uuid, uuid, text, numeric, integer, text, timestamptz, timestamptz, jsonb)", privileges: Object.freeze(["EXECUTE"]), since: "schemas/typed-reasoning-edges" }),
    // schemas/wiki-pages (revisions are append-only; the three RPCs are REVOKEd FROM PUBLIC; the identity id needs no sequence grant)
    Object.freeze({ table: "wiki_pages",             privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/wiki-pages" }),
    Object.freeze({ table: "wiki_sections",          privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/wiki-pages" }),
    Object.freeze({ table: "wiki_section_revisions", privileges: Object.freeze(["SELECT", "INSERT"]),                     since: "schemas/wiki-pages" }),
    Object.freeze({ function: "wiki_upsert_page(text, text, text, jsonb, text)",                               privileges: Object.freeze(["EXECUTE"]), since: "schemas/wiki-pages" }),
    Object.freeze({ function: "wiki_write_section(uuid, text, text, text, text, jsonb, uuid[], integer, text)", privileges: Object.freeze(["EXECUTE"]), since: "schemas/wiki-pages" }),
    Object.freeze({ function: "wiki_accept_pending(uuid, text)",                                                privileges: Object.freeze(["EXECUTE"]), since: "schemas/wiki-pages" }),
    // schemas/crm-person-tiers
    Object.freeze({ table: "crm_persons",         privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/crm-person-tiers" }),
    Object.freeze({ table: "crm_person_mentions", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/crm-person-tiers" }),
    // schemas/readwise-books (upstream granted the table nothing — its integration wrote it through Supabase's default privileges)
    Object.freeze({ table: "readwise_books", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]), since: "schemas/readwise-books" }),
    // schemas/provenance-chains (two SECURITY DEFINER merges, REVOKEd FROM PUBLIC)
    Object.freeze({ function: "merge_thought_provenance_metadata(uuid, jsonb)", privileges: Object.freeze(["EXECUTE"]), since: "schemas/provenance-chains" }),
    Object.freeze({ function: "merge_thought_eval_metadata(uuid, jsonb)",       privileges: Object.freeze(["EXECUTE"]), since: "schemas/provenance-chains" }),
  ]),
});

/** The order groups are issued and documented in. */
export const ROLE_GRANT_GROUPS = Object.freeze(["capture", "server", "worker", "extraction", "querylog", "community"]);

/**
 * The (table, privilege) pairs the core capture/edit/search path needs
 * unconditionally — preflight's `write privileges` refusal set. Flattened from
 * ROLE_GRANTS.capture so the check and the docs cannot disagree.
 */
export const CAPTURE_WRITES = Object.freeze(
  ROLE_GRANTS.capture.flatMap((g) =>
    g.privileges.map((p) => Object.freeze({ table: g.table, privilege: p, since: g.since }))),
);

/**
 * The (table, privilege) pairs 016's entity-extraction enqueue trigger adds to
 * the capture path — but only while `ob1_config.entity_extraction_key` is set.
 * That trigger fires `AFTER INSERT OR UPDATE OF content ON thoughts`, runs as the
 * calling role (SECURITY INVOKER), and upserts a `thought_work_claims` row
 * (`INSERT … ON CONFLICT DO UPDATE`) — so once extraction is enabled, every
 * capture and content-edit needs INSERT and UPDATE there, even for a role that
 * never runs a worker. Preflight folds these into the `write privileges` check
 * exactly when the key is set; a brain that never enabled extraction never needs
 * them. `thought_work_claims` is 015's; the requirement is 016's trigger.
 */
export const EXTRACTION_TRIGGER_WRITES = Object.freeze([
  Object.freeze({ table: "thought_work_claims", privilege: "INSERT", since: "016" }),
  Object.freeze({ table: "thought_work_claims", privilege: "UPDATE", since: "016" }),
]);

/**
 * The opt-in query log (migration 034, SMD-1295) — the one spelling the server,
 * preflight and the tests share. `flag`/`on` is the env switch and its "on"
 * value (the fork's on/off idiom); `table` and `prune` are the objects 034
 * creates; `tools` lists the handlers that write each kind of row; `retentionEnv`
 * and `retentionDaysDefault` are prune_query_log's window. Off by default:
 * absent or any value other than `on` leaves the server writing nothing.
 */
export const QUERY_LOG = Object.freeze({
  flag: "OB1_QUERY_LOG",
  on: "on",
  table: "query_log",
  prune: "prune_query_log",
  retentionEnv: "OB1_QUERY_LOG_RETENTION_DAYS",
  retentionDaysDefault: 30,
  // The tools whose calls produce each kind of row, for the doc/tests to read.
  searchTools: Object.freeze(["search", "search_thoughts"]),
  actionTools: Object.freeze(["fetch", "update_thought", "delete_thought"]),
});

/** True when a server env selects the query log on (the fork's "on" idiom). */
export function queryLogEnabled(env) {
  return (env?.[QUERY_LOG.flag] ?? "").toString().trim().toLowerCase() === QUERY_LOG.on;
}

/** prune_query_log's retention window in days, from the env or the default. */
export function queryLogRetentionDays(env) {
  const raw = env?.[QUERY_LOG.retentionEnv];
  if (raw === undefined || raw === null || `${raw}`.trim() === "") return QUERY_LOG.retentionDaysDefault;
  const n = Number.parseInt(`${raw}`.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : QUERY_LOG.retentionDaysDefault;
}

/**
 * A ROLE_GRANTS row's object: the one of `table`, `view`, `sequence` or
 * `function` it names, with its kind. A function is named with its argument
 * types, as GRANT and to_regprocedure take it (SMD-1796).
 */
export function grantObjectOf(row) {
  if (row.table) return { kind: "table", name: row.table };
  if (row.view) return { kind: "view", name: row.view };
  if (row.sequence) return { kind: "sequence", name: row.sequence };
  if (row.function) return { kind: "function", name: row.function };
  throw new Error(`ROLE_GRANTS row names no table, view, sequence or function: ${JSON.stringify(row)}`);
}
/** Every object named across the given groups (default: all), in group/list order, de-duplicated by name: [{ kind, name }]. */
export function grantedObjects(groups = ROLE_GRANT_GROUPS) {
  const seen = new Set();
  const out = [];
  for (const g of groups) for (const row of ROLE_GRANTS[g] ?? []) { const o = grantObjectOf(row); if (!seen.has(o.name)) { seen.add(o.name); out.push(o); } }
  return out;
}
/**
 * Every ROLE_GRANTS row, in group/list order, NOT de-duplicated:
 * `{ group, kind, name, privileges }`. Where grantedObjects() merges by name to
 * answer "is this object documented at all", this keeps an object's rows apart,
 * because db/README.md documents privileges per group and an object can appear
 * in more than one with a different set (`ob1_config`: SELECT in `server`,
 * INSERT/UPDATE in `worker`; `thought_audit`: INSERT in `capture`, SELECT in
 * `server`, SELECT and INSERT in `community`). check-fork-consistency's privilege comparison reads it
 * (SMD-1471).
 */
export function grantRows(groups = ROLE_GRANT_GROUPS) {
  const out = [];
  for (const g of groups) for (const row of ROLE_GRANTS[g] ?? []) {
    const o = grantObjectOf(row);
    out.push({ group: g, kind: o.kind, name: o.name, privileges: [...row.privileges] });
  }
  return out;
}
/** Every table named across the given groups (default: all), in group/list order, de-duplicated. */
export function grantedTables(groups = ROLE_GRANT_GROUPS) {
  return grantedObjects(groups).filter((o) => o.kind === "table").map((o) => o.name);
}
/** Every view named across the given groups (default: all), in order, de-duplicated. */
export function grantedViews(groups = ROLE_GRANT_GROUPS) {
  return grantedObjects(groups).filter((o) => o.kind === "view").map((o) => o.name);
}
/** Every sequence named across the given groups (default: all), in order, de-duplicated. */
export function grantedSequences(groups = ROLE_GRANT_GROUPS) {
  return grantedObjects(groups).filter((o) => o.kind === "sequence").map((o) => o.name);
}
/** Every function (with argument types) named across the given groups (default: all), in order, de-duplicated. */
export function grantedFunctions(groups = ROLE_GRANT_GROUPS) {
  return grantedObjects(groups).filter((o) => o.kind === "function").map((o) => o.name);
}
/**
 * One statement telling which of `objects` (grantedObjects()' shape) exist in
 * `public`, as rows { kind, name, present } in the order given — tables and
 * sequences through to_regclass, functions through to_regprocedure (which takes
 * the argument types as the row spells them). The same text runs under Bun's
 * SQL (`migrate.ts --grant`) and PGlite (test-schema [40]), so the two cannot
 * disagree on what "present" means. Names are config's own literals, quoted as
 * SQL strings all the same.
 */
export function grantPresenceSql(objects) {
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
  if (objects.length === 0) return `SELECT NULL::text AS kind, NULL::text AS name, false AS present WHERE false`;
  const values = objects.map((o, i) => `(${i}, ${lit(o.kind)}, ${lit(o.name)})`).join(", ");
  return `SELECT kind, name,
       CASE WHEN kind = 'function' THEN to_regprocedure('public.' || name) IS NOT NULL
            ELSE to_regclass('public.' || name) IS NOT NULL END AS present
  FROM (VALUES ${values}) AS v(ord, kind, name) ORDER BY ord`;
}
/**
 * GRANT statements giving `role` exactly the privileges the given groups need
 * (default: all — the do-everything role the guide sets up). Pass `present` (a
 * Set of object names that exist — tables, views, sequences and functions alike, the
 * names as the rows spell them) to skip what a partially-migrated database or an
 * unapplied community schema lacks; omit it to emit everything. The role is
 * quoted; the schema USAGE grant is the caller's to add (a schema, not a
 * table). One GRANT per object, its privileges combined, in group/list order.
 */
export function grantStatements(role, { groups = ROLE_GRANT_GROUPS, present = null } = {}) {
  const ident = quoteIdent(role);
  const out = [];
  for (const { kind, name, privileges } of mergedGrants(groups, present)) {
    const privs = privileges.join(", ");
    // A view is granted as a table is (GRANT takes either without a keyword); a
    // sequence's name is a plain identifier; a function's carries its argument
    // list, which GRANT ... ON FUNCTION takes as written.
    out.push(kind === "table" || kind === "view" ? `GRANT ${privs} ON ${name} TO ${ident};` : `GRANT ${privs} ON ${kind.toUpperCase()} ${name} TO ${ident};`);
  }
  return out;
}
/**
 * The groups' rows merged per object — [{ kind, name, privileges }] in
 * group/list order, privileges in a stable order. An object can appear in
 * more than one group with different privileges (ob1_config: SELECT in
 * `server`, INSERT/UPDATE in `worker`; thought_audit: INSERT in `capture`,
 * SELECT and INSERT in `community`), so the role gets one GRANT combining
 * them. `present` (object names) drops what a database lacks. Shared by
 * grantStatements and grantVerifySql so what is granted and what is checked
 * are one list (SMD-1796, third review pass).
 */
export function mergedGrants(groups = ROLE_GRANT_GROUPS, present = null) {
  const ORDER = ["USAGE", "SELECT", "INSERT", "UPDATE", "DELETE", "EXECUTE"];
  const byName = new Map();
  for (const g of groups) {
    for (const row of ROLE_GRANTS[g] ?? []) {
      const o = grantObjectOf(row);
      if (present && !present.has(o.name)) continue;
      const entry = byName.get(o.name) ?? { kind: o.kind, set: new Set() };
      for (const p of row.privileges) entry.set.add(p);
      byName.set(o.name, entry);
    }
  }
  return [...byName].map(([name, { kind, set }]) => ({ kind, name, privileges: ORDER.filter((p) => set.has(p)) }));
}
/**
 * One statement asking whether `role` now holds every privilege in `merged`
 * (mergedGrants()' shape), plus USAGE on schema public: rows { kind, name,
 * privilege, held } in order. Why it exists: a GRANT issued by a role that
 * holds the privilege itself but not WITH GRANT OPTION — the server's own
 * role, say, set up by an earlier --grant and now used to grant a worker —
 * does not fail; Postgres answers `WARNING: no privileges were granted` and
 * the statement succeeds having done nothing, a notice the driver does not
 * surface. Only a grantor with no privilege at all gets 42501. So `--grant`
 * runs this after its GRANTs, in the same transaction, and rolls back naming
 * what was not granted (SMD-1796, third review pass — measured in PGlite: a
 * role with SELECT alone "grants" INSERT to another and has_table_privilege
 * says false). has_table_privilege takes a view as a table; a function is
 * named with its argument types, as the row spells them.
 */
export function grantVerifySql(role, merged) {
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const rows = [{ kind: "schema", name: "public", privilege: "USAGE" }];
  for (const { kind, name, privileges } of merged) for (const privilege of privileges) rows.push({ kind, name, privilege });
  const values = rows.map((r, i) => `(${i}, ${lit(r.kind)}, ${lit(r.name)}, ${lit(r.privilege)})`).join(", ");
  return `SELECT kind, name, privilege,
       CASE kind
         WHEN 'schema'   THEN has_schema_privilege(${lit(role)}, name, privilege)
         WHEN 'sequence' THEN has_sequence_privilege(${lit(role)}, 'public.' || name, privilege)
         WHEN 'function' THEN has_function_privilege(${lit(role)}, 'public.' || name, privilege)
         ELSE                 has_table_privilege(${lit(role)}, 'public.' || name, privilege)
       END AS held
  FROM (VALUES ${values}) AS v(ord, kind, name, privilege) ORDER BY ord`;
}

/**
 * SQL with its comments blanked and everything else kept in place — `--` to end
 * of line and slash-star block comments (nested, as Postgres nests them), outside string
 * literals ('…', '' doubled), quoted identifiers ("…") and dollar-quoted bodies,
 * whose inside is scanned the same way (a plpgsql body's `--` is a comment; its
 * literals are literals). Newlines are kept, so a line number in the result is
 * a line number in the source (SMD-1796; the literal-aware strip SMD-1316 asked
 * for — a `--` inside a string no longer hides the rest of its line). Shared by
 * test-schema [10] and check-fork-consistency's Supabase-isms check through
 * supabaseIsmsIn(); ownedFunctionsIn keeps its own coarser strip, which blanks
 * bodies whole because a CREATE inside one is not a definition.
 */
export function stripSqlComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "-" && d === "-") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = n;
      out += blank(text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; }
        else if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      out += blank(text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      // An E'…' string (016 has one) escapes with a backslash too: `E'\\''`
      // is one quote, and read as two plain quotes it would flip the parity of
      // every literal after it (first review pass).
      const escaped = c === "'" && /[Ee]$/.test(out) && !/\w[Ee]$/.test(out);
      let j = i + 1;
      while (j < n) {
        if (escaped && text[j] === "\\") { j += 2; continue; }
        if (text[j] === c) { if (text[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        if (end !== -1) {
          out += tag + stripSqlComments(text.slice(i + tag.length, end)) + tag;
          i = end + tag.length;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * What a `.sql` file may not run on this fork, each with the reason (SMD-1796).
 * Matched over the whole comment-stripped text, one hit per rule and line, so a
 * statement broken across lines is one hit — string literals included,
 * since `EXECUTE 'GRANT … TO service_role'` runs the grant as surely as the
 * bare statement does — so a header that quotes one of these to explain its
 * absence is not a hit, and a statement is.
 */
export const SUPABASE_SQL_RULES = Object.freeze([
  Object.freeze({ name: "service_role", re: /\bservice_role\b/i,
    msg: "names Supabase's `service_role` — a Supabase-managed role that does not exist on plain Postgres, where the statement fails (`role \"service_role\" does not exist`) and stops the file; grant the connecting role with `migrate.ts --grant` (db/config.mjs ROLE_GRANTS) instead. String literals count (an EXECUTE string runs; a COMMENT ON … IS '…' is flagged too — reword it or move the word to a `--` comment)" }),
  Object.freeze({ name: "supabase-api-role", re: /\b(?:TO|FROM)\s+(?:(?:"?[A-Za-z_][A-Za-z0-9_]*"?|PUBLIC)\s*,\s*)*"?(?:authenticated|anon)\b"?/i,
    msg: "grants to, revokes from or scopes a policy to Supabase's `authenticated`/`anon` — API roles that do not exist on plain Postgres (`role \"authenticated\" does not exist` stops the file); EXECUTE is PUBLIC's by default, and the fork's connecting role is granted through `migrate.ts --grant`" }),
  Object.freeze({ name: "auth-schema", re: /\bauth\.(?:uid|role|jwt|email)\s*\(|\bauth\.users\b/i,
    msg: "reaches GoTrue's `auth` schema (`auth.uid()`, `auth.role()`, `auth.users`), which exists only on Supabase — the statement fails elsewhere, and on Supabase the fork's operator is not an Auth user, so such a policy denies every row; the operator model is SMD-1716" }),
  Object.freeze({ name: "supabase-prefix", re: /\bsupabase_[a-z0-9_]*/i,
    msg: "names a `supabase_`-prefixed role or schema, which exists only on Supabase" }),
  Object.freeze({ name: "rls", re: /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b|\bCREATE\s+POLICY\b/i,
    msg: "enables row-level security or creates a policy — on this fork the connecting role is not the table's owner and has no BYPASSRLS, so RLS with no policy for it denies it every row, and every policy here was written for Supabase's roles; isolation is deferred by decision (SMD-1716), so drop the RLS block rather than port it" }),
]);
/**
 * Every SUPABASE_SQL_RULES hit in `text`: [{ rule, line, msg }], line numbers
 * in the source, one per (rule, line). Matched over the whole stripped text,
 * not per line, so a statement broken across lines — `to\n  authenticated`,
 * `ENABLE ROW LEVEL\n  SECURITY` — is a hit where a per-line scan missed it
 * (first review pass).
 */
export function supabaseIsmsIn(text) {
  const sql = stripSqlComments(text);
  const list = sqlHitList(sql, SUPABASE_SQL_RULES);
  for (const rule of SUPABASE_SQL_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g");
    for (const m of sql.matchAll(re)) list.add(rule.name, m.index);
  }
  return list.sorted();
}
/**
 * The hit list of one rule set over one comment-stripped text: `add(rule,
 * index)` records the (rule, line) once, with the rule's message; `sorted()`
 * returns the hits by line. Line numbers are the source's, since the strip
 * keeps newlines. supabaseIsmsIn and destructiveSqlIn share it.
 */
function sqlHitList(sql, rules) {
  const msgOf = new Map(rules.map((r) => [r.name, r.msg]));
  const seen = new Set();
  const hits = [];
  return {
    add(rule, index) {
      const line = sql.slice(0, index).split("\n").length;
      const key = `${rule}@${line}`;
      if (seen.has(key)) return;
      seen.add(key);
      hits.push({ rule, line, msg: msgOf.get(rule) });
    },
    sorted: () => hits.sort((a, b) => a.line - b.line),
  };
}

/**
 * The statements a `.sql` file may never run, because each destroys rows a
 * brain already holds — CLAUDE.md's SQL-safety guard rail, read as what it
 * means (SMD-1936). A community file is pasted by hand into a running brain and
 * a migration is applied to every operator's, so a file that destroys rows
 * destroys a stranger's memory with no undo. The rail's four shapes, with DROP
 * SCHEMA beside DROP DATABASE (`DROP SCHEMA public CASCADE` is the reset that
 * takes every table with it), read from the comment-stripped text as
 * STATEMENTS rather than words: a `TRUNCATE` is a hit only when a table follows
 * it — `TABLE`, `ONLY`, a name, a format() placeholder (`%I`, `%1$I`) or the
 * `' ||` / `$tag$ ||` of dynamic SQL — so a trigger event (`BEFORE TRUNCATE ON t`: 046's refusing trigger, the rule
 * applied), a privilege (`GRANT TRUNCATE ON`) and the value `TG_OP = 'TRUNCATE'`
 * are not it; a `DELETE FROM` is a hit only when its statement — to its `;`, or
 * to the `)` that closes the CTE it sits in — carries no WHERE, so 034's
 * `DELETE FROM query_log` with the WHERE on the next line passes where
 * upstream's same-line grep failed it, and `DELETE FROM t;` and `DELETE FROM t
 * RETURNING id;` fail; DROP TABLE and DROP DATABASE/SCHEMA/OWNED wherever they
 * stand outside a quoted identifier. String literals are read, as
 * SUPABASE_SQL_RULES reads them: `EXECUTE 'TRUNCATE ' || quote_ident(t)` runs
 * the truncate. A `--` comment quoting a statement is not a hit, so a header
 * may say why the file has none. check-fork-consistency check 21 holds every
 * .sql git tracks to these through destructiveSqlIn().
 */
export const DESTRUCTIVE_SQL_RULES = Object.freeze([
  Object.freeze({ name: "drop-table",
    msg: "drops a table — a SQL file adds to a brain and never removes what it holds (CLAUDE.md's SQL-safety rail: a file must never destroy existing rows); a scratch table is `CREATE TEMP TABLE … ON COMMIT DROP`, as migration 016's `_rte_in` is, and a table an operator no longer wants is theirs to drop by hand, outside any file. String literals count (an EXECUTE string runs); a word in prose belongs in a `--` comment" }),
  Object.freeze({ name: "drop-database",
    msg: "drops a database, a schema, or everything a role owns (`DROP OWNED BY`) — every table in it and every row with it (CLAUDE.md's SQL-safety rail: a file must never destroy existing rows); no file in this repository builds or resets a database, and an operator's reset is theirs to run by hand. String literals count; a word in prose belongs in a `--` comment" }),
  Object.freeze({ name: "truncate",
    msg: "truncates a table (CLAUDE.md's SQL-safety rail: a file must never destroy existing rows); a trigger event (`BEFORE TRUNCATE ON t`, which REFUSES it) and a privilege (`GRANT TRUNCATE ON`) are not this statement and pass. String literals count (an EXECUTE string runs); a word in prose belongs in a `--` comment, or reworded (`'never truncated'`)" }),
  Object.freeze({ name: "unqualified-delete",
    msg: "a DELETE FROM whose statement has no WHERE clause of its own — every row of the table (CLAUDE.md's SQL-safety rail: a file must never destroy existing rows); name the rows (`WHERE id = $1`, on any line of the statement; a `WHERE true` on a TEMP table the file itself made, as 016's `_rte_in`, is the letter of the rule) — a WHERE inside a subquery or a USING source does not count, nor one inside a string when the file runs the DELETE itself. String literals count (an EXECUTE string or a format() template is read to its `;` or closing `)`); a statement quoted in prose belongs in a `--` comment" }),
]);
/**
 * What may follow TRUNCATE for it to be the statement: the TABLE/ONLY keywords,
 * then a bare or quoted name that is not the keyword ending a trigger event or a
 * privilege list (`ON`, `OR`, `TO`, …), a format() placeholder (`%I`, `%s`, the
 * positional `%1$I`), or the closing quote — `'` or a dollar tag — and `||` of a
 * statement built by concatenation. A keyword inside a quoted identifier
 * (`SELECT "TRUNCATE" FROM t`, `"my TRUNCATE"`) names a column, not a
 * statement: destructiveSqlIn skips a match that blankSqlLiterals marks as
 * one (first and second review passes).
 */
const TRUNCATE_TARGET = String.raw`\bTRUNCATE\b\s*(?:(?:TABLE|ONLY)\s+)*(?:"|%(?:\d+\$)?[Is]|(?:'|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)\s*\|\||(?!(?:ON|OR|TO|FROM|AND|THEN|ELSE|END|IN|IS|WHEN)\b)[\p{L}_][\p{L}\p{N}_$.]*)`; // \p: an unquoted name may be non-ASCII (`TRUNCATE Übersicht`), matched with the u flag
/** What blankSqlLiterals writes over the inside of a quoted identifier, so a caller can tell one from a string literal (blanked to spaces). */
const IDENT_FILL = "~";
/**
 * `sql` (comments already stripped) with the inside of every string literal
 * blanked to spaces and of every quoted identifier to IDENT_FILL, the quotes
 * kept and every position where it was, a dollar-quoted body scanned within
 * its own bounds (an apostrophe in a `$$…$$` value cannot open a literal that
 * runs to the end of the file — second review pass) and its tags left alone —
 * so a `(`, `)`, `;` or WHERE inside a literal moves no statement boundary and
 * qualifies nothing (first review pass), and a keyword inside `"…"` is known
 * for the column name it is. The quote rules are stripSqlComments's: `''`
 * doubled, an E'…' string escaping with a backslash, `$tag$` grammar.
 */
function blankSqlLiterals(sql) {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const escaped = c === "'" && /[Ee]$/.test(out) && !/\w[Ee]$/.test(out);
      let j = i + 1;
      while (j < n) {
        if (escaped && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; }
        j++;
      }
      out += c + sql.slice(i + 1, j).replace(/[^\n]/g, c === "'" ? " " : IDENT_FILL) + (j < n ? c : "");
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          out += tag + blankSqlLiterals(sql.slice(i + tag.length, end)) + tag;
          i = end + tag.length;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}
/** A closing dollar tag followed by `||`: the statement is a dollar-quoted string concatenated onward, read raw like a `'…'` one. */
const DOLLAR_CONCAT = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$\s*\|\|/;
/** Where the statement continuing at `from` ends in `text`: its `;`, or the text's end. */
function statementEnd(text, from) {
  const i = text.indexOf(";", from);
  return i === -1 ? text.length : i;
}
/**
 * Whether the statement that continues at `from` in `text` carries a WHERE of
 * its own: read to its `;`, to the `)` that closes the parenthesis it sits in
 * (a CTE's `WITH d AS (DELETE FROM …)`, a `format('DELETE FROM %I', t)`), or
 * the end of the text, and a WHERE counts only at depth 0 — one inside a
 * subquery in USING or in a format() argument qualifies nothing (first review
 * pass). `text` is the literal-blanked copy for a statement the file runs, the
 * raw copy for one inside a string — `'…'`, or a dollar-quoted one concatenated
 * onward — whose WHERE may be concatenated on.
 */
function whereQualifies(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") { if (depth === 0) return false; depth--; }
    else if (c === ";") return false;
    else if (depth === 0 && (c === "w" || c === "W") && /^where\b/i.test(text.slice(i, i + 6)) && !/\w/.test(text[i - 1] ?? "")) return true;
  }
  return false;
}
/**
 * Every DESTRUCTIVE_SQL_RULES hit in `text`: [{ rule, line, msg }], line numbers
 * in the source (stripSqlComments keeps newlines), one per (rule, line), sorted
 * by line. Comments excepted; string literals and dollar-quoted bodies read.
 */
export function destructiveSqlIn(text) {
  const sql = stripSqlComments(text);
  const flat = blankSqlLiterals(sql);
  const list = sqlHitList(sql, DESTRUCTIVE_SQL_RULES);
  // A keyword inside a quoted identifier names a column (`"my TRUNCATE"`), not a statement.
  const inIdentifier = (i) => flat[i] === IDENT_FILL;
  for (const m of sql.matchAll(/\bDROP\s+TABLE\b/gi)) if (!inIdentifier(m.index)) list.add("drop-table", m.index);
  for (const m of sql.matchAll(/\bDROP\s+(?:DATABASE|SCHEMA|OWNED)\b/gi)) if (!inIdentifier(m.index)) list.add("drop-database", m.index);
  for (const m of sql.matchAll(new RegExp(TRUNCATE_TARGET, "giu"))) if (!inIdentifier(m.index)) list.add("truncate", m.index);
  for (const m of sql.matchAll(/\bDELETE\s+FROM\b/gi)) {
    if (inIdentifier(m.index)) continue;
    // A DELETE inside a string literal, or inside a dollar-quoted string that
    // is concatenated onward (`$q$DELETE FROM $q$ || t || ' WHERE …'` — third
    // review pass), is dynamic SQL: its statement is the string's text and
    // whatever is concatenated onto it, so it is read in `sql`; one the file
    // runs is read in `flat`, where a literal cannot move its boundary or
    // qualify it.
    const end = m.index + m[0].length;
    const inLiteral = flat[m.index] === " " || DOLLAR_CONCAT.test(flat.slice(end, statementEnd(flat, end)));
    if (!whereQualifies(inLiteral ? sql : flat, end)) list.add("unqualified-delete", m.index);
  }
  return list.sorted();
}
