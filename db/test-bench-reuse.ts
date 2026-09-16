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
 * IS the kept database for the six runs, nothing outlives the suite, and
 * there is nothing to remove on the way out or on a Ctrl-C (the first drafts
 * drove the wrapper themselves, six kept volumes and their cleanup; three
 * review passes found seams in that lifecycle, which was the finding). The
 * marker table is dropped at the end so a shared database is left as the
 * other suites expect it. About three minutes.
 *
 *   ./with-postgres.sh bun test-bench-reuse.ts
 */
import { SQL } from "bun";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert, requireDatabaseUrl, runScript, shellWithoutOb1 } from "./test-support.ts";

const { assert, report } = createAssert();
const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = requireDatabaseUrl("test-bench-reuse.ts");
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

/** The scored tables of two reports on the same index agree, and there are tables to agree on. */
function sameScored(a: { out: string; label: string }, b: { out: string; label: string }, claim: string): void {
  const [sa, sb] = [scored(a.out), scored(b.out)];
  const rows = sa.split("\n").length;
  assert(rows >= 12, `the scored tables have rows to compare (${rows})`);
  assert(sa === sb, claim);
  if (sa !== sb) console.log(`--- ${a.label}\n${sa}\n--- ${b.label}\n${sb}`);
}

/** Section L's `oracle …` for a reused corpus. */
const oracleCell = (out: string) => /\| reused \(built [^)]*\), (oracle [^|]*) \|/.exec(out)?.[1] ?? null;
/** The confound line — the one number the oracle alone decides. */
const confound = (out: string) => /nearest query-to-row cosine (\d\.\d{3}) over this run's/.exec(out)?.[1] ?? null;

const sql = new SQL(URL_);
try {
  console.log(`[1] build at ${SCALE.toLocaleString()} rows with Q=5, kept in this database`);
  const r1 = await bench(5);
  assert(r1.code === 0, `the build runs (exit ${r1.code})`);
  assert(r1.out.includes("| loaded |"), "section L says loaded");
  assert(r1.out.includes("corpus kept: marker written, with the exact pass's answers for 5 queries"), "the marker is written with the exact pass's five answers per key");
  if (r1.code !== 0) throw new Error(`the build failed:\n${r1.out}`);

  console.log("[2] reuse with Q=3: every answer from the marker");
  const r2 = await bench(3);
  assert(r2.code === 0, `the reuse runs (exit ${r2.code})`);
  assert(r2.out.includes("exact oracle      reused from the marker (the first 3 of the 5 it keeps) done"), "the run says the oracle was reused, the first three of five");
  assert(oracleCell(r2.out) === "oracle reused", `section L says oracle reused (${oracleCell(r2.out)})`);
  assert(!r2.out.includes("marker extended"), "a marker answering for every query is left as it is");
  assert(r2.out.includes("(all of them the marker's)"), "the confound is read from the marker's answers");

  console.log("[3] the marker's answers removed (as a marker from before SMD-1562 has none); Q=3 computes and extends");
  await sql`UPDATE bench_hnsw_corpus SET corpus = corpus - 'oracle'`;
  const r3 = await bench(3);
  assert(r3.code === 0, `the reuse runs (exit ${r3.code})`);
  assert(oracleCell(r3.out) === "oracle computed", `section L says oracle computed (${oracleCell(r3.out)})`);
  assert(r3.out.includes("marker extended: the exact pass's answers for 3 queries (had none)"), "the marker is extended with the three computed answers");
  sameScored({ out: r2.out, label: "from the marker" }, { out: r3.out, label: "computed" }, "sections A, B, D and E from the marker's answers equal the ones from computed answers, on the same index");
  assert(confound(r2.out) !== null && confound(r2.out) === confound(r3.out), `the confound agrees (${confound(r2.out)} / ${confound(r3.out)})`);

  console.log("[4] Q=6: three from the marker, three computed, the marker extended");
  const r4 = await bench(6);
  assert(r4.code === 0, `the reuse runs (exit ${r4.code})`);
  assert(r4.out.includes("exact oracle      3 of 6 queries from the marker, computing the rest"), "the run says which queries came from the marker");
  assert(oracleCell(r4.out) === "oracle extended (3 of 6 from the marker)", `section L says oracle extended (${oracleCell(r4.out)})`);
  assert(r4.out.includes("marker extended: the exact pass's answers for 6 queries (had 3, 3 of them this run's)"), "the marker now holds six");

  console.log("[5] Q=6 again: all six from the marker, the tables as run 4's");
  const r5 = await bench(6);
  assert(r5.code === 0, `the reuse runs (exit ${r5.code})`);
  assert(r5.out.includes("exact oracle      reused from the marker (all 6 queries) done"), "the run says every answer was the marker's");
  assert(oracleCell(r5.out) === "oracle reused", `section L says oracle reused (${oracleCell(r5.out)})`);
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
  // The marker this suite planted, so a shared database (ci-parity.sh's) is
  // not left refusing the next suite's schema reset.
  await sql`DROP TABLE IF EXISTS bench_hnsw_corpus`;
  await sql.close();
}

report();
