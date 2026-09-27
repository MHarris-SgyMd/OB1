# jev/decider — decider-4b behind the `ob1-jev/1` contract (SMD-2052)

`jev/serve.ts` serves **Verdict v1.4** (151M, ONNX) behind the typed-decision
contract in `server-portable/jev-contract.ts`. SMD-2052 was scoped to add
**SemIf** (Qwen3.5-4B) behind the same contract so a spike could compare it with
Verdict through one client. SemIf turned out to be **unobtainable** (gated on
Hugging Face — 401 on every name variant — and not on PyPI), so this directory
serves **decider-4b** (`Mapika/decider-4b`, an independent Jev reproduction over
Qwen3.5-4B, Apache-2.0) instead — the obtainable, measured alternative. SemIf can
drop into the same adapter if access is sorted.

## Run

Needs a Python venv with `decider-ai[serve,metal]` (Python 3.11–3.13; `mlx` has
no 3.14 wheel). See the SMD-2052 notes for the exact setup.

```bash
JEV_PORT=8021 <venv>/bin/python jev/decider/serve.py    # serves ob1-jev/1 on 127.0.0.1:8021
```

Knobs: `JEV_HOST` (127.0.0.1), `JEV_PORT` (8021, beside Verdict's 8020),
`DECIDER_MODEL` (`Mapika/decider-4b`), `DECIDER_DEVICE` (`mps`).

It serves the identical contract as `jev/serve.ts` — `GET /health`, `GET /info`,
`POST /decide` (binary + choice, the tier's `__insufficient_evidence__` added to
every decision), with the same validation, 409 model-mismatch and 413 body cap.
So a caller switches Verdict ↔ decider by `OB1_JEV_BASE_URL` / `OB1_JEV_MODEL`
alone.

### Adapter notes (honest gaps vs Verdict's onnx path)

- decider applies its own per-type temperature internally and the Python API does
  not expose raw pre-temperature logits, so the adapter reports `logits = ln(p)`
  with `temperature = 1.0` (still recalibratable: divide by a new T, softmax).
- `weights_sha256` pins the safetensors **index** (multi-file model), not one file.
- `tokens` is reported `0` / `truncated=false`; the contract's ≤20,000-char fields
  never approach decider's 32k-token window, so truncation does not arise here.

## Comparison — decider-4b vs Verdict through `ob1-jev/1`

`jev-compare.ts <base> <model>` issues the two-decision pattern (a binary validity
gate + a choice type) per SMD-1961 gold item and scores accuracy + time;
`jev-reliability.ts <base> <model>` bins the validity `p_true` to test whether a
model's confidence separates its correct calls. Both read the SMD-1961 evals dir
via `OB1_JEV_GOLD_DIR`.

Measured on the dogfood Mac, 320-item gold (κ=0.931), 2026-09-26:

| model | valid-acc | type-acc | exact | valid-precision | valid-recall | p50 ms/item | footprint |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **decider-4b** (4.2B, MPS) | **82.2%** | **76.8%** | **66.9%** | **88.7%** | **87.6%** | 418 | ~8.4 GB, load 12.3 s |
| verdict-v1.4 (151M, CPU onnx) | 55.3% | 20.8% | 17.2% | 73.3% | 63.9% | 95 | ~1.0 GB, load 2.0 s |

- **decider-4b wins accuracy decisively** (+56 type, +50 exact). Verdict is ~4×
  faster but its 20.8% typing / 17.2% exact make it unusable for entity typing.
- **Verdict's validity confidence is anti-informative on this task**: `p_true`
  pinned at ~0.5 (316/320 in [0.4, 0.6)), top-quartile *less* valid than bottom,
  **AUC 0.441** (worse than random). So there is no confident subset to cascade on
  and nothing to recalibrate — decider replaces Verdict for entity work, it does
  not cascade with or distil into it. Verdict/openJev is trained for short
  decisions (<71 tokens); entity-validity in long-document context is out of its
  distribution.
- Framing lever: decider's type-acc is 76.8% here (the contract's verbose
  `It is <description>` option labels) vs 93.1% in the direct eval with bare type
  names — caller wording matters.
