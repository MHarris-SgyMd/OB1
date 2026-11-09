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
its tier settings alone: `OB1_JEV_BASE_URL` / `OB1_JEV_MODEL` for the shared
tier, `OB1_CONSOLIDATE_DECIDER_URL` for decide mode's own.

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
  once. 0 reads every prompt whole;
- `JEV_MAX_QUEUED` (8) and `JEV_MAX_QUEUED_BYTES` (33554432, 32 MiB):
  SMD-2082's admission bound, below. A value that isn't a positive whole number
  stops the start, naming it.

## Serving: one read at a time, a bounded queue (SMD-3326)

- **One read at a time.** A request's read runs behind a lock on a single
  worker thread, never on the event loop. Two requests never interleave on the
  model, and `GET /health` and `GET /info` answer while a decide runs. The one
  thread is the hard guarantee: a request cancelled mid-read gives up the lock,
  and the next read still waits for the thread.
- **Admission, SMD-2082's knobs.** At most `JEV_MAX_QUEUED` requests are
  admitted at once, the one being read included, holding at most
  `JEV_MAX_QUEUED_BYTES` of body between them. Past either, the answer is 503
  with `Retry-After`: the admitted requests times the recent read time, at
  least 1 s. A request is refused before its body is read when its
  Content-Length shows it would pass the bound, and otherwise as soon as the
  bytes read pass it. The consolidation pass reads that 503 as an outage: it
  pauses on its own schedule, not `Retry-After`. After three pauses a one-shot
  run records the thought failed and stops the worker; a follower probes the
  tier's `/info`, which answers, and fails the thought on the next 503. Either
  way a good pair can end failed. So set `JEV_MAX_QUEUED` above the
  decide workers of every brain sharing the tier. In review pass 4 the default,
  8, lost nothing to 10 workers at a 1 s read; a bound of 1 under 4 workers
  failed two good thoughts. A body over `JEV_MAX_QUEUED_BYTES` on its own could
  never be admitted, so it gets 413, as a body over `JEV_MAX_BODY_BYTES` does,
  not a 503 that asks for a retry.
- **A caller that leaves while it waits** is dropped then (499), its admission
  and bytes released, and its request is never read. A caller that leaves while
  its body is still arriving gets 499 too. A failing check on whether the caller
  has left counts as "still here": the request is read.
- **A body that does not arrive in 30 s** is a 408, its admission and bytes
  released. Otherwise a caller that declared a body and stalled would hold its
  place until its connection closed, and eight such callers would keep the tier
  answering 503.
- **A context over `max_state_tokens` is refused: 422** (decided 2026-11-08).
  H2O's own shim cuts such a record to its head and tail around a `...` line
  and answers. The contract lets an adapter answer a cut it reads faithfully,
  marked `truncated: true`. This adapter treats no such cut as faithful: a
  verdict on a record whose middle went unread could settle the wrong thing.
  So the whole request gets the contract's 422, naming the decision and its
  token count, before it queues. Every result it does answer says
  `truncated: false`. The consolidation pass records that pair on the newer
  thought's claim, by the older thought's id and with the tier's words, then
  judges the thought's other pairs and goes on (`DecisionRefused` in
  `server-portable/jev.ts`). The claim ends failed, so `--retry-failed`
  revisits it. The refusal does not stop the pass, since another try would get
  the same answer. The context is both thoughts together, so a long thought can
  be refused in every pair it is in.
  - Every context is encoded to count its tokens. Its UTF-8 length is no bound,
    because the tokenizer normalizes to NFC first, which can lengthen a text:
    10,666 × U+FB2C is 31,998 bytes and 42,664 tokens.
  - The count runs on a thread of the default pool, not the event loop: 64
    contexts of 20,000 U+FB2C took 1.35 s, during which `/health` would not
    answer. A context the tokenizer cannot encode (a lone surrogate, which JSON
    allows) is a 422 naming the decision, recorded against that pair like a
    context too long.
  - The context cap of 20,000 characters keeps most text under the 32,000
    tokens. Only text past 1.6 tokens a character crosses it: a Yi syllable
    (U+A000) reads as 3 tokens, so 19,999 of them are 59,997 tokens.
  - `conformance.py` keeps the shim's cut (`Reader.truncate_state`), since
    H2O's published reads were made with it. Serving never uses it.
- **Held** by `test_serve.py`, with the standard library alone: no model and no
  web framework, since `serve.handle` is the whole of `POST /decide`. Portable
  server runs it in CI. Twenty-two mutants, one per mechanism, each fail it:
  eight worker threads, the read on the event loop, no count bound, no byte
  bound, no refusal before the body, no drop while waiting, no check at its
  turn, no 422, bytes never released, a body over the byte bound alone answered
  503, a body stream that breaks and escapes, a caller check that raises and
  escapes, tokens estimated from bytes, a 409 for the model's own name, a
  cancelled waiter's acquire left running, no body deadline, the token count on
  the event loop, an encode failure escaping, a per-chunk deadline, the prompt
  built without the record, an unset knob refused, and an unencodable context
  answered 400.

**Measured on the dogfood Mac** (2026-11-08, MPS float16, the real model, the
hardened adapter on a spare port with `JEV_MAX_QUEUED=4`):

| What | Result |
| -- | -- |
| One request (3 decisions, one context) | 0.37 s warm, 0.93 s the first |
| 7 requests at once | 4 answered, one after another, at 0.46, 0.84, 1.24 and 1.63 s; 3 got 503 with `Retry-After: 4` |
| `/health` during that burst | 31 of 31 answered, the slowest in 1 ms |
| 19,999 × U+A000 | 422 in 10 ms, naming decision 0 and its 59,997 tokens |
| 19,000 × U+1F600 (an emoji) | answered, under 32,000 tokens, in 17 s |
| `server-portable/jev.ts`'s `jevDecideMany`, 70 decisions | split under the 64 cap, every one answered, in 4.1–6.0 s; the 422 reached the client as its `http` error |

Through the client, a context of 4-byte characters stops at the client's own
check first: JavaScript counts each as two UTF-16 units, so 19,000 of them pass
its 20,000-unit cap. Python counts code points, so the adapter would accept
them.

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

- **As a cheap first pass behind the 7B,** the judge both dogfood brains run, it
  fails SMD-3058's rule when gated on its own confidence. Gated on P(outdates),
  it met the rule on the first 444 pairs: the 7B read only the possible
  supersessions, and at a ceiling of 0.5 the gate settled 93% of the candidates
  at the 7B's accuracy. It then failed the confirmation on 533 fresh pairs. It
  was 10 pairs less accurate than the 7B on the pairs it settled, all on
  relates_to links, which it calls unrelated more often. The cascade is
  declined.
- **Its one-pass verdicts come close to the judges'.** On the 170 labelled pairs
  its loosest band settles, it is right on 140, against the 7B's 143 and the
  27B's 156.
- **As the judge itself** (explored after the run), it is right on 259 of 324
  labelled pairs, where the 7B gets 239 and the 27B 263. It proposes 52 of the
  62 true supersessions (the 7B 2, the 27B 23), with 32 false proposals (3 and
  17). SMD-3114 measures it deciding supersession, with an LLM writing only the
  proposal.
- **The binary shape is this adapter's choice, not H2O's.** SMD-3058's "same
  subject?" question did poorly in it: it settled 93 pairs unrelated and was
  right on 33. It is the first thing to vary before another binary workload.

## SMD-3115: deciding in the consolidation pass

SMD-3114 measured H2O deciding supersession while an LLM writes only the
proposal, and the maintainer adopted it on 2026-10-18 as the consolidation
pass's decide mode, to be reviewed on the canary. With
`OB1_CONSOLIDATE_DECIDER=h2o-lightning-4b`, `db/consolidate.ts` asks this tier
prompt 4's five verdicts as one choice for every pair. When the top verdict is
outdates it asks `OB1_JUDGE_MODEL` only to write the proposal, two-sided with
the part rule, and both quotes must check out in the texts. Anything else leaves the pair at H2O's best verdict that proposes
nothing. A proposal records H2O's P(outdates) as its confidence, under the
pass's usual floor of 0.5. Since version 3 (SMD-3151) the writer is asked only
when that P(outdates) clears the floor: under it a proposal could not be
recorded, and the pair takes the relation H2O's distribution gives at the
floor, as a quote that fails does, else its edge is closed. Since version 4
(SMD-3203) the writer is first asked the mediated-pair test's link step
(`docs/subject-anchored-claims.md`) about such a pair, and about an evolves the
pass would store. A pair linked only through a third subject, or by one thought
naming the other's subject in passing, is related at most, and no proposal is
written for it.

**The record rule** (decide version 2, shelved 2026-10-18; the pass runs version
4, version 1's writer with its quotes read without markdown and asked only at
the floor, SMD-3151, behind the link step, SMD-3203) came from
the canary's first proposals.
There, 38 of 48 outdated a Linear ticket, 35 of those tickets already said Done,
and 23 gave the ticket's work being completed as the whole reason. The
maintainer's model: a done ticket stands as a historical record of past
understanding, and so does a session summary or a change record. Any later
source can outdate what it understood, by saying something different about the
same subject. Its work being reported done never does. Measured on the canary's
proposals, version 2 missed its bar twice, so it stays in
`evals/eval-judge-propose.ts` (`--record-rule`, `--v2-quotes`) for SMD-3116's
writers and is not the pass's.

## Deploy: a host process for decide mode (SMD-3326)

PyTorch MPS runs only on the host, so on a Mac the adapter runs beside the
stack, as Ollama's Option B does (decided 2026-10-25). Decide mode reaches it
through a setting of its own, so the shared tier (`OB1_JEV_*`, which capture's
genre facet asks) can serve another model (a tier per caller, decided
2026-10-26):

```bash
# deploy/.env
OB1_CONSOLIDATE_DECIDER=h2o-lightning-4b
OB1_JUDGE_MODEL=qwen3.8:27b                                   # the writer SMD-3114 measured
OB1_CONSOLIDATE_DECIDER_URL=http://host.containers.internal:8022   # host.docker.internal under Docker Desktop
OB1_CONSOLIDATE_DECIDER_LOCAL=1
```

Unset, `OB1_CONSOLIDATE_DECIDER_URL` falls back to the shared tier at
`OB1_JEV_BASE_URL`, with `OB1_JEV_LOCAL`, and `OB1_JEV_MODEL`, when set, must
then name the decider; brains set up before SMD-3326 keep working that way.

**Moving such a brain to its own tier,** unset `OB1_JEV_BASE_URL`,
`OB1_JEV_LOCAL` and `OB1_JEV_MODEL`, or point them at another tier. Left at
:8022, they keep H2O the shared tier: preflight still dials it on every start
and fails the start when it is down, and capture's genre facet keeps asking
it. Unset, the genre facet is off.

**Keep it running.** `com.openbrain.h2o-tier.plist.example` is a LaunchAgent
for it. It starts the adapter at login, restarts it when it exits, and logs to
`~/Library/Logs/ob1-h2o-tier.log`. Point it at a `serve.py` that won't move
under it: a checkout pinned to a release, not a worktree you work in.

The template starts the adapter offline (`HF_HUB_OFFLINE=1`), so a start never
reaches the network. That only works once the weights are cached, so fetch them
first with one start by hand. It prints a ready line once the 9.1 GB are down
and checked; stop it then. Then install the agent:

```bash
VENV=<decider-4b's venv>; CHECKOUT=<a stable checkout>              # absolute paths
JEV_PORT=8023 "$VENV/bin/python" -I "$CHECKOUT/jev/h2o/serve.py"   # once: wait for "ready", then Ctrl-C
sed -e "s|__PYTHON__|$VENV/bin/python|" \
    -e "s|__SERVE_PY__|$CHECKOUT/jev/h2o/serve.py|" \
    -e "s|__HOME__|$HOME|" "$CHECKOUT/jev/h2o/com.openbrain.h2o-tier.plist.example" \
  > ~/Library/LaunchAgents/com.openbrain.h2o-tier.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.openbrain.h2o-tier.plist
curl -s http://127.0.0.1:8022/health                          # ok once the weights are loaded
```

To move it to another `serve.py`, rewrite the plist, then `launchctl bootout
gui/$(id -u)/com.openbrain.h2o-tier` and bootstrap it again. To remove it,
boot it out and delete the plist. One adapter serves every brain on the
machine (stable and the canary reach the same :8022), and its queue bound
holds them all. A compose service for Linux hosts stays a later option.

To try it by hand instead:
`JEV_PORT=8022 <venv>/bin/python -I jev/h2o/serve.py`.

- **When the tier is down.** Preflight's decide tier row dials
  `OB1_CONSOLIDATE_DECIDER_URL` on every server start and warns when nothing
  answers. The server still starts, since only the consolidation pass asks this
  tier, and capture and search don't wait on it. Until it answers, the
  consolidation pass decides nothing:
  - A follower (sleep's) checks the tier at its start. It waits for one that
    does not answer, and refuses one serving another model or not answering as
    the tier.
  - A one-shot `bun db/consolidate.ts` makes no start check. Each worker
    retries its first thought (pauses of 5, 15 and 45 s), records that thought
    failed, and stops; the rest stay pending for the next run. A tier serving
    another model (its 409), or a URL that is not a tier and answers a 4xx,
    stops every worker at the first call, marks nothing failed, and names
    `OB1_CONSOLIDATE_DECIDER_URL` and the decider. A URL that answers 200
    outside the contract fails each thought it is asked about instead.
- **An outage mid-pass** is handled like the judge's: a follower checks the
  writer's chat endpoint and then the tier's `/info` before it claims anything,
  and waits out an outage of either.
- **The pass key** is `consolidate:h2o-lightning-4b+<writer>@p4d4`, so turning
  decide mode on, or moving to a new decide version, starts a fresh pass over
  the pool. Proposals are reviewed as
  the judge's are (`bun db/consolidate.ts --list`, then `--accept` or
  `--reject`). Each one's lineage records the decider, the writer, decide
  mode's prompt hash, and what each model said.
- **Memory and co-load** (measured 2026-11-09 on the dogfood Mac, 64 GB:
  `evals/eval-jev-coload.ts --n 30` against the deployed :8022, beside
  Ollama's embedder and the 27B writer, `OLLAMA_NUM_PARALLEL=3`,
  `OLLAMA_MAX_LOADED_MODELS=2`):
  - The tier's footprint is 9.8 GB (`footprint -p`), steady through the run.
    With the 7B and the 27B loaded beside it, the box had 6.1 GB free.
  - The tier evicted nothing: it isn't an Ollama model and never asks Ollama
    to load one. Ollama evicted one of its own models at each load, since
    `OLLAMA_MAX_LOADED_MODELS=2` holds two of the three. Loading the 27B
    evicted the embedder, and the embedder's reload evicted the 7B. That's
    SMD-3034's churn between Ollama's models, which the tier neither causes
    nor relieves.
  - The three share the GPU, so each slows while the others run:

    | Call | Alone: calls, p50 / p95 | Beside the other two: calls, p50 / p95 | p50 ratio |
    | -- | -- | -- | -- |
    | Embedding | 30, 22 / 45 ms | 285, 44 / 54 ms | 1.99× |
    | 27B chat, 16 tokens | 10, 863 / 10,512 ms | 9, 1,437 / 1,465 ms | 1.67× |
    | Decision | 30, 116 / 148 ms | 36, 366 / 387 ms | 3.15× |

    The 27B's p95 alone includes a model reload.
  - Decide mode itself, measured on the real model on a spare port with a stub
    writer, judged 1.7–1.8 pairs a second for one or two brains, since the
    tier reads one request at a time. Nothing failed at the default
    `JEV_MAX_QUEUED=8`.
