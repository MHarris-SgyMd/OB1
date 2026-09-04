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
/** Provider base URL. Defaults to Ollama, matching the local model defaults. */
export const DEFAULT_LLM_BASE_URL: string;
export const LLM_BASE_URL: string;

/** Width of `thoughts.embedding`. From OB1_EMBEDDING_DIM. */
export const EMBEDDING_DIM: number;

/** Model that must produce exactly EMBEDDING_DIM numbers. */
export const EMBEDDING_MODEL: string;

/** Metadata-extraction model. No schema dependency; safe to change any time. */
export const DEFAULT_METADATA_MODEL: string;
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

/** Apply a model's query/document template; returns `text` when it has none. */
export function applyEmbeddingPrompt(model: string, text: string, isQuery: boolean): string;

/**
 * Prompts that generate the blurb prepended to a chunk before embedding, with
 * `{document}` and `{chunk}` placeholders. `document` situates a whole document
 * in one call; `chunk` situates one window and costs a call per window.
 */
export const CHUNK_CONTEXT_PROMPTS: { document: string; chunk: string };

/**
 * Whether a generated blurb is worth prepending: non-empty, and under 60% of the
 * length of what it situates. Shared with the benchmark so the two cannot decide
 * differently about the same blurb.
 */
export function usableChunkContext(context: string | null | undefined, chunk: string): boolean;

/** Join a blurb to its window. An empty context returns the window unchanged. */
export function composeChunkForEmbedding(context: string | null | undefined, chunk: string): string;

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

/** Whether migration 011 builds the trigram index. On by default since SMD-944. */
export const DEFAULT_TRGM_INDEX: boolean;
export const TRGM_INDEX: boolean;
/** Parse OB1_TRGM_INDEX; returns DEFAULT_TRGM_INDEX when unset or empty. */
export function resolveTrgmIndex(raw: string | undefined): boolean;

/**
 * Whether a capture generates a situating blurb per chunk before embedding it.
 * Off by default, and measured off — see the source, and evals/eval-contextual.ts.
 */
export const DEFAULT_CHUNK_CONTEXT: boolean;
export const CHUNK_CONTEXT: boolean;
/** Parse OB1_CHUNK_CONTEXT; returns DEFAULT_CHUNK_CONTEXT when unset or empty. */
export function resolveChunkContext(raw: string | undefined): boolean;

/** Values substituted into `{{...}}` in db/migrations/*.sql. */
export function migrationValues(overrides?: {
  dim?: number;
  model?: string;
  trgm?: boolean;
  chunkContext?: boolean;
}): Record<string, string>;

/** Substitute a migration template; throws on an unknown `{{VARIABLE}}`. */
export function substituteMigration(
  sql: string,
  values: Record<string, string>,
  file?: string
): string;

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

/** Numeric per-component version floor; "0.10.0" is at least 0.8.0 here, unlike as strings. */
export function versionAtLeast(version: string, major: number, minor?: number, patch?: number): boolean;

/** Is this hostname the local machine or its private network? Empty is not local. */
export function isLocalHostname(host: string, serviceNames?: string[]): boolean;

/** What migration 014 seeds as the HNSW walk's bounds; tuned with ALTER DATABASE, not here. */
export const HNSW_SEED_MAX_SCAN_TUPLES: number;
export const HNSW_SEED_SCAN_MEM_MULTIPLIER: number;
/** The two bound names, in remedy order. */
export const HNSW_BOUNDS: string[];
/** match_thoughts clamps match_count to this inside the function (014). */
export const MATCH_COUNT_CEILING: number;
/** pg_settings.source values that reach every role: server configuration or the database. */
export const SHARED_SETTING_SOURCES: string[];
/** SELECT of the current database's pg_db_role_setting row as `cfg` (setconfig). */
export const DB_LEVEL_SETTINGS_SQL: string;
/** `["a=1"]` → `{a: "1"}`. */
export function parseSetConfig(cfg: string[] | null | undefined): Record<string, string>;
