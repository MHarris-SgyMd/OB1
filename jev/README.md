# jev/ — the typed-decision tier

A Jev-class model answers a bounded question — *is this proposition true of
this text?*, *which of these options?* — with a calibrated probability in one
non-autoregressive forward pass. No generation, so nothing to parse, repair or
retry, and nothing that can run away. Seven spikes want one: SMD-1874
(reranker), 1897 (question router), 1937 (extraction validity gate), 2016
(runaway router), 2017 (span extraction), 2018 (relations), 2049 (span gate).
This directory is the model they share (SMD-2050); `server-portable/jev.ts` is
how they call it.

## What runs

`serve.ts` serves **Verdict v1.4** — [`heman10x/rlcd-modernbert-151m`](https://huggingface.co/heman10x/rlcd-modernbert-151m),
a 151M GLiClass ModernBERT-base decision model with an ONNX export and a
fitted temperature calibrator — on onnxruntime-node's CPU provider, under Bun.
It is not an Ollama model: Ollama's API exposes no option logits. It is its own
process, so Ollama's scheduler (`OLLAMA_MAX_LOADED_MODELS`) neither counts nor
evicts it.

The ticket named **openJev-verdict-2.0**, the line's newer model. It is not
servable today: its Hugging Face repository answers 401, and its GitHub weights
(`artifacts/verdict2-base/model.pt`) are a Git LFS pointer —
`oid sha256:2201b07c…40f7`, `size 598509338` — for which GitHub's LFS batch API
answers `404 Object does not exist on the server`, in the repository and in
every one of its 41 forks (checked 2026-09-23).
Verdict v1.4 is the same author's public checkpoint, the one on the JevBench
leaderboard. When verdict-2.0 is published, it goes behind the same contract.
**SemIf** (semantic-if over Qwen3.5-4B) is Python-only (transformers, MLX or
llama.cpp); it is a follow-up adapter speaking the same contract (SMD-2052),
not part of this directory.

`verdict.ts` ports the model's own reference engine (openJev-verdict-2.0's
`core/formatting.py` and `core/engine_encoder.py`) rather than re-imagining it:
the `<<LABEL>>…<<SEP>>` prompt, `It is {description}` choice labels, the
`true: / false: not / insufficient evidence` binary labels, the temperature
fitted for K options else the global one, and 512-token truncation that keeps
the closing `[SEP]`. `test-jev.ts` [2]–[4] hold each rule to the reference's
strings; the tokenizer (`@huggingface/tokenizers`) gave ids identical to
transformers.js on ten prompts.

## The contract

`server-portable/jev-contract.ts` is the whole of it — no imports, read by
this service and by the client:

| Route | Answer |
| --- | --- |
| `GET /health` | `ok`, once the model is loaded (the service listens only then); HEAD too |
| `GET /info` | `JevInfo`: `ob1-jev/1`, the model's name, source, revision, weights and calibrator sha256, the limits |
| `POST /decide` | `{ model?, decisions: [...] }` → `JevResponse`; 400 malformed, 409 another model, 413 over 8 MB, 422 a decision the model cannot read faithfully, 499 the caller left (before its turn, or mid-batch — the engine stops between forward passes), 500 the model failed |

A decision is `binary` (`proposition`, `context`) or `choice` (`question`,
up to 24 `options`, `context`). Every answer adds the tier's own option,
`__insufficient_evidence__`, so the model can decline instead of picking the
least-bad option; `abstained` says it did. A binary result carries `p_true` —
P(true | the evidence suffices). Every result carries the raw `logits` and the
`temperature` applied, so a spike can recalibrate on its own workload without
a second serving path. Up to 64 decisions and 8 MB a request (a cap derived
so the largest valid decision always fits alone); the client packs longer
lists under both.

**422: what the model cannot read, refused rather than answered.** The model
reads option k's score off the k-th `<<LABEL>>` marker, so the service checks
every decision's encoding before the first forward pass. A marker string in
the caller's own text (`<<LABEL>>` or `<<SEP>>` in a context, a proposition,
an option) would add a slot and shift every probability onto the wrong
option — measured, `p_insufficient` 0.194 → 0.034 — and labels that overrun
the 512 tokens would be answered without the question or context ever read —
measured, 24 fifty-token options kept 9 markers and still answered, and a
separator at token 506 kept every label and read four tokens. Both are 422
naming the decision; the whole request is refused. A cut that leaves the
question, the `Context:` line and some context is the reference engine's rule
for a long context and is answered, `truncated: true`.

## Running it

```bash
cd jev && bun install --frozen-lockfile
bun serve.ts                  # fetch-or-verify the pinned files, then serve on 127.0.0.1:8020
bun serve.ts --fetch-only     # pre-pull into ~/.cache/ob1-jev/<revision> and exit
bun serve.ts --no-fetch       # refuse to start unless the files are already there
```

On the host, `serve.ts` binds 127.0.0.1: a container reaches it as
`host.containers.internal` under podman machine on macOS (gvproxy forwards to
the host's loopback — measured for Ollama) and `host.docker.internal` under
Docker Desktop, not under rootless podman or Docker on Linux, where the
profile below is the route.

Or `podman compose -f deploy/compose.yaml --profile jev up -d` —
`deploy/README.md`, "The typed-decision tier". Knobs of its own, on the host:
`JEV_HOST` (127.0.0.1), `JEV_PORT` (8020), `JEV_MODEL_DIR`, `JEV_THREADS` (4),
`JEV_HUB`. Under compose the image fixes host, port and directory (0.0.0.0,
8020, the `jev-models` volume) and `deploy/.env` reaches the service with
`JEV_THREADS` and `JEV_HUB` only; there `JEV_PORT` is the host port
`compose.host-ports.yaml` publishes. The brain's knobs are `OB1_JEV_BASE_URL`,
`OB1_JEV_MODEL` and `OB1_JEV_LOCAL` (`deploy/.env.example`); the API is
unauthenticated, like Ollama's, and binds loopback by default. Its queue is
unbounded: each waiting request holds its body (up to 8 MB) several times
over until its turn, so a burst of large requests raised resident memory from
0.9 to 2.1 GB in the sixth review pass's run (a high-water mark; 5,000
ordinary decisions grew it ~2 MB per 1,000). Keep it where only the brain's
own callers reach it; SMD-2082 bounds the queue.

**The weights are referenced, not vendored.** `verdict.ts`'s `VERDICT` pins the
repository, revision `8af2496e…` and each file's size and sha256;
`fetch-model.ts` fetches exactly those bytes, to a part of the fetch's own (`<file>.part-<pid>-<random>`, removed on failure), renamed only
after they hash to the pin. Every file is hashed on every start (0.2 s on the
host, 0.5–0.7 s in the container), and one that does not match is replaced,
never loaded — measured by
flipping a byte in the container's volume: the next start named the file,
fetched it again, and served.

## Measured (2026-09-23, Apple M5 Pro, 64 GB)

| | Host (`bun serve.ts`, macOS arm64) | Container (podman VM, 8 vCPU, linux arm64) |
| --- | --- | --- |
| First start | — | fetch 606 MB 17–20 s, load 0.9–3.0 s |
| Restart (verify only) | pins 0.24–0.31 s, load 0.8 s | pins 0.32–0.49 s, load 0.6–0.7 s; /health in 1.2–1.3 s |
| Resident | 1,027–1,029 MB after load; 627 MB after use | 926–987 MB |
| One decision, 60 / 126 / 258 / 512 tokens | p50 18 / 30 / 62 / 146 ms | 25–34 ms at ~33 tokens; 81 / 171 ms at 126 / 258; 379 ms at 512 (4 threads — `JEV_THREADS=8` on the VM's 8 vCPU was 20–30% faster) |
| Image | — | 491 MB, no weights |

The same decision gave the same probability on both (p 0.712). A padded batch
of eight measured no faster than eight singles on this CPU, so the engine runs
one forward pass per decision; the service runs one request at a time, in
arrival order. Beside the embedder and the metadata model it is a separate
process of about 1 GB with nothing for Ollama to evict; the co-load under
`OLLAMA_MAX_LOADED_MODELS` memory pressure is measured in SMD-2050's second PR.

**Provenance names the rules, not only the weights.** The same weights
under two prompt engines answer differently — the two JevBench rows, the
banking arms — so every answer's `model` carries `rules`,
`openjev-engine@00b5ee96#<fingerprint>`: the reference engine's revision and
a hash the service computes at load from `buildPrompt`, the token budget, the
cut and the temperature rule (`verdict.ts`, `rulesFingerprint`). A change to
any of them changes what a stored probability names, without anyone having to
remember a version; test-jev [2] pins today's value.

**What the numbers do not say.** Whether a Verdict probability is useful for
any of the seven applications. A naive binary framing ("`021` is a named
entity") scored every span near 0.7 in the feasibility run, while the model's
own presets resolve sharply (+6 logits against negatives) — framing and
calibration on each workload are each spike's first measurement, and the
reason every result carries its logits.

## Conformance

The sha256 pins say the bytes are the ones published; they do not say this
runtime reads them as their author did. `conformance.ts` checks that against
the author's own per-row receipt for this bundle: `reports/v2/predictions_v2.jsonl`,
1,000 rows of `data/real_banking_test.jsonl` (800 in scope, 200 that should
abstain), written by `scripts/evaluate.py` from `artifacts/v2/model.safetensors`
— the checkpoint whose sha256 the bundle manifest names beside our
`model.onnx` — with the totals in `evaluation_report_v2.json`. The three files
are fetched pinned (commit `bff28567`, sha256 each), not vendored.

```bash
bun conformance.ts ~/.cache/ob1-jev/8af2496eb63c7fa66d7d234e1f62629380030eb4   # ~60 s
```

| 1,000 rows, K=5 | accuracy | abstention recall | abstention precision | ECE | Brier |
| --- | --- | --- | --- | --- | --- |
| published (T=1.4265) | 95.00% | 97.50% | 89.45% | 0.0335 | 0.0785 |
| **receipt arm** — this runtime, the evaluator's prompt and temperature | 95.00% | 97.50% | 89.45% | 0.0335 | 0.0785 |
| **served arm** — the contract's prompt, the bundle's calibrator | 93.10% | 96.50% | 83.91% | 0.2123 | 0.1660 |

**The runtime conforms.** The receipt arm agrees with the receipt's predicted
option on all 1,000 rows, the confidence within 6.4e-6, and every total is the
report's. A tokenizer that drops `[CLS]` — a bug every hash still passes —
moves 18 rows and fails all six of [10]'s assertions (measured as a mutant).

**The served prompt is not the evaluated one, and it costs on this set.** Taken
apart one choice at a time (same rows, same weights):

| Prompt | accuracy | abstention precision | ECE at T=1.4265 | ECE at the bundle's per-K T |
| --- | --- | --- | --- | --- |
| raw labels, abstention where the row puts it (the evaluator's) | 95.0% | 89.4% | 0.034 | 0.213 |
| raw labels, abstention last | 95.5% | 90.7% | 0.033 | 0.219 |
| `It is` labels, abstention where the row puts it | 93.5% | 84.3% | 0.033 | 0.212 |
| `It is` labels, abstention last (**served**) | 93.1% | 83.9% | 0.033 | 0.212 |

Abstention last is free. The `It is` framing — the v1.4 engine's own rule,
which its README says lifts JevBench's open-domain accuracy 2–7 points — costs
about 2 points of accuracy and 5 of abstention precision on this in-domain set.
The bundle's `calibrator.json` (fitted "open domain", T=3.06 at five options)
leaves every answer where it was and makes the confidences six times worse
calibrated here (under-confident). Which framing and which temperature a
workload wants is that workload's to measure — every result carries the raw
logits so a spike can refit — and the served arm is held at these numbers by
[10], so a change to either moves them on purpose.

### The framing on open-domain tasks (JevBench)

The engine's README says the `It is` framing lifts open-domain accuracy.
JevBench ran these same weights through both engines as two rows — "openJev
Verdict" (engine `33950bf`: bare labels, 1,024 tokens) and "openJev Verdict
1.4" (`00b5ee96`, PR #3: `It is` labels, 512 tokens, the calibrator) — and
publishes each row's right/wrong on its 231 public tasks. `jevbench.ts` fetches
the tasks and both rows pinned (JevBench `2fa63fa3`, sha256 each) and runs the
benchmark adapter's prompt rules (`jevbench/adapters/verdict_local.py`) here:

```bash
bun jevbench.ts ~/.cache/ob1-jev/8af2496eb63c7fa66d7d234e1f62629380030eb4   # ~70 s
```

| 231 public tasks | easy (48) | standard (72) | hard (111) | all |
| --- | --- | --- | --- | --- |
| earlier engine — bare, 1,024 tokens | 85.4% | 62.5% | 37.8% | 55.4% |
| v1.4 engine — `It is`, 512 tokens (**served**) | 87.5% | 69.4% | 36.9% | 57.6% |
| bare, 512 tokens | 85.4% | 62.5% | 35.1% | 54.1% |

Both published rows reproduce **task by task, 231 of 231** — the earlier one
though JevBench ran it through PyTorch — and `buildPrompt` writes the v1.4
row's prompt byte for byte for all 213 choice and binary tasks (the contract
has no score kind), so the v1.4 row measures the served path itself. The
engine README's easy and standard figures (85.4 → 87.5, 62.5 → 69.4) are these;
its "hard 36.9 → 36.9" is not — the earlier row it describes scores 37.8%.

Paired on the same items, with the token budget held at the served 512:

| | bare | `It is` | only bare right | only `It is` right | McNemar exact p |
| --- | --- | --- | --- | --- | --- |
| JevBench public, open domain (231) | 54.1% | 57.6% | 3 | 11 | 0.057 |
| … standard tier (72) | 62.5% | 69.4% | 0 | 5 | 0.063 |
| banking receipt, the model's own domain (1,000) | 95.5% | 93.1% | 25 | 1 | < 0.0001 |

**The framing's effect depends on the domain.** On the fine-tuning domain it
is a clear loss, and mostly a loss of nerve: of the 25 rows only bare labels
get right, 23 are in scope and 2 should abstain, and on 15 of the 23 `It is`
abstains wrongly — it abstains on 230 rows where bare labels abstain on 214
(the right number is 200), which is the 5 points of abstention precision
above; on
open-domain tasks it is a gain of 3.5 points that stops just short of p 0.05
on 231 items. The tier keeps `It is` (the author's current engine, and
JevBench's direction), and neither set is the fork's own workload: which
framing a spike's decisions want is that spike's first measurement.

## Licences

Verdict v1.4 weights and the openJev reference code: Apache-2.0.
onnxruntime-node: MIT. `@huggingface/tokenizers`: Apache-2.0. SemIf (the
follow-up): MIT, over Qwen3.5-4B, Apache-2.0. All permissive, all runtime
dependencies; no weights in the tree — nothing conflicts with the repository's
FSL-1.1-MIT.

## Tests

`bun test-jev.ts` — 101 assertions with no model; with `JEV_TEST_MODEL_DIR`
naming the pinned files, [9] adds the model's presets and its refusals on the
real tokenizer, [10] the receipt run and [11] both JevBench rows and the
served-prompt equivalence (114, about 100 s). CI runs it in the
portable-server job, with `bunx tsc --noEmit` here (check 18 lists `jev`).
