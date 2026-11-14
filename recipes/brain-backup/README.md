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

Run the export from a checkout of this repository. Keep the connection string
in a 0600 `.env` in the directory the run starts from (Bun reads `.env` and
`.env.local` from the working directory, not from the script's), so the
password is not on a command line:

```bash
# ~/brain-backup/.env (chmod 600):  DATABASE_URL=postgres://brain_backup:…@127.0.0.1:5432/openbrain
cd ~/brain-backup && bun /path/to/checkout/db/backup.ts --out ~/brain-backups
```

(`--url <postgres://…>` works too, at the cost of the password in `ps`.)

- **The connection.** On the stack, Postgres is reached from a checkout only
  when the stack came up with `-f deploy/compose.host-ports.yaml`, which
  publishes it on `127.0.0.1:${POSTGRES_PORT:-5432}` (`deploy/README.md`, the
  `postgres` service row). The URL is then
  `postgres://<role>:<password>@127.0.0.1:<that port>/openbrain`, the password
  percent-encoded if it holds `@ / # ? % :`. Without that file the run says
  `backup FAILED — Failed to connect`.
- **Where the files go.** `--out`, or `./backup` under the directory the run
  starts from. One JSON array per table, named `<table>-<UTC date>.json`, as the
  recipe named them; a second run the same day replaces them (a companion
  table's file from an earlier run that day, when this run did not write one,
  stays and is named). Give `--out` a
  directory outside the checkout: the files hold every thought's text. (The
  checkout's `.gitignore` covers `backup/` at its root, in `db/` and in
  `recipes/brain-backup/`, where the old script's cron job ran.)
- **Upgrading a cron job.** The old script read `SUPABASE_URL` from a
  `.env.local` in the directory it ran from: rename it `DATABASE_URL` there, and
  call `bun ../../db/backup.ts` (or the absolute path) where it called
  `bun backup-brain.mjs`.
- **A read-only role.** A login role with SELECT on every table the run
  exports, made as the superuser — `compose exec postgres psql -U postgres
  openbrain` (`deploy/README.md`, the `postgres` service row):

  ```sql
  CREATE ROLE brain_backup LOGIN PASSWORD '…';
  GRANT SELECT ON thoughts, ob1_entities, thought_entities, ob1_entity_edges TO brain_backup;
  -- and each companion table below that this brain has, e.g.:
  GRANT SELECT ON entities, edges TO brain_backup;
  ```

  The URL then names that role. The old README's grant named neither
  `ob1_entities` nor `ob1_entity_edges`, and a run renames nothing unless it read
  every table: under that grant it fails with `42501` and no file is replaced.

## What changed

- **The tables.** Always the core's `thoughts`, `ob1_entities`,
  `thought_entities` and `ob1_entity_edges` (migrations 001 and 016). The
  companion tables the recipe exported — `entities` and `edges`
  (`schemas/entity-extraction`) and `ingestion_jobs` and `ingestion_items` (the
  retired smart-ingest schema's, in `public`) — are exported when the brain has
  them as tables with their schema's key, and named as not on this brain when
  it does not. Anything else under one of those names (a view, another tool's
  table) is named and passed over. The smart-ingest plugin's tables, in its own
  schema `plugin_smart_ingest`, are not exported: `pg_dump` has them.
- **One snapshot.** Every table is read in one read-only transaction, so the
  files agree with each other. As `pg_dump` does, the run locks every table it
  reads before the snapshot (ACCESS SHARE: writes go on), so a `TRUNCATE`, drop
  or rename waits for the run rather than landing under it.
- **The JSON is Postgres's.** Each row is `to_jsonb(row)`. Downstream tooling
  will see three differences from the recipe's files:
  - timestamps keep their microseconds and offset (`2026-11-13T22:16:04.116303+00:00`), where the recipe wrote milliseconds and `Z`;
  - `numeric` and `bigint` values are JSON numbers (`"confidence": 0.90`), where the recipe wrote strings (`"0.90"`);
  - the `embedding` stays its vector text, as before.

  `jsonb_populate_record` reads each row back into the same values.
- **Nothing in place until every table is read.** The files are renamed into
  place only once every table is read and counted. A run that fails first
  renames nothing, removes its own files and leaves an earlier backup of the
  same date as it was; exit 1 names the reason. A rename that fails after that
  point (a disk full, a directory where a file should be) is said, naming the
  files it already replaced. Ctrl-C, SIGTERM and SIGHUP remove the run's
  unfinished files too (exit 130, 143, 129). A run killed outright (SIGKILL, the
  OOM killer) leaves them: `<table>-<date>.json.<run id>.tmp`, each a whole
  table's text, to be removed by hand.
- **The timeout.** `--statement-timeout SECONDS` (60; 0 for none) bounds each
  page, as `FETCH_TIMEOUT_MS` did. The counts run unbounded.
- **Not during an upgrade.** While the run holds its locks, a migration that
  alters a table it reads (`thoughts`, most often) waits, the brain's reads and
  writes of that table wait behind the migration, and after the migrator's 10 s
  lock timeout the upgrade fails: run it again once the backup is done.
  Schedule backups apart from upgrades; `pg_dump` behaves the same.
- **Size and time.** About 6.5 minutes and 18 GB of files a million thoughts
  with their graph (the embedding's text is most of a thought's row), so hours
  at 100 million and days at a billion, the locks and the snapshot held
  throughout. A large brain's backup is `pg_dump`.
- **The wrong database.** With `PGDATABASE` exported, Bun's client connects to
  that database rather than the URL's. The run refuses with exit 2, and its
  first line names the database it reads.

## The whole brain

The export is the brain's portable, readable form, not its restore path.
Loaded back into a brain (`INSERT … SELECT * FROM jsonb_populate_recordset(…)`),
the rows pass through its triggers: each thought gets a new capture event dated
at the load and loses its `actor_*` marks, and what the export leaves out is
not there — long thoughts' chunk windows (semantic search finds them again only
once `db/reembed.ts` rebuilds them), the lineage rows, the audit log, and the
companion tables' sequences.
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
