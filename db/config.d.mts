/**
 * config.d.mts — types for config.mjs.
 *
 * config.mjs is plain JavaScript on purpose: it is imported by `migrate.ts`
 * (Bun), by `preflight.ts` (Bun and Node), and read by shell tooling, so keeping
 * it dependency-free and un-compiled means there is exactly one definition of the
 * embedding contract and no build step between the runner and the server.
 *
 * The cost is that a TypeScript consumer sees `any`, which `tsc --noEmit` rejects
 * under `noImplicitAny`. This file is that missing half — it is checked against
 * the implementation by CI's typecheck, so the two cannot drift silently.
 */

/** Default model and width, shared with the server so the two cannot drift. */
export const DEFAULT_EMBEDDING_MODEL: string;
export const DEFAULT_EMBEDDING_DIM: number;

/** Width of `thoughts.embedding`. From OB1_EMBEDDING_DIM. */
export const EMBEDDING_DIM: number;

/** Model that must produce exactly EMBEDDING_DIM numbers. */
export const EMBEDDING_MODEL: string;

/** Metadata-extraction model. No schema dependency; safe to change any time. */
export const METADATA_MODEL: string;

/** pgvector's HNSW ceiling. Above this the column works but no index can exist. */
export const MAX_HNSW_DIM: number;

/**
 * Native output width per model. Local entries are measured against a live
 * provider; hosted entries are marked in the source with how they are known.
 */
export const KNOWN_MODEL_DIMS: Record<string, number>;

/** Models whose cards claim Matryoshka training, so truncation is supported. */
export const MRL_MODELS: Set<string>;

/** Models whose cards were checked and make no Matryoshka claim. */
export const VERIFIED_NOT_MRL: Set<string>;

/**
 * Asymmetric query/document prompt templates keyed by model, with `{q}` and `{d}`
 * placeholders. Absent means send the text bare, which is right for most models.
 */
export const EMBEDDING_PROMPTS: Record<string, { query: string; document: string }>;

/**
 * Resolve whether to request truncation, given the raw env value (or undefined),
 * the configured width and the model. Explicit env wins; otherwise on only for a
 * known-MRL model configured below its known native width.
 */
export function resolveEmbeddingDimensions(
  raw: string | undefined,
  dim: number,
  model: string
): boolean;

/** Whether to send the OpenAI `dimensions` parameter. OB1_EMBEDDING_DIMENSIONS. */
export const EMBEDDING_DIMENSIONS: boolean;

/**
 * Fatal configuration problems. Callers exit non-zero on a non-empty result, so
 * anything survivable belongs in embeddingConfigWarnings instead.
 */
export function validateEmbeddingConfig(
  dim?: number,
  model?: string,
  truncate?: boolean
): string[];

/** Non-fatal smells: works, but retrieval will be worse than it needs to be. */
export function embeddingConfigWarnings(
  dim?: number,
  model?: string,
  truncate?: boolean
): string[];
