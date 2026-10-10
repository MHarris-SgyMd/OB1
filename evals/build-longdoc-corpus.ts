#!/usr/bin/env bun
/**
 * build-longdoc-corpus.ts (SMD-1961) — assemble the long-document corpus for
 * entity/relation extraction labelling.
 *
 * The planted set (eval-extract-windows.ts --planted) is three documents, so
 * SMD-1879's window-header and runaway-retry decisions rest on n=3 and no
 * precision was measured (SMD-1961). This selects the longest REAL thoughts from
 * a brain — the synced long Linear issues AND the ingested research papers
 * (research:smd-2189), several of which are the over-cap thoughts extraction
 * skipped whole (EXTRACT_MAX_WINDOWS, SMD-2240) — so the corpus carries genuine
 * cross-window relations (SMD-2018) the short captures cannot.
 *
 * Read-only against the live brain; DATABASE_URL is built inside the one-off
 * container from $POSTGRES_PASSWORD (never on argv). Writes the corpus TEXT to
 * OB1_LONGDOC_OUT (default /repo/evals/longdoc-corpus.json — *-corpus.json is
 * gitignored; the grades fixture that references it stays ids-only). Only the
 * corpus's ids + numbers ever enter the repo, via the later grades fixture.
 *
 *   podman run --rm --network open-brain_data --env-file deploy/.env \
 *     -v <worktree>:/repo -w /repo oven/bun:1.4.0-alpine \
 *     sh -c 'export DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/openbrain"; bun evals/build-longdoc-corpus.ts'
 */
import { SQL } from "bun";
import { writeFileSync } from "node:fs";

const URL = process.env.DATABASE_URL;
if (!URL) { console.error("DATABASE_URL required (built inside the container from $POSTGRES_PASSWORD)"); process.exit(2); }

const N = Number(process.env.OB1_LONGDOC_N ?? 30);
// ~4,800 chars ≈ one 1,200-token extraction window (db/config.mjs EXTRACT_MAX_WINDOWS
// doc: 24 windows ≈ 115,000 chars). MIN ≈ 3 windows, so every doc actually windows.
const CHARS_PER_WINDOW = 4800;
const MIN = Number(process.env.OB1_LONGDOC_MIN_CHARS ?? CHARS_PER_WINDOW * 3);
const OUT = process.env.OB1_LONGDOC_OUT ?? "/repo/evals/longdoc-corpus.json";

const sql = new SQL({ url: URL });

const rows = (await sql`
  SELECT id::text AS id,
         content,
         length(content) AS chars,
         ceil(length(content)::float / ${CHARS_PER_WINDOW})::int AS approx_windows,
         coalesce(metadata->>'source', 'unknown') AS source,
         metadata->>'issue' AS issue,
         left(regexp_replace(content, '\s+', ' ', 'g'), 90) AS head
  FROM thoughts
  WHERE length(content) >= ${MIN}
  ORDER BY length(content) DESC
  LIMIT ${N}`) as {
    id: string; content: string; chars: number; approx_windows: number;
    source: string; issue: string | null; head: string;
  }[];

const docs = rows.map((r) => ({
  id: r.id,
  title: r.issue ?? r.head.slice(0, 60),
  text: r.content,
  source: r.source,
  issue: r.issue,
  chars: r.chars,
  approx_windows: r.approx_windows,
}));

writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  note: "SMD-1961 long-document corpus: the longest real thoughts from the brain, for entity/relation extraction labelling. Text is not committed (*-corpus.json is gitignored); the grades fixture references these ids only.",
  chars_per_window: CHARS_PER_WINDOW,
  min_chars: MIN,
  count: docs.length,
  docs,
}, null, 1));

// Report — the candidate set, so we can see we have enough long, window-spanning material.
const bySource: Record<string, number> = {};
for (const d of docs) bySource[d.source] = (bySource[d.source] ?? 0) + 1;
const windowing = docs.filter((d) => d.approx_windows >= 2).length;
const overCap = docs.filter((d) => d.approx_windows > 24).length;
console.log(`  selected ${docs.length} docs (>= ${MIN} chars) → ${OUT}`);
console.log(`  by source: ${Object.entries(bySource).map(([s, c]) => `${c} ${s}`).join(", ")}`);
console.log(`  ${windowing} span >1 window; ${overCap} are over EXTRACT_MAX_WINDOWS (24) — SMD-2240 territory\n`);
console.log("  rank  ~win   chars  source            issue        head");
console.log("  " + "─".repeat(100));
docs.forEach((d, i) => {
  console.log(
    `  ${String(i + 1).padStart(4)}  ${String(d.approx_windows).padStart(4)}  ${String(d.chars).padStart(6)}  ` +
    `${d.source.padEnd(16)}  ${(d.issue ?? "—").padEnd(11)}  ${d.title.slice(0, 44)}`
  );
});
await sql.close();
