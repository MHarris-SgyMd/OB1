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
servable today: its Hugging Face repository answers 401 and its GitHub weights
are a Git LFS pointer with no object behind it (both checked 2026-09-23).
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
| `GET /health` | `ok`, once the model is loaded (the service listens only then) |
| `GET /info` | `JevInfo`: `ob1-jev/1`, the model's name, source, revision, weights and calibrator sha256, the limits |
| `POST /decide` | `{ model?, decisions: [...] }` → `JevResponse`; 400 malformed, 409 another model, 413 too large, 500 the model failed |

A decision is `binary` (`proposition`, `context`) or `choice` (`question`,
up to 24 `options`, `context`). Every answer adds the tier's own option,
`__insufficient_evidence__`, so the model can decline instead of picking the
least-bad option; `abstained` says it did. A binary result carries `p_true` —
P(true | the evidence suffices). Every result carries the raw `logits` and the
`temperature` applied, so a spike can recalibrate on its own workload without
a second serving path. Up to 64 decisions a request; the client splits longer
lists.

## Running it

```bash
cd jev && bun install --frozen-lockfile
bun serve.ts                  # fetch-or-verify the pinned files, then serve on 127.0.0.1:8020
bun serve.ts --fetch-only     # pre-pull into ~/.cache/ob1-jev/<revision> and exit
bun serve.ts --no-fetch       # refuse to start unless the files are already there
```

Or `podman compose -f deploy/compose.yaml --profile jev up -d` —
`deploy/README.md`, "The typed-decision tier". Knobs of its own: `JEV_HOST`
(127.0.0.1; the image sets 0.0.0.0), `JEV_PORT` (8020), `JEV_MODEL_DIR`,
`JEV_THREADS` (4), `JEV_HUB`. The brain's knobs are `OB1_JEV_BASE_URL`,
`OB1_JEV_MODEL` and `OB1_JEV_LOCAL` (`deploy/.env.example`); the API is
unauthenticated, like Ollama's, and binds loopback by default.

**The weights are referenced, not vendored.** `verdict.ts`'s `VERDICT` pins the
repository, revision `8af2496e…` and each file's size and sha256;
`fetch-model.ts` fetches exactly those bytes, to `<file>.part`, renamed only
after they hash to the pin. Every file is hashed on every start (under half a
second), and one that does not match is replaced, never loaded — measured by
flipping a byte in the container's volume: the next start named the file,
fetched it again, and served.

## Measured (2026-09-23, Apple M5 Pro, 64 GB)

| | Host (`bun serve.ts`, macOS arm64) | Container (podman VM, 8 vCPU, linux arm64) |
| --- | --- | --- |
| First start | — | fetch 606 MB 20 s, load 0.9 s |
| Restart (verify only) | pins 0.24 s, load 0.8 s | pins 0.49 s, load 0.7 s |
| Resident | 1,029 MB after load; 627 MB after use | 926–973 MB |
| One decision, 60 / 126 / 258 / 512 tokens | p50 18 / 30 / 62 / 146 ms | about 48 ms at ~30 tokens (70 in 3.4 s) |
| Image | — | 491 MB, no weights |

The same decision gave the same probability on both (p 0.712). A padded batch
of eight measured no faster than eight singles on this CPU, so the engine runs
one forward pass per decision; the service runs one request at a time, in
arrival order. Beside the embedder and the metadata model it is a separate
process of about 1 GB with nothing for Ollama to evict; the co-load under
`OLLAMA_MAX_LOADED_MODELS` memory pressure is measured in SMD-2050's second PR.

**What the numbers do not say.** Whether a Verdict probability is useful for
any of the seven applications. A naive binary framing ("`021` is a named
entity") scored every span near 0.7 in the feasibility run, while the model's
own presets resolve sharply (+6 logits against negatives) — framing and
calibration on each workload are each spike's first measurement, and the
reason every result carries its logits.

## Licences

Verdict v1.4 weights and the openJev reference code: Apache-2.0.
onnxruntime-node: MIT. `@huggingface/tokenizers`: Apache-2.0. SemIf (the
follow-up): MIT, over Qwen3.5-4B, Apache-2.0. All permissive, all runtime
dependencies; no weights in the tree — nothing conflicts with the repository's
FSL-1.1-MIT.

## Tests

`bun test-jev.ts` — 75 assertions with no model; [9] adds the model itself
when `JEV_TEST_MODEL_DIR` names the pinned files (77). CI runs it in the
portable-server job, with `bunx tsc --noEmit` here (check 18 lists `jev`).
