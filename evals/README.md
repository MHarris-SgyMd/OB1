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
bun eval-extraction.ts qwen2.5:7b llama3.2
```

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

| model | dims | easy | near-dup | temporal | long | MRR |
| --- | --- | --- | --- | --- | --- | --- |
| **embeddinggemma** | **768** | 5/5 | 7/8 | 4/4 | **3/3** | **0.975** |
| bge-m3 | 1024 | 5/5 | 7/8 | 4/4 | 3/3 | 0.975 |
| snowflake-arctic-embed2 | 1024 | 5/5 | 7/8 | 4/4 | 3/3 | 0.975 |
| mxbai-embed-large | 1024 | 5/5 | 7/8 | 4/4 | 1/3 | 0.896 |
| nomic-embed-text | 768 | 4/5 | 6/8 | 4/4 | 2/3 | 0.892 |
| all-minilm | 384 | 4/5 | 6/8 | 4/4 | 2/3 | 0.869 |
| granite-embedding | 384 | 4/5 | 6/8 | 3/4 | 0/3 | 0.772 |

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

## Caveats

- **Twenty queries and eight captures is a small sample.** Differences under ~0.05
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
