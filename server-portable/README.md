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
OpenAI-compatible endpoints, so switching providers is configuration. By default
one endpoint serves both; `OB1_CHAT_BASE_URL` gives the chat calls (metadata,
chunk blurbs, the supersession judge) an endpoint of their own — local
embeddings with a hosted chat model, or a second local runtime that serves
chat only, beside Ollama:

| Variable | Default | Notes |
| --- | --- | --- |
| `OB1_LLM_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible `/v1`. Ollama works. Embeddings — and chat, unless the next row says otherwise |
| `OB1_LLM_API_KEY` | falls back to `OPENROUTER_API_KEY` | Omitted entirely for a loopback endpoint |
| `OB1_CHAT_BASE_URL` | the embeddings endpoint | Where `/chat/completions` goes when that is a different provider; `OB1_METADATA_MODEL` then names a model this endpoint serves |
| `OB1_CHAT_API_KEY` | none for a different endpoint; the embeddings key for the same one | A credential belongs to an endpoint: a different chat endpoint never inherits `OB1_LLM_API_KEY` or `OPENROUTER_API_KEY` (both are the embeddings endpoint's), so a local chat model beside a hosted embedder is not handed the hosted key, and local embeddings with OpenRouter for chat means this knob, not `OPENROUTER_API_KEY`. Preflight fails a hosted chat endpoint with no key of its own and names the fix |
| `OB1_LLM_TIMEOUT` | `120` seconds | Per provider call, both endpoints — embedding, blurb and metadata extraction alike; a call that never returns fails as such instead of hanging |
| `OB1_EMBEDDING_MODEL` / `OB1_EMBEDDING_DIM` | `openai/text-embedding-3-small` / 1536 | Must match the column; permanent once there is data |
| `OB1_METADATA_MODEL` | `openai/gpt-4o-mini` | No schema dependency — safe to change anytime |
| `OB1_JUDGE_MODEL` | the metadata model | The supersession judge's model (`db/consolidate.ts`), for running the judge — the harder task — on a stronger model than every capture's tagging; a model the chat endpoint serves. The pass key carries it, so a change starts a fresh pass (SMD-1901) |
| `OB1_LLM_LOCAL` / `OB1_CHAT_LOCAL` | unset (remote) | `1` declares the embeddings / chat endpoint on this machine or its private network, so the egress gate does not apply to it. Declared, never guessed from the address: a loopback URL with the flag unset is remote to the gate. A chat endpoint at the same base is the same box: either knob declares it (SMD-1903) |
| `OB1_EGRESS_POLICY` | `deny` | What may leave the box for an endpoint not declared local: `deny` (only what an `OB1_EGRESS_ALLOW` term names), `allow` (everything but what an `OB1_EGRESS_DENY` term names), `off`. A knob that does not parse fails preflight and closes the gate |
| `OB1_EGRESS_ALLOW` / `OB1_EGRESS_DENY` | none | Comma-separated `unit:value` terms — `actor` (the access key's name), `source`, `type`, `topic` (a row's metadata), `marker` (a literal in the text) — read under `deny` and `allow` respectively |

The two calls fail differently and deliberately. An embedding failure fails the
capture, because a thought with no vector is invisible to search. A metadata
failure lets the capture succeed and records why, because the content is the
durable part and the tags are re-derivable.

A call the **egress gate** refuses is neither (`egress.ts`, SMD-1903). The
server asks the gate before either call and makes only the ones it allows: a
refused embedding lands the capture with its text and fingerprint and no vector,
the reply says so and names the rule, and the decision is recorded on the
thought's audit row (`thought_audit.actor_context.egress`); a refused tagging
call lands it untagged — no topics, no type — with `metadata_extraction_failed:
egress_denied`, and a re-capture of a tagged thought keeps its tags and vector
(only the marker merges in — and stays: the merge cannot remove a key, so a
`metadata_extraction_failed` marker on a thought that carries real tags is
informational and may be stale, as for the other failure reasons). An edit is
judged on the row's own metadata; a capture is judged before the write, on
the actor and the text alone. A refused search names `search_thoughts_keyword`, which makes no
model call. Every dialler — `providerCall`, the judge, the entity extractor —
asks the gate itself before the request, so no call the fork makes is ungated;
a refusal there is a `ProviderError` of kind `egress`. Deny is the default and
"local" is declared, never guessed: a stack from before the gate that points
at Ollama by address needs `OB1_LLM_LOCAL=1`, and preflight's `embeddings
egress` row says so with the line.

`preflight.ts --deep` exercises both against the live endpoint, checks the
embedding width matches the schema, and checks the metadata model actually honours
JSON mode — a provider that ignores `response_format` degrades every capture to
`uncategorized` without ever failing — and, when `OB1_JUDGE_MODEL` names a
different model, checks that one too under its own `judge model` row. `chunk window` prints the length a capture
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
violation 018 removed for edits), one from before 035 fills a NULL `supersedes`
on a re-capture without walking for a loop and holds the supersession lock
through every capture that names one, and a 2-argument body from before 005
empties a double-encoded payload silently — or, from before 033, takes no
lock either; each is a warning naming 035, the last definer of both forms. `provenance` reads
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
key (twins, or a stale key) are ok. `query log` (034, SMD-1295): the opt-in query
log — reported, never a refusal, since it is off by default and its write is
best-effort. When `query_log` is present the check names it and whether
`OB1_QUERY_LOG=on` here, says what it stores (personal data at rest) and its
retention, and points at `evals/export-queries.ts` and `evals/eval-utilization.ts`;
absent, it is a skip; present without migration 035 it warns, since a write that
cites a returned id logs no cite row there (SMD-1719). Over PostgREST every
direct-connection check — this one included — prints a row: six are probed
through the store's own calls (`filtered search`, `keyword search`, `hybrid
search`, `search signatures`, `edit signature`, `delete signature`), five say
what catalog fact they would have read, and the sixteen catalog-only ones say
they have no PostgREST form (change 97's first review pass; before it those
sixteen printed nothing on that path).

## Choosing a data layer

| `OB1_STORE` | Talks to | Needs | Runs on |
| --- | --- | --- | --- |
| `sql` *(the default — leave `OB1_STORE` unset)* | Postgres directly, via `Bun.sql` | `DATABASE_URL` (or `SUPABASE_URL` holding a `postgres://` URL) | Bun: the container, a bare `bun index.ts` |
| `postgrest` | PostgREST over HTTP, via `supabase-js` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Workers, where `wrangler.toml` selects it |

The SQL store is the default (FORK.md change 97, SMD-1797): it is what `SETUP.md`'s
container runs, what every CI job against real Postgres drives, and the one that
needs no Supabase project. The PostgREST store is kept for one reason — Cloudflare
Workers cannot hold a Postgres connection, so the Bun client `store-sql.ts`
imports does not run there — and `wrangler.toml` pins `OB1_STORE=postgrest` for
that target as a `[vars]` binding, a property of the target rather than a secret.
Selected anywhere Bun runs, the PostgREST store is reported as retired: `preflight.ts`
warns under `store selection`, and the server logs the same line once when it
builds the store. Whether the SQL store can run on Workers through a driver that
runs there (Hyperdrive in front of `postgres` or `pg` over `connect()`) is
SMD-1847's measurement; until it lands, Workers is PostgREST-only.

`store-sql.ts` is imported **dynamically**, so a Workers build never pulls in the
Postgres client. Wrangler's bundler still resolves the specifier statically, so
`wrangler.toml` aliases `bun` to `shims/bun-unavailable.ts` — a stub that throws
with an explanation if a Workers deployment somehow selects the SQL store (by
setting `OB1_STORE=sql`, or by losing the `[vars]` binding and getting the
default) and has a connection string for it to open. Without one, the factory
refuses first on the missing `DATABASE_URL`, naming `OB1_STORE=postgrest` as the
way out, and the stub is never imported.

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
| Cloudflare Workers | `bun run cf:build` then `wrangler deploy` | ~281 KiB gzipped |
| Node | `bun run --bun index.ts`, or wrap with `@hono/node-server` | Same shim |

### 3. Provide configuration

Required in every environment:

```
MCP_ACCESS_KEYS              name:scope:sha256 entries, scope read | write | capture — bun keygen.ts mints one (or the legacy MCP_ACCESS_KEY, one raw key, write scope)
DATABASE_URL                 the brain's postgres:// connection string — the SQL store, the default
OPENROUTER_API_KEY           embeddings, and metadata extraction unless OB1_CHAT_BASE_URL gives chat its own endpoint — then OB1_CHAT_API_KEY (neither needed for a local endpoint)
```

On Cloudflare Workers, where `wrangler.toml` selects the PostgREST store,
`SUPABASE_URL` (the PostgREST base URL) and `SUPABASE_SERVICE_ROLE_KEY` replace
`DATABASE_URL`. A box that also runs a vendored server migrated onto
`compat/supabase-sql` — which reads a `postgres://` URL from `SUPABASE_URL` — may
set that one name for both: this server reads a `postgres://` `SUPABASE_URL` as
`DATABASE_URL` when the latter is unset (`store.ts:databaseUrl`), and preflight
says which variable supplied the string. An `https://` `SUPABASE_URL` with no
`OB1_STORE` — the deployment the old default served — is refused by preflight and
by the store's first use with both ways out named: set `DATABASE_URL`, or set
`OB1_STORE=postgrest` to keep reaching the brain through PostgREST. The mirror
slip — `OB1_STORE=postgrest` kept beside a `SUPABASE_URL` that holds a
`postgres://` string — is refused by name too, the string masked, rather than
handed to supabase-js as a base URL.

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

## What this brain is: `brain_info` and a keyed `/health`

An agent or an operator can ask a running brain what it is (SMD-2041). The
**`brain_info`** tool (read scope — a read or a write key sees it, a capture-only
key does not) answers a short table:

```
Version:         1.1.0+upstream.9543c29 (release range 049–051; this tree adds 052, unreleased)
Commit:          8ba58db5…
Store:           sql · tier stable
Embedding:       qwen3-embedding:4b @ 1024
Postgres:        16.15 (Debian 16.15-1.pgdg12+2) · pgvector 0.8.6 (schema public)
Schema version:  1.1.0+upstream.9543c29
Migrations:      052 applied — this server's tree ends at 052 (current: the ledger's highest is the tree's last)
Brain embedding: qwen3-embedding:4b @ 1024
Rows:            373 thoughts · 1,204 audit events · 90 chunks · 512 entities
Database size:   45.2 MB
HNSW:            thought_chunks_embedding_idx on thought_chunks (m 16, ef_construction 64); …
```

What the judgements mean. `ledgerStatus` compares one number: the ledger's
highest migration against the last file of the tree this server was built from.
`current` says they are equal — not that every file below it was applied as
written: a skipped, renumbered or edited migration is what `migrate.ts --dry-run`
lists, file by file (SMD-2069 compares the two lists). Between release cuts the
version stays the last cut's; `unreleased` names the migrations this tree adds
past its range. The audit count is the event log's size — every capture, edit and
delete, deleted thoughts' included — not a count of thoughts. `Database size` is
the whole database's. The server's embedding and the brain's are printed side by
side without a verdict (preflight's embedding rows judge them; SMD-2071).

**`GET /health` with a read or write key** (the `x-brain-key` header, a bearer
token or `?key=`) answers the same record as JSON — `version`, `releaseRange`,
`unreleased`, `latestMigration`, `commit`, `store`, `tier`, `embedding`,
`ledgerStatus` (`current` | `behind` | `ahead` | `null`) and `database`, which carries the
database's facts (the ledger as `{ present, readable }`, not its names) or
`{ "error": … }` when it cannot answer. It answers within 2.5 s
(`HEALTH_DEADLINE_MS`) whatever the database does — still a 200, since the
process is serving. A database that refuses at once is `database.error`; one
that never answers (a dropped route) leaves the agent registry unanswered too,
and the body is then the literal `ok`, as for a key the server cannot vouch for
(below); tables locked by a migration cost their lock waits. The
read is one transaction whose statements are capped at 800 ms and whose lock
waits at 300 ms (never above a stricter setting the role already has), a read
that does not answer is named in `unread` with its reason (`refused`,
`timeout`, `deadline`, `invisible`, `error`), the facts read by the deadline
are kept, and a database whose catalog has not answered by then is
`database.error`. Concurrent probes share one read, and requests of one key share
one agent-registry lookup (at /health and the MCP route alike), so a burst during
a migration holds one connection for the read and one per distinct key — the
registry's lock wait itself is unbounded (SMD-2072). Without a key, with a wrong
or capture-only key, or with a revoked one — or while the agent registry has
not answered by the deadline, since it could still say revoked — the body is
the literal `ok`, so nothing about the deployment reaches an unauthenticated
probe; a `HEAD`, keyed or not, is the bodiless `ok` and reads nothing. Point a
platform's liveness probe at the keyless form. `deploy/smoke.sh`'s check 10
reads the keyed body.

Where each fact comes from: the version, its release range and the tree's last
migration are generated into `version.ts` by `scripts/gen-version.ts` (the Workers
build cannot import the node-only `db/version.mjs`, and neither a Worker nor the
image carries `db/migrations/`; check-fork's 17e round-trips the file, and in a
checkout preflight's `version module` row compares it with `db/migrations/`, so
rerun the script after adding a migration). The commit is the image's
`OB1_GIT_SHA` build arg (`deploy/README.md`), `unknown` when unset — and always
on Workers, which has no build arg. The database's
half is `brain-info.ts`'s `readDatabaseFacts`, the same read preflight's
`vector extension`, `migration ledger` and `schema version` rows make, so the gate
and the tool cannot disagree (preflight skips the counts and size, which it does
not use). Each read that a role or a lock can refuse has a savepoint of its own:
a role without `SELECT` on, say, `ob1_entities` or `schema_migrations` gets that
field as unread, named on a `Not read:` line, and the rest still answers; a table
that exists where the role cannot resolve it (off its search path, or no USAGE on
its schema) is `invisible`, never "no table". The tool's statements are capped at
5 s and its whole read at 15 s. Over the PostgREST store (Workers) the
database's half is not read — PostgREST exposes no catalog reads — and the table
says so; see Caveats.

## Expected outcome

```bash
bun test-server.ts        # 213 — transport, auth, tool surface, OAuth discovery, the method guard, /health, the store default and the tool-call keepalive
bun test-auth.ts          # 97 — scoped, hashed, named keys
bun run test:local        # 52 — fully local provider, no credential
bun run test:sql          # 123 — store conformance, real Postgres in a container
bun run test:e2e          # 162 — the whole server over MCP with no Supabase at all, OB1_STORE unset
bun run cf:build          # ~342 KiB gzipped (measured 2026-09-20 at change 97; the PostgREST store and supabase-js are in it)
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

`test-e2e-sql.ts` goes further: it boots the real server with `OB1_STORE` unset —
the default store is what it drives — and `SUPABASE_URL` deleted from the
environment, and drives the tools over real JSON-RPC against real Postgres. Only the model provider is stubbed, so the suite
stays hermetic and free.

`test-egress.ts` holds the egress gate (SMD-1903): the policy's parsing, "local"
as a declaration, every term unit, a second opinion that can only refuse, the
three diallers refusing before any request reaches a counting stub — and the
real server under the default, where a capture from a key no term names lands
without a vector and says why at zero requests while the key a term names
reaches the stub. Every other suite that boots the server against a stub
declares it local (`OB1_LLM_LOCAL=1`), which is the upgrade every stack from
before the gate makes.

**Not yet ported:** `test-stats-pagination.mjs` and `test-capture-atomicity.mjs`
still live in `../server/` and still test mirrors of the Deno build. They are now
largely superseded for the portable build — the store interface makes both paths
directly testable — but the Deno build still needs them.

## Caveats

- **`brain_info` on Workers reports the server, not the database.** The
  PostgREST store has no catalog reads: the version, commit (`unknown`, no build
  arg), store and embedding answer; the database's versions, ledger, counts and
  indexes do not. A container or Bun deployment on the SQL store reports them.
- **Workers cannot pool Postgres connections.** `wrangler.toml` pins
  `OB1_STORE=postgrest` there; the SQL store, selected by hand or by a lost
  binding, fails loudly via the shim. Whether Hyperdrive and a Workers-capable
  driver let the SQL store run there is SMD-1847 — measured before promised.
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
- **A tool call may run longer than the runtime's idle timeout.** Bun closes a
  connection that has been silent for 10 s — a streaming response included, at
  the next of its 4-second sweeps, so after 8 to 12 s of silence — and the MCP
  transport opens a tool call's SSE stream at once and writes to it only when
  the tool returns. A capture whose model calls took ten seconds was closed under
  the client with nothing in the server's log (SMD-1864). Every event stream now
  carries a `: keepalive` comment frame every 5 s (`SSE_KEEPALIVE_MS` in
  `index.ts`), a line SSE parsers discard by specification, for as long as the
  tool runs — up to ten minutes (`SSE_KEEPALIVE_MAX_MS`), past which the frames
  stop, one line says `request still running after N s: …` and, on Bun, the
  idle timeout reaps the stream (not logged again as a client leaving); on Node
  or Workers it stays open until the client or a proxy gives up. A provider
  call is bounded by `OB1_LLM_TIMEOUT`, so a call that long is stuck in the
  database. The idle timeout itself stays at the runtime's default, which is
  the right reaper for a dead socket, and the two intervals are constants, not
  knobs: 5 s is inside any proxy read timeout worth running (SMD-1846). A
  client that closes the connection before the response is complete is the
  other line the server logs per request — `request abandoned by the client
  after 9.8 s: tools/call capture_thought …` — by method and tool (each capped
  at 64 printable characters), never by content; the MCP SDK client gives up at
  60 s by default, so for a Claude Desktop-class client that is the line a
  stuck call produces, long before the ceiling. The call runs to its end on the
  server, and a retry of the same text is `upsert_thought`'s fingerprint no-op
  rather than a second row. The rest of per-request logging is SMD-1849.

## Related

- `../server/` — the original Deno / Supabase Edge Function build, still deployable
- `../FORK.md` — what this fork changes and why
- `../integrations/kubernetes-deployment/` — a raw-SQL port that drops PostgREST too
