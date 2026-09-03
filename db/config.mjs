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
 * This module is imported by server-portable/index.ts, which bundles for Workers,
 * so a bare `process.env` at module scope would throw at load. The values below
 * are defaults only; the server reads live configuration through its own lazy
 * `env()` so Workers bindings still apply.
 */
const RAW_ENV = /** @type {Record<string, string|undefined>} */ (
  globalThis.process?.env ?? {}
);

/**
 * An empty variable means unset, not "".
 *
 * `??` only catches undefined, so `OB1_EMBEDDING_DIM=` — trivially produced by a
 * blank line in a .env file or a compose `${VAR}` that resolves to nothing — gave
 * `Number("") === 0` and a config refused as "must be a positive integer, got 0".
 * server-portable/index.ts already treated empty as unset because it tests
 * truthiness, so the two disagreed about the same environment: the server would
 * run at the default width while the migration runner refused to start.
 */
const ENV = new Proxy(/** @type {Record<string, string|undefined>} */ ({}), {
  get: (_t, k) => {
    const v = RAW_ENV[/** @type {string} */ (k)];
    return v === "" ? undefined : v;
  },
});

/**
 * Defaults, exported so server-portable/index.ts uses these exact values rather
 * than its own copy. They drifted before; one definition cannot.
 *
 * `qwen3-embedding:4b` at 1024 dimensions is the best configuration measured on
 * real data — 0.933 MRR against `embeddinggemma`'s 0.914 over 97 issues — and the
 * only local model that embeds a long capture whole. It costs about 3x the
 * embedding latency and 2.5 GB, and it is 2560 dimensions natively, so it relies
 * on Matryoshka truncation to fit under pgvector's 2000-dimension HNSW ceiling.
 * See evals/README.md; SETUP.md lists the cheaper alternatives.
 */
export const DEFAULT_EMBEDDING_MODEL = "qwen3-embedding:4b";
export const DEFAULT_EMBEDDING_DIM = 1024;

/**
 * Ollama, because the model defaults are local. These three move together or not
 * at all: pointing local model names at OpenRouter produces a 404 per capture, and
 * the embedding one is fatal rather than degraded. Overriding the provider means
 * overriding the models too, which SETUP.md says and
 * scripts/check-fork-consistency.mjs enforces.
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
export const LLM_BASE_URL = (ENV.OB1_LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");

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
  if (raw !== undefined && raw !== "") return /^(1|on|true|yes)$/i.test(raw);
  const native = KNOWN_MODEL_DIMS[model];
  return MRL_MODELS.has(model) && native !== undefined && dim < native;
}

export const EMBEDDING_DIMENSIONS = resolveEmbeddingDimensions(
  ENV.OB1_EMBEDDING_DIMENSIONS,
  EMBEDDING_DIM,
  EMBEDDING_MODEL
);

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
