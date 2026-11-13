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

Run the export from a checkout, with the brain's connection string:

```bash
bun db/backup.ts --url "$DATABASE_URL"                # ./backup/<table>-YYYY-MM-DD.json
bun db/backup.ts --url "$DATABASE_URL" --out ~/brain-backups
```

It writes one JSON array per table, named `<table>-<UTC date>.json`, as the
recipe did. What changed:

- **The tables are the core's:** `thoughts`, `ob1_entities`, `thought_entities`
  and `ob1_entity_edges`, which every brain has. The recipe's `entities` and
  `edges` were a companion schema's, which no Daemonic Brain has, and its
  `ingestion_jobs` and `ingestion_items` were the retired smart-ingest schema's.
- **One snapshot:** the four tables are read in one read-only transaction, so
  the files agree with each other.
- **Postgres's own JSON:** each row is written as `to_jsonb(row)`. Timestamps
  keep their microseconds and offset, numerics their digits, and the vector its
  text. The recipe's rows went through JavaScript, which cut timestamps to
  milliseconds.
- **All or nothing:** a run that fails writes no file and leaves an earlier
  backup of the same date as it was. It exits 1 with the database's reason.
- **A read-only role is enough:** SELECT on the four tables
  (`GRANT SELECT ON thoughts, ob1_entities, thought_entities, ob1_entity_edges TO <role>`).

## The whole brain

The export is the brain's portable, readable form, not its restore path.
**`pg_dump` of the stack's database is the whole-brain backup**:

```bash
compose exec -T postgres pg_dump -U postgres openbrain > dump.sql
```

Here `compose` is the stack's compose command (`deploy/README.md`, the
`postgres` service row). The dump has every table the export
leaves out: `thought_audit`, the sources and facets, the claims, the plugins'
schemas and the rest.
