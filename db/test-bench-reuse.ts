#!/usr/bin/env bun
/**
 * test-bench-reuse.ts — a kept bench corpus answers the exact oracle from its
 * marker (SMD-1562), asserted end to end at a small scale.
 *
 * bench-hnsw.ts under OB1_PG_KEEP keeps the corpus it built and, since
 * SMD-1562, the exact pass's answers beside it: a reuse takes the answers
 * whose queries are its own (the leading ones), computes only what it lacks,
 * and extends the marker. The claim that matters is that the answers a reuse
 * takes from the marker are the answers it would have computed — so this
 * runs the bench six times against ONE database at 150,000 rows (the
 * smallest scale that is kept: the before arm's ceiling is 100,000) and
 * compares the tables that depend on the oracle between a run that read the
 * marker and a run that computed, on the SAME index (two builds would give
 * two HNSW graphs and two recall figures, which would say nothing about the
 * cache):
 *
 *   1. Q=5, builds — the marker holds five answers per key.
 *   2. Q=3, reuses — all three from the marker.
 *   3. the marker's answers are removed (a marker written before SMD-1562
 *      has none), and Q=3 again computes them and extends the marker:
 *      sections A, B, D and E equal run 2's, timings aside.
 *   4. Q=6 — three from the marker, three computed, the marker extended.
 *   5. Q=6 again — all six from the marker; the tables equal run 4's.
 *   6. the marker is marked `rewritten`, as a refused reuse leaves it, and a
 *      run is refused before the oracle is consulted.
 *
 * What "kept" means to the bench is the OB1_PG_KEEP variable and a marker
 * row; the container and its volume are with-postgres.sh's concern, held by
 * SMD-1493. So the suite runs under the wrapper like any other, and only
 * the bench it spawns is told the database is kept: the throwaway container
 * IS the kept database for the six runs and nothing outlives the suite (the
 * first drafts drove the wrapper themselves, six kept volumes and their
 * cleanup; three review passes found seams in that lifecycle, which was the
 * finding). The marker it plants is dropped on the way out — on a normal
 * exit and on a signal — so a shared database (ci-parity.sh's) is left as
 * the other suites expect it; a database that already holds a marker is
 * refused up front, since that marker is a kept corpus's and not this
 * suite's to drop (review pass). About three minutes.
 *
 *   ./with-postgres.sh bun test-bench-reuse.ts
 */
import { SQL } from "bun";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertThrowawayDatabase, createAssert, requireDatabaseUrl, runScript, shellWithoutOb1 } from "./test-support.ts";

const { assert, report } = createAssert();
const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = requireDatabaseUrl("test-bench-reuse.ts");
assertThrowawayDatabase(URL_);
const SCALE = 150_000;
/** The build's own knobs pass through from the shell — only run 1 builds, and neither can tell a reused answer from a computed one; every other OB1_* name is stripped (a width or a query count from the shell would change what is measured), and runScript keeps db/.env out of the spawned bun too. */
const PASS_THROUGH = ["OB1_BENCH_BUILD_WORKERS", "OB1_BENCH_MAINTENANCE_MEM"];

/** One bench run against this database, told it is kept, Q queries. */
function bench(q: number): Promise<{ code: number; out: string }> {
  const env = shellWithoutOb1();
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  return runScript(["bun", "bench-hnsw.ts"], { cwd: HERE, env: { ...env, DATABASE_URL: URL_, OB1_PG_KEEP: "test-reuse", OB1_BENCH_SCALES: String(SCALE), OB1_BENCH_QUERIES: String(q) } });
}

/**
 * Sections A, B, D and E of a report — the tables scored against the oracle —
 * with every timing column dropped (a header naming `ms`), as one string. Two
 * runs on the same corpus, index and queries agree on every other cell.
 */
function scored(out: string): string {
  const kept: string[] = [];
  let section = "";
  let mask: boolean[] | null = null;
  for (const line of out.split("\n")) {
    const h = /^### ([A-Z])\./.exec(line);
    if (h) {
      section = h[1];
      mask = null;
      continue;
    }
    if (!/^[ABDE]$/.test(section) || !line.startsWith("| ")) continue;
    const cells = line.slice(1, -1).split(" | ").map((c) => c.trim());
    if (!mask) {
      mask = cells.map((header) => !/\bms\b/.test(header));
      continue;
    }
    if (/^:?-+:?$/.test(cells[0])) continue;
    const keep = mask;
    kept.push(`${section}: ${cells.filter((_, i) => keep[i]).join(" | ")}`);
  }
  return kept.join("\n");
}

/** The scored tables of two reports on the same index agree, and every section is there to agree on (a renamed heading would otherwise agree vacuously). */
function sameScored(a: { out: string; label: string }, b: { out: string; label: string }, claim: string): void {
  const [sa, sb] = [scored(a.out), scored(b.out)];
  const missing = ["A", "B", "D", "E"].filter((s) => !sa.includes(`${s}: `));
  assert(missing.length === 0, `every scored section is present (${sa.split("\n").length} rows${missing.length ? `; missing ${missing.join(", ")}` : ""})`);
  assert(sa === sb, claim);
  if (sa !== sb) console.log(`--- ${a.label}\n${sa}\n--- ${b.label}\n${sb}`);
}

/** A cell of section L's one row, by its header. */
function loadCell(out: string, header: string): string | null {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("### L."));
  const table = lines.slice(at + 1).filter((l) => l.startsWith("| "));
  if (at < 0 || table.length < 3) return null;
  const cells = (l: string) => l.slice(1, -1).split(" | ").map((c) => c.trim());
  const i = cells(table[0]).indexOf(header);
  return i < 0 ? null : (cells(table[2])[i] ?? null);
}
/** The confound line — the one number the oracle alone decides. */
const confound = (out: string) => /nearest query-to-row cosine (\d\.\d{3}) over this run's/.exec(out)?.[1] ?? null;

const sql = new SQL(URL_);
const [{ has }] = await sql`SELECT to_regclass('bench_hnsw_corpus') IS NOT NULL AS has`;
if (has) {
  console.error("test-bench-reuse.ts: this database already holds a bench_hnsw_corpus marker — a kept corpus's, which this suite would neither replace nor drop. Run the suite against a throwaway database (./with-postgres.sh without OB1_PG_KEEP).");
  await sql.close();
  process.exit(2);
}
/** Whether run 1 wrote the marker this suite drops on the way out — never one it found. */
let planted = false;
async function dropPlanted(): Promise<void> {
  if (planted) await sql`DROP TABLE IF EXISTS bench_hnsw_corpus`;
}
// Bun runs no `finally` on a signal: the marker goes here too, then the exit
// the signal asked for (a terminal's Ctrl-C reaches the bench in flight as
// well; a signal to this process alone leaves it to finish on its own).
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, async () => {
    await dropPlanted().catch(() => {});
    process.exit(code);
  });
}

try {
  console.log(`[1] build at ${SCALE.toLocaleString()} rows with Q=5, kept in this database`);
  const r1 = await bench(5);
  planted = r1.out.includes("corpus kept: marker written");
  assert(r1.code === 0, `the build runs (exit ${r1.code})`);
  assert(loadCell(r1.out, "source") === "loaded" && loadCell(r1.out, "oracle") === "computed", `section L says loaded, oracle computed (${loadCell(r1.out, "source")}, ${loadCell(r1.out, "oracle")})`);
  assert(r1.out.includes("corpus kept: marker written, with the exact pass's answers for 5 queries"), "the marker is written with the exact pass's five answers per key");
  if (r1.code !== 0) throw new Error(`the build failed:\n${r1.out}`);

  console.log("[2] reuse with Q=3: every answer from the marker");
  const r2 = await bench(3);
  assert(r2.code === 0, `the reuse runs (exit ${r2.code})`);
  assert(r2.out.includes("exact oracle      reused from the marker (the first 3 of the 5 it keeps) done"), "the run says the oracle was reused, the first three of five");
  assert(loadCell(r2.out, "oracle") === "reused", `section L says oracle reused (${loadCell(r2.out, "oracle")})`);
  assert(!r2.out.includes("marker extended"), "a marker answering for every query is left as it is");
  assert(r2.out.includes("(all of them the marker's)"), "the confound is read from the marker's answers");

  console.log("[3] the marker's answers removed (as a marker from before SMD-1562 has none); Q=3 computes and extends");
  await sql`UPDATE bench_hnsw_corpus SET corpus = corpus - 'oracle'`;
  const r3 = await bench(3);
  assert(r3.code === 0, `the reuse runs (exit ${r3.code})`);
  assert(loadCell(r3.out, "oracle") === "computed", `section L says oracle computed (${loadCell(r3.out, "oracle")})`);
  assert(r3.out.includes("marker extended: the exact pass's answers for 3 queries (had none)"), "the marker is extended with the three computed answers");
  sameScored({ out: r2.out, label: "from the marker" }, { out: r3.out, label: "computed" }, "sections A, B, D and E from the marker's answers equal the ones from computed answers, on the same index");
  assert(confound(r2.out) !== null && confound(r2.out) === confound(r3.out), `the confound agrees (${confound(r2.out)} / ${confound(r3.out)})`);

  console.log("[4] Q=6: three from the marker, three computed, the marker extended");
  const r4 = await bench(6);
  assert(r4.code === 0, `the reuse runs (exit ${r4.code})`);
  assert(r4.out.includes("exact oracle      3 of 6 queries from the marker, computing the rest"), "the run says which queries came from the marker");
  assert(loadCell(r4.out, "oracle") === "3 of 6 reused, the rest computed", `section L says three of six reused (${loadCell(r4.out, "oracle")})`);
  assert(r4.out.includes("marker extended: the exact pass's answers for 6 queries (had 3, 3 of them this run's)"), "the marker now holds six");

  console.log("[5] Q=6 again: all six from the marker, the tables as run 4's");
  const r5 = await bench(6);
  assert(r5.code === 0, `the reuse runs (exit ${r5.code})`);
  assert(r5.out.includes("exact oracle      reused from the marker (all 6 queries) done"), "the run says every answer was the marker's");
  assert(loadCell(r5.out, "oracle") === "reused", `section L says oracle reused (${loadCell(r5.out, "oracle")})`);
  sameScored({ out: r4.out, label: "extended" }, { out: r5.out, label: "from the marker" }, "sections A, B, D and E from the extended marker equal the run that extended it");

  console.log("[6] a corpus marked rewritten is refused before the oracle is consulted");
  await sql`UPDATE bench_hnsw_corpus SET corpus = corpus || '{"rewritten":["test-bench-reuse.ts marked it"]}'::jsonb`;
  const r6 = await bench(3);
  assert(r6.code === 2, `the run is refused (exit ${r6.code})`);
  assert(r6.out.includes("had its tables changed by migrations applied onto it on an earlier run"), "with the rewritten refusal");
  assert(!r6.out.includes("exact oracle"), "and the cached answers were never read");
} catch (err) {
  // A throw is a failure with a tally, not a stack trace in place of one —
  // the stack kept, since the next run is three minutes of exact passes.
  assert(false, `the suite stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  await dropPlanted();
  await sql.close();
}

report();
