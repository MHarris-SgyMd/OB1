#!/usr/bin/env bun
/**
 * test-e2e-sql.ts — the whole server, over MCP, backed by SQL, against real Postgres.
 *
 * test-store-sql.ts proves the store's methods behave. This proves the thing that
 * actually matters for Phase 2: an MCP client calling the documented tools gets the
 * same answers with PostgREST removed entirely. It drives the real server through
 * real JSON-RPC, with OB1_STORE unset — the SQL store is the default (change
 * 97) and this suite is what proves it — and no Supabase anywhere.
 *
 * The embedding provider is stubbed — the point is the data layer, and hitting
 * OpenRouter would make the suite non-hermetic and cost money. Everything below
 * the tool boundary is real.
 *
 *   ../db/with-postgres.sh bun test-e2e-sql.ts
 */

import { SQL } from "bun";
import { createAssert, plantLegacyRow, resetSchema, runScript } from "../db/test-support.ts";
import { readdirSync } from "node:fs";
import { FORK_VERSION } from "../db/version.mjs";
import { join, dirname } from "node:path";
import { TOOL_NAMES } from "./tools.ts";
import { hashKey } from "./auth.ts";
import { fileURLToPath } from "node:url";

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-e2e-sql.ts");
  process.exit(2);
}

/**
 * db/migrations/*.sql are templates — migrate.ts substitutes these at apply time.
 * Applying them raw fails with `syntax error at or near "{"`.
 */
// Pinned, not inherited from the shipped defaults. This suite asserts the data
// layer, not the model choice, and reading the default meant the schema it built
// and the width the server expected drifted apart the moment the default changed.
const EMBEDDING_DIM = Number(process.env.OB1_EMBEDDING_DIM ?? 1536);
const EMBEDDING_MODEL = process.env.OB1_EMBEDDING_MODEL ?? "openai/text-embedding-3-small";
process.env.OB1_EMBEDDING_DIM = String(EMBEDDING_DIM);
process.env.OB1_EMBEDDING_MODEL = EMBEDDING_MODEL;
function subst(sql: string): string {
  return sql
    .replace(/\{\{EMBEDDING_DIM\}\}/g, String(EMBEDDING_DIM))
    .replace(/\{\{EMBEDDING_MODEL\}\}/g, EMBEDDING_MODEL);
}

const { assert, report } = createAssert();

// Fresh schema.
await resetSchema(URL_, { dim: EMBEDDING_DIM, model: EMBEDDING_MODEL });

// ── Stub only the model provider ─────────────────────────────────────────────
// A deterministic embedding keyed off the text, so search ordering is predictable.
const KNOWN: Record<string, number> = { alpha: 0, beta: 1, gamma: 2 };
function axisFor(text: string): number {
  const key = Object.keys(KNOWN).find((k) => text.toLowerCase().includes(k));
  return key ? KNOWN[key] : 3;
}
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith(STUB_BASE)) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/embeddings")) {
      const v = new Array(EMBEDDING_DIM).fill(0);
      v[axisFor(String(body.input))] = 1;
      return new Response(JSON.stringify({ data: [{ embedding: v }] }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ topics: ["stubbed"], type: "idea" }) } }] }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

// ── Boot the real server with the SQL store ──────────────────────────────────
// A provider host this suite owns, so the stub matches on something it controls
// rather than on whatever the shipped default happens to be. Matching the literal
// "openrouter.ai" meant the stub stopped intercepting the moment the default base
// URL moved to Ollama, and the test hit the real provider.
const STUB_BASE = "https://stub.invalid/v1";
process.env.OB1_LLM_BASE_URL = STUB_BASE;
// Declared local to the egress gate (SMD-1903): the stub is on this box, and
// the gate reads the flag, never the address — without it the default, deny,
// refuses every call to it. test-egress.ts holds that case.
process.env.OB1_LLM_LOCAL = "1";

// OB1_STORE is UNSET on purpose (change 97, SMD-1797): the SQL store is the
// default, and this suite — the whole server over MCP against real Postgres —
// is what proves it. Setting it here would let the default drift back to
// PostgREST with every test still green.
delete process.env.OB1_STORE;
process.env.DATABASE_URL = URL_;
process.env.OPENROUTER_API_KEY = "stub";
process.env.MCP_ACCESS_KEY = "e2e-key";
// Beside the legacy write key, a capture-only key (SMD-1298) for [13]: the
// scope a session-end hook holds. Both forms configured at once, as test-auth
// [6] proves they may be.
const CAPTURE_KEY = "hook-" + "c".repeat(59);
// A second capture key for the case where the agent registry is away.
const CAPTURE_KEY_2 = "hook-" + "d".repeat(59);
// Two named write keys beside them (SMD-1726, [10c]): the server's actor is the
// key's name, and migration 050 stamps who wrote a thought from it.
// And more write keys than the pool has connections, none used before [14]'s
// registry lock (SMD-2072): each is a cold key there.
const COLD_KEYS = Array.from({ length: 12 }, (_, i) => `cold-${String(i + 1).padStart(2, "0")}`);
const KEYS_AT_BOOT = `session-hook:capture:${hashKey(CAPTURE_KEY)},hook-two:capture:${hashKey(CAPTURE_KEY_2)},op-key:write:${hashKey("op-raw")},bot-key:write:${hashKey("bot-raw")},${COLD_KEYS.map((k) => `${k}:write:${hashKey(k + "-raw")}`).join(",")}`;
process.env.MCP_ACCESS_KEYS = KEYS_AT_BOOT;
// No registry cache: [13] takes resolve_agent away and brings it back, and a
// principal's agent id must follow at once.
process.env.OB1_AGENT_CACHE_TTL_MS = "0";
// The query log (034, SMD-1295) is read once at first request and frozen, as in
// production (set at boot, not toggled per request). On for the whole suite so
// [N] can exercise the real write+join path; the OFF guarantee — that the guard
// writes nothing when unset — is a pure unit test in test-server.ts.
process.env.OB1_QUERY_LOG = "on";
// A named tier so [10b] can prove the server stamps query_log.tier from OB1_TIER
// (SMD-1806). Frozen at boot with the rest; every row this suite writes is
// 'canary'. No other section asserts tier, so the value is free to set here.
process.env.OB1_TIER = "canary";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const H = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "x-brain-key": "e2e-key",
};

let rpcId = 1;
async function call(name: string, args: Record<string, unknown> = {}, key = "e2e-key"): Promise<string> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { ...H, "x-brain-key": key },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const body = JSON.parse(line);
  if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
  const content = body.result?.content ?? [];
  const joined = content.map((c: { text?: string }) => c.text ?? "").join("\n");
  if (body.result?.isError) throw new Error(`tool error: ${joined}`);
  return joined;
}

console.log(`  store: OB1_STORE unset (sql, the default), SUPABASE_URL unset\n`);

console.log("[1] The server runs with no Supabase configuration at all");
{
  assert(process.env.SUPABASE_URL === undefined, "SUPABASE_URL is not set");
  assert(process.env.OB1_STORE === undefined, "OB1_STORE is not set — the default store is what every section below drives");
  const r = await fetch(BASE, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} }),
  });
  const t = await r.text();
  const b = JSON.parse(t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6));
  assert(b.result?.tools?.length === TOOL_NAMES.length, `all ${TOOL_NAMES.length} tools still registered (${b.result?.tools?.length})`);
}

console.log("\n[2] capture_thought writes through SQL");
{
  const out = await call("capture_thought", { content: "alpha thought about migrations" });
  assert(/Captured as/.test(out), `capture reports success (${out.split("\n")[0].slice(0, 50)}…)`);
  assert(!/NOT appear in semantic search/.test(out), "no degraded-write warning");

  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT content, metadata, embedding IS NOT NULL AS has, embedding_model AS m FROM thoughts`;
  assert(row.content === "alpha thought about migrations", "the row is in Postgres");
  assert(row.has === true, "the embedding was stored in the same write");
  assert(row.m === EMBEDDING_MODEL, `…labelled with the model the server embedded with (${row.m})`);
  assert(row.metadata?.source === "mcp", `metadata survived the jsonb binding (${JSON.stringify(row.metadata)})`);
  assert(row.metadata?.type === "idea", "…including the extracted fields");
  await sql.close();
}

console.log("\n[3] search_thoughts ranks over real pgvector");
{
  await call("capture_thought", { content: "beta thought about databases" });
  await call("capture_thought", { content: "gamma thought about runtimes" });

  const out = await call("search_thoughts", { query: "alpha", limit: 5, threshold: 0.5 });
  assert(/Found \d+ thought/.test(out), "search returns a result block");
  assert(/alpha thought about migrations/.test(out), "the matching thought is present");
  assert(/100\.0% match/.test(out), "the exact match scores 100%");
  assert(!/beta thought/.test(out), "an orthogonal thought is excluded by the threshold");

  // Migration 020 over MCP: `recency_weight` reaches the function. Age the
  // alpha thought two years; at weight 1 and no threshold the newest thought
  // leads and the alpha row, wherever it lands, still shows its raw similarity.
  const sql = new SQL({ url: URL_, max: 1 });
  await sql`UPDATE thoughts SET created_at = now() - interval '2 years' WHERE content LIKE 'alpha%'`;
  const dated = await call("search_thoughts", { query: "alpha", limit: 5, threshold: -1, recency_weight: 1 });
  const first = dated.split("--- Result ")[1] ?? "";
  assert(!/alpha thought about migrations/.test(first), `at recency_weight 1 the two-year-old exact match is not first (${first.split("\n")[0]})`);
  // The block that holds the alpha row, and its own header line: the first
  // draft's regex accepted any "100.0% match" anywhere in the output (first
  // review pass), which a formatter printing the blended score would satisfy.
  const alphaBlock = dated.split("--- Result ").find((b) => /alpha thought about migrations/.test(b)) ?? "";
  assert(/^\d+ \(100\.0% match\) ---/.test(alphaBlock), `…and its own header still reads 100.0% match — the blend orders, the similarity shown is the cosine (${alphaBlock.split("\n")[0]})`);
  const unweighted = await call("search_thoughts", { query: "alpha", limit: 5, threshold: -1 });
  const firstUnweighted = unweighted.split("--- Result ")[1] ?? "";
  assert(/^1 \(100\.0% match\) ---/.test(firstUnweighted) && /alpha thought about migrations/.test(firstUnweighted), "without a weight the exact match is first again — the default is the ranking by meaning alone");
  await sql`UPDATE thoughts SET created_at = now() WHERE content LIKE 'alpha%'`;
  await sql.close();
}

console.log("\n[3b] search_thoughts_keyword finds what the embedding cannot");
{
  // The whole argument for SMD-944, run end to end over MCP against real
  // pgvector: a token that differs from its neighbour by one trailing character.
  // The stub provider embeds by keyword, so "alpha" and "alphanumeric" are not
  // meaningfully separable to it — which is exactly the situation with a real
  // model and an error code.
  await call("capture_thought", { content: "delta thought mentioning PGRST202 exactly once" });
  await call("capture_thought", { content: "epsilon thought mentioning PGRST2020 twice: PGRST2020" });

  // The same query through search_thoughts, which is hybrid since 017. The stub
  // embeds "PGRST202" on the same axis as everything that is not alpha/beta/
  // gamma, so the vector arm cannot tell delta from epsilon, or either from the
  // other axis-3 thoughts — and both rows containing the literal come first,
  // each saying why. Both, not one: the needle rule takes the token, so the
  // trailing space that makes search_thoughts_keyword exclude PGRST2020 is not
  // available here. That boundary case is what the exact tool is still for,
  // and its description says so.
  const fused = await call("search_thoughts", { query: "PGRST202 ", limit: 5, threshold: 0.5 });
  assert(/Searched exactly for: PGRST202/.test(fused.split("\n")[0]), `search_thoughts names the literal it searched for (${fused.split("\n")[0]})`);
  assert(!/No thought contains/.test(fused.split("\n")[0]), "…and does not report it absent, since two rows contain it");
  assert(/only literals/.test(fused.split("\n")[0]), "…and says the query was only a literal");
  const blocks = fused.split("--- Result ").slice(1);
  assert(blocks.length >= 2 && blocks.slice(0, 2).every((b) => /\nContains: PGRST202\n/.test(b)), "results 1 and 2 are the two rows containing the literal, each with a Contains line");
  assert(blocks.slice(0, 2).some((b) => /delta thought/.test(b)) && blocks.slice(0, 2).some((b) => /epsilon thought/.test(b)), "…delta and epsilon, in either order");
  assert(!blocks.slice(2).some((b) => /Contains:/.test(b)), "…and nothing after them claims a match");
  // …and the mixed form, where the vector arm has a vote too.
  const mixed = await call("search_thoughts", { query: "the alpha migration and PGRST202", limit: 5, threshold: 0.0 });
  assert(!/only literals/.test(mixed.split("\n")[0]) && /Searched exactly for: PGRST202/.test(mixed.split("\n")[0]), "a query with words left is not literal-only");
  // A literal no thought contains is reported as searched for and absent —
  // not as matched, which the first version's header implied.
  const miss = await call("search_thoughts", { query: "the alpha migration and ZZQX_404", limit: 5, threshold: 0.0 });
  assert(/Searched exactly for: ZZQX_404\. No thought contains: ZZQX_404\./.test(miss.split("\n")[0]), `a zero-hit literal is reported as absent (${miss.split("\n")[0]})`);
  assert(!/Contains:/.test(miss), "…and no row claims it");
  const missAlone = await call("search_thoughts", { query: "ZZQX_404", limit: 5, threshold: 0.0 });
  assert(/only literals and no thought contains them/.test(missAlone.split("\n")[0]), "a literal-only query with no hits says the results are by similarity alone");
  // With nothing above the threshold either, the empty answer still says why.
  // Threshold 1.0: the stub puts every non-alpha/beta/gamma text on one axis,
  // so the literal's embedding is identical to several thoughts', and only the
  // strict comparison at 1.0 excludes them all.
  const nothing = await call("search_thoughts", { query: "ZZQX_404", limit: 5, threshold: 1.0 });
  assert(/^No thoughts found matching "ZZQX_404"\. No thought contains: ZZQX_404\./.test(nothing), `an empty result still reports the absent literal (${nothing.slice(0, 90)})`);
  // Truncation is reported as such, not as absence: two literals in two
  // different rows, room for one row — the losing literal's hit is outside the
  // page, and the header says so with its count rather than "no thought
  // contains" (review pass).
  await call("capture_thought", { content: "zeta thought mentioning PGRST_ZZ once" });
  const cut = await call("search_thoughts", { query: "PGRST_ZZ PGRST2020", limit: 1, threshold: 0.0 });
  assert(/Outside the top 1: PGRST(2020|_ZZ) \(in 1 thought\)/.test(cut.split("\n")[0]), `a literal whose hit fell outside the page is reported with its count, not as absent (${cut.split("\n")[0]})`);
  assert(!/No thought contains/.test(cut.split("\n")[0]), "…and not as absent");
  // The compat pair reaches the same function: an identifier ChatGPT's `search`
  // could never find before 017 is now at the top of its results.
  const compat = JSON.parse(await call("search", { query: "PGRST202" }));
  assert(compat.results.length >= 2 && compat.results.slice(0, 2).every((r: { title: string }) => /PGRST202/.test(r.title)), `search (compat) returns the exact hits first (${compat.results.map((r: { title: string }) => r.title.slice(11, 40)).join(" | ")})`);

  const out = await call("search_thoughts_keyword", { query: "PGRST202 " });
  assert(/Showing 1-1 of 1/.test(out), `the header states the whole match set (${out.split("\n")[0]})`);
  assert(/delta thought mentioning PGRST202/.test(out), "the exact row is returned");
  assert(!/epsilon/.test(out), "…and the one-character-longer token is not");
  assert(/1 occurrence\b/.test(out), "occurrences are reported, singular");

  const twice = await call("search_thoughts_keyword", { query: "PGRST2020" });
  assert(/2 occurrences/.test(twice), "a repeated needle is counted");

  // No match is an answer, not an error, and the message points at the other tool.
  const none = await call("search_thoughts_keyword", { query: "zylotrope" });
  assert(/No thoughts contain/.test(none), "a miss is a plain answer");
  assert(/search_thoughts for a match by meaning/.test(none), "…that names the tool to try instead");

  // The whitespace hint, which exists because the needle is deliberately not
  // trimmed. Without it a pasted string with a stray space fails invisibly.
  const padded = await call("search_thoughts_keyword", { query: " zylotrope " });
  assert(/leading or trailing whitespace/.test(padded), "a padded miss says the whitespace was matched literally");

  // Paging, over the tool surface rather than the function.
  const page1 = await call("search_thoughts_keyword", { query: "thought", limit: 2, offset: 0 });
  assert(/Showing 1-2 of \d+/.test(page1), `page one is labelled by position (${page1.split("\n")[0]})`);
  assert(/offset=2 for the next page/.test(page1), "…and says how to get the next one");
  const page2 = await call("search_thoughts_keyword", { query: "thought", limit: 2, offset: 2 });
  assert(/Showing 3-4 of \d+/.test(page2), `page two continues the numbering (${page2.split("\n")[0]})`);

  const empty = await call("search_thoughts_keyword", { query: "" });
  assert(/Empty query/.test(empty), "an empty query is told apart from a miss");

  // Bounds are enforced at the MCP boundary rather than silently clamped, so a
  // caller learns its argument was wrong. A negative offset used to render
  // "Result -4", because the numbering is arithmetic on the value passed in.
  for (const [args, what] of [
    [{ query: "thought", offset: -5 }, "a negative offset"],
    [{ query: "thought", limit: 500 }, "an over-large limit"],
    [{ query: "thought", limit: 2.5 }, "a fractional limit"],
  ] as [Record<string, unknown>, string][]) {
    let rejected = false;
    try { await call("search_thoughts_keyword", args); } catch { rejected = true; }
    assert(rejected, `${what} is refused at the tool boundary, not clamped in silence`);
  }

  // Clean up after itself. [5], [6] and [7] assert exact corpus counts, so a
  // section that leaves two extra rows behind fails three later sections for a
  // reason that has nothing to do with them.
  const cleanup = new SQL({ url: URL_, max: 1 });
  await cleanup`DELETE FROM thoughts WHERE content LIKE '%thought mentioning PGRST%'`;
  await cleanup.close();
}

console.log("\n[4] search + fetch, the ChatGPT-compatible pair");
{
  const found = JSON.parse(await call("search", { query: "beta" }));
  assert(Array.isArray(found.results) && found.results.length > 0, "search returns a results array");
  const id = found.results[0].id;
  assert(/^[0-9a-f-]{36}$/.test(id), `…with a uuid id (${id.slice(0, 8)}…)`);

  const doc = JSON.parse(await call("fetch", { id }));
  assert(doc.id === id, "fetch round-trips the id");
  assert(/beta thought/.test(doc.text), "fetch returns the full text");
  assert(typeof doc.metadata?.created_at === "string", "fetch includes created_at metadata");

  let missingHandled = false;
  try {
    await call("fetch", { id: "11111111-2222-3333-4444-555555555555" });
  } catch (e) {
    missingHandled = /no thought with id/.test((e as Error).message);
  }
  assert(missingHandled, "fetching an absent id is a clean error, not a crash");
}

console.log("\n[5] list_thoughts filters");
{
  const all = await call("list_thoughts", { limit: 10 });
  assert(/3 recent thought/.test(all), `lists all three (${all.split("\n")[0]})`);

  const byType = await call("list_thoughts", { limit: 10, type: "idea" });
  assert(/3 recent thought/.test(byType), "type filter matches the stubbed metadata");

  const byTopic = await call("list_thoughts", { limit: 10, topic: "stubbed" });
  assert(/3 recent thought/.test(byTopic), "topic filter matches inside the array");

  const none = await call("list_thoughts", { limit: 10, topic: "absent-topic" });
  assert(/No thoughts found/.test(none), "an unmatched filter says so");

  const windowed = await call("list_thoughts", { limit: 10, days: 1 });
  assert(/3 recent thought/.test(windowed), "days window includes today");
}

console.log("\n[6] thought_stats aggregates the whole corpus");
{
  const out = await call("thought_stats");
  assert(/Total thoughts: 3/.test(out), `total is exact (${out.split("\n")[0]})`);
  assert(/Types:/.test(out) && /idea: 3/.test(out), "type tally is present and correct");
  assert(/stubbed: 3/.test(out), "topic tally is present");
  assert(!/Note: breakdowns below cover/.test(out), "no truncation note below the cap");
  assert(/Date range:/.test(out), "date range is reported");
}

console.log("\n[7] Dedup through the tool surface");
{
  const before = await call("thought_stats");
  await call("capture_thought", { content: "  ALPHA THOUGHT ABOUT MIGRATIONS  " });
  const after = await call("thought_stats");
  assert(/Total thoughts: 3/.test(after), "a normalised duplicate did not add a row");
  assert(before.split("\n")[0] === after.split("\n")[0], "the total is unchanged");

  // 035: a re-capture writes no provenance, and the reply says what stands —
  // read from the row's pointer the store returns beside `existed`, not from
  // the caller's inputs (the second review pass drove the four `supersedes` shapes and
  // found the input-only reply advising a redundant or a refused edit).
  const idOf = (out: string) => out.match(/— id ([0-9a-f-]{36})/)?.[1] ?? "";
  const alpha = idOf(await call("capture_thought", { content: "alpha thought about migrations" }));
  const beta = idOf(await call("capture_thought", { content: "beta thought about databases" }));
  const gamma = idOf(await call("capture_thought", { content: "gamma thought about runtimes" }));
  assert(alpha && beta && gamma && alpha !== beta, "the three ids read back from the replies");
  const none = await call("capture_thought", { content: "  ALPHA THOUGHT ABOUT MIGRATIONS  ", supersedes: beta });
  assert(new RegExp(`Note: this text was already captured as ${alpha}, so the \`supersedes\` given here was not written — a re-capture leaves an existing thought's provenance as it is\\. To record that it supersedes ${beta}, call update_thought with id ${alpha} and \`supersedes\` ${beta}; it records the pointer if that thought exists and closes no loop\\.`).test(none),
         `a re-capture naming supersedes over a thought with no pointer: not written, and the reply names the edit that records it (${none.split("Note:")[1]?.slice(0, 80)})`);
  assert(/now supersedes/.test(await call("update_thought", { id: alpha, supersedes: beta })), "…which, followed, works");
  const same = await call("capture_thought", { content: "alpha thought about migrations", supersedes: beta });
  assert(new RegExp(`It already supersedes ${beta}; there is nothing to record\\.`).test(same) && !/call update_thought/.test(same), "…re-captured naming the pointer it holds: the reply says so and advises no edit");
  const upper = await call("capture_thought", { content: "alpha thought about migrations", supersedes: beta.toUpperCase() });
  assert(new RegExp(`It already supersedes ${beta}; there is nothing to record\\.`).test(upper) && !/call update_thought/.test(upper), "…the same pointer in upper case is the same pointer (compared and printed lower-case)");
  const other = await call("capture_thought", { content: "alpha thought about migrations", supersedes: gamma });
  assert(new RegExp(`It currently supersedes ${beta}; to replace that pointer with ${gamma}, call update_thought with id ${alpha} and \`supersedes\` ${gamma}; it records the pointer if that thought exists and closes no loop\\.`).test(other), "…naming another: the reply says what it holds and that the edit would replace it");
  // The advice's two conditions, driven: a pointer that would close a loop
  // (gamma supersedes alpha; alpha re-captured naming gamma) is advised with
  // the condition and refused by the edit; a first capture naming no thought
  // is 025's FK, said in the tool's words.
  await call("update_thought", { id: gamma, supersedes: alpha });
  const loopy = await call("capture_thought", { content: "alpha thought about migrations", supersedes: gamma });
  assert(/closes no loop\./.test(loopy), "…a pointer that would close a loop is advised with the condition spelled out");
  let refused = "";
  try { await call("update_thought", { id: alpha, supersedes: gamma }); } catch (e) { refused = (e as Error).message; }
  assert(/would close a loop/.test(refused), `…and the edit refuses it by name (${refused.slice(0, 60)})`);
  await call("update_thought", { id: gamma, supersedes: null });
  try { await call("capture_thought", { content: "iota thought naming a ghost", supersedes: "00000000-0000-0000-0000-000000000000" }); } catch (e) { refused = (e as Error).message; }
  assert(/Refused: no thought with the id given as supersedes/.test(refused), `a first capture naming no thought is refused in the tool's words, not Postgres's (${refused.slice(0, 60)})`);
  try { await call("capture_thought", { content: "iota thought naming a bad source", derived_from: ["abc"] }); } catch (e) { refused = (e as Error).message; }
  assert(/Refused: every `derived_from` entry must be a thought id/.test(refused), `a derived_from element that is no id is refused before the model calls (${refused.slice(0, 60)})`);
  try { await call("capture_thought", { content: "iota thought naming a ghost source", derived_from: ["00000000-0000-0000-0000-000000000000"] }); } catch (e) { refused = (e as Error).message; }
  assert(/Refused: derived_from\[0\] \(00000000-0000-0000-0000-000000000000\) names no thought\./.test(refused), `a well-formed derived_from id naming no thought is refused in the tool's words too, by position, the id beside it for a key that reads (${refused.slice(0, 90)})`);
  assert(!/Note: this text was already captured/.test(await call("capture_thought", { content: "alpha thought about migrations", derived_from: [] })), "an empty derived_from names nothing, and no note fires for it");
  const self = await call("capture_thought", { content: "alpha thought about migrations", supersedes: alpha });
  assert(/names the thought itself; a thought cannot supersede itself\./.test(self) && !/call update_thought/.test(self), "…naming itself: refused in words, no edit advised");
  const derived = await call("capture_thought", { content: "alpha thought about migrations", derived_from: [beta] });
  assert(/the `derived_from` given here was not written/.test(derived) && /`derived_from` cannot be set on an existing thought through these tools\./.test(derived) && !/supersedes/.test(derived.split("Note:")[1] ?? ""), "…derived_from alone: told it cannot be set here, nothing about supersedes");
  const fresh = await call("capture_thought", { content: "theta thought that is new", supersedes: beta });
  assert(!/Note: this text was already captured/.test(fresh), "a first capture naming supersedes carries no such note");
  await call("update_thought", { id: alpha, supersedes: null });
  await call("delete_thought", { id: idOf(fresh) });
}

console.log("\n[8] the id a read prints round-trips to update_thought and delete_thought");
{
  // The whole point of emitting the id: a caller who found a thought through a
  // read tool — not by capturing it in this session — can now edit and delete
  // it. Neither walk below could be written before the id was in the prose; it
  // meant reaching for the ChatGPT-compat `search` tool instead. SMD-1248.
  // "kappa" is off the stub's alpha/beta/gamma axes and unique in the corpus, so
  // the row is found by its content, not by where it happens to rank.
  await call("capture_thought", { content: "kappa thought awaiting a correction" });

  // search_thoughts → update_thought, aimed at the id search returned. The id is
  // in the result's header block (as search_thoughts_keyword renders it), so pull
  // it from the block that holds the captured text.
  const found = await call("search_thoughts", { query: "kappa awaiting correction", limit: 20, threshold: -1 });
  const sBlock = found.split("--- Result ").find((b) => /kappa thought awaiting a correction/.test(b)) ?? "";
  const sMatch = sBlock.match(/\nID: ([0-9a-f-]{36})/);
  assert(sMatch, "search_thoughts prints an ID line for its hit");
  const sid = sMatch![1];

  await call("update_thought", { id: sid, content: "kappa thought now corrected" });
  const edited = await call("search_thoughts", { query: "kappa corrected", limit: 20, threshold: -1 });
  assert(/kappa thought now corrected/.test(edited), "the edit aimed at the searched id took");
  assert(!/awaiting a correction/.test(edited), "…and the pre-edit text is gone");

  // list_thoughts → delete_thought, the same reach through the other read tool.
  const listed = await call("list_thoughts", { limit: 20 });
  const lMatch = listed.match(/kappa thought now corrected\n\s*ID: ([0-9a-f-]{36})/);
  assert(lMatch, "list_thoughts prints an ID line under its item");
  const lid = lMatch![1];
  assert(lid === sid, "…and it is the same id search returned for the same thought");

  await call("delete_thought", { id: lid });
  const gone = await call("list_thoughts", { limit: 20 });
  assert(!/kappa/.test(gone), "the thought reached through list_thoughts is deleted");
}

console.log("\n[9] list_supersession_proposals renders the queue for a client: both thoughts, the ids, the commands, an edit since judged, and nothing a thought can do to the terminal (migration 029)");
{
  // Seeded through SQL: the pass's own write, with a thought whose text
  // carries an escape sequence and a judge reason that does too.
  const sql = new SQL({ url: URL_, max: 1 });
  const vec = `[${new Array(EMBEDDING_DIM).fill(0).map((_, i) => (i === 3 ? 1 : 0)).join(",")}]`;
  const seed = async (content: string, daysAgo: number) => {
    const id = ((await sql`SELECT upsert_thought(${content}, ${{ metadata: {} }}::jsonb, ${vec}::vector) AS r`)[0].r as { id: string }).id;
    await sql`UPDATE thoughts SET created_at = now() - make_interval(days => ${daysAgo}) WHERE id = ${id}::uuid`;
    return id;
  };
  const older = await seed("queue older: the plan was A \x1b[2A\x1b[2Kforged line", 9);
  const newer = await seed("queue newer: the plan is B", 0);
  const [{ id: pid }] = await sql`
    SELECT record_supersession_proposal(${older}::uuid, ${newer}::uuid, 'conflict_undirected', 0.7, ${"A then B \x1b[31mred"}, 0.9, 'consolidate:stub@p2', NULL) AS id`;
  const listed = await call("list_supersession_proposals", {});
  assert(/1 pending supersession proposal/.test(listed) && /conflict, direction not stated/.test(listed), "the tool lists the pending proposal with its verdict phrase");
  assert(listed.includes(`ID: ${older}`) && listed.includes(`ID: ${newer}`) && listed.includes(`--accept ${pid} --direction <newer|older>`) && listed.includes(`--reject ${pid}`),
         "…both ids, and the accept command with the direction placeholder the shell cannot parse");
  assert(!listed.includes("\x1b") && /forged line/.test(listed) && /A then B/.test(listed), "…with the escape sequences stripped from the thought and the reason, the words kept");
  assert(!/edited since judged/.test(listed), "…and nothing marked edited yet");
  await sql`SELECT update_thought(${newer}::uuid, ${"queue newer: the plan is B, revised"}, NULL::jsonb, NULL::vector, NULL::jsonb, NULL::timestamptz, NULL::jsonb, NULL::text)`;
  const edited = await call("list_supersession_proposals", { status: "pending", limit: 5 });
  assert(/newer \[[^\]]+\] \(edited since judged\)/.test(edited) && edited.includes(`--accept ${pid} --direction <newer|older> --force`) && /verdict is about an earlier text/.test(edited),
         "after an edit the tool marks the side, adds --force to the accept command and says why");
  assert(/No accepted supersession proposals/.test(await call("list_supersession_proposals", { status: "accepted" })), "an empty status says so and names the pass that fills it");
  await sql`DELETE FROM supersession_proposals`;
  await sql`DELETE FROM thoughts WHERE id IN (${older}::uuid, ${newer}::uuid)`;
  await sql.close();
}

// ── The opt-in query log (034, SMD-1295), through the real handlers ──────────
// The flag is on for the suite (set at boot). A search records one row with the
// query and the ids it returned; a fetch of a returned id records an action row
// the export join ties back to that search.
console.log("\n[10] query log: a search and its follow-up fetch, recorded and joined (SMD-1295)");
{
  const qlog = new SQL({ url: URL_, max: 1 });
  await qlog`DELETE FROM query_log`;

  await call("capture_thought", { content: "gamma note the query log should find" });
  const searched = await call("search_thoughts", { query: "gamma", limit: 5, threshold: -1 });
  const hitId = searched.match(/ID:\s*([0-9a-f-]{36})/i)?.[1];
  assert(!!hitId, `search returned an id to follow (${searched.split("\n")[0].slice(0, 40)}…)`);
  await call("fetch", { id: hitId! });

  const rows = await qlog<{ kind: string; tool: string; query: string | null; target_id: string | null; contains: boolean | null }[]>`
    SELECT kind, tool, query, target_id,
           CASE WHEN kind='search' THEN result_ids @> ARRAY[${hitId}::uuid] END AS contains
      FROM query_log ORDER BY logged_at, kind`;
  const searchRow = rows.find((r) => r.kind === "search");
  const actionRow = rows.find((r) => r.kind === "action");
  assert(searchRow?.tool === "search_thoughts" && searchRow.query === "gamma" && searchRow.contains === true,
    `the search row carries the query and the returned id (${JSON.stringify(searchRow)})`);
  assert(actionRow?.tool === "fetch" && actionRow.target_id === hitId,
    `the fetch of the returned id is recorded as an action (${JSON.stringify(actionRow)})`);

  // The export join links the action to the search that returned its id.
  const joined = await qlog<{ from_query: string | null }[]>`
    SELECT (SELECT s.query FROM query_log s
             WHERE s.kind='search' AND s.agent_id IS NOT DISTINCT FROM act.agent_id
               AND s.logged_at <= act.logged_at AND s.result_ids @> ARRAY[act.target_id]
             ORDER BY s.logged_at DESC LIMIT 1) AS from_query
      FROM query_log act WHERE act.kind='action'`;
  assert(joined[0]?.from_query === "gamma", `the export join ties the fetch back to its search (${JSON.stringify(joined[0])})`);

  // SMD-1719: a capture that cites the returned id — derived_from — is the
  // caller USING the result in a write, and is logged as an action row with
  // tool `capture_thought/derived_from` and the cited id as target, one per id
  // named. A capture that cites nothing writes no action row. The same join
  // attributes the cite to the search that returned the id, so
  // eval-utilization.ts can count it as "cited" beside the fetch's "opened".
  const built = await call("capture_thought", { content: "a note built on the gamma note", derived_from: [hitId!] });
  const builtId = built.match(/id ([0-9a-f-]{36})/)?.[1];
  await call("capture_thought", { content: "an unrelated note that cites nothing" });
  const cites = await qlog<{ tool: string; target_id: string }[]>`
    SELECT tool, target_id FROM query_log WHERE kind = 'action' AND tool LIKE '%/%'`;
  assert(cites.length === 1 && cites[0].tool === "capture_thought/derived_from" && cites[0].target_id === hitId,
    `the citing capture logged one action row for the id it named, under <writer>/<pointer> (${JSON.stringify(cites)})`);
  let actionCount = (await qlog<{ n: number }[]>`SELECT count(*)::int AS n FROM query_log WHERE kind = 'action'`)[0].n;
  assert(actionCount === 2, `the non-citing capture logged nothing: fetch + cite = 2 action rows (${actionCount})`);
  const citeJoined = await qlog<{ from_query: string | null }[]>`
    SELECT (SELECT s.query FROM query_log s
             WHERE s.kind='search' AND s.agent_id IS NOT DISTINCT FROM act.agent_id
               AND s.logged_at <= act.logged_at AND s.result_ids @> ARRAY[act.target_id]
             ORDER BY s.logged_at DESC LIMIT 1) AS from_query
      FROM query_log act WHERE act.kind='action' AND act.tool = 'capture_thought/derived_from'`;
  assert(citeJoined[0]?.from_query === "gamma", `the cite attributes to the search that returned the id (${JSON.stringify(citeJoined[0])})`);

  // A cite row is a pointer the database ACCEPTED. A re-capture of existing
  // text writes no pointer (035) and validated none, so it logs no cite even
  // when it names one — the reply's note sends the caller to update_thought,
  // and THAT edit, which writes the pointer, logs the cite under its own
  // writer: `update_thought/supersedes` for the superseded id, beside the
  // plain `update_thought` row for the edited id.
  const recapture = await call("capture_thought", { content: "a note built on the gamma note", supersedes: hitId! });
  assert(/already captured as/.test(recapture) && /not written/.test(recapture), "a re-capture naming a pointer says the pointer was not written");
  actionCount = (await qlog<{ n: number }[]>`SELECT count(*)::int AS n FROM query_log WHERE kind = 'action'`)[0].n;
  assert(actionCount === 2, `…and logs no cite for a pointer it did not write (${actionCount})`);
  await call("update_thought", { id: builtId!, supersedes: hitId! });
  const editRows = await qlog<{ tool: string; target_id: string }[]>`
    SELECT tool, target_id FROM query_log WHERE kind = 'action' AND tool LIKE 'update_thought%' ORDER BY tool`;
  assert(editRows.length === 2 && editRows[0].tool === "update_thought" && editRows[0].target_id === builtId && editRows[1].tool === "update_thought/supersedes" && editRows[1].target_id === hitId,
    `the edit that writes the pointer logs the edited id as opened and the superseded id as cited (${JSON.stringify(editRows)})`);

  await qlog`DELETE FROM query_log`;
  await qlog`DELETE FROM thoughts`;
  await qlog.close();
}

console.log("\n[10b] query log: the filter a search ran, the arm that served it and the writer's tier are recorded, and keyword is logged too (SMD-1490)");
{
  // 034 gave query_log a `filter` column but every search tool passed
  // `filter: {}`, so it was permanently empty; keyword search wrote no row at
  // all. SMD-1490 exposes a real metadata filter on the search tools, routes all
  // three through one operation, and adds `arm` (hybrid|keyword) and `tier`
  // (from OB1_TIER, 'canary' here). This drives the real handlers and reads the
  // rows back. The filter need not match a row — the log write precedes the
  // result count — so this asserts what the boundary recorded, which is the
  // whole bug: the object sent, not `{}`. Drop-the-mechanism: hardcode
  // `filter: {}` in runSearch and the filtered-search assertion below fails.
  const qlog = new SQL({ url: URL_, max: 1 });
  await qlog`DELETE FROM query_log`;
  await call("capture_thought", { content: "zeta note the filter path can search over" });

  await call("search_thoughts", { query: "zeta", limit: 5, threshold: -1, filter: { type: "idea" } });
  await call("search_thoughts", { query: "zeta", limit: 5, threshold: -1 });
  await call("search_thoughts_keyword", { query: "zeta" });
  await call("search_thoughts_keyword", { query: "zeta", filter: { type: "idea" } });

  const rows = await qlog<{ tool: string; arm: string | null; tier: string | null; filter: Record<string, unknown> }[]>`
    SELECT tool, arm, tier, filter FROM query_log WHERE kind = 'search' ORDER BY logged_at`;
  assert(rows.length === 4, `four search rows were logged, keyword among them (${rows.length})`);
  assert(rows.every((r) => r.tier === "canary"), `every search row carries the server's tier (${JSON.stringify(rows.map((r) => r.tier))})`);

  const [stFiltered, stPlain, kwPlain, kwFiltered] = rows;
  assert(stFiltered.tool === "search_thoughts" && stFiltered.arm === "hybrid" && JSON.stringify(stFiltered.filter) === JSON.stringify({ type: "idea" }),
    `search_thoughts records the metadata filter it ran with and arm=hybrid — not the empty {} 034 always saw (${JSON.stringify(stFiltered)})`);
  assert(stPlain.tool === "search_thoughts" && stPlain.arm === "hybrid" && JSON.stringify(stPlain.filter) === "{}",
    `an unfiltered search_thoughts records {} (${JSON.stringify(stPlain)})`);
  assert(kwPlain.tool === "search_thoughts_keyword" && kwPlain.arm === "keyword" && JSON.stringify(kwPlain.filter) === "{}",
    `keyword search is logged now (034 logged none), arm=keyword, unfiltered {} (${JSON.stringify(kwPlain)})`);
  assert(kwFiltered.arm === "keyword" && JSON.stringify(kwFiltered.filter) === JSON.stringify({ type: "idea" }),
    `a filtered keyword search records its filter (${JSON.stringify(kwFiltered)})`);

  // The boundary refuses a shape jsonb should not run: a nested object. call()
  // throws on the tool error (or the schema rejection) — either way the bad
  // filter never reaches the store.
  let refused = false;
  try { await call("search_thoughts", { query: "zeta", filter: { type: { nested: "no" } } }); }
  catch { refused = true; }
  assert(refused, "a nested-object filter is refused at the tool boundary, not passed to jsonb");

  await qlog`DELETE FROM query_log`;
  await qlog`DELETE FROM thoughts`;
  await qlog.close();
}

console.log("\n[10c] Who wrote it, over MCP: a hit says By: <key> (kind) from the key that made the write, said_by and actor filter on it through the one search operation, a client's metadata cannot set it, and the folded filter reaches the log (SMD-1726, migration 050)");
{
  const sql = new SQL({ url: URL_, max: 1 });
  await sql`DELETE FROM query_log`;
  await sql`SELECT set_agent_kind('op-key', 'operator')`;
  await sql`SELECT set_agent_kind('bot-key', 'agent')`;
  // Two different texts — the same text would be one row by 003's fingerprint —
  // one through each key; the server resolves each key's agent (010) and names
  // it in the envelope, and 050's trigger stamps the row from the registry.
  const opOut = await call("capture_thought", { content: "theta the operator typed about the schedule" }, "op-raw");
  const botOut = await call("capture_thought", { content: "theta an agent concluded about the schedule" }, "bot-raw");
  assert(/Captured as/.test(opOut) && /Captured as/.test(botOut), "both keys capture");
  const blockOf = (out: string, re: RegExp) => out.split("--- Result ").find((b) => re.test(b)) ?? "";
  const both = await call("search_thoughts", { query: "theta schedule", limit: 10, threshold: -1 });
  assert(/\nBy: op-key \(operator\)\n/.test(blockOf(both, /operator typed/)) && /\nBy: bot-key \(agent\)\n/.test(blockOf(both, /agent concluded/)),
    `each hit says who wrote it, from the key that made the write (${both.replace(/\n/g, " ⏎ ").slice(0, 400)})`);
  assert(/\nID: [0-9a-f-]{36}\n(⚠[^\n]*\n)?Captured: [^\n]*\nType: [^\n]*\nBy: /.test(both), "…on its own line under Type:, so the ID: line is still the id alone and [8]'s reach through it holds");
  const onlyOp = await call("search_thoughts", { query: "theta schedule", limit: 10, threshold: -1, said_by: "operator" });
  assert(/operator typed/.test(onlyOp) && !/agent concluded/.test(onlyOp) && /^Found 1 thought/.test(onlyOp), `said_by: operator returns the operator's row and not the agent's (${onlyOp.split("\n")[0]})`);
  const onlyBot = await call("search_thoughts_keyword", { query: "theta", actor: "bot-key" });
  assert(/agent concluded/.test(onlyBot) && !/operator typed/.test(onlyBot) && /\nBy: bot-key \(agent\)\n/.test(onlyBot), "actor: bot-key on the keyword arm returns that key's row, with its By: line");
  const listed = await call("list_thoughts", { limit: 20, said_by: "agent" });
  assert(/agent concluded/.test(listed) && !/operator typed/.test(listed) && /agent concluded about the schedule\n   ID: [0-9a-f-]{36}\n   By: bot-key \(agent\)/.test(listed),
    `list_thoughts filters by said_by and prints By: under the ID line — content then ID stay adjacent, which [8] matches on (${listed.replace(/\n/g, " ⏎ ").slice(0, 200)})`);
  assert(/operator typed/.test(await call("list_thoughts", { limit: 20, actor: "op-key" })) && !/agent concluded/.test(await call("list_thoughts", { limit: 20, actor: "op-key" })), "…and by actor");
  // A client cannot set the mark: capture_thought's metadata is the extractor's,
  // so the one client-controlled metadata write is update_thought's patch — an
  // agent's key patching the operator's row to claim it changes nothing (050:
  // the actor follows the content, and a patch is not content).
  const idOp = blockOf(both, /operator typed/).match(/\nID: ([0-9a-f-]{36})/)![1];
  await call("update_thought", { id: idOp, metadata_patch: { actor_kind: "agent", actor_name: "bot-key" } }, "bot-raw");
  const patched = await call("search_thoughts", { query: "theta schedule", limit: 10, threshold: -1, said_by: "operator" });
  assert(/operator typed/.test(patched) && /By: op-key \(operator\)/.test(patched) && /^Found 1 thought/.test(patched), "an agent's metadata patch naming the two keys changes nothing: the mark is the database's, from the key");
  await call("update_thought", { id: idOp, content: "theta the agent rewrote what the operator typed" }, "bot-raw");
  const rewritten = await call("search_thoughts", { query: "theta schedule", limit: 10, threshold: -1, said_by: "agent" });
  assert(/agent rewrote/.test(rewritten) && /agent concluded/.test(rewritten) && /^Found 2 thought/.test(rewritten), "…and an agent's content edit re-stamps: the text is the agent's now, and said_by: agent finds both");
  assert(/^Found 0|No thoughts found/.test(await call("search_thoughts", { query: "theta schedule", limit: 10, threshold: -1, said_by: "operator" })), "…so said_by: operator finds nothing the operator still says");
  let refused = "";
  try { await call("search_thoughts", { query: "theta", said_by: "operator", filter: { actor_kind: "agent" } }); } catch (e) { refused = (e as Error).message; }
  assert(/pass one of the two/.test(refused), `said_by beside a filter.actor_kind that disagrees is refused at the boundary (${refused.slice(0, 120)})`);
  // The log sees the folded filter, not the sugar: a per-arm report reads one column.
  const logged = await sql<{ tool: string; filter: Record<string, unknown> }[]>`SELECT tool, filter FROM query_log WHERE kind = 'search' AND (filter ? 'actor_kind' OR filter ? 'actor_name') ORDER BY logged_at`;
  assert(logged.length >= 3 && JSON.stringify(logged[0].filter) === JSON.stringify({ actor_kind: "operator" }) && logged.some((r) => r.tool === "search_thoughts_keyword" && JSON.stringify(r.filter) === JSON.stringify({ actor_name: "bot-key" })),
    `query_log records said_by and actor as the filter they became (${logged.map((r) => `${r.tool}:${JSON.stringify(r.filter)}`).join(" ")})`);
  await sql`DELETE FROM query_log`;
  await sql`DELETE FROM thoughts`;
  await sql.close();
}

console.log("\n[11] Undated and infinity rows render through the tools without a fabricated date (SMD-1328)");
{
  // The corpus is empty here (the section above wiped it). Plant the two rows
  // only a direct INSERT can make — a NULL created_at and an infinite one — and
  // drive the two tools that print a date: list_thoughts (the [date] prefix)
  // and fetch (the title). Neither may print 1/1/1970 or "Invalid Date".
  const sql = new SQL({ url: URL_, max: 1 });
  const axis = (i: number) => { const a = new Array(EMBEDDING_DIM).fill(0); a[i] = 1; return "[" + a.join(",") + "]"; };
  const undatedId = await plantLegacyRow(sql, "an undated e2e thought", axis(0), null);
  const infinityId = await plantLegacyRow(sql, "an infinity-dated e2e thought", axis(1), "infinity");
  try {
    const listed = await call("list_thoughts", { limit: 10 });
    // The ids are masked first: a uuid ending in 1970 failed this once in a thousand runs (ninth review pass).
    assert(!/1970/.test(listed.replace(/[0-9a-f-]{36}/g, "")) && !/Invalid Date/.test(listed), `list_thoughts prints no fabricated date (${listed.replace(/\n/g, " ⏎ ")})`);
    assert(/\[undated\]/.test(listed), "the undated row shows [undated], not a date");
    assert(/\[infinity\]/.test(listed), "the infinity row shows [infinity], its own text");

    const undated = JSON.parse(await call("fetch", { id: undatedId }));
    assert(/^Open Brain/.test(undated.title) && !/1970/.test(undated.title), `fetch titles an undated thought "Open Brain …", not the epoch (${undated.title})`);
    assert(undated.metadata?.created_at === null, `fetch's created_at metadata is null for an undated row (${JSON.stringify(undated.metadata?.created_at)})`);

    const inf = JSON.parse(await call("fetch", { id: infinityId }));
    assert(inf.title.startsWith("infinity - ") && !/Invalid Date/.test(inf.title), `fetch titles an infinity thought with its own text (${inf.title})`);
    assert(inf.metadata?.created_at === "infinity", `fetch's created_at metadata keeps "infinity" (${JSON.stringify(inf.metadata?.created_at)})`);

    // The thought_stats range is the fifth renderer. min/max skip the NULL row
    // (024), so the range over this corpus is the infinity row on both ends —
    // it must read "infinity", not "Invalid Date" (the pre-fix new Date() form).
    const stats = await call("thought_stats");
    const rangeLine = stats.split("\n").find((l) => l.startsWith("Date range")) ?? "";
    assert(/infinity/.test(rangeLine) && !/Invalid Date/.test(rangeLine) && !/1970/.test(rangeLine),
           `thought_stats renders the infinity range as text, not Invalid Date/1970 (${JSON.stringify(rangeLine)})`);

    // The two remaining renderers are the `Captured:` lines of search_thoughts
    // and search_thoughts_keyword. Every other search in this suite runs over
    // dated rows, where displayDate and the pre-fix new Date() agree — so drive
    // both tools over the planted rows here, or a revert ships silently. The
    // negatives avoid a bare /1970/ (a hex uuid could carry those digits): the
    // fabrications are "Invalid Date" (infinity) and a digit right after
    // "Captured: " (the epoch), neither of which a correct render produces.
    const kwInf = await call("search_thoughts_keyword", { query: "infinity" });
    assert(/Captured: infinity/.test(kwInf) && !/Invalid Date/.test(kwInf),
           `search_thoughts_keyword renders the infinity row's date as its own text (${kwInf.replace(/\n/g, " ⏎ ")})`);
    const kwUndated = await call("search_thoughts_keyword", { query: "undated" });
    assert(!/Captured:/.test(kwUndated) && !/Invalid Date/.test(kwUndated),
           `search_thoughts_keyword omits the Captured line for the undated row (${kwUndated.replace(/\n/g, " ⏎ ")})`);
    const stBoth = await call("search_thoughts", { query: "infinity", threshold: -1 });
    assert(/Captured: infinity/.test(stBoth) && !/Invalid Date/.test(stBoth) && !/Captured:\s*\d/.test(stBoth),
           `search_thoughts renders the infinity row's date as text and never fabricates one for the undated row it also returns (${stBoth.replace(/\n/g, " ⏎ ")})`);
  } finally {
    await sql`DELETE FROM thoughts WHERE id = ${undatedId}::uuid OR id = ${infinityId}::uuid`;
    await sql.close();
  }
}

console.log("\n[12] list_supersession_proposals renders an infinity/undated proposal thought instead of crashing the whole tool (SMD-1803)");
{
  // The severe half of SMD-1803: normaliseProposal's old local iso ran the
  // proposal thoughts' created_at through new Date(v).toISOString(), which THREW
  // RangeError on an infinity-dated one — so the tool returned isError and a
  // client saw the queue vanish — and fabricated the epoch on a NULL one. Only a
  // direct INSERT reaches an undated/infinite row; reference both from a proposal
  // and drive the tool. Pre-fix, call() throws on the tool's isError; post-fix it
  // returns and each date renders as its own text.
  const sql = new SQL({ url: URL_, max: 1 });
  const axis = (i: number) => { const a = new Array(EMBEDDING_DIM).fill(0); a[i] = 1; return "[" + a.join(",") + "]"; };
  const infOlder = await plantLegacyRow(sql, "smd-1803 e2e proposal older, infinity", axis(0), "infinity");
  const undatedNewer = await plantLegacyRow(sql, "smd-1803 e2e proposal newer, undated", axis(1), null);
  try {
    await sql`SELECT record_supersession_proposal(${infOlder}::uuid, ${undatedNewer}::uuid, 'conflict_undirected', 0.7, 'infinity vs undated', 0.9, 'consolidate:smd1803@p1', NULL)`;
    // This line itself is the tooth: pre-fix, call() throws on the tool's isError.
    const listed = await call("list_supersession_proposals", {});
    assert(/older \[infinity\]/.test(listed), `the infinity-dated thought renders as [infinity], not a throw (${listed.replace(/\n/g, " ⏎ ")})`);
    assert(/newer \[undated\]/.test(listed), `the undated thought renders as [undated], not the epoch (${listed.replace(/\n/g, " ⏎ ")})`);
    // TZ/locale-robust: [infinity]/[undated] above are the positives; the epoch
    // fabrication renders "Invalid Date" (infinity) or an epoch date the render
    // localises, so key on its two forms rather than a bare year a hex uuid
    // could carry.
    assert(!/Invalid Date/.test(listed) && !/1\/1\/1970/.test(listed) && !/12\/31\/1969/.test(listed),
           `no fabricated date reaches the client (${listed.replace(/\n/g, " ⏎ ")})`);
  } finally {
    await sql`DELETE FROM supersession_proposals`;
    await sql`DELETE FROM thoughts WHERE id = ${infOlder}::uuid OR id = ${undatedNewer}::uuid`;
    await sql.close();
  }
}

console.log("\n[13] A capture-only key adds a thought that names its harness and its sources, and can do nothing else (SMD-1298)");
{
  // The raw envelope, not call(): this section reads errors as answers. One
  // helper per key (fifth review pass: three hand-rolled copies).
  type Envelope = { error?: { message: string }; result?: { isError?: boolean; content?: { text?: string }[]; tools?: { name: string }[] } };
  const rpcAs = (key: string) => async (method: string, params: Record<string, unknown>): Promise<Envelope> => {
    const r = await fetch(BASE, { method: "POST", headers: { ...H, "x-brain-key": key }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
    const text = await r.text();
    return JSON.parse(text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6));
  };
  const rpc = rpcAs(CAPTURE_KEY);
  const captureAs = (key: string) => (args: Record<string, unknown>) => rpcAs(key)("tools/call", { name: "capture_thought", arguments: args });
  const textOf = (b: Awaited<ReturnType<typeof rpc>>) => (b.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  const idIn = (s: string) => /id ([0-9a-f-]{36})/.exec(s)?.[1];
  const sql = new SQL({ url: URL_, max: 1 });

  const surface = ((await rpc("tools/list", {})).result?.tools ?? []).map((t) => t.name);
  assert(surface.join() === "capture_thought", `the capture key's surface is capture_thought alone (${surface.join(", ") || "nothing"})`);

  // A thought "the session retrieved", written by the writer key, is the
  // summary's source; the hook names it as derived_from and the harness as source.
  const retrieved = idIn(await call("capture_thought", { content: "eta thought the session retrieved from the brain" }));
  assert(retrieved !== undefined, "a source thought exists to be cited");
  const cap = await rpc("tools/call", { name: "capture_thought", arguments: {
    content: "Session summary — claude-code — the hook's first capture of a session that read eta", source: "claude-code", derived_from: [retrieved],
  } });
  const capText = textOf(cap);
  assert(cap.error === undefined && cap.result?.isError !== true, `the capture-scoped key captures (${cap.error?.message ?? capText.split("\n")[0].slice(0, 80)})`);
  const id = idIn(capText);
  assert(id !== undefined, "…and the reply carries the new id");
  const [row] = await sql`SELECT metadata->>'source' AS origin, derived_from FROM thoughts WHERE id = ${id}::uuid`;
  assert(row?.origin === "claude-code", `metadata.source is the harness the caller named (${row?.origin})`);
  assert(JSON.stringify(row?.derived_from ?? null).includes(retrieved!), `derived_from carries the retrieved thought (${JSON.stringify(row?.derived_from)})`);
  const [audit] = await sql`SELECT source, actor_name, canonical_agent_id, origin FROM thought_audit WHERE thought_id = ${id}::uuid AND action = 'capture' ORDER BY id LIMIT 1`;
  assert(audit?.source === "claude-code" && audit?.actor_name === "session-hook",
    `the audit row carries the source and the key's name (${audit?.source}, ${audit?.actor_name})`);
  // 046's origin (SMD-1730) comes from the actor's `via`, which the tool sets inline; no suite drove the real server's capture and read it back (seventh review pass).
  assert(audit?.origin === "open-brain", `…and the door the write came through, 046's origin (${audit?.origin})`);
  assert(typeof audit?.canonical_agent_id === "string", "…and the hook's agent id — 049 lets the registry record the capture scope, so the write is attributed");
  const [key] = await sql`SELECT scope FROM ob1_agent_keys WHERE key_hash = ${hashKey(CAPTURE_KEY)}`;
  assert(key?.scope === "capture", `the registry recorded the scope as presented (${key?.scope})`);

  // Absent, not refused: a read through the capture key is an unknown tool.
  const read = await rpc("tools/call", { name: "search_thoughts", arguments: { query: "eta", limit: 5, threshold: 0.1 } });
  // The shape the hook reads: a RESULT with isError whose text opens "MCP error -32602" (thirteenth review pass — the hook's fake had it as a JSON-RPC error).
  assert(read.error === undefined && read.result?.isError === true && /^MCP error -32602: Tool search_thoughts not found/.test(textOf(read)), `search_thoughts is not a tool the capture key can call — an isError result, not a JSON-RPC error (${textOf(read).slice(0, 60)})`);
  assert(/not found|unknown tool/i.test(String(read.error?.message ?? textOf(read))), "…told as a missing tool, not a permission error");
  const del = await rpc("tools/call", { name: "delete_thought", arguments: { id } });
  assert(del.error !== undefined || del.result?.isError === true, "delete_thought is not either — the key cannot remove what it added");

  // supersedes through a capture key (first review pass): only what it wrote.
  const steal = await rpc("tools/call", { name: "capture_thought", arguments: { content: "Session summary — a later ending — claims to replace eta", source: "claude-code", supersedes: retrieved } });
  assert(steal.result?.isError === true && /only a thought it captured itself/.test(textOf(steal)), `a capture key may not supersede another key's thought (${textOf(steal).slice(0, 80)})`);
  const [[untouched]] = [await sql`SELECT count(*)::int AS n FROM thoughts WHERE content LIKE 'Session summary — a later ending%'`];
  assert(untouched?.n === 0, "…and nothing was written");
  const own = await rpc("tools/call", { name: "capture_thought", arguments: { content: "Session summary — claude-code — the same session, ended again", source: "claude-code", supersedes: id } });
  const ownId = idIn(textOf(own));
  assert(own.result?.isError !== true && ownId !== undefined, `…while superseding its own earlier summary is allowed (${textOf(own).split("\n")[0].slice(0, 70)})`);
  const [chain] = await sql`SELECT supersedes::text AS s FROM thoughts WHERE id = ${ownId}::uuid`;
  assert(chain?.s === id, "…and the pointer is recorded");
  // Ownership has two paths (second review pass: mutants keeping either alone
  // passed). The AGENT path: the key is renamed — same digest, new label — so
  // its earlier thought's audit row carries the old name and the same agent id;
  // the NAME path: the registry is away, the principal has no agent id, and a
  // thought this key captured meanwhile has NULL for one.
  // The server seeds its env once per process (third review pass: a swap of
  // MCP_ACCESS_KEYS here reached nothing, and the case was vacuous), so the
  // rename is written into the RECORD: the earlier row says a name this key no
  // longer presents, and only the agent path can allow the supersedes.
  await sql`ALTER TABLE thought_audit DISABLE TRIGGER thought_audit_immutable`; // 008's append-only guard would refuse the UPDATE, honestly
  await sql`UPDATE thought_audit SET actor_name = 'session-hook-before-rename' WHERE thought_id = ${ownId}::uuid AND action = 'capture'`;
  await sql`ALTER TABLE thought_audit ENABLE TRIGGER thought_audit_immutable`;
  const renamed = await rpc("tools/call", { name: "capture_thought", arguments: { content: "Session summary — claude-code — under the key's new name", source: "claude-code", supersedes: ownId } });
  assert(renamed.result?.isError !== true && idIn(textOf(renamed)) !== undefined, `a renamed key supersedes its own thought — the audit row's name differs, the agent id is the same (${textOf(renamed).split("\n")[0].slice(0, 60)})`);
  const [renamedAudit] = await sql`SELECT actor_name FROM thought_audit WHERE thought_id = ${ownId}::uuid AND action = 'capture'`;
  assert(renamedAudit?.actor_name === "session-hook-before-rename", "…the earlier row says the old name, so only the agent path could have allowed it");
  // The ownership read needs the audit table (SELECT on it, the `server` grant
  // group): with the table out of reach the pointer is refused by name and the
  // grant is named, before any model call (third review pass: no tooth held this).
  await sql`ALTER TABLE thought_audit RENAME TO thought_audit_away`;
  try {
    const unreadable = await rpc("tools/call", { name: "capture_thought", arguments: { content: "Session summary — claude-code — with the audit table away", source: "claude-code", supersedes: ownId } });
    assert(unreadable.result?.isError === true && /^Error: /.test(textOf(unreadable)) && /could not be checked/.test(textOf(unreadable)) && /does not exist/.test(textOf(unreadable)) && !/--grant/.test(textOf(unreadable)),
      `a supersedes the server cannot check is the server's error — "Error:", not "Refused:" — carrying the store's words, and no grant remedy for what is not a privilege error (${textOf(unreadable).slice(0, 70)})`);
  } finally {
    await sql`ALTER TABLE thought_audit_away RENAME TO thought_audit`;
  }
  // The check-then-write race — a source deleted between the trim and the
  // write — is the one path to the catch's derived_from branch, driven here by
  // a validator that refuses everything: a key that cannot read is told no
  // position and no count, singular verb and all (ninth review pass: this gate
  // had no tooth, and the plural leaked the count through the placeholder).
  // The fake refuses the first N calls (a sequence: it survives the rollback the
  // RAISE causes) and then hands over to the real validator, so the race can be
  // made to clear on the retry or to persist.
  await sql`ALTER FUNCTION validate_derived_from(jsonb) RENAME TO validate_derived_from_real`;
  await sql`CREATE SEQUENCE race_seq`;
  await sql`CREATE TABLE race_mode (n int)`;
  await sql`INSERT INTO race_mode VALUES (99)`;
  await sql.unsafe("CREATE FUNCTION validate_derived_from(p_value jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN RETURN NULL; END IF; IF nextval('race_seq') <= (SELECT n FROM race_mode) THEN RAISE EXCEPTION 'derived_from references a thought that does not exist (in %).', p_value; END IF; RETURN validate_derived_from_real(p_value); END $$");
  try {
    // A refusal that clears on the retry: the write is tried once more after a re-trim, and the summary keeps its live sources (twelfth review pass: the hook could only have dropped them all).
    await sql`UPDATE race_mode SET n = 1`;
    const retried = await rpc("tools/call", { name: "capture_thought", arguments: { content: "Session summary — claude-code — a source deleted and the write tried again", source: "claude-code", derived_from: [id, retrieved] } });
    const retriedId = idIn(textOf(retried));
    const [retriedRow] = await sql`SELECT derived_from FROM thoughts WHERE id = ${retriedId}::uuid`;
    assert(retried.result?.isError !== true && retriedId !== undefined && JSON.stringify(retriedRow?.derived_from).includes(retrieved!) && JSON.stringify(retriedRow?.derived_from).includes(id!),
      `a refusal in the write that clears on a second try lands with both live sources recorded (${textOf(retried).slice(0, 50)})`);
    assert(Number((await sql`SELECT last_value FROM race_seq`)[0].last_value) === 2, "…after exactly two validator calls: the refusal, then the retry");
    await sql`UPDATE race_mode SET n = 99`;
    await sql`ALTER SEQUENCE race_seq RESTART`;
    const raced = await rpc("tools/call", { name: "capture_thought", arguments: { content: "Session summary — claude-code — a source deleted between the check and the write", source: "claude-code", derived_from: [id, retrieved] } });
    const racedText = textOf(raced);
    assert(raced.result?.isError === true && /^Refused: a `derived_from` id names no thought\./.test(racedText) && !/derived_from\[/.test(racedText) && !racedText.includes(id!) && !racedText.includes(retrieved!),
      `a refusal in the write itself tells a key that cannot read no position, no id and no count (${racedText.slice(0, 60)})`);
    let racedWriter = "";
    try { await call("capture_thought", { content: "Session summary — the writer, same race", derived_from: ["0000dead-0000-4000-8000-000000000011", "0000dead-0000-4000-8000-000000000012"] }); } catch (e) { racedWriter = (e as Error).message; }
    assert(/derived_from\[0\] \(/.test(racedWriter) && /derived_from\[1\] \(/.test(racedWriter) && / name no thought/.test(racedWriter),
      `…while a reader is told both positions with their ids, plural (${racedWriter.slice(0, 80)})`);
  } finally {
    await sql`DROP FUNCTION validate_derived_from(jsonb)`;
    await sql`ALTER FUNCTION validate_derived_from_real(jsonb) RENAME TO validate_derived_from`;
    await sql`DROP TABLE race_mode`;
    await sql`DROP SEQUENCE race_seq`;
  }
  await sql`ALTER FUNCTION resolve_agent(text, text, text) RENAME TO resolve_agent_away`;
  let awayIdOuter: string | undefined;
  try {
    const rpc2 = captureAs(CAPTURE_KEY_2);
    const away1 = await rpc2({ content: "Session summary — codex — captured while the registry was away", source: "codex" });
    const awayId = idIn(textOf(away1));
    awayIdOuter = awayId;
    const [awayAudit] = await sql`SELECT actor_name, canonical_agent_id FROM thought_audit WHERE thought_id = ${awayId}::uuid AND action = 'capture'`;
    assert(awayId !== undefined && awayAudit?.actor_name === "hook-two" && awayAudit?.canonical_agent_id === null, "with the registry away a capture lands under the key's name and no agent id");
    const away2 = await rpc2({ content: "Session summary — codex — the same session, ended again, registry still away", source: "codex", supersedes: awayId });
    assert(away2.result?.isError !== true && idIn(textOf(away2)) !== undefined, `…and the key supersedes it by NAME (${textOf(away2).split("\n")[0].slice(0, 60)})`);
    const byOtherName = await captureAs(CAPTURE_KEY)({ content: "Session summary — claude-code — session-hook claims hook-two's outage-time thought", source: "claude-code", supersedes: awayId });
    assert(byOtherName.result?.isError === true && /only a thought it captured itself/.test(textOf(byOtherName)),
      "…and another key with no id either is refused BY NAME (fifth review pass: the name path had no negative case)");
    const away3 = await rpc2({ content: "Session summary — codex — a claim on the other key's thought", source: "codex", supersedes: id });
    assert(away3.result?.isError === true && /^Error: .*could not be attributed while the agent registry is unavailable/.test(textOf(away3)),
      `…while an ATTRIBUTED row met by a key with no id is the server's error to retry, not a refusal (${textOf(away3).slice(0, 70)})`);
  } finally {
    await sql`ALTER FUNCTION resolve_agent_away(text, text, text) RENAME TO resolve_agent`;
  }
  // With the registry back the key has an agent id and the row from the outage
  // has none: not provably this key's, so refused — a later key minted under the
  // same name would otherwise own every thought written while the registry was
  // down (fourth review pass).
  {
    const b = await captureAs(CAPTURE_KEY_2)({ content: "Session summary — codex — claiming the outage-time thought after the registry returned", source: "codex", supersedes: awayIdOuter });
    assert(b.result?.isError === true && /only a thought it captured itself/.test(textOf(b)), "a row without an agent id is refused to a key that now has one, even under the same name");
  }
  // No existence oracle on a key that cannot read: re-sending the writer's
  // text says nothing of "already captured" to the capture key, and does to the writer.
  const again = await rpc("tools/call", { name: "capture_thought", arguments: { content: "eta thought the session retrieved from the brain", source: "claude-code", derived_from: [id] } });
  assert(!/already captured|currently supersedes/.test(textOf(again)) && idIn(textOf(again)) === retrieved, "a re-capture through the capture key returns the id and no note that the text existed");
  const writerAgain = await call("capture_thought", { content: "eta thought the session retrieved from the brain", derived_from: [id] });
  assert(/already captured as/.test(writerAgain), "…the writer key is told, as before");

  // A derived_from that names a ghost: the positions that name no thought are
  // named, so a caller drops exactly those; the ids beside them only to a key
  // that can read (second review pass).
  const ghost = "0000dead-0000-4000-8000-000000000000";
  const partial = await rpc("tools/call", { name: "capture_thought", arguments: { content: "kappa summary naming a ghost", source: "codex", derived_from: [retrieved, ghost] } });
  const partialText = textOf(partial);
  const partialId = idIn(partialText);
  assert(partial.result?.isError !== true && partialId !== undefined && !/Note:|named no thought/.test(partialText),
    `a capture key's list is trimmed to what exists and the reply says nothing of it — with one id the count was the answer (eighth review pass) (${partialText.split("\n").slice(-1)[0].slice(0, 80)})`);
  assert(!partialText.includes(ghost) && !partialText.includes(retrieved!) && !/derived_from\[/.test(partialText), "…never which — no id, no position, to a key that cannot read (third review pass)");
  // …and a re-capture with a ghost source reads as the re-capture without one: no note on either (seventh and eighth review passes).
  const againGhost = await rpc("tools/call", { name: "capture_thought", arguments: { content: "eta thought the session retrieved from the brain", source: "claude-code", derived_from: [id, ghost] } });
  assert(!/Note:|named no thought/.test(textOf(againGhost)) && idIn(textOf(againGhost)) === retrieved && textOf(againGhost) === textOf(again), "a trimmed source leaves a re-capture's reply byte-identical to one with live sources alone");
  const [partialRow] = await sql`SELECT derived_from FROM thoughts WHERE id = ${partialId}::uuid`;
  assert(JSON.stringify(partialRow?.derived_from).includes(retrieved!) && !JSON.stringify(partialRow?.derived_from).includes(ghost), "…and the row records the live source alone");
  let readerText = "";
  try { await call("capture_thought", { content: "kappa summary naming a ghost", derived_from: [ghost, retrieved] }); } catch (e) { readerText = (e as Error).message; }
  assert(/derived_from\[0\] \(0000dead-/.test(readerText), `…the writer key sees the id beside the position (${readerText.slice(0, 90)})`);

  // The label's shape is held, and the default is what every capture carried before.
  const bad = await rpc("tools/call", { name: "capture_thought", arguments: { content: "iota thought under a malformed label", source: "Claude Code!" } });
  assert(bad.error !== undefined || bad.result?.isError === true, "a source outside the shape is refused");
  const [[none]] = [await sql`SELECT count(*)::int AS n FROM thoughts WHERE content = 'iota thought under a malformed label'`];
  assert(none?.n === 0, "…and nothing was written for it");
  const plain = idIn(await call("capture_thought", { content: "theta thought naming no source" }));
  const [p] = await sql`SELECT metadata->>'source' AS origin FROM thoughts WHERE id = ${plain}::uuid`;
  assert(p?.origin === "mcp", `a capture naming no source still records mcp (${p?.origin})`);

  // The writer sees the hook's summary where a session would look for it.
  const found = await call("search_thoughts", { query: "eta", limit: 10, threshold: 0.1 });
  assert(found.includes(id!), "the summary the hook captured is retrievable by the writer key");
  await sql.close();
}

console.log("\n[14] brain_info and the keyed /health body read the live database: versions, the ledger against the tree, counts, size, HNSW (SMD-2041)");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const here = dirname(fileURLToPath(import.meta.url));
  const treeLast = Math.max(...readdirSync(join(here, "..", "db", "migrations")).filter((n) => /^\d{3}_.*\.sql$/.test(n)).map((n) => Number(n.slice(0, 3))));
  const health = async (key: string | null) => {
    const r = await fetch(`${BASE}/health`, { headers: key ? { "x-brain-key": key } : {} });
    const body = await r.text();
    try { return JSON.parse(body) as Record<string, any>; } catch { return body; }
  };

  // resetSchema applies the files with no ledger: the record says so rather
  // than inventing a number, and does not judge the brain against the tree.
  // Another tool's schema_migrations (Supabase's supabase_migrations, Rails,
  // dbmate) is not the fork's ledger: no sha256 column, so the brain still has
  // none — not one it cannot resolve (review pass 3).
  await sql.unsafe(`CREATE SCHEMA e2e_other_tool`);
  await sql.unsafe(`CREATE TABLE e2e_other_tool.schema_migrations (version text PRIMARY KEY)`);
  const bare = await health("e2e-key") as Record<string, any>;
  await sql.unsafe(`DROP TABLE e2e_other_tool.schema_migrations`);
  await sql.unsafe(`DROP SCHEMA e2e_other_tool`);
  assert(bare.database?.ledger?.present === false && bare.database?.highestMigration === null && bare.ledgerStatus === null,
    `a brain with no schema_migrations of its own — another tool's in another schema — reports no ledger and no judgement (${JSON.stringify(bare.database?.ledger)}, ${bare.ledgerStatus})`);

  // Adopted the way an operator adopts a hand-built schema: the ledger now
  // records every file, so its highest is the tree's last — a fresh brain is current.
  const adopt = await runScript(["bun", join(here, "..", "db", "migrate.ts"), "--url", URL_, "--baseline"], { cwd: join(here, "..", "db") });
  assert(adopt.code === 0, `migrate.ts --baseline adopts the schema (${adopt.out.trim().split("\n").slice(-1)[0]})`);
  const info = await health("e2e-key") as Record<string, any>;
  const db = info.database ?? {};
  const [truth] = await sql`
    SELECT current_setting('server_version') AS pg,
           (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vec,
           (SELECT count(*)::int FROM thoughts) AS thoughts,
           (SELECT count(*)::int FROM thought_audit) AS audit,
           (SELECT count(*)::int FROM thought_chunks) AS chunks,
           (SELECT count(*)::int FROM ob1_entities) AS entities,
           (SELECT value FROM ob1_config WHERE key = 'schema_version') AS schema_version`;
  assert(db.highestMigration === treeLast && info.latestMigration === treeLast && info.ledgerStatus === "current",
    `the ledger's highest is the tree's last file, ${treeLast}, and the brain is current (${db.highestMigration}, ${info.latestMigration}, ${info.ledgerStatus})`);
  assert(db.postgres === truth.pg && db.pgvector?.version === truth.vec && db.pgvector?.schema === "public",
    `Postgres and pgvector versions are the catalog's (${db.postgres}, ${db.pgvector?.version} in ${db.pgvector?.schema})`);
  assert(db.schemaVersion === truth.schema_version && db.schemaVersion === FORK_VERSION, `the schema version is ob1_config's, which is FORK_VERSION (${db.schemaVersion})`);
  assert(db.counts?.thoughts === truth.thoughts && db.counts?.thought_audit === truth.audit && db.counts?.thought_chunks === truth.chunks && db.counts?.ob1_entities === truth.entities && truth.thoughts > 0 && truth.audit > truth.thoughts,
    `the counts are the tables' (${JSON.stringify(db.counts)})`);
  assert(typeof db.databaseBytes === "number" && db.databaseBytes > 1_000_000, `the database size is a byte count (${db.databaseBytes})`);
  const hnsw = (db.hnsw ?? []) as { index: string; table: string; m: number; efConstruction: number }[];
  assert(hnsw.some((h) => h.table === "thoughts") && hnsw.some((h) => h.table === "thought_chunks") && hnsw.every((h) => h.m === 16 && h.efConstruction === 64),
    `every HNSW index on the path is listed with pgvector's default build parameters (${hnsw.map((h) => `${h.index}:${h.m}/${h.efConstruction}`).join(", ")})`);
  assert(Object.keys(db.unread ?? {}).length === 0, `every read answered (${JSON.stringify(db.unread)})`);
  assert(info.tier === "canary" && info.store === "sql" && info.embedding?.model === EMBEDDING_MODEL && info.embedding?.dim === EMBEDDING_DIM && db.embedding?.dim === EMBEDDING_DIM,
    `the tier, the store and the embedding contract, the server's and the brain's (${info.tier}, ${info.store}, ${info.embedding?.model} @ ${info.embedding?.dim})`);

  // The tool renders the same read.
  const text = await call("brain_info");
  assert(new RegExp(`^Migrations: +${String(treeLast).padStart(3, "0")} applied — this server's tree ends at ${String(treeLast).padStart(3, "0")} \\(current: the ledger's highest is the tree's last\\)$`, "m").test(text),
    `the tool's Migrations row says the brain is current (${text.split("\n").find((l) => l.startsWith("Migrations"))})`);
  assert(new RegExp(`^Rows: +${truth.thoughts} thoughts · ${truth.audit} audit`, "m").test(text) && /^Postgres: +\S.* · pgvector \d/m.test(text), "…and its Rows and Postgres rows carry the same counts and versions");

  // A ledger short of the tree's last file is behind it, by name.
  const last = String(treeLast).padStart(3, "0");
  const [{ name: lastName }] = await sql`SELECT name FROM schema_migrations WHERE name LIKE ${last + "%"}`;
  await sql`DELETE FROM schema_migrations WHERE name = ${lastName}`;
  const behind = await health("e2e-key") as Record<string, any>;
  assert(behind.ledgerStatus === "behind" && behind.database?.highestMigration === treeLast - 1, `a ledger missing ${last} is behind this server's tree (${behind.ledgerStatus}, ${behind.database?.highestMigration})`);

  // Against the live catalog. A role that may read the
  // corpus and not the ledger, the chunks or the entities: the ledger is
  // present and unread as a refusal, each refused count is named, the rest
  // answer — and the read's timeouts stay inside its transaction.
  const { readDatabaseFacts } = await import("./brain-info.ts");
  const holdLocks = async (tables: string) => {
    const locker = new SQL({ url: URL_, max: 1 });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => { locked = r; });
    const tx = locker.begin(async (t) => {
      await t.unsafe(`LOCK TABLE ${tables} IN ACCESS EXCLUSIVE MODE`);
      locked();
      await held;
    });
    await isLocked;
    return async () => { release(); await tx; await locker.close(); };
  };
  const roleUrl = URL_.replace(/\/\/[^@]*@/, "//brain_reader:reader@");
  /** Await `work`, sampling pg_stat_activity for backends waiting on a lock in a query LIKE `pattern`; the most seen at once rides on the result. */
  const sampleWhile = async <T extends object>(work: Promise<T>, pattern: string): Promise<T & { maxWaiting: number }> => {
    let done = false;
    let maxWaiting = 0;
    const settled = work.finally(() => { done = true; });
    while (!done) {
      const [{ n }] = await sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE ${pattern}`;
      maxWaiting = Math.max(maxWaiting, n);
      await Bun.sleep(25);
    }
    return Object.assign(await settled, { maxWaiting });
  };
  await sql.unsafe(`DROP ROLE IF EXISTS brain_reader`);
  await sql.unsafe(`CREATE ROLE brain_reader LOGIN PASSWORD 'reader'`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO brain_reader`);
  await sql.unsafe(`GRANT SELECT ON thoughts, thought_audit, ob1_config TO brain_reader`);
  try {
    const reader = new SQL({ url: roleUrl, max: 1 });
    try {
      const f = await readDatabaseFacts(reader);
      assert(f.ledger.present === true && f.ledger.names === null && f.unread.ledger?.reason === "refused",
        `a role without SELECT on schema_migrations sees it present and unread as a refusal (${JSON.stringify(f.ledger)}, ${JSON.stringify(f.unread.ledger)})`);
      assert(f.counts?.thoughts === truth.thoughts && f.counts?.thought_chunks === null && f.unread["counts.thought_chunks"]?.reason === "refused" && f.unread["counts.ob1_entities"]?.reason === "refused",
        `…the counts it may read answer, the refused ones are named (${JSON.stringify(f.counts)})`);
      assert(f.schemaVersion === FORK_VERSION && f.pgvector?.version === truth.vec, "…and the config and catalog reads stand");
      // set_config(…, true): the ceilings end with the read's transaction; the
      // one pooled connection it used keeps the role's own (no limit here).
      const [after] = await reader`SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt`;
      assert(after.st === "0" && after.lt === "0", `the read's timeouts do not outlive its transaction (statement_timeout ${after.st}, lock_timeout ${after.lt})`);
    } finally {
      await reader.close();
    }

    // A role already stricter keeps its own: lock_timeout 100 ms on the role,
    // under the read's 1 s ceiling, and a held lock on thoughts is given up at
    // the role's 100 ms, not the read's 1 s.
    await sql.unsafe(`ALTER ROLE brain_reader SET lock_timeout = '100ms'`);
    const strict = new SQL({ url: roleUrl, max: 1 });
    const unlock = await holdLocks("thoughts");
    try {
      const t0 = performance.now();
      const f = await readDatabaseFacts(strict);
      const took = performance.now() - t0;
      assert(f.unread["counts.thoughts"]?.reason === "timeout" && took < 600, `a stricter role lock_timeout is kept, not raised to the read's (${Math.round(took)} ms, ${f.unread["counts.thoughts"]?.message})`);
    } finally {
      await unlock();
      await strict.close();
      await sql.unsafe(`ALTER ROLE brain_reader RESET lock_timeout`);
    }

    // A role whose search path does not reach public: every table exists and
    // none resolves. The ledger is present and invisible — never "no table",
    // the shape preflight answers with --baseline — and nothing is queried.
    await sql.unsafe(`ALTER ROLE brain_reader SET search_path = nowhere`);
    const lost = new SQL({ url: roleUrl, max: 1 });
    try {
      const f = await readDatabaseFacts(lost);
      assert(f.ledger.present === true && f.ledger.names === null && f.unread.ledger?.reason === "invisible" && /schema public/.test(f.unread.ledger?.message ?? ""),
        `a ledger off this role's search path is present and invisible, not absent (${f.unread.ledger?.message})`);
      assert(f.unread["counts.thoughts"]?.reason === "invisible" && f.unread.ob1_config?.reason === "invisible", "…and so is every table it asks after");
    } finally {
      await lost.close();
    }

    // Another tool's schema_migrations earlier on the role's path shadows the
    // fork's (review pass 4): what resolves is not the ledger — no sha256 —
    // so the fork's is invisible, not "read" and failing with 42703.
    await sql.unsafe(`CREATE SCHEMA e2e_shadow`);
    await sql.unsafe(`CREATE TABLE e2e_shadow.schema_migrations (version text PRIMARY KEY)`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA e2e_shadow TO brain_reader`);
    await sql.unsafe(`GRANT SELECT ON e2e_shadow.schema_migrations TO brain_reader`);
    await sql.unsafe(`ALTER ROLE brain_reader SET search_path = e2e_shadow, public`);
    const shadowed = new SQL({ url: roleUrl, max: 1 });
    try {
      const f = await readDatabaseFacts(shadowed);
      assert(f.unread.ledger?.reason === "invisible" && /schema public/.test(f.unread.ledger?.message ?? "") && /reaches e2e_shadow\.schema_migrations first/.test(f.unread.ledger?.message ?? "")
          && f.highestMigration === null && f.schemaVersion === FORK_VERSION,
        `a foreign schema_migrations ahead on the path is not the ledger; the fork's is invisible behind it (${JSON.stringify(f.unread.ledger)})`);
    } finally {
      await shadowed.close();
      await sql.unsafe(`DROP TABLE e2e_shadow.schema_migrations`);
      await sql.unsafe(`REVOKE USAGE ON SCHEMA e2e_shadow FROM brain_reader`);
      await sql.unsafe(`DROP SCHEMA e2e_shadow`);
    }
  } finally {
    await sql.unsafe(`REVOKE ALL ON thoughts, thought_audit, ob1_config FROM brain_reader`);
    await sql.unsafe(`REVOKE USAGE ON SCHEMA public FROM brain_reader`);
    await sql.unsafe(`DROP ROLE brain_reader`);
  }

  // An index built WITH its own parameters is read as built, not as pgvector's defaults.
  await sql.unsafe(`CREATE INDEX e2e_hnsw_tuned ON thought_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 24, ef_construction = 100)`);
  const tuned = ((await health("e2e-key") as Record<string, any>).database?.hnsw ?? []).find((h: { index: string }) => h.index === "e2e_hnsw_tuned");
  assert(tuned?.m === 24 && tuned?.efConstruction === 100, `an index built WITH (m = 24, ef_construction = 100) reports 24/100 (${JSON.stringify(tuned)})`);
  await sql.unsafe(`DROP INDEX e2e_hnsw_tuned`);

  // A migration holding three tables at once (review pass 2: the per-read
  // budgets then added past the deadline and the whole database half was
  // lost). Each locked count is a timeout; everything else answers, inside the
  // deadline. Ten concurrent probes share one read — one backend waits on the
  // lock, not ten.
  {
    const unlock = await holdLocks("thoughts, thought_audit, thought_chunks");
    try {
      const t0 = performance.now();
      const probes = Array.from({ length: 10 }, () => health("e2e-key") as Promise<Record<string, any>>);
      // Sampled until the probes answer, not once at a guessed moment (review
      // pass 3: a slow runner could sample before the read reached the lock).
      const bodies = await sampleWhile(Promise.all(probes), "%count(*)::float8 AS n FROM thought%");
      const waiting = bodies.maxWaiting;
      const took = performance.now() - t0;
      const d = bodies[0].database ?? {};
      const locked = ["thoughts", "thought_audit", "thought_chunks"].every((t) => d.unread?.[`counts.${t}`]?.reason === "timeout");
      assert(locked && d.counts?.ob1_entities === truth.entities && d.highestMigration === treeLast - 1 && d.pgvector?.version === truth.vec && took < 2500,
        `three locked tables are three timed-out counts and the rest answer, in ${Math.round(took)} ms (${JSON.stringify(d.unread)})`);
      assert(waiting === 1 && bodies.every((b) => JSON.stringify(b) === JSON.stringify(bodies[0])), `ten concurrent probes share one read: at most ${waiting} backend(s) waiting on the lock, one body`);

      // A probe while the tool's read is in flight has a read of its own, at
      // the health ceilings (review pass 3: keyed by deadline alone, a shared
      // entry would hand it the tool's 15 s deadline and 1 s lock waits).
      const tool = call("brain_info");
      await Bun.sleep(100);
      const p0 = performance.now();
      const probe = await health("e2e-key") as Record<string, any>;
      const probeTook = performance.now() - p0;
      const toolText = await tool;
      assert(probe.database?.unread?.["counts.thought_audit"]?.reason === "timeout" && probeTook < 1800 && /^Rows: +\? thoughts · \? audit events · \? chunks/m.test(toolText),
        `a probe during the tool's read answers from its own, at the health ceilings (${Math.round(probeTook)} ms)`);
    } finally {
      await unlock();
    }
  }

  await sql`DELETE FROM schema_migrations`;

  // Keyless stays the literal against a live database too, and a key revoked in
  // the registry is shown nothing here, as at the MCP route.
  assert(await health(null) === "ok", "no key → `ok`, with a live database behind it");
  await call("thought_stats", {}, "bot-raw"); // registers bot-key in the registry, as any first request does
  await sql`SELECT revoke_agent_key(${hashKey("bot-raw")}, 'SMD-2041 e2e')`;
  assert(await health("bot-raw") === "ok", "a revoked write key → `ok`, not the record");
  // The registry's tables locked: its lookup's lock wait is capped at 1 s
  // (SMD-2072), so every key answers well inside the deadline. A key this
  // process has had an answer for keeps it: the revoked one is still shown
  // nothing, the good one the record (before the cap, both waited out the
  // deadline and got `ok`; review pass 2 of SMD-2041: a revoked key read the
  // whole record while the lock lasted).
  const lockWaits = async () => (await sql`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%resolve_agent%'`)[0].n as number;
  {
    const unlock = await holdLocks("ob1_agents, ob1_agent_keys");
    try {
      const t0 = performance.now();
      const revoked = await health("bot-raw");
      const r1 = performance.now() - t0;
      const good = await health("op-raw") as Record<string, any>;
      const r2 = performance.now() - t0 - r1;
      assert(revoked === "ok" && r1 < 2000, `with the registry locked, a key it had revoked is still shown nothing, at the lookup's cap and not the deadline (${Math.round(r1)} ms)`);
      assert(typeof good === "object" && good.version === FORK_VERSION && r2 < 2000, `…and a key it had answered for is shown the record (${typeof good === "object" ? "the record" : JSON.stringify(good)}, ${Math.round(r2)} ms)`);
      // A burst of probes with one key shares its one lookup (SMD-2041 review
      // pass 3: ten probes emptied the pool while /health said ok), and each
      // lookup gives up at the cap: none is left waiting on the lock.
      const burst = await sampleWhile(Promise.all(Array.from({ length: 10 }, () => health("op-raw"))), "%resolve_agent%");
      assert(burst.every((b) => typeof b === "object" && JSON.stringify(b) === JSON.stringify(burst[0])) && burst.maxWaiting === 1,
        `ten probes of one key during a registry lock share its one lookup (at most ${burst.maxWaiting} waiting on the lock)`);
      const after = await lockWaits();
      assert(after === 0, `…and no lookup is still waiting on the lock once they have answered (${after})`);
      // The MCP route likewise: the revoked key is refused while the lock lasts.
      // Guarded: an uncapped lookup waits for the unlock below, which never came.
      const refusal = call("thought_stats", {}, "bot-raw").then(() => "served", (e) => String((e as Error).message));
      const refused = await Promise.race([refusal, Bun.sleep(4000).then(() => "no answer in 4000 ms")]);
      assert(/revoked/.test(refused), `…and the MCP route still refuses the revoked key (${refused.slice(0, 80)})`);
    } finally {
      await unlock();
    }
  }

  // More cold keys than the pool has connections, each capturing while
  // ob1_agent_keys is locked — ob1_agents stays open, since every write reads
  // a writer's kind from it (046's audit trigger). Before the cap each lookup
  // held its connection until the lock cleared: ten of them emptied the pool
  // and every request stalled, the writes that needed no registry included.
  // Now each lookup gives up at 1 s and the capture lands attributed by name.
  // A guard of its own, so a stall fails the assertion rather than the suite.
  {
    const unlock = await holdLocks("ob1_agent_keys");
    let all: Promise<number[]> = Promise.resolve([]);
    try {
      const t0 = performance.now();
      all = Promise.all(COLD_KEYS.map((k) => call("capture_thought", { content: `SMD-2072 capture by ${k} while the registry is locked` }, `${k}-raw`).then(() => performance.now() - t0)));
      const took = await Promise.race([all, Bun.sleep(8000).then(() => null)]);
      assert(took !== null && Math.max(...took) < 5000,
        `${COLD_KEYS.length} cold keys, more than the pool's connections, each capture while the registry is locked (slowest ${took ? Math.round(Math.max(...took)) : "none answered in 8000"} ms)`);
      const rows = await sql`
        SELECT actor_name, canonical_agent_id::text AS agent FROM thought_audit
         WHERE action = 'capture' AND actor_name = ANY(${sql.array(COLD_KEYS, "TEXT")}::text[])`;
      assert(rows.length === COLD_KEYS.length && rows.every((r: { agent: string | null }) => r.agent === null),
        `…each attributed by its key's name alone (${rows.length} capture rows, ${rows.filter((r: { agent: string | null }) => r.agent !== null).length} with an agent id)`);
      const after = await lockWaits();
      assert(after === 0, `…and no lookup is still waiting on the lock (${after})`);
    } finally {
      await unlock();
      await all.catch(() => {});
    }
    // Once the lock clears the registry answers again: a cold key gets its id.
    await call("thought_stats", {}, `${COLD_KEYS[0]}-raw`);
    const [reg] = await sql`SELECT count(*)::int AS n FROM ob1_agent_keys WHERE key_hash = ${hashKey(COLD_KEYS[0] + "-raw")}`;
    assert(reg.n === 1, "…and once the lock clears, a cold key is registered on its next request");
  }

  // A transaction holding the keys' rows, not the tables: a revoked key is
  // refused at once, since its revocation is read before the UPDATE that
  // waits; a good key's UPDATE waits out the cap and it keeps its last answer.
  {
    const locker = new SQL({ url: URL_, max: 1 });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => { locked = r; });
    const tx = locker.begin(async (t) => {
      await t`SELECT 1 FROM ob1_agent_keys FOR UPDATE`;
      locked();
      await held;
    });
    await isLocked;
    try {
      const t0 = performance.now();
      const revoked = await health("bot-raw");
      const r1 = performance.now() - t0;
      const good = await health("op-raw") as Record<string, any>;
      const r2 = performance.now() - t0 - r1;
      assert(revoked === "ok" && r1 < 500, `with the keys' rows held, a revoked key is refused without waiting (${Math.round(r1)} ms)`);
      assert(typeof good === "object" && r2 >= 900 && r2 < 2000, `…and a good key's lookup waits out the 1 s cap and it keeps its last answer (${Math.round(r2)} ms)`);
    } finally {
      release();
      await tx;
      await locker.close();
    }
  }
  await sql.close();
}

server.stop();
globalThis.fetch = realFetch;

report();
