# Brain Backup and Export

> **In Daemonic Brain (SMD-3318) — moved to `db/`.** The export now lives in
> [`db/backup.ts`](../../db/backup.ts), a `db/` script on Bun's Postgres
> client. The original `backup-brain.mjs` reached the brain as a PostgREST
> client, then through `compat/supabase-sql` (SMD-2144), which retires
> (SMD-3216). This page is kept as a pointer; the script is gone.

<div align="center">

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Original recipe by [@alanshurafa](https://github.com/alanshurafa)** — the
dated JSON export it introduced is kept in the `db/` script.

</div>

## Where it went

Run the export from a checkout of this repository, with the brain's
connection string:

```bash
bun db/backup.ts --url "$DATABASE_URL" --out ~/brain-backups
```

- **The connection.** On the stack, Postgres is reached from a checkout only
  when the stack came up with `-f deploy/compose.host-ports.yaml`, which
  publishes it on `127.0.0.1:${POSTGRES_PORT:-5432}` (`deploy/README.md`, the
  `postgres` service row). The URL is then
  `postgres://postgres:<POSTGRES_PASSWORD from deploy/.env>@127.0.0.1:5432/openbrain`. Without
  that file the run says `backup FAILED — Failed to connect`.
- **Where the files go.** `--out`, or `./backup` under the directory you run
  from. One JSON array per table, named `<table>-<UTC date>.json`, as the recipe
  named them; a second run the same day replaces them. Give `--out` a directory
  outside the checkout: the files hold every thought's text. (The checkout's
  `.gitignore` covers `backup/` at its root and in `db/`, the default's two
  likely places.)
- **Scheduling.** The old script read `SUPABASE_URL` from a `.env.local` in the
  directory it ran from. Bun reads `.env` and `.env.local` from the working
  directory too, so a cron job can keep `DATABASE_URL=…` in a 0600 `.env` there
  and run `bun /path/to/checkout/db/backup.ts --out …`, with no password on
  the command line. Rename the old file's `SUPABASE_URL` to `DATABASE_URL`.
- **A read-only role.** SELECT on every table it exports:
  `GRANT SELECT ON thoughts, ob1_entities, thought_entities, ob1_entity_edges TO <role>`,
  and the companion tables below that the brain has. The old README's grant
  named neither `ob1_entities` nor `ob1_entity_edges`, and this export is all or
  nothing: under that grant the run fails with `42501` and writes no file at all.

## What changed

- **The tables.** Always the core's `thoughts`, `ob1_entities`,
  `thought_entities` and `ob1_entity_edges` (migrations 001 and 016). The
  companion tables the recipe exported — `entities` and `edges`
  (`schemas/entity-extraction`) and `ingestion_jobs` and `ingestion_items` (the
  retired smart-ingest schema) — are exported when the brain has them, and named
  as not on this brain when it does not.
- **One snapshot.** Every table is read in one read-only transaction, so the
  files agree with each other.
- **The JSON is Postgres's.** Each row is `to_jsonb(row)`. Downstream tooling
  will see three differences from the recipe's files:
  - timestamps keep their microseconds and offset (`2026-11-13T22:16:04.116303+00:00`), where the recipe wrote milliseconds and `Z`;
  - `numeric` and `bigint` values are JSON numbers (`"confidence": 0.90`), where the recipe wrote strings (`"0.90"`);
  - the `embedding` stays its vector text, as before.

  `jsonb_populate_record` reads each row back into the same values.
- **All or nothing.** The files are renamed into place only once every table is
  read and counted. A failed run writes no file and leaves an earlier backup of
  the same date as it was; exit 1 names the table and the reason. Ctrl-C and
  SIGTERM remove the run's unfinished files too.
- **The timeout.** `--statement-timeout SECONDS` (60; 0 for none) replaces
  `FETCH_TIMEOUT_MS`.
- **The wrong database.** With `PGDATABASE` exported, Bun's client connects to
  that database rather than the URL's. The run refuses with exit 2, and its
  first line names the database it reads.

## The whole brain

The export is the brain's portable, readable form, not its restore path.
**`pg_dump` of the stack's database is the whole-brain backup**:

```bash
compose exec -T postgres pg_dump -U postgres openbrain > dump.sql
```

Here `compose` stands for `podman compose -f deploy/compose.yaml` (or `docker
compose`) from the repo root, with the stack's own `-f` files. That is
`deploy/README.md`'s "What is reachable from where", where the command is the
`postgres` service row's. The dump has every table the export leaves out:
`thought_audit`, the sources and facets, the claims, the plugins' schemas and
the rest.
