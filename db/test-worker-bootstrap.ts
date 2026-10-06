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
 * database errors a follower waits out, and the wait's schedule.
 */

import { providerEndpoint } from "../server-portable/embed.ts";
import { resolveEgressPolicy, ROW_UNITS } from "../server-portable/egress.ts";
import { hashKey } from "../server-portable/auth.ts";
import { blanketGate, classifyError, databasePermanent, databaseUnavailable, egressDescription, egressRefusal, isOut, modelMissing, outageWait, PROBE_PROMPT, probeChat, probeUntilUp, ProviderOutage, regateMessage, SUSPECT_WINDOW_MS, timedOut, TRANSIENT_PAUSES_MS, waitOut, workerIdentity, type Probe } from "./worker-bootstrap.ts";

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
}

// ---------------------------------------------------------------------------
// modelMissing, probeChat, probeUntilUp, ProviderOutage — a follower waits a
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
    answer = () => new Response('{"error":{"message":"overloaded"}}', { status: 503 });
    const out = await probeChat(at, "m", 2000);
    ok(out.state === "out" && out.why.startsWith("503 "), `a 503 is out (${JSON.stringify(out)})`);
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
    ok(isOut(hung), `a provider that does not answer within the deadline is out (${JSON.stringify(hung)})`);
  } finally {
    stub.stop(true);
  }
  const gone = await probeChat({ base: `http://127.0.0.1:${stub.port}/v1`, headers: {} }, "m", 2000);
  ok(gone.state === "out", `nothing listening is out (${JSON.stringify(gone).slice(0, 100)})`);

  // probeUntilUp on the schedule, without the wall clock.
  const slept: number[] = [];
  const states: Probe[] = [{ state: "out", why: "503" }, { state: "missing", why: "pulling" }, { state: "up" }];
  const back = await probeUntilUp(async () => states.shift() as Probe, new AbortController().signal, async (ms) => { slept.push(ms); });
  ok(back && slept.join(",") === "5000,10000,20000", `probeUntilUp waits through out and missing until up (${slept.join(",")})`);
  const refusedEnds = await probeUntilUp(async () => ({ state: "refused", why: "401" }), new AbortController().signal, async () => {});
  ok(refusedEnds, "a refused probe ends the wait too: the next real call meets the refusal and ends the run");

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

  // A stop ends a probe in flight, as "out" (review pass 1).
  const hang = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => {}) });
  try {
    const stop = new AbortController();
    const t0 = Date.now();
    setTimeout(() => stop.abort(), 100);
    const stopped = await probeChat({ base: `http://127.0.0.1:${hang.port}/v1`, headers: {} }, "m", 10_000, stop.signal);
    ok(stopped.state === "out" && Date.now() - t0 < 2000, `a stop ends a probe in flight at once, as out (${JSON.stringify(stopped)} after ${Date.now() - t0} ms)`);
  } finally {
    hang.stop(true);
  }
}

console.log(`\ntest-worker-bootstrap: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
