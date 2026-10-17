# jev/h2o — H2O-Lightning-4B behind the `ob1-jev/1` contract (SMD-3058)

[H2O-Lightning-4B](https://huggingface.co/h2oai/h2o-lightning-4b) (H2O.ai,
Apache-2.0) is a Qwen3.5-4B fine-tune for typed decisions: one forward pass,
a probability for every option, no generated text. On Benchmark Heaven's
open-weights board (JevBench v1.6.1, 2026-10-06) it ranks #5, with capability
75.0 and intelligence 60.0, against decider-4b v2's 64.9 and 40.1 (#24).
SMD-3058 measured it as a cheaper first pass in front of the consolidation
judge, where decider-4b had failed.

H2O serves it through a standard-library shim in front of vLLM. Each question is
rendered in the prompt the model was trained on, and read from the next token's
log-probabilities over the options' one-letter labels, at a per-type
temperature. vLLM does not run on the dogfood Mac, so `serve.py` does the same
read on PyTorch MPS, following `h2o_lightning_shim.py` and `serve_config.json`
at v1.2.3, the revision behind the card's routing table. It serves the contract
of `jev/serve.ts` and `jev/decider/serve.py`, so a caller switches models by
`OB1_JEV_BASE_URL` / `OB1_JEV_MODEL` alone.

## Run

It runs in decider-4b's venv (`jev/decider/README.md`): torch, transformers
5.17 or later, fastapi and uvicorn, plus decider-ai for its MPS kernels.

```bash
JEV_PORT=8022 <venv>/bin/python -I jev/h2o/serve.py    # serves ob1-jev/1 on 127.0.0.1:8022
```

The first start downloads the revision's weights (9.1 GB), configuration and
tokenizer, never the repository's code. Every start checks the weights' sha256;
v1.2.3's is `2d51561f221e1549d91bd1c38b3512a1435dd32950d454a9f040f1d4d11497b6`,
the hash H2O's routing set names. Ready in about 7 s once cached.

Knobs:
- `JEV_HOST` (127.0.0.1) and `JEV_PORT` (8022, beside Verdict's 8020 and
  decider's 8021);
- `H2O_MODEL` (`h2oai/h2o-lightning-4b`) and `H2O_REVISION` (`v1.2.3`);
- `H2O_DEVICE` (`mps`);
- `H2O_DTYPE`: float16 on MPS, as decider runs, else bfloat16;
- `H2O_MPS_PATCH` (1): decider's MPS kernels for Qwen3.5's gated-delta layers.
  bfloat16 on transformers' reference code read 2.1 ms a token in the first
  conformance run, against 0.69 with float16 and these kernels;
- `H2O_SHARE` (1): the decisions of one request that share a context read it
  once. 0 reads every prompt whole.

## How the contract maps onto H2O's questions

- **choice:** the question becomes H2O's instructions, and each option a line
  `A) id: description`. The tier's option descriptions are worded for decider's
  "It is …" and begin with their own id ("unrelated: the two are about …"), so a
  description that begins with its id and a colon loses that prefix. Otherwise
  the line would read `A) unrelated: unrelated: …`.
- **binary:** a yes/no question in the shape of H2O's own: "Answer true or
  false based only on the record.", with true the proposition and false "It is
  not the case that " followed by the proposition.
- **INSUFFICIENT_EVIDENCE:** H2O has no abstain option, so the tier's own option
  is reported at probability 0, with logit -10,000 since JSON has no -inf. A
  caller abstains by its own cutoff on the top probability, as H2O's routing
  table does.
- **The yes/no floor** is not applied. As shipped, the shim reports every yes/no
  answer at 0.801 or more for benchmark runs. The tier reports probabilities as
  read, which is H2O's routing mode (`SHIM_NOUL_FLOOR=0`).
- **A shared context is read once.** For the decisions of one request that share
  a context, the prompts' common token prefix is read once. Each question's tail
  then continues from a copy of that cache, as vLLM's prefix cache does for the
  shim, and each question still sees only the record and itself. Decider's
  `DECIDER_PACK=1` instead puts the questions in one row, and that moves
  answers. A start-up check compares a shared read with whole reads and refuses
  to serve if they differ.

## Conformance

For the 3,474 questions behind its card's routing table, H2O publishes two
things: the questions as the model saw them, and each one's label
log-probabilities from the shipped shim over vLLM (`routing_reproducibility/`,
made at v1.2.3). `conformance.py` reads a stratified sample through `serve.py`'s
reader and compares top answers and probabilities.

```bash
<venv>/bin/python -I jev/h2o/conformance.py <routing_reproducibility dir> --n 300
```

On 302 questions (2026-10-17, float16 with decider's kernels):
- top answers agree on all 302;
- the largest probability gap per question has a median of 0.0009 and a 99th
  percentile of 0.020;
- both reads are right on 254.

H2O's own two passes over one vLLM server differ by a median of 0.0005 and a
99th percentile of 0.016, so the port reads as the shim does. The check passes
at 98% of top answers agreeing and a median gap of at most 0.01. The routing set
is on the model's repository: Plumb (Apache-2.0) and Eikos (CC-BY-4.0)
questions, with sources in its `ATTRIBUTION.md`. Fetch it into a directory of its
own; it is only read.

## SMD-3058: in front of the consolidation judge

Run over the judge's 444 pairs on 2026-10-17. `evals/README.md`, "Settling the
judge's easy pairs", has the tables.

- **As a cheap first pass, it fails SMD-3058's rule behind the 7B,** the judge
  both dogfood brains run. A read costs 1.41 s a candidate, and no band
  accurate enough settles enough candidates to save time. Behind the 27B it
  passes by 7%. The cascade stays declined.
- **Its one-pass verdicts come close to the judges'.** On the 170 labelled pairs
  its loosest band settles, it is right on 140, against the 7B's 143 and the
  27B's 156.
- **As the judge itself** (explored after the run), it is right on 259 of 324
  labelled pairs, where the 7B gets 239 and the 27B 263. It proposes 52 of the
  62 true supersessions (the 7B 2, the 27B 23), with 32 false proposals (3 and
  17).
- **The binary shape is this adapter's choice, not H2O's.** SMD-3058's "same
  subject?" question did poorly in it: it settled 93 pairs unrelated and was
  right on 33. It is the first thing to vary before another binary workload.
