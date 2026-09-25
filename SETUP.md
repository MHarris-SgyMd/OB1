# Setting up Open Brain without Supabase

Upstream's guide builds Open Brain on supabase.com: a hosted Postgres, an Edge
Function, SQL pasted into a dashboard, and `supabase secrets set`. This fork runs
the same thing on infrastructure you control, with no Supabase account and no
Supabase CLI.

Same MCP tools, same `thoughts` schema, same clients. Different plumbing.

This file is the operator's reference: the two decisions, what leaves the box,
where to run it for real. [`docs/01-getting-started.md`](docs/01-getting-started.md)
walks the same stack at a beginner's pace, one verified step at a time, and
connects each AI client; this fork carries no Edge Function build (`FORK.md`,
"Deploying").

## Two decisions to make first

Both are free right now and expensive after your first captures. Neither has a
good default that suits everyone.

### 1. Where the models run, and therefore the vector width

`thoughts.embedding` is a fixed-width column, and the model that fills it must
produce exactly that many numbers. Changing either later means a schema migration
**and re-embedding every row** — which costs an API call per thought. Changing
the model at the *same* width is the case `db/reembed.ts` handles, in parallel
and resumably; changing the width is not, yet.

One more per-thought cost exists and is **off until you turn it on**: entity
extraction (`db/extract-entities.ts`, migration 016) sends every thought to the
metadata model once — a long thought in windows sized to that model, each call
with an answer budget (`OB1_EXTRACT_CHUNK_TOKENS` overrides the derived window;
preflight prints it) — and every new capture after that. Locally that is compute;
on a hosted provider it is money per thought and every thought's text leaves
your machine. `db/README.md` has the measured cost and quality. A second
optional pass builds on it: consolidation (`db/consolidate.ts`, migration 029)
asks the same model whether two thoughts that share a subject contradict each
other, and files the conflicts as proposals for you to accept or reject — up to
a few calls per thought, both thoughts' text per call, and nothing changes in
the store until you accept one.

A third opt-in feature stores data rather than spending model calls, and is also
**off until you turn it on**: the query log (`OB1_QUERY_LOG=on`, migration 034).
With it on, the server records one row per search — the query text, its arguments
and the ids returned — one per follow-up fetch, edit or delete of a returned
id — and, since FORK.md change 90, one per id a capture or edit names as its
source (`derived_from` / `supersedes`), whether or not a search returned it:
every source a synthesis cites is a row, and the link to a search is made when
the log is read, not when it is written. Together they let a retrieval change be
replayed against what the brain was actually asked (`evals/eval-replay.ts`) and
show whether callers use what comes back (`evals/eval-utilization.ts`). It is
**personal data at rest**: every query you typed. It adds no new external
destination and makes no model or provider call —
the rows land in the same database your thoughts already live in, so on a hosted
(Supabase) deployment they are in your cloud database, not on your machine. And
nothing reads it on the capture or search path; the write is best-effort and
never fails a search. `prune_query_log()` enforces a retention window
(`OB1_QUERY_LOG_RETENTION_DAYS`, default 30), and `evals/export-queries.ts`
redacts the log to ids and query text — no thought content — before it becomes a
fixture (the query strings are still your own words, so a committed export
fixture carries them; only the synthetic gate fixture is content-free). A self-hosted role needs `query_log` `INSERT` to record it
(`db/README.md`, "Grants for a capturing role").

| Model | Width | Note |
| --- | --- | --- |
| **`qwen3-embedding:4b`** | 2560 → **1024** | **The default.** Best measured on real data — 0.903 MRR vs `embeddinggemma`'s 0.873 over 441 real issues with full descriptions and comments — and the only local model that embeds a long capture whole. Costs ~5x the latency and 2.5 GB. Truncation is automatic. |
| `qwen3-embedding:0.6b` | 1024 | 0.918 MRR at 639 MB — nearly the 4B's accuracy for a quarter the size. The value pick. |
| `embeddinggemma` | 768 | 0.916 MRR at 621 MB, the fastest of the three. Was the default until real-corpus measurement moved it to third. |
| `openai/text-embedding-3-small` | 1536 | Hosted. Cheap, and still unmeasured here — see [`evals/`](evals/README.md). |
| `bge-m3` | 1024 | Ties `embeddinggemma` on retrieval; pick it if your notes are multilingual. |
| `nomic-embed-text` | 768 | The obvious small default, and measurably worse — 5th of 10. |
| `qwen3-embedding:4b` | 2560 → **1024** | **Best measured on real data** (0.903 MRR vs `embeddinggemma`'s 0.873 over 441 full-length issues). Too wide to index natively — needs `OB1_EMBEDDING_DIMENSIONS=on`, below. Costs ~5x the embedding time. |
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
# deploy/.env — every commented line is the default; the profile needs ONE line set
OB1_LLM_LOCAL=1                             # the endpoint is on this box — declared, never guessed (below)
# OB1_LLM_BASE_URL=http://ollama:11434/v1   # compose's own fallback: the profile's service
# OB1_EMBEDDING_MODEL=qwen3-embedding:4b
# OB1_EMBEDDING_DIM=1024
# OB1_METADATA_MODEL=qwen2.5:7b
# leave OPENROUTER_API_KEY empty
```

```bash
podman compose -f deploy/compose.yaml --profile local-models up --build
```

That profile adds an `ollama` service and a one-shot job that pulls both models
(~7.2 GB on first run). No credential is sent to a loopback provider — the server
omits the `Authorization` header entirely.

**On macOS, install Ollama natively instead.** A Linux container on Apple Silicon
gets no Metal passthrough, so containerised inference runs on CPU. Native Ollama
uses the GPU and host memory, leaving the podman VM untouched:

```bash
brew install ollama
ollama serve                                     # its default, 127.0.0.1:11434, is enough
ollama pull qwen3-embedding:4b && ollama pull qwen2.5:7b
```

Leave Ollama on its loopback default: on podman machine and Docker Desktop the
container's `host.containers.internal` / `host.docker.internal` reaches the
host's loopback (measured on podman 5, libkrun), and `OLLAMA_HOST=0.0.0.0` would
put an unauthenticated model API on every interface for nothing. (On Linux
Docker the container reaches the host by its bridge address, so there Ollama
must listen on that address or all — that is the case the compose
`local-models` profile exists for.) Then point the server at the host rather
than the compose network, and skip the profile:

```bash
# deploy/.env
OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1   # docker: host.docker.internal
OB1_LLM_LOCAL=1                                              # …and it is on this box
```

#### What may leave the box

Every one of those calls carries a thought's full text. Before any of them is
made, the **egress gate** (`server-portable/egress.ts`, SMD-1903) decides
whether the text may reach the endpoint at all, and the policy is yours to
state in words rather than implied by which URL you typed:

- `OB1_EGRESS_POLICY=deny` — **the default.** Nothing reaches an endpoint that
  is not declared local unless an `OB1_EGRESS_ALLOW` term names it.
- `OB1_EGRESS_POLICY=allow` — everything leaves unless an `OB1_EGRESS_DENY`
  term names it.
- `OB1_EGRESS_POLICY=off` — no gate.

"Local" is **declared, never guessed** from the address: `OB1_LLM_LOCAL=1` says
the embeddings endpoint is on this machine or its private network, and
`OB1_CHAT_LOCAL=1` says the same of a chat endpoint of its own (one at the same
base is the same box: either knob declares it). A loopback URL, `host.containers.internal` and the
stack's own `ollama` service are all remote to the gate until the flag says
otherwise — which is why both blocks above carry the line. A refused capture is
not lost: it lands with its text and fingerprint and no vector, the reply says
so and names the rule, the decision sits on the row's audit entry, and a later
`db/reembed.ts` pass against an endpoint the gate allows fills the vector in. A
refused search says which tool works without a model call
(`search_thoughts_keyword`). Terms are `unit:value`, comma-separated — `actor`
(the access key's name), `source`, `type`, `topic` (a row's metadata, known to
the passes and the re-embed, not at a first capture), `marker` (a literal in the
text) — and a term that does not parse fails preflight and closes the gate.
Preflight prints the mode and, per endpoint, what leaves; `deploy/.env.example`
has the block.

**With protected health information in the brain, keep every endpoint on the
box** — Options A or B above, both declared local — and leave the policy at its
default. The gate is deterministic on purpose: a classifier that tells PHI from
not-PHI 98% of the time is a compliance failure two times in a hundred, so no
detector may widen what leaves; one may only narrow it (the second-opinion hook
in `egress.ts`). Until a local model strong enough for every task is in place
(SMD-1880, SMD-1901), a hosted chat model behind an allowlist is the only
half-way shape, and the allowlist names what may leave, not what may not.

#### Half local: embeddings at home, tagging elsewhere

The two calls need not share a provider. `OB1_LLM_BASE_URL` is where the
embedding goes, and where the chat calls — metadata extraction, the chunk
blurbs, the supersession judge — go too unless `OB1_CHAT_BASE_URL` names
another endpoint. The text of every capture then stays on the host for the
vector and leaves only for tagging; or a second local runtime that serves chat
only sits beside Ollama:

```bash
# deploy/.env — local embeddings, hosted chat
OB1_LLM_BASE_URL=http://host.containers.internal:11434/v1
OB1_LLM_LOCAL=1                              # the embeddings endpoint is on this box; the chat one is not
OB1_EMBEDDING_MODEL=qwen3-embedding:4b
OB1_EMBEDDING_DIM=1024
OB1_CHAT_BASE_URL=https://openrouter.ai/api/v1
OB1_CHAT_API_KEY=sk-or-…
OB1_METADATA_MODEL=openai/gpt-4o-mini        # a model the CHAT endpoint serves
OB1_EGRESS_ALLOW=marker:#public              # what may leave for tagging — under the default nothing else does
```

A credential belongs to an endpoint: a different chat endpoint gets
`OB1_CHAT_API_KEY` and never inherits `OB1_LLM_API_KEY`, so a local chat model
beside a hosted embedder is not handed the hosted key. `preflight.ts` prints a
row for each endpoint, fails a hosted one with no key of its own, and probes
each by name — a local one on every start, a hosted one with `--deep` — so a
chat endpoint that is down fails its own row while the embeddings row still
passes (SMD-1875). Note what leaves the host under this
shape: a capture's full text, for tagging — and only the captures the gate
lets through. Under the default policy the hosted chat endpoint is refused for
every thought until an `OB1_EGRESS_ALLOW` term names what may go (above); the
last line does that for thoughts carrying a `#public` marker, and the rest land
untagged with the reason recorded.

#### These two were chosen by measurement

`qwen3-embedding:4b` and `qwen2.5:7b` are not the smallest or most obvious picks —
they are what won a benchmark, and the embedding model won it on a real corpus
rather than a synthetic one. The harnesses are in [`evals/`](evals/README.md) so
you can re-run them when better models appear, or against your own notes.

The short version:

- **`qwen3-embedding:4b` needs its query instruction**, and the server sends it
  automatically. This is not a detail: prompted it scores 0.933 MRR, unprompted
  **0.860** — worse than a model a quarter its size. (Both figures are from the
  older 97-issue corpus; the prompted-vs-bare pair has not been re-measured on the
  rebuilt one, but the size of the gap is not in doubt.) The templates live in
  `db/config.mjs` keyed by model name, so changing model changes prompt, and
  preflight's existing model-change warning covers both.
- **`embeddinggemma`** ties the best retrieval MRR (0.975) on the synthetic set and
  is the only 768-dimension model to do so.
  `nomic-embed-text` — the obvious small default, and what this guide recommended
  first — placed 5th of 10. The gap is almost entirely on **long thoughts with the
  decision at the end**: change only the final sentence of a long note and
  `nomic-embed-text`'s vector barely moves (cosine 0.982), so the note becomes hard
  to find by its conclusion. `embeddinggemma` moves properly (0.816). This is a
  documented failure mode of embedding models generally, not a quirk of this
  benchmark — see [`evals/`](evals/README.md).
- **Ollama caps embeddings at 2048 tokens by default, and the knob is
  `num_batch`.** `bge-m3` and `snowflake-arctic-embed2` advertise 8192 and embed
  2048; `ollama show` reports the model's capability, not what you get. The cause is
  batch size, not context: llama.cpp needs an embedding to fit in one batch. So
  `num_ctx` does nothing — not as a request option, not in a Modelfile, not as
  `OLLAMA_CONTEXT_LENGTH` — but `num_batch` does. Bake it in so it applies to the
  OpenAI-compatible endpoint this server calls, which cannot pass request options:

  ```bash
  printf 'FROM bge-m3\nPARAMETER num_batch 8192\nPARAMETER num_ctx 8192\n' > Modelfile
  ollama create bge-m3-long -f Modelfile     # then set OB1_EMBEDDING_MODEL=bge-m3-long
  ```

  **The server now handles this for you**: a capture above `OB1_CHUNK_TOKENS` is
  split into overlapping windows, each embedded separately, so the whole note stays
  searchable regardless of the provider's batch. Unset, the rule follows the
  model's measured window: a 2048-token model windows everything over 1200 tokens
  at 1200, as before; `qwen3-embedding:4b`, which embeds far more than that whole,
  windows only captures over 4096 tokens — still at 1200 a window, because the
  whole vector was measured to hold to about that length and larger windows were
  measured to buy nothing (`evals/README.md`, SMD-1305). `preflight.ts` prints the
  rule and where it came from. Windows already written stay until an edit or a
  backfill re-embed pass (`FORK.md` §50). Short thoughts are untouched. Raising `num_batch`
  is therefore optional — it lets each window be larger, nothing more; a model
  rebuilt that way has a new name, so set `OB1_CHUNK_TOKENS` for it.

  It also sidesteps the harder problem. Even with the batch raised, a single 8K-token
  embedding cannot surface its own final sentence: the model embeds all of it and the
  ending is diluted away, which is a property of the model and has no configuration
  fix. Chunking avoids it by never asking one vector to represent that much text.
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
- **`qwen3.5:0.8b` is the fast option** — 0.56s per capture against 1.4s, zero
  structural failures, four points less accurate, and **1.0 GB**. Worth it if you
  capture often or are tight on memory. The rest of the `qwen3.5` ladder (2b, 4b,
  9b) all score below the default, and the 2b invents people.
- **`qwen2.5:7b` is the default, and is not the top scorer.** `qwen3.8:27b` is —
  the only model to reach a perfect 84/84, at 3.5s per capture and 18 GB. The
  default scores 81/84 at 1.4s and 4.7 GB with the same zero structural failures;
  the three-point gap is field-level accuracy, not invented people or empty topics.
  The asymmetry with the embedding default is deliberate: the embedding width is
  permanent and decides whether a thought can be found at all, while this model has
  no schema dependency and can be changed between two captures. Set
  `OB1_METADATA_MODEL=qwen3.8:27b` for the perfect score — nothing needs
  re-embedding when you change your mind, which is exactly why it is not the
  default. The supersession judge (`db/consolidate.ts`) is the harder task and
  has its own knob, `OB1_JUDGE_MODEL`, so it alone can run on the larger model
  while every capture's tagging stays on the default. Reasoning is off by
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
bun keygen.ts --name session-hook --scope capture   # captures only — for a hook
```

Each prints the key **once** plus a `name:scope:sha256` line for
`MCP_ACCESS_KEYS`. Store the hashes; the server only ever compares digests, so the
config is not itself a credential.

Prefer `--scope read` wherever a client only needs to search. A read-only key does
not get a permission error from `capture_thought` — the tool is never registered
for it, so it does not appear in `tools/list` at all.

The mirror image is `--scope capture`: `capture_thought` and nothing else — no
search, no update, no delete. It is the key for a session-end hook or an import
pipeline, a credential that sits in a config file on a machine you do not watch;
a leak of it can add a thought and cannot read one
([`recipes/session-capture-hook`](recipes/session-capture-hook/)).

That matters because the key can travel in the URL (`?key=…`). Claude Desktop's
custom connectors are URL-only, so this fork keeps that form — but query strings
reach access logs, browser history and shell history. A read-only key limits what
a leak is worth. See [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).

## Prerequisites

- podman or docker, with compose
- **Either** an [OpenRouter](https://openrouter.ai) API key with a few dollars of
  credit, **or** nothing at all if you use the `local-models` profile — in which
  case budget about 7 GB for the model downloads instead
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

The name becomes an agent on first use, with a stable id recorded against every
write (`thought_audit.canonical_agent_id`). The id survives rotating the key —
keep the name, change the digest — and renaming it — keep the digest, change the
name. To revoke a key without editing this file and restarting, take its digest
and run `SELECT revoke_agent_key('<digest>', 'why');` against the database; it
takes effect within a minute and the agent's history stays queryable.

Classify each key once — `SELECT set_agent_kind('laptop', 'operator');` —
as `operator` (a key you hold), `agent` (a key an agent holds) or `ingested`
(an importer copying external text). Every write through it is then audited
with that kind and with a trust ceiling the content cannot claim above
(`thought_audit.actor_kind` and `trust`; migration 046, SMD-1730). Until a
key is classified its rows say unknown, and preflight's `audit events` counts
them; `SELECT backfill_thought_audit_events();` fills the rows written before
the classification. A key can be classified before its first request.

The shipped defaults are **local**: `qwen3-embedding:4b` at 1024 dimensions for
embeddings and `qwen2.5:7b` for metadata, both via Ollama, with no credential
needed. To use OpenRouter instead, set all four — `OB1_LLM_BASE_URL=https://openrouter.ai/api/v1`,
`OPENROUTER_API_KEY`, and both models — not the key alone: with the URL unset
the compose file points the server at the stack's own Ollama and the key is
sent there (`deploy/.env.example`, Option C). The models are changed as a pair,
since a local model name sent to a hosted endpoint 404s on every capture and
silently stores no topics, people or type; `scripts/check-fork-consistency.ts`
fails on that combination in the defaults. To mix them on purpose — local
embeddings, hosted tagging — give the chat calls their own endpoint with
`OB1_CHAT_BASE_URL` and `OB1_CHAT_API_KEY`; see "Running the models locally"
below. Whichever you choose, say which endpoints are on this box
(`OB1_LLM_LOCAL=1`, `OB1_CHAT_LOCAL=1`): by default a thought's text never
reaches an endpoint that is not declared local — see "What may leave the box"
below.

### 2. Bring it up

```bash
podman compose -f deploy/compose.yaml up --build     # with a provider named in deploy/.env

# …or, for the fully local path:
podman compose -f deploy/compose.yaml --profile local-models up --build
```

Three services in order (five with `local-models`): Postgres with pgvector, a migration job that applies the
schema and exits, then the MCP server. The server runs `preflight.ts` before it
serves, so a misconfiguration crashloops rather than starting and failing on your
first capture. To run a *release* rather than a checkout build — the published
`ob1-server` and `ob1-migrate` images, Ollama pinned by digest — see
[`deploy/README.md`](deploy/README.md), "Pinning a release".

### 3. Verify

```bash
OB1_SMOKE_KEY=<your-raw-key> ./deploy/smoke.sh
```

### 4. Connect a client

```
http://127.0.0.1:8000/?key=<your-raw-key>
```

From a client on this machine — Claude Code, at user scope so every project
sees it:

```bash
claude mcp add --transport http --scope user open-brain http://127.0.0.1:8000/ --header "x-brain-key: <your-raw-key>"
```

`127.0.0.1` rather than `localhost`, since the port binds the IPv4 loopback
only. By default nothing outside your machine can reach it: the server is the
stack's only published port (n8n adds one under `--profile orchestration`) and
it binds `127.0.0.1`; the database and Ollama are not published at all (`deploy/README.md`, "What is reachable from where").
A claude.ai or Claude Desktop custom connector (Settings → Connectors → Add
custom connector) connects from Anthropic's side, not from your machine, so it
needs a TLS proxy or a tunnel in front. One on this host (caddy, cloudflared,
`tailscale funnel` — `tailscale serve` reaches your tailnet alone) dials
`127.0.0.1:8000` itself, and the loopback default serves it. Only a proxy on another machine needs `SERVER_BIND=0.0.0.0` in
`deploy/.env` — it opens the server, and only the server, to the network, with
the key in clear on every request until the proxy.

A write key sees twelve tools; a read key sees nine. `capture_thought`,
`update_thought` and `delete_thought` are never registered for a read key, so
they do not appear in `tools/list` at all rather than failing when called.
Opening the connector URL in a browser shows `Method Not Allowed`: the endpoint
serves POST only, and that answer is expected. `capture_thought` returns the
new thought's id, which is what the other two take.

### 5. Optional: workflows beside the brain (n8n)

For ingestion that runs on its own — a mailbox polled on a schedule, a
tracker synced — the `orchestration` profile runs n8n beside the stack
(`docs/orchestration-tool.md`). Its workflows capture through the brain's
MCP endpoint with a capture-scope key. Set its five lines in `deploy/.env`
(`deploy/.env.example`, "The orchestration tool"), then:

```bash
podman compose -f deploy/compose.yaml --profile orchestration up -d
bun deploy/orchestration/provision.ts
```

An AI client reaches an MCP endpoint a template publishes at
`http://127.0.0.1:5678/mcp/<path>`, with the header
`x-n8n-key: <N8N_MCP_KEY>`. That endpoint carries workflow tools; the
brain's own tools stay on the connector above. `deploy/README.md`,
"Orchestration", has the keys, backups, the run-history window and upgrades.

The licences, as the fork reads them (not legal advice): n8n is under its
Sustainable Use License, OB1 under FSL-1.1-MIT, so running the profile means
running two non-OSI licences side by side. Installing an OB1 brain with the
profile on a client's own infrastructure is inside both, since n8n's FAQ
permits consulting and installing on a client's server. Hosting the profile
for others is outside n8n's licence. A commercial product built on OB1 that
competes with it is outside OB1's.

## Expected outcome

`migrate` exits 0 having applied every migration under `db/migrations/`. `server`
logs `preflight OK` and `Started server`. `smoke.sh` reports every check passed
(`deploy/README.md` has the count, and the liveness-probe target for a platform
that can only GET). A client shows twelve tools for a write key, nine for a read
key.

## Where to run it for real

`deploy/compose.yaml` is a working reference, not a production topology — no TLS,
no backups, no resource limits. For something durable:

| | |
| --- | --- |
| **Container + managed Postgres** | RDS, Aurora, Neon, Cloud SQL, or Timescale with pgvector 0.8.0 or later; the server as a container. `DATABASE_URL` — the SQL store, the default (FORK.md change 97). The simplest data path. If the provider installs pgvector into a schema off the connection's `search_path` (Supabase uses `extensions`), the migrator heals its own session and preflight fails with the exact `ALTER ROLE … SET search_path` to run for the server — see `FORK.md` change 43. |
| **Cloudflare Workers** | `server-portable` builds for Workers (`server-portable/README.md` has the bundle size). Workers cannot pool Postgres connections, so `wrangler.toml` selects the PostgREST store there (`OB1_STORE=postgrest`, the one target that still needs a PostgREST endpoint); a Workers-capable Postgres driver is SMD-1847's measurement. |

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
