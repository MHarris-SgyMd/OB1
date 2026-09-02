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

Two changes. Everything else is byte-identical.

1. **No Deno globals.** `Deno.env.get(…)` and `Deno.serve(…)` are gone, and the
   `jsr:@supabase/functions-js/edge-runtime.d.ts` type import is removed.
2. **Env is read lazily.** Cloudflare Workers has no module scope for secrets —
   bindings arrive on the request context — so the four import-time env reads and
   the eager `createClient` became an `initEnv`/`env()`/`db()` shim, seeded by the
   first middleware. On Deno, Bun and Node it falls back to `process.env`.

The second change is what makes the file portable, and it is also what makes it
testable. See *Testing* below.

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

`bun test-server.ts` prints `41 assertions: 41 passed, 0 failed` and `PASS`.
`bun run cf:build` reports a successful upload of roughly 252 KiB gzipped. An MCP
client pointed at the deployed URL completes `initialize`, lists six tools, and
can search and capture.

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

**Not yet ported:** `test-stats-pagination.mjs` and `test-capture-atomicity.mjs`
still live in `../server/` and still test mirrors, because they need a stubbed
Supabase client. The lazy `db()` accessor makes injecting one straightforward, but
that seam is not built yet.

## Caveats

- **Workers cannot pool Postgres connections.** If you pair this with native SQL
  instead of PostgREST, budget for Hyperdrive. On a container the problem does not
  arise.
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
