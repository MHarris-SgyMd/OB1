/**
 * linear-corpus.ts — the producer/consumer contract between the harnesses that
 * load the Linear corpus into a throwaway Postgres.
 *
 * eval-entities.ts loads the corpus, runs the extraction worker over it and
 * dumps every answer keyed by thought id; eval-graphrag.ts loads the same
 * corpus and replays that dump. The replay works only while three things agree
 * byte for byte: which documents get a thought at all, the id each one is
 * minted, and where the dump lives. They used to be pasted into both files;
 * this is the one definition.
 */

import { readFileSync } from "node:fs";

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
