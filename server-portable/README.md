# server-portable

A runtime-neutral build of the Open Brain MCP server. Same tools, same wire
behaviour as `../server/index.ts`, but with no dependency on Deno or on Supabase
Edge Functions as a host.

This exists so the runtime decision in the Supabase migration can be made last,
and changed later. One file targets four runtimes.

## Prerequisites

- [Bun](https://bun.sh) 1.4+ (used for tests and the container image)
- A Postgres with pgvector and the core Open Brain schema — see
  [the getting-started guide](../docs/01-getting-started.md)
- For the Cloudflare target: a Cloudflare account and `wrangler` (a dev dependency here)

## What differs from `../server/index.ts`

Three changes.

1. **No Deno globals.** `Deno.env.get(…)` and `Deno.serve(…)` are gone, and the
   `jsr:@supabase/functions-js/edge-runtime.d.ts` type import is removed.
2. **Env is read lazily.** Cloudflare Workers has no module scope for secrets —
   bindings arrive on the request context — so the import-time env reads and the
   eager client became an `initEnv`/`env()`/`db()` shim, seeded by the first
   middleware. On Deno, Bun and Node it falls back to `process.env`.
3. **The data layer is swappable.** Every database call goes through the
   `ThoughtStore` interface in `store.ts`, with two implementations.

The second change is what makes the file portable and testable; the third is
Phase 2 of the migration.

## Choosing a model provider

Two calls happen per capture — an embedding, and a metadata extraction. Both go to
one OpenAI-compatible endpoint, so switching providers is configuration:

| Variable | Default | Notes |
| --- | --- | --- |
| `OB1_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible `/v1`. Ollama works. |
| `OB1_LLM_API_KEY` | falls back to `OPENROUTER_API_KEY` | Omitted entirely for a loopback endpoint |
| `OB1_LLM_TIMEOUT` | `120` seconds | Per provider call — embedding, blurb and metadata extraction alike; a call that never returns fails as such instead of hanging |
| `OB1_EMBEDDING_MODEL` / `OB1_EMBEDDING_DIM` | `openai/text-embedding-3-small` / 1536 | Must match the column; permanent once there is data |
| `OB1_METADATA_MODEL` | `openai/gpt-4o-mini` | No schema dependency — safe to change anytime |

The two calls fail differently and deliberately. An embedding failure fails the
capture, because a thought with no vector is invisible to search. A metadata
failure lets the capture succeed and records why, because the content is the
durable part and the tags are re-derivable.

`preflight.ts --deep` exercises both against the live endpoint, checks the
embedding width matches the schema, and checks the metadata model actually honours
JSON mode — a provider that ignores `response_format` degrades every capture to
`uncategorized` without ever failing. `chunk window` prints the length a capture
is windowed above, the window size, and where the numbers came from — `OB1_CHUNK_TOKENS`, the model's
measured window (`db/config.mjs`, `KNOWN_MODEL_WINDOW`), or the default for a
model the table does not know — and warns when an explicit limit is over the
window, or over the headroom under it the estimate needs, since a window that
overshoots is cut silently (SMD-1305). With or without `--deep`, over a direct
connection it also reads the claim table: a re-embed pass that has not finished —
rows pending, leased or failed under a `reembed:` key — is a warning with the
counts and the command that finishes it, because `ob1_config` records the new
model from the pass's first moment while the rows say how far it got
(`db/README.md`, "What preflight sees"); the remedy names `--accept-failed` for
a row the provider refuses permanently and `--retire` for a superseded key, the
operator's two acknowledgements. And since migration 021 every vector
carries the model that produced it, so `vector models` reads the corpus by
that label: vectors at another model are a warning with the counts and the
re-embed as the remedy, whether or not any claim row remembers the pass that
left them — a vector the operator accepted, and has not written since, is
detail; the column missing under this server is a failure, as is a database
whose `update_thought` predates 032 or carries an older form beside it (`edit
signature`) — the server sends the model on every capture and every edit, and
the provenance envelope (`p_provenance`, migration 032) on every edit.
Over a direct connection `atomic capture` reads both `upsert_thought` bodies
as well, since a `CREATE OR REPLACE` from outside the migrations — an earlier
migration by hand, the getting-started guide pasted again, a vendored schema
or recipe (SMD-1250) — replaces one with no error: a 3-argument body from
before 022 leaves a re-capture's stale windows behind, one from before 025
drops `derived_from` and `supersedes` silently, one from before 033 takes no
fingerprint lock (a capture racing an edit of the same text raises the unique
violation 018 removed for edits), one from before 034 fills a NULL `supersedes`
on a re-capture without walking for a loop and holds the supersession lock
through every capture that names one, and a 2-argument body from before 005
empties a double-encoded payload silently — or, from before 033, takes no
lock either; each is a warning naming 034, the last definer of both forms. `provenance` reads
`trace_provenance`'s body the same way and warns, naming 026, when the
bounded walk is gone; `stats summary` warns when `thought_stats_summary`'s
body is not 024's; and `work claims` fails when `release_thought`'s or
`release_claims_for_worker`'s body is not 015's — every worker release would
fail 015's CHECK — and names any overload of the claim names no migration
defines. `write privileges`: a role missing any privilege the capture path's
writers need — SELECT/INSERT/DELETE on `thought_chunks`, INSERT on
`thought_audit`, DML on `thoughts`, each writer running as its caller — is a
failure naming each
missing one with its GRANT (`db/config.mjs`'s `ROLE_GRANTS`, the same list
`migrate.ts --grant` issues). `fingerprint backfill` (023): a thought without a fingerprint
whose text no row holds is a capture doubled in waiting — a warning naming the
migration, or after it the one statement `SELECT backfill_content_fingerprints();`
as the table's owner; NULL rows that share their text with the row holding the
key (twins, or a stale key) are ok. Over PostgREST all three are skips: none is
reachable there.

## Choosing a data layer

| `OB1_STORE` | Talks to | Needs | Runs on |
| --- | --- | --- | --- |
| `postgrest` *(default)* | PostgREST over HTTP, via `supabase-js` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | anywhere, Workers included |
| `sql` | Postgres directly, via `Bun.sql` | `DATABASE_URL` | container runtimes only |

Both are kept on purpose. The cutover step in the migration plan runs the two
stacks against the same data and diffs the results, which is impossible if the old
path is deleted in the same change. And Cloudflare Workers cannot hold a
connection pool, so PostgREST stays the right pairing there — selecting at runtime
keeps the runtime decision and the data-layer decision independent.

`store-sql.ts` is imported **dynamically**, so a Workers build never pulls in the
Postgres client. Wrangler's bundler still resolves the specifier statically, so
`wrangler.toml` aliases `bun` to `shims/bun-unavailable.ts` — a stub that throws
with an explanation if a Workers deployment is somehow configured with
`OB1_STORE=sql`.

### Two behaviours the SQL port had to preserve exactly

- `match_thoughts` compares `> match_threshold` **strictly**, so a row whose
  similarity equals the threshold is excluded. The SQL store calls the stored
  function rather than reimplementing the ranking, which keeps that guaranteed in
  one place.
- jsonb parameters must be bound as **objects**. `Bun.sql` binds a JS string to a
  jsonb parameter as `jsonb_typeof='string'`, and `p_payload->'metadata'` then
  returns NULL — silently storing `{}`. Migration 005 rejects that outright.

### Ranking by recency, opt-in (migration 020)

`search_thoughts` takes `recency_weight` (0–1, default 0). At 0 the ranking is
by meaning alone, exactly as before; at 0.2 a thought's age counts gently
against its similarity (half-life 90 days); at 1 the thoughts above the
threshold come newest first. The threshold still gates the raw similarity, so a
weight reorders relevant thoughts and cannot surface irrelevant recent ones, and
the `% match` shown is always the cosine. Both stores send `recency_weight` and
`half_life_days` on every call — the function forms from before 020 no longer
exist, and preflight's `search signatures` check fails a database that still
has them, or has an old form re-created beside 020's. The ChatGPT `search` tool
cannot take a parameter and sends a fixed weight; `db/migrations/020_*.sql` and
`evals/eval-recency.ts` record how it was chosen.

## Steps

### 1. Install

```bash
bun install
```

Runtime dependencies are pinned to the exact versions in `../server/deno.json`, so
every target runs identical library code. **If you bump one file, bump both in the
same commit.**

### 2. Pick a target

| Target | Command | Notes |
| --- | --- | --- |
| Bun, locally | `bun index.ts` | Serves on `PORT`, default 8000 |
| Container | `docker build -t ob1-mcp .` | Alpine + Bun; see `Dockerfile` |
| Cloudflare Workers | `bun run cf:build` then `wrangler deploy` | ~272 KiB gzipped |
| Node | `bun run --bun index.ts`, or wrap with `@hono/node-server` | Same shim |

### 3. Provide configuration

Required in every environment:

```
MCP_ACCESS_KEY               the shared access key clients present
SUPABASE_URL                 PostgREST base URL (or your replacement)
SUPABASE_SERVICE_ROLE_KEY    service credential
OPENROUTER_API_KEY           embeddings + metadata extraction
```

Optional: `OPEN_BRAIN_CITATION_BASE_URL`, `PORT`.

On a container these are ordinary environment variables. On Workers use
`wrangler secret put NAME` — **never** put them in `wrangler.toml`, which is
committed. For `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`
(gitignored).

### 4. Apply the migrations

`../db/migrations/004_upsert_thought_with_embedding.sql` is still required for
the atomic capture path. Without it, capture falls back to the two-step write and
logs a warning.

Migration 014 matters here too. The guide's `match_thoughts` applies a metadata
filter *after* choosing its candidates, so a selective filter silently returns
fewer rows than match; preflight probes the RPC on every start and warns while
that body is in place. To clear it, run the fork's migrator against the Supabase
project's **direct** connection string (Project Settings → Database → connection
string, not the pooler) — every migration is idempotent and 014 needs pgvector
0.8.0, which Supabase ships:

```bash
cd ../db && bun migrate.ts --dry-run --url 'postgres://postgres:…@db.<ref>.supabase.co:5432/postgres'
cd ../db && bun migrate.ts --url 'postgres://postgres:…@db.<ref>.supabase.co:5432/postgres'
```

Or record the ones the dashboard already applied with `--baseline` and apply the
rest; `db/README.md` §4 covers both routes.

Upgrade every checkout that runs against the brain — this server, `db/*.ts`, a
second workstation — together with the migrations. A signature-changing
migration leaves an older checkout's preflight refusing the newer brain with a
misleading message (it looks for a form the migration dropped) — 032 today, and
the same shape at 020 and 021 — and, for 032, its `reembed.ts` sending you to
`--reapply` and that older `--reapply` re-creating the dropped form beside the
current one, after which every shorter call is `function is not unique` until a
current checkout re-applies. The compose stack is in lockstep by construction; a hand-run server
or a Supabase brain served from another machine is not (FORK.md change 60;
SMD-1451 is the migrator refusing it).

## Expected outcome

```bash
bun test-server.ts        # 71 — transport, auth, tool surface, OAuth discovery
bun test-auth.ts          # 43 — scoped, hashed, named keys
bun run test:local        # 22 — fully local provider, no credential
bun run test:sql          # 53 — store conformance, real Postgres in a container
bun run test:e2e          # 59 — the whole server over MCP with no Supabase at all
bun run cf:build          # ~272 KiB gzipped
```

`test:sql` and `test:e2e` need podman or docker; they use `../db/with-postgres.sh`
to start and remove a throwaway `pgvector/pgvector:0.8.6-pg16`.

## Testing

`test-server.ts` **imports the real server.** That is the point of this directory.

`../server/index.ts` cannot be imported by a test runner — it reads `Deno.env` at
module scope and imports from `jsr:` — so the suites beside it reimplement the
server inline and assert against the copy. That is precisely how upstream's auth
assertions came to claim HTTP 401 for three months after the server started
returning HTTP 200 ([issue #487](https://github.com/NateBJones-Projects/OB1/issues/487)).
The copy kept passing.

The fork's answer over there is a drift guard that greps `index.ts` as text, which
detects the divergence but does not prevent it. Here there is nothing to diverge
from, so the guards are unnecessary and absent.

`test-e2e-sql.ts` goes further: it boots the real server with `OB1_STORE=sql`,
deletes `SUPABASE_URL` from the environment, and drives the tools over real
JSON-RPC against real Postgres. Only the model provider is stubbed, so the suite
stays hermetic and free.

**Not yet ported:** `test-stats-pagination.mjs` and `test-capture-atomicity.mjs`
still live in `../server/` and still test mirrors of the Deno build. They are now
largely superseded for the portable build — the store interface makes both paths
directly testable — but the Deno build still needs them.

## Caveats

- **Workers cannot pool Postgres connections.** `OB1_STORE=sql` is unsupported
  there and fails loudly via the shim. Use `postgrest` on Workers, or add
  Hyperdrive and a Workers-compatible driver.
- **The SQL store's pool is bounded** at `OB1_PG_POOL` (default 10). PostgREST was
  stateless HTTP, so nothing upstream limits concurrency any more — an unbounded
  pool would let a burst of captures exhaust the server's connection slots.
- **A live `workerd` request has not been exercised.** The Cloudflare build is
  verified with the real bundler; `wrangler dev` could not be reached from the
  authoring sandbox, and a hello-world worker failed identically there, so the gap
  is environmental. Smoke-test a real deploy before trusting it.
- **Auth is unchanged**, which means it is still a single shared key accepted from
  a header or a `?key=` query parameter. Moving runtimes does not improve that; see
  [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).

## Related

- `../server/` — the original Deno / Supabase Edge Function build, still deployable
- `../FORK.md` — what this fork changes and why
- `../integrations/kubernetes-deployment/` — a raw-SQL port that drops PostgREST too
