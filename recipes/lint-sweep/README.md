# Lint Sweep

> **In Daemonic Brain (SMD-3318) — moved to `db/`.** The sweep lives in
> [`db/lint-sweep.ts`](../../db/lint-sweep.ts), a `db/` script on Bun's
> Postgres client that reads the core's tables; Tier 3, a model's reading of
> sampled thoughts, goes through the brain's own chat endpoint and egress gate.
> The original `lint-sweep.js` reached the brain as a PostgREST
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
cd ~/lint && bun /path/to/checkout/db/lint-sweep.ts                 # every tier; ./lint-report-YYYY-MM-DD.md (UTC date)
cd ~/lint && bun /path/to/checkout/db/lint-sweep.ts --tier 1 --report week.md
cd ~/lint && bun /path/to/checkout/db/lint-sweep.ts --max-llm-calls 0   # tiers 1 and 2 alone: no model call
```

- **The connection.** On the stack, a checkout reaches Postgres only when the
  stack came up with `-f deploy/compose.host-ports.yaml`, which publishes it on
  `127.0.0.1:${POSTGRES_PORT:-5432}` (`deploy/README.md`, the `postgres` service
  row); the password is `POSTGRES_PASSWORD` from `deploy/.env`, percent-encoded
  if it holds `@ / # ? % :`. A role with SELECT on `thoughts`,
  `thought_entities`, `ob1_entities` and `ob1_entity_edges` is enough.
- **The report.** `--report`, or `./lint-report-<UTC date>.md` in the directory
  the run starts from. Its previews are thought text (Tier 2's are not held
  back, a restricted thought's included; Tier 3's lines carry ids and the
  model's words, a secret in them withheld): keep it outside the
  checkout, or under the default name in a place the checkout's `.gitignore`
  covers (its root, `db/` and `recipes/lint-sweep/`). It is written 0600 through
  a file of the run's own renamed into place, so a failed run leaves an earlier
  report as it was, and only once tiers 1 and 2's reads succeeded (a Tier 3
  that fails still writes it, with what came before).
- **Upgrading a cron job.** The old script read `.env` and `.env.local` from its
  own directory, wherever it ran from; Bun reads them from the working
  directory. So `cd` into the directory holding the file (for the recipe's,
  `recipes/lint-sweep`), rename its `SUPABASE_URL` (or the legacy
  `OPEN_BRAIN_URL`) to `DATABASE_URL`, and call `bun ../../db/lint-sweep.ts`
  where you called `bun lint-sweep.js`. Flags take their value after a space
  (`--tier 1`, `--report week.md`); `--tier=1` is refused, and so are `-v` and
  `-h` (`--help` prints the flags). `--sample-size`, `--max-llm-calls` and
  `--days` are Tier 3's as before; `--llm-model` is `--model` now, and
  `--verbose` went with the recipe's progress lines (each refused saying why).
  Tier 3 no longer calls OpenRouter itself: it reads the endpoint, the model
  and the egress policy from the environment it runs in, as the brain's server
  reads them from its own (below), and nothing from the stack's `deploy/.env`.
  So the job's `.env` carries them: `OB1_LLM_BASE_URL` (or `OB1_CHAT_BASE_URL`)
  at an address the host reaches (the stack's default, `http://ollama:11434/v1`,
  resolves only inside it; with none set the run uses `http://127.0.0.1:11434/v1`
  and the model `qwen2.5:7b`, which the `[tier 3] model …` line names), its
  key, `OB1_METADATA_MODEL` or `--model` naming a model that endpoint serves,
  the `OB1_EGRESS_*` terms, and, for an `actor:` term, `OB1_WORKER_KEY` with
  `MCP_ACCESS_KEYS`. The keys pair with the bases: `OB1_LLM_API_KEY` (or its
  fallback, `OPENROUTER_API_KEY`) goes to `OB1_LLM_BASE_URL`, and to the chat
  endpoint only when it has no base of its own; a chat endpoint at
  `OB1_CHAT_BASE_URL` takes `OB1_CHAT_API_KEY` alone. A leftover
  `OPENROUTER_API_KEY` goes as the bearer key to whatever `OB1_LLM_BASE_URL`
  names, so remove it unless that is OpenRouter. An endpoint not declared local
  that carries no key at all is skipped before any read: a hosted provider
  would refuse each call only after its text had left. A job that ran Tier 3 needs the policy to let its thoughts leave,
  or runs tiers 1 and 2 alone (`--max-llm-calls 0`). A read-only role the old README granted
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
- **Tier 3's egress.** The thoughts go to the chat endpoint and model resolved
  as the brain's server resolves them, from the run's own environment
  (`OB1_CHAT_BASE_URL` or `OB1_LLM_BASE_URL`, their keys, `OB1_METADATA_MODEL`;
  `--model` names another; the `[tier 3] model …; egress: …` line says which),
  each put to the egress gate on
  its own units: `OB1_WORKER_KEY`'s name as the actor, its source, type and
  topics, and what is sent of it (its text, type, topics and tags) and its
  whole text as the marker: it goes only when both pass, so a marker anywhere
  in a thought is the thought's. A refused thought is left out. Under the
  default deny, with no allow term and no endpoint declared local, the tier is
  skipped before any read, and the report says why. Release it with
  `OB1_EGRESS_ALLOW=actor:<the worker key's name>` (the `--name` keygen gave
  it, never the key itself, which the run would print and match nothing), or
  with a source, type, topic or marker the thoughts to send carry. Or run a
  model on this machine or its private network and declare it so
  (`OB1_LLM_LOCAL=1`; `OB1_CHAT_LOCAL=1` for a chat endpoint of its own): the
  declaration is not checked, and it turns the egress gate off for that
  endpoint, allow and deny terms alike, so never set it for a hosted provider
  (the run warns when the declared host is no loopback or private address). Once a thought could leave, a worker key the server would refuse (not
  in `MCP_ACCESS_KEYS`, `MCP_ACCESS_KEYS` unset, revoked, or a forwarder's)
  refuses the run, exit 2. A skipped tier
  exits 0: the `[tier 3] skipped:` line and the report say why, with what was
  read and held back, and the report's frontmatter carries `tier3: ran`,
  `skipped`, `failed` or `unreadable` (every answer unreadable, which also
  warns on stderr) for a job to read; a stop says `then stopped` on the stdout
  line and exits 1. Under `OB1_EGRESS_POLICY=allow` a deny term (`topic:health`) holds its
  thoughts back. Before the gate, a thought `restricted`, or `personal` unless
  `--include-personal`, by its `sensitivity_tier` key or column or by the
  sensitivity patterns over what is sent and its whole text, is never sent
  (weekly-digest's hold-back, `db/sensitivity.ts`). With `OB1_WORKER_KEY` set, the
  key is resolved first, as every worker's is: the agent registry records it,
  or its last use, the run's one write to the brain.
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
- **Tier 3, a model's reading:** the newest dated thoughts of the last
  `--days` (365) whose text, trimmed, is 20 characters or more, read newest
  first until as many as the calls can send are left once the hold-back and
  the gate have kept theirs back (`--sample-size`, 100, 10 to 1,000, or
  `--max-llm-calls` × 20 if less; at most 10,000 read), sent 20 a call, at most
  `--max-llm-calls` (5, up to 100; 0 turns it off); `--days` is 1 to 36,500. Each batch is read again just before
  its call: a thought deleted or newly held back since is not sent. Each goes
  as a ref (`t1`…), its date, type, first 400 characters and five topics and
  tags (each cut to 100 characters), with today's date (UTC). Each finding's
  line names its batch and each of its thoughts by its ref in that batch, its
  id and its date; the report's table of refs by batch maps any ref (`t7`) the
  model's own words name, which are kept as written. Words that read as a
  secret are withheld. The answer must be one JSON document with a category's
  key (the request asks for JSON); anything else counts as an answer
  unreadable. A provider's failure
  is reported by its host and status, never its error text. With
  `OB1_METADATA_REASONING` on, the call has no answer budget (a thinking
  model otherwise spends it on its thinking and answers nothing), and a batch
  of 20 can take minutes: over 150 s on a 27b model, past the 120 s
  `OB1_LLM_TIMEOUT` default, so raise it; the run says so. An answer cut at the
  budget is counted as cut. The model names contradictions, stale facts, superseded
  decisions, orphans and missing links; each finding lists its thoughts' ids,
  and its words are made safe as a preview is and cut to 300 characters. Fewer
  than 10 thoughts left to send skips the tier. The sample is read in the
  sweep's snapshot, and the calls go after its transaction ends.

A run that fails writes no report and exits 1 with the reason; a Tier 3 that
fails (its read, a batch's second read, or a call after its transient retries)
fails that tier alone, and the report is written with what came before, exit 1. The samples
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
- **Tier 3 goes through the brain:** the brain's chat endpoint and model, not
  OpenRouter with a key of its own; the egress gate on each thought; and
  weekly-digest's sensitivity hold-back. Its `low_signal` kind is gone (it read
  `importance`), and so is its `source_type`, which it read but never sent. A
  thought is named by its id; the model sees a ref, mapped back, and a finding
  naming no thought of its batch is dropped and counted. An answer that is not
  one JSON document loses its batch's findings, counted, where the recipe
  stopped the run. Today's date goes with each batch, for what is stale.

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
