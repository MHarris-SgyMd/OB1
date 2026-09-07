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

import { readFileSync } from "node:fs";
import type { SQL } from "bun";

export type LinearDoc = { id: string; title: string; text: string; labels?: string[] };

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
 * literal when the caller has one.
 */
export async function insertLinearThought(sql: SQL, d: LinearDoc, embedding?: string): Promise<void> {
  const text = linearThoughtText(d);
  const meta = { source: "linear", issue: d.id };
  if (embedding === undefined) {
    await sql`INSERT INTO thoughts (id, content, metadata, content_fingerprint)
              VALUES (${linearThoughtId(d.id)}::uuid, ${text}, ${meta}::jsonb, content_fingerprint_of(${text}))
              ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING`;
  } else {
    await sql`INSERT INTO thoughts (id, content, metadata, content_fingerprint, embedding)
              VALUES (${linearThoughtId(d.id)}::uuid, ${text}, ${meta}::jsonb, content_fingerprint_of(${text}), ${embedding}::vector)
              ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO NOTHING`;
  }
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
