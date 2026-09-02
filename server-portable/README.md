# server-portable

A runtime-neutral build of the Open Brain MCP server. Same six tools, same wire
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
| Cloudflare Workers | `bun run cf:build` then `wrangler deploy` | ~252 KiB gzipped |
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

### 4. Apply the migration

`../db/migrations/004_upsert_thought_with_embedding.sql` is still required for
the atomic capture path. Without it, capture falls back to the two-step write and
logs a warning.

## Expected outcome

```bash
bun test-server.ts        # 41 — transport, auth, tool surface
bun run test:sql          # 37 — store conformance, real Postgres in a container
bun run test:e2e          # 30 — the whole server over MCP with no Supabase at all
bun run cf:build          # ~256 KiB gzipped
```

`test:sql` and `test:e2e` need podman or docker; they use `../db/with-postgres.sh`
to start and remove a throwaway `pgvector/pgvector:pg16`.

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
deletes `SUPABASE_URL` from the environment, and drives the six tools over real
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
