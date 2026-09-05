/**
 * embed.ts — how a capture becomes vectors, in one place.
 *
 * Lifted out of index.ts for SMD-946, and not for tidiness. `db/reembed.ts`
 * walks the whole corpus and re-embeds every thought, and it has to produce
 * exactly what a capture would: the same windows, the same blurb rule, the same
 * prompt template, the same whole-content-then-head-window fallback, the same
 * width check. A second copy of that logic in a script is the defect FORK.md
 * keeps finding — a value defined twice — and here the value is every stored
 * vector: two implementations that drift by one separator produce vectors that
 * are not comparable, and nothing reports it.
 *
 * So the server and the re-embed worker call the same function, and the only
 * thing either supplies is configuration. The configuration is resolved from an
 * environment record by `resolveEmbedConfig`, with the defaulting rules index.ts
 * used to hold, so the two cannot disagree about what an unset variable means
 * either. index.ts passes `() => resolveEmbedConfig(env())` because it reads its
 * environment lazily (Cloudflare Workers bindings arrive per request);
 * reembed.ts passes process.env once.
 *
 * Nothing in here imports a database client or a framework, so it builds for
 * every target index.ts does.
 */

import { chunkContent, DEFAULT_MAX_TOKENS, DEFAULT_OVERLAP_TOKENS } from "./chunk.ts";
import {
  applyEmbeddingPrompt,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DIM,
  DEFAULT_METADATA_MODEL,
  DEFAULT_LLM_BASE_URL,
  CHUNK_CONTEXT_PROMPTS,
  composeChunkForEmbedding,
  usableChunkContext,
  resolveChunkContext,
  resolveEmbeddingDimensions,
} from "../db/config.mjs";

/** The environment keys this module reads. A subset of index.ts's Env. */
export type EmbedEnv = {
  OB1_LLM_BASE_URL?: string;
  OB1_LLM_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OB1_EMBEDDING_MODEL?: string;
  OB1_EMBEDDING_DIM?: string;
  OB1_EMBEDDING_DIMENSIONS?: string;
  OB1_CHUNK_TOKENS?: string;
  OB1_CHUNK_OVERLAP?: string;
  OB1_CHUNK_CONTEXT?: string;
  OB1_METADATA_MODEL?: string;
  OB1_METADATA_TEMPERATURE?: string;
  OB1_METADATA_REASONING?: string;
};

export type EmbedConfig = {
  /** Provider base URL, trailing slashes stripped. */
  llmBase: string;
  /** Request headers; carries Authorization only when there is a key. */
  headers: Record<string, string>;
  embeddingModel: string;
  embeddingDim: number;
  /** Whether to send the OpenAI `dimensions` parameter. */
  dimensionsRequested: boolean;
  chunkTokens: number;
  chunkOverlap: number;
  /** Whether to generate a situating blurb per window before embedding it. */
  chunkContext: boolean;
  /** The chat model the blurb is generated with — the metadata model. */
  metadataModel: string;
  metadataTemperature: number;
  /** Extra chat-completion fields controlling reasoning; see metadataReasoning. */
  metadataReasoning: Record<string, unknown>;
};

/**
 * Resolve the embedding configuration from an environment record.
 *
 * Every rule here used to be a small function in index.ts reading `env()`. They
 * are unchanged in what they decide; only where they live moved. An empty
 * string is treated as unset throughout, matching db/config.mjs.
 */
export function resolveEmbedConfig(env: EmbedEnv): EmbedConfig {
  const model = env.OB1_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const dim = env.OB1_EMBEDDING_DIM ? Number(env.OB1_EMBEDDING_DIM) : DEFAULT_EMBEDDING_DIM;
  // A local endpoint needs no credential, so the key is optional there. Sending
  // `Authorization: Bearer undefined` to Ollama is harmless but confusing in
  // logs, so the header is omitted entirely when there is no key.
  const key = env.OB1_LLM_API_KEY || env.OPENROUTER_API_KEY;
  // Number("") is 0, which passes the overlap's `>= 0` below and windowed long
  // captures with NO overlap — and deploy/compose.yaml forwards every optional
  // variable as `${VAR:-}`, so a composed server saw "" wherever the operator
  // set nothing. Empty means unset, as db/config.mjs's ENV proxy already says;
  // the first review of SMD-946 found the server and reembed.ts chunking
  // differently over the same corpus for exactly this reason.
  const chunkTokens = env.OB1_CHUNK_TOKENS ? Number(env.OB1_CHUNK_TOKENS) : NaN;
  const chunkOverlap = env.OB1_CHUNK_OVERLAP ? Number(env.OB1_CHUNK_OVERLAP) : NaN;
  return {
    llmBase: (env.OB1_LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, ""),
    headers: key
      ? { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }
      : { "Content-Type": "application/json" },
    embeddingModel: model,
    embeddingDim: dim,
    /**
     * Whether to ask the provider for a narrower vector, via the OpenAI
     * `dimensions` parameter. This exists so a model whose native width exceeds
     * pgvector's 2000-dimension HNSW ceiling can be used at all:
     * `qwen3-embedding:4b` emits 2560 and cannot be indexed, but truncated to
     * 1024 it scored the best retrieval result measured on real data. Providers
     * apply the parameter to any model, including ones never trained for
     * Matryoshka truncation, with no error either way — so the decision is
     * db/config.mjs's, shared with preflight and the migrator.
     */
    dimensionsRequested: resolveEmbeddingDimensions(env.OB1_EMBEDDING_DIMENSIONS, dim, model),
    // The default is deliberately well under Ollama's 2048-token batch rather
    // than close to it: the token count is an estimate, and a chunk that
    // overshoots is silently truncated, which is the failure being fixed rather
    // than a degradation of it.
    chunkTokens: Number.isFinite(chunkTokens) && chunkTokens > 0 ? chunkTokens : DEFAULT_MAX_TOKENS,
    chunkOverlap: Number.isFinite(chunkOverlap) && chunkOverlap >= 0 ? chunkOverlap : DEFAULT_OVERLAP_TOKENS,
    chunkContext: resolveChunkContext(env.OB1_CHUNK_CONTEXT),
    metadataModel: env.OB1_METADATA_MODEL || DEFAULT_METADATA_MODEL,
    metadataTemperature: metadataTemperature(env.OB1_METADATA_TEMPERATURE),
    metadataReasoning: metadataReasoning(env.OB1_METADATA_REASONING),
  };
}

/** Deterministic by default; overridable for anyone who wants variety. */
function metadataTemperature(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Thinking-capable models reason before answering unless told not to, and a
 * growing share of open-weight models default to it — Gemma 4, Qwen 3,
 * DeepSeek-R1. For a fixed-schema extraction on the interactive path of every
 * capture, that is mostly cost: measured on gemma4, reasoning bought +3 points on
 * the extraction benchmark for 5.5x the latency (7.7s vs 1.4s per capture).
 *
 * So reasoning is OFF by default and opt-in. Note that `think: false` is silently
 * IGNORED on the OpenAI-compatible endpoint — `reasoning_effort` is what it
 * honours, and it is harmless to models with no reasoning mode.
 */
function metadataReasoning(rawValue: string | undefined): Record<string, unknown> {
  const raw = (rawValue ?? "").toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return {};
  if (raw && raw !== "off" && raw !== "false" && raw !== "0") return { reasoning_effort: raw };
  return { reasoning_effort: "none" };
}

export type EmbedKind = "query" | "document";

export type EmbeddedCapture = {
  embedding: number[];
  chunks: { content: string; embedding: number[]; context?: string }[];
  /** Windows that were meant to carry a blurb and went in bare instead. */
  contextFailures: number;
  /**
   * The content was long enough to chunk and the whole-content embedding could
   * not be had, so `embedding` is the head window's vector. The server accepts
   * this silently, as it always has; a bulk pass wants to count it.
   */
  wholeContentFellBack: boolean;
};

export type Embedder = {
  /**
   * Embed a capture: one vector for `thoughts.embedding`, plus per-window
   * vectors when the content is too long to embed in a single provider call.
   */
  embedCapture(content: string): Promise<EmbeddedCapture>;
  /** One embedding. `kind` selects the query template over the document one. */
  getEmbedding(text: string, kind?: EmbedKind): Promise<number[]>;
};

/**
 * Build an embedder over a configuration source. The source is a function
 * because index.ts reads its environment lazily; it is called on every request
 * to the provider, which is what the server did before this file existed.
 *
 * One piece of state lives in the returned object: whether the provider has
 * refused a whole-content embedding, which is a fact about the configured model
 * and is remembered for the life of the embedder so it is not re-discovered on
 * every long capture.
 */
export function createEmbedder(config: () => EmbedConfig): Embedder {
  /**
   * Set when the provider rejects a whole-content embedding outright. One-way:
   * the only thing that flips it is a 4xx, which is a property of the
   * configured model rather than a transient condition.
   */
  let wholeContentRefused = false;

  /**
   * Some embedding models are trained to see a query and a document differently,
   * and sending both bare is not a small loss: `qwen3-embedding:4b` scores 0.933
   * MRR on 97 real issues with its query instruction and 0.860 without —
   * unprompted, worse than a model a quarter its size. The templates live in
   * db/config.mjs, keyed by model, so the migration runner and the server cannot
   * disagree about them.
   *
   * A model with no entry is sent bare, which is right for most: `embeddinggemma`
   * gains 0.002 from its documented format, and nomic's prefixes measurably hurt.
   *
   * This is baked into stored vectors. Changing the template invalidates them
   * exactly as changing the model does — which is why it is keyed off the model
   * name rather than exposed as its own setting, so preflight's existing
   * model-change check already covers it.
   *
   * Applied by db/config.mjs's function rather than a copy of it: the server
   * kept its own two-line version, and both it and the original read `$&`,
   * `$'` and `$$` in the thought's text as String.replace substitution
   * patterns — a price written `$$5` was embedded as `$5`. One definition, one
   * fix, and evals/lib.ts measures the same text the server embeds.
   */
  function applyPrompt(cfg: EmbedConfig, text: string, kind: EmbedKind): string {
    return applyEmbeddingPrompt(cfg.embeddingModel, text, kind === "query");
  }

  async function getEmbedding(text: string, kind: EmbedKind = "document"): Promise<number[]> {
    const cfg = config();
    const r = await fetch(`${cfg.llmBase}/embeddings`, {
      method: "POST",
      headers: cfg.headers,
      body: JSON.stringify({
        model: cfg.embeddingModel,
        input: applyPrompt(cfg, text, kind),
        ...(cfg.dimensionsRequested ? { dimensions: cfg.embeddingDim } : {}),
      }),
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      const err = new Error(`Embeddings request to ${cfg.llmBase} failed: ${r.status} ${msg}`);
      // Attached rather than parsed back out of the message: embedCapture has to
      // distinguish "this input is too large for this model", which is a stable
      // property worth remembering, from a transient outage, which is not.
      (err as Error & { status?: number }).status = r.status;
      throw err;
    }
    const d = await r.json();
    const embedding = d?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`${cfg.llmBase} returned no embedding for model ${cfg.embeddingModel}`);
    }

    // Refuse a width the column cannot hold. Postgres would reject the insert
    // anyway, but the error surfaces as an opaque cast failure inside a tool
    // response; naming the model and both widths makes the cause obvious. A
    // same-width model from a different family is NOT detectable here — it
    // produces valid numbers that mean something else, which is why the model is
    // recorded in ob1_config and checked by preflight.
    const expected = cfg.embeddingDim;
    if (embedding.length !== expected) {
      // The cost of changing model is always worth stating; the truncation hint
      // is only worth stating when truncation could actually resolve it.
      const hint = cfg.dimensionsRequested
        ? ` OB1_EMBEDDING_DIMENSIONS=on was set, so the provider was asked for ${expected} and ` +
          `ignored it — not every provider or model supports the parameter.`
        : embedding.length > expected
          ? ` If the model supports Matryoshka truncation, set OB1_EMBEDDING_DIMENSIONS=on to ` +
            `request ${expected} instead of ${embedding.length}.`
          : "";
      throw new Error(
        `Embedding width mismatch: model ${cfg.embeddingModel} returned ${embedding.length} ` +
          `dimensions but thoughts.embedding is vector(${expected}). Changing embedding model ` +
          `requires a schema migration and re-embedding every existing row.${hint}`
      );
    }
    return embedding;
  }

  /**
   * Generate the blurb that situates one window in its document.
   *
   * Returns "" on any failure, and the caller degrades to a bare window rather
   * than failing the capture. That choice is the one this feature turns on, so it
   * is worth stating why: the alternative — fail the capture — makes one flaky
   * local model call lose a thought outright, which is the failure migration 008
   * spent a whole atomic-capture design avoiding. The usual objection to
   * degrading is that it produces a silently inconsistent corpus, and that
   * objection is answered by the column rather than by the policy:
   * `thought_chunks.context` is NULL for a window embedded bare, preflight counts
   * both kinds, and the capture response says so at the time.
   */
  async function contextualiseChunk(cfg: EmbedConfig, document: string, chunk: string): Promise<string> {
    // One pass, with a function. Two string replaces would read `$&` and its
    // relatives in the document as substitution patterns, and a document that
    // itself contains the literal `{chunk}` would receive the window where its
    // own text was, leaving the real placeholder unfilled.
    const fill: Record<string, string> = { "{document}": document, "{chunk}": chunk };
    const prompt = CHUNK_CONTEXT_PROMPTS.chunk.replace(/\{document\}|\{chunk\}/g, (m) => fill[m]);
    try {
      const r = await fetch(`${cfg.llmBase}/chat/completions`, {
        method: "POST",
        headers: cfg.headers,
        body: JSON.stringify({
          model: cfg.metadataModel,
          // The same two settings extractMetadata sends, for the same reason:
          // this is the other LLM call on the interactive capture path, and a
          // thinking model left to reason costs 5.5x the latency there.
          // `qwen3.8:27b` is suggested in db/config.mjs as an OB1_METADATA_MODEL,
          // so the case is real rather than hypothetical — and reasoning text
          // arriving in a blurb would be embedded along with it.
          temperature: cfg.metadataTemperature,
          ...cfg.metadataReasoning,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!r.ok) {
        console.error(`contextualiseChunk: ${cfg.llmBase} returned ${r.status}`);
        return "";
      }
      const d = (await r.json()) as { choices?: [{ message?: { content?: string } }] };
      const out = (d?.choices?.[0]?.message?.content ?? "").trim();
      // The rule lives in db/config.mjs so the benchmark applies the same one. A
      // blurb this file accepted and the harness rejected would mean every
      // measured number described text the server does not embed.
      if (!usableChunkContext(out, chunk)) {
        if (out) console.error(`contextualiseChunk: rejected a ${out.length}-char blurb for a ${chunk.length}-char window`);
        return "";
      }
      return out;
    } catch (e) {
      console.error(`contextualiseChunk: ${(e as Error).message}`);
      return "";
    }
  }

  /**
   * Embed a capture: one vector for `thoughts.embedding`, plus per-window vectors
   * when the content is too long to embed in a single provider call.
   *
   * Short content — nearly everything — takes exactly the path it always did: one
   * call, one vector, no chunk rows.
   *
   * ── Long content: the whole-content vector is kept ──────────────────────────
   * `thoughts.embedding` is the whole content's vector, and the windows go to
   * `thought_chunks`, so `match_thoughts` scores the thought as the best of both.
   *
   * It used to be the FIRST WINDOW's vector, on the reasoning that sending the
   * whole content would exceed the provider's batch and be silently truncated.
   * That reasoning was sound and is no longer true of the configured default:
   * `evals/eval-contextual.ts` measures the ceiling directly, by bisecting for the
   * shortest prefix that embeds to a bit-identical vector, and `qwen3-embedding:4b`
   * read all 15,812 characters of the longest real document in the corpus. The
   * head-window rule was discarding a vector the provider would have given us.
   *
   * Measured, on 37 queries that name a document's subject and ask for a detail
   * inside one window: keeping the whole-content vector scores 0.935 MRR against
   * 0.904 for windows alone — three queries better, none worse. On
   * `embeddinggemma`, which genuinely does truncate at ~8,150 characters, it is
   * still +0.020 with none worse: a head-truncated whole-content vector is a
   * longer head than the first window, not a worse one. The 426 unchunked
   * documents move by 0.001, which is noise.
   *
   * The cost is one extra provider call on the 3.4% of captures long enough to
   * chunk, and it is best-effort: a provider that REFUSES over-length input rather
   * than truncating it — which hosted APIs do, where Ollama truncates — must not
   * turn a capture that used to succeed into one that fails, so that failure falls
   * back to the old head-window behaviour.
   *
   * A long thought stored before this change still has its head window in
   * `thoughts.embedding`. `db/reembed.ts` is the backfill: it runs this same
   * function over every row. Preflight cannot report the split, because the
   * obvious detector — `thoughts.embedding` equal to chunk 0's — has a false
   * positive it cannot distinguish: a provider that refuses over-length input
   * produces exactly that state legitimately, for every long capture, forever.
   *
   * Windows are embedded concurrently; they are independent, and serialising them
   * would multiply the latency of a long capture for no benefit.
   *
   * WITH THE FLAG ON, that concurrency has a cost worth knowing before turning it
   * on. The blurbs are generated concurrently too, and each prompt carries the
   * WHOLE document — so a six-window capture fires six simultaneous generation
   * requests, each several thousand tokens, at whatever OB1_LLM_BASE_URL points
   * at. On a local box running a large model that is a real spike. It is left
   * concurrent rather than bounded because the alternative is six sequential
   * generations on the interactive capture path, and neither is obviously right:
   * anyone turning this on has already been told to measure it first.
   */
  async function embedCapture(content: string): Promise<EmbeddedCapture> {
    const cfg = config();
    const windows = chunkContent(content, { maxTokens: cfg.chunkTokens, overlapTokens: cfg.chunkOverlap });
    if (!windows.length) {
      return { embedding: await getEmbedding(content), chunks: [], contextFailures: 0, wholeContentFellBack: false };
    }

    const wantContext = cfg.chunkContext;
    const contexts = wantContext
      ? await Promise.all(windows.map((w) => contextualiseChunk(cfg, content, w.content)))
      : windows.map(() => "");

    const [whole, ...windowVectors] = await Promise.all([
      wholeContentRefused
        ? Promise.resolve(null)
        : getEmbedding(content).catch((e: Error & { status?: number }) => {
            // 400 or 413 here means the provider REFUSED the input rather than
            // truncating it, which is a fact about the model and will be just as
            // true for the next long capture. Remembering it turns a wasted round
            // trip on every long capture into one per process. A 5xx or a network
            // error says nothing durable, so it is not latched — and neither is
            // any other 4xx: 429 is a rate limit, 408 a timeout, 401 and 403 a
            // credential. This used to latch on every 4xx, so one throttled call
            // in a bulk pass downgraded every later long thought to its head
            // window while recording success (first review of SMD-946).
            if (e.status === 400 || e.status === 413) {
              wholeContentRefused = true;
              console.error(
                `embedCapture: ${cfg.embeddingModel} refused the whole content (${e.status}); ` +
                  `falling back to the head window here and skipping the attempt for the rest ` +
                  `of this process.`
              );
            } else {
              console.error(`embedCapture: whole-content embedding failed, using the head window: ${e.message}`);
            }
            return null;
          }),
      ...windows.map((w, i) => getEmbedding(composeChunkForEmbedding(contexts[i], w.content))),
    ]);

    return {
      embedding: whole ?? windowVectors[0],
      chunks: windows.map((w, i) => ({
        content: w.content,
        embedding: windowVectors[i],
        ...(contexts[i] ? { context: contexts[i] } : {}),
      })),
      contextFailures: wantContext ? contexts.filter((c) => !c).length : 0,
      wholeContentFellBack: whole === null,
    };
  }

  return { embedCapture, getEmbedding };
}
