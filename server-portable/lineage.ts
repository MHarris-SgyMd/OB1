/**
 * Lineage recipes (SMD-1731, migration 061): what each producer declares about
 * how it made a derived artifact, written to `derivations` in the transaction
 * that writes the artifact.
 *
 * The database holds the rule — `ob1_record_derivation` refuses a recipe
 * without a boolean `deterministic`, and each producer function (the write
 * functions, record_thought_entities, record_supersession_proposal) records
 * its row beside its rows — and this module holds the SHAPE each producer
 * sends, in one place, so the server's capture, the board sync, the re-embed
 * and the two workers cannot spell a recipe differently:
 *
 *   - chunks: the window split's parameters and the blurb model (013), the
 *     one recipe the row store never saw (docs/event-log-as-truth.md, the
 *     projections table: "no recipe of their own");
 *   - metadata: the tag extractor's model, prompt version and prompt hash —
 *     the fifth producer, which recorded nothing (SMD-1254's subject);
 *   - entities: the extractor's model, prompt version and hash, the windows
 *     sent and what was cut — the `--dump` record's fields, in the table;
 *   - proposal: the judge's model, prompt version and hash, the candidate
 *     parameters the pair was found under;
 *   - a structured pass (`source:<system>`): deterministic, the system.
 *
 * `deterministic` is what SMD-1732's rebuild will read: a recipe it can re-run
 * to the same rows (a split, a vector at a fixed model, a parse of a source's
 * own structure) against one it can only re-run (a model's answer). The
 * vector's own recipe — model and width — is the row trigger's, read from the
 * row, and has no builder here.
 *
 * A prompt is hashed, not copied: `prompt_hash` names the exact text a
 * version number only claims to, so a prompt edited under the same version
 * still reads as a different recipe.
 */
import { createHash } from "node:crypto";
import { CHUNK_CONTEXT_PROMPTS, CONSOLIDATE_KEY_PREFIX } from "../db/config.mjs";
import type { EmbedConfig, EmbeddedCapture } from "./embed.ts";
import { ENTITY_EXTRACTION_PROMPT, ENTITY_PROMPT_VERSION, type Extraction } from "./entities.ts";
import { CONSOLIDATE_PROMPT, CONSOLIDATE_PROMPT_VERSION, CONTENT_LIMIT_CHARS } from "./consolidate.ts";
import { METADATA_PROMPT, METADATA_PROMPT_VERSION, TAG_KEYS } from "./metadata.ts";

/** A recipe as `derivations.recipe` holds it: `deterministic` required, the rest the producer's. */
export type Recipe = { deterministic: boolean } & Record<string, unknown>;

/**
 * The lineage envelope a capture or an edit carries — `p_payload.lineage` on
 * upsert_thought, `p_lineage` on update_thought: the recipes of the windows
 * and the tags the write carries. A key absent is "no such derivation":
 * a capture that made no windows, tags a caller sent.
 */
export type Lineage = { chunks?: Recipe; metadata?: Recipe };

/** `sha256:<hex>` of a prompt's text — the form every recipe's `prompt_hash` takes. */
export function promptHash(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** How chunk.ts counts tokens (no tokeniser, by design — chunk.ts's header): named on the recipe so a rebuild knows what "1200 tokens" measured. */
export const CHUNK_ESTIMATOR = "max(chars/4, words*1.3)";

/**
 * The window set's recipe: the split's parameters as the embedder resolved
 * them, the model the windows were embedded at, and — when 013's blurbs ran —
 * the blurb model and its prompt's hash. Deterministic while no window
 * carries a blurb: the split is arithmetic, a blurb is a model's answer.
 * `undefined` when the capture made no windows (no artifact, no row).
 */
export function chunkRecipe(cfg: Pick<EmbedConfig, "chunkTokens" | "chunkOverlap" | "chunkThreshold" | "chunkTokensFrom" | "chunkContext" | "metadataModel">, embedded: Pick<EmbeddedCapture, "model" | "chunks">): Recipe | undefined {
  if (!embedded.chunks.length) return undefined;
  const blurbs = embedded.chunks.filter((c) => typeof c.context === "string" && c.context.length > 0).length;
  return {
    deterministic: blurbs === 0,
    model: embedded.model,
    params: { tokens: cfg.chunkTokens, overlap: cfg.chunkOverlap, threshold: cfg.chunkThreshold, tokens_from: cfg.chunkTokensFrom, estimator: CHUNK_ESTIMATOR },
    ...(cfg.chunkContext ? { blurb_model: cfg.metadataModel, prompt_hash: promptHash(CHUNK_CONTEXT_PROMPTS.chunk), blurbs } : {}),
  };
}

/**
 * The tags' recipe when the extractor produced them: its model, the prompt's
 * version and hash, the temperature. `undefined` when it did not — the
 * extraction failed or was refused (`metadata_extraction_failed` on the tags)
 * or the answer carries none of the extractor's keys — since a row for tags
 * no model wrote would be a lie.
 */
export function metadataRecipe(cfg: Pick<EmbedConfig, "metadataModel" | "metadataTemperature">, tags: Record<string, unknown> | undefined): Recipe | undefined {
  if (!tags || "metadata_extraction_failed" in tags) return undefined;
  if (!TAG_KEYS.some((k) => k in tags)) return undefined;
  return { deterministic: false, model: cfg.metadataModel, prompt_version: METADATA_PROMPT_VERSION, prompt_hash: promptHash(METADATA_PROMPT), temperature: cfg.metadataTemperature };
}

/**
 * The envelope for a capture or an edit that embedded and tagged: the windows'
 * recipe when there are windows, the tags' when the extractor wrote them.
 * `undefined` when neither — the caller sends no envelope at all.
 */
export function captureLineage(cfg: EmbedConfig, embedded: Pick<EmbeddedCapture, "model" | "chunks"> | undefined, tags: Record<string, unknown> | undefined): Lineage | undefined {
  const chunks = embedded ? chunkRecipe(cfg, embedded) : undefined;
  const metadata = metadataRecipe(cfg, tags);
  if (!chunks && !metadata) return undefined;
  return { ...(chunks ? { chunks } : {}), ...(metadata ? { metadata } : {}) };
}

/**
 * The extraction's recipe: the model, the prompt's version and hash, how many
 * windows were sent and — for a bounded thought — what was cut (SMD-2240),
 * whether a runaway was retried or aborted. The per-window answers stay in
 * the worker's `--dump`; their count rides here.
 */
export function entityRecipe(cfg: Pick<EmbedConfig, "metadataModel">, extraction: Pick<Extraction, "windows" | "coverage" | "retried" | "abortedMs" | "parts">): Recipe {
  return {
    deterministic: false,
    model: cfg.metadataModel,
    prompt_version: ENTITY_PROMPT_VERSION,
    prompt_hash: promptHash(ENTITY_EXTRACTION_PROMPT),
    windows: extraction.windows,
    ...(extraction.coverage ? { coverage: extraction.coverage } : {}),
    ...(extraction.retried ? { retried: true } : {}),
    ...(extraction.abortedMs !== undefined ? { aborted_ms: extraction.abortedMs } : {}),
    ...(extraction.parts ? { parts: extraction.parts.length } : {}),
  };
}

/** A structured pass's recipe (053): the source's own structure parsed, no model — deterministic. */
export function structuredRecipe(system: string): Recipe {
  return { deterministic: true, system, key: `source:${system}` };
}

/**
 * The proposal's recipe: the judge's model, the prompt's version and hash,
 * and the candidate parameters the pair was found under — the similarity the
 * walk measured, the neighbourhood size and floor, the text bound the judge
 * read within.
 */
export function proposalRecipe(cfg: Pick<EmbedConfig, "judgeModel">, found: { similarity: number; candidates: number; minSimilarity: number }): Recipe {
  return {
    deterministic: false,
    model: cfg.judgeModel,
    prompt_version: CONSOLIDATE_PROMPT_VERSION,
    prompt_hash: promptHash(CONSOLIDATE_PROMPT),
    key_prefix: CONSOLIDATE_KEY_PREFIX,
    similarity: found.similarity,
    candidates: found.candidates,
    min_similarity: found.minSimilarity,
    content_limit_chars: CONTENT_LIMIT_CHARS,
  };
}
