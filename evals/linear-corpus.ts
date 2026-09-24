/**
 * linear-corpus.ts — the producer/consumer contract between the harnesses that
 * load the Linear corpus into a throwaway Postgres.
 *
 * eval-entities.ts loads the corpus, runs the extraction worker over it and
 * dumps every answer keyed by thought id; eval-graphrag.ts loads the same
 * corpus and replays that dump. The replay works only while the two agree byte
 * for byte on: which documents get a thought at all, the id each one is
 * minted, where the dump lives, how a document becomes a thought row (the
 * fingerprint collapse decides which documents exist at all), and what a dump
 * line looks like. They used to be pasted into both files; this is the one
 * definition.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { SQL } from "bun";
import type { LinearIssue } from "../db/ingest-linear.ts";

/**
 * One corpus document. `createdAt` — when the issue was opened — is in corpora
 * built on or after 2026-09-08; eval-recency.ts needs it, and eval-graphrag.ts's
 * entity-membership arm ranks by it (SMD-1738). `issue` — the issue as Linear's
 * API gives it, the shape db/sync-linear.ts fetches — is in corpora built on or
 * after 2026-09-24: db/ingest-records.ts maps it through the Linear adapter so
 * the ingester and the board sync write one text (SMD-1958). The harnesses read
 * `title` and `text` alone, as before.
 */
export type LinearDoc = { id: string; title: string; text: string; labels?: string[]; createdAt?: string; issue?: LinearIssue };

export const DEFAULT_CORPUS = "/tmp/linear-corpus-full.json";

/** The corpus with empty-bodied issues dropped — they would embed to noise and extract to nothing. */
export function loadLinearCorpus(path = process.env.OB1_EVAL_CORPUS ?? DEFAULT_CORPUS): { path: string; docs: LinearDoc[] } {
  const docs = (JSON.parse(readFileSync(path, "utf8")) as LinearDoc[]).filter((d) => (d.text ?? "").trim().length > 0);
  return { path, docs };
}

/** What is stored as `thoughts.content` for a document. */
export function linearThoughtText(d: LinearDoc): string {
  return `${d.title}\n\n${d.text}`;
}

/**
 * A fixed, valid-looking UUID per issue id, so a dump's answers find their
 * thoughts on a fresh database. Not a real UUIDv4 — the version and variant
 * nibbles are set so Postgres accepts it, the rest is two hashes of the id.
 */
export function linearThoughtId(issueId: string): string {
  return Bun.hash.crc32(issueId).toString(16).padStart(8, "0") + "-0000-4000-8000-" + Bun.hash.xxHash64(issueId).toString(16).padStart(16, "0").slice(0, 12);
}

/** Where eval-entities.ts --corpus dumps the model's answers for the given extraction model. */
export function entityAnswersPath(metadataModel: string): string {
  return process.env.OB1_EVAL_ANSWERS ?? `/tmp/entity-answers-${metadataModel.replace(/[^A-Za-z0-9.-]+/g, "_")}.jsonl`;
}

/**
 * One corpus document as a thought row: fixed id, the product's fingerprint
 * rule, and the collapse of duplicate texts onto the first — so "which
 * documents get a thought" is decided here, once. `embedding` is a pgvector
 * literal when the caller has one. `createdAt` sets the row's created_at —
 * opt-in, for the recency eval; every other harness leaves the column at its
 * default, as before, so nothing they measure moves.
 */
export async function insertLinearThought(sql: SQL, d: LinearDoc, embedding?: string, text: string = linearThoughtText(d), createdAt?: string): Promise<void> {
  const meta = { source: "linear", issue: d.id };
  const created = createdAt ?? null;
  if (embedding === undefined) {
    await sql`INSERT INTO thoughts (id, content, metadata, content_fingerprint, created_at)
              VALUES (${linearThoughtId(d.id)}::uuid, ${text}, ${meta}::jsonb, content_fingerprint_of(${text}), COALESCE(${created}::timestamptz, now()))
              ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING`;
  } else {
    await sql`INSERT INTO thoughts (id, content, metadata, content_fingerprint, embedding, created_at)
              VALUES (${linearThoughtId(d.id)}::uuid, ${text}, ${meta}::jsonb, content_fingerprint_of(${text}), ${embedding}::vector, COALESCE(${created}::timestamptz, now()))
              ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING`;
  }
}

/**
 * Where a harness caches the corpus's document vectors: per embedding spec and
 * per text rule (`thought` is linearThoughtText, `body` the issue text alone,
 * `title` the title as a query — eval-recency.ts's 486 query vectors),
 * because a vector of one is wrong for the other. `OB1_EVAL_VECTORS` moves the
 * cache and is a PREFIX, not a file: the variant is always part of the name, so
 * two harnesses with different text rules cannot be pointed at one file and
 * re-embed the corpus on every alternation (review pass).
 */
export function linearVectorCachePath(embedModel: string, variant: "thought" | "body" | "title" = "thought"): string {
  const prefix = process.env.OB1_EVAL_VECTORS ?? "/tmp/linear-vectors";
  return `${prefix}-${variant}-${embedModel.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;
}

/** Cache entry per issue: the hash of the text it was embedded from, and the vector. */
export type CachedVector = { h: string; v: number[] };

/**
 * The corpus's document vectors, from the cache where the text is unchanged and
 * from the provider where it is not. Keyed by the text's hash rather than by
 * id alone: a rebuilt corpus with edited text re-embeds those documents, where
 * an id-keyed cache would rank new text on old vectors. Written atomically
 * (temp file, then rename) so an interrupted run leaves the previous cache
 * intact. Throws when the provider's width disagrees with `dim`.
 */
export async function cachedDocumentVectors(
  docs: LinearDoc[],
  opts: { path: string; dim: number; text: (d: LinearDoc) => string; embed: (text: string) => Promise<number[]> },
): Promise<{ vectors: Record<string, number[]>; embedded: number }> {
  let cache: Record<string, CachedVector> = {};
  if (existsSync(opts.path)) {
    try { cache = JSON.parse(readFileSync(opts.path, "utf8")); } catch { throw new Error(`Unreadable vector cache ${opts.path}; delete it and re-run.`); }
  }
  let embedded = 0;
  const vectors: Record<string, number[]> = {};
  for (const d of docs) {
    const text = opts.text(d);
    const h = Bun.hash.xxHash64(text).toString(16);
    if (cache[d.id]?.h !== h) { cache[d.id] = { h, v: await opts.embed(text) }; embedded++; }
    if (cache[d.id].v.length !== opts.dim) throw new Error(`the provider returned ${cache[d.id].v.length}-wide vectors but the column is vector(${opts.dim}); give the spec an @dims suffix that matches the model.`);
    vectors[d.id] = cache[d.id].v;
  }
  if (embedded) { writeFileSync(`${opts.path}.tmp`, JSON.stringify(cache)); renameSync(`${opts.path}.tmp`, opts.path); }
  return { vectors, embedded };
}

/**
 * One line of the answers dump db/extract-entities.ts --dump writes: the
 * model's parsed answer for one thought, the fingerprint of the text it saw,
 * and (since 2026-09-07) the extraction key it ran under. Older dumps lack
 * `key`; readers say so rather than assume.
 */
export type EntityAnswer = { id: string; fingerprint?: string; key?: string; entities: unknown[]; relations: unknown[] };

/** Every usable line of a dump, and how many were not — a torn last line, or a shape the database would reject. */
export function readEntityAnswers(path: string): { answers: EntityAnswer[]; unusable: number } {
  const answers: EntityAnswer[] = [];
  let unusable = 0;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const a = JSON.parse(line) as Partial<EntityAnswer>;
      if (typeof a.id !== "string" || !Array.isArray(a.entities) || !Array.isArray(a.relations)) throw new Error("shape");
      answers.push(a as EntityAnswer);
    } catch {
      unusable++;
    }
  }
  return { answers, unusable };
}
