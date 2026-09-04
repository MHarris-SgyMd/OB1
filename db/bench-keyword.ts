#!/usr/bin/env bun
/**
 * bench-keyword.ts — does `search_thoughts_keyword` actually reach the trigram
 * index, and what do its extras cost?
 *
 *   ./with-postgres.sh bun bench-keyword.ts
 *
 * `bench-trgm.ts` already measured a bare `content ILIKE '%needle%'` across
 * scales. This measures the three things migration 012 added on top of that
 * pattern, none of which the earlier benchmark can speak to:
 *
 *   1. WILDCARD ESCAPING. The function escapes `_` and `%` before wrapping the
 *      needle, because unescaped they are ILIKE wildcards and `upsert_thought`
 *      would also match `upsert-thought`. But `_` is the most common character
 *      in the identifiers this feature exists to find, and nothing had checked
 *      whether pg_trgm can still extract grams from a pattern containing `\_`.
 *      If it cannot, every identifier search sequentially scans and the index
 *      that this migration flipped ON by default buys nothing for its main case.
 *
 *   2. THE WINDOW. `total_count` is `count(*) OVER ()`. The migration header
 *      claims it is nearly free because the ORDER BY already forces the whole
 *      match set to be materialised. That is an argument, not a measurement.
 *
 *   3. THE OCCURRENCE COUNT. Two `length(replace(lower(...)))` calls per matched
 *      row, which is real work on long text.
 *
 * ── How the access path is established ───────────────────────────────────────
 * Not by EXPLAIN. `EXPLAIN ANALYZE SELECT * FROM search_thoughts_keyword(...)`
 * on a plpgsql function reports a Function Scan and nothing about what happens
 * inside it, so a plan read that way would say nothing at all — and would look
 * like it said something.
 *
 * Instead: `pg_stat_user_indexes.idx_scan` for the trigram index is read before
 * and after the call. A non-zero delta is direct evidence that the index served
 * the query THE FUNCTION ran, not a reconstruction of it. The equivalent inlined
 * query is also EXPLAINed, for the plan shape, and labelled as the reconstruction
 * it is.
 *
 * ── The control ──────────────────────────────────────────────────────────────
 * A decoy is planted that only an UNESCAPED pattern can match: for the needle
 * `resolve_agent_zylotrope`, rows containing `resolve-agent-zylotrope`. If the
 * escaping ever regresses, the row counts move from 5 to 10 and this script
 * refuses to print a result rather than reporting a faster wrong query. The
 * earlier benchmark in this directory reported a 190x speedup for a query
 * matching nothing; the check exists because that is what happens without one.
 */

import { SQL } from "bun";
import { requireDatabaseUrl, resetSchema } from "./test-support.ts";

const URL_ = requireDatabaseUrl("bench-keyword.ts");

/** Small vectors: HNSW build time would otherwise dominate the load step. */
const OPTS = { dim: 8, model: "stub-embed", trgm: true };

const SCALES = (process.env.OB1_BENCH_SCALES ?? "1000,10000,100000")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const REPEATS = Number(process.env.OB1_BENCH_REPEATS ?? 5);

/** Calls made to see whether plpgsql switches to a generic plan. Must exceed 5. */
const PLAN_CALLS = 12;

/**
 * The needle, and the decoy that makes the escaping falsifiable.
 *
 * IDENT contains two underscores, so an unescaped pattern reads them as
 * single-character wildcards and DECOY — same shape, hyphens instead — matches
 * too. Both are planted at the same frequency, so a regression doubles the row
 * count rather than changing it by an amount that could be a rounding artefact.
 */
const IDENT = "resolve_agent_zylotrope";
const DECOY = "resolve-agent-zylotrope";
const MARKED_ROWS = 5;

/** A term in ~10% of rows, where the index helps much less. From bench-trgm. */
const MID = "mesotrope";

/**
 * A term in EVERY row — the actual worst case, and the reason this exists.
 *
 * The first version of this benchmark called the 10% figure "the honest ceiling
 * on the feature". It is not: a needle matching everything costs about nine
 * times more, because the occurrence count and the window are then paid on the
 * whole table. Any authenticated caller can issue that query, so it is the
 * number an operator actually needs.
 */
const ALL = "omnitrope";

/** Escape exactly as migration 012 does, so the two cannot drift apart. */
function escapeNeedle(needle: string): string {
  return needle.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ── Corpus ───────────────────────────────────────────────────────────────────

const WORDS = (
  "the a of to and in that for on with as by from at an is was are were be been " +
  "migration schema index query planner vector embedding thought capture retrieval " +
  "postgres cluster deploy runtime provider chunk audit agent identity keyword"
).split(" ");

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Filler of roughly the length of a real captured thought, with the markers
 * planted at controlled frequencies rather than left to chance.
 */
function generate(n: number, seed = 42): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const words: string[] = [];
    for (let w = 0; w < 70; w++) words.push(WORDS[Math.floor(r() * WORDS.length)]);
    words.push(ALL);
    if (i < MARKED_ROWS) words.splice(10, 0, IDENT);
    else if (i < MARKED_ROWS * 2) words.splice(10, 0, DECOY);
    else if (i % 10 === 0) words.splice(10, 0, MID);
    out.push(words.join(" "));
  }
  return out;
}

// ── Measurement ──────────────────────────────────────────────────────────────

type Timing = { ms: number; rows: number };

/**
 * Median wall-clock over REPEATS, first run discarded as warm-up.
 *
 * Wall clock rather than EXPLAIN's "Execution Time" because the thing being
 * timed here is a function call, and EXPLAIN would time the Function Scan
 * wrapper. The two differ by client round-trip, which is constant across the
 * arms and therefore does not affect the comparison.
 */
async function time(fn: () => Promise<unknown[]>): Promise<Timing> {
  const runs: number[] = [];
  let rows = 0;
  for (let i = 0; i <= REPEATS; i++) {
    const t0 = performance.now();
    const r = await fn();
    const dt = performance.now() - t0;
    if (i === 0) continue;
    runs.push(dt);
    rows = r.length;
  }
  runs.sort((a, b) => a - b);
  return { ms: runs[Math.floor(runs.length / 2)], rows };
}

/**
 * idx_scan for the trigram index.
 *
 * Two calls, and both are load-bearing. A backend accumulates statistics locally
 * and flushes them to the shared collector at most once a second, so reading
 * immediately after a query returns the value from BEFORE it — the first version
 * of this function reported "index not used" at every scale while the timings
 * said 0.59 ms for a query a sequential scan does in 267 ms. The measurement was
 * wrong, not the function. `pg_stat_force_next_flush()` (PG15+) pushes the
 * pending counters out; `pg_stat_clear_snapshot()` then discards this
 * transaction's cached view of them, which is separately necessary because
 * within one transaction the stats snapshot is stable by design.
 */
async function indexScans(sql: SQL): Promise<number> {
  await sql`SELECT pg_stat_force_next_flush()`;
  await sql`SELECT pg_stat_clear_snapshot()`;
  const r = await sql`
    SELECT coalesce(sum(idx_scan), 0)::bigint AS n
    FROM pg_stat_user_indexes WHERE indexrelname = 'idx_thoughts_content_trgm'`;
  return Number(r[0].n);
}

function describePlan(node: Record<string, unknown>): string {
  const t = String(node["Node Type"] ?? "?");
  if (t === "Bitmap Heap Scan" || t === "Index Scan" || t === "Seq Scan") return t;
  for (const k of ((node.Plans ?? []) as Array<Record<string, unknown>>)) {
    const d = describePlan(k);
    if (d !== "?") return d;
  }
  return t;
}

async function planOf(sql: SQL, pattern: string): Promise<string> {
  const res = await sql`EXPLAIN (FORMAT JSON)
    SELECT id FROM thoughts WHERE content ILIKE ${pattern}`;
  const json = (res[0] as Record<string, unknown>)["QUERY PLAN"] as Array<Record<string, unknown>>;
  return describePlan(json[0].Plan as Record<string, unknown>);
}

function fmt(ms: number): string {
  return ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(0)} ms`;
}

// ── Run ──────────────────────────────────────────────────────────────────────

type Row = {
  scale: number;
  fnMs: number;
  ilikeMs: number;
  noWindowMs: number;
  noOccMs: number;
  midMs: number;
  allMs: number;
  allTotal: number;
  usedIndex: boolean;
  usedInLoop: number;
  escapedPlan: string;
  midPlan: string;
};

const results: Row[] = [];

console.log(`\n  search_thoughts_keyword, needle "${IDENT}"`);
console.log(`  decoy "${DECOY}" planted at the same frequency\n`);

for (const scale of SCALES) {
  process.stdout.write(`  … ${scale.toLocaleString()} rows`);
  await resetSchema(URL_, OPTS);
  const sql = new SQL({ url: URL_, max: 1 });

  const texts = generate(scale);
  for (let i = 0; i < texts.length; i += 500) {
    const batch = texts.slice(i, i + 500);
    await sql`INSERT INTO thoughts ${sql(batch.map((t) => ({ content: t })))}`;
  }
  await sql.unsafe("VACUUM ANALYZE thoughts");

  const escaped = `%${escapeNeedle(IDENT)}%`;
  const unescaped = `%${IDENT}%`;

  // ── The control, before anything is timed ─────────────────────────────────
  const escapedRows = (await sql`SELECT id FROM thoughts WHERE content ILIKE ${escaped}`).length;
  const unescapedRows = (await sql`SELECT id FROM thoughts WHERE content ILIKE ${unescaped}`).length;
  if (escapedRows !== MARKED_ROWS) {
    throw new Error(
      `the escaped pattern matched ${escapedRows} rows at scale ${scale}, expected ${MARKED_ROWS}. ` +
        `The needle or the escaping changed; refusing to publish a timing for the wrong query.`
    );
  }
  if (unescapedRows !== MARKED_ROWS * 2) {
    throw new Error(
      `the UNESCAPED pattern matched ${unescapedRows} rows, expected ${MARKED_ROWS * 2}. ` +
        `The decoy is not doing its job, so this run cannot tell escaped from unescaped — ` +
        `every "escaping works" conclusion below would be unfalsifiable.`
    );
  }

  // ── Did the function use the index? ───────────────────────────────────────
  const before = await indexScans(sql);
  await sql`SELECT id FROM search_thoughts_keyword(${IDENT}, 25, 0, '{}'::jsonb)`;
  const usedIndex = (await indexScans(sql)) > before;

  // ── Timings ───────────────────────────────────────────────────────────────
  const fn = await time(() =>
    sql`SELECT id, content, occurrences, total_count
        FROM search_thoughts_keyword(${IDENT}, 25, 0, '{}'::jsonb)`
  );
  if (fn.rows !== MARKED_ROWS) {
    throw new Error(`the function returned ${fn.rows} rows, expected ${MARKED_ROWS}`);
  }

  // The floor: the raw indexed pattern, nothing else.
  const ilike = await time(() =>
    sql`SELECT id FROM thoughts WHERE content ILIKE ${escaped} LIMIT 25`
  );

  // The function's body without the window, to isolate what total_count costs.
  const noWindow = await time(() =>
    sql.unsafe(
      `SELECT t.id,
              ((length(lower(t.content)) - length(replace(lower(t.content), $2, '')))
                / length($2))::int AS occ
       FROM thoughts t WHERE t.content ILIKE $1
       ORDER BY occ DESC, t.created_at DESC, t.id
       LIMIT 25`,
      [escaped, IDENT.toLowerCase()] as never[]
    )
  );

  // And without the occurrence count, to isolate that.
  const noOcc = await time(() =>
    sql.unsafe(
      `SELECT t.id, count(*) OVER () AS total
       FROM thoughts t WHERE t.content ILIKE $1
       ORDER BY t.created_at DESC, t.id
       LIMIT 25`,
      [escaped] as never[]
    )
  );

  // ── Does the plan survive repeated calls in one session? ─────────────────
  //
  // plpgsql caches the plan for a statement inside a function and may switch to
  // a GENERIC plan after five executions. A generic plan is built without
  // knowing the pattern, so if one ever chose a sequential scan the function
  // would be fast five times and then far slower for the rest of the session —
  // a regression no single-shot timing can see.
  //
  // Reported as a COUNT, not as a verdict. The first version compared the twelve
  // calls against the single probe above and printed "NO — PLAN CHANGED" at
  // 1,000 rows, which was true and meaningless: below the crossover the two
  // plans cost the same and the planner reasonably picks either. A boolean
  // derived from one earlier sample turns that into an alarm. The number says
  // what happened and lets the reader judge it.
  let usedInLoop = 0;
  for (let i = 0; i < PLAN_CALLS; i++) {
    const b4 = await indexScans(sql);
    await sql`SELECT id FROM search_thoughts_keyword(${IDENT}, 25, 0, '{}'::jsonb)`;
    if ((await indexScans(sql)) > b4) usedInLoop++;
  }

  // ~10% of rows: where the index helps least and the per-row work most.
  const mid = await time(() =>
    sql`SELECT id, occurrences, total_count FROM search_thoughts_keyword(${MID}, 25, 0, '{}'::jsonb)`
  );

  // Every row. The real ceiling.
  const all = await time(() =>
    sql`SELECT id, occurrences, total_count FROM search_thoughts_keyword(${ALL}, 25, 0, '{}'::jsonb)`
  );
  const allTotal = Number(
    (await sql`SELECT total_count FROM search_thoughts_keyword(${ALL}, 1, 0, '{}'::jsonb)`)[0].total_count
  );
  if (allTotal !== scale) {
    throw new Error(
      `the all-rows probe matched ${allTotal} of ${scale} rows. It is supposed to be in every ` +
        `row, so this is not the worst case it is labelled as — refusing to publish it as one.`
    );
  }

  results.push({
    scale,
    fnMs: fn.ms,
    ilikeMs: ilike.ms,
    noWindowMs: noWindow.ms,
    noOccMs: noOcc.ms,
    midMs: mid.ms,
    allMs: all.ms,
    allTotal,
    usedIndex,
    usedInLoop,
    escapedPlan: await planOf(sql, escaped),
    midPlan: await planOf(sql, `%${MID}%`),
  });

  await sql.close();
  process.stdout.write("\n");
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log("\n  1. Does an ESCAPED pattern still reach the trigram index?\n");
console.log(`     rows        first call   index used in ${PLAN_CALLS} more   plan (inlined equivalent)`);
console.log("     ─────────   ──────────   ─────────────────────   ─────────────────────────");
for (const r of results) {
  console.log(
    `     ${String(r.scale.toLocaleString()).padEnd(9)}   ` +
      `${(r.usedIndex ? "index" : "seq").padEnd(10)}   ` +
      `${`${r.usedInLoop}/${PLAN_CALLS}`.padEnd(21)}   ${r.escapedPlan}`
  );
}
console.log(
  "\n     idx_scan is the load-bearing column: it is read from pg_stat before and\n" +
    "     after the function call, so it describes what the FUNCTION did. The plan\n" +
    "     beside it is EXPLAIN of the equivalent inlined query — the same pattern,\n" +
    "     but a reconstruction, because EXPLAIN of a plpgsql call shows only a\n" +
    "     Function Scan.\n\n" +
    "     The third column exists because plpgsql may switch to a GENERIC plan\n" +
    "     after five executions of the same statement, built without knowing the\n" +
    "     pattern. If one ever chose a sequential scan, the function would be fast\n" +
    "     five times and then slow for the rest of the session. Below the\n" +
    "     crossover a mixed count is not a problem — both plans cost the same\n" +
    "     there, and the planner is entitled to pick either."
);

console.log("\n  2. What the function costs over a bare indexed ILIKE\n");
console.log("     rows        bare ILIKE   + occurrences   + total_count   full fn");
console.log("     ─────────   ──────────   ─────────────   ─────────────   ───────");
for (const r of results) {
  console.log(
    `     ${String(r.scale.toLocaleString()).padEnd(9)}   ` +
      `${fmt(r.ilikeMs).padEnd(10)}   ${fmt(r.noWindowMs).padEnd(13)}   ` +
      `${fmt(r.noOccMs).padEnd(13)}   ${fmt(r.fnMs)}`
  );
}
console.log(
  "\n     The middle two columns are not cumulative: each adds ONE of the function's\n" +
    "     extras to the bare pattern, so each prices that extra on its own.\n" +
    "     '+ occurrences' is the per-row count and the sort, no window.\n" +
    "     '+ total_count' is the window and the sort, no per-row count.\n" +
    "     'full fn' is the shipped function, which also returns content rather\n" +
    "     than ids — so a few of its microseconds are bytes on the wire."
);

console.log("\n  3. Where the index helps least, and the actual ceiling\n");
console.log("     rows        ~10% of rows   plan               every row");
console.log("     ─────────   ────────────   ────────────────   ─────────");
for (const r of results) {
  console.log(
    `     ${String(r.scale.toLocaleString()).padEnd(9)}   ${fmt(r.midMs).padEnd(12)}   ` +
      `${r.midPlan.padEnd(16)}   ${fmt(r.allMs)}`
  );
}
console.log(
  "\n     The last column is the worst case any caller can ask for, and it is the\n" +
    "     number an operator needs. A needle matching everything has to touch the\n" +
    "     whole heap however it is found, and the occurrence count and total_count\n" +
    "     are then paid on all of it — no index can help.\n\n" +
    "     An earlier version of this script printed only the 10% column and called\n" +
    "     it 'the honest ceiling on the feature'. It is about nine times short of\n" +
    "     one.\n"
);
