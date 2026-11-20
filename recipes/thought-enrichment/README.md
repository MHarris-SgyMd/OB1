# Thought Enrichment Pipeline

> **In Daemonic Brain (SMD-3318) — moved to `db/`.** The recipe's three
> scripts are core `db/` scripts now. `enrich-thoughts.mjs` is retired for
> [`db/retag.ts`](../../db/retag.ts), the core's re-tag worker (SMD-2298),
> decided 2026-11-15: "not a second re-tag path". `backfill-type.mjs` and
> `backfill-sensitivity.mjs` are
> [`db/backfill-metadata.ts`](../../db/backfill-metadata.ts). Until then the
> scripts reached the brain through `compat/supabase-sql` (SMD-2139), which
> retires (SMD-3216). This page is kept as a pointer; the scripts are gone.

![Community Contribution](https://img.shields.io/badge/OB1_COMMUNITY-Approved_Contribution-2ea44f?style=for-the-badge&logo=github)

**Original recipe by [@alanshurafa](https://github.com/alanshurafa)** — its
retroactive tagging and its sensitivity tiers are kept in the `db/` scripts.

## The enrichment: `db/retag.ts`

The enrichment asked a model of its own for a type, a summary, topics, tags,
people, action items, a confidence and an importance, and wrote them through
the shim under its own prompt. The core re-tags instead: `db/retag.ts` runs the
capture's own tag extractor (server-portable/metadata.ts: the model, the
prompt and the temperature a capture uses) over every thought whose tags are
behind its text — tagged before lineage was recorded (migration 061), its tags
row marked stale or at other text, or its capture fell back — and writes
people, action items, dates, topics and type through `update_thought` with the
extractor's recipe, so the tags' lineage row is settled. The summary,
importance and confidence fields are not the core's and are not written; the
`enriched` column `schemas/enhanced-thoughts` adds is not read or set.

Run it from a checkout of this repository, the connection string in a 0600
`.env` in the directory the run starts from (Bun reads `.env` and `.env.local`
from the working directory), and the model as the brain's own
(`OB1_LLM_BASE_URL` or `OB1_CHAT_BASE_URL`, `OB1_METADATA_MODEL`; SETUP.md):

```bash
bun db/retag.ts --status        # the pool and the backlog; writes nothing
bun db/retag.ts --dry-run       # what a run would do; writes nothing
bun db/retag.ts --limit 20      # a trial
bun db/retag.ts                 # the backlog
bun db/retag.ts --retry-failed  # failed rows back into the pool first
```

Each thought's text leaves only as the brain's egress policy lets it
(`OB1_EGRESS_POLICY`, `OB1_EGRESS_ALLOW`, `OB1_EGRESS_DENY`), judged per
thought; the old script sent every thought's first 4,000 characters to the
provider you chose. `db/README.md` ("retag.ts") and the script's header have
the rest: the pool key, `OB1_WORKER_KEY`, the exit codes.

## The two backfills: `db/backfill-metadata.ts`

`backfill-type.mjs` and `backfill-sensitivity.mjs` are one `db/` script now (SMD-3318). It reads `DATABASE_URL`, not `SUPABASE_URL`, from the environment or from a `.env` / `.env.local` in the directory you run it from (Bun reads those; the old scripts read `.env.local` beside themselves). Keep the URL there rather than on the command line, where `ps` shows its password to every user. From this directory, with `DATABASE_URL=postgres://…` in its `.env.local`:

```bash
bun ../../db/backfill-metadata.ts                         # both passes, a dry run: what would be written
bun ../../db/backfill-metadata.ts --apply                 # write
bun ../../db/backfill-metadata.ts --pass sensitivity --apply
```

A cron line `cd`s here first (cron starts in `$HOME`, where no `.env` names the brain) and adds `--apply`: with no flag the script is a dry run that writes nothing, where `bun backfill-type.mjs` wrote. A role of its own needs what `bun db/migrate.ts --grant <role>` gives (run from the checkout's root): the write goes through `update_thought`, which reads `ob1_agents` and `ob1_config` as well as `thoughts` and `thought_audit`.

Both passes write the metadata key through `update_thought` (one audit event a row, `actor_name` `backfill-metadata`), and the column too where `schemas/enhanced-thoughts` added it, for that schema's readers (a column's write alone records no audit event, as the old scripts' did not):

- **type** writes a `metadata.type` the capture would have written otherwise (another case, or an alias such as `todo` or `fact`) as the capture's own type, an alias's words kept in `type_raw`. A type naming none of the capture's (`decision`, `lesson`) is left in the key, and so is a row an importer owns. The `type` column takes the old script's rule on the type as the capture names it: a row stamped `reference` takes it when it is one of the old eight (so `Task` and `todo` now set it, where the old script skipped them), an importer's row included.
- **sensitivity** reads `db/sensitivity.ts`'s patterns (the ones this recipe shipped, reworked, and the session-capture hook's secret table), and each place — the key, and the column where it exists — takes the highest of their tier and the other place's when that is higher than what it says, in any case. A tier is never lowered, and a thought's text is never printed (the old script printed the first 80 characters of every restricted thought, and of the first 30 it scanned). `db/weekly-digest.ts` leaves a row out of its model calls by the key, the column, or the same patterns over its text, so a thought captured since the backfill last ran is held back too.

Without `--apply` nothing is written. `--dry-run` is refused (a run without `--apply` is one), and `--batch-size` is `--batch`. A row whose metadata is not a JSON object (SQL NULL, or a double-encoded string, below) has its keys counted, not written; repair it and run again. The audit trail names each key written: `SELECT thought_id, diff FROM thought_audit WHERE actor_name = 'backfill-metadata'` (a column's write alone is not in it). A page holds its rows' whole text: on a brain of long documents pass a smaller `--batch`. Its failures print `backfill-metadata FAILED — <code> <message>` and exit 1 (2 for a refusal). `db/README.md` has the rest.

## Upgrading from the scripts

- `SUPABASE_URL` is `DATABASE_URL` for both `db/` scripts; the provider
  variables (`OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `ANTHROPIC_API_KEY`,
  `ENRICH_*`) are not read. The enrichment's checkpoint (`data/enrichment-state.json`)
  is not read either: `db/retag.ts` keeps its progress in the brain's work pool.
- Run `bun db/backfill-metadata.ts --apply` after a re-tag, as after the old
  enrichment: the type pass settles a `metadata.type` an importer wrote, and the
  sensitivity pass reads every thought's text.

## Repairing double-encoded metadata (versions before this fix)

Versions of the retired `enrich-thoughts.mjs` before that fix pre-stringified `metadata` before the request body was itself stringified, so the `metadata` jsonb column was stored as a JSON *string* instead of an object on every enriched row. Symptoms: `metadata->'topics'` returns NULL everywhere, `metadata @>` filters stop matching, and stats/dashboard topic lists go empty, while the raw value looks like `"{\"type\":...}"`. (In Daemonic Brain the shim binds the object as jsonb, and migration 005 refuses a string payload on the functions' path.)

The inner string is the complete, valid metadata — nothing is lost. Repair in one transactional statement (`psql "$DATABASE_URL"`, or any SQL client):

```sql
UPDATE thoughts
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string';
```

If any row held a non-JSON string the statement aborts as a whole and changes nothing.
