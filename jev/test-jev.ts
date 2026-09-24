#!/usr/bin/env bun
/**
 * test-jev.ts — the typed-decision tier, service and client (SMD-2050).
 *
 * [1] holds the contract's one validation rule (jev-contract.ts), which the
 * client and the service both read. [2]–[4] hold the Verdict port against
 * its reference engine's own strings and rules — the prompt layout, the
 * per-K-else-global temperature, the truncation that keeps [SEP], the
 * binary result's P(true | sufficient) — since a prompt one marker off gives
 * a probability the calibrator was never fitted to. [5] holds the HTTP
 * handler over a fake engine: every status the contract names, and one
 * request at a time. [6] holds the verified fetch against a stub hub: a file
 * that does not hash to its pin is refused and nothing of it kept. [7]–[8]
 * hold the client against a stub tier that counts requests: a refused
 * decision is a ProviderError of kind `egress` and the stub sees NOTHING; a
 * batch splits and keeps order; a bad decision at index 66 sends nothing; an
 * answer that is not the contract's is refused by kind. [9] runs the real
 * model when JEV_TEST_MODEL_DIR names a directory holding the pinned files
 * (`bun serve.ts --fetch-only` puts them in ~/.cache/ob1-jev/<revision>) and
 * skips otherwise; no model is needed for [1]–[8].
 *
 * Mutants, each run and each killed (2026-09-23): drop the gate from
 * jevDecideMany and [7] fails (the stub sees the decision); derive no marker
 * content from the decisions and [7]'s #phi case fails; send a batch before
 * validating the next and [8]'s index-66 case fails; drop the temperature and
 * [4] fails; ignore the per-K temperature and [3] and [5] fail; truncate
 * without keeping the closing id and [3] and [5] fail; drop the handler's
 * queue and [5b]'s concurrency case fails; accept any model in the answer and
 * [8] fails; keep a download that hashes wrong and [6] fails; drop the noul
 * label's "not" and [2] fails.
 *
 *   bun test-jev.ts
 */

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAssert } from "../db/test-support.ts";
import { INSUFFICIENT_EVIDENCE, JEV_CONTRACT, JEV_MAX_BATCH, JEV_MAX_OPTIONS, JEV_MAX_TEXT, jevRequestProblem, type JevDecision, type JevResponse } from "../server-portable/jev-contract.ts";
import { jevAnswerProblem, jevChoose, jevDecide, jevDecideMany, jevInfo, resolveJevConfig } from "../server-portable/jev.ts";
import { ProviderError } from "../server-portable/embed.ts";
import { ensureModel, sha256File, type ModelPins } from "./fetch-model.ts";
import { createHandler, MAX_BODY_BYTES } from "./serve.ts";
import { buildPrompt, createEngine, createVerdictEngine, INFO, MAX_TOKENS, MODEL_INFO, resultFrom, softmax, temperatureFor, truncate, VERDICT, type Engine } from "./verdict.ts";

const { assert, skip, report } = createAssert();
const section = (s: string) => console.log(`\n${s}`);
const binary = (i = 0): Extract<JevDecision, { kind: "binary" }> => ({ id: `d${i}`, kind: "binary", proposition: `item ${i} is even`, context: `The number is ${i}.` });

// ── [1] The contract's validation rule ──────────────────────────────────────
section("[1] jevRequestProblem — one rule for the client and the service");
{
  const choice = (options: unknown[]) => ({ decisions: [{ kind: "choice", question: "q", context: "c", options }] });
  assert(jevRequestProblem({ decisions: [binary()] }) === null, "a binary decision is well formed");
  assert(jevRequestProblem(choice([{ id: "a", description: "A" }])) === null, "a one-option choice is well formed");
  const bad: [unknown, RegExp, string][] = [
    [null, /not a JSON object/, "null"],
    [{ decisions: [] }, /non-empty array/, "no decisions"],
    [{ decisions: Array.from({ length: JEV_MAX_BATCH + 1 }, (_, i) => binary(i)) }, new RegExp(`at most ${JEV_MAX_BATCH}`), "one past the batch limit"],
    [{ model: "", decisions: [binary()] }, /`model`/, "an empty model"],
    [{ decisions: [{ ...binary(), kind: "score" }] }, /"binary" or "choice"/, "an unknown kind"],
    [{ decisions: [{ ...binary(), id: 7 }] }, /`id`/, "a numeric id"],
    [{ decisions: [{ ...binary(), context: "  " }] }, /`context`/, "a blank context"],
    [{ decisions: [{ ...binary(), proposition: "x".repeat(JEV_MAX_TEXT + 1) }] }, /proposition/, "a proposition over the text limit"],
    [choice([]), /1 to 24 options/, "a choice with no options"],
    [choice(Array.from({ length: JEV_MAX_OPTIONS + 1 }, (_, i) => ({ id: `o${i}`, description: "d" }))), /1 to 24 options/, "a choice with 25 options"],
    [choice([{ id: INSUFFICIENT_EVIDENCE, description: "d" }]), /tier's own option/, "an option that takes the tier's own id"],
    [choice([{ id: "a", description: "A" }, { id: "a", description: "B" }]), /given twice/, "a duplicated option id"],
    [choice([{ id: "a" }]), /`description`/, "an option with no description"],
  ];
  for (const [body, want, what] of bad) {
    const got = jevRequestProblem(body);
    assert(got !== null && want.test(got), `${what} is refused by name (${got})`);
  }
  const at = jevRequestProblem({ decisions: [binary(0), binary(1), { ...binary(2), context: "" }] });
  assert(at?.startsWith("decision 2:") === true, `the problem names the decision's index (${at})`);
}

// ── [2] The prompt, as the reference engine writes it ───────────────────────
section("[2] buildPrompt — core/formatting.py's strings, byte for byte");
{
  const b = buildPrompt({ kind: "binary", proposition: "P", context: "C" });
  assert(b.prompt === "<<LABEL>>true: P<<LABEL>>false: not P<<LABEL>>insufficient evidence<<SEP>>Context:\nC\n\nEvaluate proposition: P", `binary is the noul layout (${JSON.stringify(b.prompt)})`);
  assert(JSON.stringify(b.ids) === JSON.stringify(["true", "false", INSUFFICIENT_EVIDENCE]), "binary option ids: true, false, the tier's own");
  const c = buildPrompt({ kind: "choice", question: "Q", context: "C", options: [{ id: "x", description: "an x" }, { id: "y", description: "a y" }] });
  assert(c.prompt === "<<LABEL>>It is an x<<LABEL>>It is a y<<LABEL>>insufficient evidence<<SEP>>Question: Q\n\nContext:\nC", `choice is the NLI-framed layout (${JSON.stringify(c.prompt)})`);
  assert(JSON.stringify(c.ids) === JSON.stringify(["x", "y", INSUFFICIENT_EVIDENCE]), "choice ids in option order, the tier's own last");
}

// ── [3] Calibration and truncation ──────────────────────────────────────────
section("[3] temperatureFor, softmax, truncate — the engine's rules");
{
  const cal = { temperature: 2.8039, per_k: { "3": 5.0069, "25": 1.5144 } };
  assert(temperatureFor(cal, 3) === 5.0069, "K with a fitted temperature uses it");
  assert(temperatureFor(cal, 8) === 2.8039, "K without one uses the global temperature");
  let threw = false;
  try { temperatureFor({ temperature: 0 }, 2); } catch { threw = true; }
  assert(threw, "a calibrator with no positive temperature is refused");
  const p = softmax([1000, 999, 0]);
  assert(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12 && p.every(Number.isFinite), "softmax sums to 1 and survives large logits");
  const long = Array.from({ length: 600 }, (_, i) => i);
  const cut = truncate(long, MAX_TOKENS);
  assert(cut.truncated && cut.ids.length === MAX_TOKENS && cut.ids.at(-1) === 599 && cut.ids[MAX_TOKENS - 2] === MAX_TOKENS - 2, "a long input is cut to 512 keeping its closing id");
  const short = truncate([1, 2, 3], MAX_TOKENS);
  assert(!short.truncated && short.ids.length === 3, "a short input is left alone");
}

// ── [4] A result from logits ────────────────────────────────────────────────
section("[4] resultFrom — probabilities, abstention, P(true | sufficient)");
{
  const d = binary();
  const r = resultFrom(d, ["true", "false", INSUFFICIENT_EVIDENCE], [2, 1, 0], 1, 40, false);
  const pt = r.probabilities.true, pf = r.probabilities.false;
  assert(r.selected === "true" && !r.abstained && r.id === "d0", "the top option is selected and the id comes back");
  assert(Math.abs((r.p_true ?? -1) - pt / (pt + pf)) < 1e-12, "p_true is true's share of true + false");
  const a = resultFrom(d, ["true", "false", INSUFFICIENT_EVIDENCE], [0, 0, 3], 1, 40, false);
  assert(a.abstained && a.selected === INSUFFICIENT_EVIDENCE && a.p_insufficient > 0.9, "the tier's own option on top is an abstention");
  const hot = resultFrom(d, ["true", "false", INSUFFICIENT_EVIDENCE], [2, 1, 0], 5, 40, false);
  assert(hot.probabilities.true < r.probabilities.true && hot.temperature === 5, "the temperature flattens, and is reported");
  let threw = false;
  try { resultFrom(d, ["true", "false", INSUFFICIENT_EVIDENCE], [1, Number.NaN, 0], 1, 1, false); } catch { threw = true; }
  assert(threw, "a non-finite logit is refused, not softmaxed");
  const c = resultFrom({ kind: "choice", question: "q", context: "c", options: [{ id: "a", description: "A" }] }, ["a", INSUFFICIENT_EVIDENCE], [1, 0], 1, 9, true);
  assert(c.p_true === undefined && c.truncated && c.tokens === 9, "a choice carries no p_true; truncation and tokens are reported");
}

// ── [5] The engine over a fake tokenizer and runner ─────────────────────────
section("[5] createEngine — what reaches the runner");
{
  const seen: { ids: bigint[]; mask: bigint[] }[] = [];
  const encoder = { encode: (t: string) => ({ ids: Array.from({ length: t.length }, (_, i) => i + 1) }) };
  const engine = createEngine(encoder, async (ids, mask) => {
    seen.push({ ids: Array.from(ids), mask: Array.from(mask) });
    return new Float32Array(25).map((_, i) => (i === 0 ? 3 : 0));
  }, { temperature: 2, per_k: { "3": 4 } });
  const [r] = await engine.decide([{ kind: "binary", proposition: "p", context: "c".repeat(2000) }]);
  assert(seen.length === 1 && seen[0].ids.length === MAX_TOKENS && seen[0].ids.at(-1) === BigInt(buildPrompt({ kind: "binary", proposition: "p", context: "c".repeat(2000) }).prompt.length), "one run, cut to 512, the closing id kept");
  assert(seen[0].mask.every((m) => m === 1n), "the attention mask is all ones at batch 1");
  assert(r.truncated && r.temperature === 4 && r.logits.length === 3, "K=3's temperature applied to the first 3 of 25 slots");
  const short = createEngine(encoder, async () => new Float32Array(2), { temperature: 1 });
  let msg = "";
  try { await short.decide([binary()]); } catch (e) { msg = (e as Error).message; }
  assert(/2 logits.*3 options/.test(msg), `a runner returning too few logits fails by name (${msg})`);
  assert(engine.info === INFO && INFO.model.weights_sha256 === VERDICT.files["model.onnx"].sha256, "the engine reports the pinned model");
}

// ── [5b] The HTTP handler over a fake engine ────────────────────────────────
section("[5b] createHandler — the contract's statuses, one request at a time");
{
  let active = 0, overlapped = false, fail = false;
  const fake: Engine = {
    info: INFO,
    async decide(ds) {
      active++;
      if (active > 1) overlapped = true;
      await Bun.sleep(20);
      active--;
      if (fail) throw new Error("boom");
      return ds.map((d) => resultFrom(d, d.kind === "binary" ? ["true", "false", INSUFFICIENT_EVIDENCE] : [...d.options.map((o) => o.id), INSUFFICIENT_EVIDENCE], d.kind === "binary" ? [1, 0, 0] : [...d.options.map(() => 0), 1], 1, 5, false));
    },
  };
  const h = createHandler(fake);
  const call = (path: string, init?: RequestInit) => h(new Request(`http://t${path}`, init));
  const post = (body: unknown) => call("/decide", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  assert((await (await call("/health")).text()) === "ok", "GET /health answers ok");
  assert(((await (await call("/info")).json()) as typeof INFO).contract === JEV_CONTRACT, "GET /info is the contract's JevInfo");
  const m = await call("/decide");
  assert(m.status === 405 && m.headers.get("Allow") === "POST", "GET /decide is 405 with Allow: POST");
  assert((await call("/nope")).status === 404, "an unknown path is 404");
  assert((await post("{not json")).status === 400, "a body that is not JSON is 400");
  const bad = await post({ decisions: [] });
  assert(bad.status === 400 && /non-empty/.test(((await bad.json()) as { error: string }).error), "a malformed request is 400 with the rule's words");
  assert((await post({ model: "other", decisions: [binary()] })).status === 409, "a request for another model is 409");
  assert((await call("/decide", { method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" })).status === 413, "a body declared over the limit is 413 before it is read");
  const ok = await post({ model: MODEL_INFO.name, decisions: [binary(1), binary(2)] });
  const body = (await ok.json()) as JevResponse;
  assert(ok.status === 200 && body.contract === JEV_CONTRACT && body.results.length === 2 && jevAnswerProblem({ model: undefined }, [binary(1), binary(2)], body) === null, "a good request is 200 with an answer the client accepts");
  await Promise.all([post({ decisions: [binary()] }), post({ decisions: [binary()] }), post({ decisions: [binary()] })]);
  assert(!overlapped, "three concurrent requests never run the engine at once");
  fail = true;
  const boom = await post({ decisions: [binary()] });
  assert(boom.status === 500 && /boom/.test(((await boom.json()) as { error: string }).error), "an engine failure is 500 naming it");
  fail = false;
  assert((await post({ decisions: [binary()] })).status === 200, "the queue survives a failed request");
}

// ── [6] The verified fetch ──────────────────────────────────────────────────
section("[6] ensureModel — fetch the pinned bytes or nothing");
{
  const good = new TextEncoder().encode("the pinned bytes\n");
  const sha = new Bun.CryptoHasher("sha256").update(good).digest("hex");
  let served = good, hits = 0;
  const hub = Bun.serve({ port: 0, fetch: (req) => { hits++; return new URL(req.url).pathname.endsWith("/m.bin") ? new Response(served) : new Response("no", { status: 404 }); } });
  const pins: ModelPins = { repo: "o/r", revision: "abc", files: { "m.bin": { bytes: good.length, sha256: sha } } };
  const dir = await mkdtemp(`${tmpdir()}/jev-test-`);
  const base = `http://127.0.0.1:${hub.port}`;
  const first = await ensureModel(dir, { pins, hub: base });
  assert(first.fetched.join() === "m.bin" && (await sha256File(`${dir}/m.bin`)) === sha, "a missing file is fetched and verified");
  hits = 0;
  const again = await ensureModel(dir, { pins, hub: base });
  assert(again.fetched.length === 0 && again.verified.join() === "m.bin" && hits === 0, "a verified file is not fetched again");
  await writeFile(`${dir}/m.bin`, "tampered");
  let msg = "";
  try { await ensureModel(dir, { pins, hub: base, fetch: false }); } catch (e) { msg = (e as Error).message; }
  assert(/not the pinned file, and fetching is off/.test(msg) && (await Bun.file(`${dir}/m.bin`).text()) === "tampered", "--no-fetch refuses a wrong file and leaves it where it was");
  const replaced = await ensureModel(dir, { pins, hub: base });
  assert(replaced.fetched.join() === "m.bin" && (await sha256File(`${dir}/m.bin`)) === sha, "a present wrong file is replaced by the pinned one");
  await rm(`${dir}/m.bin`);
  served = new TextEncoder().encode("someone else's bytes");
  msg = "";
  try { await ensureModel(dir, { pins, hub: base }); } catch (e) { msg = (e as Error).message; }
  assert(/refused, nothing kept/.test(msg) && (await readdir(dir)).length === 0, `a download that does not hash to the pin is refused and nothing of it kept (${msg.slice(0, 80)}…)`);
  msg = "";
  try { await ensureModel(dir, { pins: { ...pins, files: { "gone.bin": pins.files["m.bin"] } }, hub: base }); } catch (e) { msg = (e as Error).message; }
  assert(/gone\.bin.*answered 404/.test(msg), "a fetch that fails names the file and the status");
  hub.stop(true);
  await rm(dir, { recursive: true, force: true });
}

// ── [7]–[8] The client against a stub tier ──────────────────────────────────
type Stub = { requests: { path: string; body: any }[]; answer: (body: any) => Response | Promise<Response> };
const stub: Stub = { requests: [], answer: () => new Response("unset", { status: 500 }) };
const tier = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json() : undefined;
    stub.requests.push({ path, body });
    if (path === "/info") return Response.json(INFO);
    return stub.answer(body);
  },
});
const BASE = `http://127.0.0.1:${tier.port}`;
/** What a correct tier answers: the fake engine's results in the contract's envelope. */
const honest = async (body: { decisions: JevDecision[] }) => {
  const results = body.decisions.map((d) => resultFrom(d, d.kind === "binary" ? ["true", "false", INSUFFICIENT_EVIDENCE] : [...d.options.map((o) => o.id), INSUFFICIENT_EVIDENCE], d.kind === "binary" ? [2, 0, 0] : [...d.options.map((_, i) => (i === 0 ? 2 : 0)), 0], 1, 5, false));
  return Response.json({ contract: JEV_CONTRACT, model: MODEL_INFO, results, ms: 1 } satisfies JevResponse);
};
const subj = { kind: "decision" as const, actor: "spike" };

section("[7] the client's egress gate — refused decisions send nothing");
{
  assert(resolveJevConfig({}) === null && resolveJevConfig({ OB1_JEV_BASE_URL: "  / " }) === null, "unset (or slashes alone) turns the tier off");
  const local = resolveJevConfig({ OB1_JEV_BASE_URL: `${BASE}/`, OB1_JEV_LOCAL: "1" })!;
  assert(local.endpoint.base === BASE && local.endpoint.local && local.endpoint.declaredBy === "OB1_JEV_LOCAL", "the base is trimmed and OB1_JEV_LOCAL declares it");
  stub.answer = honest;
  stub.requests = [];
  const d = await jevDecide(local, { proposition: "p", context: "c" }, subj);
  assert(stub.requests.length === 1 && d.p !== null && d.p > 0.5 && d.model.name === MODEL_INFO.name, "a declared-local decision is sent and answered with its model");
  const remote = resolveJevConfig({ OB1_JEV_BASE_URL: BASE })!;
  assert(!remote.endpoint.local, "a loopback address is not local until declared");
  stub.requests = [];
  let err: unknown;
  try { await jevDecide(remote, { proposition: "p", context: "c" }, subj); } catch (e) { err = e; }
  assert(err instanceof ProviderError && err.kind === "egress" && stub.requests.length === 0, "under the default deny an undeclared tier is refused and the stub sees nothing");
  const allowed = resolveJevConfig({ OB1_JEV_BASE_URL: BASE, OB1_EGRESS_ALLOW: "actor:spike" })!;
  await jevDecide(allowed, { proposition: "p", context: "c" }, subj);
  assert(stub.requests.length === 1, "an allow term naming the actor lets the decision through");
  const marked = resolveJevConfig({ OB1_JEV_BASE_URL: BASE, OB1_EGRESS_POLICY: "allow", OB1_EGRESS_DENY: "marker:#phi" })!;
  stub.requests = [];
  err = undefined;
  try { await jevChoose(marked, { question: "q", options: [{ id: "a", description: "A" }], context: "a note tagged #phi" }, subj); } catch (e) { err = e; }
  assert(err instanceof ProviderError && err.kind === "egress" && stub.requests.length === 0, "a marker in the decision's own text is read when the caller gave no content");
}

section("[8] the client's batches and answers");
{
  const local = resolveJevConfig({ OB1_JEV_BASE_URL: BASE, OB1_JEV_LOCAL: "1" })!;
  stub.answer = honest;
  stub.requests = [];
  const many = Array.from({ length: 70 }, (_, i) => binary(i));
  const m = await jevDecideMany(local, many, subj);
  assert(stub.requests.length === 2 && stub.requests[0].body.decisions.length === JEV_MAX_BATCH && stub.requests[1].body.decisions.length === 6, "70 decisions go as 64 + 6");
  assert(m.results.length === 70 && m.results.every((r, i) => r.id === `d${i}`), "results come back in order");
  stub.requests = [];
  let msg = "";
  try { await jevDecideMany(local, [...many.slice(0, 66), { ...binary(66), proposition: "" }], subj); } catch (e) { msg = (e as Error).message; }
  assert(/decision 66/.test(msg) && stub.requests.length === 0, `a bad decision at index 66 is named and nothing is sent (${msg.slice(0, 60)}…)`);
  const expecting = resolveJevConfig({ OB1_JEV_BASE_URL: BASE, OB1_JEV_LOCAL: "1", OB1_JEV_MODEL: "semif" })!;
  stub.requests = [];
  await jevDecide(expecting, { proposition: "p", context: "c" }, subj).catch(() => {});
  assert(stub.requests[0]?.body.model === "semif", "OB1_JEV_MODEL rides the request, so a tier serving another can say 409");
  let err: any;
  try { await jevDecide(expecting, { proposition: "p", context: "c" }, subj); } catch (e) { err = e; }
  assert(err?.kind === "body" && /OB1_JEV_MODEL expects semif/.test(err.message), "an answer from another model is refused even from a tier that did not check");
  const bodies: [string, (b: any) => unknown][] = [
    ["another contract", (b) => ({ contract: "other/9", model: MODEL_INFO, results: [], ms: 0 })],
    ["too few results", (b) => ({ contract: JEV_CONTRACT, model: MODEL_INFO, results: [], ms: 0 })],
    ["probabilities that do not sum to 1", (b) => ({ contract: JEV_CONTRACT, model: MODEL_INFO, ms: 0, results: [{ kind: "binary", probabilities: { true: 0.9, false: 0.9, [INSUFFICIENT_EVIDENCE]: 0 }, selected: "true", abstained: false, p_insufficient: 0, p_true: 0.5, logits: [], temperature: 1, tokens: 1, truncated: false }] })],
    ["another decision's options", (b) => ({ contract: JEV_CONTRACT, model: MODEL_INFO, ms: 0, results: [{ kind: "binary", probabilities: { yes: 1, [INSUFFICIENT_EVIDENCE]: 0 }, selected: "yes", abstained: false, p_insufficient: 0, logits: [], temperature: 1, tokens: 1, truncated: false }] })],
  ];
  for (const [what, make] of bodies) {
    stub.answer = (b) => Response.json(make(b));
    err = undefined;
    try { await jevDecide(local, { proposition: "p", context: "c" }, subj); } catch (e) { err = e; }
    assert(err instanceof ProviderError && err.kind === "body", `an answer with ${what} is a body error (${err?.message?.slice(0, 70)})`);
  }
  stub.answer = () => new Response("not json", { status: 200 });
  err = undefined;
  try { await jevDecide(local, { proposition: "p", context: "c" }, subj); } catch (e) { err = e; }
  assert(err?.kind === "body", "a 200 that is not JSON is a body error");
  stub.answer = () => Response.json({ error: "this service serves x" }, { status: 409 });
  err = undefined;
  try { await jevDecide(local, { proposition: "p", context: "c" }, subj); } catch (e) { err = e; }
  assert(err?.kind === "http" && err.status === 409, "a refusal keeps its status");
  stub.answer = () => new Promise(() => {});
  err = undefined;
  const t0 = performance.now();
  try { await jevDecide(local, { proposition: "p", context: "c" }, subj, { timeoutMs: 200 }); } catch (e) { err = e; }
  assert(err?.kind === "timeout" && performance.now() - t0 < 2000, "a tier that never answers is a timeout at the deadline");
  const info = await jevInfo(local);
  assert(info.model.revision === VERDICT.revision, "jevInfo reads the tier's pins");
}
tier.stop(true);

// ── [9] The real model, when it is here ─────────────────────────────────────
section("[9] Verdict v1.4 itself (JEV_TEST_MODEL_DIR)");
const dir = process.env.JEV_TEST_MODEL_DIR?.trim();
if (!dir) {
  skip("the demo presets resolve as the reference engine resolves them", "JEV_TEST_MODEL_DIR is unset — `bun serve.ts --fetch-only`, then point it at ~/.cache/ob1-jev/<revision>");
} else {
  await ensureModel(dir, { fetch: false });
  const engine = await createVerdictEngine(dir, { threads: 4 });
  const q = "What is the primary customer inquiry or banking request?";
  const card = [
    { id: "card_arrival", description: "Inquire about whether a newly ordered debit or credit card has arrived or when it will arrive in the mail" },
    { id: "lost_or_stolen_card", description: "Report a physically lost, stolen, or misplaced card requiring immediate permanent block or cancellation" },
    { id: "compromised_card", description: "Report suspected unauthorized card cloning, skimmed magnetic stripe, or fraudulent card transactions" },
  ];
  const [arrival, solar] = await engine.decide([
    { kind: "choice", question: q, options: card, context: "I ordered my new card two weeks ago but haven't received it in the mail yet. Can you check delivery?" },
    { kind: "choice", question: q, options: card, context: "How do I install solar panels on my roof?" },
  ]);
  assert(arrival.selected === "card_arrival" && arrival.logits[0] > 5, `a card-arrival note selects card_arrival (logit ${arrival.logits[0].toFixed(2)})`);
  assert(solar.abstained, `an out-of-scope note abstains (p_insufficient ${solar.p_insufficient.toFixed(3)})`);
}

report();
