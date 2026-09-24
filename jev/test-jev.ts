#!/usr/bin/env bun
/**
 * test-jev.ts — the typed-decision tier, service and client (SMD-2050).
 *
 * [1] holds the contract's one validation rule (jev-contract.ts), which the
 * client and the service both read. [2]–[4] hold the Verdict port against
 * its reference engine's own strings and rules — the prompt layout, the
 * per-K-else-global temperature, the truncation that keeps [SEP], the
 * binary result's P(true | sufficient) — since a prompt one marker off gives
 * a probability the calibrator was never fitted to — and [2] pins the rules'
 * fingerprint the provenance carries. [5] holds the engine over a fake
 * tokenizer and runner, and its refusals; [5b] the HTTP handler over a fake
 * engine: every status the contract names, the caps, one request at a time. [6] holds the verified fetch against a stub hub: a file
 * that does not hash to its pin is refused and nothing of it kept. [7]–[8]
 * hold the client against a stub tier that counts requests: a refused
 * decision is a ProviderError of kind `egress` and the stub sees NOTHING; a
 * batch splits and keeps order; a bad decision at index 66 sends nothing; an
 * answer that is not the contract's is refused by kind. [9] runs the real
 * model when JEV_TEST_MODEL_DIR names a directory holding the pinned files
 * (`bun serve.ts --fetch-only` puts them in ~/.cache/ob1-jev/<revision>) and
 * skips otherwise; [10], likewise, reproduces the model's published receipt
 * row by row (conformance.ts) and holds the served prompt at its measured
 * numbers; [11] reproduces JevBench's two published Verdict rows task by task
 * on its 231 public tasks (jevbench.ts) and holds buildPrompt to the v1.4
 * row's prompt. No model is needed for [1]–[8].
 *
 * Mutants, each run and each killed (2026-09-23): drop the gate from
 * jevDecideMany and [7] fails (the stub sees the decision); derive no marker
 * content from the decisions and [7]'s #phi case fails; send a batch before
 * validating the next and [8]'s index-66 case fails; drop the temperature and
 * [4] fails; ignore the per-K temperature and [3] and [5] fail; truncate
 * without keeping the closing id and [3] and [5] fail; drop the handler's
 * queue and [5b]'s concurrency case fails; accept any model in the answer and
 * [8] fails; keep a download that hashes wrong and [6] fails; drop the noul
 * label's "not" and [2] fails; a tokenizer that loses [CLS] — every hash still
 * passes — and all six of [10]'s assertions fail (982 of 1,000 rows agree).
 * First review pass, each run and killed: no marker check ([5]); no streaming
 * cap, no skip for a caller gone, no 422 mapping, HEAD refused ([5b]); pack by
 * count only, the caller's content replacing what is sent, no partial-answer
 * note ([7]–[8]); one shared part name, no stale-part removal ([6]).
 * Second review pass, each run and killed: allow markers read from the joined
 * text, one gate for the whole list ([7]); no head check on a cut ([5]); no id
 * cap ([1]); a failed download keeping its part ([6]); the caller's own
 * timeout read as ours ([8]). Fifth review pass, each run and killed: the
 * engine ignoring the caller's signal ([5b]); a flat deadline again ([8]); a
 * hub that never connects saying only Bun's words ([6]). Seventh review
 * pass: jevInfo checking the contract's name only, the gate reading
 * decisions before they are validated ([7]–[8]).
 *
 *   bun test-jev.ts
 */

import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAssert } from "../db/test-support.ts";
import { INSUFFICIENT_EVIDENCE, JEV_CONTRACT, JEV_MAX_BATCH, JEV_MAX_BODY_BYTES, JEV_MAX_OPTIONS, JEV_MAX_TEXT, jevRequestProblem, type JevDecision, type JevResponse } from "../server-portable/jev-contract.ts";
import { jevAnswerProblem, jevChoose, jevDecide, jevDecideMany, jevInfo, requestTimeoutMs, resolveJevConfig } from "../server-portable/jev.ts";
import { ProviderError } from "../server-portable/embed.ts";
import { ensureModel, sha256File, STALE_PART_MS, type ModelPins } from "./fetch-model.ts";
import { createHandler } from "./serve.ts";
import { buildPrompt, createEngine, createVerdictEngine, DecisionRefused, INFO, MARKER_IDS, MAX_TOKENS, MODEL_INFO, resultFrom, softmax, temperatureFor, truncate, VERDICT, type Engine } from "./verdict.ts";

const { assert, skip, report } = createAssert();
const section = (s: string) => console.log(`\n${s}`);
/** As the model's tokenizer does: [CLS], each marker one id, one id per other character, [SEP] (50282) last. */
const markerEncoder = { encode: (t: string) => ({ ids: [50281, ...t.split(/(<<LABEL>>|<<SEP>>)/).flatMap((part) => (part === "<<LABEL>>" ? [MARKER_IDS.label] : part === "<<SEP>>" ? [MARKER_IDS.sep] : Array.from(part, (ch) => ch.charCodeAt(0)))), 50282] }) };
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
    [{ decisions: [{ ...binary(), id: "i".repeat(JEV_MAX_TEXT + 1) }] }, /`id`.*at most/, "an id over the text limit (it would outgrow the body cap)"],
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
  // The rules the provenance names: a change to buildPrompt, the budget, the
  // cut or the temperature rule changes this, and every answer's `rules` with it.
  assert(MODEL_INFO.rules === "openjev-engine@00b5ee96#d1c5fb07e514", `the prompt rules' fingerprint is the pinned one (${MODEL_INFO.rules}) — a change here is a change to what reproduces a probability: update the pin and jev/README.md's provenance note together`);
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
  const encoder = markerEncoder;
  const engine = createEngine(encoder, async (ids, mask) => {
    seen.push({ ids: Array.from(ids), mask: Array.from(mask) });
    return new Float32Array(25).map((_, i) => (i === 0 ? 3 : 0));
  }, { temperature: 2, per_k: { "3": 4 } });
  const [r] = await engine.decide([{ kind: "binary", proposition: "p", context: "c".repeat(2000) }]);
  assert(seen.length === 1 && seen[0].ids.length === MAX_TOKENS && seen[0].ids.at(-1) === 50282n, "one run, cut to 512, the closing id kept");
  assert(seen[0].mask.every((m) => m === 1n), "the attention mask is all ones at batch 1");
  assert(r.truncated && r.temperature === 4 && r.logits.length === 3, "K=3's temperature applied to the first 3 of 25 slots");
  const short = createEngine(encoder, async () => new Float32Array(2), { temperature: 1 });
  let msg = "";
  try { await short.decide([binary()]); } catch (e) { msg = (e as Error).message; }
  assert(/2 logits.*3 options/.test(msg), `a runner returning too few logits fails by name (${msg})`);
  assert(engine.info === INFO && INFO.model.weights_sha256 === VERDICT.files["model.onnx"].sha256, "the engine reports the pinned model");

  // A marker in the caller's text would add a slot and shift every option's
  // probability onto its neighbour: refused, naming the decision, before any
  // forward pass — the decisions ahead of it are not computed either.
  seen.length = 0;
  let refused: unknown;
  try { await engine.decide([binary(0), { kind: "binary", proposition: "p", context: "a note about <<LABEL>> markers" }]); } catch (e) { refused = e; }
  assert(refused instanceof DecisionRefused && refused.index === 1 && /own markers/.test(refused.message) && seen.length === 0, `a marker in a context is refused by index, before any run (${(refused as Error)?.message?.slice(0, 60)})`);
  refused = undefined;
  try { await engine.decide([{ kind: "choice", question: "q", context: "c", options: [{ id: "a", description: "A<<SEP>>" }] }]); } catch (e) { refused = e; }
  assert(refused instanceof DecisionRefused, "…and in an option description");
  // Labels past the budget: the model would read none of the question or context.
  refused = undefined;
  const long = Array.from({ length: 24 }, (_, i) => ({ id: `o${i}`, description: "d".repeat(40) }));
  try { await engine.decide([{ kind: "choice", question: "q", context: "c", options: long }]); } catch (e) { refused = e; }
  assert(refused instanceof DecisionRefused && /read \d+ of its 25 labels/.test(refused.message), `options whose labels overrun 512 tokens are refused, not answered (${(refused as Error)?.message?.slice(0, 70)})`);
  // The separator at token 506 of 512: every label kept, four tokens of text —
  // not even the "Context:" head. Refused, though nothing marker-shaped was cut.
  refused = undefined;
  const edge = { kind: "binary" as const, proposition: "p".repeat(232), context: "c".repeat(100) };
  const edgeIds = encoder.encode(buildPrompt(edge).prompt).ids;
  try { await engine.decide([edge]); } catch (e) { refused = e; }
  assert(edgeIds.indexOf(MARKER_IDS.sep) === 506 && refused instanceof DecisionRefused && /read 3 of its 3 labels \(the options and the tier.s own\) and 4 tokens/.test(refused.message),
         `a separator that lands at 506 of 512 leaves no question or context to read: refused (${(refused as Error)?.message?.slice(0, 110)})`);
  const [ctxCut] = await engine.decide([{ kind: "choice", question: "q", context: "c".repeat(2000), options: long.slice(0, 3) }]);
  assert(ctxCut.truncated && ctxCut.logits.length === 4 && ctxCut.tokens === MAX_TOKENS, "a cut that ends inside the context is answered — every option read — truncated: true");
}

// ── [5b] The HTTP handler over a fake engine ────────────────────────────────
section("[5b] createHandler — the contract's statuses, one request at a time");
{
  let active = 0, overlapped = false, fail = false, refuse = false, calls = 0;
  const fake: Engine = {
    info: INFO,
    async decide(ds) {
      calls++;
      active++;
      if (active > 1) overlapped = true;
      await Bun.sleep(20);
      active--;
      if (fail) throw new Error("boom");
      if (refuse) throw new DecisionRefused("decision 0: its text contains the model's own markers", 0);
      return ds.map((d) => resultFrom(d, d.kind === "binary" ? ["true", "false", INSUFFICIENT_EVIDENCE] : [...d.options.map((o) => o.id), INSUFFICIENT_EVIDENCE], d.kind === "binary" ? [1, 0, 0] : [...d.options.map(() => 0), 1], 1, 5, false));
    },
  };
  const h = createHandler(fake);
  const call = (path: string, init?: RequestInit) => h(new Request(`http://t${path}`, init));
  const post = (body: unknown) => call("/decide", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  assert((await (await call("/health")).text()) === "ok", "GET /health answers ok");
  assert((await call("/health", { method: "HEAD" })).status === 200 && (await call("/info", { method: "HEAD" })).status === 200, "HEAD is GET for a probe");
  assert(((await (await call("/info")).json()) as typeof INFO).contract === JEV_CONTRACT, "GET /info is the contract's JevInfo");
  const m = await call("/decide");
  assert(m.status === 405 && m.headers.get("Allow") === "POST", "GET /decide is 405 with Allow: POST");
  assert((await call("/nope")).status === 404, "an unknown path is 404");
  assert((await post("{not json")).status === 400, "a body that is not JSON is 400");
  const bad = await post({ decisions: [] });
  assert(bad.status === 400 && /non-empty/.test(((await bad.json()) as { error: string }).error), "a malformed request is 400 with the rule's words");
  assert((await post({ model: "other", decisions: [binary()] })).status === 409, "a request for another model is 409");
  assert((await call("/decide", { method: "POST", headers: { "content-length": String(JEV_MAX_BODY_BYTES + 1) }, body: "{}" })).status === 413, "a body declared over the limit is 413 before it is read");
  // No Content-Length (a stream): counted as it arrives, refused at the cap.
  const chunk = new Uint8Array(2 ** 20).fill(0x20);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 12) c.enqueue(chunk); else c.close(); } });
  const streamed = await call("/decide", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert(streamed.status === 413 && sent <= 10, `a streamed body is refused at the cap, not read whole (${streamed.status}, ${sent} MB pulled)`);
  // A valid request at the contract's largest is not refused by the service's cap.
  const maxed = { decisions: Array.from({ length: JEV_MAX_BATCH }, (_, i) => ({ id: `m${i}`, kind: "binary", proposition: "p".repeat(JEV_MAX_TEXT), context: "c".repeat(JEV_MAX_TEXT) })) };
  assert((await post(maxed)).status === 200, `64 decisions at the text limit (${(JSON.stringify(maxed).length / 2 ** 20).toFixed(1)} MB) are within the service's cap`);
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
  refuse = true;
  const refusedRes = await post({ decisions: [binary()] });
  assert(refusedRes.status === 422 && /own markers/.test(((await refusedRes.json()) as { error: string }).error), "a decision the model cannot read is 422, naming it");
  refuse = false;
  // A caller gone before its turn is skipped, not computed for no one.
  calls = 0;
  const gone = new AbortController();
  const ahead = post({ decisions: [binary()] });
  const behind = call("/decide", { method: "POST", body: JSON.stringify({ decisions: [binary()] }), signal: gone.signal });
  gone.abort();
  const [, left] = await Promise.all([ahead, behind]);
  assert(left.status === 499 && calls === 1, `a request whose caller left while it queued is not computed (${left.status}, ${calls} run)`);
  // …and one that leaves mid-batch stops the engine between forward passes.
  let passes = 0;
  const slow = createHandler(createEngine(markerEncoder, async () => { passes++; await Bun.sleep(25); return new Float32Array(25); }, { temperature: 1 }));
  const leaving = new AbortController();
  const pending = slow(new Request("http://t/decide", { method: "POST", body: JSON.stringify({ decisions: Array.from({ length: 20 }, (_, i) => binary(i)) }), signal: leaving.signal }));
  await Bun.sleep(80);
  leaving.abort();
  const midway = await pending;
  assert(midway.status === 499 && passes < 10, `a caller that leaves mid-batch stops the engine between passes (${midway.status}, ${passes} of 20 run)`);
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
  msg = "";
  try { await ensureModel(dir, { pins, hub: "http://127.0.0.1:1" }); } catch (e) { msg = (e as Error).message; }
  assert(/fetching m\.bin from http:\/\/127\.0\.0\.1:1\/.* failed: .*nothing kept/.test(msg), `a hub that cannot be reached names the file and the URL (${msg.slice(0, 90)})`);
  // A download that fails midway removes its own part and names the file.
  const flaky = Bun.serve({
    port: 0,
    fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(good.subarray(0, 5)); setTimeout(() => c.error(new Error("connection reset")), 10); } })),
  });
  await rm(dir, { recursive: true, force: true });
  msg = "";
  try { await ensureModel(dir, { pins, hub: `http://127.0.0.1:${flaky.port}` }); } catch (e) { msg = (e as Error).message; }
  flaky.stop(true);
  assert(/m\.bin .*failed after \d+ of \d+ bytes.*nothing kept/.test(msg) && (await readdir(dir)).length === 0, `a download that fails midway names the file and leaves no part (${msg.slice(0, 90)}; ${(await readdir(dir)).join(", ") || "empty"})`);
  // Two fetches into one directory at once (serve.ts and conformance.ts on the
  // host cache): each writes its own part, both end with the pinned file.
  served = good;
  await rm(dir, { recursive: true, force: true });
  const both = await Promise.allSettled([ensureModel(dir, { pins, hub: base }), ensureModel(dir, { pins, hub: base })]);
  assert(both.every((r) => r.status === "fulfilled") && (await sha256File(`${dir}/m.bin`)) === sha && (await readdir(dir)).join() === "m.bin",
         `two concurrent fetches into one directory both succeed and leave only the pinned file (${both.map((r) => r.status).join(", ")}; ${(await readdir(dir)).join(", ")})`);
  // A part no fetch has written for STALE_PART_MS is a dead fetch's, removed; a fresh one is someone's, kept.
  await writeFile(`${dir}/m.bin.part-1-dead`, "half a download");
  const old = new Date(Date.now() - STALE_PART_MS - 60_000);
  await utimes(`${dir}/m.bin.part-1-dead`, old, old);
  await writeFile(`${dir}/m.bin.part-2-live`, "being written");
  await ensureModel(dir, { pins, hub: base });
  const left = (await readdir(dir)).sort().join();
  assert(left === "m.bin,m.bin.part-2-live", `a stale part is removed at the next start and a live one left alone (${left})`);
  hub.stop(true);
  await rm(dir, { recursive: true, force: true });
}

// ── [7]–[8] The client against a stub tier ──────────────────────────────────
type Stub = { requests: { path: string; body: any; bytes: number }[]; answer: (body: any) => Response | Promise<Response> };
const stub: Stub = { requests: [], answer: () => new Response("unset", { status: 500 }) };
const tier = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const raw = req.method === "POST" ? await req.text() : "";
    const body = raw ? JSON.parse(raw) : undefined;
    stub.requests.push({ path, body, bytes: new TextEncoder().encode(raw).length });
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
  // Validated before the gate reads it: a malformed decision fails by index and rule, not as a TypeError.
  for (const [cfgName, cfg] of [["allow", marked], ["deny", remote]] as const) {
    err = undefined;
    try { await jevDecideMany(cfg, [binary(0), { kind: "choice", question: "q", context: "c" } as unknown as JevDecision], subj); } catch (e) { err = e; }
    assert(err instanceof Error && !(err instanceof TypeError) && /not sent to .*decision 1: a choice has 1 to 24 options/.test(err.message), `under ${cfgName}, a choice with no options is refused by index before the gate reads it (${(err as Error)?.message?.slice(0, 70)})`);
  }
  err = undefined;
  try { await jevChoose(marked, { question: "q", options: [{ id: "a", description: "A" }], context: "a note tagged #phi" }, { ...subj, content: "the query the caller named" }); } catch (e) { err = e; }
  assert(err instanceof ProviderError && err.kind === "egress" && stub.requests.length === 0, "…and when the caller gave content of its own: the gate reads what is sent, not only what was named");
  // Under deny, an allow marker vouches only for the context that carries it
  // (second review pass): not an option's text, not another decision's context.
  const tagged = resolveJevConfig({ OB1_JEV_BASE_URL: BASE, OB1_EGRESS_ALLOW: "marker:#public" })!;
  stub.requests = [];
  err = undefined;
  try { await jevChoose(tagged, { question: "q", options: [{ id: "a", description: "a #public note" }], context: "an untagged row" }, { ...subj, content: "the row" }); } catch (e) { err = e; }
  assert(err instanceof ProviderError && err.kind === "egress" && stub.requests.length === 0, "an allow marker in an option's description lets no untagged context leave");
  err = undefined;
  try { await jevDecideMany(tagged, [{ kind: "binary", proposition: "p", context: "a #public note" }, { kind: "binary", proposition: "p", context: "a private row" }], subj); } catch (e) { err = e; }
  assert(err instanceof ProviderError && err.kind === "egress" && /decision 1:/.test(err.message) && stub.requests.length === 0, `…nor does one tagged context let another leave; the refusal names decision 1 (${(err as Error)?.message?.slice(0, 60)})`);
  await jevDecideMany(tagged, [{ kind: "binary", proposition: "p", context: "a #public note" }, { kind: "binary", proposition: "p", context: "#public too" }], subj);
  assert(stub.requests.length === 1, "every context tagged: the decisions leave");
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
  // Packed under the byte cap as well as the count: a control character is six
  // bytes of JSON, so 64 decisions of 2 × 20,000 of them are ~15 MB.
  stub.requests = [];
  const heavy = Array.from({ length: JEV_MAX_BATCH }, (_, i) => ({ id: `h${i}`, kind: "binary" as const, proposition: "\u0001".repeat(JEV_MAX_TEXT), context: "\u0001".repeat(JEV_MAX_TEXT) }));
  const hm = await jevDecideMany(local, heavy, subj);
  assert(stub.requests.length >= 2 && stub.requests.every((r) => r.bytes <= JEV_MAX_BODY_BYTES) && hm.results.length === JEV_MAX_BATCH && hm.results.every((r, i) => r.id === `h${i}`),
         `64 decisions over the byte cap go as ${stub.requests.length} requests, each within it (${stub.requests.map((r) => (r.bytes / 2 ** 20).toFixed(1)).join(" + ")} MB), in order`);
  // A later request refused after earlier ones were answered says so.
  let n = 0;
  stub.answer = (b) => (++n === 2 ? Response.json({ error: "decision 3: its text contains the model's own markers" }, { status: 422 }) : honest(b));
  let later: any;
  try { await jevDecideMany(local, many, subj); } catch (e) { later = e; }
  assert(later?.kind === "http" && later.status === 422 && /after 64 of 70 decisions were answered/.test(later.message), `a 422 on the second request names what was already answered (${later?.message?.slice(-60)})`);
  stub.answer = honest;
  const expecting = resolveJevConfig({ OB1_JEV_BASE_URL: BASE, OB1_JEV_LOCAL: "1", OB1_JEV_MODEL: "semif" })!;
  stub.requests = [];
  await jevDecide(expecting, { proposition: "p", context: "c" }, subj).catch(() => {});
  assert(stub.requests[0]?.body.model === "semif", "OB1_JEV_MODEL rides the request, so a tier serving another can say 409");
  let err: any;
  try { await jevDecide(expecting, { proposition: "p", context: "c" }, subj); } catch (e) { err = e; }
  assert(err?.kind === "body" && /OB1_JEV_MODEL expects semif/.test(err.message), "an answer from another model is refused even from a tier that did not check");
  const bodies: [string, () => unknown][] = [
    ["another contract", () => ({ contract: "other/9", model: MODEL_INFO, results: [], ms: 0 })],
    ["too few results", () => ({ contract: JEV_CONTRACT, model: MODEL_INFO, results: [], ms: 0 })],
    ["probabilities that do not sum to 1", () => ({ contract: JEV_CONTRACT, model: MODEL_INFO, ms: 0, results: [{ kind: "binary", probabilities: { true: 0.9, false: 0.9, [INSUFFICIENT_EVIDENCE]: 0 }, selected: "true", abstained: false, p_insufficient: 0, p_true: 0.5, logits: [], temperature: 1, tokens: 1, truncated: false }] })],
    ["another decision's options", () => ({ contract: JEV_CONTRACT, model: MODEL_INFO, ms: 0, results: [{ kind: "binary", probabilities: { yes: 1, [INSUFFICIENT_EVIDENCE]: 0 }, selected: "yes", abstained: false, p_insufficient: 0, logits: [], temperature: 1, tokens: 1, truncated: false }] })],
  ];
  for (const [what, make] of bodies) {
    stub.answer = () => Response.json(make());
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
  // The default deadline grows with the request: a fixed part and a part per decision.
  assert(requestTimeoutMs({ timeoutMs: 30_000 }, 64) === 94_000 && requestTimeoutMs({ timeoutMs: 30_000 }, 64, { timeoutMs: 5 }) === 5, "a request's deadline is 30 s + 1 s a decision, and a caller's timeoutMs replaces it");
  stub.answer = async (b) => { await Bun.sleep(300); return honest(b); };
  err = undefined;
  try { await jevDecide({ ...local, timeoutMs: 100 }, { proposition: "p", context: "c" }, subj); } catch (e) { err = e; }
  assert(err === undefined, `…and jevDecideMany uses it: a 300 ms answer under a 100 ms fixed part and one decision's second arrives (${err?.message ?? "answered"})`);
  stub.answer = honest;
  // A caller's own deadline is the caller's: its error, not "timed out after 30 s".
  stub.answer = () => new Promise(() => {});
  err = undefined;
  try { await jevDecide(local, { proposition: "p", context: "c" }, subj, { signal: AbortSignal.timeout(150) }); } catch (e) { err = e; }
  assert(err && !(err instanceof ProviderError) && err.name === "TimeoutError", `a caller's own signal firing surfaces as the caller's error, not the config's timeout (${err?.name}: ${err?.message?.slice(0, 50)})`);
  stub.answer = honest;
  // /info is checked whole: the contract's name with its fields missing is a body error, not a crash in the reader.
  const partialInfo = Bun.serve({ port: 0, fetch: () => Response.json({ contract: JEV_CONTRACT, model: { name: "x" } }) });
  err = undefined;
  try { await jevInfo(resolveJevConfig({ OB1_JEV_BASE_URL: `http://127.0.0.1:${partialInfo.port}`, OB1_JEV_LOCAL: "1" })!); } catch (e) { err = e; }
  partialInfo.stop(true);
  assert(err?.kind === "body" && /lacks model\.source, model\.revision, model\.weights_sha256, model\.calibrator_sha256, model\.rules, kinds, max_options, max_batch, max_tokens/.test(err.message), `an /info that lacks its fields is a body error naming them (${err?.message?.slice(-90)})`);
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
  // The first review pass's two probes, against the real tokenizer: a marker
  // in the text, and 24 fifty-token options that overrun the budget.
  const refusal = async (d: JevDecision) => { try { await engine.decide([d]); return null; } catch (e) { return e; } };
  assert((await refusal({ kind: "choice", question: q, options: card, context: "a note that says <<LABEL>> and <<SEP>> in its text" })) instanceof DecisionRefused, "the real tokenizer's markers in a context are refused");
  const wordy = Array.from({ length: 24 }, (_, i) => ({ id: `o${i}`, description: `option ${i}: ${"a long description of what this option covers ".repeat(5)}` }));
  assert((await refusal({ kind: "choice", question: q, options: wordy, context: "short" })) instanceof DecisionRefused, "24 fifty-token options are refused rather than answered from 9 of them");
}

// ── [10] Conformance to the model's published evaluation ────────────────────
section("[10] conformance — the published receipt, row by row (JEV_TEST_MODEL_DIR)");
if (!dir) {
  skip("the runtime reproduces reports/v2/predictions_v2.jsonl on all 1,000 rows", "JEV_TEST_MODEL_DIR is unset");
} else {
  const { loadConformance, receiptArm, servedArm } = await import("./conformance.ts");
  const l = await loadConformance(dir);
  const pub = l.report.calibrated;
  const a = await receiptArm(l);
  assert(a.agree === l.rows.length && l.rows.length === 1000, `the predicted option agrees with the receipt on every row (${a.agree}/${l.rows.length}; ${a.disagreements.slice(0, 2).join("; ")})`);
  assert(a.maxConfidenceDelta < 1e-4, `…and the confidence to float noise (max |Δ| ${a.maxConfidenceDelta.toExponential(2)})`);
  const near = (x: number, y: number) => Math.abs(x - y) < 1e-4;
  assert(near(a.accuracy, pub.accuracy) && near(a.abstentionRecall, pub.abstention.recall) && near(a.abstentionPrecision, pub.abstention.precision),
         `accuracy and abstention are the report's (${a.accuracy} / ${a.abstentionRecall} / ${a.abstentionPrecision.toFixed(4)})`);
  assert(near(a.ece, pub.ece_equal_width) && near(a.brier, pub.brier_score), `ECE and Brier are the report's (${a.ece.toFixed(4)} / ${a.brier.toFixed(4)})`);
  // The served arm is a different prompt and calibration by design (verdict.ts
  // follows the v1.4 engine); held at its measured numbers so a change to
  // buildPrompt or the calibrator moves them on purpose, with the record.
  const s = await servedArm(l);
  assert(Math.abs(s.accuracy - 0.931) < 0.0015 && s.differsFromReceipt === 28, `the served arm stands at its recorded accuracy, 93.1%, 28 answers from the receipt's (${(s.accuracy * 100).toFixed(1)}%, ${s.differsFromReceipt}) — jev/README.md, "Conformance"`);
  assert(Math.abs(s.ece - 0.2123) < 0.002, `…and its recorded ECE, 0.212 under the bundle's per-K calibrator (${s.ece.toFixed(4)})`);
}

// ── [11] JevBench's two published Verdict rows, task by task ────────────────
section("[11] JevBench — both published Verdict rows on the 231 public tasks (JEV_TEST_MODEL_DIR)");
if (!dir) {
  skip("the earlier and the v1.4 engine rows reproduce task by task, and the served prompt is the v1.4 row's", "JEV_TEST_MODEL_DIR is unset");
} else {
  const { agreement, jevbenchPrompt, loadJevbench, pyDumps, runArm } = await import("./jevbench.ts");
  const j = await loadJevbench(dir);
  // The served path is the v1.4 row's prompt, byte for byte, for every task
  // the contract can carry (choice and noul — it has no score kind), so the
  // published row measures what the tier serves, not a lookalike.
  let same = 0, carried = 0;
  for (const t of j.tasks) {
    const q = t.question;
    if (q.type === "score") continue;
    carried++;
    const state = typeof t.state === "string" ? t.state : pyDumps(t.state);
    const c = (q.criteria ?? {}) as Record<string, string>;
    const d: JevDecision = q.type === "choice"
      ? { kind: "choice", question: q.instructions, context: state, options: Object.entries(c).map(([id, v]) => ({ id, description: v || id })) }
      : { kind: "binary", context: state, proposition: q.instructions + (c.true || c.false ? ` (true: ${c.true || "yes"}; false: ${c.false || "no"})` : "") };
    if (buildPrompt(d).prompt === jevbenchPrompt(t, "it-is").prompt) same++;
  }
  assert(carried === 213 && same === carried, `buildPrompt writes the v1.4 row's prompt for every choice and binary task (${same}/${carried})`);
  const earlier = agreement(await runArm(j.tasks, j.encoder, j.run, { framing: "bare", maxTokens: 1024 }), j.earlier);
  assert(earlier.agree === 231, `the earlier engine (bare labels, 1,024 tokens) scores every task as JevBench's "openJev Verdict" row (${earlier.agree}/231${earlier.differ.length ? `: ${earlier.differ.slice(0, 3).join(", ")}` : ""})`);
  const v14 = agreement(await runArm(j.tasks, j.encoder, j.run, { framing: "it-is", maxTokens: 512 }), j.v14);
  assert(v14.agree === 231, `the v1.4 engine — the served prompt — scores every task as its "openJev Verdict 1.4" row (${v14.agree}/231${v14.differ.length ? `: ${v14.differ.slice(0, 3).join(", ")}` : ""})`);
}

report();
