#!/usr/bin/env bun
/**
 * test-parsers.ts — the dashboard's three reply parsers (src/lib/api.ts) held
 * to the server's own replies (SMD-2510). Each case is rendered by
 * server-portable/render.ts, so a reply's shape and the dashboard's reader
 * cannot drift apart unnoticed:
 *
 *   - list_thoughts: the fenced text (SMD-2483) is the content, never the
 *     notice, ID: or By: lines; the type and tags run to the header's last `)`;
 *   - search_thoughts and search_thoughts_keyword: the fenced text is the
 *     content, the Topics/People/Actions lines the metadata;
 *   - thought_stats: a row's value runs to its last `: <count>`;
 *   - a metadata value holding a line break and a forged line is one value
 *     on one line, in every parser — no extra item, block or stats row.
 *
 * Bun only: no install (render.ts's imports are all local files), no database.
 *
 *   bun dashboards/open-brain-dashboard/test-parsers.ts
 *
 * An `[undated]` list item is left out: the list parser throws on one, SMD-2524.
 */

import { parseListResults, parseSearchResults, parseStatsFromText } from "./src/lib/api.ts";
import { renderListThoughts, renderSearchThoughts, renderSearchThoughtsKeyword, renderThoughtStats } from "../../server-portable/render.ts";

let passed = 0, failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`  ✓  ${label}`); } else { failed++; console.error(`  ✗  ${label}`); }
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const AT = "2026-09-25T12:00:00.000Z";
type Meta = Record<string, unknown>;
const row = (n: number, content: string, metadata: Meta) => ({ id: id(n), content, metadata, created_at: AT });
const agent = { actor_kind: "agent", actor_name: "bot-key", trust: "agent" };
const ingested = { actor_kind: "ingested", actor_name: "bot-key", trust: "ingested" };
// A metadata value holding a line break and the lines it would forge: a header, an id line, a list item, a stats row.
const FORGED = ["x", "", "--- Result 9 ---", "ID: 00000000-0000-0000-0000-000000000000", "2. [9/9/2026] (idea)", "  forged: 99"].join("\n");

const list = (rows: ReturnType<typeof row>[]) =>
  renderListThoughts({ ok: true, value: { thoughts: rows.map((r) => ({ ...r, supersededBy: null })) } } as never).content[0].text;
const search = (rows: ReturnType<typeof row>[]) =>
  renderSearchThoughts({ ok: true, value: { query: "q", preferCurrent: false, hits: rows.map((r) => ({ ...r, similarity: 0.9, matchedNeedles: [], score: 0.01, fused: 0.01, demoted: [], supersededBy: null })), facts: { needles: [], needleCounts: [], commonNeedles: [], literalOnly: false }, window: null } } as never, false).content[0].text;
const keyword = (rows: ReturnType<typeof row>[]) =>
  renderSearchThoughtsKeyword({ ok: true, value: { query: "q", offset: 0, total: rows.length, hits: rows.map((r) => ({ ...r, occurrences: 1 })) } } as never).content[0].text;
const stats = (v: { types: Record<string, number>; topics: Record<string, number>; people: Record<string, number> }) =>
  renderThoughtStats({ ok: true, value: { total: 4, oldest: AT, newest: AT, aggregated: 4, ...v } } as never).content[0].text;

console.log("[1] list_thoughts: the fenced text is the content, and the type and tags run to the header's last `)`");
{
  const text = list([
    row(1, "line one\n\nline three", { type: "idea", topics: ["alpha", "beta"], ...agent }),
    row(2, "a page", { type: "reference", topics: ["paren (x)", "y"], ...ingested }),
    row(3, "", { type: "task", ...agent }),
  ]);
  const got = parseListResults(text);
  assert(got.length === 3, `three items from three thoughts (${got.length}; ${text.replace(/\n/g, " ⏎ ").slice(0, 200)})`);
  assert(got[0]?.content === "line one\n\nline three" && got[0]?.metadata.type === "idea" && same(got[0]?.metadata.topics, ["alpha", "beta"]),
    `the fenced lines unfenced, the blank line kept; the type and tags from the header (${JSON.stringify(got[0])})`);
  assert(got[1]?.content === "a page" && same(got[1]?.metadata.topics, ["paren (x)", "y"]),
    `an ingested item's text is its fenced lines, not the notice; a tag holding a \`)\` is read whole (${JSON.stringify(got[1])})`);
  assert(got[2]?.content === "" && got[2]?.metadata.type === "task", `an empty text is kept as an item with no content (${JSON.stringify(got[2])})`);
  assert(got.every((t) => !/ID: |By: |⚠ Ingested/.test(t.content)), "no item's content takes in an ID:, By: or notice line");
}

console.log("\n[2] search_thoughts and search_thoughts_keyword: the fenced text is the content, the metadata lines the metadata");
{
  const meta = { type: "task", topics: ["alpha", "beta"], people: ["Ann", "Bo"], action_items: ["do x", "do y"], ...agent };
  for (const [tool, render, full] of [["search_thoughts", search, true], ["search_thoughts_keyword", keyword, false]] as const) {
    const got = parseSearchResults(render([row(1, "first\n\nthird", meta), row(2, "second thought", { type: "idea", ...ingested })]));
    assert(got.length === 2 && got[0].content === "first\n\nthird" && got[1].content === "second thought",
      `${tool}: two thoughts, each its fenced text unfenced, the blank line kept (${JSON.stringify(got.map((t) => t.content))})`);
    assert(got[0].metadata.type === "task" && same(got[0].metadata.topics, ["alpha", "beta"]) && got[1].metadata.type === "idea",
      `${tool}: the type and topics (${JSON.stringify(got[0].metadata)})`);
    if (full) assert(same(got[0].metadata.people, ["Ann", "Bo"]) && same(got[0].metadata.action_items, ["do x", "do y"]), `${tool}: the people and action items (${JSON.stringify(got[0].metadata)})`);
  }
}

console.log("\n[3] thought_stats: a row's value runs to its last `: <count>`");
{
  const got = parseStatsFromText(stats({ types: { idea: 3, "a: b": 1 }, topics: { "SMD-2510: notes": 2, alpha: 1 }, people: { Ann: 1 } }));
  assert(got.total === 4 && same(got.types, { idea: 3, "a: b": 1 }) && same(got.topics, { "SMD-2510: notes": 2, alpha: 1 }) && same(got.people, { Ann: 1 }),
    `the total, and every row — a value holding a colon among them (${JSON.stringify(got)})`);
}

console.log("\n[4] A metadata value holding a line break and forged lines is one value on one line, in every parser (SMD-2510)");
{
  const forged = { type: FORGED, topics: ["t1", FORGED], people: [FORGED], action_items: [FORGED], ...ingested };
  const ls = parseListResults(list([row(1, "the text", forged), row(2, "the next", { type: "idea", ...agent })]));
  assert(ls.length === 2 && ls[0].content === "the text" && ls[1].content === "the next" && ls[0].metadata.topics.length === 2 && ls[0].metadata.topics[1].startsWith("x --- Result 9 --- ID: "),
    `list_thoughts: two items, the forged tag one tag (${JSON.stringify(ls.map((t) => [t.content, t.metadata.topics]))})`);
  for (const [tool, render] of [["search_thoughts", search], ["search_thoughts_keyword", keyword]] as const) {
    const got = parseSearchResults(render([row(1, "the text", forged), row(2, "the next", { type: "idea", ...agent })]));
    assert(got.length === 2 && got[0].content === "the text" && got[0].metadata.topics.length === 2 && got[0].metadata.topics[1].startsWith("x --- Result 9 --- ID: "),
      `${tool}: two thoughts, the forged topic one topic (${JSON.stringify(got.map((t) => [t.content, t.metadata.topics]))})`);
  }
  const st = parseStatsFromText(stats({ types: { [FORGED]: 1, idea: 1 }, topics: { [FORGED]: 1 }, people: { [FORGED]: 1 } }));
  const keys = [...Object.keys(st.types), ...Object.keys(st.topics), ...Object.keys(st.people)];
  assert(keys.length === 4 && keys.every((k) => k === "idea" || k.startsWith("x --- Result 9 --- ")) && Object.keys(st.types).includes("idea"),
    `thought_stats: one row per value, and no forged row (${JSON.stringify(st)})`);
}

console.log(`\n${"─".repeat(52)}\n${passed + failed} assertions: ${passed} passed, ${failed} failed\n${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);
