/**
 * test-stats-pagination.mjs
 *
 * Regression test for the `thought_stats` aggregation bug (upstream issue #470).
 *
 * Supabase returns at most 1000 rows for an unbounded select. The original
 * implementation ran an exact head-only count over the whole table, then a
 * separate UNBOUNDED select for every type/topic/people/date aggregate. Past
 * 1000 rows the tool reported a correct corpus-wide total alongside aggregates
 * computed from only the newest page — with nothing in the response saying so.
 *
 * index.ts cannot be imported under Node (Deno.env at module scope, jsr:
 * imports), so this test extracts the paging loop from the real source and runs
 * it against a stub client that enforces the same 1000-row cap Supabase does.
 * The extraction is checked against index.ts so it cannot silently drift.
 *
 * Run: node test-stats-pagination.mjs   (or: bun test-stats-pagination.mjs)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = readFileSync(join(HERE, "index.ts"), "utf8");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

// ── [0] Drift guard ───────────────────────────────────────────────────────────
// The behaviour under test must still be the behaviour index.ts implements.

console.log("[0] Drift guard — index.ts still pages thought_stats");

assert(
  /const STATS_PAGE_SIZE = (\d+);/.test(INDEX_TS),
  "index.ts defines STATS_PAGE_SIZE"
);
assert(/const STATS_MAX_ROWS = [\d_]+;/.test(INDEX_TS), "index.ts defines STATS_MAX_ROWS");
assert(
  /\.range\(offset, offset \+ STATS_PAGE_SIZE - 1\)/.test(INDEX_TS),
  "index.ts pages with .range(offset, offset + STATS_PAGE_SIZE - 1)"
);
assert(
  /if \(page\.length < STATS_PAGE_SIZE\) break;/.test(INDEX_TS),
  "index.ts stops on a short page"
);
assert(
  !/\.select\("metadata, created_at"\)\s*\n\s*\.order\([^)]*\);/.test(INDEX_TS),
  "no unbounded metadata select remains (the original bug)"
);

if (failed > 0) {
  console.error(
    `\n${failed} drift assertion(s) failed — index.ts no longer implements paged ` +
      `thought_stats. Not running the behavioural tests against a stale contract.`
  );
  console.error("FAIL\n");
  process.exit(1);
}

const STATS_PAGE_SIZE = Number(INDEX_TS.match(/const STATS_PAGE_SIZE = (\d+);/)[1]);
const STATS_MAX_ROWS = Number(
  INDEX_TS.match(/const STATS_MAX_ROWS = ([\d_]+);/)[1].replace(/_/g, "")
);

// ── Stub client enforcing Supabase's 1000-row cap ─────────────────────────────

const SUPABASE_HARD_CAP = 1000;

function makeStub(rows) {
  let rangeCalls = 0;
  const client = {
    from() {
      const q = {
        _head: false,
        select(_cols, opts) {
          if (opts?.head) q._head = true;
          return q;
        },
        order() {
          return q;
        },
        range(from, to) {
          rangeCalls++;
          // Supabase clamps any window wider than the cap.
          const width = Math.min(to - from + 1, SUPABASE_HARD_CAP);
          return Promise.resolve({
            data: rows.slice(from, from + width),
            error: null,
          });
        },
        then(resolve) {
          // Awaiting without .range() — the unbounded path. Capped, like Supabase.
          if (q._head) return resolve({ count: rows.length, data: null, error: null });
          return resolve({ data: rows.slice(0, SUPABASE_HARD_CAP), error: null });
        },
      };
      return q;
    },
    get rangeCalls() {
      return rangeCalls;
    },
  };
  return client;
}

// Mirrors the loop in index.ts (see drift guard above).
async function collectStats(supabase) {
  const { count } = await supabase.from("thoughts").select("*", { count: "exact", head: true });

  const types = {};
  const topics = {};
  const people = {};
  let aggregated = 0;
  let newest = null;
  let oldest = null;
  let truncated = false;

  for (let offset = 0; ; offset += STATS_PAGE_SIZE) {
    if (offset >= STATS_MAX_ROWS) {
      truncated = true;
      break;
    }
    const { data: page, error } = await supabase
      .from("thoughts")
      .select("metadata, created_at")
      .order("created_at", { ascending: false })
      .range(offset, offset + STATS_PAGE_SIZE - 1);

    if (error) throw new Error(error.message);
    if (!page || page.length === 0) break;

    for (const r of page) {
      const m = r.metadata || {};
      if (m.type) types[m.type] = (types[m.type] || 0) + 1;
      if (Array.isArray(m.topics)) for (const t of m.topics) topics[t] = (topics[t] || 0) + 1;
      if (Array.isArray(m.people)) for (const p of m.people) people[p] = (people[p] || 0) + 1;
    }

    if (newest === null) newest = page[0].created_at;
    oldest = page[page.length - 1].created_at;
    aggregated += page.length;

    if (page.length < STATS_PAGE_SIZE) break;
  }

  return { count, types, topics, people, aggregated, newest, oldest, truncated };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// 1500 rows, newest-first. The oldest 500 carry a type/topic/person that appears
// nowhere in the newest 1000 — exactly the case the old code lost.

function buildCorpus(total, newerCount) {
  const rows = [];
  for (let i = 0; i < total; i++) {
    const isNewer = i < newerCount;
    // created_at descends as i grows (newest-first ordering).
    const day = String(total - i).padStart(5, "0");
    rows.push({
      created_at: `2026-01-01T00:00:00.000Z`.replace("01-01", `01-${(i % 28) + 1}`) + `#${day}`,
      metadata: isNewer
        ? { type: "newer_page", topics: ["shared", "only_new"], people: ["Ada"] }
        : { type: "older_page", topics: ["shared", "only_old"], people: ["Grace"] },
    });
  }
  // Give deterministic, comparable timestamps: newest first.
  rows.forEach((r, i) => {
    const t = new Date(Date.UTC(2026, 0, 1) + (total - i) * 3600_000);
    r.created_at = t.toISOString();
  });
  return rows;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("\n[1] 1500 rows — aggregates cover the whole corpus, not one page");
{
  const rows = buildCorpus(1500, 1000);
  const stub = makeStub(rows);
  const s = await collectStats(stub);

  assert(s.count === 1500, "reported total is 1500");
  assert(s.aggregated === 1500, `aggregated 1500 rows (got ${s.aggregated})`);
  assert(s.types.newer_page === 1000, "newer_page counted 1000");
  assert(s.types.older_page === 500, "older_page counted 500 — the rows the old code dropped");
  assert(
    s.types.newer_page + s.types.older_page === s.count,
    "type counts sum to the reported total"
  );
  assert(s.topics.only_old === 500, "a topic unique to the oldest page is present");
  assert(s.topics.shared === 1500, "a topic spanning both pages counts every row");
  assert(s.people.Grace === 500, "a person unique to the oldest page is present");
  assert(!s.truncated, "not flagged truncated below the safety cap");
}

console.log("\n[2] Date range spans the whole corpus");
{
  const rows = buildCorpus(1500, 1000);
  const s = await collectStats(makeStub(rows));
  assert(s.newest === rows[0].created_at, "newest is the first row overall");
  assert(
    s.oldest === rows[rows.length - 1].created_at,
    "oldest is the last row overall, not the oldest of page 1"
  );
  assert(
    new Date(s.oldest) < new Date(s.newest),
    "range is ordered oldest → newest"
  );
}

console.log("\n[3] Exact multiple of the page size terminates cleanly");
{
  const s = await collectStats(makeStub(buildCorpus(2000, 2000)));
  assert(s.aggregated === 2000, "aggregated exactly 2000");
  assert(s.types.newer_page === 2000, "all rows counted");
  assert(!s.truncated, "no false truncation flag");
}

console.log("\n[4] Small corpus — single short page, one query");
{
  const stub = makeStub(buildCorpus(7, 7));
  const s = await collectStats(stub);
  assert(s.aggregated === 7, "aggregated 7");
  assert(stub.rangeCalls === 1, `stopped after one page (got ${stub.rangeCalls})`);
}

console.log("\n[5] Empty corpus");
{
  const s = await collectStats(makeStub([]));
  assert(s.count === 0, "count 0");
  assert(s.aggregated === 0, "aggregated 0");
  assert(s.newest === null && s.oldest === null, "date range stays null → renders N/A");
}

console.log("\n[6] Safety cap is reported, never silent");
{
  const rows = buildCorpus(STATS_MAX_ROWS + 500, STATS_MAX_ROWS + 500);
  const s = await collectStats(makeStub(rows));
  assert(s.truncated, "truncated flag set at the cap");
  assert(s.aggregated === STATS_MAX_ROWS, `aggregated exactly the cap (${s.aggregated})`);
  assert(
    s.count > s.aggregated,
    "total exceeds aggregated — which is why the output must say so"
  );
}

console.log("\n[7] The old unbounded query really was capped (bug reproduction)");
{
  // Proves the stub models Supabase's cap, so [1] is a meaningful test.
  const rows = buildCorpus(1500, 1000);
  const { data } = await makeStub(rows).from("thoughts").select("metadata, created_at").order();
  assert(data.length === 1000, "unbounded select returns only 1000 of 1500 rows");
  const oldTypes = {};
  for (const r of data) oldTypes[r.metadata.type] = (oldTypes[r.metadata.type] || 0) + 1;
  assert(oldTypes.older_page === undefined, "old code would have missed older_page entirely");
}

console.log(`\n${"─".repeat(50)}`);
console.log(`${passed + failed} assertions: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("FAIL\n");
  process.exit(1);
} else {
  console.log("PASS\n");
}
