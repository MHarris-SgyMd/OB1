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

console.log("\n[7] A drifting `type` is normalised, not stored as a new category");
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
  const lastA = () => seen[seen.length - 1];
  const lastB = () => seenB[seenB.length - 1];

  // Neither chat knob: one endpoint, one key — the request of every deployment
  // that predates the split. Remove the fallback in resolveProviderEndpoints
  // and these fail.
  const one = resolveEmbedConfig({ OB1_LLM_BASE_URL: A, OB1_LLM_API_KEY: "key-a" });
  assert(one.chat.base === A && one.embeddings.base === A, "with no chat knob the chat endpoint IS the embeddings endpoint");
  assert(one.chat.headers.Authorization === "Bearer key-a", "…with the same credential");
  const beforeA = seen.length, beforeB = seenB.length;
  await providerCall(one, "/chat/completions", chatBody);
  assert(seen.length === beforeA + 1 && seenB.length === beforeB, "a chat call under one endpoint lands on it");
  assert(lastA().path.endsWith("/chat/completions") && lastA().auth === "Bearer key-a", "…carrying the embeddings key");

  // Both set: each path lands on its own endpoint with its own header.
  const two = resolveEmbedConfig({ OB1_LLM_BASE_URL: A, OB1_LLM_API_KEY: "key-a", OB1_CHAT_BASE_URL: B, OB1_CHAT_API_KEY: "key-b" });
  await providerCall(two, "/embeddings", embBody);
  assert(lastA().path.endsWith("/embeddings") && lastA().auth === "Bearer key-a", "embeddings land on OB1_LLM_BASE_URL with OB1_LLM_API_KEY");
  await providerCall(two, "/chat/completions", chatBody);
  assert(lastB().path.endsWith("/chat/completions") && lastB().auth === "Bearer key-b", "chat lands on OB1_CHAT_BASE_URL with OB1_CHAT_API_KEY");
  const nA = seen.length, nB = seenB.length;
  await judgePair({ content: "older", createdAt: null }, { content: "newer", createdAt: null }, two);
  await extractEntities("Ada met Grace in London", two);
  assert(seen.length === nA && seenB.length === nB + 2, "the supersession judge and the entity extractor dial the chat endpoint too, never the embeddings one");
  assert(seenB.slice(-2).every((s) => s.path.endsWith("/chat/completions") && s.auth === "Bearer key-b"), "…with its credential");

  // A credential belongs to an endpoint: a different chat base is sent none
  // unless it has its own; the same base spelled again shares the key; a chat
  // key alone gives the shared endpoint a chat-only credential.
  const own = resolveEmbedConfig({ OB1_LLM_BASE_URL: A, OB1_LLM_API_KEY: "key-a", OB1_CHAT_BASE_URL: B });
  await providerCall(own, "/chat/completions", chatBody);
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
    await providerCall(two, "/chat/completions", chatBody);
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
  const shared = resolveEmbedConfig({ OB1_LLM_BASE_URL: C, OB1_METADATA_MODEL: META_MODEL });
  assert(shared.judgeModel === META_MODEL, "OB1_JUDGE_MODEL unset: the judge model IS the metadata model");
  await judgePair(older, newer, shared);
  assert(last().path.endsWith("/chat/completions") && last().model === META_MODEL, `…and the judge request names it (${last().model})`);
  assert(consolidateKey(shared.judgeModel) === consolidateKey(META_MODEL), "…under the metadata model's pass key");
  assert(resolveEmbedConfig({ OB1_LLM_BASE_URL: C, OB1_METADATA_MODEL: META_MODEL, OB1_JUDGE_MODEL: "" }).judgeModel === META_MODEL,
         "an empty OB1_JUDGE_MODEL means unset, as for every knob embed.ts reads");

  // Set: on ONE configuration the judge names its model and the extractor
  // keeps the metadata model — the split the ticket exists for.
  const split = resolveEmbedConfig({ OB1_LLM_BASE_URL: C, OB1_METADATA_MODEL: META_MODEL, OB1_JUDGE_MODEL: "big-judge" });
  assert(split.judgeModel === "big-judge" && split.metadataModel === META_MODEL, "OB1_JUDGE_MODEL set: the judge model is its own and the metadata model is untouched");
  await judgePair(older, newer, split);
  await extractEntities("Ada met Grace in London", split);
  const [judge, extract] = models.slice(-2);
  assert(judge.model === "big-judge", `the judge request names OB1_JUDGE_MODEL (${judge.model})`);
  assert(extract.model === META_MODEL, `…while the entity extractor's, on the same configuration, names OB1_METADATA_MODEL (${extract.model})`);
  assert(consolidateKey(split.judgeModel) !== consolidateKey(shared.judgeModel), "a judge-model change is a new pass key, so an earlier model's judgements are not reused as this one's");
  providerC.stop();
}

server.stop();
provider.stop();

report();
