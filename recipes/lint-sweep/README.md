# Lint Sweep

> **In Daemonic Brain (SMD-3318) — moved to `db/`.** Tiers 1 and 2 now live
> in [`db/lint-sweep.ts`](../../db/lint-sweep.ts), a `db/` script on Bun's
> Postgres client that reads the core's tables. Tier 3, a model's reading of
> sampled thoughts, follows in SMD-3318 PR 2b through the brain's provider and
> egress gate. The original `lint-sweep.js` reached the brain as a PostgREST
> client, then through `compat/supabase-sql` (SMD-2144), which retires
> (SMD-3216). The script is gone; `views.sql` stays (below).

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Original recipe by [@alanshurafa](https://github.com/alanshurafa)** — the
read-only, tiered quality audit it introduced is kept in the `db/` script.
It was inspired by Andrej Karpathy's "lint the wiki" pattern and the
[CRATE CLI](https://github.com/GuiminChen/CRATE) compile/ask/lint/ingest loop.

## Where it went

Run the sweep from a checkout. Keep the connection string in a 0600 `.env`
in the directory the run starts from (Bun reads `.env` and `.env.local` there),
so the password is not on a command line:

```bash
# ~/lint/.env (chmod 600):  DATABASE_URL=postgres://<role>:<password>@127.0.0.1:<port>/openbrain
cd ~/lint && bun /path/to/checkout/db/lint-sweep.ts                 # both tiers; ./lint-report-YYYY-MM-DD.md (UTC date)
cd ~/lint && bun /path/to/checkout/db/lint-sweep.ts --tier 1 --report week.md
```

- **The connection.** On the stack, a checkout reaches Postgres only when the
  stack came up with `-f deploy/compose.host-ports.yaml`, which publishes it on
  `127.0.0.1:${POSTGRES_PORT:-5432}` (`deploy/README.md`, the `postgres` service
  row); the password is `POSTGRES_PASSWORD` from `deploy/.env`, percent-encoded
  if it holds `@ / # ? % :`. A role with SELECT on `thoughts`,
  `thought_entities`, `ob1_entities` and `ob1_entity_edges` is enough.
- **The report.** `--report`, or `./lint-report-<UTC date>.md` in the directory
  the run starts from. Its previews are thought text: keep it outside the
  checkout, or under the default name in a place the checkout's `.gitignore`
  covers (its root, `db/` and `recipes/lint-sweep/`). It is written 0600 through
  a file of the run's own renamed into place, so a failed run leaves an earlier
  report as it was, and only once every read succeeded.
- **Upgrading a cron job.** The old script read `.env` and `.env.local` from its
  own directory, wherever it ran from; Bun reads them from the working
  directory. So `cd` into the directory holding the file (for the recipe's,
  `recipes/lint-sweep`), rename its `SUPABASE_URL` (or the legacy
  `OPEN_BRAIN_URL`) to `DATABASE_URL`, and call `bun ../../db/lint-sweep.ts`
  where you called `bun lint-sweep.js`. Flags take their value after a space
  (`--tier 1`, `--report week.md`); `--tier=1` is refused, and so are `-v` and
  `-h` (`--help` prints the flags). `--sample-size`, `--max-llm-calls`, `--days`
  and `--llm-model` went with Tier 3 and `--verbose` with the recipe's progress
  lines; each is refused saying why, so drop `--max-llm-calls 0` from the line.
  `OPENROUTER_API_KEY` is not read. A read-only role the old README granted
  `entities` and `edges` needs SELECT on `ob1_entities` and `ob1_entity_edges`
  in their place: the run locks every table its tiers read first, so a missing
  grant fails the whole run, Tier 1 included (`--tier 1` needs `thoughts`
  alone). A usage error (no URL, a bad flag) exits 2, where the recipe's exited
  1; a failed run still exits 1.
- **Not during an upgrade.** The run locks the tables it reads (ACCESS SHARE,
  as `pg_dump` does) for its length: writes go on, but an `ALTER` or `TRUNCATE`
  of one of them waits, and every read and write of that table waits behind it
  — for the rest of the sweep, or, for a migration, until the migrator's 10 s
  lock timeout fails the upgrade. A statement is bounded by
  `--statement-timeout` (60 s; 0 for none), lifted for the whole-table counts,
  and every lock wait by the same bound. In `pg_stat_activity` the run is
  `lint-sweep`.
- **Size and time.** Measured on a scratch brain: about half a second warm and
  5 s cold for a million thoughts, so minutes at 100 million and about an hour
  at a billion, the locks and the snapshot held throughout.

## What it checks

- **Tier 1, `thoughts`:** the row count, the rows with no
  `content_fingerprint` and the rows with no `created_at` or an infinite one
  (exact); in the 2,000 newest dated thoughts, those with no topics, tags or
  people, those with more than 10 tags, and those whose content is empty or
  over 20,000 characters (code points) once trimmed of every character a
  preview drops or collapses (whitespace, controls, zero-width and
  bidirectional marks). A list's entries are those the brain shows: a JSON
  null or a blank string is none. A thought with no `created_at`, or an
  infinite one, is in no sample. Orphans are pages (which carry no tags),
  imports and raw inserts, and captures whose tagging was cut off; a capture
  whose extraction failed otherwise is tagged `uncategorized` beside its
  `metadata_extraction_failed` marker, and counts as tagged.
- **Tier 2, the entity graph** (migration 016's `ob1_entities`,
  `thought_entities`, `ob1_entity_edges`): in the 500 newest dated thoughts,
  those no entity mention names (extraction found nothing in them, has not
  reached them, failed on them — `bun db/extract-entities.ts --retry-failed` —
  or is off); the entities with no edge (exact).

A run that fails writes no report and exits 1 with the reason. The samples
read the created_at index; among thoughts sharing a `created_at` at a sample's
edge (an import's transaction, a day-precision date), which are read is the
index's order. A far-future `created_at` (a mistyped year) is the newest, and
leads both samples.

## What changed

- **The checks on `importance` are gone:** low-signal noise and high-importance
  thoughts with no entity links. The core retired `importance` (SMD-3661,
  decision 8), and its `thoughts` has no such column. Tier 2 reads the newest
  thoughts with no mention instead. A brain with `schemas/enhanced-thoughts`
  applied (the only kind the old script's default run worked on) keeps both
  checks as `views.sql`'s `lint_low_signal` and `lint_high_importance_isolated`.
- **Fingerprint groups are gone:** migration 003's partial unique index makes a
  set fingerprint unique, so no two rows share one. A twin of a fingerprinted
  thought's content keeps no fingerprint (migration 023's header), so duplicate
  content hides among the rows with none, which the count still counts;
  `SELECT backfill_content_fingerprints();` sets what it can.
- **Over-tagged reads imports:** the brain's capture writes `topics` and
  `people`, never `tags`, so the check sees imported thoughts alone.
- **The graph is the core's:** the recipe read `entities` and `edges` from
  `schemas/entity-extraction`; the script reads 016's tables, which every brain
  has, and its entity check covers all of them, where the recipe read the first
  2,000 entities and 5,000 edges.
- **The report's summary section is gone;** each tier's section carries its
  counts. Its headings, frontmatter (`database:` in place of `generated_at`),
  list lines (no `thought #`; 15 listed, not 10) and the progress lines
  (`[tier 1] N thoughts, …`, `report written: …`) are new: a job that greps
  them must follow.
- **Lengths are code points,** as Postgres counts them, where the recipe
  counted JavaScript's UTF-16 units: an emoji is one character, not two, in
  the very-long check and the 120-character previews.
- **The connection** is `--url` or `DATABASE_URL`, not `SUPABASE_URL`, and the
  run refuses (exit 2) when `PGDATABASE` would point it at another database.

## The views

[`views.sql`](./views.sql) stays the recipe's: seven read-only `lint_*` views
for psql, over the columns `schemas/enhanced-thoughts` adds to `thoughts`
(`importance`, `source_type`). Apply it as the role that owns `thoughts`
(`psql "$DATABASE_URL" -f views.sql`), and grant another role the views with
`bun db/migrate.ts --grant <role>` (the **recipes** group). The script does not
read them.

## Safety

Every finding is a suggestion for a person to review. Check a thought (the
`fetch` tool, the operator GUI) before acting on it; never delete or edit one on
the report alone.
