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

/**
 * Tokens a provider embeds in one request before cutting the rest silently.
 * Measured (`prompt_eval_count`) local models only; a hosted model is absent
 * until measured, and keeps the fallback.
 */
export const KNOWN_MODEL_WINDOW: Record<string, number>;
/** Ollama's default batch, 2048: the window the shipped chunk limit was set under. */
export const DEFAULT_MODEL_WINDOW: number;
/** The longest capture a whole vector alone was measured to hold, 4096 estimated tokens: a derived rule windows above it. */
export const MAX_WHOLE_TOKENS: number;
/** Where a chunk limit came from: the variable, the model's window, or the fallback. */
export type ChunkTokensFrom = "OB1_CHUNK_TOKENS" | "window" | "default";
/**
 * How a model's captures are windowed: `threshold` (estimated tokens a capture is
 * windowed above) and `tokens` (the window size). Both OB1_CHUNK_TOKENS when a positive
 * number; else derived from KNOWN_MODEL_WINDOW at the shipped ratio, the size never
 * above `fallback` and the threshold never above MAX_WHOLE_TOKENS; else `fallback` for
 * both. `window` is the model's entry when it has one, whichever branch decided.
 */
export function resolveChunkTokens(
  raw: string | undefined,
  model: string,
  fallback: number
): { tokens: number; threshold: number; from: ChunkTokensFrom; window: number | undefined; capped: boolean };

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
export const CHUNK_CONTEXT_PROMPTS: { document: string; chunk: string; chunkTight: string };

/**
 * Fill a CHUNK_CONTEXT_PROMPTS template in one pass, inserting the texts as
 * they are. A placeholder with no value supplied is left in place.
 */
export function applyChunkContextPrompt(template: string, fill: { document?: string; chunk?: string }): string;

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
/** Parse OB1_BACKFILL_LIMIT: null when unset or empty, a whole number 1..2147483647 otherwise; throws naming the variable. */
export function resolveBackfillLimit(raw: string | undefined): number | null;

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
  /** Rows migration 023's one call writes: NULL for every row waiting (the default), an integer for one batch. */
  backfillLimit?: number | null;
  routeEstimateMinPages?: number;
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

/** A bulk pass's counts in one phrase — printed by db/reembed.ts, embedded by preflight (SMD-1024). */
export type PassCounts = { thoughts: number; succeeded: number; fellBack: number; accepted: number; failed: number; claimed: number; pending: number; unpooled: number };
export function formatPassCounts(c: PassCounts): string;
/** The shared rule for "this pass has not finished": a row is pending, leased or failed. */
export function passUnfinished(c: Pick<PassCounts, "pending" | "claimed" | "failed">): boolean;
/** How preflight attributes a claim-table key to reembed.ts. */
export const REEMBED_KEY_PREFIX: "reembed:";
/** `reembed:<model>@<dim>` — the default key of a pass to a model at a width. */
export function reembedKey(model: string, dim: number): string;
/** `reembed:<model>@<dim>[:suffix]` → the model and width it names; null for any other shape. */
export function parseReembedKey(key: string): { model: string; dim: number } | null;
/** The model a pass under `key` pools against — its own key's model — or null for a backfill key, which pools every thought (021). */
export function poolModelFor(key: string): string | null;
/** How preflight attributes a claim-table key to db/consolidate.ts (029): `consolidate:<model>@p<version>`. */
export const CONSOLIDATE_KEY_PREFIX: "consolidate:";
/** `SELECT embedding_model AS model, count(*) AS c` over the rows with a vector, grouped (021). */
export const CORPUS_BY_MODEL_SQL: string;
/** Those rows read against one model: at it, unlabelled, and the other models with counts. */
export function summariseCorpusByModel(
  rows: { model: string | null; c: number }[],
  atModel: string,
  acceptedRows?: { model: string | null; accepted: number }[],
): { at: number; unlabelled: number; others: { model: string; c: number; accepted: number }[]; otherCount: number; acceptedCount: number; unaccepted: number };
/** The caveat `reembed.ts --accept-failed` writes on a failed row it marks succeeded (SMD-1067); both readers recognise an accepted row by it. */
export const ACCEPTED_CAVEAT_PREFIX: string;
/** Per embedding_model, the rows with a vector whose thought has a standing accepted row under $1, the model's own key exactly; $2 is ACCEPTED_CAVEAT_PREFIX. Needs 015. */
export const ACCEPTED_BY_MODEL_SQL: string;
/** 021's claim-key grammar as a Postgres regex (the model up to the last "@"), and the model's OWN key — the canonical spelling, no suffix. */
export const REEMBED_KEY_MODEL_SQL_RE: string;
export const REEMBED_OWN_KEY_SQL_RE: string;
/** Whether claim row `c` is the operator's acceptance — the predicate CLAIM_EVIDENCE_ROWS_SQL carries and migrate.ts shadows 021's backfill by (SMD-1421). */
export const ACCEPTED_CLAIM_SQL: string;
/** Every succeeded claim row under a key naming a model, with model, own_key, accepted and its timestamps — what 030 reads. Substituted into 030: changing it is a data migration. Needs 015. */
export const CLAIM_EVIDENCE_ROWS_SQL: string;
/** The migrator's re-run, as every remedy that names it prints it. */
export const REAPPLY_COMMAND: string;
/** The lock timeout, in seconds, migrate.ts sets for its session and quotes in its messages; test-upgrade derives its expectations from it. */
export const LOCK_TIMEOUT_S: number;
/** What is wrong with a listing of migration files — a name not NNN_name.sql, or two sharing a number — or null; one rule for migrate.ts at load and the fork checker on push. */
export function migrationNameProblem(names: string[]): string | null;
/** The SET list that returns a claim row to its pool — requeue()'s. */
export const REQUEUE_SET_SQL: string;

/** Numeric per-component version floor; "0.10.0" is at least 0.8.0 here, unlike as strings. */
export function versionAtLeast(version: string, major: number, minor?: number, patch?: number): boolean;

/** Is this hostname the local machine or its private network? Empty is not local. */
export function isLocalHostname(host: string, serviceNames?: string[]): boolean;

/** What migration 014 seeds as the HNSW walk's bounds, by setting name; tuned with ALTER DATABASE, not here. */
export const HNSW_SEEDS: Readonly<Record<string, number>>;
export const HNSW_SEED_MAX_SCAN_TUPLES: number;
export const HNSW_SEED_SCAN_MEM_MULTIPLIER: number;
/** The bound names, in remedy order. Bind into Bun.sql with sql.array(HNSW_BOUNDS, "TEXT"). */
export const HNSW_BOUNDS: string[];
/** A database name as an SQL identifier. */
export function quoteIdent(name: unknown): string;
/** `SELECT name, value` of each bound as this session sees it (value NULL when pgvector is not loaded). */
export const BOUNDS_IN_FORCE_SQL: string;
/** match_thoughts clamps match_count to this inside the function (014). */
export const MATCH_COUNT_CEILING: number;
/** 036's gate on match_thoughts' routing count: the heap pages it samples, and the heap size in pages under which it does not sample. */
export const ROUTE_SAMPLE_PAGES: number;
export const ROUTE_ESTIMATE_MIN_PAGES: number;
/** The signature the servers call, as regprocedure text (020: six arguments). */
export const MATCH_THOUGHTS_SIGNATURE: string;
/** The signature the servers call, as regprocedure text (020: seven arguments). */
export const SEARCH_THOUGHTS_HYBRID_SIGNATURE: string;
/** The signature the servers and reembed.ts call, as regprocedure text (032: nine arguments). */
export const UPDATE_THOUGHT_SIGNATURE: string;
/** The 4- and 5-argument search forms 020 dropped and the 7- and 8-argument update_thought 021 and 032 dropped; a schema reset drops them too. */
export const SUPERSEDED_SIGNATURES: readonly string[];
/** Function name → the migration file that last defines it, from the migrations as [name, text] pairs (SMD-1250). */
export function ownedFunctionsIn(files: Iterable<readonly [string, string]>): Map<string, string>;
/** The CREATE/DROP/ALTER FUNCTION|PROCEDURE|ROUTINE or COMMENT ON shapes naming `fn` at the start of a line, quoted or schema-qualified or not, the name on the next line allowed — a multiline regex for a whole text (SMD-1250). */
export function coreFunctionStatement(fn: string): RegExp;
/** thoughts column → the migration file that last writes its COMMENT (SMD-1250). */
export function ownedColumnCommentsIn(files: Iterable<readonly [string, string]>): Map<string, string>;
/** The COMMENT ON COLUMN thoughts.`col` shape at the start of a line, for a whole text (SMD-1250). */
export function coreColumnCommentStatement(col: string): RegExp;
/** The clause 005 added to the 2-argument upsert_thought and no earlier body has: preflight's recogniser for the shipped body. */
export const UPSERT_TWO_ARG_SHIPPED_RE: RegExp;
/** The clause 025 added to the 3-argument upsert_thought and 022's body lacks: preflight's recogniser for the shipped body. */
export const UPSERT_THREE_ARG_SHIPPED_RE: RegExp;
/** 015's release_thought and release_claims_for_worker clear the lease; upstream's bodies under the same signatures do not. */
export const RELEASE_SHIPPED_RE: RegExp;
/** 024's thought_stats_summary guards the topics array by type; the recipe body it came from does not. */
export const THOUGHT_STATS_SHIPPED_RE: RegExp;
/** pg_settings.source values that reach every role: server configuration or the database. */
export const SHARED_SETTING_SOURCES: string[];
/** SELECT of the current database's pg_db_role_setting row as `cfg` (setconfig). */
export const DB_LEVEL_SETTINGS_SQL: string;
/** `["a=1"]` → `{a: "1"}`. */
export function parseSetConfig(cfg: string[] | null | undefined): Record<string, string>;
/**
 * If the bare `vector` type does not resolve but pgvector is installed in some
 * schema, append that schema to this session's search_path and return it;
 * otherwise a no-op returning null. Session scope only — no ALTER DATABASE/ROLE.
 */
export function alignVectorSearchPath(sql: import("bun").SQL): Promise<string | null>;

/** One table's requirement in ROLE_GRANTS: the privileges a group needs on it, and the migration that introduced the need. */
export type RoleGrant = { table: string; privileges: readonly string[]; since: string };
/**
 * Table privileges the fork's SECURITY INVOKER functions need to run as their
 * caller, grouped by the role that needs each group. The single spelling read by
 * preflight's `write privileges` check, `migrate.ts --grant`, and db/README.md.
 */
export const ROLE_GRANTS: Readonly<Record<"capture" | "server" | "worker" | "extraction" | "querylog", readonly RoleGrant[]>>;
/** The order groups are issued and documented in. */
export const ROLE_GRANT_GROUPS: readonly ("capture" | "server" | "worker" | "extraction" | "querylog")[];
/** The (table, privilege) pairs the core capture/edit/search path needs unconditionally — preflight's refusal set. */
export const CAPTURE_WRITES: readonly { table: string; privilege: string; since: string }[];
/** The (table, privilege) pairs 016's enqueue trigger adds to the capture path while ob1_config.entity_extraction_key is set — thought_work_claims INSERT/UPDATE, upserted as the caller on every capture. */
export const EXTRACTION_TRIGGER_WRITES: readonly { table: string; privilege: string; since: string }[];
/** The opt-in query log (migration 034, SMD-1295): the one spelling of its env flag, table/function names, tool sets, and retention window, shared by server, preflight and tests. */
export const QUERY_LOG: Readonly<{
  flag: "OB1_QUERY_LOG";
  on: "on";
  table: "query_log";
  prune: "prune_query_log";
  retentionEnv: "OB1_QUERY_LOG_RETENTION_DAYS";
  retentionDaysDefault: number;
  searchTools: readonly string[];
  actionTools: readonly string[];
}>;
/** True when a server env selects the query log on (the fork's "on" idiom). */
export function queryLogEnabled(env: Record<string, string | undefined> | undefined | null): boolean;
/** prune_query_log's retention window in days, from OB1_QUERY_LOG_RETENTION_DAYS or the default. */
export function queryLogRetentionDays(env: Record<string, string | undefined> | undefined | null): number;
/** Every table named across the given groups (default: all), in group/list order, de-duplicated. */
export function grantedTables(groups?: readonly string[]): string[];
/** GRANT statements giving `role` the privileges the given groups need; `present` skips absent tables; the role is quoted. */
export function grantStatements(role: string, opts?: { groups?: readonly string[]; present?: Set<string> | null }): string[];
