#!/usr/bin/env bun
/**
 * bench-hybrid.ts — does `search_thoughts_hybrid` reach both indexes, and what
 * does the fusion cost over its two arms called on their own?
 *
 *   ./with-postgres.sh bun bench-hybrid.ts
 *   OB1_BENCH_SCALES=10000,100000 ./with-postgres.sh bun bench-hybrid.ts
 *
 * Migration 017's function calls `match_thoughts` and `search_thoughts_keyword`
 * rather than inlining either, and its header claims their access paths — HNSW
 * with the filter inside the scan, the trigram bitmap through an escaped
 * pattern — are inherited. That is an argument about plpgsql calling plpgsql,
 * and the ticket (SMD-958) asks for the regression it would hide to be checked
 * directly: either arm degrading into a full scan when reached through the
 * wrapper.
 *
 * ── How the access path is established ───────────────────────────────────────
 * Not by EXPLAIN. As bench-keyword.ts explains, EXPLAIN of a plpgsql function
 * shows a Function Scan and nothing inside it. `pg_stat_user_indexes.idx_scan`
 * for each index is read before and after the calls; a delta of one per call is
 * direct evidence that the index served the query THE FUNCTION ran. Thirteen
 * calls rather than one, because plpgsql may switch a statement to a generic
 * plan after five executions and a generic plan built without the pattern could
 * choose differently — the probe 012's benchmark established.
 *
 * ── The control ──────────────────────────────────────────────────────────────
 * Five rows carry the identifier, five carry a decoy that only an UNESCAPED
 * pattern matches (`resolve-agent-zylotrope` for `resolve_agent_zylotrope`).
 * The fused result must put exactly the five marked rows first, each saying
 * which needle it matched, and no decoy row may claim a match. If that fails the
 * script refuses to print timings, because a faster wrong query is not a result.
 *
 * ── What is timed ────────────────────────────────────────────────────────────
 * Median wall clock including the client round trip, first call discarded:
 * the fused function; each arm as the function calls it; and the fused
 * function on a query with NO needle, which is what every ordinary semantic
 * search now pays — the needle rule, the stopword test, and the wrapper around
 * match_thoughts — against match_thoughts called directly.
 *
 * The first run of this bench found the wrapper cost 15 ms where its arms cost
 * 1.3 together: the planner's estimate for the fused query was three orders of
 * magnitude high (it cannot see into a plpgsql function and assumes 1,000 rows
 * from each), which crossed `jit_above_cost`, and PostgreSQL JIT-compiled 112
 * expressions on every call. auto_explain with nested statements showed it —
 * "Functions: 112" under the RETURN QUERY — and nothing at the SQL level did.
 * The function no longer joins `thoughts` and runs with `jit = off`; the
 * migration header records the finding, and this bench is what would catch it
 * coming back.
 *
 * ── prefer_current (059, SMD-2255; stored, 068 / SMD-2256) ───────────────────
 * The last blocks time search_thoughts_current against the hybrid on the same
 * rows, after stamping lifecycles and supersession onto them — interleaved in
 * alternating order, the added cost the difference of the two medians (the
 * estimator pre-registered at 059), the median of the paired differences
 * printed beside it — against the budget the flag was pre-registered with (at
 * most the hybrid's own median at 10,000 rows); then what 068's triggers cost
 * a writer, against the triggers dropped.
 *
 * ── The dependency read (069, SMD-2267) ──────────────────────────────────────
 * Then source rows and blocked_by links on the ticket rows, and node_state's
 * dependency columns timed for forty ids and for every thought, and
 * node_dependencies(), on 069's reads against the reads as 068 left them;
 * then what 069's gate triggers cost a writer, against them dropped.
 */

import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { applyMigrations, migrationFiles, requireDatabaseUrl, resetSchema, seededRandom } from "./test-support.ts";
import { commandLine } from "./cli.ts";

commandLine("bench-hybrid.ts", {}, { note: "its knobs are OB1_BENCH_* environment variables" });
const URL_ = requireDatabaseUrl("bench-hybrid.ts");
const DIM = 64;
const SCALES = (process.env.OB1_BENCH_SCALES ?? "10000").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
if (!SCALES.length) { console.error("OB1_BENCH_SCALES must name at least one positive row count"); process.exit(2); }
const REPEATS = 7;
const PROBE_CALLS = 13;
const IDENT = "resolve_agent_zylotrope";
const DECOY = "resolve-agent-zylotrope";
/** In every tenth row: a needle too common to match, which the probe must dismiss without paging. */
const COMMON = "omnimid_zylotrope";
const MARKED = 5;

const WORDS = (
  "the a of to and in that for on with as by from at an is was are were be been " +
  "migration schema index query planner vector embedding thought capture retrieval " +
  "postgres cluster deploy runtime provider chunk audit agent identity keyword"
).split(" ");

const lit = (v: number[]) => `[${v.join(",")}]`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmt = (ms: number) => (ms < 10 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`);

async function load(sql: SQL, n: number): Promise<number[]> {
  const { rnd, unitVector } = seededRandom(20260907 + n);
  const B = 500;
  for (let i = 0; i < n; i += B) {
    const values: string[] = [];
    for (let j = i; j < Math.min(i + B, n); j++) {
      const words: string[] = [];
      for (let w = 0; w < 40; w++) words.push(WORDS[Math.floor(rnd() * WORDS.length)]);
      if (j < MARKED) words.splice(10, 0, IDENT);
      else if (j < MARKED * 2) words.splice(10, 0, DECOY);
      else if (j % 10 === 0) words.splice(10, 0, COMMON);
      values.push(`('${words.join(" ")}', '{"doc":${j}}'::jsonb, '${lit(unitVector(DIM))}'::vector)`);
    }
    await sql.unsafe(`INSERT INTO thoughts (content, metadata, embedding) VALUES ${values.join(",")}`);
  }
  await sql.unsafe("VACUUM ANALYZE thoughts");
  return unitVector(DIM); // the query vector: drawn after every row, so it coincides with none
}

async function indexScans(sql: SQL, index: string): Promise<number> {
  await sql`SELECT pg_stat_force_next_flush()`;
  await sql`SELECT pg_stat_clear_snapshot()`;
  const r = await sql`SELECT coalesce(sum(idx_scan), 0)::bigint AS n FROM pg_stat_user_indexes WHERE indexrelname = ${index}`;
  return Number(r[0].n);
}

async function time(fn: () => Promise<unknown>): Promise<number> {
  await fn();
  const ms: number[] = [];
  for (let i = 0; i < REPEATS; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
  return median(ms);
}

/** node_state(<40 ids>) at each scale run, for the 100,000-row budget (069). */
const keyedBudget = new Map<number, number>();
for (const n of SCALES) {
  console.log(`\n  ${n.toLocaleString()} rows, ${DIM} dimensions, ${MARKED} rows carry ${IDENT}, ${MARKED} carry the decoy ${DECOY}`);
  await resetSchema(URL_, { dim: DIM, model: "stub-embed", trgm: true });
  const sql = new SQL({ url: URL_, max: 1 });
  const q = lit(await load(sql, n));
  const text = `the scheduler timeout around ${IDENT}`;
  const hybrid = () => sql`SELECT content, matched_needles FROM search_thoughts_hybrid(${q}::vector, ${text}, 0.0, 10, '{}'::jsonb)`;

  // ── Control ────────────────────────────────────────────────────────────────
  // The query has content words, so the vector arm keeps its vote: its rank-1
  // row ties the exact hits on score and wins the tie on similarity (017's
  // header). The five marked rows therefore occupy positions 1–6 with at most
  // one vector-only row among them, every one of them names the needle, and no
  // decoy row claims a match — anything else and the timings are not printed.
  const rows = (await hybrid()) as { content: string; matched_needles: string[] }[];
  const shape = rows.map((r) => (r.content.includes(IDENT) ? "marked" : r.content.includes(DECOY) ? "DECOY" : "other"));
  const marked = rows.filter((r) => r.content.includes(IDENT));
  const claimed = rows.filter((r) => r.matched_needles.length);
  const ok = marked.length === MARKED && claimed.length === MARKED
    && marked.every((r) => r.matched_needles.join() === IDENT)
    && shape.slice(0, MARKED + 1).filter((s) => s === "marked").length === MARKED
    && !shape.includes("DECOY");
  if (!ok) {
    console.error(`  the fused result is wrong: ${marked.length} marked rows returned, ${claimed.length} rows claim a match, order ${shape.join(", ")} — refusing to time it`);
    await sql.close();
    process.exit(1);
  }
  console.log(`  control: the ${MARKED} marked rows are within the first ${MARKED + 1} (order ${shape.slice(0, MARKED + 1).join(", ")}), each matched on the needle; no decoy row claims a match`);

  // ── Index reach ────────────────────────────────────────────────────────────
  const before = { hnsw: await indexScans(sql, "thoughts_embedding_idx"), trgm: await indexScans(sql, "idx_thoughts_content_trgm") };
  for (let i = 0; i < PROBE_CALLS; i++) await hybrid();
  const after = { hnsw: await indexScans(sql, "thoughts_embedding_idx"), trgm: await indexScans(sql, "idx_thoughts_content_trgm") };
  const dh = after.hnsw - before.hnsw, dt = after.trgm - before.trgm;
  // The trigram index is read twice per call with a needle: once by the probe
  // that asks whether the needle is common, once by the page it then fetches.
  console.log(`  index reach over ${PROBE_CALLS} calls (idx_scan deltas): HNSW ${dh}, trigram ${dt} (probe + page per call)${dh >= PROBE_CALLS ? "" : "  ← the vector arm did not use its index on every call"}${dt >= 2 * PROBE_CALLS ? "" : "  ← the keyword arm did not use its index for both the probe and the page on every call"}`);

  // ── Cost ───────────────────────────────────────────────────────────────────
  const tHybrid = await time(hybrid);
  // The arms exactly as the function calls them: the vector arm at N with no
  // threshold, the keyword arm's full page.
  const tVector = await time(() => sql`SELECT id FROM match_thoughts(${q}::vector, -1.0, 10, '{}'::jsonb)`);
  const tKeyword = await time(() => sql`SELECT id FROM search_thoughts_keyword(${IDENT}, 100, 0, '{}'::jsonb)`);
  const plain = "what happened with the scheduler";
  const tHybridPlain = await time(() => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${plain}, 0.5, 10, '{}'::jsonb)`);
  const tVectorPlain = await time(() => sql`SELECT id FROM match_thoughts(${q}::vector, 0.5, 10, '{}'::jsonb)`);
  // A needle in a tenth of the rows: the probe must call it common and never
  // page it. The keyword function's own cost for that needle is what the
  // fused call would have paid before the probe existed.
  const commonQ = `the scheduler around ${COMMON}`;
  const commonRows = (await sql`SELECT common_needles FROM search_thoughts_hybrid(${q}::vector, ${commonQ}, 0.0, 10, '{}'::jsonb)`) as { common_needles: string[] }[];
  if (!commonRows.length || commonRows[0].common_needles.join() !== COMMON) {
    console.error(`  the common needle was not reported as common (${JSON.stringify(commonRows[0]?.common_needles)}) — refusing to time it`);
    await sql.close();
    process.exit(1);
  }
  const tHybridCommon = await time(() => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${commonQ}, 0.0, 10, '{}'::jsonb)`);
  const tKeywordCommon = await time(() => sql`SELECT id FROM search_thoughts_keyword(${COMMON}, 100, 0, '{}'::jsonb)`);
  console.log(`\n  median of ${REPEATS}, wall clock with the round trip:\n`);
  console.log(`    fused, one needle                       ${fmt(tHybrid).padStart(9)}`);
  console.log(`      match_thoughts(-1, 10) on its own     ${fmt(tVector).padStart(9)}`);
  console.log(`      search_thoughts_keyword(needle, 100)  ${fmt(tKeyword).padStart(9)}`);
  console.log(`      fusion overhead over the two arms     ${fmt(tHybrid - tVector - tKeyword).padStart(9)}`);
  console.log(`    fused, no needle (every ordinary query) ${fmt(tHybridPlain).padStart(9)}`);
  console.log(`      match_thoughts(0.5, 10) on its own    ${fmt(tVectorPlain).padStart(9)}`);
  console.log(`      wrapper overhead                      ${fmt(tHybridPlain - tVectorPlain).padStart(9)}`);
  console.log(`    fused, one needle in 10% of rows        ${fmt(tHybridCommon).padStart(9)}   (probed as common, not paged)`);
  console.log(`      the keyword page it did not fetch     ${fmt(tKeywordCommon).padStart(9)}`);

  // ── prefer_current (059, SMD-2255; stored, 068 / SMD-2256) ─────────────────
  // search_thoughts_current reads the hybrid at min(100, 4N) and node_state for
  // the window; since 068 node_state reads two stored tables by primary key
  // (at 059 it computed the whole brain's lifecycle per call). Timed after the
  // rows above, so their numbers are what they were: 40% of the rows become
  // ticket rows (tickets of one or two rows, so heads sometimes choose), a
  // quarter of those settled, and one row in twenty supersedes the row before
  // it. The budget, pre-registered at 059: the flag adds at most the hybrid's
  // own median at 10,000 rows, read as the difference of the two medians
  // (missed at 059; SMD-2256). The two are timed interleaved, a call of each
  // per round, the order alternating round by round (first review pass: always
  // hybrid first handed the flag warm pages), and the median of the paired
  // differences is printed beside it — a busy machine slows both halves of a
  // pair alike. The hybrid at the flag's window, min(100, 4N) = 40, is timed
  // too: that much of the added cost is the wider read, not node_state.
  const stampTickets = (settled: string, live: string) =>
    sql.unsafe(`UPDATE thoughts SET metadata = metadata || jsonb_build_object('issue', 'B-' || ((metadata->>'doc')::int / 2),
                  'status_type', CASE WHEN (metadata->>'doc')::int % 20 < 2 THEN '${settled}' ELSE '${live}' END)
                 WHERE (metadata->>'doc')::int % 5 < 2`);
  const timed = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return performance.now() - t; };
  await stampTickets("completed", "started");
  await sql.unsafe(`UPDATE thoughts t SET supersedes = s.id FROM thoughts s
                     WHERE (t.metadata->>'doc')::int % 20 = 3 AND (s.metadata->>'doc')::int = (t.metadata->>'doc')::int - 1`);
  await sql.unsafe("VACUUM ANALYZE thoughts");
  const [st] = await sql`SELECT count(*) FILTER (WHERE open = false)::int AS settled, count(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS superseded FROM node_state()`;
  const ROUNDS = 101;
  const paired = async (off: () => Promise<unknown>, on: () => Promise<unknown>) => {
    await off(); await on();
    const a: number[] = [], b: number[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      if (i % 2 === 0) { a.push(await timed(off)); b.push(await timed(on)); }
      else { b.push(await timed(on)); a.push(await timed(off)); }
    }
    return { off: median(a), on: median(b), added: median(b) - median(a), pairedAdded: median(b.map((x, i) => x - a[i])) };
  };
  const plainP = await paired(() => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${plain}, 0.5, 10, '{}'::jsonb)`,
                              () => sql`SELECT id FROM search_thoughts_current(${q}::vector, ${plain}, 0.5, 10, '{}'::jsonb)`);
  const needleP = await paired(hybrid, () => sql`SELECT content, matched_needles FROM search_thoughts_current(${q}::vector, ${text}, 0.0, 10, '{}'::jsonb)`);
  const windowP = await paired(() => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${plain}, 0.5, 10, '{}'::jsonb)`,
                               () => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${plain}, 0.5, 40, '{}'::jsonb)`);
  // A read of the columns, not count(*): since 068 count(*) reads none, and
  // the planner drops every join (first review pass).
  const tState = await time(() => sql`SELECT count(open) + count(superseded_by) FROM node_state()`);
  const tStateAll = await time(() => sql`SELECT count(blockers) + count(open) + count(superseded_by) FROM node_state()`);
  const verdict = (p: { off: number; added: number }) => (n === 10000 ? `; budget ${fmt(p.off)}: ${p.added <= p.off ? "within" : "OVER"}` : "");
  console.log(`\n  prefer_current (059, stored since 068), ${st.settled.toLocaleString()} settled and ${st.superseded.toLocaleString()} superseded rows, ${ROUNDS} interleaved rounds:\n`);
  console.log(`    hybrid, no needle                       ${fmt(plainP.off).padStart(9)}`);
  console.log(`    search_thoughts_current, no needle      ${fmt(plainP.on).padStart(9)}   (+${fmt(plainP.added)}; paired +${fmt(plainP.pairedAdded)}${verdict(plainP)})`);
  console.log(`      the hybrid asked for 40, its window     ${fmt(windowP.on).padStart(9)}   (+${fmt(windowP.added)} over asked for 10, no needle; paired +${fmt(windowP.pairedAdded)})`);
  console.log(`    hybrid, one needle                      ${fmt(needleP.off).padStart(9)}`);
  console.log(`    search_thoughts_current, one needle     ${fmt(needleP.on).padStart(9)}   (+${fmt(needleP.added)}; paired +${fmt(needleP.pairedAdded)}${verdict(needleP)})`);
  console.log(`      node_state()'s lifecycle and superseded_by, every thought ${fmt(tState)}`);
  console.log(`      node_state(), every column (the dependency read too)      ${fmt(tStateAll)}`);

  // What 068's triggers cost a writer, pre-registered: a plain capture at most
  // +0.1 ms, a ticket's status update at most +0.5 ms, a bulk stamp of 40% of
  // the rows at most +20%. Off is the three row-change triggers DROPPED, in
  // alternating blocks, and on is them re-created from their own definitions:
  // a disabled trigger still has its transition tables filled, a cost of its
  // own on a bulk statement (second review pass: DISABLE hid it).
  const triggerDefs = (await sql`SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
                                  WHERE tgrelid = 'thoughts'::regclass AND tgname IN ('thoughts_node_projection_insert', 'thoughts_node_projection_update', 'thoughts_node_projection_delete')`) as { tgname: string; def: string }[];
  if (triggerDefs.length !== 3) throw new Error(`expected 068's three row-change triggers, found ${triggerDefs.length}`);
  const projectionTriggers = (on: boolean) => sql.unsafe(triggerDefs
    .map((t) => `DROP TRIGGER IF EXISTS ${t.tgname} ON thoughts;${on ? ` ${t.def};` : ""}`).join(" "));
  const writeBlocks = async (call: () => Promise<unknown>) => {
    const on: number[] = [], off: number[] = [];
    for (let block = 0; block < 10; block++) {
      const enabled = block % 2 === 0;
      await projectionTriggers(enabled);
      for (let i = 0; i < 20; i++) (enabled ? on : off).push(await timed(call));
    }
    await projectionTriggers(true);
    return { on: median(on), off: median(off) };
  };
  let captures = 0;
  const capture = await writeBlocks(() => sql`SELECT upsert_thought(${`bench capture ${n} ${++captures}`}, '{"metadata":{}}'::jsonb)`);
  const tickets = (await sql`SELECT id FROM thoughts WHERE metadata ? 'issue' ORDER BY id LIMIT 200`).map((r: { id: string }) => r.id);
  let tick = 0;
  const statusUpdate = await writeBlocks(() => {
    const i = tick++;
    return sql`UPDATE thoughts SET metadata = metadata || jsonb_build_object('status_type', ${i % 2 ? "completed" : "started"}::text,
                 'linear_updated_at', ${`2026-10-01T00:00:${String(i % 60).padStart(2, "0")}Z`}::text) WHERE id = ${tickets[i % tickets.length]}`;
  });
  // The bulk stamp, three times each way, the arm that goes first alternating
  // round by round (third review pass: always off first). Every run stamps
  // values no run used before, so every on run rewrites every head it names,
  // stale or not, and no rebuild is needed between runs; the last run is on,
  // so drift() read after it tests the triggers.
  const stampsOn: number[] = [], stampsOff: number[] = [];
  let stamp = 0;
  const bulk = async (on: boolean) => {
    await projectionTriggers(on);
    const k = ++stamp;
    (on ? stampsOn : stampsOff).push(await timed(() => stampTickets(`settled-${k}`, `live-${k}`)));
  };
  for (const order of [[false, true], [true, false], [false, true]]) for (const on of order) await bulk(on);
  await projectionTriggers(true);
  const [{ drift }] = await sql`SELECT count(*)::int AS drift FROM ob1_node_projection_drift()`;
  const stampOn = median(stampsOn), tStampOff = median(stampsOff);
  const within = (ok: boolean) => (ok ? "within" : "OVER");
  console.log(`\n  068's triggers on a writer, against them dropped (medians; the bulk stamp three times each way):\n`);
  console.log(`    a plain upsert_thought                  ${fmt(capture.on).padStart(9)} vs ${fmt(capture.off)}   (+${fmt(capture.on - capture.off)}; budget 0.10 ms: ${within(capture.on - capture.off <= 0.1)})`);
  console.log(`    a ticket's status update                ${fmt(statusUpdate.on).padStart(9)} vs ${fmt(statusUpdate.off)}   (+${fmt(statusUpdate.on - statusUpdate.off)}; budget 0.50 ms: ${within(statusUpdate.on - statusUpdate.off <= 0.5)})`);
  console.log(`    stamping 40% of the rows                ${fmt(stampOn).padStart(9)} vs ${fmt(tStampOff)}   (${stampOn >= tStampOff ? "+" : ""}${((stampOn / tStampOff - 1) * 100).toFixed(0)}%; budget +20%: ${within(stampOn <= tStampOff * 1.2)})`);
  console.log(`    drift() after the last triggered stamp  ${String(drift).padStart(9)}${drift === 0 ? "" : "  ← the triggers left the projection behind"}`);

  // ── The dependency read (069, SMD-2267) ────────────────────────────────────
  // After the arms above, so their numbers do not move: the ticket rows get
  // their statuses back (the stamps left unknown ones), each head a linear
  // source row, and every even ticket a blocked_by link to the next. Timed on
  // 069's reads and on the reads as 068 left them (053's source_thought,
  // 058's node_dependencies and 068's node_state, re-applied from their
  // files, then 069 again). The
  // budget, pre-registered: node_state(<40 ids>) at most 2 ms at 10,000 rows,
  // and at 100,000 at most 1.5 times that — the ids' cost, not the brain's.
  await stampTickets("completed", "started");
  await sql.unsafe(`INSERT INTO thought_sources (thought_id, system, identity, canonical, media_type, canonical_hash)
                    SELECT head_id, 'linear', issue, 'x', 'text/plain', encode(sha256('x'), 'hex') FROM ob1_ticket_head`);
  await sql.unsafe(`INSERT INTO thought_facets (thought_id, kind, payload)
                    SELECT s.thought_id, 'link', jsonb_build_object('relation', 'blocked_by', 'system', 'linear', 'target', 'B-' || (substr(s.identity, 3)::int + 1))
                      FROM thought_sources s WHERE substr(s.identity, 3)::int % 2 = 0`);
  await sql.unsafe("VACUUM ANALYZE");
  const [dep] = await sql`SELECT (SELECT count(*)::int FROM thought_sources) AS sources, (SELECT count(*)::int FROM thought_facets WHERE kind = 'link') AS links`;
  const [{ ids40 }] = await sql`SELECT array_agg(id)::text AS ids40 FROM (SELECT thought_id AS id FROM thought_sources ORDER BY md5(thought_id::text) LIMIT 40) x`;
  // The reads as 068 left them are timed once each, not as a median: on this
  // brain 053's resolver costs each unheld blocker a GIN scan, seconds a read
  // at 10,000 rows and minutes at 100,000.
  const once = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return performance.now() - t; };
  const depReads = async (timer: (fn: () => Promise<unknown>) => Promise<number>) => ({
    keyed: await timer(() => sql`SELECT * FROM node_state(${ids40}::uuid[])`),
    whole: await timer(() => sql`SELECT count(blockers) + count(unknown_blockers) + count(nullif(in_dependencies, false)) FROM node_state()`),
    deps: await timer(() => sql`SELECT count(*) FROM node_dependencies()`),
    rows: (await sql`SELECT md5(string_agg(x::text, '|' ORDER BY x::text)) AS h FROM node_state(${ids40}::uuid[]) x`)[0].h as string,
  });
  const keyedNow = await depReads(time);
  await applyMigrations(URL_, { dim: DIM, model: "stub-embed", trgm: true, only: (f) => f.startsWith("058_") || f.startsWith("068_") });
  // 053's resolver alone: its file redefines much that later files redefine again.
  const src053 = readFileSync(new URL(`./migrations/${migrationFiles().find((f) => f.startsWith("053_"))}`, import.meta.url), "utf8");
  const at053 = src053.indexOf("CREATE OR REPLACE FUNCTION source_thought(");
  await sql.unsafe(src053.slice(at053, src053.indexOf("\n$$;", at053) + 4));
  const keyedBefore = await depReads(once);
  await applyMigrations(URL_, { dim: DIM, model: "stub-embed", trgm: true, only: (f) => f.startsWith("069_") });
  const [{ blockedRows }] = await sql`SELECT count(*) FILTER (WHERE blockers IS NOT NULL)::int AS "blockedRows" FROM node_state(${ids40}::uuid[])`;
  keyedBudget.set(n, keyedNow.keyed);
  const keyedVerdict = n === 10000 ? `budget 2.00 ms: ${within(keyedNow.keyed <= 2)}`
    : keyedBudget.has(10000) ? `budget 1.5 × ${fmt(keyedBudget.get(10000)!)}: ${within(keyedNow.keyed <= 1.5 * keyedBudget.get(10000)!)}` : "no 10,000-row run to compare";
  console.log(`\n  node_state's dependency read (069), ${dep.sources.toLocaleString()} source rows and ${dep.links.toLocaleString()} links; 069 (median) vs the reads as 068 left them (once):\n`);
  console.log(`    node_state(<40 ids>), every column      ${fmt(keyedNow.keyed).padStart(9)} vs ${fmt(keyedBefore.keyed)}   (${blockedRows} of 40 blocked; ${keyedVerdict}; rows ${keyedNow.rows === keyedBefore.rows ? "identical" : "DIFFER"})`);
  console.log(`    node_state(), the dependency columns    ${fmt(keyedNow.whole).padStart(9)} vs ${fmt(keyedBefore.whole)}`);
  console.log(`    node_dependencies()                     ${fmt(keyedNow.deps).padStart(9)} vs ${fmt(keyedBefore.deps)}`);

  // What 069's triggers cost a writer, pre-registered: a plain capture at most
  // +0.03 ms, a status move on a sourced row between known and unknown at most
  // +0.2 ms, a source row's write at most +0.2 ms; the bulk stamp, moving 40%
  // of the rows between known and unknown, is printed against +20%. Off is the
  // four row-change triggers dropped, as 068's above; the mirror drifts while
  // they are, so it is rebuilt after, and a last triggered stamp tests them.
  const gateDefs = (await sql`SELECT tgname, tgrelid::regclass::text AS rel, pg_get_triggerdef(oid) AS def FROM pg_trigger
                               WHERE tgname IN ('thought_sources_node_gate_insert', 'thought_sources_node_gate_update', 'thought_sources_node_gate_delete', 'thoughts_node_source_gate_update')`) as { tgname: string; rel: string; def: string }[];
  if (gateDefs.length !== 4) throw new Error(`expected 069's four row-change triggers, found ${gateDefs.length}`);
  const gateTriggers = (on: boolean) => sql.unsafe(gateDefs.map((t) => `DROP TRIGGER IF EXISTS ${t.tgname} ON ${t.rel};${on ? ` ${t.def};` : ""}`).join(" "));
  const gateBlocks = async (call: () => Promise<unknown>) => {
    const on: number[] = [], off: number[] = [];
    for (let block = 0; block < 10; block++) {
      const enabled = block % 2 === 0;
      await gateTriggers(enabled);
      for (let i = 0; i < 20; i++) (enabled ? on : off).push(await timed(call));
    }
    await gateTriggers(true);
    return { on: median(on), off: median(off) };
  };
  const gateCapture = await gateBlocks(() => sql`SELECT upsert_thought(${`bench gate capture ${n} ${++captures}`}, '{"metadata":{}}'::jsonb)`);
  const sourced = (await sql`SELECT thought_id AS id FROM thought_sources ORDER BY thought_id LIMIT 200`).map((r: { id: string }) => r.id);
  let move = 0;
  const gateStatus = await gateBlocks(() => {
    const i = move++;
    return sql`UPDATE thoughts SET metadata = metadata || jsonb_build_object('status_type', ${i % 4 < 2 ? "weird" : "started"}::text) WHERE id = ${sourced[i % sourced.length]}`;
  });
  const unsourced = (await sql`SELECT id FROM thoughts t WHERE NOT EXISTS (SELECT 1 FROM thought_sources s WHERE s.thought_id = t.id) ORDER BY id LIMIT 200`).map((r: { id: string }) => r.id);
  let rec = 0;
  const gateSource = await gateBlocks(() => {
    const i = rec++;
    return sql`SELECT record_thought_source(${unsourced[i % unsourced.length]}::uuid, 'github', ${`W-${n}-${i}`}, 'x', 'text/plain', NULL, true)`;
  });
  const flipsOn: number[] = [], flipsOff: number[] = [];
  let flip = 0;
  for (const order of [[false, true], [true, false], [false, true]]) for (const on of order) {
    await gateTriggers(on);
    const k = ++flip;
    (on ? flipsOn : flipsOff).push(await timed(() => k % 2 ? stampTickets(`settled-${k}`, `live-${k}`) : stampTickets("completed", "started")));
  }
  await gateTriggers(true);
  await sql`SELECT * FROM ob1_rebuild_source_gate()`;
  await stampTickets("canceled", "unstarted");
  const [{ gateDrift }] = await sql`SELECT count(*)::int AS "gateDrift" FROM ob1_node_projection_drift()`;
  const flipOn = median(flipsOn), flipOff = median(flipsOff);
  console.log(`\n  069's triggers on a writer, against them dropped (medians; the bulk stamp three times each way):\n`);
  console.log(`    a plain upsert_thought                  ${fmt(gateCapture.on).padStart(9)} vs ${fmt(gateCapture.off)}   (+${fmt(gateCapture.on - gateCapture.off)}; budget 0.03 ms: ${within(gateCapture.on - gateCapture.off <= 0.03)})`);
  console.log(`    a sourced row's status, known↔unknown   ${fmt(gateStatus.on).padStart(9)} vs ${fmt(gateStatus.off)}   (+${fmt(gateStatus.on - gateStatus.off)}; budget 0.20 ms: ${within(gateStatus.on - gateStatus.off <= 0.2)})`);
  console.log(`    record_thought_source, a new row        ${fmt(gateSource.on).padStart(9)} vs ${fmt(gateSource.off)}   (+${fmt(gateSource.on - gateSource.off)}; budget 0.20 ms: ${within(gateSource.on - gateSource.off <= 0.2)})`);
  console.log(`    40% of the rows, known↔unknown          ${fmt(flipOn).padStart(9)} vs ${fmt(flipOff)}   (${flipOn >= flipOff ? "+" : ""}${((flipOn / flipOff - 1) * 100).toFixed(0)}%; against +20%: ${within(flipOn <= flipOff * 1.2)})`);
  console.log(`    drift() after a rebuild and a stamp     ${String(gateDrift).padStart(9)}${gateDrift === 0 ? "" : "  ← the triggers left the gate behind"}`);
  await sql.close();
}
console.log("");
