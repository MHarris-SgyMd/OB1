#!/usr/bin/env bun
/**
 * test-local-provider.ts — the fully local path: no OpenRouter, no API key.
 *
 * Proves the provider is a configuration choice rather than a hard dependency:
 * the server sends both calls to OB1_LLM_BASE_URL, uses OB1_EMBEDDING_MODEL and
 * OB1_METADATA_MODEL, and sends NO Authorization header when no key is set.
 * [8] is the other half: with OB1_CHAT_BASE_URL / OB1_CHAT_API_KEY the chat
 * calls go to an endpoint of their own with its own credential (SMD-1902), and
 * [9] gives the supersession judge a model of its own, OB1_JUDGE_MODEL, while
 * the extractor keeps OB1_METADATA_MODEL (SMD-1901).
 *
 * The stub speaks the OpenAI-compatible shapes Ollama exposes at /v1. It asserts
 * on what the server SENDS as much as what it does with the reply, because that is
 * the part a real Ollama would judge.
 *
 * What this does not prove: that Ollama itself honours `response_format:
 * {type:"json_object"}` on your version. `preflight.ts --deep` checks that against
 * the real endpoint — run it after pointing at a live Ollama.
 *
 *   ../db/with-postgres.sh bun test-local-provider.ts
 */

import { SQL } from "bun";
import type { ExtractWindowObservation } from "./entities.ts";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { assert, report } = createAssert();

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-local-provider.ts");
  process.exit(2);
}

const DIM = 768;                        // nomic-embed-text
const EMB_MODEL = "nomic-embed-text";
const META_MODEL = "llama3.2";

function subst(sql: string): string {
  return sql.replace(/\{\{EMBEDDING_DIM\}\}/g, String(DIM)).replace(/\{\{EMBEDDING_MODEL\}\}/g, EMB_MODEL);
}


// Schema at 768.
await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });

// ── A stand-in for Ollama's /v1 surface ─────────────────────────────────────
type Seen = { path: string; auth: string | null; model: string; jsonMode: boolean };
const seen: Seen[] = [];

/**
 * Width the stub replies with. Mutable so the mismatch case can be exercised
 * without changing OB1_LLM_BASE_URL — env() caches on first use (that is what
 * makes the file Workers-compatible), so a mid-run URL change does nothing.
 */
let replyDim = DIM;

/** The last body the server POSTed to /embeddings, so the test can assert on it. */
let lastEmbedBody: Record<string, unknown> = {};


/** Type the stub's metadata model claims. Real llama3.2 returned "action_item". */
let replyType = "idea";

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as { model: string; input?: string; response_format?: { type: string } };
    seen.push({
      path: url.pathname,
      auth: req.headers.get("authorization"),
      model: body.model,
      jsonMode: body.response_format?.type === "json_object",
    });

    if (url.pathname.endsWith("/embeddings")) {
      lastEmbedBody = body as Record<string, unknown>;
      // Honour `dimensions` the way Ollama and OpenAI do, so the test exercises a
      // provider that supports it; `ignoreDimensions` models one that does not.
      const v = new Array(replyDim).fill(0);
      v[String(body.input ?? "").length % replyDim] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ topics: ["local"], type: replyType, people: [] }) } }],
    });
  },
});
const PROVIDER = `http://127.0.0.1:${provider.port}/v1`;

// ── Boot the server pointed at it, with NO credential anywhere ──────────────
process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = PROVIDER;
// Declared local to the egress gate (SMD-1903): the stub is on this box, and
// the gate reads the flag, never the address — without it the default, deny,
// refuses every call to it. test-egress.ts holds that case.
process.env.OB1_LLM_LOCAL = "1";
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_METADATA_MODEL = META_MODEL;
process.env.MCP_ACCESS_KEY = "local-key";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OB1_LLM_API_KEY;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": "local-key" };

let id = 1;
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await fetch(BASE, { method: "POST", headers: H,
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const b = JSON.parse(line);
  const text = (b.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  if (b.error) throw new Error(JSON.stringify(b.error));
  if (b.result?.isError) throw new Error(text);
  return text;
}

console.log(`  provider: ${PROVIDER}  (no OPENROUTER_API_KEY, no OB1_LLM_API_KEY)\n`);

console.log("[1] No OpenRouter credential is present");
{
  assert(process.env.OPENROUTER_API_KEY === undefined, "OPENROUTER_API_KEY is unset");
  assert(process.env.OB1_LLM_API_KEY === undefined, "OB1_LLM_API_KEY is unset");
}

console.log("\n[2] A capture reaches the configured provider, not openrouter.ai");
{
  const out = await call("capture_thought", { content: "a locally embedded thought" });
  assert(/Captured as/.test(out), "capture succeeds against the local provider");
  assert(seen.length === 2, `two provider calls were made (${seen.length})`);

  const emb = seen.find((s) => s.path.endsWith("/embeddings"));
  const chat = seen.find((s) => s.path.endsWith("/chat/completions"));
  assert(emb !== undefined, "an /embeddings call was made");
  assert(chat !== undefined, "a /chat/completions call was made");
  assert(emb!.model === EMB_MODEL, `embeddings used OB1_EMBEDDING_MODEL (${emb!.model})`);
  assert(chat!.model === META_MODEL, `metadata used OB1_METADATA_MODEL (${chat!.model})`);
  assert(chat!.jsonMode, "metadata extraction still requests JSON mode");
}

console.log("\n[3] No Authorization header is sent to a keyless provider");
{
  // Sending `Bearer undefined` would be harmless to Ollama but misleading in
  // logs, and would leak the fact that the server thinks it has a credential.
  for (const s of seen) assert(s.auth === null, `${s.path} carried no Authorization header`);
}

console.log("\n[4] The 768-dimension vector really landed in Postgres");
{
  const sql = new SQL({ url: URL_, max: 1 });
  const [row] = await sql`SELECT metadata, embedding IS NOT NULL AS has,
    vector_dims(embedding) AS dims FROM thoughts`;
  assert(row.has === true, "the embedding was stored");
  assert(Number(row.dims) === DIM, `stored vector is ${row.dims} dimensions`);
  assert(row.metadata?.topics?.[0] === "local", `metadata came from the local model (${JSON.stringify(row.metadata?.topics)})`);
  const [cfg] = await sql`SELECT value FROM ob1_config WHERE key = 'embedding_dim'`;
  assert(cfg.value === String(DIM), `ob1_config records ${cfg.value}`);
  await sql.close();
}

console.log("\n[5] Search works end to end with no external service");
{
  await call("capture_thought", { content: "another locally embedded thought entirely" });
  const out = await call("search_thoughts", { query: "a locally embedded thought", threshold: 0.1, limit: 5 });
  assert(/Found \d+ thought/.test(out), "search returns results");
  assert(/locally embedded/.test(out), "…including a captured thought");
  const stats = await call("thought_stats");
  assert(/Total thoughts: 2/.test(stats), "stats agree");
  assert(/local: 2/.test(stats), "the local model's topics are tallied");
}

console.log("\n[6] A width mismatch from the provider is refused, not stored");
{
  // Swapping the embedding model for a same-name-different-width one is the
  // realistic version of this: `ollama pull` a different model, or a provider
  // changing a default. The column cannot hold it and the row must not be written.
  replyDim = 1536;

  let msg = "";
  try { await call("capture_thought", { content: "wrong width" }); } catch (e) { msg = (e as Error).message; }
  assert(/width mismatch/i.test(msg), `capture refuses a 1536-wide vector for a 768 column (${msg.slice(0, 60)})`);
  assert(/re-embedding/.test(msg), "…and says what changing the model would cost");
  assert(/OB1_EMBEDDING_DIMENSIONS=on/.test(msg),
         "…and points at truncation, since the vector was too WIDE rather than wrong");

  const sql = new SQL({ url: URL_, max: 1 });
  assert((await sql`SELECT count(*)::int AS c FROM thoughts`)[0].c === 2, "no row was written");
  await sql.close();
  replyDim = DIM;
}

console.log("\n[7] `dimensions` is not sent unless asked for");
{
  // A provider applies `dimensions` to any model, including ones never trained for
  // Matryoshka truncation, and returns a shorter vector with no error — so sending
  // it unasked would quietly degrade retrieval. The opt-in path is covered by
  // test-embedding-dimensions.ts, which needs its own process: the server snapshots
  // the environment once at boot so Workers bindings behave, and a mid-run change
  // to process.env does nothing.
  assert(!("dimensions" in lastEmbedBody),
         "off by default: the server does not send `dimensions` unasked");
}

console.log("\n[7b] A drifting `type` is normalised, not stored as a new category");
{
  // Observed for real: llama3.2 answered "action_item" for a reminder, which is
  // not in the enum the prompt asks for. Unenforced, that silently fragments the
  // taxonomy — list_thoughts(type: "task") misses the row and thought_stats grows
  // a tail of one-off types that look like categories.
  const sql = new SQL({ url: URL_, max: 1 });
  await sql`DELETE FROM thoughts`;

  replyType = "action_item";
  await call("capture_thought", { content: "an aliased type" });
  const [aliased] = await sql`SELECT metadata FROM thoughts WHERE content = ${"an aliased type"}`;
  assert(aliased.metadata?.type === "task", `action_item maps to task (${aliased.metadata?.type})`);
  assert(aliased.metadata?.type_raw === "action_item", "…and the model's original answer is kept in type_raw");

  replyType = "Cromulent Thing";
  await call("capture_thought", { content: "an invented type" });
  const [invented] = await sql`SELECT metadata FROM thoughts WHERE content = ${"an invented type"}`;
  assert(invented.metadata?.type === "observation", `an unknown type falls back to observation (${invented.metadata?.type})`);
  assert(invented.metadata?.type_raw === "Cromulent Thing", "…with the original preserved so drift stays visible");

  replyType = "TASK";
  await call("capture_thought", { content: "a shouty type" });
  const [shouty] = await sql`SELECT metadata FROM thoughts WHERE content = ${"a shouty type"}`;
  assert(shouty.metadata?.type === "task", "case is normalised");
  assert(shouty.metadata?.type_raw === undefined, "…and an exact match after normalising records no type_raw");

  // The point of all of it: filtering works.
  const listed = await call("list_thoughts", { limit: 10, type: "task" });
  assert(/2 recent thought/.test(listed), `list_thoughts type=task finds both (${listed.split("\n")[0]})`);

  await sql.close();
  replyType = "idea";
}

console.log("\n[8] The chat calls have an endpoint of their own only when OB1_CHAT_BASE_URL or OB1_CHAT_API_KEY says so (SMD-1902)");
{
  // Function-level, not through the server: the server snapshots its
  // environment once at boot (see [7]), so a second configuration needs a
  // second process — and what is under test here is the resolver and the
  // three diallers, which take the configuration as an argument. Cases [2]
  // and [3] above are the server-level half: with neither chat knob set both
  // calls went to one endpoint, keyless, exactly as before the split.
  const { resolveEmbedConfig, providerCall, ProviderError } = await import("./embed.ts");
  const { judgePair } = await import("./consolidate.ts");
  const { extractEntities } = await import("./entities.ts");

  // A second stand-in with its own log, so where each call landed is a fact
  // about the request and not about the reply.
  const seenB: { path: string; auth: string | null }[] = [];
  let failB = false;
  const providerB = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      await req.json();
      seenB.push({ path: url.pathname, auth: req.headers.get("authorization") });
      if (failB) return new Response("chat is down", { status: 503 });
      return Response.json(url.pathname.endsWith("/embeddings")
        ? { data: [{ embedding: [1, 0, 0] }] }
        : { choices: [{ message: { content: JSON.stringify({ verdict: "unrelated", confidence: 0.9, reason: "", entities: [], relations: [] }) } }] });
    },
  });
  const A = PROVIDER;
  const B = `http://127.0.0.1:${providerB.port}/v1`;
  const chatBody = { model: META_MODEL, messages: [{ role: "user", content: "x" }] };
  const embBody = { model: EMB_MODEL, input: "x" };
  // Both stubs declared local to the egress gate (SMD-1903), as the boot
  // environment declares A; what is under test here is where a call lands.
  const LOCAL = { OB1_LLM_LOCAL: "1", OB1_CHAT_LOCAL: "1" };
  const SUBJ = { kind: "capture" as const };
  const lastA = () => seen[seen.length - 1];
  const lastB = () => seenB[seenB.length - 1];

  // Neither chat knob: one endpoint, one key — the request of every deployment
  // that predates the split. Remove the fallback in resolveProviderEndpoints
  // and these fail.
  const one = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: A, OB1_LLM_API_KEY: "key-a" });
  assert(one.chat.base === A && one.embeddings.base === A, "with no chat knob the chat endpoint IS the embeddings endpoint");
  assert(one.chat.headers.Authorization === "Bearer key-a", "…with the same credential");
  const beforeA = seen.length, beforeB = seenB.length;
  await providerCall(one, "/chat/completions", chatBody, SUBJ);
  assert(seen.length === beforeA + 1 && seenB.length === beforeB, "a chat call under one endpoint lands on it");
  assert(lastA().path.endsWith("/chat/completions") && lastA().auth === "Bearer key-a", "…carrying the embeddings key");

  // Both set: each path lands on its own endpoint with its own header.
  const two = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: A, OB1_LLM_API_KEY: "key-a", OB1_CHAT_BASE_URL: B, OB1_CHAT_API_KEY: "key-b" });
  await providerCall(two, "/embeddings", embBody, SUBJ);
  assert(lastA().path.endsWith("/embeddings") && lastA().auth === "Bearer key-a", "embeddings land on OB1_LLM_BASE_URL with OB1_LLM_API_KEY");
  await providerCall(two, "/chat/completions", chatBody, SUBJ);
  assert(lastB().path.endsWith("/chat/completions") && lastB().auth === "Bearer key-b", "chat lands on OB1_CHAT_BASE_URL with OB1_CHAT_API_KEY");
  const nA = seen.length, nB = seenB.length;
  await judgePair({ content: "older", createdAt: null }, { content: "newer", createdAt: null }, two);
  await extractEntities("Ada met Grace in London", two, undefined, SUBJ);
  assert(seen.length === nA && seenB.length === nB + 2, "the supersession judge and the entity extractor dial the chat endpoint too, never the embeddings one");
  assert(seenB.slice(-2).every((s) => s.path.endsWith("/chat/completions") && s.auth === "Bearer key-b"), "…with its credential");

  // A credential belongs to an endpoint: a different chat base is sent none
  // unless it has its own; the same base spelled again shares the key; a chat
  // key alone gives the shared endpoint a chat-only credential.
  const own = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: A, OB1_LLM_API_KEY: "key-a", OB1_CHAT_BASE_URL: B });
  await providerCall(own, "/chat/completions", chatBody, SUBJ);
  assert(lastB().auth === null, "a different chat endpoint with no OB1_CHAT_API_KEY is sent NO credential — OB1_LLM_API_KEY stays with the embeddings endpoint");
  const same = resolveEmbedConfig({ OB1_LLM_BASE_URL: A, OB1_LLM_API_KEY: "key-a", OB1_CHAT_BASE_URL: `${A}/` });
  assert(same.chat.base === A && same.chat.headers.Authorization === "Bearer key-a", "the same base spelled twice is one endpoint and shares the key");
  const keyed = resolveEmbedConfig({ OB1_LLM_BASE_URL: A, OB1_CHAT_API_KEY: "key-c" });
  assert(keyed.chat.base === A && keyed.chat.headers.Authorization === "Bearer key-c" && keyed.embeddings.headers.Authorization === undefined,
         "OB1_CHAT_API_KEY alone gives the same endpoint a chat-only credential, and the embeddings call stays keyless");

  // A failure names the endpoint that was dialled.
  failB = true;
  let msg = "";
  try {
    await providerCall(two, "/chat/completions", chatBody, SUBJ);
  } catch (e) {
    msg = (e as Error).message;
    assert(e instanceof ProviderError && e.status === 503, "a chat failure is a ProviderError carrying its status");
  }
  assert(msg.includes(B) && !msg.includes(A), `a chat failure names the chat endpoint, not the embeddings one (${msg.slice(0, 80)})`);
  failB = false;
  providerB.stop();
}

console.log("\n[9] The supersession judge has a model of its own — OB1_JUDGE_MODEL, else the metadata model (SMD-1901)");
{
  // Function-level for the reason [8] gives. One stand-in that logs the model
  // each chat request names, so which knob a dialler read is a fact about the
  // request; its one reply parses as a judgement and as an extraction alike.
  const { resolveEmbedConfig } = await import("./embed.ts");
  const { judgePair, consolidateKey } = await import("./consolidate.ts");
  const { extractEntities } = await import("./entities.ts");
  const models: { path: string; model: string }[] = [];
  const providerC = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string };
      models.push({ path: new URL(req.url).pathname, model: body.model });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "unrelated", supersedes: "unknown", confidence: 0.9, reason: "", entities: [], relations: [] }) } }] });
    },
  });
  const C = `http://127.0.0.1:${providerC.port}/v1`;
  const older = { content: "older", createdAt: null };
  const newer = { content: "newer", createdAt: null };
  const last = () => models[models.length - 1];

  // Unset: the judge runs on the metadata model, under the pass key every pass
  // before the knob pooled under — the request of every deployment that
  // predates it. Remove the fallback in resolveEmbedConfig and these fail.
  // Declared local, as every stub in this file is; the gate is test-egress.ts's.
  const shared = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: C, OB1_METADATA_MODEL: META_MODEL });
  assert(shared.judgeModel === META_MODEL, "OB1_JUDGE_MODEL unset: the judge model IS the metadata model");
  await judgePair(older, newer, shared);
  assert(last().path.endsWith("/chat/completions") && last().model === META_MODEL, `…and the judge request names it (${last().model})`);
  assert(consolidateKey(shared.judgeModel) === consolidateKey(META_MODEL), "…under the metadata model's pass key");
  assert(resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: C, OB1_METADATA_MODEL: META_MODEL, OB1_JUDGE_MODEL: "" }).judgeModel === META_MODEL,
         "an empty OB1_JUDGE_MODEL means unset, as for every knob embed.ts reads");

  // Set: on ONE configuration the judge names its model and the extractor
  // keeps the metadata model — the split the ticket exists for.
  const split = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: C, OB1_METADATA_MODEL: META_MODEL, OB1_JUDGE_MODEL: "big-judge" });
  assert(split.judgeModel === "big-judge" && split.metadataModel === META_MODEL, "OB1_JUDGE_MODEL set: the judge model is its own and the metadata model is untouched");
  await judgePair(older, newer, split);
  await extractEntities("Ada met Grace in London", split, undefined, { kind: "extraction" });
  const [judge, extract] = models.slice(-2);
  assert(judge.model === "big-judge", `the judge request names OB1_JUDGE_MODEL (${judge.model})`);
  assert(extract.model === META_MODEL, `…while the entity extractor's, on the same configuration, names OB1_METADATA_MODEL (${extract.model})`);
  assert(consolidateKey(split.judgeModel) !== consolidateKey(shared.judgeModel), "a judge-model change is a new pass key, so an earlier model's judgements are not reused as this one's");
  providerC.stop();
}

console.log("\n[10] A long thought is extracted in windows of the metadata model's size, each call budgeted, and the windows' answers merged (SMD-1879)");
{
  // Function-level, as [8] and [9]. A stand-in that answers from what each
  // request carries — the entity named in the text it was sent, plus the
  // subject every window names — and REFUSES a request over a ceiling, the way
  // test-chunking.ts's embedder does: if the windowing ever stops, [10] fails
  // on the refusal rather than passing on a call that happened to fit.
  const { resolveEmbedConfig } = await import("./embed.ts");
  const { extractEntities, windowingFor } = await import("./entities.ts");
  const { chunkContent, estimateTokens } = await import("./chunk.ts");
  const { extractOutputBudget } = await import("../db/config.mjs");
  type Req ={ text: string; maxTokens: number | undefined; part: string | undefined };
  const reqs: Req[] = [];
  const CEILING = 700; // estimated tokens of thought text the stub accepts per call
  let prose = false;
  /** Set, a window whose text it matches is answered in prose, and the others as usual (SMD-2260). */
  let proseIf: RegExp | null = null;
  const providerD = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { messages: { content: string }[]; max_tokens?: number };
      const user = body.messages[0].content;
      const inner = /<thought_content>\n([\s\S]*)\n<\/thought_content>/.exec(user)?.[1] ?? "";
      const part = /^\[Part [^\]]*\]/.exec(inner)?.[0];
      const text = part ? inner.slice(part.length).trimStart() : inner;
      reqs.push({ text, maxTokens: body.max_tokens, part });
      if (estimateTokens(text) > CEILING) return new Response(JSON.stringify({ error: { message: `input too long: ${estimateTokens(text)} tokens` } }), { status: 400 });
      if (prose || proseIf?.test(text)) return Response.json({ choices: [{ message: { content: "I cannot help with that." } }] });
      // The subject "Open Brain" is in every window; each window also names one
      // person of its own — Anita in the first, Dev in the second, and so on.
      const person = /(Anita|Dev|Priya|Sam)/.exec(text)?.[1];
      const entities: unknown[] = [{ name: "Open Brain", type: "project", confidence: 0.8 + (person === "Dev" ? 0.1 : 0), aliases: person === "Dev" ? ["OB1"] : [] }];
      const relationships: unknown[] = [];
      if (person) { entities.push({ name: person, type: "person", confidence: 0.9 }); relationships.push({ from: person, to: "Open Brain", relation: "works_on", confidence: 0.7 }); }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ entities, relationships }) } }] });
    },
  });
  const D = `http://127.0.0.1:${providerD.port}/v1`;
  const para = (who: string, n: number) => `${who} wrote about Open Brain. ${Array.from({ length: n }, (_, i) => `Sentence ${i} of this paragraph says nothing new about it.`).join(" ")}`;
  // Four paragraphs of ~330 estimated tokens each: 1,320 in all, over a 600-token
  // window and over the stub's 700-token ceiling as one call.
  const long = [para("Anita", 40), para("Dev", 40), para("Priya", 40), para("Sam", 40)].join("\n\n");
  const short = "Anita wrote about Open Brain.";
  assert(estimateTokens(long) > CEILING && estimateTokens(short) < 100, `the long thought (${estimateTokens(long)} tokens) is over the stub's ceiling and the short one is not`);

  // The configuration's window: an explicit 600 for the stub's model, which
  // the table does not list, so the rule the worker reads is the one exercised.
  const cfgD = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: D, OB1_METADATA_MODEL: "stub-chat", OB1_EXTRACT_CHUNK_TOKENS: "600" });
  const w = windowingFor(cfgD);
  assert(w.windowTokens === 600 && w.overlapTokens === 75 && w.outputBudget, "the windowing the worker runs under is the configuration's: 600-token windows, 75 overlap, an answer budget");

  const one = await extractEntities(short, cfgD, undefined, { kind: "extraction" });
  assert(reqs.length === 1 && one.windows === 1 && one.parts === undefined, "a thought within the window is one call, with no per-window record");
  assert(reqs[0].part === undefined && reqs[0].text === short, "…the p1 request: the text alone, no part marker");
  assert(reqs[0].maxTokens === extractOutputBudget(estimateTokens(short)), `…carrying the answer budget for its own length (${reqs[0].maxTokens})`);

  reqs.length = 0;
  // Caught, not thrown: with the windowing removed the stub refuses the one
  // oversized call, and that must be a counted failure here, not a crash of
  // the suite (a mutant run found the crash and no red line).
  let many: Awaited<ReturnType<typeof extractEntities>>;
  try {
    many = await extractEntities(long, cfgD, undefined, { kind: "extraction" });
  } catch (e) {
    assert(false, `the long thought went to the stub in one call and was refused — the windowing is gone (${(e as Error).message.slice(0, 80)})`);
    providerD.stop();
    throw e;
  }
  assert(reqs.length >= 3 && many.windows === reqs.length, `the long thought is ${reqs.length} calls, one per window, and the answer says so (windows ${many.windows})`);
  assert(reqs.every((r) => estimateTokens(r.text) <= 600), "every call carries at most a window of text — the stub would have refused more");
  assert(reqs.every((r, i) => r.part === `[Part ${i + 1} of ${reqs.length} of a longer note]`), `each window says which part it is (${reqs.map((r) => r.part).join(" | ")})`);
  assert(reqs.every((r) => r.maxTokens === extractOutputBudget(estimateTokens(r.text))), "each call's answer budget follows the text it carries, not the whole thought's");
  const subject = many.entities.filter((e) => e.type === "project");
  assert(subject.length === 1 && subject[0].name === "Open Brain" && subject[0].confidence === 0.9 && subject[0].aliases.includes("OB1"),
         `a subject every window names is ONE entity in the merged answer, at the best confidence with the aliases any window offered (${JSON.stringify(subject)})`);
  const people = many.entities.filter((e) => e.type === "person").map((e) => e.name).sort();
  assert(people.join(",") === "Anita,Dev,Priya,Sam", `…and each window's own person is there once (${people.join(",")})`);
  assert(many.relations.length === 4 && many.relations.every((r) => r.to === "Open Brain" && r.relation === "works_on"), "the four works_on edges, one per window, all to the one subject");
  assert(many.parts?.length === reqs.length && many.parts.every((p, i) => p.index === i && p.entities.length === 2 && p.tokens <= 600 && p.ms >= 0), "the per-window record keeps what each call returned, in order, with its size and time");

  // SMD-2269: the two measurement hooks — budgetTimes scales the answer budget,
  // observe surfaces each window's finish reason and a raw-answer sample. Neither
  // is set by windowingFor, so the worker's call above is unchanged; an eval
  // passes them explicitly to measure a larger budget and diagnose why a
  // reference-list window fails JSON. Run with retryRunaway off (windowingFor
  // leaves it off for this stub's model), so each window is one observed call.
  reqs.length = 0;
  const obs: ExtractWindowObservation[] = [];
  const scaled = await extractEntities(long, cfgD, undefined, { kind: "extraction" }, { ...windowingFor(cfgD), budgetTimes: 2, observe: (r: ExtractWindowObservation) => obs.push(r) });
  assert(reqs.length >= 3 && reqs.every((r) => r.maxTokens === Math.ceil(extractOutputBudget(estimateTokens(r.text)) * 2)),
         `budgetTimes: 2 doubles every call's answer budget over its own text (${reqs.map((r) => r.maxTokens).join(", ")}) — the base budget would be half (the drop-the-multiplier control)`);
  assert(obs.length === reqs.length && obs.every((o, i) => o.index === i && o.of === reqs.length && o.tokens <= 600 && o.budget === reqs[i].maxTokens),
         `observe fired once per window, in order, each with its own text's tokens and the budget the call requested (${obs.map((o) => o.budget).join(", ")})`);
  assert(!scaled.malformed && obs.every((o) => o.malformed === false && !o.aborted && o.answerSample?.startsWith("{")),
         "…and every window here parsed: observe reports it not malformed, not aborted, with a JSON-opening sample");

  // The diagnosis itself: a window answered in PROSE (the shape SMD-2269 hunts).
  // observe must carry the raw prose so the eval can tell it from wrong-shape
  // JSON — the merged Extraction only says `malformed`, not what the answer was.
  reqs.length = 0;
  obs.length = 0;
  proseIf = /Priya/; // the third window's person, answered "I cannot help with that."
  const mixed = await extractEntities(long, cfgD, undefined, { kind: "extraction" }, { ...windowingFor(cfgD), observe: (r: ExtractWindowObservation) => obs.push(r) });
  const proseWin = obs.find((o) => o.answerSample?.startsWith("I cannot help"));
  assert(proseWin !== undefined && proseWin.malformed === true && !proseWin.aborted,
         "a prose window is observed malformed with its prose sample — not aborted, so the eval reads it as prose, not a runaway");
  assert(obs.filter((o) => o.malformed).length === 1 && mixed.coverage?.malformed?.length === 1 && mixed.coverage.malformed[0] === proseWin!.index,
         `…and only that window: observe's malformed index matches coverage.malformed (${JSON.stringify(mixed.coverage?.malformed)})`);
  proseIf = null;

  // With neither hook the worker's request is the base budget and nothing is
  // observed — the identity guard that budgetTimes/observe are inert by default.
  reqs.length = 0;
  const plain = await extractEntities(long, cfgD, undefined, { kind: "extraction" });
  assert(!plain.malformed && reqs.every((r) => r.maxTokens === extractOutputBudget(estimateTokens(r.text))),
         "unset, budgetTimes leaves the answer budget exactly as extractOutputBudget sizes it — the worker's call");

  // An over-estimate that chunk.ts packs into one window is the whole-thought
  // path — no marker, no per-window record (third review pass).
  reqs.length = 0;
  const padded = `${" ".repeat(2500)}${short}`; // ~632 estimated tokens: over the 600 window, under the stub's 700 ceiling
  assert(estimateTokens(padded) > 600, "the padded thought over-estimates past the window");
  const one2 = await extractEntities(padded, cfgD, undefined, { kind: "extraction" });
  assert(reqs.length === 1 && one2.windows === 1 && one2.parts === undefined && reqs[0].part === undefined, "…and is one unmarked call with no per-window record");

  // A thought over the per-thought bound is extracted over its prefix, not
  // refused (SMD-2240): at most EXTRACT_MAX_WINDOWS windows, in order, and the
  // answer's coverage says how many of how many.
  const { EXTRACT_MAX_WINDOWS } = await import("../db/config.mjs");
  const { boundedWindows, partialCaveat, PARTIAL_CAVEAT_PREFIX } = await import("./entities.ts");
  assert(cfgD.extractMaxWindows === EXTRACT_MAX_WINDOWS && cfgD.extractMaxWindowsFrom === "default" && EXTRACT_MAX_WINDOWS === 24,
         "with OB1_EXTRACT_MAX_WINDOWS unset the bound is the constant, 24 — today's number (the drop-the-env control)");
  reqs.length = 0;
  // Each paragraph of ~330 tokens is its own 600-token window's subject: Anita0 … Anita29.
  const enormous = Array.from({ length: EXTRACT_MAX_WINDOWS + 6 }, (_, i) => para(`Anita${i}`, 40)).join("\n\n");
  const enormousWindows = chunkContent(enormous, { maxTokens: 600, overlapTokens: 75 }).length;
  // Caught, as the long thought's call above is: the refusal this replaced is a red line here, not a crash.
  const prefix = await extractEntities(enormous, cfgD, undefined, { kind: "extraction" }).catch((e: Error) => {
    assert(false, `the over-bound thought was refused, not extracted over its prefix (${e.message.slice(0, 90)})`);
    return { entities: [], relations: [], rejected: { entities: 0, relations: 0 }, malformed: true, windows: 0 } as Awaited<ReturnType<typeof extractEntities>>;
  });
  assert(reqs.length === EXTRACT_MAX_WINDOWS && prefix.windows === EXTRACT_MAX_WINDOWS && !prefix.malformed,
         `a thought of ${enormousWindows} windows is extracted over its first ${EXTRACT_MAX_WINDOWS} — ${reqs.length} calls, not refused and not all ${enormousWindows}`);
  assert(prefix.coverage?.windows === EXTRACT_MAX_WINDOWS && prefix.coverage.of === enormousWindows && prefix.coverage.cut === false,
         `…and its answer says so: ${JSON.stringify(prefix.coverage)}`);
  assert(reqs[0].part === `[Part 1 of ${enormousWindows} of a longer note]` && reqs.every((r, i) => r.part === `[Part ${i + 1} of ${enormousWindows} of a longer note]`),
         `…each call's marker counting the thought's windows, not the prefix's (${reqs[0].part} … ${reqs.at(-1)?.part})`);
  // The stub names "Anita" for every paragraph, so what was SENT says which: the opening in, the tail out.
  const sent = reqs.map((r) => r.text).join("\n");
  assert(sent.includes("Anita0 wrote") && sent.includes("Anita20 wrote") && !sent.includes(`Anita${EXTRACT_MAX_WINDOWS + 5} wrote`),
         "…the thought's opening paragraphs were sent and its last was not — a prefix, in order");
  const caveat = partialCaveat(prefix.coverage!, windowingFor(cfgD));
  assert(caveat === `${PARTIAL_CAVEAT_PREFIX}24 of ${enormousWindows} windows extracted, the thought is over OB1_EXTRACT_MAX_WINDOWS (24); the rest of the thought is not in the graph`,
         `the caveat the worker records names the coverage and the knob (${caveat})`);
  const within = await extractEntities(long, cfgD, undefined, { kind: "extraction" });
  assert(within.coverage === undefined,"a thought within the bound carries no coverage — a whole extraction");

  // OB1_EXTRACT_MAX_WINDOWS overrides the constant, floored; what is not a
  // positive safe integer once floored is unset.
  const cfgCap = (v: string | undefined) => resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: D, OB1_METADATA_MODEL: "stub-chat", OB1_EXTRACT_CHUNK_TOKENS: "600", OB1_EXTRACT_MAX_WINDOWS: v });
  assert(cfgCap("2").extractMaxWindows === 2 && cfgCap("2").extractMaxWindowsFrom === "OB1_EXTRACT_MAX_WINDOWS" && cfgCap("40.9").extractMaxWindows === 40,
         "OB1_EXTRACT_MAX_WINDOWS sets the bound, floored");
  for (const v of [undefined, "", "0", "-3", "0.5", "many", "1e21", "1e308"]) {
    assert(cfgCap(v).extractMaxWindows === 24 && cfgCap(v).extractMaxWindowsFrom === "default", `OB1_EXTRACT_MAX_WINDOWS=${JSON.stringify(v)} is unset: the default, 24`);
  }
  reqs.length = 0;
  const two = await extractEntities(long, cfgCap("2"), undefined, { kind: "extraction" });
  assert(reqs.length === 2 && two.windows === 2 && two.coverage?.windows === 2 && two.coverage.of >= 3 && !two.coverage.cut,
         `under OB1_EXTRACT_MAX_WINDOWS=2 the ${two.coverage?.of}-window thought is two calls, a prefix (${JSON.stringify(two.coverage)})`);
  assert(two.entities.some((e) => e.name === "Anita") && two.entities.some((e) => e.name === "Dev") && !two.entities.some((e) => e.name === "Sam"),
         "…its first two windows' people, not the last one's");
  reqs.length = 0;
  const wide = await extractEntities(enormous, cfgCap("40"), undefined, { kind: "extraction" });
  assert(reqs.length === enormousWindows && wide.coverage === undefined, `…and widened to 40 the ${enormousWindows}-window thought is extracted whole (${reqs.length} calls)`);

  // A thought that is one whitespace-free blob (SMD-1974) is one window
  // chunk.ts cannot split, however long — until SMD-2240 it went to the model
  // whole. The text bound (the bound's windows × the window) holds it: one
  // call, cut to the bound.
  reqs.length = 0;
  const blobCfg = cfgCap("1");
  const blob = "x".repeat(4 * 600 * 5); // ~3,000 estimated tokens, one "word"
  assert(chunkContent(blob, { maxTokens: 600, overlapTokens: 75 }).length === 1, "the blob is one window to chunk.ts — the SMD-1974 shape");
  let blobEx: Awaited<ReturnType<typeof extractEntities>> | undefined;
  let blobErr = "";
  try { blobEx = await extractEntities(blob, blobCfg, undefined, { kind: "extraction" }); } catch (e) { blobErr = (e as Error).message; }
  assert(reqs.length === 1 && estimateTokens(reqs[0].text) <= 600 && reqs[0].text === blob.slice(0, reqs[0].text.length) && reqs[0].text.length > 2000,
         `…is one call of at most the bound's text, its opening (${reqs[0]?.text.length} characters sent of ${blob.length}${blobErr ? `; ${blobErr.slice(0, 80)}` : ""})`);
  assert(blobEx?.coverage?.windows === 1 && blobEx.coverage.of === 1 && blobEx.coverage.cut === true && reqs[0].part === undefined,
         `…and its answer says it was cut (${JSON.stringify(blobEx?.coverage)})`);
  assert(/^partial: 1 of 1 window sent, the last cut short at the text bound, 600 estimated tokens \(1 windows' worth under OB1_EXTRACT_MAX_WINDOWS \(1\)\), which runs chunk\.ts cannot split \(SMD-1974\) used up; the rest/.test(partialCaveat(blobEx!.coverage!, windowingFor(blobCfg))),
         `…with a caveat saying the window was sent cut short at the text bound, which the run used up (${partialCaveat(blobEx!.coverage!, windowingFor(blobCfg)).slice(0, 80)})`);
  // Review pass 2's cases. Unspaced prose chunk.ts cannot split at a
  // sentence (CJK: 。 is no sentence end to it) sits one token a paragraph,
  // just over the window: under twice the size it counts no more than the
  // size, and a thought of the bound's windows so is whole.
  const unspaced = Array.from({ length: 3 }, (_, i) => ({ index: i, content: "字".repeat(1236) })); // 309 estimated tokens, one "word"
  assert(boundedWindows("", unspaced, { windowTokens: 300, maxWindows: 3 }).coverage === undefined,
         "three unspaced paragraphs each just over the window, under a bound of three, are whole — not charged as runs");
  // Blank lines around a one-window thought are no text to bound: measured on chunk.ts's trimmed window.
  const padded1 = `${"\n".repeat(12000)}${"Anita wrote about Open Brain. ".repeat(40)}`;
  const paddedB = boundedWindows(padded1, chunkContent(padded1, { maxTokens: 600, overlapTokens: 75 }), { windowTokens: 600, maxWindows: 1 });
  assert(paddedB.coverage === undefined && paddedB.windows[0].content === padded1, `a one-window thought behind 12,000 blank lines is sent whole, no caveat (${JSON.stringify(paddedB.coverage)})`);
  // A run that uses the whole bound leaves nothing of the next window: nothing
  // is sent of it, and the caveat says the prefix stopped at the text bound.
  const exact = boundedWindows("", [{ index: 0, content: "z".repeat(3600) }, { index: 1, content: "the words after it" }], { windowTokens: 300, maxWindows: 3 });
  assert(exact.windows.length === 1 && exact.windows[0].content.length === 3600 && exact.coverage?.cut === false && exact.coverage.of === 2,
         `a run of exactly the bound is sent whole and the next window not at all — no empty call (${exact.windows.length} window(s), ${JSON.stringify(exact.coverage)})`);
  assert(/^partial: 1 of 2 windows extracted, stopped at the text bound, 900 estimated tokens/.test(partialCaveat(exact.coverage!, { windowTokens: 300, maxWindows: 3 })),
         "…its caveat: extracted, stopped at the text bound — not \"over OB1_EXTRACT_MAX_WINDOWS\", which it was not");
  // A cut never ends between the halves of a surrogate pair.
  const emoji = `a${"😀".repeat(5000)}`;
  const emojiCut = boundedWindows(emoji, chunkContent(emoji, { maxTokens: 600, overlapTokens: 75 }), { windowTokens: 600, maxWindows: 1 }).windows[0].content;
  assert(emojiCut.length > 2000 && !/[\uD800-\uDBFF]$/.test(emojiCut), `a cut at 2,400 units lands mid-pair and drops the lone half (${emojiCut.length} units, last ${emojiCut.charCodeAt(emojiCut.length - 1).toString(16)})`);
  // A window chunk.ts packed from words may pass the size by the word that
  // filled it; a thought of exactly the bound's windows, each so, is whole —
  // the text bound is not a cut of what the count admits (review pass 1).
  const overshot = Array.from({ length: 3 }, (_, i) => ({ index: i, content: "word ".repeat(236).trim() })); // 236 words: 307 estimated tokens, 7 over a 300 window
  assert(overshot.every((c) => estimateTokens(c.content) > 300) && boundedWindows("", overshot, { windowTokens: 300, maxWindows: 3 }).coverage === undefined,
         "three windows each a word past the size, under a bound of three, are extracted whole — no coverage");
  // The prefix rule itself, on windows given: the text bound ends a prefix
  // at an over-window run mid-thought, cut to what is left.
  const mid = boundedWindows("", [{ index: 0, content: "a b c ".repeat(100) }, { index: 1, content: "y".repeat(4000) }, { index: 2, content: "tail words here" }], { windowTokens: 300, maxWindows: 3 });
  assert(mid.windows.length === 2 && mid.coverage?.cut === true && mid.coverage.of === 3 && estimateTokens(mid.windows.map((w) => w.content).join("")) <= 900 && mid.windows[1].content.startsWith("yyy"),
         `a run over the text bound mid-thought ends the prefix there, cut to what the bound left (${JSON.stringify(mid.coverage)}, ${mid.windows[1]?.content.length} characters of the run)`);

  // A window answering prose is left out, not the thought (SMD-2260): the
  // windows that parsed are the answer, and its coverage names the rest.
  const { MALFORMED_WINDOWS_MARK, OVER_BOUND_MARK } = await import("./entities.ts");
  reqs.length = 0;
  proseIf = /Priya wrote|Sam wrote/;
  const some = await extractEntities(long, cfgD, undefined, { kind: "extraction" });
  proseIf = null;
  assert(reqs.length === 4 && !some.malformed && some.windows === 4,
         `two of four windows answered in prose: the thought's answer is not malformed, all four sent (${reqs.length} calls, malformed ${some.malformed})`);
  assert(some.entities.map((e) => e.name).sort().join(",") === "Anita,Dev,Open Brain" && some.relations.length === 2,
         `…it is the parsed windows' answer — their people and edges, not the prose windows' (${some.entities.map((e) => e.name).join(",")}; ${some.relations.length} edges)`);
  assert(JSON.stringify(some.coverage) === JSON.stringify({ windows: 4, of: 4, cut: false, malformed: [2, 3] }) && some.parts?.map((q) => q.malformed).join(",") === "false,false,true,true",
         `…and its coverage names the windows left out, as the per-window record does (${JSON.stringify(some.coverage)})`);
  const someCaveat = partialCaveat(some.coverage!, windowingFor(cfgD));
  assert(someCaveat === `${PARTIAL_CAVEAT_PREFIX}2 of 4 windows extracted; the model's answers for windows 3, 4 were ${MALFORMED_WINDOWS_MARK}, and their text is not in the graph`,
         `the caveat counts the windows in the graph and names those left out, from 1 (${someCaveat})`);
  // Every window, and a one-window thought's one answer, is still a malformed answer, recorded failed.
  reqs.length = 0;
  prose = true;
  const bad = await extractEntities(long, cfgD, undefined, { kind: "extraction" });
  const badOne = await extractEntities(short, cfgD, undefined, { kind: "extraction" });
  prose = false;
  assert(bad.malformed && bad.windows === 4 && bad.coverage === undefined && bad.entities.length === 0,
         `every window in prose of a thought within the bound is a malformed answer, with no coverage to record it succeeded by (${JSON.stringify(bad.coverage)})`);
  assert(badOne.malformed && badOne.coverage === undefined, "…and so is a one-window thought's one prose answer");
  // Over the bound and a window malformed: both on the one coverage, and the caveat says both.
  reqs.length = 0;
  proseIf = /Dev wrote/;
  const both = await extractEntities(long, cfgD, undefined, { kind: "extraction" }, { ...windowingFor(cfgD), maxWindows: 3 });
  proseIf = null;
  assert(reqs.length === 3 && JSON.stringify(both.coverage) === JSON.stringify({ windows: 3, of: 4, cut: false, malformed: [1] }) && !both.entities.some((e) => e.name === "Dev" || e.name === "Sam"),
         `a prefix of three with its second window in prose: sent three, left out one (${JSON.stringify(both.coverage)})`);
  const bothCaveat = partialCaveat(both.coverage!, { windowTokens: 600, maxWindows: 3 });
  assert(bothCaveat === `${PARTIAL_CAVEAT_PREFIX}2 of 4 windows extracted; the model's answer for window 2 of the 3 sent was ${MALFORMED_WINDOWS_MARK}, and the thought is over OB1_EXTRACT_MAX_WINDOWS (3); the rest of the thought is not in the graph`,
         `…and its caveat names the window and the bound (${bothCaveat})`);
  // The windows as a reader counts them, runs of three or more as ranges — the stable pool's two papers.
  const cav = (malformed: number[], c: Partial<{ windows: number; of: number; cut: boolean }> = {}) =>
    partialCaveat({ windows: 24, of: 24, cut: false, ...c, malformed }, { windowTokens: 600, maxWindows: 24 });
  assert(cav([12, 14, 15, 16, 17, 18, 19, 20, 22], { of: 28 }).startsWith(`${PARTIAL_CAVEAT_PREFIX}15 of 28 windows extracted; the model's answers for windows 13, 15–21, 23 of the 24 sent were`)
         && cav([22, 23], { of: 26 }).includes("windows 23, 24 of the 24 sent"),
         `a run of three or more is a range, two are two (${cav([12, 14, 15, 16, 17, 18, 19, 20, 22], { of: 28 }).slice(0, 110)})`);
  assert(/^partial: 1 of 3 windows extracted; the model's answer for window 2 of the 2 sent was not JSON of the expected shape, and the last sent was cut short at the text bound/.test(cav([1], { windows: 2, of: 3, cut: true })),
         "a cut window left out says the cut, as a prefix's caveat does");
  assert(cav([0], { windows: 2, of: 3, cut: true }).startsWith(`${PARTIAL_CAVEAT_PREFIX}1 of 3 windows extracted, the last of them in part; the model's answer for window 1 of the 2 sent was`),
         `…and a cut window that parsed is counted in part, as a prefix's caveat says "sent" of it (${cav([0], { windows: 2, of: 3, cut: true }).slice(0, 100)})`);
  // The worker tells the two kinds of partial row apart by the marks alone:
  // every caveat naming malformed windows carries the one, and no prefix's
  // does; every prefix's carries the other, windows left out or not, and no
  // caveat of windows left out alone does.
  const prefixForms = [{ windows: 24, of: 30, cut: false }, { windows: 3, of: 30, cut: false }, { windows: 5, of: 30, cut: true }];
  const caveatOf = (c: { windows: number; of: number; cut: boolean; malformed?: number[] }) => partialCaveat(c, { windowTokens: 600, maxWindows: 24 });
  assert(prefixForms.every((c) => !caveatOf(c).includes(MALFORMED_WINDOWS_MARK) && caveatOf(c).includes(OVER_BOUND_MARK))
         && prefixForms.every((c) => caveatOf({ ...c, malformed: [0] }).includes(MALFORMED_WINDOWS_MARK) && caveatOf({ ...c, malformed: [0] }).includes(OVER_BOUND_MARK))
         && caveatOf({ windows: 24, of: 24, cut: false, malformed: [0] }).includes(MALFORMED_WINDOWS_MARK) && !caveatOf({ windows: 24, of: 24, cut: false, malformed: [0] }).includes(OVER_BOUND_MARK),
         "MALFORMED_WINDOWS_MARK is in every caveat with windows left out and in no prefix's, OVER_BOUND_MARK in every prefix's and in none of windows left out alone — the worker's partition holds");
  // The run's signal that the model, not its documents, is at fault
  // (SMD-2266): a share of the run's answers, over a floor of answers — not a
  // floor on one thought's share, which is its text's.
  const { malformedAlarm, EXTRACT_MALFORMED_ALARM_SHARE, EXTRACT_MALFORMED_ALARM_MIN } = await import("../db/config.mjs");
  // Answers at or past the floor whose share is a whole count: the share
  // itself, exactly, is not past it.
  const den = Math.round(1 / EXTRACT_MALFORMED_ALARM_SHARE);
  const evenly = Math.ceil(EXTRACT_MALFORMED_ALARM_MIN / den) * den;
  const atShare = evenly / den;
  assert(!malformedAlarm(1658, 11) && !malformedAlarm(136, 12) && !malformedAlarm(72, 8) && !malformedAlarm(24, 9),
         "the stable pool's 11 of 1,658 answers left out, its six reference-list papers read again at 12 of 136, the ticket's three at 8 of 72, and one paper's 9 of 24 alone do not trip the alarm");
  assert(malformedAlarm(61, 17) && malformedAlarm(72, 20),
         "the wrong model's 17 of 61 over the pool's windowed thoughts trips it — and so would the three papers' reading before SMD-2260, 20 of 72, which no share tells from it");
  assert(den === 1 / EXTRACT_MALFORMED_ALARM_SHARE && malformedAlarm(evenly, atShare + 1) && !malformedAlarm(evenly, atShare)
         && malformedAlarm(EXTRACT_MALFORMED_ALARM_MIN, EXTRACT_MALFORMED_ALARM_MIN) && !malformedAlarm(EXTRACT_MALFORMED_ALARM_MIN - 1, EXTRACT_MALFORMED_ALARM_MIN - 1),
         `more than the share (${EXTRACT_MALFORMED_ALARM_SHARE.toFixed(3)}) of at least ${EXTRACT_MALFORMED_ALARM_MIN} answers trips it, the share itself does not, and fewer answers do not however many are malformed`);

  // A runaway — an answer cut at its budget — is the answer under the shipped
  // windowing, and is made once more with the frequency penalty when the
  // windowing says so; a penalty is never sent on a first call.
  const { RUNAWAY_PENALTY, RUNAWAY_REPEATS, callsMadeBy } = await import("./entities.ts");
  let runawayOnce = false;
  const penalties: (number | undefined)[] = [];
  const providerE = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { max_tokens?: number; frequency_penalty?: number };
      penalties.push(body.frequency_penalty);
      if (runawayOnce && body.frequency_penalty === undefined) {
        runawayOnce = false;
        return Response.json({ choices: [{ message: { content: '{"entities":[{"name":"Loop","type":"tool","confidence":1},{"name":"Loop","type":"tool",' }, finish_reason: "length" }] });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ entities: [{ name: "Anita", type: "person", confidence: 0.9 }], relationships: [] }) }, finish_reason: "stop" }] });
    },
  });
  const cfgE = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${providerE.port}/v1`, OB1_METADATA_MODEL: "stub-chat" });
  assert(windowingFor(cfgE).retryRunaway === true, "the shipped windowing retries a runaway — 32 of 32 stragglers against 2 without (evals/README.md)");
  runawayOnce = true;
  const cutObs: ExtractWindowObservation[] = [];
  const cut = await extractEntities(short, cfgE, undefined, { kind: "extraction" }, { ...windowingFor(cfgE), retryRunaway: false, observe: (r: ExtractWindowObservation) => cutObs.push(r) });
  assert(cut.malformed && cut.retried === undefined && penalties.length === 1 && penalties[0] === undefined, "with the retry off a cut answer is malformed after one call, with no penalty sent");
  // SMD-2269: observe carries the finish reason (`length`) a cut answer ends on —
  // the signal the diagnosis reads to tell a budget cut from prose. Not aborted
  // (this is a whole read), and the sample is the JSON the answer began with.
  assert(cutObs.length === 1 && cutObs[0].finishReason === "length" && cutObs[0].malformed === true && cutObs[0].aborted === false && cutObs[0].answerSample?.startsWith("{") === true,
         `observe reports the cut window: finish_reason length, malformed, not aborted, JSON-opening sample (${JSON.stringify(cutObs[0]?.finishReason)}, ${cutObs[0]?.aborted})`);
  penalties.length = 0;
  runawayOnce = true;
  const again = await extractEntities(short, cfgE, undefined, { kind: "extraction" });
  assert(!again.malformed && again.retried === true && again.entities[0]?.name === "Anita", "under the shipped windowing the cut answer is made again and the second answer is the thought's");
  assert(penalties.length === 2 && penalties[0] === undefined && penalties[1] === RUNAWAY_PENALTY, `…the first call without a penalty, the retry with ${RUNAWAY_PENALTY} (${penalties.join(",")})`);
  penalties.length = 0;
  const clean = await extractEntities(short, cfgE, undefined, { kind: "extraction" });
  assert(!clean.malformed && clean.retried === undefined && penalties.length === 1, "…and an answer that converges is never retried");

  // SMD-2000: with OB1_EXTRACT_ESCALATE_MODEL set, a runaway is remade on the
  // LARGER model with no penalty — not once more on the same model under one —
  // and `escalated` names the model that answered; the pass key stays the
  // first model's (record_thought_entities' key, unchanged). The stub runs a
  // runaway on the small model only; the large model answers whole.
  let runawayOnceX = false;
  const modelsX: string[] = [];
  const penaltiesX: (number | undefined)[] = [];
  const providerX = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string; frequency_penalty?: number };
      modelsX.push(body.model ?? "");
      penaltiesX.push(body.frequency_penalty);
      if (runawayOnceX && body.model === "small-chat") {
        runawayOnceX = false;
        return Response.json({ choices: [{ message: { content: '{"entities":[{"name":"Loop","type":"tool","confidence":1},{"name":"Loop","type":"tool",' }, finish_reason: "length" }] });
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ entities: [{ name: "Big", type: "person", confidence: 0.9 }], relationships: [] }) }, finish_reason: "stop" }] });
    },
  });
  const cfgX = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${providerX.port}/v1`, OB1_METADATA_MODEL: "small-chat", OB1_EXTRACT_ESCALATE_MODEL: "big-chat" });
  assert(windowingFor(cfgX).escalateModel === "big-chat", "OB1_EXTRACT_ESCALATE_MODEL sets the windowing's escalation target");
  runawayOnceX = true;
  const esc = await extractEntities(short, cfgX, undefined, { kind: "extraction" });
  assert(!esc.malformed && esc.retried === true && esc.escalated === "big-chat" && esc.entities[0]?.name === "Big", "a runaway is escalated to the larger model, which answers, and `escalated` names it");
  assert(modelsX.length === 2 && modelsX[0] === "small-chat" && modelsX[1] === "big-chat", `the first call is the metadata model, the second the escalation model (${modelsX.join(",")})`);
  assert(penaltiesX.every((p) => p === undefined), `neither call carries a penalty — the escalation answers unpenalised (${penaltiesX.join(",")})`);
  // The mutant the ticket names: a converged first answer is NEVER escalated —
  // one call, the metadata model, no second call.
  modelsX.length = 0;
  const conv = await extractEntities(short, cfgX, undefined, { kind: "extraction" });
  assert(!conv.malformed && conv.escalated === undefined && conv.retried === undefined && modelsX.length === 1 && modelsX[0] === "small-chat", "an answer that converges first time is never escalated — one call on the metadata model");
  // An escalation model equal to the metadata model is ignored: a same-model
  // unpenalised retry is strictly weaker than the penalised one it would
  // replace, so windowingFor drops it and the penalised retry stands.
  const cfgSame = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${providerX.port}/v1`, OB1_METADATA_MODEL: "small-chat", OB1_EXTRACT_ESCALATE_MODEL: "small-chat" });
  assert(windowingFor(cfgSame).escalateModel === undefined, "an escalation model equal to the metadata model is ignored — the penalised retry stands");
  providerX.stop(true);

  // SMD-2000, the MULTI-WINDOW path: a runaway in ONE window of a long thought
  // escalates, and the merged answer AND that window's part carry `escalated`
  // (the single-window case above and test-live [10e] never take the of>1 path).
  // Only the first window (the "alpha-marker" it alone holds — at its head, so
  // the overlap never carries it on) runs away on the small model's first,
  // unpenalised call; the larger model and the other window converge.
  const providerMW = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string; frequency_penalty?: number; messages: { content: string }[] };
      const user = body.messages[0].content;
      if (/alpha-marker/.test(user) && body.model === "small-mw" && body.frequency_penalty === undefined) {
        return Response.json({ choices: [{ message: { content: '{"entities":[{"name":"Loop","type":"tool","confidence":1},{"name":"Loop","type":"tool",' }, finish_reason: "length" }] });
      }
      const name = body.model === "big-mw" ? "Bigfoot" : "Anita";
      return Response.json({ choices: [{ message: { content: JSON.stringify({ entities: [{ name, type: "person", confidence: 0.9 }], relationships: [] }) }, finish_reason: "stop" }] });
    },
  });
  const cfgMW = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${providerMW.port}/v1`, OB1_METADATA_MODEL: "small-mw", OB1_EXTRACT_ESCALATE_MODEL: "big-mw", OB1_EXTRACT_CHUNK_TOKENS: "300" });
  const twoWindow = `alpha-marker heads the first window. ${"Anita noted the ledger. ".repeat(120)}\n\nbeta opens the second. ${"Dev used the index. ".repeat(120)}`;
  const mw = await extractEntities(twoWindow, cfgMW, undefined, { kind: "extraction" });
  assert(mw.parts !== undefined && mw.parts.length >= 2, `the thought went in multiple windows (${mw.parts?.length} parts)`);
  assert(mw.escalated === "big-mw" && mw.retried === true, `the merged multi-window answer names the escalation model — the of>1 path propagates it (escalated=${mw.escalated})`);
  assert(mw.parts!.some((p) => p.escalated === "big-mw") && mw.parts!.some((p) => p.escalated === undefined), "only the runaway window's part carries the escalation model; a window that converged first time does not");
  assert(mw.entities.some((e) => e.name === "Bigfoot"), "the escalation model's answer merged into the thought's entities");
  providerMW.stop(true);

  // The `first.malformed` guard (SMD-1879, shared by the SMD-2000 escalation): a
  // budgeted answer that PARSES cleanly but happens to finish at `length` is the
  // thought's answer, not a runaway — so it is neither retried NOR escalated, and
  // costs one call. Without the conjunct a complete answer that closed exactly at
  // the budget would be re-called and overwritten by the retry/escalation.
  let lenCalls = 0;
  const providerLen = Bun.serve({
    port: 0,
    fetch() {
      lenCalls++;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ entities: [{ name: "Complete", type: "person", confidence: 0.9 }], relationships: [] }) }, finish_reason: "length" }] });
    },
  });
  const cfgLen = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${providerLen.port}/v1`, OB1_METADATA_MODEL: "small-len", OB1_EXTRACT_ESCALATE_MODEL: "big-len" });
  const lenEx = await extractEntities(short, cfgLen, undefined, { kind: "extraction" });
  assert(!lenEx.malformed && lenEx.retried === undefined && lenEx.escalated === undefined && lenCalls === 1 && lenEx.entities[0]?.name === "Complete",
    `a budgeted answer that parses but finished at 'length' is kept — not retried, not escalated, one call (${lenCalls})`);
  providerLen.stop(true);

  // SMD-1960: the answer is streamed and a runaway is aborted at the third copy
  // of one item, before its budget, then retried under the penalty as a cut
  // one is. The stub streams a loop one item per frame and records, per
  // request, how many frames it got out before the client hung up.
  type Run = { sent: number; total: number; cancelled: boolean; body: { stream?: boolean; frequency_penalty?: number } };
  const runs: Run[] = [];
  let gMode: "loop" | "good" | "json" | "slow" | "cut" | "error" | "nodone" | "oneframe" | "sepfinish" | "cleanclose" | "mislabelled" | "emptyfinish" | "empty" | "cr" | "multiline" | "doneonly" | "braceopen" | "finishtail" | "loop4finish" | "rolefinish" | "crlfsplit" = "loop";
  const LOOP4 = JSON.stringify({ entities: [{ name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Anita", type: "person", confidence: 0.9 }], relationships: [] });
  // A converging answer whose LAST item is a third copy: the object closes
  // after it, so the abort that was pending never fires. (Anita first: a
  // fourth item after the third copy would be the answer going on — an abort.)
  // …and a relation in the other array after it (seventh pass: an item there
  // is not the loop going on, whatever frame it lands in).
  const THRICE = JSON.stringify({ entities: [{ name: "Anita", type: "person", confidence: 0.9 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }], relationships: [{ from: "Anita", to: "Loop", relation: "uses", confidence: 0.8 }] });
  const GOOD = JSON.stringify({ entities: [{ name: "Anita", type: "person", confidence: 0.9, aliases: ["A. {Nita}"] }, { name: "Open Brain", type: "project", confidence: 0.8 }], relationships: [{ from: "Anita", to: "Open Brain", relation: "works_on", confidence: 0.7 }] });
  const frame = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;
  const providerG = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Run["body"];
      const run: Run = { sent: 0, total: 0, cancelled: false, body };
      runs.push(run);
      if (gMode === "json" || !body.stream) return Response.json({ choices: [{ message: { content: GOOD }, finish_reason: "stop" }] });
      let frames: string[];
      let gapMs = 1;
      if (gMode === "loop" && body.frequency_penalty === undefined) {
        const loop = '{"name": "Loop", "type": "tool", "confidence": 1.0}';
        frames = ['{"entities": [{"name": "Anita", "type": "person", "confidence": 0.9}', ...Array.from({ length: 40 }, () => `,\n    ${loop}`), ""].map((p, i, a) => frame(p, i === a.length - 1 ? "length" : null));
        // A second between the third copy and the loop running out (third
        // review pass): the stub's loop stops only when Bun sees the hang-up.
        gapMs = 25;
      } else if (gMode === "slow") {
        frames = Array.from({ length: 20 }, (_, i) => frame(GOOD.slice(i * 8, i * 8 + 8)));
        gapMs = 100;
      } else if (gMode === "nodone") {
        // The whole answer, a finish_reason, then the connection held open with
        // keepalives and NO [DONE] — a finishing frame is the end (fifth pass).
        frames = [...(GOOD.match(/[\s\S]{1,7}/g) ?? []).map((p) => frame(p)), frame("", "stop"), ...Array.from({ length: 400 }, () => ": keepalive\n\n")];
        gapMs = 2;
      } else if (gMode === "oneframe") {
        // One frame holding a complete answer with an item three times over,
        // finishing in the same frame: complete, so parsed — never an abort.
        frames = [frame(JSON.stringify({ entities: [{ name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }], relationships: [] }), "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "sepfinish") {
        // Ollama's own shape: content frames, then the finish in a frame of its
        // own — with a third copy inside a CONVERGING answer (sixth pass).
        frames = [...(THRICE.match(/[\s\S]{1,6}/g) ?? []).map((p) => frame(p)), frame("", "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "emptyfinish") {
        // Every frame carries finish_reason "" where the OpenAI shape has null.
        frames = [...(GOOD.match(/[\s\S]{1,7}/g) ?? []).map((p) => frame(p).replace('"finish_reason":null', '"finish_reason":""')), frame("", "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "empty") {
        frames = [];
      } else if (gMode === "cr") {
        // Lone \r line ends, as the SSE grammar allows.
        frames = [...(GOOD.match(/[\s\S]{1,7}/g) ?? []).map((p) => frame(p)), frame("", "stop"), "data: [DONE]\n\n"].map((f) => f.replace(/\n/g, "\r"));
      } else if (gMode === "multiline") {
        // One event, its payload on two data: lines (the grammar joins them with
        // a newline, so the split falls between JSON tokens).
        const one = JSON.stringify({ choices: [{ delta: { content: GOOD }, finish_reason: null }] });
        const cut = one.indexOf("[") + 1;
        frames = [`data: ${one.slice(0, cut)}\ndata: ${one.slice(cut)}\n\n`, frame("", "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "doneonly") {
        frames = ["data: [DONE]\n\n"];
      } else if (gMode === "braceopen") {
        // The answer's last brace and a second object's first in ONE frame.
        frames = [frame(`${GOOD}\n{`), frame(GOOD.slice(1)), frame("", "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "finishtail") {
        // The whole answer AND chatter after its brace, in the finishing frame.
        frames = [frame(`${GOOD}\n\nHope this helps!`, "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "loop4finish") {
        // A loop that went on, complete, in the finishing frame: the same
        // runaway it is when the finish comes alone (ninth pass).
        frames = [frame(LOOP4, "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "rolefinish") {
        // The OpenAI shape with nothing said: a role frame, a finish, [DONE].
        frames = [`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}\n\n`, frame("", "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "crlfsplit") {
        // A CRLF event on two data: lines, the chunk boundary between the \r
        // and the \n of the first — one event still (ninth pass).
        const one = JSON.stringify({ choices: [{ delta: { content: GOOD }, finish_reason: null }] });
        const cut = one.indexOf("[") + 1;
        frames = [`data: ${one.slice(0, cut)}\r`, `\ndata: ${one.slice(cut)}\r\n\r\n`, frame("", "stop").replace(/\n/g, "\r\n"), "data: [DONE]\r\n\r\n"];
      } else if (gMode === "cleanclose") {
        // The whole answer, then the stream closes with no finish_reason and
        // no [DONE]: an answer, not a closed socket (sixth pass).
        frames = (GOOD.match(/[\s\S]{1,8}/g) ?? []).map((p) => frame(p));
      } else if (gMode === "cut") {
        // Half the answer, then the stream ends: no finish_reason, no [DONE].
        frames = Array.from({ length: 10 }, (_, i) => frame(GOOD.slice(i * 8, i * 8 + 8)));
      } else if (gMode === "error") {
        // Half the answer, then the provider's error frame — and the stream
        // kept OPEN after it, as a gateway that goes on talking would.
        frames = [...Array.from({ length: 10 }, (_, i) => frame(GOOD.slice(i * 8, i * 8 + 8))), `data: ${JSON.stringify({ error: { message: "the runner exited: context length exceeded", code: 500 } })}\n\n`, ...Array.from({ length: 40 }, () => ": still here\n\n")];
        gapMs = 25;
      } else {
        // Seven characters a frame: tokens split mid-name, mid-number, mid-brace;
        // `"error": null` beside every choice, as some compat layers send; and
        // after [DONE] the connection kept open with keepalive comments for
        // seconds, as a gateway might (fourth review pass).
        frames = [...(GOOD.match(/[\s\S]{1,7}/g) ?? []).map((p) => frame(p).replace('"finish_reason":null}]', '"finish_reason":null}],"error":null')), frame("", "stop"), "data: [DONE]\n\n", ...Array.from({ length: 400 }, () => ": keepalive\n\n")];
        gapMs = 2;
      }
      run.total = frames.length;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          try {
            for (const f of frames) { c.enqueue(encoder.encode(f)); run.sent++; await Bun.sleep(gapMs); }
            c.close();
          } catch { /* cancelled mid-loop */ }
        },
        cancel() { run.cancelled = true; },
      });
      // "mislabelled": the same frames under application/json — read as what
      // the body is, not what the header says (sixth pass).
      return new Response(stream, { headers: { "content-type": gMode === "mislabelled" ? "application/json" : "text/event-stream" } });
    },
  });
  const cfgG = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${providerG.port}/v1`, OB1_METADATA_MODEL: "stub-chat" });
  assert(windowingFor(cfgG).streamAbort === true, "the shipped windowing streams the answer and aborts a runaway on it (EXTRACT_STREAM_ABORT)");
  gMode = "loop";
  const loopObs: ExtractWindowObservation[] = [];
  const rescued = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), observe: (r: ExtractWindowObservation) => loopObs.push(r) });
  // The stub's cancel() lands after the client's reader.cancel(): wait for
  // it, bounded, rather than a fixed sleep (second review pass).
  for (let waited = 0; !runs[0]?.cancelled && waited < 2000; waited += 10) await Bun.sleep(10);
  assert(!rescued.malformed && rescued.retried === true && rescued.entities[0]?.name === "Anita" && rescued.entities.length === 2, "a streamed runaway is aborted and the penalised retry's answer is the thought's");
  assert(rescued.abortedMs !== undefined && rescued.abortedMs >= 0 && rescued.abortedMs < 5000, `…and the answer says how far into the call the runaway was aborted (${rescued.abortedMs} ms)`);
  assert(runs.length === 2 && runs[0].body.stream === true && runs[0].body.frequency_penalty === undefined && runs[1].body.frequency_penalty === RUNAWAY_PENALTY && runs[1].body.stream === undefined, `the first call asks for a stream and carries no penalty; the retry carries ${RUNAWAY_PENALTY} and is read WHOLE — a penalised answer can repeat an item three times and recover (${runs.map((r) => `${r.body.stream}/${r.body.frequency_penalty}`).join(" ")})`);
  assert(runs[0].cancelled && runs[0].sent >= RUNAWAY_REPEATS + 1 && runs[0].sent < runs[0].total, `the client hung up on the loop after the third copy and before it ran out (${runs[0].sent} of ${runs[0].total} frames sent) — the mutant that reads the stream to its end sends all ${runs[0].total}`);
  assert(!runs[1].cancelled && runs[1].total === 0, "…and the retry's whole answer is the thought's");
  // SMD-2269: observe fires only on the FIRST (aborted) call — the retry omits it —
  // and reports the abort with no answer sample, so the diagnosis reads a stream
  // abort as a loop, distinct from a budget cut. (The drop-the-observe mutant fails here.)
  assert(loopObs.length === 1 && loopObs[0].aborted === true && loopObs[0].malformed === true && loopObs[0].answerSample === undefined,
         `observe reports the aborted first call once, malformed, with no sample read (${loopObs.length} obs, aborted ${loopObs[0]?.aborted})`);

  // The streamed answer, reassembled from frames that split tokens, is the
  // whole answer; and a provider that answers a stream request with plain JSON
  // is read as one not asked (every other stub in this suite does).
  runs.length = 0;
  gMode = "good";
  const streamed = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  for (let waited = 0; !runs[0]?.cancelled && waited < 2000; waited += 10) await Bun.sleep(10);
  assert(runs[0]?.cancelled === true && runs[0].sent < runs[0].total, `[DONE] ends the read: the call returned with the gateway still sending keepalives (${runs[0]?.sent} of ${runs[0]?.total} frames) and the connection closed — the mutant that waits for the socket sends all ${runs[0]?.total}`);
  gMode = "json";
  const whole = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(JSON.stringify(streamed) === JSON.stringify(whole) && streamed.entities.length === 2 && streamed.relations.length === 1 && streamed.entities[0].aliases[0] === "A. {Nita}" && streamed.retried === undefined && streamed.abortedMs === undefined, `a streamed answer parses to the same Extraction as the whole one — braces inside an alias included — with nothing aborted or retried (${JSON.stringify(streamed).slice(0, 120)})`);
  assert(runs.length === 2 && runs[1].body.stream === true && runs[1].total === 0, "…and the JSON answer to a stream request read whole");

  // The per-call deadline bounds a stream that keeps coming too slowly, and
  // the error is the timeout the worker classifies (TimeoutError / timed out),
  // with the call counted.
  gMode = "slow";
  let late = "";
  let lateCalls = -1;
  try { await extractEntities(short, cfgG, 300, { kind: "extraction" }); } catch (e) { late = `${(e as Error).name}: ${(e as Error).message}`; lateCalls = callsMadeBy(e); }
  assert(/TimeoutError|timed out/i.test(late) && lateCalls === 1, `a stream still coming at the deadline is the timeout, counted as one call (${late.slice(0, 80)}; calls ${lateCalls})`);

  // A stream that ends with neither a finish_reason nor [DONE] is a socket
  // that closed mid-answer — thrown, as the whole read's r.json() on a
  // truncated body was, and worded for the worker's transient rule (`socket`),
  // NOT returned as the model's malformed answer (first review pass).
  gMode = "cut";
  let closed = "";
  let closedCalls = -1;
  try { await extractEntities(short, cfgG, undefined, { kind: "extraction" }); } catch (e) { closed = (e as Error).message; closedCalls = callsMadeBy(e); }
  assert(/closed mid-answer/.test(closed) && /socket/i.test(closed) && /80 characters/.test(closed) && closedCalls === 1, `a stream cut mid-answer throws a socket error naming what arrived, counted as one call, rather than a malformed answer (${closed.slice(0, 100)}; calls ${closedCalls})`);

  // A finishing frame ends the read as [DONE] does, and a complete answer is
  // never an abort whatever it repeats (fifth review pass, both probed).
  runs.length = 0;
  gMode = "nodone";
  const finished = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  for (let waited = 0; !runs[0]?.cancelled && waited < 2000; waited += 10) await Bun.sleep(10);
  assert(!finished.malformed && finished.entities.length === 2 && finished.retried === undefined && runs[0]?.cancelled === true && runs[0].sent < runs[0].total, `a frame carrying finish_reason ends the read: the answer is the thought's and the connection closed on the keepalives that followed with no [DONE] (${runs[0]?.sent} of ${runs[0]?.total} frames)`);
  runs.length = 0;
  gMode = "oneframe";
  const whole3 = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!whole3.malformed && whole3.entities.length === 1 && whole3.entities[0].name === "Loop" && whole3.retried === undefined && whole3.abortedMs === undefined && runs.length === 1, `a complete answer arriving in one finishing frame with an item three times over is parsed — the copies folded to one — not aborted and not retried (${JSON.stringify(whole3).slice(0, 100)})`);

  // Sixth review pass, probed: the finish in its own frame after a converging
  // answer holding a third copy; a clean close with no end sign; SSE under the
  // wrong content-type.
  runs.length = 0;
  gMode = "sepfinish";
  const converging = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!converging.malformed && converging.entities.length === 2 && converging.relations.length === 1 && converging.retried === undefined && converging.abortedMs === undefined && runs.length === 1, `a converging answer holding an item three times, then a relation, its finish in a frame of its own, is complete — folded to two entities and one edge, not aborted, not retried (${JSON.stringify(converging).slice(0, 100)})`);
  assert(converging.entities[1]?.name === "Loop" && converging.entities.length === 2, "…the three copies one entity beside Anita");
  runs.length = 0;
  gMode = "emptyfinish";
  const emptyFinish = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!emptyFinish.malformed && emptyFinish.entities.length === 2 && runs.length === 1, "a finish_reason of \"\" on every frame is not the end — only a non-empty one is");
  runs.length = 0;
  gMode = "cr";
  const cr = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!cr.malformed && cr.entities.length === 2 && runs.length === 1, "a stream whose lines end in a lone \\r is framed all the same");
  gMode = "empty";
  let empty = "";
  try { await extractEntities(short, cfgG, undefined, { kind: "extraction" }); } catch (e) { empty = (e as Error).message; }
  assert(/was empty: no answer in 0 frame/.test(empty) && !/socket/.test(empty), `a 200 with no body at all is the provider's empty answer, this row's failure, not a closed socket (${empty.slice(0, 90)})`);
  // Eighth review pass, probed: [DONE] alone is the same empty answer; one
  // event on two data: lines is one frame; the answer's last brace and a
  // second object's first in one frame is the answer, cut at the brace.
  runs.length = 0;
  gMode = "doneonly";
  const doneOnly = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), retryRunaway: false });
  assert(doneOnly.malformed && doneOnly.retried === undefined && runs.length === 1, "[DONE] alone is the provider's empty answer, malformed as the whole read has it — not thrown (tenth review pass)");
  runs.length = 0;
  gMode = "multiline";
  const multiline = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!multiline.malformed && multiline.entities.length === 2 && runs.length === 1, "an event whose payload spans two data: lines is one frame, joined as the grammar says");
  runs.length = 0;
  gMode = "braceopen";
  const braceOpen = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!braceOpen.malformed && braceOpen.entities.length === 2 && braceOpen.retried === undefined && runs.length === 1, `the answer's last brace followed by a second object's first in the same frame is the answer, cut at the brace (${JSON.stringify(braceOpen).slice(0, 80)})`);
  // Ninth review pass, probed: the finishing frame's content is read too.
  runs.length = 0;
  gMode = "finishtail";
  const finishTail = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!finishTail.malformed && finishTail.entities.length === 2 && runs.length === 1, "chatter after the brace in the FINISHING frame is cut at the brace too");
  runs.length = 0;
  gMode = "loop4finish";
  const loop4 = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(loop4.retried === true && loop4.abortedMs !== undefined && runs.length === 2 && runs[1].body.stream === undefined, "a loop that went on, arriving complete in the finishing frame, is the runaway it is when the finish comes alone — retried, read whole");
  runs.length = 0;
  gMode = "rolefinish";
  const roleFinish = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), retryRunaway: false });
  assert(roleFinish.malformed && roleFinish.retried === undefined && runs.length === 1, "a role frame and a finish with no content is the empty answer, malformed as the whole read has it — the same record by either transport");
  runs.length = 0;
  gMode = "crlfsplit";
  const crlfSplit = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!crlfSplit.malformed && crlfSplit.entities.length === 2 && runs.length === 1, "a CRLF event split between its \\r and \\n across reads is one event still");
  runs.length = 0;
  gMode = "cleanclose";
  const wholeClose = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!wholeClose.malformed && wholeClose.entities.length === 2 && wholeClose.retried === undefined && runs.length === 1, "a whole answer whose stream then closes with no finish_reason and no [DONE] is the answer, not a closed socket");
  runs.length = 0;
  gMode = "mislabelled";
  const mislabelled = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!mislabelled.malformed && mislabelled.entities.length === 2 && runs.length === 1 && runs[0].body.stream === true, "an event stream served as application/json is read as the stream it is");
  gMode = "loop";

  // The provider's own error frame mid-stream is the provider's error, with its
  // message — not the socket sentence, not a malformed answer (second review pass).
  gMode = "error";
  runs.length = 0;
  let errored = "";
  let erroredStatus: number | undefined;
  try { await extractEntities(short, cfgG, undefined, { kind: "extraction" }); } catch (e) { errored = (e as Error).message; erroredStatus = (e as { status?: number }).status; }
  assert(/answered an error mid-stream: the runner exited: context length exceeded/.test(errored) && !/socket/.test(errored), `an error frame mid-stream throws the provider's message (${errored.slice(0, 120)})`);
  assert(erroredStatus === 500, `…carrying the frame's code as the status the worker's transient rule reads (${erroredStatus})`);
  for (let waited = 0; !runs[0]?.cancelled && waited < 2000; waited += 10) await Bun.sleep(10);
  assert(runs[0]?.cancelled === true && runs[0].sent < runs[0].total, `…and the connection is closed on the way out, not left open to the deadline (${runs[0]?.sent} of ${runs[0]?.total} frames sent)`);
  gMode = "loop";

  // Reasoning on (second review pass): max_tokens would cap the thinking and
  // the answer together, so no budget is sent and a cut answer is not retried.
  const maxTokensSeen: (number | undefined)[] = [];
  const providerF = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { max_tokens?: number; frequency_penalty?: number; reasoning_effort?: string };
      maxTokensSeen.push(body.max_tokens);
      penalties.push(body.frequency_penalty);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ entities: [{ name: "Anita", type: "person", confidence: 0.9 }], relationships: [] }) }, finish_reason: "length" }] });
    },
  });
  penalties.length = 0;
  const cfgF = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${providerF.port}/v1`, OB1_METADATA_MODEL: "stub-chat", OB1_METADATA_REASONING: "medium" });
  const thought = await extractEntities(short, cfgF, undefined, { kind: "extraction" });
  assert(maxTokensSeen.length === 1 && maxTokensSeen[0] === undefined && penalties[0] === undefined, "with OB1_METADATA_REASONING on the call carries no max_tokens and no penalty — the p1 request");
  assert(!thought.malformed && thought.retried === undefined && maxTokensSeen.length === 1, "…and an answer that parses is the thought's, with `length` not read as a runaway since nothing was budgeted");
  providerF.stop();
  providerG.stop();
  providerE.stop();

  // The default window for a model the table lists is the measured 1200, and
  // the same thought is one call under it (it is under 1200 estimated tokens)
  // — so the stub's ceiling refuses it, which is the point of the ceiling.
  const cfgWide = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: D, OB1_METADATA_MODEL: "qwen2.5:7b" });
  assert(cfgWide.extractChunkTokens === 1200, "qwen2.5:7b derives the measured 1200");
  let refused = "";
  try { await extractEntities(long, cfgWide, undefined, { kind: "extraction" }); } catch (e) { refused = (e as Error).message; }
  assert(/input too long/.test(refused), "under a 1200-token window the 1,320-token thought is two calls or refused — the stub refused one over 700, so the windowing is what [10] measures, not the stub's leniency");
  providerD.stop();
}

server.stop();
provider.stop();

report();
