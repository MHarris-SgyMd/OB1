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

Run the sweep from a checkout, with the brain's connection string (a 0600
`.env` holding `DATABASE_URL` in the directory the run starts from keeps the
password off the command line; Bun reads it):

```bash
bun db/lint-sweep.ts                                   # both tiers; ./lint-report-YYYY-MM-DD.md
bun db/lint-sweep.ts --tier 1 --report ~/lint/week.md  # one tier, another path
```

On the stack, a checkout reaches Postgres only when the stack came up with
`-f deploy/compose.host-ports.yaml` (`deploy/README.md`, the `postgres`
service row). A role with SELECT on `thoughts`, `thought_entities`,
`ob1_entities` and `ob1_entity_edges` is enough: every read is in one
read-only transaction, and nothing is written to the brain.

## What it checks

- **Tier 1, `thoughts`:** the row count and the rows with no
  `content_fingerprint` (exact); in the 2,000 newest, the thoughts with no
  topics, tags or people, those with more than 10 tags, and those whose content
  is empty or over 20,000 characters.
- **Tier 2, the entity graph** (migration 016's `ob1_entities`,
  `thought_entities`, `ob1_entity_edges`): in the 500 newest thoughts, those
  no entity mention names; the entities with no edge (exact).

The report is markdown, written 0600, only once every read succeeded. A run
that fails writes none and exits 1 with the database's reason.

## What changed

- **The checks on `importance` are gone:** low-signal noise and high-importance
  thoughts with no entity links. The core retired `importance` (SMD-3661,
  decision 8), and its `thoughts` has no such column. Tier 2 reads the newest
  thoughts with no mention instead.
- **Exact duplicates are gone:** migration 003's partial unique index on
  `content_fingerprint` rules them out. The count of rows with no fingerprint
  stays.
- **The graph is the core's:** the recipe read `entities` and `edges` from
  `schemas/entity-extraction`; the script reads 016's tables, which every brain
  has.
- **The counts are exact where they can be:** the recipe read the first 2,000
  entities and 5,000 edges; the entity check now covers all of them.
- **`--tier 3` is refused** (exit 2) until PR 2b; `--sample-size`,
  `--max-llm-calls`, `--days` and `--llm-model` went with it.
  `OPENROUTER_API_KEY` is not read.
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
