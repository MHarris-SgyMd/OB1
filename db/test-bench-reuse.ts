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
 * runs the bench six times under one kept name at 150,000 rows (the smallest
 * scale that is kept: the before arm's ceiling is 100,000) and compares the
 * tables that depend on the oracle between a run that read the marker and a
 * run that computed, on the SAME kept index (two builds would give two HNSW
 * graphs and two recall figures, which would say nothing about the cache):
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
 * Needs podman or docker (it drives with-postgres.sh itself, so it runs
 * WITHOUT the wrapper), about three minutes, and removes the volume it kept —
 * on the way out, and on an interrupt: a signal is noted, the run in flight
 * is let finish (a terminal's Ctrl-C reaches the wrapper too, which stops and
 * removes its container; a signal to this process alone waits for the run,
 * a minute at most), no further run starts, and the container and volume
 * are removed by the name both carry before exiting as the signal would
 * have (review passes).
 *
 *   bun test-bench-reuse.ts
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssert, runScript, shellWithoutOb1 } from "./test-support.ts";

const { assert, report } = createAssert();
const HERE = dirname(fileURLToPath(import.meta.url));
const SCALE = 150_000;
/** One kept name per run of this suite, so a failed run's volume cannot be mistaken for the next run's; the container and the volume both carry it. */
const KEEP = `test-reuse-${Date.now().toString(36)}`;
const NAME = `ob1-pg-keep-${KEEP}`;
/**
 * The wrapper's and the build's own knobs pass through from the shell — a
 * registry mirror's image, the shared memory, the build's workers and memory
 * — since only run 1 builds and none of them can tell a reused answer from a
 * computed one; every other OB1_* name is stripped (a width or a query count
 * from the shell would change what is measured), and runScript keeps db/.env
 * out of the spawned bun too. Not the port: six containers in a row on one
 * fixed port would race the previous one's release.
 */
const PASS_THROUGH = ["OB1_PG_IMAGE", "OB1_PG_SHM_SIZE", "OB1_BENCH_BUILD_WORKERS", "OB1_BENCH_MAINTENANCE_MEM"];
function env(extra: Record<string, string>): Record<string, string> {
  const base = shellWithoutOb1();
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) base[k] = process.env[k]!;
  return { ...base, OB1_BENCH_SCALES: String(SCALE), ...extra };
}

/** The exit code a signal asked for, once one has arrived; the run in flight finishes, nothing else starts. */
let interrupted: number | null = null;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    if (interrupted !== null) return;
    interrupted = code;
    console.error(`\n  ${signal}: finishing the run in flight, then removing the kept container and volume ${NAME}`);
  });
}
class Interrupted extends Error {}
/** The runtime as the wrapper found it, read from the first run that printed it; nothing was kept where none did. */
let runtime: string | null = null;
async function run(cmd: string[], extra: Record<string, string>): Promise<{ code: number; out: string }> {
  const r = await runScript(cmd, { cwd: HERE, env: env(extra) });
  runtime ??= /\(via (\S+)\)/.exec(r.out)?.[1] ?? null;
  if (interrupted !== null) throw new Interrupted();
  return r;
}

/** One bench run under the kept name, Q queries. */
const bench = (q: number) => run(["./with-postgres.sh", "bun", "bench-hnsw.ts"], { OB1_PG_KEEP: KEEP, OB1_BENCH_QUERIES: String(q) });

/** One statement against the kept database, through the wrapper (the only door to it). */
const onKept = (statement: string) =>
  run(["./with-postgres.sh", "bun", "-e", `import { SQL } from "bun"; const sql = new SQL(process.env.DATABASE_URL); await sql.unsafe(${JSON.stringify(statement)}); await sql.close();`], { OB1_PG_KEEP: KEEP });

/**
 * The kept container (one the wrapper is still stopping, after an interrupt)
 * and then the volume, by the name both carry — safe by name here, where
 * the wrapper removes only by ID, because the name is this run's alone; the
 * volume may take a moment to free. True where nothing was ever kept.
 */
async function removeKept(): Promise<boolean> {
  if (!runtime) return true;
  await runScript([runtime, "rm", "-f", NAME], { cwd: HERE });
  for (let i = 0; i < 10; i++) {
    if ((await runScript([runtime, "volume", "rm", NAME], { cwd: HERE })).code === 0) return true;
    await Bun.sleep(1000);
  }
  return false;
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

try {
  console.log(`[1] build at ${SCALE.toLocaleString()} rows with Q=5, kept as ${NAME} (removed on the way out)`);
  const r1 = await bench(5);
  assert(r1.code === 0, `the build runs (exit ${r1.code})`);
  assert(r1.out.includes("| loaded |"), "section L says loaded");
  assert(r1.out.includes("corpus kept: marker written, with the exact pass's answers for 5 queries"), "the marker is written with the exact pass's five answers per key");
  assert(new RegExp(`Remove: \\S+ volume rm ${NAME}$`, "m").test(r1.out), "the wrapper names the volume this suite will remove");
  if (r1.code !== 0) throw new Error(`the build failed:\n${r1.out}`);

  console.log("[2] reuse with Q=3: every answer from the marker");
  const r2 = await bench(3);
  assert(r2.code === 0, `the reuse runs (exit ${r2.code})`);
  assert(r2.out.includes("exact oracle      reused from the marker (the first 3 of the 5 it keeps) done"), "the run says the oracle was reused, the first three of five");
  assert(oracleCell(r2.out) === "oracle reused", `section L says oracle reused (${oracleCell(r2.out)})`);
  assert(!r2.out.includes("marker extended"), "a marker answering for every query is left as it is");
  assert(r2.out.includes("(all of them the marker's)"), "the confound is read from the marker's answers");

  console.log("[3] the marker's answers removed (as a marker from before SMD-1562 has none); Q=3 computes and extends");
  const s = await onKept("UPDATE bench_hnsw_corpus SET corpus = corpus - 'oracle'");
  assert(s.code === 0, `the marker's oracle is removed (exit ${s.code})`);
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
  const m = await onKept(`UPDATE bench_hnsw_corpus SET corpus = corpus || '{"rewritten":["test-bench-reuse.ts marked it"]}'::jsonb`);
  assert(m.code === 0, `the marker is marked rewritten (exit ${m.code})`);
  const r6 = await bench(3);
  assert(r6.code === 2, `the run is refused (exit ${r6.code})`);
  assert(r6.out.includes("had its tables changed by migrations applied onto it on an earlier run"), "with the rewritten refusal");
  assert(!r6.out.includes("exact oracle"), "and the cached answers were never read");
} catch (err) {
  // A throw is a failure with a tally, not a stack trace in place of one —
  // the stack kept, since the next run is three minutes of containers.
  if (!(err instanceof Interrupted)) assert(false, `the suite stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  const removed = await removeKept();
  if (interrupted !== null) {
    console.error(removed ? `  removed ${NAME}` : `  could not remove ${NAME}; \`${runtime} volume rm ${NAME}\` once its container is gone`);
    process.exit(interrupted);
  }
  assert(removed, `the kept volume ${NAME} is removed`);
}

report();
