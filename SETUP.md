# Setting up Open Brain without Supabase

The upstream guide (`docs/01-getting-started.md`) builds Open Brain on
supabase.com: a hosted Postgres, an Edge Function, SQL pasted into a dashboard,
and `supabase secrets set`. This fork runs the same thing on infrastructure you
control, with no Supabase account and no Supabase CLI.

Same six MCP tools, same `thoughts` schema, same clients. Different plumbing.

**Read this instead of `docs/01-getting-started.md`.** That guide still describes
the Supabase path, which continues to work if you want it — see `FORK.md`.

## Two decisions to make first

Both are free right now and expensive after your first captures. Neither has a
good default that suits everyone.

### 1. Where the models run, and therefore the vector width

`thoughts.embedding` is a fixed-width column, and the model that fills it must
produce exactly that many numbers. Changing either later means a schema migration
**and re-embedding every row** — which costs an API call per thought.

| Model | Width | Note |
| --- | --- | --- |
| `embeddinggemma` | 768 | **Best measured local option** — see [`evals/`](evals/README.md). Runs via Ollama. |
| `openai/text-embedding-3-small` | 1536 | The hosted default. Cheap, unmeasured here. |
| `bge-m3` | 1024 | Ties `embeddinggemma` on retrieval; pick it if your notes are multilingual. |
| `nomic-embed-text` | 768 | The obvious small default, and measurably worse — 5th of 10. |
| `qwen3-embedding:4b` | 2560 → **1024** | **Best measured on real data** (0.933 MRR vs `embeddinggemma`'s 0.914). Too wide to index natively — needs `OB1_EMBEDDING_DIMENSIONS=on`, below. Costs ~3x the embedding time. |
| `openai/text-embedding-3-large` | 3072 | **Exceeds pgvector's HNSW limit of 2000.** The column works, but no index can be built, so every search becomes a full table scan. Truncatable to 1536 with `OB1_EMBEDDING_DIMENSIONS=on`. |

#### Using a model that is too wide to index

pgvector's HNSW index tops out at 2000 dimensions, which rules out most of the
strongest embedding models — until you ask the provider for a shorter vector:

```bash
OB1_EMBEDDING_MODEL=qwen3-embedding:4b
OB1_EMBEDDING_DIM=1024
OB1_EMBEDDING_DIMENSIONS=on        # send the OpenAI `dimensions` parameter
```

That is the best-scoring configuration measured here. Without the flag, the
server refuses the 2560-wide vector rather than storing something the index
cannot cover.

**It is off by default, and only safe for models trained for Matryoshka
truncation** — `embeddinggemma`, `qwen3-embedding`, `openai/text-embedding-3-*`.
Providers apply the parameter to *any* model and return a shortened vector with no
warning: Ollama will happily give you 256 numbers for `all-minilm`. On a model not
trained for it, retrieval quietly gets worse — measured at roughly twice the MRR
loss of an MRL model at the same width. `preflight.ts` warns when you truncate a
model not known to support it, and refuses outright if the provider ignores the
parameter and returns the wrong width.

Set `OB1_EMBEDDING_MODEL` and `OB1_EMBEDDING_DIM` together. `migrate.ts` refuses a
mismatched pair, and the width is recorded in `ob1_config` so `preflight.ts`
catches a later disagreement rather than letting search quietly degrade. The
server also refuses a vector the column cannot hold, rather than surfacing an
opaque cast error from Postgres.

#### Running the models locally instead

Every capture makes two calls: an embedding, and a metadata extraction that
produces the `topics`, `people`, `type` and `action_items` behind
`list_thoughts`'s filters and the `thought_stats` tallies. By default both go to
OpenRouter, which means **the text of every thought you capture leaves your
machine**.

Both are configurable, and both speak the OpenAI-compatible shapes that Ollama
exposes at `/v1` — so a fully local brain is a URL change, not a code change:

```bash
# deploy/.env
OB1_LLM_BASE_URL=http://ollama:11434/v1
OB1_EMBEDDING_MODEL=embeddinggemma
OB1_EMBEDDING_DIM=768
OB1_METADATA_MODEL=qwen2.5:7b
# leave OPENROUTER_API_KEY empty
```

```bash
podman compose -f deploy/compose.yaml --profile local-models up --build
```

That profile adds an `ollama` service and a one-shot job that pulls both models
(~2.3 GB on first run). No credential is sent to a loopback provider — the server
omits the `Authorization` header entirely.

**On macOS, install Ollama natively instead.** A Linux container on Apple Silicon
gets no Metal passthrough, so containerised inference runs on CPU. Native Ollama
uses the GPU and host memory, leaving the podman VM untouched:

```bash
brew install ollama
OLLAMA_HOST=0.0.0.0:11434 ollama serve          # 0.0.0.0 so containers can reach it
ollama pull embeddinggemma && ollama pull qwen2.5:7b
```

Then point the server at the host rather than the compose network, and skip the
profile:

```bash
# deploy/.env
OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1   # docker: host.docker.internal
```

#### These two were chosen by measurement

`embeddinggemma` and `qwen2.5:7b` are not the smallest or most obvious picks —
they are what won a benchmark. The harnesses are in [`evals/`](evals/README.md) so
you can re-run them when better models appear, or against your own notes.

The short version:

- **`embeddinggemma`** ties the best retrieval MRR (0.975) and is the only
  768-dimension model to do so, so it drops into a schema already built at 768.
  `nomic-embed-text` — the obvious small default, and what this guide recommended
  first — placed 5th of 10. The gap is almost entirely on **long thoughts with the
  decision at the end**: change only the final sentence of a long note and
  `nomic-embed-text`'s vector barely moves (cosine 0.982), so the note becomes hard
  to find by its conclusion. `embeddinggemma` moves properly (0.816). This is a
  documented failure mode of embedding models generally, not a quirk of this
  benchmark — see [`evals/`](evals/README.md).
- **Check the context window before anything else.** Every 512-token model tested
  scores 1/3 on long thoughts and every 2048+ model scores 2/3 or 3/3 — a hard cut,
  with no error when a thought is silently truncated. Use `ollama show <model>`,
  not the model card: Ollama serves `nomic-embed-text` at 2048, not the advertised
  8192.
- **`qwen2.5:7b`** was the only extraction model with no structural failures
  (45/48). `llama3.2` scored 42/48 and produced exactly the faults seen on real
  captures: a type outside the enum, and a capture with no topics at all.
- **Avoid reasoning models here.** `qwen3:4b` takes 17.8s per extraction against
  ~2s, because it emits thinking tokens first. This call runs on every capture.
- **Bigger barely helps extraction, and costs latency.** `qwen2.5:14b` scored
  identically to the 7B at 1.7× the time. `gpt-oss:20b` did score best (83/84 vs
  81/84) but takes ~6.7s per capture against ~1.2s, and still invented a person the
  7B did not. Worth it only if captures are batched.
- **Bigger is not possible for embeddings.** `qwen3-embedding:4b` emits 2560
  dimensions, above pgvector's HNSW limit of 2000 — the column works but no index
  can be built. The largest usable one, `qwen3-embedding:0.6b`, scored below
  `embeddinggemma` despite more parameters and 16× the context.
- **`lfm2.5:8b` is the fast option** — 0.54s per capture against 1.4s, zero
  structural failures, six points less accurate. Worth it if you capture often.
- **`qwen3.8:27b` is the most accurate local option** — the only model to score a
  perfect 84/84 with no structural failures, at ~3.5s per capture and 18 GB. It is
  both more accurate and faster than `gemma4 + reasoning`, which it replaces. Worth
  it if correctness of `topics`/`people`/`type` matters more than capture latency. Reasoning is off by
  default: `think: false` is silently ignored on the OpenAI-compatible endpoint, so
  the server sends `reasoning_effort: "none"` — without it a thinking model
  multiplies capture latency with no warning.
- **Reasoning models are wrong for this, consistently.** `qwen3:4b` 17.8s,
  `deepseek-r1:8b` ~34s per capture against ~1.2s — and R1 also scored lower
  (78/84) with one unusable response. DeepSeek's and Kimi's flagship weights
  (404 GB and ~1T parameters) do not run on a workstation at all; Kimi has no
  smaller variant in Ollama.
- **The hosted defaults are unmeasured.** `openai/gpt-4o-mini` and
  `openai/text-embedding-3-small` are carried over from upstream and have not been
  benchmarked. `deepseek/deepseek-chat` via OpenRouter is a cheap, plausible
  alternative. The harnesses in [`evals/`](evals/README.md) work against any
  OpenAI-compatible endpoint — point them at OpenRouter with a key to settle it.
- **Extraction runs at `temperature: 0`.** It was previously unset, so it sampled
  at the provider default and the same note could gain or lose a field between
  captures. Override with `OB1_METADATA_TEMPERATURE` if you want variety.

If you use a weaker model anyway, the server copes: unknown `type` values are
normalised to a known alias or `observation`, with the original kept in `type_raw`
so drift stays visible rather than fragmenting your filters.

The metadata model is the safer of the two to change your mind about: it has no
schema dependency and no re-embed cost, so you can swap it whenever you like.

A same-width model from a *different family* is the nastiest case: the vectors are
numerically valid and semantically unrelated to what you already stored. Nothing
errors; retrieval just gets worse. Preflight warns when the configured model
differs from the recorded one.

### 2. Access keys and scopes

The endpoint is protected by keys you mint. Two things worth getting right at the
start, because the URLs end up pasted into client configs:

```bash
cd server-portable
bun keygen.ts --name laptop  --scope write   # captures and searches
bun keygen.ts --name chatgpt --scope read    # searches only
```

Each prints the key **once** plus a `name:scope:sha256` line for
`MCP_ACCESS_KEYS`. Store the hashes; the server only ever compares digests, so the
config is not itself a credential.

Prefer `--scope read` wherever a client only needs to search. A read-only key does
not get a permission error from `capture_thought` — the tool is never registered
for it, so it does not appear in `tools/list` at all.

That matters because the key can travel in the URL (`?key=…`). Claude Desktop's
custom connectors are URL-only, so this fork keeps that form — but query strings
reach access logs, browser history and shell history. A read-only key limits what
a leak is worth. See [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).

## Prerequisites

- podman or docker, with compose
- **Either** an [OpenRouter](https://openrouter.ai) API key with a few dollars of
  credit, **or** nothing at all if you use the `local-models` profile — in which
  case budget a few hundred MB for the model downloads instead
- [Bun](https://bun.sh) 1.4+ to mint keys and run the tests

No Supabase account. No Supabase CLI. No Deno.

## Steps

### 1. Configure

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24                                    # POSTGRES_PASSWORD
cd server-portable && bun keygen.ts --name laptop --scope write
```

Put the `name:scope:sha256` line in `MCP_ACCESS_KEYS`, and keep the raw key
somewhere safe — it is not recoverable.

Then pick a model provider: either fill in `OPENROUTER_API_KEY`, or uncomment the
`local-models` block and leave the key empty.

### 2. Bring it up

```bash
podman compose -f deploy/compose.yaml up --build

# …or, for the fully local path:
podman compose -f deploy/compose.yaml --profile local-models up --build
```

Three services in order (five with `local-models`): Postgres with pgvector, a migration job that applies the
schema and exits, then the MCP server. The server runs `preflight.ts` before it
serves, so a misconfiguration crashloops rather than starting and failing on your
first capture.

### 3. Verify

```bash
OB1_SMOKE_KEY=<your-raw-key> ./deploy/smoke.sh
```

### 4. Connect a client

```
http://localhost:8000/?key=<your-raw-key>
```

In Claude Desktop: Settings → Connectors → Add custom connector, and paste that
URL. For anything reachable from outside your machine, put it behind TLS first.

## Expected outcome

`migrate` exits 0 having applied six migrations. `server` logs `preflight OK` and
`Started server`. `smoke.sh` prints `5 checks: 5 passed, 0 failed`. A client shows
six tools for a write key, five for a read key.

## Where to run it for real

`deploy/compose.yaml` is a working reference, not a production topology — no TLS,
no backups, no resource limits. For something durable:

| | |
| --- | --- |
| **Container + managed Postgres** | RDS, Aurora, Neon, Cloud SQL, or Timescale with pgvector; the server as a container. `OB1_STORE=sql`, `DATABASE_URL`. The simplest data path. |
| **Cloudflare Workers** | `server-portable` builds for Workers at ~256 KiB gzipped. Workers cannot pool Postgres connections, so pair it with PostgREST (`OB1_STORE=postgrest`) or add Hyperdrive. |
| **Self-hosted Supabase** | If you want the Supabase stack without supabase.com. Zero code change — see `recipes/local-brain-no-mcp`. |

## Two things this does not fix

**Auth is still a bearer key.** Scoped and hashed now, but a single secret per
client with no expiry and no per-user identity. Fine for a personal or small-team
brain; not an authorization model.

**By default every captured thought goes to OpenRouter** for embedding and
metadata extraction. The `local-models` profile above removes that entirely, which
closes the largest hole — but one shared table with no per-user isolation and a
bearer-key auth model remain, so this is still not an architecture for regulated
or patient-adjacent data, wherever you host it.

## Related

- `db/README.md` — the schema, migrations, and the runner
- `server-portable/README.md` — the server, its four runtimes, and the data layers
- `compat/supabase-sql/README.md` — running recipes and integrations without PostgREST
- `evals/README.md` — how the local models were chosen, and how to re-run it
- `deploy/README.md` — the compose stack in detail
- `FORK.md` — what this fork changes and why
