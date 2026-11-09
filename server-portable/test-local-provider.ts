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
import type { Extraction, ExtractionWindow, ExtractProgress, ExtractWindowObservation } from "./entities.ts";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { mcpUnderTest, servedByMcpServer } from "./test-support.ts";
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


/** The decide tier's /info, in its contract (jev.ts jevInfo): the stand-in answers it, so [11]'s tier call is read whole (SMD-3379 PR 2a). */
const JEV_INFO = { contract: "ob1-jev/1", model: { name: "stub-decider", source: "s", revision: "r", weights_sha256: "w", calibrator_sha256: "c", rules: "x" }, kinds: ["choose"], max_options: 8, max_batch: 8, max_tokens: 512 };

/** Type the stub's metadata model claims. Real llama3.2 returned "action_item". */
let replyType = "idea";

const provider = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    // A GET (the decide tier's /info, [11]) has no body: read as none, so every request is recorded.
    const body = (req.method === "POST" ? await req.json() : {}) as { model: string; input?: string; response_format?: { type: string } };
    seen.push({
      path: url.pathname,
      auth: req.headers.get("authorization"),
      model: body.model,
      jsonMode: body.response_format?.type === "json_object",
    });

    if (url.pathname.endsWith("/info")) return Response.json(JEV_INFO);
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

const worker = await mcpUnderTest();
assert(servedByMcpServer(), "the server under test is the MCP server, the REST core behind it");
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: worker.fetch });
const BASE = `http://127.0.0.1:${server.port ?? 0}`;
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
  const { resolveEmbedConfig, providerCall, ProviderError, shownBase, shownUrl } = await import("./embed.ts");
  const { judgePair } = await import("./consolidate.ts");
  const { extractEntities } = await import("./entities.ts");

  // A second stand-in with its own log, so where each call landed is a fact
  // about the request and not about the reply.
  const seenB: { path: string; auth: string | null }[] = [];
  let failB = false;
  const providerB = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
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

  // A user and password in a base are a credential, sent as Basic by the
  // endpoint's own header — not left in the URL for fetch, which sends them
  // from Bun 1.4.3 and dropped them before (SMD-2885). Percent-escapes are
  // decoded and the pair is UTF-8; a key takes the header over them.
  const U = B.replace("://", "://us%40er:p%C3%A4ss@");
  const BASIC = `Basic ${Buffer.from("us@er:päss", "utf8").toString("base64")}`;
  const basic = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: U });
  assert(basic.embeddings.base === B && basic.embeddings.userinfo && basic.chat === basic.embeddings, "userinfo leaves the base, and with no chat knob the chat endpoint is still the embeddings one");
  await providerCall(basic, "/embeddings", embBody, SUBJ);
  await providerCall(basic, "/chat/completions", chatBody, SUBJ);
  assert(seenB.slice(-2).every((s) => s.auth === BASIC), `both calls send the userinfo as Basic, decoded and UTF-8 (${JSON.stringify(seenB.slice(-2).map((s) => s.auth))})`);
  await providerCall(resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: B.replace("://", "://solo@") }), "/embeddings", embBody, SUBJ);
  assert(lastB().auth === `Basic ${btoa("solo:")}`, "a user with no password is Basic with an empty password");
  const rawAt = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: B.replace("://", "://us@er:p@") });
  assert(rawAt.embeddings.base === B && rawAt.embeddings.headers.Authorization === `Basic ${btoa("us@er:p")}`, "an unescaped @ in the user is the URL parser's reading: the last @ ends the userinfo, all of it out of the base");
  const twice = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: U, OB1_CHAT_BASE_URL: U });
  assert(twice.chat === twice.embeddings, "the same base with the same userinfo in both knobs is one endpoint");
  // Second review pass: the same spelling in both knobs is one endpoint with a
  // key too (the key's Bearer for both calls), and so is the chat base without
  // the userinfo.
  const twiceKeyed = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: U, OB1_LLM_API_KEY: "key-u", OB1_CHAT_BASE_URL: U });
  const bareChat = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: U, OB1_LLM_API_KEY: "key-u", OB1_CHAT_BASE_URL: B });
  assert(twiceKeyed.chat === twiceKeyed.embeddings && twiceKeyed.chat.headers.Authorization === "Bearer key-u" && bareChat.chat === bareChat.embeddings,
         "the same base and userinfo in both knobs share the key; so does the chat base spelled without the userinfo");
  // A URL the parser reads userinfo from without `//`, or past a backslash
  // (special schemes read `\` as `/`): rebuilt from the parse, so no userinfo
  // is left and the host dialled is the one the parser read.
  const noSlashes = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: B.replace("http://", "http:/solo:pw@") });
  const backslash = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: "http://u:p@named.invalid\\x@127.0.0.1:1/v1" });
  assert(noSlashes.embeddings.base === B && noSlashes.embeddings.headers.Authorization === `Basic ${btoa("solo:pw")}`
         && new URL(backslash.embeddings.base).hostname === "named.invalid" && !backslash.embeddings.base.includes("u:p"),
         `userinfo the parser reads is taken out whatever the spelling, and the parser's host is dialled (${noSlashes.embeddings.base}; ${backslash.embeddings.base})`);
  // Kept as written where cutting the userinfo means the same URL, so the two
  // knobs' spellings of one base still match (third review pass).
  const spelled = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: "http://u:p@Host.invalid:80/v1", OB1_LLM_API_KEY: "key-s", OB1_CHAT_BASE_URL: "http://Host.invalid:80/v1" });
  assert(spelled.embeddings.base === "http://Host.invalid:80/v1" && spelled.chat === spelled.embeddings,
         `a base keeps its spelling when only the userinfo is cut, and the chat knob's same spelling shares it (${spelled.embeddings.base})`);
  // A base the parser refuses keeps its userinfo (fetch refuses it too); a row
  // masks it as maskUrl did.
  const refused = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: "https://user:s3cret#PW@provider.invalid/v1" });
  assert(!refused.embeddings.userinfo && shownBase(refused.embeddings) === "https://***@provider.invalid/v1",
         `a base the URL parser refuses is shown masked (${shownBase(refused.embeddings)})`);
  // A URL not yet split (brain-compare's, n8n provisioning's) prints as a split
  // endpoint would, a spelling with no `//` too, which no mask over the text
  // reads as userinfo (SMD-2894).
  assert(shownUrl("http:/op:pw@h.invalid/v1") === "http://***@h.invalid/v1" && shownUrl("http://h.invalid/v1") === "http://h.invalid/v1"
         && shownUrl("https://user:s3cret#PW@provider.invalid/v1") === "https://***@provider.invalid/v1",
         `shownUrl masks a URL's userinfo as shownBase masks an endpoint's (${shownUrl("http:/op:pw@h.invalid/v1")})`);
  await providerCall(resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: U, OB1_LLM_API_KEY: "key-u" }), "/embeddings", embBody, SUBJ);
  assert(lastB().auth === "Bearer key-u", "a key takes the Authorization header: Bearer, and the userinfo is not sent");
  const ownUser = resolveEmbedConfig({ ...LOCAL, OB1_LLM_BASE_URL: B, OB1_LLM_API_KEY: "key-a", OB1_CHAT_BASE_URL: U });
  await providerCall(ownUser, "/embeddings", embBody, SUBJ);
  await providerCall(ownUser, "/chat/completions", chatBody, SUBJ);
  assert(ownUser.chat !== ownUser.embeddings && seenB.at(-2)?.auth === "Bearer key-a" && lastB().auth === BASIC,
         "a chat base that is the embeddings base plus userinfo is an endpoint of its own: chat sends the Basic, embeddings keep the key");

  // A failure names the endpoint that was dialled, never its userinfo.
  failB = true;
  let userMsg = "";
  try {
    await providerCall(basic, "/embeddings", embBody, SUBJ);
  } catch (e) {
    userMsg = (e as Error).message;
  }
  assert(userMsg.includes(B) && !/us%40er|p%C3%A4ss/.test(userMsg), `a failure names the base without its userinfo (${userMsg.slice(0, 80)})`);
  failB = false;

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
    hostname: "127.0.0.1",
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

  // SMD-1873: an endpoint that refuses `logprobs` with a 400 is asked again
  // without it, once, and not asked with it again in this process.
  const asked: boolean[] = [];
  const strict = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { logprobs?: boolean };
      asked.push(body.logprobs === true);
      if (body.logprobs) return Response.json({ error: { message: "Unrecognized request argument supplied: logprobs" } }, { status: 400 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "related", supersedes: "unknown", confidence: 0.8, reason: "r" }) } }] });
    },
  });
  const strictCfg = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${strict.port}/v1`, OB1_METADATA_MODEL: META_MODEL });
  const first = await judgePair(older, newer, strictCfg, undefined, undefined, { logprobs: 10 });
  const second = await judgePair(older, newer, strictCfg, undefined, undefined, { logprobs: 10 });
  assert(first.verdict === "related" && !first.malformed && !first.probabilities && second.verdict === "related",
         "a judge call asking for logprobs from an endpoint that refuses them with a 400 still returns the judgement, without probabilities");
  assert(JSON.stringify(asked) === JSON.stringify([true, false, false]), `…asked once with logprobs, then without, and without for the rest of the process (${JSON.stringify(asked)})`);
  strict.stop();

  // Review pass 1: a 400 the request gets with or without logprobs (a
  // context-length overflow) is about the request, so the endpoint is still
  // asked with logprobs next time; and any other status is no retry at all.
  const seen: { logprobs: boolean; status: number }[] = [];
  let status = 400;
  const fussy = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { logprobs?: boolean };
      seen.push({ logprobs: body.logprobs === true, status });
      return Response.json({ error: { message: "maximum context length exceeded" } }, { status });
    },
  });
  const fussyCfg = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${fussy.port}/v1`, OB1_METADATA_MODEL: META_MODEL });
  const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e) => (e as { status?: number }).status ?? -1);
  assert(await statusOf(judgePair(older, newer, fussyCfg, undefined, undefined, { logprobs: 10 })) === 400 && await statusOf(judgePair(older, newer, fussyCfg, undefined, undefined, { logprobs: 10 })) === 400,
         "a 400 the retry without logprobs gets too is the caller's error, twice");
  assert(JSON.stringify(seen.map((x) => x.logprobs)) === JSON.stringify([true, false, true, false]), `…and the second call still asks with logprobs: one overflowing pair does not move the rest of the pass onto the written number (${JSON.stringify(seen)})`);
  // Review pass 3: a 422 is retried as a 400 — text-generation-inference's
  // answer to a top_logprobs past its limit — and remembered once the retry answers.
  const tgi: boolean[] = [];
  const tgiServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { logprobs?: boolean };
      tgi.push(body.logprobs === true);
      if (body.logprobs) return Response.json({ error: "Input validation error: top_n_tokens must be <= 5" }, { status: 422 });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict: "related", supersedes: "unknown", confidence: 0.8, reason: "r" }) } }] });
    },
  });
  const tgiCfg = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${tgiServer.port}/v1`, OB1_METADATA_MODEL: META_MODEL });
  const viaTgi = await judgePair(older, newer, tgiCfg, undefined, undefined, { logprobs: 10 });
  await judgePair(older, newer, tgiCfg, undefined, undefined, { logprobs: 10 });
  const otherModel = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: `http://127.0.0.1:${tgiServer.port}/v1`, OB1_METADATA_MODEL: META_MODEL, OB1_JUDGE_MODEL: "another-judge" });
  await judgePair(older, newer, otherModel, undefined, undefined, { logprobs: 10 });
  assert(viaTgi.verdict === "related" && JSON.stringify(tgi) === JSON.stringify([true, false, false, true, false]),
         `a 422 refusing logprobs is retried without them and remembered — for that model, not for another judge on the same endpoint (${JSON.stringify(tgi)})`);
  tgiServer.stop();
  seen.length = 0;
  status = 503;
  assert(await statusOf(judgePair(older, newer, fussyCfg, undefined, undefined, { logprobs: 10 })) === 503 && JSON.stringify(seen.map((x) => x.logprobs)) === JSON.stringify([true]),
         "a 503 is not retried without logprobs: only a 400 can be the field refused");
  fussy.stop();
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
  /** Set, every answer is held this long after the request is counted (the hard stop, SMD-1794). */
  let holdMs = 0;
  const providerD = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { messages: { content: string }[]; max_tokens?: number };
      const user = body.messages[0].content;
      const inner = /<thought_content>\n([\s\S]*)\n<\/thought_content>/.exec(user)?.[1] ?? "";
      const part = /^\[Part [^\]]*\]/.exec(inner)?.[0];
      const text = part ? inner.slice(part.length).trimStart() : inner;
      reqs.push({ text, maxTokens: body.max_tokens, part });
      if (holdMs) await Bun.sleep(holdMs);
      if (estimateTokens(text) > CEILING) return new Response(JSON.stringify({ error: { message: `input too long: ${estimateTokens(text)} tokens` } }), { status: 400 });
      if (prose || proseIf?.test(text)) return Response.json({ choices: [{ message: { content: "I cannot help with that." } }] });
      // The subject "Daemonic Brain" is in every window; each window also names
      // one person of its own — Anita in the first, Dev in the second, and so on.
      const person = /(Anita|Dev|Priya|Sam)/.exec(text)?.[1];
      const entities: unknown[] = [{ name: "Daemonic Brain", type: "project", confidence: 0.8 + (person === "Dev" ? 0.1 : 0), aliases: person === "Dev" ? ["OB1"] : [] }];
      const relationships: unknown[] = [];
      if (person) { entities.push({ name: person, type: "person", confidence: 0.9 }); relationships.push({ from: person, to: "Daemonic Brain", relation: "works_on", confidence: 0.7 }); }
      return Response.json({ choices: [{ message: { content: JSON.stringify({ entities, relationships }) } }] });
    },
  });
  const D = `http://127.0.0.1:${providerD.port}/v1`;
  const para = (who: string, n: number) => `${who} wrote about Daemonic Brain. ${Array.from({ length: n }, (_, i) => `Sentence ${i} of this paragraph says nothing new about it.`).join(" ")}`;
  // Four paragraphs of ~575 estimated tokens each: about 2,300 in all, over a
  // 600-token window and over the stub's 700-token ceiling as one call.
  const long = [para("Anita", 40), para("Dev", 40), para("Priya", 40), para("Sam", 40)].join("\n\n");
  const short = "Anita wrote about Daemonic Brain.";
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
  assert(subject.length === 1 && subject[0].name === "Daemonic Brain" && subject[0].confidence === 0.9 && subject[0].aliases.includes("OB1"),
         `a subject every window names is ONE entity in the merged answer, at the best confidence with the aliases any window offered (${JSON.stringify(subject)})`);
  const people = many.entities.filter((e) => e.type === "person").map((e) => e.name).sort();
  assert(people.join(",") === "Anita,Dev,Priya,Sam", `…and each window's own person is there once (${people.join(",")})`);
  assert(many.relations.length === 4 && many.relations.every((r) => r.to === "Daemonic Brain" && r.relation === "works_on"), "the four works_on edges, one per window, all to the one subject");
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
  // Each paragraph of ~575 tokens is its own 600-token window's subject: Anita0 … Anita29.
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
  const padded1 = `${"\n".repeat(12000)}${"Anita wrote about Daemonic Brain. ".repeat(40)}`;
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
  assert(some.entities.map((e) => e.name).sort().join(",") === "Anita,Daemonic Brain,Dev" && some.relations.length === 2,
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
  const { RUNAWAY_PENALTY, RUNAWAY_REPEATS, TOKEN_REPEATS, REPEAT_UNIT_MAX, repeatedTail, callsMadeBy } = await import("./entities.ts");
  let runawayOnce = false;
  const penalties: (number | undefined)[] = [];
  /** Set, the penalised retry is held this long, and `onRetry` told as it arrives (the hard stop, SMD-1794). */
  let holdRetryMs = 0;
  let onRetry: (() => void) | null = null;
  const providerE = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as { max_tokens?: number; frequency_penalty?: number };
      penalties.push(body.frequency_penalty);
      if (body.frequency_penalty !== undefined && holdRetryMs) {
        onRetry?.();
        await Bun.sleep(holdRetryMs);
      }
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
  // The hard stop reaches the retry too (SMD-1794): a stop while the penalised
  // retry is in hand aborts it, not after its 3 s answer.
  penalties.length = 0;
  runawayOnce = true;
  holdRetryMs = 3000;
  const retryStop = new AbortController();
  onRetry = () => { setTimeout(() => retryStop.abort(), 200); };
  const retryAt = Date.now();
  let retryErr: unknown = null;
  try { await extractEntities(short, cfgE, undefined, { kind: "extraction" }, undefined, retryStop.signal); } catch (e) { retryErr = e; }
  const retryMs = Date.now() - retryAt;
  holdRetryMs = 0;
  onRetry = null;
  assert(retryErr !== null && retryMs < 1500 && penalties.length === 2 && callsMadeBy(retryErr) === 2,
    `a stop during the runaway's retry aborts it, not after its answer (${retryMs} ms, ${penalties.length} call(s) sent, ${callsMadeBy(retryErr)} counted)`);

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
    hostname: "127.0.0.1",
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
    hostname: "127.0.0.1",
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
    hostname: "127.0.0.1",
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
  let gMode: "loop" | "good" | "json" | "slow" | "cut" | "error" | "nodone" | "oneframe" | "sepfinish" | "cleanclose" | "mislabelled" | "emptyfinish" | "empty" | "cr" | "multiline" | "doneonly" | "braceopen" | "finishtail" | "loop4finish" | "rolefinish" | "crlfsplit" | "tokenloop" | "tokenshort" | "wsclose" | "tokenwhole" | "halfwhole" | "tokenwholeabsent" | "tokenwholeempty" | "punctwhole" | "punctcut" | "windowloop" | "paddedwhole" | "closedrepeat" = "loop";
  // SMD-2449: the 7B naming an entity "Linear Linear …", one token a frame, as
  // Ollama streams it; Ollama's repeat limit ends such a stream with no
  // finish_reason and no [DONE] after 31 copies.
  const LINEAR_HEAD = '{"entities": [{"name": "Anita", "type": "person", "confidence": 0.9}, {"name": "Linear';
  const SHORT_NAME = `Linear${" Linear".repeat(TOKEN_REPEATS - 2)}`;
  const LOOP4 = JSON.stringify({ entities: [{ name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Anita", type: "person", confidence: 0.9 }], relationships: [] });
  // A converging answer whose LAST item is a third copy: the object closes
  // after it, so the abort that was pending never fires. (Anita first: a
  // fourth item after the third copy would be the answer going on — an abort.)
  // …and a relation in the other array after it (seventh pass: an item there
  // is not the loop going on, whatever frame it lands in).
  const THRICE = JSON.stringify({ entities: [{ name: "Anita", type: "person", confidence: 0.9 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }, { name: "Loop", type: "tool", confidence: 1 }], relationships: [{ from: "Anita", to: "Loop", relation: "uses", confidence: 0.8 }] });
  const GOOD = JSON.stringify({ entities: [{ name: "Anita", type: "person", confidence: 0.9, aliases: ["A. {Nita}"] }, { name: "Daemonic Brain", type: "project", confidence: 0.8 }], relationships: [{ from: "Anita", to: "Daemonic Brain", relation: "works_on", confidence: 0.7 }] });
  const frame = (content: string, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;
  const providerG = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Run["body"] & { messages?: { role: string; content: string }[] };
      const run: Run = { sent: 0, total: 0, cancelled: false, body };
      runs.push(run);
      // A whole answer Ollama's repeat limit cut: what it had, finish_reason
      // null (SMD-2449, measured) — or absent, or "", as a compat layer may
      // send it — and the same cut with no repetition, and a cut of dashes.
      const first = !body.stream && body.frequency_penalty === undefined;
      if (gMode === "tokenwhole" && first) return Response.json({ choices: [{ message: { content: LINEAR_HEAD + " Linear".repeat(31) }, finish_reason: null }] });
      if (gMode === "tokenwholeabsent" && first) return Response.json({ choices: [{ message: { content: LINEAR_HEAD + " Linear".repeat(31) } }] });
      if (gMode === "tokenwholeempty" && first) return Response.json({ choices: [{ message: { content: LINEAR_HEAD + " Linear".repeat(31) }, finish_reason: "" }] });
      if (gMode === "punctwhole" && first) return Response.json({ choices: [{ message: { content: `{"entities": [{"name": "${"-".repeat(31)}` }, finish_reason: null }] });
      if (gMode === "halfwhole" && first) return Response.json({ choices: [{ message: { content: GOOD.slice(0, 80) }, finish_reason: null }] });
      // A whole answer that parses, padded with newlines as a model in JSON
      // mode can, with no finish: the answer, not a cut.
      if (gMode === "paddedwhole" && first) return Response.json({ choices: [{ message: { content: GOOD + "\n".repeat(40) }, finish_reason: null }] });
      // Two windows, the first looping (its prompt holds the marker), the
      // second answered whole: the thought's abort is the first window's.
      if (gMode === "windowloop" && !body.messages?.some((m) => m.role === "user" && m.content.includes("WINDOWLOOP"))) return Response.json({ choices: [{ message: { content: GOOD }, finish_reason: "stop" }] });
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
      } else if (gMode === "closedrepeat") {
        // A complete answer and, in the same frame, a word repeated 30 times
        // after its closing brace: the answer closed first, so the guard,
        // read only while it is open, never fires (a layer batching frames).
        frames = [frame(`${GOOD}${" ok".repeat(30)}`, "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "punctcut") {
        // A loop of dashes, cut by Ollama's limit with no end sign: the guard
        // lets punctuation run, the cut is read as the runaway it is.
        frames = [frame('{"entities": [{"name": "'), ...Array.from({ length: 31 }, () => frame("-"))];
      } else if (gMode === "tokenloop" || gMode === "windowloop") {
        // Ollama's repeat-limit shape: the name grows one " Linear" a frame,
        // and after 31 copies the stream ends — no finish_reason, no [DONE].
        frames = [frame(LINEAR_HEAD), ...Array.from({ length: 30 }, () => frame(" Linear"))];
        gapMs = 60;
      } else if (gMode === "tokenshort") {
        // A converging answer whose name holds one copy fewer than the
        // limit, one token a frame: complete, so parsed — never an abort.
        const answer = JSON.stringify({ entities: [{ name: SHORT_NAME, type: "project", confidence: 0.9 }], relationships: [] });
        frames = [...(answer.match(/ ?[^ ]+/g) ?? []).map((p) => frame(p)), frame("", "stop"), "data: [DONE]\n\n"];
      } else if (gMode === "wsclose") {
        // A loop of newlines inside the answer, then the stream ends with no
        // end sign: Ollama compares a whitespace token as empty, so this is
        // its repeat limit too, and the guard does not abort on whitespace.
        frames = [frame('{"entities": [{"name": "Anita"'), ...Array.from({ length: 40 }, () => frame("\n"))];
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

  // SMD-2449: one unit repeated inside the answer — the loop Ollama's repeat
  // limit cuts with no end sign, which read as a socket closed mid-answer, a
  // provider failure the worker paused on and could stop for.
  const linears = (n: number) => `{"name": "Linear${" Linear".repeat(n - 1)}`;
  assert(repeatedTail(linears(TOKEN_REPEATS)) === "Linear" && repeatedTail(linears(TOKEN_REPEATS - 1)) === null,
    `repeatedTail: ${TOKEN_REPEATS} copies of one word at the end are a runaway, ${TOKEN_REPEATS - 1} are not`);
  assert(repeatedTail(`{"name": "${"Linear\n".repeat(8)}${"Linear  ".repeat(8)}${"Linear".repeat(8)}`) === "Linear",
    "…whatever whitespace stands between the copies, as Ollama trims the tokens it compares");
  assert(repeatedTail(`limit=${"9".repeat(20)}`) === null && repeatedTail(`limit=${"9".repeat(TOKEN_REPEATS)}`) === "9",
    "…the stable brain's longest run, twenty 9s in a ticket, is under the limit; a run at the limit is not");
  assert(repeatedTail("Linear".repeat(TOKEN_REPEATS - 1)) === null && repeatedTail(`x inear${" Linear".repeat(TOKEN_REPEATS - 1)}`) === null && repeatedTail("Linear".repeat(TOKEN_REPEATS)) === "Linear",
    `…exactly at the limit: ${TOKEN_REPEATS - 1} whole copies with nothing before them are not a runaway, nor ${TOKEN_REPEATS} copies' length one character short of ${TOKEN_REPEATS} copies (the "x" keeps the text long enough to reach the period check)`);
  assert(repeatedTail(`"name": "${"-".repeat(80)}`) === null && repeatedTail(`"name": "${"=+".repeat(80)}`) === null && repeatedTail(`"name": "${"😀".repeat(40)}`) === null,
    "…while the answer is still coming, a run of punctuation or emoji is left to the budget");
  assert(repeatedTail(`"name": "${"-".repeat(31)}`, { cut: true }) === "-" && repeatedTail(`"name": "${"😀".repeat(31)}`, { cut: true }) === "😀" && repeatedTail(`"name": "${"-".repeat(TOKEN_REPEATS - 1)}`, { cut: true }) === null,
    "…but on a cut answer, with no budget left, any unit is one — Ollama's limit cuts any token");
  const unitOf = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  assert(repeatedTail(unitOf(REPEAT_UNIT_MAX).repeat(TOKEN_REPEATS)) === unitOf(REPEAT_UNIT_MAX) && repeatedTail(unitOf(REPEAT_UNIT_MAX + 1).repeat(TOKEN_REPEATS)) === null,
    `…a unit up to ${REPEAT_UNIT_MAX} characters is seen, a longer one is not`);
  assert(repeatedTail(`{"name": "Anita"${"\n".repeat(TOKEN_REPEATS)}`) === null && repeatedTail(`{"name": "Anita"${"\n".repeat(TOKEN_REPEATS)}`, { cut: true }) === "whitespace"
         && repeatedTail(`{"name": "Anita"${"\n".repeat(TOKEN_REPEATS - 1)}`, { cut: true }) === null
         && repeatedTail(`{"name": "Anita"${" \t".repeat(TOKEN_REPEATS / 2)}`, { cut: true }) === "whitespace",
    "…a run of whitespace is one only for a cut answer, and only at the limit");

  // On the stream: aborted at the limit, before Ollama's own cut, and sent to
  // the penalised retry as any runaway is.
  // A throw is the old reading — "closed mid-answer" — so it is caught and
  // asserted against, not left to end the suite.
  const settled = async (call: () => Promise<Extraction>): Promise<Extraction & { threw?: string }> => {
    try { return await call(); } catch (e) { return { threw: (e as Error).message, entities: [], relations: [], rejected: { entities: 0, relations: 0 }, malformed: true, windows: 0 }; }
  };
  runs.length = 0;
  gMode = "tokenloop";
  const tokenObs: ExtractWindowObservation[] = [];
  const tokenRescued = await settled(() => extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), observe: (r: ExtractWindowObservation) => tokenObs.push(r) }));
  for (let waited = 0; !runs[0]?.cancelled && waited < 2000; waited += 10) await Bun.sleep(10);
  assert(!tokenRescued.malformed && tokenRescued.retried === true && tokenRescued.entities.length === 2 && tokenRescued.entities[0]?.name === "Anita",
    `a name repeating one word is a runaway — the penalised retry's answer is the thought's, where it threw "closed mid-answer" (${JSON.stringify(tokenRescued).slice(0, 120)})`);
  assert(tokenRescued.abortedMs !== undefined && tokenRescued.abortedBy === "token", `…the abort recorded, and why: one unit repeated, not a third copy of an item (${tokenRescued.abortedBy})`);
  assert(runs.length === 2 && runs[0].cancelled && runs[0].sent >= TOKEN_REPEATS && runs[0].sent < runs[0].total && runs[0].total === 31 && runs[1].body.frequency_penalty === RUNAWAY_PENALTY && runs[1].body.stream === undefined,
    `…the client hung up once the ${TOKEN_REPEATS}th copy arrived, before the 31 Ollama cuts at (${runs[0]?.sent} of ${runs[0]?.total} frames), and the retry carried the penalty, read whole`);
  assert(tokenObs.length === 1 && tokenObs[0].aborted && tokenObs[0].malformed, "…and observe reports the first call aborted");

  // A converging answer one copy short of the limit is the answer.
  runs.length = 0;
  gMode = "tokenshort";
  const tokenShort = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!tokenShort.malformed && tokenShort.entities[0]?.name === SHORT_NAME && tokenShort.retried === undefined && tokenShort.abortedMs === undefined && runs.length === 1,
    `a name holding ${TOKEN_REPEATS - 1} copies of one word, in a complete answer, is parsed — not aborted, not retried (${JSON.stringify(tokenShort).slice(0, 100)})`);

  // After the answer has closed the guard is not read: a frame carrying the
  // whole answer and 30 copies of a word after it is the answer.
  runs.length = 0;
  gMode = "closedrepeat";
  const closedRepeat = await extractEntities(short, cfgG, undefined, { kind: "extraction" });
  assert(!closedRepeat.malformed && closedRepeat.entities.length === 2 && closedRepeat.retried === undefined && closedRepeat.abortedMs === undefined && runs.length === 1,
    `a complete answer followed, in its own frame, by ${TOKEN_REPEATS + 6} copies of a word is parsed — the guard never reads past the close (${JSON.stringify(closedRepeat).slice(0, 80)})`);

  // A cut ending in a run of whitespace: the guard let it run (whitespace can
  // indent an answer in progress), and the cut is classified as the runaway.
  runs.length = 0;
  gMode = "wsclose";
  const wsClose = await settled(() => extractEntities(short, cfgG, undefined, { kind: "extraction" }));
  assert(!wsClose.malformed && wsClose.retried === true && wsClose.abortedBy === "token" && runs.length === 2 && runs[0].sent === runs[0].total,
    `a stream that ends in a run of newlines with no end sign is Ollama's repeat limit, retried — not a closed socket (${JSON.stringify(wsClose).slice(0, 100)}; ${runs[0]?.sent} of ${runs[0]?.total} frames)`);

  // Read whole (the retry's path, or the stream abort off): Ollama returns
  // the cut answer with finish_reason null. With a repeated tail it is a
  // runaway, retried; with none it is the model's malformed answer, as before.
  runs.length = 0;
  gMode = "tokenwhole";
  const tokenWhole = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), streamAbort: false });
  assert(!tokenWhole.malformed && tokenWhole.retried === true && tokenWhole.abortedMs === undefined && runs.length === 2 && runs[0].body.stream === undefined && runs[1].body.frequency_penalty === RUNAWAY_PENALTY,
    `a whole answer cut with finish_reason null after a repeated word is a runaway, sent to the retry — it was read as the model's malformed answer and kept (${JSON.stringify(tokenWhole).slice(0, 100)})`);
  for (const mode of ["tokenwholeabsent", "tokenwholeempty"] as const) {
    runs.length = 0;
    gMode = mode;
    const noFinish = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), streamAbort: false });
    assert(!noFinish.malformed && noFinish.retried === true && runs.length === 2,
      `…and so is one whose finish_reason is ${mode === "tokenwholeabsent" ? "absent" : "\"\""}, as the stream reader reads no finish (${JSON.stringify(noFinish).slice(0, 80)})`);
  }

  // Punctuation: the guard lets it run while a budget is left, and a cut of
  // it — streamed or whole — is Ollama's limit all the same.
  runs.length = 0;
  gMode = "punctcut";
  const punctCut = await settled(() => extractEntities(short, cfgG, undefined, { kind: "extraction" }));
  assert(!punctCut.malformed && punctCut.retried === true && punctCut.abortedBy === "token" && runs.length === 2 && runs[0].sent === runs[0].total,
    `a stream of dashes cut with no end sign is the runaway, retried — not a closed socket (${JSON.stringify(punctCut).slice(0, 100)})`);
  runs.length = 0;
  gMode = "punctwhole";
  const punctWhole = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), streamAbort: false });
  assert(!punctWhole.malformed && punctWhole.retried === true && runs.length === 2,
    `…and a whole answer of dashes cut with finish_reason null is retried, not kept as malformed (${JSON.stringify(punctWhole).slice(0, 80)})`);

  // Two windows, the first a token runaway: its window and the thought carry
  // the reason the worker's failed-row note reads.
  runs.length = 0;
  gMode = "windowloop";
  const paragraph = (marker: string) => `${marker} ${"The ledger rewrite moved every report onto the new store and the team signed off on it. ".repeat(5)}`;
  const twoWin = await extractEntities(`${paragraph("WINDOWLOOP")}\n\n${paragraph("Calm")}`, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), windowTokens: 120, overlapTokens: 0 });
  assert(twoWin.windows === 2 && !twoWin.malformed && twoWin.parts?.[0].abortedBy === "token" && twoWin.parts?.[1].abortedBy === undefined && twoWin.abortedBy === "token",
    `a windowed thought keeps each window's abort reason, and the thought's is its aborted window's (${JSON.stringify(twoWin.parts?.map((p) => [p.index, p.abortedBy ?? null, p.retried ?? null]))}; ${twoWin.abortedBy})`);

  runs.length = 0;
  gMode = "halfwhole";
  const halfWhole = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), streamAbort: false });
  assert(halfWhole.malformed && halfWhole.retried === undefined && runs.length === 1,
    "…and a whole answer cut with finish_reason null and no repetition is the malformed answer it was, not retried");
  runs.length = 0;
  gMode = "paddedwhole";
  const paddedWhole = await extractEntities(short, cfgG, undefined, { kind: "extraction" }, { ...windowingFor(cfgG), streamAbort: false });
  assert(!paddedWhole.malformed && paddedWhole.retried === undefined && paddedWhole.entities.length === 2 && runs.length === 1,
    "…and one that parses, padded with 40 newlines and no finish, is the answer — only a malformed answer is read for a cut");
  gMode = "loop";

  // Reasoning on (second review pass): max_tokens would cap the thinking and
  // the answer together, so no budget is sent and a cut answer is not retried.
  const maxTokensSeen: (number | undefined)[] = [];
  const providerF = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
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

  // The claim worker's hard stop (SMD-1794): a stop aborts the window in hand
  // and sends no other; one already aborted sends nothing, and counts no call.
  const { callsMadeBy: madeBy } = await import("./entities.ts");
  const stopped = new AbortController();
  stopped.abort();
  reqs.length = 0;
  let early: unknown = null;
  try { await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, stopped.signal); } catch (e) { early = e; }
  assert(early !== null && reqs.length === 0 && madeBy(early) === 0,
         `a stop already aborted sends no window and counts no call (${reqs.length} sent, ${madeBy(early)} counted)`);
  holdMs = 3000;
  reqs.length = 0;
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 200);
  const stopAt = Date.now();
  let midStop: unknown = null;
  try { await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, stop.signal); } catch (e) { midStop = e; }
  const stopMs = Date.now() - stopAt;
  holdMs = 0;
  assert(midStop !== null && stopMs < 1500 && reqs.length === 1 && madeBy(midStop) === 1,
         `a stop during the first of a long thought's windows aborts that call, not after its 3 s answer, and sends no other window (${stopMs} ms, ${reqs.length} sent, ${madeBy(midStop)} counted)`);

  // SMD-2694: the windows a stopped claim answered are kept, and the next
  // claim of the same text sends only the rest. An in-memory store stands in
  // for 093's table: it keeps what `save` hands it and answers `kept` only for
  // the request a window answered.
  const { callsOf: callsOfD } = await import("./entities.ts");
  type Stored = { part: ExtractionWindow; sent: string; windows: number };
  const store = new Map<number, Stored>();
  let onSave: ((n: number) => void) | null = null;
  const progressD: ExtractProgress = {
    kept: (i, sent) => (store.get(i)?.sent === sent ? store.get(i)!.part : undefined),
    save: async (part, sent, windows) => { store.set(part.index, { part, sent, windows }); onSave?.(store.size); },
  };
  reqs.length = 0;
  const unbroken = await extractEntities(long, cfgD, undefined, { kind: "extraction" });
  const all = reqs.length;
  assert(all >= 3, `the unbroken run the resumed one is held to: ${all} windows`);
  reqs.length = 0;
  const stopAfterTwo = new AbortController();
  onSave = (n) => { if (n === 2) stopAfterTwo.abort(); };
  let firstClaim: unknown = null;
  try { await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, stopAfterTwo.signal, progressD); } catch (e) { firstClaim = e; }
  onSave = null;
  assert(firstClaim !== null && reqs.length === 2 && store.size === 2 && [...store.keys()].join(",") === "0,1" && [...store.values()].every((s) => s.windows === all),
         `a claim stopped after its second window keeps those two, each with the thought's window count (${reqs.length} sent, kept ${[...store.keys()].join(",")})`);
  reqs.length = 0;
  const resumed = await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, progressD);
  assert(reqs.length === all - 2 && reqs.every((r, i) => r.part === `[Part ${i + 3} of ${all} of a longer note]`),
         `the next claim sends only the windows still to do, from the third on (${reqs.map((r) => r.part).join(" | ")})`);
  assert(JSON.stringify({ e: resumed.entities, r: resumed.relations, w: resumed.windows }) === JSON.stringify({ e: unbroken.entities, r: unbroken.relations, w: unbroken.windows }),
         "…and its answer is the unbroken run's: the same entities, aliases and confidences in the same order, the same relations and window count");
  assert(resumed.parts?.map((p) => p.resumed === true).join(",") === Array.from({ length: all }, (_, i) => i < 2).join(",") && callsOfD(resumed) === all - 2 && callsOfD(unbroken) === all,
         `the kept windows are marked resumed and cost no call in this claim (calls ${callsOfD(resumed)} of ${all})`);
  assert(store.size === all, `…and the windows it answered are kept as they parse (${store.size} of ${all})`);
  // A kept window is reused only for the request it answered: one whose text
  // changed under the same index — a chunker or header change — is asked again.
  store.get(0)!.sent = "another request";
  reqs.length = 0;
  await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, progressD);
  assert(reqs.length === 1 && reqs[0].part === `[Part 1 of ${all} of a longer note]`, `a kept window whose request differs is asked again, and only it (${reqs.map((r) => r.part).join(" | ")})`);
  // A malformed answer is never kept, and one kept anyway is asked again.
  store.clear();
  proseIf = /Priya/;
  reqs.length = 0;
  const withProse = await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, progressD);
  proseIf = null;
  const proseAt = withProse.coverage?.malformed?.[0];
  assert(proseAt !== undefined && store.size === all - 1 && !store.has(proseAt), `the window answered in prose is not kept, the others are (kept ${[...store.keys()].join(",")}, prose ${proseAt})`);
  // A store that hands the prose window back whatever the request: only the
  // malformed mark keeps it from being reused.
  const keepsProse: ExtractProgress = {
    kept: (i, sent) => (i === proseAt ? withProse.parts![i] : progressD.kept(i, sent)),
    save: progressD.save,
  };
  reqs.length = 0;
  const reasked = await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, keepsProse);
  assert(reqs.length === 1 && reqs[0].part === `[Part ${proseAt! + 1} of ${all} of a longer note]` && reasked.coverage === undefined,
         `a malformed window kept anyway is asked again, and its answer now parses (${reqs.map((r) => r.part).join(" | ")})`);
  // A prefix cut to one window is a windowed thought sent once: nothing after
  // it to resume, so nothing kept (review pass 1 — 093 refuses a one-window row).
  let lone = 0;
  const countsSaves: ExtractProgress = { kept: () => undefined, save: async () => { lone++; } };
  reqs.length = 0;
  const oneOfMany = await extractEntities(long, cfgCap("1"), undefined, { kind: "extraction" }, undefined, undefined, countsSaves);
  assert(reqs.length === 1 && oneOfMany.parts?.length === 1 && lone === 0, `a prefix of one window is sent and not kept (${reqs.length} sent, ${lone} saved)`);

  // SMD-3379 PR 1b: the worker's admit gate is awaited before each window
  // sent — not before a kept one, nor for a thought sent in one call — and
  // its rejection rejects the extraction there, the windows before it kept.
  const { StoppedBetweenWindows: Stopped } = await import("./entities.ts");
  const gates: number[] = [];
  let open: (() => void) | null = null;
  /** Set once the case opens the gate: an ask after it goes through, so a slow runner fails a row rather than hangs (review pass 6). */
  let released = false;
  const closedAt = (n: number, reject = false) => (): Promise<void> => {
    gates.push(reqs.length);
    if (gates.length !== n || (released && !reject)) return Promise.resolve();
    return reject ? Promise.reject(new Stopped()) : new Promise<void>((resolve) => { open = resolve; });
  };
  store.clear();
  reqs.length = 0;
  const waiting = extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, progressD, closedAt(2));
  for (let i = 0; i < 250 && open === null; i++) await Bun.sleep(20);
  await Bun.sleep(100);
  const sentWhileClosed = reqs.length;
  released = true;
  (open as (() => void) | null)?.();
  const throughGate = await waiting;
  assert(sentWhileClosed === 1 && gates.join(",") === Array.from({ length: all }, (_, i) => i).join(",") && reqs.length === all && JSON.stringify(throughGate.entities) === JSON.stringify(unbroken.entities),
         `a gate closed before the second window holds it unsent until it opens, and is asked once before each window sent (${sentWhileClosed} sent while closed; asked with ${gates.join(",")} sent)`);
  store.clear();
  reqs.length = 0;
  gates.length = 0;
  let gateRefused: unknown = null;
  try { await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, progressD, closedAt(3, true)); } catch (e) { gateRefused = e; }
  assert(gateRefused instanceof Stopped && reqs.length === 2 && madeBy(gateRefused) === 2 && [...store.keys()].join(",") === "0,1",
         `a gate that rejects before the third window rejects the extraction there, two windows sent and kept (${(gateRefused as Error | null)?.name}, ${reqs.length} sent, kept ${[...store.keys()].join(",")})`);
  reqs.length = 0;
  gates.length = 0;
  await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, progressD, closedAt(0));
  assert(reqs.length === all - 2 && gates.length === all - 2, `the next claim asks the gate before each window it sends, not the two kept (${gates.length} asked, ${reqs.length} sent)`);
  gates.length = 0;
  await extractEntities(short, cfgD, undefined, { kind: "extraction" }, undefined, undefined, undefined, closedAt(0));
  assert(gates.length === 0, `a thought sent in one call never asks the gate: the worker's claim did (${gates.length} asked)`);
  // A first stop that comes while the gate holds a window, the gate then
  // opening: the window is not sent, as a first stop's rule says.
  const firstStop = new AbortController();
  store.clear();
  reqs.length = 0;
  let lateStop: unknown = null;
  try {
    await extractEntities(long, cfgD, undefined, { kind: "extraction" }, undefined, undefined, { ...progressD, between: firstStop.signal }, async () => { if (reqs.length === 1) firstStop.abort(); });
  } catch (e) { lateStop = e; }
  assert(lateStop instanceof Stopped && reqs.length === 1 && store.size === 1,
         `a first stop that comes while the gate holds the second window ends the thought there once the gate opens, the first window kept (${(lateStop as Error | null)?.name}, ${reqs.length} sent, ${store.size} kept)`);
  providerD.stop();
}

console.log("\n[11] Every model call goes through the model-call seam, live inside a request and background outside one, the whole exchange inside it and its deadline started there (SMD-3379 PR 2a)");
{
  const { setModelCallHook, asLive, modelCall, asPass, withCallWaits } = await import("./model-call.ts");
  type Call = import("./model-call.ts").ResolvedModelCall;
  const { resolveEmbedConfig, createEmbedder } = await import("./embed.ts");
  const { judgePair } = await import("./consolidate.ts");
  const { extractEntities } = await import("./entities.ts");
  const { resolveJevConfig, jevInfo } = await import("./jev.ts");
  const { probeChat } = await import("../db/worker-bootstrap.ts");
  const calls: { call: Call; answer: unknown }[] = [];
  /** Held before each call runs, in ms: what PR 2b's wait for a slot will be. */
  let holdMs = 0;
  /** Set, the hook refuses every call before it runs: nothing may reach the provider around the seam. */
  let refuse = false;
  const restore = setModelCallHook(async (call, run) => {
    if (refuse) throw new Error("the seam refused");
    if (holdMs) await Bun.sleep(holdMs);
    // Counted before it runs, so a call that then fails is seen too.
    const seenCall: { call: Call; answer: unknown } = { call, answer: undefined };
    calls.push(seenCall);
    const answer = await run();
    seenCall.answer = answer;
    return answer;
  });
  try {
    // A capture through the MCP server is a request the REST core serves: its embedding and its metadata call are live.
    calls.length = 0;
    await call("capture_thought", { content: "A thought captured through the seam." });
    const live = calls.map((c) => c.call);
    const emb = live.find((c) => c.type === "embed");
    const meta = live.find((c) => c.type === "chat");
    assert(emb?.cls === "live" && emb.model === EMB_MODEL && emb.base === PROVIDER && emb.purpose === "capture" && meta?.cls === "live" && meta.model === META_MODEL && meta.base === PROVIDER,
      `a capture's calls go through the seam, live: its embedding and its metadata call, each naming its model and the model server (${JSON.stringify(live)})`);
    const cfg = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: PROVIDER, OB1_METADATA_MODEL: META_MODEL, OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_EMBEDDING_DIM: String(DIM) });
    const getEmbedding = (text: string, c: typeof cfg, subject: import("./egress.ts").EgressSubject, signal?: AbortSignal) => createEmbedder(() => c).getEmbedding(text, subject, "document", signal);
    // Outside a request a call is background, as the passes', board-sync's and the servers' timers' are; asLive says live.
    calls.length = 0;
    await getEmbedding("a background embedding", cfg, { kind: "re-embed" });
    await asLive(() => getEmbedding("a live embedding", cfg, { kind: "query" }));
    assert(calls.length === 2 && calls[0].call.cls === "background" && calls[0].call.purpose === "re-embed" && calls[1].call.cls === "live" && Array.isArray((calls[0].answer as { data?: unknown[] } | undefined)?.data),
      `outside a request a call is background, inside asLive live, and the seam's run returns the answer read, not a response (${JSON.stringify(calls.map((c) => c.call))})`);
    // The passes' own fetches: extraction's, the judge's, a worker's probe, and the decide tier's.
    calls.length = 0;
    await extractEntities("Ada works on Daemonic Brain.", cfg, undefined, { kind: "extraction" });
    await judgePair({ content: "older", createdAt: null }, { content: "newer", createdAt: null }, cfg);
    await probeChat({ base: PROVIDER, headers: {} }, META_MODEL, 5000);
    const jev = resolveJevConfig({ OB1_JEV_BASE_URL: PROVIDER, OB1_JEV_LOCAL: "1", OB1_JEV_MODEL: "stub-decider" })!;
    // The stand-in answers the tier's /info in its contract: the call is read whole inside the seam.
    const info = await jevInfo(jev).then((i) => i, (e: unknown) => String(e));
    const seen11 = calls.map((c) => `${c.call.type}/${c.call.purpose}/${c.call.cls}/${c.call.model}`);
    assert(seen11.includes(`chat/extraction/background/${META_MODEL}`) && seen11.includes(`chat/judge/background/${META_MODEL}`) && seen11.includes(`chat/probe/background/${META_MODEL}`)
      && seen11.includes("decide/info/background/stub-decider") && typeof info === "object" && info.contract === "ob1-jev/1"
      && calls.every((c) => c.answer !== undefined && !(c.answer instanceof Response)),
      `extraction, the judge, a worker's probe and the decide tier each go through the seam, background, each run returning what it read (${JSON.stringify(seen11)})`);
    // The seam is the way through, not a witness: a hook that refuses sends nothing to the provider.
    const before = seen.length;
    refuse = true;
    const refused = await Promise.all([
      getEmbedding("refused", cfg, { kind: "re-embed" }).then(() => false, () => true),
      extractEntities("Refused by the seam.", cfg, undefined, { kind: "extraction" }).then(() => false, () => true),
      judgePair({ content: "a", createdAt: null }, { content: "b", createdAt: null }, cfg).then(() => false, () => true),
      // A hook's refusal is the seam's failure, thrown: not read as the provider out.
      probeChat({ base: PROVIDER, headers: {} }, META_MODEL, 5000).then(() => false, () => true),
      jevInfo(jev).then(() => false, () => true),
    ]);
    refuse = false;
    assert(refused.every(Boolean) && seen.length === before, `a hook that refuses every call stops each before the provider sees it (${refused.join(",")}; ${seen.length - before} request(s) reached it)`);
    // The deadline starts inside the seam: a wait longer than the call's own deadline, before the call runs, costs it nothing.
    const tight = { ...cfg, timeoutMs: 1000 };
    holdMs = 2000;
    const heldOk = await getEmbedding("held before it runs", tight, { kind: "re-embed" }).then(() => true, (e: unknown) => String(e));
    const heldExtract = await extractEntities("Held before it runs.", tight, undefined, { kind: "extraction" }).then(() => true, (e: unknown) => String(e));
    holdMs = 0;
    assert(heldOk === true && heldExtract === true, `a 2 s wait in the seam before a call with a 1 s deadline: the call still answers, its deadline started inside the seam (${heldOk}; ${heldExtract})`);
    // The egress gate refuses before the seam, so a refused call waits for no slot: an endpoint not declared local,
    // under the default deny policy, is refused with no call through the seam.
    const away = resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://192.0.2.1/v1", OB1_LLM_API_KEY: "k", OB1_METADATA_MODEL: META_MODEL, OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_EMBEDDING_DIM: String(DIM) });
    calls.length = 0;
    const awayRefused = await getEmbedding("refused at the gate", away, { kind: "re-embed" }).then(() => "sent", (e: unknown) => (e as { kind?: string }).kind ?? String(e));
    assert(awayRefused === "egress" && calls.length === 0, `the egress gate refuses before the seam: no call reaches it (${awayRefused}; ${calls.length} call(s))`);
    // The span inside the seam, so it times the call, not a wait before it.
    const { useTracing, NO_SPAN } = await import("./spans.ts");
    const spans: { name: string; ms: number }[] = [];
    useTracing({ run: async (name, _request, fn) => { const t0 = Date.now(); try { return await fn(NO_SPAN); } finally { spans.push({ name, ms: Date.now() - t0 }); } } });
    holdMs = 500;
    try {
      await getEmbedding("a span timed inside the seam", cfg, { kind: "re-embed" });
    } finally {
      holdMs = 0;
      useTracing(undefined);
    }
    const provSpan = spans.find((x) => x.name.startsWith("embeddings "));
    assert(provSpan !== undefined && provSpan.ms < 400, `the provider's span is inside the seam: it times the call, not the seam's 500 ms wait before it (${JSON.stringify(spans)})`);
    // Each pass hands the seam its stop, which a hook waiting for a slot ends its wait on.
    const stop = new AbortController();
    calls.length = 0;
    await extractEntities("Ada works on Daemonic Brain.", cfg, undefined, { kind: "extraction" }, undefined, stop.signal);
    await judgePair({ content: "older", createdAt: null }, { content: "newer", createdAt: null }, cfg, stop.signal);
    await probeChat({ base: PROVIDER, headers: {} }, META_MODEL, 5000, stop.signal);
    await getEmbedding("an embedding with a stop", cfg, { kind: "re-embed" }, stop.signal);
    await jevInfo(jev, { signal: stop.signal });
    assert(calls.length === 5 && calls.every((c) => c.call.signal === stop.signal), `extraction, the judge, a probe, an embedding and the decide tier each hand the seam their stop (${calls.map((c) => `${c.call.purpose}:${c.call.signal === stop.signal}`).join(", ")})`);
    // A call that says its class outright keeps it, whatever the context (review pass 2).
    calls.length = 0;
    await modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "probe", cls: "live" }, async () => "said");
    await asLive(() => modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "probe", cls: "background" }, async () => "said"));
    assert(calls.map((c) => c.call.cls).join(",") === "live,background", `a call's own class stands over the context's (${calls.map((c) => c.call.cls).join(",")})`);
  } finally {
    setModelCallHook(restore);
  }
  // A hook that ends its wait on the probe's stop leaves it reading as stopped (review pass 1); a hook that throws
  // before it returns — not the stop — rejects the call, thrown, not read as the provider out (review pass 2).
  {
    const before = setModelCallHook(() => { throw new Error("a hook's own bug"); });
    try {
      // Called bare, so a throw that escapes before the promise exists is seen as one, not folded into a rejection.
      let pending: Promise<unknown> | null = null;
      let threwAtCall = "";
      try {
        pending = probeChat({ base: PROVIDER, headers: {} }, META_MODEL, 5000);
      } catch (e) {
        threwAtCall = (e as Error).message;
      }
      const sync = pending ? await pending.then((p) => ({ resolved: p }), (e: unknown) => ({ rejected: (e as Error).message })) : { threwAtCall };
      assert(JSON.stringify(sync) === JSON.stringify({ rejected: "a hook's own bug" }), `a hook that throws before it returns rejects the probe — no throw at the call — its error said, not read as the provider out (${JSON.stringify(sync)})`);
    } finally {
      setModelCallHook(before);
    }
  }
  {
    const wake = new AbortController();
    const before = setModelCallHook((call) => new Promise((_resolve, reject) => call.signal?.addEventListener("abort", () => reject(call.signal?.reason), { once: true })));
    try {
      setTimeout(() => wake.abort(), 50);
      const probe = await probeChat({ base: PROVIDER, headers: {} }, META_MODEL, 5000, wake.signal).then((p) => p, (e: unknown) => ({ threw: String(e) }));
      assert(JSON.stringify(probe) === JSON.stringify({ state: "out", why: "the probe was stopped" }), `a probe whose stop ends a hook's wait reads as stopped, never a throw (${JSON.stringify(probe)})`);
    } finally {
      setModelCallHook(before);
    }
  }
  // The seam's context for 2b's and 2c's hooks (review pass 3): asPass labels a call's pass, and withCallWaits tells a
  // worker's observer of each call's wait on the hook — a fan-out's two calls held, the entry holding no call to abort
  // until the last runs, and a wait inside one idleWhile already holds leaving it held.
  {
    const { inHandCalls, callWaitsFor } = await import("../db/lease.ts");
    const holds = new Map<string, number>([["a", 200], ["b", 400]]);
    const seenPasses: (string | undefined)[] = [];
    // A hold is a wait, told as the hook starts it (review pass 6).
    const before = setModelCallHook(async (call, run, waiting) => { seenPasses.push(call.pass); if (holds.has(call.purpose)) waiting(); await Bun.sleep(holds.get(call.purpose) ?? 0); return run(); });
    try {
      const calls2 = inHandCalls(() => false);
      const entry = calls2.begin("w");
      entry.since = Date.now() - 10_000;
      const at = (ms: number) => Bun.sleep(ms).then(() => ({ waiting: entry.waiting, aborted: calls2.abortInHand(5000) }));
      const [, , mid, late] = await asPass("extract", () => withCallWaits(callWaitsFor(() => calls2.get("w")), () => Promise.all([
        modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "a" }, async () => "a"),
        modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "b" }, async () => "b"),
        at(100),
        at(300),
      ])));
      const after = { waiting: entry.waiting, fresh: Date.now() - entry.since < 1000 };
      // Inside an idleWhile (the decider's call), the entry stays held through the seam's wait and after it.
      const nested = calls2.begin("n");
      nested.waiting = true;
      await withCallWaits(callWaitsFor(() => calls2.get("n")), () => modelCall({ type: "decide", model: undefined, base: PROVIDER, purpose: "a" }, async () => "d"));
      assert(JSON.stringify(seenPasses) === '["extract","extract",null]' && mid.waiting && mid.aborted === 0 && late.waiting && late.aborted === 0 && !after.waiting && after.fresh && nested.waiting,
        `a pass's calls carry its label; while either of a fan-out's calls waits on the hook the entry holds no call to abort, its time starting when the last runs; inside an idleWhile it stays held (${JSON.stringify({ seenPasses, mid, late, after, nested: nested.waiting })})`);
    } finally {
      setModelCallHook(before);
    }
  }
  // A file that sends a model request goes through the seam: it imports it. A file-level guard — a second, bare fetch in
  // a file that imports the seam passes it — over the servers', the REST core's and db/'s files, a fetch's first 200
  // characters read for a model path or a path variable.
  const { readdirSync, readFileSync } = await import("node:fs");
  const here = dirname(fileURLToPath(import.meta.url));
  const dirs = [here, join(here, "core"), join(here, "rest"), join(here, "../db")];
  const files = dirs.flatMap((d) => readdirSync(d).map((f) => join(d, f))).filter((f) => f.endsWith(".ts") && !/\/test-[^/]*\.ts$/.test(f) && !f.endsWith("/model-call.ts"));
  const bare = files.filter((f) => {
    const src = readFileSync(f, "utf8");
    return /fetch\s*\([\s\S]{0,200}?(\/chat\/completions|\/embeddings|\/decide|\$\{path\})/.test(src) && !/^import [^;]*from "(\.\/|\.\.\/|\.\.\/server-portable\/)model-call\.ts";/m.test(src);
  });
  assert(bare.length === 0, `every file that sends a model request imports the model-call seam (${bare.map((f) => f.split("/").slice(-2).join("/")).join(", ") || "none bare"})`);
}

console.log("\n[12] OB1_BACKGROUND_SLOTS: background calls held to a share of a model server's slots across the brain's processes by advisory locks, live calls never; off unless set; a stop ends a wait; the semaphore fails open (SMD-3379 PR 2b-1)");
{
  const { backgroundSlotsFrom, normalisedBase, shareOf, installBackgroundSlots, SLOTS_APP, SLOTS_CHANNEL } = await import("./slots.ts");
  const { modelCall, asLive, withCallWaits } = await import("./model-call.ts");
  const { pausableTimeout, inHandCalls, callWaitsFor: waitsFor, idleWhile, StoppedWaiting } = await import("../db/lease.ts");
  // The setting: types and per-model overrides; off by default; a value that does not parse said, the hook left off.
  const parsed = backgroundSlotsFrom("chat=1, embed=2,decide=1,chat:qwen3.8:27b=3");
  const refused = ["chat=0", "chat=17", "talk=1", "decide:x=1", "chat:=1", "chat=1,chat=2", "chat", "chat:m=1,chat : m=2"].map((r) => backgroundSlotsFrom(r).problem ?? "");
  const spaced = backgroundSlotsFrom("chat : qwen3.8:27b = 2").slots;
  assert(backgroundSlotsFrom(undefined).slots === null && backgroundSlotsFrom(" off ").slots === null && !backgroundSlotsFrom("").problem
    && JSON.stringify([...(parsed.slots ?? new Map())]) === JSON.stringify([["chat", 1], ["embed", 2], ["decide", 1], ["chat:qwen3.8:27b", 3]]) && refused.every(Boolean)
    && spaced?.get("chat:qwen3.8:27b") === 2
    && /"chat" has no =N/.test(refused[6]) && /names no model type/.test(refused[2]),
    `OB1_BACKGROUND_SLOTS reads types and per-model overrides, is off unset or off, and refuses a zero, too many, an unknown type, a model on the decide tier, an empty model, a repeat (spaced or not) and a bare name, each in its own words; spaces about a model's name are not part of it (${JSON.stringify(refused.map((r) => r.slice(0, 40)))})`);
  // A call's share: per normalised server and model, the decide tier per server; live and unlisted types none.
  const sl = parsed.slots!;
  const bg = (type: "embed" | "chat" | "decide", model: string | undefined, base: string) => shareOf(sl, { type, model, base, cls: "background" });
  const decideKey = bg("decide", "m1", "http://t")?.key;
  assert(normalisedBase("HTTP://User:pw@Ollama.Local:11434/v1/") === "http://ollama.local:11434/v1"
    && bg("chat", "llama3.2", "http://h/v1")?.key === "ob1:slot:chat:http://h/v1:llama3.2" && bg("chat", "llama3.2", "http://h/v1")?.limit === 1
    && bg("chat", "qwen3.8:27b", "http://h/v1")?.limit === 3 && decideKey === "ob1:slot:decide:http://t" && decideKey === bg("decide", "m2", "http://t/")?.key
    && shareOf(sl, { type: "chat", model: "llama3.2", base: "http://h/v1", cls: "live" }) === null
    && shareOf(backgroundSlotsFrom("chat=1").slots!, { type: "embed", model: "e", base: "http://h/v1", cls: "background" }) === null,
    "a share is per normalised model server and model, a model's override over its type's, the decide tier per server alone; a live call and a type left out count against none");
  // Off: no hook, the call runs at once. Unset, the defaults' hook (PR 2b-2b), put back at once.
  const off = installBackgroundSlots({ url: URL_!, raw: "off" });
  const unsetHook = installBackgroundSlots({ url: URL_!, raw: undefined });
  await unsetHook.uninstall();
  assert(!off.installed && unsetHook.installed, "off, no hook is set; unset, the defaults' is (PR 2b-2b)");
  const watch = new SQL({ url: URL_, max: 1 });
  // The share's queue lock (slot -2, an oid of 4294967294 in pg_locks): held by the call at its head, or asked for by those behind (PR 2c-1).
  const queueLocks = async (db: SQL, granted = true) => Number((await db`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND objid = 4294967294 AND granted = ${granted}`)[0].c);
  const semConns = async () => Number((await watch`SELECT count(*)::int AS c FROM pg_stat_activity WHERE application_name = ${SLOTS_APP}`)[0].c);
  const call = (model = META_MODEL, cls?: "live") => ({ type: "chat" as const, model, base: PROVIDER, purpose: "test", ...(cls ? { cls } : {}) });
  const key = shareOf(backgroundSlotsFrom("chat=1").slots!, { ...call(), cls: "background" })!.key;
  // On, chat=1: three background chat calls one at a time across the semaphore; a live one and an embedding at once.
  const said: string[] = [];
  const on = installBackgroundSlots({ url: URL_!, raw: "chat=1", log: (l) => said.push(l) });
  try {
    let inFlight = 0, most = 0;
    const work = (ms: number) => async () => { inFlight++; most = Math.max(most, inFlight); await Bun.sleep(ms); inFlight--; return ms; };
    const t0 = Date.now();
    let liveAt = 0, embedAt = 0, heldConns = -1;
    await Promise.all([
      modelCall(call(), work(300)),
      modelCall(call(), work(300)),
      modelCall(call(), work(300)),
      Bun.sleep(50).then(() => asLive(() => modelCall(call(META_MODEL, "live"), async () => { liveAt = Date.now() - t0; }))),
      Bun.sleep(50).then(() => modelCall({ type: "embed", model: EMB_MODEL, base: PROVIDER, purpose: "test" }, async () => { embedAt = Date.now() - t0; })),
      Bun.sleep(200).then(async () => { heldConns = await semConns(); }),
    ]);
    const both = Date.now() - t0;
    // A connection that let its slot go is kept 2 s for the next call (review pass 5), and a closed backend leaves
    // pg_stat_activity a few ms after its close, more under load (review pass 3).
    const keptConns = await semConns();
    let idleConns = keptConns;
    for (let i = 0; i < 175 && idleConns > 0; i++) { await Bun.sleep(20); idleConns = await semConns(); }
    assert(on.installed && most === 1 && both >= 900 && liveAt < 250 && embedAt < 250 && heldConns === 3 && keptConns >= 1 && keptConns <= 3 && idleConns === 0 && said.length === 0,
      `chat=1: three background chat calls run one at a time (${both} ms for three of 300), a live call and an unlisted embedding at once beside them (${liveAt} ms, ${embedAt} ms); three connections while a call holds its slot and two queue — the holder's, one waiter's and the channel's (PR 2c-1) — one to three kept a while, none once idle, the channel's closed too (${heldConns}, ${keptConns}, ${idleConns}); nothing said`);
    // Each model's share its own: three models under chat=1 run at once, none queued behind another's.
    const t2 = Date.now();
    const starts: number[] = [];
    await Promise.all(["m-a", "m-b", "m-c"].map((m) => modelCall(call(m), async () => { starts.push(Date.now() - t2); await Bun.sleep(300); })));
    assert(starts.length === 3 && Math.max(...starts) < 250, `three models under chat=1 each take their own share's slot at once (${JSON.stringify(starts)} ms)`);
    // Another process asking: it joins the share's queue behind this one's call already in it, one call at a time from
    // each process, so it gets the next slot but one this process lets go however many calls this one has waiting — back
    // to back, or three workers at once (review pass 2: it waited for the whole backlog; 2b's polls let it lose a coin
    // toss for each slot, ten in a row one run in a few hundred; PR 2c-1's queue).
    for (const shape of [{ workers: 1, calls: 14, most: 3 }, { workers: 3, calls: 21, most: 3 }]) {
      const startsA: number[] = [];
      const backlog = Promise.all(Array.from({ length: shape.workers }, async () => {
        for (let i = 0; i < shape.calls / shape.workers; i++) await modelCall(call(), async () => { startsA.push(Date.now()); await Bun.sleep(150); });
      }));
      for (let i = 0; i < 100 && startsA.length === 0; i++) await Bun.sleep(10);
      const child = Bun.spawn(["bun", "-e", `
        const { installBackgroundSlots } = await import("./slots.ts");
        const { modelCall } = await import("./model-call.ts");
        installBackgroundSlots({ url: process.env.DATABASE_URL, raw: "chat=1" });
        console.log(Date.now());
        await modelCall({ type: "chat", model: ${JSON.stringify(META_MODEL)}, base: ${JSON.stringify(PROVIDER)}, purpose: "test" }, async () => console.log(Date.now()));
        process.exit(0);`], { cwd: import.meta.dir, env: { ...process.env, DATABASE_URL: URL_ }, stdout: "pipe", stderr: "pipe" });
      const [askedAt, childAt] = (await new Response(child.stdout).text()).trim().split("\n").map(Number);
      await child.exited;
      await backlog;
      // The call this process has at the queue's head as the other asks, and one or two more where the other's ask is
      // printed before its connection opens and it reaches the queue (a loaded runner's connect taking a call's time).
      const passedBy = startsA.filter((t) => t > askedAt && t < childAt).length;
      assert(childAt > askedAt && askedAt > 0 && passedBy <= shape.most,
        `a call in another process gets the next slot but one this one's ${shape.workers === 1 ? "back-to-back calls" : "three workers"} let go once it asks, in the queue behind the one call this process has in it: ${passedBy} of ${startsA.length} started between its ask and its run`);
    }
    // Two processes with backlogs on one share go through it, not deferring to each other's marks in turn: two of them,
    // two workers and 150 calls of 1 ms each at chat=2 (review pass 8: 80 calls in 30 s, each a poll sat out).
    {
      const child = () => Bun.spawn(["bun", "-e", `
        const { installBackgroundSlots } = await import("./slots.ts");
        const { modelCall } = await import("./model-call.ts");
        installBackgroundSlots({ url: process.env.DATABASE_URL, raw: "chat=2" });
        const t0 = Date.now();
        let done = 0;
        await Promise.all([0, 1].map(async () => {
          for (let i = 0; i < 150 && Date.now() - t0 < 10_000; i++) {
            await modelCall({ type: "chat", model: ${JSON.stringify(META_MODEL)}, base: ${JSON.stringify(PROVIDER)}, purpose: "test" }, () => Bun.sleep(1));
            done++;
          }
        }));
        console.log(JSON.stringify({ done, ms: Date.now() - t0 }));
        process.exit(0);`], { cwd: import.meta.dir, env: { ...process.env, DATABASE_URL: URL_ }, stdout: "pipe", stderr: "pipe" });
      const both = [child(), child()];
      const results = await Promise.all(both.map(async (c) => { const out = await new Response(c.stdout).text(); await c.exited; try { return JSON.parse(out.trim()) as { done: number; ms: number }; } catch { return { done: -1, ms: -1 }; } }));
      assert(results.every((r) => r.done === 300 && r.ms < 8000),
        `two processes with backlogs on one share both go through it, neither deferring to the other in turn (${JSON.stringify(results)})`);
    }
    // …and at chat=1, 20 ms calls, the slot is kept busy and shared between them: each slot let go goes to the queue's
    // head at once, told on the channel where it is the other process's (PR 2c-1: 2b's polls made 126 calls in 6 s
    // where 300 fit, the slot idle more than half the time; untold, a slot goes at the head's next try, a second on).
    {
      const child = () => Bun.spawn(["bun", "-e", `
        const { installBackgroundSlots } = await import("./slots.ts");
        const { modelCall } = await import("./model-call.ts");
        installBackgroundSlots({ url: process.env.DATABASE_URL, raw: "chat=1" });
        const t0 = Date.now();
        let done = 0;
        await Promise.all([0, 1].map(async () => {
          while (Date.now() - t0 < 3000) {
            await modelCall({ type: "chat", model: ${JSON.stringify(META_MODEL)}, base: ${JSON.stringify(PROVIDER)}, purpose: "test" }, () => Bun.sleep(20));
            done++;
          }
        }));
        console.log(JSON.stringify({ done }));
        process.exit(0);`], { cwd: import.meta.dir, env: { ...process.env, DATABASE_URL: URL_ }, stdout: "pipe", stderr: "pipe" });
      const both = [child(), child()];
      const results = await Promise.all(both.map(async (c) => { const out = await new Response(c.stdout).text(); await c.exited; try { return JSON.parse(out.trim()) as { done: number }; } catch { return { done: -1 }; } }));
      const total = results[0].done + results[1].done;
      assert(total >= 90 && results.every((r) => r.done >= total * 0.35),
        `two processes with backlogs of 20 ms calls at chat=1 keep the slot busy between them, each slot let go handed to the queue's head at once: ${total} calls in 3 s where 150 fit, ${JSON.stringify(results)}`);
    }
    // No other process waiting, a slot this process lets go goes to its own waiter at once, not at its next poll:
    // ten 10 ms calls two at a time run in about their own time (review pass 6: a poll a handoff, 36 s for 424
    // embeddings against 0.6).
    {
      const tw = Date.now();
      await Promise.all(Array.from({ length: 2 }, async () => { for (let i = 0; i < 5; i++) await modelCall(call(), () => Bun.sleep(10)); }));
      const wokeMs = Date.now() - tw;
      assert(wokeMs < 1500, `ten 10 ms calls two at a time under chat=1, no other process waiting, run in ${wokeMs} ms — each slot let go handed to this process's waiter at once`);
      // …and 1 ms calls, a slot let go between a waiter's try and its nap tried again at once, not lost to a poll's
      // nap (review pass 7: 424 such calls took 13 s against 0.6 off). A lost wake is a handoff of a nap, 250 ms at
      // least: counted, one allowed for a loaded runner. Without the count of slots let go, 28 over 200 ms in 800.
      const starts: number[] = [], ends: number[] = [];
      const tq = Date.now();
      await Promise.all(Array.from({ length: 2 }, async () => {
        // Cut at 10 s, so wakes lost on every handoff fail the row rather than run it for minutes.
        for (let i = 0; i < 400 && Date.now() - tq < 10_000; i++) await modelCall(call(), async () => { starts.push(Date.now()); await Bun.sleep(1); ends.push(Date.now()); });
      }));
      const quickMs = Date.now() - tq;
      starts.sort((a, b) => a - b);
      ends.sort((a, b) => a - b);
      const slow = starts.slice(1).filter((s, k) => s - ends[k] > 200).length;
      assert(slow <= 1 && starts.length === 800, `eight hundred 1 ms calls two at a time run in ${quickMs} ms, ${slow} handoff(s) over 200 ms — no wake lost between a waiter's try and its nap`);
    }
    // Another process's call at the head of the share's queue — here a session holding its QUEUE lock — and a call of
    // this one waits in the queue behind it, a slot free or not, until it lets the queue go (PR 2c-1: 2b's calls took a
    // free slot whoever had waited longer).
    {
      const ahead = new SQL({ url: URL_, max: 1 });
      const looker = new SQL({ url: URL_, max: 1 });
      try {
        await ahead`SELECT pg_advisory_lock(hashtext(${key}), -2)`;
        let ranAt = 0;
        const behind = modelCall(call(), async () => { ranAt = Date.now(); });
        await Bun.sleep(300);
        const asking = await queueLocks(looker, false);
        const ranBefore = ranAt;
        const letGo = Date.now();
        await ahead`SELECT pg_advisory_unlock(hashtext(${key}), -2)`;
        await behind;
        assert(ranBefore === 0 && asking === 1 && ranAt - letGo < 150,
          `a call behind another process's at the head of the share's queue waits in it, its slot free, asking for the queue (${asking}), and runs ${ranAt - letGo} ms after the queue is let go`);
      } finally {
        await ahead.close();
        await looker.close();
      }
    }
    // …a wait in the queue as long as the calls ahead of it: a role's lock_timeout and statement_timeout, here 100 ms,
    // do not end it, the semaphore's sessions setting both to none (PR 2c-1: ended, the call would fail open and run);
    // nor does its idle_session_timeout end the slot's session, idle while its call runs (review pass 1: the lock
    // went with it, three calls running at chat=1).
    {
      const admin = new SQL({ url: URL_, max: 1 });
      const ahead = new SQL({ url: URL_, max: 1 });
      const timed = installBackgroundSlots({ url: URL_!, raw: "chat=1", log: () => {} });
      const timedSaid: string[] = [];
      try {
        const [{ role }] = (await admin`SELECT current_user AS role`) as { role: string }[];
        // Connected before the role's timeouts are set, so they hold its own session to none of them.
        await ahead`SELECT 1`;
        await admin.unsafe(`ALTER ROLE "${role}" SET lock_timeout = '100ms'`);
        await admin.unsafe(`ALTER ROLE "${role}" SET statement_timeout = '100ms'`);
        await admin.unsafe(`ALTER ROLE "${role}" SET idle_session_timeout = '100ms'`);
        await ahead`SELECT pg_advisory_lock(hashtext(${key}), -2)`;
        let ranAt = 0;
        let heldMidCall: boolean | null = null;
        const behind = modelCall(call(), async () => {
          ranAt = Date.now();
          await Bun.sleep(300);
          // The slot still held 300 ms into the call: another session cannot take it.
          [{ got: heldMidCall }] = (await ahead`SELECT NOT pg_try_advisory_lock(hashtext(${key}), 0) AS got`) as { got: boolean }[];
        }).catch((e: unknown) => { timedSaid.push((e as Error).message); });
        await Bun.sleep(400);
        const ranBefore = ranAt;
        await ahead`SELECT pg_advisory_unlock(hashtext(${key}), -2)`;
        await behind;
        await ahead`SELECT pg_advisory_unlock_all()`;
        assert(ranBefore === 0 && ranAt > 0 && timedSaid.length === 0 && heldMidCall === true,
          `a role's lock_timeout and statement_timeout of 100 ms do not end a wait of 400 ms in the share's queue: the call ran once the queue was let go, not before (${ranBefore ? "ran early" : "waited"}); its idle_session_timeout of 100 ms leaves the slot held 300 ms into the call (${heldMidCall})`);
      } finally {
        const [{ role }] = (await admin`SELECT current_user AS role`) as { role: string }[];
        await admin.unsafe(`ALTER ROLE "${role}" RESET lock_timeout`);
        await admin.unsafe(`ALTER ROLE "${role}" RESET statement_timeout`);
        await admin.unsafe(`ALTER ROLE "${role}" RESET idle_session_timeout`);
        await timed.uninstall();
        await admin.close();
        await ahead.close();
      }
    }
    // A process killed while its call waits in the queue leaves it within a second or two, not when the queue reaches
    // it: its sessions check for their client every second (client_connection_check_interval, PR 2c-1).
    {
      const ahead = new SQL({ url: URL_, max: 1 });
      const looker = new SQL({ url: URL_, max: 1 });
      try {
        await ahead`SELECT pg_advisory_lock(hashtext(${key}), -2)`;
        const child = Bun.spawn(["bun", "-e", `
          const { installBackgroundSlots } = await import("./slots.ts");
          const { modelCall } = await import("./model-call.ts");
          installBackgroundSlots({ url: process.env.DATABASE_URL, raw: "chat=1" });
          await modelCall({ type: "chat", model: ${JSON.stringify(META_MODEL)}, base: ${JSON.stringify(PROVIDER)}, purpose: "test" }, async () => {});`],
          { cwd: import.meta.dir, env: { ...process.env, DATABASE_URL: URL_ }, stdout: "pipe", stderr: "pipe" });
        let asking = 0;
        for (let i = 0; i < 150 && asking === 0; i++) { await Bun.sleep(20); asking = await queueLocks(looker, false); }
        child.kill("SIGKILL");
        await child.exited;
        const t0 = Date.now();
        let left = asking;
        for (let i = 0; i < 200 && left > 0; i++) { await Bun.sleep(20); left = await queueLocks(looker, false); }
        assert(asking === 1 && left === 0 && Date.now() - t0 < 2500,
          `a process killed while its call waits in the share's queue leaves it on the server ${Date.now() - t0} ms on (${asking} asking, then ${left})`);
      } finally {
        await ahead.close();
        await looker.close();
      }
    }
    // Another process's call at the head of the queue — a session holding the QUEUE lock and hearing the channel — is
    // told of a slot this process lets go, on the channel with the share's key, at once: not left to find it at its next
    // try (PR 2c-1). Nothing is told where no one is at the head.
    {
      const ahead = new SQL({ url: URL_, max: 1 });
      const heard: { key: string; at: number }[] = [];
      const sub = await ahead.listen(SLOTS_CHANNEL, (k) => heard.push({ key: k, at: Date.now() }));
      try {
        let endedAt = 0;
        const holder = modelCall(call(), async () => { await Bun.sleep(400); endedAt = Date.now(); });
        await Bun.sleep(100);
        await ahead`SELECT pg_advisory_lock(hashtext(${key}), -2)`;
        await holder;
        await Bun.sleep(200);
        await ahead`SELECT pg_advisory_unlock(hashtext(${key}), -2)`;
        const toldAhead = heard.slice();
        await modelCall(call(), () => Bun.sleep(50));
        await Bun.sleep(200);
        assert(toldAhead.length === 1 && toldAhead[0].key === key && toldAhead[0].at - endedAt < 150 && heard.length === 1,
          `a slot let go while another process's call heads the share's queue is told to it on ${SLOTS_CHANNEL}, ${toldAhead.length ? toldAhead[0].at - endedAt : -1} ms after the call ended, the share's key the payload; one let go with no one at the head is told to no one (${heard.length} told)`);
      } finally {
        await sub.unlisten();
        await ahead.close();
      }
    }
    // A subscription whose connection drops while a call heads the queue — a restart, here its backend terminated — is
    // re-subscribed by Bun, and the head tries its slots again then: a slot let go meanwhile was told to no one (PR
    // 2c-1). Here it is let go untold, as the subscription drops, so only the re-subscription's try finds it before the
    // head's own, a second or two on.
    {
      const holds = new SQL({ url: URL_, max: 1 });
      const admin = new SQL({ url: URL_, max: 1 });
      try {
        await holds`SELECT pg_advisory_lock(hashtext(${key}), 0)`;
        let ranAt = 0;
        const waiting = modelCall(call(), async () => { ranAt = Date.now(); });
        const listeners = async () => (await admin`SELECT pid FROM pg_stat_activity WHERE application_name = ${SLOTS_APP} AND query ILIKE 'LISTEN%'`) as { pid: number }[];
        let subs: { pid: number }[] = [];
        for (let i = 0; i < 100 && subs.length === 0; i++) { await Bun.sleep(10); subs = await listeners(); }
        await admin`SELECT pg_terminate_backend(${subs[0]?.pid ?? 0})`;
        const letGo = Date.now();
        await holds`SELECT pg_advisory_unlock(hashtext(${key}), 0)`;
        await waiting;
        assert(subs.length === 1 && ranAt - letGo < 700,
          `a subscription dropped while a call heads the queue is re-subscribed, and the head tries again then: the slot let go untold meanwhile taken ${ranAt - letGo} ms on`);
      } finally {
        await holds.close();
        await admin.close();
      }
    }
    // Processes counting a share's slots differently queue apart: a call of a chat=3 process does not wait behind a
    // chat=1 process's head, whose queue it is not, for the slot free to it (review pass 1: a chat=3 process made 13
    // calls in 5 s behind a chat=1 one with long calls, 677 alone).
    {
      const narrowHead = new SQL({ url: URL_, max: 1 });
      const wide = installBackgroundSlots({ url: URL_!, raw: "chat=3", log: () => {} });
      try {
        // A chat=1 head: its queue (-2) held, its slot 0 taken, napping.
        await narrowHead`SELECT pg_advisory_lock(hashtext(${key}), -2), pg_advisory_lock(hashtext(${key}), 0)`;
        const t0 = Date.now();
        let ranMs = -1;
        const cut = setTimeout(() => { narrowHead`SELECT pg_advisory_unlock_all()`.then(() => {}, () => {}); }, 2000);
        await modelCall(call(), async () => { ranMs = Date.now() - t0; });
        clearTimeout(cut);
        assert(ranMs >= 0 && ranMs < 300, `a chat=3 process's call takes a slot free to it at once, ${ranMs} ms, not waiting behind a chat=1 process's head`);
      } finally {
        await wide.uninstall();
        await narrowHead.close();
      }
    }
    // A subscription that fails to open — a role at its connection limit, the head's own session its one connection — is
    // said once and asked again while the call waits, so the head hears the channel once the database lets it (review
    // pass 1: kept, a failed one left the head deaf for as long as calls waited, every process behind it waiting its
    // tries out).
    {
      const admin = new SQL({ url: URL_, max: 1 });
      const holder = new SQL({ url: URL_, max: 1 });
      const role = "ob1_slots_limited";
      const limitedUrl = new URL(URL_!);
      limitedUrl.username = role;
      limitedUrl.password = "limited";
      const limSaid: string[] = [];
      let lim: { uninstall: () => Promise<void> } | undefined;
      try {
        await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
        await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'limited' CONNECTION LIMIT 1`);
        lim = installBackgroundSlots({ url: limitedUrl.toString(), raw: "chat=1", log: (l) => limSaid.push(l) });
        const listens = async () => Number((await admin`SELECT count(*)::int AS c FROM pg_stat_activity WHERE usename = ${role} AND query ILIKE 'LISTEN%'`)[0].c);
        const handoffs: number[] = [];
        let heardAfter = 0;
        for (let i = 0; i < 3; i++) {
          await holder`SELECT pg_advisory_lock(hashtext(${key}), 0)`;
          let ranAt = 0;
          const waiting = modelCall(call(), async () => { ranAt = Date.now(); });
          if (i === 0) {
            // Refused at the head's first wait, then the limit lifted: asked again within LISTEN_RETRY_MS and a try.
            await Bun.sleep(300);
            await admin.unsafe(`ALTER ROLE ${role} CONNECTION LIMIT -1`);
            for (let k = 0; k < 60 && heardAfter === 0; k++) { await Bun.sleep(100); heardAfter = await listens(); }
          }
          await Bun.sleep(300);
          // Let go as another process of PR 2c-1's does: the unlock, then the channel told.
          const letGo = Date.now();
          await holder`SELECT pg_advisory_unlock(hashtext(${key}), 0), pg_notify(${SLOTS_CHANNEL}, ${key})`;
          await waiting;
          handoffs.push(ranAt - letGo);
        }
        assert(limSaid.filter((l) => /channel could not be heard/.test(l)).length === 1 && heardAfter === 1 && handoffs.every((h) => h >= 0 && h < 300),
          `a subscription refused at a role's connection limit is said once and asked again while the call waits: heard once the limit is lifted (${heardAfter}), each slot then told taken at once (${JSON.stringify(handoffs)} ms; ${JSON.stringify(limSaid.map((l) => l.slice(0, 70)))})`);
      } finally {
        await lim?.uninstall();
        await holder.close();
        // Its connections gone before the role is dropped.
        for (let k = 0; k < 50; k++) {
          if (Number((await admin`SELECT count(*)::int AS c FROM pg_stat_activity WHERE usename = ${role}`)[0].c) === 0) break;
          await Bun.sleep(50);
        }
        await admin.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
        await admin.close();
      }
    }
    // A process that waited, its subscription to the channel live, still ends on its own once its work is done: the
    // subscription closes 2 s after its last wait, as a CLI never uninstalls the hook (PR 2c-1: a live one holds a
    // process open).
    {
      const holds = new SQL({ url: URL_, max: 1 });
      try {
        await holds`SELECT pg_advisory_lock(hashtext(${key}), 0)`;
        const t0 = Date.now();
        const child = Bun.spawn(["bun", "-e", `
          const { installBackgroundSlots } = await import("./slots.ts");
          const { modelCall } = await import("./model-call.ts");
          installBackgroundSlots({ url: process.env.DATABASE_URL, raw: "chat=1" });
          await modelCall({ type: "chat", model: ${JSON.stringify(META_MODEL)}, base: ${JSON.stringify(PROVIDER)}, purpose: "test" }, async () => console.log(Date.now()));`],
          { cwd: import.meta.dir, env: { ...process.env, DATABASE_URL: URL_ }, stdout: "pipe", stderr: "pipe" });
        setTimeout(() => { holds`SELECT pg_advisory_unlock(hashtext(${key}), 0)`.then(() => {}, () => {}); }, 300);
        // Cut at 10 s, so a process held open fails the row rather than hanging the suite.
        const cut = setTimeout(() => child.kill(), 10_000);
        const ranAt = Number((await new Response(child.stdout).text()).trim());
        const code = await child.exited;
        clearTimeout(cut);
        const exitMs = Date.now() - t0;
        assert(ranAt > 0 && code === 0 && exitMs < 7000,
          `a process whose call waited, its subscription to the channel live, ends on its own ${exitMs} ms after it began, ${ranAt ? Date.now() - ranAt : -1} ms after its call ran (exit ${code})`);
      } finally {
        await holds.close();
      }
    }
    // The call's observer is told of a wait only where the hook waits: a call whose slot is free tells it nothing, one
    // queued behind another tells it once (review pass 6: told before every hook, a stopping pass gave back calls
    // that never waited).
    {
      const told = { waiting: 0, running: 0 };
      const observer = { waiting: () => { told.waiting++; }, running: () => { told.running++; } };
      await withCallWaits(observer, () => modelCall(call(), async () => undefined));
      const free = { ...told };
      // Queued: a holder, a waiter, and two calls behind it — one queued with the waiter, before it finds no slot free,
      // told when it does; one after, told as it queues — both while the holder still holds.
      const holder = modelCall(call(), () => Bun.sleep(300));
      await Bun.sleep(30);
      const waiter = modelCall(call(), async () => undefined);
      const early = withCallWaits(observer, () => modelCall(call(), async () => undefined));
      await Bun.sleep(30);
      const behind = withCallWaits(observer, () => modelCall(call(), async () => undefined));
      await Bun.sleep(30);
      const toldWhileQueued = told.waiting;
      await Promise.all([holder, waiter, early, behind]);
      const queued = { ...told };
      // …and one whose slot another process holds, told once too.
      const elsewhere = new SQL({ url: URL_, max: 1 });
      try {
        await elsewhere`SELECT pg_try_advisory_lock(hashtext(${key}), 0)`;
        setTimeout(() => { elsewhere`SELECT pg_advisory_unlock(hashtext(${key}), 0)`.then(() => {}, () => {}); }, 300);
        await withCallWaits(observer, () => modelCall(call(), async () => undefined));
      } finally {
        await elsewhere.close();
      }
      assert(free.waiting === 0 && free.running === 0 && toldWhileQueued === 2 && queued.waiting === 2 && queued.running === 2 && told.waiting === 3 && told.running === 3,
        `a call whose slot is free tells its observer nothing (${JSON.stringify(free)}); two queued behind this process's waiter, before and after it finds no slot free, tell it while queued (${toldWhileQueued}) and once each way (${JSON.stringify(queued)}), and one whose slot another process holds (${JSON.stringify(told)})`);
    }
    // Another process holding the share's one slot: the call waits until it lets go.
    const other = new SQL({ url: URL_, max: 1 });
    try {
      const [{ got }] = (await other`SELECT pg_try_advisory_lock(hashtext(${key}), 0) AS got`) as { got: boolean }[];
      const t1 = Date.now();
      // A tagged query runs only once awaited or then'd: so then'd here.
      setTimeout(() => { other`SELECT pg_advisory_unlock(hashtext(${key}), 0)`.then(() => {}, () => {}); }, 600);
      await modelCall(call(), async () => undefined);
      const waitedForOther = Date.now() - t1;
      assert(got && waitedForOther >= 550, `a slot another process holds is waited for: the call ran ${waitedForOther} ms later, once it let go`);
    } finally {
      await other.close();
    }
    // A call's stop ends its wait, rejecting with the stop's reason, the slot not taken: queued behind this process's
    // own call, and contending for a slot another process holds — a stop, not the database not answering.
    const holder = modelCall(call(), work(600));
    for (let i = 0; i < 100 && inFlight === 0; i++) await Bun.sleep(20);
    const stopper = new AbortController();
    setTimeout(() => stopper.abort(new Error("the pass stopped")), 100);
    const stopped = await modelCall({ ...call(), signal: stopper.signal }, async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
    await holder;
    const otherHolds = new SQL({ url: URL_, max: 1 });
    let contended = "";
    try {
      await otherHolds`SELECT pg_try_advisory_lock(hashtext(${key}), 0)`;
      const stopper2 = new AbortController();
      setTimeout(() => stopper2.abort(new Error("the pass stopped")), 400);
      // Let go later, so a wait the stop did not end runs the call rather than hanging the suite.
      setTimeout(() => { otherHolds`SELECT pg_advisory_unlock_all()`.then(() => {}, () => {}); }, 1500);
      contended = await modelCall({ ...call(), signal: stopper2.signal }, async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
    } finally {
      await otherHolds.close();
    }
    assert(stopped === "rejected: the pass stopped" && contended === "rejected: the pass stopped" && said.length === 0,
      `a call's stop ends its wait for a slot, rejecting with its reason, nothing said: queued behind this process's call (${stopped}) and contending with another process's (${contended})`);
    // A call stopped while it waits in the share's queue leaves it on the server too, cancelled there: Bun's own cancel
    // leaves the server waiting, and the queue would pass through the stopped call's backend (PR 2c-1).
    {
      const ahead = new SQL({ url: URL_, max: 1 });
      const looker = new SQL({ url: URL_, max: 1 });
      try {
        await ahead`SELECT pg_advisory_lock(hashtext(${key}), -2)`;
        const stopper = new AbortController();
        const queued = modelCall({ ...call(), signal: stopper.signal }, async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
        let asking = 0;
        for (let i = 0; i < 50 && asking === 0; i++) { await Bun.sleep(20); asking = await queueLocks(looker, false); }
        const t0 = Date.now();
        stopper.abort(new Error("the pass stopped"));
        const ended = await queued;
        const endMs = Date.now() - t0;
        let left = asking;
        for (let i = 0; i < 50 && left > 0; i++) { await Bun.sleep(20); left = await queueLocks(looker, false); }
        assert(asking === 1 && ended === "rejected: the pass stopped" && endMs < 100 && left === 0,
          `a call stopped in the share's queue ends at once (${ended}, ${endMs} ms) and leaves the queue on the server too (${asking} asking, then ${left})`);
      } finally {
        await ahead.close();
        await looker.close();
      }
    }
  } finally {
    await on.uninstall();
  }
  // Calls fanned out with every slot free tell their observers of no wait — not for queueing behind the waiter's own
  // statements — so a stopping pass gives none of them back (review pass 7: seven of eight told, seven answered
  // blurbs thrown away at a stop).
  {
    // The row before's stopped waiter lets the queue go with its session, a moment after: waited out first.
    const looker = new SQL({ url: URL_, max: 1 });
    try {
      for (let i = 0; i < 50; i++) {
        if ((await queueLocks(looker)) + (await queueLocks(looker, false)) === 0) break;
        await Bun.sleep(20);
      }
    } finally {
      await looker.close();
    }
    const wide = installBackgroundSlots({ url: URL_!, raw: "chat=8", log: () => {} });
    try {
      let toldFan = 0;
      const observer = { waiting: () => { toldFan++; }, running: () => {} };
      await Promise.all(Array.from({ length: 8 }, () => withCallWaits(observer, () => modelCall(call(), () => Bun.sleep(50)))));
      assert(toldFan === 0, `eight calls fanned out under chat=8, every slot free, tell their observers of no wait (${toldFan} told)`);
    } finally {
      await wide.uninstall();
    }
  }
  // A stop telling the queue behind another caller's waiter aborts each queued call — every one, though each it stops
  // leaves the queue as the telling goes (review pass 8: every other skipped, one running its call through the stop).
  {
    const narrow = installBackgroundSlots({ url: URL_!, raw: "chat=1", log: () => {} });
    const holder = new SQL({ url: URL_, max: 1 });
    try {
      await holder`SELECT pg_try_advisory_lock(hashtext(${key}), 0)`;
      // Let go at 3 s, so a call the stop missed runs, and says so, rather than hanging the row.
      setTimeout(() => { holder`SELECT pg_advisory_unlock_all()`.then(() => {}, () => {}); }, 3000);
      // Queued in the waiter's tick, before it finds no slot free, so its telling goes through the queue.
      const t0 = Date.now();
      const waiterCall = modelCall(call(), async () => "waiter");
      const queued = Array.from({ length: 4 }, (_, i) => {
        const stop = new AbortController();
        const observer = { waiting: () => stop.abort(new Error(`stopped ${i}`)), running: () => {} };
        return withCallWaits(observer, () => modelCall({ ...call(), signal: stop.signal }, async () => `ran ${i}`))
          .then((r) => r, (e: unknown) => `${(e as Error).message} at ${Date.now() - t0}`);
      });
      const ended = await Promise.all(queued);
      await waiterCall;
      assert(ended.every((r, i) => r.startsWith(`stopped ${i} at`) && Number(r.split(" at ")[1]) < 1500),
        `a stop telling the queue behind another caller's waiter stops all four queued calls at once (${JSON.stringify(ended)})`);
    } finally {
      await narrow.uninstall();
      await holder.close();
    }
  }
  // The process's stop ends a wait for a caller that hands none: the install's `stop`, and `uninstall`, which leaves a
  // call already running its slot until it ends.
  for (const how of ["stop", "uninstall"] as const) {
    const procStop = new AbortController();
    const saidHere: string[] = [];
    const inst = installBackgroundSlots({ url: URL_!, raw: "chat=1", stop: procStop.signal, log: (l) => saidHere.push(l) });
    const other = new SQL({ url: URL_, max: 1 });
    try {
      let firstRunning = false;
      const first = modelCall(call(), () => { firstRunning = true; return Bun.sleep(600).then(() => "first"); });
      for (let i = 0; i < 100 && !firstRunning; i++) await Bun.sleep(20);
      setTimeout(() => { if (how === "stop") procStop.abort(new Error("the process is stopping")); else void inst.uninstall(); }, 100);
      const second = await modelCall(call(), async () => "second").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      const [{ got: duringHeld }] = (await other`SELECT pg_try_advisory_lock(hashtext(${key}), 0) AS got`) as { got: boolean }[];
      const firstDone = await first;
      assert(/rejected: .*the process is stopping/.test(second) && !duringHeld && firstDone === "first" && !saidHere.some((l) => /did not answer/.test(l)),
        `the process's ${how} ends a wait, rejecting as a stop, not an outage, while the running call keeps its slot to its end (${second}; slot free while held ${duringHeld})`);
    } finally {
      await inst.uninstall();
      await other.close();
    }
  }
  // A slot's connection was lost while its call ran — a Postgres restart, here its backend terminated: said as lost,
  // not as a pooler, and the unlock not waiting on a reconnect.
  {
    const lostSaid: string[] = [];
    const inst = installBackgroundSlots({ url: URL_!, raw: "chat=1", log: (l) => lostSaid.push(l) });
    const admin = new SQL({ url: URL_, max: 1 });
    try {
      let endedAt = 0;
      const t0 = Date.now();
      const got = await modelCall(call(), async () => {
        await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${SLOTS_APP}`;
        await Bun.sleep(200);
        endedAt = Date.now();
        return "answer";
      });
      const releaseMs = Date.now() - endedAt;
      const after = await modelCall(call(), async () => "next");
      assert(got === "answer" && after === "next" && lostSaid.some((l) => /connection was lost while its call ran/.test(l)) && !lostSaid.some((l) => /pooler/.test(l)) && releaseMs < 1000,
        `a slot whose connection was lost while its call ran is said as lost, not as a pooler; the call's answer kept, its release ${releaseMs} ms, the next call slotted (${JSON.stringify(lostSaid.map((l) => l.slice(0, 80)))}, ${Date.now() - t0} ms in all)`);
    } finally {
      await inst.uninstall();
      await admin.close();
    }
  }
  // A waiter's connection that closes while it heads the share's queue, before any slot — a Postgres restart, here its
  // backend terminated as it naps: Bun reconnects quietly, the call takes the queue again on the new session at once, not
  // at its next try, and the slot it then takes is no lost one (review pass 3: said lost at the unlock; PR 2c-1: the
  // queue, not 2b's mark; its review pass 1: the head slept its nap out).
  {
    const reSaid: string[] = [];
    const inst = installBackgroundSlots({ url: URL_!, raw: "chat=1", log: (l) => reSaid.push(l) });
    const other = new SQL({ url: URL_, max: 1 });
    const admin = new SQL({ url: URL_, max: 1 });
    // The queue held by a backend other than `not`, so the terminated one's lock is left out.
    const marks = async (not = 0) => Number((await admin`SELECT count(*)::int AS c FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND objid = 4294967294 AND granted AND pid <> ${not}`)[0].c);
    try {
      await other`SELECT pg_try_advisory_lock(hashtext(${key}), 0)`;
      const waiting = modelCall(call(), async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      let before = 0;
      for (let i = 0; i < 50 && before === 0; i++) { await Bun.sleep(50); before = await marks(); }
      // Napping once subscribed: its subscription's backend there, a round of tries after it, then the nap of a second
      // or two.
      let subscribed = 0;
      for (let i = 0; i < 100 && subscribed === 0; i++) { await Bun.sleep(10); subscribed = Number((await admin`SELECT count(*)::int AS c FROM pg_stat_activity WHERE application_name = ${SLOTS_APP} AND query ILIKE 'LISTEN%'`)[0].c); }
      await Bun.sleep(50);
      // The waiter's backend: the one holding the queue, not the channel's.
      const [row] = (await admin`SELECT pid AS old FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2 AND objid = 4294967294 AND granted`) as { old: number }[];
      const old = row?.old ?? 0;
      await admin`SELECT pg_terminate_backend(${old})`;
      const cutAt = Date.now();
      let after = 0;
      for (let i = 0; i < 200 && after === 0; i++) { await Bun.sleep(10); after = await marks(old); }
      const againMs = Date.now() - cutAt;
      await other`SELECT pg_advisory_unlock(hashtext(${key}), 0)`;
      const ran = await waiting;
      assert(before === 1 && subscribed === 1 && after === 1 && againMs < 600 && ran === "ran" && !reSaid.some((l) => /was lost/.test(l)),
        `a waiter whose connection closes while it heads the queue, napping, takes it again on the new session ${againMs} ms on (${before}, then ${after}), and the slot it takes is not said lost (${ran}; ${JSON.stringify(reSaid.map((l) => l.slice(0, 80)))})`);
    } finally {
      await inst.uninstall();
      await other.close();
      await admin.close();
    }
  }
  /**
   * A proxy in front of the test Postgres: `pass`; `stall`, every byte dropped, as a paused container or a frozen host
   * does; `close`, the next connection to send a byte closed, as a Postgres restart ends a session mid-statement;
   * `closeSecond`, each connection closed at its first write after the server's third ReadyForQuery — the session up,
   * and its first statement answered whether Bun sends it in one sync or two — so every session answers once and then
   * ends; `deafListen`, a connection that has sent a LISTEN hears nothing more from the server for good, as a path
   * swallowing what it is sent does, while it stays open. `opened` counts the connections made through it.
   */
  const pgProxy = () => {
    const pg = new URL(URL_!);
    type Pipe = { up?: { write(d: Uint8Array): number; end(): void }; buf: Uint8Array[]; ready: number; listen?: boolean; deaf?: boolean };
    const state = { mode: "pass" as "pass" | "stall" | "close" | "closeSecond" | "deafListen", opened: 0 };
    // ReadyForQuery messages in a chunk from the server: 'Z', length 5.
    const readies = (d: Uint8Array) => { let n = 0; for (let i = 0; i + 4 < d.length; i++) if (d[i] === 0x5a && d[i + 1] === 0 && d[i + 2] === 0 && d[i + 3] === 0 && d[i + 4] === 5) n++; return n; };
    const listener = Bun.listen<Pipe>({ hostname: "127.0.0.1", port: 0, socket: {
      open(c) {
        state.opened++;
        c.data = { buf: [], ready: 0 };
        Bun.connect({ hostname: pg.hostname, port: Number(pg.port), socket: { data(_, d) {
          if (state.mode === "stall") return;
          if (state.mode === "deafListen" && c.data.listen) c.data.deaf = true;
          if (c.data.deaf) return;
          c.data.ready += readies(d);
          c.write(d);
        }, close() { c.end(); }, error() { c.end(); } } })
          .then((up) => { c.data.up = up; for (const b of c.data.buf) up.write(b); c.data.buf = []; }, () => c.end());
      },
      data(c, d) {
        if (!c.data.listen && Buffer.from(d).includes("LISTEN ")) c.data.listen = true;
        if (state.mode === "stall") return;
        if (state.mode === "close") { state.mode = "pass"; c.end(); return; }
        if (state.mode === "closeSecond" && c.data.ready >= 3) { c.end(); return; }
        if (c.data.up) c.data.up.write(d); else c.data.buf.push(new Uint8Array(d));
      },
      close(c) { c.data.up?.end(); },
    } });
    const via = new URL(URL_!);
    via.hostname = "127.0.0.1";
    via.port = String(listener.port);
    return { url: via.toString(), stop: (closeActive?: boolean) => listener.stop(closeActive), get mode() { return state.mode; }, set mode(m) { state.mode = m; }, get opened() { return state.opened; } };
  };
  // A session the database ends mid-statement after it has answered — a restart, a terminate — is asked again on a
  // fresh one, not read as an outage: the queue behind it is not let through without slots (review pass 3: one
  // terminate ran a five-call backlog at once under chat=1).
  {
    const proxy = pgProxy();
    const closeSaid: string[] = [];
    const inst = installBackgroundSlots({ url: proxy.url, raw: "chat=1", log: (l) => closeSaid.push(l), connectS: 1 });
    const other = new SQL({ url: URL_, max: 1 });
    const admin = new SQL({ url: URL_, max: 1 });
    try {
      await other`SELECT pg_try_advisory_lock(hashtext(${key}), 0)`;
      let inFlight = 0, most = 0;
      const one = () => modelCall(call(), async () => { inFlight++; most = Math.max(most, inFlight); await Bun.sleep(100); inFlight--; return "ran"; })
        .then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      const calls = [one(), one(), one()];
      let marked = 0;
      for (let i = 0; i < 50 && marked === 0; i++) {
        await Bun.sleep(50);
        marked = await queueLocks(admin);
      }
      proxy.mode = "close";
      // Read through a function: the setter's value would otherwise narrow the reads after it.
      const modeNow = (): string => proxy.mode;
      // The head's next try, a second or two on, is the next byte sent.
      for (let i = 0; i < 200 && modeNow() === "close"; i++) await Bun.sleep(20);
      const closed = modeNow() === "pass";
      await Bun.sleep(700);
      await other`SELECT pg_advisory_unlock(hashtext(${key}), 0)`;
      const ran = await Promise.all(calls);
      assert(marked === 1 && closed && ran.every((r) => r === "ran") && most === 1 && !closeSaid.some((l) => /did not answer/.test(l)),
        `a waiter's session closed mid-statement is asked again on a fresh one: the three calls ran one at a time (${most} at most), nothing said down (${JSON.stringify(closeSaid.map((l) => l.slice(0, 80)))})`);
    } finally {
      await inst.uninstall();
      await other.close();
      await admin.close();
      proxy.stop(true);
    }
  }
  // A database that stops answering after the slot is taken — a proxy in front of Postgres dropping every byte, as a
  // paused container or a frozen host does: the unlock gives up at the bound, the call's answer kept, said as lost; the
  // next call fails open at the bound rather than waiting with no end (review pass 2: both waited past every stop).
  {
    const proxy = pgProxy();
    const stallSaid: string[] = [];
    const inst = installBackgroundSlots({ url: proxy.url, raw: "chat=1", log: (l) => stallSaid.push(l), connectS: 1 });
    // Cut at 6 s, so a wait with no bound fails the row rather than hanging the suite.
    const cut = setTimeout(() => proxy.stop(true), 6000);
    try {
      let endedAt = 0;
      const answer = await modelCall(call(), async () => { proxy.mode = "stall"; await Bun.sleep(100); endedAt = Date.now(); return "answer"; });
      const heldMs = Date.now() - endedAt;
      const t1 = Date.now();
      const next = await modelCall(call(), async () => "next").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      const nextMs = Date.now() - t1;
      assert(answer === "answer" && heldMs < 1800 && stallSaid.some((l) => /connection was lost while its call ran \(no answer in 1 s\)/.test(l)) && next === "next" && nextMs < 2500 && stallSaid.some((l) => /did not answer/.test(l)),
        `a database that stops answering while a slot is held: the unlock gives up at the bound (the answer back ${heldMs} ms after the call ended), said as lost; the next call fails open in ${nextMs} ms (${JSON.stringify(stallSaid.map((l) => l.slice(0, 90)))})`);
    } finally {
      clearTimeout(cut);
      await inst.uninstall();
      proxy.stop(true);
    }
  }
  // Calls back to back reuse the connection the one before let go, not one each (review pass 5: a fast re-embed took
  // twice as long, a backend started per call).
  {
    const proxy = pgProxy();
    const inst = installBackgroundSlots({ url: proxy.url, raw: "chat=1", log: () => {}, connectS: 1 });
    try {
      for (let i = 0; i < 5; i++) await modelCall(call(), async () => undefined);
      assert(proxy.opened === 1, `five background calls back to back open one connection between them (${proxy.opened})`);
    } finally {
      await inst.uninstall();
      proxy.stop(true);
    }
  }
  // A database that ends each session after it has answered once — a restart loop, an operator's terminates — is asked
  // again a poll later, not in a loop: the connections opened stay near one a poll (review pass 5: asked again at
  // once, with no cap).
  {
    const proxy = pgProxy();
    const loopSaid: string[] = [];
    const inst = installBackgroundSlots({ url: proxy.url, raw: "chat=1", log: (l) => loopSaid.push(l), connectS: 1 });
    const other = new SQL({ url: URL_, max: 1 });
    try {
      await other`SELECT pg_try_advisory_lock(hashtext(${key}), 0)`;
      proxy.mode = "closeSecond";
      const stopper = new AbortController();
      const waiting = modelCall({ ...call(), signal: stopper.signal }, async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      await Bun.sleep(1500);
      const opened = proxy.opened;
      stopper.abort(new Error("the case ended"));
      // A stop the call does not honour would loop for ever: 3 s on, the proxy passes and the slot is let go, so the
      // row fails instead of hanging the suite.
      const cut = setTimeout(() => { proxy.mode = "pass"; other`SELECT pg_advisory_unlock_all()`.then(() => {}, () => {}); }, 3000);
      const ended = await waiting;
      clearTimeout(cut);
      assert(ended === "rejected: the case ended" && opened >= 2 && opened <= 10 && !loopSaid.some((l) => /did not answer/.test(l)),
        `a database ending each session after it answers once is asked again a poll later, not in a loop: ${opened} connections in 1.5 s, the call waiting on, not failed open (${ended}; ${JSON.stringify(loopSaid.map((l) => l.slice(0, 70)))})`);
    } finally {
      await inst.uninstall();
      await other.close();
      proxy.stop(true);
    }
  }
  // A subscription that goes deaf while it stays open — what its server sends swallowed, which Bun never sees, as it
  // never sees a re-subscription it has given up after some 3 minutes — is found by the process's ping, sent at a nap no
  // release ended and not heard back by the next: dropped, said once, and subscribed again once the path passes, slots
  // then told at once (review pass 2: deaf for good, unsaid, every handoff a try's 1 to 2 s).
  {
    const proxy = pgProxy();
    const deafSaid: string[] = [];
    const inst = installBackgroundSlots({ url: proxy.url, raw: "chat=1", log: (l) => deafSaid.push(l), connectS: 1 });
    const holder = new SQL({ url: URL_, max: 1 });
    const admin = new SQL({ url: URL_, max: 1 });
    const listens = async () => Number((await admin`SELECT count(*)::int AS c FROM pg_stat_activity WHERE application_name = ${SLOTS_APP} AND query ILIKE 'LISTEN%'`)[0].c);
    // One handoff: the slot held elsewhere, a call waiting on it, then let go as a PR 2c-1 process does, told.
    const handoff = async (before: () => Promise<void>) => {
      await holder`SELECT pg_advisory_lock(hashtext(${key}), 0)`;
      let ranAt = 0;
      const waiting = modelCall(call(), async () => { ranAt = Date.now(); });
      await before();
      const letGo = Date.now();
      await holder`SELECT pg_advisory_unlock(hashtext(${key}), 0), pg_notify(${SLOTS_CHANNEL}, ${key})`;
      await waiting;
      return ranAt - letGo;
    };
    try {
      const first = await handoff(async () => { for (let k = 0; k < 100 && (await listens()) === 0; k++) await Bun.sleep(20); await Bun.sleep(100); });
      proxy.mode = "deafListen";
      const deaf = await handoff(async () => {
        // Found deaf at the second nap no release ends, a few seconds on; subscribed again once the path passes, within
        // a retry's 2 s and a try.
        for (let k = 0; k < 400 && !deafSaid.some((l) => /no longer heard/.test(l)); k++) await Bun.sleep(20);
        proxy.mode = "pass";
        await Bun.sleep(5000);
      });
      assert(first < 300 && deafSaid.filter((l) => /no longer heard/.test(l)).length === 1 && deaf < 300,
        `a subscription gone deaf while open is found by the process's ping, said once, and subscribed again: handoffs ${first} ms before, ${deaf} ms after (${JSON.stringify(deafSaid.map((l) => l.slice(0, 70)))})`);
    } finally {
      await inst.uninstall();
      await holder.close();
      await admin.close();
      proxy.stop(true);
    }
  }
  // A subscription closed on purpose while its first LISTEN is unanswered — here the process stopping — says nothing:
  // its failure is no channel unheard, and the one saying is kept for a real one (review pass 2).
  {
    const proxy = pgProxy();
    proxy.mode = "deafListen";
    const stopSaid: string[] = [];
    const inst = installBackgroundSlots({ url: proxy.url, raw: "chat=1", log: (l) => stopSaid.push(l), connectS: 1 });
    const holder = new SQL({ url: URL_, max: 1 });
    try {
      await holder`SELECT pg_advisory_lock(hashtext(${key}), 0)`;
      const waiting = modelCall(call(), async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      await Bun.sleep(300);
      await inst.uninstall();
      const ended = await waiting;
      // Past the subscription's 1 s bound, so a failure said late is seen.
      await Bun.sleep(1500);
      assert(/rejected: .*stopping/.test(ended) && !stopSaid.some((l) => /could not be heard/.test(l)),
        `a subscription closed as the process stops, its LISTEN unanswered, says nothing (${ended}; ${JSON.stringify(stopSaid.map((l) => l.slice(0, 70)))})`);
    } finally {
      await inst.uninstall();
      await holder.close();
      proxy.stop(true);
    }
  }
  // A database that stops answering a waiter that has answered fails it open at the bound, not asked again on a fresh
  // session: a statement unanswered is no session ended (review pass 3).
  {
    const proxy = pgProxy();
    const pollSaid: string[] = [];
    const inst = installBackgroundSlots({ url: proxy.url, raw: "chat=1", log: (l) => pollSaid.push(l), connectS: 1 });
    const other = new SQL({ url: URL_, max: 1 });
    const admin = new SQL({ url: URL_, max: 1 });
    const cut = setTimeout(() => proxy.stop(true), 8000);
    try {
      await other`SELECT pg_try_advisory_lock(hashtext(${key}), 0)`;
      const polling = modelCall(call(), async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      let marked = 0;
      for (let i = 0; i < 50 && marked === 0; i++) {
        await Bun.sleep(50);
        marked = await queueLocks(admin);
      }
      const openedBefore = proxy.opened;
      proxy.mode = "stall";
      const ran = await polling;
      assert(marked === 1 && ran === "ran" && proxy.opened === openedBefore && pollSaid.some((l) => /did not answer \(no answer in 1 s\)/.test(l)),
        `a waiter its database stops answering fails open at the bound, no fresh session tried (${proxy.opened - openedBefore} opened; ${ran}; ${JSON.stringify(pollSaid.map((l) => l.slice(0, 80)))})`);
    } finally {
      clearTimeout(cut);
      await inst.uninstall();
      await other.close();
      await admin.close();
      proxy.stop(true);
    }
  }
  // A stop while a call's connect hangs — a database that takes the connection and never answers — ends the
  // wait at once, as a stop; and a URL Bun refuses as it builds the client fails open rather than rejecting the call.
  {
    const stall = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {} } });
    const stallSaid: string[] = [];
    // One hook at a time: an install replaces the hook before it.
    const inst = installBackgroundSlots({ url: `postgres://postgres:x@127.0.0.1:${stall.port}/none`, raw: "chat=1", log: (l) => stallSaid.push(l), connectS: 5 });
    let stopped = "", stopMs = 0, built = "";
    try {
      const stopper = new AbortController();
      const t0 = Date.now();
      setTimeout(() => stopper.abort(new Error("the pass stopped")), 100);
      stopped = await modelCall({ ...call(), signal: stopper.signal }, async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
      stopMs = Date.now() - t0;
    } finally {
      await inst.uninstall();
      stall.stop(true);
    }
    const badUrl = installBackgroundSlots({ url: "postgres://postgres:x@127.0.0.1:99999/none", raw: "chat=1", log: () => {} });
    try {
      built = await modelCall(call(), async () => "ran").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
    } finally {
      await badUrl.uninstall();
    }
    assert(stopped === "rejected: the pass stopped" && stopMs < 1000 && !stallSaid.some((l) => /did not answer/.test(l)) && built === "ran",
      `a stop during a connect that hangs ends the wait in ${stopMs} ms, as a stop (${stopped}); a URL Bun refuses as it builds the client fails open (${built})`);
  }
  // Fail open: a semaphore whose database does not answer — here a port that takes each connection and closes it,
  // counting them — lets the call run without a slot, said once, within its connection's bound; then not asked
  // again for 30 s, the call queued behind the one that found it down included. Each failed open once tries the
  // same number of connections: the pair's tries are one call's.
  let tries = 0;
  const closer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(sock) { tries++; sock.end(); }, data() {} } });
  const openSaid: string[] = [];
  const deadUrl = `postgres://postgres:x@127.0.0.1:${closer.port}/none`;
  const lone = installBackgroundSlots({ url: deadUrl, raw: "chat=1", log: () => {}, connectS: 1 });
  await modelCall(call(), async () => "alone").catch(() => "rejected").finally(() => lone.uninstall());
  const triesOne = tries;
  tries = 0;
  const dead = installBackgroundSlots({ url: deadUrl, raw: "chat=1", log: (l) => openSaid.push(l), connectS: 1 });
  try {
    const tOpen = Date.now();
    const ran = await Promise.all([modelCall(call(), async () => "a"), modelCall(call(), async () => "b")]).then((r) => r.join(), (e: unknown) => `rejected: ${(e as Error).message}`);
    const triesFirst = tries;
    const openMs = Date.now() - tOpen;
    const again = await modelCall(call(), async () => "c").then((r) => r, (e: unknown) => `rejected: ${(e as Error).message}`);
    assert(ran === "a,b" && again === "c" && openSaid.filter((l) => /did not answer/.test(l)).length === 1 && triesOne >= 1 && triesFirst === triesOne && tries === triesFirst && openMs < 2500,
      `a semaphore whose database does not answer fails open: the calls run within the connection's bound (${openMs} ms), said once, and the database is not asked again meanwhile, the queued call included (${triesOne} connection tries alone, ${triesFirst} for a pair, ${tries} after a later call; ${JSON.stringify(openSaid)})`);
  } finally {
    await dead.uninstall();
    closer.stop(true);
  }
  await watch.close();
  // A pass's first stop aborts a call in hand waiting on the hook, and one that starts to after it, the thought to go
  // back as that stop; a call idle on the gate or running inside idleWhile — the decider's — is left to finish
  // (review passes 5 and 6).
  {
    const ih = inHandCalls(() => false);
    const running = ih.begin("w1"), onHook = ih.begin("w2");
    running.waiting = true;
    waitsFor(() => ih.get("w2")).waiting();
    const swept = ih.abortWaiting();
    const later = ih.begin("w3");
    const laterWaits = waitsFor(() => ih.get("w3"));
    const afterRun = ih.begin("w4");
    afterRun.noWait = false;
    const ranWaits = waitsFor(() => ih.get("w4"));
    ranWaits.waiting();
    ranWaits.running();
    laterWaits.waiting();
    assert(swept === 1 && !running.aborted && onHook.aborted && onHook.abort.signal.reason instanceof StoppedWaiting && later.aborted && later.abort.signal.reason instanceof StoppedWaiting && afterRun.slotWait === false,
      `a first stop aborts the call waiting on the hook (${swept} swept), not the one idle around a running call, and a call that starts to wait after it; a call's slot wait ends when it runs`);
  }
  // A wait on the hook begun before idleWhile — its argument evaluated first, the decider's call queued — ends inside
  // it with the entry still idle: no call N12 aborts (review pass 7: running() set it running again).
  {
    const ih = inHandCalls(() => false);
    const c = ih.begin("w");
    c.since = Date.now() - 10_000;
    const obs = waitsFor(() => ih.get("w"));
    obs.waiting();
    let inside = { waiting: false, aborted: -1 };
    const pending = new Promise<void>((resolve) => setTimeout(resolve, 50));
    const idling = idleWhile(c, pending.then(() => { obs.running(); inside = { waiting: c.waiting, aborted: ih.abortInHand(0) }; }));
    await idling;
    assert(inside.waiting && inside.aborted === 0 && !c.waiting && !c.idle,
      `a wait begun before idleWhile ends inside it with the entry idle, N12 aborting nothing (${JSON.stringify(inside)}), and idle once it returns`);
  }
  // The pair's bound pauses while its calls wait: 600 ms, paused from about 400 to 900, fires about 200 ms after the
  // resume. Bounded tight on its early side, with room on its late one for a loaded runner's timer (review pass 4):
  // resumed in full it would fire 400 ms late, never paused 500 ms early.
  const d = pausableTimeout(600);
  const tFire = Date.now();
  let pausedAt = 0, resumedAt = 0;
  setTimeout(() => { pausedAt = Date.now() - tFire; d.waits.waiting(); }, 400);
  setTimeout(() => { resumedAt = Date.now() - tFire; d.waits.running(); }, 900);
  await new Promise<void>((resolve) => d.signal.addEventListener("abort", () => resolve(), { once: true }));
  const firedAt = Date.now() - tFire;
  d.dispose();
  const expected = resumedAt + (600 - pausedAt);
  assert(firedAt >= expected - 20 && firedAt < expected + 250 && (d.signal.reason as Error).name === "TimeoutError",
    `a pausable deadline stops while its calls wait and goes on with what was left: paused at ${pausedAt}, resumed at ${resumedAt}, fired at ${firedAt} ms (expected ${expected}), a TimeoutError`);
}

console.log("\n[13] A redirect is never followed: each call that sends brain text refuses a 3xx where it lands, each probe reads it as refused, and the origin it points at receives nothing (SMD-2908)");
{
  const { resolveEmbedConfig, createEmbedder, providerCall, providerEndpoint, ProviderError, providerDown, refuseRedirect } = await import("./embed.ts");
  const { linearClient } = await import("../db/linear-api.ts");
  const { judgePair } = await import("./consolidate.ts");
  const { extractEntities } = await import("./entities.ts");
  const { resolveJevConfig, jevInfo } = await import("./jev.ts");
  const { probeChat, probeTier, modelListed, classifyError } = await import("../db/worker-bootstrap.ts");
  const { deliverTelegram } = await import("../db/weekly-digest.ts");
  // The far origin: anything that reaches it went past the gate's judgement of the base.
  const farSeen: string[] = [];
  const far = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { farSeen.push(`${req.method} ${new URL(req.url).pathname} ${await req.text()}`); return Response.json({ data: [], choices: [] }); } });
  // The base the gate judged: a stand-in declared local that redirects every request to the same path at the far origin.
  let status = 307;
  /** Set, a relative Location the stand-in answers instead (review pass 2: it must resolve against the URL that answered). */
  let relative = "";
  /** Set, the stand-in answers its 3xx with no Location at all. */
  let noLocation = false;
  // Its body repeats the target whole, as Express's default does ("Found. Redirecting to …"): a message that prints the
  // body undoes the target's masking (review pass 3).
  const near = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => {
    const location = relative || `http://127.0.0.1:${far.port}${new URL(req.url).pathname}`;
    return new Response(`Found. Redirecting to ${location}`, { status, headers: noLocation ? {} : { location } });
  } });
  const NEAR = `http://127.0.0.1:${near.port}/v1`;
  const FAR = `127.0.0.1:${far.port}`;
  try {
    const cfg = resolveEmbedConfig({ OB1_LLM_LOCAL: "1", OB1_LLM_BASE_URL: NEAR, OB1_METADATA_MODEL: META_MODEL, OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_EMBEDDING_DIM: String(DIM) });
    const failure = (p: Promise<unknown>) => p.then(() => "answered", (e: unknown) => e);
    const asRedirect = (e: unknown, s: number) => e instanceof ProviderError && e.kind === "http" && e.status === s && /never followed/.test(e.message) && e.message.includes(FAR);
    // Every 3xx a provider might send, through providerCall: the embedder's and a chat call's.
    for (const s of [301, 302, 303, 307, 308]) {
      status = s;
      const emb = await failure(createEmbedder(() => cfg).getEmbedding("private text", { kind: "re-embed" }));
      const chat = await failure(providerCall(cfg, "/chat/completions", { model: META_MODEL, messages: [{ role: "user", content: "private text" }] }, { kind: "capture" }));
      assert(asRedirect(emb, s) && asRedirect(chat, s), `a ${s}: providerCall's embedding and chat calls each fail as a redirect never followed, naming where it pointed (${String(emb)}; ${String(chat)})`);
    }
    status = 307;
    const judged = await failure(judgePair({ content: "private older", createdAt: null }, { content: "private newer", createdAt: null }, cfg));
    const extracted = await failure(extractEntities("Ada works on private text.", cfg, undefined, { kind: "extraction" }));
    assert(asRedirect(judged, 307) && asRedirect(extracted, 307), `the judge and extraction fail as a redirect never followed (${String(judged)}; ${String(extracted)})`);
    // A refused redirect is no outage, and a worker stops its pass on it: every call to that base would meet it.
    assert(providerDown(judged) === null && classifyError(judged) === "fatal" && classifyError(extracted, { maxTokensFatal: true }) === "fatal",
      `a redirect is no outage (providerDown null) and fatal to a worker's pass (${JSON.stringify(providerDown(judged))}, ${classifyError(judged)})`);
    // The probes: a worker's chat probe reads a redirect as refused, never up; the model list as unknown.
    const probe = await probeChat({ base: NEAR, headers: {} }, META_MODEL, 5000);
    const listed = await modelListed({ base: NEAR, headers: {} }, META_MODEL, META_MODEL, 5000);
    assert(probe.state === "refused" && "why" in probe && /never followed/.test(probe.why) && listed === "unknown",
      `a worker's probe reads a redirect as refused, not up, and the model list as unknown (${JSON.stringify(probe)}; ${listed})`);
    // The decide tier's client already refused one (jev.ts); its probe now reads that as refused, not an outage waited out.
    const jev = resolveJevConfig({ OB1_JEV_BASE_URL: `http://127.0.0.1:${near.port}`, OB1_JEV_LOCAL: "1", OB1_JEV_MODEL: "stub-decider" })!;
    const tierInfo = await failure(jevInfo(jev));
    const tier = await probeTier(jev, "stub-decider", 5000);
    assert((tierInfo as { status?: number }).status === 307 && tier.state === "refused", `the decide tier's client fails on a redirect and its probe reads it as refused (${String(tierInfo)}; ${JSON.stringify(tier)})`);
    // Its message masks the target's query, and leaves out the body that repeats it (review pass 3).
    relative = "http://evil.example/x?key=private-query-key";
    const tierHostile = await failure(jevInfo(jev));
    relative = "";
    const tierMsg = tierHostile instanceof Error ? tierHostile.message : String(tierHostile);
    assert(tierMsg.includes("redirecting to http://evil.example/x?…") && !tierMsg.includes("private-query-key") && (tierHostile as { body?: string }).body === "",
      `the decide tier's message masks a target's query and prints no body that repeats it (${tierMsg})`);
    // The digest's Telegram post: refused, not retried, and the bot token in the redirect's target never printed.
    const token = "123456:private-bot-token";
    const tg = await failure(deliverTelegram(providerEndpoint(NEAR, undefined, true), token, "42", "the digest's private text"));
    const tgMsg = tg instanceof Error ? tg.message : String(tg);
    // Its target is named by host alone: a path that echoes the token can spell it any way a server likes (review pass 2).
    assert(tg instanceof ProviderError && tg.status === 307 && /never followed/.test(tgMsg) && tgMsg.includes(`redirecting to http://${FAR}/…:`) && !/private-bot-token|bot123456/.test(tgMsg) && !/sendMessage/.test(tgMsg.split("redirecting to")[1] ?? ""),
      `the digest's Telegram post fails as a redirect, naming only the target's host, never the token in its path (${tgMsg})`);
    // A relative target is resolved against the URL that answered, as fetch would, not the base: the base's last
    // segment is kept (review pass 2: against the base, `embeddings-v2` read as http://host/embeddings-v2).
    relative = "embeddings-v2";
    const rel = await failure(createEmbedder(() => cfg).getEmbedding("private text", { kind: "re-embed" }));
    relative = "";
    const relMsg = rel instanceof Error ? rel.message : String(rel);
    assert(relMsg.includes(`redirecting to ${NEAR}/embeddings-v2:`), `a relative target resolves against the URL that answered (${relMsg})`);
    // The Linear client, which board-findings posts brain rows through under the gate: refused, its key sent nowhere else.
    const gql = linearClient("lin_api_private", fetch, { url: `${NEAR}/graphql`, timeoutMs: 5000 });
    const lin = await failure(gql("query { viewer { id } }"));
    const linMsg = lin instanceof Error ? lin.message : String(lin);
    assert((lin as { status?: number }).status === 307 && /never followed/.test(linMsg) && linMsg.includes(FAR) && !linMsg.includes("lin_api_private"),
      `the Linear client fails on a redirect, naming the target's host and not its key (${linMsg})`);
    // A 3xx with no Location names no target, not Linear's own host (review pass 3).
    noLocation = true;
    const linBare = await failure(gql("query { viewer { id } }"));
    noLocation = false;
    const linBareMsg = linBare instanceof Error ? linBare.message : String(linBare);
    assert((linBare as { status?: number }).status === 307 && !linBareMsg.includes("redirecting to") && /never followed/.test(linBareMsg),
      `a Linear 3xx with no Location names no target (${linBareMsg})`);
    assert(farSeen.length === 0, `the far origin received nothing from any of them (${JSON.stringify(farSeen).slice(0, 300)})`);
    // How a target prints: a protocol-relative one's userinfo masked, a query's key not printed, a long one capped.
    const hostile = refuseRedirect("Embeddings", NEAR, new Response(null, { status: 302, headers: { location: `//user:pass@evil.example/v1/x?key=private-query-key&pad=${"a".repeat(5000)}` } }));
    const hostileMsg = hostile?.message ?? "";
    assert(hostile !== null && hostileMsg.includes("http://***@evil.example/v1/x?…") && !/user|pass|private-query-key/.test(hostileMsg) && hostileMsg.length < 600,
      `a protocol-relative target's userinfo and a query's key are not printed, and the target is capped (${hostileMsg.length} chars: ${hostileMsg.slice(0, 200)})`);
    const long = refuseRedirect("Embeddings", NEAR, new Response(null, { status: 307, headers: { location: `http://far.example/${"b".repeat(5000)}` } }));
    assert(long !== null && long.message.length < 600 && long.message.includes("…"), `a 5,000-character target prints capped (${long?.message.length} chars)`);
  } finally {
    near.stop(true);
    far.stop(true);
  }
  // A guard over the files, as [11]'s: every fetch call (fetch, globalThis.fetch, Bun.fetch, an injected fetchImpl) in
  // the servers', the REST core's, db/'s, the MCP server's and the plugins' files passes redirect: "manual" or "error"
  // in its options, so a dialler added later cannot follow one by leaving it out — whatever its URL says, since the
  // digest's builds its URL a line before (a guard keyed on a model path in the call missed it). Read by the
  // TypeScript parser (review pass 2: a scanner of its own read a comment's or a string's `redirect: "manual"` as the
  // option, a spread after it as nothing, and skipped a call after a regex literal's quote). `fetch` named but not
  // called — passed, assigned, a default — is counted too, so an alias cannot dial unread. Each call or alias that
  // dials no brain text is named with why.
  const ts = (await import("typescript")).default;
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const here = dirname(fileURLToPath(import.meta.url));
  /** A directory's .ts files, its subdirectories' too when `deep`, node_modules and the test files left out. */
  const tsIn = (d: string, deep: boolean): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (f === "node_modules") return [];
    if (statSync(p).isDirectory()) return deep ? tsIn(p, true) : [];
    return p.endsWith(".ts") && !/\/test-[^/]*\.ts$/.test(p) ? [p] : [];
  });
  const files = [...[here, join(here, "core"), join(here, "rest"), join(here, "../db"), join(here, "../mcp-server")].flatMap((d) => tsIn(d, false)), ...tsIn(join(here, "../plugins"), true)];
  type Node = import("typescript").Node;
  type Expression = import("typescript").Expression;
  /** The receivers whose `.fetch` is the runtime's own: read off one, uncalled, it is an alias. */
  const GLOBAL_FETCH = new Set(["globalThis", "Bun", "self", "window"]);
  /** fetch, fetchImpl, or any x.fetch / x["fetch"]: an injected `opts.fetch(...)` is checked as fetch is (review pass 3). */
  const isFetch = (e: Expression): boolean =>
    (ts.isIdentifier(e) && (e.text === "fetch" || e.text === "fetchImpl"))
    || (ts.isPropertyAccessExpression(e) && e.name.text === "fetch")
    || (ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression) && e.argumentExpression.text === "fetch");
  /** The runtime's fetch read off its global, as globalThis.fetch or Bun["fetch"]. */
  const isGlobalFetch = (n: Node): boolean =>
    (ts.isPropertyAccessExpression(n) && n.name.text === "fetch" && ts.isIdentifier(n.expression) && GLOBAL_FETCH.has(n.expression.text))
    || (ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === "fetch" && ts.isIdentifier(n.expression) && GLOBAL_FETCH.has(n.expression.text));
  /** Whether a call's options say redirect "manual" or "error", with no spread after it that could say otherwise. */
  const refuses = (init: Expression | undefined): boolean => {
    if (!init || !ts.isObjectLiteralExpression(init)) return false;
    let ok = false;
    for (const p of init.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "redirect") ok = ts.isStringLiteral(p.initializer) && (p.initializer.text === "manual" || p.initializer.text === "error");
      else if (ts.isShorthandPropertyAssignment(p) && p.name.text === "redirect") ok = false;
      else if (ts.isSpreadAssignment(p)) ok = false;
    }
    return ok;
  };
  /** A source's fetch calls, guarded or not by line, and `fetch` named but not called (an alias, a default, an argument) by line. */
  const scan = (src: string): { guarded: number; unguarded: number[]; aliases: number[] } => {
    const sf = ts.createSourceFile("scanned.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out = { guarded: 0, unguarded: [] as number[], aliases: [] as number[] };
    const line = (n: Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const visit = (n: Node): void => {
      if (ts.isCallExpression(n) && isFetch(n.expression)) {
        if (refuses(n.arguments[1])) out.guarded++;
        else out.unguarded.push(line(n));
      } else if (isGlobalFetch(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
        // globalThis.fetch read but not called: assigned, passed, a default (review pass 3).
        out.aliases.push(line(n));
      } else if (ts.isIdentifier(n) && n.text === "fetch") {
        const p = n.parent;
        // Not an alias: the callee itself, a member's name (x.fetch, read above when its receiver is the runtime's), a
        // property's or method's name, a type (typeof fetch), a declaration's own name. Shorthand `{ fetch }` is one.
        const named = (ts.isCallExpression(p) && p.expression === n) || (ts.isPropertyAccessExpression(p) && p.name === n)
          || ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isMethodSignature(p) || ts.isPropertySignature(p)) && p.name === n)
          || ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === n);
        if (!named) out.aliases.push(line(n));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  };
  // The scanner's own teeth, on the shapes two cold reads found a scanner of its own passing (review passes 1 and 2).
  const fixtures: [string, string, { unguarded: number; aliases?: number }][] = [
    ["a redirect that follows", 'await fetch(u, { method: "POST", redirect: "follow" });', { unguarded: 1 }],
    ["a regex literal's paren and quote, then a call", 'const re = /"\\(/; await fetch(u, { method: "POST" });\nawait fetch(x, { redirect: "manual" });', { unguarded: 1 }],
    ["a URL's // in a string before the call", 'const u = "http://h"; await fetch(u, { method: "POST" });', { unguarded: 1 }],
    ["an injected fetchImpl", 'const r = await fetchImpl(url, { method: "POST" });', { unguarded: 1 }],
    ["globalThis.fetch and Bun.fetch", 'await globalThis.fetch(u, { method: "POST" }); await Bun.fetch(u, { method: "POST" });', { unguarded: 2 }],
    ["the option in a comment", 'await fetch(u, { method: "POST", // redirect: "manual"\n body });', { unguarded: 1 }],
    ["the option in a string", "await fetch(u, { body: JSON.stringify({ x: 'redirect: \"manual\"' }) });", { unguarded: 1 }],
    ["a spread after the option", 'await fetch(u, { redirect: "manual", ...opts });', { unguarded: 1 }],
    ["an alias", "const f = fetch; await f(u, {});", { unguarded: 0, aliases: 1 }],
    ["a guarded call, a comment's apostrophe inside, a spread before", 'await fetch(u, {\n  ...base,\n  // the caller\'s deadline\n  redirect: "manual",\n});', { unguarded: 0, aliases: 0 }],
    ["globalThis.fetch aliased, Bun.fetch a default", "const f = globalThis.fetch; function g(h = Bun.fetch) { return h; }", { unguarded: 0, aliases: 2 }],
    ["an injected opts.fetch called, and globalThis[\"fetch\"]", 'await opts.fetch(u, { method: "POST" }); await globalThis["fetch"](u, { method: "POST" });', { unguarded: 2, aliases: 0 }],
  ];
  const teeth = fixtures.map(([what, src, want]) => { const s = scan(src); return { what, got: { unguarded: s.unguarded.length, aliases: s.aliases.length }, want }; });
  assert(teeth.every((t) => t.got.unguarded === t.want.unguarded && (t.want.aliases === undefined || t.got.aliases === t.want.aliases)),
    `the guard's scanner counts each shape a cold read found passing as unguarded or an alias, and a guarded call as guarded (${JSON.stringify(teeth.filter((t) => t.got.unguarded !== t.want.unguarded || (t.want.aliases !== undefined && t.got.aliases !== t.want.aliases)))})`);
  /** Calls and aliases that dial no brain text, by repository path and kind, with the count there and why. */
  const NOT_DIALLERS = new Map<string, { calls?: number; aliases?: number }>([
    ["db/bench-live.ts", { calls: 1 }], // the benchmark's calls to the brain's own /mcp
    ["server-portable/oauth-edge.ts", { calls: 1 }], // a pass-through: its caller passes redirect: "manual"
    ["mcp-server/exchange.ts", { calls: 1 }], // globalThis.fetch(request): the Request it builds carries redirect: "manual"
    ["db/linear-api.ts", { aliases: 1 }], // fetchImpl's default, whose every call is read above
    ["db/board-findings.ts", { aliases: 2 }], // handed to linearClient as its fetchImpl, whose calls are read above
    ["db/sync-linear.ts", { aliases: 4 }], // a local array named fetch (the identifiers to fetch), not the global
    ["server-portable/api.ts", { calls: 1 }], // app.fetch: the REST core's own Hono app, in process
    ["mcp-server/index.ts", { calls: 1 }], // app.fetch: the MCP server's own app, in process
    ["mcp-server/stack.ts", { calls: 2 }], // restCore.fetch and app.fetch: the stack's servers, in process
    ["server-portable/core/calls.ts", { calls: 1 }], // c.fetch: the core's fetch-a-thought operation, no HTTP
  ]);
  const root = join(here, "..");
  const unread: string[] = [];
  const allowed = new Map<string, { calls: number; aliases: number }>();
  let guarded = 0;
  for (const f of files) {
    // By its whole repository path: two plugins' files of one name are two entries (review pass 3).
    const name = f.slice(root.length + 1);
    const found = scan(readFileSync(f, "utf8"));
    guarded += found.guarded;
    const known = NOT_DIALLERS.get(name);
    if (known) allowed.set(name, { calls: found.unguarded.length, aliases: found.aliases.length });
    else unread.push(...found.unguarded.map((l) => `${name}:${l}`), ...found.aliases.map((l) => `${name}:${l} (an alias)`));
  }
  const allowedRight = [...NOT_DIALLERS].every(([name, want]) => allowed.get(name)?.calls === (want.calls ?? 0) && allowed.get(name)?.aliases === (want.aliases ?? 0));
  assert(unread.length === 0 && allowedRight && guarded >= 15,
    `every fetch call passes redirect "manual" or "error", and none is aliased, those that dial no brain text aside (${guarded} do; ${unread.join(", ") || "none unread"}; allowed ${JSON.stringify([...allowed])})`);
}

console.log("\n[14] Model calls measured: every call's own time at the seam and its class on the provider's point, a span for the decide tier, a slot wait by how it ended, and each pass's tallies on its stamp, where no telemetry runs (SMD-3379 PR 2b-2a)");
{
  const { asLive, asPass, currentCallClass, modelCall, modelCallTallies } = await import("./model-call.ts");
  const { currentTracing, useTracing, NO_SPAN } = await import("./spans.ts");
  const { resolveEmbedConfig, providerCall } = await import("./embed.ts");
  const { resolveJevConfig, jevInfo } = await import("./jev.ts");
  const { installBackgroundSlots } = await import("./slots.ts");
  const { passStamper, stampKey } = await import("../db/pass-stamp.ts");
  const { parseHeartbeats, modelCallsWords } = await import("./brain-info.ts");
  type Labels = Record<string, string | number | boolean | undefined>;
  const points: { name: string; value: number; labels: Labels }[] = [];
  const spans: { name: string; attributes: Labels }[] = [];
  const before = currentTracing();
  useTracing({
    run: async (name, request, fn) => { spans.push({ name, attributes: { ...request.attributes } }); return fn(NO_SPAN); },
    record: (name, _spec, value, labels) => { points.push({ name, value, labels: { ...labels } }); },
  });
  const pass = "measured";
  const tally = () => modelCallTallies()[pass];
  try {
    const cfg = resolveEmbedConfig({ OB1_LLM_BASE_URL: PROVIDER, OB1_LLM_LOCAL: "1", OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_METADATA_MODEL: META_MODEL });
    const embBody = { model: EMB_MODEL, input: ["measured"] };
    // A background embedding and a live one under one pass: each call's own time a point, labelled with its class,
    // purpose and pass; the provider's point labelled with its class; the pass's tally counting both.
    await asPass(pass, () => providerCall(cfg, "/embeddings", embBody, { kind: "capture" }));
    await asLive(() => asPass(pass, () => providerCall(cfg, "/embeddings", embBody, { kind: "capture" })));
    const seam = points.filter((p) => p.name === "ob1.model.call.duration" && p.labels["ob1.pass"] === pass);
    const provider = spans.filter((sp) => sp.name === `embeddings ${EMB_MODEL}`);
    const t1 = tally();
    assert(seam.length === 2 && seam.map((p) => p.labels["ob1.call.class"]).join() === "background,live"
        && seam.every((p) => p.labels["ob1.model.type"] === "embed" && p.labels["gen_ai.request.model"] === EMB_MODEL && p.labels["ob1.call.purpose"] === "capture" && p.labels["server.address"] === "127.0.0.1" && p.value >= 0 && p.labels["error.type"] === undefined)
        && provider.slice(-2).map((sp) => sp.attributes["ob1.call.class"]).join() === "background,live"
        && t1?.calls.background === 1 && t1.calls.live === 1 && t1.callMs >= 0,
      `each call's own time is a point at the seam labelled with its class, purpose and pass, the provider's span carries the class, and the pass's tally counts both (${JSON.stringify({ seam: seam.map((p) => p.labels["ob1.call.class"]), tally: t1 })})`);
    // A call that names its class, unlike its context's, runs under it: its provider span reads the class its point has
    // (review pass 1).
    const named = await asPass(pass, () => modelCall({ type: "embed", model: EMB_MODEL, base: PROVIDER, purpose: "named", cls: "live" }, async () => currentCallClass()));
    const namedPoint = points.filter((p) => p.name === "ob1.model.call.duration" && p.labels["ob1.call.purpose"] === "named").at(-1);
    assert(named === "live" && namedPoint?.labels["ob1.call.class"] === "live",
      `a call naming its class runs under it, the provider's span and the seam's point one class (${named}, ${namedPoint?.labels["ob1.call.class"]})`);
    // The decide tier's exchange under a client span of its own, `decide <model>`.
    const jev = resolveJevConfig({ OB1_JEV_BASE_URL: PROVIDER, OB1_JEV_LOCAL: "1", OB1_JEV_MODEL: "stub-decider" })!;
    await asPass(pass, () => jevInfo(jev));
    const decide = spans.find((sp) => sp.name === "decide stub-decider");
    const decidePoint = points.find((p) => p.name === "ob1.model.call.duration" && p.labels["ob1.model.type"] === "decide" && p.labels["ob1.call.purpose"] === "info");
    // Preflight's probe of the tier marked as one, as its embedding and chat probes are: the provider alert leaves it out.
    await jevInfo(jev, { probe: "preflight" });
    const probeSpan = spans.filter((sp) => sp.name === "decide stub-decider").at(-1);
    assert(decide?.attributes["gen_ai.operation.name"] === "decide" && decide.attributes["ob1.call.class"] === "background" && decide.attributes["ob1.probe"] === undefined && decidePoint !== undefined
        && probeSpan?.attributes["ob1.probe"] === "preflight",
      `the decide tier's call runs under a client span of its own, a probe's marked as one, and its time is a point at the seam (${JSON.stringify(decide?.attributes)})`);
    // A call that throws: its point names how it failed, and it is counted, as a failure too.
    const callsBefore = tally()!.calls.background;
    const failuresBefore = tally()!.failed;
    await asPass(pass, () => modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "test" }, async () => { throw new TypeError("measured to fail"); })).catch(() => undefined);
    const failed = points.filter((p) => p.name === "ob1.model.call.duration" && p.labels["ob1.call.purpose"] === "test").at(-1);
    // An overload, a timeout and a body are told apart, in the provider point's words (review pass 1).
    const failWith = async (e: unknown) => {
      await asPass(pass, () => modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "test" }, async () => { throw e; })).catch(() => undefined);
      return points.filter((p) => p.name === "ob1.model.call.duration" && p.labels["ob1.call.purpose"] === "test").at(-1)?.labels["error.type"];
    };
    const { ProviderError } = await import("./embed.ts");
    const kinds = [
      await failWith(new ProviderError("overloaded", "http", 503)),
      await failWith(new ProviderError("too slow", "timeout")),
      // A body that is no JSON carries its 2xx, as embed.ts's and jev.ts's do (review pass 2: it read `_OTHER`).
      await failWith(new ProviderError("no JSON", "body", 200)),
      await failWith(new ProviderError("an http error with no status", "http")),
      await failWith(new ProviderError("refused by the gate", "egress")),
      await failWith(Object.assign(new Error("the judge's call answered 429"), { status: 429 })),
      await failWith(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })),
      // Another throw's `kind` is no label: its name is (review pass 2).
      await failWith(Object.assign(new RangeError("a kind of its own"), { kind: "some_arbitrary_kind" })),
    ];
    assert(failed?.labels["error.type"] === "TypeError" && tally()!.calls.background === callsBefore + 9 && tally()!.failed === failuresBefore + 9 && kinds.join() === "503,timeout,invalid_body,http,egress,429,ECONNREFUSED,RangeError",
      `a call that throws is a point naming how it failed — a status, a timeout, a body, the runtime's code, else the throw's name — and counted a failure (${JSON.stringify(kinds)})`);
    // Waits for a slot, by how each ended: held — the second of two under chat=1 waiting for the first — then stopped,
    // then run without one where the semaphore's database does not answer.
    const held = installBackgroundSlots({ url: URL_!, raw: "chat=1", log: () => {} });
    try {
      const work = () => modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "test" }, () => Bun.sleep(150));
      await asPass(pass, () => Promise.all([work(), work()]));
      const stop = new AbortController();
      stop.abort(new Error("stopped before it waited"));
      await asPass(pass, () => modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "test", signal: stop.signal }, async () => "ran")).catch(() => undefined);
    } finally {
      await held.uninstall();
    }
    const dead = installBackgroundSlots({ url: "postgres://postgres:x@127.0.0.1:1/none", raw: "chat=1", log: () => {}, connectS: 1 });
    try {
      await asPass(pass, () => modelCall({ type: "chat", model: META_MODEL, base: PROVIDER, purpose: "test" }, async () => "ran"));
    } finally {
      await dead.uninstall();
    }
    const waits = points.filter((p) => p.name === "ob1.model.slot.wait.duration" && p.labels["ob1.pass"] === pass);
    const ends = waits.map((p) => p.labels["ob1.slot.outcome"]);
    const w = tally()!.slotWaits;
    const longest = Math.max(...waits.filter((p) => p.labels["ob1.slot.outcome"] === "held").map((p) => p.value));
    assert(ends.filter((e) => e === "held").length === 2 && ends.includes("stopped") && ends.includes("open")
        && waits.every((p) => p.labels["ob1.model.type"] === "chat" && p.labels["gen_ai.request.model"] === META_MODEL)
        && longest >= 0.1 && w.held === 2 && w.stopped === 1 && w.open === 1 && w.waited === 1 && w.maxMs >= 100 && w.totalMs >= w.maxMs
        && waits.filter((p) => p.labels["ob1.slot.waited"] === true).length === 1,
      `an ask for a slot is a point by how it ended — two held, the second waiting ${Math.round(longest * 1000)} ms, one stopped, one run without a slot — only the one that waited marked so, and the pass's tally counts each (${JSON.stringify(w)})`);
    // The pass stamp carries the process's tallies; brain_info reads them back and says them.
    let written = "";
    const fakeSql = ((_strings: TemplateStringsArray, ...values: unknown[]) => { written = String(values[1]); return Promise.resolve([]); }) as unknown as import("bun").SQL;
    const stamper = passStamper({ sql: fakeSql, worker: "extract", job: "extract:measured", intervalS: 60 });
    await stamper.stamp("ok");
    const stamped = JSON.parse(written) as { models?: Record<string, unknown> };
    // The row as the database hands it back: its key, and its value as text.
    const beats = parseHeartbeats([{ key: stampKey("extract", "extract:measured"), value: written, at: "2026-11-06T12:00:00.000Z", age_s: 5 }]);
    const words = modelCallsWords(beats.heartbeats) ?? "";
    assert(JSON.stringify(stamped.models?.[pass]) === JSON.stringify(modelCallTallies()[pass]) && beats.heartbeats[0]?.models?.[pass]?.slotWaits.held === 2
        && /extract:measured measured: \d+ background, 2 live call\(s\), [\d.]+ m?s each, \d+ failed — 4 asked for a slot, [\d.]+ m?s in all, the longest [\d.]+ m?s; 1 waited, 1 ran without one, 1 stopped/.test(words),
      `the pass stamp carries the process's tallies, and brain_info reads them back and says them (${words.slice(Math.max(0, words.indexOf("extract:measured measured:")), 400)})`);
    // A stamp whose tallies are not of the shape is left off whole.
    const bad = parseHeartbeats([{ key: stampKey("extract", "extract:measured"), value: JSON.stringify({ ...stamped, models: { measured: { calls: { live: 0, background: 0 }, failed: 0, callMs: -1, slotWaits: { held: 0, open: 0, stopped: 0, waited: 0, totalMs: 0, maxMs: 0 } } } }), at: "2026-11-06T12:00:00.000Z", age_s: 5 }]);
    assert(bad.heartbeats[0] !== undefined && bad.heartbeats[0].models === undefined && modelCallsWords(bad.heartbeats) === null,
      "a stamp whose tallies are not of the shape has them left off, the row read and nothing said of them");
    // Nor figures one process cannot write: more waits than asks, a longest wait past all of them (review pass 2).
    const forged = (slotWaits: Record<string, number>, failed = 0) => parseHeartbeats([{ key: stampKey("extract", "extract:measured"), value: JSON.stringify({ ...stamped, models: { measured: { calls: { live: 0, background: 1 }, failed, callMs: 5, slotWaits } } }), at: "2026-11-06T12:00:00.000Z", age_s: 5 }]).heartbeats[0]?.models;
    const fine = { held: 2, open: 0, stopped: 0, waited: 1, totalMs: 10, maxMs: 9 };
    assert(forged({ held: 1, open: 0, stopped: 0, waited: 2, totalMs: 9, maxMs: 9 }) === undefined && forged({ held: 2, open: 0, stopped: 0, waited: 1, totalMs: 9, maxMs: 10 }) === undefined
        && forged(fine, 2) === undefined && forged(fine, 1)?.measured?.failed === 1
        && forged(fine)?.measured?.slotWaits.waited === 1,
      "tallies no process writes — more waits than asks, a longest wait past them all, more failures than calls — are left off; consistent ones read");
    // The row's times on figures it is handed: under a second in whole milliseconds, else seconds to a tenth (review
    // pass 1's "0.0 s"); the row above matches either unit, so a loaded runner's second does not fail it (review pass 2).
    const wordsOf = (callMs: number, failed: number) => modelCallsWords(parseHeartbeats([{ key: stampKey("extract", "extract:measured"), value: JSON.stringify({ ...stamped, models: { measured: { calls: { live: 0, background: 2 }, failed, callMs, slotWaits: { held: 2, open: 0, stopped: 0, waited: 1, totalMs: 1500, maxMs: 999 } } } }), at: "2026-11-06T12:00:00.000Z", age_s: 5 }]).heartbeats) ?? "";
    const knownWords = wordsOf(61, 0);
    // 999.5 ms a call is "1.0 s", compared once rounded (review pass 3); the failures said beside the time (pass 3).
    const roundedWords = wordsOf(1999, 1);
    assert(knownWords === "since each worker started, as last stamped: extract:measured measured: 2 background call(s), 31 ms each — 2 asked for a slot, 1.5 s in all, the longest 999 ms; 1 waited"
        && roundedWords.includes("2 background call(s), 1.0 s each, 1 failed — 2 asked"),
      `the row says a time under a second in milliseconds, a longer one in seconds, and its failures (${knownWords} | ${roundedWords})`);
  } finally {
    useTracing(before);
  }
}

console.log("\n[15] The background slots on by default (SMD-3379 PR 2b-2b): a local model server's chat and embedding calls held to OB1_MODEL_SLOTS less one, the decide tier's to one, a remote provider's not; a value's own shares over them, holding every endpoint; off, none; and a live genre call waits at most one background decide call at a tier that answers one at a time");
{
  const { slotsSettingFrom, shareOf, installBackgroundSlots } = await import("./slots.ts");
  const { asBackground, asLive, asPass, modelCall, modelCallTallies } = await import("./model-call.ts");
  const { resolveJevConfig, jevInfo } = await import("./jev.ts");
  const { resolveEmbedConfig, providerCall } = await import("./embed.ts");
  type Cls = "live" | "background";
  const call = (type: "chat" | "embed" | "decide", model: string | undefined, base: string, local: boolean, cls: Cls = "background") => ({ type, model, base, local, cls });
  const listed = (m: ReadonlyMap<string, number> | null) => (m ? [...m].map(([k, v]) => `${k}=${v}`).join(",") : "none");
  // The setting: the defaults from OB1_MODEL_SLOTS, a value that does not read said and the defaults kept, off none.
  const d = slotsSettingFrom(undefined, undefined);
  const typoSlots = slotsSettingFrom(undefined, "four");
  assert(d.modelSlots === 4 && listed(d.defaults) === "chat=3,embed=3,decide=1" && d.set === null && d.problems.length === 0
      && listed(slotsSettingFrom(undefined, "2").defaults) === "chat=1,embed=1,decide=1" && listed(slotsSettingFrom("", "1").defaults) === "chat=1,embed=1,decide=1"
      && listed(slotsSettingFrom(undefined, "16").defaults) === "chat=15,embed=15,decide=1"
      && typoSlots.modelSlots === 4 && listed(typoSlots.defaults) === "chat=3,embed=3,decide=1" && /^OB1_MODEL_SLOTS: "four" is no whole number of slots from 1 to 16 .*; 4 stays$/.test(typoSlots.problems[0] ?? "")
      && slotsSettingFrom(undefined, "17").problems.length === 1 && slotsSettingFrom(undefined, "0").problems.length === 1
      && slotsSettingFrom("off", undefined).defaults === null && slotsSettingFrom(" Off ", "2").set === null && slotsSettingFrom(" Off ", "2").defaults === null,
    `the defaults: chat and embed OB1_MODEL_SLOTS less one, at least one, decide one; a slot count that does not read keeps 4, said; off, none (${listed(d.defaults)}; ${typoSlots.problems[0]})`);
  // The shares a call counts against: a local endpoint's default, a remote's none; a value's own over them, for every endpoint.
  const own = slotsSettingFrom("chat=2,chat:big=1", undefined);
  const typo = slotsSettingFrom("chat=0", undefined);
  const H = "http://h/v1", R = "http://r/v1";
  assert(shareOf(d, call("chat", "m", H, true))?.limit === 3 && shareOf(d, call("embed", "e", H, true))?.limit === 3 && shareOf(d, call("decide", undefined, "http://t", true))?.limit === 1
      && shareOf(d, call("chat", "m", R, false)) === null && shareOf(d, call("decide", undefined, "http://t", false)) === null && shareOf(d, call("chat", "m", H, true, "live")) === null
      && shareOf(own, call("chat", "m", R, false))?.limit === 2 && shareOf(own, call("chat", "big", H, true))?.limit === 1 && shareOf(own, call("chat", "m", H, true))?.limit === 2
      && shareOf(own, call("embed", "e", H, true))?.limit === 3 && shareOf(own, call("embed", "e", R, false)) === null
      && typo.set === null && /; the defaults stay$/.test(typo.problems[0] ?? "") && shareOf(typo, call("chat", "m", H, true))?.limit === 3
      && shareOf(slotsSettingFrom("off", undefined), call("chat", "m", H, true)) === null,
    "a local endpoint's calls count against the defaults, a remote's against none; a value's own share, a model's over its type's, holds every endpoint, the defaults kept for the rest; a value that does not read leaves the defaults; off, none");
  // Installed unset, the defaults' hook: a local background call asks for a slot, a remote one does not; an embedding to
  // a local provider, through providerCall, carries its endpoint's locality to the hook.
  const pass = "defaults";
  const hookD = installBackgroundSlots({ url: URL_!, raw: undefined, modelSlots: "4", log: () => {} });
  try {
    await asPass(pass, () => modelCall({ type: "chat", model: "m", base: "http://127.0.0.1:9/v1", local: true, purpose: "test" }, async () => "x"));
    await asPass(pass, () => modelCall({ type: "chat", model: "m", base: "http://127.0.0.1:9/v1", local: false, purpose: "test" }, async () => "x"));
    const localEmbed = resolveEmbedConfig({ OB1_LLM_BASE_URL: PROVIDER, OB1_LLM_LOCAL: "1", OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_METADATA_MODEL: META_MODEL });
    await asPass(pass, () => providerCall(localEmbed, "/embeddings", { model: EMB_MODEL, input: ["held by default"] }, { kind: "capture" }));
  } finally {
    await hookD.uninstall();
  }
  const td = modelCallTallies()[pass];
  assert(hookD.installed && td?.calls.background === 3 && td.slotWaits.held === 2 && td.slotWaits.open === 0,
    `unset, the defaults' hook holds a local endpoint's background calls, an embedding through providerCall among them, and lets a remote's run without asking (${JSON.stringify(td)})`);
  // The live genre wait (draft 5, measured): the decide tier answers one request at a time, and the defaults hold its
  // background calls to one, so a live call — a capture's genre — waits at most the one background call in hand. A
  // stub tier of 300 ms a request, one at a time; two background calls and, between them, a live one.
  const PER_MS = 300;
  let queue: Promise<unknown> = Promise.resolve();
  const tier = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const answer = queue.then(async () => {
        await Bun.sleep(PER_MS);
        return (await fetch(`${PROVIDER}${new URL(req.url).pathname}`)).text();
      });
      queue = answer.catch(() => undefined);
      return answer.then((body) => new Response(body, { headers: { "content-type": "application/json" } }));
    },
  });
  const jevCfg = resolveJevConfig({ OB1_JEV_BASE_URL: `http://127.0.0.1:${tier.port}`, OB1_JEV_LOCAL: "1", OB1_JEV_MODEL: "stub-decider" })!;
  const hookG = installBackgroundSlots({ url: URL_!, raw: undefined, log: () => {} });
  let first = 0, second = 0, live = 0, liveAt = 0;
  try {
    const t0 = performance.now();
    const bg1 = asBackground(() => jevInfo(jevCfg)).then(() => { first = performance.now() - t0; });
    await Bun.sleep(50);
    const bg2 = asBackground(() => jevInfo(jevCfg)).then(() => { second = performance.now() - t0; });
    await Bun.sleep(50);
    liveAt = performance.now() - t0;
    const lv = asLive(() => jevInfo(jevCfg)).then(() => { live = performance.now() - t0; });
    await Promise.all([bg1, bg2, lv]);
  } finally {
    await hookG.uninstall();
    tier.stop(true);
  }
  const waited = live - liveAt - PER_MS;
  assert(first > 0 && live > first && live < second && live - liveAt <= 2 * PER_MS + 500,
    `a live genre call at a one-at-a-time tier waits at most the background call in hand, the second background call held for its slot behind it: the live call waited ${Math.round(waited)} ms for a ${PER_MS} ms call (first ${Math.round(first)}, live ${Math.round(live)}, second ${Math.round(second)} ms)`);
}

server.stop();
provider.stop();

report();
