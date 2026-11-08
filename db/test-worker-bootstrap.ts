#!/usr/bin/env bun
/**
 * test-worker-bootstrap.ts — the db/ claim workers' shared bootstrap
 * (db/worker-bootstrap.ts, SMD-2134 cut 3 / SMD-2303), hermetic.
 *
 * No Postgres, no model, no network. Covers the egress slice: the banner line,
 * the bare refusal reason, the blanket-gate sentence (verb and knob as
 * parameters, one remedy tail), and the identity re-gate wording — with the
 * drop-the-gate mutant, that a remote endpoint under the default deny is
 * refused while a local one proceeds. And the outage slice (SMD-2599): which
 * database errors a follower waits out, and the wait's schedule; a statement
 * run through it, and a worker key's lookup that meets the database down — a
 * closed loopback port, the one URL dialled, refused at once (SMD-2752).
 */

import { providerEndpoint, ProviderError } from "../server-portable/embed.ts";
import { resolveEgressPolicy, ROW_UNITS } from "../server-portable/egress.ts";
import { hashKey } from "../server-portable/auth.ts";
import { blanketGate, classifyError, databasePermanent, databaseUnavailable, egressDescription, egressRefusal, followClassify, followedPass, followerFault, isOut, lookupOutage, modelMissing, PERMANENT_REFUSALS, probeRefusal, outageWait, PROBE_PROMPT, missingModelIs, modelListed, probeAtStart, probeChat, probeUntil, ProviderDown, ProviderOutage, sameModel, regateMessage, SUSPECT_WINDOW_MS, throughOutage, timedOut, TRANSIENT_PAUSES_MS, Unreturned, waitAtStart, waitForDatabase, waitOut, waitOutProvider, workerIdentity, type Probe } from "./worker-bootstrap.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); }
}

// A remote endpoint the gate has a say over, and a local one it does not.
const remote = providerEndpoint("https://api.openai.com", "k", false);
const local = providerEndpoint("http://localhost:11434", undefined, true, "OB1_LLM_LOCAL");
// The default policy: deny, no allow terms — every remote call refused.
const deny = resolveEgressPolicy({});

// ---------------------------------------------------------------------------
// egressRefusal — the bare reason, or null.
// ---------------------------------------------------------------------------
{
  const reason = egressRefusal(remote, deny, ROW_UNITS);
  ok(reason !== null && /deny \(the default\)/.test(reason) && /api\.openai\.com/.test(reason),
    "a remote endpoint under the default deny is refused, and the reason names the policy and the host");
  ok(egressRefusal(local, deny, ROW_UNITS) === null, "a local endpoint is never refused — the gate does not apply");
  // Drop-the-gate mutant: were the gate not consulted, the remote reason would
  // be null like the local one. The two must differ.
  ok(egressRefusal(remote, deny, ROW_UNITS) !== egressRefusal(local, deny, ROW_UNITS),
    "the gate distinguishes the remote endpoint from the local one (drop-the-gate mutant)");
}

// ---------------------------------------------------------------------------
// The units default — the optimistic keyed gate. With a worker key set the
// workers pass units=undefined, which credits the full set (an actor among
// them); the keyless caller passes ROW_UNITS, which carries no actor. Under a
// deny policy whose only allow term is an actor:, the two must differ — the
// keyed gate passes, the keyless one (and the identity re-gate) is refused.
// ---------------------------------------------------------------------------
{
  const actorAllow = resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:someone" });
  ok(egressRefusal(remote, actorAllow, undefined) === null,
    "units undefined reaches the default EGRESS_UNITS (an actor among them): an actor: allow term lets the optimistic keyed gate pass");
  const keyless = egressRefusal(remote, actorAllow, ROW_UNITS);
  ok(keyless !== null && /names a unit this caller never carries/.test(keyless),
    "the same policy refuses a ROW_UNITS caller — it carries no actor for the actor: term to match (the re-gate case)");
}

// ---------------------------------------------------------------------------
// blanketGate — the worker's full "Nothing would be <verb>" sentence.
// ---------------------------------------------------------------------------
{
  const refused = blanketGate({ endpoint: remote, policy: deny, units: ROW_UNITS, verb: "extracted", localKnobKey: "OB1_CHAT_LOCAL" });
  ok(refused !== null && refused.startsWith("Nothing would be extracted: "), "the sentence opens with the pass's own verb");
  ok(refused !== null && refused.includes("Declare the endpoint local (OB1_CHAT_LOCAL=1) if it is, name what may leave in OB1_EGRESS_ALLOW, or set OB1_EGRESS_POLICY — in words, before a pass that would fail every row it claims."),
    "the remedy tail is one text, and names the knob it was given");
  // The verb is the only thing that changes between workers.
  const judged = blanketGate({ endpoint: remote, policy: deny, units: ROW_UNITS, verb: "judged", localKnobKey: "OB1_CHAT_LOCAL" });
  ok(judged !== null && judged.startsWith("Nothing would be judged: "), "another worker gets the same sentence with its own verb");
  ok(refused !== null && judged !== null && refused.slice("Nothing would be extracted".length) === judged.slice("Nothing would be judged".length),
    "only the verb differs — the reason and the remedy are identical");
  // A pass that may run gets no refusal (drop-the-gate: a local endpoint proceeds).
  ok(blanketGate({ endpoint: local, policy: deny, units: ROW_UNITS, verb: "re-embedded", localKnobKey: "OB1_LLM_LOCAL" }) === null,
    "a local endpoint returns null — the pass proceeds");
}

// ---------------------------------------------------------------------------
// regateMessage — the identity re-gate wording.
// ---------------------------------------------------------------------------
{
  const reason = egressRefusal(remote, deny, ROW_UNITS)!;
  const msg = regateMessage("extracted", reason);
  ok(msg.startsWith("Nothing would be extracted: ") && msg.endsWith(" — the worker key did not resolve, so the pass carries no actor for an actor: term to name."),
    "the re-gate names the pass's verb and says the key did not resolve to an actor");
  ok(msg.includes(reason), "the re-gate carries the gate's own reason");
}

// ---------------------------------------------------------------------------
// egressDescription — one banner line, delegating to describeEgress.
// ---------------------------------------------------------------------------
{
  const line = egressDescription(remote, deny, "OB1_CHAT_LOCAL");
  ok(/deny/.test(line) && /api\.openai\.com/.test(line), "the banner line says what the gate does for the endpoint");
  ok(/is declared local \(OB1_LLM_LOCAL\)/.test(egressDescription(local, deny, "OB1_LLM_LOCAL")), "a local endpoint's banner says the gate does not apply");
}

// ---------------------------------------------------------------------------
// classifyError — the claim workers' provider-error classifier (SMD-2303). The
// shared rules, and the one rule extract adds behind maxTokensFatal.
// ---------------------------------------------------------------------------
{
  ok(classifyError({ name: "TimeoutError" }) === "thought", "a timeout is the thought's — retried later");
  ok(classifyError({ message: "the request timed out" }) === "thought", "a 'timed out' message is the thought's too");
  ok(classifyError({ status: 429 }) === "transient", "a 429 is transient");
  ok(classifyError({ status: 503 }) === "transient", "a 5xx is transient");
  ok(classifyError({ message: "connect ECONNREFUSED 127.0.0.1" }) === "transient", "a dropped connection is transient");
  ok(classifyError({ status: 401 }) === "fatal", "a 401 (the key) is fatal");
  ok(classifyError({ status: 404 }) === "fatal", "a 404 (the model) is fatal");
  ok(classifyError({ status: 400, message: "bad request shape" }) === "fatal", "a 400 that is not about length is fatal");
  ok(classifyError({ status: 307 }) === "fatal" && classifyError({ status: 301 }) === "fatal", "a redirect, which no call follows, is fatal: the base redirects every call (SMD-2908)");
  ok(classifyError({}) === "thought", "an error the rules do not recognise is the thought's");
  // The one rule extract adds: a 400 about the answer budget. Without the option
  // it reads as this thought's length (refusesLength matches "tokens") and is the
  // thought's; with it, it names the request and is fatal — stop the whole pass.
  const budget = { status: 400, message: "max_tokens must be at most 4096" };
  ok(classifyError(budget) === "thought", "a max_tokens 400 is the thought's by default (consolidate)");
  ok(classifyError(budget, { maxTokensFatal: true }) === "fatal", "…and fatal under maxTokensFatal (extract) — the same request fails every thought");
  ok(TRANSIENT_PAUSES_MS.length === 3 && TRANSIENT_PAUSES_MS[0] === 5_000, "the transient back-off is three pauses starting at 5 s");
}

// ---------------------------------------------------------------------------
// workerIdentity — the cases that refuse or warn before a store is opened, so no
// database is needed (the URL is never dialled). The resolve cases (a valid key,
// a REVOKED one) need resolve_agent and live in test-live.ts.
// ---------------------------------------------------------------------------
const UNUSED_URL = "postgres://unused@127.0.0.1:1/none";
{
  const warned: string[] = [];
  const noKey = await workerIdentity(UNUSED_URL, {}, { noKeyWarning: "  ⚠  no key here", warn: (l) => warned.push(l) });
  ok(noKey.ok && noKey.identity.agentId === null && noKey.identity.keyName === undefined, "no worker key: the identity is empty — the pass carries no agent");
  ok(warned.length === 1 && warned[0] === "  ⚠  no key here", "no worker key: the caller's own warning is printed");

  const noAccessKeys = await workerIdentity(UNUSED_URL, { OB1_WORKER_KEY: "raw" }, { noKeyWarning: "unused" });
  ok(!noAccessKeys.ok && /OB1_WORKER_KEY is set but MCP_ACCESS_KEYS is not/.test(noAccessKeys.message), "a key set with no MCP_ACCESS_KEYS is refused, and the message says why");

  const notListed = await workerIdentity(UNUSED_URL, { OB1_WORKER_KEY: "raw", MCP_ACCESS_KEYS: `someone:write:${hashKey("a-different-key")}` }, { noKeyWarning: "unused" });
  ok(!notListed.ok && /OB1_WORKER_KEY is not one of the keys in MCP_ACCESS_KEYS/.test(notListed.message), "a key absent from MCP_ACCESS_KEYS is refused — the server would refuse it too");
  // A forwarder (SMD-2284) is refused before a store is opened: no identity, and no `forward` row for 049's CHECK.
  const forwarder = await workerIdentity(UNUSED_URL, { OB1_WORKER_KEY: "raw", MCP_ACCESS_KEYS: `mcp-forwarder:forward:${hashKey("raw")}` }, { noKeyWarning: "unused" });
  ok(!forwarder.ok && /"mcp-forwarder", a forward-scope key — it grants nothing and names no worker/.test(forwarder.message) && /bun keygen\.ts --name <worker> --scope capture/.test(forwarder.message), `a forwarder key is refused as the worker's identity, with a keygen line that runs (${forwarder.ok ? "accepted" : forwarder.message.trim().slice(0, 80)})`);
  // One digest listed twice, a forwarder first (preflight fails the config): the worker takes the caller's record, as the server does — not refused.
  const twice = await workerIdentity(UNUSED_URL, { OB1_WORKER_KEY: "raw", MCP_ACCESS_KEYS: `mcp-forwarder:forward:${hashKey("raw")},laptop:write:${hashKey("raw")}` }, { noKeyWarning: "unused", warn: () => {} });
  ok(twice.ok, `a digest listed as a forwarder and as a write key is the write key here, as the server picks it (${twice.ok ? "accepted" : twice.message.trim().slice(0, 60)})`);
}

// ---------------------------------------------------------------------------
// databaseUnavailable, outageWait, waitOut — a follower waits a database
// outage out (SMD-2599). The error shapes are Bun 1.4's, measured against a
// restarted, stopped and unreachable Postgres.
// ---------------------------------------------------------------------------
{
  const pg = (code: string, errno?: string) => ({ name: "PostgresError", code, ...(errno ? { errno } : {}), message: "m" });
  ok(databaseUnavailable(pg("ERR_POSTGRES_CONNECTION_REFUSED")) && databaseUnavailable(pg("ERR_POSTGRES_CONNECTION_CLOSED")) && databaseUnavailable(pg("ERR_POSTGRES_CONNECTION_TIMEOUT")),
    "a connection refused, closed or timed out is the database unavailable");
  ok(databaseUnavailable(pg("ERR_POSTGRES_SERVER_ERROR", "57P03")) && databaseUnavailable(pg("ERR_POSTGRES_SERVER_ERROR", "57P01")) && databaseUnavailable(pg("ERR_POSTGRES_SERVER_ERROR", "08006")) && databaseUnavailable(pg("ERR_POSTGRES_SERVER_ERROR", "53300")),
    "the server starting up or shutting down, a connection exception and too many connections are the database unavailable");
  ok(!databaseUnavailable(pg("ERR_POSTGRES_SYNTAX_ERROR", "42601")) && !databaseUnavailable(pg("ERR_POSTGRES_SERVER_ERROR", "42883")) && !databaseUnavailable(pg("ERR_POSTGRES_SERVER_ERROR", "28P01")),
    "a syntax error, a missing function and a password refused are not — the run still ends on them");
  // An error no wait mends ends a follower; a passing one costs a worker its poll (review pass 4).
  ok(databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "42883")) && databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "42501")) && databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "28P01")) && databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "3D000")),
    "a function missing, a privilege revoked, a password refused and a database gone are permanent");
  ok(!databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "57014")) && !databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "55P03")) && !databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "40001")) && !databasePermanent(pg("ERR_POSTGRES_SERVER_ERROR", "53200")) && !databasePermanent(pg("ERR_POSTGRES_CONNECTION_REFUSED")),
    "a statement or lock timeout, a serialization failure, out of memory and a connection refused are not");
  ok(!databaseUnavailable({ name: "Error", code: "ERR_POSTGRES_CONNECTION_REFUSED" }) && !databaseUnavailable(null) && !databaseUnavailable({ message: "connect ECONNREFUSED" }),
    "nor is an error that is not the client's — a provider's dropped connection is classifyError's");
  ok(outageWait(0) === 5_000 && outageWait(1) === 10_000 && outageWait(5) === 160_000 && outageWait(6) === 300_000 && outageWait(1e6) === 300_000,
    "the wait between checks is 5 s, doubling, at most 5 min");

  // The schedule without the wall clock: each sleep recorded, the check down twice, then up.
  const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };
  let checks = 0;
  const back = await waitOut({ check: async () => { if (++checks < 3) throw pg("ERR_POSTGRES_CONNECTION_REFUSED"); }, outage: databaseUnavailable, wake: new AbortController().signal, sleep });
  ok(back && checks === 3 && slept.join(",") === "5000,10000,20000", `waitOut checks after each wait until the check answers (${slept.join(",")}, ${checks} checks)`);
  const woken = new AbortController();
  const stopped = await waitOut({ check: async () => { throw pg("ERR_POSTGRES_CONNECTION_REFUSED"); }, outage: databaseUnavailable, wake: woken.signal, sleep: async () => { woken.abort(); } });
  ok(!stopped, "a stop during the wait ends it: false, no check made after it");
  let thrown: unknown = null;
  await waitOut({ check: async () => { throw pg("ERR_POSTGRES_SERVER_ERROR", "28P01"); }, outage: databaseUnavailable, wake: new AbortController().signal, sleep }).catch((e) => { thrown = e; });
  ok((thrown as { errno?: string } | null)?.errno === "28P01", "a check that fails for another reason is thrown, not waited on for ever");

  // throughOutage: the statement again after each wait — its own check, on
  // the schedule carried across tries — the outage said once and its end
  // once; null on a stop; another error thrown (SMD-2752).
  const lines: string[] = [];
  const say = { out: (l: string) => lines.push(`out${l}`), err: (l: string) => lines.push(`err${l}`) };
  let runs = 0;
  const waited: number[] = [];
  const twiceDown = await throughOutage(async () => { if (++runs < 4) throw pg("ERR_POSTGRES_CONNECTION_REFUSED"); return "rows"; }, { wake: new AbortController().signal, said: { down: false }, ...say, sleep: async (ms) => { waited.push(ms); } });
  ok(twiceDown === "rows" && runs === 4 && waited.join(",") === "5000,10000,20000" && lines.length === 2 && /^err {2}the database is not answering \(m\) — waiting for it$/.test(lines[0]) && lines[1] === "out  the database answers again",
    `throughOutage runs the statement again after each wait, the waits doubling across tries, saying the outage and its end once each (${runs} runs, waits ${waited.join(",")}: ${lines.join(" | ")})`);
  const ended = new AbortController();
  const none = await throughOutage(async () => { throw pg("ERR_POSTGRES_CONNECTION_REFUSED"); }, { wake: ended.signal, said: { down: false }, ...say, sleep: async () => { ended.abort(); } });
  ok(none === null, "a stop during throughOutage's wait gives null");
  let other: unknown = null;
  await throughOutage(async () => { throw pg("ERR_POSTGRES_SERVER_ERROR", "42P01"); }, { wake: new AbortController().signal, said: { down: false }, ...say, sleep: async () => {} }).catch((e) => { other = e; });
  ok((other as { errno?: string } | null)?.errno === "42P01", "a statement that fails for another reason is thrown by throughOutage, not retried");

  // The start refusals the sleep scheduler ends on, and those it retries once
  // a pass got through its start (SMD-2752): a lookup that did not name the
  // key may name it next time, so it is retried, not ended on (review pass 1).
  ok([...PERMANENT_REFUSALS].sort().join(",") === "egress,identity,key,model-switch,tables,usage" && !PERMANENT_REFUSALS.has("lookup") && !PERMANENT_REFUSALS.has("model") && !PERMANENT_REFUSALS.has("provider")
    && probeRefusal({ state: "missing", why: "" }) === "model" && probeRefusal({ state: "refused", why: "" }) === "provider",
    `the permanent start refusals are usage, egress, tables, identity, key and model-switch (a re-embed follower never switches the model, SMD-2679) — not model, provider or lookup; a probe's missing model is "model", its refusal "provider" (${[...PERMANENT_REFUSALS].join(",")})`);

  // The lookup's predicate: an outage but too many connections, which the
  // lookup's own connection meets while the pass's pool answers (review pass 2).
  ok(lookupOutage(pg("ERR_POSTGRES_CONNECTION_REFUSED")) && lookupOutage(pg("ERR_POSTGRES_SERVER_ERROR", "57P03")) && !lookupOutage(pg("ERR_POSTGRES_SERVER_ERROR", "53300")) && databaseUnavailable(pg("ERR_POSTGRES_SERVER_ERROR", "53300")) && !lookupOutage(pg("ERR_POSTGRES_SERVER_ERROR", "42P01")),
    "the key's lookup waits on a database refused or starting up, not on too many connections, which a follower's statements still wait on");

  // workerIdentity's lookup with the database not answering (a closed port):
  // warned about and unattributed by default, thrown under `outage` for a
  // follower's start to wait out (SMD-2752).
  const listed = { OB1_WORKER_KEY: "raw", MCP_ACCESS_KEYS: `sleeper:capture:${hashKey("raw")}` };
  const warnedDown: string[] = [];
  const unattributed = await workerIdentity(UNUSED_URL, listed, { noKeyWarning: "unused", warn: (l) => warnedDown.push(l) });
  let lookup: unknown = null;
  await workerIdentity(UNUSED_URL, listed, { noKeyWarning: "unused", warn: () => {}, outage: databaseUnavailable }).catch((e) => { lookup = e; });
  ok(unattributed.ok && unattributed.identity.agentId === null && warnedDown.some((l) => /could not resolve the worker's identity/.test(l)) && databaseUnavailable(lookup),
    `a lookup with the database down warns and goes on unattributed, and under \`outage\` throws for the caller to wait out (${(lookup as Error | null)?.message ?? "not thrown"})`);
}

// ---------------------------------------------------------------------------
// modelMissing, probeChat, probeUntil, ProviderOutage — a follower waits a
// provider outage out (SMD-2599). A stub on the loopback answers the probe
// the way each provider does.
// ---------------------------------------------------------------------------
{
  const thrown = (status: number, words: string) => Object.assign(new Error(`Extraction request to http://h:1/v1 failed: ${status} ${words}`), { status });
  ok(modelMissing(thrown(404, '{"error":{"message":"model \\"qwen2.5:7b\\" not found, try pulling it first"}}')), "Ollama's 404 for a model it has not pulled is the model missing");
  ok(modelMissing(thrown(404, '{"error":{"message":"The model `gpt-x` does not exist or you do not have access to it.","code":"model_not_found"}}')), "OpenAI's and vLLM's 404 naming the model is the model missing");
  ok(modelMissing({ status: 404, body: "model_not_found" }), "a ProviderError's body is read too");
  ok(!modelMissing(thrown(404, "404 page not found")) && !modelMissing(thrown(400, 'model "x" not found')) && !modelMissing(thrown(401, "model not found")),
    "a bare 404 is a wrong base URL, and a model named under another status is not this — both stay fatal");
  ok(!modelMissing(Object.assign(new Error("Extraction request to http://model-not-found.example/v1 failed: 404 page not found"), { status: 404 })),
    "the base URL in the message's lead is not read as the provider's words");
  ok(timedOut({ name: "TimeoutError" }) && timedOut({ message: "the request timed out" }) && !timedOut({ status: 503, message: "overloaded" }), "timedOut reads classifyError's timeout rule");

  // The probe against a stub that answers as told; it records what it was sent.
  let answer: () => Response = () => Response.json({ choices: [{ message: { content: "OK" } }] });
  let sent: { model?: string; max_tokens?: number; messages?: { content: string }[] } = {};
  const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { sent = await req.json(); return answer(); } });
  const at = { base: `http://127.0.0.1:${stub.port}/v1`, headers: { "content-type": "application/json" } };
  try {
    const up = await probeChat(at, "stub-model", 2000);
    ok(up.state === "up" && sent.model === "stub-model" && sent.max_tokens === 1 && sent.messages?.[0]?.content === PROBE_PROMPT, `a 200 is up; the probe is one token of the fixed prompt to the model (${JSON.stringify(sent).slice(0, 120)})`);
    // Out unanswered only when no answer came within the limit or its body never arrived (SMD-3306 PR 6b-1's review
    // pass 8): a refused connection or an answer that errs is out, not unanswered.
    answer = () => new Response('{"error":{"message":"overloaded"}}', { status: 503 });
    const out = await probeChat(at, "m", 2000);
    ok(out.state === "out" && out.why.startsWith("503 ") && out.unanswered === undefined, `a 503 is out, answered (${JSON.stringify(out)})`);
    answer = () => new Response("request timeout", { status: 408 });
    const timeout408 = await probeChat(at, "m", 2000);
    ok(timeout408.state === "out" && timeout408.why.startsWith("408 "), `a 408 is out, the provider's outage as followClassify reads it, not up (SMD-3311; ${JSON.stringify(timeout408)})`);
    answer = () => new Response('{"error":{"message":"model \\"m\\" not found, try pulling it first"}}', { status: 404 });
    ok((await probeChat(at, "m", 2000)).state === "missing", "a 404 naming the model is missing");
    answer = () => new Response("404 page not found", { status: 404 });
    ok((await probeChat(at, "m", 2000)).state === "refused", "a bare 404 is refused (the base URL)");
    answer = () => new Response('{"error":"invalid api key"}', { status: 401 });
    ok((await probeChat(at, "m", 2000)).state === "refused", "a 401 is refused (the key)");
    answer = () => new Response('{"error":"max_tokens is not supported, use max_completion_tokens"}', { status: 400 });
    ok((await probeChat(at, "m", 2000)).state === "up", "another 4xx is up: the provider answered, and the next real call judges it");
    answer = () => new Response(new ReadableStream({ start() {} }), { status: 200 });
    const hung = await probeChat({ ...at }, "m", 300);
    ok(isOut(hung) && hung.unanswered === true, `a provider that does not answer within the deadline is out, unanswered (${JSON.stringify(hung)})`);
    // A 200 whose body starts and then stalls: hung mid-answer, not up (review pass 2).
    answer = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"choices":')); } }), { status: 200 });
    const stalled = await probeChat({ ...at }, "m", 500);
    ok(stalled.state === "out" && stalled.unanswered === true, `a 200 whose answer never arrives is out, unanswered, not up (${JSON.stringify(stalled)})`);
  } finally {
    stub.stop(true);
  }
  const gone = await probeChat({ base: `http://127.0.0.1:${stub.port}/v1`, headers: {} }, "m", 2000);
  ok(gone.state === "out" && gone.unanswered === undefined, `nothing listening is out, refused, not unanswered (${JSON.stringify(gone).slice(0, 100)})`);

  // probeUntil on the schedule, without the wall clock.
  const slept: number[] = [];
  const states: Probe[] = [{ state: "out", why: "503" }, { state: "missing", why: "pulling" }, { state: "up" }];
  const back = await probeUntil(async () => states.shift() as Probe, new AbortController().signal, (p) => !isOut(p), async (ms: number) => { slept.push(ms); });
  ok(back?.state === "up" && slept.join(",") === "5000,10000,20000", `an outage's wait goes through out and missing until up (${slept.join(",")})`);
  const refusedEnds = await probeUntil(async () => ({ state: "refused", why: "401" }), new AbortController().signal, (p) => !isOut(p), async () => {});
  ok(refusedEnds?.state === "refused", "a refused probe ends an outage's wait too: the next real call meets the refusal and ends the run");
  // The start's wait settles on anything but out: a model unserved once the provider answers ends it, for the refusal (review pass 2).
  const startStates: Probe[] = [{ state: "out", why: "ECONNREFUSED" }, { state: "missing", why: "404 model not found" }];
  const startEnds = await probeUntil(async () => startStates.shift() as Probe, new AbortController().signal, (p) => p.state !== "out", async () => {});
  ok(startEnds?.state === "missing", `the start's wait ends on a missing model, not waiting on it for ever (${JSON.stringify(startEnds)})`);
  const woken = new AbortController();
  ok((await probeUntil(async () => ({ state: "out", why: "x" }), woken.signal, (p) => !isOut(p), async () => { woken.abort(); })) === null, "a stop during the wait is null");
  ok(missingModelIs(Object.assign(new Error('Extraction request to http://h/v1 failed: 404 {"error":{"message":"model \\"big-model\\" not found"}}'), { status: 404 }), "big-model")
     && !missingModelIs(Object.assign(new Error('Extraction request to http://h/v1 failed: 404 {"error":{"message":"model \\"big-model\\" not found"}}'), { status: 404 }), "small-model"),
     "missingModelIs names which model a 404 was for");

  // The outage's rule: back to the pool, unless the same thought fails again right after a probe answered.
  const o = new ProviderOutage();
  ok(o.begin("503", "A") === "outage" && o.reason === "503", "a first error past the pauses begins an outage");
  ok(o.begin("503 again", "B") === "outage" && o.reason === "503", "another worker's thought joins it, keeping the first reason");
  o.end();
  ok(o.reason === null, "a probe that answers ends it");
  ok(o.begin("503", "A") === "thought", "the same thought failing again right after is its own: recorded failed");
  ok(o.begin("503", "C") === "outage", "another thought's error begins a new outage");
  o.end();
  ok(o.begin("503", "B") === "outage", "a thought from an earlier outage is not a suspect after a newer one");
  o.end();
  o.settled("B");
  ok(o.begin("503", "B") === "outage", "a thought that finished meanwhile is a suspect no longer");

  // "Right after" is a window from the probe that answered (review pass 1).
  let clock = 0;
  const w = new ProviderOutage(() => clock);
  w.begin("503", "D");
  clock = 1_000;
  w.end();
  clock = 1_000 + SUSPECT_WINDOW_MS;
  ok(w.begin("503", "D") === "thought", "a suspect failing again at the window's edge is its own");
  w.begin("503", "E");
  w.end();
  clock += SUSPECT_WINDOW_MS + 1;
  ok(w.begin("503", "E") === "outage", "a suspect meeting an outage past the window is in an outage like any other thought");
  // A caller's own window, longer than 15 minutes, its calls outrunning the claim passes' (SMD-3306 PR 6b-1's review pass 3).
  let longClock = 0;
  const long = new ProviderOutage(() => longClock, SUSPECT_WINDOW_MS * 4);
  long.begin("500", "L");
  long.end();
  longClock = SUSPECT_WINDOW_MS * 4;
  ok(long.begin("500", "L") === "thought", "a caller's own window holds a suspect past the claim passes' 15 minutes");
  long.begin("500", "M");
  long.end();
  longClock += SUSPECT_WINDOW_MS * 4 + 1;
  ok(long.begin("500", "M") === "outage", "…and only to its own edge");
  // A window read at each error, a caller's limit changing as it runs (consolidation's beside the sweep, SMD-3306 PR 6b-2's review pass 3).
  let readClock = 0;
  let windowNow = SUSPECT_WINDOW_MS;
  const read = new ProviderOutage(() => readClock, () => windowNow);
  read.begin("500", "R");
  read.end();
  windowNow = SUSPECT_WINDOW_MS * 4;
  readClock = SUSPECT_WINDOW_MS * 4;
  ok(read.begin("500", "R") === "thought", "a window read at the error holds a suspect past the window it had when the outage was made");
  read.begin("500", "S");
  read.end();
  windowNow = SUSPECT_WINDOW_MS;
  readClock += SUSPECT_WINDOW_MS + 1;
  ok(read.begin("500", "S") === "outage", "…and its shorter window, read at the next error, ends at its own edge");

  // The schedule carried across outages that come back at once (SMD-2679 PR 4a-2b): from where the last ended, inside the window and nothing settled since.
  let resumeClock = 0;
  const r = new ProviderOutage(() => resumeClock);
  ok(r.resumeFrom(0, 60_000) === 0, "no outage yet: the schedule starts at its first wait");
  r.begin("429");
  r.end(3, 5);
  resumeClock = 30_000;
  ok(r.resumeFrom(5, 60_000) === 3, "back inside the window with nothing settled since: the last outage's step");
  ok(r.resumeFrom(6, 60_000) === 0, "…a thought settled since (re-embedded, or recorded failed): the first wait again");
  resumeClock = 60_000;
  ok(r.resumeFrom(5, 60_000) === 0, "…past the window: the first wait again");
  const plain = new ProviderOutage(() => 0);
  plain.begin("503");
  plain.end();
  ok(plain.resumeFrom(-1, 60_000) === 0 && plain.resumeFrom(0, 60_000) === 0, "an end with no step and no count (extract's) never carries a schedule");

  // followClassify — whose a --follow re-embed worker's error is (SMD-2679 PR 4a-2b, review pass 4).
  const pg = (errno: string, code?: string) => Object.assign(new Error(`pg ${errno}`), { name: "PostgresError", errno, ...(code ? { code } : {}) });
  const http = (status: number, body = "") => new ProviderError(`Embeddings request to http://h/v1 failed: ${status} ${body}`, "http", status, body);
  const runtime = (code: string) => Object.assign(new TypeError("fetch failed"), { code });
  const cells: [unknown, string, string][] = [
    [pg("08006"), "db-wait", "a connection failure"],
    [pg("57P01"), "db-wait", "an administrator's shutdown"],
    [Object.assign(new Error("Connection closed"), { name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" }), "db-wait", "Bun's connection closed"],
    [pg("42501"), "db-end", "a privilege revoked"],
    [pg("42883"), "db-end", "a function gone"],
    [pg("57014"), "db-end", "a statement past statement_timeout"],
    [pg("40P01"), "db-moment", "a deadlock"],
    [pg("40001"), "db-moment", "a serialisation retry"],
    [pg("55P03"), "db-moment", "a lock not available"],
    [pg("53200"), "db-moment", "out of memory"],
    [pg("25006"), "db-moment", "a read-only transaction"],
    [pg("25P02"), "db-moment", "an aborted transaction"],
    [pg("53100"), "db-moment", "a disk full"],
    [pg("0A000"), "db-end", "a feature the server lacks"],
    [pg("57P04"), "db-end", "the database dropped"],
    [pg("XX000"), "thought", "an internal error: recorded, not cycled"],
    [pg("P0001"), "thought", "a function's own guard"],
    [pg("OB002"), "thought", "an invariant the projector holds"],
    [pg("23503"), "thought", "a foreign key (a thought deleted under the write)"],
    [pg("22P02"), "thought", "the thought's data (invalid text)"],
    [pg("23505"), "thought", "a unique violation"],
    [pg("54000"), "thought", "a program limit the thought exceeds"],
    [http(429, "rate limited"), "backpressure", "a 429"],
    [http(503, "server busy"), "backpressure", "a 503"],
    [http(404, '{"error":{"message":"model \\"m\\" not found, try pulling it first"}}'), "backpressure", "the model not served"],
    [http(500), "maybe-poison", "a 500"],
    [http(502), "maybe-poison", "a 502"],
    [http(504), "maybe-poison", "a 504"],
    [http(408), "maybe-poison", "a 408"],
    [new ProviderError("Embeddings request to http://h/v1 timed out after 2 s", "timeout"), "maybe-poison", "a timeout"],
    [runtime("ECONNREFUSED"), "maybe-poison", "a connection refused"],
    [runtime("ENOTFOUND"), "maybe-poison", "a name not resolved"],
    [http(400, '{"error":{"message":"the input exceeds the model\'s context length"}}'), "thought", "a 400 about its length"],
    [http(413, "too large"), "thought", "a 413"],
    [new ProviderError("not sent: the egress gate refused it", "egress"), "thought", "the egress gate's refusal"],
    [http(400, '{"error":{"message":"rejected by the content filter"}}'), "probe-decides", "a 400 not about length"],
    [http(401, "invalid api key"), "probe-decides", "a 401"],
    [http(404, "404 page not found"), "probe-decides", "a 404 naming no model (a wrong base URL)"],
    [http(405), "probe-decides", "a 405"],
    [http(415), "probe-decides", "a 415"],
    [http(422, "unknown parameter dimensions"), "probe-decides", "a 422"],
    [new ProviderError("Embeddings response was not JSON", "body"), "probe-decides", "a body not of the shape"],
    [new Error("Embedding width mismatch: expected 1024, got 768"), "probe-decides", "a width mismatch"],
    [runtime("CERT_HAS_EXPIRED"), "probe-decides", "a runtime error the rules do not know (an expired certificate)"],
    [new TypeError("x is not a function"), "probe-decides", "a bare TypeError"],
    [undefined, "probe-decides", "nothing at all"],
  ];
  const wrong = cells.filter(([e, want]) => followClassify(e) !== want).map(([e, want, what]) => `${what}: ${followClassify(e)}, not ${want}`);
  ok(wrong.length === 0, `followClassify reads each of ${cells.length} errors as whose it is: the database's state, the provider's, the thought's, or the probe's to decide (${wrong.join("; ") || "every cell"})`);

  // The extraction and judge calls' own errors — an Error carrying the answer's status (entities.ts, consolidate.ts) — and a call's deadline, read as embed.ts's (SMD-3311).
  const own = (status: number, body = "") => Object.assign(new Error(`Extraction request to http://h/v1 failed: ${status} ${body}`), { status });
  const ownCells: [unknown, string, string][] = [
    [own(429, "too many requests"), "backpressure", "a 429"],
    [own(503, "busy"), "backpressure", "a 503"],
    [own(404, '{"error":"model \\"m\\" not found, try pulling it first"}'), "backpressure", "the model not served"],
    [own(408), "maybe-poison", "a 408"],
    [own(500), "maybe-poison", "a 500"],
    [own(400, '{"error":{"message":"the input exceeds the model\'s context length"}}'), "thought", "a 400 about its length"],
    [own(401, "invalid api key"), "probe-decides", "a 401"],
    [own(404, "404 page not found"), "probe-decides", "a 404 naming no model"],
    [new DOMException("The operation timed out.", "TimeoutError"), "maybe-poison", "a call's AbortSignal.timeout"],
    [new ProviderDown("the judge call timed out after 120 s, and a one-token call got no answer either"), "maybe-poison", "consolidate's ProviderDown"],
  ];
  const ownWrong = ownCells.filter(([e, want]) => followClassify(e) !== want).map(([e, want, what]) => `${what}: ${followClassify(e)}, not ${want}`);
  ok(ownWrong.length === 0, `followClassify reads the workers' own call errors as embed.ts's of the same status, and a deadline as a timeout (${ownWrong.join("; ") || `all ${ownCells.length}`})`);

  // followerFault — the pausing followers' reading (SMD-3311): classifyError's kind, a 408 transient, and no suspect on backpressure.
  const faults: [unknown, { kind: string; suspect: boolean }, string, { maxTokensFatal?: boolean }?][] = [
    [own(408), { kind: "transient", suspect: true }, "a 408: paused for, then an outage with a suspect — not the request's"],
    [own(408, "litellm.Timeout: Request timed out."), { kind: "transient", suspect: true }, "a 408 whose words say \"timed out\" (a gateway's): the status outranks the words (review pass 1)"],
    [own(504, "upstream request timed out"), { kind: "transient", suspect: true }, "a 504 saying \"timed out\": the same"],
    [own(429, "Request timed out"), { kind: "transient", suspect: false }, "a 429 saying \"timed out\": backpressure, paused for, no suspect (review pass 2)"],
    [own(503, "upstream timed out"), { kind: "transient", suspect: false }, "a 503 saying \"timed out\": the same"],
    [own(400, "the tool call timed out"), { kind: "thought", suspect: true }, "a 400 saying \"timed out\": still the thought's, for the probe to decide"],
    [own(429), { kind: "transient", suspect: false }, "a 429: paused for, then an outage with no suspect"],
    [own(503), { kind: "transient", suspect: false }, "a 503: the same"],
    [own(500), { kind: "transient", suspect: true }, "a 500: paused for, then an outage with a suspect"],
    [own(404, 'model "m" not found'), { kind: "fatal", suspect: false }, "the model not served: the follower's own model-missing path, no suspect"],
    [own(401), { kind: "fatal", suspect: true }, "a 401: still the request's"],
    [own(400, "max_tokens is too large"), { kind: "fatal", suspect: true }, "extract's answer budget refused: still the request's", { maxTokensFatal: true }],
    [new DOMException("The operation timed out.", "TimeoutError"), { kind: "thought", suspect: true }, "a timeout: the thought's until the probe says otherwise, a suspect if it does"],
  ];
  const faultWrong = faults.filter(([e, want, , o]) => { const f = followerFault(e, o); return f.kind !== want.kind || f.suspect !== want.suspect; }).map(([e, want, what, o]) => `${what}: ${JSON.stringify(followerFault(e, o))}, not ${JSON.stringify(want)}`);
  ok(faultWrong.length === 0, `followerFault reads ${faults.length} errors through followClassify's split: a 408 the provider's, backpressure no suspect (${faultWrong.join("; ") || "every cell"})`);

  // A stop ends a probe in flight, as "out" (review pass 1).
  const hang = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  try {
    const stop = new AbortController();
    const t0 = Date.now();
    setTimeout(() => stop.abort(), 100);
    const stopped = await probeChat({ base: `http://127.0.0.1:${hang.port}/v1`, headers: {} }, "m", 10_000, stop.signal);
    ok(stopped.state === "out" && stopped.unanswered === undefined && Date.now() - t0 < 2000, `a stop ends a probe in flight at once, as out, not unanswered (${JSON.stringify(stopped)} after ${Date.now() - t0} ms)`);
  } finally {
    hang.stop(true);
  }
}

// ---------------------------------------------------------------------------
// Review pass 3: model names compared whole, the escalation model's existence
// read from GET /models without loading it, and an unreadable 404 out.
// ---------------------------------------------------------------------------
{
  const ollama404 = (name: string) => Object.assign(new Error(`Extraction request to http://h/v1 failed: 404 {"error":{"message":"model \\"${name}\\" not found, try pulling it first"}}`), { status: 404 });
  ok(missingModelIs(ollama404("qwen3:32b"), "qwen3:32b") && !missingModelIs(ollama404("qwen3:32b"), "qwen3"),
    "a 404 for qwen3:32b names qwen3:32b, not qwen3 — compared whole, not as a substring");
  ok(missingModelIs(ollama404("qwen3:latest"), "qwen3") && missingModelIs(ollama404("qwen3"), "qwen3:latest"), "Ollama's implied :latest tag is the same model");
  ok(missingModelIs(Object.assign(new Error("Judge request to http://h/v1 failed: 404 {\"error\":{\"message\":\"The model `gpt-x` does not exist or you do not have access to it.\",\"code\":\"model_not_found\"}}"), { status: 404 }), "gpt-x"),
    "OpenAI's backticked name is read too");
  ok(sameModel("a", "a") && sameModel("a", "a:latest") && !sameModel("a", "a:7b") && !sameModel("a:7b", "a:14b"), "sameModel: equal, or the :latest tag, nothing else");

  let listing: () => Response = () => Response.json({ object: "list", data: [{ id: "stub-meta" }, { id: "big:latest" }] });
  let chats = 0;
  const lister = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { if (req.method !== "GET") chats++; return listing(); } });
  const at = { base: `http://127.0.0.1:${lister.port}/v1`, headers: {} };
  try {
    ok((await modelListed(at, "big", "stub-meta", 2000)) === "listed" && (await modelListed(at, "absent", "stub-meta", 2000)) === "unlisted" && chats === 0,
      "GET /models: a listed model (its :latest tag implied) is listed, another unlisted, and no model was called");
    // Review pass 4: unlisted only where the list names models as chat does.
    ok((await modelListed(at, "absent", "gemini-2.0-flash", 2000)) === "unknown",
      "a list that does not name the model chat just answered for (Gemini's models/<name>, llama-server's one alias) proves nothing: unknown");
    ok((await modelListed(at, "big:32b", "stub-meta", 2000)) === "unknown",
      "a model sharing a listed id's base (an Ollama tag not pulled, an OpenRouter :nitro variant) is unknown, not refused");
    listing = () => new Response("404 page not found", { status: 404 });
    ok((await modelListed(at, "absent", "stub-meta", 2000)) === "unknown", "a provider with no /models is unknown, refusing nothing");
    listing = () => Response.json({ models: ["absent"] });
    ok((await modelListed(at, "absent", "stub-meta", 2000)) === "unknown", "a list of another shape is unknown");
    listing = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"error":')); } }), { status: 404 });
    const unread = await probeChat(at, "m", 500);
    ok(unread.state === "out" && unread.unanswered === true, `a 404 whose body never arrives is out, unanswered, not refused (${JSON.stringify(unread)})`);
  } finally {
    lister.stop(true);
  }
}

// A follower's waits (SMD-2636): one copy of the start's probe and wait, the database wait, the pass it does not end, and the leases returned later.
{
  const lines: string[] = [];
  const writer = { out: (l: string) => lines.push(`out ${l}`), err: (l: string) => lines.push(`err ${l}`) };
  const instant = async () => {};
  const wake = new AbortController().signal;
  /** A clock the injected sleep advances, in place of Date.now while a cell runs, so the seconds a line says are the schedule's own. */
  let clock = 0;
  const ticking = async (ms: number) => { clock += ms; };
  const onTheClock = async <T>(run: () => Promise<T>): Promise<T> => {
    const realNow = Date.now;
    clock = 1_000_000;
    Date.now = () => clock;
    try {
      return await run();
    } finally {
      Date.now = realNow;
    }
  };
  /** Probes answered in order; asked past the script it answers refused and says so, so a helper that probes too often ends and is reported by name, not looped (review passes 4 and 5). */
  const overran: string[] = [];
  const scripted = (states: Probe[], cell: string) => async (): Promise<Probe> => {
    const next = states.shift();
    if (next) return next;
    // Once refused, so a wait that settles on it ends and the last cell names it; again thrown, naming the cell, so
    // a wait that would probe on for ever ends the suite instead of looping (review pass 5).
    if (overran.includes(cell)) throw new Error(`probed past the script, again: ${cell}`);
    overran.push(cell);
    return { state: "refused", why: "probed past the script" };
  };
  const refuseMissing = async (p: Probe) => (p.state === "missing" ? { kind: "model" as const, line: "unserved" } : null);

  // probeAtStart: a refusal only of a probe that answered; no answer is the start's wait, not its refusal.
  ok("refused" in (await probeAtStart({ probe: scripted([{ state: "missing", why: "404" }], "probeAtStart's unserved"), refusal: refuseMissing })), "probeAtStart: a model unserved at the first probe is refused");
  let refusalsAsked = 0;
  const outFirst = await probeAtStart({ probe: scripted([{ state: "out", why: "ECONNREFUSED" }], "probeAtStart's no answer"), refusal: async () => { refusalsAsked++; return { kind: "provider", line: "never asked" }; } });
  ok("out" in outFirst && outFirst.out === "ECONNREFUSED" && refusalsAsked === 0, `probeAtStart: no answer refuses nothing and asks no refusal — extract's is a GET /models to a provider that is down (review pass 4) — its why kept for the wait (${JSON.stringify(outFirst)}, ${refusalsAsked} asked)`);
  const startStop = new AbortController().signal;
  const signalsSeen: (AbortSignal | undefined)[] = [];
  await probeAtStart({ probe: async (w) => { signalsSeen.push(w); return { state: "up" }; }, refusal: async (_p, w) => { signalsSeen.push(w); return null; }, wake: startStop });
  ok(signalsSeen.length === 2 && signalsSeen.every((w) => w === startStop), "probeAtStart: the caller's stop reaches the probe and the refusal (review pass 4)");
  const upFirst = await probeAtStart({ probe: scripted([{ state: "up" }], "probeAtStart's answer"), refusal: refuseMissing });
  ok("out" in upFirst && upFirst.out === null, "probeAtStart: an answer through its refusals is no wait");

  // waitAtStart: said, the stamper's startWait on then off, probed until anything but out, held to the refusals.
  const stamps: boolean[] = [];
  lines.length = 0;
  const startStates: Probe[] = [{ state: "out", why: "503" }, { state: "up" }];
  const waitSignals: AbortSignal[] = [];
  const nextStart = scripted(startStates, "waitAtStart's out then up");
  const up = await onTheClock(() => waitAtStart({ who: "the provider", why: "503 busy", meanwhile: "claims nothing until it does; it calls m at b for one token", probe: (w) => { waitSignals.push(w); return nextStart(); }, refusal: (p, w) => { waitSignals.push(w); return refuseMissing(p); }, wake, writer, stamper: { startWait: async (on) => { stamps.push(on); } }, sleep: ticking }));
  // Both probes asked: an out probe is waited past, not taken for the answer (review pass 3).
  ok(up === "up" && startStates.length === 0 && waitSignals.length === 3 && waitSignals.every((w) => w === wake) && stamps.join() === "true,false" && /^err {3}the provider is not answering at start \(503 busy\) — the follower claims nothing until it does; it calls m at b for one token after 5 s and then twice as long each time, up to 5 min$/.test(lines[0] ?? "") && /^out {3}the provider answers after 15 s$/.test(lines[1] ?? ""),
    `waitAtStart: said, stamped through, and the answer said (${up}; ${stamps}; ${lines.join(" | ").slice(0, 300)})`);
  stamps.length = 0;
  let thrownThrough = "";
  let probeThrows = 0;
  await waitAtStart({ who: "the provider", why: "x", meanwhile: "m", probe: async () => { if (probeThrows++ === 0) throw new Error("the probe threw"); return { state: "up" }; }, refusal: refuseMissing, wake, writer, stamper: { startWait: async (on) => { stamps.push(on); } }, sleep: instant }).catch((e: Error) => { thrownThrough = e.message; });
  ok(thrownThrough === "the probe threw" && probeThrows === 1 && stamps.join() === "true,false", `waitAtStart: a probe that throws still turns the stamp off, its error thrown, not waited past (review passes 5 and 6; ${stamps}, ${probeThrows} probe(s))`);
  lines.length = 0;
  await waitAtStart({ who: "the provider", why: `${"w".repeat(250)}TAIL`, meanwhile: "m", probe: scripted([{ state: "up" }], "the long why"), refusal: refuseMissing, wake, writer, sleep: instant });
  ok(lines[0]?.includes(`(${"w".repeat(200)}) — `) === true && !lines[0]?.includes("TAIL"), "waitAtStart: the first probe's why cut at 200 characters in the line (review pass 5)");
  lines.length = 0;
  const unserved = await waitAtStart({ who: "the provider", why: "x", meanwhile: "m", probe: scripted([{ state: "missing", why: "404" }], "waitAtStart's unserved"), refusal: refuseMissing, wake, writer, sleep: instant });
  ok(unserved !== null && unserved !== "up" && unserved.refused.kind === "model", "waitAtStart: what answers is held to the start's refusals");
  ok(!lines.some((l) => / answers after /.test(l)), "waitAtStart: a refused answer is not said to answer — the refusal is checked first (review pass 1)");
  const stop = new AbortController();
  stop.abort();
  stamps.length = 0;
  ok((await waitAtStart({ who: "the provider", why: "x", meanwhile: "m", probe: scripted([{ state: "out", why: "x" }], "waitAtStart's stop"), refusal: refuseMissing, wake: stop.signal, writer, stamper: { startWait: async (on) => { stamps.push(on); } }, sleep: instant })) === null && stamps.join() === "true,false",
    `waitAtStart: a stop ends the wait, null, and the stamper's startWait is turned off still (review pass 1; ${stamps})`);

  // waitForDatabase and followedPass: the outage said and waited out, the pass run again at once; anything else thrown.
  const pgDown = () => Object.assign(new Error("Connection closed\nsecond line"), { name: "PostgresError", code: "ERR_POSTGRES_CONNECTION_CLOSED" });
  lines.length = 0;
  let checks = 0;
  ok((await onTheClock(() => waitForDatabase(pgDown(), { check: async () => { if (checks++ === 0) throw pgDown(); }, wake, writer, sleep: ticking, firstLine: true }))) && checks === 2
    && /^err {3}the database is not answering \(Connection closed\) — the follower waits for it, checking after 5 s and then twice as long each time, up to 5 min$/.test(lines[0] ?? "") && /^out {3}the database answers again after 15 s; polling resumes$/.test(lines[1] ?? ""),
    `waitForDatabase: said with the error's first line, checked until it answers, said again (${checks} checks; ${lines.join(" | ").slice(0, 200)})`);
  lines.length = 0;
  await waitForDatabase(pgDown(), { check: async () => {}, wake, writer, sleep: instant });
  ok(/^err {3}the database is not answering \(Connection closed\nsecond line\) — /.test(lines[0] ?? ""), "waitForDatabase: without firstLine the whole message, as extract and consolidate say it (review pass 1)");
  lines.length = 0;
  ok((await waitForDatabase(pgDown(), { check: async () => {}, wake: stop.signal, writer, sleep: instant })) === false && !lines.some((l) => / answers again/.test(l)),
    "waitForDatabase: a stop ends the wait, false, nothing said to answer (review pass 3)");
  let authChecks = 0;
  let authThrew = "";
  await waitForDatabase(pgDown(), { check: async () => { if (authChecks++ === 0) throw Object.assign(new Error("password authentication failed"), { name: "PostgresError", errno: "28P01" }); }, wake, writer, sleep: instant })
    .catch((e: { errno?: string }) => { authThrew = e.errno ?? ""; });
  ok(authThrew === "28P01" && authChecks === 1, `waitForDatabase: a check the database refuses otherwise — a password changed while it was down — is thrown, not waited on (review pass 4; ${authThrew}, ${authChecks} check(s))`);
  let afterThrows = 0;
  let afterPasses = 0;
  const throughAfter = await followedPass({ pass: async () => { afterPasses++; return 7; }, afterPass: async () => { if (afterThrows++ === 0) throw pgDown(); }, follow: true, check: async () => {}, wake, writer, sleep: instant });
  ok(throughAfter === 7 && afterThrows === 2 && afterPasses === 2, `followedPass: the database going away during the provider wait after a pass is waited out too, the pass run again (review passes 1 and 3; ${throughAfter}, ${afterThrows} waits, ${afterPasses} passes)`);
  let passes = 0;
  let afters = 0;
  const twice = await followedPass({ pass: async () => { if (passes++ === 0) throw pgDown(); return passes; }, afterPass: async () => { afters++; }, follow: true, check: async () => {}, wake, writer, sleep: instant });
  ok(twice === 2 && afters === 1, `followedPass: a database outage waited out, the pass run again, its counts returned, the wait for the provider after it (${twice}, ${afters} after)`);
  let threw = "";
  let otherPasses = 0;
  await followedPass({ pass: async () => { if (otherPasses++ === 0) throw new Error("a writer threw"); return 1; }, afterPass: async () => {}, follow: true, check: async () => {}, wake, writer, sleep: instant }).catch((e: Error) => { threw = e.message; });
  ok(threw === "a writer threw" && otherPasses === 1, `followedPass: any other error ends the run (review pass 4: its pass throws once too; ${otherPasses} pass(es))`);
  threw = "";
  // Passes that throw once, so a broken helper returns and is reported here rather than looping (review pass 3).
  let oneShotPasses = 0;
  await followedPass({ pass: async () => { if (oneShotPasses++ === 0) throw pgDown(); return 1; }, afterPass: async () => {}, follow: false, check: async () => {}, wake, writer, sleep: instant }).catch((e: Error) => { threw = e.name; });
  ok(threw === "PostgresError" && oneShotPasses === 1, `followedPass: without --follow a database outage ends the run (${threw}, ${oneShotPasses} pass(es))`);
  let stoppedPasses = 0;
  ok((await followedPass({ pass: async () => { if (stoppedPasses++ === 0) throw pgDown(); return 1; }, afterPass: async () => {}, follow: true, check: async () => {}, wake: stop.signal, writer, sleep: instant })) === null && stoppedPasses === 1,
    `followedPass: a stop during the wait is null, the counts unread (${stoppedPasses} pass(es))`);

  // Unreturned: returned in turn before a pass (the first refused throws), quietly before a gate, all at once at the end.
  const released: string[] = [];
  let refuse = new Set<string>();
  const leases = new Unreturned(async (w) => { if (refuse.has(w)) throw new Error(`refused ${w}`); released.push(w); });
  leases.add("w1");
  leases.add("w2");
  refuse = new Set(["w2"]);
  let returnThrew = false;
  await leases.returnAll().catch(() => { returnThrew = true; });
  ok(returnThrew && released.join() === "w1" && leases.size === 1, `Unreturned.returnAll: each in turn, the first refused thrown, it kept (${released}; ${leases.size} kept)`);
  leases.add("w3");
  await leases.returnWhileAnswered();
  ok(released.join() === "w1" && leases.size === 2, "Unreturned.returnWhileAnswered: a refusal ends the returns quietly, the rest kept");
  // One answered before the refusal, one after it: returned, then the returns end — not a no-op, nor past the refusal (review pass 1).
  const gated: string[] = [];
  const beforeGate = new Unreturned(async (w) => { if (w === "g2") throw new Error("refused g2"); gated.push(w); });
  for (const w of ["g1", "g2", "g3"]) beforeGate.add(w);
  await beforeGate.returnWhileAnswered();
  ok(gated.join() === "g1" && beforeGate.size === 2, `Unreturned.returnWhileAnswered: the one before the refusal returned, the refused and the one after kept (${gated}; ${beforeGate.size} kept)`);
  lines.length = 0;
  await leases.returnAtEnd(30, writer);
  ok(released.join() === "w1,w3" && /^err {3}1 worker\(s\)' leases could not be returned as the run ended; they expire within 30 s$/.test(lines[0] ?? ""), `Unreturned.returnAtEnd: all at once, one line for those that could not go (${released}; ${lines[0]})`);
  lines.length = 0;
  let inFlight = 0;
  let peak = 0;
  const twoRefused = new Unreturned(async () => { inFlight++; peak = Math.max(peak, inFlight); await Promise.resolve(); inFlight--; throw new Error("refused"); });
  twoRefused.add("r1");
  twoRefused.add("r2");
  await twoRefused.returnAtEnd(45, writer);
  ok(peak === 2 && /^err {3}2 worker\(s\)' leases could not be returned as the run ended; they expire within 45 s$/.test(lines[0] ?? ""), `Unreturned.returnAtEnd: all at once, each refusal counted (review pass 5; ${peak} in flight; ${lines[0]})`);
  lines.length = 0;
  const allBack = new Unreturned(async () => {});
  allBack.add("a1");
  await allBack.returnAtEnd(45, writer);
  ok(lines.length === 0, `Unreturned.returnAtEnd: nothing said when every lease went back (review pass 4; ${lines.join(" | ")})`);
  // waitOutProvider (SMD-2636 PR 2): one outage wait, on re-embed's rules — said, stamped, the schedule carried when
  // the outage comes back within the window with nothing settled, an answer ending the outage at its step, a refusal
  // the request's, a stop null.
  {
    const providerStamps: boolean[] = [];
    const stamper = { providerWait: async (on: boolean) => { providerStamps.push(on); } };
    let settledNow = 0;
    const base = { who: "the provider", calls: "m at b for one token", settled: () => settledNow, pollS: 0, pausesBefore: true, wake, writer, stamper, sleep: ticking };
    const o = new ProviderOutage(() => clock);
    o.begin("503 busy", "t1");
    lines.length = 0;
    const first = await onTheClock(() => waitOutProvider({ ...base, outage: o, probe: scripted([{ state: "out", why: "503" }, { state: "up" }], "waitOutProvider's first") }));
    ok(first === "answered" && o.reason === null && providerStamps.join() === "true,false"
      && /^err {3}the provider is not answering \(503 busy\) — unfinished thoughts are back in the pool, recorded nothing; the follower calls m at b for one token after 5 s and then twice as long each time, up to 5 min$/.test(lines[0] ?? "")
      && /^out {3}the provider answers again after 15 s; polling resumes$/.test(lines[1] ?? ""),
      `waitOutProvider: said, stamped, probed until it answers, the outage ended, said again (${first}; ${providerStamps}; ${lines.join(" | ").slice(0, 300)})`);
    // Back at once, nothing settled: the schedule goes on from the last outage's step, said so. Another thought's
    // error begins it: t1's own again, right after the answer, is the thought's, not an outage.
    o.begin("429 limited", "t3");
    lines.length = 0;
    const carried = await onTheClock(() => waitOutProvider({ ...base, outage: o, probe: scripted([{ state: "up" }], "waitOutProvider's carried") }));
    ok(carried === "answered" && /^err {3}the provider is not answering \(429 limited\) — .* for one token after 20 s and then twice as long each time, up to 5 min \(back within a minute and a poll of its last answer, its pauses aside, nothing got past it since, so the last wait's schedule goes on\)$/.test(lines[0] ?? "")
      && /^out {3}the provider answers again after 20 s; polling resumes$/.test(lines[1] ?? ""),
      `waitOutProvider: an outage back within the window, nothing settled, carries the last schedule on, said and slept (${lines.join(" | ").slice(-200)})`);
    // A third, nothing settled still: on from the carried wait's step, not the first one's (review pass 1, mutant).
    o.begin("429 limited", "t6");
    lines.length = 0;
    await onTheClock(() => waitOutProvider({ ...base, outage: o, probe: scripted([{ state: "up" }], "waitOutProvider's third") }));
    ok(/for one token after 40 s and then .*so the last wait's schedule goes on\)$/.test(lines[0] ?? "") && /^out {3}the provider answers again after 40 s; polling resumes$/.test(lines[1] ?? ""),
      `waitOutProvider: a third outage goes on from the carried wait's step (${lines.join(" | ").slice(-200)})`);
    // A thought settled since: the first wait again, no carry said.
    settledNow = 1;
    o.begin("429 limited", "t4");
    lines.length = 0;
    await onTheClock(() => waitOutProvider({ ...base, outage: o, probe: scripted([{ state: "up" }], "waitOutProvider's settled") }));
    ok(/for one token after 5 s and then twice as long each time, up to 5 min$/.test(lines[0] ?? ""), `waitOutProvider: a thought settled since starts the schedule over (${lines[0]})`);
    o.begin("429 limited", "t7");
    lines.length = 0;
    await onTheClock(() => waitOutProvider({ ...base, outage: o, probe: scripted([{ state: "up" }], "waitOutProvider's settled, then unmoved") }));
    ok(/for one token after 10 s and then .*so the last wait's schedule goes on\)$/.test(lines[0] ?? ""),
      `waitOutProvider: the answer records the settled count, so the next outage with it unmoved carries (review pass 1, mutant; ${lines[0]})`);
    // A refusal at the end of the wait is the request's: said, returned, the outage left standing.
    o.begin("503 busy", "t5");
    lines.length = 0;
    providerStamps.length = 0;
    const refused = await onTheClock(() => waitOutProvider({ ...base, who: "the judge", outage: o, probe: scripted([{ state: "refused", why: "401 invalid api key" }], "waitOutProvider's refused") }));
    ok(refused !== null && refused !== "answered" && refused.refused === "401 invalid api key" && refused.tier === undefined && o.reason !== null && providerStamps.join() === "true,false"
      && /^err {3}the judge answers now, refusing the request itself \(401 invalid api key\) — the follower stops; nothing is marked failed$/.test(lines[1] ?? ""),
      `waitOutProvider: a refusal is the request's, said, the follower to stop (${JSON.stringify(refused)}; ${lines[1]})`);
    // The decision tier's probe refused: said in the tier's name, not the caller's (review pass 3), and returned so, for
    // the caller's remedy to name the tier (review pass 1).
    lines.length = 0;
    const byTier = await onTheClock(() => waitOutProvider({ ...base, who: "the judge", outage: o, probe: scripted([{ state: "refused", why: "not an ob1-jev/1 tier", tier: true }], "waitOutProvider's tier refused") }));
    ok(byTier !== null && byTier !== "answered" && byTier.tier === true && byTier.refused === "not an ob1-jev/1 tier"
      && /^err {3}the decision tier answers now, refusing the request itself \(not an ob1-jev\/1 tier\)/.test(lines[1] ?? ""),
      `waitOutProvider: a refusal the tier's probe met says so, in the tier's name (${JSON.stringify(byTier)}; ${lines[1]})`);
    // The count recorded at the answer, not at the wait's start: work another worker settled while it waited moves it,
    // and the next outage with it unmoved since carries (review pass 4, mutant).
    {
      const a = new ProviderOutage(() => clock);
      let n = 0;
      a.begin("429 limited");
      await onTheClock(() => waitOutProvider({ ...base, settled: () => n, outage: a, probe: async () => { n = 5; return { state: "up" }; } }));
      a.begin("429 limited");
      lines.length = 0;
      await onTheClock(() => waitOutProvider({ ...base, settled: () => n, outage: a, probe: scripted([{ state: "up" }], "waitOutProvider's count at the answer") }));
      ok(/for one token after 10 s and then .*so the last wait's schedule goes on\)$/.test(lines[0] ?? ""),
        `waitOutProvider: the count is recorded at the answer, so work settled during the wait does not start the next one over (${lines[0]})`);
    }
    // A probe finding the model missing is still the outage: waited past, not an answer; the lines in the caller's
    // words (review pass 1, mutant: re-embed's "embedding provider" unheld).
    {
      const m = new ProviderOutage(() => clock);
      m.begin("model loading");
      lines.length = 0;
      const back = await onTheClock(() => waitOutProvider({ ...base, who: "the embedding provider", settled: () => 0, outage: m, probe: scripted([{ state: "missing", why: "404 model not found" }, { state: "up" }], "waitOutProvider's missing") }));
      ok(back === "answered" && /^err {3}the embedding provider is not answering \(model loading\)/.test(lines[0] ?? "") && /^out {3}the embedding provider answers again after 15 s; polling resumes$/.test(lines[1] ?? ""),
        `waitOutProvider: a missing model is waited past, the lines in the caller's words (${back}; ${lines.join(" | ").slice(0, 240)})`);
    }
    // At the cap the line says the probe's interval, not a doubling (review pass 1, mutant): a carry from step 6.
    {
      const c = new ProviderOutage(() => clock);
      lines.length = 0;
      await onTheClock(async () => {
        c.end(6, 0);
        c.begin("429 limited");
        return waitOutProvider({ ...base, settled: () => 0, outage: c, probe: scripted([{ state: "up" }], "waitOutProvider's cap") });
      });
      ok(/for one token every 5 min \(back within a minute and a poll of its last answer, its pauses aside/.test(lines[0] ?? ""), `waitOutProvider: a carry at the cap says every 5 min (${lines[0]})`);
      // A step short of it, still the doubling (review pass 5, mutant: the wording a step early).
      const d = new ProviderOutage(() => clock);
      lines.length = 0;
      await onTheClock(async () => {
        d.end(5, 0);
        d.begin("429 limited");
        return waitOutProvider({ ...base, settled: () => 0, outage: d, probe: scripted([{ state: "up" }], "waitOutProvider's step short of the cap") });
      });
      ok(/for one token after 160 s and then twice as long each time, up to 5 min \(back within/.test(lines[0] ?? ""), `waitOutProvider: a carry a step short of the cap says its 160 s (${lines[0]})`);
    }
    // The window's edges: a minute, the poll and — a follower that pauses before an outage — the pauses, read as it
    // runs; strictly within. Each on an outage of its own whose last answer was at step 1, nothing settled since.
    const pausesMs = TRANSIENT_PAUSES_MS.reduce((a, b) => a + b, 0);
    const carriesAfter = async (afterMs: number, pausesBefore: boolean): Promise<string> => {
      const e = new ProviderOutage(() => clock);
      lines.length = 0;
      await onTheClock(async () => {
        e.end(1, 0);
        clock += afterMs;
        e.begin("429 limited");
        return waitOutProvider({ ...base, settled: () => 0, pollS: 5, pausesBefore, outage: e, probe: scripted([{ state: "up" }], `waitOutProvider's edge at ${afterMs} ms`) });
      });
      return lines[0] ?? "";
    };
    const edges = [await carriesAfter(65_000 + pausesMs - 1, true), await carriesAfter(65_000 + pausesMs, true), await carriesAfter(64_999, false), await carriesAfter(65_000, false)];
    ok(/for one token after 10 s and then .*of its last answer, its pauses aside/.test(edges[0]) && /for one token after 5 s and then twice as long each time, up to 5 min$/.test(edges[1])
      && /for one token after 10 s and then twice as long each time, up to 5 min \(back within a minute and a poll of its last answer, no thought settled since, so the last wait's schedule goes on\)$/.test(edges[2]) && /for one token after 5 s and then twice as long each time, up to 5 min$/.test(edges[3]),
      `waitOutProvider: the carry's window is a minute and the poll, and the pauses for a follower that spends them first, strictly within (${edges.map((l) => l.slice(-110)).join(" | ")})`);
    // A stop ends the wait: null, the stamp off.
    providerStamps.length = 0;
    ok((await waitOutProvider({ ...base, outage: o, probe: scripted([{ state: "out", why: "x" }], "waitOutProvider's stop"), wake: stop.signal, sleep: instant })) === null && providerStamps.join() === "true,false",
      `waitOutProvider: a stop ends the wait, null, the stamp turned off (${providerStamps})`);
    // The caller's stop reaches each probe, so a hung one ends with it; the reason cut at 200 and a refusal's why at
    // 160; a probe that throws turns the stamp off and is thrown, not waited past (review pass 2, mutant).
    {
      const t = new ProviderOutage(() => clock);
      t.begin("r".repeat(300));
      const caller = new AbortController();
      const seen: AbortSignal[] = [];
      lines.length = 0;
      const cut = await onTheClock(() => waitOutProvider({ ...base, settled: () => 0, outage: t, wake: caller.signal, probe: async (w) => { seen.push(w); return { state: "refused", why: "w".repeat(300) }; } }));
      ok(seen.length === 1 && seen[0] === caller.signal && cut !== null && cut !== "answered" && cut.refused.length === 300
        && (lines[0] ?? "").includes(`(${"r".repeat(200)})`) && !(lines[0] ?? "").includes("r".repeat(201))
        && (lines[1] ?? "").includes(`(${"w".repeat(160)})`) && !(lines[1] ?? "").includes("w".repeat(161)),
        `waitOutProvider: the caller's stop reaches the probe; the reason cut at 200, the refusal's at 160, returned whole (${seen.length}, ${seen[0] === caller.signal})`);
      providerStamps.length = 0;
      const thrown = await onTheClock(() => waitOutProvider({ ...base, settled: () => 0, outage: t, probe: async () => { throw new Error("probe crashed"); } })).then(() => "returned", (e) => (e as Error).message);
      ok(thrown === "probe crashed" && providerStamps.join() === "true,false", `waitOutProvider: a probe that throws is thrown, the stamp turned off (${thrown}; ${providerStamps})`);
    }
  }
  ok(overran.length === 0, `no follower's-waits cell probed past its script (review pass 5; ${overran.join(", ") || "none"})`);
}

console.log(`\ntest-worker-bootstrap: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
