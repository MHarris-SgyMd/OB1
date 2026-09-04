#!/usr/bin/env bun
/**
 * eval-chunking-e2e.ts — does chunking actually recover long-document retrieval?
 *
 * test-chunking.ts proves the mechanism against a stub whose ceiling is imposed by
 * the stub itself. That is the right shape for CI — deterministic, no model — but
 * it means the *benefit* was asserted rather than measured: a stub that refuses
 * over-batch input cannot show what a real provider's silent truncation costs, nor
 * what chunking buys back.
 *
 * This runs the real server, over MCP, against real Ollama and real Postgres, and
 * captures documents whose answer is in the final sentence. Then it searches for
 * that answer. Chunking off is the honest baseline: the same server with
 * OB1_CHUNK_TOKENS set high enough that nothing splits, which is exactly how the
 * server behaved before migration 007.
 *
 *   OB1_EVAL_EMBED=embeddinggemma ../db/with-postgres.sh bun eval-chunking-e2e.ts
 *
 * Needs a running Ollama. Nothing leaves the machine.
 */

import { SQL } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { estimateTokens } from "../server-portable/chunk.ts";
import { migrationValues, substituteMigration } from "../db/config.mjs";
import { assertThrowawayDatabase } from "../db/test-support.ts";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun eval-chunking-e2e.ts");
  process.exit(2);
}

const OLLAMA = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";
const EMBED = process.env.OB1_EVAL_EMBED ?? "embeddinggemma";
const META = process.env.OB1_EVAL_META ?? "qwen2.5:7b";

/** Resolved from the live model so the schema matches whatever is configured. */
const probe = await fetch(`${OLLAMA}/embeddings`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ model: EMBED, input: "probe" }),
});
if (!probe.ok) {
  console.error(`Cannot reach Ollama at ${OLLAMA}: ${probe.status}. Is \`ollama serve\` running?`);
  process.exit(2);
}
const DIM = ((await probe.json()) as { data: [{ embedding: number[] }] }).data[0].embedding.length;

const FILLER = "We went round the same arguments as last quarter without much new evidence. " +
  "There was a digression about whether the vendor evaluation was still valid, and whether " +
  "anyone had re-run the load tests since the schema change landed. Nobody had, so the action " +
  "was to book time before the next review. The cost model came up again: the sheet assumes " +
  "steady traffic, which has not matched reality for two quarters. ";

/** Distinct conclusions, each the final sentence of an otherwise identical document. */
const CASES = [
  { key: "budget",   tail: "The decision, finally: we approved eighty thousand pounds for the observability migration.",
    query: "how much did we approve for the observability work?" },
  { key: "kafka",    tail: "The conclusion nobody wrote down: we are keeping Kafka and dropping the direct-to-Postgres path.",
    query: "did we decide to keep Kafka?" },
  { key: "mentor",   tail: "The thing worth remembering: Anita should mentor Dev's move into platform work.",
    query: "who should mentor Dev's move into platform?" },
  { key: "rollback", tail: "What we settled on: the rollback window stays at thirty minutes and anything longer needs sign-off.",
    query: "how long is the rollback window?" },
];

/** Identical leads, so nothing can be retrieved by its opening. */
const LEAD = "Notes from the session, written up afterwards so the detail is not lost.";
const build = (repeats: number, tail: string): string => `${LEAD} ${FILLER.repeat(repeats)} ${tail}`;

async function freshSchema(): Promise<void> {
  // The same refusal every other schema-resetting script gets from dropSchema.
  // This one drops on its own because it also clears the ledger and ob1_config.
  assertThrowawayDatabase(URL_);
  const admin = new SQL({ url: URL_, max: 1 });
  await admin`DROP TABLE IF EXISTS thought_chunks CASCADE`;
  await admin`DROP TABLE IF EXISTS thoughts CASCADE`;
  await admin`DROP TABLE IF EXISTS schema_migrations CASCADE`;
  await admin`DROP TABLE IF EXISTS ob1_config CASCADE`;
  for (const f of readdirSync(join(HERE, "..", "db", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
    // The shared substitution, not a private .replace() chain: 011 added a
    // {{TRGM_INDEX}} the chain here never knew about, and Postgres met it raw.
    await admin.unsafe(
      substituteMigration(readFileSync(join(HERE, "..", "db", "migrations", f), "utf8"), migrationValues({ dim: DIM, model: EMBED }), f)
    );
  }
  await admin.close();
}

/**
 * The server reads its environment once at boot, so each configuration needs its
 * own process. A child process is the honest way to compare two settings of a
 * value the server deliberately snapshots.
 */
async function runOne(chunkTokens: number, repeats: number): Promise<{ found: number; chunks: number }> {
  await freshSchema();
  const script = join(HERE, "_chunk-e2e-child.ts");
  const proc = Bun.spawn(["bun", script], {
    env: {
      ...process.env,
      DATABASE_URL: URL_,
      OB1_STORE: "sql",
      OB1_LLM_BASE_URL: OLLAMA,
      OB1_EMBEDDING_MODEL: EMBED,
      OB1_EMBEDDING_DIM: String(DIM),
      OB1_METADATA_MODEL: META,
      OB1_CHUNK_TOKENS: String(chunkTokens),
      MCP_ACCESS_KEY: "eval-key",
      OB1_EVAL_REPEATS: String(repeats),
      OB1_EVAL_CASES: JSON.stringify(CASES.map((c) => ({ ...c, text: build(repeats, c.tail) }))),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const m = out.match(/RESULT (\d+) (\d+)/);
  if (!m) { console.error(err.slice(-600)); throw new Error("child produced no result"); }
  return { found: Number(m[1]), chunks: Number(m[2]) };
}

const NO_CHUNKING = 1_000_000;   // effectively disabled: the pre-007 behaviour
const CHUNKING = 1200;

console.log(`\n  real server → real Ollama (${EMBED}, ${DIM}d) → real Postgres`);
console.log(`  ${CASES.length} documents per row, identical but for the final sentence, queried by that sentence\n`);
console.log("  document size   chunking off      chunking on");
console.log("  " + "─".repeat(56));

// Sizes are measured from the document that actually gets built, not inferred
// from the repeat count. An earlier version labelled these by guesswork and
// reported a "4K" row that was really ~1800 tokens — under the provider's ceiling,
// so it passed without chunking and made the feature look useless at that size.
for (const repeats of [5, 22, 45, 90]) {
  const size = estimateTokens(build(repeats, CASES[0].tail));
  const off = await runOne(NO_CHUNKING, repeats);
  const on = await runOne(CHUNKING, repeats);
  console.log(
    `  ${`~${size} tokens`.padEnd(15)} ${`${off.found}/${CASES.length}`.padStart(6)}            ` +
    `${`${on.found}/${CASES.length}`.padStart(6)}   (${on.chunks} chunk rows)`
  );
}
console.log(`\n  "found" = the document was ranked first for a query about its own final sentence.`);
