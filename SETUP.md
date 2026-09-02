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
| `nomic-embed-text` | 768 | Runs locally via Ollama. See below. |
| `openai/text-embedding-3-small` | 1536 | The default. Cheap, good enough for most brains. |
| `voyage/voyage-3` | 1024 | Smaller index, competitive retrieval quality. |
| `openai/text-embedding-3-large` | 3072 | **Exceeds pgvector's HNSW limit of 2000.** The column works, but no index can be built, so every search becomes a full table scan. |

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
OB1_EMBEDDING_MODEL=nomic-embed-text
OB1_EMBEDDING_DIM=768
OB1_METADATA_MODEL=llama3.2
# leave OPENROUTER_API_KEY empty
```

```bash
podman compose -f deploy/compose.yaml --profile local-models up --build
```

That profile adds an `ollama` service and a one-shot job that pulls both models
(a few hundred MB on first run). No credential is sent to a loopback provider —
the server omits the `Authorization` header entirely.

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
- `deploy/README.md` — the compose stack in detail
- `FORK.md` — what this fork changes and why
