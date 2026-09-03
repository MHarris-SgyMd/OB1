#!/usr/bin/env bun
/**
 * build-linear-corpus.ts — rebuild the real-issue evaluation corpus from Linear.
 *
 * The corpus this replaces was built ad hoc, and inspecting it turned up two
 * problems that quietly limited every number measured on it:
 *
 *   TRUNCATED. Documents topped out at 483 characters, 80 of 97 sat in the
 *   400-490 band, and 78 of 97 did not end on sentence punctuation — one cuts
 *   off mid-clause at "More importantly, the". A ~500-character cap had been
 *   applied at ingestion. So `qwen3-embedding:4b` was chosen over
 *   `embeddinggemma` (0.933 MRR against 0.914) on 483-character stubs, while
 *   db/config.mjs justifies that model partly as "the only local model that
 *   embeds a long capture whole" — an advantage those inputs cannot show.
 *
 *   NO COMMENTS. Only `id`, `title`, `text`, `labels`. On a real tracker the
 *   decision, the pushback and the "we did X instead" live in the thread, not
 *   the description.
 *
 * Both mattered beyond the leaderboard. Nothing in the old corpus reached the
 * 1200-token chunking threshold, so `thought_chunks` — and anything measured
 * against it — had no real documents to work on. That was an artifact of the
 * truncation, not a property of the source material.
 *
 * Put LINEAR_API_KEY in a .env file (see evals/.env.example — the file itself is
 * gitignored) and run:
 *
 *   bun build-linear-corpus.ts
 *
 * A variable already in the environment always wins over the file, so CI and
 * 1Password injection keep working unchanged:
 *
 *   LINEAR_API_KEY=lin_api_... bun build-linear-corpus.ts
 *
 * ── This script is committed; its output is not ──────────────────────────────
 * The corpus is internal engineering data from a healthcare company. It stays on
 * the machine that built it: out of git, and away from any hosted model
 * provider. `.gitignore` covers `*-corpus.json` and `evals/corpus-*.json`, and
 * this script refuses to write anywhere inside the repository regardless.
 *
 * Comments raise that bar rather than leaving it where it was. A description is
 * usually written to be read later; a comment thread is people talking, and is
 * far more likely to name a person, paste a log line, or quote a message. Read
 * what this produces before pointing any tool at it.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_TOKENS, estimateTokens } from "../server-portable/chunk.ts";
import { describeEnv, envFiles, loadEnv } from "./env.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Before anything reads process.env. A real environment variable still wins —
// see env.ts — so this only fills in what the shell did not already provide.
const ENV_SOURCES = loadEnv();

const API = "https://api.linear.app/graphql";
const KEY = process.env.LINEAR_API_KEY;
const TEAM = process.env.OB1_CORPUS_TEAM ?? "SMD";
/** Which workflow-state type to collect. "completed" reproduces the old corpus. */
const STATE = process.env.OB1_CORPUS_STATE ?? "completed";
const OUT = process.env.OB1_CORPUS_OUT ?? "/tmp/linear-corpus-full.json";
/** Set to "off" to emit descriptions only, for comparison against the old corpus. */
const WITH_COMMENTS = (process.env.OB1_CORPUS_COMMENTS ?? "on").toLowerCase() !== "off";

/**
 * Drop documents shorter than this many characters. Defaults to 0 — keep
 * everything — so the corpus matches Linear unless you ask otherwise.
 *
 * Worth raising for a retrieval benchmark. `eval-real.ts` asks "given the title,
 * find the body", and a body of 3 characters cannot encode its title: it is not
 * a hard query, it is not a query. In the 441-document build, 18 documents fall
 * under 120 characters and the three shortest — 3, 15 and 21 characters — were
 * the top three reported misses for both models. They set a noise floor rather
 * than measuring anything.
 *
 * Left at 0 by default anyway, because a real brain does contain thin notes and
 * silently discarding rows would make the document count disagree with Linear's.
 */
const MIN_CHARS = Number(process.env.OB1_CORPUS_MIN_CHARS ?? 0);
if (!Number.isFinite(MIN_CHARS) || MIN_CHARS < 0) {
  // `Number("abc")` is NaN, and `length >= NaN` is false for every document — so
  // a typo here would not error, it would write an empty corpus and report
  // percentiles over nothing.
  console.error(`OB1_CORPUS_MIN_CHARS must be a non-negative number, got "${process.env.OB1_CORPUS_MIN_CHARS}".`);
  process.exit(2);
}

if (!KEY) {
  console.error(
    `LINEAR_API_KEY is not set, and no .env file supplied it.\n\n` +
      `  Create a personal API key at https://linear.app/settings/api, then either\n` +
      `  put it in a .env file (gitignored — copy evals/.env.example):\n\n` +
      `    LINEAR_API_KEY=lin_api_...\n\n` +
      `  or pass it for one run:\n\n` +
      `    LINEAR_API_KEY=lin_api_... bun build-linear-corpus.ts\n\n` +
      `  Looked for a .env in, in order:\n` +
      envFiles().map((f) => `    ${f}`).join("\n") +
      `\n\n  Read: ${describeEnv(ENV_SOURCES)}\n`
  );
  process.exit(2);
}

/**
 * Refuse to write into the repository, whatever the caller asked for.
 *
 * The repo is public. A corpus file committed by accident is not a mistake you
 * can take back by deleting it in the next commit, so the check is here rather
 * than left to .gitignore — which only protects the two patterns someone
 * remembered to add.
 */
const outPath = resolve(OUT);
if (outPath.startsWith(REPO_ROOT + "/")) {
  console.error(
    `Refusing to write inside the repository.\n\n` +
      `  ${outPath}\n\n` +
      `This repo is public and the corpus is internal data. Write to /tmp, or set\n` +
      `OB1_CORPUS_OUT to a path outside ${REPO_ROOT}.\n`
  );
  process.exit(2);
}

// ── Fetch ────────────────────────────────────────────────────────────────────

type Comment = { body: string; createdAt: string };
type Node = {
  identifier: string;
  title: string;
  description: string | null;
  completedAt: string | null;
  labels: { nodes: { name: string }[] };
  comments: { nodes: Comment[]; pageInfo: { hasNextPage: boolean } };
};

const QUERY = `
query Corpus($after: String, $team: String!, $state: String!) {
  issues(
    first: 50
    after: $after
    filter: { team: { key: { eq: $team } }, state: { type: { eq: $state } } }
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier
      title
      description
      completedAt
      labels { nodes { name } }
      comments(first: 100) {
        pageInfo { hasNextPage }
        nodes { body createdAt }
      }
    }
  }
}`;

async function page(after: string | null): Promise<{ nodes: Node[]; next: string | null }> {
  const res = await fetch(API, {
    method: "POST",
    // Linear personal API keys go in Authorization raw, with no Bearer prefix.
    // OAuth access tokens do take one, so both spellings are handled rather than
    // failing with an opaque 401 for half of all callers.
    headers: {
      Authorization: KEY!.startsWith("lin_api_") ? KEY! : `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: QUERY, variables: { after, team: TEAM, state: STATE } }),
  });

  if (!res.ok) {
    throw new Error(`Linear returned HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    data?: { issues: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } };
    errors?: { message: string }[];
  };
  // A GraphQL error arrives with HTTP 200 and an `errors` array. Checking only
  // res.ok would treat it as an empty page and silently build a short corpus.
  if (json.errors?.length) throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  if (!json.data) throw new Error("Linear returned no data and no errors, which should not happen.");

  return {
    nodes: json.data.issues.nodes,
    next: json.data.issues.pageInfo.hasNextPage ? json.data.issues.pageInfo.endCursor : null,
  };
}

console.log(`▸ config: ${describeEnv(ENV_SOURCES)}`);
console.log(`▸ team ${TEAM}, state "${STATE}", comments ${WITH_COMMENTS ? "included" : "excluded"}`);

const nodes: Node[] = [];
let after: string | null = null;
try {
  do {
    const p: { nodes: Node[]; next: string | null } = await page(after);
    nodes.push(...p.nodes);
    after = p.next;
    process.stdout.write(`\r▸ fetched ${nodes.length} issues`);
  } while (after);
  console.log();
} catch (e) {
  // A bad key is the overwhelmingly likely cause and it is a configuration
  // mistake, not a crash. Printing the message and exiting beats a stack trace
  // through fetch() that buries the one line explaining what to fix.
  console.error(`\n\n${(e as Error).message}\n`);
  if (/HTTP 40[13]/.test((e as Error).message)) {
    console.error("That looks like an authentication failure. Check LINEAR_API_KEY.\n");
  }
  process.exit(1);
}

if (nodes.length === 0) {
  console.error(`No issues matched team "${TEAM}" in state "${STATE}". Check OB1_CORPUS_TEAM.`);
  process.exit(1);
}

// ── Compose ──────────────────────────────────────────────────────────────────

/**
 * The document, and what is deliberately NOT in it.
 *
 * `eval-real.ts` uses the TITLE as the query and this text as the document, so
 * putting the title into the text would place the query verbatim inside its own
 * answer and inflate every score. The old corpus got this right; keep it right.
 *
 * Comments are appended plainly, without author names. Who said it is not a
 * retrieval signal, and leaving names out keeps one class of personal data from
 * spreading into a file that gets embedded.
 */
function compose(n: Node): string {
  const parts = [(n.description ?? "").trim()];
  if (WITH_COMMENTS) {
    for (const c of n.comments.nodes) {
      const body = c.body?.trim();
      if (body) parts.push(body);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

const truncatedThreads = nodes.filter((n) => n.comments.pageInfo.hasNextPage).map((n) => n.identifier);

const items = nodes
  .map((n) => ({
    id: n.identifier,
    title: n.title,
    // `text` is what the harness embeds. `description` and `comments` are kept
    // beside it so a later harness can score the two halves separately without
    // another round trip to Linear.
    text: compose(n),
    description: (n.description ?? "").trim(),
    comments: WITH_COMMENTS ? n.comments.nodes.map((c) => c.body.trim()).filter(Boolean) : [],
    labels: n.labels.nodes.map((l) => l.name),
    completedAt: n.completedAt,
  }))
  .filter((it) => it.text.length > 0 && it.text.length >= MIN_CHARS)
  .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

if (items.length === 0) {
  console.error(
    `Every one of the ${nodes.length} issues fetched was filtered out.` +
      (MIN_CHARS > 0 ? ` OB1_CORPUS_MIN_CHARS=${MIN_CHARS} is probably too high.` : "")
  );
  process.exit(1);
}

await Bun.write(outPath, JSON.stringify(items, null, 2));

// ── Report ───────────────────────────────────────────────────────────────────

const lens = items.map((i) => i.text.length).sort((a, b) => a - b);
const toks = items.map((i) => estimateTokens(i.text));
const pct = (p: number) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
const chunkable = toks.filter((t) => t > DEFAULT_MAX_TOKENS).length;
const withComments = items.filter((i) => i.comments.length > 0).length;
const dropped = nodes.length - items.length;

console.log(`\n▸ wrote ${items.length} documents to ${outPath}\n`);
console.log(`  characters   min ${lens[0]}  p50 ${pct(0.5)}  p90 ${pct(0.9)}  max ${lens[lens.length - 1]}`);
console.log(`  est. tokens  max ${Math.max(...toks)}  total ${toks.reduce((a, b) => a + b, 0).toLocaleString()}`);
console.log(`  with comments        ${withComments} of ${items.length}`);
console.log(`  over the ${DEFAULT_MAX_TOKENS}-token chunk threshold  ${chunkable} of ${items.length}`);
if (dropped > 0) {
  const why = MIN_CHARS > 0 ? `empty, or under OB1_CORPUS_MIN_CHARS=${MIN_CHARS}` : "no description, no comments";
  console.log(`  skipped (${why})  ${dropped}`);
}
// A one-line issue is not a retrieval document. Reported rather than filtered,
// because the right floor depends on what you are measuring and silently
// dropping rows would make the document count disagree with Linear's.
const tiny = items.filter((i) => i.text.length < 120).length;
if (tiny > 0) {
  console.log(`  under 120 characters (too thin to retrieve by title)  ${tiny}`);
  console.log(`    they cap MRR at ${((items.length - tiny) / items.length).toFixed(3)} — set OB1_CORPUS_MIN_CHARS=120 to exclude them`);
}
if (truncatedThreads.length > 0) {
  console.log(`\n  ⚠  ${truncatedThreads.length} issue(s) have more than 100 comments and were cut:`);
  console.log(`     ${truncatedThreads.slice(0, 10).join(", ")}`);
}

console.log(
  `\n  Baselines in evals/baselines.json were measured on the OLD corpus — 97 documents\n` +
    `  truncated to ~500 characters. They are not comparable to anything measured on this\n` +
    `  one. Re-run the model comparison before quoting a number against it:\n\n` +
    `    OB1_EVAL_CORPUS=${outPath} bun eval-real.ts qwen3-embedding:4b embeddinggemma\n`
);

if (chunkable === 0) {
  console.log(
    `  Note: nothing here exceeds the chunk threshold, so this corpus still cannot\n` +
      `  measure chunking or contextual retrieval. That is a fact about the issues,\n` +
      `  not about the builder.\n`
  );
}

console.log(`  This file is internal data. It stays out of git and away from hosted providers.\n`);
