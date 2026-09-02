# evals — choosing local models by measurement

Two model choices sit in this stack, and both were originally made by size and
convention rather than by evaluation. These harnesses are the correction, and they
are here so the decision is auditable and re-runnable when better models appear.

## Prerequisites

- [Ollama](https://ollama.com) running locally (`brew install ollama; ollama serve`)
- [Bun](https://bun.sh) 1.4+
- The models you want to compare, pulled

## Steps

```bash
cd evals
ollama pull embeddinggemma nomic-embed-text bge-m3   # etc.
bun run retrieval      # embedding models
bun run extraction     # metadata models
```

Or name models directly:

```bash
bun eval-retrieval.ts embeddinggemma bge-m3
OB1_EVAL_TEMP=0 bun eval-extraction.ts qwen2.5:7b llama3.2
```

**Always pass `OB1_EVAL_TEMP=0` when comparing extraction models.** Without it the
provider samples and a single run is not reproducible — see below.

## Expected outcome

`retrieval` prints Recall@1 per difficulty slice plus overall MRR; `extraction`
prints a per-field score out of 8 for each model, then a failure detail line.

## What retrieval measures, and why the first attempt was useless

A first version used twenty short, topically distinct thoughts. Everything scored
85–95% and a 45 MB model tied a 669 MB one — the benchmark was saturated and
measured nothing. `eval-retrieval.ts` adds three slices that discriminate:

| Slice | What it catches |
| --- | --- |
| `near-dup` | Clusters on one subject where only one member answers. This is what a growing brain looks like — the tenth note about certificates — and it needs discrimination, not topic matching. |
| `long` | ~660-token thoughts with the answer in the **final sentence**. Models that average over a long document wash the conclusion out. |
| `temporal` | Dates and numbers where a distractor is lexically closer than the answer. |

Queries are phrased in different words from the thought they should retrieve, so
lexical overlap does not carry them.

## Results, 2026-09-02, Ollama 0.33.2

Twenty thoughts, twenty queries. R@1 per slice.

| model | dims | ctx | easy | near-dup | temporal | long | MRR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **embeddinggemma** | **768** | 2048 | 5/5 | 7/8 | 4/4 | **3/3** | **0.975** |
| bge-m3 | 1024 | 8192 | 5/5 | 7/8 | 4/4 | 3/3 | 0.975 |
| snowflake-arctic-embed2 | 1024 | 8192 | 5/5 | 7/8 | 4/4 | 3/3 | 0.975 |
| qwen3-embedding:0.6b | 1024 | 32768 | 5/5 | 7/8 | 4/4 | 2/3 | 0.950 |
| nomic-embed-text | 768 | 2048 | 4/5 | 7/8 | 4/4 | 2/3 | 0.912 |
| mxbai-embed-large | 1024 | 512 | 5/5 | 7/8 | 4/4 | 1/3 | 0.896 |
| nomic-embed-text-v2-moe | 768 | 512 | 4/5 | 7/8 | 3/4 | 1/3 | 0.852 |
| all-minilm | 384 | 512 | 4/5 | 6/8 | 4/4 | 1/3 | 0.835 |
| granite-embedding | 384 | 512 | 4/5 | 6/8 | 4/4 | 1/3 | 0.827 |
| bge-large | 1024 | 512 | 3/5 | 7/8 | 3/4 | 1/3 | 0.797 |

Ten models, every embedding-capable entry in the Ollama library that fits.
`embeddinggemma` leads and nothing has displaced it — including two that look like
they should. `nomic-embed-text-v2-moe` is the newer nomic and scores *below* the
model it replaces. `bge-large` is the bigger sibling of `bge-m3` and scores well
below it.

**The `ctx` column here is what `ollama show` reports, which is not what Ollama
serves** — see the long-document section above; the effective cap is 2048 for every
model below except `qwen3-embedding`. At the 616-token documents in this corpus the
distinction does not bite, so the analysis that follows still holds.

**The `ctx` column explains almost the whole table.** The long documents are ~616
tokens with the answer in the final sentence, so a 512-token model physically
cannot see the answer. Every model at 512 scores exactly 1/3; every model at 2048
or above scores 2/3 or 3/3. That is not a subtle quality difference — it is a
hard architectural cut, and it is invisible at capture time because nothing errors.

Note that Ollama serves `nomic-embed-text` at **2048** tokens, not the 8192 its
model card advertises. Check `ollama show <model>` rather than the card.

### A confound this table used to have

An earlier version of this benchmark gave each long document a distinctive opening
line, and `bge-large` scored 3/3 on the long slice despite a 512-token window that
made the answer unreachable. It was matching the lead, not retrieving the tail.
Making all three leads identical drops it to 1/3 and its overall MRR from 0.851 to
0.797. The slice now measures what it claims to.

**`embeddinggemma` is the recommendation.** It ties the best MRR, is the only
768-dimension model to do so — meaning it is a drop-in for a schema already built
at 768 — and it is 621 MB against 1.2 GB for the 1024-dimension models.

### The long-document result is dilution, not truncation

The obvious explanation was context windows: `mxbai-embed-large` and
`granite-embedding` are 512-token models and the documents are ~660 tokens.

That explanation is wrong. Changing only the final sentence of a long document and
re-embedding shows every model *does* read the tail — but by wildly different
amounts:

| model | cos(conclusion A, conclusion B) |
| --- | --- |
| embeddinggemma | 0.816 |
| bge-m3 | 0.914 |
| nomic-embed-text | 0.982 |
| granite-embedding | 0.986 |
| mxbai-embed-large | 0.989 |

At 0.989, two documents reaching **opposite conclusions** are 98.9% identical.
That is dilution: the conclusion is present but drowned. It matters here because a
captured thought is so often long context with one decision at the end — and a
diluting model makes that thought unfindable by its decision.

### Prefixes did not help

`nomic-embed-text` is documented as wanting `search_document:` / `search_query:`
prefixes, which OB1 does not send. Adding them made retrieval slightly *worse*
(MRR 0.950 → 0.929 on the v1 set). At this sample size that is noise, but it is
not the improvement the docs imply.

## What extraction measures

The metadata call fills `type`, `people`, `topics`, `dates_mentioned` and
`action_items`. Those are not decoration: `type` drives `list_thoughts` filtering,
`people` and `topics` drive `thought_stats`. Getting them wrong is not a crash — it
is a brain that quietly cannot find things.

Scored per field because they fail independently. A hallucinated person is treated
as worse than none, since it shows up in your stats as someone you know.

## Results, 2026-09-02

Eight captures, max 8 per field.

| model | json | type | people | dates | topics | actions | total | sec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **qwen2.5:7b** | 8 | 8 | 8 | 6 | 8 | 7 | **45/48** | 11.5 |
| llama3.2 | 8 | 6 | 8 | 7 | 7 | 6 | 42/48 | 7.0 |
| phi4-mini | 8 | 8 | 8 | 7 | 5 | 6 | 42/48 | 7.4 |
| gemma3:4b | 8 | 7 | 7 | 6 | 7 | 5 | 40/48 | 8.1 |

`qwen2.5:7b` is the only model with **no structural failures**. The others:

- `llama3.2` — returned `action_items` as a `type` (outside the enum), and one
  capture with no topics at all
- `gemma3:4b` — omitted `type` entirely once, and one capture with no topics
- `phi4-mini` — structurally clean but weak topics (5/8)

The `llama3.2` failures are the same ones observed on real captures before this
eval existed: an out-of-enum type, and a capture with no topics. The eval
reproduces them, which is the point.

### Reasoning models are the wrong shape here

`qwen3:4b` takes **17.8s** for one extraction against ~2s for the others, because
it emits thinking tokens first. This call happens on every capture, so that is
disqualifying regardless of quality.

### Sampling temperature mattered more than model size

The server sent no `temperature`, so extraction ran at the provider default — 0.8
on Ollama — for a task with exactly one right answer. Three runs of the full
benchmark with `qwen2.5:7b`:

| | run 1 | run 2 | run 3 | spread |
| --- | --- | --- | --- | --- |
| provider default | 79/84 | 82/84 | 80/84 | **3 points** |
| `temperature: 0` | 81/84 | 81/84 | 81/84 | **0** |

Temperature 0 is deterministic, scores above the sampled mean, and reaches 36/36
on the hard slice every time. It also makes a bad capture *reproducible*, which is
worth more than the point of score — an intermittently wrong extraction cannot be
debugged.

The server now sends `temperature: 0`, overridable with
`OB1_METADATA_TEMPERATURE`. This was a one-line change and it outperformed
doubling the model.

### Larger models: a small accuracy gain at a large latency cost

The first pass capped at 7B with no justification. Revisited on a 64 GB machine,
at temperature 0:

| model | size | core | hard | total | sec (14 captures) | structural failures |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-oss:20b | 13 GB | **48/48** | 35/36 | **83/84** | **93.6** | 1 invented person |
| **qwen2.5:7b** | 4.7 GB | 45/48 | **36/36** | 81/84 | 16.7 | **none** |
| qwen2.5:14b | 9.0 GB | 46/48 | 35/36 | 81/84 | 27.1 | 1 capture with no topics |
| llama3.2 | 2.0 GB | 44/48 | 32/36 | 76/84 | 7.8 | 2 with no topics, 1 invented person |

Two different results, and it is worth not collapsing them:

**Same family, 2× the parameters, no gain.** `qwen2.5:14b` matched the 7B's total
exactly while taking 1.7× as long, and dropped a `topics` field the 7B kept.

**Different family, 3× the parameters, +2 points.** `gpt-oss:20b` is genuinely the
most accurate — a perfect core slice, and the only model to get every date and
every action item right. It costs **5.6× the latency**: ~6.7s per capture against
~1.2s. It also still invented "dentist" as a person on the proper-noun case, which
the 7B did not, so more parameters did not fix the failure that matters most for
`thought_stats`.

So the honest reading is: accuracy is still improving at 20B, but slowly, and this
call sits in the interactive path of every capture. `qwen2.5:7b` is the default
because ~1.2s with no structural failures beats ~6.7s with one. Pick `gpt-oss:20b`
if captures are batched or latency is irrelevant to you.

What did **not** help: nothing about extraction from a short note is
capability-limited in the way model choice implies. The temperature fix above was
worth more than either size step, and cost nothing.

### Gemma 4, and the reasoning tax

`gemma4` shipped after this work started and would not have been tested without
being asked for. It is 8B, 131k context, multimodal, and **thinks by default** —
which turns out to matter more than the model itself.

At temperature 0:

| model | size | core | hard | total | per capture | structural failures |
| --- | --- | --- | --- | --- | --- | --- |
| **qwen3.8:27b** | 18 GB | **48/48** | **36/36** | **84/84** | 3.5s | **none** |
| gemma4 + reasoning | 9.6 GB | 47/48 | 36/36 | 83/84 | 7.7s | none |
| **qwen2.5:7b** | 4.7 GB | 45/48 | **36/36** | 81/84 | 1.4s | **none** |
| gemma4 − reasoning | 9.6 GB | 46/48 | 34/36 | 80/84 | 1.4s | 1 invented person |
| gpt-oss:20b | 13 GB | 48/48 | 35/36 | 83/84 | 6.7s | 1 invented person |
| granite4.2:30b | 17 GB | 47/48 | 35/36 | 82/84 | 4.8s | 1 invented person |
| nemotron-3.5-lightning:30b-a3b | 23 GB | 46/48 | 35/36 | 81/84 | 1.15s | none |
| **lfm2.5:8b** | 5.2 GB | 42/48 | 33/36 | 75/84 | **0.54s** | **none** |
| functiongemma:270m | 301 MB | 27/48 | 22/36 | 49/84 | 8.8s | 11 with no topics, 1 bad JSON |

**`qwen3.8:27b` is the first model to score a perfect 84/84**, with no structural
failures, and it does it in 3.5s per capture — more accurate *and* 2.2x faster than
`gemma4 + reasoning`, which it replaces as the accuracy option. It costs 18 GB and
2.9x the latency of `qwen2.5:7b` for three points, so the 7B stays the default; but
if you want the most correct metadata a workstation can produce, this is now it.
It is also the one case in this whole sweep where a much larger model genuinely
paid.

`nemotron-3.5-lightning:30b-a3b` is the MoE story again: ~3B active, 81/84 with no
failures at 1.15s per capture — matching `qwen2.5:7b`'s score and speed from a
23 GB model. Interesting, but it buys nothing the 4.7 GB model does not already do.

`lfm2.5:8b` is worth calling out separately: an MoE with roughly 1B active
parameters, it is **2.2× faster than `qwen2.5:7b`** with zero structural failures,
for six points of accuracy. If you capture constantly and want the tool to feel
instant, that is the trade to take. It is the only model tested that is both
faster than the default and clean.

**`gemma4` with reasoning is the best result on this benchmark** — it ties
`gpt-oss:20b`'s 83/84 but with zero structural failures, in a smaller model.
Reasoning is what buys it: turning reasoning off costs 3 points and introduces a
hallucinated person, while making it 5.5× faster.

`qwen2.5:7b` stays the default because ~1.4s with no failures beats ~7.7s for two
more points on a fourteen-case benchmark. Choose `gemma4` with
`OB1_METADATA_REASONING=on` if capture latency is not interactive for you.

`functiongemma:270m` scored badly, but that is probably my prompt rather than the
model: its declared capabilities are `completion` and `tools`, not JSON mode, and
it is built to emit tool calls. Driving it through `response_format: json_object`
is using it wrong. Reaching it properly would mean giving the extraction call a
tool schema instead of a prose prompt — plausibly a better design, and untested.

#### `think: false` is ignored on the OpenAI-compatible endpoint

This is the practically important finding, and it is easy to get wrong:

| how | latency | reasoning emitted |
| --- | --- | --- |
| `/v1`, no flag | 7.5s / 9.6s | 960 chars |
| `/v1` + `think: false` | 15.4s / 8.7s | **960 chars — silently ignored** |
| `/v1` + `reasoning_effort: "low"` | 4.4s / 4.3s | 960 chars — also ignored |
| **`/v1` + `reasoning_effort: "none"`** | **0.5s / 0.5s** | **0** |
| `/api/chat` + `think: false` | 0.5s / 0.5s | 0 |

Ollama's native endpoint takes `think: false`; the OpenAI-compatible one takes
`reasoning_effort`. Passing the wrong one costs 15× latency and reports nothing.
Verified harmless on `qwen2.5:7b`, `llama3.2` and `phi4-mini` — all returned 200
with valid JSON, several of them faster.

The server now sends `reasoning_effort: "none"` by default, overridable with
`OB1_METADATA_REASONING`. As more open-weight models ship thinking on by default,
this stops each one silently multiplying capture latency.

### DeepSeek and Kimi

Asked for explicitly, so checked explicitly.

**The flagships do not fit.** `deepseek-v3` and `deepseek-v3.1` are 404 GB in the
Ollama library; Kimi K2 is a ~1T-parameter MoE, larger still. On 64 GB neither is
runnable at any quantisation worth using.

**Kimi is in the library — my earlier claim was wrong.** I guessed at tag names
(`kimi-linear`, `kimi-vl`, `kimi-dev`), got 404s, and concluded Kimi was
unavailable. Enumerating the library properly shows `kimi-k3`, `kimi-k2.6` and
`kimi-k2.7-code`. They are still MoE models far past 64 GB, so the conclusion
holds — but it was reached the wrong way, by guessing instead of listing.

**DeepSeek-R1's distills run, and lose badly on this task.** `deepseek-r1:8b`
(5.2 GB) at temperature 0:

| model | core | hard | total | sec (14 captures) | per capture |
| --- | --- | --- | --- | --- | --- |
| qwen2.5:7b | 45/48 | **36/36** | **81/84** | **16.7** | **~1.2s** |
| deepseek-r1:8b | **48/48** | 30/36 | 78/84 | 482.1 | **~34s** |

A perfect core slice — and then 30/36 on hard, one capture that returned unusable
JSON, and **29× the wall-clock**. It spends the budget in the wrong place: 5,064
characters of reasoning to pull two fields out of one sentence.

Ollama does at least route that reasoning into a separate `reasoning` field, so
`response_format: json_object` still holds — R1 is not broken here, just
pathologically expensive. `deepseek-r1:14b` was not scored: at ~34s per capture
for the 8B, a larger distill can only be slower, and the disqualification is
latency rather than quality.

This is the third reasoning model to fail the same way — `qwen3:4b` at 17.8s,
`deepseek-r1:8b` at 34s. The pattern is not about any one family. **Chain-of-thought
is the wrong tool for a fixed-schema extraction that runs on every capture.**

### The embedding side has a hard ceiling, not a resource one

Scaling embeddings up runs into pgvector, not memory:

| model | dims | usable? |
| --- | --- | --- |
| qwen3-embedding:0.6b | 1024 | yes — scored 0.950, *below* embeddinggemma's 0.975 |
| qwen3-embedding:4b | **2560** | no — exceeds the HNSW limit of 2000 |
| qwen3-embedding:8b | 4096 | no |

`qwen3-embedding:0.6b` has roughly twice the parameters of `embeddinggemma` and
sixteen times the context (32k vs 2k), and still scored lower. Above 2000
dimensions the column can be created but no HNSW index can be built, so every
search becomes a full scan — a bigger embedding model would need Matryoshka
truncation to be usable at all, which Ollama does not expose.

## What the library sweep turned up, and what is still untested

Enumerating `ollama.com/library?sort=newest` returns 239 models, many of them
newer than the knowledge these choices were first made with. That is the argument
for re-running these harnesses rather than trusting any snapshot, this one
included.

Post-cutoff families that exist and were **not** evaluated, with why:

| family | smallest tag | why not tested |
| --- | --- | --- |
| `qwen3.6`, `qwen3.5` | 18 GB | Siblings of the tested `qwen3.8:27b`; unlikely to beat it. |
| `glm-5.3-flash` | — | **Cloud-only** (`:cloud`). No local weights published, so it is out of scope for a local brain. |
| `deepseek-v4-flash`, `deepseek-v4-pro` | unknown | DeepSeek V4 exists; sizes not resolved. |
| `minimax-m3`, `kimi-k3`, `qwen3.8-flash-next` | 105 GB+ where known | Beyond 64 GB. |

Three were pulled and tested. `granite4.2:30b` scored 82/84 with an invented
person at 4.8s, and `nemotron-3.5-lightning:30b-a3b` scored 81/84 at 1.15s — both
the familiar pattern, a much larger model landing at or just above `qwen2.5:7b`.
`qwen3.8:27b` broke it: 84/84, clean, 3.5s. So the sweep was worth running.

The gap for the rest is not that they are known to be worse — it is that they are
unmeasured. Anyone re-running this should start with `qwen3.8:27b`.

## How this compares to public benchmarks

Worth asking whether these results are typical or an artefact of a 20-document
corpus. Checked against MTEB and the retrieval literature:

**The winner agrees with the public data.** `embeddinggemma-300m` scores 69.67 on
MTEB English v2 and ranks first among sub-500M models by a wide margin — 17 places
above the next one on the multilingual board. Its win here is not a small-sample
fluke.

**`bge-large` below `bge-m3` agrees too.** MTEB retrieval puts them at roughly 55
and 58. Same direction; the gap is wider here because our long slice punishes
`bge-large`'s 512-token window, which MTEB's mostly-short corpora do not.

**The long-document finding is textbook.** [Quantifying Positional Biases in Text
Embedding Models](https://arxiv.org/abs/2412.15241) finds that content later in a
document contributes less to the embedding, and that edits at the *start* move
cosine similarity up to 12.3% more than the same edits at the end — present even
when the context window is not exceeded, so it is not purely truncation.
["Dwell in the Beginning"](https://arxiv.org/pdf/2404.04163) reports the same. Our
result — change only the final sentence of a long note and `nomic-embed-text`'s
vector barely moves — is a known, named failure mode, not a quirk of this corpus.

**One result looks like it contradicts the leaderboard, and does not.**
`nomic-embed-text-v2-moe` is the newer model and scores at or above v1.5 on
headline MTEB, yet loses here. The model card explains it: v2-moe is a
**multilingual** model (~100 languages) with a **512-token** window, where v1.5 is
English-first with a longer one. This corpus is English-only with 616-token
documents — precisely the case v2-moe was not built for. Newer is not worse; it is
optimised for a different job.

**`qwen3-embedding:0.6b` losing to a smaller model is also expected.** It scores
higher than `embeddinggemma` on MTEB multilingual (64.33 vs 61.15), but
EmbeddingGemma beats it specifically on instruction retrieval and reranking — and
this task is short-query retrieval in English.

**Which is the general caveat.** MTEB is widely held to be contaminated by now —
models train on its splits, and two models within a point of each other on the
board routinely sit eight to twelve points apart on a few hundred queries from a
real corpus. That is the argument for this directory existing. The public numbers
were useful here as a *cross-check* — they are what exposed the lead-matching
confound above — but they were not a substitute for measuring.

## Does chunking actually work? Measured end to end

`eval-chunking-e2e.ts`. The CI test for chunking uses a stub provider, which is
right for CI but means the *benefit* was asserted rather than measured — a stub
that refuses over-batch input cannot show what real truncation costs or what
chunking buys back. This runs the real server over MCP against real Ollama and
real Postgres. "Chunking off" is the same server with `OB1_CHUNK_TOKENS` set
high enough that nothing splits: exactly the pre-007 behaviour.

Four documents per row, identical but for the final sentence, each queried by
that sentence. Found means ranked first.

| document | chunking off | chunking on | |
| --- | --- | --- | --- |
| ~551 tokens | 4/4 | 4/4 | 0 chunk rows — correctly left alone |
| ~2285 tokens | 4/4 | 4/4 | 12 chunk rows |
| ~4631 tokens | **1/4** | **4/4** | 20 chunk rows |
| ~9221 tokens | **1/4** | **4/4** | 36 chunk rows |

1/4 is chance. So the failure begins between 2.3K and 4.6K tokens — consistent
with the 2048-token batch — and chunking removes it completely.

The 9221-token row is the interesting one. Earlier in this file, raising
`num_batch` recovered 4K documents but **not** 8K ones, because past that size the
answer stops being truncated and starts being diluted, and no provider setting
fixes dilution. Chunking scores 4/4 there anyway — it never asks one vector to
represent nine thousand tokens, so the problem does not arise. That makes it a
better answer than either a bigger batch or a longer-context model.

An earlier version of this table labelled its rows by guesswork and reported a
"4K" row that was really ~1800 tokens, under the ceiling, making the feature look
useless at that size. Sizes are now measured from the document actually built.

## Long documents: the context column was wrong

`eval-longctx.ts`. Everything else here uses short text — the synthetic "long"
slice is 616 tokens and the real issue corpus averages ~125 — so the whole
`embeddinggemma` recommendation rested on evidence that never approached a context
limit. A personal brain is exactly where a long capture happens: a pasted
transcript, a meeting write-up, a design note.

Four documents per bucket, identical except the final sentence, and the query asks
for that final sentence. A document truncated before its tail is unfindable.

| model | `ollama show` says | 1K | 2K | 4K | 8K |
| --- | --- | --- | --- | --- | --- |
| **qwen3-embedding:4b !instruct @1024** | 40960 | 4/4 | 4/4 | **4/4** | **4/4** |
| embeddinggemma | 2048 | 4/4 | 4/4 | 1/4 | 1/4 |
| nomic-embed-text | 2048 | 4/4 | 4/4 | 1/4 | 1/4 |
| bge-m3 | **8192** | 4/4 | 4/4 | **1/4** | **1/4** |
| snowflake-arctic-embed2 | **8192** | 4/4 | 4/4 | **1/4** | **1/4** |
| granite-embedding | 512 | 1/4 | 1/4 | 1/4 | 1/4 |

1/4 is chance. `bge-m3` and `snowflake-arctic-embed2` advertise 8192 and fail at
4K, which is not a quality result — it is a plumbing one.

### The cap is `num_batch`, not `num_ctx` — and it is fixable

Ollama's embedding limit is the **batch size**, not the context window. llama.cpp
needs an embedding input to fit in a single batch, and Ollama's default batch is
2048 — which is why the ceiling is 2048 for models declaring 512, 2048 and 8192
alike, and why `qwen3-embedding` escapes it (its published parameters set a larger
batch).

What works, verified by `prompt_eval_count`:

| lever | effect on `bge-m3`, 4K document |
| --- | --- |
| nothing (default) | 2048 tokens |
| model's declared 8192 window | 2048 — ignored |
| `options.num_ctx: 8192` | 2048 — ignored |
| `PARAMETER num_ctx 8192` in a Modelfile | 2048 — ignored |
| `OLLAMA_CONTEXT_LENGTH=8192` on the server | 2048 — ignored |
| **`options.num_batch: 4096`** | **3594 — the whole document** |
| **`PARAMETER num_batch 8192` in a Modelfile** | **3594 — the whole document** |

The Modelfile form is the one that matters here, because it is baked into the
model and therefore applies to **every** endpoint — including the OpenAI-compatible
`/v1/embeddings` that this server actually calls, which has no `options` field to
pass anything through:

```bash
printf 'FROM bge-m3\nPARAMETER num_batch 8192\nPARAMETER num_ctx 8192\n' > Modelfile
ollama create bge-m3-long -f Modelfile
```

Retrieval through the normal `/v1` path recovers accordingly:

| model | 1K | 2K | 4K | 8K |
| --- | --- | --- | --- | --- |
| bge-m3 | 4/4 | 4/4 | **1/4** | 1/4 |
| bge-m3 + `num_batch 8192` | 4/4 | 4/4 | **4/4** | 1/4 |
| qwen3-embedding:4b | 4/4 | 4/4 | 4/4 | **4/4** |

### The 4K and 8K failures are not the same failure

Worth separating, because only one of them is fixable.

**4K was truncation.** `bge-m3` embedded 2048 of ~3600 tokens and the answer was
never in the vector. Raising the batch fixes it completely.

**8K is not.** With the batch raised, `bge-m3` embeds all 7182 tokens — verified —
and *still* scores 1/4. Nothing is being cut; the final sentence is simply washed
out of a vector averaging over seven thousand tokens. That is the positional-bias
effect measured in
[arXiv 2412.15241](https://arxiv.org/abs/2412.15241), which reports the bias
persisting *even when the context window is not exceeded*. No configuration fixes
it. `qwen3-embedding:4b` handles the same document at 4/4, presumably because 7K
sits mid-range in a 40960-token training window rather than at its edge.

So: raise the batch if you capture documents in the low thousands of tokens, and
use `qwen3-embedding:4b` if you capture things longer than that. Chunking the
document before capture is the other answer, and the one this server does not do.

### Ollama caps embeddings at 2048 tokens by default

`/api/embed` returns `prompt_eval_count`, so this is directly observable rather
than inferred:

| model | 4K document | 8K document |
| --- | --- | --- |
| bge-m3 | embedded **2048** | embedded **2048** |
| snowflake-arctic-embed2 | embedded **2048** | embedded **2048** |
| embeddinggemma | embedded 2048 | embedded 2048 |
| granite-embedding | embedded 512 | embedded 512 |
| **qwen3-embedding:4b** | embedded **3357** | embedded **6711** |

Everything except `qwen3-embedding` is cut at 2048, silently, with no error and no
warning in the response. `OLLAMA_CONTEXT_LENGTH=8192` on the server does not lift
it either — tested with a restart, still 2048 for all three.

So the `ctx` column in the table further down reports what `ollama show` claims,
not what you get by default. The cause and the fix are above.

## Validation against a real corpus

Everything else in this file is measured on twenty thoughts I wrote to be
adversarial. `eval-real.ts` runs the same comparison over **97 closed issues from
a real Linear tracker** — body as the document, title as the query, no hand
labelling — to find out which conclusions survive data nobody wrote for the test.

The corpus is internal engineering data from a healthcare company, so it is **not
committed** and it ran entirely against local Ollama. Nothing was sent to a hosted
embedding provider. That constraint is the whole argument for the local path being
a supported option rather than a curiosity. Point `OB1_EVAL_CORPUS` at your own
JSON (`[{id, title, text}]`) to reproduce this shape on your own data.

| model | dims | R@1 | R@5 | MRR | synthetic MRR | rank move |
| --- | --- | --- | --- | --- | --- | --- |
| **qwen3-embedding:4b !instruct @1024** | 1024 | **90%** | 97% | **0.933** | 0.975 | **+2 → 1st** |
| qwen3-embedding:8b !instruct @1024 | 1024 | 88% | 97% | 0.919 | — | — |
| snowflake-arctic-embed2 | 1024 | 87% | 99% | 0.921 | 0.975 | — |
| qwen3-embedding:0.6b !instruct | 1024 | 87% | 99% | 0.918 | 0.950 | +2 |
| embeddinggemma | 768 | 86% | 99% | 0.914 | 0.975 | **−2** |
| granite-embedding | 384 | 86% | 96% | 0.902 | 0.827 | **+4** |
| bge-m3 | 1024 | 86% | 97% | 0.901 | 0.975 | **−4** |
| bge-large | 1024 | 82% | 97% | 0.894 | 0.797 | +3 |
| nomic-embed-text | 768 | 82% | 97% | 0.890 | 0.912 | −2 |
| mxbai-embed-large | 1024 | 80% | 99% | 0.882 | 0.896 | −2 |
| all-minilm | 384 | 79% | 95% | 0.869 | 0.835 | −2 |

**Spearman rank correlation between the two corpora: 0.64.** Directionally useful,
unreliable at the top — and the top is the only part anyone picks from.

### What changed, and one conclusion that was wrong

**The synthetic corpus was saturated.** Four models tied at 0.975 there. Here they
spread across 0.933–0.901 and separate cleanly. Twenty queries could not tell them
apart; ninety-seven can.

**"Five leaderboard points bought nothing" was an artefact of that saturation.**
Above, `qwen3-embedding:4b` ties `embeddinggemma` on the synthetic set and I
concluded the MTEB gap did not transfer. On real data it wins outright — 0.933 vs
0.914, and the best R@1 of anything tested. The leaderboard was directionally
right and my corpus was too easy to show it. It still costs 3x the embedding time
and 4x the disk, so `embeddinggemma` remains a defensible default; but the claim
that the bigger model buys nothing does not survive.

**`granite-embedding` is the surprise.** Last on the synthetic set (0.827) and
fifth here (0.902) — within 0.012 of `embeddinggemma` at **62 MB**, a tenth the
size. Real issues are ~500 characters, so the long-document slice that dominated
the synthetic ranking never fires. If your captures are short, the tiny model is
very nearly as good and the ranking above over-punishes it.

**`bge-m3` fell furthest** (1st → 6th), for the mirror-image reason: much of its
synthetic standing came from the long-document slice.

**Bigger does not hold within a family either.** `qwen3-embedding:8b` reports 75.22
on MTEB English v2 against the 4B's 74.60, and scores *below* it here — 0.919
against 0.933 — while taking 40% longer. Verified locally: 4096 native, and Ollama
honours `dimensions` down from it. Two model sizes from one family, one benchmark
apart, and the leaderboard order still did not hold on real data.

The general lesson is the one the MTEB critics make, reproduced in miniature: a
corpus that does not look like your data will rank models in an order that does
not apply to your data. The mix matters as much as the size — 15% long documents
in the synthetic set was enough to reorder half the table.

## Is a second retrieval tier worth it?

`eval-cascade.ts`. The three best embedding models plateau at 0.975 MRR and fail
the *same* query:

```
"which certificate do I have to renew by hand?"
  wanted  cert-staging  "Renew the SSL certificate for the staging cluster…"   (rank 2)
  got     cert-prod     "…auto-renews through cert-manager, so it needs no manual action."
```

The distractor contains "manual" and states the negation of what was asked. A
bi-encoder embeds query and document separately and never compares them, so
polarity is precisely what it cannot see — which is why scaling the encoder does
not help: `qwen3-embedding:4b` scores five points higher on MTEB and misses the
identical query. The remaining error is not a quality gap, it is a class limit.

| design | R@1 | MRR | ms/query |
| --- | --- | --- | --- |
| tier 0 — BM25 lexical only | 10/20 | 0.628 | 0 |
| **tier 1 — embedding only (current)** | 19/20 | 0.975 | **19** |
| tier 0+1 — hybrid RRF, always | 16/20 | 0.840 | 19 |
| tier 0+1 — hybrid RRF, gated | 19/20 | 0.963 | 19 |
| tier 1+2 — LLM rerank, always | **20/20** | **1.000** | 1229 |
| **tier 1+2 — LLM rerank, gated at margin < 0.08** | **20/20** | **1.000** | **152** |

**The free tier does not pay.** Adding BM25 by Reciprocal Rank Fusion *lowers*
accuracy from 0.975 to 0.840 — lexical overlap drags down paraphrased queries the
encoder already had right. It does fix the near-dup slice (8/8), so BM25 genuinely
knows something the encoder does not, but gating it only trades one win for one
loss (0.963, still below doing nothing).

**The expensive tier does pay, and only with a large model.** `qwen3.8:27b`
reranking the top 5 fixes the negation query and takes the corpus to a clean
20/20. `qwen2.5:7b` on the same job fixed *nothing* — so this tier costs 18 GB
resident on top of the embedder, not a small model.

**Gating on the cosine margin is what makes it affordable.** The gap between the
best and second-best score is a usable confidence signal: escalating only when it
is below 0.08 fires on 3 of 20 queries and cuts the average cost from 1229ms to
152ms for identical accuracy — an 8x saving.

### Does the cascade survive real data? Yes — better than on synthetic

Same design, 97 real issues, `embeddinggemma` + `qwen3.8:27b` reranking the top 5:

| gate | escalated | R@1 | MRR | +ms/query | fixed | **broke** |
| --- | --- | --- | --- | --- | --- | --- |
| tier 1 only | — | 86% | 0.914 | 0 | — | — |
| margin < 0.035 | 20/97 (21%) | **91%** | **0.950** | **+510** | 5 | **0** |
| margin < 0.074 | 36/97 (37%) | 91% | 0.950 | +998 | 5 | **0** |
| margin < 0.15 | 63/97 (65%) | **93%** | **0.960** | +1548 | 7 | **0** |

**The reranker never demoted a correct answer — zero regressions at every
threshold.** That is the result that matters most: escalation is monotone, so the
gate is purely a cost control and not an accuracy risk. On synthetic data the tier
fixed one query; here it fixes five to seven real misses.

**The threshold did not transfer, exactly as warned.** The synthetic set put the
gate at 0.08; on real data 0.035 captures the entire benefit of 0.074 at half the
latency, and the useful range runs to 0.15 if you will pay for it. Fitting that
number to one failing query was as unsafe as it looked — but the *mechanism* it was
testing held up.

So the recommendation firms up: a gated second tier is worth building, the gate
must be fitted on your own corpus, and 0.035–0.05 is a better starting guess than
0.08.

### Remaining caveats

- **One query separates 0.975 from 1.000.** The 0.08 threshold is tuned on a single
  failure, which is overfitting by any standard. On a real corpus it needs fitting
  against many misses, and the margin distribution will differ.
- **Two queries have a *smaller* margin than the failing one** and are answered
  correctly, so the signal is real but weak. It buys cheap escalation, not a
  reliable "is this wrong" detector.
- **Model residency dominates the measurement.** Tier 1 measured 535ms per query
  in the first cascade run and 19ms once both models stayed loaded — a 28x
  artifact from Ollama swapping models in and out. Any two-model design needs
  `OLLAMA_MAX_LOADED_MODELS` and enough RAM for both, or the fast tier stops being
  fast.
- **"Fast results now, better results later" is not available over MCP.** A
  `tools/call` returns exactly one result; progress notifications carry status, not
  content the model can act on. So a second tier cannot stream a first draft — it
  can only be adaptive and invisible, or an explicit parameter on the tool.

### Verifying Matryoshka support against the model cards

Widths were measured, which beats any card. **MRL membership was not** — I inferred
it from vendor and family, and got four models wrong. Every entry is now taken from
the model's own card:

| model | card says | was I right? |
| --- | --- | --- |
| `embeddinggemma` | MRL to 512/256/128 | ✓ |
| `qwen3-embedding:*` | "user-defined output dimensions from 32 to N", all variants | ✓ |
| `nomic-embed-text` | "utilizes Matryoshka Representation Learning", 768→512/256/128/64 | ✗ **missed** |
| `nomic-embed-text-v2-moe` | "Trained with Matryoshka Embeddings", 768→256 | ✗ **missed** |
| `mxbai-embed-large` | "The model supports both approaches!" (MRL + binary quant) | ✗ **missed** |
| `snowflake-arctic-embed2` | MRL at 256, "less than 3% degradation" | ✗ **missed** |
| `bge-m3`, `bge-large`, `granite-embedding`, `all-minilm` | no MRL claim | ✓ |

Four false warnings against correct configurations — the same class of error as the
non-existent model ids below, from the same cause: asserting something I had not
checked.

The distinction is real, but only visible at a **matched reduction ratio**. At 256
dimensions the raw losses look muddled, because cutting 384→256 is not the same act
as cutting 1024→256. Comparing like with like, at 4x:

| model | 1024 → 256 | |
| --- | --- | --- |
| `mxbai-embed-large` | −0.011 MRR | MRL |
| `snowflake-arctic-embed2` | −0.020 MRR | MRL |
| `bge-m3` | **−0.042 MRR** | not MRL |

Two to four times the loss for the model not trained for it. `granite-embedding`
(not MRL) loses 0.018 at only a 1.5x cut — worse than `mxbai-embed-large` manages
at 4x. Arctic's card claimed under 3% degradation at 256 and measured 2.2%, so the
card was honest.

A useful side effect: `snowflake-arctic-embed2` at **256 dimensions** scores 0.901,
matching `bge-m3` at full width, in a quarter of the storage.

### Verifying the dimension table

`db/config.mjs` refuses a configuration whose model and column width disagree,
which makes a wrong entry worse than a missing one: it produces a confident error
against a correct setup. So every local entry was checked against a live Ollama by
requesting an embedding and counting the numbers — all eleven correct, plus
`qwen3-embedding:8b` confirmed at 4096.

The hosted entries were checked against OpenRouter's public model listing, which
needs no key:

```bash
curl https://openrouter.ai/api/v1/embeddings/models   # 33 models, ids and context lengths
```

Two entries named models that **do not exist**: `voyage/voyage-3` and
`mistral/mistral-embed`. The real ids are `voyageai/voyage-4*` and
`mistralai/mistral-embed-2312`. Both have been removed rather than guessed at —
`mistral-embed-2312` went back in at 1024 because its own listing states the width,
and the Voyage and Gemini families stayed out because nothing here can confirm
their dimensions. Note that the listing's `supported_parameters` field is useless
for this: it returns chat parameters like `temperature` and `stop`, and omits
`dimensions` even for `openai/text-embedding-3-small`, which certainly supports it.

Hosted widths for models whose open weights were measured locally — the Qwen3
family and `bge-m3` — carry over, since they are the same weights.

## Open versus proprietary

On the public leaderboards the open models are ahead, which was not true two years
ago. MTEB multilingual v2, top of each camp:

| model | MTEB | $/M tokens | |
| --- | --- | --- | --- |
| **Qwen3-Embedding-8B** | **70.58** | **$0.01** hosted, free self-hosted | open |
| Gemini embedding-001 | 68.32 | $0.15 | proprietary |
| voyage-3-large | ~67 | $0.06 | proprietary |
| Cohere embed-v4 | 65.2 | $0.10 | proprietary |
| text-embedding-3-large | 64.6 | $0.13 | proprietary |
| BGE-M3 | 63.0 | free self-hosted | open |

The best open model outscores every proprietary one *and* is the cheapest way to
buy embeddings even if you do not self-host — $0.01/M against $0.13/M for
`text-embedding-3-large`, thirteen times cheaper and higher scoring. On MTEB
English v2 the same family reports 75.22 (8B), 74.60 (4B) and 70.70 (0.6B) against
`embeddinggemma`'s 69.67.

Treat the cross-camp rows as directional: the proprietary numbers come from
secondary sources that mostly do not state which MTEB version they are on, and
mixing English v1, English v2 and multilingual v2 is an easy way to produce a
comparison that means nothing. Only the Qwen and Gemma numbers here are from
primary model cards on a stated, matching benchmark.

### …and what that is worth on this corpus

`qwen3-embedding:4b` scores 74.60 on MTEB English v2 against `embeddinggemma`'s
69.67 — five points, which on a leaderboard is a rout. Here:

| model | dims | easy | near-dup | temporal | long | MRR | sec |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3-embedding:4b (+instruct) | 1024 | 5/5 | 7/8 | 4/4 | 3/3 | 0.975 | 2.8 |
| **embeddinggemma** | **768** | 5/5 | 7/8 | 4/4 | 3/3 | **0.975** | **0.8** |
| qwen3-embedding:4b (no instruct) | 1024 | 4/5 | 7/8 | 4/4 | 3/3 | 0.938 | 2.8 |

A dead tie, from a model four times the size and three and a half times slower.
Five leaderboard points bought nothing on twenty personal notes. That is the
clearest single illustration of why this directory exists.

Two things that had to be right for that to be a fair test:

**Qwen3-Embedding needs its query instruction.** Documents go in bare, queries are
wrapped as `Instruct: {task}\nQuery: {q}`. Without it the same model scores 0.938
instead of 0.975 — so an unprefixed comparison would have understated it by more
than the leaderboard gap being tested. The harness takes `model!instruct` for this.

**pgvector's 2000-dimension ceiling is not the hard exclusion this file used to say
it was.** `qwen3-embedding:4b` is 2560 natively, which cannot be HNSW-indexed — but
Qwen3-Embedding supports Matryoshka truncation from 32 to 4096 dimensions, and
**Ollama honours the OpenAI `dimensions` parameter**, verified: ask for 1024 and you
get 1024. The harness takes `model@1024`. Interestingly 1024 beat 1536 here
(0.975 vs 0.912) — narrower was better, on this corpus.

Note that the server does **not** currently send `dimensions`, so configuring a
2560-native model against a 1024 column still fails the width check at capture
time. Making that configurable is the obvious follow-up.

## The biggest gap: nothing hosted has been measured

Everything above is local, via Ollama. The **default** configuration is not local —
it is OpenRouter with `openai/gpt-4o-mini` for extraction and
`openai/text-embedding-3-small` for embeddings, and **neither has been benchmarked
here at all.** They are the upstream defaults, carried forward unexamined.

That matters in both directions:

- `gpt-4o-mini` may well beat `qwen2.5:7b` — or not. It is simply unknown, and it
  is what most people will actually run.
- `deepseek/deepseek-chat` on OpenRouter is a strong, unusually cheap option for
  exactly this kind of structured extraction, and is the realistic way to use
  DeepSeek here given the flagship weights cannot run locally.

The harnesses now speak to any OpenAI-compatible endpoint with a key, so this is a
one-liner the moment one exists:

```bash
OB1_EVAL_BASE=https://openrouter.ai/api/v1 OB1_EVAL_KEY=sk-or-… OB1_EVAL_TEMP=0 \
  bun eval-retrieval.ts openai/text-embedding-3-small qwen/qwen3-embedding-8b@1024
```

It costs almost nothing to settle — the whole retrieval corpus is about 15k tokens,
so a run against `text-embedding-3-small` at $0.02/M is a small fraction of a cent.
Until it is run, treat "qwen2.5:7b is the best extraction model" and
"embeddinggemma is the best embedding model" as scoped to *local* options.

## Caveats

- **Run once, results move.** At the provider default temperature the same model
  varied by 3 points across three runs. Any comparison here that is not at
  `OB1_EVAL_TEMP=0` should be treated as a single sample, and differences of one
  or two points as noise. This bit the first version of these results.
- **Fourteen captures and twenty queries is a small sample.** Differences under ~0.05
  MRR, or one point of a per-field score, are not meaningful. The clear separations
  — the `long` slice, the structural failures — are.
- **The test sets reflect one person's kind of notes**: engineering work, some
  domestic admin. A brain full of legal text or another language would rank
  differently, and `bge-m3` is the multilingual option if that is you.
- **Quantisation is Ollama's default** for each tag, not controlled here.
- **Nothing measures index build time or memory at scale.** These are retrieval
  quality and extraction accuracy only.

## Related

- `../SETUP.md` — the two decisions these evals inform
- `../db/config.mjs` — `KNOWN_MODEL_DIMS`, so a model/width mismatch is caught
