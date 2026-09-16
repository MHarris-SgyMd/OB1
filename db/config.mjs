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
 * @param {{ dim?: number, model?: string, trgm?: boolean, chunkContext?: boolean, backfillLimit?: number | null }} overrides
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
 * scripts/check-fork-consistency.mjs on every push, where the collision is
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
 * update_thought's signature since migration 032 (SMD-1323): a ninth,
 * defaulted parameter, `p_provenance`, the envelope that sets or clears
 * `supersedes` and `derived_from` — after 021's eighth, `p_embedding_model`,
 * the model that produced the vector being written. Each dropped the form
 * before it first, for the reason above: CREATE OR REPLACE with a new
 * parameter leaves the old form beside it, and every call with fewer
 * arguments is then "function is not unique". reembed.ts resolves the body it
 * will call by this text (for 018's sentinel), and preflight's
 * `edit signature` check reads the forms beside it.
 */
export const UPDATE_THOUGHT_SIGNATURE = "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text, jsonb)";
/**
 * The forms 020, 021 and 032 dropped. Still owned: a bench's "before" arm
 * re-applies 014 or 017, and a test re-applies 018 or 021, re-creating them,
 * so a schema reset must drop them too.
 */
export const SUPERSEDED_SIGNATURES = Object.freeze([
  "match_thoughts(vector, float, int, jsonb)",
  "search_thoughts_hybrid(vector, text, float, int, jsonb)",
  "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb)",
  "update_thought(uuid, text, jsonb, vector, jsonb, timestamptz, jsonb, text)",
]);

/**
 * The functions the core migrations define, each with the file that last
 * defines it (SMD-1250). `files` is the migrations as [name, text] pairs in
 * apply order — read by the caller, since this module is imported by the
 * Workers build and cannot touch the filesystem. A statement at the start of
 * a line, comments stripped first so a header quoting one is not it
 * (test-schema [10]'s rule). Read from the files, never typed: a list would
 * lag the next migration. scripts/check-fork-consistency.mjs check 7 fails a
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
  ]),
  // The server's soft extras, beyond the hard capture set: preflight reads its
  // own `ob1_config` as this role, and `resolve_agent` (010, SECURITY INVOKER)
  // attributes a write when a key is presented — and it UPSERTs both agent
  // tables (last_used_at, and registering an agent/key), so SELECT alone leaves
  // it raising. A capture tolerates all of this: the resolve step is caught
  // (agents.ts) and attribution degrades, and preflight only warns on the
  // config read. Documented and granted, not enforced — but granted with the
  // writes `resolve_agent` actually makes, so attribution works when it lands.
  server: Object.freeze([
    Object.freeze({ table: "ob1_config",     privileges: Object.freeze(["SELECT"]),                    since: "006" }),
    Object.freeze({ table: "ob1_agents",     privileges: Object.freeze(["SELECT", "INSERT", "UPDATE"]), since: "010" }),
    Object.freeze({ table: "ob1_agent_keys", privileges: Object.freeze(["SELECT", "INSERT", "UPDATE"]), since: "010" }),
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
});

/** The order groups are issued and documented in. */
export const ROLE_GRANT_GROUPS = Object.freeze(["capture", "server", "worker", "extraction", "querylog"]);

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

/** Every table named across the given groups (default: all), in group/list order, de-duplicated. */
export function grantedTables(groups = ROLE_GRANT_GROUPS) {
  const seen = new Set();
  const out = [];
  for (const g of groups) for (const row of ROLE_GRANTS[g] ?? []) if (!seen.has(row.table)) { seen.add(row.table); out.push(row.table); }
  return out;
}

/**
 * GRANT statements giving `role` exactly the privileges the given groups need
 * (default: all — the do-everything role the guide sets up). Pass `present` (a
 * Set of table names that exist) to skip the tables a partially-migrated
 * database lacks; omit it to emit every table. The role is quoted; the schema
 * USAGE grant is the caller's to add (a schema, not a table). One GRANT per
 * table, its privileges combined, in group/list order.
 */
export function grantStatements(role, { groups = ROLE_GRANT_GROUPS, present = null } = {}) {
  const ident = quoteIdent(role);
  // A table can appear in more than one group with different privileges
  // (ob1_config: SELECT in `server`, INSERT/UPDATE in `worker`). Merge per table
  // so the role gets one GRANT combining them, privileges in a stable order.
  const ORDER = ["SELECT", "INSERT", "UPDATE", "DELETE"];
  const byTable = new Map();
  for (const g of groups) {
    for (const row of ROLE_GRANTS[g] ?? []) {
      if (present && !present.has(row.table)) continue;
      const set = byTable.get(row.table) ?? new Set();
      for (const p of row.privileges) set.add(p);
      byTable.set(row.table, set);
    }
  }
  const out = [];
  for (const [table, set] of byTable) out.push(`GRANT ${ORDER.filter((p) => set.has(p)).join(", ")} ON ${table} TO ${ident};`);
  return out;
}
