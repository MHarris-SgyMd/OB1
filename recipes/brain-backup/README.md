# Brain Backup and Export

> **On this fork (SMD-2144).** `backup-brain.mjs` reads the brain through `compat/supabase-sql` under `bun`: `SUPABASE_URL` is a `postgres://` connection string, `SUPABASE_SERVICE_ROLE_KEY` is accepted and ignored, and the script runs from a checkout (its import is relative). Until SMD-2144 it reached the brain as a PostgREST client — `${SUPABASE_URL}/rest/v1/…` with a service-role key — over a gateway this fork's stack does not run (SETUP.md); the decision for the class is in `docs/vendored-disposition.md`. The export is the portable, readable form of the brain, not its restore path: **`pg_dump` of the stack's database is the whole-brain backup** — `compose exec -T postgres pg_dump -U postgres openbrain > dump.sql` (`deploy/README.md`, the `postgres` service row; its data-migration note is `pg_dump --data-only` plus a re-embed if the model changes) — and it has the fork's own tables (`thought_audit`, `thought_sources`, `thought_facets`, `ob1_entities`, …), which this export does not.

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Created by [@alanshurafa](https://github.com/alanshurafa)**

</div>

Export the Open Brain tables to local JSON files. The script pages each table through `compat/supabase-sql` (1 000 rows per query), writes each table to a dated JSON file, and prints a summary.

## Prerequisites

- An Open Brain setup: the brain's Postgres, reachable from where the script runs (`deploy/README.md`: a checkout reaches the stack's database with `-f deploy/compose.host-ports.yaml`)
- [Bun](https://bun.sh) 1.4 or later, and a checkout of this repository — the script imports `../../compat/supabase-sql`, so it runs in place, not copied out
- A `.env.local` file in the directory you run from (or an exported environment variable) containing:
  - `SUPABASE_URL` -- the brain's `postgres://` connection string (`SUPABASE_SERVICE_ROLE_KEY` is accepted and ignored: the credentials live in the URL)

## Steps

1. From the recipe's directory in your checkout, copy or create a `.env.local` file with the connection string:

   ```
   SUPABASE_URL=postgres://user:password@host:5432/openbrain
   ```

2. Run the backup script:

   ```bash
   cd recipes/brain-backup
   bun backup-brain.mjs
   ```

   The `.env.local` it reads and the `backup/` folder it writes are the current directory's, so a scheduler runs it with that directory as its working directory.

3. The script creates a `backup/` folder and writes one JSON file per table, named `<table>-YYYY-MM-DD.json`.

4. Review the printed summary to confirm all tables exported successfully. A table that failed shows `ERROR` in the summary and the run exits 1, so a scheduler sees it; the other tables' files are still written.

## Expected Result

After running the script you will have a `backup/` directory containing dated JSON exports of every table the script knows that is present in your brain.

- `thoughts` is always backed up (required).
- Optional companion tables — `entities`, `edges`, `thought_entities`, `ingestion_jobs`, `ingestion_items` — are backed up only if they exist. They ship with the companion schemas: `schemas/entity-extraction` for the first three (on a fork brain `thought_entities` is migration 016's, and is exported as it is) and `schemas/smart-ingest` for the last two. A brain without them will see `skipped (table not present)` for those, which is expected.

The console output shows row counts and file sizes for each table, making it easy to verify the backup is complete.

## Tips

- Schedule the script with cron or Task Scheduler for automatic daily backups.
- Commit the `backup/` directory to a private repo for versioned history.
- The script streams rows to disk, so it handles large tables without running out of memory.
- Timestamps come out as ISO strings and the `embedding` column as its vector text, as PostgREST's JSON had them. `bigint` and `numeric` columns — the entity tables' ids, `quality_score`, `confidence` — come out as JSON strings (`"1"`), where PostgREST gave numbers; tooling that read the old export as numbers should expect strings here.

## Troubleshooting

- **`expected a postgres:// connection URL`** -- `SUPABASE_URL` still holds a Supabase project URL. On this fork it is the brain's `postgres://` connection string (`SETUP.md`); the script refuses before any query.
- **`Required table "thoughts" not found in the database`** -- the connection reached a database without the Open Brain schema: the wrong database name in the URL, or a brain whose migrations have not run (`bun db/migrate.ts`). Only Postgres's "relation does not exist" (`42P01`) is treated as "table not present"; everything else is surfaced so you can diagnose it.
- **`Postgres error 42501 on thoughts: permission denied for table thoughts`** -- the connection's role has no SELECT on the table. Connect as the brain's owner, or grant the role with `bun db/migrate.ts --grant <role>` (`db/README.md`) — that is the capturing role's grant, SELECT and the writes on every table the export reads; a read-only credential is a hand `GRANT SELECT ON thoughts, entities, edges, thought_entities, ingestion_jobs, ingestion_items TO <role>` instead.
- **`skipped (table not present)` for optional tables** -- expected on a brain without the companion schemas (`schemas/entity-extraction`, `schemas/smart-ingest`).
- **A table shows `ERROR … timed out after 60000 ms`** -- set `FETCH_TIMEOUT_MS` to a larger value (milliseconds) if the database is slow or a table very large. The page is abandoned, not cancelled: the other tables still export, the run exits 1, and it ends within a few seconds of its summary rather than waiting for the abandoned query.
