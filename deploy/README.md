# deploy — running Open Brain without Supabase

Phase 4 of the migration: the operational glue. Supabase supplied a database, a
place to run the function, a secret store and a deploy command. Off Supabase each
is an ordinary piece of infrastructure, and this directory is the smallest working
arrangement of them.

`compose.yaml` is the migration plan's Phase 4 exit test made literal — a change
reaches a running system with **no Supabase CLI installed and no supabase.com
account involved**. It is a reference, not a production topology: no TLS, no
backups, no resource limits.

## Prerequisites

- podman or docker, with compose
- An OpenRouter API key

## Steps

### 1. Configure

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → MCP_ACCESS_KEY
```

`deploy/.env` is gitignored. This replaces `supabase secrets set`: the same values,
now ordinary environment variables your platform's secret store supplies.

### 2. Bring it up

```bash
podman compose -f deploy/compose.yaml up --build
```

Three services, in order:

| Service | Replaces |
| --- | --- |
| `postgres` | The Supabase-hosted database (`pgvector/pgvector:0.8.6-pg16`) |
| `migrate` | Pasting SQL into the Supabase dashboard — runs `db/migrate.ts`, then exits |
| `server` | The Edge Function and `supabase functions deploy` |

### 3. Verify

```bash
./deploy/smoke.sh
```

### 4. Connect a client

```
http://localhost:8000/?key=<MCP_ACCESS_KEY>
```

## Expected outcome

`migrate` exits 0 having applied every migration under `db/migrations/` (it needs no `bun install` —
`migrate.ts` imports only Bun and `node:` built-ins). `server` logs `preflight OK`
followed by `Started server`. `smoke.sh` prints `8 checks: 8 passed, 0 failed`.

Point an HTTP liveness probe at **`GET /health`** (200, no key). The MCP endpoint
itself serves POST only: `GET /` and `HEAD /` answer 405 since FORK.md change 73,
so a platform-default probe aimed at `/` marks a healthy server down. The image's
own `HEALTHCHECK` POSTs to the endpoint instead, which also proves the MCP path
serves; either is fine. Opening the connector URL in a browser shows
`Method Not Allowed`, which is expected.

## Why the server runs preflight before serving

The data layer is built lazily on first use. Without a gate, a server with a wrong
`DATABASE_URL` starts cleanly, answers `initialize`, returns every tool from
`tools/list`, and passes any HTTP liveness probe — then fails when a user captures
their first thought, with the real error buried inside a tool response.

On Supabase this mattered less: the platform injected the database credentials, so
they could not be wrong. Off Supabase every one is hand-written.

So the container's entrypoint is `bun preflight.ts && exec bun index.ts`. A
misconfigured deployment crashloops, which is visible, instead of looking healthy,
which is not. `preflight.ts --json` suits a pipeline gate; `--deep` also calls
OpenRouter and checks the embedding width still matches the schema.

One check that matters most on a managed database: `vector extension`. If the
provider installed pgvector into a schema off the connection's `search_path`
(Supabase uses `extensions`), the bare `vector` type does not resolve and every
capture and search would fail with `type "vector" does not exist` on a database
that has pgvector. Preflight fails with the schema it found and the exact
`ALTER ROLE … SET search_path` (or `ALTER DATABASE`) to run — see `FORK.md`
change 43.

## Using smoke.sh against a real deployment

It only needs a URL and a key, so the same check covers every target:

```bash
./deploy/smoke.sh https://ob1.internal.example.com "$MCP_ACCESS_KEY"
```

Read-only — it never captures a thought, so it is safe against production. Exit 0
if the deployment serves correctly, 1 otherwise.

Give it the URL a connector would be given, without its `?key=` — the key is the
second argument, and a query string is refused. Check 2 probes the **origin root**,
which is where claude.ai looks for OAuth discovery before it will open a custom
connector (with the server's path as a suffix, when the URL carries one). A server
behind a path prefix needs its proxy to route `/.well-known/` to it, or to 404 it
there, for that check to pass.

## What this does not cover

- **TLS, backups, resource limits, log shipping.** Reference topology only. One
  limit is set because the stack met it: the postgres service's `shm_size`
  (`POSTGRES_SHM_SIZE`, 1 GB), since a parallel HNSW index build keeps its whole
  graph in `/dev/shm` and a container's default 64 MB fails the rebuild after a
  bulk load of a few hundred thousand rows. Raise it with `maintenance_work_mem`
  before rebuilding a large index, or build with
  `max_parallel_maintenance_workers = 0` (`db/README.md`, "Caveats").
- **A Supabase Edge Function passing checks 2 and 3.** On Supabase the API gateway
  answers the OAuth discovery path with 401 before the function sees it, so check
  2 fails there — and the failure is real: the claude.ai connector will not open
  against that deployment either (upstream
  [#340](https://github.com/NateBJones-Projects/OB1/issues/340); FORK.md change 42).
  Check 3 fails too: upstream's `server/index.ts` has no method guard, so a GET
  answers 200 instead of 405, and with a key it hangs (upstream
  [#424](https://github.com/NateBJones-Projects/OB1/issues/424); FORK.md change 73).
- **Scheduled jobs.** One recipe (`recipes/editorial-policy`) uses `pg_cron` and
  `pg_net` to call an endpoint on a schedule. Off Supabase that becomes an ordinary
  cron job, a Kubernetes CronJob, or a scheduled workflow. Not ported here.
- **Data migration.** `pg_dump --data-only` from the old database, plus a full
  re-embed if the embedding model family changes — `db/reembed.ts`, run from a
  checkout with the provider reachable, not from this stack.
- **Entity extraction.** `db/extract-entities.ts --follow` is a long-running
  worker with a per-thought model cost; it is not a service here. Run it from a
  checkout, with `OB1_WORKER_KEY` set to a key whose hash is in
  `MCP_ACCESS_KEYS`, when you have decided to pay that cost. The same goes for
  `db/consolidate.ts`, the pass that proposes supersessions from the entities
  that worker extracts (a per-pair cost; `db/README.md`), and for reviewing
  what it proposes.
- **Auth.** Still a single shared key, in a header or `?key=`. Moving off Supabase
  does not improve that; see [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).

## Related

- `../db/` — the schema and its migration runner
- `../server-portable/` — the server, and `preflight.ts`
- `../FORK.md` — what this fork changes and why
