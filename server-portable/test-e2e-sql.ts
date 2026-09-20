#!/usr/bin/env bun
/**
 * test-e2e-sql.ts — the whole server, over MCP, backed by SQL, against real Postgres.
 *
 * test-store-sql.ts proves the store's methods behave. This proves the thing that
 * actually matters for Phase 2: an MCP client calling the documented tools gets the
 * same answers with PostgREST removed entirely. It drives the real server through
 * real JSON-RPC, with OB1_STORE unset — the SQL store is the default (change
 * 94) and this suite is what proves it — and no Supabase anywhere.
 *
 * The embedding provider is stubbed — the point is the data layer, and hitting
 * OpenRouter would make the suite non-hermetic and cost money. Everything below
 * the tool boundary is real.
 *
 *   ../db/with-postgres.sh bun test-e2e-sql.ts
 */

import { SQL } from "bun";
import { createAssert, plantLegacyRow, resetSchema } from "../db/test-support.ts";
import { join, dirname } from "node:path";
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

// OB1_STORE is UNSET on purpose (change 94, SMD-1797): the SQL store is the
// default, and this suite — the whole server over MCP against real Postgres —
// is what proves it. Setting it here would let the default drift back to
// PostgREST with every test still green.
delete process.env.OB1_STORE;
process.env.DATABASE_URL = URL_;
process.env.OPENROUTER_API_KEY = "stub";
process.env.MCP_ACCESS_KEY = "e2e-key";
// The query log (034, SMD-1295) is read once at first request and frozen, as in
// production (set at boot, not toggled per request). On for the whole suite so
// [N] can exercise the real write+join path; the OFF guarantee — that the guard
// writes nothing when unset — is a pure unit test in test-server.ts.
process.env.OB1_QUERY_LOG = "on";
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
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: H,
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
  assert(b.result?.tools?.length === 10, `all ten tools still registered (${b.result?.tools?.length})`);
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
  assert(/Refused: a `derived_from` id names no thought — \(in \["00000000-0000-0000-0000-000000000000"\]\)\./.test(refused), `a well-formed derived_from id naming no thought is refused in the tool's words too (${refused.slice(0, 90)})`);
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
    assert(!/1970/.test(listed) && !/Invalid Date/.test(listed), `list_thoughts prints no fabricated date (${listed.replace(/\n/g, " ⏎ ")})`);
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

server.stop();
globalThis.fetch = realFetch;

report();
