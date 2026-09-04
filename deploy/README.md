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
| `postgres` | The Supabase-hosted database (`pgvector/pgvector:pg16`) |
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

`migrate` exits 0 having applied five migrations (it needs no `bun install` —
`migrate.ts` imports only Bun and `node:` built-ins). `server` logs `preflight OK`
followed by `Started server`. `smoke.sh` prints `6 checks: 6 passed, 0 failed`.

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
OpenRouter and checks the embedding width still matches `vector(1536)`.

## Using smoke.sh against a real deployment

It only needs a URL and a key, so the same check covers every target:

```bash
./deploy/smoke.sh https://ob1.internal.example.com "$MCP_ACCESS_KEY"
```

Read-only — it never captures a thought, so it is safe against production. Exit 0
if the deployment serves correctly, 1 otherwise.

## What this does not cover

- **TLS, backups, resource limits, log shipping.** Reference topology only.
- **Scheduled jobs.** One recipe (`recipes/editorial-policy`) uses `pg_cron` and
  `pg_net` to call an endpoint on a schedule. Off Supabase that becomes an ordinary
  cron job, a Kubernetes CronJob, or a scheduled workflow. Not ported here.
- **Data migration.** `pg_dump --data-only` from the old database, plus a full
  re-embed if the embedding model family changes.
- **Auth.** Still a single shared key, in a header or `?key=`. Moving off Supabase
  does not improve that; see [issue #216](https://github.com/NateBJones-Projects/OB1/issues/216).

## Related

- `../db/` — the schema and its migration runner
- `../server-portable/` — the server, and `preflight.ts`
- `../FORK.md` — what this fork changes and why
