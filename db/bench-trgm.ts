#!/usr/bin/env bun
/**
 * bench-trgm.ts — what a trigram index on `thoughts.content` actually costs and
 * buys, measured here rather than quoted from somebody else's brain.
 *
 * SMD-925 arrived with an upstream number attached: a rare-word `ILIKE` falling
 * from ~8s to ~100-150ms, a claimed ~50x, measured on an 89,000-row brain. That
 * is a real measurement of a real database — just not of ours. Two things differ
 * enough to make the number non-transferable:
 *
 *   Scale. The claim is a seq-scan cost, and a seq scan costs what the table
 *   weighs. Our corpus is 97 rows and 45 KB. Postgres reads that in less time
 *   than it takes to plan an index scan, and the planner knows it.
 *
 *   Pattern length. pg_trgm indexes three-character grams, so a pattern shorter
 *   than three characters produces no grams and the index cannot be used at all.
 *   "Rare-word ILIKE" is the best case, not the average one.
 *
 * So this measures across scales, and across pattern kinds, and reports the
 * write cost the issue's rationale leaves out — a GIN index is not paid for once
 * at build time, it is paid for again on every capture.
 *
 *   ./with-postgres.sh bun bench-trgm.ts
 *   OB1_BENCH_CORPUS=/path/to/your-corpus.json ./with-postgres.sh bun bench-trgm.ts
 *
 * ── On the corpus ────────────────────────────────────────────────────────────
 * With no OB1_BENCH_CORPUS the generator falls back to a built-in vocabulary, so
 * this runs anywhere. Pointed at a corpus it builds a bigram model from that
 * text and samples from it, which keeps the trigram distribution close to the
 * real one: duplicating rows verbatim would collapse the index's distinct-gram
 * count and flatter it enormously. The corpus is read, never written anywhere —
 * nothing derived from it is committed.
 */

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { requireDatabaseUrl, resetSchema } from "./test-support.ts";

const URL_ = requireDatabaseUrl("bench-trgm.ts");

/** Small enough that HNSW build time does not dominate; ILIKE plans ignore it. */
const OPTS = { dim: 8, model: "stub-embed" };

const SCALES = (process.env.OB1_BENCH_SCALES ?? "97,1000,10000,100000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/** How many rows the write-amplification arm inserts. Fixed across scales. */
const WRITE_BATCH = Number(process.env.OB1_BENCH_WRITE_BATCH ?? 2000);

/** Repeats per probe. The median is reported; the first run is discarded as warm-up. */
const REPEATS = Number(process.env.OB1_BENCH_REPEATS ?? 5);

/**
 * Markers planted at known frequencies, so selectivity is a controlled variable
 * rather than an accident of what the generator happened to emit.
 *
 * An earlier version probed for a real word ("%embedding%") and called it
 * "medium selectivity". It was not: whether that word appeared at all depended on
 * the corpus and the scale, and at 1,000 rows it matched nothing — which the
 * benchmark cheerfully reported as a 190x speedup.
 *
 * `zy` is the useful one. It matches exactly the rows RARE matches, so the
 * two-character probe and the rare-word probe differ in pattern length and in
 * nothing else — the sub-trigram limit is isolated from selectivity.
 */
const RARE = "zylotrope";   // exactly RARE_ROWS rows
const RARE_ROWS = 5;
const MID = "mesotrope";    // 10% of rows
const COMMON = "polytrope"; // 90% of rows

// ── Corpus → bigram model ────────────────────────────────────────────────────

type Corpus = { texts: string[]; source: string };

function loadCorpus(): Corpus {
  const path = process.env.OB1_BENCH_CORPUS;
  if (!path) {
    return { texts: FALLBACK_TEXTS, source: "built-in vocabulary (set OB1_BENCH_CORPUS to use your own)" };
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const arr = Array.isArray(raw) ? raw : [];
  const texts = arr
    .map((r) =>
      typeof r === "string"
        ? r
        : [(r as Record<string, unknown>).title, (r as Record<string, unknown>).text ?? (r as Record<string, unknown>).content]
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .join("\n\n")
    )
    .filter((s) => s.length > 0);
  if (texts.length === 0) throw new Error(`${path} yielded no usable text.`);
  return { texts, source: `${path} (${texts.length} documents)` };
}

/**
 * A bigram chain, plus the observed length distribution.
 *
 * Bigrams rather than a bag of words because trigram selectivity depends on
 * which three-character sequences actually co-occur, and word order is most of
 * that. Sampling lengths from the real distribution rather than a mean keeps the
 * long documents long — a seq scan's cost is bytes, not rows.
 */
function buildModel(texts: string[]) {
  const chain = new Map<string, string[]>();
  const lengths: number[] = [];
  for (const t of texts) {
    lengths.push(t.length);
    const toks = t.split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length - 1; i++) {
      const k = toks[i].toLowerCase();
      const next = chain.get(k);
      if (next) next.push(toks[i + 1]);
      else chain.set(k, [toks[i + 1]]);
    }
  }
  const starts = [...chain.keys()];
  if (starts.length === 0) throw new Error("corpus produced an empty model");
  return { chain, starts, lengths };
}

/** Deterministic PRNG, so two runs of this script are comparable to each other. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function generate(model: ReturnType<typeof buildModel>, n: number, seed = 42): string[] {
  const rand = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const target = pick(model.lengths);
    let word = pick(model.starts);
    const words: string[] = [word];
    let len = word.length;
    while (len < target) {
      const next = model.chain.get(word.toLowerCase());
      word = next && next.length ? pick(next) : pick(model.starts);
      words.push(word);
      len += word.length + 1;
    }
    out.push(words.join(" "));
  }
  // Plant each marker at its target frequency, spread evenly rather than in a
  // block, so matching rows are not clustered onto a handful of heap pages —
  // clustering would flatter the bitmap heap scan for reasons unrelated to the
  // index.
  const plant = (token: string, count: number) => {
    const n = Math.min(count, out.length);
    for (let i = 0; i < n; i++) {
      const at = Math.floor((i + 0.5) * (out.length / n));
      out[at] = `${out[at]} ${token}`;
    }
  };
  plant(RARE, RARE_ROWS);
  plant(MID, Math.max(1, Math.round(out.length * 0.1)));
  plant(COMMON, Math.max(1, Math.round(out.length * 0.9)));
  return out;
}

/** Used when no corpus is supplied. Deliberately mundane engineering prose. */
const FALLBACK_TEXTS = [
  "The migration runner records each applied file in schema_migrations so a second run is a no-op. Re-applying by hand is safe because every migration is individually idempotent.",
  "Capture writes the thought and its embedding in one statement. A two-step write could leave a row without a vector, which search would then silently never return.",
  "The audit trigger records the actor for every mutation. Attribution survives a key rotation because the name is stored on the audit row rather than resolved at read time.",
  "Chunking splits a long document on paragraph boundaries and embeds each piece. Retrieval scores the chunk and returns the parent, so a long note is findable by any part of it.",
  "Preflight checks configuration before the server accepts a request, and separates a warning from a failure: a missing optional table degrades attribution, it does not stop the process.",
  "The threshold comparison is strict. A row whose similarity exactly equals the cutoff is excluded, which matters when a caller passes zero and expects everything back.",
  "Connection pooling is bounded because nothing upstream limits concurrency any more. An unbounded pool lets a burst of captures exhaust the server's connection slots.",
  "Metadata containment uses the jsonb operator rather than a text comparison, so a filter on topics matches an array element instead of the serialised array.",
];

// ── Measurement ──────────────────────────────────────────────────────────────

type Probe = { label: string; pattern: string; note: string };

const PROBES: Probe[] = [
  { label: `rare word (${RARE_ROWS} rows)`, pattern: `%${RARE}%`, note: "upstream's best case" },
  { label: "selective word (10%)", pattern: `%${MID}%`, note: "a minority of rows" },
  { label: "common word (90%)", pattern: `%${COMMON}%`, note: "matches most rows; an index cannot beat a scan" },
  { label: `two-char (${RARE_ROWS} rows)`, pattern: "%zy%", note: "same rows as the rare probe, but shorter than a trigram" },
];

type Timing = { ms: number; plan: string; rows: number };

async function timeProbe(sql: SQL, pattern: string): Promise<Timing> {
  const runs: number[] = [];
  let plan = "?";
  let rows = 0;
  for (let i = 0; i <= REPEATS; i++) {
    // TIMING must stay ON: with it off Postgres still reports the plan and the
    // row counts but every "Actual Total Time" is zero, which reads as an
    // infinitely fast query rather than as a missing measurement.
    const res = await sql`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT id FROM thoughts WHERE content ILIKE ${pattern}`;
    const json = (res[0] as Record<string, unknown>)["QUERY PLAN"] as Array<Record<string, unknown>>;
    if (i === 0) continue; // warm-up: first touch pulls pages into shared buffers
    runs.push(Number(json[0]["Execution Time"] ?? 0));
    const node = json[0].Plan as Record<string, unknown>;
    plan = describePlan(node);
    rows = Number(node["Actual Rows"] ?? 0);
  }
  runs.sort((a, b) => a - b);
  return { ms: runs[Math.floor(runs.length / 2)], plan, rows };
}

/** The node type that did the work, which is the answer to "did it use the index". */
function describePlan(node: Record<string, unknown>): string {
  const t = String(node["Node Type"] ?? "?");
  if (t === "Bitmap Heap Scan" || t === "Index Scan" || t === "Seq Scan") return t;
  const kids = (node.Plans ?? []) as Array<Record<string, unknown>>;
  for (const k of kids) {
    const d = describePlan(k);
    if (d !== "?") return d;
  }
  return t;
}

async function insertRows(sql: SQL, texts: string[], batch = 500): Promise<void> {
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    await sql`INSERT INTO thoughts ${sql(slice.map((content) => ({ content, metadata: {} })))}`;
  }
}

async function tableBytes(sql: SQL, rel: string): Promise<number> {
  const [r] = await sql`SELECT pg_total_relation_size(${rel}::regclass)::bigint AS b`;
  return Number(r.b);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 ** 2).toFixed(1)} MB`;
}

function fmtMs(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(0)} ms`;
}

/**
 * Before/after as a ratio, with a dead band.
 *
 * Anything inside ±5% is reported as no change rather than as a number: at these
 * durations that band is measurement noise, and "1.03x faster" invites a reader
 * to believe a difference that a second run would reverse.
 */
function change(before: number, after: number): string {
  if (!Number.isFinite(before) || !Number.isFinite(after) || after <= 0 || before <= 0) return "n/a";
  const r = before / after;
  if (r >= 1.05) return `${r.toFixed(1)}x faster`;
  if (r <= 0.95) return `${(1 / r).toFixed(1)}x slower`;
  return "no change";
}

// ── Run ──────────────────────────────────────────────────────────────────────

const corpus = loadCorpus();
const model = buildModel(corpus.texts);

console.log(`corpus:  ${corpus.source}`);
console.log(`scales:  ${SCALES.join(", ")} rows`);
console.log(`repeats: ${REPEATS} per probe, median reported\n`);

type Row = {
  scale: number;
  bytes: number;
  probe: string;
  before: Timing;
  after: Timing;
  note: string;
};

const results: Row[] = [];
const overhead: { scale: number; withoutMs: number; withMs: number; indexBytes: number; buildMs: number }[] = [];

for (const scale of SCALES) {
  console.log(`── ${scale.toLocaleString()} rows ${"─".repeat(Math.max(0, 50 - String(scale).length))}`);
  await resetSchema(URL_, OPTS);
  const sql = new SQL({ url: URL_, max: 1 });

  // The whole point of this script is the before/after, and since SMD-925 landed
  // the "before" state no longer exists after a reset: migration 011 builds the
  // index. Dropping it here restores a pre-011 database. Without this line the
  // first arm measures a table that already has the index and the script quietly
  // reports no improvement at any scale.
  await sql`DROP INDEX IF EXISTS idx_thoughts_content_trgm`;
  const [pre] = await sql`SELECT count(*)::int AS c FROM pg_indexes
                           WHERE indexname = 'idx_thoughts_content_trgm'`;
  if (pre.c !== 0) throw new Error("the trigram index survived the drop — the baseline arm would be invalid");

  await insertRows(sql, generate(model, scale));
  // VACUUM here as well as after the write arms, so both read arms measure a
  // table in the same state. See the note at the second VACUUM for why the
  // asymmetry mattered — and for GIN specifically, VACUUM also flushes the
  // pending list, which a query would otherwise scan in full on top of the index.
  await sql`VACUUM (ANALYZE) thoughts`;
  const bytes = await tableBytes(sql, "thoughts");
  console.log(`   table: ${fmtBytes(bytes)}`);

  const before = new Map<string, Timing>();
  for (const p of PROBES) before.set(p.label, await timeProbe(sql, p.pattern));

  // The write arm runs before the index exists and again after, on the same
  // table at the same size, so the delta is the index's contribution and not a
  // difference in how full the table was. Three repeats each way, median taken:
  // a single batch of a few thousand inserts is noisy enough that one sample
  // can move the reported overhead by tens of percent.
  const writeSample = generate(model, WRITE_BATCH, 7);
  const writeArm = async (): Promise<number> => {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await insertRows(sql, writeSample);
      runs.push(performance.now() - t);
      await sql`DELETE FROM thoughts WHERE id IN (
                  SELECT id FROM thoughts ORDER BY created_at DESC LIMIT ${WRITE_BATCH})`;
    }
    runs.sort((a, b) => a - b);
    return runs[1];
  };
  const withoutMs = await writeArm();

  let t0 = performance.now();
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  await sql`CREATE INDEX idx_thoughts_content_trgm ON thoughts USING gin (content gin_trgm_ops)`;
  const buildMs = performance.now() - t0;
  await sql`ANALYZE thoughts`;
  const indexBytes = Number((await sql`SELECT pg_relation_size('idx_thoughts_content_trgm')::bigint AS b`)[0].b);
  console.log(`   index: ${fmtBytes(indexBytes)}, built in ${fmtMs(buildMs)}`);

  const withMs = await writeArm();

  overhead.push({ scale, withoutMs, withMs, indexBytes, buildMs });

  /**
   * VACUUM, not just ANALYZE, and this matters more than it looks.
   *
   * The two write arms insert and delete 3 x WRITE_BATCH rows between the
   * "before" reads and the "after" ones. Deleted tuples stay on the heap until
   * vacuumed, and a seq scan still has to walk them — so without this the
   * "after" arm scans a table carrying thousands of dead rows that the "before"
   * arm never saw. At 100,000 live rows that bias is a rounding error. At 97 it
   * is larger than the table, and it showed up as a consistent "1.4x slower"
   * that was entirely an artifact of the measurement.
   */
  await sql`VACUUM (ANALYZE) thoughts`;
  for (const p of PROBES) {
    const after = await timeProbe(sql, p.pattern);
    results.push({ scale, bytes, probe: p.label, before: before.get(p.label)!, after, note: p.note });
    const b = before.get(p.label)!;
    console.log(
      `   ${p.label.padEnd(24)} ${String(after.rows).padStart(6)} rows  ${fmtMs(b.ms).padStart(9)} (${b.plan}) → ` +
        `${fmtMs(after.ms).padStart(9)} (${after.plan})  ${change(b.ms, after.ms)}`
    );
  }
  await sql.close();
  console.log();
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log("\n### Read latency (median of " + REPEATS + ", EXPLAIN ANALYZE)\n");
console.log("| rows | table | probe | matched | before | plan | after | plan | change |");
console.log("| ---: | ---: | --- | ---: | ---: | --- | ---: | --- | ---: |");
for (const r of results) {
  // The matched count is reported because without it a probe that accidentally
  // matches nothing looks like the best result in the table.
  const matched = r.before.rows === r.after.rows ? String(r.after.rows) : `${r.before.rows}/${r.after.rows}!`;
  console.log(
    `| ${r.scale.toLocaleString()} | ${fmtBytes(r.bytes)} | ${r.probe} | ${matched} | ${fmtMs(r.before.ms)} | ${r.before.plan} | ` +
      `${fmtMs(r.after.ms)} | ${r.after.plan} | ${change(r.before.ms, r.after.ms)} |`
  );
}

console.log("\n### Write cost of the index\n");
console.log(`Median of 3 batches of ${WRITE_BATCH} inserts, each way. Per-row is the transferable`);
console.log(`number: these rows carry no embedding, so a real capture pays this on top of an`);
console.log(`HNSW insert rather than instead of one.\n`);
console.log("| rows | index size | build | without | with | overhead | per row |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const o of overhead) {
  const pct = ((o.withMs / o.withoutMs - 1) * 100).toFixed(0);
  const perRowUs = ((o.withMs - o.withoutMs) * 1000) / WRITE_BATCH;
  console.log(
    `| ${o.scale.toLocaleString()} | ${fmtBytes(o.indexBytes)} | ${fmtMs(o.buildMs)} | ` +
      `${fmtMs(o.withoutMs)} | ${fmtMs(o.withMs)} | +${pct}% | +${perRowUs.toFixed(0)} µs |`
  );
}
console.log();
