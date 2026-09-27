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
 * ── prefer_current (059, SMD-2255; stored, 060 / SMD-2256) ───────────────────
 * The last blocks time search_thoughts_current against the hybrid on the same
 * rows, after stamping lifecycles and supersession onto them — interleaved,
 * the added cost the median of paired differences — against the budget the
 * flag was pre-registered with (at most the hybrid's own median at 10,000
 * rows); then what 060's triggers cost a writer, on against off.
 */

import { SQL } from "bun";
import { requireDatabaseUrl, resetSchema, seededRandom } from "./test-support.ts";

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

  // ── prefer_current (059, SMD-2255; stored, 060 / SMD-2256) ─────────────────
  // search_thoughts_current reads the hybrid at min(100, 4N) and node_state for
  // the window; since 060 node_state reads two stored tables by primary key
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
  const needleP = await paired(hybrid, () => sql`SELECT id FROM search_thoughts_current(${q}::vector, ${text}, 0.0, 10, '{}'::jsonb)`);
  const windowP = await paired(() => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${plain}, 0.5, 10, '{}'::jsonb)`,
                               () => sql`SELECT id FROM search_thoughts_hybrid(${q}::vector, ${plain}, 0.5, 40, '{}'::jsonb)`);
  // A read of the columns, not count(*): since 060 count(*) reads none, and
  // the planner drops every join (first review pass).
  const tState = await time(() => sql`SELECT count(open) + count(superseded_by) FROM node_state()`);
  const tStateAll = await time(() => sql`SELECT count(blockers) + count(open) + count(superseded_by) FROM node_state()`);
  const verdict = (p: { off: number; added: number }) => (n === 10000 ? `; budget ${fmt(p.off)}: ${p.added <= p.off ? "within" : "OVER"}` : "");
  console.log(`\n  prefer_current (059, stored since 060), ${st.settled.toLocaleString()} settled and ${st.superseded.toLocaleString()} superseded rows, ${ROUNDS} interleaved rounds:\n`);
  console.log(`    hybrid, no needle                       ${fmt(plainP.off).padStart(9)}`);
  console.log(`    search_thoughts_current, no needle      ${fmt(plainP.on).padStart(9)}   (+${fmt(plainP.added)}; paired +${fmt(plainP.pairedAdded)}${verdict(plainP)})`);
  console.log(`      of which the hybrid at the window (40) ${fmt(windowP.on).padStart(8)}   (+${fmt(windowP.added)}; paired +${fmt(windowP.pairedAdded)})`);
  console.log(`    hybrid, one needle                      ${fmt(needleP.off).padStart(9)}`);
  console.log(`    search_thoughts_current, one needle     ${fmt(needleP.on).padStart(9)}   (+${fmt(needleP.added)}; paired +${fmt(needleP.pairedAdded)}${verdict(needleP)})`);
  console.log(`      node_state()'s lifecycle and superseded_by, every thought ${fmt(tState)}`);
  console.log(`      node_state(), every column (the dependency read too)      ${fmt(tStateAll)}`);

  // What 060's triggers cost a writer, pre-registered: a plain capture at most
  // +0.1 ms, a ticket's status update at most +0.5 ms, a bulk stamp of 40% of
  // the rows at most +20%. Off is the three triggers disabled, in alternating
  // blocks; the rebuild after puts the projection back, and drift() must then
  // be empty.
  const projectionTriggers = (on: boolean) => sql.unsafe(["insert", "update", "delete"]
    .map((e) => `ALTER TABLE thoughts ${on ? "ENABLE" : "DISABLE"} TRIGGER thoughts_node_projection_${e}`).join("; "));
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
  // The bulk stamp, three times each way, alternating. An off run leaves the
  // projection behind the rows, so an untimed rebuild follows it: every on run
  // then moves the projection too, not only the rows (first review pass: the
  // on runs flipped back to what the tables already held, and wrote nothing
  // there).
  const stampsOn: number[] = [], stampsOff: number[] = [];
  for (let k = 0; k < 3; k++) {
    await projectionTriggers(false);
    stampsOff.push(await timed(() => stampTickets("canceled", "unstarted")));
    await projectionTriggers(true);
    await sql`SELECT * FROM ob1_rebuild_node_projection()`;
    stampsOn.push(await timed(() => stampTickets("completed", "started")));
  }
  await sql`SELECT * FROM ob1_rebuild_node_projection()`;
  const [{ drift }] = await sql`SELECT count(*)::int AS drift FROM ob1_node_projection_drift()`;
  const stampOn = median(stampsOn), tStampOff = median(stampsOff);
  const within = (ok: boolean) => (ok ? "within" : "OVER");
  console.log(`\n  060's triggers on a writer, on vs off (medians; the bulk stamp three times each way):\n`);
  console.log(`    a plain upsert_thought                  ${fmt(capture.on).padStart(9)} vs ${fmt(capture.off)}   (+${fmt(capture.on - capture.off)}; budget 0.10 ms: ${within(capture.on - capture.off <= 0.1)})`);
  console.log(`    a ticket's status update                ${fmt(statusUpdate.on).padStart(9)} vs ${fmt(statusUpdate.off)}   (+${fmt(statusUpdate.on - statusUpdate.off)}; budget 0.50 ms: ${within(statusUpdate.on - statusUpdate.off <= 0.5)})`);
  console.log(`    stamping 40% of the rows                ${fmt(stampOn).padStart(9)} vs ${fmt(tStampOff)}   (${stampOn >= tStampOff ? "+" : ""}${((stampOn / tStampOff - 1) * 100).toFixed(0)}%; budget +20%: ${within(stampOn <= tStampOff * 1.2)})`);
  console.log(`    drift() after the rebuild               ${String(drift).padStart(9)}${drift === 0 ? "" : "  ← the projection did not come back"}`);
  await sql.close();
}
console.log("");
