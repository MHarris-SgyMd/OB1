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
export const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? 1536);

/** The model that must produce exactly EMBEDDING_DIM numbers. */
export const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";

/** Metadata extraction. No schema dependency, so safe to change at any time. */
export const METADATA_MODEL = process.env.OB1_METADATA_MODEL ?? "openai/gpt-4o-mini";

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
 * This matters because **Ollama truncates for every model regardless** — asking a
 * non-MRL model for 256 dimensions returns 256 numbers and no warning. Measured on
 * 97 real documents: `embeddinggemma` (MRL) loses 0.025 MRR going 768 → 256, while
 * `bge-m3` (not MRL) loses 0.042 and its Recall@5 falls from 97% to 92%. Both
 * degrade; the unsupported one degrades faster and just as quietly.
 */
export const MRL_MODELS = new Set([
  "openai/text-embedding-3-small",
  "openai/text-embedding-3-large",
  "embeddinggemma",
  "qwen3-embedding:0.6b",
  "qwen3-embedding:4b",
  "qwen3-embedding:8b",
  "qwen/qwen3-embedding-4b",
  "qwen/qwen3-embedding-8b",
]);

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
export const EMBEDDING_DIMENSIONS =
  /^(1|on|true|yes)$/i.test(process.env.OB1_EMBEDDING_DIMENSIONS ?? "");

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
