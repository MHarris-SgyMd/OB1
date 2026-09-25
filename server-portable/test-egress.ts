#!/usr/bin/env bun
/**
 * test-egress.ts — what may leave the box for a model call (SMD-1903).
 *
 * The gate is one pure function, egress.ts's mayLeaveBox, and three diallers
 * call it before any request: embed.ts's providerCall, consolidate.ts's
 * judgePair, entities.ts's extractEntities. [1]–[4] hold the function: the
 * policy's parsing (a knob that does not parse fails closed), "local" as a
 * declaration and not a guess, every term unit, and a second opinion that can
 * only refuse. [5] holds the diallers against a stub that counts requests: a
 * refused call is a ProviderError of kind `egress` and the stub sees NOTHING.
 * [6] boots the real server under the default, deny, with the stub NOT
 * declared local and one key allowed by name: a capture under the other key
 * lands without a vector and says why, costs zero requests, and records the
 * decision on its audit row; a search is refused by name while the keyword
 * tool finds the row; an edit stores the new text vectorless; the allowed
 * key's capture reaches the stub.
 *
 * Mutants worth running: drop the gate from providerCall and [5] fails (the
 * stub sees the embedding request); make mayLeaveBox consult the second
 * opinion on a refused subject and [4] fails; read `local` off the hostname
 * and [2] fails.
 *
 *   ../db/with-postgres.sh bun test-egress.ts
 */

import { SQL } from "bun";
import { createAssert, resetSchema } from "../db/test-support.ts";
import { hashKey } from "./auth.ts";
import {
  DEFAULT_EGRESS_MODE, decideCalls, describeEgress, flagOn, localKnob, mayLeaveBox, parseEgressTerms, refusesEverything, resolveEgressPolicy, termMatches,
  type EgressSubject,
} from "./egress.ts";
import { createEmbedder, providerCall, ProviderError, resolveEmbedConfig } from "./embed.ts";
import { judgePair } from "./consolidate.ts";
import { extractEntities } from "./entities.ts";

const { assert, report } = createAssert();

const URL_ = process.env.DATABASE_URL;
if (!URL_) {
  console.error("DATABASE_URL is not set. Try: ../db/with-postgres.sh bun test-egress.ts");
  process.exit(2);
}

const DIM = 768;
const EMB_MODEL = "nomic-embed-text";
const META_MODEL = "llama3.2";

// ── A stand-in provider that counts what reaches it ─────────────────────────
type Seen = { path: string; model: string; input?: string };
const seen: Seen[] = [];
const stub = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as { model: string; input?: string };
    seen.push({ path: url.pathname, model: body.model, input: body.input });
    if (url.pathname.endsWith("/embeddings")) {
      const v = new Array(DIM).fill(0);
      v[String(body.input ?? "").length % DIM] = 1;
      return Response.json({ data: [{ embedding: v }], model: body.model });
    }
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ topics: ["stubbed"], type: "idea", people: [], verdict: "unrelated", supersedes: "unknown", confidence: 0.9, reason: "", entities: [], relations: [] }) } }],
    });
  },
});
const STUB = `http://127.0.0.1:${stub.port}/v1`;
const HOST = `127.0.0.1:${stub.port}`;

console.log("\n[1] The policy: deny unless said otherwise, and a knob that does not parse fails closed");
{
  const unset = resolveEgressPolicy({});
  assert(unset.mode === "deny" && DEFAULT_EGRESS_MODE === "deny" && unset.configured === undefined, "unset: deny, and the row can say it was the default");
  assert(resolveEgressPolicy({ OB1_EGRESS_POLICY: "" }).configured === undefined && resolveEgressPolicy({ OB1_EGRESS_POLICY: "  " }).mode === "deny", "empty and whitespace are unset, as for every knob");
  assert(resolveEgressPolicy({ OB1_EGRESS_POLICY: " Allow " }).mode === "allow" && resolveEgressPolicy({ OB1_EGRESS_POLICY: "OFF" }).mode === "off", "the mode is trimmed and case-insensitive");
  const bad = resolveEgressPolicy({ OB1_EGRESS_POLICY: "maybe" });
  assert(bad.mode === "deny" && bad.configured === undefined && bad.problems.length === 1 && /OB1_EGRESS_POLICY: `maybe` is not one of deny, allow, off/.test(bad.problems[0]),
         `a mode outside the three is a problem and the gate is deny (${bad.problems[0]})`);
  const badTerm = resolveEgressPolicy({ OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: "marker:#phi, nonsense, colour:red, actor:" });
  assert(badTerm.mode === "deny" && badTerm.configured === "allow", "a deny term that does not parse turns allow into deny — fail closed, never looser");
  assert(badTerm.problems.length === 3 && badTerm.problems.every((p) => p.startsWith("OB1_EGRESS_DENY: ")) && badTerm.deny.length === 1,
         `…naming each bad entry with its knob, and keeping the good one (${badTerm.problems.join(" | ")})`);
  const terms = parseEgressTerms(" actor:ChatGPT , marker:phi:yes ,, type:reference ", "X");
  assert(terms.problems.length === 0 && terms.terms.length === 3 && terms.terms[1].value === "phi:yes" && terms.terms[0].value === "ChatGPT",
         "terms are trimmed, empty entries skipped, a colon inside the value kept, the value kept as written");
  assert(flagOn("1") && flagOn(" on ") && flagOn("TRUE") && flagOn("yes") && !flagOn("0") && !flagOn("") && !flagOn(undefined) && !flagOn("local"),
         "the local flags read 1/on/true/yes and nothing else");
}

console.log("\n[2] Local is declared, not guessed — a loopback base with the flag unset is remote to the gate");
{
  const guessable = ["http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "http://host.containers.internal:11434/v1", "http://ollama:11434/v1", "http://192.168.1.20:11434/v1"];
  for (const base of guessable) {
    const cfg = resolveEmbedConfig({ OB1_LLM_BASE_URL: base });
    assert(cfg.embeddings.local === false && cfg.chat.local === false, `${base} with OB1_LLM_LOCAL unset is NOT local`);
    assert(!mayLeaveBox({ kind: "capture" }, cfg.embeddings, cfg.egress).allowed, `…and under the default the gate refuses a capture to it`);
  }
  const declared = resolveEmbedConfig({ OB1_LLM_BASE_URL: "https://openrouter.ai/api/v1", OB1_LLM_LOCAL: "1" });
  assert(declared.embeddings.local && declared.chat.local, "OB1_LLM_LOCAL=1 declares the embeddings endpoint, and the chat endpoint that IS it");
  const d = mayLeaveBox({ kind: "capture" }, declared.embeddings, declared.egress);
  assert(d.allowed && d.rule === "local" && /declared local/.test(d.reason), `a declared endpoint is allowed by the local rule whatever the policy (${d.rule})`);
  assert(mayLeaveBox({ kind: "capture" }, declared.embeddings, resolveEgressPolicy({ OB1_EGRESS_POLICY: "deny", OB1_EGRESS_ALLOW: "actor:nobody" })).allowed,
         "…under deny with no matching term too: the gate does not apply to the box");

  // A chat endpoint of its own has its own declaration; one at the same base inherits.
  const split = resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://127.0.0.1:11434/v1", OB1_LLM_LOCAL: "1", OB1_CHAT_BASE_URL: "https://openrouter.ai/api/v1", OB1_CHAT_API_KEY: "k" });
  assert(split.embeddings.local && !split.chat.local, "a different chat base does not inherit OB1_LLM_LOCAL");
  assert(resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://a:1/v1", OB1_CHAT_BASE_URL: "http://b:1/v1", OB1_CHAT_LOCAL: "on" }).chat.local === true, "OB1_CHAT_LOCAL declares it");
  const sameBase = resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://a:1/v1", OB1_LLM_LOCAL: "1", OB1_CHAT_BASE_URL: "http://a:1/v1/", OB1_CHAT_API_KEY: "k" });
  assert(sameBase.chat !== sameBase.embeddings && sameBase.chat.local === true, "the same base with its own key is its own endpoint and inherits the declaration — one box");
  assert(localKnob(split, "chat") === "OB1_CHAT_LOCAL" && localKnob(sameBase, "chat") === "OB1_LLM_LOCAL" && localKnob(split, "embeddings") === "OB1_LLM_LOCAL",
         "the knob a row names is the one that would declare that endpoint");
  // Either knob declares the shared endpoint (first review pass: OB1_CHAT_LOCAL
  // alone was discarded on it, every call refused, no row saying why).
  const chatOnly = resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://a:1/v1", OB1_CHAT_LOCAL: "1" });
  assert(chatOnly.chat === chatOnly.embeddings && chatOnly.embeddings.local === true, "OB1_CHAT_LOCAL alone declares the one shared endpoint, for both calls");
  assert(chatOnly.embeddings.declaredBy === "OB1_CHAT_LOCAL" && localKnob(chatOnly, "embeddings") === "OB1_CHAT_LOCAL" && localKnob(chatOnly, "chat") === "OB1_CHAT_LOCAL",
         "…and the endpoint carries the knob that declared it, so every banner names OB1_CHAT_LOCAL and not the one the operator did not set");
  assert(declared.embeddings.declaredBy === "OB1_LLM_LOCAL" && resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://a:1/v1" }).embeddings.declaredBy === undefined, "declaredBy names OB1_LLM_LOCAL when it did, and is absent when nothing declared");
  const chatOwnKey = resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://a:1/v1", OB1_CHAT_BASE_URL: "http://a:1/v1", OB1_CHAT_API_KEY: "k", OB1_CHAT_LOCAL: "1" });
  assert(chatOwnKey.chat.local && !chatOwnKey.embeddings.local && localKnob(chatOwnKey, "chat") === "OB1_CHAT_LOCAL" && localKnob(chatOwnKey, "embeddings") === "OB1_LLM_LOCAL",
         "…while a same-base chat endpoint with its own key declared by OB1_CHAT_LOCAL is named by that knob, and the undeclared embeddings one by its own");
}

console.log("\n[3] The rules: every unit under deny and allow, with the reason naming the knob and the term");
{
  const remote = { base: "https://openrouter.ai/api/v1", local: false };
  const deny = resolveEgressPolicy({});
  const subject: EgressSubject = { kind: "capture", actor: "ChatGPT", metadata: { source: "mcp", type: "reference", topics: ["Public", "ob1"] }, content: "Notes #public on the fork" };

  const refused = mayLeaveBox(subject, remote, deny);
  assert(!refused.allowed && refused.rule === "no-allow-term" && /OB1_EGRESS_POLICY=deny \(the default\) and no OB1_EGRESS_ALLOW term matches this capture \(none set\) — the text was not sent to openrouter\.ai/.test(refused.reason),
         `deny with no terms refuses, naming the default and the host (${refused.reason})`);
  for (const [term, hits] of [["actor:chatgpt", true], ["actor:other", false], ["type:reference", true], ["type:task", false], ["topic:public", true], ["topic:private", false], ["marker:#PUBLIC", true], ["marker:#phi", false]] as [string, boolean][]) {
    const policy = resolveEgressPolicy({ OB1_EGRESS_ALLOW: term });
    const d = mayLeaveBox(subject, remote, policy);
    assert(d.allowed === hits && (hits ? d.rule === "allow-term" && d.reason.includes(`OB1_EGRESS_ALLOW ${term}`) : d.rule === "no-allow-term"),
           `deny + OB1_EGRESS_ALLOW=${term}: ${hits ? "allowed by the term, which the reason names" : "refused"}`);
    const inverse = mayLeaveBox(subject, remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: term }));
    assert(inverse.allowed === !hits && (hits ? inverse.rule === "deny-term" && inverse.reason.includes(`OB1_EGRESS_DENY ${term}`) : inverse.rule === "no-deny-term"),
           `allow + OB1_EGRESS_DENY=${term}: ${hits ? "refused by the term" : "allowed"}`);
  }
  // `source` is the one unit whose gating depends on the kind (SMD-1941): a
  // capture's source is the caller's claim, so a `source:` term never gates a
  // capture — even one that DOES carry the label (`subject` above carries
  // source "mcp"). At every other step the value is the row's own, so it gates.
  const capAllow = mayLeaveBox(subject, remote, resolveEgressPolicy({ OB1_EGRESS_ALLOW: "source:mcp" }));
  assert(!capAllow.allowed && capAllow.rule === "no-allow-term", "deny + OB1_EGRESS_ALLOW=source:mcp does NOT let a capture through — its source is the caller's claim (SMD-1941)");
  const capDeny = mayLeaveBox(subject, remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: "source:mcp" }));
  assert(capDeny.allowed && capDeny.rule === "no-deny-term", "allow + OB1_EGRESS_DENY=source:mcp does NOT hold a capture back — a source: term cannot gate a capture");
  for (const kind of ["re-embed", "edit", "judge"] as const) {
    const row: EgressSubject = { kind, metadata: { source: "mcp" } };
    const rowAllow = mayLeaveBox(row, remote, resolveEgressPolicy({ OB1_EGRESS_ALLOW: "source:mcp" }));
    assert(rowAllow.allowed && rowAllow.rule === "allow-term" && rowAllow.reason.includes("OB1_EGRESS_ALLOW source:mcp"), `deny + OB1_EGRESS_ALLOW=source:mcp lets a ${kind} of a row labelled mcp through — the row's own label gates`);
    const rowDeny = mayLeaveBox(row, remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: "source:mcp" }));
    assert(!rowDeny.allowed && rowDeny.rule === "deny-term", `allow + OB1_EGRESS_DENY=source:mcp holds a ${kind} of a row labelled mcp back`);
    assert(termMatches({ unit: "source", value: "mcp" }, row) === true, `termMatches: source:mcp matches a ${kind} subject carrying that label`);
  }
  assert(termMatches({ unit: "source", value: "mcp" }, { kind: "capture", metadata: { source: "mcp" } }) === false, "termMatches: source:mcp never matches a capture subject, even one carrying the label (SMD-1941)");
  assert(termMatches({ unit: "topic", value: "x" }, { kind: "capture", metadata: { topics: "x" } }) === false, "a topics value that is not an array matches no topic term");
  assert(termMatches({ unit: "actor", value: "a" }, { kind: "query" }) === false && termMatches({ unit: "marker", value: "a" }, { kind: "query" }) === false, "an absent unit matches nothing");
  const off = mayLeaveBox(subject, remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "off" }));
  assert(off.allowed && off.rule === "off" && /the gate is off/.test(off.reason), "off allows and says so");
  const closed = mayLeaveBox(subject, remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "off", OB1_EGRESS_ALLOW: "junk" }));
  assert(!closed.allowed && /did not parse/.test(closed.reason) && /fails closed/.test(closed.reason), "off with a term that does not parse is deny, and the reason says the policy did not parse");
  const first = mayLeaveBox(subject, remote, resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:nobody,type:reference,topic:public" }));
  assert(first.allowed && first.reason.includes("type:reference"), "the first matching term is the one named");

  // The record a write carries: one entry per endpoint not declared local, and none at all when both are.
  const cfg = resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://127.0.0.1:1/v1", OB1_LLM_LOCAL: "1", OB1_CHAT_BASE_URL: "https://openrouter.ai/api/v1", OB1_CHAT_API_KEY: "k", OB1_EGRESS_ALLOW: "actor:chatgpt" });
  const both = decideCalls(subject, cfg, cfg.egress);
  assert(both.embeddings.rule === "local" && both.chat.rule === "allow-term", "decideCalls judges each endpoint on its own");
  assert(both.record !== undefined && both.record.embeddings === undefined && both.record.chat?.to === "openrouter.ai" && both.record.chat.allowed === true && both.record.chat.rule === "allow-term" && both.record.policy === "deny",
         `…and records only the endpoint that was judged (${JSON.stringify(both.record)})`);
  const local = resolveEmbedConfig({ OB1_LLM_BASE_URL: "http://127.0.0.1:1/v1", OB1_LLM_LOCAL: "1" });
  assert(decideCalls(subject, local, local.egress).record === undefined, "both declared local: nothing was judged, nothing is recorded");
  assert(/declared local \(OB1_LLM_LOCAL\)/.test(describeEgress(local.embeddings, local.egress, "OB1_LLM_LOCAL")) && /no terms: every call is refused/.test(describeEgress(cfg.chat, resolveEgressPolicy({}), "OB1_CHAT_LOCAL")),
         "describeEgress says what a banner needs");

  // The refusal no row can escape, which a worker reads before claiming.
  const blanket = refusesEverything(remote, resolveEgressPolicy({}));
  assert(blanket !== null && /OB1_EGRESS_POLICY=deny \(the default\) with no OB1_EGRESS_ALLOW term, and openrouter\.ai is not declared local — every call is refused/.test(blanket), `deny with no terms refuses everything, and says so (${blanket})`);
  assert(/did not parse/.test(refusesEverything(remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "off", OB1_EGRESS_DENY: "junk" })) ?? ""), "…as does a policy that did not parse, whatever its mode");
  assert(refusesEverything(remote, resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:x" })) === null && refusesEverything(remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "allow" })) === null && refusesEverything(remote, resolveEgressPolicy({ OB1_EGRESS_POLICY: "off" })) === null,
         "a term, allow or off might let a row through, so nothing is refused up front");
  assert(refusesEverything({ ...remote, local: true }, resolveEgressPolicy({})) === null, "a declared endpoint is never refused up front");
  // A pass with no worker key carries no actor: allow terms over actor alone
  // can match nothing it sends, and the worker is told before claiming.
  const passUnits = ["source", "type", "topic", "marker"] as const;
  const actorOnly = refusesEverything(remote, resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:chatgpt" }), passUnits);
  assert(actorOnly !== null && /every OB1_EGRESS_ALLOW term \(actor:chatgpt\) names a unit this caller never carries \(it carries source, type, topic, marker\)/.test(actorOnly),
         `allow terms over a unit the caller never carries refuse everything up front (${actorOnly})`);
  assert(refusesEverything(remote, resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:chatgpt,type:idea" }), passUnits) === null, "…one reachable term is enough");
  assert(refusesEverything(remote, resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:chatgpt" })) === null, "…and a caller that carries every unit (the server) is not refused up front");
}

console.log("\n[4] A second opinion can only refuse — it is never asked about a refused subject, and a hook that throws refuses");
{
  const remote = { base: "https://openrouter.ai/api/v1", local: false };
  const subject: EgressSubject = { kind: "capture", actor: "open", content: "patient X" };
  const allowing = resolveEgressPolicy({ OB1_EGRESS_ALLOW: "actor:open" });
  let asked = 0;
  const saysSensitive = () => { asked++; return { sensitive: true, reason: "looks like a chart" }; };
  const saysFine = () => { asked++; return { sensitive: false }; };

  const tightened = mayLeaveBox(subject, remote, allowing, saysSensitive);
  assert(!tightened.allowed && tightened.rule === "second-opinion" && /looks like a chart/.test(tightened.reason) && asked === 1, "an allowed subject the hook calls sensitive is refused, with the hook's reason");
  asked = 0;
  assert(mayLeaveBox(subject, remote, allowing, saysFine).allowed && asked === 1, "…and one it calls fine stays allowed");

  // The reverse: a refused subject, a hook that would allow it. Never asked.
  asked = 0;
  const refused = mayLeaveBox(subject, remote, resolveEgressPolicy({}), saysFine);
  assert(!refused.allowed && refused.rule === "no-allow-term" && asked === 0, "a refused subject stays refused and the hook is not even consulted — it has no way to say yes");
  const thrown = mayLeaveBox(subject, remote, allowing, () => { throw new Error("model down"); });
  assert(!thrown.allowed && thrown.rule === "second-opinion" && /model down/.test(thrown.reason), "a hook that throws refuses: could not decide is not yes");
  asked = 0;
  assert(mayLeaveBox(subject, { ...remote, local: true }, resolveEgressPolicy({}), saysSensitive).allowed && asked === 0, "a declared-local endpoint is not judged at all — the text is not leaving");
}

console.log("\n[5] The diallers refuse BEFORE the request: the stub sees nothing under deny, and everything once declared or allowed");
{
  const requests = () => seen.length;
  const gated = resolveEmbedConfig({ OB1_LLM_BASE_URL: STUB, OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_EMBEDDING_DIM: String(DIM), OB1_METADATA_MODEL: META_MODEL });
  const embedder = createEmbedder(() => gated);
  const subject: EgressSubject = { kind: "capture", actor: "gated", content: "a thought" };
  const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProviderError ? e.kind : (e as Error).message));

  const before = requests();
  assert(await kindOf(providerCall(gated, "/embeddings", { model: EMB_MODEL, input: "x" }, subject)) === "egress", "providerCall: an embeddings call is a ProviderError of kind egress");
  assert(await kindOf(providerCall(gated, "/chat/completions", { model: META_MODEL, messages: [] }, subject)) === "egress", "…and a chat call");
  assert(await kindOf(embedder.embedCapture("short", subject)) === "egress", "embedCapture: refused");
  assert(await kindOf(embedder.embedCapture(`long ${"word ".repeat(3000)}`, subject)) === "egress", "…a long capture too — the windows are refused on the same rule, so no head window stands in");
  assert(await kindOf(embedder.getEmbedding("a query", { kind: "query", actor: "gated" }, "query")) === "egress", "getEmbedding: a query is refused");
  assert(await kindOf(judgePair({ content: "older", createdAt: null }, { content: "newer", createdAt: null }, gated)) === "egress", "judgePair: refused");
  assert(await kindOf(extractEntities("Ada met Grace", gated, undefined, { kind: "extraction" })) === "egress", "extractEntities: refused");
  let msg = "";
  try { await providerCall(gated, "/embeddings", { model: EMB_MODEL, input: "x" }, subject); } catch (e) { msg = (e as Error).message; }
  assert(msg.startsWith(`Embeddings request to ${STUB} refused by the egress gate: OB1_EGRESS_POLICY=deny (the default)`), `the message names the call, the endpoint and the rule (${msg.slice(0, 120)})`);
  assert(requests() === before, `…and the stub saw NO request for any of them (${requests() - before})`);

  // A pair is refused when EITHER side may not leave.
  const byType = resolveEmbedConfig({ OB1_LLM_BASE_URL: STUB, OB1_METADATA_MODEL: META_MODEL, OB1_EGRESS_ALLOW: "type:reference" });
  assert(await kindOf(judgePair({ content: "a", createdAt: null, metadata: { type: "reference" } }, { content: "b", createdAt: null, metadata: { type: "person_note" } }, byType)) === "egress",
         "judgePair: one side allowed and one not is refused — the more restricted row decides for the pair");
  assert(await kindOf(judgePair({ content: "a", createdAt: null, metadata: { type: "reference" } }, { content: "b", createdAt: null, metadata: { type: "reference" } }, byType)) === "ok" && requests() === before + 1,
         "…and both allowed is one request");

  // Declared local: every dialler dials.
  const declared = resolveEmbedConfig({ OB1_LLM_BASE_URL: STUB, OB1_LLM_LOCAL: "1", OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_EMBEDDING_DIM: String(DIM), OB1_METADATA_MODEL: META_MODEL });
  const n = requests();
  await createEmbedder(() => declared).embedCapture("short", subject);
  await judgePair({ content: "older", createdAt: null }, { content: "newer", createdAt: null }, declared);
  await extractEntities("Ada met Grace", declared, undefined, { kind: "extraction" });
  assert(requests() === n + 3, `declared local: three calls, three requests (${requests() - n})`);
  // Allowed by a term: likewise, and the marker unit reads the text the dialler is about to send.
  const marked = resolveEmbedConfig({ OB1_LLM_BASE_URL: STUB, OB1_EMBEDDING_MODEL: EMB_MODEL, OB1_EMBEDDING_DIM: String(DIM), OB1_METADATA_MODEL: META_MODEL, OB1_EGRESS_ALLOW: "marker:#public" });
  const m = requests();
  await extractEntities("Ada met Grace #public", marked, undefined, { kind: "extraction" });
  assert(requests() === m + 1, "extractEntities reads the marker off the text it is sending");
  assert(await kindOf(extractEntities("Ada met Grace", marked, undefined, { kind: "extraction" })) === "egress" && requests() === m + 1, "…and refuses the same text without it");
}

// ── The server, under the default, with the stub NOT declared local ─────────
await resetSchema(URL_, { dim: DIM, model: EMB_MODEL });
const GATED_KEY = "g".repeat(64);
const OPEN_KEY = "o".repeat(64);
process.env.OB1_STORE = "sql";
process.env.DATABASE_URL = URL_;
process.env.OB1_LLM_BASE_URL = STUB;
process.env.OB1_EMBEDDING_MODEL = EMB_MODEL;
process.env.OB1_EMBEDDING_DIM = String(DIM);
process.env.OB1_METADATA_MODEL = META_MODEL;
process.env.MCP_ACCESS_KEYS = `gated:write:${hashKey(GATED_KEY)},open:write:${hashKey(OPEN_KEY)}`;
// One key allowed by name, and one type — which only a row already tagged can
// carry, so it reaches an EDIT of such a row and never a first capture; the
// policy itself is the default.
process.env.OB1_EGRESS_ALLOW = "actor:open,type:idea";
for (const k of ["OB1_LLM_LOCAL", "OB1_CHAT_LOCAL", "OB1_EGRESS_POLICY", "OB1_EGRESS_DENY", "OPENROUTER_API_KEY", "OB1_LLM_API_KEY", "OB1_CHAT_BASE_URL", "OB1_CHAT_API_KEY", "MCP_ACCESS_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OB1_EMBEDDING_DIMENSIONS", "OB1_CHUNK_CONTEXT"]) delete process.env[k];

const worker = (await import("./index.ts")).default as { fetch: (r: Request) => Response | Promise<Response> };
const server = Bun.serve({ port: 0, fetch: worker.fetch });
const BASE = `http://localhost:${server.port ?? 0}`;
let rpcId = 1;
async function call(key: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const r = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-brain-key": key },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const t = await r.text();
  const line = t.startsWith("{") ? t : (t.split("\n").find((l) => l.startsWith("data: ")) ?? "").slice(6);
  const b = JSON.parse(line);
  if (b.error) throw new Error(JSON.stringify(b.error));
  return { text: (b.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n"), isError: b.result?.isError === true };
}
const sql = new SQL({ url: URL_, max: 1 });

console.log("\n[6] The server under deny: a refused capture lands without a vector and says why, at zero requests; the allowed key's reaches the stub");
{
  const before = seen.length;
  const cap = await call(GATED_KEY, "capture_thought", { content: "gated-thought-marker: a note that must not leave" });
  assert(!cap.isError && /Captured as thought — id [0-9a-f-]{36}/.test(cap.text), `the capture succeeds, typed as nothing (${cap.text.split("\n")[0]})`);
  assert(/Note: saved WITHOUT a vector — OB1_EGRESS_POLICY=deny \(the default\) and no OB1_EGRESS_ALLOW term matches this capture \(actor:open, type:idea\) — the text was not sent to 127\.0\.0\.1:\d+\./.test(cap.text),
         "…the reply says the vector is missing, names the rule, the terms and the host");
  assert(/findable by exact text \(search_thoughts_keyword\)/.test(cap.text) && /re-embed pass/.test(cap.text), "…and the two ways it is still reachable");
  assert(/Note: no topics, people or type were extracted — OB1_EGRESS_POLICY=deny/.test(cap.text), "…and that no tags were extracted, under the same rule");
  assert(/^Captured as thought — id [0-9a-f-]{36}$/.test(cap.text.split("\n")[0]), "the first line carries no type and no topics — nothing was extracted, and nothing is dressed up as if it were");
  assert(seen.length === before, `zero requests reached the stub (${seen.length - before})`);
  const id = /id ([0-9a-f-]{36})/.exec(cap.text)![1];

  const [row] = await sql`SELECT content, metadata, embedding IS NULL AS no_vector, embedding_model FROM thoughts WHERE id = ${id}::uuid`;
  assert(row.no_vector === true && row.embedding_model === null, "the row has no vector and no model label");
  assert(row.metadata.metadata_extraction_failed === "egress_denied" && row.metadata.type === undefined && row.metadata.topics === undefined && row.metadata.source === "mcp",
         `the metadata records the refusal under the key the other failures use, with no fabricated type or topics (${JSON.stringify(row.metadata)})`);
  const [audit] = await sql`SELECT actor_name, actor_context FROM thought_audit WHERE thought_id = ${id}::uuid AND action = 'capture'`;
  const rec = audit.actor_context?.egress;
  assert(audit.actor_name === "gated" && rec && rec.policy === "deny" && rec.embeddings.allowed === false && rec.embeddings.rule === "no-allow-term" && rec.embeddings.to === HOST && rec.chat.allowed === false && rec.chat.rule === "no-allow-term",
         `the audit row carries the decision: which rule, which host, both calls (${JSON.stringify(audit.actor_context)})`);

  // A search is refused by name, at zero requests; the keyword tool finds the row without one.
  const search = await call(GATED_KEY, "search_thoughts", { query: "a note that must not leave" });
  assert(search.isError && /^Refused: the query text would be sent for its embedding, and OB1_EGRESS_POLICY=deny/.test(search.text) && /search_thoughts_keyword/.test(search.text) && /OB1_LLM_LOCAL=1/.test(search.text) && /OB1_EGRESS_ALLOW=actor:gated/.test(search.text),
         `search_thoughts is refused, with the keyword tool and both operator remedies named (${search.text.slice(0, 100)})`);
  const compat = await call(GATED_KEY, "search", { query: "a note" });
  assert(compat.isError && /^Refused: the query text/.test(compat.text), "…and so is the ChatGPT-shaped search tool");
  const kw = await call(GATED_KEY, "search_thoughts_keyword", { query: "gated-thought-marker" });
  assert(!kw.isError && kw.text.includes(id), "search_thoughts_keyword finds the vectorless row by its text");
  assert(seen.length === before, `still zero requests (${seen.length - before})`);

  // An edit with new text stores it vectorless and says so; the old (absent) vector is not kept for the new text.
  const edit = await call(GATED_KEY, "update_thought", { id, content: "gated-thought-marker: the note, edited, still must not leave" });
  assert(!edit.isError && /content saved without a vector/.test(edit.text) && /Note: saved WITHOUT a vector — OB1_EGRESS_POLICY=deny/.test(edit.text), `the edit lands and says the vector is missing (${edit.text.split("\n")[0]})`);
  const [edited] = await sql`SELECT content, embedding IS NULL AS no_vector FROM thoughts WHERE id = ${id}::uuid`;
  assert(/edited/.test(edited.content) && edited.no_vector === true, "…the new text is in the row, with no vector");
  const [editAudit] = await sql`SELECT actor_context FROM thought_audit WHERE thought_id = ${id}::uuid AND action = 'update' ORDER BY created_at DESC LIMIT 1`;
  assert(editAudit.actor_context?.egress?.embeddings?.allowed === false, "…and its audit row carries the refusal too");
  const patch = await call(GATED_KEY, "update_thought", { id, metadata_patch: { pinned: true } });
  assert(!patch.isError && /metadata merged/.test(patch.text) && !/WITHOUT a vector/.test(patch.text), "a metadata-only edit sends nothing and is not judged");
  assert(seen.length === before, `zero requests through all of it (${seen.length - before})`);

  // The key an allow term names: the capture reaches the stub and lands with its vector, the decision recorded as allowed.
  const open = await call(OPEN_KEY, "capture_thought", { content: "open-thought-marker: a note that may leave" });
  assert(!open.isError && /Captured as idea/.test(open.text) && !/WITHOUT a vector/.test(open.text), `the allowed key's capture is tagged and vectored (${open.text.split("\n")[0]})`);
  assert(seen.length === before + 2 && seen.slice(-2).some((s) => s.path.endsWith("/embeddings")) && seen.slice(-2).some((s) => s.path.endsWith("/chat/completions")), `…two requests, one per call (${seen.length - before})`);
  const openId = /id ([0-9a-f-]{36})/.exec(open.text)![1];
  const [openRow] = await sql`SELECT embedding IS NOT NULL AS has, embedding_model FROM thoughts WHERE id = ${openId}::uuid`;
  assert(openRow.has === true && openRow.embedding_model === EMB_MODEL, "…with the vector and its label on the row");
  const [openAudit] = await sql`SELECT actor_context FROM thought_audit WHERE thought_id = ${openId}::uuid AND action = 'capture'`;
  const openRec = openAudit.actor_context?.egress;
  assert(openRec?.embeddings?.allowed === true && openRec.embeddings.rule === "allow-term" && openRec.chat?.allowed === true && openRec.embeddings.to === HOST,
         `the audit row records that the text LEFT, and by which rule (${JSON.stringify(openRec)})`);
  // The stub's vectors are a function of length, not meaning, so what the
  // search returns is not the point; that it embedded the query is.
  const openSearch = await call(OPEN_KEY, "search_thoughts", { query: "a note that may leave", threshold: 0 });
  assert(!openSearch.isError && !/^Refused/.test(openSearch.text) && seen.length === before + 3 && seen[seen.length - 1].path.endsWith("/embeddings"),
         `…and the allowed key searches: one embeddings request, no refusal (${seen.length - before})`);

  // A RE-CAPTURE of that tagged, vectored text under the refused key: the row
  // keeps its tags and its vector (upsert_thought merges and coalesces), the
  // reply says so rather than "no vector", nothing is sent (first review
  // pass: a placeholder topic in the refusal shape had replaced the real tags).
  const n = seen.length;
  const recap = await call(GATED_KEY, "capture_thought", { content: "open-thought-marker: a note that may leave" });
  assert(!recap.isError && /id ([0-9a-f-]{36})/.exec(recap.text)![1] === openId && seen.length === n, `the re-capture lands on the same id at zero requests (${seen.length - n})`);
  assert(/Note: the embedding call for this capture was not made — OB1_EGRESS_POLICY=deny/.test(recap.text) && /keeps the vector it had/.test(recap.text) && !/WITHOUT a vector/.test(recap.text),
         "…the reply says the existing vector stands, not that there is none");
  assert(/Note: the tagging call for this capture was not made/.test(recap.text) && /keeps its tags/.test(recap.text), "…and that the existing tags stand");
  const [kept] = await sql`SELECT metadata, embedding IS NOT NULL AS has FROM thoughts WHERE id = ${openId}::uuid`;
  assert(kept.has === true && kept.metadata.type === "idea" && Array.isArray(kept.metadata.topics) && kept.metadata.topics[0] === "stubbed" && kept.metadata.metadata_extraction_failed === "egress_denied",
         `the row keeps its vector, type and topics; only the refusal marker was merged in (${JSON.stringify(kept.metadata)})`);

  // An EDIT is judged on the row's own metadata, not the capture's bare
  // source: the type:idea term lets the refused key edit the tagged row (one
  // request), while its own untyped row stays refused (first review pass).
  const m = seen.length;
  const typedEdit = await call(GATED_KEY, "update_thought", { id: openId, content: "open-thought-marker: a note that may leave, edited by the gated key" });
  assert(!typedEdit.isError && /content re-embedded/.test(typedEdit.text) && seen.length === m + 1 && seen[m].path.endsWith("/embeddings"),
         `an edit of a row a type: term names is allowed on the row's metadata — one embeddings request (${seen.length - m})`);
  const untypedEdit = await call(GATED_KEY, "update_thought", { id, content: "gated-thought-marker: edited again, still must not leave" });
  assert(!untypedEdit.isError && /content saved without a vector/.test(untypedEdit.text) && seen.length === m + 1, "…while an edit of the untyped row is still refused at zero requests");
}

await sql.close();
server.stop();
stub.stop();
report();
