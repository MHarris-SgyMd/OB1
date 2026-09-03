#!/usr/bin/env bun
/**
 * eval-keyword.ts — the claim SMD-944 rests on, tested against real data.
 *
 * The issue asserts that vector search cannot find an exact token: an error code,
 * a ticket key, a commit SHA, a symbol name. That is a plausible statement about
 * how embeddings work, and it is also exactly the kind of statement this fork has
 * twice published as measured when it was not. So it is measured here.
 *
 * ── The task ─────────────────────────────────────────────────────────────────
 * From a real corpus, take every token that appears in EXACTLY ONE document —
 * a hapax by document frequency — and keep the ones that are identifier-shaped:
 * containing a digit, an underscore, a dot, a slash, or interior capitals. Those
 * are the queries. The answer is the one document containing the token.
 *
 * Then ask both instruments the same question and record where the right document
 * lands:
 *
 *   VECTOR   embed the token as a query, cosine against every document, take the
 *            rank of the containing document. The server's own prompt template is
 *            used (via evals/lib.ts), so this is what production would do.
 *
 *   KEYWORD  `search_thoughts_keyword` running in a real Postgres over the same
 *            documents, with migration 011's trigram index built. Not a
 *            JavaScript reimplementation of the same idea — the point is to test
 *            the shipped function, including its escaping, its ordering, and
 *            whether the answer is actually FIRST rather than merely present.
 *
 * ── Why identifier-shaped, and not just any rare word ────────────────────────
 * A rare English word is a case embeddings handle reasonably: "harpsichord" has a
 * meaningful representation. The claim is about strings that do not, and letting
 * ordinary rare words into the query set would dilute the measurement toward a
 * flattering average. Restricting to identifiers is the harder, narrower, and
 * honest reading of the claim. `--all-hapax` relaxes it, and the difference
 * between the two numbers is itself worth knowing.
 *
 * ── Data handling ────────────────────────────────────────────────────────────
 * The default corpus is internal engineering data. It is read from a path outside
 * the repository, is never written anywhere, and goes only to a local Ollama and
 * a throwaway local Postgres. Nothing here may point at a hosted provider — see
 * evals/README.md.
 *
 *   ./db/with-postgres.sh bun evals/eval-keyword.ts qwen3-embedding:4b
 *   OB1_EVAL_CORPUS=/tmp/linear-corpus-full.json ./db/with-postgres.sh bun evals/eval-keyword.ts
 */

import { SQL } from "bun";
import { embed, cosine } from "./lib.ts";
import { resetSchema } from "../db/test-support.ts";

const CORPUS = process.env.OB1_EVAL_CORPUS ?? "/tmp/linear-corpus-full.json";
const MODEL = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "qwen3-embedding:4b";
const ALL_HAPAX = process.argv.includes("--all-hapax");
/** How deep a vector result counts as "found at all". The issue says 10. */
const TOPN = Number(process.env.OB1_EVAL_TOPN ?? 10);
/** Cap the query set so a run is minutes, not hours. 0 means all of them. */
const MAX_QUERIES = Number(process.env.OB1_EVAL_MAX_QUERIES ?? 60);

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("eval-keyword.ts needs DATABASE_URL. Run it under db/with-postgres.sh.");
  process.exit(2);
}

type Item = { id: string; title: string; text: string };
const ITEMS: Item[] = JSON.parse(await Bun.file(CORPUS).text());
if (ITEMS.length === 0) {
  console.error(`${CORPUS} holds no documents.`);
  process.exit(2);
}

// ── Query selection ──────────────────────────────────────────────────────────

/**
 * Tokens, split on whitespace and on the punctuation that surrounds identifiers
 * rather than the punctuation inside them. `SMD-944`, `upsert_thought`,
 * `db/config.mjs` and `PGRST202` survive as single tokens; `(foo)` and `bar,`
 * lose their wrappers.
 */
function tokenize(text: string): string[] {
  return text
    .split(/[\s`"'(){}\[\]<>,;:!?*|]+/)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter((t) => t.length >= 4 && t.length <= 40);
}

/**
 * What kind of string this is, which is reported separately because the three
 * kinds are not equally interesting and an average over them can mislead.
 *
 * `code`  — has a digit or an underscore: SMD-506, temporal_activity, PGRST202.
 *           The case the issue is actually about.
 * `path`  — a slash or a dot joining words: db/config.mjs, but also UI/API and
 *           disabled/replaced, which are two ordinary English words with
 *           punctuation between them. An embedding failing on those is much less
 *           surprising, and they were the deepest-ranked queries in the first run
 *           — so lumping them in would have let the weakest cases carry the
 *           headline.
 * `camel` — interior capitals: getUserById.
 * `word`  — none of the above: an ordinary rare word. Excluded from the default
 *           query set, and only reachable under `--all-hapax`. It has its own
 *           label rather than being folded into one of the others: an earlier
 *           version coerced these to `code`, so `--all-hapax` would have
 *           reported plain English words in the row labelled "digit or
 *           underscore" and produced a table that was wrong rather than noisy.
 */
type Shape = "code" | "path" | "camel" | "word";
function shapeOf(t: string): Shape {
  if (/^\d+$/.test(t)) return "word";                // a bare number is not an identifier
  if (/\d/.test(t) || /_/.test(t)) return "code";
  if (/[/.]/.test(t)) return "path";
  if (/[a-z][A-Z]/.test(t)) return "camel";
  return "word";
}

const df = new Map<string, Set<string>>();
for (const it of ITEMS) {
  for (const t of new Set(tokenize(it.text))) {
    if (!df.has(t)) df.set(t, new Set());
    df.get(t)!.add(it.id);
  }
}

/**
 * Hapax by SUBSTRING, not by token.
 *
 * The first version of this selected tokens appearing in exactly one document
 * and stopped there, and the control below rejected the run: "SMD-50" is a token
 * in one document and a substring of three, because SMD-500 and SMD-501 exist.
 * So does "risk_level", inside "risk_levels". Token-uniqueness is not
 * substring-uniqueness, and a query set built on the first would have made the
 * keyword column's 100% an artefact of a definition rather than a property of the
 * function.
 *
 * Token frequency is still the cheap first pass — it removes almost everything
 * for the cost of one map — and substring uniqueness is then checked against the
 * whole corpus. The check duplicates the function's semantics in JavaScript,
 * which is acceptable HERE and only here: its job is to choose queries, and the
 * control still asks the real function whether the choice was right.
 */
const lowered = ITEMS.map((it) => ({ id: it.id, text: it.text.toLowerCase() }));
const substringHapax = (token: string): string | null => {
  const needle = token.toLowerCase();
  let found: string | null = null;
  for (const d of lowered) {
    if (!d.text.includes(needle)) continue;
    if (found !== null) return null;
    found = d.id;
  }
  return found;
};

let candidates = [...df.entries()]
  .filter(([, docs]) => docs.size === 1)
  .map(([token]) => ({ token, shape: shapeOf(token) }))
  .filter((c) => ALL_HAPAX || c.shape !== "word")
  .map((c) => ({ ...c, want: substringHapax(c.token) }))
  .filter((c): c is { token: string; shape: Shape; want: string } => c.want !== null);

if (candidates.length === 0) {
  console.error("No hapax tokens matched the filter — nothing to measure. Refusing to print a result.");
  process.exit(2);
}

// Deterministic sample rather than the first N, which would be the first N
// documents' vocabulary and nothing else.
candidates.sort((a, b) => (a.token < b.token ? -1 : 1));
if (MAX_QUERIES > 0 && candidates.length > MAX_QUERIES) {
  const step = candidates.length / MAX_QUERIES;
  candidates = Array.from({ length: MAX_QUERIES }, (_, i) => candidates[Math.floor(i * step)]);
}

// ── Load the corpus into Postgres ────────────────────────────────────────────

console.log(`\n  corpus   ${CORPUS} — ${ITEMS.length} documents`);
console.log(`  queries  ${candidates.length} ${ALL_HAPAX ? "hapax" : "identifier-shaped hapax"} tokens`);
console.log(`  model    ${MODEL}\n`);

process.stdout.write("  … loading Postgres");
await resetSchema(DB_URL, { dim: 8, model: "stub-embed", trgm: true });
const sql = new SQL({ url: DB_URL, max: 1 });
const byId = new Map<string, Item>();
for (let i = 0; i < ITEMS.length; i += 200) {
  const batch = ITEMS.slice(i, i + 200);
  await sql`INSERT INTO thoughts ${sql(batch.map((it) => ({ content: it.text, metadata: { ref: it.id } })))}`;
}
for (const it of ITEMS) byId.set(it.id, it);
await sql.unsafe("VACUUM ANALYZE thoughts");
process.stdout.write("\r  … embedding documents   \n");

// ── Vector arm ───────────────────────────────────────────────────────────────

const vecs: Record<string, number[]> = {};
for (const it of ITEMS) vecs[it.id] = await embed(MODEL, it.text);

// ── Both arms, per query ─────────────────────────────────────────────────────

type Row = { token: string; shape: Shape; want: string; vectorRank: number; keywordRank: number; keywordTotal: number };
const rows: Row[] = [];

for (const { token, shape, want } of candidates) {
  const qv = await embed(MODEL, token, true);
  const ranked = ITEMS.map((d) => ({ id: d.id, s: cosine(qv, vecs[d.id]) })).sort((a, b) => b.s - a.s);
  const vectorRank = ranked.findIndex((r) => r.id === want) + 1;

  const hits = await sql`
    SELECT metadata->>'ref' AS ref, total_count
    FROM search_thoughts_keyword(${token}, 25, 0, '{}'::jsonb)`;
  const keywordRank = hits.findIndex((h: { ref: string }) => h.ref === want) + 1;

  rows.push({
    token,
    shape,
    want,
    vectorRank,
    keywordRank,
    keywordTotal: hits.length ? Number(hits[0].total_count) : 0,
  });
}

// ── The control ──────────────────────────────────────────────────────────────
//
// These queries are hapax BY CONSTRUCTION: each token is in exactly one document,
// so keyword search must return exactly one row and it must be the right one.
// Anything else means the tokenizer and the SQL function disagree about what a
// token is, and every comparison below would be against a query set that does not
// mean what its label says. That has happened in this repo before, so it aborts.

const wrong = rows.filter((r) => r.keywordRank !== 1);
if (wrong.length) {
  console.error(
    `\n  ${wrong.length} of ${rows.length} queries are hapax by the tokenizer but not by the SQL function:\n` +
      wrong.slice(0, 5).map((r) => `    "${r.token}" → rank ${r.keywordRank}, ${r.keywordTotal} matches`).join("\n") +
      `\n\n  The query set does not mean what it says, so no comparison is printed.\n` +
      `  Usually the tokenizer split on a character the substring match does not.`
  );
  await sql.close();
  process.exit(1);
}

// ── Report ───────────────────────────────────────────────────────────────────

const n = rows.length;
const vMissed = rows.filter((r) => r.vectorRank > TOPN).length;
const vFirst = rows.filter((r) => r.vectorRank === 1).length;
const vMrr = rows.reduce((a, r) => a + 1 / r.vectorRank, 0) / n;

console.log(`\n  ${n} exact-token queries — the answer is the one document containing the token\n`);
console.log("  instrument                        R@1     not in top-" + String(TOPN).padEnd(3) + "  MRR");
console.log("  ───────────────────────────────   ─────   ────────────  ─────");
console.log(
  `  vector (${MODEL})`.padEnd(35) +
    `${((vFirst / n) * 100).toFixed(0).padStart(4)}%   ` +
    `${String(vMissed).padStart(4)}/${n}`.padEnd(12) + `  ${vMrr.toFixed(3)}`
);
console.log(
  "  keyword (search_thoughts_keyword)".padEnd(35) +
    `${(100).toFixed(0).padStart(4)}%   ` +
    `${String(0).padStart(4)}/${n}`.padEnd(12) + `  1.000`
);

console.log(
  `\n  Keyword is 100% by construction, not by merit: every query is a token in\n` +
    `  exactly one document, so a correct substring search cannot do worse. That\n` +
    `  is the point — the row exists to show the vector column is not.\n`
);

// Sliced, because the three shapes are not equally hard and the average hides it.
console.log("  The vector column, by what kind of string the query is:\n");
const SHAPE_NOTE: Record<Shape, string> = {
  code: "digit or underscore (SMD-506, foo_bar)",
  path: "slash or dot (UI/API, db/config.mjs)",
  camel: "interior capitals (getUserById)",
  word: "ordinary rare word (--all-hapax only)",
};
console.log("  shape                                            n    R@1   not in top-" + String(TOPN).padEnd(3) + " MRR");
console.log("  ──────────────────────────────────────────────  ───   ────  ───────────  ─────");
for (const shape of ["code", "path", "camel", "word"] as Shape[]) {
  const g = rows.filter((r) => r.shape === shape);
  if (!g.length) continue;
  const first = g.filter((r) => r.vectorRank === 1).length;
  const missed = g.filter((r) => r.vectorRank > TOPN).length;
  const mrr = g.reduce((a, r) => a + 1 / r.vectorRank, 0) / g.length;
  console.log(
    `  ${(shape + "  " + SHAPE_NOTE[shape]).padEnd(46)}  ${String(g.length).padStart(3)}   ` +
      `${((first / g.length) * 100).toFixed(0).padStart(3)}%   ` +
      `${(String(missed) + "/" + g.length).padStart(6).padEnd(11)}  ${mrr.toFixed(3)}`
  );
}
console.log();

const worst = rows.filter((r) => r.vectorRank > TOPN).sort((a, b) => b.vectorRank - a.vectorRank);
if (worst.length) {
  console.log(`  The ${Math.min(8, worst.length)} tokens the embedding ranked deepest:\n`);
  for (const r of worst.slice(0, 8)) {
    const title = byId.get(r.want)?.title ?? "";
    console.log(`    "${r.token}"`.padEnd(34) + `rank ${String(r.vectorRank).padStart(4)}   ${r.want} ${title.slice(0, 40)}`);
  }
  console.log();
} else {
  console.log("  The embedding placed every one of them inside the top " + TOPN + ".\n");
}

await sql.close();
