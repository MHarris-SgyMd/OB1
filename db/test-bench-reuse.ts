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
 * runs the bench eight times against ONE database at 150,000 rows (the
 * smallest scale that is kept: the before arm's ceiling is 100,000) and
 * compares the tables that depend on the oracle between a run that read the
 * marker and a run that computed, on the SAME index (two builds would give
 * two HNSW graphs and two recall figures, which would say nothing about the
 * cache):
 *
 *   1.  Q=5, builds — the marker holds five answers per key.
 *   2.  Q=3, reuses — all three from the marker.
 *   3.  the marker's answers are removed (a marker written before SMD-1562
 *       has none), and Q=3 again computes them and extends the marker:
 *       sections A, B, D and E equal run 2's, timings aside.
 *   3b. one whole-table answer is given a duplicated id; Q=3 computes
 *       (the entry is not trusted) and writes a whole one back.
 *   3c. the entry's second query digest is changed; Q=3 takes one answer
 *       from the marker and computes two.
 *   4.  Q=6 — three from the marker, three computed, the marker extended.
 *   5.  Q=6 again — all six from the marker; the tables equal run 4's.
 *   6.  the marker is marked `rewritten`, as a refused reuse leaves it, and a
 *       run is refused before the oracle is consulted.
 *   7.  038's ledger row is removed, as on a corpus kept before it: the run is
 *       refused from the dry run, before the migrator rebuilds the indexes
 *       the fingerprint covers (change 80).
 *
 * What "kept" means to the bench is the OB1_PG_KEEP variable and a marker
 * row; the container and its volume are with-postgres.sh's concern, held by
 * SMD-1493. So the suite runs under the wrapper like any other, and only
 * the bench it spawns is told the database is kept: the throwaway container
 * IS the kept database for the runs and nothing outlives the suite (the
 * first drafts drove the wrapper themselves, six kept volumes and their
 * cleanup; three review passes found seams in that lifecycle, which was the
 * finding). A database that already holds a marker is refused up front —
 * that marker is a kept corpus's, not this suite's to drop — so the marker
 * found at the end is the suite's own and is dropped, on a normal exit and
 * after a signal (Bun runs no `finally` on one: the signal is noted, no
 * further run starts, and the run in flight ends as the signal reached it —
 * killed with the process group under a terminal's Ctrl-C, or left to finish
 * if the signal came to this process alone), and a shared database
 * (ci-parity.sh's) is left as the other suites expect it. About three
 * minutes.
 *
 *   ./with-postgres.sh bun test-bench-reuse.ts
 */
import { SQL } from "bun";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_MARKER, REMOTE_DB_FLAGS, assertThrowawayDatabase, createAssert, hasKeptCorpus, requireDatabaseUrl, runScript, shellWithoutOb1 } from "./test-support.ts";

const { assert, report } = createAssert();
const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = requireDatabaseUrl("test-bench-reuse.ts");
assertThrowawayDatabase(URL_);
const SCALE = 150_000;
/**
 * What passes through from the shell to the spawned bench: the build's own
 * knobs (only run 1 builds, and neither can tell a reused answer from a
 * computed one) and the remote-database flags, so a database this suite
 * accepted is not refused by the bench it spawns. Every other OB1_* name is
 * stripped (a width or a query count from the shell would change what is
 * measured), and runScript keeps db/.env out of the spawned bun too.
 */
const PASS_THROUGH = ["OB1_BENCH_BUILD_WORKERS", "OB1_BENCH_MAINTENANCE_MEM", ...REMOTE_DB_FLAGS];

/** The exit code a signal asked for, once one has arrived: no further run starts (a run in flight ends as the signal reached it — with the process group under a terminal's Ctrl-C, or on its own if the signal came to this process alone), and `finally` drops the marker. */
let interrupted: number | null = null;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.on(signal, () => {
    if (interrupted !== null) return;
    interrupted = code;
    console.error(`\n  ${signal}: no further run starts; dropping the marker and leaving once the run in flight has ended`);
  });
}
class Interrupted extends Error {}
/** A failure already in the tally, thrown to stop the runs after it; the catch prints its output and counts nothing more. */
class Stopped extends Error {}

/**
 * One bench run against this database, told it is kept, Q queries, expected
 * to exit as given: any other exit is one tallied failure that stops the
 * suite with the run's output, rather than letting later runs cascade
 * `null`s from it.
 */
async function bench(q: number, expect = 0): Promise<{ code: number; out: string }> {
  if (interrupted !== null) throw new Interrupted();
  const env = shellWithoutOb1();
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  const r = await runScript(["bun", "bench-hnsw.ts"], { cwd: HERE, env: { ...env, DATABASE_URL: URL_, OB1_PG_KEEP: "test-reuse", OB1_BENCH_SCALES: String(SCALE), OB1_BENCH_QUERIES: String(q) } });
  if (interrupted !== null) throw new Interrupted();
  assert(r.code === expect, `the run exits ${expect} (exit ${r.code})`);
  if (r.code !== expect) throw new Stopped(`the bench exited ${r.code}, not ${expect}:\n${r.out}`);
  return r;
}

/** A markdown table row's cells, trimmed. */
const cells = (row: string) => row.slice(1, -1).split(" | ").map((c) => c.trim());
/** Whether a table row is the header's separator (`| ---: | --- |`). */
const separator = (row: string) => /^:?-+:?$/.test(cells(row)[0]);

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
    const row = cells(line);
    if (!mask) {
      mask = row.map((header) => !/\bms\b/.test(header));
      continue;
    }
    if (separator(line)) continue;
    const keep = mask;
    kept.push(`${section}: ${row.filter((_, i) => keep[i]).join(" | ")}`);
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

/** A cell of section L's one row, by its header — the stable reading of where the answers came from. */
function loadCell(out: string, header: string): string | null {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("### L."));
  if (at < 0) return null;
  const table = lines.slice(at + 1).filter((l) => l.startsWith("| "));
  const sep = table.findIndex(separator);
  const row = sep > 0 ? table[sep + 1] : undefined;
  const i = sep > 0 ? cells(table[sep - 1]).indexOf(header) : -1;
  return row === undefined || i < 0 ? null : (cells(row)[i] ?? null);
}
/** The confound line — the one number the oracle alone decides. */
const confound = (out: string) => /nearest query-to-row cosine (\d\.\d{3}) over this run's/.exec(out)?.[1] ?? null;

const sql = new SQL(URL_);
if (await hasKeptCorpus(sql)) {
  console.error(`test-bench-reuse.ts: this database already holds a ${BENCH_MARKER} marker — a kept corpus's, which this suite would neither replace nor drop. Run the suite against a throwaway database (./with-postgres.sh without OB1_PG_KEEP).`);
  await sql.close();
  process.exit(2);
}
/** The one entry in the marker's oracle map (this tree's, on this server), by key. */
const entryKey = async (): Promise<string> => {
  const [{ key }] = await sql.unsafe(`SELECT jsonb_object_keys(corpus->'oracle') AS key FROM ${BENCH_MARKER}`);
  return key;
};

try {
  console.log(`[1] build at ${SCALE.toLocaleString()} rows with Q=5, kept in this database`);
  const r1 = await bench(5);
  assert(loadCell(r1.out, "source") === "loaded" && loadCell(r1.out, "oracle") === "computed", `section L says loaded, oracle computed (${loadCell(r1.out, "source")}, ${loadCell(r1.out, "oracle")})`);
  assert(r1.out.includes("corpus kept: marker written, with the exact pass's answers for 5 queries"), "the marker is written with the exact pass's five answers per key");

  console.log("[2] reuse with Q=3: every answer from the marker");
  const r2 = await bench(3);
  assert(loadCell(r2.out, "oracle") === "reused", `section L says oracle reused (${loadCell(r2.out, "oracle")})`);
  assert(!r2.out.includes("marker extended"), "a marker answering for every query is left as it is");

  console.log("[3] the marker's answers removed (as a marker from before SMD-1562 has none); Q=3 computes and extends");
  await sql.unsafe(`UPDATE ${BENCH_MARKER} SET corpus = corpus - 'oracle'`);
  const r3 = await bench(3);
  assert(loadCell(r3.out, "oracle") === "computed", `section L says oracle computed (${loadCell(r3.out, "oracle")})`);
  assert(r3.out.includes("marker extended: the exact pass's answers for 3 queries (had none)"), "the marker is extended with the three computed answers");
  sameScored({ out: r2.out, label: "from the marker" }, { out: r3.out, label: "computed" }, "sections A, B, D and E from the marker's answers equal the ones from computed answers, on the same index");
  assert(confound(r2.out) !== null && confound(r2.out) === confound(r3.out), `the confound agrees (${confound(r2.out)} / ${confound(r3.out)})`);

  console.log("[3b] one whole-table answer given a duplicated id: the entry is not trusted, Q=3 computes");
  // The paths are built server-side from a slash-joined string: a JS array
  // bound to a text parameter arrives comma-joined, not as an array literal.
  const key = await entryKey();
  const ids = ["oracle", key, "answers", "whole table", "0", "ids"].join("/");
  // The last id becomes a copy of the first: the same length at any K, so
  // only the distinctness guard can be what rejects it.
  await sql.unsafe(
    `UPDATE ${BENCH_MARKER} SET corpus = jsonb_set(corpus, string_to_array($1, '/'), (corpus #> string_to_array($1, '/')) - -1 || jsonb_build_array(corpus #> string_to_array($2, '/')))`,
    [ids, `${ids}/0`]
  );
  const r3b = await bench(3);
  assert(loadCell(r3b.out, "oracle") === "computed", `section L says oracle computed (${loadCell(r3b.out, "oracle")})`);
  assert(r3b.out.includes("marker extended: the exact pass's answers for 3 queries (had 3, 0 of them this run's)"), "a malformed entry is found, answers for nothing, and a whole one is written back");
  sameScored({ out: r3.out, label: "computed" }, { out: r3b.out, label: "computed again" }, "and the tables are the same");

  console.log("[3c] the entry's second query digest changed: one answer from the marker, two computed");
  await sql.unsafe(`UPDATE ${BENCH_MARKER} SET corpus = jsonb_set(corpus, string_to_array($1, '/'), '"not-this-run"'::jsonb)`, [["oracle", key, "queries", "1"].join("/")]);
  const r3c = await bench(3);
  assert(loadCell(r3c.out, "oracle") === "1 of 3 reused, the rest computed", `section L says one of three reused (${loadCell(r3c.out, "oracle")})`);
  assert(r3c.out.includes("marker extended: the exact pass's answers for 3 queries (had 3, 1 of them this run's)"), "the entry is written back whole");
  sameScored({ out: r3.out, label: "computed" }, { out: r3c.out, label: "one reused" }, "and the tables are the same");

  console.log("[4] Q=6: three from the marker, three computed, the marker extended");
  const r4 = await bench(6);
  assert(loadCell(r4.out, "oracle") === "3 of 6 reused, the rest computed", `section L says three of six reused (${loadCell(r4.out, "oracle")})`);
  assert(r4.out.includes("marker extended: the exact pass's answers for 6 queries (had 3, 3 of them this run's)"), "the marker now holds six");

  console.log("[5] Q=6 again: all six from the marker, the tables as run 4's");
  const r5 = await bench(6);
  assert(loadCell(r5.out, "oracle") === "reused", `section L says oracle reused (${loadCell(r5.out, "oracle")})`);
  sameScored({ out: r4.out, label: "extended" }, { out: r5.out, label: "from the marker" }, "sections A, B, D and E from the extended marker equal the run that extended it");

  console.log("[6] a corpus marked rewritten is refused before the oracle is consulted");
  await sql.unsafe(`UPDATE ${BENCH_MARKER} SET corpus = corpus || '{"rewritten":["test-bench-reuse.ts marked it"]}'::jsonb`);
  const r6 = await bench(3, 2);
  assert(r6.out.includes("had its tables changed by migrations applied onto it on an earlier run"), "with the rewritten refusal");
  assert(!r6.out.includes("exact oracle"), "and the cached answers were never read");

  console.log("[7] a kept corpus on which migration 038 is pending is refused before the migrator runs it (its swap would rebuild the fingerprinted indexes)");
  await sql.unsafe(`UPDATE ${BENCH_MARKER} SET corpus = corpus - 'rewritten'`);
  await sql.unsafe(`DELETE FROM schema_migrations WHERE name LIKE '038_%'`);
  const r7 = await bench(3, 1);
  assert(r7.out.includes("migration 038 is pending on this kept corpus"), "with the pending-038 refusal, named");
  assert(/038_\S+\s+would apply/.test(r7.out) && !/038_\S+\s+applied/.test(r7.out), "the dry run said it would apply, and the live run never ran it");
  assert(!r7.out.includes("exact oracle"), "and nothing after the schema check ran");
} catch (err) {
  // A throw is a failure with a tally, not a stack trace in place of one —
  // the stack kept, since the next run is three minutes of exact passes.
  if (err instanceof Stopped) console.log(`  ${err.message}`);
  else if (!(err instanceof Interrupted)) assert(false, `the suite stopped: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  // Proven absent when the suite started, so the marker here is the suite's own.
  await sql.unsafe(`DROP TABLE IF EXISTS ${BENCH_MARKER}`);
  await sql.close();
  if (interrupted !== null) process.exit(interrupted);
}

report();
